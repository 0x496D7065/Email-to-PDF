// Tests for the "fold, never delete" segment model (README.md, rules R6 and
// R7). Synthetic text only; non-ASCII characters are written as \u escapes.

import { describe, expect, it } from 'vitest';
import {
    FOLD_REASONS,
    buildSegments,
    checkSegments,
    lineRanges,
    linesToRange,
    joinSegments,
    segmentText,
    splitsSurrogatePair,
    visibleView,
    type FoldRange,
} from './fold-segments';
import type { FoldReason, Segment } from '../../Header/thread-analysis-result';

const EMOJI = '\ud83d\ude00'; // one emoji = two UTF-16 code units
const THUMB = '\ud83d\udc4d';

/** Short form of a segment for readable assertions: [start, end, reasons...]. */
function brief(segments: readonly Segment[]): (number | string)[][]
{
    return segments.map((s) => [s.start, s.end, ...s.reasons]);
}

function fold(start: number, end: number, reason: FoldReason, related?: number): FoldRange
{
    return related === undefined ? { start, end, reason } : { start, end, reason, related };
}

describe('buildSegments: basic shape', () =>
{
    it('returns no segments for empty text, even with folds', () =>
    {
        expect(buildSegments('', [])).toEqual([]);
        expect(buildSegments('', [fold(0, 5, 'signature')])).toEqual([]);
    });

    it('returns one shown segment when nothing is folded', () =>
    {
        expect(buildSegments('hello', [])).toEqual([
            { start: 0, end: 5, folded: false, reasons: [], related: [] },
        ]);
    });

    it('folds a middle range and keeps the text around it shown', () =>
    {
        const text = 'abcdefghij';
        const segments = buildSegments(text, [fold(3, 7, 'quote-marker')]);
        expect(brief(segments)).toEqual([[0, 3], [3, 7, 'quote-marker'], [7, 10]]);
        expect(segments[1]!.folded).toBe(true);
        expect(segmentText(text, segments[1]!)).toBe('defg');
        expect(joinSegments(text, segments)).toBe(text);
    });

    it('folds the whole text', () =>
    {
        expect(brief(buildSegments('abc', [fold(0, 3, 'signature')]))).toEqual([[0, 3, 'signature']]);
    });
});

describe('buildSegments: overlapping, nested and adjacent folds', () =>
{
    it('splits overlapping folds and unions their reasons', () =>
    {
        const segments = buildSegments('0123456789', [fold(2, 6, 'quote-marker'), fold(4, 8, 'signature')]);
        expect(brief(segments)).toEqual([
            [0, 2],
            [2, 4, 'quote-marker'],
            [4, 6, 'quote-marker', 'signature'],
            [6, 8, 'signature'],
            [8, 10],
        ]);
    });

    it('handles a nested fold', () =>
    {
        const segments = buildSegments('0123456789', [fold(1, 9, 'quoted-overlap'), fold(3, 5, 'reply-header')]);
        expect(brief(segments)).toEqual([
            [0, 1],
            [1, 3, 'quoted-overlap'],
            [3, 5, 'quoted-overlap', 'reply-header'],
            [5, 9, 'quoted-overlap'],
            [9, 10],
        ]);
    });

    it('merges adjacent folds with the same reason', () =>
    {
        const segments = buildSegments('0123456789', [fold(2, 5, 'quote-marker'), fold(5, 8, 'quote-marker')]);
        expect(brief(segments)).toEqual([[0, 2], [2, 8, 'quote-marker'], [8, 10]]);
    });

    it('keeps adjacent folds with different reasons apart', () =>
    {
        const segments = buildSegments('0123456789', [fold(2, 5, 'reply-header'), fold(5, 8, 'quote-marker')]);
        expect(brief(segments)).toEqual([[0, 2], [2, 5, 'reply-header'], [5, 8, 'quote-marker'], [8, 10]]);
    });

    it('lists a reason once even if several folds give it', () =>
    {
        const segments = buildSegments('0123456789', [fold(0, 6, 'signature'), fold(2, 10, 'signature')]);
        expect(brief(segments)).toEqual([[0, 10, 'signature']]);
    });

    it('sorts reasons in FOLD_REASONS order', () =>
    {
        const reversed = [...FOLD_REASONS].reverse().map((r) => fold(0, 4, r));
        expect(buildSegments('abcd', reversed)[0]!.reasons).toEqual(FOLD_REASONS);
    });

    it('collects related message indices, sorted and unique', () =>
    {
        const segments = buildSegments('0123456789', [
            fold(0, 6, 'quoted-overlap', 3),
            fold(2, 10, 'quoted-overlap', 1),
            fold(4, 5, 'quoted-overlap', 3),
        ]);
        expect(segments.map((s) => [s.start, s.end, s.related])).toEqual([
            [0, 2, [3]],
            [2, 6, [1, 3]],
            [6, 10, [1]],
        ]);
    });

    it('does not depend on the order of the folds', () =>
    {
        const folds = [fold(2, 6, 'quote-marker', 2), fold(4, 8, 'signature'), fold(0, 3, 'reply-header')];
        const expected = buildSegments('0123456789', folds);
        expect(buildSegments('0123456789', [...folds].reverse())).toEqual(expected);
        expect(buildSegments('0123456789', [folds[1]!, folds[2]!, folds[0]!])).toEqual(expected);
    });

    it('never modifies its inputs', () =>
    {
        const folds = [fold(2, 6, 'quote-marker', 1), fold(-3, 2.5, 'signature')];
        const copy = JSON.parse(JSON.stringify(folds)) as unknown;
        const frozen = Object.freeze(folds.map((f) => Object.freeze({ ...f })));
        buildSegments('0123456789', frozen);
        buildSegments('0123456789', folds);
        expect(folds).toEqual(copy);
    });
});

describe('buildSegments: invalid folds are cleaned or ignored, never thrown', () =>
{
    const text = '0123456789';

    it('ignores a fold with NaN', () =>
    {
        expect(brief(buildSegments(text, [fold(NaN, 5, 'signature')]))).toEqual([[0, 10]]);
        expect(brief(buildSegments(text, [fold(2, NaN, 'signature')]))).toEqual([[0, 10]]);
    });

    it('ignores reversed and empty folds', () =>
    {
        expect(brief(buildSegments(text, [fold(6, 2, 'signature'), fold(4, 4, 'signature')]))).toEqual([
            [0, 10],
        ]);
    });

    it('clamps out-of-range ends to the text', () =>
    {
        expect(brief(buildSegments(text, [fold(-5, 3, 'signature')]))).toEqual([[0, 3, 'signature'], [3, 10]]);
        expect(brief(buildSegments(text, [fold(7, 99, 'signature')]))).toEqual([[0, 7], [7, 10, 'signature']]);
        expect(brief(buildSegments(text, [fold(-Infinity, Infinity, 'signature')]))).toEqual([
            [0, 10, 'signature'],
        ]);
    });

    it('ignores a fold entirely outside the text', () =>
    {
        expect(brief(buildSegments(text, [fold(20, 30, 'signature'), fold(-9, -1, 'signature')]))).toEqual([
            [0, 10],
        ]);
    });

    it('rounds non-integer ends outwards (the fold grows)', () =>
    {
        expect(brief(buildSegments(text, [fold(2.5, 4.2, 'signature')]))).toEqual([
            [0, 2],
            [2, 5, 'signature'],
            [5, 10],
        ]);
    });

    it('ignores an unknown reason and non-number offsets (bad runtime data)', () =>
    {
        const bad = [
            { start: 1, end: 3, reason: 'nonsense' },
            { start: '1', end: 3, reason: 'signature' },
            null,
            undefined,
            42,
            'signature',
        ] as unknown as FoldRange[];
        expect(brief(buildSegments(text, bad))).toEqual([[0, 10]]);
        expect(brief(buildSegments(text, [null as unknown as FoldRange, fold(2, 4, 'signature')]))).toEqual([
            [0, 2],
            [2, 4, 'signature'],
            [4, 10],
        ]);
    });

    it('treats a non-array folds argument as no folds', () =>
    {
        for (const notArray of [null, undefined, 7, 'abc', { start: 1, end: 3, reason: 'signature' }])
        {
            expect(brief(buildSegments(text, notArray as unknown as FoldRange[]))).toEqual([[0, 10]]);
        }
    });

    it('keeps the fold but drops an invalid related index', () =>
    {
        const segments = buildSegments(text, [
            fold(0, 3, 'quoted-overlap', -1),
            fold(0, 3, 'quoted-overlap', 1.5),
            fold(0, 3, 'quoted-overlap', NaN),
        ]);
        expect(segments[0]).toEqual({ start: 0, end: 3, folded: true, reasons: ['quoted-overlap'], related: [] });
    });
});

describe('buildSegments: surrogate pairs (emoji) are never split', () =>
{
    // 'a' + emoji + 'b': offsets 0 'a', 1-2 emoji, 3 'b'. Offset 2 is inside the emoji.
    const text = `a${EMOJI}b`;

    it('detects a split position', () =>
    {
        expect(splitsSurrogatePair(text, 1)).toBe(false);
        expect(splitsSurrogatePair(text, 2)).toBe(true);
        expect(splitsSurrogatePair(text, 3)).toBe(false);
    });

    it('moves a start inside an emoji backwards (the emoji is folded)', () =>
    {
        const segments = buildSegments(text, [fold(2, 4, 'signature')]);
        expect(brief(segments)).toEqual([[0, 1], [1, 4, 'signature']]);
        expect(segmentText(text, segments[1]!)).toBe(`${EMOJI}b`);
    });

    it('moves an end inside an emoji forwards (the emoji is folded)', () =>
    {
        const segments = buildSegments(text, [fold(0, 2, 'signature')]);
        expect(brief(segments)).toEqual([[0, 3, 'signature'], [3, 4]]);
        expect(segmentText(text, segments[0]!)).toBe(`a${EMOJI}`);
    });

    it('folds a whole emoji when the fold is only its second half', () =>
    {
        expect(brief(buildSegments(text, [fold(2, 3, 'signature')]))).toEqual([
            [0, 1],
            [1, 3, 'signature'],
            [3, 4],
        ]);
    });

    it('ignores an empty fold inside an emoji (does not widen it into a fold)', () =>
    {
        expect(brief(buildSegments(text, [fold(2, 2, 'signature')]))).toEqual([[0, 4]]);
        expect(brief(buildSegments(text, [fold(2, 1.5, 'signature')]))).toEqual([[0, 4]]);
    });

    it('leaves lone surrogates alone (nothing to keep together)', () =>
    {
        const lone = 'a\ud83db\ude00c';
        expect(brief(buildSegments(lone, [fold(2, 4, 'signature')]))).toEqual([
            [0, 2],
            [2, 4, 'signature'],
            [4, 5],
        ]);
    });
});

describe('checkSegments', () =>
{
    const text = '0123456789';
    const shown = (start: number, end: number): Segment => ({
        start,
        end,
        folded: false,
        reasons: [],
        related: [],
    });
    const folded = (start: number, end: number, reasons: FoldReason[], related: number[] = []): Segment => ({
        start,
        end,
        folded: true,
        reasons,
        related,
    });

    it('accepts what buildSegments produces', () =>
    {
        expect(checkSegments(text, buildSegments(text, [fold(2, 5, 'signature')]))).toEqual([]);
        expect(checkSegments('', [])).toEqual([]);
    });

    it('reports gaps, overlaps, empty segments and wrong coverage', () =>
    {
        expect(checkSegments(text, [shown(0, 4), folded(5, 10, ['signature'])])).not.toEqual([]);
        expect(checkSegments(text, [shown(0, 6), folded(5, 10, ['signature'])])).not.toEqual([]);
        expect(checkSegments(text, [shown(0, 5), folded(5, 5, ['signature']), shown(5, 10)])).not.toEqual([]);
        expect(checkSegments(text, [shown(0, 9)])).not.toEqual([]);
        expect(checkSegments(text, [shown(0, 11)])).not.toEqual([]);
        expect(checkSegments(text, [])).not.toEqual([]);
        expect(checkSegments('', [shown(0, 1)])).not.toEqual([]);
    });

    it('reports a segment boundary inside an emoji', () =>
    {
        const emojiText = `a${EMOJI}b`;
        expect(checkSegments(emojiText, [shown(0, 2), folded(2, 4, ['signature'])])).not.toEqual([]);
    });

    it('reports inconsistent reasons, related and unmerged neighbours', () =>
    {
        expect(checkSegments(text, [{ ...shown(0, 10), folded: true }])).not.toEqual([]);
        expect(checkSegments(text, [{ ...shown(0, 10), reasons: ['signature'] }])).not.toEqual([]);
        expect(checkSegments(text, [folded(0, 10, ['signature', 'quote-marker'])])).not.toEqual([]);
        expect(checkSegments(text, [folded(0, 10, ['signature', 'signature'])])).not.toEqual([]);
        expect(checkSegments(text, [folded(0, 10, ['signature'], [2, 1])])).not.toEqual([]);
        expect(checkSegments(text, [{ ...shown(0, 10), related: [1] }])).not.toEqual([]);
        expect(checkSegments(text, [shown(0, 5), shown(5, 10)])).not.toEqual([]);
    });
});

describe('lineRanges and linesToRange', () =>
{
    it('handles LF, CRLF and lone CR line breaks', () =>
    {
        const text = 'a\nbb\r\nc\rd';
        expect(lineRanges(text)).toEqual([
            { start: 0, contentEnd: 1, end: 2 },
            { start: 2, contentEnd: 4, end: 6 },
            { start: 6, contentEnd: 7, end: 8 },
            { start: 8, contentEnd: 9, end: 9 },
        ]);
    });

    it('keeps empty lines and does not add a line after a final break', () =>
    {
        expect(lineRanges('a\n\nb\n')).toEqual([
            { start: 0, contentEnd: 1, end: 2 },
            { start: 2, contentEnd: 2, end: 3 },
            { start: 3, contentEnd: 4, end: 5 },
        ]);
        expect(lineRanges('')).toEqual([]);
        expect(lineRanges('\r\n')).toEqual([{ start: 0, contentEnd: 0, end: 2 }]);
    });

    it('treats "\\r\\r\\n" as a lone CR then a CRLF', () =>
    {
        expect(lineRanges('\r\r\n')).toEqual([
            { start: 0, contentEnd: 0, end: 1 },
            { start: 1, contentEnd: 1, end: 3 },
        ]);
    });

    it('turns a line span into a fold range', () =>
    {
        const text = 'Hi\n> old\n> older\nBye';
        const lines = lineRanges(text);
        const range = linesToRange(lines, 1, 2);
        expect(range).toEqual({ start: 3, end: 17 });
        if (range === null)
        {
            throw new Error('unreachable');
        }
        const segments = buildSegments(text, [{ ...range, reason: 'quote-marker' }]);
        expect(segments.map((s) => segmentText(text, s))).toEqual(['Hi\n', '> old\n> older\n', 'Bye']);
    });

    it('returns null for invalid line numbers', () =>
    {
        const lines = lineRanges('a\nb\nc');
        expect(linesToRange(lines, -1, 1)).toBeNull();
        expect(linesToRange(lines, 0, 3)).toBeNull();
        expect(linesToRange(lines, 2, 1)).toBeNull();
        expect(linesToRange(lines, 0.5, 1)).toBeNull();
        expect(linesToRange([], 0, 0)).toBeNull();
    });
});

describe('visibleView', () =>
{
    const text = 'Thanks!\n> old text\n';
    const segments = buildSegments(text, [{ start: 8, end: 19, reason: 'quote-marker' }]);

    it('keeps folded text, marked as collapsed', () =>
    {
        expect(visibleView(text, segments, { unfoldAll: false })).toEqual([
            { start: 0, end: 8, text: 'Thanks!\n', folded: false, reasons: [], related: [], collapsed: false },
            {
                start: 8,
                end: 19,
                text: '> old text\n',
                folded: true,
                reasons: ['quote-marker'],
                related: [],
                collapsed: true,
            },
        ]);
    });

    it('carries offsets and related message indices for each block', () =>
    {
        const linked = buildSegments(text, [{ start: 8, end: 19, reason: 'quoted-overlap', related: 2 }]);
        const view = visibleView(text, linked, { unfoldAll: false });
        expect(view.map((b) => [b.start, b.end, b.related])).toEqual([
            [0, 8, []],
            [8, 19, [2]],
        ]);
        for (const block of view)
        {
            expect(text.slice(block.start, block.end)).toBe(block.text);
        }
    });

    it('with unfoldAll, collapses nothing but still reports what is folded', () =>
    {
        const view = visibleView(text, segments, { unfoldAll: true });
        expect(view.map((b) => [b.folded, b.collapsed])).toEqual([
            [false, false],
            [true, false],
        ]);
        expect(view.map((b) => b.text).join('')).toBe(text);
    });
});

// ---------------------------------------------------------------------------
// Property test: thousands of random texts and fold lists, with a fixed seed
// so any failure can be replayed. No extra library: a tiny PRNG is enough.

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

// Text pieces: ASCII, accents, emoji (surrogate pairs), every line-break
// style, quote markers, and (rarely) lone surrogates.
const PIECES = ['a', 'b', 'Z', ' ', '>', '\u00e9', '\u00e8', '\n', '\r\n', '\r', EMOJI, THUMB];
const RARE_PIECES = ['\ud83d', '\ude00'];

function randomText(rand: () => number): string
{
    if (rand() < 0.05)
    {
        return '';
    }
    const count = Math.floor(rand() * 30);
    let text = '';
    for (let i = 0; i < count; i++)
    {
        const pool = rand() < 0.03 ? RARE_PIECES : PIECES;
        text += pool[Math.floor(rand() * pool.length)];
    }
    return text;
}

function randomOffset(rand: () => number, length: number): number
{
    const roll = rand();
    if (roll < 0.03)
    {
        return NaN;
    }
    if (roll < 0.05)
    {
        return rand() < 0.5 ? Infinity : -Infinity;
    }
    const base = Math.floor(rand() * (length + 7)) - 3; // a little out of range on both sides
    return roll < 0.12 ? base + 0.5 : base;
}

function randomFolds(rand: () => number, length: number): FoldRange[]
{
    const count = Math.floor(rand() * 7);
    const folds: FoldRange[] = [];
    for (let i = 0; i < count; i++)
    {
        const reason = FOLD_REASONS[Math.floor(rand() * FOLD_REASONS.length)]!;
        const start = randomOffset(rand, length);
        // Often build adjacent or nested ranges on purpose, from the previous fold.
        const prev = folds[folds.length - 1];
        const end = prev && rand() < 0.2 ? prev.start : randomOffset(rand, length);
        const roll = rand();
        const related = roll < 0.5 ? undefined : roll < 0.9 ? Math.floor(rand() * 4) : [-1, 1.5, NaN][i % 3];
        folds.push(related === undefined ? { start, end, reason } : { start, end, reason, related });
    }
    return folds;
}

/**
 * The expected reasons at every offset, computed the slow, obvious way, one
 * code unit at a time, from the documented rules: ignore NaN, round outwards,
 * clamp, widen past a split surrogate pair, ignore what is left empty.
 */
interface Expected
{
    readonly reasons: Set<FoldReason>[];
    readonly related: Set<number>[];
    /** How many folds had a boundary moved out of an emoji (to prove the generator hits that case). */
    readonly snapped: number;
}

/** Local, independent copy of the "offset inside an emoji" check (not imported from the module). */
const insidePair = (text: string, i: number): boolean =>
    i > 0 && i < text.length && (text.charCodeAt(i - 1) & 0xfc00) === 0xd800 && (text.charCodeAt(i) & 0xfc00) === 0xdc00;

function expectedCover(text: string, folds: readonly FoldRange[]): Expected
{
    const reasons = Array.from({ length: text.length }, () => new Set<FoldReason>());
    const related = Array.from({ length: text.length }, () => new Set<number>());
    let snapped = 0;
    for (const foldRange of folds)
    {
        if (Number.isNaN(foldRange.start) || Number.isNaN(foldRange.end))
        {
            continue;
        }
        let start = Math.min(Math.max(Math.floor(foldRange.start), 0), text.length);
        let end = Math.min(Math.max(Math.ceil(foldRange.end), 0), text.length);
        if (start >= end)
        {
            continue; // empty or reversed: ignored, before any snapping
        }
        const rawStart = start;
        const rawEnd = end;
        if (insidePair(text, start))
        {
            start--;
        }
        if (insidePair(text, end))
        {
            end++;
        }
        // Snapping moves a boundary by at most one unit, outwards.
        expect(rawStart - start).toBeLessThanOrEqual(1);
        expect(end - rawEnd).toBeLessThanOrEqual(1);
        if (start !== rawStart || end !== rawEnd)
        {
            snapped++;
        }
        const link =
            foldRange.related !== undefined && Number.isSafeInteger(foldRange.related) && foldRange.related >= 0 ? foldRange.related : null;
        for (let i = start; i < end; i++)
        {
            reasons[i]!.add(foldRange.reason);
            if (link !== null)
            {
                related[i]!.add(link);
            }
        }
    }
    return { reasons, related, snapped };
}

describe('property test: random texts and folds', () =>
{
    const CASES = 5000;

    it(`holds every invariant for ${CASES} random cases`, () =>
    {
        const rand = mulberry32(0x5e9a3e17);
        let snappedTotal = 0;
        for (let n = 0; n < CASES; n++)
        {
            const text = randomText(rand);
            const folds = randomFolds(rand, text.length);
            const snapshot = JSON.stringify(folds.map((f) => [f.start, f.end, f.reason, f.related]));
            const label = `case ${n}: ${JSON.stringify(text)} ${snapshot}`;

            const segments = buildSegments(text, folds);

            // Valid cover, and the text comes back unchanged.
            expect(checkSegments(text, segments), label).toEqual([]);
            expect(joinSegments(text, segments), label).toBe(text);
            expect(visibleView(text, segments, { unfoldAll: false }).map((b) => b.text).join(''), label).toBe(
                text,
            );

            // Every offset is folded with exactly the reasons of the folds covering it.
            // (Linked message indices follow the same rule.)
            const expected = expectedCover(text, folds);
            snappedTotal += expected.snapped;
            for (const segment of segments)
            {
                for (let i = segment.start; i < segment.end; i++)
                {
                    const want = FOLD_REASONS.filter((r) => expected.reasons[i]!.has(r));
                    expect(segment.reasons, `${label} offset ${i}`).toEqual(want);
                    expect(segment.folded, `${label} offset ${i}`).toBe(want.length > 0);
                    const wantRelated = [...expected.related[i]!].sort((a, b) => a - b);
                    expect(segment.related, `${label} offset ${i}`).toEqual(wantRelated);
                }
            }

            // Same result whatever the fold order.
            const reversed = buildSegments(text, [...folds].reverse());
            expect(reversed, label).toEqual(segments);
            const rotated = folds.length > 1 ? [...folds.slice(1), folds[0]!] : folds;
            expect(buildSegments(text, rotated), label).toEqual(segments);

            // Inputs unchanged.
            expect(JSON.stringify(folds.map((f) => [f.start, f.end, f.reason, f.related])), label).toBe(
                snapshot,
            );
        }
        // The random data really did put fold boundaries inside emoji.
        expect(snappedTotal).toBeGreaterThan(50);
    });
});
