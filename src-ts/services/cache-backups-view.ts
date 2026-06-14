import * as obsidian from "obsidian";
import * as fs from "fs";
import * as path from "path";
import type { default as LocalImageCompressPlugin } from "../plugin";
import { ConcurrencyLimiter } from "../concurrency-limiter";
import { getUserLang, t } from "../i18n";
import { getLogTag, getPluginName, openFilesystemPath } from "../utils";

// Lists cache backups (bounded stat fan-out) and renders the read-only backup modal.
export class CacheBackupsView {
  constructor(private readonly plugin: LocalImageCompressPlugin) {}

  async showCacheBackupsList() {
    try {
      const backupDir = this.plugin.getBackupStoragePaths().cacheBackups;
      try {
        await fs.promises.access(backupDir);
      } catch {
        await fs.promises.mkdir(backupDir, { recursive: true });
        new obsidian.Notice(`${this.plugin.manifest?.name || "Local Image Compress"}: ${t(this.plugin.app, "backups.cache.title")}`);
        return;
      }
      const backups = await this.plugin.cache.getAvailableBackups();
      if (backups.length === 0) {
        new obsidian.Notice(`${this.plugin.manifest?.name || "Local Image Compress"}: ${t(this.plugin.app, "backups.cache.none")}`);
        return;
      }
      const locale = getUserLang(this.plugin.app);
      const backupInfoLimiter = new ConcurrencyLimiter(8);
      const infoItems = await Promise.all(backups.map((backup) => backupInfoLimiter.run(async () => {
        try {
          const backupPath = path.join(backupDir, backup);
          const stats = await fs.promises.stat(backupPath);
          const sizeKb = (stats.size / 1024).toFixed(1);
          const date = stats.mtime.toLocaleString(locale);
          return `${backup} ${sizeKb} ${t(this.plugin.app, "units.kb")}, ${date}`;
        } catch {
          return `${backup}`;
        }
      })));
      const backupInfo = infoItems.join("\n");
      this.showBackupModal(backupDir, backups, backupInfo);
    } catch {
      new obsidian.Notice(`${this.plugin.manifest?.name || "Local Image Compress"}: ${t(this.plugin.app, "backups.imagesFolder.openError")}`);
    }
  }

  private showBackupModal(backupDir: string, backups: string[], backupInfo: string) {
    const pluginName = getPluginName(this.plugin);
    const owner = this.plugin;
    const modal = new class extends obsidian.Modal {
      listenerCleanups: Array<() => void>;
      returnFocusTo: HTMLElement | null;

      constructor(app: obsidian.App) {
        super(app);
        this.listenerCleanups = [];
        this.returnFocusTo = owner.captureModalFocusTarget();
        this.titleEl.setText(`${pluginName}: ${t(this.app, "backups.cache.title")}`);
      }

      override onOpen() {
        const { contentEl } = this;
        contentEl.createEl("p", { text: `${t(this.app, "backups.pathLabel")}: ${backupDir}` });
        contentEl.createEl("p", { text: `${t(this.app, "backups.foundLabel")}: ${backups.length}` });
        const list = contentEl.createDiv({ cls: "tiny-local-backup-list" });
        list.setAttribute("role", "list");
        list.setAttribute("aria-label", t(this.app, "backups.cache.title"));
        backupInfo.split("\n").forEach((line: string) => {
          const item = list.createDiv({ text: line });
          item.setAttribute("role", "listitem");
        });
        const openButton = contentEl.createEl("button", {
          text: t(this.app, "backups.imagesFolder.openButton"),
          cls: "mod-cta"
        });
        openButton.type = "button";
        const openBackupFolder = async () => {
          try {
            const openError = await openFilesystemPath(backupDir);
            if (openError) {
              console.error(getLogTag(owner), "Error opening cache backups folder:", openError);
              new obsidian.Notice(`${pluginName}: ${t(this.app, "backups.imagesFolder.openError")}`);
            }
          } catch (err) {
            console.error(getLogTag(owner), "Error opening cache backups folder:", err);
            new obsidian.Notice(`${pluginName}: ${t(this.app, "backups.imagesFolder.openError")}`);
          }
        };
        const onOpenButtonClick = () => {
          openBackupFolder().catch((error: unknown) => {
            console.error(getLogTag(owner), "Error opening cache backups folder:", error);
          });
        };
        // modal-scoped: cleaned in onClose() — registerDomEvent unavailable on Modal
        openButton.addEventListener("click", onOpenButtonClick);
        this.listenerCleanups.push(() => openButton.removeEventListener("click", onOpenButtonClick));
        owner.scheduleElementFocus(openButton);
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
    }(this.plugin.app);
    this.plugin.trackManagedModal(modal);
    modal.open();
  }
}
