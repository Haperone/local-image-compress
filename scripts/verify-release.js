"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { resolveRepositoryLayout } = require("./repository-layout");

const { repositoryRoot: root, sourceRoot } = resolveRepositoryLayout();
const rootMainPath = path.join(root, "main.js");
const releaseFiles = ["manifest.json", "main.js", "styles.css", "versions.json"];

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex").toUpperCase();
}

function readProductionBundle() {
  if (!fs.existsSync(rootMainPath)) {
    throw new Error("Production main.js is missing");
  }
  return fs.readFileSync(rootMainPath);
}

const firstBundle = readProductionBundle();
const firstHash = sha256(firstBundle);
const firstText = firstBundle.toString("utf8");
const lineCount = firstText.split(/\r?\n/).length;

if (!firstText.startsWith("/* GENERATED/BUNDLED FILE.")) {
  throw new Error("Production bundle is missing the generated-file source banner");
}
if (firstText.includes("sourceMappingURL=")) {
  throw new Error("Production bundle unexpectedly contains a source map");
}
if (lineCount > 100) {
  throw new Error(`Production bundle does not appear minified: ${lineCount} lines`);
}

const rebuild = spawnSync(process.execPath, [path.join(sourceRoot, "scripts", "build-root.js")], {
  cwd: sourceRoot,
  stdio: "inherit",
  windowsHide: true
});
if (rebuild.status !== 0) {
  process.exit(rebuild.status || 1);
}

const secondBundle = readProductionBundle();
const secondHash = sha256(secondBundle);
if (!firstBundle.equals(secondBundle)) {
  throw new Error(`Production build is not deterministic: ${firstHash} != ${secondHash}`);
}

const prepare = spawnSync(process.execPath, [path.join(sourceRoot, "scripts", "prepare-release.js")], {
  cwd: sourceRoot,
  stdio: "inherit",
  windowsHide: true
});
if (prepare.status !== 0) {
  process.exit(prepare.status || 1);
}

const stagedFiles = fs.readdirSync(path.join(root, "build")).sort();
if (JSON.stringify(stagedFiles) !== JSON.stringify([...releaseFiles].sort())) {
  throw new Error(`Release staging mismatch: ${stagedFiles.join(", ")}`);
}

process.stdout.write(`Verified deterministic minified release (${firstBundle.length} bytes, ${lineCount} lines, SHA-256 ${firstHash})\n`);
