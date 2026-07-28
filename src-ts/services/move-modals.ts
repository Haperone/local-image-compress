import * as obsidian from "obsidian";
import { t } from "../i18n";
import { getPluginName } from "../utils";
import type { default as LocalImageCompressPlugin } from "../plugin";
import type { CompressedFileRecord } from "../move-service";

// Owns the move-flow modals: the progress modal shown while files are replaced and the
// result summary modal with grouped skip reasons. MoveService keeps thin delegators so
// runtime QA and smoke tests can keep invoking them through the move service.
export class MoveModals {
  constructor(private readonly plugin: LocalImageCompressPlugin) {}

  showMoveProgressModal(totalFiles: number) {
    const pluginName = getPluginName(this.plugin);
    const owner = this.plugin;
    const modal = new class extends obsidian.Modal {
      totalFiles: number;
      currentFile: number;
      progressText!: HTMLElement;
      currentFileText!: HTMLElement;
      progressBar!: HTMLElement;
      progressFill!: HTMLElement;
      returnFocusTo: HTMLElement | null;

      constructor(app: obsidian.App, totalFiles: number) {
        super(app);
        this.totalFiles = totalFiles;
        this.currentFile = 0;
        this.returnFocusTo = owner.captureModalFocusTarget();
        this.titleEl.setText(`${pluginName}: ${t(this.app, "move.title")}`);
      }

      override onOpen() {
        const { contentEl } = this;
        contentEl.addClass("tiny-local-move-progress-modal");

        this.progressText = contentEl.createEl("p", {
          text: `${t(this.app, "progress.processing")}: 0 / ${this.totalFiles}`
        });
        this.progressText.setAttribute("role", "status");
        this.progressText.setAttribute("aria-live", "polite");
        this.progressText.setAttribute("aria-atomic", "true");

        this.currentFileText = contentEl.createEl("p", {
          text: t(this.app, "common.refresh")
        });

        this.progressBar = contentEl.createDiv({
          cls: "tiny-local-progress-bar"
        });
        this.progressBar.setAttribute("role", "progressbar");
        this.progressBar.setAttribute("aria-label", t(this.app, "move.title"));
        this.progressBar.setAttribute("aria-valuemin", "0");
        this.progressBar.setAttribute("aria-valuemax", String(this.totalFiles));
        this.progressBar.setAttribute("aria-valuenow", "0");
        this.progressBar.setAttribute("aria-valuetext", `${t(this.app, "progress.processing")}: 0 / ${this.totalFiles}`);

        this.progressFill = contentEl.createDiv({
          cls: "tiny-local-progress-fill"
        });

        this.progressBar.appendChild(this.progressFill);
        owner.scheduleElementFocus(this.modalEl.querySelector<HTMLElement>(".modal-close-button"));
      }

      updateProgress(current: number, total: number, fileName: string) {
        this.currentFile = current;
        const percentage = (current / total) * 100;

        this.progressText.setText(`${t(this.app, "progress.processing")}: ${current} / ${total}`);
        this.currentFileText.setText(`${t(this.app, "progress.processing")}: ${fileName}`);
        this.progressBar.setAttribute("aria-valuemax", String(Math.max(0, total)));
        this.progressBar.setAttribute("aria-valuenow", String(Math.max(0, Math.min(current, total))));
        this.progressBar.setAttribute("aria-valuetext", `${t(this.app, "progress.processing")}: ${current} / ${total}. ${fileName}`);
        // dynamic: required at runtime
        this.progressFill.setCssProps({
          "--local-image-compress-progress-width": `${percentage}%`
        });
      }

      override onClose() {
        const { contentEl } = this;
        owner.untrackManagedModal(this);
        contentEl.empty();
        owner.restoreModalFocus(this.returnFocusTo);
      }
    }(this.plugin.app, totalFiles);

    this.plugin.trackManagedModal(modal);
    modal.open();
    return modal;
  }

  showMoveResult(successCount: number, errorCount: number, backupCreated: boolean, skippedCount = 0, compressedFiles: CompressedFileRecord[] = []) {
    const pluginName = getPluginName(this.plugin);
    const owner = this.plugin;
    const skipReasonGroups = this.plugin.moveService.getMoveSkipReasonGroups(compressedFiles);
    const groupedSkippedCount = skipReasonGroups.reduce((total, group) => total + group.count, 0);
    const displaySkippedCount = groupedSkippedCount > 0 ? groupedSkippedCount : skippedCount;
    const modal = new class extends obsidian.Modal {
      successCount: number;
      errorCount: number;
      backupCreated: boolean;
      skippedCount: number;
      skipReasonGroups: Array<{ reason: string; count: number }>;
      listenerCleanups: Array<() => void>;
      returnFocusTo: HTMLElement | null;

      constructor(
        app: obsidian.App,
        successCount: number,
        errorCount: number,
        backupCreated: boolean,
        skippedCount: number,
        skipReasonGroups: Array<{ reason: string; count: number }>
      ) {
        super(app);
        this.successCount = successCount;
        this.errorCount = errorCount;
        this.backupCreated = backupCreated;
        this.skippedCount = skippedCount;
        this.skipReasonGroups = skipReasonGroups;
        this.listenerCleanups = [];
        this.returnFocusTo = owner.captureModalFocusTarget();
        this.titleEl.setText(`${pluginName}: ${t(this.app, "move.title")}`);
      }

      override onOpen() {
        const { contentEl } = this;
        contentEl.addClass("tiny-local-move-result-modal");

        if (this.successCount > 0) {
          contentEl.createEl("p", {
            text: `✅ ${t(this.app, "move.button")}: ${this.successCount}`,
            cls: "tiny-local-success"
          });
        }

        if (this.errorCount > 0) {
          contentEl.createEl("p", {
            text: `❌ ${t(this.app, "progress.error")}: ${this.errorCount}`,
            cls: "tiny-local-error"
          });
        }

        if (this.skippedCount > 0) {
          contentEl.createEl("p", {
            text: `${t(this.app, "progress.skipped")}: ${this.skippedCount}`,
            cls: "tiny-local-info"
          });
          if (this.skipReasonGroups.length > 0) {
            const reasonList = contentEl.createEl("ul", {
              cls: "tiny-local-move-skip-reasons"
            });
            for (const group of this.skipReasonGroups) {
              reasonList.createEl("li", {
                text: `${group.reason}: ${group.count}`
              });
            }
          }
        }

        if (this.backupCreated) {
          contentEl.createEl("p", {
            text: `\u{1F4BE} ${t(this.app, "move.backupCreated")}`,
            cls: "tiny-local-info"
          });
        }

        const closeButton = contentEl.createEl("button", {
          text: t(this.app, "common.close"),
          cls: "mod-cta"
        });
        closeButton.type = "button";
        closeButton.setAttribute("aria-label", t(this.app, "common.close"));

        const onCloseClick = () => {
          this.close();
        };
        // modal-scoped: cleaned in onClose() — registerDomEvent unavailable on Modal
        closeButton.addEventListener("click", onCloseClick);
        this.listenerCleanups.push(() => closeButton.removeEventListener("click", onCloseClick));
        owner.scheduleElementFocus(closeButton);
      }

      override onClose() {
        const { contentEl } = this;
        for (const cleanup of this.listenerCleanups) {
          cleanup();
        }
        this.listenerCleanups = [];
        owner.untrackManagedModal(this);
        contentEl.empty();
        owner.restoreModalFocus(this.returnFocusTo);
      }
    }(this.plugin.app, successCount, errorCount, backupCreated, displaySkippedCount, skipReasonGroups);

    this.plugin.trackManagedModal(modal);
    modal.open();
  }
}
