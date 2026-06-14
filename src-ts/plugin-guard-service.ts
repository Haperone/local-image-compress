import * as obsidian from "obsidian";
import { t } from "./i18n";
import { INTERNAL_PLUGIN_GUARD_TIMEOUT_MS } from "./settings";
import { getLogTag, getPluginName } from "./utils";
import type LocalImageCompressPlugin from "./plugin";
import type { TimerHandle } from "./types";

interface PluginDisableGuard {
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
  operationTimeoutMs: number;

  constructor(plugin: LocalImageCompressPlugin) {
    this.plugin = plugin;
    this.operationTimeoutMs = INTERNAL_PLUGIN_GUARD_TIMEOUT_MS;
  }

  private getPluginRegistry(): InternalPluginRegistry | undefined {
    return (this.plugin.app as AppWithInternalPluginRegistry).plugins;
  }

  async acquire(id: string): Promise<void> {
    while (true) {
      const existingGuard = this.guards.get(id);
      if (!existingGuard) {
        const wasEnabled = !!this.getPluginRegistry()?.enabledPlugins?.has(id);
        const guard: PluginDisableGuard = {
          count: 1,
          wasEnabled,
          disabledByGuard: false,
          observedEnabledAfterGuardDisable: false,
          monitorTimer: null,
          releasing: false,
          ready: Promise.resolve()
        };
        guard.ready = (async () => {
          if (wasEnabled) {
            const disabled = await this.runPluginOperation(id, "disable", () => this.getPluginRegistry()?.disablePlugin?.(id));
            if (disabled && !this.isPluginEnabled(id)) {
              guard.disabledByGuard = true;
              this.startGuardStateMonitor(id, guard);
              this.showGuardNotice("guard.disabled", id);
            } else if (disabled) {
              console.debug(getLogTag(this.plugin), `Plugin ${id} was still enabled after guard disable; skipping restore ownership.`);
            }
          }
        })();
        this.guards.set(id, guard);
        try {
          await guard.ready;
        } catch (error) {
          this.guards.delete(id);
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
        const restored = await this.runPluginOperation(id, "enable", () => this.getPluginRegistry()?.enablePlugin?.(id));
        if (restored) {
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
        this.guards.delete(id);
      }
    }
  }

  async releaseAllGuards(): Promise<void> {
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
          const restored = await this.runPluginOperation(id, "enable", () => this.getPluginRegistry()?.enablePlugin?.(id));
          if (restored) {
            this.showGuardNotice("guard.restored", id);
          }
        }
      } catch (error) {
        console.warn(getLogTag(this.plugin), `Failed to restore guarded plugin ${id} during unload:`, error);
      } finally {
        this.stopGuardStateMonitor(guard);
        this.guards.delete(id);
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
      if (!this.guards.has(id) || guard.releasing) {
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
    if (!guard.monitorTimer) {
      return;
    }
    this.plugin.clearWindowTimeout(guard.monitorTimer);
    guard.monitorTimer = null;
  }

  showGuardNotice(key: "guard.disabled" | "guard.restored", id: string) {
    new obsidian.Notice(`${getPluginName(this.plugin)}: ${t(this.plugin.app, key, { id })}`, 5000);
  }

  async runPluginOperation(id: string, action: "disable" | "enable", operation: () => Promise<void> | void, allowEnableRetry = true): Promise<boolean> {
    let timer: TimerHandle | null = null;
    let operationSucceeded = false;
    let operationTimedOut = false;
    const operationCompleted = Promise.resolve()
      .then(operation)
      .then(async () => {
        operationSucceeded = true;
        if (operationTimedOut && action === "disable") {
          await this.restoreAfterLateDisable(id);
        }
        return true;
      }, (error) => {
        console.warn(getLogTag(this.plugin), `Could not ${action} plugin ${id}:`, error);
        return false;
      });
    const timeout = new Promise<void>((resolve) => {
      const callback = () => {
        console.warn(getLogTag(this.plugin), `Timed out while trying to ${action} plugin ${id}; continuing without waiting for that plugin.`);
        resolve();
      };
      timer = typeof this.plugin.setWindowTimeout === "function"
        ? this.plugin.setWindowTimeout(callback, this.operationTimeoutMs)
        : window.setTimeout(callback, this.operationTimeoutMs);
    });
    const timedOut = await Promise.race([
      operationCompleted.then(() => false),
      timeout.then(() => true)
    ]);
    if (timer) {
      if (typeof this.plugin.clearWindowTimeout === "function") {
        this.plugin.clearWindowTimeout(timer);
      } else {
        window.clearTimeout(timer);
      }
    }
    if (timedOut && action === "disable") {
      operationTimedOut = true;
    } else if (timedOut && action === "enable" && allowEnableRetry) {
      this.scheduleEnableRetry(id);
    }
    return !timedOut && operationSucceeded;
  }

  scheduleEnableRetry(id: string): void {
    if (this.enableRetryTimers.has(id)) {
      return;
    }
    const retryDelayMs = Math.max(this.operationTimeoutMs * 2, 10_000);
    const retry = async () => {
      this.enableRetryTimers.delete(id);
      if (this.guards.has(id) || this.isPluginEnabled(id)) {
        return;
      }
      try {
        const restored = await this.runPluginOperation(id, "enable", () => this.getPluginRegistry()?.enablePlugin?.(id), false);
        if (restored) {
          this.showGuardNotice("guard.restored", id);
        }
      } catch (error) {
        console.warn(getLogTag(this.plugin), `Could not retry restore for plugin ${id}:`, error);
      }
    };
    const runRetry = () => {
      retry().catch((error: unknown) => {
        console.warn(getLogTag(this.plugin), `Unexpected retry failure for plugin ${id}:`, error);
      });
    };
    const timer = typeof this.plugin.setWindowTimeout === "function"
      ? this.plugin.setWindowTimeout(runRetry, retryDelayMs)
      : window.setTimeout(runRetry, retryDelayMs);
    this.enableRetryTimers.set(id, timer);
  }

  async restoreAfterLateDisable(id: string): Promise<void> {
    try {
      if (this.guards.has(id)) {
        return;
      }
      if (this.getPluginRegistry()?.enabledPlugins?.has(id)) {
        return;
      }
      const restored = await this.runPluginOperation(id, "enable", () => this.getPluginRegistry()?.enablePlugin?.(id));
      if (restored) {
        this.showGuardNotice("guard.restored", id);
      }
    } catch (error) {
      console.warn(getLogTag(this.plugin), `Could not restore plugin ${id} after a late disable:`, error);
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
