"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runEsbuildCli } = require("./run-esbuild-cli");

const root = path.resolve(__dirname, "..");

function loadCacheFileNames() {
  const outputPath = path.join(os.tmpdir(), `lic-mutation-cache-file-names-${process.pid}-${Date.now()}.cjs`);
  runEsbuildCli([
    path.join("src-ts", "cache-file-names.ts"),
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=es2020",
    `--outfile=${outputPath}`,
    "--log-level=silent"
  ], { cwd: root, stdio: "pipe" });
  try {
    return require(outputPath);
  } finally {
    fs.rmSync(outputPath, { force: true });
  }
}

const pathOps = {
  joinPath: (...parts) => parts.filter(Boolean).join("/"),
  dirnamePath: (filePath) => filePath.slice(0, Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\")))
};

const cache = loadCacheFileNames();

assert.equal(cache.getCacheBackupTimestamp(new Date("2026-08-24T01:02:03.456Z")), "2026-08-24T01-02-03-456");
assert.equal(
  cache.getBrokenCacheFilePath(pathOps, "cache-backups", "2026-08-24T01-02-03-456", "deadbeef"),
  "cache-backups/broken/tinyLocal-cache.broken-2026-08-24T01-02-03-456-deadbeef.json"
);
assert.equal(
  cache.getCacheTempFilePath(pathOps, "vault\\tinyLocal-cache.json", 12, 345, "deadbeef"),
  "vault/.tinyLocal-cache.json.tinylocal-345-deadbeef.tmp"
);
assert.equal(
  cache.getCacheTempFilePath(pathOps, "vault/", 12, 345, "deadbeef"),
  "vault/.tinyLocal-cache.json.tinylocal-345-deadbeef.tmp"
);
assert.deepEqual(
  cache.getCacheBackupPath(pathOps, "cache-backups", "deadbeef", new Date("2026-08-24T01:02:03.456Z")),
  { backupDir: "cache-backups", backupFile: "cache-backups/tinyLocal-cache-backup-2026-08-24T01-02-03-456-deadbeef.json" }
);

for (const [predicate, validName, invalidName] of [
  [cache.isCacheTempFileName, ".tinyLocal-cache-abc.tmp", ".not-a-cache.tmp"],
  [cache.isCacheBackupFileName, "tinyLocal-cache-backup-abc.json", "tinyLocal-cache-backup-abc.tmp"],
  [cache.isBrokenCacheFileName, "tinyLocal-cache.broken-abc.json", "tinyLocal-cache.broken-abc.tmp"]
]) {
  assert.equal(predicate(validName), true);
  assert.equal(predicate(invalidName), false);
}
assert.equal(cache.isCacheTempFileName(".tinyLocal-cache-abc.json"), false);

for (const fileName of [
  "tinyLocal-cache-backup-2026-08-24T01-02-03-456.json",
  "tinyLocal-cache-backup-2026-08-24T01-02-03-deadbeef.json",
  "tinyLocal-cache-backup-2026-08-24T01-02-03-456-deadbeef.json"
]) {
  assert.equal(cache.isValidCacheBackupFileName(fileName), true, fileName);
}
for (const fileName of [
  "tinyLocal-cache-backup-2026-08-24T01-02-03.json",
  "tinyLocal-cache-backup-2026-08-24T01-02-03-456.txt",
  "prefix-tinyLocal-cache-backup-2026-08-24T01-02-03-456.json",
  "tinyLocal-cache-backup-2026-08-24T01-02-03-456.json.bak",
  "folder/tinyLocal-cache-backup-2026-08-24T01-02-03-456.json",
  "folder\\tinyLocal-cache-backup-2026-08-24T01-02-03-456.json",
  "..tinyLocal-cache-backup-2026-08-24T01-02-03-456.json"
]) {
  assert.equal(cache.isValidCacheBackupFileName(fileName), false, fileName);
}
