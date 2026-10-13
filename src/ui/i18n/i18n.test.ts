// Unit tests for the strings system: every string is usable, placeholders
// are consistent, and t() fills them in as text.
import { describe, expect, it } from 'vitest';
import { FOLD_REASONS } from '../../engine/segments';
import { en } from './en';
import { interpolate, isPluralForms, lookup, placeholdersIn, pluralForm, t, type Messages, type MessageKey } from './index';

/** Every language file. French and Dutch are added here when they exist. */
const LOCALES: Readonly<Record<string, Messages>> = { en };

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

  it('uses only well-formed {name} placeholders (no stray braces)', () => {
    for (const [key, value] of enEntries) {
      for (const text of textsOf(value)) {
        const withoutPlaceholders = text.replace(/\{\w+\}/g, '');
        expect(withoutPlaceholders, key).not.toMatch(/[{}]/);
      }
    }
  });

  it('gives both plural forms the same placeholders, always including {count}', () => {
    for (const [key, value] of enEntries) {
      if (!isPluralForms(value)) continue;
      expect(placeholderSet(value.one), key).toEqual(placeholderSet(value.other));
      expect(placeholderSet(value.one), key).toContain('count');
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
    expect(t('counts.filesRead', { count: 1 })).toBe('1 file read');
    expect(t('counts.filesRead', { count: 0 })).toBe('0 files read');
    expect(t('counts.filesRead', { count: 2 })).toBe('2 files read');
    expect(t('counts.duplicatesMerged', { count: 1 })).toBe('1 identical copy merged');
    expect(t('counts.undated', { count: 3 })).toBe('3 emails have no date');
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
    t('counts.filesRead', { count: '2' });
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
    expect(lookup(en, 'counts.filesRead')).toEqual(en.counts.filesRead);
    expect(lookup(en, 'steps.add')).toBeUndefined();
    expect(lookup(en, 'toString')).toBeUndefined();
    expect(lookup(en, '__proto__.x')).toBeUndefined();
  });

  it('placeholdersIn lists placeholders in order', () => {
    expect(placeholdersIn('Reading file {done} of {total}...')).toEqual(['done', 'total']);
    expect(placeholdersIn('none')).toEqual([]);
  });
});
