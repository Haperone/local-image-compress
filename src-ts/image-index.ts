import { isAllowedByRoots, isInsideOutputFolder } from "./utils";
import type { CachePathEntries, FreshCacheEntry } from "./types";
import type { App, TFile } from "obsidian";

export type ImageIndexFile = TFile;

export type ImageIndexRecord = {
  path: string;
  file: ImageIndexFile;
  extension: string;
  size: number;
  mtime: number;
  allowed: boolean;
  processed: boolean;
};

export type ImageIndexSnapshot = {
  totalImages: number;
  uncompressedImages: number;
};

type ImageIndexOptions = {
  getOutputFolder: () => string;
  getAllowedRoots: () => string[];
  getSupportedExtensions: () => string[];
  yieldToUi: () => Promise<void>;
  batchSize?: number;
};

type ImageIndexCache = {
  isFileAlreadyProcessed(file: ImageIndexFile): Promise<boolean>;
  getEntriesByPathMap?: () => Map<string, CachePathEntries>;
  getEntriesForPathFromMap?: (filePath: string, entriesByPath: Map<string, CachePathEntries>) => CachePathEntries;
  getFreshEntryForFileFromEntries?: (file: ImageIndexFile, entries?: CachePathEntries) => Promise<FreshCacheEntry | null>;
};

export class ImageIndex {
  private records = new Map<string, ImageIndexRecord>();
  private pendingRebuildMutations = new Map<string, ImageIndexRecord | null>();
  private ready = false;
  private generation = 0;
  private rebuildingGeneration: number | null = null;
  private snapshot: ImageIndexSnapshot = {
    totalImages: 0,
    uncompressedImages: 0
  };

  constructor(private app: App, private options: ImageIndexOptions) {}

  isReady() {
    return this.ready;
  }

  getSnapshot() {
    return this.snapshot;
  }

  getAllFiles() {
    return Array.from(this.records.values())
      .filter((record) => record.allowed)
      .map((record) => record.file);
  }

  getUncompressedFiles() {
    return Array.from(this.records.values())
      .filter((record) => record.allowed && !record.processed)
      .map((record) => record.file);
  }

  async rebuild(cache: ImageIndexCache) {
    const generation = ++this.generation;
    this.rebuildingGeneration = generation;
    const wasReady = this.ready;
    this.ready = false;
    this.pendingRebuildMutations.clear();
    const nextRecords = new Map<string, ImageIndexRecord>();

    try {
      const files = this.app.vault.getFiles();
      const batchSize = this.options.batchSize || 150;
      for (let i = 0; i < files.length; i += batchSize) {
        if (generation !== this.generation) {
          return;
        }
        for (const file of files.slice(i, i + batchSize)) {
          const record = this.createRecord(file);
          if (record) {
            nextRecords.set(record.path, record);
          }
        }
        if (i + batchSize < files.length) {
          await this.options.yieldToUi();
        }
      }

      if (files.length > 0) {
        await this.options.yieldToUi();
      }
      await this.refreshProcessedStatesForRecords(nextRecords, cache, generation);
      if (generation === this.generation) {
        for (const [path, record] of this.pendingRebuildMutations) {
          if (record) {
            nextRecords.set(path, record);
          } else {
            nextRecords.delete(path);
          }
        }
        this.records = nextRecords;
        this.ready = true;
        this.rebuildingGeneration = null;
        this.pendingRebuildMutations.clear();
        this.recalculateSnapshot();
      }
    } catch (error) {
      // PPP2-B-2: an exception during rebuild must not leave the index permanently
      // unready. nextRecords is built separately, so this.records still holds the
      // prior snapshot — restore the previous ready state for the current generation.
      if (generation === this.generation) {
        this.ready = wasReady;
        this.rebuildingGeneration = null;
      }
      throw error;
    }
  }

  async upsert(file: ImageIndexFile, cache: ImageIndexCache) {
    const record = this.createRecord(file);
    if (!record) {
      this.remove(file?.path);
      return;
    }
    record.processed = await cache.isFileAlreadyProcessed(file);
    this.records.set(record.path, record);
    this.trackRebuildMutation(record.path, record);
    this.recalculateSnapshot();
  }

  async rename(file: ImageIndexFile, oldPath: string, cache: ImageIndexCache) {
    this.remove(oldPath);
    await this.upsert(file, cache);
  }

  remove(filePath: string) {
    if (filePath) {
      this.records.delete(filePath);
      this.trackRebuildMutation(filePath, null);
      this.recalculateSnapshot();
    }
  }

  async refreshFile(file: ImageIndexFile, cache: ImageIndexCache) {
    await this.upsert(file, cache);
  }

  async refreshProcessedStates(cache: ImageIndexCache, generation = this.generation) {
    await this.refreshProcessedStatesForRecords(this.records, cache, generation);
    if (generation === this.generation) {
      this.recalculateSnapshot();
    }
  }

  private async refreshProcessedStatesForRecords(recordsByPath: Map<string, ImageIndexRecord>, cache: ImageIndexCache, generation: number) {
    const batchSize = this.options.batchSize || 150;
    const entriesByPath = cache.getEntriesByPathMap ? cache.getEntriesByPathMap() : null;
    const recordPaths = Array.from(recordsByPath.keys());
    for (let i = 0; i < recordPaths.length; i += batchSize) {
      if (generation !== this.generation) {
        return;
      }
      for (const recordPath of recordPaths.slice(i, i + batchSize)) {
        const record = recordsByPath.get(recordPath);
        if (!record) {
          continue;
        }
        if (entriesByPath && cache.getEntriesForPathFromMap && cache.getFreshEntryForFileFromEntries) {
          record.processed = !!await cache.getFreshEntryForFileFromEntries(record.file, cache.getEntriesForPathFromMap(record.path, entriesByPath));
        } else {
          record.processed = await cache.isFileAlreadyProcessed(record.file);
        }
      }
    }
  }

  private createRecord(file: ImageIndexFile): ImageIndexRecord | null {
    if (!file?.path || !file?.extension || !file.stat) {
      return null;
    }
    const extension = file.extension.toLowerCase();
    if (!this.options.getSupportedExtensions().includes(extension)) {
      return null;
    }
    if (isInsideOutputFolder(file.path, this.options.getOutputFolder())) {
      return null;
    }
    const allowedRoots = this.options.getAllowedRoots();
    const allowed = isAllowedByRoots(file.path, allowedRoots);
    return {
      path: file.path,
      file,
      extension,
      size: file.stat.size,
      mtime: file.stat.mtime,
      allowed,
      processed: false
    };
  }

  private trackRebuildMutation(path: string, record: ImageIndexRecord | null) {
    if (this.rebuildingGeneration === null) {
      return;
    }
    this.pendingRebuildMutations.set(path, record);
  }

  private recalculateSnapshot() {
    let uncompressedImages = 0;
    let totalImages = 0;
    for (const record of this.records.values()) {
      if (!record.allowed) {
        continue;
      }
      totalImages++;
      if (!record.processed) {
        uncompressedImages++;
      }
    }
    this.snapshot = {
      totalImages,
      uncompressedImages
    };
  }
}
