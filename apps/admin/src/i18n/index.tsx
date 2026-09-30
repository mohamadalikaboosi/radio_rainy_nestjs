import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * Tiny i18n: every language is one JSON file in ./locales (flat keys, `{name}` placeholders).
 * To add a language: copy en.json to <code>.json, translate the values, set "_meta.name" (shown in the switcher) and "_meta.dir"
 * ("rtl" for Arabic/Persian/Hebrew...). Nothing else needs to change. Missing keys fall back to English, then to the key itself.
 */
export interface LocaleFile {
  _meta: { name: string; dir?: 'ltr' | 'rtl' };
  [key: string]: string | { name: string; dir?: 'ltr' | 'rtl' };
}

export interface LanguageInfo {
  code: string;
  name: string;
  dir: 'ltr' | 'rtl';
}

const modules = import.meta.glob<LocaleFile>('./locales/*.json', { eager: true, import: 'default' });
const locales: Record<string, LocaleFile> = {};
for (const [path, file] of Object.entries(modules)) {
  const code = /\/([^/]+)\.json$/.exec(path)?.[1];
  if (code) locales[code] = file;
}

export const DEFAULT_LANGUAGE = 'en';
const STORAGE_KEY = 'rr_lang';

export function availableLanguages(): LanguageInfo[] {
  return Object.entries(locales)
    .map(([code, f]) => ({ code, name: f._meta.name, dir: f._meta.dir ?? 'ltr' }))
    .sort((a, b) => (a.code === DEFAULT_LANGUAGE ? -1 : b.code === DEFAULT_LANGUAGE ? 1 : a.code.localeCompare(b.code)));
}

const raw = (lang: string, key: string): string | undefined => {
  const v = locales[lang]?.[key];
  return typeof v === 'string' ? v : undefined;
};

/** Pure translation: `lang` -> English -> key. `{name}` placeholders are replaced from `vars`. */
export function translate(lang: string, key: string, vars?: Record<string, string | number>): string {
  const text = raw(lang, key) ?? raw(DEFAULT_LANGUAGE, key) ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m)) : text;
}

function stored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Saved choice, else the browser language (fa-IR -> fa), else English. */
export function detectLanguage(): string {
  const saved = stored();
  if (saved && locales[saved]) return saved;
  const prefs = typeof navigator === 'undefined' ? [] : [...(navigator.languages ?? []), navigator.language];
  for (const p of prefs) {
    const code = p?.toLowerCase().split('-')[0];
    if (code && locales[code]) return code;
  }
  return DEFAULT_LANGUAGE;
}

export type TFunction = (key: string, vars?: Record<string, string | number>) => string;

interface Ctx {
  lang: string;
  dir: 'ltr' | 'rtl';
  languages: LanguageInfo[];
  setLang: (code: string) => void;
  t: TFunction;
}

const fallback: Ctx = { lang: DEFAULT_LANGUAGE, dir: 'ltr', languages: availableLanguages(), setLang: () => undefined, t: (k, v) => translate(DEFAULT_LANGUAGE, k, v) };
const I18nContext = createContext<Ctx>(fallback);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<string>(detectLanguage);
  const dir = locales[lang]?._meta.dir ?? 'ltr';

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dir;
  }, [lang, dir]);

  const setLang = useCallback((code: string) => {
    if (!locales[code]) return;
    setLangState(code);
    try {
      localStorage.setItem(STORAGE_KEY, code);
    } catch {
      /* the choice just isn't remembered */
    }
  }, []);

  const value = useMemo<Ctx>(() => ({ lang, dir, languages: availableLanguages(), setLang, t: (k, v) => translate(lang, k, v) }), [lang, dir, setLang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

/** Works without a provider too (English), so components stay testable in isolation. */
export const useI18n = (): Ctx => useContext(I18nContext);
export const useT = (): TFunction => useContext(I18nContext).t;

export function LanguageSwitcher({ className = '' }: { className?: string }) {
  const { lang, languages, setLang, t } = useI18n();
  if (languages.length < 2) return null;
  return (
    <select className={className} value={lang} onChange={(e) => setLang(e.target.value)} aria-label={t('common.language')}>
      {languages.map((l) => (
        <option key={l.code} value={l.code}>
          {l.name}
        </option>
      ))}
    </select>
  );
}
