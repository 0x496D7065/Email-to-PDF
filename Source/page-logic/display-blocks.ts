// The blocks of one message body as the preview shows them: like
// visibleView (Source/thread-analysis/segments.ts), but with folded parts grouped so the
// reader gets ONE expandable block instead of a row of small fragments.
//
// Rules:
// - Adjacent folded segments become one folded block. Its reasons and links
//   are the union of theirs. Its label is the reason covering the most
//   characters: each folded segment counts its whole length for ONE reason,
//   the engine's primaryReason of its own reasons (Source/thread-analysis/engine.ts), so
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
//   out of it (Source/page-logic/pdf-plan.ts).
//
// Collapse, never delete (README.md, rule R6): blocks only group segments.
// Their texts are slices of the body, so joining all blocks always gives the
// body back unchanged. If the segments are not a valid cover of the body
// (never expected: the engine checks them), the whole body is shown as one
// unfolded block instead of risking a gap.
//
// Pure functions, no DOM (README.md, rule R7).

import { primaryReason } from '../thread-analysis/engine';
import { checkSegments, FOLD_REASONS } from '../thread-analysis/segments';
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
function isTinyWhitespace(text: string, s: Part): boolean
{
    return !s.folded && s.end - s.start <= MAX_ABSORBED_WHITESPACE && /^\s+$/.test(text.slice(s.start, s.end));
}

/** The segments cut at every break that falls strictly inside one. */
function cutAtBreaks(segments: readonly Segment[], breaks: readonly number[]): Part[]
{
    const cuts = new Set(breaks);
    const points = [...cuts].sort((a, b) => a - b);
    const parts: Part[] = [];
    let c = 0;
    for (const s of segments)
    {
        let from = s.start;
        while (c < points.length && (points[c] ?? 0) <= from)
        {
            c++;
        }
        while (c < points.length && (points[c] ?? 0) < s.end)
        {
            const at = points[c] ?? s.end;
            parts.push({ start: from, end: at, folded: s.folded, reasons: s.reasons, related: s.related, breakBefore: cuts.has(from) });
            from = at;
            c++;
        }
        parts.push({ start: from, end: s.end, folded: s.folded, reasons: s.reasons, related: s.related, breakBefore: cuts.has(from) });
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
    parts.forEach((s, i) =>
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
            !s.breakBefore &&
            (s.folded || (next?.folded === true && isTinyWhitespace(text, s)));
        if (last !== undefined && joinsLast)
        {
            last.end = s.end;
        }
        else
        {
            groups.push({ start: s.start, end: s.end, folded: s.folded, reasons: new Set(), related: new Set(), weight: new Map() });
        }
        const group = groups[groups.length - 1]!;
        for (const r of s.reasons)
        {
            group.reasons.add(r);
        }
        for (const n of s.related)
        {
            group.related.add(n);
        }
        const primary = s.folded ? primaryReason(s.reasons) : null;
        if (primary !== null)
        {
            group.weight.set(primary, (group.weight.get(primary) ?? 0) + (s.end - s.start));
        }
    });

    return groups.map((g) =>
    {
        const reasons = FOLD_REASONS.filter((r) => g.reasons.has(r));
        return {
            start: g.start,
            end: g.end,
            text: text.slice(g.start, g.end),
            folded: g.folded,
            reasons,
            related: [...g.related].sort((a, b) => a - b),
            label: g.folded ? labelOf(g.weight) : null,
            collapsed: g.folded && !options.unfoldAll,
        };
    });
}
