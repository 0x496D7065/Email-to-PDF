// cmap parsing on hand-built synthetic tables (pure, as in rule R7).
import { describe, expect, it } from 'vitest';
import { FontError } from './binary';
import { parseCmap } from './cmap';

/** A big-endian byte writer for building test tables. */
class Writer
{
    private readonly bytes: number[] = [];
    u16(value: number): this
    {
        this.bytes.push((value >>> 8) & 0xff, value & 0xff);
        return this;
    }
    u32(value: number): this
    {
        return this.u16((value >>> 16) & 0xffff).u16(value & 0xffff);
    }
    raw(data: Uint8Array): this
    {
        this.bytes.push(...data);
        return this;
    }
    get length(): number
    {
        return this.bytes.length;
    }
    done(): Uint8Array
    {
        return Uint8Array.from(this.bytes);
    }
}

interface Segment {
    start: number;
    end: number;
    delta: number;
    /** When given, the segment maps through glyphIdArray (idRangeOffset != 0). */
    glyphs?: number[];
}

/** A format 4 subtable. Segments must be sorted; a final U+FFFF segment is added. */
function format4(segments: Segment[], { lengthDelta = 0, segCountX2 }: { lengthDelta?: number; segCountX2?: number } = {}): Uint8Array
{
    const all: Segment[] = [...segments, { start: 0xffff, end: 0xffff, delta: 1 }];
    const segCount = all.length;
    const glyphIdArray: number[] = [];
    const rangeOffsets = all.map((segment, i) =>
    {
        if (segment.glyphs === undefined)
        {
            return 0;
        }
        const offset = 2 * (segCount - i) + 2 * glyphIdArray.length;
        glyphIdArray.push(...segment.glyphs);
        return offset;
    });
    const body = new Writer();
    for (const s of all)
    {
        body.u16(s.end);
    }
    body.u16(0); // reservedPad
    for (const s of all)
    {
        body.u16(s.start);
    }
    for (const s of all)
    {
        body.u16(s.delta & 0xffff);
    }
    for (const offset of rangeOffsets)
    {
        body.u16(offset);
    }
    for (const glyph of glyphIdArray)
    {
        body.u16(glyph);
    }
    const length = 14 + body.length;
    return new Writer()
        .u16(4)
        .u16(length + lengthDelta)
        .u16(0) // language
        .u16(segCountX2 ?? segCount * 2)
        .u16(0) // searchRange etc.: not used by the reader
        .u16(0)
        .u16(0)
        .raw(body.done())
        .done();
}

/** A format 12 subtable from [startChar, endChar, startGlyph] groups. */
function format12(groups: [number, number, number][], numGroups = groups.length): Uint8Array
{
    const w = new Writer().u16(12).u16(0).u32(16 + 12 * groups.length).u32(0).u32(numGroups);
    for (const [start, end, glyph] of groups)
    {
        w.u32(start).u32(end).u32(glyph);
    }
    return w.done();
}

/** A cmap table holding the given subtables. */
function cmap(subtables: { platformId: number; encodingId: number; data: Uint8Array }[]): Uint8Array
{
    const w = new Writer().u16(0).u16(subtables.length);
    let offset = 4 + 8 * subtables.length;
    for (const s of subtables)
    {
        w.u16(s.platformId).u16(s.encodingId).u32(offset);
        offset += s.data.length;
    }
    for (const s of subtables)
    {
        w.raw(s.data);
    }
    return w.done();
}

const SEGMENTS: Segment[] = [
    { start: 0x20, end: 0x7e, delta: -0x1f }, // ASCII: U+0020 -> glyph 1, U+007E -> 95
    // Through glyphIdArray, delta added: U+00E0 -> 105, U+00E2 -> 107. U+00E1
    // has entry 0, which stays "missing" (not 0 + delta).
    { start: 0xe0, end: 0xe2, delta: 5, glyphs: [100, 0, 102] },
    { start: 0x20ac, end: 0x20ac, delta: 10, glyphs: [190] }, // delta added to the array value: 200
];

describe('parseCmap format 4', () =>
{
    const table = cmap([{ platformId: 3, encodingId: 1, data: format4(SEGMENTS) }]);
    const parsed = parseCmap(table, 300);

    it('maps by delta and through glyphIdArray', () =>
    {
        expect(parsed).toMatchObject({ format: 4, platformId: 3, encodingId: 1 });
        expect(parsed.lookup(0x20)).toBe(1);
        expect(parsed.lookup(0x41)).toBe(0x22);
        expect(parsed.lookup(0x7e)).toBe(95);
        expect(parsed.lookup(0xe0)).toBe(105);
        expect(parsed.lookup(0xe1)).toBe(0);
        expect(parsed.lookup(0xe2)).toBe(107);
        expect(parsed.lookup(0x20ac)).toBe(200);
    });

    it('gives 0 between segments, below the first, at U+FFFF and above the BMP', () =>
    {
        for (const codePoint of [0, 0x1f, 0x7f, 0xdf, 0xe3, 0x20ab, 0x20ad, 0xffff, 0x10000, 0x1f600])
        {
            expect(parsed.lookup(codePoint), codePoint.toString(16)).toBe(0);
        }
    });

    it('treats a glyph id at or above numGlyphs as missing', () =>
    {
        const small = parseCmap(table, 50);
        expect(small.lookup(0x40)).toBe(0x21);
        expect(small.lookup(0x51)).toBe(0); // glyph 50
        expect(small.lookup(0xe0)).toBe(0); // glyph 105
    });

    it('gives 0 when idRangeOffset points past the subtable', () =>
    {
        const data = format4([{ start: 0x41, end: 0x5a, delta: 0, glyphs: [7] }]); // one entry for 26 code points
        const lookup = parseCmap(cmap([{ platformId: 3, encodingId: 1, data }]), 300).lookup;
        expect(lookup(0x41)).toBe(7);
        expect(lookup(0x42)).toBe(0); // its glyphIdArray entry would be past the end of the subtable
        expect(lookup(0x5a)).toBe(0);
    });

    it('rejects damaged subtables', () =>
    {
        const parse = (data: Uint8Array): unknown => parseCmap(cmap([{ platformId: 3, encodingId: 1, data }]), 300);
        expect(() => parse(format4(SEGMENTS, { lengthDelta: 2 }))).toThrow(/format 4 subtable .* past the end/);
        expect(() => parse(format4(SEGMENTS, { segCountX2: 7 }))).toThrow(/bad segment count/);
        expect(() => parse(format4(SEGMENTS, { segCountX2: 0 }))).toThrow(/bad segment count/);
        expect(() => parse(format4(SEGMENTS, { segCountX2: 400 }))).toThrow(/segment arrays .* past the end/);
        const unsorted = [SEGMENTS[1]!, SEGMENTS[0]!];
        expect(() => parse(format4(unsorted))).toThrow(/not sorted or overlap/);
        const overlapping = [{ start: 0x20, end: 0x50, delta: 0 }, { start: 0x50, end: 0x60, delta: 0 }];
        expect(() => parse(format4(overlapping))).toThrow(/not sorted or overlap/);
        expect(() => parse(format4([{ start: 0x50, end: 0x40, delta: 0 }]))).toThrow(/not sorted or overlap/);
        expect(() => parse(format4(SEGMENTS).subarray(0, 10))).toThrow(FontError);
    });
});

describe('parseCmap format 12', () =>
{
    const groups: [number, number, number][] = [
        [0x20, 0x7e, 1],
        [0xe9, 0xe9, 120],
        [0x1f600, 0x1f602, 250], // a few emoji, to test the planes above the BMP
    ];
    const parsed = parseCmap(cmap([{ platformId: 3, encodingId: 10, data: format12(groups) }]), 300);

    it('maps groups in all planes', () =>
    {
        expect(parsed).toMatchObject({ format: 12, platformId: 3, encodingId: 10 });
        expect(parsed.lookup(0x20)).toBe(1);
        expect(parsed.lookup(0x7e)).toBe(95);
        expect(parsed.lookup(0xe9)).toBe(120);
        expect(parsed.lookup(0x1f601)).toBe(251);
        for (const codePoint of [0, 0x1f, 0x7f, 0xe8, 0xea, 0x1f5ff, 0x1f603, 0x10ffff])
        {
            expect(parsed.lookup(codePoint)).toBe(0);
        }
    });

    it('treats a glyph id at or above numGlyphs as missing', () =>
    {
        const lookup = parseCmap(cmap([{ platformId: 3, encodingId: 10, data: format12(groups) }]), 251).lookup;
        expect(lookup(0x1f600)).toBe(250);
        expect(lookup(0x1f601)).toBe(0);
    });

    it('rejects damaged subtables', () =>
    {
        const parse = (data: Uint8Array): unknown => parseCmap(cmap([{ platformId: 3, encodingId: 10, data }]), 300);
        expect(() => parse(format12(groups, 0))).toThrow(/no groups/);
        expect(() => parse(format12(groups, 0xffffffff))).toThrow(/groups .* past the end/);
        expect(() => parse(format12([[0x30, 0x20, 1]]))).toThrow(/not sorted/);
        expect(() => parse(format12([[0x20, 0x30, 1], [0x30, 0x40, 1]]))).toThrow(/not sorted, overlap/);
        expect(() => parse(format12([[0x20, 0x110000, 1]]))).toThrow(/U\+10FFFF/);
        expect(() => parse(format12(groups).subarray(0, 30))).toThrow(/format 12 subtable .* past the end/);
    });
});

describe('parseCmap subtable choice', () =>
{
    const bmp = format4([{ start: 0x41, end: 0x41, delta: 1 - 0x41 }]); // A -> 1
    const full = format12([[0x41, 0x41, 2]]); // A -> 2

    it('prefers (3,10), then (0,6)/(0,4), then (3,1)/(0,3)', () =>
    {
        const pick = (records: [number, number, Uint8Array][]): string =>
        {
            const parsed = parseCmap(cmap(records.map(([platformId, encodingId, data]) => ({ platformId, encodingId, data }))), 10);
            return `${parsed.platformId},${parsed.encodingId}`;
        };
        expect(pick([[0, 3, bmp], [3, 1, bmp], [3, 10, full]])).toBe('3,10');
        expect(pick([[0, 3, bmp], [3, 1, bmp], [0, 4, full]])).toBe('0,4');
        expect(pick([[0, 3, bmp], [3, 1, bmp]])).toBe('3,1');
        expect(pick([[1, 0, bmp], [0, 3, bmp]])).toBe('0,3');
    });

    it('skips a preferred record of another format', () =>
    {
        const format6 = new Writer().u16(6).u16(10).u16(0).u16(0).u16(0).done();
        const parsed = parseCmap(cmap([{ platformId: 3, encodingId: 10, data: format6 }, { platformId: 3, encodingId: 1, data: bmp }]), 10);
        expect(parsed).toMatchObject({ format: 4, platformId: 3, encodingId: 1 });
        expect(parsed.lookup(0x41)).toBe(1);
    });

    it('rejects a table with no Unicode subtable, a wrong version or records past the end', () =>
    {
        expect(() => parseCmap(cmap([{ platformId: 1, encodingId: 0, data: bmp }]), 10)).toThrow(/no Unicode subtable/);
        expect(() => parseCmap(cmap([]), 10)).toThrow(/no Unicode subtable/);
        const versioned = cmap([{ platformId: 3, encodingId: 1, data: bmp }]);
        versioned[1] = 1;
        expect(() => parseCmap(versioned, 10)).toThrow(/unknown table version/);
        const counted = cmap([{ platformId: 3, encodingId: 1, data: bmp }]);
        counted[2] = 0xff;
        expect(() => parseCmap(counted, 10)).toThrow(/encoding records .* past the end/);
        const pointing = cmap([{ platformId: 3, encodingId: 1, data: bmp }]);
        pointing[8] = 0x7f;
        expect(() => parseCmap(pointing, 10)).toThrow(FontError);
    });
});
