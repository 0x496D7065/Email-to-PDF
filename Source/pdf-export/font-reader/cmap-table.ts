// The font's cmap table (the OpenType "character to glyph index mapping"
// table): Unicode code point -> glyph id (pure, as in rule
// R7). Reads subtable format 4 (BMP, segments) and format 12 (all planes,
// groups). Glyph 0 (.notdef) means "the font has no glyph for it".
// segCountX2, segCount, startCode, endCode, idDelta, idRangeOffset, numGroups,
// startCharCode and endCharCode are the OpenType spec's field names.
//
// Both formats are checked once when parsed (sizes, sorted non-overlapping
// segments / groups) and then looked up with a binary search, so a lookup is
// O(log n) and can never loop on damaged data.
import { BinaryReader, throwFontError } from './binary-reader';

export interface CmapSubtable
{
    readonly format: 4 | 12;
    readonly platformId: number;
    readonly encodingId: number;
    /** The glyph id for a code point, or 0 when the font has none. A closure: safe to call detached. */
    readonly lookup: (codePoint: number) => number;
}

/**
 * Subtables tried in this order (platform id, encoding id): Windows full
 * Unicode, Unicode full repertoire, Unicode 2.0 full, Windows BMP, Unicode
 * 2.0 BMP. The first one present with format 4 or 12 is used.
 */
export const CMAP_PREFERENCE: readonly (readonly [number, number])[] = [
    [3, 10],
    [0, 6],
    [0, 4],
    [3, 1],
    [0, 3],
];

/**
 * Parses a cmap table and picks its best Unicode subtable (CMAP_PREFERENCE).
 * Glyph ids >= numGlyphs are treated as missing (0). Throws a FontError when
 * the table is damaged or has no usable Unicode subtable.
 */
export function parseCmap(table: Uint8Array, numGlyphs: number): CmapSubtable
{
    const reader = new BinaryReader(table, 'cmap');
    if (reader.readUint16(0) !== 0)
    {
        throwFontError('cmap: unknown table version');
    }
    const encodingRecordCount = reader.readUint16(2);
    reader.requireBytes(4, encodingRecordCount * 8, 'encoding records');
    const encodingRecords: { platformId: number; encodingId: number; offset: number }[] = [];
    for (let i = 0; i < encodingRecordCount; i++)
    {
        const recordAt = 4 + i * 8;
        encodingRecords.push({
            platformId: reader.readUint16(recordAt),
            encodingId: reader.readUint16(recordAt + 2),
            offset: reader.readUint32(recordAt + 4)
        });
    }
    for (const [platformId, encodingId] of CMAP_PREFERENCE)
    {
        for (const record of encodingRecords)
        {
            if (record.platformId !== platformId || record.encodingId !== encodingId)
            {
                continue;
            }
            const format = reader.readUint16(record.offset);
            if (format === 4)
            {
                return { format, platformId, encodingId, lookup: format4Lookup(reader, record.offset, numGlyphs) };
            }
            if (format === 12)
            {
                return { format, platformId, encodingId, lookup: format12Lookup(reader, record.offset, numGlyphs) };
            }
        }
    }
    throwFontError('cmap: no Unicode subtable of format 4 or 12');
}

function glyphOrMissing(glyph: number, numGlyphs: number): number
{
    return glyph < numGlyphs ? glyph : 0;
}

/** Format 4: segment mapping to delta values (BMP only). */
function format4Lookup(reader: BinaryReader, start: number, numGlyphs: number): (codePoint: number) => number
{
    reader.requireBytes(start, 14, 'format 4 header');
    const length = reader.readUint16(start + 2);
    const subtable = new BinaryReader(reader.slice(start, length, 'format 4 subtable'), 'cmap format 4');
    const segCountX2 = subtable.readUint16(6);
    if (segCountX2 === 0 || segCountX2 % 2 !== 0)
    {
        throwFontError('cmap format 4: bad segment count');
    }
    const segCount = segCountX2 / 2;
    const endCodesAt = 14;
    const startCodesAt = endCodesAt + segCountX2 + 2; // + reservedPad
    const idDeltasAt = startCodesAt + segCountX2;
    const idRangeOffsetsAt = idDeltasAt + segCountX2;
    subtable.requireBytes(endCodesAt, idRangeOffsetsAt + segCountX2 - endCodesAt, 'format 4 segment arrays');
    let previousEnd = -1;
    for (let i = 0; i < segCount; i++)
    {
        const endCode = subtable.readUint16(endCodesAt + 2 * i);
        const startCode = subtable.readUint16(startCodesAt + 2 * i);
        if (startCode > endCode || startCode <= previousEnd)
        {
            throwFontError('cmap format 4: segments are not sorted or overlap');
        }
        previousEnd = endCode;
    }
    return (codePoint) =>
    {
        if (codePoint > 0xffff)
        {
            return 0;
        }
        // First segment whose end >= codePoint.
        let low = 0;
        let high = segCount - 1;
        while (low < high)
        {
            const middle = (low + high) >>> 1;
            if (subtable.readUint16(endCodesAt + 2 * middle) < codePoint)
            {
                low = middle + 1;
            }
            else
            {
                high = middle;
            }
        }
        const endCode = subtable.readUint16(endCodesAt + 2 * low);
        const startCode = subtable.readUint16(startCodesAt + 2 * low);
        if (codePoint > endCode || codePoint < startCode)
        {
            return 0;
        }
        const idDelta = subtable.readUint16(idDeltasAt + 2 * low);
        const idRangeOffset = subtable.readUint16(idRangeOffsetsAt + 2 * low);
        if (idRangeOffset === 0)
        {
            return glyphOrMissing((codePoint + idDelta) & 0xffff, numGlyphs);
        }
        // idRangeOffset counts bytes from its own position into glyphIdArray.
        const glyphIdAt = idRangeOffsetsAt + 2 * low + idRangeOffset + 2 * (codePoint - startCode);
        if (glyphIdAt + 2 > subtable.length)
        {
            return 0;
        }
        const glyph = subtable.readUint16(glyphIdAt);
        return glyph === 0 ? 0 : glyphOrMissing((glyph + idDelta) & 0xffff, numGlyphs);
    };
}

/** Format 12: segmented coverage (all of Unicode). */
function format12Lookup(reader: BinaryReader, start: number, numGlyphs: number): (codePoint: number) => number
{
    reader.requireBytes(start, 16, 'format 12 header');
    const length = reader.readUint32(start + 4);
    const subtable = new BinaryReader(reader.slice(start, length, 'format 12 subtable'), 'cmap format 12');
    const numGroups = subtable.readUint32(12);
    if (numGroups === 0)
    {
        throwFontError('cmap format 12: no groups');
    }
    subtable.requireBytes(16, numGroups * 12, 'format 12 groups');
    let previousEnd = -1;
    for (let i = 0; i < numGroups; i++)
    {
        const groupAt = 16 + 12 * i;
        const startCharCode = subtable.readUint32(groupAt);
        const endCharCode = subtable.readUint32(groupAt + 4);
        if (startCharCode > endCharCode || endCharCode > 0x10ffff || startCharCode <= previousEnd)
        {
            throwFontError('cmap format 12: groups are not sorted, overlap or pass U+10FFFF');
        }
        previousEnd = endCharCode;
    }
    return (codePoint) =>
    {
        let low = 0;
        let high = numGroups - 1;
        while (low < high)
        {
            const middle = (low + high) >>> 1;
            if (subtable.readUint32(16 + 12 * middle + 4) < codePoint)
            {
                low = middle + 1;
            }
            else
            {
                high = middle;
            }
        }
        const groupAt = 16 + 12 * low;
        const startCharCode = subtable.readUint32(groupAt);
        if (codePoint < startCharCode || codePoint > subtable.readUint32(groupAt + 4))
        {
            return 0;
        }
        return glyphOrMissing(subtable.readUint32(groupAt + 8) + (codePoint - startCharCode), numGlyphs);
    };
}
