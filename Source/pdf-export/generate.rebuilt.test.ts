// The whole PDF path (generatePdf, real fonts, our own writer) with emails
// rebuilt from quoted text (tasks 7.7 and 8.3), read back from the written
// file as text (Helper/Test/test-support/pdf-reader.ts: glyphs through ToUnicode, as a
// reader sees them). USER DECISION 2026-11-02 (task 8.3, PDF only): a
// rebuilt email looks and is numbered exactly like a real one, so the PDF
// holds no rebuilt heading, marker, note, "Taken from" row, cover count or
// cover section, in any language; every email is numbered 1..n in PDF
// order (index, headings, bookmarks, links); the cover has no source file
// list and no SHA-256 (task 8.12). Synthetic fixture only
// (Helper/Test/test-data/eml/13-order-4-bob-outlook-nl.eml: the last email of a
// thread, whose quote holds 3 earlier emails).
import { beforeAll, describe, expect, it } from 'vitest';
import { parseAllFixtures } from '../../Helper/Test/test-data/parse-all';
import { type PdfValue, readDests, readOutline, readPageRuns, readPdf, textLines } from '../../Helper/Test/test-support/pdf-reader';
import { analyzeThread } from '../thread-analysis/analyze-thread';
import { DEFAULT_OUTPUT_POLICY, planOutput } from '../thread-analysis/output-plan';
import { translator } from '../web-page/translations';
import { rebuiltEntries } from '../web-page-logic/rebuilt-email-display';
import { generatePdf, type PdfFonts } from './generate';
import { DEFAULT_LAYOUT_CONFIG as CONFIG } from './page-layout';
import { loadPdfFonts } from './load-bundled-fonts';
import { createPdfStrings } from './strings';
import type { NormalizedMessage } from '../../Header/parsed-email';
import type { EngineResult } from '../../Header/thread-analysis-result';

let fonts: PdfFonts;
let last: NormalizedMessage;
beforeAll(async () =>
{
    fonts = await loadPdfFonts();
    const found = (await parseAllFixtures()).find((m) => m.source.fileName === 'eml/13-order-4-bob-outlook-nl.eml');
    if (found === undefined)
    {
        throw new Error('no fixture');
    }
    last = found;
});

/** The PDF of the last email alone, with the given rebuilt ids (default: every entry), read back as text. */
async function pdfText(options: { rebuilt?: readonly number[]; positions?: readonly number[]; locale?: 'en' | 'fr' | 'nl' } = {})
{
    const result: EngineResult = analyzeThread([{ ok: true, message: last }]);
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
function between(all: string, start: string, ...ends: string[]): string
{
    const from = all.indexOf(start);
    if (from < 0)
    {
        throw new Error(`not found: ${start}`);
    }
    const stops = ends.map((e) => all.indexOf(e, from + start.length)).filter((k) => k >= 0);
    return all.slice(from, stops.length === 0 ? undefined : Math.min(...stops));
}

/** What the PDF used to write for a rebuilt email (before task 8.3), in `locale` (see Source/pdf-export/model.rebuilt.test.ts). */
function removedTexts(locale: 'en' | 'fr' | 'nl'): { fragments: string[]; word: RegExp }
{
    const { t } = translator(locale);
    const before = (s: string): string => s.split('\u0000')[0]!.trim();
    const own: Record<typeof locale, string[]> = {
        en: ['Earlier email (rebuilt', '[Rebuilt]', 'Rebuilt emails', 'Earlier emails rebuilt from quoted text', 'They are not original files.'],
        fr: ['E-mail antérieur (reconstitué', '[Reconstitué]', 'E-mails reconstitués', 'Ce ne sont pas des fichiers d’origine.'],
        nl: ['Eerdere e-mail (gereconstrueerd', '[Gereconstrueerd]', 'Gereconstrueerde e-mails', 'Het zijn geen originele bestanden.'],
    };
    return {
        fragments: [
            ...own[locale],
            before(t('rebuilt.noteMarks', { number: '\u0000' })),
            before(t('rebuilt.noteNoMarks', { number: '\u0000' })),
            before(t('rebuilt.alsoOne', { list: '\u0000' })),
            t('rebuilt.takenFrom'),
            t('rebuilt.listIncomplete'),
            t('rebuilt.noSubject'),
            before(t('rebuilt.dateAsWritten', { text: '\u0000' })),
            t('rebuilt.dateAbout', { date: '2025' }),
        ],
        word: { en: /rebuilt/i, fr: /reconstitu/i, nl: /gereconstrueerd/i }[locale],
    };
}

describe('the PDF with rebuilt emails, read back (task 8.3: shown like real emails)', () =>
{
    it('cover: "Emails" counts all four, no rebuilt row or section; no source file list and no hash (task 8.12)', async () =>
    {
        const { pages, result, pdf } = await pdfText();
        const dests = readDests(pdf);
        const cover = pages[0]!.join(' ');
        expect(cover).toContain('Emails 4 emails');
        expect(cover).not.toMatch(/rebuilt/i);
        // The real file is named only in its own email's File row, never before the first email.
        const front = pages.slice(0, dests.get('email-1')!.page).flat().join('\n');
        expect(front).not.toContain(last.source.fileName);
        expect(front).not.toContain('Source files');
        expect(pages.flat().join('\n')).not.toMatch(/\b[0-9a-f]{64}\b/);
        // The index starts on the cover page.
        expect(dests.get('index')!.page).toBe(0);
        expect(result.messages).toHaveLength(1);
    });

    it('index: four numbered rows, no marker; one "email-N" destination each', async () =>
    {
        const { pdf, pages } = await pdfText();
        const dests = readDests(pdf);
        const indexPage = pages[dests.get('index')!.page]!;
        for (const n of [1, 2, 3, 4])
        {
            expect(indexPage.some((l) => l.startsWith(`${String(n)} `)), `row ${String(n)}`).toBe(true);
        }
        expect(indexPage.join('\n')).toContain('3 2025-03-03');
        expect(indexPage.join('\n')).not.toContain('[Rebuilt]');
        expect(indexPage.join('\n')).toContain('Re: Office desks and chairs');
        expect([...dests.keys()].filter((k) => k.startsWith('email-')).sort()).toEqual(['email-1', 'email-2', 'email-3', 'email-4']);
        expect([...dests.keys()].some((k) => k.startsWith('rebuilt'))).toBe(false);
    });

    it('bookmarks: one per email, numbered 1..4 in PDF order, no marker', async () =>
    {
        const { pdf } = await pdfText();
        const titles = readOutline(pdf)!.items.map((i) => i.title);
        expect(titles.slice(0, 2)).toEqual(['Cover', 'Index']);
        expect(titles).toHaveLength(6);
        for (const [k, title] of titles.slice(2).entries())
        {
            expect(title.startsWith(`${String(k + 1)}. `)).toBe(true);
        }
        expect(titles[4]).toBe('3. 2025-03-03, Alice Example: Re: Office desks and chairs');
        expect(titles.some((t) => t.includes('[Rebuilt]'))).toBe(false);
    });

    it('a rebuilt email: the heading and rows of a real email, no "Taken from", no note; its text', async () =>
    {
        const { all } = await pdfText();
        for (const n of [1, 2, 3, 4])
        {
            expect(all).toContain(`Email ${String(n)} From`);
        }
        // The newest rebuilt one (an Outlook block in Dutch, no quote marks), up to the real email.
        const newest = between(all, 'Email 3 From', 'Email 4 From');
        expect(newest).toContain('From Alice Example <alice@example.test>');
        expect(newest).toMatch(/Date 2025-03-03 \d\d:40:00 UTC\+01:00/);
        // No "time zone not given" line (task 8.8: the app says it).
        expect(newest).not.toContain("The sender's time zone is not given");
        expect(newest).toContain('Subject Re: Office desks and chairs');
        expect(newest).not.toContain('Taken from');
        expect(newest).not.toContain('As written in the quote');
        expect(newest).not.toContain('incomplete or inexact');
        expect(newest).not.toMatch(/\bFile\b/);
        // The Gmail quote: its ">" marks removed, no note; "(no subject)" as for a real email.
        const gmail = between(all, 'Email 2 From', 'Email 3 From');
        expect(gmail).toContain('Subject (no subject)');
        expect(gmail).toContain('Thank you for your message.');
        expect(gmail).not.toMatch(/(^| )> /);
        expect(gmail).not.toContain('Quote marks removed');
    });

    for (const locale of ['en', 'fr', 'nl'] as const)
    {
        it(`${locale}: none of the removed texts anywhere in the PDF`, async () =>
        {
            const { all, pdf } = await pdfText({ locale });
            const { fragments, word } = removedTexts(locale);
            expect(all).not.toMatch(word);
            for (const f of fragments)
            {
                expect(all, `"${f}"`).not.toContain(f);
            }
            for (const t of readOutline(pdf)!.items.map((i) => i.title))
            {
                expect(t).not.toMatch(word);
            }
            // Four emails, with the real emails' heading.
            const heading = createPdfStrings(locale).emailHeading(4);
            expect(all).toContain(heading);
        });
    }

    it('the switch off: only the real email, as email 1', async () =>
    {
        const { all, pdf } = await pdfText({ rebuilt: [] });
        expect(all).not.toMatch(/rebuilt|\[Rebuilt\]/i);
        expect(all).toContain('Email 1 From');
        expect(all).not.toContain('Email 2');
        expect(readOutline(pdf)!.items).toHaveLength(3);
    });

    it('each email, rebuilt or real, starts at the top of a new page; no empty page; index numbers and bookmarks point there', async () =>
    {
        const { pdf, pages } = await pdfText();
        const dests = readDests(pdf);
        const runs = await readPageRuns(pdf);
        // PDF order, as the bookmarks give it: the three rebuilt emails (oldest first), then the real one.
        const anchors = readOutline(pdf)!.items.slice(2).map((i) => i.dest);
        expect(anchors).toEqual(['email-1', 'email-2', 'email-3', 'email-4']);
        const starts = anchors.map((a) => dests.get(a)!.page);
        // The first right after the index, then one page each (the rebuilt emails are short), in PDF order.
        expect(starts[0]).toBe(dests.get('index')!.page + 1);
        for (let k = 1; k < starts.length; k++)
        {
            expect(starts[k]).toBe(starts[k - 1]! + 1);
        }
        // Each destination at the same height (the top of the text area), its heading the first line of its page.
        const top = CONFIG.page.height - CONFIG.margin.top + CONFIG.spacing.destinationAbove;
        for (const [k, anchor] of anchors.entries())
        {
            expect(dests.get(anchor)!.top).toBeCloseTo(top, 3);
            expect(pages[starts[k]!]![0]!).toBe(`Email ${String(k + 1)}`);
        }
        // No empty page: each has text above its footer.
        const footerY = CONFIG.footer.baselineFromBottom + 1;
        for (const page of runs)
        {
            expect(page.some((r) => r.y > footerY)).toBe(true);
        }
        // Index: each row's link goes to its email, the number drawn in the row's page column is that page + 1.
        const pageColumn = CONFIG.page.width - CONFIG.margin.right - CONFIG.index.pageWidth;
        const shown = new Map<string, string[]>();
        for (const [i, pageDict] of pdf.pages().entries())
        {
            for (const a of (pageDict.get('Annots') as PdfValue[] | undefined) ?? [])
            {
                const link = pdf.dict(a);
                const dest = pdf.name(link.get('Dest'));
                const [, y1, , y2] = link.get('Rect') as number[];
                shown.set(dest, runs[i]!.filter((r) => r.x >= pageColumn - 0.01 && r.y > y1! && r.y < y2!).map((r) => r.shown));
            }
        }
        expect([...shown.keys()].sort()).toEqual([...anchors].sort());
        for (const [k, anchor] of anchors.entries())
        {
            expect(shown.get(anchor)).toEqual([String(starts[k]! + 1)]);
        }
    });
});
