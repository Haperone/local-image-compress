"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { runEsbuildCli } = require("./run-esbuild-cli");

const root = path.resolve(__dirname, "..");
let bundleNumber = 0;

function bundleModule(entryPoint, name) {
  const outputPath = path.join(os.tmpdir(), `lic-mutation-policy-${process.pid}-${Date.now()}-${bundleNumber++}-${name}.cjs`);
  runEsbuildCli([
    entryPoint,
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=es2020",
    "--external:obsidian",
    `--outfile=${outputPath}`,
    "--log-level=silent"
  ], { cwd: root, stdio: "pipe" });
  try {
    return require(outputPath);
  } finally {
    delete require.cache[outputPath];
    fs.rmSync(outputPath, { force: true });
  }
}

function loadPolicy(platform) {
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === "obsidian") {
      return { Platform: platform };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return {
      utils: bundleModule(path.join("src-ts", "utils.ts"), "utils"),
      settings: bundleModule(path.join("src-ts", "settings.ts"), "settings")
    };
  } finally {
    Module._load = originalLoad;
  }
}

const linux = loadPolicy({ isWin: false, isMacOS: false, isIosApp: false });
const windows = loadPolicy({ isWin: true, isMacOS: false, isIosApp: false });
const ios = loadPolicy({ isWin: false, isMacOS: false, isIosApp: true });

assert.equal(linux.utils.normalizeVaultPath("  Images\\\\A//B  "), "  Images/A/B  ");
assert.equal(linux.utils.normalizeVaultPathRoot("//Images/Compressed//"), "Images/Compressed");
assert.equal(linux.utils.normalizeVaultPath("\\\\?\\UNC\\server\\share\\Vault\\A.png"), "/server/share/Vault/A.png");
assert.equal(linux.utils.normalizeVaultPath("\\\\?\\C:\\Vault\\A.png"), "C:/Vault/A.png");
assert.equal(linux.utils.vaultPathsEqual("Images/A.png", "images/A.png"), false);
assert.equal(windows.utils.vaultPathsEqual("Images/A.png", "images/A.png"), true);
assert.equal(ios.utils.vaultPathsEqual("Images/A.png", "images/A.png"), true);

for (const unsafePath of ["", " ", ".", "..", "Images/../secret", "/etc/passwd", "\\\\server\\share\\file", "C:\\Vault\\file", "\\\\?\\C:\\Vault\\file", "//server/share/file"]) {
  assert.equal(linux.utils.isSafeVaultRelativePath(unsafePath), false, unsafePath);
}
for (const safePath of ["Images/A.png", "Images\\A.png", "Русский/é.png", "folder/.hidden"]) {
  assert.equal(linux.utils.isSafeVaultRelativePath(safePath), true, safePath);
}
assert.equal(linux.utils.isSafeVaultRelativePath("/explicit-absolute"), false);
assert.equal(linux.utils.isSafeVaultRelativePath("C:\\explicit-absolute"), false);
assert.equal(linux.utils.normalizeOutputFolder(" ../outside "), "Compressed");
assert.equal(linux.utils.normalizeOutputFolder(" Images\\Compressed "), "Images/Compressed");
assert.equal(linux.utils.normalizeOutputFolder("Images/Compressed/"), "Compressed");
assert.equal(linux.utils.normalizeOutputFolder(undefined, "Fallback"), "Fallback");
assert.equal(linux.utils.isValidOutputFolder("Images/Compressed"), true);
assert.equal(linux.utils.isValidOutputFolder("../outside"), false);
assert.equal(linux.utils.isPathInsideRoot("Images2/A.png", "Images"), false);
assert.equal(linux.utils.isPathInsideRoot("Images/A.png", "Images"), true);
assert.equal(linux.utils.isPathInsideRoot("Images", "Images"), true);
assert.equal(linux.utils.isPathInsideRoot("Any/A.png", ""), true);
assert.equal(windows.utils.isPathInsideRoot("images/A.png", "Images"), true);
assert.equal(linux.utils.isAllowedByRoots("Images/A.png", ["Allowed", "Images"]), true);
assert.equal(linux.utils.isAllowedByRoots("Other/A.png", ["Allowed", "Images"]), false);
assert.equal(linux.utils.isAllowedByRoots("Other/A.png", []), true);
for (const absolutePath of ["/tmp/a.png", "\\\\server\\share\\a.png", "C:\\Vault\\a.png", "\\\\?\\C:\\Vault\\a.png", "//server/share/a.png"]) {
  assert.equal(linux.utils.isAbsoluteFilesystemPath(absolutePath), true, absolutePath);
}
assert.equal(linux.utils.isAbsoluteFilesystemPath("Images/A.png"), false);
assert.equal(linux.utils.isAbsoluteFilesystemPath("\\relative-rooted"), true);

const { settings } = linux;
assert.equal(settings.getInternalWorkerPoolSize(), 2);
assert.equal(settings.getInternalWorkerPoolSize(1), 1);
assert.equal(settings.getInternalWorkerPoolSize("8"), 4);
assert.equal(settings.getInternalWorkerPoolSize(99), 4);
assert.equal(settings.getInternalWorkerPoolSize(-1), 2);
assert.equal(settings.getInternalWorkerPoolSize(0), 2);
assert.equal(settings.getPlatformWorkerPoolSize(true, 8), 1);
assert.equal(settings.getPlatformWorkerPoolSize(false, 8), 4);
assert.equal(settings.getMaxInputSizeMb(true), 25);
assert.equal(settings.getMaxInputSizeMb(false), 100);
assert.equal(settings.getMaxImagePixelsMillions(true), 50);
assert.equal(settings.getCompressionMemoryBudgetBytes(true), 512 * 1024 * 1024);
assert.equal(settings.getCompressionMemoryBudgetBytes(false), 1024 * 1024 * 1024);
assert.equal(settings.getCompressionSettingsKeyForSnapshot(".PNG", settings.DEFAULT_SETTINGS), "png:65-80");
assert.equal(settings.getCompressionSettingsKeyForSnapshot("jpeg", settings.DEFAULT_SETTINGS), "jpeg:85");
assert.equal(settings.getCompressionSettingsKeyForSnapshot("jpg", settings.DEFAULT_SETTINGS), "jpeg:85");
assert.equal(settings.getCompressionSettingsKeyForSnapshot(".gif", settings.DEFAULT_SETTINGS), null);
assert.equal(settings.getCompressionSettingsKeyForSnapshot("png", settings.DEFAULT_SETTINGS, "too_large", true), "png:limits:25:50:too_large");
assert.equal(settings.getCompressionSettingsKeyForSnapshot("png", settings.DEFAULT_SETTINGS, "too_large"), "png:limits:100:100:too_large");
assert.equal(settings.getCompressionSettingsKeyForSnapshot("", settings.DEFAULT_SETTINGS, "too_large"), "unknown:limits:100:100:too_large");
assert.equal(settings.getCompressionSettingsKeyForSnapshot("", settings.DEFAULT_SETTINGS, "custom"), "unknown:custom");
assert.equal(settings.getCompressionSettingsKeyForSnapshot(".webp", settings.DEFAULT_SETTINGS, " custom "), "webp:custom");
assert.equal(settings.getCompressionSettingsKeyForSnapshot("x.png", settings.DEFAULT_SETTINGS, "custom"), "x.png:custom");

const normalized = settings.normalizeSettings({
  pngQuality: { min: 0, max: -2 },
  jpegQuality: "100",
  allowedRoots: ["/Images//", 1, "", "Images", "Images"],
  outputFolder: "../outside",
  autoCompressNewFiles: "true",
  autoBackgroundCompression: false,
  autoBackgroundThreshold: 2,
  inactivityThresholdMinutes: 99,
  autoBackupsRetentionEnabled: true,
  autoBackupsRetentionDays: 999,
  autoMoveCompressedEnabled: false,
  autoMoveCompressedThreshold: 0,
  pngquantPath: "removed",
  cacheRetentionMonths: 12
});
assert.deepEqual(normalized.pngQuality, { min: 1, max: 1 });
assert.equal(normalized.jpegQuality, 95);
assert.deepEqual(normalized.allowedRoots, ["Images", "Images", "Images"]);
assert.equal(normalized.outputFolder, "Compressed");
assert.equal(normalized.autoCompressNewFiles, false);
assert.equal(normalized.autoBackgroundCompression, false);
assert.equal(normalized.autoBackgroundThreshold, 10);
assert.equal(normalized.inactivityThresholdMinutes, 60);
assert.equal(normalized.autoBackupsRetentionEnabled, true);
assert.equal(normalized.autoBackupsRetentionDays, 365);
assert.equal(normalized.autoMoveCompressedEnabled, false);
assert.equal(normalized.autoMoveCompressedThreshold, 1);
assert.equal("pngquantPath" in normalized, false);
assert.equal("cacheRetentionMonths" in normalized, false);

const defaults = settings.normalizeSettings({
  pngQuality: null,
  jpegQuality: Number.NaN,
  allowedRoots: "Images",
  outputFolder: "Images/Compressed",
  autoBackgroundThreshold: "invalid",
  inactivityThresholdMinutes: "invalid"
});
assert.deepEqual(defaults.pngQuality, settings.DEFAULT_SETTINGS.pngQuality);
assert.equal(defaults.jpegQuality, settings.DEFAULT_SETTINGS.jpegQuality);
assert.deepEqual(defaults.allowedRoots, []);
assert.equal(defaults.outputFolder, "Images/Compressed");
assert.equal(defaults.autoBackgroundThreshold, settings.DEFAULT_SETTINGS.autoBackgroundThreshold);
assert.equal(defaults.inactivityThresholdMinutes, settings.DEFAULT_SETTINGS.inactivityThresholdMinutes);
assert.equal(settings.normalizeSettings({ inactivityThresholdMinutes: null }).inactivityThresholdMinutes, 1);
assert.equal(settings.normalizeSettings({ outputFolder: 5 }).outputFolder, "Compressed");
assert.equal("0" in settings.normalizeSettings("x"), false);
