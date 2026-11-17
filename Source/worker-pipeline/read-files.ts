// Reads dropped files (browser File objects) into memory, safely.
//
// The size limits are checked against `File.size` BEFORE the file is read
// (`arrayBuffer()`), so a huge file is rejected without ever being loaded
// into the tab's memory (README.md, rule R4). The browser knows a local
// file's size without reading it.
//
// A rejected file becomes a failed ParseResult with the same codes and
// details as the parse dispatcher (parse-files.ts), so the preview lists it
// like any other file that could not be read. parse-files.ts checks the
// limits again on the bytes; this is the earlier, cheaper gate.
//
// Batch limit: every file that is read counts, whatever its type (the type
// is only known from its bytes, and the bytes are in memory either way).
// A file that would take the total over the limit is not read; a smaller file
// further down the list can still fit, as in parse-files.ts.
//
// The bytes stay in memory only (README.md, rule R5).

import { BATCH_TOO_LARGE_DETAIL, FILE_TOO_LARGE_DETAIL, MAX_BATCH_BYTES, MAX_FILE_BYTES } from '../email-reading/parse-files';
import type { FileLike } from '../../Header/file-processing';
import type { Limits } from '../../Header/parse-worker-messages';
import type { InputFile, ParseResult } from '../../Header/parsed-email';

/** One file after reading: its bytes, or a failed result for the preview. */
export type ReadOutcome =
    | { readonly ok: true; readonly input: InputFile }
    | { readonly ok: false; readonly result: ParseResult };

/**
 * Detail for a file the browser could not read (moved, deleted or changed
 * since it was dropped). Its code is 'unreadable', never 'corrupt': the file
 * itself may be fine.
 */
export const UNREADABLE_DETAIL = 'could not be read from your computer (it may have been moved or changed); add it again';

const DEFAULT_LIMITS: Limits = { maxFileBytes: MAX_FILE_BYTES, maxBatchBytes: MAX_BATCH_BYTES };

/**
 * Returns a reader for one batch: call it once per file, in order. It keeps
 * the running total for the batch limit. Never rejects.
 */
export function createFileReader(limits: Limits = DEFAULT_LIMITS): (file: FileLike) => Promise<ReadOutcome>
{
    let acceptedBytes = 0;
    return async (file) =>
    {
        const name = typeof file.name === 'string' ? file.name : '';
        const failed = (error: 'too-large' | 'unreadable', detail: string): ReadOutcome => ({
            ok: false,
            // sha256 null: the file was never read, so it has no hash.
            result: { ok: false, fileName: name, sha256: null, error, detail },
        });
        const size: unknown = file.size;
        if (typeof size !== 'number' || !Number.isFinite(size) || size < 0)
        {
            return failed('unreadable', UNREADABLE_DETAIL);
        }
        if (size > limits.maxFileBytes)
        {
            return failed('too-large', FILE_TOO_LARGE_DETAIL);
        }
        if (acceptedBytes + size > limits.maxBatchBytes)
        {
            return failed('too-large', BATCH_TOO_LARGE_DETAIL);
        }

        // Reserved before waiting, so the total is right even if calls overlap.
        acceptedBytes += size;
        let buffer: unknown;
        try
        {
            buffer = await file.arrayBuffer();
        }
        catch
        {
            buffer = null;
        }
        if (!(buffer instanceof ArrayBuffer))
        {
            acceptedBytes -= size;
            return failed('unreadable', UNREADABLE_DETAIL);
        }
        // The file may have changed on disk since its size was taken: the limits
        // are checked again on what was actually read, and the reservation is
        // replaced by the real length only if the file is accepted.
        const total = acceptedBytes - size + buffer.byteLength;
        if (buffer.byteLength > limits.maxFileBytes)
        {
            acceptedBytes -= size;
            return failed('too-large', FILE_TOO_LARGE_DETAIL);
        }
        if (total > limits.maxBatchBytes)
        {
            acceptedBytes -= size;
            return failed('too-large', BATCH_TOO_LARGE_DETAIL);
        }
        acceptedBytes = total;
        return { ok: true, input: { name, bytes: new Uint8Array(buffer) } };
    };
}
