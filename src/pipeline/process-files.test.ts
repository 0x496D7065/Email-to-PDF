// Unit tests for the UI's processing call (process-files.ts), in Node: fake
// File-like objects, the real dispatcher and adapters (without workers), and
// the real engine (without its worker). The browser version, with the real
// workers, is checked in Chromium by e2e/parse-files.spec.ts.

import { describe, expect, it, vi } from 'vitest';
import { runEngine } from '../engine/engine';
import { createEmlParser } from '../parsing/eml';
import type { HtmlToTextResult } from '../parsing/html-to-text';
import { createMsgParser } from '../parsing/msg';
import { FILE_TOO_LARGE_DETAIL, parseFilesWith } from '../parsing/parse-files';
import type { InputFile, ParseResult } from '../parsing/types';
import { ENGINE_TIMEOUT_DETAIL, type EngineOutcome } from './engine-runner';
import {
    CANCELLED_BATCH_DETAIL,
    processFilesWith,
    UNEXPECTED_BATCH_DETAIL,
    UNEXPECTED_FILE_DETAIL,
    type ProcessProgress,
    type ProcessSteps,
} from './process-files';
import type { FileLike } from './read-files';

const fixtures = import.meta.glob<string>('../../tests/fixtures/eml/*.eml', { query: '?raw', import: 'default', eager: true });

function fixture(name: string): string
{
    const text = fixtures[`../../tests/fixtures/eml/${name}`];
    if (text === undefined)
    {
        throw new Error(`missing fixture ${name}`);
    }
    return text;
}

/** A fake File holding `text`; `arrayBuffer` is a spy. */
function textFile(name: string, text: string): { file: FileLike; arrayBuffer: ReturnType<typeof vi.fn> }
{
    const bytes = new TextEncoder().encode(text);
    const arrayBuffer = vi.fn(() => Promise.resolve(bytes.slice().buffer));
    return { file: { name, size: bytes.length, arrayBuffer }, arrayBuffer };
}

// A stub, NOT a converter (Node has no DOMParser).
const htmlToText = (html: string): HtmlToTextResult => ({ text: `[stub] ${html.length}`, truncated: false });

/** The real dispatcher with the adapters called directly (no worker in Node). */
const parse = (inputs: readonly InputFile[]): Promise<ParseResult[]> =>
    parseFilesWith(inputs, (job) => (job.kind === 'eml' ? createEmlParser({ htmlToText }) : createMsgParser({ htmlToText })).parse(job));

const organize = (results: readonly ParseResult[]): Promise<EngineOutcome> => Promise.resolve({ ok: true, result: runEngine(results) });

const STEPS: ProcessSteps = { parse, organize, limits: { maxFileBytes: 20_000, maxBatchBytes: 100_000 } };

describe('processFilesWith', () =>
{
    it('reads, parses and organizes a batch; rejected files are listed; progress counts every file', async () =>
    {
        const huge = { name: 'huge.eml', size: 20_001, arrayBuffer: vi.fn(() => Promise.resolve(new ArrayBuffer(0))) };
        const files: FileLike[] = [
            textFile('order-1.eml', fixture('10-order-1-alice.eml')).file,
            textFile('order-2.eml', fixture('11-order-2-bob-outlook-en.eml')).file,
            textFile('order-2-copy.eml', fixture('30-dup-order-2-copy.eml')).file,
            textFile('notes.txt', 'Order notes, not an email.').file,
            huge,
            textFile('order-3.eml', fixture('12-order-3-alice-gmail.eml')).file,
        ];
        const progress: ProcessProgress[] = [];
        const result = await processFilesWith(files, STEPS, { onProgress: (p) => progress.push(p) });

        if (!result.ok)
        {
            throw new Error(result.detail);
        }
        expect(result.engine.counts).toMatchObject({ filesGiven: 6, messagesFound: 4, duplicatesMerged: 1, filesFailed: 2 });
        expect(result.engine.messages.map((m) => m.message.source.fileName)).toEqual(['order-1.eml', 'order-2.eml', 'order-3.eml']);
        expect(result.engine.failed.map((f) => [f.index, f.fileName, f.error])).toEqual([
            [3, 'notes.txt', 'unsupported-type'],
            [4, 'huge.eml', 'too-large'],
        ]);
        expect(result.engine.failed[1]?.detail).toBe(FILE_TOO_LARGE_DETAIL);
        // The huge file was never loaded.
        expect(huge.arrayBuffer).not.toHaveBeenCalled();
        expect(progress).toEqual([
            ...[0, 1, 2, 3, 4, 5, 6].map((filesDone) => ({ stage: 'reading', filesDone, filesTotal: 6 })),
            { stage: 'organizing', filesDone: 6, filesTotal: 6 },
        ]);
    });

    it('reads and parses one file at a time (the next file is read only after the previous one is parsed)', async () =>
    {
        const log: string[] = [];
        const files = ['a.eml', 'b.eml'].map((name) => ({
            name,
            size: 1,
            arrayBuffer: () =>
            {
                log.push(`read ${name}`);
                return Promise.resolve(new ArrayBuffer(1));
            },
        }));
        const steps: ProcessSteps = {
            ...STEPS,
            parse: (inputs) =>
            {
                log.push(`parse ${inputs.map((i) => i.name).join(',')}`);
                return Promise.resolve(inputs.map((i): ParseResult => ({ ok: false, fileName: i.name, sha256: null, error: 'corrupt', detail: 'x' })));
            },
        };
        await processFilesWith(files, steps);
        expect(log).toEqual(['read a.eml', 'parse a.eml', 'read b.eml', 'parse b.eml']);
    });

    it('an engine timeout gives a batch-level error, with the parse results kept', async () =>
    {
        const steps: ProcessSteps = { ...STEPS, organize: () => Promise.resolve({ ok: false, error: 'engine-timeout', detail: ENGINE_TIMEOUT_DETAIL }) };
        const result = await processFilesWith([textFile('plain.eml', fixture('01-plain-english.eml')).file], steps);
        expect(result.ok).toBe(false);
        if (result.ok)
        {
            return;
        }
        expect(result.error).toBe('engine-timeout');
        expect(result.detail).toBe(ENGINE_TIMEOUT_DETAIL);
        expect(result.parsed.map((r) => r.ok)).toEqual([true]);
    });

    it('an organize step that rejects (a bug) gives an "unexpected" batch error, never a rejection', async () =>
    {
        const steps: ProcessSteps = { ...STEPS, organize: () => Promise.reject(new Error('bug')) };
        const result = await processFilesWith([textFile('plain.eml', fixture('01-plain-english.eml')).file], steps);
        expect(result).toMatchObject({ ok: false, error: 'unexpected', detail: UNEXPECTED_BATCH_DETAIL });
        expect(!result.ok && result.parsed).toHaveLength(1);
    });

    it.each([
        ['rejects', () => Promise.reject(new Error('bug'))],
        ['returns no result', () => Promise.resolve([])],
    ])('a parse step that %s fails that file only', async (_label, broken: () => Promise<ParseResult[]>) =>
    {
        const steps: ProcessSteps = { ...STEPS, parse: (inputs) => (inputs[0]?.name === 'bad.eml' ? broken() : parse(inputs)) };
        const files = [textFile('bad.eml', fixture('01-plain-english.eml')).file, textFile('good.eml', fixture('70-no-date.eml')).file];
        const result = await processFilesWith(files, steps);
        if (!result.ok)
        {
            throw new Error(result.detail);
        }
        expect(result.engine.failed).toEqual([{ index: 0, fileName: 'bad.eml', sha256: null, error: 'tool-error', detail: UNEXPECTED_FILE_DETAIL }]);
        expect(result.engine.messages.map((m) => m.message.source.fileName)).toEqual(['good.eml']);
    });

    it('a progress callback that throws does not stop the batch', async () =>
    {
        const result = await processFilesWith([textFile('plain.eml', fixture('01-plain-english.eml')).file], STEPS, {
            onProgress: () =>
            {
                throw new Error('display broke');
            },
        });
        expect(result.ok).toBe(true);
    });

    it('an empty list still gives an (empty) organized result', async () =>
    {
        const organizeSpy = vi.fn(organize);
        const result = await processFilesWith([], { ...STEPS, organize: organizeSpy });
        expect(result.ok && result.engine.counts.filesGiven).toBe(0);
        expect(organizeSpy).toHaveBeenCalledWith([], undefined);
    });

    it('an HTML body the converter cannot handle: the message is listed with html-body-unreadable, not as a failed file', async () =>
    {
        const failing = (inputs: readonly InputFile[]): Promise<ParseResult[]> =>
            parseFilesWith(inputs, (job) =>
                createEmlParser({
                    htmlToText: () =>
                    {
                        throw new RangeError('Maximum call stack size exceeded');
                    },
                }).parse(job),
            );
        const result = await processFilesWith([textFile('html.eml', fixture('50-html-only.eml')).file], { ...STEPS, parse: failing });
        if (!result.ok)
        {
            throw new Error(result.detail);
        }
        expect(result.engine.counts.filesFailed).toBe(0);
        expect(result.engine.messages[0]?.parserWarnings).toContain('html-body-unreadable');
        expect(result.engine.messages[0]?.message.bodyText).toBe('');
    });
});

describe('processFilesWith: cancelling ("Clear everything")', () =>
{
    const CANCELLED = { ok: false, error: 'cancelled', detail: CANCELLED_BATCH_DETAIL, parsed: [] };

    it('passes the signal to both steps', async () =>
    {
        const controller = new AbortController();
        const parseSpy = vi.fn<ProcessSteps['parse']>(parse);
        const organizeSpy = vi.fn<ProcessSteps['organize']>(organize);
        await processFilesWith([textFile('plain.eml', fixture('01-plain-english.eml')).file], { ...STEPS, parse: parseSpy, organize: organizeSpy }, { signal: controller.signal });
        expect(parseSpy.mock.calls[0]?.[1]).toBe(controller.signal);
        expect(organizeSpy.mock.calls[0]?.[1]).toBe(controller.signal);
    });

    it('already aborted: nothing is read, parsed or organized', async () =>
    {
        const controller = new AbortController();
        controller.abort();
        const file = textFile('plain.eml', fixture('01-plain-english.eml'));
        const parseSpy = vi.fn(parse);
        const organizeSpy = vi.fn(organize);
        const progress: ProcessProgress[] = [];
        const result = await processFilesWith([file.file], { ...STEPS, parse: parseSpy, organize: organizeSpy }, { signal: controller.signal, onProgress: (p) => progress.push(p) });
        expect(result).toEqual(CANCELLED);
        expect(file.arrayBuffer).not.toHaveBeenCalled();
        expect(parseSpy).not.toHaveBeenCalled();
        expect(organizeSpy).not.toHaveBeenCalled();
        expect(progress).toEqual([]);
    });

    it('aborted while a file is parsed: no further file is read, the engine never runs, nothing is kept', async () =>
    {
        const controller = new AbortController();
        const files = [textFile('a.eml', fixture('10-order-1-alice.eml')), textFile('b.eml', fixture('11-order-2-bob-outlook-en.eml'))];
        const organizeSpy = vi.fn(organize);
        const progress: ProcessProgress[] = [];
        const steps: ProcessSteps = {
            ...STEPS,
            organize: organizeSpy,
            parse: async (inputs, signal) =>
            {
                controller.abort(); // "Clear everything" while the first file is in its worker
                expect(signal?.aborted).toBe(true);
                return parse(inputs);
            },
        };
        const result = await processFilesWith(
            files.map((f) => f.file),
            steps,
            { signal: controller.signal, onProgress: (p) => progress.push(p) },
        );
        expect(result).toEqual(CANCELLED);
        expect(files[1]?.arrayBuffer).not.toHaveBeenCalled();
        expect(organizeSpy).not.toHaveBeenCalled();
        // Only the start was reported: nothing after the abort.
        expect(progress).toEqual([{ stage: 'reading', filesDone: 0, filesTotal: 2 }]);
    });

    it('aborted while the browser reads a file: its bytes are never parsed', async () =>
    {
        const controller = new AbortController();
        const parseSpy = vi.fn(parse);
        const file: FileLike = {
            name: 'slow.eml',
            size: 10,
            arrayBuffer: () =>
            {
                controller.abort();
                return Promise.resolve(new ArrayBuffer(10));
            },
        };
        const result = await processFilesWith([file], { ...STEPS, parse: parseSpy }, { signal: controller.signal });
        expect(result).toEqual(CANCELLED);
        expect(parseSpy).not.toHaveBeenCalled();
    });

    it('aborted while organizing: the engine result that still comes is thrown away', async () =>
    {
        const controller = new AbortController();
        const steps: ProcessSteps = {
            ...STEPS,
            organize: (results) =>
            {
                controller.abort();
                return organize(results);
            },
        };
        const result = await processFilesWith([textFile('plain.eml', fixture('01-plain-english.eml')).file], steps, { signal: controller.signal });
        expect(result).toEqual(CANCELLED);
    });

    it('a step that rejects after the abort still gives the cancelled result', async () =>
    {
        const controller = new AbortController();
        const steps: ProcessSteps = {
            ...STEPS,
            organize: () =>
            {
                controller.abort();
                return Promise.reject(new Error('worker terminated'));
            },
        };
        const result = await processFilesWith([textFile('plain.eml', fixture('01-plain-english.eml')).file], steps, { signal: controller.signal });
        expect(result).toEqual(CANCELLED);
    });

    it('a signal that is never aborted changes nothing', async () =>
    {
        const result = await processFilesWith([textFile('plain.eml', fixture('01-plain-english.eml')).file], STEPS, { signal: new AbortController().signal });
        expect(result.ok).toBe(true);
    });
});
