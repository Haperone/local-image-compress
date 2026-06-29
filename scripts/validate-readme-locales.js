"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { resolveRepositoryLayout } = require("./repository-layout");

const { repositoryRoot } = resolveRepositoryLayout(__dirname);
const localeNames = [
  "ar", "de", "es", "fa", "fr", "id", "it", "nl", "pl", "pt",
  "pt-br", "ru", "th", "tr", "uk", "vi", "ja", "ko", "zh-cn", "zh-tw"
];
const localeFiles = localeNames.map((locale) => path.join(repositoryRoot, "assets", `README.${locale}.md`));
const allReadmes = [path.join(repositoryRoot, "README.md"), ...localeFiles];
const publicRepositoryUrl = "https://github.com/Haperone/local-image-compress/blob/main";
const publicRawUrl = "https://raw.githubusercontent.com/Haperone/local-image-compress/main";
const expectedLanguageTargets = [
  "README.md",
  ...localeNames.map((locale) => `assets/README.${locale}.md`)
].map((target) => `${publicRepositoryUrl}/${target}`);
const expectedFeatureImage = `${publicRawUrl}/assets/Features.gif`;
const requiredTokens = [
  "PNG", "JPEG", "WebP", "GIF", "BMP", "HEIC/HEIF", "AVIF",
  "65-80", "85", "Compressed", "10-1000", "1-60", "1-365", "30", "50", "true", "false",
  "Vault/.local-image-compress/backups/cache/",
  "Vault/.local-image-compress/backups/originals/",
  "obsidian-paste-image-rename", "app.plugins", "main.js", "GPL-3.0-or-later", "THIRD_PARTY_NOTICES.md"
];

function slugHeading(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s-]/gu, "")
    .replace(/[\u200c\u200d]/g, "")
    .replace(/\s+/g, "-");
}

for (const filePath of allReadmes) {
  assert(fs.existsSync(filePath), `Missing README: ${path.relative(repositoryRoot, filePath)}`);
  const source = fs.readFileSync(filePath, "utf8");
  assert(source.includes(`![Local Image Compress features](${expectedFeatureImage})`), `Missing public feature GIF URL in ${path.relative(repositoryRoot, filePath)}`);
  const languageLine = source.split(/\r?\n/).find((line) => line.startsWith("Read in your language:"));
  assert(languageLine, `Missing language selector: ${path.relative(repositoryRoot, filePath)}`);
  const languageTargets = [...languageLine.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
  assert.strictEqual(languageTargets.length, 21, `Language selector must contain 21 links: ${path.relative(repositoryRoot, filePath)}`);
  assert.deepStrictEqual(languageTargets, expectedLanguageTargets, `Language selector must use public PROD GitHub README URLs: ${path.relative(repositoryRoot, filePath)}`);

  const headings = new Set([...source.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => slugHeading(match[1])));
  for (const anchor of [...source.matchAll(/\]\(#([^)]+)\)/g)].map((match) => match[1])) {
    assert(headings.has(anchor), `Broken heading link in ${path.relative(repositoryRoot, filePath)}: #${anchor}`);
  }
}

for (const filePath of allReadmes) {
  const source = fs.readFileSync(filePath, "utf8");
  const relativePath = path.relative(repositoryRoot, filePath);
  assert.strictEqual([...source.matchAll(/^### .+$/gm)].length, 12, `${relativePath} must contain the 12 canonical sections`);
  assert.strictEqual([...source.matchAll(/^- \[[^\]]+\]\(#[^)]+\)$/gm)].length, 11, `${relativePath} must contain the 11 canonical table-of-contents links`);
  assert.strictEqual([...source.matchAll(/^<details>$/gm)].length, 1, `${relativePath} must contain one collapsible details block`);
  assert.strictEqual([...source.matchAll(/^<summary>.+<\/summary>$/gm)].length, 1, `${relativePath} must contain one details summary`);
  assert.strictEqual([...source.matchAll(/^\|.+\|$/gm)].length, 14, `${relativePath} must contain the complete 12-setting table`);
  for (const token of requiredTokens) {
    assert(source.includes(token), `${relativePath} is missing canonical token: ${token}`);
  }
  assert(source.includes("100 MB") || source.includes("100 МБ"), `${relativePath} is missing the 100 MB safety limit`);
}

process.stdout.write(`README locale validation passed: ${localeFiles.length} locales, ${allReadmes.length * 21} language links.\n`);
