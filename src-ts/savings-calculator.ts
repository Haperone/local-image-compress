import { t } from "./i18n";
import { getErrorCode, getLogTag, getVaultBasePath, toVaultRelativePath } from "./utils";
import * as fs from "fs";
import * as path from "path";
import { ConcurrencyLimiter } from "./concurrency-limiter";
import type LocalImageCompressPlugin from "./plugin";
import type { SavingsSnapshot } from "./types";
import type { TFile } from "obsidian";

export const FILE_SIZE_THRESHOLDS = {
  KB_100: 100 * 1024,
  KB_500: 500 * 1024,
  MB_1: 1024 * 1024
};

// Conservative UI estimates used only when exact cache originalSize is unavailable.
export const COMPRESSION_RATIOS = {
  PNG_SMALL: 2.5,
  PNG_MEDIUM: 2.0,
  PNG_LARGE: 1.8,
  JPEG_SMALL: 1.4,
  JPEG_LARGE: 1.3,
  DEFAULT: 1.5
};
export const MAX_ESTIMATED_COMPRESSION_RATIO = 30;
export const SAVINGS_STATS_IO_CONCURRENCY = 8;
type SavingsFileLike = {
  extension?: string;
  stat?: {
    size?: unknown;
  };
};

export class SavingsCalculator {
  private readonly plugin: LocalImageCompressPlugin;

  constructor(plugin: LocalImageCompressPlugin) {
    this.plugin = plugin;
  }

  async calculateSpaceSavings() {
    const stats = await this.collectImageStats(this.plugin.getAllImageFiles());
    return stats.savings;
  }

  getSavingsPercentage(savedSize: number, originalSize: number) {
    if (!Number.isFinite(savedSize) || savedSize <= 0 || !Number.isFinite(originalSize) || originalSize <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(100, Math.round((savedSize / originalSize) * 100)));
  }

  async collectImageStats(allFiles: TFile[]) {
    try {
      if (allFiles.length === 0) {
        return {
          totalImages: 0,
          uncompressedImages: 0,
          savings: this.getEmptySavingsResult()
        };
      }

      let originalSize = 0;
      let currentSize = 0;
      let processedFiles = 0;
      let filesWithExactData = 0;
      let estimatedFiles = 0;
      let uncompressedImages = 0;
      const entriesByPath = this.plugin.cache.getEntriesByPathMap();
      const cacheLookupLimiter = new ConcurrencyLimiter(SAVINGS_STATS_IO_CONCURRENCY);
      const compressedSizeLimiter = new ConcurrencyLimiter(SAVINGS_STATS_IO_CONCURRENCY);

      const batchSize = 50;
      for (let i = 0; i < allFiles.length; i += batchSize) {
        if (this.plugin.isUnloading) {
          return this.getInterruptedSavingsResult(allFiles.length, uncompressedImages);
        }
        const batch = allFiles.slice(i, i + batchSize);
        const phaseData = await Promise.all(batch.map((file, index) => cacheLookupLimiter.run(async () => {
          const freshCache = await this.plugin.cache.getFreshEntryForFileFromEntries(
            file,
            this.plugin.cache.getEntriesForPathFromMap(file.path, entriesByPath)
          );
          const cachedOutputSize = freshCache?.entry?.outputSize;
          const needsSizeFetch = !!freshCache && (typeof cachedOutputSize !== "number" || cachedOutputSize <= 0);
          return {
            file,
            index,
            freshCache,
            compressedPath: needsSizeFetch ? this.getCompressedFilePath(file.path) : null
          };
        })));
        const fetchTasks = phaseData.filter((item) => item.compressedPath);
        const fetchedSizes = await Promise.all(fetchTasks.map((item) =>
          compressedSizeLimiter.run(() => this.getCompressedFileSize(item.compressedPath as string).catch(() => null))
        ));
        const fetchedSizeByIndex = new Map<number, number>();
        fetchTasks.forEach((item, index) => {
          const fetchedSize = fetchedSizes[index];
          fetchedSizeByIndex.set(item.index, typeof fetchedSize === "number" ? fetchedSize : 0);
        });

        for (const item of phaseData) {
          const file = item.file;
          const fileSize = file.stat.size;
          const freshCache = item.freshCache;

          if (freshCache) {
            const entry = freshCache.entry;
            const cachedOriginalSize = entry?.originalSize;
            let compressedSize = typeof entry?.outputSize === "number" ? entry.outputSize : 0;
            if (compressedSize <= 0) {
              compressedSize = fetchedSizeByIndex.get(item.index) || 0;
            }
            const current = compressedSize > 0 ? compressedSize : fileSize;

            if (cachedOriginalSize && cachedOriginalSize > 0) {
              originalSize += cachedOriginalSize;
              currentSize += current;
              filesWithExactData++;
            } else {
              const estimatedOriginalSize = compressedSize > 0
                ? this.estimateOriginalSizeFromCurrent({ stat: { size: compressedSize }, extension: file.extension })
                : this.estimateOriginalSizeFromCurrent(file);
              originalSize += estimatedOriginalSize;
              currentSize += current;
              estimatedFiles++;
            }
            processedFiles++;
          } else {
            originalSize += fileSize;
            currentSize += fileSize;
            uncompressedImages++;
          }
        }
        if (i + batchSize < allFiles.length && typeof this.plugin.yieldToUi === "function") {
          await this.plugin.yieldToUi();
          if (this.plugin.isUnloading) {
            return this.getInterruptedSavingsResult(allFiles.length, uncompressedImages);
          }
        }
      }

      if (filesWithExactData === 0 && estimatedFiles === 0) {
        return {
          totalImages: allFiles.length,
          uncompressedImages,
          savings: this.getEmptySavingsResult(allFiles.length)
        };
      }

      const savedSize = Math.max(0, originalSize - currentSize);
      const savedPercentage = this.getSavingsPercentage(savedSize, originalSize);

      return {
        totalFiles: allFiles.length,
        totalImages: allFiles.length,
        uncompressedImages,
        savings: {
          originalSize,
          currentSize,
          savedSize,
          savedPercentage,
          processedFiles,
          totalFiles: allFiles.length,
          estimatedFiles
        }
      };
    } catch (error) {
      console.error(getLogTag(this.plugin), "Space savings calculation error:", error);
      return {
        totalImages: 0,
        uncompressedImages: 0,
        savings: this.getEmptySavingsResult()
      };
    }
  }

  getEmptySavingsResult(totalFiles = 0) {
    return {
      originalSize: 0,
      currentSize: 0,
      savedSize: 0,
      savedPercentage: 0,
      processedFiles: 0,
      totalFiles,
      estimatedFiles: 0
    };
  }

  getInterruptedSavingsResult(totalFiles = 0, uncompressedImages = 0) {
    return {
      totalFiles,
      totalImages: totalFiles,
      uncompressedImages,
      savings: this.getEmptySavingsResult(totalFiles)
    };
  }

  validateSavingsData(savings: unknown): savings is SavingsSnapshot {
    if (!savings) {
      return false;
    }
    const candidate = savings as Partial<Record<keyof SavingsSnapshot, unknown>>;
    const numericFields = [
      "processedFiles",
      "savedSize",
      "originalSize",
      "currentSize",
      "savedPercentage",
      "totalFiles",
      "estimatedFiles"
    ];
    if (!numericFields.every((field) => typeof candidate[field as keyof SavingsSnapshot] === "number" && Number.isFinite(candidate[field as keyof SavingsSnapshot]))) {
      return false;
    }
    const typedSavings = savings as SavingsSnapshot;
    const hasActivity = typedSavings.totalFiles > 0 || typedSavings.processedFiles > 0 || typedSavings.estimatedFiles > 0;
    return hasActivity &&
      typedSavings.savedSize >= 0 &&
      typedSavings.originalSize >= 0 &&
      typedSavings.currentSize >= 0 &&
      typedSavings.savedPercentage >= 0 &&
      typedSavings.savedPercentage <= 100 &&
      typedSavings.savedSize <= typedSavings.originalSize &&
      typedSavings.totalFiles >= 0 &&
      typedSavings.estimatedFiles >= 0;
  }

  estimateOriginalSizeFromCurrent(file: SavingsFileLike): number {
    try {
      if (!file || !file.stat || typeof file.stat.size !== "number" || !Number.isFinite(file.stat.size) || file.stat.size <= 0) {
        return 0;
      }

      const currentSize = file.stat.size;
      const extension = (file.extension || "").toLowerCase();
      const compressionRatio = this.getCompressionRatio(extension, currentSize, FILE_SIZE_THRESHOLDS);
      if (!Number.isFinite(compressionRatio) || compressionRatio <= 0) {
        return currentSize;
      }
      const estimatedSize = Math.round(currentSize * compressionRatio);

      if (!Number.isFinite(estimatedSize) || estimatedSize <= 0 || estimatedSize > currentSize * MAX_ESTIMATED_COMPRESSION_RATIO) {
        return currentSize;
      }

      return estimatedSize;
    } catch (error) {
      console.error(getLogTag(this.plugin), "Original size estimation error:", error);
      return 0;
    }
  }

  getCompressionRatio(extension: string, currentSize: number, sizes = FILE_SIZE_THRESHOLDS) {
    const { KB_100, KB_500, MB_1 } = sizes;
    const ratios = COMPRESSION_RATIOS;

    switch (extension) {
      case "png":
        if (currentSize < KB_100) return ratios.PNG_SMALL;
        if (currentSize < MB_1) return ratios.PNG_MEDIUM;
        return ratios.PNG_LARGE;
      case "jpg":
      case "jpeg":
        if (currentSize < KB_500) return ratios.JPEG_SMALL;
        return ratios.JPEG_LARGE;
      default:
        return ratios.DEFAULT;
    }
  }

  formatTooltipData(savings: SavingsSnapshot | null | undefined) {
    if (!savings) {
      return {
        originalFormatted: "0 B",
        currentFormatted: "0 B",
        savedFormatted: "0 B",
        estimatedIndicator: "",
        estimatedText: ""
      };
    }

    const originalFormatted = this.formatFileSize(savings.originalSize || 0);
    const currentFormatted = this.formatFileSize(savings.currentSize || 0);
    const savedFormatted = this.formatFileSize(savings.savedSize || 0);
    const estimatedIndicator = (savings.estimatedFiles || 0) > 0 ? " ~" : "";
    const estimatedText = (savings.estimatedFiles || 0) > 0 ? ` (${savings.estimatedFiles} ${t(this.plugin.app, "tooltip.savings.estimated")})` : "";

    return {
      originalFormatted,
      currentFormatted,
      savedFormatted,
      estimatedIndicator,
      estimatedText
    };
  }

  async getCachedOriginalSize(filePath: string) {
    try {
      if (!filePath || !this.plugin.cache || !this.plugin.cache.cacheData || !this.plugin.cache.cacheData.entries) {
        return null;
      }

      const entriesByPath = this.plugin.cache.getEntriesByPathMap();
      const pathEntries = this.plugin.cache.getEntriesForPathFromMap(filePath, entriesByPath);
      for (const [, entry] of pathEntries) {
        if (entry && entry.originalSize && typeof entry.originalSize === "number" && entry.originalSize > 0) {
          return entry.originalSize;
        }
      }
      return null;
    } catch (error) {
      console.error(getLogTag(this.plugin), "Error getting original size from cache:", error);
      return null;
    }
  }

  formatFileSize(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";

    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB", "TB", "PB"];
    const i = Math.min(sizes.length - 1, Math.max(0, Math.floor(Math.log(bytes) / Math.log(k))));

    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
  }

  async getCompressedFileSize(compressedFilePath: string): Promise<number | null> {
    try {
      const stats = await fs.promises.stat(compressedFilePath);
      return stats.size;
    } catch (error) {
      if (getErrorCode(error) === "ENOENT") {
        return 0;
      }
      console.warn(getLogTag(this.plugin), `Cannot read compressed file size: ${compressedFilePath}`, error);
      return null;
    }
  }

  getDisplaySavingsPercentage(value: unknown) {
    const numeric = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(100, Math.round(numeric)));
  }

  getCompressedFilePath(originalPathOrVaultRelative: string) {
    const basePath = getVaultBasePath(this.plugin.app);
    const vaultRelativePath = toVaultRelativePath(originalPathOrVaultRelative, basePath);
    return path.join(basePath, this.plugin.getOutputFolder(), vaultRelativePath);
  }
}
