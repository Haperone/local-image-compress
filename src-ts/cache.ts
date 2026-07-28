import * as obsidian from "obsidian";
import { getBackupStoragePaths } from "./backup-storage";
import { getCacheTempFilePath, LEGACY_CACHE_FILE_NAME } from "./cache-file-names";
import type { FsLease, FsSyncPort, PlatformPorts, ReplaceFileOptions } from "./platform/ports";
import { CacheBackupStore } from "./services/cache-backup-store";
import { CacheCompaction } from "./services/cache-compaction";
import type { CacheData, CacheEntry, CacheEntryState, CacheMutationRevision, CachePathEntries, CompressionArtifactContext, FileStatsLike, FreshCacheEntry, ImageFileLike, TimerHandle } from "./types";
import { getErrorCode, getLogTag, getVaultFileByPath, isSafeVaultRelativePath, normalizeVaultPath, normalizeVaultPathForComparison, randomHexSuffix, randomHexSuffixSync, vaultPathsEqual } from "./utils";

type CacheWriteOptions = {
  mergeDiskEntries?: boolean;
  // Access-only snapshots may update surviving entries but must never recreate
  // a key removed by an authoritative compaction in another instance.
  existingEntriesOnly?: boolean;
  // Authoritative writes (e.g. clearCache) must NOT merge disk entries even when coalesced with a
  // concurrent additive save — they intentionally overwrite the whole cache.
  authoritative?: boolean;
  // undefined means no caller CAS; null means the cache must still be absent.
  expectedRevision?: string | null;
  requiredEntryMutation?: {
    cacheKey: string;
    revision: CacheMutationRevision;
    signature: string;
  };
};

type PendingCacheWrite = {
  version: 1;
  ownerId: string;
  createdAt: number;
  mergeDiskEntries: boolean;
  existingEntriesOnly: boolean;
  expectedRevision: string | null;
  acceptedRevisions: Array<string | null>;
  data: string;
};

type CacheFileIdentity = {
  path: string;
  stat: {
    mtime: number;
    size: number;
  };
};

type PendingMoveIdentity = CacheFileIdentity & {
  sourceSha256: string;
  outputSha256: string;
};

type MoveCacheEntryIdentity = {
  cacheKey: string;
  outputSha256: string;
};

type CacheApp = obsidian.App & {
  manifest?: {
    dir?: string;
  };
};

type CacheWriteLock = FsLease;

const CACHE_WRITE_LOCK_TIMEOUT_MS = 5_000;
const CACHE_WRITE_LOCK_SYNC_TIMEOUT_MS = 500;
const CACHE_WRITE_LOCK_RETRY_MS = 50;
const CACHE_TEMP_STALE_MS = 5 * 60_000;
const CACHE_TEMP_FILE_PATTERN = /^\.tinyLocal-cache-\d+-(\d+)-[a-f0-9]{32}\.tmp$/i;
const PENDING_CACHE_FILE_PATTERN = /^\.tinyLocal-cache-pending-\d+-(\d+)-[a-f0-9]{32}\.json$/i;

export class Cache {
  CACHE_VERSION: string;
  app: CacheApp;
  readonly ports: PlatformPorts;
  cacheFile: string;
  cacheBackupsDir: string;
  cacheData: CacheData;
  lastLoadError: unknown;
  brokenCacheBackupPath: string | null;
  compressionSettingsProvider: ((file: ImageFileLike, skipReason?: string) => string | null) | null;
  isUnloadingProvider: (() => boolean) | null;
  saveCacheDelayMs: number;
  saveCacheTimer: TimerHandle | null;
  saveCachePromise: Promise<boolean> | null;
  saveCacheResolve: ((committed: boolean) => void) | null;
  activeWritePromise: Promise<boolean> | null;
  activeWriteMergeDiskEntries: boolean;
  activeWriteExistingEntriesOnly: boolean;
  cacheWriteToken: number;
  syncFlushToken: number;
  acceptingWrites: boolean;
  backupStore: CacheBackupStore;
  compaction: CacheCompaction;
  lastInvalidMtimeFallback: number;
  cacheLockOwnerId: string;
  pendingSaveMergeDiskEntries: boolean;
  pendingSaveExistingEntriesOnly: boolean;
  pendingSaveAuthoritative: boolean;
  lastAccessSaveIntervalMs: number;
  lastAccessSaveAt: number;
  lastAccessSavePromise: Promise<void> | null;

  constructor(app: CacheApp, cacheBackupsDir: string | undefined, ports: PlatformPorts) {
    this.CACHE_VERSION = "2.0.0";
    this.app = app;
    this.ports = ports;
    const manifestDir = app.manifest?.dir;
    const configDir = app.vault.configDir;
    const cacheDir = normalizeVaultPath(manifestDir || `${configDir}/plugins/local-image-compress`);
    if (cacheDir && !isSafeVaultRelativePath(cacheDir)) {
      throw new Error(`Plugin cache directory is outside the vault: ${cacheDir}`);
    }
    this.cacheFile = ports.fs.joinPath(cacheDir, LEGACY_CACHE_FILE_NAME);
    this.cacheBackupsDir = normalizeVaultPath(cacheBackupsDir ?? getBackupStoragePaths(ports.fs).cacheBackups);
    if (!isSafeVaultRelativePath(this.cacheBackupsDir)) {
      throw new Error(`Cache backup directory is outside the vault: ${this.cacheBackupsDir}`);
    }
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
    this.activeWriteMergeDiskEntries = false;
    this.activeWriteExistingEntriesOnly = false;
    this.cacheWriteToken = 0;
    this.syncFlushToken = 0;
    this.acceptingWrites = true;
    this.backupStore = new CacheBackupStore(this);
    this.compaction = new CacheCompaction(this);
    this.lastInvalidMtimeFallback = 0;
    this.cacheLockOwnerId = `${ports.runtime.instanceId}-${Date.now()}-${randomHexSuffixSync()}`;
    this.pendingSaveMergeDiskEntries = true;
    this.pendingSaveExistingEntriesOnly = false;
    this.pendingSaveAuthoritative = false;
    this.lastAccessSaveIntervalMs = 60_000;
    this.lastAccessSaveAt = 0;
    this.lastAccessSavePromise = null;
  }
  isAcceptingWrites() {
    return this.acceptingWrites && !this.isUnloadingProvider?.();
  }
  // The sync facet exists only on desktop; sync cache paths are unreachable on
  // mobile (locks disabled, unload flush falls back to async there).
  requireSyncFs(): FsSyncPort {
    const syncFs = this.ports.fs.sync;
    if (!syncFs) {
      throw new Error("Synchronous cache filesystem is unavailable on this platform");
    }
    return syncFs;
  }
  lockWritesForUnload() {
    this.acceptingWrites = false;
  }
  getEmptyCacheData() {
    return {
      entries: {},
      tombstones: {},
      version: this.CACHE_VERSION
    };
  }
  serializeForDisk(data: unknown = this.cacheData) {
    return JSON.stringify(data);
  }
  getCacheLockFile() {
    return `${this.cacheFile}.lock`;
  }
  async sleepForCacheLock(delayMs: number) {
    await new Promise((resolve) => window.setTimeout(resolve, delayMs));
  }
  async acquireCacheWriteLock(timeoutMs = CACHE_WRITE_LOCK_TIMEOUT_MS): Promise<CacheWriteLock | null> {
    const leasePort = this.ports.fs.lease;
    if (!leasePort) {
      return null;
    }
    const lease = await leasePort.acquire(this.getCacheLockFile(), this.cacheLockOwnerId, timeoutMs, CACHE_WRITE_LOCK_RETRY_MS);
    if (!lease) {
      console.warn(getLogTag(this), "Could not acquire cache write lease; skipping cache write to avoid multi-instance corruption");
    }
    return lease;
  }
  acquireCacheWriteLockSync(timeoutMs = CACHE_WRITE_LOCK_SYNC_TIMEOUT_MS): CacheWriteLock | null {
    const lease = this.ports.fs.lease?.acquireSync(this.getCacheLockFile(), this.cacheLockOwnerId, timeoutMs, CACHE_WRITE_LOCK_RETRY_MS) || null;
    if (!lease) {
      console.warn(getLogTag(this), "Could not acquire cache write lease; skipping sync cache write to avoid multi-instance corruption");
    }
    return lease;
  }
  async renewAndValidateCacheWriteLock(lock: CacheWriteLock) {
    const leasePort = this.ports.fs.lease;
    return !!leasePort && await leasePort.renew(lock) && await leasePort.validate(lock);
  }
  renewAndValidateCacheWriteLockSync(lock: CacheWriteLock) {
    const leasePort = this.ports.fs.lease;
    return !!leasePort && leasePort.renewSync(lock) && leasePort.validateSync(lock);
  }
  async releaseCacheWriteLock(lock: CacheWriteLock | null) {
    if (!lock) {
      return;
    }
    try {
      await this.ports.fs.lease?.release(lock);
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
      this.ports.fs.lease?.releaseSync(lock);
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") {
        console.warn(getLogTag(this), "Cache write lock release failed:", error);
      }
    }
  }
  getMutationRevision(value: unknown): CacheMutationRevision | null {
    if (!this.isPlainRecord(value)) {
      return null;
    }
    const counter = Number(value["counter"]);
    const ownerId = value["ownerId"];
    return Number.isSafeInteger(counter) && counter > 0 && typeof ownerId === "string" && ownerId.length > 0
      ? { counter, ownerId }
      : null;
  }
  compareMutationRevisions(left: CacheMutationRevision | null, right: CacheMutationRevision | null) {
    if (!left || !right) {
      return left ? 1 : right ? -1 : 0;
    }
    return left.counter - right.counter || (left.ownerId === right.ownerId ? 0 : left.ownerId > right.ownerId ? 1 : -1);
  }
  compareEntryMutations(left: CacheEntry, right: CacheEntry) {
    const leftRevision = this.getMutationRevision(left.mutationRevision);
    const rightRevision = this.getMutationRevision(right.mutationRevision);
    if (leftRevision || rightRevision) {
      return this.compareMutationRevisions(leftRevision, rightRevision);
    }
    return this.getEntryMutationTime(left) - this.getEntryMutationTime(right);
  }
  nextMutationRevision(...candidates: Array<CacheMutationRevision | CacheEntry | null | undefined>): CacheMutationRevision {
    let counter = 0;
    for (const candidate of candidates) {
      const revision = candidate && "counter" in candidate
        ? this.getMutationRevision(candidate)
        : this.getMutationRevision(candidate?.mutationRevision);
      counter = Math.max(counter, revision?.counter || 0);
    }
    return { counter: counter + 1, ownerId: this.cacheLockOwnerId };
  }
  stampEntryMutation(entry: CacheEntry, previousEntry?: CacheEntry, tombstone?: CacheMutationRevision) {
    entry.mutationRevision = this.nextMutationRevision(previousEntry, tombstone);
    return entry;
  }
  getCacheTombstones(data: CacheData) {
    return data.tombstones || {};
  }
  setMutatedCacheEntry(cacheKey: string, entry: CacheEntry) {
    const tombstones = (this.cacheData.tombstones ??= {});
    this.stampEntryMutation(entry, this.cacheData.entries[cacheKey], tombstones[cacheKey]);
    this.cacheData.entries[cacheKey] = entry;
    delete tombstones[cacheKey];
    return entry;
  }
  tombstoneCacheEntry(cacheKey: string) {
    const currentEntry = this.cacheData.entries[cacheKey];
    const tombstones = (this.cacheData.tombstones ??= {});
    tombstones[cacheKey] = this.nextMutationRevision(currentEntry, tombstones[cacheKey]);
    delete this.cacheData.entries[cacheKey];
    return tombstones[cacheKey];
  }
  mergeCacheEntries(diskEntries: Record<string, CacheEntry>, nextEntries: Record<string, CacheEntry>, existingEntriesOnly = false) {
    const merged: Record<string, CacheEntry> = { ...diskEntries };
    for (const [cacheKey, nextEntry] of Object.entries(nextEntries)) {
      const diskEntry = merged[cacheKey];
      if (!diskEntry) {
        if (!existingEntriesOnly) {
          merged[cacheKey] = nextEntry;
        }
        continue;
      }
      const selectedEntry = existingEntriesOnly || this.compareEntryMutations(diskEntry, nextEntry) >= 0
        ? diskEntry
        : nextEntry;
      const lastAccessMs = Math.max(this.getEntryLastAccessTime(diskEntry), this.getEntryLastAccessTime(nextEntry));
      merged[cacheKey] = lastAccessMs > 0 && this.getEntryLastAccessTime(selectedEntry) !== lastAccessMs
        ? { ...selectedEntry, lastAccessMs }
        : selectedEntry;
    }
    return merged;
  }
  mergeCacheTombstones(
    diskTombstones: Record<string, CacheMutationRevision>,
    nextTombstones: Record<string, CacheMutationRevision>,
    existingEntriesOnly = false
  ) {
    const merged = { ...diskTombstones };
    if (existingEntriesOnly) {
      return merged;
    }
    for (const [cacheKey, nextRevision] of Object.entries(nextTombstones)) {
      const diskRevision = merged[cacheKey];
      if (!diskRevision || this.compareMutationRevisions(nextRevision, diskRevision) > 0) {
        merged[cacheKey] = nextRevision;
      }
    }
    return merged;
  }
  buildMergedCachePayload(nextRawData: string, diskRawData: string, existingEntriesOnly = false) {
    const nextData = this.normalizeCacheData(JSON.parse(nextRawData)).data;
    const diskData = this.normalizeCacheData(JSON.parse(diskRawData)).data;
    const entries = this.mergeCacheEntries(diskData.entries, nextData.entries, existingEntriesOnly);
    const tombstones = this.mergeCacheTombstones(
      this.getCacheTombstones(diskData),
      this.getCacheTombstones(nextData),
      existingEntriesOnly
    );
    for (const cacheKey of new Set([...Object.keys(entries), ...Object.keys(tombstones)])) {
      const entry = entries[cacheKey];
      const tombstone = tombstones[cacheKey];
      if (!tombstone) {
        continue;
      }
      const entryRevision = entry ? this.getMutationRevision(entry.mutationRevision) : null;
      if (!entryRevision || this.compareMutationRevisions(tombstone, entryRevision) >= 0) {
        delete entries[cacheKey];
      } else {
        delete tombstones[cacheKey];
      }
    }
    return this.serializeForDisk({
      ...diskData,
      ...nextData,
      entries,
      tombstones,
      version: this.CACHE_VERSION
    });
  }
  getCacheRevision(rawData: string | null) {
    return rawData === null ? null : this.ports.hash.sha256Hex(rawData);
  }
  cachePayloadContainsRequiredMutation(rawData: string, required: NonNullable<CacheWriteOptions["requiredEntryMutation"]>) {
    const entry = this.normalizeCacheData(JSON.parse(rawData)).data.entries[required.cacheKey];
    const revision = this.getMutationRevision(entry?.mutationRevision);
    return !!entry
      && !!revision
      && this.compareMutationRevisions(revision, required.revision) === 0
      && this.getEntryMutationSignature(entry) === required.signature;
  }
  cacheRevisionMatches(options: CacheWriteOptions, rawData: string | null) {
    if (!Object.prototype.hasOwnProperty.call(options, "expectedRevision")) {
      return true;
    }
    return options.expectedRevision === this.getCacheRevision(rawData);
  }
  async readCacheRawIfPresent() {
    try {
      return await this.ports.fs.readText(this.cacheFile);
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        return null;
      }
      throw error;
    }
  }
  mergeDiskCacheEntriesSync(nextRawData: string) {
    const diskRawData = this.readCacheRawIfPresentSync();
    return diskRawData === null ? nextRawData : this.buildMergedCachePayload(nextRawData, diskRawData);
  }
  readCacheRawIfPresentSync() {
    try {
      return this.requireSyncFs().readTextSync(this.cacheFile);
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        return null;
      }
      throw error;
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
  createBrokenCacheCopySync(error: unknown, expectedRevision: string | null) {
    this.lastLoadError = error;
    this.brokenCacheBackupPath = null;
    this.logCacheLoadFailure(error);
    try {
      const syncFs = this.requireSyncFs();
      if (!syncFs.existsSync(this.cacheFile)) {
        return true;
      }
      const backupPath = this.backupStore.getBrokenCacheBackupPath();
      syncFs.mkdirSync(this.ports.fs.dirnamePath(backupPath));
      syncFs.copyFileSync(this.cacheFile, backupPath, { exclusive: true });
      this.brokenCacheBackupPath = backupPath;
      this.backupStore.cleanupOldBrokenCacheCopiesSync(this.ports.fs.dirnamePath(backupPath));
      this.backupStore.cleanupOldBrokenCacheCopiesSync(this.ports.fs.dirnamePath(this.cacheFile));
      return this.persistPendingCacheWriteSync(
        this.serializeForDisk(this.getEmptyCacheData()),
        false,
        false,
        expectedRevision
      );
    } catch (copyError) {
      console.error(getLogTag(this), "Broken cache recovery failed:", copyError);
      return true;
    }
  }
  async createBrokenCacheCopy(error: unknown, expectedRevision: string | null) {
    this.lastLoadError = error;
    this.brokenCacheBackupPath = null;
    this.logCacheLoadFailure(error);
    try {
      if (!await this.ports.fs.exists(this.cacheFile)) {
        return true;
      }
      const backupPath = this.backupStore.getBrokenCacheBackupPath();
      await this.ports.fs.mkdir(this.ports.fs.dirnamePath(backupPath));
      await this.ports.fs.copyFile(this.cacheFile, backupPath, { exclusive: true });
      this.brokenCacheBackupPath = backupPath;
      await this.backupStore.cleanupOldBrokenCacheCopies(this.ports.fs.dirnamePath(backupPath));
      await this.backupStore.cleanupOldBrokenCacheCopies(this.ports.fs.dirnamePath(this.cacheFile));
      return await this.writeCacheFileAtomic(this.serializeForDisk(this.getEmptyCacheData()), () => true, {
        mergeDiskEntries: false,
        expectedRevision
      });
    } catch (copyError) {
      console.error(getLogTag(this), "Broken cache recovery failed:", copyError);
      return true;
    }
  }
  writeCacheFileSyncAtomic(data: string, options: CacheWriteOptions = {}) {
    // Desktop has no crash-safe synchronous conditional-replace primitive.
    // The unload path therefore publishes this snapshot as a complete pending
    // journal below; a raw sync rename would reopen the final-fence race.
    void data;
    void options;
    return false;
  }
  getStaleCacheTempTimestamp(fileName: string, now = Date.now()) {
    const targetName = this.cacheFile.replace(/\\/g, "/").split("/").pop() || LEGACY_CACHE_FILE_NAME;
    const escapedTargetName = targetName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const currentPattern = new RegExp(`^\\.?${escapedTargetName}\\.tinylocal-(?:recovery-)?(\\d+)-[a-f0-9]{32}\\.tmp$`, "i");
    const match = CACHE_TEMP_FILE_PATTERN.exec(fileName) || currentPattern.exec(fileName);
    const timestamp = Number(match?.[1]);
    return Number.isFinite(timestamp) && timestamp > 0 && now - timestamp >= CACHE_TEMP_STALE_MS ? timestamp : null;
  }
  cleanupOrphanedTempFilesSync() {
    // The sync port has no identity-bound delete. Retain stale artifacts here;
    // the normal async startup pass removes their exact content revisions.
  }
  async cleanupOrphanedTempFiles() {
    const cacheDir = this.ports.fs.dirnamePath(this.cacheFile);
    const lock = await this.acquireCacheWriteLock();
    if (!lock) {
      return;
    }
    try {
      const entries = await this.ports.fs.listNames(cacheDir).catch((error: unknown) => {
        if (getErrorCode(error) !== "ENOENT") {
          console.warn(getLogTag(this), "Orphan cache temp scan failed:", error);
        }
        return [] as string[];
      });
      for (const fileName of entries) {
        if (this.getStaleCacheTempTimestamp(fileName) === null || !await this.renewAndValidateCacheWriteLock(lock)) {
          continue;
        }
        try {
          const tempPath = this.ports.fs.joinPath(cacheDir, fileName);
          const expectedSha256 = await this.ports.hash.fileSha256Hex(tempPath);
          const result = await this.ports.fs.removeFileIfUnchanged(tempPath, expectedSha256);
          if (result.retainedConflictPath) {
            console.warn(getLogTag(this), "Orphan cache temp cleanup conflict retained:", result.retainedConflictPath);
          }
        } catch (error) {
          if (getErrorCode(error) !== "ENOENT") {
            console.warn(getLogTag(this), "Orphan cache temp cleanup failed:", fileName, error);
          }
        }
      }
    } catch (error) {
      console.warn(getLogTag(this), "Orphan cache temp cleanup failed:", error);
    } finally {
      await this.releaseCacheWriteLock(lock);
    }
  }
  // fsync is unsupported on some network/virtual filesystems; the atomic
  // rename still guarantees readers never observe a torn cache file. The
  // platform port swallows those errors (LLL2-A-6 durability best effort).
  async fsyncPathBestEffort(filePath: string) {
    await this.ports.fs.fsyncBestEffort(filePath);
  }
  async unlinkTempFileWithRetry(tempFile: string, expectedSha256: string, context: string) {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await this.ports.fs.removeFileIfUnchanged(tempFile, expectedSha256);
        if (result.removed) {
          return true;
        }
        console.warn(getLogTag(this), `Temporary cache cleanup retained a changed file after ${context}:`, result.retainedConflictPath || tempFile);
        return false;
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
  async renameCacheFileWithRetry(
    tempFile: string,
    targetFile: string,
    replaceOptions: ReplaceFileOptions,
    canCommit: () => Promise<boolean> = async () => true
  ) {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 8; attempt++) {
      if (!await canCommit()) {
        return false;
      }
      try {
        await this.ports.fs.replaceFile(tempFile, targetFile, replaceOptions);
        return true;
      } catch (error) {
        if (!this.isRetriableCacheRenameError(error)) {
          if (!await canCommit()) {
            return false;
          }
          throw error;
        }
        lastError = error;
        await this.sleepForCacheLock(25 * (attempt + 1));
      }
    }
    throw lastError;
  }
  persistPendingCacheWriteSync(
    data: string,
    mergeDiskEntries: boolean,
    existingEntriesOnly: boolean,
    expectedRevision: string | null,
    acceptedRevisions: Array<string | null> = [expectedRevision]
  ) {
    const syncFs = this.requireSyncFs();
    const createdAt = Date.now();
    const finalPath = this.getPendingCacheWritePath(createdAt, randomHexSuffixSync());
    const stagedPath = `${finalPath}.stage-${randomHexSuffixSync()}`;
    const payload: PendingCacheWrite = {
      version: 1,
      ownerId: this.cacheLockOwnerId,
      createdAt,
      mergeDiskEntries,
      existingEntriesOnly,
      expectedRevision,
      acceptedRevisions: [...new Set([expectedRevision, ...acceptedRevisions])],
      data
    };
    try {
      syncFs.writeTextSync(stagedPath, JSON.stringify(payload));
      syncFs.fsyncBestEffortSync(stagedPath);
      syncFs.replaceFileSync(stagedPath, finalPath);
      return true;
    } catch (error) {
      // No sync conditional-delete primitive exists. Retain a possibly partial
      // stage instead of deleting a path that another process may have replaced.
      console.error(getLogTag(this), "Pending cache journal publication failed:", error);
      return false;
    }
  }
  async writeCacheFileAtomic(data: string, shouldCommit: () => boolean = () => true, options: CacheWriteOptions = {}) {
    const cacheDir = this.ports.fs.dirnamePath(this.cacheFile);
    await this.ports.fs.mkdir(cacheDir);
    const processTextAtomically = this.ports.fs.processTextAtomically;
    if (processTextAtomically) {
      if (!shouldCommit()) {
        return false;
      }
      const initialData = this.serializeForDisk(this.getEmptyCacheData());
      const existedBefore = await this.ports.fs.exists(this.cacheFile);
      let committed = false;
      await processTextAtomically(this.cacheFile, initialData, (currentData) => {
        if (!shouldCommit()) {
          return currentData;
        }
        if (Object.prototype.hasOwnProperty.call(options, "expectedRevision")) {
          const revisionMatches = options.expectedRevision === null
            ? !existedBefore && currentData === initialData
            : options.expectedRevision === this.getCacheRevision(currentData);
          if (!revisionMatches) {
            return currentData;
          }
        }
        const finalData = options.mergeDiskEntries
          ? this.buildMergedCachePayload(data, currentData, options.existingEntriesOnly === true)
          : data;
        if (options.requiredEntryMutation && !this.cachePayloadContainsRequiredMutation(finalData, options.requiredEntryMutation)) {
          return currentData;
        }
        committed = true;
        return finalData;
      });
      return committed;
    }
    const lock = await this.acquireCacheWriteLock();
    if (!lock) {
      return false;
    }
    const randomSuffix = await randomHexSuffix();
    const tempFile = getCacheTempFilePath(this.ports.fs, this.cacheFile, this.ports.runtime.instanceId, Date.now(), randomSuffix);
    let tempFileSha256 = this.ports.hash.sha256Hex(data);
    try {
      if (!shouldCommit()) {
        return false;
      }
      const observedRawData = await this.readCacheRawIfPresent();
      if (!this.cacheRevisionMatches(options, observedRawData)) {
        return false;
      }
      const finalData = options.mergeDiskEntries
        ? this.buildMergedCachePayload(
            data,
            observedRawData ?? this.serializeForDisk(this.getEmptyCacheData()),
            options.existingEntriesOnly === true
          )
        : data;
      const finalDataSha256 = this.ports.hash.sha256Hex(finalData);
      tempFileSha256 = finalDataSha256;
      if (options.requiredEntryMutation && !this.cachePayloadContainsRequiredMutation(finalData, options.requiredEntryMutation)) {
        return false;
      }
      await this.ports.fs.writeText(tempFile, finalData);
      if (!shouldCommit()) {
        await this.unlinkTempFileWithRetry(tempFile, finalDataSha256, "cancelled commit");
        return false;
      }
      // LLL2-A-6: flush temp contents to disk before the rename so a power loss
      // immediately after rename cannot surface a zero-length / torn cache file.
      await this.fsyncPathBestEffort(tempFile);
      if (!shouldCommit()
        || !await this.renewAndValidateCacheWriteLock(lock)
        || this.getCacheRevision(await this.readCacheRawIfPresent()) !== this.getCacheRevision(observedRawData)) {
        await this.unlinkTempFileWithRetry(tempFile, finalDataSha256, "lost lease or cache revision");
        return false;
      }
      const observedRevision = this.getCacheRevision(observedRawData);
      const committed = await this.renameCacheFileWithRetry(
        tempFile,
        this.cacheFile,
        {
          ...(observedRevision ? { expectedTargetSha256: observedRevision } : {}),
          expectedTargetMissing: observedRevision === null,
          allowMissingTarget: observedRevision === null,
          expectedStagedSha256: finalDataSha256,
          canCommit: shouldCommit
        },
        async () => shouldCommit()
          && await this.renewAndValidateCacheWriteLock(lock)
          && this.getCacheRevision(await this.readCacheRawIfPresent()) === observedRevision
      );
      if (!committed) {
        await this.unlinkTempFileWithRetry(tempFile, finalDataSha256, "lost commit fence");
      }
      return committed;
    } catch (error) {
      await this.unlinkTempFileWithRetry(tempFile, tempFileSha256, "failed atomic write");
      throw error;
    } finally {
      await this.releaseCacheWriteLock(lock);
    }
  }
  getPendingCacheWritePath(createdAt: number, randomSuffix: string) {
    return this.ports.fs.joinPath(
      this.ports.fs.dirnamePath(this.cacheFile),
      `.tinyLocal-cache-pending-${this.ports.runtime.instanceId}-${createdAt}-${randomSuffix}.json`
    );
  }
  parsePendingCacheWrite(fileName: string, rawData: string): PendingCacheWrite | null {
    const match = PENDING_CACHE_FILE_PATTERN.exec(fileName);
    if (!match) {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(rawData);
      if (!this.isPlainRecord(parsed)) {
        return null;
      }
      const createdAt = Number(parsed["createdAt"]);
      const expectedRevision = parsed["expectedRevision"];
      const data = parsed["data"];
      const ownerId = parsed["ownerId"];
      const mergeDiskEntries = parsed["mergeDiskEntries"];
      const rawExistingEntriesOnly = parsed["existingEntriesOnly"];
      const existingEntriesOnly = rawExistingEntriesOnly === undefined ? false : rawExistingEntriesOnly;
      const rawAcceptedRevisions = parsed["acceptedRevisions"];
      const acceptedRevisions = rawAcceptedRevisions === undefined ? [expectedRevision] : rawAcceptedRevisions;
      if (parsed["version"] !== 1
        || createdAt !== Number(match[1])
        || !Number.isFinite(createdAt) || createdAt <= 0
        || typeof ownerId !== "string" || !ownerId
        || typeof mergeDiskEntries !== "boolean"
        || typeof existingEntriesOnly !== "boolean"
        || typeof data !== "string"
        || !Array.isArray(acceptedRevisions)
        || acceptedRevisions.length === 0
        || acceptedRevisions.some((revision) => revision !== null && (typeof revision !== "string" || !/^[a-f0-9]{64}$/i.test(revision)))
        || (expectedRevision !== null && (typeof expectedRevision !== "string" || !/^[a-f0-9]{64}$/i.test(expectedRevision)))) {
        return null;
      }
      // Validate the snapshot now; malformed journals remain for diagnosis and
      // never reach the authoritative cache path.
      this.normalizeCacheData(JSON.parse(data));
      return {
        version: 1,
        ownerId,
        createdAt,
        mergeDiskEntries,
        existingEntriesOnly,
        expectedRevision,
        acceptedRevisions: [...new Set(acceptedRevisions as Array<string | null>)],
        data
      };
    } catch (error) {
      void error;
      return null;
    }
  }
  pendingRevisionMatches(pending: PendingCacheWrite, revision: string | null) {
    return pending.acceptedRevisions.includes(revision);
  }
  async recoverPendingCacheWrites() {
    const cacheDir = this.ports.fs.dirnamePath(this.cacheFile);
    let fileNames: string[];
    try {
      fileNames = (await this.ports.fs.listNames(cacheDir)).filter((name) => PENDING_CACHE_FILE_PATTERN.test(name)).sort();
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") {
        console.warn(getLogTag(this), "Pending cache journal scan failed:", error);
      }
      return;
    }
    for (const fileName of fileNames) {
      try {
        const journalPath = this.ports.fs.joinPath(cacheDir, fileName);
        const journalData = await this.ports.fs.readText(journalPath);
        const journalSha256 = this.ports.hash.sha256Hex(journalData);
        const pending = this.parsePendingCacheWrite(fileName, journalData);
        if (!pending) {
          console.warn(getLogTag(this), "Invalid pending cache journal retained:", fileName);
          continue;
        }
        const currentRevision = this.getCacheRevision(await this.readCacheRawIfPresent());
        if (!pending.mergeDiskEntries && !this.pendingRevisionMatches(pending, currentRevision)) {
          await this.ports.fs.removeFileIfUnchanged(journalPath, journalSha256);
          continue;
        }
        const committed = await this.writeCacheFileAtomic(pending.data, () => true, {
          mergeDiskEntries: pending.mergeDiskEntries,
          existingEntriesOnly: pending.existingEntriesOnly,
          ...(!pending.mergeDiskEntries ? { expectedRevision: currentRevision } : {})
        });
        if (committed) {
          await this.ports.fs.removeFileIfUnchanged(journalPath, journalSha256);
          continue;
        }
        if (!pending.mergeDiskEntries && !this.pendingRevisionMatches(pending, this.getCacheRevision(await this.readCacheRawIfPresent()))) {
          await this.ports.fs.removeFileIfUnchanged(journalPath, journalSha256);
        }
      } catch (error) {
        if (getErrorCode(error) === "ENOENT") {
          continue;
        }
        console.warn(getLogTag(this), "Pending cache journal recovery deferred:", fileName, error);
      }
      break;
    }
  }
  loadCacheSync(retryCount = 0): void {
    void retryCount;
    this.lastLoadError = null;
    this.brokenCacheBackupPath = null;
    let observedRevision: string | null = null;
    try {
      const syncFs = this.requireSyncFs();
      const cacheDir = this.ports.fs.dirnamePath(this.cacheFile);
      if (!syncFs.existsSync(cacheDir)) {
        syncFs.mkdirSync(cacheDir);
      }
      this.cleanupOrphanedTempFilesSync();
      this.recoverPendingCacheWritesSync();
      if (!syncFs.existsSync(this.cacheFile)) {
        const initialCache = this.getEmptyCacheData();
        this.cacheData = initialCache;
        if (!this.persistPendingCacheWriteSync(this.serializeForDisk(initialCache), false, false, null)) {
          console.warn(getLogTag(this), "Initial cache snapshot could not be preserved for async recovery");
        }
      }
      if (syncFs.existsSync(this.cacheFile)) {
        const data = syncFs.readTextSync(this.cacheFile);
        observedRevision = this.getCacheRevision(data);
        const parsed: unknown = JSON.parse(data);
        const migrated = this.normalizeCacheData(parsed);
        const promotedLegacy = this.migrateLegacyProcessedEntries(migrated.data);
        const version = this.isPlainRecord(parsed) ? parsed["version"] : undefined;
        const shouldPersistMigration = version !== this.CACHE_VERSION || migrated.changed || promotedLegacy;
        if (shouldPersistMigration) {
          this.createBackupSync();
        }
        this.cacheData = migrated.data;
        if (shouldPersistMigration) {
          if (!this.persistPendingCacheWriteSync(this.serializeForDisk(), false, false, observedRevision)) {
            console.warn(getLogTag(this), "Migrated cache snapshot could not be preserved for async recovery");
          }
        }
      }
    } catch (error) {
      this.createBrokenCacheCopySync(error, observedRevision);
      this.cacheData = this.getEmptyCacheData();
    }
  }
  recoverPendingCacheWritesSync() {
    const syncFs = this.requireSyncFs();
    const cacheDir = this.ports.fs.dirnamePath(this.cacheFile);
    if (!syncFs.existsSync(cacheDir)) {
      return;
    }
    const fileNames = syncFs.listNamesSync(cacheDir).filter((name) => PENDING_CACHE_FILE_PATTERN.test(name)).sort();
    for (const fileName of fileNames) {
      try {
        const journalPath = this.ports.fs.joinPath(cacheDir, fileName);
        const pending = this.parsePendingCacheWrite(fileName, syncFs.readTextSync(journalPath));
        if (!pending) {
          console.warn(getLogTag(this), "Invalid pending cache journal retained:", fileName);
          continue;
        }
        const currentRevision = this.getCacheRevision(this.readCacheRawIfPresentSync());
        if (!pending.mergeDiskEntries && !this.pendingRevisionMatches(pending, currentRevision)) {
          continue;
        }
        const committed = this.writeCacheFileSyncAtomic(pending.data, {
          mergeDiskEntries: pending.mergeDiskEntries,
          existingEntriesOnly: pending.existingEntriesOnly,
          ...(!pending.mergeDiskEntries ? { expectedRevision: currentRevision } : {})
        });
        if (committed) {
          continue;
        }
      } catch (error) {
        if (getErrorCode(error) === "ENOENT") {
          continue;
        }
        console.warn(getLogTag(this), "Pending cache journal recovery deferred:", fileName, error);
      }
      break;
    }
  }
  async loadCache(retryCount = 0): Promise<void> {
    this.lastLoadError = null;
    this.brokenCacheBackupPath = null;
    let observedRevision: string | null = null;
    try {
      const cacheDir = this.ports.fs.dirnamePath(this.cacheFile);
      await this.ports.fs.mkdir(cacheDir);
      await this.cleanupOrphanedTempFiles();
      await this.recoverPendingCacheWrites();
      const exists = await this.ports.fs.exists(this.cacheFile);
      if (!exists) {
        const initialCache = this.getEmptyCacheData();
        const created = await this.writeCacheFileAtomic(this.serializeForDisk(initialCache), () => true, {
          mergeDiskEntries: false,
          expectedRevision: null
        });
        if (!created && retryCount < 2) {
          return await this.loadCache(retryCount + 1);
        }
      }
      const data = await this.ports.fs.readText(this.cacheFile);
      observedRevision = this.getCacheRevision(data);
      const parsed: unknown = JSON.parse(data);
      const migrated = this.normalizeCacheData(parsed);
      const promotedLegacy = this.migrateLegacyProcessedEntries(migrated.data);
      const version = this.isPlainRecord(parsed) ? parsed["version"] : undefined;
      const shouldPersistMigration = version !== this.CACHE_VERSION || migrated.changed || promotedLegacy;
      if (shouldPersistMigration) {
        await this.createBackup();
      }
      this.cacheData = migrated.data;
      if (shouldPersistMigration) {
        const persisted = await this.writeCacheFileAtomic(this.serializeForDisk(), () => true, {
          mergeDiskEntries: false,
          expectedRevision: observedRevision
        });
        if (!persisted && retryCount < 2) {
          return await this.loadCache(retryCount + 1);
        }
      }
    } catch (error) {
      const recovered = await this.createBrokenCacheCopy(error, observedRevision);
      if (!recovered && retryCount < 2) {
        return await this.loadCache(retryCount + 1);
      }
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
      return false;
    }
    if (options.requiredEntryMutation) {
      if (this.saveCachePromise) {
        await this.flushPendingCacheSave();
      }
      return await this.queueCacheWrite(this.serializeForDisk(), options);
    }
    const mergeDiskEntries = options.mergeDiskEntries !== false;
    const existingEntriesOnly = options.existingEntriesOnly === true;
    const authoritative = options.authoritative === true;
    if (!this.saveCachePromise) {
      this.saveCachePromise = new Promise((resolve) => {
        this.saveCacheResolve = resolve;
      });
      this.pendingSaveMergeDiskEntries = mergeDiskEntries;
      this.pendingSaveExistingEntriesOnly = existingEntriesOnly;
      this.pendingSaveAuthoritative = authoritative;
    } else {
      // BR-H2: OR the merge intents so a coalesced ADDITIVE write (addToCache, merge:true) is never
      // downgraded to a disk-clobbering merge:false by a concurrent deletion that lands in the same
      // debounce window. Without this, a synced second instance's freshly-written entries are lost.
      // Authoritative writes (clearCache) still force no-merge below via pendingSaveAuthoritative.
      this.pendingSaveMergeDiskEntries = this.pendingSaveMergeDiskEntries || mergeDiskEntries;
      this.pendingSaveExistingEntriesOnly = this.pendingSaveExistingEntriesOnly && existingEntriesOnly;
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
    this.pendingSaveExistingEntriesOnly = false;
    this.pendingSaveAuthoritative = false;
    resolve?.(false);
  }
  queueCacheWrite(data: string, options: CacheWriteOptions = {}) {
    const previousWrite = this.activeWritePromise;
    const writeToken = ++this.cacheWriteToken;
    let nextWrite: Promise<boolean>;
    nextWrite = (async () => {
      if (previousWrite) {
        await previousWrite;
      }
      try {
        let committed = false;
        for (let attempt = 0; attempt < 3 && writeToken > this.syncFlushToken; attempt++) {
          committed = await this.writeCacheFileAtomic(data, () => writeToken > this.syncFlushToken, options);
          if (committed) {
            break;
          }
          if (writeToken <= this.syncFlushToken) {
            break;
          }
          await this.sleepForCacheLock(CACHE_WRITE_LOCK_RETRY_MS * (attempt + 1));
        }
        if (!committed && writeToken > this.syncFlushToken) {
          console.warn(getLogTag(this), "Cache write remained pending after conditional commit retries");
        }
        return committed;
      } catch (error) {
        console.error(getLogTag(this), "Cache save failed:", error);
        return false;
      }
    })().finally(() => {
      if (this.activeWritePromise === nextWrite) {
        this.activeWritePromise = null;
        this.activeWriteMergeDiskEntries = false;
        this.activeWriteExistingEntriesOnly = false;
      }
    });
    this.activeWritePromise = nextWrite;
    this.activeWriteMergeDiskEntries = options.mergeDiskEntries === true;
    this.activeWriteExistingEntriesOnly = this.activeWriteMergeDiskEntries && options.existingEntriesOnly === true;
    return nextWrite;
  }
  async flushPendingCacheSave() {
    if (this.saveCacheTimer) {
      this.clearSaveCacheTimeout(this.saveCacheTimer);
      this.saveCacheTimer = null;
    }
    const resolve = this.saveCacheResolve;
    if (!this.saveCachePromise) {
      return this.activeWritePromise ? await this.activeWritePromise : true;
    }
    if (!this.isAcceptingWrites()) {
      this.cancelPendingSave();
      return false;
    }
    const mergeDiskEntries = this.pendingSaveAuthoritative ? false : this.pendingSaveMergeDiskEntries;
    const existingEntriesOnly = mergeDiskEntries && this.pendingSaveExistingEntriesOnly;
    this.saveCachePromise = null;
    this.saveCacheResolve = null;
    this.pendingSaveMergeDiskEntries = true;
    this.pendingSaveExistingEntriesOnly = false;
    this.pendingSaveAuthoritative = false;
    const committed = await this.queueCacheWrite(this.serializeForDisk(), { mergeDiskEntries, existingEntriesOnly });
    resolve?.(committed);
    return committed;
  }
  flushPendingCacheSaveSync() {
    if (!this.ports.fs.sync) {
      // Mobile: no synchronous filesystem — flush the pending snapshot through
      // the async write queue as a best effort during unload. queueCacheWrite
      // intentionally bypasses isAcceptingWrites (unload already locked writes).
      const asyncSnapshot = this.serializeForDisk();
      const hasPendingSave = this.saveCachePromise !== null;
      const asyncMergeDiskEntries = hasPendingSave
        ? (this.pendingSaveAuthoritative ? false : this.pendingSaveMergeDiskEntries)
        : this.activeWriteMergeDiskEntries;
      const asyncExistingEntriesOnly = asyncMergeDiskEntries && (hasPendingSave
        ? this.pendingSaveExistingEntriesOnly
        : this.activeWriteExistingEntriesOnly);
      if (this.saveCacheTimer) {
        this.clearSaveCacheTimeout(this.saveCacheTimer);
        this.saveCacheTimer = null;
      }
      if (!this.saveCachePromise && !this.activeWritePromise) {
        return;
      }
      const resolvePending = this.saveCacheResolve;
      this.syncFlushToken = Math.max(this.syncFlushToken, this.cacheWriteToken);
      this.saveCachePromise = null;
      this.saveCacheResolve = null;
      this.pendingSaveMergeDiskEntries = true;
      this.pendingSaveExistingEntriesOnly = false;
      this.pendingSaveAuthoritative = false;
      this.queueCacheWrite(asyncSnapshot, {
        mergeDiskEntries: asyncMergeDiskEntries,
        existingEntriesOnly: asyncExistingEntriesOnly
      }).catch((error: unknown) => {
        console.warn(getLogTag(this), "Async unload cache flush failed:", error);
      });
      resolvePending?.(false);
      return;
    }
    const snapshot = this.serializeForDisk();
    const hasPendingSave = this.saveCachePromise !== null;
    const mergeDiskEntries = hasPendingSave
      ? (this.pendingSaveAuthoritative ? false : this.pendingSaveMergeDiskEntries)
      : this.activeWriteMergeDiskEntries;
    const existingEntriesOnly = mergeDiskEntries && (hasPendingSave
      ? this.pendingSaveExistingEntriesOnly
      : this.activeWriteExistingEntriesOnly);
    if (this.saveCacheTimer) {
      this.clearSaveCacheTimeout(this.saveCacheTimer);
      this.saveCacheTimer = null;
    }
    if (!this.saveCachePromise && !this.activeWritePromise) {
      return;
    }
    this.syncFlushToken = Math.max(this.syncFlushToken, this.cacheWriteToken);
    let expectedRevision: string | null = null;
    try {
      expectedRevision = this.getCacheRevision(this.readCacheRawIfPresentSync());
    } catch (error) {
      console.warn(getLogTag(this), "Could not capture unload cache revision; authoritative replay will fail closed:", error);
    }
    const inFlightRevisions = this.ports.fs.getInFlightReplacementRevisions?.(this.cacheFile) || [];
    const committed = this.writeCacheFileSyncAtomic(snapshot, {
      mergeDiskEntries,
      existingEntriesOnly,
      ...(!mergeDiskEntries ? { expectedRevision } : {})
    });
    const preserved = committed || this.persistPendingCacheWriteSync(
      snapshot,
      mergeDiskEntries,
      existingEntriesOnly,
      expectedRevision,
      inFlightRevisions
    );
    const resolve = this.saveCacheResolve;
    this.saveCachePromise = null;
    this.saveCacheResolve = null;
    this.pendingSaveMergeDiskEntries = true;
    this.pendingSaveExistingEntriesOnly = false;
    this.pendingSaveAuthoritative = false;
    resolve?.(preserved);
  }
  async getCacheKey(file: ImageFileLike, pathOverride: string | null = null, mtimeOverride: number | null = null) {
    try {
      const buffer = await this.readFileBinaryForFingerprint(file);
      const uint8Buffer = new Uint8Array(buffer);
      const md5 = this.ports.hash.md5Hex(uint8Buffer);
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
      const buffer = await this.readFileBinaryForFingerprint(file);
      const uint8Buffer = new Uint8Array(buffer);
      // Cache fingerprint only; integrity/security comparisons use SHA-256 helpers.
      return this.ports.hash.md5Hex(uint8Buffer);
    } catch {
      return "";
    }
  }
  async readFileBinaryForFingerprint(file: ImageFileLike) {
    return await this.ports.fs.runBufferedOperation(async () => {
      if (!this.canReadFileBinary(file)) {
        throw new Error("File exceeds the platform buffered-read limit");
      }
      const buffer = await this.app.vault.readBinary(file);
      const limit = this.ports.runtime.maxBufferedFileBytes;
      if (limit !== null && buffer.byteLength > limit) {
        throw new Error("File exceeded the platform buffered-read limit during read");
      }
      return buffer;
    });
  }
  canReadFileBinary(file: ImageFileLike) {
    const limit = this.ports.runtime.maxBufferedFileBytes;
    if (limit === null) {
      return true;
    }
    const size = file?.stat?.size;
    return typeof size === "number" && Number.isFinite(size) && size >= 0 && size <= limit;
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
  normalizeVaultPath(filePath: string | null | undefined) {
    if (!filePath) {
      return "";
    }
    const vaultRelativePath = normalizeVaultPath(String(filePath));
    return isSafeVaultRelativePath(vaultRelativePath) ? vaultRelativePath : "";
  }
  resolveVaultPath(filePath: string | null | undefined) {
    const vaultRelativePath = this.normalizeVaultPath(filePath);
    return vaultRelativePath;
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
      const stats = await this.ports.fs.stat(fullPath);
      if (!stats) {
        return null;
      }
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
    return `v2:${this.ports.hash.sha256Hex(fingerprint)}`;
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
    const parsedTombstones = this.isPlainRecord(parsed) ? parsed["tombstones"] : undefined;
    const sourceTombstones = this.isPlainRecord(parsedTombstones) ? parsedTombstones : {};
    const entries: Record<string, CacheEntry> = {};
    const tombstones: Record<string, CacheMutationRevision> = {};
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
      if (entry.mutationRevision !== undefined) {
        const mutationRevision = this.getMutationRevision(entry.mutationRevision);
        if (mutationRevision) {
          entry.mutationRevision = mutationRevision;
        } else {
          delete entry.mutationRevision;
          changed = true;
        }
      }
      if (this.getLegacyCacheFlag(entry, "skipped") && (!this.hasFiniteNumber(entry.sourceMtime) || !this.hasNonNegativeSize(entry.sourceSize))) {
        changed = true;
        continue;
      }
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
      if (existingEntry && this.compareEntryMutations(existingEntry, entry) >= 0) {
        continue;
      }
      entries[normalizedCacheKey] = entry;
    }
    if (parsedTombstones !== undefined && !this.isPlainRecord(parsedTombstones)) {
      changed = true;
    }
    for (const [cacheKey, rawRevision] of Object.entries(sourceTombstones)) {
      const revision = this.getMutationRevision(rawRevision);
      if (!revision) {
        changed = true;
        continue;
      }
      tombstones[cacheKey] = revision;
      const entry = entries[cacheKey];
      const entryRevision = entry ? this.getMutationRevision(entry.mutationRevision) : null;
      if (!entryRevision || this.compareMutationRevisions(revision, entryRevision) >= 0) {
        delete entries[cacheKey];
      } else {
        delete tombstones[cacheKey];
      }
    }
    return {
      changed,
      data: {
        ...baseData,
        entries,
        tombstones,
        version: this.CACHE_VERSION
      }
    };
  }
  migrateLegacyProcessedEntries(data: CacheData) {
    let changed = false;
    for (const [cacheKey, entry] of Object.entries(data.entries)) {
      if (!this.isLegacyEntry(entry)) {
        continue;
      }
      const entryPath = this.normalizeVaultPath(entry.path || "");
      if (!entryPath) {
        continue;
      }
      const file = getVaultFileByPath(this.app.vault, entryPath);
      const processedMtime = this.resolveSourceMtime(file?.stat?.mtime);
      const processedSize = this.resolveSourceSize(null, file?.stat?.size);
      if (processedMtime === null || processedSize === null) {
        continue;
      }
      const previousEntry = { ...entry };
      entry.state = "moved";
      entry.stateUpdatedAt = entry.stateUpdatedAt ?? this.resolveSourceMtime(entry.timestamp) ?? processedMtime;
      entry.processedMtime = processedMtime;
      entry.processedSize = processedSize;
      this.stampEntryMutation(entry, previousEntry, data.tombstones?.[cacheKey]);
      changed = true;
    }
    return changed;
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
      return false;
    }
    const oldNormalized = this.normalizeVaultPath(oldPath);
    const newNormalized = this.normalizeVaultPath(newPath);
    if (!oldNormalized || !newNormalized || oldNormalized === newNormalized) {
      return true;
    }
    const previousData = this.cacheData;
    let changed = false;
    const nextEntries: Record<string, CacheEntry> = {};
    const nextTombstones = { ...this.getCacheTombstones(previousData) };
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
      const nextKey = this.buildCacheKey(newNormalized, md5, mtime);
      nextEntry.mutationRevision = this.nextMutationRevision(entry, nextEntries[nextKey], nextTombstones[nextKey]);
      nextEntries[nextKey] = nextEntry;
      nextTombstones[cacheKey] = this.nextMutationRevision(entry, nextTombstones[cacheKey]);
      delete nextTombstones[nextKey];
      changed = true;
    }
    if (!changed) {
      return true;
    }
    if (!this.isAcceptingWrites()) {
      return false;
    }
    const writtenData: CacheData = {
      ...previousData,
      entries: nextEntries,
      tombstones: nextTombstones
    };
    const writtenSignature = this.serializeForDisk(writtenData);
    this.cacheData = writtenData;
    if (!await this.saveCache({ mergeDiskEntries: false, authoritative: true })) {
      if (this.cacheData === writtenData && this.serializeForDisk() === writtenSignature) {
        this.cacheData = previousData;
      }
      return false;
    }
    await this.compactPath(newNormalized);
    return true;
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
  getEntryMutationTime(entry: CacheEntry) {
    const candidates = [
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
  getEntryLastAccessTime(entry: CacheEntry) {
    const lastAccessMs = Number(entry.lastAccessMs);
    return Number.isFinite(lastAccessMs) && lastAccessMs > 0 ? lastAccessMs : 0;
  }
  getEntryMutationSignature(entry: CacheEntry) {
    const mutationFields = { ...entry };
    delete mutationFields.lastAccessMs;
    return JSON.stringify(mutationFields);
  }
  rollbackEntryMutationIfCurrent(
    cacheKey: string,
    previousEntry: CacheEntry | undefined,
    previousTombstone: CacheMutationRevision | undefined,
    writtenEntry: CacheEntry,
    writtenMutationSignature: string
  ) {
    const currentEntry = this.cacheData.entries[cacheKey];
    if (currentEntry !== writtenEntry || this.getEntryMutationSignature(currentEntry) !== writtenMutationSignature) {
      return;
    }
    if (previousEntry) {
      const lastAccessMs = Math.max(this.getEntryLastAccessTime(previousEntry), this.getEntryLastAccessTime(currentEntry));
      this.cacheData.entries[cacheKey] = lastAccessMs > this.getEntryLastAccessTime(previousEntry)
        ? { ...previousEntry, lastAccessMs }
        : previousEntry;
    } else {
      delete this.cacheData.entries[cacheKey];
    }
    const tombstones = (this.cacheData.tombstones ??= {});
    if (previousTombstone) {
      tombstones[cacheKey] = previousTombstone;
    } else {
      delete tombstones[cacheKey];
    }
  }
  async commitEntryMutation(
    cacheKey: string,
    writtenEntry: CacheEntry,
    previousEntry: CacheEntry | undefined,
    previousTombstone: CacheMutationRevision | undefined,
    requireExactMutation = true
  ) {
    const revision = this.getMutationRevision(writtenEntry.mutationRevision);
    const signature = this.getEntryMutationSignature(writtenEntry);
    const committed = !!revision && await this.saveCache(requireExactMutation
      ? { mergeDiskEntries: true, requiredEntryMutation: { cacheKey, revision, signature } }
      : { mergeDiskEntries: true });
    if (!committed) {
      this.rollbackEntryMutationIfCurrent(cacheKey, previousEntry, previousTombstone, writtenEntry, signature);
    }
    return committed;
  }
  rollbackTombstoneMutationIfCurrent(
    cacheKey: string,
    previousEntry: CacheEntry | undefined,
    previousTombstone: CacheMutationRevision | undefined,
    writtenTombstone: CacheMutationRevision
  ) {
    if (this.cacheData.entries[cacheKey]) {
      return;
    }
    const currentTombstone = this.cacheData.tombstones?.[cacheKey];
    if (this.compareMutationRevisions(this.getMutationRevision(currentTombstone), writtenTombstone) !== 0) {
      return;
    }
    if (previousEntry) {
      this.cacheData.entries[cacheKey] = previousEntry;
    }
    const tombstones = (this.cacheData.tombstones ??= {});
    if (previousTombstone) {
      tombstones[cacheKey] = previousTombstone;
    } else {
      delete tombstones[cacheKey];
    }
  }
  getEntryRetentionTime(entry: CacheEntry) {
    return Math.max(this.getEntryMutationTime(entry), this.getEntryLastAccessTime(entry));
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
    // Access recency is its own delta intent. Queue it separately so coalescing
    // with a state-creation save cannot grant stale keys permission to reappear.
    const savePromise = this.queueCacheWrite(this.serializeForDisk(), {
      mergeDiskEntries: true,
      existingEntriesOnly: true
    })
      .then(() => undefined)
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
      const outputPathEntries = sortedEntries.filter(([, entry]) => vaultPathsEqual(this.getEntryOutputPath(entry), normalizedOutputPath));
      const outputPathEntry = outputPathEntries.find(([, entry]) => entry?.state === "pending_move") || outputPathEntries[0];
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
  selectEntryForMoveByIdentity(
    entries: CachePathEntries,
    outputPath: string | null,
    expectedIdentity: MoveCacheEntryIdentity
  ): [string, CacheEntry] | null {
    const normalizedOutputPath = this.normalizeVaultPath(outputPath || "");
    return entries.find(([cacheKey, entry]) =>
      cacheKey === expectedIdentity.cacheKey
      && this.getCacheEntryState(entry) === "pending_move"
      && (!normalizedOutputPath || vaultPathsEqual(this.getEntryOutputPath(entry), normalizedOutputPath))
      && this.isSha256(entry.outputSha256)
      && entry.outputSha256.toLowerCase() === expectedIdentity.outputSha256.toLowerCase()
    ) || null;
  }
  sourceMatchesCurrentFile(entry: CacheEntry, file: CacheFileIdentity) {
    if (!this.hasFiniteNumber(entry.sourceMtime) || !this.hasNonNegativeSize(entry.sourceSize) || !this.hasFiniteNumber(file?.stat?.mtime) || !this.hasNonNegativeSize(file?.stat?.size)) {
      return false;
    }
    return this.normalizeMtime(entry.sourceMtime) === this.normalizeMtime(file.stat.mtime) && Number(entry.sourceSize) === Number(file.stat.size);
  }
  isSha256(value: string | null | undefined): value is string {
    return /^[a-f0-9]{64}$/i.test(value || "");
  }
  async fileHashMatches(filePath: string, expectedSha256: string | null | undefined) {
    if (expectedSha256 === undefined || expectedSha256 === null || expectedSha256 === "") {
      return true;
    }
    if (!this.isSha256(expectedSha256)) {
      return false;
    }
    const normalizedPath = this.normalizeVaultPath(filePath);
    if (!normalizedPath) {
      return false;
    }
    try {
      const actualSha256 = await this.ports.fs.runBufferedOperation(async (token) =>
        await this.ports.hash.fileSha256Hex(normalizedPath, token)
      );
      return actualSha256.toLowerCase() === expectedSha256.toLowerCase();
    } catch (error) {
      console.warn(getLogTag(this), "Cache content-identity check failed:", normalizedPath, error);
      return false;
    }
  }
  processedMatchesCurrentFile(entry: CacheEntry, file: CacheFileIdentity) {
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
    return await this.fileHashMatches(metadata.outputPath, entry.outputSha256);
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
        return this.sourceMatchesCurrentFile(entry, file)
          && await this.fileHashMatches(file.path, entry.sourceSha256)
          && await this.outputMatchesEntry(entry);
      case "moved": {
        if (!this.hasFiniteNumber(entry.processedMtime) || !this.hasNonNegativeSize(entry.processedSize)) {
          return false;
        }
        if (this.isSha256(entry.outputSha256)) {
          return await this.fileHashMatches(file.path, entry.outputSha256);
        }
        const hasNoOutputHash = entry.outputSha256 === undefined
          || entry.outputSha256 === null
          || entry.outputSha256 === "";
        return hasNoOutputHash && this.processedMatchesCurrentFile(entry, file);
      }
      case "skipped":
      case "skipped_identical":
        return this.sourceMatchesCurrentFile(entry, file)
          && await this.fileHashMatches(file.path, entry.sourceSha256)
          && this.skippedSettingsMatch(entry, file);
      case "processed":
        if (this.processedMatchesCurrentFile(entry, file)) {
          return await this.fileHashMatches(file.path, entry.outputSha256);
        }
        if (this.sourceMatchesCurrentFile(entry, file)) {
          return await this.fileHashMatches(file.path, entry.sourceSha256);
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
    for (const [cacheKey, entry] of sortedEntries.filter(([, entry]) => !this.isLegacyEntry(entry))) {
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
      return false;
    }
    try {
      const legacyParts = this.parseLegacyCacheKey(cacheKey);
      const filePath = this.normalizeVaultPath(pathOverride || file?.path || legacyParts.path);
      if (!filePath) {
        return false;
      }
      const sourceMtime = this.resolveSourceMtime(mtimeOverride, file?.stat?.mtime, legacyParts.mtime);
      if (sourceMtime === null) {
        console.warn(getLogTag(this), `addToCache refusing entry without real mtime: ${filePath}`);
        return false;
      }
      const sourceSize = this.resolveSourceSize(originalSize, file?.stat?.size);
      if (sourceSize === null) {
        console.warn(getLogTag(this), `addToCache refusing entry without real size: ${filePath}`);
        return false;
      }
      let md5 = legacyParts.md5 || "";
      if (!md5 && file) {
        md5 = await this.getFileMd5(file);
      }
      if (!this.isAcceptingWrites()) {
        return false;
      }
      const entryKey = this.buildCacheKey(filePath, md5, sourceMtime);
      const outputMetadata = await this.getOutputMetadata(outputPath);
      if (!this.isAcceptingWrites()) {
        return false;
      }
      const now = Date.now();
      const previousEntry = this.cacheData.entries[entryKey];
      const previousTombstone = this.cacheData.tombstones?.[entryKey];
      const entry = this.setMutatedCacheEntry(entryKey, {
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
      });
      if (!await this.commitEntryMutation(entryKey, entry, previousEntry, previousTombstone, false)) {
        return false;
      }
      await this.compactPath(filePath);
      return true;
    } catch (error) {
      console.warn(getLogTag(this), "addToCache failed:", error);
      return false;
    }
  }
  async addCompressionArtifact(artifact: CompressionArtifactContext) {
    if (!this.isAcceptingWrites()) {
      return false;
    }
    const filePath = this.normalizeVaultPath(artifact.sourcePath);
    const outputPath = this.normalizeVaultPath(artifact.outputPath);
    if (!filePath || !outputPath) {
      throw new Error("Compression artifact contains an invalid Vault path");
    }
    const outputMetadata = await this.getOutputMetadata(outputPath);
    if (!outputMetadata) {
      throw new Error(`Compression output changed before cache commit: ${outputPath}`);
    }
    const outputSha256 = await this.ports.fs.runBufferedOperation(async (token) =>
      await this.ports.hash.fileSha256Hex(outputPath, token)
    );
    const verifiedOutputMetadata = await this.getOutputMetadata(outputPath);
    if (!verifiedOutputMetadata
      || this.normalizeMtime(verifiedOutputMetadata.outputMtime) !== this.normalizeMtime(outputMetadata.outputMtime)
      || outputSha256.toLowerCase() !== artifact.outputSha256.toLowerCase()) {
      throw new Error(`Compression output changed before cache commit: ${outputPath}`);
    }
    if (!this.isAcceptingWrites()) {
      return false;
    }
    const entryKey = this.buildCacheKey(filePath, artifact.sourceMd5, artifact.sourceMtime);
    const now = Date.now();
    const previousEntry = this.cacheData.entries[entryKey];
    const previousTombstone = this.cacheData.tombstones?.[entryKey];
    const entry = this.setMutatedCacheEntry(entryKey, {
      path: filePath,
      md5: artifact.sourceMd5,
      mtime: artifact.sourceMtime,
      timestamp: now,
      lastAccessMs: now,
      originalSize: artifact.sourceSize,
      sourceMtime: artifact.sourceMtime,
      sourceSize: artifact.sourceSize,
      sourceSha256: artifact.sourceSha256,
      state: "pending_move",
      stateUpdatedAt: now,
      pendingSince: now,
      outputPath,
      outputMtime: verifiedOutputMetadata.outputMtime,
      outputSize: artifact.outputSize,
      outputSha256: artifact.outputSha256,
      compressionSettingsKey: artifact.compressionSettingsKey
    });
    if (!await this.commitEntryMutation(entryKey, entry, previousEntry, previousTombstone)) {
      try {
        const cleanup = await this.ports.fs.removeFileIfUnchanged(outputPath, artifact.outputSha256);
        if (cleanup.retainedConflictPath) {
          console.warn(getLogTag(this), "Compression output changed while failed cache commit was cleaned up; newer output retained:", cleanup.retainedConflictPath);
        }
      } catch (error) {
        console.warn(getLogTag(this), "Failed compression output retained after cache commit failure:", outputPath, error);
      }
      return false;
    }
    await this.compactPath(filePath);
    return true;
  }
  async addSkippedEntry(filePath: string, skipReason: string, compressionSettingsKey: string | null = null) {
    if (!this.isAcceptingWrites()) {
      return false;
    }
    try {
      const normalizedPath = this.normalizeVaultPath(filePath);
      const file = getVaultFileByPath(this.app.vault, normalizedPath);
      if (!file)
        return false;
      let md5 = "";
      let sourceSha256: string;
      if (skipReason === "too_large") {
        try {
          sourceSha256 = await this.ports.fs.runBufferedOperation(async (token) =>
            await this.ports.hash.fileSha256Hex(file.path, token)
          );
        } catch (error) {
          console.warn(getLogTag(this), "Skipped entry cannot be content-bound and will not be cached:", normalizedPath, error);
          return false;
        }
      } else {
        const sourceBytes = new Uint8Array(await this.readFileBinaryForFingerprint(file));
        md5 = this.ports.hash.md5Hex(sourceBytes);
        sourceSha256 = this.ports.hash.sha256Hex(sourceBytes);
      }
      const normalizedFilePath = this.normalizeVaultPath(file.path);
      const cacheKey = this.buildCacheKey(normalizedFilePath, md5, file.stat.mtime);
      if (!this.isAcceptingWrites()) {
        return false;
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
        sourceSha256,
        ...(compressionSettingsKey ? { compressionSettingsKey } : {})
      };
      const previousEntry = this.cacheData.entries[cacheKey];
      const previousTombstone = this.cacheData.tombstones?.[cacheKey];
      this.setMutatedCacheEntry(cacheKey, entry);
      if (!await this.commitEntryMutation(cacheKey, entry, previousEntry, previousTombstone)) {
        return false;
      }
      await this.compactPath(normalizedFilePath);
      return true;
    } catch (error) {
      console.warn(getLogTag(this), "addSkippedEntry failed:", error);
      return false;
    }
  }
  async markProcessedFileMoved(
    filePath: string,
    processedStats: FileStatsLike,
    originalSize: number | null = null,
    outputPath: string | null = null,
    expectedIdentity: MoveCacheEntryIdentity | null = null
  ) {
    if (!this.isAcceptingWrites()) {
      return false;
    }
    try {
      const normalizedPath = this.normalizeVaultPath(filePath);
      const entries = this.getEntriesForPath(normalizedPath);
      let selectedEntry = expectedIdentity
        ? this.selectEntryForMoveByIdentity(entries, outputPath, expectedIdentity)
        : this.selectEntryForMove(entries, outputPath);
      if (expectedIdentity) {
        if (!selectedEntry || !await this.fileHashMatches(normalizedPath, expectedIdentity.outputSha256)) {
          return false;
        }
        selectedEntry = this.selectEntryForMoveByIdentity(this.getEntriesForPath(normalizedPath), outputPath, expectedIdentity);
        if (!selectedEntry) {
          return false;
        }
      }
      const processedMtime = this.resolveSourceMtime(processedStats?.mtimeMs, processedStats?.mtime);
      const processedSize = this.resolveSourceSize(null, processedStats?.size);
      if (processedMtime === null || processedSize === null) {
        console.warn(getLogTag(this), `Cannot mark moved file without processed mtime/size: ${normalizedPath}`);
        return false;
      }
      const existingEntry = (selectedEntry?.[1] || {});
      let md5 = existingEntry.md5 || "";
      let cacheKey = selectedEntry?.[0];
      if (!cacheKey) {
        md5 = await this.getFileMd5ByPath(normalizedPath);
        if (!md5) {
          console.error(getLogTag(this), "Cannot mark moved file without cache entry or md5:", normalizedPath);
          return false;
        }
        cacheKey = this.buildCacheKey(normalizedPath, md5, processedMtime);
      }
      if (!this.isAcceptingWrites()) {
        return false;
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
      const previousEntry = this.cacheData.entries[cacheKey];
      const previousTombstone = this.cacheData.tombstones?.[cacheKey];
      this.stampEntryMutation(movedEntry, previousEntry, previousTombstone);
      this.cacheData.entries[cacheKey] = movedEntry;
      delete this.cacheData.tombstones?.[cacheKey];
      if (!await this.commitEntryMutation(cacheKey, movedEntry, previousEntry, previousTombstone)) {
        return false;
      }
      await this.compactPath(normalizedPath);
      return true;
    } catch (error) {
      console.warn(getLogTag(this), "markProcessedFileMoved failed:", error);
      return false;
    }
  }
  async markProcessedFileSkippedIdentical(
    filePath: string,
    processedStats: FileStatsLike,
    originalSize: number | null = null,
    outputPath: string | null = null,
    expectedIdentity: MoveCacheEntryIdentity | null = null
  ) {
    if (!this.isAcceptingWrites()) {
      return false;
    }
    try {
      const normalizedPath = this.normalizeVaultPath(filePath);
      const entries = this.getEntriesForPath(normalizedPath);
      let selectedEntry = expectedIdentity
        ? this.selectEntryForMoveByIdentity(entries, outputPath, expectedIdentity)
        : this.selectEntryForMove(entries, outputPath);
      if (expectedIdentity) {
        if (!selectedEntry || !await this.fileHashMatches(normalizedPath, expectedIdentity.outputSha256)) {
          return false;
        }
        selectedEntry = this.selectEntryForMoveByIdentity(this.getEntriesForPath(normalizedPath), outputPath, expectedIdentity);
        if (!selectedEntry) {
          return false;
        }
      }
      const sourceMtime = this.resolveSourceMtime(processedStats?.mtimeMs, processedStats?.mtime);
      const sourceSize = this.resolveSourceSize(null, processedStats?.size) ?? this.resolveSourceSize(originalSize, null);
      if (sourceMtime === null || sourceSize === null) {
        console.warn(getLogTag(this), `Cannot mark identical skipped file without source mtime/size: ${normalizedPath}`);
        return false;
      }
      const existingEntry = (selectedEntry?.[1] || {});
      const normalizedOutputPath = this.normalizeVaultPath(outputPath || "");
      if (existingEntry.state === "pending_move"
        && normalizedOutputPath
        && vaultPathsEqual(this.getEntryOutputPath(existingEntry), normalizedOutputPath)
        && this.isSha256(existingEntry.sourceSha256)
        && this.isSha256(existingEntry.outputSha256)
        && existingEntry.sourceSha256.toLowerCase() !== existingEntry.outputSha256.toLowerCase()) {
        // The move service has proved that the current target is byte-identical
        // to this pending output. After restart that is a landed move, not an
        // originally-identical compression result; keep the pre-move cache key
        // and record current target metadata as the processed revision.
        return await this.markProcessedFileMoved(normalizedPath, processedStats, originalSize, normalizedOutputPath, expectedIdentity);
      }
      let md5 = existingEntry.md5 || "";
      let cacheKey = selectedEntry?.[0];
      if (!cacheKey) {
        md5 = await this.getFileMd5ByPath(normalizedPath);
        if (!md5) {
          console.error(getLogTag(this), "Cannot mark identical skipped file without cache entry or md5:", normalizedPath);
          return false;
        }
        cacheKey = this.buildCacheKey(normalizedPath, md5, sourceMtime);
      }
      if (!this.isAcceptingWrites()) {
        return false;
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
      const previousEntry = this.cacheData.entries[cacheKey];
      const previousTombstone = this.cacheData.tombstones?.[cacheKey];
      this.stampEntryMutation(skippedEntry, previousEntry, previousTombstone);
      this.cacheData.entries[cacheKey] = skippedEntry;
      delete this.cacheData.tombstones?.[cacheKey];
      if (!await this.commitEntryMutation(cacheKey, skippedEntry, previousEntry, previousTombstone)) {
        return false;
      }
      await this.compactPath(normalizedPath);
      return true;
    } catch (error) {
      console.warn(getLogTag(this), "markProcessedFileSkippedIdentical failed:", error);
      return false;
    }
  }
  async clearCache() {
    if (!this.isAcceptingWrites()) {
      return false;
    }
    this.cancelPendingSave();
    const removed: Array<{
      cacheKey: string;
      previousEntry: CacheEntry;
      previousTombstone: CacheMutationRevision | undefined;
      writtenTombstone: CacheMutationRevision;
    }> = [];
    for (const cacheKey of Object.keys(this.cacheData.entries)) {
      const previousEntry = this.cacheData.entries[cacheKey];
      if (!previousEntry) {
        continue;
      }
      const previousTombstone = this.cacheData.tombstones?.[cacheKey];
      const writtenTombstone = this.tombstoneCacheEntry(cacheKey);
      removed.push({ cacheKey, previousEntry, previousTombstone, writtenTombstone });
    }
    const committed = await this.saveCache({ mergeDiskEntries: false, authoritative: true });
    if (!committed) {
      for (const mutation of removed) {
        this.rollbackTombstoneMutationIfCurrent(
          mutation.cacheKey,
          mutation.previousEntry,
          mutation.previousTombstone,
          mutation.writtenTombstone
        );
      }
      return false;
    }
    return true;
  }
  getCacheStats() {
    const total = Object.keys(this.cacheData.entries).length;
    const size = JSON.stringify(this.cacheData).length;
    return { total, size };
  }
  // Cache backup naming, retention, and restore live in services/cache-backup-store.ts;
  // the thin delegators below keep the Cache API and instance-level test mocks stable.
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
    await this.backupStore.createBackup();
  }
  createBackupSync() {
    this.backupStore.createBackupSync();
  }
  async cleanupOldBackups(backupDir: string) {
    await this.backupStore.cleanupOldBackups(backupDir);
  }
  async cleanupRetainedFiles(directory: string, includeFile: (file: string) => boolean) {
    await this.backupStore.cleanupRetainedFiles(directory, includeFile);
  }
  isValidBackupFileName(fileName: string) {
    return this.backupStore.isValidBackupFileName(fileName);
  }
  async restoreFromBackup(backupFileName: string | null = null) {
    return await this.backupStore.restoreFromBackup(backupFileName);
  }
  async getAvailableBackups() {
    return await this.backupStore.getAvailableBackups();
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
  // Compaction decisions live in services/cache-compaction.ts; thin delegators keep the Cache API stable.
  async compactCache() {
    return await this.compaction.compactCache();
  }
  async compactPath(filePath: string) {
    try {
      return await this.compaction.compactPath(filePath);
    } catch (error) {
      console.warn(getLogTag(this), `Post-commit cache compaction failed for ${filePath}:`, error);
      return { removed: 0, missingFilesRemoved: 0, supersededRemoved: 0 };
    }
  }
  async compactDeletedPath(filePath: string) {
    return await this.compaction.compactDeletedPath(filePath);
  }
  getPendingMoveArtifacts(): Array<{ sourcePath: string; outputPath: string }> {
    const artifacts: Array<{ sourcePath: string; outputPath: string }> = [];
    const seenOutputs = new Set<string>();
    for (const [cacheKey, entry] of this.sortEntriesByTimestamp(this.getCachePathEntries())) {
      if (this.getCacheEntryState(entry) !== "pending_move") {
        continue;
      }
      const sourcePath = this.normalizeVaultPath(this.getEntryPath(cacheKey, entry));
      const outputPath = this.getEntryOutputPath(entry);
      if (!isSafeVaultRelativePath(sourcePath) || !isSafeVaultRelativePath(outputPath)) {
        continue;
      }
      if (!/^[a-f0-9]{64}$/i.test(entry.sourceSha256 || "") || !/^[a-f0-9]{64}$/i.test(entry.outputSha256 || "")) {
        continue;
      }
      const outputKey = normalizeVaultPathForComparison(outputPath);
      if (seenOutputs.has(outputKey)) {
        continue;
      }
      seenOutputs.add(outputKey);
      artifacts.push({ sourcePath, outputPath });
    }
    return artifacts;
  }
  async resolvePendingMoveEntry(file: PendingMoveIdentity, outputPath: string): Promise<{
    status: "none" | "match" | "landed" | "conflict";
    cacheKey?: string;
    entry?: CacheEntry;
  }> {
    const normalizedOutput = this.normalizeVaultPath(outputPath);
    const candidates = this.sortEntriesByTimestamp(this.getEntriesForPath(file.path)).filter(([, entry]) =>
      this.getCacheEntryState(entry) === "pending_move" && vaultPathsEqual(this.getEntryOutputPath(entry), normalizedOutput)
    );
    if (candidates.length === 0) {
      return { status: "none" };
    }
    for (const [cacheKey, entry] of candidates) {
      const sourceSha256 = entry.sourceSha256?.toLowerCase();
      const outputSha256 = entry.outputSha256?.toLowerCase();
      if (!this.isSha256(sourceSha256)
        || !this.isSha256(outputSha256)
        || !this.compaction.isModernCompactionEntry(entry)) {
        continue;
      }
      const currentSourceSha256 = file.sourceSha256.toLowerCase();
      const currentOutputSha256 = file.outputSha256.toLowerCase();
      if (sourceSha256 === currentSourceSha256
        && outputSha256 === currentOutputSha256
        && this.sourceMatchesCurrentFile(entry, file)) {
        return { status: "match", cacheKey, entry };
      }
      if (sourceSha256 !== outputSha256
        && outputSha256 === currentSourceSha256
        && outputSha256 === currentOutputSha256) {
        return { status: "landed", cacheKey, entry };
      }
    }
    return { status: "conflict" };
  }
}
