import * as obsidian from "obsidian";
import type { default as LocalImageCompressPlugin } from "../plugin";
import { getErrorCode, getLogTag, getPluginName, isSafeVaultRelativePath, normalizeVaultPath, vaultBasename } from "../utils";
import { t } from "../i18n";

type MigrationQuarantineJournal = {
  version: 1;
  transactionId: string;
  sourcePath: string;
  destinationPath: string;
  quarantinePath: string;
  sourceSha256: string;
  checksum: string;
};

type MigrationRecoveryResult = {
  status: "completed" | "completed-retained" | "restored" | "retained";
  quarantinePath: string;
};

type MigrationItem = {
  item: string;
  src: string;
  dest: string;
};

const MIGRATION_JOURNAL_PATTERN = /^migration-quarantine-v1-[a-f0-9]{32}\.json$/i;
const MIGRATION_QUARANTINE_DIRECTORY_PATTERN = /^\.tinylocal-quarantine-\d+-([a-f0-9]{32})\.tmp$/i;

export class MigrationRunner {
  constructor(private readonly plugin: LocalImageCompressPlugin) {}

  private ports() {
    return this.plugin.getPlatformPorts();
  }

  async filesystemPathExists(filePath: string) {
    return await this.ports().fs.exists(filePath);
  }

  private getRecoveryDirectory() {
    return this.ports().fs.joinPath(this.toVaultRelativePath(this.plugin.getBackupStoragePaths().root), "recovery");
  }

  private getMigrationItems(): MigrationItem[] {
    const ports = this.ports();
    const configDir = this.plugin.app.vault.configDir;
    const oldDir = normalizeVaultPath(`${configDir}/plugins/tiny-local`);
    const newDir = normalizeVaultPath(`${configDir}/plugins/local-image-compress`);
    const backupPaths = this.plugin.getBackupStoragePaths();
    const cacheBackups = this.toVaultRelativePath(backupPaths.cacheBackups);
    const originalFilesBackups = this.toVaultRelativePath(backupPaths.originalFilesBackups);
    return [
      {
        item: "legacy cache file",
        src: ports.fs.joinPath(oldDir, "tinyLocal-cache.json"),
        dest: ports.fs.joinPath(newDir, "tinyLocal-cache.json")
      },
      {
        item: "legacy cache backups",
        src: ports.fs.joinPath(oldDir, "cache-backups"),
        dest: cacheBackups
      },
      {
        item: "legacy original-file backups",
        src: ports.fs.joinPath(oldDir, "original-files-backups"),
        dest: originalFilesBackups
      },
      {
        item: "cache backups",
        src: ports.fs.joinPath(newDir, "cache-backups"),
        dest: cacheBackups
      },
      {
        item: "original-file backups",
        src: ports.fs.joinPath(newDir, "original-files-backups"),
        dest: originalFilesBackups
      }
    ];
  }

  private toVaultRelativePath(filePath: string) {
    const relativePath = normalizeVaultPath(filePath);
    if (!isSafeVaultRelativePath(relativePath)) {
      throw new Error(`Migration recovery path is outside the Vault: ${filePath}`);
    }
    return relativePath;
  }

  private getJournalChecksum(journal: Omit<MigrationQuarantineJournal, "checksum">) {
    return this.ports().hash.sha256Hex(JSON.stringify({
      version: journal.version,
      transactionId: journal.transactionId,
      sourcePath: journal.sourcePath,
      destinationPath: journal.destinationPath,
      quarantinePath: journal.quarantinePath,
      sourceSha256: journal.sourceSha256
    }));
  }

  private async parseMigrationJournal(journalPath: string): Promise<MigrationQuarantineJournal> {
    const raw = JSON.parse(await this.ports().fs.readText(journalPath)) as Partial<MigrationQuarantineJournal>;
    const sourcePath = normalizeVaultPath(raw.sourcePath || "");
    const destinationPath = normalizeVaultPath(raw.destinationPath || "");
    const quarantinePath = normalizeVaultPath(raw.quarantinePath || "");
    const transactionId = raw.transactionId || "";
    const sourceSha256 = raw.sourceSha256 || "";
    const checksum = raw.checksum || "";
    if (raw.version !== 1
      || !/^[a-f0-9]{32}$/i.test(transactionId)
      || !/^[a-f0-9]{64}$/i.test(sourceSha256)
      || !/^[a-f0-9]{64}$/i.test(checksum)
      || !isSafeVaultRelativePath(sourcePath)
      || !isSafeVaultRelativePath(destinationPath)
      || !isSafeVaultRelativePath(quarantinePath)
      || vaultBasename(quarantinePath) !== vaultBasename(sourcePath)) {
      throw new Error(`Invalid migration quarantine journal: ${journalPath}`);
    }
    const quarantineDirectory = normalizeVaultPath(this.ports().fs.dirnamePath(quarantinePath));
    const quarantineParent = normalizeVaultPath(this.ports().fs.dirnamePath(quarantineDirectory));
    const sourceParent = normalizeVaultPath(this.ports().fs.dirnamePath(sourcePath));
    const quarantineMatch = /^\.tinylocal-quarantine-\d+-([a-f0-9]{32})\.tmp$/i.exec(vaultBasename(quarantineDirectory));
    const expectedJournalName = `migration-quarantine-v1-${transactionId.toLowerCase()}.json`;
    const journalRelativePath = this.toVaultRelativePath(journalPath);
    const recoveryRelativePath = this.toVaultRelativePath(this.getRecoveryDirectory());
    if (quarantineParent !== sourceParent
      || quarantineMatch?.[1]?.toLowerCase() !== transactionId.toLowerCase()
      || vaultBasename(journalRelativePath).toLowerCase() !== expectedJournalName
      || normalizeVaultPath(this.ports().fs.dirnamePath(journalRelativePath)) !== recoveryRelativePath) {
      throw new Error(`Migration quarantine journal does not own its paths: ${journalPath}`);
    }
    const journalWithoutChecksum = {
      version: 1 as const,
      transactionId,
      sourcePath,
      destinationPath,
      quarantinePath,
      sourceSha256: sourceSha256.toLowerCase()
    };
    const expectedChecksum = this.getJournalChecksum(journalWithoutChecksum);
    if (expectedChecksum !== checksum.toLowerCase()) {
      throw new Error(`Migration quarantine journal checksum mismatch: ${journalPath}`);
    }
    return { ...journalWithoutChecksum, checksum: expectedChecksum };
  }

  private async writeMigrationJournal(sourcePath: string, destinationPath: string, quarantinePath: string, sourceSha256: string) {
    const ports = this.ports();
    const recoveryDirectory = this.getRecoveryDirectory();
    await ports.fs.mkdir(recoveryDirectory);
    const quarantineDirectory = ports.fs.dirnamePath(quarantinePath);
    const quarantineMatch = /^\.tinylocal-quarantine-\d+-([a-f0-9]{32})\.tmp$/i.exec(vaultBasename(quarantineDirectory));
    const transactionId = quarantineMatch?.[1]?.toLowerCase();
    if (!transactionId) {
      throw new Error(`Migration quarantine does not expose a transaction identity: ${quarantinePath}`);
    }
    const journalPath = ports.fs.joinPath(recoveryDirectory, `migration-quarantine-v1-${transactionId}.json`);
    const journalWithoutChecksum = {
      version: 1 as const,
      transactionId,
      sourcePath: this.toVaultRelativePath(sourcePath),
      destinationPath: this.toVaultRelativePath(destinationPath),
      quarantinePath: this.toVaultRelativePath(quarantinePath),
      sourceSha256: sourceSha256.toLowerCase()
    };
    const journal: MigrationQuarantineJournal = {
      ...journalWithoutChecksum,
      checksum: this.getJournalChecksum(journalWithoutChecksum)
    };
    const serialized = JSON.stringify(journal);
    if (ports.fs.writeExclusive) {
      if (!await ports.fs.writeExclusive(journalPath, serialized)) {
        throw new Error(`Migration quarantine journal already exists: ${journalPath}`);
      }
    } else {
      if (await ports.fs.exists(journalPath)) {
        throw new Error(`Migration quarantine journal already exists: ${journalPath}`);
      }
      await ports.fs.writeText(journalPath, serialized);
    }
    await ports.fs.fsyncBestEffort(journalPath);
    const verified = await this.parseMigrationJournal(journalPath);
    if (verified.transactionId !== transactionId || verified.quarantinePath !== journal.quarantinePath) {
      throw new Error(`Migration quarantine journal readback failed: ${journalPath}`);
    }
    return journalPath;
  }

  private async isOwnedMigrationQuarantineDirectory(directoryPath: string): Promise<boolean> {
    const transactionId = MIGRATION_QUARANTINE_DIRECTORY_PATTERN.exec(vaultBasename(directoryPath))?.[1]?.toLowerCase();
    if (!transactionId) {
      return false;
    }
    const journalPath = this.ports().fs.joinPath(
      this.getRecoveryDirectory(),
      `migration-quarantine-v1-${transactionId}.json`
    );
    if (!await this.ports().fs.exists(journalPath)) {
      return false;
    }
    try {
      const journal = await this.parseMigrationJournal(journalPath);
      return normalizeVaultPath(this.ports().fs.dirnamePath(journal.quarantinePath))
        === normalizeVaultPath(this.toVaultRelativePath(directoryPath));
    } catch (error) {
      console.warn(getLogTag(this.plugin), "Invalid migration quarantine was not skipped:", directoryPath, error);
      return false;
    }
  }

  private async directoryContainsOnlyOwnedQuarantines(directoryPath: string): Promise<boolean> {
    const remaining = await this.ports().fs.listEntries(directoryPath);
    if (remaining.length === 0) {
      return false;
    }
    const ownership = await Promise.all(remaining.map(async (entry) =>
      entry.isDirectory
      && !entry.isSymbolicLink
      && await this.isRetainedMigrationRecoveryDirectory(this.ports().fs.joinPath(directoryPath, entry.name))
    ));
    return ownership.every(Boolean);
  }

  private async isRetainedMigrationRecoveryDirectory(directoryPath: string): Promise<boolean> {
    return await this.isOwnedMigrationQuarantineDirectory(directoryPath)
      || await this.directoryContainsOnlyOwnedQuarantines(directoryPath);
  }

  private async getFileSha256IfPresent(filePath: string): Promise<string | null> {
    try {
      const stat = await this.ports().fs.lstat(filePath);
      if (!stat.isFile || stat.isSymbolicLink) {
        return null;
      }
      return await this.ports().hash.fileSha256Hex(filePath);
    } catch (error) {
      if (!await this.ports().fs.exists(filePath)) {
        return null;
      }
      throw error;
    }
  }

  private async removeMigrationJournalIfUnchanged(journalPath: string): Promise<boolean> {
    const expectedSha256 = await this.getFileSha256IfPresent(journalPath);
    if (!expectedSha256) {
      return true;
    }
    const result = await this.ports().fs.removeFileIfUnchanged(journalPath, expectedSha256);
    if (result.retainedConflictPath) {
      console.warn(getLogTag(this.plugin), "Migration journal cleanup conflict retained:", result.retainedConflictPath);
    }
    return result.removed;
  }

  private async recoverMigrationJournal(journalPath: string): Promise<MigrationRecoveryResult> {
    const journal = await this.parseMigrationJournal(journalPath);
    const ports = this.ports();
    const sourcePath = journal.sourcePath;
    const destinationPath = journal.destinationPath;
    const quarantinePath = journal.quarantinePath;
    // Mobile reads whole files, so classify sequentially until the shared byte-budget
    // owns all buffered operations. Desktop hashing remains streaming.
    const quarantineSha256 = await this.getFileSha256IfPresent(quarantinePath);
    const sourceSha256 = await this.getFileSha256IfPresent(sourcePath);
    const destinationSha256 = await this.getFileSha256IfPresent(destinationPath);
    if (quarantineSha256 && quarantineSha256 !== journal.sourceSha256) {
      if (sourceSha256 === null) {
        await ports.fs.copyFile(quarantinePath, sourcePath, { exclusive: true });
        if (await this.getFileSha256IfPresent(sourcePath) !== quarantineSha256) {
          throw new Error(`Migration conflict restore verification failed: ${sourcePath}`);
        }
        // The captured bytes are restored, but the quarantine remains as the
        // durable owner: Sync may replace source immediately after readback.
        return { status: "retained", quarantinePath };
      }
      return { status: "retained", quarantinePath };
    }
    if (quarantineSha256) {
      if (sourceSha256 === journal.sourceSha256 || destinationSha256 === journal.sourceSha256) {
        // A mutable canonical source/destination is not durable proof for
        // deleting the last transaction-owned copy. The one-time migration is
        // logically complete, but its exact quarantine and journal stay as the
        // safety record until the platform exposes a multi-path CAS primitive.
        return { status: "completed-retained", quarantinePath };
      }
      if (sourceSha256 === null) {
        await ports.fs.copyFile(quarantinePath, sourcePath, { exclusive: true });
        if (await this.getFileSha256IfPresent(sourcePath) !== journal.sourceSha256) {
          throw new Error(`Migration quarantine restore verification failed: ${sourcePath}`);
        }
        // Retain the second verified copy and journal: Sync can replace the
        // canonical path immediately after readback, so deleting quarantine
        // here would recreate the same check-await-delete loss window.
        return { status: "retained", quarantinePath };
      }
      return { status: "retained", quarantinePath };
    }
    if (sourceSha256 === journal.sourceSha256 || destinationSha256 === journal.sourceSha256) {
      return {
        status: await this.removeMigrationJournalIfUnchanged(journalPath) ? "completed" : "completed-retained",
        quarantinePath
      };
    }
    return { status: "retained", quarantinePath };
  }

  async recoverMigrationQuarantineJournals(): Promise<void> {
    const recoveryDirectory = this.getRecoveryDirectory();
    if (!await this.ports().fs.exists(recoveryDirectory)) {
      return;
    }
    const entries = await this.ports().fs.listEntries(recoveryDirectory);
    for (const entry of entries) {
      if (!entry.isFile || !MIGRATION_JOURNAL_PATTERN.test(entry.name)) {
        continue;
      }
      const journalPath = this.ports().fs.joinPath(recoveryDirectory, entry.name);
      try {
        const result = await this.recoverMigrationJournal(journalPath);
        if (result.status === "retained") {
          console.warn(getLogTag(this.plugin), "Ambiguous migration quarantine retained:", result.quarantinePath);
        }
      } catch (error) {
        console.error(getLogTag(this.plugin), "Migration quarantine journal retained after recovery failure:", journalPath, error);
      }
    }
  }

  async copyMigrationItem(src: string, dest: string): Promise<void> {
    const ports = this.ports();
    const stat = await ports.fs.lstat(src);
    if (stat.isSymbolicLink) {
      throw new Error(`Migration source must not be a symbolic link: ${src}`);
    }
    if (!stat.isDirectory) {
      await ports.fs.mkdir(ports.fs.dirnamePath(dest));
      await ports.fs.copyFile(src, dest, { exclusive: true });
      return;
    }
    await ports.fs.mkdir(dest);
    for (const entry of await ports.fs.listEntries(src)) {
      const sourcePath = ports.fs.joinPath(src, entry.name);
      if (entry.isDirectory && !entry.isSymbolicLink && await this.isRetainedMigrationRecoveryDirectory(sourcePath)) {
        continue;
      }
      await this.copyMigrationItem(sourcePath, ports.fs.joinPath(dest, entry.name));
    }
  }

  async validateMigrationItemForPlatform(src: string): Promise<void> {
    const ports = this.ports();
    const stat = await ports.fs.lstat(src);
    if (stat.isSymbolicLink || (!stat.isFile && !stat.isDirectory)) {
      throw new Error(`Migration source must be a regular file or directory: ${src}`);
    }
    const bufferedLimit = ports.runtime.maxBufferedFileBytes;
    if (stat.isFile) {
      if (bufferedLimit !== null && stat.size > bufferedLimit) {
        throw new Error(`Migration source exceeds the mobile maintenance limit and was left unchanged: ${src}`);
      }
      return;
    }
    for (const entry of await ports.fs.listEntries(src)) {
      const sourcePath = ports.fs.joinPath(src, entry.name);
      if (entry.isDirectory && !entry.isSymbolicLink && await this.isRetainedMigrationRecoveryDirectory(sourcePath)) {
        continue;
      }
      await this.validateMigrationItemForPlatform(sourcePath);
    }
  }

  async verifyMigrationItem(src: string, dest: string): Promise<void> {
    const ports = this.ports();
    const [sourceStat, destinationStat] = await Promise.all([
      ports.fs.lstat(src),
      ports.fs.lstat(dest)
    ]);
    if (sourceStat.isSymbolicLink || destinationStat.isSymbolicLink) {
      throw new Error(`Migration verification rejected a symbolic link: ${src}`);
    }
    if (sourceStat.isDirectory !== destinationStat.isDirectory) {
      throw new Error(`Migration source and destination types differ: ${src}`);
    }
    if (!sourceStat.isDirectory) {
      if (sourceStat.size !== destinationStat.size || !await this.plugin.moveService.filesHaveSameContent(src, dest)) {
        throw new Error(`Migration copy verification failed: ${src}`);
      }
      return;
    }
    for (const entry of await ports.fs.listEntries(src)) {
      const sourcePath = ports.fs.joinPath(src, entry.name);
      if (entry.isDirectory && !entry.isSymbolicLink && await this.isRetainedMigrationRecoveryDirectory(sourcePath)) {
        continue;
      }
      await this.verifyMigrationItem(sourcePath, ports.fs.joinPath(dest, entry.name));
    }
  }

  async moveOrCopyMigrationItem(src: string, dest: string): Promise<void> {
    const ports = this.ports();
    await ports.fs.mkdir(ports.fs.dirnamePath(dest));
    const sourceStat = await ports.fs.lstat(src);
    if (sourceStat.isSymbolicLink) {
      throw new Error(`Migration source must not be a symbolic link: ${src}`);
    }
    if (!sourceStat.isFile && !sourceStat.isDirectory) {
      throw new Error(`Migration source must be a regular file or directory: ${src}`);
    }
    await this.validateMigrationItemForPlatform(src);
    await this.copyMigrationItem(src, dest);
    await this.verifyMigrationItem(src, dest);
    // Reconcile again before deletion. Files are quarantined before comparison;
    // directories are removed only non-recursively, so late sync writes survive.
    await this.mergeMigrationItem(src, dest);
  }

  async mergeMigrationItem(src: string, dest: string): Promise<void> {
    const ports = this.ports();
    if (!await this.filesystemPathExists(src)) {
      return;
    }
    if (!await this.filesystemPathExists(dest)) {
      await this.moveOrCopyMigrationItem(src, dest);
      return;
    }
    const [sourceStat, destinationStat] = await Promise.all([
      ports.fs.lstat(src),
      ports.fs.lstat(dest)
    ]);
    if (sourceStat.isSymbolicLink || destinationStat.isSymbolicLink) {
      throw new Error(`Migration merge rejected a symbolic link: ${src}`);
    }
    if (sourceStat.isDirectory && destinationStat.isDirectory) {
      for (const entry of await ports.fs.listEntries(src)) {
        const sourcePath = ports.fs.joinPath(src, entry.name);
        if (entry.isDirectory && !entry.isSymbolicLink && await this.isRetainedMigrationRecoveryDirectory(sourcePath)) {
          continue;
        }
        await this.mergeMigrationItem(sourcePath, ports.fs.joinPath(dest, entry.name));
      }
      try {
        await ports.fs.removeDir(src, { recursive: false, force: false });
      } catch (error) {
        if (getErrorCode(error) === "ENOTEMPTY" && await this.directoryContainsOnlyOwnedQuarantines(src)) {
          return;
        }
        throw error;
      }
      return;
    }
    if (!sourceStat.isDirectory && !destinationStat.isDirectory) {
      const sourceSha256 = await ports.hash.fileSha256Hex(src);
      let journalPath: string | null = null;
      let quarantinePath: string;
      try {
        quarantinePath = await ports.fs.moveFileToUniqueSibling(src, {
          beforeMove: async (reservedQuarantinePath) => {
            journalPath = await this.writeMigrationJournal(src, dest, reservedQuarantinePath, sourceSha256);
          }
        });
      } catch (error) {
        if (journalPath) {
          await this.recoverMigrationJournal(journalPath).catch((recoveryError) => {
            console.error(getLogTag(this.plugin), "Migration quarantine recovery after move failure failed:", recoveryError);
          });
        }
        throw error;
      }
      const writtenJournalPath = journalPath;
      if (!writtenJournalPath) {
        throw new Error(`Migration quarantine was created without a durable journal: ${quarantinePath}`);
      }
      const recoveryResult = await this.recoverMigrationJournal(writtenJournalPath);
      if (recoveryResult.status === "restored") {
        throw new Error(`Migration destination already contains a different file; source restored at: ${src}`);
      }
      if (recoveryResult.status === "retained") {
        throw new Error(`Migration destination already contains a different file; source retained at: ${recoveryResult.quarantinePath}`);
      }
      return;
    }
    throw new Error(`Migration source and destination types differ: ${src}`);
  }

  async migrateLegacyPluginData() {
    try {
      const ports = this.ports();
      const migrationItems = this.getMigrationItems();
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
      const legacyPluginDir = ports.fs.dirnamePath(migrationItems[0]?.src || "");
      if (legacyPluginDir && await this.filesystemPathExists(legacyPluginDir)) {
        await ports.fs.removeDir(legacyPluginDir, { recursive: false, force: false }).catch(() => undefined);
      }
    } catch (e) {
      console.error(getLogTag(this.plugin), 'Startup migration error:', e);
    }
  }
}
