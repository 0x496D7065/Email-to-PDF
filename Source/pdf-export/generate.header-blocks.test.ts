// Task 8.13: no email header block in the middle of a page, none without
// its index entry. Every email of the PDF, real or rebuilt, starts at the
// top of a new page with its header block (the bold "Email N" heading and
// the bold header labels: From, To, Date, Subject...), and has its own
// index line giving that page (user decisions 2026-11-02, 2026-11-06,
// 2026-11-09). Checked on the whole PDF path (generatePdf, real fonts, our
// own writer), read back from the written file (fonts by their PostScript
// name, positions, links, destinations), as a general invariant over every
// conversation of Helper/Test/test-support/thread-cases.ts (the last email alone, with
// and without rebuilt emails; every email; the first and the last; the last
// two) and over the fixture set, with "Print full original text" off and on.
//
// THE INVARIANT: in the email pages, every run in the bold font is one of
// - an email heading ("Email N"), the topmost text of its page, whose index
//   line (a link to "email-N" on the front pages) shows that page;
// - a header label of that email, on the page of its heading, above the
//   first line of its text;
// - the "Attachments" label of an email's attachment list.
// So whatever an email's text holds (forwarded or quoted header lines such
// as "From: / Sent: / To: / Subject:", a "Forwarded message" block, an
// attached email the .eml reader shows in the text), it is drawn as plain
// text in the body font, one tab in, never in the header style. The
// regression tests at the end pin that for the input shapes of the bug
// report (header lines that are still printed inside a body after task
// 8.13a: an attached email the engine does not rebuild, header lines moved
// to the top of a rebuilt email, a forward with the switch off; which
// header lines stay is checked in Source/pdf-export/model.header-lines.test.ts).
// Synthetic data only (README.md, rule R7).
import { beforeAll, describe, expect, it } from 'vitest';
import { parseAllFixtures } from '../../Helper/Test/test-data/parse-all';
import { readDests, readLinks, readPageRuns, readPdf, textLines, type PageRun, type ParsedPdf } from '../../Helper/Test/test-support/pdf-reader';
import { buildThread, instantOf, type ThreadMessage } from '../../Helper/Test/test-support/thread-builder';
import { THREAD_CASES } from '../../Helper/Test/test-support/thread-cases';
import { runEngine, type EngineResult } from '../thread-analysis/engine';
import { DEFAULT_OUTPUT_POLICY, planOutput, type OutputPolicy } from '../thread-analysis/output-plan';
import { createEmlParser } from '../email-reading/eml';
import type { NormalizedMessage } from '../email-reading/types';
import { rebuiltEntries } from '../page-logic/rebuilt';
import { generatePdf, type PdfFonts } from './generate';
import { DEFAULT_LAYOUT_CONFIG as CONFIG } from './page-layout';
import { loadPdfFonts } from './load-fonts';
import { createPdfStrings } from './strings';

const STRINGS = createPdfStrings('en');
const FULL: OutputPolicy = { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true };

let fonts: PdfFonts;
let fixtures: NormalizedMessage[];
beforeAll(async () =>
{
    fonts = await loadPdfFonts();
    fixtures = await parseAllFixtures();
});

/** Message `i` of a conversation as a real file (its body quotes the ones before it). */
function realFile(messages: readonly ThreadMessage[], i: number, tag: string): NormalizedMessage
{
    const m = messages[i]!;
    const id = (k: number): string => `${tag}-${String(k)}@example.test`;
    const utcMs = instantOf(m.sent, m.zone);
    return {
        messageId: id(i),
        inReplyTo: i === 0 ? null : id(i - 1),
        references: Array.from({ length: i }, (_, k) => id(k)),
        date: { utcMs, original: new Date(utcMs).toUTCString(), offsetMinutes: m.zone.offsetMinutes, zoneKnown: true },
        from: [m.from],
        to: m.to,
        cc: m.cc ?? [],
        bcc: [],
        subject: m.subject,
        bodyText: buildThread(messages.slice(0, i + 1)).body,
        attachments: [],
        source: { fileName: `${tag}-${String(i)}.eml`, sha256: (i + 1).toString(16).padStart(64, '0'), kind: 'eml' },
        warnings: [],
    };
}

/**
 * The PDF of `messages` (every one ticked), with every rebuilt email chosen unless `rebuilt` says otherwise;
 * every rebuilt email not chosen counts as unticked by the reader (BuildPdfInput.unticked) unless `rebuildingOff`.
 */
async function makePdf(messages: readonly NormalizedMessage[], policy: OutputPolicy, rebuilt?: (result: EngineResult) => number[], rebuildingOff = false)
{
    const result = runEngine(messages.map((message) => ({ ok: true as const, message })));
    const positions = result.messages.map((_, k) => k);
    const plans = planOutput(
        positions.map((p) => result.messages[p]!),
        policy,
    );
    const chosen = rebuilt?.(result) ?? rebuiltEntries(result).map((r) => r.id);
    const made = await generatePdf({
        result,
        positions,
        plans,
        rebuilt: chosen,
        rebuildingOff,
        unticked: rebuiltEntries(result)
            .map((r) => r.id)
            .filter((id) => !chosen.includes(id)),
        policy,
        timeZone: 'UTC',
        generatedAt: Date.UTC(2025, 5, 1, 12, 0, 0),
        fonts,
        locale: 'en',
    });
    return readPdf(made.bytes);
}

const near = (a: number, b: number): boolean => Math.abs(a - b) < 0.01;
const isBody = (r: PageRun, regular: Set<string>): boolean => regular.has(r.font) && near(r.size, CONFIG.roles.body.size);

/** The fonts of each page by resource name -> PostScript name. */
function pageFonts(pdf: ParsedPdf): Map<string, string>[]
{
    return pdf.pages().map((page) =>
    {
        const dict = pdf.dict(pdf.dict(page.get('Resources')).get('Font'));
        return new Map([...dict.keys()].map((key) => [key, pdf.name(pdf.dict(dict.get(key)).get('BaseFont'))]));
    });
}

/**
 * Checks THE INVARIANT (top of this file) on a written PDF and returns what
 * it found: the emails (number -> page), so a caller can check more.
 */
async function expectHeaderBlocksAtPageTops(pdf: ParsedPdf, what: string): Promise<Map<number, number>>
{
    const pages = await readPageRuns(pdf);
    const names = pageFonts(pdf);
    const dests = readDests(pdf);
    const links = readLinks(pdf);
    const bold = fonts['sans-bold'].postScriptName;
    const regular = fonts['sans-regular'].postScriptName;

    // The emails, by their destinations "email-N".
    const emails = new Map<number, number>();
    for (const [name, dest] of dests)
    {
        const m = /^email-(\d+)$/u.exec(name);
        if (m !== null)
        {
            emails.set(Number(m[1]), dest.page);
        }
    }
    expect(emails.size, what).toBeGreaterThan(0);
    const firstEmailPage = Math.min(...emails.values());

    // The index: one line per email, a link to it on a front page, showing its page.
    const indexed = new Map<number, number>();
    for (const link of links)
    {
        const m = /^email-(\d+)$/u.exec(link.dest);
        if (m === null)
        {
            continue;
        }
        expect(link.page, `${what}: index link on a front page`).toBeLessThan(firstEmailPage);
        const [, y1, , y2] = link.rect;
        const lines = textLines(pages[link.page]!).filter((l) => l.y > y1 && l.y < y2);
        const shown = /\s(\d+)$/u.exec(lines[0]?.shown ?? '');
        expect(shown, `${what}: the index line of email ${m[1]!} shows a page`).not.toBeNull();
        if (!indexed.has(Number(m[1])))
        {
            indexed.set(Number(m[1]), Number(shown![1]) - 1);
        }
    }
    expect(indexed, `${what}: every email has an index line with its page, and every index line an email`).toEqual(emails);

    const regularNames = new Set([regular]);
    const headings = new Map<number, number>();
    for (let p = firstEmailPage; p < pages.length; p++)
    {
        const runs = pages[p]!.map((r) => ({ ...r, font: names[p]!.get(r.font) ?? r.font }));
        const boldRuns = runs.filter((r) => r.font === bold);
        const heading = boldRuns.filter((r) => near(r.size, CONFIG.roles.heading.size));
        expect(heading.length, `${what}: page ${String(p + 1)} has at most one email heading`).toBeLessThanOrEqual(1);
        const h = heading[0];
        if (h !== undefined)
        {
            const m = /^Email (\d+)$/u.exec(h.shown);
            expect(m, `${what}: page ${String(p + 1)}: "${h.shown}" is an email heading`).not.toBeNull();
            const n = Number(m![1]);
            headings.set(n, p);
            expect(emails.get(n), `${what}: Email ${String(n)} is on the page of its destination`).toBe(p);
            // The topmost text of its page (PDF y goes up).
            expect(Math.max(...runs.map((r) => r.y)), `${what}: Email ${String(n)} starts at the top of page ${String(p + 1)}`).toBeCloseTo(h.y, 6);
        }
        const bodyTop = Math.max(-Infinity, ...runs.filter((r) => isBody(r, regularNames)).map((r) => r.y));
        for (const r of boldRuns)
        {
            if (r === h || r.shown === STRINGS.attachmentsLabel)
            {
                continue;
            }
            // A header label: on the page of its email's heading, above the email's text.
            expect(near(r.size, CONFIG.roles['field-label'].size) && h !== undefined && r.y > bodyTop, `${what}: page ${String(p + 1)}: bold "${r.shown}" is a header label above the text of an email that starts on this page`).toBe(true);
        }
    }
    expect(headings, `${what}: one heading per email, on its page`).toEqual(emails);
    return emails;
}

describe('every header block of the PDF is at the top of a page and has its index line (task 8.13)', () =>
{
    for (const c of THREAD_CASES)
    {
        it(c.id, async () =>
        {
            const ms = c.messages!;
            const tag = c.id.replace(/[^a-z0-9]+/giu, '-');
            const n = ms.length;
            const files = (idx: readonly number[]): NormalizedMessage[] => idx.map((i) => realFile(ms, i, tag));
            const batches: [string, number[]][] = [
                ['last', [n - 1]],
                ['every email', ms.map((_, i) => i)],
                ['first and last', [0, n - 1]],
                ['last two', [n - 2, n - 1]],
            ];
            for (const [name, idx] of batches)
            {
                await expectHeaderBlocksAtPageTops(await makePdf(files(idx), DEFAULT_OUTPUT_POLICY), `${c.id}, ${name}`);
            }
            // The last email alone with the switch off, and with "Print full original text".
            await expectHeaderBlocksAtPageTops(await makePdf(files([n - 1]), DEFAULT_OUTPUT_POLICY, () => []), `${c.id}, last, no rebuilt email`);
            await expectHeaderBlocksAtPageTops(await makePdf(files([n - 1]), FULL), `${c.id}, last, full original text`);
            await expectHeaderBlocksAtPageTops(await makePdf(files(ms.map((_, i) => i)), FULL), `${c.id}, every email, full original text`);
        });
    }

    it('the fixture set, all together and one by one, folded and full', async () =>
    {
        for (const policy of [DEFAULT_OUTPUT_POLICY, FULL])
        {
            const mode = policy.unfoldEverything ? 'full' : 'folded';
            await expectHeaderBlocksAtPageTops(await makePdf(fixtures, policy), `all fixtures, ${mode}`);
            for (const f of fixtures)
            {
                await expectHeaderBlocksAtPageTops(await makePdf([f], policy), `${f.source.fileName}, ${mode}`);
            }
        }
    });
});

/** Lines joined with CRLF, as in a real .eml file. */
const crlf = (...lines: string[]): string => lines.join('\r\n');

/**
 * The lines of each page that hold `text`, with their runs' fonts by
 * PostScript name and their left edge.
 */
async function linesHolding(pdf: ParsedPdf, text: string): Promise<{ page: number; x: number; fonts: string[]; shown: string }[]>
{
    const pages = await readPageRuns(pdf);
    const names = pageFonts(pdf);
    const out: { page: number; x: number; fonts: string[]; shown: string }[] = [];
    for (const [p, runs] of pages.entries())
    {
        for (const line of textLines(runs))
        {
            if (line.shown.includes(text))
            {
                out.push({ page: p, x: line.runs[0]!.x, fonts: line.runs.map((r) => names[p]!.get(r.font) ?? r.font), shown: line.shown });
            }
        }
    }
    return out;
}

describe('header lines inside an email text are plain body text, never a header block (task 8.13 regressions)', () =>
{
    const BODY_X = CONFIG.margin.left;

    /** Expects every line holding `text` to be one tab in, in the regular body font, on an email page. */
    async function expectPlainBodyLines(pdf: ParsedPdf, texts: readonly string[], what: string): Promise<void>
    {
        const regular = fonts['sans-regular'].postScriptName;
        for (const text of texts)
        {
            const lines = await linesHolding(pdf, text);
            expect(lines.length, `${what}: "${text}" is in the PDF`).toBeGreaterThan(0);
            for (const line of lines)
            {
                expect(line.fonts.every((f) => f === regular), `${what}: "${line.shown}" in the body font`).toBe(true);
                expect(line.x, `${what}: "${line.shown}" one tab in`).toBeGreaterThan(BODY_X + 1);
            }
        }
        await expectHeaderBlocksAtPageTops(pdf, what);
    }

    it('an attached email the .eml reader shows inside a forward (message/rfc822, no Content-Disposition)', async () =>
    {
        const inner = crlf(
            'From: Bob Sample <bob@example.test>',
            'To: Carol Test <carol@example.test>',
            'Subject: Desk quote',
            'Date: Mon, 3 Mar 2025 10:00:00 +0100',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'Hello Carol,',
            '',
            'The quote for four desks is twelve hundred.',
            '',
            'Bob',
        );
        const eml = crlf(
            'From: Carol Test <carol@example.test>',
            'To: Alice Example <alice@example.test>',
            'Subject: Fwd: Desk quote',
            'Date: Tue, 4 Mar 2025 09:00:00 +0100',
            'Message-ID: <fwd-8-13@example.test>',
            'MIME-Version: 1.0',
            'Content-Type: multipart/mixed; boundary="b"',
            '',
            '--b',
            'Content-Type: text/plain; charset=utf-8',
            '',
            'Alice, see the quote below.',
            '--b',
            'Content-Type: message/rfc822',
            '',
            inner,
            '--b--',
            '',
        );
        const parsed = await createEmlParser({ htmlToText: () => ({ text: '', truncated: false }) }).parse({ name: 'fwd.eml', bytes: new TextEncoder().encode(eml) });
        if (!parsed.ok)
        {
            throw new Error(parsed.detail);
        }
        for (const policy of [DEFAULT_OUTPUT_POLICY, FULL])
        {
            const pdf = await makePdf([parsed.message], policy);
            const what = `attached email, ${policy.unfoldEverything ? 'full' : 'folded'}`;
            // One email in the PDF: the forward, its attached email printed in its text (current behaviour, see the top of this file).
            expect((await expectHeaderBlocksAtPageTops(pdf, what)).size, what).toBe(1);
            await expectPlainBodyLines(pdf, ['---------- Forwarded message ----------', 'From: Bob Sample', 'Subject: Desk quote', 'The quote for four desks'], what);
        }
    });

    it('an Outlook chain with only the first and the last file: the middle emails\' header lines, moved to their rebuilt emails, are plain body text (task 8.13a, Q3, Q4)', async () =>
    {
        const c = THREAD_CASES.find((x) => x.id === 'outlook-en x3')!;
        const ms = c.messages!;
        const pdf = await makePdf([realFile(ms, 0, 'b1'), realFile(ms, ms.length - 1, 'b1')], DEFAULT_OUTPUT_POLICY);
        await expectPlainBodyLines(pdf, ['From: Alice Example', 'Sent: Monday, March 3, 2025', 'Subject: RE: Office desks and chairs'], 'outlook-en x3, first and last');
    });

    it('a Gmail forward of an Outlook thread, the last email alone: header lines that the rebuilt emails cannot show, moved to their tops, are plain body text (task 8.13a, Q4)', async () =>
    {
        const c = THREAD_CASES.find((x) => x.id === 'gmail forward of an outlook thread')!;
        const ms = c.messages!;
        const pdf = await makePdf([realFile(ms, ms.length - 1, 'b2')], DEFAULT_OUTPUT_POLICY);
        await expectPlainBodyLines(pdf, ['---------- Forwarded message', 'Date: Mon, Mar 3, 2025 at 6:52 PM', 'Sent: Monday, March 3, 2025 5:15 PM'], 'gmail forward, last');
    });

    it('a forward whose rebuilt emails are unticked: the forwarded emails are left out (task 8.13a, Q2); with the switch off, or "Print full original text", they stay in its text', async () =>
    {
        const c = THREAD_CASES.find((x) => x.id === 'outlook forward (FW: subject)')!;
        const ms = c.messages!;
        const lines = ['From: Bob Sample', 'Subject: RE: Office desks and chairs', 'Thank you for your message.'];
        const unticked = await makePdf([realFile(ms, ms.length - 1, 'off')], DEFAULT_OUTPUT_POLICY, () => []);
        expect((await expectHeaderBlocksAtPageTops(unticked, 'forward, rebuilt emails unticked')).size).toBe(1);
        for (const text of lines)
        {
            expect(await linesHolding(unticked, text), `unticked: "${text}" left out`).toEqual([]);
        }
        const off = await makePdf([realFile(ms, ms.length - 1, 'off')], DEFAULT_OUTPUT_POLICY, () => [], true);
        expect((await expectHeaderBlocksAtPageTops(off, 'forward, switch off')).size).toBe(1);
        await expectPlainBodyLines(off, lines, 'forward, switch off');
        await expectPlainBodyLines(await makePdf([realFile(ms, ms.length - 1, 'off')], FULL), lines, 'forward, full original text');
    });
});
