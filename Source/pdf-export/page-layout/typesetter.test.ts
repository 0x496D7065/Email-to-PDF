// Text to glyphs and line breaking (shape-text.ts, line-break.ts, typesetter.ts)
// with the real IBM Plex fonts. Synthetic text only. Special characters are
// written as braced escapes, so this file stays ASCII.
import { beforeAll, describe, expect, it } from 'vitest';
import { readWoffFont } from '../font-reader/parse-font';
import { PDF_FONTS } from '../bundled-fonts';
import { sanitizeRuns } from '../text';
import { DEFAULT_LAYOUT_CONFIG } from './layout-config';
import { SPACE_ITEM } from './shape-text';
import { type LaidLine, Typesetter } from './typesetter';
import type { LaidOutTextRun } from '../../../Header/laid-out-document';
import type { PdfLine, PdfRole } from '../../../Header/pdf-document-model';
import type { ParsedFont, PdfFontName } from '../../../Header/pdf-fonts';

const fonts = {} as Record<PdfFontName, ParsedFont>;
beforeAll(async () =>
{
    for (const name of Object.keys(PDF_FONTS) as PdfFontName[])
    {
        fonts[name] = await readWoffFont(PDF_FONTS[name]);
    }
});

const BODY = DEFAULT_LAYOUT_CONFIG.roles.body;
const WIDE = 1e6;

/** Width of a text in the body style, one glyph per code point (as the layout measures plain text). */
function bodyWidth(text: string): number
{
    const font = fonts[BODY.font];
    return (font.measure(text) * BODY.size) / font.unitsPerEm;
}

function drawAll(typesetter: Typesetter, lines: readonly LaidLine[]): LaidOutTextRun[][]
{
    return lines.map((line) =>
    {
        const lineRuns: LaidOutTextRun[] = [];
        typesetter.drawLine(line, 0, 0, lineRuns);
        return lineRuns;
    });
}

/** Wraps one line; per wrapped line: the copy text, the drawn text (glyph texts) and the runs. */
function wrap(line: PdfLine, width = WIDE, strut: PdfRole = 'body')
{
    const typesetter = new Typesetter(fonts, DEFAULT_LAYOUT_CONFIG);
    const lines = typesetter.wrap(line, width, strut);
    const runs = drawAll(typesetter, lines);
    return {
        typesetter,
        lines,
        runs,
        copies: runs.map((lineRuns) => lineRuns.map((run) => run.copyText).join('')),
        drawn: runs.map((lineRuns) => lineRuns.map((run) => run.glyphText.join('')).join('')),
    };
}

const body = (text: string): PdfLine => [{ role: 'body', text }];

/** Drawn extent of a line's runs, from x = 0: trailing space glyphs not counted. */
function extent(runs: readonly LaidOutTextRun[]): number
{
    let right = 0;
    for (const run of runs)
    {
        const font = fonts[run.font];
        let penX = run.x;
        let lastInk = run.x;
        for (const [i, glyph] of run.glyphs.entries())
        {
            penX += (font.advance(glyph) * run.size) / font.unitsPerEm;
            if (run.glyphText[i] !== ' ')
            {
                lastInk = penX;
            }
        }
        if (run.glyphText.some((t) => t !== ' '))
        {
            right = Math.max(right, lastInk);
        }
    }
    return right;
}

const graphemes = (text: string): string[] => [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].map((s) => s.segment);

describe('glyph mapping', () =>
{
    const ACCENTS = '\u{E9} \u{E8} \u{EA} \u{EB} \u{E0} \u{E7} \u{EF} \u{F4} \u{FC} \u{DF} \u{153} \u{20AC} \u{201C} \u{201D} \u{2018} \u{2019} \u{AB} \u{BB} \u{2013} \u{2014} \u{2026} \u{142} \u{151} \u{15F} \u{11F}';

    it.each<PdfRole>(['body', 'heading', 'muted', 'field-label', 'code'])('draws common accents and punctuation with real glyphs (%s)', (role) =>
    {
        const { typesetter, runs, copies } = wrap([{ role, text: ACCENTS }]);
        expect(typesetter.placeholders).toBe(0);
        expect(runs).toHaveLength(1);
        const run = runs[0]![0]!;
        expect(run.font).toBe(DEFAULT_LAYOUT_CONFIG.roles[role].font);
        expect(run.glyphs).toHaveLength([...ACCENTS].length);
        expect(run.glyphs.every((g) => g !== 0)).toBe(true);
        expect(run.glyphText.join('')).toBe(ACCENTS);
        expect(copies[0]).toBe(ACCENTS);
    });

    it('draws "e" + U+0301 with the glyph of U+00E9, copy text keeps both code points', () =>
    {
        const { runs, typesetter } = wrap(body('Caf' + 'e\u{301}'));
        const run = runs[0]![0]!;
        expect(run.glyphs.at(-1)).toBe(fonts['sans-regular'].glyphFor(0xe9));
        expect(run.glyphs).toHaveLength(4);
        expect(run.glyphText.at(-1)).toBe('\u{E9}');
        expect(run.copyText).toBe('Cafe\u{301}');
        expect(typesetter.placeholders).toBe(0);
    });

    it('draws "q" + U+0301 (no composed form) as two glyphs, the mark at its own advance', () =>
    {
        const { runs, lines } = wrap(body('q\u{301}'));
        const run = runs[0]![0]!;
        const font = fonts['sans-regular'];
        expect(run.glyphs).toEqual([font.glyphFor(0x71), font.glyphFor(0x301)]);
        expect(run.glyphs.every((g) => g !== 0)).toBe(true);
        expect(run.glyphText).toEqual(['q', '\u{301}']);
        expect(run.copyText).toBe('q\u{301}');
        expect(lines[0]!.width).toBeCloseTo(bodyWidth('q\u{301}'), 6);
    });

    it('draws an emoji as a placeholder in the code style; its copy text is the emoji', () =>
    {
        const { runs, typesetter } = wrap(body('Hi \u{1F600}!'));
        const line = runs[0]!;
        expect(line.map((r) => r.copyText)).toEqual(['Hi ', '\u{1F600}', '!']);
        const code = line[1]!;
        const style = DEFAULT_LAYOUT_CONFIG.roles.code;
        expect(code).toMatchObject({ font: style.font, size: style.size, color: style.color });
        expect(code.glyphText.join('')).toBe('[U+1F600]');
        expect(code.glyphs.every((g) => g !== 0)).toBe(true);
        expect(typesetter.placeholders).toBe(1);
    });

    it('draws one code per drawn code point of an emoji sequence, skipping ZWJ and VS16', () =>
    {
        const woman = '\u{1F469}\u{200D}\u{1F4BB}';
        const wave = '\u{1F44B}\u{1F3FD}';
        const heart = '\u{2764}\u{FE0F}';
        const { runs, typesetter } = wrap(body(woman + wave + heart));
        const code = runs[0]!;
        expect(code).toHaveLength(1);
        expect(code[0]!.glyphText.join('')).toBe('[U+1F469][U+1F4BB][U+1F44B][U+1F3FD][U+2764]');
        expect(code[0]!.copyText).toBe(woman + wave + heart);
        expect(typesetter.placeholders).toBe(5);
    });

    it('draws group 2 characters as nothing (no glyph, no width), keeping them in the copy text', () =>
    {
        const text = 'a\u{200B}b\u{2060}c\u{FEFF}d\u{200E}e';
        const { runs, lines } = wrap(body(text));
        expect(runs[0]![0]!.glyphText).toEqual(['a', 'b', 'c', 'd', 'e']);
        expect(runs[0]![0]!.copyText).toBe(text);
        expect(lines[0]!.width).toBeCloseTo(bodyWidth('abcde'), 6);
    });

    it('keeps the code style of the codes made by Source/pdf-export/text.ts', () =>
    {
        const { runs } = wrap(sanitizeRuns('bell\u{7}here', 'body').runs);
        const line = runs[0]!;
        expect(line.map((r) => r.copyText)).toEqual(['bell', '[U+0007]', 'here']);
        expect(line[1]!.font).toBe(DEFAULT_LAYOUT_CONFIG.roles.code.font);
        expect(line[1]!.size).toBe(DEFAULT_LAYOUT_CONFIG.roles.code.size);
        expect(line[0]!.font).toBe(BODY.font);
    });

    it('places runs one after the other on one baseline', () =>
    {
        const { runs } = wrap([
            { role: 'field-value', text: 'report.pdf' },
            { role: 'muted', text: ' (12 KB)' },
        ]);
        const [valueRun, mutedRun] = runs[0]!;
        expect(valueRun!.y).toBe(mutedRun!.y);
        const font = fonts['sans-regular'];
        expect(mutedRun!.x).toBeCloseTo((font.measure('report.pdf') * 9.5) / font.unitsPerEm, 6);
    });
});

describe('line breaking', () =>
{
    it('breaks after spaces; the spaces stay at the end of the line, never at the start of the next', () =>
    {
        const { copies, lines } = wrap(body('alpha beta gamma   delta'), bodyWidth('alpha beta g'));
        expect(copies).toEqual(['alpha beta ', 'gamma   ', 'delta']);
        expect(lines[0]!.width).toBeCloseTo(bodyWidth('alpha beta'), 6);
    });

    it('keeps the leading spaces of a line (indentation)', () =>
    {
        const { copies, lines, runs } = wrap(body('    indented text here'), bodyWidth('    indented text'));
        expect(copies).toEqual(['    indented text ', 'here']);
        expect(lines[0]!.width).toBeCloseTo(bodyWidth('    indented text'), 6);
        expect(runs[0]![0]!.x).toBe(0);
    });

    it('breaks at a ZWSP', () =>
    {
        const { copies, drawn } = wrap(body('abcdef\u{200B}ghijkl'), bodyWidth('abcdefgh'));
        expect(copies).toEqual(['abcdef\u{200B}', 'ghijkl']);
        expect(drawn).toEqual(['abcdef', 'ghijkl']);
    });

    it('draws a soft hyphen only where the line breaks there, and copies "-" only there (what you copy is what you see)', () =>
    {
        const word = 'hyphen\u{AD}ation';
        const broken = wrap(body(word), bodyWidth('hyphen-at'));
        expect(broken.drawn).toEqual(['hyphen-', 'ation']);
        expect(broken.copies).toEqual(['hyphen-', 'ation']);
        expect(broken.lines[0]!.width).toBeCloseTo(bodyWidth('hyphen-'), 6);
        const whole = wrap(body(word));
        expect(whole.drawn).toEqual(['hyphenation']);
        expect(whole.copies).toEqual(['hyphenation']);
        // Two soft hyphens, the line breaking at the second: the first copies as nothing.
        const two = wrap(body('hy\u{AD}phen\u{AD}ation'), bodyWidth('hyphen-at'));
        expect(two.drawn).toEqual(['hyphen-', 'ation']);
        expect(two.copies).toEqual(['hyphen-', 'ation']);
    });

    it('does not break at a soft hyphen when the hyphen itself would not fit', () =>
    {
        // "cdef-" does not fit, so the word is broken between characters instead (no hyphen drawn, none copied).
        const { drawn, copies } = wrap(body('cdef\u{AD}gh'), bodyWidth('cdef') + 0.1);
        expect(drawn).toEqual(['cdef', 'gh']);
        expect(copies).toEqual(['cdef', 'gh']);
    });

    it('breaks after "-" and "/"', () =>
    {
        expect(wrap(body('well-known-thing'), bodyWidth('well-know')).copies).toEqual(['well-', 'known-', 'thing']);
        expect(wrap(body('example.test/path/to/file'), bodyWidth('example.test/pa')).copies).toEqual(['example.test/', 'path/to/file']);
        expect(wrap(body('ab/path/to/file'), bodyWidth('ab/path/t')).copies).toEqual(['ab/path/', 'to/file']);
    });

    it('breaks a word longer than the line between characters', () =>
    {
        const word = 'x'.repeat(500);
        const { copies, lines } = wrap(body(word), 100);
        expect(copies.join('')).toBe(word);
        expect(lines.length).toBeGreaterThan(5);
        for (const line of lines)
        {
            expect(line.width).toBeLessThanOrEqual(100 + 1e-6);
        }
        // Greedy: every line but the last is full (one more "x" would not fit).
        for (const line of lines.slice(0, -1))
        {
            expect(line.width + bodyWidth('x')).toBeGreaterThan(100);
        }
    });

    it('keeps the spaces after an item wider than the line on its line, not at the start of the next', () =>
    {
        // The "[U+1F600]" code is wider than 30 pt: a line of its own, with the spaces after it.
        const { copies, drawn } = wrap(body('\u{1F600}  next'), 30);
        expect(copies).toEqual(['\u{1F600}  ', 'next']);
        expect(drawn).toEqual(['[U+1F600]  ', 'next']);
    });

    it('keeps an empty line, with the height of its style', () =>
    {
        const { lines, runs, typesetter } = wrap([]);
        expect(lines).toHaveLength(1);
        expect(lines[0]!.height).toBeCloseTo(BODY.size * BODY.lineHeight, 6);
        expect(lines[0]!.height).toBe(typesetter.lineHeight('body'));
        expect(runs[0]).toEqual([]);
    });

    it('gives the title a line pitch of 20 x 1.3 points', () =>
    {
        const { lines, typesetter } = wrap([], WIDE, 'title');
        expect(typesetter.lineHeight('title')).toBeCloseTo(20 * 1.3, 6);
        expect(lines[0]!.height).toBeCloseTo(20 * 1.3, 6);
    });

    it.each([
        ['emoji ZWJ sequences', '\u{1F469}\u{200D}\u{1F4BB}'],
        ['regional indicator pairs', '\u{1F1FD}\u{1F1FD}'],
        ['skin tones', '\u{1F44B}\u{1F3FD}'],
        ['combining marks (composed)', 'e\u{301}'],
        ['combining marks (not composed)', 'q\u{301}\u{323}'],
        ['a mix', 'a\u{1F600}e\u{301}\u{FE0F}b'],
    ])('never splits a cluster (%s)', (_name, cluster) =>
    {
        const text = cluster.repeat(60);
        const { copies, lines } = wrap(body(text), 60);
        expect(lines.length).toBeGreaterThan(1);
        expect(copies.join('')).toBe(text);
        // Every line holds whole clusters.
        const boundaries = new Set<number>([0]);
        let offset = 0;
        for (const grapheme of graphemes(text))
        {
            boundaries.add((offset += grapheme.length));
        }
        offset = 0;
        for (const copy of copies)
        {
            expect(boundaries.has(offset)).toBe(true);
            offset += copy.length;
        }
    });

    it('never makes a line wider than the column (many texts and widths)', () =>
    {
        let seed = 7;
        const random = (bound: number): number =>
        {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed % bound;
        };
        const words = ['Alice', 'Example', 'desk', 'delivery', 'example.test/a/b', 'well-known', 'hy\u{AD}phen\u{AD}ated', 'e\u{301}t\u{E9}', '\u{1F600}', 'x'.repeat(40), 'zero\u{200B}width'];
        for (let round = 0; round < 60; round++)
        {
            const parts: string[] = [];
            for (let k = 0; k < 30; k++)
            {
                parts.push(words[random(words.length)]!, ' '.repeat(1 + random(3)));
            }
            const width = 40 + random(400);
            const { lines, runs } = wrap(body(parts.join('')), width);
            for (const [i, line] of lines.entries())
            {
                // Only a line holding a single item wider than the column may be wider (here: the "[U+1F600]" code at 40 pt).
                let inked = 0;
                for (let k = line.start; k < line.end; k++)
                {
                    if (line.shapedText.width[k]! > 0 && (line.shapedText.kind[k]! & SPACE_ITEM) === 0)
                    {
                        inked++;
                    }
                }
                if (inked > 1)
                {
                    expect(line.width).toBeLessThanOrEqual(width + 1e-6);
                }
                // The reported width is what is drawn (trailing spaces not counted).
                expect(extent(runs[i]!)).toBeCloseTo(line.width, 4);
            }
        }
    });
});
