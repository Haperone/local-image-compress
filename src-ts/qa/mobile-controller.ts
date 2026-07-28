import { Modal, Notice, Platform, Setting, type App } from "obsidian";
import type LocalImageCompressPlugin from "../plugin";
import { randomHexSuffix } from "../utils";
import {
  MOBILE_QA_BRIDGE_KEY,
  MOBILE_QA_COMMAND_ID,
  MOBILE_QA_REPORT_ROOT,
  MOBILE_QA_REPORT_SCHEMA,
  sanitizeMobileQaMessage,
  type MobileQaBridge,
  type MobileQaBridgeStatus,
  type MobileQaProfile,
  type MobileQaProgress,
  type MobileQaRecoveryResult,
  type MobileQaReport,
  type MobileQaRunState,
  type MobileQaSessionPhase
} from "./contracts";
import { detectMobileQaCapabilities, MobileQaRunner } from "./mobile-runner";
import { getMobileQaDeviceOwnerId, MobileQaSessionStore } from "./session";
export { MobileQaSessionStore } from "./session";

type QaPluginWithBridge = LocalImageCompressPlugin & {
  __LIC_MOBILE_QA_RUN__?: MobileQaBridge;
};

type MobileQaRunRecord = {
  sessionId: string;
  state: MobileQaRunState;
  phase: MobileQaSessionPhase;
  currentCheck: string | null;
  completed: number;
  total: number;
  report: MobileQaReport | null;
  failure: string | null;
  cancelRequested: boolean;
  completion: Promise<void>;
  execution: Promise<void> | null;
  progressNotice: Notice | null;
};

type ActiveQaCarrier = {
  controller: MobileQaController;
  sessionId: string;
};

const ACTIVE_QA_SYMBOL = Symbol.for("local-image-compress.mobile-qa-active-v1");
type WindowWithActiveQa = Window & { [ACTIVE_QA_SYMBOL]?: ActiveQaCarrier };

class MobileQaConfirmationModal extends Modal {
  private resolved = false;

  constructor(app: App, private readonly resolveChoice: (confirmed: boolean) => void) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle("Run mobile runtime qa?");
    this.contentEl.createEl("p", {
      text: "This creates synthetic images, isolated cache data, compressed outputs, move backups, and reports in the marked qa vault. Do not run it in a personal vault."
    });
    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText("Cancel")
        .onClick(() => this.finish(false)))
      .addButton((button) => button
        .setButtonText("Run qa")
        .setCta()
        .onClick(() => this.finish(true)));
  }

  override onClose(): void {
    this.contentEl.empty();
    if (!this.resolved) {
      this.resolved = true;
      this.resolveChoice(false);
    }
  }

  private finish(confirmed: boolean): void {
    if (this.resolved) {
      return;
    }
    this.resolved = true;
    this.resolveChoice(confirmed);
    this.close();
  }
}

export class MobileQaController {
  private readonly runs = new Map<string, MobileQaRunRecord>();
  private readonly ownerWindow: Window;
  private deviceOwnerId = "";
  private profile: MobileQaProfile | null = null;
  private recovery: MobileQaRecoveryResult = {
    status: "not-required",
    recoveredSessions: 0,
    retainedJournals: [],
    errors: []
  };
  private recoveryBlock: string | null = null;
  private disposed = false;
  private startInProgress = false;
  private commandRunInProgress = false;
  private confirmationModal: MobileQaConfirmationModal | null = null;

  constructor(private readonly plugin: LocalImageCompressPlugin) {
    this.ownerWindow = plugin.getActiveWindow();
  }

  async initialize(): Promise<void> {
    this.profile = this.resolveProfile();
    const active = (this.ownerWindow as WindowWithActiveQa)[ACTIVE_QA_SYMBOL];
    if (active && active.controller !== this) {
      this.recoveryBlock = "A mobile QA operation from the previous plugin instance is still settling. Fully restart Obsidian before recovery or another run.";
      this.registerSurfaces();
      return;
    }
    try {
      this.deviceOwnerId = await getMobileQaDeviceOwnerId(this.ownerWindow);
    } catch (error) {
      this.recoveryBlock = sanitizeMobileQaMessage(error, "");
      this.registerSurfaces();
      return;
    }
    if (this.disposed || this.plugin.isUnloading) {
      return;
    }
    const store = new MobileQaSessionStore(this.plugin, this.plugin.getPlatformPorts(), this.deviceOwnerId);
    try {
      await store.assertVaultMarker();
    } catch {
      // A marker is required at run time, but its absence must not break plugin loading.
      this.registerSurfaces();
      return;
    }
    if (this.disposed || this.plugin.isUnloading) {
      return;
    }
    try {
      this.recovery = await store.recoverOwnedSessions(this.profile);
      if (this.recovery.status === "fail") {
        this.recoveryBlock = "Mobile QA recovery retained ambiguous safety state. Inspect the retained journal before running again.";
      } else if (this.recovery.recoveredSessions > 0) {
        new Notice(`Local Image Compress: recovered ${this.recovery.recoveredSessions} interrupted mobile QA session(s).`);
      }
    } catch (error) {
      this.recoveryBlock = sanitizeMobileQaMessage(error, "");
    }
    if (this.disposed || this.plugin.isUnloading) {
      return;
    }
    this.registerSurfaces();
  }

  dispose(): void {
    this.disposed = true;
    this.confirmationModal?.close();
    this.confirmationModal = null;
    for (const record of this.runs.values()) {
      if (record.state === "running") {
        record.cancelRequested = true;
      }
      record.progressNotice?.hide();
    }
    const pluginWithBridge: QaPluginWithBridge = this.plugin;
    Reflect.deleteProperty(pluginWithBridge, MOBILE_QA_BRIDGE_KEY);
  }

  private registerSurfaces(): void {
    if (this.disposed || this.plugin.isUnloading) {
      return;
    }
    const bridge: MobileQaBridge = {
      version: 1,
      start: async () => await this.start(),
      status: async (sessionId) => this.status(sessionId),
      report: async (sessionId) => await this.report(sessionId),
      latestReport: async () => await this.latestReport(),
      cancel: async (sessionId, reason) => await this.cancel(sessionId, reason)
    };
    const pluginWithBridge: QaPluginWithBridge = this.plugin;
    pluginWithBridge.__LIC_MOBILE_QA_RUN__ = bridge;
    this.plugin.addCommand({
      id: MOBILE_QA_COMMAND_ID,
      name: "Run mobile runtime qa",
      callback: async () => await this.runFromCommand()
    });
    this.plugin.register(() => this.dispose());
  }

  private async runFromCommand(): Promise<void> {
    if (this.disposed || this.plugin.isUnloading || this.commandRunInProgress) {
      return;
    }
    this.commandRunInProgress = true;
    try {
      if (this.recoveryBlock) {
        new Notice(`Local Image Compress: ${this.recoveryBlock}`, 10000);
        return;
      }
      const store = new MobileQaSessionStore(this.plugin, this.plugin.getPlatformPorts(), this.deviceOwnerId);
      try {
        await store.assertVaultMarker();
      } catch (error) {
        if (!this.disposed && !this.plugin.isUnloading) {
          new Notice(`Local Image Compress: ${sanitizeMobileQaMessage(error, "")}`, 10000);
        }
        return;
      }
      if (this.disposed || this.plugin.isUnloading) {
        return;
      }
      const confirmed = await new Promise<boolean>((resolve) => {
        const modal = new MobileQaConfirmationModal(this.plugin.app, (choice) => {
          if (this.confirmationModal === modal) {
            this.confirmationModal = null;
          }
          resolve(choice);
        });
        this.confirmationModal = modal;
        modal.open();
      });
      if (!confirmed || this.disposed || this.plugin.isUnloading) {
        return;
      }
      try {
        const { sessionId } = await this.start();
        const record = this.requireRun(sessionId);
        await record.completion;
        if (this.disposed || this.plugin.isUnloading) {
          return;
        }
        if (record.report) {
          const result = record.report.summary.success ? "passed" : "failed";
          new Notice(`Local Image Compress: mobile QA ${result}. Reports: ${MOBILE_QA_REPORT_ROOT}`, 12000);
        } else {
          new Notice(`Local Image Compress: mobile QA failed before a report could be saved. ${record.failure || ""}`, 12000);
        }
      } catch (error) {
        if (!this.disposed && !this.plugin.isUnloading) {
          new Notice(`Local Image Compress: ${sanitizeMobileQaMessage(error, "")}`, 12000);
        }
      }
    } finally {
      this.commandRunInProgress = false;
    }
  }

  private async start(): Promise<{ sessionId: string }> {
    if (this.disposed) {
      throw new Error("Mobile QA controller is unloaded");
    }
    if (this.recoveryBlock) {
      throw new Error(this.recoveryBlock);
    }
    if (!this.plugin.isInitialized) {
      throw new Error("Mobile QA cannot start before plugin initialization completes");
    }
    if (this.startInProgress) {
      throw new Error("Another mobile QA start is already being prepared");
    }
    const carrier = this.ownerWindow as WindowWithActiveQa;
    if (carrier[ACTIVE_QA_SYMBOL]) {
      throw new Error(`Another mobile QA session is active: ${carrier[ACTIVE_QA_SYMBOL].sessionId}`);
    }
    this.startInProgress = true;
    try {
      const profile = this.profile;
      if (!profile) {
        throw new Error("Mobile QA platform profile is unavailable");
      }
      const store = new MobileQaSessionStore(this.plugin, this.plugin.getPlatformPorts(), this.deviceOwnerId);
      await store.assertVaultMarker();
      this.assertStartStillOwned(carrier);
      this.recovery = await store.recoverOwnedSessions(profile);
      this.assertStartStillOwned(carrier);
      if (this.recovery.status === "fail") {
        this.recoveryBlock = "Mobile QA recovery retained ambiguous safety state. Inspect the retained journal before running again.";
        throw new Error(this.recoveryBlock);
      }
      const sessionId = await randomHexSuffix(16);
      this.assertStartStillOwned(carrier);
      let resolveCompletion!: () => void;
      const completion = new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      });
      const record: MobileQaRunRecord = {
        sessionId,
        state: "running",
        phase: "prepared",
        currentCheck: null,
        completed: 0,
        total: 0,
        report: null,
        failure: null,
        cancelRequested: false,
        completion,
        execution: null,
        progressNotice: new Notice("Local image compress: preparing mobile qa…", 0)
      };
      this.runs.set(sessionId, record);
      carrier[ACTIVE_QA_SYMBOL] = { controller: this, sessionId };
      record.execution = this.execute(record, resolveCompletion);
      return { sessionId };
    } finally {
      this.startInProgress = false;
    }
  }

  private assertStartStillOwned(carrier: WindowWithActiveQa): void {
    if (this.disposed || this.plugin.isUnloading || !this.plugin.isInitialized) {
      throw new Error("Mobile QA controller was unloaded during start preflight");
    }
    if (carrier[ACTIVE_QA_SYMBOL]) {
      throw new Error(`Another mobile QA session became active during start preflight: ${carrier[ACTIVE_QA_SYMBOL].sessionId}`);
    }
  }

  private async execute(record: MobileQaRunRecord, resolveCompletion: () => void): Promise<void> {
    try {
      const ports = this.plugin.getPlatformPorts();
      const profile = this.profile;
      if (!profile) {
        throw new Error("Mobile QA platform profile is unavailable");
      }
      const runner = new MobileQaRunner({
        plugin: this.plugin,
        ports,
        profile,
        capabilities: detectMobileQaCapabilities(this.plugin, ports),
        deviceOwnerId: this.deviceOwnerId,
        sessionId: record.sessionId,
        recovery: this.recovery,
        isCancellationRequested: () => record.cancelRequested || this.disposed,
        onProgress: async (progress) => this.applyProgress(record, progress)
      });
      record.report = await runner.run();
      record.phase = record.report.phase;
      if (record.report.cleanup.status !== "pass") {
        this.recoveryBlock = "Mobile QA cleanup retained safety state. Reload the plugin before another run.";
      }
      record.state = record.report.summary.cancelled
        ? "cancelled"
        : record.report.summary.success
          ? "passed"
          : "failed";
    } catch (error) {
      record.failure = sanitizeMobileQaMessage(error, "");
      record.state = record.cancelRequested ? "cancelled" : "failed";
      this.recoveryBlock = "Mobile QA stopped before clean completion. Reload the plugin before another run.";
    } finally {
      record.progressNotice?.hide();
      record.progressNotice = null;
      const carrier = this.ownerWindow as WindowWithActiveQa;
      if (carrier[ACTIVE_QA_SYMBOL]?.controller === this && carrier[ACTIVE_QA_SYMBOL]?.sessionId === record.sessionId) {
        Reflect.deleteProperty(carrier, ACTIVE_QA_SYMBOL);
      }
      resolveCompletion();
    }
  }

  private applyProgress(record: MobileQaRunRecord, progress: MobileQaProgress): void {
    record.phase = progress.phase;
    record.currentCheck = progress.currentCheck;
    record.completed = progress.completed;
    record.total = progress.total;
    record.progressNotice?.setMessage(
      progress.currentCheck
        ? `Local Image Compress: mobile QA ${progress.currentCheck} (${progress.completed}/${progress.total})`
        : `Local Image Compress: mobile QA ${progress.phase}`
    );
  }

  private status(sessionId: string): MobileQaBridgeStatus {
    const record = this.requireRun(sessionId);
    return {
      sessionId,
      state: record.state,
      phase: record.phase,
      currentCheck: record.currentCheck,
      completed: record.completed,
      total: record.total,
      reportReady: record.report !== null
    };
  }

  private async report(sessionId: string): Promise<MobileQaReport> {
    const record = this.runs.get(sessionId);
    if (record?.report) {
      return record.report;
    }
    const diskReport = await this.readLatestReport(sessionId);
    if (diskReport) {
      return diskReport;
    }
    throw new Error(record?.failure || `Mobile QA report is not ready: ${sessionId}`);
  }

  private async latestReport(): Promise<MobileQaReport | null> {
    const inMemory = Array.from(this.runs.values()).reverse().find((record) => record.report)?.report;
    return inMemory || await this.readLatestReport(null);
  }

  private async cancel(sessionId: string, reason: string): Promise<void> {
    const record = this.requireRun(sessionId);
    if (record.state !== "running") {
      return;
    }
    record.cancelRequested = true;
    record.failure = `Cancelled by transport: ${sanitizeMobileQaMessage(reason, "")}`;
  }

  private requireRun(sessionId: string): MobileQaRunRecord {
    const record = this.runs.get(sessionId);
    if (!record) {
      throw new Error(`Unknown mobile QA session: ${sessionId}`);
    }
    return record;
  }

  private async readLatestReport(sessionId: string | null): Promise<MobileQaReport | null> {
    const ports = this.plugin.getPlatformPorts();
    let vaultId: string;
    try {
      vaultId = (await new MobileQaSessionStore(this.plugin, ports, this.deviceOwnerId).assertVaultMarker()).vaultId;
    } catch {
      return null;
    }
    if (!await ports.fs.exists(MOBILE_QA_REPORT_ROOT)) {
      return null;
    }
    const names = (await ports.fs.listNames(MOBILE_QA_REPORT_ROOT))
      .filter((name) => name.startsWith("runtime-qa-report-") && name.endsWith(".json"))
      .filter((name) => sessionId === null || name.includes(`-${sessionId}.json`))
      .sort()
      .reverse();
    for (const name of names) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await ports.fs.readText(`${MOBILE_QA_REPORT_ROOT}/${name}`));
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      const report = parsed as MobileQaReport;
      const identityValid = report.schema === MOBILE_QA_REPORT_SCHEMA
        && report.platform === "mobile"
        && report.profile === this.profile
        && typeof report.pluginVersion === "string"
        && report.pluginVersion.trim().length > 0
        && typeof report.appVersion === "string"
        && report.appVersion.trim().length > 0
        && report.appVersion !== "unknown"
        && report.buildFingerprint === __LIC_MOBILE_QA_FINGERPRINT__
        && report.deviceOwnerId === this.deviceOwnerId
        && report.vaultId === vaultId
        && /^[a-f0-9]{32}$/.test(report.sessionId)
        && name.endsWith(`-${report.sessionId}.json`)
        && (sessionId === null || report.sessionId === sessionId)
        && Array.isArray(report.checks)
        && Array.isArray(report.warnings)
        && typeof report.summary?.success === "boolean"
        && typeof report.summary?.failed === "number"
        && typeof report.cleanup?.status === "string"
        && typeof report.recovery?.status === "string";
      if (!identityValid) {
        continue;
      }
      if (report.summary.success && (report.phase !== "completed"
        || report.summary.failed !== 0
        || report.warnings.length !== 0
        || report.checks.some((check) => check.status === "fail")
        || report.cleanup.status !== "pass"
        || report.recovery.status === "fail")) {
        continue;
      }
      return report;
    }
    return null;
  }

  private resolveProfile(): MobileQaProfile {
    if (Platform.isAndroidApp) {
      return "android";
    }
    if (Platform.isIosApp) {
      return "ios";
    }
    throw new Error("Mobile QA build can run only in the Android or iOS app");
  }
}

export async function initializeMobileQa(plugin: LocalImageCompressPlugin): Promise<void> {
  const controller = new MobileQaController(plugin);
  await controller.initialize();
}
