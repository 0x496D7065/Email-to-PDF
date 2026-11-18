// A parsed TrueType font: what the PDF writer (FontDescriptor, widths,
// FontFile2) and the layout (line heights, text widths) need, read from the
// sfnt tables (pure, as in rule R7; worker-safe, no DOM, no Node).
//
// All metrics are in font units (divide by unitsPerEm for ems). Nothing is
// chosen for the caller: hhea, OS/2 typo and OS/2 win line metrics are all
// exposed, because the PDF FontDescriptor and the layout may want different
// ones (OS/2 fsSelection bit 7, USE_TYPO_METRICS, says which the font
// designer intends for line spacing; it is exposed as useTypoMetrics).
//
// Text measuring is deliberately simple: one glyph per code point, from the
// cmap, and the sum of their advance widths. No kerning (GPOS/kern), no
// ligatures or other GSUB/GPOS shaping, no bidi. A combining mark is
// measured with its own advance (usually 0 in Plex), so "e" + U+0301 is the
// width of "e". A code point the font lacks maps to glyph 0 (.notdef) and is
// measured as .notdef; the renderer decides what to draw instead.
import { BinaryReader, fail, toFontError } from './binary-reader';
import { type Cmap, parseCmap } from './cmap-table';
import { readSfntDirectory, tableBytes } from './sfnt-directory';
import { unwrapWoff } from './unwrap-woff';
import type { ParsedFont } from '../../../Header/pdf-fonts';

/** The tables a TrueType font for FontFile2 must have (glyf/loca: TrueType outlines). */
const REQUIRED_TABLES = ['head', 'hhea', 'maxp', 'hmtx', 'cmap', 'name', 'post', 'OS/2', 'glyf', 'loca'] as const;

/** Unwraps a WOFF 1.0 file and parses the font in it. Rejects with a FontError. */
export async function readWoffFont(woff: Uint8Array): Promise<ParsedFont>
{
    return parseFont(await unwrapWoff(woff));
}

/** Parses a TrueType font (sfnt bytes). Throws a FontError when it is damaged or incomplete. */
export function parseFont(sfnt: Uint8Array): ParsedFont
{
    try
    {
        return parse(sfnt);
    }
    catch (error)
    {
        throw toFontError(error, 'font');
    }
}

function parse(sfnt: Uint8Array): ParsedFont
{
    const directory = readSfntDirectory(sfnt);
    const table = (tag: (typeof REQUIRED_TABLES)[number]): BinaryReader =>
    {
        const bytes = tableBytes(sfnt, directory, tag);
        if (bytes === undefined)
        {
            fail(`font: no "${tag}" table`);
        }
        return new BinaryReader(bytes, tag);
    };
    for (const tag of REQUIRED_TABLES)
    {
        table(tag);
    }

    const head = table('head');
    head.need(0, 54, 'head table');
    if (head.u32(12) !== 0x5f0f3cf5)
    {
        fail('head: wrong magic number');
    }
    const unitsPerEm = head.u16(18);
    if (unitsPerEm < 16 || unitsPerEm > 16384)
    {
        fail(`head: unitsPerEm ${unitsPerEm} is out of range (16 to 16384)`);
    }
    const macStyle = head.u16(44);

    const maxp = table('maxp');
    const numGlyphs = maxp.u16(4);
    if (numGlyphs === 0)
    {
        fail('maxp: font has no glyphs');
    }

    const hhea = table('hhea');
    hhea.need(0, 36, 'hhea table');
    const numberOfHMetrics = hhea.u16(34);
    if (numberOfHMetrics === 0 || numberOfHMetrics > numGlyphs)
    {
        fail('hhea: numberOfHMetrics is 0 or more than the glyph count');
    }

    const advances = readAdvances(table('hmtx'), numberOfHMetrics, numGlyphs);

    const os2 = table('OS/2');
    os2.need(0, 78, 'OS/2 table');
    const os2Version = os2.u16(0);
    if (os2Version >= 2)
    {
        os2.need(0, 96, 'OS/2 version 2 table');
    }
    const fsSelection = os2.u16(62);

    const post = table('post');
    post.need(0, 32, 'post table');

    const cmap: Cmap = parseCmap(table('cmap').bytes, numGlyphs);

    const glyphFor = (codePoint: number): number =>
    {
        if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff)
        {
            return 0;
        }
        if (codePoint >= 0xd800 && codePoint <= 0xdfff)
        {
            return 0; // a surrogate is never a character
        }
        return cmap.lookup(codePoint);
    };
    const advance = (glyphId: number): number =>
    {
        const width = Number.isInteger(glyphId) ? advances[glyphId] : undefined;
        if (width === undefined)
        {
            throw new RangeError(`font: glyph id ${glyphId} is not in the font (0 to ${numGlyphs - 1})`);
        }
        return width;
    };

    return Object.freeze({
        sfnt,
        postScriptName: postScriptNameFor(table('name')),
        unitsPerEm,
        numGlyphs,
        bbox: Object.freeze({ xMin: head.i16(36), yMin: head.i16(38), xMax: head.i16(40), yMax: head.i16(42) }),
        hhea: Object.freeze({ ascender: hhea.i16(4), descender: hhea.i16(6), lineGap: hhea.i16(8) }),
        typo: Object.freeze({ ascender: os2.i16(68), descender: os2.i16(70), lineGap: os2.i16(72) }),
        win: Object.freeze({ ascent: os2.u16(74), descent: os2.u16(76) }),
        // Bit 7 is defined from OS/2 version 4 on; earlier versions reserve it.
        useTypoMetrics: os2Version >= 4 && (fsSelection & 0x80) !== 0,
        capHeight: os2Version >= 2 ? os2.i16(88) : null,
        xHeight: os2Version >= 2 ? os2.i16(86) : null,
        os2Version,
        weightClass: os2.u16(4),
        fsType: os2.u16(8),
        italicAngle: post.i32(4) / 65536,
        underlinePosition: post.i16(8),
        underlineThickness: post.i16(10),
        isFixedPitch: post.u32(12) !== 0,
        isItalic: (macStyle & 0x02) !== 0 || (fsSelection & 0x01) !== 0,
        isBold: (macStyle & 0x01) !== 0 || (fsSelection & 0x20) !== 0,
        cmap: Object.freeze({ format: cmap.format, platformId: cmap.platformId, encodingId: cmap.encodingId }),
        glyphFor,
        hasGlyph: (codePoint: number): boolean => glyphFor(codePoint) !== 0,
        advance,
        measure: (text: string): number =>
        {
            let width = 0;
            // for...of walks code points; a lone surrogate comes out alone and maps to 0.
            for (const character of text)
            {
                width += advance(glyphFor(character.codePointAt(0)!));
            }
            return width;
        },
    });
}

/**
 * The advance width of every glyph. hmtx holds numberOfHMetrics
 * (advance, lsb) pairs, then one lsb per remaining glyph: those glyphs all
 * have the LAST pair's advance (typical for monospaced fonts).
 */
function readAdvances(hmtx: BinaryReader, numberOfHMetrics: number, numGlyphs: number): Uint16Array
{
    hmtx.need(0, 4 * numberOfHMetrics + 2 * (numGlyphs - numberOfHMetrics), 'hmtx table');
    const advances = new Uint16Array(numGlyphs);
    for (let i = 0; i < numberOfHMetrics; i++)
    {
        advances[i] = hmtx.u16(4 * i);
    }
    advances.fill(advances[numberOfHMetrics - 1]!, numberOfHMetrics);
    return advances;
}

/** Most characters in a PostScript name (the limit Adobe recommends). */
const MAX_POSTSCRIPT_NAME = 63;

/**
 * name ID 6, the PostScript name, as a safe PDF name: only printable ASCII
 * from "!" to "~" is kept, minus the PDF delimiters ( ) < > [ ] { } / %
 * and "#" (the PDF name escape), at most 63 characters. Prefers the Windows
 * Unicode record (3, 1), then Macintosh (1, 0), then Unicode (0, *).
 * (1, 0) bytes are read one per character (as Latin-1); only the ASCII
 * ones survive the filter, so the Mac Roman upper half never matters.
 */
function postScriptNameFor(name: BinaryReader): string
{
    const count = name.u16(2);
    const storage = name.u16(4);
    name.need(6, count * 12, 'name records');
    const candidates: { rank: number; text: string }[] = [];
    for (let i = 0; i < count; i++)
    {
        const at = 6 + i * 12;
        if (name.u16(at + 6) !== 6)
        {
            continue;
        }
        const platformId = name.u16(at);
        const encodingId = name.u16(at + 2);
        const rank = platformId === 3 && encodingId === 1 ? 0 : platformId === 1 && encodingId === 0 ? 1 : platformId === 0 ? 2 : -1;
        if (rank < 0)
        {
            continue;
        }
        const bytes = name.slice(storage + name.u16(at + 10), name.u16(at + 8), 'name string');
        let text = '';
        if (platformId === 1)
        {
            for (const byte of bytes)
            {
                text += String.fromCharCode(byte);
            }
        }
        else
        {
            for (let j = 0; j + 1 < bytes.length; j += 2)
            {
                text += String.fromCharCode((bytes[j]! << 8) | bytes[j + 1]!);
            }
        }
        candidates.push({ rank, text });
    }
    candidates.sort((a, b) => a.rank - b.rank);
    for (const { text } of candidates)
    {
        const safe = text.replace(/[^\x21-\x7e]|[()<>[\]{}/%#]/g, '').slice(0, MAX_POSTSCRIPT_NAME);
        if (safe !== '')
        {
            return safe;
        }
    }
    fail('name: no usable PostScript name (name ID 6)');
}
