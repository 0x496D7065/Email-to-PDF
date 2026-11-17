// Quote-marker detection (README.md, rules R6 and R7).
//
// Idea: in plain-text mail, quoted lines start with ">" ("> text", nested
// "> > text" or ">> text"). This works in every language and for quotes of
// messages that are NOT in the batch, so it is the fallback after overlap
// detection (overlap.ts), which stays the main quote detector. It only
// produces fold ranges (reason 'quote-marker'); it never changes or removes
// text (README.md, rule R6: collapse, never delete).
//
// The HTML-to-text converter (src/parsing/html-to-text.ts) writes "> " before
// every line inside a <blockquote> (and a bare ">" for a blank line there),
// so HTML quotes that use <blockquote> (Gmail, Apple Mail, Thunderbird) are
// covered by this detector too.
//
// Rules:
// 1. A MARKED line is a line whose first character that is not whitespace
//    is ">". Leading spaces, tabs, nbsp and a byte-order mark are skipped
//    (JavaScript's \s covers all of them). So "-> next", "=> result" and
//    "a > b" are not marked: there the ">" is not the first character.
// 2. Consecutive marked lines form a BLOCK. Blank (whitespace-only) lines
//    lying between two marked lines join the block, so a quote with an empty
//    line in it folds as one piece. Blank lines before the first or after
//    the last marked line stay shown, as does any line with other text
//    (for example an inline reply between two quoted parts).
// 3. A block is folded only when at least MIN_MARKED_LINES of its marked
//    lines carry text after the markers (see there). A bare ">" line does
//    not count, but is folded when its block is.
// 4. A fold covers whole lines, line breaks included (CRLF, LF and lone CR
//    all work, see `lineRanges`), from the first to the last marked line of
//    the block. U+2028 and U+2029 are not line breaks for `lineRanges` (same
//    as the other detectors), so text after one stays on the same line for
//    folding purposes.
//
// Not this detector's job: the "On ... wrote:" line above a quote (the
// reply-header detector handles it) and quotes without markers (overlap).
//
// Known trade-off: single ">" lines stay shown (see MIN_MARKED_LINES); two
// or more ">" lines with text are treated as a quote even when they are not
// (lists written with ">" bullets, pasted shell prompts, "> 18 years old").
// Folding is reversible: the user can expand them and nothing is lost.
//
// Cost: one pass over the lines, linear in the body length.
//
// Pure function: no DOM, no storage, the input is never modified (README.md,
// rule R7).

import { lineRanges, type FoldRange, type LineRange } from './segments';

/**
 * A block needs at least this many marked lines with text to be folded.
 * One line alone is too ambiguous: "> 100 units ordered" or ">> see below"
 * can be a person's own text, while a real quote nearly always spans several
 * lines. So a quote of a single line stays shown (the safe direction).
 */
export const MIN_MARKED_LINES = 2;

/** What a line is, for this detector. */
type LineKind = 'blank' | 'marked-text' | 'marked-bare' | 'other';

/** True for whitespace, including tab, nbsp and the byte-order mark U+FEFF. */
function isSpace(ch: string): boolean
{
    return /\s/.test(ch);
}

/** Classifies the content of one line (line break excluded). */
function classify(text: string, line: LineRange): LineKind
{
    let i = line.start;
    while (i < line.contentEnd && isSpace(text.charAt(i)))
    {
        i++;
    }
    if (i === line.contentEnd)
    {
        return 'blank';
    }
    if (text.charAt(i) !== '>')
    {
        return 'other';
    }
    // Skip the markers and the spaces between them ("> > ", ">>", ">\t>").
    while (i < line.contentEnd && (text.charAt(i) === '>' || isSpace(text.charAt(i))))
    {
        i++;
    }
    return i === line.contentEnd ? 'marked-bare' : 'marked-text';
}

/**
 * Finds the blocks of ">"-quoted lines in `bodyText` and returns one fold
 * per block (reason 'quote-marker', no `related`), sorted by position.
 * Never throws: a non-string input gives [].
 */
export function detectQuoteMarkers(bodyText: string): FoldRange[]
{
    if (typeof (bodyText as unknown) !== 'string')
    {
        return [];
    }
    const lines = lineRanges(bodyText);
    const kinds = lines.map((line) => classify(bodyText, line));
    const folds: FoldRange[] = [];

    let i = 0;
    while (i < lines.length)
    {
        if (kinds[i] !== 'marked-text' && kinds[i] !== 'marked-bare')
        {
            i++;
            continue;
        }
        // A block starts at line i. `last` is its last marked line so far; blank
        // lines after it only join when another marked line follows.
        const first = i;
        let last = i;
        let withText = 0;
        let j = i;
        while (j < lines.length)
        {
            const kind = kinds[j];
            if (kind === 'marked-text' || kind === 'marked-bare')
            {
                if (kind === 'marked-text')
                {
                    withText++;
                }
                last = j;
            }
            else if (kind !== 'blank')
            {
                break; // a line with other text ends the block
            }
            j++;
        }
        if (withText >= MIN_MARKED_LINES)
        {
            const start = lines[first]?.start ?? 0;
            const end = lines[last]?.end ?? bodyText.length;
            folds.push({ start, end, reason: 'quote-marker' });
        }
        // Go on after the last marked line: trailing blank lines are not part
        // of this block and cannot start a new one.
        i = last + 1;
    }
    return folds;
}
