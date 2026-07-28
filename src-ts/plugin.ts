import * as obsidian from "obsidian";
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
import { ContextMenus } from "./services/context-menus";
import { BatchCompressionService, type CompressionBatchOptions } from "./services/batch-compression-service";
import { MoveBackupPreflight } from "./services/move-backup-preflight";
import { MoveModals } from "./services/move-modals";
import { createPlatformPorts, type PlatformPorts } from "./platform";
import {
  getPlatformWorkerPoolSize,
  getCompressionSettingsKeyForSnapshot,
  INTERNAL_PLUGIN_GUARD_TIMEOUT_MS,
  normalizeSettings,
  type LocalImageCompressSettings
} from "./settings";
import { SettingsTab } from "./settings-tab";
import { getActiveDocumentForApp, getActiveWindowForApp, getLogTag, getPluginName, isAllowedByRoots, isInsideOutputFolder, isSafeVaultRelativePath, sanitizeErrorForUser, normalizeOutputFolder, normalizeVaultPath, normalizeVaultPathRoot, vaultBasename } from "./utils";
import type { CompressionBatchResult, CompressionResult, CompressionSuccessResult, CompressionValidationResult, TimerHandle } from "./types";

type ManagedModal = { close: () => void };

const PLUGIN_ASYNC_FILTER_CONCURRENCY = 8;
const PLUGIN_BACKUP_DELETE_CONCURRENCY = 4;

type SettingsPersistenceState = {
  owner: LocalImageCompressPlugin;
  tail: Promise<void>;
};

type SettingsPersistenceCarrier = {
  statesByPlugin: Map<string, SettingsPersistenceState>;
};

const SETTINGS_PERSISTENCE_STATE = Symbol.for("local-image-compress.settings-persistence-state-v1");
type AppWithSettingsPersistence = obsidian.App & {
  [SETTINGS_PERSISTENCE_STATE]?: SettingsPersistenceCarrier;
};

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
  backgroundCompressionNoticeAt: number;
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
  contextMenus: ContextMenus;
  batchCompressionService: BatchCompressionService;
  moveBackupPreflight: MoveBackupPreflight;
  moveModals: MoveModals;
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
  private platformPortsInstance: PlatformPorts | null;

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
    this.backgroundCompressionNoticeAt = 0;
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
    this.contextMenus = new ContextMenus(this);
    this.batchCompressionService = new BatchCompressionService(this);
    this.moveBackupPreflight = new MoveBackupPreflight(this);
    this.moveModals = new MoveModals(this);
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
    this.platformPortsInstance = null;
    if (!LocalImageCompressPlugin.currentLang) LocalImageCompressPlugin.currentLang = "en";
  }
  getPlatformPorts(): PlatformPorts {
    return (this.platformPortsInstance ??= createPlatformPorts(this.app));
  }
  // ========================================================================
  // LIFECYCLE METHODS
  // ========================================================================
  async preloadExternalLanguageFiles() {
    LocalImageCompressPlugin.currentLang = getCurrentLang(this.app);
    await preloadExternalLanguages(this.app, this.getPlatformPorts().fs, LocalImageCompressPlugin.currentLang);
  }
  override onload(): void {
    this.claimSettingsPersistenceOwnership();
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
    if (__LIC_MOBILE_QA__) {
      const { initializeMobileQa } = await import("./qa/mobile-controller");
      await initializeMobileQa(this);
    }
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
    this.imageIndex?.cancelPendingWork();
    this.statusBarController?.closeMenu?.();
    this.settingsTab?.dispose();
    this.closeManagedModals();
    this.pluginGuardService?.releaseAllGuards?.(true).catch((error: unknown) => {
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
    await this.getPlatformPorts().fs.recoverInterruptedReplacement();
    if (this.isUnloading) {
      return;
    }
    await this.migrationRunner.recoverMigrationQuarantineJournals();
    if (this.isUnloading) {
      return;
    }
    this.compressionLimiter = new ConcurrencyLimiter(
      getPlatformWorkerPoolSize(obsidian.Platform.isMobile === true, this.getActiveWindow().navigator?.hardwareConcurrency)
    );
    await this.migrateLegacyPluginData();
    if (this.isUnloading) {
      return;
    }
    this.cache = new Cache(this.app, this.getBackupStoragePaths().cacheBackups, this.getPlatformPorts());
    await this.cache.loadCache();
    if (this.isUnloading) {
      return;
    }
    this.cache.compressionSettingsProvider = (file, skipReason) => this.getCompressionSettingsKey(file, skipReason);
    this.cache.isUnloadingProvider = () => this.isUnloading;
    if (this.cache.brokenCacheBackupPath) {
      new obsidian.Notice(`${getPluginName(this)}: ${t(this.app, "cache.corruptSaved")} ${vaultBasename(this.cache.brokenCacheBackupPath)}`);
    }
    this.compressor = new Compressor(this.settings, this.app, null, this.getPlatformPorts().fs, this.getPlatformPorts().hash);
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
      if (this.isUnloading || !this.imageIndex?.isReady()) {
        return;
      }
      await this.cache.compactCache();
      if (!this.isUnloading) {
        await this.statusBarController.update();
      }
    } catch (error) {
      console.error(getLogTag(this), "Startup image-index rebuild failed:", error);
    }
  }

  async runStartupMaintenance() {
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
      } catch (e) {
        console.error(getLogTag(this), 'Startup auto-move error:', e);
      }
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
    const pluginDirectory = normalizeVaultPath(manifestDir || `${configDir}/plugins/local-image-compress`);
    if (!isSafeVaultRelativePath(pluginDirectory)) {
      throw new Error(`Plugin directory is outside the vault: ${pluginDirectory}`);
    }
    return pluginDirectory;
  }
  getBackupStoragePaths(): BackupStoragePaths {
    return getBackupStoragePaths(this.getPlatformPorts().fs);
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
    if (this.isUnloading || !this.imageIndex || !this.cache) {
      return;
    }
    try {
      await this.imageIndex.rebuild(this.cache);
    } catch (error) {
      console.error(getLogTag(this), `rebuildImageIndex failed (${reason}):`, error);
    }
  }
  async updateImageIndexForFile(file: obsidian.TAbstractFile | null | undefined) {
    if (this.isUnloading || !this.imageIndex || !this.cache || !file?.path) {
      return;
    }
    if (!this.isImageFile(file)) {
      this.removeImageIndexFile(file.path);
      return;
    }
    await this.imageIndex.upsert(file, this.cache);
  }
  async renameImageIndexFile(file: obsidian.TAbstractFile | null | undefined, oldPath: string) {
    if (this.isUnloading || !this.imageIndex || !this.cache) {
      return;
    }
    if (!this.isImageFile(file)) {
      this.removeImageIndexFile(oldPath);
      return;
    }
    await this.imageIndex.rename(file, oldPath, this.cache);
  }
  async refreshImageIndexProcessedStates() {
    if (this.isUnloading || !this.imageIndex || !this.cache) {
      return;
    }
    await this.imageIndex.refreshProcessedStates(this.cache);
  }
  removeImageIndexFile(filePath: string) {
    if (!this.isUnloading) {
      this.imageIndex?.remove(filePath);
    }
  }
  clearIndexRefreshTimer(key: string) {
    const existing = this.indexRefreshTimers?.get(key);
    if (existing) {
      this.clearWindowTimeout(existing);
      this.indexRefreshTimers.delete(key);
    }
  }
  scheduleImageIndexRefresh(filePath: string | null | undefined, reason = "index-refresh") {
    if (this.isUnloading || !filePath) {
      return;
    }
    const normalizedPath = normalizeVaultPathRoot(filePath);
    const key = `file:${normalizedPath}`;
    this.clearIndexRefreshTimer(key);
    const timer = this.setWindowTimeout(async () => {
      this.indexRefreshTimers?.delete(key);
      if (this.isUnloading) {
        return;
      }
      const freshFile = this.app.vault.getAbstractFileByPath(normalizedPath);
      if (freshFile) {
        await this.updateImageIndexForFile(freshFile);
      } else {
        this.removeImageIndexFile(normalizedPath);
      }
      if (this.isUnloading) {
        return;
      }
      this.scheduleStatusBarUpdate(reason);
    }, 250);
    this.indexRefreshTimers?.set(key, timer);
  }
  scheduleImageIndexProcessedRefresh(reason = "processed-refresh") {
    if (this.isUnloading) {
      return;
    }
    const key = `processed:${reason}`;
    this.clearIndexRefreshTimer(key);
    const timer = this.setWindowTimeout(async () => {
      this.indexRefreshTimers?.delete(key);
      if (this.isUnloading) {
        return;
      }
      await this.refreshImageIndexProcessedStates();
      if (this.isUnloading) {
        return;
      }
      this.scheduleStatusBarUpdate(reason);
    }, 250);
    this.indexRefreshTimers?.set(key, timer);
  }
  isOutputFolderPath(filePath: string | null | undefined) {
    return isInsideOutputFolder(filePath || "", this.getOutputFolder());
  }
  scheduleStatusBarUpdate(_reason = "change") {
    if (this.isUnloading) {
      return;
    }
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
      if (this.isUnloading) {
        return;
      }
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
  async waitForCompressionIdle(maxWaitMs = 60_000): Promise<boolean> {
    const start = Date.now();
    while ((this.compressionWorkflowsInFlight > 0 || this.compressionJobsInFlight > 0) && !this.isUnloading) {
      if (Date.now() - start >= maxWaitMs) {
        console.warn(getLogTag(this), `waitForCompressionIdle giving up after ${maxWaitMs}ms`, {
          workflows: this.compressionWorkflowsInFlight,
          jobs: this.compressionJobsInFlight
        });
        return false;
      }
      await this.waitForCompressionIdleTick();
    }
    return !this.isUnloading
      && this.compressionWorkflowsInFlight === 0
      && this.compressionJobsInFlight === 0;
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
    if (this.isUnloading || !this.isInitialized) {
      return;
    }
    const next = getCurrentLang(this.app);
    if (next !== LocalImageCompressPlugin.currentLang) {
      await preloadExternalLanguages(this.app, this.getPlatformPorts().fs, next);
      if (this.isUnloading || getCurrentLang(this.app) !== next) {
        return;
      }
      LocalImageCompressPlugin.currentLang = next;
      try {
        await this.updateSavingsIndicatorInSettings?.();
      } catch (error) {
        console.debug(getLogTag(this), "settings rerender after lang switch failed (non-critical)", error);
      }
      if (this.isUnloading) {
        return;
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
      if (this.isUnloading) {
        return;
      }
      this.scheduleImageIndexProcessedRefresh("vault-create-output");
    } else {
      await this.updateImageIndexForFile(file);
      if (this.isUnloading) {
        return;
      }
      this.scheduleImageIndexRefresh(file?.path, "vault-create-stabilized");
    }
    this.scheduleStatusBarUpdate("vault-create");
    await this.handleNewFile(file);
  }
  async handleVaultDelete(file: obsidian.TAbstractFile) {
    if (this.isUnloading || !this.isInitialized) {
      return;
    }
    this.imageScanner.invalidateImageLookupCache();
    this.cancelPendingNewFileCompression(file?.path);
    if (this.isOutputFolderPath(file?.path)) {
      await this.refreshImageIndexProcessedStates();
      if (this.isUnloading) {
        return;
      }
    } else {
      this.removeImageIndexFile(file?.path);
    }
    await this.cache.compactDeletedPath(file?.path);
    if (this.isUnloading) {
      return;
    }
    this.scheduleStatusBarUpdate("vault-delete");
  }
  async handleVaultRename(file: obsidian.TAbstractFile, oldPath: string) {
    if (this.isUnloading || !this.isInitialized) {
      return;
    }
    this.imageScanner.invalidateImageLookupCache();
    this.cancelPendingNewFileCompression(oldPath);
    if (file instanceof obsidian.TFile && this.isImageFile(file) && !this.isOutputFolderPath(file.path) && !this.isOutputFolderPath(oldPath)) {
      if (!await this.cache.renameCacheEntries(oldPath, file.path)) {
        console.warn(getLogTag(this), `Cache rename was not durably committed: ${oldPath} -> ${file.path}`);
      }
      if (this.isUnloading) {
        return;
      }
    }
    if (this.isOutputFolderPath(file?.path) || this.isOutputFolderPath(oldPath)) {
      await this.refreshImageIndexProcessedStates();
      if (this.isUnloading) {
        return;
      }
      this.scheduleImageIndexProcessedRefresh("vault-rename-output");
    } else {
      await this.renameImageIndexFile(file, oldPath);
      if (this.isUnloading) {
        return;
      }
      this.scheduleImageIndexRefresh(file?.path, "vault-rename-stabilized");
    }
    this.scheduleStatusBarUpdate("vault-rename");
  }
  async handleVaultModify(file: obsidian.TAbstractFile) {
    if (this.isUnloading || !this.isInitialized) {
      return;
    }
    const isOutputPath = this.isOutputFolderPath(file?.path);
    const indexUpdatePromise = isOutputPath
      ? this.refreshImageIndexProcessedStates()
      : this.updateImageIndexForFile(file);
    await indexUpdatePromise;
    if (this.isUnloading) {
      return;
    }
    if (isOutputPath) {
      this.scheduleImageIndexProcessedRefresh("vault-modify-output");
    } else {
      this.scheduleImageIndexRefresh(file?.path, "vault-modify-stabilized");
    }
    this.scheduleStatusBarUpdate("vault-modify");
    if (this.newFileQueue.hasPendingOrTimer(file?.path)) {
      this.cancelPendingNewFileCompression(file?.path);
      await this.handleNewFile(file);
    }
  }
  async runCompressionBatch(files: obsidian.TFile[], options: CompressionBatchOptions = {}): Promise<CompressionBatchResult> {
    return await this.batchCompressionService.runCompressionBatch(files, options);
  }
  // Batch compression in background (no modal)
  async processBatchCompressionBackground(files: obsidian.TFile[]) {
    await this.batchCompressionService.processBatchCompressionBackground(files);
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
    this.registerDomEvent(this.statusBarItem, "click", (event: MouseEvent) => {
      event.preventDefault();
      this.consumeStatusMenuOpen(event);
    });
    this.registerDomEvent(this.statusBarItem, "keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      this.consumeStatusMenuOpen({
        keyboard: true,
        returnFocusTo: this.statusBarItem,
        target: this.statusBarItem
      });
    });
    this.statusBarItem.setText(t(this.app, "status.indexing"));
    // Mobile has no status bar, so the same menu hangs off a ribbon icon there.
    if (obsidian.Platform.isMobile && typeof this.addRibbonIcon === "function") {
      const ribbonIcon = this.addRibbonIcon("image", getPluginName(this), (event: MouseEvent) => {
        this.consumeStatusMenuOpen(event);
      });
      ribbonIcon.addClass("tiny-local-status-trigger");
    }
  }
  consumeStatusMenuOpen(event: Parameters<StatusBarController["showMenu"]>[0]) {
    this.openStatusMenuSafely(event).catch((error) => {
      console.error(getLogTag(this), "Unexpected status menu error:", error);
    });
  }
  async openStatusMenuSafely(event: Parameters<StatusBarController["showMenu"]>[0]) {
    if (this.isUnloading) {
      return;
    }
    try {
      await this.statusBarController.showMenu(event);
    } catch (error) {
      this.statusBarController.closeMenu(true);
      console.error(getLogTag(this), "Status menu open failed:", error);
      if (!this.isUnloading) {
        new obsidian.Notice(`${getPluginName(this)}: ${t(this.app, "progress.error")}`);
      }
    }
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
  private getSettingsPersistenceState(): SettingsPersistenceState {
    const app = this.app as AppWithSettingsPersistence;
    let carrier = app[SETTINGS_PERSISTENCE_STATE];
    if (!carrier?.statesByPlugin || !(carrier.statesByPlugin instanceof Map)) {
      carrier = { statesByPlugin: new Map() };
      Object.defineProperty(app, SETTINGS_PERSISTENCE_STATE, {
        configurable: false,
        enumerable: false,
        value: carrier,
        writable: false
      });
    }
    const statesByPlugin = carrier.statesByPlugin;
    let state = statesByPlugin.get(this.manifest.id);
    if (!state) {
      state = { owner: this, tail: Promise.resolve() };
      statesByPlugin.set(this.manifest.id, state);
    }
    return state;
  }

  private claimSettingsPersistenceOwnership(): void {
    this.getSettingsPersistenceState().owner = this;
  }

  private async waitForPendingSettingsSaves(): Promise<boolean> {
    const state = this.getSettingsPersistenceState();
    await state.tail;
    return state.owner === this;
  }

  async waitForSettingsPersistenceIdle(): Promise<boolean> {
    return await this.waitForPendingSettingsSaves();
  }

  private async persistSettingsSnapshot(settings: LocalImageCompressSettings): Promise<boolean> {
    const state = this.getSettingsPersistenceState();
    if (state.owner !== this) {
      return false;
    }
    const previous = state.tail;
    let releaseQueue!: () => void;
    const queueTail = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    state.tail = queueTail;
    // Accepted snapshots stay ordered across reload; the next owner waits for this tail before load/save.
    await previous;
    try {
      await this.saveData(settings);
      return true;
    } finally {
      releaseQueue();
    }
  }

  async loadSettings() {
    try {
      if (!await this.waitForPendingSettingsSaves()) {
        return;
      }
      const loadedSettings: unknown = await this.loadData();
      if (this.getSettingsPersistenceState().owner !== this) {
        return;
      }
      this.settings = normalizeSettings(loadedSettings);
    } catch (error) {
      console.error(getLogTag(this), "Failed to load settings; using defaults:", error);
      this.settings = normalizeSettings(undefined);
      new obsidian.Notice(`${getPluginName(this)}: ${t(this.app, "settings.loadFailed")}`, 10000);
    }
    this.applyRuntimeSettings();
  }
  async saveSettings() {
    const persistenceState = this.getSettingsPersistenceState();
    if (persistenceState.owner !== this) {
      return;
    }
    // Re-normalize before save because UI/event mutations can temporarily violate settings invariants.
    const settingsSnapshot = normalizeSettings(this.settings);
    this.settings = settingsSnapshot;
    this.applyRuntimeSettings();
    if (!await this.persistSettingsSnapshot(settingsSnapshot)) {
      return;
    }
    if (persistenceState.owner !== this) {
      return;
    }
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
    this.contextMenus.addContextMenu(menu, file);
  }
  addFolderContextMenu(menu: obsidian.Menu, folder: obsidian.TFolder) {
    this.contextMenus.addFolderContextMenu(menu, folder);
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
      if (!await this.cache.addSkippedEntry(file.path, "too_small")) {
        throw new Error(`Skipped cache entry was not durably committed: ${file.path}`);
      }
      await this.runPostCommitMaintenance("too-small image index update", async () => await this.updateImageIndexForFile(file));
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
          const mtimeSnapshot = file.stat.mtime;
          const settingsSnapshot = normalizeSettings(this.settings);
          const result = await this.runLimitedCompression(() => this.compressor.compress(file, settingsSnapshot, {
            sourcePath: pathSnapshot,
            sourceMtime: mtimeSnapshot
          }));
          if (this.isUnloading) {
            return;
          }
          if (result.success) {
            await this.handleSuccessfulCompression(file, result);
            shouldAutoMove = true;
          } else if (this.isSkippableCompressionFailure(result)) {
            await this.handleSkippedCompression(file, result, settingsSnapshot, pathSnapshot);
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
  async handleSuccessfulCompression(file: obsidian.TFile, result: CompressionSuccessResult) {
    if (!await this.cache.addCompressionArtifact(result.artifact)) {
      throw new Error(`Compression cache entry was not durably committed: ${result.artifact.outputPath}`);
    }
    await this.runPostCommitMaintenance("cache backup", async () => await this.cache.createBackup());
    await this.runPostCommitMaintenance("image index update", async () => await this.updateImageIndexForFile(file));
    await this.runPostCommitMaintenance("status bar update", async () => await this.statusBarController.update());
    
    // Update savings indicator in settings if settings tab is open
    await this.runPostCommitMaintenance("settings savings update", async () => await this.updateSavingsIndicatorInSettings());
    
    await this.runPostCommitMaintenance("success notice", () => {
      const displaySavings = this.savingsCalculator.getDisplaySavingsPercentage(result.savings);
      if (displaySavings > 0) {
        new obsidian.Notice(`${getPluginName(this)}: ${displaySavings}%`);
      } else {
        new obsidian.Notice(`${getPluginName(this)}: ${t(this.app, "notice.cacheUpdated")}`);
      }
    });
  }
  isSkippableCompressionFailure(result: CompressionResult) {
    return result?.skipReason === "pngquant_quality_failed" || result?.skipReason === "mozjpeg_failed" || result?.skipReason === "compressed_not_smaller" || result?.skipReason === "too_large";
  }
  getCompressionSettingsKey(file: Pick<obsidian.TFile, "extension">, skipReason = "", settings = this.settings) {
    return getCompressionSettingsKeyForSnapshot(file?.extension || "", settings, skipReason, obsidian.Platform.isMobile === true);
  }
  async handleSkippedCompression(
    file: obsidian.TFile,
    result: CompressionResult,
    settingsSnapshot = this.settings,
    pathSnapshot = file.path
  ) {
    if (!await this.cache.addSkippedEntry(pathSnapshot, result.skipReason || "", this.getCompressionSettingsKey(file, result.skipReason || "", settingsSnapshot))) {
      throw new Error(`Skipped cache entry was not durably committed: ${pathSnapshot}`);
    }
    await this.runPostCommitMaintenance("skipped image index update", async () => await this.updateImageIndexForFile(file));
    await this.runPostCommitMaintenance("skipped status bar update", async () => await this.statusBarController.update());
  }
  private async runPostCommitMaintenance(label: string, operation: () => unknown) {
    try {
      await operation();
    } catch (error) {
      console.warn(getLogTag(this), `Post-commit ${label} failed:`, error);
    }
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
          const mtimeSnapshot = file.stat.mtime;
          const settingsSnapshot = normalizeSettings(this.settings);
          const result = await this.runLimitedCompression(() => this.compressor.compress(file, settingsSnapshot, {
            sourcePath: pathSnapshot,
            sourceMtime: mtimeSnapshot
          }));
          if (this.isUnloading) {
            return;
          }
          if (result.success) {
            await this.handleSuccessfulCompression(file, result);
            shouldAutoMove = true;
          } else if (this.isSkippableCompressionFailure(result)) {
            await this.handleSkippedCompression(file, result, settingsSnapshot, pathSnapshot);
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
    await this.batchCompressionService.compressImagesInNote();
  }
  async compressImagesInFolder() {
    await this.batchCompressionService.compressImagesInFolder();
  }
  async compressAllImages() {
    await this.batchCompressionService.compressAllImages();
  }
  async processBatchCompression(files: obsidian.TFile[], title: string) {
    await this.batchCompressionService.processBatchCompression(files, title);
  }
  // ========================================================================
  // FOLDER SELECTION
  // ========================================================================
  showFolderSelector(folderPaths: string[]): Promise<string | null> {
    return FolderSelectorModal.show(this, folderPaths);
  }
  async compressImagesInFolderPath(folderPath: string, isRecursive = false) {
    await this.batchCompressionService.compressImagesInFolderPath(folderPath, isRecursive);
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
    const compressedFilesCount = await this.moveService.getCompressedFilesCount();
    return {
      ...imageStats,
      cacheStats: this.cache.getCacheStats(),
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
      const ports = this.getPlatformPorts();
      const fsPort = ports.fs;
      const backupDir = this.getBackupStoragePaths().originalFilesBackups;

      if (!await fsPort.exists(backupDir)) {
        new obsidian.Notice(`${getPluginName(this)}: ${t(this.app, "backups.imagesFolder.notFound")}`);
        return;
      }

      const backups = (await fsPort.listEntries(backupDir)).map((entry) => ({
        path: fsPort.joinPath(backupDir, entry.name),
        isDirectory: entry.isDirectory,
        isFile: entry.isFile,
        isSymbolicLink: entry.isSymbolicLink
      }));

      if (backups.length === 0) {
        new obsidian.Notice(`${getPluginName(this)}: ${t(this.app, "backups.imagesFolder.noneToDelete")}`);
        return;
      }

      const backupDeleteLimiter = new ConcurrencyLimiter(PLUGIN_BACKUP_DELETE_CONCURRENCY);
      const deleteResults = await Promise.allSettled(backups.map((backup) => backupDeleteLimiter.run(async () => {
        if (backup.isDirectory) {
          if (!await this.moveService.deleteDirectoryRecursiveAsync(backup.path)) {
            throw new Error(`Backup directory changed during cleanup: ${backup.path}`);
          }
          return true;
        }
        if (!backup.isFile || backup.isSymbolicLink) {
          throw new Error(`Unsupported backup entry retained: ${backup.path}`);
        }
        const expectedSha256 = await ports.hash.fileSha256Hex(backup.path);
        const removal = await fsPort.removeFileIfUnchanged(backup.path, expectedSha256);
        if (!removal.removed) {
          throw new Error(`Backup file changed during cleanup: ${backup.path}`);
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
