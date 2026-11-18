// Unit tests for the dispatcher (parse-files.ts): size limits, the file type
// decision, hashing, the mapping to per-file results, input order, and that
// one bad file never stops the others. The worker step is injected: a fake
// for the dispatcher rules, and the real worker-side parse
// (parseWithDeferredHtml, with a stub HTML converter) for the end-to-end
// cases. The real Web Worker is checked in Chromium by Helper/Test/browser-tests/parse-files.spec.ts.

import { describe, expect, it, vi } from 'vitest';
import { buildMsg, type MsgSpec } from '../../Helper/Test/test-data/msg/builder';
import { MSG_SPECS } from '../../Helper/Test/test-data/msg/specs';
import { convertHtmlList, parseWithDeferredHtml } from './deferred-html';
import { sha256Hex } from './file-hash';
import {
    BATCH_TOO_LARGE_DETAIL,
    FILE_TOO_LARGE_DETAIL,
    MAX_BATCH_BYTES,
    MAX_FILE_BYTES,
    PARSE_TIMEOUT_MS,
    parseFilesWith,
    type JobRunner,
} from './parse-files';
import { DETACHED_DETAIL, type WorkerJob } from './parse-worker-runner';
import type { InputFile, ParseResult } from '../../Header/parsed-email';

const fixtureFiles = import.meta.glob<string>('../../Helper/Test/test-data/eml/*.eml', { query: '?raw', import: 'default', eager: true });

function fixture(name: string): string
{
    const entry = Object.entries(fixtureFiles).find(([path]) => path.endsWith(`/${name}`));
    if (entry === undefined)
    {
        throw new Error(`missing fixture ${name}`);
    }
    return entry[1];
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

function msgSpec(index: number): MsgSpec
{
    const spec = MSG_SPECS[index];
    if (spec === undefined)
    {
        throw new Error(`missing .msg spec ${String(index)}`);
    }
    return spec;
}

/** A small synthetic .eml of exactly `size` bytes (padded body). */
function emlOfSize(size: number): Uint8Array
{
    const head = 'X-Synthetic-Fixture: true\r\nFrom: Alice Example <alice@example.test>\r\nSubject: Size test\r\n\r\n';
    if (size < head.length)
    {
        throw new Error('too small');
    }
    return encode(head + 'x'.repeat(size - head.length));
}

/** A fake worker step: records each job, answers with a recognizable failure result. */
function recordingRunner()
{
    const jobs: WorkerJob[] = [];
    const runJob: JobRunner = (job) =>
    {
        jobs.push(job);
        return Promise.resolve({ ok: false, fileName: job.name, sha256: job.sha256, error: 'corrupt', detail: `parsed as ${job.kind}` });
    };
    return { jobs, runJob };
}

/** The real worker-side parse, run in-process with a stub HTML converter. */
const realRunner: JobRunner = (job) =>
    parseWithDeferredHtml({ name: job.name, bytes: job.bytes }, job.kind, (htmls) =>
        Promise.resolve(convertHtmlList(htmls, (html) => ({ text: html.replace(/<[^>]*>/g, ''), truncated: false }))),
    );

const failure = (result: ParseResult | undefined) => (result !== undefined && !result.ok ? result : undefined);

describe('limits: values and wording', () =>
{
    it('are named constants with the values their comments explain', () =>
    {
        expect(MAX_FILE_BYTES).toBe(50 * 1024 * 1024);
        expect(MAX_BATCH_BYTES).toBe(500 * 1024 * 1024);
        expect(PARSE_TIMEOUT_MS).toBe(20_000);
    });

    it('the details name the limits in plain words', () =>
    {
        expect(FILE_TOO_LARGE_DETAIL).toBe('the file is larger than 50 MB, the limit for one file');
        expect(BATCH_TOO_LARGE_DETAIL).toBe('not read: the files together are larger than 500 MB, the limit for one batch');
    });
});

describe('parseFilesWith: size limits', () =>
{
    const limits = { maxFileBytes: 200, maxBatchBytes: 500 };

    it('a file over the per-file limit is too-large, not hashed, never sent to a parser', async () =>
    {
        const { jobs, runJob } = recordingRunner();
        const [result] = await parseFilesWith([{ name: 'big.eml', bytes: emlOfSize(201) }], runJob, limits);
        expect(result).toEqual({ ok: false, fileName: 'big.eml', sha256: null, error: 'too-large', detail: FILE_TOO_LARGE_DETAIL });
        expect(jobs).toEqual([]);
    });

    it('a file exactly at the per-file limit is read', async () =>
    {
        const { jobs, runJob } = recordingRunner();
        await parseFilesWith([{ name: 'edge.eml', bytes: emlOfSize(200) }], runJob, limits);
        expect(jobs.map((j) => j.name)).toEqual(['edge.eml']);
    });

    it('the default per-file limit applies without injected limits', async () =>
    {
        const { jobs, runJob } = recordingRunner();
        const [result] = await parseFilesWith([{ name: 'huge.eml', bytes: new Uint8Array(MAX_FILE_BYTES + 1) }], runJob);
        expect(result).toMatchObject({ ok: false, error: 'too-large', detail: FILE_TOO_LARGE_DETAIL, sha256: null });
        expect(jobs).toEqual([]);
    });

    it('files past the batch limit are too-large; a smaller later file that still fits is read', async () =>
    {
        const { jobs, runJob } = recordingRunner();
        const files: InputFile[] = [
            { name: 'a.eml', bytes: emlOfSize(200) },
            { name: 'b.eml', bytes: emlOfSize(200) },
            { name: 'c.eml', bytes: emlOfSize(200) }, // 600 > 500
            { name: 'd.eml', bytes: emlOfSize(100) }, // 500: fits
        ];
        const results = await parseFilesWith(files, runJob, limits);
        expect(results.map((r) => (r.ok ? 'ok' : r.detail))).toEqual(['parsed as eml', 'parsed as eml', BATCH_TOO_LARGE_DETAIL, 'parsed as eml']);
        expect(failure(results[2])).toMatchObject({ fileName: 'c.eml', error: 'too-large', sha256: null });
        expect(jobs.map((j) => j.name)).toEqual(['a.eml', 'b.eml', 'd.eml']);
    });

    it('rejected files (unsupported, too large) do not count towards the batch limit', async () =>
    {
        const { jobs, runJob } = recordingRunner();
        const files: InputFile[] = [
            { name: 'big.eml', bytes: emlOfSize(201) },
            { name: 'notes.txt', bytes: emlOfSize(200) },
            { name: 'a.eml', bytes: emlOfSize(200) },
            { name: 'b.eml', bytes: emlOfSize(200) },
            { name: 'c.eml', bytes: emlOfSize(100) },
        ];
        await parseFilesWith(files, runJob, limits);
        expect(jobs.map((j) => j.name)).toEqual(['a.eml', 'b.eml', 'c.eml']);
    });
});

describe('parseFilesWith: file type and hashing', () =>
{
    it('an unsupported or unreadable file gets a clear result with its hash, and no parser', async () =>
    {
        const { jobs, runJob } = recordingRunner();
        const notes = encode('Order notes');
        const results = await parseFilesWith(
            [
                { name: 'notes.txt', bytes: notes },
                { name: 'empty.eml', bytes: new Uint8Array(0) },
                { name: 'garbage.msg', bytes: Uint8Array.of(0x50, 0x4b, 3, 4, 0, 0) },
            ],
            runJob,
        );
        expect(results).toEqual([
            {
                ok: false,
                fileName: 'notes.txt',
                sha256: await sha256Hex(notes),
                error: 'unsupported-type',
                detail: 'not an email file: only .eml and .msg files can be read',
            },
            { ok: false, fileName: 'empty.eml', sha256: await sha256Hex(new Uint8Array(0)), error: 'corrupt', detail: 'the file is empty' },
            {
                ok: false,
                fileName: 'garbage.msg',
                sha256: await sha256Hex(Uint8Array.of(0x50, 0x4b, 3, 4, 0, 0)),
                error: 'corrupt',
                detail: 'damaged file structure: this is not a readable Outlook message file',
            },
        ]);
        expect(jobs).toEqual([]);
    });

    it('hands each file to the worker step with its detected kind and SHA-256', async () =>
    {
        const { jobs, runJob } = recordingRunner();
        const eml = encode(fixture('01-plain-english.eml'));
        const msg = buildMsg(msgSpec(0));
        const compoundFileNamedEml = buildMsg(msgSpec(0));
        await parseFilesWith(
            [
                { name: 'a.eml', bytes: eml },
                { name: 'b.MSG', bytes: msg },
                { name: 'renamed.eml', bytes: compoundFileNamedEml },
            ],
            runJob,
        );
        expect(jobs.map((j) => [j.name, j.kind])).toEqual([
            ['a.eml', 'eml'],
            ['b.MSG', 'msg'],
            ['renamed.eml', 'msg'],
        ]);
        expect(jobs[0]?.sha256).toBe(await sha256Hex(eml));
        expect(jobs[1]?.sha256).toBe(await sha256Hex(msg));
    });
});

describe('parseFilesWith: bytes given twice', () =>
{
    /** Like the real worker step: moves (transfers) a buffer the bytes fully cover. */
    function movingRunner()
    {
        const { jobs, runJob } = recordingRunner();
        const moving: JobRunner = (job) =>
        {
            const { buffer } = job.bytes;
            if (buffer instanceof ArrayBuffer && job.bytes.byteOffset === 0 && job.bytes.byteLength === buffer.byteLength)
            {
                structuredClone(buffer, { transfer: [buffer] });
            }
            return runJob(job);
        };
        return { jobs, runJob: moving };
    }

    it('the same array twice: the second says the data was handed over, not that the file is empty', async () =>
    {
        const { jobs, runJob } = movingRunner();
        const bytes = encode(fixture('01-plain-english.eml'));
        const results = await parseFilesWith(
            [
                { name: 'a.eml', bytes },
                { name: 'again.eml', bytes },
            ],
            runJob,
        );
        expect(jobs.map((j) => j.name)).toEqual(['a.eml']);
        expect(results[1]).toEqual({ ok: false, fileName: 'again.eml', sha256: null, error: 'tool-error', detail: DETACHED_DETAIL });
    });

    it('two views of one buffer: the second is reported the same way', async () =>
    {
        const { runJob } = movingRunner();
        const bytes = encode(fixture('01-plain-english.eml'));
        const results = await parseFilesWith(
            [
                { name: 'whole.eml', bytes },
                { name: 'part.eml', bytes: bytes.subarray(0, 40) },
            ],
            runJob,
        );
        expect(results[1]).toMatchObject({ fileName: 'part.eml', detail: DETACHED_DETAIL });
    });

    it('without ArrayBuffer.prototype.detached, the record of handed-over buffers still catches it', async () =>
    {
        // ES2022 types do not know `detached` yet.
        const prototype = ArrayBuffer.prototype as unknown as { readonly detached: boolean };
        const getter = vi.spyOn(prototype, 'detached', 'get').mockReturnValue(false);
        try
        {
            const { runJob } = movingRunner();
            const bytes = encode(fixture('01-plain-english.eml'));
            const results = await parseFilesWith(
                [
                    { name: 'a.eml', bytes },
                    { name: 'again.eml', bytes },
                ],
                runJob,
            );
            expect(results[1]).toMatchObject({ fileName: 'again.eml', detail: DETACHED_DETAIL });
        }
        finally
        {
            getter.mockRestore();
        }
    });

    it('a genuinely empty file, even given twice, is still "the file is empty"', async () =>
    {
        const { runJob } = movingRunner();
        const empty = new Uint8Array(0);
        const results = await parseFilesWith(
            [
                { name: 'empty.eml', bytes: empty },
                { name: 'empty-again.eml', bytes: empty },
            ],
            runJob,
        );
        expect(results.map((r) => (r.ok ? null : r.detail))).toEqual(['the file is empty', 'the file is empty']);
    });

    it('after a partial view (copied, not moved), an empty view of the same buffer is still "the file is empty"', async () =>
    {
        const { jobs, runJob } = movingRunner();
        const bytes = encode(fixture('01-plain-english.eml'));
        const results = await parseFilesWith(
            [
                { name: 'part.eml', bytes: bytes.subarray(0, 40) },
                { name: 'empty.eml', bytes: bytes.subarray(40, 40) },
            ],
            runJob,
        );
        expect(jobs.map((j) => j.name)).toEqual(['part.eml']);
        expect(bytes.byteLength).toBeGreaterThan(40);
        expect(failure(results[1])).toMatchObject({ fileName: 'empty.eml', detail: 'the file is empty' });
    });
});

describe('parseFilesWith: never throws, keeps going, keeps order', () =>
{
    it('a worker step that throws or rejects fails only that file, with its hash', async () =>
    {
        const bytes = encode(fixture('01-plain-english.eml'));
        const runJob = vi.fn<JobRunner>((job) =>
        {
            if (job.name === 'throws.eml')
            {
                throw new Error('boom');
            }
            if (job.name === 'rejects.eml')
            {
                return Promise.reject(new Error('boom'));
            }
            return realRunner(job);
        });
        const results = await parseFilesWith(
            [
                { name: 'throws.eml', bytes },
                { name: 'ok-1.eml', bytes },
                { name: 'rejects.eml', bytes },
                { name: 'ok-2.eml', bytes },
            ],
            runJob,
        );
        const fileSha256 = await sha256Hex(bytes);
        expect(results.map((r) => (r.ok ? r.message.source.fileName : r.fileName))).toEqual(['throws.eml', 'ok-1.eml', 'rejects.eml', 'ok-2.eml']);
        for (const index of [0, 2])
        {
            expect(results[index]).toMatchObject({ ok: false, error: 'tool-error', detail: 'could not be read (unexpected error)', sha256: fileSha256 });
        }
        expect(results[1]?.ok && results[3]?.ok).toBe(true);
    });

    it('an empty batch gives an empty list', async () =>
    {
        await expect(parseFilesWith([], recordingRunner().runJob)).resolves.toEqual([]);
    });

    it('a mixed batch through the real parse: one result per file, in input order', async () =>
    {
        const looping = buildMsg(msgSpec(0));
        const view = new DataView(looping.buffer);
        const dirSector = view.getUint32(0x30, true);
        view.setUint32((view.getUint32(0x4c, true) + 1) * 512 + 4 * dirSector, dirSector, true); // directory chain loops
        const files: InputFile[] = [
            { name: 'b.eml', bytes: encode(fixture('10-order-1-alice.eml')) },
            { name: 'looping.msg', bytes: looping },
            { name: 'photo.png', bytes: Uint8Array.of(0x89, 0x50, 0x4e, 0x47) },
            { name: 'a.msg', bytes: buildMsg(msgSpec(1)) },
            { name: 'html.eml', bytes: encode(fixture('50-html-only.eml')) },
        ];
        const results = await parseFilesWith(files, realRunner);
        expect(results.map((r) => (r.ok ? `${r.message.source.fileName} ok` : `${r.fileName} ${r.error}`))).toEqual([
            'b.eml ok',
            'looping.msg corrupt',
            'photo.png unsupported-type',
            'a.msg ok',
            'html.eml ok',
        ]);
        expect(failure(results[1])?.detail).toBe('damaged file structure: a sector chain loops back on itself');
        expect(results[4]?.ok && results[4].message.warnings).toContain('html-converted-body');
    });
});

describe('date fallbacks: flagged, never fatal, file order kept', () =>
{
    // A message without a usable date keeps date.utcMs = null and a warning
    // the preview shows; its place in the input order (= file order) is the
    // fallback for sorting.
    it('missing and unparseable .eml dates are flagged in place', async () =>
    {
        const results = await parseFilesWith(
            [
                { name: 'dated.eml', bytes: encode(fixture('01-plain-english.eml')) },
                { name: 'no-date.eml', bytes: encode(fixture('70-no-date.eml')) },
                { name: 'bad-date.eml', bytes: encode(fixture('71-bad-date.eml')) },
                { name: 'no-zone.eml', bytes: encode(fixture('73-date-no-zone.eml')) },
            ],
            realRunner,
        );
        const summary = results.map((r) => (r.ok ? { name: r.message.source.fileName, utcMs: r.message.date.utcMs, warnings: r.message.warnings } : null));
        expect(summary[0]?.utcMs).not.toBeNull();
        expect(summary[0]?.warnings).not.toEqual(expect.arrayContaining(['missing-date']));
        expect(summary[1]).toMatchObject({ name: 'no-date.eml', utcMs: null });
        expect(summary[1]?.warnings).toContain('missing-date');
        expect(summary[2]).toMatchObject({ name: 'bad-date.eml', utcMs: null });
        expect(summary[2]?.warnings).toContain('unparseable-date');
        expect(summary[3]?.name).toBe('no-zone.eml');
        expect(summary[3]?.utcMs).not.toBeNull();
        expect(summary[3]?.warnings).toContain('unknown-time-zone');
    });

    it('a .msg with no time at all is flagged missing-date', async () =>
    {
        const undated: MsgSpec = {
            id: 'undated',
            description: 'a .msg with no sent, received or header time',
            strings: 'unicode',
            subject: 'Undated note',
            sender: { name: 'Alice Example', smtp: 'alice@example.test' },
            recipients: [{ name: 'Bob Sample', smtp: 'bob@example.test', type: 'to' }],
            bodyText: 'Please check the chair order.',
            messageId: '<undated@example.test>',
        };
        const [result] = await parseFilesWith([{ name: 'undated.msg', bytes: buildMsg(undated) }], realRunner);
        expect(result?.ok && result.message.date.utcMs).toBeNull();
        expect(result?.ok && result.message.warnings).toContain('missing-date');
    });
});
