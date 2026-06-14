import * as fs from "fs";
import * as path from "path";
import * as obsidian from "obsidian";
import type { default as LocalImageCompressPlugin } from "../plugin";
import { getVaultBasePath, getLogTag, getPluginName } from "../utils";
import { t } from "../i18n";

export class MigrationRunner {
  constructor(private readonly plugin: LocalImageCompressPlugin) {}

  async filesystemPathExists(filePath: string) {
    return await fs.promises.access(filePath).then(() => true, () => false);
  }

  async copyMigrationItem(src: string, dest: string): Promise<void> {
    const stat = await fs.promises.lstat(src);
    if (stat.isSymbolicLink()) {
      throw new Error(`Migration source must not be a symbolic link: ${src}`);
    }
    if (!stat.isDirectory()) {
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
      return;
    }
    await fs.promises.mkdir(dest, { recursive: true });
    for (const entry of await fs.promises.readdir(src, { withFileTypes: true })) {
      await this.copyMigrationItem(path.join(src, entry.name), path.join(dest, entry.name));
    }
  }

  async verifyMigrationItem(src: string, dest: string): Promise<void> {
    const [sourceStat, destinationStat] = await Promise.all([
      fs.promises.lstat(src),
      fs.promises.lstat(dest)
    ]);
    if (sourceStat.isSymbolicLink() || destinationStat.isSymbolicLink()) {
      throw new Error(`Migration verification rejected a symbolic link: ${src}`);
    }
    if (sourceStat.isDirectory() !== destinationStat.isDirectory()) {
      throw new Error(`Migration source and destination types differ: ${src}`);
    }
    if (!sourceStat.isDirectory()) {
      if (sourceStat.size !== destinationStat.size || !await this.plugin.moveService.filesHaveSameContent(src, dest)) {
        throw new Error(`Migration copy verification failed: ${src}`);
      }
      return;
    }
    for (const entry of await fs.promises.readdir(src, { withFileTypes: true })) {
      await this.verifyMigrationItem(path.join(src, entry.name), path.join(dest, entry.name));
    }
  }

  async moveOrCopyMigrationItem(src: string, dest: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    const sourceStat = await fs.promises.lstat(src);
    if (sourceStat.isSymbolicLink()) {
      throw new Error(`Migration source must not be a symbolic link: ${src}`);
    }
    try {
      await fs.promises.rename(src, dest);
      return;
    } catch (renameError) {
      console.debug(getLogTag(this.plugin), "Migration rename failed; falling back to copy", renameError);
    }
    await this.copyMigrationItem(src, dest);
    await this.verifyMigrationItem(src, dest);
    await fs.promises.rm(src, { recursive: true, force: true });
  }

  async mergeMigrationItem(src: string, dest: string): Promise<void> {
    if (!await this.filesystemPathExists(src)) {
      return;
    }
    if (!await this.filesystemPathExists(dest)) {
      await this.moveOrCopyMigrationItem(src, dest);
      return;
    }
    const [sourceStat, destinationStat] = await Promise.all([
      fs.promises.lstat(src),
      fs.promises.lstat(dest)
    ]);
    if (sourceStat.isSymbolicLink() || destinationStat.isSymbolicLink()) {
      throw new Error(`Migration merge rejected a symbolic link: ${src}`);
    }
    if (sourceStat.isDirectory() && destinationStat.isDirectory()) {
      for (const entry of await fs.promises.readdir(src, { withFileTypes: true })) {
        await this.mergeMigrationItem(path.join(src, entry.name), path.join(dest, entry.name));
      }
      await fs.promises.rmdir(src);
      return;
    }
    if (!sourceStat.isDirectory() && !destinationStat.isDirectory()) {
      const sameContent = sourceStat.size === destinationStat.size
        && await this.plugin.moveService.filesHaveSameContent(src, dest);
      if (!sameContent) {
        throw new Error(`Migration destination already contains a different file: ${dest}`);
      }
      await fs.promises.unlink(src);
      return;
    }
    throw new Error(`Migration source and destination types differ: ${src}`);
  }

  async migrateLegacyPluginData() {
    try {
      const configDir = this.plugin.app.vault.configDir;
      const basePath = getVaultBasePath(this.plugin.app);
      const oldDir = path.join(basePath, configDir, "plugins", "tiny-local");
      const newDir = path.join(basePath, configDir, "plugins", "local-image-compress");
      const backupPaths = this.plugin.getBackupStoragePaths();
      const migrationItems = [
        {
          item: "legacy cache file",
          src: path.join(oldDir, "tinyLocal-cache.json"),
          dest: path.join(newDir, "tinyLocal-cache.json")
        },
        {
          item: "legacy cache backups",
          src: path.join(oldDir, "cache-backups"),
          dest: backupPaths.cacheBackups
        },
        {
          item: "legacy original-file backups",
          src: path.join(oldDir, "original-files-backups"),
          dest: backupPaths.originalFilesBackups
        },
        {
          item: "cache backups",
          src: path.join(newDir, "cache-backups"),
          dest: backupPaths.cacheBackups
        },
        {
          item: "original-file backups",
          src: path.join(newDir, "original-files-backups"),
          dest: backupPaths.originalFilesBackups
        }
      ];
      const migrationErrors: Array<{ item: string; error: unknown }> = [];
      for (const { item, src, dest } of migrationItems) {
        try {
          await this.mergeMigrationItem(src, dest);
        } catch (e) {
          migrationErrors.push({ item, error: e });
        }
      }
      if (migrationErrors.length > 0) {
        new obsidian.Notice(`${getPluginName(this.plugin)}: ${t(this.plugin.app, "migration.partialFailure")} (${migrationErrors.length})`, 10000);
        for (const { item, error } of migrationErrors) {
          console.error(getLogTag(this.plugin), "Migration item error", item, error);
        }
      }
      if (await this.filesystemPathExists(oldDir)) {
        await fs.promises.rmdir(oldDir).catch(() => undefined);
      }
    } catch (e) {
      console.error(getLogTag(this.plugin), 'Startup migration error:', e);
    }
  }
}
