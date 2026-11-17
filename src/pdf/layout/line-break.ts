// Line breaking: splits the items of one line (shape.ts) into lines that fit
// a width. Greedy (each line takes as much as fits), linear in the number of
// items (an item is looked at most twice).
//
// Where a line may break:
// - after spaces (before the first non-space after them); the spaces stay at
//   the END of the line they follow, drawn (they are invisible) but not
//   counted in its width, so a line never starts with them;
// - after a ZWSP, "-", "/" or U+2010 (URLs, paths, compound words);
// - at a soft hyphen, when the hyphen drawn there fits too.
// When a piece between break places is wider than the line (a long URL, a
// hash, 1 MB without a space), it is broken between items, at the line end.
// A single item wider than the line (rare: a huge cluster) gets a line of
// its own. Spaces at the start of the text (indentation) are kept. A line
// with no item is one empty line. Pure (README.md, rule R7).
import { BREAK_AFTER, type ShapedText, SOFT_HYPHEN_ITEM, SPACE } from './shape';

/** LineRange.hyphenAt when the line does not end at a soft hyphen. */
export const SHY_NONE = -1;

/** One line: items [start, end). */
export interface LineRange {
    readonly start: number;
    readonly end: number;
    /** The soft hyphen item where the line breaks (a hyphen is drawn after it), or SHY_NONE. */
    readonly hyphenAt: number;
    /** Drawn width: trailing spaces not counted, the hyphen counted. */
    readonly width: number;
}

/** Rounding slack, in points. */
const EPSILON = 1e-6;

/**
 * Breaks items into lines of at most `maxWidth` points. `hyphenWidth(i)` is
 * the width of the hyphen drawn for soft hyphen item i.
 */
export function breakLines(text: ShapedText, maxWidth: number, hyphenWidth: (item: number) => number): LineRange[]
{
    const n = text.length;
    const { kind, width } = text;
    const lines: LineRange[] = [];
    if (n === 0) return [{ start: 0, end: 0, hyphenAt: SHY_NONE, width: 0 }];
    const limit = maxWidth + EPSILON;
    let start = 0;
    while (start < n)
    {
        let x = 0; // width so far, trailing spaces included
        let visible = 0; // width so far, trailing spaces not included
        let candidate = -1; // the line may end before this item
        let candidateWidth = 0;
        let candidateHyphen = SHY_NONE;
        let end = n;
        let endWidth = -1;
        let hyphenAt = SHY_NONE;
        for (let i = start; i < n; i++)
        {
            const k = kind[i]!;
            const w = width[i]!;
            if ((k & SPACE) !== 0)
            {
                x += w;
                continue;
            }
            if (i > start && (kind[i - 1]! & SPACE) !== 0)
            {
                candidate = i;
                candidateWidth = visible;
                candidateHyphen = SHY_NONE;
            }
            if ((k & SOFT_HYPHEN_ITEM) !== 0)
            {
                const withHyphen = x + hyphenWidth(i);
                if (withHyphen <= limit)
                {
                    candidate = i + 1;
                    candidateWidth = withHyphen;
                    candidateHyphen = i;
                }
                continue;
            }
            if (x + w <= limit)
            {
                x += w;
                visible = x;
                if ((k & BREAK_AFTER) !== 0)
                {
                    candidate = i + 1;
                    candidateWidth = visible;
                    candidateHyphen = SHY_NONE;
                }
                continue;
            }
            // Item i does not fit.
            if (candidate > start)
            {
                end = candidate;
                endWidth = candidateWidth;
                hyphenAt = candidateHyphen;
            }
            else if (i > start)
            {
                end = i; // no break place: break between items
                endWidth = visible;
            }
            else
            {
                end = i + 1; // one item wider than the line
                endWidth = w;
            }
            break;
        }
        if (endWidth < 0) endWidth = visible; // the rest fits
        // Spaces after the break stay on this line (never at the start of the next one).
        // Needed after a single item wider than the line ("[U+1F600] next" in a
        // narrow column); a break after spaces already ends at a non-space.
        while (end < n && (kind[end]! & SPACE) !== 0) end++;
        lines.push({ start, end, hyphenAt, width: endWidth });
        start = end;
    }
    return lines;
}
