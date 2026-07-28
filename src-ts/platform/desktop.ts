import type * as obsidian from "obsidian";
import { getErrorCode, getVaultFolderPath, isAbsoluteFilesystemPath, isSafeVaultRelativePath, normalizeVaultPath, stripWindowsLongPathPrefix, toVaultRelativePath, vaultBasename } from "../utils";
import type { BufferedOperationToken, FsDirEntry, FsLease, FsLeasePort, FsLstat, FsPort, FsRestoreProbe, FsStat, FsSyncPort, HandleIdentity, HashPort, MoveFileToUniqueSiblingOptions, PlatformPorts, RemoveFileIfUnchangedResult, ReplaceFileOptions, RuntimePort } from "./ports";

type VaultBasePathAdapter = {
  getBasePath?: () => string;
};

type AppOrVaultWithAdapter = {
  vault?: {
    adapter?: unknown;
  };
  adapter?: unknown;
};

// Desktop-only vault base-path resolution: mobile adapters expose no base
// path, and every caller is either this port or a desktop-gated code path.
export function getVaultBasePathFromAdapter(adapter: unknown, fallback?: string): string {
  const candidate = adapter as VaultBasePathAdapter | null | undefined;
  try {
    const methodPath = typeof candidate?.getBasePath === "function" ? candidate.getBasePath() : "";
    if (typeof methodPath === "string" && isAbsoluteFilesystemPath(methodPath)) {
      return stripWindowsLongPathPrefix(methodPath);
    }
  } catch (error) {
    void error;
  }
  if (typeof fallback === "string" && isAbsoluteFilesystemPath(fallback)) {
    return stripWindowsLongPathPrefix(fallback);
  }
  throw new Error("Vault filesystem base path is unavailable; refusing filesystem access outside the vault.");
}

export function getVaultBasePath(appOrVault: AppOrVaultWithAdapter | null | undefined, fallback?: string): string {
  const vault = appOrVault?.vault || appOrVault;
  return getVaultBasePathFromAdapter(vault?.adapter, fallback);
}

// Desktop port implementations. This file is the single sanctioned home for
// Node and Electron APIs (see validate-manifest.js allowlist). Modules are
// required lazily inside functions so the bundle can load on mobile, where
// these code paths are never taken.

type NodeFsModule = typeof import("fs");
type NodePathModule = typeof import("path");
type NodeCryptoModule = typeof import("crypto");
type ElectronModule = {
  shell: {
    openPath(targetPath: string): Promise<string>;
    trashItem(targetPath: string): Promise<void>;
  };
};
type NodeFileHandle = Awaited<ReturnType<NodeFsModule["promises"]["open"]>>;
type NodeStats = import("fs").Stats;

const DESKTOP_REPLACEMENT_JOURNAL_DIR = ".local-image-compress/recovery";
const DESKTOP_REPLACEMENT_JOURNAL_PATTERN = /^desktop-replacement-journal-v1-[a-f0-9]{32}-[a-f0-9]{32}\.json$/i;
const DESKTOP_CLEANUP_JOURNAL_PATTERN = /^desktop-cleanup-journal-v1-[a-f0-9]{32}-[a-f0-9]{32}\.json$/i;
const DESKTOP_DEVICE_OWNER_STORAGE_KEY = "local-image-compress:desktop-device-owner-v1";
const DESKTOP_ID_PATTERN = /^[a-f0-9]{32}$/i;
const DESKTOP_REPLACEMENT_QUEUE_SYMBOL = Symbol.for("local-image-compress.desktop-replacement-queue");
const DESKTOP_CACHE_LEASE_RECLAIM_QUEUES_SYMBOL = Symbol.for("local-image-compress.desktop-cache-lease-reclaim-queues");
const DESKTOP_CACHE_LEASE_ACTIVE_RECLAIMS_SYMBOL = Symbol.for("local-image-compress.desktop-cache-lease-active-reclaims");
const DESKTOP_CACHE_LEASE_ID_PATTERN = /^[a-f0-9]{32}$/i;

type DesktopReplacementPhase = "prepared" | "detached" | "installed";

type DesktopReplacementJournal = {
  version: 1;
  ownerId: string;
  transactionId: string;
  stagedPath: string;
  targetPath: string;
  rollbackPath: string | null;
  stagedSha256: string;
  expectedTargetSha256: string | null;
  rollbackSha256: string | null;
  phase: DesktopReplacementPhase;
};

type StoredDesktopReplacementJournal = DesktopReplacementJournal & {
  checksum: string;
};

type DesktopCleanupJournal = {
  version: 1;
  ownerId: string;
  transactionId: string;
  sourcePath: string;
  quarantinePath: string;
  expectedSha256: string;
};

type StoredDesktopCleanupJournal = DesktopCleanupJournal & {
  checksum: string;
};

type DesktopReplacementWindow = Window & {
  [DESKTOP_REPLACEMENT_QUEUE_SYMBOL]?: Promise<void>;
};

type DesktopCacheLeaseWindow = Window & {
  [DESKTOP_CACHE_LEASE_RECLAIM_QUEUES_SYMBOL]?: Map<string, Promise<void>>;
  [DESKTOP_CACHE_LEASE_ACTIVE_RECLAIMS_SYMBOL]?: Set<string>;
};

type DesktopCacheLeasePayload = {
  version: 1;
  deviceOwnerId: string;
  ownerId: string;
  leaseId: string;
  ownerPath: string;
  pid: number;
  createdAt: number;
};

type DesktopReclaimMarkerPayload = {
  version: 1;
  deviceOwnerId: string;
  markerId: string;
  ownerPath: string;
  pid: number;
  createdAt: number;
};

type DesktopFileIdentity = {
  dev: number;
  ino: number;
};

let nodeFsModule: NodeFsModule | null = null;
let nodePathModule: NodePathModule | null = null;
let nodeCryptoModule: NodeCryptoModule | null = null;
let electronModule: ElectronModule | null = null;

function nodeFs(): NodeFsModule {
  return (nodeFsModule ??= require("fs") as NodeFsModule);
}

function nodePath(): NodePathModule {
  return (nodePathModule ??= require("path") as NodePathModule);
}

function nodeCrypto(): NodeCryptoModule {
  return (nodeCryptoModule ??= require("crypto") as NodeCryptoModule);
}

function electronShell(): ElectronModule["shell"] {
  return (electronModule ??= require("electron") as ElectronModule).shell;
}

function getOrCreateDesktopDeviceOwnerId(): string | null {
  try {
    const existing = window.localStorage.getItem(DESKTOP_DEVICE_OWNER_STORAGE_KEY);
    if (existing && DESKTOP_ID_PATTERN.test(existing)) {
      return existing.toLowerCase();
    }
    const ownerId = nodeCrypto().randomBytes(16).toString("hex");
    window.localStorage.setItem(DESKTOP_DEVICE_OWNER_STORAGE_KEY, ownerId);
    return window.localStorage.getItem(DESKTOP_DEVICE_OWNER_STORAGE_KEY) === ownerId ? ownerId : null;
  } catch (error) {
    console.error("[Local Image Compress] Desktop recovery identity is unavailable:", error);
    return null;
  }
}

async function runInDesktopReplacementQueue<T>(operation: () => Promise<T>): Promise<T> {
  const sharedWindow = window as DesktopReplacementWindow;
  const previous = sharedWindow[DESKTOP_REPLACEMENT_QUEUE_SYMBOL] || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  sharedWindow[DESKTOP_REPLACEMENT_QUEUE_SYMBOL] = previous.catch(() => undefined).then(() => current);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
  }
}

function getDesktopCacheLeaseReclaimQueues(): Map<string, Promise<void>> {
  const sharedWindow = window as DesktopCacheLeaseWindow;
  return (sharedWindow[DESKTOP_CACHE_LEASE_RECLAIM_QUEUES_SYMBOL] ??= new Map<string, Promise<void>>());
}

function getDesktopCacheLeaseActiveReclaims(): Set<string> {
  const sharedWindow = window as DesktopCacheLeaseWindow;
  return (sharedWindow[DESKTOP_CACHE_LEASE_ACTIVE_RECLAIMS_SYMBOL] ??= new Set<string>());
}

function isDesktopCacheLeaseReclaimBusy(lockPath: string): boolean {
  return getDesktopCacheLeaseReclaimQueues().has(lockPath)
    || getDesktopCacheLeaseActiveReclaims().has(lockPath);
}

async function runInDesktopCacheLeaseReclaimQueue<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  const queues = getDesktopCacheLeaseReclaimQueues();
  const previous = queues.get(lockPath) || Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => current);
  queues.set(lockPath, tail);
  await previous.catch(() => undefined);
  const activeReclaims = getDesktopCacheLeaseActiveReclaims();
  activeReclaims.add(lockPath);
  try {
    return await operation();
  } finally {
    activeReclaims.delete(lockPath);
    release();
    if (queues.get(lockPath) === tail) {
      queues.delete(lockPath);
    }
  }
}

function toArrayBuffer(buffer: Uint8Array): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

// Desktop-only helpers consumed directly by desktop code paths until the
// full port wiring lands; they keep their historical names and semantics.
export async function streamHashSha256(filePath: string): Promise<string> {
  const fs = nodeFs();
  const crypto = nodeCrypto();
  return await new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
    stream.on("data", (chunk) => {
      hash.update(chunk);
    });
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

export async function openFilesystemPath(targetPath: string): Promise<string> {
  return await electronShell().openPath(targetPath);
}

class DesktopHashPort implements HashPort {
  constructor(private readonly resolvePath: (filePath: string) => string) {}

  md5Hex(data: Uint8Array): string {
    return nodeCrypto().createHash("md5").update(data).digest("hex");
  }

  sha256Hex(data: Uint8Array | string): string {
    return nodeCrypto().createHash("sha256").update(data).digest("hex");
  }

  async fileSha256Hex(filePath: string): Promise<string> {
    return await streamHashSha256(this.resolvePath(filePath));
  }
}

class DesktopFsLeasePort implements FsLeasePort {
  private readonly syncPort: DesktopFsSyncLeasePort;

  constructor(
    private readonly resolvePath: (filePath: string) => string,
    private readonly deviceOwnerId: string | null
  ) {
    this.syncPort = new DesktopFsSyncLeasePort(resolvePath, deviceOwnerId);
  }

  private getOwnerPath(lockPath: string, leaseId: string): string {
    return `${lockPath}.owner-${leaseId}`;
  }

  private getScopedLockPath(lockPath: string): string {
    return `${lockPath}.device-${this.deviceOwnerId || "unavailable"}`;
  }

  private getReclaimMarkerPath(lockPath: string): string {
    return `${lockPath}.reclaiming`;
  }

  private getReclaimMarkerOwnerPath(lockPath: string, markerId: string): string {
    return `${this.getReclaimMarkerPath(lockPath)}.owner-${markerId}`;
  }

  private getReclaimRecoveryPath(lockPath: string): string {
    return `${this.getReclaimMarkerPath(lockPath)}.recovery`;
  }

  private getHeartbeatPath(ownerPath: string): string {
    return `${ownerPath}.heartbeat`;
  }

  private getReleasedPath(ownerPath: string): string {
    return `${ownerPath}.released`;
  }

  private getPayload(lockPath: string, ownerId: string, leaseId: string): DesktopCacheLeasePayload {
    return {
      version: 1,
      deviceOwnerId: this.deviceOwnerId || "",
      ownerId,
      leaseId,
      ownerPath: this.getOwnerPath(lockPath, leaseId),
      pid: process.pid,
      createdAt: Date.now()
    };
  }

  private parsePayload(rawData: string, lockPath: string): DesktopCacheLeasePayload | null {
    try {
      const value: unknown = JSON.parse(rawData);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
      }
      const record = value as Record<string, unknown>;
      const leaseId = typeof record["leaseId"] === "string" ? record["leaseId"] : "";
      const ownerId = typeof record["ownerId"] === "string" ? record["ownerId"] : "";
      const deviceOwnerId = typeof record["deviceOwnerId"] === "string" ? record["deviceOwnerId"] : "";
      const ownerPath = typeof record["ownerPath"] === "string" ? record["ownerPath"] : "";
      const expectedOwnerPath = this.getOwnerPath(lockPath, leaseId);
      const pid = Number(record["pid"]);
      const createdAt = Number(record["createdAt"]);
      if (record["version"] !== 1
        || !DESKTOP_CACHE_LEASE_ID_PATTERN.test(leaseId)
        || !ownerId || ownerId.length > 256
        || !DESKTOP_ID_PATTERN.test(deviceOwnerId)
        || nodePath().resolve(this.resolvePath(ownerPath)) !== nodePath().resolve(this.resolvePath(expectedOwnerPath))
        || !Number.isSafeInteger(pid) || pid <= 0
        || !Number.isFinite(createdAt) || createdAt <= 0) {
        return null;
      }
      return { version: 1, deviceOwnerId, ownerId, leaseId, ownerPath: expectedOwnerPath, pid, createdAt };
    } catch (error) {
      void error;
      return null;
    }
  }

  private parseReclaimMarkerPayload(rawData: string, lockPath: string): DesktopReclaimMarkerPayload | null {
    try {
      const value: unknown = JSON.parse(rawData);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
      }
      const record = value as Record<string, unknown>;
      const markerId = typeof record["markerId"] === "string" ? record["markerId"] : "";
      const deviceOwnerId = typeof record["deviceOwnerId"] === "string" ? record["deviceOwnerId"] : "";
      const ownerPath = typeof record["ownerPath"] === "string" ? record["ownerPath"] : "";
      const expectedOwnerPath = this.getReclaimMarkerOwnerPath(lockPath, markerId);
      const pid = Number(record["pid"]);
      const createdAt = Number(record["createdAt"]);
      if (record["version"] !== 1
        || !DESKTOP_CACHE_LEASE_ID_PATTERN.test(markerId)
        || !DESKTOP_ID_PATTERN.test(deviceOwnerId)
        || nodePath().resolve(this.resolvePath(ownerPath)) !== nodePath().resolve(this.resolvePath(expectedOwnerPath))
        || !Number.isSafeInteger(pid) || pid <= 0
        || !Number.isFinite(createdAt) || createdAt <= 0) {
        return null;
      }
      return { version: 1, deviceOwnerId, markerId, ownerPath: expectedOwnerPath, pid, createdAt };
    } catch (error) {
      void error;
      return null;
    }
  }

  private identitiesMatch(left: DesktopFileIdentity | null, right: DesktopFileIdentity | null): boolean {
    return !!left && !!right && left.dev === right.dev && left.ino === right.ino;
  }

  private async getIdentity(filePath: string): Promise<DesktopFileIdentity | null> {
    try {
      const stat = await nodeFs().promises.lstat(this.resolvePath(filePath));
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return null;
      }
      return { dev: stat.dev, ino: stat.ino };
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private isProcessProvablyDead(pid: number): boolean {
    if (pid === process.pid) {
      // The same PID can own a lease in another live Obsidian window. A stale
      // same-process owner is therefore unverifiable and must fail closed.
      return false;
    }
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return getErrorCode(error) === "ESRCH";
    }
  }

  private async readPayload(lockPath: string): Promise<DesktopCacheLeasePayload | null> {
    try {
      const rawData = await nodeFs().promises.readFile(this.resolvePath(lockPath), "utf8");
      return this.parsePayload(rawData, lockPath);
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async readReclaimMarkerPayload(filePath: string, lockPath: string): Promise<DesktopReclaimMarkerPayload | null> {
    try {
      const rawData = await nodeFs().promises.readFile(this.resolvePath(filePath), "utf8");
      return this.parseReclaimMarkerPayload(rawData, lockPath);
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private async removeIfPresent(filePath: string): Promise<void> {
    try {
      await nodeFs().promises.unlink(this.resolvePath(filePath));
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") {
        throw error;
      }
    }
  }

  private async writeCompleteOwner(ownerPath: string, payload: DesktopCacheLeasePayload): Promise<void> {
    const fs = nodeFs();
    let handle: NodeFileHandle | null = null;
    try {
      handle = await fs.promises.open(this.resolvePath(ownerPath), "wx");
      await handle.writeFile(JSON.stringify(payload));
      await handle.sync();
    } finally {
      await handle?.close();
    }
  }

  private async detachMatchingFile(filePath: string, expectedIdentity: DesktopFileIdentity, purpose: string): Promise<string | null> {
    if (!this.identitiesMatch(await this.getIdentity(filePath), expectedIdentity)) {
      return null;
    }
    const detachedPath = `${filePath}.${purpose}-${nodeCrypto().randomBytes(16).toString("hex")}`;
    try {
      await nodeFs().promises.rename(this.resolvePath(filePath), this.resolvePath(detachedPath));
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        return null;
      }
      throw error;
    }
    if (this.identitiesMatch(await this.getIdentity(detachedPath), expectedIdentity)) {
      return detachedPath;
    }
    await this.restoreMovedObject(detachedPath, filePath);
    return null;
  }

  private async finishStaleReclaimMarkerRecovery(
    lockPath: string,
    payload: DesktopReclaimMarkerPayload,
    recoveryIdentity: DesktopFileIdentity
  ): Promise<boolean> {
    const markerPath = this.getReclaimMarkerPath(lockPath);
    const markerIdentity = await this.getIdentity(markerPath);
    if (!markerIdentity) {
      const detachedRecovery = await this.detachMatchingFile(
        this.getReclaimRecoveryPath(lockPath),
        recoveryIdentity,
        "cleared"
      );
      if (!detachedRecovery) {
        return false;
      }
      await this.removeIfPresent(detachedRecovery);
      await this.removeIfPresent(payload.ownerPath);
      return true;
    }
    if (!this.identitiesMatch(markerIdentity, recoveryIdentity)) {
      return false;
    }
    const detachedMarker = await this.detachMatchingFile(markerPath, recoveryIdentity, "stale");
    if (!detachedMarker) {
      // Another recovery worker won the detach. It owns recovery cleanup.
      return false;
    }
    await this.removeIfPresent(detachedMarker);
    const detachedRecovery = await this.detachMatchingFile(
      this.getReclaimRecoveryPath(lockPath),
      recoveryIdentity,
      "cleared"
    );
    if (!detachedRecovery) {
      return false;
    }
    await this.removeIfPresent(detachedRecovery);
    await this.removeIfPresent(payload.ownerPath);
    return true;
  }

  private async recoverStaleReclaimMarker(lockPath: string): Promise<boolean> {
    const markerPath = this.getReclaimMarkerPath(lockPath);
    const recoveryPath = this.getReclaimRecoveryPath(lockPath);
    const recoveryPayload = await this.readReclaimMarkerPayload(recoveryPath, lockPath);
    if (recoveryPayload) {
      const [recoveryIdentity, ownerIdentity] = await Promise.all([
        this.getIdentity(recoveryPath),
        this.getIdentity(recoveryPayload.ownerPath)
      ]);
      if (!this.deviceOwnerId
        || recoveryPayload.deviceOwnerId !== this.deviceOwnerId
        || !this.identitiesMatch(recoveryIdentity, ownerIdentity)
        || !recoveryIdentity
        || !this.isProcessProvablyDead(recoveryPayload.pid)) {
        return false;
      }
      return await this.finishStaleReclaimMarkerRecovery(lockPath, recoveryPayload, recoveryIdentity);
    }
    if (await this.getIdentity(recoveryPath)) {
      return false;
    }
    const markerPayload = await this.readReclaimMarkerPayload(markerPath, lockPath);
    if (!markerPayload
      || !this.deviceOwnerId
      || markerPayload.deviceOwnerId !== this.deviceOwnerId
      || !this.isProcessProvablyDead(markerPayload.pid)) {
      return false;
    }
    const [markerIdentity, ownerIdentity] = await Promise.all([
      this.getIdentity(markerPath),
      this.getIdentity(markerPayload.ownerPath)
    ]);
    if (!markerIdentity || !this.identitiesMatch(markerIdentity, ownerIdentity)) {
      return false;
    }
    try {
      await nodeFs().promises.link(this.resolvePath(markerPayload.ownerPath), this.resolvePath(recoveryPath));
    } catch (error) {
      if (getErrorCode(error) === "EEXIST") {
        return false;
      }
      throw error;
    }
    const [currentMarkerIdentity, recoveryIdentity] = await Promise.all([
      this.getIdentity(markerPath),
      this.getIdentity(recoveryPath)
    ]);
    if (!recoveryIdentity
      || !this.identitiesMatch(currentMarkerIdentity, markerIdentity)
      || !this.identitiesMatch(recoveryIdentity, markerIdentity)) {
      if (recoveryIdentity && this.identitiesMatch(recoveryIdentity, markerIdentity)) {
        const detachedRecovery = await this.detachMatchingFile(recoveryPath, recoveryIdentity, "aborted");
        if (detachedRecovery) {
          await this.removeIfPresent(detachedRecovery);
        }
      }
      return false;
    }
    return await this.finishStaleReclaimMarkerRecovery(lockPath, markerPayload, recoveryIdentity);
  }

  private async acquireReclaimMarker(lockPath: string): Promise<string | null> {
    const fs = nodeFs();
    await this.recoverStaleReclaimMarker(lockPath);
    const markerPath = this.getReclaimMarkerPath(lockPath);
    const recoveryPath = this.getReclaimRecoveryPath(lockPath);
    if (await this.getIdentity(recoveryPath)) {
      return null;
    }
    const markerId = nodeCrypto().randomBytes(16).toString("hex");
    const ownerPath = this.getReclaimMarkerOwnerPath(lockPath, markerId);
    const payload: DesktopReclaimMarkerPayload = {
      version: 1,
      deviceOwnerId: this.deviceOwnerId || "",
      markerId,
      ownerPath,
      pid: process.pid,
      createdAt: Date.now()
    };
    let handle: NodeFileHandle | null = null;
    try {
      handle = await fs.promises.open(this.resolvePath(ownerPath), "wx");
      await handle.writeFile(JSON.stringify(payload));
      await handle.sync();
      await handle.close();
      handle = null;
      if (await this.getIdentity(recoveryPath)) {
        await this.removeIfPresent(ownerPath);
        return null;
      }
      await fs.promises.link(this.resolvePath(ownerPath), this.resolvePath(markerPath));
      if (await this.getIdentity(recoveryPath)) {
        await this.releaseReclaimMarker(lockPath, ownerPath);
        return null;
      }
      return ownerPath;
    } catch (error) {
      await handle?.close();
      await this.removeIfPresent(ownerPath);
      if (getErrorCode(error) === "EEXIST") {
        return null;
      }
      throw error;
    }
  }

  private async releaseReclaimMarker(lockPath: string, ownerPath: string): Promise<void> {
    const ownerIdentity = await this.getIdentity(ownerPath);
    const markerPath = this.getReclaimMarkerPath(lockPath);
    if (ownerIdentity) {
      const detachedMarker = await this.detachMatchingFile(markerPath, ownerIdentity, "released");
      if (detachedMarker) {
        await this.removeIfPresent(detachedMarker);
      }
    }
    await this.removeIfPresent(ownerPath);
  }

  private async restoreMovedObject(quarantinePath: string, lockPath: string): Promise<void> {
    const fs = nodeFs();
    try {
      await fs.promises.link(this.resolvePath(quarantinePath), this.resolvePath(lockPath));
      await this.removeIfPresent(quarantinePath);
    } catch (error) {
      if (getErrorCode(error) !== "EEXIST") {
        throw error;
      }
    }
  }

  private async reclaimProvablyReleasedOrDeadOwnerUnlocked(lockPath: string): Promise<boolean> {
    const payload = await this.readPayload(lockPath);
    if (!payload || !this.deviceOwnerId || payload.deviceOwnerId !== this.deviceOwnerId) {
      return false;
    }
    const [lockIdentity, ownerIdentity, releasedIdentity] = await Promise.all([
      this.getIdentity(lockPath),
      this.getIdentity(payload.ownerPath),
      this.getIdentity(this.getReleasedPath(payload.ownerPath))
    ]);
    if (!this.identitiesMatch(lockIdentity, ownerIdentity)) {
      return false;
    }
    const wasReleased = this.identitiesMatch(releasedIdentity, ownerIdentity);
    if (!wasReleased && !this.isProcessProvablyDead(payload.pid)) {
      return false;
    }
    const quarantinePath = `${lockPath}.reclaim-${nodeCrypto().randomBytes(16).toString("hex")}`;
    try {
      await nodeFs().promises.rename(this.resolvePath(lockPath), this.resolvePath(quarantinePath));
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        return true;
      }
      throw error;
    }
    const movedIdentity = await this.getIdentity(quarantinePath);
    if (!this.identitiesMatch(movedIdentity, ownerIdentity)) {
      await this.restoreMovedObject(quarantinePath, lockPath);
      return false;
    }
    await this.removeIfPresent(quarantinePath);
    await this.removeIfPresent(payload.ownerPath);
    await this.removeIfPresent(this.getHeartbeatPath(payload.ownerPath));
    await this.removeIfPresent(this.getReleasedPath(payload.ownerPath));
    return true;
  }

  private async reclaimProvablyReleasedOrDeadOwner(lockPath: string): Promise<boolean> {
    return await runInDesktopCacheLeaseReclaimQueue(this.resolvePath(lockPath), async () => {
      const markerOwnerPath = await this.acquireReclaimMarker(lockPath);
      if (!markerOwnerPath) {
        return false;
      }
      try {
        return await this.reclaimProvablyReleasedOrDeadOwnerUnlocked(lockPath);
      } finally {
        await this.releaseReclaimMarker(lockPath, markerOwnerPath);
      }
    });
  }

  async acquire(lockPath: string, ownerId: string, timeoutMs: number, retryMs: number): Promise<FsLease | null> {
    if (!this.deviceOwnerId) {
      return null;
    }
    lockPath = this.getScopedLockPath(lockPath);
    const fs = nodeFs();
    await fs.promises.mkdir(nodePath().dirname(this.resolvePath(lockPath)), { recursive: true });
    const resolvedLockPath = this.resolvePath(lockPath);
    const startedAt = Date.now();
    do {
      if (isDesktopCacheLeaseReclaimBusy(resolvedLockPath)) {
        if (Date.now() - startedAt >= timeoutMs) {
          break;
        }
        await new Promise((resolve) => window.setTimeout(resolve, retryMs));
        continue;
      }
      const leaseId = nodeCrypto().randomBytes(16).toString("hex");
      const ownerPath = this.getOwnerPath(lockPath, leaseId);
      const lease: FsLease = { lockPath, ownerPath, ownerId, leaseId };
      let ownerCreated = false;
      let claimed = false;
      try {
        await this.writeCompleteOwner(ownerPath, this.getPayload(lockPath, ownerId, leaseId));
        ownerCreated = true;
        if (isDesktopCacheLeaseReclaimBusy(resolvedLockPath)) {
          await this.removeIfPresent(ownerPath);
          ownerCreated = false;
          if (Date.now() - startedAt >= timeoutMs) {
            break;
          }
          await new Promise((resolve) => window.setTimeout(resolve, retryMs));
          continue;
        }
        await fs.promises.link(this.resolvePath(ownerPath), this.resolvePath(lockPath));
        claimed = true;
        if (!await this.renew(lease)) {
          await this.release(lease);
          return null;
        }
        return lease;
      } catch (error) {
        if (claimed) {
          await this.release(lease);
        } else if (ownerCreated) {
          await this.removeIfPresent(ownerPath);
          await this.removeIfPresent(this.getHeartbeatPath(ownerPath));
        }
        if (getErrorCode(error) !== "EEXIST") {
          throw error;
        }
      }
      if (await this.reclaimProvablyReleasedOrDeadOwner(lockPath)) {
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        break;
      }
      await new Promise((resolve) => window.setTimeout(resolve, retryMs));
    } while (Date.now() - startedAt <= timeoutMs);
    return null;
  }

  acquireSync(lockPath: string, ownerId: string, timeoutMs: number, retryMs: number): FsLease | null {
    return this.syncPort.acquireSync(lockPath, ownerId, timeoutMs, retryMs);
  }

  async validate(lease: FsLease): Promise<boolean> {
    const [lockIdentity, ownerIdentity, releasedIdentity] = await Promise.all([
      this.getIdentity(lease.lockPath),
      this.getIdentity(lease.ownerPath),
      this.getIdentity(this.getReleasedPath(lease.ownerPath))
    ]);
    return this.identitiesMatch(lockIdentity, ownerIdentity) && releasedIdentity === null;
  }

  validateSync(lease: FsLease): boolean {
    return this.syncPort.validateSync(lease);
  }

  async renew(lease: FsLease): Promise<boolean> {
    if (!await this.validate(lease)) {
      return false;
    }
    const heartbeatPath = this.getHeartbeatPath(lease.ownerPath);
    const stagedPath = `${heartbeatPath}.stage-${nodeCrypto().randomBytes(16).toString("hex")}`;
    try {
      await nodeFs().promises.writeFile(this.resolvePath(stagedPath), String(Date.now()), { flag: "wx" });
      await this.removeIfPresent(heartbeatPath);
      await nodeFs().promises.rename(this.resolvePath(stagedPath), this.resolvePath(heartbeatPath));
      return await this.validate(lease);
    } finally {
      await this.removeIfPresent(stagedPath);
    }
  }

  renewSync(lease: FsLease): boolean {
    return this.syncPort.renewSync(lease);
  }

  async release(lease: FsLease): Promise<boolean> {
    const ownerIdentity = await this.getIdentity(lease.ownerPath);
    if (!ownerIdentity) {
      return false;
    }
    const releasedPath = this.getReleasedPath(lease.ownerPath);
    try {
      await nodeFs().promises.link(this.resolvePath(lease.ownerPath), this.resolvePath(releasedPath));
    } catch (error) {
      if (getErrorCode(error) !== "EEXIST") {
        throw error;
      }
    }
    if (!this.identitiesMatch(await this.getIdentity(releasedPath), ownerIdentity)) {
      return false;
    }
    // Do not unlink or rename the canonical lock during release. The hard-linked
    // marker lets the next acquirer reclaim this exact inode, while a concurrently
    // replaced foreign lock stays continuously present and untouched.
    return this.identitiesMatch(await this.getIdentity(lease.lockPath), ownerIdentity);
  }

  releaseSync(lease: FsLease): boolean {
    return this.syncPort.releaseSync(lease);
  }
}

class DesktopFsPort implements FsPort {
  readonly sync: FsSyncPort;
  readonly restoreProbe: FsRestoreProbe;
  readonly lease: FsLeasePort;
  readonly processTextAtomically = null;
  private readonly deviceOwnerId = getOrCreateDesktopDeviceOwnerId();
  private readonly inFlightReplacementRevisions = new Map<string, Array<string | null>>();

  // The base path is read lazily so adapter re-pointing (tests, vault moves)
  // keeps resolving against the current vault base, matching historical
  // call-time getVaultBasePath() semantics.
  constructor(
    private readonly getBasePath: () => string,
    private readonly trashLocal?: (vaultRelativePath: string) => Promise<void>
  ) {
    this.sync = new DesktopFsSyncPort((filePath) => this.resolve(filePath));
    this.restoreProbe = new DesktopFsRestoreProbe((filePath) => this.resolve(filePath));
    this.lease = new DesktopFsLeasePort((filePath) => this.resolve(filePath), this.deviceOwnerId);
  }

  async runBufferedOperation<T>(operation: (token: BufferedOperationToken) => Promise<T>, token?: BufferedOperationToken): Promise<T> {
    return await operation(token || ({} as BufferedOperationToken));
  }

  resolve(filePath: string): string {
    const value = normalizeVaultPath(String(filePath || ""));
    if (value && !isSafeVaultRelativePath(value)) {
      throw new Error(`Desktop FsPort requires a vault-relative path: ${filePath}`);
    }
    return value
      ? nodePath().join(this.getBasePath(), ...value.split("/"))
      : this.getBasePath();
  }

  resolvePath(filePath: string): string {
    return this.resolve(filePath);
  }

  joinPath(...segments: string[]): string {
    const joined = normalizeVaultPath(segments.filter((segment) => segment !== "").join("/"));
    if (joined && !isSafeVaultRelativePath(joined)) {
      throw new Error(`Desktop FsPort cannot join a path outside the vault: ${joined}`);
    }
    return joined;
  }

  dirnamePath(filePath: string): string {
    const normalized = normalizeVaultPath(filePath);
    if (normalized && !isSafeVaultRelativePath(normalized)) {
      throw new Error(`Desktop FsPort requires a vault-relative path: ${filePath}`);
    }
    return getVaultFolderPath(normalized);
  }

  canonicalizePath(filePath: string): string {
    return nodePath().resolve(this.resolve(filePath));
  }

  toVaultRelativePath(filePath: string): string {
    const relativePath = normalizeVaultPath(toVaultRelativePath(filePath, this.getBasePath()));
    if (relativePath && !isSafeVaultRelativePath(relativePath)) {
      throw new Error(`Path is outside the vault: ${filePath}`);
    }
    return relativePath;
  }

  getDisplayPath(filePath: string): string {
    return this.resolve(filePath);
  }

  async exists(filePath: string): Promise<boolean> {
    const resolvedPath = this.resolve(filePath);
    try {
      await nodeFs().promises.access(resolvedPath);
      return true;
    } catch (error) {
      void error;
      return false;
    }
  }

  getInFlightReplacementRevisions(targetPath: string): Array<string | null> {
    return [...(this.inFlightReplacementRevisions.get(this.resolve(targetPath)) || [])];
  }

  async mkdir(dirPath: string): Promise<void> {
    await nodeFs().promises.mkdir(this.resolve(dirPath), { recursive: true });
  }

  async readText(filePath: string): Promise<string> {
    return await nodeFs().promises.readFile(this.resolve(filePath), "utf8");
  }

  async writeText(filePath: string, text: string): Promise<void> {
    await nodeFs().promises.writeFile(this.resolve(filePath), text);
  }

  async readBinary(filePath: string): Promise<ArrayBuffer> {
    return toArrayBuffer(await nodeFs().promises.readFile(this.resolve(filePath)));
  }

  async writeBinary(filePath: string, data: ArrayBuffer): Promise<void> {
    await nodeFs().promises.writeFile(this.resolve(filePath), new Uint8Array(data));
  }

  async copyFile(sourcePath: string, targetPath: string, options?: {
    exclusive?: boolean;
    bufferedOperationToken?: BufferedOperationToken;
  }): Promise<void> {
    const fs = nodeFs();
    const mode = options?.exclusive ? fs.constants.COPYFILE_EXCL : 0;
    await fs.promises.copyFile(this.resolve(sourcePath), this.resolve(targetPath), mode);
  }

  async moveFileToUniqueSibling(sourcePath: string, options?: MoveFileToUniqueSiblingOptions): Promise<string> {
    const quarantinePath = await this.moveNativeFileToUniqueSibling(
      this.resolve(sourcePath),
      options?.beforeMove
        ? async (nativePath) => await options.beforeMove?.(this.toJournalRelativePath(nativePath))
        : undefined
    );
    return this.toJournalRelativePath(quarantinePath);
  }

  private async moveNativeFileToUniqueSibling(source: string, beforeMove?: (quarantinePath: string) => Promise<void>): Promise<string> {
    const fs = nodeFs();
    const path = nodePath();
    const sourceStat = await fs.promises.lstat(source);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error(`Quarantine source must be a regular file: ${source}`);
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      const quarantineDir = path.join(
        path.dirname(source),
        `.tinylocal-quarantine-${Date.now()}-${nodeCrypto().randomBytes(16).toString("hex")}.tmp`
      );
      try {
        await fs.promises.mkdir(quarantineDir);
      } catch (error) {
        if (getErrorCode(error) === "EEXIST") {
          continue;
        }
        throw error;
      }
      const quarantinePath = path.join(quarantineDir, path.basename(source));
      try {
        await beforeMove?.(quarantinePath);
        await fs.promises.rename(source, quarantinePath);
        return quarantinePath;
      } catch (error) {
        try {
          await fs.promises.rmdir(quarantineDir);
        } catch (cleanupError) {
          console.warn("[Local Image Compress] Empty migration quarantine cleanup failed:", cleanupError);
        }
        throw error;
      }
    }
    throw new Error(`Could not reserve a unique migration quarantine beside: ${source}`);
  }

  async replaceFile(stagedPath: string, targetPath: string, options?: ReplaceFileOptions): Promise<{ leftoverRollbackPath: string | null }> {
    const fs = nodeFs();
    const staged = this.resolve(stagedPath);
    const target = this.resolve(targetPath);
    if (!options) {
      await fs.promises.rename(staged, target);
      return { leftoverRollbackPath: null };
    }
    return await runInDesktopReplacementQueue(async () => {
      if (!this.deviceOwnerId) {
        throw new Error("Device-local recovery identity is unavailable; refusing desktop replacement.");
      }
      await this.recoverInterruptedCleanupUnlocked();
      const unresolvedTargets = await this.recoverInterruptedReplacementUnlocked();
      if (unresolvedTargets.has(target)) {
        throw new Error(`Unresolved local replacement recovery blocks target: ${target}`);
      }
      const stagedStat = await fs.promises.lstat(staged);
      if (!stagedStat.isFile() || stagedStat.isSymbolicLink()) {
        throw new Error(`Replacement source must be a regular file: ${staged}`);
      }
      const stagedHash = await streamHashSha256(staged);
      if (options.expectedStagedSha256 && stagedHash !== options.expectedStagedSha256) {
        throw new Error(`Replacement source changed before install: ${staged}`);
      }
      const targetStat = await this.lstatIfPresent(target);
      if (targetStat && (!targetStat.isFile() || targetStat.isSymbolicLink())) {
        throw new Error(`Replacement target must be a regular file: ${target}`);
      }
      if (targetStat && options.expectedTargetMissing === true) {
        throw new Error(`Expected replacement target to remain missing: ${target}`);
      }
      if (!targetStat && options.expectedTargetSha256 && options.allowMissingTarget !== true) {
        throw new Error(`Expected replacement target is missing: ${target}`);
      }
      const observedTargetHash = targetStat ? await streamHashSha256(target) : null;
      if (options.expectedTargetSha256 && observedTargetHash !== options.expectedTargetSha256) {
        throw new Error(`Replacement target changed before transaction start: ${target}`);
      }
      const transactionId = nodeCrypto().randomBytes(16).toString("hex");
      const rollbackPath = targetStat
        ? nodePath().join(nodePath().dirname(target), `.${nodePath().basename(target)}.tinylocal-rollback-${Date.now()}-${transactionId}.tmp`)
        : null;
      const journal: DesktopReplacementJournal = {
        version: 1,
        ownerId: this.deviceOwnerId,
        transactionId,
        stagedPath: this.toJournalRelativePath(staged),
        targetPath: this.toJournalRelativePath(target),
        rollbackPath: rollbackPath ? this.toJournalRelativePath(rollbackPath) : null,
        stagedSha256: stagedHash,
        expectedTargetSha256: observedTargetHash,
        rollbackSha256: null,
        phase: "prepared"
      };
      const journalPath = this.getReplacementJournalPath(journal);
      await this.writeReplacementJournal(journalPath, journal);
      const trackedRevisions = options.canCommit ? [observedTargetHash, stagedHash] : null;
      if (trackedRevisions) {
        this.inFlightReplacementRevisions.set(target, trackedRevisions);
      }
      try {
        if (options.canCommit && !options.canCommit()) {
          throw new Error(`Replacement commit was cancelled before install: ${target}`);
        }
        if (rollbackPath) {
          await fs.promises.rename(target, rollbackPath);
          const rollbackHash = await streamHashSha256(rollbackPath);
          journal.rollbackSha256 = rollbackHash;
          journal.phase = "detached";
          await this.writeReplacementJournal(journalPath, journal);
          if (rollbackHash !== observedTargetHash) {
            if (await this.restoreRollbackNoClobber(rollbackPath, target, rollbackHash)) {
              await this.removeReplacementJournal(journalPath);
            }
            throw new Error(`Replacement target changed before capture: ${target}`);
          }
        } else {
          journal.phase = "detached";
          await this.writeReplacementJournal(journalPath, journal);
        }
        if (options.canCommit && !options.canCommit()) {
          throw new Error(`Replacement commit was cancelled before publication: ${target}`);
        }
        // A hard link is the native no-clobber publication primitive here:
        // target appears atomically with the exact staged inode or EEXIST wins.
        await fs.promises.link(staged, target);
        if (await streamHashSha256(target) !== stagedHash) {
          throw new Error(`Replacement target changed during install: ${target}`);
        }
        const retainedStagedPath = await this.removeOwnedCleanupRevision(staged, stagedHash, true);
        if (retainedStagedPath) {
          console.warn("[Local Image Compress] Installed replacement retained its detached staged revision:", retainedStagedPath);
        }
        journal.phase = "installed";
        await this.writeReplacementJournal(journalPath, journal);
        let leftoverRollbackPath: string | null = null;
        if (rollbackPath && journal.rollbackSha256) {
          const retainedRollbackPath = await this.removeOwnedCleanupRevision(rollbackPath, journal.rollbackSha256, true);
          if (retainedRollbackPath) {
            leftoverRollbackPath = this.toJournalRelativePath(retainedRollbackPath);
            console.warn("[Local Image Compress] Installed replacement retained its detached rollback safety copy:", retainedRollbackPath);
          }
        }
        await this.removeReplacementJournal(journalPath);
        return { leftoverRollbackPath };
      } catch (error) {
        const unresolvedTarget = await this.recoverReplacementJournal(journalPath, true).catch((recoveryError: unknown) => {
          console.error("[Local Image Compress] Desktop replacement recovery failed:", journalPath, recoveryError);
          return target;
        });
        const targetHash = await this.getFileSha256IfPresent(target);
        if (targetHash === stagedHash) {
          const rollbackExists = rollbackPath && await this.lstatIfPresent(rollbackPath);
          return {
            leftoverRollbackPath: rollbackPath && rollbackExists
              ? this.toJournalRelativePath(rollbackPath)
              : null
          };
        }
        if (unresolvedTarget) {
          throw new Error(`Desktop replacement conflict retained for recovery at ${journalPath}. ${String(error)}`);
        }
        throw error;
      } finally {
        if (trackedRevisions && this.inFlightReplacementRevisions.get(target) === trackedRevisions) {
          this.inFlightReplacementRevisions.delete(target);
        }
      }
    });
  }

  private async lstatIfPresent(filePath: string) {
    try {
      return await nodeFs().promises.lstat(filePath);
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private fileIdentitiesMatch(left: DesktopFileIdentity | null, right: DesktopFileIdentity | null): boolean {
    return !!left && !!right && left.dev === right.dev && left.ino === right.ino;
  }

  private getRegularFileIdentity(stat: NodeStats | null): DesktopFileIdentity | null {
    if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
      return null;
    }
    return { dev: stat.dev, ino: stat.ino };
  }

  private async getFileSha256IfPresent(filePath: string): Promise<string | null> {
    const stat = await this.lstatIfPresent(filePath);
    if (!stat) {
      return null;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Replacement recovery path is not a regular file: ${filePath}`);
    }
    return await streamHashSha256(filePath);
  }

  private toJournalRelativePath(filePath: string): string {
    const relativePath = normalizeVaultPath(toVaultRelativePath(filePath, this.getBasePath()));
    if (!isSafeVaultRelativePath(relativePath)) {
      throw new Error(`Replacement recovery path is outside the vault: ${filePath}`);
    }
    return relativePath;
  }

  private getReplacementJournalPath(journal: DesktopReplacementJournal): string {
    return this.resolve(nodePath().join(
      DESKTOP_REPLACEMENT_JOURNAL_DIR,
      `desktop-replacement-journal-v1-${journal.ownerId}-${journal.transactionId}.json`
    ));
  }

  private serializeReplacementJournal(journal: DesktopReplacementJournal): string {
    const payload: DesktopReplacementJournal = {
      version: 1,
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
    const stored: StoredDesktopReplacementJournal = {
      ...payload,
      checksum: nodeCrypto().createHash("sha256").update(JSON.stringify(payload)).digest("hex")
    };
    return JSON.stringify(stored);
  }

  private parseReplacementJournal(rawJournal: string, journalPath: string): DesktopReplacementJournal {
    const parsed: unknown = JSON.parse(rawJournal);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Invalid desktop replacement journal: ${journalPath}`);
    }
    const record = parsed as Record<string, unknown>;
    const version = record["version"];
    const ownerId = record["ownerId"];
    const transactionId = record["transactionId"];
    const stagedPath = record["stagedPath"];
    const targetPath = record["targetPath"];
    const rollbackValue = record["rollbackPath"];
    const stagedSha256 = record["stagedSha256"];
    const expectedTargetSha256 = record["expectedTargetSha256"];
    const rollbackSha256 = record["rollbackSha256"];
    const phase = record["phase"];
    const checksum = record["checksum"];
    const payload = {
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
    const isSafeCanonicalPath = (value: unknown): value is string => typeof value === "string"
      && value.length > 0
      && value === normalizeVaultPath(value)
      && isSafeVaultRelativePath(value);
    const expectedChecksum = nodeCrypto().createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    if (version !== 1 || typeof checksum !== "string" || checksum.toLowerCase() !== expectedChecksum
      || typeof ownerId !== "string" || !DESKTOP_ID_PATTERN.test(ownerId)
      || typeof transactionId !== "string" || !DESKTOP_ID_PATTERN.test(transactionId)
      || typeof stagedSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(stagedSha256)
      || !isHashOrNull(expectedTargetSha256) || !isHashOrNull(rollbackSha256)
      || !isSafeCanonicalPath(stagedPath) || !isSafeCanonicalPath(targetPath)
      || (phase !== "prepared" && phase !== "detached" && phase !== "installed")) {
      throw new Error(`Invalid desktop replacement journal: ${journalPath}`);
    }
    const targetDir = nodePath().dirname(targetPath);
    const targetName = vaultBasename(targetPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const stagedPattern = new RegExp(`^\\.?${targetName}\\.tinylocal-(?:recovery-)?\\d+-[a-f0-9]{16,32}\\.tmp$`, "i");
    if (nodePath().dirname(stagedPath) !== targetDir || !stagedPattern.test(vaultBasename(stagedPath))) {
      throw new Error(`Invalid desktop replacement staged path; journal retained: ${journalPath}`);
    }
    let rollbackPath: string | null = null;
    if (rollbackValue !== null) {
      if (!isSafeCanonicalPath(rollbackValue)) {
        throw new Error(`Invalid desktop replacement rollback path; journal retained: ${journalPath}`);
      }
      const rollbackPattern = new RegExp(`^\\.${targetName}\\.tinylocal-rollback-\\d+-[a-f0-9]{32}\\.tmp$`, "i");
      if (nodePath().dirname(rollbackValue) !== targetDir || !rollbackPattern.test(vaultBasename(rollbackValue))) {
        throw new Error(`Invalid desktop replacement rollback path; journal retained: ${journalPath}`);
      }
      rollbackPath = rollbackValue;
    }
    const journal: DesktopReplacementJournal = {
      version: 1,
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
      throw new Error(`Desktop replacement journal identity does not match its path: ${journalPath}`);
    }
    return journal;
  }

  private async writeReplacementJournal(journalPath: string, journal: DesktopReplacementJournal): Promise<void> {
    const fs = nodeFs();
    const serialized = this.serializeReplacementJournal(journal);
    await fs.promises.mkdir(nodePath().dirname(journalPath), { recursive: true });
    const existing = await this.lstatIfPresent(journalPath);
    if (!existing) {
      const created = await this.writeExclusiveNative(journalPath, serialized);
      if (!created) {
        throw new Error(`Desktop replacement journal already exists: ${journalPath}`);
      }
      await this.fsyncBestEffortNative(journalPath);
      return;
    }
    const previous = this.parseReplacementJournal(await fs.promises.readFile(journalPath, "utf8"), journalPath);
    if (previous.ownerId !== journal.ownerId || previous.transactionId !== journal.transactionId
      || (previous.phase === "installed" && journal.phase !== "installed")) {
      throw new Error(`Refusing to overwrite unrelated desktop replacement journal: ${journalPath}`);
    }
    const updatePath = `${journalPath}.update-${nodeCrypto().randomBytes(16).toString("hex")}.tmp`;
    let handle: NodeFileHandle | null = null;
    try {
      handle = await fs.promises.open(updatePath, "wx");
      await handle.writeFile(serialized);
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.promises.rename(updatePath, journalPath);
    } finally {
      await handle?.close().catch((error: unknown) => {
        console.warn("[Local Image Compress] Desktop replacement journal handle cleanup failed:", error);
      });
      // A failed update keeps its transaction-unique temp. Deleting by path
      // could destroy a Sync replacement that lands after the failed write.
    }
  }

  private async removeReplacementJournal(journalPath: string): Promise<void> {
    try {
      const rawJournal = await nodeFs().promises.readFile(journalPath, "utf8");
      const journal = this.parseReplacementJournal(rawJournal, journalPath);
      if (!this.deviceOwnerId || journal.ownerId !== this.deviceOwnerId) {
        return;
      }
      const expectedHash = nodeCrypto().createHash("sha256").update(rawJournal).digest("hex");
      const retainedPath = await this.removeOwnedCleanupRevision(journalPath, expectedHash, true);
      if (retainedPath) {
        throw new Error(`Desktop replacement journal changed before removal and was retained: ${retainedPath}`);
      }
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") {
        throw error;
      }
    }
  }

  private async restoreRollbackNoClobber(rollbackPath: string, targetPath: string, expectedHash: string): Promise<boolean> {
    try {
      await nodeFs().promises.link(rollbackPath, targetPath);
    } catch (error) {
      if (getErrorCode(error) === "EEXIST") {
        return false;
      }
      throw error;
    }
    if (await this.getFileSha256IfPresent(targetPath) !== expectedHash) {
      return false;
    }
    // Keep the exact hard-linked rollback as a safety copy. Sync may replace
    // target immediately after readback, and unlinking here could drop the last
    // link to the recovered revision.
    return true;
  }

  private async recoverInterruptedReplacementUnlocked(): Promise<Set<string>> {
    const unresolvedTargets = new Set<string>();
    const journalDirectory = this.resolve(DESKTOP_REPLACEMENT_JOURNAL_DIR);
    const directoryStat = await this.lstatIfPresent(journalDirectory);
    if (!directoryStat) {
      return unresolvedTargets;
    }
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      console.error("[Local Image Compress] Desktop replacement recovery directory is unsafe:", journalDirectory);
      return unresolvedTargets;
    }
    const journalNames = (await nodeFs().promises.readdir(journalDirectory))
      .filter((name) => DESKTOP_REPLACEMENT_JOURNAL_PATTERN.test(name))
      .sort();
    for (const journalName of journalNames) {
      const journalPath = nodePath().join(journalDirectory, journalName);
      try {
        const unresolvedTarget = await this.recoverReplacementJournal(journalPath);
        if (unresolvedTarget) {
          unresolvedTargets.add(unresolvedTarget);
        }
      } catch (error) {
        console.error("[Local Image Compress] Desktop replacement journal retained after isolated recovery failure:", journalPath, error);
      }
    }
    return unresolvedTargets;
  }

  private async recoverReplacementJournal(journalPath: string, preserveStaged = false): Promise<string | null> {
    const journalStat = await this.lstatIfPresent(journalPath);
    if (!journalStat) {
      return null;
    }
    if (!journalStat.isFile() || journalStat.isSymbolicLink()) {
      return null;
    }
    const journal = this.parseReplacementJournal(await nodeFs().promises.readFile(journalPath, "utf8"), journalPath);
    if (!this.deviceOwnerId || journal.ownerId !== this.deviceOwnerId) {
      return null;
    }
    const stagedPath = this.resolve(journal.stagedPath);
    const targetPath = this.resolve(journal.targetPath);
    const rollbackPath = journal.rollbackPath ? this.resolve(journal.rollbackPath) : null;
    const stagedHash = await this.getFileSha256IfPresent(stagedPath);
    const targetHash = await this.getFileSha256IfPresent(targetPath);
    const rollbackHash = rollbackPath ? await this.getFileSha256IfPresent(rollbackPath) : null;
    if (targetHash === journal.stagedSha256) {
      if (!preserveStaged && stagedHash === journal.stagedSha256) {
        const retainedStagedPath = await this.removeOwnedCleanupRevision(stagedPath, stagedHash, true);
        if (retainedStagedPath) {
          console.warn("[Local Image Compress] Recovered desktop replacement retained its staged safety copy:", retainedStagedPath);
        }
      }
      if (rollbackPath && journal.rollbackSha256 !== null && rollbackHash === journal.rollbackSha256) {
        console.warn("[Local Image Compress] Recovered desktop replacement kept its exact rollback safety copy:", rollbackPath);
      }
      await this.removeReplacementJournal(journalPath);
      return null;
    }
    if (targetHash === null && rollbackPath && rollbackHash !== null
      && journal.expectedTargetSha256 !== null && rollbackHash === journal.expectedTargetSha256) {
      if (await this.restoreRollbackNoClobber(rollbackPath, targetPath, rollbackHash)) {
        if (!preserveStaged && stagedHash === journal.stagedSha256) {
          const retainedStagedPath = await this.removeOwnedCleanupRevision(stagedPath, stagedHash, true);
          if (retainedStagedPath) {
            console.warn("[Local Image Compress] Desktop replacement recovery retained its staged safety copy:", retainedStagedPath);
          }
        }
        console.warn("[Local Image Compress] Desktop replacement recovery restored target and kept the exact rollback safety copy:", rollbackPath);
        await this.removeReplacementJournal(journalPath);
        return null;
      }
    }
    if ((stagedHash !== null && stagedHash !== journal.stagedSha256)
      || (journal.rollbackSha256 !== null && rollbackHash !== null && rollbackHash !== journal.rollbackSha256)) {
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
        "[Local Image Compress] Retired stale desktop replacement journal and kept its terminal safety evidence:",
        rollbackPath || targetPath
      );
      try {
        await this.removeReplacementJournal(journalPath);
      } catch (error) {
        if (await this.lstatIfPresent(journalPath)) {
          throw error;
        }
        console.warn("[Local Image Compress] Stale desktop replacement journal was retained outside the active recovery namespace:", error);
      }
      return null;
    }
    if (journal.expectedTargetSha256 === null) {
      if (targetHash === null && rollbackHash === null && stagedHash === journal.stagedSha256) {
        if (!preserveStaged) {
          if (await this.removeOwnedCleanupRevision(stagedPath, stagedHash, true)) {
            return targetPath;
          }
        }
        await this.removeReplacementJournal(journalPath);
        return null;
      }
      return targetPath;
    }
    if (targetHash === journal.expectedTargetSha256 && rollbackHash === null) {
      if (!preserveStaged && stagedHash === journal.stagedSha256) {
        if (await this.removeOwnedCleanupRevision(stagedPath, stagedHash, true)) {
          return targetPath;
        }
      }
      await this.removeReplacementJournal(journalPath);
      return null;
    }
    if (targetHash === null && rollbackPath && rollbackHash !== null
      && journal.rollbackSha256 !== null && rollbackHash === journal.rollbackSha256) {
      if (await this.restoreRollbackNoClobber(rollbackPath, targetPath, rollbackHash)) {
        if (!preserveStaged && stagedHash === journal.stagedSha256) {
          if (await this.removeOwnedCleanupRevision(stagedPath, stagedHash, true)) {
            return targetPath;
          }
        }
        console.warn("[Local Image Compress] Desktop replacement recovery restored target and kept the exact rollback safety copy:", rollbackPath);
        await this.removeReplacementJournal(journalPath);
        return null;
      }
    }
    return targetPath;
  }

  async removeFileIfUnchanged(filePath: string, expectedSha256: string, bufferedOperationToken?: BufferedOperationToken): Promise<RemoveFileIfUnchangedResult> {
    void bufferedOperationToken;
    const sourcePath = this.resolve(filePath);
    return await runInDesktopReplacementQueue(async () => {
      await this.recoverInterruptedCleanupUnlocked();
      const sourceHash = await this.getFileSha256IfPresent(sourcePath);
      if (sourceHash === null || sourceHash !== expectedSha256) {
        return { removed: false, retainedConflictPath: null };
      }
      let journalPath: string | null = null;
      let quarantinePath: string | null = null;
      try {
        quarantinePath = await this.moveNativeFileToUniqueSibling(sourcePath, async (reservedQuarantinePath) => {
            const transactionId = this.getQuarantineTransactionId(reservedQuarantinePath);
            const journal: DesktopCleanupJournal = {
              version: 1,
              ownerId: this.deviceOwnerId || "",
              transactionId,
              sourcePath: this.toJournalRelativePath(sourcePath),
              quarantinePath: this.toJournalRelativePath(reservedQuarantinePath),
              expectedSha256: expectedSha256.toLowerCase()
            };
            journalPath = this.getCleanupJournalPath(journal);
            await this.writeCleanupJournal(journalPath, journal);
        });
      } catch (error) {
        if (journalPath) {
          await this.recoverCleanupJournal(journalPath).catch((recoveryError: unknown) => {
            console.error("[Local Image Compress] Desktop cleanup recovery after detach failure failed:", recoveryError);
          });
        }
        throw error;
      }
      if (!journalPath || !quarantinePath) {
        throw new Error(`Cleanup quarantine was created without a durable journal: ${sourcePath}`);
      }
      const isolatedHash = await this.getFileSha256IfPresent(quarantinePath);
      const retainedConflictPath = await this.recoverCleanupJournal(journalPath);
      return {
        removed: isolatedHash === expectedSha256 && retainedConflictPath === null,
        retainedConflictPath: retainedConflictPath ? this.toJournalRelativePath(retainedConflictPath) : null
      };
    });
  }

  private getQuarantineTransactionId(quarantinePath: string): string {
    const match = /^\.tinylocal-quarantine-\d+-([a-f0-9]{32})\.tmp$/i.exec(nodePath().basename(nodePath().dirname(quarantinePath)));
    if (!match?.[1]) {
      throw new Error(`Cleanup quarantine does not expose a transaction identity: ${quarantinePath}`);
    }
    return match[1].toLowerCase();
  }

  private getCleanupJournalPath(journal: DesktopCleanupJournal): string {
    return this.resolve(nodePath().join(
      DESKTOP_REPLACEMENT_JOURNAL_DIR,
      `desktop-cleanup-journal-v1-${journal.ownerId}-${journal.transactionId}.json`
    ));
  }

  private serializeCleanupJournal(journal: DesktopCleanupJournal): string {
    const stored: StoredDesktopCleanupJournal = {
      ...journal,
      checksum: nodeCrypto().createHash("sha256").update(JSON.stringify(journal)).digest("hex")
    };
    return JSON.stringify(stored);
  }

  private parseCleanupJournal(rawJournal: string, journalPath: string): DesktopCleanupJournal {
    const parsed: unknown = JSON.parse(rawJournal);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Invalid desktop cleanup journal: ${journalPath}`);
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
    const expectedChecksum = nodeCrypto().createHash("sha256").update(JSON.stringify(journal)).digest("hex");
    if (journal.version !== 1 || typeof checksum !== "string" || checksum.toLowerCase() !== expectedChecksum
      || typeof journal.ownerId !== "string" || !DESKTOP_ID_PATTERN.test(journal.ownerId)
      || typeof journal.transactionId !== "string" || !DESKTOP_ID_PATTERN.test(journal.transactionId)
      || typeof journal.expectedSha256 !== "string" || !/^[a-f0-9]{64}$/i.test(journal.expectedSha256)
      || typeof journal.sourcePath !== "string" || journal.sourcePath !== normalizeVaultPath(journal.sourcePath) || !isSafeVaultRelativePath(journal.sourcePath)
      || typeof journal.quarantinePath !== "string" || journal.quarantinePath !== normalizeVaultPath(journal.quarantinePath) || !isSafeVaultRelativePath(journal.quarantinePath)) {
      throw new Error(`Invalid desktop cleanup journal: ${journalPath}`);
    }
    const quarantineDirectory = nodePath().dirname(journal.quarantinePath);
    const quarantineParent = normalizeVaultPath(nodePath().dirname(quarantineDirectory));
    const sourceParent = normalizeVaultPath(nodePath().dirname(journal.sourcePath));
    if (quarantineParent !== sourceParent
      || vaultBasename(journal.quarantinePath) !== vaultBasename(journal.sourcePath)
      || this.getQuarantineTransactionId(journal.quarantinePath) !== journal.transactionId.toLowerCase()) {
      throw new Error(`Desktop cleanup journal does not own its quarantine: ${journalPath}`);
    }
    const normalized: DesktopCleanupJournal = {
      version: 1,
      ownerId: journal.ownerId.toLowerCase(),
      transactionId: journal.transactionId.toLowerCase(),
      sourcePath: journal.sourcePath,
      quarantinePath: journal.quarantinePath,
      expectedSha256: journal.expectedSha256.toLowerCase()
    };
    if (this.getCleanupJournalPath(normalized) !== journalPath) {
      throw new Error(`Desktop cleanup journal identity does not match its path: ${journalPath}`);
    }
    return normalized;
  }

  private async writeCleanupJournal(journalPath: string, journal: DesktopCleanupJournal): Promise<void> {
    if (!this.deviceOwnerId || journal.ownerId !== this.deviceOwnerId) {
      throw new Error("Device-local recovery identity is unavailable; refusing cleanup.");
    }
    await nodeFs().promises.mkdir(nodePath().dirname(journalPath), { recursive: true });
    if (!await this.writeExclusiveNative(journalPath, this.serializeCleanupJournal(journal))) {
      throw new Error(`Desktop cleanup journal already exists: ${journalPath}`);
    }
    await this.fsyncBestEffortNative(journalPath);
    this.parseCleanupJournal(await nodeFs().promises.readFile(journalPath, "utf8"), journalPath);
  }

  private async removeCleanupJournal(journalPath: string): Promise<void> {
    try {
      const rawJournal = await nodeFs().promises.readFile(journalPath, "utf8");
      const journal = this.parseCleanupJournal(rawJournal, journalPath);
      if (this.deviceOwnerId && journal.ownerId === this.deviceOwnerId) {
        const expectedHash = nodeCrypto().createHash("sha256").update(rawJournal).digest("hex");
        const retainedPath = await this.removeOwnedCleanupRevision(journalPath, expectedHash, true);
        if (retainedPath) {
          throw new Error(`Desktop cleanup journal changed before removal and was retained: ${retainedPath}`);
        }
      }
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") {
        throw error;
      }
    }
  }

  private async cleanupQuarantineDirectory(quarantinePath: string): Promise<void> {
    try {
      await nodeFs().promises.rmdir(nodePath().dirname(quarantinePath));
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT" && getErrorCode(error) !== "ENOTEMPTY") {
        console.warn("[Local Image Compress] Empty cleanup quarantine removal failed:", error);
      }
    }
  }

  private async recoverInterruptedCleanupUnlocked(): Promise<void> {
    const journalDirectory = this.resolve(DESKTOP_REPLACEMENT_JOURNAL_DIR);
    const directoryStat = await this.lstatIfPresent(journalDirectory);
    if (!directoryStat || !directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      return;
    }
    const journalNames = (await nodeFs().promises.readdir(journalDirectory))
      .filter((name) => DESKTOP_CLEANUP_JOURNAL_PATTERN.test(name))
      .sort();
    for (const journalName of journalNames) {
      const journalPath = nodePath().join(journalDirectory, journalName);
      try {
        const retainedPath = await this.recoverCleanupJournal(journalPath);
        if (retainedPath) {
          console.warn("[Local Image Compress] Ambiguous cleanup quarantine retained:", retainedPath);
        }
      } catch (error) {
        console.error("[Local Image Compress] Desktop cleanup journal retained after recovery failure:", journalPath, error);
      }
    }
  }

  private async recoverCleanupJournal(journalPath: string): Promise<string | null> {
    const journalStat = await this.lstatIfPresent(journalPath);
    if (!journalStat || !journalStat.isFile() || journalStat.isSymbolicLink()) {
      return null;
    }
    const journal = this.parseCleanupJournal(await nodeFs().promises.readFile(journalPath, "utf8"), journalPath);
    if (!this.deviceOwnerId || journal.ownerId !== this.deviceOwnerId) {
      return null;
    }
    const sourcePath = this.resolve(journal.sourcePath);
    const quarantinePath = this.resolve(journal.quarantinePath);
    const quarantineHash = await this.getFileSha256IfPresent(quarantinePath);
    if (quarantineHash === null) {
      await this.removeCleanupJournal(journalPath);
      return null;
    }
    if (quarantineHash === journal.expectedSha256) {
      const retainedPath = await this.removeOwnedCleanupRevision(quarantinePath, journal.expectedSha256);
      if (retainedPath) {
        return retainedPath;
      }
      await this.cleanupQuarantineDirectory(quarantinePath);
      await this.removeCleanupJournal(journalPath);
      return null;
    }
    if (await this.getFileSha256IfPresent(sourcePath) !== null) {
      return quarantinePath;
    }
    try {
      await nodeFs().promises.link(quarantinePath, sourcePath);
    } catch (error) {
      if (getErrorCode(error) === "EEXIST") {
        return quarantinePath;
      }
      throw error;
    }
    if (await this.getFileSha256IfPresent(sourcePath) !== quarantineHash) {
      return quarantinePath;
    }
    // Keep the durable second copy and journal. A Sync replacement can land
    // immediately after readback; unlinking quarantine would then lose bytes.
    return quarantinePath;
  }

  // Terminal step of every owned deletion. Must preserve the bytes: a
  // path-based unlink here could destroy a replacement that lands after the
  // final identity check. Obsidian's vault-local trash is the primary
  // mechanism because Electron's shell.trashItem is not reliable from the
  // renderer on every Windows setup ("Failed to create FileOperation
  // instance"), and a persistently failing trash poisons recovery journals.
  private async trashDetachedRevision(deletionPath: string): Promise<void> {
    if (this.trashLocal) {
      const relative = nodePath().relative(this.getBasePath(), deletionPath);
      if (relative && !relative.startsWith("..") && !nodePath().isAbsolute(relative)) {
        try {
          await this.trashLocal(relative.split(nodePath().sep).join("/"));
          return;
        } catch (error) {
          void error; // Fall back to the OS trash below.
        }
      }
    }
    await electronShell().trashItem(deletionPath);
  }

  private async removeOwnedCleanupRevision(filePath: string, expectedHash: string, discardVerifiedTransactionRevision = false): Promise<string | null> {
    const beforeIdentity = this.getRegularFileIdentity(await this.lstatIfPresent(filePath));
    if (!beforeIdentity || await this.getFileSha256IfPresent(filePath) !== expectedHash) {
      return filePath;
    }
    const afterIdentity = this.getRegularFileIdentity(await this.lstatIfPresent(filePath));
    if (!this.fileIdentitiesMatch(beforeIdentity, afterIdentity)) {
      return filePath;
    }
    const deletionPath = `${filePath}.delete-${nodeCrypto().randomBytes(16).toString("hex")}.tmp`;
    try {
      await nodeFs().promises.rename(filePath, deletionPath);
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        return filePath;
      }
      throw error;
    }
    const movedIdentity = this.getRegularFileIdentity(await this.lstatIfPresent(deletionPath));
    const movedHash = movedIdentity ? await this.getFileSha256IfPresent(deletionPath) : null;
    if (!this.fileIdentitiesMatch(beforeIdentity, movedIdentity) || movedHash !== expectedHash) {
      try {
        await nodeFs().promises.link(deletionPath, filePath);
      } catch (error) {
        if (getErrorCode(error) === "EEXIST") {
          return deletionPath;
        }
        throw error;
      }
      await this.trashDetachedRevision(deletionPath).catch(() => undefined);
      return filePath;
    }
    try {
      if (discardVerifiedTransactionRevision) {
        // Stage, rollback, and journal paths belong to the completed
        // transaction. Conflicts took the preserving branch above.
        await nodeFs().promises.unlink(deletionPath);
        return null;
      }
      // A path-based unlink cannot prove inode identity at its final syscall.
      // Trash preserves a Sync replacement that lands after the last check.
      await this.trashDetachedRevision(deletionPath);
      return null;
    } catch (error) {
      void error;
      // The owned revision is already detached under an unpredictable name.
      // Re-linking it to the journal path would make every recovery attempt
      // detach another hard link when the OS trash remains unavailable.
      return deletionPath;
    }
  }

  async removeFile(filePath: string): Promise<void> {
    await nodeFs().promises.unlink(this.resolve(filePath));
  }

  async removeDir(dirPath: string, options: { recursive: boolean; force: boolean; maxRetries?: number }): Promise<void> {
    const fs = nodeFs();
    if (!options.recursive) {
      // Non-recursive removal must fail on non-empty directories like rmdir;
      // fs.rm without recursive refuses directories outright.
      await fs.promises.rmdir(this.resolve(dirPath));
      return;
    }
    await fs.promises.rm(this.resolve(dirPath), options);
  }

  async listNames(dirPath: string): Promise<string[]> {
    return await nodeFs().promises.readdir(this.resolve(dirPath));
  }

  async listEntries(dirPath: string): Promise<FsDirEntry[]> {
    const entries = await nodeFs().promises.readdir(this.resolve(dirPath), { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isFile: entry.isFile(),
      isDirectory: entry.isDirectory(),
      isSymbolicLink: entry.isSymbolicLink()
    }));
  }

  async lstat(filePath: string): Promise<FsLstat> {
    const stats = await nodeFs().promises.lstat(this.resolve(filePath));
    return {
      isFile: stats.isFile(),
      isDirectory: stats.isDirectory(),
      isSymbolicLink: stats.isSymbolicLink(),
      size: stats.size
    };
  }

  async realpath(filePath: string): Promise<string> {
    const [realFilePath, realBasePath] = await Promise.all([
      nodeFs().promises.realpath(this.resolve(filePath)),
      nodeFs().promises.realpath(this.getBasePath())
    ]);
    const relativePath = normalizeVaultPath(toVaultRelativePath(realFilePath, realBasePath));
    if (!isSafeVaultRelativePath(relativePath)) {
      throw new Error(`Real path escapes the vault: ${filePath}`);
    }
    return relativePath;
  }

  async compareFileContents(leftPath: string, rightPath: string): Promise<boolean> {
    const fs = nodeFs();
    const chunkSize = 64 * 1024;
    let leftHandle: NodeFileHandle | null = null;
    let rightHandle: NodeFileHandle | null = null;
    try {
      [leftHandle, rightHandle] = await Promise.all([
        fs.promises.open(this.resolve(leftPath), "r"),
        fs.promises.open(this.resolve(rightPath), "r")
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
    } finally {
      const closeQuietly = async (handle: NodeFileHandle | null) => {
        try {
          await handle?.close();
        } catch (closeError) {
          void closeError;
        }
      };
      await Promise.all([closeQuietly(leftHandle), closeQuietly(rightHandle)]);
    }
  }

  async stat(filePath: string): Promise<FsStat | null> {
    try {
      const stats = await nodeFs().promises.stat(this.resolve(filePath));
      return { mtimeMs: stats.mtimeMs, size: stats.size, isDirectory: stats.isDirectory() };
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async writeExclusive(filePath: string, text: string): Promise<boolean> {
    return await this.writeExclusiveNative(this.resolve(filePath), text);
  }

  private async writeExclusiveNative(filePath: string, text: string): Promise<boolean> {
    const fs = nodeFs();
    let handle: NodeFileHandle | null = null;
    try {
      handle = await fs.promises.open(filePath, "wx");
      await handle.writeFile(text);
      await handle.close();
      return true;
    } catch (error) {
      try {
        await handle?.close();
      } catch (closeError) {
        void closeError;
      }
      if (getErrorCode(error) === "EEXIST") {
        return false;
      }
      throw error;
    }
  }

  async fsyncBestEffort(filePath: string): Promise<void> {
    await this.fsyncBestEffortNative(this.resolve(filePath));
  }

  private async fsyncBestEffortNative(filePath: string): Promise<void> {
    const fs = nodeFs();
    let handle: NodeFileHandle | null = null;
    try {
      handle = await fs.promises.open(filePath, "r+");
      await handle.sync();
    } catch (error) {
      // fsync is unsupported on some network/virtual filesystems; the atomic
      // rename still guarantees readers never observe a torn file.
      void error;
    } finally {
      try {
        await handle?.close();
      } catch (closeError) {
        void closeError;
      }
    }
  }

  async recoverInterruptedReplacement(): Promise<void> {
    await runInDesktopReplacementQueue(async () => {
      await this.recoverInterruptedCleanupUnlocked();
      await this.recoverInterruptedReplacementUnlocked();
    });
  }
}

class DesktopFsRestoreProbe implements FsRestoreProbe {
  constructor(private readonly resolvePath: (filePath: string) => string) {}

  async lstatIdentity(filePath: string) {
    const stats = await nodeFs().promises.lstat(this.resolvePath(filePath));
    return {
      isFile: stats.isFile(),
      isSymbolicLink: stats.isSymbolicLink(),
      dev: stats.dev,
      ino: stats.ino
    };
  }

  async realpath(filePath: string): Promise<string> {
    return await nodeFs().promises.realpath(this.resolvePath(filePath));
  }

  async copyViaHandle(
    sourcePath: string,
    targetPath: string,
    hooks: {
      afterOpen: () => Promise<() => Promise<void>>;
      afterStat: (identity: HandleIdentity) => Promise<void>;
    }
  ): Promise<void> {
    const fs = nodeFs();
    const { pipeline } = require("stream/promises") as typeof import("stream/promises");
    const handle = await fs.promises.open(this.resolvePath(sourcePath), "r");
    let release: (() => Promise<void>) | null = null;
    try {
      release = await hooks.afterOpen();
      const handleStat = await handle.stat();
      await hooks.afterStat({ isFile: handleStat.isFile(), dev: handleStat.dev, ino: handleStat.ino });
      await pipeline(handle.createReadStream({ start: 0 }), fs.createWriteStream(this.resolvePath(targetPath), { flags: "wx" }));
    } finally {
      try {
        await release?.();
      } finally {
        await handle.close();
      }
    }
  }
}

function createDesktopRuntimePort(fsPort: DesktopFsPort): RuntimePort {
  return {
    instanceId: process.pid,
    isCaseInsensitiveFs: process.platform === "win32" || process.platform === "darwin",
    maxBufferedFileBytes: null,
    revealPath: async (vaultRelativePath: string) => await openFilesystemPath(fsPort.resolvePath(vaultRelativePath))
  };
}

export function createDesktopPorts(app: obsidian.App): PlatformPorts {
  // Adapter is resolved at call time (like the base path) so re-pointed
  // adapters keep working; a missing trashLocal falls back to the OS trash.
  const fsPort = new DesktopFsPort(
    () => getVaultBasePath(app),
    async (vaultRelativePath) => await app.vault.adapter.trashLocal(vaultRelativePath)
  );
  return {
    fs: fsPort,
    hash: new DesktopHashPort((filePath) => fsPort.resolve(filePath)),
    runtime: createDesktopRuntimePort(fsPort)
  };
}

// Synchronous facet: kept in one contiguous block at the end of the file for
// the class-wide sync-fs gate exception scope. Callers are limited to the
// unload durability path and explicit recovery flows.
class DesktopFsSyncPort implements FsSyncPort {
  constructor(private readonly resolvePath: (filePath: string) => string) {}

  existsSync(filePath: string): boolean {
    return nodeFs().existsSync(this.resolvePath(filePath));
  }

  mkdirSync(dirPath: string): void {
    nodeFs().mkdirSync(this.resolvePath(dirPath), { recursive: true });
  }

  readTextSync(filePath: string): string {
    return nodeFs().readFileSync(this.resolvePath(filePath), "utf8");
  }

  writeTextSync(filePath: string, text: string): void {
    nodeFs().writeFileSync(this.resolvePath(filePath), text);
  }

  copyFileSync(sourcePath: string, targetPath: string, options?: { exclusive?: boolean }): void {
    const fs = nodeFs();
    fs.copyFileSync(this.resolvePath(sourcePath), this.resolvePath(targetPath), options?.exclusive ? fs.constants.COPYFILE_EXCL : 0);
  }

  replaceFileSync(stagedPath: string, targetPath: string): void {
    nodeFs().renameSync(this.resolvePath(stagedPath), this.resolvePath(targetPath));
  }

  removeFileSync(filePath: string): void {
    nodeFs().unlinkSync(this.resolvePath(filePath));
  }

  listNamesSync(dirPath: string): string[] {
    return nodeFs().readdirSync(this.resolvePath(dirPath));
  }

  listEntriesSync(dirPath: string): FsDirEntry[] {
    return nodeFs().readdirSync(this.resolvePath(dirPath), { withFileTypes: true })
      .map((entry) => ({
        name: entry.name,
        isFile: entry.isFile(),
        isDirectory: entry.isDirectory(),
        isSymbolicLink: entry.isSymbolicLink()
      }));
  }

  statSync(filePath: string): FsStat | null {
    try {
      const stats = nodeFs().statSync(this.resolvePath(filePath));
      return { mtimeMs: stats.mtimeMs, size: stats.size, isDirectory: stats.isDirectory() };
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  writeExclusiveSync(filePath: string, text: string): boolean {
    const fs = nodeFs();
    let fd: number | null = null;
    try {
      fd = fs.openSync(this.resolvePath(filePath), "wx");
      fs.writeFileSync(fd, text);
      fs.closeSync(fd);
      return true;
    } catch (error) {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch (closeError) {
          void closeError;
        }
      }
      if (getErrorCode(error) === "EEXIST") {
        return false;
      }
      throw error;
    }
  }

  fsyncBestEffortSync(filePath: string): void {
    const fs = nodeFs();
    let fd: number | null = null;
    try {
      fd = fs.openSync(this.resolvePath(filePath), "r+");
      fs.fsyncSync(fd);
    } catch (error) {
      void error;
    } finally {
      if (fd !== null) {
        try {
          fs.closeSync(fd);
        } catch (closeError) {
          void closeError;
        }
      }
    }
  }
}

// Cache lease synchronous facet. It intentionally lives beside the existing
// desktop sync port at EOF: callers are limited to unload durability and
// explicit recovery paths, while normal cache writes use the async facet.
class DesktopFsSyncLeasePort {
  constructor(
    private readonly resolvePath: (filePath: string) => string,
    private readonly deviceOwnerId: string | null
  ) {}

  private getOwnerPath(lockPath: string, leaseId: string): string {
    return `${lockPath}.owner-${leaseId}`;
  }

  private getScopedLockPath(lockPath: string): string {
    return `${lockPath}.device-${this.deviceOwnerId || "unavailable"}`;
  }

  private getReclaimMarkerPath(lockPath: string): string {
    return `${lockPath}.reclaiming`;
  }

  private getReclaimMarkerOwnerPath(lockPath: string, markerId: string): string {
    return `${this.getReclaimMarkerPath(lockPath)}.owner-${markerId}`;
  }

  private getReclaimRecoveryPath(lockPath: string): string {
    return `${this.getReclaimMarkerPath(lockPath)}.recovery`;
  }

  private getHeartbeatPath(ownerPath: string): string {
    return `${ownerPath}.heartbeat`;
  }

  private getReleasedPath(ownerPath: string): string {
    return `${ownerPath}.released`;
  }

  private getPayload(lockPath: string, ownerId: string, leaseId: string): DesktopCacheLeasePayload {
    return {
      version: 1,
      deviceOwnerId: this.deviceOwnerId || "",
      ownerId,
      leaseId,
      ownerPath: this.getOwnerPath(lockPath, leaseId),
      pid: process.pid,
      createdAt: Date.now()
    };
  }

  private parsePayload(rawData: string, lockPath: string): DesktopCacheLeasePayload | null {
    try {
      const value: unknown = JSON.parse(rawData);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
      }
      const record = value as Record<string, unknown>;
      const leaseId = typeof record["leaseId"] === "string" ? record["leaseId"] : "";
      const ownerId = typeof record["ownerId"] === "string" ? record["ownerId"] : "";
      const deviceOwnerId = typeof record["deviceOwnerId"] === "string" ? record["deviceOwnerId"] : "";
      const ownerPath = typeof record["ownerPath"] === "string" ? record["ownerPath"] : "";
      const expectedOwnerPath = this.getOwnerPath(lockPath, leaseId);
      const pid = Number(record["pid"]);
      const createdAt = Number(record["createdAt"]);
      if (record["version"] !== 1
        || !DESKTOP_CACHE_LEASE_ID_PATTERN.test(leaseId)
        || !ownerId || ownerId.length > 256
        || !DESKTOP_ID_PATTERN.test(deviceOwnerId)
        || nodePath().resolve(this.resolvePath(ownerPath)) !== nodePath().resolve(this.resolvePath(expectedOwnerPath))
        || !Number.isSafeInteger(pid) || pid <= 0
        || !Number.isFinite(createdAt) || createdAt <= 0) {
        return null;
      }
      return { version: 1, deviceOwnerId, ownerId, leaseId, ownerPath: expectedOwnerPath, pid, createdAt };
    } catch (error) {
      void error;
      return null;
    }
  }

  private parseReclaimMarkerPayload(rawData: string, lockPath: string): DesktopReclaimMarkerPayload | null {
    try {
      const value: unknown = JSON.parse(rawData);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
      }
      const record = value as Record<string, unknown>;
      const markerId = typeof record["markerId"] === "string" ? record["markerId"] : "";
      const deviceOwnerId = typeof record["deviceOwnerId"] === "string" ? record["deviceOwnerId"] : "";
      const ownerPath = typeof record["ownerPath"] === "string" ? record["ownerPath"] : "";
      const expectedOwnerPath = this.getReclaimMarkerOwnerPath(lockPath, markerId);
      const pid = Number(record["pid"]);
      const createdAt = Number(record["createdAt"]);
      if (record["version"] !== 1
        || !DESKTOP_CACHE_LEASE_ID_PATTERN.test(markerId)
        || !DESKTOP_ID_PATTERN.test(deviceOwnerId)
        || nodePath().resolve(this.resolvePath(ownerPath)) !== nodePath().resolve(this.resolvePath(expectedOwnerPath))
        || !Number.isSafeInteger(pid) || pid <= 0
        || !Number.isFinite(createdAt) || createdAt <= 0) {
        return null;
      }
      return { version: 1, deviceOwnerId, markerId, ownerPath: expectedOwnerPath, pid, createdAt };
    } catch (error) {
      void error;
      return null;
    }
  }

  private identitiesMatch(left: DesktopFileIdentity | null, right: DesktopFileIdentity | null): boolean {
    return !!left && !!right && left.dev === right.dev && left.ino === right.ino;
  }

  private getIdentitySync(filePath: string): DesktopFileIdentity | null {
    try {
      const stat = nodeFs().lstatSync(this.resolvePath(filePath));
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return null;
      }
      return { dev: stat.dev, ino: stat.ino };
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private readPayloadSync(lockPath: string): DesktopCacheLeasePayload | null {
    try {
      return this.parsePayload(nodeFs().readFileSync(this.resolvePath(lockPath), "utf8"), lockPath);
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private readReclaimMarkerPayloadSync(filePath: string, lockPath: string): DesktopReclaimMarkerPayload | null {
    try {
      return this.parseReclaimMarkerPayload(nodeFs().readFileSync(this.resolvePath(filePath), "utf8"), lockPath);
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  private removeIfPresentSync(filePath: string): void {
    try {
      nodeFs().unlinkSync(this.resolvePath(filePath));
    } catch (error) {
      if (getErrorCode(error) !== "ENOENT") {
        throw error;
      }
    }
  }

  private writeCompleteOwnerSync(ownerPath: string, payload: DesktopCacheLeasePayload): void {
    const fs = nodeFs();
    let fd: number | null = null;
    try {
      fd = fs.openSync(this.resolvePath(ownerPath), "wx");
      fs.writeFileSync(fd, JSON.stringify(payload));
      fs.fsyncSync(fd);
    } finally {
      if (fd !== null) {
        fs.closeSync(fd);
      }
    }
  }

  private detachMatchingFileSync(filePath: string, expectedIdentity: DesktopFileIdentity, purpose: string): string | null {
    if (!this.identitiesMatch(this.getIdentitySync(filePath), expectedIdentity)) {
      return null;
    }
    const detachedPath = `${filePath}.${purpose}-${nodeCrypto().randomBytes(16).toString("hex")}`;
    try {
      nodeFs().renameSync(this.resolvePath(filePath), this.resolvePath(detachedPath));
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        return null;
      }
      throw error;
    }
    if (this.identitiesMatch(this.getIdentitySync(detachedPath), expectedIdentity)) {
      return detachedPath;
    }
    this.restoreMovedObjectSync(detachedPath, filePath);
    return null;
  }

  private finishStaleReclaimMarkerRecoverySync(
    lockPath: string,
    payload: DesktopReclaimMarkerPayload,
    recoveryIdentity: DesktopFileIdentity
  ): boolean {
    const markerPath = this.getReclaimMarkerPath(lockPath);
    const markerIdentity = this.getIdentitySync(markerPath);
    if (!markerIdentity) {
      const detachedRecovery = this.detachMatchingFileSync(
        this.getReclaimRecoveryPath(lockPath),
        recoveryIdentity,
        "cleared"
      );
      if (!detachedRecovery) {
        return false;
      }
      this.removeIfPresentSync(detachedRecovery);
      this.removeIfPresentSync(payload.ownerPath);
      return true;
    }
    if (!this.identitiesMatch(markerIdentity, recoveryIdentity)) {
      return false;
    }
    const detachedMarker = this.detachMatchingFileSync(markerPath, recoveryIdentity, "stale");
    if (!detachedMarker) {
      return false;
    }
    this.removeIfPresentSync(detachedMarker);
    const detachedRecovery = this.detachMatchingFileSync(
      this.getReclaimRecoveryPath(lockPath),
      recoveryIdentity,
      "cleared"
    );
    if (!detachedRecovery) {
      return false;
    }
    this.removeIfPresentSync(detachedRecovery);
    this.removeIfPresentSync(payload.ownerPath);
    return true;
  }

  private recoverStaleReclaimMarkerSync(lockPath: string): boolean {
    const markerPath = this.getReclaimMarkerPath(lockPath);
    const recoveryPath = this.getReclaimRecoveryPath(lockPath);
    const recoveryPayload = this.readReclaimMarkerPayloadSync(recoveryPath, lockPath);
    if (recoveryPayload) {
      const recoveryIdentity = this.getIdentitySync(recoveryPath);
      const ownerIdentity = this.getIdentitySync(recoveryPayload.ownerPath);
      if (!this.deviceOwnerId
        || recoveryPayload.deviceOwnerId !== this.deviceOwnerId
        || !this.identitiesMatch(recoveryIdentity, ownerIdentity)
        || !recoveryIdentity
        || !this.isProcessProvablyDead(recoveryPayload.pid)) {
        return false;
      }
      return this.finishStaleReclaimMarkerRecoverySync(lockPath, recoveryPayload, recoveryIdentity);
    }
    if (this.getIdentitySync(recoveryPath)) {
      return false;
    }
    const markerPayload = this.readReclaimMarkerPayloadSync(markerPath, lockPath);
    if (!markerPayload
      || !this.deviceOwnerId
      || markerPayload.deviceOwnerId !== this.deviceOwnerId
      || !this.isProcessProvablyDead(markerPayload.pid)) {
      return false;
    }
    const markerIdentity = this.getIdentitySync(markerPath);
    const ownerIdentity = this.getIdentitySync(markerPayload.ownerPath);
    if (!markerIdentity || !this.identitiesMatch(markerIdentity, ownerIdentity)) {
      return false;
    }
    try {
      nodeFs().linkSync(this.resolvePath(markerPayload.ownerPath), this.resolvePath(recoveryPath));
    } catch (error) {
      if (getErrorCode(error) === "EEXIST") {
        return false;
      }
      throw error;
    }
    const currentMarkerIdentity = this.getIdentitySync(markerPath);
    const recoveryIdentity = this.getIdentitySync(recoveryPath);
    if (!recoveryIdentity
      || !this.identitiesMatch(currentMarkerIdentity, markerIdentity)
      || !this.identitiesMatch(recoveryIdentity, markerIdentity)) {
      if (recoveryIdentity && this.identitiesMatch(recoveryIdentity, markerIdentity)) {
        const detachedRecovery = this.detachMatchingFileSync(recoveryPath, recoveryIdentity, "aborted");
        if (detachedRecovery) {
          this.removeIfPresentSync(detachedRecovery);
        }
      }
      return false;
    }
    return this.finishStaleReclaimMarkerRecoverySync(lockPath, markerPayload, recoveryIdentity);
  }

  private acquireReclaimMarkerSync(lockPath: string): string | null {
    const fs = nodeFs();
    this.recoverStaleReclaimMarkerSync(lockPath);
    const markerPath = this.getReclaimMarkerPath(lockPath);
    const recoveryPath = this.getReclaimRecoveryPath(lockPath);
    if (this.getIdentitySync(recoveryPath)) {
      return null;
    }
    const markerId = nodeCrypto().randomBytes(16).toString("hex");
    const ownerPath = this.getReclaimMarkerOwnerPath(lockPath, markerId);
    const payload: DesktopReclaimMarkerPayload = {
      version: 1,
      deviceOwnerId: this.deviceOwnerId || "",
      markerId,
      ownerPath,
      pid: process.pid,
      createdAt: Date.now()
    };
    let fd: number | null = null;
    try {
      fd = fs.openSync(this.resolvePath(ownerPath), "wx");
      fs.writeFileSync(fd, JSON.stringify(payload));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      if (this.getIdentitySync(recoveryPath)) {
        this.removeIfPresentSync(ownerPath);
        return null;
      }
      fs.linkSync(this.resolvePath(ownerPath), this.resolvePath(markerPath));
      if (this.getIdentitySync(recoveryPath)) {
        this.releaseReclaimMarkerSync(lockPath, ownerPath);
        return null;
      }
      return ownerPath;
    } catch (error) {
      if (fd !== null) {
        fs.closeSync(fd);
      }
      this.removeIfPresentSync(ownerPath);
      if (getErrorCode(error) === "EEXIST") {
        return null;
      }
      throw error;
    }
  }

  private releaseReclaimMarkerSync(lockPath: string, ownerPath: string): void {
    const ownerIdentity = this.getIdentitySync(ownerPath);
    const markerPath = this.getReclaimMarkerPath(lockPath);
    if (ownerIdentity) {
      const detachedMarker = this.detachMatchingFileSync(markerPath, ownerIdentity, "released");
      if (detachedMarker) {
        this.removeIfPresentSync(detachedMarker);
      }
    }
    this.removeIfPresentSync(ownerPath);
  }

  private isProcessProvablyDead(pid: number): boolean {
    if (pid === process.pid) {
      return false;
    }
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return getErrorCode(error) === "ESRCH";
    }
  }

  private restoreMovedObjectSync(quarantinePath: string, lockPath: string): void {
    const fs = nodeFs();
    try {
      fs.linkSync(this.resolvePath(quarantinePath), this.resolvePath(lockPath));
      this.removeIfPresentSync(quarantinePath);
    } catch (error) {
      if (getErrorCode(error) !== "EEXIST") {
        throw error;
      }
    }
  }

  private reclaimProvablyReleasedOrDeadOwnerSyncUnlocked(lockPath: string): boolean {
    const payload = this.readPayloadSync(lockPath);
    if (!payload || !this.deviceOwnerId || payload.deviceOwnerId !== this.deviceOwnerId) {
      return false;
    }
    const lockIdentity = this.getIdentitySync(lockPath);
    const ownerIdentity = this.getIdentitySync(payload.ownerPath);
    if (!this.identitiesMatch(lockIdentity, ownerIdentity)) {
      return false;
    }
    const wasReleased = this.identitiesMatch(this.getIdentitySync(this.getReleasedPath(payload.ownerPath)), ownerIdentity);
    if (!wasReleased && !this.isProcessProvablyDead(payload.pid)) {
      return false;
    }
    const quarantinePath = `${lockPath}.reclaim-${nodeCrypto().randomBytes(16).toString("hex")}`;
    try {
      nodeFs().renameSync(this.resolvePath(lockPath), this.resolvePath(quarantinePath));
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        return true;
      }
      throw error;
    }
    if (!this.identitiesMatch(this.getIdentitySync(quarantinePath), ownerIdentity)) {
      this.restoreMovedObjectSync(quarantinePath, lockPath);
      return false;
    }
    this.removeIfPresentSync(quarantinePath);
    this.removeIfPresentSync(payload.ownerPath);
    this.removeIfPresentSync(this.getHeartbeatPath(payload.ownerPath));
    this.removeIfPresentSync(this.getReleasedPath(payload.ownerPath));
    return true;
  }

  private reclaimProvablyReleasedOrDeadOwnerSync(lockPath: string): boolean {
    const resolvedLockPath = this.resolvePath(lockPath);
    if (isDesktopCacheLeaseReclaimBusy(resolvedLockPath)) {
      return false;
    }
    const activeReclaims = getDesktopCacheLeaseActiveReclaims();
    activeReclaims.add(resolvedLockPath);
    const markerOwnerPath = this.acquireReclaimMarkerSync(lockPath);
    if (!markerOwnerPath) {
      activeReclaims.delete(resolvedLockPath);
      return false;
    }
    try {
      return this.reclaimProvablyReleasedOrDeadOwnerSyncUnlocked(lockPath);
    } finally {
      this.releaseReclaimMarkerSync(lockPath, markerOwnerPath);
      activeReclaims.delete(resolvedLockPath);
    }
  }

  acquireSync(lockPath: string, ownerId: string, timeoutMs: number, retryMs: number): FsLease | null {
    if (!this.deviceOwnerId) {
      return null;
    }
    lockPath = this.getScopedLockPath(lockPath);
    const fs = nodeFs();
    fs.mkdirSync(nodePath().dirname(this.resolvePath(lockPath)), { recursive: true });
    const resolvedLockPath = this.resolvePath(lockPath);
    const startedAt = Date.now();
    do {
      if (isDesktopCacheLeaseReclaimBusy(resolvedLockPath)) {
        if (Date.now() - startedAt >= timeoutMs) {
          break;
        }
        const end = Date.now() + retryMs;
        while (Date.now() < end) {
          // Rare sync-unload contention.
        }
        continue;
      }
      const leaseId = nodeCrypto().randomBytes(16).toString("hex");
      const ownerPath = this.getOwnerPath(lockPath, leaseId);
      const lease: FsLease = { lockPath, ownerPath, ownerId, leaseId };
      let ownerCreated = false;
      let claimed = false;
      try {
        this.writeCompleteOwnerSync(ownerPath, this.getPayload(lockPath, ownerId, leaseId));
        ownerCreated = true;
        fs.linkSync(this.resolvePath(ownerPath), this.resolvePath(lockPath));
        claimed = true;
        if (!this.renewSync(lease)) {
          this.releaseSync(lease);
          return null;
        }
        return lease;
      } catch (error) {
        if (claimed) {
          this.releaseSync(lease);
        } else if (ownerCreated) {
          this.removeIfPresentSync(ownerPath);
          this.removeIfPresentSync(this.getHeartbeatPath(ownerPath));
        }
        if (getErrorCode(error) !== "EEXIST") {
          throw error;
        }
      }
      if (this.reclaimProvablyReleasedOrDeadOwnerSync(lockPath)) {
        continue;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        break;
      }
      const end = Date.now() + retryMs;
      while (Date.now() < end) {
        // Rare sync-unload contention.
      }
    } while (Date.now() - startedAt <= timeoutMs);
    return null;
  }

  validateSync(lease: FsLease): boolean {
    return this.identitiesMatch(this.getIdentitySync(lease.lockPath), this.getIdentitySync(lease.ownerPath))
      && this.getIdentitySync(this.getReleasedPath(lease.ownerPath)) === null;
  }

  renewSync(lease: FsLease): boolean {
    if (!this.validateSync(lease)) {
      return false;
    }
    const heartbeatPath = this.getHeartbeatPath(lease.ownerPath);
    const stagedPath = `${heartbeatPath}.stage-${nodeCrypto().randomBytes(16).toString("hex")}`;
    try {
      nodeFs().writeFileSync(this.resolvePath(stagedPath), String(Date.now()), { flag: "wx" });
      this.removeIfPresentSync(heartbeatPath);
      nodeFs().renameSync(this.resolvePath(stagedPath), this.resolvePath(heartbeatPath));
      return this.validateSync(lease);
    } finally {
      this.removeIfPresentSync(stagedPath);
    }
  }

  releaseSync(lease: FsLease): boolean {
    const ownerIdentity = this.getIdentitySync(lease.ownerPath);
    if (!ownerIdentity) {
      return false;
    }
    const releasedPath = this.getReleasedPath(lease.ownerPath);
    try {
      nodeFs().linkSync(this.resolvePath(lease.ownerPath), this.resolvePath(releasedPath));
    } catch (error) {
      if (getErrorCode(error) !== "EEXIST") {
        throw error;
      }
    }
    if (!this.identitiesMatch(this.getIdentitySync(releasedPath), ownerIdentity)) {
      return false;
    }
    return this.identitiesMatch(this.getIdentitySync(lease.lockPath), ownerIdentity);
  }
}
