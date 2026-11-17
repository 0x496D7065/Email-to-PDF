// A cheap safety check of a .msg file's container BEFORE msgreader reads it.
//
// A .msg file is a "Compound File" ([MS-CFB]): a small file system inside one
// file. It is cut into fixed-size sectors; a table (the FAT) says, for each
// sector, which sector comes next, so each stream (a "file" inside) is a
// chain of sectors. Small streams live in a "mini stream" with its own table
// (the mini FAT). A directory of 128-byte entries names every stream and
// storage (folder), with its first sector and its size, and links the
// entries into trees.
//
// msgreader trusts all of this. On a damaged or hostile file it can:
// - follow a sector chain that loops back on itself forever, filling an
//   array until the tab runs out of memory (the directory chain, the mini
//   stream chain, a small stream's chain);
// - follow a loop in the directory tree forever, the same way;
// - reserve a buffer as large as a stream's declared size
//   (`new Uint8Array(size)`), up to 4 GB for a damaged size field.
// try/catch cannot reliably stop any of them. This check rejects such files
// first. It is NOT a full reader: it follows the chains and links msgreader
// will follow (and is stricter where that is cheap: it checks every stream
// entry, reachable or not), marks every sector it visits, and stops at the
// first problem. Every loop below visits each sector or entry at most once,
// so the check takes time proportional to the file size, whatever the file
// says.
//
// The parse also runs in a Web Worker with a time limit (see
// worker-runner.ts), so a parser stuck in a loop this check misses is
// stopped. That is a second line, not a full one: a real heap exhaustion in
// the worker can still take down the tab before the time limit, which is why
// this check runs first.

/** Special sector numbers ([MS-CFB] 2.1). */
const END_OF_CHAIN = 0xfffffffe;
const FREE_SECTOR = 0xffffffff;
/** "No entry" in the directory tree links. */
const NO_STREAM = 0xffffffff;

/** Directory entry types ([MS-CFB] 2.6.1). */
const STORAGE = 1;
const STREAM = 2;
const ROOT = 5;

const DIRECTORY_ENTRY_SIZE = 128;
const MINI_SECTOR_SIZE = 64;
/** Streams smaller than this live in the mini stream ([MS-CFB] 2.2, always 4096). */
const MINI_STREAM_CUTOFF = 4096;
/** The header holds the first 109 FAT sector numbers itself. */
const HEADER_DIFAT_ENTRIES = 109;

/** Why the check stopped. Caught inside findCfbDamage, never thrown out of it. */
class Damage extends Error
{
}

/**
 * Checks the Compound File structure of `bytes` (which must start with the
 * Compound File signature, see file-type.ts). Returns null if msgreader can
 * safely read it, or a short reason for the preview ("damaged file
 * structure: ...").
 */
export function findCfbDamage(bytes: Uint8Array): string | null
{
    try
    {
        checkStructure(bytes);
        return null;
    }
    catch (error)
    {
        if (error instanceof Damage)
        {
            return `damaged file structure: ${error.message}`;
        }
        throw error;
    }
}

function checkStructure(bytes: Uint8Array): void
{
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const fileLength = bytes.byteLength;
    const u16 = (offset: number): number =>
    {
        if (offset + 2 > fileLength)
        {
            throw new Damage('the file is cut off');
        }
        return view.getUint16(offset, true);
    };
    const u32 = (offset: number): number =>
    {
        if (offset + 4 > fileLength)
        {
            throw new Damage('the file is cut off');
        }
        return view.getUint32(offset, true);
    };

    // --- Header ([MS-CFB] 2.2) ---
    if (fileLength < 512)
    {
        throw new Damage('the file is too short');
    }
    const sectorShift = u16(0x1e);
    if (sectorShift !== 9 && sectorShift !== 12)
    {
        throw new Damage('impossible sector size');
    }
    if (u16(0x20) !== 6 || u32(0x38) !== MINI_STREAM_CUTOFF)
    {
        throw new Damage('impossible mini sector size');
    }
    const sectorSize = 2 ** sectorShift;
    if (fileLength < sectorSize)
    {
        throw new Damage('the file is too short');
    }
    // Sector n starts at byte (n + 1) * sectorSize (the header fills sector -1).
    // A last sector cut short is allowed; reading past the end is caught by u32.
    const sectorCount = Math.ceil((fileLength - sectorSize) / sectorSize);
    const entriesPerSector = sectorSize / 4;

    const fatSectorCount = u32(0x2c);
    const miniFatSectorCount = u32(0x40);
    const difatSectorCount = u32(0x48);
    // Each of these tables is made of sectors of this file, so it cannot have
    // more sectors than the file. A larger count is a damaged field.
    if (fatSectorCount > sectorCount || miniFatSectorCount > sectorCount || difatSectorCount > sectorCount)
    {
        throw new Damage('impossible sector count');
    }

    // --- Where the FAT sectors are: the header list, then the DIFAT chain ---
    const fatSectors: number[] = [];
    for (let i = 0; i < Math.min(fatSectorCount, HEADER_DIFAT_ENTRIES); i++)
    {
        fatSectors.push(u32(0x4c + 4 * i));
    }
    let difat = u32(0x44);
    for (let i = 0; i < difatSectorCount && fatSectors.length < fatSectorCount; i++)
    {
        if (difat >= sectorCount)
        {
            throw new Damage('a sector chain points outside the file');
        }
        const base = (difat + 1) * sectorSize;
        for (let j = 0; j < entriesPerSector - 1 && fatSectors.length < fatSectorCount; j++)
        {
            fatSectors.push(u32(base + 4 * j));
        }
        difat = u32(base + 4 * (entriesPerSector - 1));
    }
    if (fatSectors.some((sector) => sector >= sectorCount))
    {
        throw new Damage('a sector chain points outside the file');
    }

    /** The FAT entry of `sector`: the next sector of its chain. */
    const nextSector = (sector: number): number =>
    {
        const fatSector = fatSectors[Math.floor(sector / entriesPerSector)];
        if (fatSector === undefined)
        {
            throw new Damage('a sector chain points outside the sector table');
        }
        return u32((fatSector + 1) * sectorSize + 4 * (sector % entriesPerSector));
    };

    // One mark per sector: a sector belongs to at most one chain. A sector seen
    // twice means a chain loops back on itself or two chains overlap; both are
    // damage, and the mark is what keeps every walk finite.
    const used = new Uint8Array(sectorCount);
    /** Follows the chain from `start`, returns its sectors in order. */
    const walkChain = (start: number): number[] =>
    {
        const chain: number[] = [];
        if (start === END_OF_CHAIN || start === FREE_SECTOR)
        {
            return chain;
        }
        for (let sector = start; sector !== END_OF_CHAIN; sector = nextSector(sector))
        {
            if (sector >= sectorCount)
            {
                throw new Damage('a sector chain points outside the file');
            }
            if (used[sector] === 1)
            {
                throw new Damage('a sector chain loops back on itself');
            }
            used[sector] = 1;
            chain.push(sector);
        }
        return chain;
    };

    // --- Directory ([MS-CFB] 2.6) ---
    const directorySectors = walkChain(u32(0x30));
    const entriesPerDirectorySector = sectorSize / DIRECTORY_ENTRY_SIZE;
    const entryCount = directorySectors.length * entriesPerDirectorySector;
    if (entryCount === 0)
    {
        throw new Damage('the directory is missing');
    }
    const entryOffset = (index: number): number =>
    {
        const sector = directorySectors[Math.floor(index / entriesPerDirectorySector)] ?? 0;
        return (sector + 1) * sectorSize + (index % entriesPerDirectorySector) * DIRECTORY_ENTRY_SIZE;
    };
    const entryType = (index: number): number =>
    {
        const offset = entryOffset(index) + 0x42;
        if (offset >= fileLength)
        {
            throw new Damage('the file is cut off');
        }
        return bytes[offset] ?? 0;
    };
    /**
     * The declared size of a stream. Only the low 32 bits are read, as
     * msgreader does; in a version 4 file (4096-byte sectors) the high 32 bits
     * must be 0, else the size is over 4 GB.
     */
    const streamSize = (index: number): number =>
    {
        const offset = entryOffset(index);
        if (sectorSize === 4096 && u32(offset + 0x7c) !== 0)
        {
            throw new Damage('a stream is declared larger than the file');
        }
        return u32(offset + 0x78);
    };

    if (entryType(0) !== ROOT)
    {
        throw new Damage('the root entry is missing');
    }
    // msgreader keeps the left/right links of EVERY root-type entry and follows
    // them if the entry is reached from the tree, but the walk below only
    // expects one root, at index 0. A second one is damage ([MS-CFB] 2.6.1:
    // exactly one root entry), so it is rejected outright.
    for (let index = 1; index < entryCount; index++)
    {
        if (entryType(index) === ROOT)
        {
            throw new Damage('a second root entry');
        }
    }

    // --- Directory tree: no loops, no links outside the directory ---
    // msgreader walks the root's children (a binary tree linked by left/right),
    // follows the left/right links of every storage, stream and root entry it
    // reaches, and goes down into every storage. The only root is entry 0 (see
    // above), which is marked already, so storages and streams are all that
    // the walk can reach. One mark per entry: an entry reached twice means a
    // loop.
    const seen = new Uint8Array(entryCount);
    seen[0] = 1;
    const pending: number[] = [u32(entryOffset(0) + 0x4c)];
    while (pending.length > 0)
    {
        const index = pending.pop() ?? NO_STREAM;
        if (index === NO_STREAM)
        {
            continue;
        }
        if (index >= entryCount)
        {
            throw new Damage('a directory entry points outside the directory');
        }
        if (seen[index] === 1)
        {
            throw new Damage('the directory tree loops back on itself');
        }
        seen[index] = 1;
        const type = entryType(index);
        // msgreader ignores the links of unused entries (type 0) and of unknown
        // types (it replaces them with "no entry").
        if (type !== STORAGE && type !== STREAM)
        {
            continue;
        }
        const offset = entryOffset(index);
        pending.push(u32(offset + 0x44), u32(offset + 0x48));
        if (type === STORAGE)
        {
            pending.push(u32(offset + 0x4c));
        }
    }

    // --- The mini stream (root entry) and the mini FAT ---
    const miniStreamSize = streamSize(0);
    if (miniStreamSize > fileLength)
    {
        throw new Damage('a stream is declared larger than the file');
    }
    const miniStreamSectors = walkChain(u32(entryOffset(0) + 0x74));
    if (miniStreamSectors.length * sectorSize < miniStreamSize)
    {
        throw new Damage('a stream is longer than its sector chain');
    }
    const miniSectorCount = Math.floor((miniStreamSectors.length * sectorSize) / MINI_SECTOR_SIZE);
    const miniFatSectors = walkChain(u32(0x3c));
    const nextMiniSector = (sector: number): number =>
    {
        const fatSector = miniFatSectors[Math.floor(sector / entriesPerSector)];
        if (fatSector === undefined)
        {
            throw new Damage('a sector chain points outside the sector table');
        }
        return u32((fatSector + 1) * sectorSize + 4 * (sector % entriesPerSector));
    };
    const miniUsed = new Uint8Array(miniSectorCount);
    /** Follows the mini chain from `start`, returns its length in mini sectors. */
    const walkMiniChain = (start: number): number =>
    {
        let length = 0;
        for (let sector = start; sector !== END_OF_CHAIN; sector = nextMiniSector(sector))
        {
            if (sector >= miniSectorCount)
            {
                throw new Damage('a sector chain points outside the file');
            }
            if (miniUsed[sector] === 1)
            {
                throw new Damage('a sector chain loops back on itself');
            }
            miniUsed[sector] = 1;
            length++;
        }
        return length;
    };

    // --- Every stream: size within the file, chain without loops, chain long
    // enough for the size (else msgreader would read past the chain's end) ---
    for (let index = 1; index < entryCount; index++)
    {
        if (entryType(index) !== STREAM)
        {
            continue;
        }
        const size = streamSize(index);
        if (size > fileLength)
        {
            throw new Damage('a stream is declared larger than the file');
        }
        if (size === 0)
        {
            continue; // msgreader reads nothing for an empty stream
        }
        const start = u32(entryOffset(index) + 0x74);
        const capacity =
            size < MINI_STREAM_CUTOFF ? walkMiniChain(start) * MINI_SECTOR_SIZE : walkChain(start).length * sectorSize;
        if (capacity < size)
        {
            throw new Damage('a stream is longer than its sector chain');
        }
    }
}
