// The table directory of a plain sfnt (TrueType) font: where each table is,
// checked for bounds, alignment, overlaps, duplicates and checksums
// (pure, as in rule R7; no DOM). The font reader's other modules only
// ever reach a table through readSfntDirectory.
import {
    BinaryReader,
    directoryChecksum,
    fail,
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

const SFNT_HEADER = 12;
const SFNT_ENTRY = 16;

/**
 * Reads and checks the table directory of a TrueType font. Throws a
 * FontError for anything damaged: a table past the end, overlapping
 * another, not 4-byte aligned, listed twice, or with a wrong checksum.
 */
export function readSfntDirectory(sfnt: Uint8Array): SfntDirectory
{
    if (!(sfnt instanceof Uint8Array))
    {
        fail('font: input is not a Uint8Array');
    }
    if (sfnt.length > MAX_FONT_BYTES)
    {
        fail(`font: larger than ${MAX_FONT_BYTES} bytes`);
    }
    const r = new BinaryReader(sfnt, 'font');
    r.need(0, SFNT_HEADER, 'offset table');
    const flavor = r.u32(0);
    if (flavor !== TRUETYPE_FLAVOR)
    {
        fail(`font: unsupported sfnt version "${tagName(flavor)}" (expected TrueType 0x00010000)`);
    }
    const numTables = r.u16(4);
    if (numTables === 0)
    {
        fail('font: has no tables');
    }
    if (numTables > MAX_TABLES)
    {
        fail(`font: too many tables (${numTables}, at most ${MAX_TABLES})`);
    }
    const directoryEnd = SFNT_HEADER + numTables * SFNT_ENTRY;
    r.need(SFNT_HEADER, numTables * SFNT_ENTRY, 'table directory');

    const tables = new Map<string, SfntTable>();
    for (let i = 0; i < numTables; i++)
    {
        const at = SFNT_HEADER + i * SFNT_ENTRY;
        const tagValue = r.u32(at);
        const table: SfntTable = { tag: tagName(tagValue), checksum: r.u32(at + 4), offset: r.u32(at + 8), length: r.u32(at + 12) };
        const name = `table "${table.tag}"`;
        if (tables.has(table.tag))
        {
            fail(`font: ${name} appears twice`);
        }
        if (table.offset < directoryEnd)
        {
            fail(`font: ${name} starts inside the table directory`);
        }
        if (table.offset % 4 !== 0)
        {
            fail(`font: ${name} does not start on a 4-byte boundary`);
        }
        r.need(table.offset, table.length, name);
        if (directoryChecksum(tagValue, sfnt, table.offset, table.length) !== table.checksum)
        {
            fail(`font: ${name} checksum does not match (damaged data)`);
        }
        tables.set(table.tag, table);
    }
    const byOffset = [...tables.values()].sort((a, b) => a.offset - b.offset);
    for (let i = 1; i < byOffset.length; i++)
    {
        const before = byOffset[i - 1]!;
        const table = byOffset[i]!;
        if (table.offset < before.offset + before.length)
        {
            fail(`font: tables "${before.tag}" and "${table.tag}" overlap`);
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
        fail('font: no head table');
    }
    const stored = new BinaryReader(sfnt, 'font').u32(head.offset + 8);
    const whole = (tableChecksum(sfnt, 0, sfnt.length) - stored) >>> 0;
    return { stored, computed: (0xb1b0afba - whole) >>> 0 };
}
