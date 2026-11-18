// Embedding one TrueType font, whole (no subsetting), as a Type0 font with a
// CIDFontType2 descendant: /Encoding /Identity-H (each glyph is drawn by its
// 2-byte glyph id) and /CIDToGIDMap /Identity. Also builds the font's /W
// widths (only the glyphs used) and its ToUnicode CMap (the copy layer, see
// copy-layer-text.ts). Pure apart from deflate (README.md, rule R7).
import { copyLayerText } from './copy-layer-text';
import { throwWriteError, fourHexDigits, pdfInteger, pdfName, pdfNumber, utf16Hex } from './pdf-syntax';
import type { ParsedFont } from '../../../Header/pdf-fonts';

/** fsType bit 1: "restricted license embedding", the font must not be embedded. */
const FS_TYPE_RESTRICTED = 0x0002;

/** Most UTF-16 code units one glyph maps to in ToUnicode (a CMap allows 512 bytes); longer texts use /ActualText. */
const MAX_GLYPH_TEXT_UNITS = 256;

/** Entries per bfchar / bfrange block (the CMap format's limit). */
const CMAP_BLOCK_SIZE = 100;

/** What the document uses of one font: glyphs, and the text each stands for (first one wins). */
export class FontUsage
{
    readonly glyphs = new Set<number>();
    readonly toUnicode = new Map<number, string>();

    constructor(
        readonly font: ParsedFont,
        readonly resourceName: string,
    )
    {
    }

    /** Records a glyph and, if it has none yet, the copy-layer text it stands for. */
    recordGlyph(glyph: number, text: string): void
    {
        if (!Number.isInteger(glyph) || glyph < 0 || glyph >= this.font.numGlyphs)
        {
            throwWriteError(`glyph id ${String(glyph)} is not in font ${this.font.postScriptName} (0 to ${this.font.numGlyphs - 1})`);
        }
        this.glyphs.add(glyph);
        if (this.toUnicode.has(glyph))
        {
            return;
        }
        const copyText = copyLayerText(text);
        if (copyText !== '' && copyText.length <= MAX_GLYPH_TEXT_UNITS)
        {
            this.toUnicode.set(glyph, copyText);
        }
    }

    /** What a reader gets from ToUnicode for these glyphs. */
    toUnicodeTextOf(glyphs: readonly number[]): string
    {
        let text = '';
        for (const glyph of glyphs)
        {
            text += this.toUnicode.get(glyph) ?? '';
        }
        return text;
    }
}

/** Font units to PDF glyph space (1000 per em). */
function toGlyphSpace(font: ParsedFont, value: number): number
{
    return (value * 1000) / font.unitsPerEm;
}

/** Throws unless the font's license allows embedding. */
export function checkEmbeddable(font: ParsedFont): void
{
    if ((font.fsType & FS_TYPE_RESTRICTED) !== 0)
    {
        throwWriteError(`font ${font.postScriptName} has a restricted license (fsType bit 0x0002): it may not be embedded`);
    }
}

/**
 * The FontDescriptor values. Choices:
 * - Ascent / Descent: hhea ascender / descender, the values most PDF writers
 *   (pdfkit / fontkit among them) and macOS use; viewers only use them as a
 *   hint for selection boxes when the font is embedded;
 * - CapHeight: OS/2 sCapHeight; when the font has none (OS/2 version below
 *   2), the bounding box top (yMax), a safe upper bound (Plex has it);
 * - StemV: TrueType stores no stem width, so it is estimated from the weight
 *   class as 50 + (weightClass / 65)^2 (400 gives 88, 700 gives 166), the
 *   usual heuristic; viewers use it only to fake a missing font;
 * - Flags: Nonsymbolic (32), plus FixedPitch (1) and Italic (64) from the
 *   font; never Serif (Plex Sans and Mono have none).
 */
export function fontDescriptor(font: ParsedFont, fontFileObjectNumber: number): string
{
    const flags = 32 | (font.isFixedPitch ? 1 : 0) | (font.isItalic || font.italicAngle !== 0 ? 64 : 0);
    const { xMin, yMin, xMax, yMax } = font.bbox;
    const capHeight = font.capHeight ?? yMax;
    const stemV = Math.round(50 + (font.weightClass / 65) ** 2);
    const entries = [
        '/Type /FontDescriptor',
        `/FontName ${pdfName(font.postScriptName)}`,
        `/Flags ${flags}`,
        `/FontBBox [${[xMin, yMin, xMax, yMax].map((coordinate) => pdfNumber(toGlyphSpace(font, coordinate))).join(' ')}]`,
        `/ItalicAngle ${pdfNumber(font.italicAngle)}`,
        `/Ascent ${pdfNumber(toGlyphSpace(font, font.hhea.ascender))}`,
        `/Descent ${pdfNumber(toGlyphSpace(font, font.hhea.descender))}`,
        `/CapHeight ${pdfNumber(toGlyphSpace(font, capHeight))}`,
        ...(font.xHeight === null ? [] : [`/XHeight ${pdfNumber(toGlyphSpace(font, font.xHeight))}`]),
        `/StemV ${pdfInteger(stemV)}`,
        `/MissingWidth ${pdfNumber(toGlyphSpace(font, font.advance(0)))}`,
        `/FontFile2 ${fontFileObjectNumber} 0 R`,
    ];
    return `<< ${entries.join(' ')} >>`;
}

/**
 * The /W array for the used glyphs, compact: consecutive ids form one
 * group; a group of 3 or more equal widths is written "first last width",
 * any other group "first [w1 w2 ...]".
 */
export function widthsArray(font: ParsedFont, glyphs: Iterable<number>): string
{
    const glyphIds = [...glyphs].sort((a, b) => a - b);
    const parts: string[] = [];
    let groupStart = 0;
    while (groupStart < glyphIds.length)
    {
        let groupEnd = groupStart;
        while (groupEnd + 1 < glyphIds.length && glyphIds[groupEnd + 1] === glyphIds[groupEnd]! + 1)
        {
            groupEnd++;
        }
        const widths = glyphIds.slice(groupStart, groupEnd + 1).map((glyphId) => pdfNumber(toGlyphSpace(font, font.advance(glyphId))));
        if (widths.length >= 3 && widths.every((width) => width === widths[0]))
        {
            parts.push(`${glyphIds[groupStart]} ${glyphIds[groupEnd]} ${widths[0]}`);
        }
        else
        {
            parts.push(`${glyphIds[groupStart]} [${widths.join(' ')}]`);
        }
        groupStart = groupEnd + 1;
    }
    return `[${parts.join(' ')}]`;
}

/** The CIDFontType2 dictionary. */
export function cidFont(font: ParsedFont, descriptorObjectNumber: number, widths: string): string
{
    return (
        `<< /Type /Font /Subtype /CIDFontType2 /BaseFont ${pdfName(font.postScriptName)}` +
        ` /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>` +
        ` /FontDescriptor ${descriptorObjectNumber} 0 R /DW ${pdfNumber(toGlyphSpace(font, font.advance(0)))} /W ${widths} /CIDToGIDMap /Identity >>`
    );
}

/** The Type0 font dictionary (what pages refer to). */
export function type0Font(font: ParsedFont, descendantObjectNumber: number, toUnicodeObjectNumber: number): string
{
    return (
        `<< /Type /Font /Subtype /Type0 /BaseFont ${pdfName(font.postScriptName)} /Encoding /Identity-H` +
        ` /DescendantFonts [${descendantObjectNumber} 0 R] /ToUnicode ${toUnicodeObjectNumber} 0 R >>`
    );
}

/** One code unit when a text is a single BMP character (usable in a bfrange), else undefined. */
function singleCodeUnit(text: string): number | undefined
{
    if (text.length !== 1)
    {
        return undefined;
    }
    const unit = text.charCodeAt(0);
    return unit >= 0xd800 && unit <= 0xdfff ? undefined : unit;
}

/**
 * The ToUnicode CMap: glyph id (2 bytes, Identity-H) to UTF-16BE text.
 * Runs of 2 or more consecutive glyph ids (same high byte) that map to
 * consecutive single BMP code units (without the last byte wrapping) become
 * one bfrange entry; everything else (one glyph, a pair, several code
 * points) a bfchar entry. At most 100 entries per block.
 */
export function toUnicodeCmap(toUnicode: ReadonlyMap<number, string>): string
{
    const glyphIds = [...toUnicode.keys()].sort((a, b) => a - b);
    const rangeEntries: string[] = [];
    const charEntries: string[] = [];
    let runStart = 0;
    while (runStart < glyphIds.length)
    {
        const firstGlyph = glyphIds[runStart]!;
        const firstUnit = singleCodeUnit(toUnicode.get(firstGlyph)!);
        let runEnd = runStart;
        if (firstUnit !== undefined)
        {
            while (runEnd + 1 < glyphIds.length)
            {
                const nextGlyph = glyphIds[runEnd + 1]!;
                const step = nextGlyph - firstGlyph;
                if (nextGlyph !== glyphIds[runEnd]! + 1 || nextGlyph >> 8 !== firstGlyph >> 8)
                {
                    break;
                }
                if (singleCodeUnit(toUnicode.get(nextGlyph)!) !== firstUnit + step || (firstUnit & 0xff) + step > 0xff)
                {
                    break;
                }
                runEnd++;
            }
        }
        if (runEnd > runStart)
        {
            rangeEntries.push(`<${fourHexDigits(firstGlyph)}> <${fourHexDigits(glyphIds[runEnd]!)}> <${fourHexDigits(firstUnit!)}>`);
        }
        else
        {
            charEntries.push(`<${fourHexDigits(firstGlyph)}> <${utf16Hex(toUnicode.get(firstGlyph)!)}>`);
        }
        runStart = runEnd + 1;
    }
    const blocks: string[] = [];
    for (let blockStart = 0; blockStart < charEntries.length; blockStart += CMAP_BLOCK_SIZE)
    {
        const blockEntries = charEntries.slice(blockStart, blockStart + CMAP_BLOCK_SIZE);
        blocks.push(`${blockEntries.length} beginbfchar\n${blockEntries.join('\n')}\nendbfchar`);
    }
    for (let blockStart = 0; blockStart < rangeEntries.length; blockStart += CMAP_BLOCK_SIZE)
    {
        const blockEntries = rangeEntries.slice(blockStart, blockStart + CMAP_BLOCK_SIZE);
        blocks.push(`${blockEntries.length} beginbfrange\n${blockEntries.join('\n')}\nendbfrange`);
    }
    return [
        '/CIDInit /ProcSet findresource begin',
        '12 dict begin',
        'begincmap',
        '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
        '/CMapName /Adobe-Identity-UCS def',
        '/CMapType 2 def',
        '1 begincodespacerange',
        '<0000> <FFFF>',
        'endcodespacerange',
        ...blocks,
        'endcmap',
        'CMapName currentdict /CIDResource defineresource pop',
        'end',
        'end',
        '',
    ].join('\n');
}
