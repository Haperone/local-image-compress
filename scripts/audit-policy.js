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
const readmeRu = fs.readFileSync(path.join(repoRoot, "README.ru.md"), "utf8");
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
const pluginSource = fs.readFileSync(path.join(tsRoot, "plugin.ts"), "utf8");
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
  [/\b(?:localStorage|sessionStorage)\b/, "web storage"],
  [/\bprocess\.cwd\s*\(/, "ambient working-directory fallback"],
  [/\b(?:api[_-]?key|client[_-]?secret|private[_-]?key|access[_-]?token|refresh[_-]?token|BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY)\b/i, "secret material"]
];
for (const [pattern, label] of forbiddenSourcePatterns) {
  assert(!pattern.test(combinedSource), `Policy audit found ${label} in application TypeScript`);
}

const dependencyNames = Object.keys(packageJson.dependencies || {});
assert(dependencyNames.length === 0, `Runtime npm dependencies must stay bundled and explicit; found ${dependencyNames.join(", ")}`);
for (const [name, version] of Object.entries({
  "@jsquash/jpeg": "1.6.0",
  "@jsquash/png": "3.1.1",
  imagequant: "0.1.2"
})) {
  assert(packageJson.devDependencies?.[name] === version, `${name} must stay pinned to ${version}`);
}

assert(manifest.isDesktopOnly === true, "Node/Electron plugin must remain desktop-only");
assert(/^https:\/\/buymeacoffee\.com\//.test(manifest.fundingUrl || ""), "fundingUrl must remain an optional support link");
assert(!combinedSource.includes(manifest.fundingUrl), "Runtime source must not contact or gate on fundingUrl");

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
  "Аккаунты и платежи",
  "Файлы vault",
  "Локальное состояние",
  "Внешние файлы",
  "Другие плагины"
]) {
  assert(readmeRu.includes(token), `README.ru.md is missing policy disclosure: ${token}`);
}

const expectedFsBoundaryFiles = [
  "src-ts/cache.ts",
  "src-ts/i18n.ts",
  "src-ts/move-service.ts",
  "src-ts/plugin.ts",
  "src-ts/savings-calculator.ts",
  "src-ts/services/cache-backups-view.ts",
  "src-ts/services/migration-runner.ts",
  "src-ts/settings-tab.ts",
  "src-ts/utils.ts"
];
const fsBoundaryFiles = matchingFiles(files, /import\s+\*\s+as\s+fs\w*\s+from\s+["']fs["']/);
assert(JSON.stringify(fsBoundaryFiles) === JSON.stringify(expectedFsBoundaryFiles), `Raw fs boundary inventory changed: ${fsBoundaryFiles.join(", ")}`);
const electronBoundaryFiles = matchingFiles(files, /from\s+["']electron["']/);
assert(JSON.stringify(electronBoundaryFiles) === JSON.stringify(["src-ts/utils.ts"]), `Electron boundary inventory changed: ${electronBoundaryFiles.join(", ")}`);

assert(!/getVaultBasePathFromAdapter\([^)]*process\.cwd/.test(utilsSource), "Vault base-path helper still defaults to process.cwd()");
assert(utilsSource.includes("refusing filesystem access outside the vault"), "Vault base-path helper must fail closed");
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
  "src-ts/plugin.ts"
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
