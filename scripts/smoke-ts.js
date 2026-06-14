"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const Module = require("module");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const artifact = path.join(root, "dist-ts", "main.js");
const sourceTsRoot = path.join(root, "src-ts");

const MOCK_MD5 = "0123456789abcdef0123456789abcdef";
const MOCK_MD5_ALT = "fedcba9876543210fedcba9876543210";
const VALID_JPEG_EOI = Uint8Array.from([0xff, 0xd9]);
const VALID_JPEG_OUTPUT = Uint8Array.from(Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAMDAwMDAwQEBAQFBQUFBQcHBgYHBwsICQgJCAsRCwwLCwwLEQ8SDw4PEg8bFRMTFRsfGhkaHyYiIiYwLTA+PlQBAwMDAwMDBAQEBAUFBQUFBwcGBgcHCwgJCAkICxELDAsLDAsRDxIPDg8SDxsVExMVGx8aGRofJiIiJjAtMD4+VP/CABEIAAEAAQMBEQACEQEDEQH/xAAmAAEAAAAAAAAAAAAAAAAAAAAJAQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAAqj//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAT8Af//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQIBAT8Af//EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQMBAT8Af//Z",
  "base64"
));
const VALID_PNG_OUTPUT = Uint8Array.from(Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
));

function cloneArrayBuffer(view) {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function neverSettlingPromise() {
  return new Promise(() => {});
}

function stringifyConsoleArg(arg) {
  if (arg instanceof Error) {
    return arg.message;
  }
  if (typeof arg === "string") {
    return arg;
  }
  try {
    return JSON.stringify(arg);
  } catch (error) {
    void error;
    return String(arg);
  }
}

function captureConsoleWarn() {
  const originalWarn = console.warn;
  const messages = [];
  console.warn = (...args) => {
    messages.push(args.map((arg) => stringifyConsoleArg(arg)).join(" "));
  };
  return {
    messages,
    restore() {
      console.warn = originalWarn;
    }
  };
}

async function withTestTimeout(name, promise, timeoutMs = 5000) {
  let timeoutHandle = null;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = originalGlobals.setTimeout(() => reject(new Error(`Smoke test "${name}" timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutHandle !== null) {
      originalGlobals.clearTimeout(timeoutHandle);
    }
  }
}

function createValidJpegBytes(byteLength = null) {
  const targetLength = byteLength || VALID_JPEG_OUTPUT.byteLength;
  assert(targetLength >= VALID_JPEG_OUTPUT.byteLength, "JPEG fixture cannot be truncated and remain valid");
  const bytes = new Uint8Array(targetLength);
  bytes.set(VALID_JPEG_OUTPUT.subarray(0, VALID_JPEG_OUTPUT.byteLength - VALID_JPEG_EOI.byteLength), 0);
  bytes.set(VALID_JPEG_EOI, bytes.byteLength - VALID_JPEG_EOI.byteLength);
  return bytes;
}

function createValidJpegOutput(byteLength = VALID_JPEG_OUTPUT.byteLength) {
  return cloneArrayBuffer(createValidJpegBytes(byteLength));
}

function createValidEncodedOutput(format = "jpeg", byteLength = null) {
  if (format === "png") {
    return cloneArrayBuffer(VALID_PNG_OUTPUT);
  }
  return createValidJpegOutput(byteLength || VALID_JPEG_OUTPUT.byteLength);
}

function createPngWithoutIdat() {
  const signatureAndIhdr = VALID_PNG_OUTPUT.subarray(0, 33);
  const iend = VALID_PNG_OUTPUT.subarray(VALID_PNG_OUTPUT.byteLength - 12);
  const bytes = new Uint8Array(signatureAndIhdr.byteLength + iend.byteLength);
  bytes.set(signatureAndIhdr, 0);
  bytes.set(iend, signatureAndIhdr.byteLength);
  return cloneArrayBuffer(bytes);
}

function createTruncatedPngChunk() {
  return cloneArrayBuffer(VALID_PNG_OUTPUT.subarray(0, 40));
}

function createZeroWidthPng() {
  const bytes = new Uint8Array(VALID_PNG_OUTPUT);
  bytes[16] = 0;
  bytes[17] = 0;
  bytes[18] = 0;
  bytes[19] = 0;
  return bytes;
}

function findJpegMarkerOffset(bytes, marker) {
  for (let offset = 0; offset < bytes.byteLength - 1; offset += 1) {
    if (bytes[offset] === 0xff && bytes[offset + 1] === marker) {
      return offset;
    }
  }
  return -1;
}

function concatUint8Arrays(parts) {
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

function createJpegWithoutSos() {
  const sosOffset = findJpegMarkerOffset(VALID_JPEG_OUTPUT, 0xda);
  assert(sosOffset > 0, "JPEG fixture must include an SOS marker");
  return cloneArrayBuffer(concatUint8Arrays([
    VALID_JPEG_OUTPUT.subarray(0, sosOffset),
    VALID_JPEG_EOI
  ]));
}

function readUint32BE(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function assertValidPngFixture(bytes) {
  assert(bytes.byteLength >= 57, "PNG fixture must be large enough for IHDR, IDAT, and IEND");
  assert(Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "PNG fixture has an invalid signature");
  assert(Buffer.from(bytes.subarray(12, 16)).toString("ascii") === "IHDR", "PNG fixture must start with IHDR");
  assert(readUint32BE(bytes, 16) > 0 && readUint32BE(bytes, 20) > 0, "PNG fixture must have non-zero dimensions");
  assert(Buffer.from(bytes).includes(Buffer.from("IDAT")), "PNG fixture must include IDAT");
  assert(Buffer.from(bytes.subarray(bytes.byteLength - 8, bytes.byteLength - 4)).toString("ascii") === "IEND", "PNG fixture must end with IEND");
}

function assertValidJpegFixture(bytes) {
  assert(bytes.byteLength > 100, "JPEG fixture must be more than an SOI/EOI envelope");
  assert(bytes[0] === 0xff && bytes[1] === 0xd8, "JPEG fixture must start with SOI");
  assert(bytes[bytes.byteLength - 2] === 0xff && bytes[bytes.byteLength - 1] === 0xd9, "JPEG fixture must end with EOI");
  assert(findJpegMarkerOffset(bytes, 0xc0) > 0 || findJpegMarkerOffset(bytes, 0xc2) > 0, "JPEG fixture must include an SOF marker");
  assert(findJpegMarkerOffset(bytes, 0xda) > 0, "JPEG fixture must include an SOS marker");
}

assertValidPngFixture(VALID_PNG_OUTPUT);
assertValidJpegFixture(VALID_JPEG_OUTPUT);

if (!fs.existsSync(artifact)) {
  throw new Error(`Missing TypeScript artifact: ${path.relative(root, artifact)}`);
}

const source = fs.readFileSync(artifact, "utf8");

const requiredArtifactTokens = [
  "require(\"obsidian\")",
  "require(\"fs\")",
  "require(\"path\")",
  "require(\"crypto\")"
];

for (const token of requiredArtifactTokens) {
  assert(source.includes(token), `TypeScript artifact is missing expected bundler token: ${token}`);
}

assert(
  !source.includes("this.getCompressedFiles(compressedFolderPath)"),
  "TypeScript artifact still calls missing getCompressedFiles() in moveCompressedToFiles()"
);

assert(
  source.includes("await this.getCompressedFilesAsync(compressedFolderPath)"),
  "TypeScript artifact does not use getCompressedFilesAsync() in moveCompressedToFiles()"
);

assert(
  source.includes("findOriginalFileForCompressed"),
  "TypeScript artifact is missing relative-path original lookup for compressed files"
);

assert(
  !source.includes("replace(/\\//g"),
  "TypeScript artifact still normalizes plugin paths with Windows backslashes"
);

assert(
  !source.includes("spawnSync(") && !source.includes("spawn("),
  "TypeScript artifact still spawns native compressor binaries"
);

assert(
  !source.includes(".innerHTML"),
  "TypeScript artifact still writes localized content through innerHTML"
);

assert(
  !source.includes(".outerHTML") && !source.includes("insertAdjacentHTML("),
  "TypeScript artifact still writes raw HTML into the DOM"
);

assert(
  !source.includes("setupMenuEventListeners("),
  "TypeScript artifact still contains unused status menu listener helper"
);

assert(
  !source.includes("isFileAlreadyCompressed("),
  "TypeScript artifact still contains path-only isFileAlreadyCompressed()"
);

assert(
  !source.includes("readSync("),
  "TypeScript artifact still performs dead binary header reads before compression"
);

assert(
  !source.includes("execSync("),
  "TypeScript artifact still resolves binaries through shell execSync"
);

const compressorSource = fs.readFileSync(path.join(sourceTsRoot, "compressor.ts"), "utf8");
const workerSlotSource = fs.readFileSync(path.join(sourceTsRoot, "worker-slot.ts"), "utf8");
const workerPoolSource = fs.readFileSync(path.join(sourceTsRoot, "worker-pool.ts"), "utf8");
const compressionWorkerSource = fs.readFileSync(path.join(sourceTsRoot, "compression-worker.ts"), "utf8");
const imageScannerSource = fs.readFileSync(path.join(sourceTsRoot, "image-scanner.ts"), "utf8");
const imageIndexSource = fs.readFileSync(path.join(sourceTsRoot, "image-index.ts"), "utf8");
const progressModalSource = fs.readFileSync(path.join(sourceTsRoot, "progress-modal.ts"), "utf8");
const backupStorageSource = fs.readFileSync(path.join(sourceTsRoot, "backup-storage.ts"), "utf8");
const cacheSource = fs.readFileSync(path.join(sourceTsRoot, "cache.ts"), "utf8");
const cacheFileNamesSource = fs.readFileSync(path.join(sourceTsRoot, "cache-file-names.ts"), "utf8");
const typesSource = fs.readFileSync(path.join(sourceTsRoot, "types.ts"), "utf8");
const cacheEntryTypeSource = typesSource.slice(typesSource.indexOf("export interface CacheEntry"), typesSource.indexOf("export interface FreshCacheEntry"));
const wasmModulesSource = fs.readFileSync(path.join(sourceTsRoot, "wasm-modules.d.ts"), "utf8");
const settingsTabSource = fs.readFileSync(path.join(sourceTsRoot, "settings-tab.ts"), "utf8");
const pluginSource = fs.readFileSync(path.join(sourceTsRoot, "plugin.ts"), "utf8");
const setupStatusBarSource = pluginSource.slice(pluginSource.indexOf("\n  setupStatusBar()"), pluginSource.indexOf("\n  getMonotonicTime()"));
const settingsSource = fs.readFileSync(path.join(sourceTsRoot, "settings.ts"), "utf8");
const utilsSource = fs.readFileSync(path.join(sourceTsRoot, "utils.ts"), "utf8");
const moveServiceSource = fs.readFileSync(path.join(sourceTsRoot, "move-service.ts"), "utf8");
const i18nSource = fs.readFileSync(path.join(sourceTsRoot, "i18n.ts"), "utf8");
const concurrencyLimiterSource = fs.readFileSync(path.join(sourceTsRoot, "concurrency-limiter.ts"), "utf8");
const backgroundCompressionServiceSource = fs.readFileSync(path.join(sourceTsRoot, "background-compression-service.ts"), "utf8");
const statusBarControllerSource = fs.readFileSync(path.join(sourceTsRoot, "status-bar-controller.ts"), "utf8");
const stylesSource = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const runtimeQaSource = fs.readFileSync(path.join(root, "scripts", "runtime-qa.js"), "utf8");
const pluginGuardSource = fs.readFileSync(path.join(sourceTsRoot, "plugin-guard-service.ts"), "utf8");
const savingsCalculatorSource = fs.readFileSync(path.join(sourceTsRoot, "savings-calculator.ts"), "utf8");
const commandRegistrySource = fs.readFileSync(path.join(sourceTsRoot, "services", "command-registry.ts"), "utf8");
const eventRouterSource = fs.readFileSync(path.join(sourceTsRoot, "services", "event-router.ts"), "utf8");
const migrationRunnerSource = fs.readFileSync(path.join(sourceTsRoot, "services", "migration-runner.ts"), "utf8");
const folderSelectorModalSource = fs.readFileSync(path.join(sourceTsRoot, "services", "folder-selector-modal.ts"), "utf8");
const newFileQueueSource = fs.readFileSync(path.join(sourceTsRoot, "services", "new-file-queue.ts"), "utf8");
const cacheBackupsViewSource = fs.readFileSync(path.join(sourceTsRoot, "services", "cache-backups-view.ts"), "utf8");
const serviceSources = [
  "background-compression-service.ts",
  "image-scanner.ts",
  "move-service.ts",
  "plugin-guard-service.ts",
  "savings-calculator.ts",
  "settings-tab.ts",
  "status-bar-controller.ts"
].map((fileName) => fs.readFileSync(path.join(sourceTsRoot, fileName), "utf8"));
const readmeSource = fs.readFileSync(path.join(root, "README.md"), "utf8");
const readmeRuSource = fs.readFileSync(path.join(root, "README.ru.md"), "utf8");
const releasePolicySource = fs.readFileSync(path.join(root, "RELEASE_POLICY.md"), "utf8");
const packageSource = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const rootPackageSource = packageSource;
const manifestSource = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
const versionsSource = JSON.parse(fs.readFileSync(path.join(root, "versions.json"), "utf8"));
const tsconfigSource = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"));
const releaseWorkflowSource = fs.readFileSync(path.join(root, ".github", "workflows", "release.yml"), "utf8");
const licenseSource = fs.readFileSync(path.join(root, "LICENSE"), "utf8");
const gitignoreSource = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
const validateManifestSource = fs.readFileSync(path.join(root, "scripts", "validate-manifest.js"), "utf8");
const buildRootSource = fs.readFileSync(path.join(root, "scripts", "build-root.js"), "utf8");
const buildTsSource = fs.readFileSync(path.join(root, "scripts", "build-ts.js"), "utf8");
const prepareReleaseSource = fs.readFileSync(path.join(root, "scripts", "prepare-release.js"), "utf8");
const verifyReleaseSource = fs.readFileSync(path.join(root, "scripts", "verify-release.js"), "utf8");
const classWideGatesSource = fs.readFileSync(path.join(root, "scripts", "class-wide-gates.js"), "utf8");
const auditPolicySource = fs.readFileSync(path.join(root, "scripts", "audit-policy.js"), "utf8");
const lintObsidianSource = fs.readFileSync(path.join(root, "scripts", "lint-obsidian.js"), "utf8");
const eslintObsidianConfigSource = fs.readFileSync(path.join(root, "eslint.obsidian.config.mjs"), "utf8");
const combinedTsSource = [
  backupStorageSource,
  backgroundCompressionServiceSource,
  commandRegistrySource,
  eventRouterSource,
  migrationRunnerSource,
  folderSelectorModalSource,
  newFileQueueSource,
  cacheBackupsViewSource,
  cacheFileNamesSource,
  cacheSource,
  compressionWorkerSource,
  imageIndexSource,
  compressorSource,
  concurrencyLimiterSource,
  i18nSource,
  imageScannerSource,
  moveServiceSource,
  pluginGuardSource,
  pluginSource,
  progressModalSource,
  savingsCalculatorSource,
  settingsSource,
  settingsTabSource,
  statusBarControllerSource,
  typesSource,
  utilsSource,
  wasmModulesSource,
  workerPoolSource,
  workerSlotSource
].join("\n");
assert(!/(?::\s*any\b|\bas\s+any\b|\bis\s+any\b|\bany\s*\[\]|<[^>\n]*\bany\b[^>\n]*>)/.test(combinedTsSource), "src-ts reintroduced explicit any; use domain types or unknown with narrowing");
assert(!combinedTsSource.includes("app.setting") && !combinedTsSource.includes("this.app.setting"), "Runtime source reintroduced private app.setting access");
assert(!utilsSource.includes("adapter?.basePath") && !utilsSource.includes("adapter?.path?.absolute") && utilsSource.includes("getVaultBasePathFromAdapter(adapter: unknown"), "Vault base-path helper still reads undocumented adapter fields");
assert((combinedTsSource.match(/\.vault\.get(?:Files|AllLoadedFiles)\(\)/g) || []).length === 8, "Full-vault iteration count changed; review each new or removed scan");
assert(!compressorSource.includes("openSync(") && !compressorSource.includes("readSync("), "Compressor still performs dead binary header reads before compression");
const requiredSemanticSourceTokens = [
  "compress-images-in-note",
  "compress-images-in-folder",
  "compress-all-images",
  "move-compressed-to-files",
  "tinyLocal-cache.json",
  "Compressed",
  "pngquant_quality_failed",
  "tiny-local-status-attention",
  "getStatsSnapshot",
  "sourceMtime",
  "processedMtime",
  "pending_move",
  "outputMtime",
  "outputSize",
  "ImageIndex",
  "scheduleStatusBarUpdate",
  "ConcurrencyLimiter",
  "compressed_not_smaller",
  "writeCacheFileAtomic",
  "tooltip.savings.estimated",
  "newFileCompressionTimers",
  "isAllowedByRoots",
  "seenDirectories",
  "signature",
  "brokenCacheBackupPath",
  "cache.corruptSaved",
  "preloadExternalLanguages",
  "Image is too large to compress safely",
  "tinyLocal-cache.broken-",
  "cleanupOldBrokenCacheCopies",
  "Failed to resolve directory:",
  "Broken cache recovery failed:",
  "getFileMd5ByPath",
  "Cannot mark moved file without cache entry or md5:",
  "runCompressionBatch",
  "PluginGuardService",
  "MoveService",
  "StatusBarController",
  "ImageScanner",
  "SavingsCalculator",
  "BackgroundCompressionService",
  "normalizeOutputFolder",
  "compressionSettingsKey",
  "extractMarkdownImageTargets",
  "closeMenu",
  "pluginsToDisableDuringCompression",
  "validation.pathNotAllowed",
  "compress.error.fileAccess",
  "too_large",
  "writeBinary",
  "maxInputBytes"
];
for (const token of requiredSemanticSourceTokens) {
  assert(combinedTsSource.includes(token), `TypeScript sources are missing expected semantic token: ${token}`);
}
assert(!compressorSource.includes("[key: string]: any"), "Compressor still has a class index signature");
assert(!compressorSource.includes("child_process"), "Compressor still imports child_process");
assert(!compressorSource.includes("spawn(") && !compressorSource.includes("spawnSync("), "Compressor still spawns native binaries");
assert(!compressorSource.includes("getPathCandidates") && !compressorSource.includes("resolveCommandFromPath"), "Compressor still contains native binary path resolution");
assert(!compressorSource.includes("withWasmTimeout") && !compressorSource.includes("Promise.race"), "Compressor still advertises a fake cancellable WASM timeout");
assert(!compressorSource.includes("@jsquash/jpeg/decode.js") && !compressorSource.includes("@jsquash/png/decode.js"), "Compressor still imports codec wrappers on the main thread");
assert(compressorSource.includes("WorkerPool") || compressorSource.includes("workerPool"), "Compressor is missing worker pool integration");
assert(/destroy\(\)\s*\{\s*this\.workerPool\.destroy\(/.test(compressorSource), "Compressor destroy is no longer a synchronous worker-pool teardown");
assert(!compressorSource.includes("this.worker?.postMessage"), "Compressor still posts directly to a worker");
assert(!compressorSource.includes("worker.postMessage"), "Compressor still owns worker message dispatch");
assert(!compressorSource.includes("_pluginDir"), "Compressor still accepts the unused _pluginDir constructor parameter");
assert(workerSlotSource.includes("postMessage") && workerSlotSource.includes("terminate"), "WorkerSlot is missing worker lifecycle operations");
assert(workerSlotSource.includes("needsRecreate"), "WorkerSlot is missing the lazy worker recreate flag");
assert(workerSlotSource.includes("WASM worker timed out after"), "WorkerSlot is missing real worker timeout handling");
assert(workerSlotSource.includes("WASM worker init timed out after"), "WorkerSlot is missing init timeout handling");
assert(workerSlotSource.includes("this.failActiveWorkerState(error, true)"), "WorkerSlot init timeout does not mark the worker for lazy retry");
assert(workerSlotSource.includes("Worker crashed:"), "WorkerSlot is missing worker.onerror crash handling");
assert(workerSlotSource.includes("new Blob([this.workerSource]") && workerSlotSource.includes("URL.createObjectURL(blob)") && workerSlotSource.includes("URL.revokeObjectURL"), "WorkerSlot is missing the Blob worker CSP-sensitive creation/revoke path");
assert(workerSlotSource.includes("Unhandled worker message") && workerSlotSource.includes("expecting"), "WorkerSlot is missing unhandled worker message diagnostics");
assert(workerSlotSource.includes("normalizeCompressionBuffer") && workerSlotSource.includes("ArrayBuffer.isView") && workerSlotSource.includes("empty or detached"), "WorkerSlot does not validate transferable compression buffers");
assert(/setWorkerTimeout\(\(\) => \{\s*if \(this\.destroyed\)/.test(workerSlotSource), "WorkerSlot timeout callbacks do not guard against firing after destroy");
assert(workerPoolSource.includes("class WorkerPool") && workerPoolSource.includes("waiters"), "WorkerPool is missing dispatcher queue logic");
assert(workerPoolSource.includes("staggeredInitQueue"), "WorkerPool is missing staggered initialization");
assert(workerPoolSource.includes("MAX_WAITERS") && workerPoolSource.includes("Worker pool waiters queue full"), "WorkerPool is missing a bounded waiter queue");
assert(compressorSource.includes("adapter.writeBinary"), "Compressor no longer writes through vault.adapter.writeBinary()");
assert(compressorSource.includes("compress.error.notSmaller") && !compressorSource.includes(">= ${originalSize}"), "Compressor not-smaller error still exposes exact byte sizes");
const failActiveWorkerStateSource = workerSlotSource.match(/failActiveWorkerState\([\s\S]*?\n  private terminateWorker\(\)/)?.[0] || "";
assert(failActiveWorkerStateSource && !failActiveWorkerStateSource.includes("initializeWasmModules("), "failActiveWorkerState should mark lazy recreate instead of eagerly initializing a worker");
assert(compressionWorkerSource.includes("image?.free?.()"), "Compression worker does not free ImagequantImage wrappers");
assert(compressionWorkerSource.includes("validateImagequantBindings") && compressionWorkerSource.includes("validateImagequantExports") && compressionWorkerSource.includes("Invalid imagequant WASM module"), "Compression worker does not validate imagequant bindings/WASM exports before __wbg_set_wasm");
assert(!compressionWorkerSource.includes("as unknown as (module: WebAssembly.Module"), "Compression worker still double-casts jsquash init functions");
assert(compressionWorkerSource.includes("isWorkerInitMessage") && compressionWorkerSource.includes("isWorkerCompressMessage") && compressionWorkerSource.includes("MessageEvent<unknown>"), "Compression worker does not validate worker message shape before dispatch");
assert(compressionWorkerSource.includes("Unknown or malformed message type") && compressionWorkerSource.includes("invalid_init_message"), "Compression worker does not report malformed protocol messages");
const initializeCodecsSource = compressionWorkerSource.match(/async function initializeCodecs[\s\S]*?\n}\n\nfunction validateImagequantRuntimeSmoke/)?.[0] || "";
assert(initializeCodecsSource && !initializeCodecsSource.includes("smokeQuantizer"), "Compression worker still runs the Imagequant smoke quantizer during init");
assert(compressionWorkerSource.includes("let imagequantSmokeValidated = false") && compressionWorkerSource.includes("function validateImagequantRuntimeSmoke") && compressionWorkerSource.includes("validateImagequantRuntimeSmoke();"), "Compression worker does not defer Imagequant smoke validation to first PNG compression");
assert(compressionWorkerSource.includes("initStage") && compressionWorkerSource.includes("WASM init failed at stage") && compressionWorkerSource.includes("initialized = false"), "Compression worker does not report/reset partial WASM init failures");
assert(compressionWorkerSource.includes("quality_failed"), "Compression worker does not classify PNG quality failures");
assert(compressionWorkerSource.includes("PngQualityFailureError") && compressionWorkerSource.includes("isImagequantQualityError") && !compressorSource.includes("quality_too_low") && !compressorSource.includes("minimum quality"), "PNG quality failure classification is still coupled to imagequant message text in Compressor");
assert(compressionWorkerSource.includes("safeMin") && compressionWorkerSource.includes("Math.max(safeMin"), "Compression worker does not clamp PNG quality defensively");
assert(compressorSource.includes("validateEncodedOutput"), "Compressor does not validate worker output before writing");
assert(compressionWorkerSource.includes("validateEncodedOutput"), "Compression worker does not validate encoded output before posting success");
assert(fs.readFileSync(path.join(sourceTsRoot, "encoded-output-validator.ts"), "utf8").includes("validatePngStructure"), "Encoded output validator is missing deep PNG validation");
assert(settingsSource.includes("normalizeSettings"), "Settings source is missing deep normalization");
assert(!combinedTsSource.includes("disablePasteImageRenameDuringCompression") && !combinedTsSource.includes("auto.pasteRenameGuard.name"), "Paste Image Rename guard opt-out setting returned to TypeScript sources");
const removedTechnicalSettingKeys = [
  "pngquantPath",
  "mozjpegPath",
  "pluginGuardTimeoutMs",
  "workerPoolSize",
  "compressionTimeoutSeconds",
  "wasmInitTimeoutSeconds",
  "maxInputSizeMB",
  "maxImagePixelsMillions"
];
for (const technicalKey of removedTechnicalSettingKeys) {
  assert(!settingsTabSource.includes(technicalKey), `Settings tab still references removed technical setting: ${technicalKey}`);
  assert(!readmeSource.includes(technicalKey) && !readmeRuSource.includes(technicalKey), `README still documents removed technical setting key: ${technicalKey}`);
}
assert(settingsSource.includes("INTERNAL_PLUGIN_GUARD_TIMEOUT_MS = 8_000"), "Settings source is missing internal plugin guard timeout");
assert(settingsSource.includes("INTERNAL_COMPRESSION_TIMEOUT_SECONDS = 120"), "Settings source is missing internal compression timeout");
assert(settingsSource.includes("INTERNAL_WASM_INIT_TIMEOUT_SECONDS = 60"), "Settings source is missing internal WASM init timeout");
assert(settingsSource.includes("INTERNAL_MAX_INPUT_SIZE_MB = 100"), "Settings source is missing internal input size limit");
assert(settingsSource.includes("INTERNAL_MAX_IMAGE_PIXELS_MILLIONS = 100"), "Settings source is missing internal image pixel limit");
assert(settingsSource.includes("function getInternalWorkerPoolSize") && settingsSource.includes("INTERNAL_MAX_WORKER_POOL_SIZE = 4"), "Settings source is missing adaptive internal worker pool sizing");
assert(!settingsTabSource.includes("auto.pasteRenameGuard.timeout") && !settingsTabSource.includes("settings.workerPoolSize") && !settingsTabSource.includes("settings.compressionTimeout") && !settingsTabSource.includes("settings.wasmInitTimeout") && !settingsTabSource.includes("settings.maxInputSize") && !settingsTabSource.includes("settings.maxImagePixels"), "Technical settings returned to the settings UI");
assert(!utilsSource.includes("|| /^[a-zA-Z]:/.test(normalizedPath)") && !settingsSource.includes("const outputFolder = typeof source.outputFolder"), "Low-severity utility/settings cleanup regressions are present");
assert(settingsSource.includes("inactivityThresholdMinutes") && settingsTabSource.includes("auto.bg.inactivity"), "Settings are missing configurable inactivity threshold support");
assert(settingsSource.includes("cacheRetentionMonths") && settingsTabSource.includes("stats.cache.retention"), "Settings are missing configurable cache retention support");
assert(compressorSource.includes("applySettings(settings") && pluginSource.includes("this.compressor?.applySettings?.(this.settings)"), "Compressor runtime limits are not applied from normalized settings");
assert(compressorSource.includes("app: App | null") && !compressorSource.includes("app: any | null"), "Compressor app reference is still typed as any");
assert(!settingsSource.includes("integer || 4"), "Worker pool sizing still contains a dead integer fallback");
assert(cacheSource.includes("flushPendingCacheSaveSync"), "Cache is missing synchronous unload flush");
assert(cacheSource.includes("syncFlushToken"), "Cache sync flush does not guard against late async write commits");
assert(cacheSource.includes("acquireCacheWriteLock") && cacheSource.includes("mergeDiskCacheEntries") && cacheSource.includes("pendingSaveMergeDiskEntries"), "Cache writes are missing multi-instance lock/merge coordination");
assert(!/buildCacheKey\([^\n;]*Date\.now\(\)/.test(runtimeQaSource), "Runtime QA builds synthetic cache keys with an inline Date.now() mtime");
// BR-H2 regression guard: coalesced saves must OR their merge intents (an additive write can never be
// downgraded to a disk-clobbering merge:false by a concurrent deletion sharing its debounce window),
// and clearCache must stay authoritative (force no-merge) so a trailing additive save cannot resurrect
// the entries it just cleared.
assert(
  cacheSource.includes("this.pendingSaveMergeDiskEntries || mergeDiskEntries") &&
  !cacheSource.includes("this.pendingSaveMergeDiskEntries && mergeDiskEntries") &&
  cacheSource.includes("pendingSaveAuthoritative") &&
  cacheSource.includes("mergeDiskEntries: false, authoritative: true"),
  "Cache save coalescing no longer ORs merge intents, or clearCache lost its authoritative no-merge flag (BR-H2)"
);
assert(cacheSource.includes("getCachePathEntries()") && !cacheSource.includes("Object.entries(this.cacheData.entries) as CachePathEntries"), "Cache still bypasses runtime entry validation with CachePathEntries casts");
assert(cacheSource.includes("selectEntryForMove(entries: CachePathEntries, outputPath: string | null = null)") && moveServiceSource.includes("compressedRelativePath"), "Move cache selection is not tied to the compressed output path");
assert(cacheSource.includes("resolveSourceMtime") && !cacheSource.includes("legacyParts.mtime || Date.now()") && !cacheSource.includes("mtime: unknown = Date.now()"), "Cache key creation still synthesizes Date.now() for missing source mtimes");
assert(cacheSource.includes("isSettingsSensitiveSkipReason") && cacheSource.includes("return !this.isSettingsSensitiveSkipReason(entry.skipReason)"), "Legacy settings-sensitive skipped entries still auto-match after settings changes");
assert(cacheSource.includes("getCacheBackupPath") && cacheSource.includes("getCacheBackupCleanupDirs") && !cacheSource.includes("slice(0, 19)") && !cacheSource.includes("@__PURE__"), "Cache backup naming/cleanup still uses truncated timestamps, duplicate cleanup plumbing, or obscure purity markers");
assert(cacheSource.includes("retainedFilesStatBatchSize") && !cacheSource.includes(".slice(0, 1000)"), "Cache retained-file cleanup still silently ignores retained files beyond the first 1000");
assert(!cacheSource.includes("crypto.randomBytes(4)"), "Cache backups still use a 32-bit random suffix");
assert(cacheSource.includes("realpath(backupFile)") && cacheSource.includes("validateBackupPathForRestore"), "Cache restore does not validate real backup paths before copying");
assert(cacheSource.includes("clonePlainRecord"), "Cache normalization does not deep-clone unknown top-level fields");
assert(typesSource.includes('"processed" | "pending_move"') && !cacheEntryTypeSource.includes("skipped?: boolean") && !cacheEntryTypeSource.includes("moved?: boolean") && !cacheEntryTypeSource.includes("movedAt?: number"), "CacheEntry type still exposes overlapping state booleans");
assert(typesSource.includes("skipReason?: string") && !typesSource.includes("reason?: string") && cacheSource.includes("normalizeCacheEntrySkipReason") && !cacheSource.includes("entry.reason"), "CacheEntry skip reason naming is not consolidated around skipReason");
assert(cacheSource.includes("normalizeCacheEntryState") && cacheSource.includes("stripLegacyCacheStateFields") && cacheSource.includes("stateUpdatedAt"), "Cache does not normalize legacy moved/skipped fields into canonical state");
assert(!cacheSource.includes("skipped: true") && !cacheSource.includes("moved: true") && !cacheSource.includes("movedAt: now"), "Cache mutation paths still write legacy moved/skipped state fields");
assert(!/entry\.(?:moved|skipped)\b/.test(cacheSource), "Cache matching still branches on legacy moved/skipped booleans");
assert(!utilsSource.includes("escapeHtml"), "Unused escapeHtml helper should stay removed; add a real DOM use before reintroducing it");
assert(utilsSource.includes("stripWindowsLongPathPrefix") && utilsSource.includes("isUncFilesystemPath") && utilsSource.includes("path.win32"), "Path helpers do not explicitly handle Windows UNC/long-path prefixes");
assert(utilsSource.includes("MAX_SANITIZED_PATH_LENGTH") && utilsSource.includes("getSensitivePathReplacement") && !utilsSource.includes("pathLikeExtensions") && !utilsSource.includes("[^\"'<>]*?"), "sanitizeErrorForUser still uses the old narrow/backtracking path regex sanitizer");
assert(!/catch\s*\([^)]*\)\s*\{\s*\}/.test(cacheSource), "Cache still contains empty catch blocks");
assert(!settingsTabSource.includes("ensureWasmReady?.()"), "Settings tab still initializes WASM workers while rendering status");
assert(!settingsTabSource.includes("requestWindowAnimationFrame(async"), "Settings tab still passes async callbacks directly to requestAnimationFrame");
assert(settingsTabSource.includes("this.containerEl?.win || this.getActiveWindow()"), "Settings animation frames are not scheduled on the owning settings window");
assert(progressModalSource.includes("this.contentEl?.win || this.getActiveWindow()"), "Progress modal animation frames are not scheduled on the owning modal window");
assert(pluginSource.includes("this.statusBarItem?.win || this.getActiveWindow()"), "Status-bar animation frames are not scheduled on the owning status-bar window");
assert(!settingsTabSource.includes("this.rerenderPreservingScroll =") && !settingsTabSource.includes("rerenderPreservingScroll: () => void"), "Settings tab still stores rerenderPreservingScroll as a constructor field");
assert(!settingsTabSource.includes("instanceof HTMLElement") && settingsTabSource.includes("typeof focusable?.focus === \"function\""), "Settings tab focus restore still only handles HTMLElement");
assert(settingsTabSource.includes("if (!containerEl)") && settingsTabSource.includes("displayWithoutScrollRestore"), "Settings tab rerender fallback does not guard missing container/fallback display collisions");
assert(settingsTabSource.includes("debouncedSaveSettings"), "Settings tab quality controls are missing debounced settings saves");
assert(!/add(?:Slider|Text)\([\s\S]{0,700}await this\.plugin\.saveSettings\(\)/.test(settingsTabSource), "Settings tab slider/text controls still save settings on every change event");
assert(settingsTabSource.includes("flushPendingSaveSettings") && settingsTabSource.includes("_renderRootsCleanups"), "Settings tab does not flush debounced saves or clean allowed-root pill listeners");
assert(settingsTabSource.includes("class AllowedRootsFolderSuggestModal extends obsidian.FuzzySuggestModal<string>") && !settingsTabSource.includes("new (class extends obsidian.FuzzySuggestModal"), "Allowed-roots picker still uses an anonymous FuzzySuggestModal subclass");
assert(settingsTabSource.includes("normalizeAllowedRootSelection") && settingsTabSource.includes("paths.allowedRoots.cannotAddRoot") && i18nSource.includes("paths.allowedRoots.cannotAddRoot"), "Allowed-roots picker does not handle root selection explicitly");
assert(settingsTabSource.includes("tiny-local-warning-block") && stylesSource.includes(".tiny-local-warning-block") && settingsTabSource.includes("tiny-local-roots-pill") && stylesSource.includes(".tiny-local-roots-pill") && !settingsTabSource.includes("warn.style.") && !settingsTabSource.includes("pill.style."), "Settings tab static warning/root-pill styles still live inline");
assert(settingsTabSource.includes('list.createEl("button", { text: root, cls: "badge tiny-local-roots-pill"') && settingsTabSource.includes('pill.setAttribute("aria-label"'), "Allowed-root removal pills are not keyboard-accessible buttons");
assert(!settingsTabSource.includes("debouncedWorkerPoolRestartNotice") && !settingsTabSource.includes("settings.workerPoolSize.restartNote"), "Settings tab still contains worker-pool restart UI for removed technical settings");
assert(settingsTabSource.includes("runButtonTask") && settingsTabSource.includes("common.refreshing") && settingsTabSource.includes("common.clearing") && i18nSource.includes("common.refreshing") && i18nSource.includes("common.clearing"), "Settings async stats buttons are missing loading/disabled state");
assert(settingsTabSource.includes("stats.ghosts.clearedCount") && i18nSource.includes("stats.ghosts.clearedCount") && !settingsTabSource.includes("stats.ghosts.name\").toLowerCase()"), "Ghost cleanup Notice still concatenates translated fragments");
assert(settingsTabSource.includes("applySubsettingVisibility") && (settingsTabSource.match(/\.settingEl\.toggle\(/g) || []).length === 1, "Settings conditional rows still duplicate raw settingEl.toggle calls");
assert(settingsTabSource.includes("registerDomEvent(container, 'mouseenter'") && !settingsTabSource.includes("container.addEventListener('mouseenter'"), "Savings tooltip listeners are not registered through the plugin lifecycle");
assert(settingsTabSource.includes("tooltipRoot") && !settingsTabSource.includes("activeDocument.body.appendChild") && !settingsTabSource.includes("activeDocument.body.removeChild"), "Savings tooltip DOM operations lack a body guard");
assert(settingsTabSource.includes("showSettingsOperationError") && settingsTabSource.includes("Move compressed files action failed") && settingsTabSource.includes("Cache restore action failed") && i18nSource.includes("notice.operationFailed"), "Settings async actions are missing shared error feedback");
assert(settingsTabSource.includes("getSavingsBarWidths") && settingsTabSource.includes("Number.isFinite(savings.savedSize)") && settingsTabSource.includes("Number.isFinite(savings.originalSize)"), "Savings bar widths are missing finite-number guards");
assert(stylesSource.includes(".tiny-local-savings-tooltip-wrapper") && stylesSource.includes(".tiny-local-savings-tooltip-target") && !settingsTabSource.includes("tooltip.style.position") && !settingsTabSource.includes("tooltip.style.zIndex") && !settingsTabSource.includes("tooltip.style.pointerEvents") && !settingsTabSource.includes("container.style.cursor"), "Savings tooltip static styles still live inline");
// Obsidian plugin guidelines compliance (2026-05-31): GL1 heading wording, GL2 setHeading not raw h3, GL3 tooltip position via CSS custom properties
assert(!/"section\.paths":\s*"[^"]*[Ss]ettings/.test(i18nSource) && !/"section\.paths":\s*"Настройки/.test(i18nSource), "section.paths heading still contains a redundant 'settings' word (Obsidian guideline #7)");
assert(!pluginSource.includes('createEl("h3"') && !pluginSource.includes("createEl('h3'"), "Backups modal still renders a raw h3 heading instead of Setting().setHeading() (Obsidian guideline #8)");
assert(settingsTabSource.includes("tooltip.setCssProps({") && settingsTabSource.includes('"--local-image-compress-savings-tooltip-left"') && settingsTabSource.includes('"--local-image-compress-savings-tooltip-top"') && !settingsTabSource.includes("tooltip.style.left") && !settingsTabSource.includes("tooltip.style.top") && stylesSource.includes("--local-image-compress-savings-tooltip-left") && stylesSource.includes("--local-image-compress-savings-tooltip-top"), "Savings tooltip position is not driven by CSS custom properties (Obsidian guideline #23)");
assert(i18nSource.includes("preloadExternalLanguages") && pluginSource.includes("await preloadExternalLanguages") && !i18nSource.includes("fs.existsSync") && !i18nSource.includes("fs.statSync") && !i18nSource.includes("fs.readFileSync"), "i18n still performs sync filesystem reads in the t() hot path");
assert(!i18nSource.includes("process.cwd()") && i18nSource.includes("if (!pluginDir)") && i18nSource.includes("return {};") && i18nSource.includes("pluginDir ? LOADED_LANGS"), "i18n external-language resolution does not fail closed when the vault plugin directory is unavailable");
assert(i18nSource.includes("TranslationParams") && i18nSource.includes("interpolateTranslation") && !/t\([^\n]+\)\.replace\(/.test(combinedTsSource), "Translated placeholders still rely on caller-side string replacement");
assert(i18nSource.includes("WARNED_LANG_LOAD_ERRORS") && i18nSource.includes("console.warn") && i18nSource.includes("i18n.externalLoadFailed"), "External language parse/load failures are still silent");
assert(i18nSource.includes('primary === "be"') && i18nSource.includes('primary === "by"') && i18nSource.includes("[missing translation key]") && i18nSource.includes("`[${key}]`"), "i18n locale/missing-key fallback semantics are incomplete");
assert(compressionWorkerSource.includes("getCachedWasmModule") && !compressionWorkerSource.includes("new WebAssembly.Module(message.wasm.jpeg"), "Compression worker still recompiles JPEG WASM modules for every init");
assert(compressionWorkerSource.includes("getImagequantBindingModule") && !compressionWorkerSource.includes("as any"), "Compression worker still bypasses imagequant binding validation with any casts");
assert(imageIndexSource.includes("pendingRebuildMutations") && imageIndexSource.includes("const nextRecords = new Map") && imageIndexSource.includes("this.records = nextRecords") && !imageIndexSource.includes("this.records.clear()"), "ImageIndex rebuild still mutates the live records map instead of atomically swapping");
assert(imageIndexSource.includes("refreshProcessedStatesForRecords") && imageIndexSource.includes("await this.options.yieldToUi();"), "ImageIndex rebuild/refresh does not use an isolated processed-state pass with a UI yield");
assert(settingsTabSource.includes("parseInt(minPart, 10)") && settingsTabSource.includes("parseInt(maxPart, 10)"), "Settings tab integer parsing still omits radix");
assert(compressorSource.includes("getSavingsPercentage") && savingsCalculatorSource.includes("getSavingsPercentage") && savingsCalculatorSource.includes("getDisplaySavingsPercentage"), "Savings percentage formatting is missing finite/bounds guards");
assert(savingsCalculatorSource.includes("!Number.isFinite(bytes) || bytes <= 0") && savingsCalculatorSource.includes("Math.min(sizes.length - 1"), "File-size formatting still allows NaN/Infinity unit indexes");
assert(cacheSource.includes("getCacheLoadErrorKind") && cacheSource.includes("logCacheLoadFailure") && cacheSource.includes("Cache load failed (") && cacheSource.includes("resolveSourceSize") && !cacheSource.includes("file?.stat ? file.stat.size : originalSize"), "Cache load/source-size error handling still lacks classification or has nested ternary fallback");
assert(utilsSource.includes("AppWithActiveWorkspaceDom") && utilsSource.includes("getActiveWindowForApp") && eventRouterSource.includes("VaultWithOptionalConfigChange") && !pluginSource.includes("this.app.workspace as any") && !eventRouterSource.includes("this.plugin.app.vault as any"), "Plugin still uses untyped workspace/vault event casts for runtime APIs");
assert(compressorSource.indexOf("await this.ensureWasmReady()") < compressorSource.indexOf("await this.readBinaryWithTimeout"), "Compressor reads image bytes before WASM readiness");
assert(compressorSource.includes("readBinaryWithTimeout") && compressorSource.includes("File read timed out after"), "Compressor does not bound vault.readBinary with a timeout");
assert(compressorSource.includes("const filePath = pathOverride || file?.path") && !compressorSource.includes("pathOverride || file.path || \"\""), "Compressor still falls through an empty path to extension parsing");
assert(compressorSource.includes("isJpegEncodingFailure") && compressionWorkerSource.includes("jpeg_encode_failed") && pluginSource.includes("mozjpeg_failed"), "JPEG worker encode failures are not classified and tracked distinctly");
assert(!pluginSource.includes("setupThemeAdaptation") && !pluginSource.includes("getCurrentPngquantVersion") && !pluginSource.includes("getCurrentMozjpegVersion"), "Plugin still contains dead theme/version compatibility shims");
assert(
  migrationRunnerSource.includes("moveOrCopyMigrationItem")
    && migrationRunnerSource.includes("mergeMigrationItem")
    && migrationRunnerSource.includes("verifyMigrationItem")
    && migrationRunnerSource.includes("fs.constants.COPYFILE_EXCL")
    && migrationRunnerSource.includes("sourceStat.isSymbolicLink()")
    && migrationRunnerSource.includes("fs.promises.rm(src, { recursive: true, force: true })")
    && migrationRunnerSource.includes("readdir(src, { withFileTypes: true })")
    && migrationRunnerSource.includes("migrationErrors"),
  "Backup migration does not merge safely, verify copy fallback data, use Dirent recursion, and report partial failures"
);
assert(
  backupStorageSource.includes('BACKUP_STORAGE_FOLDER = ".local-image-compress"')
    && backupStorageSource.includes('path.join(backupsRoot, "cache")')
    && backupStorageSource.includes('path.join(backupsRoot, "originals")'),
  "Backup storage paths are not centralized under the vault-level .local-image-compress folder"
);
assert(cacheSource.includes("CACHE_BACKUP_MAX_COUNT = 50"), "Cache backups are not capped at 50 files");
assert(!pluginSource.includes("autoBackgroundThreshold || 50") && pluginSource.includes("autoBackgroundThreshold ?? 50"), "Runtime settings still use || instead of ?? for autoBackgroundThreshold");
assert(moveServiceSource.includes("fs.promises.open(leftPath") && !moveServiceSource.includes("fs.readFileSync(leftPath)"), "MoveService does not stream same-content comparisons");
assert(moveServiceSource.includes("prepassLimiter") && moveServiceSource.includes("getIOConcurrency"), "MoveService backup prepass is not concurrency-limited for disk I/O");
assert(moveServiceSource.includes("originalSha256") && moveServiceSource.includes("streamHashSha256"), "MoveService backup verification does not hash source content");
// T1 / H1 regression guard: the 3-phase SHA-256 content verification must stay intact
// so a future refactor cannot silently drop anti-tampering protection without failing here.
// (Phase 1 = prepass hash, asserted above via originalSha256/streamHashSha256.)
assert(
  moveServiceSource.includes("currentOriginalSha256") &&
  moveServiceSource.includes("!== task.originalSha256") &&
  moveServiceSource.includes("move.skip.originalContentChangedDuringBackup"),
  "MoveService verify phase no longer re-hashes the ORIGINAL to reject same-size content substitution (H1 phase 2)"
);
assert(
  moveServiceSource.includes("currentCompressedSha256") &&
  moveServiceSource.includes("!== task.compressedSha256") &&
  moveServiceSource.includes("move.skip.compressedContentChangedDuringBackup"),
  "MoveService verify phase no longer re-hashes the COMPRESSED file to reject same-size content substitution (H1 phase 2)"
);
assert(
  moveServiceSource.includes("streamHashSha256(task.backupFilePath)") &&
  moveServiceSource.includes("streamHashSha256(task.compressedBackupPath)") &&
  moveServiceSource.includes("move.skip.contentChangedDuringCopy") &&
  /cleanupBackupTaskFiles\(task\)[\s\S]{0,400}contentChangedDuringCopy/.test(moveServiceSource),
  "MoveService post-copy phase no longer re-hashes the written backup and cleans up on mismatch (H1 phase 3)"
);
// BR-H1 regression guard: the destructive overwrite (moveSingleFile) must re-verify CONTENT, not
// just byte length, before renaming over the user's original — re-hash the staged temp bytes and
// compare to the backup-verified compressedSha256, positioned before the rename.
assert(
  moveServiceSource.includes("streamHashSha256(tempOriginalPath)") &&
  moveServiceSource.includes("!== compressedFile.compressedSha256") &&
  moveServiceSource.indexOf("streamHashSha256(tempOriginalPath)") < moveServiceSource.indexOf("rename(tempOriginalPath, originalPath)"),
  "MoveService overwrite no longer re-hashes the staged compressed bytes before the destructive rename (BR-H1)"
);
assert(!moveServiceSource.includes("crypto.randomBytes(4)"), "MoveService backup paths still use a 32-bit random suffix");
assert(moveServiceSource.includes("randomHexSuffix(16)"), "MoveService backup/temp paths do not request 128-bit random suffixes explicitly");
assert(moveServiceSource.includes("normalizeVaultPathForComparison(await fs.promises.realpath(dirPath))"), "MoveService compressed scan does not normalize realpath loop detection keys");
assert(concurrencyLimiterSource.includes("RangeError") && concurrencyLimiterSource.includes("isValidLimit"), "ConcurrencyLimiter does not reject invalid limits at construction time");
assert(!concurrencyLimiterSource.includes("getActiveCount()") && !concurrencyLimiterSource.includes("getQueueDepth()"), "ConcurrencyLimiter still exposes dead diagnostic active/queue getters");
assert(concurrencyLimiterSource.includes("Promise.resolve()") && concurrencyLimiterSource.includes("releaseNext()"), "ConcurrencyLimiter does not isolate queued waiter release failures");
assert(backgroundCompressionServiceSource.includes("getReadyUncompressedCount") && !backgroundCompressionServiceSource.includes('workspace as any).on("file-open"') && !backgroundCompressionServiceSource.includes('workspace as any).on("layout-change"'), "Background compression still uses stale snapshots or workspace layout events as user activity");
assert(backgroundCompressionServiceSource.includes("lastUserActivityPerfTime") && backgroundCompressionServiceSource.includes("getMonotonicTime()") && !backgroundCompressionServiceSource.includes("Date.now() - this.plugin.backgroundCompressionService.lastUserActivity"), "Background inactivity still uses wall-clock deltas instead of monotonic time");
assert(backgroundCompressionServiceSource.includes("BACKGROUND_FILTER_CONCURRENCY") && backgroundCompressionServiceSource.includes("filterUnprocessedFiles") && backgroundCompressionServiceSource.includes("hasReadyIndex") && backgroundCompressionServiceSource.includes(": this.plugin.getAllImageFiles()") && !backgroundCompressionServiceSource.includes("for (const file of filteredFiles)"), "Background compression still filters processed files sequentially or routes not-ready fallback through getImageFiles()");
assert(pluginSource.includes("PLUGIN_ASYNC_FILTER_CONCURRENCY") && pluginSource.includes("filterUnprocessedImageFiles") && pluginSource.includes("new ConcurrencyLimiter(concurrency)") && pluginSource.includes("filterUnprocessedImageFiles(this.getAllImageFiles())") && pluginSource.includes("filterUnprocessedImageFiles(targetFiles)") && pluginSource.includes("filterUnprocessedImageFiles(imageFiles)).length") && !pluginSource.includes("for (const file of imageFiles)") && !pluginSource.includes("for (const file of targetFiles)") && !pluginSource.includes("let uncompressedImages = 0"), "Plugin still has sequential async image filtering instead of the shared bounded helper");
assert(pluginSource.includes("Re-normalize before save because UI/event mutations") && pluginSource.includes("sort((left, right) => left.localeCompare(right))"), "Settings save/index config does not document re-normalization or canonicalize allowedRoots order");
assert(pluginSource.includes("isImageFile(file: unknown): file is obsidian.TFile") && !pluginSource.includes("return this.SUPPORTED_IMAGE_EXTENSIONS.includes(file.extension.toLowerCase())"), "Plugin image-file check is not null-safe or typed as a TFile predicate");
assert(pluginSource.includes("intentionally uses || instead of ??") && pluginSource.includes("Returns every supported image file") && pluginSource.includes("Returns only uncompressed image files"), "Plugin output-folder fallback or image-file method naming intent is undocumented");
assert(pluginSource.includes("progress.error\")} (${fileLabel})") && pluginSource.includes('reason === "too_large"') && cacheSource.includes('skipReason === "too_large"'), "Compression errors or too_large skip settings keys are missing class-wide guards");
assert(pluginSource.includes('new Set(["/", ...folders.map') && !pluginSource.includes('folderPaths.unshift("/")'), "Folder selector still filters root and re-adds it with unshift");
assert(pluginSource.includes("notice.compressionDeferredDueToMove") && i18nSource.includes("notice.compressionDeferredDueToMove"), "Move-in-progress compression deferral Notice is missing specific i18n coverage");
assert(pluginSource.includes("Snapshot defensively because UI/event mutations") && pluginSource.includes("const indexUpdatePromise = isOutputPath"), "Batch settings snapshot or modify-event scheduling intent is not guarded");
assert(pluginSource.includes("PLUGIN_BACKUP_DELETE_CONCURRENCY") && pluginSource.includes("backupDeleteLimiter") && pluginSource.includes("Promise.allSettled(backups.map") && !pluginSource.includes("for (const backup of backups)"), "Original-files backup cleanup still deletes backup directories sequentially");
assert(pluginSource.includes("readdir(backupDir, { withFileTypes: true })") && !pluginSource.includes("fs3.promises.lstat(backupPath)") && pluginSource.includes("backup.isFile()") && pluginSource.includes("fs3.promises.unlink(backupPath)"), "Original-files backup cleanup still uses lstat per entry or leaves orphan files in backupDir");
assert(pluginSource.includes("BACKGROUND_COMPRESSION_NOTICE_COOLDOWN_MS") && pluginSource.includes("backgroundCompressionNoticeAt"), "Background compression notices are not rate-limited");
assert(statusBarControllerSource.includes("status bar item is not visible") && statusBarControllerSource.includes("rect.width === 0"), "Status menu does not guard hidden zero-size status bar targets");
assert(!statusBarControllerSource.includes("activeDocument.createDiv") && !settingsTabSource.includes("activeDocument.createDiv"), "Document-level createDiv appends to the document root instead of creating a safe body-owned element");
assert(
  statusBarControllerSource.includes("openStatusMenuDocument")
    && statusBarControllerSource.includes("accessibleStatusText")
    && statusBarControllerSource.includes("const activeDocument = this.plugin.getActiveDocument()")
    && statusBarControllerSource.includes("const activeWindow = this.plugin.getActiveWindow()")
    && statusBarControllerSource.includes("createMenu(event, uncompressedCount, totalCount, movableCompressedCount, activeDocument)")
    && statusBarControllerSource.includes("positionMenu(menu, event, activeWindow)"),
  "Status bar controller does not keep menu document/window context atomic"
);
assert(statusBarControllerSource.includes("this.plugin.isUnloading") && statusBarControllerSource.includes("this.openStatusMenu !== menu"), "Status menu deferred click listener does not guard unload/stale menu state");
assert(pluginSource.includes("registerDomEvent(this.statusBarItem") && !statusBarControllerSource.includes(".onclick ="), "Status bar click handler is still reassigned from update()");
assert(pluginSource.includes('setAttribute?.("role", "button")') && pluginSource.includes('setAttribute?.("tabindex", "0")') && pluginSource.includes('setAttribute?.("aria-haspopup", "menu")') && pluginSource.includes('setAttribute?.("aria-expanded", "false")'), "Status bar item is missing keyboard/ARIA button semantics");
assert(pluginSource.includes('registerDomEvent(this.statusBarItem, "keydown"') && pluginSource.includes('event.key !== "Enter" && event.key !== " "') && pluginSource.includes("keyboard: true"), "Status bar item is missing Enter/Space keyboard activation");
assert(statusBarControllerSource.includes('menu.setAttribute("role", "menu")') && statusBarControllerSource.includes('menu.createEl("button"') && statusBarControllerSource.includes('setAttribute("role", "menuitem")') && !statusBarControllerSource.includes('const menuItem = menu.createEl("div"'), "Status menu actions are not button-backed menuitems");
assert(statusBarControllerSource.includes("focusFirstMenuItem(menu)") && statusBarControllerSource.includes("restoreStatusMenuFocus") && statusBarControllerSource.includes("requestWindowAnimationFrame") && statusBarControllerSource.includes("e.stopImmediatePropagation()") && statusBarControllerSource.includes('"ArrowDown"') && statusBarControllerSource.includes('"ArrowUp"') && statusBarControllerSource.includes('"Home"') && statusBarControllerSource.includes('"End"'), "Status menu keyboard focus management is missing");
assert(!statusBarControllerSource.includes("console.debug"), "Status bar controller still logs debug output in production paths");
assert(statusBarControllerSource.includes("setCssProps({") && statusBarControllerSource.includes("\"--local-image-compress-status-menu-left\"") && statusBarControllerSource.includes("\"--local-image-compress-status-menu-top\"") && statusBarControllerSource.includes("\"--local-image-compress-status-menu-transform\"") && !statusBarControllerSource.includes("menu.style.left") && !statusBarControllerSource.includes("menu.style.top") && !statusBarControllerSource.includes("menu.style.transform"), "Status bar menu positioning still uses direct inline left/top/transform assignments");
assert(statusBarControllerSource.includes("positionMenu(menu, event, activeWindow)") && statusBarControllerSource.includes("STATUS_MENU_FALLBACK_WIDTH = 360") && statusBarControllerSource.includes("viewportWidth - menuWidth - STATUS_MENU_VIEWPORT_MARGIN"), "Status bar menu does not clamp measured width to the active viewport");
assert(stylesSource.includes("max-width: min(360px, calc(100vw - 20px))") && stylesSource.includes("background-color: transparent") && stylesSource.includes("box-shadow: none") && stylesSource.includes("text-overflow: ellipsis"), "Status bar menu CSS does not protect against edge overflow and theme button backgrounds");
const statusMenuTransitionRules = [...stylesSource.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter((match) => match[1].split(",").some((selector) => selector.trim() === ".tiny-local-status-menu"))
  .map((match) => match[2])
  .filter((declarations) => /\btransition(?:-property)?\s*:/.test(declarations));
assert(
  statusMenuTransitionRules.every((declarations) => {
    const transitionValues = [...declarations.matchAll(/\btransition(?:-property)?\s*:\s*([^;]+)/g)]
      .map((match) => match[1].toLowerCase());
    return transitionValues.every((value) => !/(^|[\s,])(all|left|top|transform)([\s,]|$)/.test(value));
  }),
  "Status bar menu still transitions dynamic position properties"
);
assert(stylesSource.includes(".tiny-local-status-menu .tiny-local-status-menu-item:focus-visible") && stylesSource.includes("outline: 2px solid var(--interactive-accent)") && !stylesSource.includes("outline: none"), "Status bar menu focus styling does not expose a visible Obsidian-themed keyboard indicator");
assert(!stylesSource.includes("--local-image-compress-status-menu-highlight") && !stylesSource.includes("color-mix(in srgb, var(--interactive-accent)") && !stylesSource.includes("box-shadow: inset 3px 0 0 var(--interactive-accent)"), "Status bar menu still uses a custom accent hover/focus treatment");
assert(stylesSource.includes(".tiny-local-status-trigger:focus-visible") && stylesSource.includes(".tiny-local-savings-tooltip-target:focus-visible"), "Custom status/tooltip focus targets are missing visible focus styles");
assert(!statusBarControllerSource.includes("\"mouseenter\"") && !statusBarControllerSource.includes("\"mouseleave\"") && !stylesSource.includes("tiny-local-status-menu-item-hover"), "Status bar menu hover still uses JS listeners instead of CSS :hover");
assert(!/#[0-9A-Fa-f]{3,8}\b|rgba?\(|hsla?\(/.test(stylesSource), "styles.css contains hardcoded color literals");
const importantAllowlist = new Map();
const importantDeclarations = [...stylesSource.matchAll(/([^{}]+)\{([^{}]*!important[^{}]*)\}/g)]
  .map((match) => match[1].trim());
assert(importantDeclarations.every((selector) => importantAllowlist.has(selector)), `styles.css has unapproved !important selectors: ${importantDeclarations.join(", ")}`);
assert(!/transition\s*:\s*all\b/i.test(stylesSource), "styles.css contains a broad transition: all rule");
assert(stylesSource.includes("@media (prefers-reduced-motion: reduce)") && stylesSource.includes(".tiny-local-savings-tooltip") && stylesSource.includes("animation: none"), "Motion surfaces are missing reduced-motion overrides");
const tinyLocalCssClasses = new Set([...stylesSource.matchAll(/\.([A-Za-z_][\w-]*)/g)]
  .map((match) => match[1])
  .filter((className) => className.startsWith("tiny-local-")));
const tinyLocalClassUsageSource = [
  pluginSource,
  folderSelectorModalSource,
  cacheBackupsViewSource,
  ...serviceSources,
  cacheSource,
  compressorSource,
  compressionWorkerSource,
  progressModalSource,
  settingsTabSource,
  statusBarControllerSource,
  moveServiceSource,
  imageScannerSource,
  savingsCalculatorSource
].join("\n");
const tinyLocalUsedClasses = new Set([...tinyLocalClassUsageSource.matchAll(/tiny-local-[\w-]+/g)].map((match) => match[0]));
const orphanTinyLocalClasses = [...tinyLocalCssClasses].filter((className) => !tinyLocalUsedClasses.has(className));
assert(orphanTinyLocalClasses.length === 0, `styles.css contains orphan tiny-local classes: ${orphanTinyLocalClasses.join(", ")}`);
assert(moveServiceSource.includes("move.warning.externalModification"), "MoveService does not notify on external move modification");
assert(moveServiceSource.includes("getMoveSkipReasonGroups") && moveServiceSource.includes("tiny-local-move-skip-reasons"), "MoveService does not show grouped skip reasons in move results");
assert(moveServiceSource.includes("isCompleteBackupTask") && !/backupFilePath!|compressedBackupPath!|originalPath!|byName\.get\(file\.name\)!/.test(moveServiceSource), "MoveService backup flow still uses unsafe non-null assertions");
assert(moveServiceSource.includes("isCandidateOriginalFile(file: unknown): file is obsidian.TFile") && !moveServiceSource.includes("Map<string, any[]>"), "MoveService original file lookup is missing a shared TFile candidate predicate");
assert(moveServiceSource.includes("normalizeVaultPath(compressedFile.relativePath") && !/compressedFile\.relativePath[\s\S]{0,100}\.replace\(/.test(moveServiceSource), "MoveService still normalizes compressed relative paths with inline string replacement");
assert(moveServiceSource.includes("pathsReferToSameFile") && moveServiceSource.includes("move.skip.selfMove"), "MoveService does not guard compressed/original self-moves");
assert(moveServiceSource.includes("move.skip.noOriginalCandidate") && moveServiceSource.includes("displaySkippedCount"), "MoveService does not account zero-candidate originals or derive skipped totals from reason groups");
assert(i18nSource.includes("move.backup.createdCount") && i18nSource.includes("backups.imagesFolder.deletedCount"), "Backup notices are missing i18n keys");
assert(i18nSource.includes("normalizeVaultPathForComparison(pluginDir)") && i18nSource.includes("LOADED_LANGS[cacheKey]"), "i18n external-language cache is not scoped by plugin directory");
assert(!moveServiceSource.includes("Created backup of ${") && !pluginSource.includes("Backups folder not found") && !pluginSource.includes("No backups to delete"), "Backup notices still contain hardcoded English text");
assert(pluginSource.includes("compressionWorkflowsInFlight") && pluginSource.includes("waitForCompressionIdle") && moveServiceSource.includes("await this.plugin.waitForCompressionIdle()"), "Move flow does not wait for active compression workflows");
assert(pluginSource.includes("indexRefreshTimers: Map<string, TimerHandle>") && pluginSource.includes("clearIndexRefreshTimer") && pluginSource.includes("file:${normalizedPath}"), "Image index refresh scheduling is not deduped by path");
assert(pluginSource.includes("waitForCompressionIdle(maxWaitMs = 60_000)") && pluginSource.includes("waitForCompressionIdle giving up after") && !pluginSource.includes("queueMicrotask(() => resolve(undefined))"), "Compression idle wait can still spin forever or fall back to a microtask-only tick");
assert(newFileQueueSource.includes("NEW_FILE_PENDING_MAX") && newFileQueueSource.includes("auto.queueFull"), "Plugin does not cap the new-file auto-compress queue");
assert(pluginSource.includes("background.starting") && pluginSource.includes("background.finished"), "Background compression does not notify users about larger batches");
assert(pluginSource.includes("GHOST_CLEANUP_COMPRESSED_THRESHOLD") && pluginSource.includes("maybeCleanupGhostEntriesAfterCompression"), "Plugin does not automatically clean ghost cache entries after enough successful compressions");
assert(pluginSource.includes("STALE_CACHE_PRUNE_COMPRESSED_THRESHOLD") && pluginSource.includes("maybePruneStaleCacheEntriesAfterCompression"), "Plugin does not automatically prune stale cache entries after enough successful compressions");
assert(cacheSource.includes("pruneStaleCacheEntries") && cacheSource.includes("lastAccessMs"), "Cache is missing stale-entry retention with last-access tracking");
assert(cacheSource.includes("scheduleLastAccessSave") && cacheSource.includes("lastAccessSaveIntervalMs"), "Cache lastAccessMs touches are not persisted through a bounded save path");
assert(cacheSource.includes("!this.hasNonNegativeSize(entry.outputSize)") && cacheSource.includes("!this.hasFiniteNumber(entry.outputMtime)"), "pending_move output matching still accepts entries without output size/mtime identity");
assert(cacheSource.includes("Cannot mark moved file without processed mtime/size"), "Moved cache entries still allow missing processed identity");
assert(cacheSource.includes("lastInvalidMtimeFallback") && cacheSource.includes("nextInvalidMtimeFallback"), "Cache invalid mtime fallback is not monotonic");
assert(pluginSource.includes("applyRuntimeSettings") && pluginSource.includes("backgroundCompressionService?.applySettings") && backgroundCompressionServiceSource.includes("USER_INACTIVITY_THRESHOLD"), "Plugin does not apply normalized runtime inactivity settings");
assert(folderSelectorModalSource.includes("extends obsidian.Modal") && folderSelectorModalSource.includes("override onOpen()") && folderSelectorModalSource.includes("override onClose()"), "Folder selector is not implemented as an Obsidian Modal lifecycle component");
assert(!folderSelectorModalSource.includes("activeDocument.body.appendChild") && !folderSelectorModalSource.includes("activeDocument.body.removeChild") && !folderSelectorModalSource.includes("modal-container"), "Folder selector still owns a manual body overlay");
assert(folderSelectorModalSource.includes("plugin.trackManagedModal(modal)") && folderSelectorModalSource.includes("this.plugin.untrackManagedModal(this)") && folderSelectorModalSource.includes("resolveIfPending(null)"), "Folder selector is not tracked or does not resolve pending promises on close");
assert(folderSelectorModalSource.includes("folderSelect.selectLabel") && folderSelectorModalSource.includes('contentEl.setAttribute("aria-labelledby"'), "Folder selector modal is missing accessible title/select labels");
assert(folderSelectorModalSource.includes("tiny-local-folder-select-control") && stylesSource.includes(".tiny-local-folder-select-control") && !folderSelectorModalSource.includes("select.style.width"), "Folder selector select still uses inline styles instead of CSS class");
assert(!pluginSource.includes("folders.root") && !pluginSource.includes("common.select") && !pluginSource.includes("common.cancel"), "Folder selector still contains dead i18n fallback keys");
assert(pluginSource.includes("managedModals") && pluginSource.includes("closeManagedModals"), "Plugin does not close managed modals on unload");
assert(progressModalSource.includes("this.plugin.untrackManagedModal(this)") && moveServiceSource.includes("this.plugin.trackManagedModal(modal)") && settingsTabSource.includes("this.plugin.trackManagedModal(new AllowedRootsFolderSuggestModal"), "Plugin-owned progress/settings modals are not tracked through unload cleanup");
assert(cacheBackupsViewSource.includes("openButton.removeEventListener") && moveServiceSource.includes("closeButton.removeEventListener"), "Modal click listeners are not explicitly cleaned up on close");
assert(
  pluginSource.includes("captureModalFocusTarget()")
    && pluginSource.includes("restoreModalFocus(")
    && pluginSource.includes("modalFocusTimers")
    && folderSelectorModalSource.includes("restoreModalFocus(this.returnFocusTo)")
    && progressModalSource.includes("restoreModalFocus(this.returnFocusTo)")
    && moveServiceSource.match(/restoreModalFocus\(this\.returnFocusTo\)/g)?.length === 2
    && cacheBackupsViewSource.includes("restoreModalFocus(this.returnFocusTo)")
    && settingsTabSource.includes("restoreModalFocus(this.returnFocusTo)"),
  "Custom modal classes do not consistently capture and restore trigger focus"
);
assert(
  statusBarControllerSource.includes("this.closeMenu(true)") && moveServiceSource.includes("scheduleElementFocus(closeButton)") && cacheBackupsViewSource.includes("scheduleElementFocus(openButton)"),
  "Keyboard menu actions or custom modal controls are missing deterministic focus entry"
);
assert(folderSelectorModalSource.includes("contentEl.removeEventListener") && folderSelectorModalSource.includes("listenerCleanups"), "Folder selector listeners are not explicitly cleaned up on close");
assert(pluginSource.includes("isInitialized") && pluginSource.includes("handleInitializationFailure") && pluginSource.includes("cleanupRuntimeState"), "Plugin startup does not fence partial initialization failures");
assert(pluginSource.includes("scheduleStartupImageIndexRebuild()") && pluginSource.includes("queueStartupImageIndexRebuild()") && pluginSource.includes("runStartupImageIndexRebuild()"), "Startup image index rebuild is not owned by a named background helper");
assert(pluginSource.includes("override onload(): void") && pluginSource.includes("startInitializationAfterLayoutReady") && pluginSource.includes("this.app.workspace.onLayoutReady") && pluginSource.indexOf("await this.initializePlugin()") > pluginSource.indexOf("async loadPlugin()"), "Plugin initialization is not deferred behind the layout-ready boundary");
assert(pluginSource.includes("if (this.isUnloading || !this.isInitialized)") && pluginSource.indexOf("if (this.isUnloading || !this.isInitialized)") < pluginSource.indexOf("this.imageScanner.invalidateImageLookupCache()"), "Vault create handling is not fenced until layout-ready initialization completes");
assert(!pluginSource.includes("await this.setupStatusBar()") && pluginSource.indexOf("this.setupStatusBar();") < pluginSource.indexOf("this.setupEventListeners()"), "Status bar setup is still awaited or ordered after event registration");
assert(!setupStatusBarSource.includes('rebuildImageIndex("startup")') && !setupStatusBarSource.includes("await this.statusBarController.update()"), "setupStatusBar() still blocks on startup image indexing");
assert(pluginSource.includes('const key = "startup-image-index"') && pluginSource.includes("await this.runStartupImageIndexRebuild()") && pluginSource.includes("Startup image-index rebuild failed"), "Startup image index rebuild is missing timer ownership or error handling");
assert(pluginSource.indexOf("this.isInitialized = true;") < pluginSource.indexOf("this.scheduleStartupImageIndexRebuild();"), "Startup image index rebuild is scheduled before base plugin initialization is complete");
assert(i18nSource.includes("init.failed"), "Initialization failure notice is missing i18n coverage");
assert(pluginGuardSource.includes("guard.disabled") && pluginGuardSource.includes("guard.restored") && pluginGuardSource.includes("new obsidian.Notice"), "Plugin guard does not notify on disable/restore");
assert(pluginGuardSource.includes("releaseAllGuards") && pluginSource.includes("releaseAllGuards"), "Plugin guard does not restore guarded plugins during unload");
assert(pluginGuardSource.includes("observedEnabledAfterGuardDisable") && pluginGuardSource.includes("shouldRestoreGuardedPlugin") && pluginGuardSource.includes("startGuardStateMonitor"), "Plugin guard restore does not respect user/external toggles during guard");
assert(pluginGuardSource.includes("scheduleEnableRetry") && pluginGuardSource.includes("allowEnableRetry") && pluginGuardSource.includes("disabledByGuard"), "Plugin guard does not handle enable timeouts or idempotent disable ownership");
assert(pluginGuardSource.includes("releaseGuardsInParallel") && pluginGuardSource.includes("Promise.allSettled") && !/for\s*\(\s*const id of acquired\.reverse\(\)\s*\)\s*\{\s*await this\.release\(id\)/.test(pluginGuardSource), "Plugin guard withDisabled() still releases acquired guards sequentially");
assert(pluginGuardSource.includes("operationTimedOut") && !pluginGuardSource.includes("operationCompleted.then((completed)"), "Plugin guard late-disable restore still uses an orphan operationCompleted continuation");
assert(imageScannerSource.includes("stripMarkdownCode") && imageScannerSource.includes("getWikiTargetBeforeAlias") && imageScannerSource.includes("\\\\([() |])"), "Image scanner does not handle escaped wiki pipes/code blocks");
assert(imageScannerSource.includes("imageLookupCache") && pluginSource.includes("invalidateImageLookupCache"), "Image scanner lookup cache is missing invalidation hooks");
assert(!cacheSource.includes("Math.random") && !compressorSource.includes("Math.random") && !moveServiceSource.includes("Math.random"), "Temp file naming still uses Math.random");
assert(savingsCalculatorSource.includes("Promise.all(fetchTasks.map"), "Savings calculator does not parallelize compressed size fetches within a batch");
assert(savingsCalculatorSource.includes("getInterruptedSavingsResult") && savingsCalculatorSource.includes("this.plugin.isUnloading"), "Savings calculator does not stop safely after unload during UI yields");
assert(moveServiceSource.includes("skipForUnload") && moveServiceSource.includes("move.skip.unloading"), "Move service does not stop safely when plugin unloads before backup/move file operations");
assert(pluginSource.includes("if (this.isUnloading)") && pluginSource.includes("!this.isUnloading && shouldAutoMove"), "Direct compression flows do not stop safely around unload boundaries");
assert(savingsCalculatorSource.includes("MAX_ESTIMATED_COMPRESSION_RATIO = 30") && !savingsCalculatorSource.includes("currentSize * 10"), "Savings calculator still uses the old 10x estimation cap");
assert(!savingsCalculatorSource.includes("WEBP_SMALL") && !savingsCalculatorSource.includes('case "webp"'), "Savings calculator still has WebP-specific ratios despite WebP not being supported");
assert(savingsCalculatorSource.includes("typedSavings.totalFiles > 0 || typedSavings.processedFiles > 0 || typedSavings.estimatedFiles > 0"), "Savings validation still requires processed files instead of accepting all-skipped activity");
assert(!pluginSource.includes("savings.processedFiles > 0 && savings.savedSize > 0"), "Plugin still treats zero-savings activity as invalid savings data");
assert(cacheSource.includes("getEntriesForPathFromMap") && cacheSource.includes("normalizeVaultPathForComparison(this.normalizeVaultPath(filePath))"), "Cache path index lookup is missing comparison-normalized getEntriesForPathFromMap()");
assert(cacheSource.includes("if (!filePath)") && cacheSource.includes("continue;") && cacheSource.includes("const pathKey = normalizeVaultPathForComparison(filePath)"), "Cache path index does not skip malformed empty-path entries");
assert(!cacheSource.includes(".filter(([cacheKey, entry]) => vaultPathsEqual(this.getEntryPath(cacheKey, entry)"), "Cache getEntriesForPath still scans all entries directly");
assert(savingsCalculatorSource.includes("const entriesByPath = this.plugin.cache.getEntriesByPathMap()") && savingsCalculatorSource.includes("getFreshEntryForFileFromEntries"), "Savings calculator still does per-file cache path scans");
assert(!savingsCalculatorSource.includes("const cacheKeys = Object.keys(entries)") && !savingsCalculatorSource.includes("for (const cacheKey of cacheKeys)"), "Savings getCachedOriginalSize still scans every cache key");
assert(savingsCalculatorSource.includes("SAVINGS_STATS_IO_CONCURRENCY = 8") && savingsCalculatorSource.includes("cacheLookupLimiter.run") && savingsCalculatorSource.includes("compressedSizeLimiter.run"), "Savings calculator does not limit async cache/stat fan-out within batches");
assert(!progressModalSource.includes("[key: string]: any"), "ProgressModal still has a class index signature");
assert(progressModalSource.includes("requestCancel") && progressModalSource.includes("setAbortController") && progressModalSource.includes("setCancelled"), "ProgressModal is missing user cancellation support");
assert(progressModalSource.includes("removeEventListener") && progressModalSource.includes("clearModalTimeout"), "ProgressModal does not clean cancel listeners/timers on close");
assert(progressModalSource.includes("animationHandle") && progressModalSource.includes("cancelModalAnimationFrame") && progressModalSource.includes("this.statusElement = null") && progressModalSource.includes("this.progressElement = null"), "ProgressModal does not clean pending animation frames or stale element refs on close");
assert(progressModalSource.includes("pendingProgressUpdate") && progressModalSource.includes("if (this.animationHandle)") && progressModalSource.includes("return;"), "ProgressModal does not coalesce pending progress updates into one animation frame");
assert(progressModalSource.includes("isClosed") && progressModalSource.includes("Math.min(100") && progressModalSource.includes("Math.max(0"), "ProgressModal does not guard late updates or clamp progress");
assert(progressModalSource.includes('setAttribute("role", "progressbar")') && progressModalSource.includes('setAttribute("aria-live", "polite")') && progressModalSource.includes('setAttribute("aria-valuenow"') && progressModalSource.includes("focusTimer"), "ProgressModal is missing progress/live-region semantics or deterministic initial focus");
assert(moveServiceSource.includes('setAttribute("role", "progressbar")') && moveServiceSource.includes('setAttribute("aria-valuetext"') && moveServiceSource.includes('setAttribute("aria-live", "polite")'), "Move progress modal is missing accessible progress semantics");
assert(pluginSource.includes("signal: abortController.signal") && pluginSource.includes("cancelled_batch_aborted") && pluginSource.includes("cancelled: isCancelled()"), "Batch compression does not propagate ProgressModal cancellation");
assert(pluginSource.includes("Batch compression failed unexpectedly") && pluginSource.includes("progressModal.setError(errorMessage)"), "processBatchCompression does not surface unexpected batch failures in the modal");
assert(i18nSource.includes("progress.cancelling") && i18nSource.includes("progress.cancelled") && i18nSource.includes("common.cancel"), "Progress cancellation i18n keys are missing");
assert(!pluginSource.includes("app.setting") && pluginSource.includes("settingsTab?.refreshStatsIfVisible()") && settingsTabSource.includes("refreshStatsIfVisible()") && settingsTabSource.includes("this._isVisible = true"), "Settings indicator refresh still depends on private app.setting state instead of plugin-owned visibility");
assert(settingsTabSource.includes("requestRerenderAfterCurrentRender()") && settingsTabSource.includes("refreshStatsIfVisible()") && !pluginSource.includes("settingsTab._isRendering") && !pluginSource.includes("settingsTab._pendingRerender"), "Settings indicator refresh still mutates SettingsTab render internals directly");
assert(settingsTabSource.includes('setAttribute("tabindex", "0")') && settingsTabSource.includes('setAttribute("role", "group")') && settingsTabSource.includes("'focus', onFocus") && settingsTabSource.includes('"Escape"') && settingsTabSource.includes("container.doc || ownerWindow.document"), "Savings tooltip is not keyboard-accessible or popout-owned");
assert(!i18nSource.includes('"Command Palette →"') && !i18nSource.includes('"Space Savings Details"') && !i18nSource.includes('"Original Size:"'), "English built-in locale contains title-case UI copy");
assert(pluginSource.includes("new ProgressModal(this, t(this.app, \"common.refreshCache\")") && i18nSource.includes("status.indexing"), "forceRefreshCache does not show progress for cache/index refresh");
assert(pluginSource.includes('setText(t(this.app, "status.loading"))') && pluginSource.includes('setText(t(this.app, "status.indexing"))') && !pluginSource.includes('setText("…")') && i18nSource.includes("status.loading"), "Status bar startup still uses a magic loading string or lacks indexing feedback");
assert(pluginSource.includes("async showCacheBackupsList()") && settingsTabSource.includes("showCacheBackupsList") && !settingsTabSource.includes("openBackupsFolder"), "Cache backup list method is still named or called as opening a folder");
assert(cacheBackupsViewSource.includes("backupInfoLimiter = new ConcurrencyLimiter(8)") && cacheBackupsViewSource.includes("toLocaleString(locale)") && !cacheBackupsViewSource.includes("toLocaleString(locale === 'en'"), "Cache backup list stat/locale formatting is not bounded or explicit");
assert(savingsCalculatorSource.includes("Promise<number | null>") && savingsCalculatorSource.includes('getErrorCode(error) === "ENOENT"') && savingsCalculatorSource.includes(".catch(() => null)"), "Compressed size lookup does not distinguish missing files from stat errors");
assert(!cacheSource.includes("[key: string]: any"), "Cache still has a class index signature");
assert(!cacheSource.includes("async isCached(") && !cacheSource.includes("getCacheFile()") && !pluginSource.includes("getUncompressedImagesCount("), "Public dead methods returned after the dead-code pass");
assert(cacheSource.includes("saveCacheDelayMs"), "Cache is missing debounced save scheduling");
assert(cacheSource.includes("activeWritePromise"), "Cache is missing serialized write tracking");
assert(cacheSource.includes("cancelPendingSave"), "Cache is missing pending save cancellation");
assert(cacheSource.includes("renameCacheFileWithRetry") && cacheSource.includes("isRetriableCacheRenameError") && cacheSource.includes('code === "EPERM"'), "Cache atomic rename does not retry transient Windows EPERM/EACCES/EBUSY failures");
assert(!settingsTabSource.includes("[key: string]: any"), "SettingsTab still has a class index signature");
assert(!pluginSource.includes("[key: string]: any"), "Plugin source still has class index signatures");
assert(!pluginSource.includes("child_process"), "Plugin still opens folders through child_process");
assert(!pluginSource.includes("exec(cmd"), "Plugin still opens folders through exec(cmd)");
assert((combinedTsSource.match(/from\s+(["'])electron\1/g) || []).length === 1 && utilsSource.includes("openFilesystemPath") && cacheBackupsViewSource.includes("openFilesystemPath(backupDir)") && settingsTabSource.includes("openFilesystemPath(dir)"), "Folder opening should go through one shared electron.shell.openPath helper");
assert(!utilsSource.includes("fallback = process.cwd()") && utilsSource.includes("refusing filesystem access outside the vault"), "Vault base-path resolution still fails open outside the vault");
assert(cacheSource.includes("isSafeVaultRelativePath(vaultRelativePath)") && !cacheSource.includes("return rawPath;"), "Cache output metadata can still resolve arbitrary absolute paths");
assert(!serviceSources.some((serviceSource) => serviceSource.includes("plugin: any")), "A service or settings tab still accepts plugin:any");
for (const removedWrapper of [
  "async getImagesInNote(",
  "async calculateSpaceSavings(",
  "async collectImageStats(",
  "validateSavingsData(",
  "formatTooltipData(",
  "async getCompressedFilesCount(",
  "async moveCompressedToFiles(",
  "async moveSingleFile(",
  "async showStatusBarMenu(",
  "async updateStatusBar("
]) {
  assert(!pluginSource.includes(removedWrapper), `Plugin still contains service wrapper: ${removedWrapper}`);
}
assert(!settingsSource.includes("pngquantPath?:") && !settingsSource.includes("mozjpegPath?:"), "Settings interface still exposes deprecated native-binary paths");
assert(settingsSource.includes('"pngquantPath"') && settingsSource.includes('"mozjpegPath"'), "Settings normalization no longer strips deprecated native-binary paths");
for (const staleBinaryLocaleKey of [
  "warning.binariesMissing",
  "compress.error.pngquantMissing",
  "compress.error.mozjpegMissing",
  "compress.error.pngquantLaunch",
  "compress.error.mozjpegLaunch",
  "compress.error.pngquantExit",
  "compress.error.mozjpegExit",
  "paths.pngquant.name",
  "paths.pngquant.desc",
  "paths.mozjpeg.name",
  "paths.mozjpeg.desc",
  "binaries.available"
]) {
  assert(!i18nSource.includes(`"${staleBinaryLocaleKey}"`), `Obsolete native-binary locale key returned: ${staleBinaryLocaleKey}`);
}
assert(compressorSource.includes('"compress.error.pngQuality"') && !compressorSource.includes('"compress.error.pngquantExit"'), "PNG quality failure still uses native pngquant wording");
assert(!settingsSource.includes("workerPoolSize") && !settingsSource.includes("pluginGuardTimeoutMs"), "Settings source still exposes technical runtime settings");
assert(!readmeSource.includes("Compression worker pool size") && !readmeSource.includes("Plugin guard timeout"), "README.md still documents technical runtime settings as configurable");
assert(!readmeRuSource.includes("Размер пула воркеров сжатия") && !readmeRuSource.includes("Таймаут защиты плагина"), "README.ru.md still documents technical runtime settings as configurable");
assert(readmeSource.includes("WebP, GIF, BMP") && readmeSource.includes("Internal safety limits are fixed") && readmeSource.includes("100 million"), "README.md is missing supported-format limitations or internal safety-limit documentation");
assert(readmeRuSource.includes("WebP, GIF, BMP") && readmeRuSource.includes("Внутренние лимиты безопасности фиксированы") && readmeRuSource.includes("100 млн"), "README.ru.md is missing supported-format limitations or internal safety-limit documentation");
assert(readmeSource.includes("| PNG quality (min-max) | Quality range for lossy PNG quantization | 1-100") && !readmeSource.includes("PNG quality (min-max) | Quality range for lossy PNG quantization | 0-100"), "README.md PNG quality range is out of sync with settings clamp");
assert(readmeRuSource.includes("| Качество PNG (мин-макс) | Диапазон качества для lossy PNG quantization | 1-100") && !readmeRuSource.includes("Качество PNG (мин-макс) | Диапазон качества для lossy PNG quantization | 0-100"), "README.ru.md PNG quality range is out of sync with settings clamp");
for (const token of [
  "Inactivity threshold",
  "Cache retention",
  "Auto backup retention",
  "Auto-move compressed files",
  "Auto-move threshold",
  "conservative estimates with capped ratios",
  "skips restore ownership"
]) {
  assert(readmeSource.includes(token), `README.md is missing settings/savings/guard documentation token: ${token}`);
}
assert(!readmeSource.includes("Disable Paste Image Rename during compression") && !readmeSource.includes("with the setting off"), "README.md still documents a Paste Image Rename opt-out setting");
for (const token of [
  "Порог неактивности",
  "Срок хранения кэша",
  "Автохранение бэкапов",
  "Автоперемещение сжатых файлов",
  "Порог автоперемещения",
  "консервативную оценку с ограниченными коэффициентами",
  "не присваивает себе восстановление"
]) {
  assert(readmeRuSource.includes(token), `README.ru.md is missing settings/savings/guard documentation token: ${token}`);
}
assert(!readmeRuSource.includes("Отключать Paste Image Rename при сжатии") && !readmeRuSource.includes("если выключить"), "README.ru.md still documents a Paste Image Rename opt-out setting");
assert(manifestSource.minAppVersion === "1.4.0", "manifest.json minAppVersion must match the activeWindow/activeDocument/getBasePath API minimum");
assert(versionsSource[manifestSource.version] === manifestSource.minAppVersion, "versions.json current version must match manifest minAppVersion");
assert(readmeSource.includes("Requires Obsidian `1.4.0+`") && readmeSource.includes("Min app version: `1.4.0`"), "README.md minimum Obsidian version is out of sync with manifest");
assert(readmeRuSource.includes("Требуется Obsidian `1.4.0+`") && readmeRuSource.includes("Минимальная версия приложения: `1.4.0`"), "README.ru.md minimum Obsidian version is out of sync with manifest");
assert(readmeSource.includes("Build and release model") && readmeSource.includes("RELEASE_POLICY.md") && readmeRuSource.includes("Модель сборки и релиза") && readmeRuSource.includes("RELEASE_POLICY.md"), "README files must link the release policy and explain the build/release model");
assert(manifestSource.authorUrl === "https://github.com/haperone", "manifest.json authorUrl must point to the author profile");
assert(packageSource.scripts["build:root"] === "node scripts/build-root.js", "package.json is missing build:root");
assert(packageSource.scripts.build === "npm run build:root", "package.json build must delegate to the TypeScript root build");
assert(!packageSource.scripts["build:baseline"] && !packageSource.scripts["test:baseline"] && !packageSource.scripts.verify && !packageSource.scripts.extract, "byte-exact baseline recovery scripts must stay decommissioned");
assert(packageSource.scripts["test:release"] === "npm test && npm run build:root && npm run audit:policy:bundle && npm run verify:release && npm run verify:root-ts", "package.json test:release must build and verify deterministic release output");
assert(packageSource.scripts["validate:license"] === "node scripts/validate-license.js", "package.json is missing validate:license");
assert(packageSource.scripts["audit:policy"] === "node scripts/audit-policy.js" && packageSource.scripts.test.includes("npm run audit:policy"), "package.json must keep the policy audit blocking in npm test");
assert(packageSource.scripts["audit:policy:bundle"] === "node scripts/audit-policy.js --require-bundle" && packageSource.scripts["test:release"].includes("npm run audit:policy:bundle"), "Release tests must run the policy audit against the built production bundle");
assert(packageSource.scripts["lint:eslint"] === "eslint src-ts/" && packageSource.scripts.test.includes("npm run lint:eslint"), "package.json must keep lint:eslint executable and wired into npm test");
assert(packageSource.scripts["lint:obsidian"] === "node scripts/lint-obsidian.js" && packageSource.scripts.test.includes("npm run lint:obsidian"), "package.json must keep the Obsidian scanner executable and blocking in npm test");
assert(eslintObsidianConfigSource.includes("recommendedWithLocalesEn") && eslintObsidianConfigSource.includes('"src-ts/i18n.ts"'), "Obsidian scanner config must cover the current recommended rules and English locale source");
assert(lintObsidianSource.includes("warningCount === 0") && lintObsidianSource.includes("errorCount === 0"), "Obsidian scanner wrapper must reject both errors and warnings");
assert(packageSource.devDependencies["@jsquash/jpeg"], "package.json is missing @jsquash/jpeg");
assert(packageSource.devDependencies["@jsquash/png"], "package.json is missing @jsquash/png");
assert(packageSource.devDependencies["@types/node"] === "25.7.0", "@types/node must be pinned exactly for repeatable type checks");
assert(packageSource.devDependencies.obsidian === "1.13.0", "obsidian API types must stay pinned to the reviewed 1.13.0 baseline");
assert(packageSource.devDependencies["eslint-plugin-obsidianmd"] === "0.3.0", "eslint-plugin-obsidianmd must stay pinned to the reviewed 0.3.0 scanner baseline");
assert(packageSource.devDependencies.eslint && packageSource.devDependencies["@typescript-eslint/parser"] && packageSource.devDependencies["@typescript-eslint/eslint-plugin"], "ESLint devDependencies are required for lint:eslint");
assertExactPackageSeries(packageSource.devDependencies.imagequant, /^0\.1\.\d+$/, "imagequant must stay on the 0.1.x series while pngquant_quality_failed depends on its error contract");
assertExactPackageSeries(packageSource.devDependencies.typescript, /^6\.0\.\d+$/, "typescript must stay on the reviewed 6.0.x series");
assert(packageSource.devDependencies.esbuild === "0.28.1", "esbuild must stay exact-pinned to the reviewed patched version 0.28.1");
assert(tsconfigSource.compilerOptions.strict === true, "tsconfig strict mode must stay enabled");
assert(Array.isArray(tsconfigSource.compilerOptions.types) && tsconfigSource.compilerOptions.types.includes("node") && tsconfigSource.compilerOptions.types.includes("obsidian"), "tsconfig must include node and obsidian ambient types");
for (const strictFlag of [
  "noUncheckedIndexedAccess",
  "noPropertyAccessFromIndexSignature",
  "noFallthroughCasesInSwitch",
  "noImplicitOverride",
  "exactOptionalPropertyTypes",
  "useUnknownInCatchVariables",
  "forceConsistentCasingInFileNames"
]) {
  assert(tsconfigSource.compilerOptions[strictFlag] === true, `tsconfig ${strictFlag} must stay enabled`);
}
assert(releaseWorkflowSource.includes("pull_request:"), "Release workflow does not validate pull requests");
assert(releaseWorkflowSource.includes("npm run test:release"), "Release workflow does not run the root release test entrypoint");
assert(packageSource.scripts["test:release"].includes("npm run build:root") && packageSource.scripts["test:release"].includes("npm run verify:release") && packageSource.scripts["test:release"].includes("npm run verify:root-ts"), "Source release test does not build and verify deterministic root bundle output");
assert(!releaseWorkflowSource.includes("|| true"), "Release workflow still silently ignores missing release artifacts");
assert(rootPackageSource.license === "GPL-3.0-or-later", "Root package.json license must match bundled GPL codec obligations");
assert(rootPackageSource.scripts.build === "npm run build:root", "Root package.json build must delegate to the real source-recovery build");
assert(rootPackageSource.scripts.test.includes("npm run test:ts") && rootPackageSource.scripts["test:release"].includes("npm run verify:release"), "Root package.json test scripts must run DEV deployment tests, promotion tests, and delegate to source-recovery");
assert(Array.isArray(rootPackageSource.files) && JSON.stringify(rootPackageSource.files) === JSON.stringify(["manifest.json", "main.js", "styles.css", "versions.json"]), "Root package.json files allowlist must contain only Obsidian install artifacts");
assert(!releaseWorkflowSource.includes("build/package.json") && !releaseWorkflowSource.includes("build/README.md") && releaseWorkflowSource.includes("npm run test:release"), "Release workflow still ships dev package metadata or bypasses root test:release");
assert(releaseWorkflowSource.includes('"*.*.*"') && releaseWorkflowSource.includes("^[0-9]+\\.[0-9]+\\.[0-9]+$") && !releaseWorkflowSource.includes('"v*"') && !releaseWorkflowSource.includes("GITHUB_REF_NAME#v"), "Release workflow does not combine a dotted tag trigger with exact numeric SemVer validation");
assert((releaseWorkflowSource.match(/actions\/checkout@v6/g) || []).length === 2 && (releaseWorkflowSource.match(/actions\/setup-node@v6/g) || []).length === 2 && (releaseWorkflowSource.match(/node-version:\s*"24"/g) || []).length === 2, "Release workflow must use checkout/setup-node v6 and Node 24 in both jobs");
assert(releaseWorkflowSource.includes("npm run prepare:release") && prepareReleaseSource.includes('["manifest.json", "main.js", "styles.css", "versions.json"]'), "Release workflow does not use the exact install-file staging allowlist");
assert(validateManifestSource.includes("forbiddenReleaseEntries") && validateManifestSource.includes("package.json must declare a files allowlist"), "Manifest validation does not guard release packaging against dev artifact leaks");
assert(validateManifestSource.includes("MIN_API_SURFACE_APP_VERSION") && validateManifestSource.includes("activeWindow/activeDocument/getBasePath"), "Manifest validation does not enforce API-surface minAppVersion");
assert(validateManifestSource.includes("manifest.json authorUrl must be a valid URL") && validateManifestSource.includes("must not point to localhost"), "Manifest validation does not reject malformed or local authorUrl values");
assert(validateManifestSource.includes("DESKTOP_ONLY_REQUIRED_REASON") && validateManifestSource.includes("DESKTOP_ONLY_API_PATTERNS") && validateManifestSource.includes("collectDesktopOnlyApiMatches") && manifestSource.isDesktopOnly === true, "Manifest validation does not derive isDesktopOnly from desktop-only API usage");
assert(buildRootSource.includes("copyFileSync failed with EPERM") && buildRootSource.includes("writeFileSync fallback both failed") && buildRootSource.includes("post-copy SHA mismatch") && buildRootSource.includes("SHA-256"), "build-root.js does not warn on fallback failures or verify root main.js integrity");
assert(buildRootSource.includes('"--production"') && buildTsSource.includes('process.argv.includes("--production")') && buildTsSource.includes("minify: production"), "Root release build is not production-minified");
assert(buildTsSource.includes('"--loader:.wasm=binary"') && buildTsSource.includes('".wasm": "binary"'), "build-ts.js must keep WASM binary loader configured for both worker and main bundles");
assert(rootPackageSource.files.includes("main.js") && !rootPackageSource.files.some((filePath) => filePath.endsWith(".wasm")), "Release package must keep WASM inline in the self-contained main.js bundle");
assert(verifyReleaseSource.includes("Production build is not deterministic") && verifyReleaseSource.includes("lineCount > 100") && verifyReleaseSource.includes("sourceMappingURL="), "Release verification is missing determinism or minification/source-map guards");
for (const token of [
  "src-ts",
  "Root `main.js` is generated, ignored",
  "verify:root-ts",
  "production-minified",
  "exact numeric SemVer",
  "manifest.json",
  "versions.json"
]) {
  assert(releasePolicySource.includes(token), `RELEASE_POLICY.md is missing release policy token: ${token}`);
}
assert(classWideGatesSource.includes("addEmptyCatchFindings") && classWideGatesSource.includes("--self-test") && classWideGatesSource.includes("multiline empty catch"), "class-wide-gates.js does not guard multiline empty catch detection");
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
  assert(pattern.test(gitignoreSource), `.gitignore is missing required generated/local artifact pattern: ${pattern}`);
}
assert(gitignoreSource.includes("qa-backups/"), ".gitignore is missing QA output ignores");
assert(licenseSource.includes("SPDX-License-Identifier: GPL-3.0-or-later") && licenseSource.includes("GNU GENERAL PUBLIC LICENSE") && licenseSource.includes("17. Interpretation of Sections 15 and 16.") && licenseSource.length > 30000, "LICENSE must contain the project grant and complete GPL v3 text");
assert(auditPolicySource.includes("Policy audit passed") && auditPolicySource.includes("expectedFullVaultScans") && auditPolicySource.includes("expectedFsBoundaryFiles"), "Policy audit is missing blocking source/filesystem inventory guards");
for (const token of ["Network", "Telemetry and ads", "Accounts and payments", "External files", "Other plugins"]) {
  assert(readmeSource.includes(token), `README.md is missing policy disclosure: ${token}`);
}
for (const token of ["Сеть", "Телеметрия и реклама", "Аккаунты и платежи", "Внешние файлы", "Другие плагины"]) {
  assert(readmeRuSource.includes(token), `README.ru.md is missing policy disclosure: ${token}`);
}
assert(!rootPackageSource.dependencies?.["pngquant-bin"], "Root package.json still depends on pngquant-bin");
assert(!rootPackageSource.dependencies?.mozjpeg, "Root package.json still depends on mozjpeg");

function assertExactPackageSeries(version, pattern, message) {
  assert(/^\d+\.\d+\.\d+$/.test(version), `${message}; dependency must be exact semver for repeatable builds`);
  assert(pattern.test(version), message);
}

assert(
  !source.includes("this.app.setting.openTabById"),
  "TypeScript artifact still force-opens the plugin settings tab"
);

assert(
  source.includes("require(\"electron\")") || source.includes("require('electron')"),
  "TypeScript artifact is missing expected electron external require"
);
assert(
  (source.match(/require\((["'])electron\1\)/g) || []).length === 1,
  "TypeScript artifact should have a single shared electron require site"
);

const originalLoad = Module._load;
let cachedObsidianMock = null;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "obsidian") {
    if (cachedObsidianMock) {
      return cachedObsidianMock;
    }
    class Plugin {
      constructor() {
        this.manifest = {
          id: "local-image-compress",
          name: "Local Image Compress",
          dir: root
        };
        this.commands = [];
        this.events = [];
        this.registeredCallbacks = [];
        this.settingTabs = [];
        this.statusBarItem = null;
      }
      registerEvent(event) {
        this.events.push(event);
      }
      register(callback) {
        this.registeredCallbacks.push(callback);
      }
      registerDomEvent(element, type, callback) {
        element.addEventListener(type, callback);
        this.register(() => element.removeEventListener(type, callback));
      }
      addCommand(command) {
        this.commands.push(command);
      }
      addSettingTab(tab) {
        this.settingTabs.push(tab);
      }
      addStatusBarItem() {
        const item = createMockElement();
        item.setText = (text) => {
          item.text = text;
        };
        item.show = () => {
          item.visible = true;
        };
        item.hide = () => {
          item.visible = false;
        };
        this.statusBarItem = item;
        return item;
      }
      async loadData() {
        return {};
      }
      async saveData(data) {
        this.savedData = data;
      }
    }
    cachedObsidianMock = {
      Plugin,
      PluginSettingTab: class {
        constructor(app, plugin) {
          this.app = app;
          this.plugin = plugin;
          this.containerEl = createMockElement();
        }
        hide() {
          this.hidden = true;
        }
      },
      Modal: class {
        constructor(app) {
          this.app = app;
          this.contentEl = createMockElement();
          this.titleEl = createMockElement();
        }
        open() {
          if (typeof this.onOpen === "function") {
            this.onOpen();
          }
        }
        close() {
          if (typeof this.onClose === "function") {
            this.onClose();
          }
        }
      },
      Setting: class {
        constructor(containerEl) {
          this.containerEl = containerEl;
          this.settingEl = createMockElement();
          this.controlEl = createMockElement();
        }
        setName(value) { this.name = value; return this; }
        setDesc(value) { this.desc = value; return this; }
        setHeading() { return this; }
        setDisabled(value) { this.disabled = value; return this; }
        addText() { return this; }
        addSlider() { return this; }
        addToggle() { return this; }
        addButton() { return this; }
        addExtraButton() { return this; }
        addDropdown() { return this; }
      },
      Notice: class {},
      TFile: class {},
      TFolder: class {},
      FuzzySuggestModal: class {},
      getLanguage: () => "en"
    };
    return cachedObsidianMock;
  }
  if (request === "electron") {
    return {
      shell: {
        openPath: async () => ""
      }
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

function createMockElement() {
  const classes = new Set();
  const listeners = {};
  const children = [];
  const styleState = {};
  const style = {};
  Object.defineProperty(style, "width", {
    get() {
      return styleState.width;
    },
    set(value) {
      styleState.width = value;
      if (Array.isArray(global.__progressWidthUpdates)) {
        global.__progressWidthUpdates.push(value);
      }
    }
  });
  style.setProperty = (name, value) => {
    styleState[name] = String(value);
    style[name] = String(value);
  };
  style.getPropertyValue = (name) => styleState[name] || "";
  const element = {
    attributes: {},
    style,
    children,
    _listeners: listeners,
    classList: {
      add(...names) {
        for (const name of names) classes.add(name);
        element.className = Array.from(classes).join(" ");
      },
      remove(...names) {
        for (const name of names) classes.delete(name);
        element.className = Array.from(classes).join(" ");
      },
      contains(name) {
        return classes.has(name);
      }
    },
    className: "",
    addClass(name) {
      this.classList.add(name);
    },
    removeClass(name) {
      this.classList.remove(name);
    },
    setCssProps(props) {
      for (const [name, value] of Object.entries(props)) {
        style.setProperty(name, value);
      }
    },
    empty() {},
    appendChild(child) {
      children.push(child);
      child.parentElement = element;
    },
    removeChild(child) {
      const index = children.indexOf(child);
      if (index !== -1) {
        children.splice(index, 1);
      }
      child.parentElement = null;
    },
    contains(child) {
      return child === element || children.includes(child) || children.some((nested) => nested.contains && nested.contains(child));
    },
    createEl(tag, opts) {
      const child = Object.assign(createMockElement(), {
        tag,
        opts,
        textContent: opts && opts.text
      });
      if (opts && opts.cls) {
        child.addClass(opts.cls);
      }
      this.appendChild(child);
      return child;
    },
    createDiv(opts) {
      const child = Object.assign(createMockElement(), { opts });
      if (opts && opts.cls) {
        child.addClass(opts.cls);
      }
      this.appendChild(child);
      return child;
    },
    setText(text) {
      this.text = text;
    },
    getText() {
      return this.text || this.textContent || "";
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 0, height: 0 };
    },
    addEventListener(name, callback) {
      listeners[name] = listeners[name] || [];
      listeners[name].push(callback);
    },
    removeEventListener(name, callback) {
      if (!listeners[name]) return;
      listeners[name] = listeners[name].filter((listener) => listener !== callback);
    },
    dispatchEvent(name, event = {}) {
      for (const listener of listeners[name] || []) {
        listener(event);
      }
    },
    querySelectorAll(selector) {
      if (!String(selector || "").startsWith(".")) {
        return [];
      }
      const className = String(selector).slice(1);
      const result = [];
      const visit = (node) => {
        if (node.classList?.contains?.(className)) {
          result.push(node);
        }
        for (const child of node.children || []) {
          visit(child);
        }
      };
      visit(element);
      return result;
    },
    toggle() {},
    focus() {
      this.focused = true;
    }
  };
  return element;
}

function createMockDocument() {
  const doc = {
    activeElement: null,
    body: createMockElement(),
    createElement(tag) {
      const element = Object.assign(createMockElement(), {
        tag,
        id: "",
        value: "",
        textContent: ""
      });
      element.focus = () => {
        doc.activeElement = element;
      };
      return element;
    }
  };
  return doc;
}

function createMockFile(filePath, size, mtime = 1) {
  const name = filePath.split("/").pop();
  return {
    path: filePath,
    name,
    extension: name.split(".").pop(),
    stat: {
      size,
      mtime
    }
  };
}

function createMockApp() {
  const files = [
    createMockFile("Images/a.png", 100000),
    createMockFile("Images/b.jpg", 100000),
    createMockFile("Compressed/Images/c.png", 100000),
    createMockFile("Images/project/Compressed/d.png", 100000)
  ];
  const setting = {
    activeTab: null,
    openTabByIdCalls: 0,
    openTabById() {
      this.openTabByIdCalls += 1;
      return null;
    }
  };
  const vaultHandlers = {};
  const workspaceHandlers = {};
  const layoutReadyCallbacks = [];
  let layoutReady = false;
  let getFilesCalls = 0;
  const app = {
    _files: files,
    _vaultHandlers: vaultHandlers,
    _workspaceHandlers: workspaceHandlers,
    _layoutReadyCallbacks: layoutReadyCallbacks,
    _getFilesCalls: 0,
    vault: {
      configDir: ".obsidian",
      adapter: {
        basePath: root,
        path: {
          absolute: root
        },
        getBasePath() {
          return this.basePath || this.path?.absolute || root;
        }
      },
      getFiles: () => {
        getFilesCalls += 1;
        app._getFilesCalls = getFilesCalls;
        return app._files;
      },
      getAllLoadedFiles: () => [],
      on: (name, callback) => {
        vaultHandlers[name] = callback;
        return { scope: "vault", name };
      },
      getFileByPath: (filePath) => app._files.find((file) => file.path === filePath) || null,
      getAbstractFileByPath: (filePath) => app._files.find((file) => file.path === filePath) || null,
      readBinary: async (file) => Buffer.from(file.path),
      cachedRead: async () => "![[Images/a.png]]"
    },
    workspace: {
      activeWindow: {
        document: global.document,
        innerWidth: 1200,
        addEventListener() {},
        removeEventListener() {},
        requestAnimationFrame: (callback) => callback(),
        setTimeout: (...args) => global.setTimeout(...args),
        clearTimeout: (...args) => global.clearTimeout(...args)
      },
      onLayoutReady: (callback) => {
        if (layoutReady) {
          callback();
          return;
        }
        layoutReadyCallbacks.push(callback);
      },
      on: (name, callback) => {
        workspaceHandlers[name] = callback;
        return { scope: "workspace", name };
      },
      getActiveFile: () => null
    },
    setting,
    plugins: {
      enabledPlugins: new Set(),
      disablePlugin: async () => {},
      enablePlugin: async () => {}
    }
  };
  Object.defineProperty(app, "_resetGetFilesCalls", {
    value() {
      getFilesCalls = 0;
      app._getFilesCalls = 0;
    }
  });
  Object.defineProperty(app, "_triggerLayoutReady", {
    value() {
      layoutReady = true;
      for (const callback of layoutReadyCallbacks.splice(0)) {
        callback();
      }
    }
  });
  return app;
}

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function installImageDataPolyfill() {
  if (typeof global.ImageData === "undefined") {
    global.ImageData = class ImageData {
      constructor(data, width, height) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    };
  }
}

let fixtureCodecsPromise = null;
async function getFixtureCodecs() {
  if (!fixtureCodecsPromise) {
    fixtureCodecsPromise = (async () => {
      installImageDataPolyfill();
      const [jpegEncodeModule, pngEncodeModule] = await Promise.all([
        import("@jsquash/jpeg/encode.js"),
        import("@jsquash/png/encode.js")
      ]);
      const jpegEncodeWasm = new WebAssembly.Module(fs.readFileSync(path.join(root, "node_modules", "@jsquash", "jpeg", "codec", "enc", "mozjpeg_enc.wasm")));
      const pngWasm = fs.readFileSync(path.join(root, "node_modules", "@jsquash", "png", "codec", "pkg", "squoosh_png_bg.wasm"));
      await jpegEncodeModule.init(jpegEncodeWasm, { locateFile: (fileName) => fileName });
      await pngEncodeModule.init(pngWasm);
      return {
        jpegEncode: jpegEncodeModule.default,
        pngEncode: pngEncodeModule.default
      };
    })();
  }
  return fixtureCodecsPromise;
}

function createPatternImageData(width, height, mode = "gradient") {
  installImageDataPolyfill();
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      if (mode === "blocks") {
        const band = Math.floor(y / 12) % 2;
        const cell = Math.floor(x / 12) % 8;
        data[offset] = band ? 230 : 35;
        data[offset + 1] = cell * 28;
        data[offset + 2] = band ? 80 : 210;
      } else {
        data[offset] = (x * 3 + y) & 255;
        data[offset + 1] = (y * 5 + x) & 255;
        data[offset + 2] = (x * 7 + y * 11) & 255;
      }
      data[offset + 3] = 255;
    }
  }
  return new global.ImageData(data, width, height);
}

async function runImagequantHeapStress() {
  const imagequantBindings = await import("imagequant/imagequant_bg.js");
  const wasmBytes = fs.readFileSync(path.join(root, "node_modules", "imagequant", "imagequant_bg.wasm"));
  const imagequantWasmInstance = await WebAssembly.instantiate(wasmBytes, {
    "./imagequant_bg.js": imagequantBindings
  });
  const imagequantExports = imagequantWasmInstance.instance?.exports || imagequantWasmInstance.exports;
  for (const exportName of [
    "__wbg_imagequant_free",
    "__wbg_imagequantimage_free",
    "__wbindgen_add_to_stack_pointer",
    "__wbindgen_free",
    "__wbindgen_malloc",
    "imagequant_new",
    "imagequant_new_image",
    "imagequant_process",
    "imagequant_set_quality",
    "imagequant_set_speed",
    "imagequantimage_new"
  ]) {
    assert(typeof imagequantExports[exportName] === "function", `Imagequant WASM fixture is missing required export: ${exportName}`);
  }
  assert(imagequantExports.memory instanceof WebAssembly.Memory, "Imagequant WASM fixture is missing a memory export");
  imagequantBindings.__wbg_set_wasm(imagequantExports);
  assert(imagequantExports.memory?.buffer, "Imagequant heap stress could not inspect WASM memory");

  const width = 128;
  const height = 128;
  const imageBytes = width * height * 4;
  const warmupIterations = 20;
  const totalIterations = 200;
  const rgba = new Uint8Array(imageBytes);
  for (let i = 0; i < imageBytes; i += 4) {
    const pixel = i / 4;
    rgba[i] = pixel & 255;
    rgba[i + 1] = (pixel >> 8) & 255;
    rgba[i + 2] = (pixel * 17) & 255;
    rgba[i + 3] = 255;
  }

  let memoryAfterWarmup = 0;
  let peakMemoryAfterWarmup = 0;
  for (let iteration = 0; iteration < totalIterations; iteration++) {
    const quantizer = new imagequantBindings.Imagequant();
    let image = null;
    try {
      quantizer.set_quality(45, 70);
      quantizer.set_speed(6);
      image = new imagequantBindings.ImagequantImage(new Uint8Array(rgba), width, height, 0);
      const output = quantizer.process(image);
      assert(output.byteLength > 0, "Imagequant heap stress produced empty output");
    } finally {
      try {
        image?.free?.();
      } catch (_) {
      }
      try {
        quantizer.free();
      } catch (_) {
      }
    }

    const memoryBytes = imagequantExports.memory.buffer.byteLength;
    if (iteration === warmupIterations - 1) {
      memoryAfterWarmup = memoryBytes;
      peakMemoryAfterWarmup = memoryBytes;
    } else if (iteration >= warmupIterations) {
      peakMemoryAfterWarmup = Math.max(peakMemoryAfterWarmup, memoryBytes);
    }
  }

  const growthAfterWarmup = peakMemoryAfterWarmup - memoryAfterWarmup;
  const allowedGrowth = Math.max(imageBytes * 8, 2 * 1024 * 1024);
  assert(
    growthAfterWarmup <= allowedGrowth,
    `Imagequant WASM heap grew after warmup: ${growthAfterWarmup} bytes > ${allowedGrowth} bytes`
  );
}

function writeVaultBinary(app, basePath, filePath, bytes, mtime = Date.now()) {
  const fullPath = path.join(basePath, filePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, Buffer.from(bytes));
  const file = createMockFile(filePath, Buffer.from(bytes).byteLength, mtime);
  file.vault = app.vault;
  return file;
}

function pointMockVaultAtPath(app, basePath) {
  const resolveVaultPath = (vaultPath) => path.join(basePath, ...String(vaultPath || "").split("/").filter(Boolean));
  app.vault.adapter.basePath = basePath;
  app.vault.adapter.path.absolute = basePath;
  app.vault.adapter.exists = async (vaultPath) => fs.existsSync(resolveVaultPath(vaultPath));
  app.vault.adapter.mkdir = async (vaultPath) => {
    fs.mkdirSync(resolveVaultPath(vaultPath), { recursive: true });
  };
  app.vault.adapter.writeBinary = async (vaultPath, data) => {
    const fullPath = resolveVaultPath(vaultPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, data);
  };
  app.vault.adapter.rename = async (oldPath, newPath) => {
    const oldFullPath = resolveVaultPath(oldPath);
    const newFullPath = resolveVaultPath(newPath);
    fs.mkdirSync(path.dirname(newFullPath), { recursive: true });
    fs.renameSync(oldFullPath, newFullPath);
  };
  app.vault.adapter.remove = async (vaultPath) => {
    fs.rmSync(resolveVaultPath(vaultPath), { recursive: true, force: true });
  };
  app.vault.readBinary = async (file) => toArrayBuffer(fs.readFileSync(resolveVaultPath(file.path)));
}

function createMockWorkerFactory(scenarios, createdWorkers = []) {
  return () => {
    const scenario = scenarios.shift() || {};
    const schedule = (callback, delay = 0) => setTimeout(callback, delay);
    const worker = {
      onmessage: null,
      onerror: null,
      terminated: false,
      messages: [],
      transfers: [],
      terminateCalls: 0,
      postMessage(message, transfer) {
        this.messages.push(message);
        this.transfers.push(transfer || []);
        if (typeof scenario.onPostMessage === "function") {
          scenario.onPostMessage(message, this, transfer || []);
        }
        if (message.type === "init") {
          if (scenario.noInitResponse) {
            return;
          }
          const initMessage = scenario.initError
            ? { id: message.id, type: "init-failed", error: { message: scenario.initError } }
            : { id: message.id, type: "ready" };
          schedule(() => this.onmessage?.({ data: initMessage }), scenario.initDelayMs || 0);
          return;
        }
        if (message.type === "compress") {
          if (scenario.throwOnCompressPost) {
            throw new Error(scenario.throwOnCompressPost);
          }
          if (scenario.noCompressResponse) {
            return;
          }
          if (scenario.crashOnCompress) {
            schedule(() => this.onerror?.({ message: scenario.crashOnCompress }), scenario.crashDelayMs || 0);
            return;
          }
          const response = (scenario.compressResponses || []).shift() || {};
          if (response.error) {
            schedule(() => this.onmessage?.({
              data: {
                id: message.id,
                type: "result",
                ok: false,
                error: response.error
              }
            }), response.delayMs || scenario.compressDelayMs || 0);
            return;
          }
          const output = response.output || createValidEncodedOutput(message.format);
          schedule(() => this.onmessage?.({
            data: {
              id: message.id,
              type: "result",
              ok: true,
              output
            }
          }), response.delayMs || scenario.compressDelayMs || 0);
        }
      },
      terminate() {
        this.terminated = true;
        this.terminateCalls += 1;
        if (typeof scenario.onTerminate === "function") {
          scenario.onTerminate(this);
        }
      }
    };
    createdWorkers.push(worker);
    return worker;
  };
}

async function replaceCompressorWorkerPool(plugin, workerFactory, size) {
  await plugin.compressor.workerPool.drainInFlight();
  plugin.compressor.workerPool.destroy(new Error("Compressor worker pool was replaced by the smoke harness"));
  plugin.compressor.workerFactory = workerFactory;
  plugin.compressor.activeWorkerCount = size;
  plugin.compressor.workerPool = plugin.compressor.createWorkerPool(size);
}

async function resetCompressorWorker(plugin, workerFactory) {
  await replaceCompressorWorkerPool(plugin, workerFactory, 1);
  await plugin.compressor.ensureWasmReady();
}

async function resetCompressorPool(plugin, workerFactory, size) {
  await replaceCompressorWorkerPool(plugin, workerFactory, size);
  await plugin.compressor.ensureWasmReady();
}

function getCompressorSlots(plugin) {
  return plugin.compressor.workerPool?.slots || [];
}

async function waitForReadySlots(plugin, expectedReady, timeoutMs = 500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const readyCount = getCompressorSlots(plugin).filter((slot) => slot.isReady()).length;
    if (readyCount >= expectedReady) {
      return readyCount;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return getCompressorSlots(plugin).filter((slot) => slot.isReady()).length;
}

async function setMockFiles(plugin, files) {
  plugin.app._files = files;
  if (typeof plugin.rebuildImageIndex === "function") {
    await plugin.rebuildImageIndex("smoke");
  }
}

async function setCacheEntries(plugin, entries) {
  plugin.cache.cacheData.entries = plugin.cache.normalizeCacheData({
    version: "1.0.0",
    entries
  }).data.entries;
  if (typeof plugin.rebuildImageIndex === "function") {
    await plugin.rebuildImageIndex("smoke-cache");
  }
}

const originalGlobals = {
  document: global.document,
  window: global.window,
  requestAnimationFrame: global.requestAnimationFrame,
  setTimeout: global.setTimeout,
  clearTimeout: global.clearTimeout
};
let smokeBackupStorageTemp = null;

(async () => {
try {
  await runImagequantHeapStress();

  global.document = {
    activeElement: null,
    body: createMockElement(),
    addEventListener() {},
    removeEventListener() {},
    createElement() {
      return createMockElement();
    }
  };
  global.window = {
    document: global.document,
    innerWidth: 1200,
    addEventListener() {},
    removeEventListener() {},
    setTimeout: (...args) => global.setTimeout(...args),
    clearTimeout: (...args) => global.clearTimeout(...args)
  };
  global.requestAnimationFrame = (callback) => callback();
  global.setTimeout = (callback, delay) => ({ callback, delay });
  global.clearTimeout = () => {};

  const mod = require(artifact);
  const PluginClass = mod && (mod.default || mod);
  assert(typeof PluginClass === "function", "TypeScript artifact does not expose a default plugin class");
  assert(
    typeof PluginClass.prototype.setupThemeAdaptation === "undefined",
    "TypeScript plugin class still exposes dead setupThemeAdaptation()"
  );

  {
    const failedInitPlugin = new PluginClass();
    failedInitPlugin.app = createMockApp();
    failedInitPlugin.manifest = {
      id: "local-image-compress",
      name: "Local Image Compress",
      dir: root
    };
    const InitFailureObsidianMock = require("obsidian");
    const originalNoticeForInitFailure = InitFailureObsidianMock.Notice;
    const originalConsoleErrorForInitFailure = console.error;
    const initFailureNotices = [];
    try {
      InitFailureObsidianMock.Notice = class {
        constructor(message, duration) {
          initFailureNotices.push({ message, duration });
        }
      };
      console.error = () => {};
      failedInitPlugin.initializePlugin = async () => {
        throw new Error("settings corrupt");
      };
      failedInitPlugin.onload();
      assert(failedInitPlugin.initializationPromise === null, "Plugin started initialization before layout readiness");
      failedInitPlugin.app._triggerLayoutReady();
      await failedInitPlugin.initializationPromise;
      assert(failedInitPlugin.isInitialized === false, "Plugin marked failed startup as initialized");
      assert(failedInitPlugin.isUnloading === true, "Plugin did not fence operations after failed startup");
      assert(failedInitPlugin.initializationError instanceof Error, "Plugin did not retain the startup failure");
      assert(failedInitPlugin.commands.length === 0, "Plugin registered commands after initialization failed");
      assert(failedInitPlugin.settingTabs.length === 0, "Plugin registered settings tab after initialization failed");
      assert(failedInitPlugin.events.length === 0, "Plugin registered events before initialization succeeded");
      assert(!failedInitPlugin.statusBarItem || failedInitPlugin.statusBarItem.visible === false, "Plugin left a partial status bar visible after startup failure");
      assert(initFailureNotices.some((notice) => String(notice.message).includes("initialization failed") && notice.duration === 10000), "Plugin did not show a user-visible startup failure notice");
      failedInitPlugin.onunload();
    } finally {
      InitFailureObsidianMock.Notice = originalNoticeForInitFailure;
      console.error = originalConsoleErrorForInitFailure;
    }
  }

  const plugin = new PluginClass();
  plugin.app = createMockApp();
  plugin.manifest = {
    id: "local-image-compress",
    name: "Local Image Compress",
    dir: root
  };

  plugin.onload();
  assert(plugin.initializationPromise === null, "Plugin started initialization before layout readiness");
  assert(plugin.commands.length === 0 && plugin.settingTabs.length === 0 && plugin.events.length === 0, "Plugin registered runtime resources before layout readiness");
  assert(plugin.app._getFilesCalls === 0, "Plugin scanned vault files before layout readiness");
  const preLayoutCreateFile = Object.assign(new (require("obsidian").TFile)(), createMockFile("Images/startup-create.png", 100000, 1));
  await plugin.handleVaultCreate(preLayoutCreateFile);
  assert(plugin.app._getFilesCalls === 0, "Vault create handling processed startup enumeration before initialization");
  plugin.app._triggerLayoutReady();
  await plugin.initializationPromise;
  smokeBackupStorageTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-smoke-backup-storage-"));
  plugin.cache.cacheBackupsDir = path.join(smokeBackupStorageTemp, "cache");
  assert(plugin.app.setting.openTabByIdCalls === 0, "Plugin force-opened its settings tab during onload");
  assert(plugin.isInitialized === true, "Plugin did not finish initialization before startup image indexing");
  assert(plugin.commands.length === 4 && plugin.settingTabs.length === 1, "Plugin did not register commands/settings before startup image indexing completed");
  assert(plugin.imageIndex?.isReady?.() === false, "Startup image index rebuild still completed synchronously during onload");
  assert(plugin.app._getFilesCalls === 0, "Plugin onload still scanned vault files before the startup image index timer fired");
  const startupImageIndexTimer = plugin.indexRefreshTimers.get("startup-image-index");
  assert(startupImageIndexTimer && startupImageIndexTimer.delay === 0, "Startup image index rebuild was not scheduled as a deferred timer");
  await startupImageIndexTimer.callback();
  assert(plugin.imageIndex?.isReady?.() === true, "Deferred startup image index rebuild did not make the index ready");
  assert(plugin.app._getFilesCalls > 0, "Deferred startup image index rebuild did not scan vault files after onload");

  const originalBasePathForPathSmoke = plugin.app.vault.adapter.basePath;
  const originalAbsolutePathForPathSmoke = plugin.app.vault.adapter.path.absolute;
  try {
    plugin.app.vault.adapter.basePath = "C:\\Users\\Tiny\\Vault";
    plugin.app.vault.adapter.path.absolute = "C:\\Users\\Tiny\\Vault";
    assert(plugin.isAbsoluteFilesystemPath("\\\\server\\share\\Vault\\Images\\unc.png"), "UNC filesystem paths are not recognized as absolute");
    assert(plugin.isAbsoluteFilesystemPath("\\\\?\\C:\\Users\\Tiny\\Vault\\Images\\long.png"), "Windows long-path drive prefix is not recognized as absolute");
    assert(plugin.cache.normalizeVaultPath("\\\\?\\C:\\Users\\Tiny\\Vault\\Images\\long.png") === "Images/long.png", "Windows long-path drive prefix was not stripped from cache paths");
    plugin.app.vault.adapter.basePath = "\\\\server\\share\\Vault";
    plugin.app.vault.adapter.path.absolute = "\\\\server\\share\\Vault";
    assert(plugin.cache.normalizeVaultPath("\\\\?\\UNC\\server\\share\\Vault\\Images\\unc.png") === "Images/unc.png", "Windows long-path UNC prefix was not stripped from cache paths");
    assert(!plugin.cache.isAbsolutePath("Images/relative.png"), "Relative vault paths were misclassified as absolute");
  } finally {
    plugin.app.vault.adapter.basePath = originalBasePathForPathSmoke;
    plugin.app.vault.adapter.path.absolute = originalAbsolutePathForPathSmoke;
  }

  const originalGetBasePathForPolicySmoke = plugin.app.vault.adapter.getBasePath;
  try {
    plugin.app.vault.adapter.getBasePath = undefined;
    let missingBasePathRejected = false;
    try {
      plugin.cache.getVaultBasePath();
    } catch (error) {
      missingBasePathRejected = String(error?.message || error).includes("refusing filesystem access outside the vault");
    }
    assert(missingBasePathRejected, "Missing vault getBasePath() did not fail closed");
  } finally {
    plugin.app.vault.adapter.getBasePath = originalGetBasePathForPolicySmoke;
  }

  const outsideCachePath = path.resolve(root, "..", "outside-cache-output.png");
  assert(plugin.cache.normalizeVaultPath(outsideCachePath) === "", "Outside-vault absolute cache path was normalized into the vault");
  assert(plugin.cache.normalizeVaultPath("../outside-cache-output.png") === "", "Traversal cache path was accepted");
  const originalStatForOutsideCache = fs.promises.stat;
  let outsideCacheStatCalls = 0;
  try {
    fs.promises.stat = async (...args) => {
      outsideCacheStatCalls += 1;
      return await originalStatForOutsideCache.apply(fs.promises, args);
    };
    assert(await plugin.cache.getOutputMetadata(outsideCachePath) === null, "Outside-vault cache metadata path returned filesystem metadata");
  } finally {
    fs.promises.stat = originalStatForOutsideCache;
  }
  assert(outsideCacheStatCalls === 0, "Outside-vault cache metadata path reached fs.stat");

  const legacyMigrationTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-legacy-migration-"));
  const originalFsRenameForMigration = fs.promises.rename;
  const originalConsoleDebugForMigration = console.debug;
  try {
    plugin.app.vault.adapter.basePath = legacyMigrationTemp;
    plugin.app.vault.adapter.path.absolute = legacyMigrationTemp;
    const oldPluginDir = path.join(legacyMigrationTemp, ".obsidian", "plugins", "tiny-local");
    const newPluginDir = path.join(legacyMigrationTemp, ".obsidian", "plugins", "local-image-compress");
    const cacheBackupsDir = path.join(legacyMigrationTemp, ".local-image-compress", "backups", "cache");
    const originalFilesBackupsDir = path.join(legacyMigrationTemp, ".local-image-compress", "backups", "originals");
    fs.mkdirSync(path.join(oldPluginDir, "cache-backups", "nested"), { recursive: true });
    fs.mkdirSync(path.join(newPluginDir, "original-files-backups", "backup-current"), { recursive: true });
    fs.mkdirSync(cacheBackupsDir, { recursive: true });
    fs.writeFileSync(path.join(oldPluginDir, "tinyLocal-cache.json"), "{\"version\":\"legacy\"}");
    fs.writeFileSync(path.join(oldPluginDir, "cache-backups", "nested", "backup.json"), "{}");
    fs.writeFileSync(path.join(newPluginDir, "original-files-backups", "backup-current", "image.jpg"), "image");
    fs.writeFileSync(path.join(cacheBackupsDir, "existing.json"), "{}");
    fs.promises.rename = async (src, dest) => {
      if (String(src).includes("tiny-local")) {
        throw new Error("simulated cross-device rename");
      }
      return await originalFsRenameForMigration(src, dest);
    };
    console.debug = () => {};
    await plugin.migrateLegacyPluginData();
    assert(fs.existsSync(path.join(newPluginDir, "tinyLocal-cache.json")), "Legacy migration copy fallback did not create cache file in new plugin dir");
    assert(fs.existsSync(path.join(cacheBackupsDir, "nested", "backup.json")), "Legacy migration copy fallback did not move cache backups to vault-level storage");
    assert(fs.existsSync(path.join(cacheBackupsDir, "existing.json")), "Backup migration removed an existing destination file while merging");
    assert(fs.existsSync(path.join(originalFilesBackupsDir, "backup-current", "image.jpg")), "Current plugin image backups were not moved to vault-level storage");
    assert(!fs.existsSync(path.join(oldPluginDir, "tinyLocal-cache.json")), "Legacy migration copy fallback left duplicate cache file in old plugin dir");
    assert(!fs.existsSync(path.join(oldPluginDir, "cache-backups")), "Legacy migration copy fallback left duplicate backup dir in old plugin dir");
    assert(!fs.existsSync(path.join(newPluginDir, "original-files-backups")), "Backup migration left the current plugin backup directory behind");
  } finally {
    fs.promises.rename = originalFsRenameForMigration;
    console.debug = originalConsoleDebugForMigration;
    plugin.app.vault.adapter.basePath = originalBasePathForPathSmoke;
    plugin.app.vault.adapter.path.absolute = originalAbsolutePathForPathSmoke;
    fs.rmSync(legacyMigrationTemp, { recursive: true, force: true });
  }

  const i18nCacheTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-i18n-cache-"));
  try {
    const vaultA = path.join(i18nCacheTemp, "vault-a");
    const vaultB = path.join(i18nCacheTemp, "vault-b");
    const langA = path.join(vaultA, ".obsidian", "plugins", "local-image-compress", "lang");
    const langB = path.join(vaultB, ".obsidian", "plugins", "local-image-compress", "lang");
    fs.mkdirSync(langA, { recursive: true });
    fs.mkdirSync(langB, { recursive: true });
    fs.writeFileSync(path.join(langA, "en.json"), JSON.stringify({ "settings.title": "Vault A Settings" }));
    fs.writeFileSync(path.join(langB, "en.json"), JSON.stringify({ "settings.title": "Vault B Settings" }));
    plugin.app.vault.adapter.basePath = vaultA;
    plugin.app.vault.adapter.path.absolute = vaultA;
    await plugin.preloadExternalLanguageFiles();
    assert(plugin.moveService.getMoveText("settings.title") === "Vault A Settings", "External i18n file for vault A was not loaded");
    plugin.app.vault.adapter.basePath = vaultB;
    plugin.app.vault.adapter.path.absolute = vaultB;
    await plugin.preloadExternalLanguageFiles();
    assert(plugin.moveService.getMoveText("settings.title") === "Vault B Settings", "External i18n cache leaked across plugin directories");
  } finally {
    plugin.app.vault.adapter.basePath = originalBasePathForPathSmoke;
    plugin.app.vault.adapter.path.absolute = originalAbsolutePathForPathSmoke;
    fs.rmSync(i18nCacheTemp, { recursive: true, force: true });
  }

  const commandIds = plugin.commands.map((command) => command.id).sort();
  assert(
    JSON.stringify(commandIds) === JSON.stringify([
      "compress-all-images",
      "compress-images-in-folder",
      "compress-images-in-note",
      "move-compressed-to-files"
    ]),
    `Unexpected command ids after onload: ${commandIds.join(", ")}`
  );
  assert(plugin.settingTabs.length === 1, "Plugin did not register exactly one settings tab");
  assert(plugin.statusBarItem, "Plugin did not create a status bar item");
  assert(plugin.statusBarItem.attributes.role === "button", "Status bar item is missing role=button");
  assert(plugin.statusBarItem.attributes.tabindex === "0", "Status bar item is missing tabindex=0");
  assert(plugin.statusBarItem.attributes["aria-haspopup"] === "menu", "Status bar item is missing aria-haspopup=menu");
  assert(plugin.statusBarItem.attributes["aria-expanded"] === "false", "Status bar item should start collapsed");
  assert((plugin.statusBarItem._listeners.click || []).length === 1, "Status bar click handler was not registered exactly once");
  assert((plugin.statusBarItem._listeners.keydown || []).length === 1, "Status bar keydown handler was not registered exactly once");
  const originalShowStatusMenuForClick = plugin.statusBarController.showMenu;
  let statusMenuClickCount = 0;
  const statusMenuOpenEvents = [];
  try {
    plugin.statusBarController.showMenu = async (event) => {
      statusMenuClickCount += 1;
      statusMenuOpenEvents.push(event);
    };
    await plugin.statusBarController.update();
    await plugin.statusBarController.update();
    assert((plugin.statusBarItem._listeners.click || []).length === 1, "Status bar update registered duplicate click handlers");
    assert((plugin.statusBarItem._listeners.keydown || []).length === 1, "Status bar update registered duplicate keydown handlers");
    plugin.statusBarItem.dispatchEvent("click", { preventDefault() {} });
    assert(statusMenuClickCount === 1, "Status bar registered click handler did not open the menu once");
    plugin.statusBarItem.dispatchEvent("keydown", { key: "Tab", preventDefault() { throw new Error("Tab should not open status menu"); } });
    assert(statusMenuClickCount === 1, "Non-activation status bar key opened the menu");
    let enterPrevented = false;
    plugin.statusBarItem.dispatchEvent("keydown", {
      key: "Enter",
      preventDefault() {
        enterPrevented = true;
      }
    });
    assert(statusMenuClickCount === 2 && enterPrevented, "Status bar Enter key did not open the menu with preventDefault");
    assert(statusMenuOpenEvents[1]?.keyboard === true && statusMenuOpenEvents[1]?.target === plugin.statusBarItem, "Status bar Enter key did not use keyboard menu open context");
    let spacePrevented = false;
    plugin.statusBarItem.dispatchEvent("keydown", {
      key: " ",
      preventDefault() {
        spacePrevented = true;
      }
    });
    assert(statusMenuClickCount === 3 && spacePrevented, "Status bar Space key did not open the menu with preventDefault");
    assert(statusMenuOpenEvents[2]?.keyboard === true && statusMenuOpenEvents[2]?.returnFocusTo === plugin.statusBarItem, "Status bar Space key did not preserve focus return target");
  } finally {
    plugin.statusBarController.showMenu = originalShowStatusMenuForClick;
  }
  assert(plugin.cache && String(plugin.cache.cacheFile).includes("tinyLocal-cache.json"), "Plugin cache was not initialized");

  const ConcurrencyLimiterClass = plugin.compressionLimiter.constructor;
  for (const invalidLimit of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    let rejectedInvalidLimit = false;
    try {
      new ConcurrencyLimiterClass(invalidLimit);
    } catch (error) {
      rejectedInvalidLimit = error instanceof RangeError;
    }
    assert(rejectedInvalidLimit, `ConcurrencyLimiter accepted invalid limit: ${invalidLimit}`);
  }

  const limiterSleep = (delayMs) => new Promise((resolve) => originalGlobals.setTimeout(resolve, delayMs));
  const withLimiterTimeout = (promise, message) => Promise.race([
    promise,
    new Promise((_, reject) => originalGlobals.setTimeout(() => reject(new Error(message)), 500))
  ]);
  const concurrencyLimiter = new ConcurrencyLimiterClass(2);
  let runningLimiterTasks = 0;
  let maxRunningLimiterTasks = 0;
  const limiterResults = await Promise.all(Array.from({ length: 10 }, (_, index) => concurrencyLimiter.run(async () => {
    runningLimiterTasks += 1;
    maxRunningLimiterTasks = Math.max(maxRunningLimiterTasks, runningLimiterTasks);
    assert(concurrencyLimiter.active <= concurrencyLimiter.getLimit(), "ConcurrencyLimiter active count exceeded its limit");
    await limiterSleep(2);
    runningLimiterTasks -= 1;
    return index;
  })));
  assert(maxRunningLimiterTasks <= 2, `ConcurrencyLimiter allowed ${maxRunningLimiterTasks} concurrent tasks for limit=2`);
  assert(limiterResults.length === 10 && limiterResults[9] === 9, "ConcurrencyLimiter did not resolve all queued tasks");
  assert(concurrencyLimiter.active === 0 && concurrencyLimiter.queue.length === 0, "ConcurrencyLimiter leaked active or queued task state");

  const corruptQueueLimiter = new ConcurrencyLimiterClass(1);
  let releaseBlockingLimiterTask = null;
  const blockingLimiterTask = corruptQueueLimiter.run(async () => {
    await new Promise((resolve) => {
      releaseBlockingLimiterTask = resolve;
    });
  });
  const queuedLimiterTask = corruptQueueLimiter.run(async () => "queued-ok");
  assert(corruptQueueLimiter.active === 1 && corruptQueueLimiter.queue.length === 1, "ConcurrencyLimiter queued task state is wrong");
  corruptQueueLimiter.queue.unshift(() => {
    throw new Error("corrupted queued waiter");
  });
  releaseBlockingLimiterTask();
  await withLimiterTimeout(blockingLimiterTask, "ConcurrencyLimiter blocking task did not settle");
  assert(await withLimiterTimeout(queuedLimiterTask, "ConcurrencyLimiter did not recover after a corrupted queued waiter") === "queued-ok", "ConcurrencyLimiter recovered waiter returned the wrong value");
  assert(corruptQueueLimiter.active === 0 && corruptQueueLimiter.queue.length === 0, "ConcurrencyLimiter kept stale state after corrupted waiter recovery");

  const originalLoadDataForNormalize = plugin.loadData;
  const originalSettingsForNormalize = plugin.settings;
  try {
    plugin.loadData = async () => ({
      pngQuality: { min: 0 },
      jpegQuality: 999,
      allowedRoots: "Images",
      outputFolder: "../outside",
      pngquantPath: "C:\\legacy\\pngquant.exe",
      mozjpegPath: "C:\\legacy\\mozjpeg.exe",
      workerPoolSize: 99,
      compressionTimeoutSeconds: 9999,
      wasmInitTimeoutSeconds: 1,
      maxInputSizeMB: 0,
      maxImagePixelsMillions: 2000,
      autoBackgroundThreshold: -1,
      inactivityThresholdMinutes: 99,
      cacheRetentionMonths: 999,
      pluginGuardTimeoutMs: 999999,
      autoBackupsRetentionDays: 9999,
      autoMoveCompressedThreshold: 0
    });
    await plugin.loadSettings();
    assert(plugin.settings.pngQuality.min === 1 && plugin.settings.pngQuality.max === 80, "loadSettings() did not deep-normalize partial PNG quality");
    assert(plugin.settings.jpegQuality === 95, "loadSettings() did not clamp JPEG quality");
    assert(Array.isArray(plugin.settings.allowedRoots) && plugin.settings.allowedRoots.length === 0, "loadSettings() did not normalize malformed allowedRoots");
    assert(plugin.settings.outputFolder === "Compressed", "loadSettings() did not reject unsafe outputFolder");
    for (const technicalKey of removedTechnicalSettingKeys) {
      assert(!(technicalKey in plugin.settings), `normalizeSettings kept removed technical key: ${technicalKey}`);
    }
    assert(plugin.compressor.processTimeoutMs === 120000, "loadSettings() did not apply internal compression timeout to Compressor");
    assert(plugin.compressor.initTimeoutMs === 60000, "loadSettings() did not apply internal WASM init timeout to Compressor");
    assert(plugin.compressor.maxInputBytes === 100 * 1024 * 1024, "loadSettings() did not apply internal input size limit to Compressor");
    assert(plugin.compressor.maxImagePixels === 100 * 1000000, "loadSettings() did not apply internal image pixel limit to Compressor");
    assert(plugin.settings.autoBackgroundThreshold === 10, "normalizeSettings did not clamp autoBackgroundThreshold");
    assert(plugin.settings.inactivityThresholdMinutes === 60, "normalizeSettings did not clamp inactivityThresholdMinutes");
    assert(plugin.backgroundCompressionService.USER_INACTIVITY_THRESHOLD === 60 * 60 * 1000, "loadSettings() did not apply runtime inactivity threshold");
    assert(plugin.settings.cacheRetentionMonths === 60, "normalizeSettings did not clamp cacheRetentionMonths");
    assert(plugin.pluginGuardService.operationTimeoutMs === 8000, "loadSettings() did not apply internal plugin guard timeout");
    assert(plugin.settings.autoBackupsRetentionDays === 365, "normalizeSettings did not clamp autoBackupsRetentionDays");
    assert(plugin.settings.autoMoveCompressedThreshold === 1, "normalizeSettings did not clamp autoMoveCompressedThreshold");
    for (const malformedOutputFolder of [{}, [], 42, "   "]) {
      plugin.loadData = async () => ({ outputFolder: malformedOutputFolder });
      await plugin.loadSettings();
      assert(plugin.settings.outputFolder === "Compressed", `loadSettings() accepted malformed outputFolder: ${JSON.stringify(malformedOutputFolder)}`);
    }
    const LoadSettingsObsidianMock = require("obsidian");
    const originalNoticeForLoadSettings = LoadSettingsObsidianMock.Notice;
    const originalConsoleErrorForLoadSettings = console.error;
    const loadSettingsNotices = [];
    try {
      LoadSettingsObsidianMock.Notice = class {
        constructor(message, duration) {
          loadSettingsNotices.push({ message, duration });
        }
      };
      console.error = () => {};
      plugin.loadData = async () => {
        throw new SyntaxError("corrupt data.json");
      };
      await plugin.loadSettings();
      assert(plugin.settings.outputFolder === "Compressed", "loadSettings() did not fall back to defaults after loadData failure");
      assert(plugin.settings.inactivityThresholdMinutes === 2 && plugin.backgroundCompressionService.USER_INACTIVITY_THRESHOLD === 2 * 60 * 1000, "loadSettings() did not restore default inactivity threshold after loadData failure");
      assert(plugin.settings.cacheRetentionMonths === 12, "loadSettings() did not restore default cache retention after loadData failure");
      assert(plugin.pluginGuardService.operationTimeoutMs === 8000, "loadSettings() did not restore internal plugin guard timeout after loadData failure");
      assert(plugin.compressor.processTimeoutMs === 120000, "loadSettings() did not restore internal compression timeout after loadData failure");
      assert(plugin.compressor.initTimeoutMs === 60000, "loadSettings() did not restore internal WASM init timeout after loadData failure");
      assert(plugin.compressor.maxInputBytes === 100 * 1024 * 1024, "loadSettings() did not restore internal input size limit after loadData failure");
      assert(plugin.compressor.maxImagePixels === 100 * 1000000, "loadSettings() did not restore internal image pixel limit after loadData failure");
      assert(loadSettingsNotices.some((notice) => String(notice.message).includes("Settings") && notice.duration === 10000), "loadSettings() failure did not notify the user");
    } finally {
      LoadSettingsObsidianMock.Notice = originalNoticeForLoadSettings;
      console.error = originalConsoleErrorForLoadSettings;
    }
  } finally {
    plugin.loadData = originalLoadDataForNormalize;
    plugin.settings = originalSettingsForNormalize;
  }

  const originalSettingsForSaveConfig = plugin.settings;
  const originalSaveDataForSaveConfig = plugin.saveData;
  const originalRebuildImageIndexForSaveConfig = plugin.rebuildImageIndex;
  const originalImageIndexConfigKeyForSaveConfig = plugin.imageIndexConfigKey;
  try {
    const SaveConfigObsidianMock = require("obsidian");
    const rebuildReasons = [];
    plugin.saveData = async () => {};
    plugin.rebuildImageIndex = async (reason) => {
      rebuildReasons.push(reason);
    };
    plugin.settings = { ...plugin.settings, outputFolder: "Compressed", allowedRoots: ["Alpha", "Beta"] };
    plugin.imageIndexConfigKey = plugin.getImageIndexConfigKey();
    plugin.settings = { ...plugin.settings, outputFolder: "Compressed", allowedRoots: ["Beta", "Alpha"] };
    await plugin.saveSettings();
    assert(rebuildReasons.length === 0, "saveSettings() rebuilt the image index for allowedRoots reorder only");
    plugin.settings = { ...plugin.settings, outputFolder: "Compressed", allowedRoots: ["Alpha", "Gamma"] };
    await plugin.saveSettings();
    assert(rebuildReasons.length === 1, "saveSettings() did not rebuild the image index for allowedRoots content changes");
    const folderLikeImage = new SaveConfigObsidianMock.TFolder();
    folderLikeImage.path = "Images/folder.png";
    folderLikeImage.name = "folder.png";
    assert(plugin.isImageFile(folderLikeImage) === false, "isImageFile() accepted a folder-like object without extension");
    assert(plugin.isImageFile({ path: "Images/no-extension", name: "no-extension" }) === false, "isImageFile() threw or accepted an object without extension");
    assert(plugin.isImageFile({ path: "Images/caps.PNG", name: "caps.PNG", extension: "PNG" }) === true, "isImageFile() did not handle uppercase extensions");
    const invalidValidationResult = await plugin.validateFileForCompression({ path: "Images/no-extension", name: "no-extension" });
    assert(invalidValidationResult.valid === false && String(invalidValidationResult.error).includes("Unsupported"), "validateFileForCompression() did not reject missing-extension files safely");
  } finally {
    plugin.settings = originalSettingsForSaveConfig;
    plugin.saveData = originalSaveDataForSaveConfig;
    plugin.rebuildImageIndex = originalRebuildImageIndexForSaveConfig;
    plugin.imageIndexConfigKey = originalImageIndexConfigKeyForSaveConfig;
  }

  const originalGetActiveDocumentForFolderSelector = plugin.getActiveDocument;
  const originalSetWindowTimeoutForFolderSelector = plugin.setWindowTimeout;
  try {
    plugin.setWindowTimeout = (callback) => {
      callback();
      return 1;
    };
    const selectedFolderPromise = plugin.showFolderSelector(["/", "Images"]);
    const modal = Array.from(plugin.managedModals).find((candidate) => candidate?.contentEl?.classList?.contains("tiny-local-folder-select-modal"));
    assert(modal, "Folder selector modal was not tracked as a managed modal");
    const select = modal.contentEl.children[0];
    const footer = modal.contentEl.children[1];
    const okButton = footer.children[0];
    const cancelButton = footer.children[1];
    assert(modal.titleEl.id === "tiny-local-folder-select-title", "Folder selector title is missing a stable id");
    assert(modal.contentEl.attributes["aria-labelledby"] === "tiny-local-folder-select-title", "Folder selector content is missing aria-labelledby");
    assert(select.attributes["aria-label"] === "Folder", "Folder selector select is missing an accessible label");
    assert(select.className === "tiny-local-folder-select-control", "Folder selector select is missing its CSS class");
    assert(select.children[0].textContent === "Root folder", `Folder selector used wrong root label: ${select.children[0].textContent}`);
    assert(okButton.attributes["aria-label"] === "Select", "Folder selector OK button is missing an accessible label");
    assert(cancelButton.attributes["aria-label"] === "Cancel", "Folder selector cancel button is missing an accessible label");
    assert(select.focused === true, "Folder selector did not focus the select control on open");
    select.value = "Images";
    okButton.dispatchEvent("click");
    const selectedFolder = await selectedFolderPromise;
    assert(selectedFolder === "Images", `Folder selector returned wrong path: ${selectedFolder}`);
    assert(!plugin.managedModals.has(modal), "Folder selector modal was not untracked after selection");

    const closedFolderPromise = plugin.showFolderSelector(["/", "Images"]);
    const closeModal = Array.from(plugin.managedModals).find((candidate) => candidate?.contentEl?.classList?.contains("tiny-local-folder-select-modal"));
    assert(closeModal, "Folder selector close test did not track the modal");
    plugin.closeManagedModals();
    const closedFolder = await closedFolderPromise;
    assert(closedFolder === null, "Folder selector did not resolve null when closed through managed modal cleanup");
    assert(!plugin.managedModals.has(closeModal), "Folder selector modal was not untracked after managed close");
  } finally {
    plugin.getActiveDocument = originalGetActiveDocumentForFolderSelector;
    plugin.setWindowTimeout = originalSetWindowTimeoutForFolderSelector;
  }

  const basePathOnlyTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-getbasepath-"));
  const originalAdapterBasePath = plugin.app.vault.adapter.basePath;
  const originalAdapterPath = plugin.app.vault.adapter.path;
  const originalAdapterGetBasePath = plugin.app.vault.adapter.getBasePath;
  try {
    plugin.app.vault.adapter.basePath = undefined;
    plugin.app.vault.adapter.path = {};
    plugin.app.vault.adapter.getBasePath = () => basePathOnlyTemp;
    plugin.settings.outputFolder = "Compressed";
    const colonRelativeOutput = plugin.savingsCalculator.getCompressedFilePath("Images/photo:edited.jpg");
    assert(
      colonRelativeOutput === path.join(basePathOnlyTemp, "Compressed", "Images", "photo:edited.jpg"),
      `Vault-relative path with colon was treated as absolute: ${colonRelativeOutput}`
    );
    assert(plugin.cache.getVaultBasePath() === basePathOnlyTemp, "Cache did not resolve getBasePath()-only adapter");
    assert(plugin.moveService.getVaultBasePath() === basePathOnlyTemp, "MoveService did not resolve getBasePath()-only adapter");
    const originalPath = path.join(basePathOnlyTemp, "Images", "basepath-only.jpg");
    const compressedPath = path.join(basePathOnlyTemp, "Compressed", "Images", "basepath-only.jpg");
    fs.mkdirSync(path.dirname(originalPath), { recursive: true });
    fs.mkdirSync(path.dirname(compressedPath), { recursive: true });
    fs.writeFileSync(originalPath, Buffer.alloc(100));
    fs.writeFileSync(compressedPath, Buffer.alloc(50));
    await setMockFiles(plugin, [
      Object.assign(new (require("obsidian").TFile)(), createMockFile("Images/basepath-only.jpg", 100, 1))
    ]);
    const getBasePathOnlyMoveCount = await plugin.moveService.getCompressedFilesCount();
    assert(getBasePathOnlyMoveCount === 1, `MoveService getBasePath()-only count was wrong: ${getBasePathOnlyMoveCount}`);
  } finally {
    plugin.app.vault.adapter.basePath = originalAdapterBasePath;
    plugin.app.vault.adapter.path = originalAdapterPath;
    plugin.app.vault.adapter.getBasePath = originalAdapterGetBasePath;
    fs.rmSync(basePathOnlyTemp, { recursive: true, force: true });
    await setMockFiles(plugin, []);
  }

  const ObsidianMock = require("obsidian");
  const originalSetWindowTimeoutForNewFile = plugin.setWindowTimeout;
  const originalClearWindowTimeoutForNewFile = plugin.clearWindowTimeout;
  const originalAutoCompressNewFile = plugin.autoCompressNewFile;
  const delayedNewFileTimers = [];
  let delayedNewFileCompressCalls = 0;
  try {
    plugin.settings.autoCompressNewFiles = true;
    plugin.isUnloading = false;
    plugin.setWindowTimeout = (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      delayedNewFileTimers.push(timer);
      return timer;
    };
    plugin.clearWindowTimeout = (timer) => {
      if (timer) timer.cleared = true;
    };
    plugin.autoCompressNewFile = async () => {
      delayedNewFileCompressCalls += 1;
    };
    const newImageFile = Object.assign(new ObsidianMock.TFile(), createMockFile("Images/delayed-new.png", 100000, 1));
    await plugin.handleNewFile(newImageFile);
    assert(delayedNewFileTimers.length === 1, "handleNewFile() did not schedule delayed auto-compression");
    assert(plugin.newFileQueue.newFileCompressionTimers.size === 1, "Delayed new-file timer was not tracked for unload cleanup");
    const outputImageFile = Object.assign(new ObsidianMock.TFile(), createMockFile("Compressed/Images/delayed-output.png", 100000, 2));
    await plugin.handleNewFile(outputImageFile);
    assert(delayedNewFileTimers.length === 1, "handleNewFile() scheduled recursive compression for an output-folder file");
    const outputValidation = await plugin.validateFileForCompression(outputImageFile);
    assert(outputValidation.valid === false, "validateFileForCompression() allowed an output-folder file");
    let outputContextItems = 0;
    plugin.addContextMenu({
      addItem(itemBuilder) {
        outputContextItems += 1;
        itemBuilder({
          setTitle() { return this; },
          setIcon() { return this; },
          onClick() { return this; }
        });
      }
    }, outputImageFile);
    assert(outputContextItems === 0, "Context menu exposed single-file compression for an output-folder file");
    plugin.onunload();
    assert(plugin.newFileQueue.newFileCompressionTimers.size === 0, "onunload() did not clear delayed new-file timers");
    assert(delayedNewFileTimers[0].cleared === true, "onunload() did not clear the scheduled new-file timer handle");
    await delayedNewFileTimers[0].callback();
    assert(delayedNewFileCompressCalls === 0, "Delayed new-file compression ran after plugin unload");
  } finally {
    plugin.setWindowTimeout = originalSetWindowTimeoutForNewFile;
    plugin.clearWindowTimeout = originalClearWindowTimeoutForNewFile;
    plugin.autoCompressNewFile = originalAutoCompressNewFile;
    plugin.settings.autoCompressNewFiles = false;
    plugin.isUnloading = false;
    plugin.newFileQueue.newFileCompressionTimers.clear();
  }

  const originalSetWindowTimeoutForNewFileBatch = plugin.setWindowTimeout;
  const originalClearWindowTimeoutForNewFileBatch = plugin.clearWindowTimeout;
  const originalProcessBatchCompressionBackground = plugin.processBatchCompressionBackground;
  const originalGetAbstractFileByPathForNewFileBatch = plugin.app.vault.getAbstractFileByPath;
  const batchTimers = [];
  let batchCompressionCalls = 0;
  let batchCompressionSize = 0;
  try {
    plugin.settings.autoCompressNewFiles = true;
    plugin.isUnloading = false;
    plugin.newFileQueue.newFileCompressionTimers.clear();
    plugin.newFileQueue.newFileCompressionPending.clear();
    plugin.newFileQueue.newFileCompressionInFlight.clear();
    const batchFiles = new Map(Array.from({ length: 6 }, (_, index) => {
      const file = Object.assign(new ObsidianMock.TFile(), createMockFile(`Images/batch-${index}.png`, 100000, index + 10));
      return [file.path, file];
    }));
    plugin.app.vault.getAbstractFileByPath = (filePath) => batchFiles.get(filePath) || null;
    plugin.setWindowTimeout = (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      batchTimers.push(timer);
      return timer;
    };
    plugin.clearWindowTimeout = (timer) => {
      if (timer) timer.cleared = true;
    };
    plugin.processBatchCompressionBackground = async (files) => {
      batchCompressionCalls += 1;
      batchCompressionSize = files.length;
    };
    for (const file of batchFiles.values()) {
      await plugin.handleNewFile(file);
    }
    assert(plugin.newFileQueue.newFileCompressionTimers.size === 6, "Rapid create events were not tracked per path");
    for (const timer of batchTimers.slice(0, 6)) {
      await timer.callback();
    }
    assert(batchTimers.length === 7, `New-file batch drain should use one coalesced timer, got ${batchTimers.length - 6}`);
    await batchTimers[6].callback();
    assert(batchCompressionCalls === 1, `New-file compression was not coalesced into one batch: ${batchCompressionCalls}`);
    assert(batchCompressionSize === 6, `New-file batch size was wrong: ${batchCompressionSize}`);

    const duplicateFile = batchFiles.values().next().value;
    await plugin.handleNewFile(duplicateFile);
    const firstDuplicateTimer = plugin.newFileQueue.newFileCompressionTimers.get(duplicateFile.path);
    await plugin.handleNewFile(duplicateFile);
    assert(firstDuplicateTimer.cleared === true, "Duplicate create event did not cancel the older timer");
    assert(plugin.newFileQueue.newFileCompressionTimers.size === 1, "Duplicate create event left more than one timer for the same path");
    const timerBeforeModify = plugin.newFileQueue.newFileCompressionTimers.get(duplicateFile.path);
    await plugin.app._vaultHandlers.modify(duplicateFile);
    const timerAfterModify = plugin.newFileQueue.newFileCompressionTimers.get(duplicateFile.path);
    assert(timerBeforeModify.cleared === true, "Modify event did not cancel a pending new-file compression timer");
    assert(timerAfterModify && timerAfterModify !== timerBeforeModify, "Modify event did not re-arm pending new-file compression");
    await timerAfterModify.callback();
    const drainTimerBeforePendingModify = plugin.newFileQueue.newFileBatchFlushTimer;
    assert(plugin.newFileQueue.newFileCompressionPending.has(duplicateFile.path), "New-file timer did not move path into pending batch");
    await plugin.app._vaultHandlers.modify(duplicateFile);
    const timerAfterPendingModify = plugin.newFileQueue.newFileCompressionTimers.get(duplicateFile.path);
    assert(drainTimerBeforePendingModify.cleared === true, "Modify event did not cancel the pending-drain timer");
    assert(!plugin.newFileQueue.newFileCompressionPending.has(duplicateFile.path), "Modify event left a stale pending new-file path");
    assert(timerAfterPendingModify && timerAfterPendingModify !== timerAfterModify, "Modify event did not re-arm from the pending-drain window");
    await drainTimerBeforePendingModify.callback();
    assert(batchCompressionCalls === 1, "Cleared pending-drain timer still compressed a modified new file");
  } finally {
    plugin.setWindowTimeout = originalSetWindowTimeoutForNewFileBatch;
    plugin.clearWindowTimeout = originalClearWindowTimeoutForNewFileBatch;
    plugin.processBatchCompressionBackground = originalProcessBatchCompressionBackground;
    plugin.app.vault.getAbstractFileByPath = originalGetAbstractFileByPathForNewFileBatch;
    plugin.settings.autoCompressNewFiles = false;
    plugin.isUnloading = false;
    plugin.newFileQueue.newFileCompressionTimers.clear();
    plugin.newFileQueue.newFileCompressionPending.clear();
    plugin.newFileQueue.newFileCompressionInFlight.clear();
    plugin.newFileQueue.newFileBatchFlushTimer = null;
    plugin.newFileQueue.newFileBatchDrainInProgress = false;
    plugin.newFileQueue.newFileBatchDrainRescheduleRequested = false;
    plugin.newFileQueue.newFileBatchFirstQueuedAt = null;
  }

  const originalSetWindowTimeoutForDrainOverlap = plugin.setWindowTimeout;
  const originalProcessBatchForDrainOverlap = plugin.processBatchCompressionBackground;
  const originalGetAbstractFileByPathForDrainOverlap = plugin.app.vault.getAbstractFileByPath;
  const drainOverlapTimers = [];
  let activeDrainBatches = 0;
  let maxActiveDrainBatches = 0;
  let drainBatchCalls = 0;
  let releaseFirstDrain = null;
  let firstDrainStarted = null;
  const firstDrainStartedPromise = new Promise((resolve) => {
    firstDrainStarted = resolve;
  });
  try {
    const firstDrainFile = Object.assign(new ObsidianMock.TFile(), createMockFile("Images/drain-overlap-a.png", 100000, 30));
    const secondDrainFile = Object.assign(new ObsidianMock.TFile(), createMockFile("Images/drain-overlap-b.png", 100000, 31));
    const drainFiles = new Map([
      [firstDrainFile.path, firstDrainFile],
      [secondDrainFile.path, secondDrainFile]
    ]);
    plugin.app.vault.getAbstractFileByPath = (filePath) => drainFiles.get(filePath) || null;
    plugin.setWindowTimeout = (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      drainOverlapTimers.push(timer);
      return timer;
    };
    plugin.processBatchCompressionBackground = async () => {
      drainBatchCalls += 1;
      activeDrainBatches += 1;
      maxActiveDrainBatches = Math.max(maxActiveDrainBatches, activeDrainBatches);
      if (drainBatchCalls === 1) {
        firstDrainStarted();
        await new Promise((resolve) => {
          releaseFirstDrain = resolve;
        });
      }
      activeDrainBatches -= 1;
    };
    plugin.newFileQueue.newFileCompressionPending.add(firstDrainFile.path);
    const firstDrain = plugin.drainNewFileCompressionBatch();
    await firstDrainStartedPromise;
    plugin.newFileQueue.newFileCompressionPending.add(secondDrainFile.path);
    plugin.scheduleNewFileBatchDrain();
    assert(drainOverlapTimers.length === 0, "scheduleNewFileBatchDrain() scheduled an overlapping drain while one was active");
    releaseFirstDrain();
    await firstDrain;
    assert(drainOverlapTimers.length === 1, "Completed drain did not schedule the pending follow-up batch");
    drainOverlapTimers[0].callback();
    await Promise.resolve();
    await Promise.resolve();
    assert(drainBatchCalls === 2, `Expected serialized follow-up drain, got ${drainBatchCalls} batch calls`);
    assert(maxActiveDrainBatches === 1, "New-file batch drains overlapped");
  } finally {
    releaseFirstDrain?.();
    plugin.setWindowTimeout = originalSetWindowTimeoutForDrainOverlap;
    plugin.processBatchCompressionBackground = originalProcessBatchForDrainOverlap;
    plugin.app.vault.getAbstractFileByPath = originalGetAbstractFileByPathForDrainOverlap;
    plugin.newFileQueue.newFileCompressionPending.clear();
    plugin.newFileQueue.newFileCompressionInFlight.clear();
    plugin.newFileQueue.newFileBatchFlushTimer = null;
    plugin.newFileQueue.newFileBatchDrainInProgress = false;
    plugin.newFileQueue.newFileBatchDrainRescheduleRequested = false;
    plugin.newFileQueue.newFileBatchFirstQueuedAt = null;
  }

  const originalSetWindowTimeoutForQueueCap = plugin.setWindowTimeout;
  const originalGetAbstractFileByPathForQueueCap = plugin.app.vault.getAbstractFileByPath;
  const originalNoticeForQueueCap = ObsidianMock.Notice;
  const originalProcessBatchForQueueCap = plugin.processBatchCompressionBackground;
  const originalQueueCap = plugin.newFileQueue.NEW_FILE_PENDING_MAX;
  const queueCapTimers = [];
  const queueCapNotices = [];
  try {
    plugin.settings.autoCompressNewFiles = true;
    plugin.newFileQueue.NEW_FILE_PENDING_MAX = 2;
    plugin.newFileQueue.newFilePendingOverflowWarned = false;
    plugin.newFileQueue.newFileCompressionPending.clear();
    plugin.newFileQueue.newFileCompressionTimers.clear();
    plugin.newFileQueue.newFileCompressionInFlight.clear();
    const capFiles = new Map(Array.from({ length: 3 }, (_, index) => {
      const file = Object.assign(new ObsidianMock.TFile(), createMockFile(`Images/queue-cap-${index}.png`, 100000, index + 40));
      return [file.path, file];
    }));
    plugin.app.vault.getAbstractFileByPath = (filePath) => capFiles.get(filePath) || null;
    plugin.processBatchCompressionBackground = async () => {};
    plugin.setWindowTimeout = (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      queueCapTimers.push(timer);
      return timer;
    };
    ObsidianMock.Notice = class {
      constructor(message, duration) {
        queueCapNotices.push({ message, duration });
      }
    };
    for (const file of capFiles.values()) {
      await plugin.handleNewFile(file);
    }
    for (const timer of queueCapTimers.slice(0, 3)) {
      await timer.callback();
    }
    assert(plugin.newFileQueue.newFileCompressionPending.size === 2, "New-file pending queue exceeded its cap");
    assert(plugin.newFileQueue.newFilePendingOverflowWarned === true, "New-file queue cap did not set overflow warning state");
    assert(queueCapNotices.some((notice) => String(notice.message).includes("2") && notice.duration === 10000), "New-file queue overflow did not show a user Notice");
    plugin.newFileQueue.newFileBatchFlushTimer = null;
    await plugin.drainNewFileCompressionBatch();
    assert(plugin.newFileQueue.newFileCompressionPending.size === 0, "New-file queue cap drain did not clear pending paths");
    assert(plugin.newFileQueue.newFilePendingOverflowWarned === false, "New-file queue cap warning state did not reset after drain");
    const noticeCountAfterFirstOverflow = queueCapNotices.length;
    const nextTimerStart = queueCapTimers.length;
    for (const file of capFiles.values()) {
      await plugin.handleNewFile(file);
    }
    for (const timer of queueCapTimers.slice(nextTimerStart)) {
      await timer.callback();
    }
    assert(queueCapNotices.length > noticeCountAfterFirstOverflow, "New-file queue cap did not notify again after a completed drain cycle");
  } finally {
    plugin.setWindowTimeout = originalSetWindowTimeoutForQueueCap;
    plugin.app.vault.getAbstractFileByPath = originalGetAbstractFileByPathForQueueCap;
    ObsidianMock.Notice = originalNoticeForQueueCap;
    plugin.processBatchCompressionBackground = originalProcessBatchForQueueCap;
    plugin.newFileQueue.NEW_FILE_PENDING_MAX = originalQueueCap;
    plugin.settings.autoCompressNewFiles = false;
    plugin.newFileQueue.newFilePendingOverflowWarned = false;
    plugin.newFileQueue.newFileCompressionPending.clear();
    plugin.newFileQueue.newFileCompressionTimers.clear();
    plugin.newFileQueue.newFileCompressionInFlight.clear();
    plugin.newFileQueue.newFileBatchFlushTimer = null;
  }

  const originalRunCompressionBatchForBackgroundNotice = plugin.runCompressionBatch;
  const originalMaybeAutoMoveForBackgroundNotice = plugin.maybeAutoMoveCompressed;
  const originalNoticeForBackgroundNotice = ObsidianMock.Notice;
  const backgroundNotices = [];
  try {
    ObsidianMock.Notice = class {
      constructor(message, duration) {
        backgroundNotices.push({ message, duration });
      }
    };
    plugin.runCompressionBatch = async () => ({ compressed: 2 });
    plugin.maybeAutoMoveCompressed = async () => {};
    plugin.backgroundCompressionNoticeAt = 0;
    await plugin.processBatchCompressionBackground(Array.from({ length: 5 }, (_, index) => createMockFile(`Images/background-${index}.jpg`, 100000, index + 50)));
    assert(backgroundNotices.some((notice) => String(notice.message).includes("5") && notice.duration === 3000), "Background compression did not show a start Notice");
    assert(backgroundNotices.some((notice) => String(notice.message).includes("2") && notice.duration === 5000), "Background compression did not show a finish Notice");
    const noticesAfterFirstBackgroundRun = backgroundNotices.length;
    await plugin.processBatchCompressionBackground(Array.from({ length: 5 }, (_, index) => createMockFile(`Images/background-again-${index}.jpg`, 100000, index + 70)));
    assert(backgroundNotices.length === noticesAfterFirstBackgroundRun, "Background compression notices were not rate-limited for a repeated threshold trigger");
  } finally {
    plugin.runCompressionBatch = originalRunCompressionBatchForBackgroundNotice;
    plugin.maybeAutoMoveCompressed = originalMaybeAutoMoveForBackgroundNotice;
    plugin.backgroundCompressionNoticeAt = 0;
    ObsidianMock.Notice = originalNoticeForBackgroundNotice;
  }

  const originalValidateForGhostAutoCleanup = plugin.validateFileForCompression;
  const originalRunLimitedForGhostAutoCleanup = plugin.runLimitedCompression;
  const originalIsProcessedForGhostAutoCleanup = plugin.cache.isFileAlreadyProcessed;
  const originalGetCacheKeyForGhostAutoCleanup = plugin.cache.getCacheKey;
  const originalAddToCacheForGhostAutoCleanup = plugin.cache.addToCache;
  const originalCreateBackupForGhostAutoCleanup = plugin.cache.createBackup;
  const originalUpdateImageIndexForGhostAutoCleanup = plugin.updateImageIndexForFile;
  const originalCleanupGhostEntriesForAutoCleanup = plugin.cleanupGhostEntries;
  const originalUpdateSavingsIndicatorForGhostAutoCleanup = plugin.updateSavingsIndicatorInSettings;
  try {
    plugin.isUnloading = false;
    plugin.cache.acceptingWrites = true;
    plugin.moveService.moveOperationInProgress = false;
    plugin.ghostEntryDirtyCount = 0;
    let automaticGhostCleanupCalls = 0;
    plugin.validateFileForCompression = async () => ({ valid: true });
    plugin.runLimitedCompression = async () => ({ success: true, savings: 10 });
    plugin.cache.isFileAlreadyProcessed = async () => false;
    plugin.cache.getCacheKey = async (file) => `ghost-auto:${file.path}`;
    plugin.cache.addToCache = async () => {};
    plugin.cache.createBackup = async () => {};
    plugin.updateImageIndexForFile = async () => {};
    plugin.updateSavingsIndicatorInSettings = () => {};
    plugin.cleanupGhostEntries = async () => {
      automaticGhostCleanupCalls += 1;
      return 3;
    };
    const firstGhostBatch = Array.from({ length: 99 }, (_, index) => createMockFile(`Images/ghost-auto-${index}.jpg`, 100000, index + 1));
    const secondGhostBatch = [createMockFile("Images/ghost-auto-trigger.jpg", 100000, 200)];
    await plugin.runCompressionBatch(firstGhostBatch);
    assert(automaticGhostCleanupCalls === 0, "Automatic ghost cleanup ran before the compression threshold");
    assert(plugin.ghostEntryDirtyCount === 99, `Automatic ghost cleanup tracked wrong dirty count before threshold: ${plugin.ghostEntryDirtyCount}`);
    await plugin.runCompressionBatch(secondGhostBatch);
    assert(automaticGhostCleanupCalls === 1, `Automatic ghost cleanup ran ${automaticGhostCleanupCalls} times instead of once at threshold`);
    assert(plugin.ghostEntryDirtyCount === 0, "Automatic ghost cleanup did not reset the dirty counter after cleanup");
  } finally {
    plugin.validateFileForCompression = originalValidateForGhostAutoCleanup;
    plugin.runLimitedCompression = originalRunLimitedForGhostAutoCleanup;
    plugin.cache.isFileAlreadyProcessed = originalIsProcessedForGhostAutoCleanup;
    plugin.cache.getCacheKey = originalGetCacheKeyForGhostAutoCleanup;
    plugin.cache.addToCache = originalAddToCacheForGhostAutoCleanup;
    plugin.cache.createBackup = originalCreateBackupForGhostAutoCleanup;
    plugin.updateImageIndexForFile = originalUpdateImageIndexForGhostAutoCleanup;
    plugin.cleanupGhostEntries = originalCleanupGhostEntriesForAutoCleanup;
    plugin.updateSavingsIndicatorInSettings = originalUpdateSavingsIndicatorForGhostAutoCleanup;
    plugin.ghostEntryDirtyCount = 0;
  }

  const originalRunLimitedForUnload = plugin.runLimitedCompression;
  const originalAddToCacheForUnload = plugin.cache.addToCache;
  const originalIsProcessedForUnload = plugin.cache.isFileAlreadyProcessed;
  const originalUpdateStatusBarForUnload = plugin.updateStatusBar;
  let unloadBatchCacheWrites = 0;
  try {
    plugin.isUnloading = false;
    plugin.settings.allowedRoots = [];
    plugin.cache.isFileAlreadyProcessed = async () => false;
    plugin.cache.addToCache = async () => {
      unloadBatchCacheWrites += 1;
    };
    plugin.updateStatusBar = async () => {};
    plugin.runLimitedCompression = async () => {
      plugin.isUnloading = true;
      return { success: true, savings: 50 };
    };
    await plugin.processBatchCompression([createMockFile("Images/unload-batch.png", 100000, 1)], "Unload smoke");
    assert(unloadBatchCacheWrites === 0, "Batch compression wrote cache after plugin unload");
  } finally {
    plugin.runLimitedCompression = originalRunLimitedForUnload;
    plugin.cache.addToCache = originalAddToCacheForUnload;
    plugin.cache.isFileAlreadyProcessed = originalIsProcessedForUnload;
    plugin.updateStatusBar = originalUpdateStatusBarForUnload;
    plugin.isUnloading = false;
  }

  const originalEnsureWasmReadyForBatch = plugin.compressor.ensureWasmReady;
  const originalRunLimitedForInitFailure = plugin.runLimitedCompression;
  const originalCompressorCompressForInitFailure = plugin.compressor.compress;
  const originalHandleSkippedCompressionForInitFailure = plugin.handleSkippedCompression;
  const originalIsProcessedForInitFailure = plugin.cache.isFileAlreadyProcessed;
  try {
    let fatalInitCalls = 0;
    let compressionCallsBeforeInitFailure = 0;
    let initFailureCacheChecks = 0;
    plugin.compressor.compress = async () => ({
      success: false,
      error: "simulated wasm init failure",
      skipReason: "wasm_init_failed"
    });
    plugin.cache.isFileAlreadyProcessed = async () => {
      initFailureCacheChecks += 1;
      if (initFailureCacheChecks > 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return false;
    };
    plugin.runLimitedCompression = async (task) => {
      compressionCallsBeforeInitFailure += 1;
      return await task();
    };
    const initFailureResult = await plugin.runCompressionBatch([
      createMockFile("Images/init-a.png", 100000, 1),
      createMockFile("Images/init-b.png", 100000, 2),
      createMockFile("Images/init-c.png", 100000, 3),
      createMockFile("Images/init-d.png", 100000, 4)
    ], {
      onFatalError: async () => {
        fatalInitCalls += 1;
      }
    });
    assert(fatalInitCalls === 1, "WASM init failure was not reported exactly once for the batch");
    assert(compressionCallsBeforeInitFailure === 1, `Fatal init failure did not stop later compression attempts: ${compressionCallsBeforeInitFailure}`);
    assert(initFailureResult.processed === 0, "Batch compression advanced progress after WASM init failure");
    assert(initFailureResult.skippedErrors === 4, "Batch init failure did not account for all skipped errors");

    let ensureCallsForTooLarge = 0;
    let compressionCallsForTooLarge = 0;
    plugin.compressor.compress = originalCompressorCompressForInitFailure;
    plugin.compressor.ensureWasmReady = async () => {
      ensureCallsForTooLarge += 1;
      throw new Error("too-large file should not initialize wasm");
    };
    plugin.runLimitedCompression = async (task) => {
      compressionCallsForTooLarge += 1;
      return await task();
    };
    plugin.handleSkippedCompression = async () => {};
    const tooLargeResult = await plugin.runCompressionBatch([
      createMockFile("Images/init-too-large.png", plugin.compressor.maxInputBytes + 1, 3)
    ]);
    assert(compressionCallsForTooLarge === 1, "Too-large file did not exercise compressor preflight");
    assert(ensureCallsForTooLarge === 0, "Too-large batch item initialized WASM before compressor preflight skipped it");
    assert(tooLargeResult.skippedValidation === 1 && tooLargeResult.skippedErrors === 0, "Too-large batch item was not handled as validation skip");
  } finally {
    plugin.compressor.ensureWasmReady = originalEnsureWasmReadyForBatch;
    plugin.runLimitedCompression = originalRunLimitedForInitFailure;
    plugin.compressor.compress = originalCompressorCompressForInitFailure;
    plugin.handleSkippedCompression = originalHandleSkippedCompressionForInitFailure;
    plugin.cache.isFileAlreadyProcessed = originalIsProcessedForInitFailure;
  }

  const originalRunLimitedForProgress = plugin.runLimitedCompression;
  const originalCompressorCompressForProgress = plugin.compressor.compress;
  const originalIsProcessedForProgress = plugin.cache.isFileAlreadyProcessed;
  const originalAddToCacheForProgress = plugin.cache.addToCache;
  const originalUpdateImageIndexForProgress = plugin.updateImageIndexForFile;
  const originalStatusBarUpdateForProgress = plugin.statusBarController.update;
  const originalMaybeAutoMoveForProgress = plugin.maybeAutoMoveCompressed;
  try {
    plugin.cache.isFileAlreadyProcessed = async () => false;
    plugin.cache.addToCache = async () => {};
    plugin.updateImageIndexForFile = async () => {};
    plugin.statusBarController.update = async () => {};
    plugin.maybeAutoMoveCompressed = async () => {};
    plugin.runLimitedCompression = async (task) => task();
    plugin.compressor.compress = async (file) => {
      const delay = file.name.includes("slow") ? 40 : 0;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return { success: true, savings: 25 };
    };
    const progressUpdates = [];
    await plugin.runCompressionBatch([
      createMockFile("Images/slow-progress.jpg", 100000, 1),
      createMockFile("Images/fast-progress-a.jpg", 100000, 2),
      createMockFile("Images/fast-progress-b.jpg", 100000, 3)
    ], {
      onCompressed: async (_file, processed) => {
        progressUpdates.push(processed);
      },
      onCacheUpdated: async (_file, processed) => {
        progressUpdates.push(processed);
      }
    });
    assert(
      JSON.stringify(progressUpdates) === JSON.stringify([1, 1, 2, 2, 3, 3]),
      `Parallel batch progress was not completion-based and monotonic: ${progressUpdates.join(",")}`
    );

    global.__progressWidthUpdates = [];
    await plugin.processBatchCompression([
      createMockFile("Images/slow-modal-progress.jpg", 100000, 1),
      createMockFile("Images/fast-modal-progress-a.jpg", 100000, 2),
      createMockFile("Images/fast-modal-progress-b.jpg", 100000, 3)
    ], "Modal progress smoke");
    const modalWidthPercentages = global.__progressWidthUpdates
      .map((value) => Number.parseFloat(String(value)))
      .filter((value) => Number.isFinite(value));
    for (let index = 1; index < modalWidthPercentages.length; index++) {
      assert(
        modalWidthPercentages[index] >= modalWidthPercentages[index - 1],
        `Modal progress width moved backward under parallel compression: ${modalWidthPercentages.join(",")}`
      );
    }
    assert(
      modalWidthPercentages.length > 0 && modalWidthPercentages[modalWidthPercentages.length - 1] === 100,
      `Modal progress did not complete at 100%: ${modalWidthPercentages.join(",")}`
    );

    const cancellationController = new AbortController();
    let cancellationCompressionCalls = 0;
    let cancellationLimiterTail = Promise.resolve();
    plugin.runLimitedCompression = async (task) => {
      const previous = cancellationLimiterTail;
      let releaseCurrent = null;
      cancellationLimiterTail = new Promise((resolve) => {
        releaseCurrent = resolve;
      });
      await previous;
      try {
        return await task();
      } finally {
        releaseCurrent();
      }
    };
    plugin.compressor.compress = async () => {
      cancellationCompressionCalls += 1;
      cancellationController.abort();
      return { success: true, savings: 25 };
    };
    const cancellationResult = await plugin.runCompressionBatch([
      createMockFile("Images/cancel-a.jpg", 100000, 10),
      createMockFile("Images/cancel-b.jpg", 100000, 11),
      createMockFile("Images/cancel-c.jpg", 100000, 12),
      createMockFile("Images/cancel-d.jpg", 100000, 13)
    ], {
      signal: cancellationController.signal
    });
    assert(cancellationResult.cancelled === true, "Batch cancellation did not mark the result as cancelled");
    assert(cancellationCompressionCalls === 1, `Batch cancellation allowed ${cancellationCompressionCalls} compression calls`);
    assert(cancellationResult.compressed === 1, `Batch cancellation did not preserve the completed in-flight item: ${cancellationResult.compressed}`);
    assert(cancellationResult.processed === 1, `Batch cancellation advanced progress after cancellation: ${cancellationResult.processed}`);
    assert(cancellationResult.skippedErrors === 0, "Batch cancellation was counted as an error");
  } finally {
    delete global.__progressWidthUpdates;
    plugin.runLimitedCompression = originalRunLimitedForProgress;
    plugin.compressor.compress = originalCompressorCompressForProgress;
    plugin.cache.isFileAlreadyProcessed = originalIsProcessedForProgress;
    plugin.cache.addToCache = originalAddToCacheForProgress;
    plugin.updateImageIndexForFile = originalUpdateImageIndexForProgress;
    plugin.statusBarController.update = originalStatusBarUpdateForProgress;
    plugin.maybeAutoMoveCompressed = originalMaybeAutoMoveForProgress;
  }

  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  global.setTimeout = originalGlobals.setTimeout;
  global.clearTimeout = originalGlobals.clearTimeout;
  const wasmCompressionTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-wasm-"));
  const originalVaultReadBinary = plugin.app.vault.readBinary;
  const originalVaultBasePath = plugin.app.vault.adapter.basePath;
  const originalVaultAbsolutePath = plugin.app.vault.adapter.path.absolute;
  const originalWorkerFactory = plugin.compressor.workerFactory;
  const originalWorkerPool = plugin.compressor.workerPool;
  const originalActiveWorkerCount = plugin.compressor.activeWorkerCount;
  const originalProcessTimeoutMs = plugin.compressor.processTimeoutMs;
  const originalInitTimeoutMs = plugin.compressor.initTimeoutMs;
  const originalMaxInputBytes = plugin.compressor.maxInputBytes;
  const originalMaxImagePixels = plugin.compressor.maxImagePixels;
  const originalPngQuality = plugin.settings.pngQuality;
  const originalJpegQuality = plugin.settings.jpegQuality;
  const originalOutputFolder = plugin.settings.outputFolder;
  try {
    pointMockVaultAtPath(plugin.app, wasmCompressionTemp);
    plugin.settings.outputFolder = "Compressed";

    const previousBlob = global.Blob;
    const previousWorker = global.Worker;
    const previousCreateObjectURL = global.URL?.createObjectURL;
    const previousRevokeObjectURL = global.URL?.revokeObjectURL;
    try {
      const blobWorkerEvents = {
        blobParts: null,
        blobType: "",
        workerUrl: "",
        createdUrl: "",
        revokedUrl: ""
      };
      global.Blob = class {
        constructor(parts, options = {}) {
          blobWorkerEvents.blobParts = parts;
          blobWorkerEvents.blobType = options.type || "";
        }
      };
      global.URL.createObjectURL = (blob) => {
        assert(blob, "Blob worker smoke did not receive a Blob");
        blobWorkerEvents.createdUrl = "blob:local-image-compress-smoke";
        return blobWorkerEvents.createdUrl;
      };
      global.URL.revokeObjectURL = (url) => {
        blobWorkerEvents.revokedUrl = url;
      };
      global.Worker = class {
        constructor(url) {
          blobWorkerEvents.workerUrl = url;
          this.messages = [];
          this.terminateCalls = 0;
        }
        postMessage(message) {
          this.messages.push(message);
          if (message?.type === "init") {
            setImmediate(() => this.onmessage?.({ data: { id: message.id, type: "ready" } }));
          }
        }
        terminate() {
          this.terminateCalls += 1;
        }
      };
      await replaceCompressorWorkerPool(plugin, null, 1);
      await plugin.compressor.ensureWasmReady();
      assert(blobWorkerEvents.blobType === "text/javascript", "Blob worker smoke used the wrong MIME type");
      assert(Array.isArray(blobWorkerEvents.blobParts) && String(blobWorkerEvents.blobParts[0] || "").includes("onmessage"), "Blob worker smoke did not wrap the worker source in a Blob");
      assert(blobWorkerEvents.workerUrl === blobWorkerEvents.createdUrl, "Blob worker smoke did not construct Worker from the object URL");
      assert(blobWorkerEvents.revokedUrl === blobWorkerEvents.createdUrl, "Blob worker smoke did not revoke the object URL after initialization");
    } finally {
      if (previousBlob === undefined) {
        delete global.Blob;
      } else {
        global.Blob = previousBlob;
      }
      if (previousWorker === undefined) {
        delete global.Worker;
      } else {
        global.Worker = previousWorker;
      }
      if (previousCreateObjectURL === undefined) {
        delete global.URL.createObjectURL;
      } else {
        global.URL.createObjectURL = previousCreateObjectURL;
      }
      if (previousRevokeObjectURL === undefined) {
        delete global.URL.revokeObjectURL;
      } else {
        global.URL.revokeObjectURL = previousRevokeObjectURL;
      }
    }

    const initFailedWorkers = [];
    await replaceCompressorWorkerPool(plugin, createMockWorkerFactory([{ initError: "simulated init failure" }], initFailedWorkers), 1);
    let initFailed = false;
    try {
      await plugin.compressor.ensureWasmReady();
    } catch (error) {
      initFailed = String(error?.message || error).includes("simulated init failure");
    }
    assert(initFailed, "Worker init-failed smoke did not surface the init error");
    assert(initFailedWorkers[0].terminateCalls === 1, "Worker init-failed smoke did not terminate the failed worker");

    const initTimeoutWorkers = [];
    plugin.compressor.initTimeoutMs = 10;
    await replaceCompressorWorkerPool(plugin, createMockWorkerFactory([{ noInitResponse: true }], initTimeoutWorkers), 1);
    const initTimeoutStartedAt = Date.now();
    await plugin.compressor.ensureWasmReady();
    const initTimeoutElapsedMs = Date.now() - initTimeoutStartedAt;
    assert(initTimeoutElapsedMs < 500, `Worker init timeout took too long: ${initTimeoutElapsedMs}ms`);
    assert(initTimeoutWorkers[0].terminateCalls === 1, "Worker init timeout did not terminate the hung worker");
    assert(initTimeoutWorkers.length === 2, "Worker init timeout did not lazily recreate a replacement worker");
    assert(getCompressorSlots(plugin)[0].isReady(), "Worker init timeout replacement worker did not become ready");
    plugin.compressor.initTimeoutMs = originalInitTimeoutMs;

    const transferValidationWorkers = [];
    await resetCompressorWorker(plugin, createMockWorkerFactory([{
      compressResponses: [
        { output: createValidEncodedOutput("jpeg") }
      ]
    }], transferValidationWorkers));
    const transferSlot = getCompressorSlots(plugin)[0];
    const transferSource = Uint8Array.from([1, 2, 3, 4, 5, 6]);
    const transferView = transferSource.subarray(2, 5);
    await transferSlot.runCompression("jpeg", transferView, plugin.settings);
    const postedTransferMessage = transferValidationWorkers[0].messages.find((message) => message.type === "compress");
    assert(postedTransferMessage, "WorkerSlot did not post a compression message for typed-array input");
    const postedTransferList = transferValidationWorkers[0].transfers.find((transfer) => transfer[0] === postedTransferMessage.buffer);
    assert(postedTransferMessage.buffer instanceof ArrayBuffer, "WorkerSlot did not convert a typed-array view to ArrayBuffer before postMessage");
    assert(postedTransferMessage.buffer.byteLength === transferView.byteLength, "WorkerSlot transferred the typed-array backing buffer instead of the view range");
    assert(postedTransferMessage.buffer !== transferSource.buffer, "WorkerSlot reused the caller's typed-array backing buffer");
    assert(postedTransferList && postedTransferList.length === 1, "WorkerSlot did not transfer the normalized ArrayBuffer");
    for (const invalidInput of ["not-buffer", null, new ArrayBuffer(0)]) {
      let rejectedInvalidInput = false;
      try {
        await transferSlot.runCompression("png", invalidInput, plugin.settings);
      } catch (error) {
        rejectedInvalidInput = error instanceof TypeError && /Expected/.test(String(error.message));
      }
      assert(rejectedInvalidInput, `WorkerSlot accepted invalid compression buffer: ${invalidInput}`);
      assert(transferSlot.isBusy() === false, "WorkerSlot leaked reservation after invalid compression buffer");
    }
    if (typeof structuredClone === "function") {
      const detachedBuffer = new ArrayBuffer(8);
      structuredClone(detachedBuffer, { transfer: [detachedBuffer] });
      let rejectedDetachedBuffer = false;
      try {
        await transferSlot.runCompression("png", detachedBuffer, plugin.settings);
      } catch (error) {
        rejectedDetachedBuffer = error instanceof TypeError && /detached/.test(String(error.message));
      }
      assert(rejectedDetachedBuffer, "WorkerSlot accepted a detached compression buffer");
      assert(transferSlot.isBusy() === false, "WorkerSlot leaked reservation after detached compression buffer");
    }

    const compressionWorkers = [];
    await resetCompressorWorker(plugin, createMockWorkerFactory([{
      compressResponses: [
        { output: createValidEncodedOutput("jpeg") },
        { output: createValidEncodedOutput("png") },
        { error: { kind: "quality_failed", message: "QUALITY_TOO_LOW", skipReason: "pngquant_quality_failed" } },
        { output: createValidEncodedOutput("jpeg", 256) }
      ]
    }], compressionWorkers));
    assert(compressionWorkers.length === 1, "Worker smoke did not create an initial compression worker");
    assert(compressionWorkers[0].messages.some((message) => message.type === "init"), "Worker smoke did not send init message");
    const originalConsoleDebugForUnhandledWorkerMessage = console.debug;
    let unhandledWorkerMessageLog = null;
    try {
      console.debug = (...args) => {
        if (String(args[1] || "").includes("Unhandled worker message")) {
          unhandledWorkerMessageLog = args;
        }
      };
      getCompressorSlots(plugin)[0].handleWorkerMessage({ type: "compress-reply", id: 999 });
      assert(unhandledWorkerMessageLog, "WorkerSlot did not log an unhandled worker message");
      assert(unhandledWorkerMessageLog[2]?.type === "compress-reply", "Unhandled worker message log omitted the message type");
      assert(unhandledWorkerMessageLog[2]?.expecting?.init === null && unhandledWorkerMessageLog[2]?.expecting?.job === null, "Unhandled worker message log omitted expected ids");
    } finally {
      console.debug = originalConsoleDebugForUnhandledWorkerMessage;
    }

    const previousWindowExists = Object.prototype.hasOwnProperty.call(global, "window");
    const previousGlobalWindow = global.window;
    const previousActiveWindow = plugin.app.workspace.activeWindow;
    try {
      delete global.window;
      plugin.app.workspace.activeWindow = undefined;
      let fallbackTimerFired = false;
      await new Promise((resolve) => {
        getCompressorSlots(plugin)[0].setWorkerTimeout(() => {
          fallbackTimerFired = true;
          resolve();
        }, 0);
      });
      assert(fallbackTimerFired, "Worker timer fallback did not use globalThis when window was unavailable");
    } finally {
      if (previousWindowExists) {
        global.window = previousGlobalWindow;
      } else {
        delete global.window;
      }
      plugin.app.workspace.activeWindow = previousActiveWindow;
    }

    const fixtureCodecs = await getFixtureCodecs();
    const jpegInput = await fixtureCodecs.jpegEncode(createPatternImageData(96, 96, "gradient"), { quality: 95 });
    plugin.settings.jpegQuality = 35;
    const jpegFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/wasm-smoke.jpg", new Uint8Array(jpegInput), 100);
    const jpegResult = await plugin.compressor.compress(jpegFile, plugin.settings);
    const jpegOutputPath = path.join(wasmCompressionTemp, "Compressed", "Images", "wasm-smoke.jpg");
    assert(jpegResult.success === true, `JPEG WASM compression failed: ${jpegResult.error}`);
    assert(jpegResult.savings > 0, `JPEG WASM compression did not report savings: ${jpegResult.savings}`);
    assert(fs.statSync(jpegOutputPath).size < fs.statSync(path.join(wasmCompressionTemp, "Images", "wasm-smoke.jpg")).size, "JPEG WASM output is not smaller than original");

    const pngInput = Buffer.from(await fixtureCodecs.pngEncode(createPatternImageData(480, 320, "blocks")));
    plugin.settings.pngQuality = { min: 45, max: 70 };
    const pngFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/wasm-smoke.png", pngInput, 101);
    const pngResult = await plugin.compressor.compress(pngFile, plugin.settings);
    const pngOutputPath = path.join(wasmCompressionTemp, "Compressed", "Images", "wasm-smoke.png");
    assert(pngResult.success === true, `PNG WASM compression failed: ${pngResult.error}`);
    assert(pngResult.savings > 0, `PNG WASM compression did not report savings: ${pngResult.savings}`);
    assert(fs.statSync(pngOutputPath).size < fs.statSync(path.join(wasmCompressionTemp, "Images", "wasm-smoke.png")).size, "PNG WASM output is not smaller than original");

    const complexPng = await fixtureCodecs.pngEncode(createPatternImageData(256, 256, "gradient"));
    plugin.settings.pngQuality = { min: 99, max: 99 };
    const qualityFailFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/quality-fail.png", new Uint8Array(complexPng), 102);
    const qualityFailResult = await plugin.compressor.compress(qualityFailFile, plugin.settings);
    assert(qualityFailResult.success === false, "PNG quality-fail smoke unexpectedly succeeded");
    assert(qualityFailResult.skipReason === "pngquant_quality_failed", `PNG quality-fail smoke used wrong skipReason: ${qualityFailResult.skipReason}`);

    const notSmallerFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/not-smaller.jpg", Buffer.alloc(128, 1), 103);
    const notSmallerResult = await plugin.compressor.compress(notSmallerFile, plugin.settings);
    assert(notSmallerResult.success === false, "Not-smaller smoke unexpectedly succeeded");
    assert(notSmallerResult.skipReason === "compressed_not_smaller", `Not-smaller smoke used wrong skipReason: ${notSmallerResult.skipReason}`);

    const zeroWidthPngFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/zero-width.png", createZeroWidthPng(), 116);
    const zeroWidthPngResult = await plugin.compressor.compress(zeroWidthPngFile, plugin.settings);
    assert(zeroWidthPngResult.success === false, "Zero-width PNG smoke unexpectedly succeeded");
    assert(zeroWidthPngResult.skipReason === "invalid_image_dimensions", `Zero-width PNG smoke used wrong skipReason: ${zeroWidthPngResult.skipReason}`);

    let tooLargeReadCalls = 0;
    plugin.compressor.maxInputBytes = 64;
    plugin.app.vault.readBinary = async () => {
      tooLargeReadCalls += 1;
      throw new Error("too-large input should be skipped before readBinary");
    };
    const tooLargeFile = createMockFile("Images/too-large.png", 65, 104);
    tooLargeFile.vault = plugin.app.vault;
    const tooLargeResult = await plugin.compressor.compress(tooLargeFile, plugin.settings);
    assert(tooLargeResult.success === false, "Too-large smoke unexpectedly succeeded");
    assert(tooLargeResult.skipReason === "too_large", `Too-large smoke used wrong skipReason: ${tooLargeResult.skipReason}`);
    assert(tooLargeReadCalls === 0, "Too-large smoke still read file contents before skipping");

    plugin.app.vault.readBinary = originalVaultReadBinary;
    plugin.compressor.maxInputBytes = originalMaxInputBytes;
    plugin.compressor.maxImagePixels = originalMaxImagePixels;

    const originalEnsureWasmReadyForReadOrder = plugin.compressor.ensureWasmReady;
    const originalCompressBufferForReadOrder = plugin.compressor.compressBuffer;
    const originalWriteStagedOutputForReadOrder = plugin.compressor.writeStagedOutput;
    try {
      let releaseWasmReady = null;
      let readBeforeReadyCalls = 0;
      plugin.compressor.ensureWasmReady = async () => await new Promise((resolve) => {
        releaseWasmReady = resolve;
      });
      plugin.app.vault.readBinary = async () => {
        readBeforeReadyCalls += 1;
        return toArrayBuffer(new Uint8Array(jpegInput));
      };
      plugin.compressor.compressBuffer = async () => createValidEncodedOutput("jpeg");
      plugin.compressor.writeStagedOutput = async () => {};
      const readOrderFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/read-order.jpg", new Uint8Array(jpegInput), 130);
      const readOrderPromise = plugin.compressor.compress(readOrderFile, plugin.settings);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert(readBeforeReadyCalls === 0, "Compressor read file bytes before WASM readiness resolved");
      releaseWasmReady();
      const readOrderResult = await readOrderPromise;
      assert(readOrderResult.success === true, `Read-order smoke failed after WASM readiness: ${readOrderResult.error}`);
      assert(readBeforeReadyCalls === 1, "Compressor did not read file bytes after WASM readiness resolved");
    } finally {
      plugin.compressor.ensureWasmReady = originalEnsureWasmReadyForReadOrder;
      plugin.compressor.compressBuffer = originalCompressBufferForReadOrder;
      plugin.compressor.writeStagedOutput = originalWriteStagedOutputForReadOrder;
      plugin.app.vault.readBinary = originalVaultReadBinary;
    }

    const originalEnsureWasmReadyForReadTimeout = plugin.compressor.ensureWasmReady;
    try {
      plugin.compressor.processTimeoutMs = 10;
      plugin.compressor.ensureWasmReady = async () => {};
      plugin.app.vault.readBinary = async () => neverSettlingPromise();
      const readTimeoutFile = createMockFile("Images/read-timeout.jpg", 1000, 131);
      readTimeoutFile.vault = plugin.app.vault;
      const readTimeoutResult = await plugin.compressor.compress(readTimeoutFile, plugin.settings);
      assert(readTimeoutResult.success === false, "Read-timeout smoke unexpectedly succeeded");
      assert(String(readTimeoutResult.error || "").includes("File read timed out after 10ms"), `Read-timeout smoke returned wrong error: ${readTimeoutResult.error}`);
    } finally {
      plugin.compressor.processTimeoutMs = originalProcessTimeoutMs;
      plugin.compressor.ensureWasmReady = originalEnsureWasmReadyForReadTimeout;
      plugin.app.vault.readBinary = originalVaultReadBinary;
    }

    const originalEnsureWasmReadyForJpegFailure = plugin.compressor.ensureWasmReady;
    const originalCompressBufferForJpegFailure = plugin.compressor.compressBuffer;
    try {
      plugin.compressor.ensureWasmReady = async () => {};
      plugin.compressor.compressBuffer = async () => {
        throw new Error("mozjpeg encode failed");
      };
      const jpegFailureFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/jpeg-failure.jpg", new Uint8Array(jpegInput), 132);
      const jpegFailureResult = await plugin.compressor.compress(jpegFailureFile, plugin.settings);
      assert(jpegFailureResult.success === false, "JPEG encode failure smoke unexpectedly succeeded");
      assert(jpegFailureResult.skipReason === "mozjpeg_failed", `JPEG encode failure used wrong skipReason: ${jpegFailureResult.skipReason}`);
    } finally {
      plugin.compressor.ensureWasmReady = originalEnsureWasmReadyForJpegFailure;
      plugin.compressor.compressBuffer = originalCompressBufferForJpegFailure;
      plugin.app.vault.readBinary = originalVaultReadBinary;
    }

    const createdAdapterDirs = new Set();
    const duplicateMkdirAdapter = {
      exists: async (vaultPath) => createdAdapterDirs.has(vaultPath),
      mkdir: async (vaultPath) => {
        if (vaultPath === "Compressed/Images") {
          createdAdapterDirs.add(vaultPath);
          throw new Error("simulated duplicate mkdir race");
        }
        createdAdapterDirs.add(vaultPath);
      }
    };
    await plugin.compressor.ensureAdapterDirectory(duplicateMkdirAdapter, "Compressed/Images/race.png");
    assert(createdAdapterDirs.has("Compressed/Images"), "ensureAdapterDirectory() did not tolerate duplicate mkdir races");

    plugin.compressor.maxInputBytes = originalMaxInputBytes;
    plugin.app.vault.readBinary = originalVaultReadBinary;
    pointMockVaultAtPath(plugin.app, wasmCompressionTemp);

    for (const invalidCase of [
      { name: "empty", extension: "jpg", input: new Uint8Array(jpegInput), output: new Uint8Array(0).buffer, expected: "empty" },
      { name: "bad-magic", extension: "jpg", input: new Uint8Array(jpegInput), output: Uint8Array.from([0x00, 0x01, 0x02, 0x03]).buffer, expected: "JPEG bad-SOI" },
      { name: "missing-sos", extension: "jpg", input: new Uint8Array(jpegInput), output: createJpegWithoutSos(), expected: "JPEG missing-SOS" },
      { name: "png-missing-idat", extension: "png", input: pngInput, output: createPngWithoutIdat(), expected: "PNG missing-or-empty-IDAT" },
      { name: "png-truncated", extension: "png", input: pngInput, output: createTruncatedPngChunk(), expected: "PNG truncated-chunk" }
    ]) {
      const invalidWorkers = [];
      const originalWriteBinaryForInvalidOutput = plugin.app.vault.adapter.writeBinary;
      let invalidOutputWrites = 0;
      try {
        plugin.app.vault.adapter.writeBinary = async (...args) => {
          invalidOutputWrites += 1;
          return originalWriteBinaryForInvalidOutput(...args);
        };
        await resetCompressorWorker(plugin, createMockWorkerFactory([
          { compressResponses: [{ output: invalidCase.output }] }
        ], invalidWorkers));
        const invalidOutputFile = writeVaultBinary(plugin.app, wasmCompressionTemp, `Images/invalid-output-${invalidCase.name}.${invalidCase.extension}`, invalidCase.input, 120);
        const invalidOutputResult = await plugin.compressor.compress(invalidOutputFile, plugin.settings);
        const invalidOutputPath = path.join(wasmCompressionTemp, "Compressed", "Images", `invalid-output-${invalidCase.name}.${invalidCase.extension}`);
        assert(invalidOutputResult.success === false, `Invalid ${invalidCase.name} worker output unexpectedly succeeded`);
        assert(String(invalidOutputResult.error || "").includes(invalidCase.expected), `Invalid ${invalidCase.name} worker output returned wrong error: ${invalidOutputResult.error}`);
        assert(invalidOutputResult.skipReason === "corrupt_encoder_output", `Invalid ${invalidCase.name} worker output used wrong skipReason: ${invalidOutputResult.skipReason}`);
        assert(invalidOutputWrites === 0, `Invalid ${invalidCase.name} worker output wrote staged bytes`);
        assert(!fs.existsSync(invalidOutputPath), `Invalid ${invalidCase.name} worker output created a compressed file`);
      } finally {
        plugin.app.vault.adapter.writeBinary = originalWriteBinaryForInvalidOutput;
      }
    }

    const postFailureWorkers = [];
    await resetCompressorWorker(plugin, createMockWorkerFactory([
      { throwOnCompressPost: "simulated postMessage failure" }
    ], postFailureWorkers));
    plugin.compressor.processTimeoutMs = 1000;
    const postFailureFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/post-failure.jpg", new Uint8Array(jpegInput), 105);
    const postFailureStartedAt = Date.now();
    const postFailureResult = await plugin.compressor.compress(postFailureFile, plugin.settings);
    const postFailureElapsedMs = Date.now() - postFailureStartedAt;
    assert(postFailureResult.success === false, "Worker postMessage failure smoke unexpectedly succeeded");
    assert(String(postFailureResult.error || "").includes("simulated postMessage failure"), `Worker postMessage failure smoke returned wrong error: ${postFailureResult.error}`);
    assert(postFailureElapsedMs <= 500, `Worker postMessage failure waited for timeout: ${postFailureElapsedMs}ms`);
    assert(getCompressorSlots(plugin)[0].activeJob === null, "Worker postMessage failure left an active job behind");

    const timeoutWorkers = [];
    let timeoutCompressPosted = null;
    const timeoutCompressPostedPromise = new Promise((resolve) => {
      timeoutCompressPosted = resolve;
    });
    await resetCompressorWorker(plugin, createMockWorkerFactory([
      {
        noCompressResponse: true,
        onPostMessage: (message) => {
          if (message.type === "compress") {
            timeoutCompressPosted();
          }
        }
      },
      { compressResponses: [{ output: createValidEncodedOutput("jpeg") }] }
    ], timeoutWorkers));
    plugin.compressor.processTimeoutMs = 10;
    const timeoutFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/timeout.jpg", new Uint8Array(jpegInput), 106);
    const timeoutStartedAt = Date.now();
    const timeoutPromise = plugin.compressor.compress(timeoutFile, plugin.settings);
    await timeoutCompressPostedPromise;
    plugin.compressor.processTimeoutMs = 9999;
    const timeoutResult = await timeoutPromise;
    const timeoutElapsedMs = Date.now() - timeoutStartedAt;
    assert(timeoutResult.success === false, "Worker timeout smoke unexpectedly succeeded");
    assert(String(timeoutResult.error || "").includes("timed out"), `Worker timeout smoke did not return timeout error: ${timeoutResult.error}`);
    assert(String(timeoutResult.error || "").includes("10ms"), `Worker timeout smoke did not report the scheduled timeout: ${timeoutResult.error}`);
    assert(timeoutElapsedMs <= 1000, `Worker timeout smoke took too long: ${timeoutElapsedMs}ms`);
    assert(timeoutWorkers[0].terminateCalls === 1, "Worker timeout did not terminate the stuck worker");
    assert(getCompressorSlots(plugin)[0].worker === null, "Worker timeout kept a live worker before lazy recovery");
    assert(getCompressorSlots(plugin)[0].objectUrl === null, "Worker timeout left an object URL before lazy recovery");
    assert(getCompressorSlots(plugin)[0].needsRecreate === true, "Worker timeout did not mark lazy recreate pending");
    assert(getCompressorSlots(plugin)[0].wasmInitError === null, "Worker timeout left a stale init error before lazy recovery");
    assert(timeoutWorkers.length === 1, "Worker timeout eagerly recreated the worker");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert(getCompressorSlots(plugin)[0].worker === null, "Lazy idle timeout recovery created a worker while idle");
    assert(getCompressorSlots(plugin)[0].objectUrl === null, "Lazy idle timeout recovery left an object URL while idle");
    assert(timeoutWorkers.length === 1, "Lazy idle timeout recovery invoked the worker factory while idle");
    const timeoutRecoveryFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/timeout-recovery.jpg", new Uint8Array(jpegInput), 107);
    const timeoutRecoveryPromise = plugin.compressor.compress(timeoutRecoveryFile, plugin.settings);
    assert(timeoutWorkers.length === 2, "Lazy timeout recovery did not create a worker on demand");
    assert(getCompressorSlots(plugin)[0].worker === timeoutWorkers[1], "Lazy timeout recovery did not install the new worker");
    const timeoutRecoveryResult = await timeoutRecoveryPromise;
    assert(timeoutRecoveryResult.success === true, `Worker timeout recovery failed: ${timeoutRecoveryResult.error}`);
    assert(timeoutWorkers[1].messages.some((message) => message.type === "init"), "Recreated timeout worker did not receive init");

    const crashWorkers = [];
    await resetCompressorWorker(plugin, createMockWorkerFactory([
      { crashOnCompress: "simulated worker crash" },
      { compressResponses: [{ output: createValidEncodedOutput("jpeg") }] }
    ], crashWorkers));
    const crashFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/crash.jpg", new Uint8Array(jpegInput), 108);
    const crashResult = await plugin.compressor.compress(crashFile, plugin.settings);
    assert(crashResult.success === false, "Worker crash smoke unexpectedly succeeded");
    assert(String(crashResult.error || "").includes("Worker crashed"), `Worker crash smoke returned wrong error: ${crashResult.error}`);
    assert(crashWorkers[0].terminateCalls === 1, "Worker crash did not terminate the crashed worker");
    assert(getCompressorSlots(plugin)[0].worker === null, "Worker crash kept a live worker before lazy recovery");
    assert(getCompressorSlots(plugin)[0].needsRecreate === true, "Worker crash did not mark lazy recreate pending");
    assert(crashWorkers.length === 1, "Worker crash eagerly recreated the worker");
    const crashRecoveryFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/crash-recovery.jpg", new Uint8Array(jpegInput), 109);
    const crashRecoveryPromise = plugin.compressor.compress(crashRecoveryFile, plugin.settings);
    assert(crashWorkers.length === 2, "Lazy crash recovery did not create a worker on demand");
    const crashRecoveryResult = await crashRecoveryPromise;
    assert(crashRecoveryResult.success === true, `Worker crash recovery failed: ${crashRecoveryResult.error}`);

    const ensureReadyWorkers = [];
    let ensureReadyCompressPosted = null;
    const ensureReadyCompressPostedPromise = new Promise((resolve) => {
      ensureReadyCompressPosted = resolve;
    });
    await resetCompressorWorker(plugin, createMockWorkerFactory([
      {
        noCompressResponse: true,
        onPostMessage: (message) => {
          if (message.type === "compress") {
            ensureReadyCompressPosted();
          }
        }
      },
      {}
    ], ensureReadyWorkers));
    plugin.compressor.processTimeoutMs = 10;
    const ensureReadyTimeoutFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/ensure-ready-timeout.jpg", new Uint8Array(jpegInput), 110);
    const ensureReadyTimeoutPromise = plugin.compressor.compress(ensureReadyTimeoutFile, plugin.settings);
    await ensureReadyCompressPostedPromise;
    plugin.compressor.processTimeoutMs = 9999;
    const ensureReadyTimeoutResult = await ensureReadyTimeoutPromise;
    assert(ensureReadyTimeoutResult.success === false, "Parallel ensureWasmReady timeout unexpectedly succeeded");
    assert(ensureReadyWorkers.length === 1, "Parallel ensureWasmReady setup eagerly recreated the worker");
    const ensureReadyOnce = plugin.compressor.ensureWasmReady();
    const ensureReadyTwice = plugin.compressor.ensureWasmReady();
    assert(ensureReadyWorkers.length === 2, "Parallel ensureWasmReady did not create the lazy worker");
    await Promise.all([ensureReadyOnce, ensureReadyTwice]);
    assert(ensureReadyWorkers.length === 2, "Parallel ensureWasmReady created more than one lazy worker");
    assert(getCompressorSlots(plugin)[0].needsRecreate === false, "Parallel ensureWasmReady left lazy recreate pending");

    const idleDestroyWorkers = [];
    let idleDestroyCompressPosted = null;
    const idleDestroyCompressPostedPromise = new Promise((resolve) => {
      idleDestroyCompressPosted = resolve;
    });
    await resetCompressorWorker(plugin, createMockWorkerFactory([
      {
        noCompressResponse: true,
        onPostMessage: (message) => {
          if (message.type === "compress") {
            idleDestroyCompressPosted();
          }
        }
      },
      { compressResponses: [{ output: createValidEncodedOutput("jpeg") }] }
    ], idleDestroyWorkers));
    plugin.compressor.processTimeoutMs = 10;
    const idleDestroyTimeoutFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/idle-destroy-timeout.jpg", new Uint8Array(jpegInput), 111);
    const idleDestroyTimeoutPromise = plugin.compressor.compress(idleDestroyTimeoutFile, plugin.settings);
    await idleDestroyCompressPostedPromise;
    plugin.compressor.processTimeoutMs = 9999;
    const idleDestroyTimeoutResult = await idleDestroyTimeoutPromise;
    assert(idleDestroyTimeoutResult.success === false, "Lazy idle destroy timeout unexpectedly succeeded");
    assert(getCompressorSlots(plugin)[0].worker === null, "Lazy idle destroy setup kept a live worker");
    assert(idleDestroyWorkers.length === 1, "Lazy idle destroy setup eagerly recreated the worker");
    plugin.compressor.destroy();
    assert(getCompressorSlots(plugin)[0].worker === null, "Destroy during lazy idle left a worker behind");
    assert(idleDestroyWorkers.length === 1, "Destroy during lazy idle created a worker");
    assert(idleDestroyWorkers[0].terminateCalls === 1, "Destroy during lazy idle re-terminated the already stopped worker");
    const idleDestroyAfterFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/idle-destroy-after.jpg", new Uint8Array(jpegInput), 112);
    const idleDestroyAfterResult = await plugin.compressor.compress(idleDestroyAfterFile, plugin.settings);
    assert(idleDestroyAfterResult.success === false, "Compress after lazy idle destroy unexpectedly succeeded");
    assert(String(idleDestroyAfterResult.error || "").includes("plugin was unloaded"), `Compress after lazy idle destroy returned wrong error: ${idleDestroyAfterResult.error}`);
    await replaceCompressorWorkerPool(plugin, createMockWorkerFactory([{ compressResponses: [{ output: createValidEncodedOutput("jpeg") }] }]), 1);

    const destroyWorkers = [];
    await resetCompressorWorker(plugin, createMockWorkerFactory([{ noCompressResponse: true }], destroyWorkers));
    const destroyFile = writeVaultBinary(plugin.app, wasmCompressionTemp, "Images/destroy.jpg", new Uint8Array(jpegInput), 113);
    const destroyPromise = plugin.compressor.compress(destroyFile, plugin.settings);
    await new Promise((resolve) => setTimeout(resolve, 0));
    plugin.compressor.destroy();
    const destroyResult = await destroyPromise;
    assert(destroyResult.success === false, "Worker destroy smoke unexpectedly succeeded");
    assert(String(destroyResult.error || "").includes("plugin was unloaded"), `Worker destroy smoke returned wrong error: ${destroyResult.error}`);
    assert(destroyWorkers[0].terminateCalls === 1, "Compressor.destroy() did not terminate the active worker");

    const staggeredInitWorkers = [];
    await replaceCompressorWorkerPool(plugin, createMockWorkerFactory([
      { initDelayMs: 25 },
      { initDelayMs: 25 },
      { initDelayMs: 25 },
      { initDelayMs: 25 }
    ], staggeredInitWorkers), 4);
    const staggeredReadyPromise = plugin.compressor.ensureWasmReady();
    assert(staggeredInitWorkers.length === 1, `Worker pool did not start with a single eager slot: ${staggeredInitWorkers.length}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert(staggeredInitWorkers.length === 1, `Worker pool initialized extra slots before the first slot settled: ${staggeredInitWorkers.length}`);
    await staggeredReadyPromise;
    for (let attempt = 0; attempt < 30 && staggeredInitWorkers.length < 4; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert(staggeredInitWorkers.length === 4, `Worker pool did not finish staggered slot init: ${staggeredInitWorkers.length}`);

    const parallelWorkers = [];
    const parallelDispatchTimes = [];
    await resetCompressorPool(plugin, createMockWorkerFactory([
      { compressDelayMs: 50, onPostMessage: (message) => { if (message.type === "compress") parallelDispatchTimes.push(Date.now()); } },
      { compressDelayMs: 50, onPostMessage: (message) => { if (message.type === "compress") parallelDispatchTimes.push(Date.now()); } },
      { compressDelayMs: 50, onPostMessage: (message) => { if (message.type === "compress") parallelDispatchTimes.push(Date.now()); } },
      { compressDelayMs: 50, onPostMessage: (message) => { if (message.type === "compress") parallelDispatchTimes.push(Date.now()); } }
    ], parallelWorkers), 4);
    assert(await waitForReadySlots(plugin, 4) === 4, "Parallel pool setup did not warm all slots");
    const parallelStartedAt = Date.now();
    const parallelResults = await Promise.all([10, 11, 12, 13].map((size) =>
      plugin.compressor.compressBuffer(new Uint8Array(size).buffer, ".jpg", plugin.settings)
    ));
    const parallelElapsedMs = Date.now() - parallelStartedAt;
    assert(parallelResults.length === 4 && parallelResults.every((output) => output.byteLength === 64), "Parallel pool dispatch did not complete all jobs");
    assert(parallelDispatchTimes.length === 4, `Parallel pool did not dispatch all jobs immediately: ${parallelDispatchTimes.length}`);
    assert(Math.max(...parallelDispatchTimes) - Math.min(...parallelDispatchTimes) <= 35, "Parallel pool dispatch was not simultaneous enough");
    assert(parallelElapsedMs < 170, `Parallel pool wall-clock looked serial: ${parallelElapsedMs}ms`);

    const backpressureWorkers = [];
    const backpressureOrder = [];
    await resetCompressorPool(plugin, createMockWorkerFactory([
      {
        compressDelayMs: 20,
        onPostMessage: (message) => { if (message.type === "compress") backpressureOrder.push(message.buffer.byteLength); },
        compressResponses: [{}, {}, {}]
      },
      {
        compressDelayMs: 20,
        onPostMessage: (message) => { if (message.type === "compress") backpressureOrder.push(message.buffer.byteLength); },
        compressResponses: [{}, {}]
      }
    ], backpressureWorkers), 2);
    assert(await waitForReadySlots(plugin, 2) === 2, "Backpressure pool setup did not warm all slots");
    const backpressurePromises = [20, 21, 22, 23, 24].map((size) =>
      plugin.compressor.compressBuffer(new Uint8Array(size).buffer, ".jpg", plugin.settings)
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert(JSON.stringify(backpressureOrder) === JSON.stringify([20, 21]), `Backpressure did not dispatch the first two jobs immediately: ${backpressureOrder.join(",")}`);
    await Promise.all(backpressurePromises);
    assert(JSON.stringify(backpressureOrder) === JSON.stringify([20, 21, 22, 23, 24]), `Backpressure queue did not drain FIFO: ${backpressureOrder.join(",")}`);

    const waiterCapWorkers = [];
    let waiterCapJobPosted = null;
    const waiterCapJobPostedPromise = new Promise((resolve) => {
      waiterCapJobPosted = resolve;
    });
    await resetCompressorPool(plugin, createMockWorkerFactory([
      {
        noCompressResponse: true,
        onPostMessage: (message) => {
          if (message.type === "compress") {
            waiterCapJobPosted();
          }
        }
      }
    ], waiterCapWorkers), 1);
    plugin.compressor.workerPool.MAX_WAITERS = 2;
    const waiterCapActive = plugin.compressor.compressBuffer(new Uint8Array(25).buffer, ".jpg", plugin.settings).catch((error) => error);
    await waiterCapJobPostedPromise;
    const waiterCapQueuedA = plugin.compressor.compressBuffer(new Uint8Array(26).buffer, ".jpg", plugin.settings).catch((error) => error);
    const waiterCapQueuedB = plugin.compressor.compressBuffer(new Uint8Array(27).buffer, ".jpg", plugin.settings).catch((error) => error);
    await Promise.resolve();
    assert(plugin.compressor.workerPool.waiters.length === 2, `WorkerPool waiter cap setup queued ${plugin.compressor.workerPool.waiters.length} jobs instead of 2`);
    const waiterCapOverflow = await plugin.compressor.compressBuffer(new Uint8Array(28).buffer, ".jpg", plugin.settings).catch((error) => error);
    assert(String(waiterCapOverflow?.message || waiterCapOverflow).includes("waiters queue full"), `WorkerPool waiter overflow returned wrong error: ${waiterCapOverflow}`);
    plugin.compressor.destroy();
    await Promise.all([waiterCapActive, waiterCapQueuedA, waiterCapQueuedB]);

    const timeoutPoolWorkers = [];
    await resetCompressorPool(plugin, createMockWorkerFactory([
      { noCompressResponse: true },
      { compressResponses: [{ output: createValidEncodedOutput("jpeg") }] },
      { compressResponses: [{ output: createValidEncodedOutput("jpeg") }] },
      { compressResponses: [{ output: createValidEncodedOutput("jpeg") }] }
    ], timeoutPoolWorkers), 3);
    assert(await waitForReadySlots(plugin, 3) === 3, "Timeout pool setup did not warm all slots");
    plugin.compressor.processTimeoutMs = 10;
    const timeoutPoolResults = await Promise.allSettled([30, 31, 32].map((size) =>
      plugin.compressor.compressBuffer(new Uint8Array(size).buffer, ".jpg", plugin.settings)
    ));
    assert(timeoutPoolResults[0].status === "rejected" && String(timeoutPoolResults[0].reason?.message || timeoutPoolResults[0].reason).includes("timed out"), "Pool timeout did not reject only the timed-out job");
    assert(timeoutPoolResults[1].status === "fulfilled" && timeoutPoolResults[2].status === "fulfilled", "Pool timeout affected healthy slots");
    assert(timeoutPoolWorkers[0].terminateCalls === 1, "Pool timeout did not terminate the timed-out slot");
    assert(timeoutPoolWorkers[1].terminateCalls === 0 && timeoutPoolWorkers[2].terminateCalls === 0, "Pool timeout terminated healthy slots");
    assert(timeoutPoolWorkers.length === 3, "Pool timeout eagerly recreated the failed slot");
    plugin.compressor.processTimeoutMs = 9999;
    await plugin.compressor.compressBuffer(new Uint8Array(33).buffer, ".jpg", plugin.settings);
    assert(timeoutPoolWorkers.length === 3, "Pool timeout recreated a failed slot while a ready slot was idle");
    assert(getCompressorSlots(plugin)[0].needsRecreate === true, "Pool timeout cleared lazy recreate before the failed slot was used again");

    const readyPriorityWorkers = [];
    const readyPriorityDispatches = [];
    await resetCompressorPool(plugin, createMockWorkerFactory([
      { noCompressResponse: true },
      {
        compressResponses: [
          { output: createValidEncodedOutput("jpeg") },
          { output: createValidEncodedOutput("jpeg") }
        ],
        onPostMessage: (message) => {
          if (message.type === "compress") readyPriorityDispatches.push(message.buffer.byteLength);
        }
      },
      { compressResponses: [{ output: createValidEncodedOutput("jpeg") }] }
    ], readyPriorityWorkers), 2);
    assert(await waitForReadySlots(plugin, 2) === 2, "Ready-slot priority setup did not warm all slots");
    plugin.compressor.processTimeoutMs = 10;
    const readyPriorityResults = await Promise.allSettled([70, 71].map((size) =>
      plugin.compressor.compressBuffer(new Uint8Array(size).buffer, ".jpg", plugin.settings)
    ));
    assert(readyPriorityResults[0].status === "rejected" && readyPriorityResults[1].status === "fulfilled", "Ready-slot priority setup did not leave one failed and one ready slot");
    assert(readyPriorityWorkers.length === 2, "Ready-slot priority setup recreated the failed slot too early");
    assert(getCompressorSlots(plugin)[0].needsRecreate === true, "Ready-slot priority setup did not mark the failed slot for lazy recreate");
    plugin.compressor.processTimeoutMs = 9999;
    const readyPriorityOutput = await plugin.compressor.compressBuffer(new Uint8Array(72).buffer, ".jpg", plugin.settings);
    assert(readyPriorityOutput.byteLength === 32, "Ready-slot priority recovery job did not complete");
    assert(readyPriorityWorkers.length === 2, "Worker pool did not prefer an already-ready slot over lazy recreate");
    assert(JSON.stringify(readyPriorityDispatches) === JSON.stringify([71, 72]), `Ready-slot priority dispatched to the wrong worker: ${readyPriorityDispatches.join(",")}`);

    const crashPoolWorkers = [];
    await resetCompressorPool(plugin, createMockWorkerFactory([
      { crashOnCompress: "pool slot crash" },
      { compressResponses: [{ output: createValidEncodedOutput("jpeg") }] },
      { compressResponses: [{ output: createValidEncodedOutput("jpeg") }] },
      { compressResponses: [{ output: createValidEncodedOutput("jpeg") }] }
    ], crashPoolWorkers), 3);
    assert(await waitForReadySlots(plugin, 3) === 3, "Crash pool setup did not warm all slots");
    const crashPoolResults = await Promise.allSettled([40, 41, 42].map((size) =>
      plugin.compressor.compressBuffer(new Uint8Array(size).buffer, ".jpg", plugin.settings)
    ));
    assert(crashPoolResults[0].status === "rejected" && String(crashPoolResults[0].reason?.message || crashPoolResults[0].reason).includes("Worker crashed"), "Pool crash did not reject only the crashed job");
    assert(crashPoolResults[1].status === "fulfilled" && crashPoolResults[2].status === "fulfilled", "Pool crash affected healthy slots");
    assert(crashPoolWorkers[0].terminateCalls === 1, "Pool crash did not terminate the crashed slot");
    assert(crashPoolWorkers[1].terminateCalls === 0 && crashPoolWorkers[2].terminateCalls === 0, "Pool crash terminated healthy slots");
    await plugin.compressor.compressBuffer(new Uint8Array(43).buffer, ".jpg", plugin.settings);
    assert(crashPoolWorkers.length === 3, "Pool crash recreated a failed slot while a ready slot was idle");
    assert(getCompressorSlots(plugin)[0].needsRecreate === true, "Pool crash cleared lazy recreate before the failed slot was used again");

    const allInitFailureWorkers = [];
    await replaceCompressorWorkerPool(plugin, createMockWorkerFactory([
      { initError: "slot 1 init failed" },
      { initError: "slot 2 init failed" },
      { initError: "slot 3 init failed" }
    ], allInitFailureWorkers), 3);
    const allInitFailureFile = createMockFile("Images/all-init-failed.jpg", 100000, 114);
    allInitFailureFile.vault = plugin.app.vault;
    const allInitFailureResult = await plugin.compressor.compress(allInitFailureFile, plugin.settings);
    assert(allInitFailureResult.success === false, "All-slots init failure unexpectedly allowed compression");
    assert(String(allInitFailureResult.error || "").includes("init failed"), `All-slots init failure returned wrong error: ${allInitFailureResult.error}`);
    assert(allInitFailureWorkers.every((worker) => worker.terminateCalls === 1), "All-slots init failure did not terminate failed workers");

    const partialInitWorkers = [];
    await resetCompressorPool(plugin, createMockWorkerFactory([
      { initError: "partial slot 1 failed" },
      { initError: "partial slot 2 failed" },
      { compressResponses: [{ output: createValidEncodedOutput("jpeg") }] },
      { compressResponses: [{ output: createValidEncodedOutput("jpeg") }] },
      { compressResponses: [{ output: createValidEncodedOutput("jpeg") }] },
      { compressResponses: [{ output: createValidEncodedOutput("jpeg") }] }
    ], partialInitWorkers), 4);
    assert(plugin.compressor.checkBinaries().pngquant === true, "Partial init success did not mark pool usable");
    assert(await waitForReadySlots(plugin, 2) >= 2, "Partial init priority test did not get two ready slots");
    const partialInitWorkersBeforeJobs = partialInitWorkers.length;
    const [partialA, partialB] = await Promise.all([
      plugin.compressor.compressBuffer(new Uint8Array(50).buffer, ".jpg", plugin.settings),
      plugin.compressor.compressBuffer(new Uint8Array(51).buffer, ".jpg", plugin.settings)
    ]);
    assert(partialA.byteLength === 32 && partialB.byteLength === 32, "Partial init success did not run jobs on healthy slots");
    assert(partialInitWorkers.length === partialInitWorkersBeforeJobs, "Partial init success retried failed slots while ready slots were idle");

    const destroyPoolWorkers = [];
    await resetCompressorPool(plugin, createMockWorkerFactory([
      { noCompressResponse: true },
      { noCompressResponse: true },
      { noCompressResponse: true }
    ], destroyPoolWorkers), 3);
    assert(await waitForReadySlots(plugin, 3) === 3, "Destroy pool setup did not warm all slots");
    const destroyPoolPromises = [60, 61, 62, 63, 64, 65].map((size) =>
      plugin.compressor.compressBuffer(new Uint8Array(size).buffer, ".jpg", plugin.settings)
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    plugin.compressor.destroy();
    const destroyPoolResults = await Promise.allSettled(destroyPoolPromises);
    assert(destroyPoolResults.every((result) => result.status === "rejected"), "Destroy mid-batch did not reject every active and queued pool job");
    assert(destroyPoolWorkers.every((worker) => worker.terminateCalls === 1), "Destroy mid-batch did not terminate every pool worker");
    const afterDestroyFile = createMockFile("Images/after-pool-destroy.jpg", 100000, 115);
    afterDestroyFile.vault = plugin.app.vault;
    const afterDestroyResult = await plugin.compressor.compress(afterDestroyFile, plugin.settings);
    assert(afterDestroyResult.success === false && String(afterDestroyResult.error || "").includes("plugin was unloaded"), "Compress after pool destroy did not return sticky destroy error");
  } finally {
    try {
      plugin.compressor.workerPool?.destroy?.(new Error("smoke cleanup"));
    } catch (_) {
    }
    plugin.compressor.workerFactory = originalWorkerFactory;
    plugin.compressor.workerPool = originalWorkerPool;
    plugin.compressor.activeWorkerCount = originalActiveWorkerCount;
    plugin.compressor.processTimeoutMs = originalProcessTimeoutMs;
    plugin.compressor.initTimeoutMs = originalInitTimeoutMs;
    plugin.compressor.maxInputBytes = originalMaxInputBytes;
    plugin.settings.pngQuality = originalPngQuality;
    plugin.settings.jpegQuality = originalJpegQuality;
    plugin.settings.outputFolder = originalOutputFolder;
    plugin.app.vault.readBinary = originalVaultReadBinary;
    plugin.app.vault.adapter.basePath = originalVaultBasePath;
    plugin.app.vault.adapter.path.absolute = originalVaultAbsolutePath;
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
    fs.rmSync(wasmCompressionTemp, { recursive: true, force: true });
  }

  const originalCachedRead = plugin.app.vault.cachedRead;
  await setMockFiles(plugin, [
    createMockFile("Images/a.png", 100000),
    createMockFile("Images/b.jpg", 100000),
    createMockFile("Images/space image.jpeg", 100000),
    createMockFile("Images/with(foo).png", 100000),
    createMockFile("Images/pipe|name.png", 100000),
    createMockFile("Images/code-block.png", 100000),
    createMockFile("Other/b.jpg", 100000),
    createMockFile("Images/ignored.gif", 100000)
  ]);
  plugin.app.vault.cachedRead = async () => [
    "![[Images/a.png|400]]",
    "![[Images/pipe\\|name.png|400]]",
    "![markdown jpg](Images/b.jpg)",
    "![markdown space](Images/space image.jpeg)",
    "![markdown paren](Images/with(foo).png)",
    "![ambiguous basename](b.jpg)",
    "![remote](https://example.com/remote.png)",
    "```",
    "![[Images/code-block.png]]",
    "![code markdown](Images/code-block.png)",
    "```",
    "`![[Images/code-block.png]]`",
    "![[Images/ignored.gif]]",
    "![[Images/a.png]]"
  ].join("\n");
  const noteImages = await plugin.imageScanner.getImagesInNote(createMockFile("Notes/note.md", 1000));
  const noteImagePaths = noteImages.map((file) => file.path).sort();
  assert(
    JSON.stringify(noteImagePaths) === JSON.stringify(["Images/a.png", "Images/b.jpg", "Images/pipe|name.png", "Images/space image.jpeg", "Images/with(foo).png"]),
    `getImagesInNote() did not resolve markdown/wiki image embeds correctly: ${noteImagePaths.join(", ")}`
  );
  assert(!noteImagePaths.includes("Other/b.jpg"), "getImagesInNote() chose an arbitrary duplicate basename image");
  assert(!noteImagePaths.includes("Images/code-block.png"), "getImagesInNote() extracted image embeds from markdown code blocks");
  const cachedLookupA = plugin.imageScanner.buildImageLookup(plugin.app._files);
  const cachedLookupB = plugin.imageScanner.buildImageLookup(plugin.app._files);
  assert(cachedLookupA === cachedLookupB, "ImageScanner did not reuse the cached image lookup for the same file list");
  plugin.imageScanner.invalidateImageLookupCache();
  const cachedLookupC = plugin.imageScanner.buildImageLookup(plugin.app._files);
  assert(cachedLookupC !== cachedLookupA, "ImageScanner did not invalidate the cached image lookup");
  await setMockFiles(plugin, [
    createMockFile("Notes/Sub/local.png", 100000),
    createMockFile("Notes/Images/parent.png", 100000),
    createMockFile("Images/root.png", 100000),
    createMockFile("Other/local.png", 100000)
  ]);
  plugin.app.vault.cachedRead = async () => [
    "![same-folder](local.png)",
    "![parent](../Images/parent.png)",
    "![root](../../Images/root.png)"
  ].join("\n");
  const relativeNoteImages = await plugin.imageScanner.getImagesInNote(createMockFile("Notes/Sub/note.md", 1000));
  const relativeNotePaths = relativeNoteImages.map((file) => file.path).sort();
  assert(
    JSON.stringify(relativeNotePaths) === JSON.stringify(["Images/root.png", "Notes/Images/parent.png", "Notes/Sub/local.png"]),
    `getImagesInNote() did not resolve note-relative markdown links: ${relativeNotePaths.join(", ")}`
  );
  const pathologicalMarkdown = `![](${"(".repeat(10000)}Images/a.png${")".repeat(10000)})`;
  const markdownParseStart = Date.now();
  const pathologicalTargets = plugin.imageScanner.extractMarkdownImageTargets(pathologicalMarkdown);
  const markdownParseElapsed = Date.now() - markdownParseStart;
  assert(pathologicalTargets.length === 0, "Pathological markdown image target was accepted instead of aborted");
  assert(markdownParseElapsed < 500, `Pathological markdown image target parsing was too slow: ${markdownParseElapsed}ms`);
  const overlongMarkdownTarget = plugin.imageScanner.extractMarkdownImageTargets(`![](${"a".repeat(5000)}.png)`);
  assert(overlongMarkdownTarget.length === 0, "Overlong markdown image target was accepted instead of capped");
  plugin.app.vault.cachedRead = originalCachedRead;

  const originalFsStatSyncForI18n = fs.statSync;
  let i18nStatCalls = 0;
  try {
    fs.statSync = function patchedStatSync(filePath, ...args) {
      if (String(filePath).includes(`${path.sep}lang${path.sep}`)) {
        i18nStatCalls += 1;
      }
      return originalFsStatSyncForI18n.call(this, filePath, ...args);
    };
    plugin.registerCommands();
    const statCallsAfterFirstRegister = i18nStatCalls;
    plugin.registerCommands();
    assert(i18nStatCalls === statCallsAfterFirstRegister, "i18n language cache repeated statSync calls within the TTL window");
  } finally {
    fs.statSync = originalFsStatSyncForI18n;
  }

  const settingsTab = plugin.settingTabs[0];
  const originalGetStatsSnapshot = plugin.getStatsSnapshot;
  let displayFailedAsExpected = false;
  try {
    plugin.getStatsSnapshot = async () => {
      throw new Error("simulated stats failure");
    };
    await settingsTab.renderSettings();
  } catch (_) {
    displayFailedAsExpected = true;
  } finally {
    plugin.getStatsSnapshot = originalGetStatsSnapshot;
  }
  assert(displayFailedAsExpected, "SettingsTab.renderSettings() did not surface the simulated stats failure");
  assert(settingsTab._isRendering === false, "SettingsTab.renderSettings() left its rendering state active after a failed await");

  const originalSettingsTabRenderForRerender = settingsTab.renderSettings;
  const originalSettingsTabRaf = settingsTab.requestWindowAnimationFrame;
  const originalConsoleErrorForRerender = console.error;
  const rerenderCallbacks = [];
  let rerenderErrorsLogged = 0;
  try {
    settingsTab.containerEl.scrollTop = 42;
    settingsTab.requestWindowAnimationFrame = (callback) => {
      rerenderCallbacks.push(callback);
      return rerenderCallbacks.length;
    };
    settingsTab.renderSettings = async () => {
      throw new Error("simulated rerender failure");
    };
    console.error = () => {
      rerenderErrorsLogged += 1;
    };
    settingsTab.rerenderPreservingScroll();
    rerenderCallbacks[0]();
    await Promise.resolve();
    await Promise.resolve();
    assert(rerenderErrorsLogged >= 1, "rerenderPreservingScroll() did not log renderSettings() rejection");
    assert(rerenderCallbacks.length >= 2, "rerenderPreservingScroll() did not schedule restore after renderSettings() rejection");
  } finally {
    settingsTab.renderSettings = originalSettingsTabRenderForRerender;
    settingsTab.requestWindowAnimationFrame = originalSettingsTabRaf;
    console.error = originalConsoleErrorForRerender;
  }

  const originalSettingsTabRenderForFocus = settingsTab.renderSettings;
  const originalSettingsTabRafForFocus = settingsTab.requestWindowAnimationFrame;
  const originalSettingsTabGetActiveDocumentForFocus = settingsTab.getActiveDocument;
  const focusCallbacks = [];
  let focusRestoredForNonHtmlElement = false;
  try {
    settingsTab.containerEl.scrollTop = 84;
    settingsTab.getActiveDocument = () => ({
      activeElement: {
        focus() {
          focusRestoredForNonHtmlElement = true;
        }
      }
    });
    settingsTab.requestWindowAnimationFrame = (callback) => {
      focusCallbacks.push(callback);
      return focusCallbacks.length;
    };
    settingsTab.renderSettings = async () => {};
    settingsTab.rerenderPreservingScroll();
    focusCallbacks[0]();
    await Promise.resolve();
    focusCallbacks[1]();
    assert(focusRestoredForNonHtmlElement, "rerenderPreservingScroll() did not restore focus for non-HTMLElement focusable active elements");
  } finally {
    settingsTab.renderSettings = originalSettingsTabRenderForFocus;
    settingsTab.requestWindowAnimationFrame = originalSettingsTabRafForFocus;
    settingsTab.getActiveDocument = originalSettingsTabGetActiveDocumentForFocus;
  }

  const originalSettingsTabSetTimeout = settingsTab.setWindowTimeout;
  const originalSettingsTabClearTimeout = settingsTab.clearWindowTimeout;
  const originalPluginSaveSettingsForDebounce = plugin.saveSettings;
  const settingsSaveTimers = [];
  let debouncedSaveCalls = 0;
  try {
    settingsTab.setWindowTimeout = (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      settingsSaveTimers.push(timer);
      return timer;
    };
    settingsTab.clearWindowTimeout = (timer) => {
      if (timer) {
        timer.cleared = true;
      }
    };
    plugin.saveSettings = async () => {
      debouncedSaveCalls += 1;
    };
    settingsTab.debouncedSaveSettings();
    settingsTab.debouncedSaveSettings();
    settingsTab.debouncedSaveSettings();
    assert(settingsSaveTimers.length === 3, `Debounced settings save expected 3 scheduled timers, got ${settingsSaveTimers.length}`);
    assert(settingsSaveTimers[0].cleared && settingsSaveTimers[1].cleared, "Debounced settings save did not clear previous timers");
    settingsSaveTimers[2].callback();
    await Promise.resolve();
    assert(debouncedSaveCalls === 1, `Debounced settings save wrote ${debouncedSaveCalls} times instead of once`);
  } finally {
    settingsTab.setWindowTimeout = originalSettingsTabSetTimeout;
    settingsTab.clearWindowTimeout = originalSettingsTabClearTimeout;
    plugin.saveSettings = originalPluginSaveSettingsForDebounce;
    settingsTab.saveSettingsDebounceTimer = null;
  }

  const ObsidianMockForRestartNotice = require("obsidian");
  const originalNoticeForRestartNotice = ObsidianMockForRestartNotice.Notice;
  const restartNoticeTimers = [];
  const restartNoticeMessages = [];
  try {
    settingsTab.setWindowTimeout = (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      restartNoticeTimers.push(timer);
      return timer;
    };
    settingsTab.clearWindowTimeout = (timer) => {
      if (timer) {
        timer.cleared = true;
      }
    };
    ObsidianMockForRestartNotice.Notice = class {
      constructor(message) {
        restartNoticeMessages.push(String(message));
      }
    };
    settingsTab.debouncedWorkerPoolRestartNotice();
    settingsTab.debouncedWorkerPoolRestartNotice();
    assert(restartNoticeTimers.length === 2 && restartNoticeTimers[0].cleared, "Worker-pool restart Notice debounce did not clear the previous timer");
    restartNoticeTimers[1].callback();
    assert(restartNoticeMessages.length === 1 && restartNoticeMessages[0].includes("Reload"), "Worker-pool restart Notice debounce did not emit exactly one localized Notice");
  } finally {
    settingsTab.setWindowTimeout = originalSettingsTabSetTimeout;
    settingsTab.clearWindowTimeout = originalSettingsTabClearTimeout;
    ObsidianMockForRestartNotice.Notice = originalNoticeForRestartNotice;
    settingsTab.restartNoticeDebounceTimer = null;
  }

  const settingsHideTimers = [];
  let saveCallsOnSettingsHide = 0;
  try {
    settingsTab.setWindowTimeout = (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      settingsHideTimers.push(timer);
      return timer;
    };
    settingsTab.clearWindowTimeout = (timer) => {
      if (timer) {
        timer.cleared = true;
      }
    };
    plugin.saveSettings = async () => {
      saveCallsOnSettingsHide += 1;
    };
    settingsTab.debouncedSaveSettings();
    settingsTab.hide();
    await Promise.resolve();
    assert(settingsHideTimers.length === 1 && settingsHideTimers[0].cleared, "SettingsTab.hide() did not clear a pending debounced save timer");
    assert(settingsTab.saveSettingsDebounceTimer === null, "SettingsTab.hide() left a pending save timer reference");
    assert(saveCallsOnSettingsHide === 1, `SettingsTab.hide() flushed ${saveCallsOnSettingsHide} saves instead of one`);
  } finally {
    settingsTab.setWindowTimeout = originalSettingsTabSetTimeout;
    settingsTab.clearWindowTimeout = originalSettingsTabClearTimeout;
    plugin.saveSettings = originalPluginSaveSettingsForDebounce;
    settingsTab.saveSettingsDebounceTimer = null;
  }

  assert(settingsTab.normalizeAllowedRootSelection("") === null, "Allowed roots should reject the empty vault root selection");
  assert(settingsTab.normalizeAllowedRootSelection("/") === null, "Allowed roots should reject the slash vault root selection");
  assert(settingsTab.normalizeAllowedRootSelection("Images") === "Images/", "Allowed roots should normalize folder selections with a trailing slash");
  assert(settingsTab.formatCountMessage("stats.ghosts.clearedCount", 3) === "3 ghost entries cleared", "Ghost cleanup count Notice should use a translated count template");

  const loadingButtonCalls = [];
  const loadingButton = {
    setDisabled(value) {
      loadingButtonCalls.push(["disabled", value]);
      return this;
    },
    setButtonText(value) {
      loadingButtonCalls.push(["text", value]);
      return this;
    }
  };
  let loadingTaskRan = false;
  await settingsTab.runButtonTask(loadingButton, "common.refresh", "common.refreshing", async () => {
    loadingTaskRan = true;
  });
  assert(loadingTaskRan, "runButtonTask() did not run the async button task");
  assert(JSON.stringify(loadingButtonCalls) === JSON.stringify([
    ["disabled", true],
    ["text", "Refreshing..."],
    ["text", "Refresh"],
    ["disabled", false]
  ]), `runButtonTask() did not restore loading state correctly: ${JSON.stringify(loadingButtonCalls)}`);

  const ObsidianMockForButtonFailure = require("obsidian");
  const originalNoticeForButtonFailure = ObsidianMockForButtonFailure.Notice;
  const originalConsoleErrorForButtonFailure = console.error;
  const failedButtonNotices = [];
  const failedButtonCalls = [];
  try {
    ObsidianMockForButtonFailure.Notice = class {
      constructor(message) {
        failedButtonNotices.push(String(message));
      }
    };
    console.error = () => {};
    await settingsTab.runButtonTask({
      setDisabled(value) {
        failedButtonCalls.push(["disabled", value]);
        return this;
      },
      setButtonText(value) {
        failedButtonCalls.push(["text", value]);
        return this;
      }
    }, "common.clearGhosts", "common.clearing", async () => {
      throw new Error("simulated settings action failure");
    });
    assert(failedButtonNotices.some((message) => message.includes("Operation failed")), "runButtonTask() did not show a Notice after a failed async settings action");
    assert(JSON.stringify(failedButtonCalls.slice(-2)) === JSON.stringify([["text", "Clear ghosts"], ["disabled", false]]), "runButtonTask() did not restore button state after failure");
  } finally {
    ObsidianMockForButtonFailure.Notice = originalNoticeForButtonFailure;
    console.error = originalConsoleErrorForButtonFailure;
  }

  const subsettingRow = { settingEl: createMockElement() };
  let subsettingVisible = null;
  subsettingRow.settingEl.toggle = (value) => {
    subsettingVisible = value;
  };
  settingsTab.applySubsettingVisibility(false, subsettingRow);
  assert(subsettingVisible === false && subsettingRow.settingEl.classList.contains("tiny-local-subsetting"), "applySubsettingVisibility() did not toggle and classify conditional settings rows");
  const invalidSavingsWidths = settingsTab.getSavingsBarWidths({
    originalSize: 100,
    currentSize: 100,
    savedSize: Number.NaN,
    savedPercentage: Number.NaN,
    processedFiles: 1,
    totalFiles: 1
  });
  assert(invalidSavingsWidths.savedWidth === 0 && invalidSavingsWidths.currentWidth === 100, `Savings bar finite guard returned wrong widths: ${JSON.stringify(invalidSavingsWidths)}`);

  const activeDocument = {
    activeElement: null,
    body: createMockElement(),
    addEventListener() {},
    removeEventListener() {},
    createElement() {
      const element = createMockElement();
      element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 40, bottom: 40 });
      return element;
    }
  };
  const tooltipContainer = createMockElement();
  tooltipContainer.getBoundingClientRect = () => ({ left: 20, top: 60, width: 160, height: 20, bottom: 80 });
  settingsTab.getActiveDocument = () => activeDocument;
  settingsTab.getActiveWindow = () => ({
    innerWidth: 320,
    innerHeight: 240,
    requestAnimationFrame: (callback) => callback(),
    setTimeout: (callback) => callback()
  });
  settingsTab.setWindowTimeout = (callback) => callback();
  settingsTab.createSavingsTooltip(tooltipContainer, {
    originalSize: 1000,
    currentSize: 700,
    savedSize: 300,
    savedPercentage: 30,
    processedFiles: 1,
    totalFiles: 2,
    estimatedFiles: 0
  });
  tooltipContainer.dispatchEvent("mouseenter", {});
  assert(activeDocument.body.children.length === 1, "Savings tooltip did not render on hover");
  assert(activeDocument.body.children[0].style.left, "Savings tooltip did not calculate left position");
  assert(activeDocument.body.children[0].style.top, "Savings tooltip did not calculate top position");
  tooltipContainer.dispatchEvent("mouseleave", {});
  settingsTab.cleanupSavingsTooltips();
  assert(activeDocument.body.children.length === 0, "Savings tooltip cleanup left tooltip DOM behind");
  assert((tooltipContainer._listeners.mouseenter || []).length === 0, "Savings tooltip cleanup left mouseenter listener behind");
  assert((tooltipContainer._listeners.mouseleave || []).length === 0, "Savings tooltip cleanup left mouseleave listener behind");

  const tooltipTimers = [];
  const tooltipTimerWindow = {
    innerWidth: 320,
    innerHeight: 240,
    requestAnimationFrame: (callback) => callback(),
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      tooltipTimers.push(timer);
      return timer;
    },
    clearTimeout: (timer) => {
      if (timer) timer.cleared = true;
    }
  };
  const raceTooltipContainer = createMockElement();
  settingsTab.getActiveDocument = () => activeDocument;
  settingsTab.getActiveWindow = () => tooltipTimerWindow;
  settingsTab.setWindowTimeout = (callback, delay) => tooltipTimerWindow.setTimeout(callback, delay);
  settingsTab.createSavingsTooltip(raceTooltipContainer, {
    originalSize: 1000,
    currentSize: 700,
    savedSize: 300,
    savedPercentage: 30,
    processedFiles: 1,
    totalFiles: 2,
    estimatedFiles: 0
  });
  raceTooltipContainer.dispatchEvent("mouseenter", {});
  raceTooltipContainer.dispatchEvent("mouseleave", {});
  raceTooltipContainer.dispatchEvent("mouseenter", {});
  assert(tooltipTimers.length === 3, `Tooltip timer race test expected 3 timers, got ${tooltipTimers.length}`);
  assert(tooltipTimers[0].cleared === true, "Tooltip mouseleave did not clear the pending show timer");
  assert(tooltipTimers[1].cleared === true, "Tooltip re-enter did not clear the pending hide timer");
  settingsTab.cleanupSavingsTooltips();

  const hideTooltipContainer = createMockElement();
  const hideTooltipDocument = {
    activeElement: null,
    body: createMockElement(),
    addEventListener() {},
    removeEventListener() {},
    createElement() {
      const element = createMockElement();
      element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 40, bottom: 40 });
      return element;
    },
    querySelectorAll(selector) {
      return this.body.querySelectorAll(selector);
    }
  };
  hideTooltipContainer.getBoundingClientRect = () => ({ left: 20, top: 60, width: 160, height: 20, bottom: 80 });
  settingsTab.getActiveDocument = () => hideTooltipDocument;
  settingsTab.getActiveWindow = () => ({
    innerWidth: 320,
    innerHeight: 240,
    requestAnimationFrame: (callback) => callback(),
    setTimeout: (callback) => callback(),
    clearTimeout() {}
  });
  settingsTab.setWindowTimeout = (callback) => callback();
  settingsTab.createSavingsTooltip(hideTooltipContainer, {
    originalSize: 1000,
    currentSize: 700,
    savedSize: 300,
    savedPercentage: 30,
    processedFiles: 1,
    totalFiles: 2,
    estimatedFiles: 0
  });
  hideTooltipContainer.dispatchEvent("mouseenter", {});
  assert(hideTooltipDocument.body.querySelectorAll(".tiny-local-savings-tooltip").length === 1, "Savings tooltip did not render before hide()");
  settingsTab.hide();
  assert(hideTooltipDocument.body.querySelectorAll(".tiny-local-savings-tooltip").length === 0, "SettingsTab.hide() left savings tooltip DOM behind");
  assert((hideTooltipContainer._listeners.mouseenter || []).length === 0, "SettingsTab.hide() left mouseenter listener behind");
  assert((hideTooltipContainer._listeners.mouseleave || []).length === 0, "SettingsTab.hide() left mouseleave listener behind");
  assert(settingsTab.hidden === true, "SettingsTab.hide() did not delegate to the base hide()");

  const popoutTooltipContainer = createMockElement();
  const popoutTooltipDocument = {
    activeElement: null,
    body: createMockElement(),
    addEventListener() {},
    removeEventListener() {},
    createElement() {
      const element = createMockElement();
      element.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 40, bottom: 40 });
      return element;
    },
    querySelectorAll(selector) {
      return this.body.querySelectorAll(selector);
    }
  };
  const mainTooltipDocument = {
    activeElement: null,
    body: createMockElement(),
    addEventListener() {},
    removeEventListener() {},
    createElement() {
      return createMockElement();
    },
    querySelectorAll(selector) {
      return this.body.querySelectorAll(selector);
    }
  };
  popoutTooltipContainer.getBoundingClientRect = () => ({ left: 20, top: 60, width: 160, height: 20, bottom: 80 });
  settingsTab.getActiveDocument = () => popoutTooltipDocument;
  settingsTab.getActiveWindow = () => ({
    innerWidth: 320,
    innerHeight: 240,
    requestAnimationFrame: (callback) => callback(),
    setTimeout: (callback) => callback(),
    clearTimeout() {}
  });
  settingsTab.setWindowTimeout = (callback) => callback();
  settingsTab.createSavingsTooltip(popoutTooltipContainer, {
    originalSize: 1000,
    currentSize: 700,
    savedSize: 300,
    savedPercentage: 30,
    processedFiles: 1,
    totalFiles: 2,
    estimatedFiles: 0
  });
  popoutTooltipContainer.dispatchEvent("mouseenter", {});
  assert(popoutTooltipDocument.body.querySelectorAll(".tiny-local-savings-tooltip").length === 1, "Popout savings tooltip did not render");
  settingsTab.getActiveDocument = () => mainTooltipDocument;
  settingsTab.cleanupSavingsTooltips();
  assert(popoutTooltipDocument.body.querySelectorAll(".tiny-local-savings-tooltip").length === 0, "Savings tooltip cleanup missed a tooltip created in a previous document");
  assert((popoutTooltipContainer._listeners.mouseenter || []).length === 0, "Cross-document tooltip cleanup left mouseenter listener behind");

  let settingsDisplayCount = 0;
  const originalSettingsTabUpdateStats = settingsTab.updateStats;
  settingsTab._isVisible = true;
  settingsTab.updateStats = async () => {
    settingsDisplayCount += 1;
  };
  await plugin.updateSavingsIndicatorInSettings();
  assert(settingsDisplayCount === 1, "Plugin did not refresh an already-open active settings tab");
  settingsTab._isVisible = false;
  await plugin.updateSavingsIndicatorInSettings();
  assert(settingsDisplayCount === 1, "Plugin refreshed settings while its settings tab was hidden");
  const ownedSettingsTab = plugin.settingsTab;
  plugin.settingsTab = null;
  await plugin.updateSavingsIndicatorInSettings();
  plugin.settingsTab = ownedSettingsTab;
  assert(settingsDisplayCount === 1, "Plugin settings indicator refresh did not tolerate a missing owned settings tab");

  let settingsPendingRerenderRequested = false;
  let settingsUpdateStatsWhileRendering = false;
  settingsTab._isVisible = true;
  settingsTab._isRendering = true;
  settingsTab._pendingRerender = false;
  settingsTab.updateStats = async () => {
    settingsUpdateStatsWhileRendering = true;
  };
  await plugin.updateSavingsIndicatorInSettings();
  settingsPendingRerenderRequested = settingsTab._pendingRerender;
  assert(settingsPendingRerenderRequested, "Plugin did not ask SettingsTab to defer a stats refresh while rendering");
  assert(!settingsUpdateStatsWhileRendering, "Plugin refreshed settings stats while SettingsTab reported an active render");
  settingsTab._isRendering = false;
  settingsTab._pendingRerender = false;
  settingsTab._isVisible = false;
  settingsTab.updateStats = originalSettingsTabUpdateStats;

  plugin.cache.cacheData.entries = {};
  plugin.settings.autoBackgroundThreshold = 1;
  await plugin.statusBarController.update();
  assert(plugin.statusBarItem.getText().startsWith("\u25CF "), "Status bar backlog state is missing its attention indicator");
  assert(String(plugin.statusBarItem.attributes["aria-label"] || "").includes(plugin.statusBarItem.getText()), "Status bar aria-label did not match the visible backlog status text");
  assert(plugin.statusBarItem.classList.contains("tiny-local-status-attention"), "Status bar backlog class is missing");
  assert(!plugin.statusBarItem.classList.contains("tiny-local-compressing"), "Status bar backlog state should not use running class");

  plugin.backgroundCompressionService.isBackgroundCompressionRunning = true;
  await plugin.statusBarController.update();
  assert(plugin.statusBarItem.getText().startsWith("\u27F3 "), "Status bar running state is missing its running indicator");
  assert(plugin.statusBarItem.classList.contains("tiny-local-compressing"), "Status bar running class is missing");
  assert(!plugin.statusBarItem.classList.contains("tiny-local-status-attention"), "Status bar running state should not use backlog class");

  plugin.backgroundCompressionService.isBackgroundCompressionRunning = false;
  plugin.settings.autoBackgroundThreshold = 999;
  await plugin.statusBarController.update();
  assert(!plugin.statusBarItem.classList.contains("tiny-local-compressing"), "Status bar idle state should not use running class");
  assert(!plugin.statusBarItem.classList.contains("tiny-local-status-attention"), "Status bar idle state should not use backlog class");

  const originalLastUserActivity = plugin.backgroundCompressionService.lastUserActivity;
  const originalLastUserActivityPerfTime = plugin.backgroundCompressionService.lastUserActivityPerfTime;
  try {
    plugin.backgroundCompressionService.lastUserActivity = Date.now() + 60 * 60 * 1000;
    plugin.backgroundCompressionService.lastUserActivityPerfTime = plugin.getMonotonicTime() - plugin.backgroundCompressionService.USER_INACTIVITY_THRESHOLD - 1;
    assert(plugin.backgroundCompressionService.isUserInactive(), "Background inactivity used wall-clock time instead of monotonic time");
  } finally {
    plugin.backgroundCompressionService.lastUserActivity = originalLastUserActivity;
    plugin.backgroundCompressionService.lastUserActivityPerfTime = originalLastUserActivityPerfTime;
  }

  const originalIsUserInactiveForThreshold = plugin.backgroundCompressionService.isUserInactive;
  const originalStartBackgroundCompression = plugin.backgroundCompressionService.startBackgroundCompression;
  let backgroundStartsAtThreshold = 0;
  plugin.backgroundCompressionService.isUserInactive = () => true;
  plugin.backgroundCompressionService.startBackgroundCompression = async () => {
    backgroundStartsAtThreshold += 1;
  };
  await setMockFiles(plugin, [
    createMockFile("Threshold/a.png", 100000, 1),
    createMockFile("Threshold/b.png", 100000, 1)
  ]);
  plugin.cache.cacheData.entries = {};
  plugin.settings.autoBackgroundCompression = true;
  plugin.settings.autoBackgroundThreshold = 2;
  plugin.backgroundCompressionService.AUTO_BACKGROUND_THRESHOLD = 2;
  await plugin.backgroundCompressionService.checkAndStartBackgroundCompression();
  assert(backgroundStartsAtThreshold === 1, "Background compression did not start at exactly the configured threshold");
  const originalImageIndexForBackgroundGuard = plugin.imageIndex;
  try {
    plugin.imageIndex = {
      isReady: () => false,
      getSnapshot() {
        throw new Error("stale snapshot should not be read while image index is rebuilding");
      }
    };
    backgroundStartsAtThreshold = 0;
    await plugin.backgroundCompressionService.checkAndStartBackgroundCompression();
    assert(backgroundStartsAtThreshold === 0, "Background compression used an image-index snapshot while rebuild was in flight");
  } finally {
    plugin.imageIndex = originalImageIndexForBackgroundGuard;
  }
  let inactiveChecksDuringBackgroundStart = 0;
  plugin.backgroundCompressionService.isUserInactive = () => {
    inactiveChecksDuringBackgroundStart += 1;
    return inactiveChecksDuringBackgroundStart === 1;
  };
  backgroundStartsAtThreshold = 0;
  await plugin.backgroundCompressionService.checkAndStartBackgroundCompression();
  assert(backgroundStartsAtThreshold === 0, "Background compression ignored user activity between threshold check and trigger");
  plugin.backgroundCompressionService.isUserInactive = () => true;
  const originalAutoBackgroundCompressionForThreshold = plugin.settings.autoBackgroundCompression;
  let autoBackgroundReads = 0;
  try {
    Object.defineProperty(plugin.settings, "autoBackgroundCompression", {
      configurable: true,
      get() {
        autoBackgroundReads += 1;
        return autoBackgroundReads === 1;
      },
      set(value) {
        autoBackgroundReads = value ? 0 : 2;
      }
    });
    backgroundStartsAtThreshold = 0;
    await plugin.backgroundCompressionService.checkAndStartBackgroundCompression();
    assert(backgroundStartsAtThreshold === 0, "Background compression ignored a settings toggle between threshold check and trigger");
  } finally {
    Object.defineProperty(plugin.settings, "autoBackgroundCompression", {
      configurable: true,
      writable: true,
      value: originalAutoBackgroundCompressionForThreshold
    });
  }
  await plugin.statusBarController.update();
  assert(plugin.statusBarItem.classList.contains("tiny-local-status-attention"), "Status bar did not show backlog at exactly the configured threshold");
  plugin.backgroundCompressionService.isUserInactive = originalIsUserInactiveForThreshold;
  plugin.backgroundCompressionService.startBackgroundCompression = originalStartBackgroundCompression;

  const originalGetImageFilesForBackgroundFilter = plugin.getImageFiles;
  const originalImageIndexForBackgroundFilter = plugin.imageIndex;
  const originalIsProcessedForBackgroundFilter = plugin.cache.isFileAlreadyProcessed;
  const originalProcessBackgroundFilter = plugin.processBatchCompressionBackground;
  const originalIsUserInactiveForBackgroundFilter = plugin.backgroundCompressionService.isUserInactive;
  try {
    const readyBackgroundFiles = [
      createMockFile("Background/ready-a.png", 100000, 1),
      createMockFile("Background/ready-b.jpg", 100000, 2)
    ];
    plugin.imageIndex = { isReady: () => true };
    plugin.getImageFiles = async () => readyBackgroundFiles;
    plugin.cache.isFileAlreadyProcessed = async () => {
      throw new Error("ready image index should avoid sequential processed checks");
    };
    let backgroundBatchFiles = null;
    plugin.processBatchCompressionBackground = async (files) => {
      backgroundBatchFiles = files;
    };
    plugin.backgroundCompressionService.isUserInactive = () => true;
    plugin.backgroundCompressionService.isBackgroundCompressionRunning = false;
    plugin.settings.autoBackgroundCompression = true;
    await plugin.backgroundCompressionService.startBackgroundCompression();
    assert(backgroundBatchFiles?.length === readyBackgroundFiles.length, "Background compression did not trust the ready image-index uncompressed file list");

    const fallbackBackgroundFiles = [
      createMockFile("Background/fallback-a.png", 100000, 3),
      createMockFile("Background/fallback-processed.jpg", 100000, 4)
    ];
    await setMockFiles(plugin, fallbackBackgroundFiles);
    plugin.imageIndex = { isReady: () => false };
    plugin.getImageFiles = async () => {
      throw new Error("not-ready background should use getAllImageFiles instead of sequential getImageFiles fallback");
    };
    let fallbackProcessedChecks = 0;
    plugin.cache.isFileAlreadyProcessed = async (file) => {
      fallbackProcessedChecks += 1;
      return file.path.includes("processed");
    };
    backgroundBatchFiles = null;
    plugin.backgroundCompressionService.isBackgroundCompressionRunning = false;
    await plugin.backgroundCompressionService.startBackgroundCompression();
    assert(fallbackProcessedChecks === fallbackBackgroundFiles.length, "Background fallback did not filter not-ready index files through the bounded cache check");
    assert(backgroundBatchFiles?.length === 1 && backgroundBatchFiles[0].path === "Background/fallback-a.png", "Background fallback did not pass only unprocessed files to batch compression");
  } finally {
    plugin.getImageFiles = originalGetImageFilesForBackgroundFilter;
    plugin.imageIndex = originalImageIndexForBackgroundFilter;
    plugin.cache.isFileAlreadyProcessed = originalIsProcessedForBackgroundFilter;
    plugin.processBatchCompressionBackground = originalProcessBackgroundFilter;
    plugin.backgroundCompressionService.isUserInactive = originalIsUserInactiveForBackgroundFilter;
    plugin.backgroundCompressionService.isBackgroundCompressionRunning = false;
  }

  const originalGetActiveDocumentForMenu = plugin.getActiveDocument;
  const originalGetActiveWindowForMenu = plugin.getActiveWindow;
  const originalGetCompressedFilesCountForMenu = plugin.getCompressedFilesCount;
  const originalMoveCompressedToFilesForMenu = plugin.moveCompressedToFiles;
  const menuDocument = {
    body: createMockElement(),
    _listeners: {},
    createElement: () => createMockElement(),
    addEventListener(name, callback) {
      this._listeners[name] = this._listeners[name] || [];
      this._listeners[name].push(callback);
    },
    removeEventListener(name, callback) {
      this._listeners[name] = (this._listeners[name] || []).filter((listener) => listener !== callback);
    }
  };
  const menuWindow = {
    innerWidth: 1200,
    innerHeight: 800,
    _listeners: {},
    addEventListener(name, callback) {
      this._listeners[name] = this._listeners[name] || [];
      this._listeners[name].push(callback);
    },
    removeEventListener(name, callback) {
      this._listeners[name] = (this._listeners[name] || []).filter((listener) => listener !== callback);
    }
  };
  let statusMenuMoveCalls = 0;
  const createVisibleStatusMenuTarget = () => {
    const target = createMockElement();
    target.getBoundingClientRect = () => ({ left: 25, top: 120, width: 80, height: 20, bottom: 140 });
    return target;
  };
  try {
    plugin.getActiveDocument = () => menuDocument;
    plugin.getActiveWindow = () => menuWindow;
    plugin.setWindowTimeout = (callback) => {
      callback();
      return null;
    };
    plugin.getCompressedFilesCount = async () => 1;
    plugin.moveCompressedToFiles = async () => {
      statusMenuMoveCalls += 1;
    };
    const hiddenStatusMenuTarget = createMockElement();
    const hiddenStatusMenuWarnings = captureConsoleWarn();
    try {
      await plugin.statusBarController.showMenu({ target: hiddenStatusMenuTarget, preventDefault() {} });
    } finally {
      hiddenStatusMenuWarnings.restore();
    }
    assert(hiddenStatusMenuWarnings.messages.some((message) => message.includes("Status menu skipped because the status bar item is not visible")), "Hidden status menu did not emit the expected warning");
    assert(menuDocument.body.children.length === 0, "Status menu rendered for a hidden zero-size status bar item");
    await plugin.statusBarController.showMenu({ target: createVisibleStatusMenuTarget(), preventDefault() {} });
    const menu = menuDocument.body.children[0];
    assert(menu.attributes.role === "menu", "Status menu is missing role=menu");
    const moveItem = menu.children[menu.children.length - 1];
    assert(moveItem.tag === "button", "Status menu action is not rendered as a button");
    assert(moveItem.type === "button", "Status menu action button is missing type=button");
    assert(moveItem.attributes.role === "menuitem", "Status menu action button is missing role=menuitem");
    assert(plugin.statusBarItem.attributes["aria-expanded"] === "true", "Status bar aria-expanded did not change when menu opened");
    moveItem.dispatchEvent("click");
    assert(statusMenuMoveCalls === 1, "Status menu item did not run its action");
    assert(!menuDocument.body.contains(menu), "Status menu click did not remove the menu");
    assert(plugin.statusBarItem.attributes["aria-expanded"] === "false", "Status bar aria-expanded did not reset after menu action");
    assert((menuDocument._listeners.click || []).length === 0, "Status menu click left document click listeners behind");
    assert((menuDocument._listeners.keydown || []).length === 0, "Status menu click left document keydown listeners behind");
    assert((menuWindow._listeners.blur || []).length === 0, "Status menu click left window blur listeners behind");

    await plugin.statusBarController.showMenu({ keyboard: true, returnFocusTo: plugin.statusBarItem, target: createVisibleStatusMenuTarget() });
    const keyboardMenu = menuDocument.body.children[0];
    const firstKeyboardItem = keyboardMenu.children[1];
    const keyboardMoveItem = keyboardMenu.children[keyboardMenu.children.length - 1];
    assert(firstKeyboardItem.focused === true, "Keyboard-opened status menu did not focus the first menu item");
    let enterPreventedForMenuItem = false;
    keyboardMoveItem.dispatchEvent("keydown", {
      key: "Enter",
      preventDefault() {
        enterPreventedForMenuItem = true;
      }
    });
    assert(enterPreventedForMenuItem && statusMenuMoveCalls === 2, "Status menu Enter key did not run item action");
    assert(!menuDocument.body.contains(keyboardMenu), "Status menu Enter action did not close the menu");

    await plugin.statusBarController.showMenu({ keyboard: true, returnFocusTo: plugin.statusBarItem, target: createVisibleStatusMenuTarget() });
    const escapeMenu = menuDocument.body.children[0];
    plugin.statusBarItem.focused = false;
    let escapePreventedForMenu = false;
    menuDocument._listeners.keydown[0]?.({
      key: "Escape",
      preventDefault() {
        escapePreventedForMenu = true;
      }
    });
    assert(escapePreventedForMenu, "Status menu Escape key did not prevent default");
    assert(!menuDocument.body.contains(escapeMenu), "Status menu Escape key did not close the menu");
    assert(plugin.statusBarItem.focused === true, "Status menu Escape key did not restore focus");
    assert(plugin.statusBarItem.attributes["aria-expanded"] === "false", "Status bar aria-expanded did not reset after Escape");

    menuWindow.innerWidth = 800;
    menuWindow.innerHeight = 600;
    const edgeStatusMenuTarget = createMockElement();
    edgeStatusMenuTarget.getBoundingClientRect = () => ({ left: 790, top: 580, width: 20, height: 20, bottom: 600 });
    await plugin.statusBarController.showMenu({ target: edgeStatusMenuTarget, preventDefault() {} });
    const edgeMenu = menuDocument.body.children[0];
    const edgeLeft = Number.parseInt(edgeMenu.style.getPropertyValue("--local-image-compress-status-menu-left"), 10);
    const edgeTop = Number.parseInt(edgeMenu.style.getPropertyValue("--local-image-compress-status-menu-top"), 10);
    assert(edgeLeft === 430, `Right-edge status menu left was not clamped to the viewport: ${edgeLeft}`);
    assert(edgeTop >= 10 && edgeTop <= 430, `Bottom-edge status menu top was not clamped to the viewport: ${edgeTop}`);
    plugin.statusBarController.closeMenu();

    const capturedMenuDocument = {
      body: createMockElement(),
      _listeners: {},
      createElement() {
        const element = createMockElement();
        element.ownerDocumentName = "captured";
        return element;
      },
      addEventListener(name, callback) {
        this._listeners[name] = this._listeners[name] || [];
        this._listeners[name].push(callback);
      },
      removeEventListener(name, callback) {
        this._listeners[name] = (this._listeners[name] || []).filter((listener) => listener !== callback);
      }
    };
    const switchedMenuDocument = {
      body: createMockElement(),
      createElement() {
        const element = createMockElement();
        element.ownerDocumentName = "switched";
        return element;
      },
      addEventListener() {},
      removeEventListener() {}
    };
    let activeDocumentReadsDuringMenuOpen = 0;
    plugin.getActiveDocument = () => {
      activeDocumentReadsDuringMenuOpen += 1;
      return activeDocumentReadsDuringMenuOpen <= 2 ? capturedMenuDocument : switchedMenuDocument;
    };
    await plugin.statusBarController.showMenu({ target: createVisibleStatusMenuTarget(), preventDefault() {} });
    assert(activeDocumentReadsDuringMenuOpen === 2, "Status menu re-read activeDocument after async count lookup");
    assert(capturedMenuDocument.body.children[0]?.ownerDocumentName === "captured", "Status menu was created in a different document than the one captured at open");
    plugin.statusBarController.closeMenu();
  } finally {
    plugin.getActiveDocument = originalGetActiveDocumentForMenu;
    plugin.getActiveWindow = originalGetActiveWindowForMenu;
    plugin.getCompressedFilesCount = originalGetCompressedFilesCountForMenu;
    plugin.moveCompressedToFiles = originalMoveCompressedToFilesForMenu;
    plugin.setWindowTimeout = originalSetWindowTimeoutForNewFile;
  }

  const deferredMenuDocument = {
    body: createMockElement(),
    _listeners: {},
    createElement: () => createMockElement(),
    addEventListener(name, callback) {
      this._listeners[name] = this._listeners[name] || [];
      this._listeners[name].push(callback);
    },
    removeEventListener(name, callback) {
      this._listeners[name] = (this._listeners[name] || []).filter((listener) => listener !== callback);
    }
  };
  const deferredMenuWindow = {
    innerWidth: 1200,
    _listeners: {},
    addEventListener(name, callback) {
      this._listeners[name] = this._listeners[name] || [];
      this._listeners[name].push(callback);
    },
    removeEventListener(name, callback) {
      this._listeners[name] = (this._listeners[name] || []).filter((listener) => listener !== callback);
    }
  };
  const deferredMenuTimers = [];
  try {
    plugin.getActiveDocument = () => deferredMenuDocument;
    plugin.getActiveWindow = () => deferredMenuWindow;
    plugin.setWindowTimeout = (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      deferredMenuTimers.push(timer);
      return timer;
    };
    plugin.clearWindowTimeout = (timer) => {
      if (timer) timer.cleared = true;
    };
    plugin.getCompressedFilesCount = async () => 0;
    await plugin.statusBarController.showMenu({ target: createVisibleStatusMenuTarget(), preventDefault() {} });
    assert(deferredMenuTimers.length === 1, `Status menu did not schedule exactly one deferred click listener: ${deferredMenuTimers.length}`);
    plugin.statusBarController.closeMenu();
    assert(deferredMenuTimers[0].cleared === true, "closeMenu() did not cancel the deferred status-menu click listener");
    assert(deferredMenuDocument.body.children.length === 0, "closeMenu() left the status menu DOM behind");
    assert((deferredMenuDocument._listeners.click || []).length === 0, "closeMenu() left document click listeners behind");
    assert((deferredMenuDocument._listeners.keydown || []).length === 0, "closeMenu() left document keydown listeners behind");
    assert((deferredMenuWindow._listeners.blur || []).length === 0, "closeMenu() left window blur listeners behind");
  } finally {
    plugin.getActiveDocument = originalGetActiveDocumentForMenu;
    plugin.getActiveWindow = originalGetActiveWindowForMenu;
    plugin.getCompressedFilesCount = originalGetCompressedFilesCountForMenu;
    plugin.setWindowTimeout = originalSetWindowTimeoutForNewFile;
    plugin.clearWindowTimeout = originalClearWindowTimeoutForNewFile;
    plugin.statusBarController.closeMenu();
  }

  let counts;
  plugin.settings.outputFolder = "Compressed";
  await setMockFiles(plugin, [
    createMockFile("Compressed/root.png", 100000),
    createMockFile("Images/project/Compressed/nested.png", 100000)
  ]);
  let visibleImagePaths = plugin.getAllImageFiles().map((file) => file.path).sort();
  assert(
    JSON.stringify(visibleImagePaths) === JSON.stringify(["Images/project/Compressed/nested.png"]),
    `Output folder filtering excluded the wrong files for root output folder: ${visibleImagePaths.join(", ")}`
  );
  plugin.settings.outputFolder = "files/Compressed";
  await setMockFiles(plugin, [
    createMockFile("Compressed/root.png", 100000),
    createMockFile("files/Compressed/output.png", 100000),
    createMockFile("files/project/Compressed/ordinary.png", 100000)
  ]);
  visibleImagePaths = plugin.getAllImageFiles().map((file) => file.path).sort();
  assert(
    JSON.stringify(visibleImagePaths) === JSON.stringify(["Compressed/root.png", "files/project/Compressed/ordinary.png"]),
    `Output folder filtering excluded the wrong files for nested output folder: ${visibleImagePaths.join(", ")}`
  );
  for (const invalidOutputFolder of ["../outside", "/tmp/outside", "C:\\outside", "\\\\server\\share"]) {
    plugin.settings.outputFolder = invalidOutputFolder;
    await plugin.saveSettings();
    assert(plugin.getOutputFolder() === "Compressed", `Unsafe output folder was not normalized to Compressed: ${invalidOutputFolder}`);
    assert(plugin.savedData.outputFolder === "Compressed", `Unsafe output folder was persisted: ${invalidOutputFolder}`);
  }
  plugin.settings.outputFolder = "files/Compressed";
  await plugin.saveSettings();
  assert(plugin.getOutputFolder() === "files/Compressed", "Safe nested output folder was not preserved");

  plugin.settings.outputFolder = "Compressed";
  plugin.settings.allowedRoots = ["Allowed", "foo"];
  await setMockFiles(plugin, [
    createMockFile("Allowed/a.png", 100000),
    createMockFile("Disallowed/b.png", 100000),
    createMockFile("foo/c.jpg", 100000),
    createMockFile("foobar/d.jpg", 100000)
  ]);
  counts = await plugin.getImageCompressionCounts();
  visibleImagePaths = plugin.getAllImageFiles().map((file) => file.path).sort();
  assert(
    JSON.stringify(visibleImagePaths) === JSON.stringify(["Allowed/a.png", "foo/c.jpg"]),
    `Allowed roots filtering included wrong files: ${visibleImagePaths.join(", ")}`
  );
  assert(counts.totalImages === 2 && counts.uncompressedImages === 2, `Allowed roots snapshot counted wrong files: ${JSON.stringify(counts)}`);
  plugin.settings.allowedRoots = [];

  const originalProcessBatchCompression = plugin.processBatchCompression;
  const originalIsImageFileAndNotCompressed = plugin.isImageFileAndNotCompressed;
  let folderBatchPaths = [];
  plugin.processBatchCompression = async (files) => {
    folderBatchPaths = files.map((file) => file.path).sort();
  };
  plugin.isImageFileAndNotCompressed = async (file) => plugin.isImageFile(file);
  await setMockFiles(plugin, [
    createMockFile("foo/a.png", 100000, 1),
    createMockFile("foo/sub/c.jpg", 100000, 1),
    createMockFile("foobar/b.png", 100000, 1)
  ]);
  await plugin.compressImagesInFolderPath("foo", true);
  assert(
    JSON.stringify(folderBatchPaths) === JSON.stringify(["foo/a.png", "foo/sub/c.jpg"]),
    `Recursive folder match captured wrong files: ${folderBatchPaths.join(", ")}`
  );
  await setMockFiles(plugin, [
    createMockFile("root.png", 100000, 1),
    createMockFile("images/nested.png", 100000, 1)
  ]);
  await plugin.compressImagesInFolderPath("", false);
  assert(
    JSON.stringify(folderBatchPaths) === JSON.stringify(["root.png"]),
    `Root non-recursive folder match captured wrong files: ${folderBatchPaths.join(", ")}`
  );
  plugin.processBatchCompression = originalProcessBatchCompression;
  plugin.isImageFileAndNotCompressed = originalIsImageFileAndNotCompressed;

  const originalFsReaddir = fs.promises.readdir;
  const originalFsRealpath = fs.promises.realpath;
  const originalFsStat = fs.promises.stat;
  const originalConsoleErrorForCompressedScan = console.error;
  let compressedScanRealpathErrors = 0;
  let compressedScanCycleReaddirCalls = 0;
  try {
    fs.promises.realpath = async (dirPath) => {
      if (String(dirPath).includes(`${path.sep}bad`) || String(dirPath).includes("/bad")) {
        throw new Error("simulated realpath failure");
      }
      if (String(dirPath).includes("cycle")) {
        return "C:/Vault/Cafe\u0301";
      }
      if (String(dirPath).includes("virtual-compressed")) {
        return "C:/Vault/Caf\u00e9";
      }
      return originalFsRealpath(dirPath);
    };
    fs.promises.readdir = async (dirPath) => {
      if (String(dirPath).includes("virtual-compressed")) {
        if (String(dirPath).includes("cycle")) {
          compressedScanCycleReaddirCalls += 1;
        }
        return [
          { name: "cycle", isSymbolicLink: () => false, isDirectory: () => true },
          { name: "linked", isSymbolicLink: () => true, isDirectory: () => true },
          { name: "bad", isSymbolicLink: () => false, isDirectory: () => true },
          { name: "image.png", isSymbolicLink: () => false, isDirectory: () => false }
        ];
      }
      return originalFsReaddir(dirPath, { withFileTypes: true });
    };
    fs.promises.stat = async (filePath) => {
      if (String(filePath).includes("virtual-compressed")) {
        return { size: 12345 };
      }
      return originalFsStat(filePath);
    };
    console.error = (...args) => {
      if (String(args[1] || "").includes("Failed to resolve directory")) {
        compressedScanRealpathErrors += 1;
      }
    };
    const compressedScanFiles = await plugin.moveService.getCompressedFilesAsync("virtual-compressed");
    assert(compressedScanFiles.length === 1, `Compressed scan did not skip symlink/cycle entries: ${compressedScanFiles.length}`);
    assert(compressedScanFiles[0].name === "image.png", "Compressed scan missed the ordinary image file");
    assert(compressedScanCycleReaddirCalls === 0, "Compressed scan did not normalize Unicode/case-equivalent realpaths before cycle detection");
    assert(compressedScanRealpathErrors === 1, "Compressed scan did not log realpath failures");
  } finally {
    fs.promises.readdir = originalFsReaddir;
    fs.promises.realpath = originalFsRealpath;
    fs.promises.stat = originalFsStat;
    console.error = originalConsoleErrorForCompressedScan;
  }

  const moveCountTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-count-"));
  try {
    plugin.settings.outputFolder = "Compressed";
    plugin.app.vault.adapter.basePath = moveCountTemp;
    plugin.app.vault.adapter.path.absolute = moveCountTemp;
    fs.mkdirSync(path.join(moveCountTemp, "Compressed", "lost"), { recursive: true });
    fs.writeFileSync(path.join(moveCountTemp, "Compressed", "lost", "a.png"), Buffer.alloc(50));
    fs.writeFileSync(path.join(moveCountTemp, "Compressed", "lost", "b.jpg"), Buffer.alloc(50));
    await setMockFiles(plugin, [
      createMockFile("Images/a.png", 100, 1),
      createMockFile("Images/b.jpg", 100, 1)
    ]);
    plugin.app._resetGetFilesCalls();
    const movableCount = await plugin.moveService.getCompressedFilesCount();
    assert(movableCount === 2, `Move count did not find basename fallback originals: ${movableCount}`);
    assert(plugin.app._getFilesCalls === 1, `Move count rebuilt original lookup too many times: ${plugin.app._getFilesCalls}`);
  } finally {
    fs.rmSync(moveCountTemp, { recursive: true, force: true });
    plugin.app.vault.adapter.basePath = root;
    plugin.app.vault.adapter.path.absolute = root;
  }

  const originalUpdateStatusBar = plugin.updateStatusBar.bind(plugin);
  const scheduledTimers = [];
  let clearTimerCalls = 0;
  let statusRefreshCalls = 0;
  global.setTimeout = (callback, delay) => {
    const timer = { callback, delay, cleared: false };
    scheduledTimers.push(timer);
    return timer;
  };
  global.clearTimeout = (timer) => {
    if (timer) timer.cleared = true;
    clearTimerCalls += 1;
  };
  plugin.updateStatusBar = async () => {
    statusRefreshCalls += 1;
  };
  plugin.scheduleStatusBarUpdate("debounce-a");
  plugin.scheduleStatusBarUpdate("debounce-b");
  plugin.scheduleStatusBarUpdate("debounce-c");
  assert(scheduledTimers.length === 1, `Status update debounce thrashed timers under rapid calls: ${scheduledTimers.length}`);
  assert(clearTimerCalls === 0, `Status update debounce cleared timers under rapid calls: ${clearTimerCalls}`);
  assert(scheduledTimers.filter((timer) => !timer.cleared).length === 1, "Debounce left more than one active status timer");
  await scheduledTimers[0].callback();
  assert(statusRefreshCalls === 1, `Debounced status refresh ran ${statusRefreshCalls} times instead of once`);
  plugin.statusUpdateFirstQueuedAt = Date.now() - plugin.statusUpdateMaxWaitMs - 1;
  plugin.scheduleStatusBarUpdate("debounce-max-wait");
  assert(scheduledTimers[scheduledTimers.length - 1].delay === 0, "Status bar max-wait did not force an immediate refresh under event storm");
  plugin.updateStatusBar = originalUpdateStatusBar;

  const originalHandleNewFile = plugin.handleNewFile;
  plugin.handleNewFile = async () => {};
  plugin.app._resetGetFilesCalls();
  await plugin.app._vaultHandlers.create(createMockFile("Images/incremental.png", 100000, 20));
  counts = await plugin.getImageCompressionCounts();
  assert(plugin.app._getFilesCalls === 0, "Image create event triggered a full vault scan");
  assert(counts.totalImages === 3, `Image create event did not update index incrementally, total=${counts.totalImages}`);
  await plugin.app._vaultHandlers.create(createMockFile("Notes/not-image.md", 1000, 20));
  counts = await plugin.getImageCompressionCounts();
  assert(counts.totalImages === 3, "Non-image create event changed the image index");
  await plugin.app._vaultHandlers.rename(createMockFile("Images/renamed.png", 100000, 20), "Images/incremental.png");
  visibleImagePaths = plugin.getAllImageFiles().map((file) => file.path).sort();
  assert(visibleImagePaths.includes("Images/renamed.png"), "Image rename event did not update index path");
  assert(!visibleImagePaths.includes("Images/incremental.png"), "Image rename event left the old path in index");
  await plugin.app._vaultHandlers.delete({ path: "Images/renamed.png" });
  visibleImagePaths = plugin.getAllImageFiles().map((file) => file.path).sort();
  assert(!visibleImagePaths.includes("Images/renamed.png"), "Image delete event did not remove index path");
  plugin.handleNewFile = originalHandleNewFile;

  let readBinaryCalls = 0;
  const originalReadBinary = plugin.app.vault.readBinary;
  plugin.app.vault.readBinary = async () => {
    readBinaryCalls += 1;
    throw new Error("status path should not hash binary files");
  };
  await plugin.statusBarController.update();
  assert(readBinaryCalls === 0, "Status bar update read binary file contents");
  plugin.app.vault.readBinary = originalReadBinary;

  plugin.cache.cacheData.entries = {};
  const manyFiles = Array.from({ length: 401 }, (_, index) => createMockFile(`Batch/file-${index}.png`, 20000 + index, index + 1));
  plugin.app._files = manyFiles;
  let yieldCalls = 0;
  const originalYieldToUi = plugin.yieldToUi;
  plugin.yieldToUi = async () => {
    yieldCalls += 1;
  };
  await plugin.rebuildImageIndex("smoke-batch-yield");
  assert(yieldCalls >= 2, `Batch image index scan did not yield across chunks, yields=${yieldCalls}`);
  counts = await plugin.getImageCompressionCounts();
  assert(counts.totalImages === manyFiles.length, `Batch image index scan missed files: ${counts.totalImages}/${manyFiles.length}`);
  plugin.yieldToUi = originalYieldToUi;

  const originalFilesForReadyRace = plugin.app._files;
  const originalYieldForReadyRace = plugin.yieldToUi;
  try {
    const readyRaceFiles = Array.from({ length: 301 }, (_, index) => createMockFile(`Race/file-${index}.png`, 20000 + index, index + 1));
    plugin.app._files = readyRaceFiles;
    let releaseRebuildYield = null;
    let rebuildYieldReached = null;
    let readyRaceYieldCount = 0;
    const rebuildYieldReachedPromise = new Promise((resolve) => {
      rebuildYieldReached = resolve;
    });
    plugin.yieldToUi = async () => {
      readyRaceYieldCount += 1;
      if (readyRaceYieldCount > 1) {
        return;
      }
      rebuildYieldReached();
      await new Promise((resolve) => {
        releaseRebuildYield = resolve;
      });
    };
    const rebuildPromise = plugin.rebuildImageIndex("ready-race");
    await rebuildYieldReachedPromise;
    assert(plugin.imageIndex.isReady() === false, "ImageIndex rebuild did not mark index as not ready");
    await plugin.imageIndex.upsert(createMockFile("Race/new-during-rebuild.png", 25000, 999), plugin.cache);
    assert(plugin.imageIndex.isReady() === false, "ImageIndex upsert during rebuild flipped ready=true");
    releaseRebuildYield();
    await rebuildPromise;
    assert(plugin.imageIndex.isReady() === true, "ImageIndex rebuild did not restore ready=true after completion");
    const readyRacePaths = plugin.imageIndex.getAllFiles().map((file) => file.path).sort();
    assert(readyRacePaths.includes("Race/new-during-rebuild.png"), "ImageIndex rebuild lost an upsert that happened during rebuild");
    plugin.imageIndex.ready = false;
    await plugin.imageIndex.upsert(createMockFile("Race/fresh-delta-before-rebuild.png", 25000, 1000), plugin.cache);
    assert(plugin.imageIndex.isReady() === false, "ImageIndex upsert marked a fresh index ready without a rebuild");
  } finally {
    plugin.yieldToUi = originalYieldForReadyRace;
    plugin.app._files = originalFilesForReadyRace;
    await plugin.rebuildImageIndex("ready-race-restore");
  }

  const originalYieldForSavingsUnload = plugin.yieldToUi;
  const originalGetFreshForSavingsUnload = plugin.cache.getFreshEntryForFile;
  try {
    const savingsUnloadFiles = Array.from({ length: 60 }, (_, index) => createMockFile(`Savings/unload-${index}.png`, 20000 + index, index + 1));
    let savingsCacheLookups = 0;
    plugin.isUnloading = false;
    plugin.cache.getFreshEntryForFile = async () => {
      savingsCacheLookups += 1;
      return null;
    };
    plugin.yieldToUi = async () => {
      plugin.isUnloading = true;
    };
    const interruptedSavings = await plugin.savingsCalculator.collectImageStats(savingsUnloadFiles);
    assert(savingsCacheLookups === 50, `Savings calculator continued scanning after unload: ${savingsCacheLookups}`);
    assert(interruptedSavings.totalImages === 60 && interruptedSavings.savings.totalFiles === 60, "Savings calculator did not return a stable interrupted result after unload");
  } finally {
    plugin.yieldToUi = originalYieldForSavingsUnload;
    plugin.cache.getFreshEntryForFile = originalGetFreshForSavingsUnload;
    plugin.isUnloading = false;
  }

  let runningTasks = 0;
  let maxRunningTasks = 0;
  await Promise.all(Array.from({ length: 5 }, () => plugin.runLimitedCompression(async () => {
    runningTasks += 1;
    maxRunningTasks = Math.max(maxRunningTasks, runningTasks);
    await new Promise((resolve) => setImmediate(resolve));
    runningTasks -= 1;
  })));
  assert(maxRunningTasks === plugin.compressor.activeWorkerCount, `Compression concurrency did not match internal worker count: ${maxRunningTasks}/${plugin.compressor.activeWorkerCount}`);

  const originalPlugins = plugin.app.plugins;
  try {
    const guardedPluginId = "obsidian-paste-image-rename";
    let disableCalls = 0;
    let enableCalls = 0;
    plugin.app.plugins = {
      enabledPlugins: new Set([guardedPluginId]),
      disablePlugin: async (id) => {
        disableCalls += 1;
        plugin.app.plugins.enabledPlugins.delete(id);
      },
      enablePlugin: async (id) => {
        enableCalls += 1;
        plugin.app.plugins.enabledPlugins.add(id);
      }
    };

    const originalNoticeForPluginGuard = ObsidianMock.Notice;
    try {
      const guardNotices = [];
      ObsidianMock.Notice = class {
        constructor(message, duration) {
          guardNotices.push({ message, duration });
        }
      };
      await plugin.pluginGuardService.withDisabled([guardedPluginId], async () => {});
      assert(disableCalls === 1, `Plugin guard notice test disabled plugin ${disableCalls} times`);
      assert(enableCalls === 1, `Plugin guard notice test restored plugin ${enableCalls} times`);
      assert(
        guardNotices.some((notice) => String(notice.message).includes("temporarily disabled") && String(notice.message).includes(guardedPluginId) && notice.duration === 5000),
        `Plugin guard did not notify about disable: ${guardNotices.map((notice) => notice.message).join(" | ")}`
      );
      assert(
        guardNotices.some((notice) => String(notice.message).includes("restored") && String(notice.message).includes(guardedPluginId) && notice.duration === 5000),
        `Plugin guard did not notify about restore: ${guardNotices.map((notice) => notice.message).join(" | ")}`
      );
    } finally {
      ObsidianMock.Notice = originalNoticeForPluginGuard;
    }
    disableCalls = 0;
    enableCalls = 0;
    plugin.app.plugins.enabledPlugins = new Set([guardedPluginId]);

    let releaseFirstGuard;
    let resolveFirstEntered;
    const firstEntered = new Promise((resolve) => {
      resolveFirstEntered = resolve;
    });
    const firstGuard = plugin.pluginGuardService.withDisabled([guardedPluginId], async () => {
      resolveFirstEntered();
      await new Promise((resolve) => {
        releaseFirstGuard = resolve;
      });
    });
    await firstEntered;
    assert(disableCalls === 1, `Overlapping guard disabled plugin ${disableCalls} times before second entry`);
    let secondRan = false;
    await plugin.pluginGuardService.withDisabled([guardedPluginId], async () => {
      secondRan = true;
    });
    assert(secondRan, "Second overlapping guard task did not run");
    assert(disableCalls === 1, `Overlapping guard disabled plugin more than once: ${disableCalls}`);
    assert(enableCalls === 0, "Overlapping guard re-enabled plugin before the first guard exited");
    releaseFirstGuard();
    await firstGuard;
    assert(enableCalls === 1, `Overlapping guard did not re-enable exactly once: ${enableCalls}`);

    disableCalls = 0;
    enableCalls = 0;
    plugin.app.plugins.enabledPlugins = new Set();
    await plugin.pluginGuardService.withDisabled([guardedPluginId], async () => {});
    assert(disableCalls === 0, "Pre-disabled plugin was disabled again");
    assert(enableCalls === 0, "Pre-disabled plugin was enabled after guard exit");

    disableCalls = 0;
    enableCalls = 0;
    plugin.app.plugins.enabledPlugins = new Set([guardedPluginId]);
    await plugin.pluginGuardService.acquire(guardedPluginId);
    const userToggledGuard = plugin.pluginGuardService.guards.get(guardedPluginId);
    assert(userToggledGuard, "Plugin guard user-toggle setup did not create a guard");
    userToggledGuard.observedEnabledAfterGuardDisable = true;
    plugin.app.plugins.enabledPlugins.delete(guardedPluginId);
    await plugin.pluginGuardService.release(guardedPluginId);
    assert(enableCalls === 0, "Plugin guard re-enabled a plugin after user/external toggle left it disabled");
    assert(!plugin.app.plugins.enabledPlugins.has(guardedPluginId), "Plugin guard ignored user/external disabled state on release");

    disableCalls = 0;
    enableCalls = 0;
    plugin.app.plugins.enabledPlugins = new Set([guardedPluginId]);
    plugin.settings.disablePasteImageRenameDuringCompression = false;
    try {
      await withTestTimeout("mandatory paste rename guard", plugin.withCompressionGuards(async () => {}), 1000);
      assert(disableCalls === 1, "Legacy Paste Image Rename opt-out prevented the mandatory guard from disabling the plugin");
      assert(enableCalls === 1, "Mandatory Paste Image Rename guard did not restore the plugin");
    } finally {
      delete plugin.settings.disablePasteImageRenameDuringCompression;
    }

    disableCalls = 0;
    enableCalls = 0;
    plugin.app.plugins.enabledPlugins = new Set([guardedPluginId]);
    const originalGuardTimeoutMs = plugin.pluginGuardService.operationTimeoutMs;
    const guardDisableTimeoutWarnings = captureConsoleWarn();
    try {
      plugin.pluginGuardService.operationTimeoutMs = 10;
      plugin.app.plugins.disablePlugin = async () => {
        disableCalls += 1;
        await neverSettlingPromise();
      };
      plugin.app.plugins.enablePlugin = async () => {
        enableCalls += 1;
      };
      let guardedTaskRan = false;
      await withTestTimeout("plugin guard disable timeout", plugin.withCompressionGuards(async () => {
        guardedTaskRan = true;
      }), 1000);
      assert(guardedTaskRan, "Plugin guard timeout prevented the guarded compression task from running");
      assert(disableCalls === 1, `Plugin guard timeout did not attempt to disable the plugin exactly once: ${disableCalls}`);
      assert(enableCalls === 0, `Plugin guard timeout restored before disable completion: ${enableCalls}`);
      assert(guardDisableTimeoutWarnings.messages.some((message) => message.includes("Timed out while trying to disable plugin")), "Plugin guard disable timeout did not emit the expected warning");
    } finally {
      plugin.pluginGuardService.operationTimeoutMs = originalGuardTimeoutMs;
      guardDisableTimeoutWarnings.restore();
    }

    disableCalls = 0;
    enableCalls = 0;
    plugin.app.plugins.enabledPlugins = new Set([guardedPluginId]);
    const originalSetWindowTimeoutForEnableRetry = plugin.setWindowTimeout;
    const originalClearWindowTimeoutForEnableRetry = plugin.clearWindowTimeout;
    const guardEnableRetryWarnings = captureConsoleWarn();
    const enableRetryTimers = [];
    try {
      plugin.pluginGuardService.operationTimeoutMs = 1;
      plugin.setWindowTimeout = (callback, delay) => {
        const timer = { callback, delay, cleared: false };
        enableRetryTimers.push(timer);
        return timer;
      };
      plugin.clearWindowTimeout = (timer) => {
        if (timer) {
          timer.cleared = true;
        }
      };
      plugin.app.plugins.disablePlugin = async () => {
        disableCalls += 1;
        plugin.app.plugins.enabledPlugins.delete(guardedPluginId);
      };
      plugin.app.plugins.enablePlugin = async () => {
        enableCalls += 1;
        if (enableCalls === 1) {
          await neverSettlingPromise();
          return;
        }
        plugin.app.plugins.enabledPlugins.add(guardedPluginId);
      };
      const enableRetryGuard = plugin.withCompressionGuards(async () => {});
      for (let attempt = 0; attempt < 20; attempt++) {
        if (enableRetryTimers.some((timer) => !timer.cleared && timer.delay === 1)) {
          break;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      const enableTimeoutTimer = enableRetryTimers.find((timer) => !timer.cleared && timer.delay === 1);
      assert(enableTimeoutTimer, "Plugin guard enable retry test did not schedule the enable timeout timer");
      enableTimeoutTimer.callback();
      await withTestTimeout("plugin guard enable retry", enableRetryGuard, 1000);
      const retryTimer = enableRetryTimers.find((timer) => !timer.cleared && timer.delay >= 10000);
      assert(retryTimer, "Plugin guard enable timeout did not schedule a retry timer");
      await withTestTimeout("plugin guard enable retry callback", Promise.resolve(retryTimer.callback()), 1000);
      assert(enableCalls >= 2, `Plugin guard enable timeout did not schedule a retry: ${enableCalls}`);
      assert(plugin.app.plugins.enabledPlugins.has(guardedPluginId), "Plugin guard enable retry left the guarded plugin disabled");
      assert(guardEnableRetryWarnings.messages.some((message) => message.includes("Timed out while trying to enable plugin")), "Plugin guard enable timeout did not emit the expected warning");
    } finally {
      plugin.pluginGuardService.operationTimeoutMs = originalGuardTimeoutMs;
      plugin.setWindowTimeout = originalSetWindowTimeoutForEnableRetry;
      plugin.clearWindowTimeout = originalClearWindowTimeoutForEnableRetry;
      guardEnableRetryWarnings.restore();
    }

    disableCalls = 0;
    enableCalls = 0;
    const parallelGuardIds = ["parallel-guard-one", "parallel-guard-two", "parallel-guard-three"];
    plugin.app.plugins.enabledPlugins = new Set(parallelGuardIds);
    const parallelReleaseTimers = [];
    const parallelReleaseWarnings = captureConsoleWarn();
    try {
      plugin.pluginGuardService.operationTimeoutMs = 37;
      plugin.setWindowTimeout = (callback, delay) => {
        const timer = { callback, delay, cleared: false };
        parallelReleaseTimers.push(timer);
        return timer;
      };
      plugin.clearWindowTimeout = (timer) => {
        if (timer) {
          timer.cleared = true;
        }
      };
      plugin.app.plugins.disablePlugin = async (id) => {
        disableCalls += 1;
        plugin.app.plugins.enabledPlugins.delete(id);
      };
      plugin.app.plugins.enablePlugin = async () => {
        enableCalls += 1;
        await neverSettlingPromise();
      };
      const parallelRelease = plugin.pluginGuardService.withDisabled(parallelGuardIds, async () => {});
      for (let attempt = 0; attempt < 20; attempt++) {
        const activeReleaseTimers = parallelReleaseTimers.filter((timer) => !timer.cleared && timer.delay === 37);
        if (activeReleaseTimers.length >= parallelGuardIds.length) {
          break;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      const activeReleaseTimers = parallelReleaseTimers.filter((timer) => !timer.cleared && timer.delay === 37);
      assert(activeReleaseTimers.length === parallelGuardIds.length, `withDisabled() did not start guard releases in parallel: ${activeReleaseTimers.length}/${parallelGuardIds.length}`);
      activeReleaseTimers.forEach((timer) => timer.callback());
      await withTestTimeout("parallel guard release timeout", parallelRelease, 1000);
      assert(enableCalls === parallelGuardIds.length, `Parallel guard release did not attempt every restore: ${enableCalls}/${parallelGuardIds.length}`);
      assert(plugin.pluginGuardService.guards.size === 0, "Parallel guard release left guard state behind");
      assert(parallelReleaseWarnings.messages.filter((message) => message.includes("Timed out while trying to enable plugin")).length === parallelGuardIds.length, "Parallel guard release did not warn for every timed-out restore");
    } finally {
      plugin.pluginGuardService.operationTimeoutMs = originalGuardTimeoutMs;
      plugin.setWindowTimeout = originalSetWindowTimeoutForEnableRetry;
      plugin.clearWindowTimeout = originalClearWindowTimeoutForEnableRetry;
      parallelReleaseWarnings.restore();
    }

    disableCalls = 0;
    enableCalls = 0;
    plugin.app.plugins.enabledPlugins = new Set([guardedPluginId]);
    let resolveLateDisable;
    const lateDisableFinished = new Promise((resolve) => {
      resolveLateDisable = resolve;
    });
    let resolveLateDisableRestore;
    const lateDisableRestoreFinished = new Promise((resolve) => {
      resolveLateDisableRestore = resolve;
    });
    const replacementGuardWarnings = captureConsoleWarn();
    try {
      plugin.pluginGuardService.operationTimeoutMs = 10;
      plugin.app.plugins.disablePlugin = async () => {
        disableCalls += 1;
        await lateDisableFinished;
        plugin.app.plugins.enabledPlugins.delete(guardedPluginId);
      };
      plugin.app.plugins.enablePlugin = async () => {
        enableCalls += 1;
        plugin.app.plugins.enabledPlugins.add(guardedPluginId);
        resolveLateDisableRestore();
      };
      await withTestTimeout("replacement guard timeout", plugin.withCompressionGuards(async () => {}), 1000);
      assert(enableCalls === 0, `Timed-out guard release restored before late disable completion: ${enableCalls}`);
      resolveLateDisable();
      await withTestTimeout("late disable restore completion", lateDisableRestoreFinished, 1000);
      assert(enableCalls === 1, `Late disable completion was not followed by restore: ${enableCalls}`);
      assert(plugin.app.plugins.enabledPlugins.has(guardedPluginId), "Late disable completion left the guarded plugin disabled");
      assert(replacementGuardWarnings.messages.some((message) => message.includes("Timed out while trying to disable plugin")), "Replacement guard timeout did not emit the expected warning");
    } finally {
      plugin.pluginGuardService.operationTimeoutMs = originalGuardTimeoutMs;
      replacementGuardWarnings.restore();
    }

    disableCalls = 0;
    enableCalls = 0;
    plugin.app.plugins.enabledPlugins = new Set([guardedPluginId]);
    let resolveFirstLateDisable;
    const firstLateDisableFinished = new Promise((resolve) => {
      resolveFirstLateDisable = resolve;
    });
    let resolveFirstLateDisableReturned;
    const firstLateDisableReturned = new Promise((resolve) => {
      resolveFirstLateDisableReturned = resolve;
    });
    const firstLateDisableWarnings = captureConsoleWarn();
    try {
      plugin.pluginGuardService.operationTimeoutMs = 10;
      plugin.app.plugins.disablePlugin = async () => {
        disableCalls += 1;
        const isFirstDisableCall = disableCalls === 1;
        if (isFirstDisableCall) {
          await firstLateDisableFinished;
        }
        plugin.app.plugins.enabledPlugins.delete(guardedPluginId);
        if (isFirstDisableCall) {
          resolveFirstLateDisableReturned();
        }
      };
      plugin.app.plugins.enablePlugin = async () => {
        enableCalls += 1;
        plugin.app.plugins.enabledPlugins.add(guardedPluginId);
      };
      await withTestTimeout("first late disable guard timeout", plugin.withCompressionGuards(async () => {}), 1000);
      assert(enableCalls === 0, `First timed-out guard restored before late disable completion: ${enableCalls}`);
      let releaseSecondGuard;
      let resolveSecondEntered;
      const secondEntered = new Promise((resolve) => {
        resolveSecondEntered = resolve;
      });
      const secondGuard = plugin.pluginGuardService.withDisabled([guardedPluginId], async () => {
        resolveSecondEntered();
        await new Promise((resolve) => {
          releaseSecondGuard = resolve;
        });
      });
      await secondEntered;
      assert(disableCalls === 2, `Second guard did not disable the plugin before late restore test: ${disableCalls}`);
      assert(!plugin.app.plugins.enabledPlugins.has(guardedPluginId), "Second guard did not leave the plugin disabled during guarded work");
      resolveFirstLateDisable();
      await withTestTimeout("first late disable completion", firstLateDisableReturned, 1000);
      await Promise.resolve();
      assert(enableCalls === 0, `Late disable restore re-enabled plugin during an active replacement guard: ${enableCalls}`);
      assert(!plugin.app.plugins.enabledPlugins.has(guardedPluginId), "Late disable restore enabled plugin during an active replacement guard");
      releaseSecondGuard();
      await secondGuard;
      assert(enableCalls === 1, `Second guard did not restore plugin after release: ${enableCalls}`);
      assert(plugin.app.plugins.enabledPlugins.has(guardedPluginId), "Second guard release left plugin disabled");
      assert(firstLateDisableWarnings.messages.some((message) => message.includes("Timed out while trying to disable plugin")), "First late disable timeout did not emit the expected warning");
    } finally {
      plugin.pluginGuardService.operationTimeoutMs = originalGuardTimeoutMs;
      firstLateDisableWarnings.restore();
    }

    disableCalls = 0;
    enableCalls = 0;
    plugin.app.plugins.enabledPlugins = new Set([guardedPluginId]);
    plugin.app.plugins.disablePlugin = async (id) => {
      disableCalls += 1;
      plugin.app.plugins.enabledPlugins.delete(id);
    };
    plugin.app.plugins.enablePlugin = async (id) => {
      enableCalls += 1;
      plugin.app.plugins.enabledPlugins.add(id);
    };
    await plugin.pluginGuardService.acquire(guardedPluginId);
    assert(disableCalls === 1 && !plugin.app.plugins.enabledPlugins.has(guardedPluginId), "Plugin guard unload setup did not disable the guarded plugin");
    await plugin.pluginGuardService.releaseAllGuards();
    assert(enableCalls === 1, `releaseAllGuards did not restore the guarded plugin exactly once: ${enableCalls}`);
    assert(plugin.app.plugins.enabledPlugins.has(guardedPluginId), "releaseAllGuards left the guarded plugin disabled");
    assert(plugin.pluginGuardService.guards.size === 0, "releaseAllGuards did not clear guard state");

    disableCalls = 0;
    enableCalls = 0;
    plugin.app.plugins.enabledPlugins = new Set([guardedPluginId]);
    await plugin.pluginGuardService.acquire(guardedPluginId);
    const userToggledUnloadGuard = plugin.pluginGuardService.guards.get(guardedPluginId);
    assert(userToggledUnloadGuard, "Plugin guard unload user-toggle setup did not create a guard");
    userToggledUnloadGuard.observedEnabledAfterGuardDisable = true;
    plugin.app.plugins.enabledPlugins.delete(guardedPluginId);
    await plugin.pluginGuardService.releaseAllGuards();
    assert(enableCalls === 0, "releaseAllGuards re-enabled a plugin after user/external toggle left it disabled");
    assert(!plugin.app.plugins.enabledPlugins.has(guardedPluginId), "releaseAllGuards ignored user/external disabled state");
    assert(plugin.pluginGuardService.guards.size === 0, "releaseAllGuards did not clear user-toggle guard state");
  } finally {
    plugin.app.plugins = originalPlugins;
  }

  const originalSetWindowTimeout = plugin.setWindowTimeout;
  const originalClearWindowTimeout = plugin.clearWindowTimeout;
  const originalIsUserInactive = plugin.backgroundCompressionService.isUserInactive;
  const originalCheckAndStartBackgroundCompression = plugin.backgroundCompressionService.checkAndStartBackgroundCompression;
  const originalAutoBackgroundCompression = plugin.settings.autoBackgroundCompression;
  try {
    const inactivityTimers = [];
    plugin.setWindowTimeout = (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      inactivityTimers.push(timer);
      return timer;
    };
    plugin.clearWindowTimeout = (timer) => {
      if (timer) {
        timer.cleared = true;
      }
    };
    plugin.backgroundCompressionService.inactivityTimer = null;
    plugin.backgroundCompressionService.inactivityCheckActive = false;
    plugin.isUnloading = false;
    plugin.settings.autoBackgroundCompression = true;
    plugin.backgroundCompressionService.isUserInactive = () => true;
    let backgroundChecks = 0;
    plugin.backgroundCompressionService.checkAndStartBackgroundCompression = async () => {
      backgroundChecks += 1;
      plugin.onunload();
    };
    plugin.backgroundCompressionService.startInactivityCheck();
    assert(inactivityTimers.length === 1, "Inactivity check did not schedule its initial timer");
    await inactivityTimers[0].callback();
    assert(backgroundChecks === 1, "Inactivity check did not run background compression callback");
    assert(inactivityTimers.length === 1, "Inactivity check rescheduled itself after unload");
    assert(plugin.backgroundCompressionService.inactivityCheckActive === false, "Inactivity check stayed active after unload");
  } finally {
    plugin.setWindowTimeout = originalSetWindowTimeout;
    plugin.clearWindowTimeout = originalClearWindowTimeout;
    plugin.backgroundCompressionService.isUserInactive = originalIsUserInactive;
    plugin.backgroundCompressionService.checkAndStartBackgroundCompression = originalCheckAndStartBackgroundCompression;
    plugin.settings.autoBackgroundCompression = originalAutoBackgroundCompression;
    plugin.isUnloading = false;
    plugin.backgroundCompressionService.inactivityCheckActive = false;
    plugin.backgroundCompressionService.inactivityTimer = null;
  }

  const migrationTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-migration-"));
  const originalCacheFile = plugin.cache.cacheFile;
  const originalCacheBackupsDir = plugin.cache.cacheBackupsDir;
  const originalCacheData = plugin.cache.cacheData;
  const setCacheTestFile = (cacheFile, cacheBackupsDir = path.join(path.dirname(cacheFile), "cache-backups")) => {
    plugin.cache.cacheFile = cacheFile;
    plugin.cache.cacheBackupsDir = cacheBackupsDir;
  };
  const restoreCacheTestPaths = () => {
    plugin.cache.cacheFile = originalCacheFile;
    plugin.cache.cacheBackupsDir = originalCacheBackupsDir;
  };
  try {
    const migrationCacheFile = path.join(migrationTemp, "tinyLocal-cache.json");
    fs.writeFileSync(migrationCacheFile, JSON.stringify({
      version: "0.9.0",
      entries: {
        [`Folder:WithColon/image.png:${MOCK_MD5}:123`]: {
          md5: MOCK_MD5,
          mtime: 123,
          timestamp: 1,
          originalSize: 1000
        },
        "Skipped/raw.png": {
          skipped: true,
          reason: "pngquant_quality_failed",
          timestamp: 1,
          sourceMtime: 5,
          sourceSize: 100
        }
      }
    }, null, 2));
    setCacheTestFile(migrationCacheFile);
    plugin.cache.loadCacheSync();
    assert(plugin.cache.cacheData.version === plugin.cache.CACHE_VERSION, "Cache version mismatch was not migrated");
    assert(plugin.cache.getEntriesForPath("Folder:WithColon/image.png").length === 1, "Legacy cache key with ':' in path was not parsed from the right");
    assert(plugin.cache.getEntriesForPath("Skipped/raw.png").length === 1, "Raw skipped cache key was not preserved");
    const migratedColonEntry = plugin.cache.getEntriesForPath("Folder:WithColon/image.png")[0][1];
    const migratedSkippedEntry = plugin.cache.getEntriesForPath("Skipped/raw.png")[0][1];
    assert(migratedColonEntry.path === "Folder:WithColon/image.png", `Migrated entry path is wrong: ${migratedColonEntry.path}`);
    assert(migratedSkippedEntry.state === "skipped", "Legacy skipped flag was not migrated to canonical state");
    assert(migratedSkippedEntry.skipReason === "pngquant_quality_failed" && !Object.prototype.hasOwnProperty.call(migratedSkippedEntry, "reason"), "Legacy cache reason was not migrated to skipReason");
    assert(!Object.prototype.hasOwnProperty.call(migratedSkippedEntry, "skipped"), "Legacy skipped flag survived cache migration");
    plugin.cache.cacheData.entries["v2:malformed-no-path"] = { timestamp: 1 };
    assert(!plugin.cache.getEntriesByPathMap().has(""), "Cache path map indexed a malformed empty-path entry");
    const migrationBackups = fs.readdirSync(path.join(migrationTemp, "cache-backups")).filter((name) => name.startsWith("tinyLocal-cache-backup-"));
    assert(migrationBackups.length === 1, "Cache migration did not create a backup");
  } finally {
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(migrationTemp, { recursive: true, force: true });
  }

  const corruptCacheTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-corrupt-cache-"));
  try {
    const corruptCacheFile = path.join(corruptCacheTemp, "tinyLocal-cache.json");
    fs.writeFileSync(corruptCacheFile, "{ invalid json");
    setCacheTestFile(corruptCacheFile);
    await plugin.cache.loadCache();
    assert(plugin.cache.lastLoadError, "Corrupt async cache load did not record lastLoadError");
    assert(plugin.cache.brokenCacheBackupPath, "Corrupt async cache load did not record brokenCacheBackupPath");
    assert(fs.existsSync(plugin.cache.brokenCacheBackupPath), "Corrupt async cache load did not create a broken cache copy");
    assert(plugin.cache.brokenCacheBackupPath.includes(path.join("cache-backups", "broken")), "Broken async cache copy was not placed under cache-backups/broken");
    assert(fs.readFileSync(plugin.cache.brokenCacheBackupPath, "utf8") === "{ invalid json", "Broken async cache copy does not preserve original corrupt content");
    assert(Object.keys(plugin.cache.cacheData.entries).length === 0, "Corrupt async cache load did not fall back to an empty in-memory cache");
    const asyncBrokenDir = path.dirname(plugin.cache.brokenCacheBackupPath);
    const asyncBrokenCount = fs.readdirSync(asyncBrokenDir).filter((name) => name.startsWith("tinyLocal-cache.broken-")).length;
    assert(JSON.parse(fs.readFileSync(corruptCacheFile, "utf8")).version === plugin.cache.CACHE_VERSION, "Corrupt async cache file was not replaced with an empty valid cache");
    await plugin.cache.loadCache();
    const asyncBrokenCountAfterReload = fs.readdirSync(asyncBrokenDir).filter((name) => name.startsWith("tinyLocal-cache.broken-")).length;
    assert(asyncBrokenCountAfterReload === asyncBrokenCount, "Valid empty cache reload created an extra broken cache copy");

    const corruptSyncCacheFile = path.join(corruptCacheTemp, "tinyLocal-cache-sync.json");
    fs.writeFileSync(corruptSyncCacheFile, "{ invalid json sync");
    setCacheTestFile(corruptSyncCacheFile);
    plugin.cache.loadCacheSync();
    assert(plugin.cache.lastLoadError, "Corrupt sync cache load did not record lastLoadError");
    assert(plugin.cache.brokenCacheBackupPath, "Corrupt sync cache load did not record brokenCacheBackupPath");
    assert(fs.existsSync(plugin.cache.brokenCacheBackupPath), "Corrupt sync cache load did not create a broken cache copy");
    assert(plugin.cache.brokenCacheBackupPath.includes(path.join("cache-backups", "broken")), "Broken sync cache copy was not placed under cache-backups/broken");
    assert(fs.readFileSync(plugin.cache.brokenCacheBackupPath, "utf8") === "{ invalid json sync", "Broken sync cache copy does not preserve original corrupt content");
    assert(JSON.parse(fs.readFileSync(corruptSyncCacheFile, "utf8")).version === plugin.cache.CACHE_VERSION, "Corrupt sync cache file was not replaced with an empty valid cache");

    const originalWriteCacheFileAtomic = plugin.cache.writeCacheFileAtomic;
    const originalWriteCacheFileSyncAtomic = plugin.cache.writeCacheFileSyncAtomic;
    const originalConsoleErrorForBrokenRecovery = console.error;
    let brokenRecoveryLogs = 0;
    try {
      console.error = (...args) => {
        if (String(args[1] || "").includes("Broken cache recovery failed")) {
          brokenRecoveryLogs += 1;
        }
      };

      const recoveryAsyncCacheFile = path.join(corruptCacheTemp, "tinyLocal-cache-recovery-async.json");
      fs.writeFileSync(recoveryAsyncCacheFile, "{ invalid recovery async");
      setCacheTestFile(recoveryAsyncCacheFile);
      plugin.cache.writeCacheFileAtomic = async () => {
        throw new Error("simulated async recovery write failure");
      };
      await plugin.cache.loadCache();
      assert(plugin.cache.brokenCacheBackupPath, "Async recovery write failure did not keep a broken cache backup path");
      assert(fs.existsSync(plugin.cache.brokenCacheBackupPath), "Async recovery write failure did not preserve a broken cache copy");
      assert(fs.readFileSync(recoveryAsyncCacheFile, "utf8") === "{ invalid recovery async", "Async recovery write failure unexpectedly rewrote the corrupt cache");

      const recoverySyncCacheFile = path.join(corruptCacheTemp, "tinyLocal-cache-recovery-sync.json");
      fs.writeFileSync(recoverySyncCacheFile, "{ invalid recovery sync");
      setCacheTestFile(recoverySyncCacheFile);
      plugin.cache.writeCacheFileSyncAtomic = () => {
        throw new Error("simulated sync recovery write failure");
      };
      plugin.cache.loadCacheSync();
      assert(plugin.cache.brokenCacheBackupPath, "Sync recovery write failure did not keep a broken cache backup path");
      assert(fs.existsSync(plugin.cache.brokenCacheBackupPath), "Sync recovery write failure did not preserve a broken cache copy");
      assert(fs.readFileSync(recoverySyncCacheFile, "utf8") === "{ invalid recovery sync", "Sync recovery write failure unexpectedly rewrote the corrupt cache");
      assert(brokenRecoveryLogs === 2, `Broken cache recovery logged wrong number of failures: ${brokenRecoveryLogs}`);
    } finally {
      plugin.cache.writeCacheFileAtomic = originalWriteCacheFileAtomic;
      plugin.cache.writeCacheFileSyncAtomic = originalWriteCacheFileSyncAtomic;
      console.error = originalConsoleErrorForBrokenRecovery;
    }
  } finally {
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    plugin.cache.lastLoadError = null;
    plugin.cache.brokenCacheBackupPath = null;
    fs.rmSync(corruptCacheTemp, { recursive: true, force: true });
  }

  const ghostTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-ghosts-"));
  try {
    plugin.app.vault.adapter.basePath = ghostTemp;
    plugin.app.vault.adapter.path.absolute = ghostTemp;
    const existingGhostFile = path.join(ghostTemp, "Existing", "ok.png");
    fs.mkdirSync(path.dirname(existingGhostFile), { recursive: true });
    fs.writeFileSync(existingGhostFile, Buffer.alloc(10));
    plugin.cache.cacheData.entries = {
      [plugin.cache.buildCacheKey("Existing/ok.png", MOCK_MD5, 1)]: {
        path: "Existing/ok.png",
        timestamp: 1
      },
      ...Object.fromEntries(Array.from({ length: 401 }, (_, index) => [
        plugin.cache.buildCacheKey(`Missing/file-${index}.png`, MOCK_MD5, index + 1),
        {
          path: `Missing/file-${index}.png`,
          timestamp: index + 1
        }
      ]))
    };
    const originalExistsSync = fs.existsSync;
    const originalCacheYieldToUi = plugin.cache.yieldToUi;
    const originalCacheCreateBackup = plugin.cache.createBackup;
    const originalCacheSaveCache = plugin.cache.saveCache;
    let ghostYieldCalls = 0;
    let ghostBackupCalls = 0;
    let ghostSaveCalls = 0;
    try {
      fs.existsSync = () => {
        throw new Error("ghost paths must not use fs.existsSync");
      };
      plugin.cache.yieldToUi = async () => {
        ghostYieldCalls += 1;
      };
      plugin.cache.createBackup = () => {
        ghostBackupCalls += 1;
      };
      plugin.cache.saveCache = async () => {
        ghostSaveCalls += 1;
      };
      const ghostCount = await plugin.cache.getGhostEntriesCount();
      assert(ghostCount === 401, `Async ghost count returned wrong count: ${ghostCount}`);
      assert(ghostYieldCalls >= 2, `Async ghost count did not yield across batches: ${ghostYieldCalls}`);
      const removedGhosts = await plugin.cache.cleanupGhostEntries();
      assert(removedGhosts === 401, `Async ghost cleanup removed wrong count: ${removedGhosts}`);
      assert(ghostBackupCalls === 1, `Ghost cleanup created backup wrong number of times: ${ghostBackupCalls}`);
      assert(ghostSaveCalls === 1, `Ghost cleanup saved cache wrong number of times: ${ghostSaveCalls}`);
      assert(plugin.cache.getEntriesForPath("Existing/ok.png").length === 1, "Ghost cleanup removed an existing file entry");

      ghostBackupCalls = 0;
      ghostSaveCalls = 0;
      const removedNone = await plugin.cache.cleanupGhostEntries();
      assert(removedNone === 0, "Ghost cleanup removed entries when no ghosts remained");
      assert(ghostBackupCalls === 0, "Ghost cleanup created backup when no ghosts were removed");
      assert(ghostSaveCalls === 0, "Ghost cleanup saved cache when no ghosts were removed");
    } finally {
      fs.existsSync = originalExistsSync;
      plugin.cache.yieldToUi = originalCacheYieldToUi;
      plugin.cache.createBackup = originalCacheCreateBackup;
      plugin.cache.saveCache = originalCacheSaveCache;
    }
  } finally {
    plugin.app.vault.adapter.basePath = root;
    plugin.app.vault.adapter.path.absolute = root;
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(ghostTemp, { recursive: true, force: true });
  }

  try {
    const now = Date.now();
    const oldTimestamp = now - 13 * 30 * 24 * 60 * 60 * 1000;
    const recentTimestamp = now - 2 * 24 * 60 * 60 * 1000;
    const oldKey = plugin.cache.buildCacheKey("Images/old-cache.png", MOCK_MD5, oldTimestamp);
    const recentKey = plugin.cache.buildCacheKey("Images/recent-cache.png", MOCK_MD5, recentTimestamp);
    const unknownKey = "legacy:path-only-cache";
    plugin.cache.cacheData = plugin.cache.getEmptyCacheData();
    plugin.cache.cacheData.entries = {
      [oldKey]: {
        path: "Images/old-cache.png",
        timestamp: oldTimestamp,
        lastAccessMs: oldTimestamp
      },
      [recentKey]: {
        path: "Images/recent-cache.png",
        timestamp: oldTimestamp,
        lastAccessMs: recentTimestamp
      },
      [unknownKey]: {
        path: "Images/path-only-cache.png"
      }
    };
    const originalCacheCreateBackupForPrune = plugin.cache.createBackup;
    const originalCacheSaveCacheForPrune = plugin.cache.saveCache;
    let pruneBackupCalls = 0;
    let pruneSaveCalls = 0;
    try {
      plugin.cache.createBackup = async () => {
        pruneBackupCalls += 1;
      };
      plugin.cache.saveCache = async () => {
        pruneSaveCalls += 1;
      };
      const prunedCount = await plugin.cache.pruneStaleCacheEntries(12, now);
      assert(prunedCount === 1, `Stale cache retention pruned wrong number of entries: ${prunedCount}`);
      assert(!plugin.cache.cacheData.entries[oldKey], "Stale cache retention kept an expired entry");
      assert(plugin.cache.cacheData.entries[recentKey], "Stale cache retention removed a recently accessed entry");
      assert(plugin.cache.cacheData.entries[unknownKey], "Stale cache retention removed an entry with no retention timestamp");
      assert(pruneBackupCalls === 1 && pruneSaveCalls === 1, "Stale cache retention did not back up and save exactly once");

      const touchKey = plugin.cache.buildCacheKey("Images/touched-cache.png", MOCK_MD5, oldTimestamp);
      plugin.cache.cacheData.entries = {
        [touchKey]: {
          path: "Images/touched-cache.png",
          timestamp: oldTimestamp
        }
      };
      const touchedFile = createMockFile("Images/touched-cache.png", 50000, oldTimestamp);
      const freshEntry = await plugin.cache.getFreshEntryForFile(touchedFile);
      assert(freshEntry?.cacheKey === touchKey, "Fresh cache lookup did not return the touched entry");
      assert(plugin.cache.cacheData.entries[touchKey].lastAccessMs >= now, "Fresh cache lookup did not update lastAccessMs");
      const untouchedPrunedCount = await plugin.cache.pruneStaleCacheEntries(12, Date.now());
      assert(untouchedPrunedCount === 0, "Stale cache retention pruned an entry touched during lookup");
    } finally {
      plugin.cache.createBackup = originalCacheCreateBackupForPrune;
      plugin.cache.saveCache = originalCacheSaveCacheForPrune;
    }
  } finally {
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
  }

  const validCacheBackupNames = [
    "tinyLocal-cache-backup-2026-05-15T00-00-00-000.json",
    "tinyLocal-cache-backup-2026-05-15T00-00-00-deadbeef.json",
    "tinyLocal-cache-backup-2026-05-15T00-00-00-000-deadbeefcafebabe.json",
    "tinyLocal-cache-backup-2026-05-15T00-00-00-000-deadbeefcafebabe0123456789abcdef.json"
  ];
  for (const backupName of validCacheBackupNames) {
    assert(plugin.cache.isValidBackupFileName(backupName), `Valid cache backup filename was rejected: ${backupName}`);
  }
  const invalidCacheBackupNames = [
    "../tinyLocal-cache-backup-2026-05-15T00-00-00-000.json",
    "nested/tinyLocal-cache-backup-2026-05-15T00-00-00-000.json",
    "tinyLocal-cache-backup-2026-05-15T00-00-00-000-deadbeefcafebabe.txt",
    "tinyLocal-cache-backup-2026-05-15T00-00-00-000-deadbee.json",
    "tinyLocal-cache-backup-old-00.json"
  ];
  for (const backupName of invalidCacheBackupNames) {
    assert(!plugin.cache.isValidBackupFileName(backupName), `Invalid cache backup filename was accepted: ${backupName}`);
  }

  const restoreTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-restore-"));
  try {
    const restoreCacheFile = path.join(restoreTemp, "tinyLocal-cache.json");
    const restoreBackupDir = path.join(restoreTemp, "cache-backups");
    const restoreBackupName = "tinyLocal-cache-backup-2026-05-15T00-00-00-000-deadbeefcafebabe.json";
    fs.mkdirSync(restoreBackupDir, { recursive: true });
    fs.writeFileSync(restoreCacheFile, JSON.stringify({
      version: plugin.cache.CACHE_VERSION,
      entries: {}
    }, null, 2));
    fs.writeFileSync(path.join(restoreBackupDir, restoreBackupName), JSON.stringify({
      version: plugin.cache.CACHE_VERSION,
      entries: {
        "Images/restored.png": {
          path: "Images/restored.png",
          timestamp: 1234,
          originalSize: 1000
        }
      }
    }, null, 2));
    setCacheTestFile(restoreCacheFile);
    assert(plugin.cache.isValidBackupFileName(restoreBackupName), "restoreFromBackup() rejects the current backup filename format");
    const restored = await plugin.cache.restoreFromBackup(restoreBackupName);
    assert(restored, "restoreFromBackup() did not restore the selected backup");
    const restoredEntry = plugin.cache.getEntriesForPath("Images/restored.png")[0]?.[1];
    assert(restoredEntry && restoredEntry.timestamp === 1234, `restoreFromBackup() changed entry timestamp: ${restoredEntry && restoredEntry.timestamp}`);
  } finally {
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(restoreTemp, { recursive: true, force: true });
  }

  const normalizedFutureCache = plugin.cache.normalizeCacheData({
    version: "99.0.0",
    futureMetadata: {
      shouldSurvive: true
    },
    entries: {
      "Images/future.png": {
        path: "Images/future.png",
        timestamp: 1,
        originalSize: 100
      }
    }
  }).data;
  assert(normalizedFutureCache.futureMetadata?.shouldSurvive === true, "normalizeCacheData() dropped unknown future cache metadata");
  assert(normalizedFutureCache.version === plugin.cache.CACHE_VERSION, "normalizeCacheData() did not keep the current cache version");
  const sourceCacheForClone = {
    version: plugin.cache.CACHE_VERSION,
    futureMetadata: {
      nested: {
        value: "keep"
      }
    },
    entries: {
      "Images/deep-clone.png": {
        path: "Images/deep-clone.png",
        meta: {
          value: "source"
        }
      }
    }
  };
  const normalizedCloneCache = plugin.cache.normalizeCacheData(sourceCacheForClone).data;
  normalizedCloneCache.futureMetadata.nested.value = "changed";
  normalizedCloneCache.entries["Images/deep-clone.png"].meta.value = "changed";
  assert(sourceCacheForClone.futureMetadata.nested.value === "keep", "normalizeCacheData() leaked top-level nested mutations to source data");
  assert(sourceCacheForClone.entries["Images/deep-clone.png"].meta.value === "source", "normalizeCacheData() leaked entry nested mutations to source data");
  const originalConsoleWarnForNormalize = console.warn;
  let invalidNormalizeWarnings = 0;
  try {
    console.warn = () => {
      invalidNormalizeWarnings += 1;
    };
    const normalizedArrayEntries = plugin.cache.normalizeCacheData({ version: plugin.cache.CACHE_VERSION, entries: [] });
    const normalizedCallableEntry = plugin.cache.normalizeCacheData({ version: plugin.cache.CACHE_VERSION, entries: { bad: () => null } });
    assert(Object.keys(normalizedArrayEntries.data.entries).length === 0, "normalizeCacheData() accepted array entries");
    assert(Object.keys(normalizedCallableEntry.data.entries).length === 0, "normalizeCacheData() accepted callable entries");
    assert(invalidNormalizeWarnings >= 2, "normalizeCacheData() did not warn for invalid entries shapes");
  } finally {
    console.warn = originalConsoleWarnForNormalize;
  }

  const invalidMtimeNaN = plugin.cache.normalizeMtime(NaN);
  const invalidMtimeInfinity = plugin.cache.normalizeMtime(Infinity);
  const invalidMtimeNull = plugin.cache.normalizeMtime(null);
  assert(invalidMtimeNaN > 0 && invalidMtimeInfinity > 0 && invalidMtimeNull > 0, "Invalid mtime fallback returned epoch 0");
  assert(new Set([invalidMtimeNaN, invalidMtimeInfinity, invalidMtimeNull]).size === 3, "Invalid mtime fallback is not monotonic");
  const invalidMtimeKeyA = plugin.cache.buildCacheKey("Images/invalid-mtime.png", MOCK_MD5, NaN);
  const invalidMtimeKeyB = plugin.cache.buildCacheKey("Images/invalid-mtime.png", MOCK_MD5, Infinity);
  assert(invalidMtimeKeyA !== invalidMtimeKeyB, "Invalid mtime cache keys collide for the same file/md5");

  const unicodeNfcPath = "Images/caf\u00e9.png".normalize("NFC");
  const unicodeNfdPath = "Images/caf\u00e9.png".normalize("NFD");
  assert(unicodeNfcPath !== unicodeNfdPath, "Unicode path fixture must use distinct NFC/NFD byte forms");
  const unicodeNfcKey = plugin.cache.buildCacheKey(unicodeNfcPath, MOCK_MD5, 123);
  const unicodeNfdKey = plugin.cache.buildCacheKey(unicodeNfdPath, MOCK_MD5, 123);
  const unicodeDoubleSlashKey = plugin.cache.buildCacheKey("Images//caf\u00e9.png", MOCK_MD5, 123);
  assert(unicodeNfcKey === unicodeNfdKey, "Cache key normalization does not collapse Unicode NFC/NFD variants");
  assert(unicodeNfcKey === unicodeDoubleSlashKey, "Cache key normalization does not collapse duplicate path separators");
  const migratedUnicodeCache = plugin.cache.normalizeCacheData({
    version: plugin.cache.CACHE_VERSION,
    entries: {
      [`${unicodeNfdPath}:${MOCK_MD5}:123`]: {
        path: unicodeNfdPath,
        md5: MOCK_MD5,
        mtime: 123,
        timestamp: 1
      }
    }
  }).data;
  assert(migratedUnicodeCache.entries[unicodeNfcKey]?.path === unicodeNfcPath, "normalizeCacheData() did not migrate legacy Unicode paths to NFC v2 keys");
  if (process.platform === "win32" || process.platform === "darwin") {
    const originalAllowedRootsForCase = plugin.settings.allowedRoots;
    try {
      plugin.settings.allowedRoots = ["images"];
      assert(plugin.isAllowedPath("Images/CaseSensitive.jpg"), "Allowed roots should compare case-insensitively on this platform");
      plugin.cache.cacheData.entries = {
        [plugin.cache.buildCacheKey("Images/CaseSensitive.jpg", MOCK_MD5, 124)]: {
          path: "Images/CaseSensitive.jpg",
          md5: MOCK_MD5,
          mtime: 124,
          timestamp: 1
        }
      };
      assert(plugin.cache.getEntriesForPath("images/casesensitive.jpg").length === 1, "Cache path lookup should compare case-insensitively on this platform");
    } finally {
      plugin.settings.allowedRoots = originalAllowedRootsForCase;
      plugin.cache.cacheData = originalCacheData;
    }
  }

  const backupSuffixTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-backup-suffix-"));
  try {
    setCacheTestFile(path.join(backupSuffixTemp, "tinyLocal-cache.json"));
    fs.writeFileSync(plugin.cache.cacheFile, JSON.stringify(plugin.cache.getEmptyCacheData(), null, 2));
    await plugin.cache.createBackup();
    await plugin.cache.createBackup();
    const backupNames = fs.readdirSync(path.join(backupSuffixTemp, "cache-backups"));
    assert(backupNames.length === 2, `Cache backups collided or were overwritten: ${backupNames.join(", ")}`);
    assert(
      backupNames.every((name) => /^tinyLocal-cache-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}-[0-9a-f]{32}\.json$/i.test(name)),
      `Cache backups do not keep millisecond timestamps and 32-hex random suffixes: ${backupNames.join(", ")}`
    );
  } finally {
    restoreCacheTestPaths();
    fs.rmSync(backupSuffixTemp, { recursive: true, force: true });
  }

  const cleanupBackupsTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-cleanup-"));
  try {
    setCacheTestFile(path.join(cleanupBackupsTemp, "tinyLocal-cache.json"), cleanupBackupsTemp);
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    for (let index = 0; index < 12; index++) {
      const backupPath = path.join(cleanupBackupsTemp, `tinyLocal-cache-backup-old-${String(index).padStart(2, "0")}.json`);
      fs.writeFileSync(backupPath, "{}");
      fs.utimesSync(backupPath, oldTime, oldTime);
    }
    await plugin.cache.cleanupOldBackups(cleanupBackupsTemp);
    assert(fs.readdirSync(cleanupBackupsTemp).length === 10, "Cache backup cleanup did not keep exactly the latest 10 old backups");
    const retainedSameMtimeBackups = fs.readdirSync(cleanupBackupsTemp).filter((name) => name.startsWith("tinyLocal-cache-backup-old-")).sort();
    assert(!retainedSameMtimeBackups.includes("tinyLocal-cache-backup-old-00.json"), "Cache backup cleanup kept the oldest same-mtime filename");
    assert(!retainedSameMtimeBackups.includes("tinyLocal-cache-backup-old-01.json"), "Cache backup cleanup kept the second-oldest same-mtime filename");
    assert(retainedSameMtimeBackups.includes("tinyLocal-cache-backup-old-11.json"), "Cache backup cleanup did not keep the newest same-mtime filename");
    for (let index = 0; index < 12; index++) {
      fs.writeFileSync(path.join(cleanupBackupsTemp, `tinyLocal-cache-backup-fresh-${String(index).padStart(2, "0")}.json`), "{}");
    }
    await plugin.cache.cleanupOldBackups(cleanupBackupsTemp);
    const remainingFresh = fs.readdirSync(cleanupBackupsTemp).filter((name) => name.includes("fresh-"));
    assert(remainingFresh.length === 12, "Cache backup cleanup deleted backups younger than the minimum retention window");
    const brokenDir = path.join(cleanupBackupsTemp, "broken");
    fs.mkdirSync(brokenDir, { recursive: true });
    for (let index = 0; index < 12; index++) {
      const brokenPath = path.join(brokenDir, `tinyLocal-cache.broken-old-${String(index).padStart(2, "0")}.json`);
      fs.writeFileSync(brokenPath, "{}");
      fs.utimesSync(brokenPath, oldTime, oldTime);
    }
    const freshBrokenPath = path.join(brokenDir, "tinyLocal-cache.broken-fresh.json");
    fs.writeFileSync(freshBrokenPath, "{}");
    await plugin.cache.cleanupOldBackups(cleanupBackupsTemp);
    const remainingBroken = fs.readdirSync(brokenDir).filter((name) => name.startsWith("tinyLocal-cache.broken-"));
    const remainingOldBroken = remainingBroken.filter((name) => name.includes("old-"));
    assert(remainingBroken.length === 10, "Broken cache cleanup did not keep the retained set size at 10");
    assert(remainingOldBroken.length === 9, "Broken cache cleanup did not retain the expected old broken copies alongside a fresh copy");
    assert(remainingBroken.includes("tinyLocal-cache.broken-fresh.json"), "Broken cache cleanup deleted a fresh broken copy");
    for (let index = 0; index < 12; index++) {
      const rootBrokenPath = path.join(cleanupBackupsTemp, `tinyLocal-cache.broken-root-old-${String(index).padStart(2, "0")}.json`);
      fs.writeFileSync(rootBrokenPath, "{}");
      fs.utimesSync(rootBrokenPath, oldTime, oldTime);
    }
    const freshRootBrokenPath = path.join(cleanupBackupsTemp, "tinyLocal-cache.broken-root-fresh.json");
    fs.writeFileSync(freshRootBrokenPath, "{}");
    await plugin.cache.cleanupOldBackups(cleanupBackupsTemp);
    const remainingRootBroken = fs.readdirSync(cleanupBackupsTemp).filter((name) => name.startsWith("tinyLocal-cache.broken-root-"));
    assert(remainingRootBroken.length === 10, "Root-level broken cache cleanup did not keep the retained set size at 10");
    assert(remainingRootBroken.includes("tinyLocal-cache.broken-root-fresh.json"), "Root-level broken cache cleanup deleted a fresh broken copy");
  } finally {
    restoreCacheTestPaths();
    fs.rmSync(cleanupBackupsTemp, { recursive: true, force: true });
  }

  const cleanupLargeBackupsTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-cleanup-large-"));
  try {
    setCacheTestFile(path.join(cleanupLargeBackupsTemp, "tinyLocal-cache.json"), cleanupLargeBackupsTemp);
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    for (let index = 0; index < 1005; index++) {
      const backupPath = path.join(cleanupLargeBackupsTemp, `tinyLocal-cache-backup-large-${String(index).padStart(4, "0")}.json`);
      fs.writeFileSync(backupPath, "{}");
      fs.utimesSync(backupPath, oldTime, oldTime);
    }
    await plugin.cache.cleanupRetainedFiles(cleanupLargeBackupsTemp, (fileName) => fileName.startsWith("tinyLocal-cache-backup-large-"));
    const remainingLargeBackups = fs.readdirSync(cleanupLargeBackupsTemp).filter((name) => name.startsWith("tinyLocal-cache-backup-large-")).sort();
    assert(remainingLargeBackups.length === 10, `Cache retained-file cleanup left ${remainingLargeBackups.length} files when >1000 candidates existed`);
    assert(remainingLargeBackups[0] === "tinyLocal-cache-backup-large-0995.json", `Cache retained-file cleanup retained wrong lower bound: ${remainingLargeBackups[0]}`);
    assert(remainingLargeBackups[9] === "tinyLocal-cache-backup-large-1004.json", `Cache retained-file cleanup retained wrong upper bound: ${remainingLargeBackups[9]}`);
  } finally {
    restoreCacheTestPaths();
    fs.rmSync(cleanupLargeBackupsTemp, { recursive: true, force: true });
  }

  const cleanupFreshCapTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-cleanup-fresh-cap-"));
  try {
    setCacheTestFile(path.join(cleanupFreshCapTemp, "tinyLocal-cache.json"), cleanupFreshCapTemp);
    for (let index = 0; index < 60; index++) {
      fs.writeFileSync(path.join(cleanupFreshCapTemp, `tinyLocal-cache-backup-fresh-cap-${String(index).padStart(2, "0")}.json`), "{}");
    }
    await plugin.cache.cleanupRetainedFiles(cleanupFreshCapTemp, (fileName) => fileName.startsWith("tinyLocal-cache-backup-fresh-cap-"));
    const remainingFreshCapBackups = fs.readdirSync(cleanupFreshCapTemp).filter((name) => name.startsWith("tinyLocal-cache-backup-fresh-cap-"));
    assert(remainingFreshCapBackups.length === 50, `Cache backup hard cap retained ${remainingFreshCapBackups.length} fresh files instead of 50`);
  } finally {
    restoreCacheTestPaths();
    fs.rmSync(cleanupFreshCapTemp, { recursive: true, force: true });
  }

  const cleanupConcurrencyTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-cleanup-concurrency-"));
  const originalUnlinkForCleanupConcurrency = fs.promises.unlink;
  try {
    const oldTime = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    for (let index = 0; index < 40; index++) {
      const filePath = path.join(cleanupConcurrencyTemp, `cleanup-${String(index).padStart(2, "0")}.json`);
      fs.writeFileSync(filePath, "{}");
      fs.utimesSync(filePath, oldTime, oldTime);
    }
    let activeUnlinks = 0;
    let maxActiveUnlinks = 0;
    fs.promises.unlink = async (filePath) => {
      activeUnlinks += 1;
      maxActiveUnlinks = Math.max(maxActiveUnlinks, activeUnlinks);
      await new Promise((resolve) => setTimeout(resolve, 2));
      activeUnlinks -= 1;
      return originalUnlinkForCleanupConcurrency.call(fs.promises, filePath);
    };
    await plugin.cache.cleanupRetainedFiles(cleanupConcurrencyTemp, (fileName) => fileName.endsWith(".json"));
    assert(maxActiveUnlinks <= 8, `cleanupRetainedFiles() unlinked too many files concurrently: ${maxActiveUnlinks}`);
  } finally {
    fs.promises.unlink = originalUnlinkForCleanupConcurrency;
    fs.rmSync(cleanupConcurrencyTemp, { recursive: true, force: true });
  }

  const orphanTempCleanupDir = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-temp-orphans-"));
  try {
    setCacheTestFile(path.join(orphanTempCleanupDir, "tinyLocal-cache.json"));
    const orphanTempFile = path.join(orphanTempCleanupDir, ".tinyLocal-cache-test.tmp");
    const unrelatedTempFile = path.join(orphanTempCleanupDir, ".other.tmp");
    fs.writeFileSync(orphanTempFile, "orphan");
    fs.writeFileSync(unrelatedTempFile, "keep");
    await plugin.cache.cleanupOrphanedTempFiles();
    assert(!fs.existsSync(orphanTempFile), "cleanupOrphanedTempFiles() left a cache temp orphan");
    assert(fs.existsSync(unrelatedTempFile), "cleanupOrphanedTempFiles() removed an unrelated temp file");
  } finally {
    restoreCacheTestPaths();
    fs.rmSync(orphanTempCleanupDir, { recursive: true, force: true });
  }

  const debounceCacheTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-debounce-"));
  const originalDebounceWriteCacheFileAtomic = plugin.cache.writeCacheFileAtomic;
  const originalSaveCacheDelayMs = plugin.cache.saveCacheDelayMs;
  try {
    setCacheTestFile(path.join(debounceCacheTemp, "tinyLocal-cache.json"));
    plugin.cache.cacheData = plugin.cache.getEmptyCacheData();
    plugin.cache.saveCacheDelayMs = 10;
    let debouncedWriteCalls = 0;
    let debouncedSavedEntryCount = 0;
    let debouncedSavedPayload = "";
    plugin.cache.writeCacheFileAtomic = async (data) => {
      debouncedWriteCalls += 1;
      debouncedSavedPayload = data;
      debouncedSavedEntryCount = Object.keys(JSON.parse(data).entries || {}).length;
      await new Promise((resolve) => setTimeout(resolve, 5));
    };
    await Promise.all(Array.from({ length: 6 }, (_, index) =>
      plugin.cache.addToCache(
        `Images/cache-debounce-${index}.png`,
        1000 + index,
        createMockFile(`Images/cache-debounce-${index}.png`, 1000 + index, 500 + index),
        null
      )
    ));
    assert(debouncedWriteCalls === 1, `Debounced cache save wrote ${debouncedWriteCalls} times instead of once`);
    assert(debouncedSavedEntryCount === 6, `Debounced cache save persisted ${debouncedSavedEntryCount} entries instead of 6`);
    assert(!debouncedSavedPayload.includes("\n  "), "Debounced cache save still pretty-prints JSON in the hot path");
    assert(plugin.cache.saveCachePromise === null && plugin.cache.saveCacheTimer === null, "Debounced cache save left pending state after flush");
  } finally {
    await plugin.cache.flushPendingCacheSave?.();
    plugin.cache.writeCacheFileAtomic = originalDebounceWriteCacheFileAtomic;
    plugin.cache.saveCacheDelayMs = originalSaveCacheDelayMs;
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(debounceCacheTemp, { recursive: true, force: true });
  }

  const unloadFlushTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-unload-flush-"));
  const originalCompressorDestroyForUnloadFlush = plugin.compressor.destroy;
  try {
    setCacheTestFile(path.join(unloadFlushTemp, "tinyLocal-cache.json"));
    plugin.cache.cacheData = plugin.cache.getEmptyCacheData();
    plugin.cache.saveCacheDelayMs = 10000;
    plugin.compressor.destroy = () => {};
    const unloadFlushFile = createMockFile("Images/unload-flush.png", 100000, 91);
    const unloadFlushPromise = plugin.cache.addToCache(
      plugin.cache.buildCacheKey(unloadFlushFile.path, MOCK_MD5, unloadFlushFile.stat.mtime),
      unloadFlushFile.stat.size,
      unloadFlushFile,
      null
    );
    await Promise.resolve();
    assert(plugin.cache.saveCacheTimer, "Unload flush setup did not create a pending save timer");
    plugin.onunload();
    await unloadFlushPromise;
    const persistedAfterUnload = JSON.parse(fs.readFileSync(plugin.cache.cacheFile, "utf8"));
    assert(
      Object.values(persistedAfterUnload.entries || {}).some((entry) => entry.path === "Images/unload-flush.png"),
      "onunload() did not flush a pending cache save"
    );
  } finally {
    plugin.compressor.destroy = originalCompressorDestroyForUnloadFlush;
    plugin.isUnloading = false;
    plugin.cache.acceptingWrites = true;
    plugin.cache.saveCacheDelayMs = originalSaveCacheDelayMs;
    await plugin.cache.flushPendingCacheSave?.();
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(unloadFlushTemp, { recursive: true, force: true });
  }

  const lockedWritesOriginalSaveCache = plugin.cache.saveCache;
  try {
    const lockedEntrySnapshot = {
      keep: {
        path: "Images/write-lock.png",
        timestamp: 1,
        md5: MOCK_MD5,
        mtime: 1,
        sourceMtime: 1,
        sourceSize: 100
      }
    };
    plugin.cache.cacheData = {
      version: plugin.cache.CACHE_VERSION,
      entries: { ...lockedEntrySnapshot }
    };
    let lockedWriteSaveCalls = 0;
    plugin.cache.saveCache = async () => {
      lockedWriteSaveCalls += 1;
    };
    plugin.cache.lockWritesForUnload();
    await plugin.cache.renameCacheEntries("Images/write-lock.png", "Images/write-lock-renamed.png");
    await plugin.cache.addSkippedEntry("Images/skipped-after-unload.png", "too_small");
    await plugin.cache.markProcessedFileMoved("Images/write-lock.png", { mtimeMs: 2, size: 50 }, 100);
    await plugin.cache.clearCache();
    const removedLockedGhosts = await plugin.cache.cleanupGhostEntries();
    assert(removedLockedGhosts === 0, "cleanupGhostEntries() removed entries after cache writes were locked");
    assert(
      JSON.stringify(plugin.cache.cacheData.entries) === JSON.stringify(lockedEntrySnapshot),
      "Cache write lock allowed a post-unload mutation"
    );
    assert(lockedWriteSaveCalls === 0, "Cache write lock allowed saveCache() after unload");
  } finally {
    plugin.cache.saveCache = lockedWritesOriginalSaveCache;
    plugin.cache.acceptingWrites = true;
    plugin.cache.cacheData = originalCacheData;
  }

  const unloadHungWriteTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-unload-hung-write-"));
  try {
    setCacheTestFile(path.join(unloadHungWriteTemp, "tinyLocal-cache.json"));
    plugin.cache.cacheData = plugin.cache.getEmptyCacheData();
    plugin.cache.cacheData.entries.hung = { path: "Images/hung-write.png", timestamp: 1 };
    plugin.cache.activeWritePromise = new Promise(() => {});
    const start = Date.now();
    plugin.cache.flushPendingCacheSaveSync();
    assert(Date.now() - start < 100, "flushPendingCacheSaveSync() blocked on activeWritePromise");
    const persistedHungWrite = JSON.parse(fs.readFileSync(plugin.cache.cacheFile, "utf8"));
    assert(persistedHungWrite.entries.hung?.path === "Images/hung-write.png", "flushPendingCacheSaveSync() did not write a snapshot during hung write");
  } finally {
    plugin.cache.activeWritePromise = null;
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(unloadHungWriteTemp, { recursive: true, force: true });
  }

  const unloadLateWriteTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-unload-late-write-"));
  const originalWriteCacheFileAtomicForLateWrite = plugin.cache.writeCacheFileAtomic;
  try {
    setCacheTestFile(path.join(unloadLateWriteTemp, "tinyLocal-cache.json"));
    plugin.cache.cacheData = plugin.cache.getEmptyCacheData();
    let releaseStaleWrite = null;
    let staleWriteStarted = null;
    let staleWriteSkipped = false;
    const staleWriteStartedPromise = new Promise((resolve) => {
      staleWriteStarted = resolve;
    });
    plugin.cache.writeCacheFileAtomic = async (data, shouldCommit = () => true) => {
      staleWriteStarted();
      await new Promise((resolve) => {
        releaseStaleWrite = resolve;
      });
      if (!shouldCommit()) {
        staleWriteSkipped = true;
        return;
      }
      fs.mkdirSync(path.dirname(plugin.cache.cacheFile), { recursive: true });
      fs.writeFileSync(plugin.cache.cacheFile, data);
    };
    const staleWrite = plugin.cache.queueCacheWrite(JSON.stringify({
      version: plugin.cache.CACHE_VERSION,
      entries: { stale: { path: "Images/stale-write.png" } }
    }, null, 2));
    await staleWriteStartedPromise;
    plugin.cache.cacheData.entries.fresh = { path: "Images/fresh-unload.png" };
    plugin.cache.flushPendingCacheSaveSync();
    releaseStaleWrite();
    await staleWrite;
    const persistedLateWrite = JSON.parse(fs.readFileSync(plugin.cache.cacheFile, "utf8"));
    assert(staleWriteSkipped, "Late active cache write was not skipped after sync unload flush");
    assert(persistedLateWrite.entries.fresh?.path === "Images/fresh-unload.png" && !persistedLateWrite.entries.stale, "Late active cache write overwrote sync unload snapshot");
  } finally {
    releaseStaleWrite?.();
    plugin.cache.activeWritePromise = null;
    plugin.cache.writeCacheFileAtomic = originalWriteCacheFileAtomicForLateWrite;
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(unloadLateWriteTemp, { recursive: true, force: true });
  }

  const unloadReplayTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-unload-replay-"));
  try {
    setCacheTestFile(path.join(unloadReplayTemp, "tinyLocal-cache.json"));
    plugin.cache.cacheData = plugin.cache.getEmptyCacheData();
    plugin.cache.cacheData.entries.fresh = { path: "Images/replayed-fresh.png" };
    let finishActiveRename = null;
    const activeRenamePromise = new Promise((resolve) => {
      finishActiveRename = () => {
        fs.mkdirSync(path.dirname(plugin.cache.cacheFile), { recursive: true });
        fs.writeFileSync(plugin.cache.cacheFile, JSON.stringify({
          version: plugin.cache.CACHE_VERSION,
          entries: { stale: { path: "Images/replayed-stale.png" } }
        }, null, 2));
        resolve();
      };
    });
    plugin.cache.activeWritePromise = activeRenamePromise;
    plugin.cache.flushPendingCacheSaveSync();
    finishActiveRename();
    await activeRenamePromise;
    await new Promise((resolve) => setImmediate(resolve));
    const persistedReplay = JSON.parse(fs.readFileSync(plugin.cache.cacheFile, "utf8"));
    assert(persistedReplay.entries.fresh?.path === "Images/replayed-fresh.png" && !persistedReplay.entries.stale, "Sync unload flush was not replayed after a late active rename");
  } finally {
    plugin.cache.activeWritePromise = null;
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(unloadReplayTemp, { recursive: true, force: true });
  }

  const clearRaceTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-clear-race-"));
  try {
    setCacheTestFile(path.join(clearRaceTemp, "tinyLocal-cache.json"));
    plugin.cache.cacheData = plugin.cache.getEmptyCacheData();
    plugin.cache.saveCacheDelayMs = 10000;
    const clearRaceFile = createMockFile("Images/clear-race.png", 100000, 92);
    const pendingAdd = plugin.cache.addToCache(
      plugin.cache.buildCacheKey(clearRaceFile.path, MOCK_MD5, clearRaceFile.stat.mtime),
      clearRaceFile.stat.size,
      clearRaceFile,
      null
    );
    await Promise.resolve();
    assert(plugin.cache.saveCacheTimer, "clearCache race setup did not create a pending save timer");
    plugin.cache.saveCacheDelayMs = 0;
    await plugin.cache.clearCache();
    await Promise.race([
      pendingAdd,
      new Promise((_, reject) => setTimeout(() => reject(new Error("pending addToCache did not settle after clearCache()")), 250))
    ]);
    const persistedAfterClear = JSON.parse(fs.readFileSync(plugin.cache.cacheFile, "utf8"));
    assert(Object.keys(persistedAfterClear.entries || {}).length === 0, "clearCache() allowed a canceled pending save to repopulate the cache");
  } finally {
    plugin.cache.cancelPendingSave?.();
    plugin.cache.saveCacheDelayMs = originalSaveCacheDelayMs;
    await plugin.cache.flushPendingCacheSave?.();
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(clearRaceTemp, { recursive: true, force: true });
  }

  const restoreRaceTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-restore-race-"));
  const originalSetSaveCacheTimeout = plugin.cache.setSaveCacheTimeout;
  const originalClearSaveCacheTimeout = plugin.cache.clearSaveCacheTimeout;
  try {
    const restoreRaceCacheFile = path.join(restoreRaceTemp, "tinyLocal-cache.json");
    const restoreRaceBackupDir = path.join(restoreRaceTemp, "cache-backups");
    const restoreRaceBackupName = "tinyLocal-cache-backup-2026-05-16T00-00-00-000.json";
    fs.mkdirSync(restoreRaceBackupDir, { recursive: true });
    fs.writeFileSync(restoreRaceCacheFile, JSON.stringify({ version: plugin.cache.CACHE_VERSION, entries: {} }, null, 2));
    fs.writeFileSync(path.join(restoreRaceBackupDir, restoreRaceBackupName), JSON.stringify({
      version: plugin.cache.CACHE_VERSION,
      entries: {
        restored: {
          path: "Images/restored-race.png",
          timestamp: 5678,
          originalSize: 1234
        }
      }
    }, null, 2));
    let capturedRestoreTimerCallback = null;
    let restoreTimerCleared = false;
    plugin.cache.setSaveCacheTimeout = (callback, delay) => {
      capturedRestoreTimerCallback = callback;
      return { delay, cleared: false };
    };
    plugin.cache.clearSaveCacheTimeout = (timer) => {
      if (timer) timer.cleared = true;
      restoreTimerCleared = true;
    };
    setCacheTestFile(restoreRaceCacheFile);
    plugin.cache.cacheData = plugin.cache.getEmptyCacheData();
    const staleRestoreFile = createMockFile("Images/stale-before-restore.png", 100000, 93);
    const pendingRestoreAdd = plugin.cache.addToCache(
      plugin.cache.buildCacheKey(staleRestoreFile.path, MOCK_MD5, staleRestoreFile.stat.mtime),
      staleRestoreFile.stat.size,
      staleRestoreFile,
      null
    );
    await Promise.resolve();
    assert(capturedRestoreTimerCallback, "restoreFromBackup race setup did not capture a pending save timer");
    const restoredRace = await plugin.cache.restoreFromBackup(restoreRaceBackupName);
    assert(restoredRace, "restoreFromBackup() did not restore while a save was pending");
    assert(restoreTimerCleared, "restoreFromBackup() did not clear the pending save timer");
    await pendingRestoreAdd;
    await capturedRestoreTimerCallback();
    await Promise.resolve();
    const persistedAfterRestoreRace = JSON.parse(fs.readFileSync(plugin.cache.cacheFile, "utf8"));
    const restoreRacePaths = Object.values(persistedAfterRestoreRace.entries || {}).map((entry) => entry.path).sort();
    assert(
      JSON.stringify(restoreRacePaths) === JSON.stringify(["Images/restored-race.png"]),
      `A stale pending save overwrote restoreFromBackup(): ${restoreRacePaths.join(", ")}`
    );
  } finally {
    plugin.cache.setSaveCacheTimeout = originalSetSaveCacheTimeout;
    plugin.cache.clearSaveCacheTimeout = originalClearSaveCacheTimeout;
    plugin.cache.cancelPendingSave?.();
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(restoreRaceTemp, { recursive: true, force: true });
  }

  const restoreTraversalTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-restore-traversal-"));
  try {
    setCacheTestFile(path.join(restoreTraversalTemp, "tinyLocal-cache.json"));
    fs.mkdirSync(path.join(restoreTraversalTemp, "cache-backups"), { recursive: true });
    fs.writeFileSync(plugin.cache.cacheFile, JSON.stringify(plugin.cache.getEmptyCacheData(), null, 2));
    const traversalRestored = await plugin.cache.restoreFromBackup("../tinyLocal-cache-backup-2026-05-16T00-00-00-000.json");
    const nestedRestored = await plugin.cache.restoreFromBackup("nested/tinyLocal-cache-backup-2026-05-16T00-00-00-000.json");
    assert(traversalRestored === false && nestedRestored === false, "restoreFromBackup() accepted a path traversal backup filename");
  } finally {
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(restoreTraversalTemp, { recursive: true, force: true });
  }

  const restoreRealpathTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-restore-realpath-"));
  const originalRestoreRealpath = fs.promises.realpath;
  const originalConsoleErrorForRestoreRealpath = console.error;
  try {
    setCacheTestFile(path.join(restoreRealpathTemp, "tinyLocal-cache.json"));
    const restoreRealpathBackupDir = path.join(restoreRealpathTemp, "cache-backups");
    const restoreRealpathBackupName = "tinyLocal-cache-backup-2026-05-16T00-00-00-deadbeef.json";
    const restoreRealpathBackupPath = path.join(restoreRealpathBackupDir, restoreRealpathBackupName);
    fs.mkdirSync(restoreRealpathBackupDir, { recursive: true });
    fs.writeFileSync(plugin.cache.cacheFile, JSON.stringify(plugin.cache.getEmptyCacheData(), null, 2));
    fs.writeFileSync(restoreRealpathBackupPath, JSON.stringify({
      version: plugin.cache.CACHE_VERSION,
      entries: {
        "Images/realpath-escaped.png": {
          path: "Images/realpath-escaped.png",
          timestamp: 1
        }
      }
    }, null, 2));
    console.error = () => {};
    fs.promises.realpath = async (target) => {
      if (path.resolve(String(target)) === path.resolve(restoreRealpathBackupPath)) {
        return path.join(os.tmpdir(), "local-image-compress-outside-backup.json");
      }
      return originalRestoreRealpath.call(fs.promises, target);
    };
    const realpathRestored = await plugin.cache.restoreFromBackup(restoreRealpathBackupName);
    assert(realpathRestored === false, "restoreFromBackup() accepted a backup whose real path escapes cache-backups");
    const realpathCache = JSON.parse(fs.readFileSync(plugin.cache.cacheFile, "utf8"));
    assert(!realpathCache.entries["Images/realpath-escaped.png"], "restoreFromBackup() copied an escaped realpath backup");
  } finally {
    console.error = originalConsoleErrorForRestoreRealpath;
    fs.promises.realpath = originalRestoreRealpath;
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(restoreRealpathTemp, { recursive: true, force: true });
  }

  const restoreSymlinkTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-restore-symlink-"));
  const originalLstatForRestoreSymlink = fs.promises.lstat;
  const originalConsoleErrorForRestoreSymlink = console.error;
  try {
    setCacheTestFile(path.join(restoreSymlinkTemp, "tinyLocal-cache.json"));
    const restoreSymlinkBackupDir = path.join(restoreSymlinkTemp, "cache-backups");
    const restoreSymlinkBackupName = "tinyLocal-cache-backup-2026-05-16T00-00-00-deadbeef.json";
    const restoreSymlinkBackupPath = path.join(restoreSymlinkBackupDir, restoreSymlinkBackupName);
    fs.mkdirSync(restoreSymlinkBackupDir, { recursive: true });
    fs.writeFileSync(plugin.cache.cacheFile, JSON.stringify(plugin.cache.getEmptyCacheData()));
    fs.writeFileSync(restoreSymlinkBackupPath, JSON.stringify({
      version: plugin.cache.CACHE_VERSION,
      entries: {
        "Images/symlink-escaped.png": {
          path: "Images/symlink-escaped.png",
          timestamp: 1
        }
      }
    }));
    console.error = () => {};
    fs.promises.lstat = async (target) => {
      const stats = await originalLstatForRestoreSymlink.call(fs.promises, target);
      if (path.resolve(String(target)) === path.resolve(restoreSymlinkBackupPath)) {
        return {
          ...stats,
          isFile: () => false,
          isSymbolicLink: () => true
        };
      }
      return stats;
    };
    const symlinkRestored = await plugin.cache.restoreFromBackup(restoreSymlinkBackupName);
    assert(symlinkRestored === false, "restoreFromBackup() accepted a symlink-like backup file");
    const symlinkCache = JSON.parse(fs.readFileSync(plugin.cache.cacheFile, "utf8"));
    assert(!symlinkCache.entries["Images/symlink-escaped.png"], "restoreFromBackup() copied a symlink-like backup");
  } finally {
    console.error = originalConsoleErrorForRestoreSymlink;
    fs.promises.lstat = originalLstatForRestoreSymlink;
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(restoreSymlinkTemp, { recursive: true, force: true });
  }

  const writeSerializeTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-write-serialize-"));
  try {
    setCacheTestFile(path.join(writeSerializeTemp, "tinyLocal-cache.json"));
    plugin.cache.cacheData = plugin.cache.getEmptyCacheData();
    plugin.cache.saveCacheDelayMs = 0;
    let inFlightWrites = 0;
    let maxInFlightWrites = 0;
    let writeCalls = 0;
    let releaseFirstWrite = null;
    let firstWriteStarted = null;
    const firstWriteStartedPromise = new Promise((resolve) => {
      firstWriteStarted = resolve;
    });
    plugin.cache.writeCacheFileAtomic = async (data) => {
      writeCalls += 1;
      inFlightWrites += 1;
      maxInFlightWrites = Math.max(maxInFlightWrites, inFlightWrites);
      if (writeCalls === 1) {
        firstWriteStarted();
        await new Promise((resolve) => {
          releaseFirstWrite = resolve;
        });
      }
      await originalDebounceWriteCacheFileAtomic.call(plugin.cache, data);
      inFlightWrites -= 1;
    };
    const firstSerializeFile = createMockFile("Images/write-serialize-a.png", 100000, 94);
    const secondSerializeFile = createMockFile("Images/write-serialize-b.png", 100000, 95);
    const firstSerializeAdd = plugin.cache.addToCache(
      plugin.cache.buildCacheKey(firstSerializeFile.path, MOCK_MD5, firstSerializeFile.stat.mtime),
      firstSerializeFile.stat.size,
      firstSerializeFile,
      null
    );
    await firstWriteStartedPromise;
    const secondSerializeAdd = plugin.cache.addToCache(
      plugin.cache.buildCacheKey(secondSerializeFile.path, MOCK_MD5_ALT, secondSerializeFile.stat.mtime),
      secondSerializeFile.stat.size,
      secondSerializeFile,
      null
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert(writeCalls === 1, `A second cache write started before the first completed: ${writeCalls}`);
    releaseFirstWrite();
    await Promise.all([firstSerializeAdd, secondSerializeAdd]);
    assert(maxInFlightWrites === 1, `Cache writes overlapped: max in flight ${maxInFlightWrites}`);
    assert(writeCalls === 2, `Serialized cache write test expected two writes, got ${writeCalls}`);
    const persistedAfterSerializedWrites = JSON.parse(fs.readFileSync(plugin.cache.cacheFile, "utf8"));
    const serializedPaths = Object.values(persistedAfterSerializedWrites.entries || {}).map((entry) => entry.path).sort();
    assert(
      JSON.stringify(serializedPaths) === JSON.stringify(["Images/write-serialize-a.png", "Images/write-serialize-b.png"]),
      `Serialized cache writes did not persist both entries: ${serializedPaths.join(", ")}`
    );
  } finally {
    releaseFirstWrite?.();
    await plugin.cache.flushPendingCacheSave?.();
    plugin.cache.writeCacheFileAtomic = originalDebounceWriteCacheFileAtomic;
    plugin.cache.saveCacheDelayMs = originalSaveCacheDelayMs;
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(writeSerializeTemp, { recursive: true, force: true });
  }

  const queueContentionTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-queue-contention-"));
  const originalConsoleErrorForQueue = console.error;
  try {
    setCacheTestFile(path.join(queueContentionTemp, "tinyLocal-cache.json"));
    const writeOrder = [];
    plugin.cache.writeCacheFileAtomic = async (data) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      writeOrder.push(JSON.parse(data).order);
    };
    await Promise.all(Array.from({ length: 10 }, (_, index) =>
      plugin.cache.queueCacheWrite(JSON.stringify({ order: index }))
    ));
    assert(JSON.stringify(writeOrder) === JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), `queueCacheWrite changed write order under contention: ${writeOrder.join(",")}`);

    let queueWriteCalls = 0;
    let queueErrorsLogged = 0;
    console.error = () => {
      queueErrorsLogged += 1;
    };
    plugin.cache.writeCacheFileAtomic = async () => {
      queueWriteCalls += 1;
      if (queueWriteCalls === 2) {
        throw new Error("simulated cache write failure");
      }
    };
    await Promise.all([
      plugin.cache.queueCacheWrite('{"a":1}'),
      plugin.cache.queueCacheWrite('{"a":2}'),
      plugin.cache.queueCacheWrite('{"a":3}')
    ]);
    assert(queueWriteCalls === 3, `queueCacheWrite stopped after a failed write: ${queueWriteCalls}`);
    assert(queueErrorsLogged === 1, `queueCacheWrite logged wrong error count: ${queueErrorsLogged}`);
  } finally {
    console.error = originalConsoleErrorForQueue;
    await plugin.cache.flushPendingCacheSave?.();
    plugin.cache.writeCacheFileAtomic = originalDebounceWriteCacheFileAtomic;
    plugin.cache.saveCacheDelayMs = originalSaveCacheDelayMs;
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(queueContentionTemp, { recursive: true, force: true });
  }

  const renameRetryTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-rename-retry-"));
  try {
    const retryCacheFile = path.join(renameRetryTemp, "tinyLocal-cache.json");
    setCacheTestFile(retryCacheFile);
    const originalRename = fs.promises.rename;
    let renameAttempts = 0;
    try {
      fs.promises.rename = async (sourcePath, targetPath) => {
        if (targetPath === retryCacheFile) {
          renameAttempts += 1;
          if (renameAttempts <= 2) {
            const error = new Error("simulated transient Windows cache rename failure");
            error.code = renameAttempts === 1 ? "EPERM" : "EBUSY";
            throw error;
          }
        }
        return originalRename.call(fs.promises, sourcePath, targetPath);
      };
      await plugin.cache.writeCacheFileAtomic(JSON.stringify({
        version: plugin.cache.CACHE_VERSION,
        entries: {
          retry: { path: "Images/retry.png", timestamp: 1 }
        }
      }), () => true, { mergeDiskEntries: false });
    } finally {
      fs.promises.rename = originalRename;
    }
    assert(renameAttempts === 3, `Async cache rename retry used wrong attempt count: ${renameAttempts}`);
    const persistedRetryCache = JSON.parse(fs.readFileSync(retryCacheFile, "utf8"));
    assert(persistedRetryCache.entries.retry?.path === "Images/retry.png", "Async cache rename retry did not persist the cache file");

    const originalRenameSync = fs.renameSync;
    const originalSleepForCacheLockSync = plugin.cache.sleepForCacheLockSync;
    let syncRenameAttempts = 0;
    let syncRetrySleeps = 0;
    try {
      fs.renameSync = (sourcePath, targetPath) => {
        if (targetPath === retryCacheFile) {
          syncRenameAttempts += 1;
          if (syncRenameAttempts === 1) {
            const error = new Error("simulated transient Windows sync cache rename failure");
            error.code = "EACCES";
            throw error;
          }
        }
        return originalRenameSync.call(fs, sourcePath, targetPath);
      };
      plugin.cache.sleepForCacheLockSync = () => {
        syncRetrySleeps += 1;
      };
      plugin.cache.writeCacheFileSyncAtomic(JSON.stringify({
        version: plugin.cache.CACHE_VERSION,
        entries: {
          syncRetry: { path: "Images/sync-retry.png", timestamp: 2 }
        }
      }), { mergeDiskEntries: false });
    } finally {
      fs.renameSync = originalRenameSync;
      plugin.cache.sleepForCacheLockSync = originalSleepForCacheLockSync;
    }
    assert(syncRenameAttempts === 2, `Sync cache rename retry used wrong attempt count: ${syncRenameAttempts}`);
    assert(syncRetrySleeps === 1, `Sync cache rename retry used wrong sleep count: ${syncRetrySleeps}`);
    const persistedSyncRetryCache = JSON.parse(fs.readFileSync(retryCacheFile, "utf8"));
    assert(persistedSyncRetryCache.entries.syncRetry?.path === "Images/sync-retry.png", "Sync cache rename retry did not persist the cache file");
    const tempLeftovers = fs.readdirSync(renameRetryTemp).filter((name) => name.startsWith(".tinyLocal-cache-") && name.endsWith(".tmp"));
    assert(tempLeftovers.length === 0, `Cache rename retry left temp files: ${tempLeftovers.join(", ")}`);
  } finally {
    restoreCacheTestPaths();
    plugin.cache.cacheData = originalCacheData;
    fs.rmSync(renameRetryTemp, { recursive: true, force: true });
  }

  const multiInstanceCacheTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-cache-multi-instance-"));
  try {
    const CacheClass = plugin.cache.constructor;
    const cacheFile = path.join(multiInstanceCacheTemp, "tinyLocal-cache.json");
    const cacheA = new CacheClass(plugin.app);
    const cacheB = new CacheClass(plugin.app);
    cacheA.cacheFile = cacheFile;
    cacheB.cacheFile = cacheFile;
    await Promise.all([
      cacheA.queueCacheWrite(JSON.stringify({
        version: cacheA.CACHE_VERSION,
        entries: {
          fromA: { path: "Images/from-a.png", timestamp: 1 }
        }
      }), { mergeDiskEntries: true }),
      cacheB.queueCacheWrite(JSON.stringify({
        version: cacheB.CACHE_VERSION,
        entries: {
          fromB: { path: "Images/from-b.png", timestamp: 2 }
        }
      }), { mergeDiskEntries: true })
    ]);
    const mergedCache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    assert(mergedCache.entries.fromA?.path === "Images/from-a.png", "Multi-instance cache write lost instance A entry");
    assert(mergedCache.entries.fromB?.path === "Images/from-b.png", "Multi-instance cache write lost instance B entry");
    assert(!fs.existsSync(`${cacheFile}.lock`), "Multi-instance cache write left a lock file behind");

    fs.writeFileSync(`${cacheFile}.lock`, JSON.stringify({
      ownerId: "stale-owner",
      pid: 0,
      timestamp: Date.now() - 60_000
    }));
    await cacheA.queueCacheWrite(JSON.stringify({
      version: cacheA.CACHE_VERSION,
      entries: {
        fromC: { path: "Images/from-c.png", timestamp: 3 }
      }
    }), { mergeDiskEntries: true });
    const staleLockRecoveredCache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    assert(staleLockRecoveredCache.entries.fromC?.path === "Images/from-c.png", "Stale cache lock did not recover for later writes");
    assert(!fs.existsSync(`${cacheFile}.lock`), "Stale cache lock recovery left a lock file behind");

    await cacheA.queueCacheWrite(JSON.stringify({
      version: cacheA.CACHE_VERSION,
      entries: {}
    }), { mergeDiskEntries: false });
    const authoritativeEmptyCache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    assert(Object.keys(authoritativeEmptyCache.entries || {}).length === 0, "Authoritative cache write merged deleted entries back from disk");
  } finally {
    fs.rmSync(multiInstanceCacheTemp, { recursive: true, force: true });
  }

  assert(plugin.savingsCalculator.validateSavingsData({
    originalSize: 1000,
    currentSize: 1000,
    savedSize: 0,
    savedPercentage: 0,
    processedFiles: 1,
    totalFiles: 1,
    estimatedFiles: 0
  }), "Savings validation rejected a valid zero-savings result");
  assert(plugin.savingsCalculator.validateSavingsData({
    originalSize: 0,
    currentSize: 0,
    savedSize: 0,
    savedPercentage: 0,
    processedFiles: 0,
    totalFiles: 3,
    estimatedFiles: 0
  }), "Savings validation rejected all-skipped activity");
  assert(!plugin.savingsCalculator.validateSavingsData({
    originalSize: 1000,
    currentSize: 500,
    savedSize: 1500,
    savedPercentage: 150,
    processedFiles: 1,
    totalFiles: 1,
    estimatedFiles: 0
  }), "Savings validation accepted impossible savings totals");
  const originalGetCompressionRatioForEstimate = plugin.savingsCalculator.getCompressionRatio;
  try {
    plugin.savingsCalculator.getCompressionRatio = () => 15;
    assert(
      plugin.savingsCalculator.estimateOriginalSizeFromCurrent({ extension: "png", stat: { size: 100000 } }) === 1500000,
      "Savings estimator rejected a valid 15x compression ratio"
    );
    plugin.savingsCalculator.getCompressionRatio = () => 31;
    assert(
      plugin.savingsCalculator.estimateOriginalSizeFromCurrent({ extension: "png", stat: { size: 100000 } }) === 100000,
      "Savings estimator did not cap implausible ratios"
    );
    plugin.savingsCalculator.getCompressionRatio = () => Infinity;
    assert(
      plugin.savingsCalculator.estimateOriginalSizeFromCurrent({ extension: "png", stat: { size: 100000 } }) === 100000,
      "Savings estimator accepted a non-finite ratio"
    );
  } finally {
    plugin.savingsCalculator.getCompressionRatio = originalGetCompressionRatioForEstimate;
  }
  assert(plugin.savingsCalculator.getCompressionRatio("webp", 100000) === plugin.constructor.COMPRESSION_RATIOS.DEFAULT, "WebP still uses a supported-format-specific savings ratio");

  const originalGetCompressedFileSizeForSavings = plugin.savingsCalculator.getCompressedFileSize;
  try {
    const cachedSavingsFile = createMockFile("Images/cached-output-size.jpg", 400, 96);
    plugin.cache.cacheData.entries = {
      [plugin.cache.buildCacheKey(cachedSavingsFile.path, MOCK_MD5, cachedSavingsFile.stat.mtime)]: {
        path: cachedSavingsFile.path,
        md5: MOCK_MD5,
        mtime: cachedSavingsFile.stat.mtime,
        timestamp: 1,
        state: "moved",
        originalSize: 1000,
        processedMtime: cachedSavingsFile.stat.mtime,
        processedSize: cachedSavingsFile.stat.size,
        outputSize: cachedSavingsFile.stat.size
      }
    };
    let compressedStatCalls = 0;
    plugin.savingsCalculator.getCompressedFileSize = async () => {
      compressedStatCalls += 1;
      throw new Error("cached outputSize should avoid fs.stat fallback");
    };
    const cachedSavingsStats = await plugin.savingsCalculator.collectImageStats([cachedSavingsFile]);
    assert(compressedStatCalls === 0, "collectImageStats() did not use cached outputSize before fs.stat fallback");
    assert(cachedSavingsStats.savings.originalSize === 1000, `Cached savings original size was wrong: ${cachedSavingsStats.savings.originalSize}`);
    assert(cachedSavingsStats.savings.currentSize === 400, `Cached savings current size was wrong: ${cachedSavingsStats.savings.currentSize}`);
  } finally {
    plugin.savingsCalculator.getCompressedFileSize = originalGetCompressedFileSizeForSavings;
    plugin.cache.cacheData = originalCacheData;
  }

  const originalGetEntriesByPathMapForSavings = plugin.cache.getEntriesByPathMap;
  const originalGetEntriesForPathForSavings = plugin.cache.getEntriesForPath;
  try {
    const parallelSavingsFiles = Array.from({ length: 12 }, (_, index) => createMockFile(`Images/parallel-size-${index}.jpg`, 400 + index, 500 + index));
    plugin.cache.cacheData.entries = {};
    for (const file of parallelSavingsFiles) {
      plugin.cache.cacheData.entries[plugin.cache.buildCacheKey(file.path, MOCK_MD5, file.stat.mtime)] = {
        path: file.path,
        md5: MOCK_MD5,
        mtime: file.stat.mtime,
        timestamp: 1,
        state: "moved",
        originalSize: 1000,
        processedMtime: file.stat.mtime,
        processedSize: file.stat.size
      };
    }
    let savingsPathMapBuilds = 0;
    let savingsDirectPathScans = 0;
    plugin.cache.getEntriesByPathMap = function(...args) {
      savingsPathMapBuilds += 1;
      return originalGetEntriesByPathMapForSavings.apply(this, args);
    };
    plugin.cache.getEntriesForPath = function(...args) {
      savingsDirectPathScans += 1;
      return originalGetEntriesForPathForSavings.apply(this, args);
    };
    let inFlightSizeFetches = 0;
    let maxInFlightSizeFetches = 0;
    plugin.savingsCalculator.getCompressedFileSize = async () => {
      inFlightSizeFetches += 1;
      maxInFlightSizeFetches = Math.max(maxInFlightSizeFetches, inFlightSizeFetches);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlightSizeFetches -= 1;
      return 400;
    };
    await plugin.savingsCalculator.collectImageStats(parallelSavingsFiles);
    assert(maxInFlightSizeFetches > 1, `collectImageStats() fetched compressed sizes serially: max=${maxInFlightSizeFetches}`);
    assert(maxInFlightSizeFetches <= 8, `collectImageStats() exceeded the savings stat concurrency cap: max=${maxInFlightSizeFetches}`);
    assert(savingsPathMapBuilds === 1, `collectImageStats() rebuilt the cache path map more than once: ${savingsPathMapBuilds}`);
    assert(savingsDirectPathScans === 0, "collectImageStats() fell back to direct per-file cache path scans");
  } finally {
    plugin.savingsCalculator.getCompressedFileSize = originalGetCompressedFileSizeForSavings;
    plugin.cache.getEntriesByPathMap = originalGetEntriesByPathMapForSavings;
    plugin.cache.getEntriesForPath = originalGetEntriesForPathForSavings;
    plugin.cache.cacheData = originalCacheData;
  }

  plugin.cache.cacheData.entries = {};
  await plugin.cache.addToCache("v2:empty-path", 100, null, null);
  assert(Object.keys(plugin.cache.cacheData.entries).length === 0, "addToCache() created an entry with an empty path");

  plugin.cache.cacheData.entries = {};
  plugin.cache.saveCache = async () => {};
  plugin.cache.createBackup = () => {};
  await setMockFiles(plugin, [createMockFile("Images/a.png", 100000, 1)]);
  plugin.compressor.compress = async () => ({
    success: false,
    error: "pngquant exited with code 99",
    skipReason: "pngquant_quality_failed"
  });
  await plugin.compressFile(plugin.app.vault.getAbstractFileByPath("Images/a.png"));
  const skippedEntry = Object.values(plugin.cache.cacheData.entries).find((entry) => entry.path === "Images/a.png" && entry.state === "skipped");
  assert(skippedEntry && !Object.prototype.hasOwnProperty.call(skippedEntry, "skipped"), "PNG quality failure was not written as a canonical skipped cache entry");
  assert(skippedEntry.skipReason === "pngquant_quality_failed", `Unexpected PNG skip reason: ${skippedEntry && skippedEntry.skipReason}`);
  assert(skippedEntry.compressionSettingsKey === "png:65-80", `PNG skip entry did not record quality settings: ${skippedEntry.compressionSettingsKey}`);
  const tooLargeSettingsKey = plugin.getCompressionSettingsKey({ extension: "png" }, "too_large");
  assert(tooLargeSettingsKey === "png:limits:100:100:too_large", `too_large skip entry did not record size/pixel limits: ${tooLargeSettingsKey}`);
  assert(plugin.cache.isSettingsSensitiveSkipReason("too_large") === true, "too_large skipped entries are not settings-sensitive");
  assert(plugin.getCompressionSettingsKey({ extension: "webp" }, "future_skip_reason") === "webp:future_skip_reason", "Future skip reasons still get a null compression settings key");
  assert(Object.keys(plugin.cache.cacheData.entries).some((key) => key.startsWith("v2:")), "Skipped cache entry was not written with a v2 key");

  const originalNoticeClassForSanitize = ObsidianMock.Notice;
  const originalCompressorCompressForSanitize = plugin.compressor.compress;
  try {
    const noticeMessages = [];
    ObsidianMock.Notice = class {
      constructor(message) {
        noticeMessages.push(String(message));
      }
    };
    const pathLeakErrors = [
      "C:\\Users\\joe\\Documents\\private\\secret.png failed",
      "C:\\Users\\Joe\\My Photos\\secret.jpg failed",
      "/Users/Joe/My Photos/secret.jpeg failed",
      "/opt/vault/private/secret.png failed",
      "~/Documents/private/secret.png failed",
      "file:///Users/joe/private/img.png failed",
      "Cache temp C:\\Users\\Joe\\AppData\\Local\\plugin.tmp failed",
      "Second line\n/Users/Joe/private/plugin.log failed",
      "Markdown /home/joe/private/notes.md failed",
      "http://localhost:8080/private/debug failed",
      "http://127.0.0.1:3000/private/debug failed"
    ];
    plugin.cache.cacheData.entries = {};
    for (let index = 0; index < pathLeakErrors.length; index++) {
      plugin.compressor.compress = async () => ({
        success: false,
        error: pathLeakErrors[index]
      });
      await setMockFiles(plugin, [createMockFile(`Images/path-leak-${index}.png`, 100000, index + 2)]);
      await plugin.compressFile(plugin.app.vault.getAbstractFileByPath(`Images/path-leak-${index}.png`));
    }
    plugin.compressor.compress = async () => ({
      success: false,
      error: "Generic compression error"
    });
    await setMockFiles(plugin, [createMockFile("Images/generic-error.png", 100000, 12)]);
    await plugin.compressFile(plugin.app.vault.getAbstractFileByPath("Images/generic-error.png"));
    plugin.compressor.compress = async () => {
      throw new Error("Thrown compression error");
    };
    await setMockFiles(plugin, [createMockFile("Images/thrown-error.png", 100000, 13)]);
    await plugin.compressFile(plugin.app.vault.getAbstractFileByPath("Images/thrown-error.png"));
    assert(noticeMessages.length > 0, "Compression failure did not show a user notice");
    assert(
      !noticeMessages.some((message) => /C:\\|~\/|file:\/\/|localhost|127\.0\.0\.1|\/Users\/Joe|\/home\/joe|\/opt\/vault|AppData|secret\.(png|jpe?g)|plugin\.(tmp|log)|notes\.md|My Photos/.test(message)),
      `User notice leaked an absolute path: ${noticeMessages.join(" | ")}`
    );
    assert(
      noticeMessages.some((message) => message.includes("Generic compression error")),
      "sanitizeErrorForUser removed a generic error message"
    );
    assert(
      noticeMessages.some((message) => message.includes("progress.error") || message.includes("Error")) && noticeMessages.some((message) => message.includes("Images/thrown-error.png")),
      "Thrown compression error notice did not include the file context"
    );
    const longPathLikeError = `Error: C:\\${"a".repeat(10000)}`;
    const sanitizeStartedAt = Date.now();
    const sanitizedLongPath = plugin.compressor.formatErrorForUser(longPathLikeError);
    const sanitizeElapsedMs = Date.now() - sanitizeStartedAt;
    assert(sanitizedLongPath === "Error: <path>", "sanitizeErrorForUser did not scrub a long path-like Windows token");
    assert(sanitizeElapsedMs < 100, `sanitizeErrorForUser was too slow for a long non-matching path: ${sanitizeElapsedMs}ms`);
  } finally {
    ObsidianMock.Notice = originalNoticeClassForSanitize;
    plugin.compressor.compress = originalCompressorCompressForSanitize;
  }

  const originalGetCompressedFilesCountForAutoMove = plugin.moveService.getCompressedFilesCount;
  const originalMoveCompressedToFilesForAutoMove = plugin.moveService.moveCompressedToFiles;
  const originalCompressorCompressForAutoMove = plugin.compressor.compress;
  let autoMoveCalls = 0;
  const autoMoveWorkflowCounts = [];
  try {
    plugin.settings.autoMoveCompressedEnabled = true;
    plugin.settings.autoMoveCompressedThreshold = 1;
    plugin.moveService.getCompressedFilesCount = async () => 1;
    plugin.moveService.moveCompressedToFiles = async () => {
      autoMoveWorkflowCounts.push(plugin.compressionWorkflowsInFlight);
      autoMoveCalls += 1;
    };
    plugin.compressor.compress = async () => ({ success: true, savings: 25 });
    plugin.cache.cacheData.entries = {};
    await setMockFiles(plugin, [createMockFile("Images/auto-move.png", 100000, 3)]);
    await plugin.compressFile(plugin.app.vault.getAbstractFileByPath("Images/auto-move.png"));
    assert(autoMoveCalls === 1, `Auto-move did not run after compression reached threshold: ${autoMoveCalls}`);
    assert(autoMoveWorkflowCounts[0] === 0, `Auto-move started while compression workflow was still counted: ${autoMoveWorkflowCounts[0]}`);
    plugin.isAutoMoveRunning = true;
    await plugin.tryAutoMoveCompressed();
    assert(autoMoveCalls === 1, "Auto-move ran re-entrantly while already active");
  } finally {
    plugin.isAutoMoveRunning = false;
    plugin.settings.autoMoveCompressedEnabled = false;
    plugin.moveService.getCompressedFilesCount = originalGetCompressedFilesCountForAutoMove;
    plugin.moveService.moveCompressedToFiles = originalMoveCompressedToFilesForAutoMove;
    plugin.compressor.compress = originalCompressorCompressForAutoMove;
  }

  const originalCompressorCompressForMoveLock = plugin.compressor.compress;
  const originalNoticeClassForMoveLock = ObsidianMock.Notice;
  try {
    const moveLockNotices = [];
    ObsidianMock.Notice = class {
      constructor(message) {
        moveLockNotices.push(String(message));
      }
    };
    let compressionDuringMoveCalls = 0;
    plugin.moveService.moveOperationInProgress = true;
    plugin.compressor.compress = async () => {
      compressionDuringMoveCalls += 1;
      return { success: true, savings: 10 };
    };
    const moveLockResult = await plugin.runCompressionBatch([createMockFile("Images/move-lock.png", 100000, 4)]);
    assert(moveLockResult.compressed === 0 && moveLockResult.skippedValidation === 1, "Compression was not deferred while move was in progress");
    assert(compressionDuringMoveCalls === 0, "Compressor ran while move was in progress");
    assert(moveLockNotices.some((message) => message.includes("move operation is in progress")), "Move lock Notice did not explain why compression was deferred");
    await plugin.compressFile(createMockFile("Images/move-lock-direct.png", 100000, 5));
    await plugin.autoCompressNewFile(createMockFile("Images/move-lock-auto.png", 100000, 6));
    assert(compressionDuringMoveCalls === 0, "Direct compression path ran while move was in progress");
  } finally {
    plugin.moveService.moveOperationInProgress = false;
    plugin.compressor.compress = originalCompressorCompressForMoveLock;
    ObsidianMock.Notice = originalNoticeClassForMoveLock;
  }

  const originalWaitForCompressionIdle = plugin.waitForCompressionIdle;
  const moveWaitTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-move-wait-"));
  try {
    let waitForIdleCalls = 0;
    plugin.waitForCompressionIdle = async () => {
      waitForIdleCalls += 1;
    };
    plugin.app.vault.adapter.basePath = moveWaitTemp;
    plugin.app.vault.adapter.path.absolute = moveWaitTemp;
    plugin.settings.outputFolder = "Compressed";
    await plugin.moveService.moveCompressedToFiles();
    assert(waitForIdleCalls === 1, `Move did not wait for active compression jobs before scanning backups: ${waitForIdleCalls}`);
  } finally {
    plugin.waitForCompressionIdle = originalWaitForCompressionIdle;
    plugin.moveService.moveOperationInProgress = false;
    plugin.app.vault.adapter.basePath = root;
    plugin.app.vault.adapter.path.absolute = root;
    fs.rmSync(moveWaitTemp, { recursive: true, force: true });
  }

  const originalWindowSetTimeoutForIdle = global.window.setTimeout;
  const originalGlobalSetTimeoutForIdle = global.setTimeout;
  try {
    let idleMacroTicks = 0;
    global.window.setTimeout = (callback, delay) => originalGlobals.setTimeout(() => {
      idleMacroTicks += 1;
      callback();
    }, delay);
    plugin.compressionWorkflowsInFlight = 0;
    plugin.compressionJobsInFlight = 1;
    originalGlobals.setTimeout(() => {
      plugin.compressionJobsInFlight = 0;
    }, 0);
    await plugin.waitForCompressionIdle();
    assert(idleMacroTicks > 0, "waitForCompressionIdle did not yield through a macrotask timer");
    assert(plugin.compressionJobsInFlight === 0, "waitForCompressionIdle did not observe drained compression jobs");
  } finally {
    plugin.compressionWorkflowsInFlight = 0;
    plugin.compressionJobsInFlight = 0;
    global.window.setTimeout = originalWindowSetTimeoutForIdle;
    global.setTimeout = originalGlobalSetTimeoutForIdle;
  }

  const originalWaitTickForIdleTimeout = plugin.waitForCompressionIdleTick;
  const idleTimeoutWarnings = captureConsoleWarn();
  try {
    let idleTimeoutTicks = 0;
    plugin.waitForCompressionIdleTick = async () => {
      idleTimeoutTicks += 1;
    };
    plugin.compressionWorkflowsInFlight = 0;
    plugin.compressionJobsInFlight = 1;
    await plugin.waitForCompressionIdle(0);
    assert(idleTimeoutTicks === 0, "waitForCompressionIdle did not stop before ticking when maxWaitMs elapsed");
    assert(idleTimeoutWarnings.messages.some((message) => message.includes("waitForCompressionIdle giving up after 0ms")), "waitForCompressionIdle timeout did not log stuck counters");
  } finally {
    idleTimeoutWarnings.restore();
    plugin.waitForCompressionIdleTick = originalWaitTickForIdleTimeout;
    plugin.compressionWorkflowsInFlight = 0;
    plugin.compressionJobsInFlight = 0;
  }

  const originalSetWindowTimeoutForIndexDedupe = plugin.setWindowTimeout;
  const originalClearWindowTimeoutForIndexDedupe = plugin.clearWindowTimeout;
  const originalUpdateImageIndexForDedupe = plugin.updateImageIndexForFile;
  const originalScheduleStatusBarForDedupe = plugin.scheduleStatusBarUpdate;
  const originalGetAbstractFileByPathForDedupe = plugin.app.vault.getAbstractFileByPath;
  try {
    const scheduledTimers = [];
    let refreshCalls = 0;
    let clearedTimers = 0;
    plugin.setWindowTimeout = (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      scheduledTimers.push(timer);
      return timer;
    };
    plugin.clearWindowTimeout = (timer) => {
      timer.cleared = true;
      clearedTimers += 1;
    };
    plugin.updateImageIndexForFile = async () => {
      refreshCalls += 1;
    };
    plugin.scheduleStatusBarUpdate = () => {};
    plugin.app.vault.getAbstractFileByPath = (filePath) => createMockFile(filePath, 100, 1);
    for (let index = 0; index < 100; index++) {
      plugin.scheduleImageIndexRefresh("Images/dedupe.png", "modify");
    }
    assert(plugin.indexRefreshTimers.size === 1, `scheduleImageIndexRefresh kept ${plugin.indexRefreshTimers.size} timers for one path`);
    assert(clearedTimers === 99, `scheduleImageIndexRefresh did not clear superseded timers: ${clearedTimers}`);
    const activeTimer = scheduledTimers.filter((timer) => !timer.cleared).at(-1);
    await activeTimer.callback();
    assert(refreshCalls === 1, `scheduleImageIndexRefresh fired ${refreshCalls} refreshes for one path`);
    assert(plugin.indexRefreshTimers.size === 0, "scheduleImageIndexRefresh did not remove the fired timer from the Map");
  } finally {
    plugin.setWindowTimeout = originalSetWindowTimeoutForIndexDedupe;
    plugin.clearWindowTimeout = originalClearWindowTimeoutForIndexDedupe;
    plugin.updateImageIndexForFile = originalUpdateImageIndexForDedupe;
    plugin.scheduleStatusBarUpdate = originalScheduleStatusBarForDedupe;
    plugin.app.vault.getAbstractFileByPath = originalGetAbstractFileByPathForDedupe;
    plugin.indexRefreshTimers.clear();
  }

  const originalCacheDataForRename = plugin.cache.cacheData;
  try {
    plugin.cache.cacheData = plugin.cache.getEmptyCacheData();
    const oldPath = "Images/old-name.png";
    const newPath = "Images/new-name.png";
    const oldKey = plugin.cache.buildCacheKey(oldPath, MOCK_MD5, 777);
    plugin.cache.cacheData.entries[oldKey] = {
      path: oldPath,
      md5: MOCK_MD5,
      mtime: 777,
      sourceMtime: 777,
      sourceSize: 1000,
      timestamp: 1,
      state: "pending_move",
      outputPath: "Compressed/Images/old-name.png"
    };
    await plugin.cache.renameCacheEntries(oldPath, newPath);
    assert(plugin.cache.getEntriesForPath(oldPath).length === 0, "renameCacheEntries() left old path entries behind");
    const renamedEntries = plugin.cache.getEntriesForPath(newPath);
    assert(renamedEntries.length === 1 && renamedEntries[0][1].outputPath === "Compressed/Images/old-name.png", "renameCacheEntries() did not migrate path while preserving output metadata");
    const legacyNoMtimeKey = "legacy-no-mtime";
    plugin.cache.cacheData.entries = {
      [legacyNoMtimeKey]: {
        path: oldPath,
        md5: MOCK_MD5,
        timestamp: 2
      }
    };
    await plugin.cache.renameCacheEntries(oldPath, newPath);
    assert(plugin.cache.cacheData.entries[legacyNoMtimeKey]?.path === oldPath, "renameCacheEntries() rewrote a no-mtime entry with a synthetic Date.now cache key");
    assert(!plugin.cache.getEntriesForPath(newPath).some(([key]) => key !== legacyNoMtimeKey), "renameCacheEntries() created a migrated key without a real source mtime");
  } finally {
    plugin.cache.cacheData = originalCacheDataForRename;
  }

  const originalCacheDataForMissingMtime = plugin.cache.cacheData;
  const noMtimeWarn = captureConsoleWarn();
  try {
    plugin.cache.cacheData = plugin.cache.getEmptyCacheData();
    const missingMtimeKey = await plugin.cache.getCacheKey({ path: "Images/no-mtime.png" }, "Images/no-mtime.png", null);
    assert(missingMtimeKey === "", "getCacheKey() synthesized a cache key without a real source mtime");
    await plugin.cache.addToCache("v2:no-mtime", 100, null, "Compressed/Images/no-mtime.png", "Images/no-mtime.png", null);
    assert(Object.keys(plugin.cache.cacheData.entries).length === 0, "addToCache() wrote an entry without a real source mtime");
    assert(noMtimeWarn.messages.some((message) => message.includes("without real mtime")), "Missing-mtime cache key path did not warn");
  } finally {
    noMtimeWarn.restore();
    plugin.cache.cacheData = originalCacheDataForMissingMtime;
  }

  const originalCompressorCompressForSnapshot = plugin.compressor.compress;
  const originalCacheIsProcessedForSnapshot = plugin.cache.isFileAlreadyProcessed;
  const originalCacheGetKeyForSnapshot = plugin.cache.getCacheKey;
  const originalCacheAddToCacheForSnapshot = plugin.cache.addToCache;
  const originalUpdateImageIndexForSnapshot = plugin.updateImageIndexForFile;
  try {
    const snapshotFile = createMockFile("Images/snapshot.png", 100000, 123);
    let compressorPathOverride = null;
    let cacheKeyPathOverride = null;
    let addToCachePathOverride = null;
    let addToCacheOutputPath = null;
    plugin.cache.isFileAlreadyProcessed = async () => false;
    plugin.cache.getCacheKey = async (_file, pathOverride) => {
      cacheKeyPathOverride = pathOverride;
      return "snapshot-key";
    };
    plugin.cache.addToCache = async (_key, _size, _file, outputPath, pathOverride) => {
      addToCacheOutputPath = outputPath;
      addToCachePathOverride = pathOverride;
    };
    plugin.updateImageIndexForFile = async () => {};
    plugin.compressor.compress = async (file, _settings, pathOverride) => {
      compressorPathOverride = pathOverride;
      file.path = "Images/renamed-mid-flight.png";
      return { success: true, savings: 10 };
    };
    await plugin.runCompressionBatch([snapshotFile]);
    assert(compressorPathOverride === "Images/snapshot.png", `Batch compression did not pass path snapshot to compressor: ${compressorPathOverride}`);
    assert(cacheKeyPathOverride === "Images/snapshot.png", `Batch compression did not pass path snapshot to cache key: ${cacheKeyPathOverride}`);
    assert(addToCachePathOverride === "Images/snapshot.png", `Batch compression did not pass path snapshot to cache entry: ${addToCachePathOverride}`);
    assert(String(addToCacheOutputPath).includes(path.join("Compressed", "Images", "snapshot.png")), `Batch compression used live renamed path for output metadata: ${addToCacheOutputPath}`);
  } finally {
    plugin.compressor.compress = originalCompressorCompressForSnapshot;
    plugin.cache.isFileAlreadyProcessed = originalCacheIsProcessedForSnapshot;
    plugin.cache.getCacheKey = originalCacheGetKeyForSnapshot;
    plugin.cache.addToCache = originalCacheAddToCacheForSnapshot;
    plugin.updateImageIndexForFile = originalUpdateImageIndexForSnapshot;
  }

  const originalCompressorCompressForSettingsSnapshot = plugin.compressor.compress;
  const originalCacheIsProcessedForSettingsSnapshot = plugin.cache.isFileAlreadyProcessed;
  const originalCacheGetKeyForSettingsSnapshot = plugin.cache.getCacheKey;
  const originalCacheAddToCacheForSettingsSnapshot = plugin.cache.addToCache;
  const originalUpdateImageIndexForSettingsSnapshot = plugin.updateImageIndexForFile;
  const originalSettingsForSettingsSnapshot = plugin.settings;
  try {
    plugin.settings = { ...plugin.settings, pngQuality: { min: 30, max: 40 }, jpegQuality: 70 };
    const capturedPngQualities = [];
    plugin.cache.isFileAlreadyProcessed = async () => false;
    plugin.cache.getCacheKey = async (file) => `settings-snapshot:${file.path}`;
    plugin.cache.addToCache = async () => {};
    plugin.updateImageIndexForFile = async () => {};
    plugin.compressor.compress = async (_file, settings) => {
      capturedPngQualities.push({ ...settings.pngQuality });
      plugin.settings.pngQuality = { min: 80, max: 90 };
      return { success: true, savings: 10 };
    };
    await plugin.runCompressionBatch([
      createMockFile("Images/settings-a.png", 100000, 1),
      createMockFile("Images/settings-b.png", 100000, 2),
      createMockFile("Images/settings-c.png", 100000, 3)
    ]);
    assert(capturedPngQualities.length === 3, "Settings snapshot batch did not call compressor for every file");
    assert(capturedPngQualities.every((quality) => quality.min === 30 && quality.max === 40), `Batch used mutated settings mid-flight: ${JSON.stringify(capturedPngQualities)}`);
  } finally {
    plugin.compressor.compress = originalCompressorCompressForSettingsSnapshot;
    plugin.cache.isFileAlreadyProcessed = originalCacheIsProcessedForSettingsSnapshot;
    plugin.cache.getCacheKey = originalCacheGetKeyForSettingsSnapshot;
    plugin.cache.addToCache = originalCacheAddToCacheForSettingsSnapshot;
    plugin.updateImageIndexForFile = originalUpdateImageIndexForSettingsSnapshot;
    plugin.settings = originalSettingsForSettingsSnapshot;
  }

  plugin.settings.outputFolder = "Compressed";
  await setMockFiles(plugin, [createMockFile("Images/stale.png", 120000, 2)]);
  await setCacheEntries(plugin, {
    [`Images/stale.png:${MOCK_MD5}:1`]: {
      md5: MOCK_MD5,
      mtime: 1,
      timestamp: 1,
      originalSize: 100000,
      sourceMtime: 1,
      sourceSize: 100000
    }
  });
  counts = await plugin.getImageCompressionCounts();
  assert(counts.uncompressedImages === 1, "Changed same-path image was hidden by a stale cache entry");

  await setMockFiles(plugin, [createMockFile("Images/skipped.png", 120000, 2)]);
  await setCacheEntries(plugin, {
    "Images/skipped.png": {
      skipped: true,
      reason: "pngquant_quality_failed",
      originalSize: 100000,
      sourceMtime: 1,
      sourceSize: 100000
    }
  });
  counts = await plugin.getImageCompressionCounts();
  assert(counts.uncompressedImages === 1, "Changed skipped image was hidden by a stale skipped cache entry");

  const qualitySkippedFile = createMockFile("Images/quality-skipped.png", 120000, 7);
  plugin.settings.pngQuality = { min: 65, max: 80 };
  await setMockFiles(plugin, [qualitySkippedFile]);
  await setCacheEntries(plugin, {
    "Images/quality-skipped.png": {
      path: "Images/quality-skipped.png",
      skipped: true,
      state: "skipped",
      reason: "pngquant_quality_failed",
      originalSize: 120000,
      sourceMtime: 7,
      sourceSize: 120000,
      compressionSettingsKey: "png:65-80"
    }
  });
  counts = await plugin.getImageCompressionCounts();
  assert(counts.uncompressedImages === 0, "Quality-aware skipped image was not treated as processed before settings changed");
  plugin.settings.pngQuality = { min: 40, max: 60 };
  await plugin.rebuildImageIndex("quality-skip-settings-change");
  counts = await plugin.getImageCompressionCounts();
  assert(counts.uncompressedImages === 1, "Skipped image stayed processed after relevant quality settings changed");
  await setCacheEntries(plugin, {
    "Images/legacy-quality-skipped.png": {
      path: "Images/quality-skipped.png",
      skipped: true,
      state: "skipped",
      reason: "pngquant_quality_failed",
      originalSize: 120000,
      sourceMtime: 7,
      sourceSize: 120000
    }
  });
  counts = await plugin.getImageCompressionCounts();
  assert(counts.uncompressedImages === 1, "Legacy settings-sensitive skipped image without quality key was not re-evaluated");
  plugin.settings.pngQuality = { min: 65, max: 80 };

  await setMockFiles(plugin, [createMockFile("Images/legacy-moved.jpg", 70000, 9)]);
  await setCacheEntries(plugin, {
    [`Images/legacy-moved.jpg:${MOCK_MD5}:1`]: {
      md5: MOCK_MD5,
      mtime: 1,
      timestamp: 1,
      originalSize: 100000
    }
  });
  counts = await plugin.getImageCompressionCounts();
  assert(counts.uncompressedImages === 0, "Legacy moved compressed file was not treated as processed");

  await setMockFiles(plugin, [createMockFile("Images/legacy-mtime-only.jpg", 100000, 9)]);
  await setCacheEntries(plugin, {
    [`Images/legacy-mtime-only.jpg:${MOCK_MD5}:9`]: {
      md5: MOCK_MD5,
      mtime: 9,
      timestamp: 1
    }
  });
  counts = await plugin.getImageCompressionCounts();
  assert(counts.uncompressedImages === 0, "Legacy mtime-only cache entry was not treated as processed");

  await setMockFiles(plugin, [createMockFile("Images/legacy-path-only.jpg", 120000, 99)]);
  await setCacheEntries(plugin, {
    [`Images/legacy-path-only.jpg:${MOCK_MD5}:1`]: {
      md5: MOCK_MD5,
      mtime: 1,
      timestamp: 1,
      originalSize: 100000
    }
  });
  counts = await plugin.getImageCompressionCounts();
  assert(counts.uncompressedImages === 0, "Legacy path-only cache entry should stay processed for old pre-fingerprint caches");

  await setMockFiles(plugin, [createMockFile("Images/future-moved.jpg", 70000, 9)]);
  await setCacheEntries(plugin, {
    [`Images/future-moved.jpg:${MOCK_MD5_ALT}:1`]: {
      md5: MOCK_MD5_ALT,
      mtime: 1,
      timestamp: 1,
      originalSize: 100000,
      processedMtime: 9,
      processedSize: 70000,
      moved: true
    }
  });
  counts = await plugin.getImageCompressionCounts();
  const migratedMovedEntry = plugin.cache.getEntriesForPath("Images/future-moved.jpg")[0]?.[1];
  assert(migratedMovedEntry?.state === "moved" && !Object.prototype.hasOwnProperty.call(migratedMovedEntry, "moved"), "Legacy moved flag was not migrated to canonical state");
  assert(counts.uncompressedImages === 0, "Moved processed fingerprint was not treated as processed");

  await setMockFiles(plugin, [createMockFile("Images/conflicting-state.jpg", 50000, 20)]);
  await setCacheEntries(plugin, {
    [`Images/conflicting-state.jpg:${MOCK_MD5}:10`]: {
      state: "skipped",
      moved: true,
      md5: MOCK_MD5,
      mtime: 10,
      timestamp: 1,
      sourceMtime: 10,
      sourceSize: 100000,
      processedMtime: 20,
      processedSize: 50000
    }
  });
  const conflictingStateEntry = plugin.cache.getEntriesForPath("Images/conflicting-state.jpg")[0]?.[1];
  assert(conflictingStateEntry?.state === "skipped" && !Object.prototype.hasOwnProperty.call(conflictingStateEntry, "moved"), "Conflicting legacy state fields were not collapsed during normalization");
  counts = await plugin.getImageCompressionCounts();
  assert(counts.uncompressedImages === 1, "Conflicting legacy moved flag overrode canonical skipped state");

  const pendingTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-pending-"));
  try {
    plugin.settings.outputFolder = "Compressed";
    plugin.app.vault.adapter.basePath = pendingTemp;
    plugin.app.vault.adapter.path.absolute = pendingTemp;
    plugin.cache.cacheData.entries = {};
    const pendingOutputPath = path.join(pendingTemp, "Compressed", "Images", "pending.jpg");
    fs.mkdirSync(path.dirname(pendingOutputPath), { recursive: true });
    fs.writeFileSync(pendingOutputPath, Buffer.alloc(50000));
    const pendingOutputStats = fs.statSync(pendingOutputPath);
    await setMockFiles(plugin, [createMockFile("Images/pending.jpg", 100000, 10)]);
    await setCacheEntries(plugin, {
      [`Images/pending.jpg:${MOCK_MD5}:10`]: {
        state: "pending_move",
        md5: MOCK_MD5,
        mtime: 10,
        timestamp: 1,
        originalSize: 100000,
        sourceMtime: 10,
        sourceSize: 100000,
        outputPath: "Compressed/Images/pending.jpg",
        outputMtime: Math.round(pendingOutputStats.mtimeMs),
        outputSize: 50000
      }
    });
    counts = await plugin.getImageCompressionCounts();
    assert(counts.uncompressedImages === 0, "Valid pending_move output was not treated as processed");

    await setMockFiles(plugin, [createMockFile("Images/pending-missing-output-identity.jpg", 100000, 10)]);
    await setCacheEntries(plugin, {
      [`Images/pending-missing-output-identity.jpg:${MOCK_MD5}:10`]: {
        state: "pending_move",
        md5: MOCK_MD5,
        mtime: 10,
        timestamp: 1,
        originalSize: 100000,
        sourceMtime: 10,
        sourceSize: 100000,
        outputPath: "Compressed/Images/pending.jpg"
      }
    });
    counts = await plugin.getImageCompressionCounts();
    assert(counts.uncompressedImages === 1, "pending_move without output size/mtime identity hid an uncompressed source");

    await setMockFiles(plugin, [createMockFile("Images/pending-null-source-size.jpg", 100000, 10)]);
    await setCacheEntries(plugin, {
      [`Images/pending-null-source-size.jpg:${MOCK_MD5}:10`]: {
        state: "pending_move",
        md5: MOCK_MD5,
        mtime: 10,
        timestamp: 1,
        originalSize: 100000,
        sourceMtime: 10,
        sourceSize: null,
        outputPath: "Compressed/Images/pending.jpg",
        outputMtime: Math.round(pendingOutputStats.mtimeMs),
        outputSize: 50000
      }
    });
    counts = await plugin.getImageCompressionCounts();
    assert(counts.uncompressedImages === 1, "pending_move with null source size matched as size zero");

    const lastAccessSaveKey = `Images/last-access.jpg:${MOCK_MD5}:10`;
    await setMockFiles(plugin, [createMockFile("Images/last-access.jpg", 100000, 10)]);
    await setCacheEntries(plugin, {
      [lastAccessSaveKey]: {
        state: "processed",
        md5: MOCK_MD5,
        mtime: 10,
        timestamp: 1,
        lastAccessMs: 1,
        sourceMtime: 10,
        sourceSize: 100000
      }
    });
    const lastAccessSaveEntry = plugin.cache.cacheData.entries[lastAccessSaveKey];
    const originalSaveCacheForLastAccess = plugin.cache.saveCache;
    let lastAccessSaveOptions = null;
    try {
      plugin.cache.lastAccessSaveAt = 0;
      plugin.cache.lastAccessSavePromise = null;
      plugin.cache.saveCache = async (options) => {
        lastAccessSaveOptions = options;
      };
      const freshLastAccess = await plugin.cache.getFreshEntryForFile(createMockFile("Images/last-access.jpg", 100000, 10));
      await plugin.cache.lastAccessSavePromise;
      assert(freshLastAccess, "lastAccess smoke setup did not find the cache entry");
      assert(lastAccessSaveEntry.lastAccessMs > 1, "Cache hit did not bump lastAccessMs");
      assert(lastAccessSaveOptions?.mergeDiskEntries === true, "Cache hit did not schedule a merge-safe lastAccessMs save");
    } finally {
      plugin.cache.saveCache = originalSaveCacheForLastAccess;
      plugin.cache.lastAccessSavePromise = null;
    }

    fs.unlinkSync(pendingOutputPath);
    await plugin.refreshImageIndexProcessedStates();
    counts = await plugin.getImageCompressionCounts();
    assert(counts.uncompressedImages === 1, "Missing pending_move output did not make the source image uncompressed again");

    fs.writeFileSync(pendingOutputPath, Buffer.alloc(50000));
    const changedSourceOutputStats = fs.statSync(pendingOutputPath);
    await setMockFiles(plugin, [createMockFile("Images/pending-source-changed.jpg", 100001, 11)]);
    await setCacheEntries(plugin, {
      [`Images/pending-source-changed.jpg:${MOCK_MD5}:10`]: {
        state: "pending_move",
        md5: MOCK_MD5,
        mtime: 10,
        timestamp: 1,
        originalSize: 100000,
        sourceMtime: 10,
        sourceSize: 100000,
        outputPath: "Compressed/Images/pending.jpg",
        outputMtime: Math.round(changedSourceOutputStats.mtimeMs),
        outputSize: 50000
      }
    });
    counts = await plugin.getImageCompressionCounts();
    assert(counts.uncompressedImages === 1, "Changed source file was hidden by a pending_move cache entry");

    await setMockFiles(plugin, [createMockFile("Images/moved-from-pending.jpg", 50000, 15)]);
    const movedFromPendingKey = `Images/moved-from-pending.jpg:${MOCK_MD5}:10`;
    await setCacheEntries(plugin, {
      [movedFromPendingKey]: {
        state: "pending_move",
        md5: MOCK_MD5,
        mtime: 10,
        timestamp: 1,
        originalSize: 100000,
        sourceMtime: 10,
        sourceSize: 100000,
        outputPath: "Compressed/Images/pending.jpg",
        outputMtime: Math.round(changedSourceOutputStats.mtimeMs),
        outputSize: 50000
      }
    });
    await plugin.cache.markProcessedFileMoved("Images/moved-from-pending.jpg", { mtimeMs: 15, size: 50000 }, 100000);
    await plugin.rebuildImageIndex("smoke-moved");
    const movedEntry = plugin.cache.cacheData.entries[movedFromPendingKey];
    assert(movedEntry.state === "moved", "markProcessedFileMoved() did not set state=moved");
    assert(typeof movedEntry.stateUpdatedAt === "number", "markProcessedFileMoved() did not record stateUpdatedAt");
    assert(!Object.prototype.hasOwnProperty.call(movedEntry, "moved") && !Object.prototype.hasOwnProperty.call(movedEntry, "movedAt"), "markProcessedFileMoved() kept legacy moved fields");

    const invalidMovedKey = `Images/invalid-moved.jpg:${MOCK_MD5}:10`;
    await setCacheEntries(plugin, {
      [invalidMovedKey]: {
        state: "pending_move",
        md5: MOCK_MD5,
        mtime: 10,
        timestamp: 1,
        originalSize: 100000,
        sourceMtime: 10,
        sourceSize: 100000,
        outputPath: "Compressed/Images/pending.jpg",
        outputMtime: Math.round(changedSourceOutputStats.mtimeMs),
        outputSize: 50000
      }
    });
    await plugin.cache.markProcessedFileMoved("Images/invalid-moved.jpg", { mtimeMs: 16 }, 100000);
    assert(plugin.cache.cacheData.entries[invalidMovedKey].state === "pending_move", "markProcessedFileMoved() wrote a moved entry without processed size");

    fs.rmSync(path.join(pendingTemp, "Compressed"), { recursive: true, force: true });
    counts = await plugin.getImageCompressionCounts();
    assert(counts.uncompressedImages === 0, "Moved entry still depended on the deleted Compressed output");

    await setMockFiles(plugin, [createMockFile("Images/select-pending.jpg", 50000, 20)]);
    const selectPendingKey = `Images/select-pending.jpg:${MOCK_MD5}:10`;
    const selectLegacyKey = `Images/select-pending.jpg:${MOCK_MD5_ALT}:1`;
    await setCacheEntries(plugin, {
      [selectLegacyKey]: {
        md5: MOCK_MD5_ALT,
        mtime: 1,
        timestamp: 999,
        originalSize: 100000
      },
      [selectPendingKey]: {
        path: "Images/select-pending.jpg",
        state: "pending_move",
        md5: MOCK_MD5,
        mtime: 10,
        timestamp: 1,
        originalSize: 100000,
        sourceMtime: 10,
        sourceSize: 100000,
        outputPath: "Compressed/Images/pending.jpg"
      }
    });
    await plugin.cache.markProcessedFileMoved("Images/select-pending.jpg", { mtimeMs: 20, size: 50000 }, 100000);
    assert(plugin.cache.cacheData.entries[selectPendingKey].state === "moved", "markProcessedFileMoved() did not prefer pending_move entry");
    assert(plugin.cache.cacheData.entries[selectLegacyKey].state !== "moved", "markProcessedFileMoved() updated legacy entry instead of pending_move");

    await setMockFiles(plugin, [createMockFile("Images/select-output.jpg", 50000, 25)]);
    const selectCurrentOutputKey = `Images/select-output.jpg:${MOCK_MD5}:10`;
    const selectStaleOutputKey = `Images/select-output.jpg:${MOCK_MD5_ALT}:11`;
    await setCacheEntries(plugin, {
      [selectStaleOutputKey]: {
        path: "Images/select-output.jpg",
        state: "pending_move",
        md5: MOCK_MD5_ALT,
        mtime: 11,
        timestamp: 999,
        originalSize: 100000,
        sourceMtime: 11,
        sourceSize: 100000,
        outputPath: "Compressed/Images/stale-output.jpg"
      },
      [selectCurrentOutputKey]: {
        path: "Images/select-output.jpg",
        state: "pending_move",
        md5: MOCK_MD5,
        mtime: 10,
        timestamp: 1,
        originalSize: 100000,
        sourceMtime: 10,
        sourceSize: 100000,
        outputPath: "Compressed/Images/current-output.jpg"
      }
    });
    await plugin.cache.markProcessedFileMoved("Images/select-output.jpg", { mtimeMs: 25, size: 50000 }, 100000, "Compressed/Images/current-output.jpg");
    assert(plugin.cache.cacheData.entries[selectCurrentOutputKey].state === "moved", "markProcessedFileMoved() did not prefer the entry for the moved compressed output");
    assert(plugin.cache.cacheData.entries[selectStaleOutputKey].state === "pending_move", "markProcessedFileMoved() updated a newer timestamp entry with a different compressed output");

    const originalMalformedCacheData = plugin.cache.cacheData;
    try {
      plugin.cache.cacheData = { version: plugin.cache.CACHE_VERSION, entries: [] };
      assert(plugin.cache.getEntriesByPathMap().size === 0, "Malformed in-memory cache entries were not rejected");
    } finally {
      plugin.cache.cacheData = originalMalformedCacheData;
    }

    const noCacheMovedFile = Object.assign(new ObsidianMock.TFile(), createMockFile("Images/no-cache-entry.jpg", 50000, 30));
    await setMockFiles(plugin, [noCacheMovedFile]);
    plugin.cache.cacheData.entries = {};
    await plugin.cache.markProcessedFileMoved("Images/no-cache-entry.jpg", { mtimeMs: 30, size: 50000 }, 100000);
    const expectedMovedFallbackKey = await plugin.cache.getCacheKey(noCacheMovedFile);
    const syntheticMovedEntry = plugin.cache.getEntriesForPath("Images/no-cache-entry.jpg")[0]?.[1];
    assert(syntheticMovedEntry && syntheticMovedEntry.state === "moved", "markProcessedFileMoved() did not create a fallback moved entry");
    assert(plugin.cache.cacheData.entries[expectedMovedFallbackKey]?.state === "moved", "Fallback moved entry key does not match getCacheKey(file)");
    assert(syntheticMovedEntry.md5 === crypto.createHash("md5").update(Buffer.from(noCacheMovedFile.path)).digest("hex"), "Fallback moved entry did not store the real file md5");
    const movedFallbackEntryCount = plugin.cache.getEntriesForPath("Images/no-cache-entry.jpg").length;
    await plugin.cache.addToCache(expectedMovedFallbackKey, 100000, noCacheMovedFile, "Compressed/Images/no-cache-entry.jpg");
    assert(plugin.cache.getEntriesForPath("Images/no-cache-entry.jpg").length === movedFallbackEntryCount, "Real-md5 moved fallback created a duplicate cache entry on later addToCache()");

    await setMockFiles(plugin, []);
    plugin.cache.cacheData.entries = {};
    let missingMd5Logs = 0;
    const originalConsoleErrorForMissingMd5 = console.error;
    try {
      console.error = (...args) => {
        if (String(args[1] || "").includes("Cannot mark moved file without cache entry or md5")) {
          missingMd5Logs += 1;
        }
      };
      await plugin.cache.markProcessedFileMoved("Images/missing-md5.jpg", { mtimeMs: 40, size: 50000 }, 100000);
    } finally {
      console.error = originalConsoleErrorForMissingMd5;
    }
    assert(missingMd5Logs === 1, "Missing-md5 fallback did not log a diagnostic");
    assert(plugin.cache.getEntriesForPath("Images/missing-md5.jpg").length === 0, "Missing-md5 fallback created a cache entry");
  } finally {
    fs.rmSync(pendingTemp, { recursive: true, force: true });
    plugin.app.vault.adapter.basePath = root;
    plugin.app.vault.adapter.path.absolute = root;
  }

  const originalGetAbstractFileByPathForFolder = plugin.app.vault.getAbstractFileByPath;
  try {
    const folderLikePath = "FolderLike.png";
    plugin.app.vault.getAbstractFileByPath = (filePath) => {
      if (filePath === folderLikePath) {
        const folder = new ObsidianMock.TFolder();
        folder.path = folderLikePath;
        folder.name = folderLikePath;
        return folder;
      }
      return originalGetAbstractFileByPathForFolder(filePath);
    };
    const folderOriginal = await plugin.moveService.findOriginalFileForCompressed({
      compressedPath: path.join(root, "Compressed", folderLikePath),
      relativePath: folderLikePath,
      name: folderLikePath,
      size: 50
    });
    assert(folderOriginal === null, "findOriginalFileForCompressed() treated a TFolder as an image file");
    const noCandidateRecord = {
      compressedPath: path.join(root, "Compressed", "missing-original.png"),
      relativePath: "",
      name: "missing-original.png",
      size: 50
    };
    const noCandidateOriginal = await plugin.moveService.findOriginalFile("missing-original.png", noCandidateRecord, { byName: new Map() });
    assert(noCandidateOriginal === null, "findOriginalFile() returned an original when the candidate set was empty");
    assert(noCandidateRecord.moveSkipReason === plugin.moveService.getMoveText("move.skip.noOriginalCandidate"), `Zero-candidate original used wrong skip reason: ${noCandidateRecord.moveSkipReason}`);
  } finally {
    plugin.app.vault.getAbstractFileByPath = originalGetAbstractFileByPathForFolder;
  }

  const moveLookupTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-move-lookup-"));
  try {
    plugin.app.vault.adapter.basePath = moveLookupTemp;
    plugin.app.vault.adapter.path.absolute = moveLookupTemp;
    for (const corruptWorkerPoolSize of [NaN, Infinity, -Infinity, "not-a-number"]) {
      plugin.settings.workerPoolSize = corruptWorkerPoolSize;
      assert(plugin.moveService.getIOConcurrency() === Math.max(1, Math.min(plugin.compressor.activeWorkerCount * 2, 16)), `MoveService getIOConcurrency() did not ignore corrupt legacy workerPoolSize: ${String(corruptWorkerPoolSize)}`);
      delete plugin.settings.workerPoolSize;
    }
    const duplicateA = path.join(moveLookupTemp, "Images", "a", "icon.png");
    const duplicateB = path.join(moveLookupTemp, "Images", "b", "icon.png");
    const backslashOriginal = path.join(moveLookupTemp, "Images", "slash", "photo.jpg");
    const duplicateCompressed = path.join(moveLookupTemp, "Compressed", "lost", "icon.png");
    fs.mkdirSync(path.dirname(duplicateA), { recursive: true });
    fs.mkdirSync(path.dirname(duplicateB), { recursive: true });
    fs.mkdirSync(path.dirname(backslashOriginal), { recursive: true });
    fs.mkdirSync(path.dirname(duplicateCompressed), { recursive: true });
    fs.writeFileSync(duplicateA, Buffer.alloc(100));
    fs.writeFileSync(duplicateB, Buffer.alloc(100));
    fs.writeFileSync(backslashOriginal, Buffer.alloc(100));
    fs.writeFileSync(duplicateCompressed, Buffer.alloc(50));
    await setMockFiles(plugin, [
      createMockFile("Images/a/icon.png", 100, 1),
      createMockFile("Images/b/icon.png", 100, 1),
      createMockFile("Images/slash/photo.jpg", 100, 1)
    ]);
    plugin.cache.cacheData.entries = {};
    let duplicateMovedCalls = 0;
    const originalMarkProcessedFileMoved = plugin.cache.markProcessedFileMoved;
    plugin.cache.markProcessedFileMoved = async () => {
      duplicateMovedCalls += 1;
    };
    let duplicateFailed = false;
    const originalConsoleError = console.error;
    try {
      console.error = () => {};
      await plugin.moveService.moveSingleFile({
        compressedPath: duplicateCompressed,
        relativePath: "missing/icon.png",
        name: "icon.png",
        size: 50
      });
    } catch (_) {
      duplicateFailed = true;
    } finally {
      console.error = originalConsoleError;
      plugin.cache.markProcessedFileMoved = originalMarkProcessedFileMoved;
    }
    assert(duplicateFailed, "Duplicate basename move did not fail as ambiguous");
    assert(duplicateMovedCalls === 0, "Duplicate basename move marked cache moved");
    assert(fs.statSync(duplicateA).size === 100 && fs.statSync(duplicateB).size === 100, "Duplicate basename move changed an original file");
    const backslashOriginalResult = await plugin.moveService.findOriginalFileForCompressed({
      compressedPath: path.join(moveLookupTemp, "Compressed", "Images", "slash", "photo.jpg"),
      relativePath: "Images\\slash\\photo.jpg",
      name: "photo.jpg",
      size: 50
    });
    assert(backslashOriginalResult === backslashOriginal, `MoveService did not normalize backslash relative paths through shared path normalization: ${backslashOriginalResult}`);

    const uniqueOriginal = path.join(moveLookupTemp, "Images", "unique", "photo.jpg");
    const uniqueCompressed = path.join(moveLookupTemp, "Compressed", "lost", "photo.jpg");
    fs.mkdirSync(path.dirname(uniqueOriginal), { recursive: true });
    fs.mkdirSync(path.dirname(uniqueCompressed), { recursive: true });
    fs.writeFileSync(uniqueOriginal, Buffer.alloc(100));
    fs.writeFileSync(uniqueCompressed, Buffer.alloc(50));
    await setMockFiles(plugin, [
      Object.assign(new ObsidianMock.TFile(), createMockFile("Images/unique/photo.jpg", 100, 2))
    ]);
    plugin.cache.cacheData.entries = {};
    await plugin.moveService.moveSingleFile({
      compressedPath: uniqueCompressed,
      relativePath: "missing/photo.jpg",
      name: "photo.jpg",
      size: 50
    });
    assert(fs.statSync(uniqueOriginal).size === 50, "Unique basename fallback did not replace the original");
    assert(!fs.existsSync(uniqueCompressed), "Unique basename fallback did not remove compressed output");
    const movedUniqueEntry = plugin.cache.getEntriesForPath("Images/unique/photo.jpg").find(([, entry]) => entry.state === "moved");
    assert(movedUniqueEntry, "Unique basename fallback did not mark cache moved");

    const deletedOriginal = path.join(moveLookupTemp, "Images", "deleted", "gone.jpg");
    const deletedCompressed = path.join(moveLookupTemp, "Compressed", "Images", "deleted", "gone.jpg");
    fs.mkdirSync(path.dirname(deletedOriginal), { recursive: true });
    fs.mkdirSync(path.dirname(deletedCompressed), { recursive: true });
    fs.writeFileSync(deletedOriginal, Buffer.alloc(100));
    fs.writeFileSync(deletedCompressed, Buffer.alloc(50));
    fs.unlinkSync(deletedOriginal);
    const deletedRecord = {
      compressedPath: deletedCompressed,
      originalPath: deletedOriginal,
      relativePath: "Images/deleted/gone.jpg",
      name: "gone.jpg",
      size: 50
    };
    await plugin.moveService.moveSingleFile(deletedRecord);
    assert(deletedRecord.moveSkipReason === plugin.moveService.getMoveText("move.skip.originalNotFoundAtMoveTime"), `Deleted original was not skipped gracefully: ${deletedRecord.moveSkipReason}`);

    const unloadOriginal = path.join(moveLookupTemp, "Images", "unload", "stop.jpg");
    const unloadCompressed = path.join(moveLookupTemp, "Compressed", "Images", "unload", "stop.jpg");
    fs.mkdirSync(path.dirname(unloadOriginal), { recursive: true });
    fs.mkdirSync(path.dirname(unloadCompressed), { recursive: true });
    fs.writeFileSync(unloadOriginal, Buffer.alloc(100));
    fs.writeFileSync(unloadCompressed, Buffer.alloc(50));
    const unloadRecord = {
      compressedPath: unloadCompressed,
      originalPath: unloadOriginal,
      relativePath: "Images/unload/stop.jpg",
      name: "stop.jpg",
      size: 50
    };
    try {
      plugin.isUnloading = true;
      await plugin.moveService.moveSingleFile(unloadRecord);
      assert(unloadRecord.moveSkipReason === plugin.moveService.getMoveText("move.skip.unloading"), `Move unload skip used wrong reason: ${unloadRecord.moveSkipReason}`);
      assert(fs.statSync(unloadOriginal).size === 100, "Move unload guard changed the original file");
      assert(fs.existsSync(unloadCompressed), "Move unload guard removed compressed output");
      const unloadBackupResult = await plugin.moveService.createBackupBeforeMove([unloadRecord]);
      assert(unloadBackupResult.files.length === 0 && unloadBackupResult.skippedCount === 1, "Backup prepass did not skip while plugin was unloading");
    } finally {
      plugin.isUnloading = false;
    }

    const selfMovePath = path.join(moveLookupTemp, "Images", "self-move.jpg");
    fs.mkdirSync(path.dirname(selfMovePath), { recursive: true });
    fs.writeFileSync(selfMovePath, Buffer.alloc(100, 0xaa));
    const originalCopyFileForSelfMove = fs.promises.copyFile;
    let selfMoveCopyCalls = 0;
    try {
      fs.promises.copyFile = async (...args) => {
        selfMoveCopyCalls += 1;
        return await originalCopyFileForSelfMove.call(fs.promises, ...args);
      };
      const selfMoveRecord = {
        compressedPath: selfMovePath,
        originalPath: selfMovePath,
        relativePath: "Images/self-move.jpg",
        name: "self-move.jpg",
        size: 100
      };
      await plugin.moveService.moveSingleFile(selfMoveRecord);
      assert(selfMoveRecord.moveSkipReason === plugin.moveService.getMoveText("move.skip.selfMove"), `Self-move used wrong skip reason: ${selfMoveRecord.moveSkipReason}`);
      assert(selfMoveCopyCalls === 0, "Self-move attempted to stage-copy over the original file");
      assert(fs.statSync(selfMovePath).size === 100, "Self-move changed the original file");

      const backupSelfMoveRecord = {
        compressedPath: selfMovePath,
        originalPath: selfMovePath,
        relativePath: "Images/self-move.jpg",
        name: "self-move.jpg",
        size: 100
      };
      const backupSelfMoveResult = await plugin.moveService.createBackupBeforeMove([backupSelfMoveRecord]);
      assert(backupSelfMoveResult.files.length === 0, "Backup prepass allowed a self-move into move tasks");
      assert(backupSelfMoveResult.skippedCount === 1, "Backup prepass did not count self-move as skipped");
      assert(backupSelfMoveRecord.moveSkipReason === plugin.moveService.getMoveText("move.skip.selfMove"), `Backup self-move used wrong skip reason: ${backupSelfMoveRecord.moveSkipReason}`);
      assert(selfMoveCopyCalls === 0, "Backup self-move copied a file onto itself");
    } finally {
      fs.promises.copyFile = originalCopyFileForSelfMove;
    }

    const backupRaceOriginal = path.join(moveLookupTemp, "Images", "backup-race.jpg");
    const backupRaceCompressed = path.join(moveLookupTemp, "Compressed", "Images", "backup-race.jpg");
    fs.mkdirSync(path.dirname(backupRaceOriginal), { recursive: true });
    fs.mkdirSync(path.dirname(backupRaceCompressed), { recursive: true });
    fs.writeFileSync(backupRaceOriginal, Buffer.alloc(100));
    fs.writeFileSync(backupRaceCompressed, Buffer.alloc(50));
    const originalStatForBackupRace = fs.promises.stat;
    let backupRaceOriginalStatCount = 0;
    try {
      fs.promises.stat = async (filePath, ...args) => {
        const stats = await originalStatForBackupRace.call(fs.promises, filePath, ...args);
        if (filePath === backupRaceOriginal) {
          backupRaceOriginalStatCount += 1;
          if (backupRaceOriginalStatCount >= 2) {
            return { ...stats, size: stats.size + 1 };
          }
        }
        return stats;
      };
      const backupRaceRecord = {
        compressedPath: backupRaceCompressed,
        originalPath: backupRaceOriginal,
        relativePath: "Images/backup-race.jpg",
        name: "backup-race.jpg",
        size: 50
      };
      const backupRaceResult = await plugin.moveService.createBackupBeforeMove([backupRaceRecord]);
      assert(backupRaceResult.files.length === 0, "Backup TOCTOU verification allowed a modified original into move tasks");
      assert(backupRaceResult.skippedCount === 1, "Backup TOCTOU verification did not count the modified original as skipped");
      assert(backupRaceRecord.moveSkipReason === plugin.moveService.getMoveText("move.skip.originalModifiedDuringBackup"), `Backup TOCTOU used wrong skip reason: ${backupRaceRecord.moveSkipReason}`);
    } finally {
      fs.promises.stat = originalStatForBackupRace;
    }

    const backupHashRaceOriginal = path.join(moveLookupTemp, "Images", "backup-hash-race.jpg");
    const backupHashRaceCompressed = path.join(moveLookupTemp, "Compressed", "Images", "backup-hash-race.jpg");
    fs.mkdirSync(path.dirname(backupHashRaceOriginal), { recursive: true });
    fs.mkdirSync(path.dirname(backupHashRaceCompressed), { recursive: true });
    fs.writeFileSync(backupHashRaceOriginal, Buffer.alloc(100, 0xaa));
    fs.writeFileSync(backupHashRaceCompressed, Buffer.alloc(50, 0xbb));
    const originalStatForBackupHashRace = fs.promises.stat;
    let backupHashRaceOriginalStatCount = 0;
    try {
      fs.promises.stat = async (filePath, ...args) => {
        const stats = await originalStatForBackupHashRace.call(fs.promises, filePath, ...args);
        if (filePath === backupHashRaceOriginal) {
          backupHashRaceOriginalStatCount += 1;
          if (backupHashRaceOriginalStatCount === 2) {
            fs.writeFileSync(backupHashRaceOriginal, Buffer.alloc(100, 0xcc));
            fs.utimesSync(backupHashRaceOriginal, stats.atime, stats.mtime);
            return await originalStatForBackupHashRace.call(fs.promises, filePath, ...args);
          }
        }
        return stats;
      };
      const backupHashRaceRecord = {
        compressedPath: backupHashRaceCompressed,
        originalPath: backupHashRaceOriginal,
        relativePath: "Images/backup-hash-race.jpg",
        name: "backup-hash-race.jpg",
        size: 50
      };
      const backupHashRaceResult = await plugin.moveService.createBackupBeforeMove([backupHashRaceRecord]);
      assert(backupHashRaceResult.files.length === 0, "Backup content-hash verification allowed a same-size modified original into move tasks");
      assert(backupHashRaceResult.skippedCount === 1, "Backup content-hash verification did not count the modified original as skipped");
      assert(
        backupHashRaceRecord.moveSkipReason === plugin.moveService.getMoveText("move.skip.originalContentChangedDuringBackup"),
        `Backup content-hash verification used wrong skip reason: ${backupHashRaceRecord.moveSkipReason}`
      );
    } finally {
      fs.promises.stat = originalStatForBackupHashRace;
    }

    // T1 / H1 phase-2 regression (compressed branch): a same-size content
    // substitution of the COMPRESSED file between prepass and copy must be caught
    // by SHA-256 verification, mirroring the original-file guard above.
    const backupCompressedHashOriginal = path.join(moveLookupTemp, "Images", "backup-compressed-hash.jpg");
    const backupCompressedHashCompressed = path.join(moveLookupTemp, "Compressed", "Images", "backup-compressed-hash.jpg");
    fs.mkdirSync(path.dirname(backupCompressedHashOriginal), { recursive: true });
    fs.mkdirSync(path.dirname(backupCompressedHashCompressed), { recursive: true });
    fs.writeFileSync(backupCompressedHashOriginal, Buffer.alloc(100, 0xaa));
    fs.writeFileSync(backupCompressedHashCompressed, Buffer.alloc(50, 0xbb));
    const originalStatForCompressedHashRace = fs.promises.stat;
    let backupCompressedHashStatCount = 0;
    try {
      fs.promises.stat = async (filePath, ...args) => {
        const stats = await originalStatForCompressedHashRace.call(fs.promises, filePath, ...args);
        if (filePath === backupCompressedHashCompressed) {
          backupCompressedHashStatCount += 1;
          if (backupCompressedHashStatCount === 2) {
            fs.writeFileSync(backupCompressedHashCompressed, Buffer.alloc(50, 0xdd));
            fs.utimesSync(backupCompressedHashCompressed, stats.atime, stats.mtime);
            return await originalStatForCompressedHashRace.call(fs.promises, filePath, ...args);
          }
        }
        return stats;
      };
      const backupCompressedHashRecord = {
        compressedPath: backupCompressedHashCompressed,
        originalPath: backupCompressedHashOriginal,
        relativePath: "Images/backup-compressed-hash.jpg",
        name: "backup-compressed-hash.jpg",
        size: 50
      };
      const backupCompressedHashResult = await plugin.moveService.createBackupBeforeMove([backupCompressedHashRecord]);
      assert(backupCompressedHashResult.files.length === 0, "Backup content-hash verification allowed a same-size modified compressed file into move tasks");
      assert(backupCompressedHashResult.skippedCount === 1, "Backup content-hash verification did not count the modified compressed file as skipped");
      assert(
        backupCompressedHashRecord.moveSkipReason === plugin.moveService.getMoveText("move.skip.compressedContentChangedDuringBackup"),
        `Backup compressed content-hash verification used wrong skip reason: ${backupCompressedHashRecord.moveSkipReason}`
      );
    } finally {
      fs.promises.stat = originalStatForCompressedHashRace;
    }

    // T1 / H1 phase-3 regression (post-copy verification): if the bytes that land in
    // the backup do not match the verified source hash (TOCTOU between verify and
    // copy), the backup must be rejected and the partial backup cleaned up — never
    // accepted as a valid backup.
    const backupPostCopyOriginal = path.join(moveLookupTemp, "Images", "backup-postcopy.jpg");
    const backupPostCopyCompressed = path.join(moveLookupTemp, "Compressed", "Images", "backup-postcopy.jpg");
    fs.mkdirSync(path.dirname(backupPostCopyOriginal), { recursive: true });
    fs.mkdirSync(path.dirname(backupPostCopyCompressed), { recursive: true });
    fs.writeFileSync(backupPostCopyOriginal, Buffer.alloc(100, 0xaa));
    fs.writeFileSync(backupPostCopyCompressed, Buffer.alloc(50, 0xbb));
    const originalCopyFileForPostCopy = fs.promises.copyFile;
    let postCopyTamperApplied = false;
    try {
      fs.promises.copyFile = async (src, dest, ...args) => {
        const destStr = String(dest);
        // Original's backup copy lands with the right size but wrong bytes.
        if (
          String(src) === backupPostCopyOriginal
          && destStr.includes(path.join(".local-image-compress", "backups", "originals"))
        ) {
          fs.writeFileSync(dest, Buffer.alloc(100, 0x00));
          postCopyTamperApplied = true;
          return;
        }
        return await originalCopyFileForPostCopy.call(fs.promises, src, dest, ...args);
      };
      const backupPostCopyRecord = {
        compressedPath: backupPostCopyCompressed,
        originalPath: backupPostCopyOriginal,
        relativePath: "Images/backup-postcopy.jpg",
        name: "backup-postcopy.jpg",
        size: 50
      };
      const backupPostCopyResult = await plugin.moveService.createBackupBeforeMove([backupPostCopyRecord]);
      assert(postCopyTamperApplied, "Post-copy backup test never intercepted the original's backup copy");
      assert(backupPostCopyResult.files.length === 0, "Post-copy backup verification accepted a backup whose content did not match the source");
      assert(backupPostCopyResult.skippedCount === 1, "Post-copy backup verification did not count the corrupted backup as skipped");
      assert(
        backupPostCopyRecord.moveSkipReason === plugin.moveService.getMoveText("move.skip.contentChangedDuringCopy"),
        `Post-copy backup verification used wrong skip reason: ${backupPostCopyRecord.moveSkipReason}`
      );
    } finally {
      fs.promises.copyFile = originalCopyFileForPostCopy;
    }

    const externalOriginal = path.join(moveLookupTemp, "Images", "external.jpg");
    const externalCompressed = path.join(moveLookupTemp, "Compressed", "Images", "external.jpg");
    fs.mkdirSync(path.dirname(externalOriginal), { recursive: true });
    fs.mkdirSync(path.dirname(externalCompressed), { recursive: true });
    fs.writeFileSync(externalOriginal, Buffer.alloc(100));
    fs.writeFileSync(externalCompressed, Buffer.alloc(50));
    const originalStatForExternalMove = fs.promises.stat;
    const originalNoticeForExternalMove = ObsidianMock.Notice;
    const externalMoveNotices = [];
    let externalOriginalStatCount = 0;
    try {
      ObsidianMock.Notice = class {
        constructor(message, duration) {
          externalMoveNotices.push({ message, duration });
        }
      };
      fs.promises.stat = async (filePath, ...args) => {
        const stats = await originalStatForExternalMove.call(fs.promises, filePath, ...args);
        if (filePath === externalOriginal) {
          externalOriginalStatCount += 1;
          if (externalOriginalStatCount >= 2) {
            return { ...stats, size: stats.size + 1 };
          }
        }
        return stats;
      };
      const externalRecord = {
        compressedPath: externalCompressed,
        originalPath: externalOriginal,
        relativePath: "Images/external.jpg",
        name: "external.jpg",
        size: 50
      };
      await plugin.moveService.moveSingleFile(externalRecord);
      assert(externalRecord.moveSkipReason === plugin.moveService.getMoveText("move.skip.externalModification"), `External modification used wrong skip reason: ${externalRecord.moveSkipReason}`);
      assert(externalMoveNotices.some((notice) => String(notice.message).includes("external.jpg") && notice.duration === 10000), "External modification did not create a user-visible Notice");
    } finally {
      fs.promises.stat = originalStatForExternalMove;
      ObsidianMock.Notice = originalNoticeForExternalMove;
    }

    const originalModalForMoveResult = ObsidianMock.Modal;
    let moveResultModal = null;
    try {
      ObsidianMock.Modal = class extends originalModalForMoveResult {
        open() {
          moveResultModal = this;
          super.open();
        }
      };
      plugin.moveService.showMoveResult(0, 0, false, 99, [
        { moveSkipReason: "Original missing before backup" },
        { moveSkipReason: "Original missing before backup" },
        { moveSkipReason: "Compressed file changed during backup" }
      ]);
      const skippedSummaryText = (moveResultModal?.contentEl.children || [])
        .map((child) => child.textContent)
        .find((text) => String(text).startsWith("Skipped:"));
      assert(skippedSummaryText === "Skipped: 3", `Move result modal did not derive skipped summary from reason groups: ${skippedSummaryText}`);
      const reasonList = moveResultModal?.contentEl.querySelectorAll(".tiny-local-move-skip-reasons")[0];
      const reasonTexts = (reasonList?.children || []).map((child) => child.textContent).sort();
      assert(
        JSON.stringify(reasonTexts) === JSON.stringify([
          "Compressed file changed during backup: 1",
          "Original missing before backup: 2"
        ]),
        `Move result modal did not show grouped skip reasons: ${reasonTexts.join(" | ")}`
      );
    } finally {
      ObsidianMock.Modal = originalModalForMoveResult;
    }
  } finally {
    fs.rmSync(moveLookupTemp, { recursive: true, force: true });
    plugin.app.vault.adapter.basePath = root;
    plugin.app.vault.adapter.path.absolute = root;
  }

  const moveFailTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-move-fail-"));
  try {
    const originalPath = path.join(moveFailTemp, "Images", "move-fail.jpg");
    const compressedPath = path.join(moveFailTemp, "Compressed", "Images", "move-fail.jpg");
    fs.mkdirSync(path.dirname(originalPath), { recursive: true });
    fs.mkdirSync(path.dirname(compressedPath), { recursive: true });
    fs.writeFileSync(originalPath, Buffer.alloc(100));
    fs.writeFileSync(compressedPath, Buffer.alloc(50));
    plugin.app.vault.adapter.basePath = moveFailTemp;
    plugin.app.vault.adapter.path.absolute = moveFailTemp;
    const originalRename = fs.promises.rename;
    const originalMarkProcessedFileMoved = plugin.cache.markProcessedFileMoved;
    const originalConsoleError = console.error;
    let markMovedCalls = 0;
    fs.promises.rename = async () => {
      throw new Error("simulated staged replace failure");
    };
    plugin.cache.markProcessedFileMoved = async () => {
      markMovedCalls += 1;
    };
    let failedAsExpected = false;
    try {
      console.error = () => {};
      await plugin.moveService.moveSingleFile({
        compressedPath,
        originalPath,
        relativePath: "Images/move-fail.jpg",
        name: "move-fail.jpg",
        size: 50
      });
    } catch (_) {
      failedAsExpected = true;
    } finally {
      console.error = originalConsoleError;
      fs.promises.rename = originalRename;
      plugin.cache.markProcessedFileMoved = originalMarkProcessedFileMoved;
    }
    assert(failedAsExpected, "moveSingleFile() did not surface staged replace failure");
    assert(markMovedCalls === 0, "moveSingleFile() marked cache moved after failed staged replace");
    assert(fs.statSync(originalPath).size === 100, "Failed staged replace changed original file size");
    assert(fs.existsSync(compressedPath), "Failed staged replace deleted compressed output");
    const tempLeftovers = fs.readdirSync(path.dirname(originalPath)).filter((name) => name.includes(".tinylocal-"));
    assert(tempLeftovers.length === 0, `Failed staged replace left temp files: ${tempLeftovers.join(", ")}`);
  } finally {
    fs.rmSync(moveFailTemp, { recursive: true, force: true });
    plugin.app.vault.adapter.basePath = root;
    plugin.app.vault.adapter.path.absolute = root;
  }

  const moveCleanupFailTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-move-cleanup-fail-"));
  try {
    const originalPath = path.join(moveCleanupFailTemp, "Images", "cleanup-fail.jpg");
    const compressedPath = path.join(moveCleanupFailTemp, "Compressed", "Images", "cleanup-fail.jpg");
    fs.mkdirSync(path.dirname(originalPath), { recursive: true });
    fs.mkdirSync(path.dirname(compressedPath), { recursive: true });
    fs.writeFileSync(originalPath, Buffer.alloc(100));
    fs.writeFileSync(compressedPath, Buffer.alloc(50));
    plugin.app.vault.adapter.basePath = moveCleanupFailTemp;
    plugin.app.vault.adapter.path.absolute = moveCleanupFailTemp;
    const originalUnlink = fs.promises.unlink;
    const originalMarkProcessedFileMoved = plugin.cache.markProcessedFileMoved;
    const originalConsoleError = console.error;
    let markMovedCalls = 0;
    fs.promises.unlink = async (filePath) => {
      if (filePath === compressedPath) {
        throw new Error("simulated compressed cleanup failure");
      }
      return originalUnlink.call(fs.promises, filePath);
    };
    plugin.cache.markProcessedFileMoved = async () => {
      markMovedCalls += 1;
    };
    let failedAsExpected = false;
    try {
      console.error = () => {};
      await plugin.moveService.moveSingleFile({
        compressedPath,
        originalPath,
        relativePath: "Images/cleanup-fail.jpg",
        name: "cleanup-fail.jpg",
        size: 50
      });
    } catch (_) {
      failedAsExpected = true;
    } finally {
      console.error = originalConsoleError;
      fs.promises.unlink = originalUnlink;
      plugin.cache.markProcessedFileMoved = originalMarkProcessedFileMoved;
    }
    assert(!failedAsExpected, "moveSingleFile() surfaced a non-fatal compressed cleanup failure");
    assert(markMovedCalls === 1, "moveSingleFile() did not mark cache moved before non-fatal compressed cleanup");
    assert(fs.statSync(originalPath).size === 50, "Compressed cleanup failure did not happen after staged replace");
    assert(fs.existsSync(compressedPath), "Compressed cleanup failure unexpectedly deleted compressed output");
  } finally {
    fs.rmSync(moveCleanupFailTemp, { recursive: true, force: true });
    plugin.app.vault.adapter.basePath = root;
    plugin.app.vault.adapter.path.absolute = root;
  }

  const moveExternalEditTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-move-external-edit-"));
  try {
    const originalPath = path.join(moveExternalEditTemp, "Images", "external-edit.jpg");
    const compressedPath = path.join(moveExternalEditTemp, "Compressed", "Images", "external-edit.jpg");
    fs.mkdirSync(path.dirname(originalPath), { recursive: true });
    fs.mkdirSync(path.dirname(compressedPath), { recursive: true });
    fs.writeFileSync(originalPath, Buffer.alloc(100));
    fs.writeFileSync(compressedPath, Buffer.alloc(50));
    plugin.app.vault.adapter.basePath = moveExternalEditTemp;
    plugin.app.vault.adapter.path.absolute = moveExternalEditTemp;
    const originalRename = fs.promises.rename;
    const originalMarkProcessedFileMoved = plugin.cache.markProcessedFileMoved;
    const externalEditWarnings = captureConsoleWarn();
    let markMovedCalls = 0;
    try {
      fs.promises.rename = async (sourcePath, destPath) => {
        await originalRename.call(fs.promises, sourcePath, destPath);
        fs.writeFileSync(destPath, Buffer.alloc(200));
      };
      plugin.cache.markProcessedFileMoved = async () => {
        markMovedCalls += 1;
      };
      await plugin.moveService.moveSingleFile({
        compressedPath,
        originalPath,
        relativePath: "Images/external-edit.jpg",
        name: "external-edit.jpg",
        size: 50
      });
    } finally {
      fs.promises.rename = originalRename;
      plugin.cache.markProcessedFileMoved = originalMarkProcessedFileMoved;
      externalEditWarnings.restore();
    }
    assert(markMovedCalls === 0, "External edit during move was written to cache as moved");
    assert(fs.existsSync(compressedPath), "External edit during move removed compressed output");
    assert(externalEditWarnings.messages.some((message) => message.includes("External modification detected during move")), "External edit during move did not emit the expected warning");
  } finally {
    fs.rmSync(moveExternalEditTemp, { recursive: true, force: true });
    plugin.app.vault.adapter.basePath = root;
    plugin.app.vault.adapter.path.absolute = root;
  }

  const orphanMoveTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-orphan-move-"));
  try {
    const originalPath = path.join(orphanMoveTemp, "Images", "orphan.jpg");
    const compressedPath = path.join(orphanMoveTemp, "Compressed", "Images", "orphan.jpg");
    fs.mkdirSync(path.dirname(originalPath), { recursive: true });
    fs.mkdirSync(path.dirname(compressedPath), { recursive: true });
    const sharedContent = Buffer.from("already moved compressed content");
    fs.writeFileSync(originalPath, sharedContent);
    fs.writeFileSync(compressedPath, sharedContent);
    plugin.app.vault.adapter.basePath = orphanMoveTemp;
    plugin.app.vault.adapter.path.absolute = orphanMoveTemp;
    await setMockFiles(plugin, [
      Object.assign(new ObsidianMock.TFile(), createMockFile("Images/orphan.jpg", sharedContent.length, 44))
    ]);
    plugin.cache.cacheData.entries = {};
    await plugin.moveService.moveSingleFile({
      compressedPath,
      originalPath,
      relativePath: "Images/orphan.jpg",
      name: "orphan.jpg",
      size: sharedContent.length
    });
    assert(!fs.existsSync(compressedPath), "Orphan compressed output was not removed");
    const orphanIdenticalEntry = plugin.cache.getEntriesForPath("Images/orphan.jpg").find(([, entry]) => entry.state === "skipped_identical");
    assert(orphanIdenticalEntry, "Bit-identical compressed output was not marked with a distinct skipped_identical cache state");

    const streamCompareA = path.join(orphanMoveTemp, "Images", "stream-a.bin");
    const streamCompareB = path.join(orphanMoveTemp, "Images", "stream-b.bin");
    fs.writeFileSync(streamCompareA, Buffer.alloc(256 * 1024, 7));
    fs.writeFileSync(streamCompareB, Buffer.alloc(256 * 1024, 7));
    const originalReadFileSyncForStreamCompare = fs.readFileSync;
    try {
      fs.readFileSync = (filePath, ...args) => {
        if (filePath === streamCompareA || filePath === streamCompareB) {
          throw new Error("filesHaveSameContent should not read whole files");
        }
        return originalReadFileSyncForStreamCompare(filePath, ...args);
      };
      assert(await plugin.moveService.filesHaveSameContent(streamCompareA, streamCompareB), "Streaming same-content comparison returned false for identical files");
      fs.writeFileSync(streamCompareB, Buffer.concat([Buffer.from([8]), Buffer.alloc(256 * 1024 - 1, 7)]));
      assert(!await plugin.moveService.filesHaveSameContent(streamCompareA, streamCompareB), "Streaming same-content comparison returned true for early mismatch");
    } finally {
      fs.readFileSync = originalReadFileSyncForStreamCompare;
    }

    const bigCompareA = path.join(orphanMoveTemp, "Images", "stream-200mb-a.bin");
    const bigCompareB = path.join(orphanMoveTemp, "Images", "stream-200mb-b.bin");
    const bigCompareSize = 200 * 1024 * 1024;
    const writeSparseCompareFile = (filePath, finalByte) => {
      const handle = fs.openSync(filePath, "w");
      try {
        fs.ftruncateSync(handle, bigCompareSize);
        fs.writeSync(handle, Buffer.from([finalByte]), 0, 1, bigCompareSize - 1);
      } finally {
        fs.closeSync(handle);
      }
    };
    writeSparseCompareFile(bigCompareA, 9);
    writeSparseCompareFile(bigCompareB, 9);
    assert(await plugin.moveService.filesHaveSameContent(bigCompareA, bigCompareB), "filesHaveSameContent failed on identical 200MB sparse files");
    writeSparseCompareFile(bigCompareB, 10);
    assert(!await plugin.moveService.filesHaveSameContent(bigCompareA, bigCompareB), "filesHaveSameContent missed a 200MB tail mismatch");

    const differentOriginal = path.join(orphanMoveTemp, "Images", "different.jpg");
    const differentCompressed = path.join(orphanMoveTemp, "Compressed", "Images", "different.jpg");
    fs.writeFileSync(differentOriginal, Buffer.from("same-size-content-a"));
    fs.writeFileSync(differentCompressed, Buffer.from("same-size-content-b"));
    let differentFailed = false;
    const originalConsoleError = console.error;
    try {
      console.error = () => {};
      await plugin.moveService.moveSingleFile({
        compressedPath: differentCompressed,
        originalPath: differentOriginal,
        relativePath: "Images/different.jpg",
        name: "different.jpg",
        size: fs.statSync(differentCompressed).size
      });
    } catch (_) {
      differentFailed = true;
    } finally {
      console.error = originalConsoleError;
    }
    assert(differentFailed, "Same-size different-content compressed output was incorrectly treated as orphan");
    assert(fs.existsSync(differentCompressed), "Different-content compressed output was removed");
    assert(!plugin.cache.getEntriesForPath("Images/different.jpg").some(([, entry]) => entry.state === "moved"), "Different-content failure marked cache moved");

    const unlinkFailOriginal = path.join(orphanMoveTemp, "Images", "unlink-fail.jpg");
    const unlinkFailCompressed = path.join(orphanMoveTemp, "Compressed", "Images", "unlink-fail.jpg");
    fs.writeFileSync(unlinkFailOriginal, sharedContent);
    fs.writeFileSync(unlinkFailCompressed, sharedContent);
    const originalUnlink = fs.promises.unlink;
    let unlinkFailed = false;
    try {
      fs.promises.unlink = async (filePath) => {
        if (filePath === unlinkFailCompressed) {
          throw new Error("simulated orphan unlink failure");
        }
        return originalUnlink.call(fs.promises, filePath);
      };
      console.error = () => {};
      await plugin.moveService.moveSingleFile({
        compressedPath: unlinkFailCompressed,
        originalPath: unlinkFailOriginal,
        relativePath: "Images/unlink-fail.jpg",
        name: "unlink-fail.jpg",
        size: sharedContent.length
      });
    } catch (_) {
      unlinkFailed = true;
    } finally {
      fs.promises.unlink = originalUnlink;
      console.error = originalConsoleError;
    }
    assert(!unlinkFailed, "Orphan unlink failure was surfaced even though cleanup is non-fatal");
    assert(fs.existsSync(unlinkFailCompressed), "Orphan unlink failure unexpectedly removed compressed output");
    assert(plugin.cache.getEntriesForPath("Images/unlink-fail.jpg").some(([, entry]) => entry.state === "moved"), "Orphan unlink failure did not mark cache moved before non-fatal cleanup");
  } finally {
    fs.rmSync(orphanMoveTemp, { recursive: true, force: true });
    plugin.app.vault.adapter.basePath = root;
    plugin.app.vault.adapter.path.absolute = root;
  }

  const backupFailureMoveTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-backup-failure-"));
  try {
    const okOriginal = path.join(backupFailureMoveTemp, "Images", "ok.jpg");
    const failOriginal = path.join(backupFailureMoveTemp, "Images", "fail.jpg");
    const okCompressed = path.join(backupFailureMoveTemp, "Compressed", "Images", "ok.jpg");
    const failCompressed = path.join(backupFailureMoveTemp, "Compressed", "Images", "fail.jpg");
    for (const filePath of [okOriginal, failOriginal, okCompressed, failCompressed]) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    }
    fs.writeFileSync(okOriginal, Buffer.alloc(100));
    fs.writeFileSync(failOriginal, Buffer.alloc(100));
    fs.writeFileSync(okCompressed, Buffer.alloc(50));
    fs.writeFileSync(failCompressed, Buffer.alloc(50));
    plugin.app.vault.adapter.basePath = backupFailureMoveTemp;
    plugin.app.vault.adapter.path.absolute = backupFailureMoveTemp;
    plugin.settings.outputFolder = "Compressed";
    await setMockFiles(plugin, [
      Object.assign(new ObsidianMock.TFile(), createMockFile("Images/ok.jpg", 100, 1)),
      Object.assign(new ObsidianMock.TFile(), createMockFile("Images/fail.jpg", 100, 1))
    ]);
    const originalCopyFile = fs.promises.copyFile;
    const originalConsoleError = console.error;
    try {
      console.error = () => {};
      fs.promises.copyFile = async (sourcePath, destPath) => {
        if (
          sourcePath === failOriginal
          && String(destPath).includes(path.join(".local-image-compress", "backups", "originals"))
        ) {
          throw new Error("simulated backup failure");
        }
        return originalCopyFile.call(fs.promises, sourcePath, destPath);
      };
      await plugin.moveService.moveCompressedToFiles();
    } finally {
      fs.promises.copyFile = originalCopyFile;
      console.error = originalConsoleError;
    }
    assert(fs.statSync(okOriginal).size === 50, "Move flow did not move the file with a complete backup");
    assert(fs.statSync(failOriginal).size === 100, "Move flow replaced a file whose backup failed");
    assert(!fs.existsSync(okCompressed), "Move flow did not remove moved compressed output");
    assert(fs.existsSync(failCompressed), "Move flow removed compressed output for a file whose backup failed");
  } finally {
    fs.rmSync(backupFailureMoveTemp, { recursive: true, force: true });
    plugin.app.vault.adapter.basePath = root;
    plugin.app.vault.adapter.path.absolute = root;
  }

  const backupTemp = fs.mkdtempSync(path.join(os.tmpdir(), "local-image-compress-smoke-"));
  try {
    const originalPath = path.join(backupTemp, "Images", "move-original.jpg");
    const compressedPath = path.join(backupTemp, "Compressed", "Images", "move-original.jpg");
    fs.mkdirSync(path.dirname(originalPath), { recursive: true });
    fs.mkdirSync(path.dirname(compressedPath), { recursive: true });
    fs.writeFileSync(originalPath, Buffer.alloc(100));
    fs.writeFileSync(compressedPath, Buffer.alloc(50));
    plugin.app.vault.adapter.basePath = backupTemp;
    plugin.app.vault.adapter.path.absolute = backupTemp;
    plugin.settings.autoBackupsRetentionEnabled = false;
    const originalApplyBackupsRetention = plugin.moveService.applyBackupsRetention;
    let retentionCalls = 0;
    plugin.moveService.applyBackupsRetention = async () => {
      retentionCalls += 1;
    };
    await plugin.moveService.createBackupBeforeMove([
      {
        compressedPath,
        originalPath,
        relativePath: "Images/move-original.jpg",
        name: "move-original.jpg",
        size: 50
      }
    ]);
    assert(retentionCalls === 0, "Image backup retention ran while autoBackupsRetentionEnabled was false");

    plugin.settings.autoBackupsRetentionEnabled = true;
    await plugin.moveService.createBackupBeforeMove([
      {
        compressedPath,
        originalPath,
        relativePath: "Images/move-original.jpg",
        name: "move-original.jpg",
        size: 50
      }
    ]);
    assert(retentionCalls === 1, "Image backup retention did not run while autoBackupsRetentionEnabled was true");

    plugin.moveService.applyBackupsRetention = originalApplyBackupsRetention;
    const originalDeleteDirectoryRecursiveAsync = plugin.moveService.deleteDirectoryRecursiveAsync;
    try {
      const clearBackupsRoot = plugin.getBackupStoragePaths().originalFilesBackups;
      const backupDirs = [
        path.join(clearBackupsRoot, "backup-a"),
        path.join(clearBackupsRoot, "backup-b"),
        path.join(clearBackupsRoot, "backup-c")
      ];
      for (const backupDir of backupDirs) {
        fs.mkdirSync(path.join(backupDir, "nested"), { recursive: true });
        fs.writeFileSync(path.join(backupDir, "nested", "image.jpg"), "backup");
      }
      const backupMarkerFile = path.join(clearBackupsRoot, "not-a-directory.txt");
      fs.writeFileSync(backupMarkerFile, "keep");
      let activeBackupDeletes = 0;
      let maxActiveBackupDeletes = 0;
      plugin.moveService.deleteDirectoryRecursiveAsync = async (directoryPath) => {
        activeBackupDeletes += 1;
        maxActiveBackupDeletes = Math.max(maxActiveBackupDeletes, activeBackupDeletes);
        try {
          await Promise.resolve();
          await fs.promises.rm(directoryPath, { recursive: true, force: true });
        } finally {
          activeBackupDeletes -= 1;
        }
      };
      await plugin.clearOriginalFilesBackups();
      assert(maxActiveBackupDeletes > 1, "Original-files backup cleanup did not delete directories concurrently");
      assert(backupDirs.every((backupDir) => !fs.existsSync(backupDir)), "Original-files backup cleanup left backup directories behind");
      assert(!fs.existsSync(backupMarkerFile), "Original-files backup cleanup left an orphan file in backupDir");
    } finally {
      plugin.moveService.deleteDirectoryRecursiveAsync = originalDeleteDirectoryRecursiveAsync;
    }
    const retentionRoot = path.join(backupTemp, "original-files-backups-retention");
    const expiredBackup = path.join(retentionRoot, "backup-expired");
    const freshBackup = path.join(retentionRoot, "backup-fresh");
    fs.mkdirSync(path.join(expiredBackup, "nested"), { recursive: true });
    fs.mkdirSync(freshBackup, { recursive: true });
    fs.writeFileSync(path.join(expiredBackup, "nested", "old.txt"), "old");
    const oldTime = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    fs.utimesSync(path.join(expiredBackup, "nested", "old.txt"), oldTime, oldTime);
    fs.utimesSync(path.join(expiredBackup, "nested"), oldTime, oldTime);
    fs.utimesSync(expiredBackup, oldTime, oldTime);
    plugin.settings.autoBackupsRetentionDays = 0.001;
    await plugin.moveService.applyBackupsRetention(retentionRoot);
    assert(fs.existsSync(expiredBackup), "Fractional image backup retention days deleted backups");
    assert(fs.existsSync(freshBackup), "Fractional image backup retention days removed a fresh backup");
    plugin.settings.autoBackupsRetentionDays = 1;
    await plugin.moveService.applyBackupsRetention(retentionRoot);
    assert(!fs.existsSync(expiredBackup), "Expired image backup directory was not removed");
    assert(fs.existsSync(freshBackup), "Fresh image backup directory was removed by retention");
  } finally {
    fs.rmSync(backupTemp, { recursive: true, force: true });
  }

  console.log("TypeScript artifact smoke check passed.");
} finally {
  Module._load = originalLoad;
  global.document = originalGlobals.document;
  global.window = originalGlobals.window;
  global.requestAnimationFrame = originalGlobals.requestAnimationFrame;
  global.setTimeout = originalGlobals.setTimeout;
  global.clearTimeout = originalGlobals.clearTimeout;
  delete require.cache[require.resolve(artifact)];
  if (smokeBackupStorageTemp) {
    fs.rmSync(smokeBackupStorageTemp, { recursive: true, force: true });
  }
}
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
