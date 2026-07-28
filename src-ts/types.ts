import type { TFile } from "obsidian";

export type CacheEntryState = "processed" | "pending_move" | "moved" | "skipped" | "skipped_identical";

export type TimerHandle = number | ReturnType<typeof setTimeout>;
export type AnimationHandle = ReturnType<typeof requestAnimationFrame> | TimerHandle;

export type ImageFileLike = TFile;

export interface CacheMutationRevision {
  counter: number;
  ownerId: string;
}

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
  sourceSha256?: string;
  outputSha256?: string;
  skipReason?: string;
  compressionSettingsKey?: string;
  processedMtime?: number;
  processedSize?: number;
  mutationRevision?: CacheMutationRevision;
}

export interface CacheData {
  version: string;
  entries: Record<string, CacheEntry>;
  tombstones?: Record<string, CacheMutationRevision>;
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

export type CompressionOperationInput = Readonly<{
  sourcePath: string;
  sourceMtime: number;
}>;

export type CompressionArtifactContext = Readonly<{
  sourcePath: string;
  sourceMtime: number;
  sourceSize: number;
  sourceMd5: string;
  sourceSha256: string;
  outputPath: string;
  outputSize: number;
  outputSha256: string;
  compressionSettingsKey: string;
}>;

export type CompressionSuccessResult = {
  success: true;
  savings: number;
  artifact: CompressionArtifactContext;
  error?: never;
  skipReason?: never;
};

export type CompressionFailureResult = {
  success: false;
  savings?: never;
  artifact?: never;
  error?: string;
  skipReason?: string;
};

export type CompressionResult = CompressionSuccessResult | CompressionFailureResult;

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
  compressedFilesCount: number;
}

export interface CacheCompactionResult {
  removed: number;
  missingFilesRemoved: number;
  supersededRemoved: number;
}

export interface FileStatsLike {
  size?: unknown;
  mtime?: unknown;
  mtimeMs?: unknown;
}
