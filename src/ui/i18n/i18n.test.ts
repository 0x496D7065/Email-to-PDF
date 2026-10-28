// Unit tests for the strings system: every string is usable, placeholders
// are consistent, and t() fills them in as text.
import { describe, expect, it } from 'vitest';
import { FOLD_REASONS } from '../../engine/segments';
import { en } from './en';
import { fr } from './fr';
import { nl } from './nl';
import enSource from './en.ts?raw';
import frSource from './fr.ts?raw';
import nlSource from './nl.ts?raw';
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

/** Every language file. */
const LOCALES: Readonly<Record<string, Messages>> = { en, fr, nl };

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

  it('has no comma in any PDF reason, in every language (reasons are joined with ", ", so a comma would read as two reasons)', () => {
    for (const [name, table] of Object.entries(LOCALES)) {
      const reasons = entries(table).filter(([key]) => key.startsWith('pdf.reason.'));
      expect(reasons.length, name).toBeGreaterThan(0);
      for (const [key, value] of reasons) {
        for (const text of textsOf(value)) expect(text, `${name} ${key}`).not.toContain(',');
      }
    }
  });

  it('has a fold label for every fold reason', () => {
    for (const reason of FOLD_REASONS) expect(lookup(en, `preview.fold.${reason}`), reason).toEqual(expect.any(String));
  });
});

describe('"Put everything in the PDF": its note and the rebuilt card mark (user decision 2026-10-28, task 7.8b)', () => {
  /** The checkbox's name without the part in brackets ("Put everything in the PDF"). */
  const shortName = (m: Messages): string => m.pdf.everything.replace(/\s*\(.*\)$/, '');
  /** How each language quotes a control's name (as the "Clear everything" mentions do). */
  const QUOTED: Readonly<Record<string, (name: string) => string>> = {
    en: (name) => `"${name}"`,
    fr: (name) => `«\u00A0${name}\u00A0»`,
    nl: (name) => `“${name}”`,
  };

  it('every language has a note and a card mark, different from the checkbox label and from each other', () => {
    for (const [name, m] of Object.entries(LOCALES)) {
      expect(m.pdf.everythingNote.length, name).toBeGreaterThan(60);
      expect(m.pdf.everythingNote, name).not.toBe(m.pdf.everything);
      expect(m.rebuilt.everythingExcluded, name).not.toBe(m.rebuilt.sourceExcluded);
      expect(placeholdersIn(m.pdf.everythingNote), name).toEqual([]);
      expect(placeholdersIn(m.rebuilt.everythingExcluded), name).toEqual([]);
    }
  });

  it('the card mark names the checkbox as it reads, quoted as each language does, and starts like the other "Not in the PDF" marks', () => {
    for (const [name, m] of Object.entries(LOCALES)) {
      expect(m.rebuilt.everythingExcluded, name).toContain(QUOTED[name]!(shortName(m)));
      expect(m.rebuilt.everythingExcluded.startsWith(m.review.excluded), name).toBe(true);
    }
  });

  it('the note says: every email in full with the quoted earlier emails, may repeat, cleaner unticked, rebuilt emails left out', () => {
    const parts: Readonly<Record<string, readonly RegExp[]>> = {
      en: [/^Ticking this puts every ticked email in the PDF in full/, /quoted earlier emails/, /more than once/, /unticked for a cleaner PDF/, /rebuilt emails are left out of the PDF/, /repeat the quoted text/],
      fr: [/^Si cette case est cochée, chaque e-mail coché figure en entier dans le PDF/, /e-mails antérieurs cités/, /plusieurs fois/, /décochée pour un PDF plus clair/, /e-mails reconstitués ne sont pas mis dans le PDF/, /répéter le texte cité/],
      nl: [/^Als dit is aangevinkt, komt elke aangevinkte e-mail volledig in de PDF/, /geciteerde eerdere e-mails/, /meer dan eens/, /uitgevinkt voor een overzichtelijkere PDF/, /gereconstrueerde e-mails buiten de PDF/, /geciteerde tekst herhalen/],
    };
    for (const [name, m] of Object.entries(LOCALES)) {
      for (const part of parts[name]!) expect(m.pdf.everythingNote, `${name} ${String(part)}`).toMatch(part);
    }
  });

  it('the rebuilt label word of each language is the one the note uses', () => {
    expect(en.pdf.everythingNote).toContain(en.rebuilt.label.toLowerCase());
    expect(fr.pdf.everythingNote.toLowerCase()).toContain(fr.rebuilt.label.toLowerCase().slice(0, 10));
    expect(nl.pdf.everythingNote.toLowerCase()).toContain(nl.rebuilt.label.toLowerCase());
  });

  it('no language file holds a raw invisible character: only \\u escapes (no-break spaces, thin spaces, zero widths)', () => {
    for (const [name, source] of Object.entries({ en: enSource, fr: frSource, nl: nlSource })) {
      expect(source, name).not.toMatch(/[\u00A0\u00AD\u2000-\u200F\u2028\u2029\u202F\u2060\uFEFF]/);
    }
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

describe('languages (the shipped catalog: English, French and Dutch)', () => {
  it('ships English, French, then Dutch; the page starts in English until it picks one', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'fr', 'nl']);
    expect(DEFAULT_LOCALE).toBe('en');
    expect(getLocale()).toBe('en');
    // Each name in its own language, never translated.
    expect(languageName('en')).toBe('English');
    expect(languageName('fr')).toBe('Français');
    expect(languageName('nl')).toBe('Nederlands');
  });

  it('isSupportedLocale: exact shipped codes only', () => {
    expect(isSupportedLocale('en')).toBe(true);
    expect(isSupportedLocale('fr')).toBe(true);
    expect(isSupportedLocale('nl')).toBe(true);
    for (const value of ['EN', 'en-US', 'FR', 'fr-BE', 'NL', 'nl-BE', 'de', 'xx', '', ' en', 'toString', '__proto__', null, undefined, 1, ['en']]) {
      expect(isSupportedLocale(value), String(value)).toBe(false);
    }
  });

  it('setLocale refuses a language the page does not ship (the page language stays)', () => {
    expect(() => setLocale('de')).toThrow(/unsupported/);
    expect(() => setLocale('nl-BE')).toThrow(/unsupported/);
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

  it('uses the shipped languages by default (English, French and Dutch)', () => {
    expect(pickLocale(['fr-BE'])).toBe('fr');
    expect(pickLocale(['fr-FR', 'en'])).toBe('fr');
    expect(pickLocale(['fr-CA'])).toBe('fr');
    expect(pickLocale(['nl-BE'])).toBe('nl');
    expect(pickLocale(['nl-NL', 'en'])).toBe('nl');
    expect(pickLocale(['en-US'])).toBe('en');
    // Only the first language counts.
    expect(pickLocale(['nl-BE', 'fr-BE'])).toBe('nl');
    expect(pickLocale(['de', 'nl'])).toBe('en');
    expect(pickLocale(['en-GB', 'nl-BE'])).toBe('en');
  });
});
