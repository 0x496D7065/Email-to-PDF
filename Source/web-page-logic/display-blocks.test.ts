// Unit tests for the preview's grouped blocks (display-blocks.ts): exact
// cases, a seeded property test in the style of Source/thread-analysis/fold-segments.test.ts,
// and every synthetic fixture through the real engine. The key invariant
// (README.md, rule R6): joining all blocks gives the body back unchanged.

import { describe, expect, it } from 'vitest';
import { parseAllFixtures } from '../../Helper/Test/test-data/parse-all';
import { primaryReason, analyzeThread } from '../thread-analysis/analyze-thread';
import { buildSegments, FOLD_REASONS, type FoldRange } from '../thread-analysis/fold-segments';
import { displayBlocks, MAX_ABSORBED_WHITESPACE } from './display-blocks';
import type { DisplayBlock } from '../../Header/pdf-plan';
import type { Segment } from '../../Header/thread-analysis-result';

const SHOWN = { unfoldAll: false };

/** Compact view of blocks for exact comparisons: [text, folded, reasons, related, label]. */
const brief = (blocks: readonly DisplayBlock[]) => blocks.map((b) => [b.text, b.folded, b.reasons, b.related, b.label]);

describe('displayBlocks: exact cases', () =>
{
    it('empty text gives no blocks', () =>
    {
        expect(displayBlocks('', [], SHOWN)).toEqual([]);
    });

    it('a body without folds is one shown block', () =>
    {
        const text = 'Hello\nBob';
        expect(displayBlocks(text, buildSegments(text, []), SHOWN)).toEqual([
            { start: 0, end: 9, text, folded: false, reasons: [], related: [], label: null, collapsed: false },
        ]);
    });

    it('adjacent folded segments become one block: union of reasons and links, label by most characters', () =>
    {
        const text = 'Own text\n-- \nAlice\n> quoted\n';
        const folds: FoldRange[] = [
            { start: 9, end: 19, reason: 'signature' },
            { start: 19, end: 28, reason: 'quote-marker' },
            { start: 19, end: 28, reason: 'quoted-overlap', related: 4 },
        ];
        const segments = buildSegments(text, folds);
        expect(segments.filter((s) => s.folded)).toHaveLength(2);
        const blocks = displayBlocks(text, segments, SHOWN);
        expect(brief(blocks)).toEqual([
            ['Own text\n', false, [], [], null],
            ['-- \nAlice\n> quoted\n', true, ['quoted-overlap', 'quote-marker', 'signature'], [4], 'signature'],
        ]);
        expect(blocks[1]).toMatchObject({ start: 9, end: 28, collapsed: true });
    });

    it('label: each segment counts once, for its primaryReason; ties go to primaryReason order', () =>
    {
        const blockLabels = (text: string, folds: FoldRange[]) =>
            displayBlocks(text, buildSegments(text, folds), SHOWN).map((b) => [b.label, b.reasons]);
        // A short signature (8) above a longer quote (12, folded as quote-marker
        // and quoted-overlap): the quote names the block.
        const text = '-- \nBob\n> a\n> b\n> c\n';
        const quoted: FoldRange[] = [
            { start: 8, end: 20, reason: 'quote-marker' },
            { start: 8, end: 20, reason: 'quoted-overlap', related: 1 },
        ];
        expect(blockLabels(text, [{ start: 0, end: 8, reason: 'signature' }, ...quoted])).toEqual([
            ['quote-marker', ['quoted-overlap', 'quote-marker', 'signature']],
        ]);
        // The two-reason segment counts 12 for quote-marker only, so 9 more
        // characters of quoted-overlap (9 < 12) do not make quoted-overlap win.
        const overlap = 'abcdefghi> a\n> b\n> c\n';
        expect(
            blockLabels(overlap, [
                { start: 0, end: 9, reason: 'quoted-overlap', related: 1 },
                ...quoted.map((f) => ({ ...f, start: 9, end: 21 })),
            ]),
        ).toEqual([['quote-marker', ['quoted-overlap', 'quote-marker']]]);
        // A tie (8 and 8): primaryReason order, signature first.
        const tie = '-- \nBob\n> a\n> b\n';
        expect(
            blockLabels(tie, [
                { start: 0, end: 8, reason: 'signature' },
                { start: 8, end: 16, reason: 'quote-marker' },
            ]),
        ).toEqual([['signature', ['quote-marker', 'signature']]]);
    });

    it('absorbed whitespace counts for nothing in the label', () =>
    {
        // signature (4) + 8 absorbed spaces + quote-marker (5): quote-marker wins.
        const text = 'Sig!        >abcd';
        const folds: FoldRange[] = [
            { start: 0, end: 4, reason: 'signature' },
            { start: 12, end: 17, reason: 'quote-marker' },
        ];
        expect(displayBlocks(text, buildSegments(text, folds), SHOWN).map((b) => [b.folded, b.label])).toEqual([[true, 'quote-marker']]);
    });

    it('a tiny whitespace-only shown segment between two folded ones is absorbed', () =>
    {
        const text = 'Hi\n-- \nBob\n\nOn Monday Alice wrote:\n> x\n';
        const folds: FoldRange[] = [
            { start: 3, end: 11, reason: 'signature' },
            { start: 12, end: text.length, reason: 'reply-header' },
        ];
        expect(displayBlocks(text, buildSegments(text, folds), SHOWN).map((b) => [b.text, b.folded])).toEqual([
            ['Hi\n', false],
            ['-- \nBob\n\nOn Monday Alice wrote:\n> x\n', true],
        ]);
    });

    it(`whitespace longer than ${MAX_ABSORBED_WHITESPACE} code units, or with any word, stays shown`, () =>
    {
        const long = ' '.repeat(MAX_ABSORBED_WHITESPACE + 1);
        for (const gap of [long, '\n.\n'])
        {
            const text = `AAA${gap}BBB`;
            const folds: FoldRange[] = [
                { start: 0, end: 3, reason: 'quote-marker' },
                { start: 3 + gap.length, end: text.length, reason: 'quote-marker' },
            ];
            expect(displayBlocks(text, buildSegments(text, folds), SHOWN).map((b) => [b.text, b.folded])).toEqual([
                ['AAA', true],
                [gap, false],
                ['BBB', true],
            ]);
        }
        // Exactly at the limit: absorbed.
        const atLimit = '\r\n'.repeat(MAX_ABSORBED_WHITESPACE / 2);
        const text = `AAA${atLimit}BBB`;
        const folds: FoldRange[] = [
            { start: 0, end: 3, reason: 'quote-marker' },
            { start: 3 + atLimit.length, end: text.length, reason: 'quote-marker' },
        ];
        expect(displayBlocks(text, buildSegments(text, folds), SHOWN)).toHaveLength(1);
    });

    it('whitespace at the start or end of a body, next to only one folded segment, stays shown', () =>
    {
        const text = '\nAAA\n';
        const folds: FoldRange[] = [{ start: 1, end: 4, reason: 'signature' }];
        expect(displayBlocks(text, buildSegments(text, folds), SHOWN).map((b) => [b.text, b.folded])).toEqual([
            ['\n', false],
            ['AAA', true],
            ['\n', false],
        ]);
    });

    it('unfoldAll: same blocks, none collapsed, folded and label still reported', () =>
    {
        const text = 'Hi\n> a\n';
        const segments = buildSegments(text, [{ start: 3, end: 7, reason: 'quote-marker' }]);
        const blocks = displayBlocks(text, segments, { unfoldAll: true });
        expect(blocks.map((b) => [b.folded, b.collapsed, b.label])).toEqual([
            [false, false, null],
            [true, false, 'quote-marker'],
        ]);
    });

    it('invalid segments (never expected) show the whole body as one unfolded block', () =>
    {
        const text = 'Hello Bob';
        const gap: Segment[] = [{ start: 0, end: 3, folded: true, reasons: ['signature'], related: [] }];
        expect(displayBlocks(text, gap, SHOWN)).toEqual([
            { start: 0, end: 9, text, folded: false, reasons: [], related: [], label: null, collapsed: false },
        ]);
        expect(displayBlocks('', gap, SHOWN)).toEqual([]);
    });

    it('breaks: a new block starts at each break, cutting a segment if needed; the body stays whole', () =>
    {
        // A signature, a blank line, then a quote: one folded block without breaks.
        const text = 'Own\n-- \nBob\n\n> a\n> b\n';
        const folds: FoldRange[] = [
            { start: 4, end: 12, reason: 'signature' },
            { start: 13, end: 21, reason: 'quote-marker', related: 2 },
        ];
        const segments = buildSegments(text, folds);
        expect(brief(displayBlocks(text, segments, SHOWN))).toEqual([
            ['Own\n', false, [], [], null],
            ['-- \nBob\n\n> a\n> b\n', true, ['quote-marker', 'signature'], [2], 'signature'], // a tie (8 and 8): primaryReason order
        ]);
        // A break where the quote starts: the blank line stays with the signature.
        expect(brief(displayBlocks(text, segments, { unfoldAll: false, breaks: [13] }))).toEqual([
            ['Own\n', false, [], [], null],
            ['-- \nBob\n\n', true, ['signature'], [], 'signature'],
            ['> a\n> b\n', true, ['quote-marker'], [2], 'quote-marker'],
        ]);
        // A break inside a folded segment: both parts keep its reasons and links.
        const inside = displayBlocks(text, segments, { unfoldAll: false, breaks: [17, 17, 0, text.length] });
        expect(brief(inside)).toEqual([
            ['Own\n', false, [], [], null],
            ['-- \nBob\n\n> a\n', true, ['quote-marker', 'signature'], [2], 'signature'],
            ['> b\n', true, ['quote-marker'], [2], 'quote-marker'],
        ]);
        expect(inside.map((b) => b.text).join('')).toBe(text);
        expect(inside.map((b) => [b.start, b.end])).toEqual([
            [0, 4],
            [4, 17],
            [17, 21],
        ]);
        // A break inside shown text: two shown blocks, nothing else changes.
        expect(brief(displayBlocks(text, segments, { unfoldAll: false, breaks: [2] })).slice(0, 2)).toEqual([
            ['Ow', false, [], [], null],
            ['n\n', false, [], [], null],
        ]);
    });
});

// ---------------------------------------------------------------------------
// Property test: random texts and folds with a fixed seed, so any failure can
// be replayed (same approach as Source/thread-analysis/fold-segments.test.ts).

/** mulberry32: a small, well-known seeded random generator returning [0, 1). */
function mulberry32(seed: number): () => number
{
    let a = seed >>> 0;
    return () =>
    {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Whitespace pieces are frequent on purpose, so whitespace-only gaps between
// folds (the absorbed case) occur often. \ud83d\ude00 is an emoji (a surrogate pair).
const PIECES = ['a', 'Z', ' ', ' ', '\n', '\n', '\r\n', '\t', '>', '\u00e9', '\u00a0', '\ud83d\ude00'];

function randomText(rand: () => number): string
{
    if (rand() < 0.05)
    {
        return '';
    }
    const count = Math.floor(rand() * 40);
    let text = '';
    for (let i = 0; i < count; i++)
    {
        text += PIECES[Math.floor(rand() * PIECES.length)];
    }
    return text;
}

function randomFolds(rand: () => number, length: number): FoldRange[]
{
    const count = Math.floor(rand() * 7);
    const folds: FoldRange[] = [];
    for (let i = 0; i < count; i++)
    {
        const reason = FOLD_REASONS[Math.floor(rand() * FOLD_REASONS.length)]!;
        const start = Math.floor(rand() * (length + 1));
        const end = start + Math.floor(rand() * (length - start + 1));
        const related = rand() < 0.5 ? undefined : Math.floor(rand() * 4);
        folds.push(related === undefined ? { start, end, reason } : { start, end, reason, related });
    }
    return folds;
}

/**
 * The label rule, written out independently: per reason, the total length of
 * the folded segments whose primaryReason it is; the largest total wins, ties
 * by primaryReason order. null for a shown block.
 */
function expectedLabel(block: DisplayBlock, inside: readonly Segment[]): string | null
{
    if (!block.folded)
    {
        return null;
    }
    const totals = new Map<string, number>();
    for (const segment of inside)
    {
        if (!segment.folded)
        {
            continue;
        }
        const primary = primaryReason(segment.reasons);
        if (primary !== null)
        {
            totals.set(primary, (totals.get(primary) ?? 0) + segment.end - segment.start);
        }
    }
    const ranked = [...FOLD_REASONS].sort((x, y) =>
    {
        const diff = (totals.get(y) ?? -1) - (totals.get(x) ?? -1);
        return diff !== 0 ? diff : (primaryReason([x, y]) === x ? -1 : 1);
    });
    return totals.size === 0 ? null : ranked[0]!;
}

/** Every invariant of displayBlocks for one body and its segments. */
function checkBlocks(text: string, segments: readonly Segment[], label: string): { absorbed: number; byLength: number }
{
    let absorbed = 0;
    // Blocks whose label differs from primaryReason of the union (the length rule mattered).
    let byLength = 0;
    for (const unfoldAll of [false, true])
    {
        const blocks = displayBlocks(text, segments, { unfoldAll });
        // Nothing lost or changed: the blocks cover the body exactly, in order.
        expect(blocks.map((b) => b.text).join(''), label).toBe(text);
        let at = 0;
        for (const block of blocks)
        {
            expect(block.start, label).toBe(at);
            expect(block.end, label).toBeGreaterThan(block.start);
            expect(block.text, label).toBe(text.slice(block.start, block.end));
            at = block.end;
        }
        expect(at, label).toBe(text.length);
        blocks.forEach((block, i) =>
        {
            // No two folded blocks side by side (they would have been one).
            if (i > 0)
            {
                expect(block.folded && blocks[i - 1]!.folded, label).toBe(false);
            }
            const inside = segments.filter((s) => s.start >= block.start && s.end <= block.end);
            // Blocks only ever group whole segments.
            expect(inside.reduce((n, s) => n + (s.end - s.start), 0), label).toBe(block.end - block.start);
            const wantReasons = FOLD_REASONS.filter((r) => inside.some((s) => s.reasons.includes(r)));
            expect(block.reasons, label).toEqual(wantReasons);
            expect(block.related, label).toEqual([...new Set(inside.flatMap((s) => s.related))].sort((x, y) => x - y));
            expect(block.label, label).toBe(expectedLabel(block, inside));
            if (!unfoldAll && block.label !== primaryReason(wantReasons))
            {
                byLength++;
            }
            expect(block.collapsed, label).toBe(block.folded && !unfoldAll);
            if (!block.folded)
            {
                // A shown block is exactly one shown segment.
                expect(inside.map((s) => s.folded), label).toEqual([false]);
            }
            else
            {
                // A folded block starts and ends with folded segments; any shown
                // segment inside it is tiny whitespace.
                expect(inside[0]?.folded && inside[inside.length - 1]?.folded, label).toBe(true);
                for (const segment of inside.filter((x) => !x.folded))
                {
                    expect(text.slice(segment.start, segment.end), label).toMatch(/^\s+$/);
                    expect(segment.end - segment.start, label).toBeLessThanOrEqual(MAX_ABSORBED_WHITESPACE);
                    if (!unfoldAll)
                    {
                        absorbed++;
                    }
                }
            }
        });
        // Every folded segment ends up in a folded block (folding is never undone).
        for (const segment of segments.filter((x) => x.folded))
        {
            expect(blocks.some((b) => b.folded && b.start <= segment.start && segment.end <= b.end), label).toBe(true);
        }
    }
    return { absorbed, byLength };
}

describe('property test: random texts and folds', () =>
{
    const CASES = 5000;

    it(`holds every invariant for ${CASES} random cases`, () =>
    {
        const rand = mulberry32(0x0d15b10c);
        let absorbed = 0;
        let byLength = 0;
        let merged = 0;
        for (let n = 0; n < CASES; n++)
        {
            const text = randomText(rand);
            const folds = randomFolds(rand, text.length);
            const segments = buildSegments(text, folds);
            const checked = checkBlocks(text, segments, `case ${n}: ${JSON.stringify(text)} ${JSON.stringify(folds)}`);
            absorbed += checked.absorbed;
            byLength += checked.byLength;
            merged += segments.length - displayBlocks(text, segments, SHOWN).length;
        }
        // The random data really did exercise both grouping rules and the label rule.
        expect(absorbed).toBeGreaterThan(100);
        expect(byLength).toBeGreaterThan(100);
        expect(merged).toBeGreaterThan(1000);
    });
});

describe('every synthetic fixture through the real engine', () =>
{
    it('keeps every body complete, and gives one folded block where the engine had several fragments', async () =>
    {
        const messages = await parseAllFixtures();
        const out = analyzeThread(messages.map((message) => ({ ok: true, message })));
        for (const email of out.messages)
        {
            checkBlocks(email.message.bodyText, email.segments, email.message.source.fileName);
        }
        const blocksOf = (file: string): DisplayBlock[] =>
        {
            const email = out.messages.find((x) => x.message.source.fileName === file);
            if (email === undefined)
            {
                throw new Error(`no kept message for ${file}`);
            }
            return displayBlocks(email.message.bodyText, email.segments, SHOWN);
        };
        // msg-04: the engine's signature, 1-char quoted-overlap line break,
        // reply-header and quoted segments become ONE folded block below the
        // shown reply.
        expect(blocksOf('msg-04-chain-3-bob-nl').map((b) => b.folded)).toEqual([false, true]);
        // 11: signature, then a shown "\n", then the quoted history: one block.
        const eleven = blocksOf('eml/11-order-2-bob-outlook-en.eml');
        expect(eleven.map((b) => b.folded)).toEqual([false, true]);
        expect(eleven[1]?.reasons).toEqual(['quoted-overlap', 'reply-header', 'signature']);
        // The short signature does not name the block: the quoted history is longer.
        expect(['quoted-overlap', 'reply-header']).toContain(eleven[1]?.label);
    });
});
