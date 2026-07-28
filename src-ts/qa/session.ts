import { TFile, TFolder, normalizePath } from "obsidian";
import type LocalImageCompressPlugin from "../plugin";
import type { BackupStoragePaths } from "../backup-storage";
import type { CacheData } from "../types";
import type { PlatformPorts } from "../platform";
import { normalizeSettings } from "../settings";
import { randomHexSuffix } from "../utils";
import {
  MOBILE_QA_JOURNAL_SCHEMA,
  MOBILE_QA_MARKER_PATH,
  MOBILE_QA_REPORT_ROOT,
  MOBILE_QA_REPORT_SCHEMA,
  MOBILE_QA_SESSION_PREFIX,
  cloneSettings,
  formatMobileQaTextReport,
  getMobileQaJournalPath,
  getMobileQaProgressPath,
  getMobileQaStateRoot,
  getMobileQaStorageRoot,
  sanitizeMobileQaMessage,
  type MobileQaCacheSnapshot,
  type MobileQaCleanupResult,
  type MobileQaJournalEnvelope,
  type MobileQaProfile,
  type MobileQaProgress,
  type MobileQaRecoveryResult,
  type MobileQaReport,
  type MobileQaSessionJournal,
  type MobileQaSessionPhase,
  type MobileQaVaultMarker
} from "./contracts";

const OWNER_MARKER_FILE = ".qa-session-owner.json";
const SESSION_ID_PATTERN = /^[a-f0-9]{32}$/;
const VAULT_ID_PATTERN = /^[a-f0-9]{32}$/;

type SessionOwnerMarker = {
  schema: "local-image-compress-mobile-qa-owner/v1";
  deviceOwnerId: string;
  vaultId: string;
  sessionId: string;
  sessionRoot: string;
};

export type SessionRuntimeState = {
  originalSettings: ReturnType<typeof cloneSettings>;
  originalCacheFile: string;
  originalCacheBackupsDir: string;
  originalCacheData: CacheData;
  originalGetBackupStoragePaths: () => BackupStoragePaths;
  hadOwnBackupStorageMethod: boolean;
  originalSaveSettings: LocalImageCompressPlugin["saveSettings"];
  hadOwnSaveSettingsMethod: boolean;
  originalCompressorCompress: LocalImageCompressPlugin["compressor"]["compress"];
  hadOwnCompressorCompressMethod: boolean;
  blockedSettingsSaveAttempts: number;
  observedCompressionInputs: string[];
  blockedCompressionInputs: string[];
  observedCompressionOutputs: string[];
  blockedCompressionOutputs: string[];
};

export type PreparedMobileQaSession = {
  journal: MobileQaSessionJournal;
  runtime: SessionRuntimeState;
};

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function isOwnedSessionRoot(sessionRoot: string, sessionId: string): boolean {
  return sessionRoot === `${MOBILE_QA_SESSION_PREFIX}${sessionId}` && SESSION_ID_PATTERN.test(sessionId);
}

function reportTimestamp(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function isValidReportPaths(journal: MobileQaSessionJournal): boolean {
  const jsonPrefix = `${MOBILE_QA_REPORT_ROOT}/runtime-qa-report-`;
  const jsonSuffix = `-${journal.sessionId}.json`;
  if (!journal.reportJsonPath.startsWith(jsonPrefix) || !journal.reportJsonPath.endsWith(jsonSuffix)) {
    return false;
  }
  const timestamp = journal.reportJsonPath.slice(jsonPrefix.length, -jsonSuffix.length);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(timestamp)) {
    return false;
  }
  return journal.reportTextPath === `${MOBILE_QA_REPORT_ROOT}/runtime-qa-log-${timestamp}-${journal.sessionId}.txt`;
}

function hasExactDerivedPaths(pluginDirectory: string, journal: MobileQaSessionJournal, journalPath: string): boolean {
  return isOwnedSessionRoot(journal.sessionRoot, journal.sessionId)
    && journal.stateRoot === getMobileQaStateRoot(pluginDirectory, journal.deviceOwnerId, journal.sessionId)
    && journalPath === getMobileQaJournalPath(pluginDirectory, journal.deviceOwnerId, journal.sessionId)
    && journal.progressPath === getMobileQaProgressPath(pluginDirectory, journal.deviceOwnerId, journal.sessionId)
    && isValidReportPaths(journal);
}

export class MobileQaSessionStore {
  private readonly controlFileHashes = new Map<string, string>();
  private readonly visibleReportHashes = new Map<string, string>();

  constructor(
    private readonly plugin: LocalImageCompressPlugin,
    private readonly ports: PlatformPorts,
    readonly deviceOwnerId: string
  ) {
    if (!SESSION_ID_PATTERN.test(deviceOwnerId)) {
      throw new Error("Invalid mobile QA device owner id");
    }
  }

  async assertVaultMarker(): Promise<MobileQaVaultMarker> {
    if (!await this.ports.fs.exists(MOBILE_QA_MARKER_PATH)) {
      throw new Error(`Mobile QA marker is missing: ${MOBILE_QA_MARKER_PATH}`);
    }
    const marker = parseJsonObject(await this.ports.fs.readText(MOBILE_QA_MARKER_PATH), "Mobile QA marker");
    const vaultId = marker["vaultId"];
    if (marker["schemaVersion"] !== 1
      || marker["purpose"] !== "local-image-compress-mobile-qa"
      || marker["allowDestructiveQa"] !== true
      || typeof vaultId !== "string"
      || !VAULT_ID_PATTERN.test(vaultId)) {
      throw new Error(`Mobile QA marker is invalid: ${MOBILE_QA_MARKER_PATH}`);
    }
    return {
      schemaVersion: 1,
      purpose: "local-image-compress-mobile-qa",
      allowDestructiveQa: true,
      vaultId
    };
  }

  async prepare(sessionId: string, profile: MobileQaProfile): Promise<PreparedMobileQaSession> {
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error("Invalid mobile QA session id");
    }
    const vaultMarker = await this.assertVaultMarker();
    await this.assertIdle();
    this.plugin.settingsTab?.flushPendingSaveSettings();
    if (!await this.plugin.waitForSettingsPersistenceIdle()) {
      throw new Error("Settings persistence ownership changed before mobile QA isolation");
    }
    if (!await this.plugin.cache.flushPendingCacheSave()) {
      throw new Error("Product cache did not settle before mobile QA isolation");
    }

    const originalSettings = cloneSettings(normalizeSettings(this.plugin.settings));
    const originalCacheFile = this.plugin.cache.cacheFile;
    const cacheSnapshot = await this.captureCacheSnapshot(originalCacheFile);
    const settingsSnapshotSha256 = this.ports.hash.sha256Hex(JSON.stringify(originalSettings));
    const sessionRoot = `${MOBILE_QA_SESSION_PREFIX}${sessionId}`;
    const pluginDirectory = this.plugin.getPluginDirectory();
    const timestamp = reportTimestamp();
    const journal: MobileQaSessionJournal = {
      schema: MOBILE_QA_JOURNAL_SCHEMA,
      deviceOwnerId: this.deviceOwnerId,
      vaultId: vaultMarker.vaultId,
      sessionId,
      profile,
      phase: "prepared",
      sessionRoot,
      stateRoot: getMobileQaStateRoot(pluginDirectory, this.deviceOwnerId, sessionId),
      progressPath: getMobileQaProgressPath(pluginDirectory, this.deviceOwnerId, sessionId),
      progressSha256: null,
      reportJsonPath: `${MOBILE_QA_REPORT_ROOT}/runtime-qa-report-${timestamp}-${sessionId}.json`,
      reportTextPath: `${MOBILE_QA_REPORT_ROOT}/runtime-qa-log-${timestamp}-${sessionId}.txt`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      settingsPersistence: "memory-only",
      cacheIsolation: "hidden-session-state",
      settingsSnapshotSha256,
      cacheSnapshot,
      ownedFiles: [],
      ownedDirectories: [getMobileQaStateRoot(pluginDirectory, this.deviceOwnerId, sessionId)],
      intentionallyRetainedArtifacts: []
    };

    for (const reportPath of [journal.reportJsonPath, journal.reportTextPath]) {
      if (await this.ports.fs.exists(reportPath)) {
        throw new Error(`Refusing to overwrite an existing mobile QA report path: ${reportPath}`);
      }
    }

    const runtime: SessionRuntimeState = {
      originalSettings,
      originalCacheFile,
      originalCacheBackupsDir: this.plugin.cache.cacheBackupsDir,
      originalCacheData: this.plugin.cache.cacheData,
      originalGetBackupStoragePaths: this.plugin.getBackupStoragePaths.bind(this.plugin),
      hadOwnBackupStorageMethod: Object.prototype.hasOwnProperty.call(this.plugin, "getBackupStoragePaths"),
      // Keep the exact instance property so a test/mock override can be restored byte-for-byte.
      originalSaveSettings: this.plugin["saveSettings"],
      hadOwnSaveSettingsMethod: Object.prototype.hasOwnProperty.call(this.plugin, "saveSettings"),
      // Keep the exact compressor override; the normal prototype method is restored by deletion.
      originalCompressorCompress: this.plugin.compressor["compress"],
      hadOwnCompressorCompressMethod: Object.prototype.hasOwnProperty.call(this.plugin.compressor, "compress"),
      blockedSettingsSaveAttempts: 0,
      observedCompressionInputs: [],
      blockedCompressionInputs: [],
      observedCompressionOutputs: [],
      blockedCompressionOutputs: []
    };
    const prepared = { journal, runtime };
    let journalWritten = false;
    let sessionRootCreated = false;
    try {
      await this.writeJournal(journal, true);
      journalWritten = true;
      await this.createSessionRoot(journal);
      sessionRootCreated = true;
      this.applyIsolation(journal, runtime);
      await this.updatePhase(journal, "running");
      return prepared;
    } catch (error) {
      let cleanupFailure = "";
      try {
        if (!sessionRootCreated && await this.ports.fs.exists(journal.sessionRoot)) {
          sessionRootCreated = true;
        }
        if (sessionRootCreated) {
          const cleanup = await this.restoreAndCleanup(prepared, true);
          if (cleanup.status === "pass") {
            await this.finalizeAfterReport(journal);
          } else {
            cleanupFailure = cleanup.errors.join("; ") || `cleanup status: ${cleanup.status}`;
          }
        } else if (journalWritten) {
          const journalPath = getMobileQaJournalPath(this.plugin.getPluginDirectory(), this.deviceOwnerId, journal.sessionId);
          await this.removeOwnedFile(journalPath, journalPath, this.controlFileHashes.get(journalPath) ?? null);
        } else {
          cleanupFailure = "";
        }
      } catch (cleanupError) {
        cleanupFailure = sanitizeMobileQaMessage(cleanupError, journal.sessionRoot);
      }
      if (cleanupFailure) {
        throw new Error(`${sanitizeMobileQaMessage(error, journal.sessionRoot)} Cleanup requires reload: ${cleanupFailure}`);
      }
      throw error;
    }
  }

  async updatePhase(journal: MobileQaSessionJournal, phase: MobileQaSessionPhase): Promise<void> {
    journal.phase = phase;
    journal.updatedAt = new Date().toISOString();
    await this.writeJournal(journal, false);
  }

  async writeProgress(journal: MobileQaSessionJournal, progress: MobileQaProgress): Promise<void> {
    const serialized = `${JSON.stringify(progress, null, 2)}\n`;
    const nextSha256 = this.ports.hash.sha256Hex(serialized);
    const previousSha256 = journal.progressSha256;
    const processTextAtomically = this.ports.fs.processTextAtomically;
    if (!processTextAtomically) {
      throw new Error("Mobile QA requires atomic text processing for crash-safe progress");
    }
    await processTextAtomically(journal.progressPath, serialized, (current) => {
      if (previousSha256 === null ? current !== serialized : this.ports.hash.sha256Hex(current) !== previousSha256) {
        throw new Error("Refusing to atomically replace changed mobile QA progress");
      }
      const existing = parseJsonObject(current, "Mobile QA progress");
      if (existing["schema"] !== progress.schema || existing["sessionId"] !== progress.sessionId) {
        throw new Error("Refusing to atomically replace foreign mobile QA progress");
      }
      return serialized;
    });
    if (await this.ports.fs.readText(journal.progressPath) !== serialized) {
      throw new Error("Mobile QA progress failed durable readback verification");
    }
    journal.progressSha256 = nextSha256;
    journal.updatedAt = new Date().toISOString();
    await this.writeJournal(journal, false);
  }

  async recordOwnedDirectory(journal: MobileQaSessionJournal, directoryPath: string): Promise<void> {
    const normalizedPath = this.assertOwnedArtifactPath(journal, directoryPath);
    const boundary = normalizedPath === journal.sessionRoot || normalizedPath.startsWith(`${journal.sessionRoot}/`)
      ? journal.sessionRoot
      : journal.stateRoot;
    let currentDirectory = normalizedPath;
    let changed = false;
    while (currentDirectory === boundary || currentDirectory.startsWith(`${boundary}/`)) {
      if (!journal.ownedDirectories.includes(currentDirectory)) {
        journal.ownedDirectories.push(currentDirectory);
        changed = true;
      }
      if (currentDirectory === boundary) {
        break;
      }
      currentDirectory = this.ports.fs.dirnamePath(currentDirectory);
    }
    if (changed) {
      journal.ownedDirectories.sort();
      await this.writeJournal(journal, false);
    }
  }

  async recordOwnedFile(journal: MobileQaSessionJournal, filePath: string, expectedSha256: string): Promise<void> {
    const normalizedPath = this.assertOwnedArtifactPath(journal, filePath);
    if (!await this.ports.fs.exists(normalizedPath)) {
      throw new Error(`Owned mobile QA file is missing: ${normalizedPath}`);
    }
    const actualSha256 = await this.ports.hash.fileSha256Hex(normalizedPath);
    if (!/^[a-f0-9]{64}$/.test(expectedSha256) || actualSha256 !== expectedSha256) {
      throw new Error(`Owned mobile QA file does not match its expected identity: ${normalizedPath}`);
    }
    const existingIndex = journal.ownedFiles.findIndex((entry) => entry.path === normalizedPath);
    const identity = { path: normalizedPath, sha256: expectedSha256 };
    if (existingIndex >= 0) {
      journal.ownedFiles[existingIndex] = identity;
    } else {
      journal.ownedFiles.push(identity);
    }
    const boundary = normalizedPath === journal.sessionRoot || normalizedPath.startsWith(`${journal.sessionRoot}/`)
      ? journal.sessionRoot
      : journal.stateRoot;
    let directoryPath = this.ports.fs.dirnamePath(normalizedPath);
    while (directoryPath === boundary || directoryPath.startsWith(`${boundary}/`)) {
      if (!journal.ownedDirectories.includes(directoryPath)) {
        journal.ownedDirectories.push(directoryPath);
      }
      if (directoryPath === boundary) {
        break;
      }
      directoryPath = this.ports.fs.dirnamePath(directoryPath);
    }
    journal.ownedFiles.sort((left, right) => left.path.localeCompare(right.path));
    journal.ownedDirectories.sort();
    await this.writeJournal(journal, false);
  }

  async writeReport(journal: MobileQaSessionJournal, report: MobileQaReport): Promise<void> {
    if (report.schema !== MOBILE_QA_REPORT_SCHEMA || report.sessionId !== journal.sessionId) {
      throw new Error("Mobile QA report identity does not match its session");
    }
    if (report.summary.success) {
      throw new Error("Mobile QA draft reports must remain fail-closed");
    }
    await this.ensureVisibleFolder(MOBILE_QA_REPORT_ROOT);
    await this.writeVisibleText(journal.reportTextPath, formatMobileQaTextReport(report));
    // JSON is the completion authority and lands last, after cleanup and the human-readable log.
    await this.writeVisibleText(journal.reportJsonPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  async publishFinalReport(journal: MobileQaSessionJournal, report: MobileQaReport): Promise<void> {
    if (!report.summary.success) {
      await this.writeReport(journal, report);
      return;
    }
    if (report.schema !== MOBILE_QA_REPORT_SCHEMA || report.sessionId !== journal.sessionId) {
      throw new Error("Mobile QA report identity does not match its session");
    }
    await this.ensureVisibleFolder(MOBILE_QA_REPORT_ROOT);
    // The JSON report is authoritative. Commit it before exposing PASS in the derivative TXT log.
    await this.writeVisibleText(journal.reportJsonPath, `${JSON.stringify(report, null, 2)}\n`);
    try {
      await this.writeVisibleText(journal.reportTextPath, formatMobileQaTextReport(report));
    } catch (error) {
      console.warn(`[Local Image Compress] Authoritative mobile QA JSON was saved, but the TXT summary remained fail-closed: ${sanitizeMobileQaMessage(error, journal.sessionRoot)}`);
    }
  }

  async restoreAndCleanup(
    prepared: PreparedMobileQaSession,
    allowCleanup: boolean
  ): Promise<MobileQaCleanupResult> {
    const { journal, runtime } = prepared;
    const errors: string[] = [];
    const retainedArtifacts: string[] = [];
    let settingsRestored = false;
    let productCacheUntouched = false;
    let sessionRootRemoved = false;

    try {
      await this.updatePhase(journal, "restoring");
    } catch (error) {
      errors.push(sanitizeMobileQaMessage(error, journal.sessionRoot));
    }
    let idle = false;
    if (allowCleanup) {
      try {
        idle = await this.isIdle();
      } catch (error) {
        errors.push(sanitizeMobileQaMessage(error, journal.sessionRoot));
      }
    }
    if (!allowCleanup || !idle) {
      retainedArtifacts.push(journal.sessionRoot, journal.stateRoot, getMobileQaJournalPath(this.plugin.getPluginDirectory(), this.deviceOwnerId, journal.sessionId));
      journal.intentionallyRetainedArtifacts = retainedArtifacts;
      try {
        await this.writeJournal(journal, false);
      } catch (error) {
        errors.push(sanitizeMobileQaMessage(error, journal.sessionRoot));
      }
      errors.push("A timed-out operation is still settling; reload the plugin before another QA run.");
      return {
        status: "deferred",
        settingsRestored,
        productCacheUntouched,
        sessionRootRemoved,
        retainedArtifacts,
        errors
      };
    }

    try {
      if (!await this.plugin.cache.flushPendingCacheSave()) {
        errors.push("Isolated cache did not settle during cleanup");
      } else if (await this.ports.fs.exists(this.plugin.cache.cacheFile)) {
        await this.recordOwnedFile(
          journal,
          this.plugin.cache.cacheFile,
          await this.ports.hash.fileSha256Hex(this.plugin.cache.cacheFile)
        );
      }
    } catch (error) {
      errors.push(sanitizeMobileQaMessage(error, journal.sessionRoot));
    }

    try {
      this.restoreRuntimeMethods(runtime);
    } catch (error) {
      errors.push(sanitizeMobileQaMessage(error, journal.sessionRoot));
    }

    try {
      this.plugin.settings = cloneSettings(runtime.originalSettings);
      this.plugin.applyRuntimeSettings();
      settingsRestored = true;
    } catch (error) {
      errors.push(sanitizeMobileQaMessage(error, journal.sessionRoot));
    }

    try {
      this.plugin.cache.cancelPendingSave();
      this.plugin.cache.cacheFile = runtime.originalCacheFile;
      this.plugin.cache.cacheBackupsDir = runtime.originalCacheBackupsDir;
      this.plugin.cache.cacheData = runtime.originalCacheData;
      productCacheUntouched = await this.productCacheMatches(journal.cacheSnapshot);
      await this.plugin.cache.loadCache();
    } catch (error) {
      errors.push(sanitizeMobileQaMessage(error, journal.sessionRoot));
    }

    if (!productCacheUntouched) {
      errors.push("Product cache changed while the QA cache was isolated; the current product cache was retained.");
    }

    if (errors.length === 0) {
      try {
        this.detachOwnedSessionLeaves(journal.sessionRoot);
        await this.removeOwnedSessionRoot(journal);
        sessionRootRemoved = true;
        await this.plugin.rebuildImageIndex("mobile-qa-restore");
      } catch (error) {
        errors.push(sanitizeMobileQaMessage(error, journal.sessionRoot));
      }
    }

    if (errors.length !== 0) {
      retainedArtifacts.push(getMobileQaJournalPath(this.plugin.getPluginDirectory(), this.deviceOwnerId, journal.sessionId));
      if (!sessionRootRemoved) {
        retainedArtifacts.push(journal.sessionRoot, journal.stateRoot);
      }
      journal.intentionallyRetainedArtifacts = retainedArtifacts;
      await this.writeJournal(journal, false);
    }

    return {
      status: errors.length === 0 ? "pass" : "fail",
      settingsRestored,
      productCacheUntouched,
      sessionRootRemoved,
      retainedArtifacts,
      errors
    };
  }

  async finalizeAfterReport(journal: MobileQaSessionJournal): Promise<void> {
    await this.updatePhase(journal, "completed");
    const pluginDirectory = this.plugin.getPluginDirectory();
    const progressPath = getMobileQaProgressPath(pluginDirectory, this.deviceOwnerId, journal.sessionId);
    const journalPath = getMobileQaJournalPath(pluginDirectory, this.deviceOwnerId, journal.sessionId);
    await this.removeOwnedFile(progressPath, progressPath, journal.progressSha256);
    await this.removeOwnedFile(journalPath, journalPath, this.controlFileHashes.get(journalPath) ?? null);
  }

  async recoverOwnedSessions(profile: MobileQaProfile): Promise<MobileQaRecoveryResult> {
    const result: MobileQaRecoveryResult = {
      status: "not-required",
      recoveredSessions: 0,
      retainedJournals: [],
      errors: []
    };
    const vaultMarker = await this.assertVaultMarker();
    const ownerRoot = `${getMobileQaStorageRoot(this.plugin.getPluginDirectory())}/${this.deviceOwnerId}`;
    if (!await this.ports.fs.exists(ownerRoot)) {
      return result;
    }
    const names = await this.ports.fs.listNames(ownerRoot);
    for (const name of names.sort()) {
      const match = /^([a-f0-9]{32})\.json$/.exec(name);
      if (!match?.[1]) {
        continue;
      }
      const journalPath = `${ownerRoot}/${name}`;
      try {
        const journalFile = await this.readJournalFile(journalPath);
        const journal = journalFile.journal;
        if (journal.deviceOwnerId !== this.deviceOwnerId
          || journal.vaultId !== vaultMarker.vaultId
          || journal.sessionId !== match[1]
          || journal.profile !== profile
          || !isOwnedSessionRoot(journal.sessionRoot, journal.sessionId)) {
          throw new Error("Journal identity does not match the local recovery namespace");
        }
        if (await this.ports.fs.exists(journal.sessionRoot) || await this.ports.fs.exists(journal.stateRoot)) {
          await this.removeOwnedSessionRoot(journal);
        }
        const progressPath = getMobileQaProgressPath(this.plugin.getPluginDirectory(), this.deviceOwnerId, journal.sessionId);
        await this.removeOwnedFile(progressPath, progressPath, journal.progressSha256);
        await this.removeOwnedFile(journalPath, journalPath, journalFile.sha256);
        result.recoveredSessions++;
      } catch (error) {
        result.retainedJournals.push(journalPath);
        result.errors.push(sanitizeMobileQaMessage(error, ""));
      }
    }
    result.status = result.errors.length > 0 ? "fail" : result.recoveredSessions > 0 ? "pass" : "not-required";
    return result;
  }

  private async assertIdle(): Promise<void> {
    if (!await this.isIdle()) {
      throw new Error("Compression, move, background, new-file, or cache work is still active");
    }
  }

  private async isIdle(): Promise<boolean> {
    if (!await this.plugin.waitForCompressionIdle(60_000)) {
      return false;
    }
    const queue = this.plugin.newFileQueue;
    return this.plugin.moveService.moveOperationInProgress !== true
      && this.plugin.backgroundCompressionService.isBackgroundCompressionRunning !== true
      && queue.newFileBatchDrainInProgress !== true
      && queue.newFileCompressionTimers.size === 0
      && queue.newFileCompressionInFlight.size === 0
      && queue.newFileCompressionPending.size === 0
      && queue.newFileBatchFlushTimer === null
      && queue.newFileBatchDrainRescheduleRequested !== true
      && this.plugin.cache.activeWritePromise === null;
  }

  private async captureCacheSnapshot(cacheFile: string): Promise<MobileQaCacheSnapshot> {
    const existed = await this.ports.fs.exists(cacheFile);
    if (!existed) {
      return { cacheFile, existed: false, sha256: null };
    }
    const rawText = await this.ports.fs.readText(cacheFile);
    return {
      cacheFile,
      existed: true,
      sha256: this.ports.hash.sha256Hex(rawText)
    };
  }

  private async productCacheMatches(snapshot: MobileQaCacheSnapshot): Promise<boolean> {
    const exists = await this.ports.fs.exists(snapshot.cacheFile);
    if (exists !== snapshot.existed) {
      return false;
    }
    if (!exists) {
      return true;
    }
    return this.ports.hash.sha256Hex(await this.ports.fs.readText(snapshot.cacheFile)) === snapshot.sha256;
  }

  private async createSessionRoot(journal: MobileQaSessionJournal): Promise<void> {
    if (await this.ports.fs.exists(journal.sessionRoot)) {
      throw new Error("Mobile QA session root already exists");
    }
    await this.ensureVisibleFolder(journal.sessionRoot);
    try {
      const marker: SessionOwnerMarker = {
        schema: "local-image-compress-mobile-qa-owner/v1",
        deviceOwnerId: this.deviceOwnerId,
        vaultId: journal.vaultId,
        sessionId: journal.sessionId,
        sessionRoot: journal.sessionRoot
      };
      const markerPath = `${journal.sessionRoot}/${OWNER_MARKER_FILE}`;
      const markerText = `${JSON.stringify(marker, null, 2)}\n`;
      await this.ports.fs.writeText(markerPath, markerText);
      await this.recordOwnedDirectory(journal, journal.sessionRoot);
      await this.recordOwnedFile(journal, markerPath, this.ports.hash.sha256Hex(markerText));
    } catch (error) {
      const createdFolder = this.plugin.app.vault.getAbstractFileByPath(journal.sessionRoot);
      if (createdFolder instanceof TFolder && createdFolder.path === journal.sessionRoot) {
        const entries = await this.ports.fs.listEntries(journal.sessionRoot).catch(() => []);
        if (entries.length === 0) {
          await this.ports.fs.removeDir(journal.sessionRoot, { recursive: false, force: false });
        }
      }
      throw error;
    }
  }

  private applyIsolation(journal: MobileQaSessionJournal, runtime: SessionRuntimeState): void {
    const fsPort = this.ports.fs;
    const cacheRoot = fsPort.joinPath(journal.stateRoot, "cache");
    const backupsRoot = fsPort.joinPath(journal.stateRoot, "backups");
    const cacheBackups = fsPort.joinPath(backupsRoot, "cache");
    const originalFilesBackups = fsPort.joinPath(backupsRoot, "originals");
    const isolatedPaths: BackupStoragePaths = {
      root: journal.stateRoot,
      backupsRoot,
      cacheBackups,
      originalFilesBackups
    };
    this.plugin.getBackupStoragePaths = () => isolatedPaths;
    this.plugin.saveSettings = async () => {
      runtime.blockedSettingsSaveAttempts++;
    };
    this.plugin.compressor.compress = async (...args: Parameters<SessionRuntimeState["originalCompressorCompress"]>) => {
      const [file, settings, operation] = args;
      const sourcePath = normalizePath(file?.path || "");
      const operationSourcePath = normalizePath(operation?.sourcePath || "");
      const sourcePaths = [sourcePath, operationSourcePath].filter(Boolean);
      if (sourcePaths.length === 0 || sourcePaths.some((candidate) => candidate !== journal.sessionRoot && !candidate.startsWith(`${journal.sessionRoot}/`))) {
        runtime.blockedCompressionInputs.push(sourcePath || "<missing>");
        throw new Error(`Mobile QA blocked compression outside its session root: ${sourcePath || "<missing>"}`);
      }
      const outputPath = normalizePath(this.plugin.compressor.getOutputPath(sourcePath, settings?.outputFolder || ""));
      if (outputPath !== journal.sessionRoot && !outputPath.startsWith(`${journal.sessionRoot}/`)) {
        runtime.blockedCompressionOutputs.push(outputPath || "<missing>");
        throw new Error(`Mobile QA blocked compression output outside its session root: ${outputPath || "<missing>"}`);
      }
      runtime.observedCompressionInputs.push(sourcePath);
      runtime.observedCompressionOutputs.push(outputPath);
      return await runtime.originalCompressorCompress.apply(this.plugin.compressor, args);
    };
    this.plugin.cache.cancelPendingSave();
    this.plugin.cache.cacheFile = fsPort.joinPath(cacheRoot, "tinyLocal-cache.json");
    this.plugin.cache.cacheBackupsDir = cacheBackups;
    this.plugin.cache.cacheData = { entries: {}, version: this.plugin.cache.CACHE_VERSION };
    this.plugin.settings = normalizeSettings({
      ...this.plugin.settings,
      allowedRoots: [journal.sessionRoot],
      outputFolder: fsPort.joinPath(journal.sessionRoot, "Compressed"),
      autoCompressNewFiles: false,
      autoBackgroundCompression: false,
      autoBackupsRetentionEnabled: false,
      autoMoveCompressedEnabled: false
    });
    this.plugin.applyRuntimeSettings();
  }

  private restoreRuntimeMethods(runtime: SessionRuntimeState): void {
    if (runtime.hadOwnBackupStorageMethod) {
      this.plugin.getBackupStoragePaths = runtime.originalGetBackupStoragePaths;
    } else {
      Reflect.deleteProperty(this.plugin, "getBackupStoragePaths");
    }
    if (runtime.hadOwnSaveSettingsMethod) {
      this.plugin.saveSettings = runtime.originalSaveSettings;
    } else {
      Reflect.deleteProperty(this.plugin, "saveSettings");
    }
    if (runtime.hadOwnCompressorCompressMethod) {
      this.plugin.compressor.compress = runtime.originalCompressorCompress;
    } else {
      Reflect.deleteProperty(this.plugin.compressor, "compress");
    }
  }

  private envelopeFor(journal: MobileQaSessionJournal): MobileQaJournalEnvelope {
    return {
      journal,
      sha256: this.ports.hash.sha256Hex(JSON.stringify(journal))
    };
  }

  private async writeJournal(journal: MobileQaSessionJournal, initial: boolean): Promise<void> {
    const journalPath = getMobileQaJournalPath(this.plugin.getPluginDirectory(), journal.deviceOwnerId, journal.sessionId);
    await this.ports.fs.mkdir(this.ports.fs.dirnamePath(journalPath));
    if (initial && await this.ports.fs.exists(journalPath)) {
      throw new Error("Refusing to overwrite an existing mobile QA session journal");
    }
    let expectedCurrentSha256: string | null = null;
    if (!initial) {
      const currentFile = await this.readJournalFile(journalPath);
      if (currentFile.journal.deviceOwnerId !== journal.deviceOwnerId || currentFile.journal.sessionId !== journal.sessionId) {
        throw new Error("Refusing to overwrite a foreign mobile QA session journal");
      }
      expectedCurrentSha256 = this.controlFileHashes.get(journalPath) ?? currentFile.sha256;
      if (currentFile.sha256 !== expectedCurrentSha256) {
        throw new Error("Refusing to overwrite a changed mobile QA session journal");
      }
    }
    const serialized = `${JSON.stringify(this.envelopeFor(journal), null, 2)}\n`;
    const processTextAtomically = this.ports.fs.processTextAtomically;
    if (!processTextAtomically) {
      throw new Error("Mobile QA requires atomic text processing for crash-safe session journals");
    }
    await processTextAtomically(journalPath, initial ? serialized : "", (current) => {
      if (initial) {
        if (current !== serialized) {
          throw new Error("Refusing to atomically overwrite an existing mobile QA session journal");
        }
      } else {
        if (this.ports.hash.sha256Hex(current) !== expectedCurrentSha256) {
          throw new Error("Refusing to atomically replace a changed mobile QA session journal");
        }
        const existing = this.parseJournal(current, journalPath);
        if (existing.deviceOwnerId !== journal.deviceOwnerId || existing.sessionId !== journal.sessionId) {
          throw new Error("Refusing to atomically replace a foreign mobile QA session journal");
        }
      }
      return serialized;
    });
    const verified = await this.readJournalFile(journalPath);
    const serializedSha256 = this.ports.hash.sha256Hex(serialized);
    if (verified.sha256 !== serializedSha256
      || verified.journal.phase !== journal.phase
      || verified.journal.updatedAt !== journal.updatedAt) {
      throw new Error("Mobile QA session journal failed durable readback verification");
    }
    this.controlFileHashes.set(journalPath, serializedSha256);
  }

  private async readJournalFile(journalPath: string): Promise<{ journal: MobileQaSessionJournal; sha256: string }> {
    const rawText = await this.ports.fs.readText(journalPath);
    return {
      journal: this.parseJournal(rawText, journalPath),
      sha256: this.ports.hash.sha256Hex(rawText)
    };
  }

  private parseJournal(rawText: string, journalPath: string): MobileQaSessionJournal {
    const raw = parseJsonObject(rawText, "Mobile QA journal envelope");
    const journal = raw["journal"];
    const envelopeSha256 = raw["sha256"];
    if (!journal || typeof journal !== "object" || Array.isArray(journal) || typeof envelopeSha256 !== "string") {
      throw new Error("Invalid mobile QA journal envelope");
    }
    const typed = journal as MobileQaSessionJournal;
    if (typed.schema !== MOBILE_QA_JOURNAL_SCHEMA
      || !SESSION_ID_PATTERN.test(typed.deviceOwnerId)
      || !VAULT_ID_PATTERN.test(typed.vaultId)
      || !SESSION_ID_PATTERN.test(typed.sessionId)
      || !hasExactDerivedPaths(this.plugin.getPluginDirectory(), typed, journalPath)
      || (typed.progressSha256 !== undefined
        && typed.progressSha256 !== null
        && !/^[a-f0-9]{64}$/.test(typed.progressSha256))
      || !Array.isArray(typed.ownedFiles)
      || !Array.isArray(typed.ownedDirectories)
      || typed.ownedFiles.some((entry) => !entry || typeof entry.path !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256 || ""))
      || typed.ownedDirectories.some((directoryPath) => typeof directoryPath !== "string")
      || this.ports.hash.sha256Hex(JSON.stringify(typed)) !== envelopeSha256) {
      throw new Error("Invalid or corrupt mobile QA session journal");
    }
    return {
      ...typed,
      progressSha256: typed.progressSha256 ?? null
    };
  }

  private assertOwnedArtifactPath(journal: MobileQaSessionJournal, artifactPath: string): string {
    const normalizedPath = normalizePath(artifactPath);
    const insideSession = normalizedPath === journal.sessionRoot || normalizedPath.startsWith(`${journal.sessionRoot}/`);
    const insideState = normalizedPath === journal.stateRoot || normalizedPath.startsWith(`${journal.stateRoot}/`);
    if (!insideSession && !insideState) {
      throw new Error(`Refusing mobile QA ownership outside the exact session roots: ${normalizedPath}`);
    }
    return normalizedPath;
  }

  private async collectOwnedTree(rootPath: string, directories: Set<string>, files: Set<string>): Promise<void> {
    if (!await this.ports.fs.exists(rootPath)) {
      return;
    }
    const rootStat = await this.ports.fs.stat(rootPath);
    if (!rootStat?.isDirectory) {
      throw new Error(`Mobile QA cleanup root is not a directory: ${rootPath}`);
    }
    directories.add(rootPath);
    for (const entry of await this.ports.fs.listEntries(rootPath)) {
      const entryPath = this.ports.fs.joinPath(rootPath, entry.name);
      if (entry.isSymbolicLink) {
        throw new Error(`Mobile QA cleanup found an unowned symbolic link: ${entryPath}`);
      }
      if (entry.isDirectory) {
        await this.collectOwnedTree(entryPath, directories, files);
      } else if (entry.isFile) {
        files.add(entryPath);
      } else {
        throw new Error(`Mobile QA cleanup found an unsupported entry: ${entryPath}`);
      }
    }
  }

  private async removeOwnedSessionRoot(journal: MobileQaSessionJournal): Promise<void> {
    if (!isOwnedSessionRoot(journal.sessionRoot, journal.sessionId)) {
      throw new Error("Refusing cleanup outside the exact mobile QA session root");
    }
    const vaultMarker = await this.assertVaultMarker();
    if (vaultMarker.vaultId !== journal.vaultId) {
      throw new Error("Refusing cleanup because the QA Vault identity changed");
    }
    const markerPath = `${journal.sessionRoot}/${OWNER_MARKER_FILE}`;
    const marker = parseJsonObject(await this.ports.fs.readText(markerPath), "Mobile QA owner marker");
    if (marker["schema"] !== "local-image-compress-mobile-qa-owner/v1"
      || marker["deviceOwnerId"] !== this.deviceOwnerId
      || marker["vaultId"] !== journal.vaultId
      || marker["sessionId"] !== journal.sessionId
      || marker["sessionRoot"] !== journal.sessionRoot) {
      throw new Error("Refusing cleanup because the mobile QA owner marker does not match");
    }
    const ownedFiles = new Map<string, string>();
    for (const entry of journal.ownedFiles) {
      const ownedPath = this.assertOwnedArtifactPath(journal, entry.path);
      if (ownedFiles.has(ownedPath)) {
        throw new Error(`Mobile QA ownership contains a duplicate file: ${ownedPath}`);
      }
      ownedFiles.set(ownedPath, entry.sha256);
    }
    const ownedDirectories = new Set(journal.ownedDirectories.map((directoryPath) => this.assertOwnedArtifactPath(journal, directoryPath)));
    if (!ownedDirectories.has(journal.sessionRoot) || !ownedDirectories.has(journal.stateRoot)) {
      throw new Error("Mobile QA ownership does not include both exact session roots");
    }
    const actualDirectories = new Set<string>();
    const actualFiles = new Set<string>();
    await this.collectOwnedTree(journal.sessionRoot, actualDirectories, actualFiles);
    await this.collectOwnedTree(journal.stateRoot, actualDirectories, actualFiles);
    for (const directoryPath of actualDirectories) {
      if (!ownedDirectories.has(directoryPath)) {
        throw new Error(`Mobile QA cleanup retained an unknown directory: ${directoryPath}`);
      }
    }
    for (const filePath of actualFiles) {
      const expectedSha256 = ownedFiles.get(filePath);
      if (!expectedSha256) {
        throw new Error(`Mobile QA cleanup retained an unknown file: ${filePath}`);
      }
      if (await this.ports.hash.fileSha256Hex(filePath) !== expectedSha256) {
        throw new Error(`Mobile QA cleanup retained a changed owned file: ${filePath}`);
      }
    }
    for (const [filePath, expectedSha256] of [...ownedFiles].sort(([left], [right]) => {
      if (left === markerPath) return 1;
      if (right === markerPath) return -1;
      return right.length - left.length;
    })) {
      if (!await this.ports.fs.exists(filePath)) {
        continue;
      }
      const removed = await this.ports.fs.removeFileIfUnchanged(filePath, expectedSha256);
      if (!removed.removed) {
        throw new Error(`Owned mobile QA file changed during cleanup: ${filePath}`);
      }
    }
    for (const directoryPath of [...ownedDirectories].sort((left, right) => right.length - left.length)) {
      if (await this.ports.fs.exists(directoryPath)) {
        await this.ports.fs.removeDir(directoryPath, { recursive: false, force: false });
      }
    }
  }

  private detachOwnedSessionLeaves(sessionRoot: string): void {
    for (const leaf of this.plugin.app.workspace.getLeavesOfType("markdown")) {
      const file = (leaf.view as { file?: TFile | null }).file;
      const filePath = normalizePath(file?.path || "");
      if (filePath === sessionRoot || filePath.startsWith(`${sessionRoot}/`)) {
        leaf.detach();
      }
    }
  }

  private async removeOwnedFile(filePath: string, expectedPath: string, expectedSha256: string | null): Promise<void> {
    if (filePath !== expectedPath) {
      throw new Error(`Refusing cleanup outside the exact mobile QA state path: ${filePath}`);
    }
    if (!await this.ports.fs.exists(filePath)) {
      return;
    }
    if (!expectedSha256 || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
      throw new Error(`Refusing cleanup without an authorized QA state hash: ${filePath}`);
    }
    const removed = await this.ports.fs.removeFileIfUnchanged(filePath, expectedSha256);
    if (!removed.removed) {
      throw new Error(`Owned QA state changed during cleanup: ${filePath}`);
    }
  }

  private async ensureVisibleFolder(folderPath: string): Promise<void> {
    const segments = normalizePath(folderPath).split("/").filter(Boolean);
    let current = "";
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment;
      const existing = this.plugin.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) {
        continue;
      }
      if (existing) {
        throw new Error(`Mobile QA report folder path is occupied by a file: ${current}`);
      }
      try {
        await this.plugin.app.vault.createFolder(current);
      } catch (error) {
        if (!(this.plugin.app.vault.getAbstractFileByPath(current) instanceof TFolder)) {
          throw error;
        }
      }
    }
  }

  private async writeVisibleText(filePath: string, text: string): Promise<void> {
    const normalizedPath = normalizePath(filePath);
    const existing = this.plugin.app.vault.getAbstractFileByPath(normalizedPath);
    const expectedSha256 = this.visibleReportHashes.get(normalizedPath);
    const nextSha256 = this.ports.hash.sha256Hex(text);
    if (existing instanceof TFile) {
      if (!expectedSha256) {
        throw new Error(`Refusing to overwrite a pre-existing mobile QA report: ${normalizedPath}`);
      }
      await this.plugin.app.vault.process(existing, (current) => {
        if (this.ports.hash.sha256Hex(current) !== expectedSha256) {
          throw new Error(`Mobile QA report changed before rewrite: ${normalizedPath}`);
        }
        return text;
      });
    } else {
      if (existing) {
        throw new Error(`Mobile QA report path is occupied by a folder: ${normalizedPath}`);
      }
      if (expectedSha256) {
        throw new Error(`Owned mobile QA report disappeared before rewrite: ${normalizedPath}`);
      }
      await this.plugin.app.vault.create(normalizedPath, text);
    }
    let committedText: string | null = null;
    try {
      committedText = await this.ports.fs.readText(normalizedPath);
    } catch {
      try {
        committedText = await this.ports.fs.readText(normalizedPath);
      } catch {
        // Vault.process/create already committed. A transiently unavailable adapter readback
        // cannot turn the same committed PASS into a controller failure.
        committedText = null;
      }
    }
    if (committedText !== null && this.ports.hash.sha256Hex(committedText) !== nextSha256) {
      throw new Error(`Mobile QA report failed durable readback verification: ${normalizedPath}`);
    }
    this.visibleReportHashes.set(normalizedPath, nextSha256);
  }
}

const DEVICE_OWNER_STORAGE_KEY = "local-image-compress.mobile-qa-device-owner.v1";

export async function getMobileQaDeviceOwnerId(ownerWindow: Window): Promise<string> {
  try {
    const stored = ownerWindow.localStorage.getItem(DEVICE_OWNER_STORAGE_KEY);
    if (stored && SESSION_ID_PATTERN.test(stored)) {
      return stored;
    }
  } catch {
    // The in-memory owner below keeps this load safe when storage is unavailable.
  }
  const ownerId = await randomHexSuffix(16);
  try {
    ownerWindow.localStorage.setItem(DEVICE_OWNER_STORAGE_KEY, ownerId);
    if (ownerWindow.localStorage.getItem(DEVICE_OWNER_STORAGE_KEY) !== ownerId) {
      throw new Error("Mobile QA device owner id failed persistent readback");
    }
  } catch (error) {
    throw new Error(`Mobile QA requires persistent local storage for crash recovery: ${sanitizeMobileQaMessage(error, "")}`);
  }
  return ownerId;
}
