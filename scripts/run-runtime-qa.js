"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { resolveRepositoryLayout } = require("./repository-layout");

const pluginId = "local-image-compress";
const { repositoryRoot: repoRoot, sourceRoot } = resolveRepositoryLayout();
const runnerPath = path.join(__dirname, "runtime-qa.js");
const reportDir = path.join(repoRoot, "qa-backups");
const pluginInstallDir = resolvePluginInstallDirectory();
const vaultRoot = path.resolve(pluginInstallDir, "..", "..", "..");
const dataJsonPath = path.join(pluginInstallDir, "data.json");
const preQaSettingsBackupPath = path.join(reportDir, "pre-qa-data-backup.json");
const QA_STATE_MARKER = "QA-LIC-Runtime-";
const QA_ARTIFACT_PARENTS = ["", "Compressed", "files", "files/Compressed"];
const cliPath = process.env.OBSIDIAN_CLI || (
  process.platform === "win32" ? "C:\\Program Files\\Obsidian\\Obsidian.com" : "obsidian"
);
const DEFAULT_OBSIDIAN_CLI_TIMEOUT_MS = 10 * 60 * 1000;

const args = new Set(process.argv.slice(2));
const skipReload = args.has("--skip-reload");
const skipDevErrors = args.has("--skip-dev-errors");

function resolvePluginInstallDirectory() {
  const environmentPath = process.env.OBSIDIAN_DEV_PLUGIN_DIR?.trim();
  if (environmentPath) {
    return path.resolve(environmentPath);
  }
  const configPath = path.join(repoRoot, ".obsidian-dev.json");
  const config = readJsonSafe(configPath);
  return path.resolve(config?.pluginDir || repoRoot);
}

function printHelp() {
  const runnerDisplayPath = path.relative(repoRoot, runnerPath).replace(/\\/g, "/");
  console.log([
    "Usage: npm run qa:runtime [-- --skip-reload] [-- --skip-dev-errors]",
    "",
    `Runs ${runnerDisplayPath} inside a live Obsidian instance.`,
    "The DEV command builds and deploys the configured Vault copy before running.",
    "Set OBSIDIAN_DEV_PLUGIN_DIR to override .obsidian-dev.json.",
    "Set OBSIDIAN_CLI to override the Obsidian CLI executable path."
  ].join("\n"));
}

function timestampForFile() {
  return new Date().toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
}

function runObsidianCli(cliArgs, description, options = {}) {
  const timeoutMs = getObsidianCliTimeoutMs();
  const result = spawnSync(cliPath, cliArgs, {
    cwd: pluginInstallDir,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs
  });
  if (result.error) {
    if (result.error.code === "ETIMEDOUT") {
      throw new Error(`Obsidian CLI timed out during ${description} after ${timeoutMs}ms.\nCLI: ${cliPath}`);
    }
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

function getObsidianCliTimeoutMs() {
  const timeoutMs = Number(process.env.OBSIDIAN_CLI_TIMEOUT_MS);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : DEFAULT_OBSIDIAN_CLI_TIMEOUT_MS;
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

function removePathInsideVault(targetPath) {
  const resolvedBase = path.resolve(vaultRoot);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedBase, resolvedTarget);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove outside vault: ${targetPath}`);
  }
  fs.rmSync(resolvedTarget, { recursive: true, force: true });
}

function cleanupRuntimeQaVaultArtifacts() {
  for (const parentRel of QA_ARTIFACT_PARENTS) {
    const parentPath = parentRel ? path.join(vaultRoot, ...parentRel.split("/")) : vaultRoot;
    let entries = [];
    try {
      entries = fs.readdirSync(parentPath, { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.warn(`Could not read runtime QA artifact parent ${parentPath}: ${error.message}`);
      }
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(QA_STATE_MARKER)) {
        continue;
      }
      try {
        removePathInsideVault(path.join(parentPath, entry.name));
      } catch (error) {
        console.warn(`Could not remove runtime QA artifact ${entry.name}: ${error.message}`);
      }
    }
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
  const installedManifest = readJsonSafe(path.join(pluginInstallDir, "manifest.json"));
  if (installedManifest?.id !== pluginId || !fs.existsSync(path.join(pluginInstallDir, "main.js"))) {
    throw new Error(`Configured runtime plugin is not a deployed ${pluginId} installation: ${pluginInstallDir}`);
  }
  fs.mkdirSync(reportDir, { recursive: true });
  console.log(`Runtime plugin directory: ${pluginInstallDir}`);
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
  cleanupRuntimeQaVaultArtifacts();
});
