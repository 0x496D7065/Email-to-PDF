// Unit tests for the engine worker's messages and its side of the
// conversation (engine-protocol.ts), in Node without a browser. The real
// worker is checked in Chromium by e2e/parse-files.spec.ts.

import { describe, expect, it } from 'vitest';
import { runEngine } from '../engine/engine';
import type { ParseResult } from '../parsing/types';
import { createEngineWorkerSide, isFromEngineWorker, isToEngineWorker, type FromEngineWorker } from './engine-protocol';

const FAILED_FILE: ParseResult = { ok: false, fileName: 'notes.txt', sha256: null, error: 'unsupported-type', detail: 'not an email file' };

describe('message checks', () => {
  it('accepts a run request with parse results', () => {
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
  ])('rejects %s as a request', (_label, data) => {
    expect(isToEngineWorker(data)).toBe(false);
  });

  it('accepts a real engine result and a failure', () => {
    expect(isFromEngineWorker({ type: 'result', result: runEngine([FAILED_FILE]) })).toBe(true);
    expect(isFromEngineWorker({ type: 'failed' })).toBe(true);
  });

  it.each([
    ['null', null],
    ['an unknown type', { type: 'html' }],
    ['a result without a body', { type: 'result' }],
    ['messages not a list', { type: 'result', result: { messages: {}, failed: [], counts: {}, positionByIndex: [] } }],
    ['no counts', { type: 'result', result: { messages: [], failed: [], positionByIndex: [] } }],
    ['no positionByIndex', { type: 'result', result: { messages: [], failed: [], counts: {} } }],
  ])('rejects %s as a reply', (_label, data) => {
    expect(isFromEngineWorker(data)).toBe(false);
  });
});

describe('createEngineWorkerSide', () => {
  it('runs the engine once and posts its result', () => {
    const posted: FromEngineWorker[] = [];
    const handle = createEngineWorkerSide((m) => posted.push(m));
    handle({ type: 'run', results: [FAILED_FILE] });
    expect(posted).toEqual([{ type: 'result', result: runEngine([FAILED_FILE]) }]);
  });

  it('the result survives a structured clone unchanged (plain data only)', () => {
    let result: unknown;
    createEngineWorkerSide((m) => (result = m.type === 'result' ? m.result : undefined))({ type: 'run', results: [FAILED_FILE] });
    expect(structuredClone(result)).toEqual(result);
  });

  it('ignores malformed messages and a second request', () => {
    const posted: FromEngineWorker[] = [];
    const handle = createEngineWorkerSide((m) => posted.push(m));
    handle(null);
    handle({ type: 'run', results: 'nope' });
    expect(posted).toEqual([]);
    handle({ type: 'run', results: [] });
    handle({ type: 'run', results: [FAILED_FILE] });
    expect(posted).toHaveLength(1);
  });

  it('an engine that throws gives a bare failure message (no internals)', () => {
    const posted: FromEngineWorker[] = [];
    const handle = createEngineWorkerSide(
      (m) => posted.push(m),
      () => {
        throw new TypeError('secret internals');
      },
    );
    handle({ type: 'run', results: [] });
    expect(posted).toEqual([{ type: 'failed' }]);
  });

  it('a result that cannot be posted is followed by a failure message', () => {
    const posted: FromEngineWorker[] = [];
    const handle = createEngineWorkerSide((m) => {
      if (m.type === 'result') throw new Error('DataCloneError');
      posted.push(m);
    });
    handle({ type: 'run', results: [] });
    expect(posted).toEqual([{ type: 'failed' }]);
  });
});
