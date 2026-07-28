"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { resolveRepositoryLayout } = require("./repository-layout");

const FINGERPRINT_PATTERN = /mobile-qa-src-[a-f0-9]{64}/g;

function listFilesRecursive(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? listFilesRecursive(entryPath) : entry.isFile() ? [entryPath] : [];
  });
}

function mobileQaBuildInputs(layout = resolveRepositoryLayout()) {
  const { repositoryRoot, sourceRoot } = layout;
  return [
    ...listFilesRecursive(path.join(sourceRoot, "src-ts")),
    path.join(sourceRoot, "scripts", "build-ts.js"),
    path.join(sourceRoot, "scripts", "mobile-qa-fingerprint.js"),
    path.join(sourceRoot, "scripts", "mobile-qa-scenario-matrix.json"),
    path.join(sourceRoot, "tsconfig.json"),
    path.join(sourceRoot, "package.json"),
    path.join(sourceRoot, "package-lock.json"),
    path.join(sourceRoot, "wasm-hashes.json"),
    path.join(repositoryRoot, "manifest.json"),
    path.join(repositoryRoot, "styles.css")
  ].sort((left, right) => left.localeCompare(right));
}

function computeMobileQaSourceFingerprint(layout = resolveRepositoryLayout()) {
  const hash = crypto.createHash("sha256");
  hash.update("local-image-compress-mobile-qa-build-profile-v2\0");
  for (const inputPath of mobileQaBuildInputs(layout)) {
    if (!fs.statSync(inputPath).isFile()) {
      throw new Error(`Mobile QA fingerprint input is not a file: ${inputPath}`);
    }
    hash.update(path.relative(layout.repositoryRoot, inputPath).replace(/\\/g, "/"));
    hash.update("\0");
    hash.update(fs.readFileSync(inputPath));
    hash.update("\0");
  }
  return `mobile-qa-src-${hash.digest("hex")}`;
}

function extractMobileQaFingerprint(bundleText) {
  const matches = [...new Set(String(bundleText).match(FINGERPRINT_PATTERN) || [])];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one mobile QA source fingerprint in staged main.js; found ${matches.length}.`);
  }
  return matches[0];
}

function getLocalMobileQaFingerprintState(layout = resolveRepositoryLayout()) {
  const current = computeMobileQaSourceFingerprint(layout);
  const bundlePath = path.join(layout.repositoryRoot, "mobile-qa-build", "main.js");
  if (!fs.existsSync(bundlePath)) {
    return { current, staged: null, bundlePath };
  }
  return { current, staged: extractMobileQaFingerprint(fs.readFileSync(bundlePath, "utf8")), bundlePath };
}

module.exports = {
  FINGERPRINT_PATTERN,
  computeMobileQaSourceFingerprint,
  extractMobileQaFingerprint,
  getLocalMobileQaFingerprintState,
  mobileQaBuildInputs
};
