"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runEsbuildCli } = require("./run-esbuild-cli");

const root = path.resolve(__dirname, "..");
const signature = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

function loadValidator() {
  const outputPath = path.join(os.tmpdir(), `lic-mutation-png-validator-${process.pid}-${Date.now()}.cjs`);
  runEsbuildCli([
    path.join("src-ts", "encoded-output-validator.ts"),
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

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (-(crc & 1) & 0xedb88320);
    }
  }
  return (crc ^ -1) >>> 0;
}

function chunk(type, data = []) {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Uint8Array.from([...typeBytes, ...data]);
  const result = new Uint8Array(12 + data.length);
  new DataView(result.buffer).setUint32(0, data.length, false);
  result.set(body, 4);
  new DataView(result.buffer).setUint32(8 + data.length, crc32(body), false);
  return result;
}

function png(...chunks) {
  return Uint8Array.from([...signature, ...chunks.flatMap((value) => [...value])]);
}

function ihdr(width = 1, height = 1, length = 13) {
  const data = new Uint8Array(length);
  if (length >= 8) {
    const view = new DataView(data.buffer);
    view.setUint32(0, width, false);
    view.setUint32(4, height, false);
  }
  if (length >= 13) {
    data.set([8, 6, 0, 0, 0], 8);
  }
  return chunk("IHDR", data);
}

function expect(bytes, reason) {
  assert.deepEqual(validator.validatePngStructure(bytes), reason ? { ok: false, reason } : { ok: true });
}

const validator = loadValidator();
const valid = png(ihdr(), chunk("IDAT", [0]), chunk("IEND"));

expect(valid);
expect(new Uint8Array(56), "too-small");

const badSignature = valid.slice();
badSignature[0] = 0;
expect(badSignature, "bad-signature");

const badCrc = valid.slice();
badCrc[29] ^= 1;
expect(badCrc, "crc-mismatch-IHDR");
expect(png(chunk("IHD1", new Uint8Array(13)), chunk("IDAT", [0]), chunk("IEND")), "invalid-chunk-type");
expect(png(chunk("TEXT", new Uint8Array(13)), chunk("IDAT", [0]), chunk("IEND")), "first-chunk-not-IHDR");
expect(png(ihdr(), ihdr(), chunk("IDAT", [0]), chunk("IEND")), "duplicate-IHDR");
expect(png(ihdr(1, 1, 12), chunk("IDAT", [0]), chunk("IEND")), "IHDR-wrong-length");
expect(png(ihdr(0), chunk("IDAT", [0]), chunk("IEND")), "zero-dimensions");
expect(png(ihdr(1, 0), chunk("IDAT", [0]), chunk("IEND")), "zero-dimensions");

const truncated = new Uint8Array(57);
truncated.set(signature);
new DataView(truncated.buffer).setUint32(8, 100, false);
truncated.set(Buffer.from("IHDR"), 12);
expect(truncated, "truncated-chunk");

const tooLarge = new Uint8Array(57);
tooLarge.set(signature);
new DataView(tooLarge.buffer).setUint32(8, 256 * 1024 * 1024 + 1, false);
expect(tooLarge, "chunk-too-large");

const maximumLength = new Uint8Array(57);
maximumLength.set(signature);
new DataView(maximumLength.buffer).setUint32(8, 256 * 1024 * 1024, false);
expect(maximumLength, "truncated-chunk");

expect(png(ihdr(), chunk("TEXT", new Uint8Array(13)), chunk("IEND")), "missing-or-empty-IDAT");
expect(png(ihdr(), chunk("IDAT"), chunk("IEND")), "missing-or-empty-IDAT");
expect(png(ihdr(), chunk("IDAT"), chunk("TEXT", new Uint8Array(13))), "missing-or-empty-IDAT");
expect(png(ihdr(), chunk("IDAT", [0]), chunk("IEND", [0])), "IEND-wrong-length");
expect(png(ihdr(), chunk("IDAT", [0]), chunk("TEXT", [0])), "missing-IEND");
expect(Uint8Array.from([...valid, 0]), "trailing-data");
