import * as fs from "fs";
import * as path from "path";
import { getLanguage as getObsidianLanguage, Notice, requireApiVersion, type App } from "obsidian";
import { BUILTIN_I18N } from "./locales";
import { getLogTag, getVaultBasePath, normalizeVaultPathForComparison } from "./utils";

type LocaleApp = Partial<App>;

export const I18N = BUILTIN_I18N;
// Optional external translations loader (lang/*.json). Preloaded async; t() stays sync and memory-only.
type TranslationParams = Record<string, string | number>;
type LoadedLangCache = {
  dict: Record<string, string>;
  loadedAt: number;
};
const LOADED_LANGS: Record<string, LoadedLangCache> = {};
const WARNED_LANG_LOAD_ERRORS = new Set<string>();
export function resolvePluginDirFromApp(app: LocaleApp | null | undefined): string | null {
  try {
    const configDir = app?.vault?.configDir;
    if (!configDir) {
      return null;
    }
    const basePath = getVaultBasePath(app);
    return path.join(basePath, configDir, "plugins", "local-image-compress");
  } catch {
    return null;
  }
}

function normalizeLanguageTag(lang: string | null | undefined): string {
  return String(lang || "en").toLowerCase().replace(/_/g, "-");
}

function getPrimaryLanguage(lang: string): string {
  const fullLang = String(lang || "en").toLowerCase();
  return fullLang.split(/[_.-]/)[0] || "en";
}

function getBuiltinLanguage(lang: string): string {
  const fullLang = normalizeLanguageTag(lang);
  const aliases: Record<string, string> = {
    be: "ru",
    by: "ru",
    ua: "uk",
    zh: "zh-cn",
    "zh-hans": "zh-cn",
    "zh-sg": "zh-cn",
    "zh-hant": "zh-tw",
    "zh-hk": "zh-tw",
    "zh-mo": "zh-tw"
  };
  const exact = aliases[fullLang] || fullLang;
  if (I18N[exact]) {
    return exact;
  }
  const primary = aliases[getPrimaryLanguage(fullLang)] || getPrimaryLanguage(fullLang);
  if (I18N[primary]) {
    return primary;
  }
  return "en";
}

function getExternalLanguageCandidates(lang: string): string[] {
  const fullLang = normalizeLanguageTag(lang);
  const primary = getPrimaryLanguage(fullLang);
  return Array.from(new Set([fullLang, primary].filter(Boolean)));
}

function getExternalCacheKey(pluginDir: string, lang: string): string {
  return `${normalizeVaultPathForComparison(pluginDir)}\0${normalizeLanguageTag(lang)}`;
}

function normalizeTranslationDict(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") {
      normalized[key] = value;
    }
  }
  return normalized;
}

function warnExternalLanguageLoadFailure(_app: LocaleApp | null | undefined, filePath: string, error: unknown) {
  const warningKey = normalizeVaultPathForComparison(filePath);
  if (WARNED_LANG_LOAD_ERRORS.has(warningKey)) {
    return;
  }
  WARNED_LANG_LOAD_ERRORS.add(warningKey);
  console.warn(getLogTag({ manifest: { name: 'Local Image Compress' } }), "i18n: failed to load external lang file", filePath, error);
  try {
    new Notice(`${I18N["en"]?.["i18n.externalLoadFailed"] || "External language file could not be loaded"}: ${path.basename(filePath)}`, 10000);
  } catch (noticeError) {
    console.debug(getLogTag({ manifest: { name: 'Local Image Compress' } }), "i18n: failed to show external lang warning", noticeError);
  }
}

export async function preloadExternalLanguages(app: LocaleApp | null | undefined, lang: string = getCurrentLang(app)): Promise<Record<string, string>> {
  const pluginDir = resolvePluginDirFromApp(app);
  if (!pluginDir) {
    return {};
  }
  const cacheKey = getExternalCacheKey(pluginDir, lang);
  const externalDict: Record<string, string> = {};
  for (const candidate of getExternalLanguageCandidates(lang)) {
    const langFile = path.join(pluginDir, "lang", `${candidate}.json`);
    try {
      const raw = await fs.promises.readFile(langFile, "utf8");
      Object.assign(externalDict, normalizeTranslationDict(JSON.parse(raw)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        warnExternalLanguageLoadFailure(app, langFile, error);
      }
    }
  }
  LOADED_LANGS[cacheKey] = { dict: externalDict, loadedAt: Date.now() };
  return externalDict;
}

export function getMergedDict(app: LocaleApp | null | undefined, lang: string): Record<string, string> {
  const pluginDir = resolvePluginDirFromApp(app);
  const builtinLang = getBuiltinLanguage(lang);
  const merged = Object.assign({}, I18N["en"] || {}, I18N[builtinLang] || {});
  const external = pluginDir ? LOADED_LANGS[getExternalCacheKey(pluginDir, lang)]?.dict : null;
  if (external) {
    Object.assign(merged, external);
  }
  return merged;
}
export function getUserLang(_app: LocaleApp | null | undefined): string {
  try {
    const detected = requireApiVersion("1.8.7") ? getObsidianLanguage() : null;
    const raw = detected && detected !== "system" ? detected : null;
    return getBuiltinLanguage(raw || "en");
  } catch (error) {
    console.debug(getLogTag({ manifest: { name: 'Local Image Compress' } }), "i18n: failed to detect user language", error);
  }
  return "en";
}

export function getCurrentLang(app: LocaleApp | null | undefined): string {
  return getUserLang(app);
}

function interpolateTranslation(value: string, params: TranslationParams): string {
  let translated = value;
  for (const [paramKey, paramValue] of Object.entries(params)) {
    translated = translated.replace(new RegExp(`\\{${paramKey}\\}`, "g"), String(paramValue));
  }
  return translated;
}

export function t(app: LocaleApp | null | undefined, key: string, params: TranslationParams = {}): string {
  if (!key) {
    return "[missing translation key]";
  }
  const lang = getCurrentLang(app);
  const dict = getMergedDict(app, lang);
  const value = (dict && dict[key]) || (I18N["en"] && I18N["en"][key]) || `[${key}]`;
  return interpolateTranslation(value, params);
}
