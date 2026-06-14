import * as obsidian from "obsidian";
import * as path from "path";
import { getLogTag, getVaultFileByPath, normalizeVaultPath } from "./utils";
import type LocalImageCompressPlugin from "./plugin";

type ImageLookup = {
  imageFiles: obsidian.TFile[];
  byPath: Map<string, obsidian.TFile>;
  byName: Map<string, obsidian.TFile[]>;
};

const MARKDOWN_IMAGE_TARGET_MAX_PAREN_DEPTH = 100;
const MARKDOWN_IMAGE_TARGET_MAX_LENGTH = 4096;

export class ImageScanner {
  private readonly plugin: LocalImageCompressPlugin;
  private imageLookupCache: { source: obsidian.TFile[]; lookup: ImageLookup } | null;

  constructor(plugin: LocalImageCompressPlugin) {
    this.plugin = plugin;
    this.imageLookupCache = null;
  }

  isCompressibleImageTarget(imagePath: string | null | undefined) {
    const extension = path.extname(imagePath || "").slice(1).toLowerCase();
    return ["png", "jpg", "jpeg"].includes(extension);
  }

  normalizeEmbeddedImageTarget(rawTarget: unknown): string | null {
    let target = typeof rawTarget === "string" ? rawTarget.trim() : "";
    if (!target) {
      return null;
    }
    if (/^(https?:|data:)/i.test(target)) {
      return null;
    }
    if (target.startsWith("<")) {
      const closingIndex = target.indexOf(">");
      if (closingIndex === -1) {
        return null;
      }
      target = target.slice(1, closingIndex);
    } else {
      target = target.replace(/\s+(['"]).*\1\s*$/, "").trim();
    }
    if (/^(https?:|data:)/i.test(target)) {
      return null;
    }
    const targetBeforeHash = target.split("#")[0] || "";
    target = (targetBeforeHash.split("?")[0] || "").trim();
    target = target.replace(/^\.\/+/, "");
    try {
      target = decodeURIComponent(target);
    } catch (error) {
      console.debug(getLogTag(this.plugin), "Failed to decode embedded image target:", error);
    }
    target = target.replace(/\\([() |])/g, "$1");
    return this.isCompressibleImageTarget(target) ? target : null;
  }

  stripMarkdownCode(content: string): string {
    return String(content || "")
      .replace(/(^|\n)(```|~~~)[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g, "$1")
      .replace(/`[^`\n]*`/g, "");
  }

  getWikiTargetBeforeAlias(rawTarget: string): string {
    let escaped = false;
    for (let index = 0; index < rawTarget.length; index++) {
      const char = rawTarget[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "|") {
        return rawTarget.slice(0, index);
      }
    }
    return rawTarget;
  }

  buildImageLookup(allFiles: obsidian.TFile[]): ImageLookup {
    if (this.imageLookupCache?.source === allFiles) {
      return this.imageLookupCache.lookup;
    }
    const imageFiles = allFiles.filter((file) => this.plugin.isImageFile(file));
    const byPath = new Map<string, obsidian.TFile>();
    const byName = new Map<string, obsidian.TFile[]>();
    for (const file of imageFiles) {
      byPath.set(file.path, file);
      const namedFiles = byName.get(file.name) || [];
      namedFiles.push(file);
      byName.set(file.name, namedFiles);
    }
    const lookup = { imageFiles, byPath, byName };
    this.imageLookupCache = { source: allFiles, lookup };
    return lookup;
  }

  invalidateImageLookupCache() {
    this.imageLookupCache = null;
  }

  resolveNoteRelativeTarget(target: string, notePath: string): string | null {
    const normalizedTarget = String(target || "").replace(/\\/g, "/");
    if (!normalizedTarget || normalizedTarget.startsWith("/") || /^[a-zA-Z]:/.test(normalizedTarget)) {
      return null;
    }
    const normalizedNotePath = String(notePath || "").replace(/\\/g, "/");
    const noteDir = normalizedNotePath.includes("/") ? path.posix.dirname(normalizedNotePath) : "";
    const resolved = path.posix.normalize(noteDir ? `${noteDir}/${normalizedTarget}` : normalizedTarget).replace(/^\/+/, "");
    if (!resolved || resolved === "." || resolved === ".." || resolved.startsWith("../")) {
      return null;
    }
    return resolved;
  }

  resolveImageTarget(target: string, lookupOrAllFiles: ImageLookup | obsidian.TFile[], notePath = "", preferNoteRelative = false): obsidian.TFile | null {
    const lookup = Array.isArray(lookupOrAllFiles) ? this.buildImageLookup(lookupOrAllFiles) : lookupOrAllFiles;
    const normalizedTarget = normalizeVaultPath(target);
    const candidatePaths: string[] = [];
    if (preferNoteRelative) {
      const relativeTarget = this.resolveNoteRelativeTarget(normalizedTarget, notePath);
      if (relativeTarget) {
        candidatePaths.push(relativeTarget);
      }
    }
    candidatePaths.push(normalizedTarget);
    for (const candidatePath of candidatePaths) {
      const indexedFile = lookup.byPath.get(candidatePath);
      if (indexedFile) {
        return indexedFile;
      }
      const directFile = getVaultFileByPath(this.plugin.app.vault, candidatePath);
      if (directFile && this.plugin.isImageFile(directFile)) {
        return directFile;
      }
    }
    if (!normalizedTarget) {
      return null;
    }
    const directFile = getVaultFileByPath(this.plugin.app.vault, normalizedTarget);
    if (directFile && this.plugin.isImageFile(directFile)) {
      return directFile;
    }
    const hasFolder = normalizedTarget.includes("/");
    const candidates = hasFolder
      ? lookup.imageFiles.filter((file) => file.path === normalizedTarget || file.path.endsWith(`/${normalizedTarget}`))
      : lookup.byName.get(normalizedTarget) || [];
    if (candidates.length === 1) {
      return candidates[0] ?? null;
    }
    if (candidates.length > 1) {
      console.warn(getLogTag(this.plugin), "Ambiguous image embed target skipped:", normalizedTarget, candidates.map((file) => file.path));
    }
    return null;
  }

  extractMarkdownImageTargets(content: string): string[] {
    const targets: string[] = [];
    let searchIndex = 0;
    while (searchIndex < content.length) {
      const imageStart = content.indexOf("![", searchIndex);
      if (imageStart === -1) {
        break;
      }
      const destinationStart = content.indexOf("](", imageStart + 2);
      if (destinationStart === -1) {
        searchIndex = imageStart + 2;
        continue;
      }
      let index = destinationStart + 2;
      let depth = 0;
      let targetLength = 0;
      const targetParts: string[] = [];
      let closed = false;
      let aborted = false;
      const appendTargetPart = (part: string) => {
        if (targetLength + part.length > MARKDOWN_IMAGE_TARGET_MAX_LENGTH) {
          aborted = true;
          return false;
        }
        targetParts.push(part);
        targetLength += part.length;
        return true;
      };
      while (index < content.length) {
        const char = content[index];
        if (char === undefined) {
          break;
        }
        if (char === "\\") {
          if (!appendTargetPart(char)) {
            break;
          }
          const escapedChar = content[index + 1];
          if (escapedChar !== undefined) {
            if (!appendTargetPart(escapedChar)) {
              break;
            }
            index += 2;
            continue;
          }
          index++;
          continue;
        }
        if (char === "(") {
          depth++;
          if (depth > MARKDOWN_IMAGE_TARGET_MAX_PAREN_DEPTH || !appendTargetPart(char)) {
            aborted = true;
            break;
          }
        } else if (char === ")") {
          if (depth === 0) {
            closed = true;
            index++;
            break;
          }
          depth--;
          if (!appendTargetPart(char)) {
            break;
          }
        } else {
          if (!appendTargetPart(char)) {
            break;
          }
        }
        index++;
      }
      if (closed && !aborted) {
        targets.push(targetParts.join(""));
        searchIndex = index;
      } else {
        searchIndex = destinationStart + 2;
      }
    }
    return targets;
  }

  async getImagesInNote(file: obsidian.TFile): Promise<obsidian.TFile[]> {
    try {
      const content = await this.plugin.app.vault.cachedRead(file);
      if (this.plugin.isUnloading) {
        return [];
      }
      const searchableContent = this.stripMarkdownCode(content);
      const targets: Array<{ target: string; preferNoteRelative: boolean }> = [];
      let match: RegExpExecArray | null;
      const wikiImageRegex = /!\[\[([^\]]+)\]\]/g;
      while ((match = wikiImageRegex.exec(searchableContent)) !== null) {
        const rawWikiTarget = match[1];
        if (!rawWikiTarget) {
          continue;
        }
        const wikiTarget = this.normalizeEmbeddedImageTarget(this.getWikiTargetBeforeAlias(rawWikiTarget));
        if (wikiTarget) {
          targets.push({ target: wikiTarget, preferNoteRelative: false });
        }
      }
      for (const markdownRawTarget of this.extractMarkdownImageTargets(searchableContent)) {
        const markdownTarget = this.normalizeEmbeddedImageTarget(markdownRawTarget);
        if (markdownTarget) {
          targets.push({ target: markdownTarget, preferNoteRelative: true });
        }
      }
      if (targets.length === 0) {
        return [];
      }
      const imageFiles: obsidian.TFile[] = [];
      const seenPaths = new Set<string>();
      const allFiles = this.plugin.app.vault.getFiles();
      const lookup = this.buildImageLookup(allFiles);
      for (const { target, preferNoteRelative } of targets) {
        const foundFile = this.resolveImageTarget(target, lookup, file?.path || "", preferNoteRelative);
        if (foundFile && !seenPaths.has(foundFile.path)) {
          seenPaths.add(foundFile.path);
          imageFiles.push(foundFile);
        }
      }
      return imageFiles;
    } catch {
      return [];
    }
  }
}
