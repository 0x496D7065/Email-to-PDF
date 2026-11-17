// Unit tests for the engine worker's messages and its side of the
// conversation (engine-protocol.ts), in Node without a browser. The real
// worker is checked in Chromium by Helper/Test/browser-tests/parse-files.spec.ts.

import { describe, expect, it } from 'vitest';
import { runEngine } from '../thread-analysis/engine';
import type { NormalizedMessage, ParseResult } from '../email-reading/types';
import { createEngineWorkerSide, isFromEngineWorker, isToEngineWorker, type FromEngineWorker } from './engine-protocol';

const FAILED_FILE: ParseResult = { ok: false, fileName: 'notes.txt', sha256: null, error: 'unsupported-type', detail: 'not an email file' };

/** An email quoting an earlier one, so the result holds a rebuilt message and a timeline. */
const QUOTING: NormalizedMessage = {
    messageId: 'protocol-1@example.test',
    inReplyTo: null,
    references: [],
    date: { utcMs: Date.parse('2025-03-04T10:00:00Z'), original: '', offsetMinutes: 60, zoneKnown: true },
    from: [{ name: 'Bob Sample', address: 'bob@furniture.example.test' }],
    to: [],
    cc: [],
    bcc: [],
    subject: 'Re: Desks',
    bodyText: 'Fine for me.\n\nOn Mon, 3 Mar 2025 at 14:02, Alice Example <alice@example.test> wrote:\n> Could you send a quote?\n',
    attachments: [],
    source: { fileName: 'reply.eml', sha256: '0'.repeat(64), kind: 'eml' },
    warnings: [],
};
const WITH_REBUILT: readonly ParseResult[] = [{ ok: true, message: QUOTING }, FAILED_FILE];
const RESULT = runEngine(WITH_REBUILT);

describe('message checks', () =>
{
    it('accepts a run request with parse results', () =>
    {
        expect(isToEngineWorker({ type: 'run', results: [] })).toBe(true);
        expect(isToEngineWorker({ type: 'run', results: [FAILED_FILE] })).toBe(true);
    });

    it.each([
        ['null', null],
        ['a string', 'run'],
        ['another type', { type: 'parse', results: [] }],
        ['results not a list', { type: 'run', results: 'x' }],
        ['a result without ok', { type: 'run', results: [{ fileName: 'x' }] }],
        ['a result that is not an object', { type: 'run', results: [1] }],
    ])('rejects %s as a request', (_label, data) =>
    {
        expect(isToEngineWorker(data)).toBe(false);
    });

    it('accepts a real engine result and a failure', () =>
    {
        expect(isFromEngineWorker({ type: 'result', result: runEngine([FAILED_FILE]) })).toBe(true);
        expect(RESULT.reconstructed.length).toBe(1);
        expect(RESULT.timeline.length).toBe(2);
        expect(isFromEngineWorker({ type: 'result', result: RESULT })).toBe(true);
        expect(isFromEngineWorker({ type: 'failed' })).toBe(true);
    });

    it.each([
        ['null', null],
        ['an unknown type', { type: 'html' }],
        ['a result without a body', { type: 'result' }],
        ['messages not a list', { type: 'result', result: { messages: {}, failed: [], counts: {}, positionByIndex: [] } }],
        ['no counts', { type: 'result', result: { messages: [], failed: [], positionByIndex: [] } }],
        ['no positionByIndex', { type: 'result', result: { messages: [], failed: [], counts: {} } }],
        ['no reconstructed list', { type: 'result', result: { ...RESULT, reconstructed: undefined } }],
        ['timeline not a list', { type: 'result', result: { ...RESULT, timeline: {} } }],
        ['no reconstruction warnings', { type: 'result', result: { ...RESULT, reconstructionWarnings: null } }],
    ])('rejects %s as a reply', (_label, data) =>
    {
        expect(isFromEngineWorker(data)).toBe(false);
    });
});

describe('createEngineWorkerSide', () =>
{
    it('runs the engine once and posts its result', () =>
    {
        const posted: FromEngineWorker[] = [];
        const handle = createEngineWorkerSide((m) => posted.push(m));
        handle({ type: 'run', results: [FAILED_FILE] });
        expect(posted).toEqual([{ type: 'result', result: runEngine([FAILED_FILE]) }]);
    });

    it('the result survives a structured clone unchanged (plain data only), rebuilt messages included', () =>
    {
        let result: unknown;
        createEngineWorkerSide((m) => (result = m.type === 'result' ? m.result : undefined))({ type: 'run', results: WITH_REBUILT });
        expect(result).toEqual(RESULT);
        expect(structuredClone(result)).toEqual(result);
    });

    it('ignores malformed messages and a second request', () =>
    {
        const posted: FromEngineWorker[] = [];
        const handle = createEngineWorkerSide((m) => posted.push(m));
        handle(null);
        handle({ type: 'run', results: 'nope' });
        expect(posted).toEqual([]);
        handle({ type: 'run', results: [] });
        handle({ type: 'run', results: [FAILED_FILE] });
        expect(posted).toHaveLength(1);
    });

    it('an engine that throws gives a bare failure message (no internals)', () =>
    {
        const posted: FromEngineWorker[] = [];
        const handle = createEngineWorkerSide(
            (m) => posted.push(m),
            () =>
            {
                throw new TypeError('secret internals');
            },
        );
        handle({ type: 'run', results: [] });
        expect(posted).toEqual([{ type: 'failed' }]);
    });

    it('a result that cannot be posted is followed by a failure message', () =>
    {
        const posted: FromEngineWorker[] = [];
        const handle = createEngineWorkerSide((m) =>
        {
            if (m.type === 'result')
            {
                throw new Error('DataCloneError');
            }
            posted.push(m);
        });
        handle({ type: 'run', results: [] });
        expect(posted).toEqual([{ type: 'failed' }]);
    });
});
