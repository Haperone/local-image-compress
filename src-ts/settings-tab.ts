import * as obsidian from "obsidian";
import type { BackupStoragePaths } from "./backup-storage";
import { t } from "./i18n";
import type { PlatformPorts } from "./platform";
import type { LocalImageCompressSettings } from "./settings";
import { getActiveDocumentForApp, getActiveWindowForApp, getLogTag, getPluginName, isValidOutputFolder, normalizeOutputFolder } from "./utils";
import type { SavingsSnapshot, StatsSnapshot, TimerHandle } from "./types";

type ManagedModal = { close: () => void };

export interface FolderSuggestModalHost {
  app: obsidian.App;
  captureModalFocusTarget(): HTMLElement | null;
  restoreModalFocus(target: HTMLElement | null | undefined): void;
  untrackManagedModal(modal: ManagedModal): void;
}

export interface SettingsTabHost extends obsidian.Plugin, FolderSuggestModalHost {
  settings: LocalImageCompressSettings;
  backgroundCompressionService: {
    AUTO_BACKGROUND_THRESHOLD: number;
    USER_INACTIVITY_THRESHOLD: number;
  };
  cache: {
    clearCache(): Promise<boolean>;
    getAvailableBackups(): Promise<string[]>;
    restoreFromBackup(backupFileName: string): Promise<boolean>;
  };
  compressor: {
    getWasmInitError?(): unknown;
  };
  moveService: {
    moveCompressedToFiles(): Promise<void>;
  };
  savingsCalculator: {
    calculateSpaceSavings(): Promise<SavingsSnapshot>;
    validateSavingsData(savings: unknown): savings is SavingsSnapshot;
    formatTooltipData(savings: SavingsSnapshot | null | undefined): {
      originalFormatted: string;
      currentFormatted: string;
      savedFormatted: string;
      estimatedIndicator: string;
      estimatedText: string;
    };
  };
  statusBarController: {
    update(): Promise<void>;
  };
  clearOriginalFilesBackups(): Promise<void>;
  forceRefreshCache(): Promise<void>;
  getBackupStoragePaths(): BackupStoragePaths;
  getOutputFolder(): string;
  getPlatformPorts(): PlatformPorts;
  getStatsSnapshot(): Promise<StatsSnapshot>;
  rebuildImageIndex(reason?: string): Promise<void>;
  saveSettings(): Promise<void>;
  showCacheBackupsList(): Promise<void>;
  trackManagedModal<T extends ManagedModal>(modal: T): T;
}

type OwnedAnimationFrame = {
  ownerWindow: Window;
  handle: number;
  isAnimationFrame: boolean;
};

class AllowedRootsFolderSuggestModal extends obsidian.FuzzySuggestModal<string> {
  private readonly plugin: FolderSuggestModalHost;
  private readonly items: string[];
  private readonly appRef: obsidian.App;
  private readonly onChooseCb: (item: string) => void | Promise<void>;
  private readonly returnFocusTo: HTMLElement | null;

  constructor(plugin: FolderSuggestModalHost, items: string[], onChoose: (item: string) => void | Promise<void>) {
    super(plugin.app);
    this.plugin = plugin;
    this.appRef = plugin.app;
    this.items = items;
    this.onChooseCb = onChoose;
    this.returnFocusTo = plugin.captureModalFocusTarget();
    this.setPlaceholder(t(plugin.app, "paths.allowedRoots.modal.placeholder"));
  }
  getItems() { return this.items; }
  getItemText(item: string) {
    return item === "" || item === "/" ? t(this.appRef, "folderSelect.root") : item;
  }
  onChooseItem(item: string) {
    Promise.resolve(this.onChooseCb(item)).catch((error: unknown) => {
      console.error(getLogTag(this), "Allowed-root selection failed:", error);
    });
  }
  override onClose() {
    this.plugin.untrackManagedModal(this);
    super.onClose();
    this.plugin.restoreModalFocus(this.returnFocusTo);
  }
}

export class SettingsTab extends obsidian.PluginSettingTab {
  plugin: SettingsTabHost;
  private _isVisible: boolean;
  private _isRendering: boolean;
  private _pendingRerender: boolean;
  private _isDisposed: boolean;
  private _renderGeneration: number;
  private readonly _ownedAnimationFrames: Set<OwnedAnimationFrame>;
  _renderRootsCleanups: Array<() => void>;
  _savingsTooltipCleanups: Array<() => void>;
  _savingsTooltipDocuments: Set<Document>;
  currentStatsSnapshot: StatsSnapshot | null;
  cacheStatsElement: HTMLElement | null;
  uncompressedStatsElement: HTMLElement | null;
  compressedFilesCountElement: HTMLElement | null;
  savingsHostElement: HTMLElement | null;
  saveSettingsDebounceTimer: TimerHandle | null;
  saveSettingsDebounceWindow: Window | null;
  updateStats!: () => Promise<void>;

  constructor(app: obsidian.App, plugin: SettingsTabHost) {
    super(app, plugin);
    this.plugin = plugin;
    this._isVisible = false;
    this._isRendering = false;
    this._pendingRerender = false;
    this._isDisposed = false;
    this._renderGeneration = 0;
    this._ownedAnimationFrames = new Set();
    this._renderRootsCleanups = [];
    this._savingsTooltipCleanups = [];
    this._savingsTooltipDocuments = new Set();
    this.currentStatsSnapshot = null;
    this.cacheStatsElement = null;
    this.uncompressedStatsElement = null;
    this.compressedFilesCountElement = null;
    this.savingsHostElement = null;
    this.saveSettingsDebounceTimer = null;
    this.saveSettingsDebounceWindow = null;
  }
  requestRerenderAfterCurrentRender() {
    if (this._isDisposed || !this._isRendering) {
      return false;
    }
    this._pendingRerender = true;
    return true;
  }
  private focusRestorableElement(active: Element | null) {
    const focusable = active as unknown as { focus?: () => void } | null;
    if (typeof focusable?.focus === "function") {
      focusable.focus();
    }
  }
  private displayWithoutScrollRestore(errorContext: string) {
    if (this.requestRerenderAfterCurrentRender()) {
      return;
    }
    this.renderSettings().catch((displayError) => {
      console.error(getLogTag(this), errorContext, displayError);
    });
  }
  rerenderPreservingScroll() {
    if (this._isDisposed) {
      return;
    }
    try {
      const { containerEl } = this;
      if (!containerEl) {
        this.displayWithoutScrollRestore("Settings render without container failed:");
        return;
      }
      const prevScroll = containerEl.scrollTop || 0;
      const active = this.getActiveDocument().activeElement;
      const ownerWindow = containerEl.win || this.getActiveWindow();
      const restore = () => {
        try {
          containerEl.scrollTop = prevScroll;
          this.focusRestorableElement(active);
        } catch (error) {
          console.debug(getLogTag(this), "settings scroll restore failed (non-critical)", error);
        }
      };
      this.requestWindowAnimationFrame(() => {
        const renderPromise = this.renderSettings();
        const renderGeneration = this._renderGeneration;
        renderPromise
          .then(() => this.requestWindowAnimationFrame(restore, ownerWindow, renderGeneration, containerEl))
          .catch((error) => {
            console.error(getLogTag(this), "Settings re-render failed:", error);
            this.requestWindowAnimationFrame(restore, ownerWindow, renderGeneration, containerEl);
          });
      }, ownerWindow);
    } catch (error) {
      console.error(getLogTag(this), "Settings re-render setup failed:", error);
      this.displayWithoutScrollRestore("Settings fallback render failed:");
    }
  }
  getActiveDocument() {
    return getActiveDocumentForApp(this.app)
      || this.getActiveWindow().document
      || window.document;
  }
  getActiveWindow() {
    return getActiveWindowForApp(this.app) || window;
  }
  setWindowTimeout(
    callback: (...args: never[]) => unknown,
    delay: number,
    ownerWindow: Window = this.containerEl?.win || this.getActiveWindow()
  ) {
    return ownerWindow.setTimeout(callback, delay);
  }
  clearWindowTimeout(
    timer: TimerHandle | null | undefined,
    ownerWindow: Window = this.containerEl?.win || this.getActiveWindow()
  ) {
    if (timer === null || timer === undefined) {
      return;
    }
    ownerWindow.clearTimeout(timer as number);
  }
  flushPendingSaveSettings() {
    if (!this.saveSettingsDebounceTimer) {
      return;
    }
    try {
      this.clearWindowTimeout(
        this.saveSettingsDebounceTimer,
        this.saveSettingsDebounceWindow || this.containerEl?.win || this.getActiveWindow()
      );
    } catch (error) {
      console.debug(getLogTag(this), "Settings debounce timer cleanup failed (non-critical)", error);
    }
    this.saveSettingsDebounceTimer = null;
    this.saveSettingsDebounceWindow = null;
    this.plugin.saveSettings().catch((error: unknown) => {
      console.error(getLogTag(this), "Settings save during close failed:", error);
    });
  }
  debouncedSaveSettings(delayMs = 300, afterSave: (() => void) | null = null) {
    if (this.saveSettingsDebounceTimer) {
      this.clearWindowTimeout(
        this.saveSettingsDebounceTimer,
        this.saveSettingsDebounceWindow || this.containerEl?.win || this.getActiveWindow()
      );
    }
    const ownerWindow = this.containerEl?.win || this.getActiveWindow();
    this.saveSettingsDebounceWindow = ownerWindow;
    this.saveSettingsDebounceTimer = this.setWindowTimeout(() => {
      this.saveSettingsDebounceTimer = null;
      this.saveSettingsDebounceWindow = null;
      this.plugin.saveSettings()
        .then(() => afterSave?.())
        .catch((error) => {
          console.error(getLogTag(this), "Settings save failed:", error);
        });
    }, delayMs, ownerWindow);
  }
  showSettingsOperationError(error: unknown, context: string, noticeKey = "notice.operationFailed") {
    console.error(getLogTag(this), context, error);
    new obsidian.Notice(`${getPluginName(this.plugin)}: ${t(this.plugin.app, noticeKey)}`);
  }
  async runButtonTask(button: obsidian.ButtonComponent, idleKey: string, loadingKey: string, task: () => Promise<void>, errorContext = "Settings button action failed:", noticeKey = "notice.operationFailed") {
    const renderGeneration = this._renderGeneration;
    const renderContainer = this.containerEl;
    button.setDisabled(true);
    button.setButtonText(t(this.plugin.app, loadingKey));
    try {
      await task();
    } catch (error) {
      if (this.isRenderCurrent(renderGeneration, renderContainer)) {
        this.showSettingsOperationError(error, errorContext, noticeKey);
      }
    } finally {
      if (this.isRenderCurrent(renderGeneration, renderContainer)) {
        button.setButtonText(t(this.plugin.app, idleKey));
        button.setDisabled(false);
      }
    }
  }
  applySubsettingVisibility(visible: boolean, ...rows: obsidian.Setting[]) {
    for (const row of rows) {
      row.settingEl.toggle(visible);
      row.settingEl.addClass("tiny-local-subsetting");
    }
  }
  getSavingsBarWidths(savings: SavingsSnapshot) {
    const originalSize = Number.isFinite(savings.originalSize) && savings.originalSize > 0 ? savings.originalSize : 0;
    const savedSize = Number.isFinite(savings.savedSize) && savings.savedSize > 0 ? savings.savedSize : 0;
    const savedWidth = originalSize > 0 ? Math.min(100, Math.max(0, (savedSize / originalSize) * 100)) : 0;
    return {
      savedWidth,
      currentWidth: Math.max(0, 100 - savedWidth)
    };
  }
  cleanupRenderRoots() {
    for (const cleanup of this._renderRootsCleanups || []) {
      try {
        cleanup();
      } catch (error) {
        console.debug(getLogTag(this), "Allowed roots cleanup failed (non-critical)", error);
      }
    }
    this._renderRootsCleanups = [];
  }
  requestWindowAnimationFrame(
    callback: FrameRequestCallback | (() => void),
    ownerWindow: Window = this.containerEl?.win || this.getActiveWindow(),
    renderGeneration = this._renderGeneration,
    renderContainer = this.containerEl
  ): OwnedAnimationFrame | null {
    if (!this.isRenderCurrent(renderGeneration, renderContainer)) {
      return null;
    }
    const isAnimationFrame = typeof ownerWindow.requestAnimationFrame === "function";
    let completedSynchronously = false;
    let ownedFrame: OwnedAnimationFrame | null = null;
    const run = (timestamp: number) => {
      completedSynchronously = true;
      if (ownedFrame) {
        this._ownedAnimationFrames.delete(ownedFrame);
      }
      if (!this.isRenderCurrent(renderGeneration, renderContainer)) {
        return;
      }
      callback(timestamp);
    };
    const handle = isAnimationFrame
      ? ownerWindow.requestAnimationFrame(run)
      : ownerWindow.setTimeout(() => run(ownerWindow.performance?.now?.() || 0), 0);
    if (!completedSynchronously) {
      ownedFrame = { ownerWindow, handle, isAnimationFrame };
      this._ownedAnimationFrames.add(ownedFrame);
    }
    return ownedFrame;
  }
  private cancelOwnedAnimationFrame(frame: OwnedAnimationFrame | null) {
    if (!frame || !this._ownedAnimationFrames.delete(frame)) {
      return;
    }
    if (frame.isAnimationFrame) {
      frame.ownerWindow.cancelAnimationFrame?.(frame.handle);
    } else {
      frame.ownerWindow.clearTimeout(frame.handle);
    }
  }
  private cancelOwnedAnimationFrames() {
    for (const frame of Array.from(this._ownedAnimationFrames)) {
      this.cancelOwnedAnimationFrame(frame);
    }
  }
  normalizeAllowedRootSelection(chosen: string) {
    if (chosen === "" || chosen === "/") {
      return null;
    }
    return chosen.endsWith("/") ? chosen : `${chosen}/`;
  }
  renderSection(containerEl: HTMLElement, key: string) {
    new obsidian.Setting(containerEl)
      .setName(t(this.plugin.app, key))
      .setHeading();
  }
  private setDestructiveButton(button: obsidian.ButtonComponent) {
    const compatibleButton = button as unknown as {
      setDestructive?: () => unknown;
      setWarning?: () => unknown;
    };
    if (typeof compatibleButton.setDestructive === "function") {
      compatibleButton.setDestructive();
    } else {
      compatibleButton.setWarning?.();
    }
    return button;
  }
  renderInstructions(containerEl: HTMLElement) {
    this.renderSection(containerEl, "section.instructions");
    const instructions = containerEl.createDiv({ cls: "setting-item-description" });
    const usageTitle = instructions.createEl("p");
    usageTitle.createEl("strong", { text: t(this.plugin.app, "instructions.usageTitle") });
    const usageList = instructions.createEl("ul");
    const addUsageItem = (prefix: string, command: string) => {
      usageList.createEl("li", { text: `${prefix} "${command}"` });
    };
    addUsageItem(t(this.plugin.app, "instructions.action.rightClick"), t(this.plugin.app, "context.compressImage"));
    addUsageItem(t(this.plugin.app, "instructions.action.commandPalette"), t(this.plugin.app, "command.compressInNote"));
    addUsageItem(t(this.plugin.app, "instructions.action.commandPalette"), t(this.plugin.app, "command.compressInFolder"));
    addUsageItem(t(this.plugin.app, "instructions.action.commandPalette"), t(this.plugin.app, "command.compressAll"));
    addUsageItem(t(this.plugin.app, "instructions.action.commandPalette"), t(this.plugin.app, "command.moveCompressed"));
    const notesTitle = instructions.createEl("p");
    notesTitle.createEl("strong", { text: t(this.plugin.app, "instructions.notesTitle") });
    const notesList = instructions.createEl("ul");
    notesList.createEl("li", { text: `${t(this.plugin.app, "instructions.notes.saved")} "${this.plugin.getOutputFolder()}"` });
    notesList.createEl("li", { text: t(this.plugin.app, "instructions.notes.originalUnchanged") });
    notesList.createEl("li", { text: t(this.plugin.app, "instructions.notes.recompressionSkipped") });
  }
  private isRenderCurrent(generation: number, containerEl: HTMLElement) {
    return !this._isDisposed && this._renderGeneration === generation && this.containerEl === containerEl;
  }
  finishRender() {
    this._isRendering = false;
    if (this._pendingRerender && !this._isDisposed && this._isVisible) {
      this._pendingRerender = false;
      this.requestWindowAnimationFrame(() => {
        this.renderSettings().catch((error) => {
          console.error(getLogTag(this), "Settings pending re-render failed:", error);
        });
      });
    }
  }
  cleanupSavingsTooltips() {
    for (const cleanup of this._savingsTooltipCleanups || []) {
      try {
        cleanup();
      } catch (error) {
        console.debug(getLogTag(this), "Savings tooltip cleanup failed:", error);
      }
    }
    this._savingsTooltipCleanups = [];
    try {
      const documents = new Set([this.getActiveDocument(), ...(this._savingsTooltipDocuments || [])]);
      for (const activeDocument of documents) {
        const wrappers = Array.from(activeDocument?.querySelectorAll?.(".tiny-local-savings-tooltip-wrapper") || []);
        for (const wrapper of wrappers) {
          wrapper.parentElement?.removeChild(wrapper);
        }
        const contents = Array.from(activeDocument?.querySelectorAll?.(".tiny-local-savings-tooltip") || []);
        for (const content of contents) {
          const parent = content.parentElement;
          if (parent?.classList?.contains?.("tiny-local-savings-tooltip-wrapper")) {
            parent.parentElement?.removeChild(parent);
          } else {
            parent?.removeChild(content);
          }
        }
      }
      this._savingsTooltipDocuments?.clear?.();
    } catch (error) {
      console.debug(getLogTag(this), "Savings tooltip DOM cleanup failed:", error);
    }
  }
  dispose() {
    this._isVisible = false;
    this._isDisposed = true;
    this._renderGeneration++;
    this._pendingRerender = false;
    this.cancelOwnedAnimationFrames();
    this.flushPendingSaveSettings();
    this.cleanupRenderRoots();
    this.cleanupSavingsTooltips();
  }
  override hide() {
    this.dispose();
    super.hide();
  }
  async applyStatsSnapshot(stats: StatsSnapshot) {
    this.currentStatsSnapshot = stats;
    if (this.cacheStatsElement) {
      const cacheStats = stats.cacheStats;
      this.cacheStatsElement.setText(`${t(this.plugin.app, "stats.cache.entries")}: ${cacheStats.total}, ${t(this.plugin.app, "stats.cache.size")}: ${Math.round(cacheStats.size / 1024)} ${t(this.plugin.app, "units.kb")}`);
    }
    if (this.uncompressedStatsElement) {
      this.uncompressedStatsElement.setText(`${t(this.plugin.app, "stats.uncompressed.ready")}: ${stats.uncompressedImages}`);
    }
    if (this.compressedFilesCountElement) {
      this.compressedFilesCountElement.setText(`${t(this.plugin.app, "move.ready")}: ${stats.compressedFilesCount}`);
    }
    if (this.savingsHostElement) {
      this.cleanupSavingsTooltips();
      this.savingsHostElement.empty();
      await this.renderSavingsIndicator(this.savingsHostElement, stats.savings);
    }
  }
  // Obsidian invokes this legacy hook synchronously; async work is exposed separately.
  override display(): void {
    this._isDisposed = false;
    this._isVisible = true;
    this.renderSettings().catch((error) => {
      console.warn(getLogTag(this), "Settings render failed:", error);
    });
  }
  async refreshStatsIfVisible() {
    if (!this._isVisible) {
      return;
    }
    if (this.requestRerenderAfterCurrentRender()) {
      return;
    }
    if (typeof this.updateStats === "function") {
      await this.updateStats();
      return;
    }
    await this.renderSettings();
  }
  async renderSettings() {
    if (this._isDisposed) {
      return;
    }
    if (this._isRendering) {
      // If already rendering, mark that a subsequent pass is required
      this._pendingRerender = true;
      return;
    }
    this._isRendering = true;
    const renderGeneration = ++this._renderGeneration;
    try {
    const { containerEl } = this;
    this.cleanupRenderRoots();
    this.cleanupSavingsTooltips();
    containerEl.empty();
    containerEl.addClass("tiny-local-settings");
    
    // Keep references to elements for updates
    this.cacheStatsElement = null;
    this.uncompressedStatsElement = null;
    this.compressedFilesCountElement = null;
    this.savingsHostElement = null;
    const statsSnapshot = await this.plugin.getStatsSnapshot();
    if (!this.isRenderCurrent(renderGeneration, containerEl)) {
      return;
    }
    this.currentStatsSnapshot = statsSnapshot;
    
    // Function to update statistics
    this.updateStats = async () => {
      const stats = await this.plugin.getStatsSnapshot();
      if (!this.isRenderCurrent(renderGeneration, containerEl)) {
        return;
      }
      await this.applyStatsSnapshot(stats);
    };
    
    await this.renderHeaderIndicators(containerEl, statsSnapshot);
    if (!this.isRenderCurrent(renderGeneration, containerEl)) {
      return;
    }
    this.renderQualitySection(containerEl);
    this.renderPathsSection(containerEl, renderGeneration);
    this.renderAutomationSection(containerEl, renderGeneration);
    this.renderStatsSection(containerEl, statsSnapshot);
    this.renderMoveSection(containerEl, statsSnapshot);
    await this.renderCacheBackupsSection(containerEl, renderGeneration);
    if (!this.isRenderCurrent(renderGeneration, containerEl)) {
      return;
    }
    this.renderInstructions(containerEl);
    } finally {
      this.finishRender();
    }
  }
  async renderHeaderIndicators(containerEl: HTMLElement, statsSnapshot: StatsSnapshot) {
    // Global warning if WASM modules are not available
    const wasmInitError = this.plugin.compressor.getWasmInitError?.();
    if (wasmInitError) {
      containerEl.createDiv({ text: t(this.plugin.app, "warning.wasmInitFailed"), cls: "tiny-local-notice tiny-local-warning-block" });
    }

    // Add space savings indicator
    this.savingsHostElement = containerEl.createDiv({ cls: "tiny-local-savings-host" });
    await this.renderSavingsIndicator(this.savingsHostElement, statsSnapshot.savings);
  }
  renderQualitySection(containerEl: HTMLElement) {
    this.renderSection(containerEl, "section.quality");
    new obsidian.Setting(containerEl).setName(t(this.plugin.app, "quality.png.name")).setDesc(t(this.plugin.app, "quality.png.desc")).addText((text) => text.setPlaceholder("65-80").setValue(`${this.plugin.settings.pngQuality.min}-${this.plugin.settings.pngQuality.max}`).onChange((value) => {
      const parts = value.split("-");
      if (parts.length === 2) {
        const minPart = parts[0];
        const maxPart = parts[1];
        if (minPart === undefined || maxPart === undefined) {
          return;
        }
        const min = parseInt(minPart, 10);
        const max = parseInt(maxPart, 10);
        if (!isNaN(min) && !isNaN(max) && min >= 1 && max <= 100 && min <= max) {
          this.plugin.settings.pngQuality.min = min;
          this.plugin.settings.pngQuality.max = max;
          this.debouncedSaveSettings();
        }
      }
    }));
    new obsidian.Setting(containerEl).setName(t(this.plugin.app, "quality.jpeg.name")).setDesc(t(this.plugin.app, "quality.jpeg.desc")).addSlider((slider) => slider.setLimits(1, 95, 1).setValue(this.plugin.settings.jpegQuality).setDynamicTooltip().onChange((value) => {
      this.plugin.settings.jpegQuality = value;
      this.debouncedSaveSettings();
    }));

    // Button: open image backups folder
    // Removed from "Cache backups" section — moved to "Move compressed files"
  }
  renderPathsSection(containerEl: HTMLElement, renderGeneration = this._renderGeneration) {
    const isCurrent = () => this.isRenderCurrent(renderGeneration, containerEl);
    this.renderSection(containerEl, "section.paths");
    // Allowed roots: choose from folder list with autocomplete (modal)
    const rootsSetting = new obsidian.Setting(containerEl)
      .setName(t(this.plugin.app, "paths.allowedRoots.name"))
      .setDesc(t(this.plugin.app, "paths.allowedRoots.desc"));

    const rootsListEl = rootsSetting.controlEl.createDiv({ cls: "tiny-local-roots-list" });

    const renderRoots = () => {
      if (!isCurrent()) {
        return;
      }
      this.cleanupRenderRoots();
      rootsListEl.empty();
      if (!Array.isArray(this.plugin.settings.allowedRoots) || this.plugin.settings.allowedRoots.length === 0) {
        rootsListEl.createDiv({ text: t(this.plugin.app, "paths.allowedRoots.empty"), cls: "setting-item-description" });
        return;
      }
      const list = rootsListEl.createDiv();
      this.plugin.settings.allowedRoots.forEach((root: string) => {
        const removeLabel = t(this.plugin.app, "paths.allowedRoots.pill.remove");
        const pill = list.createEl("button", { text: root, cls: "badge tiny-local-roots-pill" });
        pill.type = "button";
        pill.title = removeLabel;
        pill.setAttribute("aria-label", `${removeLabel}: ${root}`);
        const removeRoot = () => {
          // Look up by value at click time: a render-captured index goes stale when two pills are removed before the re-render.
          const rootIndex = this.plugin.settings.allowedRoots.indexOf(root);
          if (rootIndex === -1) {
            return;
          }
          this.plugin.settings.allowedRoots.splice(rootIndex, 1);
          this.plugin.saveSettings()
            .then(() => {
              if (isCurrent()) {
                renderRoots();
              }
            })
            .catch((error: unknown) => {
              console.error(getLogTag(this), "Allowed root removal failed:", error);
            });
        };
        // transient: re-rendered per render, removed via _renderRootsCleanups (registerDomEvent would leak across renders)
        pill.addEventListener("click", removeRoot);
        this._renderRootsCleanups.push(() => pill.removeEventListener("click", removeRoot));
      });
    };

    rootsSetting.addButton((btn) =>
      btn.setButtonText(t(this.plugin.app, "common.add")).onClick(async () => {
        const folders = this.app.vault.getAllLoadedFiles()
          .filter((f) => f instanceof obsidian.TFolder)
          .map((f) => f.path);
        const modal = this.plugin.trackManagedModal(new AllowedRootsFolderSuggestModal(this.plugin, folders, async (chosen) => {
          const normalized = this.normalizeAllowedRootSelection(chosen);
          if (normalized === null) {
            new obsidian.Notice(`${getPluginName(this.plugin)}: ${t(this.plugin.app, "paths.allowedRoots.cannotAddRoot")}`);
            return;
          }
          if (!this.plugin.settings.allowedRoots.includes(normalized)) {
            this.plugin.settings.allowedRoots.push(normalized);
            await this.plugin.saveSettings();
            if (isCurrent()) {
              renderRoots();
            }
          }
        }));
        modal.open();
      })
    ).addExtraButton((btn) =>
      btn.setIcon("trash").setTooltip(t(this.plugin.app, "paths.allowedRoots.clear")).onClick(async () => {
        this.plugin.settings.allowedRoots = [];
        await this.plugin.saveSettings();
        if (isCurrent()) {
          renderRoots();
        }
      })
    );

    // Mark the trash icon with a class for styling (red hover)
    try {
      const icons = rootsSetting.controlEl.querySelectorAll('.clickable-icon');
      const lastIcon = icons[icons.length - 1];
      if (lastIcon) lastIcon.classList.add('tiny-local-roots-clear');
    } catch (error) {
      console.debug(getLogTag(this), "allowed roots clear icon styling failed (non-critical)", error);
    }

    renderRoots();
    new obsidian.Setting(containerEl).setName(t(this.plugin.app, "paths.output.name")).setDesc(t(this.plugin.app, "paths.output.desc")).addText((text) => text.setPlaceholder("Compressed").setValue(this.plugin.getOutputFolder()).onChange((value) => {
      const rawValue = value.trim();
      if (rawValue && !isValidOutputFolder(rawValue)) {
        text.setValue(this.plugin.getOutputFolder());
        new obsidian.Notice(`${getPluginName(this.plugin)}: ${t(this.plugin.app, "validation.pathNotAllowed")}`);
        return;
      }
      this.plugin.settings.outputFolder = normalizeOutputFolder(rawValue || "Compressed");
      this.debouncedSaveSettings();
    }));
    
  }
  renderAutomationSection(containerEl: HTMLElement, renderGeneration = this._renderGeneration) {
    const isCurrent = () => this.isRenderCurrent(renderGeneration, containerEl);
    this.renderSection(containerEl, "section.automation");
    new obsidian.Setting(containerEl).setName(t(this.plugin.app, "auto.newFiles.name")).setDesc(t(this.plugin.app, "auto.newFiles.desc")).addToggle((toggle) => toggle.setValue(this.plugin.settings.autoCompressNewFiles).onChange(async (value) => {
      this.plugin.settings.autoCompressNewFiles = value;
      await this.plugin.saveSettings();
    }));
    // Background compression + conditional threshold slider (without full re-render)
    const bgSetting = new obsidian.Setting(containerEl).setName(t(this.plugin.app, "auto.bg.name")).setDesc(t(this.plugin.app, "auto.bg.desc"));
    bgSetting.addToggle((toggle) => toggle.setValue(this.plugin.settings.autoBackgroundCompression).onChange(async (value) => {
      this.plugin.settings.autoBackgroundCompression = value;
      await this.plugin.saveSettings();
      if (isCurrent()) {
        this.applySubsettingVisibility(value, thresholdRow, inactivityRow);
      }
    }));
    const thresholdRow = new obsidian.Setting(containerEl).setName(t(this.plugin.app, "auto.bg.threshold.name")).setDesc(t(this.plugin.app, "auto.bg.threshold.desc"));
    thresholdRow.addSlider((slider) => slider
      .setLimits(10, 1000, 5)
      .setValue(this.plugin.settings.autoBackgroundThreshold)
      .setDynamicTooltip()
      .onChange((value) => {
        this.plugin.settings.autoBackgroundThreshold = value;
        this.plugin.backgroundCompressionService.AUTO_BACKGROUND_THRESHOLD = value;
        this.debouncedSaveSettings();
      })
    );
    this.applySubsettingVisibility(this.plugin.settings.autoBackgroundCompression, thresholdRow);
    const inactivityRow = new obsidian.Setting(containerEl).setName(t(this.plugin.app, "auto.bg.inactivity.name")).setDesc(t(this.plugin.app, "auto.bg.inactivity.desc"));
    inactivityRow.addSlider((slider) => slider
      .setLimits(1, 60, 1)
      .setValue(this.plugin.settings.inactivityThresholdMinutes)
      .setDynamicTooltip()
      .onChange((value) => {
        this.plugin.settings.inactivityThresholdMinutes = value;
        this.plugin.backgroundCompressionService.USER_INACTIVITY_THRESHOLD = value * 60 * 1000;
        this.debouncedSaveSettings();
      })
    );
    this.applySubsettingVisibility(this.plugin.settings.autoBackgroundCompression, inactivityRow);

    // Backups retention: toggle + slider
    const retentionToggle = new obsidian.Setting(containerEl).setName(t(this.plugin.app, "auto.retention.toggle.name")).setDesc(t(this.plugin.app, "auto.retention.toggle.desc"));
    retentionToggle.addToggle((toggle) => toggle.setValue(this.plugin.settings.autoBackupsRetentionEnabled).onChange(async (value) => {
      this.plugin.settings.autoBackupsRetentionEnabled = value;
      await this.plugin.saveSettings();
      if (isCurrent()) {
        this.applySubsettingVisibility(value, retentionRow);
      }
    }));
    const retentionRow = new obsidian.Setting(containerEl).setName(t(this.plugin.app, "auto.retention.days.name")).setDesc(t(this.plugin.app, "auto.retention.days.desc"));
    retentionRow.addSlider((slider) => slider
      .setLimits(1, 365, 1)
      .setValue(this.plugin.settings.autoBackupsRetentionDays)
      .setDynamicTooltip()
      .onChange((value) => {
        this.plugin.settings.autoBackupsRetentionDays = value;
        this.debouncedSaveSettings();
      })
    );
    this.applySubsettingVisibility(this.plugin.settings.autoBackupsRetentionEnabled, retentionRow);

    // Auto-move compressed files: toggle + count slider
    const autoMoveToggle = new obsidian.Setting(containerEl).setName(t(this.plugin.app, "auto.move.toggle.name")).setDesc(t(this.plugin.app, "auto.move.toggle.desc"));
    autoMoveToggle.addToggle((toggle) => toggle.setValue(this.plugin.settings.autoMoveCompressedEnabled).onChange(async (value) => {
      this.plugin.settings.autoMoveCompressedEnabled = value;
      await this.plugin.saveSettings();
      if (isCurrent()) {
        this.applySubsettingVisibility(value, autoMoveRow);
      }
    }));
    const autoMoveRow = new obsidian.Setting(containerEl).setName(t(this.plugin.app, "auto.move.threshold.name")).setDesc(t(this.plugin.app, "auto.move.threshold.desc"));
    autoMoveRow.addSlider((slider) => slider
      .setLimits(1, 1000, 1)
      .setValue(this.plugin.settings.autoMoveCompressedThreshold)
      .setDynamicTooltip()
      .onChange((value) => {
        this.plugin.settings.autoMoveCompressedThreshold = value;
        this.debouncedSaveSettings();
      })
    );
    this.applySubsettingVisibility(this.plugin.settings.autoMoveCompressedEnabled, autoMoveRow);
  }
  renderStatsSection(containerEl: HTMLElement, statsSnapshot: StatsSnapshot) {
    this.renderSection(containerEl, "section.stats");
    const uncompressedSetting = new obsidian.Setting(containerEl).setName(t(this.plugin.app, "stats.uncompressed.name")).setDesc(`${t(this.plugin.app, "stats.uncompressed.ready")}: ${statsSnapshot.uncompressedImages}`);
    this.uncompressedStatsElement = uncompressedSetting.descEl;
    uncompressedSetting.addButton((button) => button.setButtonText(t(this.plugin.app, "common.refresh")).onClick(async () => {
      await this.runButtonTask(button, "common.refresh", "common.refreshing", async () => {
        await this.plugin.forceRefreshCache();
        await this.updateStats();
        new obsidian.Notice(`${getPluginName(this.plugin)}: ${t(this.plugin.app, "notice.cacheUpdated")}`);
      });
    }));
    const cacheStats = statsSnapshot.cacheStats;
    const cacheSetting = new obsidian.Setting(containerEl).setName(t(this.plugin.app, "stats.cache.name")).setDesc(`${t(this.plugin.app, "stats.cache.entries")}: ${cacheStats.total}, ${t(this.plugin.app, "stats.cache.size")}: ${Math.round(cacheStats.size / 1024)} ${t(this.plugin.app, "units.kb")}`);
    this.cacheStatsElement = cacheSetting.descEl;
    cacheSetting.addButton((button) => this.setDestructiveButton(button).setButtonText(t(this.plugin.app, "common.clearCache")).onClick(async () => {
      await this.runButtonTask(button, "common.clearCache", "common.clearing", async () => {
        if (!await this.plugin.cache.clearCache()) {
          throw new Error("Cache clear was not durably committed");
        }
        await this.plugin.rebuildImageIndex("cache-clear");
        await this.plugin.statusBarController.update();
        await this.updateStats();
        new obsidian.Notice(`${getPluginName(this.plugin)}: ${t(this.plugin.app, "notice.cacheCleared")}`);
      });
    })).addButton((button) => button.setButtonText(t(this.plugin.app, "common.refreshCache")).onClick(async () => {
      await this.runButtonTask(button, "common.refreshCache", "common.refreshing", async () => {
        await this.plugin.forceRefreshCache();
        await this.updateStats();
        new obsidian.Notice(`${getPluginName(this.plugin)}: ${t(this.plugin.app, "notice.cacheUpdated")}`);
      });
    }));
  }
  renderMoveSection(containerEl: HTMLElement, statsSnapshot: StatsSnapshot) {
    this.renderSection(containerEl, "section.move");
    
    // Button: move compressed files
    const moveSetting = new obsidian.Setting(containerEl).setName(t(this.plugin.app, "move.title")).setDesc(`${t(this.plugin.app, "move.ready")}: ${statsSnapshot.compressedFilesCount}`);
    this.compressedFilesCountElement = moveSetting.descEl;
    moveSetting.addButton((button) => this.setDestructiveButton(button).setButtonText(t(this.plugin.app, "move.button")).onClick(async () => {
      await this.runButtonTask(button, "move.button", "common.processing", async () => {
        await this.plugin.moveService.moveCompressedToFiles();
        // Update all stats after operation
        await this.updateStats();
      }, "Move compressed files action failed:");
    }));
    
    // Button: clear backups of moved files
    new obsidian.Setting(containerEl).setName(t(this.plugin.app, "backups.imagesFolder.clearName")).setDesc(t(this.plugin.app, "backups.imagesFolder.clearDesc")).addButton((button) => this.setDestructiveButton(button).setButtonText(t(this.plugin.app, "backups.imagesFolder.clearButton")).onClick(async () => {
      await this.runButtonTask(button, "backups.imagesFolder.clearButton", "common.clearing", async () => {
        await this.plugin.clearOriginalFilesBackups();
      }, "Clear image backups action failed:", "backups.imagesFolder.clearError");
    }));

    // Button: open image backups folder (desktop only — mobile has no OS file manager)
    const revealPath = this.plugin.getPlatformPorts().runtime.revealPath;
    if (revealPath) {
      new obsidian.Setting(containerEl)
        .setName(t(this.plugin.app, "backups.imagesFolder.name"))
        .setDesc(t(this.plugin.app, "backups.imagesFolder.desc"))
        .addButton((button) => button
          .setButtonText(t(this.plugin.app, "backups.imagesFolder.openButton"))
          .onClick(async () => {
            try {
              const dir = this.plugin.getBackupStoragePaths().originalFilesBackups;
              await this.plugin.getPlatformPorts().fs.mkdir(dir);
              const err = await revealPath(dir);
              if (err) {
                console.error(getLogTag(this), 'Error opening image backups folder:', err);
                new obsidian.Notice(`${getPluginName(this.plugin)}: ${t(this.plugin.app, "backups.imagesFolder.openError")}`);
              }
            } catch (e) {
              console.error(getLogTag(this), 'Error opening image backups folder:', e);
              new obsidian.Notice(`${getPluginName(this.plugin)}: ${t(this.plugin.app, "backups.imagesFolder.openError")}`);
            }
          })
        );
    }

  }
  async renderCacheBackupsSection(containerEl: HTMLElement, renderGeneration: number | null = null) {
    const isCurrent = () => renderGeneration === null || this.isRenderCurrent(renderGeneration, containerEl);
    if (!isCurrent()) {
      return;
    }
    this.renderSection(containerEl, "backups.cache.title");
    const fsPort = this.plugin.getPlatformPorts().fs;
    if (fsPort.restoreProbe || fsPort.processTextAtomically) {
      const backups = await this.plugin.cache.getAvailableBackups();
      if (!isCurrent()) {
        return;
      }
      if (backups.length === 0) {
        new obsidian.Setting(containerEl).setName(t(this.plugin.app, "backups.cache.restore")).setDesc(t(this.plugin.app, "backups.cache.none")).setDisabled(true);
      } else {
        new obsidian.Setting(containerEl).setName(t(this.plugin.app, "backups.cache.restore")).setDesc(`${t(this.plugin.app, "backups.cache.available")} ${backups.length}`).addDropdown((dropdown) => {
          dropdown.addOption("", t(this.plugin.app, "backups.cache.selectPlaceholder"));
          backups.forEach((backup) => {
            const date = backup.replace("tinyLocal-cache-backup-", "").replace(".json", "").replace(/-/g, ":").replace(/T/, " ");
            dropdown.addOption(backup, date);
          });
          dropdown.onChange(async (value) => {
            if (value) {
              try {
                const success = await this.plugin.cache.restoreFromBackup(value);
                if (!success) {
                  throw new Error("Cache restore returned false");
                }
                await this.plugin.rebuildImageIndex("cache-restore");
                await this.plugin.statusBarController.update();
                await this.updateStats();
                new obsidian.Notice(`${getPluginName(this.plugin)}: ${t(this.plugin.app, "notice.cacheUpdated")}`);
              } catch (error) {
                this.showSettingsOperationError(error, "Cache restore action failed:");
              }
            }
          });
        });
      }
    }
    new obsidian.Setting(containerEl).setName(t(this.plugin.app, "backups.cache.folder.name")).setDesc(t(this.plugin.app, "backups.cache.folder.desc")).addButton((button) => button.setButtonText(t(this.plugin.app, "backups.cache.folder.openButton")).onClick(async () => {
      await this.plugin.showCacheBackupsList();
    }));

    // (Moved to "Move compressed files" section)
  }
  
  async renderSavingsIndicator(containerEl: HTMLElement, savings: SavingsSnapshot | null = null) {
    const renderGeneration = this._renderGeneration;
    const renderContainer = this.containerEl;
    try {
      savings = savings || await this.plugin.savingsCalculator.calculateSpaceSavings();

      if (!this.isRenderCurrent(renderGeneration, renderContainer)) {
        return;
      }

      if (!this.plugin.savingsCalculator.validateSavingsData(savings)) {
        return; // Do not render if data is not valid
      }
      
      // Create container for indicator
      const indicatorContainer = containerEl.createDiv({
        cls: "tiny-local-savings-indicator"
      });
      
      // Create textual summary
      const textInfo = indicatorContainer.createDiv({
        cls: "tiny-local-savings-text"
      });
      
      const { originalFormatted, currentFormatted, savedFormatted, estimatedIndicator } = this.plugin.savingsCalculator.formatTooltipData(savings);
      
      textInfo.createEl("strong", { text: `${t(this.plugin.app, "savings.original")}:` });
      textInfo.createSpan({ text: ` ${originalFormatted}${estimatedIndicator} \u2192 ` });
      textInfo.createEl("strong", { text: `${t(this.plugin.app, "savings.current")}:` });
      textInfo.createSpan({ text: ` ${currentFormatted} \u2192 ` });
      textInfo.createEl("strong", { text: `${t(this.plugin.app, "savings.saved")}:` });
      textInfo.createSpan({ text: ` ${savedFormatted} (${savings.savedPercentage}%)${estimatedIndicator}` });
      
      // Create progress bar
      const barContainer = indicatorContainer.createDiv({
        cls: "tiny-local-savings-bar"
      });
      barContainer.setAttribute("aria-hidden", "true");
      
      // Compute bar proportions with divide-by-zero/NaN protection
      const { savedWidth, currentWidth } = this.getSavingsBarWidths(savings);
      

      
      // Create saved space segment
      if (savedWidth > 0) {
        const savedBlock = barContainer.createDiv({
          cls: "tiny-local-savings-saved"
        });
        // dynamic: required at runtime
        savedBlock.setCssProps({
          "--local-image-compress-savings-width": `${savedWidth}%`
        });
      }
      
      // Create current size segment (always create, even if 0%)
      const currentBlock = barContainer.createDiv({
        cls: "tiny-local-savings-current"
      });
      // dynamic: required at runtime
      currentBlock.setCssProps({
        "--local-image-compress-savings-width": `${currentWidth}%`
      });
      
      // Fallback: if both are 0, render empty block for visibility
      if (savedWidth === 0 && currentWidth === 0) {
        barContainer.createDiv({
          cls: "tiny-local-savings-current tiny-local-savings-fallback"
        });
      }
      
      // Attach tooltip
      this.createSavingsTooltip(indicatorContainer, savings);
      
    } catch (error) {
      console.error(getLogTag(this), "Savings indicator render error:", error);
    }
  }
  
  createSavingsTooltip(container: HTMLElement, savings: SavingsSnapshot) {
    try {
      const { originalFormatted, currentFormatted, savedFormatted, estimatedIndicator, estimatedText } = this.plugin.savingsCalculator.formatTooltipData(savings);
      const accessibleSummary = [
        `${t(this.plugin.app, "tooltip.savings.original")} ${originalFormatted}${estimatedIndicator}`,
        `${t(this.plugin.app, "tooltip.savings.current")} ${currentFormatted}`,
        `${t(this.plugin.app, "tooltip.savings.saved")} ${savedFormatted} (${savings.savedPercentage}%)${estimatedIndicator}`,
        `${t(this.plugin.app, "tooltip.savings.filesProcessed")} ${savings.processedFiles} / ${savings.totalFiles}${estimatedText}`
      ].join(". ");
      
      // Create custom tooltip
      let tooltip: HTMLElement | null = null;
      let isTooltipActive = false;
      let showTimer: TimerHandle | null = null;
      let hideTimer: TimerHandle | null = null;
      let positionFrame: OwnedAnimationFrame | null = null;
      const ownerWindow = container.win || this.getActiveWindow();
      const activeDocument = container.doc || ownerWindow.document || this.getActiveDocument();
      const tooltipRoot = activeDocument?.body;
      if (!tooltipRoot) {
        return;
      }
      this._savingsTooltipDocuments?.add?.(activeDocument);
      const clearTooltipTimeout = ownerWindow.clearTimeout.bind(ownerWindow);
      const setTooltipTimeout = ownerWindow.setTimeout.bind(ownerWindow);
      const clearTooltipTimer = (timer: TimerHandle | null) => {
        if (timer) {
          clearTooltipTimeout(timer as number);
        }
      };
      const clearShowTimer = () => {
        clearTooltipTimer(showTimer);
        showTimer = null;
      };
      const clearHideTimer = () => {
        clearTooltipTimer(hideTimer);
        hideTimer = null;
      };
      const addTooltipItem = (parent: HTMLElement, label: string, value: string) => {
        const item = parent.createDiv({ cls: "tooltip-item" });
        item.createSpan({ text: label, cls: "tooltip-label" });
        item.createSpan({ text: value, cls: "tooltip-value" });
      };
      const showTooltip = () => {
        if (tooltip || !isTooltipActive) return;
        
        tooltip = tooltipRoot.createDiv();
        tooltip.classList.add("tiny-local-savings-tooltip-wrapper");
        const tooltipContent = tooltip.createDiv({ cls: "tiny-local-savings-tooltip" });
        tooltipContent.classList.add("tiny-local-savings-tooltip-placement-above");
        tooltipContent.id = "tiny-local-savings-tooltip";
        tooltipContent.setAttribute("role", "tooltip");
        container.setAttribute("aria-describedby", tooltipContent.id);
        tooltipContent.createDiv({ text: t(this.plugin.app, "tooltip.savings.header"), cls: "tooltip-header" });
        addTooltipItem(tooltipContent, t(this.plugin.app, "tooltip.savings.original"), `${originalFormatted}${estimatedIndicator}`);
        addTooltipItem(tooltipContent, t(this.plugin.app, "tooltip.savings.current"), currentFormatted);
        addTooltipItem(tooltipContent, t(this.plugin.app, "tooltip.savings.saved"), `${savedFormatted} (${savings.savedPercentage}%)${estimatedIndicator}`);
        addTooltipItem(tooltipContent, t(this.plugin.app, "tooltip.savings.filesProcessed"), `${savings.processedFiles} / ${savings.totalFiles}${estimatedText}`);
        tooltipRoot.appendChild(tooltip);
        
        // Position tooltip after a frame to ensure proper sizes
        positionFrame = this.requestWindowAnimationFrame(() => {
          positionFrame = null;
          if (!tooltip || !tooltipRoot.contains(tooltip)) return;
          
          const rect = container.getBoundingClientRect();
          const tooltipRect = tooltip.getBoundingClientRect();
          
          let left = rect.left + (rect.width / 2) - (tooltipRect.width / 2);
          let top = rect.top - tooltipRect.height - 10;
          let placement: "above" | "below" = "above";
          
          // Ensure on-screen positioning
          const margin = 10;
          const maxLeft = ownerWindow.innerWidth - tooltipRect.width - margin;
          const maxTop = ownerWindow.innerHeight - tooltipRect.height - margin;
          
          left = Math.max(margin, Math.min(left, maxLeft));
          
          if (top < margin) {
            top = rect.bottom + margin;
            placement = "below";
          }
          top = Math.max(margin, Math.min(top, maxTop));
          const arrowPadding = 12;
          const targetCenterX = rect.left + (rect.width / 2);
          const maxArrowX = Math.max(arrowPadding, tooltipRect.width - arrowPadding);
          const arrowX = Math.max(arrowPadding, Math.min(targetCenterX - left, maxArrowX));
          tooltipContent.classList.remove("tiny-local-savings-tooltip-placement-above", "tiny-local-savings-tooltip-placement-below");
          tooltipContent.classList.add(`tiny-local-savings-tooltip-placement-${placement}`);
          
          // dynamic position via CSS custom properties (static styles live in CSS)
          tooltip.setCssProps({
            "--local-image-compress-savings-tooltip-left": `${left}px`,
            "--local-image-compress-savings-tooltip-top": `${top}px`,
            "--local-image-compress-savings-tooltip-arrow-x": `${arrowX}px`
          });
        }, ownerWindow);
      };
      
      const hideTooltip = () => {
        this.cancelOwnedAnimationFrame(positionFrame);
        positionFrame = null;
        if (tooltip && tooltipRoot.contains(tooltip)) {
          tooltipRoot.removeChild(tooltip);
        }
        tooltip = null;
        container.removeAttribute("aria-describedby");
      };
      
      const activateTooltip = (delay: number) => {
        isTooltipActive = true;
        clearShowTimer();
        clearHideTimer();
        showTimer = setTooltipTimeout(showTooltip, delay);
      };

      const deactivateTooltip = () => {
        isTooltipActive = false;
        clearShowTimer();
        clearHideTimer();
        hideTimer = setTooltipTimeout(hideTooltip, 100);
      };

      container.addClass("tiny-local-savings-tooltip-target");
      container.setAttribute("role", "group");
      container.setAttribute("tabindex", "0");
      container.setAttribute("aria-label", accessibleSummary);
      const onMouseEnter = () => activateTooltip(200);
      const onMouseLeave = () => deactivateTooltip();
      const onFocus = () => activateTooltip(0);
      const onBlur = () => deactivateTooltip();
      const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.preventDefault();
          isTooltipActive = false;
          clearShowTimer();
          clearHideTimer();
          hideTooltip();
        }
      };
      // Render-scoped: dispose() owns this cleanup, so listeners do not accumulate on the plugin root component.
      container.addEventListener('mouseenter', onMouseEnter);
      container.addEventListener('mouseleave', onMouseLeave);
      container.addEventListener('focus', onFocus);
      container.addEventListener('blur', onBlur);
      container.addEventListener('keydown', onKeyDown);
      this._savingsTooltipCleanups.push(() => {
        container.removeEventListener('mouseenter', onMouseEnter);
        container.removeEventListener('mouseleave', onMouseLeave);
        container.removeEventListener('focus', onFocus);
        container.removeEventListener('blur', onBlur);
        container.removeEventListener('keydown', onKeyDown);
        clearShowTimer();
        clearHideTimer();
        isTooltipActive = false;
        hideTooltip();
      });
    } catch (error) {
      console.error(getLogTag(this), "Tooltip creation error:", error);
    }
  }
}
