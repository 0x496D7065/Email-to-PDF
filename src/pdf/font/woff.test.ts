// WOFF 1.0 unwrapping and the sfnt directory (pure functions, as in rule
// R7, tested without a DOM). The real bundled Plex files are checked
// against an independent decompression in this test; damaged files are
// built synthetically here (no real font data is modified on disk).
import { describe, expect, it } from 'vitest';
import { PDF_FONTS, type PdfFontName } from '../fonts';
import { directoryChecksum, FontError, MAX_FONT_BYTES, pad4, tagName, TRUETYPE_FLAVOR } from './binary';
import { checkSumAdjustment, readSfntDirectory, tableBytes } from './sfnt';
import { unwrapWoff } from './woff';

const names = Object.keys(PDF_FONTS) as PdfFontName[];

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>>
{
    const parts: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;)
    {
        const { done, value } = await reader.read();
        if (done)
        {
            break;
        }
        parts.push(value);
    }
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts)
    {
        out.set(part, at);
        at += part.length;
    }
    return out;
}

const deflate = (data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> =>
    readAll(new Blob([data.slice()]).stream().pipeThrough(new CompressionStream('deflate')));
const inflate = (data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> =>
    readAll(new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream('deflate')));

const tagValue = (tag: string): number =>
    ((tag.charCodeAt(0) << 24) | (tag.charCodeAt(1) << 16) | (tag.charCodeAt(2) << 8) | tag.charCodeAt(3)) >>> 0;

interface WoffEntryView {
    tag: string;
    offset: number;
    compLength: number;
    origLength: number;
    origChecksum: number;
}

/** The WOFF directory, read here independently of src/pdf/font/woff.ts. */
function woffDirectory(woff: Uint8Array): WoffEntryView[]
{
    const view = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
    return Array.from({ length: view.getUint16(12) }, (_, i) =>
    {
        const at = 44 + 20 * i;
        return {
            tag: tagName(view.getUint32(at)),
            offset: view.getUint32(at + 4),
            compLength: view.getUint32(at + 8),
            origLength: view.getUint32(at + 12),
            origChecksum: view.getUint32(at + 16),
        };
    });
}

interface SyntheticTable {
    tag: string;
    data: Uint8Array;
    compress: boolean;
}

/** A valid WOFF 1.0 file holding the given tables (directory sorted by tag). */
async function buildWoff(tables: SyntheticTable[], flavor = TRUETYPE_FLAVOR): Promise<Uint8Array<ArrayBuffer>>
{
    const sorted = [...tables].sort((a, b) => tagValue(a.tag) - tagValue(b.tag));
    const stored = await Promise.all(sorted.map((table) => (table.compress ? deflate(table.data) : Promise.resolve(table.data))));
    // WOFF stores a table raw unless compressing makes it smaller.
    stored.forEach((data, i) =>
    {
        if (sorted[i]!.compress && data.length >= sorted[i]!.data.length)
        {
            throw new Error(`test table ${sorted[i]!.tag} does not compress`);
        }
    });
    const directoryEnd = 44 + 20 * sorted.length;
    let length = directoryEnd;
    const offsets = stored.map((data) =>
    {
        const offset = length;
        length += pad4(data.length);
        return offset;
    });
    const woff = new Uint8Array(length);
    const view = new DataView(woff.buffer);
    view.setUint32(0, 0x774f4646);
    view.setUint32(4, flavor);
    view.setUint32(8, length);
    view.setUint16(12, sorted.length);
    view.setUint32(16, 12 + 16 * sorted.length + sorted.reduce((sum, table) => sum + pad4(table.data.length), 0));
    view.setUint16(20, 1);
    sorted.forEach((table, i) =>
    {
        const at = 44 + 20 * i;
        const tag = tagValue(table.tag);
        view.setUint32(at, tag);
        view.setUint32(at + 4, offsets[i]!);
        view.setUint32(at + 8, stored[i]!.length);
        view.setUint32(at + 12, table.data.length);
        view.setUint32(at + 16, directoryChecksum(tag, table.data, 0, table.data.length));
        woff.set(stored[i]!, offsets[i]);
    });
    return woff;
}

/** Synthetic table contents: a repeating pattern that compresses well. */
const pattern = (length: number, seed: number): Uint8Array => Uint8Array.from({ length }, (_, i) => (i * 7 + seed) % 251);

const sampleTables = (): SyntheticTable[] => [
    { tag: 'zzzz', data: pattern(37, 1), compress: false }, // odd length: padded
    { tag: 'aaaa', data: pattern(4000, 2), compress: true },
    { tag: 'mmmm', data: pattern(1000, 3), compress: true },
];

describe('unwrapWoff on the bundled Plex fonts', () =>
{
    it.each(names)('%s: TrueType flavor, size = totalSfntSize, every table equals an independent decompression', async (name) =>
    {
        const woff = PDF_FONTS[name];
        const sfnt = await unwrapWoff(woff);
        const view = new DataView(sfnt.buffer);
        expect(view.getUint32(0)).toBe(TRUETYPE_FLAVOR);
        expect(sfnt.length).toBe(new DataView(woff.buffer, woff.byteOffset).getUint32(16));

        const entries = woffDirectory(woff);
        const directory = readSfntDirectory(sfnt);
        expect([...directory.tables.keys()]).toEqual(entries.map((entry) => entry.tag).sort((a, b) => tagValue(a) - tagValue(b)));
        expect(directory.tables.has('glyf')).toBe(true); // TrueType outlines
        expect(directory.tables.has('CFF ')).toBe(false);
        for (const entry of entries)
        {
            const stored = woff.subarray(entry.offset, entry.offset + entry.compLength);
            const expected = entry.compLength === entry.origLength ? stored : await inflate(stored);
            expect(tableBytes(sfnt, directory, entry.tag), entry.tag).toEqual(expected);
            expect(directory.tables.get(entry.tag)?.checksum).toBe(entry.origChecksum);
        }
    });

    it.each(names)('%s: binary-search fields and zero padding of the rebuilt sfnt', async (name) =>
    {
        const sfnt = await unwrapWoff(PDF_FONTS[name]);
        const view = new DataView(sfnt.buffer);
        const numTables = view.getUint16(4);
        const searchRange = view.getUint16(6);
        expect(searchRange).toBe(16 * 2 ** Math.floor(Math.log2(numTables)));
        expect(view.getUint16(8)).toBe(Math.floor(Math.log2(numTables)));
        expect(view.getUint16(10)).toBe(16 * numTables - searchRange);
        for (const table of readSfntDirectory(sfnt).tables.values())
        {
            expect(table.offset % 4).toBe(0);
            expect([...sfnt.subarray(table.offset + table.length, table.offset + pad4(table.length))].every((byte) => byte === 0)).toBe(true);
        }
    });

    it('mono-regular comes back byte for byte: its head.checkSumAdjustment matches the rebuilt file', async () =>
    {
        const sfnt = await unwrapWoff(PDF_FONTS['mono-regular']);
        const { stored, computed } = checkSumAdjustment(sfnt, readSfntDirectory(sfnt));
        expect(computed).toBe(stored);
    });
    // The three IBM Plex Sans files carry a stored checkSumAdjustment that
    // matches no layout of their tables (their table checksums are all right),
    // so it is reported, not enforced. PDF readers ignore this field.

    it('does not change its input', async () =>
    {
        const woff = PDF_FONTS['sans-regular'];
        const before = woff.slice();
        await unwrapWoff(woff);
        expect(woff).toEqual(before);
    });
});

describe('unwrapWoff on synthetic files', () =>
{
    it('unwraps raw and compressed tables, an odd length padded, directory sorted by tag', async () =>
    {
        const tables = sampleTables();
        const sfnt = await unwrapWoff(await buildWoff(tables));
        const directory = readSfntDirectory(sfnt);
        expect([...directory.tables.keys()]).toEqual(['aaaa', 'mmmm', 'zzzz']);
        for (const table of tables)
        {
            expect(tableBytes(sfnt, directory, table.tag)).toEqual(table.data);
        }
        expect(sfnt.length).toBe(12 + 16 * 3 + 4000 + 1000 + 40);
        expect(() => checkSumAdjustment(sfnt, directory)).toThrow(/no head table/);
    });

    it('reads a WOFF that is a view into a larger buffer', async () =>
    {
        const woff = await buildWoff(sampleTables());
        const outer = new Uint8Array(woff.length + 9);
        outer.set(woff, 5);
        const sfnt = await unwrapWoff(outer.subarray(5, 5 + woff.length));
        expect(sfnt).toEqual(await unwrapWoff(woff));
    });

    it.each([1, 2, 3, 4, 5, 15, 16, 17])('%i tables: searchRange, entrySelector, rangeShift follow the spec formula', async (count) =>
    {
        const tables = Array.from({ length: count }, (_, i) => ({
            tag: `t${String(i).padStart(3, '0')}`,
            data: pattern(8 + i, i),
            compress: false,
        }));
        const sfnt = await unwrapWoff(await buildWoff(tables));
        const view = new DataView(sfnt.buffer);
        // OpenType: entrySelector = floor(log2(numTables)), searchRange = 16 * 2^entrySelector.
        let entrySelector = 0;
        while (2 ** (entrySelector + 1) <= count)
        {
            entrySelector++;
        }
        expect(view.getUint16(4)).toBe(count);
        expect(view.getUint16(6)).toBe(16 * 2 ** entrySelector);
        expect(view.getUint16(8)).toBe(entrySelector);
        expect(view.getUint16(10)).toBe(16 * count - 16 * 2 ** entrySelector);
        expect(readSfntDirectory(sfnt).tables.size).toBe(count);
    });

    it('4 and 16 tables (powers of two): rangeShift is 0', async () =>
    {
        for (const [count, searchRange, entrySelector] of [
            [4, 64, 2],
            [16, 256, 4],
        ] as const)
        {
            const tables = Array.from({ length: count }, (_, i) => ({ tag: `p${String(i).padStart(3, '0')}`, data: pattern(12, i), compress: false }));
            const view = new DataView((await unwrapWoff(await buildWoff(tables))).buffer);
            expect([view.getUint16(6), view.getUint16(8), view.getUint16(10)]).toEqual([searchRange, entrySelector, 0]);
        }
    });

    it('rejects CFF outlines ("OTTO") with a clear message', async () =>
    {
        await expect(unwrapWoff(await buildWoff(sampleTables(), 0x4f54544f))).rejects.toThrow(/CFF outlines/);
    });
});

/** A damaged-file case: the valid synthetic file, changed by `damage`. */
interface DamageCase {
    name: string;
    damage: (woff: Uint8Array<ArrayBuffer>, view: DataView) => Uint8Array | Promise<Uint8Array>;
    error: RegExp;
}

// Directory entry i of the synthetic file: tables sorted aaaa (0, compressed),
// mmmm (1, compressed), zzzz (2, raw).
const entry = (i: number): number => 44 + 20 * i;

const damageCases: DamageCase[] = [
    { name: 'empty input', damage: () => new Uint8Array(0), error: /truncated/ },
    { name: 'truncated header', damage: (woff) => woff.subarray(0, 30), error: /truncated/ },
    { name: 'truncated file', damage: (woff) => woff.subarray(0, woff.length - 8), error: /header says \d+ bytes but the file has/ },
    { name: 'not a Uint8Array', damage: () => [1, 2, 3] as unknown as Uint8Array, error: /not a Uint8Array/ },
    {
        name: 'wrong signature (WOFF 2)',
        damage: (woff, view) => (view.setUint32(0, 0x774f4632), woff),
        error: /wrong signature "wOF2"/,
    },
    { name: 'unknown flavor', damage: (woff, view) => (view.setUint32(4, 0x74727565), woff), error: /unsupported flavor/ },
    { name: 'zero tables', damage: (woff, view) => (view.setUint16(12, 0), woff), error: /no tables/ },
    { name: 'too many tables', damage: (woff, view) => (view.setUint16(12, 65535), woff), error: /too many tables/ },
    { name: 'directory past the end', damage: (woff, view) => (view.setUint16(12, 60), woff), error: /table directory .* past the end/ },
    { name: 'reserved field set', damage: (woff, view) => (view.setUint16(14, 1), woff), error: /reserved/ },
    {
        name: 'huge totalSfntSize',
        damage: (woff, view) => (view.setUint32(16, 0xffffffff), woff),
        error: new RegExp(`larger than ${MAX_FONT_BYTES}`),
    },
    { name: 'wrong totalSfntSize', damage: (woff, view) => (view.setUint32(16, view.getUint32(16) + 4), woff), error: /tables add up to/ },
    {
        name: 'table offset past the end',
        damage: (woff, view) => (view.setUint32(entry(2) + 4, woff.length + 4), woff),
        error: /table "zzzz" .* past the end/,
    },
    {
        name: 'table offset inside the directory',
        damage: (woff, view) => (view.setUint32(entry(0) + 4, 0), woff),
        error: /inside the header or directory/,
    },
    { name: 'unaligned table offset', damage: (woff, view) => (view.setUint32(entry(2) + 4, view.getUint32(entry(2) + 4) + 1), woff), error: /4-byte boundary/ },
    {
        name: 'huge compLength',
        damage: (woff, view) => (view.setUint32(entry(0) + 8, 0xfffffff0), woff),
        error: /longer compressed than uncompressed|past the end/,
    },
    {
        name: 'huge origLength',
        damage: (woff, view) => (view.setUint32(entry(0) + 12, 0xfffffff0), woff),
        error: new RegExp(`declares \\d+ bytes \\(more than ${MAX_FONT_BYTES}\\)`),
    },
    {
        name: 'compLength above origLength',
        damage: (woff, view) => (view.setUint32(entry(2) + 8, view.getUint32(entry(2) + 12) + 1), woff),
        error: /longer compressed than uncompressed/,
    },
    {
        name: 'overlapping tables',
        damage: (woff, view) => (view.setUint32(entry(1) + 4, view.getUint32(entry(0) + 4)), woff),
        error: /overlap/,
    },
    { name: 'duplicate tag', damage: (woff, view) => (view.setUint32(entry(1), tagValue('aaaa')), woff), error: /appears twice/ },
    {
        name: 'metadata block past the end',
        damage: (woff, view) => (view.setUint32(24, 44 + 60), view.setUint32(28, woff.length), woff),
        error: /metadata block .* past the end/,
    },
    {
        name: 'private block overlapping a table',
        damage: (woff, view) => (view.setUint32(36, view.getUint32(entry(0) + 4)), view.setUint32(40, 8), woff),
        error: /overlap/,
    },
    { name: 'offset without length', damage: (woff, view) => (view.setUint32(24, 100), woff), error: /offset but no length/ },
    {
        name: 'bad zlib data',
        damage: (woff, view) =>
        {
            const offset = view.getUint32(entry(0) + 4);
            woff.fill(0xa5, offset, offset + view.getUint32(entry(0) + 8));
            return woff;
        },
        error: /table "aaaa" has bad zlib data/,
    },
    {
        name: 'decompresses to fewer bytes than origLength',
        damage: (woff, view) =>
        {
            view.setUint32(entry(0) + 12, view.getUint32(entry(0) + 12) + 400);
            view.setUint32(16, view.getUint32(16) + 400);
            return woff;
        },
        error: /decompressed to 4000 bytes, expected 4400/,
    },
    {
        name: 'decompresses to more bytes than origLength',
        damage: (woff, view) =>
        {
            view.setUint32(entry(0) + 12, view.getUint32(entry(0) + 12) - 400);
            view.setUint32(16, view.getUint32(16) - 400);
            return woff;
        },
        error: /more than the declared 3600 bytes/,
    },
    {
        name: 'checksum mismatch in a raw table',
        damage: (woff, view) =>
        {
            const offset = view.getUint32(entry(2) + 4);
            woff[offset] = woff[offset]! ^ 0xff;
            return woff;
        },
        error: /table "zzzz" checksum does not match/,
    },
    {
        name: 'checksum mismatch in a compressed table',
        damage: (woff, view) => (view.setUint32(entry(1) + 16, view.getUint32(entry(1) + 16) ^ 1), woff),
        error: /table "mmmm" checksum does not match/,
    },
];

describe('unwrapWoff on damaged files', () =>
{
    it.each(damageCases)('$name: rejects with a clear FontError', async ({ damage, error }) =>
    {
        const woff = await buildWoff(sampleTables());
        const damaged = await damage(woff, new DataView(woff.buffer));
        const result = unwrapWoff(damaged);
        await expect(result).rejects.toBeInstanceOf(FontError);
        await expect(result).rejects.toThrow(error);
    });

    it('a real font cut short or with one byte changed is rejected', async () =>
    {
        const real = PDF_FONTS['sans-regular'];
        await expect(unwrapWoff(real.subarray(0, 1000))).rejects.toThrow(/header says/);
        const flipped = real.slice();
        const glyf = woffDirectory(real).find((table) => table.tag === 'glyf')!;
        flipped[glyf.offset + 100] = flipped[glyf.offset + 100]! ^ 0x10;
        await expect(unwrapWoff(flipped)).rejects.toThrow(FontError);
    });

    it('fails every damaged case quickly (no hang)', async () =>
    {
        const started = performance.now();
        for (const { damage } of damageCases)
        {
            const woff = await buildWoff(sampleTables());
            await expect(unwrapWoff(await damage(woff, new DataView(woff.buffer)))).rejects.toThrow(FontError);
        }
        expect(performance.now() - started).toBeLessThan(2000);
    }, 5000);
});

describe('readSfntDirectory on damaged fonts', () =>
{
    const sample = async (): Promise<Uint8Array<ArrayBuffer>> => unwrapWoff(await buildWoff(sampleTables()));

    it('rejects a truncated font, a wrong version and zero tables', async () =>
    {
        const sfnt = await sample();
        expect(() => readSfntDirectory(sfnt.subarray(0, 8))).toThrow(/offset table .* past the end/);
        expect(() => readSfntDirectory(sfnt.subarray(0, 40))).toThrow(/table directory .* past the end/);
        expect(() => readSfntDirectory(sfnt.subarray(0, sfnt.length - 20))).toThrow(/table "zzzz" .* past the end/);
        const otto = sfnt.slice();
        new DataView(otto.buffer).setUint32(0, 0x4f54544f);
        expect(() => readSfntDirectory(otto)).toThrow(/unsupported sfnt version "OTTO"/);
        const empty = sfnt.slice();
        new DataView(empty.buffer).setUint16(4, 0);
        expect(() => readSfntDirectory(empty)).toThrow(/no tables/);
    });

    it('rejects overlapping, unaligned and duplicate tables and a wrong checksum', async () =>
    {
        const at = (i: number): number => 12 + 16 * i;
        const change = async (edit: (view: DataView) => void): Promise<Uint8Array> =>
        {
            const sfnt = await sample();
            edit(new DataView(sfnt.buffer));
            return sfnt;
        };
        // mmmm (1000 bytes) made to start 4 bytes into aaaa: its data then differs, so fix its checksum.
        const overlapping = await change((view) => view.setUint32(at(1) + 8, view.getUint32(at(0) + 8) + 4));
        const view = new DataView(overlapping.buffer, overlapping.byteOffset);
        view.setUint32(at(1) + 4, directoryChecksum(tagValue('mmmm'), overlapping, view.getUint32(at(1) + 8), 1000));
        expect(() => readSfntDirectory(overlapping)).toThrow(/tables "aaaa" and "mmmm" overlap/);
        const unaligned = await change((v) => v.setUint32(at(2) + 8, v.getUint32(at(2) + 8) + 2));
        expect(() => readSfntDirectory(unaligned)).toThrow(/4-byte boundary/);
        const duplicate = await change((v) => v.setUint32(at(1), tagValue('aaaa')));
        expect(() => readSfntDirectory(duplicate)).toThrow(/appears twice/);
        const badChecksum = await change((v) => v.setUint32(at(2) + 4, 0));
        expect(() => readSfntDirectory(badChecksum)).toThrow(/checksum does not match/);
        const inDirectory = await change((v) => v.setUint32(at(0) + 8, 0));
        expect(() => readSfntDirectory(inDirectory)).toThrow(/inside the table directory/);
    });
});
