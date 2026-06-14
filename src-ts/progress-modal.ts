import * as obsidian from "obsidian";
import { t } from "./i18n";
import type LocalImageCompressPlugin from "./plugin";
import type { AnimationHandle, TimerHandle } from "./types";
import { getActiveWindowForApp } from "./utils";

type TextElement = HTMLElement & { setText(text: string): void };
type PendingProgressUpdate = {
  current: number;
  total: number;
  status: string;
  percentage: number;
};

export class ProgressModal extends obsidian.Modal {
  private readonly plugin: LocalImageCompressPlugin;
  private readonly progressLabel: string;
  statusElement: TextElement | null;
  progressContainer: HTMLElement | null;
  progressElement: HTMLElement | null;
  cancelButton: HTMLButtonElement | null;
  private abortController: AbortController | null;
  private cancelRequested: boolean;
  private isClosed: boolean;
  private closeTimer: TimerHandle | null;
  private animationHandle: AnimationHandle | null;
  private focusTimer: TimerHandle | null;
  private pendingProgressUpdate: PendingProgressUpdate | null;
  private cancelButtonCleanup: (() => void) | null;
  private readonly returnFocusTo: HTMLElement | null;

  constructor(plugin: LocalImageCompressPlugin, title: string) {
    super(plugin.app);
    this.plugin = plugin;
    this.progressLabel = title;
    this.statusElement = null;
    this.progressContainer = null;
    this.progressElement = null;
    this.cancelButton = null;
    this.abortController = null;
    this.cancelRequested = false;
    this.isClosed = true;
    this.closeTimer = null;
    this.animationHandle = null;
    this.focusTimer = null;
    this.pendingProgressUpdate = null;
    this.cancelButtonCleanup = null;
    this.returnFocusTo = plugin.captureModalFocusTarget();
    this.titleEl.setText(title);
  }
  getActiveWindow() {
    return getActiveWindowForApp(this.app) || window;
  }
  setModalTimeout(callback: () => void, delay: number) {
    return (this.contentEl?.win || this.getActiveWindow()).setTimeout(callback, delay);
  }
  clearModalTimeout(timer: TimerHandle | null | undefined) {
    if (timer === null || timer === undefined) {
      return;
    }
    (this.contentEl?.win || this.getActiveWindow()).clearTimeout(timer as number);
  }
  requestModalAnimationFrame(callback: () => void) {
    const ownerWindow = this.contentEl?.win || this.getActiveWindow();
    if (ownerWindow.requestAnimationFrame) {
      return ownerWindow.requestAnimationFrame(callback);
    }
    return this.setModalTimeout(callback, 0);
  }
  cancelModalAnimationFrame(handle: AnimationHandle | null | undefined) {
    if (handle === null || handle === undefined) {
      return;
    }
    const ownerWindow = this.contentEl?.win || this.getActiveWindow();
    if (ownerWindow.cancelAnimationFrame) {
      return ownerWindow.cancelAnimationFrame(handle as number);
    }
    return this.clearModalTimeout(handle);
  }
  override onOpen() {
    const { contentEl } = this;
    this.cancelRequested = false;
    this.isClosed = false;
    contentEl.empty();
    contentEl.createDiv({ text: t(this.app, "progress.processing"), cls: "tiny-local-progress-title" });
    this.statusElement = contentEl.createDiv({
      text: t(this.app, "progress.start"),
      cls: "tiny-local-progress-status"
    });
    this.statusElement.setAttribute("role", "status");
    this.statusElement.setAttribute("aria-live", "polite");
    this.statusElement.setAttribute("aria-atomic", "true");
    const progressContainer = contentEl.createDiv({ cls: "tiny-local-progress-container" });
    progressContainer.setAttribute("role", "progressbar");
    progressContainer.setAttribute("aria-label", this.progressLabel);
    progressContainer.setAttribute("aria-valuemin", "0");
    progressContainer.setAttribute("aria-valuemax", "100");
    progressContainer.setAttribute("aria-valuenow", "0");
    progressContainer.setAttribute("aria-valuetext", t(this.app, "progress.start"));
    this.progressContainer = progressContainer;
    const progressBar = progressContainer.createDiv({ cls: "tiny-local-progress-bar" });
    this.progressElement = progressBar.createDiv({ cls: "tiny-local-progress-fill" });
    const actionsEl = contentEl.createDiv({ cls: "tiny-local-progress-actions" });
    const cancelButton = actionsEl.createEl("button", {
      text: t(this.app, "common.cancel"),
      cls: "mod-warning tiny-local-progress-cancel"
    });
    cancelButton.type = "button";
    cancelButton.setAttribute("aria-label", t(this.app, "common.cancel"));
    const onCancelClick = () => this.requestCancel();
    // modal-scoped: cleaned in onClose() via cancelButtonCleanup — registerDomEvent unavailable on Modal
    cancelButton.addEventListener("click", onCancelClick);
    this.cancelButtonCleanup = () => cancelButton.removeEventListener("click", onCancelClick);
    this.cancelButton = cancelButton;
    this.focusTimer = this.setModalTimeout(() => {
      this.focusTimer = null;
      if (!this.isClosed) {
        cancelButton.focus();
      }
    }, 0);
    // Use adaptive CSS classes instead of inline styles
    contentEl.addClass("tiny-local-progress-modal");
  }
  setAbortController(controller: AbortController | null) {
    this.abortController = controller;
  }
  requestCancel() {
    if (this.isClosed || this.cancelRequested) {
      return;
    }
    this.cancelRequested = true;
    this.abortController?.abort();
    if (this.cancelButton) {
      this.cancelButton.disabled = true;
      this.cancelButton.textContent = t(this.app, "progress.cancelling");
    }
    this.setStatus(t(this.app, "progress.cancelling"));
    this.scheduleClose(1000);
  }
  updateProgress(current: number, total: number, status: string) {
    if (this.isClosed || !this.statusElement || !this.progressElement) {
      return;
    }
    const percentage = total > 0 ? Math.min(100, Math.max(0, current / total * 100)) : 0;
    this.pendingProgressUpdate = { current, total, status, percentage };
    if (this.animationHandle) {
      return;
    }
    this.animationHandle = this.requestModalAnimationFrame(() => {
      this.animationHandle = null;
      const pendingUpdate = this.pendingProgressUpdate;
      this.pendingProgressUpdate = null;
      if (this.isClosed || !this.statusElement || !this.progressElement || !pendingUpdate) {
        return;
      }
      this.statusElement.setText(`${pendingUpdate.status} (${pendingUpdate.current}/${pendingUpdate.total})`);
      this.progressContainer?.setAttribute("aria-valuemax", String(Math.max(0, pendingUpdate.total)));
      this.progressContainer?.setAttribute("aria-valuenow", String(Math.max(0, Math.min(pendingUpdate.current, pendingUpdate.total))));
      this.progressContainer?.setAttribute("aria-valuetext", `${pendingUpdate.status} (${pendingUpdate.current}/${pendingUpdate.total})`);
      this.progressElement.setCssProps({
        "--local-image-compress-progress-width": `${pendingUpdate.percentage}%`
      });
    });
  }
  setStatus(status: string) {
    if (this.isClosed || !this.statusElement) {
      return;
    }
    this.statusElement.setText(status);
    this.progressContainer?.setAttribute("aria-valuetext", status);
  }
  setCompleted(message: string) {
    if (this.isClosed || !this.statusElement || !this.progressElement) {
      return;
    }
    this.statusElement.setText(message);
    const maximum = this.progressContainer?.getAttribute("aria-valuemax") || "100";
    this.progressContainer?.setAttribute("aria-valuenow", maximum);
    this.progressContainer?.setAttribute("aria-valuetext", message);
    this.progressElement.setCssProps({
      "--local-image-compress-progress-width": "100%"
    });
    this.progressElement.classList.add("tiny-local-progress-completed");
    this.scheduleClose(2e3);
  }
  setCancelled(message: string) {
    if (this.isClosed || !this.statusElement || !this.progressElement) {
      return;
    }
    this.statusElement.setText(message);
    this.progressContainer?.setAttribute("aria-valuetext", message);
    this.progressElement.classList.add("tiny-local-progress-cancelled");
    this.scheduleClose(1000);
  }
  setError(message: string) {
    if (this.isClosed || !this.statusElement || !this.progressElement) {
      return;
    }
    this.statusElement.setText(message);
    this.progressContainer?.setAttribute("aria-valuetext", message);
    this.progressElement.classList.add("tiny-local-progress-error");
    this.scheduleClose(3e3);
  }
  private scheduleClose(delay: number) {
    if (this.isClosed) {
      return;
    }
    if (this.closeTimer) {
      this.clearModalTimeout(this.closeTimer);
    }
    this.closeTimer = this.setModalTimeout(() => {
      this.closeTimer = null;
      if (!this.isClosed) {
        this.close();
      }
    }, delay);
  }
  override onClose() {
    this.isClosed = true;
    if (this.closeTimer) {
      this.clearModalTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    if (this.animationHandle) {
      this.cancelModalAnimationFrame(this.animationHandle);
      this.animationHandle = null;
    }
    if (this.focusTimer) {
      this.clearModalTimeout(this.focusTimer);
      this.focusTimer = null;
    }
    this.pendingProgressUpdate = null;
    if (this.cancelButtonCleanup) {
      this.cancelButtonCleanup();
      this.cancelButtonCleanup = null;
    }
    // Remove classes on close
    if (this.progressElement) {
      this.progressElement.classList.remove("tiny-local-progress-completed", "tiny-local-progress-cancelled", "tiny-local-progress-error");
    }
    this.cancelButton = null;
    this.abortController = null;
    this.statusElement = null;
    this.progressContainer = null;
    this.progressElement = null;
    this.plugin.untrackManagedModal(this);
    this.plugin.restoreModalFocus(this.returnFocusTo);
  }
}
