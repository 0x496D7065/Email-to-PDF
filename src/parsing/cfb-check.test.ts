// Unit tests for the Compound File pre-check (cfb-check.ts). Every .msg is
// built in memory from synthetic specs (tests/fixtures/msg/builder.ts), then
// damaged byte by byte here. Nothing is read from disk.
//
// The damaged files below are exactly the kind that make msgreader loop
// forever or reserve gigabytes. They are only ever handed to findCfbDamage
// and parseWithDeferredHtml (which checks first), NEVER to msgreader
// directly: that would hang the test run. The browser test
// (e2e/parse-files.spec.ts) checks the same protection in a real worker.

import { describe, expect, it } from 'vitest';
import { buildMsg, type MsgSpec } from '../../tests/fixtures/msg/builder';
import { MSG_SPECS } from '../../tests/fixtures/msg/specs';
import { findCfbDamage } from './cfb-check';
import { parseWithDeferredHtml } from './deferred-html';

const BASE: MsgSpec = {
    id: 'cfb-unit',
    description: 'pre-check unit test message',
    strings: 'unicode',
    subject: 'Pre-check test',
    sender: { name: 'Alice Example', smtp: 'alice@example.test' },
    recipients: [{ name: 'Bob Sample', smtp: 'bob@example.test', type: 'to' }],
    bodyText: 'Hello, this is the body of a test message.\n'.repeat(4), // several mini sectors
    submitTime: '2025-06-03T12:05:09Z',
    messageId: '<cfb1@example.test>',
};

/** BASE plus an attachment of 5000 bytes: stored as a regular (non-mini) stream. */
const WITH_BIG_STREAM: MsgSpec = {
    ...BASE,
    attachments: [{ fileName: 'big.txt', mimeType: 'text/plain', content: 'x'.repeat(5000) }],
};

const SECTOR = 512; // the builder writes version 3 files (512-byte sectors)

/** Little helpers over a built file. */
function layout(bytes: Uint8Array)
{
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u32 = (offset: number): number => view.getUint32(offset, true);
    const setU32 = (offset: number, value: number): void => view.setUint32(offset, value, true);
    const sectorAt = (sector: number): number => (sector + 1) * SECTOR;
    /** Byte offset of the FAT entry of `sector` (first FAT sector only: files here are small). */
    const fatEntry = (sector: number): number => sectorAt(u32(0x4c)) + 4 * sector;
    const miniFatEntry = (sector: number): number => sectorAt(u32(0x3c)) + 4 * sector;
    /** Directory sectors in chain order. */
    const directorySectors = (): number[] =>
    {
        const sectors: number[] = [];
        for (let s = u32(0x30); s !== 0xfffffffe; s = u32(fatEntry(s)))
        {
            sectors.push(s);
        }
        return sectors;
    };
    const entry = (index: number): number =>
    {
        const sector = directorySectors()[Math.floor(index / 4)];
        if (sector === undefined)
        {
            throw new Error(`no directory entry ${String(index)}`);
        }
        return sectorAt(sector) + (index % 4) * 128;
    };
    const entryCount = (): number => directorySectors().length * 4;
    /** Index of the first stream entry whose declared size matches `test`. */
    const findStream = (test: (size: number) => boolean): number =>
    {
        for (let i = 1; i < entryCount(); i++)
        {
            if (bytes[entry(i) + 0x42] === 2 && test(u32(entry(i) + 0x78)))
            {
                return i;
            }
        }
        throw new Error('no such stream');
    };
    return { view, u32, setU32, fatEntry, miniFatEntry, entry, entryCount, findStream };
}

describe('findCfbDamage: well-formed files pass', () =>
{
    it.each(MSG_SPECS.map((s) => [s.id, s] as const))('%s', (_id, spec) =>
    {
        expect(findCfbDamage(buildMsg(spec))).toBeNull();
    });

    it('a file with a regular (non-mini) stream passes', () =>
    {
        expect(findCfbDamage(buildMsg(WITH_BIG_STREAM))).toBeNull();
    });

    it('a file given as a view into a larger buffer passes', () =>
    {
        const data = buildMsg(BASE);
        const big = new Uint8Array(data.length + 64);
        big.set(data, 16);
        expect(findCfbDamage(big.subarray(16, 16 + data.length))).toBeNull();
    });
});

describe('findCfbDamage: damaged files are rejected', () =>
{
    const damaged = (spec: MsgSpec, damage: (l: ReturnType<typeof layout>, bytes: Uint8Array) => void): Uint8Array =>
    {
        const bytes = buildMsg(spec);
        damage(layout(bytes), bytes);
        return bytes;
    };

    it('a stream declared larger than the file (msgreader would reserve ~2 GB)', () =>
    {
        const bytes = damaged(BASE, (l) => l.setU32(l.entry(l.findStream((size) => size > 0)) + 0x78, 0x7ffffff0));
        expect(findCfbDamage(bytes)).toBe('damaged file structure: a stream is declared larger than the file');
    });

    it('a stream declared one byte larger than the file', () =>
    {
        const bytes = damaged(BASE, (l, b) => l.setU32(l.entry(l.findStream((size) => size > 0)) + 0x78, b.length + 1));
        expect(findCfbDamage(bytes)).toBe('damaged file structure: a stream is declared larger than the file');
    });

    it('a mini stream (root entry) declared larger than the file', () =>
    {
        const bytes = damaged(BASE, (l) => l.setU32(l.entry(0) + 0x78, 0xfffffff0));
        expect(findCfbDamage(bytes)).toBe('damaged file structure: a stream is declared larger than the file');
    });

    it.each([
        ['0 (1-byte sectors)', 0],
        ['8', 8],
        ['10', 10],
        ['30 (1 GB sectors)', 30],
        ['0xFFFF', 0xffff],
    ])('a bogus sector size shift: %s', (_label, shift) =>
    {
        const bytes = damaged(BASE, (l) => l.view.setUint16(0x1e, shift, true));
        expect(findCfbDamage(bytes)).toBe('damaged file structure: impossible sector size');
    });

    it('a bogus mini sector size shift', () =>
    {
        const bytes = damaged(BASE, (l) => l.view.setUint16(0x20, 12, true));
        expect(findCfbDamage(bytes)).toBe('damaged file structure: impossible mini sector size');
    });

    it.each([
        ['FAT sectors', 0x2c],
        ['mini FAT sectors', 0x40],
        ['DIFAT sectors', 0x48],
    ])('more %s than the file has sectors', (_label, offset) =>
    {
        const bytes = damaged(BASE, (l) => l.setU32(offset, 0x7fffffff));
        expect(findCfbDamage(bytes)).toBe('damaged file structure: impossible sector count');
    });

    it('a directory chain that loops back on itself (msgreader would loop forever)', () =>
    {
        const bytes = damaged(BASE, (l) =>
        {
            const first = l.u32(0x30);
            l.setU32(l.fatEntry(first), first);
        });
        expect(findCfbDamage(bytes)).toBe('damaged file structure: a sector chain loops back on itself');
    });

    it('a mini stream chain that loops back on itself', () =>
    {
        const bytes = damaged(BASE, (l) =>
        {
            const start = l.u32(l.entry(0) + 0x74);
            l.setU32(l.fatEntry(start), start);
        });
        expect(findCfbDamage(bytes)).toBe('damaged file structure: a sector chain loops back on itself');
    });

    it("a small stream's chain that loops back on itself (msgreader would loop forever)", () =>
    {
        const bytes = damaged(BASE, (l) =>
        {
            const stream = l.findStream((size) => size > 64 && size < 4096);
            const start = l.u32(l.entry(stream) + 0x74);
            l.setU32(l.miniFatEntry(start), start);
        });
        expect(findCfbDamage(bytes)).toBe('damaged file structure: a sector chain loops back on itself');
    });

    it("a regular stream's chain that loops back on itself", () =>
    {
        const bytes = damaged(WITH_BIG_STREAM, (l) =>
        {
            const stream = l.findStream((size) => size >= 4096);
            const start = l.u32(l.entry(stream) + 0x74);
            l.setU32(l.fatEntry(start + 1), start);
        });
        expect(findCfbDamage(bytes)).toBe('damaged file structure: a sector chain loops back on itself');
    });

    it('two streams sharing sectors', () =>
    {
        const bytes = damaged(BASE, (l) =>
        {
            const a = l.findStream((size) => size > 0 && size < 4096);
            const b = l.findStream((size) => size > 0 && size < 4096 && size !== l.u32(l.entry(a) + 0x78));
            l.setU32(l.entry(b) + 0x74, l.u32(l.entry(a) + 0x74));
        });
        expect(findCfbDamage(bytes)).toBe('damaged file structure: a sector chain loops back on itself');
    });

    it('a chain that points outside the file', () =>
    {
        const bytes = damaged(BASE, (l) => l.setU32(l.fatEntry(l.u32(0x30)), 0x00ffffff));
        expect(findCfbDamage(bytes)).toBe('damaged file structure: a sector chain points outside the file');
    });

    it('a directory tree that loops back on itself (msgreader would loop forever)', () =>
    {
        const bytes = damaged(BASE, (l) =>
        {
            const child = l.u32(l.entry(0) + 0x4c);
            l.setU32(l.entry(child) + 0x44, child); // its left sibling is itself
        });
        expect(findCfbDamage(bytes)).toBe('damaged file structure: the directory tree loops back on itself');
    });

    it('a directory tree that links back to the root', () =>
    {
        const bytes = damaged(BASE, (l) => l.setU32(l.entry(l.u32(l.entry(0) + 0x4c)) + 0x48, 0));
        expect(findCfbDamage(bytes)).toBe('damaged file structure: the directory tree loops back on itself');
    });

    it('a second root entry whose sibling link loops (msgreader would grow an array until it fails)', () =>
    {
        // The reviewed case: the first synthetic spec, the root's child turned
        // into a root-type entry whose right sibling is itself.
        const bytes = damaged(MSG_SPECS[0] as MsgSpec, (l, b) =>
        {
            const child = l.u32(l.entry(0) + 0x4c);
            b[l.entry(child) + 0x42] = 5;
            l.setU32(l.entry(child) + 0x48, child);
        });
        expect(findCfbDamage(bytes)).toBe('damaged file structure: a second root entry');
    });

    it('a second root entry with harmless links is still rejected', () =>
    {
        const bytes = damaged(BASE, (l, b) =>
        {
            b[l.entry(l.u32(l.entry(0) + 0x4c)) + 0x42] = 5;
        });
        expect(findCfbDamage(bytes)).toBe('damaged file structure: a second root entry');
    });

    it('a second root entry that the tree does not reach is rejected too', () =>
    {
        const bytes = damaged(BASE, (l, b) =>
        {
            // The last directory entry of the file: unused (type 0) in these
            // synthetic files, so not linked from the tree.
            const last = l.entryCount() - 1;
            expect(b[l.entry(last) + 0x42]).toBe(0);
            b[l.entry(last) + 0x42] = 5;
        });
        expect(findCfbDamage(bytes)).toBe('damaged file structure: a second root entry');
    });

    it('a small stream whose chain is shorter than its declared size', () =>
    {
        const bytes = damaged(BASE, (l) =>
        {
            const stream = l.findStream((size) => size > 64 && size < 4096);
            // Cut its mini chain after the first mini sector.
            l.setU32(l.miniFatEntry(l.u32(l.entry(stream) + 0x74)), 0xfffffffe);
        });
        expect(findCfbDamage(bytes)).toBe('damaged file structure: a stream is longer than its sector chain');
    });

    it('a small stream with a size but no chain', () =>
    {
        const bytes = damaged(BASE, (l) => l.setU32(l.entry(l.findStream((size) => size > 0 && size < 4096)) + 0x74, 0xfffffffe));
        expect(findCfbDamage(bytes)).toBe('damaged file structure: a stream is longer than its sector chain');
    });

    it('a regular stream whose chain is shorter than its declared size', () =>
    {
        const bytes = damaged(WITH_BIG_STREAM, (l) =>
        {
            const stream = l.findStream((size) => size >= 4096);
            l.setU32(l.fatEntry(l.u32(l.entry(stream) + 0x74)), 0xfffffffe);
        });
        expect(findCfbDamage(bytes)).toBe('damaged file structure: a stream is longer than its sector chain');
    });

    it('a regular stream declared one byte larger than its chain holds', () =>
    {
        const bytes = damaged(WITH_BIG_STREAM, (l) =>
        {
            const stream = l.findStream((size) => size >= 4096);
            let length = 0;
            for (let s = l.u32(l.entry(stream) + 0x74); s !== 0xfffffffe; s = l.u32(l.fatEntry(s)))
            {
                length++;
            }
            l.setU32(l.entry(stream) + 0x78, length * SECTOR + 1);
        });
        expect(findCfbDamage(bytes)).toBe('damaged file structure: a stream is longer than its sector chain');
    });

    it('a mini stream (root entry) longer than its sector chain', () =>
    {
        const bytes = damaged(BASE, (l) =>
        {
            let length = 0;
            for (let s = l.u32(l.entry(0) + 0x74); s !== 0xfffffffe; s = l.u32(l.fatEntry(s)))
            {
                length++;
            }
            l.setU32(l.entry(0) + 0x78, length * SECTOR + 1);
        });
        expect(findCfbDamage(bytes)).toBe('damaged file structure: a stream is longer than its sector chain');
    });

    it('a directory link outside the directory', () =>
    {
        const bytes = damaged(BASE, (l) => l.setU32(l.entry(0) + 0x4c, 0x100000));
        expect(findCfbDamage(bytes)).toBe('damaged file structure: a directory entry points outside the directory');
    });

    it('no root entry', () =>
    {
        const bytes = damaged(BASE, (l, b) =>
        {
            b[l.entry(0) + 0x42] = 1;
        });
        expect(findCfbDamage(bytes)).toBe('damaged file structure: the root entry is missing');
    });

    it('a file cut off after the header', () =>
    {
        expect(findCfbDamage(buildMsg(BASE).slice(0, 600))).toMatch(/^damaged file structure: /);
    });

    it('a file shorter than the header', () =>
    {
        expect(findCfbDamage(buildMsg(BASE).slice(0, 300))).toBe('damaged file structure: the file is too short');
    });

    it('a version 4 file (4096-byte sectors) with a size over 4 GB', () =>
    {
        // Synthetic minimal header: only what the check reads before the size.
        const bytes = new Uint8Array(4096 * 4);
        const view = new DataView(bytes.buffer);
        bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
        view.setUint16(0x1c, 0xfffe, true);
        view.setUint16(0x1e, 12, true);
        view.setUint16(0x20, 6, true);
        view.setUint32(0x38, 4096, true);
        view.setUint32(0x2c, 1, true); // one FAT sector: sector 0
        view.setUint32(0x4c, 0, true);
        for (let i = 1; i < 109; i++)
        {
            view.setUint32(0x4c + 4 * i, 0xffffffff, true);
        }
        view.setUint32(0x30, 1, true); // directory: sector 1
        view.setUint32(0x3c, 0xfffffffe, true);
        view.setUint32(0x44, 0xfffffffe, true);
        const fat = 4096; // sector 0
        view.setUint32(fat, 0xfffffffd, true); // FAT sector
        view.setUint32(fat + 4, 0xfffffffe, true); // directory: one sector
        const root = 2 * 4096; // sector 1, entry 0
        bytes[root + 0x42] = 5;
        view.setUint32(root + 0x44, 0xffffffff, true);
        view.setUint32(root + 0x48, 0xffffffff, true);
        view.setUint32(root + 0x4c, 0xffffffff, true);
        view.setUint32(root + 0x74, 0xfffffffe, true);
        expect(findCfbDamage(bytes)).toBeNull();
        view.setUint32(root + 0x7c, 1, true); // high 32 bits of the size
        expect(findCfbDamage(bytes)).toBe('damaged file structure: a stream is declared larger than the file');
    });
});

describe('the parse path checks the structure before msgreader reads the file', () =>
{
    it('a looping directory chain becomes a corrupt result, quickly, with the hash', async () =>
    {
        const bytes = buildMsg(BASE);
        const l = layout(bytes);
        const first = l.u32(0x30);
        l.setU32(l.fatEntry(first), first);
        const started = Date.now();
        const result = await parseWithDeferredHtml({ name: 'loop.msg', bytes }, 'msg', () =>
        {
            throw new Error('no HTML expected');
        });
        expect(Date.now() - started).toBeLessThan(2000);
        expect(result).toMatchObject({
            ok: false,
            error: 'corrupt',
            fileName: 'loop.msg',
            detail: 'damaged file structure: a sector chain loops back on itself',
        });
        expect(result.ok ? null : result.sha256).toMatch(/^[0-9a-f]{64}$/);
    });
});
