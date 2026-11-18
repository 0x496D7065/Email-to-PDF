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
// - Characters of group 2 (Source/pdf-export/text.ts, DRAWN_AS_NOTHING) get no glyph
//   and no width; they stay in the copy text (the backend's copy layer then
//   keeps or drops them, Source/pdf-export/pdf-writer/copy-text.ts).
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
// No kerning, no ligatures, no bidi (Source/pdf-export/font-reader/parse-font.ts). Pure (README.md,
// rule R7).
import { controlMarker, isDrawnAsNothing, SOFT_HYPHEN, ZERO_WIDTH_SPACE } from '../text';
import type { FontMetrics } from './font-metrics';
import type { TextStyle } from '../../../Header/laid-out-document';

/** Item kinds (bit flags). */
export const SPACE_ITEM = 1;
/** A line may break right after this item (ZWSP, "-", "/"). */
export const BREAK_AFTER_ITEM = 2;
/** A soft hyphen: a line may break after it, and then a hyphen is drawn. */
export const SOFT_HYPHEN_ITEM = 4;
/** One "[U+XXXX]" code drawn for a character the font lacks. */
export const PLACEHOLDER_ITEM = 8;

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
    readonly styleIndex: number[] = [];
    readonly kind: number[] = [];
    /** Width in points. */
    readonly width: number[] = [];
    /** The original text this item stands for when copied ('' for the 2nd and later codes of a cluster). */
    readonly copyText: string[] = [];
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

    addItem(styleIndex: number, kind: number, width: number, copyText: string): void
    {
        this.styleIndex.push(styleIndex);
        this.kind.push(kind);
        this.width.push(width);
        this.copyText.push(copyText);
        this.glyphEnd.push(this.glyphs.length);
    }
}

/** Plain Latin text: every code unit is a grapheme cluster of its own. */
const PLAIN_LATIN = /^[\u{20}-\u{7E}\u{A0}-\u{2FF}]*$/u;

/** Most code points tried for a composed (NFC) form: real base + marks clusters are short. */
const MAX_COMPOSE_CODE_POINTS = 8;

const graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Spaces a line may break after (not U+00A0 / U+2007 / U+202F, the no-break ones). */
function isBreakableSpace(codePoint: number): boolean
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
    readonly styleIndex: number;
    readonly text: string;
}

export class Shaper
{
    /** Characters drawn as a "[U+XXXX]" code so far (one per code point). */
    placeholders = 0;

    constructor(
        private readonly styles: readonly ResolvedStyle[],
        /** The style of placeholders ('code'). */
        private readonly codeStyleIndex: number,
    )
    {
    }

    /** Shapes the runs of one line into items. */
    shape(runs: readonly StyledText[]): ShapedText
    {
        const shaped = new ShapedText();
        for (const run of runs)
        {
            if (run.text === '')
            {
                continue;
            }
            if (PLAIN_LATIN.test(run.text))
            {
                this.shapePlainLatin(shaped, run.styleIndex, run.text);
            }
            else
            {
                for (const { segment } of graphemeSegmenter.segment(run.text))
                {
                    this.shapeCluster(shaped, run.styleIndex, segment);
                }
            }
        }
        return shaped;
    }

    /** The fast path: one code unit per cluster. */
    private shapePlainLatin(shaped: ShapedText, styleIndex: number, text: string): void
    {
        const { metrics, style: textStyle } = this.styles[styleIndex]!;
        const size = textStyle.size;
        for (let i = 0; i < text.length; i++)
        {
            const codePoint = text.charCodeAt(i);
            const character = text[i]!;
            if (codePoint === SOFT_HYPHEN)
            {
                shaped.addItem(styleIndex, SOFT_HYPHEN_ITEM, 0, character);
                continue;
            }
            const glyph = metrics.glyph(codePoint);
            if (glyph === 0)
            {
                this.shapeCluster(shaped, styleIndex, character);
                continue;
            }
            shaped.glyphs.push(glyph);
            shaped.glyphText.push(character);
            shaped.addItem(styleIndex, codePoint === 0x20 ? SPACE_ITEM : isBreakAfter(codePoint) ? BREAK_AFTER_ITEM : 0,
                metrics.advance(glyph) * size, character);
        }
    }

    /** One grapheme cluster (see the top of this file). */
    private shapeCluster(shaped: ShapedText, styleIndex: number, cluster: string): void
    {
        const { metrics, style: textStyle } = this.styles[styleIndex]!;
        const codePoints: number[] = [];
        for (const character of cluster)
        {
            codePoints.push(character.codePointAt(0)!);
        }
        if (codePoints.length === 1 && codePoints[0] === SOFT_HYPHEN)
        {
            shaped.addItem(styleIndex, SOFT_HYPHEN_ITEM, 0, cluster);
            return;
        }
        const drawnCodePoints = codePoints.filter((codePoint) => !isDrawnAsNothing(codePoint));
        if (drawnCodePoints.length === 0)
        {
            shaped.addItem(styleIndex, codePoints[0] === ZERO_WIDTH_SPACE ? BREAK_AFTER_ITEM : 0, 0, cluster);
            return;
        }

        const fontHasAll = drawnCodePoints.every((codePoint) => metrics.glyph(codePoint) !== 0);
        if (drawnCodePoints.length > 1 || !fontHasAll)
        {
            const composed = drawnCodePoints.length <= MAX_COMPOSE_CODE_POINTS ? String.fromCodePoint(...drawnCodePoints).normalize('NFC') : '';
            const composedCodePoint = composed.codePointAt(0);
            if (composedCodePoint !== undefined && composed.length === (composedCodePoint > 0xffff ? 2 : 1) && metrics.glyph(composedCodePoint) !== 0)
            {
                const glyph = metrics.glyph(composedCodePoint);
                shaped.glyphs.push(glyph);
                shaped.glyphText.push(composed);
                shaped.addItem(styleIndex, isBreakAfter(composedCodePoint) ? BREAK_AFTER_ITEM : 0, metrics.advance(glyph) * textStyle.size, cluster);
                return;
            }
        }

        if (fontHasAll)
        {
            let width = 0;
            for (const codePoint of drawnCodePoints)
            {
                const glyph = metrics.glyph(codePoint);
                shaped.glyphs.push(glyph);
                shaped.glyphText.push(String.fromCodePoint(codePoint));
                width += metrics.advance(glyph);
            }
            const kind = drawnCodePoints.length === 1
                ? (isBreakableSpace(drawnCodePoints[0]!) ? SPACE_ITEM : isBreakAfter(drawnCodePoints[0]!) ? BREAK_AFTER_ITEM : 0)
                : 0;
            shaped.addItem(styleIndex, kind, width * textStyle.size, cluster);
            return;
        }

        // Missing glyph: the whole cluster as codes, in the 'code' style.
        const codeStyle = this.styles[this.codeStyleIndex]!;
        for (const [position, codePoint] of drawnCodePoints.entries())
        {
            let width = 0;
            for (const character of controlMarker(codePoint))
            {
                const glyph = codeStyle.metrics.glyph(character.charCodeAt(0));
                shaped.glyphs.push(glyph);
                shaped.glyphText.push(character);
                width += codeStyle.metrics.advance(glyph);
            }
            shaped.addItem(this.codeStyleIndex, PLACEHOLDER_ITEM, width * codeStyle.style.size, position === 0 ? cluster : '');
        }
        this.placeholders += drawnCodePoints.length;
    }
}
