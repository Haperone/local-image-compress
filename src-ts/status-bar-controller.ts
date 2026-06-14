import { t } from "./i18n";
import { getLogTag, getPluginName } from "./utils";
import type LocalImageCompressPlugin from "./plugin";
import type { TimerHandle } from "./types";

type StatusMenuAction = {
  action: () => unknown;
  text: string;
};

type StatusMenuOpenEvent = {
  keyboard?: boolean;
  preventDefault?: () => void;
  returnFocusTo?: { focus?: () => void } | null;
  target?: EventTarget | null;
};

const STATUS_MENU_VIEWPORT_MARGIN = 10;
const STATUS_MENU_FALLBACK_WIDTH = 360;
const STATUS_MENU_FALLBACK_HEIGHT = 160;

export class StatusBarController {
  private readonly plugin: LocalImageCompressPlugin;
  private openStatusMenu: HTMLElement | null = null;
  private openStatusMenuDocument: Document | null = null;
  private teardownStatusMenuListeners: (() => void) | null = null;
  private deferredClickTimer: TimerHandle | null = null;
  private statusMenuFocusTarget: { focus?: () => void } | null = null;

  constructor(plugin: LocalImageCompressPlugin) {
    this.plugin = plugin;
  }

  closeMenu(restoreFocus = false): void {
    this.clearDeferredClickTimer();
    if (typeof this.teardownStatusMenuListeners === "function") {
      try {
        const focusTarget = this.statusMenuFocusTarget;
        this.teardownStatusMenuListeners();
        if (restoreFocus) {
          this.restoreStatusMenuFocus(focusTarget);
        }
      } catch (error) {
        this.ignoreNonCriticalError(error);
      }
      return;
    }
    const activeDocument = this.openStatusMenuDocument || this.plugin.getActiveDocument();
    if (this.openStatusMenu && activeDocument.body.contains(this.openStatusMenu)) {
      try {
        activeDocument.body.removeChild(this.openStatusMenu);
      } catch (error) {
        this.ignoreNonCriticalError(error);
      }
    }
    this.openStatusMenu = null;
    this.openStatusMenuDocument = null;
    this.statusMenuFocusTarget = null;
    this.setStatusMenuExpanded(false);
  }

  async update(): Promise<void> {
    if (!this.plugin.statusBarItem) {
      return;
    }
    const { uncompressedImages: uncompressedCount, totalImages: totalCount } = await this.plugin.getImageCompressionCounts();
    if (totalCount > 0) {
      const backlogThreshold = this.plugin.settings.autoBackgroundThreshold || this.plugin.backgroundCompressionService.AUTO_BACKGROUND_THRESHOLD || 50;
      const hasBacklog = uncompressedCount >= backlogThreshold;
      const statusText = this.plugin.backgroundCompressionService.isBackgroundCompressionRunning
        ? `\u27F3 ${uncompressedCount} / ${totalCount}`
        : hasBacklog
          ? `\u25CF ${uncompressedCount} / ${totalCount}`
          : `${uncompressedCount} / ${totalCount}`;
      const accessibleStatusText = `${getPluginName(this.plugin)}: ${statusText}`;
      this.plugin.statusBarItem.setText(statusText);
      this.plugin.statusBarItem.setAttribute?.("aria-label", accessibleStatusText);
      this.plugin.statusBarItem.setAttribute?.("title", accessibleStatusText);
      this.plugin.statusBarItem.show();
      this.plugin.statusBarItem.removeClass("tiny-local-compressing");
      this.plugin.statusBarItem.removeClass("tiny-local-status-attention");
      if (this.plugin.backgroundCompressionService.isBackgroundCompressionRunning) {
        this.plugin.statusBarItem.addClass("tiny-local-compressing");
      } else if (hasBacklog) {
        this.plugin.statusBarItem.addClass("tiny-local-status-attention");
      } else {
        this.plugin.statusBarItem.removeClass("tiny-local-compressing");
      }
    } else {
      this.plugin.statusBarItem.hide();
    }
  }

  async showMenu(event: StatusMenuOpenEvent): Promise<void> {
    const activeDocument = this.plugin.getActiveDocument();
    const activeWindow = this.plugin.getActiveWindow();
    // Close a previously opened menu before rendering the new one.
    this.closeMenu();

    const [
      { uncompressedImages: uncompressedCount, totalImages: totalCount },
      movableCompressedCount
    ] = await Promise.all([
      this.plugin.getImageCompressionCounts(),
      this.plugin.moveService.getCompressedFilesCount()
    ]);
    const menu = this.createMenu(event, uncompressedCount, totalCount, movableCompressedCount, activeDocument);
    if (!menu) {
      this.setStatusMenuExpanded(false);
      return;
    }
    activeDocument.body.appendChild(menu);
    this.positionMenu(menu, event, activeWindow);
    this.setStatusMenuExpanded(true);
    this.statusMenuFocusTarget = event?.returnFocusTo ?? (event?.keyboard ? event?.target as { focus?: () => void } ?? null : null);

    // Attach listeners with centralized teardown
      const teardown = (() => {
      const onDocClick = (e: MouseEvent) => {
        const target = e.target as Node | null;
        if (!target || !menu.contains(target)) {
          cleanup(false);
        }
      };
      const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault?.();
          e.stopPropagation();
          e.stopImmediatePropagation();
          cleanup(true);
        } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          this.focusAdjacentMenuItem(menu, e, e.key === "ArrowDown" ? 1 : -1);
        } else if (e.key === "Home" || e.key === "End") {
          this.focusBoundaryMenuItem(menu, e, e.key === "Home" ? 0 : -1);
        }
      };
      const onBlur = () => cleanup(false);
      let clickListenerAttached = false;

      const cleanup = (restoreFocus = false) => {
        const focusTarget = this.statusMenuFocusTarget;
        this.clearDeferredClickTimer();
        if (clickListenerAttached) {
          activeDocument.removeEventListener('click', onDocClick);
          clickListenerAttached = false;
        }
        activeDocument.removeEventListener('keydown', onKeyDown);
        activeWindow.removeEventListener('blur', onBlur);
        if (activeDocument.body.contains(menu)) {
          try {
            activeDocument.body.removeChild(menu);
          } catch (error) {
            this.ignoreNonCriticalError(error);
          }
        }
        if (this.openStatusMenu === menu) this.openStatusMenu = null;
        if (this.openStatusMenuDocument === activeDocument) this.openStatusMenuDocument = null;
        if (this.teardownStatusMenuListeners === cleanup) this.teardownStatusMenuListeners = null;
        if (this.statusMenuFocusTarget === focusTarget) this.statusMenuFocusTarget = null;
        this.setStatusMenuExpanded(false);
        if (restoreFocus) {
          this.restoreStatusMenuFocus(focusTarget);
        }
      };

      // Defer click binding to avoid immediate close due to the opening click
      this.deferredClickTimer = this.plugin.setWindowTimeout(() => {
        this.deferredClickTimer = null;
        if (this.plugin.isUnloading || this.openStatusMenu !== menu || this.teardownStatusMenuListeners !== cleanup) {
          return;
        }
        // transient: menu-scoped, removed on close via cleanup() (registerDomEvent would leak across opens)
        activeDocument.addEventListener('click', onDocClick);
        clickListenerAttached = true;
      }, 0);
      activeDocument.addEventListener('keydown', onKeyDown);
      activeWindow.addEventListener('blur', onBlur);
      return cleanup;
    })();

    this.openStatusMenu = menu;
    this.openStatusMenuDocument = activeDocument;
    this.teardownStatusMenuListeners = teardown;
    if (event?.keyboard) {
      this.focusFirstMenuItem(menu);
    }
  }

  private clearDeferredClickTimer(): void {
    if (!this.deferredClickTimer) {
      return;
    }
    try {
      this.plugin.clearWindowTimeout(this.deferredClickTimer);
    } catch (error) {
      this.ignoreNonCriticalError(error);
    }
    this.deferredClickTimer = null;
  }

  private ignoreNonCriticalError(_error: unknown): void {
    void _error;
  }

  private setStatusMenuExpanded(expanded: boolean): void {
    this.plugin.statusBarItem?.setAttribute?.("aria-expanded", expanded ? "true" : "false");
  }

  private restoreStatusMenuFocus(focusTarget: { focus?: () => void } | null): void {
    try {
      focusTarget?.focus?.();
      this.plugin.requestWindowAnimationFrame(() => {
        if (this.plugin.isUnloading || !focusTarget?.focus) {
          return;
        }
        const activeElement = this.plugin.getActiveDocument().activeElement;
        if (activeElement !== focusTarget) {
          focusTarget.focus();
        }
      });
      this.plugin.setWindowTimeout(() => {
        if (!this.plugin.isUnloading) {
          focusTarget?.focus?.();
        }
      }, 0);
    } catch (error) {
      this.ignoreNonCriticalError(error);
    }
  }

  private getMenuItems(menu: HTMLElement): HTMLElement[] {
    return Array.from(menu.querySelectorAll(".tiny-local-status-menu-item"));
  }

  private focusFirstMenuItem(menu: HTMLElement): void {
    const firstItem = this.getMenuItems(menu)[0];
    try {
      firstItem?.focus?.();
    } catch (error) {
      this.ignoreNonCriticalError(error);
    }
  }

  private focusAdjacentMenuItem(menu: HTMLElement, event: KeyboardEvent, direction: 1 | -1): void {
    const menuItems = this.getMenuItems(menu);
    if (menuItems.length === 0) {
      return;
    }
    event.preventDefault?.();
    const activeDocument = this.openStatusMenuDocument || this.plugin.getActiveDocument();
    const activeElement = activeDocument.activeElement as HTMLElement | null;
    const currentTarget = event.target as HTMLElement | null || activeElement;
    const currentIndex = Math.max(
      currentTarget ? menuItems.indexOf(currentTarget) : -1,
      activeElement ? menuItems.indexOf(activeElement) : -1
    );
    const nextIndex = currentIndex >= 0
      ? (currentIndex + direction + menuItems.length) % menuItems.length
      : direction > 0
        ? 0
        : menuItems.length - 1;
    try {
      menuItems[nextIndex]?.focus?.();
    } catch (error) {
      this.ignoreNonCriticalError(error);
    }
  }

  private focusBoundaryMenuItem(menu: HTMLElement, event: KeyboardEvent, index: 0 | -1): void {
    const menuItems = this.getMenuItems(menu);
    if (menuItems.length === 0) {
      return;
    }
    event.preventDefault?.();
    try {
      menuItems[index === 0 ? 0 : menuItems.length - 1]?.focus?.();
    } catch (error) {
      this.ignoreNonCriticalError(error);
    }
  }

  private runMenuAction(action: StatusMenuAction["action"]): void {
    this.closeMenu(true);
    Promise.resolve(action()).catch((error) => {
      console.error(getLogTag(this.plugin), "Status menu action failed:", error);
    });
  }

  private getFiniteNumber(value: unknown, fallback: number): number {
    const numeric = typeof value === "number" ? value : Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  private getMenuTargetRect(event: StatusMenuOpenEvent): { bottom?: number; height: number; left: number; top: number; width: number } | null {
    const target = event?.target as { getBoundingClientRect?: () => { bottom?: number; height: number; left: number; top: number; width: number } } | null | undefined;
    const rect = target?.getBoundingClientRect?.();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      return null;
    }
    return rect;
  }

  private positionMenu(menu: HTMLElement, event: StatusMenuOpenEvent, activeWindow = this.plugin.getActiveWindow()): void {
    const rect = this.getMenuTargetRect(event);
    if (!rect) {
      return;
    }
    const measuredRect = menu.getBoundingClientRect?.();
    const measuredWidth = this.getFiniteNumber(measuredRect?.width, 0);
    const measuredHeight = this.getFiniteNumber(measuredRect?.height, 0);
    const menuWidth = measuredWidth > 0 ? measuredWidth : STATUS_MENU_FALLBACK_WIDTH;
    const menuHeight = measuredHeight > 0 ? measuredHeight : STATUS_MENU_FALLBACK_HEIGHT;
    const viewportWidth = Math.max(menuWidth + STATUS_MENU_VIEWPORT_MARGIN * 2, this.getFiniteNumber(activeWindow.innerWidth, menuWidth + STATUS_MENU_VIEWPORT_MARGIN * 2));
    const viewportHeight = Math.max(menuHeight + STATUS_MENU_VIEWPORT_MARGIN * 2, this.getFiniteNumber(activeWindow.innerHeight, menuHeight + STATUS_MENU_VIEWPORT_MARGIN * 2));
    const maxLeft = Math.max(STATUS_MENU_VIEWPORT_MARGIN, viewportWidth - menuWidth - STATUS_MENU_VIEWPORT_MARGIN);
    const left = Math.max(STATUS_MENU_VIEWPORT_MARGIN, Math.min(rect.left, maxLeft));
    const rectBottom = typeof rect.bottom === "number" ? rect.bottom : rect.top + rect.height;
    const topAbove = rect.top - menuHeight - STATUS_MENU_VIEWPORT_MARGIN;
    const topBelow = rectBottom + STATUS_MENU_VIEWPORT_MARGIN;
    const topFitsAbove = topAbove >= STATUS_MENU_VIEWPORT_MARGIN;
    const topFitsBelow = topBelow + menuHeight <= viewportHeight - STATUS_MENU_VIEWPORT_MARGIN;
    const preferredTop = topFitsAbove || !topFitsBelow ? topAbove : topBelow;
    const maxTop = Math.max(STATUS_MENU_VIEWPORT_MARGIN, viewportHeight - menuHeight - STATUS_MENU_VIEWPORT_MARGIN);
    const top = Math.max(STATUS_MENU_VIEWPORT_MARGIN, Math.min(preferredTop, maxTop));
    menu.setCssProps({
      "--local-image-compress-status-menu-left": `${Math.round(left)}px`,
      "--local-image-compress-status-menu-top": `${Math.round(top)}px`,
      "--local-image-compress-status-menu-transform": "none"
    });
  }

  createMenu(event: StatusMenuOpenEvent, uncompressedCount: number, totalCount: number, movableCompressedCount = 0, activeDocument = this.plugin.getActiveDocument()) {
    const rect = this.getMenuTargetRect(event);
    if (!rect) {
      console.warn(getLogTag(this.plugin), "Status menu skipped because the status bar item is not visible");
      return null;
    }
    const menu = activeDocument.body.createDiv();
    menu.className = "tiny-local-status-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", getPluginName(this.plugin));
    menu.createDiv({
      text: `${t(this.plugin.app, "stats.uncompressed.name")}: ${uncompressedCount} / ${totalCount}`,
      cls: "tiny-local-status-menu-header"
    });
    const menuItems: StatusMenuAction[] = [
      { text: t(this.plugin.app, "command.compressInNote"), action: () => this.plugin.compressImagesInNote() },
      { text: t(this.plugin.app, "command.compressAll"), action: () => this.plugin.compressAllImages() }
    ];
    if (movableCompressedCount > 0) {
      menuItems.push({
        text: `${t(this.plugin.app, "command.moveCompressed")} (${movableCompressedCount})`,
        action: () => this.plugin.moveService.moveCompressedToFiles()
      });
    }
    menuItems.forEach((item) => {
      const menuItem = menu.createEl("button", {
        text: item.text,
        cls: "tiny-local-status-menu-item"
      });
      menuItem.type = "button";
      menuItem.setAttribute("role", "menuitem");
      // transient: menu recreated per open; element removed on close
      menuItem.addEventListener("click", () => {
        this.runMenuAction(item.action);
      });
      menuItem.addEventListener("keydown", (event2: KeyboardEvent) => {
        if (event2.key !== "Enter" && event2.key !== " ") {
          return;
        }
        event2.preventDefault();
        this.runMenuAction(item.action);
      });
    });
    return menu;
  }
}
