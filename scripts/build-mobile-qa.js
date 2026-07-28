"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { assertMobileQaBundle } = require("./mobile-qa-bundle-contract");
const { resolveRepositoryLayout } = require("./repository-layout");

const { repositoryRoot, sourceRoot } = resolveRepositoryLayout();
const stagingDirectory = path.join(repositoryRoot, "mobile-qa-build");
const installFiles = ["main.js", "manifest.json", "styles.css"];

function resetStagingDirectory() {
  if (path.dirname(stagingDirectory) !== repositoryRoot || path.basename(stagingDirectory) !== "mobile-qa-build") {
    throw new Error(`Refusing to reset unexpected mobile QA staging path: ${stagingDirectory}`);
  }
  fs.rmSync(stagingDirectory, { recursive: true, force: true });
  fs.mkdirSync(stagingDirectory, { recursive: true });
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex").toUpperCase();
}

function main() {
  resetStagingDirectory();
  try {
    const args = [path.join(sourceRoot, "scripts", "build-ts.js"), "--qa"];
    if (process.argv.includes("--force-cli")) {
      args.push("--force-cli");
    }
    const build = spawnSync(process.execPath, args, {
      cwd: sourceRoot,
      stdio: "inherit",
      windowsHide: true
    });
    if (build.error) {
      throw build.error;
    }
    if (build.status !== 0) {
      throw new Error(`Mobile QA TypeScript build failed with exit ${build.status || 1}`);
    }

    for (const fileName of installFiles.slice(1)) {
      fs.copyFileSync(path.join(repositoryRoot, fileName), path.join(stagingDirectory, fileName));
    }
    const stagedFiles = fs.readdirSync(stagingDirectory).sort();
    const expectedFiles = [...installFiles].sort();
    if (JSON.stringify(stagedFiles) !== JSON.stringify(expectedFiles)) {
      throw new Error(`Mobile QA staging mismatch: ${stagedFiles.join(", ")}`);
    }
    assertMobileQaBundle(fs.readFileSync(path.join(stagingDirectory, "main.js"), "utf8"), "Mobile QA main.js");

    for (const fileName of installFiles) {
      const filePath = path.join(stagingDirectory, fileName);
      process.stdout.write(`${fileName}  SHA-256 ${sha256(filePath)}\n`);
    }
    process.stdout.write(`Prepared mobile QA install files in ${stagingDirectory}\n`);
  } catch (error) {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

main();
