// The "fold, never delete" segment model (README.md, rules R6 and R7).
//
// Detectors (quoted history, `>` quote markers, reply-header blocks,
// signatures) do not cut text out of a message. They only say "fold the code
// units from `start` to `end`, for this reason". This module turns those
// ranges into a list of segments that covers the whole body text, each one
// either shown or folded.
//
// Why offsets: a segment never holds a copy of the text, only two indices
// into the message's original `bodyText`. The text itself is never copied,
// trimmed or rewritten, so it cannot be lost or changed by accident: joining
// the segments back (`joinSegments`) always gives the original body
// (README.md, rule R6: collapse, never delete). `checkSegments` verifies this
// shape and can be used as a runtime safety net.
//
// Offsets are UTF-16 code-unit indices, the same units as `string.length`
// and `string.slice` in JavaScript.
//
// Decisions:
// - Invalid fold ranges never throw and never remove text; at worst they
//   are ignored. See `normalizeFold` for the exact rules.
// - A fold only ever grows when it is adjusted, never shrinks: non-integer
//   ends are rounded outwards, and an end that falls inside an emoji (a
//   surrogate pair, two code units) is moved outwards so the whole emoji is
//   folded. So everything a detector asked to fold is folded.
// - Cost grows with (nested folds x distinct related indices) per segment,
//   which is small for real emails.
//
// Pure functions: no DOM, no storage, inputs are never modified (README.md,
// rule R7).

import type { FoldReason, Segment } from '../../Header/thread-analysis-result';

/** Every known reason, in the order used for sorting `Segment.reasons`. */
export const FOLD_REASONS: readonly FoldReason[] = [
    'quoted-overlap',
    'quote-marker',
    'reply-header',
    'signature',
];

/** What a detector produces: fold code units [start, end) of the body. */
export interface FoldRange
{
    readonly start: number;
    readonly end: number;
    readonly reason: FoldReason;
    /** Optional link to another message, e.g. the index of the message whose text was quoted. */
    readonly related?: number;
}

/** One line of a text: [start, end) includes the line break, [start, contentEnd) excludes it. */
export interface LineRange
{
    readonly start: number;
    readonly contentEnd: number;
    readonly end: number;
}

/** One block for the preview / PDF. The text is always present, even when folded. */
export interface ViewBlock
{
    /** Offsets of the block in the body: [start, end). Also a stable key (e.g. for expand toggles). */
    readonly start: number;
    readonly end: number;
    readonly text: string;
    readonly folded: boolean;
    readonly reasons: readonly FoldReason[];
    /** Linked message indices, as in `Segment.related` (e.g. "quoted from message N"). */
    readonly related: readonly number[];
    /** True when the preview should show this block collapsed (folded and not "unfold all"). */
    readonly collapsed: boolean;
}

const reasonRank = new Map<FoldReason, number>(FOLD_REASONS.map((r, i) => [r, i]));

function isHigh(code: number): boolean
{
    return code >= 0xd800 && code <= 0xdbff;
}

function isLow(code: number): boolean
{
    return code >= 0xdc00 && code <= 0xdfff;
}

/** True when offset `i` falls between the two halves of a surrogate pair (one emoji). */
export function splitsSurrogatePair(text: string, i: number): boolean
{
    return i > 0 && i < text.length && isHigh(text.charCodeAt(i - 1)) && isLow(text.charCodeAt(i));
}

/** A fold after cleaning: integer offsets with 0 <= start < end <= length. */
interface CleanFold
{
    readonly start: number;
    readonly end: number;
    readonly reason: FoldReason;
    readonly related: number | null;
}

/**
 * Cleans one detector range. Rules (never throws):
 * - start or end NaN (or not a number at all), or an unknown reason: ignored.
 * - Non-integers are rounded outwards (start down, end up), so a fold grows
 *   rather than leaving a fraction of what was asked unfolded.
 * - An entry that is not an object (null, undefined, ...): ignored.
 * - Then clamped to [0, length] (so -Infinity / Infinity mean "from the
 *   beginning" / "to the end").
 * - If nothing is left (start >= end, including reversed ranges): ignored.
 *   This is checked before the next step, so an empty fold stays empty.
 * - A boundary inside a surrogate pair moves outwards: start one unit
 *   back, end one unit forward. The emoji is folded whole.
 * - `related` is kept only if it is a non-negative safe integer; otherwise the
 *   fold still applies, without the link.
 */
function normalizeFold(text: string, fold: FoldRange): CleanFold | null
{
    // Runtime guard: an entry that is not an object (null, undefined, a number...) is ignored.
    if (typeof (fold as unknown) !== 'object' || (fold as unknown) === null)
    {
        return null;
    }
    const rawStart: unknown = fold.start;
    const rawEnd: unknown = fold.end;
    if (typeof rawStart !== 'number' || typeof rawEnd !== 'number')
    {
        return null;
    }
    if (Number.isNaN(rawStart) || Number.isNaN(rawEnd))
    {
        return null;
    }
    if (!reasonRank.has(fold.reason))
    {
        return null;
    }
    let start = Math.min(Math.max(Math.floor(rawStart), 0), text.length);
    let end = Math.min(Math.max(Math.ceil(rawEnd), 0), text.length);
    // Empty or reversed before snapping: ignored. Checked here so that an empty
    // fold inside an emoji is not widened into a fold of the whole emoji.
    if (start >= end)
    {
        return null;
    }
    if (splitsSurrogatePair(text, start))
    {
        start -= 1;
    }
    if (splitsSurrogatePair(text, end))
    {
        end += 1;
    }
    if (start >= end)
    {
        return null;
    }
    const rawRelated: unknown = fold.related;
    const related =
        typeof rawRelated === 'number' && Number.isSafeInteger(rawRelated) && rawRelated >= 0
            ? rawRelated
            : null;
    return { start, end, reason: fold.reason, related };
}

function sameList<V>(a: readonly V[], b: readonly V[]): boolean
{
    return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Adds `delta` to the count of `key`, removing the key when it reaches 0. */
function bump<K>(counts: Map<K, number>, key: K, delta: number): void
{
    const next = (counts.get(key) ?? 0) + delta;
    if (next === 0)
    {
        counts.delete(key);
    }
    else
    {
        counts.set(key, next);
    }
}

function addTo(map: Map<number, CleanFold[]>, key: number, fold: CleanFold): void
{
    const list = map.get(key);
    if (list)
    {
        list.push(fold);
    }
    else
    {
        map.set(key, [fold]);
    }
}

/**
 * Splits `text` into segments that cover [0, text.length) with no gap and no
 * overlap. Overlapping folds are split at their boundaries; each piece gets
 * all the reasons and links of the folds covering it; neighbours that end up
 * identical are merged. Empty text gives []. The result does not depend on
 * the order of `folds`. If `folds` is not an array (bad runtime data), it is
 * treated as no folds.
 */
export function buildSegments(text: string, folds: readonly FoldRange[]): Segment[]
{
    if (text.length === 0)
    {
        return [];
    }
    const list: readonly FoldRange[] = Array.isArray(folds) ? folds : [];

    // Sweep line: each fold opens at `start` and closes at `end`. Between two
    // consecutive boundaries the set of covering folds does not change. Counts
    // (not sets) are kept because several folds can share a reason.
    const opens = new Map<number, CleanFold[]>();
    const closes = new Map<number, CleanFold[]>();
    const boundaries = new Set<number>([0, text.length]);
    for (const raw of list)
    {
        const fold = normalizeFold(text, raw);
        if (fold === null)
        {
            continue;
        }
        boundaries.add(fold.start);
        boundaries.add(fold.end);
        addTo(opens, fold.start, fold);
        addTo(closes, fold.end, fold);
    }
    const points = [...boundaries].sort((a, b) => a - b);

    const reasonCounts = new Map<FoldReason, number>();
    const relatedCounts = new Map<number, number>();
    const result: Segment[] = [];
    // `points` is sorted, so each pair (at, next) is one elementary piece.
    for (let i = 0; i + 1 < points.length; i++)
    {
        const point = points[i] ?? 0;
        const next = points[i + 1] ?? text.length;
        for (const fold of closes.get(point) ?? [])
        {
            bump(reasonCounts, fold.reason, -1);
            if (fold.related !== null)
            {
                bump(relatedCounts, fold.related, -1);
            }
        }
        for (const fold of opens.get(point) ?? [])
        {
            bump(reasonCounts, fold.reason, 1);
            if (fold.related !== null)
            {
                bump(relatedCounts, fold.related, 1);
            }
        }
        const reasons = [...reasonCounts.keys()].sort(
            (a, b) => (reasonRank.get(a) ?? 0) - (reasonRank.get(b) ?? 0),
        );
        const related = [...relatedCounts.keys()].sort((a, b) => a - b);
        const segment: Segment = {
            start: point,
            end: next,
            folded: reasons.length > 0,
            reasons,
            related,
        };
        const last = result[result.length - 1];
        if (last && sameList(last.reasons, reasons) && sameList(last.related, related))
        {
            // Same look as the previous piece: extend it instead of adding a new one.
            result[result.length - 1] = { ...last, end: segment.end };
        }
        else
        {
            result.push(segment);
        }
    }
    return result;
}

/** The original text of one segment (a slice, never a modified copy). */
export function segmentText(text: string, segment: Segment): string
{
    return text.slice(segment.start, segment.end);
}

/** Joins all segments back together. For valid segments this always equals `text`. */
export function joinSegments(text: string, segments: readonly Segment[]): string
{
    return segments.map((s) => segmentText(text, s)).join('');
}

/**
 * Checks that `segments` is a valid, canonical cover of `text` (as produced
 * by `buildSegments`). Returns a list of human-readable problems, empty when
 * all is well.
 */
export function checkSegments(text: string, segments: readonly Segment[]): string[]
{
    const problems: string[] = [];
    if (text.length === 0)
    {
        if (segments.length > 0)
        {
            problems.push('empty text must have no segments');
        }
        return problems;
    }
    if (segments.length === 0)
    {
        problems.push('no segments for a non-empty text');
        return problems;
    }
    let expectedStart = 0;
    segments.forEach((segment, i) =>
    {
        const where = `segment ${i} [${segment.start}, ${segment.end})`;
        if (!Number.isInteger(segment.start) || !Number.isInteger(segment.end))
        {
            problems.push(`${where}: offsets must be integers`);
        }
        if (segment.start !== expectedStart)
        {
            problems.push(`${where}: expected to start at ${expectedStart} (gap or overlap)`);
        }
        if (segment.end <= segment.start)
        {
            problems.push(`${where}: empty or reversed`);
        }
        if (segment.end > text.length)
        {
            problems.push(`${where}: ends past the text (${text.length})`);
        }
        if (splitsSurrogatePair(text, segment.start))
        {
            problems.push(`${where}: starts inside a surrogate pair`);
        }
        if (segment.folded !== segment.reasons.length > 0)
        {
            problems.push(`${where}: folded must be true exactly when reasons is not empty`);
        }
        if (segment.reasons.some((r) => !reasonRank.has(r)))
        {
            problems.push(`${where}: unknown reason`);
        }
        const ranks = segment.reasons.map((r) => reasonRank.get(r) ?? -1);
        if (ranks.some((r, k) => k > 0 && r <= (ranks[k - 1] ?? -1)))
        {
            problems.push(`${where}: reasons not sorted and unique`);
        }
        if (segment.related.some((n) => !Number.isSafeInteger(n) || n < 0))
        {
            problems.push(`${where}: related must be non-negative integers`);
        }
        if (segment.related.some((n, k) => k > 0 && n <= (segment.related[k - 1] ?? -1)))
        {
            problems.push(`${where}: related not sorted and unique`);
        }
        if (!segment.folded && segment.related.length > 0)
        {
            problems.push(`${where}: shown segment with related`);
        }
        const prev = segments[i - 1];
        if (prev && sameList(prev.reasons, segment.reasons) && sameList(prev.related, segment.related))
        {
            problems.push(`${where}: identical to the previous segment (should be merged)`);
        }
        expectedStart = segment.end;
    });
    if (expectedStart !== text.length)
    {
        problems.push(`segments end at ${expectedStart}, text length is ${text.length}`);
    }
    return problems;
}

/**
 * The lines of `text`. A line break is "\r\n", a lone "\n" or a lone "\r";
 * it belongs to the line it ends. A final line break does not start an
 * extra empty line, and empty text has no lines. The lines cover the text
 * contiguously, so a range built from them never loses a character.
 */
export function lineRanges(text: string): LineRange[]
{
    const lines: LineRange[] = [];
    let start = 0;
    let i = 0;
    while (i < text.length)
    {
        const code = text.charCodeAt(i);
        if (code === 0x0a || code === 0x0d)
        {
            const contentEnd = i;
            i += code === 0x0d && text.charCodeAt(i + 1) === 0x0a ? 2 : 1;
            lines.push({ start, contentEnd, end: i });
            start = i;
        }
        else
        {
            i++;
        }
    }
    if (start < text.length)
    {
        lines.push({ start, contentEnd: text.length, end: text.length });
    }
    return lines;
}

/**
 * The offsets spanning lines `firstLine` to `lastLine` (both included,
 * 0-based), line breaks included, ready to use in a FoldRange. Returns null
 * when the line numbers are not integers, out of range, or reversed.
 */
export function linesToRange(
    lines: readonly LineRange[],
    firstLine: number,
    lastLine: number,
): { start: number; end: number } | null
{
    if (!Number.isInteger(firstLine) || !Number.isInteger(lastLine))
    {
        return null;
    }
    if (firstLine > lastLine)
    {
        return null;
    }
    const first = lines[firstLine];
    const last = lines[lastLine];
    if (first === undefined || last === undefined)
    {
        return null; // out of range
    }
    return { start: first.start, end: last.end };
}

/**
 * The blocks to display. Every segment becomes one block with its full
 * original text: folded text is never left out, only marked `collapsed` so
 * the preview can grey it out and let the user expand it. With
 * `unfoldAll`, nothing is collapsed, but `folded` and `reasons` are still
 * reported so folded parts can be marked.
 */
export function visibleView(
    text: string,
    segments: readonly Segment[],
    options: { readonly unfoldAll: boolean },
): ViewBlock[]
{
    return segments.map((segment) => ({
        start: segment.start,
        end: segment.end,
        text: segmentText(text, segment),
        folded: segment.folded,
        reasons: segment.reasons,
        related: segment.related,
        collapsed: segment.folded && !options.unfoldAll,
    }));
}
