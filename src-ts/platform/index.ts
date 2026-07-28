import { Platform, type App } from "obsidian";
import { createDesktopPorts } from "./desktop";
import { createMobilePorts } from "./mobile";
import type { PlatformPorts } from "./ports";

export type { PlatformPorts } from "./ports";

export function isDesktopAdapter(adapter: unknown): boolean {
  return typeof (adapter as { getBasePath?: unknown } | null | undefined)?.getBasePath === "function";
}

export function createPlatformPorts(app: App): PlatformPorts {
  if (Platform.isDesktopApp === true) {
    if (!isDesktopAdapter(app.vault.adapter)) {
      throw new Error("Desktop vault adapter does not expose a filesystem base path; refusing to select an unsafe platform port.");
    }
    return createDesktopPorts(app);
  }
  return createMobilePorts(app);
}
