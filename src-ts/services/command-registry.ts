import type LocalImageCompressPlugin from "../plugin";
import { t } from "../i18n";

export class CommandRegistry {
  constructor(private readonly plugin: LocalImageCompressPlugin) {}

  registerAll() {
    const commands = [
      {
        id: "compress-images-in-note",
        name: t(this.plugin.app, "command.compressInNote"),
        callback: () => this.plugin.compressImagesInNote()
      },
      {
        id: "compress-images-in-folder",
        name: t(this.plugin.app, "command.compressInFolder"),
        callback: () => this.plugin.compressImagesInFolder()
      },
      {
        id: "compress-all-images",
        name: t(this.plugin.app, "command.compressAll"),
        callback: () => this.plugin.compressAllImages()
      },
      {
        id: "move-compressed-to-files",
        name: t(this.plugin.app, "command.moveCompressed"),
        callback: () => this.plugin.moveService.moveCompressedToFiles()
      }
    ];
    commands.forEach((cmd) => this.plugin.addCommand(cmd));
  }
}
