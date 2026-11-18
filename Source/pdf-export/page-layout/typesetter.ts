// The typesetter: one PdfLine (runs with roles, Source/pdf-export/pdf-text-transforms.ts) in, wrapped
// lines out (wrap), each then drawn at a place as text runs for the backend
// (drawLine). It owns the styles, the shaper and the line breaker.
//
// Line box and baseline: each style's line box is `size x lineHeight` high.
// The font's glyph box is hhea ascender to hhea descender (lineGap ignored;
// it is 0 in IBM Plex) and sits in the middle of the line box (the extra
// space split above and below, as CSS does). A line mixing styles is as
// high as needed for all of them on one shared baseline; the default style
// of the context (body text in a body, a value in a field) always counts,
// so lines keep one even pitch whatever their content (an empty line too).
//
// Runs: one per stretch of items with the same style on a line that draws
// at least one glyph. Each run's glyphText gives the text of each glyph (a
// composed glyph: its NFC text; a placeholder: the characters of
// "[U+XXXX]"); its copyText is the original text of its items (the backend
// writes it as /ActualText when the glyphs say something else,
// Header/laid-out-document.ts). A stretch with no glyph at all (only group 2
// characters, e.g. a line holding only an LRM or a ZWSP, or a ZWSP between
// an emoji's codes and the end of the line) makes no run, so its copy text
// is not written: nothing is seen there, and the copy layer would drop
// those characters anyway (Source/pdf-export/pdf-writer/copy-layer-text.ts).
// "What you copy is what you see": a soft hyphen where the line breaks is
// drawn as "-" and copies as "-"; elsewhere it is not drawn and is not in
// the copy text either. Pure (README.md, rule R7).
import { FontMetrics } from './font-metrics';
import { breakLines, NO_SOFT_HYPHEN } from './line-break';
import { type ResolvedStyle, type ShapedText, Shaper, SOFT_HYPHEN_ITEM, type StyledText } from './shape-text';
import type { LaidOutTextRun, LayoutConfig, TextStyle } from '../../../Header/laid-out-document';
import type { PdfLine, PdfRole } from '../../../Header/pdf-document-model';
import type { ParsedFont, PdfFontName } from '../../../Header/pdf-fonts';

const ROLES: readonly PdfRole[] = ['title', 'heading', 'field-label', 'field-value', 'body', 'muted', 'code'];
const HYPHEN_MINUS = 0x2d;

/** One wrapped line, ready to be drawn. */
export interface LaidLine
{
    readonly shapedText: ShapedText;
    readonly start: number;
    readonly end: number;
    readonly hyphenAt: number;
    /** Drawn width in points (trailing spaces not counted). */
    readonly width: number;
    /** Height of the line box in points. */
    readonly height: number;
    /** From the top of the line box to the baseline. */
    readonly above: number;
}

export class Typesetter
{
    private readonly styles: ResolvedStyle[] = [];
    private readonly roleStyleIndex = new Map<PdfRole, number>();
    private readonly shaper: Shaper;

    constructor(fonts: Readonly<Record<PdfFontName, ParsedFont>>, config: LayoutConfig)
    {
        const metricsByFont = new Map<PdfFontName, FontMetrics>();
        const metricsOf = (name: PdfFontName): FontMetrics =>
        {
            let fontMetrics = metricsByFont.get(name);
            if (fontMetrics === undefined)
            {
                const font = fonts[name];
                if (font === undefined)
                {
                    throw new Error(`layout: font ${name} was not given`);
                }
                fontMetrics = new FontMetrics(font);
                metricsByFont.set(name, fontMetrics);
            }
            return fontMetrics;
        };
        for (const role of ROLES)
        {
            this.roleStyleIndex.set(role, this.addStyle(config.roles[role], metricsOf));
        }
        this.footerStyleIndex = this.addStyle(config.footer.style, metricsOf);
        this.shaper = new Shaper(this.styles, this.styleIndexOf('code'));
    }

    /** The style index of the page footer. */
    readonly footerStyleIndex: number;

    /** Characters drawn as "[U+XXXX]" codes so far (one per code point). */
    get placeholders(): number
    {
        return this.shaper.placeholders;
    }

    private addStyle(style: TextStyle, metricsOf: (name: PdfFontName) => FontMetrics): number
    {
        const fontMetrics = metricsOf(style.font);
        const lineBox = style.size * style.lineHeight;
        const glyphBox = (fontMetrics.ascent - fontMetrics.descent) * style.size;
        const above = (lineBox - glyphBox) / 2 + fontMetrics.ascent * style.size;
        this.styles.push({ style, metrics: fontMetrics, above, below: lineBox - above });
        return this.styles.length - 1;
    }

    styleIndexOf(role: PdfRole): number
    {
        return this.roleStyleIndex.get(role)!;
    }

    /** Height of one line of a role's style alone (an empty line). */
    lineHeight(role: PdfRole): number
    {
        const resolved = this.styles[this.styleIndexOf(role)]!;
        return resolved.above + resolved.below;
    }

    /**
     * The advance of one normal space (U+0020) in a role's font at its size,
     * in points: what a space in that role's text takes on a line (the shaper
     * uses the same advance). An Error when the font has no space glyph.
     */
    spaceWidth(role: PdfRole): number
    {
        const { metrics, style } = this.styles[this.styleIndexOf(role)]!;
        const glyph = metrics.glyph(0x20);
        if (glyph === 0)
        {
            throw new Error(`layout: the font of the ${role} text has no space`);
        }
        return metrics.advance(glyph) * style.size;
    }

    /**
     * Wraps one line to `maxWidth` points. Runs use the style of their role,
     * or the style at `overrideStyleIndex` for all of them when given (the footer). `strut` is the
     * context's role (its line box always counts).
     */
    wrap(line: PdfLine, maxWidth: number, strut: PdfRole, overrideStyleIndex?: number): LaidLine[]
    {
        const runs: StyledText[] = line.map((run) => ({ styleIndex: overrideStyleIndex ?? this.styleIndexOf(run.role), text: run.text }));
        const shaped = this.shaper.shape(runs);
        const strutStyle = this.styles[overrideStyleIndex ?? this.styleIndexOf(strut)]!;
        const ranges = breakLines(shaped, maxWidth, (i) => this.hyphenWidth(shaped.styleIndex[i]!));
        return ranges.map((range) =>
        {
            let above = strutStyle.above;
            let below = strutStyle.below;
            let lastStyleIndex = -1;
            for (let i = range.start; i < range.end; i++)
            {
                const itemStyleIndex = shaped.styleIndex[i]!;
                if (itemStyleIndex === lastStyleIndex)
                {
                    continue;
                }
                lastStyleIndex = itemStyleIndex;
                const resolved = this.styles[itemStyleIndex]!;
                if (resolved.above > above)
                {
                    above = resolved.above;
                }
                if (resolved.below > below)
                {
                    below = resolved.below;
                }
            }
            return {
                shapedText: shaped,
                start: range.start,
                end: range.end,
                hyphenAt: range.hyphenAt,
                width: range.width,
                height: above + below,
                above
            };
        });
    }

    private hyphenWidth(styleIndex: number): number
    {
        const { metrics, style: textStyle } = this.styles[styleIndex]!;
        return metrics.advance(metrics.glyph(HYPHEN_MINUS)) * textStyle.size;
    }

    /** Draws a wrapped line with its left end at `x` and its top at `top`: appends its runs to `runs`. */
    drawLine(line: LaidLine, x: number, top: number, runs: LaidOutTextRun[]): void
    {
        const { shapedText } = line;
        const baseline = top + line.above;
        let runStyleIndex = -1;
        let runX = x;
        let penX = x;
        let glyphs: number[] = [];
        let glyphText: string[] = [];
        let copyText = '';
        const flushRun = (): void =>
        {
            if (glyphs.length > 0)
            {
                const { style } = this.styles[runStyleIndex]!;
                runs.push({ font: style.font, size: style.size, x: runX, y: baseline, color: style.color, glyphs, glyphText, copyText });
            }
            glyphs = [];
            glyphText = [];
            copyText = '';
        };
        for (let i = line.start; i < line.end; i++)
        {
            const itemStyleIndex = shapedText.styleIndex[i]!;
            if (itemStyleIndex !== runStyleIndex)
            {
                flushRun();
                runStyleIndex = itemStyleIndex;
                runX = penX;
            }
            for (let glyphPosition = shapedText.glyphStart(i); glyphPosition < shapedText.glyphEnd[i]!; glyphPosition++)
            {
                glyphs.push(shapedText.glyphs[glyphPosition]!);
                glyphText.push(shapedText.glyphText[glyphPosition]!);
            }
            penX += shapedText.width[i]!;
            if (i === line.hyphenAt && line.hyphenAt !== NO_SOFT_HYPHEN)
            {
                const { metrics } = this.styles[itemStyleIndex]!;
                glyphs.push(metrics.glyph(HYPHEN_MINUS));
                glyphText.push('-');
                copyText += '-';
                penX += this.hyphenWidth(itemStyleIndex);
            }
            else if ((shapedText.kind[i]! & SOFT_HYPHEN_ITEM) === 0)
            {
                // A soft hyphen not at the break is not drawn, so it is not copied either.
                // So "letter + U+00AD + VS16" copies as "letter + VS16": the VS16 now follows
                // the letter and the copy layer keeps it (invisible, stable), unlike
                // copyLayerText on the raw text, which drops a VS16 after a soft hyphen.
                copyText += shapedText.copyText[i]!;
            }
        }
        flushRun();
    }
}
