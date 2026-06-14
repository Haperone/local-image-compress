"use strict";

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const manifestPath = path.join(root, "manifest.json");
const versionsPath = path.join(root, "versions.json");
const packagePath = path.join(root, "package.json");
const releaseWorkflowPath = path.join(root, ".github", "workflows", "release.yml");
const gitignorePath = path.join(root, ".gitignore");
const releasePreparePath = path.join(root, "scripts", "prepare-release.js");
const sourceTsRoot = path.join(root, "src-ts");
const MIN_API_SURFACE_APP_VERSION = "1.4.0";
const DESKTOP_ONLY_REQUIRED_REASON = "cache, move, backup, and WASM artifact paths still depend on desktop Node fs/path APIs";
const DESKTOP_ONLY_API_PATTERNS = [
  { label: "Node fs", pattern: /(?:from\s+["']fs["']|require\(["']fs["']\)|\bfs\.promises\b)/ },
  { label: "Node path", pattern: /(?:from\s+["']path["']|require\(["']path["']\)|\bpath\.)/ },
  { label: "Node crypto", pattern: /(?:from\s+["']crypto["']|require\(["']crypto["']\)|\bcrypto\.)/ },
  { label: "FileSystemAdapter.getBasePath", pattern: /\bFileSystemAdapter\b|\bgetBasePath\(/ }
];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function listFilesRecursive(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  return files;
}

function collectDesktopOnlyApiMatches() {
  if (!fs.existsSync(sourceTsRoot)) {
    return [];
  }
  const matches = [];
  for (const filePath of listFilesRecursive(sourceTsRoot)) {
    if (!filePath.endsWith(".ts")) {
      continue;
    }
    const source = fs.readFileSync(filePath, "utf8");
    for (const { label, pattern } of DESKTOP_ONLY_API_PATTERNS) {
      if (pattern.test(source)) {
        matches.push(`${path.relative(root, filePath)} (${label})`);
        break;
      }
    }
  }
  return matches;
}

function compareSemver(left, right) {
  const leftParts = left.split(".").map((part) => Number(part));
  const rightParts = right.split(".").map((part) => Number(part));
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] > rightParts[index] ? 1 : -1;
    }
  }
  return 0;
}

const manifest = readJson(manifestPath);
const rootPackage = readJson(packagePath);
const requiredStringFields = [
  "id",
  "name",
  "version",
  "minAppVersion",
  "description",
  "author"
];

for (const field of requiredStringFields) {
  assert(typeof manifest[field] === "string" && manifest[field].trim(), `manifest.json is missing required string field: ${field}`);
}

assert(!manifest.id.includes("obsidian"), "manifest.json id must not contain 'obsidian'");
assert(/^\d+\.\d+\.\d+$/.test(manifest.version), "manifest.json version must be semver x.y.z");
assert(/^\d+\.\d+\.\d+$/.test(manifest.minAppVersion), "manifest.json minAppVersion must be semver x.y.z");
assert(
  compareSemver(manifest.minAppVersion, MIN_API_SURFACE_APP_VERSION) >= 0,
  `manifest.json minAppVersion must be at least ${MIN_API_SURFACE_APP_VERSION} for activeWindow/activeDocument/getBasePath API usage`
);
assert(typeof manifest.isDesktopOnly === "boolean", "manifest.json isDesktopOnly must be a boolean");
assert(rootPackage.version === manifest.version, "package.json version must match manifest.json");
const desktopOnlyApiMatches = collectDesktopOnlyApiMatches();
assert(
  desktopOnlyApiMatches.length === 0 || manifest.isDesktopOnly === true,
  `manifest.json isDesktopOnly must remain true until ${DESKTOP_ONLY_REQUIRED_REASON}; found ${desktopOnlyApiMatches.slice(0, 5).join(", ")}`
);
if (manifest.authorUrl) {
  let authorUrl;
  try {
    authorUrl = new URL(manifest.authorUrl);
  } catch (error) {
    throw new Error(`manifest.json authorUrl must be a valid URL: ${manifest.authorUrl}`);
  }
  assert(["http:", "https:"].includes(authorUrl.protocol), "manifest.json authorUrl must use http or https");
  assert(authorUrl.protocol === "https:", "manifest.json authorUrl must use https");
  assert(!["localhost", "127.0.0.1", "::1"].includes(authorUrl.hostname), "manifest.json authorUrl must not point to localhost");
  assert(!/^10\./.test(authorUrl.hostname), "manifest.json authorUrl must not point to a private network");
  assert(!/^192\.168\./.test(authorUrl.hostname), "manifest.json authorUrl must not point to a private network");
  assert(!/^172\.(1[6-9]|2\d|3[0-1])\./.test(authorUrl.hostname), "manifest.json authorUrl must not point to a private network");
}

assert(fs.existsSync(versionsPath), "versions.json is required for rollback-friendly auto updates");
const versions = readJson(versionsPath);
assert(typeof versions === "object" && versions && !Array.isArray(versions), "versions.json must be an object");
assert(versions[manifest.version] === manifest.minAppVersion, "versions.json must map the current manifest version to minAppVersion");

for (const [version, minAppVersion] of Object.entries(versions)) {
  assert(/^\d+\.\d+\.\d+$/.test(version), `versions.json key is not semver: ${version}`);
  assert(typeof minAppVersion === "string" && /^\d+\.\d+\.\d+$/.test(minAppVersion), `versions.json value must be a semver minAppVersion string for ${version}`);
  assert(
    compareSemver(minAppVersion, MIN_API_SURFACE_APP_VERSION) >= 0,
    `versions.json minAppVersion for ${version} must be at least ${MIN_API_SURFACE_APP_VERSION}`
  );
}

const releaseFiles = [
  "manifest.json",
  "main.js",
  "styles.css",
  "versions.json"
];
const forbiddenReleaseEntries = [
  "cache-backups",
  "original-files-backups",
  "qa-backups",
  "qa-screenshots",
  ".claude",
  "source-recovery",
  "node_modules",
  "tinyLocal-cache.json",
  "data.json"
];

assert(Array.isArray(rootPackage.files), "package.json must declare a files allowlist for release packaging");
for (const filePath of rootPackage.files) {
  assert(releaseFiles.includes(filePath), `package.json files contains non-release entry: ${filePath}`);
}
for (const filePath of releaseFiles) {
  assert(rootPackage.files.includes(filePath), `package.json files is missing release entry: ${filePath}`);
}
for (const forbidden of forbiddenReleaseEntries) {
  assert(!rootPackage.files.includes(forbidden), `package.json files includes forbidden dev artifact: ${forbidden}`);
}

assert(fs.existsSync(releaseWorkflowPath), "Release workflow is required");
const releaseWorkflow = fs.readFileSync(releaseWorkflowPath, "utf8");
assert(fs.existsSync(releasePreparePath), "Release preparation script is required");
const releasePrepare = fs.readFileSync(releasePreparePath, "utf8");
const gitignore = fs.readFileSync(gitignorePath, "utf8");
assert(
  releaseWorkflow.includes("npm run prepare:release"),
  "Release workflow must use the validated release preparation script"
);
assert(releaseWorkflow.includes('"*.*.*"'), "Release workflow must trigger on dotted tag candidates");
assert(releaseWorkflow.includes("^[0-9]+\\.[0-9]+\\.[0-9]+$"), "Release workflow must validate exact numeric SemVer tags");
assert(!releaseWorkflow.includes("GITHUB_REF_NAME#v") && !releaseWorkflow.includes('"v*"'), "Release workflow must reject v-prefixed tags");
assert(releasePrepare.includes('["manifest.json", "main.js", "styles.css", "versions.json"]'), "Release preparation script must use the explicit install-file allowlist");
for (const pattern of [
  /^node_modules\/$/m,
  /^main\.js$/m,
  /^build\/$/m,
  /^(?:source-recovery\/)?dist-ts\/$/m,
  /^\.obsidian\/$/m,
  /^data\.json$/m,
  /^tinyLocal-cache\.json$/m,
  /^\*\.map$/m
]) {
  assert(pattern.test(gitignore), `Required generated/local artifact ignore is missing: ${pattern}`);
}

const buildDir = path.join(root, "build");
if (fs.existsSync(buildDir)) {
  for (const forbidden of forbiddenReleaseEntries) {
    assert(!fs.existsSync(path.join(buildDir, forbidden)), `Dev folder leaked into release artifact: ${forbidden}`);
  }
}

console.log("Manifest validation passed.");
