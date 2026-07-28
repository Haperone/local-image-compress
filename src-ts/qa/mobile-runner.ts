import { Platform, TFile, TFolder, apiVersion, normalizePath, type App } from "obsidian";
import type LocalImageCompressPlugin from "../plugin";
import type { PlatformPorts } from "../platform";
import {
  MOBILE_COMPRESSION_MEMORY_BUDGET_MB,
  MOBILE_MAX_IMAGE_PIXELS_MILLIONS,
  MOBILE_MAX_INPUT_SIZE_MB
} from "../settings";
import {
  MOBILE_QA_PROGRESS_SCHEMA,
  MOBILE_QA_REPORT_SCHEMA,
  MOBILE_QA_SESSION_PREFIX,
  cloneSettings,
  sanitizeMobileQaMessage,
  type MobileQaCapabilities,
  type MobileQaCheckResult,
  type MobileQaCleanupResult,
  type MobileQaProfile,
  type MobileQaProgress,
  type MobileQaRecoveryResult,
  type MobileQaReport
} from "./contracts";
import { MobileQaSessionStore, type PreparedMobileQaSession } from "./session";
export { MobileQaSessionStore } from "./session";
import mobileQaScenarioMatrix from "../../scripts/mobile-qa-scenario-matrix.json";

const DEFAULT_CHECK_TIMEOUT_MS = 120_000;
const LATE_SETTLEMENT_TIMEOUT_MS = 30_000;
const SUITE_TIMEOUT_MS = 15 * 60_000;
const CLEANUP_TIMEOUT_MS = 120_000;
const REPORT_TIMEOUT_MS = 60_000;

export type MobileQaScenarioContext = {
  app: App;
  plugin: LocalImageCompressPlugin;
  ports: PlatformPorts;
  profile: MobileQaProfile;
  capabilities: MobileQaCapabilities;
  sessionRoot: string;
  stateRoot: string;
  fixtures: Map<string, string>;
  recordOwnedDirectory: (directoryPath: string) => Promise<void>;
  recordOwnedFile: (filePath: string, expectedSha256: string) => Promise<void>;
};

export type MobileQaScenario = {
  id: string;
  name: string;
  timeoutMs?: number;
  run(context: MobileQaScenarioContext): Promise<Record<string, unknown> | void>;
};

export type MobileQaRunnerOptions = {
  plugin: LocalImageCompressPlugin;
  ports: PlatformPorts;
  profile: MobileQaProfile;
  capabilities: MobileQaCapabilities;
  deviceOwnerId: string;
  sessionId: string;
  recovery: MobileQaRecoveryResult;
  isCancellationRequested(): boolean;
  onProgress(progress: MobileQaProgress): Promise<void>;
  scenarios?: readonly MobileQaScenario[];
};

type ScenarioExecution = {
  checks: MobileQaCheckResult[];
  cancelled: boolean;
  cleanupAllowed: boolean;
};

type MatrixScenario = {
  desktopCheck: string;
  classification: Record<MobileQaProfile | "desktop", "automated" | "partial" | "manual" | "skip">;
  manual: string[];
  skipReasons: Partial<Record<MobileQaProfile | "desktop", string>>;
};

const MATRIX_SCENARIOS = (mobileQaScenarioMatrix as { scenarios: MatrixScenario[] }).scenarios;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function isOwnedPath(sessionRoot: string, filePath: string): boolean {
  const normalizedRoot = normalizePath(sessionRoot);
  const normalizedPath = normalizePath(filePath);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function assertOwnedPath(sessionRoot: string, filePath: string): void {
  assert(isOwnedPath(sessionRoot, filePath), "QA product entrypoint path escaped the current session root");
}

async function wait(ownerWindow: Window, delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    ownerWindow.setTimeout(resolve, delayMs);
  });
}

async function ensureVaultFolder(context: MobileQaScenarioContext, folderPath: string): Promise<void> {
  const segments = normalizePath(folderPath).split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    const existing = context.app.vault.getAbstractFileByPath(current);
    if (existing instanceof TFolder) {
      continue;
    }
    if (existing) {
      throw new Error(`Fixture folder path is occupied by a file: ${current}`);
    }
    try {
      await context.app.vault.createFolder(current);
      if (isOwnedPath(context.sessionRoot, current)) {
        await context.recordOwnedDirectory(current);
      }
    } catch (error) {
      const afterCreate = context.app.vault.getAbstractFileByPath(current);
      if (!(afterCreate instanceof TFolder)) {
        throw error;
      }
    }
  }
}

async function canvasBytes(document: Document, mimeType: "image/jpeg" | "image/png", variant: number): Promise<ArrayBuffer> {
  const canvas = document.createElement("canvas");
  canvas.width = 720;
  canvas.height = 480;
  const context = canvas.getContext("2d");
  assert(context, "Canvas 2D context is unavailable");
  const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, `hsl(${(variant * 47) % 360} 85% 55%)`);
  gradient.addColorStop(1, `hsl(${(variant * 91 + 120) % 360} 75% 25%)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y += 12) {
    for (let x = 0; x < canvas.width; x += 12) {
      const hue = (x * 3 + y * 5 + variant * 31) % 360;
      context.fillStyle = `hsla(${hue} 80% 55% / 0.42)`;
      context.fillRect(x, y, 9, 9);
    }
  }
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value) {
        resolve(value);
      } else {
        reject(new Error(`Canvas failed to encode ${mimeType}`));
      }
    }, mimeType, mimeType === "image/jpeg" ? 0.98 : undefined);
  });
  return await blob.arrayBuffer();
}

async function createImageFixture(
  context: MobileQaScenarioContext,
  relativePath: string,
  mimeType: "image/jpeg" | "image/png",
  variant: number
): Promise<TFile> {
  const filePath = normalizePath(`${context.sessionRoot}/fixtures/${relativePath}`);
  assertOwnedPath(context.sessionRoot, filePath);
  await ensureVaultFolder(context, context.ports.fs.dirnamePath(filePath));
  const bytes = await canvasBytes(context.plugin.getActiveDocument(), mimeType, variant);
  const file = await context.app.vault.createBinary(filePath, bytes);
  await context.recordOwnedFile(filePath, context.ports.hash.sha256Hex(new Uint8Array(bytes)));
  context.fixtures.set(relativePath, filePath);
  return file;
}

async function assertCompressionOutput(context: MobileQaScenarioContext, file: TFile): Promise<Record<string, unknown>> {
  const sourceHash = await context.ports.hash.fileSha256Hex(file.path);
  const outputPath = context.plugin.compressor.getOutputPath(file.path, context.plugin.settings.outputFolder);
  assertOwnedPath(context.sessionRoot, file.path);
  assertOwnedPath(context.sessionRoot, outputPath);
  await context.plugin.compressFile(file);
  assert(await context.plugin.waitForCompressionIdle(), "Compression did not become idle");
  const sourceStat = await context.ports.fs.stat(file.path);
  const outputStat = await context.ports.fs.stat(outputPath);
  assert(sourceStat && outputStat, "Compression did not produce both source and output files");
  assert(outputStat.size < sourceStat.size, "Compression output is not smaller than its source");
  assert(await context.ports.hash.fileSha256Hex(file.path) === sourceHash, "Compression changed source bytes");
  const outputBytes = new Uint8Array(await context.ports.fs.readBinary(outputPath));
  context.plugin.compressor.validateEncodedOutput(file.extension.toLowerCase(), outputBytes);
  assert(await context.plugin.cache.isFileAlreadyProcessed(file), "Compression cache entry is not readable after commit");
  const outputSha256 = context.plugin.cache.getEntriesForPath(file.path)
    .map(([, entry]) => entry)
    .find((entry) => entry.state === "pending_move" && entry.outputPath === outputPath)?.outputSha256;
  assert(typeof outputSha256 === "string", "Compression cache has no exact committed output proof");
  await context.recordOwnedFile(outputPath, outputSha256);
  return {
    extension: file.extension.toLowerCase(),
    sourceBytes: sourceStat.size,
    outputBytes: outputStat.size,
    savedBytes: sourceStat.size - outputStat.size
  };
}

async function recordIsolatedCacheBackups(
  context: MobileQaScenarioContext,
  recordedBackupPaths: Set<string>
): Promise<void> {
  assertOwnedPath(context.stateRoot, context.plugin.cache.cacheBackupsDir);
  for (const backupName of await context.plugin.cache.getAvailableBackups()) {
    assert(context.plugin.cache.isValidBackupFileName(backupName), "Isolated cache returned an invalid backup filename");
    const backupPath = context.ports.fs.joinPath(context.plugin.cache.cacheBackupsDir, backupName);
    assertOwnedPath(context.stateRoot, backupPath);
    if (recordedBackupPaths.has(backupPath)) {
      continue;
    }
    await context.recordOwnedFile(backupPath, await context.ports.hash.fileSha256Hex(backupPath));
    recordedBackupPaths.add(backupPath);
  }
}

async function runScenarioWithCacheBackupOwnership(
  scenario: MobileQaScenario,
  context: MobileQaScenarioContext,
  recordedBackupPaths: Set<string>
): Promise<Record<string, unknown> | void> {
  let result: Record<string, unknown> | void = undefined;
  let scenarioError: unknown;
  let scenarioFailed = false;
  try {
    result = await scenario.run(context);
  } catch (error) {
    scenarioFailed = true;
    scenarioError = error;
  }
  try {
    await recordIsolatedCacheBackups(context, recordedBackupPaths);
  } catch (ownershipError) {
    if (scenarioFailed) {
      throw new Error(`Scenario failed: ${String(scenarioError)}; cache-backup ownership failed: ${String(ownershipError)}`);
    }
    throw ownershipError;
  }
  if (scenarioFailed) {
    throw scenarioError;
  }
  return result;
}

async function listTreePathsRecursive(ports: PlatformPorts, rootPath: string): Promise<{ directories: string[]; files: string[] }> {
  if (!await ports.fs.exists(rootPath)) {
    return { directories: [], files: [] };
  }
  const directories: string[] = [];
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    directories.push(directory);
    for (const entry of await ports.fs.listEntries(directory)) {
      const entryPath = ports.fs.joinPath(directory, entry.name);
      assert(!entry.isSymbolicLink, `Mobile QA file tree contains a symbolic link: ${entryPath}`);
      if (entry.isDirectory) {
        await visit(entryPath);
      } else if (entry.isFile) {
        files.push(entryPath);
      } else {
        throw new Error(`Mobile QA file tree contains an unsupported entry: ${entryPath}`);
      }
    }
  };
  await visit(rootPath);
  return { directories, files };
}

async function listFilePathsRecursive(ports: PlatformPorts, rootPath: string): Promise<string[]> {
  return (await listTreePathsRecursive(ports, rootPath)).files;
}

export async function verifyMobileQaBackupTree(
  ports: PlatformPorts,
  backupRoot: string,
  expectedBackupFiles: ReadonlyMap<string, string>
): Promise<Array<{ filePath: string; sha256: string }>> {
  const tree = await listTreePathsRecursive(ports, backupRoot);
  const expectedDirectories = new Set([backupRoot]);
  for (const expectedFilePath of expectedBackupFiles.keys()) {
    let directoryPath = ports.fs.dirnamePath(expectedFilePath);
    while (directoryPath === backupRoot || directoryPath.startsWith(`${backupRoot}/`)) {
      expectedDirectories.add(directoryPath);
      if (directoryPath === backupRoot) break;
      directoryPath = ports.fs.dirnamePath(directoryPath);
    }
    assert(tree.files.includes(expectedFilePath), "Mobile QA exact original-backup file is missing");
  }
  assert(tree.directories.length === expectedDirectories.size
    && tree.directories.every((directoryPath) => expectedDirectories.has(directoryPath)),
  "Mobile QA original-backup tree contains an unproven directory");
  const identities = await Promise.all(tree.files.map(async (filePath) => ({
    filePath,
    sha256: expectedBackupFiles.get(filePath),
    actualSha256: await ports.hash.fileSha256Hex(filePath)
  })));
  for (const identity of identities) {
    assert(typeof identity.sha256 === "string" && identity.actualSha256 === identity.sha256,
      "Mobile QA refused to adopt an unproven original-backup file");
  }
  return identities.map((identity) => ({ filePath: identity.filePath, sha256: identity.sha256 as string }));
}

export function getMobileQaMoveBackupProofPaths(
  ports: PlatformPorts,
  originalBackupPath: string,
  compressedPath: string
): { compressedBackupPath: string; originalBackupPath: string } {
  const normalizedOriginalBackupPath = normalizePath(originalBackupPath);
  const originalsMarker = "/originals/";
  const originalsIndex = normalizedOriginalBackupPath.lastIndexOf(originalsMarker);
  assert(originalsIndex > 0, "Mobile move backup path has no exact batch originals segment");
  const batchRoot = normalizedOriginalBackupPath.slice(0, originalsIndex);
  return {
    originalBackupPath: normalizedOriginalBackupPath,
    compressedBackupPath: ports.fs.joinPath(batchRoot, "compressed", compressedPath)
  };
}

function scenarioDefinitions(): MobileQaScenario[] {
  return [
    {
      id: "M01",
      name: "Services, product commands, and image index are ready",
      async run({ app, plugin }) {
        assert(plugin.isInitialized, "Plugin is not initialized");
        assert(plugin.cache && plugin.compressor && plugin.imageIndex, "Core plugin services are unavailable");
        const commandApp = app as App & { commands?: { commands?: Record<string, unknown> } };
        const commands = commandApp.commands?.commands || {};
        const expected = [
          "compress-images-in-note",
          "compress-images-in-folder",
          "compress-all-images",
          "move-compressed-to-files"
        ];
        for (const id of expected) {
          assert(`${plugin.manifest.id}:${id}` in commands, `Product command is missing: ${id}`);
        }
        assert(plugin.imageIndex.isReady(), "Image index is not ready");
        return { commandCount: expected.length, imageIndexReady: true };
      }
    },
    {
      id: "M02",
      name: "Mobile ports, codecs, worker count, and memory limits are active",
      async run({ plugin, ports }) {
        assert(Platform.isMobile === true, "Obsidian did not select a mobile platform profile");
        assert(ports.fs.sync === null, "Mobile filesystem unexpectedly exposes synchronous operations");
        assert(ports.runtime.revealPath === null, "Mobile runtime unexpectedly exposes revealPath");
        assert(plugin.compressor.activeWorkerCount === 1, "Mobile compressor worker count is not serialized");
        assert(plugin.compressionLimiter.getLimit() === 1, "Mobile plugin compression limiter is not serialized");
        assert(plugin.compressor.maxInputBytes === MOBILE_MAX_INPUT_SIZE_MB * 1024 * 1024, "Mobile input byte limit is incorrect");
        assert(plugin.compressor.maxImagePixels === MOBILE_MAX_IMAGE_PIXELS_MILLIONS * 1_000_000, "Mobile pixel limit is incorrect");
        assert(plugin.compressor.memoryBudgetBytes === MOBILE_COMPRESSION_MEMORY_BUDGET_MB * 1024 * 1024, "Mobile memory budget is incorrect");
        plugin.compressor.checkBinaries();
        return {
          workers: plugin.compressor.activeWorkerCount,
          maxInputMb: MOBILE_MAX_INPUT_SIZE_MB,
          maxPixelsMillions: MOBILE_MAX_IMAGE_PIXELS_MILLIONS,
          memoryBudgetMb: MOBILE_COMPRESSION_MEMORY_BUDGET_MB
        };
      }
    },
    {
      id: "M03",
      name: "Mobile localization, settings service, and ribbon surface are available",
      async run({ plugin, capabilities }) {
        assert(plugin.settingsTab, "Settings tab is unavailable");
        assert(typeof LocalImageCompressPluginLanguage(plugin) === "string", "Current plugin language is unavailable");
        assert(capabilities.mobileRibbon, "Mobile ribbon trigger is unavailable");
        return { language: LocalImageCompressPluginLanguage(plugin), mobileRibbon: true };
      }
    },
    {
      id: "M04",
      name: "Session settings, cache, outputs, and backups are isolated",
      async run({ plugin, sessionRoot, stateRoot }) {
        assert(plugin.settings.allowedRoots.length === 1 && plugin.settings.allowedRoots[0] === sessionRoot, "Allowed roots are not isolated");
        assertOwnedPath(sessionRoot, plugin.settings.outputFolder);
        assertOwnedPath(stateRoot, plugin.cache.cacheFile);
        assertOwnedPath(stateRoot, plugin.cache.cacheBackupsDir);
        assertOwnedPath(stateRoot, plugin.getBackupStoragePaths().originalFilesBackups);
        assert(plugin.settings.autoCompressNewFiles === false
          && plugin.settings.autoBackgroundCompression === false
          && plugin.settings.autoMoveCompressedEnabled === false,
        "Background automation was not disabled");
        return { settingsPersistence: "memory-only", cacheIsolation: "hidden-session-state" };
      }
    },
    {
      id: "M05",
      name: "JPG, JPEG, and PNG compression preserves sources and validates outputs",
      timeoutMs: 180_000,
      async run(context) {
        const files = [
          await createImageFixture(context, "direct/direct.jpg", "image/jpeg", 1),
          await createImageFixture(context, "direct/direct.jpeg", "image/jpeg", 2),
          await createImageFixture(context, "direct/direct.png", "image/png", 3)
        ];
        const outputs: Record<string, unknown>[] = [];
        for (const file of files) {
          outputs.push(await assertCompressionOutput(context, file));
        }
        const firstFile = files[0];
        assert(firstFile, "Direct compression fixture list is empty");
        const repeated = await context.plugin.validateFileForCompression(firstFile);
        assert(repeated.valid === false, "Repeated compression validation accepted an already processed source");
        return { outputs };
      }
    },
    {
      id: "M06",
      name: "Unsupported, too-small, and oversized inputs fail safely",
      async run(context) {
        const invalidPath = `${context.sessionRoot}/fixtures/validation/unsupported.gif`;
        await ensureVaultFolder(context, context.ports.fs.dirnamePath(invalidPath));
        const unsupportedBytes = new Uint8Array([0x47, 0x49, 0x46, 0x38]);
        const unsupported = await context.app.vault.createBinary(invalidPath, unsupportedBytes.buffer);
        await context.recordOwnedFile(unsupported.path, context.ports.hash.sha256Hex(unsupportedBytes));
        const unsupportedResult = await context.plugin.validateFileForCompression(unsupported);
        assert(unsupportedResult.valid === false, "Unsupported input was accepted");
        const tinyPath = `${context.sessionRoot}/fixtures/validation/tiny.jpg`;
        const tinyBytes = new Uint8Array(512);
        const tiny = await context.app.vault.createBinary(tinyPath, tinyBytes.buffer);
        await context.recordOwnedFile(tiny.path, context.ports.hash.sha256Hex(tinyBytes));
        context.fixtures.set("validation/tiny.jpg", tiny.path);
        const tinyResult = await context.plugin.validateFileForCompression(tiny);
        assert(tinyResult.valid === false && tinyResult.skipped === true, "Too-small input was not rejected safely");
        assert(context.plugin.compressor.isTooLargeInput(context.plugin.compressor.maxInputBytes + 1), "Oversized input metadata was not rejected");
        assert(context.plugin.compressor.getTooLargeResult(context.plugin.compressor.maxInputBytes + 1, "file-size").skipReason === "too_large", "Oversized input did not return the expected skip reason");
        return { unsupported: true, tooSmall: true, metadataOnlyTooLarge: true };
      }
    },
    {
      id: "M07",
      name: "Isolated cache compaction, backup, clear, and restore work",
      async run({ plugin, stateRoot }) {
        assertOwnedPath(stateRoot, plugin.cache.cacheFile);
        assertOwnedPath(stateRoot, plugin.cache.cacheBackupsDir);
        assert(await plugin.cache.flushPendingCacheSave(), "Isolated cache did not flush");
        await plugin.cache.compactCache();
        assert(await plugin.cache.flushPendingCacheSave(), "Compacted isolated cache did not flush");
        const cacheSha256 = await plugin.getPlatformPorts().hash.fileSha256Hex(plugin.cache.cacheFile);
        const backupsBefore = new Set(await plugin.cache.getAvailableBackups());
        await plugin.cache.createBackup();
        const backups = await plugin.cache.getAvailableBackups();
        const createdBackups = backups.filter((backupName) => !backupsBefore.has(backupName));
        assert(createdBackups.length > 0, "Isolated cache backup was not created");
        for (const backupName of createdBackups) {
          const backupPath = plugin.getPlatformPorts().fs.joinPath(plugin.cache.cacheBackupsDir, backupName);
          assert(await plugin.getPlatformPorts().hash.fileSha256Hex(backupPath) === cacheSha256, "New isolated cache backup does not match the persisted cache");
        }
        assert(await plugin.cache.clearCache(), "Isolated cache could not be cleared");
        assert(plugin.cache.getCacheStats().total === 0, "Isolated cache was not cleared in memory");
        assert(await plugin.cache.restoreFromBackup(createdBackups[0] || null), "Isolated cache backup could not be restored");
        assert(plugin.cache.getCacheStats().total > 0, "Restored isolated cache is empty");
        return {
          availableBackupCount: backups.length,
          createdBackupCount: createdBackups.length,
          restoredEntries: plugin.cache.getCacheStats().total
        };
      }
    },
    {
      id: "M08",
      name: "Active note, folder, and all-images workflows respect QA scope",
      timeoutMs: 180_000,
      async run(context) {
        const noteImage = await createImageFixture(context, "workflows/note.jpg", "image/jpeg", 4);
        const folderImage = await createImageFixture(context, "workflows/folder/folder.jpg", "image/jpeg", 5);
        const allImage = await createImageFixture(context, "workflows/all/all.png", "image/png", 6);
        const notePath = `${context.sessionRoot}/fixtures/workflows/note.md`;
        const noteText = `![[${noteImage.path}]]\n`;
        const note = await context.app.vault.create(notePath, noteText);
        await context.recordOwnedFile(note.path, context.ports.hash.sha256Hex(noteText));
        const previousFile = context.app.workspace.getActiveFile();
        const leaf = context.app.workspace.getLeaf(false);
        try {
          await leaf.openFile(note);
          await wait(context.plugin.getActiveWindow(), 300);
          await context.plugin.compressImagesInNote();
        } finally {
          if (previousFile) {
            await leaf.openFile(previousFile);
          } else {
            leaf.detach();
          }
        }
        await context.plugin.compressImagesInFolderPath(context.ports.fs.dirnamePath(folderImage.path), true);
        await context.plugin.rebuildImageIndex("mobile-qa-all-images");
        await context.plugin.compressAllImages();
        for (const file of [noteImage, folderImage, allImage]) {
          const output = context.plugin.compressor.getOutputPath(file.path, context.plugin.settings.outputFolder);
          assertOwnedPath(context.sessionRoot, output);
          assert(await context.ports.fs.exists(output), `Workflow output is missing for ${file.extension}`);
          const outputSha256 = context.plugin.cache.getEntriesForPath(file.path)
            .map(([, entry]) => entry)
            .find((entry) => entry.state === "pending_move" && entry.outputPath === output)?.outputSha256;
          assert(typeof outputSha256 === "string", "Workflow output has no exact committed cache proof");
          await context.recordOwnedFile(output, outputSha256);
        }
        return { activeNote: true, folder: true, allImages: true };
      }
    },
    {
      id: "M09",
      name: "Background batch and new-file queue compress inside QA scope",
      timeoutMs: 180_000,
      async run(context) {
        const background = await createImageFixture(context, "automation/background.jpg", "image/jpeg", 7);
        await context.plugin.processBatchCompressionBackground([background]);
        const backgroundOutput = context.plugin.compressor.getOutputPath(background.path, context.plugin.settings.outputFolder);
        assert(await context.ports.fs.exists(backgroundOutput), "Background batch did not create an output");
        const backgroundSha256 = context.plugin.cache.getEntriesForPath(background.path)
          .map(([, entry]) => entry)
          .find((entry) => entry.state === "pending_move" && entry.outputPath === backgroundOutput)?.outputSha256;
        assert(typeof backgroundSha256 === "string", "Background output has no exact committed cache proof");
        await context.recordOwnedFile(backgroundOutput, backgroundSha256);

        const queued = await createImageFixture(context, "automation/new-file.jpg", "image/jpeg", 8);
        context.plugin.settings.autoCompressNewFiles = true;
        try {
          await context.plugin.handleNewFile(queued);
          await wait(context.plugin.getActiveWindow(), context.plugin.newFileQueue.AUTO_COMPRESS_DELAY + 350);
          await context.plugin.drainNewFileCompressionBatch();
        } finally {
          context.plugin.settings.autoCompressNewFiles = false;
        }
        const queuedOutput = context.plugin.compressor.getOutputPath(queued.path, context.plugin.settings.outputFolder);
        assert(await context.ports.fs.exists(queuedOutput), "New-file queue did not create an output");
        const queuedSha256 = context.plugin.cache.getEntriesForPath(queued.path)
          .map(([, entry]) => entry)
          .find((entry) => entry.state === "pending_move" && entry.outputPath === queuedOutput)?.outputSha256;
        assert(typeof queuedSha256 === "string", "New-file queue output has no exact committed cache proof");
        await context.recordOwnedFile(queuedOutput, queuedSha256);
        return { backgroundBatch: true, newFileQueue: true };
      }
    },
    {
      id: "M10",
      name: "Move, auto-move, original backup, and backup cleanup stay isolated",
      timeoutMs: 180_000,
      async run(context) {
        const expectedBackupFiles = new Map<string, string>();
        const captureMoveBackupProofs = async <T>(action: () => Promise<T>): Promise<T> => {
          const moveService = context.plugin.moveService;
          const originalOwnDescriptor = Object.getOwnPropertyDescriptor(moveService, "createBackupBeforeMove");
          const originalCreateBackupBeforeMove = moveService.createBackupBeforeMove.bind(moveService);
          context.plugin.moveService.createBackupBeforeMove = async function(compressedFiles) {
            const result = await originalCreateBackupBeforeMove(compressedFiles);
            for (const file of result.files) {
              assert(/^[a-f0-9]{64}$/.test(file.originalSha256BeforeMove || "")
                && /^[a-f0-9]{64}$/.test(file.compressedSha256 || ""),
              "Mobile move backup result has no exact path-bound file proofs");
              const proofPaths = getMobileQaMoveBackupProofPaths(
                context.ports,
                file.originalBackupPath || "",
                file.compressedPath
              );
              for (const [filePath, expectedSha256] of [
                [proofPaths.originalBackupPath, file.originalSha256BeforeMove],
                [proofPaths.compressedBackupPath, file.compressedSha256]
              ] as Array<[string, string]>) {
                assertOwnedPath(context.stateRoot, filePath);
                assert(!expectedBackupFiles.has(filePath), "Mobile move backup proof reused an exact path");
                expectedBackupFiles.set(filePath, expectedSha256);
              }
            }
            return result;
          };
          try {
            return await action();
          } finally {
            if (originalOwnDescriptor) {
              Object.defineProperty(moveService, "createBackupBeforeMove", originalOwnDescriptor);
            } else {
              Reflect.deleteProperty(moveService, "createBackupBeforeMove");
            }
          }
        };
        const verifyAndRecordBackupTree = async (backupRoot: string) => {
          const identities = await verifyMobileQaBackupTree(context.ports, backupRoot, expectedBackupFiles);
          for (const identity of identities) {
            await context.recordOwnedFile(identity.filePath, identity.sha256);
          }
          return identities;
        };
        const candidates = await context.plugin.moveService.getCompressedMoveCandidates();
        assert(candidates.length > 0, "No compressed files were available for move QA");
        const moveProofs: Array<{
          compressedPath: string;
          compressedSha256: string;
          originalPath: string;
          originalSha256: string;
        }> = [];
        for (const candidate of candidates) {
          assertOwnedPath(context.sessionRoot, candidate.compressedPath);
          assert(typeof candidate.relativePath === "string", "Move candidate has no source-relative path");
          assertOwnedPath(context.sessionRoot, candidate.relativePath);
          if (candidate.originalPath) {
            assertOwnedPath(context.sessionRoot, candidate.originalPath);
          }
          const originalPath = candidate.originalPath || await context.plugin.moveService.findOriginalFileForCompressed(candidate);
          if (originalPath) {
            assertOwnedPath(context.sessionRoot, originalPath);
            moveProofs.push({
              compressedPath: candidate.compressedPath,
              compressedSha256: await context.ports.hash.fileSha256Hex(candidate.compressedPath),
              originalPath,
              originalSha256: await context.ports.hash.fileSha256Hex(originalPath)
            });
          }
        }
        assert(moveProofs.length > 0, "No unambiguous move candidates were available");
        await captureMoveBackupProofs(async () => await context.plugin.moveService.moveCompressedToFiles());
        const backupRoot = context.plugin.getBackupStoragePaths().originalFilesBackups;
        assertOwnedPath(context.stateRoot, backupRoot);
        assert(await context.ports.fs.exists(backupRoot), "Move did not create isolated original backups");
        const backupIdentitiesAfterMove = await verifyAndRecordBackupTree(backupRoot);
        const backupHashesAfterMove = new Set(backupIdentitiesAfterMove.map((backup) => backup.sha256));
        for (const proof of moveProofs) {
          assert(!await context.ports.fs.exists(proof.compressedPath), "Move retained a compressed output after replacement");
          assert(await context.ports.hash.fileSha256Hex(proof.originalPath) === proof.compressedSha256, "Move did not install the exact compressed bytes");
          assert(backupHashesAfterMove.has(proof.originalSha256), "Move backup does not preserve the exact original bytes");
          const movedFile = context.app.vault.getAbstractFileByPath(proof.originalPath);
          assert(movedFile instanceof TFile, "Moved original is not visible through the Vault API");
          assert(await context.plugin.cache.isFileAlreadyProcessed(movedFile), "Moved cache transition is not readable");
          await context.recordOwnedFile(proof.originalPath, proof.compressedSha256);
        }

        const autoMove = await createImageFixture(context, "move/auto-move.jpg", "image/jpeg", 9);
        const autoMovePath = autoMove.path;
        const autoMoveOriginalSha256 = await context.ports.hash.fileSha256Hex(autoMovePath);
        const originalSettings = cloneSettings(context.plugin.settings);
        const autoMoveOutput = context.plugin.compressor.getOutputPath(autoMovePath, originalSettings.outputFolder);
        await context.recordOwnedDirectory(autoMoveOutput.slice(0, autoMoveOutput.lastIndexOf("/")));
        try {
          context.plugin.settings.autoMoveCompressedEnabled = true;
          context.plugin.settings.autoMoveCompressedThreshold = 1;
          await captureMoveBackupProofs(async () => await context.plugin.compressFile(autoMove));
        } finally {
          context.plugin.settings = originalSettings;
          context.plugin.applyRuntimeSettings();
        }
        assert(!await context.ports.fs.exists(autoMoveOutput), "Auto-move left its compressed output behind");
        const autoMoveInstalledSha256 = await context.ports.hash.fileSha256Hex(autoMovePath);
        assert(autoMoveInstalledSha256 !== autoMoveOriginalSha256, "Auto-move did not replace the original bytes");
        const freshAutoMove = context.app.vault.getAbstractFileByPath(autoMovePath);
        assert(freshAutoMove instanceof TFile && await context.plugin.cache.isFileAlreadyProcessed(freshAutoMove), "Auto-move cache transition is not readable");
        const exactAutoMoveProof = context.plugin.cache.getEntriesForPath(autoMovePath)
          .map(([, entry]) => entry)
          .find((entry) => entry.state === "moved" && entry.outputSha256 === autoMoveInstalledSha256);
        assert(!!exactAutoMoveProof, "Auto-move installed bytes differ from the exact committed compressed output");
        const exactAutoMoveSha256 = exactAutoMoveProof.outputSha256;
        assert(typeof exactAutoMoveSha256 === "string", "Auto-move cache proof has no output SHA-256");
        await context.recordOwnedFile(autoMovePath, exactAutoMoveSha256);
        const backupIdentitiesAfterAutoMove = await verifyAndRecordBackupTree(backupRoot);
        const backupHashesAfterAutoMove = new Set(backupIdentitiesAfterAutoMove.map((backup) => backup.sha256));
        assert(backupHashesAfterAutoMove.has(autoMoveOriginalSha256), "Auto-move backup does not preserve the exact original bytes");
        await context.plugin.clearOriginalFilesBackups();
        const remainingBackups = await listFilePathsRecursive(context.ports, backupRoot);
        assert(remainingBackups.length === 0, "Isolated original backups were not cleared");
        return { movedCandidates: moveProofs.length, verifiedBackupFiles: backupIdentitiesAfterMove.length, autoMove: true, backupCleanup: true };
      }
    },
    {
      id: "M11",
      name: "Force refresh, index, stats, and counts remain consistent",
      timeoutMs: 180_000,
      async run({ app, fixtures, plugin, sessionRoot }) {
        await plugin.forceRefreshCache();
        await plugin.rebuildImageIndex("mobile-qa-final-index");
        assert(plugin.imageIndex?.isReady(), "Image index is not ready after force refresh");
        const counts = await plugin.getImageCompressionCounts();
        const stats = await plugin.getStatsSnapshot();
        const expectedFiles = Array.from(fixtures.values())
          .map((filePath) => app.vault.getAbstractFileByPath(filePath))
          .filter((file): file is TFile => file instanceof TFile)
          .filter((file) => isOwnedPath(sessionRoot, file.path) && plugin.isImageFile(file) && !plugin.isOutputFolderPath(file.path));
        const expectedUncompressed = (await plugin.filterUnprocessedImageFiles(expectedFiles)).length;
        assert(Number.isInteger(counts.totalImages) && Number.isInteger(counts.uncompressedImages), "Image counts are not integers");
        assert(counts.totalImages === expectedFiles.length, "Image index total does not match visible QA images");
        assert(counts.uncompressedImages === expectedUncompressed, "Image index uncompressed count does not match cache state");
        assert(stats.totalImages === counts.totalImages && stats.uncompressedImages === counts.uncompressedImages, "Stats and index counts disagree");
        assert(stats.savings.totalFiles === counts.totalImages, "Savings total does not match image count");
        assert(stats.cacheStats.total >= counts.totalImages - counts.uncompressedImages, "Cache contains fewer entries than processed images");
        assert(stats.compressedFilesCount === await plugin.moveService.getCompressedFilesCount(), "Movable output count is inconsistent");
        return { counts, cacheEntries: stats.cacheStats.total, movable: stats.compressedFilesCount };
      }
    },
    {
      id: "M12",
      name: "Mobile ribbon menu registration, actions, and visible touch targets are valid",
      async run({ plugin }) {
        const document = plugin.getActiveDocument();
        const ownerWindow = document.defaultView;
        assert(ownerWindow, "Active mobile document has no owning window");
        const ribbonCandidate = document.querySelector(".side-dock-ribbon-action.tiny-local-status-trigger");
        assert(ribbonCandidate?.instanceOf(ownerWindow.HTMLElement), "Mobile ribbon trigger is missing from the active document");
        assert(ribbonCandidate.isConnected && (ribbonCandidate.getAttribute("aria-label") || "").trim() !== "", "Mobile ribbon registration is not accessible");
        const triggerRect = ribbonCandidate.getBoundingClientRect();
        const triggerVisible = triggerRect.width > 0 || triggerRect.height > 0;
        if (triggerVisible) {
          assert(triggerRect.width >= 44 && triggerRect.height >= 44, "Mobile ribbon touch target is below 44 by 44 pixels");
        }
        const menuTarget = triggerVisible
          ? ribbonCandidate
          : {
              getBoundingClientRect: () => ({
                bottom: 54,
                height: 44,
                left: 10,
                top: 10,
                width: 44
              })
            } as unknown as EventTarget;
        const hadOwnCompressInNote = Object.prototype.hasOwnProperty.call(plugin, "compressImagesInNote");
        const hadOwnCompressAll = Object.prototype.hasOwnProperty.call(plugin, "compressAllImages");
        const originalCompressInNote = plugin["compressImagesInNote"];
        const originalCompressAll = plugin["compressAllImages"];
        let noteActions = 0;
        let allActions = 0;
        plugin.compressImagesInNote = async () => { noteActions++; };
        plugin.compressAllImages = async () => { allActions++; };
        try {
          await plugin.statusBarController.showMenu({ target: menuTarget, returnFocusTo: ribbonCandidate });
          await wait(plugin.getActiveWindow(), 100);
          const menu = document.querySelector(".tiny-local-status-menu");
          assert(menu?.instanceOf(ownerWindow.HTMLElement), "Mobile status menu did not open");
          assert(menu.getAttribute("role") === "menu" && (menu.getAttribute("aria-label") || "").trim() !== "", "Mobile status menu accessibility metadata is missing");
          const items = Array.from(menu.querySelectorAll(".tiny-local-status-menu-item"));
          assert(items.length >= 2, "Mobile status menu is missing primary actions");
          let minimumTouchHeight = Number.POSITIVE_INFINITY;
          let minimumTouchWidth = Number.POSITIVE_INFINITY;
          for (const item of items) {
            assert(item.instanceOf(ownerWindow.HTMLElement), "Mobile status menu item has an invalid owner");
            assert(item.getAttribute("role") === "menuitem" && (item.textContent || "").trim() !== "", "Mobile menu action lacks accessible text or role");
            const itemRect = item.getBoundingClientRect();
            minimumTouchHeight = Math.min(minimumTouchHeight, itemRect.height);
            minimumTouchWidth = Math.min(minimumTouchWidth, itemRect.width);
            assert(itemRect.height >= 44 && itemRect.width >= 44, "Mobile status menu touch target is below 44 by 44 pixels");
          }
          (items[0] as HTMLElement).click();
          await wait(plugin.getActiveWindow(), 50);
          assert(noteActions === 1, "Mobile ribbon note action did not dispatch exactly once");
          await plugin.statusBarController.showMenu({ target: menuTarget, returnFocusTo: ribbonCandidate });
          await wait(plugin.getActiveWindow(), 100);
          const reopenedItems = Array.from(document.querySelectorAll(".tiny-local-status-menu-item"));
          assert(reopenedItems[1]?.instanceOf(ownerWindow.HTMLElement), "Mobile ribbon all-images action is missing");
          reopenedItems[1].click();
          await wait(plugin.getActiveWindow(), 50);
          assert(allActions === 1, "Mobile ribbon all-images action did not dispatch exactly once");
          return { actionCount: items.length, minimumTouchHeight, minimumTouchWidth, dispatchedActions: 2, triggerVisible };
        } finally {
          if (hadOwnCompressInNote) {
            plugin.compressImagesInNote = originalCompressInNote;
          } else {
            Reflect.deleteProperty(plugin, "compressImagesInNote");
          }
          if (hadOwnCompressAll) {
            plugin.compressAllImages = originalCompressAll;
          } else {
            Reflect.deleteProperty(plugin, "compressAllImages");
          }
          plugin.statusBarController.closeMenu();
        }
      }
    }
  ];
}

function LocalImageCompressPluginLanguage(plugin: LocalImageCompressPlugin): string {
  return (plugin.constructor as typeof LocalImageCompressPlugin).currentLang;
}

const SKIPPED_CHECKS: Array<{ id: string; name: string; reason: string }> = [
  { id: "D01", name: "Electron reveal-path integration", reason: "runtime-reveal-path-unavailable" },
  { id: "D02", name: "Popout window ownership", reason: "popout-window-unavailable-on-mobile" },
  { id: "D03", name: "Desktop status bar contract", reason: "replaced-by-mobile-ribbon" },
  { id: "D04", name: "Absolute filesystem paths and dev:errors", reason: "desktop-transport-only" }
];

function declaredMatrixSkips(profile: MobileQaProfile): Array<{ id: string; name: string; reason: string }> {
  const checks: Array<{ id: string; name: string; reason: string }> = [];
  MATRIX_SCENARIOS.forEach((scenario, scenarioIndex) => {
    const matrixId = `MX${String(scenarioIndex + 1).padStart(2, "0")}`;
    const classification = scenario.classification[profile];
    if (classification !== "automated") {
      checks.push({
        id: matrixId,
        name: `${scenario.desktopCheck} (${classification} remainder)`,
        reason: scenario.skipReasons[profile] || `unimplemented-${classification}-remainder`
      });
    }
    scenario.manual.forEach((instruction, instructionIndex) => {
      checks.push({
        id: `${matrixId}-MAN${String(instructionIndex + 1).padStart(2, "0")}`,
        name: instruction,
        reason: "manual-device-check"
      });
    });
  });
  return checks;
}

function skipResult(id: string, name: string, skipReason: string): MobileQaCheckResult {
  const now = new Date().toISOString();
  return { id, name, status: "skip", skipReason, startedAt: now, finishedAt: now, durationMs: 0 };
}

async function runWithTimeout<T>(
  ownerWindow: Window,
  operation: Promise<T>,
  timeoutMs: number
): Promise<{ kind: "settled"; value: T } | { kind: "failed"; error: unknown } | { kind: "timeout"; settled: Promise<void> }> {
  let timer = 0;
  const tracked = operation.then(
    (value) => ({ kind: "settled" as const, value }),
    (error: unknown) => ({ kind: "failed" as const, error })
  );
  const timeout = new Promise<{ kind: "timeout"; settled: Promise<void> }>((resolve) => {
    timer = ownerWindow.setTimeout(() => {
      resolve({ kind: "timeout", settled: tracked.then(() => undefined) });
    }, timeoutMs);
  });
  const result = await Promise.race([tracked, timeout]);
  ownerWindow.clearTimeout(timer);
  return result;
}

async function waitForLateSettlement(ownerWindow: Window, settled: Promise<void>): Promise<boolean> {
  let timer = 0;
  const timeout = new Promise<false>((resolve) => {
    timer = ownerWindow.setTimeout(() => resolve(false), LATE_SETTLEMENT_TIMEOUT_MS);
  });
  const result = await Promise.race([settled.then(() => true), timeout]);
  ownerWindow.clearTimeout(timer);
  return result;
}

async function awaitBoundedSettlement<T>(
  ownerWindow: Window,
  operation: Promise<T>,
  timeoutMs: number
): Promise<{ value: T; timedOut: boolean }> {
  const outcome = await runWithTimeout(ownerWindow, operation, timeoutMs);
  if (outcome.kind === "settled") {
    return { value: outcome.value, timedOut: false };
  }
  if (outcome.kind === "failed") {
    throw outcome.error;
  }
  // Do not abandon the underlying operation after the grace window. Keeping this Promise
  // pending also keeps the controller's cross-reload carrier alive until mutation really stops.
  await waitForLateSettlement(ownerWindow, outcome.settled);
  return { value: await operation, timedOut: true };
}

export class MobileQaRunner {
  private readonly store: MobileQaSessionStore;

  constructor(private readonly options: MobileQaRunnerOptions) {
    this.store = new MobileQaSessionStore(options.plugin, options.ports, options.deviceOwnerId);
  }

  async run(): Promise<MobileQaReport> {
    const warnings: string[] = [];
    const stopRuntimeErrorCapture = this.captureRuntimeErrors(warnings);
    try {
      return await this.runCaptured(warnings, stopRuntimeErrorCapture);
    } finally {
      stopRuntimeErrorCapture();
    }
  }

  private async runCaptured(warnings: string[], stopRuntimeErrorCapture: () => void): Promise<MobileQaReport> {
    const startedAt = new Date();
    const suiteDeadline = startedAt.getTime() + SUITE_TIMEOUT_MS;
    const checks: MobileQaCheckResult[] = [];
    const declaredSkips = [...SKIPPED_CHECKS, ...declaredMatrixSkips(this.options.profile)];
    let prepared: PreparedMobileQaSession | null = null;
    let execution: ScenarioExecution = { checks, cancelled: false, cleanupAllowed: true };
    let cleanup: MobileQaCleanupResult = {
      status: "fail",
      settingsRestored: false,
      productCacheUntouched: false,
      sessionRootRemoved: false,
      retainedArtifacts: [],
      errors: ["Session setup did not complete"]
    };
    try {
      const prepareOperation = this.store.prepare(this.options.sessionId, this.options.profile);
      const prepareOutcome = await runWithTimeout(
        this.options.plugin.getActiveWindow(),
        prepareOperation,
        Math.max(1, suiteDeadline - Date.now())
      );
      if (prepareOutcome.kind === "failed") {
        throw prepareOutcome.error;
      }
      if (prepareOutcome.kind === "timeout") {
        const settledWithinGrace = await waitForLateSettlement(this.options.plugin.getActiveWindow(), prepareOutcome.settled);
        prepared = await prepareOperation;
        throw new Error(`Mobile QA session preparation exceeded the ${SUITE_TIMEOUT_MS} ms suite timeout and ${settledWithinGrace ? "then settled" : "settled after the extended safety wait"}`);
      }
      prepared = prepareOutcome.value;
      const rebuildOperation = this.options.plugin.rebuildImageIndex("mobile-qa-start");
      const rebuildOutcome = await runWithTimeout(
        this.options.plugin.getActiveWindow(),
        rebuildOperation,
        Math.max(1, suiteDeadline - Date.now())
      );
      if (rebuildOutcome.kind === "failed") {
        throw rebuildOutcome.error;
      }
      if (rebuildOutcome.kind === "timeout") {
        const settledWithinGrace = await waitForLateSettlement(this.options.plugin.getActiveWindow(), rebuildOutcome.settled);
        await rebuildOperation;
        execution.cleanupAllowed = true;
        throw new Error(`Mobile QA initial index rebuild exceeded the ${SUITE_TIMEOUT_MS} ms suite timeout and ${settledWithinGrace ? "then settled" : "settled after the extended safety wait"}`);
      }
      execution = await this.executeScenarios(prepared, suiteDeadline, declaredSkips.length);
      checks.push(...execution.checks);
      checks.push(...declaredSkips.map((entry) => skipResult(entry.id, entry.name, entry.reason)));
    } catch (error) {
      const now = new Date().toISOString();
      checks.push({
        id: "RUNNER",
        name: "Mobile QA runner setup and execution",
        status: "fail",
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
        error: sanitizeMobileQaMessage(error, prepared?.journal.sessionRoot || "")
      });
    } finally {
      if (prepared) {
        try {
          const cleanupOperation = this.store.restoreAndCleanup(prepared, execution.cleanupAllowed);
          const cleanupOutcome = await runWithTimeout(
            this.options.plugin.getActiveWindow(),
            cleanupOperation,
            CLEANUP_TIMEOUT_MS
          );
          if (cleanupOutcome.kind === "settled") {
            cleanup = cleanupOutcome.value;
          } else if (cleanupOutcome.kind === "failed") {
            cleanup = {
              status: "fail",
              settingsRestored: false,
              productCacheUntouched: false,
              sessionRootRemoved: false,
              retainedArtifacts: [prepared.journal.sessionRoot],
              errors: [sanitizeMobileQaMessage(cleanupOutcome.error, prepared.journal.sessionRoot)]
            };
          } else {
            const settled = await waitForLateSettlement(this.options.plugin.getActiveWindow(), cleanupOutcome.settled);
            if (settled) {
              cleanup = await cleanupOperation;
              const now = new Date().toISOString();
              checks.push({
                id: "CLEANUP",
                name: "Mobile QA bounded cleanup",
                status: "fail",
                startedAt: now,
                finishedAt: now,
                durationMs: CLEANUP_TIMEOUT_MS,
                error: `Cleanup exceeded ${CLEANUP_TIMEOUT_MS} ms and then settled`
              });
            } else {
              cleanup = await cleanupOperation;
              const now = new Date().toISOString();
              checks.push({
                id: "CLEANUP",
                name: "Mobile QA bounded cleanup",
                status: "fail",
                startedAt: now,
                finishedAt: now,
                durationMs: CLEANUP_TIMEOUT_MS + LATE_SETTLEMENT_TIMEOUT_MS,
                error: `Cleanup exceeded ${CLEANUP_TIMEOUT_MS} ms and settled after the extended safety wait`
              });
            }
          }
        } catch (error) {
          cleanup = {
            status: "fail",
            settingsRestored: false,
            productCacheUntouched: false,
            sessionRootRemoved: false,
            retainedArtifacts: [prepared.journal.sessionRoot],
            errors: [sanitizeMobileQaMessage(error, prepared.journal.sessionRoot)]
          };
        }
      }
    }

    if (!prepared) {
      throw new Error(checks[0]?.error || "Mobile QA session setup failed");
    }
    if (cleanup.status !== "pass") {
      stopRuntimeErrorCapture();
    }
    this.syncRuntimeErrorCheck(checks, warnings, startedAt);

    const finishedAt = new Date();
    const passed = checks.filter((check) => check.status === "pass").length;
    const failed = checks.filter((check) => check.status === "fail").length;
    const skipped = checks.filter((check) => check.status === "skip").length;
    const report: MobileQaReport = {
      schema: MOBILE_QA_REPORT_SCHEMA,
      pluginVersion: this.options.plugin.manifest.version,
      appVersion: apiVersion,
      platform: "mobile",
      profile: this.options.profile,
      buildFingerprint: __LIC_MOBILE_QA_FINGERPRINT__,
      deviceOwnerId: this.options.deviceOwnerId,
      vaultId: prepared.journal.vaultId,
      sessionId: this.options.sessionId,
      phase: "restoring",
      startedAt: startedAt.toISOString(),
      updatedAt: finishedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      capabilities: this.options.capabilities,
      checks,
      warnings,
      settingsSnapshotSha256: prepared.journal.settingsSnapshotSha256,
      cacheSnapshotSha256: prepared.journal.cacheSnapshot.sha256,
      cleanup,
      recovery: this.options.recovery,
      // JSON may exist before journal finalization; it must remain fail-closed until finalization succeeds.
      summary: { passed, failed, skipped, cancelled: execution.cancelled, success: false }
    };
    const reportWrite = await awaitBoundedSettlement(
      this.options.plugin.getActiveWindow(),
      this.store.writeReport(prepared.journal, report),
      REPORT_TIMEOUT_MS
    );
    if (reportWrite.timedOut) {
      const timeoutFinishedAt = new Date();
      checks.push({
        id: "REPORT",
        name: "Mobile QA bounded report write",
        status: "fail",
        startedAt: finishedAt.toISOString(),
        finishedAt: timeoutFinishedAt.toISOString(),
        durationMs: timeoutFinishedAt.getTime() - finishedAt.getTime(),
        error: `Report write exceeded ${REPORT_TIMEOUT_MS} ms and then settled`
      });
      report.updatedAt = timeoutFinishedAt.toISOString();
      report.finishedAt = timeoutFinishedAt.toISOString();
      report.durationMs = timeoutFinishedAt.getTime() - startedAt.getTime();
      report.summary = {
        passed: checks.filter((check) => check.status === "pass").length,
        failed: checks.filter((check) => check.status === "fail").length,
        skipped: checks.filter((check) => check.status === "skip").length,
        cancelled: execution.cancelled,
        success: false
      };
      const rewrite = await awaitBoundedSettlement(
        this.options.plugin.getActiveWindow(),
        this.store.writeReport(prepared.journal, report),
        REPORT_TIMEOUT_MS
      );
      if (rewrite.timedOut) {
        throw new Error(`Mobile QA corrected report write exceeded ${REPORT_TIMEOUT_MS} ms`);
      }
    }
    if (cleanup.status === "pass") {
      let finalizationError: unknown = null;
      let finalizationTimedOut = false;
      try {
        const finalize = await awaitBoundedSettlement(
          this.options.plugin.getActiveWindow(),
          this.store.finalizeAfterReport(prepared.journal),
          REPORT_TIMEOUT_MS
        );
        finalizationTimedOut = finalize.timedOut;
      } catch (error) {
        finalizationError = error;
      }
      if (finalizationError || finalizationTimedOut) {
        const finalizeFinishedAt = new Date();
        checks.push({
          id: "FINALIZE",
          name: "Mobile QA bounded state finalization",
          status: "fail",
          startedAt: report.finishedAt,
          finishedAt: finalizeFinishedAt.toISOString(),
          durationMs: finalizeFinishedAt.getTime() - new Date(report.finishedAt).getTime(),
          error: finalizationError
            ? sanitizeMobileQaMessage(finalizationError, prepared.journal.sessionRoot)
            : `State finalization exceeded ${REPORT_TIMEOUT_MS} ms and then settled`
        });
      }
      stopRuntimeErrorCapture();
      this.syncRuntimeErrorCheck(checks, warnings, startedAt);
      const finalFinishedAt = new Date();
      report.phase = finalizationError ? "restoring" : "completed";
      report.updatedAt = finalFinishedAt.toISOString();
      report.finishedAt = finalFinishedAt.toISOString();
      report.durationMs = finalFinishedAt.getTime() - startedAt.getTime();
      report.summary = {
        passed: checks.filter((check) => check.status === "pass").length,
        failed: checks.filter((check) => check.status === "fail").length,
        skipped: checks.filter((check) => check.status === "skip").length,
        cancelled: execution.cancelled,
        success: checks.every((check) => check.status !== "fail")
          && !execution.cancelled
          && !finalizationError
          && !finalizationTimedOut
          && warnings.length === 0
      };
      await awaitBoundedSettlement(
        this.options.plugin.getActiveWindow(),
        this.store.publishFinalReport(prepared.journal, report),
        REPORT_TIMEOUT_MS
      );
    }
    return report;
  }

  private syncRuntimeErrorCheck(checks: MobileQaCheckResult[], warnings: string[], startedAt: Date): void {
    if (warnings.length === 0) {
      return;
    }
    const now = new Date().toISOString();
    const existing = checks.find((check) => check.id === "RUNTIME-ERRORS");
    const error = `${warnings.length} scoped runtime error(s) captured; first: ${warnings[0] || "unknown"}`;
    if (existing) {
      existing.finishedAt = now;
      existing.durationMs = Date.now() - startedAt.getTime();
      existing.error = error;
      return;
    }
    checks.push({
      id: "RUNTIME-ERRORS",
      name: "Scoped uncaught errors and unhandled rejections",
      status: "fail",
      startedAt: startedAt.toISOString(),
      finishedAt: now,
      durationMs: Date.now() - startedAt.getTime(),
      error
    });
  }

  private captureRuntimeErrors(warnings: string[]): () => void {
    const ownerWindow = this.options.plugin.getActiveWindow();
    const sessionRoot = `${MOBILE_QA_SESSION_PREFIX}${this.options.sessionId}`;
    const record = (kind: string, value: unknown) => {
      const warning = `${kind}: ${sanitizeMobileQaMessage(value, sessionRoot)}`;
      if (warnings.length < 50 && !warnings.includes(warning)) {
        warnings.push(warning);
      }
    };
    const onError = (event: ErrorEvent) => record("uncaught-error", event.error || event.message);
    const onUnhandledRejection = (event: PromiseRejectionEvent) => record("unhandled-rejection", event.reason);
    ownerWindow.addEventListener("error", onError);
    ownerWindow.addEventListener("unhandledrejection", onUnhandledRejection);
    let stopped = false;
    return () => {
      if (stopped) {
        return;
      }
      stopped = true;
      ownerWindow.removeEventListener("error", onError);
      ownerWindow.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }

  private async executeScenarios(prepared: PreparedMobileQaSession, suiteDeadline: number, declaredSkipCount: number): Promise<ScenarioExecution> {
    const scenarios = [...(this.options.scenarios || scenarioDefinitions())];
    const results: MobileQaCheckResult[] = [];
    const fixtures = new Map<string, string>();
    const recordedBackupPaths = new Set<string>();
    const context: MobileQaScenarioContext = {
      app: this.options.plugin.app,
      plugin: this.options.plugin,
      ports: this.options.ports,
      profile: this.options.profile,
      capabilities: this.options.capabilities,
      sessionRoot: prepared.journal.sessionRoot,
      stateRoot: prepared.journal.stateRoot,
      fixtures,
      recordOwnedDirectory: async (directoryPath) => await this.store.recordOwnedDirectory(prepared.journal, directoryPath),
      recordOwnedFile: async (filePath, expectedSha256) => await this.store.recordOwnedFile(prepared.journal, filePath, expectedSha256)
    };
    let cancelled = false;
    let cleanupAllowed = true;
    for (let index = 0; index < scenarios.length; index++) {
      const scenario = scenarios[index];
      if (!scenario) {
        continue;
      }
      if (this.options.isCancellationRequested() || Date.now() >= suiteDeadline) {
        cancelled = this.options.isCancellationRequested();
        const reason = cancelled ? "cancelled-by-transport" : "suite-timeout";
        const remainingScenarios = scenarios.slice(index);
        const timedOut = !cancelled ? remainingScenarios.shift() : undefined;
        if (timedOut) {
          const now = new Date().toISOString();
          results.push({
            id: timedOut.id,
            name: timedOut.name,
            status: "fail",
            startedAt: now,
            finishedAt: now,
            durationMs: 0,
            error: `Mobile QA suite exceeded ${SUITE_TIMEOUT_MS} ms before this check started`
          });
        }
        for (const remaining of remainingScenarios) {
          results.push(skipResult(remaining.id, remaining.name, reason));
        }
        break;
      }
      const progress: MobileQaProgress = {
        schema: MOBILE_QA_PROGRESS_SCHEMA,
        sessionId: prepared.journal.sessionId,
        phase: "running",
        currentCheck: scenario.id,
        completed: index,
        total: scenarios.length + declaredSkipCount,
        updatedAt: new Date().toISOString()
      };
      await this.store.writeProgress(prepared.journal, progress);
      await this.options.onProgress(progress);
      const checkStartedAt = new Date();
      const configuredTimeoutMs = scenario.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;
      const remainingSuiteMs = Math.max(1, suiteDeadline - Date.now());
      const effectiveTimeoutMs = Math.min(configuredTimeoutMs, remainingSuiteMs);
      const outcome = await runWithTimeout(
        this.options.plugin.getActiveWindow(),
        runScenarioWithCacheBackupOwnership(scenario, context, recordedBackupPaths),
        effectiveTimeoutMs
      );
      const checkFinishedAt = new Date();
      if (outcome.kind === "settled") {
        results.push({
          id: scenario.id,
          name: scenario.name,
          status: "pass",
          startedAt: checkStartedAt.toISOString(),
          finishedAt: checkFinishedAt.toISOString(),
          durationMs: checkFinishedAt.getTime() - checkStartedAt.getTime(),
          ...(outcome.value ? { details: outcome.value } : {})
        });
        continue;
      }
      if (outcome.kind === "failed") {
        results.push({
          id: scenario.id,
          name: scenario.name,
          status: "fail",
          startedAt: checkStartedAt.toISOString(),
          finishedAt: checkFinishedAt.toISOString(),
          durationMs: checkFinishedAt.getTime() - checkStartedAt.getTime(),
          error: sanitizeMobileQaMessage(outcome.error, prepared.journal.sessionRoot)
        });
        continue;
      }
      const settledWithinGrace = await waitForLateSettlement(this.options.plugin.getActiveWindow(), outcome.settled);
      await outcome.settled;
      cleanupAllowed = true;
      results.push({
        id: scenario.id,
        name: scenario.name,
        status: "fail",
        startedAt: checkStartedAt.toISOString(),
        finishedAt: checkFinishedAt.toISOString(),
        durationMs: checkFinishedAt.getTime() - checkStartedAt.getTime(),
        error: settledWithinGrace
          ? `Check timed out after ${effectiveTimeoutMs} ms and then settled`
          : `Check timed out after ${effectiveTimeoutMs} ms and settled after the extended safety wait`
      });
      for (const remaining of scenarios.slice(index + 1)) {
        results.push(skipResult(remaining.id, remaining.name, "suite-stopped-after-timeout"));
      }
      break;
    }
    cancelled = cancelled || this.options.isCancellationRequested();
    const scopeResult = results.find((result) => result.id === "M04");
    if (prepared.runtime.blockedCompressionInputs.length > 0 || prepared.runtime.blockedCompressionOutputs.length > 0) {
      if (scopeResult) {
        scopeResult.status = "fail";
        scopeResult.error = `Compression scope guard blocked ${prepared.runtime.blockedCompressionInputs.length} input(s) and ${prepared.runtime.blockedCompressionOutputs.length} output(s)`;
      }
    } else if (scopeResult) {
      scopeResult.details = {
        ...scopeResult.details,
        observedCompressionInputs: prepared.runtime.observedCompressionInputs.length,
        observedCompressionOutputs: prepared.runtime.observedCompressionOutputs.length,
        blockedCompressionInputs: 0,
        blockedCompressionOutputs: 0
      };
    }
    const total = scenarios.length + declaredSkipCount;
    const finalProgress: MobileQaProgress = {
      schema: MOBILE_QA_PROGRESS_SCHEMA,
      sessionId: prepared.journal.sessionId,
      phase: "restoring",
      currentCheck: null,
      completed: total,
      total,
      updatedAt: new Date().toISOString()
    };
    await this.store.writeProgress(prepared.journal, finalProgress);
    await this.options.onProgress(finalProgress);
    return { checks: results, cancelled, cleanupAllowed };
  }

}

export function detectMobileQaCapabilities(plugin: LocalImageCompressPlugin, ports: PlatformPorts): MobileQaCapabilities {
  const document = plugin.getActiveDocument();
  const mobileRibbon = Array.from(document.querySelectorAll(".side-dock-ribbon-action.tiny-local-status-trigger"))
    .some((candidate) => candidate.isConnected);
  return {
    mobileFs: ports.fs.sync === null,
    atomicText: ports.fs.processTextAtomically !== null,
    revealPath: ports.runtime.revealPath !== null,
    mobileRibbon,
    touchDom: document.defaultView !== null,
    popoutWindow: false,
    desktopStatusBar: false
  };
}
