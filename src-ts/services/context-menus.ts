import * as obsidian from "obsidian";
import { t } from "../i18n";
import { isInsideOutputFolder } from "../utils";
import type { default as LocalImageCompressPlugin } from "../plugin";

// Owns the file/folder context-menu items. The plugin routes handleFileMenu here and
// keeps thin delegators so runtime QA can invoke the menu builders directly.
export class ContextMenus {
  constructor(private readonly plugin: LocalImageCompressPlugin) {}

  addContextMenu(menu: obsidian.Menu, file: obsidian.TFile) {
    if (!this.plugin.isImageFile(file))
      return;
    if (this.plugin.isOutputFolderPath(file.path))
      return;
    menu.addItem((item) => {
      item.setTitle(t(this.plugin.app, "context.compressImage")).setIcon("compress").onClick(() => this.plugin.compressFile(file));
    });
  }
  addFolderContextMenu(menu: obsidian.Menu, folder: obsidian.TFolder) {
    if (isInsideOutputFolder(folder.path, this.plugin.getOutputFolder()))
      return;
    menu.addItem((item) => {
      item.setTitle(t(this.plugin.app, "context.compressImagesInFolder")).setIcon("images").onClick(() => this.plugin.compressImagesInFolderPath(folder.path));
    });
  }
}
