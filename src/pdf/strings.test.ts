// Unit tests for the PDF's fixed texts (strings.ts): always in the language
// asked for, never in the page's active language. A synthetic language
// ('xx', tests/support/test-locale.ts) is added to the catalog for this
// file only; it is never shipped.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pseudo } from '../../tests/support/test-locale';
import { setLocale } from '../ui/i18n';
import { createPdfStrings } from './strings';

vi.mock('../ui/i18n/catalog', async (importOriginal) => {
  const { withTestLocales } = await import('../../tests/support/test-locale');
  return withTestLocales(await importOriginal(), ['xx']);
});

afterEach(() => {
  setLocale('en');
});

describe('createPdfStrings', () => {
  it('gives the English texts for "en"', () => {
    const strings = createPdfStrings('en');
    expect(strings.locale).toBe('en');
    expect(strings.title).toBe('Email correspondence');
    expect(strings.pageFooter(3, 12)).toBe('Page 3 of 12');
    expect(strings.fileName('2025-06-02')).toBe('correspondence-2025-06-02.pdf');
    expect(strings.fileName(null)).toBe('correspondence.pdf');
    expect(strings.size(2048)).toBe('2 KB');
  });

  it('gives the texts of the language asked for, whatever the page language', () => {
    setLocale('en');
    const xx = createPdfStrings('xx');
    expect(xx.locale).toBe('xx');
    expect(xx.title).toBe(pseudo('Email correspondence'));
    expect(xx.fromLabel).toBe(pseudo('From'));
    expect(xx.pageFooter(3, 12)).toBe(pseudo('Page {page} of {total}').replace('{page}', '3').replace('{total}', '12'));
    expect(xx.fileName('2025-06-02')).toBe(pseudo('correspondence-{date}.pdf').replace('{date}', '2025-06-02'));
    // The tool's name is never translated.
    expect(xx.producer).toBe('Email to PDF');

    setLocale('xx');
    const en = createPdfStrings('en');
    expect(en.title).toBe('Email correspondence');
    expect(en.fileName('2025-06-02')).toBe('correspondence-2025-06-02.pdf');
  });

  it('refuses a language the page does not ship (no fallback of its own)', () => {
    expect(() => createPdfStrings('zz')).toThrow(/unsupported/);
    expect(() => createPdfStrings('')).toThrow(/unsupported/);
  });
});

describe('the texts of rebuilt emails (task 7.7)', () => {
  it('mark them, name the email they were taken from by its PDF number, and reuse the preview words', () => {
    const s = createPdfStrings('en');
    expect(s.rebuiltHeading(3)).toBe('Earlier email (rebuilt from quoted text in email 3)');
    expect(s.rebuiltMarker).toBe('[Rebuilt]');
    expect(s.rebuiltBookmark('2025-03-03', 'Alice Example', 'Desks')).toBe('[Rebuilt] 2025-03-03, Alice Example: Desks');
    expect(s.rebuiltNote(3, true)).toBe('Rebuilt from the quoted text in email 3. Quote marks removed; may be incomplete or inexact.');
    expect(s.rebuiltNote(3, false)).toBe('Rebuilt from the quoted text in email 3. May be incomplete or inexact.');
    expect(s.rebuiltAlso([])).toBe('');
    expect(s.rebuiltAlso([4])).toBe('Same quoted text also in email 4.');
    expect(s.rebuiltAlso([4, 1006])).toBe('Same quoted text also in emails 4, 1006.');
    expect(s.takenFromLabel).toBe('Taken from');
    expect(s.takenFrom(1234)).toBe('email 1234');
    expect(s.dateAbout('2025-03-03 09:15')).toBe('about 2025-03-03 09:15');
    expect(s.quoteDateAsWritten('maandag')).toBe('As written in the quote: maandag');
    expect(s.rebuiltCount(1)).toBe('1 earlier email rebuilt from quoted text');
    expect(s.rebuiltCount(2)).toBe('2 earlier emails rebuilt from quoted text');
    // The paragraph names the marker the index uses, in every language.
    for (const locale of ['en', 'fr', 'nl']) {
      const x = createPdfStrings(locale);
      expect(x.rebuiltIntro).toContain(x.rebuiltMarker);
      expect(x.rebuiltBookmark('d', 'f', 's').startsWith(`${x.rebuiltMarker} `)).toBe(true);
    }
  });
});
