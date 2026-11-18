// Line breaking: splits the items of one line (shape-text.ts) into lines that fit
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
import { BREAK_AFTER_ITEM, type ShapedText, SOFT_HYPHEN_ITEM, SPACE_ITEM } from './shape-text';

/** LineRange.hyphenAt when the line does not end at a soft hyphen. */
export const NO_SOFT_HYPHEN = -1;

/** One line: items [start, end). */
export interface LineRange
{
    readonly start: number;
    readonly end: number;
    /** The soft hyphen item where the line breaks (a hyphen is drawn after it), or NO_SOFT_HYPHEN. */
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
    const itemCount = text.length;
    const { kind, width } = text;
    const lines: LineRange[] = [];
    if (itemCount === 0)
    {
        return [{ start: 0, end: 0, hyphenAt: NO_SOFT_HYPHEN, width: 0 }];
    }
    const widthLimit = maxWidth + EPSILON;
    let start = 0;
    while (start < itemCount)
    {
        let widthWithSpaces = 0; // width so far, trailing spaces included
        let visibleWidth = 0; // width so far, trailing spaces not included
        let candidateEnd = -1; // the line may end before this item
        let candidateWidth = 0;
        let candidateHyphen = NO_SOFT_HYPHEN;
        let end = itemCount;
        let endWidth = -1;
        let hyphenAt = NO_SOFT_HYPHEN;
        for (let i = start; i < itemCount; i++)
        {
            const itemKind = kind[i]!;
            const itemWidth = width[i]!;
            if ((itemKind & SPACE_ITEM) !== 0)
            {
                widthWithSpaces += itemWidth;
                continue;
            }
            if (i > start && (kind[i - 1]! & SPACE_ITEM) !== 0)
            {
                candidateEnd = i;
                candidateWidth = visibleWidth;
                candidateHyphen = NO_SOFT_HYPHEN;
            }
            if ((itemKind & SOFT_HYPHEN_ITEM) !== 0)
            {
                const widthWithHyphen = widthWithSpaces + hyphenWidth(i);
                if (widthWithHyphen <= widthLimit)
                {
                    candidateEnd = i + 1;
                    candidateWidth = widthWithHyphen;
                    candidateHyphen = i;
                }
                continue;
            }
            if (widthWithSpaces + itemWidth <= widthLimit)
            {
                widthWithSpaces += itemWidth;
                visibleWidth = widthWithSpaces;
                if ((itemKind & BREAK_AFTER_ITEM) !== 0)
                {
                    candidateEnd = i + 1;
                    candidateWidth = visibleWidth;
                    candidateHyphen = NO_SOFT_HYPHEN;
                }
                continue;
            }
            // Item i does not fit.
            if (candidateEnd > start)
            {
                end = candidateEnd;
                endWidth = candidateWidth;
                hyphenAt = candidateHyphen;
            }
            else if (i > start)
            {
                end = i; // no break place: break between items
                endWidth = visibleWidth;
            }
            else
            {
                end = i + 1; // one item wider than the line
                endWidth = itemWidth;
            }
            break;
        }
        if (endWidth < 0)
        {
            endWidth = visibleWidth; // the rest fits
        }
        // Spaces after the break stay on this line (never at the start of the next one).
        // Needed after a single item wider than the line ("[U+1F600] next" in a
        // narrow column); a break after spaces already ends at a non-space.
        while (end < itemCount && (kind[end]! & SPACE_ITEM) !== 0)
        {
            end++;
        }
        lines.push({ start, end, hyphenAt, width: endWidth });
        start = end;
    }
    return lines;
}
