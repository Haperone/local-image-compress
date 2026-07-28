import type { LocalImageCompressSettings } from "../settings";

export const MOBILE_QA_COMMAND_ID = "run-mobile-runtime-qa";
export const MOBILE_QA_BRIDGE_KEY = "__LIC_MOBILE_QA_RUN__";
export const MOBILE_QA_SESSION_PREFIX = "QA-LIC-Mobile-";
export const MOBILE_QA_REPORT_SCHEMA = "local-image-compress-mobile-qa-report/v1";
export const MOBILE_QA_PROGRESS_SCHEMA = "local-image-compress-mobile-qa-progress/v1";
export const MOBILE_QA_JOURNAL_SCHEMA = "local-image-compress-mobile-qa-session/v1";
export const MOBILE_QA_MARKER_PATH = ".local-image-compress-qa/qa-vault-marker.json";
export const MOBILE_QA_STATE_SUBPATH = "qa-backups/mobile";
export const MOBILE_QA_REPORT_ROOT = "Local Image Compress QA/reports";

export type MobileQaProfile = "android" | "ios";
export type MobileQaCheckStatus = "pass" | "fail" | "skip";
export type MobileQaSessionPhase = "prepared" | "running" | "restoring" | "completed";
export type MobileQaRunState = "running" | "passed" | "failed" | "cancelled";

export type MobileQaCapabilities = {
  mobileFs: boolean;
  atomicText: boolean;
  revealPath: boolean;
  mobileRibbon: boolean;
  touchDom: boolean;
  popoutWindow: boolean;
  desktopStatusBar: boolean;
};

export type MobileQaVaultMarker = {
  schemaVersion: 1;
  purpose: "local-image-compress-mobile-qa";
  allowDestructiveQa: true;
  vaultId: string;
};

export type MobileQaCheckResult = {
  id: string;
  name: string;
  status: MobileQaCheckStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  details?: Record<string, unknown>;
  error?: string;
  skipReason?: string;
};

export type MobileQaProgress = {
  schema: typeof MOBILE_QA_PROGRESS_SCHEMA;
  sessionId: string;
  phase: MobileQaSessionPhase;
  currentCheck: string | null;
  completed: number;
  total: number;
  updatedAt: string;
};

export type MobileQaCacheSnapshot = {
  cacheFile: string;
  existed: boolean;
  sha256: string | null;
};

export type MobileQaOwnedFile = {
  path: string;
  sha256: string;
};

export type MobileQaSessionJournal = {
  schema: typeof MOBILE_QA_JOURNAL_SCHEMA;
  deviceOwnerId: string;
  vaultId: string;
  sessionId: string;
  profile: MobileQaProfile;
  phase: MobileQaSessionPhase;
  sessionRoot: string;
  stateRoot: string;
  progressPath: string;
  progressSha256: string | null;
  reportJsonPath: string;
  reportTextPath: string;
  createdAt: string;
  updatedAt: string;
  settingsPersistence: "memory-only";
  cacheIsolation: "hidden-session-state";
  settingsSnapshotSha256: string;
  cacheSnapshot: MobileQaCacheSnapshot;
  ownedFiles: MobileQaOwnedFile[];
  ownedDirectories: string[];
  intentionallyRetainedArtifacts: string[];
};

export type MobileQaJournalEnvelope = {
  journal: MobileQaSessionJournal;
  sha256: string;
};

export type MobileQaCleanupResult = {
  status: "pass" | "fail" | "deferred";
  settingsRestored: boolean;
  productCacheUntouched: boolean;
  sessionRootRemoved: boolean;
  retainedArtifacts: string[];
  errors: string[];
};

export type MobileQaRecoveryResult = {
  status: "not-required" | "pass" | "fail";
  recoveredSessions: number;
  retainedJournals: string[];
  errors: string[];
};

export type MobileQaReport = {
  schema: typeof MOBILE_QA_REPORT_SCHEMA;
  pluginVersion: string;
  appVersion: string;
  platform: "mobile";
  profile: MobileQaProfile;
  buildFingerprint: string;
  deviceOwnerId: string;
  vaultId: string;
  sessionId: string;
  phase: MobileQaSessionPhase;
  startedAt: string;
  updatedAt: string;
  finishedAt: string;
  durationMs: number;
  capabilities: MobileQaCapabilities;
  checks: MobileQaCheckResult[];
  warnings: string[];
  settingsSnapshotSha256: string;
  cacheSnapshotSha256: string | null;
  cleanup: MobileQaCleanupResult;
  recovery: MobileQaRecoveryResult;
  summary: {
    passed: number;
    failed: number;
    skipped: number;
    cancelled: boolean;
    success: boolean;
  };
};

export type MobileQaBridgeStatus = {
  sessionId: string;
  state: MobileQaRunState;
  phase: MobileQaSessionPhase;
  currentCheck: string | null;
  completed: number;
  total: number;
  reportReady: boolean;
};

export interface MobileQaBridge {
  version: 1;
  start(): Promise<{ sessionId: string }>;
  status(sessionId: string): Promise<MobileQaBridgeStatus>;
  report(sessionId: string): Promise<MobileQaReport>;
  latestReport(): Promise<MobileQaReport | null>;
  cancel(sessionId: string, reason: string): Promise<void>;
}

export function cloneSettings(settings: LocalImageCompressSettings): LocalImageCompressSettings {
  return {
    ...settings,
    pngQuality: { ...settings.pngQuality },
    allowedRoots: [...settings.allowedRoots]
  };
}

export function getMobileQaStorageRoot(pluginDirectory: string): string {
  return `${pluginDirectory.replace(/\/+$/, "")}/${MOBILE_QA_STATE_SUBPATH}`;
}

export function getMobileQaJournalPath(pluginDirectory: string, deviceOwnerId: string, sessionId: string): string {
  return `${getMobileQaStorageRoot(pluginDirectory)}/${deviceOwnerId}/${sessionId}.json`;
}

export function getMobileQaProgressPath(pluginDirectory: string, deviceOwnerId: string, sessionId: string): string {
  return `${getMobileQaStorageRoot(pluginDirectory)}/${deviceOwnerId}/runtime-qa-progress-${sessionId}.json`;
}

export function getMobileQaStateRoot(pluginDirectory: string, deviceOwnerId: string, sessionId: string): string {
  return `${getMobileQaStorageRoot(pluginDirectory)}/${deviceOwnerId}/${sessionId}.state`;
}

export function sanitizeMobileQaMessage(message: unknown, sessionRoot: string): string {
  let sanitized = message instanceof Error ? message.message : String(message);
  if (sessionRoot) {
    sanitized = sanitized.split(sessionRoot).join("$QA_ROOT");
  }
  sanitized = sanitized
    .replace(/\b(?:content|file):\/\/[^\r\n\t"']+/gi, "<redacted-uri>")
    .replace(/[A-Za-z]:[\\/][^\r\n\t"']+/g, "<redacted-path>")
    .replace(/\\\\[^\\\s]+\\[^\r\n\t"']+/g, "<redacted-path>")
    .replace(/\/(?:private\/var\/mobile|var\/mobile|storage|sdcard|mnt|data\/user|data\/data|Users)\/[^\r\n\t"']+/g, "<redacted-path>");
  return sanitized.slice(0, 1500);
}

export function formatMobileQaTextReport(report: MobileQaReport): string {
  const lines = [
    `Schema: ${report.schema}`,
    `Session: ${report.sessionId}`,
    `Build: ${report.buildFingerprint}`,
    `Profile: ${report.profile}`,
    `Started: ${report.startedAt}`,
    `Finished: ${report.finishedAt}`,
    `Result: ${report.summary.success ? "PASS" : "FAIL"}`,
    `Cleanup: ${report.cleanup.status}`,
    `Recovery: ${report.recovery.status}`,
    `Checks: ${report.summary.passed} pass, ${report.summary.failed} fail, ${report.summary.skipped} skip`,
    ""
  ];
  for (const check of report.checks) {
    const suffix = check.status === "skip"
      ? ` — ${check.skipReason || "missing skip reason"}`
      : check.status === "fail"
        ? ` — ${check.error || "unknown failure"}`
        : "";
    lines.push(`[${check.status.toUpperCase()}] ${check.id} ${check.name}${suffix}`);
  }
  if (report.cleanup.errors.length > 0) {
    lines.push("", "Cleanup errors:", ...report.cleanup.errors.map((error) => `- ${error}`));
  }
  return `${lines.join("\n")}\n`;
}
