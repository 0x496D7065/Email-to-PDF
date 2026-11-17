// Header: the PDF fonts, by name and as read from the font files. Shared
// types only, no code (README.md, "Where things are").
// pdf-export/font-reader/ reads a ParsedFont; pdf-export/page-layout/
// measures text with it; pdf-export/pdf-writer/ embeds it; the PDF worker
// receives the font bytes by PdfFontName.

/** The four font styles the PDF uses. */
export type PdfFontName = 'sans-regular' | 'sans-bold' | 'sans-italic' | 'mono-regular';

export interface LineMetrics
{
    /** Distance above the baseline (positive). */
    readonly ascender: number;
    /** Distance below the baseline (negative, as stored). */
    readonly descender: number;
    readonly lineGap: number;
}

export interface ParsedFont
{
    /** The sfnt bytes the font was read from, to embed as FontFile2 (not copied). */
    readonly sfnt: Uint8Array;
    /** name ID 6, reduced to characters that are safe in a PDF name (see postScriptNameFor). */
    readonly postScriptName: string;
    readonly unitsPerEm: number;
    readonly numGlyphs: number;
    /** head: the bounding box of all glyphs. */
    readonly bbox: { readonly xMin: number; readonly yMin: number; readonly xMax: number; readonly yMax: number };
    /** hhea ascender / descender / lineGap (what most layout engines use on macOS). */
    readonly hhea: LineMetrics;
    /** OS/2 sTypoAscender / sTypoDescender / sTypoLineGap. */
    readonly typo: LineMetrics;
    /** OS/2 usWinAscent / usWinDescent: the clipping box on Windows (descent positive, as stored). */
    readonly win: { readonly ascent: number; readonly descent: number };
    /** OS/2 fsSelection bit 7 (OS/2 version 4 and later, else false): the typo metrics are the intended line metrics. */
    readonly useTypoMetrics: boolean;
    /** OS/2 sCapHeight and sxHeight (version 2 and later), else null. */
    readonly capHeight: number | null;
    readonly xHeight: number | null;
    readonly os2Version: number;
    /** OS/2 usWeightClass, 100 to 900 (400 regular, 700 bold). */
    readonly weightClass: number;
    /** OS/2 fsType: the embedding permissions, raw bits (0 = installable). */
    readonly fsType: number;
    /** post italicAngle in degrees, counter-clockwise from vertical (negative for a right lean). */
    readonly italicAngle: number;
    readonly underlinePosition: number;
    readonly underlineThickness: number;
    /** post isFixedPitch: every glyph has the same advance (monospaced). */
    readonly isFixedPitch: boolean;
    /** head macStyle bit 1 or OS/2 fsSelection bit 0. */
    readonly isItalic: boolean;
    /** head macStyle bit 0 or OS/2 fsSelection bit 5. */
    readonly isBold: boolean;
    /** Which cmap subtable the lookups use. */
    readonly cmap: { readonly format: 4 | 12; readonly platformId: number; readonly encodingId: number };
    // The four helpers below are closures (no `this`): safe to call detached.
    /** The glyph id for a code point, or 0 (.notdef) when the font has none. */
    readonly glyphFor: (codePoint: number) => number;
    /** True when the font has a glyph (other than .notdef) for the code point. */
    readonly hasGlyph: (codePoint: number) => boolean;
    /** The advance width of a glyph, in font units. Throws a RangeError for an id not in the font. */
    readonly advance: (glyphId: number) => number;
    /** The width of a text in font units: the sum of its code points' advances (no kerning, no shaping). */
    readonly measure: (text: string) => number;
}
