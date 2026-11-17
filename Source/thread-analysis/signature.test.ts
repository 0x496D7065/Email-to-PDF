// Tests for signature and disclaimer detection (README.md, rules R6 and R7).
// Synthetic text only; non-ASCII characters are written as \u escapes.

import { describe, expect, it } from 'vitest';
import { buildSegments, checkSegments, reconstruct, type FoldRange } from './segments';
import {
    MAX_SIGNATURE_LINES,
    MIN_BLOCK_CHARS,
    detectSignatures,
    minRepeat,
    senderKeyOf,
    type SignatureInput,
} from './signature';
import type { NormalizedMessage } from '../../Header/parsed-email';

const BOB = 'bob@furniture.example.test';
const ALICE = 'alice@example.test';

/** Runs the detector and checks every result against the segment model. */
function detect(inputs: readonly SignatureInput[]): FoldRange[][]
{
    const results = detectSignatures(inputs);
    expect(results).toHaveLength(inputs.length);
    results.forEach((folds, i) =>
    {
        const body = inputs[i]?.bodyText ?? '';
        const segments = buildSegments(body, folds);
        expect(checkSegments(body, segments)).toEqual([]);
        expect(reconstruct(body, segments)).toBe(body);
        for (const f of folds)
        {
            expect(f.reason).toBe('signature');
            expect(f.related).toBeUndefined();
            expect(f.start).toBeLessThan(f.end);
            const own = inputs[i]?.ownTextEnd;
            const limit = typeof own === 'number' && !Number.isNaN(own) ? Math.min(own, body.length) : body.length;
            expect(f.end).toBeLessThanOrEqual(limit);
        }
    });
    return results;
}

/** The folded text of one message (folds merged, as the segments show it). */
function foldedText(body: string, folds: readonly FoldRange[]): string[]
{
    return buildSegments(body, folds)
        .filter((s) => s.folded)
        .map((s) => body.slice(s.start, s.end));
}

/** Folded pieces of a single message with no sender (only the delimiter rule applies). */
function alone(body: string, ownTextEnd?: number): string[]
{
    const input: SignatureInput = ownTextEnd === undefined ? { bodyText: body, senderKey: '' } : { bodyText: body, senderKey: '', ownTextEnd };
    return foldedText(body, detect([input])[0] ?? []);
}

const BOB_SIG = ['Met vriendelijke groeten,', 'Bob Sample', 'Sample Furniture (fictional company)'];
const BOB_DISCLAIMER = [
    'DISCLAIMER: This e-mail and any attachments are confidential and intended',
    'solely for the addressee. If you have received it in error, please notify',
    'the sender and delete it.',
];
const BOB_TAIL = [...BOB_SIG, '', ...BOB_DISCLAIMER].join('\n');

/** A message by Bob: greeting, new text, then signature and disclaimer. */
function bobMessage(text: string): string
{
    return `Hello Alice,\n\n${text}\n\n${BOB_TAIL}\n`;
}

describe('senderKeyOf', () =>
{
    const base = { from: [], sender: null } as unknown as NormalizedMessage;
    it('uses the first From address, lower-cased', () =>
    {
        const m = { ...base, from: [{ name: 'Bob', address: 'Bob@Furniture.Example.TEST' }, { name: 'A', address: ALICE }] };
        expect(senderKeyOf(m)).toBe(BOB);
    });
    it('falls back to Sender, then to the empty string', () =>
    {
        expect(senderKeyOf({ ...base, sender: { name: 'Bob', address: 'BOB@furniture.example.test' } })).toBe(BOB);
        expect(senderKeyOf({ ...base, from: [{ name: 'Bob', address: '' }], sender: { name: 'B', address: BOB } })).toBe(BOB);
        expect(senderKeyOf(base)).toBe('');
    });
});

describe('detectSignatures: delimiter rule', () =>
{
    it('folds a "-- " signature down to the end of the text, keeping trailing blank lines shown', () =>
    {
        const body = 'Hi Bob,\n\nSee you Thursday.\n\n-- \nAlice Example\nSent from my laptop\n\n';
        expect(alone(body)).toEqual(['-- \nAlice Example\nSent from my laptop\n']);
    });

    it('accepts "--" with several trailing spaces, tabs or nbsp, and CRLF line breaks', () =>
    {
        expect(alone('Text\r\n--  \r\nAlice\r\n')).toEqual(['--  \r\nAlice\r\n']);
        expect(alone('Text\n--\t\nAlice')).toEqual(['--\t\nAlice']);
        expect(alone('Text\n--\u00A0\nAlice\n')).toEqual(['--\u00A0\nAlice\n']);
    });

    it(`caps the fold at MAX_SIGNATURE_LINES (${MAX_SIGNATURE_LINES}) lines; the text after the cap stays shown`, () =>
    {
        const after = Array.from({ length: 20 }, (_, i) => `Line ${i + 1} written after the dashes`);
        const body = ['Intro', '-- ', ...after].join('\n');
        const folded = alone(body);
        expect(folded).toEqual([['-- ', ...after.slice(0, MAX_SIGNATURE_LINES - 1)].join('\n') + '\n']);
        // Exactly MAX lines after the delimiter line minus one: everything folds.
        const short = ['Intro', '-- ', ...after.slice(0, MAX_SIGNATURE_LINES - 1)].join('\n');
        expect(alone(short)).toEqual([['-- ', ...after.slice(0, MAX_SIGNATURE_LINES - 1)].join('\n')]);
    });

    it('folds a bare "--" only when little text follows it', () =>
    {
        expect(alone('Thanks\n--\nAlice Example\nSent from my laptop\n')).toEqual(['--\nAlice Example\nSent from my laptop\n']);
        const prose = ['First part of the story.', '--', ...Array.from({ length: 15 }, (_, i) => `More story ${i}`)].join('\n');
        expect(alone(prose)).toEqual([]);
    });

    it('does not take "---", "----------", indented or quoted dashes as a delimiter', () =>
    {
        expect(alone('Text\n---\nAlice\n')).toEqual([]);
        expect(alone('Text\n----------\nAlice\n')).toEqual([]);
        expect(alone('Text\n -- \nAlice\n')).toEqual([]);
        expect(alone('Text\n> -- \n> Alice\n')).toEqual([]);
        expect(alone('Text\n-- x\nAlice\n')).toEqual([]);
    });

    it('folds nothing when no text follows the delimiter', () =>
    {
        expect(alone('Text\n-- \n\n\n')).toEqual([]);
    });

    it('stops at ownTextEnd: a signature above a quote folds down to the quote start only', () =>
    {
        const own = 'Yes, Thursday works.\n\n-- \nAlice Example\n\n';
        const quote = 'On Mon, Bob Sample <bob@furniture.example.test> wrote:\n> Thursday?\n> Bob\n';
        expect(alone(own + quote, own.length)).toEqual(['-- \nAlice Example\n']);
        // A delimiter that lies inside the quote is ignored.
        const quote2 = '> Hi\n-- \nBob Sample\n';
        expect(alone('My reply\n' + quote2, 'My reply\n'.length)).toEqual([]);
    });

    it('ignores a line that straddles ownTextEnd and clamps bad ownTextEnd values', () =>
    {
        const body = 'Reply\n-- \nAlice Example\n';
        expect(alone(body, body.indexOf('Example'))).toEqual([]); // the name line is cut: not own text
        expect(alone(body, Number.NaN)).toEqual(['-- \nAlice Example\n']);
        expect(alone(body, 1e9)).toEqual(['-- \nAlice Example\n']);
        expect(alone(body, -5)).toEqual([]);
    });
});

describe('detectSignatures: frequency rule', () =>
{
    const bob1 = bobMessage('I can come by on Wednesday at 10:00 to measure the room.');
    const bob2 = bobMessage('Here is the quote for the four desks.\nDelivery takes two weeks.');
    const bob3 = bobMessage('The desks are ready.');

    it("folds Bob's signature and disclaimer in each of his messages, blank line inside included", () =>
    {
        const results = detect([bob1, bob2, bob3].map((b) => ({ bodyText: b, senderKey: BOB })));
        for (const [i, body] of [bob1, bob2, bob3].entries())
        {
            expect(foldedText(body, results[i] ?? [])).toEqual([`${BOB_TAIL}\n`]);
        }
    });

    it('does not count the same block written by a different sender', () =>
    {
        const results = detect([
            { bodyText: bob1, senderKey: BOB },
            { bodyText: bob2, senderKey: ALICE },
        ]);
        expect(results).toEqual([[], []]);
    });

    it('skips the rule for a sender with one message and for unknown senders', () =>
    {
        expect(detect([{ bodyText: bob1, senderKey: BOB }])).toEqual([[]]);
        expect(
            detect([
                { bodyText: bob1, senderKey: '' },
                { bodyText: bob2, senderKey: '' },
            ]),
        ).toEqual([[], []]);
        // The delimiter rule still applies to them.
        const withDashes = 'Hi\n-- \nBob Sample\n';
        const [only] = detect([{ bodyText: withDashes, senderKey: '' }]);
        expect(foldedText(withDashes, only ?? [])).toEqual(['-- \nBob Sample\n']);
    });

    it('does not fold a repeated one-line greeting or closing', () =>
    {
        const a = 'Hi Bob,\n\nThe chairs arrived.\n\nThanks,\n';
        const b = 'Hi Bob,\n\nThe desks arrived too, all in good shape.\n\nThanks,\n';
        expect(detect([a, b].map((t) => ({ bodyText: t, senderKey: ALICE })))).toEqual([[], []]);
    });

    it(`does not fold a repeated block shorter than MIN_BLOCK_CHARS (${MIN_BLOCK_CHARS})`, () =>
    {
        const a = 'The chairs arrived.\nThanks,\nBob\n';
        const b = 'The desks arrived as well.\nThanks,\nBob\n';
        expect(detect([a, b].map((t) => ({ bodyText: t, senderKey: BOB })))).toEqual([[], []]);
        // Long enough: "Best regards," + "Bob Sample" has 22 non-space characters.
        const c = 'The chairs arrived.\nBest regards,\nBob Sample\n';
        const d = 'The desks arrived as well.\nBest regards,\nBob Sample\n';
        const results = detect([c, d].map((t) => ({ bodyText: t, senderKey: BOB })));
        expect(foldedText(c, results[0] ?? [])).toEqual(['Best regards,\nBob Sample\n']);
    });

    it('does not fold a repeated paragraph in the middle of the own text', () =>
    {
        const opening = 'Thank you for contacting Sample Furniture.\nWe answer every question within two days.';
        const make = (text: string): string => `Hello Alice,\n\n${opening}\n\n${text}\n`;
        const a = make('The desk is 160 cm wide.\nIt comes in oak and in white.\nAssembly takes an hour.\nRegards');
        const b = make('The chair has armrests.\nThe fabric is grey.\nWe have twelve in stock.\nRegards');
        expect(detect([a, b].map((t) => ({ bodyText: t, senderKey: BOB })))).toEqual([[], []]);
    });

    it('folds a signature followed by a short P.S., but not a block followed by much new text', () =>
    {
        const ps = `Hello,\n\nThe desks are ready.\n\n${BOB_TAIL}\n\nP.S. Bring the samples.\n`;
        const results = detect([
            { bodyText: ps, senderKey: BOB },
            { bodyText: bob1, senderKey: BOB },
        ]);
        expect(foldedText(ps, results[0] ?? [])).toEqual([`${BOB_TAIL}\n`]);
        const long = `Hello,\n\nShort intro.\n\n${BOB_SIG.join('\n')}\n\nOne\nTwo\nThree\nFour\nFive\nSix\nSeven\n`;
        const r2 = detect([
            { bodyText: long, senderKey: BOB },
            { bodyText: bob1, senderKey: BOB },
        ]);
        expect(r2[0]).toEqual([]);
    });

    it('still matches across whitespace, nbsp and CRLF differences, and decomposed accents', () =>
    {
        const tail2 = 'Met  vriendelijke\u00A0groeten,\r\n  Bob Sample\r\nSample Furniture (fictional company)\t\r\n';
        const a = `Hello,\n\nFirst message.\n\nMet vriendelijke groeten,\nBob Sample\nSample Furniture (fictional company)\n`;
        const b = `Hello,\r\n\r\nSecond message.\r\n\r\n${tail2}`;
        const results = detect([a, b].map((t) => ({ bodyText: t, senderKey: BOB })));
        expect(foldedText(b, results[1] ?? [])).toEqual([tail2]);
        const c = 'Hi\nDone.\nCordialement,\nB\u00E9atrice Exemple, Head office\n';
        const d = 'Hi\nAlso done.\nCordialement,\nBe\u0301atrice Exemple, Head office\n';
        const r2 = detect([c, d].map((t) => ({ bodyText: t, senderKey: 'b@example.test' })));
        expect(r2[1]?.length).toBe(1);
    });

    it('does not match after a slight wording or case change', () =>
    {
        const a = 'First.\nKind regards,\nBob Sample, Sample Furniture\n';
        const b = 'Second.\nKind regards,\nBob Sample, Sample Furniture BV\n';
        const c = 'Third.\nkind regards,\nBob Sample, Sample Furniture\n';
        expect(detect([a, b].map((t) => ({ bodyText: t, senderKey: BOB })))).toEqual([[], []]);
        expect(detect([a, c].map((t) => ({ bodyText: t, senderKey: BOB })))).toEqual([[], []]);
    });

    it('counts a block once per message, and needs it in max(2, 30%) of the sender messages', () =>
    {
        expect([1, 2, 6, 7, 10, 100].map(minRepeat)).toEqual([2, 2, 2, 3, 3, 30]);
        const twice = `Hello,\n\nText.\n\n${BOB_TAIL}\n\n${BOB_TAIL}\n`;
        const other = 'Hello,\n\nSomething else entirely, no signature here.\n';
        // One message holding the block twice is not "repeated in 2 messages".
        expect(detect([twice, other].map((t) => ({ bodyText: t, senderKey: BOB })))).toEqual([[], []]);
        // 2 of 7 messages is below 30% (needs 3): not folded; 3 of 7 is folded.
        const fillers = Array.from({ length: 5 }, (_, i) => `Hello,\n\nShort note number ${i}.\n`);
        const two = detect([bob1, bob2, ...fillers].map((t) => ({ bodyText: t, senderKey: BOB })));
        expect(two[0]).toEqual([]);
        const three = detect([bob1, bob2, bob3, ...fillers.slice(0, 4)].map((t) => ({ bodyText: t, senderKey: BOB })));
        expect(three[0]?.length).toBe(1);
    });

    it('only looks at the own text: a signature inside the quote does not count or fold', () =>
    {
        const own = 'Thanks, noted.\n\n';
        const quoted = `> ${BOB_TAIL.split('\n').join('\n> ')}\n`;
        const reply = own + quoted;
        const results = detect([
            { bodyText: bob1, senderKey: BOB },
            { bodyText: reply, senderKey: BOB, ownTextEnd: own.length },
        ]);
        expect(results).toEqual([[], []]);
        // Signature above the quote: the fold stops at the quote start.
        const above = `Thanks.\n\n${BOB_TAIL}\n\n`;
        const r2 = detect([
            { bodyText: bob1, senderKey: BOB },
            { bodyText: above + bob2, senderKey: BOB, ownTextEnd: above.length },
        ]);
        expect(foldedText(above + bob2, r2[1] ?? [])).toEqual([`${BOB_TAIL}\n`]);
    });
});

describe('detectSignatures: never folds the whole own text (SAFETY)', () =>
{
    const DANA = 'dana@example.test';
    const asDana = (bodies: readonly string[]): FoldRange[][] => detect(bodies.map((t) => ({ bodyText: t, senderKey: DANA })));

    it('does not fold a short reminder sent twice', () =>
    {
        const body = 'Any update on this?\nThanks,\nDana';
        expect(asDana([body, body])).toEqual([[], []]);
    });

    it('does not fold a 4-line note sent twice', () =>
    {
        const body = 'Hi Bob,\nOK for me, thanks.\nBest regards,\nDana Writer';
        expect(asDana([body, body])).toEqual([[], []]);
    });

    it('keeps a repeated 2-line opening of a 3-line mail shown', () =>
    {
        const make = (line: string): string => `Hi Bob,\nThanks for the update.\n${line}`;
        const bodies = [make('The desks can come on Monday.'), make('Please send the invoice.'), make('See you next week.')];
        expect(asDana(bodies)).toEqual([[], [], []]);
    });

    it('keeps a repeated pair shown when more new text follows it than precedes it', () =>
    {
        // A different greeting per message, so the repeated block is lines 1-2
        // (not line 0, which the SAFETY a guard would skip first): it ends in the
        // second half, but after=2 > before=1, so the `after <= before` test keeps it shown.
        const make = (name: string, a: string, b: string): string =>
            `Hi ${name},\nThanks for the update.\nWe agreed on the oak desks.\n${a}\n${b}`;
        const bodies = [
            make('Bob', 'Delivery on Monday.', 'Two boxes.'),
            make('Carol', 'Invoice attached.', 'Pay in May.'),
            make('Erin', 'New chair?', 'Grey.'),
        ];
        expect(asDana(bodies)).toEqual([[], [], []]);
    });

    it('still folds a signature after a single own line, also with a one-line P.S.', () =>
    {
        const a = 'Fine by me.\nBest regards,\nDana Writer\n';
        const b = 'Thursday works.\nBest regards,\nDana Writer\nP.S. Bring the samples.\n';
        const results = asDana([a, b]);
        expect(foldedText(a, results[0] ?? [])).toEqual(['Best regards,\nDana Writer\n']);
        expect(foldedText(b, results[1] ?? [])).toEqual(['Best regards,\nDana Writer\n']);
    });

    it('does not fold 1000 identical 200-line messages', () =>
    {
        const lines = Array.from({ length: 198 }, (_, i) => `Line ${i + 1} of the standard weekly report.`);
        const body = [...lines, 'Best regards,', 'Dana Writer'].join('\n') + '\n';
        const results = detectSignatures(Array.from({ length: 1000 }, () => ({ bodyText: body, senderKey: DANA })));
        expect(results).toHaveLength(1000);
        expect(results.every((f) => f.length === 0)).toBe(true);
    });

    it('does not fold a message that is only a "-- " signature; a later delimiter still counts', () =>
    {
        const only = '-- \nDana Writer\nSales';
        expect(alone(only)).toEqual([]);
        expect(asDana([only, only])).toEqual([[], []]);
        expect(alone('--\nDana Writer\nSales\n')).toEqual([]);
        // Leading blank lines do not matter: the first NON-BLANK own line counts.
        expect(alone('\n\n-- \nDana Writer\n')).toEqual([]);
        // A delimiter on the first line is skipped, a later one still folds.
        expect(alone('-- \nNew text here.\n-- \nDana Writer\n')).toEqual(['-- \nDana Writer\n']);
    });

    it('folds templated lines repeated above the closing (documented known limit, not desired)', () =>
    {
        // Every folded line is repeated verbatim in the other messages, so nothing
        // unique is hidden and the fold can be opened. Pinned so a change shows up.
        const make = (n: number): string => `Hi team,\nDone this week: task ${n}\nStatus: on track\nBlockers: none\nThanks,\nDana\n`;
        const bodies = [1, 2, 3, 4].map(make);
        const results = asDana(bodies);
        bodies.forEach((body, i) =>
        {
            expect(foldedText(body, results[i] ?? [])).toEqual(['Status: on track\nBlockers: none\nThanks,\nDana\n']);
        });
    });
});

describe('detectSignatures: general properties', () =>
{
    it('never throws on bad input and does not modify its input', () =>
    {
        expect(detectSignatures(null as unknown as SignatureInput[])).toEqual([]);
        const bad = [null, { bodyText: 5, senderKey: BOB }, { bodyText: 'x\n-- \ny', senderKey: 7 }] as unknown as SignatureInput[];
        expect(detectSignatures(bad).map((f) => f.length)).toEqual([0, 0, 1]);
        const inputs = Object.freeze([
            Object.freeze({ bodyText: bobMessage('One.'), senderKey: BOB }),
            Object.freeze({ bodyText: bobMessage('Two.'), senderKey: BOB, ownTextEnd: 1000 }),
        ]);
        const copy = JSON.stringify(inputs);
        detect(inputs);
        expect(JSON.stringify(inputs)).toBe(copy);
        expect(detectSignatures([])).toEqual([]);
        expect(detect([{ bodyText: '', senderKey: BOB }])).toEqual([[]]);
    });

    it('gives the same folds per message whatever the input order', () =>
    {
        const bodies = [
            { bodyText: bobMessage('Alpha.'), senderKey: BOB },
            { bodyText: 'Hi\n\nNote.\n\n-- \nAlice Example\n', senderKey: ALICE },
            { bodyText: bobMessage('Beta.\nGamma.'), senderKey: BOB },
            { bodyText: 'Hi\n\nOther note.\n\n-- \nAlice Example\n', senderKey: ALICE },
            { bodyText: bobMessage('Delta.'), senderKey: BOB },
            { bodyText: 'Nothing to see.', senderKey: '' },
        ];
        const base = detect(bodies);
        const order = [4, 2, 5, 0, 3, 1];
        const shuffled = detect(order.map((i) => bodies[i] as SignatureInput));
        order.forEach((original, k) => expect(shuffled[k]).toEqual(base[original]));
    });

    it('runs about linearly: 500 messages from 5 senders, 2 to 5 KB each', () =>
    {
        const senders = ['a', 'b', 'c', 'd', 'e'].map((s) => `${s}@example.test`);
        const inputs: SignatureInput[] = [];
        for (let i = 0; i < 500; i++)
        {
            const sender = senders[i % senders.length] ?? '';
            const paragraphs: string[] = [];
            const words = 300 + ((i * 37) % 450); // about 2 to 5 KB of text
            let line: string[] = [];
            for (let w = 0; w < words; w++)
            {
                line.push(`word${(i * 7919 + w * 104729) % 9973}`);
                if (line.length === 9)
                {
                    paragraphs.push(line.join(' '));
                    line = [];
                }
            }
            paragraphs.push(line.join(' '));
            const sig = `Best regards,\nPerson ${sender}\nExample Company, Department ${i % 5}\n\nDISCLAIMER: confidential message for ${sender} only.\nIf received in error, please delete it.`;
            inputs.push({ bodyText: `Hello,\n\n${paragraphs.join('\n')}\n\n${i % 3 === 0 ? '-- \n' : ''}${sig}\n`, senderKey: sender });
        }
        const t0 = performance.now();
        const results = detectSignatures(inputs);
        const ms = performance.now() - t0;
        const totalKb = inputs.reduce((n, m) => n + m.bodyText.length, 0) / 1024;
        console.log(`signature detection: ${inputs.length} messages, ${totalKb.toFixed(0)} KB in ${ms.toFixed(1)} ms`);
        expect(results.every((f) => f.length > 0)).toBe(true);
        expect(ms).toBeLessThan(2000);
    });
});
