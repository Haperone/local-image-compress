import * as obsidian from "obsidian";
import type { default as LocalImageCompressPlugin } from "../plugin";
import type { TimerHandle } from "../types";
import { t } from "../i18n";

export class FolderSelectorModal extends obsidian.Modal {
  private readonly plugin: LocalImageCompressPlugin;
  private readonly folderPaths: string[];
  private resolveSelection: ((value: string | null) => void) | null;
  private settled = false;
  private listenerCleanups: Array<() => void> = [];
  private focusTimer: TimerHandle | null = null;
  private readonly returnFocusTo: HTMLElement | null;

  constructor(plugin: LocalImageCompressPlugin, folderPaths: string[], resolveSelection: (value: string | null) => void) {
    super(plugin.app);
    this.plugin = plugin;
    this.folderPaths = folderPaths;
    this.resolveSelection = resolveSelection;
    this.returnFocusTo = plugin.captureModalFocusTarget();
    this.titleEl.setText(t(this.plugin.app, "folderSelect.title"));
    this.titleEl.id = "tiny-local-folder-select-title";
  }

  static show(plugin: LocalImageCompressPlugin, folderPaths: string[]): Promise<string | null> {
    return new Promise<string | null>((resolveSelection) => {
      const modal = new FolderSelectorModal(plugin, folderPaths, resolveSelection);
      plugin.trackManagedModal(modal);
      modal.open();
    });
  }

  override onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("tiny-local-folder-select-modal");
    contentEl.setAttribute("aria-labelledby", "tiny-local-folder-select-title");

    const select = contentEl.createEl("select", { cls: "tiny-local-folder-select-control" });
    select.setAttribute("aria-label", t(this.plugin.app, "folderSelect.selectLabel"));
    for (const folderPath of this.folderPaths) {
      const option = select.createEl("option", {
        text: folderPath === "/" ? t(this.plugin.app, "folderSelect.root") : folderPath
      });
      option.value = folderPath;
    }
    select.value = this.folderPaths[0] ?? "";

    const actionsEl = contentEl.createDiv({ cls: "modal-button-container" });
    const okButton = actionsEl.createEl("button", {
      text: t(this.plugin.app, "folderSelect.select"),
      cls: "mod-cta"
    });
    okButton.id = "select-folder";
    okButton.type = "button";
    okButton.setAttribute("aria-label", t(this.plugin.app, "folderSelect.select"));

    const cancelButton = actionsEl.createEl("button", {
      text: t(this.plugin.app, "folderSelect.cancel")
    });
    cancelButton.id = "cancel-folder";
    cancelButton.type = "button";
    cancelButton.setAttribute("aria-label", t(this.plugin.app, "folderSelect.cancel"));

    const onOkClick = () => this.settle(select.value);
    const onCancelClick = () => this.settle(null);
    const onContentKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        this.settle(null);
      } else if (event.key === "Enter") {
        event.preventDefault();
        this.settle(select.value);
      }
    };

    okButton.addEventListener("click", onOkClick);
    cancelButton.addEventListener("click", onCancelClick);
    contentEl.addEventListener("keydown", onContentKeydown);
    this.listenerCleanups.push(
      () => okButton.removeEventListener("click", onOkClick),
      () => cancelButton.removeEventListener("click", onCancelClick),
      () => contentEl.removeEventListener("keydown", onContentKeydown)
    );

    this.focusTimer = this.plugin.setWindowTimeout(() => {
      this.focusTimer = null;
      select.focus();
    }, 0);
  }

  override onClose() {
    if (this.focusTimer) {
      this.plugin.clearWindowTimeout(this.focusTimer);
      this.focusTimer = null;
    }
    for (const listenerCleanup of this.listenerCleanups) {
      listenerCleanup();
    }
    this.listenerCleanups = [];
    this.plugin.untrackManagedModal(this);
    this.contentEl.empty();
    this.resolveIfPending(null);
    this.plugin.restoreModalFocus(this.returnFocusTo);
  }

  private settle(value: string | null) {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.resolveSelection?.(value);
    this.resolveSelection = null;
    this.close();
  }

  private resolveIfPending(value: string | null) {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.resolveSelection?.(value);
    this.resolveSelection = null;
  }
}
