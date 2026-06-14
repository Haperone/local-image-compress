import { normalizeOutputFolder, normalizeVaultPathRoot } from "./utils";

export interface PngQualitySettings {
  min: number;
  max: number;
}

export interface LocalImageCompressSettings {
  pngQuality: PngQualitySettings;
  jpegQuality: number;
  allowedRoots: string[];
  outputFolder: string;
  autoCompressNewFiles: boolean;
  autoBackgroundCompression: boolean;
  autoBackgroundThreshold: number;
  inactivityThresholdMinutes: number;
  cacheRetentionMonths: number;
  autoCleanupGhostsOnStart: boolean;
  autoBackupsRetentionEnabled: boolean;
  autoBackupsRetentionDays: number;
  autoMoveCompressedEnabled: boolean;
  autoMoveCompressedThreshold: number;
}

export const DEFAULT_SETTINGS: LocalImageCompressSettings = {
  pngQuality: {
    min: 65,
    max: 80
  },
  jpegQuality: 85,
  allowedRoots: [],
  outputFolder: "Compressed",
  autoCompressNewFiles: false,
  autoBackgroundCompression: true,
  autoBackgroundThreshold: 50,
  inactivityThresholdMinutes: 2,
  cacheRetentionMonths: 12,
  autoCleanupGhostsOnStart: false,
  autoBackupsRetentionEnabled: false,
  autoBackupsRetentionDays: 30,
  autoMoveCompressedEnabled: false,
  autoMoveCompressedThreshold: 50
};

const REMOVED_PASTE_RENAME_GUARD_SETTING = "disablePasteImageRename" + "DuringCompression";
const REMOVED_TECHNICAL_SETTING_KEYS = [
  "pngquantPath",
  "mozjpegPath",
  "pluginGuard" + "TimeoutMs",
  "worker" + "PoolSize",
  "compression" + "TimeoutSeconds",
  "wasmInit" + "TimeoutSeconds",
  "maxInput" + "SizeMB",
  "maxImagePixels" + "Millions",
  REMOVED_PASTE_RENAME_GUARD_SETTING
];

export const INTERNAL_PLUGIN_GUARD_TIMEOUT_MS = 8_000;
export const INTERNAL_COMPRESSION_TIMEOUT_SECONDS = 120;
export const INTERNAL_WASM_INIT_TIMEOUT_SECONDS = 60;
export const INTERNAL_MAX_INPUT_SIZE_MB = 100;
export const INTERNAL_MAX_IMAGE_PIXELS_MILLIONS = 100;
const INTERNAL_DEFAULT_WORKER_POOL_SIZE = 2;
export const INTERNAL_MAX_WORKER_POOL_SIZE = 4;

export function getInternalWorkerPoolSize(hardwareConcurrency?: unknown) {
  const numeric = typeof hardwareConcurrency === "number" ? hardwareConcurrency : Number(hardwareConcurrency);
  const halfCores = Number.isFinite(numeric) && numeric > 0
    ? Math.floor(numeric / 2)
    : INTERNAL_DEFAULT_WORKER_POOL_SIZE;
  return Math.max(1, Math.min(INTERNAL_MAX_WORKER_POOL_SIZE, halfCores || 1));
}

function clampInteger(value: unknown, fallback: number, min: number, max: number) {
  const numeric = typeof value === "number" ? value : Number(value);
  const integer = Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
  return Math.max(min, Math.min(max, integer));
}

function normalizeBoolean(value: unknown, fallback: boolean) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeAllowedRoots(value: unknown) {
  if (!Array.isArray(value)) {
    return [...DEFAULT_SETTINGS.allowedRoots];
  }
  return value
    .filter((root): root is string => typeof root === "string")
    .map((root) => normalizeVaultPathRoot(root))
    .filter((root) => root.length > 0);
}

function normalizePngQuality(value: unknown): PngQualitySettings {
  const source = value && typeof value === "object" ? value as Partial<PngQualitySettings> : {};
  const min = clampInteger(source.min, DEFAULT_SETTINGS.pngQuality.min, 1, 100);
  const max = Math.max(min, clampInteger(source.max, DEFAULT_SETTINGS.pngQuality.max, 1, 100));
  return { min, max };
}

export function normalizeSettings(loadedData: unknown): LocalImageCompressSettings {
  const rawSource = loadedData && typeof loadedData === "object" ? loadedData as Partial<LocalImageCompressSettings> & Record<string, unknown> : {};
  const source = { ...rawSource };
  for (const key of REMOVED_TECHNICAL_SETTING_KEYS) {
    delete source[key];
  }
  return {
    ...DEFAULT_SETTINGS,
    ...source,
    pngQuality: normalizePngQuality(source.pngQuality),
    jpegQuality: clampInteger(source.jpegQuality, DEFAULT_SETTINGS.jpegQuality, 1, 95),
    allowedRoots: normalizeAllowedRoots(source.allowedRoots),
    outputFolder: normalizeOutputFolder(
      typeof source.outputFolder === "string" ? source.outputFolder : DEFAULT_SETTINGS.outputFolder,
      DEFAULT_SETTINGS.outputFolder
    ),
    autoCompressNewFiles: normalizeBoolean(source.autoCompressNewFiles, DEFAULT_SETTINGS.autoCompressNewFiles),
    autoBackgroundCompression: normalizeBoolean(source.autoBackgroundCompression, DEFAULT_SETTINGS.autoBackgroundCompression),
    autoBackgroundThreshold: clampInteger(source.autoBackgroundThreshold, DEFAULT_SETTINGS.autoBackgroundThreshold, 10, 1000),
    inactivityThresholdMinutes: clampInteger(source.inactivityThresholdMinutes, DEFAULT_SETTINGS.inactivityThresholdMinutes, 1, 60),
    cacheRetentionMonths: clampInteger(source.cacheRetentionMonths, DEFAULT_SETTINGS.cacheRetentionMonths, 1, 60),
    autoCleanupGhostsOnStart: normalizeBoolean(source.autoCleanupGhostsOnStart, DEFAULT_SETTINGS.autoCleanupGhostsOnStart),
    autoBackupsRetentionEnabled: normalizeBoolean(source.autoBackupsRetentionEnabled, DEFAULT_SETTINGS.autoBackupsRetentionEnabled),
    autoBackupsRetentionDays: clampInteger(source.autoBackupsRetentionDays, DEFAULT_SETTINGS.autoBackupsRetentionDays, 1, 365),
    autoMoveCompressedEnabled: normalizeBoolean(source.autoMoveCompressedEnabled, DEFAULT_SETTINGS.autoMoveCompressedEnabled),
    autoMoveCompressedThreshold: clampInteger(source.autoMoveCompressedThreshold, DEFAULT_SETTINGS.autoMoveCompressedThreshold, 1, 1000)
  };
}
