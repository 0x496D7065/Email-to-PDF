// The blocks of one message body as the preview shows them: like
// visibleView (Source/thread-analysis/fold-segments.ts), but with folded parts grouped so the
// reader gets ONE expandable block instead of a row of small fragments.
//
// Rules:
// - Adjacent folded segments become one folded block. Its reasons and links
//   are the union of theirs. Its label is the reason covering the most
//   characters: each folded segment counts its whole length for ONE reason,
//   the thread analysis's primaryReason of its own reasons (Source/thread-analysis/analyze-thread.ts), so
//   a segment folded by several detectors is not counted twice; absorbed
//   whitespace counts for nothing; a tie goes to the reason primaryReason
//   prefers. (A short signature above a long quoted history is then called
//   quoted text, not "signature".)
// - A tiny shown segment made only of whitespace (at most
//   MAX_ABSORBED_WHITESPACE code units, e.g. the blank line between a folded
//   signature and the folded quoted history below it) that sits between two
//   folded segments is absorbed into the folded block. It holds no words, so
//   folding it hides nothing a reader could miss.
// - Everything else stays as it is.
// - Optional `breaks`: offsets where a new block must start (a segment is cut
//   there if needed, each part keeping its reasons and links). The preview
//   uses them so that a folded block is either all in the PDF or all left
//   out of it (Source/web-page-logic/pdf-plan.ts).
//
// Collapse, never delete (README.md, rule R6): blocks only group segments.
// Their texts are slices of the body, so joining all blocks always gives the
// body back unchanged. If the segments are not a valid cover of the body
// (never expected: the thread analysis checks them), the whole body is shown as one
// unfolded block instead of risking a gap.
//
// Pure functions, no DOM (README.md, rule R7).

import { primaryReason } from '../thread-analysis/analyze-thread';
import { checkSegments, FOLD_REASONS } from '../thread-analysis/fold-segments';
import type { DisplayBlock } from '../../Header/pdf-plan';
import type { FoldReason, Segment } from '../../Header/thread-analysis-result';

/**
 * Longest whitespace-only shown segment absorbed between two folded ones: 8
 * code units, enough for two or three blank lines (with Windows line ends)
 * plus stray spaces. Longer gaps stay visible.
 */
export const MAX_ABSORBED_WHITESPACE = 8;

/** A segment, or a part of one cut at a break. */
interface Part
{
    readonly start: number;
    readonly end: number;
    readonly folded: boolean;
    readonly reasons: readonly FoldReason[];
    readonly related: readonly number[];
    /** A block must start here (a break). */
    readonly breakBefore: boolean;
}

/** True for a shown part that may be absorbed between two folded ones. */
function isTinyWhitespace(text: string, part: Part): boolean
{
    return !part.folded && part.end - part.start <= MAX_ABSORBED_WHITESPACE && /^\s+$/.test(text.slice(part.start, part.end));
}

/** The segments cut at every break that falls strictly inside one. */
function cutAtBreaks(segments: readonly Segment[], breaks: readonly number[]): Part[]
{
    const cuts = new Set(breaks);
    const points = [...cuts].sort((a, b) => a - b);
    const parts: Part[] = [];
    let pointIndex = 0;
    for (const segment of segments)
    {
        let from = segment.start;
        while (pointIndex < points.length && (points[pointIndex] ?? 0) <= from)
        {
            pointIndex++;
        }
        while (pointIndex < points.length && (points[pointIndex] ?? 0) < segment.end)
        {
            const at = points[pointIndex] ?? segment.end;
            parts.push({ start: from, end: at, folded: segment.folded, reasons: segment.reasons, related: segment.related, breakBefore: cuts.has(from) });
            from = at;
            pointIndex++;
        }
        parts.push({ start: from, end: segment.end, folded: segment.folded, reasons: segment.reasons, related: segment.related, breakBefore: cuts.has(from) });
    }
    return parts;
}

interface Group
{
    start: number;
    end: number;
    folded: boolean;
    readonly reasons: Set<FoldReason>;
    readonly related: Set<number>;
    /** Characters per reason, each folded segment counted for its primaryReason only. */
    readonly weight: Map<FoldReason, number>;
}

/** The reason with the most characters in `weight`; ties go to primaryReason's choice. */
function labelOf(weight: ReadonlyMap<FoldReason, number>): FoldReason | null
{
    const most = Math.max(0, ...weight.values());
    return primaryReason([...weight].filter(([, n]) => n === most).map(([r]) => r));
}

/** The display blocks of `text` (see the rules at the top of this file). */
export function displayBlocks(
    text: string,
    segments: readonly Segment[],
    options: { readonly unfoldAll: boolean; readonly breaks?: readonly number[] },
): DisplayBlock[]
{
    if (checkSegments(text, segments).length > 0)
    {
        if (text.length === 0)
        {
            return [];
        }
        return [{ start: 0, end: text.length, text, folded: false, reasons: [], related: [], label: null, collapsed: false }];
    }

    const parts = cutAtBreaks(segments, options.breaks ?? []);
    const groups: Group[] = [];
    parts.forEach((part, i) =>
    {
        const last = groups[groups.length - 1];
        const next = parts[i + 1];
        // A folded part joins a folded block; a shown one only if it is tiny
        // whitespace with folded parts on both sides. Never across a break.
        // (Two shown neighbours only occur at a break: valid segments are
        // merged when they look the same.)
        const joinsLast =
            last !== undefined &&
            last.folded &&
            !part.breakBefore &&
            (part.folded || (next?.folded === true && isTinyWhitespace(text, part)));
        if (last !== undefined && joinsLast)
        {
            last.end = part.end;
        }
        else
        {
            groups.push({ start: part.start, end: part.end, folded: part.folded, reasons: new Set(), related: new Set(), weight: new Map() });
        }
        const group = groups[groups.length - 1]!;
        for (const reason of part.reasons)
        {
            group.reasons.add(reason);
        }
        for (const relatedIndex of part.related)
        {
            group.related.add(relatedIndex);
        }
        const primary = part.folded ? primaryReason(part.reasons) : null;
        if (primary !== null)
        {
            group.weight.set(primary, (group.weight.get(primary) ?? 0) + (part.end - part.start));
        }
    });

    return groups.map((group) =>
    {
        const reasons = FOLD_REASONS.filter((r) => group.reasons.has(r));
        return {
            start: group.start,
            end: group.end,
            text: text.slice(group.start, group.end),
            folded: group.folded,
            reasons,
            related: [...group.related].sort((a, b) => a - b),
            label: group.folded ? labelOf(group.weight) : null,
            collapsed: group.folded && !options.unfoldAll,
        };
    });
}
