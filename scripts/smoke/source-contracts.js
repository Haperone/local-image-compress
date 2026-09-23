"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const assert = require("node:assert/strict");

function runSourceContractChecks({ root, repositoryRoot, artifact, isDevLayout }) {
  const sourceTsRoot = path.join(root, "src-ts");
  const source = fs.readFileSync(artifact, "utf8");
  const runRuntimeQaWrapperSource = fs.readFileSync(path.join(root, "scripts", "run-runtime-qa.js"), "utf8");
  const runtimeQaOwnershipSource = fs.readFileSync(path.join(root, "scripts", "runtime-qa-ownership.js"), "utf8");
  const devVaultSource = isDevLayout ? fs.readFileSync(path.join(repositoryRoot, "scripts", "dev-vault.mjs"), "utf8") : "";

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
    source.includes("await this.getCompressedMoveCandidates()"),
    "TypeScript artifact does not merge current-folder and immutable pending compression artifacts"
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
    runRuntimeQaWrapperSource.includes("OBSIDIAN_CLI_TIMEOUT_MS")
      && runRuntimeQaWrapperSource.includes("Number.isInteger(timeoutMs)")
      && /spawnSync\(cliPath, cliArgs,[\s\S]*timeout: timeoutMs/.test(runRuntimeQaWrapperSource),
    "Runtime QA wrapper does not require a positive-integer Obsidian CLI timeout"
  );
  assert(
    runRuntimeQaWrapperSource.includes("cleanupRuntimeQaVaultArtifacts")
      && runRuntimeQaWrapperSource.includes("cleanupRuntimeQaOwnershipLedgers")
      && runRuntimeQaWrapperSource.includes("__tinyLocalRuntimeQaOwnershipModulePath")
      && runRuntimeQaWrapperSource.includes("runtimeQaMayStillBeActive")
      && runRuntimeQaWrapperSource.includes("reserveRuntimeQa")
      && runRuntimeQaWrapperSource.includes("releaseUnusedRuntimeQaReservation")
      && runRuntimeQaWrapperSource.includes('"method=Page.bringToFront"')
      && runRuntimeQaWrapperSource.indexOf("closeSettingsBeforeRuntimeQa();", runRuntimeQaWrapperSource.indexOf("async function main"))
        < runRuntimeQaWrapperSource.indexOf("if (!skipReload)")
      && !runRuntimeQaWrapperSource.includes("QA_ARTIFACT_PARENTS")
      && !runRuntimeQaWrapperSource.includes("removePathInsideVault"),
    "Runtime QA wrapper does not serialize renderer runs or fence wrapper cleanup from a live eval"
  );
  assert(
    runtimeQaOwnershipSource.includes("RUNTIME_QA_OWNERSHIP_SCHEMA")
      && runtimeQaOwnershipSource.includes("cleanupRuntimeQaOwnershipLedger")
      && runtimeQaOwnershipSource.includes("RuntimeQaOwnershipLedger")
      && runtimeQaOwnershipSource.includes("Runtime QA cleanup retained an unknown file")
      && runtimeQaOwnershipSource.includes("Owned runtime QA file changed before cleanup")
      && runtimeQaOwnershipSource.includes("getMovedOutputPath")
      && runtimeQaOwnershipSource.includes("recordCacheLeaseArtifactsSync")
      && runtimeQaOwnershipSource.includes("Runtime QA cache directory contains an unrecognized lease artifact")
      && runtimeQaOwnershipSource.includes("stat.ino !== linkedStats[0].ino")
      && runtimeQaOwnershipSource.includes("linkedStats[0].nlink < 3n")
      && runtimeQaOwnershipSource.includes("ownership.pending-")
      && runtimeQaOwnershipSource.includes("payload.revision")
      && runtimeQaOwnershipSource.includes("multiple physical files for revision")
      && runtimeQaOwnershipSource.includes("multiple physical representations of an owned file")
      && runtimeQaOwnershipSource.includes("fs.rmdirSync(directoryPath)")
      && !runtimeQaOwnershipSource.includes("fs.rmSync(")
      && !runtimeQaOwnershipSource.includes("fs.rm(")
      && !runtimeQaOwnershipSource.includes("startsWith(QA_ROOT_PREFIX)"),
    "Runtime QA ownership cleanup must prove exact file identities before non-recursive removal"
  );

  if (isDevLayout) {
    assert(
      devVaultSource.includes("OBSIDIAN_CLI_TIMEOUT_MS")
        && devVaultSource.includes("Number.isInteger(timeoutMs)")
        && /spawnSync\(cliPath, cliArgs,[\s\S]*timeout: timeoutMs/.test(devVaultSource),
      "DEV vault helper does not require a positive-integer Obsidian CLI timeout"
    );
  }

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
  const memoryBudgetLimiterSource = fs.readFileSync(path.join(sourceTsRoot, "memory-budget-limiter.ts"), "utf8");
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
  const mobileQaSources = Object.fromEntries(
    fs.readdirSync(path.join(sourceTsRoot, "qa"))
      .filter((fileName) => fileName.endsWith(".ts"))
      .sort()
      .map((fileName) => [fileName, fs.readFileSync(path.join(sourceTsRoot, "qa", fileName), "utf8")])
  );
  const portableMobileQaSource = Object.values(mobileQaSources).join("\n");
  const setupStatusBarSource = pluginSource.slice(pluginSource.indexOf("\n  setupStatusBar()"), pluginSource.indexOf("\n  getMonotonicTime()"));
  const settingsSource = fs.readFileSync(path.join(sourceTsRoot, "settings.ts"), "utf8");
  const utilsSource = fs.readFileSync(path.join(sourceTsRoot, "utils.ts"), "utf8");
  const moveServiceSource = fs.readFileSync(path.join(sourceTsRoot, "move-service.ts"), "utf8");
  const i18nSource = fs.readFileSync(path.join(sourceTsRoot, "i18n.ts"), "utf8");
  const concurrencyLimiterSource = fs.readFileSync(path.join(sourceTsRoot, "concurrency-limiter.ts"), "utf8");
  const backgroundCompressionServiceSource = fs.readFileSync(path.join(sourceTsRoot, "background-compression-service.ts"), "utf8");
  const statusBarControllerSource = fs.readFileSync(path.join(sourceTsRoot, "status-bar-controller.ts"), "utf8");
  const stylesSource = fs.readFileSync(path.join(repositoryRoot, "styles.css"), "utf8");
  const runtimeQaSource = fs.readFileSync(path.join(root, "scripts", "runtime-qa.js"), "utf8");
  const runtimeQaCliSource = fs.readFileSync(path.join(root, "scripts", "run-runtime-qa.js"), "utf8");
  assert(
    runtimeQaSource.includes("RuntimeQaOwnershipLedger")
      && runtimeQaSource.includes('joinVault(p.getPluginDirectory(), "qa-backups", "runtime", qaSessionId)')
      && runtimeQaSource.includes("originalFilesBackups: joinVault(qaBackupStorageRoot")
      && runtimeQaSource.includes("const originalCacheBackupsDir = p.cache.cacheBackupsDir")
      && runtimeQaSource.includes("const originalCacheFile = p.cache.cacheFile")
      && runtimeQaSource.includes('p.cache.cacheFile = joinVault(qaStateRoot, "cache", "tinyLocal-cache.json")')
      && runtimeQaSource.includes('p.cache.cacheBackupsDir = joinVault(qaBackupStorageRoot, "backups", "cache")')
      && runtimeQaSource.includes("Runtime QA changed the product cache while the isolated cache was active")
      && runtimeQaSource.includes("Runtime QA isolated cache did not settle before cleanup")
      && runtimeQaSource.includes("Runtime QA blocked ${action} outside ${qaRoot}")
      && runtimeQaSource.includes("const isQaOwnedRecoveryJournal = async")
      && runtimeQaSource.includes('normalized.startsWith(".local-image-compress/recovery/")')
      && runtimeQaSource.includes("journal?.rollbackPath === null")
      && runtimeQaSource.includes('typeof journal?.rollbackPath === "string" && isQaOwnedArtifactPath(journal.rollbackPath)')
      && runtimeQaSource.includes("adapter.trashLocal = async")
      && runtimeQaSource.includes("electron.shell.trashItem = async")
      && !runtimeQaSource.includes("await p.cache.saveCache({ mergeDiskEntries: false, authoritative: true });\n    await p.rebuildImageIndex?.(\"runtime-qa-restore\")")
      && runtimeQaSource.includes("p.cache.cacheBackupsDir = originalCacheBackupsDir")
      && runtimeQaSource.includes("Runtime QA attempted ${action} outside ${qaRoot}")
      && runtimeQaSource.includes("originalRunCompressionBatch")
      && runtimeQaSource.includes("assertQaRuntimeScope(`before command ${commandId}`)")
      && runtimeQaSource.includes('Symbol.for("local-image-compress.runtime-qa-active-v1")')
      && runtimeQaSource.includes("__tinyLocalRuntimeQaLaunchToken")
      && runtimeQaSource.includes("delete require.cache[require.resolve(ownershipModulePath)]")
      && runtimeQaSource.includes("ownership.recordFileWithExpectedSha256Sync")
      && !runtimeQaSource.includes("ownership.recordFileSync")
      && runtimeQaSource.includes("ownership.recordCacheLeaseArtifactsSync")
      && runtimeQaSource.includes('patchMethod(p.cache.backupStore, "getCacheBackupPath"')
      && runtimeQaSource.includes("Runtime QA fixture escaped its visible root after Vault automation")
      && runtimeQaSource.includes("Move installed bytes that differ from the exact registered compressed output")
      && runtimeQaSource.includes("Auto-move installed bytes that differ from its exact committed compressed output")
      && runtimeQaSource.includes("Runtime QA refused to adopt an unproven original-backup file")
      && runtimeQaSource.includes("ownership.recordFileWithExpectedSha256Sync(file.path, file.expectedSha256)")
      && !runtimeQaSource.includes("recordOwnedFilesRecursive")
      && runtimeQaSource.includes("ownership.cleanup()")
      && !runtimeQaSource.includes("staleQaArtifactParents")
      && !runtimeQaSource.includes("entry.name.startsWith(qaStateMarker)")
      && (runtimeQaSource.match(/finally \{\n        await restoreQaDefaults\(\);/g) || []).length >= 5,
    "Runtime QA no longer records exact QA ownership, isolates hidden control state, or fails closed outside its QA roots"
  );
  const pluginGuardSource = fs.readFileSync(path.join(sourceTsRoot, "plugin-guard-service.ts"), "utf8");
  const savingsCalculatorSource = fs.readFileSync(path.join(sourceTsRoot, "savings-calculator.ts"), "utf8");
  const commandRegistrySource = fs.readFileSync(path.join(sourceTsRoot, "services", "command-registry.ts"), "utf8");
  const eventRouterSource = fs.readFileSync(path.join(sourceTsRoot, "services", "event-router.ts"), "utf8");
  const migrationRunnerSource = fs.readFileSync(path.join(sourceTsRoot, "services", "migration-runner.ts"), "utf8");
  const folderSelectorModalSource = fs.readFileSync(path.join(sourceTsRoot, "services", "folder-selector-modal.ts"), "utf8");
  const newFileQueueSource = fs.readFileSync(path.join(sourceTsRoot, "services", "new-file-queue.ts"), "utf8");
  const cacheBackupsViewSource = fs.readFileSync(path.join(sourceTsRoot, "services", "cache-backups-view.ts"), "utf8");
  const cacheBackupStoreSource = fs.readFileSync(path.join(sourceTsRoot, "services", "cache-backup-store.ts"), "utf8");
  const contextMenusSource = fs.readFileSync(path.join(sourceTsRoot, "services", "context-menus.ts"), "utf8");
  const batchCompressionServiceSource = fs.readFileSync(path.join(sourceTsRoot, "services", "batch-compression-service.ts"), "utf8");
  const moveBackupPreflightSource = fs.readFileSync(path.join(sourceTsRoot, "services", "move-backup-preflight.ts"), "utf8");
  const moveModalsSource = fs.readFileSync(path.join(sourceTsRoot, "services", "move-modals.ts"), "utf8");
  const cacheCompactionSource = fs.readFileSync(path.join(sourceTsRoot, "services", "cache-compaction.ts"), "utf8");
  const platformIndexSource = fs.readFileSync(path.join(sourceTsRoot, "platform", "index.ts"), "utf8");
  const platformPortsSource = fs.readFileSync(path.join(sourceTsRoot, "platform", "ports.ts"), "utf8");
  const platformDesktopSource = fs.readFileSync(path.join(sourceTsRoot, "platform", "desktop.ts"), "utf8");
  const platformMobileSource = fs.readFileSync(path.join(sourceTsRoot, "platform", "mobile.ts"), "utf8");
  const localesIndexSource = fs.readFileSync(path.join(sourceTsRoot, "locales", "index.ts"), "utf8");
  const englishLocale = JSON.parse(fs.readFileSync(path.join(sourceTsRoot, "locales", "en.json"), "utf8"));
  const i18nCatalogSource = fs.readdirSync(path.join(sourceTsRoot, "locales"))
    .filter((fileName) => fileName.endsWith(".json"))
    .sort()
    .map((fileName) => fs.readFileSync(path.join(sourceTsRoot, "locales", fileName), "utf8"))
    .join("\n");
  const serviceSources = [
    "background-compression-service.ts",
    "image-scanner.ts",
    "move-service.ts",
    "plugin-guard-service.ts",
    "savings-calculator.ts",
    "settings-tab.ts",
    "status-bar-controller.ts"
  ].map((fileName) => fs.readFileSync(path.join(sourceTsRoot, fileName), "utf8"));
  const readmeSource = fs.readFileSync(path.join(repositoryRoot, "README.md"), "utf8");
  const mobileQaGuideSource = fs.readFileSync(path.join(repositoryRoot, "MOBILE_QA.md"), "utf8");
  const readmeRuSource = fs.readFileSync(path.join(repositoryRoot, "assets", "README.ru.md"), "utf8");
  const releasePolicySource = fs.readFileSync(path.join(repositoryRoot, "RELEASE_POLICY.md"), "utf8");
  const releaseReadinessPath = path.join(repositoryRoot, "RELEASE_READINESS.md");
  const obsidianReleaseAuditPath = path.join(repositoryRoot, "OBSIDIAN_RELEASE_AUDIT.md");
  const obsidianBoundaryAuditPath = path.join(repositoryRoot, "OBSIDIAN_API_BOUNDARIES.md");
  if (isDevLayout) {
    for (const internalAuditPath of [releaseReadinessPath, obsidianReleaseAuditPath, obsidianBoundaryAuditPath]) {
      assert(fs.existsSync(internalAuditPath), `DEV smoke requires ${path.basename(internalAuditPath)}`);
    }
  }
  const releaseReadinessSource = fs.existsSync(releaseReadinessPath) ? fs.readFileSync(releaseReadinessPath, "utf8") : null;
  const obsidianReleaseAuditSource = fs.existsSync(obsidianReleaseAuditPath) ? fs.readFileSync(obsidianReleaseAuditPath, "utf8") : null;
  const obsidianBoundaryAuditSource = fs.existsSync(obsidianBoundaryAuditPath) ? fs.readFileSync(obsidianBoundaryAuditPath, "utf8") : null;
  const packageSource = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const rootPackageSource = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"));
  const manifestSource = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "manifest.json"), "utf8"));
  const versionsSource = JSON.parse(fs.readFileSync(path.join(repositoryRoot, "versions.json"), "utf8"));
  const tsconfigSource = JSON.parse(fs.readFileSync(path.join(root, "tsconfig.json"), "utf8"));
  const releaseWorkflowSource = fs.readFileSync(path.join(repositoryRoot, ".github", "workflows", "release.yml"), "utf8");
  const licenseSource = fs.readFileSync(path.join(repositoryRoot, "LICENSE"), "utf8");
  const gitignoreSource = fs.readFileSync(path.join(repositoryRoot, ".gitignore"), "utf8");
  const bugResearchPath = path.join(repositoryRoot, "BUG_RESEARCH_FINDINGS.txt");
  const validateManifestSource = fs.readFileSync(path.join(root, "scripts", "validate-manifest.js"), "utf8");
  const androidMobileQaSource = fs.readFileSync(path.join(root, "scripts", "android-mobile-qa.js"), "utf8");
  const androidMobileQaTestSource = fs.readFileSync(path.join(root, "scripts", "android-mobile-qa.test.js"), "utf8");
  const buildMobileQaSource = fs.readFileSync(path.join(root, "scripts", "build-mobile-qa.js"), "utf8");
  const buildRootSource = fs.readFileSync(path.join(root, "scripts", "build-root.js"), "utf8");
  const buildTsSource = fs.readFileSync(path.join(root, "scripts", "build-ts.js"), "utf8");
  const runEsbuildCliSource = fs.readFileSync(path.join(root, "scripts", "run-esbuild-cli.js"), "utf8");
  const mobileQaBundleContractSource = fs.readFileSync(path.join(root, "scripts", "mobile-qa-bundle-contract.js"), "utf8");
  const mobileQaFingerprintSource = fs.readFileSync(path.join(root, "scripts", "mobile-qa-fingerprint.js"), "utf8");
  const prepareReleaseSource = fs.readFileSync(path.join(root, "scripts", "prepare-release.js"), "utf8");
  const prepareReleaseNotesSource = fs.readFileSync(path.join(root, "scripts", "prepare-release-notes.js"), "utf8");
  const verifyReleaseSource = fs.readFileSync(path.join(root, "scripts", "verify-release.js"), "utf8");
  const classWideGatesSource = fs.readFileSync(path.join(root, "scripts", "class-wide-gates.js"), "utf8");
  const auditPolicySource = fs.readFileSync(path.join(root, "scripts", "audit-policy.js"), "utf8");
  const lintObsidianSource = fs.readFileSync(path.join(root, "scripts", "lint-obsidian.js"), "utf8");
  const eslintConfigSource = fs.readFileSync(path.join(root, "eslint.config.mjs"), "utf8");
  const eslintObsidianConfigSource = fs.readFileSync(path.join(root, "eslint.obsidian.config.mjs"), "utf8");
  const validateLicenseSource = fs.readFileSync(path.join(root, "scripts", "validate-license.js"), "utf8");
  const combinedTsSource = [
    backupStorageSource,
    backgroundCompressionServiceSource,
    commandRegistrySource,
    eventRouterSource,
    migrationRunnerSource,
    folderSelectorModalSource,
    newFileQueueSource,
    cacheBackupsViewSource,
    cacheBackupStoreSource,
    contextMenusSource,
    batchCompressionServiceSource,
    moveBackupPreflightSource,
    moveModalsSource,
    cacheCompactionSource,
    cacheFileNamesSource,
    cacheSource,
    compressionWorkerSource,
    imageIndexSource,
    compressorSource,
    concurrencyLimiterSource,
    i18nSource,
    localesIndexSource,
    imageScannerSource,
    moveServiceSource,
    memoryBudgetLimiterSource,
    platformIndexSource,
    platformPortsSource,
    platformDesktopSource,
    platformMobileSource,
    pluginGuardSource,
    pluginSource,
    portableMobileQaSource,
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
  for (const forbiddenMobileQaToken of [
    'from "node:',
    "from 'node:",
    "require(",
    "process.",
    "Buffer.",
    'from "electron"',
    "from 'electron'",
    'from "fs"',
    "from 'fs'",
    'from "path"',
    "from 'path'",
    'from "crypto"',
    "from 'crypto'",
    ".vault.adapter"
  ]) {
    assert(!portableMobileQaSource.includes(forbiddenMobileQaToken), `Mobile QA runner is not portable: ${forbiddenMobileQaToken}`);
  }
  assert(!/[`"'][A-Za-z]:[\\/]/.test(portableMobileQaSource), "Mobile QA runner contains an absolute Windows path literal");
  assert(!/[`"']\\\\[^\\]/.test(portableMobileQaSource), "Mobile QA runner contains an absolute UNC path literal");
  assert(
    pluginSource.includes("if (__LIC_MOBILE_QA__)")
      && pluginSource.includes('import("./qa/mobile-controller")')
      && mobileQaSources["contracts.ts"].includes("run-mobile-runtime-qa")
      && mobileQaSources["mobile-controller.ts"].includes("__LIC_MOBILE_QA_RUN__"),
    "Mobile QA command and bridge are not isolated behind the compile-time QA profile"
  );
  assert(
    mobileQaSources["contracts.ts"].includes("local-image-compress-mobile-qa-report/v1")
      && mobileQaSources["contracts.ts"].includes(".local-image-compress-qa/qa-vault-marker.json")
      && mobileQaSources["contracts.ts"].includes("Local Image Compress QA/reports")
      && mobileQaSources["session.ts"].includes("productCacheUntouched")
      && mobileQaSources["session.ts"].includes("removeOwnedSessionRoot")
      && mobileQaSources["session.ts"].includes("hasExactDerivedPaths")
      && mobileQaSources["session.ts"].includes("Refusing cleanup because the mobile QA owner marker does not match")
      && mobileQaSources["session.ts"].includes("Refusing cleanup outside the exact mobile QA state path")
      && mobileQaSources["session.ts"].includes("requires persistent local storage for crash recovery")
      && mobileQaSources["session.ts"].includes("waitForSettingsPersistenceIdle")
      && mobileQaSources["session.ts"].includes("blockedCompressionInputs")
      && mobileQaSources["session.ts"].includes("newFileCompressionTimers.size === 0")
      && mobileQaSources["session.ts"].includes("processTextAtomically(journalPath")
      && mobileQaSources["contracts.ts"].includes('cacheIsolation: "hidden-session-state"')
      && mobileQaSources["contracts.ts"].includes('MOBILE_QA_STATE_SUBPATH = "qa-backups/mobile"')
      && mobileQaSources["contracts.ts"].includes("getMobileQaStateRoot")
      && mobileQaSources["session.ts"].includes("recordOwnedFile")
      && mobileQaSources["session.ts"].includes("Mobile QA cleanup retained an unknown file")
      && mobileQaSources["session.ts"].includes("removeFileIfUnchanged")
      && mobileQaSources["session.ts"].includes("removeDir(directoryPath, { recursive: false, force: false })")
      && !mobileQaSources["session.ts"].includes("this.plugin.app.vault.delete(sessionFolder, true)")
      && !mobileQaSources["contracts.ts"].includes("settingsSnapshot: LocalImageCompressSettings")
      && !mobileQaSources["contracts.ts"].includes("rawText: string")
      && mobileQaSources["mobile-controller.ts"].includes('record.report.cleanup.status !== "pass"')
      && mobileQaSources["mobile-controller.ts"].includes('report.appVersion !== "unknown"')
      && mobileQaSources["mobile-controller.ts"].includes("previous plugin instance is still settling")
      && mobileQaSources["mobile-controller.ts"].includes("this.recovery = await store.recoverOwnedSessions(profile)")
      && mobileQaSources["mobile-runner.ts"].includes("checks.push(...execution.checks)")
      && mobileQaSources["mobile-runner.ts"].includes("declaredMatrixSkips")
      && mobileQaSources["mobile-runner.ts"].includes("Auto-move installed bytes differ from the exact committed compressed output")
      && mobileQaSources["mobile-runner.ts"].includes("verifyMobileQaBackupTree")
      && mobileQaSources["mobile-runner.ts"].includes("Mobile QA refused to adopt an unproven original-backup file")
      && mobileQaSources["mobile-runner.ts"].includes("Mobile QA file tree contains a symbolic link")
      && mobileQaSources["mobile-runner.ts"].includes("captureRuntimeErrors"),
    "Mobile QA report, marker, ownership, cache isolation, or result aggregation contract regressed"
  );
  assert(
    mobileQaSources["mobile-runner.ts"].includes("apiVersion")
      && !mobileQaSources["mobile-runner.ts"].includes("getVersion"),
    "Mobile QA reports must use Obsidian's public apiVersion export"
  );
  for (let scenario = 1; scenario <= 12; scenario += 1) {
    assert(mobileQaSources["mobile-runner.ts"].includes(`M${String(scenario).padStart(2, "0")}`), `Mobile QA runner is missing M${String(scenario).padStart(2, "0")}`);
  }
  assert(!platformDesktopSource.includes("adapter?.basePath") && !platformDesktopSource.includes("adapter?.path?.absolute") && platformDesktopSource.includes("getVaultBasePathFromAdapter(adapter: unknown"), "Vault base-path helper still reads undocumented adapter fields");
  assert((combinedTsSource.match(/\.vault\.get(?:Files|AllLoadedFiles)\(\)/g) || []).length === 8, "Full-vault iteration count changed; classify each new or removed scan in OBSIDIAN_API_BOUNDARIES.md");
  if (obsidianBoundaryAuditSource) {
    assert(obsidianBoundaryAuditSource.includes("Intentional Vault Iteration") && obsidianBoundaryAuditSource.includes("`DeferredViews` is not applicable") && obsidianBoundaryAuditSource.includes("Plugin registry enable/disable"), "Obsidian API boundary audit is missing lifecycle/private/full-scan classification");
  }
  assert(!compressorSource.includes("openSync(") && !compressorSource.includes("readSync("), "Compressor still performs dead binary header reads before compression");
  assert(
    !combinedTsSource.includes("slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer")
      && !combinedTsSource.includes("slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer")
      && (combinedTsSource.match(/const output = new ArrayBuffer\([^)]*\.byteLength\);/g) || []).length >= 3,
    "Transfer helpers must copy partial views into owned ArrayBuffers without unsafe assertions"
  );
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
  assert(!compressorSource.includes("withWasmTimeout"), "Compressor still advertises a fake cancellable WASM timeout");
  assert(!compressorSource.includes("@jsquash/jpeg/decode.js") && !compressorSource.includes("@jsquash/png/decode.js"), "Compressor still imports codec wrappers on the main thread");
  assert(compressorSource.includes("WorkerPool") || compressorSource.includes("workerPool"), "Compressor is missing worker pool integration");
  assert(/destroy\(\)\s*\{[\s\S]{0,300}this\.memoryLimiter\.destroy\(error\);[\s\S]{0,100}this\.workerPool\.destroy\(error\);/.test(compressorSource), "Compressor destroy no longer tears down memory and worker queues synchronously");
  assert(
    compressorSource.includes("estimateCompressionMemoryBytes")
      && compressorSource.includes("this.memoryLimiter.reserve(this.maxInputBytes)")
      && compressorSource.includes("memoryReservation.current.resize(Math.max(")
      && compressorSource.includes("copyAdmissionWeight")
      && compressorSource.includes("this.readAdmissionLimiter.run(this.maxInputBytes")
      && settingsSource.includes("INTERNAL_COMPRESSION_MEMORY_BUDGET_MB")
      && settingsSource.includes("MOBILE_COMPRESSION_MEMORY_BUDGET_MB")
      && memoryBudgetLimiterSource.includes("this.activeWeight + waiter.weight > this.budget"),
    "Compression reads and worker jobs are not covered by the shared weighted memory budget"
  );
  assert(
    compressionWorkerSource.includes("new Uint8Array(input.buffer, input.byteOffset, input.byteLength)")
      && !compressionWorkerSource.includes("copy.set(input)"),
    "Compression worker still duplicates the decoded RGBA buffer before imagequant"
  );
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
  assert(compressorSource.includes("this.fsPort.writeBinary") && compressorSource.includes("this.fsPort.replaceFile") && !compressorSource.includes("adapter.writeBinary"), "Compressor output does not stay behind the explicit filesystem replacement contract");
  assert(compressorSource.includes("compress.error.notSmaller") && !compressorSource.includes(">= ${originalSize}"), "Compressor not-smaller error still exposes exact byte sizes");
  const failActiveWorkerStateSource = workerSlotSource.match(/failActiveWorkerState\([\s\S]*?\n  private terminateWorker\(\)/)?.[0] || "";
  assert(failActiveWorkerStateSource && !failActiveWorkerStateSource.includes("initializeWasmModules("), "failActiveWorkerState should mark lazy recreate instead of eagerly initializing a worker");
  assert(compressionWorkerSource.includes("process() consumes the wrapper") && !compressionWorkerSource.includes("image?.free?.()"), "Compression worker does not honor Imagequant.process() wrapper ownership");
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
  assert(settingsSource.includes('"cacheRetentionMonths"') && settingsSource.includes('"autoCleanupGhostsOnStart"'), "Settings normalization does not silently drop removed cache-maintenance fields");
  assert(!settingsTabSource.includes("cacheRetentionMonths") && !settingsTabSource.includes("autoCleanupGhostsOnStart"), "Removed cache-maintenance controls remain in settings UI");
  assert(compressorSource.includes("applySettings(settings") && pluginSource.includes("this.compressor?.applySettings?.(this.settings)"), "Compressor runtime limits are not applied from normalized settings");
  assert(compressorSource.includes("app: App | null") && !compressorSource.includes("app: any | null"), "Compressor app reference is still typed as any");
  assert(!settingsSource.includes("integer || 4"), "Worker pool sizing still contains a dead integer fallback");
  assert(cacheSource.includes("flushPendingCacheSaveSync"), "Cache is missing synchronous unload flush");
  assert(cacheSource.includes("syncFlushToken"), "Cache sync flush does not guard against late async write commits");
  assert(cacheSource.includes("acquireCacheWriteLock") && cacheSource.includes("buildMergedCachePayload") && cacheSource.includes("pendingSaveMergeDiskEntries"), "Cache writes are missing multi-instance lease/merge coordination");
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
  assert(cacheBackupStoreSource.includes("getCacheBackupPath") && cacheBackupStoreSource.includes("getCacheBackupCleanupDirs") && !cacheBackupStoreSource.includes("slice(0, 19)") && !cacheBackupStoreSource.includes("@__PURE__"), "Cache backup naming/cleanup still uses truncated timestamps, duplicate cleanup plumbing, or obscure purity markers");
  assert(cacheBackupStoreSource.includes("retainedFilesStatBatchSize") && !cacheBackupStoreSource.includes(".slice(0, 1000)"), "Cache retained-file cleanup still silently ignores retained files beyond the first 1000");
  assert(!cacheSource.includes("crypto.randomBytes(4)") && !cacheBackupStoreSource.includes("crypto.randomBytes(4)"), "Cache backups still use a 32-bit random suffix");
  assert(cacheBackupStoreSource.includes("realpath(backupFile)") && cacheBackupStoreSource.includes("validateBackupPathForRestore"), "Cache restore does not validate real backup paths before copying");
  // Lesson 52 lift: Cache keeps thin delegators so external callers and instance-level mocks keep working.
  assert(cacheSource.includes("this.backupStore.createBackup()") && cacheSource.includes("this.backupStore.restoreFromBackup(backupFileName)") && cacheBackupStoreSource.includes("createVerifiedRestoreSafetyBackup"), "Cache backup delegation or mandatory restore safety-backup flow is missing");
  assert(cacheSource.includes("clonePlainRecord"), "Cache normalization does not deep-clone unknown top-level fields");
  assert(typesSource.includes('"processed" | "pending_move"') && !cacheEntryTypeSource.includes("skipped?: boolean") && !cacheEntryTypeSource.includes("moved?: boolean") && !cacheEntryTypeSource.includes("movedAt?: number"), "CacheEntry type still exposes overlapping state booleans");
  assert(typesSource.includes("skipReason?: string") && !typesSource.includes("reason?: string") && cacheSource.includes("normalizeCacheEntrySkipReason") && !cacheSource.includes("entry.reason"), "CacheEntry skip reason naming is not consolidated around skipReason");
  assert(cacheSource.includes("normalizeCacheEntryState") && cacheSource.includes("stripLegacyCacheStateFields") && cacheSource.includes("stateUpdatedAt"), "Cache does not normalize legacy moved/skipped fields into canonical state");
  assert(!cacheSource.includes("skipped: true") && !cacheSource.includes("moved: true") && !cacheSource.includes("movedAt: now"), "Cache mutation paths still write legacy moved/skipped state fields");
  assert(!/entry\.(?:moved|skipped)\b/.test(cacheSource), "Cache matching still branches on legacy moved/skipped booleans");
  assert(!utilsSource.includes("escapeHtml"), "Unused escapeHtml helper should stay removed; add a real DOM use before reintroducing it");
  assert(utilsSource.includes("stripWindowsLongPathPrefix") && utilsSource.includes("isUncFilesystemPath") && utilsSource.includes("isWindowsStyleFilesystemPath"), "Path helpers do not explicitly handle Windows UNC/long-path prefixes");
  assert(utilsSource.includes("MAX_SANITIZED_PATH_LENGTH") && utilsSource.includes("getSensitivePathReplacement") && !utilsSource.includes("pathLikeExtensions") && !utilsSource.includes("[^\"'<>]*?"), "sanitizeErrorForUser still uses the old narrow/backtracking path regex sanitizer");
  assert(!/catch\s*\([^)]*\)\s*\{\s*\}/.test(cacheSource), "Cache still contains empty catch blocks");
  assert(!settingsTabSource.includes("ensureWasmReady?.()"), "Settings tab still initializes WASM workers while rendering status");
  assert(!settingsTabSource.includes("requestWindowAnimationFrame(async"), "Settings tab still passes async callbacks directly to requestAnimationFrame");
  assert(settingsTabSource.includes("this.containerEl?.win || this.getActiveWindow()"), "Settings animation frames are not scheduled on the owning settings window");
  assert(settingsTabSource.includes("return ownerWindow.setTimeout(callback, delay)") && settingsTabSource.includes("ownerWindow.clearTimeout(timer as number)") && !settingsTabSource.includes("return window.setTimeout(callback, delay)"), "Settings timers are not created and cleared through their owning window");
  assert(progressModalSource.includes("this.contentEl?.win || this.getActiveWindow()"), "Progress modal animation frames are not scheduled on the owning modal window");
  assert(pluginSource.includes("this.statusBarItem?.win || this.getActiveWindow()"), "Status-bar animation frames are not scheduled on the owning status-bar window");
  assert(pluginSource.includes("modalFocusTimers: Map<Window, Set<number>>") && pluginSource.includes("for (const [ownerWindow, timers] of this.modalFocusTimers)"), "Modal focus timers are not tracked independently per owning window");
  assert(pluginSource.includes("ownerWindow: Window = window") && statusBarControllerSource.includes("}, 0, activeWindow)") && folderSelectorModalSource.includes("}, 0, ownerWindow)"), "UI timer callers do not pass their owning window to the plugin timer API");
  assert(!workerPoolSource.includes("getActiveWindowForApp") && workerPoolSource.includes("return window.setTimeout(callback, delay)") && workerPoolSource.includes("window.clearTimeout(timer as number)"), "WorkerPool timers still re-resolve a mutable active window");
  assert(!workerSlotSource.includes("getActiveWindowForApp") && workerSlotSource.includes('if (typeof window !== "undefined")'), "WorkerSlot timers still re-resolve a mutable active window");
  assert(!settingsTabSource.includes("this.rerenderPreservingScroll =") && !settingsTabSource.includes("rerenderPreservingScroll: () => void"), "Settings tab still stores rerenderPreservingScroll as a constructor field");
  assert(!settingsTabSource.includes("instanceof HTMLElement") && settingsTabSource.includes("typeof focusable?.focus === \"function\""), "Settings tab focus restore still only handles HTMLElement");
  assert(settingsTabSource.includes("if (!containerEl)") && settingsTabSource.includes("displayWithoutScrollRestore"), "Settings tab rerender fallback does not guard missing container/fallback display collisions");
  assert(settingsTabSource.includes("debouncedSaveSettings"), "Settings tab quality controls are missing debounced settings saves");
  assert(!/add(?:Slider|Text)\([\s\S]{0,700}await this\.plugin\.saveSettings\(\)/.test(settingsTabSource), "Settings tab slider/text controls still save settings on every change event");
  assert(settingsTabSource.includes("flushPendingSaveSettings") && settingsTabSource.includes("_renderRootsCleanups"), "Settings tab does not flush debounced saves or clean allowed-root pill listeners");
  assert(settingsTabSource.includes("class AllowedRootsFolderSuggestModal extends obsidian.FuzzySuggestModal<string>") && !settingsTabSource.includes("new (class extends obsidian.FuzzySuggestModal"), "Allowed-roots picker still uses an anonymous FuzzySuggestModal subclass");
  assert(settingsTabSource.includes("normalizeAllowedRootSelection") && settingsTabSource.includes("paths.allowedRoots.cannotAddRoot") && i18nCatalogSource.includes("paths.allowedRoots.cannotAddRoot"), "Allowed-roots picker does not handle root selection explicitly");
  assert(settingsTabSource.includes("tiny-local-warning-block") && stylesSource.includes(".tiny-local-warning-block") && settingsTabSource.includes("tiny-local-roots-pill") && stylesSource.includes(".tiny-local-roots-pill") && !settingsTabSource.includes("warn.style.") && !settingsTabSource.includes("pill.style."), "Settings tab static warning/root-pill styles still live inline");
  assert(settingsTabSource.includes('list.createEl("button", { text: root, cls: "badge tiny-local-roots-pill"') && settingsTabSource.includes('pill.setAttribute("aria-label"'), "Allowed-root removal pills are not keyboard-accessible buttons");
  assert(!settingsTabSource.includes("debouncedWorkerPoolRestartNotice") && !settingsTabSource.includes("settings.workerPoolSize.restartNote"), "Settings tab still contains worker-pool restart UI for removed technical settings");
  assert(settingsTabSource.includes("runButtonTask") && settingsTabSource.includes("common.refreshing") && settingsTabSource.includes("common.clearing") && i18nCatalogSource.includes("common.refreshing") && i18nCatalogSource.includes("common.clearing"), "Settings async stats buttons are missing loading/disabled state");
  assert(
    settingsTabSource.includes('`${t(this.plugin.app, "stats.uncompressed.ready")}: ${stats.uncompressedImages}`')
      && settingsTabSource.includes('`${t(this.plugin.app, "move.ready")}: ${stats.compressedFilesCount}`')
      && !settingsTabSource.includes('`${stats.uncompressedImages} ${t(this.plugin.app, "stats.uncompressed.ready")}`'),
    "Settings count labels must precede values so translations do not require numeric plural forms"
  );
  assert(
    savingsCalculatorSource.includes('` (${t(this.plugin.app, "tooltip.savings.estimated")}: ${savings.estimatedFiles})`')
      && !savingsCalculatorSource.includes('`${savings.estimatedFiles} ${t(this.plugin.app, "tooltip.savings.estimated")}`'),
    "Estimated-file labels must precede values so translations do not require numeric plural forms"
  );
  assert(!settingsTabSource.includes("stats.ghosts") && !i18nCatalogSource.includes("stats.ghosts") && !i18nCatalogSource.includes("stats.cache.retention"), "Removed ghost/retention strings remain in runtime UI locales");
  assert(settingsTabSource.includes("applySubsettingVisibility") && (settingsTabSource.match(/\.settingEl\.toggle\(/g) || []).length === 1, "Settings conditional rows still duplicate raw settingEl.toggle calls");
  assert(settingsTabSource.includes("container.addEventListener('mouseenter'") && settingsTabSource.includes("container.removeEventListener('mouseenter'") && !settingsTabSource.includes("registerDomEvent(container, 'mouseenter'"), "Savings tooltip listeners are not owned by the render-scoped cleanup");
  assert(settingsTabSource.includes("tooltipRoot") && !settingsTabSource.includes("activeDocument.body.appendChild") && !settingsTabSource.includes("activeDocument.body.removeChild"), "Savings tooltip DOM operations lack a body guard");
  assert(settingsTabSource.includes("showSettingsOperationError") && settingsTabSource.includes("Move compressed files action failed") && settingsTabSource.includes("Cache restore action failed") && i18nCatalogSource.includes("notice.operationFailed"), "Settings async actions are missing shared error feedback");
  // R21-1: pill removal must resolve the root by value at click time; a render-captured index goes stale after another removal.
  assert(!settingsTabSource.includes("splice(idx") && settingsTabSource.includes("allowedRoots.indexOf(root)"), "Allowed-root pill removal must look up the root by value at click time, not by captured render index");
  // R21-5: SettingsTab has no manifest, so getPluginName(this) only ever hits the fallback string.
  assert(!settingsTabSource.includes("getPluginName(this)"), "Settings tab must pass the plugin (not the tab) to getPluginName");
  // R21-2: t() runs in hot UI paths; merged dictionaries must be memoized and invalidated on external preload.
  assert(i18nSource.includes("MERGED_DICTS.get(mergedKey)") && i18nSource.includes("MERGED_DICTS.clear()"), "i18n merged dictionary lookups must be memoized per (pluginDir, lang) and cleared on external preload");
  // Backup tree deletion hashes each snapshot file and finishes with non-recursive rmdir so Sync-created children survive.
  assert(moveServiceSource.includes("removeFileVersionIfContentMatches(entryPath, expectedSha256)") && moveServiceSource.includes("removeDir(dirPath, { recursive: false, force: false") && moveServiceSource.includes("retentionLimiter"), "Backup directory cleanup is missing conditional file deletion or the non-recursive final fence");
  assert(settingsTabSource.includes("getSavingsBarWidths") && settingsTabSource.includes("Number.isFinite(savings.savedSize)") && settingsTabSource.includes("Number.isFinite(savings.originalSize)"), "Savings bar widths are missing finite-number guards");
  assert(stylesSource.includes(".tiny-local-savings-tooltip-wrapper") && stylesSource.includes(".tiny-local-savings-tooltip-target") && !settingsTabSource.includes("tooltip.style.position") && !settingsTabSource.includes("tooltip.style.zIndex") && !settingsTabSource.includes("tooltip.style.pointerEvents") && !settingsTabSource.includes("container.style.cursor"), "Savings tooltip static styles still live inline");
  assert(settingsTabSource.includes("tiny-local-savings-tooltip-placement-above") && settingsTabSource.includes("tiny-local-savings-tooltip-placement-below") && settingsTabSource.includes('"--local-image-compress-savings-tooltip-arrow-x"') && stylesSource.includes(".tiny-local-savings-tooltip-placement-above::before") && stylesSource.includes("border-top: var(--local-image-compress-savings-tooltip-arrow-size)") && stylesSource.includes(".tiny-local-savings-tooltip-placement-below::before") && stylesSource.includes("border-bottom: var(--local-image-compress-savings-tooltip-arrow-size)"), "Savings tooltip arrow is not placement-aware");
  // Obsidian plugin guidelines compliance (2026-05-31): GL1 heading wording, GL2 setHeading not raw h3, GL3 tooltip position via CSS custom properties
  assert(!/"section\.paths":\s*"[^"]*[Ss]ettings/.test(i18nCatalogSource) && !/"section\.paths":\s*"Настройки/.test(i18nCatalogSource), "section.paths heading still contains a redundant 'settings' word (Obsidian guideline #7)");
  assert(!pluginSource.includes('createEl("h3"') && !pluginSource.includes("createEl('h3'"), "Backups modal still renders a raw h3 heading instead of Setting().setHeading() (Obsidian guideline #8)");
  assert(settingsTabSource.includes("tooltip.setCssProps({") && settingsTabSource.includes('"--local-image-compress-savings-tooltip-left"') && settingsTabSource.includes('"--local-image-compress-savings-tooltip-top"') && !settingsTabSource.includes("tooltip.style.left") && !settingsTabSource.includes("tooltip.style.top") && stylesSource.includes("--local-image-compress-savings-tooltip-left") && stylesSource.includes("--local-image-compress-savings-tooltip-top"), "Savings tooltip position is not driven by CSS custom properties (Obsidian guideline #23)");
  assert(i18nSource.includes("preloadExternalLanguages") && pluginSource.includes("await preloadExternalLanguages") && !i18nSource.includes("fs.existsSync") && !i18nSource.includes("fs.statSync") && !i18nSource.includes("fs.readFileSync"), "i18n still performs sync filesystem reads in the t() hot path");
  assert(i18nSource.includes("export const I18N = BUILTIN_I18N") && localesIndexSource.includes("export const BUILTIN_I18N") && (localesIndexSource.match(/\.json";/g) || []).length === 21, "README UI locales are not statically bundled into main.js");
  assert(i18nSource.includes('"zh-hans": "zh-cn"') && i18nSource.includes('"zh-hant": "zh-tw"') && i18nSource.includes("replace(/_/g, \"-\")"), "Regional Obsidian language aliases are incomplete");
  assert(i18nSource.includes("getLanguage as getObsidianLanguage") && i18nSource.includes('requireApiVersion("1.8.7")') && !i18nSource.includes("app?.getLanguage"), "i18n must detect the locale through Obsidian's guarded module-level getLanguage API");
  assert(!i18nSource.includes("process.cwd()") && i18nSource.includes("if (!pluginDir)") && i18nSource.includes("return {};") && i18nSource.includes("pluginDir ? LOADED_LANGS"), "i18n external-language resolution does not fail closed when the vault plugin directory is unavailable");
  assert(i18nSource.includes("TranslationParams") && i18nSource.includes("interpolateTranslation") && !/t\([^\n]+\)\.replace\(/.test(combinedTsSource), "Translated placeholders still rely on caller-side string replacement");
  assert(i18nSource.includes("WARNED_LANG_LOAD_ERRORS") && i18nSource.includes("console.warn") && i18nCatalogSource.includes("i18n.externalLoadFailed"), "External language parse/load failures are still silent");
  assert(i18nSource.includes('be: "ru"') && i18nSource.includes('by: "ru"') && i18nSource.includes('ua: "uk"') && i18nSource.includes("[missing translation key]") && i18nSource.includes("`[${key}]`"), "i18n locale/missing-key fallback semantics are incomplete");
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
  const compressorActualSizeGate = compressorSource.slice(
    compressorSource.indexOf("const input = await this.readBinaryWithTimeout"),
    compressorSource.indexOf("const originalBuffer = this.toArrayBuffer(input)")
  );
  assert(
    compressorActualSizeGate.includes("const retainedInputBytes")
      && compressorActualSizeGate.includes("const actualInputBytes")
      && compressorActualSizeGate.includes("this.isTooLargeInput(actualInputBytes)"),
    "Compressor does not reject the actual retained input size immediately after read"
  );
  assert(compressorSource.includes("const filePath = operation?.sourcePath || file?.path") && !compressorSource.includes("operation?.sourcePath || file?.path || \"\""), "Compressor still falls through an empty path to extension parsing");
  assert(compressorSource.includes("isJpegEncodingFailure") && compressionWorkerSource.includes("jpeg_encode_failed") && pluginSource.includes("mozjpeg_failed"), "JPEG worker encode failures are not classified and tracked distinctly");
  assert(!pluginSource.includes("setupThemeAdaptation") && !pluginSource.includes("getCurrentPngquantVersion") && !pluginSource.includes("getCurrentMozjpegVersion"), "Plugin still contains dead theme/version compatibility shims");
  assert(
    migrationRunnerSource.includes("moveOrCopyMigrationItem")
      && migrationRunnerSource.includes("mergeMigrationItem")
      && migrationRunnerSource.includes("verifyMigrationItem")
      && migrationRunnerSource.includes("copyFile(src, dest, { exclusive: true })")
      && migrationRunnerSource.includes("sourceStat.isSymbolicLink")
      && migrationRunnerSource.includes("validateMigrationItemForPlatform")
      && migrationRunnerSource.includes("await this.mergeMigrationItem(src, dest)")
      && migrationRunnerSource.includes("moveFileToUniqueSibling(src, {")
      && migrationRunnerSource.includes("beforeMove: async (reservedQuarantinePath)")
      && migrationRunnerSource.includes("writeMigrationJournal")
      && migrationRunnerSource.includes("recoverMigrationQuarantineJournals")
      && migrationRunnerSource.includes("copyFile(quarantinePath, sourcePath, { exclusive: true })")
      && !migrationRunnerSource.includes("removeFile(src)")
      && migrationRunnerSource.includes("removeDir(src, { recursive: false, force: false })")
      && !migrationRunnerSource.includes("removeDir(src, { recursive: true, force: true })")
      && migrationRunnerSource.includes("listEntries(src)")
      && migrationRunnerSource.includes("migrationErrors"),
    "Backup migration does not merge safely, verify copy fallback data, use typed entry recursion, and report partial failures"
  );
  assert(
    platformPortsSource.includes("MoveFileToUniqueSiblingOptions")
      && platformDesktopSource.includes("options.beforeMove?.(this.toJournalRelativePath(nativePath))")
      && platformDesktopSource.includes("beforeMove?.(quarantinePath)")
      && platformMobileSource.includes("options?.beforeMove?.(quarantinePath)"),
    "Migration quarantine primitive does not durably hook the exact reserved path before rename"
  );
  assert(
    backupStorageSource.includes('BACKUP_STORAGE_FOLDER = ".local-image-compress"')
      && backupStorageSource.includes('joinPath(backupsRoot, "cache")')
      && backupStorageSource.includes('joinPath(backupsRoot, "originals")')
      && !backupStorageSource.includes("resolvePath(")
      && !backupStorageSource.includes("canonicalizePath("),
    "Backup storage paths are not centralized under the vault-level .local-image-compress folder"
  );
  assert(
    !cacheSource.includes("ports.fs.resolvePath(")
      && !moveServiceSource.includes(".fs.resolvePath(")
      && !migrationRunnerSource.includes(".fs.resolvePath(")
      && !cacheSource.includes(".fs.toVaultRelativePath(")
      && !moveServiceSource.includes(".fs.toVaultRelativePath(")
      && !migrationRunnerSource.includes(".fs.toVaultRelativePath(")
      && !savingsCalculatorSource.includes(".fs.toVaultRelativePath("),
    "A shared cache, move, or migration service still stores native desktop paths"
  );
  assert(cacheBackupStoreSource.includes("CACHE_BACKUP_MAX_COUNT = 50"), "Cache backups are not capped at 50 files");
  assert(!pluginSource.includes("autoBackgroundThreshold || 50") && pluginSource.includes("autoBackgroundThreshold ?? 50"), "Runtime settings still use || instead of ?? for autoBackgroundThreshold");
  assert(moveServiceSource.includes("compareFileContents(leftPath, rightPath)") && platformDesktopSource.includes("fs.promises.open(this.resolve(leftPath)"), "MoveService does not stream same-content comparisons through the desktop port");
  assert(moveBackupPreflightSource.includes("prepassLimiter") && moveBackupPreflightSource.includes("getIOConcurrency"), "MoveService backup prepass is not concurrency-limited for disk I/O");
  assert(moveBackupPreflightSource.includes("originalSha256") && moveBackupPreflightSource.includes("fileSha256Hex"), "MoveService backup verification does not hash source content");
  // T1 / H1 regression guard: the 3-phase SHA-256 content verification must stay intact
  // so a future refactor cannot silently drop anti-tampering protection without failing here.
  // (Phase 1 = prepass hash, asserted above via originalSha256/fileSha256Hex.)
  assert(
    moveBackupPreflightSource.includes("currentOriginalSha256") &&
    moveBackupPreflightSource.includes("!== task.originalSha256") &&
    moveBackupPreflightSource.includes("move.skip.originalContentChangedDuringBackup"),
    "MoveService verify phase no longer re-hashes the ORIGINAL to reject same-size content substitution (H1 phase 2)"
  );
  assert(
    moveBackupPreflightSource.includes("currentCompressedSha256") &&
    moveBackupPreflightSource.includes("!== task.compressedSha256") &&
    moveBackupPreflightSource.includes("move.skip.compressedContentChangedDuringBackup"),
    "MoveService verify phase no longer re-hashes the COMPRESSED file to reject same-size content substitution (H1 phase 2)"
  );
  assert(
    moveBackupPreflightSource.includes("fileSha256Hex(task.backupFilePath)") &&
    moveBackupPreflightSource.includes("fileSha256Hex(task.compressedBackupPath)") &&
    moveBackupPreflightSource.includes("move.skip.contentChangedDuringCopy") &&
    /cleanupBackupTaskFiles\(task\)[\s\S]{0,400}contentChangedDuringCopy/.test(moveBackupPreflightSource),
    "MoveService post-copy phase no longer re-hashes the written backup and cleans up on mismatch (H1 phase 3)"
  );
  // The destructive replacement must verify staged bytes and the permanent
  // original backup first, then verify the installed target before cache commit.
  assert(
    moveServiceSource.includes("fileSha256Hex(tempOriginalPath)") &&
    moveServiceSource.includes("stagedSha256 !== expectedCompressedSha256") &&
    moveServiceSource.includes("fileSha256Hex(compressedFile.originalBackupPath)") &&
    moveServiceSource.includes("replaceFile(tempOriginalPath, originalPath, {") &&
    moveServiceSource.includes("expectedTargetSha256: compressedFile.originalSha256BeforeMove") &&
    moveServiceSource.includes("expectedStagedSha256: expectedCompressedSha256") &&
    moveServiceSource.includes("fileSha256Hex(originalPath)") &&
    moveServiceSource.includes("observedProcessedStats.size === compressedFile.size") &&
    !moveServiceSource.includes("Staged compressed file size mismatch") &&
    moveServiceSource.includes("restoreOriginalFromBackup") &&
    moveServiceSource.indexOf("fileSha256Hex(tempOriginalPath)") < moveServiceSource.indexOf("replaceFile(tempOriginalPath, originalPath, {"),
    "MoveService replacement no longer verifies staged/backup/installed content with recovery (BR-H1)"
  );
  assert(!moveServiceSource.includes("crypto.randomBytes(4)") && !moveBackupPreflightSource.includes("crypto.randomBytes(4)"), "MoveService backup paths still use a 32-bit random suffix");
  assert(moveServiceSource.includes("randomHexSuffix(16)") && moveBackupPreflightSource.includes("randomHexSuffix(16)"), "MoveService backup/temp paths do not request 128-bit random suffixes explicitly");
  assert(moveServiceSource.includes("normalizeVaultPathForComparison(await this.ports().fs.realpath(dirPath))"), "MoveService compressed scan does not normalize realpath loop detection keys");
  assert(concurrencyLimiterSource.includes("RangeError") && concurrencyLimiterSource.includes("isValidLimit"), "ConcurrencyLimiter does not reject invalid limits at construction time");
  assert(!concurrencyLimiterSource.includes("getActiveCount()") && !concurrencyLimiterSource.includes("getQueueDepth()"), "ConcurrencyLimiter still exposes dead diagnostic active/queue getters");
  assert(
    concurrencyLimiterSource.includes("if (next)")
      && concurrencyLimiterSource.includes("Failed to transfer a concurrency permit")
      && /if \(this\.active >= this\.limit\)[\s\S]{0,180}else \{\s*this\.active\+\+;/.test(concurrencyLimiterSource)
      && /if \(next\)[\s\S]{0,300}this\.active--;/.test(concurrencyLimiterSource),
    "ConcurrencyLimiter does not transfer the active permit directly to the oldest waiter"
  );
  assert(
    backgroundCompressionServiceSource.includes("activityDocuments")
      && backgroundCompressionServiceSource.includes("registerUserActivityDocument")
      && backgroundCompressionServiceSource.includes("unregisterUserActivityDocument")
      && eventRouterSource.includes('workspace.on("window-open"')
      && eventRouterSource.includes('workspace.on("window-close"'),
    "Background activity tracking does not cover current and future popout documents"
  );
  assert(backgroundCompressionServiceSource.includes("getReadyUncompressedCount") && !backgroundCompressionServiceSource.includes('workspace as any).on("file-open"') && !backgroundCompressionServiceSource.includes('workspace as any).on("layout-change"'), "Background compression still uses stale snapshots or workspace layout events as user activity");
  assert(backgroundCompressionServiceSource.includes("lastUserActivityPerfTime") && backgroundCompressionServiceSource.includes("getMonotonicTime()") && !backgroundCompressionServiceSource.includes("Date.now() - this.plugin.backgroundCompressionService.lastUserActivity"), "Background inactivity still uses wall-clock deltas instead of monotonic time");
  assert(backgroundCompressionServiceSource.includes("BACKGROUND_FILTER_CONCURRENCY") && backgroundCompressionServiceSource.includes("filterUnprocessedFiles") && backgroundCompressionServiceSource.includes("hasReadyIndex") && backgroundCompressionServiceSource.includes(": this.plugin.getAllImageFiles()") && !backgroundCompressionServiceSource.includes("for (const file of filteredFiles)"), "Background compression still filters processed files sequentially or routes not-ready fallback through getImageFiles()");
  assert(pluginSource.includes("PLUGIN_ASYNC_FILTER_CONCURRENCY") && pluginSource.includes("filterUnprocessedImageFiles") && pluginSource.includes("new ConcurrencyLimiter(concurrency)") && pluginSource.includes("filterUnprocessedImageFiles(this.getAllImageFiles())") && batchCompressionServiceSource.includes("filterUnprocessedImageFiles(targetFiles)") && pluginSource.includes("filterUnprocessedImageFiles(imageFiles)).length") && !pluginSource.includes("for (const file of imageFiles)") && !batchCompressionServiceSource.includes("for (const file of targetFiles)") && !pluginSource.includes("let uncompressedImages = 0"), "Plugin still has sequential async image filtering instead of the shared bounded helper");
  assert(pluginSource.includes("Re-normalize before save because UI/event mutations") && pluginSource.includes("sort((left, right) => left.localeCompare(right))"), "Settings save/index config does not document re-normalization or canonicalize allowedRoots order");
  assert(pluginSource.includes("isImageFile(file: unknown): file is obsidian.TFile") && !pluginSource.includes("return this.SUPPORTED_IMAGE_EXTENSIONS.includes(file.extension.toLowerCase())"), "Plugin image-file check is not null-safe or typed as a TFile predicate");
  assert(pluginSource.includes("intentionally uses || instead of ??") && pluginSource.includes("Returns every supported image file") && pluginSource.includes("Returns only uncompressed image files"), "Plugin output-folder fallback or image-file method naming intent is undocumented");
  assert(pluginSource.includes("progress.error\")} (${fileLabel})") && settingsSource.includes('reason === "too_large"') && cacheSource.includes('skipReason === "too_large"'), "Compression errors or too_large skip settings keys are missing class-wide guards");
  assert(
    /skipReason === "too_large"[\s\S]{0,240}fileSha256Hex\(file\.path, token\)/.test(cacheSource)
      && cacheSource.includes("sourceSha256,")
      && cacheSource.includes("Skipped entry cannot be content-bound and will not be cached"),
    "Skipped cache persistence is not content-bound or can buffer an oversized file"
  );
  assert(platformIndexSource.includes("Platform.isDesktopApp === true") && platformIndexSource.includes("isDesktopAdapter(app.vault.adapter)"), "Platform selection does not require both host and adapter desktop capabilities");
  assert(classWideGatesSource.includes("desktop-boundary-import") && classWideGatesSource.includes("adapter-rename-boundary"), "Class-wide gates do not protect the platform boundary or replacement contract");
  assert.deepEqual(
    [...classWideGatesSource.matchAll(/if \(relativePath === "([^"]+)"\) \{\s*return;\s*\}/g)].map((match) => match[1]),
    ["src-ts/platform/index.ts"],
    "Desktop boundary import gate must exempt only the platform composition root"
  );
  assert(platformMobileSource.includes("processTextAtomically") && platformMobileSource.includes("readonly writeExclusive = null") && platformMobileSource.includes("this.vault.createBinary(resolvedPath, encoded.buffer)") && platformMobileSource.includes("copyFileExclusive") && platformMobileSource.includes("this.vault.createBinary(this.resolve(targetPath), data)"), "Mobile exclusive creation is not routed through Vault.createBinary");
  const desktopOwnedCleanupSource = platformDesktopSource.slice(platformDesktopSource.indexOf("private async removeOwnedCleanupRevision("), platformDesktopSource.indexOf("async removeFile(", platformDesktopSource.indexOf("private async removeOwnedCleanupRevision(")));
  const mobileOwnedCleanupSource = platformMobileSource.slice(platformMobileSource.indexOf("private async removeOwnedCleanupRevision("), platformMobileSource.indexOf("private async requireBufferedFile(", platformMobileSource.indexOf("private async removeOwnedCleanupRevision(")));
  assert(
    desktopOwnedCleanupSource.includes("discardVerifiedTransactionRevision = false")
      && desktopOwnedCleanupSource.includes("if (discardVerifiedTransactionRevision)")
      && desktopOwnedCleanupSource.includes("await nodeFs().promises.unlink(deletionPath)")
      && desktopOwnedCleanupSource.includes("await this.trashDetachedRevision(deletionPath)")
      && platformDesktopSource.includes("await this.trashLocal(")
      && platformDesktopSource.includes("electronShell().trashItem(deletionPath)")
      && mobileOwnedCleanupSource.includes("discardVerifiedTransactionRevision = false")
      && mobileOwnedCleanupSource.includes("if (discardVerifiedTransactionRevision)")
      && mobileOwnedCleanupSource.includes("await this.adapter.remove(deletionPath)")
      && mobileOwnedCleanupSource.includes("await this.adapter.trashLocal(deletionPath)"),
    "Verified transaction cleanup or conflict-preserving conditional cleanup lost its platform safety boundary"
  );
  assert(/if \(options\.canCommit && !options\.canCommit\(\)\) \{\s*throw new Error\(`Replacement commit was cancelled before publication: \$\{target\}`\);\s*\}\s*\/\/ A hard link[\s\S]*?await fs\.promises\.link\(staged, target\);/.test(platformDesktopSource), "Desktop replacement lacks a final synchronous lifecycle fence immediately before publication");
  assert(/if \(canCommit && !canCommit\(\)\) \{\s*throw new Error\(`Replacement commit was cancelled before publication: \$\{targetPath\}`\);\s*\}\s*await this\.vault\.createBinary\(this\.resolve\(targetPath\), data\);/.test(platformMobileSource), "Mobile replacement lacks a final synchronous lifecycle fence immediately before publication");
  assert(platformPortsSource.includes("runBufferedOperation<T>") && platformMobileSource.includes("MOBILE_BUFFERED_OPERATION_QUEUE_KEY") && platformMobileSource.includes("Invalid or expired mobile buffered-operation token"), "Mobile full-buffer work is not serialized by a shared reentrant budget");
  assert(compressorSource.includes("compressWithBufferedPermit") && compressorSource.includes("bufferedOperationToken") && cacheSource.includes("readFileBinaryForFingerprint") && cacheSource.includes("runBufferedOperation"), "Compression and cache fingerprinting do not share the mobile full-buffer budget");
  assert(platformMobileSource.includes("maintenance limit after read") && platformMobileSource.includes("data.byteLength > MOBILE_MAX_BUFFERED_FILE_BYTES"), "Mobile buffered reads trust stale pre-read stat size");
  const mobileReadTextSource = platformMobileSource.slice(
    platformMobileSource.indexOf("async readText("),
    platformMobileSource.indexOf("async writeText(")
  );
  assert(
    mobileReadTextSource.includes("this.runBufferedOperation")
      && mobileReadTextSource.includes("this.requireBufferedFile")
      && mobileReadTextSource.includes("getUtf8ByteLength(text) > MOBILE_MAX_BUFFERED_FILE_BYTES")
      && mobileReadTextSource.includes("bufferedOperationToken"),
    "Mobile text reads bypass the serialized buffered-operation queue or pre/post byte limits"
  );
  assert(/\.is-mobile \.tiny-local-status-menu \.tiny-local-status-menu-item\s*\{[^}]*min-height:\s*44px/.test(stylesSource), "Mobile status menu touch targets are below 44px");
  assert(settingsTabSource.includes("fsPort.restoreProbe || fsPort.processTextAtomically") && settingsTabSource.includes('throw new Error("Cache restore returned false")'), "Settings restore UI ignores desktop/mobile restore capability or reports false success");
  assert(batchCompressionServiceSource.includes('new Set(["/", ...folders.map') && !batchCompressionServiceSource.includes('folderPaths.unshift("/")'), "Folder selector still filters root and re-adds it with unshift");
  assert(batchCompressionServiceSource.includes("notice.compressionDeferredDueToMove") && i18nCatalogSource.includes("notice.compressionDeferredDueToMove"), "Move-in-progress compression deferral Notice is missing specific i18n coverage");
  assert(batchCompressionServiceSource.includes("Snapshot defensively because UI/event mutations") && pluginSource.includes("const indexUpdatePromise = isOutputPath"), "Batch settings snapshot or modify-event scheduling intent is not guarded");
  assert(pluginSource.includes("PLUGIN_BACKUP_DELETE_CONCURRENCY") && pluginSource.includes("backupDeleteLimiter") && pluginSource.includes("Promise.allSettled(backups.map") && !pluginSource.includes("for (const backup of backups)"), "Original-files backup cleanup still deletes backup directories sequentially");
  assert(
    pluginSource.includes("fsPort.listEntries(backupDir)")
      && pluginSource.includes("deleteDirectoryRecursiveAsync(backup.path)")
      && pluginSource.includes("fsPort.removeFileIfUnchanged(backup.path, expectedSha256)")
      && !pluginSource.includes("adapter.list(relativeBackupDir)"),
    "Original-files backup cleanup must stay behind identity-bound shared filesystem operations"
  );
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
  assert(statusBarControllerSource.includes('setAttribute?.("aria-label", accessibleStatusText)') && statusBarControllerSource.includes('removeAttribute?.("title")') && !statusBarControllerSource.includes('setAttribute?.("title"'), "Status bar item must use one tooltip surface: aria-label without a native title");
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
  const brandRulePattern = /\.tiny-local-settings \.tiny-local-support-link--(?:coffee|telegram)(?::hover)?\s*\{[^}]*\}/g;
  const coffeeBrandRules = (stylesSource.match(brandRulePattern) || []).filter((rule) => rule.includes("--coffee"));
  const telegramBrandRules = (stylesSource.match(brandRulePattern) || []).filter((rule) => rule.includes("--telegram"));
  assert(coffeeBrandRules.length === 2 && coffeeBrandRules.some((rule) => rule.includes("background: #ffdd00;") && rule.includes("color: #000;")), "Buy Me a Coffee button must keep its supplied brand colors");
  assert(telegramBrandRules.length === 2 && telegramBrandRules.some((rule) => rule.includes("background: #007db8;") && rule.includes("color: #fff;")), "Telegram button must keep its high-contrast blue and white colors");
  const unbrandedStyles = stylesSource.replace(brandRulePattern, "");
  assert(!/#[0-9A-Fa-f]{3,8}\b|rgba?\(|hsla?\(/.test(unbrandedStyles), "styles.css contains hardcoded color literals outside the support buttons");
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
    moveModalsSource,
    imageScannerSource,
    savingsCalculatorSource
  ].join("\n");
  const tinyLocalUsedClasses = new Set([...tinyLocalClassUsageSource.matchAll(/tiny-local-[\w-]+/g)].map((match) => match[0]));
  const orphanTinyLocalClasses = [...tinyLocalCssClasses].filter((className) => !tinyLocalUsedClasses.has(className));
  assert(orphanTinyLocalClasses.length === 0, `styles.css contains orphan tiny-local classes: ${orphanTinyLocalClasses.join(", ")}`);
  assert(moveServiceSource.includes("move.warning.externalModification"), "MoveService does not notify on external move modification");
  assert(moveServiceSource.includes("getMoveSkipReasonGroups") && moveModalsSource.includes("tiny-local-move-skip-reasons"), "MoveService does not show grouped skip reasons in move results");
  assert(moveBackupPreflightSource.includes("isCompleteBackupTask") && !/backupFilePath!|compressedBackupPath!|originalPath!|byName\.get\(file\.name\)!/.test(moveServiceSource + moveBackupPreflightSource), "MoveService backup flow still uses unsafe non-null assertions");
  assert(moveServiceSource.includes("isCandidateOriginalFile(file: unknown): file is obsidian.TFile") && !moveServiceSource.includes("Map<string, any[]>"), "MoveService original file lookup is missing a shared TFile candidate predicate");
  assert(moveServiceSource.includes("normalizeVaultPath(compressedFile.relativePath") && !/compressedFile\.relativePath[\s\S]{0,100}\.replace\(/.test(moveServiceSource), "MoveService still normalizes compressed relative paths with inline string replacement");
  assert(moveServiceSource.includes("pathsReferToSameFile") && moveServiceSource.includes("move.skip.selfMove"), "MoveService does not guard compressed/original self-moves");
  assert(moveServiceSource.includes("move.skip.noOriginalCandidate") && moveModalsSource.includes("displaySkippedCount"), "MoveService does not account zero-candidate originals or derive skipped totals from reason groups");
  assert(i18nCatalogSource.includes("move.backup.createdCount") && i18nCatalogSource.includes("backups.imagesFolder.deletedCount"), "Backup notices are missing i18n keys");
  assert(i18nSource.includes("normalizeVaultPathForComparison(pluginDir)") && i18nSource.includes("LOADED_LANGS[cacheKey]"), "i18n external-language cache is not scoped by plugin directory");
  assert(!moveServiceSource.includes("Created backup of ${") && !moveBackupPreflightSource.includes("Created backup of ${") && !pluginSource.includes("Backups folder not found") && !pluginSource.includes("No backups to delete"), "Backup notices still contain hardcoded English text");
  assert(pluginSource.includes("compressionWorkflowsInFlight") && pluginSource.includes("waitForCompressionIdle") && moveServiceSource.includes("await this.plugin.waitForCompressionIdle()"), "Move flow does not wait for active compression workflows");
  assert(pluginSource.includes("indexRefreshTimers: Map<string, TimerHandle>") && pluginSource.includes("clearIndexRefreshTimer") && pluginSource.includes("file:${normalizedPath}"), "Image index refresh scheduling is not deduped by path");
  assert(pluginSource.includes("waitForCompressionIdle(maxWaitMs = 60_000)") && pluginSource.includes("waitForCompressionIdle giving up after") && !pluginSource.includes("queueMicrotask(() => resolve(undefined))"), "Compression idle wait can still spin forever or fall back to a microtask-only tick");
  assert(newFileQueueSource.includes("NEW_FILE_PENDING_MAX") && newFileQueueSource.includes("auto.queueFull"), "Plugin does not cap the new-file auto-compress queue");
  assert(batchCompressionServiceSource.includes("background.starting") && batchCompressionServiceSource.includes("background.finished"), "Background compression does not notify users about larger batches");
  assert(pluginSource.includes('rebuildImageIndex("startup")') && pluginSource.includes("await this.cache.compactCache()"), "Startup indexing is not followed by full cache compaction");
  assert(cacheSource.includes("compactCache") && cacheSource.includes("compactPath") && cacheSource.includes("compactDeletedPath"), "Cache is missing full or point compaction operations");
  assert(cacheCompactionSource.includes("signature: JSON.stringify(entry)") && cacheCompactionSource.includes("JSON.stringify(currentEntry) !== candidate.signature"), "Cache compaction can delete a newer replacement of a selected key");
  assert(cacheSource.includes("filter(([, entry]) => !this.isLegacyEntry(entry))") && !cacheSource.includes("if (this.isLegacyEntry(entry))"), "Legacy cache entries can still become fresh processing/statistics candidates");
  assert(cacheSource.includes("resolvePendingMoveEntry") && moveServiceSource.includes("move.skip.externalModification"), "Move flow does not reject conflicting pending cache identity");
  assert(cacheSource.includes("sourceSha256") && cacheSource.includes("outputSha256") && moveBackupPreflightSource.includes("sourceSha256: originalSha256") && moveBackupPreflightSource.includes("outputSha256: compressedSha256"), "Move preflight does not bind pending cache entries to exact source/output content hashes");
  assert(moveBackupPreflightSource.includes('pendingMove.status !== "match"'), "Move preflight still allows untracked compressed output to replace an original");
  assert(!cacheSource.includes("outputMetadata.outputSize !== artifact.outputSize") && !cacheSource.includes("verifiedOutputMetadata.outputSize !== outputMetadata.outputSize"), "Compression artifact commit still treats immediate post-write size metadata as stronger than exact output content");
  assert(!cacheSource.includes("|| !await this.outputMatchesEntry(entry)"), "Pending move resolution still repeats stale output-stat identity checks after exact hashes were supplied");
  assert(moveBackupPreflightSource.includes("trustedCompressedSize") && !moveBackupPreflightSource.includes("outputMatchesStats") && !moveBackupPreflightSource.includes("currentCompressedStats.size !== task.compressedSize"), "Hash-owned move preflight still rejects Android output solely because size metadata lags");
  assert(!cacheSource.includes("Number(entry.outputSize) !== Number(metadata.outputSize)") && !cacheSource.includes("this.processedMatchesCurrentFile(entry, file) && await this.fileHashMatches(file.path, entry.outputSha256)"), "Exact pending/moved cache proofs still depend on immediate Android metadata convergence");
  assert(moveServiceSource.includes("originalSha256BeforeMove") && moveServiceSource.includes("currentOriginalSha256"), "Move flow does not revalidate the backup-verified original before replacement");
  assert(!pluginSource.includes("GHOST_CLEANUP_COMPRESSED_THRESHOLD") && !pluginSource.includes("STALE_CACHE_PRUNE_COMPRESSED_THRESHOLD") && !cacheSource.includes("pruneStaleCacheEntries") && !cacheSource.includes("cleanupGhostEntries"), "Legacy threshold/retention cache cleanup remains active");
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
  assert(progressModalSource.includes("this.plugin.untrackManagedModal(this)") && moveModalsSource.includes("this.plugin.trackManagedModal(modal)") && settingsTabSource.includes("this.plugin.trackManagedModal(new AllowedRootsFolderSuggestModal"), "Plugin-owned progress/settings modals are not tracked through unload cleanup");
  assert(cacheBackupsViewSource.includes("openButton.removeEventListener") && moveModalsSource.includes("closeButton.removeEventListener"), "Modal click listeners are not explicitly cleaned up on close");
  assert(
    pluginSource.includes("captureModalFocusTarget()")
      && pluginSource.includes("restoreModalFocus(")
      && pluginSource.includes("modalFocusTimers")
      && folderSelectorModalSource.includes("restoreModalFocus(this.returnFocusTo)")
      && progressModalSource.includes("restoreModalFocus(this.returnFocusTo)")
      && moveModalsSource.match(/restoreModalFocus\(this\.returnFocusTo\)/g)?.length === 2
      && cacheBackupsViewSource.includes("restoreModalFocus(this.returnFocusTo)")
      && settingsTabSource.includes("restoreModalFocus(this.returnFocusTo)"),
    "Custom modal classes do not consistently capture and restore trigger focus"
  );
  assert(
    statusBarControllerSource.includes("this.closeMenu(true)") && moveModalsSource.includes("scheduleElementFocus(closeButton)") && cacheBackupsViewSource.includes("scheduleElementFocus(openButton)"),
    "Keyboard menu actions or custom modal controls are missing deterministic focus entry"
  );
  assert(folderSelectorModalSource.includes("contentEl.removeEventListener") && folderSelectorModalSource.includes("listenerCleanups"), "Folder selector listeners are not explicitly cleaned up on close");
  assert(pluginSource.includes("isInitialized") && pluginSource.includes("handleInitializationFailure") && pluginSource.includes("cleanupRuntimeState"), "Plugin startup does not fence partial initialization failures");
  assert(runtimeQaSource.includes("candidate?.isInitialized === true"), "Desktop runtime QA can accept a partially initialized plugin after reload");
  const runtimeQaCliMainSource = runtimeQaCliSource.slice(runtimeQaCliSource.indexOf("async function main()"), runtimeQaCliSource.indexOf("main().catch"));
  assert(
    runtimeQaCliMainSource.indexOf("try {") < runtimeQaCliMainSource.indexOf("reserveRuntimeQa(reservationToken);")
      && runtimeQaCliMainSource.indexOf("reserveRuntimeQa(reservationToken);") < runtimeQaCliMainSource.indexOf("ensurePreQaSettingsBackup();")
      && runtimeQaCliSource.includes("runtimeQaReservationConfirmed = true;")
      && runtimeQaCliSource.includes("if (!runtimeQaReservationConfirmed)"),
    "Desktop runtime QA mutates recovery state or performs wrapper cleanup without confirmed renderer ownership"
  );
  assert(pluginSource.includes("scheduleStartupImageIndexRebuild()") && pluginSource.includes("queueStartupImageIndexRebuild()") && pluginSource.includes("runStartupImageIndexRebuild()"), "Startup image index rebuild is not owned by a named background helper");
  assert(pluginSource.includes("override onload(): void") && pluginSource.includes("startInitializationAfterLayoutReady") && pluginSource.includes("this.app.workspace.onLayoutReady") && pluginSource.indexOf("await this.initializePlugin()") > pluginSource.indexOf("async loadPlugin()"), "Plugin initialization is not deferred behind the layout-ready boundary");
  assert(pluginSource.includes("if (this.isUnloading || !this.isInitialized)") && pluginSource.indexOf("if (this.isUnloading || !this.isInitialized)") < pluginSource.indexOf("this.imageScanner.invalidateImageLookupCache()"), "Vault create handling is not fenced until layout-ready initialization completes");
  assert(eventRouterSource.includes("runGuardedEvent") && pluginSource.includes("openStatusMenuSafely") && pluginSource.includes("this.statusBarController.closeMenu(true)"), "Async event/menu callbacks are missing rejection and lifecycle boundaries");
  assert(pluginSource.includes("await this.migrationRunner.recoverMigrationQuarantineJournals()") && newFileQueueSource.includes("this.plugin.isUnloading || !this.plugin.isInitialized"), "Startup or new-file continuations are missing unload fences");
  assert(!pluginSource.includes("await this.setupStatusBar()") && pluginSource.indexOf("this.setupStatusBar();") < pluginSource.indexOf("this.setupEventListeners()"), "Status bar setup is still awaited or ordered after event registration");
  assert(!setupStatusBarSource.includes('rebuildImageIndex("startup")') && !setupStatusBarSource.includes("await this.statusBarController.update()"), "setupStatusBar() still blocks on startup image indexing");
  assert(pluginSource.includes('const key = "startup-image-index"') && pluginSource.includes("await this.runStartupImageIndexRebuild()") && pluginSource.includes("Startup image-index rebuild failed"), "Startup image index rebuild is missing timer ownership or error handling");
  assert(pluginSource.indexOf("this.isInitialized = true;") < pluginSource.indexOf("this.scheduleStartupImageIndexRebuild();"), "Startup image index rebuild is scheduled before base plugin initialization is complete");
  assert(pluginSource.indexOf("this.isInitialized = true;") < pluginSource.indexOf("if (__LIC_MOBILE_QA__)"), "Mobile QA surfaces are registered before product initialization completes");
  assert(i18nCatalogSource.includes("init.failed"), "Initialization failure notice is missing i18n coverage");
  assert(pluginGuardSource.includes("guard.disabled") && pluginGuardSource.includes("guard.restored") && pluginGuardSource.includes("new obsidian.Notice"), "Plugin guard does not notify on disable/restore");
  assert(pluginGuardSource.includes("releaseAllGuards") && pluginSource.includes("releaseAllGuards"), "Plugin guard does not restore guarded plugins during unload");
  assert(pluginGuardSource.includes("observedEnabledAfterGuardDisable") && pluginGuardSource.includes("shouldRestoreGuardedPlugin") && pluginGuardSource.includes("startGuardStateMonitor"), "Plugin guard restore does not respect user/external toggles during guard");
  assert(pluginGuardSource.includes("scheduleEnableRetry") && pluginGuardSource.includes("allowEnableRetry") && pluginGuardSource.includes("disabledByGuard"), "Plugin guard does not handle enable timeouts or idempotent disable ownership");
  assert(pluginGuardSource.includes("releaseGuardsInParallel") && pluginGuardSource.includes("Promise.allSettled") && !/for\s*\(\s*const id of acquired\.reverse\(\)\s*\)\s*\{\s*await this\.release\(id\)/.test(pluginGuardSource), "Plugin guard withDisabled() still releases acquired guards sequentially");
  assert(pluginGuardSource.includes("operationTimedOut") && !pluginGuardSource.includes("operationCompleted.then((completed)"), "Plugin guard late-disable restore still uses an orphan operationCompleted continuation");
  assert(
    pluginGuardSource.includes("guardGeneration")
      && pluginGuardSource.includes("lifecycleGeneration")
      && pluginGuardSource.includes("shutdownGuards")
      && pluginGuardSource.includes("operationTimedOut = true")
      && pluginSource.includes("releaseAllGuards?.(true)"),
    "Plugin guard late completion or unload is not fenced by guard/lifecycle generation"
  );
  assert(
    imageIndexSource.includes("cancelPendingWork")
      && imageIndexSource.includes("isCurrentGeneration")
      && pluginSource.includes("this.imageIndex?.cancelPendingWork()"),
    "ImageIndex async publication is not cancelled at the start of unload cleanup"
  );
  assert(imageScannerSource.includes("stripMarkdownCode") && imageScannerSource.includes("getWikiTargetBeforeAlias") && imageScannerSource.includes("\\\\([() |])"), "Image scanner does not handle escaped wiki pipes/code blocks");
  assert(imageScannerSource.includes("imageLookupCache") && pluginSource.includes("invalidateImageLookupCache"), "Image scanner lookup cache is missing invalidation hooks");
  assert(!cacheSource.includes("Math.random") && !cacheBackupStoreSource.includes("Math.random") && !compressorSource.includes("Math.random") && !moveServiceSource.includes("Math.random"), "Temp file naming still uses Math.random");
  assert(savingsCalculatorSource.includes("Promise.all(fetchTasks.map"), "Savings calculator does not parallelize compressed size fetches within a batch");
  assert(savingsCalculatorSource.includes("getInterruptedSavingsResult") && savingsCalculatorSource.includes("this.plugin.isUnloading"), "Savings calculator does not stop safely after unload during UI yields");
  assert(moveBackupPreflightSource.includes("skipForUnload") && moveServiceSource.includes("move.skip.unloading"), "Move service does not stop safely when plugin unloads before backup/move file operations");
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
  assert(moveModalsSource.includes('setAttribute("role", "progressbar")') && moveModalsSource.includes('setAttribute("aria-valuetext"') && moveModalsSource.includes('setAttribute("aria-live", "polite")'), "Move progress modal is missing accessible progress semantics");
  assert(batchCompressionServiceSource.includes("signal: abortController.signal") && batchCompressionServiceSource.includes("cancelled_batch_aborted") && batchCompressionServiceSource.includes("cancelled: isCancelled()"), "Batch compression does not propagate ProgressModal cancellation");
  assert(batchCompressionServiceSource.includes("Batch compression failed unexpectedly") && batchCompressionServiceSource.includes("progressModal.setError(errorMessage)"), "processBatchCompression does not surface unexpected batch failures in the modal");
  assert(i18nCatalogSource.includes("progress.cancelling") && i18nCatalogSource.includes("progress.cancelled") && i18nCatalogSource.includes("common.cancel"), "Progress cancellation i18n keys are missing");
  assert(!pluginSource.includes("app.setting") && pluginSource.includes("settingsTab?.refreshStatsIfVisible()") && settingsTabSource.includes("refreshStatsIfVisible()") && settingsTabSource.includes("this._isVisible = true"), "Settings indicator refresh still depends on private app.setting state instead of plugin-owned visibility");
  assert(settingsTabSource.includes("requestRerenderAfterCurrentRender()") && settingsTabSource.includes("refreshStatsIfVisible()") && !pluginSource.includes("settingsTab._isRendering") && !pluginSource.includes("settingsTab._pendingRerender"), "Settings indicator refresh still mutates SettingsTab render internals directly");
  assert(settingsTabSource.includes('setAttribute("tabindex", "0")') && settingsTabSource.includes('setAttribute("role", "group")') && settingsTabSource.includes("'focus', onFocus") && settingsTabSource.includes('"Escape"') && settingsTabSource.includes("container.doc || ownerWindow.document"), "Savings tooltip is not keyboard-accessible or popout-owned");
  assert(!i18nCatalogSource.includes('"Command Palette →"') && !i18nCatalogSource.includes('"Space Savings Details"') && !i18nCatalogSource.includes('"Original Size:"'), "English built-in locale contains title-case UI copy");
  assert(pluginSource.includes("new ProgressModal(this, t(this.app, \"common.refreshCache\")") && i18nCatalogSource.includes("status.indexing"), "forceRefreshCache does not show progress for cache/index refresh");
  assert(pluginSource.includes('setText(t(this.app, "status.loading"))') && pluginSource.includes('setText(t(this.app, "status.indexing"))') && !pluginSource.includes('setText("…")') && i18nCatalogSource.includes("status.loading"), "Status bar startup still uses a magic loading string or lacks indexing feedback");
  assert(pluginSource.includes("async showCacheBackupsList()") && settingsTabSource.includes("showCacheBackupsList") && !settingsTabSource.includes("openBackupsFolder"), "Cache backup list method is still named or called as opening a folder");
  assert(cacheBackupsViewSource.includes("backupInfoLimiter = new ConcurrencyLimiter(8)") && cacheBackupsViewSource.includes("toLocaleString(locale)") && !cacheBackupsViewSource.includes("toLocaleString(locale === 'en'"), "Cache backup list stat/locale formatting is not bounded or explicit");
  assert(
    cacheBackupsViewSource.includes(".fs.getDisplayPath(backupDir)")
      && cacheBackupsViewSource.includes('text: `${t(this.app, "backups.pathLabel")}: ${displayBackupDir}`')
      && cacheBackupsViewSource.includes("revealPath(backupDir)")
      && !cacheBackupsViewSource.includes("revealPath(displayBackupDir)"),
    "Cache backup modal does not separate the desktop display path from vault-relative storage/reveal paths"
  );
  assert(savingsCalculatorSource.includes("Promise<number | null>") && savingsCalculatorSource.includes("if (!stat || stat.isDirectory)") && savingsCalculatorSource.includes("Cannot read compressed file size") && savingsCalculatorSource.includes("return null"), "Compressed size lookup does not distinguish missing files from stat errors");
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
  assert(
    (combinedTsSource.match(/from\s+(["'])electron\1/g) || []).length === 0
      && (platformDesktopSource.match(/require\((["'])electron\1\)/g) || []).length === 1
      && platformDesktopSource.includes("openFilesystemPath")
      && cacheBackupsViewSource.includes("revealPath(backupDir)")
      && settingsTabSource.includes("revealPath(dir)")
      && cacheBackupsViewSource.includes("runtime.revealPath")
      && settingsTabSource.includes("runtime.revealPath"),
    "Folder opening should go through the runtime revealPath port gated off on mobile"
  );
  assert(!platformDesktopSource.includes("fallback = process.cwd()") && platformDesktopSource.includes("refusing filesystem access outside the vault"), "Vault base-path resolution still fails open outside the vault");
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
    assert(!i18nCatalogSource.includes(`"${staleBinaryLocaleKey}"`), `Obsolete native-binary locale key returned: ${staleBinaryLocaleKey}`);
  }
  assert(compressorSource.includes('"compress.error.pngQuality"') && !compressorSource.includes('"compress.error.pngquantExit"'), "PNG quality failure still uses native pngquant wording");
  assert(!settingsSource.includes("workerPoolSize") && !settingsSource.includes("pluginGuardTimeoutMs"), "Settings source still exposes technical runtime settings");
  assert(!readmeSource.includes("Compression worker pool size") && !readmeSource.includes("Plugin guard timeout"), "README.md still documents technical runtime settings as configurable");
  assert(!readmeRuSource.includes("Размер пула воркеров сжатия") && !readmeRuSource.includes("Таймаут защиты плагина"), "README.ru.md still documents technical runtime settings as configurable");
  assert(readmeSource.includes("WebP, GIF, BMP") && readmeSource.includes("100 MB / 100 MP") && readmeSource.includes("25 MB / 50 MP"), "README.md is missing supported-format limitations or platform safety-limit documentation");
  for (const token of [
    "npm run qa:mobile:build",
    ".local-image-compress-qa/qa-vault-marker.json",
    "Local Image Compress QA/reports",
    ".obsidian/plugins/local-image-compress/qa-backups/mobile/<device-owner-id>/",
    "npm run qa:mobile:probe",
    "Required manual device pass"
  ]) {
    assert(mobileQaGuideSource.includes(token), `MOBILE_QA.md is missing workflow token: ${token}`);
  }
  assert(
    !mobileQaGuideSource.includes(".local-image-compress-qa/sessions/"),
    "MOBILE_QA.md still documents the obsolete crash-recovery path"
  );
  assert(readmeRuSource.includes("WebP, GIF, BMP") && readmeRuSource.includes("100 MB / 100 MP") && readmeRuSource.includes("25 MB / 50 MP"), "README.ru.md is missing supported-format limitations or platform safety-limit documentation");
  assert(readmeSource.includes("| PNG quality (min-max) | Quality range for lossy PNG quantization | 1-100") && !readmeSource.includes("PNG quality (min-max) | Quality range for lossy PNG quantization | 0-100"), "README.md PNG quality range is out of sync with settings clamp");
  assert(readmeRuSource.includes("| Качество PNG (мин-макс) | Диапазон качества квантования PNG с потерями | 1-100") && !readmeRuSource.includes("Качество PNG (мин-макс) | Диапазон качества квантования PNG с потерями | 0-100"), "README.ru.md PNG quality range is out of sync with settings clamp");
  for (const token of [
    "Inactivity threshold",
    "Auto backup retention",
    "Auto-move compressed files",
    "Auto-move threshold",
    "conservative estimates with capped ratios",
    "does not attempt to restore it"
  ]) {
    assert(readmeSource.includes(token), `README.md is missing settings/savings/guard documentation token: ${token}`);
  }
  assert(!readmeSource.includes("Disable Paste Image Rename during compression") && !readmeSource.includes("with the setting off"), "README.md still documents a Paste Image Rename opt-out setting");
  for (const token of [
    "Порог неактивности",
    "Автохранение резервных копий",
    "Автоперемещение сжатых файлов",
    "Порог автоперемещения",
    "консервативную оценку с ограниченными коэффициентами",
    "не пытается восстановить его"
  ]) {
    assert(readmeRuSource.includes(token), `README.ru.md is missing settings/savings/guard documentation token: ${token}`);
  }
  assert(!readmeRuSource.includes("Отключать Paste Image Rename при сжатии") && !readmeRuSource.includes("если выключить"), "README.ru.md still documents a Paste Image Rename opt-out setting");
  assert(manifestSource.minAppVersion === "1.4.0", "manifest.json minAppVersion must match the activeWindow/activeDocument/getBasePath API minimum");
  assert(versionsSource[manifestSource.version] === manifestSource.minAppVersion, "versions.json current version must match manifest minAppVersion");
  assert(manifestSource.authorUrl === "https://github.com/haperone", "manifest.json authorUrl must point to the author profile");
  assert(packageSource.scripts["build:root"] === "node scripts/build-root.js", "package.json is missing build:root");
  assert(packageSource.scripts.build === "npm run build:root", "package.json build must delegate to the TypeScript root build");
  assert(packageSource.scripts["qa:mobile:build"] === "node scripts/build-mobile-qa.js", "package.json is missing the mobile QA staging build");
  assert(packageSource.scripts["qa:mobile:probe"] === "node scripts/android-mobile-qa.js probe", "package.json is missing the Android mobile QA capability probe");
  assert(packageSource.scripts["qa:mobile"] === "node scripts/android-mobile-qa.js run", "package.json is missing the Android mobile QA runner");
  assert(packageSource.scripts["qa:mobile:pull-report"] === "node scripts/android-mobile-qa.js pull-report", "package.json is missing the Android mobile QA report pull command");
  assert(packageSource.scripts["test:ts"].includes("verify:mobile-qa-matrix") && packageSource.scripts["test:ts"].includes("test:mobile-qa-contracts") && packageSource.scripts["test:ts"].includes("test:mobile-qa-session") && packageSource.scripts["test:ts"].includes("test:mobile-qa-runner") && packageSource.scripts["test:ts"].includes("test:mobile-qa-transport") && packageSource.scripts["test:ts"].includes("verify:mobile-qa-bundle-load"), "package.json test:ts must keep all mobile QA contracts blocking");
  assert(packageSource.scripts["verify:production-qa-exclusion"] === "node scripts/mobile-qa-bundle-contract.js", "package.json is missing the production mobile QA exclusion gate");
  assert(!packageSource.scripts["build:baseline"] && !packageSource.scripts["test:baseline"] && !packageSource.scripts.verify && !packageSource.scripts.extract, "byte-exact baseline recovery scripts must stay decommissioned");
  assert(packageSource.scripts["test:release"] === "npm test && npm run build:root && npm run verify:production-qa-exclusion && npm run verify:mobile-bundle-load && npm run verify:worker-codecs && npm run audit:policy:bundle && npm run verify:release && npm run verify:root-ts", "package.json test:release must build and verify deterministic release output");
  assert(packageSource.scripts["validate:license"] === "node scripts/validate-license.js", "package.json is missing validate:license");
  assert(packageSource.scripts["validate:readmes"] === "node scripts/validate-readme-locales.js" && packageSource.scripts.test.includes("npm run validate:readmes"), "package.json must keep localized README validation blocking in npm test");
  assert(packageSource.scripts["qa:i18n"] === "node scripts/validate-i18n.js" && packageSource.scripts.test.includes("npm run qa:i18n"), "package.json must keep interface localization QA blocking in npm test");
  assert(packageSource.scripts["audit:policy"] === "node scripts/audit-policy.js" && packageSource.scripts.test.includes("npm run audit:policy"), "package.json must keep the policy audit blocking in npm test");
  assert(packageSource.scripts["audit:policy:bundle"] === "node scripts/audit-policy.js --require-bundle" && packageSource.scripts["test:release"].includes("npm run audit:policy:bundle"), "Release tests must run the policy audit against the built production bundle");
  assert(packageSource.scripts["lint:eslint"] === "eslint src-ts/" && packageSource.scripts.test.includes("npm run lint:eslint"), "package.json must keep lint:eslint executable and wired into npm test");
  assert(packageSource.scripts["lint:obsidian"] === "node scripts/lint-obsidian.js" && packageSource.scripts.test.includes("npm run lint:obsidian"), "package.json must keep the Obsidian scanner executable and blocking in npm test");
  assert(eslintConfigSource.includes("\"@typescript-eslint/no-unnecessary-type-assertion\": \"error\""), "Standard ESLint must reject unnecessary type assertions");
  assert(eslintObsidianConfigSource.includes("recommendedWithLocalesEn") && eslintObsidianConfigSource.includes("src-ts/locales/en.json") && eslintObsidianConfigSource.includes('language: "json/json"') && eslintObsidianConfigSource.includes("sourcePrefix"), "Obsidian scanner config must cover the current recommended rules and layout-aware English locale source");
  assert(lintObsidianSource.includes("warningCount === 0") && lintObsidianSource.includes("errorCount === 0"), "Obsidian scanner wrapper must reject both errors and warnings");
  assert(packageSource.devDependencies["@jsquash/jpeg"], "package.json is missing @jsquash/jpeg");
  assert(packageSource.devDependencies["@jsquash/png"], "package.json is missing @jsquash/png");
  assert(packageSource.devDependencies["@types/node"] === "25.7.0", "@types/node must be pinned exactly for repeatable type checks");
  assert(packageSource.devDependencies.obsidian === "1.13.0", "obsidian API types must stay pinned to the reviewed 1.13.0 baseline");
  assert(packageSource.devDependencies["eslint-plugin-obsidianmd"] === "0.3.0", "eslint-plugin-obsidianmd must stay pinned to the reviewed 0.3.0 scanner baseline");
  assert(packageSource.devDependencies["@eslint/json"] === "0.14.0", "@eslint/json must stay pinned for English locale linting");
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
  if (isDevLayout) {
    assert(rootPackageSource.scripts.build === "npm --prefix source-recovery run build:root", "Root package.json build must delegate to the real source-recovery build");
    assert(rootPackageSource.scripts["qa:mobile:build"] === "npm --prefix source-recovery run qa:mobile:build", "Root package.json must delegate the mobile QA staging build");
    assert(rootPackageSource.scripts["qa:mobile:probe"] === "node source-recovery/scripts/android-mobile-qa.js probe" && rootPackageSource.scripts["qa:mobile"] === "node source-recovery/scripts/android-mobile-qa.js run" && rootPackageSource.scripts["qa:mobile:pull-report"] === "node source-recovery/scripts/android-mobile-qa.js pull-report", "Root package.json must expose the Android mobile QA transport");
    assert(rootPackageSource.scripts["qa:i18n"] === "npm --prefix source-recovery run qa:i18n", "Root package.json must expose the fast interface localization QA");
    assert(["plan", "check", "sync", "verify", "promote", "commit"].every((command) => rootPackageSource.scripts[`prod:${command}`] === `node dev-prod-toolkit/bin/dev-prod.mjs ${command} --config dev-prod-toolkit/local-image-compress.config.json`), "Root prod:* commands must use the tracked DEV/PROD toolkit");
    assert(rootPackageSource.scripts["prod:test"] === "npm --prefix dev-prod-toolkit test && npm run prod:legacy:test" && ["test", "plan", "check", "sync", "verify", "promote", "commit"].every((command) => rootPackageSource.scripts[`prod:legacy:${command}`]?.includes("scripts/prod-promotion")), "Root promotion tests must cover the toolkit while preserving explicit legacy rollback commands");
    assert(rootPackageSource.scripts.test === "npm run dev:test && npm run prod:test && npm --prefix source-recovery test" && rootPackageSource.scripts["test:release"] === "npm run dev:test && npm run prod:test && npm --prefix source-recovery run test:release", "Root package.json test scripts must run DEV deployment tests, promotion tests, and delegate to source-recovery");
  } else {
    assert(rootPackageSource.scripts.build === "npm run build:root", "Standalone package.json build must use the local source build");
    assert(rootPackageSource.scripts["qa:mobile:build"] === "node scripts/build-mobile-qa.js", "Standalone package.json must expose the mobile QA staging build");
    assert(rootPackageSource.scripts["qa:mobile:probe"] === "node scripts/android-mobile-qa.js probe" && rootPackageSource.scripts["qa:mobile"] === "node scripts/android-mobile-qa.js run" && rootPackageSource.scripts["qa:mobile:pull-report"] === "node scripts/android-mobile-qa.js pull-report", "Standalone package.json must expose the Android mobile QA transport");
    assert(rootPackageSource.scripts.test.includes("npm run test:ts") && rootPackageSource.scripts["test:release"].includes("npm run verify:release"), "Standalone package.json test scripts must run local source and release verification");
  }
  assert(Array.isArray(rootPackageSource.files) && JSON.stringify(rootPackageSource.files) === JSON.stringify(["manifest.json", "main.js", "styles.css"]), "Root package.json files allowlist must contain only Obsidian install artifacts");
  assert(!releaseWorkflowSource.includes("build/package.json") && !releaseWorkflowSource.includes("build/README.md") && releaseWorkflowSource.includes("npm run test:release"), "Release workflow still ships dev package metadata or bypasses root test:release");
  assert(releaseWorkflowSource.includes('"*.*.*"') && releaseWorkflowSource.includes("^[0-9]+\\.[0-9]+\\.[0-9]+$") && !releaseWorkflowSource.includes('"v*"') && !releaseWorkflowSource.includes("GITHUB_REF_NAME#v"), "Release workflow does not combine a dotted tag trigger with exact numeric SemVer validation");
  assert((releaseWorkflowSource.match(/actions\/checkout@v6/g) || []).length === 2 && (releaseWorkflowSource.match(/actions\/setup-node@v6/g) || []).length === 2 && (releaseWorkflowSource.match(/node-version:\s*"24"/g) || []).length === 2, "Release workflow must use checkout/setup-node v6 and Node 24 in both jobs");
  const releasePrepareCommand = isDevLayout ? "npm --prefix source-recovery run prepare:release" : "npm run prepare:release";
  const releaseNotesCommand = isDevLayout ? "npm --prefix source-recovery run prepare:release-notes" : "npm run prepare:release-notes";
  assert(
    releaseWorkflowSource.includes(releasePrepareCommand)
      && prepareReleaseSource.includes('["manifest.json", "main.js", "styles.css"]')
      && !releaseWorkflowSource.includes("build/versions.json")
      && !prepareReleaseSource.includes('"versions.json"'),
    "Release workflow does not use the exact supported Obsidian install-file staging allowlist"
  );
  assert(releaseWorkflowSource.includes(releaseNotesCommand) && releaseWorkflowSource.includes("body_path: release-notes.md") && prepareReleaseNotesSource.includes('gitOutput(["log", "-1", "--format=%B", "HEAD"])') && prepareReleaseNotesSource.includes("Release commit message has no promoted DEV subjects"), "Release workflow must generate its body from the promoted PROD commit body");
  assert(validateManifestSource.includes("forbiddenReleaseEntries") && validateManifestSource.includes("package.json must declare a files allowlist"), "Manifest validation does not guard release packaging against dev artifact leaks");
  assert(validateManifestSource.includes("MIN_API_SURFACE_APP_VERSION") && validateManifestSource.includes("activeWindow/activeDocument/getBasePath"), "Manifest validation does not enforce API-surface minAppVersion");
  assert(validateManifestSource.includes("manifest.json authorUrl must be a valid URL") && validateManifestSource.includes("must not point to localhost"), "Manifest validation does not reject malformed or local authorUrl values");
  assert(validateManifestSource.includes("DESKTOP_ONLY_REQUIRED_REASON") && validateManifestSource.includes("DESKTOP_ONLY_API_PATTERNS") && validateManifestSource.includes("collectDesktopOnlyApiMatches") && manifestSource.isDesktopOnly === false, "Manifest validation does not derive isDesktopOnly from desktop-only API usage");
  assert(buildRootSource.includes("copyFileSync failed with EPERM") && buildRootSource.includes("writeFileSync fallback both failed") && buildRootSource.includes("post-copy SHA mismatch") && buildRootSource.includes("SHA-256"), "build-root.js does not warn on fallback failures or verify root main.js integrity");
  assert(
    buildRootSource.includes('"--production"')
      && buildRootSource.includes("assertProductionBundle")
      && buildTsSource.includes('process.argv.includes("--production")')
      && buildTsSource.includes('process.argv.includes("--qa")')
      && buildTsSource.includes("--production and --qa are mutually exclusive")
      && buildTsSource.includes("--define:__LIC_MOBILE_QA__=")
      && buildTsSource.includes("__LIC_MOBILE_QA__: mobileQa")
      && buildTsSource.includes("computeMobileQaSourceFingerprint")
      && mobileQaFingerprintSource.includes("package-lock.json")
      && mobileQaFingerprintSource.includes("wasm-hashes.json")
      && mobileQaFingerprintSource.includes("build-ts.js")
      && buildTsSource.includes("__LIC_MOBILE_QA_FINGERPRINT__"),
    "Build profiles do not keep production and mobile QA bundles isolated in both esbuild paths"
  );
  assert(
    buildMobileQaSource.includes('["main.js", "manifest.json", "styles.css"]')
      && buildMobileQaSource.includes("assertMobileQaBundle")
      && mobileQaBundleContractSource.includes("MOBILE_QA_EXCLUSION_TOKENS")
      && mobileQaBundleContractSource.includes("mobile-qa-src-[a-f0-9]{64}")
      && mobileQaBundleContractSource.includes("assertProductionBundle"),
    "Mobile QA staging or production exclusion contract is incomplete"
  );
  assert(
    androidMobileQaSource.includes('!/^[a-f0-9]{32}$/.test(sessionId)')
      && androidMobileQaSource.includes("Android transport rejected an invalid session id")
      && androidMobileQaTestSource.includes('"a".repeat(32)')
      && androidMobileQaTestSource.includes("invalid started session is cancelled"),
    "Android transport session identity drifted from the QA bridge contract"
  );
  assert(androidMobileQaSource.includes("requireCurrentStagedFingerprint") && androidMobileQaSource.includes("validateExpectedFingerprint"), "Android mobile QA does not bind reports to the current staged bundle");
  assert(buildTsSource.includes('"--loader:.wasm=binary"') && buildTsSource.includes('".wasm": "binary"'), "build-ts.js must keep WASM binary loader configured for both worker and main bundles");
  const directEsbuildViaNodePattern = /execFileSync\s*\(\s*process\.execPath\s*,\s*\[\s*(?:require\.resolve\(["']esbuild\/bin\/esbuild["']\)|esbuildCli)/;
  const directEsbuildViaNodeScripts = fs.readdirSync(path.join(root, "scripts"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .filter((entry) => directEsbuildViaNodePattern.test(fs.readFileSync(path.join(root, "scripts", entry.name), "utf8")))
    .map((entry) => entry.name);
  assert(
    directEsbuildViaNodeScripts.length === 0
      && runEsbuildCliSource.includes("prefix[0] === 0x23 && prefix[1] === 0x21")
      && runEsbuildCliSource.includes("isJavaScriptLauncher ? process.execPath : esbuildCli"),
    `esbuild CLI launchers must run through the cross-platform helper, not Node directly: ${directEsbuildViaNodeScripts.join(", ")}`
  );
  assert(rootPackageSource.files.includes("main.js") && !rootPackageSource.files.some((filePath) => filePath.endsWith(".wasm")), "Release package must keep WASM inline in the self-contained main.js bundle");
  assert(verifyReleaseSource.includes("Production build is not deterministic") && verifyReleaseSource.includes("lineCount > 100") && verifyReleaseSource.includes("sourceMappingURL="), "Release verification is missing determinism or minification/source-map guards");
  assert(verifyReleaseSource.includes("assertProductionBundle"), "Release verification does not reject mobile QA tokens");
  assert(/^mobile-qa-build\/$/m.test(gitignoreSource), "Mobile QA staging output must stay ignored");
  assert(/^\.local-image-compress-qa\/$/m.test(gitignoreSource) && /^Local Image Compress QA\/$/m.test(gitignoreSource) && /^QA-LIC-Mobile-\*\/$/m.test(gitignoreSource), "Mobile QA Vault state, reports, and session roots must stay ignored");
  for (const token of [
    isDevLayout ? "source-recovery/src-ts" : "src-ts",
    "Root `main.js` is generated, ignored",
    "verify:root-ts",
    "production-minified",
    "exact numeric SemVer",
    "manifest.json",
    "versions.json"
  ]) {
    assert(releasePolicySource.includes(token), `RELEASE_POLICY.md is missing release policy token: ${token}`);
  }
  assert(
    classWideGatesSource.includes("addEmptyCatchFindings")
      && classWideGatesSource.includes("addDuplicateCssDeclarationFindings")
      && classWideGatesSource.includes("duplicate-css-property")
      && classWideGatesSource.includes("--self-test")
      && classWideGatesSource.includes("multiline empty catch"),
    "class-wide-gates.js does not guard multiline empty catches and duplicate CSS properties"
  );
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
  assert(
    licenseSource.startsWith("GNU GENERAL PUBLIC LICENSE")
      && licenseSource.includes("END OF TERMS AND CONDITIONS")
      && licenseSource.includes("How to Apply These Terms to Your New Programs")
      && !licenseSource.includes("libimagequant"),
    "LICENSE must remain the canonical recognizable GPL text"
  );
  assert(
    validateLicenseSource.includes("FB981668C18A279E285FC4D83FBA1E836CC84DD4DAA73C9697D3CFD2D8ACA6E0")
      && validateLicenseSource.includes("licenses/imagequant.txt")
      && validateLicenseSource.includes("installedImagequantLicense"),
    "License validation must pin the canonical GPL text and the exact imagequant license"
  );
  assert(auditPolicySource.includes("Policy audit passed") && auditPolicySource.includes("expectedFullVaultScans") && auditPolicySource.includes("expectedFsBoundaryFiles"), "Policy audit is missing blocking source/filesystem inventory guards");
  if (obsidianReleaseAuditSource) {
    assert(
      obsidianReleaseAuditSource.includes(`Manifest/package are \`${manifestSource.version}\``)
        && obsidianReleaseAuditSource.includes(`\`isDesktopOnly: ${manifestSource.isDesktopOnly}\``)
        && obsidianReleaseAuditSource.includes("exactly `manifest.json`, `main.js`, and `styles.css`")
        && obsidianReleaseAuditSource.includes("`versions.json` remains repository compatibility metadata")
        && obsidianReleaseAuditSource.includes("iOS and Android device QA remains required")
        && obsidianReleaseAuditSource.includes("Dormant vendor fallbacks"),
      "OBSIDIAN_RELEASE_AUDIT.md does not match the current manifest, install allowlist, or mobile QA status"
    );
  }
  if (releaseReadinessSource) {
    assert(releaseReadinessSource.includes("Checked: 2026-06-09") && releaseReadinessSource.includes("Exact ID matches: 0") && releaseReadinessSource.includes("Historical tags"), "Release readiness audit is missing dated uniqueness or historical-tag evidence");
  }
  for (const token of ["Network", "Telemetry and ads", "Accounts and payments", "External files", "Other plugins"]) {
    assert(readmeSource.includes(token), `README.md is missing policy disclosure: ${token}`);
  }
  for (const token of ["Сеть", "Телеметрия и реклама", "Учётные записи и платежи", "Внешние файлы", "Другие плагины"]) {
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

  // Mobile hash parity: js-md5/js-sha256 must produce byte-identical hex to
  // Node crypto so cache fingerprints stay stable across desktop and mobile.
  {
    const { md5: jsMd5 } = require("js-md5");
    const { sha256: jsSha256 } = require("js-sha256");
    const parityBuffers = [
      new Uint8Array(0),
      new Uint8Array(Buffer.from("abc")),
      new Uint8Array(Buffer.from("тест 🙂 unicode\n")),
      new Uint8Array(crypto.randomBytes(1024)),
      new Uint8Array(crypto.randomBytes(5 * 1024 * 1024))
    ];
    for (const bytes of parityBuffers) {
      assert.equal(jsMd5(bytes), crypto.createHash("md5").update(bytes).digest("hex"), `js-md5 parity failed for ${bytes.byteLength} bytes`);
      assert.equal(jsSha256(bytes), crypto.createHash("sha256").update(bytes).digest("hex"), `js-sha256 parity failed for ${bytes.byteLength} bytes`);
    }
    const parityFingerprint = "images/один.png\n0123456789abcdef0123456789abcdef\n1712345678901";
    assert.equal(
      jsSha256(parityFingerprint),
      crypto.createHash("sha256").update(parityFingerprint).digest("hex"),
      "js-sha256 parity failed for utf8 string input"
    );
  }

  return { englishLocale, bugResearchPath, removedTechnicalSettingKeys };
}

module.exports = { runSourceContractChecks };
