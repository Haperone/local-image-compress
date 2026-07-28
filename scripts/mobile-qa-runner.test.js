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
const MARKER_PATH = ".local-image-compress-qa/qa-vault-marker.json";
const PRODUCT_CACHE = ".obsidian/plugins/local-image-compress/tinyLocal-cache.json";

function normalize(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\/{2,}/g, "/");
}

class MockTFile {
  constructor(filePath, size = 100) {
    this.path = normalize(filePath);
    this.name = this.path.split("/").pop() || "";
    this.extension = this.name.includes(".") ? this.name.split(".").pop() : "";
    this.stat = { size, mtime: 1, ctime: 1 };
  }
}

class MockTFolder {
  constructor(folderPath) { this.path = normalize(folderPath); }
}

function compileRunner() {
  const outputPath = path.join(os.tmpdir(), `lic-mobile-qa-runner-${process.pid}-${crypto.randomBytes(6).toString("hex")}.cjs`);
  runEsbuildCli([
    path.join("src-ts", "qa", "mobile-runner.ts"),
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=es2020",
    "--external:obsidian",
    "--define:__LIC_MOBILE_QA_FINGERPRINT__=\"mobile-qa-src-test\"",
    `--outfile=${outputPath}`,
    "--log-level=silent"
  ], { cwd: sourceRoot, stdio: "pipe" });
  const originalLoad = Module._load;
  Module._load = function loadWithObsidianMock(request, parent, isMain) {
    if (request === "obsidian") {
      return new Proxy({
        apiVersion: "test-app",
        Platform: { isMobile: true, isAndroidApp: true, isIosApp: false },
        TFile: MockTFile,
        TFolder: MockTFolder,
        normalizePath: normalize
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
  }
  joinPath(...parts) { return normalize(parts.filter(Boolean).join("/")); }
  dirnamePath(filePath) { return normalize(filePath).split("/").slice(0, -1).join("/"); }
  async exists(filePath) { return this.files.has(normalize(filePath)) || this.directories.has(normalize(filePath)); }
  async mkdir(dirPath) {
    let current = "";
    for (const part of normalize(dirPath).split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      this.directories.add(current);
    }
  }
  async readText(filePath) {
    const value = this.files.get(normalize(filePath));
    if (value === undefined) throw new Error(`ENOENT ${filePath}`);
    return value;
  }
  async writeText(filePath, text) {
    await this.mkdir(this.dirnamePath(filePath));
    this.files.set(normalize(filePath), String(text));
  }
  async processTextAtomically(filePath, initialText, update) {
    const normalized = normalize(filePath);
    await this.mkdir(this.dirnamePath(normalized));
    const current = this.files.has(normalized) ? this.files.get(normalized) : String(initialText);
    const next = String(update(current));
    this.files.set(normalized, next);
    return next;
  }
  async listNames(dirPath) {
    const prefix = normalize(dirPath) ? `${normalize(dirPath)}/` : "";
    const names = new Set();
    for (const item of [...this.files.keys(), ...this.directories]) {
      if (item.startsWith(prefix)) {
        const name = item.slice(prefix.length).split("/")[0];
        if (name) names.add(name);
      }
    }
    return [...names];
  }
  async listEntries(dirPath) {
    const normalized = normalize(dirPath);
    return (await this.listNames(normalized)).map((name) => {
      const entryPath = normalize(`${normalized}/${name}`);
      return { name, isFile: this.files.has(entryPath), isDirectory: this.directories.has(entryPath), isSymbolicLink: false };
    });
  }
  async stat(filePath) {
    const normalized = normalize(filePath);
    if (this.directories.has(normalized)) return { mtimeMs: 1, size: 0, isDirectory: true };
    if (this.files.has(normalized)) return { mtimeMs: 1, size: Buffer.byteLength(this.files.get(normalized)), isDirectory: false };
    return null;
  }
  async removeDir(dirPath, options = { recursive: true }) {
    const normalized = normalize(dirPath);
    const prefix = `${normalized}/`;
    if (!options.recursive) {
      assert.equal([...this.files.keys()].some((filePath) => filePath.startsWith(prefix)), false);
      assert.equal([...this.directories].some((folderPath) => folderPath.startsWith(prefix)), false);
      this.directories.delete(normalized);
      return;
    }
    for (const filePath of [...this.files.keys()]) if (filePath.startsWith(prefix)) this.files.delete(filePath);
    for (const folderPath of [...this.directories]) {
      if (folderPath === normalized || folderPath.startsWith(prefix)) this.directories.delete(folderPath);
    }
  }
  async removeFileIfUnchanged(filePath, expectedSha256) {
    const normalized = normalize(filePath);
    const current = this.files.get(normalized);
    if (current === undefined || sha256(current) !== expectedSha256) return { removed: false, retainedConflictPath: normalized };
    this.files.delete(normalized);
    return { removed: true, retainedConflictPath: null };
  }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function settings() {
  return {
    pngQuality: { min: 65, max: 80 }, jpegQuality: 85, allowedRoots: ["Images"], outputFolder: "Compressed",
    autoCompressNewFiles: true, autoBackgroundCompression: true, autoBackgroundThreshold: 50,
    inactivityThresholdMinutes: 2, autoBackupsRetentionEnabled: true, autoBackupsRetentionDays: 30,
    autoMoveCompressedEnabled: true, autoMoveCompressedThreshold: 10
  };
}

async function createFixture(sessionId) {
  const memory = new MemoryFs();
  const persisted = { writes: 0 };
  const progress = [];
  const rebuilds = [];
  const productCache = JSON.stringify({ version: "2.0.0", entries: {} });
  await memory.writeText(PRODUCT_CACHE, productCache);
  await memory.writeText(MARKER_PATH, JSON.stringify({
    schemaVersion: 1, purpose: "local-image-compress-mobile-qa", allowDestructiveQa: true, vaultId: "c".repeat(32)
  }));
  const vault = {
    getAbstractFileByPath(filePath) {
      const normalized = normalize(filePath);
      if (memory.files.has(normalized)) return new MockTFile(normalized, memory.files.get(normalized).length);
      if (memory.directories.has(normalized)) return new MockTFolder(normalized);
      return null;
    },
    getFiles() { return [...memory.files.keys()].map((filePath) => new MockTFile(filePath, memory.files.get(filePath).length)); },
    async createFolder(folderPath) { await memory.mkdir(folderPath); },
    async create(filePath, text) { await memory.writeText(filePath, text); return new MockTFile(filePath, String(text).length); },
    async process(file, transform) { await memory.writeText(file.path, transform(await memory.readText(file.path))); },
    async delete(folder, recursive) { assert.equal(recursive, true); await memory.removeDir(folder.path); }
  };
  const ports = {
    fs: {
      sync: null,
      processTextAtomically: memory.processTextAtomically.bind(memory),
      joinPath: memory.joinPath.bind(memory), dirnamePath: memory.dirnamePath.bind(memory),
      exists: memory.exists.bind(memory), mkdir: memory.mkdir.bind(memory), readText: memory.readText.bind(memory),
      writeText: memory.writeText.bind(memory), listNames: memory.listNames.bind(memory),
      listEntries: memory.listEntries.bind(memory), stat: memory.stat.bind(memory), removeDir: memory.removeDir.bind(memory),
      removeFileIfUnchanged: memory.removeFileIfUnchanged.bind(memory)
    },
    hash: {
      sha256Hex: sha256,
      fileSha256Hex: async (filePath) => sha256(await memory.readText(filePath))
    },
    runtime: { revealPath: null }
  };
  const plugin = {
    manifest: { id: "local-image-compress", version: "2.0.0" },
    isInitialized: true,
    settings: settings(),
    settingsTab: null,
    app: {
      vault,
      workspace: { getLeavesOfType() { return []; } }
    },
    cache: {
      CACHE_VERSION: "2.0.0", cacheFile: PRODUCT_CACHE, cacheBackupsDir: ".local-image-compress/backups/cache",
      cacheData: { version: "2.0.0", entries: {} }, activeWritePromise: null,
      async flushPendingCacheSave() { return true; }, cancelPendingSave() {},
      async loadCache() { this.cacheData = JSON.parse(await memory.readText(this.cacheFile)); },
      isValidBackupFileName(fileName) { return /^tinyLocal-cache-backup-.+\.json$/.test(fileName); },
      async getAvailableBackups() {
        return (await memory.listNames(this.cacheBackupsDir))
          .filter((fileName) => this.isValidBackupFileName(fileName))
          .sort()
          .reverse();
      }
    },
    compressor: {
      getOutputPath(filePath, outputFolder) { return `${normalize(outputFolder)}/${normalize(filePath)}`; },
      async compress(file) { return { success: false, skipReason: `mock:${file.path}` }; }
    },
    moveService: { moveOperationInProgress: false },
    backgroundCompressionService: { isBackgroundCompressionRunning: false },
    newFileQueue: {
      newFileBatchDrainInProgress: false, newFileCompressionTimers: new Map(), newFileCompressionInFlight: new Set(),
      newFileCompressionPending: new Set(), newFileBatchFlushTimer: null, newFileBatchDrainRescheduleRequested: false
    },
    async waitForCompressionIdle() { return true; }, async waitForSettingsPersistenceIdle() { return true; },
    async saveSettings() { persisted.writes++; }, applyRuntimeSettings() {},
    getPluginDirectory() { return ".obsidian/plugins/local-image-compress"; },
    async rebuildImageIndex(reason) {
      rebuilds.push({ reason, sessionRootExists: await memory.exists(`QA-LIC-Mobile-${sessionId}`) });
    },
    getBackupStoragePaths() {
      return { root: ".local-image-compress", backupsRoot: ".local-image-compress/backups", cacheBackups: ".local-image-compress/backups/cache", originalFilesBackups: ".local-image-compress/backups/originals" };
    },
    getActiveWindow() { return global.window; }
  };
  return { memory, persisted, progress, rebuilds, plugin, ports };
}

async function runCase(MobileQaRunner, sessionId, scenarios, isCancellationRequested = () => false, configureFixture = null) {
  const fixture = await createFixture(sessionId);
  configureFixture?.(fixture);
  const runner = new MobileQaRunner({
    plugin: fixture.plugin, ports: fixture.ports, profile: "android", capabilities: {}, deviceOwnerId: OWNER,
    sessionId, recovery: { status: "not-required", recoveredSessions: 0, retainedJournals: [], errors: [] },
    scenarios, isCancellationRequested,
    async onProgress(value) { fixture.progress.push(value); }
  });
  return { fixture, report: await runner.run() };
}

async function main() {
  const listeners = new Map();
  global.window = {
    crypto: crypto.webcrypto,
    setTimeout,
    clearTimeout,
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener(type, listener) { if (listeners.get(type) === listener) listeners.delete(type); },
    dispatchQaEvent(type, event) { listeners.get(type)?.(event); }
  };
  const { MobileQaRunner, MobileQaSessionStore, detectMobileQaCapabilities, getMobileQaMoveBackupProofPaths, verifyMobileQaBackupTree } = compileRunner();

  const zeroRectRibbon = { isConnected: true, getBoundingClientRect() { return { width: 0, height: 0 }; } };
  const collapsedRibbonCapabilities = detectMobileQaCapabilities({
    getActiveDocument() {
      return {
        defaultView: {},
        querySelectorAll(selector) {
          return selector === ".side-dock-ribbon-action.tiny-local-status-trigger" ? [zeroRectRibbon] : [];
        }
      };
    }
  }, { fs: { sync: null }, runtime: { revealPath: null } });
  assert.equal(collapsedRibbonCapabilities.mobileRibbon, true, "Collapsed connected mobile ribbon was treated as unavailable");

  const backupFixture = await createFixture("f".repeat(32));
  assert.deepEqual(
    getMobileQaMoveBackupProofPaths(
      backupFixture.ports,
      ".obsidian/plugins/local-image-compress/qa-backups/mobile/device/session.state/backups/originals/backup-1/originals/QA/file.jpg",
      "QA/Compressed/QA/file.jpg"
    ),
    {
      originalBackupPath: ".obsidian/plugins/local-image-compress/qa-backups/mobile/device/session.state/backups/originals/backup-1/originals/QA/file.jpg",
      compressedBackupPath: ".obsidian/plugins/local-image-compress/qa-backups/mobile/device/session.state/backups/originals/backup-1/compressed/QA/Compressed/QA/file.jpg"
    }
  );
  const backupRoot = ".obsidian/plugins/local-image-compress/qa-backups/mobile/backup-proof";
  const expectedBackupPath = `${backupRoot}/batch/originals/image.jpg`;
  await backupFixture.memory.writeText(expectedBackupPath, "same-bytes");
  const expectedBackupFiles = new Map([[expectedBackupPath, sha256("same-bytes")]]);
  assert.deepEqual(
    await verifyMobileQaBackupTree(backupFixture.ports, backupRoot, expectedBackupFiles),
    [{ filePath: expectedBackupPath, sha256: sha256("same-bytes") }]
  );
  const foreignCopyPath = `${backupRoot}/batch/originals/foreign-copy.jpg`;
  await backupFixture.memory.writeText(foreignCopyPath, "same-bytes");
  await assert.rejects(
    verifyMobileQaBackupTree(backupFixture.ports, backupRoot, expectedBackupFiles),
    /unproven original-backup file/
  );
  backupFixture.memory.files.delete(foreignCopyPath);
  const originalListEntries = backupFixture.ports.fs.listEntries;
  backupFixture.ports.fs.listEntries = async (directoryPath) => directoryPath === backupRoot
    ? [{ name: "foreign-link", isFile: false, isDirectory: true, isSymbolicLink: true }]
    : await originalListEntries(directoryPath);
  await assert.rejects(
    verifyMobileQaBackupTree(backupFixture.ports, backupRoot, expectedBackupFiles),
    /symbolic link/
  );

  const pass = await runCase(MobileQaRunner, "1".repeat(32), [
    { id: "M04", name: "scope", async run({ plugin, sessionRoot }) {
      await plugin.saveSettings();
      await plugin.compressor.compress(
        new MockTFile(`${sessionRoot}/inside.jpg`),
        plugin.settings,
        { sourcePath: `${sessionRoot}/inside.jpg` }
      );
      return { ok: true };
    } },
    { id: "T02", name: "aggregate", async run() { return { aggregated: true }; } }
  ]);
  assert.equal(pass.report.summary.success, true);
  assert.equal(pass.report.appVersion, "test-app");
  assert.equal(pass.report.checks.find((check) => check.id === "M04").details.observedCompressionInputs, 1);
  assert.equal(pass.fixture.persisted.writes, 0);
  assert.equal(pass.report.warnings.length, 0);
  assert.equal(listeners.size, 0, "Runner retained global error listeners after completion");
  assert.equal(pass.fixture.progress.at(-1).completed, pass.fixture.progress.at(-1).total);
  assert.deepEqual(pass.fixture.rebuilds.map((entry) => entry.reason), ["mobile-qa-start", "mobile-qa-restore"]);
  assert.equal(pass.fixture.rebuilds.at(-1).sessionRootExists, false, "Product index rebuilt before QA root deletion");

  const persistedCacheIdentity = await runCase(MobileQaRunner, "e".repeat(32), [
    { id: "T-CACHE", name: "persisted cache identity", async run({ plugin, ports }) {
      plugin.cache.serializeForDisk = () => "different-in-memory-cache";
      await ports.fs.writeText(plugin.cache.cacheFile, JSON.stringify({ version: "2.0.0", entries: { persisted: {} } }));
    } }
  ]);
  assert.equal(persistedCacheIdentity.report.cleanup.status, "pass", "Cleanup did not bind isolated cache ownership to persisted bytes");

  const cacheBackupOwnership = await runCase(MobileQaRunner, "b".repeat(32), [
    { id: "T-BACKUP", name: "cache backup ownership", async run({ plugin, ports }) {
      const backupPath = ports.fs.joinPath(
        plugin.cache.cacheBackupsDir,
        "tinyLocal-cache-backup-2026-07-23T00-00-00-000-owned.json"
      );
      await ports.fs.writeText(backupPath, JSON.stringify({ version: "2.0.0", entries: {} }));
    } }
  ]);
  assert.equal(cacheBackupOwnership.report.cleanup.status, "pass", "Cleanup did not journal an isolated cache backup created by a scenario");

  const runnerSource = fs.readFileSync(path.join(sourceRoot, "src-ts", "qa", "mobile-runner.ts"), "utf8");
  assert.match(runnerSource, /fixtures: Map<string, string>/, "Mobile QA fixtures retain mutable TFile objects");
  assert.match(runnerSource, /const autoMovePath = autoMove\.path/, "Mobile QA auto-move does not capture a stable path before replacement");
  assert.match(runnerSource, /const createdBackups = backups\.filter\(\(backupName\) => !backupsBefore\.has\(backupName\)\)/, "Mobile QA M07 still rejects backups created by earlier scenarios");
  assert.match(runnerSource, /const menuTarget = triggerVisible[\s\S]*\? ribbonCandidate[\s\S]*height: 44[\s\S]*width: 44/, "Collapsed mobile ribbon does not use the QA-only visible menu anchor");
  assert.equal((runnerSource.match(/showMenu\(\{ target: menuTarget, returnFocusTo: ribbonCandidate \}\)/g) || []).length, 2, "Mobile QA menu checks do not consistently use the selected anchor");

  const failed = await runCase(MobileQaRunner, "2".repeat(32), [
    { id: "T01", name: "failure", async run() { throw new Error("expected failure"); } }
  ]);
  assert.equal(failed.report.summary.success, false);
  assert.match(failed.report.checks.find((check) => check.id === "T01").error, /expected failure/);
  assert.equal(failed.report.cleanup.status, "pass");

  const timedOut = await runCase(MobileQaRunner, "3".repeat(32), [
    { id: "T01", name: "timeout", timeoutMs: 2, async run() { await new Promise((resolve) => setTimeout(resolve, 20)); } }
  ]);
  assert.equal(timedOut.report.summary.success, false);
  assert.match(timedOut.report.checks.find((check) => check.id === "T01").error, /timed out/);
  assert.equal(timedOut.report.cleanup.status, "pass");

  const cancelled = await runCase(MobileQaRunner, "4".repeat(32), [
    { id: "T01", name: "cancelled", async run() { throw new Error("must not run"); } }
  ], () => true);
  assert.equal(cancelled.report.summary.cancelled, true);
  assert.equal(cancelled.report.summary.success, false);
  assert.equal(cancelled.report.checks.find((check) => check.id === "T01").status, "skip");

  const scopeBlocked = await runCase(MobileQaRunner, "5".repeat(32), [
    { id: "M04", name: "scope", async run({ plugin }) {
      await assert.rejects(plugin.compressor.compress(new MockTFile("Images/outside.jpg")), /outside its session root/);
    } }
  ]);
  assert.equal(scopeBlocked.report.summary.success, false);
  assert.match(scopeBlocked.report.checks.find((check) => check.id === "M04").error, /scope guard blocked/i);

  const runtimeError = await runCase(MobileQaRunner, "6".repeat(32), [
    { id: "T01", name: "runtime error", async run() {
      global.window.dispatchQaEvent("error", { error: new Error("failure at /storage/emulated/0/Vault/private.jpg"), message: "" });
    } }
  ]);
  assert.equal(runtimeError.report.summary.success, false);
  assert.equal(runtimeError.report.warnings.length, 1);
  assert(!runtimeError.report.warnings[0].includes("private.jpg"));
  assert.equal(runtimeError.report.checks.find((check) => check.id === "RUNTIME-ERRORS").status, "fail");
  assert.equal(listeners.size, 0, "Runner retained global error listeners after runtime failure");

  const originalFinalize = MobileQaSessionStore.prototype.finalizeAfterReport;
  MobileQaSessionStore.prototype.finalizeAfterReport = async () => { throw new Error("injected finalization failure"); };
  try {
    const finalizeFailed = await runCase(MobileQaRunner, "7".repeat(32), [
      { id: "T01", name: "passes before finalize", async run() {} }
    ]);
    assert.equal(finalizeFailed.report.summary.success, false);
    assert.equal(finalizeFailed.report.phase, "restoring");
    assert.match(finalizeFailed.report.checks.find((check) => check.id === "FINALIZE").error, /finalization failure/);
    const reportPath = [...finalizeFailed.fixture.memory.files.keys()].find((filePath) => filePath.includes("runtime-qa-report-"));
    assert(reportPath, "Finalization-failure report was not written");
    assert.equal(JSON.parse(await finalizeFailed.fixture.memory.readText(reportPath)).summary.success, false);
  } finally {
    MobileQaSessionStore.prototype.finalizeAfterReport = originalFinalize;
  }

  MobileQaSessionStore.prototype.finalizeAfterReport = async function finalizeWithLateRuntimeError(journal) {
    global.window.dispatchQaEvent("unhandledrejection", { reason: new Error("late finalization rejection") });
    return await originalFinalize.call(this, journal);
  };
  try {
    const lateRuntimeError = await runCase(MobileQaRunner, "8".repeat(32), [
      { id: "T01", name: "passes before late runtime error", async run() {} }
    ]);
    assert.equal(lateRuntimeError.report.summary.success, false);
    assert.equal(lateRuntimeError.report.checks.filter((check) => check.id === "RUNTIME-ERRORS").length, 1);
    assert.match(lateRuntimeError.report.checks.find((check) => check.id === "RUNTIME-ERRORS").error, /late finalization rejection/);
    const reportPath = [...lateRuntimeError.fixture.memory.files.keys()].find((filePath) => filePath.includes("runtime-qa-report-"));
    assert.equal(JSON.parse(await lateRuntimeError.fixture.memory.readText(reportPath)).summary.success, false);
  } finally {
    MobileQaSessionStore.prototype.finalizeAfterReport = originalFinalize;
  }

  const originalPublishFinalReport = MobileQaSessionStore.prototype.publishFinalReport;
  const originalWindowSetTimeout = global.window.setTimeout;
  MobileQaSessionStore.prototype.publishFinalReport = async function delayedFinalPublish(journal, report) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return await originalPublishFinalReport.call(this, journal, report);
  };
  global.window.setTimeout = (callback, timeoutMs) => originalWindowSetTimeout(callback, timeoutMs === 60_000 ? 2 : timeoutMs);
  try {
    const delayedPublish = await runCase(MobileQaRunner, "9".repeat(32), [
      { id: "T01", name: "passes before delayed publication", async run() {} }
    ]);
    assert.equal(delayedPublish.report.summary.success, true);
    const reportPath = [...delayedPublish.fixture.memory.files.keys()].find((filePath) => filePath.includes("runtime-qa-report-"));
    assert.equal(JSON.parse(await delayedPublish.fixture.memory.readText(reportPath)).summary.success, true);
  } finally {
    global.window.setTimeout = originalWindowSetTimeout;
    MobileQaSessionStore.prototype.publishFinalReport = originalPublishFinalReport;
  }

  let injectedReadbackFailure = false;
  const postCommitReadback = await runCase(
    MobileQaRunner,
    "d".repeat(32),
    [{ id: "T01", name: "passes before post-commit readback", async run() {} }],
    () => false,
    (fixture) => {
      const readText = fixture.ports.fs.readText;
      fixture.ports.fs.readText = async (filePath) => {
        const current = await readText(filePath);
        if (!injectedReadbackFailure && String(filePath).includes("runtime-qa-report-") && current.includes('"success": true')) {
          injectedReadbackFailure = true;
          throw new Error("injected post-commit readback failure");
        }
        return current;
      };
    }
  );
  assert.equal(injectedReadbackFailure, true);
  assert.equal(postCommitReadback.report.summary.success, true);
  const postCommitReportPath = [...postCommitReadback.fixture.memory.files.keys()].find((filePath) => filePath.includes("runtime-qa-report-"));
  assert.equal(JSON.parse(await postCommitReadback.fixture.memory.readText(postCommitReportPath)).summary.success, true);

  process.stdout.write("Mobile QA runner passed: pass/fail/timeout/cancel, aggregation, fail-closed reports, cleanup ordering, and scope guard.\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
