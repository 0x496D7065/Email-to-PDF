// Emails attached inside a dropped file (task 8.13b-3) on the whole PDF path
// (generatePdf, real fonts, our own writer), read back from the written file
// as text: the attached email has its own index line and page, its File row
// names "file › attachment" (the separator is drawn, not a missing glyph),
// and its text is printed once, on its own page, not in its parent. With
// "Print full original text" it is printed in both. Synthetic data only
// (README.md, rule R7).
import { beforeAll, describe, expect, it } from 'vitest';
import { readDests, readPageRuns, readPdf, textLines } from '../../tests/support/pdf-reader';
import { runEngine } from '../thread-analysis/engine';
import { DEFAULT_OUTPUT_POLICY, planOutput, type OutputPolicy } from '../thread-analysis/output-plan';
import { createEmlParser } from '../email-reading/eml';
import type { HtmlToTextResult } from '../email-reading/html-to-text';
import { generatePdf, type PdfFonts } from './generate';
import { loadPdfFonts } from './load-fonts';

let fonts: PdfFonts;
beforeAll(async () =>
{
    fonts = await loadPdfFonts();
});

const crlf = (...lines: string[]): string => lines.join('\r\n');
const stub = (html: string): HtmlToTextResult => ({ text: `[html ${String(html.length)}]`, truncated: false });
const squash = (s: string): string => s.replace(/\s+/gu, ' ').trim();

const OWN = 'Please find the forwarded figures below, as promised during the call.';
const A_BODY = 'The quarterly figures for the north warehouse are attached and the totals were checked twice by the team.';
const FILE = crlf(
    'From: Alice <alice@example.test>',
    'To: Team <team@example.test>',
    'Date: Tue, 3 Jun 2025 14:00:00 +0200',
    'Subject: Fwd: figures',
    'Message-ID: <alice-fwd@example.test>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="outer"',
    '',
    '--outer',
    'Content-Type: text/plain; charset=utf-8',
    '',
    OWN,
    '--outer',
    'Content-Type: message/rfc822',
    '',
    'From: Bob <bob@example.test>',
    'To: Alice <alice@example.test>',
    'Date: Mon, 2 Jun 2025 10:00:00 +0200',
    'Subject: figures',
    'Message-ID: <bob-figures@example.test>',
    '',
    A_BODY,
    '--outer--',
    '',
);

/** The PDF of the file, read back: the text of each email's pages, in PDF order, and the index page. */
async function made(policy: OutputPolicy): Promise<{ texts: string[]; cover: string }>
{
    const parsed = await createEmlParser({ htmlToText: stub }).parse({ name: 'forward.eml', bytes: new TextEncoder().encode(FILE) });
    const result = runEngine([parsed]);
    const positions = result.messages.map((_, k) => k);
    const plans = planOutput(
        positions.map((p) => result.messages[p]!),
        policy,
    );
    const pdf = readPdf((await generatePdf({ result, positions, plans, policy, timeZone: 'UTC', generatedAt: Date.UTC(2025, 5, 10), fonts, locale: 'en' })).bytes);
    const pages = (await readPageRuns(pdf)).map((runs) => textLines(runs).map((l) => l.shown).join(' '));
    const dests = readDests(pdf);
    const starts: number[] = [];
    for (let n = 1; dests.has(`email-${String(n)}`); n++)
    {
        starts.push(dests.get(`email-${String(n)}`)!.page);
    }
    return { texts: starts.map((page, k) => squash(pages.slice(page, starts[k + 1] ?? pages.length).join(' '))), cover: squash(pages.slice(0, starts[0]).join(' ')) };
}

describe('generatePdf: an attached email', () =>
{
    it('the File row separator has a glyph in every text font (never a missing-glyph box)', () =>
    {
        for (const name of ['sans-regular', 'sans-bold', 'sans-italic'] as const)
        {
            expect(fonts[name].glyphFor(0x203a), name).not.toBe(0);
        }
    });

    it('folded: two emails, the forward printed once on its own page, its File row "file › attachment"', async () =>
    {
        const { texts, cover } = await made(DEFAULT_OUTPUT_POLICY);
        expect(texts).toHaveLength(2);
        // Email 1 is the attached one (older); Email 2 its parent.
        expect(texts[0]).toContain(squash(A_BODY));
        expect(texts[0]).toContain('forward.eml › (attached email 1)');
        expect(texts[1]).toContain(OWN);
        expect(texts[1]).not.toContain(squash(A_BODY));
        expect(texts[1]).not.toContain('Forwarded message');
        expect(cover).toContain('figures');
        expect(cover).toContain('Fwd: figures');
    });

    it('full original text: the parent prints the forward too', async () =>
    {
        const { texts } = await made({ ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true });
        expect(texts).toHaveLength(2);
        expect(texts[0]).toContain(squash(A_BODY));
        expect(texts[1]).toContain(squash(A_BODY));
        expect(texts[1]).toContain('Forwarded message');
    });
});
