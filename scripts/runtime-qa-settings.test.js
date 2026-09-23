"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const source = fs.readFileSync(path.join(__dirname, "runtime-qa.js"), "utf8");
const wrapperSource = fs.readFileSync(path.join(__dirname, "run-runtime-qa.js"), "utf8");
const startMarker = "/* RUNTIME_QA_SETTINGS_WAIT_START */";
const endMarker = "/* RUNTIME_QA_SETTINGS_WAIT_END */";
const start = source.indexOf(startMarker);
const end = source.indexOf(endMarker);
assert(start >= 0 && end > start, "runtime QA settings wait markers are missing");
const helperSource = source.slice(start + startMarker.length, end);
const recoveryStart = wrapperSource.indexOf("function settingsLookPolluted(");
const recoveryEnd = wrapperSource.indexOf("function cleanupRuntimeQaVaultArtifacts(");
assert(recoveryStart >= 0 && recoveryEnd > recoveryStart, "runtime QA wrapper recovery helpers are missing");
const recoverySource = wrapperSource.slice(recoveryStart, recoveryEnd);

function qaAssert(condition, message, details) {
  assert(condition, `${message}: ${JSON.stringify(details || {})}`);
}

function createSurface(state) {
  return {
    childElementCount: state.children,
    textContent: "x".repeat(state.textLength),
    querySelector(selector) {
      return selector === "select" && state.select ? {} : null;
    },
    querySelectorAll(selector) {
      const count = {
        ".setting-item-name": state.labels,
        button: state.buttons,
        "input[type='text']": state.textInputs,
        "input[type='range']": state.rangeInputs,
        ".checkbox-container": state.toggles
      }[selector] || 0;
      return { length: count };
    }
  };
}

async function main() {
  const recoveryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-runtime-qa-settings-"));
  try {
    const dataJsonPath = path.join(recoveryRoot, "data.json");
    const preQaSettingsBackupPath = path.join(recoveryRoot, "pre-qa-data-backup.json");
    const cleanSettings = { outputFolder: "Compressed", allowedRoots: [], jpegQuality: 85 };
    const readJsonSafe = (filePath) => {
      try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
      } catch (error) {
        return null;
      }
    };
    let reloads = 0;
    const recovery = new Function(
      "fs",
      "dataJsonPath",
      "preQaSettingsBackupPath",
      "readJsonSafe",
      "console",
      "runObsidianCli",
      "pluginId",
      "QA_STATE_MARKER",
      `${recoverySource}; return { ensurePreQaSettingsBackup, restoreSettingsIfPolluted };`
    )(
      fs,
      dataJsonPath,
      preQaSettingsBackupPath,
      readJsonSafe,
      { warn() {}, error() {} },
      () => {
        reloads += 1;
      },
      "local-image-compress",
      "QA-LIC-Runtime-"
    );
    fs.writeFileSync(dataJsonPath, JSON.stringify(cleanSettings));
    recovery.ensurePreQaSettingsBackup();
    assert.deepEqual(JSON.parse(fs.readFileSync(preQaSettingsBackupPath, "utf8")), cleanSettings, "wrapper did not persist the clean pre-QA settings");
    fs.writeFileSync(dataJsonPath, JSON.stringify({
      ...cleanSettings,
      outputFolder: "QA-LIC-Runtime-crashed/Compressed",
      allowedRoots: ["QA-LIC-Runtime-crashed"]
    }));
    assert(fs.existsSync(preQaSettingsBackupPath), "simulated crash lost the wrapper-owned settings backup");
    recovery.restoreSettingsIfPolluted();
    assert.deepEqual(JSON.parse(fs.readFileSync(dataJsonPath, "utf8")), cleanSettings, "wrapper did not restore settings after a simulated crash");
    assert.equal(reloads, 1, "wrapper did not reload the plugin after restoring crashed QA settings");
  } finally {
    fs.rmSync(recoveryRoot, { recursive: true, force: true });
  }

  const states = [
    { labels: 0, buttons: 0, textInputs: 0, rangeInputs: 0, toggles: 0, select: false, children: 0, textLength: 0 },
    { labels: 24, buttons: 8, textInputs: 2, rangeInputs: 5, toggles: 4, select: false, children: 30, textLength: 100 },
    { labels: 0, buttons: 0, textInputs: 0, rangeInputs: 0, toggles: 0, select: false, children: 0, textLength: 0 },
    { labels: 25, buttons: 8, textInputs: 2, rangeInputs: 5, toggles: 4, select: true, children: 32, textLength: 120 },
    { labels: 25, buttons: 8, textInputs: 2, rangeInputs: 5, toggles: 4, select: true, children: 32, textLength: 120 },
    { labels: 25, buttons: 8, textInputs: 2, rangeInputs: 5, toggles: 4, select: true, children: 32, textLength: 120 }
  ];
  let index = 0;
  const tab = { containerEl: createSurface(states[index]) };
  const sleep = async () => {
    index = Math.min(index + 1, states.length - 1);
    tab.containerEl = createSurface(states[index]);
  };
  const waitForSettingsSurface = new Function(
    "assert",
    "sleep",
    `${helperSource}; return waitForSettingsSurface;`
  )(qaAssert, sleep);
  const result = await waitForSettingsSurface(tab, "select");
  assert.equal(index, states.length - 1, "settings wait returned before the post-rerender surface was stable");
  assert(result.querySelector("select"), "settings wait returned a surface without the required control");
  assert(
    !source.includes('absolute(joinVault(p.getPluginDirectory(), "qa-backups", "pre-qa-data-backup.json"))'),
    "runtime QA leaves its settings recovery backup outside the exact session-owned state root"
  );
  assert(
    source.includes('.modal-container .modal, .modal-container .prompt'),
    "runtime QA does not recognize both legacy modal and declarative prompt surfaces"
  );
  console.log("Runtime QA settings wait tests passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
