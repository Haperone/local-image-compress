import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as obsidian from "obsidian";
import { promisify } from "util";
import { shell } from "electron";

const randomBytesAsync = promisify(crypto.randomBytes) as (size: number) => Promise<Buffer>;
const CASE_INSENSITIVE_PATH_PLATFORM = process.platform === "win32" || process.platform === "darwin";
const MAX_SANITIZED_PATH_LENGTH = 500;
const SENSITIVE_PATH_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "heic", "heif", "avif", "json", "tmp", "bak", "log", "txt", "md"];
const SENSITIVE_UNIX_ROOTS = ["Users", "home", "var", "opt", "tmp", "usr", "etc", "private"];

type AppWithActiveWorkspaceDom = {
  workspace?: {
    activeWindow?: Window;
    activeDocument?: Document;
  };
};

export function getVaultFileByPath(vault: obsidian.Vault, filePath: string): obsidian.TFile | null {
  const normalizedPath = normalizeVaultPath(filePath);
  // Obsidian 1.4 fallback is retained below; feature-detect the 1.5.7+ direct API.
  const modernLookup = Reflect.get(vault, "getFileByPath") as unknown;
  if (typeof modernLookup === "function") {
    return modernLookup.call(vault, normalizedPath) as obsidian.TFile | null;
  }
  const abstractFile = vault.getAbstractFileByPath(normalizedPath);
  return abstractFile instanceof obsidian.TFile ? abstractFile : null;
}

export function getActiveWindowForApp(app: unknown): Window | undefined {
  const workspaceWindow = (app as AppWithActiveWorkspaceDom | null | undefined)?.workspace?.activeWindow;
  if (workspaceWindow) {
    return workspaceWindow;
  }
  if (typeof activeWindow !== "undefined") {
    return activeWindow;
  }
  return typeof window !== "undefined" ? window : undefined;
}

export function getActiveDocumentForApp(app: unknown): Document | undefined {
  const workspaceDocument = (app as AppWithActiveWorkspaceDom | null | undefined)?.workspace?.activeDocument;
  if (workspaceDocument) {
    return workspaceDocument;
  }
  if (typeof activeDocument !== "undefined") {
    return activeDocument;
  }
  return getActiveWindowForApp(app)?.document;
}

export function stripWindowsLongPathPrefix(filePath: string): string {
  const value = String(filePath || "");
  if (value.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${value.slice(8)}`;
  }
  if (value.startsWith("//?/UNC/")) {
    return `//${value.slice(8)}`;
  }
  if (/^\\\\\?\\[A-Za-z]:[\\/]/.test(value) || /^\/\/\?\/[A-Za-z]:[\\/]/.test(value)) {
    return value.slice(4);
  }
  return value;
}

export function isWindowsDriveFilesystemPath(filePath: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(stripWindowsLongPathPrefix(filePath));
}

export function isUncFilesystemPath(filePath: string): boolean {
  const value = stripWindowsLongPathPrefix(filePath);
  return /^\\\\[^\\]+\\[^\\]+/.test(value) || /^\/\/[^/]+\/[^/]+/.test(value);
}

function getPathModuleForFilesystemPath(filePath: string, basePath = "") {
  return isWindowsDriveFilesystemPath(filePath) || isWindowsDriveFilesystemPath(basePath) || isUncFilesystemPath(filePath) || isUncFilesystemPath(basePath)
    ? path.win32
    : path;
}

// path & html helpers
export function normalizeVaultPath(p: string): string {
  return stripWindowsLongPathPrefix(String(p || "")).normalize("NFC").replace(/\\/g, "/").replace(/\/+/g, "/");
}
export function normalizeVaultPathRoot(p: string): string {
  return normalizeVaultPath(p).replace(/^\/+|\/+$/g, "");
}
export function normalizeVaultPathForComparison(p: string): string {
  const normalized = normalizeVaultPathRoot(p);
  return CASE_INSENSITIVE_PATH_PLATFORM ? normalized.toLowerCase() : normalized;
}
export function vaultPathsEqual(leftPath: string, rightPath: string): boolean {
  return normalizeVaultPathForComparison(leftPath) === normalizeVaultPathForComparison(rightPath);
}
export function isSafeVaultRelativePath(p: string): boolean {
  const rawPath = String(p || "").trim();
  if (!rawPath) return false;
  const normalizedPath = normalizeVaultPath(rawPath);
  if (isAbsoluteFilesystemPath(rawPath)) return false;
  if (normalizedPath.startsWith("/") || normalizedPath.startsWith("//")) return false;
  const parts = normalizedPath.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}
export function normalizeOutputFolder(outputFolderName: string, fallback = "Compressed"): string {
  const rawPath = String(outputFolderName || "").trim();
  if (!isSafeVaultRelativePath(rawPath)) {
    return fallback;
  }
  return normalizeVaultPath(rawPath).replace(/^\/+|\/+$/g, "");
}
export function isValidOutputFolder(outputFolderName: string): boolean {
  return isSafeVaultRelativePath(outputFolderName);
}
export function isPathInsideRoot(targetPath: string, rootPath: string): boolean {
  const safeRoot = normalizeVaultPathForComparison(rootPath);
  if (!safeRoot) return true;
  const safeTarget = normalizeVaultPathForComparison(targetPath);
  return safeTarget === safeRoot || safeTarget.startsWith(`${safeRoot}/`);
}
export function isAllowedByRoots(targetPath: string, allowedRoots?: string[]): boolean {
  if (!allowedRoots || allowedRoots.length === 0) return true;
  return allowedRoots.some((root) => isPathInsideRoot(targetPath, root));
}
export function isAbsoluteFilesystemPath(filePath: string | null | undefined): boolean {
  const value = stripWindowsLongPathPrefix(String(filePath || ""));
  return path.isAbsolute(value) || isWindowsDriveFilesystemPath(value) || isUncFilesystemPath(value);
}

export type VaultBasePathAdapter = {
  getBasePath?: () => string;
};

export type AppOrVaultWithAdapter = {
  vault?: {
    adapter?: unknown;
  };
  adapter?: unknown;
};

export type ManifestLike = {
  manifest?: {
    id?: string;
    name?: string;
  };
};

export function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? String(code) : undefined;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "";
}

export function getVaultBasePathFromAdapter(adapter: unknown, fallback?: string): string {
  const candidate = adapter as VaultBasePathAdapter | null | undefined;
  try {
    const methodPath = typeof candidate?.getBasePath === "function" ? candidate.getBasePath() : "";
    if (typeof methodPath === "string" && isAbsoluteFilesystemPath(methodPath)) {
      return stripWindowsLongPathPrefix(methodPath);
    }
  } catch (error) {
    void error;
  }
  if (typeof fallback === "string" && isAbsoluteFilesystemPath(fallback)) {
    return stripWindowsLongPathPrefix(fallback);
  }
  throw new Error("Vault filesystem base path is unavailable; refusing filesystem access outside the vault.");
}
export function getVaultBasePath(appOrVault: AppOrVaultWithAdapter | null | undefined, fallback?: string): string {
  const vault = appOrVault?.vault || appOrVault;
  return getVaultBasePathFromAdapter(vault?.adapter, fallback);
}
export function toVaultRelativePath(filePath: string | null | undefined, basePath: string): string {
  const rawPath = stripWindowsLongPathPrefix(String(filePath || ""));
  if (!rawPath) {
    return "";
  }
  const safeBasePath = stripWindowsLongPathPrefix(String(basePath || ""));
  const pathModule = getPathModuleForFilesystemPath(rawPath, safeBasePath);
  return normalizeVaultPath(isAbsoluteFilesystemPath(rawPath) ? pathModule.relative(safeBasePath, rawPath) : rawPath);
}
export function getVaultFolderPath(filePath: string): string {
  const safePath = normalizeVaultPathRoot(filePath);
  const slashIndex = safePath.lastIndexOf("/");
  return slashIndex === -1 ? "" : safePath.slice(0, slashIndex);
}
export async function openFilesystemPath(targetPath: string): Promise<string> {
  return await shell.openPath(targetPath);
}
export function isInsideOutputFolder(targetPath: string, outputFolderName: string): boolean {
  const safeOutput = normalizeOutputFolder(outputFolderName);
  if (!safeOutput) return false;
  const safeTarget = normalizeVaultPath(targetPath).replace(/^\/+|\/+$/g, "");
  return isPathInsideRoot(safeTarget, safeOutput);
}
export function getLogTag(self: unknown): string {
  try {
    const source = self as ManifestLike | null | undefined;
    const name = source?.manifest?.name || "Local Image Compress";
    return `[${name}]`;
  } catch (error) {
    void error;
    return "[Local Image Compress]";
  }
}

export function getPluginName(self: unknown): string {
  try {
    const source = self as ManifestLike | null | undefined;
    return source?.manifest?.name || "Local Image Compress";
  } catch (error) {
    void error;
    return "Local Image Compress";
  }
}

export function getPluginId(self: unknown): string {
  try {
    const source = self as ManifestLike | null | undefined;
    return source?.manifest?.id || 'local-image-compress';
  } catch (error) {
    void error;
    return 'local-image-compress';
  }
}

function startsWithIgnoreCase(value: string, index: number, prefix: string): boolean {
  return value.slice(index, index + prefix.length).toLowerCase() === prefix.toLowerCase();
}

function isPathHardDelimiter(char: string): boolean {
  return char === '"' || char === "'" || char === "<" || char === ">" || char === "\n" || char === "\r" || char === "\t";
}

function isPathTokenDelimiter(char: string): boolean {
  return isPathHardDelimiter(char) || char === " " || char === ")" || char === "(" || char === "[" || char === "]" || char === "{" || char === "}";
}

function boundedWindowEnd(message: string, start: number): number {
  const maxEnd = Math.min(message.length, start + MAX_SANITIZED_PATH_LENGTH);
  for (let index = start; index < maxEnd; index++) {
    if (isPathHardDelimiter(message[index] || "")) {
      return index;
    }
  }
  return maxEnd;
}

function tokenEnd(message: string, start: number): number {
  for (let index = start; index < message.length; index++) {
    if (isPathTokenDelimiter(message[index] || "")) {
      return index;
    }
  }
  return message.length;
}

function findSensitiveExtensionEnd(message: string, start: number, end: number): number | null {
  for (let index = start; index < end; index++) {
    if (message[index] !== ".") {
      continue;
    }
    const extension = SENSITIVE_PATH_EXTENSIONS.find((candidate) => startsWithIgnoreCase(message, index + 1, candidate));
    if (!extension) {
      continue;
    }
    const afterExtension = index + 1 + extension.length;
    const nextChar = message[afterExtension] || "";
    if (!nextChar || !/[A-Za-z0-9_-]/.test(nextChar)) {
      return afterExtension;
    }
  }
  return null;
}

function startsSensitiveUnixPath(message: string, index: number): boolean {
  if (message[index] !== "/") {
    return false;
  }
  return SENSITIVE_UNIX_ROOTS.some((root) => startsWithIgnoreCase(message, index + 1, `${root}/`));
}

function startsLocalhostUrl(message: string, index: number): boolean {
  return startsWithIgnoreCase(message, index, "http://localhost") ||
    startsWithIgnoreCase(message, index, "https://localhost") ||
    startsWithIgnoreCase(message, index, "http://127.0.0.1") ||
    startsWithIgnoreCase(message, index, "https://127.0.0.1");
}

function getSensitivePathReplacement(message: string, index: number): { end: number; replacement: string } | null {
  if (startsLocalhostUrl(message, index)) {
    return { end: tokenEnd(message, index), replacement: "<url>" };
  }

  const startsFileUri = startsWithIgnoreCase(message, index, "file://");
  const startsWindowsDrive = /^[A-Za-z]$/.test(message[index] || "") && message[index + 1] === ":" && (message[index + 2] === "\\" || message[index + 2] === "/");
  const startsUncPath = message[index] === "\\" && message[index + 1] === "\\";
  const startsHomePath = message[index] === "~" && message[index + 1] === "/";
  const startsUnixPath = startsSensitiveUnixPath(message, index);
  if (!startsFileUri && !startsWindowsDrive && !startsUncPath && !startsHomePath && !startsUnixPath) {
    return null;
  }

  const windowEnd = boundedWindowEnd(message, index);
  return {
    end: findSensitiveExtensionEnd(message, index, windowEnd) ?? tokenEnd(message, index),
    replacement: "<path>"
  };
}

export function sanitizeErrorForUser(error: unknown): string {
  const message = getErrorMessage(error);
  let sanitized = "";
  let index = 0;
  while (index < message.length) {
    const replacement = getSensitivePathReplacement(message, index);
    if (replacement && replacement.end > index) {
      sanitized += replacement.replacement;
      index = replacement.end;
      continue;
    }
    sanitized += message[index];
    index++;
  }
  return sanitized;
}

export async function randomHexSuffix(byteCount = 16): Promise<string> {
  return (await randomBytesAsync(byteCount)).toString("hex");
}

export function randomHexSuffixSync(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

export async function streamHashSha256(filePath: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
    stream.on("data", (chunk) => {
      hash.update(chunk);
    });
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}
