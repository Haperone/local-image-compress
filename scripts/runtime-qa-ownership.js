"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const RUNTIME_QA_OWNERSHIP_SCHEMA = "local-image-compress-runtime-qa-ownership/v1";
const SESSION_ID_PATTERN = /^[a-f0-9]{32}$/;
const QA_ROOT_PREFIX = "QA-LIC-Runtime-";
const OWNERSHIP_FILE_NAME = "ownership.json";
const OWNERSHIP_GENERATION_PATTERN = /^ownership\.(\d+)\.json$/;

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isInside(rootPath, targetPath, allowRoot = true) {
  const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath));
  return (allowRoot && relative === "") || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function getRuntimeQaOwnershipPaths(vaultRoot, pluginInstallDir, sessionId) {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error("Invalid desktop runtime QA ownership session id");
  }
  const resolvedVaultRoot = path.resolve(vaultRoot);
  const resolvedPluginInstallDir = path.resolve(pluginInstallDir);
  if (!isInside(resolvedVaultRoot, resolvedPluginInstallDir, false)) {
    throw new Error("Runtime QA plugin directory is outside the configured Vault");
  }
  const visibleRoot = path.join(resolvedVaultRoot, `${QA_ROOT_PREFIX}${sessionId}`);
  const stateRoot = path.join(resolvedPluginInstallDir, "qa-backups", "runtime", sessionId);
  return {
    vaultRoot: resolvedVaultRoot,
    pluginInstallDir: resolvedPluginInstallDir,
    visibleRoot,
    stateRoot,
    ledgerPath: path.join(stateRoot, OWNERSHIP_FILE_NAME)
  };
}

function getPayload(envelope, expectedPaths, expectedSessionId) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("Runtime QA ownership envelope must be an object");
  }
  const payload = envelope.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || envelope.sha256 !== sha256(JSON.stringify(payload))
    || payload.schema !== RUNTIME_QA_OWNERSHIP_SCHEMA
    || payload.sessionId !== expectedSessionId
    || !Number.isSafeInteger(payload.revision) || payload.revision < 1
    || path.resolve(payload.vaultRoot || "") !== expectedPaths.vaultRoot
    || path.resolve(payload.pluginInstallDir || "") !== expectedPaths.pluginInstallDir
    || path.resolve(payload.visibleRoot || "") !== expectedPaths.visibleRoot
    || path.resolve(payload.stateRoot || "") !== expectedPaths.stateRoot
    || !Array.isArray(payload.files)
    || !Array.isArray(payload.directories)) {
    throw new Error("Runtime QA ownership envelope is invalid or does not match its exact roots");
  }
  return payload;
}

function validateOwnedPath(paths, targetPath, label) {
  const resolved = path.resolve(targetPath);
  if (!isInside(paths.visibleRoot, resolved) && !isInside(paths.stateRoot, resolved)) {
    throw new Error(`${label} is outside the exact runtime QA roots: ${targetPath}`);
  }
  return resolved;
}

function readOwnershipEnvelope(paths, sessionId) {
  if (!fs.existsSync(paths.stateRoot)) {
    return null;
  }
  const pendingPattern = new RegExp(`^ownership\\.pending-(\\d+)-${sessionId}\\.tmp$`);
  const cleanupSuffix = `.delete-${sessionId}.tmp`;
  const candidates = [];
  for (const entry of fs.readdirSync(paths.stateRoot, { withFileTypes: true })) {
    let logicalName = entry.name;
    while (logicalName.endsWith(cleanupSuffix)) {
      logicalName = logicalName.slice(0, -cleanupSuffix.length);
    }
    const generationMatch = OWNERSHIP_GENERATION_PATTERN.exec(logicalName);
    const pendingMatch = pendingPattern.exec(logicalName);
    const expectedRevision = logicalName === OWNERSHIP_FILE_NAME
      ? 1
      : generationMatch
        ? Number(generationMatch[1])
        : pendingMatch
          ? Number(pendingMatch[1])
          : null;
    if (expectedRevision === null) {
      continue;
    }
    const candidatePath = path.join(paths.stateRoot, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Runtime QA ownership generation is not a real file: ${candidatePath}`);
    }
    const raw = fs.readFileSync(candidatePath, "utf8");
    const payload = getPayload(JSON.parse(raw), paths, sessionId);
    if (payload.revision !== expectedRevision) {
      throw new Error(`Runtime QA ownership generation revision does not match its exact file: ${candidatePath}`);
    }
    candidates.push({ path: candidatePath, logicalPath: path.join(paths.stateRoot, logicalName), raw, payload, isPending: !!pendingMatch });
  }
  if (candidates.length === 0) {
    return null;
  }
  const logicalControlPaths = new Set();
  const controlRevisions = new Set();
  for (const candidate of candidates) {
    if (logicalControlPaths.has(candidate.logicalPath)) {
      throw new Error(`Runtime QA ownership generation has multiple physical representations: ${candidate.logicalPath}`);
    }
    logicalControlPaths.add(candidate.logicalPath);
    if (controlRevisions.has(candidate.payload.revision)) {
      throw new Error(`Runtime QA ownership generation has multiple physical files for revision ${candidate.payload.revision}`);
    }
    controlRevisions.add(candidate.payload.revision);
  }
  candidates.sort((left, right) => right.payload.revision - left.payload.revision);
  const latest = candidates[0];
  const authority = latest;
  const cleanupOrder = candidates
    .filter((candidate) => candidate !== authority)
    .sort((left, right) => left.payload.revision - right.payload.revision);
  cleanupOrder.push(authority);
  return {
    payload: latest.payload,
    controlFiles: new Map(cleanupOrder.map((candidate) => [candidate.path, sha256(candidate.raw)]))
  };
}

function getDetachedOwnedPath(filePath, sessionId) {
  const cleanupSuffix = `.delete-${sessionId}.tmp`;
  let logicalPath = filePath;
  while (logicalPath.endsWith(cleanupSuffix)) {
    logicalPath = logicalPath.slice(0, -cleanupSuffix.length);
  }
  return logicalPath === filePath ? null : logicalPath;
}

function isOwnershipControlPath(paths, sessionId, targetPath) {
  if (path.dirname(targetPath) !== paths.stateRoot) {
    return false;
  }
  const fileName = path.basename(targetPath);
  return fileName === OWNERSHIP_FILE_NAME
    || OWNERSHIP_GENERATION_PATTERN.test(fileName)
    || new RegExp(`^ownership\\.pending-\\d+-${sessionId}\\.tmp$`).test(fileName);
}

function walkTree(rootPath, directories, files) {
  if (!fs.existsSync(rootPath)) {
    return;
  }
  const rootStat = fs.lstatSync(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Runtime QA root is not a real directory: ${rootPath}`);
  }
  directories.add(path.resolve(rootPath));
  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Runtime QA cleanup found an unowned symbolic link: ${entryPath}`);
    }
    if (entry.isDirectory()) {
      walkTree(entryPath, directories, files);
    } else if (entry.isFile()) {
      files.add(path.resolve(entryPath));
    } else {
      throw new Error(`Runtime QA cleanup found an unsupported entry: ${entryPath}`);
    }
  }
}

function removeFileIfUnchangedSync(filePath, expectedSha256, sessionId, expectedFileSystemIdentity = null) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const stat = fs.lstatSync(filePath, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()
    || expectedFileSystemIdentity && (stat.dev.toString() !== expectedFileSystemIdentity.device || stat.ino.toString() !== expectedFileSystemIdentity.inode)
    || sha256(fs.readFileSync(filePath)) !== expectedSha256) {
    throw new Error(`Owned runtime QA file changed before cleanup: ${filePath}`);
  }
  const detachedPath = `${filePath}.delete-${sessionId}.tmp`;
  if (fs.existsSync(detachedPath)) {
    throw new Error(`Runtime QA conditional cleanup path already exists: ${detachedPath}`);
  }
  fs.renameSync(filePath, detachedPath);
  const detachedStat = fs.lstatSync(detachedPath, { bigint: true });
  if (expectedFileSystemIdentity && (detachedStat.dev.toString() !== expectedFileSystemIdentity.device || detachedStat.ino.toString() !== expectedFileSystemIdentity.inode)
    || sha256(fs.readFileSync(detachedPath)) !== expectedSha256) {
    if (!fs.existsSync(filePath)) {
      fs.renameSync(detachedPath, filePath);
    }
    throw new Error(`Owned runtime QA file changed during cleanup: ${filePath}`);
  }
  fs.unlinkSync(detachedPath);
}

function getMovedOutputPath(paths, sessionId, sourcePath) {
  if (!isInside(paths.visibleRoot, sourcePath, false)) {
    return null;
  }
  const relativeSource = path.relative(paths.visibleRoot, sourcePath);
  if (!relativeSource || relativeSource.split(path.sep)[0] === "Compressed") {
    return null;
  }
  return path.join(paths.visibleRoot, "Compressed", `${QA_ROOT_PREFIX}${sessionId}`, relativeSource);
}

function cleanupRuntimeQaOwnershipLedger({ vaultRoot, pluginInstallDir, sessionId }) {
  const paths = getRuntimeQaOwnershipPaths(vaultRoot, pluginInstallDir, sessionId);
  const ownershipEnvelope = readOwnershipEnvelope(paths, sessionId);
  if (!ownershipEnvelope) {
    return false;
  }
  const { payload, controlFiles } = ownershipEnvelope;
  const ownedFiles = new Map();
  const ownedFileSystemIdentities = new Map();
  for (const entry of payload.files) {
    const hasFileSystemIdentity = entry?.device !== undefined || entry?.inode !== undefined;
    if (!entry || typeof entry.path !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256 || "")
      || hasFileSystemIdentity && (!/^\d+$/.test(entry.device || "") || !/^\d+$/.test(entry.inode || ""))) {
      throw new Error("Runtime QA ownership ledger contains an invalid file identity");
    }
    const ownedPath = validateOwnedPath(paths, entry.path, "Owned runtime QA file");
    if (isOwnershipControlPath(paths, sessionId, ownedPath) || ownedFiles.has(ownedPath)) {
      throw new Error(`Runtime QA ownership ledger contains a duplicate or self-owned file: ${ownedPath}`);
    }
    ownedFiles.set(ownedPath, entry.sha256);
    if (hasFileSystemIdentity) {
      ownedFileSystemIdentities.set(ownedPath, { device: entry.device, inode: entry.inode });
    }
  }
  const ownedDirectories = new Set(payload.directories.map((directoryPath) => validateOwnedPath(paths, directoryPath, "Owned runtime QA directory")));
  if (!ownedDirectories.has(paths.stateRoot)) {
    throw new Error("Runtime QA ownership ledger does not own its exact state root");
  }

  const actualDirectories = new Set();
  const actualFiles = new Set();
  const filesToRemove = new Map();
  const seenOwnedLogicalPaths = new Set();
  walkTree(paths.visibleRoot, actualDirectories, actualFiles);
  walkTree(paths.stateRoot, actualDirectories, actualFiles);
  for (const directoryPath of actualDirectories) {
    if (!ownedDirectories.has(directoryPath)) {
      throw new Error(`Runtime QA cleanup retained an unknown directory: ${directoryPath}`);
    }
  }
  for (const filePath of actualFiles) {
    if (controlFiles.has(filePath)) {
      continue;
    }
    let ownedPath = filePath;
    let expectedSha256 = ownedFiles.get(ownedPath);
    if (!expectedSha256) {
      const detachedOwnedPath = getDetachedOwnedPath(filePath, sessionId);
      if (!detachedOwnedPath || fs.existsSync(detachedOwnedPath) || !ownedFiles.has(detachedOwnedPath)) {
        throw new Error(`Runtime QA cleanup retained an unknown file: ${filePath}`);
      }
      ownedPath = detachedOwnedPath;
      expectedSha256 = ownedFiles.get(ownedPath);
    }
    if (seenOwnedLogicalPaths.has(ownedPath)) {
      throw new Error(`Runtime QA cleanup retained multiple physical representations of an owned file: ${ownedPath}`);
    }
    seenOwnedLogicalPaths.add(ownedPath);
    const actualSha256 = sha256(fs.readFileSync(filePath));
    const expectedFileSystemIdentity = ownedFileSystemIdentities.get(ownedPath);
    if (expectedFileSystemIdentity) {
      const stat = fs.lstatSync(filePath, { bigint: true });
      if (stat.dev.toString() !== expectedFileSystemIdentity.device || stat.ino.toString() !== expectedFileSystemIdentity.inode) {
        throw new Error(`Runtime QA cleanup retained a replaced owned file: ${filePath}`);
      }
    }
    if (actualSha256 !== expectedSha256) {
      const movedOutputPath = filePath === ownedPath ? getMovedOutputPath(paths, sessionId, ownedPath) : null;
      const movedOutputSha256 = movedOutputPath ? ownedFiles.get(movedOutputPath) : null;
      if (!movedOutputPath || fs.existsSync(movedOutputPath) || actualSha256 !== movedOutputSha256) {
        throw new Error(`Runtime QA cleanup retained a changed owned file: ${filePath}`);
      }
      expectedSha256 = actualSha256;
    }
    filesToRemove.set(filePath, { expectedSha256, expectedFileSystemIdentity });
  }

  for (const [filePath, identity] of filesToRemove) {
    removeFileIfUnchangedSync(filePath, identity.expectedSha256, sessionId, identity.expectedFileSystemIdentity || null);
  }
  for (const [controlPath, expectedSha256] of controlFiles) {
    removeFileIfUnchangedSync(controlPath, expectedSha256, sessionId);
  }
  for (const directoryPath of [...ownedDirectories].sort((left, right) => right.length - left.length)) {
    if (fs.existsSync(directoryPath)) {
      fs.rmdirSync(directoryPath);
    }
  }
  return true;
}

function cleanupRuntimeQaOwnershipLedgers({ vaultRoot, pluginInstallDir, onWarning = () => {} }) {
  const runtimeRoot = path.join(path.resolve(pluginInstallDir), "qa-backups", "runtime");
  const cleaned = [];
  if (fs.existsSync(runtimeRoot)) {
    for (const entry of fs.readdirSync(runtimeRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SESSION_ID_PATTERN.test(entry.name)) {
        continue;
      }
      try {
        if (cleanupRuntimeQaOwnershipLedger({ vaultRoot, pluginInstallDir, sessionId: entry.name })) {
          cleaned.push(entry.name);
        }
      } catch (error) {
        onWarning(entry.name, error);
      }
    }
  }
  for (const directoryPath of [runtimeRoot, path.dirname(runtimeRoot)]) {
    try {
      fs.rmdirSync(directoryPath);
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error?.code)) {
        throw error;
      }
    }
  }
  return cleaned;
}

class RuntimeQaOwnershipLedger {
  constructor({ vaultRoot, pluginInstallDir, sessionId }) {
    this.sessionId = sessionId;
    this.paths = getRuntimeQaOwnershipPaths(vaultRoot, pluginInstallDir, sessionId);
    this.payload = {
      schema: RUNTIME_QA_OWNERSHIP_SCHEMA,
      sessionId,
      revision: 0,
      vaultRoot: this.paths.vaultRoot,
      pluginInstallDir: this.paths.pluginInstallDir,
      visibleRoot: this.paths.visibleRoot,
      stateRoot: this.paths.stateRoot,
      files: [],
      directories: []
    };
  }

  initialize() {
    if (fs.existsSync(this.paths.stateRoot) || fs.existsSync(this.paths.visibleRoot)) {
      throw new Error("Refusing to adopt an existing runtime QA root");
    }
    fs.mkdirSync(path.dirname(this.paths.stateRoot), { recursive: true });
    fs.mkdirSync(this.paths.stateRoot, { recursive: false });
    this.recordDirectorySync(this.paths.stateRoot);
  }

  persist() {
    this.payload.revision += 1;
    const serializedPayload = JSON.stringify(this.payload);
    const serialized = `${JSON.stringify({ payload: this.payload, sha256: sha256(serializedPayload) }, null, 2)}\n`;
    const finalPath = this.payload.revision === 1
      ? this.paths.ledgerPath
      : path.join(this.paths.stateRoot, `ownership.${this.payload.revision}.json`);
    const temporaryPath = path.join(this.paths.stateRoot, `ownership.pending-${this.payload.revision}-${this.sessionId}.tmp`);
    fs.writeFileSync(temporaryPath, serialized, { flag: "wx" });
    if (fs.existsSync(finalPath)) {
      throw new Error(`Runtime QA ownership generation already exists: ${finalPath}`);
    }
    fs.renameSync(temporaryPath, finalPath);
  }

  recordDirectorySync(directoryPath) {
    const resolved = validateOwnedPath(this.paths, directoryPath, "Runtime QA directory");
    const boundary = isInside(this.paths.visibleRoot, resolved) ? this.paths.visibleRoot : this.paths.stateRoot;
    let current = resolved;
    while (isInside(boundary, current)) {
      if (!this.payload.directories.includes(current)) {
        this.payload.directories.push(current);
      }
      if (current === boundary) {
        break;
      }
      current = path.dirname(current);
    }
    this.payload.directories.sort();
    this.persist();
  }

  recordFileSync(filePath) {
    const resolved = validateOwnedPath(this.paths, filePath, "Runtime QA file");
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Runtime QA cannot own a non-file: ${resolved}`);
    }
    this.recordFileWithExpectedSha256Sync(resolved, sha256(fs.readFileSync(resolved)));
  }

  recordFileWithExpectedSha256Sync(filePath, expectedSha256, fileSystemIdentity = null) {
    const resolved = validateOwnedPath(this.paths, filePath, "Runtime QA file");
    const stat = fs.lstatSync(resolved, { bigint: true });
    if (!/^[a-f0-9]{64}$/.test(expectedSha256) || !stat.isFile() || stat.isSymbolicLink()
      || fileSystemIdentity && (stat.dev.toString() !== fileSystemIdentity.device || stat.ino.toString() !== fileSystemIdentity.inode)
      || sha256(fs.readFileSync(resolved)) !== expectedSha256) {
      throw new Error(`Runtime QA cannot prove the expected file identity: ${resolved}`);
    }
    this.commitFileEntriesSync([{
      path: resolved,
      sha256: expectedSha256,
      ...(fileSystemIdentity ? { device: fileSystemIdentity.device, inode: fileSystemIdentity.inode } : {})
    }]);
  }

  commitFileEntriesSync(entries) {
    for (const identity of entries) {
      const stat = fs.lstatSync(identity.path, { bigint: true });
      if (!stat.isFile() || stat.isSymbolicLink()
        || identity.device !== undefined && (stat.dev.toString() !== identity.device || stat.ino.toString() !== identity.inode)
        || sha256(fs.readFileSync(identity.path)) !== identity.sha256) {
        throw new Error(`Runtime QA file identity changed before ownership commit: ${identity.path}`);
      }
    }
    for (const identity of entries) {
      let directoryPath = path.dirname(identity.path);
      const boundary = isInside(this.paths.visibleRoot, identity.path) ? this.paths.visibleRoot : this.paths.stateRoot;
      while (isInside(boundary, directoryPath)) {
        if (!this.payload.directories.includes(directoryPath)) {
          this.payload.directories.push(directoryPath);
        }
        if (directoryPath === boundary) {
          break;
        }
        directoryPath = path.dirname(directoryPath);
      }
      const existingIndex = this.payload.files.findIndex((entry) => entry.path === identity.path);
      if (existingIndex >= 0) {
        this.payload.files[existingIndex] = identity;
      } else {
        this.payload.files.push(identity);
      }
    }
    this.payload.files.sort((left, right) => left.path.localeCompare(right.path));
    this.payload.directories.sort();
    this.persist();
  }

  recordCacheLeaseArtifactsSync(cacheFilePath) {
    const resolvedCacheFile = validateOwnedPath(this.paths, cacheFilePath, "Runtime QA cache file");
    if (!isInside(this.paths.stateRoot, resolvedCacheFile, false)) {
      throw new Error("Runtime QA cache lease artifacts must stay inside the exact state root");
    }
    const cacheDirectory = path.dirname(resolvedCacheFile);
    const cacheFileName = path.basename(resolvedCacheFile);
    const lockPattern = new RegExp(`^${escapeRegExp(cacheFileName)}\\.lock\\.device-([a-f0-9]{32})$`);
    const directoryEntries = fs.readdirSync(cacheDirectory, { withFileTypes: true });
    const lockEntries = directoryEntries.filter((entry) => entry.name.startsWith(`${cacheFileName}.lock`));
    const ownedLeasePaths = new Set();
    const leaseGroups = [];
    for (const lockEntry of lockEntries) {
      const match = lockPattern.exec(lockEntry.name);
      if (!match) {
        continue;
      }
      const deviceOwnerId = match[1];
      const lockPath = path.join(cacheDirectory, lockEntry.name);
      const rawPayload = fs.readFileSync(lockPath, "utf8");
      const payload = JSON.parse(rawPayload);
      const leaseId = typeof payload?.leaseId === "string" ? payload.leaseId : "";
      const ownerPath = `${lockPath}.owner-${leaseId}`;
      const heartbeatPath = `${ownerPath}.heartbeat`;
      const releasedPath = `${ownerPath}.released`;
      const expectedOwnerPath = path.relative(this.paths.vaultRoot, ownerPath).split(path.sep).join("/");
      if (!lockEntry.isFile() || lockEntry.isSymbolicLink()
        || payload?.version !== 1
        || payload?.deviceOwnerId !== deviceOwnerId
        || !/^[a-f0-9]{32}$/.test(leaseId)
        || typeof payload?.ownerId !== "string" || !payload.ownerId || payload.ownerId.length > 256
        || !Number.isSafeInteger(payload?.pid) || payload.pid <= 0
        || !Number.isSafeInteger(payload?.createdAt) || payload.createdAt <= 0
        || payload?.ownerPath !== expectedOwnerPath
        || !fs.existsSync(ownerPath)
        || !fs.existsSync(releasedPath)
        || !fs.existsSync(heartbeatPath)) {
        throw new Error(`Runtime QA cache lease artifact identity is invalid: ${lockPath}`);
      }
      const linkedPaths = [lockPath, ownerPath, releasedPath];
      const linkedStats = linkedPaths.map((leasePath) => fs.lstatSync(leasePath, { bigint: true }));
      const heartbeatStat = fs.lstatSync(heartbeatPath, { bigint: true });
      if (linkedStats.some((stat) => !stat.isFile() || stat.isSymbolicLink())
        || !heartbeatStat.isFile() || heartbeatStat.isSymbolicLink()
        || linkedStats.some((stat) => stat.dev !== linkedStats[0].dev || stat.ino !== linkedStats[0].ino)
        || linkedStats[0].nlink < 3n
        || fs.readFileSync(ownerPath, "utf8") !== rawPayload
        || fs.readFileSync(releasedPath, "utf8") !== rawPayload
        || !/^\d+$/.test(fs.readFileSync(heartbeatPath, "utf8"))) {
        throw new Error(`Runtime QA cache lease artifact identity is invalid: ${lockPath}`);
      }
      for (const leasePath of [...linkedPaths, heartbeatPath]) {
        ownedLeasePaths.add(leasePath);
      }
      leaseGroups.push(linkedPaths);
    }
    if (lockEntries.some((entry) => !ownedLeasePaths.has(path.join(cacheDirectory, entry.name)))) {
      throw new Error("Runtime QA cache directory contains an unrecognized lease artifact");
    }
    const identities = [...ownedLeasePaths].map((leasePath) => {
      const stat = fs.lstatSync(leasePath, { bigint: true });
      return {
        path: leasePath,
        sha256: sha256(fs.readFileSync(leasePath)),
        device: stat.dev.toString(),
        inode: stat.ino.toString()
      };
    });
    for (const linkedPaths of leaseGroups) {
      const capturedLinkedIdentities = linkedPaths.map((linkedPath) => identities.find((identity) => identity.path === linkedPath));
      if (capturedLinkedIdentities.some((identity) => !identity)
        || capturedLinkedIdentities.some((identity) => identity.device !== capturedLinkedIdentities[0].device || identity.inode !== capturedLinkedIdentities[0].inode)) {
        throw new Error("Runtime QA cache lease hard-link family changed before ownership commit");
      }
    }
    this.commitFileEntriesSync(identities);
  }

  cleanup() {
    return cleanupRuntimeQaOwnershipLedger({
      vaultRoot: this.paths.vaultRoot,
      pluginInstallDir: this.paths.pluginInstallDir,
      sessionId: this.sessionId
    });
  }
}

module.exports = {
  OWNERSHIP_FILE_NAME,
  QA_ROOT_PREFIX,
  RUNTIME_QA_OWNERSHIP_SCHEMA,
  RuntimeQaOwnershipLedger,
  cleanupRuntimeQaOwnershipLedger,
  cleanupRuntimeQaOwnershipLedgers,
  getRuntimeQaOwnershipPaths
};
