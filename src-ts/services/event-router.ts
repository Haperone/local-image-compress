import type * as obsidian from "obsidian";
import { getLogTag } from "../utils";
import type LocalImageCompressPlugin from "../plugin";

type VaultWithOptionalConfigChange = obsidian.Vault & {
  on(name: "config-changed", callback: () => void | Promise<void>): obsidian.EventRef;
};

export class EventRouter {
  constructor(private readonly plugin: LocalImageCompressPlugin) {}

  private registerConfigChange() {
    try {
      const vault = this.plugin.app.vault as VaultWithOptionalConfigChange;
      const eventRef = vault.on("config-changed", () => this.plugin.handleLocaleConfigChanged());
      if (eventRef) {
        this.plugin.registerEvent(eventRef);
      }
    } catch (error) {
      console.debug(getLogTag(this.plugin), "Vault config-change event is unavailable; locale will refresh on reload.", error);
    }
  }

  registerAll() {
    this.registerConfigChange();
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("file-menu", (menu, file) => this.plugin.handleFileMenu(menu, file))
    );
    this.plugin.registerEvent(
      this.plugin.app.vault.on("create", (file) => this.plugin.handleVaultCreate(file))
    );
    this.plugin.registerEvent(
      this.plugin.app.vault.on("delete", (file) => this.plugin.handleVaultDelete(file))
    );
    this.plugin.registerEvent(
      this.plugin.app.vault.on("rename", (file, oldPath) => this.plugin.handleVaultRename(file, oldPath))
    );
    this.plugin.registerEvent(
      this.plugin.app.vault.on("modify", (file) => this.plugin.handleVaultModify(file))
    );
    this.plugin.backgroundCompressionService.setupUserActivityTracking();
    this.plugin.backgroundCompressionService.startInactivityCheck();
  }
}
