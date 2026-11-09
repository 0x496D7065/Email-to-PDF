// The whole PDF path (generatePdf, real fonts, our own writer), read back
// from the written file as text (tests/support/pdf-reader.ts: glyphs
// through ToUnicode, as a reader sees them), for task 8.7 (user decision
// 2026-11-05, PDF only):
// - nothing in the PDF (cover, index, emails, bookmarks) says or hints that
//   an email was rebuilt from quoted text (task 8.3, checked again here in
//   every language, default and "Print full original text");
// - the cover has its title, date range, email count, generation date and
//   people, and NO source files: no heading, no file names, no SHA-256
//   (user decision 2026-11-09, task 8.12, replacing brief section 8.5);
// - the index follows the cover information directly on page 1, and every
//   email starts at the top of a page of its own (task 8.12);
// - collapse, never delete: the engine result (every message and every
//   rebuilt email) is the same after the PDF is made.
// Synthetic fixtures only (tests/fixtures/eml/): the last email of a thread
// alone (three earlier emails rebuilt from its quote), and several files of
// two threads, one of them an identical copy that is merged.
import { beforeAll, describe, expect, it } from 'vitest';
import { parseAllFixtures } from '../../tests/fixtures/parse-all';
import { readOutline, readPageRuns, readPdf, textLines } from '../../tests/support/pdf-reader';
import { runEngine } from '../engine/engine';
import { DEFAULT_OUTPUT_POLICY, planOutput } from '../engine/output-plan';
import type { NormalizedMessage } from '../parsing/types';
import { CATALOG } from '../ui/i18n/catalog';
import { isPluralForms, type Messages } from '../ui/i18n';
import { rebuiltEntries } from '../ui-model/rebuilt';
import { generatePdf, type PdfFonts } from './generate';
import { loadPdfFonts } from './load-fonts';
import { buildPdfDocument } from './model';
import { createPdfStrings } from './strings';

const LOCALES = ['en', 'fr', 'nl'] as const;
type Locale = (typeof LOCALES)[number];

const SETS = {
  'the last email alone': ['eml/13-order-4-bob-outlook-nl.eml'],
  'several files, a merged copy among them': [
    'eml/11-order-2-bob-outlook-en.eml',
    'eml/30-dup-order-2-copy.eml',
    'eml/12-order-3-alice-gmail.eml',
    'eml/13-order-4-bob-outlook-nl.eml',
    'eml/23-delivery-4-alice-outlook-fr.eml',
  ],
} as const;
type SetName = keyof typeof SETS;

const GENERATED_AT = Date.UTC(2025, 5, 1, 12, 0, 0);
const ZONE = 'Africa/Lagos';

let fonts: PdfFonts;
let parsed: NormalizedMessage[];
beforeAll(async () => {
  fonts = await loadPdfFonts();
  parsed = await parseAllFixtures();
});

function messagesOf(set: SetName): NormalizedMessage[] {
  return SETS[set].map((name) => {
    const found = parsed.find((m) => m.source.fileName === name);
    if (found === undefined) throw new Error(`no fixture ${name}`);
    return found;
  });
}

/** The PDF of `set` (every email included, every rebuilt email chosen) read back, with the model behind it. */
async function make(set: SetName, locale: Locale, full: boolean) {
  const result = runEngine(messagesOf(set).map((message) => ({ ok: true as const, message })));
  const before = JSON.stringify(result);
  const positions = result.messages.map((_, k) => k);
  const policy = { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: full };
  const plans = planOutput(
    positions.map((p) => result.messages[p]!),
    policy,
  );
  const rebuilt = rebuiltEntries(result).map((r) => r.id);
  const input = { result, positions, plans, rebuilt, policy, timeZone: ZONE, generatedAt: GENERATED_AT };
  const made = await generatePdf({ ...input, fonts, locale });
  const doc = buildPdfDocument({ ...input, strings: createPdfStrings(locale) });
  const pdf = readPdf(made.bytes);
  const pages = (await readPageRuns(pdf)).map((runs) => textLines(runs).map((l) => l.shown));
  const all = pages.map((lines) => lines.join(' ')).join(' ');
  const bookmarks = readOutline(pdf)!.items.map((i) => i.title);
  return { result, before, rebuilt, doc, pages, all, bookmarks };
}

/**
 * Words that name rebuilding or quoted-text reconstruction, in each language.
 * This stem list is only a backstop: any new text about rebuilt emails must live under the
 * catalog's `rebuilt` group, so that `rebuiltFragments` catches it whatever its wording.
 */
const REBUILT_WORDS: Record<Locale, RegExp> = {
  en: /rebuil|reconstruct|quoted text|not original|incomplete or inexact/i,
  fr: /reconstitu|reconstrui|texte cit|pas des fichiers d.origine|incomplets? ou inexact/i,
  nl: /gereconstrueerd|reconstru|geciteerde tekst|geen originele|onvolledig of onnauwkeurig/i,
};

/** Every text of the page that is about rebuilt emails (the preview's `rebuilt` group, and any other text naming them), cut at its placeholders. */
function rebuiltFragments(locale: Locale): string[] {
  const out: string[] = [];
  const walk = (value: unknown, inRebuilt: boolean): void => {
    if (typeof value === 'string') {
      if (!inRebuilt && !REBUILT_WORDS[locale].test(value)) return;
      for (const piece of value.split(/\{[a-z]+\}/i)) if (piece.trim().length >= 10) out.push(piece.trim());
    } else if (isPluralForms(value)) {
      for (const v of Object.values(value)) walk(v, inRebuilt);
    } else if (typeof value === 'object' && value !== null) {
      for (const [k, v] of Object.entries(value)) walk(v, inRebuilt || k === 'rebuilt');
    }
  };
  walk(CATALOG[locale] satisfies Messages | undefined, false);
  return out;
}

/** What the PDF used to write before tasks 8.3 and 8.7 (those strings are gone from the catalog). */
const REMOVED: Record<Locale, string[]> = {
  en: [
    'Earlier email (rebuilt from quoted text in email',
    '[Rebuilt]',
    'Rebuilt emails',
    'Earlier emails rebuilt from quoted text',
    'They are not original files.',
    'Every file that gave an email in this PDF, with its SHA-256 fingerprint.',
    'A file with the same fingerprint is exactly the same file.',
  ],
  fr: [
    'E-mail antérieur (reconstitué',
    '[Reconstitué]',
    'E-mails reconstitués',
    'Ce ne sont pas des fichiers d’origine.',
    'Chaque fichier dont provient un e-mail de ce PDF, avec son empreinte SHA-256.',
    'Un fichier qui a la même empreinte est exactement le même fichier.',
  ],
  nl: [
    'Eerdere e-mail (gereconstrueerd',
    '[Gereconstrueerd]',
    'Gereconstrueerde e-mails',
    'Het zijn geen originele bestanden.',
    'Elk bestand waaruit een e-mail in deze PDF komt, met zijn SHA-256-vingerafdruk.',
    'Een bestand met dezelfde vingerafdruk is precies hetzelfde bestand.',
  ],
};

/** The cover's old "Source files" heading (removed in task 8.12, with the file list and the SHA-256). */
const SOURCES_HEADING: Record<Locale, string> = { en: 'Source files', fr: 'Fichiers sources', nl: 'Bronbestanden' };

/** The PDF read back: lines may wrap anywhere, so texts are compared with spaces collapsed. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');

describe('tasks 8.7 and 8.12: no text about rebuilt emails, no source files or SHA-256, the index right after the cover', () => {
  it('the fixtures give rebuilt emails, and catalog fragments to look for', () => {
    for (const set of Object.keys(SETS) as SetName[]) {
      const result = runEngine(messagesOf(set).map((message) => ({ ok: true as const, message })));
      expect(rebuiltEntries(result).length, set).toBeGreaterThan(0);
    }
    for (const locale of LOCALES) expect(rebuiltFragments(locale).length, locale).toBeGreaterThan(10);
    // The note is gone from the PDF texts.
    // So are the source file texts (task 8.12).
    for (const key of ['sourcesIntro', 'sourcesHeading', 'sourceEmail', 'separator']) expect(Object.keys(createPdfStrings('en'))).not.toContain(key);
    for (const locale of LOCALES) {
      for (const key of ['sourcesIntro', 'sources', 'sourceEmail']) expect(Object.keys(CATALOG[locale]!.pdf.document), locale).not.toContain(key);
    }
  });

  for (const set of Object.keys(SETS) as SetName[]) {
    for (const locale of LOCALES) {
      for (const full of [false, true]) {
        it(`${set}, ${locale}, ${full ? '"Print full original text"' : 'default'}`, async () => {
          const s = createPdfStrings(locale);
          const { result, before, rebuilt, doc, pages, all, bookmarks } = await make(set, locale, full);
          const cover = pages[0]!;
          const coverText = flat(cover.join(' '));

          // Rebuilt emails are in the PDF by default (none with the full text), numbered like the others.
          const real = result.messages.length;
          expect(doc.cover.emailCount).toBe(full ? real : real + rebuilt.length);
          expect(doc.emails.filter((e) => e.rebuilt !== null)).toHaveLength(full ? 0 : rebuilt.length);

          // Nothing about rebuilding, anywhere: cover, index, emails, bookmarks.
          const text = flat(all);
          expect(text).not.toMatch(REBUILT_WORDS[locale]);
          for (const f of [...rebuiltFragments(locale), ...REMOVED[locale]]) expect(text, `"${f}"`).not.toContain(flat(f));
          for (const title of bookmarks) expect(title).not.toMatch(REBUILT_WORDS[locale]);

          // The cover: title, dates, count, zone, made on; people. No source files, no SHA-256 (task 8.12).
          expect(cover[0]).toBe(s.title);
          const range = doc.cover.dateRange!;
          expect(coverText).toContain(flat(`${s.datesLabel} ${range.first === range.last ? range.first : s.dateRange(range.first, range.last)}`));
          expect(coverText).toContain(`${s.emailsLabel} ${s.emailCount(doc.cover.emailCount)}`);
          expect(coverText).toContain(`${s.generatedLabel} ${doc.cover.generated}`);
          expect(cover).toContain(s.peopleHeading);
          expect(doc.cover.participants.length).toBeGreaterThan(0);
          for (const p of doc.cover.participants) expect(coverText).toContain(p.name === '' ? p.address : s.mailbox(p.name, p.address));
          // Task 8.12: no source file list, no file names, no SHA-256 anywhere in the PDF.
          // (The file names are only in each real email's own File row, never before the first email.)
          expect(text).not.toMatch(/\b[0-9a-f]{64}\b/);
          expect(text).not.toContain(SOURCES_HEADING[locale]);
          const firstEmailPage = pages.findIndex((lines) => lines[0] === doc.emails[0]!.heading);
          expect(firstEmailPage).toBeGreaterThan(0);
          const front = pages.slice(0, firstEmailPage);
          const frontText = flat(front.map((lines) => lines.join(' ')).join(' '));
          for (const name of SETS[set]) expect(frontText, name).not.toContain(name);
          expect(Object.keys(doc.cover)).not.toContain('sources');
          // The cover blocks end with the people list: no other heading after it.
          const headings = doc.cover.blocks.filter((b) => b.kind === 'heading').map((b) => b.line.map((r) => r.text).join(''));
          expect(headings).toEqual([s.title, s.peopleHeading]);

          // The index follows the cover information on page 1: its heading right after the people list.
          const people = cover.indexOf(s.peopleHeading);
          const indexAt = cover.indexOf(s.indexHeading);
          expect(people).toBeGreaterThan(0);
          expect(indexAt).toBe(people + 1 + doc.cover.participants.length);
          // Every email starts at the top of a page of its own (its heading first), in order, after the front.
          let previous = firstEmailPage - 1;
          for (const e of doc.emails) {
            const at = pages.findIndex((lines, i) => i > previous && lines[0] === e.heading);
            expect(at, e.heading).toBeGreaterThan(previous);
            previous = at;
          }
          expect(cover.at(-1)).toBe(s.pageFooter(1, pages.length));

          // Collapse, never delete: the engine data is unchanged by making the PDF.
          expect(JSON.stringify(result)).toBe(before);
        });
      }
    }
  }
});
