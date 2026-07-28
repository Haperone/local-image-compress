"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  RuntimeQaOwnershipLedger,
  cleanupRuntimeQaOwnershipLedger,
  cleanupRuntimeQaOwnershipLedgers
} = require("./runtime-qa-ownership");

function createHarness(sessionId) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-runtime-qa-ownership-"));
  const vaultRoot = path.join(temporaryRoot, "Vault");
  const pluginInstallDir = path.join(vaultRoot, ".obsidian", "plugins", "local-image-compress");
  fs.mkdirSync(pluginInstallDir, { recursive: true });
  const ledger = new RuntimeQaOwnershipLedger({ vaultRoot, pluginInstallDir, sessionId });
  ledger.initialize();
  fs.mkdirSync(ledger.paths.visibleRoot);
  ledger.recordDirectorySync(ledger.paths.visibleRoot);
  return { temporaryRoot, vaultRoot, pluginInstallDir, ledger };
}

function writeOwnedFile(ledger, relativePath, content) {
  const filePath = path.join(ledger.paths.visibleRoot, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  ledger.recordDirectorySync(path.dirname(filePath));
  fs.writeFileSync(filePath, content);
  ledger.recordFileSync(filePath);
  return filePath;
}

function writeReleasedCacheLease(ledger, overrides = {}) {
  const cacheFilePath = path.join(ledger.paths.stateRoot, "cache", "tinyLocal-cache.json");
  fs.mkdirSync(path.dirname(cacheFilePath), { recursive: true });
  fs.writeFileSync(cacheFilePath, "{}");
  ledger.recordFileSync(cacheFilePath);
  const deviceOwnerId = "a".repeat(32);
  const leaseId = "b".repeat(32);
  const lockPath = `${cacheFilePath}.lock.device-${deviceOwnerId}`;
  const ownerPath = `${lockPath}.owner-${leaseId}`;
  const payload = {
    version: 1,
    deviceOwnerId,
    ownerId: "qa-owner",
    leaseId,
    ownerPath: path.relative(ledger.paths.vaultRoot, ownerPath).split(path.sep).join("/"),
    pid: 123,
    createdAt: 456,
    ...overrides
  };
  const rawPayload = JSON.stringify(payload);
  fs.writeFileSync(ownerPath, rawPayload);
  fs.linkSync(ownerPath, lockPath);
  fs.linkSync(ownerPath, `${ownerPath}.released`);
  fs.writeFileSync(`${ownerPath}.heartbeat`, "456");
  return { cacheFilePath, lockPath };
}

function stageGenerationCrash(harness, mode) {
  harness.ledger.recordDirectorySync(path.join(harness.ledger.paths.visibleRoot, "planned", "output"));
  const oldPath = path.join(harness.ledger.paths.stateRoot, "ownership.2.json");
  const newPath = path.join(harness.ledger.paths.stateRoot, "ownership.3.json");
  const oldRaw = fs.readFileSync(oldPath, "utf8");
  const newRaw = fs.readFileSync(newPath, "utf8");
  for (const entry of fs.readdirSync(harness.ledger.paths.stateRoot)) {
    if (entry.startsWith("ownership")) {
      fs.unlinkSync(path.join(harness.ledger.paths.stateRoot, entry));
    }
  }
  const pendingPath = path.join(
    harness.ledger.paths.stateRoot,
    `ownership.pending-3-${harness.ledger.sessionId}.tmp`
  );
  if (mode !== "pending-only") {
    fs.writeFileSync(oldPath, oldRaw);
  }
  if (mode === "after-rename") {
    fs.writeFileSync(newPath, newRaw);
  } else {
    fs.writeFileSync(pendingPath, newRaw);
  }
}

function main() {
  const directoryHarness = createHarness("0".repeat(32));
  try {
    const nestedDirectory = path.join(directoryHarness.ledger.paths.visibleRoot, "Compressed", "nested", "output");
    directoryHarness.ledger.recordDirectorySync(nestedDirectory);
    for (const expectedDirectory of [
      directoryHarness.ledger.paths.visibleRoot,
      path.join(directoryHarness.ledger.paths.visibleRoot, "Compressed"),
      path.join(directoryHarness.ledger.paths.visibleRoot, "Compressed", "nested"),
      nestedDirectory
    ]) {
      assert(directoryHarness.ledger.payload.directories.includes(expectedDirectory), `missing owned ancestor: ${expectedDirectory}`);
    }
  } finally {
    fs.rmSync(directoryHarness.temporaryRoot, { recursive: true, force: true });
  }

  const cleanupHarness = createHarness("1".repeat(32));
  try {
    writeOwnedFile(cleanupHarness.ledger, "fixtures/owned.txt", "owned");
    const foreignPrefixRoot = path.join(cleanupHarness.vaultRoot, `QA-LIC-Runtime-${"f".repeat(32)}`);
    fs.mkdirSync(foreignPrefixRoot);
    fs.writeFileSync(path.join(foreignPrefixRoot, "foreign.txt"), "foreign");
    assert.equal(cleanupRuntimeQaOwnershipLedger({
      vaultRoot: cleanupHarness.vaultRoot,
      pluginInstallDir: cleanupHarness.pluginInstallDir,
      sessionId: "1".repeat(32)
    }), true);
    assert(!fs.existsSync(cleanupHarness.ledger.paths.visibleRoot), "exact owned visible root was retained");
    assert(fs.existsSync(path.join(foreignPrefixRoot, "foreign.txt")), "foreign prefix root was removed");
  } finally {
    fs.rmSync(cleanupHarness.temporaryRoot, { recursive: true, force: true });
  }

  const leaseHarness = createHarness("6".repeat(32));
  try {
    const lease = writeReleasedCacheLease(leaseHarness.ledger);
    leaseHarness.ledger.recordCacheLeaseArtifactsSync(lease.cacheFilePath);
    assert.equal(leaseHarness.ledger.cleanup(), true, "valid released cache lease was not cleaned");
  } finally {
    fs.rmSync(leaseHarness.temporaryRoot, { recursive: true, force: true });
  }

  for (const [sessionId, mode] of [
    ["9".repeat(32), "before-rename"],
    ["a".repeat(32), "pending-only"],
    ["b".repeat(32), "after-rename"]
  ]) {
    const generationHarness = createHarness(sessionId);
    try {
      stageGenerationCrash(generationHarness, mode);
      assert.equal(generationHarness.ledger.cleanup(), true, `ownership generation recovery failed: ${mode}`);
      assert(!fs.existsSync(generationHarness.ledger.paths.stateRoot), `generation state root was retained: ${mode}`);
    } finally {
      fs.rmSync(generationHarness.temporaryRoot, { recursive: true, force: true });
    }
  }

  const interruptedControlHarness = createHarness("d".repeat(32));
  try {
    writeOwnedFile(interruptedControlHarness.ledger, "fixtures/owned.txt", "owned");
    const originalUnlinkSync = fs.unlinkSync;
    let interrupted = false;
    fs.unlinkSync = (filePath) => {
      originalUnlinkSync(filePath);
      if (!interrupted && path.basename(filePath).startsWith("ownership")) {
        interrupted = true;
        throw new Error("simulated crash after control-file removal");
      }
    };
    try {
      assert.throws(() => interruptedControlHarness.ledger.cleanup(), /simulated crash/);
    } finally {
      fs.unlinkSync = originalUnlinkSync;
    }
    assert(interrupted, "control-file cleanup was not interrupted");
    assert.equal(interruptedControlHarness.ledger.cleanup(), true, "control-file cleanup did not recover after interruption");
    assert(!fs.existsSync(interruptedControlHarness.ledger.paths.stateRoot), "interrupted control state root was retained");
  } finally {
    fs.rmSync(interruptedControlHarness.temporaryRoot, { recursive: true, force: true });
  }

  const detachedControlHarness = createHarness("e".repeat(32));
  try {
    writeOwnedFile(detachedControlHarness.ledger, "fixtures/owned.txt", "owned");
    const originalUnlinkSync = fs.unlinkSync;
    let interrupted = false;
    fs.unlinkSync = (filePath) => {
      if (!interrupted && path.basename(filePath).startsWith("ownership")) {
        interrupted = true;
        throw new Error("simulated crash before detached control unlink");
      }
      originalUnlinkSync(filePath);
    };
    try {
      assert.throws(() => detachedControlHarness.ledger.cleanup(), /simulated crash/);
    } finally {
      fs.unlinkSync = originalUnlinkSync;
    }
    assert(interrupted, "detached control cleanup was not interrupted");
    assert.equal(detachedControlHarness.ledger.cleanup(), true, "detached control cleanup did not recover after interruption");
    assert(!fs.existsSync(detachedControlHarness.ledger.paths.stateRoot), "detached control state root was retained");
  } finally {
    fs.rmSync(detachedControlHarness.temporaryRoot, { recursive: true, force: true });
  }

  const duplicateControlHarness = createHarness("f".repeat(32));
  try {
    const ownedPath = writeOwnedFile(duplicateControlHarness.ledger, "fixtures/owned.txt", "owned");
    const controlPath = path.join(duplicateControlHarness.ledger.paths.stateRoot, "ownership.2.json");
    fs.copyFileSync(controlPath, `${controlPath}.delete-${duplicateControlHarness.ledger.sessionId}.tmp`);
    assert.throws(() => duplicateControlHarness.ledger.cleanup(), /multiple physical representations/);
    assert(fs.existsSync(ownedPath), "duplicate control cleanup partially removed owned data");
    assert(fs.existsSync(controlPath), "duplicate control cleanup removed the canonical control file");
  } finally {
    fs.rmSync(duplicateControlHarness.temporaryRoot, { recursive: true, force: true });
  }

  const duplicateRevisionHarness = createHarness("f".repeat(32));
  try {
    const ownedPath = writeOwnedFile(duplicateRevisionHarness.ledger, "fixtures/owned.txt", "owned");
    const generationPath = path.join(duplicateRevisionHarness.ledger.paths.stateRoot, "ownership.2.json");
    const pendingPath = path.join(
      duplicateRevisionHarness.ledger.paths.stateRoot,
      `ownership.pending-2-${duplicateRevisionHarness.ledger.sessionId}.tmp`
    );
    fs.writeFileSync(pendingPath, `\n${fs.readFileSync(generationPath, "utf8")}`);
    assert.throws(() => duplicateRevisionHarness.ledger.cleanup(), /multiple physical files for revision 2/);
    assert(fs.existsSync(ownedPath), "duplicate revision cleanup partially removed owned data");
    assert(fs.existsSync(generationPath), "duplicate revision cleanup removed the finalized generation");
    assert(fs.existsSync(pendingPath), "duplicate revision cleanup removed the pending generation");
  } finally {
    fs.rmSync(duplicateRevisionHarness.temporaryRoot, { recursive: true, force: true });
  }

  const duplicateDataHarness = createHarness("f".repeat(32));
  try {
    const ownedPath = writeOwnedFile(duplicateDataHarness.ledger, "fixtures/owned.txt", "owned");
    const detachedPath = `${ownedPath}.delete-${duplicateDataHarness.ledger.sessionId}.tmp`;
    const doubleDetachedPath = `${detachedPath}.delete-${duplicateDataHarness.ledger.sessionId}.tmp`;
    fs.copyFileSync(ownedPath, detachedPath);
    fs.copyFileSync(ownedPath, doubleDetachedPath);
    fs.unlinkSync(ownedPath);
    assert.throws(() => duplicateDataHarness.ledger.cleanup(), /multiple physical representations/);
    assert(fs.existsSync(detachedPath), "duplicate data cleanup removed the first detached representation");
    assert(fs.existsSync(doubleDetachedPath), "duplicate data cleanup removed the second detached representation");
  } finally {
    fs.rmSync(duplicateDataHarness.temporaryRoot, { recursive: true, force: true });
  }

  const symbolicLinkHarness = createHarness("f".repeat(32));
  try {
    const ownedPath = writeOwnedFile(symbolicLinkHarness.ledger, "fixtures/owned.txt", "owned");
    const foreignTarget = path.join(symbolicLinkHarness.temporaryRoot, "foreign-target");
    fs.mkdirSync(foreignTarget);
    const foreignFile = path.join(foreignTarget, "foreign.txt");
    fs.writeFileSync(foreignFile, "foreign");
    const junctionPath = path.join(symbolicLinkHarness.ledger.paths.visibleRoot, "fixtures", "foreign-junction");
    fs.symlinkSync(foreignTarget, junctionPath, "junction");
    assert.throws(() => symbolicLinkHarness.ledger.cleanup(), /symbolic link/);
    assert(fs.existsSync(ownedPath), "symbolic-link cleanup partially removed an owned sibling");
    assert.equal(fs.readFileSync(foreignFile, "utf8"), "foreign", "symbolic-link cleanup changed the external target");
  } finally {
    fs.rmSync(symbolicLinkHarness.temporaryRoot, { recursive: true, force: true });
  }

  const invalidLeaseHarness = createHarness("7".repeat(32));
  try {
    const lease = writeReleasedCacheLease(invalidLeaseHarness.ledger, { ownerPath: "foreign/path" });
    assert.throws(() => invalidLeaseHarness.ledger.recordCacheLeaseArtifactsSync(lease.cacheFilePath), /identity is invalid/);
    assert(!invalidLeaseHarness.ledger.payload.files.some((entry) => entry.path === lease.lockPath), "invalid lease was adopted");
  } finally {
    fs.rmSync(invalidLeaseHarness.temporaryRoot, { recursive: true, force: true });
  }

  const copiedLeaseHarness = createHarness("8".repeat(32));
  try {
    const lease = writeReleasedCacheLease(copiedLeaseHarness.ledger);
    const rawPayload = fs.readFileSync(lease.lockPath, "utf8");
    fs.unlinkSync(lease.lockPath);
    fs.writeFileSync(lease.lockPath, rawPayload);
    assert.throws(() => copiedLeaseHarness.ledger.recordCacheLeaseArtifactsSync(lease.cacheFilePath), /identity is invalid/);
    assert(!copiedLeaseHarness.ledger.payload.files.some((entry) => entry.path === lease.lockPath), "copied lease bytes were adopted without hard-link identity");
  } finally {
    fs.rmSync(copiedLeaseHarness.temporaryRoot, { recursive: true, force: true });
  }

  const racedLeaseHarness = createHarness("c".repeat(32));
  try {
    const lease = writeReleasedCacheLease(racedLeaseHarness.ledger);
    const commitFileEntriesSync = racedLeaseHarness.ledger.commitFileEntriesSync.bind(racedLeaseHarness.ledger);
    racedLeaseHarness.ledger.commitFileEntriesSync = (entries) => {
      const rawPayload = fs.readFileSync(lease.lockPath);
      fs.unlinkSync(lease.lockPath);
      fs.writeFileSync(lease.lockPath, rawPayload);
      commitFileEntriesSync(entries);
    };
    assert.throws(
      () => racedLeaseHarness.ledger.recordCacheLeaseArtifactsSync(lease.cacheFilePath),
      /changed before ownership commit/
    );
    assert(!racedLeaseHarness.ledger.payload.files.some((entry) => entry.path === lease.lockPath), "raced lease replacement was adopted");
  } finally {
    fs.rmSync(racedLeaseHarness.temporaryRoot, { recursive: true, force: true });
  }

  const atomicBatchHarness = createHarness("c".repeat(32));
  try {
    const validPath = path.join(atomicBatchHarness.ledger.paths.visibleRoot, "valid.txt");
    const invalidPath = path.join(atomicBatchHarness.ledger.paths.visibleRoot, "invalid.txt");
    fs.writeFileSync(validPath, "valid");
    fs.writeFileSync(invalidPath, "invalid");
    const beforePayload = JSON.stringify(atomicBatchHarness.ledger.payload);
    assert.throws(() => atomicBatchHarness.ledger.commitFileEntriesSync([
      { path: validPath, sha256: crypto.createHash("sha256").update("valid").digest("hex") },
      { path: invalidPath, sha256: "0".repeat(64) }
    ]), /changed before ownership commit/);
    assert.equal(JSON.stringify(atomicBatchHarness.ledger.payload), beforePayload, "failed ownership batch partially mutated the in-memory ledger");
  } finally {
    fs.rmSync(atomicBatchHarness.temporaryRoot, { recursive: true, force: true });
  }

  const unknownHarness = createHarness("2".repeat(32));
  try {
    const ownedPath = writeOwnedFile(unknownHarness.ledger, "fixtures/owned.txt", "owned");
    const unknownPath = path.join(unknownHarness.ledger.paths.visibleRoot, "fixtures", "foreign.txt");
    fs.writeFileSync(unknownPath, "foreign");
    assert.throws(() => unknownHarness.ledger.cleanup(), /unknown file/);
    assert(fs.existsSync(ownedPath) && fs.existsSync(unknownPath), "cleanup partially deleted a tree with an unknown child");
  } finally {
    fs.rmSync(unknownHarness.temporaryRoot, { recursive: true, force: true });
  }

  const changedHarness = createHarness("3".repeat(32));
  try {
    const ownedPath = writeOwnedFile(changedHarness.ledger, "fixtures/owned.txt", "owned");
    fs.writeFileSync(ownedPath, "changed");
    assert.throws(() => changedHarness.ledger.cleanup(), /changed owned file/);
    assert.equal(fs.readFileSync(ownedPath, "utf8"), "changed", "changed owned file was removed");
  } finally {
    fs.rmSync(changedHarness.temporaryRoot, { recursive: true, force: true });
  }

  const movedHarness = createHarness("5".repeat(32));
  try {
    const relativeSource = "fixtures/moved.jpg";
    const sourcePath = writeOwnedFile(movedHarness.ledger, relativeSource, "original");
    const outputPath = writeOwnedFile(
      movedHarness.ledger,
      `Compressed/QA-LIC-Runtime-${"5".repeat(32)}/${relativeSource}`,
      "compressed"
    );
    fs.writeFileSync(sourcePath, "compressed");
    fs.unlinkSync(outputPath);
    assert.equal(movedHarness.ledger.cleanup(), true, "exact moved output identity was not reconciled");
    assert(!fs.existsSync(movedHarness.ledger.paths.visibleRoot), "reconciled move session was retained");
  } finally {
    fs.rmSync(movedHarness.temporaryRoot, { recursive: true, force: true });
  }

  const foreignParentHarness = createHarness("5".repeat(32));
  try {
    writeOwnedFile(foreignParentHarness.ledger, "fixtures/owned.txt", "owned");
    const runtimeRoot = path.dirname(foreignParentHarness.ledger.paths.stateRoot);
    const foreignPath = path.join(runtimeRoot, "foreign.txt");
    fs.writeFileSync(foreignPath, "foreign");
    cleanupRuntimeQaOwnershipLedgers({
      vaultRoot: foreignParentHarness.vaultRoot,
      pluginInstallDir: foreignParentHarness.pluginInstallDir
    });
    assert.equal(fs.readFileSync(foreignPath, "utf8"), "foreign", "parent cleanup changed or removed a foreign child");
  } finally {
    fs.rmSync(foreignParentHarness.temporaryRoot, { recursive: true, force: true });
  }

  const staleHarness = createHarness("4".repeat(32));
  try {
    writeOwnedFile(staleHarness.ledger, "fixtures/owned.txt", "owned");
    const warnings = [];
    const cleaned = cleanupRuntimeQaOwnershipLedgers({
      vaultRoot: staleHarness.vaultRoot,
      pluginInstallDir: staleHarness.pluginInstallDir,
      onWarning: (sessionId, error) => warnings.push({ sessionId, error })
    });
    assert.deepEqual(cleaned, ["4".repeat(32)], "valid stale ownership ledger was not recovered");
    assert.equal(warnings.length, 0, "valid stale ownership cleanup emitted a warning");
    assert(!fs.existsSync(path.dirname(staleHarness.ledger.paths.stateRoot)), "successful cleanup retained the empty runtime QA parent");
    assert(!fs.existsSync(path.dirname(path.dirname(staleHarness.ledger.paths.stateRoot))), "successful cleanup retained the empty QA backup parent");
  } finally {
    fs.rmSync(staleHarness.temporaryRoot, { recursive: true, force: true });
  }

  console.log("Runtime QA ownership tests passed.");
}

main();
