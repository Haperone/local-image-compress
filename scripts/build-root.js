"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const rootMainPath = path.join(root, "main.js");
const generatedPath = path.join(root, "dist-ts", "main.js");

const build = spawnSync(process.execPath, [path.join(root, "scripts", "build-ts.js"), "--production"], {
  cwd: root,
  stdio: "inherit",
  windowsHide: true
});

if (build.status !== 0) {
  process.exit(build.status || 1);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex").toUpperCase();
}

let updateMethod = "copyFileSync";
try {
  fs.copyFileSync(generatedPath, rootMainPath);
} catch (error) {
  if (error && error.code === "EPERM") {
    console.warn("[build-root] copyFileSync failed with EPERM; trying writeFileSync fallback. Close Obsidian if main.js is locked.");
    try {
      fs.writeFileSync(rootMainPath, fs.readFileSync(generatedPath));
      updateMethod = "writeFileSync fallback";
    } catch (writeError) {
      console.error("[build-root] copyFileSync and writeFileSync fallback both failed. Close Obsidian and retry.");
      throw writeError;
    }
  } else {
    throw error;
  }
}

const generated = fs.readFileSync(generatedPath);
const rootMain = fs.readFileSync(rootMainPath);
const generatedHash = sha256(generated);
const rootMainHash = sha256(rootMain);
if (generatedHash !== rootMainHash) {
  throw new Error(`build-root post-copy SHA mismatch: dist-ts=${generatedHash}, root=${rootMainHash}`);
}

console.log(`Updated ${path.relative(root, rootMainPath)} via ${updateMethod} (${rootMain.length} bytes, SHA-256 ${rootMainHash})`);
