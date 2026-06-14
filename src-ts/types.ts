import type { TFile } from "obsidian";

export type CacheEntryState = "processed" | "pending_move" | "moved" | "skipped" | "skipped_identical";

export type TimerHandle = number | ReturnType<typeof setTimeout>;
export type AnimationHandle = ReturnType<typeof requestAnimationFrame> | TimerHandle;

export type ImageFileLike = TFile;

export interface CacheEntry {
  path?: string;
  md5?: string;
  mtime?: number;
  timestamp?: number;
  lastAccessMs?: number;
  originalSize?: number | null;
  sourceMtime?: number;
  sourceSize?: number | null;
  state?: CacheEntryState;
  stateUpdatedAt?: number;
  pendingSince?: number;
  outputPath?: string;
  outputMtime?: number;
  outputSize?: number;
  skipReason?: string;
  compressionSettingsKey?: string;
  processedMtime?: number;
  processedSize?: number;
}

export interface CacheData {
  version: string;
  entries: Record<string, CacheEntry>;
}

export interface FreshCacheEntry {
  cacheKey: string;
  entry: CacheEntry;
}

export type CachePathEntries = Array<[string, CacheEntry]>;

export interface CacheStats {
  total: number;
  size: number;
}

export interface CompressionResult {
  success: boolean;
  savings?: number;
  error?: string;
  skipReason?: string;
}

export type CompressionValidationResult =
  | { valid: true }
  | { valid: false; error: string; skipped?: boolean };

export interface CompressionBatchResult {
  compressed: number;
  processed: number;
  skippedAlreadyCompressed: number;
  skippedValidation: number;
  skippedErrors: number;
  cancelled: boolean;
  fatalError?: unknown;
}

export type CompressionBatchCallback<TPayload = unknown> = (
  file: ImageFileLike,
  processed: number,
  total: number,
  payload?: TPayload
) => void | Promise<void>;

export interface SavingsSnapshot {
  originalSize: number;
  currentSize: number;
  savedSize: number;
  savedPercentage: number;
  processedFiles: number;
  totalFiles: number;
  estimatedFiles: number;
}

export interface ImageStatsSnapshot {
  totalFiles?: number;
  totalImages: number;
  uncompressedImages: number;
  savings: SavingsSnapshot;
}

export interface StatsSnapshot extends ImageStatsSnapshot {
  cacheStats: CacheStats;
  ghostCount: number;
  compressedFilesCount: number;
}

export interface FileStatsLike {
  size?: unknown;
  mtime?: unknown;
  mtimeMs?: unknown;
}
