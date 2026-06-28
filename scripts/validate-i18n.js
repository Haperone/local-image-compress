"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { resolveRepositoryLayout } = require("./repository-layout");

const { repositoryRoot, sourceRoot } = resolveRepositoryLayout(__dirname);
const localeDir = path.join(sourceRoot, "src-ts", "locales");
const dictionaries = {};
for (const fileName of fs.readdirSync(localeDir).filter((fileName) => fileName.endsWith(".json"))) {
  dictionaries[path.basename(fileName, ".json")] = JSON.parse(fs.readFileSync(path.join(localeDir, fileName), "utf8"));
}
const readmeLocales = [
  "en",
  ...fs.readdirSync(path.join(repositoryRoot, "assets"))
    .map((fileName) => fileName.match(/^README\.(.+)\.md$/)?.[1])
    .filter(Boolean)
].sort();
const locales = Object.keys(dictionaries).sort();
const englishKeys = Object.keys(dictionaries.en || {}).sort();
const placeholderPattern = /\{([a-zA-Z0-9_]+)\}/g;
const interfaceKeys = [
  "settings.title",
  "command.compressInNote",
  "command.compressInFolder",
  "command.compressAll",
  "command.moveCompressed",
  "context.compressImage",
  "context.compressImagesInFolder",
  "section.quality",
  "section.paths",
  "section.automation",
  "section.stats",
  "section.move",
  "section.cacheBackups",
  "section.instructions",
  "common.add",
  "common.cancel",
  "progress.start",
  "progress.completed",
  "folderSelect.title",
  "tooltip.savings.header",
  "move.title",
  "backups.cache.title"
];
const allowedEnglishInterfaceMatches = new Set(["fr:section.instructions"]);
const requiredScripts = {
  ar: /[\u0600-\u06ff]/,
  fa: /[\u0600-\u06ff]/,
  ja: /[\u3040-\u30ff\u3400-\u9fff]/,
  ko: /[\uac00-\ud7af]/,
  th: /[\u0e00-\u0e7f]/,
  "zh-cn": /[\u3400-\u9fff]/,
  "zh-tw": /[\u3400-\u9fff]/
};
const technicalLiteralKeys = ["auto.move.threshold.desc", "move.noCompressedFolder"];

function placeholders(value) {
  return [...String(value).matchAll(placeholderPattern)].map((match) => match[1]).sort();
}

assert.deepStrictEqual(locales, readmeLocales, "UI locale inventory must match README languages");
assert(englishKeys.length > 100, "English locale unexpectedly contains too few UI strings");

for (const locale of locales) {
  const dictionary = dictionaries[locale];
  assert(dictionary && typeof dictionary === "object", `Missing built-in locale: ${locale}`);
  assert.deepStrictEqual(Object.keys(dictionary).sort(), englishKeys, `${locale} locale keys differ from English`);
  for (const key of englishKeys) {
    assert(typeof dictionary[key] === "string" && dictionary[key].trim(), `${locale} has an empty translation: ${key}`);
    assert.deepStrictEqual(placeholders(dictionary[key]), placeholders(dictionaries.en[key]), `${locale} placeholder mismatch: ${key}`);
    assert(!dictionary[key].includes("[missing translation key]"), `${locale} contains a missing-key marker: ${key}`);
    assert(!dictionary[key].includes("__LIC_"), `${locale} contains a translation-generation marker: ${key}`);
  }
  for (const key of interfaceKeys) {
    assert(dictionary[key], `${locale} is missing interface surface key: ${key}`);
    if (locale !== "en") {
      assert(dictionary[key] !== dictionaries.en[key] || allowedEnglishInterfaceMatches.has(`${locale}:${key}`), `${locale} falls back to English for interface surface: ${key}`);
    }
  }
  for (const key of technicalLiteralKeys) {
    assert(dictionary[key].includes("Compressed"), `${locale} must preserve the Compressed folder name: ${key}`);
  }
  const requiredScript = requiredScripts[locale];
  if (requiredScript) {
    const localizedCount = englishKeys.filter((key) => requiredScript.test(dictionary[key])).length;
    assert(localizedCount >= englishKeys.length * 0.8, `${locale} does not contain enough text in its expected script`);
  }
}

process.stdout.write(`I18N QA passed: ${locales.length} locales, ${englishKeys.length} keys, placeholders and interface surfaces verified.\n`);
