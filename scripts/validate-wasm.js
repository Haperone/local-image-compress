#!/usr/bin/env node
"use strict";

// WASM integrity gate (WWW2-A hardening).
//
// The plugin inlines four WebAssembly codecs into the bundle at build time:
//   - @jsquash/jpeg  mozjpeg decode + encode
//   - @jsquash/png   squoosh PNG
//   - imagequant     PNG quantizer (pinned 0.1.2, unmaintained upstream)
//
// npm already verifies the package tarballs against package-lock.json on
// `npm ci`. This gate adds a second, build-local check: it asserts the exact
// bytes we are about to bundle match a committed known-good SHA-256 manifest,
// so a compromised/republished package, an accidental version bump, or local
// tampering of node_modules fails the build with a clear error instead of
// silently shipping in main.js.
//
// Regenerate the manifest only after you have verified provenance of a
// deliberate dependency change:  node scripts/validate-wasm.js --write

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..");
const MANIFEST = path.join(ROOT, "wasm-hashes.json");

// Logical name -> { wasm file (relative to node_modules), package.json for the version }
const TARGETS = {
  "jpeg-decode": {
    wasm: "@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm",
    pkg: "@jsquash/jpeg/package.json"
  },
  "jpeg-encode": {
    wasm: "@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm",
    pkg: "@jsquash/jpeg/package.json"
  },
  "png": {
    wasm: "@jsquash/png/codec/pkg/squoosh_png_bg.wasm",
    pkg: "@jsquash/png/package.json"
  },
  "imagequant": {
    wasm: "imagequant/imagequant_bg.wasm",
    pkg: "imagequant/package.json"
  }
};

function nodeModulesPath(relative) {
  return path.join(ROOT, "node_modules", relative);
}

function readVersion(pkgRelative) {
  try {
    const pkg = JSON.parse(fs.readFileSync(nodeModulesPath(pkgRelative), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch (error) {
    return "unknown";
  }
}

function computeEntries() {
  const entries = {};
  const missing = [];
  for (const [name, target] of Object.entries(TARGETS)) {
    const wasmPath = nodeModulesPath(target.wasm);
    if (!fs.existsSync(wasmPath)) {
      missing.push(target.wasm);
      continue;
    }
    const bytes = fs.readFileSync(wasmPath);
    entries[name] = {
      file: target.wasm,
      version: readVersion(target.pkg),
      bytes: bytes.byteLength,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex")
    };
  }
  return { entries, missing };
}

function fail(message) {
  console.error(`[validate:wasm] ${message}`);
  process.exit(1);
}

function main() {
  const write = process.argv.includes("--write");
  const { entries, missing } = computeEntries();

  if (missing.length > 0) {
    fail(
      `Missing bundled WASM file(s): ${missing.join(", ")}.\n` +
      `Run \`npm ci\` to install the exact, lockfile-verified dependencies first.`
    );
  }

  if (write) {
    const manifest = {
      _comment: "Known-good SHA-256 of every WASM codec inlined into the bundle. Regenerate via `npm run validate:wasm -- --write` only after verifying a deliberate dependency change.",
      generatedAt: new Date().toISOString(),
      wasm: entries
    };
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
    console.log(`[validate:wasm] Wrote ${MANIFEST} with ${Object.keys(entries).length} entries.`);
    return;
  }

  if (!fs.existsSync(MANIFEST)) {
    fail(
      `Manifest ${path.basename(MANIFEST)} not found.\n` +
      `After verifying dependency provenance, generate it with: npm run validate:wasm -- --write`
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  } catch (error) {
    fail(`Could not parse ${path.basename(MANIFEST)}: ${error.message}`);
  }

  const expected = manifest && manifest.wasm ? manifest.wasm : {};
  const problems = [];

  for (const [name, actual] of Object.entries(entries)) {
    const want = expected[name];
    if (!want) {
      problems.push(`${name} (${actual.file}): no entry in manifest — add it via --write after verifying provenance`);
      continue;
    }
    if (want.sha256 !== actual.sha256) {
      problems.push(
        `${name} (${actual.file}): SHA-256 mismatch\n` +
        `    expected ${want.sha256} (v${want.version})\n` +
        `    actual   ${actual.sha256} (v${actual.version})`
      );
    }
  }
  for (const name of Object.keys(expected)) {
    if (!entries[name]) {
      problems.push(`${name}: present in manifest but the WASM file was not found`);
    }
  }

  if (problems.length > 0) {
    fail(
      `WASM integrity check failed:\n  - ${problems.join("\n  - ")}\n` +
      `If this change is intentional and provenance is verified, regenerate the manifest: npm run validate:wasm -- --write`
    );
  }

  console.log(`[validate:wasm] OK — ${Object.keys(entries).length} WASM codecs match wasm-hashes.json.`);
}

main();
