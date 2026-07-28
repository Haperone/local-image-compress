"use strict";

const fs = require("fs");
const path = require("path");
const { resolveRepositoryLayout } = require("./repository-layout");

const MOBILE_QA_BUILD_TOKEN = "LIC_MOBILE_QA_BUILD_V1";
const MOBILE_QA_EXCLUSION_TOKENS = Object.freeze([
  MOBILE_QA_BUILD_TOKEN,
  "run-mobile-runtime-qa",
  "__LIC_MOBILE_QA_RUN__",
  "QA-LIC-Mobile-",
  "local-image-compress-mobile-qa-report/v1"
]);

function assertMobileQaBundle(text, label) {
  const missingTokens = MOBILE_QA_EXCLUSION_TOKENS.filter((token) => !text.includes(token));
  if (missingTokens.length > 0) {
    throw new Error(`${label} is missing mobile QA-only tokens: ${missingTokens.join(", ")}`);
  }
  if (!/mobile-qa-src-[a-f0-9]{64}/.test(text)) {
    throw new Error(`${label} is missing its deterministic mobile QA source fingerprint`);
  }
}

function assertProductionBundle(text, label) {
  const leakedTokens = MOBILE_QA_EXCLUSION_TOKENS.filter((token) => text.includes(token));
  if (leakedTokens.length > 0) {
    throw new Error(`${label} contains mobile QA-only tokens: ${leakedTokens.join(", ")}`);
  }
  if (/mobile-qa-src-[a-f0-9]{64}/.test(text)) {
    throw new Error(`${label} contains a mobile QA source fingerprint`);
  }
}

function readRequired(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Bundle not found: ${filePath}`);
  }
  return fs.readFileSync(filePath, "utf8");
}

function verifyBuiltProductionBundles(distOnly = false) {
  const { repositoryRoot, sourceRoot } = resolveRepositoryLayout();
  const paths = [path.join(sourceRoot, "dist-ts", "main.js")];
  if (!distOnly) {
    paths.push(path.join(repositoryRoot, "main.js"));
  }
  for (const bundlePath of paths) {
    assertProductionBundle(readRequired(bundlePath), bundlePath);
  }
  process.stdout.write(`Verified mobile QA exclusion in ${paths.length} production bundle${paths.length === 1 ? "" : "s"}.\n`);
}

if (require.main === module) {
  verifyBuiltProductionBundles(process.argv.includes("--dist-only"));
}

module.exports = {
  MOBILE_QA_BUILD_TOKEN,
  MOBILE_QA_EXCLUSION_TOKENS,
  assertMobileQaBundle,
  assertProductionBundle,
  verifyBuiltProductionBundles
};
