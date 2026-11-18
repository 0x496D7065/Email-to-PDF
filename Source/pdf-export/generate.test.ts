// The whole PDF path (generatePdf): cover, index with real page numbers,
// links, bookmarks, emails. Synthetic emails only (made-up names, reserved
// *.test addresses). Every index page number is checked
// twice: in the laid-out document (anchorPages, destinations, the drawn
// number in each row's link area) and in the written file, read back with
// the test reader (link annotations, named destinations, drawn text).
// Special characters are written as braced escapes (ASCII file).
import { beforeAll, describe, expect, it } from 'vitest';
import { parseToUnicode, type ParsedPdf, type PdfDict, PdfString, type PdfValue, readContent, readDests, readOutline, readPageRuns, readPdf, textLines } from '../../Helper/Test/test-support/pdf-reader';
import { runEngine } from '../thread-analysis/analyze-thread';
import { DEFAULT_OUTPUT_POLICY, planOutput } from '../thread-analysis/output-plan';
import { type GeneratePdfInput, generatePdf, type PdfFonts } from './generate';
import { COVER_DESTINATION, DEFAULT_LAYOUT_CONFIG as CONFIG, INDEX_DESTINATION, layoutPdf, MAX_FRONT_PASSES, type PdfLayout, settlePageCount } from './page-layout';
import { loadPdfFonts } from './load-fonts';
import { buildPdfDocument, MAX_BOOKMARK_LENGTH } from './model';
import { createPdfStrings } from './strings';
import { lineText } from './text';
import { OwnPdfWriter } from './pdf-writer';
import type { EmailAddress, NormalizedMessage, ParseResult } from '../../Header/parsed-email';
import type { PdfDocument } from '../../Header/pdf-document-model';

let fonts: PdfFonts;
beforeAll(async () =>
{
    fonts = await loadPdfFonts();
});

const strings = createPdfStrings('en');
const ALICE: EmailAddress = { name: 'Alice Example', address: 'alice@example.test' };
const BOB: EmailAddress = { name: 'Bob Sample', address: 'bob@sample.test' };
const CAROL: EmailAddress = { name: 'Carol Test', address: 'carol@other.test' };
const PEOPLE = [ALICE, BOB, CAROL];
const BASE_MS = Date.UTC(2025, 2, 4, 8, 0, 0);
const GENERATED_AT = Date.UTC(2025, 5, 1, 12, 0, 0);

/** Email k (0-based): one hour after email k - 1, from Alice, Bob, Carol in turn. */
function make(k: number, fields: Partial<NormalizedMessage> = {}): NormalizedMessage
{
    const n = String(k + 1);
    return {
        messageId: `generate-${n}@example.test`,
        inReplyTo: null,
        references: [],
        date: { utcMs: BASE_MS + k * 3_600_000, original: 'Tue, 4 Mar 2025 08:00:00 +0000', offsetMinutes: 0, zoneKnown: true },
        from: [PEOPLE[k % 3]!],
        to: [PEOPLE[(k + 1) % 3]!],
        cc: [],
        bcc: [],
        subject: `Office desks, part ${n}`,
        bodyText: `Hello,\n\nThe desks arrive on Monday, note ${n}.\n\nRegards\n`,
        attachments: [],
        source: { fileName: `email-${n}.eml`, sha256: (k + 1).toString(16).padStart(64, '0'), kind: 'eml' },
        warnings: [],
        ...fields,
    };
}

const many = (count: number, fields: (k: number) => Partial<NormalizedMessage> = () => ({})): NormalizedMessage[] =>
    Array.from({ length: count }, (_, k) => make(k, fields(k)));

/** The generatePdf input for these emails, all included, default policy. */
function inputFor(messages: readonly NormalizedMessage[], extra: Partial<GeneratePdfInput> = {}): GeneratePdfInput
{
    const results: ParseResult[] = messages.map((message) => ({ ok: true, message }));
    const result = runEngine(results);
    const positions = result.messages.map((_, k) => k);
    const plans = planOutput(
        positions.map((p) => result.messages[p]!),
        DEFAULT_OUTPUT_POLICY,
    );
    return { result, positions, plans, policy: DEFAULT_OUTPUT_POLICY, timeZone: 'UTC', generatedAt: GENERATED_AT, fonts, locale: 'en', strings, ...extra };
}

/** The same steps as generatePdf, keeping the document and the layout to check them. */
function docAndLayout(input: GeneratePdfInput): { doc: PdfDocument; layout: PdfLayout }
{
    const doc = buildPdfDocument({ ...input, strings });
    return { doc, layout: layoutPdf(doc, fonts, { strings }) };
}

const BOTTOM = CONFIG.page.height - CONFIG.margin.bottom;
const RIGHT = CONFIG.page.width - CONFIG.margin.right;
/** Left edge of the index's page column. */
const PAGE_COLUMN = RIGHT - CONFIG.index.pageWidth;
/** Left edge of the index's date column. */
const DATE_COLUMN = CONFIG.margin.left + CONFIG.index.numberWidth + CONFIG.index.gap;

/** Pages (0-based) of the index: from its heading to the last page before the emails. */
function indexPages(layout: PdfLayout): number[]
{
    const first = layout.document.destinations.find((d) => d.name === INDEX_DESTINATION)!.page;
    return Array.from({ length: layout.frontPages - first }, (_, k) => first + k);
}

/**
 * Checks in the laid-out document: each email's heading is on its anchor
 * page, its destination there; its index row (first link area) shows that
 * page + 1 in the page column; links only on index pages; footers right.
 */
function checkLayout(doc: PdfDocument, layout: PdfLayout): void
{
    const { document, anchorPages, frontPages } = layout;
    const total = document.pages.length;
    const index = indexPages(layout);
    expect(anchorPages.get(doc.emails[0]!.anchor)).toBe(frontPages);
    // The default (task 8.4): each email from the top of a new page, in order, never an empty page between two.
    for (const [k, email] of doc.emails.entries())
    {
        const destination = document.destinations.find((d) => d.name === email.anchor)!;
        expect(destination.y).toBeCloseTo(CONFIG.margin.top - CONFIG.spacing.destinationAbove, 6);
        if (k > 0)
        {
            expect(anchorPages.get(email.anchor)).toBeGreaterThan(anchorPages.get(doc.emails[k - 1]!.anchor)!);
        }
    }
    for (const page of document.pages)
    {
        expect(page.text.some((r) => r.y <= BOTTOM)).toBe(true);
    }
    for (const entry of doc.index.entries)
    {
        const page = anchorPages.get(entry.anchor)!;
        expect(document.pages[page]!.text.some((r) => r.copyText === `Email ${String(entry.number)}`)).toBe(true);
        expect(document.destinations.find((d) => d.name === entry.anchor)!.page).toBe(page);
        const p = index.find((i) => document.pages[i]!.links.some((l) => l.destination === entry.anchor));
        expect(p).toBeDefined();
        const rect = document.pages[p!]!.links.find((l) => l.destination === entry.anchor)!.rect;
        const shown = document.pages[p!]!.text.filter((r) => r.x >= PAGE_COLUMN - 1e-6 && r.y > rect.y && r.y < rect.y + rect.height);
        expect(shown.map((r) => r.copyText)).toEqual([String(page + 1)]);
    }
    for (const [i, page] of document.pages.entries())
    {
        if (!index.includes(i))
        {
            expect(page.links).toEqual([]);
        }
        expect(page.text.filter((r) => r.y > BOTTOM).map((r) => r.copyText)).toEqual([`Page ${String(i + 1)} of ${String(total)}`]);
    }
}

/** Each page's drawn runs as read back from the file: position (PDF coordinates, y up) and text. */
async function pageRuns(pdf: ParsedPdf): Promise<{ x: number; y: number; text: string }[][]>
{
    const out: { x: number; y: number; text: string }[][] = [];
    for (const pageDict of pdf.pages())
    {
        const fontDict = pdf.dict(pdf.dict(pageDict.get('Resources')).get('Font'));
        const maps = new Map<string, Map<number, string>>();
        for (const key of fontDict.keys())
        {
            maps.set(key, parseToUnicode(await pdf.dataText(pdf.dict(fontDict.get(key)).get('ToUnicode'))));
        }
        const { runs } = readContent(await pdf.dataText(pageDict.get('Contents')));
        out.push(runs.map((r) => ({ x: r.x, y: r.y, text: r.actualText ?? r.glyphs.map((g) => maps.get(r.font)!.get(g) ?? '').join('') })));
    }
    return out;
}

/**
 * Checks in the written file: every index row's link annotation points to
 * its email's named destination; that destination is on the page of the
 * email's heading, just above it; the number drawn in the row is that page + 1.
 */
async function checkPdf(bytes: Uint8Array, doc: PdfDocument): Promise<ParsedPdf>
{
    const pdf = readPdf(bytes);
    const dests = readDests(pdf);
    const runs = await pageRuns(pdf);
    const shownFor = new Map<string, string[]>();
    for (const [i, page] of pdf.pages().entries())
    {
        const annots = page.get('Annots') as PdfValue[] | undefined;
        for (const a of annots ?? [])
        {
            const link: PdfDict = pdf.dict(a);
            expect(pdf.name(link.get('Subtype'))).toBe('Link');
            const dest = pdf.name(link.get('Dest'));
            if (shownFor.has(dest))
            {
                continue; // a later piece of the same row
            }
            const [, y1, , y2] = link.get('Rect') as number[];
            shownFor.set(
                dest,
                runs[i]!.filter((r) => r.x >= PAGE_COLUMN - 0.01 && r.y > y1! && r.y < y2!).map((r) => r.text),
            );
        }
    }
    expect([...shownFor.keys()].sort()).toEqual(doc.index.entries.map((e) => e.anchor).sort());
    for (const entry of doc.index.entries)
    {
        const dest = dests.get(entry.anchor)!;
        expect(shownFor.get(entry.anchor)).toEqual([String(dest.page + 1)]);
        const heading = runs[dest.page]!.find((r) => r.text === `Email ${String(entry.number)}`);
        expect(heading).toBeDefined();
        expect(dest.top).toBeGreaterThan(heading!.y);
        expect(dest.top - heading!.y).toBeLessThan(30);
    }
    return pdf;
}

describe('loadPdfFonts', () =>
{
    it('parses the four bundled fonts, and given bytes the same way', async () =>
    {
        expect(Object.keys(fonts)).toEqual(['sans-regular', 'sans-bold', 'sans-italic', 'mono-regular']);
        expect(fonts['sans-bold'].weightClass).toBe(700);
        expect(fonts['mono-regular'].isFixedPitch).toBe(true);
        const { PDF_FONTS } = await import('./fonts');
        const again = await loadPdfFonts(PDF_FONTS);
        expect(again['sans-italic'].postScriptName).toBe(fonts['sans-italic'].postScriptName);
    });
});

describe('generatePdf: index page numbers', () =>
{
    it.each([1, 2, 3])('small batch of %i: cover and index on page 1, then the emails; numbers, links and destinations agree', async (count) =>
    {
        const input = inputFor(many(count));
        const { doc, layout } = docAndLayout(input);
        // Task 8.12: no source files on the cover, the index right below the cover information, on the same page.
        expect(layout.frontPages).toBe(1);
        expect(indexPages(layout)).toEqual([0]);
        expect(layout.passes).toBe(1);
        checkLayout(doc, layout);
        // The index heading below the last cover line (the last person), one section gap below it.
        const page0 = layout.document.pages[0]!.text;
        const indexTop = layout.document.destinations.find((d) => d.name === INDEX_DESTINATION)!.y + CONFIG.spacing.destinationAbove;
        const lastPerson = Math.max(...page0.filter((r) => PEOPLE.some((p) => r.copyText.includes(p.address))).map((r) => r.y));
        expect(lastPerson).toBeLessThan(indexTop);
        expect(page0.filter((r) => r.y > lastPerson && r.y < indexTop && r.y <= BOTTOM)).toEqual([]);
        expect(page0.find((r) => r.copyText === 'Index')!.y).toBeGreaterThanOrEqual(indexTop - 1e-6);
        const { bytes, fileName } = await generatePdf(input);
        expect(fileName).toBe('correspondence-2025-06-01.pdf');
        const pdf = await checkPdf(bytes, doc);
        expect(pdf.pages()).toHaveLength(layout.document.pages.length);
        expect(readDests(pdf).get(COVER_DESTINATION)!.page).toBe(0);
        expect(readDests(pdf).get(INDEX_DESTINATION)!.page).toBe(0);
    });

    it('starts the index on a new page only when its heading, column titles and first row do not fit below the cover', () =>
    {
        // Many people make a long cover (one line each); find the first count whose cover pushes the index to page 2.
        const crowd = (people: number, first: Partial<NormalizedMessage> = {}): NormalizedMessage[] => [
            make(0, { to: Array.from({ length: people }, (_, i) => ({ name: `Person ${String(i + 1)}`, address: `person-${String(i + 1)}@example.test` })), ...first }),
            make(1),
        ];
        const indexDestination = (layout: PdfLayout) => layout.document.destinations.find((d) => d.name === INDEX_DESTINATION)!;
        /** Page (0-based) of the first index row: the page holding email 1's first link area. */
        const firstRowPage = (doc: PdfDocument, layout: PdfLayout): number =>
            layout.document.pages.findIndex((p) => p.links.some((l) => l.destination === doc.index.entries[0]!.anchor));
        let people = 1;
        let indexPage = 0;
        while (indexPage === 0)
        {
            people++;
            expect(people).toBeLessThan(200);
            const { layout } = docAndLayout(inputFor(crowd(people)));
            indexPage = indexDestination(layout).page;
        }
        const checkNewPage = (doc: PdfDocument, layout: PdfLayout): void =>
        {
            // On a new page, the index (heading and first row) is at its top; the cover's page holds no part of it.
            const dest = indexDestination(layout);
            expect(dest.page).toBe(1);
            expect(firstRowPage(doc, layout)).toBe(1);
            expect(dest.y).toBeCloseTo(CONFIG.margin.top - CONFIG.spacing.destinationAbove, 6);
            expect(layout.document.pages[0]!.text.some((r) => r.copyText === 'No.' || r.copyText === 'Index')).toBe(false);
            expect(layout.document.pages[0]!.links).toEqual([]);
        };
        for (const [count, page] of [
            [people - 1, 0],
            [people, 1],
        ] as const)
        {
            const { doc, layout } = docAndLayout(inputFor(crowd(count)));
            expect(indexDestination(layout).page, `${String(count)} people`).toBe(page);
            if (page === 0)
            {
                expect(firstRowPage(doc, layout), 'first index row with the heading').toBe(0);
            }
            else
            {
                checkNewPage(doc, layout);
            }
            checkLayout(doc, layout);
        }
        // With people - 1, the heading, column titles and a one-line first row fit below the cover; so
        // do the heading and the column titles alone. A first row made taller (several attachments, one
        // line each) no longer fits there: the whole index moves to page 2, though the cover is the same.
        const short = docAndLayout(inputFor(crowd(people - 1)));
        const attachments = Array.from({ length: 6 }, (_, i) => ({ fileName: `plan-${String(i + 1)}.pdf`, size: 2048, mimeType: 'application/pdf' }));
        const tall = docAndLayout(inputFor(crowd(people - 1, { attachments })));
        const coverText = (layout: PdfLayout): string[] => layout.document.pages[0]!.text.filter((r) => r.y <= BOTTOM).map((r) => r.copyText);
        expect(coverText(tall.layout)).toEqual(coverText(short.layout).slice(0, coverText(tall.layout).length));
        expect(coverText(short.layout)).toEqual(expect.arrayContaining(['Index', 'No.']));
        checkNewPage(tall.doc, tall.layout);
        checkLayout(tall.doc, tall.layout);
    });

    it('is right on both sides of the index growing from one page to two', async () =>
    {
        // The smallest batch whose index needs two pages.
        let n = 1;
        while (indexPages(docAndLayout(inputFor(many(n))).layout).length < 2)
        {
            n++;
            expect(n).toBeLessThan(200);
        }
        expect(n).toBeGreaterThan(10);
        for (const [count, pages] of [
            [n - 1, 1],
            [n, 2],
        ] as const)
        {
            const input = inputFor(many(count));
            const { doc, layout } = docAndLayout(input);
            expect(indexPages(layout)).toHaveLength(pages);
            checkLayout(doc, layout);
            await checkPdf((await generatePdf(input)).bytes, doc);
        }
    });

    it('is right for a big batch whose index spans several pages, the column titles on each', async () =>
    {
        // Emails of varied length, every fifth with attachments (taller index rows).
        const body = (k: number): string => Array.from({ length: 1 + ((k * 13) % 70) }, (_, i) => `Line ${String(i + 1)} of email ${String(k + 1)}.`).join('\n');
        const input = inputFor(
            many(240, (k) => ({
                bodyText: body(k),
                attachments: k % 5 === 0 ? [{ fileName: `plan-${String(k + 1)}.pdf`, size: 12_345, mimeType: 'application/pdf' }] : [],
            })),
            { timeZone: 'America/New_York' },
        );
        const { doc, layout } = docAndLayout(input);
        const index = indexPages(layout);
        expect(index.length).toBeGreaterThanOrEqual(3);
        checkLayout(doc, layout);
        for (const p of index)
        {
            expect(layout.document.pages[p]!.text.filter((r) => r.copyText === 'No.')).toHaveLength(1);
        }
        // The date column: its title (bold, here wrapped) the same on every index page; below it, each
        // row's short date in one piece (one line), then only attachment labels and bullets.
        const titleFont = CONFIG.roles['field-label'].font;
        const inDateColumn = index.map((p) => layout.document.pages[p]!.text.filter((r) => Math.abs(r.x - DATE_COLUMN) < 1e-6 && r.y <= BOTTOM));
        const titles = inDateColumn.map((runs) => runs.filter((r) => r.font === titleFont && r.copyText !== 'Attachments').map((r) => r.copyText));
        expect(titles[0]!.length).toBeGreaterThan(1);
        expect(titles[0]!.join('').replace(/\s+/g, ' ')).toBe('Date (America/New York)');
        for (const t of titles)
        {
            expect(t).toEqual(titles[0]);
        }
        const dates = inDateColumn.flat().filter((r) => r.font !== titleFont && r.copyText !== '\u{2022}').map((r) => r.copyText);
        expect(dates).toEqual(doc.index.entries.map((e) => lineText(e.date)));
        for (const d of dates)
        {
            expect(d).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
        }
        expect(dates[0]).toBe('2025-03-04 03:00'); // 08:00 UTC in New York (UTC-05:00)
        // Index rows inside the text area, the page numbers right-aligned on the right margin.
        for (const p of index)
        {
            for (const run of layout.document.pages[p]!.text)
            {
                if (run.y > BOTTOM)
                {
                    continue;
                }
                expect(run.x).toBeGreaterThanOrEqual(CONFIG.margin.left - 1e-6);
                expect(run.x).toBeLessThan(RIGHT);
            }
        }
        const pdf = await checkPdf((await generatePdf(input)).bytes, doc);
        expect(pdf.pages()).toHaveLength(layout.document.pages.length);
    }, 30_000);

    it('splits the link of a row taller than a page over each of its pages, numbered once', async () =>
    {
        const long = Array.from({ length: 1500 }, (_, i) => `word${String(i)}`).join(' ');
        const input = inputFor([make(0), make(1, { subject: long }), make(2)]);
        const { doc, layout } = docAndLayout(input);
        const index = indexPages(layout);
        expect(index.length).toBeGreaterThan(2);
        const withLink = index.filter((p) => layout.document.pages[p]!.links.some((l) => l.destination === 'email-2'));
        expect(withLink.length).toBeGreaterThan(1);
        // The column titles again at the top of each index page.
        for (const p of index)
        {
            expect(layout.document.pages[p]!.text.some((r) => r.copyText === 'No.')).toBe(true);
        }
        checkLayout(doc, layout);
        await checkPdf((await generatePdf(input)).bytes, doc);
    });
});

describe('generatePdf: index rows', () =>
{
    it('lists each email\u{2019}s attachments in its row, as in the email', async () =>
    {
        const input = inputFor([
            make(0, {
                attachments: [
                    { fileName: 'plan.pdf', size: 12_345, mimeType: 'application/pdf' },
                    { fileName: '', size: null, mimeType: '' },
                ],
            }),
            make(1),
        ]);
        const { doc, layout } = docAndLayout(input);
        // The index is on the cover page (task 8.12).
        const page = layout.document.pages[0]!;
        const rect = page.links.find((l) => l.destination === 'email-1')!.rect;
        const inRow = page.text.filter((r) => r.y > rect.y && r.y < rect.y + rect.height).map((r) => r.copyText);
        // Number, short date (one line), sender, subject, page; then the attachments, one per line.
        expect(inRow).toEqual([
            '1',
            '2025-03-04 08:00',
            'Alice Example',
            'Office desks, part 1',
            '2',
            'Attachments',
            '\u{2022}',
            'plan.pdf',
            ' (12 KB, application/pdf)',
            '\u{2022}',
            '(attachment without a name) (size unknown)',
        ]);
        expect(doc.index.entries[0]!.attachmentLines).toBe(doc.emails[0]!.attachments!.items);
        // The row without attachments has no attachment lines.
        const rect2 = page.links.find((l) => l.destination === 'email-2')!.rect;
        expect(page.text.filter((r) => r.y > rect2.y && r.y < rect2.y + rect2.height && r.copyText === 'Attachments')).toEqual([]);
        // The same in the written file.
        const runs = await pageRuns(readPdf((await generatePdf(input)).bytes));
        const texts = runs[0]!.map((r) => r.text);
        expect(texts).toEqual(expect.arrayContaining(['Attachments', 'plan.pdf', ' (12 KB, application/pdf)', '(attachment without a name) (size unknown)']));
    });
});

describe('generatePdf: bookmarks', () =>
{
    it('has Cover, Index, then one bookmark per email, in order, one line, cut to length', async () =>
    {
        const input = inputFor([
            make(0),
            make(1, { subject: 'Line one\r\nline\ttwo \u{7}bell' }),
            make(2, { subject: 'x'.repeat(300) }),
            make(3, { subject: '', from: [] }),
            make(4, { date: { utcMs: null, original: '', offsetMinutes: null, zoneKnown: false } }),
        ]);
        const { bytes } = await generatePdf(input);
        const outline = readOutline(readPdf(bytes))!;
        expect(outline.items.map((o) => o.dest)).toEqual(['cover', 'index', 'email-1', 'email-2', 'email-3', 'email-4', 'email-5']);
        expect(outline.count).toBe(7);
        const titles = outline.items.map((o) => o.title);
        expect(titles.slice(0, 2)).toEqual(['Cover', 'Index']);
        expect(titles[2]).toBe('1. 2025-03-04, Alice Example: Office desks, part 1');
        expect(titles[3]).toBe('2. 2025-03-04, Bob Sample: Line one line    two [U+0007]bell');
        expect(Array.from(titles[4]!)).toHaveLength(MAX_BOOKMARK_LENGTH);
        expect(titles[4]!.startsWith('3. 2025-03-04, Carol Test: xxx')).toBe(true);
        expect(titles[4]!.endsWith('x\u{2026}')).toBe(true);
        expect(titles[5]).toBe('4. 2025-03-04, Unknown sender: (no subject)');
        expect(titles[6]).toBe('5. (no date), Bob Sample: Office desks, part 5');
        for (const title of titles)
        {
            expect(title).not.toMatch(/[\r\n\t]/);
        }
    });
});

describe('generatePdf: file name and output', () =>
{
    // 23:30 UTC on 1 June 2025: already 2 June east of UTC, still 1 June west of it.
    const lateUtc = Date.UTC(2025, 5, 1, 23, 30, 0);
    // 02:00 UTC on 2 June 2025: still 1 June in New York.
    const earlyUtc = Date.UTC(2025, 5, 2, 2, 0, 0);
    it.each<[string, number, string]>([
        ['UTC', lateUtc, 'correspondence-2025-06-01.pdf'],
        ['America/New_York', lateUtc, 'correspondence-2025-06-01.pdf'],
        ['America/New_York', earlyUtc, 'correspondence-2025-06-01.pdf'],
        ['Africa/Lagos', lateUtc, 'correspondence-2025-06-02.pdf'],
        ['Asia/Tokyo', lateUtc, 'correspondence-2025-06-02.pdf'],
        ['Australia/Sydney', lateUtc, 'correspondence-2025-06-02.pdf'],
        ['UTC', earlyUtc, 'correspondence-2025-06-02.pdf'],
    ])('names the file with the generation date in the chosen zone (%s)', async (timeZone, generatedAt, fileName) =>
    {
        const result = await generatePdf(inputFor([make(0)], { timeZone, generatedAt }));
        expect(result.fileName).toBe(fileName);
    });

    it('gives the same bytes for the same input', async () =>
    {
        const input = inputFor(many(12, (k) => ({ attachments: k % 3 === 0 ? [{ fileName: 'a.txt', size: 3, mimeType: 'text/plain' }] : [] })));
        const a = await generatePdf(input);
        const b = await generatePdf({ ...input });
        expect(a.bytes.length).toBeGreaterThan(1000);
        expect(b.bytes).toEqual(a.bytes);
        expect(b.fileName).toBe(a.fileName);
        // Info: title and producer only (no date, no author).
        const pdf = readPdf(a.bytes);
        expect(pdf.info.keys().sort()).toEqual(['Producer', 'Title']);
        expect((pdf.info.get('Title') as PdfString).text).toBe('Email correspondence');
    });

    it('uses the backend it is given', async () =>
    {
        const seen: number[] = [];
        const backend = {
            render: async (doc: Parameters<OwnPdfWriter['render']>[0], set: Parameters<OwnPdfWriter['render']>[1]) =>
            {
                seen.push(doc.pages.length);
                return new OwnPdfWriter().render(doc, set);
            },
        };
        await generatePdf(inputFor([make(0)], { backend }));
        // The cover with the index, then the email (task 8.12).
        expect(seen).toEqual([2]);
    });
});

describe('index page numbers: the pass bound', () =>
{
    it('settles on the first right guess, and stops a run that does not settle with a clear Error', () =>
    {
        expect(settlePageCount((guess) => ({ pages: 3, guess }), 4)).toEqual({ front: { pages: 3, guess: 3 }, passes: 2 });
        expect(settlePageCount(() => ({ pages: 1 }), 4)).toEqual({ front: { pages: 1 }, passes: 1 });
        // Never agrees with its guess: one more page each time.
        const growing = (guess: number) => ({ pages: guess + 1 });
        expect(() => settlePageCount(growing, MAX_FRONT_PASSES)).toThrow(/^layout: the index page numbers did not settle after 4 passes$/);
        // Flips between two counts.
        let calls = 0;
        const flipping = (guess: number) =>
        {
            calls++;
            return { pages: guess === 2 ? 3 : 2 };
        };
        expect(() => settlePageCount(flipping, 6)).toThrow(/did not settle after 6 passes/);
        expect(calls).toBe(6);
        expect(() => settlePageCount(growing, 0)).toThrow(/maxPasses must be a whole number >= 1/);
    });

    it('applies the bound to a real layout: one pass when the front is one page, two when it is longer', () =>
    {
        // The cover and the index on one page (task 8.12): the first guess (1 page) is right.
        const small = buildPdfDocument({ ...inputFor(many(3)), strings });
        expect(layoutPdf(small, fonts, { strings, maxPasses: 1 }).passes).toBe(1);
        // An index that runs onto a second page: the first guess is wrong, the second is right.
        const big = buildPdfDocument({ ...inputFor(many(60)), strings });
        expect(() => layoutPdf(big, fonts, { strings, maxPasses: 1 })).toThrow(/^layout: the index page numbers did not settle after 1 passes$/);
        expect(layoutPdf(big, fonts, { strings, maxPasses: 2 }).passes).toBe(2);
    });
});

describe('generatePdf: time bound', () =>
{
    it('makes the PDF of 2000 emails (index of many pages) in bounded time', async () =>
    {
        const body = (k: number): string => Array.from({ length: 10 + (k % 40) }, (_, i) => `Line ${String(i + 1)}: the desks arrive on Monday, email ${String(k + 1)}.`).join('\n');
        const input = inputFor(
            many(2000, (k) => ({
                bodyText: body(k),
                attachments: k % 4 === 0 ? [{ fileName: `plan-${String(k + 1)}.pdf`, size: 2048 * (k + 1), mimeType: 'application/pdf' }] : [],
            })),
        );
        const start = performance.now();
        const doc = buildPdfDocument({ ...input, strings });
        const layout = layoutPdf(doc, fonts, { strings });
        const bytes = await new OwnPdfWriter().render(layout.document, fonts);
        const ms = performance.now() - start;
        expect(ms).toBeLessThan(60_000); // about 1.5 s on a developer machine
        expect(indexPages(layout).length).toBeGreaterThanOrEqual(3);
        expect(layout.passes).toBe(2);
        checkLayout(doc, layout);
        expect(readOutline(readPdf(bytes))!.items).toHaveLength(2002);
    }, 180_000);
});

describe('generatePdf in French (locale "fr", its own texts)', () =>
{
    it('writes the French texts with no code for a missing character, the French file name, and the same structure', async () =>
    {
        const messages = many(3, (k) => ({
            attachments: k === 0 ? [{ fileName: 'plan.pdf', size: 1.4 * 1024 * 1024, mimeType: 'application/pdf' }] : [],
        }));
        // No `strings`: generatePdf makes them from the locale, as the PDF worker does.
        const { strings: englishStrings, ...input } = inputFor(messages);
        const french = await generatePdf({ ...input, locale: 'fr' });
        const english = await generatePdf({ ...input, strings: englishStrings });
        expect(french.fileName).toBe('correspondance-2025-06-01.pdf');
        expect(french.pageCount).toBe(english.pageCount);

        const pdf = readPdf(french.bytes);
        const text = (await pageRuns(pdf)).flat().map((r) => r.text).join('\n');
        for (const part of ['Correspondance par e-mail', 'Sommaire', 'Pi\u00e8ces jointes', 'E-mail 1', `Page 1 sur ${String(french.pageCount)}`, '1,4 Mo'])
        {
            expect(text).toContain(part);
        }
        // Every French character is in the fonts: none was written as a code such as [U+00E9].
        expect(text).not.toMatch(/\[U\+[0-9A-F]{4,6}\]/);
        expect(text).not.toContain('Email correspondence');
        const outline = readOutline(pdf)!;
        expect(outline.items[0]?.title).toBe('Page de garde');
    });
});

describe('generatePdf in Dutch (locale "nl", its own texts)', () =>
{
    it('writes the Dutch texts with no code for a missing character, the Dutch file name, and the same structure', async () =>
    {
        const messages = many(3, (k) => ({
            attachments: k === 0 ? [{ fileName: 'plan.pdf', size: 1.4 * 1024 * 1024, mimeType: 'application/pdf' }] : [],
        }));
        // No `strings`: generatePdf makes them from the locale, as the PDF worker does.
        const { strings: englishStrings, ...input } = inputFor(messages);
        const dutch = await generatePdf({ ...input, locale: 'nl' });
        const english = await generatePdf({ ...input, strings: englishStrings });
        expect(dutch.fileName).toBe('correspondentie-2025-06-01.pdf');
        expect(dutch.pageCount).toBe(english.pageCount);

        const pdf = readPdf(dutch.bytes);
        const text = (await pageRuns(pdf)).flat().map((r) => r.text).join('\n');
        for (const part of ['E-mailcorrespondentie', 'Inhoudsopgave', 'Bijlagen', 'E-mail 1', `Pagina 1 van ${String(dutch.pageCount)}`, '1,4 MB'])
        {
            expect(text).toContain(part);
        }
        // Every Dutch character is in the fonts: none was written as a code such as [U+00EB].
        expect(text).not.toMatch(/\[U\+[0-9A-F]{4,6}\]/);
        expect(text).not.toContain('Email correspondence');
        const outline = readOutline(pdf)!;
        expect(outline.items[0]?.title).toBe('Voorblad');
    });
});

describe('generatePdf: quote marks removed, one body indent of one tab (tasks 8.1, 8.6 and 8.9), read back from the file', () =>
{
    const LEFT = CONFIG.margin.left;
    /** One tab: 4 normal spaces of the body font at the body size, straight from the font's tables. */
    let STEP = Number.NaN;
    beforeAll(() =>
    {
        const font = fonts[CONFIG.roles.body.font];
        STEP = (4 * font.advance(font.glyphFor(0x20)) * CONFIG.roles.body.size) / font.unitsPerEm;
    });
    const long = 'alpha beta gamma delta epsilon zeta eta theta '.repeat(8).trim();
    const quoted =
        '> Can the desks come on Monday?\nYes, Monday works.\n\n> > And the chairs, Alice?\n>> They come later.\n>> ' +
        long +
        '\n>\n> Bob\n> -> a mark inside: kept\n>>>>>>> Seven levels deep.\n';

    /** The body lines of the email pages as read back: copied text and x of the line's first run. */
    async function bodyLinesOf(input: GeneratePdfInput): Promise<{ text: string; x: number; inserted: number }[]>
    {
        const made = await generatePdf(input);
        const { layout } = docAndLayout(input);
        const pages = (await readPageRuns(readPdf(made.bytes))).slice(layout.frontPages);
        return pages.flatMap((runs) =>
            textLines(runs.filter((r) => r.y > CONFIG.margin.bottom && r.size === CONFIG.roles.body.size)).map((l) => ({ text: l.copied, x: l.runs[0]!.x, inserted: l.insertedSpaces })),
        );
    }

    function check(lines: readonly { text: string; x: number; inserted: number }[]): void
    {
        const xOf = (text: string): number =>
        {
            const found = lines.find((l) => l.text === text);
            if (found === undefined)
            {
                throw new Error(`not found: ${text}`);
            }
            return found.x;
        };
        // Own text and every quote level: the same single step in.
        for (const text of ['Hello Bob,', 'Yes, Monday works.', 'Alice', 'Can the desks come on Monday?', 'And the chairs, Alice?', 'They come later.', 'Bob', '-> a mark inside: kept', 'Seven levels deep.'])
        {
            expect(xOf(text), text).toBeCloseTo(LEFT + STEP, 3);
        }
        // The long quoted line wraps; every piece keeps the step, and together they are the text as written.
        const pieces = lines.filter((l) => l.text.includes('alpha') || l.text.includes('theta'));
        expect(pieces.length).toBeGreaterThan(1);
        for (const p of pieces)
        {
            expect(p.x).toBeCloseTo(LEFT + STEP, 3);
        }
        expect(pieces.map((p) => p.text.trim()).join(' ')).toBe(long);
        // No ">" at the start of any line (the text copied out follows the printed text), none added inside one.
        for (const l of lines)
        {
            expect(l.text).not.toMatch(/^\s*>/u);
            expect(l.inserted).toBe(0);
        }
    }

    it('prints a pasted quote (no reply header) one step in, without its ">" marks', async () =>
    {
        const message = make(0, { bodyText: `Hello Bob,\n\n${quoted}\nAlice\n` });
        check(await bodyLinesOf(inputFor([message])));
    });

    it('prints the whole quoted history the same way with "Print full original text"', async () =>
    {
        const message = make(0, { bodyText: `Hello Bob,\n\nOn Tue, 4 Mar 2025 at 09:00, Bob Sample <bob@sample.test> wrote:\n${quoted}\nAlice\n` });
        const policy = { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true };
        const lines = await bodyLinesOf(inputFor([message], { policy }));
        check(lines);
        expect(lines.find((l) => l.text.startsWith('On Tue, 4 Mar 2025'))!.x).toBeCloseTo(LEFT + STEP, 3);
    });
});
