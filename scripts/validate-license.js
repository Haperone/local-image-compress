"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { resolveRepositoryLayout } = require("./repository-layout");

const { repositoryRoot: root, sourceRoot } = resolveRepositoryLayout();

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readText(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function readJson(relativePath) {
  return JSON.parse(readText(relativePath));
}

const packageJson = readJson("package.json");
const licenseText = readText("LICENSE");
const thirdPartyNotices = readText("THIRD_PARTY_NOTICES.md");
const readme = readText("README.md");
const readmeRu = readText("README.ru.md");
const apacheLicense = readText("licenses/Apache-2.0.txt");
const jpegCodecLicense = readText("licenses/jpeg-codec.txt");
const pngCodecLicense = readText("licenses/png-codec.txt");
const imagequantLicense = readText("licenses/imagequant.txt");
const installedApacheLicense = fs.readFileSync(path.join(sourceRoot, "node_modules", "@jsquash", "jpeg", "LICENSE"), "utf8");
const installedPngApacheLicense = fs.readFileSync(path.join(sourceRoot, "node_modules", "@jsquash", "png", "LICENSE"), "utf8");
const installedJpegCodecLicense = fs.readFileSync(path.join(sourceRoot, "node_modules", "@jsquash", "jpeg", "codec", "LICENSE.codec.md"), "utf8");
const installedPngCodecLicense = fs.readFileSync(path.join(sourceRoot, "node_modules", "@jsquash", "png", "codec", "LICENSE.codec.md"), "utf8");
const installedImagequantLicense = fs.readFileSync(path.join(sourceRoot, "node_modules", "imagequant", "LICENSE"), "utf8");

const bundlesGplCodec = /imagequant[\s\S]*GPL\s*v?3/i.test(thirdPartyNotices);
if (bundlesGplCodec) {
  assert(packageJson.license === "GPL-3.0-or-later", `package.json license must be GPL-3.0-or-later when GPL codecs are bundled, got ${packageJson.license}`);
  const normalizedLicense = licenseText.replace(/\r\n/g, "\n");
  const canonicalLicenseSha256 = crypto.createHash("sha256").update(normalizedLicense, "utf8").digest("hex").toUpperCase();
  assert(canonicalLicenseSha256 === "FB981668C18A279E285FC4D83FBA1E836CC84DD4DAA73C9697D3CFD2D8ACA6E0", "LICENSE must be the canonical SPDX GPL-3.0 text");
  assert(licenseText.startsWith("GNU GENERAL PUBLIC LICENSE"), "LICENSE must start with the canonical GPL title");
  assert(licenseText.includes("END OF TERMS AND CONDITIONS") && licenseText.includes("How to Apply These Terms to Your New Programs"), "LICENSE is missing the canonical GPL ending");
  assert(!/libimagequant|pngquant's original license|Local Image Compress/i.test(licenseText), "LICENSE must not mix project or third-party notices into the canonical GPL text");
  assert(/GPL-3\.0-or-later/i.test(readme), "README.md must document the GPL-3.0-or-later distribution license");
  assert(/GPL-3\.0-or-later/i.test(readmeRu), "README.ru.md must document the GPL-3.0-or-later distribution license");
  assert(!/Plugin code:\s*MIT/i.test(readme), "README.md still documents plugin code as MIT");
  assert(!/Код плагина:\s*MIT/i.test(readmeRu), "README.ru.md still documents plugin code as MIT");
}

assert(apacheLicense === installedApacheLicense, "Tracked Apache-2.0 text does not match @jsquash/jpeg");
assert(apacheLicense === installedPngApacheLicense, "Tracked Apache-2.0 text does not match @jsquash/png");
assert(jpegCodecLicense === installedJpegCodecLicense, "Tracked JPEG codec license does not match the pinned package");
assert(pngCodecLicense === installedPngCodecLicense, "Tracked PNG codec license does not match the pinned package");
assert(imagequantLicense === installedImagequantLicense, "Tracked imagequant license does not match the pinned package");
assert(/This software is based in part on the work of the\s+Independent JPEG Group\./i.test(thirdPartyNotices), "JPEG codec attribution is missing");
const wasmHashPath = path.relative(root, path.join(sourceRoot, "wasm-hashes.json")).replace(/\\/g, "/");
for (const localLicensePath of [
  "licenses/Apache-2.0.txt",
  "licenses/jpeg-codec.txt",
  "licenses/png-codec.txt",
  "licenses/imagequant.txt",
  wasmHashPath
]) {
  assert(thirdPartyNotices.includes(localLicensePath), `Third-party notices are missing ${localLicensePath}`);
}

console.log("License validation passed.");
