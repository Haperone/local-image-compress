"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const pluginId = "local-image-compress";
const sourceRoot = path.resolve(__dirname, "..");
const repoRoot = sourceRoot;
const runnerPath = path.join(__dirname, "runtime-qa.js");
const reportDir = path.join(repoRoot, "qa-backups");
const dataJsonPath = path.join(repoRoot, "data.json");
const preQaSettingsBackupPath = path.join(reportDir, "pre-qa-data-backup.json");
const QA_STATE_MARKER = "QA-LIC-Runtime-";
const cliPath = process.env.OBSIDIAN_CLI || (
  process.platform === "win32" ? "C:\\Program Files\\Obsidian\\Obsidian.com" : "obsidian"
);

const args = new Set(process.argv.slice(2));
const skipReload = args.has("--skip-reload");
const skipDevErrors = args.has("--skip-dev-errors");

function printHelp() {
  console.log([
    "Usage: npm run qa:runtime [-- --skip-reload] [-- --skip-dev-errors]",
    "",
    "Runs scripts/runtime-qa.js inside a live Obsidian instance.",
    "Set OBSIDIAN_CLI to override the Obsidian CLI executable path."
  ].join("\n"));
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
}

function runObsidianCli(cliArgs, description, options = {}) {
  const result = spawnSync(cliPath, cliArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.error) {
    throw new Error(`Failed to run Obsidian CLI for ${description}: ${result.error.message}\nCLI: ${cliPath}`);
  }
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error([
      `Obsidian CLI failed during ${description} with exit ${result.status}.`,
      result.stdout ? `stdout:\n${result.stdout}` : "",
      result.stderr ? `stderr:\n${result.stderr}` : ""
    ].filter(Boolean).join("\n"));
  }
  return result;
}

function extractEvalPayload(stdout) {
  const markerIndex = stdout.lastIndexOf("=>");
  if (markerIndex === -1) {
    throw new Error(`Obsidian eval output did not contain a return marker.\nOutput:\n${stdout}`);
  }
  const payload = stdout.slice(markerIndex + 2).trim();
  if (!payload) {
    throw new Error("Obsidian eval return marker was empty.");
  }
  try {
    const parsed = JSON.parse(payload);
    return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
  } catch (error) {
    const firstBrace = payload.indexOf("{");
    const lastBrace = payload.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return payload.slice(firstBrace, lastBrace + 1);
    }
    throw error;
  }
}

function parseRuntimeReport(stdout) {
  const reportJson = extractEvalPayload(stdout);
  try {
    return JSON.parse(reportJson);
  } catch (error) {
    throw new Error(`Could not parse runtime QA report: ${error.message}\nPayload:\n${reportJson.slice(0, 4000)}`);
  }
}

function hasPluginRelevantDevErrors(output) {
  return /plugin:local-image-compress|local-image-compress|tinyLocal|Tiny Local/i.test(output);
}

function writeTextReport(prefix, text) {
  const filePath = path.join(reportDir, `${prefix}-${timestampForFile()}.txt`);
  fs.writeFileSync(filePath, text);
  return filePath;
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return null;
  }
}

// Runtime QA overwrites the real plugin data.json with isolated test settings (a "QA-LIC-Runtime-*"
// output folder / allowed root). These guards make the run transactional so a crashed or hard-killed
// run cannot leave those test settings behind as the user's real configuration.
function settingsLookPolluted(data) {
  if (!data || typeof data !== "object") {
    return false;
  }
  const outputFolder = String(data.outputFolder || "");
  const roots = Array.isArray(data.allowedRoots) ? data.allowedRoots : [];
  return outputFolder.includes(QA_STATE_MARKER) || roots.some((root) => String(root).includes(QA_STATE_MARKER));
}

function ensurePreQaSettingsBackup() {
  try {
    const current = readJsonSafe(dataJsonPath);
    if (!current) {
      return;
    }
    if (settingsLookPolluted(current)) {
      if (fs.existsSync(preQaSettingsBackupPath)) {
        fs.copyFileSync(preQaSettingsBackupPath, dataJsonPath);
        console.warn("Detected leftover QA settings in data.json; restored from the pre-QA backup before running.");
      } else {
        console.warn("data.json looks like leftover QA state, but no pre-QA backup exists to restore from.");
      }
      return;
    }
    fs.copyFileSync(dataJsonPath, preQaSettingsBackupPath);
  } catch (error) {
    console.warn(`Could not create pre-QA settings backup: ${error.message}`);
  }
}

function restoreSettingsIfPolluted() {
  try {
    const current = readJsonSafe(dataJsonPath);
    if (!settingsLookPolluted(current)) {
      return;
    }
    if (!fs.existsSync(preQaSettingsBackupPath)) {
      console.warn("Runtime QA left QA settings in data.json, but no pre-QA backup was found to restore from.");
      return;
    }
    fs.copyFileSync(preQaSettingsBackupPath, dataJsonPath);
    console.warn("Runtime QA left QA settings in data.json; restored your settings from the pre-QA backup.");
    try {
      runObsidianCli(["plugin:reload", `id=${pluginId}`], "post-QA settings restore reload", { allowFailure: true });
    } catch (error) {
      // Obsidian may be closed; the on-disk data.json is already restored for the next launch.
    }
  } catch (error) {
    console.error(`Failed to restore data.json after runtime QA: ${error.message}`);
  }
}

async function main() {
  if (args.has("--help") || args.has("-h")) {
    printHelp();
    return;
  }
  if (!fs.existsSync(runnerPath)) {
    throw new Error(`Missing runtime QA runner: ${runnerPath}`);
  }
  fs.mkdirSync(reportDir, { recursive: true });
  ensurePreQaSettingsBackup();

  if (!skipReload) {
    console.log(`Reloading ${pluginId} through Obsidian CLI...`);
    runObsidianCli(["plugin:reload", `id=${pluginId}`], "plugin reload");
  }

  console.log("Running Obsidian runtime QA...");
  const evalExpression = `eval(require("fs").readFileSync(${JSON.stringify(runnerPath)}, "utf8"))`;
  const qaResult = runObsidianCli(["eval", `code=${evalExpression}`], "runtime QA", { allowFailure: true });
  if (qaResult.status !== 0) {
    const rawPath = writeTextReport("runtime-qa-raw", `${qaResult.stdout || ""}\n${qaResult.stderr || ""}`);
    throw new Error(`Runtime QA eval failed with exit ${qaResult.status}. Raw output: ${rawPath}`);
  }

  const report = parseRuntimeReport(qaResult.stdout);
  const reportPath = path.join(reportDir, `runtime-qa-report-${timestampForFile()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  const summary = report.summary || {};
  const failed = Number(summary.failed || report.failures?.length || 0);
  const warnings = Number(summary.warnings || report.warnings?.length || 0);
  const passed = Number(summary.passed || 0);
  console.log(`Runtime QA summary: ${passed} passed, ${failed} failed, ${warnings} warnings.`);
  console.log(`Runtime QA report: ${reportPath}`);

  let failedGate = failed > 0;
  if (failedGate) {
    for (const failure of report.failures || []) {
      console.error(`FAILED ${failure.name}: ${failure.error?.message || "unknown error"}`);
    }
  }

  if (!skipDevErrors) {
    console.log("Collecting Obsidian dev:errors...");
    const devErrors = runObsidianCli(["dev:errors"], "dev:errors", { allowFailure: true });
    const devErrorsText = `${devErrors.stdout || ""}${devErrors.stderr || ""}`.trim();
    const devErrorsPath = writeTextReport("runtime-qa-dev-errors", devErrorsText || "(no dev errors)");
    console.log(`dev:errors report: ${devErrorsPath}`);
    if (hasPluginRelevantDevErrors(devErrorsText)) {
      console.error("Plugin-relevant dev:errors were found after runtime QA.");
      failedGate = true;
    } else {
      console.log("No plugin-relevant dev:errors found.");
    }
  }

  if (failedGate) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  restoreSettingsIfPolluted();
});
