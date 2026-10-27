// The whole PDF path (generatePdf, real fonts, our own writer) with emails
// rebuilt from quoted text (task 7.7), read back from the written file as
// text (tests/support/pdf-reader.ts: glyphs through ToUnicode, as a reader
// sees them): the cover's count and paragraph, the index marker, the
// heading, the "Taken from" row, the fixed note, the bookmarks, and the
// SHA-256 of the real file only. Synthetic fixture only
// (tests/fixtures/eml/13-order-4-bob-outlook-nl.eml: the last email of a
// thread, whose quote holds 3 earlier emails).
import { beforeAll, describe, expect, it } from 'vitest';
import { parseAllFixtures } from '../../tests/fixtures/parse-all';
import { readDests, readOutline, readPageRuns, readPdf, textLines } from '../../tests/support/pdf-reader';
import { runEngine, type EngineResult } from '../engine/engine';
import { DEFAULT_OUTPUT_POLICY, planOutput } from '../engine/output-plan';
import type { NormalizedMessage } from '../parsing/types';
import { rebuiltEntries } from '../ui-model/rebuilt';
import { generatePdf, type PdfFonts } from './generate';
import { loadPdfFonts } from './load-fonts';
import { createPdfStrings } from './strings';

let fonts: PdfFonts;
let last: NormalizedMessage;
beforeAll(async () => {
  fonts = await loadPdfFonts();
  const found = (await parseAllFixtures()).find((m) => m.source.fileName === 'eml/13-order-4-bob-outlook-nl.eml');
  if (found === undefined) throw new Error('no fixture');
  last = found;
});

const EN = createPdfStrings('en');

/** The PDF of the last email alone, with the given rebuilt ids (default: every entry), read back as text. */
async function pdfText(options: { rebuilt?: readonly number[]; positions?: readonly number[]; locale?: 'en' | 'fr' | 'nl' } = {}) {
  const result: EngineResult = runEngine([{ ok: true, message: last }]);
  const positions = options.positions ?? [0];
  const plans = planOutput(
    positions.map((p) => result.messages[p]!),
    DEFAULT_OUTPUT_POLICY,
  );
  const made = await generatePdf({
    result,
    positions,
    plans,
    rebuilt: options.rebuilt ?? rebuiltEntries(result).map((r) => r.id),
    policy: DEFAULT_OUTPUT_POLICY,
    timeZone: 'Africa/Lagos',
    generatedAt: Date.UTC(2025, 5, 1, 12, 0, 0),
    fonts,
    locale: options.locale ?? 'en',
  });
  const pdf = readPdf(made.bytes);
  const pages = (await readPageRuns(pdf)).map((runs) => textLines(runs).map((l) => l.shown));
  // Lines joined with spaces: a long line may wrap anywhere.
  const all = pages.map((lines) => lines.join(' ')).join(' ');
  return { pdf, pages, all, result };
}

/** The PDF text from `start` up to (not including) the first of `ends` after it. */
function between(all: string, start: string, ...ends: string[]): string {
  const from = all.indexOf(start);
  if (from < 0) throw new Error(`not found: ${start}`);
  const stops = ends.map((e) => all.indexOf(e, from + start.length)).filter((k) => k >= 0);
  return all.slice(from, stops.length === 0 ? undefined : Math.min(...stops));
}

describe('the PDF with rebuilt emails, read back', () => {
  it('cover: the count row and the paragraph saying what rebuilt emails are; the hash of the real file only', async () => {
    const { pages, result } = await pdfText();
    const cover = pages[0]!.join(' ');
    expect(cover).toContain('Emails 1 email');
    expect(cover).toContain('Rebuilt emails 3 earlier emails rebuilt from quoted text');
    expect(cover).toContain('Earlier emails rebuilt from quoted text');
    expect(cover).toContain(EN.rebuiltIntro.slice(0, 60));
    expect(cover).toContain('They are not original files.');
    // SHA-256: exactly one, the file's own (one file, one email; the rebuilt emails have none).
    const hashes = pages.flat().join('\n').match(/\b[0-9a-f]{64}\b/g);
    expect(hashes).toEqual([last.source.sha256]);
    expect(result.messages).toHaveLength(1);
  });

  it('index: the three rebuilt emails marked, without a number, before email 1', async () => {
    const { pdf, pages } = await pdfText();
    const dests = readDests(pdf);
    const indexPage = dests.get('index')!.page;
    const rows = pages[indexPage]!.filter((l) => /^\[Rebuilt\]|\[Rebuilt\]/.test(l) || /^1 /.test(l));
    expect(rows.filter((l) => l.includes('[Rebuilt]'))).toHaveLength(3);
    // No number in front of a rebuilt row: it starts with its date.
    for (const row of pages[indexPage]!.filter((l) => l.includes('[Rebuilt]'))) expect(row).toMatch(/^(about )?\d{4}-\d\d-\d\d/);
    expect(pages[indexPage]!.join('\n')).toContain('[Rebuilt] Re: Office desks and chairs');
    // Every rebuilt email has its own destination; the real one keeps "email-1".
    expect([...dests.keys()].filter((k) => k.startsWith('rebuilt-')).sort()).toEqual(['rebuilt-0', 'rebuilt-1', 'rebuilt-2']);
    expect(dests.has('email-1')).toBe(true);
    expect(dests.has('email-2')).toBe(false);
  });

  it('bookmarks: one per rebuilt email, marked, in PDF order', async () => {
    const { pdf } = await pdfText();
    const titles = readOutline(pdf)!.items.map((i) => i.title);
    expect(titles.slice(0, 2)).toEqual(['Cover', 'Index']);
    expect(titles.slice(2, 5).every((t) => t.startsWith('[Rebuilt] '))).toBe(true);
    expect(titles[4]).toBe('[Rebuilt] 2025-03-03, Alice Example: Re: Office desks and chairs');
    expect(titles[5]).toMatch(/^1\. /);
    expect(titles).toHaveLength(6);
  });

  it('a rebuilt email: heading suffix, the fields read from the quote, "Taken from", the fixed note, its text', async () => {
    const { all } = await pdfText();
    const heading = 'Earlier email (rebuilt from quoted text in email 1)';
    expect(all.split(heading)).toHaveLength(4);
    // The newest one (an Outlook block in Dutch, no quote marks), up to the real email.
    const parts = all.split(heading);
    const newest = between(parts[3]!, '', 'Email 1');
    expect(newest).toContain('From Alice Example <alice@example.test>');
    expect(newest).toMatch(/Date about 2025-03-03 \d\d:40 UTC\+01:00/);
    expect(newest).toContain('As written in the quote: maandag 3 maart 2025 15:40');
    expect(newest).toContain('Subject Re: Office desks and chairs');
    expect(newest).toContain('Taken from email 1');
    expect(newest).toContain('Rebuilt from the quoted text in email 1. May be incomplete or inexact.');
    expect(newest).not.toMatch(/\bFile\b/);
    // The Gmail quote: its ">" marks removed, and the note says so.
    const gmail = parts[2]!;
    expect(gmail).toContain('Rebuilt from the quoted text in email 1. Quote marks removed; may be incomplete or inexact.');
    expect(gmail).toContain('Subject (subject not in the quote)');
    expect(gmail).toContain('Thank you for your message.');
    expect(gmail).not.toMatch(/(^| )> /);
  });

  it('the switch off: nothing rebuilt in the PDF, no count, no paragraph, no marker', async () => {
    const { all, pdf } = await pdfText({ rebuilt: [] });
    expect(all).not.toMatch(/rebuilt|\[Rebuilt\]/i);
    expect(readOutline(pdf)!.items).toHaveLength(3);
  });

  it('in French: the heading, the marker and the paragraph in the PDF language', async () => {
    const { all } = await pdfText({ locale: 'fr' });
    expect(all).toContain('E-mail antérieur (reconstitué à partir du texte cité dans l’e-mail 1)');
    expect(all).toContain('[Reconstitué]');
    expect(all).toContain('Ce ne sont pas des fichiers d’origine.');
  });
});
