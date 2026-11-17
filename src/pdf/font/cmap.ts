// The font's cmap table: Unicode code point -> glyph id (pure, as in rule
// R7). Reads subtable format 4 (BMP, segments) and format 12 (all planes,
// groups). Glyph 0 (.notdef) means "the font has no glyph for it".
//
// Both formats are checked once when parsed (sizes, sorted non-overlapping
// segments / groups) and then looked up with a binary search, so a lookup is
// O(log n) and can never loop on damaged data.
import { BinaryReader, fail } from './binary';

export interface Cmap {
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
export function parseCmap(table: Uint8Array, numGlyphs: number): Cmap
{
    const r = new BinaryReader(table, 'cmap');
    if (r.u16(0) !== 0) fail('cmap: unknown table version');
    const count = r.u16(2);
    r.need(4, count * 8, 'encoding records');
    const records: { platformId: number; encodingId: number; offset: number }[] = [];
    for (let i = 0; i < count; i++)
    {
        const at = 4 + i * 8;
        records.push({ platformId: r.u16(at), encodingId: r.u16(at + 2), offset: r.u32(at + 4) });
    }
    for (const [platformId, encodingId] of CMAP_PREFERENCE)
    {
        for (const record of records)
        {
            if (record.platformId !== platformId || record.encodingId !== encodingId) continue;
            const format = r.u16(record.offset);
            if (format === 4) return { format, platformId, encodingId, lookup: format4(r, record.offset, numGlyphs) };
            if (format === 12) return { format, platformId, encodingId, lookup: format12(r, record.offset, numGlyphs) };
        }
    }
    fail('cmap: no Unicode subtable of format 4 or 12');
}

function validGlyph(glyph: number, numGlyphs: number): number
{
    return glyph < numGlyphs ? glyph : 0;
}

/** Format 4: segment mapping to delta values (BMP only). */
function format4(r: BinaryReader, start: number, numGlyphs: number): (codePoint: number) => number
{
    r.need(start, 14, 'format 4 header');
    const length = r.u16(start + 2);
    const sub = new BinaryReader(r.slice(start, length, 'format 4 subtable'), 'cmap format 4');
    const segCountX2 = sub.u16(6);
    if (segCountX2 === 0 || segCountX2 % 2 !== 0) fail('cmap format 4: bad segment count');
    const segCount = segCountX2 / 2;
    const endAt = 14;
    const startAt = endAt + segCountX2 + 2; // + reservedPad
    const deltaAt = startAt + segCountX2;
    const rangeAt = deltaAt + segCountX2;
    sub.need(endAt, rangeAt + segCountX2 - endAt, 'format 4 segment arrays');
    let previousEnd = -1;
    for (let i = 0; i < segCount; i++)
    {
        const end = sub.u16(endAt + 2 * i);
        const first = sub.u16(startAt + 2 * i);
        if (first > end || first <= previousEnd) fail('cmap format 4: segments are not sorted or overlap');
        previousEnd = end;
    }
    return (codePoint) =>
    {
        if (codePoint > 0xffff) return 0;
        // First segment whose end >= codePoint.
        let low = 0;
        let high = segCount - 1;
        while (low < high)
        {
            const middle = (low + high) >>> 1;
            if (sub.u16(endAt + 2 * middle) < codePoint) low = middle + 1;
            else high = middle;
        }
        const end = sub.u16(endAt + 2 * low);
        const first = sub.u16(startAt + 2 * low);
        if (codePoint > end || codePoint < first) return 0;
        const delta = sub.u16(deltaAt + 2 * low);
        const rangeOffset = sub.u16(rangeAt + 2 * low);
        if (rangeOffset === 0) return validGlyph((codePoint + delta) & 0xffff, numGlyphs);
        // idRangeOffset counts bytes from its own position into glyphIdArray.
        const at = rangeAt + 2 * low + rangeOffset + 2 * (codePoint - first);
        if (at + 2 > sub.length) return 0;
        const glyph = sub.u16(at);
        return glyph === 0 ? 0 : validGlyph((glyph + delta) & 0xffff, numGlyphs);
    };
}

/** Format 12: segmented coverage (all of Unicode). */
function format12(r: BinaryReader, start: number, numGlyphs: number): (codePoint: number) => number
{
    r.need(start, 16, 'format 12 header');
    const length = r.u32(start + 4);
    const sub = new BinaryReader(r.slice(start, length, 'format 12 subtable'), 'cmap format 12');
    const numGroups = sub.u32(12);
    if (numGroups === 0) fail('cmap format 12: no groups');
    sub.need(16, numGroups * 12, 'format 12 groups');
    let previousEnd = -1;
    for (let i = 0; i < numGroups; i++)
    {
        const at = 16 + 12 * i;
        const first = sub.u32(at);
        const end = sub.u32(at + 4);
        if (first > end || end > 0x10ffff || first <= previousEnd) fail('cmap format 12: groups are not sorted, overlap or pass U+10FFFF');
        previousEnd = end;
    }
    return (codePoint) =>
    {
        let low = 0;
        let high = numGroups - 1;
        while (low < high)
        {
            const middle = (low + high) >>> 1;
            if (sub.u32(16 + 12 * middle + 4) < codePoint) low = middle + 1;
            else high = middle;
        }
        const at = 16 + 12 * low;
        const first = sub.u32(at);
        if (codePoint < first || codePoint > sub.u32(at + 4)) return 0;
        return validGlyph(sub.u32(at + 8) + (codePoint - first), numGlyphs);
    };
}
