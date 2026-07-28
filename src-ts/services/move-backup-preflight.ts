import * as obsidian from "obsidian";
import { t } from "../i18n";
import { ConcurrencyLimiter } from "../concurrency-limiter";
import { getErrorCode, getLogTag, getPluginName, isAbsoluteFilesystemPath, normalizeVaultPath, randomHexSuffix } from "../utils";
import type { default as LocalImageCompressPlugin } from "../plugin";
import type { CompressedFileRecord } from "../move-service";

export type BackupPreflightTask = {
  compressedFile: CompressedFileRecord;
  skipped: boolean;
  reconciled?: boolean;
  failed?: boolean;
  originalPath?: string;
  backupFilePath?: string;
  compressedBackupPath?: string;
  originalSize?: number;
  originalMtimeMs?: number;
  originalSha256?: string;
  compressedSize?: number;
  compressedMtimeMs?: number;
  compressedSha256?: string;
  ownedBackupFiles?: Array<{ path: string; sha256: string }>;
};

type CompleteBackupPreflightTask = BackupPreflightTask & {
  skipped: false;
  originalPath: string;
  backupFilePath: string;
  compressedBackupPath: string;
  originalSize: number;
  originalMtimeMs: number;
  originalSha256: string;
  compressedSize: number;
  compressedMtimeMs: number;
  compressedSha256: string;
};

// Owns the pre-move backup preflight: hashing originals/compressed outputs, backing both
// up into a timestamped directory, and verifying the copies (H1 phases 1-3). MoveService
// keeps a thin delegator and this service routes cross-cluster calls (retention, lookup,
// unload checks) back through plugin.moveService so instance-level test mocks keep working.
export class MoveBackupPreflight {
  constructor(private readonly plugin: LocalImageCompressPlugin) {}

  skipForUnload(compressedFile: CompressedFileRecord) {
    compressedFile.moveSkipReason = this.plugin.moveService.getMoveText("move.skip.unloading");
    return { compressedFile, skipped: true };
  }

  isCompleteBackupTask(task: BackupPreflightTask): task is CompleteBackupPreflightTask {
    return task.skipped === false &&
      typeof task.originalPath === "string" &&
      task.originalPath.length > 0 &&
      typeof task.backupFilePath === "string" &&
      task.backupFilePath.length > 0 &&
      typeof task.compressedBackupPath === "string" &&
      task.compressedBackupPath.length > 0 &&
      typeof task.originalSize === "number" &&
      Number.isFinite(task.originalSize) &&
      typeof task.originalMtimeMs === "number" &&
      Number.isFinite(task.originalMtimeMs) &&
      typeof task.originalSha256 === "string" &&
      task.originalSha256.length > 0 &&
      typeof task.compressedSize === "number" &&
      Number.isFinite(task.compressedSize) &&
      typeof task.compressedMtimeMs === "number" &&
      Number.isFinite(task.compressedMtimeMs) &&
      typeof task.compressedSha256 === "string" &&
      task.compressedSha256.length > 0;
  }

  private async runBufferedPair<T, U>(left: () => Promise<T>, right: () => Promise<U>): Promise<[T, U]> {
    if (this.plugin.getPlatformPorts().fs.sync === null) {
      return [await left(), await right()];
    }
    return await Promise.all([left(), right()]);
  }

  private async runCopyPair(left: () => Promise<void>, right: () => Promise<void>): Promise<void> {
    if (this.plugin.getPlatformPorts().fs.sync === null) {
      await left();
      await right();
      return;
    }
    const results = await Promise.allSettled([left(), right()]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) {
      throw failure.reason;
    }
  }

  async createBackupBeforeMove(compressedFiles: CompressedFileRecord[]) {
    const moveService = this.plugin.moveService;
    const result = {
      backupCreated: false,
      files: [] as CompressedFileRecord[],
      skippedCount: 0,
      errorCount: 0,
      reconciledCount: 0
    };
    try {
      if (moveService.isUnloading()) {
        for (const compressedFile of compressedFiles) {
          compressedFile.moveSkipReason = moveService.getMoveText("move.skip.unloading");
        }
        result.skippedCount = compressedFiles.length;
        return result;
      }
      const ports = this.plugin.getPlatformPorts();
      const backupDir = this.plugin.getBackupStoragePaths().originalFilesBackups;
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const randomSuffix = await randomHexSuffix(16);
      const backupPath = ports.fs.joinPath(backupDir, `backup-${timestamp}-${randomSuffix}`);

      const prepassLimiter = new ConcurrencyLimiter(moveService.getIOConcurrency());
      const tasks = await Promise.all(compressedFiles.map((compressedFile) => prepassLimiter.run(async (): Promise<BackupPreflightTask> => {
        if (moveService.isUnloading()) {
          return this.skipForUnload(compressedFile);
        }
        const originalPath = compressedFile.originalPath || await moveService.findOriginalFileForCompressed(compressedFile);
        if (moveService.isUnloading()) {
          return this.skipForUnload(compressedFile);
        }
        if (!originalPath) {
          compressedFile.moveSkipReason = moveService.getMoveText("move.skip.originalMissingBeforeBackup");
          return { compressedFile, skipped: true };
        }
        if (await moveService.pathsReferToSameFile(compressedFile.compressedPath, originalPath)) {
          compressedFile.moveSkipReason = moveService.getMoveText("move.skip.selfMove");
          return { compressedFile, skipped: true };
        }
        const [originalStats, compressedStats] = await Promise.all([
          ports.fs.stat(originalPath).catch(() => null),
          ports.fs.stat(compressedFile.compressedPath).catch(() => null)
        ]);
        if (moveService.isUnloading()) {
          return this.skipForUnload(compressedFile);
        }
        if (!originalStats) {
          compressedFile.moveSkipReason = moveService.getMoveText("move.skip.originalMissingBeforeBackup");
          return { compressedFile, skipped: true };
        }
        if (!compressedStats) {
          compressedFile.moveSkipReason = moveService.getMoveText("move.skip.compressedMissingBeforeBackup");
          return { compressedFile, skipped: true };
        }
        const relativeToVault = moveService.toVaultRelativeSafe(originalPath);
        const compressedRelativePath = moveService.toVaultRelativeSafe(compressedFile.compressedPath);
        // Defensive: originals/compressed are expected inside the vault (allowed roots). Refuse to
        // back up a path that escapes the vault root, so an edge/crafted path cannot traverse out of
        // the timestamped backup directory.
        const pathEscapesVault = (relativePath: string) =>
          isAbsoluteFilesystemPath(relativePath) || relativePath.split(/[\\/]/).some((segment) => segment === "..");
        if (pathEscapesVault(relativeToVault) || pathEscapesVault(compressedRelativePath)) {
          compressedFile.moveSkipReason = moveService.getMoveText("move.skip.originalMissingBeforeBackup");
          return { compressedFile, skipped: true };
        }
        const [originalSha256, compressedSha256] = await this.runBufferedPair(
          () => ports.hash.fileSha256Hex(originalPath),
          () => ports.hash.fileSha256Hex(compressedFile.compressedPath)
        );
        if (moveService.isUnloading()) {
          return this.skipForUnload(compressedFile);
        }
        const pendingMove = await this.plugin.cache.resolvePendingMoveEntry({
          path: normalizeVaultPath(relativeToVault),
          stat: { mtime: originalStats.mtimeMs, size: originalStats.size },
          sourceSha256: originalSha256,
          outputSha256: compressedSha256
        }, normalizeVaultPath(compressedRelativePath));
        if (pendingMove.status === "landed") {
          const cacheKey = pendingMove.cacheKey;
          const outputSha256 = pendingMove.entry?.outputSha256;
          const currentStats = await ports.fs.stat(originalPath);
          if (!cacheKey || !outputSha256 || !currentStats) {
            return { compressedFile, skipped: false, failed: true };
          }
          const committed = await this.plugin.cache.markProcessedFileMoved(
            relativeToVault,
            currentStats,
            pendingMove.entry?.originalSize ?? originalStats.size,
            compressedRelativePath,
            { cacheKey, outputSha256 }
          );
          if (!committed) {
            return { compressedFile, skipped: false, failed: true };
          }
          try {
            const cleanup = await ports.fs.removeFileIfUnchanged(compressedFile.compressedPath, outputSha256);
            if (cleanup.retainedConflictPath) {
              console.warn(getLogTag(this.plugin), "Landed-move duplicate changed during cleanup; newer output retained:", cleanup.retainedConflictPath);
            }
          } catch (error) {
            if (getErrorCode(error) !== "ENOENT") {
              console.warn(getLogTag(this.plugin), `Landed-move duplicate cleanup failed for ${compressedFile.name}:`, error);
            }
          }
          await this.plugin.cache.compactPath(relativeToVault);
          return { compressedFile, skipped: false, reconciled: true };
        }
        if (pendingMove.status !== "match") {
          compressedFile.moveSkipReason = moveService.getMoveText("move.skip.externalModification");
          return { compressedFile, skipped: true };
        }
        const trustedCompressedSize = Number(pendingMove.entry?.outputSize);
        if (!Number.isFinite(trustedCompressedSize) || trustedCompressedSize < 0) {
          compressedFile.moveSkipReason = moveService.getMoveText("move.skip.externalModification");
          return { compressedFile, skipped: true };
        }
        if (pendingMove.cacheKey && pendingMove.entry?.outputSha256) {
          compressedFile.cacheEntryKey = pendingMove.cacheKey;
          compressedFile.cacheEntryOutputSha256 = pendingMove.entry.outputSha256;
        }
        compressedFile.size = trustedCompressedSize;
        return {
          compressedFile,
          originalPath,
          skipped: false,
          backupFilePath: ports.fs.joinPath(backupPath, "originals", relativeToVault),
          compressedBackupPath: ports.fs.joinPath(backupPath, "compressed", compressedRelativePath),
          originalSize: originalStats.size,
          originalMtimeMs: originalStats.mtimeMs,
          originalSha256,
          compressedSize: trustedCompressedSize,
          compressedMtimeMs: compressedStats.mtimeMs,
          compressedSha256
        };
      })));

      const backupDirs = new Set<string>();
      for (const task of tasks) {
        if (this.isCompleteBackupTask(task)) {
          backupDirs.add(ports.fs.dirnamePath(task.backupFilePath));
          backupDirs.add(ports.fs.dirnamePath(task.compressedBackupPath));
        }
      }
      await Promise.all(Array.from(backupDirs).map((dir) => ports.fs.mkdir(dir)));

      const limiter = new ConcurrencyLimiter(moveService.getIOConcurrency());
      await Promise.all(tasks.map((task) => limiter.run(async () => {
        const compressedFile = task.compressedFile;
        if (task.reconciled) {
          result.reconciledCount++;
          return;
        }
        if (task.failed) {
          result.errorCount++;
          return;
        }
        if (task.skipped) {
          result.skippedCount++;
          return;
        }
        if (!this.isCompleteBackupTask(task)) {
          compressedFile.moveSkipReason = moveService.getMoveText("move.skip.invalidBackupTask");
          result.errorCount++;
          console.error(getLogTag(this.plugin), "Invalid backup task; missing required paths or metadata:", {
            name: compressedFile.name,
            hasOriginalPath: Boolean(task.originalPath),
            hasBackupFilePath: Boolean(task.backupFilePath),
            hasCompressedBackupPath: Boolean(task.compressedBackupPath)
          });
          return;
        }
        try {
          const [currentOriginalStats, currentCompressedStats] = await Promise.all([
            ports.fs.stat(task.originalPath),
            ports.fs.stat(compressedFile.compressedPath)
          ]);
          if (!currentOriginalStats || !currentCompressedStats) {
            throw new Error(`Backup source disappeared before copy: ${compressedFile.name}`);
          }
          if (currentOriginalStats.size !== task.originalSize || currentOriginalStats.mtimeMs !== task.originalMtimeMs) {
            compressedFile.moveSkipReason = moveService.getMoveText("move.skip.originalModifiedDuringBackup");
            result.skippedCount++;
            return;
          }
          if (currentCompressedStats.mtimeMs !== task.compressedMtimeMs) {
            compressedFile.moveSkipReason = moveService.getMoveText("move.skip.compressedModifiedDuringBackup");
            result.skippedCount++;
            return;
          }
          const [currentOriginalSha256, currentCompressedSha256] = await this.runBufferedPair(
            () => ports.hash.fileSha256Hex(task.originalPath),
            () => ports.hash.fileSha256Hex(compressedFile.compressedPath)
          );
          if (currentOriginalSha256 !== task.originalSha256) {
            compressedFile.moveSkipReason = moveService.getMoveText("move.skip.originalContentChangedDuringBackup");
            result.skippedCount++;
            return;
          }
          if (currentCompressedSha256 !== task.compressedSha256) {
            compressedFile.moveSkipReason = moveService.getMoveText("move.skip.compressedContentChangedDuringBackup");
            result.skippedCount++;
            return;
          }
          task.ownedBackupFiles = [];
          await this.runCopyPair(
            async () => {
              await ports.fs.copyFile(task.originalPath, task.backupFilePath, { exclusive: true });
              task.ownedBackupFiles?.push({ path: task.backupFilePath, sha256: task.originalSha256 });
            },
            async () => {
              await ports.fs.copyFile(compressedFile.compressedPath, task.compressedBackupPath, { exclusive: true });
              task.ownedBackupFiles?.push({ path: task.compressedBackupPath, sha256: task.compressedSha256 });
            }
          );
          const [backupOriginalSha256, backupCompressedSha256] = await this.runBufferedPair(
            () => ports.hash.fileSha256Hex(task.backupFilePath),
            () => ports.hash.fileSha256Hex(task.compressedBackupPath)
          );
          if (backupOriginalSha256 !== task.originalSha256 || backupCompressedSha256 !== task.compressedSha256) {
            await this.cleanupBackupTaskFiles(task);
            compressedFile.moveSkipReason = moveService.getMoveText("move.skip.contentChangedDuringCopy");
            result.skippedCount++;
            return;
          }
          compressedFile.originalPath = task.originalPath;
          // BR-H1: carry the backup-verified content hash so the destructive overwrite
          // (moveSingleFile) can re-verify content, not just byte length.
          compressedFile.compressedSha256 = task.compressedSha256;
          compressedFile.originalSizeBeforeMove = task.originalSize;
          compressedFile.originalMtimeMsBeforeMove = task.originalMtimeMs;
          compressedFile.originalSha256BeforeMove = task.originalSha256;
          compressedFile.originalBackupPath = task.backupFilePath;
          result.files.push(compressedFile);
        } catch (error) {
          result.errorCount++;
          // PPP2-A-2: a copy failure (ENOSPC/EMFILE/EIO) can leave one of the two
          // If one backup write failed after the other succeeded, remove partial backup output.
          // so a disk-full/handle-exhaustion error cannot orphan files on disk.
          await this.cleanupBackupTaskFiles(task);
          console.error(getLogTag(this.plugin), `Backup creation error for ${compressedFile.name}:`, error);
        }
      })));

      if (result.files.length > 0) {
        result.backupCreated = true;
        new obsidian.Notice(`${getPluginName(this.plugin)}: ${t(this.plugin.app, "move.backup.createdCount", { count: result.files.length })}`);
        if (this.plugin.settings.autoBackupsRetentionEnabled) {
          await moveService.applyBackupsRetention(backupDir);
        }
      }

      return result;
    } catch (error) {
      result.errorCount += compressedFiles.length;
      console.error(getLogTag(this.plugin), "Backup creation error:", error);
      return result;
    }
  }

  async cleanupBackupTaskFiles(task: BackupPreflightTask) {
    const cleanupTargets = task.ownedBackupFiles || [];
    await Promise.all(cleanupTargets.map(async ({ path, sha256 }) => {
      try {
        const result = await this.plugin.getPlatformPorts().fs.removeFileIfUnchanged(path, sha256);
        if (result.retainedConflictPath) {
          console.warn(getLogTag(this.plugin), "Backup cleanup conflict retained:", result.retainedConflictPath);
        }
      } catch (error) {
        if (getErrorCode(error) !== "ENOENT") {
          console.warn(getLogTag(this.plugin), "Backup verification cleanup failed:", path, error);
        }
      }
    }));
    task.ownedBackupFiles = [];
  }
}
