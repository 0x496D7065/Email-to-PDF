// Unit tests for the strings system: every string is usable, placeholders
// are consistent, and t() fills them in as text.
import { describe, expect, it } from 'vitest';
import { FOLD_REASONS } from '../../engine/segments';
import { en } from './en';
import { fr } from './fr';
import {
  DEFAULT_LOCALE,
  getLocale,
  interpolate,
  isPluralForms,
  isSupportedLocale,
  languageName,
  lookup,
  pickLocale,
  placeholdersIn,
  pluralForm,
  setLocale,
  SUPPORTED_LOCALES,
  t,
  translator,
  type Messages,
  type MessageKey,
} from './index';

/** Every language file. Dutch is added here when it exists. */
const LOCALES: Readonly<Record<string, Messages>> = { en, fr };

/** Every [dotted key, value] of a language file. */
function entries(table: unknown, prefix = ''): [string, unknown][] {
  return Object.entries(table as Record<string, unknown>).flatMap(([key, value]): [string, unknown][] =>
    typeof value === 'string' || isPluralForms(value) ? [[prefix + key, value]] : entries(value, `${prefix}${key}.`),
  );
}

/** The placeholder names of an entry (a string or both plural forms), sorted and unique. */
function placeholderSet(value: unknown): string[] {
  const texts = typeof value === 'string' ? [value] : isPluralForms(value) ? [value.one, value.other] : [];
  return [...new Set(texts.flatMap(placeholdersIn))].sort();
}

/** The individual strings of an entry. */
function textsOf(value: unknown): string[] {
  return typeof value === 'string' ? [value] : isPluralForms(value) ? [value.one, value.other] : [];
}

const enEntries = entries(en);

describe('language files', () => {
  it('has a reasonable number of entries, all strings or plural forms', () => {
    expect(enEntries.length).toBeGreaterThan(50);
    for (const [key, value] of enEntries) expect(textsOf(value).length, key).toBeGreaterThan(0);
  });

  it('has no empty string and no stray spaces', () => {
    for (const [name, table] of Object.entries(LOCALES)) {
      for (const [key, value] of entries(table)) {
        for (const text of textsOf(value)) {
          expect(text.trim(), `${name} ${key}`).not.toBe('');
          expect(text, `${name} ${key}`).toBe(text.trim());
          expect(text, `${name} ${key}`).not.toMatch(/ {2}|\n/);
        }
      }
    }
  });

  it('has the same keys and the same placeholders in every language as in English', () => {
    const expected = enEntries.map(([key, value]) => [key, placeholderSet(value)]);
    for (const [name, table] of Object.entries(LOCALES)) {
      expect(entries(table).map(([key, value]) => [key, placeholderSet(value)]), name).toEqual(expected);
    }
  });

  it('uses only well-formed {name} placeholders (no stray braces), in every language', () => {
    for (const [name, table] of Object.entries(LOCALES)) {
      for (const [key, value] of entries(table)) {
        for (const text of textsOf(value)) {
          const withoutPlaceholders = text.replace(/\{\w+\}/g, '');
          expect(withoutPlaceholders, `${name} ${key}`).not.toMatch(/[{}]/);
        }
      }
    }
  });

  it('gives both plural forms the same placeholders, always including {count}, in every language', () => {
    for (const [name, table] of Object.entries(LOCALES)) {
      for (const [key, value] of entries(table)) {
        if (!isPluralForms(value)) continue;
        expect(placeholderSet(value.one), `${name} ${key}`).toEqual(placeholderSet(value.other));
        expect(placeholderSet(value.one), `${name} ${key}`).toContain('count');
      }
    }
  });

  it('is plain ASCII in English (non-ASCII characters must be \\u escapes in the source)', () => {
    for (const [key, value] of enEntries) {
      for (const text of textsOf(value)) expect(text, key).toMatch(/^[\x20-\x7e]*$/);
    }
  });

  it('has a fold label for every fold reason', () => {
    for (const reason of FOLD_REASONS) expect(lookup(en, `preview.fold.${reason}`), reason).toEqual(expect.any(String));
  });
});

describe('t', () => {
  it('returns the plain string', () => {
    expect(t('app.name')).toBe('Email to PDF');
    expect(t('warnings.parse.html-body-unreadable')).toBe(
      'Part of this email could not be shown (the formatted version could not be read).',
    );
  });

  it('fills in placeholders, numbers written the local way', () => {
    expect(t('steps.number', { number: 2 })).toBe('Step 2');
    expect(t('drop.reading', { done: 1, total: 1234 })).toBe('Reading file 1 of 1,234...');
  });

  it('picks the English plural form', () => {
    expect(t('counts.files', { count: 1 })).toBe('1 file');
    expect(t('counts.files', { count: 0 })).toBe('0 files');
    expect(t('counts.files', { count: 2 })).toBe('2 files');
    expect(t('counts.duplicatesMerged', { count: 1 })).toBe('1 identical copy merged');
    expect(t('counts.included', { included: 2, count: 3 })).toBe('2 of 3 emails will be in the PDF.');
    expect(t('counts.included', { included: 0, count: 1 })).toBe('0 of 1 email will be in the PDF.');
  });

  it('fills every placeholder of every entry when given its params', () => {
    for (const [key, value] of enEntries) {
      const params = Object.fromEntries(placeholderSet(value).map((name) => [name, name === 'count' ? 2 : 'X']));
      const text = (t as (key: string, params: Record<string, string | number>) => string)(key, params);
      expect(text, key).not.toMatch(/[{}]/);
      expect(text, key).not.toBe(key);
    }
  });

  it('works with keys built from a code (type-checked template keys)', () => {
    const code = 'corrupt' as 'corrupt' | 'too-large';
    expect(t(`errors.file.${code}`)).toBe('This file could not be read. It may be damaged.');
  });

  it('shows the key for an unknown key (only possible by bypassing the types)', () => {
    const untyped = t as (key: MessageKey) => string;
    expect(untyped('app.nope' as MessageKey)).toBe('app.nope');
    expect(untyped('app' as MessageKey)).toBe('app');
  });

  it('type-checks keys and params at compile time', () => {
    // Each line below must be a TypeScript error; `npm run typecheck` fails
    // if one of them ever compiles (an unused @ts-expect-error is an error).
    // @ts-expect-error unknown key
    t('app.nam');
    // @ts-expect-error params are required
    t('drop.reading');
    // @ts-expect-error misspelled placeholder
    t('drop.reading', { done: 1, totl: 2 });
    // @ts-expect-error a plural count must be a number
    t('counts.files', { count: '2' });
    // @ts-expect-error no params for a string without placeholders
    t('app.name', { x: 1 });
    expect(true).toBe(true);
  });
});

describe('helpers', () => {
  it('interpolate keeps values as plain text and leaves unknown placeholders visible', () => {
    expect(interpolate('File {name}', { name: '<b>x</b>.eml' })).toBe('File <b>x</b>.eml');
    expect(interpolate('{a} and {b}', { a: 'one' })).toBe('one and {b}');
    // Only own properties count, never inherited ones such as "constructor".
    expect(interpolate('{constructor}', {})).toBe('{constructor}');
    // A value that looks like a placeholder is not filled in again.
    expect(interpolate('{a}{b}', { a: '{b}', b: 'B' })).toBe('{b}B');
  });

  it('pluralForm uses "other" for anything that is not exactly one', () => {
    const forms = { one: 'one', other: 'other' };
    expect([0, 1, 2, 1.5, -1, Number.NaN].map((n) => pluralForm(forms, n))).toEqual([
      'other',
      'one',
      'other',
      'other',
      'one',
      'other',
    ]);
  });

  it('lookup walks own keys only', () => {
    expect(lookup(en, 'steps.add.title')).toBe('Add your emails');
    expect(lookup(en, 'counts.files')).toEqual(en.counts.files);
    expect(lookup(en, 'steps.add')).toBeUndefined();
    expect(lookup(en, 'toString')).toBeUndefined();
    expect(lookup(en, '__proto__.x')).toBeUndefined();
  });

  it('placeholdersIn lists placeholders in order', () => {
    expect(placeholdersIn('Reading file {done} of {total}...')).toEqual(['done', 'total']);
    expect(placeholdersIn('none')).toEqual([]);
  });
});

describe('languages (the shipped catalog: English and French)', () => {
  it('ships English then French; the page starts in English until it picks one', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'fr']);
    expect(DEFAULT_LOCALE).toBe('en');
    expect(getLocale()).toBe('en');
    // Each name in its own language, never translated.
    expect(languageName('en')).toBe('English');
    expect(languageName('fr')).toBe('Français');
  });

  it('isSupportedLocale: exact shipped codes only', () => {
    expect(isSupportedLocale('en')).toBe(true);
    expect(isSupportedLocale('fr')).toBe(true);
    for (const value of ['EN', 'en-US', 'FR', 'fr-BE', 'nl', 'xx', '', ' en', 'toString', '__proto__', null, undefined, 1, ['en']]) {
      expect(isSupportedLocale(value), String(value)).toBe(false);
    }
  });

  it('setLocale refuses a language the page does not ship (the page language stays)', () => {
    expect(() => setLocale('nl')).toThrow(/unsupported/);
    expect(() => setLocale('fr-BE')).toThrow(/unsupported/);
    expect(() => setLocale('EN')).toThrow(/unsupported/);
    expect(getLocale()).toBe('en');
  });

  it('translator: one per language, made once and kept; refuses an unknown language', () => {
    const en1 = translator('en');
    expect(translator('en')).toBe(en1);
    expect(en1.locale).toBe('en');
    expect(() => translator('xx')).toThrow(/unsupported/);
    expect(() => translator('toString')).toThrow(/unsupported/);
  });

  it('translator: English text, numbers, lists and plurals', () => {
    const tr = translator('en');
    expect(tr.t('steps.add.title')).toBe('Add your emails');
    expect(tr.t('drop.reading', { done: 1, total: 1234 })).toBe('Reading file 1 of 1,234...');
    expect(tr.number(1234.5)).toBe('1,234.5');
    expect(tr.list(['a', 'b', 'c'])).toBe('a, b, c');
    expect(tr.plural({ one: 'one', other: 'other' }, 1)).toBe('one');
    expect(tr.plural({ one: 'one', other: 'other' }, 2)).toBe('other');
    expect(tr.t('pdf.document.fileName', { date: '2025-06-02' })).toBe('correspondence-2025-06-02.pdf');
    expect(tr.t('pdf.document.fileNameNoDate')).toBe('correspondence.pdf');
  });
});

describe('pickLocale', () => {
  const withFrench = ['en', 'fr'];

  it('takes the primary subtag of the FIRST language when the page ships it', () => {
    expect(pickLocale(['fr-BE'], withFrench)).toBe('fr');
    expect(pickLocale(['fr'], withFrench)).toBe('fr');
    expect(pickLocale(['en-GB', 'fr'], withFrench)).toBe('en');
    expect(pickLocale(['fr_CA'], withFrench)).toBe('fr');
  });

  it('is case-insensitive and ignores spaces around the tag', () => {
    expect(pickLocale(['FR-be'], withFrench)).toBe('fr');
    expect(pickLocale(['Fr'], withFrench)).toBe('fr');
    expect(pickLocale([' fr-BE '], withFrench)).toBe('fr');
  });

  it('never looks past the first language: anything else gives English', () => {
    expect(pickLocale(['de', 'fr'], withFrench)).toBe('en');
    expect(pickLocale(['de-AT', 'fr-BE', 'en'], withFrench)).toBe('en');
    expect(pickLocale(['', 'fr'], withFrench)).toBe('en');
    expect(pickLocale(['frr'], withFrench)).toBe('en');
  });

  it('gives English for an empty list', () => {
    expect(pickLocale([], withFrench)).toBe('en');
    expect(pickLocale([])).toBe('en');
  });

  it('uses the shipped languages by default (English and French)', () => {
    expect(pickLocale(['fr-BE'])).toBe('fr');
    expect(pickLocale(['fr-FR', 'en'])).toBe('fr');
    expect(pickLocale(['fr-CA'])).toBe('fr');
    expect(pickLocale(['en-US'])).toBe('en');
    // Only the first language counts.
    expect(pickLocale(['nl-BE', 'fr-BE'])).toBe('en');
  });
});
