"use strict";

const fs = require("fs");
const path = require("path");

const scriptsDir = __dirname;
const runtimeQaPath = path.join(scriptsDir, "runtime-qa.js");
const matrixPath = path.join(scriptsDir, "mobile-qa-scenario-matrix.json");
const mobileRunnerPath = path.join(scriptsDir, "..", "src-ts", "qa", "mobile-runner.ts");

function fail(message) {
  throw new Error(`Mobile QA matrix: ${message}`);
}

function assertNonEmptyStrings(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    fail(`${label} must be an array of non-empty strings`);
  }
  if (new Set(value).size !== value.length) {
    fail(`${label} contains duplicates`);
  }
}

const runtimeSource = fs.readFileSync(runtimeQaPath, "utf8");
const mobileRunnerSource = fs.readFileSync(mobileRunnerPath, "utf8");
if (!mobileRunnerSource.includes('import mobileQaScenarioMatrix from "../../scripts/mobile-qa-scenario-matrix.json"')) {
  fail("mobile runner must consume the authoritative matrix for declared manual/partial skips");
}
const runtimeChecks = Array.from(runtimeSource.matchAll(/\bawait\s+check\(\s*(["'])(.*?)\1\s*,/g), (match) => match[2]);
if (runtimeChecks.length === 0) {
  fail("runtime-qa.js contains no await check(...) calls");
}
if (new Set(runtimeChecks).size !== runtimeChecks.length) {
  fail("runtime-qa.js contains duplicate check names");
}
const mobileScenarioIds = Array.from(
  mobileRunnerSource.matchAll(/\bid:\s*"(M\d{2})"\s*,\s*\n\s*name:\s*"[^"]+"/g),
  (match) => match[1]
);
if (mobileScenarioIds.length === 0 || new Set(mobileScenarioIds).size !== mobileScenarioIds.length) {
  fail("mobile-runner.ts must declare unique executable MNN scenarios");
}

const matrix = JSON.parse(fs.readFileSync(matrixPath, "utf8"));
if (matrix.schemaVersion !== 1) {
  fail(`unsupported schemaVersion ${String(matrix.schemaVersion)}`);
}
assertNonEmptyStrings(matrix.profiles, "profiles");
assertNonEmptyStrings(matrix.statuses, "statuses");
assertNonEmptyStrings(matrix.capabilities, "capabilities");
if (!Array.isArray(matrix.scenarios)) {
  fail("scenarios must be an array");
}

const knownProfiles = new Set(matrix.profiles);
const knownStatuses = new Set(matrix.statuses);
const knownCapabilities = new Set(matrix.capabilities);
const matrixNames = [];

for (const [index, scenario] of matrix.scenarios.entries()) {
  const label = `scenarios[${index}]`;
  if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)) {
    fail(`${label} must be an object`);
  }
  if (typeof scenario.desktopCheck !== "string" || scenario.desktopCheck.trim() === "") {
    fail(`${label}.desktopCheck must be a non-empty string`);
  }
  matrixNames.push(scenario.desktopCheck);
  if (typeof scenario.portableScenario !== "string" || !/^M\d{2}-[a-z0-9-]+$/.test(scenario.portableScenario)) {
    fail(`${scenario.desktopCheck}: portableScenario must match MNN-kebab-case`);
  }
  for (const field of ["capabilities", "mutation", "fixtures", "cleanup", "manual"]) {
    assertNonEmptyStrings(scenario[field], `${scenario.desktopCheck}.${field}`);
  }
  for (const capability of scenario.capabilities) {
    if (!knownCapabilities.has(capability)) {
      fail(`${scenario.desktopCheck}: unknown capability ${capability}`);
    }
  }
  if (!scenario.classification || typeof scenario.classification !== "object" || Array.isArray(scenario.classification)) {
    fail(`${scenario.desktopCheck}: classification must be an object`);
  }
  const classifiedProfiles = Object.keys(scenario.classification);
  for (const profile of classifiedProfiles) {
    if (!knownProfiles.has(profile)) {
      fail(`${scenario.desktopCheck}: unknown classification profile ${profile}`);
    }
    if (!knownStatuses.has(scenario.classification[profile])) {
      fail(`${scenario.desktopCheck}: unknown status ${String(scenario.classification[profile])} for ${profile}`);
    }
  }
  for (const profile of knownProfiles) {
    if (!Object.hasOwn(scenario.classification, profile)) {
      fail(`${scenario.desktopCheck}: missing classification for ${profile}`);
    }
  }
  if (!scenario.skipReasons || typeof scenario.skipReasons !== "object" || Array.isArray(scenario.skipReasons)) {
    fail(`${scenario.desktopCheck}: skipReasons must be an object`);
  }
  for (const [profile, reason] of Object.entries(scenario.skipReasons)) {
    if (!knownProfiles.has(profile)) {
      fail(`${scenario.desktopCheck}: unknown skipReasons profile ${profile}`);
    }
    if (typeof reason !== "string" || reason.trim() === "") {
      fail(`${scenario.desktopCheck}: empty skip reason for ${profile}`);
    }
  }
  for (const profile of knownProfiles) {
    const status = scenario.classification[profile];
    const hasReason = Object.hasOwn(scenario.skipReasons, profile);
    if (status !== "automated" && !hasReason) {
      fail(`${scenario.desktopCheck}: ${status} classification for ${profile} requires a skip reason`);
    }
    if (status === "automated" && hasReason) {
      fail(`${scenario.desktopCheck}: unexpected skip reason for ${profile} with ${status} classification`);
    }
  }
}

if (new Set(matrixNames).size !== matrixNames.length) {
  fail("matrix contains duplicate desktopCheck names");
}
const runtimeSet = new Set(runtimeChecks);
const matrixSet = new Set(matrixNames);
const missing = runtimeChecks.filter((name) => !matrixSet.has(name));
const unknown = matrixNames.filter((name) => !runtimeSet.has(name));
if (missing.length > 0 || unknown.length > 0) {
  fail(`desktop check coverage mismatch; missing=${JSON.stringify(missing)}, unknown=${JSON.stringify(unknown)}`);
}
const matrixMobileScenarioIds = new Set(matrix.scenarios.map((scenario) => scenario.portableScenario.slice(0, 3)));
const unknownMobileIds = [...matrixMobileScenarioIds].filter((id) => !mobileScenarioIds.includes(id));
const unreferencedMobileIds = mobileScenarioIds.filter((id) => !matrixMobileScenarioIds.has(id));
if (unknownMobileIds.length > 0 || unreferencedMobileIds.length > 0) {
  fail(`mobile executable coverage mismatch; unknown=${JSON.stringify(unknownMobileIds)}, unreferenced=${JSON.stringify(unreferencedMobileIds)}`);
}

console.log(`Mobile QA matrix verified: ${matrix.scenarios.length} desktop checks, ${mobileScenarioIds.length} executable mobile scenarios, ${matrix.profiles.length} profiles.`);
