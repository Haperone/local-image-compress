import * as obsidian from "obsidian";
import { t } from "./i18n";
import { ConcurrencyLimiter } from "./concurrency-limiter";
import { getPlatformWorkerPoolSize } from "./settings";
import { getErrorCode, getErrorMessage, getLogTag, getPluginName, getVaultFileByPath, isAllowedByRoots, isInsideOutputFolder, isSafeVaultRelativePath, normalizeVaultPath, normalizeVaultPathForComparison, randomHexSuffix, vaultBasename, vaultFileExtension } from "./utils";
import type LocalImageCompressPlugin from "./plugin";

export type CompressedFileRecord = {
  compressedPath: string;
  relativePath?: string;
  name: string;
  size: number;
  originalPath?: string;
  compressedSha256?: string;
  originalSizeBeforeMove?: number;
  originalMtimeMsBeforeMove?: number;
  originalSha256BeforeMove?: string;
  originalBackupPath?: string;
  cacheEntryKey?: string;
  cacheEntryOutputSha256?: string;
  moveSkipReason?: string;
  moveCandidates?: string[];
};

type OriginalFileLookup = {
  byName: Map<string, obsidian.TFile[]>;
};

export class MoveService {
  private readonly plugin: LocalImageCompressPlugin;
  // True while a move operation runs; runCompressionBatch defers compression to it.
  moveOperationInProgress = false;

  constructor(plugin: LocalImageCompressPlugin) {
    this.plugin = plugin;
  }

  private ports() {
    return this.plugin.getPlatformPorts();
  }

  toVaultRelativeSafe(filePath: string) {
    const normalized = normalizeVaultPath(filePath);
    if (!isSafeVaultRelativePath(normalized)) {
      throw new Error(`Move path is outside the vault-relative domain: ${filePath}`);
    }
    return normalized;
  }

  isAllowedOriginalPath(filePath: string) {
    if (isInsideOutputFolder(filePath, this.plugin.getOutputFolder())) {
      return false;
    }
    return isAllowedByRoots(filePath, this.plugin.settings.allowedRoots || []);
  }

  isCandidateOriginalFile(file: unknown): file is obsidian.TFile {
    const candidate = file as Partial<obsidian.TFile> | null;
    return !!candidate
      && typeof candidate.path === "string"
      && typeof candidate.name === "string"
      && this.plugin.isImageFile(candidate)
      && this.isAllowedOriginalPath(candidate.path);
  }

  getIOConcurrency() {
    if (this.ports().fs.sync === null) {
      return 1;
    }
    const activeWorkerCount = getPlatformWorkerPoolSize(
      obsidian.Platform.isMobile === true,
      this.plugin.getActiveWindow().navigator?.hardwareConcurrency
    );
    return Math.max(1, Math.min(activeWorkerCount * 2, 16));
  }

  getMoveText(key: string) {
    return t(this.plugin.app, key);
  }

  isUnloading() {
    return !!this.plugin.isUnloading;
  }

  buildOriginalFileLookup() {
    const byName = new Map<string, obsidian.TFile[]>();
    for (const file of this.plugin.app.vault.getFiles()) {
      if (!this.isCandidateOriginalFile(file)) {
        continue;
      }
      if (!byName.has(file.name)) {
        byName.set(file.name, []);
      }
      const entries = byName.get(file.name);
      if (entries) {
        entries.push(file);
      }
    }
    return { byName };
  }

  getOriginalFileCandidatesByName(fileName: string) {
    const allFiles = this.plugin.app.vault.getFiles();
    return allFiles.filter((file): file is obsidian.TFile => {
      if (file.name !== fileName) return false;
      return this.isCandidateOriginalFile(file);
    });
  }

  async pathExists(filePath: string) {
    return await this.ports().fs.exists(filePath);
  }

  async findOriginalFileForCompressed(compressedFile: CompressedFileRecord, originalLookup: OriginalFileLookup | null = null) {
    const relativePath = compressedFile.relativePath ? normalizeVaultPath(compressedFile.relativePath) : "";
    if (relativePath && this.isAllowedOriginalPath(relativePath)) {
      const file = getVaultFileByPath(this.plugin.app.vault, relativePath);
      if (file && this.plugin.isImageFile(file)) {
        return file.path;
      }

      if (await this.pathExists(relativePath)) {
        return relativePath;
      }
    }

    return await this.findOriginalFile(compressedFile.name, compressedFile, originalLookup);
  }

  async findOriginalFile(fileName: string, compressedFile: CompressedFileRecord | null = null, originalLookup: OriginalFileLookup | null = null) {
    const candidates = originalLookup?.byName?.get(fileName) || this.getOriginalFileCandidatesByName(fileName);

    if (candidates.length === 1) {
      const [candidate] = candidates;
      return candidate?.path ?? null;
    }

    if (candidates.length === 0 && compressedFile) {
      compressedFile.moveSkipReason = this.getMoveText("move.skip.noOriginalCandidate");
    }

    if (candidates.length > 1 && compressedFile) {
      compressedFile.moveSkipReason = this.getMoveText("move.skip.ambiguousOriginal");
      compressedFile.moveCandidates = candidates.map((file) => file.path);
    }

    return null;
  }

  async getCompressedFilesCount() {
    try {
      const allCompressedFiles = await this.getCompressedMoveCandidates();

      if (allCompressedFiles.length === 0) {
        return 0;
      }

      let movableCount = 0;
      const originalLookup = this.buildOriginalFileLookup();

      for (const compressedFile of allCompressedFiles) {
        const originalPath = await this.findOriginalFileForCompressed(compressedFile, originalLookup);
        if (originalPath) {
          movableCount++;
        }
      }

      return movableCount;
    } catch (error) {
      console.error(getLogTag(this.plugin), "Compressed files count error:", error);
      return 0;
    }
  }

  async moveCompressedToFiles() {
    if (this.moveOperationInProgress) {
      return;
    }
    this.moveOperationInProgress = true;
    try {
      if (!await this.plugin.waitForCompressionIdle()) {
        return;
      }
      await this.plugin.withCompressionGuards(
        async () => {
        try {
          const compressedFolderPath = this.plugin.getOutputFolder();

          const compressedFolderExists = await this.pathExists(compressedFolderPath);
          const allCompressedFiles = await this.getCompressedMoveCandidates();
          if (!compressedFolderExists && allCompressedFiles.length === 0) {
            new obsidian.Notice(`${getPluginName(this.plugin)}: ${t(this.plugin.app, "move.noCompressedFolder")}`);
            return;
          }

          if (allCompressedFiles.length === 0) {
            new obsidian.Notice(`${getPluginName(this.plugin)}: ${t(this.plugin.app, "move.noneToMove")}`);
            return;
          }

          const compressedFiles: CompressedFileRecord[] = [];
          let skippedCount = 0;
          const originalLookup = this.buildOriginalFileLookup();
          for (const compressedFile of allCompressedFiles) {
            const originalPath = await this.findOriginalFileForCompressed(compressedFile, originalLookup);
            if (originalPath) {
              compressedFile.originalPath = originalPath;
              compressedFiles.push(compressedFile);
            } else if (compressedFile.moveSkipReason) {
              skippedCount++;
            }
          }

          if (compressedFiles.length === 0) {
            const skippedReasonText = this.getMoveSkipReasonGroups(allCompressedFiles)
              .map((group) => `${group.reason}: ${group.count}`)
              .join("; ");
            const skippedDetails = skippedReasonText ? `; ${skippedReasonText}` : "";
            const skippedText = skippedCount > 0 ? ` (${t(this.plugin.app, "progress.skipped")}: ${skippedCount}${skippedDetails})` : "";
            new obsidian.Notice(`${getPluginName(this.plugin)}: ${t(this.plugin.app, "move.noneWithOriginals")}${skippedText}`);
            return;
          }

          const backupResult = await this.createBackupBeforeMove(compressedFiles);
          skippedCount += backupResult.skippedCount;
          let errorCount = backupResult.errorCount;
          const filesToMove = backupResult.files;

          if (filesToMove.length === 0) {
            await this.runPostCommitMaintenance("reconciled result presentation", () => this.showMoveResult(backupResult.reconciledCount, errorCount, backupResult.backupCreated, skippedCount, allCompressedFiles));
            await this.runPostCommitMaintenance("reconciled image index rebuild", async () => await this.plugin.rebuildImageIndex("move-compressed"));
            await this.runPostCommitMaintenance("reconciled status bar update", async () => await this.plugin.statusBarController.update());
            return;
          }

          const progressModal = this.showMoveProgressModal(filesToMove.length);

          let successCount = backupResult.reconciledCount;

          try {
            for (let i = 0; i < filesToMove.length; i++) {
              const compressedFile = filesToMove[i];
              if (!compressedFile) {
                continue;
              }

              try {
                progressModal.updateProgress(i + 1, filesToMove.length, compressedFile.name);
                await this.moveSingleFile(compressedFile);
                if (compressedFile.moveSkipReason) {
                  skippedCount++;
                } else {
                  successCount++;
                }
                await new Promise((resolve) => this.plugin.setWindowTimeout(resolve, 50));
              } catch (error) {
                console.error(getLogTag(this.plugin), `Move error for ${compressedFile.name}:`, getErrorMessage(error));
                errorCount++;
              }
            }
          } finally {
            // III2-A-3: guarantee the progress modal closes even if the loop body
            // throws an unexpected error, so it can never stay open indefinitely.
            progressModal.close();
          }
          await this.runPostCommitMaintenance("result presentation", () => this.showMoveResult(successCount, errorCount, backupResult.backupCreated, skippedCount, allCompressedFiles));
          await this.runPostCommitMaintenance("image index rebuild", async () => await this.plugin.rebuildImageIndex("move-compressed"));
          await this.runPostCommitMaintenance("status bar update", async () => await this.plugin.statusBarController.update());
        } catch (error) {
          console.error(getLogTag(this.plugin), "Error while moving files:", error);
          new obsidian.Notice(`${getPluginName(this.plugin)}: ${t(this.plugin.app, "progress.error")}`);
        }
        }
      );
    } finally {
      this.moveOperationInProgress = false;
    }
  }

  private async runPostCommitMaintenance(label: string, operation: () => unknown) {
    try {
      await operation();
    } catch (error) {
      console.warn(getLogTag(this.plugin), `Post-move ${label} failed:`, error);
    }
  }

  async getCompressedFilesAsync(compressedFolderPath: string): Promise<CompressedFileRecord[]> {
    const files: CompressedFileRecord[] = [];
    let visitedCount = 0;
    const seenDirectories = new Set<string>();
    const walk = async (dirPath: string, relativePath = "") => {
      try {
        const realPath = normalizeVaultPathForComparison(await this.ports().fs.realpath(dirPath));
        if (seenDirectories.has(realPath)) {
          return;
        }
        seenDirectories.add(realPath);
      } catch (e) {
        console.error(getLogTag(this.plugin), "Failed to resolve directory:", dirPath, e);
        return;
      }
      let items;
      try {
        items = await this.ports().fs.listEntries(dirPath);
      } catch (e) {
        console.error(getLogTag(this.plugin), "Failed to read directory:", dirPath, e);
        return;
      }
      for (const entry of items) {
        const name = entry.name;
        const fullPath = this.ports().fs.joinPath(dirPath, name);
        const relativeItemPath = relativePath ? this.ports().fs.joinPath(relativePath, name) : name;
        if (entry.isSymbolicLink) {
          continue;
        }
        if (entry.isDirectory) {
          await walk(fullPath, relativeItemPath);
        } else if (this.plugin.isImageFile({ extension: vaultFileExtension(name).toLowerCase() })) {
          try {
            const stats = await this.ports().fs.stat(fullPath);
            if (stats) {
              files.push({ compressedPath: fullPath, relativePath: relativeItemPath, name, size: stats.size });
            }
          } catch (e) {
            console.error(getLogTag(this.plugin), "Failed to stat path:", fullPath, e);
          }
        }
        visitedCount++;
        if (visitedCount % 200 === 0) {
          await new Promise((r) => this.plugin.setWindowTimeout(r, 0));
        }
      }
    };
    await walk(compressedFolderPath);
    return files;
  }

  async getCompressedMoveCandidates(): Promise<CompressedFileRecord[]> {
    const compressedFolderPath = this.plugin.getOutputFolder();
    const files = await this.pathExists(compressedFolderPath)
      ? await this.getCompressedFilesAsync(compressedFolderPath)
      : [];
    const filesByPath = new Map<string, CompressedFileRecord>();
    for (const file of files) {
      filesByPath.set(normalizeVaultPathForComparison(this.toVaultRelativeSafe(file.compressedPath)), file);
    }
    for (const artifact of this.plugin.cache.getPendingMoveArtifacts()) {
      const outputPath = artifact.outputPath;
      const outputKey = normalizeVaultPathForComparison(artifact.outputPath);
      const existing = filesByPath.get(outputKey);
      if (existing) {
        existing.relativePath = artifact.sourcePath;
        continue;
      }
      if (!this.plugin.isImageFile({ extension: vaultFileExtension(artifact.outputPath).toLowerCase() })) {
        continue;
      }
      const stats = await this.ports().fs.stat(outputPath).catch(() => null);
      if (!stats || stats.isDirectory) {
        continue;
      }
      const record = {
        compressedPath: outputPath,
        relativePath: artifact.sourcePath,
        name: vaultBasename(artifact.sourcePath),
        size: stats.size
      };
      files.push(record);
      filesByPath.set(outputKey, record);
    }
    return files;
  }

  async createBackupBeforeMove(compressedFiles: CompressedFileRecord[]) {
    return await this.plugin.moveBackupPreflight.createBackupBeforeMove(compressedFiles);
  }

  async applyBackupsRetention(backupDir: string) {
    try {
      const days = this.plugin.settings.autoBackupsRetentionDays;
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        console.warn(getLogTag(this.plugin), "Invalid backups retention days; skipping cleanup:", days);
        return;
      }
      const exists = await this.pathExists(backupDir);
      if (!exists) return;

      const now = Date.now();
      const ttlMs = days * 24 * 60 * 60 * 1000;

      const backupEntries = (await this.ports().fs.listEntries(backupDir))
        .filter((entry) => entry.isDirectory);
      const retentionLimiter = new ConcurrencyLimiter(this.getIOConcurrency());
      await Promise.allSettled(backupEntries.map((entry) => retentionLimiter.run(async () => {
        const entryPath = this.ports().fs.joinPath(backupDir, entry.name);
        try {
          const stats = await this.ports().fs.stat(entryPath);
          if (stats && now - stats.mtimeMs > ttlMs) {
            await this.deleteDirectoryRecursiveAsync(entryPath);
          }
        } catch (err) {
          console.error(getLogTag(this.plugin), "Expired backup removal error:", entryPath, err);
        }
      })));
    } catch (err) {
      console.error(getLogTag(this.plugin), "Backups retention apply error:", err);
    }
  }

  async moveSingleFile(compressedFile: CompressedFileRecord) {
    let tempOriginalPath: string | null = null;
    let tempOriginalSha256: string | null = null;
    try {
      if (this.isUnloading()) {
        compressedFile.moveSkipReason = this.getMoveText("move.skip.unloading");
        return;
      }
      const originalPath = compressedFile.originalPath || await this.findOriginalFileForCompressed(compressedFile);

      if (!originalPath) {
        throw new Error(`Original file not found: ${compressedFile.name}`);
      }
      if (this.isUnloading()) {
        compressedFile.moveSkipReason = this.getMoveText("move.skip.unloading");
        return;
      }
      if (await this.pathsReferToSameFile(compressedFile.compressedPath, originalPath)) {
        compressedFile.moveSkipReason = this.getMoveText("move.skip.selfMove");
        return;
      }

      const originalStats = await this.ports().fs.stat(originalPath);
      if (!originalStats) {
        compressedFile.moveSkipReason = this.getMoveText("move.skip.originalNotFoundAtMoveTime");
        return;
      }
      if (this.isUnloading()) {
        compressedFile.moveSkipReason = this.getMoveText("move.skip.unloading");
        return;
      }
      if (compressedFile.originalSizeBeforeMove !== undefined
        && compressedFile.originalMtimeMsBeforeMove !== undefined
        && (originalStats.size !== compressedFile.originalSizeBeforeMove || originalStats.mtimeMs !== compressedFile.originalMtimeMsBeforeMove)) {
        compressedFile.moveSkipReason = this.getMoveText("move.skip.externalModification");
        return;
      }
      if (compressedFile.originalSha256BeforeMove) {
        const currentOriginalSha256 = await this.ports().hash.fileSha256Hex(originalPath);
        if (currentOriginalSha256 !== compressedFile.originalSha256BeforeMove) {
          compressedFile.moveSkipReason = this.getMoveText("move.skip.externalModification");
          return;
        }
      }
      const originalRelativePath = this.toVaultRelativeSafe(originalPath);
      const compressedRelativePath = this.toVaultRelativeSafe(compressedFile.compressedPath);

      if (compressedFile.size >= originalStats.size) {
        if (compressedFile.size === originalStats.size) {
          const cleanupSha256 = compressedFile.compressedSha256
            || await this.ports().hash.fileSha256Hex(compressedFile.compressedPath);
          if (!await this.filesHaveSameContent(compressedFile.compressedPath, originalPath)) {
            throw new Error(`Compressed file is larger or equal to original: ${compressedFile.name}`);
          }
          const cacheCommitted = await this.plugin.cache.markProcessedFileSkippedIdentical(
            originalRelativePath,
            originalStats,
            originalStats.size,
            compressedRelativePath,
            compressedFile.cacheEntryKey && compressedFile.cacheEntryOutputSha256
              ? { cacheKey: compressedFile.cacheEntryKey, outputSha256: compressedFile.cacheEntryOutputSha256 }
              : null
          );
          if (!cacheCommitted) {
            throw new Error(`Identical-output cache transition was not durably committed; compressed output retained: ${compressedFile.name}`);
          }
          try {
            await this.removeFileVersionIfContentMatches(compressedFile.compressedPath, cleanupSha256);
          } catch (cleanupError) {
            console.error(getLogTag(this.plugin), `Compressed output cleanup failed for ${compressedFile.name}:`, getErrorMessage(cleanupError));
          }
          await this.plugin.cache.compactPath(originalRelativePath);
          return;
        }
        throw new Error(`Compressed file is larger or equal to original: ${compressedFile.name}`);
      }

      const randomSuffix = await randomHexSuffix(16);
      tempOriginalPath = this.ports().fs.joinPath(
        this.ports().fs.dirnamePath(originalPath),
        `.${vaultBasename(originalPath)}.tinylocal-${Date.now()}-${randomSuffix}.tmp`
      );
      const expectedCompressedSha256 = compressedFile.compressedSha256;
      if (!expectedCompressedSha256) {
        throw new Error(`Verified compressed identity is unavailable: ${compressedFile.name}`);
      }
      await this.ports().fs.copyFile(compressedFile.compressedPath, tempOriginalPath, { exclusive: true });
      // BR-H1: the destructive overwrite must verify CONTENT, not just byte length. Re-hash the
      // staged temp bytes (the exact bytes that get renamed over the original) and compare to the
      // backup-verified compressedSha256, so a same-size-but-different-content compressed file
      // (corruption / sync substitution between backup and move) cannot silently replace the original.
      // Android document providers can expose stale zero-byte stat metadata for a newly copied dotfile,
      // so the exact content digest is the staging authority.
      const stagedSha256 = await this.ports().hash.fileSha256Hex(tempOriginalPath);
      tempOriginalSha256 = stagedSha256;
      if (stagedSha256 !== expectedCompressedSha256) {
        compressedFile.moveSkipReason = this.getMoveText("move.skip.externalModification");
        const message = t(this.plugin.app, "move.warning.externalModification", { name: compressedFile.name });
        new obsidian.Notice(`${getPluginName(this.plugin)}: ${message}`, 10000);
        console.warn(getLogTag(this.plugin), `Compressed content changed before move (hash mismatch): ${compressedFile.name}`);
        try {
          if (await this.removeFileVersionIfContentMatches(tempOriginalPath, stagedSha256)) {
            tempOriginalPath = null;
            tempOriginalSha256 = null;
          }
        } catch (cleanupError) {
          console.warn(getLogTag(this.plugin), `Temporary move cleanup failed for ${compressedFile.name}:`, cleanupError);
        }
        return;
      }
      if (!compressedFile.originalBackupPath || !compressedFile.originalSha256BeforeMove) {
        throw new Error(`Verified original backup is unavailable: ${compressedFile.name}`);
      }
      const backupStat = await this.ports().fs.stat(compressedFile.originalBackupPath);
      if (!backupStat || backupStat.isDirectory) {
        throw new Error(`Verified original backup is missing: ${compressedFile.originalBackupPath}`);
      }
      const backupSha256 = await this.ports().hash.fileSha256Hex(compressedFile.originalBackupPath);
      if (backupSha256 !== compressedFile.originalSha256BeforeMove) {
        throw new Error(`Verified original backup changed: ${compressedFile.originalBackupPath}`);
      }
      if (this.isUnloading()) {
        compressedFile.moveSkipReason = this.getMoveText("move.skip.unloading");
        try {
          if (await this.removeFileVersionIfContentMatches(tempOriginalPath, expectedCompressedSha256)) {
            tempOriginalPath = null;
            tempOriginalSha256 = null;
          }
        } catch (cleanupError) {
          console.warn(getLogTag(this.plugin), `Temporary move cleanup failed for ${compressedFile.name}:`, cleanupError);
        }
        return;
      }
      let processedStats;
      let replacementLanded = false;
      try {
        const replacement = await this.ports().fs.replaceFile(tempOriginalPath, originalPath, {
          expectedTargetSha256: compressedFile.originalSha256BeforeMove,
          expectedStagedSha256: expectedCompressedSha256
        });
        replacementLanded = true;
        tempOriginalPath = null;
        tempOriginalSha256 = null;
        if (replacement.leftoverRollbackPath) {
          console.warn(getLogTag(this.plugin), `Move replacement left a recoverable rollback file for ${compressedFile.name}:`, replacement.leftoverRollbackPath);
        }
        const observedProcessedStats = await this.ports().fs.stat(originalPath);
        const processedSha256 = await this.ports().hash.fileSha256Hex(originalPath);
        if (!observedProcessedStats || processedSha256 !== expectedCompressedSha256) {
          throw new Error(`Post-replacement verification failed: ${compressedFile.name}`);
        }
        processedStats = observedProcessedStats.size === compressedFile.size
          ? observedProcessedStats
          : { ...observedProcessedStats, size: compressedFile.size };
      } catch (replacementError) {
        if (replacementLanded) {
          try {
            await this.restoreOriginalFromBackup(compressedFile, originalPath, expectedCompressedSha256);
          } catch (recoveryError) {
            throw new Error(`Replacement failed after a concurrent target change. The newer target was preserved. Verified backup: ${compressedFile.originalBackupPath}. ${getErrorMessage(recoveryError)}`);
          }
        } else {
          const currentOriginal = await this.ports().fs.stat(originalPath);
          if (!currentOriginal) {
            await this.restoreOriginalFromBackup(compressedFile, originalPath, expectedCompressedSha256);
          } else if (await this.ports().hash.fileSha256Hex(originalPath) !== compressedFile.originalSha256BeforeMove) {
            throw new Error(`Replacement failed while the original also changed. Preserved backup: ${compressedFile.originalBackupPath}. ${getErrorMessage(replacementError)}`);
          }
        }
        throw replacementError;
      }
      const cacheCommitted = await this.plugin.cache.markProcessedFileMoved(
        originalRelativePath,
        processedStats,
        originalStats.size,
        compressedRelativePath,
        compressedFile.cacheEntryKey && compressedFile.cacheEntryOutputSha256
          ? { cacheKey: compressedFile.cacheEntryKey, outputSha256: compressedFile.cacheEntryOutputSha256 }
          : null
      );
      if (!cacheCommitted) {
        throw new Error(`Moved cache transition was not durably committed; compressed output retained: ${compressedFile.name}`);
      }
      try {
        await this.removeFileVersionIfContentMatches(compressedFile.compressedPath, expectedCompressedSha256);
      } catch (cleanupError) {
        console.error(getLogTag(this.plugin), `Compressed output cleanup failed for ${compressedFile.name}:`, getErrorMessage(cleanupError));
      }
      await this.plugin.cache.compactPath(originalRelativePath);
    } catch (error) {
      if (tempOriginalPath) {
        if (tempOriginalSha256) {
          try {
            await this.removeFileVersionIfContentMatches(tempOriginalPath, tempOriginalSha256);
          } catch (cleanupError) {
            console.warn(getLogTag(this.plugin), `Temporary move cleanup failed for ${compressedFile.name}:`, cleanupError);
          }
        } else {
          console.warn(getLogTag(this.plugin), `Unverified temporary move file retained for ${compressedFile.name}:`, tempOriginalPath);
        }
      }
      console.error(getLogTag(this.plugin), `moveSingleFile error for ${compressedFile.name}:`, getErrorMessage(error));
      throw error;
    }
  }

  private async removeFileVersionIfContentMatches(filePath: string, expectedSha256: string): Promise<boolean> {
    const result = await this.ports().fs.removeFileIfUnchanged(filePath, expectedSha256);
    if (result.retainedConflictPath) {
      throw new Error(`Newer output was retained at ${result.retainedConflictPath}`);
    }
    return result.removed;
  }

  private async restoreOriginalFromBackup(
    compressedFile: CompressedFileRecord,
    originalPath: string,
    expectedCurrentSha256: string
  ): Promise<void> {
    const backupPath = compressedFile.originalBackupPath;
    const expectedHash = compressedFile.originalSha256BeforeMove;
    if (!backupPath || !expectedHash) {
      throw new Error(`Original recovery metadata is unavailable for ${compressedFile.name}`);
    }
    const backupHash = await this.ports().hash.fileSha256Hex(backupPath);
    if (backupHash !== expectedHash) {
      throw new Error(`Original recovery backup failed verification: ${backupPath}`);
    }
    const recoveryTemp = this.ports().fs.joinPath(
      this.ports().fs.dirnamePath(originalPath),
      `.${vaultBasename(originalPath)}.tinylocal-recovery-${Date.now()}-${await randomHexSuffix(16)}.tmp`
    );
    let recoveryTempVerified = false;
    try {
      await this.ports().fs.copyFile(backupPath, recoveryTemp, { exclusive: true });
      if (await this.ports().hash.fileSha256Hex(recoveryTemp) !== expectedHash) {
        throw new Error(`Original recovery staging failed verification: ${recoveryTemp}`);
      }
      recoveryTempVerified = true;
      const replacement = await this.ports().fs.replaceFile(recoveryTemp, originalPath, {
        expectedTargetSha256: expectedCurrentSha256,
        allowMissingTarget: true,
        expectedStagedSha256: expectedHash
      });
      if (replacement.leftoverRollbackPath) {
        console.warn(getLogTag(this.plugin), `Original recovery left a rollback file for ${compressedFile.name}:`, replacement.leftoverRollbackPath);
      }
      if (await this.ports().hash.fileSha256Hex(originalPath) !== expectedHash) {
        throw new Error(`Original recovery target failed verification: ${originalPath}`);
      }
    } catch (error) {
      if (recoveryTempVerified) {
        try {
          await this.removeFileVersionIfContentMatches(recoveryTemp, expectedHash);
        } catch (cleanupError) {
          console.warn(getLogTag(this.plugin), `Original recovery temp cleanup failed for ${compressedFile.name}:`, cleanupError);
        }
      } else {
        console.warn(getLogTag(this.plugin), `Unverified original recovery temp retained for ${compressedFile.name}:`, recoveryTemp);
      }
      throw new Error(`Original recovery failed for ${compressedFile.name}. Verified backup: ${backupPath}. ${getErrorMessage(error)}`);
    }
  }

  async pathsReferToSameFile(leftPath: string, rightPath: string) {
    const [leftResolved, rightResolved] = await Promise.all([
      this.resolvePathForSelfMoveComparison(leftPath),
      this.resolvePathForSelfMoveComparison(rightPath)
    ]);
    return leftResolved === rightResolved;
  }

  private async resolvePathForSelfMoveComparison(filePath: string) {
    try {
      return normalizeVaultPathForComparison(await this.ports().fs.realpath(filePath));
    } catch {
      return normalizeVaultPathForComparison(this.ports().fs.canonicalizePath(filePath));
    }
  }

  async filesHaveSameContent(leftPath: string, rightPath: string) {
    try {
      return await this.ports().fs.compareFileContents(leftPath, rightPath);
    } catch (error) {
      throw new Error(`Content comparison failed for ${vaultBasename(leftPath)} and ${vaultBasename(rightPath)}: ${getErrorMessage(error)}`);
    }
  }

  showMoveProgressModal(totalFiles: number) {
    return this.plugin.moveModals.showMoveProgressModal(totalFiles);
  }

  getMoveSkipReasonGroups(compressedFiles: CompressedFileRecord[] = []) {
    const groups = new Map<string, number>();
    for (const compressedFile of compressedFiles) {
      const reason = compressedFile.moveSkipReason?.trim();
      if (!reason) {
        continue;
      }
      groups.set(reason, (groups.get(reason) || 0) + 1);
    }
    return Array.from(groups.entries()).map(([reason, count]) => ({ reason, count }));
  }

  showMoveResult(successCount: number, errorCount: number, backupCreated: boolean, skippedCount = 0, compressedFiles: CompressedFileRecord[] = []) {
    this.plugin.moveModals.showMoveResult(successCount, errorCount, backupCreated, skippedCount, compressedFiles);
  }

  async deleteDirectoryRecursiveAsync(dirPath: string): Promise<boolean> {
    try {
      const entries = await this.ports().fs.listEntries(dirPath);
      const fileSnapshots = new Map<string, string>();
      for (const entry of entries) {
        if (entry.isFile && !entry.isSymbolicLink) {
          const entryPath = this.ports().fs.joinPath(dirPath, entry.name);
          fileSnapshots.set(entry.name, await this.ports().hash.fileSha256Hex(entryPath));
        }
      }
      const confirmedEntries = await this.ports().fs.listEntries(dirPath);
      const snapshotSignature = (items: typeof entries) => items
        .map((entry) => `${entry.name}\0${entry.isFile ? "f" : entry.isDirectory ? "d" : "o"}\0${entry.isSymbolicLink ? "l" : "n"}`)
        .sort()
        .join("\n");
      if (snapshotSignature(entries) !== snapshotSignature(confirmedEntries)) {
        return false;
      }
      const cleanupLimiter = new ConcurrencyLimiter(this.getIOConcurrency());
      const cleanupResults = await Promise.allSettled(entries.map((entry) => cleanupLimiter.run(async () => {
        const entryPath = this.ports().fs.joinPath(dirPath, entry.name);
        if (entry.isDirectory) {
          return await this.deleteDirectoryRecursiveAsync(entryPath);
        }
        if (!entry.isFile || entry.isSymbolicLink) {
          return false;
        }
        const expectedSha256 = fileSnapshots.get(entry.name);
        if (!expectedSha256) {
          return false;
        }
        return await this.removeFileVersionIfContentMatches(entryPath, expectedSha256);
      })));
      if (cleanupResults.some((result) => result.status === "rejected" || !result.value)) {
        return false;
      }
      // Non-recursive removal is the final fence: a Sync-created child makes
      // rmdir fail instead of being swept up by a recursive delete.
      await this.ports().fs.removeDir(dirPath, { recursive: false, force: false });
      return true;
    } catch (e) {
      if (getErrorCode(e) === "ENOENT") {
        return true;
      }
      console.warn(getLogTag(this.plugin), "Failed to remove directory tree:", dirPath, e);
      return false;
    }
  }
}
