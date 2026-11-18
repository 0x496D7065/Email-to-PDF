// Tests for quote-marker detection (README.md, rules R6 and R7).
// Synthetic text only; non-ASCII characters are written as \u escapes.

import { describe, expect, it } from 'vitest';
import { MIN_MARKED_LINES, detectQuoteMarkers } from './quote-markers';
import { buildSegments, checkSegments, joinSegments, type FoldRange } from './fold-segments';

/** Runs the detector and checks the result against the segment model. */
function detect(body: string): FoldRange[]
{
    const folds = detectQuoteMarkers(body);
    const segments = buildSegments(body, folds);
    expect(checkSegments(body, segments)).toEqual([]);
    expect(joinSegments(body, segments)).toBe(body);
    for (const fold of folds)
    {
        expect(fold.reason).toBe('quote-marker');
        expect(fold.related).toBeUndefined();
        expect(fold.start).toBeLessThan(fold.end);
    }
    // Sorted, not overlapping.
    folds.forEach((fold, k) =>
    {
        if (k > 0)
        {
            expect(fold.start).toBeGreaterThanOrEqual(folds[k - 1]?.end ?? 0);
        }
    });
    return folds;
}

/** The folded pieces of `body`, one string per fold. */
function folded(body: string): string[]
{
    return detect(body).map((f) => body.slice(f.start, f.end));
}

/** The text that stays shown. */
function shown(body: string): string
{
    return buildSegments(body, detect(body))
        .filter((s) => !s.folded)
        .map((s) => body.slice(s.start, s.end))
        .join('');
}

describe('detectQuoteMarkers', () =>
{
    it('folds the "> " block of a Gmail-style reply, not the "On ... wrote:" line', () =>
    {
        const body = [
            'Hi Bob,',
            '',
            'Wednesday works for me.',
            '',
            'On Mon, 3 Mar 2025 at 10:00, Bob Sample <bob@example.test> wrote:',
            '> Hello Alice,',
            '>',
            '> Can we meet on Wednesday?',
            '> Bob',
            '',
        ].join('\n');
        expect(folded(body)).toEqual(['> Hello Alice,\n>\n> Can we meet on Wednesday?\n> Bob\n']);
        expect(shown(body)).toBe(
            'Hi Bob,\n\nWednesday works for me.\n\nOn Mon, 3 Mar 2025 at 10:00, Bob Sample <bob@example.test> wrote:\n',
        );
    });

    it('handles nested "> >" and ">>" markers as one block', () =>
    {
        const body = 'Reply\n> Level one\n> > Level two\n>> Level two again\n>>> Level three\n> Back\nAfter\n';
        expect(folded(body)).toEqual(['> Level one\n> > Level two\n>> Level two again\n>>> Level three\n> Back\n']);
    });

    it('folds blank lines inside a block and keeps blank lines at its edges shown', () =>
    {
        const body = 'Reply\n\n\n> First\n\n   \n\t\n> Second\n\n\nEnd\n';
        expect(folded(body)).toEqual(['> First\n\n   \n\t\n> Second\n']);
        expect(shown(body)).toBe('Reply\n\n\n\n\nEnd\n');
    });

    it(`keeps a block with fewer than ${MIN_MARKED_LINES} marked lines with text shown`, () =>
    {
        expect(MIN_MARKED_LINES).toBe(2);
        expect(folded('We have\n> 100 units ordered\nso far.\n')).toEqual([]);
        expect(folded('>> see below\n')).toEqual([]);
        // A bare ">" does not count towards the minimum.
        expect(folded('Text\n> One quoted line\n>\n>\nMore\n')).toEqual([]);
        expect(folded('>\n>\n> \n')).toEqual([]);
        // Two lines with text are enough.
        expect(folded('> one\n> two')).toEqual(['> one\n> two']);
    });

    it('folds two separate blocks and keeps the inline replies between them shown', () =>
    {
        const body = [
            'On Tue, Carol Test <carol@example.test> wrote:',
            '> Can you bring the samples?',
            '> Six colours would be fine.',
            'Yes, I will bring them.',
            '> And the price list?',
            '> The new one, please.',
            '',
            'Sure.',
        ].join('\n');
        expect(folded(body)).toEqual([
            '> Can you bring the samples?\n> Six colours would be fine.\n',
            '> And the price list?\n> The new one, please.\n',
        ]);
        expect(shown(body)).toContain('Yes, I will bring them.\n');
        expect(shown(body)).toContain('\nSure.');
    });

    it('ends a block at a line with other text, even after blank lines', () =>
    {
        const body = '> a1\n> a2\n\nInline answer\n\n> b1\n';
        expect(folded(body)).toEqual(['> a1\n> a2\n']);
    });

    it('accepts spaces, tabs, nbsp and a BOM before the marker', () =>
    {
        const body = '  > one\n\t> two\n\u00A0> three\n';
        expect(folded(body)).toEqual([body]);
        const withBom = '\uFEFF> first\n> second\n';
        expect(folded(withBom)).toEqual([withBom]);
    });

    it('does not treat "->", "=>" or "a > b" as marked', () =>
    {
        expect(folded('-> next step\n-> other step\n')).toEqual([]);
        expect(folded('=> result\n=> another\n')).toEqual([]);
        expect(folded('a > b\nc > d\n')).toEqual([]);
        expect(folded('x\n  -> one\n> real\n=> two\n')).toEqual([]);
    });

    it('folds a ">" bullet list of 3 lines (known limitation)', () =>
    {
        // Documented, not desired: the detector cannot tell a ">" bullet list
        // from a quote. The fold is reversible, so no text is lost.
        const body = 'Agenda:\n> budget\n> schedule\n> hiring\nThanks\n';
        expect(folded(body)).toEqual(['> budget\n> schedule\n> hiring\n']);
    });

    it('works with CRLF and lone CR line breaks', () =>
    {
        expect(folded('Reply\r\n> one\r\n\r\n> two\r\nEnd\r\n')).toEqual(['> one\r\n\r\n> two\r\n']);
        expect(folded('Reply\r> one\r> two\rEnd')).toEqual(['> one\r> two\r']);
        expect(folded('Reply\n> one\r\n> two\rEnd')).toEqual(['> one\r\n> two\r']);
    });

    it('handles an empty body, a body of only quotes, and no final newline', () =>
    {
        expect(detect('')).toEqual([]);
        expect(folded('> one\n> two\n')).toEqual(['> one\n> two\n']);
        expect(folded('Reply\n> one\n> two')).toEqual(['> one\n> two']);
        expect(folded('Reply\n> one\n> two\n\n')).toEqual(['> one\n> two\n']);
    });

    it('keeps emoji and non-ASCII text intact', () =>
    {
        const body = 'R\u00E9ponse\n> Merci \uD83D\uDE00\n> \u00C0 bient\u00F4t\n';
        expect(folded(body)).toEqual(['> Merci \uD83D\uDE00\n> \u00C0 bient\u00F4t\n']);
    });

    it('returns [] for non-string input without throwing', () =>
    {
        const badInputs: unknown[] = [null, undefined, 42, {}, ['> a', '> b']];
        for (const bad of badInputs)
        {
            expect(detectQuoteMarkers(bad as string)).toEqual([]);
        }
    });

    it('is deterministic and does not modify its input', () =>
    {
        const body = 'Reply\n> one\n> two\n';
        const copy = body.slice();
        const firstRun = detectQuoteMarkers(body);
        const secondRun = detectQuoteMarkers(body);
        expect(firstRun).toEqual(secondRun);
        expect(firstRun).not.toBe(secondRun);
        expect(body).toBe(copy);
    });

    it('stays linear on a long body', () =>
    {
        const body = '> quoted line\n\n'.repeat(50_000) + 'end';
        const folds = detect(body);
        expect(folds).toHaveLength(1);
        expect(body.slice(folds[0]?.start, folds[0]?.end)).toBe(body.slice(0, body.length - 'end'.length - 1));
    });
});
