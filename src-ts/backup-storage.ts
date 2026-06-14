import * as path from "path";
import type * as obsidian from "obsidian";
import { getVaultBasePath } from "./utils";

export const BACKUP_STORAGE_FOLDER = ".local-image-compress";

export interface BackupStoragePaths {
  root: string;
  backupsRoot: string;
  cacheBackups: string;
  originalFilesBackups: string;
}

export function getBackupStoragePaths(app: obsidian.App): BackupStoragePaths {
  const root = path.resolve(getVaultBasePath(app), BACKUP_STORAGE_FOLDER);
  const backupsRoot = path.join(root, "backups");
  return {
    root,
    backupsRoot,
    cacheBackups: path.join(backupsRoot, "cache"),
    originalFilesBackups: path.join(backupsRoot, "originals")
  };
}
