import * as path from "path";

// Persisted cache artifacts keep the historical TinyLocal filenames for backward
// compatibility with existing vaults and backup/restore flows.
export const LEGACY_CACHE_FILE_NAME = "tinyLocal-cache.json";
export const LEGACY_CACHE_TEMP_PREFIX = ".tinyLocal-cache-";
export const LEGACY_CACHE_BACKUP_PREFIX = "tinyLocal-cache-backup-";
export const LEGACY_BROKEN_CACHE_PREFIX = "tinyLocal-cache.broken-";

export function getCacheBackupTimestamp(now = new Date()) {
  return now.toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
}

export function getBrokenCacheFilePath(cacheBackupsDir: string, timestamp: string, randomSuffix: string) {
  return path.join(cacheBackupsDir, "broken", `${LEGACY_BROKEN_CACHE_PREFIX}${timestamp}-${randomSuffix}.json`);
}

export function getCacheTempFilePath(cacheFile: string, processId: number, timestamp: number, randomSuffix: string) {
  return path.join(path.dirname(cacheFile), `${LEGACY_CACHE_TEMP_PREFIX}${processId}-${timestamp}-${randomSuffix}.tmp`);
}

export function getCacheBackupPath(cacheBackupsDir: string, randomSuffix: string, now = new Date()) {
  const backupDir = cacheBackupsDir;
  const timestamp = getCacheBackupTimestamp(now);
  const backupFile = path.join(backupDir, `${LEGACY_CACHE_BACKUP_PREFIX}${timestamp}-${randomSuffix}.json`);
  return { backupDir, backupFile };
}

export function isCacheTempFileName(fileName: string) {
  return fileName.startsWith(LEGACY_CACHE_TEMP_PREFIX) && fileName.endsWith(".tmp");
}

export function isCacheBackupFileName(fileName: string) {
  return fileName.startsWith(LEGACY_CACHE_BACKUP_PREFIX) && fileName.endsWith(".json");
}

export function isBrokenCacheFileName(fileName: string) {
  return fileName.startsWith(LEGACY_BROKEN_CACHE_PREFIX) && fileName.endsWith(".json");
}

export function isValidCacheBackupFileName(fileName: string) {
  const safePattern = /^tinyLocal-cache-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(?:\d{3}(?:-[0-9a-f]{8,32})?|[0-9a-f]{8,32})\.json$/i;
  return safePattern.test(fileName) && !fileName.includes("/") && !fileName.includes("\\") && !fileName.includes("..");
}
