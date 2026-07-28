(async () => {
  const fs = require("fs");
  const path = require("path");
  const electron = require("electron");
  const crypto = require("crypto");

  const pluginId = "local-image-compress";
  const startedAt = new Date().toISOString();
  const qaStateMarker = "QA-LIC-Runtime-";
  const launchTokenKey = "__tinyLocalRuntimeQaLaunchToken";
  const ownershipModulePathKey = "__tinyLocalRuntimeQaOwnershipModulePath";
  const launchToken = globalThis[launchTokenKey];
  const ownershipModulePath = globalThis[ownershipModulePathKey];
  Reflect.deleteProperty(globalThis, launchTokenKey);
  Reflect.deleteProperty(globalThis, ownershipModulePathKey);
  const qaSessionId = typeof launchToken === "string" && /^[a-f0-9]{32}$/.test(launchToken)
    ? launchToken
    : crypto.randomBytes(16).toString("hex");
  const qaRoot = `${qaStateMarker}${qaSessionId}`;
  const report = {
    startedAt,
    pluginId,
    qaRoot,
    checks: [],
    failures: [],
    warnings: [],
    metrics: {}
  };

  const activeQaSymbol = Symbol.for("local-image-compress.runtime-qa-active-v1");
  // RUNTIME_QA_CARRIER_START
  const claimRuntimeQaCarrier = (globalObject, carrierSymbol, wrapperLaunchToken, claimStartedAt) => {
    const existing = globalObject[carrierSymbol];
    if (typeof wrapperLaunchToken === "string") {
      if (existing?.version !== 1 || existing.owner !== "wrapper" || existing.phase !== "reserved" || existing.token !== wrapperLaunchToken) {
        throw new Error("Desktop runtime QA launch token has no matching renderer reservation");
      }
      existing.phase = "running";
      return existing;
    }
    if (existing) {
      throw new Error("Another desktop runtime QA operation is already active; refusing an overlapping run");
    }
    const directOwner = { version: 1, token: `direct-${claimStartedAt}`, owner: "direct", phase: "running", startedAt: claimStartedAt };
    globalObject[carrierSymbol] = directOwner;
    return directOwner;
  };
  const finishRuntimeQaCarrier = (globalObject, carrierSymbol, owner, settledAt) => {
    if (globalObject[carrierSymbol] !== owner) {
      return;
    }
    if (owner.owner === "direct") {
      Reflect.deleteProperty(globalObject, carrierSymbol);
      return;
    }
    if (owner.owner === "wrapper" && owner.phase === "running") {
      owner.phase = "settled";
      owner.settledAt = settledAt;
    }
  };
  // RUNTIME_QA_CARRIER_END
  const qaOwner = claimRuntimeQaCarrier(globalThis, activeQaSymbol, launchToken, startedAt);

  try {

  const restoreStack = [];
  const cleanupStack = [];
  let progressPath = "";
  let ownership = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const normalizeVaultPath = (value) => String(value || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  const joinVault = (...parts) => normalizeVaultPath(parts.filter(Boolean).join("/"));
  const serializeError = (error) => ({
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack ? String(error.stack).split("\n").slice(0, 6).join("\n") : ""
  });
  const assert = (condition, message, details) => {
    if (!condition) {
      const error = new Error(message);
      if (details !== undefined) {
        error.details = details;
      }
      throw error;
    }
  };
  const recordWarning = (name, details) => report.warnings.push({ name, details });
  const writeProgress = (status, name, details = {}) => {
    if (!progressPath) {
      return;
    }
    const progressText = JSON.stringify({
      status,
      name,
      updatedAt: new Date().toISOString(),
      ...details
    }, null, 2);
    fs.writeFileSync(progressPath, progressText);
    ownership?.recordFileWithExpectedSha256Sync(progressPath, crypto.createHash("sha256").update(progressText).digest("hex"));
  };
  const check = async (name, fn) => {
    const start = Date.now();
    writeProgress("running", name);
    try {
      const details = await fn();
      report.checks.push({
        name,
        status: "pass",
        durationMs: Date.now() - start,
        ...(details === undefined ? {} : { details })
      });
      writeProgress("passed", name, { durationMs: Date.now() - start });
      return details;
    } catch (error) {
      const failure = {
        name,
        status: "fail",
        durationMs: Date.now() - start,
        error: serializeError(error),
        ...(error?.details === undefined ? {} : { details: error.details })
      };
      report.checks.push(failure);
      report.failures.push(failure);
      writeProgress("failed", name, { durationMs: Date.now() - start, error: serializeError(error) });
      return undefined;
    }
  };

  let p = null;
  const pluginReadyDeadline = Date.now() + 90_000;
  while (Date.now() < pluginReadyDeadline) {
    const candidate = app?.plugins?.plugins?.[pluginId];
    if (candidate?.isInitialized === true && candidate?.cache?.cacheData && candidate?.compressor && candidate?.imageIndex && typeof candidate.getPlatformPorts === "function") {
      p = candidate;
      break;
    }
    await sleep(100);
  }
  if (!p) {
    throw new Error(`${pluginId} did not finish runtime initialization`);
  }
  const vaultBase = p.getPlatformPorts?.().fs.getDisplayPath("") || app.vault.adapter?.getBasePath?.() || app.vault.adapter?.basePath;
  if (!vaultBase) {
    throw new Error("Vault base path is unavailable");
  }
  const absolute = (vaultRel) => path.join(vaultBase, ...normalizeVaultPath(vaultRel).split("/").filter(Boolean));
  const sha256Abs = (targetAbs) => crypto.createHash("sha256").update(fs.readFileSync(targetAbs)).digest("hex");
  assert(typeof ownershipModulePath === "string" && ownershipModulePath, "Runtime QA ownership module path is unavailable");
  delete require.cache[require.resolve(ownershipModulePath)];
  const { RuntimeQaOwnershipLedger } = require(ownershipModulePath);
  const pluginInstallAbsolute = absolute(p.getPluginDirectory());
  ownership = new RuntimeQaOwnershipLedger({ vaultRoot: vaultBase, pluginInstallDir: pluginInstallAbsolute, sessionId: qaSessionId });
  ownership.initialize();
  const qaStateRoot = joinVault(p.getPluginDirectory(), "qa-backups", "runtime", qaSessionId);
  report.qaStateRoot = qaStateRoot;
  progressPath = absolute(joinVault(qaStateRoot, "runtime-qa-progress.json"));
  writeProgress("starting", "runtime QA");
  const outputRelFor = (sourceRel) => joinVault(p.getOutputFolder(), sourceRel);
  const outputAbsFor = (sourceRel) => absolute(outputRelFor(sourceRel));
  const existsRel = async (vaultRel) => fs.promises.access(absolute(vaultRel)).then(() => true).catch(() => false);
  const statRel = async (vaultRel) => fs.promises.stat(absolute(vaultRel));
  const safeRmAbs = async (targetAbs) => {
    const resolvedBase = path.resolve(vaultBase);
    const resolvedTarget = path.resolve(targetAbs);
    const relative = path.relative(resolvedBase, resolvedTarget);
    assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Refusing to remove outside vault", { targetAbs, vaultBase });
    const targetStat = await fs.promises.lstat(resolvedTarget).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error));
    if (!targetStat) return;
    assert(!targetStat.isSymbolicLink(), "Refusing to remove a symbolic link from runtime QA", { targetAbs });
    if (targetStat.isDirectory()) {
      await fs.promises.rmdir(resolvedTarget);
    } else {
      await fs.promises.unlink(resolvedTarget);
    }
  };
  const isQaOwnedVaultPath = (vaultRel) => {
    const normalized = normalizeVaultPath(vaultRel);
    return normalized === qaRoot || normalized.startsWith(`${qaRoot}/`);
  };
  const isQaOwnedStatePath = (vaultRel) => {
    const normalized = normalizeVaultPath(vaultRel);
    return normalized === qaStateRoot || normalized.startsWith(`${qaStateRoot}/`);
  };
  const isQaOwnedArtifactPath = (vaultRel) => isQaOwnedVaultPath(vaultRel) || isQaOwnedStatePath(vaultRel);
  const getEscapedQaFiles = (files) => Array.from(files || [])
    .filter((file) => file?.path && !isQaOwnedVaultPath(file.path))
    .map((file) => file.path);
  const assertQaOwnedFiles = (files, action) => {
    const escaped = getEscapedQaFiles(files);
    assert(escaped.length === 0, `Runtime QA attempted ${action} outside ${qaRoot}`, {
      escaped: escaped.slice(0, 25),
      escapedCount: escaped.length,
      allowedRoots: p.settings?.allowedRoots,
      outputFolder: p.settings?.outputFolder
    });
  };
  const assertQaRuntimeScope = async (label) => {
    const allowedRoots = Array.isArray(p.settings?.allowedRoots) ? p.settings.allowedRoots.map(normalizeVaultPath) : [];
    assert(allowedRoots.length === 1 && normalizeVaultPathRootForQa(allowedRoots[0]) === qaRoot, `${label}: runtime QA allowedRoots escaped QA root`, {
      allowedRoots: p.settings?.allowedRoots
    });
    assert(normalizeVaultPath(p.getOutputFolder()) === `${qaRoot}/Compressed`, `${label}: runtime QA output folder escaped QA root`, {
      outputFolder: p.getOutputFolder()
    });
    if (p.imageIndex?.isReady?.()) {
      assertQaOwnedFiles(p.getAllImageFiles(), `${label} image-index scope`);
    }
  };
  function normalizeVaultPathRootForQa(vaultRel) {
    return normalizeVaultPath(vaultRel).replace(/^\/+|\/+$/g, "");
  }

  const originalSettings = clone(p.settings);
  const originalCacheData = clone(p.cache.cacheData);
  const originalOpenPath = electron.shell.openPath;
  const originalTrashItem = electron.shell.trashItem;
  const adapter = app.vault.adapter;
  const hadOwnTrashLocal = Object.prototype.hasOwnProperty.call(adapter, "trashLocal");
  const originalTrashLocal = adapter.trashLocal;
  let vaultTrashCallCount = 0;
  const originalNewFileDelay = p.newFileQueue?.AUTO_COMPRESS_DELAY;
  const originalCompressFile = p.compressFile;
  const originalRunCompressionBatch = p.runCompressionBatch;
  if (typeof originalCompressFile === "function") {
    p.compressFile = async (file, ...args) => {
      assertQaOwnedFiles([file], "compressFile");
      return await originalCompressFile.call(p, file, ...args);
    };
    restoreStack.push(async () => {
      p.compressFile = originalCompressFile;
    });
  }
  if (typeof originalRunCompressionBatch === "function") {
    p.runCompressionBatch = async (files, ...args) => {
      assertQaOwnedFiles(files, "runCompressionBatch");
      return await originalRunCompressionBatch.call(p, files, ...args);
    };
    restoreStack.push(async () => {
      p.runCompressionBatch = originalRunCompressionBatch;
    });
  }
  const originalGetBackupStoragePaths = p.getBackupStoragePaths;
  if (typeof originalGetBackupStoragePaths === "function") {
    const qaBackupStorageRoot = joinVault(qaStateRoot, "storage");
    const originalCacheFile = p.cache.cacheFile;
    const originalCacheBackupsDir = p.cache.cacheBackupsDir;
    const originalCacheFileAbsolute = absolute(originalCacheFile);
    const originalCacheFileBytes = await fs.promises.readFile(originalCacheFileAbsolute).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    p.getBackupStoragePaths = () => {
      const originalPaths = originalGetBackupStoragePaths.call(p);
      return {
        ...originalPaths,
        root: qaBackupStorageRoot,
        backupsRoot: joinVault(qaBackupStorageRoot, "backups"),
        cacheBackups: joinVault(qaBackupStorageRoot, "backups", "cache"),
        originalFilesBackups: joinVault(qaBackupStorageRoot, "backups", "originals")
      };
    };
    p.cache.cancelPendingSave();
    p.cache.cacheFile = joinVault(qaStateRoot, "cache", "tinyLocal-cache.json");
    p.cache.cacheBackupsDir = joinVault(qaBackupStorageRoot, "backups", "cache");
    ownership.recordDirectorySync(path.dirname(absolute(p.cache.cacheFile)));
    const isQaOwnedRecoveryJournal = async (vaultRel) => {
      const normalized = normalizeVaultPath(vaultRel);
      if (!normalized.startsWith(".local-image-compress/recovery/")) return false;
      const fileName = path.basename(normalized);
      if (!/^desktop-(?:replacement|cleanup)-journal-v1-[a-f0-9]{32}-[a-f0-9]{32}\.json\.delete-[a-f0-9]{32}\.tmp$/i.test(fileName)) return false;
      let journal;
      try {
        journal = JSON.parse(await fs.promises.readFile(absolute(normalized), "utf8"));
      } catch (error) {
        void error;
        return false;
      }
      if (journal?.sourcePath !== undefined) {
        return [journal.sourcePath, journal.quarantinePath]
          .every((candidate) => typeof candidate === "string" && isQaOwnedArtifactPath(candidate));
      }
      return [journal?.stagedPath, journal?.targetPath]
        .every((candidate) => typeof candidate === "string" && isQaOwnedArtifactPath(candidate))
        && (journal?.rollbackPath === null
          || (typeof journal?.rollbackPath === "string" && isQaOwnedArtifactPath(journal.rollbackPath)));
    };
    const removeQaOwnedTrashTarget = async (vaultRel, action) => {
      const normalized = normalizeVaultPath(vaultRel);
      assert(
        isQaOwnedVaultPath(normalized) || isQaOwnedStatePath(normalized) || await isQaOwnedRecoveryJournal(normalized),
        `Runtime QA blocked ${action} outside ${qaRoot}`,
        { target: normalized }
      );
      await safeRmAbs(absolute(normalized));
    };
    adapter.trashLocal = async (vaultRel) => {
      vaultTrashCallCount += 1;
      await removeQaOwnedTrashTarget(vaultRel, "trashLocal");
    };
    electron.shell.trashItem = async (targetAbs) => {
      const relative = path.relative(path.resolve(vaultBase), path.resolve(targetAbs));
      assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative), `Runtime QA blocked trashItem outside ${qaRoot}`, { targetAbs });
      await removeQaOwnedTrashTarget(relative, "trashItem");
    };
    restoreStack.push(async () => {
      p.cache.cacheFile = originalCacheFile;
      p.cache.cacheBackupsDir = originalCacheBackupsDir;
      p.getBackupStoragePaths = originalGetBackupStoragePaths;
      if (hadOwnTrashLocal) {
        adapter.trashLocal = originalTrashLocal;
      } else {
        Reflect.deleteProperty(adapter, "trashLocal");
      }
      electron.shell.trashItem = originalTrashItem;
    });
    restoreStack.push(async () => {
      const currentCacheFileBytes = await fs.promises.readFile(originalCacheFileAbsolute).catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
      });
      assert(
        originalCacheFileBytes === null
          ? currentCacheFileBytes === null
          : currentCacheFileBytes !== null && Buffer.compare(originalCacheFileBytes, currentCacheFileBytes) === 0,
        "Runtime QA changed the product cache while the isolated cache was active"
      );
    });
  }
  restoreStack.push(async () => {
    try {
      p.statusBarController?.closeMenu?.();
      p.closeManagedModals?.();
    } catch (error) {
      recordWarning("cleanup.close-ui", serializeError(error));
    }
    if (originalNewFileDelay !== undefined && p.newFileQueue) {
      p.newFileQueue.AUTO_COMPRESS_DELAY = originalNewFileDelay;
    }
    electron.shell.openPath = originalOpenPath;
    p.settings = clone(originalSettings);
    await p.saveSettings();
    p.cache.cacheData = clone(originalCacheData);
    await p.rebuildImageIndex?.("runtime-qa-restore");
    await p.statusBarController?.update?.();
  });
  cleanupStack.push(async () => {
    assert(await p.cache.flushPendingCacheSave(), "Runtime QA isolated cache did not settle before cleanup");
    p.cache.cancelPendingSave();
    if (await existsRel(p.cache.cacheFile)) {
      assert(typeof expectedCacheFileSha256 === "string", "Runtime QA isolated cache has no exact committed payload proof");
      ownership.recordFileWithExpectedSha256Sync(
        absolute(p.cache.cacheFile),
        expectedCacheFileSha256
      );
    }
    ownership.recordCacheLeaseArtifactsSync(absolute(p.cache.cacheFile));
    for (const backupName of await p.cache.getAvailableBackups()) {
      const backupPath = joinVault(p.cache.cacheBackupsDir, backupName);
      if (await existsRel(backupPath)) {
        const backupAbsolutePath = path.resolve(absolute(backupPath));
        const expectedSha256 = expectedCacheBackupFiles.get(backupAbsolutePath);
        assert(typeof expectedSha256 === "string", "Runtime QA cache backup has no exact creation proof", { backupPath });
        ownership.recordFileWithExpectedSha256Sync(backupAbsolutePath, expectedSha256);
      }
    }
  });

  function patchMethod(target, name, replacement) {
    const original = target?.[name];
    target[name] = replacement;
    restoreStack.push(async () => {
      target[name] = original;
    });
    return original;
  }

  const expectedCacheBackupFiles = new Map();
  let expectedCacheFileSha256 = null;
  const originalWriteCacheFileAtomic = patchMethod(p.cache, "writeCacheFileAtomic", async function(data, shouldCommit, options = {}) {
    let committedPayload = options.mergeDiskEntries ? null : data;
    const originalBuildMergedCachePayload = this.buildMergedCachePayload;
    this.buildMergedCachePayload = (...args) => {
      committedPayload = originalBuildMergedCachePayload.apply(this, args);
      return committedPayload;
    };
    try {
      const committed = await originalWriteCacheFileAtomic.call(this, data, shouldCommit, options);
      if (committed) {
        assert(typeof committedPayload === "string", "Runtime QA cache commit exposed no exact payload proof");
        expectedCacheFileSha256 = crypto.createHash("sha256").update(committedPayload).digest("hex");
      }
      return committed;
    } finally {
      this.buildMergedCachePayload = originalBuildMergedCachePayload;
    }
  });
  const originalGetCacheBackupPath = patchMethod(p.cache.backupStore, "getCacheBackupPath", function(...args) {
    const cacheAbsolutePath = absolute(p.cache.cacheFile);
    const expectedSha256 = fs.existsSync(cacheAbsolutePath) ? sha256Abs(cacheAbsolutePath) : null;
    const result = originalGetCacheBackupPath.apply(this, args);
    if (typeof expectedSha256 === "string") {
      const backupAbsolutePath = path.resolve(absolute(result.backupFile));
      assert(!expectedCacheBackupFiles.has(backupAbsolutePath), "Runtime QA cache backup path was reused", { backupFile: result.backupFile });
      expectedCacheBackupFiles.set(backupAbsolutePath, expectedSha256);
    }
    return result;
  });

  async function ensureFolder(vaultRel) {
    const normalized = normalizeVaultPath(vaultRel);
    if (!normalized) {
      return;
    }
    const parts = normalized.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!app.vault.getAbstractFileByPath(current)) {
        await app.vault.createFolder(current);
        await sleep(20);
        if (isQaOwnedVaultPath(current)) {
          ownership.recordDirectorySync(absolute(current));
        }
      }
    }
  }

  async function createTextFile(vaultRel, text) {
    await ensureFolder(path.posix.dirname(normalizeVaultPath(vaultRel)));
    const file = await app.vault.create(vaultRel, text);
    ownership.recordFileWithExpectedSha256Sync(absolute(file.path), crypto.createHash("sha256").update(text).digest("hex"));
    return file;
  }

  function drawPattern(ctx, width, height, variant) {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, variant % 2 ? "#fb7185" : "#0ea5e9");
    gradient.addColorStop(0.45, variant % 3 ? "#f8fafc" : "#22c55e");
    gradient.addColorStop(1, variant % 2 ? "#0f172a" : "#f59e0b");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    for (let y = 0; y < height; y += 18) {
      for (let x = 0; x < width; x += 18) {
        const r = (x * 13 + y * 3 + variant * 19) % 255;
        const g = (x * 7 + y * 17 + variant * 11) % 255;
        const b = (x * 5 + y * 23 + variant * 29) % 255;
        ctx.fillStyle = `rgba(${r}, ${g}, ${b}, 0.55)`;
        ctx.fillRect(x, y, 12 + (variant % 5), 12 + ((x + y) % 5));
      }
    }
    ctx.fillStyle = "rgba(255,255,255,0.32)";
    ctx.font = "bold 96px sans-serif";
    ctx.fillText(`QA ${variant}`, 44, Math.floor(height * 0.58));
  }

  async function makeImageBuffer(mime, width, height, quality, variant) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    drawPattern(ctx, width, height, variant);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((value) => value ? resolve(value) : reject(new Error(`canvas.toBlob failed for ${mime}`)), mime, quality);
    });
    return await blob.arrayBuffer();
  }

  async function createImage(vaultRel, kind, variant) {
    const normalized = normalizeVaultPath(vaultRel);
    await ensureFolder(path.posix.dirname(normalized));
    const buffer = kind === "png"
      ? await makeImageBuffer("image/png", 760, 520, undefined, variant)
      : await makeImageBuffer("image/jpeg", 960, 640, 0.99, variant);
    const expectedSha256 = crypto.createHash("sha256").update(Buffer.from(buffer)).digest("hex");
    const file = await app.vault.createBinary(normalized, buffer);
    ownership.recordFileWithExpectedSha256Sync(absolute(file.path), expectedSha256);
    await sleep(80);
    assert(isQaOwnedVaultPath(file.path), "Runtime QA fixture escaped its visible root after Vault automation", { createdPath: normalized, currentPath: file.path });
    ownership.recordFileWithExpectedSha256Sync(absolute(file.path), expectedSha256);
    return file;
  }

  async function createSmallJpeg(vaultRel) {
    const normalized = normalizeVaultPath(vaultRel);
    await ensureFolder(path.posix.dirname(normalized));
    const buffer = await makeImageBuffer("image/jpeg", 64, 64, 0.45, 999);
    const expectedSha256 = crypto.createHash("sha256").update(Buffer.from(buffer)).digest("hex");
    const file = await app.vault.createBinary(normalized, buffer);
    ownership.recordFileWithExpectedSha256Sync(absolute(file.path), expectedSha256);
    await sleep(80);
    assert(isQaOwnedVaultPath(file.path), "Runtime QA fixture escaped its visible root after Vault automation", { createdPath: normalized, currentPath: file.path });
    ownership.recordFileWithExpectedSha256Sync(absolute(file.path), expectedSha256);
    return file;
  }

  const expectedOriginalBackupFiles = new Map();

  const captureMoveBackupProofs = async (action) => {
    const originalCreateBackupBeforeMove = p.moveService.createBackupBeforeMove;
    p.moveService.createBackupBeforeMove = async function(compressedFiles) {
      const result = await originalCreateBackupBeforeMove.call(this, compressedFiles);
      for (const file of result.files) {
        const originalBackupPath = normalizeVaultPath(file.originalBackupPath);
        const originalsMarker = "/originals/";
        const originalsIndex = originalBackupPath.lastIndexOf(originalsMarker);
        assert(originalsIndex > 0
          && /^[a-f0-9]{64}$/.test(file.originalSha256BeforeMove || "")
          && /^[a-f0-9]{64}$/.test(file.compressedSha256 || ""),
        "Move backup result has no exact path-bound file proofs", { file });
        const batchRoot = originalBackupPath.slice(0, originalsIndex);
        const expectedFiles = [
          [originalBackupPath, file.originalSha256BeforeMove],
          [joinVault(batchRoot, "compressed", file.compressedPath), file.compressedSha256]
        ];
        for (const [vaultPath, expectedSha256] of expectedFiles) {
          assert(isQaOwnedArtifactPath(vaultPath), "Move backup proof escaped exact QA storage", { vaultPath });
          const absolutePath = path.resolve(absolute(vaultPath));
          assert(!expectedOriginalBackupFiles.has(absolutePath), "Move backup proof reused an exact path", { vaultPath });
          expectedOriginalBackupFiles.set(absolutePath, expectedSha256);
        }
      }
      return result;
    };
    try {
      return await action();
    } finally {
      p.moveService.createBackupBeforeMove = originalCreateBackupBeforeMove;
    }
  };

  function recordProvenOriginalBackups(rootAbs) {
    if (!fs.existsSync(rootAbs)) {
      return;
    }
    const resolvedRoot = path.resolve(rootAbs);
    const directories = [];
    const files = [];
    const visit = (directoryPath) => {
      const stat = fs.lstatSync(directoryPath);
      assert(stat.isDirectory() && !stat.isSymbolicLink(), "Runtime QA original-backup root is not a real directory", { directoryPath });
      directories.push(path.resolve(directoryPath));
      for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
        const entryPath = path.join(directoryPath, entry.name);
        assert(!entry.isSymbolicLink(), "Runtime QA original-backup storage contains a symbolic link", { entryPath });
        if (entry.isDirectory()) {
          visit(entryPath);
        } else {
          assert(entry.isFile(), "Runtime QA original-backup storage contains an unsupported entry", { entryPath });
          const resolvedEntryPath = path.resolve(entryPath);
          const expectedSha256 = expectedOriginalBackupFiles.get(resolvedEntryPath);
          assert(typeof expectedSha256 === "string", "Runtime QA refused to adopt an unproven original-backup file", { entryPath });
          files.push({ path: resolvedEntryPath, expectedSha256 });
        }
      }
    };
    visit(resolvedRoot);
    const expectedDirectories = new Set([resolvedRoot]);
    for (const expectedFilePath of expectedOriginalBackupFiles.keys()) {
      assert(expectedFilePath.startsWith(`${resolvedRoot}${path.sep}`), "Runtime QA original-backup proof escaped its exact root", { expectedFilePath });
      let directoryPath = path.dirname(expectedFilePath);
      while (directoryPath === resolvedRoot || directoryPath.startsWith(`${resolvedRoot}${path.sep}`)) {
        expectedDirectories.add(directoryPath);
        if (directoryPath === resolvedRoot) break;
        directoryPath = path.dirname(directoryPath);
      }
      assert(files.some((file) => file.path === expectedFilePath), "Runtime QA exact original-backup file is missing", { expectedFilePath });
    }
    assert(directories.length === expectedDirectories.size
      && directories.every((directoryPath) => expectedDirectories.has(directoryPath)),
    "Runtime QA original-backup tree contains an unproven directory", { directories });
    for (const directoryPath of directories) {
      ownership.recordDirectorySync(directoryPath);
    }
    for (const file of files) {
      ownership.recordFileWithExpectedSha256Sync(file.path, file.expectedSha256);
    }
  }

  async function waitForFile(vaultRel, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await existsRel(vaultRel)) {
        return true;
      }
      await sleep(250);
    }
    return false;
  }

  async function waitForCompressionIdle(timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((p.compressionWorkflowsInFlight || 0) === 0 && !p.isAutoMoveRunning && !p.moveService?.moveOperationInProgress && !p.backgroundCompressionService?.isBackgroundCompressionRunning) {
        return true;
      }
      await sleep(250);
    }
    return false;
  }

  async function waitForFreshCacheEntry(file, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const freshEntry = await p.cache.getFreshEntryForFile(file);
      if (freshEntry) {
        return freshEntry;
      }
      await sleep(150);
    }
    return null;
  }

  function getStoredCacheEntryWithState(filePath, state) {
    const entries = p.cache.getEntriesForPath(filePath) || [];
    const matchingEntries = entries
      .map(([cacheKey, entry]) => ({ cacheKey, entry }))
      .filter(({ entry }) => entry?.state === state)
      .sort((left, right) => Number(right.entry?.timestamp || 0) - Number(left.entry?.timestamp || 0));
    return matchingEntries[0] || null;
  }

  async function waitForStatusMenu(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const menu = document.querySelector(".tiny-local-status-menu");
      if (menu) {
        return menu;
      }
      await sleep(100);
    }
    return null;
  }

  async function assertCompressed(file, label) {
    await waitForCompressionIdle();
    const outRel = outputRelFor(file.path);
    assert(await waitForFile(outRel), `${label}: compressed output was not created`, { source: file.path, outRel });
    const originalStats = await statRel(file.path);
    const compressedStats = await statRel(outRel);
    assert(compressedStats.size > 0, `${label}: compressed output is empty`, { outRel });
    assert(compressedStats.size < originalStats.size, `${label}: compressed output is not smaller`, {
      source: file.path,
      originalSize: originalStats.size,
      compressedSize: compressedStats.size
    });
    const freshEntry = await waitForFreshCacheEntry(file);
    assert(!!freshEntry, `${label}: cache entry missing`, { source: file.path });
    assert(freshEntry.entry?.state === "pending_move", `${label}: cache entry is not pending_move`, freshEntry.entry);
    assert(freshEntry.entry?.outputPath === outRel && typeof freshEntry.entry?.outputSha256 === "string", `${label}: cache entry has no exact committed output proof`, freshEntry.entry);
    ownership.recordFileWithExpectedSha256Sync(absolute(outRel), freshEntry.entry.outputSha256);
    return {
      source: file.path,
      output: outRel,
      originalSize: originalStats.size,
      compressedSize: compressedStats.size,
      savedBytes: originalStats.size - compressedStats.size
    };
  }

  function dispatchInput(input, value) {
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function clickElement(element) {
    if (typeof element.click === "function") {
      element.click();
      return;
    }
    element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
  }

  function isToggleOn(toggle) {
    if (toggle.classList.contains("is-enabled")) {
      return true;
    }
    const input = toggle.querySelector?.("input[type='checkbox']");
    if (input) {
      return !!input.checked;
    }
    return false;
  }

  function getToggleLabel(toggle) {
    return toggle.closest?.(".setting-item")?.querySelector?.(".setting-item-name")?.textContent?.trim() || "";
  }

  function refindToggleByLabel(label) {
    if (!label) {
      return null;
    }
    const root = app.setting?.activeTab?.containerEl;
    if (!root) {
      return null;
    }
    return Array.from(root.querySelectorAll(".checkbox-container")).find((candidate) => getToggleLabel(candidate) === label) || null;
  }

  async function setToggle(toggle, value) {
    const label = getToggleLabel(toggle);
    let current = toggle;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!current?.isConnected) {
        current = refindToggleByLabel(label) || current;
      }
      if (isToggleOn(current) === value) {
        break;
      }
      clickElement(current);
      await sleep(700);
    }
    if (isToggleOn(current) !== value) {
      const input = current.querySelector?.("input[type='checkbox']");
      if (input) {
        input.checked = value;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        await sleep(700);
      }
    }
    if (isToggleOn(current) !== value) {
      recordWarning("settings.toggleVisualState", {
        label,
        requested: value,
        actual: isToggleOn(current)
      });
    }
  }

  /* RUNTIME_QA_SETTINGS_WAIT_START */
  async function waitForSettingsSurface(tab, requiredSelector = null) {
    const deadline = Date.now() + 5000;
    let previousSignature = "";
    let stableSamples = 0;
    do {
      const root = tab?.containerEl;
      const counts = root ? {
        labels: root.querySelectorAll(".setting-item-name").length,
        buttons: root.querySelectorAll("button").length,
        textInputs: root.querySelectorAll("input[type='text']").length,
        rangeInputs: root.querySelectorAll("input[type='range']").length,
        toggles: root.querySelectorAll(".checkbox-container").length
      } : null;
      const requiredControlReady = !requiredSelector || !!root?.querySelector(requiredSelector);
      const surfaceReady = !!counts
        && counts.labels >= 24
        && counts.buttons >= 8
        && counts.textInputs >= 2
        && counts.rangeInputs >= 5
        && counts.toggles >= 4
        && requiredControlReady;
      const signature = surfaceReady
        ? `${counts.labels}:${counts.buttons}:${counts.textInputs}:${counts.rangeInputs}:${counts.toggles}:${root.childElementCount}:${root.textContent?.length || 0}`
        : "";
      stableSamples = signature && signature === previousSignature ? stableSamples + 1 : 0;
      previousSignature = signature;
      if (stableSamples >= 2) {
        return root;
      }
      await sleep(100);
    } while (Date.now() < deadline);
    assert(false, "Plugin settings render did not reach a stable complete surface", { requiredSelector });
  }
  /* RUNTIME_QA_SETTINGS_WAIT_END */

  async function openSettings(requiredSelector = null) {
    app.setting.open();
    app.setting.openTabById(pluginId);
    let tab = null;
    const deadline = Date.now() + 5000;
    do {
      await sleep(100);
      tab = app.setting.activeTab;
      if (tab?.id === pluginId) {
        break;
      }
      app.setting.openTabById(pluginId);
    } while (Date.now() < deadline);
    assert(tab?.id === pluginId, "Plugin settings tab is not active", { activeId: tab?.id });
    return await waitForSettingsSurface(tab, requiredSelector);
  }

  async function closeTopModal() {
    const doc = app.workspace?.activeDocument || document;
    const closeButton = doc.querySelector(".modal-container .modal-close-button");
    if (closeButton) {
      clickElement(closeButton);
      await sleep(200);
      return;
    }
    doc.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(200);
  }

  async function runCommand(commandId, timeoutMs = 90000) {
    await assertQaRuntimeScope(`before command ${commandId}`);
    const result = app.commands.executeCommandById(`${pluginId}:${commandId}`);
    if (result && typeof result.then === "function") {
      await result;
    }
    await waitForCompressionIdle(timeoutMs);
  }

  async function setupIsolatedState() {
    assert(!await existsRel(qaRoot), "Refusing to adopt an existing runtime QA visible root", { qaRoot });
    await ensureFolder(qaRoot);
    p.statusBarController?.closeMenu?.();
    p.closeManagedModals?.();
    p.settings = {
      ...clone(p.settings),
      pngQuality: { min: 45, max: 60 },
      jpegQuality: 50,
      allowedRoots: [`${qaRoot}/`],
      outputFolder: `${qaRoot}/Compressed`,
      autoCompressNewFiles: false,
      autoBackgroundCompression: false,
      autoBackgroundThreshold: 10,
      inactivityThresholdMinutes: 1,
      autoBackupsRetentionEnabled: false,
      autoBackupsRetentionDays: 7,
      autoMoveCompressedEnabled: false,
      autoMoveCompressedThreshold: 1
    };
    await p.saveSettings();
    await p.cache.clearCache();
    await p.rebuildImageIndex("runtime-qa-start");
    await assertQaRuntimeScope("setupIsolatedState");
    await p.statusBarController.update();
    if (p.newFileQueue) {
      p.newFileQueue.AUTO_COMPRESS_DELAY = 25;
    }
  }

  async function restoreQaDefaults() {
    p.settings = {
      ...clone(p.settings),
      pngQuality: { min: 45, max: 60 },
      jpegQuality: 50,
      allowedRoots: [`${qaRoot}/`],
      outputFolder: `${qaRoot}/Compressed`,
      autoCompressNewFiles: false,
      autoBackgroundCompression: false,
      autoBackgroundThreshold: 10,
      inactivityThresholdMinutes: 1,
      autoBackupsRetentionEnabled: false,
      autoBackupsRetentionDays: 7,
      autoMoveCompressedEnabled: false,
      autoMoveCompressedThreshold: 1
    };
    await p.saveSettings();
    await assertQaRuntimeScope("restoreQaDefaults");
  }

  try {
    await setupIsolatedState();

    await check("runtime: plugin services and commands are loaded", async () => {
      const commandIds = Object.keys(app.commands.commands).filter((id) => id.startsWith(`${pluginId}:`)).sort();
      const expected = [
        `${pluginId}:compress-all-images`,
        `${pluginId}:compress-images-in-folder`,
        `${pluginId}:compress-images-in-note`,
        `${pluginId}:move-compressed-to-files`
      ].sort();
      for (const id of expected) {
        assert(commandIds.includes(id), `Missing command ${id}`, { commandIds });
      }
      assert(!!p.cache && !!p.compressor && !!p.moveService && !!p.statusBarController && !!p.imageScanner, "Core services missing");
      assert(p.imageIndex?.isReady?.() === true, "Image index is not ready");
      return { commandIds };
    });

    await check("runtime: codec readiness and settings application", async () => {
      const binaries = p.compressor.checkBinaries();
      assert(binaries.pngquant === true, "pngquant WASM is not ready", binaries);
      assert(binaries.mozjpeg === true, "mozjpeg WASM is not ready", binaries);
      const pngVersion = await p.getPngCodecVersions?.();
      const jpegVersion = await p.getJpegCodecVersions?.();
      p.applyRuntimeSettings();
      assert(p.pluginGuardService.operationTimeoutMs === 8000, "Internal guard timeout not applied");
      assert(p.compressor.processTimeoutMs === 120000, "Internal compression timeout not applied");
      assert(p.compressor.initTimeoutMs === 60000, "Internal WASM init timeout not applied");
      assert(p.compressor.maxInputBytes === 100 * 1024 * 1024, "Internal input size limit not applied");
      assert(p.compressor.maxImagePixels === 100 * 1000000, "Internal image pixel limit not applied");
      assert(p.backgroundCompressionService.AUTO_BACKGROUND_THRESHOLD === p.settings.autoBackgroundThreshold, "Background threshold not applied");
      return { binaries, pngVersion, jpegVersion };
    });

    await check("settings: DOM surface has every expected control family", async () => {
      const root = await openSettings();
      assert(p.settingsTab === app.setting.activeTab, "Plugin does not own the active settings tab instance");
      assert(p.settingsTab?._isVisible === true, "Plugin-owned settings tab did not record visible state");
      await p.updateSavingsIndicatorInSettings();
      const labels = Array.from(root.querySelectorAll(".setting-item-name")).map((el) => el.textContent.trim()).filter(Boolean);
      const buttons = Array.from(root.querySelectorAll("button"));
      const textInputs = Array.from(root.querySelectorAll("input[type='text']"));
      const rangeInputs = Array.from(root.querySelectorAll("input[type='range']"));
      const toggles = Array.from(root.querySelectorAll(".checkbox-container"));
      const dropdowns = Array.from(root.querySelectorAll("select"));
      report.metrics.settingsLabels = labels;
      assert(labels.length >= 24, "Settings labels count is too low", { count: labels.length, labels });
      assert(buttons.length >= 8, "Settings buttons count is too low", { count: buttons.length, texts: buttons.map((button) => button.textContent.trim()) });
      assert(textInputs.length >= 2, "Expected PNG and output-folder text inputs", { count: textInputs.length });
      assert(rangeInputs.length >= 5, "Expected all remaining settings sliders", { count: rangeInputs.length });
      assert(toggles.length >= 4, "Expected all settings toggles", { count: toggles.length });
      assert(dropdowns.length >= 0, "Dropdown query failed");
      const savingsTarget = root.querySelector(".tiny-local-savings-tooltip-target");
      if (savingsTarget) {
        assert(savingsTarget.getAttribute("role") === "group", "Savings tooltip target is missing group semantics");
        assert(savingsTarget.getAttribute("tabindex") === "0", "Savings tooltip target is not keyboard focusable");
        assert(!!savingsTarget.getAttribute("aria-label"), "Savings tooltip target is missing an accessible summary");
        savingsTarget.focus();
        await sleep(100);
        const tooltip = document.querySelector(".tiny-local-savings-tooltip");
        assert(tooltip?.getAttribute("role") === "tooltip", "Savings tooltip did not open from keyboard focus");
        const tooltipWrapper = document.querySelector(".tiny-local-savings-tooltip-wrapper");
        assert(!!tooltipWrapper?.style.getPropertyValue("--local-image-compress-savings-tooltip-arrow-x"), "Savings tooltip did not calculate arrow position");
        const targetRect = savingsTarget.getBoundingClientRect();
        const tooltipRect = tooltip.getBoundingClientRect();
        if (tooltipRect.bottom <= targetRect.top) {
          assert(tooltip.classList.contains("tiny-local-savings-tooltip-placement-above"), "Savings tooltip arrow is not attached to the bottom edge for above-target placement");
        } else if (tooltipRect.top >= targetRect.bottom) {
          assert(tooltip.classList.contains("tiny-local-savings-tooltip-placement-below"), "Savings tooltip arrow is not attached to the top edge for below-target placement");
        } else {
          assert(tooltip.classList.contains("tiny-local-savings-tooltip-placement-above") || tooltip.classList.contains("tiny-local-savings-tooltip-placement-below"), "Savings tooltip is missing a placement class");
        }
        savingsTarget.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
        await sleep(100);
        assert(!document.querySelector(".tiny-local-savings-tooltip"), "Savings tooltip did not close from Escape");
      }
      return {
        labelCount: labels.length,
        buttonCount: buttons.length,
        textInputCount: textInputs.length,
        rangeInputCount: rangeInputs.length,
        toggleCount: toggles.length,
        dropdownCount: dropdowns.length,
        keyboardTooltip: !!savingsTarget
      };
    });

    await check("localization: selected language reaches commands and settings", async () => {
      const expectedLocale = p.constructor.currentLang;
      const expected = {
        en: { command: "Compress all images in note", setting: "PNG quality (min-max)" },
        ru: { command: "Сжать все изображения в заметке", setting: "Качество PNG (мин-макс)" },
        uk: { command: "Стиснути всі зображення в нотатці", setting: "Якість PNG (мін-макс)" }
      }[expectedLocale];
      assert(expected, "Plugin selected an unsupported built-in language", { expectedLocale });
      const command = app.commands.commands[`${pluginId}:compress-images-in-note`];
      const root = await openSettings();
      const labels = Array.from(root.querySelectorAll(".setting-item-name")).map((el) => el.textContent.trim());
      assert(command?.name?.endsWith(expected.command), "Registered command is not localized", { command: command?.name, expected });
      assert(labels.includes(expected.setting), "Settings DOM is not localized", { expected: expected.setting, labels });
      return { locale: expectedLocale, command: command.name, setting: expected.setting };
    });

    await check("accessibility: theme variables, motion overrides, and popout ownership", async () => {
      const mainDocument = document;
      const root = await openSettings();
      const settingsDocument = root.doc || root.ownerDocument;
      const settingsWindow = settingsDocument?.defaultView;
      assert(!!settingsDocument && !!settingsWindow, "Plugin settings UI has no owning document or window");
      const themeBody = settingsDocument.body;
      const originalThemeClasses = {
        light: themeBody.classList.contains("theme-light"),
        dark: themeBody.classList.contains("theme-dark")
      };
      const originallyMobile = mainDocument.body.classList.contains("is-mobile");
      let mobileTouchProbe = null;
      const sample = root.querySelector(".tiny-local-savings-indicator") || (root.matches(".tiny-local-settings") ? root : null);
      assert(!!sample, "No plugin UI sample available for theme verification");
      const readTheme = (themeClass) => {
        themeBody.classList.remove("theme-light", "theme-dark");
        themeBody.classList.add(themeClass);
        const style = settingsWindow.getComputedStyle(sample);
        return {
          color: style.color,
          backgroundColor: style.backgroundColor,
          borderColor: style.borderColor
        };
      };
      let popoutLeaf = null;
      try {
        const light = readTheme("theme-light");
        const dark = readTheme("theme-dark");
        for (const [theme, values] of Object.entries({ light, dark })) {
          assert(Object.values(values).every((value) => value && !value.includes("var(")), `Theme ${theme} left unresolved plugin colors`, values);
        }

        const mediaRules = [];
        for (const sheet of Array.from(settingsDocument.styleSheets)) {
          let rules = [];
          try {
            rules = Array.from(sheet.cssRules || []);
          } catch {
            continue;
          }
          for (const rule of rules) {
            if (typeof rule.conditionText === "string") {
              mediaRules.push({ condition: rule.conditionText, cssText: rule.cssText, rule });
            }
          }
        }
        const reducedMotion = mediaRules.find((rule) => rule.condition.includes("prefers-reduced-motion") && rule.cssText.includes(".tiny-local-"));
        const highContrast = mediaRules.find((rule) => rule.condition.includes("prefers-contrast") && rule.cssText.includes(".tiny-local-"));
        const reducedMotionRules = Array.from(reducedMotion?.rule.cssRules || []);
        const disablesTransitions = reducedMotionRules.some((rule) => rule.style?.transitionProperty === "none");
        const disablesAnimations = reducedMotionRules.some((rule) => rule.style?.animationName === "none");
        assert(disablesTransitions && disablesAnimations, "Loaded CSS is missing reduced-motion overrides");
        assert(!!highContrast, "Loaded CSS is missing high-contrast overrides");

        popoutLeaf = app.workspace.openPopoutLeaf();
        await sleep(500);
        const popoutContainer = popoutLeaf?.view?.containerEl;
        const popoutDocument = popoutContainer?.doc || popoutContainer?.ownerDocument;
        assert(popoutContainer && popoutDocument && popoutDocument !== mainDocument, "Obsidian popout leaf did not expose a distinct document");
        const popoutWindow = popoutDocument.defaultView;
        assert(!!popoutWindow, "Obsidian popout document did not expose its owning window");
        let cancelledPopoutTimerFired = false;
        const popoutTimer = p.settingsTab.setWindowTimeout(() => {
          cancelledPopoutTimerFired = true;
        }, 100, popoutWindow);
        p.settingsTab.clearWindowTimeout(popoutTimer, popoutWindow);
        await sleep(150);
        assert(!cancelledPopoutTimerFired, "Settings timer was not cancelled through its owning popout window");
        const popoutTarget = popoutContainer.createDiv({ cls: "tiny-local-runtime-popout-tooltip-probe" });
        const savings = (await p.getStatsSnapshot()).savings;
        p.settingsTab.createSavingsTooltip(popoutTarget, savings);
        popoutTarget.focus();
        await sleep(150);
        assert(!!popoutDocument.querySelector(".tiny-local-savings-tooltip"), "Savings tooltip did not render in its owning popout document");
        assert(!mainDocument.querySelector(".tiny-local-savings-tooltip"), "Popout savings tooltip leaked into the main document");
        p.settingsTab.cleanupSavingsTooltips();
        popoutTarget.remove();

        mainDocument.body.classList.add("is-mobile");
        mobileTouchProbe = mainDocument.createElement("div");
        mobileTouchProbe.classList.add("tiny-local-status-menu");
        const mobileTouchItem = mainDocument.createElement("button");
        mobileTouchItem.classList.add("tiny-local-status-menu-item");
        mobileTouchProbe.appendChild(mobileTouchItem);
        mainDocument.body.appendChild(mobileTouchProbe);
        const mainWindow = mainDocument.defaultView || window;
        const mobileTouchMinHeight = Number.parseFloat(mainWindow.getComputedStyle(mobileTouchItem).minHeight);
        assert(mobileTouchMinHeight >= 44, "Mobile status menu touch target is below 44px", { mobileTouchMinHeight });

        return { light, dark, reducedMotion: true, highContrast: true, popoutOwned: true, popoutTimerOwned: true, mobileTouchMinHeight };
      } finally {
        themeBody.classList.remove("theme-light", "theme-dark");
        if (originalThemeClasses.light) themeBody.classList.add("theme-light");
        if (originalThemeClasses.dark) themeBody.classList.add("theme-dark");
        mobileTouchProbe?.remove?.();
        if (!originallyMobile) mainDocument.body.classList.remove("is-mobile");
        p.settingsTab.cleanupSavingsTooltips();
        popoutLeaf?.detach?.();
      }
    });

    await check("settings: text inputs and sliders update runtime settings", async () => {
      try {
        const root = await openSettings();
        const textInputs = Array.from(root.querySelectorAll("input[type='text']"));
        const rangeInputs = Array.from(root.querySelectorAll("input[type='range']"));
        assert(textInputs.length >= 2 && rangeInputs.length >= 5, "Settings controls missing");

        dispatchInput(textInputs[0], "42-58");
        assert(p.settings.pngQuality.min === 42 && p.settings.pngQuality.max === 58, "PNG quality text input did not update settings", p.settings.pngQuality);
        const oldOutput = p.settings.outputFolder;
        dispatchInput(textInputs[1], "../bad-output");
        await sleep(100);
        assert(p.settings.outputFolder === oldOutput, "Invalid output folder was accepted", { oldOutput, current: p.settings.outputFolder });
        dispatchInput(textInputs[1], `${qaRoot}/Compressed`);
        assert(p.settings.outputFolder === `${qaRoot}/Compressed`, "Output folder text input did not update settings", p.settings.outputFolder);

        const sliderAssertions = [
          [0, 55, () => p.settings.jpegQuality === 55, "jpegQuality"],
          [1, 20, () => p.settings.autoBackgroundThreshold === 20 && p.backgroundCompressionService.AUTO_BACKGROUND_THRESHOLD === 20, "autoBackgroundThreshold"],
          [2, 3, () => p.settings.inactivityThresholdMinutes === 3 && p.backgroundCompressionService.USER_INACTIVITY_THRESHOLD === 180000, "inactivityThresholdMinutes"],
          [3, 9, () => p.settings.autoBackupsRetentionDays === 9, "autoBackupsRetentionDays"],
          [4, 2, () => p.settings.autoMoveCompressedThreshold === 2, "autoMoveCompressedThreshold"]
        ];
        for (const [index, value, predicate, key] of sliderAssertions) {
          dispatchInput(rangeInputs[index], value);
          await sleep(80);
          assert(predicate(), `Slider did not update ${key}`, { key, value, current: p.settings[key] });
        }

        await sleep(800);
        return {
          pngQuality: clone(p.settings.pngQuality),
          outputFolder: p.settings.outputFolder,
          slidersTested: sliderAssertions.length
        };
      } finally {
        await restoreQaDefaults();
      }
    });

    await check("settings: toggles update runtime settings", async () => {
      await restoreQaDefaults();
      try {
        const root = await openSettings();
        const freshToggles = Array.from(root.querySelectorAll(".checkbox-container"));
        assert(freshToggles.length >= 4, "Settings toggles missing", { count: freshToggles.length });
        await setToggle(freshToggles[0], true);
        assert(p.settings.autoCompressNewFiles === true, "autoCompressNewFiles toggle did not update");
        await setToggle(freshToggles[1], true);
        assert(p.settings.autoBackgroundCompression === true, "background toggle did not update");
        await setToggle(freshToggles[2], true);
        assert(p.settings.autoBackupsRetentionEnabled === true, "retention toggle did not update");
        await setToggle(freshToggles[3], true);
        assert(p.settings.autoMoveCompressedEnabled === true, "auto-move toggle did not update");
        await sleep(650);
        return {
          togglesTested: 4
        };
      } finally {
        await restoreQaDefaults();
      }
    });

    await check("settings: allowed roots add modal and clear icon work", async () => {
      try {
        p.settings.allowedRoots = [`${qaRoot}/`];
        await p.saveSettings();
        let root = await openSettings();
        let buttons = Array.from(root.querySelectorAll("button"));
        const rootPill = root.querySelector(".tiny-local-roots-pill");
        assert(rootPill?.tagName === "BUTTON" && !!rootPill.getAttribute("aria-label"), "Allowed-root removal pill is not an accessible button");
        const addButton = buttons.find((button) => !button.classList.contains("tiny-local-roots-pill"));
        assert(!!addButton, "Allowed-roots Add button missing");
        clickElement(addButton);
        await sleep(300);
        assert(!!document.querySelector(".modal-container .modal"), "Allowed-roots modal did not open");
        await closeTopModal();
        root = await openSettings();
        const clearIcon = root.querySelector(".tiny-local-roots-clear");
        assert(!!clearIcon, "Allowed-roots clear icon missing");
        clickElement(clearIcon);
        await sleep(400);
        assert(Array.isArray(p.settings.allowedRoots) && p.settings.allowedRoots.length === 0, "Allowed roots were not cleared", p.settings.allowedRoots);
        return { modalOpened: true, clearWorked: true };
      } finally {
        await restoreQaDefaults();
      }
    });

    await check("settings: cache restore dropdown is populated and dispatches restore", async () => {
      const markerMtime = Date.now();
      const markerKey = p.cache.buildCacheKey(`${qaRoot}/restore-marker.jpg`, "restore-marker", markerMtime);
      p.cache.cacheData.entries[markerKey] = {
        path: `${qaRoot}/restore-marker.jpg`,
        md5: "restore-marker",
        mtime: markerMtime,
        timestamp: markerMtime,
        lastAccessMs: markerMtime,
        state: "processed",
        originalSize: 123,
        sourceMtime: markerMtime,
        sourceSize: 123
      };
      const vaultTrashCallsBeforeSave = vaultTrashCallCount;
      await p.cache.saveCache({ mergeDiskEntries: false, authoritative: true });
      assert(
        vaultTrashCallCount === vaultTrashCallsBeforeSave,
        "Successful cache save added internal transaction files to the user-visible Vault trash"
      );
      await p.cache.createBackup();
      const backups = await p.cache.getAvailableBackups();
      assert(backups.length > 0, "No cache backups available after createBackup");
      const targetBackup = backups[0];
      const originalRestore = p.cache.restoreFromBackup.bind(p.cache);
      let restoredValue = null;
      p.cache.restoreFromBackup = async (value) => {
        restoredValue = value;
        return true;
      };
      try {
        const root = await openSettings("select");
        const select = root.querySelector("select");
        assert(!!select, "Cache restore dropdown missing");
        assert(Array.from(select.options).some((option) => option.value === targetBackup), "Created backup is missing from dropdown", { targetBackup });
        select.value = targetBackup;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        await sleep(600);
        assert(restoredValue === targetBackup, "Dropdown did not dispatch restoreFromBackup", { restoredValue, targetBackup });
      } finally {
        p.cache.restoreFromBackup = originalRestore;
      }
      return { backupCount: backups.length, targetBackup };
    });

    await check("settings: all action buttons dispatch their intended operations", async () => {
      const calls = {
        refresh: 0,
        clearCache: 0,
        rebuildIndex: 0,
        statusUpdate: 0,
        move: 0,
        clearBackups: 0,
        openPath: [],
        showBackupsList: 0
      };
      const originals = {
        forceRefreshCache: p.forceRefreshCache,
        clearCache: p.cache.clearCache,
        rebuildImageIndex: p.rebuildImageIndex,
        statusUpdate: p.statusBarController.update,
        moveCompressedToFiles: p.moveService.moveCompressedToFiles,
        clearOriginalFilesBackups: p.clearOriginalFilesBackups,
        showCacheBackupsList: p.showCacheBackupsList,
        openPath: electron.shell.openPath
      };
      p.forceRefreshCache = async () => { calls.refresh++; };
      p.cache.clearCache = async () => { calls.clearCache++; };
      p.rebuildImageIndex = async () => { calls.rebuildIndex++; };
      p.statusBarController.update = async () => { calls.statusUpdate++; };
      p.moveService.moveCompressedToFiles = async () => { calls.move++; };
      p.clearOriginalFilesBackups = async () => { calls.clearBackups++; };
      p.showCacheBackupsList = async () => { calls.showBackupsList++; };
      electron.shell.openPath = async (targetPath) => {
        calls.openPath.push(targetPath);
        return "";
      };
      try {
        const root = await openSettings();
        const buttons = Array.from(root.querySelectorAll("button"))
          .filter((button) => !button.classList.contains("tiny-local-roots-pill"));
        assert(buttons.length >= 8, "Expected at least 8 settings buttons", { count: buttons.length, texts: buttons.map((button) => button.textContent.trim()) });
        const buttonIndexes = {
          refreshUncompressed: 1,
          clearCache: 2,
          refreshCache: 3,
          moveCompressed: 4,
          clearImageBackups: 5,
          openImageBackups: 6,
          openCacheBackups: 7
        };
        for (const index of Object.values(buttonIndexes)) {
          assert(buttons[index], `Missing button index ${index}`, { count: buttons.length });
          clickElement(buttons[index]);
          await sleep(450);
        }
        assert(calls.refresh === 2, "Refresh buttons did not dispatch forceRefreshCache twice", calls);
        assert(calls.clearCache === 1, "Clear cache button did not dispatch", calls);
        assert(calls.move === 1, "Move button did not dispatch", calls);
        assert(calls.clearBackups === 1, "Clear image backups button did not dispatch", calls);
        assert(calls.openPath.length === 1, "Open image backups button did not open path", calls);
        assert(calls.showBackupsList === 1, "Open cache backups button did not dispatch", calls);
      } finally {
        p.forceRefreshCache = originals.forceRefreshCache;
        p.cache.clearCache = originals.clearCache;
        p.rebuildImageIndex = originals.rebuildImageIndex;
        p.statusBarController.update = originals.statusUpdate;
        p.moveService.moveCompressedToFiles = originals.moveCompressedToFiles;
        p.clearOriginalFilesBackups = originals.clearOriginalFilesBackups;
        p.showCacheBackupsList = originals.showCacheBackupsList;
        electron.shell.openPath = originals.openPath;
        await restoreQaDefaults();
        await p.cache.saveCache({ mergeDiskEntries: false, authoritative: true });
        await p.rebuildImageIndex("runtime-qa-after-button-wiring");
        await p.statusBarController.update();
      }
      return calls;
    });

    await check("cache: clear, compaction, backup, and restore work", async () => {
      await p.cache.clearCache();
      assert(p.cache.getCacheStats().total === 0, "clearCache did not empty cache", p.cache.getCacheStats());
      const tiny = await createSmallJpeg(`${qaRoot}/Cache/tiny-too-small.jpg`);
      await p.compressFile(tiny);
      await waitForCompressionIdle();
      let fresh = await p.cache.getFreshEntryForFile(tiny);
      assert(fresh?.entry?.state === "skipped" && fresh.entry.skipReason === "too_small", "Too-small image was not cached as skipped", fresh?.entry);
      const legacySource = await createSmallJpeg(`${qaRoot}/Cache/legacy-source.jpg`);

      const missingMtime = Date.now();
      const missingModernKey = p.cache.buildCacheKey(`${qaRoot}/Cache/missing.jpg`, "missing-modern", missingMtime);
      const missingLegacyKey = `legacy:${qaRoot}/Cache/missing-legacy.jpg`;
      const existingLegacyKey = `legacy:${legacySource.path}`;
      const staleKey = p.cache.buildCacheKey(tiny.path, "stale-modern", Math.max(1, tiny.stat.mtime - 1));
      p.cache.cacheData.entries[missingModernKey] = {
        path: `${qaRoot}/Cache/missing.jpg`,
        md5: "missing-modern",
        mtime: missingMtime,
        timestamp: missingMtime,
        state: "skipped",
        originalSize: 100,
        sourceMtime: missingMtime,
        sourceSize: 100
      };
      p.cache.cacheData.entries[missingLegacyKey] = {
        path: `${qaRoot}/Cache/missing-legacy.jpg`,
        state: "processed",
        timestamp: 1
      };
      p.cache.cacheData.entries[existingLegacyKey] = {
        path: legacySource.path,
        state: "processed",
        originalSize: legacySource.stat.size,
        timestamp: 1
      };
      p.cache.cacheData.entries[staleKey] = {
        path: tiny.path,
        md5: "stale-modern",
        state: "skipped",
        sourceMtime: Math.max(1, tiny.stat.mtime - 1),
        sourceSize: tiny.stat.size + 1,
        timestamp: 1
      };
      await p.cache.saveCache({ mergeDiskEntries: false, authoritative: true });
      const compacted = await p.cache.compactCache();
      assert(compacted.missingFilesRemoved === 1 && compacted.supersededRemoved === 1, "Cache compaction returned wrong result", compacted);
      assert(!p.cache.cacheData.entries[missingModernKey] && !p.cache.cacheData.entries[staleKey], "Cache compaction kept removable modern entries", compacted);
      assert(!!p.cache.cacheData.entries[missingLegacyKey] && !!p.cache.cacheData.entries[fresh.cacheKey], "Cache compaction removed legacy or current entries", compacted);
      assert(!!p.cache.cacheData.entries[existingLegacyKey] && await p.cache.getFreshEntryForFile(legacySource) === null, "Existing legacy cache entry was deleted or still treated as processed");

      const markerMtime = Date.now();
      const markerKey = p.cache.buildCacheKey(`${qaRoot}/Cache/backup-marker.jpg`, "backup-marker", markerMtime);
      p.cache.cacheData.entries[markerKey] = {
        path: `${qaRoot}/Cache/backup-marker.jpg`,
        md5: "backup-marker",
        mtime: markerMtime,
        timestamp: markerMtime,
        lastAccessMs: markerMtime,
        state: "processed",
        originalSize: 456,
        sourceMtime: markerMtime,
        sourceSize: 456
      };
      await p.cache.saveCache({ mergeDiskEntries: false, authoritative: true });
      await p.cache.createBackup();
      const backups = await p.cache.getAvailableBackups();
      assert(backups.length > 0, "Cache backup list is empty");
      for (const backupName of backups) {
        const backupAbsolutePath = path.resolve(absolute(joinVault(p.cache.cacheBackupsDir, backupName)));
        const expectedSha256 = expectedCacheBackupFiles.get(backupAbsolutePath);
        assert(typeof expectedSha256 === "string", "Cache backup has no exact creation proof", { backupName });
        ownership.recordFileWithExpectedSha256Sync(backupAbsolutePath, expectedSha256);
      }
      const targetBackup = backups[0];
      delete p.cache.cacheData.entries[markerKey];
      await p.cache.saveCache({ mergeDiskEntries: false, authoritative: true });
      const restored = await p.cache.restoreFromBackup(targetBackup);
      assert(restored === true, "restoreFromBackup returned false", { targetBackup });
      assert(!!p.cache.cacheData.entries[markerKey], "Cache backup did not restore marker entry", { targetBackup });
      assert(p.cache.isValidBackupFileName("../bad.json") === false, "Invalid backup filename was accepted");
      return { compacted, backupCount: backups.length, targetBackup };
    });

    await check("compression: direct JPG, JPEG, and PNG produce smaller outputs and pending cache entries", async () => {
      await p.cache.clearCache();
      await p.rebuildImageIndex("runtime-qa-compression-start");
      const jpg = await createImage(`${qaRoot}/Direct/direct-jpg.jpg`, "jpg", 1);
      const jpeg = await createImage(`${qaRoot}/Direct/direct-jpeg.jpeg`, "jpg", 2);
      const png = await createImage(`${qaRoot}/Direct/direct-png.png`, "png", 3);
      await p.compressFile(jpg);
      const jpgResult = await assertCompressed(jpg, "direct jpg");
      await p.compressFile(jpeg);
      const jpegResult = await assertCompressed(jpeg, "direct jpeg");
	      await p.compressFile(png);
	      const pngResult = await assertCompressed(png, "direct png");
	      const repeatedJpg = await p.compressor.compress(jpg, p.settings);
	      assert(repeatedJpg.success === true, "Repeated compression could not replace the existing output", repeatedJpg);
	      await p.handleSuccessfulCompression(jpg, repeatedJpg);
      ownership.recordFileWithExpectedSha256Sync(outputAbsFor(jpg.path), repeatedJpg.artifact.outputSha256);
	      const repeatedJpgStats = await statRel(outputRelFor(jpg.path));
	      assert(repeatedJpgStats.size > 0 && repeatedJpgStats.size < jpgResult.originalSize, "Repeated compression produced an invalid output", repeatedJpgStats);
	      const validation = await p.validateFileForCompression(jpg);
      assert(validation.valid === false, "Already-compressed file was still valid for compression", validation);
	      return { jpgResult, jpegResult, pngResult, repeatedJpgSize: repeatedJpgStats.size, alreadyCompressedValidation: validation };
    });

    await check("compression: file context menu action compresses selected image", async () => {
      const file = await createImage(`${qaRoot}/Context/File/context-file.jpg`, "jpg", 4);
      const items = [];
      const menu = {
        addItem(callback) {
          const item = {
            title: "",
            icon: "",
            callback: null,
            setTitle(value) { this.title = value; return this; },
            setIcon(value) { this.icon = value; return this; },
            onClick(value) { this.callback = value; return this; }
          };
          callback(item);
          items.push(item);
        }
      };
      p.addContextMenu(menu, file);
      assert(items.length === 1 && typeof items[0].callback === "function", "File context menu item missing", items);
      await items[0].callback();
      return await assertCompressed(file, "file context menu");
    });

    await check("compression: folder context menu action compresses images in the folder", async () => {
      const file = await createImage(`${qaRoot}/Context/Folder/context-folder.jpg`, "jpg", 5);
      const folder = app.vault.getAbstractFileByPath(`${qaRoot}/Context/Folder`);
      const items = [];
      const menu = {
        addItem(callback) {
          const item = {
            title: "",
            icon: "",
            callback: null,
            setTitle(value) { this.title = value; return this; },
            setIcon(value) { this.icon = value; return this; },
            onClick(value) { this.callback = value; return this; }
          };
          callback(item);
          items.push(item);
        }
      };
      p.addFolderContextMenu(menu, folder);
      assert(items.length === 1 && typeof items[0].callback === "function", "Folder context menu item missing", items);
      await items[0].callback();
      return await assertCompressed(file, "folder context menu");
    });

    await check("commands: compress images in active note", async () => {
      const noteImageA = await createImage(`${qaRoot}/Note/note-a.jpg`, "jpg", 6);
      const noteImageB = await createImage(`${qaRoot}/Note/note-b.png`, "png", 7);
      const note = await createTextFile(`${qaRoot}/Note/note.md`, `# Runtime QA\n\n![[${noteImageA.path}]]\n\n![[${noteImageB.path}]]\n`);
      await app.workspace.getLeaf(false).openFile(note);
      await sleep(1200);
      const discovered = await p.imageScanner.getImagesInNote(note);
      assert(discovered.some((file) => file.path === noteImageA.path), "Image scanner did not find note JPG", discovered.map((file) => file.path));
      assert(discovered.some((file) => file.path === noteImageB.path), "Image scanner did not find note PNG", discovered.map((file) => file.path));
      await runCommand("compress-images-in-note");
      const a = await assertCompressed(noteImageA, "command note jpg");
      const b = await assertCompressed(noteImageB, "command note png");
      return { discovered: discovered.map((file) => file.path), outputs: [a, b] };
    });

    await check("commands: compress images in selected folder", async () => {
      const file = await createImage(`${qaRoot}/FolderCommand/folder-command.jpg`, "jpg", 8);
      const originalSelector = p.showFolderSelector;
      p.showFolderSelector = async () => `${qaRoot}/FolderCommand`;
      try {
        await runCommand("compress-images-in-folder");
      } finally {
        p.showFolderSelector = originalSelector;
      }
      return await assertCompressed(file, "command folder");
    });

    await check("folder selector: cancel, select, and managed close clean up", async () => {
      const folderChoices = ["/", `${qaRoot}/FolderCommand`];
      app.setting?.close?.();
      p.closeManagedModals();
      await sleep(200);
      assert(p.settingsTab?._isVisible === false, "Plugin-owned settings tab remained visible before standalone modal QA");
      assert(p.managedModals.size === 0, "A prior managed modal remained open before standalone modal QA");
      const focusReturnProbe = document.body.createEl("button", { text: "Runtime QA modal trigger" });
      focusReturnProbe.type = "button";
      focusReturnProbe.focus();
      assert(document.activeElement === focusReturnProbe, "Runtime modal trigger could not receive focus before opening the folder selector");
      try {
        const cancelPromise = p.showFolderSelector(folderChoices);
        await sleep(250);
        let select = document.querySelector(".tiny-local-folder-select-control");
        assert(!!select, "Folder selector did not render a select control for cancel path");
        assert(select.getAttribute("aria-label"), "Folder selector select is missing aria-label");
        assert(document.activeElement === select, "Folder selector did not focus its first actionable control");
        clickElement(document.querySelector("#cancel-folder"));
        const cancelResult = await cancelPromise;
        assert(cancelResult === null, "Folder selector cancel did not resolve null", { cancelResult });
        await sleep(150);
        assert(!document.querySelector(".tiny-local-folder-select-control"), "Folder selector DOM remained after cancel");
        assert(document.activeElement === focusReturnProbe, "Folder selector did not return focus to its trigger");

        const selectPromise = p.showFolderSelector(folderChoices);
        await sleep(250);
        select = document.querySelector(".tiny-local-folder-select-control");
        assert(!!select, "Folder selector did not render a select control for selection path");
        select.value = `${qaRoot}/FolderCommand`;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        clickElement(document.querySelector("#select-folder"));
        const selectedResult = await selectPromise;
        assert(selectedResult === `${qaRoot}/FolderCommand`, "Folder selector returned the wrong selected folder", { selectedResult });
        await sleep(150);
        assert(!document.querySelector(".tiny-local-folder-select-control"), "Folder selector DOM remained after selection");

        const cleanupPromise = p.showFolderSelector(folderChoices);
        await sleep(250);
        assert(!!document.querySelector(".tiny-local-folder-select-control"), "Folder selector did not render before managed close");
        p.closeManagedModals();
        const cleanupResult = await cleanupPromise;
        assert(cleanupResult === null, "Managed modal cleanup did not resolve folder selector with null", { cleanupResult });
        await sleep(150);
        assert(!document.querySelector(".tiny-local-folder-select-control"), "Folder selector DOM remained after managed close");

        const moveProgressModal = p.moveService.showMoveProgressModal(1);
        assert(p.managedModals.has(moveProgressModal), "Move progress modal was not tracked");
        const moveProgressBar = moveProgressModal.contentEl.querySelector('[role="progressbar"]');
        const moveProgressStatus = moveProgressModal.contentEl.querySelector('[role="status"]');
        assert(moveProgressBar?.getAttribute("aria-valuemin") === "0" && moveProgressBar?.getAttribute("aria-valuemax") === "1", "Move progress modal is missing bounded ARIA values");
        assert(moveProgressStatus?.getAttribute("aria-live") === "polite", "Move progress modal is missing polite status announcements");
        p.closeManagedModals();
        assert(!p.managedModals.has(moveProgressModal), "Move progress modal remained tracked after cleanup");
        await sleep(100);
        assert(!document.querySelector(".tiny-local-move-progress-modal"), "Move progress modal DOM remained after managed close");

        return { cancelResult, selectedResult, cleanupResult, initialFocus: true, focusReturned: true, moveProgressCleaned: true };
      } finally {
        p.closeManagedModals();
        focusReturnProbe.remove();
      }
    });

    await check("commands: compress all images respects allowed roots and output folder exclusion", async () => {
      const file = await createImage(`${qaRoot}/All/all-command.jpg`, "jpg", 9);
      await runCommand("compress-all-images", 120000);
      const result = await assertCompressed(file, "command all");
      const outputFiles = app.vault.getFiles().filter((candidate) => candidate.path.startsWith(`${qaRoot}/Compressed/`));
      const uncompressed = await p.getImageFiles();
      assert(!uncompressed.some((candidate) => candidate.path.startsWith(`${qaRoot}/Compressed/`)), "Output folder files are treated as compression inputs", {
        outputFiles: outputFiles.map((candidate) => candidate.path),
        uncompressed: uncompressed.map((candidate) => candidate.path)
      });
      return { result, outputVaultFilesSeen: outputFiles.length };
    });

    await check("compression: background batch compression works without modal workflow", async () => {
      const file = await createImage(`${qaRoot}/Background/background.jpg`, "jpg", 10);
      await p.processBatchCompressionBackground([file]);
      return await assertCompressed(file, "background batch");
    });

    await check("compression: new-file auto compression queue drains and compresses", async () => {
      try {
        p.settings.autoCompressNewFiles = true;
        await p.saveSettings();
        const file = await createImage(`${qaRoot}/Auto/auto-new-file.jpg`, "jpg", 11);
        await p.handleNewFile(file);
        await sleep(100);
        await p.drainNewFileCompressionBatch();
        return await assertCompressed(file, "auto new file");
      } finally {
        await restoreQaDefaults();
      }
    });

    await check("validation: unsupported and too-small files are rejected safely", async () => {
      const textFile = await createTextFile(`${qaRoot}/Validation/not-image.txt`, "not an image");
      const unsupported = await p.validateFileForCompression(textFile);
      assert(unsupported.valid === false, "Unsupported text file was accepted", unsupported);
      const small = await createSmallJpeg(`${qaRoot}/Validation/small.jpg`);
      const tooSmall = await p.validateFileForCompression(small);
      assert(tooSmall.valid === false && tooSmall.skipped === true, "Too-small image was not rejected as skipped", tooSmall);
      const fresh = await p.cache.getFreshEntryForFile(small);
      assert(fresh?.entry?.skipReason === "too_small", "Too-small validation did not write cache skip entry", fresh?.entry);
      return { unsupported, tooSmall, skipEntry: fresh.entry };
    });

    await check("status bar: text, aria label, attention state, and menu buttons work", async () => {
      app.setting?.close?.();
      await sleep(200);
      assert(p.settingsTab?._isVisible === false, "Plugin-owned settings tab remained visible after settings close");
      await p.statusBarController.update();
      const statusText = p.statusBarItem?.getText?.() || p.statusBarItem?.textContent || "";
      const aria = p.statusBarItem?.getAttribute?.("aria-label") || "";
      assert(statusText.includes("/"), "Status bar text does not contain counts", { statusText, aria });
      assert(aria.includes(statusText.trim()), "Status bar aria-label does not include status text", { statusText, aria });
      assert(!p.statusBarItem?.getAttribute?.("title"), "Status bar item has a native title tooltip that can overlap Obsidian's tooltip", {
        title: p.statusBarItem?.getAttribute?.("title")
      });
      assert(p.statusBarItem?.getAttribute?.("role") === "button", "Status bar item is missing role=button");
      assert(p.statusBarItem?.getAttribute?.("tabindex") === "0", "Status bar item is missing tabindex=0");
      assert(p.statusBarItem?.getAttribute?.("aria-haspopup") === "menu", "Status bar item is missing aria-haspopup=menu");

      const originalNote = p.compressImagesInNote;
      const originalAll = p.compressAllImages;
      const originalMove = p.moveService.moveCompressedToFiles;
      const originalCount = p.moveService.getCompressedFilesCount;
      const calls = { note: 0, all: 0, move: 0 };
      p.compressImagesInNote = async () => { calls.note++; };
      p.compressAllImages = async () => { calls.all++; };
      p.moveService.moveCompressedToFiles = async () => { calls.move++; };
      p.moveService.getCompressedFilesCount = async () => 1;
      try {
        const fakeEvent = {
          target: {
            getBoundingClientRect: () => ({ left: 80, top: 700, bottom: 720, width: 140, height: 22 })
          }
        };
        for (const [index, key] of [[0, "note"], [1, "all"], [2, "move"]]) {
          await p.statusBarController.showMenu(fakeEvent);
          const menu = document.querySelector(".tiny-local-status-menu");
          assert(!!menu, "Status menu did not open");
          const menuWindow = menu.ownerDocument?.defaultView || window;
          const immediateStyle = menuWindow.getComputedStyle(menu);
          const immediateRect = menu.getBoundingClientRect();
          const expectedLeft = Number.parseFloat(immediateStyle.getPropertyValue("--local-image-compress-status-menu-left"));
          const expectedTop = Number.parseFloat(immediateStyle.getPropertyValue("--local-image-compress-status-menu-top"));
          const transitionProperties = immediateStyle.transitionProperty
            .split(",")
            .map((property) => property.trim().toLowerCase());
          const transitionDurationsMs = immediateStyle.transitionDuration
            .split(",")
            .map((duration) => {
              const trimmed = duration.trim().toLowerCase();
              const numeric = Number.parseFloat(trimmed);
              return trimmed.endsWith("ms") ? numeric : numeric * 1000;
            });
          const hasAnimatedPositionTransition = transitionProperties.some((property, propertyIndex) => {
            const durationMs = transitionDurationsMs[propertyIndex % transitionDurationsMs.length] || 0;
            return durationMs > 0 && (property === "all" || property === "left" || property === "top" || property === "transform");
          });
          assert(
            !hasAnimatedPositionTransition,
            "Status menu still transitions dynamic position properties",
            { transitionProperty: immediateStyle.transitionProperty, transitionDuration: immediateStyle.transitionDuration }
          );
          assert(
            Number.isFinite(expectedLeft)
              && Number.isFinite(expectedTop)
              && Math.abs(immediateRect.left - expectedLeft) <= 1
              && Math.abs(immediateRect.top - expectedTop) <= 1,
            "Status menu did not render at its computed position immediately",
            {
              actual: { left: immediateRect.left, top: immediateRect.top },
              expected: { left: expectedLeft, top: expectedTop }
            }
          );
          await sleep(100);
          assert(menu.getAttribute("role") === "menu", "Status menu is missing role=menu");
          const items = Array.from(menu.querySelectorAll(".tiny-local-status-menu-item"));
          assert(items.length >= 3, "Status menu did not include all action items", { itemTexts: items.map((item) => item.textContent.trim()) });
          for (const item of items) {
            assert(item.tagName === "BUTTON", "Status menu action is not rendered as a button", { tagName: item.tagName, text: item.textContent.trim() });
            assert(item.getAttribute("role") === "menuitem", "Status menu action is missing role=menuitem", { text: item.textContent.trim() });
          }
          clickElement(items[index]);
          await sleep(250);
          assert(calls[key] === 1, `Status menu item ${key} did not dispatch`, calls);
        }

        p.statusBarController.closeMenu();
        const viewportWindow = document.defaultView || window;
        const edgeEvent = {
          target: {
            getBoundingClientRect: () => ({
              left: viewportWindow.innerWidth - 2,
              top: viewportWindow.innerHeight - 24,
              bottom: viewportWindow.innerHeight - 4,
              width: 2,
              height: 20
            })
          }
        };
        await p.statusBarController.showMenu(edgeEvent);
        const edgeMenu = await waitForStatusMenu();
        assert(!!edgeMenu, "Status menu did not open for right-edge viewport check");
        const edgeRect = edgeMenu.getBoundingClientRect();
        assert(edgeRect.left >= 0 && edgeRect.right <= viewportWindow.innerWidth && edgeRect.top >= 0 && edgeRect.bottom <= viewportWindow.innerHeight, "Status menu overflowed viewport", {
          rect: { left: edgeRect.left, right: edgeRect.right, top: edgeRect.top, bottom: edgeRect.bottom },
          viewport: { width: viewportWindow.innerWidth, height: viewportWindow.innerHeight }
        });
        const edgeItem = edgeMenu.querySelector(".tiny-local-status-menu-item");
        assert(!!edgeItem, "Status menu right-edge check did not find a menu item");
        const edgeItemStyle = viewportWindow.getComputedStyle(edgeItem);
        assert(edgeItemStyle.backgroundColor === "rgba(0, 0, 0, 0)" || edgeItemStyle.backgroundColor === "transparent", "Status menu item has a separate background", {
          backgroundColor: edgeItemStyle.backgroundColor
        });
        assert(edgeItemStyle.boxShadow === "none", "Status menu item still has theme button shadow", { boxShadow: edgeItemStyle.boxShadow });
        p.statusBarController.closeMenu();

        p.statusBarController.closeMenu();
        const originalStatusBarRect = p.statusBarItem.getBoundingClientRect;
        p.statusBarItem.getBoundingClientRect = () => ({ left: 80, top: 700, bottom: 720, width: 140, height: 22 });
        try {
          const statusBarWindow = p.statusBarItem.ownerDocument?.defaultView || window;
          p.statusBarItem.focus();
          const noteCallsBeforeKeyboard = calls.note;
          p.statusBarItem.dispatchEvent(new statusBarWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, view: statusBarWindow }));
          const keyboardMenu = await waitForStatusMenu();
          assert(!!keyboardMenu, "Status menu did not open with keyboard context");
          assert(p.statusBarItem.getAttribute("aria-expanded") === "true", "Status bar aria-expanded did not become true after keyboard open");
          const keyboardItems = Array.from(keyboardMenu.querySelectorAll(".tiny-local-status-menu-item"));
          assert(document.activeElement === keyboardItems[0], "Keyboard-opened status menu did not focus first action");
          const focusedItemStyle = statusBarWindow.getComputedStyle(keyboardItems[0]);
          assert(focusedItemStyle.outlineStyle !== "none" && Number.parseFloat(focusedItemStyle.outlineWidth) > 0, "Focused status menu item has no visible focus indicator", {
            outlineStyle: focusedItemStyle.outlineStyle,
            outlineWidth: focusedItemStyle.outlineWidth
          });
          document.dispatchEvent(new statusBarWindow.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true, view: statusBarWindow }));
          assert(document.activeElement === keyboardItems[1], "ArrowDown did not focus the next status menu action");
          document.dispatchEvent(new statusBarWindow.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true, view: statusBarWindow }));
          assert(document.activeElement === keyboardItems[0], "ArrowUp did not focus the previous status menu action");
          document.dispatchEvent(new statusBarWindow.KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true, view: statusBarWindow }));
          assert(document.activeElement === keyboardItems[keyboardItems.length - 1], "End did not focus the last status menu action");
          document.dispatchEvent(new statusBarWindow.KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true, view: statusBarWindow }));
          assert(document.activeElement === keyboardItems[0], "Home did not focus the first status menu action");
          keyboardItems[0].dispatchEvent(new statusBarWindow.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, view: statusBarWindow }));
          await sleep(250);
          assert(calls.note === noteCallsBeforeKeyboard + 1, "Focused status menu first item did not dispatch", calls);
          assert(!document.querySelector(".tiny-local-status-menu"), "Status menu did not close after focused item action");

          await p.statusBarController.showMenu({ keyboard: true, returnFocusTo: p.statusBarItem, target: p.statusBarItem });
          const spaceMenu = await waitForStatusMenu();
          assert(!!spaceMenu, "Status menu did not reopen with keyboard context");
          const spaceItems = Array.from(spaceMenu.querySelectorAll(".tiny-local-status-menu-item"));
          spaceItems[0].dispatchEvent(new statusBarWindow.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true, view: statusBarWindow }));
          await sleep(250);
          assert(calls.note === noteCallsBeforeKeyboard + 2, "Space did not activate the focused status menu action", calls);
          assert(!document.querySelector(".tiny-local-status-menu"), "Status menu did not close after Space activation");

          await p.statusBarController.showMenu({ keyboard: true, returnFocusTo: p.statusBarItem, target: p.statusBarItem });
          const escapeMenu = await waitForStatusMenu();
          assert(!!escapeMenu, "Status menu did not reopen for Escape verification");
          document.dispatchEvent(new statusBarWindow.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, view: statusBarWindow }));
          await sleep(150);
          assert(!document.querySelector(".tiny-local-status-menu"), "Status menu did not close from Escape key");
          assert(p.statusBarItem.getAttribute("aria-expanded") === "false", "Status bar aria-expanded did not reset after Escape");
          const focusRestoreDeadline = Date.now() + 1000;
          while (document.activeElement !== p.statusBarItem && Date.now() < focusRestoreDeadline) {
            await sleep(50);
          }
          assert(document.activeElement === p.statusBarItem, "Status menu Escape did not restore focus to status bar");
        } finally {
          p.statusBarItem.getBoundingClientRect = originalStatusBarRect;
        }
      } finally {
        p.statusBarController.closeMenu();
        p.compressImagesInNote = originalNote;
        p.compressAllImages = originalAll;
        p.moveService.moveCompressedToFiles = originalMove;
        p.moveService.getCompressedFilesCount = originalCount;
      }
      return { statusText, aria, calls };
    });

    await check("stats: counts and savings calculator reflect QA images", async () => {
      await p.rebuildImageIndex("runtime-qa-stats");
      const counts = await p.getImageCompressionCounts();
      const stats = await p.getStatsSnapshot();
      const savings = await p.savingsCalculator.calculateSpaceSavings();
      assert(counts.totalImages > 0, "Image counts did not see QA images", counts);
      assert(stats.cacheStats.total > 0, "Stats cache total is empty after compression", stats.cacheStats);
      assert(typeof savings.savedPercentage === "number" && savings.savedPercentage >= 0 && savings.savedPercentage <= 100, "Savings result invalid", savings);
      return { counts, cacheStats: stats.cacheStats, savings };
    });

    await check("move: command moves compressed outputs to originals and creates backups", async () => {
      const moveProbe = await createImage(`${qaRoot}/Move/move-probe.jpg`, "jpg", 12);
      const originalBefore = (await statRel(moveProbe.path)).size;
      await p.compressFile(moveProbe);
      const compressed = await assertCompressed(moveProbe, "move command setup");
      const movableBefore = await p.moveService.getCompressedFilesCount();
      assert(movableBefore > 0, "No compressed files are movable before move", { movableBefore });
      const movedOriginalProofs = [];
      for (const candidate of await p.moveService.getCompressedMoveCandidates()) {
        const originalPath = candidate.originalPath || await p.moveService.findOriginalFileForCompressed(candidate);
        if (originalPath) {
          assert(isQaOwnedVaultPath(originalPath), "Move candidate original escaped the exact QA root", { originalPath });
          assert(isQaOwnedVaultPath(candidate.compressedPath), "Move candidate output escaped the exact QA root", { compressedPath: candidate.compressedPath });
          movedOriginalProofs.push({
            originalPath,
            compressedSha256: sha256Abs(absolute(candidate.compressedPath))
          });
        }
      }
      await captureMoveBackupProofs(async () => await runCommand("move-compressed-to-files", 120000));
      for (const { originalPath, compressedSha256 } of movedOriginalProofs) {
        if (await existsRel(originalPath)) {
          assert(sha256Abs(absolute(originalPath)) === compressedSha256, "Move installed bytes that differ from the exact registered compressed output", { originalPath });
          ownership.recordFileWithExpectedSha256Sync(absolute(originalPath), compressedSha256);
        }
      }
      const originalAfter = (await statRel(moveProbe.path)).size;
      assert(originalAfter < originalBefore, "Move command did not replace original with smaller compressed file", { originalBefore, originalAfter, compressed });
      assert(!(await existsRel(outputRelFor(moveProbe.path))), "Move command did not remove compressed output", { output: outputRelFor(moveProbe.path) });
      const movedCacheEntry = getStoredCacheEntryWithState(moveProbe.path, "moved");
      assert(!!movedCacheEntry, "Move command did not mark cache entry as moved", {
        entries: p.cache.getEntriesForPath(moveProbe.path)
      });
      const backupDir = p.getBackupStoragePaths().originalFilesBackups;
      const backupDirAbsolute = absolute(backupDir);
      const backups = await fs.promises.readdir(backupDirAbsolute).catch(() => []);
      assert(backups.length > 0, "Move command did not create an image backup directory", { backupDir });
      recordProvenOriginalBackups(backupDirAbsolute);
      return { movableBefore, originalBefore, originalAfter, backupCount: backups.length };
    });

    await check("move: auto-move threshold moves fresh compressed output automatically", async () => {
      try {
        p.settings.autoMoveCompressedEnabled = true;
        p.settings.autoMoveCompressedThreshold = 1;
        await p.saveSettings();
        const file = await createImage(`${qaRoot}/AutoMove/auto-move.jpg`, "jpg", 13);
        const originalBefore = (await statRel(file.path)).size;
        ownership.recordDirectorySync(path.dirname(outputAbsFor(file.path)));
        await captureMoveBackupProofs(async () => {
          await p.compressFile(file);
          await waitForCompressionIdle(120000);
        });
        const originalAfter = (await statRel(file.path)).size;
        assert(originalAfter < originalBefore, "Auto-move did not replace original with smaller compressed file", { originalBefore, originalAfter });
        assert(!(await existsRel(outputRelFor(file.path))), "Auto-move left compressed output behind", { output: outputRelFor(file.path) });
        const movedCacheEntry = getStoredCacheEntryWithState(file.path, "moved");
        assert(!!movedCacheEntry, "Auto-move did not mark cache entry moved", {
          entries: p.cache.getEntriesForPath(file.path)
        });
        const installedSha256 = sha256Abs(absolute(file.path));
        assert(movedCacheEntry.entry?.outputSha256 === installedSha256, "Auto-move installed bytes that differ from its exact committed compressed output", {
          installedSha256,
          outputSha256: movedCacheEntry.entry?.outputSha256
        });
        ownership.recordFileWithExpectedSha256Sync(absolute(file.path), movedCacheEntry.entry.outputSha256);
        recordProvenOriginalBackups(absolute(p.getBackupStoragePaths().originalFilesBackups));
        return { originalBefore, originalAfter };
      } finally {
        await restoreQaDefaults();
      }
    });

    await check("backups: clear original-files backups is safe when redirected to isolated storage", async () => {
      const isolatedStorageRoot = joinVault(qaStateRoot, "storage");
      const originalGetBackupStoragePaths = p.getBackupStoragePaths;
      p.getBackupStoragePaths = () => ({
        root: isolatedStorageRoot,
        backupsRoot: joinVault(isolatedStorageRoot, "backups"),
        cacheBackups: joinVault(isolatedStorageRoot, "backups", "cache"),
        originalFilesBackups: joinVault(isolatedStorageRoot, "backups", "originals")
      });
      try {
        const backupDir = p.getBackupStoragePaths().originalFilesBackups;
        const backupDirAbsolute = absolute(backupDir);
        await fs.promises.mkdir(path.join(backupDirAbsolute, "backup-test"), { recursive: true });
        await fs.promises.writeFile(path.join(backupDirAbsolute, "backup-test", "file.txt"), "backup");
        ownership.recordFileWithExpectedSha256Sync(
          path.join(backupDirAbsolute, "backup-test", "file.txt"),
          crypto.createHash("sha256").update("backup").digest("hex")
        );
        await p.clearOriginalFilesBackups();
        const remaining = await fs.promises.readdir(backupDirAbsolute).catch(() => []);
        assert(remaining.length === 0, "clearOriginalFilesBackups did not empty isolated backup dir", { remaining, backupDir });
        return { backupDir };
      } finally {
        p.getBackupStoragePaths = originalGetBackupStoragePaths;
      }
    });

    await check("settings: force refresh cache completes and leaves index usable", async () => {
      await p.forceRefreshCache();
      await sleep(200);
      p.closeManagedModals?.();
      assert(p.imageIndex?.isReady?.() === true, "Image index is not ready after forceRefreshCache");
      const counts = await p.getImageCompressionCounts();
      return { counts };
    });
  } catch (error) {
    const failure = {
      name: "runtime-qa: uncaught setup or runner failure",
      status: "fail",
      error: serializeError(error)
    };
    report.checks.push(failure);
    report.failures.push(failure);
  } finally {
    for (let index = cleanupStack.length - 1; index >= 0; index--) {
      try {
        await cleanupStack[index]();
      } catch (error) {
        recordWarning(`cleanup.${index}`, serializeError(error));
      }
    }
    for (let index = restoreStack.length - 1; index >= 0; index--) {
      try {
        await restoreStack[index]();
      } catch (error) {
        recordWarning(`restore.${index}`, serializeError(error));
      }
    }
    try {
      p.closeManagedModals?.();
      p.statusBarController?.closeMenu?.();
    } catch (error) {
      recordWarning("final-ui-close", serializeError(error));
    }
  }

  report.finishedAt = new Date().toISOString();
  report.summary = {
    passed: report.checks.filter((item) => item.status === "pass").length,
    failed: report.failures.length,
    warnings: report.warnings.length
  };
  writeProgress(report.failures.length > 0 ? "completed-with-failures" : "completed", "runtime QA", {
    summary: report.summary
  });
  try {
    ownership.cleanup();
  } catch (error) {
    recordWarning("cleanup.ownership", serializeError(error));
    report.summary.warnings = report.warnings.length;
  }
  globalThis.__tinyLocalFullQaLastReport = report;
  return JSON.stringify(report, null, 2);
  } finally {
    finishRuntimeQaCarrier(globalThis, activeQaSymbol, qaOwner, new Date().toISOString());
  }
})()
