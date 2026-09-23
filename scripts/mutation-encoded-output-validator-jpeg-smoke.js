"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { runEsbuildCli } = require("./run-esbuild-cli");

const root = path.resolve(__dirname, "..");

function loadValidator() {
  const outputPath = path.join(os.tmpdir(), `lic-mutation-jpeg-validator-${process.pid}-${Date.now()}.cjs`);
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

function marker(code, data = []) {
  const length = data.length + 2;
  return Uint8Array.from([0xff, code, length >> 8, length & 0xff, ...data]);
}

function jpeg(...parts) {
  return Uint8Array.from([0xff, 0xd8, ...parts.flatMap((part) => [...part])]);
}

function sof(width = 1, height = 1, components = 1) {
  return marker(0xc0, [
    8,
    height >> 8, height & 0xff,
    width >> 8, width & 0xff,
    components,
    ...Array.from({ length: components }, (_, index) => [index + 1, 0x11, 0]).flat()
  ]);
}

function sos(components = 1) {
  return marker(0xda, [
    components,
    ...Array.from({ length: components }, (_, index) => [index + 1, 0]).flat(),
    0, 63, 0
  ]);
}

function expect(bytes, reason) {
  assert.deepEqual(validator.validateJpegStructure(bytes), reason ? { ok: false, reason } : { ok: true });
}

const validator = loadValidator();
const valid = jpeg(
  sof(),
  sos(),
  Uint8Array.from([0x11, 0xff, 0x00, 0x22, 0xff, 0xd0, 0x33, 0xff, 0xd9])
);
const validWithLastRestart = jpeg(
  sof(),
  sos(),
  Uint8Array.from([0x11, 0xff, 0xd7, 0x33, 0xff, 0xd9])
);

expect(valid);
expect(validWithLastRestart);
expect(Uint8Array.from([0xff, 0xd8, 0xff]), "too-small");
expect(Uint8Array.from([0, 0xd8, 0xff, 0xd9]), "bad-SOI");
expect(Uint8Array.from([0xff, 0, 0xff, 0xd9]), "bad-SOI");
expect(jpeg(Uint8Array.from([0, 0])), "marker-misalign");
expect(jpeg(Uint8Array.from([0xff, 0xff])), "truncated-marker");
expect(jpeg(Uint8Array.from([0xff, 0x00])), "stuffed-marker-outside-scan");
expect(jpeg(Uint8Array.from([0xff, 0xd9, 0])), "trailing-data");
expect(jpeg(Uint8Array.from([0xff, 0x01, 0xff, 0xd0, 0xff, 0xd9])), "missing-SOF");
expect(jpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0x01, 0xff, 0xd0]), sof(), sos(), Uint8Array.from([0xff, 0xd9])));
expect(jpeg(Uint8Array.from([0xff, 0xe0, 0, 2, 0xff, 0xd9])), "missing-SOF");
expect(jpeg(Uint8Array.from([0xff, 0xe0, 0])), "truncated-segment");
expect(jpeg(Uint8Array.from([0xff, 0xe0, 0, 1])), "bad-segment-length");
expect(jpeg(Uint8Array.from([0xff, 0xe0, 0, 5])), "bad-segment-length");
expect(jpeg(marker(0xc0, [8, 0, 1, 0, 1])), "bad-SOF");
expect(jpeg(sof(0), sos(), Uint8Array.from([0xff, 0xd9])), "bad-SOF-dimensions");
expect(jpeg(sof(1, 0), sos(), Uint8Array.from([0xff, 0xd9])), "bad-SOF-dimensions");
expect(jpeg(sof(1, 1, 0), sos(), Uint8Array.from([0xff, 0xd9])), "bad-SOF-dimensions");
expect(jpeg(marker(0xc0, [8, 0, 1, 0, 1, 2, 1, 0x11, 0]), sos(), Uint8Array.from([0xff, 0xd9])), "truncated-SOF");
expect(jpeg(marker(0xcf, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]), sos(), Uint8Array.from([0xff, 0xd9])));
expect(jpeg(marker(0xbf, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]), sos(), Uint8Array.from([0xff, 0xd9])), "missing-SOF");
expect(jpeg(marker(0xc4, [8, 0, 1, 0, 1, 1, 1, 0x11, 0]), sos(), Uint8Array.from([0xff, 0xd9])), "missing-SOF");
expect(jpeg(sof(), marker(0xda, [1, 1, 0])), "bad-SOS");
expect(jpeg(sof(), marker(0xda, [0, 0, 63, 0])), "truncated-SOS");
expect(jpeg(sof(), marker(0xda, [2, 1, 0, 2])), "truncated-SOS");
expect(jpeg(sof(), marker(0xda, [3, 1, 0, 2, 0, 3])), "truncated-SOS");
expect(jpeg(sof(), Uint8Array.from([0xff, 0xd9])), "missing-SOS");
expect(jpeg(sos(), Uint8Array.from([0xff, 0xd9])), "missing-SOF");
expect(jpeg(sof(), sos(), Uint8Array.from([0x11])), "missing-EOI");
