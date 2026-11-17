// Text to glyphs: turns runs of text into "items", one per grapheme cluster
// (a base character with its combining marks, variation selectors, skin
// tones, a whole emoji ZWJ sequence or flag), each with its glyphs, width
// and copy text. A cluster is never split: line breaking (line-break.ts)
// only ever breaks between items.
//
// Rules, per cluster (in the font of its run's style):
// - Clusters come from Intl.Segmenter (granularity 'grapheme'), which
//   browsers, workers and Node all have. Runs of plain Latin text (U+0020
//   to U+007E, U+00A0 to U+02FF: no combining mark, no surrogate) skip it:
//   there every code unit is a cluster of its own.
// - Characters of group 2 (src/pdf/text.ts, DRAWN_AS_NOTHING) get no glyph
//   and no width; they stay in the copy text (the backend's copy layer then
//   keeps or drops them, src/pdf/writer/copy-text.ts).
// - A cluster of one character the font has is drawn with that glyph.
// - A base with combining marks (or a lone character the font lacks) whose
//   NFC form is ONE code point the font has ("e" + U+0301 -> U+00E9) is drawn
//   with that composed glyph; its copy text stays the ORIGINAL code points
//   (NFC is for drawing only, README.md, rule R6). Otherwise, when the font
//   has every character, base and marks are drawn as they are, one glyph
//   each, at their own advance (usually 0 for a mark): the mark may then sit
//   beside the letter instead of on it. Accepted: we do no mark positioning.
// - When the font lacks any (drawn) character of a cluster (emoji, scripts
//   IBM Plex does not cover), the whole cluster is drawn as visible codes in
//   the 'code' style: one "[U+XXXX]" per code point, skipping group 2 (so
//   woman + ZWJ + laptop is "[U+1F469][U+1F4BB]"). Its copy text is the
//   original cluster, so copying gives the emoji back. Each code is an item
//   of its own (only the first carries the copy text), so a very long
//   cluster can still wrap. One font per role: no fallback to another font
//   (the four Plex fonts cover the same Latin set).
// - Soft hyphen (group 3) gets no glyph and no width; the line breaker may
//   break there, and then a "-" is drawn and copied; elsewhere it is neither
//   drawn nor copied (typesetter.ts).
// No kerning, no ligatures, no bidi (src/pdf/font/font.ts). Pure (README.md,
// rule R7).
import { controlMarker, isDrawnAsNothing, SOFT_HYPHEN, ZERO_WIDTH_SPACE } from '../text';
import type { TextStyle } from './config';
import type { FontMetrics } from './font-metrics';

/** Item kinds (bit flags). */
export const SPACE = 1;
/** A line may break right after this item (ZWSP, "-", "/"). */
export const BREAK_AFTER = 2;
/** A soft hyphen: a line may break after it, and then a hyphen is drawn. */
export const SOFT_HYPHEN_ITEM = 4;
/** One "[U+XXXX]" code drawn for a character the font lacks. */
export const PLACEHOLDER = 8;

/** A style with its font metrics and its line box (see typesetter.ts). */
export interface ResolvedStyle
{
    readonly style: TextStyle;
    readonly metrics: FontMetrics;
    /** From the top of the line box to the baseline, in points. */
    readonly above: number;
    /** From the baseline to the bottom of the line box, in points. */
    readonly below: number;
}

/**
 * The items of one line of text, as parallel arrays (millions of them for a
 * big document: no object per item). Item i has the glyphs
 * glyphs[glyphStart(i) .. glyphEnd[i]).
 */
export class ShapedText
{
    readonly style: number[] = [];
    readonly kind: number[] = [];
    /** Width in points. */
    readonly width: number[] = [];
    /** The original text this item stands for when copied ('' for the 2nd and later codes of a cluster). */
    readonly copy: string[] = [];
    readonly glyphEnd: number[] = [];
    readonly glyphs: number[] = [];
    /** The text each glyph stands for (for the font's ToUnicode map). */
    readonly glyphText: string[] = [];

    get length(): number
    {
        return this.kind.length;
    }

    glyphStart(item: number): number
    {
        return item === 0 ? 0 : this.glyphEnd[item - 1]!;
    }

    push(style: number, kind: number, width: number, copy: string): void
    {
        this.style.push(style);
        this.kind.push(kind);
        this.width.push(width);
        this.copy.push(copy);
        this.glyphEnd.push(this.glyphs.length);
    }
}

/** Plain Latin text: every code unit is a grapheme cluster of its own. */
const SIMPLE = /^[\u{20}-\u{7E}\u{A0}-\u{2FF}]*$/u;

/** Most code points tried for a composed (NFC) form: real base + marks clusters are short. */
const MAX_COMPOSE = 8;

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Spaces a line may break after (not U+00A0 / U+2007 / U+202F, the no-break ones). */
function isSpace(codePoint: number): boolean
{
    return (
        codePoint === 0x20 ||
        codePoint === 0x1680 ||
        (codePoint >= 0x2000 && codePoint <= 0x200a && codePoint !== 0x2007) ||
        codePoint === 0x205f ||
        codePoint === 0x3000
    );
}

/** "-", "/" and U+2010 (hyphen): a line may break after them (URLs, paths, compound words). */
function isBreakAfter(codePoint: number): boolean
{
    return codePoint === 0x2d || codePoint === 0x2f || codePoint === 0x2010;
}

/** A run to shape: its text and the index of its style. */
export interface StyledText
{
    readonly style: number;
    readonly text: string;
}

export class Shaper
{
    /** Characters drawn as a "[U+XXXX]" code so far (one per code point). */
    placeholders = 0;

    constructor(
        private readonly styles: readonly ResolvedStyle[],
        /** The style of placeholders ('code'). */
        private readonly codeStyle: number,
    )
    {
    }

    /** Shapes the runs of one line into items. */
    shape(runs: readonly StyledText[]): ShapedText
    {
        const out = new ShapedText();
        for (const run of runs)
        {
            if (run.text === '')
            {
                continue;
            }
            if (SIMPLE.test(run.text))
            {
                this.simple(out, run.style, run.text);
            }
            else
            {
                for (const { segment } of segmenter.segment(run.text))
                {
                    this.cluster(out, run.style, segment);
                }
            }
        }
        return out;
    }

    /** The fast path: one code unit per cluster. */
    private simple(out: ShapedText, style: number, text: string): void
    {
        const { metrics, style: look } = this.styles[style]!;
        const size = look.size;
        for (let i = 0; i < text.length; i++)
        {
            const cp = text.charCodeAt(i);
            const ch = text[i]!;
            if (cp === SOFT_HYPHEN)
            {
                out.push(style, SOFT_HYPHEN_ITEM, 0, ch);
                continue;
            }
            const glyph = metrics.glyph(cp);
            if (glyph === 0)
            {
                this.cluster(out, style, ch);
                continue;
            }
            out.glyphs.push(glyph);
            out.glyphText.push(ch);
            out.push(style, cp === 0x20 ? SPACE : isBreakAfter(cp) ? BREAK_AFTER : 0, metrics.advance(glyph) * size, ch);
        }
    }

    /** One grapheme cluster (see the top of this file). */
    private cluster(out: ShapedText, style: number, cluster: string): void
    {
        const { metrics, style: look } = this.styles[style]!;
        const cps: number[] = [];
        for (const ch of cluster)
        {
            cps.push(ch.codePointAt(0)!);
        }
        if (cps.length === 1 && cps[0] === SOFT_HYPHEN)
        {
            out.push(style, SOFT_HYPHEN_ITEM, 0, cluster);
            return;
        }
        const drawn = cps.filter((cp) => !isDrawnAsNothing(cp));
        if (drawn.length === 0)
        {
            out.push(style, cps[0] === ZERO_WIDTH_SPACE ? BREAK_AFTER : 0, 0, cluster);
            return;
        }

        const hasAll = drawn.every((cp) => metrics.glyph(cp) !== 0);
        if (drawn.length > 1 || !hasAll)
        {
            const composed = drawn.length <= MAX_COMPOSE ? String.fromCodePoint(...drawn).normalize('NFC') : '';
            const cp = composed.codePointAt(0);
            if (cp !== undefined && composed.length === (cp > 0xffff ? 2 : 1) && metrics.glyph(cp) !== 0)
            {
                const glyph = metrics.glyph(cp);
                out.glyphs.push(glyph);
                out.glyphText.push(composed);
                out.push(style, isBreakAfter(cp) ? BREAK_AFTER : 0, metrics.advance(glyph) * look.size, cluster);
                return;
            }
        }

        if (hasAll)
        {
            let width = 0;
            for (const cp of drawn)
            {
                const glyph = metrics.glyph(cp);
                out.glyphs.push(glyph);
                out.glyphText.push(String.fromCodePoint(cp));
                width += metrics.advance(glyph);
            }
            const kind = drawn.length === 1 ? (isSpace(drawn[0]!) ? SPACE : isBreakAfter(drawn[0]!) ? BREAK_AFTER : 0) : 0;
            out.push(style, kind, width * look.size, cluster);
            return;
        }

        // Missing glyph: the whole cluster as codes, in the 'code' style.
        const code = this.styles[this.codeStyle]!;
        for (const [k, cp] of drawn.entries())
        {
            let width = 0;
            for (const ch of controlMarker(cp))
            {
                const glyph = code.metrics.glyph(ch.charCodeAt(0));
                out.glyphs.push(glyph);
                out.glyphText.push(ch);
                width += code.metrics.advance(glyph);
            }
            out.push(this.codeStyle, PLACEHOLDER, width * code.style.size, k === 0 ? cluster : '');
        }
        this.placeholders += drawn.length;
    }
}
