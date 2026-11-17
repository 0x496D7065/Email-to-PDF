// WOFF 1.0 -> plain sfnt (TrueType) bytes, for embedding in the PDF as
// FontFile2 (the PDF writer, milestone 5.4b). Fonts are the bundled IBM Plex
// files only (README.md, rule R1: never loaded from the network), but the
// reader is strict anyway: every count, offset and length is checked before
// use, and nothing is allocated before the sizes are known to add up.
//
// WOFF 1.0 (W3C Recommendation) in short: a 44-byte header, a directory of
// 20-byte entries (tag, offset, compLength, origLength, origChecksum), then
// each table either stored as it is (compLength == origLength) or compressed
// with zlib (compLength < origLength). Optional metadata and private blocks
// follow; they are not part of the font and are checked for bounds only.
//
// Decompression uses the platform's DecompressionStream('deflate') (the
// zlib format), available in browsers, workers and Node 22: no dependency
// and no hand-written inflate.
//
// The rebuilt sfnt: offset table + table directory sorted by tag + the
// tables, each 4-byte aligned with zero padding, in the same order as their
// data in the WOFF file (the WOFF spec asks encoders to keep the original
// order). The table bytes come back unchanged; the directory is rebuilt.
// head.checkSumAdjustment is kept as stored, so it can be stale (see
// checkSumAdjustment in sfnt.ts).
import { BinaryReader, directoryChecksum, fail, MAX_FONT_BYTES, MAX_TABLES, pad4, tagName, toFontError, TRUETYPE_FLAVOR } from './binary';

const WOFF_SIGNATURE = 0x774f4646; // 'wOFF'
const OTTO_FLAVOR = 0x4f54544f; // 'OTTO': CFF outlines
const WOFF_HEADER = 44;
const WOFF_ENTRY = 20;
const SFNT_HEADER = 12;
const SFNT_ENTRY = 16;

interface WoffEntry {
    readonly tag: number;
    readonly offset: number;
    readonly compLength: number;
    readonly origLength: number;
    readonly origChecksum: number;
}

/**
 * Unwraps a WOFF 1.0 file into the TrueType font it holds. Resolves to new
 * bytes (the input is not changed); rejects with a FontError when the file
 * is damaged, not WOFF 1.0, or not TrueType-flavored.
 */
export async function unwrapWoff(woff: Uint8Array): Promise<Uint8Array<ArrayBuffer>>
{
    try
    {
        return await unwrap(woff);
    }
    catch (error)
    {
        throw toFontError(error, 'WOFF');
    }
}

async function unwrap(woff: Uint8Array): Promise<Uint8Array<ArrayBuffer>>
{
    if (!(woff instanceof Uint8Array))
    {
        fail('WOFF: input is not a Uint8Array');
    }
    if (woff.length < WOFF_HEADER)
    {
        fail(`WOFF: file is truncated (${woff.length} bytes, the header alone is ${WOFF_HEADER})`);
    }
    if (woff.length > MAX_FONT_BYTES)
    {
        fail(`WOFF: file is larger than ${MAX_FONT_BYTES} bytes`);
    }
    const r = new BinaryReader(woff, 'WOFF');

    const signature = r.u32(0);
    if (signature !== WOFF_SIGNATURE)
    {
        fail(`WOFF: wrong signature "${tagName(signature)}" (expected "wOFF")`);
    }
    const flavor = r.u32(4);
    if (flavor === OTTO_FLAVOR)
    {
        fail('WOFF: font has CFF outlines (flavor "OTTO"); only TrueType outlines are supported');
    }
    if (flavor !== TRUETYPE_FLAVOR)
    {
        fail(`WOFF: unsupported flavor 0x${flavor.toString(16).padStart(8, '0')} (expected TrueType 0x00010000)`);
    }
    const length = r.u32(8);
    if (length !== woff.length)
    {
        fail(`WOFF: header says ${length} bytes but the file has ${woff.length} (truncated or padded)`);
    }
    const numTables = r.u16(12);
    if (numTables === 0)
    {
        fail('WOFF: font has no tables');
    }
    if (numTables > MAX_TABLES)
    {
        fail(`WOFF: too many tables (${numTables}, at most ${MAX_TABLES})`);
    }
    if (r.u16(14) !== 0)
    {
        fail('WOFF: reserved header field is not 0');
    }
    const totalSfntSize = r.u32(16);
    if (totalSfntSize > MAX_FONT_BYTES)
    {
        fail(`WOFF: decompressed font would be larger than ${MAX_FONT_BYTES} bytes`);
    }

    const directoryEnd = WOFF_HEADER + numTables * WOFF_ENTRY;
    r.need(WOFF_HEADER, numTables * WOFF_ENTRY, 'table directory');

    // Regions of the file in use, to reject overlaps: tables and the
    // optional metadata / private blocks.
    const regions: { start: number; end: number; what: string }[] = [];
    const optionalBlock = (offsetAt: number, lengthAt: number, what: string): void =>
    {
        const offset = r.u32(offsetAt);
        const size = r.u32(lengthAt);
        if (size === 0)
        {
            if (offset !== 0)
            {
                fail(`WOFF: ${what} block has an offset but no length`);
            }
            return;
        }
        if (offset < directoryEnd)
        {
            fail(`WOFF: ${what} block starts inside the header or directory`);
        }
        r.need(offset, size, `${what} block`);
        regions.push({ start: offset, end: offset + size, what: `${what} block` });
    };
    optionalBlock(24, 28, 'metadata');
    optionalBlock(36, 40, 'private');

    const entries: WoffEntry[] = [];
    const tags = new Set<number>();
    let sfntSize = SFNT_HEADER + numTables * SFNT_ENTRY;
    for (let i = 0; i < numTables; i++)
    {
        const at = WOFF_HEADER + i * WOFF_ENTRY;
        const entry: WoffEntry = {
            tag: r.u32(at),
            offset: r.u32(at + 4),
            compLength: r.u32(at + 8),
            origLength: r.u32(at + 12),
            origChecksum: r.u32(at + 16),
        };
        const name = `table "${tagName(entry.tag)}"`;
        if (tags.has(entry.tag))
        {
            fail(`WOFF: ${name} appears twice`);
        }
        tags.add(entry.tag);
        if (entry.origLength > MAX_FONT_BYTES)
        {
            fail(`WOFF: ${name} declares ${entry.origLength} bytes (more than ${MAX_FONT_BYTES})`);
        }
        if (entry.compLength > entry.origLength)
        {
            fail(`WOFF: ${name} is longer compressed than uncompressed`);
        }
        if (entry.offset < directoryEnd)
        {
            fail(`WOFF: ${name} starts inside the header or directory`);
        }
        if (entry.offset % 4 !== 0)
        {
            fail(`WOFF: ${name} does not start on a 4-byte boundary`);
        }
        r.need(entry.offset, entry.compLength, name);
        regions.push({ start: entry.offset, end: entry.offset + entry.compLength, what: name });
        sfntSize += pad4(entry.origLength);
        entries.push(entry);
    }
    regions.sort((a, b) => a.start - b.start);
    for (let i = 1; i < regions.length; i++)
    {
        const before = regions[i - 1]!;
        const region = regions[i]!;
        if (region.start < before.end)
        {
            fail(`WOFF: ${before.what} and ${region.what} overlap`);
        }
    }
    if (sfntSize !== totalSfntSize)
    {
        fail(`WOFF: header says the font is ${totalSfntSize} bytes but its tables add up to ${sfntSize}`);
    }

    // Write the sfnt: offset table, directory sorted by tag, tables in file order.
    const sfnt = new Uint8Array(totalSfntSize);
    const out = new DataView(sfnt.buffer);
    out.setUint32(0, flavor);
    out.setUint16(4, numTables);
    let entrySelector = 0;
    while (2 << entrySelector <= numTables)
    {
        entrySelector++; // numTables <= MAX_TABLES: a few steps
    }
    const searchRange = (1 << entrySelector) * SFNT_ENTRY;
    out.setUint16(6, searchRange);
    out.setUint16(8, entrySelector);
    out.setUint16(10, numTables * SFNT_ENTRY - searchRange);

    const placed = new Map<WoffEntry, number>();
    let position = SFNT_HEADER + numTables * SFNT_ENTRY;
    for (const entry of [...entries].sort((a, b) => a.offset - b.offset))
    {
        placed.set(entry, position);
        const data = woff.subarray(entry.offset, entry.offset + entry.compLength);
        if (entry.compLength === entry.origLength)
        {
            sfnt.set(data, position);
        }
        else
        {
            await inflateInto(data, entry.origLength, sfnt, position, tagName(entry.tag));
        }
        const checksum = directoryChecksum(entry.tag, sfnt, position, entry.origLength);
        if (checksum !== entry.origChecksum)
        {
            fail(`WOFF: table "${tagName(entry.tag)}" checksum does not match (damaged data)`);
        }
        position += pad4(entry.origLength);
    }

    [...entries]
        .sort((a, b) => a.tag - b.tag)
        .forEach((entry, i) =>
        {
            const at = SFNT_HEADER + i * SFNT_ENTRY;
            out.setUint32(at, entry.tag);
            out.setUint32(at + 4, entry.origChecksum);
            out.setUint32(at + 8, placed.get(entry)!);
            out.setUint32(at + 12, entry.origLength);
        });
    return sfnt;
}

/**
 * Inflates one zlib-compressed table straight into `target` at `position`.
 * Fails as soon as the output would pass `expected` bytes (so a "zip bomb"
 * cannot grow memory), and when it ends short of `expected`.
 */
async function inflateInto(data: Uint8Array, expected: number, target: Uint8Array, position: number, tag: string): Promise<void>
{
    const what = `table "${tag}"`;
    // A copy, so the stream gets a plain ArrayBuffer-backed chunk of its own.
    const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream('deflate'));
    const reader = stream.getReader();
    let written = 0;
    try
    {
        // Each non-empty chunk adds at least 1 byte and the total is capped at
        // `expected`, so this loop ends; the extra allowance covers empty chunks.
        for (let reads = 0; reads <= expected + 64; reads++)
        {
            let chunk: ReadableStreamReadResult<Uint8Array>;
            try
            {
                chunk = await reader.read();
            }
            catch (error)
            {
                throw toFontError(error, `WOFF: ${what} has bad zlib data`);
            }
            if (chunk.done)
            {
                if (written !== expected)
                {
                    fail(`WOFF: ${what} decompressed to ${written} bytes, expected ${expected}`);
                }
                return;
            }
            const bytes = chunk.value;
            if (written + bytes.length > expected)
            {
                fail(`WOFF: ${what} decompresses to more than the declared ${expected} bytes`);
            }
            target.set(bytes, position + written);
            written += bytes.length;
        }
        fail(`WOFF: ${what} decompression did not finish`);
    }
    finally
    {
        // Stops the stream after an early exit; harmless once it is done.
        reader.cancel().catch(() => undefined);
    }
}
