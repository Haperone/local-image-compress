import { getBrokenCacheFilePath, getCacheBackupPath as buildCacheBackupPath, isBrokenCacheFileName, isCacheBackupFileName, isValidCacheBackupFileName } from "../cache-file-names";
import { ConcurrencyLimiter } from "../concurrency-limiter";
import { getErrorCode, getLogTag, normalizeVaultPath, randomHexSuffix, randomHexSuffixSync, relativeFilesystemPath, resolveVaultDotSegments, stripWindowsLongPathPrefix, vaultBasename } from "../utils";
import type { BufferedOperationToken, FsStat } from "../platform/ports";
import type { Cache } from "../cache";

const CACHE_BACKUP_MAX_COUNT = 50;

// Canonical separator-normalized dot-resolved form for identity comparison of
// plugin-owned storage paths (replaces Node path.resolve equality checks).
function canonicalStoragePath(filePath: string): string {
  return resolveVaultDotSegments(normalizeVaultPath(stripWindowsLongPathPrefix(filePath)));
}

// Owns cache backup files: creation, retention cleanup, broken-copy retention, listing,
// and validated restore. The Cache keeps thin delegators for external callers and this
// store routes cross-cluster calls (createBackup during restore) back through the Cache
// so instance-level test mocks keep intercepting them.
export class CacheBackupStore {
  retainedFilesStatBatchSize: number;

  constructor(private readonly cache: Cache) {
    this.retainedFilesStatBatchSize = 1000;
  }
  private get fsPort() {
    return this.cache.ports.fs;
  }
  getBrokenCacheBackupPath() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const randomSuffix = randomHexSuffixSync();
    return getBrokenCacheFilePath(this.fsPort, this.cache.cacheBackupsDir, timestamp, randomSuffix);
  }
  getCacheBackupPath(randomSuffix: string, now = new Date()) {
    return buildCacheBackupPath(this.fsPort, this.cache.cacheBackupsDir, randomSuffix, now);
  }
  isCacheBackupFile(file: string) {
    return isCacheBackupFileName(file);
  }
  getCacheBackupCleanupDirs(backupDir: string) {
    return [
      this.fsPort.joinPath(backupDir, "broken"),
      this.fsPort.dirnamePath(this.cache.cacheFile)
    ];
  }
  async createBackup() {
    try {
      if (!await this.fsPort.exists(this.cache.cacheFile)) {
        return;
      }
      const randomSuffix = await randomHexSuffix();
      const { backupDir, backupFile } = this.getCacheBackupPath(randomSuffix);
      await this.fsPort.mkdir(backupDir);
      await this.fsPort.copyFile(this.cache.cacheFile, backupFile, { exclusive: true });
      await this.cleanupOldBackups(backupDir);
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") {
        console.warn(getLogTag(this.cache), "createBackup failed:", error);
      }
    }
  }
  createBackupSync() {
    try {
      const syncFs = this.cache.requireSyncFs();
      if (!syncFs.existsSync(this.cache.cacheFile)) {
        return;
      }
      const randomSuffix = randomHexSuffixSync();
      const { backupDir, backupFile } = this.getCacheBackupPath(randomSuffix);
      if (!syncFs.existsSync(backupDir)) {
        syncFs.mkdirSync(backupDir);
      }
      syncFs.copyFileSync(this.cache.cacheFile, backupFile, { exclusive: true });
      this.cleanupOldBackupsSync(backupDir);
    } catch (error) {
      console.warn(getLogTag(this.cache), "createBackup failed:", error);
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
  sortRetainedFiles<T extends { name: string; stat: FsStat }>(files: T[]) {
    return files.sort((left, right) => {
      const mtimeDiff = right.stat.mtimeMs - left.stat.mtimeMs;
      if (mtimeDiff !== 0) {
        return mtimeDiff;
      }
      return right.name.localeCompare(left.name);
    });
  }

  private statsMatch(left: FsStat, right: FsStat) {
    return left.isDirectory === right.isDirectory
      && left.size === right.size
      && left.mtimeMs === right.mtimeMs;
  }

  async cleanupRetainedFiles(directory: string, includeFile: (file: string) => boolean) {
    try {
      const entries = await this.fsPort.listEntries(directory).catch((error: unknown) => {
        if (getErrorCode(error) !== "ENOENT") {
          console.warn(getLogTag(this.cache), "cleanupRetainedFiles readdir failed:", error);
        }
        return [];
      });
      const statLimiter = new ConcurrencyLimiter(8);
      const stats: Array<{ name: string; path: string; stat: FsStat; sha256: string } | null> = [];
      const retainedEntries = entries.filter((entry) => entry.isFile && includeFile(entry.name));
      for (let index = 0; index < retainedEntries.length; index += this.retainedFilesStatBatchSize) {
        const batch = retainedEntries.slice(index, index + this.retainedFilesStatBatchSize);
        stats.push(...await Promise.all(batch.map((entry) => statLimiter.run(async () => {
            const entryPath = this.fsPort.joinPath(directory, entry.name);
            try {
              const entryStat = await this.fsPort.stat(entryPath);
              if (!entryStat) {
                return null;
              }
              const sha256 = await this.cache.ports.hash.fileSha256Hex(entryPath);
              const verifiedStat = await this.fsPort.stat(entryPath);
              if (!verifiedStat || !this.statsMatch(entryStat, verifiedStat)) {
                return null;
              }
              return {
                name: entry.name,
                path: entryPath,
                stat: verifiedStat,
                sha256
              };
            } catch (error) {
              console.warn(getLogTag(this.cache), "cleanupRetainedFiles stat failed:", error);
              return null;
            }
          }))));
        if (index + this.retainedFilesStatBatchSize < retainedEntries.length) {
          await this.cache.yieldToUi();
        }
      }
      const files = this.sortRetainedFiles(stats
        .filter((file): file is { name: string; path: string; stat: FsStat; sha256: string } => file !== null));
      const minRetentionMs = 7 * 24 * 60 * 60 * 1000;
      const now = Date.now();
      const filesToDelete = files.filter((file, index) => {
        if (index >= CACHE_BACKUP_MAX_COUNT) {
          return true;
        }
        if (index < 10) {
          return false;
        }
        return now - file.stat.mtimeMs > minRetentionMs;
      });
      const unlinkLimiter = new ConcurrencyLimiter(8);
      await Promise.all(filesToDelete.map((file) => unlinkLimiter.run(async () => {
        try {
          const result = await this.fsPort.removeFileIfUnchanged(file.path, file.sha256);
          if (result.retainedConflictPath) {
            console.warn(getLogTag(this.cache), "cleanupRetainedFiles conflict retained:", result.retainedConflictPath);
          }
        } catch (error) {
          if (getErrorCode(error) !== "ENOENT") {
            console.warn(getLogTag(this.cache), "cleanupRetainedFiles unlink failed:", error);
          }
        }
      })));
    } catch (error) {
      console.warn(getLogTag(this.cache), "cleanupRetainedFiles failed:", error);
    }
  }
  cleanupRetainedFilesSync(directory: string, includeFile: (file: string) => boolean) {
    try {
      const syncFs = this.cache.requireSyncFs();
      if (!syncFs.existsSync(directory)) {
        return;
      }
      const files: Array<{ name: string; path: string; stat: FsStat }> = [];
      for (const entry of syncFs.listEntriesSync(directory)) {
        if (!entry.isFile || !includeFile(entry.name)) {
          continue;
        }
        const entryPath = this.fsPort.joinPath(directory, entry.name);
        const entryStat = syncFs.statSync(entryPath);
        if (entryStat) {
          files.push({ name: entry.name, path: entryPath, stat: entryStat });
        }
      }
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
        return now - file.stat.mtimeMs > minRetentionMs;
      });
      // The sync port cannot bind deletion to the stat-observed revision.
      // The normal async retention pass safely removes these files later.
      void filesToDelete;
    } catch (error) {
      console.warn(getLogTag(this.cache), "cleanupRetainedFiles failed:", error);
    }
  }
  isValidBackupFileName(fileName: string) {
    return isValidCacheBackupFileName(fileName);
  }
  isPathWithinDirectory(candidatePath: string, directoryPath: string, allowDirectoryItself = false) {
    const relativePath = relativeFilesystemPath(canonicalStoragePath(directoryPath), canonicalStoragePath(candidatePath));
    if (allowDirectoryItself && relativePath === "") {
      return true;
    }
    return Boolean(relativePath) && !relativePath.startsWith("..");
  }
  validateBackupStoragePathForRestore(backupFile: string, backupDir: string) {
    const resolvedBackup = canonicalStoragePath(backupFile);
    const resolvedDir = canonicalStoragePath(backupDir);
    const expectedBackupDir = canonicalStoragePath(this.cache.cacheBackupsDir);
    if (resolvedDir !== expectedBackupDir) {
      throw new Error(`Unexpected backup directory: ${vaultBasename(backupDir)}`);
    }
    if (!this.isPathWithinDirectory(resolvedBackup, resolvedDir)) {
      throw new Error(`Backup path escapes backupDir: ${vaultBasename(backupFile)}`);
    }
  }
  async validateBackupPathForRestore(backupFile: string, backupDir: string) {
    this.validateBackupStoragePathForRestore(backupFile, backupDir);
    const probe = this.requireRestoreProbe();
    const backupStorageRoot = this.fsPort.dirnamePath(this.cache.cacheBackupsDir);
    const realBackupStorageRoot = await probe.realpath(backupStorageRoot);
    const realBackupDir = await probe.realpath(backupDir);
    const realBackup = await probe.realpath(backupFile);
    if (!this.isPathWithinDirectory(realBackupDir, realBackupStorageRoot)) {
      throw new Error(`Backup directory escapes backup storage: ${vaultBasename(backupDir)}`);
    }
    if (!this.isPathWithinDirectory(realBackup, realBackupDir)) {
      throw new Error(`Backup file resolves outside backupDir: ${vaultBasename(backupFile)}`);
    }
    return realBackup;
  }
  // Desktop additionally proves realpath/inode identity. Mobile never reaches
  // this helper: its adapter sandbox and atomic process callback are the trust boundary.
  private requireRestoreProbe() {
    const probe = this.fsPort.restoreProbe;
    if (!probe) {
      throw new Error("Hardened cache restore is unavailable on this platform");
    }
    return probe;
  }
  async copyBackupHandleToStage(backupFile: string, backupDir: string, stagedFile: string) {
    const probe = this.requireRestoreProbe();
    const lstatBeforeOpen = await probe.lstatIdentity(backupFile);
    if (lstatBeforeOpen.isSymbolicLink || !lstatBeforeOpen.isFile) {
      throw new Error(`Backup is not a regular file: ${vaultBasename(backupFile)}`);
    }
    await probe.copyViaHandle(backupFile, stagedFile, {
      afterOpen: async () => async () => undefined,
      afterStat: async (handleStat) => {
        if (!handleStat.isFile) {
          throw new Error(`Backup handle is not a regular file: ${vaultBasename(backupFile)}`);
        }
        const realBackup = await this.validateBackupPathForRestore(backupFile, backupDir);
        const lstatAfterValidation = await probe.lstatIdentity(backupFile);
        if (lstatAfterValidation.isSymbolicLink || !lstatAfterValidation.isFile) {
          throw new Error(`Backup changed during validation: ${vaultBasename(backupFile)}`);
        }
        if (lstatAfterValidation.dev !== handleStat.dev || lstatAfterValidation.ino !== handleStat.ino) {
          throw new Error(`Backup changed during validation: ${vaultBasename(backupFile)}`);
        }
        const finalRealBackup = await probe.realpath(backupFile);
        if (finalRealBackup !== realBackup) {
          throw new Error(`Backup real path changed during validation: ${vaultBasename(backupFile)}`);
        }
      }
    });
  }
  private async readBoundedRestoreText(filePath: string, label: string, bufferedOperationToken?: BufferedOperationToken) {
    return await this.fsPort.runBufferedOperation(async (token) => {
      const limit = this.cache.ports.runtime.maxBufferedFileBytes;
      const stat = await this.fsPort.stat(filePath);
      if (!stat || stat.isDirectory) {
        throw new Error(`${label} is not a file: ${vaultBasename(filePath)}`);
      }
      if (limit !== null && stat.size > limit) {
        throw new Error(`${label} exceeds the platform buffered-file limit: ${vaultBasename(filePath)}`);
      }
      return await this.fsPort.readText(filePath, token);
    }, bufferedOperationToken);
  }
  private validateRestorePayload(payload: string, label: string) {
    const parsed: unknown = JSON.parse(payload);
    if (!this.cache.isPlainRecord(parsed) || !this.cache.isPlainRecord(parsed["entries"])) {
      throw new Error(`${label} has an invalid cache structure`);
    }
    for (const entry of Object.values(parsed["entries"])) {
      if (!this.cache.isPlainRecord(entry)) {
        throw new Error(`${label} contains an invalid cache entry`);
      }
    }
  }
  private async copyCurrentCacheToSafetyBackup(backupFile: string, bufferedOperationToken?: BufferedOperationToken) {
    const probe = this.fsPort.restoreProbe;
    if (!probe) {
      await this.fsPort.copyFile(this.cache.cacheFile, backupFile, bufferedOperationToken
        ? { exclusive: true, bufferedOperationToken }
        : { exclusive: true });
      return;
    }
    const beforeOpen = await probe.lstatIdentity(this.cache.cacheFile);
    if (!beforeOpen.isFile || beforeOpen.isSymbolicLink) {
      throw new Error("Current cache is not a regular file; refusing safety backup");
    }
    await probe.copyViaHandle(this.cache.cacheFile, backupFile, {
      afterOpen: async () => async () => undefined,
      afterStat: async (handleStat) => {
        const afterOpen = await probe.lstatIdentity(this.cache.cacheFile);
        if (!handleStat.isFile || !afterOpen.isFile || afterOpen.isSymbolicLink
          || beforeOpen.dev !== handleStat.dev || beforeOpen.ino !== handleStat.ino
          || afterOpen.dev !== handleStat.dev || afterOpen.ino !== handleStat.ino) {
          throw new Error("Current cache changed while the safety backup was opened");
        }
      }
    });
  }
  private async createVerifiedRestoreSafetyBackup(bufferedOperationToken?: BufferedOperationToken) {
    if (!await this.fsPort.exists(this.cache.cacheFile)) {
      throw new Error("Cannot restore cache without a safety backup of the current cache");
    }
    const randomSuffix = await randomHexSuffix();
    const { backupDir, backupFile } = this.getCacheBackupPath(randomSuffix);
    await this.fsPort.mkdir(backupDir);
    let copied = false;
    let copiedSha256: string | null = null;
    try {
      await this.copyCurrentCacheToSafetyBackup(backupFile, bufferedOperationToken);
      copied = true;
      copiedSha256 = await this.cache.ports.hash.fileSha256Hex(backupFile, bufferedOperationToken);
      if (!await this.fsPort.compareFileContents(this.cache.cacheFile, backupFile, bufferedOperationToken)) {
        throw new Error("Restore safety backup does not match the current cache");
      }
      const payload = await this.readBoundedRestoreText(backupFile, "Restore safety backup", bufferedOperationToken);
      return { backupDir, backupFile, payload, sha256: copiedSha256 };
    } catch (error) {
      if (copied && copiedSha256) {
        try {
          await this.fsPort.removeFileIfUnchanged(backupFile, copiedSha256, bufferedOperationToken);
        } catch (cleanupError) {
          console.warn(getLogTag(this.cache), "Failed restore safety-backup cleanup:", cleanupError);
        }
      }
      throw error;
    }
  }
  private async rollbackMobileRestore(
    processTextAtomically: NonNullable<typeof this.fsPort.processTextAtomically>,
    restoredPayload: string,
    safetyPayload: string
  ) {
    let rollbackApplied = false;
    const rollbackResult = await processTextAtomically(this.cache.cacheFile, safetyPayload, (currentPayload) => {
      if (currentPayload !== restoredPayload) {
        return currentPayload;
      }
      rollbackApplied = true;
      return safetyPayload;
    });
    if (!rollbackApplied) {
      return false;
    }
    if (rollbackResult !== safetyPayload) {
      throw new Error("Cache rollback result does not match the safety backup");
    }
    const rollbackReadback = await this.readBoundedRestoreText(this.cache.cacheFile, "Cache rollback readback");
    if (rollbackReadback !== safetyPayload) {
      throw new Error("Cache rollback readback does not match the safety backup");
    }
    return true;
  }
  private async restoreMobileBackup(
    processTextAtomically: NonNullable<typeof this.fsPort.processTextAtomically>,
    restoredPayload: string,
    safetyPayload: string
  ) {
    let restoreApplied = false;
    let cacheChangedBeforeRestore = false;
    try {
      const restoreResult = await processTextAtomically(this.cache.cacheFile, safetyPayload, (currentPayload) => {
        if (currentPayload !== safetyPayload) {
          cacheChangedBeforeRestore = true;
          return currentPayload;
        }
        restoreApplied = true;
        return restoredPayload;
      });
      if (cacheChangedBeforeRestore || !restoreApplied) {
        throw new Error("Cache changed after the restore safety backup was created");
      }
      if (restoreResult !== restoredPayload) {
        throw new Error("Atomic cache restore result does not match the selected backup");
      }
      const restoreReadback = await this.readBoundedRestoreText(this.cache.cacheFile, "Cache restore readback");
      this.validateRestorePayload(restoreReadback, "Cache restore readback");
      if (restoreReadback !== restoredPayload) {
        throw new Error("Cache restore readback does not match the selected backup");
      }
      await this.cache.loadCache();
      if (this.cache.lastLoadError !== null) {
        throw new Error("Restored cache failed to load");
      }
    } catch (error) {
      if (restoreApplied) {
        try {
          await this.rollbackMobileRestore(processTextAtomically, restoredPayload, safetyPayload);
          await this.cache.loadCache();
          if (this.cache.lastLoadError !== null) {
            throw new Error("Cache rollback payload failed to load");
          }
        } catch (rollbackError) {
          throw new Error(`Cache restore failed and rollback could not be verified: ${String(error)}; ${String(rollbackError)}`);
        }
      }
      throw error;
    }
  }
  private async cleanupOwnedRestoreStage(stagedFile: string, expectedSha256: string | null) {
    try {
      const sha256 = expectedSha256 || await this.cache.ports.hash.fileSha256Hex(stagedFile);
      const result = await this.fsPort.removeFileIfUnchanged(stagedFile, sha256);
      if (result.retainedConflictPath) {
        console.warn(getLogTag(this.cache), "Restore stage cleanup conflict retained:", result.retainedConflictPath);
      }
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") {
        console.warn(getLogTag(this.cache), "Restore stage cleanup failed:", error);
      }
    }
  }
  private async createDesktopRestoreStage(backupFile: string, backupDir: string) {
    const stagedFile = `${this.cache.cacheFile}.tinylocal-recovery-${Date.now()}-${await randomHexSuffix(16)}.tmp`;
    let stagedSha256: string | null = null;
    try {
      await this.copyBackupHandleToStage(backupFile, backupDir, stagedFile);
      const payload = await this.readBoundedRestoreText(stagedFile, "Selected cache backup stage");
      this.validateRestorePayload(payload, "Selected cache backup stage");
      stagedSha256 = await this.cache.ports.hash.fileSha256Hex(stagedFile);
      return { stagedFile, stagedSha256, payload };
    } catch (error) {
      if (await this.fsPort.exists(stagedFile)) {
        await this.cleanupOwnedRestoreStage(stagedFile, stagedSha256);
      }
      throw error;
    }
  }
  private async rollbackDesktopRestore(restoredSha256: string, safetyBackup: { backupFile: string; payload: string; sha256: string }) {
    const rollbackStage = `${this.cache.cacheFile}.tinylocal-recovery-${Date.now()}-${await randomHexSuffix(16)}.tmp`;
    let rollbackStageSha256: string | null = null;
    try {
      await this.fsPort.copyFile(safetyBackup.backupFile, rollbackStage, { exclusive: true });
      rollbackStageSha256 = await this.cache.ports.hash.fileSha256Hex(rollbackStage);
      if (rollbackStageSha256 !== safetyBackup.sha256) {
        throw new Error("Cache rollback stage does not match the safety backup");
      }
      const lock = await this.cache.acquireCacheWriteLock();
      if (!lock) {
        throw new Error("Could not acquire cache write lock for rollback");
      }
      try {
        await this.fsPort.replaceFile(rollbackStage, this.cache.cacheFile, {
          expectedTargetSha256: restoredSha256,
          allowMissingTarget: true,
          expectedStagedSha256: rollbackStageSha256
        });
        rollbackStageSha256 = null;
        const readback = await this.readBoundedRestoreText(this.cache.cacheFile, "Cache rollback readback");
        if (readback !== safetyBackup.payload) {
          throw new Error("Cache rollback readback does not match the safety backup");
        }
      } finally {
        await this.cache.releaseCacheWriteLock(lock);
      }
      await this.cache.loadCache();
      if (this.cache.lastLoadError !== null) {
        throw new Error("Cache rollback payload failed to load");
      }
    } finally {
      if (await this.fsPort.exists(rollbackStage)) {
        await this.cleanupOwnedRestoreStage(rollbackStage, rollbackStageSha256);
      }
    }
  }
  private async restoreDesktopBackup(backupFile: string, backupDir: string) {
    const staged = await this.createDesktopRestoreStage(backupFile, backupDir);
    let stageConsumed = false;
    let safetyBackup: Awaited<ReturnType<CacheBackupStore["createVerifiedRestoreSafetyBackup"]>> | null = null;
    let restoreApplied = false;
    try {
      const lock = await this.cache.acquireCacheWriteLock();
      if (!lock) {
        throw new Error("Could not acquire cache write lock for restore");
      }
      try {
        const cacheIdentity = await this.requireRestoreProbe().lstatIdentity(this.cache.cacheFile);
        if (!cacheIdentity.isFile || cacheIdentity.isSymbolicLink) {
          throw new Error("Current cache is not a regular file; refusing restore");
        }
        safetyBackup = await this.createVerifiedRestoreSafetyBackup();
        await this.fsPort.replaceFile(staged.stagedFile, this.cache.cacheFile, {
          expectedTargetSha256: safetyBackup.sha256,
          expectedStagedSha256: staged.stagedSha256
        });
        stageConsumed = true;
        restoreApplied = true;
        const readback = await this.readBoundedRestoreText(this.cache.cacheFile, "Cache restore readback");
        this.validateRestorePayload(readback, "Cache restore readback");
        if (readback !== staged.payload) {
          throw new Error("Cache restore readback does not match the selected backup stage");
        }
      } finally {
        await this.cache.releaseCacheWriteLock(lock);
      }
      await this.cache.loadCache();
      if (this.cache.lastLoadError !== null) {
        throw new Error("Restored cache failed to load");
      }
    } catch (error) {
      if (restoreApplied && safetyBackup) {
        try {
          await this.rollbackDesktopRestore(staged.stagedSha256, safetyBackup);
        } catch (rollbackError) {
          throw new Error(`Cache restore failed and rollback could not be verified: ${String(error)}; ${String(rollbackError)}`);
        }
      }
      throw error;
    } finally {
      if (!stageConsumed && await this.fsPort.exists(staged.stagedFile)) {
        await this.cleanupOwnedRestoreStage(staged.stagedFile, staged.stagedSha256);
      }
      if (safetyBackup) {
        await this.cleanupOldBackups(safetyBackup.backupDir);
      }
    }
  }
  async restoreFromBackup(backupFileName: string | null = null) {
    try {
      const backupDir = this.cache.cacheBackupsDir;
      let backupFile: string;
      if (backupFileName) {
        const safeBackupName = String(backupFileName);
        if (!this.isValidBackupFileName(safeBackupName)) {
          throw new Error(`Invalid backup filename: ${safeBackupName}`);
        }
        backupFile = this.fsPort.joinPath(backupDir, backupFileName);
      } else {
        const backupEntries = await this.fsPort.listEntries(backupDir);
        const files = (await Promise.all(
          backupEntries
            .filter((entry) => entry.isFile && this.isValidBackupFileName(entry.name))
            .map(async (entry) => {
              const entryPath = this.fsPort.joinPath(backupDir, entry.name);
              const entryStat = await this.fsPort.stat(entryPath);
              if (!entryStat) {
                throw new Error(`Backup disappeared during listing: ${entry.name}`);
              }
              return {
                name: entry.name,
                path: entryPath,
                stat: entryStat
              };
            })
        )).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
        if (files.length === 0) {
          return false;
        }
        const latestBackup = files[0];
        if (!latestBackup) {
          return false;
        }
        backupFile = latestBackup.path;
      }
      if (!await this.fsPort.exists(backupFile)) {
        return false;
      }
      const processTextAtomically = this.fsPort.processTextAtomically;
      if (!processTextAtomically) {
        const cacheIdentity = await this.requireRestoreProbe().lstatIdentity(this.cache.cacheFile);
        if (!cacheIdentity.isFile || cacheIdentity.isSymbolicLink) {
          throw new Error("Current cache is not a regular file; refusing restore");
        }
      }
      await this.cache.flushPendingCacheSave();
      if (processTextAtomically) {
        this.validateBackupStoragePathForRestore(backupFile, backupDir);
        const restoredPayload = await this.readBoundedRestoreText(backupFile, "Selected cache backup");
        this.validateRestorePayload(restoredPayload, "Selected cache backup");
        const safetyBackup = await this.createVerifiedRestoreSafetyBackup();
        await this.restoreMobileBackup(processTextAtomically, restoredPayload, safetyBackup.payload);
        await this.cleanupOldBackups(safetyBackup.backupDir);
      } else {
        await this.restoreDesktopBackup(backupFile, backupDir);
      }
      return true;
    } catch (error) {
      console.error(getLogTag(this.cache), "Backup restore error:", error);
      return false;
    }
  }
  async getAvailableBackups() {
    try {
      const backupDir = this.cache.cacheBackupsDir;
      const backups = await this.fsPort.listNames(backupDir).catch((error: unknown) => {
        if (getErrorCode(error) !== "ENOENT") {
          console.warn(getLogTag(this.cache), "getAvailableBackups readdir failed:", error);
        }
        return [] as string[];
      });
      return backups
        .filter((file) => isCacheBackupFileName(file))
        .sort()
        .reverse();
    } catch (error) {
      console.warn(getLogTag(this.cache), "getAvailableBackups failed:", error);
      return [];
    }
  }
}
