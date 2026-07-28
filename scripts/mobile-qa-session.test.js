"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { resolveRepositoryLayout } = require("./repository-layout");
const { runEsbuildCli } = require("./run-esbuild-cli");

const { sourceRoot } = resolveRepositoryLayout();
const OWNER = "a".repeat(32);
const SESSION = "b".repeat(32);
const PROFILE = "android";
const MARKER_PATH = ".local-image-compress-qa/qa-vault-marker.json";
const PRODUCT_CACHE = ".obsidian/plugins/local-image-compress/tinyLocal-cache.json";
const PRIVATE_STATE_ROOT = ".obsidian/plugins/local-image-compress/qa-backups/mobile";

class MockTFile {
  constructor(filePath) { this.path = normalize(filePath); }
}

class MockTFolder {
  constructor(folderPath) { this.path = normalize(folderPath); }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalize(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}

function compileSessionModule() {
  const outputPath = path.join(os.tmpdir(), `lic-mobile-qa-session-${process.pid}-${crypto.randomBytes(6).toString("hex")}.cjs`);
  runEsbuildCli([
    path.join("src-ts", "qa", "session.ts"),
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=es2020",
    "--external:obsidian",
    `--outfile=${outputPath}`,
    "--log-level=silent"
  ], { cwd: sourceRoot, stdio: "pipe" });

  const originalLoad = Module._load;
  Module._load = function loadWithObsidianMock(request, parent, isMain) {
    if (request === "obsidian") {
      return new Proxy({
        normalizePath: normalize,
        Platform: { isMobile: true, isAndroidApp: true, isIosApp: false },
        TFile: MockTFile,
        TFolder: MockTFolder
      }, {
        get(target, property) {
          return property in target ? target[property] : class {};
        }
      });
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(outputPath);
  } finally {
    Module._load = originalLoad;
    fs.rmSync(outputPath, { force: true });
  }
}

function compileMobilePlatformModule() {
  const outputPath = path.join(os.tmpdir(), `lic-mobile-platform-${process.pid}-${crypto.randomBytes(6).toString("hex")}.cjs`);
  runEsbuildCli([
    path.join("src-ts", "platform", "mobile.ts"),
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=es2020",
    "--external:obsidian",
    `--outfile=${outputPath}`,
    "--log-level=silent"
  ], { cwd: sourceRoot, stdio: "pipe" });
  const originalLoad = Module._load;
  Module._load = function loadWithObsidianMock(request, parent, isMain) {
    if (request === "obsidian") {
      return new Proxy({
        normalizePath: normalize,
        Platform: { isMobile: true, isAndroidApp: true, isIosApp: false },
        TFile: MockTFile,
        TFolder: MockTFolder
      }, {
        get(target, property) { return property in target ? target[property] : class {}; }
      });
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(outputPath);
  } finally {
    Module._load = originalLoad;
    fs.rmSync(outputPath, { force: true });
  }
}

class MemoryFs {
  constructor() {
    this.files = new Map();
    this.directories = new Set([""]);
    this.writeCount = 0;
  }

  joinPath(...segments) { return normalize(segments.filter(Boolean).join("/")); }
  dirnamePath(filePath) { return normalize(filePath).split("/").slice(0, -1).join("/"); }
  async exists(filePath) { return this.files.has(normalize(filePath)) || this.directories.has(normalize(filePath)); }
  async mkdir(dirPath) {
    const parts = normalize(dirPath).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      this.directories.add(current);
    }
  }
  async readText(filePath) {
    const value = this.files.get(normalize(filePath));
    if (value === undefined) throw new Error(`ENOENT: ${filePath}`);
    return value;
  }
  async writeText(filePath, text) {
    await this.mkdir(this.dirnamePath(filePath));
    this.files.set(normalize(filePath), String(text));
    this.writeCount++;
  }
  async processTextAtomically(filePath, initialText, update) {
    const normalized = normalize(filePath);
    await this.mkdir(this.dirnamePath(normalized));
    const current = this.files.has(normalized) ? this.files.get(normalized) : String(initialText);
    const next = String(update(current));
    this.files.set(normalized, next);
    this.writeCount++;
    return next;
  }
  async listNames(dirPath) {
    const normalized = normalize(dirPath);
    const prefix = normalized ? `${normalized}/` : "";
    const names = new Set();
    for (const filePath of this.files.keys()) {
      if (filePath.startsWith(prefix)) {
        const name = filePath.slice(prefix.length).split("/")[0];
        if (name) names.add(name);
      }
    }
    for (const directory of this.directories) {
      if (directory.startsWith(prefix)) {
        const name = directory.slice(prefix.length).split("/")[0];
        if (name) names.add(name);
      }
    }
    return [...names];
  }
  async listEntries(dirPath) {
    const normalized = normalize(dirPath);
    const names = await this.listNames(normalized);
    return names.map((name) => {
      const entryPath = normalize(`${normalized}/${name}`);
      return {
        name,
        isFile: this.files.has(entryPath),
        isDirectory: this.directories.has(entryPath),
        isSymbolicLink: false
      };
    });
  }
  async stat(filePath) {
    const normalized = normalize(filePath);
    if (this.directories.has(normalized)) return { mtimeMs: 1, size: 0, isDirectory: true };
    if (this.files.has(normalized)) return { mtimeMs: 1, size: Buffer.byteLength(this.files.get(normalized)), isDirectory: false };
    return null;
  }
  async removeDir(dirPath, options) {
    const normalized = normalize(dirPath);
    const prefix = `${normalized}/`;
    if (!options.recursive) {
      assert.equal([...this.files.keys()].some((filePath) => filePath.startsWith(prefix)), false, `non-recursive remove retained files in ${normalized}`);
      assert.equal([...this.directories].some((directory) => directory.startsWith(prefix)), false, `non-recursive remove retained directories in ${normalized}`);
      this.directories.delete(normalized);
      return;
    }
    for (const filePath of [...this.files.keys()]) {
      if (filePath.startsWith(prefix)) this.files.delete(filePath);
    }
    for (const directory of [...this.directories]) {
      if (directory === normalized || directory.startsWith(prefix)) this.directories.delete(directory);
    }
  }
  async removeFileIfUnchanged(filePath, expectedSha256) {
    const normalized = normalize(filePath);
    const value = this.files.get(normalized);
    if (value === undefined || sha256(value) !== expectedSha256) {
      return { removed: false, retainedConflictPath: normalized };
    }
    this.files.delete(normalized);
    return { removed: true, retainedConflictPath: null };
  }
}

function settings() {
  return {
    pngQuality: { min: 65, max: 80 },
    jpegQuality: 85,
    allowedRoots: ["Images"],
    outputFolder: "Compressed",
    autoCompressNewFiles: true,
    autoBackgroundCompression: true,
    autoBackgroundThreshold: 50,
    inactivityThresholdMinutes: 2,
    autoBackupsRetentionEnabled: true,
    autoBackupsRetentionDays: 30,
    autoMoveCompressedEnabled: true,
    autoMoveCompressedThreshold: 10
  };
}

function cacheData(pathValue = "Images/original.jpg") {
  return {
    version: "2.0.0",
    entries: { entry: { path: pathValue, timestamp: 1, originalSize: 123 } }
  };
}

function createFixture(existingMemoryFs = null) {
  const memoryFs = existingMemoryFs || new MemoryFs();
  const visibleWrites = [];
  const visibleDeletes = [];
  const persistence = { writes: 0 };
  const productCacheText = `${JSON.stringify(cacheData())}\n`;
  if (!memoryFs.files.has(PRODUCT_CACHE)) {
    memoryFs.files.set(PRODUCT_CACHE, productCacheText);
  }
  const ports = {
    fs: {
      ...memoryFs,
      joinPath: memoryFs.joinPath.bind(memoryFs),
      dirnamePath: memoryFs.dirnamePath.bind(memoryFs),
      exists: memoryFs.exists.bind(memoryFs),
      mkdir: memoryFs.mkdir.bind(memoryFs),
      readText: memoryFs.readText.bind(memoryFs),
      writeText: memoryFs.writeText.bind(memoryFs),
      processTextAtomically: memoryFs.processTextAtomically.bind(memoryFs),
      listNames: memoryFs.listNames.bind(memoryFs),
      listEntries: memoryFs.listEntries.bind(memoryFs),
      stat: memoryFs.stat.bind(memoryFs),
      removeDir: memoryFs.removeDir.bind(memoryFs),
      removeFileIfUnchanged: memoryFs.removeFileIfUnchanged.bind(memoryFs)
    },
    hash: {
      sha256Hex: (value) => sha256(value),
      fileSha256Hex: async (filePath) => sha256(await memoryFs.readText(filePath))
    },
    runtime: { instanceId: 1, revealPath: null, maxBufferedFileBytes: 25 * 1024 * 1024 }
  };
  const plugin = {
    app: {
      workspace: { getLeavesOfType() { return []; } },
      vault: {
        getAbstractFileByPath(filePath) {
          const normalized = normalize(filePath);
          if (memoryFs.files.has(normalized)) return new MockTFile(normalized);
          if (memoryFs.directories.has(normalized)) return new MockTFolder(normalized);
          return null;
        },
        async createFolder(folderPath) {
          await memoryFs.mkdir(folderPath);
        },
        async create(filePath, text) {
          await memoryFs.writeText(filePath, text);
          visibleWrites.push(normalize(filePath));
          return new MockTFile(filePath);
        },
        async process(file, transform) {
          const next = transform(await memoryFs.readText(file.path));
          await memoryFs.writeText(file.path, next);
          visibleWrites.push(normalize(file.path));
        },
        async delete(file, recursive) {
          assert(file instanceof MockTFolder);
          assert.equal(recursive, true);
          await memoryFs.removeDir(file.path, { recursive: true });
          visibleDeletes.push(normalize(file.path));
        }
      }
    },
    settings: settings(),
    cache: {
      CACHE_VERSION: "2.0.0",
      cacheFile: PRODUCT_CACHE,
      cacheBackupsDir: ".local-image-compress/backups/cache",
      cacheData: cacheData(),
      serializeForDisk(data = this.cacheData) { return JSON.stringify(data); },
      activeWritePromise: null,
      async flushPendingCacheSave() { return true; },
      cancelPendingSave() {},
      async loadCache() { this.cacheData = JSON.parse(await memoryFs.readText(this.cacheFile)); }
    },
    moveService: { moveOperationInProgress: false },
    backgroundCompressionService: { isBackgroundCompressionRunning: false },
    newFileQueue: {
      newFileBatchDrainInProgress: false,
      newFileCompressionTimers: new Map(),
      newFileCompressionInFlight: new Set(),
      newFileCompressionPending: new Set(),
      newFileBatchFlushTimer: null,
      newFileBatchDrainRescheduleRequested: false
    },
    compressor: {
      getOutputPath(filePath, outputFolder) { return `${normalize(outputFolder)}/${normalize(filePath)}`; },
      async compress(file) { return { success: false, skipReason: `mock:${file.path}` }; }
    },
    async waitForCompressionIdle() { return true; },
    async waitForSettingsPersistenceIdle() { return true; },
    async saveSettings() { persistence.writes++; },
    applyRuntimeSettings() {},
    async rebuildImageIndex() {},
    getPluginDirectory() { return ".obsidian/plugins/local-image-compress"; },
    getBackupStoragePaths() {
      return {
        root: ".local-image-compress",
        backupsRoot: ".local-image-compress/backups",
        cacheBackups: ".local-image-compress/backups/cache",
        originalFilesBackups: ".local-image-compress/backups/originals"
      };
    }
  };
  return { memoryFs, plugin, ports, productCacheText, visibleWrites, visibleDeletes, persistence };
}

async function addMarker(memoryFs) {
  await memoryFs.writeText(MARKER_PATH, JSON.stringify({
    schemaVersion: 1,
    purpose: "local-image-compress-mobile-qa",
    allowDestructiveQa: true,
    vaultId: "c".repeat(32)
  }));
}

function attachAdapterBackedVault(fixture, vaultEvents) {
  const memoryFs = fixture.memoryFs;
  const vaultListeners = new Map();
  const adapter = {
    async exists(filePath) { return await memoryFs.exists(filePath); },
    async mkdir(dirPath) { await memoryFs.mkdir(dirPath); },
    async read(filePath) { return await memoryFs.readText(filePath); },
    async write(filePath, text) { await memoryFs.writeText(filePath, text); },
    async readBinary(filePath) {
      return Uint8Array.from(Buffer.from(await memoryFs.readText(filePath), "utf8")).buffer;
    },
    async writeBinary(filePath, data) {
      await memoryFs.writeText(filePath, Buffer.from(new Uint8Array(data)).toString("utf8"));
    },
    async process(filePath, update) {
      return await memoryFs.processTextAtomically(filePath, "", update);
    },
    async list(dirPath) {
      const normalized = normalize(dirPath);
      const files = [];
      const folders = [];
      for (const name of await memoryFs.listNames(normalized)) {
        const entryPath = normalize(`${normalized}/${name}`);
        if (memoryFs.files.has(entryPath)) files.push(entryPath);
        if (memoryFs.directories.has(entryPath)) folders.push(entryPath);
      }
      return { files, folders };
    },
    async stat(filePath) {
      const stat = await memoryFs.stat(filePath);
      return stat ? { type: stat.isDirectory ? "folder" : "file", mtime: stat.mtimeMs, ctime: stat.mtimeMs, size: stat.size } : null;
    },
    async rmdir(dirPath, recursive) { await memoryFs.removeDir(dirPath, { recursive, force: false }); },
    async remove(filePath) { memoryFs.files.delete(normalize(filePath)); },
    async rename(oldPath, newPath) {
      const value = await memoryFs.readText(oldPath);
      memoryFs.files.delete(normalize(oldPath));
      await memoryFs.writeText(newPath, value);
    },
    async copy(oldPath, newPath) { await memoryFs.writeText(newPath, await memoryFs.readText(oldPath)); }
  };
  fixture.plugin.app.vault.adapter = adapter;
  fixture.plugin.app.vault.configDir = ".obsidian";
  fixture.plugin.app.vault.on = (eventName, callback) => {
    const listeners = vaultListeners.get(eventName) || [];
    listeners.push(callback);
    vaultListeners.set(eventName, listeners);
    return { eventName, callback };
  };
  fixture.plugin.app.vault.createBinary = async (filePath, data) => {
    const normalized = normalize(filePath);
    if (await memoryFs.exists(normalized)) throw new Error(`EEXIST: ${normalized}`);
    await adapter.writeBinary(normalized, data);
    const file = new MockTFile(normalized);
    if (normalized !== ".obsidian" && !normalized.startsWith(".obsidian/")) {
      for (const listener of vaultListeners.get("create") || []) {
        await listener(file);
      }
    }
    return file;
  };
  fixture.plugin.app.vault.on("create", async (file) => {
    vaultEvents.push(file.path);
    if (file.path.startsWith(`${PRIVATE_STATE_ROOT}/`)) {
      await memoryFs.writeText(file.path, "listener-mutated");
    }
  });
  return adapter;
}

async function runTest(name, test) {
  await test();
  process.stdout.write(`PASS ${name}\n`);
}

async function main() {
  const localStorageValues = new Map();
  global.window = {
    crypto: crypto.webcrypto,
    localStorage: {
      getItem(key) { return localStorageValues.get(key) || null; },
      setItem(key, value) { localStorageValues.set(key, value); }
    }
  };
  const { MobileQaSessionStore, getMobileQaDeviceOwnerId } = compileSessionModule();
  const { createMobilePorts } = compileMobilePlatformModule();

  await runTest("device owner id is durable and stable across WebView reloads", async () => {
    const storage = new Map();
    const localStorage = {
      getItem(key) { return storage.get(key) || null; },
      setItem(key, value) { storage.set(key, value); }
    };
    const first = await getMobileQaDeviceOwnerId({ localStorage });
    const second = await getMobileQaDeviceOwnerId({ localStorage });
    assert.match(first, /^[a-f0-9]{32}$/);
    assert.equal(second, first);
  });

  await runTest("unavailable persistent storage blocks crash-unsafe QA ownership", async () => {
    const localStorage = {
      getItem() { throw new Error("storage unavailable"); },
      setItem() { throw new Error("storage unavailable"); }
    };
    await assert.rejects(getMobileQaDeviceOwnerId({ localStorage }), /requires persistent local storage/i);
  });

  await runTest("marker guard performs no Vault writes", async () => {
    const fixture = createFixture();
    const store = new MobileQaSessionStore(fixture.plugin, fixture.ports, OWNER);
    await assert.rejects(store.prepare(SESSION, PROFILE), /marker is missing/i);
    assert.equal(fixture.memoryFs.writeCount, 0);
    assert.equal(await fixture.memoryFs.readText(PRODUCT_CACHE), fixture.productCacheText);
  });

  await runTest("Vault listener cannot observe or mutate private QA cache and journal files", async () => {
    const fixture = createFixture();
    await addMarker(fixture.memoryFs);
    const vaultEvents = [];
    attachAdapterBackedVault(fixture, vaultEvents);
    const mobilePorts = createMobilePorts(fixture.plugin.app);
    const store = new MobileQaSessionStore(fixture.plugin, mobilePorts, OWNER);
    const prepared = await store.prepare(SESSION, PROFILE);
    const cacheText = fixture.plugin.cache.serializeForDisk();
    await mobilePorts.fs.processTextAtomically(fixture.plugin.cache.cacheFile, cacheText, (current) => current);
    assert(prepared.journal.stateRoot.startsWith(`${PRIVATE_STATE_ROOT}/`));
    assert.equal(await fixture.memoryFs.readText(fixture.plugin.cache.cacheFile), cacheText);
    assert.deepEqual(vaultEvents.filter((filePath) => filePath.startsWith(`${PRIVATE_STATE_ROOT}/`)), []);
  });

  for (const [label, mutateQueue] of [
    ["debounce timer", (queue) => queue.newFileCompressionTimers.set("Images/a.jpg", 1)],
    ["pending path", (queue) => queue.newFileCompressionPending.add("Images/a.jpg")],
    ["batch timer", (queue) => { queue.newFileBatchFlushTimer = 1; }],
    ["drain reschedule", (queue) => { queue.newFileBatchDrainRescheduleRequested = true; }]
  ]) {
    await runTest(`queue ${label} blocks isolation`, async () => {
      const fixture = createFixture();
      await addMarker(fixture.memoryFs);
      mutateQueue(fixture.plugin.newFileQueue);
      const store = new MobileQaSessionStore(fixture.plugin, fixture.ports, OWNER);
      await assert.rejects(store.prepare(SESSION, PROFILE), /still active/i);
      assert.equal(await fixture.memoryFs.exists(`QA-LIC-Mobile-${SESSION}`), false);
    });
  }

  await runTest("session isolates cache and settings then restores without rewriting product cache", async () => {
    const fixture = createFixture();
    await addMarker(fixture.memoryFs);
    const writesAfterMarker = fixture.memoryFs.writeCount;
    const store = new MobileQaSessionStore(fixture.plugin, fixture.ports, OWNER);
    const prepared = await store.prepare(SESSION, PROFILE);
    assert(prepared.journal.sessionRoot.startsWith("QA-LIC-Mobile-"));
    assert(fixture.plugin.cache.cacheFile.startsWith(prepared.journal.stateRoot));
    assert.deepEqual(fixture.plugin.settings.allowedRoots, [prepared.journal.sessionRoot]);
    await fixture.plugin.saveSettings();
    assert.equal(fixture.persistence.writes, 0, "QA settings escaped through saveSettings");
    await assert.rejects(
      fixture.plugin.compressor.compress(new MockTFile("Images/outside.jpg"), fixture.plugin.settings, { sourcePath: "Images/outside.jpg" }),
      /blocked compression outside/i
    );
    await assert.rejects(
      fixture.plugin.compressor.compress(
        new MockTFile(`${prepared.journal.sessionRoot}/inside.jpg`),
        { ...fixture.plugin.settings, outputFolder: "Compressed" },
        { sourcePath: `${prepared.journal.sessionRoot}/inside.jpg` }
      ),
      /blocked compression output outside/i
    );
    await fixture.plugin.compressor.compress(
      new MockTFile(`${prepared.journal.sessionRoot}/inside.jpg`),
      fixture.plugin.settings,
      { sourcePath: `${prepared.journal.sessionRoot}/inside.jpg` }
    );
    assert.deepEqual(prepared.runtime.observedCompressionInputs, [`${prepared.journal.sessionRoot}/inside.jpg`]);
    assert.deepEqual(prepared.runtime.observedCompressionOutputs, [`${prepared.journal.sessionRoot}/Compressed/${prepared.journal.sessionRoot}/inside.jpg`]);
    assert.equal(await fixture.memoryFs.readText(PRODUCT_CACHE), fixture.productCacheText);
    assert(fixture.memoryFs.writeCount > writesAfterMarker);
    const journalText = await fixture.memoryFs.readText(`${PRIVATE_STATE_ROOT}/${OWNER}/${SESSION}.json`);
    assert(!journalText.includes("Images/original.jpg"), "Session journal leaked raw product cache entries");
    assert(!journalText.includes('"allowedRoots"'), "Session journal leaked raw product settings");
    const plannedOutputDirectory = `${prepared.journal.sessionRoot}/Compressed/${prepared.journal.sessionRoot}/AutoMove`;
    await store.recordOwnedDirectory(prepared.journal, plannedOutputDirectory);
    for (const expectedDirectory of [
      prepared.journal.sessionRoot,
      `${prepared.journal.sessionRoot}/Compressed`,
      `${prepared.journal.sessionRoot}/Compressed/${prepared.journal.sessionRoot}`,
      plannedOutputDirectory
    ]) {
      assert(prepared.journal.ownedDirectories.includes(expectedDirectory), `Missing mobile owned ancestor: ${expectedDirectory}`);
    }
    const cleanup = await store.restoreAndCleanup(prepared, true);
    assert.equal(cleanup.status, "pass");
    assert.equal(cleanup.productCacheUntouched, true);
    assert.equal(fixture.plugin.cache.cacheFile, PRODUCT_CACHE);
    assert.deepEqual(fixture.plugin.settings.allowedRoots, ["Images"]);
    await fixture.plugin.saveSettings();
    assert.equal(fixture.persistence.writes, 1, "Original saveSettings method was not restored");
    await fixture.plugin.compressor.compress(new MockTFile("Images/outside.jpg"));
    await store.finalizeAfterReport(prepared.journal);
    assert.equal(await fixture.memoryFs.exists(prepared.journal.sessionRoot), false);
    assert.deepEqual(fixture.visibleDeletes, []);
    assert.equal(await fixture.memoryFs.exists(`${PRIVATE_STATE_ROOT}/${OWNER}/${SESSION}.json`), false);
    assert.equal(await fixture.memoryFs.readText(PRODUCT_CACHE), fixture.productCacheText);
  });

  await runTest("prepare failure restores current runtime before rejecting", async () => {
    const fixture = createFixture();
    await addMarker(fixture.memoryFs);
    let applyCalls = 0;
    fixture.plugin.applyRuntimeSettings = () => {
      applyCalls++;
      if (applyCalls === 1) {
        throw new Error("injected isolation failure");
      }
    };
    const store = new MobileQaSessionStore(fixture.plugin, fixture.ports, OWNER);
    await assert.rejects(store.prepare(SESSION, PROFILE), /injected isolation failure/);
    assert.equal(fixture.plugin.cache.cacheFile, PRODUCT_CACHE);
    assert.deepEqual(fixture.plugin.settings.allowedRoots, ["Images"]);
    assert.equal(await fixture.memoryFs.readText(PRODUCT_CACHE), fixture.productCacheText);
    assert.equal(await fixture.memoryFs.exists(`QA-LIC-Mobile-${SESSION}`), false);
    assert.equal(await fixture.memoryFs.exists(`${PRIVATE_STATE_ROOT}/${OWNER}/${SESSION}.json`), false);
  });

  await runTest("cleanup restores methods settings and cache pointers after isolated cache flush failure", async () => {
    const fixture = createFixture();
    await addMarker(fixture.memoryFs);
    const store = new MobileQaSessionStore(fixture.plugin, fixture.ports, OWNER);
    const prepared = await store.prepare(SESSION, PROFILE);
    fixture.plugin.cache.flushPendingCacheSave = async () => false;
    const cleanup = await store.restoreAndCleanup(prepared, true);
    assert.equal(cleanup.status, "fail");
    assert.equal(cleanup.settingsRestored, true);
    assert.equal(fixture.plugin.cache.cacheFile, PRODUCT_CACHE);
    assert.deepEqual(fixture.plugin.settings.allowedRoots, ["Images"]);
    await fixture.plugin.saveSettings();
    assert.equal(fixture.persistence.writes, 1);
    await fixture.plugin.compressor.compress(new MockTFile("Images/outside.jpg"));
  });

  for (const [label, foreignEvidence] of [["non-empty", "foreign-evidence"], ["empty", ""], ["whitespace", "   \n"]]) {
    await runTest(`initial journal creation preserves concurrent ${label} foreign bytes`, async () => {
      const fixture = createFixture();
      await addMarker(fixture.memoryFs);
      const journalPath = `${PRIVATE_STATE_ROOT}/${OWNER}/${SESSION}.json`;
      const processTextAtomically = fixture.ports.fs.processTextAtomically;
      fixture.ports.fs.processTextAtomically = async (filePath, initialText, update) => {
        if (normalize(filePath) === journalPath) {
          await fixture.memoryFs.writeText(journalPath, foreignEvidence);
        }
        return await processTextAtomically(filePath, initialText, update);
      };
      const store = new MobileQaSessionStore(fixture.plugin, fixture.ports, OWNER);
      await assert.rejects(store.prepare(SESSION, PROFILE), /atomically overwrite an existing/i);
      assert.equal(await fixture.memoryFs.readText(journalPath), foreignEvidence);
    });
  }

  await runTest("session-root creation failure removes the unmutated journal", async () => {
    const fixture = createFixture();
    await addMarker(fixture.memoryFs);
    fixture.plugin.app.vault.createFolder = async () => { throw new Error("injected folder failure"); };
    const store = new MobileQaSessionStore(fixture.plugin, fixture.ports, OWNER);
    await assert.rejects(store.prepare(SESSION, PROFILE), /injected folder failure/);
    assert.equal(await fixture.memoryFs.exists(`QA-LIC-Mobile-${SESSION}`), false);
    assert.equal(await fixture.memoryFs.exists(`${PRIVATE_STATE_ROOT}/${OWNER}/${SESSION}.json`), false);
  });

  await runTest("owner-marker failure removes the freshly owned root and journal", async () => {
    const fixture = createFixture();
    await addMarker(fixture.memoryFs);
    const writeText = fixture.ports.fs.writeText;
    fixture.ports.fs.writeText = async (filePath, text) => {
      if (normalize(filePath).endsWith("/.qa-session-owner.json")) throw new Error("injected owner marker failure");
      await writeText(filePath, text);
    };
    const store = new MobileQaSessionStore(fixture.plugin, fixture.ports, OWNER);
    await assert.rejects(store.prepare(SESSION, PROFILE), /owner marker failure/);
    assert.equal(await fixture.memoryFs.exists(`QA-LIC-Mobile-${SESSION}`), false);
    assert.equal(await fixture.memoryFs.exists(`${PRIVATE_STATE_ROOT}/${OWNER}/${SESSION}.json`), false);
  });

  await runTest("atomic journal failure retains the previous valid phase", async () => {
    const fixture = createFixture();
    await addMarker(fixture.memoryFs);
    const store = new MobileQaSessionStore(fixture.plugin, fixture.ports, OWNER);
    const prepared = await store.prepare(SESSION, PROFILE);
    const journalPath = `${PRIVATE_STATE_ROOT}/${OWNER}/${SESSION}.json`;
    const processTextAtomically = fixture.ports.fs.processTextAtomically;
    fixture.ports.fs.processTextAtomically = async (filePath, initialText, update) => {
      if (normalize(filePath) === journalPath) {
        throw new Error("injected atomic interruption");
      }
      return await processTextAtomically(filePath, initialText, update);
    };
    await assert.rejects(store.updatePhase(prepared.journal, "restoring"), /atomic interruption/);
    assert.equal(JSON.parse(await fixture.memoryFs.readText(journalPath)).journal.phase, "running");
    fixture.ports.fs.processTextAtomically = processTextAtomically;
    const cleanup = await store.restoreAndCleanup(prepared, true);
    assert.equal(cleanup.status, "pass");
    await store.finalizeAfterReport(prepared.journal);
  });

  await runTest("final JSON and TXT reports use the visible Vault API", async () => {
    const fixture = createFixture();
    await addMarker(fixture.memoryFs);
    const store = new MobileQaSessionStore(fixture.plugin, fixture.ports, OWNER);
    const prepared = await store.prepare(SESSION, PROFILE);
    const cleanup = await store.restoreAndCleanup(prepared, true);
    assert.equal(cleanup.status, "pass");
    const now = new Date().toISOString();
    const report = {
      schema: "local-image-compress-mobile-qa-report/v1",
      pluginVersion: "2.0.0",
      appVersion: "test",
      platform: "mobile",
      profile: PROFILE,
      buildFingerprint: "test",
      deviceOwnerId: OWNER,
      vaultId: "c".repeat(32),
      sessionId: SESSION,
      phase: "completed",
      startedAt: now,
      updatedAt: now,
      finishedAt: now,
      durationMs: 1,
      capabilities: {},
      checks: [],
      warnings: [],
      settingsSnapshotSha256: prepared.journal.settingsSnapshotSha256,
      cacheSnapshotSha256: prepared.journal.cacheSnapshot.sha256,
      cleanup,
      recovery: { status: "not-required", recoveredSessions: 0, retainedJournals: [], errors: [] },
      summary: { passed: 0, failed: 0, skipped: 0, cancelled: false, success: true }
    };
    const draftReport = {
      ...report,
      phase: "restoring",
      summary: { ...report.summary, success: false }
    };
    await store.writeReport(prepared.journal, draftReport);
    assert.deepEqual(fixture.visibleWrites, [prepared.journal.reportTextPath, prepared.journal.reportJsonPath]);
    assert.match(await fixture.memoryFs.readText(prepared.journal.reportTextPath), /Result: FAIL/);
    assert.equal(JSON.parse(await fixture.memoryFs.readText(prepared.journal.reportJsonPath)).sessionId, SESSION);
    await store.publishFinalReport(prepared.journal, report);
    assert.deepEqual(fixture.visibleWrites, [
      prepared.journal.reportTextPath,
      prepared.journal.reportJsonPath,
      prepared.journal.reportJsonPath,
      prepared.journal.reportTextPath
    ]);
    assert.match(await fixture.memoryFs.readText(prepared.journal.reportTextPath), /Result: PASS/);
    await store.publishFinalReport(prepared.journal, report);
    const concurrentReport = "{\"foreign\":true}\n";
    await fixture.memoryFs.writeText(prepared.journal.reportJsonPath, concurrentReport);
    await assert.rejects(store.publishFinalReport(prepared.journal, report), /report changed before rewrite/i);
    assert.equal(await fixture.memoryFs.readText(prepared.journal.reportJsonPath), concurrentReport);
    await store.finalizeAfterReport(prepared.journal);
  });

  await runTest("final JSON rejection leaves the TXT report fail-closed", async () => {
    const fixture = createFixture();
    await addMarker(fixture.memoryFs);
    const store = new MobileQaSessionStore(fixture.plugin, fixture.ports, OWNER);
    const prepared = await store.prepare(SESSION, PROFILE);
    const cleanup = await store.restoreAndCleanup(prepared, true);
    const now = new Date().toISOString();
    const draft = {
      schema: "local-image-compress-mobile-qa-report/v1",
      pluginVersion: "2.0.0",
      appVersion: "test",
      platform: "mobile",
      profile: PROFILE,
      buildFingerprint: "test",
      deviceOwnerId: OWNER,
      vaultId: "c".repeat(32),
      sessionId: SESSION,
      phase: "restoring",
      startedAt: now,
      updatedAt: now,
      finishedAt: now,
      durationMs: 1,
      capabilities: {},
      checks: [],
      warnings: [],
      settingsSnapshotSha256: prepared.journal.settingsSnapshotSha256,
      cacheSnapshotSha256: prepared.journal.cacheSnapshot.sha256,
      cleanup,
      recovery: { status: "not-required", recoveredSessions: 0, retainedJournals: [], errors: [] },
      summary: { passed: 0, failed: 0, skipped: 0, cancelled: false, success: false }
    };
    await store.writeReport(prepared.journal, draft);
    await fixture.memoryFs.writeText(prepared.journal.reportJsonPath, "foreign-evidence");
    await assert.rejects(
      store.publishFinalReport(prepared.journal, {
        ...draft,
        phase: "completed",
        summary: { ...draft.summary, success: true }
      }),
      /report changed before rewrite/i
    );
    assert.match(await fixture.memoryFs.readText(prepared.journal.reportTextPath), /Result: FAIL/);
  });

  for (const phase of ["prepared", "running", "restoring", "completed"]) {
    await runTest(`hard-kill recovery is idempotent from ${phase}`, async () => {
      const fixture = createFixture();
      await addMarker(fixture.memoryFs);
      const firstStore = new MobileQaSessionStore(fixture.plugin, fixture.ports, OWNER);
      const prepared = await firstStore.prepare(SESSION, PROFILE);
      if (phase === "completed") {
        const cleanup = await firstStore.restoreAndCleanup(prepared, true);
        assert.equal(cleanup.status, "pass");
      }
      await firstStore.updatePhase(prepared.journal, phase);
      const reloaded = createFixture(fixture.memoryFs);
      const recoveryStore = new MobileQaSessionStore(reloaded.plugin, reloaded.ports, OWNER);
      const recovery = await recoveryStore.recoverOwnedSessions(PROFILE);
      assert.equal(recovery.status, "pass");
      assert.equal(recovery.recoveredSessions, 1);
      assert.equal(await fixture.memoryFs.readText(PRODUCT_CACHE), fixture.productCacheText);
      const repeated = await recoveryStore.recoverOwnedSessions(PROFILE);
      assert.equal(repeated.status, "not-required");
      assert.equal(repeated.recoveredSessions, 0);
    });
  }

  await runTest("recovery retains hidden state when the visible session root is missing", async () => {
    const fixture = createFixture();
    await addMarker(fixture.memoryFs);
    const firstStore = new MobileQaSessionStore(fixture.plugin, fixture.ports, OWNER);
    const prepared = await firstStore.prepare(SESSION, PROFILE);
    const journalPath = `${PRIVATE_STATE_ROOT}/${OWNER}/${SESSION}.json`;
    await fixture.memoryFs.mkdir(prepared.journal.stateRoot);
    await fixture.memoryFs.removeDir(prepared.journal.sessionRoot, { recursive: true, force: false });

    const reloaded = createFixture(fixture.memoryFs);
    const recoveryStore = new MobileQaSessionStore(reloaded.plugin, reloaded.ports, OWNER);
    const recovery = await recoveryStore.recoverOwnedSessions(PROFILE);
    assert.equal(recovery.status, "fail");
    assert.equal(recovery.recoveredSessions, 0);
    assert.deepEqual(recovery.retainedJournals, [journalPath]);
    assert.equal(await fixture.memoryFs.exists(prepared.journal.stateRoot), true);
    assert.equal(await fixture.memoryFs.exists(journalPath), true);
  });

  await runTest("changed progress is retained during final cleanup", async () => {
    const fixture = createFixture();
    await addMarker(fixture.memoryFs);
    const store = new MobileQaSessionStore(fixture.plugin, fixture.ports, OWNER);
    const prepared = await store.prepare(SESSION, PROFILE);
    await store.writeProgress(prepared.journal, {
      schema: "local-image-compress-mobile-qa-progress/v1",
      sessionId: SESSION,
      phase: "running",
      currentCheck: "M01",
      completed: 0,
      total: 1,
      updatedAt: new Date().toISOString()
    });
    const foreignProgress = "foreign-progress-evidence";
    await fixture.memoryFs.writeText(prepared.journal.progressPath, foreignProgress);
    const cleanup = await store.restoreAndCleanup(prepared, true);
    assert.equal(cleanup.status, "pass");
    await assert.rejects(store.finalizeAfterReport(prepared.journal), /state changed during cleanup/i);
    assert.equal(await fixture.memoryFs.readText(prepared.journal.progressPath), foreignProgress);
    assert.equal(await fixture.memoryFs.exists(`${PRIVATE_STATE_ROOT}/${OWNER}/${SESSION}.json`), true);
  });

  await runTest("journal replacement after validation is retained during final cleanup", async () => {
    const fixture = createFixture();
    await addMarker(fixture.memoryFs);
    const store = new MobileQaSessionStore(fixture.plugin, fixture.ports, OWNER);
    const prepared = await store.prepare(SESSION, PROFILE);
    const cleanup = await store.restoreAndCleanup(prepared, true);
    assert.equal(cleanup.status, "pass");
    const journalPath = `${PRIVATE_STATE_ROOT}/${OWNER}/${SESSION}.json`;
    const exists = fixture.ports.fs.exists;
    const foreignJournal = "foreign-journal-evidence";
    let injectReplacement = true;
    fixture.ports.fs.exists = async (filePath) => {
      if (injectReplacement && normalize(filePath) === prepared.journal.progressPath) {
        injectReplacement = false;
        await fixture.memoryFs.writeText(journalPath, foreignJournal);
      }
      return await exists(filePath);
    };
    await assert.rejects(store.finalizeAfterReport(prepared.journal), /state changed during cleanup/i);
    assert.equal(await fixture.memoryFs.readText(journalPath), foreignJournal);
  });

  await runTest("changed QA Vault marker cannot authorize cleanup of an older session", async () => {
    const fixture = createFixture();
    await addMarker(fixture.memoryFs);
    const store = new MobileQaSessionStore(fixture.plugin, fixture.ports, OWNER);
    const prepared = await store.prepare(SESSION, PROFILE);
    await fixture.memoryFs.writeText(MARKER_PATH, JSON.stringify({
      schemaVersion: 1,
      purpose: "local-image-compress-mobile-qa",
      allowDestructiveQa: true,
      vaultId: "d".repeat(32)
    }));
    const cleanup = await store.restoreAndCleanup(prepared, true);
    assert.equal(cleanup.status, "fail");
    assert.match(cleanup.errors.join(" "), /Vault identity changed/i);
    assert.equal(await fixture.memoryFs.exists(prepared.journal.sessionRoot), true);
  });

  await runTest("unknown session child blocks cleanup before any owned file is removed", async () => {
    const fixture = createFixture();
    await addMarker(fixture.memoryFs);
    const store = new MobileQaSessionStore(fixture.plugin, fixture.ports, OWNER);
    const prepared = await store.prepare(SESSION, PROFILE);
    const markerPath = `${prepared.journal.sessionRoot}/.qa-session-owner.json`;
    const foreignPath = `${prepared.journal.sessionRoot}/foreign-evidence.txt`;
    await fixture.memoryFs.writeText(foreignPath, "foreign");
    const cleanup = await store.restoreAndCleanup(prepared, true);
    assert.equal(cleanup.status, "fail");
    assert.match(cleanup.errors.join(" "), /unknown file/i);
    assert.equal(await fixture.memoryFs.exists(markerPath), true, "owned marker was removed before unknown-child preflight failed");
    assert.equal(await fixture.memoryFs.readText(foreignPath), "foreign");
  });

  await runTest("changed owner marker blocks cleanup and is preserved", async () => {
    const fixture = createFixture();
    await addMarker(fixture.memoryFs);
    const store = new MobileQaSessionStore(fixture.plugin, fixture.ports, OWNER);
    const prepared = await store.prepare(SESSION, PROFILE);
    const markerPath = `${prepared.journal.sessionRoot}/.qa-session-owner.json`;
    await fixture.memoryFs.writeText(markerPath, "changed-marker");
    const cleanup = await store.restoreAndCleanup(prepared, true);
    assert.equal(cleanup.status, "fail");
    assert.match(cleanup.errors.join(" "), /JSON|marker/i);
    assert.equal(await fixture.memoryFs.readText(markerPath), "changed-marker");
  });

  await runTest("foreign journal is retained and ignored", async () => {
    const fixture = createFixture();
    await addMarker(fixture.memoryFs);
    const foreignPath = `${PRIVATE_STATE_ROOT}/${"d".repeat(32)}/${"e".repeat(32)}.json`;
    await fixture.memoryFs.writeText(foreignPath, "foreign-evidence");
    const store = new MobileQaSessionStore(fixture.plugin, fixture.ports, OWNER);
    const recovery = await store.recoverOwnedSessions(PROFILE);
    assert.equal(recovery.status, "not-required");
    assert.equal(await fixture.memoryFs.readText(foreignPath), "foreign-evidence");
  });

  await runTest("corrupt local journal is retained", async () => {
    const fixture = createFixture();
    await addMarker(fixture.memoryFs);
    const corruptPath = `${PRIVATE_STATE_ROOT}/${OWNER}/${SESSION}.json`;
    await fixture.memoryFs.writeText(corruptPath, "{not-json");
    const store = new MobileQaSessionStore(fixture.plugin, fixture.ports, OWNER);
    const recovery = await store.recoverOwnedSessions(PROFILE);
    assert.equal(recovery.status, "fail");
    assert.deepEqual(recovery.retainedJournals, [corruptPath]);
    assert.equal(await fixture.memoryFs.readText(corruptPath), "{not-json");
  });

  for (const [field, injectedPath] of [
    ["progressPath", PRODUCT_CACHE],
    ["reportJsonPath", PRODUCT_CACHE]
  ]) {
    await runTest(`self-consistent journal cannot redirect ${field}`, async () => {
      const fixture = createFixture();
      await addMarker(fixture.memoryFs);
      const store = new MobileQaSessionStore(fixture.plugin, fixture.ports, OWNER);
      const prepared = await store.prepare(SESSION, PROFILE);
      const journalPath = `${PRIVATE_STATE_ROOT}/${OWNER}/${SESSION}.json`;
      const envelope = JSON.parse(await fixture.memoryFs.readText(journalPath));
      envelope.journal[field] = injectedPath;
      envelope.sha256 = sha256(JSON.stringify(envelope.journal));
      await fixture.memoryFs.writeText(journalPath, `${JSON.stringify(envelope)}\n`);
      const recovery = await store.recoverOwnedSessions(PROFILE);
      assert.equal(recovery.status, "fail");
      assert.deepEqual(recovery.retainedJournals, [journalPath]);
      assert.equal(await fixture.memoryFs.readText(PRODUCT_CACHE), fixture.productCacheText);
      assert.equal(await fixture.memoryFs.exists(prepared.journal.sessionRoot), true);
    });
  }

  await runTest("concurrent product-cache change is retained without overwrite", async () => {
    const fixture = createFixture();
    await addMarker(fixture.memoryFs);
    const store = new MobileQaSessionStore(fixture.plugin, fixture.ports, OWNER);
    const prepared = await store.prepare(SESSION, PROFILE);
    const concurrentCache = `${JSON.stringify(cacheData("Images/synced.jpg"))}\n`;
    await fixture.memoryFs.writeText(PRODUCT_CACHE, concurrentCache);
    const cleanup = await store.restoreAndCleanup(prepared, true);
    assert.equal(cleanup.status, "fail");
    assert.equal(cleanup.productCacheUntouched, false);
    assert.equal(await fixture.memoryFs.readText(PRODUCT_CACHE), concurrentCache);
    assert.equal(await fixture.memoryFs.exists(prepared.journal.sessionRoot), true);
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
