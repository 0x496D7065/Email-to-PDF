// WOFF 1.0 (Web Open Font Format: a font file with each table optionally
// compressed) -> plain sfnt (TrueType) bytes, for embedding in the PDF as
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
// compLength, origLength, origChecksum, numTables, totalSfntSize, flavor,
// searchRange and entrySelector are the WOFF / OpenType spec's field names.
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
// checkSumAdjustment in sfnt-directory.ts).
import {
    BinaryReader,
    directoryChecksum,
    throwFontError,
    MAX_FONT_BYTES,
    MAX_TABLES,
    padToFourBytes,
    tagName,
    toFontError,
    TRUETYPE_FLAVOR
} from './binary-reader';

const WOFF_SIGNATURE = 0x774f4646; // 'wOFF'
const OTTO_FLAVOR = 0x4f54544f; // 'OTTO': CFF outlines
const WOFF_HEADER_BYTES = 44;
const WOFF_ENTRY_BYTES = 20;
const SFNT_HEADER_BYTES = 12;
const SFNT_ENTRY_BYTES = 16;

interface WoffEntry
{
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
        return await convertWoffToSfnt(woff);
    }
    catch (error)
    {
        throw toFontError(error, 'WOFF');
    }
}

async function convertWoffToSfnt(woff: Uint8Array): Promise<Uint8Array<ArrayBuffer>>
{
    if (!(woff instanceof Uint8Array))
    {
        throwFontError('WOFF: input is not a Uint8Array');
    }
    if (woff.length < WOFF_HEADER_BYTES)
    {
        throwFontError(`WOFF: file is truncated (${woff.length} bytes, the header alone is ${WOFF_HEADER_BYTES})`);
    }
    if (woff.length > MAX_FONT_BYTES)
    {
        throwFontError(`WOFF: file is larger than ${MAX_FONT_BYTES} bytes`);
    }
    const reader = new BinaryReader(woff, 'WOFF');

    const signature = reader.readUint32(0);
    if (signature !== WOFF_SIGNATURE)
    {
        throwFontError(`WOFF: wrong signature "${tagName(signature)}" (expected "wOFF")`);
    }
    const flavor = reader.readUint32(4);
    if (flavor === OTTO_FLAVOR)
    {
        throwFontError('WOFF: font has CFF outlines (flavor "OTTO"); only TrueType outlines are supported');
    }
    if (flavor !== TRUETYPE_FLAVOR)
    {
        throwFontError(`WOFF: unsupported flavor 0x${flavor.toString(16).padStart(8, '0')} (expected TrueType 0x00010000)`);
    }
    const length = reader.readUint32(8);
    if (length !== woff.length)
    {
        throwFontError(`WOFF: header says ${length} bytes but the file has ${woff.length} (truncated or padded)`);
    }
    const numTables = reader.readUint16(12);
    if (numTables === 0)
    {
        throwFontError('WOFF: font has no tables');
    }
    if (numTables > MAX_TABLES)
    {
        throwFontError(`WOFF: too many tables (${numTables}, at most ${MAX_TABLES})`);
    }
    if (reader.readUint16(14) !== 0)
    {
        throwFontError('WOFF: reserved header field is not 0');
    }
    const totalSfntSize = reader.readUint32(16);
    if (totalSfntSize > MAX_FONT_BYTES)
    {
        throwFontError(`WOFF: decompressed font would be larger than ${MAX_FONT_BYTES} bytes`);
    }

    const directoryEnd = WOFF_HEADER_BYTES + numTables * WOFF_ENTRY_BYTES;
    reader.requireBytes(WOFF_HEADER_BYTES, numTables * WOFF_ENTRY_BYTES, 'table directory');

    // Regions of the file in use, to reject overlaps: tables and the
    // optional metadata / private blocks.
    const regions: { start: number; end: number; description: string }[] = [];
    const checkOptionalBlock = (offsetAt: number, lengthAt: number, blockName: string): void =>
    {
        const offset = reader.readUint32(offsetAt);
        const size = reader.readUint32(lengthAt);
        if (size === 0)
        {
            if (offset !== 0)
            {
                throwFontError(`WOFF: ${blockName} block has an offset but no length`);
            }
            return;
        }
        if (offset < directoryEnd)
        {
            throwFontError(`WOFF: ${blockName} block starts inside the header or directory`);
        }
        reader.requireBytes(offset, size, `${blockName} block`);
        regions.push({ start: offset, end: offset + size, description: `${blockName} block` });
    };
    checkOptionalBlock(24, 28, 'metadata');
    checkOptionalBlock(36, 40, 'private');

    const entries: WoffEntry[] = [];
    const seenTags = new Set<number>();
    let sfntSizeFromTables = SFNT_HEADER_BYTES + numTables * SFNT_ENTRY_BYTES;
    for (let i = 0; i < numTables; i++)
    {
        const entryAt = WOFF_HEADER_BYTES + i * WOFF_ENTRY_BYTES;
        const entry: WoffEntry = {
            tag: reader.readUint32(entryAt),
            offset: reader.readUint32(entryAt + 4),
            compLength: reader.readUint32(entryAt + 8),
            origLength: reader.readUint32(entryAt + 12),
            origChecksum: reader.readUint32(entryAt + 16),
        };
        const tableLabel = `table "${tagName(entry.tag)}"`;
        if (seenTags.has(entry.tag))
        {
            throwFontError(`WOFF: ${tableLabel} appears twice`);
        }
        seenTags.add(entry.tag);
        if (entry.origLength > MAX_FONT_BYTES)
        {
            throwFontError(`WOFF: ${tableLabel} declares ${entry.origLength} bytes (more than ${MAX_FONT_BYTES})`);
        }
        if (entry.compLength > entry.origLength)
        {
            throwFontError(`WOFF: ${tableLabel} is longer compressed than uncompressed`);
        }
        if (entry.offset < directoryEnd)
        {
            throwFontError(`WOFF: ${tableLabel} starts inside the header or directory`);
        }
        if (entry.offset % 4 !== 0)
        {
            throwFontError(`WOFF: ${tableLabel} does not start on a 4-byte boundary`);
        }
        reader.requireBytes(entry.offset, entry.compLength, tableLabel);
        regions.push({ start: entry.offset, end: entry.offset + entry.compLength, description: tableLabel });
        sfntSizeFromTables += padToFourBytes(entry.origLength);
        entries.push(entry);
    }
    regions.sort((a, b) => a.start - b.start);
    for (let i = 1; i < regions.length; i++)
    {
        const before = regions[i - 1]!;
        const region = regions[i]!;
        if (region.start < before.end)
        {
            throwFontError(`WOFF: ${before.description} and ${region.description} overlap`);
        }
    }
    if (sfntSizeFromTables !== totalSfntSize)
    {
        throwFontError(`WOFF: header says the font is ${totalSfntSize} bytes but its tables add up to ${sfntSizeFromTables}`);
    }

    // Write the sfnt: offset table, directory sorted by tag, tables in file order.
    const sfnt = new Uint8Array(totalSfntSize);
    const sfntView = new DataView(sfnt.buffer);
    sfntView.setUint32(0, flavor);
    sfntView.setUint16(4, numTables);
    let entrySelector = 0;
    while (2 << entrySelector <= numTables)
    {
        entrySelector++; // numTables <= MAX_TABLES: a few steps
    }
    const searchRange = (1 << entrySelector) * SFNT_ENTRY_BYTES;
    sfntView.setUint16(6, searchRange);
    sfntView.setUint16(8, entrySelector);
    sfntView.setUint16(10, numTables * SFNT_ENTRY_BYTES - searchRange);

    const sfntOffsets = new Map<WoffEntry, number>();
    let position = SFNT_HEADER_BYTES + numTables * SFNT_ENTRY_BYTES;
    for (const entry of [...entries].sort((a, b) => a.offset - b.offset))
    {
        sfntOffsets.set(entry, position);
        const storedBytes = woff.subarray(entry.offset, entry.offset + entry.compLength);
        if (entry.compLength === entry.origLength)
        {
            sfnt.set(storedBytes, position);
        }
        else
        {
            await inflateInto(storedBytes, entry.origLength, sfnt, position, tagName(entry.tag));
        }
        const checksum = directoryChecksum(entry.tag, sfnt, position, entry.origLength);
        if (checksum !== entry.origChecksum)
        {
            throwFontError(`WOFF: table "${tagName(entry.tag)}" checksum does not match (damaged data)`);
        }
        position += padToFourBytes(entry.origLength);
    }

    [...entries]
        .sort((a, b) => a.tag - b.tag)
        .forEach((entry, i) =>
        {
            const entryAt = SFNT_HEADER_BYTES + i * SFNT_ENTRY_BYTES;
            sfntView.setUint32(entryAt, entry.tag);
            sfntView.setUint32(entryAt + 4, entry.origChecksum);
            sfntView.setUint32(entryAt + 8, sfntOffsets.get(entry)!);
            sfntView.setUint32(entryAt + 12, entry.origLength);
        });
    return sfnt;
}

/**
 * Inflates one zlib-compressed table straight into `target` at `position`.
 * Fails as soon as the output would pass `expectedLength` bytes (so a "zip bomb"
 * cannot grow memory), and when it ends short of `expectedLength`.
 */
async function inflateInto(storedBytes: Uint8Array, expectedLength: number, target: Uint8Array, position: number, tag: string): Promise<void>
{
    const tableLabel = `table "${tag}"`;
    // A copy, so the stream gets a plain ArrayBuffer-backed chunk of its own.
    const stream = new Blob([storedBytes.slice()]).stream().pipeThrough(new DecompressionStream('deflate'));
    const reader = stream.getReader();
    let written = 0;
    try
    {
        // Each non-empty chunk adds at least 1 byte and the total is capped at
        // `expectedLength`, so this loop ends; the extra allowance covers empty chunks.
        for (let readCount = 0; readCount <= expectedLength + 64; readCount++)
        {
            let chunk: ReadableStreamReadResult<Uint8Array>;
            try
            {
                chunk = await reader.read();
            }
            catch (error)
            {
                throw toFontError(error, `WOFF: ${tableLabel} has bad zlib data`);
            }
            if (chunk.done)
            {
                if (written !== expectedLength)
                {
                    throwFontError(`WOFF: ${tableLabel} decompressed to ${written} bytes, expected ${expectedLength}`);
                }
                return;
            }
            const bytes = chunk.value;
            if (written + bytes.length > expectedLength)
            {
                throwFontError(`WOFF: ${tableLabel} decompresses to more than the declared ${expectedLength} bytes`);
            }
            target.set(bytes, position + written);
            written += bytes.length;
        }
        throwFontError(`WOFF: ${tableLabel} decompression did not finish`);
    }
    finally
    {
        // Stops the stream after an early exit; harmless once it is done.
        reader.cancel().catch(() => undefined);
    }
}
