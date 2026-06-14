"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const buildDir = path.join(root, "build");
const releaseFiles = ["manifest.json", "main.js", "styles.css", "versions.json"];

fs.rmSync(buildDir, { recursive: true, force: true });
fs.mkdirSync(buildDir, { recursive: true });

for (const fileName of releaseFiles) {
  const sourcePath = path.join(root, fileName);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Release file is missing: ${fileName}`);
  }
  fs.copyFileSync(sourcePath, path.join(buildDir, fileName));
}

const stagedFiles = fs.readdirSync(buildDir).sort();
const expectedFiles = [...releaseFiles].sort();
if (JSON.stringify(stagedFiles) !== JSON.stringify(expectedFiles)) {
  throw new Error(`Unexpected release contents: ${stagedFiles.join(", ")}`);
}

process.stdout.write(`Prepared release files: ${stagedFiles.join(", ")}\n`);
