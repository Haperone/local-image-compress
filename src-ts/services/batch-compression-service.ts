import * as obsidian from "obsidian";
import { t } from "../i18n";
import { ProgressModal, type ProgressModalHost } from "../progress-modal";
import { normalizeSettings, type LocalImageCompressSettings } from "../settings";
import { getLogTag, getPluginName, getVaultFolderPath, isPathInsideRoot, normalizeVaultPath, sanitizeErrorForUser } from "../utils";
import type { CompressionArtifactContext, CompressionBatchCallback, CompressionBatchResult, CompressionOperationInput, CompressionResult, CompressionValidationResult } from "../types";

export interface CompressionBatchOptions {
  signal?: AbortSignal;
  logErrors?: boolean;
  onFileStart?: CompressionBatchCallback;
  onAlreadyCompressed?: CompressionBatchCallback;
  onValidationSkipped?: CompressionBatchCallback<CompressionValidationResult>;
  onCompressed?: CompressionBatchCallback<CompressionResult>;
  onCacheUpdated?: CompressionBatchCallback<CompressionResult>;
  onCompressionSkipped?: CompressionBatchCallback<CompressionResult>;
  onCompressionError?: CompressionBatchCallback<CompressionResult>;
  onError?: CompressionBatchCallback<unknown>;
  onFatalError?: (error: unknown, total: number) => void | Promise<void>;
}

export interface BatchCompressionHost extends ProgressModalHost {
  readonly manifest?: { readonly name?: string };
  readonly settings: LocalImageCompressSettings;
  readonly moveService: { readonly moveOperationInProgress: boolean };
  readonly cache: {
    isFileAlreadyProcessed(file: obsidian.TFile): Promise<boolean>;
    addCompressionArtifact(artifact: CompressionArtifactContext): Promise<boolean>;
    createBackup(): Promise<unknown>;
  };
  readonly compressor: {
    compress(file: obsidian.TFile, settings: LocalImageCompressSettings, operation: CompressionOperationInput): Promise<CompressionResult>;
  };
  readonly imageScanner: { getImagesInNote(file: obsidian.TFile): Promise<obsidian.TFile[]> };
  readonly statusBarController: { update(): Promise<void> };
  readonly isUnloading: boolean;
  compressionWorkflowsInFlight: number;
  backgroundCompressionNoticeAt: number;
  readonly BACKGROUND_COMPRESSION_NOTICE_COOLDOWN_MS: number;
  validateFileForCompression(file: obsidian.TFile): Promise<CompressionValidationResult>;
  runLimitedCompression<T>(task: () => Promise<T>): Promise<T>;
  updateImageIndexForFile(file: obsidian.TAbstractFile | null | undefined): Promise<void>;
  isSkippableCompressionFailure(result: CompressionResult): boolean;
  handleSkippedCompression(file: obsidian.TFile, result: CompressionResult, settings: LocalImageCompressSettings, path: string): Promise<void>;
  updateSavingsIndicatorInSettings(): Promise<void>;
  withCompressionGuards<T>(task: () => Promise<T>): Promise<T>;
  runCompressionBatch(files: obsidian.TFile[], options?: CompressionBatchOptions): Promise<CompressionBatchResult>;
  scheduleStatusBarUpdate(reason?: string): void;
  maybeAutoMoveCompressed(): Promise<void>;
  trackManagedModal<T extends { close: () => void }>(modal: T): T;
  processBatchCompression(files: obsidian.TFile[], title: string): Promise<void>;
  showFolderSelector(folderPaths: string[]): Promise<string | null>;
  compressImagesInFolderPath(folderPath: string, isRecursive?: boolean): Promise<void>;
  filterUnprocessedImageFiles(files: obsidian.TFile[]): Promise<obsidian.TFile[]>;
}

// Owns batch compression orchestration: the core batch runner, the background and
// modal batch flows, and the note/folder/vault entry points. Cross-cluster calls go
// through the host's thin delegators so instance-level test mocks keep intercepting
// them; the host contract exposes only capabilities used by this service.
export class BatchCompressionService {
  constructor(private readonly plugin: BatchCompressionHost) {}

  async runCompressionBatch(files: obsidian.TFile[], options: CompressionBatchOptions = {}): Promise<CompressionBatchResult> {
    if (this.plugin.moveService.moveOperationInProgress) {
      new obsidian.Notice(`${getPluginName(this.plugin)}: ${t(this.plugin.app, "notice.compressionDeferredDueToMove")}`);
      return {
        compressed: 0,
        processed: 0,
        skippedAlreadyCompressed: 0,
        skippedValidation: files.length,
        skippedErrors: 0,
        cancelled: false
      };
    }
    this.plugin.compressionWorkflowsInFlight++;
    try {
      // Snapshot defensively because UI/event mutations can happen between load/save and compression start.
      const settingsSnapshot: LocalImageCompressSettings = normalizeSettings(this.plugin.settings);
      let fatalError: unknown = null;
      let fatalErrorReported = false;
      const runReportingStep = async (label: string, operation: (() => unknown) | undefined) => {
        if (!operation) {
          return;
        }
        try {
          await operation();
        } catch (error) {
          console.warn(getLogTag(this.plugin), `Batch ${label} reporting failed:`, error);
        }
      };
      const reportFatalError = async (error: unknown) => {
        if (fatalErrorReported) {
          return;
        }
        fatalErrorReported = true;
        fatalError = error;
        await runReportingStep("fatal error", async () => await options.onFatalError?.(error, files.length));
        if (options.logErrors) {
          console.error(getLogTag(this.plugin), "WASM compressor initialization failed:", error);
        }
      };
      let compressed = 0;
      let started = 0;
      let completed = 0;
      let skippedAlreadyCompressed = 0;
      let skippedValidation = 0;
      let skippedErrors = 0;
      const isCancelled = () => options.signal?.aborted === true;
      const shouldStopBatch = () => fatalErrorReported || this.plugin.isUnloading || isCancelled();
      const getBatchAbortSkipReason = () => {
        if (fatalErrorReported) {
          return "fatal_batch_aborted";
        }
        if (isCancelled()) {
          return "cancelled_batch_aborted";
        }
        return "unloading_batch_aborted";
      };
      const processFile = async (file: obsidian.TFile) => {
        if (shouldStopBatch()) {
          if (fatalErrorReported) {
            skippedErrors++;
          }
          return;
        }
        const pathSnapshot = file?.path || "";
        const mtimeSnapshot = file.stat.mtime;
        let currentProcessed = 0;
        try {
          currentProcessed = ++started;
          await runReportingStep("file start", async () => await options.onFileStart?.(file, currentProcessed, files.length));
          if (shouldStopBatch()) {
            if (fatalErrorReported) {
              skippedErrors++;
            }
            return;
          }
          const isAlreadyCompressed = await this.plugin.cache.isFileAlreadyProcessed(file);
          if (shouldStopBatch()) {
            if (fatalErrorReported) {
              skippedErrors++;
            }
            return;
          }
          if (isAlreadyCompressed) {
            const completedProcessed = ++completed;
            skippedAlreadyCompressed++;
            await runReportingStep("already compressed", async () => await options.onAlreadyCompressed?.(file, completedProcessed, files.length));
            return;
          }
          const validation = await this.plugin.validateFileForCompression(file);
          if (!validation.valid) {
            const completedProcessed = ++completed;
            skippedValidation++;
            await runReportingStep("validation skip", async () => await options.onValidationSkipped?.(file, completedProcessed, files.length, validation));
            return;
          }
          if (shouldStopBatch()) {
            if (fatalErrorReported) {
              skippedErrors++;
            }
            return;
          }
          const result: CompressionResult = await this.plugin.runLimitedCompression<CompressionResult>(async () => {
            if (shouldStopBatch()) {
              return { success: false, skipReason: getBatchAbortSkipReason() };
            }
            return await this.plugin.compressor.compress(file, settingsSnapshot, {
              sourcePath: pathSnapshot,
              sourceMtime: mtimeSnapshot
            });
          });
          if (this.plugin.isUnloading) {
            return;
          }
          if (result.skipReason === "fatal_batch_aborted") {
            skippedErrors++;
            return;
          }
          if (result.skipReason === "cancelled_batch_aborted" || result.skipReason === "unloading_batch_aborted") {
            return;
          }
          if (result.success) {
            if (!result.artifact || !await this.plugin.cache.addCompressionArtifact(result.artifact)) {
              throw new Error("Compression artifact could not be committed to the cache");
            }
            compressed++;
            const completedProcessed = ++completed;
            await runReportingStep("compression success", async () => await options.onCompressed?.(file, completedProcessed, files.length, result));
            await runReportingStep("image index update", async () => await this.plugin.updateImageIndexForFile(file));
            await runReportingStep("cache update", async () => await options.onCacheUpdated?.(file, completedProcessed, files.length, result));
          } else if (result.skipReason === "wasm_init_failed") {
            await reportFatalError(result.error || "WASM compressor initialization failed");
            skippedErrors++;
          } else if (this.plugin.isSkippableCompressionFailure(result)) {
            await this.plugin.handleSkippedCompression(file, result, settingsSnapshot, pathSnapshot);
            const completedProcessed = ++completed;
            skippedValidation++;
            await runReportingStep("compression skip", async () => await options.onCompressionSkipped?.(file, completedProcessed, files.length, result));
          } else {
            const completedProcessed = ++completed;
            skippedErrors++;
            await runReportingStep("compression error", async () => await options.onCompressionError?.(file, completedProcessed, files.length, result));
          }
        } catch (error) {
          const completedProcessed = ++completed;
          skippedErrors++;
          await runReportingStep("unexpected error", async () => await options.onError?.(file, completedProcessed, files.length, error));
          if (options.logErrors) {
            console.error(getLogTag(this.plugin), `Error: ${file.name}`, error);
          }
        }
      };
      await Promise.all(files.map((file) => processFile(file)));

      if (!this.plugin.isUnloading && compressed > 0) {
        await runReportingStep("cache backup", async () => await this.plugin.cache.createBackup());
        await runReportingStep("settings savings update", async () => await this.plugin.updateSavingsIndicatorInSettings());
      }
      return {
        compressed,
        processed: completed,
        skippedAlreadyCompressed,
        skippedValidation,
        skippedErrors,
        cancelled: isCancelled(),
        ...(fatalError ? { fatalError } : {})
      };
    } finally {
      this.plugin.compressionWorkflowsInFlight--;
    }
  }
  // Batch compression in background (no modal)
  async processBatchCompressionBackground(files: obsidian.TFile[]) {
    const now = Date.now();
    const noticeDue = now < this.plugin.backgroundCompressionNoticeAt || now - this.plugin.backgroundCompressionNoticeAt >= this.plugin.BACKGROUND_COMPRESSION_NOTICE_COOLDOWN_MS;
    const shouldNotify = files.length >= 5 && noticeDue;
    if (shouldNotify) {
      this.plugin.backgroundCompressionNoticeAt = now;
      this.runPresentationStep("background start notice", () => {
        new obsidian.Notice(`${getPluginName(this.plugin)}: ${t(this.plugin.app, "background.starting", { count: files.length })}`, 3000);
      });
    }
    const result = await this.plugin.withCompressionGuards(
      async () => {
        return await this.plugin.runCompressionBatch(files, {
        logErrors: true,
        onFatalError: async () => {
          this.plugin.scheduleStatusBarUpdate("background-compress-init-failed");
        },
        onCacheUpdated: async () => {
          this.plugin.scheduleStatusBarUpdate("background-compress");
        }
        });
      }
    );
    if (result?.compressed > 0) {
      await this.plugin.maybeAutoMoveCompressed();
    }
    if (shouldNotify) {
      const compressed = Number(result?.compressed || 0);
      this.runPresentationStep("background finish notice", () => {
        new obsidian.Notice(`${getPluginName(this.plugin)}: ${t(this.plugin.app, "background.finished", { count: compressed })}`, 5000);
      });
    }
  }
  private runPresentationStep(label: string, operation: () => unknown) {
    try {
      operation();
    } catch (error) {
      console.warn(getLogTag(this.plugin), `Batch ${label} failed:`, error);
    }
  }
  async processBatchCompression(files: obsidian.TFile[], title: string) {
    const result = await this.plugin.withCompressionGuards(
      async () => {
        const progressModal = this.plugin.trackManagedModal(new ProgressModal(this.plugin, title));
        const abortController = new AbortController();
        let fatalError: unknown = null;
        let batchResult: CompressionBatchResult | null = null;
        progressModal.setAbortController(abortController);
        progressModal.open();
        progressModal.updateProgress(0, files.length, t(this.plugin.app, "progress.start"));
        try {
          batchResult = await this.plugin.runCompressionBatch(files, {
            signal: abortController.signal,
            onFileStart: async (file) => {
              progressModal.setStatus(`${t(this.plugin.app, "progress.processing")}: ${file.name}`);
            },
            onAlreadyCompressed: async (file, processed, total) => {
              progressModal.updateProgress(processed, total, `${t(this.plugin.app, "progress.skippedAlready")}: ${file.name}`);
            },
            onValidationSkipped: async (file, processed, total) => {
              progressModal.updateProgress(processed, total, `${t(this.plugin.app, "progress.skipped")}: ${file.name}`);
            },
            onCompressed: async (file, processed, total, compressionResult) => {
              progressModal.updateProgress(processed, total, `${t(this.plugin.app, "progress.compressed")} (${compressionResult?.savings ?? 0}%): ${file.name}`);
            },
            onCompressionSkipped: async (file, processed, total) => {
              progressModal.updateProgress(processed, total, `${t(this.plugin.app, "progress.skipped")}: ${file.name}`);
            },
            onCompressionError: async (file, processed, total) => {
              progressModal.updateProgress(processed, total, `${t(this.plugin.app, "progress.skipped")}: ${file.name}`);
            },
            onError: async (file, processed, total) => {
              progressModal.updateProgress(processed, total, `${t(this.plugin.app, "progress.error")}: ${file.name}`);
            },
            onFatalError: async (error) => {
              fatalError = error;
              const errorMessage = `${t(this.plugin.app, "warning.wasmInitFailed")}: ${sanitizeErrorForUser(error)}`;
              progressModal.setError(errorMessage);
              new obsidian.Notice(`${getPluginName(this.plugin)}: ${errorMessage}`);
            }
          });
        } catch (error) {
          fatalError = error;
          const errorMessage = `${t(this.plugin.app, "progress.error")}: ${sanitizeErrorForUser(error)}`;
          progressModal.setError(errorMessage);
          new obsidian.Notice(`${getPluginName(this.plugin)}: ${errorMessage}`);
          console.error(getLogTag(this.plugin), "Batch compression failed unexpectedly:", error);
        }
        if (!fatalError && batchResult) {
          try {
            if (batchResult.cancelled) {
              progressModal.setCancelled(`${t(this.plugin.app, "progress.cancelled")} ${batchResult.compressed}/${files.length}`);
            } else {
              progressModal.setCompleted(`${t(this.plugin.app, "progress.completed")} ${batchResult.compressed}/${files.length}`);
            }
          } catch (error) {
            console.warn(getLogTag(this.plugin), "Batch completion presentation failed:", error);
          }
        }
        return batchResult || {
          compressed: 0,
          processed: 0,
          skippedAlreadyCompressed: 0,
          skippedValidation: 0,
          skippedErrors: files.length,
          cancelled: abortController.signal.aborted
        };
      }
    );
    if (!this.plugin.isUnloading) {
      try {
        await this.plugin.statusBarController.update();
      } catch (error) {
        console.warn(getLogTag(this.plugin), "Post-batch status bar update failed:", error);
      }
    }
    if (result?.compressed > 0) {
      await this.plugin.maybeAutoMoveCompressed();
    }
  }
  async compressImagesInNote() {
    const activeFile = this.plugin.app.workspace.getActiveFile();
    if (!activeFile) {
      new obsidian.Notice(`${getPluginName(this.plugin)}: ${t(this.plugin.app, "command.compressInNote")}`);
      return;
    }
    const images = await this.plugin.imageScanner.getImagesInNote(activeFile);
    if (images.length === 0) {
      new obsidian.Notice(`${getPluginName(this.plugin)}: ${t(this.plugin.app, "stats.uncompressed.name")}`);
      return;
    }
    await this.plugin.processBatchCompression(images, t(this.plugin.app, "command.compressInNote"));
  }
  async compressImagesInFolder() {
    const folders = this.plugin.app.vault.getAllLoadedFiles().filter((file): file is obsidian.TFolder => file instanceof obsidian.TFolder);
    if (folders.length === 0) {
      new obsidian.Notice(`${getPluginName(this.plugin)}: ${t(this.plugin.app, "folders.noneInVault")}`);
      return;
    }
    const folderPaths = Array.from(new Set(["/", ...folders.map((folder) => folder.path).filter((folderPath) => folderPath)]));
    const selectedPath = await this.plugin.showFolderSelector(folderPaths);
    if (selectedPath === null)
      return;
    await this.plugin.compressImagesInFolderPath(selectedPath);
  }
  async compressAllImages() {
    await this.plugin.compressImagesInFolderPath("/", true);
  }
  async compressImagesInFolderPath(folderPath: string, isRecursive = false) {
    const allFiles = this.plugin.app.vault.getFiles();
    let targetFiles;
    if (folderPath === "/") {
      targetFiles = allFiles;
    } else {
      targetFiles = allFiles.filter((file) => {
        if (isRecursive) {
          const normalizedFolderPath = normalizeVaultPath(folderPath).replace(/^\/+|\/+$/g, "");
          return isPathInsideRoot(file.path, normalizedFolderPath);
        } else {
          const normalizedFolderPath = normalizeVaultPath(folderPath).replace(/^\/+|\/+$/g, "");
          return getVaultFolderPath(file.path) === normalizedFolderPath;
        }
      });
    }
    const imageFiles = await this.plugin.filterUnprocessedImageFiles(targetFiles);
    if (imageFiles.length === 0) {
      new obsidian.Notice(`${this.plugin.manifest?.name || "Local Image Compress"}: ${t(this.plugin.app, "stats.uncompressed.name")}`);
      return;
    }
    await this.plugin.processBatchCompression(imageFiles, t(this.plugin.app, "command.compressAll"));
  }
}
