import * as obsidian from "obsidian";
import * as fs from "fs";
import * as path from "path";
import { t } from "./i18n";
import { ConcurrencyLimiter } from "./concurrency-limiter";
import { getInternalWorkerPoolSize } from "./settings";
import { getErrorCode, getErrorMessage, getLogTag, getPluginName, getVaultBasePath, getVaultFileByPath, isAllowedByRoots, isInsideOutputFolder, normalizeVaultPath, normalizeVaultPathForComparison, randomHexSuffix, streamHashSha256 } from "./utils";
import type LocalImageCompressPlugin from "./plugin";

type CompressedFileRecord = {
  compressedPath: string;
  relativePath?: string;
  name: string;
  size: number;
  originalPath?: string;
  compressedSha256?: string;
  originalSizeBeforeMove?: number;
  originalMtimeMsBeforeMove?: number;
  originalSha256BeforeMove?: string;
  moveSkipReason?: string;
  moveCandidates?: string[];
};

type OriginalFileLookup = {
  byName: Map<string, obsidian.TFile[]>;
};

type BackupPreflightTask = {
  compressedFile: CompressedFileRecord;
  skipped: boolean;
  originalPath?: string;
  backupFilePath?: string;
  compressedBackupPath?: string;
  originalSize?: number;
  originalMtimeMs?: number;
  originalSha256?: string;
  compressedSize?: number;
  compressedMtimeMs?: number;
  compressedSha256?: string;
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

export class MoveService {
  private readonly plugin: LocalImageCompressPlugin;
  // True while a move operation runs; runCompressionBatch defers compression to it.
  moveOperationInProgress = false;

  constructor(plugin: LocalImageCompressPlugin) {
    this.plugin = plugin;
  }

  getVaultBasePath() {
    return getVaultBasePath(this.plugin.app);
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
    const activeWorkerCount = getInternalWorkerPoolSize(
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

  skipForUnload(compressedFile: CompressedFileRecord) {
    compressedFile.moveSkipReason = this.getMoveText("move.skip.unloading");
    return { compressedFile, skipped: true };
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
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async findOriginalFileForCompressed(compressedFile: CompressedFileRecord, originalLookup: OriginalFileLookup | null = null) {
    const relativePath = compressedFile.relativePath ? normalizeVaultPath(compressedFile.relativePath) : "";
    if (relativePath && this.isAllowedOriginalPath(relativePath)) {
      const file = getVaultFileByPath(this.plugin.app.vault, relativePath);
      if (file && this.plugin.isImageFile(file)) {
        return path.join(this.getVaultBasePath(), file.path);
      }

      const absolutePath = path.join(this.getVaultBasePath(), relativePath);
      if (await this.pathExists(absolutePath)) {
        return absolutePath;
      }
    }

    return await this.findOriginalFile(compressedFile.name, compressedFile, originalLookup);
  }

  async findOriginalFile(fileName: string, compressedFile: CompressedFileRecord | null = null, originalLookup: OriginalFileLookup | null = null) {
    const candidates = originalLookup?.byName?.get(fileName) || this.getOriginalFileCandidatesByName(fileName);

    if (candidates.length === 1) {
      const [candidate] = candidates;
      return candidate ? path.join(this.getVaultBasePath(), candidate.path) : null;
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
      const compressedFolderPath = path.join(this.getVaultBasePath(), this.plugin.getOutputFolder());

      if (!await this.pathExists(compressedFolderPath)) {
        return 0;
      }

      const allCompressedFiles = await this.getCompressedFilesAsync(compressedFolderPath);

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
      await this.plugin.waitForCompressionIdle();
      await this.plugin.withCompressionGuards(
        async () => {
        try {
          const compressedFolderPath = path.join(this.getVaultBasePath(), this.plugin.getOutputFolder());

          if (!await this.pathExists(compressedFolderPath)) {
            new obsidian.Notice(`${getPluginName(this.plugin)}: ${t(this.plugin.app, "move.noCompressedFolder")}`);
            return;
          }

          const allCompressedFiles = await this.getCompressedFilesAsync(compressedFolderPath);

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
            this.showMoveResult(0, errorCount, backupResult.backupCreated, skippedCount, allCompressedFiles);
            await this.plugin.rebuildImageIndex("move-compressed");
            await this.plugin.statusBarController.update();
            return;
          }

          const progressModal = this.showMoveProgressModal(filesToMove.length);

          let successCount = 0;

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
          this.showMoveResult(successCount, errorCount, backupResult.backupCreated, skippedCount, allCompressedFiles);
          await this.plugin.rebuildImageIndex("move-compressed");
          await this.plugin.statusBarController.update();
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

  async getCompressedFilesAsync(compressedFolderPath: string): Promise<CompressedFileRecord[]> {
    const files: CompressedFileRecord[] = [];
    let visitedCount = 0;
    const seenDirectories = new Set<string>();
    const walk = async (dirPath: string, relativePath = "") => {
      try {
        const realPath = normalizeVaultPathForComparison(await fs.promises.realpath(dirPath));
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
        items = await fs.promises.readdir(dirPath, { withFileTypes: true });
      } catch (e) {
        console.error(getLogTag(this.plugin), "Failed to read directory:", dirPath, e);
        return;
      }
      for (const entry of items) {
        const name = entry.name;
        const fullPath = path.join(dirPath, name);
        const relativeItemPath = path.join(relativePath, name);
        if (entry.isSymbolicLink && entry.isSymbolicLink()) {
          continue;
        }
        if (entry.isDirectory()) {
          await walk(fullPath, relativeItemPath);
        } else if (this.plugin.isImageFile({ extension: path.extname(name).slice(1).toLowerCase() })) {
          try {
            const stats = await fs.promises.stat(fullPath);
            files.push({ compressedPath: fullPath, relativePath: relativeItemPath, name, size: stats.size });
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

  async createBackupBeforeMove(compressedFiles: CompressedFileRecord[]) {
    const result = {
      backupCreated: false,
      files: [] as CompressedFileRecord[],
      skippedCount: 0,
      errorCount: 0
    };
    try {
      if (this.isUnloading()) {
        for (const compressedFile of compressedFiles) {
          compressedFile.moveSkipReason = this.getMoveText("move.skip.unloading");
        }
        result.skippedCount = compressedFiles.length;
        return result;
      }
      const backupDir = this.plugin.getBackupStoragePaths().originalFilesBackups;
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const randomSuffix = await randomHexSuffix(16);
      const backupPath = path.join(backupDir, `backup-${timestamp}-${randomSuffix}`);
      await fs.promises.mkdir(backupPath, { recursive: true });

      const prepassLimiter = new ConcurrencyLimiter(this.getIOConcurrency());
      const tasks = await Promise.all(compressedFiles.map((compressedFile) => prepassLimiter.run(async (): Promise<BackupPreflightTask> => {
        if (this.isUnloading()) {
          return this.skipForUnload(compressedFile);
        }
        const originalPath = compressedFile.originalPath || await this.findOriginalFileForCompressed(compressedFile);
        if (this.isUnloading()) {
          return this.skipForUnload(compressedFile);
        }
        if (!originalPath) {
          compressedFile.moveSkipReason = this.getMoveText("move.skip.originalMissingBeforeBackup");
          return { compressedFile, skipped: true };
        }
        if (await this.pathsReferToSameFile(compressedFile.compressedPath, originalPath)) {
          compressedFile.moveSkipReason = this.getMoveText("move.skip.selfMove");
          return { compressedFile, skipped: true };
        }
        const [originalStats, compressedStats] = await Promise.all([
          fs.promises.stat(originalPath).catch(() => null),
          fs.promises.stat(compressedFile.compressedPath).catch(() => null)
        ]);
        if (this.isUnloading()) {
          return this.skipForUnload(compressedFile);
        }
        if (!originalStats) {
          compressedFile.moveSkipReason = this.getMoveText("move.skip.originalMissingBeforeBackup");
          return { compressedFile, skipped: true };
        }
        if (!compressedStats) {
          compressedFile.moveSkipReason = this.getMoveText("move.skip.compressedMissingBeforeBackup");
          return { compressedFile, skipped: true };
        }
        const relativeToVault = path.relative(this.getVaultBasePath(), originalPath);
        const compressedRelativePath = path.relative(this.getVaultBasePath(), compressedFile.compressedPath);
        // Defensive: originals/compressed are expected inside the vault (allowed roots). Refuse to
        // back up a path that escapes the vault root, so an edge/crafted path cannot traverse out of
        // the timestamped backup directory.
        const pathEscapesVault = (relativePath: string) =>
          path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).some((segment) => segment === "..");
        if (pathEscapesVault(relativeToVault) || pathEscapesVault(compressedRelativePath)) {
          compressedFile.moveSkipReason = this.getMoveText("move.skip.originalMissingBeforeBackup");
          return { compressedFile, skipped: true };
        }
        const pendingMove = await this.plugin.cache.resolvePendingMoveEntry({
          path: normalizeVaultPath(relativeToVault),
          stat: { mtime: originalStats.mtimeMs, size: originalStats.size }
        }, normalizeVaultPath(compressedRelativePath));
        if (pendingMove.status === "conflict") {
          compressedFile.moveSkipReason = this.getMoveText("move.skip.externalModification");
          return { compressedFile, skipped: true };
        }
        if (pendingMove.status === "match" && pendingMove.entry) {
          const outputMatchesStats = this.plugin.cache.normalizeMtime(pendingMove.entry.outputMtime) === this.plugin.cache.normalizeMtime(compressedStats.mtimeMs)
            && Number(pendingMove.entry.outputSize) === compressedStats.size;
          if (!outputMatchesStats) {
            compressedFile.moveSkipReason = this.getMoveText("move.skip.externalModification");
            return { compressedFile, skipped: true };
          }
        }
        const [originalSha256, compressedSha256] = await Promise.all([
          streamHashSha256(originalPath),
          streamHashSha256(compressedFile.compressedPath)
        ]);
        if (this.isUnloading()) {
          return this.skipForUnload(compressedFile);
        }
        return {
          compressedFile,
          originalPath,
          skipped: false,
          backupFilePath: path.join(backupPath, "originals", relativeToVault),
          compressedBackupPath: path.join(backupPath, "compressed", compressedRelativePath),
          originalSize: originalStats.size,
          originalMtimeMs: originalStats.mtimeMs,
          originalSha256,
          compressedSize: compressedStats.size,
          compressedMtimeMs: compressedStats.mtimeMs,
          compressedSha256
        };
      })));

      const backupDirs = new Set<string>();
      for (const task of tasks) {
        if (this.isCompleteBackupTask(task)) {
          backupDirs.add(path.dirname(task.backupFilePath));
          backupDirs.add(path.dirname(task.compressedBackupPath));
        }
      }
      await Promise.all(Array.from(backupDirs).map((dir) => fs.promises.mkdir(dir, { recursive: true })));

      const limiter = new ConcurrencyLimiter(this.getIOConcurrency());
      await Promise.all(tasks.map((task) => limiter.run(async () => {
        const compressedFile = task.compressedFile;
        if (task.skipped) {
          result.skippedCount++;
          return;
        }
        if (!this.isCompleteBackupTask(task)) {
          compressedFile.moveSkipReason = this.getMoveText("move.skip.invalidBackupTask");
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
            fs.promises.stat(task.originalPath),
            fs.promises.stat(compressedFile.compressedPath)
          ]);
          if (currentOriginalStats.size !== task.originalSize || currentOriginalStats.mtimeMs !== task.originalMtimeMs) {
            compressedFile.moveSkipReason = this.getMoveText("move.skip.originalModifiedDuringBackup");
            result.skippedCount++;
            return;
          }
          if (currentCompressedStats.size !== task.compressedSize || currentCompressedStats.mtimeMs !== task.compressedMtimeMs) {
            compressedFile.moveSkipReason = this.getMoveText("move.skip.compressedModifiedDuringBackup");
            result.skippedCount++;
            return;
          }
          const [currentOriginalSha256, currentCompressedSha256] = await Promise.all([
            streamHashSha256(task.originalPath),
            streamHashSha256(compressedFile.compressedPath)
          ]);
          if (currentOriginalSha256 !== task.originalSha256) {
            compressedFile.moveSkipReason = this.getMoveText("move.skip.originalContentChangedDuringBackup");
            result.skippedCount++;
            return;
          }
          if (currentCompressedSha256 !== task.compressedSha256) {
            compressedFile.moveSkipReason = this.getMoveText("move.skip.compressedContentChangedDuringBackup");
            result.skippedCount++;
            return;
          }
          await Promise.all([
            fs.promises.copyFile(task.originalPath, task.backupFilePath),
            fs.promises.copyFile(compressedFile.compressedPath, task.compressedBackupPath)
          ]);
          const [backupOriginalSha256, backupCompressedSha256] = await Promise.all([
            streamHashSha256(task.backupFilePath),
            streamHashSha256(task.compressedBackupPath)
          ]);
          if (backupOriginalSha256 !== task.originalSha256 || backupCompressedSha256 !== task.compressedSha256) {
            await this.cleanupBackupTaskFiles(task);
            compressedFile.moveSkipReason = this.getMoveText("move.skip.contentChangedDuringCopy");
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
          await this.applyBackupsRetention(backupDir);
        }
      }

      return result;
    } catch (error) {
      result.errorCount += compressedFiles.length;
      console.error(getLogTag(this.plugin), "Backup creation error:", error);
      return result;
    }
  }

  async applyBackupsRetention(backupDir: string) {
    try {
      const days = this.plugin.settings.autoBackupsRetentionDays;
      if (!Number.isInteger(days) || days < 1 || days > 365) {
        console.warn(getLogTag(this.plugin), "Invalid backups retention days; skipping cleanup:", days);
        return;
      }
      const exists = await fs.promises.access(backupDir).then(() => true).catch(() => false);
      if (!exists) return;

      const now = Date.now();
      const ttlMs = days * 24 * 60 * 60 * 1000;

      const entries: Array<{ name: string; path: string; mtime: number }> = [];
      for (const entry of await fs.promises.readdir(backupDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        const entryPath = path.join(backupDir, entry.name);
        const stats = await fs.promises.stat(entryPath);
        if (now - stats.mtimeMs > ttlMs) {
          entries.push({ name: entry.name, path: entryPath, mtime: stats.mtimeMs });
        }
      }

      for (const entry of entries) {
        try {
          await this.deleteDirectoryRecursiveAsync(entry.path);
        } catch (err) {
          console.error(getLogTag(this.plugin), "Expired backup removal error:", entry.path, err);
        }
      }
    } catch (err) {
      console.error(getLogTag(this.plugin), "Backups retention apply error:", err);
    }
  }

  async moveSingleFile(compressedFile: CompressedFileRecord) {
    let tempOriginalPath: string | null = null;
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

      let originalStats;
      try {
        originalStats = await fs.promises.stat(originalPath);
      } catch (statError) {
        if (getErrorCode(statError) === "ENOENT") {
          compressedFile.moveSkipReason = this.getMoveText("move.skip.originalNotFoundAtMoveTime");
          return;
        }
        throw statError;
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
        const currentOriginalSha256 = await streamHashSha256(originalPath);
        if (currentOriginalSha256 !== compressedFile.originalSha256BeforeMove) {
          compressedFile.moveSkipReason = this.getMoveText("move.skip.externalModification");
          return;
        }
      }
      const vaultBasePath = this.getVaultBasePath();
      const originalRelativePath = normalizeVaultPath(path.relative(vaultBasePath, originalPath));
      const compressedRelativePath = normalizeVaultPath(path.relative(vaultBasePath, compressedFile.compressedPath));

      if (compressedFile.size >= originalStats.size) {
        if (compressedFile.size === originalStats.size && await this.filesHaveSameContent(compressedFile.compressedPath, originalPath)) {
          await this.plugin.cache.markProcessedFileSkippedIdentical(originalRelativePath, originalStats, originalStats.size, compressedRelativePath);
          try {
            await fs.promises.unlink(compressedFile.compressedPath);
          } catch (cleanupError) {
            console.error(getLogTag(this.plugin), `Compressed output cleanup failed for ${compressedFile.name}:`, getErrorMessage(cleanupError));
          }
          return;
        }
        throw new Error(`Compressed file is larger or equal to original: ${compressedFile.name}`);
      }

      const randomSuffix = await randomHexSuffix(16);
      tempOriginalPath = path.join(
        path.dirname(originalPath),
        `.${path.basename(originalPath)}.tinylocal-${Date.now()}-${randomSuffix}.tmp`
      );
      await fs.promises.copyFile(compressedFile.compressedPath, tempOriginalPath);
      const tempStats = await fs.promises.stat(tempOriginalPath);
      if (tempStats.size !== compressedFile.size) {
        throw new Error(`Staged compressed file size mismatch: ${compressedFile.name}`);
      }
      if (tempStats.size >= originalStats.size) {
        throw new Error(`Staged compressed file is larger or equal to original: ${compressedFile.name}`);
      }
      // BR-H1: the destructive overwrite must verify CONTENT, not just byte length. Re-hash the
      // staged temp bytes (the exact bytes that get renamed over the original) and compare to the
      // backup-verified compressedSha256, so a same-size-but-different-content compressed file
      // (corruption / sync substitution between backup and move) cannot silently replace the original.
      if (compressedFile.compressedSha256) {
        const stagedSha256 = await streamHashSha256(tempOriginalPath);
        if (stagedSha256 !== compressedFile.compressedSha256) {
          compressedFile.moveSkipReason = this.getMoveText("move.skip.externalModification");
          const message = t(this.plugin.app, "move.warning.externalModification", { name: compressedFile.name });
          new obsidian.Notice(`${getPluginName(this.plugin)}: ${message}`, 10000);
          console.warn(getLogTag(this.plugin), `Compressed content changed before move (hash mismatch): ${compressedFile.name}`);
          try {
            await fs.promises.unlink(tempOriginalPath);
            tempOriginalPath = null;
          } catch (cleanupError) {
            console.warn(getLogTag(this.plugin), `Temporary move cleanup failed for ${compressedFile.name}:`, cleanupError);
          }
          return;
        }
      }
      if (this.isUnloading()) {
        compressedFile.moveSkipReason = this.getMoveText("move.skip.unloading");
        try {
          await fs.promises.unlink(tempOriginalPath);
          tempOriginalPath = null;
        } catch (cleanupError) {
          console.warn(getLogTag(this.plugin), `Temporary move cleanup failed for ${compressedFile.name}:`, cleanupError);
        }
        return;
      }
      await fs.promises.rename(tempOriginalPath, originalPath);
      tempOriginalPath = null;

      const processedStats = await fs.promises.stat(originalPath);
      if (processedStats.size !== compressedFile.size) {
        compressedFile.moveSkipReason = this.getMoveText("move.skip.externalModification");
        const message = t(this.plugin.app, "move.warning.externalModification", { name: compressedFile.name });
        new obsidian.Notice(`${getPluginName(this.plugin)}: ${message}`, 10000);
        console.warn(getLogTag(this.plugin), `External modification detected during move: ${compressedFile.name}`);
        return;
      }
      await this.plugin.cache.markProcessedFileMoved(originalRelativePath, processedStats, originalStats.size, compressedRelativePath);
      try {
        await fs.promises.unlink(compressedFile.compressedPath);
      } catch (cleanupError) {
        console.error(getLogTag(this.plugin), `Compressed output cleanup failed for ${compressedFile.name}:`, getErrorMessage(cleanupError));
      }
    } catch (error) {
      if (tempOriginalPath) {
        try {
          await fs.promises.unlink(tempOriginalPath);
        } catch (cleanupError) {
          console.warn(getLogTag(this.plugin), `Temporary move cleanup failed for ${compressedFile.name}:`, cleanupError);
        }
      }
      console.error(getLogTag(this.plugin), `moveSingleFile error for ${compressedFile.name}:`, getErrorMessage(error));
      throw error;
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
      return normalizeVaultPathForComparison(await fs.promises.realpath(filePath));
    } catch {
      return normalizeVaultPathForComparison(path.resolve(filePath));
    }
  }

  async filesHaveSameContent(leftPath: string, rightPath: string) {
    const chunkSize = 64 * 1024;
    let leftHandle: fs.promises.FileHandle | null = null;
    let rightHandle: fs.promises.FileHandle | null = null;
    try {
      [leftHandle, rightHandle] = await Promise.all([
        fs.promises.open(leftPath, "r"),
        fs.promises.open(rightPath, "r")
      ]);
      const leftBuffer = Buffer.alloc(chunkSize);
      const rightBuffer = Buffer.alloc(chunkSize);
      let position = 0;
      while (true) {
        const [leftRead, rightRead] = await Promise.all([
          leftHandle.read(leftBuffer, 0, chunkSize, position),
          rightHandle.read(rightBuffer, 0, chunkSize, position)
        ]);
        if (leftRead.bytesRead !== rightRead.bytesRead) {
          return false;
        }
        if (leftRead.bytesRead === 0) {
          return true;
        }
        if (Buffer.compare(leftBuffer.subarray(0, leftRead.bytesRead), rightBuffer.subarray(0, rightRead.bytesRead)) !== 0) {
          return false;
        }
        position += leftRead.bytesRead;
      }
    } catch (error) {
      throw new Error(`Content comparison failed for ${path.basename(leftPath)} and ${path.basename(rightPath)}: ${getErrorMessage(error)}`);
    } finally {
      const closeWithLog = async (handle: fs.promises.FileHandle | null, label: string) => {
        try {
          await handle?.close();
        } catch (error) {
          console.warn(getLogTag(this.plugin), `Failed to close ${label} comparison handle:`, error);
        }
      };
      await Promise.all([
        closeWithLog(leftHandle, "left"),
        closeWithLog(rightHandle, "right")
      ]);
    }
  }

  async cleanupBackupTaskFiles(task: BackupPreflightTask) {
    const cleanupTargets = [task.backupFilePath, task.compressedBackupPath].filter((filePath): filePath is string => Boolean(filePath));
    await Promise.all(cleanupTargets.map(async (filePath) => {
      try {
        await fs.promises.unlink(filePath);
      } catch (error) {
        if (getErrorCode(error) !== "ENOENT") {
          console.warn(getLogTag(this.plugin), "Backup verification cleanup failed:", filePath, error);
        }
      }
    }));
  }

  showMoveProgressModal(totalFiles: number) {
    const pluginName = getPluginName(this.plugin);
    const owner = this.plugin;
    const modal = new class extends obsidian.Modal {
      totalFiles: number;
      currentFile: number;
      progressText!: HTMLElement;
      currentFileText!: HTMLElement;
      progressBar!: HTMLElement;
      progressFill!: HTMLElement;
      returnFocusTo: HTMLElement | null;

      constructor(app: obsidian.App, totalFiles: number) {
        super(app);
        this.totalFiles = totalFiles;
        this.currentFile = 0;
        this.returnFocusTo = owner.captureModalFocusTarget();
        this.titleEl.setText(`${pluginName}: ${t(this.app, "move.title")}`);
      }

      override onOpen() {
        const { contentEl } = this;
        contentEl.addClass("tiny-local-move-progress-modal");

        this.progressText = contentEl.createEl("p", {
          text: `${t(this.app, "progress.processing")}: 0 / ${this.totalFiles}`
        });
        this.progressText.setAttribute("role", "status");
        this.progressText.setAttribute("aria-live", "polite");
        this.progressText.setAttribute("aria-atomic", "true");

        this.currentFileText = contentEl.createEl("p", {
          text: t(this.app, "common.refresh")
        });

        this.progressBar = contentEl.createDiv({
          cls: "tiny-local-progress-bar"
        });
        this.progressBar.setAttribute("role", "progressbar");
        this.progressBar.setAttribute("aria-label", t(this.app, "move.title"));
        this.progressBar.setAttribute("aria-valuemin", "0");
        this.progressBar.setAttribute("aria-valuemax", String(this.totalFiles));
        this.progressBar.setAttribute("aria-valuenow", "0");
        this.progressBar.setAttribute("aria-valuetext", `${t(this.app, "progress.processing")}: 0 / ${this.totalFiles}`);

        this.progressFill = contentEl.createDiv({
          cls: "tiny-local-progress-fill"
        });

        this.progressBar.appendChild(this.progressFill);
        owner.scheduleElementFocus(this.modalEl.querySelector<HTMLElement>(".modal-close-button"));
      }

      updateProgress(current: number, total: number, fileName: string) {
        this.currentFile = current;
        const percentage = (current / total) * 100;

        this.progressText.setText(`${t(this.app, "progress.processing")}: ${current} / ${total}`);
        this.currentFileText.setText(`${t(this.app, "progress.processing")}: ${fileName}`);
        this.progressBar.setAttribute("aria-valuemax", String(Math.max(0, total)));
        this.progressBar.setAttribute("aria-valuenow", String(Math.max(0, Math.min(current, total))));
        this.progressBar.setAttribute("aria-valuetext", `${t(this.app, "progress.processing")}: ${current} / ${total}. ${fileName}`);
        // dynamic: required at runtime
        this.progressFill.setCssProps({
          "--local-image-compress-progress-width": `${percentage}%`
        });
      }

      override onClose() {
        const { contentEl } = this;
        owner.untrackManagedModal(this);
        contentEl.empty();
        owner.restoreModalFocus(this.returnFocusTo);
      }
    }(this.plugin.app, totalFiles);

    this.plugin.trackManagedModal(modal);
    modal.open();
    return modal;
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
    const pluginName = getPluginName(this.plugin);
    const owner = this.plugin;
    const skipReasonGroups = this.getMoveSkipReasonGroups(compressedFiles);
    const groupedSkippedCount = skipReasonGroups.reduce((total, group) => total + group.count, 0);
    const displaySkippedCount = groupedSkippedCount > 0 ? groupedSkippedCount : skippedCount;
    const modal = new class extends obsidian.Modal {
      successCount: number;
      errorCount: number;
      backupCreated: boolean;
      skippedCount: number;
      skipReasonGroups: Array<{ reason: string; count: number }>;
      listenerCleanups: Array<() => void>;
      returnFocusTo: HTMLElement | null;

      constructor(
        app: obsidian.App,
        successCount: number,
        errorCount: number,
        backupCreated: boolean,
        skippedCount: number,
        skipReasonGroups: Array<{ reason: string; count: number }>
      ) {
        super(app);
        this.successCount = successCount;
        this.errorCount = errorCount;
        this.backupCreated = backupCreated;
        this.skippedCount = skippedCount;
        this.skipReasonGroups = skipReasonGroups;
        this.listenerCleanups = [];
        this.returnFocusTo = owner.captureModalFocusTarget();
        this.titleEl.setText(`${pluginName}: ${t(this.app, "move.title")}`);
      }

      override onOpen() {
        const { contentEl } = this;
        contentEl.addClass("tiny-local-move-result-modal");

        if (this.successCount > 0) {
          contentEl.createEl("p", {
            text: `\u2705 ${t(this.app, "move.button")}: ${this.successCount}`,
            cls: "tiny-local-success"
          });
        }

        if (this.errorCount > 0) {
          contentEl.createEl("p", {
            text: `\u274C ${t(this.app, "progress.error")}: ${this.errorCount}`,
            cls: "tiny-local-error"
          });
        }

        if (this.skippedCount > 0) {
          contentEl.createEl("p", {
            text: `${t(this.app, "progress.skipped")}: ${this.skippedCount}`,
            cls: "tiny-local-info"
          });
          if (this.skipReasonGroups.length > 0) {
            const reasonList = contentEl.createEl("ul", {
              cls: "tiny-local-move-skip-reasons"
            });
            for (const group of this.skipReasonGroups) {
              reasonList.createEl("li", {
                text: `${group.reason}: ${group.count}`
              });
            }
          }
        }

        if (this.backupCreated) {
          contentEl.createEl("p", {
            text: `\u{1F4BE} ${t(this.app, "move.backupCreated")}`,
            cls: "tiny-local-info"
          });
        }

        const closeButton = contentEl.createEl("button", {
          text: t(this.app, "common.close"),
          cls: "mod-cta"
        });
        closeButton.type = "button";
        closeButton.setAttribute("aria-label", t(this.app, "common.close"));

        const onCloseClick = () => {
          this.close();
        };
        // modal-scoped: cleaned in onClose() — registerDomEvent unavailable on Modal
        closeButton.addEventListener("click", onCloseClick);
        this.listenerCleanups.push(() => closeButton.removeEventListener("click", onCloseClick));
        owner.scheduleElementFocus(closeButton);
      }

      override onClose() {
        const { contentEl } = this;
        for (const cleanup of this.listenerCleanups) {
          cleanup();
        }
        this.listenerCleanups = [];
        owner.untrackManagedModal(this);
        contentEl.empty();
        owner.restoreModalFocus(this.returnFocusTo);
      }
    }(this.plugin.app, successCount, errorCount, backupCreated, displaySkippedCount, skipReasonGroups);

    this.plugin.trackManagedModal(modal);
    modal.open();
  }

  async deleteDirectoryRecursiveAsync(dirPath: string) {
    try {
      const entries = await fs.promises.readdir(dirPath);
      for (const entry of entries) {
        const curPath = path.join(dirPath, entry);
        const stats = await fs.promises.lstat(curPath);
        if (stats.isDirectory()) {
          await this.deleteDirectoryRecursiveAsync(curPath);
        } else {
          try {
            await fs.promises.unlink(curPath);
          } catch (e) {
            console.warn("Failed to delete file:", curPath, e);
          }
        }
      }
      try {
        await fs.promises.rmdir(dirPath);
      } catch (e) {
        console.warn("Failed to remove directory:", dirPath, e);
      }
    } catch (e) {
      console.warn("Failed to remove directory tree:", dirPath, e);
    }
  }
}
