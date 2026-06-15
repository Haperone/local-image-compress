import * as obsidian from "obsidian";
import * as fs3 from "fs";
import * as path3 from "path";
import { Cache } from "./cache";
import { ConcurrencyLimiter } from "./concurrency-limiter";
import { Compressor } from "./compressor";
import { BackgroundCompressionService } from "./background-compression-service";
import { getBackupStoragePaths, type BackupStoragePaths } from "./backup-storage";
import { ImageIndex } from "./image-index";
import { ImageScanner } from "./image-scanner";
import { getCurrentLang, preloadExternalLanguages, t } from "./i18n";
import { ProgressModal } from "./progress-modal";
import { PluginGuardService } from "./plugin-guard-service";
import { MoveService } from "./move-service";
import { SavingsCalculator, FILE_SIZE_THRESHOLDS, COMPRESSION_RATIOS } from "./savings-calculator";
import { StatusBarController } from "./status-bar-controller";
import { CommandRegistry } from "./services/command-registry";
import { EventRouter } from "./services/event-router";
import { MigrationRunner } from "./services/migration-runner";
import { FolderSelectorModal } from "./services/folder-selector-modal";
import { NewFileQueue } from "./services/new-file-queue";
import { CacheBackupsView } from "./services/cache-backups-view";
import {
  getInternalWorkerPoolSize,
  INTERNAL_MAX_IMAGE_PIXELS_MILLIONS,
  INTERNAL_MAX_INPUT_SIZE_MB,
  INTERNAL_PLUGIN_GUARD_TIMEOUT_MS,
  normalizeSettings,
  type LocalImageCompressSettings
} from "./settings";
import { SettingsTab } from "./settings-tab";
import { getActiveDocumentForApp, getActiveWindowForApp, getLogTag, getPluginName, getVaultBasePath, getVaultFolderPath, isAbsoluteFilesystemPath, isAllowedByRoots, isInsideOutputFolder, isPathInsideRoot, sanitizeErrorForUser, normalizeOutputFolder, normalizeVaultPath, normalizeVaultPathRoot } from "./utils";
import type { CompressionBatchCallback, CompressionBatchResult, CompressionResult, CompressionValidationResult, TimerHandle } from "./types";

interface CompressionBatchOptions {
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
type ManagedModal = { close: () => void };

const PLUGIN_ASYNC_FILTER_CONCURRENCY = 8;
const PLUGIN_BACKUP_DELETE_CONCURRENCY = 4;

export default class LocalImageCompressPlugin extends obsidian.Plugin {
  static currentLang: string;
  static FILE_SIZE_THRESHOLDS = FILE_SIZE_THRESHOLDS;
  static COMPRESSION_RATIOS = COMPRESSION_RATIOS;
  MIN_FILE_SIZE: number;
  SUPPORTED_IMAGE_EXTENSIONS: string[];
  statusUpdateTimer: TimerHandle | null;
  statusUpdateDebounceMs: number;
  statusUpdateMaxWaitMs: number;
  statusUpdateFirstQueuedAt: number;
  imageIndex: ImageIndex | null;
  imageIndexConfigKey: string;
  indexRefreshTimers: Map<string, TimerHandle>;
  readonly BACKGROUND_COMPRESSION_NOTICE_COOLDOWN_MS: number;
  readonly GHOST_CLEANUP_COMPRESSED_THRESHOLD: number;
  readonly STALE_CACHE_PRUNE_COMPRESSED_THRESHOLD: number;
  backgroundCompressionNoticeAt: number;
  ghostEntryDirtyCount: number;
  staleCacheDirtyCount: number;
  compressionLimiter: ConcurrencyLimiter;
  pluginsToDisableDuringCompression: string[];
  pluginGuardService: PluginGuardService;
  moveService: MoveService;
  imageScanner: ImageScanner;
  savingsCalculator: SavingsCalculator;
  backgroundCompressionService: BackgroundCompressionService;
  statusBarController: StatusBarController;
  migrationRunner: MigrationRunner;
  newFileQueue: NewFileQueue;
  cacheBackupsView: CacheBackupsView;
  isAutoMoveRunning: boolean;
  compressionWorkflowsInFlight: number;
  // Counts queued plus active limiter jobs; waitForCompressionIdle needs both.
  compressionJobsInFlight: number;
  isUnloading: boolean;
  isInitialized: boolean;
  initializationError: unknown;
  override settings: LocalImageCompressSettings;
  cache!: Cache;
  compressor!: Compressor;
  statusBarItem: HTMLElement | null;
  managedModals: Set<ManagedModal>;
  modalFocusTimers: Map<Window, Set<number>>;
  settingsTab: SettingsTab | null;
  initializationPromise: Promise<void> | null;

  constructor(app: obsidian.App, manifest: obsidian.PluginManifest) {
    super(app, manifest);
    this.MIN_FILE_SIZE = 1024;
    // 1KB
    this.SUPPORTED_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg"];
    this.statusUpdateTimer = null;
    this.statusUpdateDebounceMs = 750;
    this.statusUpdateMaxWaitMs = 2500;
    this.statusUpdateFirstQueuedAt = 0;
    this.imageIndex = null;
    this.imageIndexConfigKey = "";
    this.indexRefreshTimers = new Map();
    this.BACKGROUND_COMPRESSION_NOTICE_COOLDOWN_MS = 30 * 60 * 1000;
    this.GHOST_CLEANUP_COMPRESSED_THRESHOLD = 100;
    this.STALE_CACHE_PRUNE_COMPRESSED_THRESHOLD = 100;
    this.backgroundCompressionNoticeAt = 0;
    this.ghostEntryDirtyCount = 0;
    this.staleCacheDirtyCount = 0;
    this.compressionLimiter = new ConcurrencyLimiter(1);
    this.pluginsToDisableDuringCompression = ["obsidian-paste-image-rename"];
    this.pluginGuardService = new PluginGuardService(this);
    this.moveService = new MoveService(this);
    this.imageScanner = new ImageScanner(this);
    this.savingsCalculator = new SavingsCalculator(this);
    this.backgroundCompressionService = new BackgroundCompressionService(this);
    this.statusBarController = new StatusBarController(this);
    this.migrationRunner = new MigrationRunner(this);
    this.newFileQueue = new NewFileQueue(this);
    this.cacheBackupsView = new CacheBackupsView(this);
    this.isAutoMoveRunning = false;
    this.compressionWorkflowsInFlight = 0;
    this.compressionJobsInFlight = 0;
    this.isUnloading = false;
    this.isInitialized = false;
    this.initializationError = null;
    this.settings = normalizeSettings(undefined);
    this.statusBarItem = null;
    this.managedModals = new Set();
    this.modalFocusTimers = new Map();
    this.settingsTab = null;
    this.initializationPromise = null;
    if (!LocalImageCompressPlugin.currentLang) LocalImageCompressPlugin.currentLang = "en";
  }
  // ========================================================================
  // LIFECYCLE METHODS
  // ========================================================================
  async preloadExternalLanguageFiles() {
    LocalImageCompressPlugin.currentLang = getCurrentLang(this.app);
    await preloadExternalLanguages(this.app, LocalImageCompressPlugin.currentLang);
  }
  override onload(): void {
    this.isUnloading = false;
    this.isInitialized = false;
    this.initializationError = null;
    this.app.workspace.onLayoutReady(() => {
      this.startInitializationAfterLayoutReady();
    });
  }
  startInitializationAfterLayoutReady() {
    if (this.isUnloading || this.initializationPromise) {
      return;
    }
    this.initializationPromise = this.loadPlugin().catch((error: unknown) => {
      this.handleInitializationFailure(error);
    });
  }
  async loadPlugin() {
    await this.preloadExternalLanguageFiles();
    if (this.isUnloading) {
      return;
    }
    await this.initializePlugin();
    if (this.isUnloading) {
      this.cleanupRuntimeState();
      return;
    }
    this.setupStatusBar();
    this.setupEventListeners();
    this.registerCommands();
    this.settingsTab = new SettingsTab(this.app, this);
    this.addSettingTab(this.settingsTab);
    this.isInitialized = true;
    this.scheduleStartupImageIndexRebuild();
    this.scheduleStartupMaintenance();
  }
  override onunload() {
    this.isUnloading = true;
    this.cleanupRuntimeState();
  }

  handleInitializationFailure(error: unknown) {
    this.initializationError = error;
    this.isInitialized = false;
    this.isUnloading = true;
    console.error(getLogTag(this), "Plugin initialization failed:", error);
    try {
      this.statusBarItem?.hide?.();
      new obsidian.Notice(`${getPluginName(this)}: ${t(this.app, "init.failed")}`, 10000);
    } catch (noticeError) {
      console.warn(getLogTag(this), "Failed to show initialization failure notice:", noticeError);
    }
    this.cleanupRuntimeState();
  }

  cleanupRuntimeState() {
    this.statusBarController?.closeMenu?.();
    this.settingsTab?.dispose();
    this.closeManagedModals();
    this.pluginGuardService?.releaseAllGuards?.().catch((error: unknown) => {
      console.warn(getLogTag(this), "Failed to restore guarded plugins during unload:", error);
    });
    this.compressor?.destroy?.();
    try {
      this.cache?.lockWritesForUnload?.();
      this.cache?.flushPendingCacheSaveSync?.();
    } catch (error) {
      console.error(getLogTag(this), "Failed to flush cache on unload:", error);
    }
    this.backgroundCompressionService.cleanup();
    if (this.statusUpdateTimer) {
      this.clearWindowTimeout(this.statusUpdateTimer);
      this.statusUpdateTimer = null;
    }
    if (this.indexRefreshTimers) {
      for (const timer of this.indexRefreshTimers.values()) {
        this.clearWindowTimeout(timer);
      }
      this.indexRefreshTimers.clear();
    }
    for (const [ownerWindow, timers] of this.modalFocusTimers) {
      for (const timer of timers) {
        ownerWindow.clearTimeout(timer);
      }
    }
    this.modalFocusTimers.clear();
    this.newFileQueue.cleanup();
  }

  // ========================================================================
  // INITIALIZATION
  // ========================================================================
  async migrateLegacyPluginData() {
    await this.migrationRunner.migrateLegacyPluginData();
  }

  async initializePlugin() {
    await this.loadSettings();
    if (this.isUnloading) {
      return;
    }
    this.compressionLimiter = new ConcurrencyLimiter(
      getInternalWorkerPoolSize(this.getActiveWindow().navigator?.hardwareConcurrency)
    );
    await this.migrateLegacyPluginData();
    if (this.isUnloading) {
      return;
    }
    this.cache = new Cache(this.app, this.getBackupStoragePaths().cacheBackups);
    await this.cache.loadCache();
    if (this.isUnloading) {
      return;
    }
    this.cache.compressionSettingsProvider = (file, skipReason) => this.getCompressionSettingsKey(file, skipReason);
    this.cache.isUnloadingProvider = () => this.isUnloading;
    if (this.cache.brokenCacheBackupPath) {
      new obsidian.Notice(`${getPluginName(this)}: ${t(this.app, "cache.corruptSaved")} ${path3.basename(this.cache.brokenCacheBackupPath)}`);
    }
    this.compressor = new Compressor(this.settings, this.app);
    this.imageIndex = new ImageIndex(this.app, {
      getOutputFolder: () => this.getOutputFolder(),
      getAllowedRoots: () => this.settings.allowedRoots || [],
      getSupportedExtensions: () => this.SUPPORTED_IMAGE_EXTENSIONS,
      yieldToUi: () => this.yieldToUi(),
      batchSize: 150
    });
    this.imageIndexConfigKey = this.getImageIndexConfigKey();
  }

  scheduleStartupMaintenance() {
    const key = "startup-maintenance";
    this.clearIndexRefreshTimer(key);
    const timer = this.setWindowTimeout(async () => {
      this.indexRefreshTimers?.delete(key);
      await this.runStartupMaintenance();
    }, 1000);
    this.indexRefreshTimers?.set(key, timer);
  }

  scheduleStartupImageIndexRebuild() {
    this.queueStartupImageIndexRebuild();
  }

  queueStartupImageIndexRebuild() {
    const key = "startup-image-index";
    this.clearIndexRefreshTimer(key);
    const timer = this.setWindowTimeout(async () => {
      this.indexRefreshTimers?.delete(key);
      await this.runStartupImageIndexRebuild();
    }, 0);
    this.indexRefreshTimers?.set(key, timer);
  }

  async runStartupImageIndexRebuild() {
    if (this.isUnloading || !this.imageIndex || !this.cache) {
      return;
    }
    try {
      this.statusBarItem?.setText?.(t(this.app, "status.indexing"));
      await this.rebuildImageIndex("startup");
      if (!this.isUnloading) {
        await this.statusBarController.update();
      }
    } catch (error) {
      console.error(getLogTag(this), "Startup image-index rebuild failed:", error);
    }
  }

  async runStartupMaintenance() {
    let cacheChanged = false;
    if (this.settings.autoCleanupGhostsOnStart) {
      try {
        const removed = await this.cleanupGhostEntries();
        cacheChanged = cacheChanged || removed > 0;
      } catch (e) {
        console.error(getLogTag(this), 'Startup ghost cleanup error:', e);
      }
    }
    try {
      const pruned = await this.cache.pruneStaleCacheEntries(this.settings.cacheRetentionMonths);
      cacheChanged = cacheChanged || pruned > 0;
    } catch (e) {
      console.error(getLogTag(this), 'Startup cache retention error:', e);
    }
    try {
      const backupDir = this.getBackupStoragePaths().originalFilesBackups;
      if (this.settings.autoBackupsRetentionEnabled) {
        await this.moveService.applyBackupsRetention(backupDir);
      }
    } catch (e) {
      console.error(getLogTag(this), 'Startup backups cleanup error:', e);
    }

    if (this.settings.autoMoveCompressedEnabled) {
      try {
        await this.tryAutoMoveCompressed();
        cacheChanged = true;
      } catch (e) {
        console.error(getLogTag(this), 'Startup auto-move error:', e);
      }
    }
    if (cacheChanged) {
      await this.rebuildImageIndex("startup-maintenance");
      await this.statusBarController.update();
    }
  }

  async tryAutoMoveCompressed() {
    if (this.isAutoMoveRunning || this.settings.autoMoveCompressedEnabled !== true || this.isUnloading) {
      return;
    }
    this.isAutoMoveRunning = true;
    try {
      const count = await this.moveService.getCompressedFilesCount();
      if (count >= (this.settings.autoMoveCompressedThreshold || 1)) {
        await this.moveService.moveCompressedToFiles();
      }
    } catch (e) {
      console.error(getLogTag(this), 'tryAutoMoveCompressed error:', e);
    } finally {
      this.isAutoMoveRunning = false;
    }
  }
  getPluginDirectory() {
    const manifestDir = this.manifest.dir;
    const configDir = this.app.vault.configDir;
    const basePath = getVaultBasePath(this.app);
    if (manifestDir) {
      return isAbsoluteFilesystemPath(manifestDir)
        ? path3.resolve(manifestDir)
        : path3.resolve(basePath, manifestDir);
    }
    return path3.resolve(basePath, configDir, "plugins", "local-image-compress");
  }
  getBackupStoragePaths(): BackupStoragePaths {
    return getBackupStoragePaths(this.app);
  }
  isAbsoluteFilesystemPath(filePath: string) {
    return isAbsoluteFilesystemPath(filePath);
  }
  getActiveWindow() {
    return getActiveWindowForApp(this.app) || window;
  }
  getActiveDocument() {
    return getActiveDocumentForApp(this.app)
      || this.getActiveWindow().document
      || window.document;
  }
  setWindowTimeout(callback: (...args: never[]) => unknown, delay: number, ownerWindow: Window = window) {
    return ownerWindow.setTimeout(callback, delay);
  }
  requestWindowAnimationFrame(callback: FrameRequestCallback) {
    const ownerWindow = this.statusBarItem?.win || this.getActiveWindow();
    if (ownerWindow.requestAnimationFrame) {
      return ownerWindow.requestAnimationFrame(callback);
    }
    return this.setWindowTimeout(callback, 0, ownerWindow);
  }
  clearWindowTimeout(timer: TimerHandle | null | undefined, ownerWindow: Window = window) {
    if (timer === null || timer === undefined) {
      return;
    }
    ownerWindow.clearTimeout(timer as number);
  }
  async yieldToUi() {
    await new Promise((resolve) => {
      try {
        this.setWindowTimeout(() => resolve(undefined), 0);
      } catch (error) {
        console.debug(getLogTag(this), "yield timer scheduling failed (non-critical)", error);
        window.setTimeout(() => resolve(undefined), 0);
      }
    });
  }
  getImageIndexConfigKey() {
    const allowedRoots = [...(this.settings?.allowedRoots || [])]
      .map((root) => normalizeVaultPathRoot(root))
      .sort((left, right) => left.localeCompare(right));
    return JSON.stringify({
      outputFolder: this.getOutputFolder(),
      allowedRoots
    });
  }
  async rebuildImageIndex(reason = "manual") {
    if (!this.imageIndex || !this.cache) {
      return;
    }
    try {
      await this.imageIndex.rebuild(this.cache);
    } catch (error) {
      console.error(getLogTag(this), `rebuildImageIndex failed (${reason}):`, error);
    }
  }
  async updateImageIndexForFile(file: obsidian.TAbstractFile | null | undefined) {
    if (!this.imageIndex || !this.cache || !file?.path) {
      return;
    }
    if (!this.isImageFile(file)) {
      this.removeImageIndexFile(file.path);
      return;
    }
    await this.imageIndex.upsert(file, this.cache);
  }
  async renameImageIndexFile(file: obsidian.TAbstractFile | null | undefined, oldPath: string) {
    if (!this.imageIndex || !this.cache) {
      return;
    }
    if (!this.isImageFile(file)) {
      this.removeImageIndexFile(oldPath);
      return;
    }
    await this.imageIndex.rename(file, oldPath, this.cache);
  }
  async refreshImageIndexProcessedStates() {
    if (!this.imageIndex || !this.cache) {
      return;
    }
    await this.imageIndex.refreshProcessedStates(this.cache);
  }
  removeImageIndexFile(filePath: string) {
    this.imageIndex?.remove(filePath);
  }
  clearIndexRefreshTimer(key: string) {
    const existing = this.indexRefreshTimers?.get(key);
    if (existing) {
      this.clearWindowTimeout(existing);
      this.indexRefreshTimers.delete(key);
    }
  }
  scheduleImageIndexRefresh(filePath: string | null | undefined, reason = "index-refresh") {
    if (!filePath) {
      return;
    }
    const normalizedPath = normalizeVaultPathRoot(filePath);
    const key = `file:${normalizedPath}`;
    this.clearIndexRefreshTimer(key);
    const timer = this.setWindowTimeout(async () => {
      this.indexRefreshTimers?.delete(key);
      const freshFile = this.app.vault.getAbstractFileByPath(normalizedPath);
      if (freshFile) {
        await this.updateImageIndexForFile(freshFile);
      } else {
        this.removeImageIndexFile(normalizedPath);
      }
      this.scheduleStatusBarUpdate(reason);
    }, 250);
    this.indexRefreshTimers?.set(key, timer);
  }
  scheduleImageIndexProcessedRefresh(reason = "processed-refresh") {
    const key = `processed:${reason}`;
    this.clearIndexRefreshTimer(key);
    const timer = this.setWindowTimeout(async () => {
      this.indexRefreshTimers?.delete(key);
      await this.refreshImageIndexProcessedStates();
      this.scheduleStatusBarUpdate(reason);
    }, 250);
    this.indexRefreshTimers?.set(key, timer);
  }
  isOutputFolderPath(filePath: string | null | undefined) {
    return isInsideOutputFolder(filePath || "", this.getOutputFolder());
  }
  scheduleStatusBarUpdate(_reason = "change") {
    const now = Date.now();
    if (!this.statusUpdateFirstQueuedAt) {
      this.statusUpdateFirstQueuedAt = now;
    }
    if (this.statusUpdateTimer && now - this.statusUpdateFirstQueuedAt < this.statusUpdateMaxWaitMs) {
      return;
    }
    const delay = now - this.statusUpdateFirstQueuedAt >= this.statusUpdateMaxWaitMs ? 0 : this.statusUpdateDebounceMs;
    if (this.statusUpdateTimer) {
      this.clearWindowTimeout(this.statusUpdateTimer);
    }
    this.statusUpdateTimer = this.setWindowTimeout(async () => {
      this.statusUpdateTimer = null;
      this.statusUpdateFirstQueuedAt = 0;
      await this.statusBarController.update();
    }, delay);
  }
  async runLimitedCompression<T>(task: () => Promise<T>): Promise<T> {
    this.compressionJobsInFlight++;
    try {
      return await this.compressionLimiter.run(task);
    } finally {
      this.compressionJobsInFlight--;
    }
  }
  async waitForCompressionIdle(maxWaitMs = 60_000) {
    const start = Date.now();
    while ((this.compressionWorkflowsInFlight > 0 || this.compressionJobsInFlight > 0) && !this.isUnloading) {
      if (Date.now() - start >= maxWaitMs) {
        console.warn(getLogTag(this), `waitForCompressionIdle giving up after ${maxWaitMs}ms`, {
          workflows: this.compressionWorkflowsInFlight,
          jobs: this.compressionJobsInFlight
        });
        return;
      }
      await this.waitForCompressionIdleTick();
    }
  }
  async waitForCompressionIdleTick() {
    await new Promise((resolve) => {
      try {
        window.setTimeout(resolve, 0);
        return;
      } catch (error) {
        console.warn(getLogTag(this), "waitForCompressionIdleTick failed:", error);
      }
      window.setTimeout(() => resolve(undefined), 10);
    });
  }
  async withCompressionGuards<T>(task: () => Promise<T>) {
    return await this.pluginGuardService.withDisabled(this.pluginsToDisableDuringCompression, task);
  }
  setupEventListeners() {
    new EventRouter(this).registerAll();
  }
  async handleLocaleConfigChanged() {
    const next = getCurrentLang(this.app);
    if (next !== LocalImageCompressPlugin.currentLang) {
      LocalImageCompressPlugin.currentLang = next;
      try {
        await this.updateSavingsIndicatorInSettings?.();
      } catch (error) {
        console.debug(getLogTag(this), "settings rerender after lang switch failed (non-critical)", error);
      }
      this.scheduleStatusBarUpdate?.("config-language");
    }
  }
  handleFileMenu(menu: obsidian.Menu, file: obsidian.TAbstractFile) {
    if (file instanceof obsidian.TFile) {
      this.addContextMenu(menu, file);
    } else if (file instanceof obsidian.TFolder) {
      this.addFolderContextMenu(menu, file);
    }
  }
  async handleVaultCreate(file: obsidian.TAbstractFile) {
    if (this.isUnloading || !this.isInitialized) {
      return;
    }
    this.imageScanner.invalidateImageLookupCache();
    if (this.isOutputFolderPath(file?.path)) {
      await this.refreshImageIndexProcessedStates();
      this.scheduleImageIndexProcessedRefresh("vault-create-output");
    } else {
      await this.updateImageIndexForFile(file);
      this.scheduleImageIndexRefresh(file?.path, "vault-create-stabilized");
    }
    this.scheduleStatusBarUpdate("vault-create");
    await this.handleNewFile(file);
  }
  async handleVaultDelete(file: obsidian.TAbstractFile) {
    this.imageScanner.invalidateImageLookupCache();
    this.cancelPendingNewFileCompression(file?.path);
    if (this.isOutputFolderPath(file?.path)) {
      await this.refreshImageIndexProcessedStates();
    } else {
      this.removeImageIndexFile(file?.path);
    }
    this.scheduleStatusBarUpdate("vault-delete");
  }
  async handleVaultRename(file: obsidian.TAbstractFile, oldPath: string) {
    this.imageScanner.invalidateImageLookupCache();
    this.cancelPendingNewFileCompression(oldPath);
    if (file instanceof obsidian.TFile && this.isImageFile(file) && !this.isOutputFolderPath(file.path) && !this.isOutputFolderPath(oldPath)) {
      await this.cache.renameCacheEntries(oldPath, file.path);
    }
    if (this.isOutputFolderPath(file?.path) || this.isOutputFolderPath(oldPath)) {
      await this.refreshImageIndexProcessedStates();
      this.scheduleImageIndexProcessedRefresh("vault-rename-output");
    } else {
      await this.renameImageIndexFile(file, oldPath);
      this.scheduleImageIndexRefresh(file?.path, "vault-rename-stabilized");
    }
    this.scheduleStatusBarUpdate("vault-rename");
  }
  async handleVaultModify(file: obsidian.TAbstractFile) {
    const isOutputPath = this.isOutputFolderPath(file?.path);
    const indexUpdatePromise = isOutputPath
      ? this.refreshImageIndexProcessedStates()
      : this.updateImageIndexForFile(file);
    if (isOutputPath) {
      this.scheduleImageIndexProcessedRefresh("vault-modify-output");
    } else {
      this.scheduleImageIndexRefresh(file?.path, "vault-modify-stabilized");
    }
    this.scheduleStatusBarUpdate("vault-modify");
    await indexUpdatePromise;
    if (this.newFileQueue.hasPendingOrTimer(file?.path)) {
      this.cancelPendingNewFileCompression(file?.path);
      await this.handleNewFile(file);
    }
  }
  async runCompressionBatch(files: obsidian.TFile[], options: CompressionBatchOptions = {}): Promise<CompressionBatchResult> {
    if (this.moveService.moveOperationInProgress) {
      new obsidian.Notice(`${getPluginName(this)}: ${t(this.app, "notice.compressionDeferredDueToMove")}`);
      return {
        compressed: 0,
        processed: 0,
        skippedAlreadyCompressed: 0,
        skippedValidation: files.length,
        skippedErrors: 0,
        cancelled: false
      };
    }
    this.compressionWorkflowsInFlight++;
    try {
      // Snapshot defensively because UI/event mutations can happen between load/save and compression start.
      const settingsSnapshot: LocalImageCompressSettings = normalizeSettings(this.settings);
      let fatalError: unknown = null;
      let fatalErrorReported = false;
      const reportFatalError = async (error: unknown) => {
        if (fatalErrorReported) {
          return;
        }
        fatalErrorReported = true;
        fatalError = error;
        await options.onFatalError?.(error, files.length);
        if (options.logErrors) {
          console.error(getLogTag(this), "WASM compressor initialization failed:", error);
        }
      };
      let compressed = 0;
      let started = 0;
      let completed = 0;
      let skippedAlreadyCompressed = 0;
      let skippedValidation = 0;
      let skippedErrors = 0;
      const isCancelled = () => options.signal?.aborted === true;
      const shouldStopBatch = () => fatalErrorReported || this.isUnloading || isCancelled();
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
        const mtimeSnapshot = file?.stat?.mtime;
        const sizeSnapshot = file?.stat?.size;
        let currentProcessed = 0;
        try {
          currentProcessed = ++started;
          await options.onFileStart?.(file, currentProcessed, files.length);
          if (shouldStopBatch()) {
            if (fatalErrorReported) {
              skippedErrors++;
            }
            return;
          }
          const isAlreadyCompressed = await this.cache.isFileAlreadyProcessed(file);
          if (shouldStopBatch()) {
            if (fatalErrorReported) {
              skippedErrors++;
            }
            return;
          }
          if (isAlreadyCompressed) {
            const completedProcessed = ++completed;
            await options.onAlreadyCompressed?.(file, completedProcessed, files.length);
            skippedAlreadyCompressed++;
            return;
          }
          const validation = await this.validateFileForCompression(file);
          if (!validation.valid) {
            const completedProcessed = ++completed;
            await options.onValidationSkipped?.(file, completedProcessed, files.length, validation);
            skippedValidation++;
            return;
          }
          if (shouldStopBatch()) {
            if (fatalErrorReported) {
              skippedErrors++;
            }
            return;
          }
          const result = await this.runLimitedCompression(async () => {
            if (shouldStopBatch()) {
              return { success: false, skipReason: getBatchAbortSkipReason() };
            }
            return await this.compressor.compress(file, settingsSnapshot, pathSnapshot);
          });
          if (this.isUnloading) {
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
            compressed++;
            const completedProcessed = ++completed;
            await options.onCompressed?.(file, completedProcessed, files.length, result);
            const cacheKey = await this.cache.getCacheKey(file, pathSnapshot, mtimeSnapshot);
            // Store original file size in cache
            await this.cache.addToCache(cacheKey, sizeSnapshot, file, this.savingsCalculator.getCompressedFilePath(pathSnapshot), pathSnapshot, mtimeSnapshot);
            await this.updateImageIndexForFile(file);
            await options.onCacheUpdated?.(file, completedProcessed, files.length, result);
          } else if (result.skipReason === "wasm_init_failed") {
            await reportFatalError(result.error || "WASM compressor initialization failed");
            skippedErrors++;
          } else if (this.isSkippableCompressionFailure(result)) {
            await this.handleSkippedCompression(file, result);
            const completedProcessed = ++completed;
            await options.onCompressionSkipped?.(file, completedProcessed, files.length, result);
            skippedValidation++;
          } else {
            const completedProcessed = ++completed;
            await options.onCompressionError?.(file, completedProcessed, files.length, result);
            skippedErrors++;
          }
        } catch (error) {
          const completedProcessed = ++completed;
          await options.onError?.(file, completedProcessed, files.length, error);
          if (options.logErrors) {
            console.error(getLogTag(this), `Error: ${file.name}`, error);
          }
          skippedErrors++;
        }
      };
      await Promise.all(files.map((file) => processFile(file)));

      if (!this.isUnloading && compressed > 0) {
        await this.cache.createBackup();
        // Update savings indicator in settings
        await this.updateSavingsIndicatorInSettings();
        await this.maybeCleanupGhostEntriesAfterCompression(compressed);
        if (await this.maybePruneStaleCacheEntriesAfterCompression(compressed) > 0) {
          await this.rebuildImageIndex("cache-retention");
        }
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
      this.compressionWorkflowsInFlight--;
    }
  }
  async maybeCleanupGhostEntriesAfterCompression(compressedCount: number) {
    if (this.isUnloading || !this.cache?.isAcceptingWrites?.()) {
      return 0;
    }
    const safeCompressedCount = typeof compressedCount === "number" && Number.isFinite(compressedCount) ? Math.max(0, Math.trunc(compressedCount)) : 0;
    if (safeCompressedCount <= 0) {
      return 0;
    }
    this.ghostEntryDirtyCount += safeCompressedCount;
    if (this.ghostEntryDirtyCount < this.GHOST_CLEANUP_COMPRESSED_THRESHOLD) {
      return 0;
    }
    try {
      const removedCount = await this.cleanupGhostEntries();
      this.ghostEntryDirtyCount = 0;
      return removedCount;
    } catch (error) {
      this.ghostEntryDirtyCount = this.GHOST_CLEANUP_COMPRESSED_THRESHOLD;
      console.error(getLogTag(this), "Automatic ghost cleanup error:", error);
      return 0;
    }
  }
  async maybePruneStaleCacheEntriesAfterCompression(compressedCount: number) {
    if (this.isUnloading || !this.cache?.isAcceptingWrites?.()) {
      return 0;
    }
    const safeCompressedCount = typeof compressedCount === "number" && Number.isFinite(compressedCount) ? Math.max(0, Math.trunc(compressedCount)) : 0;
    if (safeCompressedCount <= 0) {
      return 0;
    }
    this.staleCacheDirtyCount += safeCompressedCount;
    if (this.staleCacheDirtyCount < this.STALE_CACHE_PRUNE_COMPRESSED_THRESHOLD) {
      return 0;
    }
    try {
      const prunedCount = await this.cache.pruneStaleCacheEntries(this.settings.cacheRetentionMonths);
      this.staleCacheDirtyCount = 0;
      return prunedCount;
    } catch (error) {
      this.staleCacheDirtyCount = this.STALE_CACHE_PRUNE_COMPRESSED_THRESHOLD;
      console.error(getLogTag(this), "Automatic cache retention error:", error);
      return 0;
    }
  }
  // Batch compression in background (no modal)
  async processBatchCompressionBackground(files: obsidian.TFile[]) {
    const now = Date.now();
    const noticeDue = now < this.backgroundCompressionNoticeAt || now - this.backgroundCompressionNoticeAt >= this.BACKGROUND_COMPRESSION_NOTICE_COOLDOWN_MS;
    const shouldNotify = files.length >= 5 && noticeDue;
    if (shouldNotify) {
      this.backgroundCompressionNoticeAt = now;
      new obsidian.Notice(`${getPluginName(this)}: ${t(this.app, "background.starting", { count: files.length })}`, 3000);
    }
    const result = await this.withCompressionGuards(
      async () => {
        return await this.runCompressionBatch(files, {
        logErrors: true,
        onFatalError: async () => {
          this.scheduleStatusBarUpdate("background-compress-init-failed");
        },
        onCacheUpdated: async () => {
          this.scheduleStatusBarUpdate("background-compress");
        }
        });
      }
    );
    if (result?.compressed > 0) {
      await this.maybeAutoMoveCompressed();
    }
    if (shouldNotify) {
      const compressed = Number(result?.compressed || 0);
      new obsidian.Notice(`${getPluginName(this)}: ${t(this.app, "background.finished", { count: compressed })}`, 5000);
    }
  }
  async handleNewFile(file: obsidian.TAbstractFile) {
    await this.newFileQueue.handleNewFile(file);
  }
  cancelPendingNewFileCompression(filePath: string | null | undefined) {
    this.newFileQueue.cancelPendingNewFileCompression(filePath);
  }
  scheduleNewFileBatchDrain() {
    this.newFileQueue.scheduleNewFileBatchDrain();
  }
  async drainNewFileCompressionBatch() {
    await this.newFileQueue.drainNewFileCompressionBatch();
  }
  setupStatusBar() {
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.setText(t(this.app, "status.loading"));
    this.statusBarItem.setAttribute?.("role", "button");
    this.statusBarItem.setAttribute?.("tabindex", "0");
    this.statusBarItem.setAttribute?.("aria-haspopup", "menu");
    this.statusBarItem.setAttribute?.("aria-expanded", "false");
    this.statusBarItem.setAttribute?.("aria-live", "polite");
    this.statusBarItem.setAttribute?.("aria-atomic", "true");
    this.statusBarItem.addClass("tiny-local-status-trigger");
    this.statusBarItem.show();
    this.registerDomEvent(this.statusBarItem, "click", async (event: MouseEvent) => {
      event.preventDefault();
      await this.statusBarController.showMenu(event);
    });
    this.registerDomEvent(this.statusBarItem, "keydown", async (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      await this.statusBarController.showMenu({
        keyboard: true,
        returnFocusTo: this.statusBarItem,
        target: this.statusBarItem
      });
    });
    this.statusBarItem.setText(t(this.app, "status.indexing"));
  }
  getMonotonicTime() {
    return typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  }
  trackManagedModal<T extends { close: () => void }>(modal: T) {
    this.managedModals.add(modal);
    return modal;
  }
  captureModalFocusTarget(): HTMLElement | null {
    const documents = [
      this.getActiveDocument(),
      this.statusBarItem?.ownerDocument,
      this.getActiveWindow().document
    ];
    for (const candidateDocument of new Set(documents.filter((candidate): candidate is Document => !!candidate))) {
      const activeElement = candidateDocument.activeElement as HTMLElement | null;
      if (
        activeElement
        && activeElement !== candidateDocument.body
        && activeElement !== candidateDocument.documentElement
        && typeof activeElement.focus === "function"
      ) {
        return activeElement;
      }
    }
    return null;
  }
  scheduleElementFocus(target: HTMLElement | null | undefined) {
    if (!target) {
      return;
    }
    const ownerWindow = target.ownerDocument?.defaultView || this.getActiveWindow();
    const timer = ownerWindow.setTimeout(() => {
      const ownerTimers = this.modalFocusTimers.get(ownerWindow);
      ownerTimers?.delete(timer);
      if (ownerTimers?.size === 0) {
        this.modalFocusTimers.delete(ownerWindow);
      }
      if (!this.isUnloading && target.isConnected) {
        target.focus();
      }
    }, 0);
    const ownerTimers = this.modalFocusTimers.get(ownerWindow) || new Set<number>();
    ownerTimers.add(timer);
    this.modalFocusTimers.set(ownerWindow, ownerTimers);
  }
  restoreModalFocus(target: HTMLElement | null | undefined) {
    this.scheduleElementFocus(target);
  }
  untrackManagedModal(modal: ManagedModal) {
    this.managedModals.delete(modal);
  }
  closeManagedModals() {
    if (!this.managedModals) {
      return;
    }
    for (const modal of Array.from(this.managedModals)) {
      try {
        modal?.close?.();
      } catch (error) {
        console.warn(getLogTag(this), "Managed modal cleanup failed:", error);
      }
    }
    this.managedModals.clear();
  }
  // ========================================================================
  // SETTINGS MANAGEMENT
  // ========================================================================
  async loadSettings() {
    try {
      this.settings = normalizeSettings(await this.loadData());
    } catch (error) {
      console.error(getLogTag(this), "Failed to load settings; using defaults:", error);
      this.settings = normalizeSettings(undefined);
      new obsidian.Notice(`${getPluginName(this)}: ${t(this.app, "settings.loadFailed")}`, 10000);
    }
    this.applyRuntimeSettings();
  }
  async saveSettings() {
    // Re-normalize before save because UI/event mutations can temporarily violate settings invariants.
    this.settings = normalizeSettings(this.settings);
    this.applyRuntimeSettings();
    await this.saveData(this.settings);
    const nextIndexConfigKey = this.getImageIndexConfigKey();
    if (nextIndexConfigKey !== this.imageIndexConfigKey) {
      this.imageIndexConfigKey = nextIndexConfigKey;
      await this.rebuildImageIndex("settings");
    }
    this.scheduleStatusBarUpdate("settings");
  }
  applyRuntimeSettings() {
    this.backgroundCompressionService?.applySettings(
      this.settings.autoBackgroundThreshold ?? 50,
      (this.settings.inactivityThresholdMinutes ?? 2) * 60 * 1000
    );
    if (this.pluginGuardService) {
      this.pluginGuardService.operationTimeoutMs = INTERNAL_PLUGIN_GUARD_TIMEOUT_MS;
    }
    this.compressor?.applySettings?.(this.settings);
  }
  getOutputFolder() {
    // Empty string is not a valid output folder, so this fallback intentionally uses || instead of ??.
    return normalizeOutputFolder(this.settings?.outputFolder || "Compressed");
  }
  // ========================================================================
  // COMMAND REGISTRATION
  // ========================================================================
  registerCommands() {
    new CommandRegistry(this).registerAll();
  }
  // ========================================================================
  // CONTEXT MENU
  // ========================================================================
  addContextMenu(menu: obsidian.Menu, file: obsidian.TFile) {
    if (!this.isImageFile(file))
      return;
    if (this.isOutputFolderPath(file.path))
      return;
    menu.addItem((item) => {
      item.setTitle(t(this.app, "context.compressImage")).setIcon("compress").onClick(() => this.compressFile(file));
    });
  }
  addFolderContextMenu(menu: obsidian.Menu, folder: obsidian.TFolder) {
    if (isInsideOutputFolder(folder.path, this.getOutputFolder()))
      return;
    menu.addItem((item) => {
      item.setTitle(t(this.app, "context.compressImagesInFolder")).setIcon("images").onClick(() => this.compressImagesInFolderPath(folder.path));
    });
  }
  // ========================================================================
  // UTILITY METHODS
  // ========================================================================
  isImageFile(file: unknown): file is obsidian.TFile {
    const extension = typeof (file as Partial<obsidian.TFile> | null)?.extension === "string"
      ? (file as Partial<obsidian.TFile>).extension?.toLowerCase()
      : "";
    return !!extension && this.SUPPORTED_IMAGE_EXTENSIONS.includes(extension);
  }
  async isImageFileAndNotCompressed(file: obsidian.TFile) {
    if (!this.isImageFile(file)) {
      return false;
    }
    const isInOutputFolder = isInsideOutputFolder(file.path, this.getOutputFolder());
    if (isInOutputFolder) {
      return false;
    }
    if (!this.isAllowedPath(file.path)) {
      return false;
    }
    const isAlreadyCompressed = await this.cache.isFileAlreadyProcessed(file);
    return !isAlreadyCompressed;
  }
  async filterUnprocessedImageFiles(files: obsidian.TFile[], concurrency = PLUGIN_ASYNC_FILTER_CONCURRENCY) {
    const limiter = new ConcurrencyLimiter(concurrency);
    const checkedFiles = await Promise.all(files.map((file) =>
      limiter.run(async () => await this.isImageFileAndNotCompressed(file) ? file : null)
    ));
    return checkedFiles.filter((file): file is obsidian.TFile => file !== null);
  }
  /**
   * Returns every supported image file that is in scope for this plugin.
   * This is synchronous because it only uses vault/index state and does not consult compression cache freshness.
   */
  getAllImageFiles() {
    if (this.imageIndex?.isReady()) {
      return this.imageIndex.getAllFiles();
    }
    const allFiles = this.app.vault.getFiles();
    const outputFolder = this.getOutputFolder();
    
    // Optimization: use Array.filter instead of manual loop
    return allFiles.filter(file => {
      if (!this.isImageFile(file)) {
        return false;
      }
      
      // Ensure file is not inside the configured compressed files folder
      return !isInsideOutputFolder(file.path, outputFolder) && this.isAllowedPath(file.path);
    });
  }
  /**
   * Returns only uncompressed image files.
   * This is async because the index fallback performs bounded cache lookups.
   */
  async getImageFiles() {
    if (this.imageIndex?.isReady()) {
      return this.imageIndex.getUncompressedFiles();
    }
    return await this.filterUnprocessedImageFiles(this.getAllImageFiles());
  }
  isAllowedPath(filePath: string) {
    return isAllowedByRoots(filePath, this.settings.allowedRoots || []);
  }
  // ========================================================================
  // VALIDATION
  // ========================================================================
  async validateFileForCompression(file: obsidian.TFile): Promise<CompressionValidationResult> {
    if (!this.isImageFile(file)) {
      return { valid: false, error: t(this.app, "compress.error.unsupportedFormat") };
    }
    if (!this.isAllowedPath(file.path)) {
      return { valid: false, error: t(this.app, "validation.pathNotAllowed") };
    }
    if (this.isOutputFolderPath(file.path)) {
      return { valid: false, error: t(this.app, "validation.outputFolder") };
    }
    const isAlreadyCompressed = await this.cache.isFileAlreadyProcessed(file);
    if (isAlreadyCompressed) {
      return { valid: false, error: t(this.app, "validation.alreadyCompressed") };
    }
    const extension = String(file.extension || "").toLowerCase();
    const minSize = extension === "png" ? 5 * 1024 : 10 * 1024;
    if (file.stat.size < minSize) {
      await this.cache.addSkippedEntry(file.path, "too_small");
      await this.updateImageIndexForFile(file);
      return { valid: false, error: `${t(this.app, "validation.tooSmall")} (${file.stat.size} ${t(this.app, "validation.bytes")})`, skipped: true };
    }
    return { valid: true };
  }
  // ========================================================================
  // COMPRESSION METHODS
  // ========================================================================
  async compressFile(file: obsidian.TFile) {
    let shouldAutoMove = false;
    await this.withCompressionGuards(
      async () => {
        let countedWorkflow = false;
        try {
          if (this.isUnloading) {
            return;
          }
          if (this.moveService.moveOperationInProgress) {
            new obsidian.Notice(`${getPluginName(this)}: ${t(this.app, "progress.skipped")}`);
            return;
          }
          this.compressionWorkflowsInFlight++;
          countedWorkflow = true;
          const validation = await this.validateFileForCompression(file);
          if (!validation.valid) {
            if (validation.skipped) {
              return;
            } else {
              new obsidian.Notice(`${getPluginName(this)}: ${validation.error}`);
              return;
            }
          }
          if (this.isUnloading) {
            return;
          }
          const pathSnapshot = file.path;
          const mtimeSnapshot = file.stat?.mtime;
          const sizeSnapshot = file.stat?.size;
          const settingsSnapshot = normalizeSettings(this.settings);
          const result = await this.runLimitedCompression(() => this.compressor.compress(file, settingsSnapshot, pathSnapshot));
          if (this.isUnloading) {
            return;
          }
          if (result.success) {
            await this.handleSuccessfulCompression(file, result.savings, pathSnapshot, sizeSnapshot, mtimeSnapshot);
            shouldAutoMove = true;
          } else if (this.isSkippableCompressionFailure(result)) {
            await this.handleSkippedCompression(file, result);
          } else {
            new obsidian.Notice(`${getPluginName(this)}: ${sanitizeErrorForUser(result.error)}`);
          }
        } catch (error) {
          console.error(getLogTag(this), `Compression error for ${file?.path || file?.name || "unknown file"}:`, error);
          const fileLabel = file?.path || file?.name || "unknown file";
          new obsidian.Notice(`${getPluginName(this)}: ${t(this.app, "progress.error")} (${fileLabel})`);
        } finally {
          if (countedWorkflow) {
            this.compressionWorkflowsInFlight--;
          }
        }
      }
    );
    if (!this.isUnloading && shouldAutoMove) {
      await this.maybeAutoMoveCompressed();
    }
  }
  async handleSuccessfulCompression(file: obsidian.TFile, savings: number | undefined, pathSnapshot = file.path, sizeSnapshot = file.stat.size, mtimeSnapshot = file.stat.mtime) {
    const cacheKey = await this.cache.getCacheKey(file, pathSnapshot, mtimeSnapshot);
    // Store original file size in cache
    await this.cache.addToCache(cacheKey, sizeSnapshot, file, this.savingsCalculator.getCompressedFilePath(pathSnapshot), pathSnapshot, mtimeSnapshot);
    await this.cache.createBackup();
    await this.updateImageIndexForFile(file);
    if (await this.maybePruneStaleCacheEntriesAfterCompression(1) > 0) {
      await this.rebuildImageIndex("cache-retention");
    }
    await this.statusBarController.update();
    
    // Update savings indicator in settings if settings tab is open
    await this.updateSavingsIndicatorInSettings();
    
    const displaySavings = this.savingsCalculator.getDisplaySavingsPercentage(savings);
    if (displaySavings > 0) {
      new obsidian.Notice(`${getPluginName(this)}: ${displaySavings}%`);
    } else {
      new obsidian.Notice(`${getPluginName(this)}: ${t(this.app, "notice.cacheUpdated")}`);
    }
  }
  isSkippableCompressionFailure(result: CompressionResult) {
    return result?.skipReason === "pngquant_quality_failed" || result?.skipReason === "mozjpeg_failed" || result?.skipReason === "compressed_not_smaller" || result?.skipReason === "too_large";
  }
  getCompressionSettingsKey(file: obsidian.TFile, skipReason = "") {
    const reason = String(skipReason || "").trim();
    if (!reason) {
      return null;
    }
    const extension = String(file?.extension || "").toLowerCase();
    if (reason === "too_large") {
      return `${extension || "unknown"}:limits:${INTERNAL_MAX_INPUT_SIZE_MB}:${INTERNAL_MAX_IMAGE_PIXELS_MILLIONS}:${reason}`;
    }
    if (extension === "png") {
      return `png:${this.settings.pngQuality?.min}-${this.settings.pngQuality?.max}`;
    }
    if (extension === "jpg" || extension === "jpeg") {
      return `jpeg:${this.settings.jpegQuality}`;
    }
    return `${extension || "unknown"}:${reason}`;
  }
  async handleSkippedCompression(file: obsidian.TFile, result: CompressionResult) {
    await this.cache.addSkippedEntry(file.path, result.skipReason || "", this.getCompressionSettingsKey(file, result.skipReason || ""));
    await this.updateImageIndexForFile(file);
    await this.statusBarController.update();
  }
  async maybeAutoMoveCompressed() {
    if (this.settings.autoMoveCompressedEnabled === true && !this.isUnloading) {
      await this.tryAutoMoveCompressed();
    }
  }
  async autoCompressNewFile(file: obsidian.TFile) {
    let shouldAutoMove = false;
    await this.withCompressionGuards(
      async () => {
        let countedWorkflow = false;
        try {
          if (this.isUnloading) {
            return;
          }
          if (this.moveService.moveOperationInProgress) {
            return;
          }
          this.compressionWorkflowsInFlight++;
          countedWorkflow = true;
          const validation = await this.validateFileForCompression(file);
          if (!validation.valid) {
            return;
          }
          if (this.isUnloading) {
            return;
          }
          const pathSnapshot = file.path;
          const mtimeSnapshot = file.stat?.mtime;
          const sizeSnapshot = file.stat?.size;
          const settingsSnapshot = normalizeSettings(this.settings);
          const result = await this.runLimitedCompression(() => this.compressor.compress(file, settingsSnapshot, pathSnapshot));
          if (this.isUnloading) {
            return;
          }
          if (result.success) {
            await this.handleSuccessfulCompression(file, result.savings, pathSnapshot, sizeSnapshot, mtimeSnapshot);
            shouldAutoMove = true;
          } else if (this.isSkippableCompressionFailure(result)) {
            await this.handleSkippedCompression(file, result);
          }
        } catch (error) {
          console.error(getLogTag(this), "Auto-compression error:", error);
        } finally {
          if (countedWorkflow) {
            this.compressionWorkflowsInFlight--;
          }
        }
      }
    );
    if (!this.isUnloading && shouldAutoMove) {
      await this.maybeAutoMoveCompressed();
    }
  }
  // ========================================================================
  // BATCH COMPRESSION METHODS
  // ========================================================================
  async compressImagesInNote() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      new obsidian.Notice(`${getPluginName(this)}: ${t(this.app, "command.compressInNote")}`);
      return;
    }
    const images = await this.imageScanner.getImagesInNote(activeFile);
    if (images.length === 0) {
      new obsidian.Notice(`${getPluginName(this)}: ${t(this.app, "stats.uncompressed.name")}`);
      return;
    }
    await this.processBatchCompression(images, t(this.app, "command.compressInNote"));
  }
  async compressImagesInFolder() {
    const folders = this.app.vault.getAllLoadedFiles().filter((file): file is obsidian.TFolder => file instanceof obsidian.TFolder);
    if (folders.length === 0) {
      new obsidian.Notice(`${getPluginName(this)}: ${t(this.app, "folders.noneInVault")}`);
      return;
    }
    const folderPaths = Array.from(new Set(["/", ...folders.map((folder) => folder.path).filter((folderPath) => folderPath)]));
    const selectedPath = await this.showFolderSelector(folderPaths);
    if (selectedPath === null)
      return;
    await this.compressImagesInFolderPath(selectedPath);
  }
  async compressAllImages() {
    await this.compressImagesInFolderPath("/", true);
  }
  async processBatchCompression(files: obsidian.TFile[], title: string) {
    const result = await this.withCompressionGuards(
      async () => {
        const progressModal = this.trackManagedModal(new ProgressModal(this, title));
        const abortController = new AbortController();
        let fatalError: unknown = null;
        let batchResult: CompressionBatchResult | null = null;
        progressModal.setAbortController(abortController);
        progressModal.open();
        progressModal.updateProgress(0, files.length, t(this.app, "progress.start"));
        try {
          batchResult = await this.runCompressionBatch(files, {
            signal: abortController.signal,
            onFileStart: async (file) => {
              progressModal.setStatus(`${t(this.app, "progress.processing")}: ${file.name}`);
            },
            onAlreadyCompressed: async (file, processed, total) => {
              progressModal.updateProgress(processed, total, `${t(this.app, "progress.skippedAlready")}: ${file.name}`);
            },
            onValidationSkipped: async (file, processed, total) => {
              progressModal.updateProgress(processed, total, `${t(this.app, "progress.skipped")}: ${file.name}`);
            },
            onCompressed: async (file, processed, total, compressionResult) => {
              progressModal.updateProgress(processed, total, `${t(this.app, "progress.compressed")} (${compressionResult?.savings ?? 0}%): ${file.name}`);
            },
            onCompressionSkipped: async (file, processed, total) => {
              progressModal.updateProgress(processed, total, `${t(this.app, "progress.skipped")}: ${file.name}`);
            },
            onCompressionError: async (file, processed, total) => {
              progressModal.updateProgress(processed, total, `${t(this.app, "progress.skipped")}: ${file.name}`);
            },
            onError: async (file, processed, total) => {
              progressModal.updateProgress(processed, total, `${t(this.app, "progress.error")}: ${file.name}`);
            },
            onFatalError: async (error) => {
              fatalError = error;
              const errorMessage = `${t(this.app, "warning.wasmInitFailed")}: ${sanitizeErrorForUser(error)}`;
              progressModal.setError(errorMessage);
              new obsidian.Notice(`${getPluginName(this)}: ${errorMessage}`);
            }
          });
        } catch (error) {
          fatalError = error;
          const errorMessage = `${t(this.app, "progress.error")}: ${sanitizeErrorForUser(error)}`;
          progressModal.setError(errorMessage);
          new obsidian.Notice(`${getPluginName(this)}: ${errorMessage}`);
          console.error(getLogTag(this), "Batch compression failed unexpectedly:", error);
        }
        if (!fatalError && batchResult) {
          if (batchResult.cancelled) {
            progressModal.setCancelled(`${t(this.app, "progress.cancelled")} ${batchResult.compressed}/${files.length}`);
          } else {
            progressModal.setCompleted(`${t(this.app, "progress.completed")} ${batchResult.compressed}/${files.length}`);
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
    if (!this.isUnloading) {
      await this.statusBarController.update();
    }
    if (result?.compressed > 0) {
      await this.maybeAutoMoveCompressed();
    }
  }
  // ========================================================================
  // FOLDER SELECTION
  // ========================================================================
  showFolderSelector(folderPaths: string[]): Promise<string | null> {
    return FolderSelectorModal.show(this, folderPaths);
  }
  async compressImagesInFolderPath(folderPath: string, isRecursive = false) {
    const allFiles = this.app.vault.getFiles();
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
    const imageFiles = await this.filterUnprocessedImageFiles(targetFiles);
    if (imageFiles.length === 0) {
      new obsidian.Notice(`${this.manifest?.name || "Local Image Compress"}: ${t(this.app, "stats.uncompressed.name")}`);
      return;
    }
    await this.processBatchCompression(imageFiles, t(this.app, "command.compressAll"));
  }
  // ========================================================================
  // STATISTICS
  // ========================================================================
  async getImageCompressionCounts() {
    if (this.imageIndex?.isReady()) {
      return this.imageIndex.getSnapshot();
    }
    const imageFiles = this.getAllImageFiles();
    const uncompressedImages = (await this.filterUnprocessedImageFiles(imageFiles)).length;
    return {
      totalImages: imageFiles.length,
      uncompressedImages
    };
  }
  async getStatsSnapshot() {
    const imageStats = await this.savingsCalculator.collectImageStats(this.getAllImageFiles());
    const [ghostCount, compressedFilesCount] = await Promise.all([
      this.getGhostEntriesCount(),
      this.moveService.getCompressedFilesCount()
    ]);
    return {
      ...imageStats,
      cacheStats: this.cache.getCacheStats(),
      ghostCount,
      compressedFilesCount
    };
  }
  
  async updateSavingsIndicatorInSettings() {
    try {
      await this.settingsTab?.refreshStatsIfVisible();
    } catch (error) {
      console.error(getLogTag(this), "Settings indicator update error:", error);
    }
  }
  // Force refresh of cache and status bar
  async forceRefreshCache() {
    const progressModal = this.trackManagedModal(new ProgressModal(this, t(this.app, "common.refreshCache")));
    progressModal.open();
    try {
      progressModal.setStatus(t(this.app, "common.refreshCache"));
      await this.cache.forceRefreshCache();
      progressModal.setStatus(t(this.app, "status.indexing"));
      await this.rebuildImageIndex("cache-refresh");
      progressModal.setStatus(t(this.app, "progress.completed"));
      await this.statusBarController.update();
      progressModal.setCompleted(t(this.app, "progress.completed"));
    } catch (error) {
      progressModal.setError(sanitizeErrorForUser(error));
      throw error;
    }
  }
  // Get number of ghost entries in cache
  async getGhostEntriesCount() {
    return await this.cache.getGhostEntriesCount();
  }
  // Remove ghost entries from cache
  async cleanupGhostEntries() {
    const removedCount = await this.cache.cleanupGhostEntries();
    await this.rebuildImageIndex("cleanup-ghosts");
    await this.statusBarController.update();
    return removedCount;
  }
  // ========================================================================
  // STATUS BAR
  // ========================================================================
  // ========================================================================
  // BACKUP MANAGEMENT
  // ========================================================================
  async showCacheBackupsList() {
    await this.cacheBackupsView.showCacheBackupsList();
  }
  
  // ========================================================================
  // MOVE BACKUP MANAGEMENT
  // ========================================================================

  async clearOriginalFilesBackups() {
    try {
      const backupDir = this.getBackupStoragePaths().originalFilesBackups;
      
      const exists = await fs3.promises.access(backupDir).then(() => true).catch(() => false);
      if (!exists) {
        new obsidian.Notice(`${getPluginName(this)}: ${t(this.app, "backups.imagesFolder.notFound")}`);
        return;
      }
      
      const backups = await fs3.promises.readdir(backupDir, { withFileTypes: true });
      
      if (backups.length === 0) {
        new obsidian.Notice(`${getPluginName(this)}: ${t(this.app, "backups.imagesFolder.noneToDelete")}`);
        return;
      }
      
      const backupDeleteLimiter = new ConcurrencyLimiter(PLUGIN_BACKUP_DELETE_CONCURRENCY);
      const deleteResults = await Promise.allSettled(backups.map((backup) => backupDeleteLimiter.run(async () => {
        const backupPath = path3.join(backupDir, backup.name);
        if (backup.isDirectory()) {
          await this.moveService.deleteDirectoryRecursiveAsync(backupPath);
          return true;
        }
        if (backup.isFile()) {
          await fs3.promises.unlink(backupPath);
        }
        return false;
      })));
      const failedDelete = deleteResults.find((result) => result.status === "rejected");
      if (failedDelete) {
        throw failedDelete.reason;
      }
      const deletedCount = deleteResults.filter((result) => result.status === "fulfilled" && result.value).length;
      
      new obsidian.Notice(`${getPluginName(this)}: ${t(this.app, "backups.imagesFolder.deletedCount", { count: deletedCount })}`);
      
    } catch (error) {
      console.error(getLogTag(this), "Error while clearing backups:", error);
      new obsidian.Notice(`${getPluginName(this)}: ${t(this.app, "backups.imagesFolder.clearError")}`);
    }
  }
}
