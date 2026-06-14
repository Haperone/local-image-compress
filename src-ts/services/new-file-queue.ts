import * as obsidian from "obsidian";
import type { default as LocalImageCompressPlugin } from "../plugin";
import type { TimerHandle } from "../types";
import { getLogTag, getPluginName, getVaultFileByPath, normalizeVaultPath } from "../utils";
import { t } from "../i18n";

// Owns the new-file auto-compress queue: BOTH the state (timers/pending/in-flight
// sets, batch flags, limits) and the logic (debounce -> pending -> batch drain).
// The plugin only holds a reference plus thin delegators for its event handlers.
export class NewFileQueue {
  readonly newFileCompressionTimers: Map<string, TimerHandle> = new Map();
  readonly newFileCompressionInFlight: Set<string> = new Set();
  readonly newFileCompressionPending: Set<string> = new Set();
  newFileBatchFlushTimer: TimerHandle | null = null;
  newFileBatchDrainInProgress = false;
  newFileBatchDrainRescheduleRequested = false;
  newFileBatchFirstQueuedAt: number | null = null;
  newFilePendingOverflowWarned = false;
  newFilePendingOverflowNoticeAt = 0;
  readonly NEW_FILE_BATCH_DEBOUNCE_MS = 500;
  readonly NEW_FILE_BATCH_MAX_WAIT_MS = 5e3;
  NEW_FILE_PENDING_MAX = 10_000;
  readonly NEW_FILE_OVERFLOW_NOTICE_COOLDOWN_MS = 60_000;
  readonly AUTO_COMPRESS_DELAY = 3e3;

  constructor(private readonly plugin: LocalImageCompressPlugin) {}

  // Clears every timer and resets all queue state. Called from plugin onunload.
  cleanup() {
    for (const timer of this.newFileCompressionTimers.values()) {
      this.plugin.clearWindowTimeout(timer);
    }
    this.newFileCompressionTimers.clear();
    if (this.newFileBatchFlushTimer) {
      this.plugin.clearWindowTimeout(this.newFileBatchFlushTimer);
      this.newFileBatchFlushTimer = null;
    }
    this.newFileCompressionPending.clear();
    this.newFileCompressionInFlight.clear();
    this.newFileBatchDrainInProgress = false;
    this.newFileBatchDrainRescheduleRequested = false;
    this.newFileBatchFirstQueuedAt = null;
    this.newFilePendingOverflowWarned = false;
    this.newFilePendingOverflowNoticeAt = 0;
  }

  // True if a debounce timer or a pending entry exists for this path (used by the
  // modify handler to re-arm auto-compression).
  hasPendingOrTimer(filePath: string | null | undefined): boolean {
    if (!filePath) {
      return false;
    }
    const normalizedPath = normalizeVaultPath(filePath);
    return this.newFileCompressionTimers?.has(normalizedPath) || this.newFileCompressionPending?.has(normalizedPath);
  }

  async handleNewFile(file: obsidian.TAbstractFile) {
    if (!this.plugin.settings.autoCompressNewFiles || !(file instanceof obsidian.TFile) || !this.plugin.isImageFile(file) || this.plugin.isOutputFolderPath(file.path)) {
      return;
    }
    const filePath = normalizeVaultPath(file.path);
    const existingTimer = this.newFileCompressionTimers?.get(filePath);
    if (existingTimer) {
      this.plugin.clearWindowTimeout(existingTimer);
    }
    const timer = this.plugin.setWindowTimeout(() => {
      this.newFileCompressionTimers?.delete(filePath);
      if (this.plugin.isUnloading) {
        return;
      }
      const freshFile = getVaultFileByPath(this.plugin.app.vault, filePath);
      if (!freshFile || !this.plugin.isImageFile(freshFile) || this.plugin.isOutputFolderPath(freshFile.path)) {
        return;
      }
      if (this.newFileCompressionInFlight.has(filePath)) {
        return;
      }
      if (!this.newFileCompressionPending.has(filePath) && this.newFileCompressionPending.size >= this.NEW_FILE_PENDING_MAX) {
        const now = Date.now();
        const noticeDue = !this.newFilePendingOverflowWarned || now - this.newFilePendingOverflowNoticeAt >= this.NEW_FILE_OVERFLOW_NOTICE_COOLDOWN_MS;
        if (noticeDue) {
          this.newFilePendingOverflowWarned = true;
          this.newFilePendingOverflowNoticeAt = now;
          console.warn(getLogTag(this.plugin), `Auto-compress queue full (${this.NEW_FILE_PENDING_MAX}); dropping new files`);
          new obsidian.Notice(`${getPluginName(this.plugin)}: ${t(this.plugin.app, "auto.queueFull", { max: this.NEW_FILE_PENDING_MAX })}`, 10000);
        }
        return;
      }
      this.newFileCompressionPending.add(filePath);
      this.scheduleNewFileBatchDrain();
    }, this.AUTO_COMPRESS_DELAY);
    this.newFileCompressionTimers?.set(filePath, timer);
  }

  cancelPendingNewFileCompression(filePath: string | null | undefined) {
    if (!filePath) {
      return;
    }
    const normalizedPath = normalizeVaultPath(filePath);
    const timer = this.newFileCompressionTimers?.get(normalizedPath);
    if (timer) {
      this.plugin.clearWindowTimeout(timer);
      this.newFileCompressionTimers.delete(normalizedPath);
    }
    this.newFileCompressionPending?.delete(normalizedPath);
    if (this.newFileCompressionPending?.size === 0 && this.newFileBatchFlushTimer) {
      this.plugin.clearWindowTimeout(this.newFileBatchFlushTimer);
      this.newFileBatchFlushTimer = null;
      this.newFilePendingOverflowWarned = false;
    }
  }

  scheduleNewFileBatchDrain() {
    if (this.newFileBatchFlushTimer) {
      return;
    }
    if (this.newFileBatchDrainInProgress) {
      this.newFileBatchDrainRescheduleRequested = true;
      return;
    }
    if (this.newFileBatchFirstQueuedAt === null) {
      this.newFileBatchFirstQueuedAt = Date.now();
    }
    const elapsedMs = Date.now() - this.newFileBatchFirstQueuedAt;
    const remainingMs = Math.max(0, this.NEW_FILE_BATCH_MAX_WAIT_MS - elapsedMs);
    const delayMs = Math.min(this.NEW_FILE_BATCH_DEBOUNCE_MS, remainingMs);
    this.newFileBatchFlushTimer = this.plugin.setWindowTimeout(() => {
      this.newFileBatchFlushTimer = null;
      this.drainNewFileCompressionBatch().catch((error) => {
        if (!this.plugin.isUnloading) {
          console.error(getLogTag(this.plugin), "Delayed new-file batch compression error:", error);
        }
      });
    }, delayMs);
  }

  async drainNewFileCompressionBatch() {
    if (this.newFileBatchDrainInProgress) {
      this.newFileBatchDrainRescheduleRequested = true;
      return;
    }
    if (this.plugin.isUnloading || this.newFileCompressionPending.size === 0) {
      this.newFileBatchFirstQueuedAt = null;
      return;
    }
    this.newFileBatchDrainInProgress = true;
    this.newFileBatchDrainRescheduleRequested = false;
    let files: obsidian.TFile[] = [];
    try {
      const paths = Array.from(this.newFileCompressionPending);
      this.newFileCompressionPending.clear();
      files = paths
        .map((filePath) => getVaultFileByPath(this.plugin.app.vault, filePath))
        .filter((freshFile): freshFile is obsidian.TFile =>
          freshFile !== null &&
          this.plugin.isImageFile(freshFile) &&
          !this.plugin.isOutputFolderPath(freshFile.path) &&
          !this.newFileCompressionInFlight.has(freshFile.path)
        );
      if (files.length === 0) {
        return;
      }
      for (const freshFile of files) {
        this.newFileCompressionInFlight.add(freshFile.path);
      }
      await this.plugin.processBatchCompressionBackground(files);
    } catch (error) {
      if (!this.plugin.isUnloading) {
        console.error(getLogTag(this.plugin), "Delayed new-file batch compression error:", error);
      }
    } finally {
      for (const freshFile of files) {
        this.newFileCompressionInFlight.delete(freshFile.path);
      }
      this.newFileBatchDrainInProgress = false;
      const shouldDrainAgain = this.newFileBatchDrainRescheduleRequested || this.newFileCompressionPending.size > 0;
      this.newFileBatchDrainRescheduleRequested = false;
      if (!this.plugin.isUnloading && shouldDrainAgain && this.newFileCompressionPending.size > 0) {
        this.scheduleNewFileBatchDrain();
      } else if (this.newFileCompressionPending.size === 0) {
        this.newFileBatchFirstQueuedAt = null;
        this.newFilePendingOverflowWarned = false;
      }
    }
  }
}
