"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

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
const installedApacheLicense = fs.readFileSync(path.join(root, "node_modules", "@jsquash", "jpeg", "LICENSE"), "utf8");
const installedPngApacheLicense = fs.readFileSync(path.join(root, "node_modules", "@jsquash", "png", "LICENSE"), "utf8");
const installedJpegCodecLicense = fs.readFileSync(path.join(root, "node_modules", "@jsquash", "jpeg", "codec", "LICENSE.codec.md"), "utf8");
const installedPngCodecLicense = fs.readFileSync(path.join(root, "node_modules", "@jsquash", "png", "codec", "LICENSE.codec.md"), "utf8");

const bundlesGplCodec = /imagequant[\s\S]*GPL\s*v?3/i.test(thirdPartyNotices);
if (bundlesGplCodec) {
  assert(packageJson.license === "GPL-3.0-or-later", `package.json license must be GPL-3.0-or-later when GPL codecs are bundled, got ${packageJson.license}`);
  assert(/SPDX-License-Identifier:\s*GPL-3\.0-or-later/i.test(licenseText), "LICENSE must declare GPL-3.0-or-later SPDX identifier");
  assert(/Copyright \(C\) 2025-2026 Haperone/i.test(licenseText), "LICENSE must contain the project copyright notice");
  assert(/GNU GENERAL PUBLIC LICENSE[\s\S]*Version 3, 29 June 2007/i.test(licenseText), "LICENSE must contain the complete GPL v3 text");
  assert(/0\.\s+Definitions\.[\s\S]*17\.\s+Interpretation of Sections 15 and 16\./i.test(licenseText), "LICENSE is missing GPL v3 sections");
  assert(licenseText.length > 30000, "LICENSE is too short to contain the complete GPL v3 text");
  assert(/GPL-3\.0-or-later/i.test(readme), "README.md must document the GPL-3.0-or-later distribution license");
  assert(/GPL-3\.0-or-later/i.test(readmeRu), "README.ru.md must document the GPL-3.0-or-later distribution license");
  assert(!/Plugin code:\s*MIT/i.test(readme), "README.md still documents plugin code as MIT");
  assert(!/Код плагина:\s*MIT/i.test(readmeRu), "README.ru.md still documents plugin code as MIT");
}

assert(apacheLicense === installedApacheLicense, "Tracked Apache-2.0 text does not match @jsquash/jpeg");
assert(apacheLicense === installedPngApacheLicense, "Tracked Apache-2.0 text does not match @jsquash/png");
assert(jpegCodecLicense === installedJpegCodecLicense, "Tracked JPEG codec license does not match the pinned package");
assert(pngCodecLicense === installedPngCodecLicense, "Tracked PNG codec license does not match the pinned package");
assert(/This software is based in part on the work of the\s+Independent JPEG Group\./i.test(thirdPartyNotices), "JPEG codec attribution is missing");
for (const localLicensePath of [
  "licenses/Apache-2.0.txt",
  "licenses/jpeg-codec.txt",
  "licenses/png-codec.txt",
  "wasm-hashes.json"
]) {
  assert(thirdPartyNotices.includes(localLicensePath), `Third-party notices are missing ${localLicensePath}`);
}

console.log("License validation passed.");
