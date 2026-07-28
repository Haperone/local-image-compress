import type { FsPort } from "./platform/ports";

export const BACKUP_STORAGE_FOLDER = ".local-image-compress";

export interface BackupStoragePaths {
  root: string;
  backupsRoot: string;
  cacheBackups: string;
  originalFilesBackups: string;
}

export function getBackupStoragePaths(fsPort: FsPort): BackupStoragePaths {
  const root = BACKUP_STORAGE_FOLDER;
  const backupsRoot = fsPort.joinPath(root, "backups");
  return {
    root,
    backupsRoot,
    cacheBackups: fsPort.joinPath(backupsRoot, "cache"),
    originalFilesBackups: fsPort.joinPath(backupsRoot, "originals")
  };
}
