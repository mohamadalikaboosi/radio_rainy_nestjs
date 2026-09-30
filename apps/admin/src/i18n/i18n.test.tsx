import { fireEvent, render, screen } from '@testing-library/react';
import { DEFAULT_LANGUAGE, I18nProvider, LanguageSwitcher, availableLanguages, translate, useT } from './index';

const files = import.meta.glob<Record<string, unknown>>('./locales/*.json', { eager: true, import: 'default' });
const locales = Object.fromEntries(Object.entries(files).map(([p, f]) => [/\/([^/]+)\.json$/.exec(p)?.[1] ?? p, f]));
const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();

describe('translate', () => {
  it('interpolates {placeholders}, falls back to English, then to the key', () => {
    expect(translate('en', 'vote.votes', { n: 3 })).toBe('3 votes');
    expect(translate('fa', 'vote.votes', { n: 3 })).toBe('3 رأی');
    expect(translate('xx', 'common.save')).toBe('Save'); // unknown language -> English
    expect(translate('en', 'no.such.key')).toBe('no.such.key'); // unknown key -> the key
    expect(translate('en', 'vote.votes')).toBe('{n} votes'); // a missing variable is left visible, never "undefined"
  });
});

describe('locale files (every language, including ones added later, is validated)', () => {
  it('has English as the base language and a _meta block everywhere', () => {
    expect(Object.keys(locales)).toContain(DEFAULT_LANGUAGE);
    for (const [code, f] of Object.entries(locales)) {
      const meta = f._meta as { name?: string; dir?: string } | undefined;
      expect(meta?.name, `${code}._meta.name`).toBeTruthy();
      expect(['ltr', 'rtl', undefined], `${code}._meta.dir`).toContain(meta?.dir);
    }
  });

  it('every other language only uses keys that exist in English, with the same {placeholders}', () => {
    const en = locales[DEFAULT_LANGUAGE] ?? {};
    for (const [code, f] of Object.entries(locales)) {
      if (code === DEFAULT_LANGUAGE) continue;
      for (const [key, value] of Object.entries(f)) {
        if (key === '_meta') continue;
        expect(typeof en[key], `${code}: "${key}" is not an English key`).toBe('string');
        expect(placeholders(String(value)), `${code}: placeholders of "${key}"`).toEqual(placeholders(String(en[key])));
      }
    }
  });

  it('Persian is complete (every English key is translated)', () => {
    const en = Object.keys(locales[DEFAULT_LANGUAGE] ?? {});
    const fa = locales.fa ?? {};
    expect(en.filter((k) => !(k in fa))).toEqual([]);
  });

  it('lists the languages for the switcher, English first', () => {
    const langs = availableLanguages();
    expect(langs[0]?.code).toBe('en');
    expect(langs.find((l) => l.code === 'fa')).toMatchObject({ name: 'فارسی', dir: 'rtl' });
  });
});

function Probe() {
  const t = useT();
  return <p>{t('player.listenLive')}</p>;
}

describe('I18nProvider', () => {
  beforeEach(() => localStorage.clear());

  it('works without a provider (English)', () => {
    render(<Probe />);
    expect(screen.getByText('Listen live')).toBeInTheDocument();
  });

  it('switches language, remembers it, and sets lang/dir on the document (RTL for Persian)', () => {
    render(
      <I18nProvider>
        <LanguageSwitcher />
        <Probe />
      </I18nProvider>,
    );
    fireEvent.change(screen.getByLabelText('Language'), { target: { value: 'fa' } });
    expect(screen.getByText('پخش زنده')).toBeInTheDocument();
    expect(document.documentElement.dir).toBe('rtl');
    expect(document.documentElement.lang).toBe('fa');
    expect(localStorage.getItem('rr_lang')).toBe('fa');
    fireEvent.change(screen.getByLabelText('زبان'), { target: { value: 'en' } });
    expect(document.documentElement.dir).toBe('ltr');
  });
});
