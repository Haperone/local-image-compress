"use strict";

const fs = require("fs");
const path = require("path");
const { resolveRepositoryLayout } = require("./repository-layout");

const { isDevLayout, repositoryRoot: repoRoot, sourceRoot } = resolveRepositoryLayout();
const tsRoot = path.join(sourceRoot, "src-ts");
const requireBundle = process.argv.includes("--require-bundle");

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function collectTypeScriptFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      files.push(entryPath);
    }
  }
  return files;
}

function relativeSourcePath(filePath) {
  return path.relative(sourceRoot, filePath).replace(/\\/g, "/");
}

function matchingFiles(files, pattern) {
  return files
    .filter((file) => pattern.test(file.source))
    .map((file) => file.relativePath)
    .sort();
}

function countMatches(source, pattern) {
  return (source.match(pattern) || []).length;
}

const files = collectTypeScriptFiles(tsRoot).map((filePath) => ({
  filePath,
  relativePath: relativeSourcePath(filePath),
  source: fs.readFileSync(filePath, "utf8")
}));
const combinedSource = files.map((file) => file.source).join("\n");
const packageJson = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "manifest.json"), "utf8"));
const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
const readmeRu = fs.readFileSync(path.join(repoRoot, "assets", "README.ru.md"), "utf8");
const releaseAuditPath = path.join(repoRoot, "OBSIDIAN_RELEASE_AUDIT.md");
assert(!isDevLayout || fs.existsSync(releaseAuditPath), "DEV policy audit requires OBSIDIAN_RELEASE_AUDIT.md");
const releaseAudit = fs.existsSync(releaseAuditPath) ? fs.readFileSync(releaseAuditPath, "utf8") : null;
const mainBundlePath = path.join(repoRoot, "main.js");
const mainBundleExists = fs.existsSync(mainBundlePath);
assert(!requireBundle || mainBundleExists, "Production main.js is required after build");
const mainBundle = mainBundleExists ? fs.readFileSync(mainBundlePath, "utf8") : "";
const cacheSource = fs.readFileSync(path.join(tsRoot, "cache.ts"), "utf8");
const i18nSource = fs.readFileSync(path.join(tsRoot, "i18n.ts"), "utf8");
const utilsSource = fs.readFileSync(path.join(tsRoot, "utils.ts"), "utf8");
const platformDesktopSource = fs.readFileSync(path.join(tsRoot, "platform", "desktop.ts"), "utf8");
const platformMobileSource = fs.readFileSync(path.join(tsRoot, "platform", "mobile.ts"), "utf8");
const mobileQaSessionSource = fs.readFileSync(path.join(tsRoot, "qa", "session.ts"), "utf8");
const pluginSource = fs.readFileSync(path.join(tsRoot, "plugin.ts"), "utf8");
const settingsTabSource = fs.readFileSync(path.join(tsRoot, "settings-tab.ts"), "utf8");
const compressionWorkerSource = fs.readFileSync(path.join(tsRoot, "compression-worker.ts"), "utf8");
const workerSlotSource = fs.readFileSync(path.join(tsRoot, "worker-slot.ts"), "utf8");

const forbiddenSourcePatterns = [
  [/\bfetch\s*\(/, "fetch"],
  [/\brequestUrl\s*\(/, "requestUrl"],
  [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
  [/\bWebSocket\b/, "WebSocket"],
  [/\bEventSource\b/, "EventSource"],
  [/\bsendBeacon\s*\(/, "sendBeacon"],
  [/\b(?:import|require)\b[^\n]*(?:node:)?(?:http|https|net|dns)["']/, "network module"],
  [/\b(?:innerHTML|outerHTML|insertAdjacentHTML|document\.write|document\.writeln)\b/, "raw HTML sink"],
  [/\beval\s*\(|new\s+Function\b|set(?:Timeout|Interval)\s*\(\s*["']/, "string-to-code execution"],
  [/setAttribute\s*\(\s*["']on/i, "string event handler"],
  [/\brequire\s*\(\s*["']child_process["']\s*\)/, "child_process"],
  [/\bprocess\.cwd\s*\(/, "ambient working-directory fallback"],
  [/\b(?:api[_-]?key|client[_-]?secret|private[_-]?key|access[_-]?token|refresh[_-]?token|BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY)\b/i, "secret material"]
];
for (const [pattern, label] of forbiddenSourcePatterns) {
  assert(!pattern.test(combinedSource), `Policy audit found ${label} in application TypeScript`);
}
const webStorageFiles = matchingFiles(files, /\b(?:localStorage|sessionStorage)\b/);
assert(
  JSON.stringify(webStorageFiles) === JSON.stringify(["src-ts/platform/desktop.ts", "src-ts/platform/mobile.ts", "src-ts/qa/session.ts"])
    && countMatches(platformDesktopSource, /window\.localStorage\b/g) === 3
    && countMatches(platformMobileSource, /window\.localStorage\b/g) === 3
    && countMatches(mobileQaSessionSource, /ownerWindow\.localStorage\b/g) === 3
    && !/\bsessionStorage\b/.test(platformDesktopSource)
    && !/\bsessionStorage\b/.test(platformMobileSource)
    && !/\bsessionStorage\b/.test(mobileQaSessionSource)
    && platformDesktopSource.includes("local-image-compress:desktop-device-owner-v1")
    && platformMobileSource.includes("local-image-compress:device-owner-v1")
    && mobileQaSessionSource.includes("local-image-compress.mobile-qa-device-owner.v1"),
  `Web storage is restricted to reviewed recovery and mobile QA device-owner operations; found ${webStorageFiles.join(", ")}`
);

const dependencyNames = Object.keys(packageJson.dependencies || {});
assert(dependencyNames.length === 0, `Runtime npm dependencies must stay bundled and explicit; found ${dependencyNames.join(", ")}`);
for (const [name, version] of Object.entries({
  "@jsquash/jpeg": "1.6.0",
  "@jsquash/png": "3.1.1",
  imagequant: "0.1.2"
})) {
  assert(packageJson.devDependencies?.[name] === version, `${name} must stay pinned to ${version}`);
}

// Mobile support ships through src-ts/platform ports; Node/Electron access is
// confined to the lazily-required desktop port, so the manifest is no longer
// desktop-only. validate-manifest.js enforces that confinement.
assert(manifest.isDesktopOnly === false, "isDesktopOnly must stay false now that the platform port migration shipped");
assert(/^https:\/\/buymeacoffee\.com\//.test(manifest.fundingUrl || ""), "fundingUrl must remain an optional support link");
assert(!combinedSource.includes("fundingUrl"), "Runtime source must not read fundingUrl");
assert(settingsTabSource.includes(`"${manifest.fundingUrl}"`), "Settings donation link must match fundingUrl");

for (const token of [
  "Network",
  "Telemetry and ads",
  "Accounts and payments",
  "Vault files",
  "Local state",
  "External files",
  "Other plugins"
]) {
  assert(readme.includes(token), `README.md is missing policy disclosure: ${token}`);
}
for (const token of [
  "Сеть",
  "Телеметрия и реклама",
  "Учётные записи и платежи",
  "Файлы хранилища",
  "Локальное состояние",
  "Внешние файлы",
  "Другие плагины"
]) {
  assert(readmeRu.includes(token), `assets/README.ru.md is missing policy disclosure: ${token}`);
}

const expectedFsBoundaryFiles = [
  "src-ts/platform/desktop.ts"
];
const fsBoundaryFiles = matchingFiles(files, /(?:import\s+\*\s+as\s+fs\w*\s+from\s+["']fs["']|require\(\s*["']fs["']\s*\))/);
assert(JSON.stringify(fsBoundaryFiles) === JSON.stringify(expectedFsBoundaryFiles), `Raw fs boundary inventory changed: ${fsBoundaryFiles.join(", ")}`);
const electronBoundaryFiles = matchingFiles(files, /(?:from\s+["']electron["']|require\(\s*["']electron["']\s*\))/);
assert(JSON.stringify(electronBoundaryFiles) === JSON.stringify(["src-ts/platform/desktop.ts"]), `Electron boundary inventory changed: ${electronBoundaryFiles.join(", ")}`);

assert(!/getVaultBasePathFromAdapter\([^)]*process\.cwd/.test(platformDesktopSource), "Vault base-path helper still defaults to process.cwd()");
assert(platformDesktopSource.includes("refusing filesystem access outside the vault"), "Vault base-path helper must fail closed");
assert(!utilsSource.includes("getBasePath("), "utils must stay free of desktop base-path access");
assert(cacheSource.includes("isSafeVaultRelativePath(vaultRelativePath)") && !cacheSource.includes("return rawPath;"), "Cache raw filesystem resolution must reject outside-vault paths");
assert(
  i18nSource.includes("if (!pluginDir)") && i18nSource.includes("return {};"),
  "External language loading must skip filesystem access when the vault plugin directory is unavailable"
);

const onloadSource = pluginSource.match(/override onload\(\): void \{[\s\S]*?\n  \}/)?.[0] || "";
assert(onloadSource.includes("onLayoutReady") && !/\bawait\b|getFiles\(|loadData\(|readFile/.test(onloadSource), "onload must remain registration-only");

const expectedFullVaultScans = [
  "src-ts/image-index.ts",
  "src-ts/image-scanner.ts",
  "src-ts/move-service.ts",
  "src-ts/move-service.ts",
  "src-ts/plugin.ts",
  "src-ts/services/batch-compression-service.ts"
];
const fullVaultScans = [];
for (const file of files) {
  for (const match of file.source.matchAll(/\.vault\.getFiles\(\)/g)) {
    void match;
    fullVaultScans.push(file.relativePath);
  }
}
fullVaultScans.sort();
assert(JSON.stringify(fullVaultScans) === JSON.stringify(expectedFullVaultScans), `Full-vault scan inventory changed: ${fullVaultScans.join(", ")}`);

if (releaseAudit) {
  for (const boundaryPath of [...new Set([...expectedFsBoundaryFiles, ...expectedFullVaultScans])]) {
    assert(releaseAudit.includes(`\`${boundaryPath}\``), `Release audit is missing boundary disposition for ${boundaryPath}`);
  }
}

assert(compressionWorkerSource.includes("initJpegDecode(getCachedWasmModule") && compressionWorkerSource.includes("initPngDecode(message.wasm.png)"), "Codec initialization must use transferred inline WASM");
assert(
  workerSlotSource.includes("wasmBytes")
    && workerSlotSource.includes('worker.postMessage({ id, type: "init", wasm }, [')
    && ["wasm.jpegDecode", "wasm.jpegEncode", "wasm.png", "wasm.imagequant"].every((token) => workerSlotSource.includes(token)),
  "Worker must transfer bundled WASM bytes explicitly"
);
if (mainBundleExists) {
  assert(countMatches(mainBundle, /\brequire\(["'](?:node:)?https?["']\)/g) === 0, "Production bundle imports a network module");
  assert(countMatches(mainBundle, /\b(?:WebSocket|EventSource|sendBeacon)\b/g) === 0, "Production bundle contains an unreviewed network API");
  assert(countMatches(mainBundle, /\b(?:innerHTML|outerHTML|insertAdjacentHTML)\b/g) === 0, "Production bundle contains a raw HTML sink");
  assert(countMatches(mainBundle, /\beval\s*\(|new Function/g) === 0, "Production bundle contains eval-like execution");
  assert(countMatches(mainBundle, /\bfetch\s*\(/g) === 5 && countMatches(mainBundle, /\bXMLHttpRequest\b/g) === 6, "Dormant pinned codec fallback inventory changed");
}
if (releaseAudit) {
  assert(releaseAudit.includes("Dormant vendor fallbacks"), "Release audit must explain bundled codec fetch/XMLHttpRequest fallback strings");
}

process.stdout.write([
  "Policy audit passed.",
  `TypeScript files: ${files.length}`,
  `Raw fs boundaries: ${fsBoundaryFiles.length}`,
  `Full-vault scans: ${fullVaultScans.length}`,
  "Application network/HTML/eval/secret findings: 0",
  `Production bundle policy check: ${mainBundleExists ? "passed" : "skipped until build"}`,
  ...(mainBundleExists ? [
    "Production network modules/unsafe sinks: 0",
    "Dormant vendor fallbacks: fetch=5, XMLHttpRequest=6"
  ] : [])
].join("\n") + "\n");
