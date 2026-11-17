// The PDF layout of quoted text (task 8.6, user decision 2026-11-05, PDF
// only), over whole synthetic conversations run through the whole path
// (engine, plans, generatePdf with the real fonts and our own writer) and
// read back from the written file: no line of the PDF starts with a ">"
// quote mark; every body line, wrapped lines included, is one fixed step
// (one tab: 4 spaces of the body font, bodyIndentSpaces, task 8.9) in from
// the margin, whatever its quote level, for real
// emails and for emails rebuilt from quoted text alike; the heading and
// header rows stay at the margin; a ">" inside a line is kept; VT / FF stay
// visible as codes. And the full text is still there: the engine's messages
// are unchanged and "Print full original text" prints every body whole,
// only its quote prefixes left out (Helper/Test/test-support/pdf-reference.ts).
//
// Synthetic data only (Helper/Test/test-support/thread-builder.ts: invented people,
// example.test addresses).
import { beforeAll, describe, expect, it } from 'vitest';
import { quotePrefixProblems, referenceDisplayText } from '../../Helper/Test/test-support/pdf-reference';
import { readDests, readPageRuns, readPdf, textLines } from '../../Helper/Test/test-support/pdf-reader';
import { buildThread, type QuoteStyle, type ThreadMessage } from '../../Helper/Test/test-support/thread-builder';
import { chain } from '../../Helper/Test/test-support/thread-cases';
import { runEngine } from '../thread-analysis/engine';
import { DEFAULT_OUTPUT_POLICY, planOutput } from '../thread-analysis/output-plan';
import { rebuiltEntries } from '../page-logic/rebuilt';
import { generatePdf, type PdfFonts } from './generate';
import { DEFAULT_LAYOUT_CONFIG as CONFIG } from './page-layout';
import { loadPdfFonts } from './load-fonts';
import { buildPdfDocument } from './model';
import { createPdfStrings } from './strings';
import { lineText } from './text';
import type { OutputPolicy } from '../../Header/output-plan';
import type { NormalizedMessage } from '../../Header/parsed-email';
import type { EngineResult } from '../../Header/thread-analysis-result';

const LEFT = CONFIG.margin.left;
/** Where every body line starts: one tab (4 normal spaces of the body font at the body size, from the font's tables) in from the margin. */
let BODY_X = Number.NaN;

let fonts: PdfFonts;
beforeAll(async () =>
{
    fonts = await loadPdfFonts();
    const font = fonts[CONFIG.roles.body.font];
    BODY_X = LEFT + (4 * font.advance(font.glyphFor(0x20)) * CONFIG.roles.body.size) / font.unitsPerEm;
});
/** Where a header row's value starts (a wrapped value or a note under it). */
const VALUE_X = LEFT + CONFIG.fields.labelWidth + CONFIG.fields.gap;
const LONG = 'The delivery van can only park in the side street between nine and eleven, so please keep the gate open and the hall free of boxes.';

/** Each message's own text: a ">" inside a line, and a line long enough to wrap. */
function withOwnText(messages: readonly ThreadMessage[]): ThreadMessage[]
{
    return messages.map((m, k) => ({ ...m, text: `Hello,\n\nNote ${String(k + 1)}: price > cost, a -> b.\n${LONG} (${String(k + 1)})\n\nRegards` }));
}

let counter = 0;
function message(body: string, subject: string, iso: string): NormalizedMessage
{
    counter++;
    return {
        messageId: `quotes-${String(counter)}@example.test`,
        inReplyTo: null,
        references: [],
        date: { utcMs: Date.parse(iso), original: '', offsetMinutes: 0, zoneKnown: true },
        from: [{ name: 'Alice Example', address: 'alice@example.test' }],
        to: [],
        cc: [],
        bcc: [],
        subject,
        bodyText: body,
        attachments: [],
        source: { fileName: `quotes-${String(counter)}.eml`, sha256: counter.toString(16).padStart(64, '0'), kind: 'eml' },
        warnings: [],
    };
}

/** The conversation as files: every message as its own file ('multi'), or only the last one, the rest rebuilt from it ('single'). */
function files(styles: readonly QuoteStyle[], mode: 'multi' | 'single'): NormalizedMessage[]
{
    const messages = withOwnText(chain(styles));
    const from = mode === 'multi' ? 0 : messages.length - 1;
    return messages.slice(from).map((_, k) =>
    {
        const t = buildThread(messages.slice(0, from + k + 1));
        return message(t.body, t.subject, t.instantUtc);
    });
}

interface ReadLine
{
    readonly text: string;
    readonly x: number;
}

/** Every line of the email pages (footers left out), as read back from the file. */
async function emailLines(messages: readonly NormalizedMessage[], policy: OutputPolicy): Promise<{ lines: ReadLine[]; result: EngineResult; rebuilt: number }>
{
    const result = runEngine(messages.map((m) => ({ ok: true as const, message: m })));
    const positions = result.messages.map((_, k) => k);
    const rebuilt = rebuiltEntries(result).map((r) => r.id);
    const made = await generatePdf({
        result,
        positions,
        plans: planOutput(
            positions.map((p) => result.messages[p]!),
            policy,
        ),
        rebuilt,
        policy,
        timeZone: 'Etc/UTC',
        generatedAt: Date.UTC(2025, 5, 1),
        fonts,
        locale: 'en',
    });
    const pdf = readPdf(made.bytes);
    const first = readDests(pdf).get('email-1')!.page;
    const pages = (await readPageRuns(pdf)).slice(first);
    const lines = pages.flatMap((runs) => textLines(runs.filter((r) => r.y > CONFIG.margin.bottom)).map((l) => ({ text: l.shown, x: l.runs[0]!.x })));
    return { lines, result, rebuilt: rebuilt.length };
}

const STYLES: readonly [string, readonly QuoteStyle[]][] = [
    ['Gmail', ['gmail-en', 'gmail-en', 'gmail-en', 'gmail-en']],
    ['Outlook', ['outlook-en', 'outlook-en', 'outlook-en', 'outlook-en']],
    ['mixed', ['outlook-en', 'gmail-en', 'apple-en', 'gmail-fr']],
];

describe('generatePdf: quoted conversations, one body indent and no quote marks (task 8.6)', () =>
{
    for (const [name, styles] of STYLES)
    {
        for (const mode of ['multi', 'single'] as const)
        {
            for (const unfold of [false, true])
            {
                it(`${name}, ${mode === 'multi' ? 'every email a file' : 'the last email only, the rest rebuilt'}${unfold ? ', "Print full original text"' : ''}`, async () =>
                {
                    const input = files(styles, mode);
                    const before = structuredClone(input);
                    const { lines, result, rebuilt } = await emailLines(input, { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: unfold });
                    if (mode === 'single')
                    {
                        expect(result.reconstructed.length).toBe(styles.length);
                    }
                    if (mode === 'single' && !unfold)
                    {
                        expect(rebuilt).toBeGreaterThan(0);
                    }

                    // No line starts with a quote mark.
                    for (const l of lines)
                    {
                        expect(l.text, l.text).not.toMatch(/^\s*>/u);
                    }
                    // Only three x positions: the margin (heading, header labels, notes), a header value, the body step.
                    for (const l of lines)
                    {
                        expect([LEFT, VALUE_X, BODY_X].some((x) => Math.abs(l.x - x) < 1e-3), `${l.text} at ${String(l.x)}`).toBe(true);
                    }
                    expect(lines.find((l) => l.text.startsWith('Email 1'))!.x).toBeCloseTo(LEFT, 3);
                    for (const l of lines.filter((r) => /^(From|Date|Subject) /u.test(r.text)))
                    {
                        expect(l.x).toBeCloseTo(LEFT, 3);
                    }

                    // Every email's own text is printed, one step in, the ">" inside the line kept; the long line wrapped, every piece one step in.
                    const total = mode === 'multi' ? styles.length + 1 : 1 + (unfold ? 0 : styles.length);
                    const notes = lines.filter((l) => /^Note \d+: price > cost, a -> b\.$/u.test(l.text));
                    expect(new Set(notes.map((l) => l.text)).size).toBe(styles.length + 1);
                    for (const l of notes)
                    {
                        expect(l.x).toBeCloseTo(BODY_X, 3);
                    }
                    const pieces = lines.filter((l) => /delivery van|side street|hall free of boxes/u.test(l.text));
                    expect(pieces.length).toBeGreaterThanOrEqual(2 * total);
                    for (const l of pieces)
                    {
                        expect(l.x).toBeCloseTo(BODY_X, 3);
                    }

                    // Collapse, never delete: the messages are unchanged; the full text keeps every body whole (only quote prefixes left out).
                    expect(result.messages.map((m) => m.message)).toEqual(before);
                    if (unfold)
                    {
                        const doc = buildPdfDocument({
                            result,
                            positions: result.messages.map((_, k) => k),
                            plans: planOutput(result.messages, { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true }),
                            policy: { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true },
                            timeZone: 'Etc/UTC',
                            generatedAt: 0,
                            strings: createPdfStrings('en'),
                        });
                        const real = doc.emails.filter((e) => e.position !== null);
                        expect(real).toHaveLength(input.length);
                        for (const e of real)
                        {
                            const body = result.messages[e.position!]!.message.bodyText;
                            expect(e.body.map(lineText).join('\n')).toBe(referenceDisplayText(body));
                            expect(quotePrefixProblems(body, e.body.map(lineText))).toEqual([]);
                        }
                    }
                }, 60_000);
            }
        }
    }

    it('keeps VT and FF visible as codes (never part of a removed prefix), and a ">" inside a line', async () =>
    {
        const body = 'Own text, a > b.\n> \f> after a form feed\n\v> after a vertical tab\n>> deep > inside\n';
        const { lines } = await emailLines([message(body, 'Codes', '2025-03-04T08:00:00Z')], { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true });
        const body2 = lines.filter((l) => Math.abs(l.x - BODY_X) < 1e-3).map((l) => l.text);
        expect(body2).toEqual(['Own text, a > b.', '[U+000C]> after a form feed', '[U+000B]> after a vertical tab', 'deep > inside']);
    });

    it('removes marks after invisible characters outside the BMP and one no-break space after them; blank-looking characters the fonts lack stay as codes', async () =>
    {
        const body = [
            'Own text.',
            '\u{E0100}> supplement selector first',
            '>\u{E01EF}> supplement selector between',
            '>\u{00A0}no-break space after',
            '>\u{00A0}\u{00A0}two no-break spaces',
            '\u{3164}> Hangul filler',
            '>\u{2800}> braille blank',
            '\u{E0041}> tag character',
            '',
        ].join('\n');
        const { lines } = await emailLines([message(body, 'Invisible', '2025-03-04T09:00:00Z')], { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true });
        const shown = lines.filter((l) => Math.abs(l.x - BODY_X) < 1e-3).map((l) => l.text);
        expect(shown).toEqual([
            'Own text.',
            'supplement selector first',
            'supplement selector between',
            'no-break space after',
            '\u{00A0}two no-break spaces',
            '[U+3164]> Hangul filler',
            '[U+2800]> braille blank',
            '[U+E0041]> tag character',
        ]);
    });
});
