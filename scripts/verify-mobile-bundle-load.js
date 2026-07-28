"use strict";

const assert = require("node:assert/strict");
const { webcrypto } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { resolveRepositoryLayout } = require("./repository-layout");

const { repositoryRoot, sourceRoot } = resolveRepositoryLayout();
const qaProfile = process.argv.includes("--qa");
const bundlePath = qaProfile
  ? path.join(repositoryRoot, "mobile-qa-build", "main.js")
  : path.join(sourceRoot, "dist-ts", "main.js");
const bundle = fs.readFileSync(bundlePath, "utf8");
const profileProgress = [];
const VALID_JPEG_OUTPUT = Uint8Array.from(
  atob("/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAMDAwMDAwQEBAQFBQUFBQcHBgYHBwsICQgJCAsRCwwLCwwLEQ8SDw4PEg8bFRMTFRsfGhkaHyYiIiYwLTA+PlQBAwMDAwMDBAQEBAUFBQUFBwcGBgcHCwgJCAkICxELDAsLDAsRDxIPDg8SDxsVExMVGx8aGRofJiIiJjAtMD4+VP/CABEIAAEAAQMBEQACEQEDEQH/xAAmAAEAAAAAAAAAAAAAAAAAAAAJAQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAAqj//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8Af//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Af//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Af//Z"),
  (character) => character.charCodeAt(0)
);

function createJpegInput(byteLength = 4096) {
  const bytes = new Uint8Array(byteLength);
  bytes.set(VALID_JPEG_OUTPUT.subarray(0, VALID_JPEG_OUTPUT.byteLength - 2));
  bytes.set([0xff, 0xd9], byteLength - 2);
  return bytes;
}

class FakeElement {
  constructor(ownerDocument) {
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.attributes = new Map();
    this.classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)),
      contains: (name) => this.classes.has(name)
    };
    this.isConnected = true;
    this.textContent = "";
  }

  addClass(...names) { this.classList.add(...names); return this; }
  removeClass(...names) { this.classList.remove(...names); return this; }
  addEventListener() {}
  removeEventListener() {}
  appendChild(child) { this.children.push(child); return child; }
  contains(child) { return child === this || this.children.includes(child); }
  createDiv() { return this.appendChild(new FakeElement(this.ownerDocument)); }
  createEl() { return this.appendChild(new FakeElement(this.ownerDocument)); }
  createSpan() { return this.appendChild(new FakeElement(this.ownerDocument)); }
  empty() { this.children = []; this.textContent = ""; }
  focus() { this.ownerDocument.activeElement = this; }
  hide() { this.hidden = true; return this; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  remove() { this.isConnected = false; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  setText(value) { this.textContent = String(value); return this; }
  show() { this.hidden = false; return this; }
}

function createBrowserDom() {
  let nextTimerId = 1;
  const timers = new Map();
  const storage = new Map();
  const document = {
    activeElement: null,
    addEventListener() {},
    removeEventListener() {},
    createElement() { return new FakeElement(document); },
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  document.body = new FakeElement(document);
  document.documentElement = new FakeElement(document);
  document.activeElement = document.body;
  const window = {
    document,
    navigator: { hardwareConcurrency: 4 },
    innerHeight: 800,
    innerWidth: 1200,
    crypto: webcrypto,
    localStorage: {
      getItem: (key) => storage.get(String(key)) ?? null,
      removeItem: (key) => storage.delete(String(key)),
      setItem: (key, value) => storage.set(String(key), String(value))
    },
    addEventListener() {},
    removeEventListener() {},
    setTimeout(callback, delay = 0) {
      const id = nextTimerId++;
      const handle = globalThis.setTimeout(() => {
        timers.delete(id);
        callback();
      }, delay);
      handle.unref?.();
      timers.set(id, handle);
      return id;
    },
    clearTimeout(id) {
      const handle = timers.get(id);
      if (handle) globalThis.clearTimeout(handle);
      timers.delete(id);
    },
    requestAnimationFrame(callback) { return this.setTimeout(() => callback(Date.now()), 0); },
    cancelAnimationFrame(id) { this.clearTimeout(id); }
  };
  document.defaultView = window;
  return { document, window };
}

class BrowserLikeBlob {
  constructor(parts, options) {
    this.parts = parts;
    this.type = options?.type || "";
  }
}

class ObsidianBase {
  constructor(app, manifest) {
    this.app = app;
    this.manifest = manifest;
    this.containerEl = app?.workspace?.activeDocument?.createElement?.("div") || new FakeElement(null);
    this.children = [];
    this.registeredCallbacks = [];
    this.registeredCommands = [];
  }

  addCommand(command) { this.registeredCommands.push(command); return command; }
  addRibbonIcon(_icon, _title, callback) {
    const element = new FakeElement(this.app.workspace.activeDocument);
    element.callback = callback;
    return element;
  }
  addSettingTab() {}
  addStatusBarItem() { return new FakeElement(this.app.workspace.activeDocument); }
  async loadData() { return {}; }
  register(callback) {
    this.registeredCallbacks.push(callback);
    return callback;
  }
  registerDomEvent(target, event, callback, options) {
    target.addEventListener?.(event, callback, options);
    this.register(() => target.removeEventListener?.(event, callback, options));
  }
  addChild(component) {
    this.children.push(component);
    return component;
  }
  removeChild(component) {
    this.children = this.children.filter((child) => child !== component);
    component.unload?.();
  }
  unload() {
    for (const child of this.children.splice(0)) {
      child.unload?.();
    }
    for (const callback of this.registeredCallbacks.splice(0).reverse()) {
      callback();
    }
  }
  registerEvent(eventRef) { return eventRef; }
  registerInterval(intervalId) { return intervalId; }
  async saveData() {}
}

class ObsidianNotice {}

class ObsidianTFile {
  constructor(vault, filePath, stat) {
    this.vault = vault;
    this.path = normalizeVaultPath(filePath);
    this.name = this.path.split("/").pop();
    this.extension = this.name.includes(".") ? this.name.split(".").pop() : "";
    this.basename = this.extension ? this.name.slice(0, -(this.extension.length + 1)) : this.name;
    this.parent = null;
    this.stat = stat;
  }
}

class ObsidianTFolder {}

function normalizeVaultPath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}

function createMemoryAdapter(caseInsensitive) {
  const files = new Map();
  const directories = new Map([["", ""]]);
  let nextMtime = 10;
  let createArrayBuffer = (bytes) => Uint8Array.from(bytes).buffer;
  const keyOf = (value) => {
    const normalized = normalizeVaultPath(value);
    return caseInsensitive ? normalized.toLowerCase() : normalized;
  };
  const ensureDirectories = (filePath) => {
    const parts = normalizeVaultPath(filePath).split("/").filter(Boolean);
    parts.pop();
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      directories.set(keyOf(current), current);
    }
  };
  const requireFile = (filePath) => {
    const file = files.get(keyOf(filePath));
    if (!file) {
      const error = new Error(`ENOENT: ${filePath}`);
      error.code = "ENOENT";
      throw error;
    }
    return file;
  };
  const toBytes = (value) => typeof value === "string"
    ? new TextEncoder().encode(value)
    : new Uint8Array(value).slice();

  return {
    setArrayBufferFactory(factory) {
      createArrayBuffer = factory;
    },
    async exists(filePath) {
      const key = keyOf(filePath);
      return files.has(key) || directories.has(key);
    },
    async mkdir(dirPath) {
      ensureDirectories(`${normalizeVaultPath(dirPath)}/child`);
      directories.set(keyOf(dirPath), normalizeVaultPath(dirPath));
    },
    async read(filePath) {
      return new TextDecoder().decode(requireFile(filePath).bytes);
    },
    async write(filePath, value) {
      const normalized = normalizeVaultPath(filePath);
      ensureDirectories(normalized);
      files.set(keyOf(normalized), { path: normalized, bytes: toBytes(String(value)), mtime: nextMtime++ });
    },
    async readBinary(filePath) {
      const bytes = requireFile(filePath).bytes;
      return createArrayBuffer(bytes);
    },
    async writeBinary(filePath, value) {
      const normalized = normalizeVaultPath(filePath);
      ensureDirectories(normalized);
      files.set(keyOf(normalized), { path: normalized, bytes: toBytes(value), mtime: nextMtime++ });
    },
    async copy(sourcePath, targetPath) {
      const source = requireFile(sourcePath);
      const normalized = normalizeVaultPath(targetPath);
      ensureDirectories(normalized);
      files.set(keyOf(normalized), { path: normalized, bytes: source.bytes.slice(), mtime: nextMtime++ });
    },
    async trashLocal(filePath) {
      const source = requireFile(filePath);
      const trashPath = `.trash-local/${nextMtime}-${normalizeVaultPath(filePath).replaceAll("/", "-")}`;
      ensureDirectories(trashPath);
      files.set(keyOf(trashPath), { path: trashPath, bytes: source.bytes.slice(), mtime: nextMtime++ });
      files.delete(keyOf(filePath));
    },
    async remove(filePath) {
      if (!files.delete(keyOf(filePath))) {
        const error = new Error(`ENOENT: ${filePath}`);
        error.code = "ENOENT";
        throw error;
      }
    },
    async rename(sourcePath, targetPath) {
      const sourceKey = keyOf(sourcePath);
      const source = requireFile(sourcePath);
      const normalized = normalizeVaultPath(targetPath);
      const targetKey = keyOf(normalized);
      if (files.has(targetKey) || directories.has(targetKey)) {
        throw new Error(`EEXIST: ${targetPath}`);
      }
      ensureDirectories(normalized);
      files.set(targetKey, { path: normalized, bytes: source.bytes, mtime: nextMtime++ });
      files.delete(sourceKey);
    },
    async rmdir(dirPath, recursive) {
      const normalized = normalizeVaultPath(dirPath);
      const prefix = `${normalized}/`;
      const children = [
        ...[...files.values()].filter((file) => file.path.startsWith(prefix)),
        ...[...directories.values()].filter((directory) => directory.startsWith(prefix))
      ];
      if (!recursive && children.length > 0) {
        throw new Error(`ENOTEMPTY: ${dirPath}`);
      }
      if (recursive) {
        for (const [key, file] of files) {
          if (file.path.startsWith(prefix)) files.delete(key);
        }
        for (const [key, directory] of directories) {
          if (directory.startsWith(prefix)) directories.delete(key);
        }
      }
      directories.delete(keyOf(normalized));
    },
    async list(dirPath) {
      const normalized = normalizeVaultPath(dirPath);
      const prefix = normalized ? `${normalized}/` : "";
      const immediate = (candidate) => {
        if (!candidate.startsWith(prefix)) return false;
        return !candidate.slice(prefix.length).includes("/");
      };
      return {
        files: [...files.values()].map((file) => file.path).filter(immediate),
        folders: [...directories.values()].filter((dir) => dir && immediate(dir))
      };
    },
    async stat(filePath) {
      const key = keyOf(filePath);
      const file = files.get(key);
      if (file) {
        return { ctime: file.mtime, mtime: file.mtime, size: file.bytes.byteLength, type: "file" };
      }
      if (directories.has(key)) {
        return { ctime: 1, mtime: 1, size: 0, type: "folder" };
      }
      return null;
    },
    async process(filePath, update) {
      const current = await this.read(filePath);
      const next = update(current);
      await this.write(filePath, next);
      return next;
    }
  };
}

function createApp(adapter, window, document) {
  const eventRef = {};
  const vaultFiles = [];
  const findVaultFile = (filePath) => {
    const normalized = normalizeVaultPath(filePath);
    return vaultFiles.find((file) => file.path === normalized) || null;
  };
  const vault = {
    adapter,
    configDir: ".obsidian",
    getAbstractFileByPath(filePath) { return findVaultFile(filePath); },
    getFileByPath(filePath) { return findVaultFile(filePath); },
    getAllLoadedFiles() { return [...vaultFiles]; },
    getFiles() { return [...vaultFiles]; },
    async createBinary(filePath, data) {
      if (await adapter.exists(filePath)) {
        throw new Error(`EEXIST: ${filePath}`);
      }
      await adapter.writeBinary(filePath, data);
    },
    async readBinary(file) { return await adapter.readBinary(file.path); },
    on() { return eventRef; }
  };
  vault.addFile = async (filePath) => {
    const stat = await adapter.stat(filePath);
    const file = new ObsidianTFile(vault, filePath, {
      ctime: stat?.ctime || 0,
      mtime: stat?.mtime || 0,
      size: stat?.size || 0
    });
    vaultFiles.push(file);
    return file;
  };
  return {
    vault,
    workspace: {
      activeDocument: document,
      activeWindow: window,
      getActiveFile() { return null; },
      getActiveViewOfType() { return null; },
      getLeavesOfType() { return []; },
      iterateAllLeaves() {},
      on() { return eventRef; },
      onLayoutReady(callback) { this.layoutReadyCallback = callback; }
    },
    metadataCache: {
      getFileCache() { return null; },
      on() { return eventRef; }
    },
    plugins: {
      enabledPlugins: new Set(),
      manifests: {}
    }
  };
}

async function verifyMobilePlatform(platformName, platform) {
  const markProgress = (step) => profileProgress.push(`${platformName}:${step}`);
  const caseInsensitive = platform.isIosApp === true;
  const { document, window } = createBrowserDom();
  const adapter = createMemoryAdapter(caseInsensitive);
  const app = createApp(adapter, window, document);
  const obsidian = new Proxy({
    apiVersion: "test-app",
    Plugin: ObsidianBase,
    PluginSettingTab: ObsidianBase,
    Modal: ObsidianBase,
    FuzzySuggestModal: ObsidianBase,
    Notice: ObsidianNotice,
    TFile: ObsidianTFile,
    TFolder: ObsidianTFolder,
    Platform: {
      isDesktop: false,
      isDesktopApp: false,
      isMobile: true,
      isMobileApp: true,
      ...platform
    },
    getLanguage: () => "en",
    normalizePath: normalizeVaultPath,
    requireApiVersion: () => false
  }, {
    get(target, property) {
      return property in target ? target[property] : ObsidianBase;
    }
  });
  const moduleRecord = { exports: {} };
  const browserUrl = {
    createObjectURL: () => `blob:${platformName}`,
    revokeObjectURL() {}
  };
  const context = vm.createContext({
    atob,
    Blob: BrowserLikeBlob,
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    console,
    crypto: webcrypto,
    document,
    exports: moduleRecord.exports,
    HTMLElement: FakeElement,
    module: moduleRecord,
    navigator: window.navigator,
    localStorage: window.localStorage,
    performance: { now: () => Date.now() },
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    require(moduleName) {
      if (moduleName === "obsidian") {
        return obsidian;
      }
      throw new Error(`Unexpected module load during ${platformName} startup: ${moduleName}`);
    },
    setTimeout: window.setTimeout.bind(window),
    TextDecoder,
    TextEncoder,
    URL: browserUrl,
    window
  });
  adapter.setArrayBufferFactory(vm.runInContext("(bytes) => Uint8Array.from(bytes).buffer", context));

  context.__validJpegBytes = [...VALID_JPEG_OUTPUT];
  vm.runInContext(`
    {
      const encodedOutput = Uint8Array.from(globalThis.__validJpegBytes);
      delete globalThis.__validJpegBytes;
      globalThis.Worker = class {
        constructor() {
          this.onmessage = null;
          this.onerror = null;
          this.terminated = false;
        }
        postMessage(message) {
          const response = message?.type === "init"
            ? { id: message.id, type: "ready" }
            : { id: message?.id, type: "result", ok: true, output: encodedOutput.slice().buffer };
          Promise.resolve().then(() => {
            if (!this.terminated) this.onmessage?.({ data: response });
          });
        }
        terminate() { this.terminated = true; }
      };
    }
  `, context);

  vm.runInContext(`
    Uint8Array.fromBase64 = undefined;
    if (typeof Buffer !== "undefined" || typeof process !== "undefined" || typeof global !== "undefined") {
      throw new Error("Node globals leaked into the mobile bundle context");
    }
  `, context);

  new vm.Script(bundle, { filename: bundlePath }).runInContext(context, { timeout: 10_000 });

  const PluginClass = moduleRecord.exports.default ?? moduleRecord.exports;
  assert.equal(typeof PluginClass, "function", `${platformName} bundle did not export the plugin class`);

  const plugin = new PluginClass(app, {
    dir: ".obsidian/plugins/local-image-compress",
    id: "local-image-compress",
    name: "Local Image Compress",
    version: "0.0.0"
  });
  plugin.onload();

  assert.equal(typeof app.workspace.layoutReadyCallback, "function", `${platformName} onload did not register layout initialization`);
  app.workspace.layoutReadyCallback();
  assert.equal(typeof plugin.initializationPromise?.then, "function", `${platformName} layout-ready did not start initialization`);
  await plugin.initializationPromise;
  markProgress("initialized");
  assert.equal(plugin.initializationError, null, `${platformName} initialization failed: ${plugin.initializationError}`);
  assert.equal(plugin.isInitialized, true, `${platformName} initialization did not complete`);
  assert(plugin.cache && plugin.compressor, `${platformName} initialization did not create runtime services`);
  assert.equal(plugin.cache.lastLoadError, null, `${platformName} initialization recovered from a hidden cache error`);
  const mobileQaCommands = plugin.registeredCommands.filter((command) => command?.id === "run-mobile-runtime-qa");
  if (qaProfile) {
    assert.equal(mobileQaCommands.length, 1, `${platformName} QA bundle did not register exactly one mobile QA command`);
    assert.equal(plugin.__LIC_MOBILE_QA_RUN__?.version, 1, `${platformName} QA bundle did not expose the versioned mobile QA bridge`);
    await assert.rejects(
      plugin.__LIC_MOBILE_QA_RUN__.start(),
      /marker is missing/i,
      `${platformName} QA bridge did not re-check the marker before start`
    );
    const qaPorts = plugin.getPlatformPorts();
    const ownerId = window.localStorage.getItem("local-image-compress.mobile-qa-device-owner.v1");
    assert.match(ownerId, /^[a-f0-9]{32}$/, `${platformName} QA device owner is not durable`);
    const qaStateRoot = qaPorts.fs.joinPath(plugin.getPluginDirectory(), "qa-backups", "mobile");
    await qaPorts.fs.writeText(".local-image-compress-qa/qa-vault-marker.json", JSON.stringify({
      schemaVersion: 1,
      purpose: "local-image-compress-mobile-qa",
      allowDestructiveQa: true,
      vaultId: "c".repeat(32)
    }));
    await qaPorts.fs.writeText(
      qaPorts.fs.joinPath(qaStateRoot, ownerId, `${"d".repeat(32)}.json`),
      "{corrupt"
    );
    await assert.rejects(
      plugin.__LIC_MOBILE_QA_RUN__.start(),
      /recovery retained ambiguous safety state/i,
      `${platformName} QA bridge did not re-scan journals immediately before start`
    );
  } else {
    assert.equal(mobileQaCommands.length, 0, `${platformName} production bundle registered the mobile QA command`);
    assert.equal(plugin.__LIC_MOBILE_QA_RUN__, undefined, `${platformName} production bundle exposed the mobile QA bridge`);
  }

  const ports = plugin.getPlatformPorts();
  assert.equal(ports.fs.sync, null, `${platformName} selected a desktop filesystem port`);
  assert.equal(ports.runtime.isCaseInsensitiveFs, caseInsensitive, `${platformName} filesystem case-sensitivity flag is wrong`);
  await ports.fs.writeText("Case/Photo.txt", "case-probe");
  assert.equal(await ports.fs.exists("case/photo.txt"), caseInsensitive, `${platformName} adapter case behavior is wrong`);

  const cacheBackupName = "tinyLocal-cache-backup-2026-07-13T00-00-00-000.json";
  const cacheBackupPath = `.local-image-compress/backups/cache/${cacheBackupName}`;
  await ports.fs.writeText(cacheBackupPath, JSON.stringify({
    version: plugin.cache.CACHE_VERSION,
    entries: {
      "browser-restore-marker": {
        path: "Images/browser-restored.jpg",
        timestamp: 1,
        originalSize: 1
      }
    }
  }));
  assert.equal(await plugin.cache.restoreFromBackup(cacheBackupName), true, `${platformName} adapter-safe cache restore failed`);
  assert.equal(plugin.cache.getEntriesForPath("Images/browser-restored.jpg").length, 1, `${platformName} cache restore did not update memory`);
  markProgress("restored");

  const sourcePath = "Images/browser-deep.jpg";
  const sourceBytes = createJpegInput();
  await ports.fs.writeBinary(sourcePath, sourceBytes.buffer.slice(sourceBytes.byteOffset, sourceBytes.byteOffset + sourceBytes.byteLength));
  const sourceFile = await app.vault.addFile(sourcePath);
  const sourceBeforeCompression = new Uint8Array(await ports.fs.readBinary(sourcePath));
  const settings = { ...plugin.settings, outputFolder: "Compressed" };
  markProgress("compress-start");
  const compressionResult = await plugin.compressor.compress(sourceFile, settings, {
    sourcePath,
    sourceMtime: sourceFile.stat.mtime
  });
  markProgress("compress-result");
  const sourceAfterCompression = new Uint8Array(await ports.fs.readBinary(sourcePath));
  const firstSourceMismatch = sourceBeforeCompression.findIndex((byte, index) => byte !== sourceAfterCompression[index]);
  assert.equal(firstSourceMismatch, -1, `${platformName} compression mutated source bytes at offset ${firstSourceMismatch}`);
  assert.equal(compressionResult.success, true, `${platformName} browser-like compression failed: ${compressionResult.error || compressionResult.skipReason || "unknown"}`);
  await plugin.cache.addCompressionArtifact(compressionResult.artifact);
  markProgress("artifact-cached");
  await plugin.cache.flushPendingCacheSave();
  markProgress("compressed");
  assert.equal(await ports.fs.exists(compressionResult.artifact.outputPath), true, `${platformName} compression output was not installed`);

  const moveRecord = {
    compressedPath: compressionResult.artifact.outputPath,
    relativePath: sourcePath,
    name: sourceFile.name,
    size: compressionResult.artifact.outputSize
  };
  const sourceStatBeforeMove = await ports.fs.stat(sourcePath);
  const outputStatBeforeMove = await ports.fs.stat(compressionResult.artifact.outputPath);
  const pendingEntry = plugin.cache.getEntriesForPath(sourcePath)[0]?.[1];
  const observedSourceSha256 = await ports.hash.fileSha256Hex(sourcePath);
  const observedOutputSha256 = await ports.hash.fileSha256Hex(compressionResult.artifact.outputPath);
  const pendingMoveProbe = await plugin.cache.resolvePendingMoveEntry({
    path: sourcePath,
    stat: { mtime: sourceStatBeforeMove.mtimeMs, size: sourceStatBeforeMove.size },
    sourceSha256: observedSourceSha256,
    outputSha256: observedOutputSha256
  }, compressionResult.artifact.outputPath);
  assert.equal(
    pendingMoveProbe.status,
    "match",
    `${platformName} immutable compression artifact did not match its exact source/output: ${JSON.stringify({
      artifact: compressionResult.artifact,
      sourceStatBeforeMove,
      outputStatBeforeMove,
      observedSourceSha256,
      observedOutputSha256,
      modern: plugin.cache.compaction.isModernCompactionEntry(pendingEntry),
      sourceMatches: plugin.cache.sourceMatchesCurrentFile(pendingEntry, { path: sourcePath, stat: { mtime: sourceStatBeforeMove.mtimeMs, size: sourceStatBeforeMove.size } }),
      outputMatches: await plugin.cache.outputMatchesEntry(pendingEntry),
      entries: plugin.cache.getEntriesForPath(sourcePath)
    })}`
  );
  const backupResult = await plugin.moveService.createBackupBeforeMove([moveRecord]);
  assert.equal(
    backupResult.files.length,
    1,
    `${platformName} move preflight did not create a verified task: ${moveRecord.moveSkipReason || backupResult.errorCount || "unknown"}`
  );
  await plugin.moveService.moveSingleFile(backupResult.files[0]);
  const movedBytes = new Uint8Array(await ports.fs.readBinary(sourcePath));
  assert.equal(movedBytes.byteLength, compressionResult.artifact.outputSize, `${platformName} move did not replace the original`);
  assert.equal(await ports.fs.exists(compressionResult.artifact.outputPath), false, `${platformName} move did not remove its compressed artifact`);
  markProgress("moved");

  await ports.fs.writeText("Migration/browser-source.json", "migration-payload");
  await plugin.migrationRunner.moveOrCopyMigrationItem("Migration/browser-source.json", "Migration/browser-target.json");
  assert.equal(await ports.fs.readText("Migration/browser-target.json"), "migration-payload", `${platformName} migration did not preserve bytes`);
  assert.equal(await ports.fs.exists("Migration/browser-source.json"), false, `${platformName} migration left its source behind`);
  await ports.fs.recoverInterruptedReplacement();
  await plugin.migrationRunner.recoverMigrationQuarantineJournals();
  markProgress("migrated");

  vm.runInContext(`
    if (typeof Buffer !== "undefined" || typeof process !== "undefined" || typeof global !== "undefined"
      || typeof __dirname !== "undefined" || typeof __filename !== "undefined") {
      throw new Error("Node globals leaked during deep mobile execution");
    }
  `, context);

  plugin.onunload();
  markProgress("unloaded");
  assert.equal(plugin.isUnloading, true, `${platformName} unload did not enter cleanup state`);
}

const keepAlive = setInterval(() => {}, 1000);
const deepProfiles = Promise.all([
  verifyMobilePlatform("iOS", { isAndroidApp: false, isIosApp: true }),
  verifyMobilePlatform("Android", { isAndroidApp: true, isIosApp: false })
]);
let timeoutHandle;
const timeout = new Promise((_, reject) => {
  timeoutHandle = setTimeout(() => reject(new Error(`Mobile browser-like deep profiles timed out: ${profileProgress.join(", ")}`)), 20_000);
});
Promise.race([deepProfiles, timeout]).then(() => {
  process.stdout.write(`${qaProfile ? "Mobile QA" : "Mobile"} bundle browser-like deep gate passed for iOS and Android profiles.\n`);
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  clearTimeout(timeoutHandle);
  clearInterval(keepAlive);
});
