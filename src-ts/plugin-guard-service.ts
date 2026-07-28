import * as obsidian from "obsidian";
import { t } from "./i18n";
import { INTERNAL_PLUGIN_GUARD_TIMEOUT_MS } from "./settings";
import { getLogTag, getPluginName } from "./utils";
import type LocalImageCompressPlugin from "./plugin";
import type { TimerHandle } from "./types";

interface PluginDisableGuard {
  generation: number;
  count: number;
  wasEnabled: boolean;
  disabledByGuard: boolean;
  observedEnabledAfterGuardDisable: boolean;
  monitorTimer: TimerHandle | null;
  releasing: boolean;
  ready: Promise<void>;
}

type InternalPluginRegistry = {
  enabledPlugins?: Set<string>;
  disablePlugin?: (id: string) => Promise<void> | void;
  enablePlugin?: (id: string) => Promise<void> | void;
};

type AppWithInternalPluginRegistry = obsidian.App & {
  plugins?: InternalPluginRegistry;
};

type PluginOperationOptions = {
  allowEnableRetry?: boolean;
  guardGeneration?: number;
  restoreAfterLateDisable?: boolean;
};

type SharedGuardClaim = {
  service: PluginGuardService;
  generation: number;
};

type SharedGuardRegistryState = {
  claimsById: Map<string, SharedGuardClaim[]>;
  operationQueuesById: Map<string, Promise<void>>;
};

const SHARED_GUARD_REGISTRY_STATE = Symbol.for("local-image-compress.plugin-guard-registry-state-v1");
type InternalPluginRegistryWithGuardState = InternalPluginRegistry & {
  [SHARED_GUARD_REGISTRY_STATE]?: SharedGuardRegistryState;
};

/**
 * Temporarily disables a small, explicit allow-list of third-party plugins for the
 * duration of a compression or move operation, then restores them.
 *
 * Reviewer note - why this uses the undocumented app.plugins.enable/disablePlugin:
 * The only guarded id is "obsidian-paste-image-rename" (see the plugin's
 * pluginsToDisableDuringCompression allow-list). That plugin registers a
 * vault.on("create") handler that fires for every image added to the vault within
 * ~1s of creation - unconditionally for names starting with "Pasted image ", and for
 * all images when its "Handle all attachments" option is enabled. While this plugin
 * writes compressed outputs, those fresh files trip that handler:
 *   - with an active Markdown view it renames our just-written output (which breaks the
 *     compressed -> original mapping the move step relies on) or opens a rename modal
 *     per file;
 *   - with no active Markdown view it shows an "Error: No active file found" notice for
 *     every created file, spamming the UI during batch runs.
 * Obsidian exposes no public/typed API for one plugin to ask another to pause, so the
 * only reliable mitigation is to disable that one plugin while the operation runs.
 *
 * The behavior is deliberately narrow and reversible:
 *   - it touches only ids in the plugin's pluginsToDisableDuringCompression allow-list,
 *     and only while an operation is in flight;
 *   - the allow-list is always guarded during compression and move operations because
 *     the output mapping depends on those writes not being renamed by another plugin;
 *   - it always restores what it disabled (with retries) and skips restore ownership if
 *     the plugin's enabled state changed externally during the operation.
 * The app.plugins access is feature-detected and every call degrades gracefully on
 * failure.
 */
export class PluginGuardService {
  private readonly plugin: LocalImageCompressPlugin;
  private readonly guards = new Map<string, PluginDisableGuard>();
  private readonly enableRetryTimers = new Map<string, TimerHandle>();
  private readonly operationTimeouts = new Map<TimerHandle, () => void>();
  private lifecycleGeneration = 0;
  private nextGuardGeneration = 0;
  private shuttingDown = false;
  operationTimeoutMs: number;

  constructor(plugin: LocalImageCompressPlugin) {
    this.plugin = plugin;
    this.operationTimeoutMs = INTERNAL_PLUGIN_GUARD_TIMEOUT_MS;
  }

  private getPluginRegistry(): InternalPluginRegistry | undefined {
    return (this.plugin.app as AppWithInternalPluginRegistry).plugins;
  }

  private getSharedRegistryState(): SharedGuardRegistryState | null {
    const registry = this.getPluginRegistry() as InternalPluginRegistryWithGuardState | undefined;
    if (!registry) {
      return null;
    }
    const existing = registry[SHARED_GUARD_REGISTRY_STATE];
    if (existing?.claimsById instanceof Map && existing.operationQueuesById instanceof Map) {
      return existing;
    }
    const state: SharedGuardRegistryState = {
      claimsById: new Map(),
      operationQueuesById: new Map()
    };
    Object.defineProperty(registry, SHARED_GUARD_REGISTRY_STATE, {
      configurable: false,
      enumerable: false,
      value: state,
      writable: false
    });
    return state;
  }

  private getSharedClaims(id: string): SharedGuardClaim[] {
    return this.getSharedRegistryState()?.claimsById.get(id) || [];
  }

  private hasSharedClaim(id: string, generation: number): boolean {
    return this.getSharedClaims(id).some((claim) => claim.service === this && claim.generation === generation);
  }

  private hasOtherSharedClaim(id: string, generation: number): boolean {
    return this.getSharedClaims(id).some((claim) => claim.service !== this || claim.generation !== generation);
  }

  private hasRegistryOperationInFlight(id: string): boolean {
    return this.getSharedRegistryState()?.operationQueuesById.has(id) === true;
  }

  private claimSharedGuard(id: string, generation: number): boolean {
    const state = this.getSharedRegistryState();
    if (!state) {
      return false;
    }
    const claimsById = state.claimsById;
    const claims = claimsById.get(id) || [];
    const concurrentWorkExists = claims.length > 0 || this.hasRegistryOperationInFlight(id);
    claims.push({ service: this, generation });
    claimsById.set(id, claims);
    return concurrentWorkExists;
  }

  private releaseSharedGuard(id: string, generation: number): void {
    const claimsById = this.getSharedRegistryState()?.claimsById;
    const claims = claimsById?.get(id);
    if (!claims || !claimsById) {
      return;
    }
    const remaining = claims.filter((claim) => claim.service !== this || claim.generation !== generation);
    if (remaining.length > 0) {
      claimsById.set(id, remaining);
    } else {
      claimsById.delete(id);
    }
  }

  private transferRestoreOwnership(id: string, sourceGeneration: number): boolean {
    const claims = this.getSharedClaims(id);
    for (let index = claims.length - 1; index >= 0; index--) {
      const claim = claims[index];
      if (!claim || (claim.service === this && claim.generation === sourceGeneration)) {
        continue;
      }
      if (claim.service.acceptTransferredDisable(id, claim.generation)) {
        return true;
      }
    }
    return false;
  }

  private async compensateAfterLateEnable(id: string, sourceGeneration: number): Promise<void> {
    const claims = this.getSharedClaims(id);
    for (let index = claims.length - 1; index >= 0; index--) {
      const claim = claims[index];
      if (!claim || (claim.service === this && claim.generation === sourceGeneration)) {
        continue;
      }
      if (await claim.service.reassertGuardAfterLateEnable(id, claim.generation)) {
        return;
      }
    }
  }

  private async reassertGuardAfterLateEnable(id: string, generation: number): Promise<boolean> {
    const guard = this.guards.get(id);
    if (!guard || guard.generation !== generation || this.shuttingDown || !this.hasSharedClaim(id, generation)) {
      return false;
    }
    if (this.isPluginEnabled(id)) {
      await this.runPluginOperation(
        id,
        "disable",
        () => this.getPluginRegistry()?.disablePlugin?.(id),
        { guardGeneration: generation, restoreAfterLateDisable: true }
      );
    }
    if (this.isPluginEnabled(id)) {
      return false;
    }
    return this.acceptTransferredDisable(id, generation);
  }

  private acceptTransferredDisable(id: string, generation: number): boolean {
    const guard = this.guards.get(id);
    if (!guard || guard.generation !== generation || this.shuttingDown) {
      return false;
    }
    guard.wasEnabled = true;
    if (!guard.disabledByGuard) {
      guard.disabledByGuard = true;
      guard.observedEnabledAfterGuardDisable = false;
      this.startGuardStateMonitor(id, guard);
      this.showGuardNotice("guard.disabled", id);
    }
    return true;
  }

  private async runRegistryOperation<T>(
    id: string,
    operation: () => Promise<T> | T,
    releaseSignal?: Promise<void>,
    abandonedValue?: T
  ): Promise<T> {
    const state = this.getSharedRegistryState();
    if (!state) {
      return await operation();
    }
    const queuesById = state.operationQueuesById;
    const previous = queuesById.get(id) || Promise.resolve();
    let releaseQueue!: () => void;
    const queueTail = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    queuesById.set(id, queueTail);
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      releaseQueue();
      if (queuesById.get(id) === queueTail) {
        queuesById.delete(id);
      }
    };
    if (releaseSignal) {
      const reachedTurn = await Promise.race([
        previous.then(() => true),
        releaseSignal.then(() => false)
      ]);
      if (!reachedTurn) {
        release();
        return abandonedValue as T;
      }
    } else {
      await previous;
    }
    try {
      const operationPromise = Promise.resolve().then(operation);
      if (releaseSignal) {
        await Promise.race([
          operationPromise.then(() => undefined, () => undefined),
          releaseSignal
        ]);
        release();
      }
      return await operationPromise;
    } finally {
      release();
    }
  }

  async acquire(id: string): Promise<void> {
    while (true) {
      if (this.shuttingDown) {
        throw new Error(`Plugin guard is shut down: ${id}`);
      }
      const existingGuard = this.guards.get(id);
      if (!existingGuard) {
        const wasEnabled = !!this.getPluginRegistry()?.enabledPlugins?.has(id);
        const guard: PluginDisableGuard = {
          generation: ++this.nextGuardGeneration,
          count: 1,
          wasEnabled,
          disabledByGuard: false,
          observedEnabledAfterGuardDisable: false,
          monitorTimer: null,
          releasing: false,
          ready: Promise.resolve()
        };
        this.guards.set(id, guard);
        const concurrentGuardWork = this.claimSharedGuard(id, guard.generation);
        guard.ready = (async () => {
          if (wasEnabled || concurrentGuardWork) {
            const disabled = await this.runPluginOperation(
              id,
              "disable",
              () => this.getPluginRegistry()?.disablePlugin?.(id),
              { guardGeneration: guard.generation, restoreAfterLateDisable: wasEnabled }
            );
            if (disabled && !this.isPluginEnabled(id)) {
              const newlyOwned = !guard.disabledByGuard;
              guard.disabledByGuard = true;
              this.startGuardStateMonitor(id, guard);
              if (newlyOwned) {
                this.showGuardNotice("guard.disabled", id);
              }
            } else if (disabled) {
              console.debug(getLogTag(this.plugin), `Plugin ${id} was still enabled after guard disable; skipping restore ownership.`);
            }
          }
        })();
        try {
          await guard.ready;
        } catch (error) {
          if (this.guards.get(id) === guard) {
            this.guards.delete(id);
          }
          this.releaseSharedGuard(id, guard.generation);
          throw error;
        }
        return;
      }
      if (existingGuard.releasing) {
        try {
          await existingGuard.ready;
        } catch (error) {
          console.warn(getLogTag(this.plugin), `Previous plugin guard release failed for ${id}:`, error);
        }
        continue;
      }
      existingGuard.count++;
      try {
        await existingGuard.ready;
      } catch (error) {
        existingGuard.count = Math.max(0, existingGuard.count - 1);
        throw error;
      }
      return;
    }
  }

  async release(id: string): Promise<void> {
    const guard = this.guards.get(id);
    if (!guard) {
      return;
    }
    guard.count = Math.max(0, guard.count - 1);
    if (guard.count > 0) {
      return;
    }
    guard.releasing = true;
    const disableReady = guard.ready;
    guard.ready = (async () => {
      await disableReady;
      if (this.shouldRestoreGuardedPlugin(id, guard)) {
        const restored = await this.runPluginOperation(
          id,
          "enable",
          () => this.getPluginRegistry()?.enablePlugin?.(id),
          { guardGeneration: guard.generation }
        );
        if (this.hasOtherSharedClaim(id, guard.generation)) {
          this.transferRestoreOwnership(id, guard.generation);
        } else if (restored) {
          this.showGuardNotice("guard.restored", id);
        }
      }
    })();
    try {
      await guard.ready;
    } catch (error) {
      console.error(getLogTag(this.plugin), `Error enabling plugin ${id}:`, error);
    } finally {
      if (guard.count === 0) {
        this.stopGuardStateMonitor(guard);
        if (this.guards.get(id) === guard) {
          this.guards.delete(id);
        }
        this.releaseSharedGuard(id, guard.generation);
      }
    }
  }

  async releaseAllGuards(shutdown = false): Promise<void> {
    if (shutdown) {
      this.shutdownGuards();
      return;
    }
    if (this.shuttingDown) {
      return;
    }
    const guards = Array.from(this.guards.entries());
    await Promise.all(guards.map(async ([id, guard]) => {
      guard.count = 0;
      guard.releasing = true;
      try {
        await guard.ready;
      } catch (error) {
        console.warn(getLogTag(this.plugin), `Plugin guard was not ready during unload for ${id}:`, error);
      }
      try {
        if (this.shouldRestoreGuardedPlugin(id, guard)) {
          const restored = await this.runPluginOperation(
            id,
            "enable",
            () => this.getPluginRegistry()?.enablePlugin?.(id),
            { guardGeneration: guard.generation }
          );
          if (this.hasOtherSharedClaim(id, guard.generation)) {
            this.transferRestoreOwnership(id, guard.generation);
          } else if (restored) {
            this.showGuardNotice("guard.restored", id);
          }
        }
      } catch (error) {
        console.warn(getLogTag(this.plugin), `Failed to restore guarded plugin ${id} during unload:`, error);
      } finally {
        this.stopGuardStateMonitor(guard);
        if (this.guards.get(id) === guard) {
          this.guards.delete(id);
        }
        this.releaseSharedGuard(id, guard.generation);
      }
    }));
  }

  private isPluginEnabled(id: string) {
    return !!this.getPluginRegistry()?.enabledPlugins?.has(id);
  }

  private shouldRestoreGuardedPlugin(id: string, guard: PluginDisableGuard) {
    if (!guard.wasEnabled || !guard.disabledByGuard) {
      return false;
    }
    if (this.isPluginEnabled(id)) {
      return false;
    }
    if (guard.observedEnabledAfterGuardDisable) {
      console.debug(getLogTag(this.plugin), `Skipping restore for ${id}; plugin state changed during guard.`);
      return false;
    }
    return true;
  }

  private startGuardStateMonitor(id: string, guard: PluginDisableGuard) {
    this.stopGuardStateMonitor(guard);
    const poll = () => {
      if (this.shuttingDown || this.guards.get(id) !== guard || guard.releasing) {
        guard.monitorTimer = null;
        return;
      }
      if (guard.disabledByGuard && this.isPluginEnabled(id)) {
        guard.observedEnabledAfterGuardDisable = true;
      }
      guard.monitorTimer = typeof this.plugin.setWindowTimeout === "function"
        ? this.plugin.setWindowTimeout(poll, 250)
        : window.setTimeout(poll, 250);
    };
    guard.monitorTimer = typeof this.plugin.setWindowTimeout === "function"
      ? this.plugin.setWindowTimeout(poll, 250)
      : window.setTimeout(poll, 250);
  }

  private stopGuardStateMonitor(guard: PluginDisableGuard) {
    if (guard.monitorTimer === null) {
      return;
    }
    this.plugin.clearWindowTimeout(guard.monitorTimer);
    guard.monitorTimer = null;
  }

  showGuardNotice(key: "guard.disabled" | "guard.restored", id: string) {
    if (this.shuttingDown) {
      return;
    }
    new obsidian.Notice(`${getPluginName(this.plugin)}: ${t(this.plugin.app, key, { id })}`, 5000);
  }

  async runPluginOperation(
    id: string,
    action: "disable" | "enable",
    operation: () => Promise<boolean | void> | boolean | void,
    options: PluginOperationOptions = {}
  ): Promise<boolean> {
    const lifecycleGeneration = this.lifecycleGeneration;
    const allowEnableRetry = options.allowEnableRetry !== false;
    let timer: TimerHandle | null = null;
    let operationSucceeded = false;
    let operationTimedOut = false;
    let operationStarted = false;
    let releaseRegistryOperation!: () => void;
    const registryOperationReleaseSignal = new Promise<void>((resolve) => {
      releaseRegistryOperation = resolve;
    });
    const operationCompleted = Promise.resolve()
      .then(async () => {
        if (!this.isLifecycleActive(lifecycleGeneration)) {
          return false;
        }
        return await this.runRegistryOperation(id, async () => {
          if (!this.isLifecycleActive(lifecycleGeneration)) {
            return false;
          }
          if (options.guardGeneration !== undefined) {
            if (!this.hasSharedClaim(id, options.guardGeneration)) {
              return false;
            }
            if (action === "enable" && this.hasOtherSharedClaim(id, options.guardGeneration)) {
              return false;
            }
          }
          operationStarted = true;
          return await operation() !== false;
        }, registryOperationReleaseSignal, false);
      })
      .then(async (completed) => {
        const effectApplied = operationStarted && (action === "disable" ? !this.isPluginEnabled(id) : this.isPluginEnabled(id));
        operationSucceeded = completed && effectApplied;
        if (
          operationSucceeded
          && action === "disable"
          && options.guardGeneration !== undefined
          && options.restoreAfterLateDisable !== false
        ) {
          if (operationTimedOut && this.isLifecycleActive(lifecycleGeneration)) {
            await this.restoreAfterLateDisable(id, options.guardGeneration, lifecycleGeneration);
          } else if (this.shuttingDown && lifecycleGeneration !== this.lifecycleGeneration) {
            await this.restoreAfterShutdownLateDisable(id);
          }
        }
        if (
          operationSucceeded
          && action === "enable"
          && options.guardGeneration !== undefined
          && this.hasOtherSharedClaim(id, options.guardGeneration)
        ) {
          await this.compensateAfterLateEnable(id, options.guardGeneration);
        }
        return operationSucceeded;
      }, async (error) => {
        const effectApplied = operationStarted && (action === "disable" ? !this.isPluginEnabled(id) : this.isPluginEnabled(id));
        operationSucceeded = effectApplied;
        if (this.isLifecycleActive(lifecycleGeneration)) {
          console.warn(getLogTag(this.plugin), `Could not ${action} plugin ${id}:`, error);
        }
        if (
          effectApplied
          && action === "disable"
          && options.guardGeneration !== undefined
          && options.restoreAfterLateDisable !== false
        ) {
          if (operationTimedOut && this.isLifecycleActive(lifecycleGeneration)) {
            await this.restoreAfterLateDisable(id, options.guardGeneration, lifecycleGeneration);
          } else if (this.shuttingDown && lifecycleGeneration !== this.lifecycleGeneration) {
            await this.restoreAfterShutdownLateDisable(id);
          }
        }
        if (
          effectApplied
          && action === "enable"
          && options.guardGeneration !== undefined
          && this.hasOtherSharedClaim(id, options.guardGeneration)
        ) {
          await this.compensateAfterLateEnable(id, options.guardGeneration);
        }
        return effectApplied;
      });
    const timeout = new Promise<void>((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== null) {
          this.operationTimeouts.delete(timer);
        }
        releaseRegistryOperation();
        resolve();
      };
      const callback = () => {
        operationTimedOut = true;
        if (this.isLifecycleActive(lifecycleGeneration)) {
          console.warn(getLogTag(this.plugin), `Timed out while trying to ${action} plugin ${id}; continuing without waiting for that plugin.`);
        }
        settle();
      };
      timer = typeof this.plugin.setWindowTimeout === "function"
        ? this.plugin.setWindowTimeout(callback, this.operationTimeoutMs)
        : window.setTimeout(callback, this.operationTimeoutMs);
      this.operationTimeouts.set(timer, settle);
    });
    const timedOut = await Promise.race([
      operationCompleted.then(() => false),
      timeout.then(() => true)
    ]);
    if (timer !== null) {
      this.operationTimeouts.delete(timer);
      if (typeof this.plugin.clearWindowTimeout === "function") {
        this.plugin.clearWindowTimeout(timer);
      } else {
        window.clearTimeout(timer);
      }
    }
    if (timedOut && action === "enable" && allowEnableRetry && this.isLifecycleActive(lifecycleGeneration)) {
      this.scheduleEnableRetry(id);
    }
    return !timedOut && operationSucceeded;
  }

  scheduleEnableRetry(id: string): void {
    if (this.shuttingDown || this.enableRetryTimers.has(id)) {
      return;
    }
    const lifecycleGeneration = this.lifecycleGeneration;
    const retryDelayMs = Math.max(this.operationTimeoutMs * 2, 10_000);
    const retry = async () => {
      this.enableRetryTimers.delete(id);
      if (
        !this.isLifecycleActive(lifecycleGeneration)
        || this.guards.has(id)
        || this.getSharedClaims(id).length > 0
        || this.isPluginEnabled(id)
      ) {
        return;
      }
      try {
        const restored = await this.runPluginOperation(
          id,
          "enable",
          async () => {
            if (this.getSharedClaims(id).length > 0) {
              return false;
            }
            await this.getPluginRegistry()?.enablePlugin?.(id);
            return true;
          },
          { allowEnableRetry: false }
        );
        if (restored && this.isLifecycleActive(lifecycleGeneration)) {
          this.showGuardNotice("guard.restored", id);
        }
      } catch (error) {
        if (this.isLifecycleActive(lifecycleGeneration)) {
          console.warn(getLogTag(this.plugin), `Could not retry restore for plugin ${id}:`, error);
        }
      }
    };
    const runRetry = () => {
      if (!this.isLifecycleActive(lifecycleGeneration)) {
        return;
      }
      retry().catch((error: unknown) => {
        if (this.isLifecycleActive(lifecycleGeneration)) {
          console.warn(getLogTag(this.plugin), `Unexpected retry failure for plugin ${id}:`, error);
        }
      });
    };
    const timer = typeof this.plugin.setWindowTimeout === "function"
      ? this.plugin.setWindowTimeout(runRetry, retryDelayMs)
      : window.setTimeout(runRetry, retryDelayMs);
    this.enableRetryTimers.set(id, timer);
  }

  async restoreAfterLateDisable(id: string, sourceGuardGeneration: number, lifecycleGeneration: number): Promise<void> {
    try {
      if (!this.isLifecycleActive(lifecycleGeneration)) {
        return;
      }
      const currentGuard = this.guards.get(id);
      if (currentGuard && !currentGuard.releasing) {
        this.claimLateDisableOwnership(id, currentGuard, sourceGuardGeneration);
        return;
      }
      if (currentGuard?.disabledByGuard || this.isPluginEnabled(id)) {
        return;
      }
      if (this.getSharedClaims(id).length > 0) {
        this.transferRestoreOwnership(id, sourceGuardGeneration);
        return;
      }
      const restored = await this.runPluginOperation(id, "enable", async () => {
        if (this.getSharedClaims(id).length > 0) {
          return false;
        }
        await this.getPluginRegistry()?.enablePlugin?.(id);
        return true;
      });
      if (restored && this.isLifecycleActive(lifecycleGeneration)) {
        this.showGuardNotice("guard.restored", id);
      }
    } catch (error) {
      if (this.isLifecycleActive(lifecycleGeneration)) {
        console.warn(getLogTag(this.plugin), `Could not restore plugin ${id} after a late disable:`, error);
      }
    }
  }

  private claimLateDisableOwnership(id: string, guard: PluginDisableGuard, sourceGuardGeneration: number) {
    if (guard.generation !== sourceGuardGeneration) {
      guard.wasEnabled = true;
    }
    if (guard.disabledByGuard) {
      return;
    }
    guard.disabledByGuard = true;
    guard.observedEnabledAfterGuardDisable = false;
    this.startGuardStateMonitor(id, guard);
    this.showGuardNotice("guard.disabled", id);
  }

  private async restoreAfterShutdownLateDisable(id: string) {
    if (this.getSharedClaims(id).length > 0) {
      this.transferRestoreOwnership(id, -1);
      return;
    }
    if (this.isPluginEnabled(id)) {
      return;
    }
    try {
      await this.runRegistryOperation(id, async () => {
        if (this.getSharedClaims(id).length > 0) {
          this.transferRestoreOwnership(id, -1);
          return;
        }
        await this.getPluginRegistry()?.enablePlugin?.(id);
      });
    } catch (error) {
      console.warn(getLogTag(this.plugin), `Best-effort late plugin restore failed during unload for ${id}:`, error);
    }
  }

  private isLifecycleActive(generation: number) {
    return !this.shuttingDown && generation === this.lifecycleGeneration;
  }

  private shutdownGuards() {
    if (this.shuttingDown) {
      return;
    }
    this.shuttingDown = true;
    const shutdownGeneration = ++this.lifecycleGeneration;
    for (const [timer, settle] of Array.from(this.operationTimeouts.entries())) {
      this.plugin.clearWindowTimeout(timer);
      settle();
    }
    this.operationTimeouts.clear();
    for (const timer of this.enableRetryTimers.values()) {
      this.plugin.clearWindowTimeout(timer);
    }
    this.enableRetryTimers.clear();
    const guards = Array.from(this.guards.entries());
    this.guards.clear();
    for (const [id, guard] of guards) {
      guard.count = 0;
      guard.releasing = true;
      this.stopGuardStateMonitor(guard);
      if (!guard.wasEnabled || guard.observedEnabledAfterGuardDisable) {
        this.releaseSharedGuard(id, guard.generation);
        continue;
      }
      this.restoreGuardDuringShutdown(id, guard).catch((error: unknown) => {
        if (this.shuttingDown && this.lifecycleGeneration === shutdownGeneration) {
          console.warn(getLogTag(this.plugin), `Best-effort plugin restore failed during unload for ${id}:`, error);
        }
      });
    }
  }

  private async restoreGuardDuringShutdown(id: string, guard: PluginDisableGuard): Promise<void> {
    try {
      await this.runRegistryOperation(id, async () => {
        if (!this.hasSharedClaim(id, guard.generation)) {
          return;
        }
        if (this.hasOtherSharedClaim(id, guard.generation)) {
          this.transferRestoreOwnership(id, guard.generation);
          return;
        }
        await this.getPluginRegistry()?.enablePlugin?.(id);
      });
      if (this.hasOtherSharedClaim(id, guard.generation)) {
        this.transferRestoreOwnership(id, guard.generation);
      }
    } finally {
      this.releaseSharedGuard(id, guard.generation);
    }
  }

  async withDisabled<T>(pluginIds: string[], task: () => Promise<T> | T): Promise<T> {
    const acquired: string[] = [];
    try {
      for (const id of pluginIds) {
        await this.acquire(id);
        acquired.push(id);
      }
      return await task();
    } finally {
      await this.releaseGuardsInParallel(acquired.reverse());
    }
  }

  private async releaseGuardsInParallel(ids: string[]): Promise<void> {
    const results = await Promise.allSettled(ids.map((id) => this.release(id)));
    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (result?.status === "rejected") {
        console.warn(getLogTag(this.plugin), `Failed to release plugin guard for ${ids[index] || "unknown plugin"}:`, result.reason);
      }
    }
  }
}
