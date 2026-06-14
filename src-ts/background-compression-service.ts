import { getLogTag } from "./utils";
import { ConcurrencyLimiter } from "./concurrency-limiter";
import type LocalImageCompressPlugin from "./plugin";
import type { TimerHandle } from "./types";
import type { TFile } from "obsidian";

const BACKGROUND_FILTER_CONCURRENCY = 8;

// Owns background auto-compression: user-activity/inactivity tracking state and
// the idle-trigger logic. The plugin holds a reference and forwards runtime
// settings (applySettings) and unload cleanup.
export class BackgroundCompressionService {
  private readonly plugin: LocalImageCompressPlugin;
  AUTO_BACKGROUND_THRESHOLD = 50;
  USER_INACTIVITY_THRESHOLD = 2 * 60 * 1e3;
  readonly INACTIVITY_CHECK_INTERVAL = 5 * 60 * 1e3;
  lastUserActivity = Date.now();
  lastUserActivityPerfTime: number;
  isBackgroundCompressionRunning = false;
  inactivityTimer: TimerHandle | null = null;
  inactivityCheckActive = false;

  constructor(plugin: LocalImageCompressPlugin) {
    this.plugin = plugin;
    this.lastUserActivityPerfTime = plugin.getMonotonicTime();
  }

  // Applies normalized runtime limits (called from plugin.applyRuntimeSettings).
  applySettings(autoBackgroundThreshold: number, userInactivityThresholdMs: number) {
    this.AUTO_BACKGROUND_THRESHOLD = autoBackgroundThreshold;
    this.USER_INACTIVITY_THRESHOLD = userInactivityThresholdMs;
  }

  // Stops the inactivity loop and clears its timer (called from plugin onunload).
  cleanup() {
    this.inactivityCheckActive = false;
    if (this.inactivityTimer) {
      this.plugin.clearWindowTimeout(this.inactivityTimer);
      this.inactivityTimer = null;
    }
  }

  setupUserActivityTracking() {
    const updateActivity: EventListener = () => {
      this.lastUserActivity = Date.now();
      this.lastUserActivityPerfTime = this.plugin.getMonotonicTime();
    };
    const activeDocument = this.plugin.getActiveDocument();
    // Plugin-lifetime listeners: registerDomEvent auto-removes them on unload.
    const activityEvents: Array<keyof DocumentEventMap> = [
      "mousemove",
      "mousedown",
      "keydown",
      "scroll",
      "wheel",
      "touchstart"
    ];
    for (const event of activityEvents) {
      this.plugin.registerDomEvent(activeDocument, event, updateActivity, { passive: true });
    }
  }

  isUserInactive() {
    const timeSinceLastActivity = Math.max(0, this.plugin.getMonotonicTime() - this.lastUserActivityPerfTime);
    return timeSinceLastActivity > this.USER_INACTIVITY_THRESHOLD;
  }

  startInactivityCheck() {
    if (this.inactivityCheckActive) {
      return;
    }
    this.inactivityCheckActive = true;
    const checkInactivity = async () => {
      if (!this.inactivityCheckActive || this.plugin.isUnloading) {
        return;
      }
      try {
        if (this.plugin.settings.autoBackgroundCompression && this.isUserInactive()) {
          await this.checkAndStartBackgroundCompression();
        }
      } catch (error) {
        console.error(getLogTag(this.plugin), "Inactivity check error:", error);
      } finally {
        if (this.inactivityCheckActive && !this.plugin.isUnloading) {
          this.inactivityTimer = this.plugin.setWindowTimeout(checkInactivity, this.INACTIVITY_CHECK_INTERVAL);
        }
      }
    };
    this.inactivityTimer = this.plugin.setWindowTimeout(checkInactivity, this.INACTIVITY_CHECK_INTERVAL);
  }

  async checkAndStartBackgroundCompression() {
    if (!this.plugin.settings.autoBackgroundCompression || !this.isUserInactive()) {
      return;
    }
    const uncompressedCount = this.getReadyUncompressedCount();
    if (uncompressedCount === null) {
      return;
    }
    if (!this.plugin.settings.autoBackgroundCompression || !this.isUserInactive()) {
      return;
    }
    if (uncompressedCount >= this.getAutoBackgroundThreshold()) {
      await this.startBackgroundCompression();
    }
  }

  async startBackgroundCompression() {
    if (this.isBackgroundCompressionRunning || !this.plugin.settings.autoBackgroundCompression || !this.isUserInactive()) {
      return;
    }
    this.isBackgroundCompressionRunning = true;
    try {
      const hasReadyIndex = !!this.plugin.imageIndex?.isReady?.();
      const imageFiles = hasReadyIndex
        ? await this.plugin.getImageFiles()
        : this.plugin.getAllImageFiles();
      const filteredFiles = imageFiles.filter(
        (file): file is TFile => this.plugin.isImageFile(file) && this.plugin.isAllowedPath(file.path)
      );
      const uncompressedFiles = hasReadyIndex
        ? filteredFiles
        : await this.filterUnprocessedFiles(filteredFiles);
      if (!this.plugin.settings.autoBackgroundCompression || !this.isUserInactive()) {
        return;
      }
      await this.plugin.processBatchCompressionBackground(uncompressedFiles);
    } catch (error) {
      console.error(getLogTag(this.plugin), "Background compression error:", error);
    } finally {
      this.isBackgroundCompressionRunning = false;
      await this.plugin.statusBarController.update();
    }
  }

  private async filterUnprocessedFiles(files: TFile[]) {
    const limiter = new ConcurrencyLimiter(BACKGROUND_FILTER_CONCURRENCY);
    const checkedFiles = await Promise.all(files.map((file) =>
      limiter.run(async () => !await this.plugin.cache.isFileAlreadyProcessed(file) ? file : null)
    ));
    return checkedFiles.filter((file): file is TFile => file !== null);
  }

  private getReadyUncompressedCount() {
    if (!this.plugin.imageIndex?.isReady?.()) {
      return null;
    }
    const snapshot = this.plugin.imageIndex.getSnapshot?.();
    const count = snapshot?.uncompressedImages;
    return typeof count === "number" && Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : null;
  }

  private getAutoBackgroundThreshold() {
    const threshold = this.plugin.settings.autoBackgroundThreshold;
    if (typeof threshold === "number" && Number.isFinite(threshold)) {
      return Math.max(1, Math.trunc(threshold));
    }
    const fallback = this.AUTO_BACKGROUND_THRESHOLD;
    return typeof fallback === "number" && Number.isFinite(fallback) ? Math.max(1, Math.trunc(fallback)) : 50;
  }
}
