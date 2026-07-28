import { getVaultFileByPath, normalizeVaultPathForComparison, vaultPathsEqual } from "../utils";
import type { Cache } from "../cache";
import type { CacheCompactionResult, CacheEntry, CachePathEntries, ImageFileLike } from "../types";

type CompactionCandidate = {
  signature: string;
  reason: "missing" | "superseded";
};

// Owns cache compaction: deciding which records are superseded or point at missing
// files and removing them in one backup+authoritative-save transaction (Lesson 63).
// The Cache keeps thin compactCache/compactPath/compactDeletedPath delegators so
// external callers and instance-level test mocks stay stable.
export class CacheCompaction {
  compactionBatchSize: number;

  constructor(private readonly cache: Cache) {
    this.compactionBatchSize = 200;
  }
  isModernCompactionEntry(entry: CacheEntry) {
    const state = this.cache.getCacheEntryState(entry);
    const hasSourceIdentity = this.cache.hasFiniteNumber(entry.sourceMtime) && this.cache.hasNonNegativeSize(entry.sourceSize);
    const hasProcessedIdentity = this.cache.hasFiniteNumber(entry.processedMtime) && this.cache.hasNonNegativeSize(entry.processedSize);
    const hasOutputIdentity = !!this.cache.getEntryOutputPath(entry)
      && this.cache.hasFiniteNumber(entry.outputMtime)
      && this.cache.hasNonNegativeSize(entry.outputSize);
    switch (state) {
      case "pending_move":
        return hasSourceIdentity && hasOutputIdentity;
      case "moved":
        return hasProcessedIdentity;
      case "skipped":
      case "skipped_identical":
        return hasSourceIdentity;
      case "processed":
        return false;
    }
  }
  isSourceHashCompactionState(entry: CacheEntry) {
    const state = this.cache.getCacheEntryState(entry);
    return state === "pending_move" || state === "skipped" || state === "skipped_identical";
  }
  compactionEntryMatchesCurrentFile(entry: CacheEntry, file: ImageFileLike) {
    switch (this.cache.getCacheEntryState(entry)) {
      case "pending_move":
      case "skipped":
      case "skipped_identical":
        return this.cache.sourceMatchesCurrentFile(entry, file);
      case "moved":
        return this.cache.processedMatchesCurrentFile(entry, file);
      case "processed":
        return false;
    }
  }
  async findCanonicalCompactionKey(file: ImageFileLike, entries: CachePathEntries) {
    const matching: CachePathEntries = [];
    for (const entryPair of entries) {
      if (this.compactionEntryMatchesCurrentFile(entryPair[1], file)) {
        matching.push(entryPair);
      }
    }
    if (matching.length === 1) {
      return matching[0]?.[0] || null;
    }
    if (matching.length < 2 || !matching.every(([, entry]) => this.isSourceHashCompactionState(entry) && /^[a-f0-9]{32}$/i.test(entry.md5 || ""))) {
      return null;
    }
    const currentMd5 = await this.cache.getFileMd5(file);
    if (!currentMd5) {
      return null;
    }
    const normalizedCurrentMd5 = currentMd5.toLowerCase();
    const hashMatches = matching.filter(([, entry]) => entry.md5?.toLowerCase() === normalizedCurrentMd5);
    return hashMatches.length === 1 ? hashMatches[0]?.[0] || null : null;
  }
  async pendingOutputExists(entry: CacheEntry) {
    return this.cache.getCacheEntryState(entry) === "pending_move" && await this.cache.outputMatchesEntry(entry);
  }
  async collectCompactionKeys(entries: CachePathEntries) {
    const groups = new Map<string, CachePathEntries>();
    for (const entryPair of entries) {
      const entryPath = this.cache.getEntryPath(entryPair[0], entryPair[1]);
      const pathKey = normalizeVaultPathForComparison(entryPath);
      const pathEntries = groups.get(pathKey) || [];
      pathEntries.push(entryPair);
      groups.set(pathKey, pathEntries);
    }
    const candidates = new Map<string, CompactionCandidate>();
    let processedGroups = 0;
    for (const groupEntries of groups.values()) {
      const modernEntries = groupEntries.filter(([, entry]) => this.isModernCompactionEntry(entry));
      if (modernEntries.length === 0) {
        continue;
      }
      const firstModernEntry = modernEntries[0];
      if (!firstModernEntry) {
        continue;
      }
      const filePath = this.cache.getEntryPath(firstModernEntry[0], firstModernEntry[1]);
      const file = getVaultFileByPath(this.cache.app.vault, filePath);
      if (!file) {
        for (const [cacheKey] of modernEntries) {
          const entry = this.cache.cacheData.entries[cacheKey];
          if (entry) {
            candidates.set(cacheKey, { signature: JSON.stringify(entry), reason: "missing" });
          }
        }
      } else {
        const canonicalKey = await this.findCanonicalCompactionKey(file, modernEntries);
        if (canonicalKey) {
          for (const [cacheKey, entry] of modernEntries) {
            if (cacheKey === canonicalKey || await this.pendingOutputExists(entry)) {
              continue;
            }
            candidates.set(cacheKey, { signature: JSON.stringify(entry), reason: "superseded" });
          }
        }
      }
      processedGroups++;
      if (processedGroups % this.compactionBatchSize === 0) {
        await this.cache.yieldToUi();
      }
    }
    return { candidates };
  }
  async applyCompaction(entries: CachePathEntries): Promise<CacheCompactionResult> {
    const emptyResult = { removed: 0, missingFilesRemoved: 0, supersededRemoved: 0 };
    if (!this.cache.isAcceptingWrites() || entries.length === 0) {
      return emptyResult;
    }
    const collected = await this.collectCompactionKeys(entries);
    if (collected.candidates.size === 0 || !this.cache.isAcceptingWrites()) {
      return emptyResult;
    }
    await this.cache.createBackup();
    let missingFilesRemoved = 0;
    let supersededRemoved = 0;
    const removedEntries: Array<{
      cacheKey: string;
      previousEntry: CacheEntry;
      previousTombstone: ReturnType<Cache["getMutationRevision"]>;
      writtenTombstone: NonNullable<ReturnType<Cache["getMutationRevision"]>>;
    }> = [];
    for (const [cacheKey, candidate] of collected.candidates) {
      const currentEntry = this.cache.cacheData.entries[cacheKey];
      if (!currentEntry || JSON.stringify(currentEntry) !== candidate.signature) {
        continue;
      }
      const previousTombstone = this.cache.getMutationRevision(this.cache.cacheData.tombstones?.[cacheKey]);
      const writtenTombstone = this.cache.getMutationRevision(this.cache.tombstoneCacheEntry(cacheKey));
      if (!writtenTombstone) {
        continue;
      }
      removedEntries.push({ cacheKey, previousEntry: currentEntry, previousTombstone, writtenTombstone });
      if (candidate.reason === "missing") {
        missingFilesRemoved++;
      } else {
        supersededRemoved++;
      }
    }
    const removed = missingFilesRemoved + supersededRemoved;
    if (removed === 0 || !this.cache.isAcceptingWrites()) {
      return emptyResult;
    }
    if (!await this.cache.saveCache({ mergeDiskEntries: false, authoritative: true })) {
      for (const mutation of removedEntries) {
        this.cache.rollbackTombstoneMutationIfCurrent(
          mutation.cacheKey,
          mutation.previousEntry,
          mutation.previousTombstone || undefined,
          mutation.writtenTombstone
        );
      }
      return emptyResult;
    }
    return {
      removed,
      missingFilesRemoved,
      supersededRemoved
    };
  }
  async compactCache() {
    return await this.applyCompaction(this.cache.getCachePathEntries());
  }
  async compactPath(filePath: string) {
    return await this.applyCompaction(this.cache.getEntriesForPath(filePath));
  }
  async compactDeletedPath(filePath: string) {
    const normalized = this.cache.normalizeVaultPath(filePath);
    const entries = this.cache.getCachePathEntries().filter(([cacheKey, entry]) => {
      const entryPath = this.cache.getEntryPath(cacheKey, entry);
      return vaultPathsEqual(entryPath, normalized) || normalizeVaultPathForComparison(entryPath).startsWith(`${normalizeVaultPathForComparison(normalized)}/`);
    });
    return await this.applyCompaction(entries);
  }
}
