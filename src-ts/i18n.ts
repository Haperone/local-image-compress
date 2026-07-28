import { getLanguage as getObsidianLanguage, Notice, requireApiVersion, type App } from "obsidian";
import { BUILTIN_I18N } from "./locales";
import type { FsPort } from "./platform/ports";
import { getLogTag, normalizeVaultPathForComparison, vaultBasename } from "./utils";

type LocaleApp = Partial<App>;

export const I18N = BUILTIN_I18N;
// Optional external translations loader (lang/*.json). Preloaded async; t() stays sync and memory-only.
type TranslationParams = Record<string, string | number>;
type LoadedLangCache = {
  dict: Record<string, string>;
  loadedAt: number;
};
const LOADED_LANGS: Record<string, LoadedLangCache> = {};
// ponytail: builtin dicts are static, so merged lookups are cached per (pluginDir, lang) and cleared on external preload.
const MERGED_DICTS = new Map<string, Record<string, string>>();
const WARNED_LANG_LOAD_ERRORS = new Set<string>();
// Vault-relative plugin directory; only used for cache keys and lang paths.
export function resolvePluginDirFromApp(app: LocaleApp | null | undefined): string | null {
  const configDir = app?.vault?.configDir;
  return configDir ? `${configDir}/plugins/local-image-compress` : null;
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
  return Array.from(new Set([primary, fullLang].filter(Boolean)));
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
    new Notice(`${I18N["en"]?.["i18n.externalLoadFailed"] || "External language file could not be loaded"}: ${vaultBasename(filePath)}`, 10000);
  } catch (noticeError) {
    console.debug(getLogTag({ manifest: { name: 'Local Image Compress' } }), "i18n: failed to show external lang warning", noticeError);
  }
}

export async function preloadExternalLanguages(
  app: LocaleApp | null | undefined,
  fsPort: FsPort,
  lang: string = getCurrentLang(app)
): Promise<Record<string, string>> {
  const pluginDir = resolvePluginDirFromApp(app);
  if (!pluginDir) {
    return {};
  }
  const configDir = app?.vault?.configDir;
  if (!configDir) {
    return {};
  }
  const cacheKey = getExternalCacheKey(pluginDir, lang);
  const externalDict: Record<string, string> = {};
  for (const candidate of getExternalLanguageCandidates(lang)) {
    const langFile = `${pluginDir}/lang/${candidate}.json`;
    const relativeLangFile = `${configDir}/plugins/local-image-compress/lang/${candidate}.json`;
    try {
      if (!await fsPort.exists(relativeLangFile)) {
        continue;
      }
      const raw = await fsPort.readText(relativeLangFile);
      Object.assign(externalDict, normalizeTranslationDict(JSON.parse(raw)));
    } catch (error) {
      warnExternalLanguageLoadFailure(app, langFile, error);
    }
  }
  LOADED_LANGS[cacheKey] = { dict: externalDict, loadedAt: Date.now() };
  MERGED_DICTS.clear();
  return externalDict;
}

export function getMergedDict(app: LocaleApp | null | undefined, lang: string): Record<string, string> {
  const pluginDir = resolvePluginDirFromApp(app);
  const mergedKey = `${pluginDir ? normalizeVaultPathForComparison(pluginDir) : ""}\0${normalizeLanguageTag(lang)}`;
  const cachedDict = MERGED_DICTS.get(mergedKey);
  if (cachedDict) {
    return cachedDict;
  }
  const builtinLang = getBuiltinLanguage(lang);
  const merged = Object.assign({}, I18N["en"] || {}, I18N[builtinLang] || {});
  const external = pluginDir ? LOADED_LANGS[getExternalCacheKey(pluginDir, lang)]?.dict : null;
  if (external) {
    Object.assign(merged, external);
  }
  MERGED_DICTS.set(mergedKey, merged);
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
