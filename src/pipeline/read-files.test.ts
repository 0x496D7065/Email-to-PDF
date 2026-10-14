// Unit tests for reading dropped files (read-files.ts) with FAKE File-like
// objects: the limits must be checked on `size` before `arrayBuffer()` is
// ever called. Small limits are injected so no test needs 50 MB of data.

import { describe, expect, it, vi } from 'vitest';
import { BATCH_TOO_LARGE_DETAIL, FILE_TOO_LARGE_DETAIL, MAX_BATCH_BYTES, MAX_FILE_BYTES } from '../parsing/parse-files';
import { createFileReader, UNREADABLE_DETAIL, type FileLike } from './read-files';

const LIMITS = { maxFileBytes: 10, maxBatchBytes: 25 };

/** A fake File: `size` as given, `arrayBuffer` a spy returning `content` (default: `size` bytes). */
function fakeFile(name: string, size: number, content?: ArrayBuffer | (() => Promise<ArrayBuffer>)) {
  const arrayBuffer = vi.fn((): Promise<ArrayBuffer> => {
    if (typeof content === 'function') return content();
    return Promise.resolve(content ?? new Uint8Array(size).fill(7).buffer);
  });
  const file: FileLike = { name, size, arrayBuffer };
  return { file, arrayBuffer };
}

describe('createFileReader', () => {
  it('reads a file within the limits into an InputFile with its exact bytes', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { file } = fakeFile('order.eml', 3, bytes.buffer);
    const outcome = await createFileReader(LIMITS)(file);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.input.name).toBe('order.eml');
    expect(outcome.ok && [...outcome.input.bytes]).toEqual([1, 2, 3]);
  });

  it('rejects a file over the per-file limit WITHOUT reading it', async () => {
    const { file, arrayBuffer } = fakeFile('huge.eml', 11);
    const outcome = await createFileReader(LIMITS)(file);
    expect(outcome).toEqual({
      ok: false,
      result: { ok: false, fileName: 'huge.eml', sha256: null, error: 'too-large', detail: FILE_TOO_LARGE_DETAIL },
    });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('a file exactly at the limit is read', async () => {
    const { file, arrayBuffer } = fakeFile('edge.eml', 10);
    expect((await createFileReader(LIMITS)(file)).ok).toBe(true);
    expect(arrayBuffer).toHaveBeenCalledTimes(1);
  });

  it('rejects a file that would take the batch over its limit, without reading it; a smaller later file still fits', async () => {
    const read = createFileReader(LIMITS);
    const a = fakeFile('a.eml', 10);
    const b = fakeFile('b.eml', 10);
    const c = fakeFile('c.eml', 10);
    const d = fakeFile('d.eml', 5);
    expect((await read(a.file)).ok).toBe(true);
    expect((await read(b.file)).ok).toBe(true);
    const third = await read(c.file);
    expect(third).toEqual({
      ok: false,
      result: { ok: false, fileName: 'c.eml', sha256: null, error: 'too-large', detail: BATCH_TOO_LARGE_DETAIL },
    });
    expect(c.arrayBuffer).not.toHaveBeenCalled();
    expect((await read(d.file)).ok).toBe(true); // 10 + 10 + 5 = 25: exactly the limit
  });

  it('a file the browser cannot read (arrayBuffer rejects) fails alone, and does not use up the batch', async () => {
    const read = createFileReader(LIMITS);
    const gone = fakeFile('moved.eml', 10, () => Promise.reject(new Error('NotReadableError')));
    expect(await read(gone.file)).toEqual({
      ok: false,
      result: { ok: false, fileName: 'moved.eml', sha256: null, error: 'unreadable', detail: UNREADABLE_DETAIL },
    });
    // Its 10 bytes were given back: two more 10-byte files and a 5-byte one fit.
    for (const name of ['x.eml', 'y.eml']) expect((await read(fakeFile(name, 10).file)).ok).toBe(true);
    expect((await read(fakeFile('z.eml', 5).file)).ok).toBe(true);
  });

  it('a file that grew on disk after it was dropped is checked again on what was read', async () => {
    const read = createFileReader(LIMITS);
    const grown = fakeFile('grown.eml', 5, new Uint8Array(11).buffer);
    expect(await read(grown.file)).toMatchObject({ ok: false, result: { error: 'too-large', detail: FILE_TOO_LARGE_DETAIL } });
    // Nothing of it counts towards the batch.
    expect((await read(fakeFile('a.eml', 10).file)).ok).toBe(true);
    expect((await read(fakeFile('b.eml', 10).file)).ok).toBe(true);
    expect((await read(fakeFile('c.eml', 5).file)).ok).toBe(true);
  });

  it('a file whose real size takes the batch over the limit is rejected after reading, and frees its share', async () => {
    const read = createFileReader(LIMITS);
    expect((await read(fakeFile('a.eml', 10).file)).ok).toBe(true);
    expect((await read(fakeFile('b.eml', 10).file)).ok).toBe(true);
    const grown = fakeFile('grown.eml', 5, new Uint8Array(6).buffer);
    expect(await read(grown.file)).toMatchObject({ ok: false, result: { error: 'too-large', detail: BATCH_TOO_LARGE_DETAIL } });
    expect((await read(fakeFile('c.eml', 5).file)).ok).toBe(true);
  });

  it('a file that shrank on disk after it was dropped counts only the bytes actually read', async () => {
    const read = createFileReader(LIMITS);
    const shrunk = fakeFile('shrunk.eml', 10, new Uint8Array(5).buffer);
    const outcome = await read(shrunk.file);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.input.bytes.byteLength).toBe(5);
    // 5 bytes used: 10 + 10 more fit exactly (5 + 10 + 10 = 25), then not one byte more.
    expect((await read(fakeFile('a.eml', 10).file)).ok).toBe(true);
    expect((await read(fakeFile('b.eml', 10).file)).ok).toBe(true);
    expect(await read(fakeFile('c.eml', 1).file)).toMatchObject({
      ok: false,
      result: { error: 'too-large', detail: BATCH_TOO_LARGE_DETAIL },
    });
  });

  it.each([
    ['NaN', NaN],
    ['negative', -1],
    ['Infinity', Infinity],
    ['not a number', '3' as unknown as number],
  ])('a size that is %s is reported as unreadable, without reading', async (_label, size) => {
    const { file, arrayBuffer } = fakeFile('odd.eml', size, new ArrayBuffer(1));
    expect(await createFileReader(LIMITS)(file)).toMatchObject({ ok: false, result: { error: 'unreadable', detail: UNREADABLE_DETAIL } });
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('arrayBuffer resolving to something that is not an ArrayBuffer is unreadable', async () => {
    const { file } = fakeFile('odd.eml', 3, () => Promise.resolve('text' as unknown as ArrayBuffer));
    expect(await createFileReader(LIMITS)(file)).toMatchObject({ ok: false, result: { error: 'unreadable', detail: UNREADABLE_DETAIL } });
  });

  it('uses the real limits by default (50 MB per file)', async () => {
    const { file, arrayBuffer } = fakeFile('huge.eml', MAX_FILE_BYTES + 1);
    expect(await createFileReader()(file)).toMatchObject({ ok: false, result: { error: 'too-large', detail: FILE_TOO_LARGE_DETAIL } });
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(MAX_BATCH_BYTES).toBe(500 * 1024 * 1024);
  });
});
