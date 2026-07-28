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

function deferred() {
  let resolve;
  const promise = new Promise((settle) => { resolve = settle; });
  return { promise, resolve };
}

function compileController() {
  const outputPath = path.join(os.tmpdir(), `lic-mobile-qa-controller-${process.pid}-${crypto.randomBytes(6).toString("hex")}.cjs`);
  runEsbuildCli([
    path.join("src-ts", "qa", "mobile-controller.ts"),
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
  const modalHarness = { opened: [], notices: [] };
  Module._load = function loadWithObsidianMock(request, parent, isMain) {
    if (request === "obsidian") {
      class BaseModal {
        constructor() {
          this.opened = false;
          this.contentEl = {
            createEl() {},
            empty() {}
          };
        }
        setTitle() {}
        open() {
          this.opened = true;
          modalHarness.opened.push(this);
          this.onOpen?.();
        }
        close() {
          if (!this.opened) {
            return;
          }
          this.opened = false;
          this.onClose?.();
        }
      }
      class BaseNotice {
        constructor(message) {
          modalHarness.notices.push(message);
        }
        hide() {}
        setMessage() {}
      }
      class BaseSetting {
        addButton(configure) {
          const button = {
            setButtonText() { return button; },
            onClick(callback) { button.click = callback; return button; },
            setCta() { return button; }
          };
          configure(button);
          return this;
        }
      }
      return {
        apiVersion: "test-app",
        Modal: BaseModal,
        Notice: BaseNotice,
        Setting: BaseSetting,
        Platform: { isAndroidApp: true, isIosApp: false },
        TFile: class {},
        TFolder: class {},
        normalizePath: (value) => String(value || "").replace(/\\/g, "/")
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return { ...require(outputPath), modalHarness };
  } finally {
    Module._load = originalLoad;
    fs.rmSync(outputPath, { force: true });
  }
}

function fixture(MobileQaController) {
  const ownerWindow = { crypto: crypto.webcrypto, setTimeout, clearTimeout };
  const plugin = {
    isInitialized: true,
    isUnloading: false,
    manifest: { id: "local-image-compress", version: "test" },
    getActiveWindow: () => ownerWindow,
    getPlatformPorts: () => ({ fs: {}, hash: {}, runtime: {} }),
    addCommand() {},
    register() {}
  };
  const controller = new MobileQaController(plugin);
  controller.profile = "android";
  controller.deviceOwnerId = OWNER;
  return { controller, ownerWindow, plugin };
}

async function main() {
  const { MobileQaController, MobileQaSessionStore, modalHarness } = compileController();
  const originalAssertMarker = MobileQaSessionStore.prototype.assertVaultMarker;
  const originalRecover = MobileQaSessionStore.prototype.recoverOwnedSessions;
  try {
    const markerGate = deferred();
    const markerEntered = deferred();
    let recoveryCalls = 0;
    MobileQaSessionStore.prototype.assertVaultMarker = async () => {
      markerEntered.resolve();
      await markerGate.promise;
      return { schemaVersion: 1, purpose: "local-image-compress-mobile-qa", allowDestructiveQa: true, vaultId: "c".repeat(32) };
    };
    MobileQaSessionStore.prototype.recoverOwnedSessions = async () => {
      recoveryCalls++;
      return { status: "not-required", recoveredSessions: 0, retainedJournals: [], errors: [] };
    };
    const first = fixture(MobileQaController);
    const firstStart = first.controller.start();
    await markerEntered.promise;
    first.controller.dispose();
    first.plugin.isUnloading = true;
    markerGate.resolve();
    await assert.rejects(firstStart, /unloaded during start preflight/i);
    assert.equal(recoveryCalls, 0, "Unloaded controller entered recovery after marker preflight");
    assert.equal(first.controller.runs.size, 0, "Unloaded controller published a run record");
    assert.equal(first.ownerWindow[Symbol.for("local-image-compress.mobile-qa-active-v1")], undefined);

    const recoveryGate = deferred();
    const recoveryEntered = deferred();
    MobileQaSessionStore.prototype.assertVaultMarker = async () => ({
      schemaVersion: 1,
      purpose: "local-image-compress-mobile-qa",
      allowDestructiveQa: true,
      vaultId: "c".repeat(32)
    });
    MobileQaSessionStore.prototype.recoverOwnedSessions = async () => {
      recoveryEntered.resolve();
      await recoveryGate.promise;
      return { status: "not-required", recoveredSessions: 0, retainedJournals: [], errors: [] };
    };
    const second = fixture(MobileQaController);
    const secondStart = second.controller.start();
    await recoveryEntered.promise;
    second.controller.dispose();
    second.plugin.isUnloading = true;
    recoveryGate.resolve();
    await assert.rejects(secondStart, /unloaded during start preflight/i);
    assert.equal(second.controller.runs.size, 0, "Unloaded controller published a run after recovery preflight");
    assert.equal(second.ownerWindow[Symbol.for("local-image-compress.mobile-qa-active-v1")], undefined);

    MobileQaSessionStore.prototype.recoverOwnedSessions = async () => ({
      status: "not-required",
      recoveredSessions: 0,
      retainedJournals: [],
      errors: []
    });
    const third = fixture(MobileQaController);
    const commandRun = third.controller.runFromCommand();
    const duplicateCommandRun = third.controller.runFromCommand();
    await new Promise((resolve) => setImmediate(resolve));
    const confirmationModal = modalHarness.opened.at(-1);
    assert(confirmationModal?.opened, "Mobile QA confirmation modal did not open");
    assert.equal(modalHarness.opened.length, 1, "Concurrent command opened a second confirmation modal");
    third.controller.dispose();
    third.plugin.isUnloading = true;
    await commandRun;
    await duplicateCommandRun;
    confirmationModal.onClose();
    confirmationModal.finish?.(true);
    assert.equal(confirmationModal.opened, false, "Controller dispose left the confirmation modal open");
    assert.equal(third.controller.runs.size, 0, "Confirmation resolved after unload and started mobile QA");
    assert.equal(modalHarness.notices.length, 0, "Confirmation unload emitted a post-unload Notice");

    const commandMarkerGate = deferred();
    const commandMarkerEntered = deferred();
    MobileQaSessionStore.prototype.assertVaultMarker = async () => {
      commandMarkerEntered.resolve();
      await commandMarkerGate.promise;
      return {
        schemaVersion: 1,
        purpose: "local-image-compress-mobile-qa",
        allowDestructiveQa: true,
        vaultId: "c".repeat(32)
      };
    };
    const fourth = fixture(MobileQaController);
    const fourthRun = fourth.controller.runFromCommand();
    await commandMarkerEntered.promise;
    fourth.controller.dispose();
    fourth.plugin.isUnloading = true;
    commandMarkerGate.resolve();
    await fourthRun;
    assert.equal(modalHarness.opened.length, 1, "Unloaded marker preflight opened a confirmation modal");
    assert.equal(modalHarness.notices.length, 0, "Unloaded marker preflight emitted a Notice");
  } finally {
    MobileQaSessionStore.prototype.assertVaultMarker = originalAssertMarker;
    MobileQaSessionStore.prototype.recoverOwnedSessions = originalRecover;
  }
  process.stdout.write("Mobile QA controller lifecycle preflight tests passed.\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
