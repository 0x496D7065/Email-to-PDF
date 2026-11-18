// The table directory of a plain sfnt (TrueType) font: where each table is,
// checked for bounds, alignment, overlaps, duplicates and checksums
// (pure, as in rule R7; no DOM). The font reader's other modules only
// ever reach a table through readSfntDirectory.
// "sfnt" is the OpenType spec's name for this file structure (a directory
// of tagged tables); numTables is the spec's field name.
import {
    BinaryReader,
    directoryChecksum,
    throwFontError,
    MAX_FONT_BYTES,
    MAX_TABLES,
    tableChecksum,
    TAG_HEAD,
    tagName,
    TRUETYPE_FLAVOR,
} from './binary-reader';

export interface SfntTable
{
    /** The tag as text, e.g. "head", "cvt " (with its trailing space). */
    readonly tag: string;
    readonly offset: number;
    readonly length: number;
    /** The checksum stored in the directory (verified against the data). */
    readonly checksum: number;
}

export interface SfntDirectory
{
    /** The sfnt version: always 0x00010000 (TrueType outlines) here. */
    readonly flavor: number;
    /** The tables by tag, in directory order. */
    readonly tables: ReadonlyMap<string, SfntTable>;
}

const SFNT_HEADER_BYTES = 12;
const SFNT_ENTRY_BYTES = 16;

/**
 * Reads and checks the table directory of a TrueType font. Throws a
 * FontError for anything damaged: a table past the end, overlapping
 * another, not 4-byte aligned, listed twice, or with a wrong checksum.
 */
export function readSfntDirectory(sfnt: Uint8Array): SfntDirectory
{
    if (!(sfnt instanceof Uint8Array))
    {
        throwFontError('font: input is not a Uint8Array');
    }
    if (sfnt.length > MAX_FONT_BYTES)
    {
        throwFontError(`font: larger than ${MAX_FONT_BYTES} bytes`);
    }
    const reader = new BinaryReader(sfnt, 'font');
    reader.requireBytes(0, SFNT_HEADER_BYTES, 'offset table');
    const flavor = reader.readUint32(0);
    if (flavor !== TRUETYPE_FLAVOR)
    {
        throwFontError(`font: unsupported sfnt version "${tagName(flavor)}" (expected TrueType 0x00010000)`);
    }
    const numTables = reader.readUint16(4);
    if (numTables === 0)
    {
        throwFontError('font: has no tables');
    }
    if (numTables > MAX_TABLES)
    {
        throwFontError(`font: too many tables (${numTables}, at most ${MAX_TABLES})`);
    }
    const directoryEnd = SFNT_HEADER_BYTES + numTables * SFNT_ENTRY_BYTES;
    reader.requireBytes(SFNT_HEADER_BYTES, numTables * SFNT_ENTRY_BYTES, 'table directory');

    const tables = new Map<string, SfntTable>();
    for (let i = 0; i < numTables; i++)
    {
        const entryAt = SFNT_HEADER_BYTES + i * SFNT_ENTRY_BYTES;
        const tagValue = reader.readUint32(entryAt);
        const table: SfntTable = {
            tag: tagName(tagValue),
            checksum: reader.readUint32(entryAt + 4),
            offset: reader.readUint32(entryAt + 8),
            length: reader.readUint32(entryAt + 12)
        };
        const tableLabel = `table "${table.tag}"`;
        if (tables.has(table.tag))
        {
            throwFontError(`font: ${tableLabel} appears twice`);
        }
        if (table.offset < directoryEnd)
        {
            throwFontError(`font: ${tableLabel} starts inside the table directory`);
        }
        if (table.offset % 4 !== 0)
        {
            throwFontError(`font: ${tableLabel} does not start on a 4-byte boundary`);
        }
        reader.requireBytes(table.offset, table.length, tableLabel);
        if (directoryChecksum(tagValue, sfnt, table.offset, table.length) !== table.checksum)
        {
            throwFontError(`font: ${tableLabel} checksum does not match (damaged data)`);
        }
        tables.set(table.tag, table);
    }
    const tablesByOffset = [...tables.values()].sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < tablesByOffset.length; i++)
    {
        const before = tablesByOffset[i - 1]!;
        const table = tablesByOffset[i]!;
        if (table.offset < before.offset + before.length)
        {
            throwFontError(`font: tables "${before.tag}" and "${table.tag}" overlap`);
        }
    }
    return { flavor, tables };
}

/** The bytes of one table (a view, not a copy), or undefined when the font has none. */
export function tableBytes(sfnt: Uint8Array, directory: SfntDirectory, tag: string): Uint8Array | undefined
{
    const table = directory.tables.get(tag);
    return table === undefined ? undefined : sfnt.subarray(table.offset, table.offset + table.length);
}

/**
 * head.checkSumAdjustment as stored, and the value the OpenType spec says it
 * should have for these exact bytes (0xB1B0AFBA minus the checksum of the
 * whole font with the field taken as 0). Informational only: PDF readers do
 * not check it, and the reader never rewrites it, so the embedded font keeps
 * the official table bytes. Some official fonts carry a stale value.
 */
export function checkSumAdjustment(sfnt: Uint8Array, directory: SfntDirectory): { stored: number; computed: number }
{
    const head = directory.tables.get(tagName(TAG_HEAD));
    if (head === undefined || head.length < 12)
    {
        throwFontError('font: no head table');
    }
    const stored = new BinaryReader(sfnt, 'font').readUint32(head.offset + 8);
    const wholeFontChecksum = (tableChecksum(sfnt, 0, sfnt.length) - stored) >>> 0;
    return { stored, computed: (0xb1b0afba - wholeFontChecksum) >>> 0 };
}
