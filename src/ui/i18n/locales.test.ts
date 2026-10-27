// Unit tests for switching between languages, with two synthetic languages
// added to the catalog for this file only (tests/support/test-locale.ts):
// 'xx' (not a real language) and 'de', whose strings are the same synthetic
// text but whose code is a real one, so the browser's number and list rules
// of a real other language can be checked. Neither is ever shipped.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pseudo } from '../../../tests/support/test-locale';
import { getLocale, interpolate, languageName, pickLocale, pluralForm, setLocale, SUPPORTED_LOCALES, t, translator } from './index';

vi.mock('./catalog', async (importOriginal) => {
  const { withTestLocales } = await import('../../../tests/support/test-locale');
  return withTestLocales(await importOriginal(), ['xx', 'de']);
});

afterEach(() => {
  setLocale('en');
});

describe('with more than one language', () => {
  it('lists every language of the catalog, English first', () => {
    expect(SUPPORTED_LOCALES).toEqual(['en', 'xx', 'de']);
    expect(languageName('xx')).toBe('[Pseudo xx]');
    expect(languageName('en')).toBe('English');
    expect(languageName('zz')).toBe('zz');
  });

  it('pickLocale uses the shipped list by default: the first language only', () => {
    expect(pickLocale(['de-AT'])).toBe('de');
    expect(pickLocale(['DE'])).toBe('de');
    expect(pickLocale(['fr-BE', 'de'])).toBe('en');
    expect(pickLocale([])).toBe('en');
  });

  it('setLocale switches what t() returns; getLocale says which', () => {
    expect(t('steps.add.title')).toBe('Add your emails');
    setLocale('xx');
    expect(getLocale()).toBe('xx');
    expect(t('steps.add.title')).toBe(pseudo('Add your emails'));
    expect(t('counts.files', { count: 2 })).toBe(pseudo('{count} files').replace('{count}', '2'));
    // The app's name is never translated.
    expect(t('app.name')).toBe('Email to PDF');
    setLocale('en');
    expect(t('steps.add.title')).toBe('Add your emails');
  });

  it('translator: one per language, made once and kept, independent of the page language', () => {
    const xx = translator('xx');
    expect(translator('xx')).toBe(xx);
    expect(translator('en')).not.toBe(xx);
    setLocale('xx');
    expect(translator('en').t('steps.add.title')).toBe('Add your emails');
    expect(translator('xx')).toBe(xx);
  });

  it('formats numbers and lists with each language own rules', () => {
    const en = translator('en');
    const de = translator('de');
    expect(en.number(1234.5)).toBe('1,234.5');
    expect(de.number(1234.5)).toBe('1.234,5');
    expect(en.list(['a', 'b', 'c'])).toBe('a, b, c');
    expect(de.list(['a', 'b', 'c'])).toBe(new Intl.ListFormat('de', { style: 'short', type: 'unit' }).format(['a', 'b', 'c']));
    expect(de.list(['a', 'b', 'c'])).not.toBe(en.list(['a', 'b', 'c']));
    // Placeholders are filled with the language's numbers.
    expect(de.t('drop.reading', { done: 1, total: 1234 })).toBe(pseudo('Reading file {done} of {total}...').replace('{done}', '1').replace('{total}', '1.234'));
    expect(interpolate('{n}', { n: 1234 }, 'de')).toBe('1.234');
    expect(interpolate('{n}', { n: 1234 }, 'en')).toBe('1,234');
  });

  it('interpolate and pluralForm follow the page language by default', () => {
    setLocale('de');
    expect(interpolate('{n}', { n: 1234 })).toBe('1.234');
    expect(pluralForm({ one: 'one', other: 'other' }, 1)).toBe('one');
    setLocale('en');
    expect(interpolate('{n}', { n: 1234 })).toBe('1,234');
  });
});
