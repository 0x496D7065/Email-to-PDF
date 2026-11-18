// The PRINTED SOMEWHERE check of the PDF model (Source/pdf-export/model.ts,
// printedNowhere; task 8.13b-3, review round 3, finding M2; collapse, never
// delete): text an email's plan leaves out only because another email in
// the PDF holds it must really be printed somewhere, else it is printed
// where it is. The reviewer's cases, with emails attached inside files and
// with plain files (a loss that existed before task 8.13b-3), each checked
// in the PDF and in the preview's labels (the same calculation), with the
// engine's own fix (overlap.ts, withHeldReferences) and without it.
// Synthetic data only: made-up names, *.test addresses (README.md, rule R7).

import { describe, expect, it } from 'vitest';
import { DEFAULT_PARTS, runEngine, type EngineParts } from '../thread-analysis/engine';
import { detectQuotedOverlap } from '../thread-analysis/overlap';
import { DEFAULT_OUTPUT_POLICY, planOutput } from '../thread-analysis/output-plan';
import { createEmlParser } from '../email-reading/eml';
import type { HtmlToTextResult } from '../email-reading/html-to-text';
import { printedElsewhereRanges } from '../web-page-logic/printed-elsewhere';
import { buildPdfDocument, noRepeat } from './model';
import { createPdfStrings } from './strings';
import { lineText } from './text';
import type { ParseResult } from '../../Header/parsed-email';
import type { PdfDocument, PdfEmail } from '../../Header/pdf-document-model';
import type { EngineResult } from '../../Header/thread-analysis-result';

const crlf = (...lines: string[]): string => lines.join('\r\n');
const stub = (html: string): HtmlToTextResult => ({ text: `[html ${String(html.length)}]`, truncated: false });
const eml = createEmlParser({ htmlToText: stub });
const strings = createPdfStrings('en');

const mixed = (b: string, ...parts: string[]): string =>
    crlf(`Content-Type: multipart/mixed; boundary="${b}"`, '', ...parts.flatMap((p) => [`--${b}`, p]), `--${b}--`, '');
const plain = (text: string): string => crlf('Content-Type: text/plain; charset=utf-8', '', text);
const rfc822 = (message: string): string => crlf('Content-Type: message/rfc822', '', message);

interface Head
{
    readonly name: string;
    readonly date: string | null;
    readonly inReplyTo?: string;
}
const head = ({ name, date, inReplyTo }: Head): string[] => [
    `From: ${name} <${name}@example.test>`,
    'To: Team <team@example.test>',
    ...(date === null ? [] : [`Date: ${date}`]),
    `Subject: ${name} subject`,
    `Message-ID: <${name}@example.test>`,
    ...(inReplyTo === undefined ? [] : [`In-Reply-To: <${inReplyTo}@example.test>`]),
    'MIME-Version: 1.0',
];
const simple = (h: Head, body: string): string => crlf(...head(h), 'Content-Type: text/plain; charset=utf-8', '', body);
const holding = (h: Head, own: string, ...children: string[]): string => crlf(...head(h), mixed(`b-${h.name}`, plain(own), ...children.map(rfc822)));

const MON = 'Mon, 2 Jun 2025 10:00:00 +0200';
const TUE = 'Tue, 3 Jun 2025 10:00:00 +0200';
const WED = 'Wed, 4 Jun 2025 10:00:00 +0200';
const THU = 'Thu, 5 Jun 2025 10:00:00 +0200';

const HELLO = 'Hello Ben, a short update on the office move before the weekend starts for all of us.';
const S = 'The twelve oak desks will arrive on Thursday morning and the movers need the loading bay free until noon.';
const FINE = 'Fine by me, I will tell the front desk about the loading bay today.';
const FORWARD = 'Forwarding the note from Ben about the move, for the record of the facilities team.';
const ATTRIBUTION = 'On Mon, 2 Jun 2025 at 10:00, ann <ann@example.test> wrote:';

/** Ann's email: an opening, then S (her paragraph quoted by Ben). */
const annBody = `${HELLO}\n\n${S}\n`;
/** Ben's reply: his answer, then S quoted under a reply header. */
const benBody = `${FINE}\n\n${ATTRIBUTION}\n> ${S}\n`;

async function parse(name: string, text: string): Promise<ParseResult>
{
    const r = await eml.parse({ name, bytes: new TextEncoder().encode(text) });
    if (!r.ok)
    {
        throw new Error(r.detail);
    }
    return r;
}

const squash = (s: string): string => s.replace(/\s+/gu, ' ').trim();
const bodyOf = (e: PdfEmail): string => e.body.map(lineText).join('\n');
const docOf = (out: EngineResult): PdfDocument =>
{
    const positions = out.messages.map((_, k) => k);
    const plans = planOutput(
        positions.map((p) => out.messages[p]!),
        DEFAULT_OUTPUT_POLICY,
    );
    return buildPdfDocument({ result: out, positions, plans, policy: DEFAULT_OUTPUT_POLICY, timeZone: 'UTC', generatedAt: 0, strings });
};
/** How many emails of the PDF print `text`. */
const printedIn = (d: PdfDocument, text: string): number => d.emails.filter((e) => squash(bodyOf(e)).includes(squash(text))).length;
const positionOf = (out: EngineResult, name: string): number => out.messages.findIndex((m) => m.message.subject === `${name} subject`);

/** The preview's ranges for every email (Source/web-page-logic/printed-elsewhere.ts), and the restored pieces (noRepeat). */
function previewOf(out: EngineResult)
{
    const positions = out.messages.map((_, k) => k);
    const plans = planOutput(
        positions.map((p) => out.messages[p]!),
        DEFAULT_OUTPUT_POLICY,
    );
    const input = { result: out, positions, plans, policy: DEFAULT_OUTPUT_POLICY, rebuilt: [] };
    return { ranges: printedElsewhereRanges(input), restored: noRepeat(input).restored, plans };
}

/** The real overlap detector, told nothing about which email holds which: the engine's own fixes undone (holds and withHeldReferences). */
const NO_HOLDS: EngineParts = {
    ...DEFAULT_PARTS,
    detectQuotedOverlap: (messages) => detectQuotedOverlap(messages.map((m) => ({ bodyText: m.bodyText, messageId: m.messageId, inReplyTo: m.inReplyTo, references: m.references, index: m.index }))),
};

describe('PDF model, printed somewhere: the reviewer\'s M2 case (an attached reply quoting an undated email)', () =>
{
    // Ann (no Date) wrote S; Ben's reply (In-Reply-To Ann) quotes S; Cy forwards Ben's reply inline. The reader drops Cy's file and Ann's.
    const files = async (): Promise<ParseResult[]> => [
        await parse('cy.eml', holding({ name: 'cy', date: WED }, FORWARD, simple({ name: 'ben', date: TUE, inReplyTo: 'ann' }, benBody))),
        await parse('ann.eml', simple({ name: 'ann', date: null }, annBody)),
    ];

    // Review round 4 (M1, user decision option a): Ben's page leaves his quote of S out (quoted history), so
    // that quote stays in Cy's copy of Ben's block (only what Ben's page prints is cut there): S is printed in
    // Ann's email and inside Cy's forward (an accepted repeat, never nowhere).
    const bodyAt = (d: PdfDocument, out: EngineResult, name: string): string => squash(bodyOf(d.emails.find((e) => e.position === positionOf(out, name))!));

    it('S is printed in Ann\'s email: the engine folds the forward, not Ann (Cy counts as referencing what Ben references)', async () =>
    {
        const out = runEngine(await files());
        const ann = out.messages[positionOf(out, 'ann')]!;
        // Ann's own paragraph is not folded as quoted from Cy any more.
        const sAt = ann.message.bodyText.indexOf(S);
        expect(ann.segments.filter((s) => s.folded && s.start <= sAt && s.end > sAt)).toEqual([]);
        const d = docOf(out);
        expect(bodyAt(d, out, 'ann')).toContain(squash(S));
        // And in Cy's forward, where Ben's quote of it stays (Ben's page leaves it out).
        expect(bodyAt(d, out, 'cy')).toContain(squash(S));
        expect(bodyAt(d, out, 'ben')).not.toContain(squash(S));
        expect(printedIn(d, S)).toBe(2);
        expect(printedIn(d, HELLO)).toBe(1);
        expect(printedIn(d, FINE)).toBe(1);
        expect(printedIn(d, FORWARD)).toBe(1);
    });

    it('the engine fixes undone: S is still printed, once, in Cy\'s copy of Ben\'s block; nothing to restore', async () =>
    {
        const out = runEngine(await files(), NO_HOLDS);
        const annPosition = positionOf(out, 'ann');
        const ann = out.messages[annPosition]!;
        const sAt = ann.message.bodyText.indexOf(S);
        // The setting of the round 3 bug: S folded in Ann's email as quoted from Cy (no quote mark, no reply
        // header), and left out by her plan; Ben's quote of it left out by his (quoted history).
        const cyIndex = out.messages[positionOf(out, 'cy')]!.index;
        expect(ann.segments.some((s) => s.folded && s.start <= sAt && s.end > sAt && s.related.includes(cyIndex) && s.reasons.join() === 'quoted-overlap')).toBe(true);
        const { restored, plans } = previewOf(out);
        expect(plans[annPosition]!.ranges.some((r) => !r.keep && r.start <= sAt && r.end > sAt)).toBe(true);
        const d = docOf(out);
        // Ben's quote stays in Cy's copy of his block (Ben's page does not print it), so the PRINTED SOMEWHERE
        // check finds S printed there and restores nothing.
        expect(printedIn(d, S)).toBe(1);
        expect(bodyAt(d, out, 'cy')).toContain(squash(S));
        expect(restored.size).toBe(0);
    });

    it('wrong clocks: Ann dated after Ben\'s reply (and after the forward), the same', async () =>
    {
        for (const parts of [DEFAULT_PARTS, NO_HOLDS])
        {
            const out = runEngine(
                [
                    await parse('cy.eml', holding({ name: 'cy', date: WED }, FORWARD, simple({ name: 'ben', date: TUE, inReplyTo: 'ann' }, benBody))),
                    await parse('ann.eml', simple({ name: 'ann', date: THU }, annBody)),
                ],
                parts,
            );
            const d = docOf(out);
            expect(printedIn(d, S)).toBeGreaterThanOrEqual(1);
            expect(printedIn(d, HELLO)).toBe(1);
            // Ben's quote of S stays in Cy's forward (round 4, M1).
            expect(bodyAt(d, out, 'cy')).toContain(squash(S));
            if (parts === DEFAULT_PARTS)
            {
                expect(bodyAt(d, out, 'ann')).toContain(squash(S));
            }
        }
    });

    it('nested: the quoting reply two levels down (Cy holds Dee\'s forward, which holds Ben\'s reply), the same', async () =>
    {
        const dee = holding({ name: 'dee', date: TUE }, 'Dee passes this on to the team without further comment for now.', simple({ name: 'ben', date: MON, inReplyTo: 'ann' }, benBody));
        for (const parts of [DEFAULT_PARTS, NO_HOLDS])
        {
            const out = runEngine([await parse('cy.eml', holding({ name: 'cy', date: WED }, FORWARD, dee)), await parse('ann.eml', simple({ name: 'ann', date: null }, annBody))], parts);
            expect(out.attached?.length).toBe(2);
            const d = docOf(out);
            expect(printedIn(d, S)).toBeGreaterThanOrEqual(1);
            expect(printedIn(d, HELLO)).toBe(1);
            expect(printedIn(d, FINE)).toBe(1);
            // Ben's quote of S stays in Dee's copy of his block (round 4, M1: Ben's page does not print it); Dee's
            // page prints it, so it is cut from Cy's copy of Dee's block, printed as Dee.
            expect(bodyAt(d, out, 'dee')).toContain(squash(S));
            expect(bodyAt(d, out, 'cy')).not.toContain(squash(S));
            if (parts === DEFAULT_PARTS)
            {
                expect(bodyAt(d, out, 'ann')).toContain(squash(S));
            }
        }
    });
});

describe('PDF model, printed somewhere: plain files (the loss that existed before task 8.13b-3)', () =>
{
    // X has no Date (or a wrong clock); Y quotes X's last paragraph under a reply header, without In-Reply-To.
    const xBody = `${HELLO}\n\n${S}\n`;
    const yBody = `${FINE}\n\n${ATTRIBUTION.replace('ann', 'x')}\n> ${S}\n`;

    for (const [what, xDate] of [
        ['X undated', null],
        ['X dated after its reply (wrong clock)', THU],
    ] as const)
    {
        it(`${what}: X's paragraph is printed once, in X, and the preview says it is in the PDF`, async () =>
        {
            const out = runEngine([await parse('x.eml', simple({ name: 'x', date: xDate }, xBody)), await parse('y.eml', simple({ name: 'y', date: TUE }, yBody))]);
            const xPosition = positionOf(out, 'x');
            const x = out.messages[xPosition]!;
            const sAt = x.message.bodyText.indexOf(S);
            // The setting of the old loss: S folded in X as quoted from Y, left out by X's plan; Y leaves its quote out.
            const { ranges, restored, plans } = previewOf(out);
            expect(plans[xPosition]!.ranges.some((r) => !r.keep && r.start <= sAt && r.end > sAt)).toBe(true);
            const d = docOf(out);
            expect(printedIn(d, S)).toBe(1);
            expect(squash(bodyOf(d.emails.find((e) => e.position === xPosition)!))).toContain(squash(S));
            expect(printedIn(d, HELLO)).toBe(1);
            expect(printedIn(d, FINE)).toBe(1);
            expect(restored.get(xPosition)?.some(([a, b]) => a <= sAt && b > sAt)).toBe(true);
            expect(ranges.get(xPosition)?.some((r) => r.keep && r.start <= sAt && r.end > sAt)).toBe(true);
        });
    }

    it('nothing is restored when the text is printed elsewhere (a normal reply: the quote left out, the quoted email printed)', async () =>
    {
        const out = runEngine([
            await parse('x.eml', simple({ name: 'x', date: MON }, xBody)),
            await parse('y.eml', simple({ name: 'y', date: TUE, inReplyTo: 'x' }, yBody)),
        ]);
        const { restored } = previewOf(out);
        expect(restored.size).toBe(0);
        const d = docOf(out);
        expect(printedIn(d, S)).toBe(1);
    });

    it('a quote of an email that is not in the PDF stays left out (not justified by "printed elsewhere": no candidate)', async () =>
    {
        const out = runEngine([
            await parse('x.eml', simple({ name: 'x', date: MON }, xBody)),
            await parse('y.eml', simple({ name: 'y', date: TUE, inReplyTo: 'x' }, yBody)),
        ]);
        const y = positionOf(out, 'y');
        const plans = planOutput([out.messages[y]!], DEFAULT_OUTPUT_POLICY);
        const input = { result: out, positions: [y], plans, policy: DEFAULT_OUTPUT_POLICY, rebuilt: [] };
        expect(noRepeat(input).restored.size).toBe(0);
        const d = buildPdfDocument({ ...input, timeZone: 'UTC', generatedAt: 0, strings });
        expect(printedIn(d, S)).toBe(0);
        expect(printedIn(d, FINE)).toBe(1);
    });

    it('"Print full original text": nothing to restore (every body whole)', async () =>
    {
        const out = runEngine([await parse('x.eml', simple({ name: 'x', date: null }, xBody)), await parse('y.eml', simple({ name: 'y', date: TUE }, yBody))]);
        const positions = out.messages.map((_, k) => k);
        const policy = { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true };
        const plans = planOutput(
            positions.map((p) => out.messages[p]!),
            policy,
        );
        expect(noRepeat({ result: out, positions, plans, policy, rebuilt: [] }).restored.size).toBe(0);
    });
});
