"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveRepositoryLayout } = require("./repository-layout");
const { runEsbuildCli } = require("./run-esbuild-cli");

const { sourceRoot } = resolveRepositoryLayout();

function loadContracts() {
  const outputPath = path.join(os.tmpdir(), `lic-mobile-qa-contracts-${process.pid}-${crypto.randomBytes(6).toString("hex")}.cjs`);
  runEsbuildCli([
    path.join("src-ts", "qa", "contracts.ts"),
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=es2020",
    `--outfile=${outputPath}`,
    "--log-level=silent"
  ], { cwd: sourceRoot, stdio: "pipe" });
  try {
    return require(outputPath);
  } finally {
    fs.rmSync(outputPath, { force: true });
  }
}

const { sanitizeMobileQaMessage } = loadContracts();
const sessionRoot = "QA-LIC-Mobile-" + "a".repeat(32);
const probes = [
  "C:\\Users\\User Name\\Vault\\secret.jpg",
  "\\\\server\\share\\Vault\\secret.jpg",
  "/storage/emulated/0/Documents/Vault/secret.jpg",
  "/data/user/0/md.obsidian/files/Vault/secret.jpg",
  "/private/var/mobile/Containers/Data/Application/UUID/secret.jpg",
  "file:///storage/emulated/0/Documents/Vault/secret.jpg",
  "content://com.android.externalstorage.documents/document/primary%3AVault%2Fsecret.jpg"
];

for (const probe of probes) {
  const sanitized = sanitizeMobileQaMessage(`failure at ${probe}`, sessionRoot);
  assert(!sanitized.includes("secret.jpg"), `Path sanitizer leaked ${probe}`);
  assert.match(sanitized, /<redacted-(?:path|uri)>/);
}

assert.equal(
  sanitizeMobileQaMessage(`failure in ${sessionRoot}/fixtures/image.jpg`, sessionRoot),
  "failure in $QA_ROOT/fixtures/image.jpg"
);
assert.equal(sanitizeMobileQaMessage("x".repeat(2000), sessionRoot).length, 1500);

process.stdout.write("Mobile QA contracts passed: cross-platform path redaction and bounded messages.\n");
