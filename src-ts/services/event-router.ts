import type * as obsidian from "obsidian";
import { getLogTag } from "../utils";
import type LocalImageCompressPlugin from "../plugin";

type VaultWithOptionalConfigChange = obsidian.Vault & {
  on(name: "config-changed", callback: () => void | Promise<void>): obsidian.EventRef;
};

export class EventRouter {
  constructor(private readonly plugin: LocalImageCompressPlugin) {}

  private runGuardedEvent(label: string, operation: () => Promise<void>) {
    if (this.plugin.isUnloading) {
      return Promise.resolve();
    }
    return operation().catch((error) => {
      if (!this.plugin.isUnloading) {
        console.error(getLogTag(this.plugin), `${label} event failed:`, error);
      }
    });
  }

  private registerConfigChange() {
    try {
      const vault = this.plugin.app.vault as VaultWithOptionalConfigChange;
      const eventRef = vault.on("config-changed", () => this.runGuardedEvent("config-changed", () => this.plugin.handleLocaleConfigChanged()));
      if (eventRef) {
        this.plugin.registerEvent(eventRef);
      }
    } catch (error) {
      console.debug(getLogTag(this.plugin), "Vault config-change event is unavailable; locale will refresh on reload.", error);
    }
  }

  private registerUserActivityTracking() {
    const documents = new Set<Document>([this.plugin.getActiveDocument()]);
    const statusDocument = this.plugin.statusBarItem?.ownerDocument;
    if (statusDocument) {
      documents.add(statusDocument);
    }
    this.plugin.app.workspace.iterateAllLeaves((leaf) => {
      const document = leaf.view.containerEl?.ownerDocument;
      if (document) {
        documents.add(document);
      }
    });
    this.plugin.backgroundCompressionService.setupUserActivityTracking(documents);
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("window-open", (_workspaceWindow, ownerWindow) => {
        if (!this.plugin.isUnloading) {
          this.plugin.backgroundCompressionService.registerUserActivityDocument(ownerWindow.document);
        }
      })
    );
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("window-close", (_workspaceWindow, ownerWindow) => {
        this.plugin.backgroundCompressionService.unregisterUserActivityDocument(ownerWindow.document);
      })
    );
  }

  registerAll() {
    this.registerConfigChange();
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("file-menu", (menu, file) => this.plugin.handleFileMenu(menu, file))
    );
    this.plugin.registerEvent(
      this.plugin.app.vault.on("create", (file) => this.runGuardedEvent("create", () => this.plugin.handleVaultCreate(file)))
    );
    this.plugin.registerEvent(
      this.plugin.app.vault.on("delete", (file) => this.runGuardedEvent("delete", () => this.plugin.handleVaultDelete(file)))
    );
    this.plugin.registerEvent(
      this.plugin.app.vault.on("rename", (file, oldPath) => this.runGuardedEvent("rename", () => this.plugin.handleVaultRename(file, oldPath)))
    );
    this.plugin.registerEvent(
      this.plugin.app.vault.on("modify", (file) => this.runGuardedEvent("modify", () => this.plugin.handleVaultModify(file)))
    );
    this.registerUserActivityTracking();
    this.plugin.backgroundCompressionService.startInactivityCheck();
  }
}
