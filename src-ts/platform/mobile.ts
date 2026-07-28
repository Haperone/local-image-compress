import { md5 } from "js-md5";
import { sha256 } from "js-sha256";
import { Platform, type App, type DataAdapter, type Vault } from "obsidian";
import { MOBILE_MAX_INPUT_SIZE_MB } from "../settings";
import { getErrorMessage, getVaultFolderPath, isSafeVaultRelativePath, normalizeVaultPath, normalizeVaultPathRoot, randomHexSuffix, vaultBasename } from "../utils";
import type { BufferedOperationToken, FsDirEntry, FsLstat, FsPort, FsStat, HashPort, MoveFileToUniqueSiblingOptions, PlatformPorts, RemoveFileIfUnchangedResult, ReplaceFileOptions, RuntimePort } from "./ports";

// Mobile port implementations on top of the vault DataAdapter. Paths stay
// vault-relative; there is no Node runtime, no synchronous filesystem and no
// OS shell on this platform.

const MOBILE_MAX_BUFFERED_FILE_BYTES = MOBILE_MAX_INPUT_SIZE_MB * 1024 * 1024;
const REPLACEMENT_JOURNAL_DIR = ".local-image-compress/recovery";
const LEGACY_REPLACEMENT_JOURNAL_PATH = `${REPLACEMENT_JOURNAL_DIR}/mobile-replacement-journal-v1.json`;
const LEGACY_REPLACEMENT_JOURNAL_FILE_PATTERN = /^mobile-replacement-journal-v1-[a-f0-9]{64}\.json$/i;
const REPLACEMENT_JOURNAL_FILE_PATTERN = /^mobile-replacement-journal-v2-[a-f0-9]{32}-[a-f0-9]{32}\.json$/i;
const CLEANUP_JOURNAL_FILE_PATTERN = /^mobile-cleanup-journal-v1-[a-f0-9]{32}-[a-f0-9]{32}\.json$/i;
const MOBILE_DEVICE_OWNER_STORAGE_KEY = "local-image-compress:device-owner-v1";
const MOBILE_DEVICE_ID_PATTERN = /^[a-f0-9]{32}$/i;
const MOBILE_REPLACEMENT_QUEUE_KEY = "local-image-compress:replacement";
const MOBILE_BUFFERED_OPERATION_QUEUE_KEY = "local-image-compress:buffered-operation";
const MOBILE_QUEUE_SYMBOL = Symbol.for("local-image-compress.mobile-path-queues");
const MOBILE_BUFFERED_STATE_SYMBOL = Symbol.for("local-image-compress.mobile-buffered-state");

type MobileReplacementJournal = {
  version: 2;
  ownerId: string;
  transactionId: string;
  stagedPath: string;
  targetPath: string;
  rollbackPath: string | null;
  stagedSha256: string;
  expectedTargetSha256: string | null;
  rollbackSha256: string | null;
  phase: "prepared" | "detached" | "installed";
};

type StoredMobileReplacementJournal = MobileReplacementJournal & {
  checksum: string;
};

type MobileCleanupJournal = {
  version: 1;
  ownerId: string;
  transactionId: string;
  sourcePath: string;
  quarantinePath: string;
  expectedSha256: string;
};

type StoredMobileCleanupJournal = MobileCleanupJournal & {
  checksum: string;
};

type MobileQueueWindow = Window & {
  [MOBILE_QUEUE_SYMBOL]?: Map<string, Promise<void>>;
  [MOBILE_BUFFERED_STATE_SYMBOL]?: { activeToken: BufferedOperationToken | null };
};

function getMobilePathQueues(): Map<string, Promise<void>> {
  const sharedWindow = window as MobileQueueWindow;
  return (sharedWindow[MOBILE_QUEUE_SYMBOL] ??= new Map<string, Promise<void>>());
}

function getMobileBufferedState() {
  const sharedWindow = window as MobileQueueWindow;
  return (sharedWindow[MOBILE_BUFFERED_STATE_SYMBOL] ??= { activeToken: null });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getUtf8ByteLength(value: string): number {
  let byteLength = 0;
  for (let index = 0; index < value.length; index++) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit < 0x80) {
      byteLength += 1;
    } else if (codeUnit < 0x800) {
      byteLength += 2;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff
      && index + 1 < value.length
      && value.charCodeAt(index + 1) >= 0xdc00
      && value.charCodeAt(index + 1) <= 0xdfff) {
      byteLength += 4;
      index += 1;
    } else {
      byteLength += 3;
    }
    if (byteLength > MOBILE_MAX_BUFFERED_FILE_BYTES) {
      return byteLength;
    }
  }
  return byteLength;
}

function getOrCreateMobileDeviceOwnerId(): string | null {
  try {
    const existing = window.localStorage.getItem(MOBILE_DEVICE_OWNER_STORAGE_KEY);
    if (existing && MOBILE_DEVICE_ID_PATTERN.test(existing)) {
      return existing.toLowerCase();
    }
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    const ownerId = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    window.localStorage.setItem(MOBILE_DEVICE_OWNER_STORAGE_KEY, ownerId);
    return window.localStorage.getItem(MOBILE_DEVICE_OWNER_STORAGE_KEY) === ownerId ? ownerId : null;
  } catch (error) {
    console.error("[Local Image Compress] Device-local recovery identity is unavailable:", error);
    return null;
  }
}

async function runInMobilePathQueue<T>(pathKey: string, operation: () => Promise<T>): Promise<T> {
  const queues = getMobilePathQueues();
  const previous = queues.get(pathKey) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.catch(() => undefined).then(() => current);
  queues.set(pathKey, queued);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(pathKey) === queued) {
      queues.delete(pathKey);
    }
  }
}

async function runInMobileBufferedOperation<T>(operation: (token: BufferedOperationToken) => Promise<T>, token?: BufferedOperationToken): Promise<T> {
  const state = getMobileBufferedState();
  if (token) {
    if (state.activeToken !== token) {
      throw new Error("Invalid or expired mobile buffered-operation token");
    }
    return await operation(token);
  }
  return await runInMobilePathQueue(MOBILE_BUFFERED_OPERATION_QUEUE_KEY, async () => {
    const nextToken = {} as BufferedOperationToken;
    state.activeToken = nextToken;
    try {
      return await operation(nextToken);
    } finally {
      if (state.activeToken === nextToken) {
        state.activeToken = null;
      }
    }
  });
}

class MobileFsPort implements FsPort {
  readonly sync = null;
  readonly restoreProbe = null;
  readonly lease = null;
  readonly writeExclusive = null;

  private readonly deviceOwnerId = getOrCreateMobileDeviceOwnerId();

  private readonly adapter: DataAdapter;

  constructor(private readonly vault: Vault) {
    this.adapter = vault.adapter;
  }

  async runBufferedOperation<T>(operation: (token: BufferedOperationToken) => Promise<T>, token?: BufferedOperationToken): Promise<T> {
    return await runInMobileBufferedOperation(operation, token);
  }

  private resolve(filePath: string): string {
    const normalized = normalizeVaultPath(filePath);
    if (normalized && !isSafeVaultRelativePath(normalized)) {
      throw new Error(`Mobile FsPort requires a vault-relative path: ${filePath}`);
    }
    return normalizeVaultPathRoot(normalized);
  }

  resolvePath(filePath: string): string {
    return this.resolve(filePath);
  }

  joinPath(...segments: string[]): string {
    return this.resolve(segments.filter((segment) => segment !== "").join("/"));
  }

  dirnamePath(filePath: string): string {
    return getVaultFolderPath(this.resolve(filePath));
  }

  canonicalizePath(filePath: string): string {
    return this.resolve(filePath);
  }

  toVaultRelativePath(filePath: string): string {
    return this.resolve(filePath);
  }

  getDisplayPath(filePath: string): string {
    return this.resolve(filePath);
  }

  async exists(filePath: string): Promise<boolean> {
    return await this.adapter.exists(this.resolve(filePath));
  }

  async mkdir(dirPath: string): Promise<void> {
    // Adapter mkdir is not reliably recursive; create each segment and
    // tolerate a concurrent create.
    const parts = this.resolve(dirPath).split("/").filter(Boolean);
    let currentPath = "";
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (await this.adapter.exists(currentPath)) {
        continue;
      }
      try {
        await this.adapter.mkdir(currentPath);
      } catch (error) {
        if (!await this.adapter.exists(currentPath)) {
          throw error;
        }
      }
    }
  }

  async readText(filePath: string, bufferedOperationToken?: BufferedOperationToken): Promise<string> {
    return await this.runBufferedOperation(async () => {
      await this.requireBufferedFile(filePath, "Text read source");
      const text = await this.adapter.read(this.resolve(filePath));
      if (getUtf8ByteLength(text) > MOBILE_MAX_BUFFERED_FILE_BYTES) {
        throw new Error(`Text read source exceeds the mobile ${MOBILE_MAX_INPUT_SIZE_MB} MB maintenance limit after read: ${filePath}`);
      }
      return text;
    }, bufferedOperationToken);
  }

  async writeText(filePath: string, text: string): Promise<void> {
    await this.adapter.write(this.resolve(filePath), text);
  }

  async readBinary(filePath: string, bufferedOperationToken?: BufferedOperationToken): Promise<ArrayBuffer> {
    return await this.runBufferedOperation(async () => {
      await this.requireBufferedFile(filePath, "Binary read source");
      const data = await this.adapter.readBinary(this.resolve(filePath));
      if (data.byteLength > MOBILE_MAX_BUFFERED_FILE_BYTES) {
        throw new Error(`Binary read source exceeds the mobile ${MOBILE_MAX_INPUT_SIZE_MB} MB maintenance limit after read: ${filePath}`);
      }
      return data;
    }, bufferedOperationToken);
  }

  async writeBinary(filePath: string, data: ArrayBuffer, bufferedOperationToken?: BufferedOperationToken): Promise<void> {
    await this.runBufferedOperation(async () => {
      if (data.byteLength > MOBILE_MAX_BUFFERED_FILE_BYTES) {
        throw new Error(`Binary write exceeds the mobile ${MOBILE_MAX_INPUT_SIZE_MB} MB maintenance limit: ${filePath}`);
      }
      await this.adapter.writeBinary(this.resolve(filePath), data);
    }, bufferedOperationToken);
  }

  async copyFile(sourcePath: string, targetPath: string, options?: {
    exclusive?: boolean;
    bufferedOperationToken?: BufferedOperationToken;
  }): Promise<void> {
    if (options?.exclusive !== true) {
      throw new Error("Mobile copy requires an exclusive target; overwrite copy is unsupported.");
    }
    await this.copyFileExclusive(sourcePath, targetPath, options.bufferedOperationToken);
  }

  async moveFileToUniqueSibling(sourcePath: string, options?: MoveFileToUniqueSiblingOptions): Promise<string> {
    const source = this.resolve(sourcePath);
    const sourceStat = await this.requireBufferedFile(source, "Quarantine source");
    for (let attempt = 0; attempt < 8; attempt++) {
      const quarantineDir = this.joinPath(
        this.dirnamePath(source),
        `.tinylocal-quarantine-${Date.now()}-${await randomHexSuffix(16)}.tmp`
      );
      if (await this.adapter.exists(quarantineDir)) {
        continue;
      }
      try {
        await this.adapter.mkdir(quarantineDir);
      } catch (error) {
        if (await this.adapter.exists(quarantineDir)) {
          continue;
        }
        throw error;
      }
      const quarantinePath = this.joinPath(quarantineDir, vaultBasename(source));
      try {
        await options?.beforeMove?.(quarantinePath);
        await this.renameWithExpectedEffect(source, quarantinePath, sourceStat.size);
        return quarantinePath;
      } catch (error) {
        if (!await this.adapter.exists(quarantinePath)) {
          try {
            await this.adapter.rmdir(quarantineDir, false);
          } catch (cleanupError) {
            console.warn("[Local Image Compress] Empty migration quarantine cleanup failed:", cleanupError);
          }
        }
        throw error;
      }
    }
    throw new Error(`Could not reserve a unique migration quarantine beside: ${source}`);
  }

  async replaceFile(stagedPath: string, targetPath: string, options?: ReplaceFileOptions): Promise<{ leftoverRollbackPath: string | null }> {
    const staged = this.resolve(stagedPath);
    const target = this.resolve(targetPath);
    return await runInMobilePathQueue(MOBILE_REPLACEMENT_QUEUE_KEY, async () => {
      if (!this.deviceOwnerId) {
        throw new Error("Device-local recovery identity is unavailable; refusing mobile replacement.");
      }
      await this.recoverInterruptedCleanupUnlocked(options?.bufferedOperationToken);
      const unresolvedTargets = await this.recoverInterruptedReplacementUnlocked(options?.bufferedOperationToken);
      if (unresolvedTargets.has(target)) {
        throw new Error(`Unresolved local replacement recovery blocks target: ${target}`);
      }
      await this.requireBufferedFile(staged, "Replacement source");
      const stagedHash = await this.fileSha256HexBounded(staged, "Replacement source", options?.bufferedOperationToken);
      if (options?.expectedStagedSha256 && stagedHash !== options.expectedStagedSha256) {
        throw new Error(`Replacement source changed before install: ${staged}`);
      }
      const targetStat = await this.adapter.stat(target);
      if (targetStat?.type === "folder") {
        throw new Error(`Replacement target is a directory: ${target}`);
      }
      if (targetStat && options?.expectedTargetMissing === true) {
        throw new Error(`Expected replacement target to remain missing: ${target}`);
      }
      if (!targetStat && options?.expectedTargetSha256 && options.allowMissingTarget !== true) {
        throw new Error(`Expected replacement target is missing: ${target}`);
      }
      const observedTargetHash = targetStat
        ? await this.fileSha256HexBounded(target, "Replacement target", options?.bufferedOperationToken)
        : null;
      if (options?.expectedTargetSha256 && observedTargetHash !== options.expectedTargetSha256) {
        throw new Error(`Replacement target changed before transaction start: ${target}`);
      }
      const rollbackPath = targetStat
        ? this.joinPath(this.dirnamePath(target), `.${vaultBasename(target)}.tinylocal-rollback-${Date.now()}-${await randomHexSuffix(16)}.tmp`)
        : null;
      const journal: MobileReplacementJournal = {
        version: 2,
        ownerId: this.deviceOwnerId,
        transactionId: await randomHexSuffix(16),
        stagedPath: staged,
        targetPath: target,
        rollbackPath,
        stagedSha256: stagedHash,
        expectedTargetSha256: observedTargetHash,
        rollbackSha256: null,
        phase: "prepared"
      };
      const journalPath = this.getReplacementJournalPath(journal);
      await this.writeReplacementJournal(journalPath, journal);
      try {
        let capturedRollbackHash: string | null = null;
        if (rollbackPath) {
          await this.renameWithExpectedEffect(target, rollbackPath, targetStat!.size);
          const capturedHash = await this.fileSha256HexBounded(rollbackPath, "Captured replacement target", options?.bufferedOperationToken);
          capturedRollbackHash = capturedHash;
          journal.rollbackSha256 = capturedHash;
          journal.phase = "detached";
          await this.writeReplacementJournal(journalPath, journal);
          if (capturedHash !== observedTargetHash) {
            const restored = await this.restoreRollbackNoClobber(rollbackPath, target, capturedHash, options?.bufferedOperationToken);
            if (restored) {
              await this.removeReplacementJournal(journalPath, options?.bufferedOperationToken);
            }
            throw new Error(`Replacement target changed before capture: ${target}`);
          }
        } else {
          journal.phase = "detached";
          await this.writeReplacementJournal(journalPath, journal);
        }
        await this.copyFileExclusive(staged, target, options?.bufferedOperationToken, options?.canCommit);
        if (await this.fileSha256HexBounded(target, "Installed replacement target", options?.bufferedOperationToken) !== stagedHash) {
          throw new Error(`Replacement target changed during install: ${target}`);
        }
        journal.phase = "installed";
        await this.writeReplacementJournal(journalPath, journal);
        const retainedStagedPath = await this.removeOwnedCleanupRevision(staged, stagedHash, options?.bufferedOperationToken, true);
        if (retainedStagedPath) {
          console.warn("[Local Image Compress] Installed mobile replacement retained its detached staged revision:", retainedStagedPath);
        }
        let leftoverRollbackPath: string | null = null;
        if (rollbackPath && capturedRollbackHash) {
          const retainedRollbackPath = await this.removeOwnedCleanupRevision(rollbackPath, capturedRollbackHash, options?.bufferedOperationToken, true);
          if (retainedRollbackPath) {
            leftoverRollbackPath = retainedRollbackPath;
            console.warn("[Local Image Compress] Installed mobile replacement retained its detached rollback safety copy:", retainedRollbackPath);
          }
        }
        await this.removeReplacementJournal(journalPath, options?.bufferedOperationToken);
        return { leftoverRollbackPath };
      } catch (error) {
        let unresolvedTarget: string | null = null;
        let recoveryError: unknown = null;
        try {
          unresolvedTarget = await this.recoverReplacementJournal(journalPath, options?.bufferedOperationToken);
        } catch (caughtRecoveryError) {
          recoveryError = caughtRecoveryError;
        }
        const [stagedStillExists, targetHash, rollbackStillExists] = await Promise.all([
          this.adapter.exists(staged),
          this.getFileSha256IfPresent(target, "Replacement target", options?.bufferedOperationToken),
          rollbackPath ? this.adapter.exists(rollbackPath) : Promise.resolve(false)
        ]);
        if (!stagedStillExists && targetHash === stagedHash) {
          return { leftoverRollbackPath: rollbackStillExists ? rollbackPath : null };
        }
        if (recoveryError) {
          throw new Error(`Mobile replacement recovery failed at ${journalPath}. ${getErrorMessage(recoveryError)}`);
        }
        if (unresolvedTarget) {
          throw new Error(`Mobile replacement conflict retained for recovery at ${journalPath}. ${getErrorMessage(error)}`);
        }
        throw error;
      }
    });
  }

  async removeFileIfUnchanged(filePath: string, expectedSha256: string, bufferedOperationToken?: BufferedOperationToken): Promise<RemoveFileIfUnchangedResult> {
    const sourcePath = this.resolve(filePath);
    return await runInMobilePathQueue(MOBILE_REPLACEMENT_QUEUE_KEY, async () => {
      await this.recoverInterruptedCleanupUnlocked(bufferedOperationToken);
      const sourceHash = await this.getFileSha256IfPresent(sourcePath, "Cleanup source", bufferedOperationToken);
      if (sourceHash === null || sourceHash !== expectedSha256) {
        return { removed: false, retainedConflictPath: null };
      }
      let journalPath: string | null = null;
      let quarantinePath: string | null = null;
      try {
        quarantinePath = await this.moveFileToUniqueSibling(sourcePath, {
          beforeMove: async (reservedQuarantinePath) => {
            const transactionId = this.getCleanupTransactionId(reservedQuarantinePath);
            const journal: MobileCleanupJournal = {
              version: 1,
              ownerId: this.deviceOwnerId || "",
              transactionId,
              sourcePath,
              quarantinePath: reservedQuarantinePath,
              expectedSha256: expectedSha256.toLowerCase()
            };
            journalPath = this.getCleanupJournalPath(journal);
            await this.writeCleanupJournal(journalPath, journal, bufferedOperationToken);
          }
        });
      } catch (error) {
        if (journalPath) {
          await this.recoverCleanupJournal(journalPath, bufferedOperationToken).catch((recoveryError) => {
            console.error("[Local Image Compress] Mobile cleanup recovery after detach failure failed:", recoveryError);
          });
        }
        throw error;
      }
      if (!journalPath || !quarantinePath) {
        throw new Error(`Cleanup quarantine was created without a durable journal: ${sourcePath}`);
      }
      const isolatedHash = await this.getFileSha256IfPresent(quarantinePath, "Cleanup quarantine", bufferedOperationToken);
      const retainedConflictPath = await this.recoverCleanupJournal(journalPath, bufferedOperationToken);
      return {
        removed: isolatedHash === expectedSha256 && retainedConflictPath === null,
        retainedConflictPath
      };
    });
  }

  async removeFile(filePath: string): Promise<void> {
    await this.adapter.remove(this.resolve(filePath));
  }

  async removeDir(dirPath: string, options: { recursive: boolean; force: boolean; maxRetries?: number }): Promise<void> {
    const resolvedPath = this.resolve(dirPath);
    if (options.force && !await this.adapter.exists(resolvedPath)) {
      return;
    }
    await this.adapter.rmdir(resolvedPath, options.recursive);
  }

  async listNames(dirPath: string): Promise<string[]> {
    const listing = await this.adapter.list(this.resolve(dirPath));
    return [...listing.files, ...listing.folders].map((entryPath) => vaultBasename(entryPath));
  }

  async listEntries(dirPath: string): Promise<FsDirEntry[]> {
    const listing = await this.adapter.list(this.resolve(dirPath));
    return [
      ...listing.files.map((entryPath) => ({ name: vaultBasename(entryPath), isFile: true, isDirectory: false, isSymbolicLink: false })),
      ...listing.folders.map((entryPath) => ({ name: vaultBasename(entryPath), isFile: false, isDirectory: true, isSymbolicLink: false }))
    ];
  }

  async lstat(filePath: string): Promise<FsLstat> {
    const resolvedPath = this.resolve(filePath);
    const stat = await this.adapter.stat(resolvedPath);
    if (!stat) {
      throw new Error(`ENOENT: no such file or directory: ${resolvedPath}`);
    }
    return {
      isFile: stat.type === "file",
      isDirectory: stat.type === "folder",
      isSymbolicLink: false,
      size: stat.size
    };
  }

  async realpath(filePath: string): Promise<string> {
    // The adapter sandbox has no symlink surface; the normalized path is canonical.
    return this.resolve(filePath);
  }

  async compareFileContents(leftPath: string, rightPath: string, bufferedOperationToken?: BufferedOperationToken): Promise<boolean> {
    return await this.runBufferedOperation(async (token) => {
      const leftStat = await this.requireBufferedFile(this.resolve(leftPath), "Comparison source");
      const rightStat = await this.requireBufferedFile(this.resolve(rightPath), "Comparison target");
      if (leftStat.size !== rightStat.size) {
        return false;
      }
      const hashFile = async (filePath: string) => sha256(new Uint8Array(await this.readBinary(filePath, token)));
      const leftHash = await hashFile(leftPath);
      const rightHash = await hashFile(rightPath);
      return leftHash === rightHash;
    }, bufferedOperationToken);
  }

  async stat(filePath: string): Promise<FsStat | null> {
    const stat = await this.adapter.stat(this.resolve(filePath));
    if (!stat) {
      return null;
    }
    return { mtimeMs: stat.mtime, size: stat.size, isDirectory: stat.type === "folder" };
  }

  readonly processTextAtomically = async (filePath: string, initialText: string, update: (current: string) => string): Promise<string> => {
    const resolvedPath = this.resolve(filePath);
    return await this.runBufferedOperation(async () =>
      await runInMobilePathQueue(resolvedPath, async () => {
        if (getUtf8ByteLength(initialText) > MOBILE_MAX_BUFFERED_FILE_BYTES) {
          throw new Error(`Initial text exceeds the mobile ${MOBILE_MAX_INPUT_SIZE_MB} MB maintenance limit: ${filePath}`);
        }
        if (!await this.adapter.exists(resolvedPath)) {
          await this.mkdir(this.dirnamePath(resolvedPath));
          try {
            const encoded = new TextEncoder().encode(initialText);
            await this.vault.createBinary(resolvedPath, encoded.buffer);
          } catch (error) {
            if (!await this.adapter.exists(resolvedPath)) {
              throw error;
            }
          }
        }
        await this.requireBufferedFile(resolvedPath, "Atomic text source");
        return await this.adapter.process(resolvedPath, (current) => {
          if (getUtf8ByteLength(current) > MOBILE_MAX_BUFFERED_FILE_BYTES) {
            throw new Error(`Atomic text source exceeds the mobile ${MOBILE_MAX_INPUT_SIZE_MB} MB maintenance limit after read: ${filePath}`);
          }
          const next = update(current);
          if (getUtf8ByteLength(next) > MOBILE_MAX_BUFFERED_FILE_BYTES) {
            throw new Error(`Atomic text output exceeds the mobile ${MOBILE_MAX_INPUT_SIZE_MB} MB maintenance limit: ${filePath}`);
          }
          return next;
        });
      })
    );
  };

  async fsyncBestEffort(filePath: string): Promise<void> {
    // The adapter exposes no durability flush; adapter writes are as durable
    // as the platform makes them.
    this.resolve(filePath);
  }

  async recoverInterruptedReplacement(): Promise<void> {
    await runInMobilePathQueue(MOBILE_REPLACEMENT_QUEUE_KEY, async () => {
      await this.recoverInterruptedCleanupUnlocked();
      await this.recoverInterruptedReplacementUnlocked();
    });
  }

  private getCleanupTransactionId(quarantinePath: string): string {
    const match = /^\.tinylocal-quarantine-\d+-([a-f0-9]{32})\.tmp$/i.exec(vaultBasename(this.dirnamePath(quarantinePath)));
    if (!match?.[1]) {
      throw new Error(`Cleanup quarantine does not expose a transaction identity: ${quarantinePath}`);
    }
    return match[1].toLowerCase();
  }

  private getCleanupJournalPath(journal: MobileCleanupJournal): string {
    return `${REPLACEMENT_JOURNAL_DIR}/mobile-cleanup-journal-v1-${journal.ownerId}-${journal.transactionId}.json`;
  }

  private serializeCleanupJournal(journal: MobileCleanupJournal): string {
    const stored: StoredMobileCleanupJournal = {
      ...journal,
      checksum: sha256(JSON.stringify(journal))
    };
    return JSON.stringify(stored);
  }

  private parseCleanupJournal(rawJournal: string, journalPath: string): MobileCleanupJournal {
    const parsed: unknown = JSON.parse(rawJournal);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Invalid mobile cleanup journal: ${journalPath}`);
    }
    const record = parsed as Record<string, unknown>;
    const journal = {
      version: record["version"],
      ownerId: record["ownerId"],
      transactionId: record["transactionId"],
      sourcePath: record["sourcePath"],
      quarantinePath: record["quarantinePath"],
      expectedSha256: record["expectedSha256"]
    };
    const checksum = record["checksum"];
    if (journal.version !== 1 || typeof checksum !== "string" || checksum !== sha256(JSON.stringify(journal))
      || typeof journal.ownerId !== "string" || !MOBILE_DEVICE_ID_PATTERN.test(journal.ownerId)
      || typeof journal.transactionId !== "string" || !MOBILE_DEVICE_ID_PATTERN.test(journal.transactionId)
      || typeof journal.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(journal.expectedSha256)
      || typeof journal.sourcePath !== "string" || journal.sourcePath !== this.resolve(journal.sourcePath) || !isSafeVaultRelativePath(journal.sourcePath)
      || typeof journal.quarantinePath !== "string" || journal.quarantinePath !== this.resolve(journal.quarantinePath) || !isSafeVaultRelativePath(journal.quarantinePath)) {
      throw new Error(`Invalid mobile cleanup journal: ${journalPath}`);
    }
    const quarantineDirectory = this.dirnamePath(journal.quarantinePath);
    if (this.dirnamePath(quarantineDirectory) !== this.dirnamePath(journal.sourcePath)
      || vaultBasename(journal.quarantinePath) !== vaultBasename(journal.sourcePath)
      || this.getCleanupTransactionId(journal.quarantinePath) !== journal.transactionId.toLowerCase()) {
      throw new Error(`Mobile cleanup journal does not own its quarantine: ${journalPath}`);
    }
    const normalized: MobileCleanupJournal = {
      version: 1,
      ownerId: journal.ownerId.toLowerCase(),
      transactionId: journal.transactionId.toLowerCase(),
      sourcePath: journal.sourcePath,
      quarantinePath: journal.quarantinePath,
      expectedSha256: journal.expectedSha256.toLowerCase()
    };
    if (this.getCleanupJournalPath(normalized) !== journalPath) {
      throw new Error(`Mobile cleanup journal identity does not match its path: ${journalPath}`);
    }
    return normalized;
  }

  private async writeCleanupJournal(
    journalPath: string,
    journal: MobileCleanupJournal,
    bufferedOperationToken?: BufferedOperationToken
  ): Promise<void> {
    if (!this.deviceOwnerId || journal.ownerId !== this.deviceOwnerId) {
      throw new Error("Device-local recovery identity is unavailable; refusing cleanup.");
    }
    await this.mkdir(REPLACEMENT_JOURNAL_DIR);
    if (await this.adapter.exists(journalPath)) {
      throw new Error(`Mobile cleanup journal already exists: ${journalPath}`);
    }
    await this.adapter.write(journalPath, this.serializeCleanupJournal(journal));
    this.parseCleanupJournal(await this.readText(journalPath, bufferedOperationToken), journalPath);
  }

  private async removeCleanupJournal(journalPath: string, bufferedOperationToken?: BufferedOperationToken): Promise<void> {
    if (!await this.adapter.exists(journalPath)) {
      return;
    }
    const rawJournal = await this.readText(journalPath, bufferedOperationToken);
    const journal = this.parseCleanupJournal(rawJournal, journalPath);
    if (this.deviceOwnerId && journal.ownerId === this.deviceOwnerId) {
      const retainedPath = await this.removeOwnedCleanupRevision(journalPath, sha256(rawJournal), bufferedOperationToken, true);
      if (retainedPath) {
        throw new Error(`Mobile cleanup journal changed before removal and was retained: ${retainedPath}`);
      }
    }
  }

  private async cleanupQuarantineDirectory(quarantinePath: string): Promise<void> {
    const quarantineDirectory = this.dirnamePath(quarantinePath);
    try {
      await this.adapter.rmdir(quarantineDirectory, false);
    } catch (error) {
      if (await this.adapter.exists(quarantineDirectory)) {
        console.warn("[Local Image Compress] Empty cleanup quarantine removal failed:", error);
      }
    }
  }

  private async recoverInterruptedCleanupUnlocked(bufferedOperationToken?: BufferedOperationToken): Promise<void> {
    if (!await this.adapter.exists(REPLACEMENT_JOURNAL_DIR)) {
      return;
    }
    const listing = await this.adapter.list(REPLACEMENT_JOURNAL_DIR);
    const journalPaths = listing.files
      .map((filePath) => this.resolve(filePath))
      .filter((filePath) => this.dirnamePath(filePath) === REPLACEMENT_JOURNAL_DIR && CLEANUP_JOURNAL_FILE_PATTERN.test(vaultBasename(filePath)))
      .sort();
    for (const journalPath of journalPaths) {
      try {
        const retainedPath = await this.recoverCleanupJournal(journalPath, bufferedOperationToken);
        if (retainedPath) {
          console.warn("[Local Image Compress] Ambiguous cleanup quarantine retained:", retainedPath);
        }
      } catch (error) {
        console.error("[Local Image Compress] Mobile cleanup journal retained after recovery failure:", journalPath, error);
      }
    }
  }

  private async recoverCleanupJournal(journalPath: string, bufferedOperationToken?: BufferedOperationToken): Promise<string | null> {
    if (!await this.adapter.exists(journalPath)) {
      return null;
    }
    const journal = this.parseCleanupJournal(await this.readText(journalPath, bufferedOperationToken), journalPath);
    if (!this.deviceOwnerId || journal.ownerId !== this.deviceOwnerId) {
      return null;
    }
    const quarantineHash = await this.getFileSha256IfPresent(journal.quarantinePath, "Cleanup quarantine", bufferedOperationToken);
    if (quarantineHash === null) {
      await this.removeCleanupJournal(journalPath, bufferedOperationToken);
      return null;
    }
    if (quarantineHash === journal.expectedSha256) {
      const retainedPath = await this.removeOwnedCleanupRevision(
        journal.quarantinePath,
        journal.expectedSha256,
        bufferedOperationToken
      );
      if (retainedPath) {
        return retainedPath;
      }
      await this.cleanupQuarantineDirectory(journal.quarantinePath);
      await this.removeCleanupJournal(journalPath, bufferedOperationToken);
      return null;
    }
    if (await this.getFileSha256IfPresent(journal.sourcePath, "Cleanup source", bufferedOperationToken) !== null) {
      return journal.quarantinePath;
    }
    try {
      await this.copyFileExclusive(journal.quarantinePath, journal.sourcePath, bufferedOperationToken);
    } catch (error) {
      if (await this.adapter.exists(journal.sourcePath)) {
        return journal.quarantinePath;
      }
      throw error;
    }
    if (await this.getFileSha256IfPresent(journal.sourcePath, "Restored cleanup source", bufferedOperationToken) !== quarantineHash) {
      return journal.quarantinePath;
    }
    // Keep the durable second copy and journal. A Sync replacement can land
    // immediately after readback; removing quarantine would then lose bytes.
    return journal.quarantinePath;
  }

  private async removeOwnedCleanupRevision(
    filePath: string,
    expectedHash: string,
    bufferedOperationToken?: BufferedOperationToken,
    discardVerifiedTransactionRevision = false
  ): Promise<string | null> {
    const stat = await this.requireBufferedFile(filePath, "Cleanup deletion candidate");
    const deletionPath = `${filePath}.delete-${Date.now()}-${await randomHexSuffix(16)}.tmp`;
    await this.renameWithExpectedEffect(filePath, deletionPath, stat.size);
    const detachedHash = await this.getFileSha256IfPresent(deletionPath, "Detached cleanup deletion candidate", bufferedOperationToken);
    if (detachedHash !== expectedHash) {
      try {
        await this.copyFileExclusive(deletionPath, filePath, bufferedOperationToken);
      } catch (error) {
        if (!await this.adapter.exists(filePath)) {
          throw error;
        }
      }
      return deletionPath;
    }
    try {
      if (discardVerifiedTransactionRevision) {
        // Stage, rollback, and journal paths belong to the completed
        // transaction. Conflicts took the preserving branch above.
        await this.adapter.remove(deletionPath);
      } else {
        // Mobile exposes no inode/CAS unlink. Local trash preserves whichever
        // revision occupies the detached path if Sync replaces it after hashing.
        await this.adapter.trashLocal(deletionPath);
      }
      return null;
    } catch (error) {
      void error;
      // Keep one detached safety copy. Restoring it to the journal path would
      // make every later recovery create another retained deletion copy.
      return deletionPath;
    }
  }

  private async requireBufferedFile(filePath: string, label: string): Promise<{ size: number }> {
    const stat = await this.adapter.stat(this.resolve(filePath));
    if (!stat || stat.type !== "file") {
      throw new Error(`${label} is not a file: ${filePath}`);
    }
    if (stat.size > MOBILE_MAX_BUFFERED_FILE_BYTES) {
      throw new Error(`${label} exceeds the mobile ${MOBILE_MAX_INPUT_SIZE_MB} MB maintenance limit: ${filePath}`);
    }
    return { size: stat.size };
  }

  private async fileSha256HexBounded(filePath: string, label: string, bufferedOperationToken?: BufferedOperationToken): Promise<string> {
    return await this.runBufferedOperation(async () => {
      await this.requireBufferedFile(filePath, label);
      const data = await this.adapter.readBinary(this.resolve(filePath));
      if (data.byteLength > MOBILE_MAX_BUFFERED_FILE_BYTES) {
        throw new Error(`${label} exceeds the mobile ${MOBILE_MAX_INPUT_SIZE_MB} MB maintenance limit after read: ${filePath}`);
      }
      return sha256(new Uint8Array(data));
    }, bufferedOperationToken);
  }

  private async getFileSha256IfPresent(filePath: string, label: string, bufferedOperationToken?: BufferedOperationToken): Promise<string | null> {
    const stat = await this.adapter.stat(this.resolve(filePath));
    if (!stat) {
      return null;
    }
    if (stat.type !== "file") {
      throw new Error(`${label} is not a file: ${filePath}`);
    }
    return await this.fileSha256HexBounded(filePath, label, bufferedOperationToken);
  }

  private async restoreRollbackNoClobber(rollbackPath: string, targetPath: string, expectedHash: string, bufferedOperationToken?: BufferedOperationToken): Promise<boolean> {
    try {
      await this.copyFileExclusive(rollbackPath, targetPath, bufferedOperationToken);
    } catch (error) {
      if (await this.adapter.exists(targetPath)) {
        return false;
      }
      throw error;
    }
    if (await this.getFileSha256IfPresent(targetPath, "Restored replacement target", bufferedOperationToken) !== expectedHash) {
      return false;
    }
    // The adapter exposes no inode/CAS delete. Keep the exact rollback as a
    // safety copy: Sync may replace target immediately after the verification.
    return true;
  }

  private async copyFileExclusive(
    sourcePath: string,
    targetPath: string,
    bufferedOperationToken?: BufferedOperationToken,
    canCommit?: () => boolean
  ): Promise<void> {
    await this.runBufferedOperation(async (token) => {
      const data = await this.readBinary(sourcePath, token);
      // Vault.createBinary is the public mobile API whose contract rejects an
      // existing path. DataAdapter.copy overwrites on Capacitor and therefore
      // cannot implement an exclusive publication.
      if (canCommit && !canCommit()) {
        throw new Error(`Replacement commit was cancelled before publication: ${targetPath}`);
      }
      await this.vault.createBinary(this.resolve(targetPath), data);
    }, bufferedOperationToken);
  }

  private async renameWithExpectedEffect(sourcePath: string, targetPath: string, expectedSize: number): Promise<void> {
    try {
      await this.adapter.rename(sourcePath, targetPath);
    } catch (error) {
      const [sourceExists, targetStat] = await Promise.all([
        this.adapter.exists(sourcePath),
        this.adapter.stat(targetPath)
      ]);
      if (!sourceExists && targetStat?.type === "file" && targetStat.size === expectedSize) {
        return;
      }
      throw error;
    }
  }

  private getReplacementJournalPath(journal: MobileReplacementJournal): string {
    return `${REPLACEMENT_JOURNAL_DIR}/mobile-replacement-journal-v2-${journal.ownerId}-${journal.transactionId}.json`;
  }

  private isManagedReplacementJournalPath(filePath: string): boolean {
    const resolvedPath = this.resolve(filePath);
    return resolvedPath === LEGACY_REPLACEMENT_JOURNAL_PATH
      || (this.dirnamePath(resolvedPath) === REPLACEMENT_JOURNAL_DIR
        && (LEGACY_REPLACEMENT_JOURNAL_FILE_PATTERN.test(vaultBasename(resolvedPath))
          || REPLACEMENT_JOURNAL_FILE_PATTERN.test(vaultBasename(resolvedPath))));
  }

  private async writeReplacementJournal(journalPath: string, journal: MobileReplacementJournal): Promise<void> {
    const serialized = this.serializeReplacementJournal(journal);
    await this.mkdir(REPLACEMENT_JOURNAL_DIR);
    if (await this.adapter.exists(journalPath)) {
      await this.adapter.process(journalPath, (current) => {
        const existing = this.parseReplacementJournal(current, journalPath);
        if (this.getReplacementJournalPath(existing) !== journalPath
          || existing.ownerId !== journal.ownerId
          || existing.transactionId !== journal.transactionId
          || (existing.phase === "installed" && journal.phase !== "installed")) {
          throw new Error(`Refusing to overwrite unrelated mobile replacement journal: ${journalPath}`);
        }
        return serialized;
      });
      return;
    }
    await this.adapter.write(journalPath, serialized);
  }

  private serializeReplacementJournal(journal: MobileReplacementJournal): string {
    const payload = {
      version: 2 as const,
      ownerId: journal.ownerId,
      transactionId: journal.transactionId,
      stagedPath: journal.stagedPath,
      targetPath: journal.targetPath,
      rollbackPath: journal.rollbackPath,
      stagedSha256: journal.stagedSha256,
      expectedTargetSha256: journal.expectedTargetSha256,
      rollbackSha256: journal.rollbackSha256,
      phase: journal.phase
    };
    const stored: StoredMobileReplacementJournal = {
      ...payload,
      checksum: sha256(JSON.stringify(payload))
    };
    return JSON.stringify(stored);
  }

  private async removeReplacementJournal(journalPath: string, bufferedOperationToken?: BufferedOperationToken): Promise<void> {
    if (!await this.adapter.exists(journalPath)) {
      return;
    }
    const rawJournal = await this.readText(journalPath, bufferedOperationToken);
    const journal = this.parseReplacementJournal(rawJournal, journalPath);
    if (this.deviceOwnerId && journal.ownerId === this.deviceOwnerId) {
      const retainedPath = await this.removeOwnedCleanupRevision(journalPath, sha256(rawJournal), bufferedOperationToken, true);
      if (retainedPath) {
        throw new Error(`Mobile replacement journal changed before removal and was retained: ${retainedPath}`);
      }
    }
  }

  private async recoverInterruptedReplacementUnlocked(bufferedOperationToken?: BufferedOperationToken): Promise<Set<string>> {
    const unresolvedTargets = new Set<string>();
    const journalPaths: string[] = [];
    if (await this.adapter.exists(LEGACY_REPLACEMENT_JOURNAL_PATH)) {
      console.warn("[Local Image Compress] Unowned legacy mobile replacement journal retained:", LEGACY_REPLACEMENT_JOURNAL_PATH);
    }
    if (await this.adapter.exists(REPLACEMENT_JOURNAL_DIR)) {
      const listing = await this.adapter.list(REPLACEMENT_JOURNAL_DIR);
      const listedPaths = listing.files
        .map((filePath) => this.resolve(filePath))
        .filter((filePath) => this.dirnamePath(filePath) === REPLACEMENT_JOURNAL_DIR);
      for (const filePath of listedPaths) {
        if (LEGACY_REPLACEMENT_JOURNAL_FILE_PATTERN.test(vaultBasename(filePath))) {
          console.warn("[Local Image Compress] Unowned legacy mobile replacement journal retained:", filePath);
        } else if (REPLACEMENT_JOURNAL_FILE_PATTERN.test(vaultBasename(filePath))) {
          journalPaths.push(filePath);
        }
      }
    }
    for (const journalPath of journalPaths.sort()) {
      try {
        const unresolvedTarget = await this.recoverReplacementJournal(journalPath, bufferedOperationToken);
        if (unresolvedTarget) {
          unresolvedTargets.add(unresolvedTarget);
        }
      } catch (error) {
        console.error("[Local Image Compress] Mobile replacement journal was retained after isolated recovery failure:", journalPath, error);
      }
    }
    return unresolvedTargets;
  }

  private async recoverReplacementJournal(journalPath: string, bufferedOperationToken?: BufferedOperationToken): Promise<string | null> {
    if (!await this.adapter.exists(journalPath)) {
      return null;
    }
    const rawJournal = await this.readText(journalPath, bufferedOperationToken);
    let journal: MobileReplacementJournal;
    try {
      journal = this.parseReplacementJournal(rawJournal, journalPath);
    } catch (error) {
      console.error("[Local Image Compress] Invalid mobile replacement journal was retained and not executed:", journalPath, error);
      return null;
    }
    if (!this.deviceOwnerId || journal.ownerId !== this.deviceOwnerId) {
      return null;
    }
    const stagedPath = journal.stagedPath;
    const targetPath = journal.targetPath;
    const rollbackPath = journal.rollbackPath;
    const stagedHash = await this.getFileSha256IfPresent(stagedPath, "Replacement recovery staged file", bufferedOperationToken);
    const targetHash = await this.getFileSha256IfPresent(targetPath, "Replacement recovery target", bufferedOperationToken);
    const rollbackHash = rollbackPath
      ? await this.getFileSha256IfPresent(rollbackPath, "Replacement recovery rollback", bufferedOperationToken)
      : null;
    if (targetHash === journal.stagedSha256) {
      if (stagedHash === journal.stagedSha256) {
        const retainedStagedPath = await this.removeOwnedCleanupRevision(stagedPath, stagedHash, bufferedOperationToken, true);
        if (retainedStagedPath) {
          console.warn("[Local Image Compress] Recovered mobile replacement retained its staged safety copy:", retainedStagedPath);
        }
      }
      if (rollbackPath && journal.rollbackSha256 !== null && rollbackHash === journal.rollbackSha256) {
        console.warn("[Local Image Compress] Recovered mobile replacement kept its exact rollback safety copy:", rollbackPath);
      }
      await this.removeReplacementJournal(journalPath, bufferedOperationToken);
      return null;
    }
    if (targetHash === null && rollbackPath && rollbackHash !== null
      && journal.expectedTargetSha256 !== null && rollbackHash === journal.expectedTargetSha256) {
      if (await this.restoreRollbackNoClobber(rollbackPath, targetPath, rollbackHash, bufferedOperationToken)) {
        if (stagedHash === journal.stagedSha256) {
          const retainedStagedPath = await this.removeOwnedCleanupRevision(stagedPath, stagedHash, bufferedOperationToken, true);
          if (retainedStagedPath) {
            console.warn("[Local Image Compress] Mobile replacement recovery retained its staged safety copy:", retainedStagedPath);
          }
        }
        console.warn("[Local Image Compress] Mobile replacement recovery restored target and kept the exact rollback safety copy:", rollbackPath);
        await this.removeReplacementJournal(journalPath, bufferedOperationToken);
        return null;
      }
    }
    if (stagedHash !== null && stagedHash !== journal.stagedSha256) {
      return targetPath;
    }
    if (rollbackHash !== null && journal.rollbackSha256 !== null && rollbackHash !== journal.rollbackSha256) {
      return targetPath;
    }
    const hasExactRollbackSafetyCopy = targetHash !== null
      && targetHash !== journal.stagedSha256
      && rollbackPath !== null
      && journal.rollbackSha256 !== null
      && rollbackHash === journal.rollbackSha256;
    const hasConcurrentCreateWinner = journal.expectedTargetSha256 === null
      && rollbackPath === null
      && journal.rollbackSha256 === null
      && targetHash !== null
      && targetHash !== journal.stagedSha256;
    if (hasExactRollbackSafetyCopy || hasConcurrentCreateWinner) {
      console.warn(
        "[Local Image Compress] Retired stale mobile replacement journal and kept its terminal safety evidence:",
        rollbackPath || targetPath
      );
      try {
        await this.removeReplacementJournal(journalPath, bufferedOperationToken);
      } catch (error) {
        if (await this.adapter.exists(journalPath)) {
          throw error;
        }
        console.warn("[Local Image Compress] Stale mobile replacement journal was retained outside the active recovery namespace:", error);
      }
      return null;
    }

    if (journal.expectedTargetSha256 === null) {
      if (rollbackHash !== null) {
        return targetPath;
      }
      if (targetHash === null && stagedHash === journal.stagedSha256) {
        if (await this.removeOwnedCleanupRevision(stagedPath, stagedHash, bufferedOperationToken, true)) {
          return targetPath;
        }
        await this.removeReplacementJournal(journalPath, bufferedOperationToken);
        return null;
      }
      return targetPath;
    }

    const expectedTargetHash = journal.expectedTargetSha256;
    if (targetHash === expectedTargetHash && rollbackHash === null) {
      if (stagedHash === journal.stagedSha256) {
        if (await this.removeOwnedCleanupRevision(stagedPath, stagedHash, bufferedOperationToken, true)) {
          return targetPath;
        }
      }
      await this.removeReplacementJournal(journalPath, bufferedOperationToken);
      return null;
    }
    if (targetHash === null && rollbackPath && rollbackHash !== null
      && journal.rollbackSha256 !== null && rollbackHash === journal.rollbackSha256) {
      if (await this.restoreRollbackNoClobber(rollbackPath, targetPath, rollbackHash, bufferedOperationToken)) {
        if (stagedHash === journal.stagedSha256) {
          if (await this.removeOwnedCleanupRevision(stagedPath, stagedHash, bufferedOperationToken, true)) {
            return targetPath;
          }
        }
        console.warn("[Local Image Compress] Mobile replacement recovery restored target and kept the exact rollback safety copy:", rollbackPath);
        await this.removeReplacementJournal(journalPath, bufferedOperationToken);
        return null;
      }
    }
    return targetPath;
  }

  private parseReplacementJournal(rawJournal: string, journalPath: string): MobileReplacementJournal {
    const parsed: unknown = JSON.parse(rawJournal);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Invalid mobile replacement journal: ${journalPath}`);
    }
    const record = parsed as Record<string, unknown>;
    const stagedPath = record["stagedPath"];
    const targetPath = record["targetPath"];
    const rollbackValue = record["rollbackPath"];
    const ownerId = record["ownerId"];
    const transactionId = record["transactionId"];
    const stagedSha256 = record["stagedSha256"];
    const expectedTargetSha256 = record["expectedTargetSha256"];
    const rollbackSha256 = record["rollbackSha256"];
    const phase = record["phase"];
    const version = record["version"];
    const checksum = record["checksum"];
    const isSafeCanonicalPath = (value: unknown): value is string => typeof value === "string"
      && value.length > 0
      && value === normalizeVaultPathRoot(value)
      && isSafeVaultRelativePath(value)
      && !this.isManagedReplacementJournalPath(value);
    const checksumPayload = {
      version,
      ownerId,
      transactionId,
      stagedPath,
      targetPath,
      rollbackPath: rollbackValue,
      stagedSha256,
      expectedTargetSha256,
      rollbackSha256,
      phase
    };
    const isHashOrNull = (value: unknown): value is string | null => value === null
      || (typeof value === "string" && /^[a-f0-9]{64}$/i.test(value));
    if (version !== 2 || typeof checksum !== "string" || checksum !== sha256(JSON.stringify(checksumPayload))
      || typeof ownerId !== "string" || !MOBILE_DEVICE_ID_PATTERN.test(ownerId)
      || typeof transactionId !== "string" || !MOBILE_DEVICE_ID_PATTERN.test(transactionId)
      || typeof stagedSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(stagedSha256)
      || !isHashOrNull(expectedTargetSha256) || !isHashOrNull(rollbackSha256)
      || !isSafeCanonicalPath(stagedPath) || !isSafeCanonicalPath(targetPath)
      || (phase !== "prepared" && phase !== "detached" && phase !== "installed")) {
      throw new Error(`Invalid mobile replacement journal: ${journalPath}`);
    }
    const targetDir = this.dirnamePath(targetPath);
    const targetName = vaultBasename(targetPath);
    const stagedPattern = new RegExp(`^\\.?${escapeRegExp(targetName)}\\.tinylocal-(?:recovery-)?\\d+-[a-f0-9]{16,32}\\.tmp$`, "i");
    if (this.dirnamePath(stagedPath) !== targetDir || !stagedPattern.test(vaultBasename(stagedPath))) {
      throw new Error(`Invalid mobile replacement staged path; journal retained: ${journalPath}`);
    }
    let rollbackPath: string | null = null;
    if (rollbackValue !== null) {
      if (!isSafeCanonicalPath(rollbackValue)) {
        throw new Error(`Invalid mobile replacement rollback path; journal retained: ${journalPath}`);
      }
      const rollbackPattern = new RegExp(`^\\.${escapeRegExp(targetName)}\\.tinylocal-rollback-\\d+-[a-f0-9]{32}\\.tmp$`, "i");
      if (this.dirnamePath(rollbackValue) !== targetDir || !rollbackPattern.test(vaultBasename(rollbackValue))) {
        throw new Error(`Invalid mobile replacement rollback path; journal retained: ${journalPath}`);
      }
      rollbackPath = rollbackValue;
    }
    const journal: MobileReplacementJournal = {
      version: 2,
      ownerId: ownerId.toLowerCase(),
      transactionId: transactionId.toLowerCase(),
      stagedPath,
      targetPath,
      rollbackPath,
      stagedSha256: stagedSha256.toLowerCase(),
      expectedTargetSha256: expectedTargetSha256?.toLowerCase() || null,
      rollbackSha256: rollbackSha256?.toLowerCase() || null,
      phase
    };
    if (this.getReplacementJournalPath(journal) !== journalPath) {
      throw new Error(`Mobile replacement journal identity does not match its path: ${journalPath}`);
    }
    return journal;
  }
}

class MobileHashPort implements HashPort {
  constructor(private readonly fsPort: FsPort) {}

  md5Hex(data: Uint8Array): string {
    return md5(data);
  }

  sha256Hex(data: Uint8Array | string): string {
    return sha256(data);
  }

  async fileSha256Hex(filePath: string, bufferedOperationToken?: BufferedOperationToken): Promise<string> {
    return await this.fsPort.runBufferedOperation(async (token) => {
      const stat = await this.fsPort.stat(filePath);
      if (!stat || stat.isDirectory) {
        throw new Error(`Hash source is not a file: ${filePath}`);
      }
      if (stat.size > MOBILE_MAX_BUFFERED_FILE_BYTES) {
        throw new Error(`Hash source exceeds the mobile ${MOBILE_MAX_INPUT_SIZE_MB} MB maintenance limit: ${filePath}`);
      }
      const data = await this.fsPort.readBinary(filePath, token);
      if (data.byteLength > MOBILE_MAX_BUFFERED_FILE_BYTES) {
        throw new Error(`Hash source exceeds the mobile ${MOBILE_MAX_INPUT_SIZE_MB} MB maintenance limit after read: ${filePath}`);
      }
      return sha256(new Uint8Array(data));
    }, bufferedOperationToken);
  }
}

function createMobileRuntimePort(): RuntimePort {
  return {
    // ponytail: Math.random suffices — the id only disambiguates temp names
    // next to a timestamp and a random hex suffix.
    instanceId: Math.floor(Math.random() * 0x7fffffff) + 1,
    // iOS filesystems are case-insensitive by default; Android is case-sensitive.
    isCaseInsensitiveFs: typeof Platform === "object" && Platform !== null && Platform.isIosApp === true,
    maxBufferedFileBytes: MOBILE_MAX_BUFFERED_FILE_BYTES,
    revealPath: null
  };
}

export function createMobilePorts(app: App): PlatformPorts {
  const fsPort = new MobileFsPort(app.vault);
  return {
    fs: fsPort,
    hash: new MobileHashPort(fsPort),
    runtime: createMobileRuntimePort()
  };
}
