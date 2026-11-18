// Fast glyph and width lookups for one parsed font, as the layout needs them
// millions of times: the glyph id of each BMP code point is cached in a
// table (other planes in a map), and every glyph's advance is kept in ems.
// Widths are font units x size / unitsPerEm; no kerning, no shaping (see
// Source/pdf-export/font-reader/parse-font.ts). Pure (README.md, rule R7).
import type { ParsedFont } from '../../../Header/pdf-fonts';

const UNKNOWN_GLYPH = -1;

export class FontMetrics
{
    /** Glyph id per BMP code point, UNKNOWN_GLYPH until looked up. */
    private readonly bmpGlyphs = new Int32Array(0x10000).fill(UNKNOWN_GLYPH);
    private readonly astralGlyphs = new Map<number, number>();
    /** Advance width of each glyph, in ems. */
    private readonly advances: Float64Array;
    /** hhea ascender and descender in ems (descender negative, as stored). */
    readonly ascent: number;
    readonly descent: number;

    constructor(readonly font: ParsedFont)
    {
        this.advances = new Float64Array(font.numGlyphs);
        for (let glyphId = 0; glyphId < font.numGlyphs; glyphId++)
        {
            this.advances[glyphId] = font.advance(glyphId) / font.unitsPerEm;
        }
        this.ascent = font.hhea.ascender / font.unitsPerEm;
        this.descent = font.hhea.descender / font.unitsPerEm;
    }

    /** The glyph id of a code point, 0 (.notdef) when the font has none. */
    glyph(codePoint: number): number
    {
        if (codePoint < 0x10000)
        {
            let glyphId = this.bmpGlyphs[codePoint]!;
            if (glyphId === UNKNOWN_GLYPH)
            {
                glyphId = this.font.glyphFor(codePoint);
                this.bmpGlyphs[codePoint] = glyphId;
            }
            return glyphId;
        }
        let glyphId = this.astralGlyphs.get(codePoint);
        if (glyphId === undefined)
        {
            glyphId = this.font.glyphFor(codePoint);
            this.astralGlyphs.set(codePoint, glyphId);
        }
        return glyphId;
    }

    /** The advance of a glyph, in ems. */
    advance(glyph: number): number
    {
        return this.advances[glyph] ?? 0;
    }
}
