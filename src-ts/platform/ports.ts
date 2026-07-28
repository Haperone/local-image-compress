// Platform ports: the only seam between vault-relative plugin code and the
// real filesystem. Desktop resolves paths against the vault base path with
// Node APIs (byte-identical to the historical direct fs calls); mobile speaks
// vault-relative paths straight to the DataAdapter. Storage methods accept
// only vault-relative paths; native desktop inputs require explicit ingress
// through toVaultRelativePath().

export type FsStat = {
  mtimeMs: number;
  size: number;
  isDirectory: boolean;
};

export type FsDirEntry = {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  // Always false on mobile: the adapter sandbox exposes no symlinks.
  isSymbolicLink: boolean;
};

export type FsLstat = {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
};

declare const bufferedOperationTokenBrand: unique symbol;
export type BufferedOperationToken = {
  readonly [bufferedOperationTokenBrand]: true;
};

export type ReplaceFileOptions = {
  // When present, replacement is a compare-and-swap: the exact target bytes
  // captured for rollback must match this digest before staged bytes land.
  expectedTargetSha256?: string;
  // Requires the target to remain absent until the conditional transaction
  // begins; a concurrently published target is a conflict, never an overwrite.
  expectedTargetMissing?: boolean;
  // Allows recovery to recreate a target that disappeared after a successful
  // replacement, while still refusing to overwrite an unexpected new target.
  allowMissingTarget?: boolean;
  // Binds the staged path to the exact verified output/recovery bytes.
  expectedStagedSha256?: string;
  // Checked synchronously immediately before the no-clobber publication call;
  // callers may cancel a transaction after its earlier awaited preparation.
  canCommit?: () => boolean;
  // Reuses an already-held mobile full-buffer permit for nested install I/O.
  bufferedOperationToken?: BufferedOperationToken;
};

export type MoveFileToUniqueSiblingOptions = {
  // Runs after the unique sibling path is reserved but before source bytes move.
  // Migration uses this point to durably journal the exact quarantine path.
  beforeMove?: (quarantinePath: string) => Promise<void>;
};

export type RemoveFileIfUnchangedResult = {
  removed: boolean;
  retainedConflictPath: string | null;
};

export type HandleIdentity = {
  isFile: boolean;
  dev: number;
  ino: number;
};

// Opaque owner token for a desktop filesystem lease. The implementation binds
// the canonical lock path to the exact owner inode, so callers never release a
// replacement merely because its JSON happens to contain the same owner id.
export type FsLease = Readonly<{
  lockPath: string;
  ownerPath: string;
  ownerId: string;
  leaseId: string;
}>;

export type FsLeasePort = {
  acquire(lockPath: string, ownerId: string, timeoutMs: number, retryMs: number): Promise<FsLease | null>;
  acquireSync(lockPath: string, ownerId: string, timeoutMs: number, retryMs: number): FsLease | null;
  renew(lease: FsLease): Promise<boolean>;
  renewSync(lease: FsLease): boolean;
  validate(lease: FsLease): Promise<boolean>;
  validateSync(lease: FsLease): boolean;
  release(lease: FsLease): Promise<boolean>;
  releaseSync(lease: FsLease): boolean;
};

// Hardened cache-restore primitives (symlink, inode-identity and realpath
// checks plus handle-based streaming). null where the platform filesystem
// exposes no such surface — the mobile adapter sandbox is the guarantee there.
export type FsRestoreProbe = {
  lstatIdentity(filePath: string): Promise<{ isFile: boolean; isSymbolicLink: boolean; dev: number; ino: number }>;
  realpath(filePath: string): Promise<string>;
  // Sequence: open source handle -> afterOpen (returns release hook) ->
  // handle.stat -> afterStat (validations while the handle is open) ->
  // stream copy -> release hook -> close handle.
  copyViaHandle(
    sourcePath: string,
    targetPath: string,
    hooks: {
      afterOpen: () => Promise<() => Promise<void>>;
      afterStat: (identity: HandleIdentity) => Promise<void>;
    }
  ): Promise<void>;
};

// Method names keep the *Sync suffix so the class-wide sync-fs gate keeps
// guarding call sites that go through the port.
export type FsSyncPort = {
  existsSync(filePath: string): boolean;
  mkdirSync(dirPath: string): void;
  readTextSync(filePath: string): string;
  writeTextSync(filePath: string, text: string): void;
  copyFileSync(sourcePath: string, targetPath: string, options?: { exclusive?: boolean }): void;
  replaceFileSync(stagedPath: string, targetPath: string): void;
  removeFileSync(filePath: string): void;
  listNamesSync(dirPath: string): string[];
  listEntriesSync(dirPath: string): FsDirEntry[];
  statSync(filePath: string): FsStat | null;
  writeExclusiveSync(filePath: string, text: string): boolean;
  fsyncBestEffortSync(filePath: string): void;
};

export type FsPort = {
  // All storage operations and path math use normalized vault-relative paths.
  // Native desktop paths must enter only through the explicit conversion below.
  joinPath(...segments: string[]): string;
  dirnamePath(filePath: string): string;
  // Platform-boundary conversion for native desktop integrations. Shared
  // services keep persisted and working paths vault-relative instead.
  resolvePath(filePath: string): string;
  // Canonical form for identity comparison (Node path.resolve on desktop).
  canonicalizePath(filePath: string): string;
  // Explicit ingress conversion for manifest/host native paths. Mobile inputs
  // are already relative; desktop strips the current vault base path.
  toVaultRelativePath(filePath: string): string;
  exists(filePath: string): Promise<boolean>;
  mkdir(dirPath: string): Promise<void>;
  // Mobile serializes text reads with every other full-buffer operation and
  // rejects files that exceed its buffered-file budget before or after read.
  readText(filePath: string, bufferedOperationToken?: BufferedOperationToken): Promise<string>;
  writeText(filePath: string, text: string): Promise<void>;
  readBinary(filePath: string, bufferedOperationToken?: BufferedOperationToken): Promise<ArrayBuffer>;
  writeBinary(filePath: string, data: ArrayBuffer, bufferedOperationToken?: BufferedOperationToken): Promise<void>;
  // `exclusive: true` is the cross-platform safety contract: the destination
  // must remain untouched when it already exists. Mobile rejects overwrite
  // copies because Capacitor's DataAdapter.copy replaces the destination.
  copyFile(sourcePath: string, targetPath: string, options?: {
    exclusive?: boolean;
    bufferedOperationToken?: BufferedOperationToken;
  }): Promise<void>;
  // Atomically isolates a file inside a newly reserved sibling directory and
  // returns its quarantined path. Used before compare/delete migration flows.
  moveFileToUniqueSibling(sourcePath: string, options?: MoveFileToUniqueSiblingOptions): Promise<string>;
  // Replaces target with a staged file. Callers that replace user originals
  // must still own a verified permanent backup for recovery.
  replaceFile(stagedPath: string, targetPath: string, options?: ReplaceFileOptions): Promise<{ leftoverRollbackPath: string | null }>;
  // Exposes only the old/new revisions of an already-journaled local cache
  // replacement, allowing synchronous unload journaling to bind to either
  // crash-safe transaction outcome without accepting an unrelated Sync write.
  getInFlightReplacementRevisions?(targetPath: string): Array<string | null>;
  // Removes only the exact content revision named by expectedSha256. The
  // implementation durably journals its quarantine before detaching the path.
  removeFileIfUnchanged(filePath: string, expectedSha256: string, bufferedOperationToken?: BufferedOperationToken): Promise<RemoveFileIfUnchangedResult>;
  removeFile(filePath: string): Promise<void>;
  removeDir(dirPath: string, options: { recursive: boolean; force: boolean; maxRetries?: number }): Promise<void>;
  listNames(dirPath: string): Promise<string[]>;
  listEntries(dirPath: string): Promise<FsDirEntry[]>;
  stat(filePath: string): Promise<FsStat | null>;
  // No-follow stat; throws when the path is missing. Mobile maps adapter stat
  // (no symlink surface) onto the same shape.
  lstat(filePath: string): Promise<FsLstat>;
  // Canonical on-disk path. Desktop resolves symlinks and throws on missing
  // paths like fs.realpath; mobile returns the normalized input.
  realpath(filePath: string): Promise<string>;
  // Chunked byte-equality check without loading both files on desktop.
  compareFileContents(leftPath: string, rightPath: string, bufferedOperationToken?: BufferedOperationToken): Promise<boolean>;
  // Serializes full-buffer mobile work across compression, cache, hashing,
  // comparisons and recovery. Desktop executes immediately.
  runBufferedOperation<T>(operation: (token: BufferedOperationToken) => Promise<T>, token?: BufferedOperationToken): Promise<T>;
  // Genuine exclusive create. null where the adapter cannot provide it.
  readonly writeExclusive: ((filePath: string, text: string) => Promise<boolean>) | null;
  // Atomic read-modify-write for text. Mobile maps this to DataAdapter.process;
  // desktop uses its lock + staged replacement path instead.
  readonly processTextAtomically: ((filePath: string, initialText: string, update: (current: string) => string) => Promise<string>) | null;
  fsyncBestEffort(filePath: string): Promise<void>;
  // Desktop shows users absolute filesystem paths; mobile shows vault-relative.
  getDisplayPath(filePath: string): string;
  // null on mobile: the adapter has no synchronous surface.
  readonly sync: FsSyncPort | null;
  // null on mobile: no symlink/inode surface behind the adapter sandbox.
  readonly restoreProbe: FsRestoreProbe | null;
  // null on mobile: DataAdapter.process is the cache serialization primitive.
  readonly lease: FsLeasePort | null;
  // Repairs an interrupted mobile rollback swap before migrations or writes.
  recoverInterruptedReplacement(): Promise<void>;
};

export type PathOps = Pick<FsPort, "joinPath" | "dirnamePath">;

export type HashPort = {
  md5Hex(data: Uint8Array): string;
  sha256Hex(data: Uint8Array | string): string;
  fileSha256Hex(filePath: string, bufferedOperationToken?: BufferedOperationToken): Promise<string>;
};

export type RuntimePort = {
  readonly instanceId: number;
  readonly isCaseInsensitiveFs: boolean;
  // null on streaming desktop; mobile full-buffer maintenance must stay
  // within this per-file ceiling.
  readonly maxBufferedFileBytes: number | null;
  // null on mobile: no OS file manager to reveal paths in. The desktop port
  // resolves the shared vault-relative path at this native integration edge.
  readonly revealPath: ((vaultRelativePath: string) => Promise<string>) | null;
};

export type PlatformPorts = {
  fs: FsPort;
  hash: HashPort;
  runtime: RuntimePort;
};
