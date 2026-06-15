import * as fs2 from "fs";
import * as path2 from "path";
import * as crypto from "crypto";
import * as obsidian from "obsidian";
import { pipeline } from "stream/promises";
import { getBackupStoragePaths } from "./backup-storage";
import { getBrokenCacheFilePath, getCacheBackupPath as buildCacheBackupPath, getCacheBackupTimestamp as buildCacheBackupTimestamp, getCacheTempFilePath, isBrokenCacheFileName, isCacheBackupFileName, isCacheTempFileName as isLegacyCacheTempFileName, isValidCacheBackupFileName, LEGACY_CACHE_FILE_NAME } from "./cache-file-names";
import { ConcurrencyLimiter } from "./concurrency-limiter";
import type { CacheData, CacheEntry, CacheEntryState, CachePathEntries, FileStatsLike, FreshCacheEntry, ImageFileLike, TimerHandle } from "./types";
import { getErrorCode, getLogTag, getVaultBasePath, getVaultFileByPath, isAbsoluteFilesystemPath, isSafeVaultRelativePath, normalizeVaultPathForComparison, randomHexSuffix, randomHexSuffixSync, toVaultRelativePath, vaultPathsEqual } from "./utils";

type CacheWriteOptions = {
  mergeDiskEntries?: boolean;
  // Authoritative writes (e.g. clearCache) must NOT merge disk entries even when coalesced with a
  // concurrent additive save — they intentionally overwrite the whole cache.
  authoritative?: boolean;
};

type CacheApp = obsidian.App & {
  manifest?: {
    dir?: string;
  };
};

type CacheWriteLock = {
  lockFile: string;
  ownerId: string;
};

const CACHE_WRITE_LOCK_STALE_MS = 30_000;
const CACHE_WRITE_LOCK_TIMEOUT_MS = 5_000;
const CACHE_WRITE_LOCK_SYNC_TIMEOUT_MS = 500;
const CACHE_WRITE_LOCK_RETRY_MS = 50;
const CACHE_BACKUP_MAX_COUNT = 50;

export class Cache {
  CACHE_VERSION: string;
  app: CacheApp;
  cacheFile: string;
  cacheBackupsDir: string;
  cacheData: CacheData;
  lastLoadError: unknown;
  brokenCacheBackupPath: string | null;
  compressionSettingsProvider: ((file: ImageFileLike, skipReason?: string) => string | null) | null;
  isUnloadingProvider: (() => boolean) | null;
  saveCacheDelayMs: number;
  saveCacheTimer: TimerHandle | null;
  saveCachePromise: Promise<void> | null;
  saveCacheResolve: (() => void) | null;
  activeWritePromise: Promise<void> | null;
  cacheWriteToken: number;
  syncFlushToken: number;
  syncFlushReplayToken: number;
  acceptingWrites: boolean;
  syncFlushReplayPromise: Promise<void> | null;
  retainedFilesStatBatchSize: number;
  staleEntryPruneBatchSize: number;
  lastInvalidMtimeFallback: number;
  cacheLockOwnerId: string;
  pendingSaveMergeDiskEntries: boolean;
  pendingSaveAuthoritative: boolean;
  lastAccessSaveIntervalMs: number;
  lastAccessSaveAt: number;
  lastAccessSavePromise: Promise<void> | null;

  constructor(app: CacheApp, cacheBackupsDir = getBackupStoragePaths(app).cacheBackups) {
    this.CACHE_VERSION = "2.0.0";
    this.app = app;
    const manifestDir = app.manifest?.dir;
    const configDir = app.vault.configDir;
    const basePath = getVaultBasePath(app);
    let cacheDir;
    if (manifestDir) {
      cacheDir = this.isAbsolutePath(manifestDir) ? manifestDir : path2.join(basePath, manifestDir);
    } else {
      cacheDir = path2.join(basePath, configDir, "plugins", "local-image-compress");
    }
    this.cacheFile = path2.join(cacheDir, LEGACY_CACHE_FILE_NAME);
    this.cacheBackupsDir = path2.resolve(cacheBackupsDir);
    this.cacheData = {
      entries: {},
      version: this.CACHE_VERSION
    };
    this.lastLoadError = null;
    this.brokenCacheBackupPath = null;
    this.compressionSettingsProvider = null;
    this.isUnloadingProvider = null;
    this.saveCacheDelayMs = 50;
    this.saveCacheTimer = null;
    this.saveCachePromise = null;
    this.saveCacheResolve = null;
    this.activeWritePromise = null;
    this.cacheWriteToken = 0;
    this.syncFlushToken = 0;
    this.syncFlushReplayToken = 0;
    this.acceptingWrites = true;
    this.syncFlushReplayPromise = null;
    this.retainedFilesStatBatchSize = 1000;
    this.staleEntryPruneBatchSize = 1000;
    this.lastInvalidMtimeFallback = 0;
    this.cacheLockOwnerId = `${process.pid}-${Date.now()}-${randomHexSuffixSync()}`;
    this.pendingSaveMergeDiskEntries = true;
    this.pendingSaveAuthoritative = false;
    this.lastAccessSaveIntervalMs = 60_000;
    this.lastAccessSaveAt = 0;
    this.lastAccessSavePromise = null;
  }
  isAcceptingWrites() {
    return this.acceptingWrites && !this.isUnloadingProvider?.();
  }
  lockWritesForUnload() {
    this.acceptingWrites = false;
  }
  getEmptyCacheData() {
    return {
      entries: {},
      version: this.CACHE_VERSION
    };
  }
  serializeForDisk(data: unknown = this.cacheData) {
    return JSON.stringify(data);
  }
  getCacheLockFile() {
    return `${this.cacheFile}.lock`;
  }
  getCacheLockPayload(ownerId = this.cacheLockOwnerId) {
    return JSON.stringify({
      ownerId,
      pid: process.pid,
      timestamp: Date.now()
    });
  }
  isStaleCacheLock(rawLockData: string, now = Date.now()) {
    try {
      const parsed: unknown = JSON.parse(rawLockData);
      const timestamp = Number(this.isPlainRecord(parsed) ? parsed["timestamp"] : undefined);
      return !Number.isFinite(timestamp) || now - timestamp > CACHE_WRITE_LOCK_STALE_MS;
    } catch {
      return true;
    }
  }
  async sleepForCacheLock(delayMs: number) {
    await new Promise((resolve) => window.setTimeout(resolve, delayMs));
  }
  sleepForCacheLockSync(delayMs: number) {
    if (typeof SharedArrayBuffer !== "function" || typeof Atomics?.wait !== "function") {
      const end = Date.now() + delayMs;
      while (Date.now() < end) {
        // Blocking fallback only runs during rare sync-unload cache lock contention.
      }
      return;
    }
    const sharedBuffer = new SharedArrayBuffer(4);
    const state = new Int32Array(sharedBuffer);
    Atomics.wait(state, 0, 0, delayMs);
  }
  async removeStaleCacheLock(lockFile: string) {
    try {
      const rawLockData = await fs2.promises.readFile(lockFile, "utf8");
      if (!this.isStaleCacheLock(rawLockData)) {
        return false;
      }
      await fs2.promises.unlink(lockFile);
      return true;
    } catch (error) {
      return getErrorCode(error) === "ENOENT";
    }
  }
  removeStaleCacheLockSync(lockFile: string) {
    try {
      const rawLockData = fs2.readFileSync(lockFile, "utf8");
      if (!this.isStaleCacheLock(rawLockData)) {
        return false;
      }
      fs2.unlinkSync(lockFile);
      return true;
    } catch (error) {
      return getErrorCode(error) === "ENOENT";
    }
  }
  async acquireCacheWriteLock(timeoutMs = CACHE_WRITE_LOCK_TIMEOUT_MS): Promise<CacheWriteLock | null> {
    const lockFile = this.getCacheLockFile();
    const ownerId = this.cacheLockOwnerId;
    const start = Date.now();
    await fs2.promises.mkdir(path2.dirname(lockFile), { recursive: true });
    while (Date.now() - start <= timeoutMs) {
      let handle: fs2.promises.FileHandle | null = null;
      try {
        handle = await fs2.promises.open(lockFile, "wx");
        await handle.writeFile(this.getCacheLockPayload(ownerId));
        await handle.close();
        return { lockFile, ownerId };
      } catch (error) {
        try {
          await handle?.close();
        } catch (closeError) {
          void closeError;
        }
        if (getErrorCode(error) !== "EEXIST") {
          throw error;
        }
        await this.removeStaleCacheLock(lockFile);
        if (Date.now() - start > timeoutMs) {
          break;
        }
        await this.sleepForCacheLock(CACHE_WRITE_LOCK_RETRY_MS);
      }
    }
    console.warn(getLogTag(this), "Could not acquire cache write lock; skipping cache write to avoid multi-instance corruption");
    return null;
  }
  acquireCacheWriteLockSync(timeoutMs = CACHE_WRITE_LOCK_SYNC_TIMEOUT_MS): CacheWriteLock | null {
    const lockFile = this.getCacheLockFile();
    const ownerId = this.cacheLockOwnerId;
    const start = Date.now();
    const lockDir = path2.dirname(lockFile);
    if (!fs2.existsSync(lockDir)) {
      fs2.mkdirSync(lockDir, { recursive: true });
    }
    while (Date.now() - start <= timeoutMs) {
      let fd: number | null = null;
      try {
        fd = fs2.openSync(lockFile, "wx");
        fs2.writeFileSync(fd, this.getCacheLockPayload(ownerId));
        fs2.closeSync(fd);
        return { lockFile, ownerId };
      } catch (error) {
        if (fd !== null) {
          try {
            fs2.closeSync(fd);
          } catch (closeError) {
            void closeError;
          }
        }
        if (getErrorCode(error) !== "EEXIST") {
          throw error;
        }
        this.removeStaleCacheLockSync(lockFile);
        if (Date.now() - start > timeoutMs) {
          break;
        }
        this.sleepForCacheLockSync(CACHE_WRITE_LOCK_RETRY_MS);
      }
    }
    console.warn(getLogTag(this), "Could not acquire cache write lock; skipping sync cache write to avoid multi-instance corruption");
    return null;
  }
  async releaseCacheWriteLock(lock: CacheWriteLock | null) {
    if (!lock) {
      return;
    }
    try {
      const rawLockData = await fs2.promises.readFile(lock.lockFile, "utf8");
      const parsed: unknown = JSON.parse(rawLockData);
      if (this.getRecordString(parsed, "ownerId") === lock.ownerId) {
        await fs2.promises.unlink(lock.lockFile);
      }
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") {
        console.warn(getLogTag(this), "Cache write lock release failed:", error);
      }
    }
  }
  releaseCacheWriteLockSync(lock: CacheWriteLock | null) {
    if (!lock) {
      return;
    }
    try {
      const rawLockData = fs2.readFileSync(lock.lockFile, "utf8");
      const parsed: unknown = JSON.parse(rawLockData);
      if (this.getRecordString(parsed, "ownerId") === lock.ownerId) {
        fs2.unlinkSync(lock.lockFile);
      }
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") {
        console.warn(getLogTag(this), "Cache write lock release failed:", error);
      }
    }
  }
  mergeCacheEntries(diskEntries: Record<string, CacheEntry>, nextEntries: Record<string, CacheEntry>) {
    const merged: Record<string, CacheEntry> = { ...diskEntries };
    for (const [cacheKey, nextEntry] of Object.entries(nextEntries)) {
      const diskEntry = merged[cacheKey];
      if (diskEntry && this.getEntryRetentionTime(diskEntry) > this.getEntryRetentionTime(nextEntry)) {
        continue;
      }
      merged[cacheKey] = nextEntry;
    }
    return merged;
  }
  buildMergedCachePayload(nextRawData: string, diskRawData: string) {
    const nextData = this.normalizeCacheData(JSON.parse(nextRawData)).data;
    const diskData = this.normalizeCacheData(JSON.parse(diskRawData)).data;
    const entries = this.mergeCacheEntries(diskData.entries, nextData.entries);
    return this.serializeForDisk({
      ...diskData,
      ...nextData,
      entries,
      version: this.CACHE_VERSION
    });
  }
  async mergeDiskCacheEntries(nextRawData: string) {
    try {
      const diskRawData = await fs2.promises.readFile(this.cacheFile, "utf8");
      return this.buildMergedCachePayload(nextRawData, diskRawData);
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") {
        console.warn(getLogTag(this), "Cache merge skipped after disk read failed:", error);
      }
      return nextRawData;
    }
  }
  mergeDiskCacheEntriesSync(nextRawData: string) {
    try {
      const diskRawData = fs2.readFileSync(this.cacheFile, "utf8");
      return this.buildMergedCachePayload(nextRawData, diskRawData);
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") {
        console.warn(getLogTag(this), "Cache merge skipped after disk read failed:", error);
      }
      return nextRawData;
    }
  }
  isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }
  getRecordString(value: unknown, key: string): string | undefined {
    if (!this.isPlainRecord(value)) {
      return undefined;
    }
    const field = value[key];
    return typeof field === "string" ? field : undefined;
  }
  cloneCacheValue(value: unknown): unknown {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      return value;
    }
    if (Array.isArray(value)) {
      return value.map((entry) => this.cloneCacheValue(entry));
    }
    if (this.isPlainRecord(value)) {
      return this.clonePlainRecord(value);
    }
    return undefined;
  }
  clonePlainRecord(value: Record<string, unknown>) {
    const clone: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        continue;
      }
      const clonedValue = this.cloneCacheValue(nestedValue);
      if (clonedValue !== undefined) {
        clone[key] = clonedValue;
      }
    }
    return clone;
  }
  isCacheEntryState(value: unknown): value is CacheEntryState {
    return value === "processed" || value === "pending_move" || value === "moved" || value === "skipped" || value === "skipped_identical";
  }
  getLegacyCacheFlag(entry: CacheEntry, key: "moved" | "skipped") {
    return (entry as Record<string, unknown>)[key] === true;
  }
  getLegacyCacheNumber(entry: CacheEntry, key: "movedAt") {
    const numeric = Number((entry as Record<string, unknown>)[key]);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  inferCacheEntryState(entry: CacheEntry): CacheEntryState {
    if (this.isCacheEntryState(entry.state)) {
      return entry.state;
    }
    if (this.getLegacyCacheFlag(entry, "moved")) {
      return "moved";
    }
    if (this.getLegacyCacheFlag(entry, "skipped")) {
      return "skipped";
    }
    if (entry.pendingSince !== undefined || entry.outputPath || entry.outputMtime !== undefined || entry.outputSize !== undefined) {
      return "pending_move";
    }
    return "processed";
  }
  getCacheEntryState(entry: CacheEntry): CacheEntryState {
    return this.inferCacheEntryState(entry);
  }
  stripLegacyCacheStateFields(entry: CacheEntry) {
    const sanitized = { ...entry } as CacheEntry & Record<string, unknown>;
    if (sanitized.skipReason === undefined && typeof sanitized["reason"] === "string" && sanitized["reason"]) {
      sanitized.skipReason = sanitized["reason"];
    }
    delete sanitized["reason"];
    delete sanitized["skipped"];
    delete sanitized["moved"];
    delete sanitized["movedAt"];
    return sanitized as CacheEntry;
  }
  normalizeCacheEntrySkipReason(entry: CacheEntry) {
    const legacyEntry = entry as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(legacyEntry, "reason")) {
      return false;
    }
    if (entry.skipReason === undefined && typeof legacyEntry["reason"] === "string" && legacyEntry["reason"]) {
      entry.skipReason = legacyEntry["reason"];
    }
    delete legacyEntry["reason"];
    return true;
  }
  normalizeCacheEntryState(entry: CacheEntry) {
    const legacyEntry = entry as Record<string, unknown>;
    let changed = false;
    const state = this.inferCacheEntryState(entry);
    if (entry.state !== state) {
      entry.state = state;
      changed = true;
    }
    const fallbackStateUpdatedAt = [
      this.getLegacyCacheNumber(entry, "movedAt"),
      Number(entry.pendingSince),
      Number(entry.timestamp)
    ].find((candidate): candidate is number => typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0);
    if (state !== "processed" && entry.stateUpdatedAt === undefined && fallbackStateUpdatedAt !== undefined) {
      entry.stateUpdatedAt = fallbackStateUpdatedAt;
      changed = true;
    }
    for (const legacyKey of ["skipped", "moved", "movedAt"]) {
      if (Object.prototype.hasOwnProperty.call(legacyEntry, legacyKey)) {
        delete legacyEntry[legacyKey];
        changed = true;
      }
    }
    return changed;
  }
  getBrokenCacheBackupPath() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const randomSuffix = randomHexSuffixSync();
    return getBrokenCacheFilePath(this.cacheBackupsDir, timestamp, randomSuffix);
  }
  createBrokenCacheCopySync(error: unknown) {
    this.lastLoadError = error;
    this.brokenCacheBackupPath = null;
    this.logCacheLoadFailure(error);
    try {
      if (!fs2.existsSync(this.cacheFile)) {
        return;
      }
      const backupPath = this.getBrokenCacheBackupPath();
      fs2.mkdirSync(path2.dirname(backupPath), { recursive: true });
      fs2.copyFileSync(this.cacheFile, backupPath);
      this.brokenCacheBackupPath = backupPath;
      this.cleanupOldBrokenCacheCopiesSync(path2.dirname(backupPath));
      this.cleanupOldBrokenCacheCopiesSync(path2.dirname(this.cacheFile));
      this.writeCacheFileSyncAtomic(this.serializeForDisk(this.getEmptyCacheData()), { mergeDiskEntries: false });
    } catch (copyError) {
      console.error(getLogTag(this), "Broken cache recovery failed:", copyError);
    }
  }
  async createBrokenCacheCopy(error: unknown) {
    this.lastLoadError = error;
    this.brokenCacheBackupPath = null;
    this.logCacheLoadFailure(error);
    try {
      await fs2.promises.access(this.cacheFile);
      const backupPath = this.getBrokenCacheBackupPath();
      await fs2.promises.mkdir(path2.dirname(backupPath), { recursive: true });
      await fs2.promises.copyFile(this.cacheFile, backupPath);
      this.brokenCacheBackupPath = backupPath;
      await this.cleanupOldBrokenCacheCopies(path2.dirname(backupPath));
      await this.cleanupOldBrokenCacheCopies(path2.dirname(this.cacheFile));
      await this.writeCacheFileAtomic(this.serializeForDisk(this.getEmptyCacheData()), () => true, { mergeDiskEntries: false });
    } catch (copyError) {
      console.error(getLogTag(this), "Broken cache recovery failed:", copyError);
    }
  }
  writeCacheFileSyncAtomic(data: string, options: CacheWriteOptions = {}) {
    const cacheDir = path2.dirname(this.cacheFile);
    if (!fs2.existsSync(cacheDir)) {
      fs2.mkdirSync(cacheDir, { recursive: true });
    }
    const lock = this.acquireCacheWriteLockSync();
    if (!lock) {
      return;
    }
    const randomSuffix = randomHexSuffixSync();
    const tempFile = getCacheTempFilePath(this.cacheFile, process.pid, Date.now(), randomSuffix);
    try {
      const finalData = options.mergeDiskEntries ? this.mergeDiskCacheEntriesSync(data) : data;
      fs2.writeFileSync(tempFile, finalData);
      // LLL2-A-6: durability flush before rename (unload path — durability matters most here).
      this.fsyncPathBestEffortSync(tempFile);
      this.renameCacheFileWithRetrySync(tempFile, this.cacheFile);
    } catch (error) {
      try {
        if (fs2.existsSync(tempFile)) {
          fs2.unlinkSync(tempFile);
        }
      } catch (cleanupError) {
        console.warn(getLogTag(this), "Temporary cache cleanup failed:", cleanupError);
      }
      throw error;
    } finally {
      this.releaseCacheWriteLockSync(lock);
    }
  }
  isCacheTempFileName(fileName: string) {
    return isLegacyCacheTempFileName(fileName);
  }
  cleanupOrphanedTempFilesSync() {
    const cacheDir = path2.dirname(this.cacheFile);
    try {
      if (!fs2.existsSync(cacheDir)) {
        return;
      }
      for (const fileName of fs2.readdirSync(cacheDir)) {
        if (!this.isCacheTempFileName(fileName)) {
          continue;
        }
        const tempPath = path2.join(cacheDir, fileName);
        try {
          fs2.unlinkSync(tempPath);
        } catch (error) {
          console.warn(getLogTag(this), "Orphan cache temp cleanup failed:", fileName, error);
        }
      }
    } catch (error) {
      console.warn(getLogTag(this), "Orphan cache temp scan failed:", error);
    }
  }
  async cleanupOrphanedTempFiles() {
    const cacheDir = path2.dirname(this.cacheFile);
    try {
      const entries = await fs2.promises.readdir(cacheDir).catch((error) => {
        if (getErrorCode(error) !== "ENOENT") {
          console.warn(getLogTag(this), "Orphan cache temp scan failed:", error);
        }
        return [];
      });
      const limiter = new ConcurrencyLimiter(4);
      await Promise.all(entries
        .filter((fileName) => this.isCacheTempFileName(fileName))
        .map((fileName) => limiter.run(async () => {
          try {
            await fs2.promises.unlink(path2.join(cacheDir, fileName));
          } catch (error) {
            console.warn(getLogTag(this), "Orphan cache temp cleanup failed:", fileName, error);
          }
        })));
    } catch (error) {
      console.warn(getLogTag(this), "Orphan cache temp cleanup failed:", error);
    }
  }
  async fsyncPathBestEffort(filePath: string) {
    let handle: fs2.promises.FileHandle | null = null;
    try {
      handle = await fs2.promises.open(filePath, "r+");
      await handle.sync();
    } catch (error) {
      // fsync is unsupported on some network/virtual filesystems; the atomic
      // rename still guarantees readers never observe a torn cache file.
      void error;
    } finally {
      try {
        await handle?.close();
      } catch (closeError) {
        void closeError;
      }
    }
  }
  fsyncPathBestEffortSync(filePath: string) {
    let fd: number | null = null;
    try {
      fd = fs2.openSync(filePath, "r+");
      fs2.fsyncSync(fd);
    } catch (error) {
      void error;
    } finally {
      if (fd !== null) {
        try {
          fs2.closeSync(fd);
        } catch (closeError) {
          void closeError;
        }
      }
    }
  }
  async unlinkTempFileWithRetry(tempFile: string, context: string) {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await fs2.promises.unlink(tempFile);
        return true;
      } catch (error) {
        if (getErrorCode(error) === "ENOENT") {
          return true;
        }
        lastError = error;
        await this.sleepForCacheLock(25 * (attempt + 1));
      }
    }
    console.warn(getLogTag(this), `Temporary cache cleanup failed after ${context}:`, lastError);
    return false;
  }
  isRetriableCacheRenameError(error: unknown) {
    const code = getErrorCode(error);
    return code === "EPERM" || code === "EACCES" || code === "EBUSY";
  }
  async renameCacheFileWithRetry(tempFile: string, targetFile: string) {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await fs2.promises.rename(tempFile, targetFile);
        return;
      } catch (error) {
        if (!this.isRetriableCacheRenameError(error)) {
          throw error;
        }
        lastError = error;
        await this.sleepForCacheLock(25 * (attempt + 1));
      }
    }
    throw lastError;
  }
  renameCacheFileWithRetrySync(tempFile: string, targetFile: string) {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        fs2.renameSync(tempFile, targetFile);
        return;
      } catch (error) {
        if (!this.isRetriableCacheRenameError(error)) {
          throw error;
        }
        lastError = error;
        this.sleepForCacheLockSync(25 * (attempt + 1));
      }
    }
    throw lastError;
  }
  async writeCacheFileAtomic(data: string, shouldCommit: () => boolean = () => true, options: CacheWriteOptions = {}) {
    const cacheDir = path2.dirname(this.cacheFile);
    await fs2.promises.mkdir(cacheDir, { recursive: true });
    const lock = await this.acquireCacheWriteLock();
    if (!lock) {
      return;
    }
    const randomSuffix = await randomHexSuffix();
    const tempFile = getCacheTempFilePath(this.cacheFile, process.pid, Date.now(), randomSuffix);
    try {
      if (!shouldCommit()) {
        return;
      }
      const finalData = options.mergeDiskEntries ? await this.mergeDiskCacheEntries(data) : data;
      await fs2.promises.writeFile(tempFile, finalData);
      if (!shouldCommit()) {
        await this.unlinkTempFileWithRetry(tempFile, "cancelled commit");
        return;
      }
      // LLL2-A-6: flush temp contents to disk before the rename so a power loss
      // immediately after rename cannot surface a zero-length / torn cache file.
      await this.fsyncPathBestEffort(tempFile);
      await this.renameCacheFileWithRetry(tempFile, this.cacheFile);
    } catch (error) {
      await this.unlinkTempFileWithRetry(tempFile, "failed atomic write");
      throw error;
    } finally {
      await this.releaseCacheWriteLock(lock);
    }
  }
  loadCacheSync() {
    this.lastLoadError = null;
    this.brokenCacheBackupPath = null;
    try {
      const cacheDir = path2.dirname(this.cacheFile);
      if (!fs2.existsSync(cacheDir)) {
        fs2.mkdirSync(cacheDir, { recursive: true });
      }
      this.cleanupOrphanedTempFilesSync();
      if (!fs2.existsSync(this.cacheFile)) {
        const initialCache = this.getEmptyCacheData();
        this.writeCacheFileSyncAtomic(this.serializeForDisk(initialCache), { mergeDiskEntries: false });
      }
      if (fs2.existsSync(this.cacheFile)) {
        const data = fs2.readFileSync(this.cacheFile, "utf8");
        const parsed: unknown = JSON.parse(data);
        const migrated = this.normalizeCacheData(parsed);
        const version = this.isPlainRecord(parsed) ? parsed["version"] : undefined;
        const shouldPersistMigration = version !== this.CACHE_VERSION || migrated.changed;
        if (shouldPersistMigration) {
          this.createBackupSync();
        }
        this.cacheData = migrated.data;
        if (shouldPersistMigration) {
          this.writeCacheFileSyncAtomic(this.serializeForDisk(), { mergeDiskEntries: false });
        }
      }
    } catch (error) {
      this.createBrokenCacheCopySync(error);
      this.cacheData = this.getEmptyCacheData();
    }
  }
  async loadCache() {
    this.lastLoadError = null;
    this.brokenCacheBackupPath = null;
    try {
      const cacheDir = path2.dirname(this.cacheFile);
      await fs2.promises.mkdir(cacheDir, { recursive: true });
      await this.cleanupOrphanedTempFiles();
      const exists = await fs2.promises.access(this.cacheFile).then(() => true).catch(() => false);
      if (!exists) {
        const initialCache = this.getEmptyCacheData();
        await this.writeCacheFileAtomic(this.serializeForDisk(initialCache), () => true, { mergeDiskEntries: false });
      }
      const data = await fs2.promises.readFile(this.cacheFile, "utf8");
      const parsed: unknown = JSON.parse(data);
      const migrated = this.normalizeCacheData(parsed);
      const version = this.isPlainRecord(parsed) ? parsed["version"] : undefined;
      const shouldPersistMigration = version !== this.CACHE_VERSION || migrated.changed;
      if (shouldPersistMigration) {
        await this.createBackup();
      }
      this.cacheData = migrated.data;
      if (shouldPersistMigration) {
        await this.writeCacheFileAtomic(this.serializeForDisk(), () => true, { mergeDiskEntries: false });
      }
    } catch (error) {
      await this.createBrokenCacheCopy(error);
      this.cacheData = this.getEmptyCacheData();
    }
  }
  setSaveCacheTimeout(callback: () => void, delay: number) {
    return window.setTimeout(callback, delay);
  }
  clearSaveCacheTimeout(timer: TimerHandle | null | undefined) {
    if (timer === null || timer === undefined) {
      return;
    }
    window.clearTimeout(timer as number);
  }
  async saveCache(options: CacheWriteOptions = {}) {
    if (!this.isAcceptingWrites()) {
      return;
    }
    const mergeDiskEntries = options.mergeDiskEntries !== false;
    const authoritative = options.authoritative === true;
    if (!this.saveCachePromise) {
      this.saveCachePromise = new Promise((resolve) => {
        this.saveCacheResolve = () => resolve();
      });
      this.pendingSaveMergeDiskEntries = mergeDiskEntries;
      this.pendingSaveAuthoritative = authoritative;
    } else {
      // BR-H2: OR the merge intents so a coalesced ADDITIVE write (addToCache, merge:true) is never
      // downgraded to a disk-clobbering merge:false by a concurrent deletion that lands in the same
      // debounce window. Without this, a synced second instance's freshly-written entries are lost.
      // Deletions that get merged back instead resurrect harmlessly and self-heal on the next prune.
      // Authoritative writes (clearCache) still force no-merge below via pendingSaveAuthoritative.
      this.pendingSaveMergeDiskEntries = this.pendingSaveMergeDiskEntries || mergeDiskEntries;
      this.pendingSaveAuthoritative = this.pendingSaveAuthoritative || authoritative;
    }
    if (this.saveCacheTimer) {
      this.clearSaveCacheTimeout(this.saveCacheTimer);
    }
    this.saveCacheTimer = this.setSaveCacheTimeout(() => {
      this.saveCacheTimer = null;
      this.flushPendingCacheSave().catch((error) => {
        console.error(getLogTag(this), "Cache save failed:", error);
      });
    }, this.saveCacheDelayMs);
    return this.saveCachePromise;
  }
  cancelPendingSave() {
    if (this.saveCacheTimer) {
      this.clearSaveCacheTimeout(this.saveCacheTimer);
      this.saveCacheTimer = null;
    }
    const resolve = this.saveCacheResolve;
    this.saveCachePromise = null;
    this.saveCacheResolve = null;
    this.pendingSaveMergeDiskEntries = true;
    this.pendingSaveAuthoritative = false;
    resolve?.();
  }
  queueCacheWrite(data: string, options: CacheWriteOptions = {}) {
    const previousWrite = this.activeWritePromise;
    const writeToken = ++this.cacheWriteToken;
    let nextWrite: Promise<void>;
    nextWrite = (async () => {
      if (previousWrite) {
        await previousWrite;
      }
      try {
        await this.writeCacheFileAtomic(data, () => writeToken > this.syncFlushToken, options);
      } catch (error) {
        console.error(getLogTag(this), "Cache save failed:", error);
      }
    })().finally(() => {
      if (this.activeWritePromise === nextWrite) {
        this.activeWritePromise = null;
      }
    });
    this.activeWritePromise = nextWrite;
    return nextWrite;
  }
  async flushPendingCacheSave() {
    if (this.saveCacheTimer) {
      this.clearSaveCacheTimeout(this.saveCacheTimer);
      this.saveCacheTimer = null;
    }
    const resolve = this.saveCacheResolve;
    if (!this.saveCachePromise) {
      await this.activeWritePromise;
      return;
    }
    if (!this.isAcceptingWrites()) {
      this.cancelPendingSave();
      return;
    }
    const mergeDiskEntries = this.pendingSaveAuthoritative ? false : this.pendingSaveMergeDiskEntries;
    this.saveCachePromise = null;
    this.saveCacheResolve = null;
    this.pendingSaveMergeDiskEntries = true;
    this.pendingSaveAuthoritative = false;
    await this.queueCacheWrite(this.serializeForDisk(), { mergeDiskEntries });
    resolve?.();
  }
  flushPendingCacheSaveSync() {
    const snapshot = this.serializeForDisk();
    const activeWriteAtFlush = this.activeWritePromise;
    const replayToken = ++this.syncFlushReplayToken;
    const mergeDiskEntries = this.pendingSaveAuthoritative ? false : this.pendingSaveMergeDiskEntries;
    if (this.saveCacheTimer) {
      this.clearSaveCacheTimeout(this.saveCacheTimer);
      this.saveCacheTimer = null;
    }
    if (!this.saveCachePromise && !this.activeWritePromise) {
      return;
    }
    this.syncFlushToken = Math.max(this.syncFlushToken, this.cacheWriteToken);
    try {
      this.writeCacheFileSyncAtomic(snapshot, { mergeDiskEntries });
      if (activeWriteAtFlush) {
        this.syncFlushReplayPromise = activeWriteAtFlush.catch((error) => {
          console.warn(getLogTag(this), "Active cache write failed before unload replay:", error);
        }).then(() => {
          if (this.syncFlushReplayToken !== replayToken) {
            return;
          }
          try {
            this.writeCacheFileSyncAtomic(snapshot, { mergeDiskEntries: false });
          } catch (error) {
            console.error(getLogTag(this), "Failed to replay cache flush after active write:", error);
          }
        }).finally(() => {
          if (this.syncFlushReplayToken === replayToken) {
            this.syncFlushReplayPromise = null;
          }
        });
      }
    } finally {
      const resolve = this.saveCacheResolve;
      this.saveCachePromise = null;
      this.saveCacheResolve = null;
      this.activeWritePromise = null;
      this.pendingSaveMergeDiskEntries = true;
      resolve?.();
    }
  }
  async getCacheKey(file: ImageFileLike, pathOverride: string | null = null, mtimeOverride: number | null = null) {
    try {
      const buffer = await this.app.vault.readBinary(file);
      const uint8Buffer = new Uint8Array(buffer);
      const md5 = crypto.createHash("md5").update(uint8Buffer).digest("hex");
      const mtime = this.resolveSourceMtime(mtimeOverride, file?.stat?.mtime);
      if (mtime === null) {
        console.warn(getLogTag(this), `Cannot build cache key without real mtime: ${pathOverride || file?.path || ""}`);
        return "";
      }
      return this.buildCacheKey(pathOverride || file.path, md5, mtime);
    } catch {
      const mtime = this.resolveSourceMtime(mtimeOverride, file?.stat?.mtime);
      if (mtime === null) {
        console.warn(getLogTag(this), `Cannot build fallback cache key without real mtime: ${pathOverride || file?.path || ""}`);
        return "";
      }
      return this.buildCacheKey(pathOverride || file?.path || "", "", mtime);
    }
  }
  async getFileMd5(file: ImageFileLike) {
    try {
      const buffer = await this.app.vault.readBinary(file);
      const uint8Buffer = new Uint8Array(buffer);
      // Cache fingerprint only; integrity/security comparisons use SHA-256 helpers.
      return crypto.createHash("md5").update(uint8Buffer).digest("hex");
    } catch {
      return "";
    }
  }
  async getFileMd5ByPath(filePath: string) {
    try {
      const normalizedPath = this.normalizeVaultPath(filePath);
      const file = getVaultFileByPath(this.app.vault, normalizedPath);
      if (!file) {
        return "";
      }
      return await this.getFileMd5(file);
    } catch {
      return "";
    }
  }
  normalizeMtime(value: unknown) {
    if (value === null || value === undefined || value === "" || typeof value === "boolean") {
      return this.nextInvalidMtimeFallback();
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.round(numeric) : this.nextInvalidMtimeFallback();
  }
  nextInvalidMtimeFallback() {
    this.lastInvalidMtimeFallback = Math.max(Date.now(), this.lastInvalidMtimeFallback + 1);
    return this.lastInvalidMtimeFallback;
  }
  resolveSourceMtime(...candidates: unknown[]) {
    for (const candidate of candidates) {
      if (candidate === null || candidate === undefined || candidate === "" || typeof candidate === "boolean") {
        continue;
      }
      const numeric = Number(candidate);
      if (Number.isFinite(numeric)) {
        return this.normalizeMtime(numeric);
      }
    }
    return null;
  }
  isAbsolutePath(filePath: string) {
    return isAbsoluteFilesystemPath(filePath);
  }
  getVaultBasePath() {
    return getVaultBasePath(this.app);
  }
  normalizeVaultPath(filePath: string | null | undefined) {
    if (!filePath) {
      return "";
    }
    const vaultRelativePath = toVaultRelativePath(filePath, this.getVaultBasePath());
    return isSafeVaultRelativePath(vaultRelativePath) ? vaultRelativePath : "";
  }
  resolveVaultPath(filePath: string | null | undefined) {
    const vaultRelativePath = this.normalizeVaultPath(filePath);
    if (!vaultRelativePath) {
      return "";
    }
    return path2.join(this.getVaultBasePath(), vaultRelativePath);
  }
  async getOutputMetadata(outputPath: string | null | undefined) {
    try {
      if (!outputPath) {
        return null;
      }
      const fullPath = this.resolveVaultPath(outputPath);
      if (!fullPath) {
        return null;
      }
      const stats = await fs2.promises.stat(fullPath);
      return {
        outputPath: this.normalizeVaultPath(outputPath),
        outputMtime: this.normalizeMtime(stats.mtimeMs),
        outputSize: stats.size
      };
    } catch {
      return null;
    }
  }
  buildCacheKey(filePath: string, md5 = "", mtime: unknown) {
    const resolvedMtime = this.resolveSourceMtime(mtime);
    if (resolvedMtime === null) {
      throw new Error(`Cannot build cache key without real mtime: ${filePath}`);
    }
    const normalizedPath = this.normalizeVaultPath(filePath);
    const fingerprint = `${normalizeVaultPathForComparison(normalizedPath)}\n${md5 || ""}\n${resolvedMtime}`;
    return `v2:${crypto.createHash("sha256").update(fingerprint).digest("hex")}`;
  }
  parseLegacyCacheKey(cacheKey: string) {
    const key = String(cacheKey || "");
    if (!key || key.startsWith("v2:")) {
      return { path: "", md5: "", mtime: undefined };
    }
    const md5Match = key.match(/^(.*):([a-f0-9]{32}):(\d+(?:\.\d+)?)$/i);
    if (md5Match) {
      return {
        path: md5Match[1],
        md5: md5Match[2],
        mtime: this.normalizeMtime(md5Match[3])
      };
    }
    const fallbackMtimeMatch = key.match(/^(.*):(\d{12,})$/);
    if (fallbackMtimeMatch) {
      return {
        path: fallbackMtimeMatch[1],
        md5: "",
        mtime: this.normalizeMtime(fallbackMtimeMatch[2])
      };
    }
    return { path: key, md5: "", mtime: undefined };
  }
  getEntryPath(cacheKey: string, entry: CacheEntry | null = null) {
    const entryPath = entry?.path;
    if (entryPath) {
      return this.normalizeVaultPath(entryPath);
    }
    return this.normalizeVaultPath(this.parseLegacyCacheKey(cacheKey).path);
  }
  normalizeCacheData(parsed: unknown) {
    const baseData = this.isPlainRecord(parsed) ? this.clonePlainRecord(parsed) : {};
    const parsedEntries = this.isPlainRecord(parsed) ? parsed["entries"] : undefined;
    const sourceEntries = this.isPlainRecord(parsedEntries) ? parsedEntries : {};
    const entries: Record<string, CacheEntry> = {};
    let changed = false;
    if (this.isPlainRecord(parsed) && parsed["entries"] !== undefined && !this.isPlainRecord(parsed["entries"])) {
      changed = true;
      console.warn(getLogTag(this), `cache.entries has invalid type (${Array.isArray(parsed["entries"]) ? "array" : typeof parsed["entries"]}); using empty entries`);
    }
    for (const [cacheKey, rawEntry] of Object.entries(sourceEntries)) {
      if (!this.isPlainRecord(rawEntry)) {
        changed = true;
        console.warn(getLogTag(this), `cache entry has invalid type (${Array.isArray(rawEntry) ? "array" : typeof rawEntry}); skipping ${cacheKey}`);
        continue;
      }
      const entry = this.clonePlainRecord(rawEntry) as CacheEntry;
      const entryPath = this.getEntryPath(cacheKey, entry);
      if (entryPath && entry.path !== entryPath) {
        entry.path = entryPath;
        changed = true;
      }
      if (this.normalizeCacheEntryState(entry)) {
        changed = true;
      }
      if (this.normalizeCacheEntrySkipReason(entry)) {
        changed = true;
      }
      const parsedKey = this.parseLegacyCacheKey(cacheKey);
      const md5 = entry.md5 || parsedKey.md5 || "";
      const mtime = entry.sourceMtime ?? entry.mtime ?? (parsedKey.mtime ? parsedKey.mtime : undefined);
      const normalizedCacheKey = entryPath && mtime !== undefined ? this.buildCacheKey(entryPath, md5, mtime) : cacheKey;
      if (normalizedCacheKey !== cacheKey) {
        changed = true;
      }
      const existingEntry = entries[normalizedCacheKey];
      if (existingEntry && Number(existingEntry.timestamp || 0) > Number(entry.timestamp || 0)) {
        continue;
      }
      entries[normalizedCacheKey] = entry;
    }
    return {
      changed,
      data: {
        ...baseData,
        entries,
        version: this.CACHE_VERSION
      }
    };
  }
  getCachePathEntries(): CachePathEntries {
    const rawEntries = this.cacheData?.entries;
    if (!this.isPlainRecord(rawEntries)) {
      console.warn(getLogTag(this), `cache.entries has invalid in-memory type (${Array.isArray(rawEntries) ? "array" : typeof rawEntries}); ignoring entries`);
      return [];
    }
    const entries: CachePathEntries = [];
    for (const [cacheKey, entry] of Object.entries(rawEntries)) {
      if (!this.isPlainRecord(entry)) {
        console.warn(getLogTag(this), `cache entry has invalid in-memory type (${Array.isArray(entry) ? "array" : typeof entry}); skipping ${cacheKey}`);
        continue;
      }
      entries.push([cacheKey, entry]);
    }
    return entries;
  }
  async renameCacheEntries(oldPath: string, newPath: string) {
    if (!this.isAcceptingWrites()) {
      return;
    }
    const oldNormalized = this.normalizeVaultPath(oldPath);
    const newNormalized = this.normalizeVaultPath(newPath);
    if (!oldNormalized || !newNormalized || oldNormalized === newNormalized) {
      return;
    }
    let changed = false;
    const nextEntries: Record<string, CacheEntry> = {};
    for (const [cacheKey, entry] of this.getCachePathEntries()) {
      if (!vaultPathsEqual(this.getEntryPath(cacheKey, entry), oldNormalized)) {
        nextEntries[cacheKey] = entry;
        continue;
      }
      const nextEntry: CacheEntry = {
        ...entry,
        path: newNormalized
      };
      const md5 = nextEntry.md5 || this.parseLegacyCacheKey(cacheKey).md5 || "";
      let mtime = nextEntry.sourceMtime ?? nextEntry.mtime;
      if (mtime === undefined) {
        const renamedFile = getVaultFileByPath(this.app.vault, newNormalized);
        mtime = renamedFile?.stat.mtime;
      }
      if (mtime === undefined) {
        console.warn(getLogTag(this), `Cannot rename cache entry without mtime: ${oldNormalized} -> ${newNormalized}`);
        nextEntries[cacheKey] = entry;
        continue;
      }
      nextEntries[this.buildCacheKey(newNormalized, md5, mtime)] = nextEntry;
      changed = true;
    }
    if (changed) {
      if (!this.isAcceptingWrites()) {
        return;
      }
      this.cacheData.entries = nextEntries;
      await this.saveCache({ mergeDiskEntries: false });
    }
  }
  getEntriesByPathMap() {
    const map = new Map<string, CachePathEntries>();
    for (const [cacheKey, entry] of this.getCachePathEntries()) {
      const filePath = this.getEntryPath(cacheKey, entry);
      if (!filePath) {
        continue;
      }
      const pathKey = normalizeVaultPathForComparison(filePath);
      if (!map.has(pathKey)) {
        map.set(pathKey, []);
      }
      map.get(pathKey)!.push([cacheKey, entry]);
    }
    return map;
  }
  getEntriesForPathFromMap(filePath: string, entriesByPath: Map<string, CachePathEntries>): CachePathEntries {
    const pathKey = normalizeVaultPathForComparison(this.normalizeVaultPath(filePath));
    return entriesByPath.get(pathKey) || [];
  }
  getEntriesForPath(filePath: string): CachePathEntries {
    return this.getEntriesForPathFromMap(filePath, this.getEntriesByPathMap());
  }
  sortEntriesByTimestamp(entries: CachePathEntries): CachePathEntries {
    return [...entries].sort((left, right) => Number(right[1]?.timestamp || 0) - Number(left[1]?.timestamp || 0));
  }
  getEntryRetentionTime(entry: CacheEntry) {
    const candidates = [
      entry.lastAccessMs,
      entry.timestamp,
      entry.stateUpdatedAt,
      this.getLegacyCacheNumber(entry, "movedAt"),
      entry.pendingSince,
      entry.outputMtime,
      entry.processedMtime,
      entry.sourceMtime,
      entry.mtime
    ];
    let newest = 0;
    for (const candidate of candidates) {
      const numeric = Number(candidate);
      if (Number.isFinite(numeric) && numeric > newest) {
        newest = numeric;
      }
    }
    return newest;
  }
  hasFiniteNumber(value: unknown) {
    return value !== null && value !== undefined && Number.isFinite(Number(value));
  }
  hasNonNegativeSize(value: unknown) {
    return this.hasFiniteNumber(value) && Number(value) >= 0;
  }
  touchCacheEntry(entry: CacheEntry, now = Date.now()) {
    const current = Number(entry.lastAccessMs || 0);
    if (!Number.isFinite(current) || current < now) {
      entry.lastAccessMs = now;
      return true;
    }
    return false;
  }
  scheduleLastAccessSave(now = Date.now()) {
    if (!this.isAcceptingWrites()) {
      return;
    }
    if (this.lastAccessSavePromise || now - this.lastAccessSaveAt < this.lastAccessSaveIntervalMs) {
      return;
    }
    this.lastAccessSaveAt = now;
    const savePromise = this.saveCache({ mergeDiskEntries: true })
      .catch((error) => {
        console.warn(getLogTag(this), "lastAccessMs cache touch save failed:", error);
      })
      .finally(() => {
        if (this.lastAccessSavePromise === savePromise) {
          this.lastAccessSavePromise = null;
        }
      });
    this.lastAccessSavePromise = savePromise;
  }
  getEntryOutputPath(entry: CacheEntry) {
    return this.normalizeVaultPath(entry.outputPath || "");
  }
  selectEntryForMove(entries: CachePathEntries, outputPath: string | null = null): [string, CacheEntry] | null {
    const sortedEntries = this.sortEntriesByTimestamp(entries);
    const normalizedOutputPath = this.normalizeVaultPath(outputPath || "");
    if (normalizedOutputPath) {
      const outputPathEntry = sortedEntries.find(([, entry]) => vaultPathsEqual(this.getEntryOutputPath(entry), normalizedOutputPath));
      if (outputPathEntry) {
        return outputPathEntry;
      }
    }
    const pendingEntry = sortedEntries.find(([, entry]) => entry?.state === "pending_move");
    if (pendingEntry) {
      return pendingEntry;
    }
    const stateAwareEntry = sortedEntries.find(([, entry]) => !this.isLegacyEntry(entry));
    return stateAwareEntry || sortedEntries[0] || null;
  }
  sourceMatchesCurrentFile(entry: CacheEntry, file: ImageFileLike) {
    if (!this.hasFiniteNumber(entry.sourceMtime) || !this.hasNonNegativeSize(entry.sourceSize) || !this.hasFiniteNumber(file?.stat?.mtime) || !this.hasNonNegativeSize(file?.stat?.size)) {
      return false;
    }
    return this.normalizeMtime(entry.sourceMtime) === this.normalizeMtime(file.stat.mtime) && Number(entry.sourceSize) === Number(file.stat.size);
  }
  processedMatchesCurrentFile(entry: CacheEntry, file: ImageFileLike) {
    if (!this.hasFiniteNumber(entry.processedMtime) || !this.hasNonNegativeSize(entry.processedSize) || !this.hasFiniteNumber(file?.stat?.mtime) || !this.hasNonNegativeSize(file?.stat?.size)) {
      return false;
    }
    return this.normalizeMtime(entry.processedMtime) === this.normalizeMtime(file.stat.mtime) && Number(entry.processedSize) === Number(file.stat.size);
  }
  async outputMatchesEntry(entry: CacheEntry) {
    const metadata = await this.getOutputMetadata(entry.outputPath);
    if (!metadata) {
      return false;
    }
    if (!this.hasNonNegativeSize(entry.outputSize) || !this.hasFiniteNumber(entry.outputMtime)) {
      return false;
    }
    if (Number(entry.outputSize) !== Number(metadata.outputSize)) {
      return false;
    }
    if (this.normalizeMtime(entry.outputMtime) !== this.normalizeMtime(metadata.outputMtime)) {
      return false;
    }
    return true;
  }
  isLegacyEntry(entry: CacheEntry) {
    return this.getCacheEntryState(entry) === "processed" && entry.sourceMtime === undefined && entry.sourceSize === undefined && entry.processedMtime === undefined && entry.processedSize === undefined;
  }
  async entryMatchesCurrentFile(entry: CacheEntry, file: ImageFileLike) {
    if (!entry || !file?.stat) {
      return false;
    }
    const state = this.getCacheEntryState(entry);
    switch (state) {
      case "pending_move":
        return this.sourceMatchesCurrentFile(entry, file) && await this.outputMatchesEntry(entry);
      case "moved":
        return this.processedMatchesCurrentFile(entry, file);
      case "skipped":
      case "skipped_identical":
        return this.sourceMatchesCurrentFile(entry, file) && this.skippedSettingsMatch(entry, file);
      case "processed":
        if (this.processedMatchesCurrentFile(entry, file)) {
          return true;
        }
        if (this.sourceMatchesCurrentFile(entry, file)) {
          return true;
        }
        if (this.isLegacyEntry(entry)) {
          return true;
        }
        return false;
    }
    return false;
  }
  async getFreshEntryForFile(file: ImageFileLike): Promise<FreshCacheEntry | null> {
    if (!file?.path) {
      return null;
    }
    return await this.getFreshEntryForFileFromEntries(file, this.getEntriesForPath(file.path));
  }
  async getFreshEntryForFileFromEntries(file: ImageFileLike, entries?: CachePathEntries): Promise<FreshCacheEntry | null> {
    if (!file?.path || !entries) {
      return null;
    }
    const sortedEntries = this.sortEntriesByTimestamp(entries);
    const stateAwareEntries = sortedEntries.filter(([, entry]) => !this.isLegacyEntry(entry));
    const candidates = stateAwareEntries.length > 0 ? stateAwareEntries : sortedEntries;
    for (const [cacheKey, entry] of candidates) {
      if (await this.entryMatchesCurrentFile(entry, file)) {
        if (this.touchCacheEntry(entry)) {
          this.scheduleLastAccessSave();
        }
        return { cacheKey, entry };
      }
    }
    return null;
  }
  async isFileAlreadyProcessed(file: ImageFileLike) {
    return !!await this.getFreshEntryForFile(file);
  }
  isSettingsSensitiveSkipReason(skipReason: string | undefined) {
    return skipReason === "pngquant_quality_failed" || skipReason === "mozjpeg_failed" || skipReason === "compressed_not_smaller" || skipReason === "too_large";
  }
  skippedSettingsMatch(entry: CacheEntry, file: ImageFileLike) {
    if (!entry.compressionSettingsKey) {
      return !this.isSettingsSensitiveSkipReason(entry.skipReason);
    }
    if (typeof this.compressionSettingsProvider !== "function") {
      return true;
    }
    const currentKey = this.compressionSettingsProvider(file, entry.skipReason);
    return entry.compressionSettingsKey === currentKey;
  }
  // New method: force cache refresh (skip timestamp validation)
  async forceRefreshCache() {
    await this.loadCache();
  }
  async addToCache(
    cacheKey: string,
    originalSize: number | null = null,
    file: ImageFileLike | null = null,
    outputPath: string | null = null,
    pathOverride: string | null = null,
    mtimeOverride: number | null = null
  ) {
    if (!this.isAcceptingWrites()) {
      return;
    }
    try {
      const legacyParts = this.parseLegacyCacheKey(cacheKey);
      const filePath = this.normalizeVaultPath(pathOverride || file?.path || legacyParts.path);
      if (!filePath) {
        return;
      }
      const sourceMtime = this.resolveSourceMtime(mtimeOverride, file?.stat?.mtime, legacyParts.mtime);
      if (sourceMtime === null) {
        console.warn(getLogTag(this), `addToCache refusing entry without real mtime: ${filePath}`);
        return;
      }
      const sourceSize = this.resolveSourceSize(originalSize, file?.stat?.size);
      if (sourceSize === null) {
        console.warn(getLogTag(this), `addToCache refusing entry without real size: ${filePath}`);
        return;
      }
      let md5 = legacyParts.md5 || "";
      if (!md5 && file) {
        md5 = await this.getFileMd5(file);
      }
      if (!this.isAcceptingWrites()) {
        return;
      }
      const entryKey = this.buildCacheKey(filePath, md5, sourceMtime);
      const outputMetadata = await this.getOutputMetadata(outputPath);
      if (!this.isAcceptingWrites()) {
        return;
      }
      const now = Date.now();
      this.cacheData.entries[entryKey] = {
        path: filePath,
        md5,
        mtime: sourceMtime,
        timestamp: now,
        lastAccessMs: now,
        originalSize: originalSize, // Preserve original size
        sourceMtime,
        sourceSize,
        // Intentionally pending until the compressed output is moved or deleted.
        state: "pending_move",
        stateUpdatedAt: now,
        pendingSince: now,
        outputPath: outputMetadata?.outputPath || this.normalizeVaultPath(outputPath),
        ...(outputMetadata?.outputMtime !== undefined ? { outputMtime: outputMetadata.outputMtime } : {}),
        ...(outputMetadata?.outputSize !== undefined ? { outputSize: outputMetadata.outputSize } : {})
      };
      await this.saveCache({ mergeDiskEntries: true });
    } catch (error) {
      console.warn(getLogTag(this), "addToCache failed:", error);
    }
  }
  async addSkippedEntry(filePath: string, skipReason: string, compressionSettingsKey: string | null = null) {
    if (!this.isAcceptingWrites()) {
      return;
    }
    try {
      const normalizedPath = this.normalizeVaultPath(filePath);
      const file = getVaultFileByPath(this.app.vault, normalizedPath);
      if (!file)
        return;
      const buffer = await this.app.vault.readBinary(file);
      const uint8Buffer = new Uint8Array(buffer);
      const md5 = crypto.createHash("md5").update(uint8Buffer).digest("hex");
      const normalizedFilePath = this.normalizeVaultPath(file.path);
      const cacheKey = this.buildCacheKey(normalizedFilePath, md5, file.stat.mtime);
      if (!this.isAcceptingWrites()) {
        return;
      }
      const now = Date.now();
      const entry: CacheEntry = {
        path: normalizedFilePath,
        md5,
        mtime: file.stat.mtime,
        timestamp: now,
        lastAccessMs: now,
        state: "skipped",
        stateUpdatedAt: now,
        skipReason,
        originalSize: file.stat.size, // Preserve size for skipped files as well
        sourceMtime: this.normalizeMtime(file.stat.mtime),
        sourceSize: file.stat.size,
        ...(compressionSettingsKey ? { compressionSettingsKey } : {})
      };
      this.cacheData.entries[cacheKey] = entry;
      await this.saveCache({ mergeDiskEntries: true });
    } catch (error) {
      console.warn(getLogTag(this), "addSkippedEntry failed:", error);
    }
  }
  async markProcessedFileMoved(filePath: string, processedStats: FileStatsLike, originalSize: number | null = null, outputPath: string | null = null) {
    if (!this.isAcceptingWrites()) {
      return;
    }
    try {
      const normalizedPath = this.normalizeVaultPath(filePath);
      const entries = this.getEntriesForPath(normalizedPath);
      const selectedEntry = this.selectEntryForMove(entries, outputPath);
      const processedMtime = this.resolveSourceMtime(processedStats?.mtimeMs, processedStats?.mtime);
      const processedSize = this.resolveSourceSize(null, processedStats?.size);
      if (processedMtime === null || processedSize === null) {
        console.warn(getLogTag(this), `Cannot mark moved file without processed mtime/size: ${normalizedPath}`);
        return;
      }
      const existingEntry = (selectedEntry?.[1] || {});
      let md5 = existingEntry.md5 || "";
      let cacheKey = selectedEntry?.[0];
      if (!cacheKey) {
        md5 = await this.getFileMd5ByPath(normalizedPath);
        if (!md5) {
          console.error(getLogTag(this), "Cannot mark moved file without cache entry or md5:", normalizedPath);
          return;
        }
        cacheKey = this.buildCacheKey(normalizedPath, md5, processedMtime);
      }
      if (!this.isAcceptingWrites()) {
        return;
      }
      const now = Date.now();
      const baseEntry = this.stripLegacyCacheStateFields(existingEntry);
      const movedEntry: CacheEntry = {
        ...baseEntry,
        path: normalizedPath,
        timestamp: now,
        lastAccessMs: now,
        originalSize: existingEntry.originalSize || originalSize,
        state: "moved",
        stateUpdatedAt: now,
        processedMtime,
        processedSize
      };
      const movedMd5 = md5 || existingEntry.md5;
      if (movedMd5) {
        movedEntry.md5 = movedMd5;
      }
      this.cacheData.entries[cacheKey] = movedEntry;
      await this.saveCache({ mergeDiskEntries: true });
    } catch (error) {
      console.warn(getLogTag(this), "markProcessedFileMoved failed:", error);
    }
  }
  async markProcessedFileSkippedIdentical(filePath: string, processedStats: FileStatsLike, originalSize: number | null = null, outputPath: string | null = null) {
    if (!this.isAcceptingWrites()) {
      return;
    }
    try {
      const normalizedPath = this.normalizeVaultPath(filePath);
      const entries = this.getEntriesForPath(normalizedPath);
      const selectedEntry = this.selectEntryForMove(entries, outputPath);
      const sourceMtime = this.resolveSourceMtime(processedStats?.mtimeMs, processedStats?.mtime);
      const sourceSize = this.resolveSourceSize(null, processedStats?.size) ?? this.resolveSourceSize(originalSize, null);
      if (sourceMtime === null || sourceSize === null) {
        console.warn(getLogTag(this), `Cannot mark identical skipped file without source mtime/size: ${normalizedPath}`);
        return;
      }
      const existingEntry = (selectedEntry?.[1] || {});
      let md5 = existingEntry.md5 || "";
      let cacheKey = selectedEntry?.[0];
      if (!cacheKey) {
        md5 = await this.getFileMd5ByPath(normalizedPath);
        if (!md5) {
          console.error(getLogTag(this), "Cannot mark identical skipped file without cache entry or md5:", normalizedPath);
          return;
        }
        cacheKey = this.buildCacheKey(normalizedPath, md5, sourceMtime);
      }
      if (!this.isAcceptingWrites()) {
        return;
      }
      const now = Date.now();
      const baseEntry = this.stripLegacyCacheStateFields(existingEntry);
      const skippedEntry: CacheEntry = {
        ...baseEntry,
        path: normalizedPath,
        timestamp: now,
        lastAccessMs: now,
        originalSize: existingEntry.originalSize || originalSize,
        state: "skipped_identical",
        stateUpdatedAt: now,
        skipReason: "identical_output",
        sourceMtime,
        sourceSize
      };
      const skippedMd5 = md5 || existingEntry.md5;
      if (skippedMd5) {
        skippedEntry.md5 = skippedMd5;
      }
      this.cacheData.entries[cacheKey] = skippedEntry;
      await this.saveCache({ mergeDiskEntries: true });
    } catch (error) {
      console.warn(getLogTag(this), "markProcessedFileSkippedIdentical failed:", error);
    }
  }
  async clearCache() {
    if (!this.isAcceptingWrites()) {
      return;
    }
    this.cancelPendingSave();
    this.cacheData.entries = {};
    await this.saveCache({ mergeDiskEntries: false, authoritative: true });
  }
  getCacheStats() {
    const total = Object.keys(this.cacheData.entries).length;
    const size = JSON.stringify(this.cacheData).length;
    return { total, size };
  }
  // Cache backup system
  getCacheBackupTimestamp(now = new Date()) {
    return buildCacheBackupTimestamp(now);
  }
  getCacheBackupPath(randomSuffix: string, now = new Date()) {
    return buildCacheBackupPath(this.cacheBackupsDir, randomSuffix, now);
  }
  isCacheBackupFile(file: string) {
    return isCacheBackupFileName(file);
  }
  getCacheBackupCleanupDirs(backupDir: string) {
    return [
      path2.join(backupDir, "broken"),
      path2.dirname(this.cacheFile)
    ];
  }
  getCacheLoadErrorKind(error: unknown) {
    if (error instanceof SyntaxError) {
      return "parse";
    }
    if (error instanceof Error && /invalid|malformed|schema|version/i.test(error.message)) {
      return "validation";
    }
    return "io";
  }
  logCacheLoadFailure(error: unknown) {
    const kind = this.getCacheLoadErrorKind(error);
    console.warn(getLogTag(this), `Cache load failed (${kind}); preserving broken cache copy before reset:`, error);
  }
  resolveSourceSize(originalSize: number | null | undefined, fileStatSize: unknown) {
    if (originalSize !== null && originalSize !== undefined) {
      return originalSize;
    }
    if (typeof fileStatSize === "number" && Number.isFinite(fileStatSize) && fileStatSize >= 0) {
      return fileStatSize;
    }
    return null;
  }
  async createBackup() {
    try {
      await fs2.promises.access(this.cacheFile);
      const randomSuffix = await randomHexSuffix();
      const { backupDir, backupFile } = this.getCacheBackupPath(randomSuffix);
      await fs2.promises.mkdir(backupDir, { recursive: true });
      await fs2.promises.copyFile(this.cacheFile, backupFile);
      await this.cleanupOldBackups(backupDir);
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") {
        console.warn(getLogTag(this), "createBackup failed:", error);
      }
    }
  }
  createBackupSync() {
    try {
      if (!fs2.existsSync(this.cacheFile)) {
        return;
      }
      const randomSuffix = randomHexSuffixSync();
      const { backupDir, backupFile } = this.getCacheBackupPath(randomSuffix);
      if (!fs2.existsSync(backupDir)) {
        fs2.mkdirSync(backupDir, { recursive: true });
      }
      fs2.copyFileSync(this.cacheFile, backupFile);
      this.cleanupOldBackupsSync(backupDir);
    } catch (error) {
      console.warn(getLogTag(this), "createBackup failed:", error);
    }
  }
  async cleanupOldBackups(backupDir: string) {
    await this.cleanupRetainedFiles(
      backupDir,
      (file: string) => this.isCacheBackupFile(file)
    );
    for (const cleanupDir of this.getCacheBackupCleanupDirs(backupDir)) {
      await this.cleanupOldBrokenCacheCopies(cleanupDir);
    }
  }
  cleanupOldBackupsSync(backupDir: string) {
    this.cleanupRetainedFilesSync(
      backupDir,
      (file: string) => this.isCacheBackupFile(file)
    );
    for (const cleanupDir of this.getCacheBackupCleanupDirs(backupDir)) {
      this.cleanupOldBrokenCacheCopiesSync(cleanupDir);
    }
  }
  async cleanupOldBrokenCacheCopies(brokenDir: string) {
    await this.cleanupRetainedFiles(
      brokenDir,
      (file: string) => isBrokenCacheFileName(file)
    );
  }
  cleanupOldBrokenCacheCopiesSync(brokenDir: string) {
    this.cleanupRetainedFilesSync(
      brokenDir,
      (file: string) => isBrokenCacheFileName(file)
    );
  }
  sortRetainedFiles<T extends { name: string; stat: fs2.Stats }>(files: T[]) {
    return files.sort((left, right) => {
      const mtimeDiff = right.stat.mtime.getTime() - left.stat.mtime.getTime();
      if (mtimeDiff !== 0) {
        return mtimeDiff;
      }
      return right.name.localeCompare(left.name);
    });
  }
  async cleanupRetainedFiles(directory: string, includeFile: (file: string) => boolean) {
    try {
      const entries = await fs2.promises.readdir(directory, { withFileTypes: true }).catch((error) => {
        if (getErrorCode(error) !== "ENOENT") {
          console.warn(getLogTag(this), "cleanupRetainedFiles readdir failed:", error);
        }
        return [];
      });
      const statLimiter = new ConcurrencyLimiter(8);
      const stats: Array<{ name: string; path: string; stat: fs2.Stats } | null> = [];
      const retainedEntries = entries.filter((entry) => entry.isFile() && includeFile(entry.name));
      for (let index = 0; index < retainedEntries.length; index += this.retainedFilesStatBatchSize) {
        const batch = retainedEntries.slice(index, index + this.retainedFilesStatBatchSize);
        stats.push(...await Promise.all(batch.map((entry) => statLimiter.run(async () => {
            const entryPath = path2.join(directory, entry.name);
            try {
              return {
                name: entry.name,
                path: entryPath,
                stat: await fs2.promises.stat(entryPath)
              };
            } catch (error) {
              console.warn(getLogTag(this), "cleanupRetainedFiles stat failed:", error);
              return null;
            }
          }))));
        if (index + this.retainedFilesStatBatchSize < retainedEntries.length) {
          await this.yieldToUi();
        }
      }
      const files = this.sortRetainedFiles(stats
        .filter((file): file is { name: string; path: string; stat: fs2.Stats } => file !== null));
      const minRetentionMs = 7 * 24 * 60 * 60 * 1000;
      const now = Date.now();
      const filesToDelete = files.filter((file, index) => {
        if (index >= CACHE_BACKUP_MAX_COUNT) {
          return true;
        }
        if (index < 10) {
          return false;
        }
        return now - file.stat.mtime.getTime() > minRetentionMs;
      });
      const unlinkLimiter = new ConcurrencyLimiter(8);
      await Promise.all(filesToDelete.map((file) => unlinkLimiter.run(async () => {
        try {
          await fs2.promises.unlink(file.path);
        } catch (error) {
          console.warn(getLogTag(this), "cleanupRetainedFiles unlink failed:", error);
        }
      })));
    } catch (error) {
      console.warn(getLogTag(this), "cleanupRetainedFiles failed:", error);
    }
  }
  cleanupRetainedFilesSync(directory: string, includeFile: (file: string) => boolean) {
    try {
      if (!fs2.existsSync(directory)) {
        return;
      }
      const files = fs2.readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && includeFile(entry.name))
        .map((entry) => ({
        name: entry.name,
        path: path2.join(directory, entry.name),
        stat: fs2.statSync(path2.join(directory, entry.name))
      }));
      this.sortRetainedFiles(files);
      const minRetentionMs = 7 * 24 * 60 * 60 * 1000;
      const now = Date.now();
      const filesToDelete = files.filter((file, index) => {
        if (index >= CACHE_BACKUP_MAX_COUNT) {
          return true;
        }
        if (index < 10) {
          return false;
        }
        return now - file.stat.mtime.getTime() > minRetentionMs;
      });
      for (const file of filesToDelete) {
        fs2.unlinkSync(file.path);
      }
    } catch (error) {
      console.warn(getLogTag(this), "cleanupRetainedFiles failed:", error);
    }
  }
  // Enhanced restore-from-backup method
  isValidBackupFileName(fileName: string) {
    return isValidCacheBackupFileName(fileName);
  }
  isPathWithinDirectory(candidatePath: string, directoryPath: string, allowDirectoryItself = false) {
    const relativePath = path2.relative(directoryPath, candidatePath);
    if (allowDirectoryItself && relativePath === "") {
      return true;
    }
    return Boolean(relativePath) && !relativePath.startsWith("..") && !path2.isAbsolute(relativePath);
  }
  async validateBackupPathForRestore(backupFile: string, backupDir: string) {
    const resolvedBackup = path2.resolve(backupFile);
    const resolvedDir = path2.resolve(backupDir);
    const expectedBackupDir = path2.resolve(this.cacheBackupsDir);
    if (resolvedDir !== expectedBackupDir) {
      throw new Error(`Unexpected backup directory: ${path2.basename(backupDir)}`);
    }
    if (!this.isPathWithinDirectory(resolvedBackup, resolvedDir)) {
      throw new Error(`Backup path escapes backupDir: ${path2.basename(backupFile)}`);
    }
    const backupStorageRoot = path2.dirname(this.cacheBackupsDir);
    const realBackupStorageRoot = await fs2.promises.realpath(backupStorageRoot);
    const realBackupDir = await fs2.promises.realpath(backupDir);
    const realBackup = await fs2.promises.realpath(backupFile);
    if (!this.isPathWithinDirectory(realBackupDir, realBackupStorageRoot)) {
      throw new Error(`Backup directory escapes backup storage: ${path2.basename(backupDir)}`);
    }
    if (!this.isPathWithinDirectory(realBackup, realBackupDir)) {
      throw new Error(`Backup file resolves outside backupDir: ${path2.basename(backupFile)}`);
    }
    return realBackup;
  }
  async copyBackupHandleToCache(backupFile: string, backupDir: string) {
    const lstatBeforeOpen = await fs2.promises.lstat(backupFile);
    if (lstatBeforeOpen.isSymbolicLink() || !lstatBeforeOpen.isFile()) {
      throw new Error(`Backup is not a regular file: ${path2.basename(backupFile)}`);
    }
    const backupHandle = await fs2.promises.open(backupFile, "r");
    const lock = await this.acquireCacheWriteLock();
    if (!lock) {
      await backupHandle.close();
      throw new Error("Could not acquire cache write lock for restore");
    }
    try {
      const handleStat = await backupHandle.stat();
      if (!handleStat.isFile()) {
        throw new Error(`Backup handle is not a regular file: ${path2.basename(backupFile)}`);
      }
      const realBackup = await this.validateBackupPathForRestore(backupFile, backupDir);
      const lstatAfterValidation = await fs2.promises.lstat(backupFile);
      if (lstatAfterValidation.isSymbolicLink() || !lstatAfterValidation.isFile()) {
        throw new Error(`Backup changed during validation: ${path2.basename(backupFile)}`);
      }
      if (lstatAfterValidation.dev !== handleStat.dev || lstatAfterValidation.ino !== handleStat.ino) {
        throw new Error(`Backup changed during validation: ${path2.basename(backupFile)}`);
      }
      const finalRealBackup = await fs2.promises.realpath(backupFile);
      if (finalRealBackup !== realBackup) {
        throw new Error(`Backup real path changed during validation: ${path2.basename(backupFile)}`);
      }
      await pipeline(backupHandle.createReadStream({ start: 0 }), fs2.createWriteStream(this.cacheFile));
    } finally {
      await this.releaseCacheWriteLock(lock);
      await backupHandle.close();
    }
  }
  async restoreFromBackup(backupFileName: string | null = null) {
    try {
      const backupDir = this.cacheBackupsDir;
      let backupFile: string;
      if (backupFileName) {
        const safeBackupName = String(backupFileName);
        if (!this.isValidBackupFileName(safeBackupName)) {
          throw new Error(`Invalid backup filename: ${safeBackupName}`);
        }
        backupFile = path2.join(backupDir, backupFileName);
      } else {
        const backupEntries = await fs2.promises.readdir(backupDir, { withFileTypes: true });
        const files = (await Promise.all(
          backupEntries
            .filter((entry) => entry.isFile() && this.isValidBackupFileName(entry.name))
            .map(async (entry) => {
              const entryPath = path2.join(backupDir, entry.name);
              return {
                name: entry.name,
                path: entryPath,
                stat: await fs2.promises.stat(entryPath)
              };
            })
        )).sort((a, b) => b.stat.mtime.getTime() - a.stat.mtime.getTime());
        if (files.length === 0) {
          return false;
        }
        const latestBackup = files[0];
        if (!latestBackup) {
          return false;
        }
        backupFile = latestBackup.path;
      }
      try {
        await fs2.promises.access(backupFile);
      } catch {
        return false;
      }
      await this.flushPendingCacheSave();
      await this.createBackup();
      await this.copyBackupHandleToCache(backupFile, backupDir);
      await this.loadCache();
      return true;
    } catch (error) {
      console.error(getLogTag(this), "Backup restore error:", error);
      return false;
    }
  }
  async getAvailableBackups() {
    try {
      const backupDir = this.cacheBackupsDir;
      const backups = await fs2.promises.readdir(backupDir).catch((error) => {
        if (getErrorCode(error) !== "ENOENT") {
          console.warn(getLogTag(this), "getAvailableBackups readdir failed:", error);
        }
        return [];
      });
      return backups
        .filter((file) => isCacheBackupFileName(file))
        .sort()
        .reverse();
    } catch (error) {
      console.warn(getLogTag(this), "getAvailableBackups failed:", error);
      return [];
    }
  }
  // Count ghost entries (files that no longer exist)
  async getGhostEntriesCount() {
    const entriesToRemove = await this.collectGhostEntryKeys();
    return entriesToRemove.length;
  }
  async yieldToUi() {
    await new Promise((resolve) => {
      try {
        window.setTimeout(resolve, 0);
        return;
      } catch (error) {
        console.warn(getLogTag(this), "yieldToUi failed:", error);
      }
      window.setTimeout(resolve, 0);
    });
  }
  async pathExists(filePath: string) {
    try {
      if (!filePath) {
        return false;
      }
      await fs2.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }
  async collectGhostEntryKeys() {
    const entriesToRemove: string[] = [];
    const entries = this.getCachePathEntries();
    const batchSize = 200;
    for (let index = 0; index < entries.length; index++) {
      const entryPair = entries[index];
      if (!entryPair) {
        continue;
      }
      const [cacheKey, entry] = entryPair;
      const filePath = this.getEntryPath(cacheKey, entry);
      try {
        const fullPath = this.resolveVaultPath(filePath);
        if (!await this.pathExists(fullPath)) {
          entriesToRemove.push(cacheKey);
        }
      } catch {
        entriesToRemove.push(cacheKey);
      }
      if ((index + 1) % batchSize === 0) {
        await this.yieldToUi();
      }
    }
    return entriesToRemove;
  }
  // Cleanup ghost entries from cache
  async cleanupGhostEntries() {
    if (!this.isAcceptingWrites()) {
      return 0;
    }
    const entriesToRemove = await this.collectGhostEntryKeys();
    if (entriesToRemove.length === 0) {
      return 0;
    }
    if (!this.isAcceptingWrites()) {
      return 0;
    }
    await this.createBackup();
    for (const cacheKey of entriesToRemove) {
      delete this.cacheData.entries[cacheKey];
    }
    await this.saveCache({ mergeDiskEntries: false });
    return entriesToRemove.length;
  }
  async pruneStaleCacheEntries(retentionMonths: number, now = Date.now()) {
    if (!this.isAcceptingWrites()) {
      return 0;
    }
    const numericMonths = Number(retentionMonths);
    const safeMonths = Number.isFinite(numericMonths) ? Math.max(1, Math.min(60, Math.trunc(numericMonths))) : 12;
    const cutoffMs = now - safeMonths * 30 * 24 * 60 * 60 * 1000;
    const entries = this.getCachePathEntries();
    const entriesToRemove: string[] = [];
    for (let index = 0; index < entries.length; index++) {
      const entryPair = entries[index];
      if (!entryPair) {
        continue;
      }
      const [cacheKey, entry] = entryPair;
      const retentionTime = this.getEntryRetentionTime(entry);
      if (retentionTime > 0 && retentionTime < cutoffMs) {
        entriesToRemove.push(cacheKey);
      }
      if ((index + 1) % this.staleEntryPruneBatchSize === 0) {
        await this.yieldToUi();
      }
    }
    if (entriesToRemove.length === 0 || !this.isAcceptingWrites()) {
      return 0;
    }
    await this.createBackup();
    for (const cacheKey of entriesToRemove) {
      delete this.cacheData.entries[cacheKey];
    }
    await this.saveCache({ mergeDiskEntries: false });
    return entriesToRemove.length;
  }
}
