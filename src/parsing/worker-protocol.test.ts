// Unit tests for the page <-> worker messages (worker-protocol.ts): the
// message checks, the worker's side, and a full round trip with
// runInWorker (worker-runner.ts) over an in-memory fake channel that copies
// every message with structuredClone, like the browser does.
//
// The HTML converter here is a stub (Node has no DOMParser); the real one
// is checked in Chromium by e2e/parse-files.spec.ts.

import { describe, expect, it } from 'vitest';
import { buildMsg } from '../../tests/fixtures/msg/builder';
import { MSG_SPECS } from '../../tests/fixtures/msg/specs';
import { createEmlParser } from './eml';
import { sha256Hex } from './hash';
import type { HtmlToTextResult } from './html-to-text';
import { createMsgParser } from './msg';
import type { ParseResult } from './types';
import { createWorkerSide, isFromWorker, isToWorker, type FromWorker } from './worker-protocol';
import { runInWorker, type WorkerFactory } from './worker-runner';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const PLAIN_EML = [
  'X-Synthetic-Fixture: true',
  'From: Alice Example <alice@example.test>',
  'To: Bob Sample <bob@example.test>',
  'Subject: Desk delivery',
  'Date: Tue, 03 Jun 2025 12:05:09 +0200',
  'Message-ID: <proto-plain@example.test>',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'The desks arrive on Thursday.',
].join('\r\n');

const HTML_EML = [
  'X-Synthetic-Fixture: true',
  'From: Carol Test <carol@example.test>',
  'To: Bob Sample <bob@example.test>',
  'Subject: Chair catalogue',
  'Date: Wed, 04 Jun 2025 08:00:00 +0000',
  'Message-ID: <proto-html@example.test>',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>Three chair models</p>',
].join('\r\n');

/** Sent on behalf of someone, with Bcc recipients: the optional `sender` and `bcc` must survive the copy. */
const ON_BEHALF_EML = [
  'X-Synthetic-Fixture: true',
  'From: Alice Example <alice@example.test>',
  'Sender: Carol Test <carol@example.test>',
  'To: Bob Sample <bob@example.test>',
  'Bcc: Sample Furniture Planning <planning@example.test>, erin@example.test',
  'Subject: Desk delivery, on behalf of Alice',
  'Date: Thu, 05 Jun 2025 09:00:00 +0200',
  'Message-ID: <proto-on-behalf@example.test>',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Sent for Alice: the desks arrive on Thursday.',
].join('\r\n');

const stubConverter = (html: string): HtmlToTextResult => ({ text: html.replace(/<[^>]*>/g, ''), truncated: false });

describe('isToWorker / isFromWorker', () => {
  it.each([
    [{ type: 'parse', name: 'a.eml', kind: 'eml', bytes: new Uint8Array(1) }, true],
    [{ type: 'parse', name: 'a.msg', kind: 'msg', bytes: new Uint8Array(1) }, true],
    [{ type: 'parse', name: 'a.txt', kind: 'txt', bytes: new Uint8Array(1) }, false],
    [{ type: 'parse', name: 'a.eml', kind: 'eml', bytes: [1, 2] }, false],
    [{ type: 'parse', name: 1, kind: 'eml', bytes: new Uint8Array(1) }, false],
    [{ type: 'conversions', outcomes: [] }, true],
    [{ type: 'conversions' }, false],
    [{ type: 'other' }, false],
    [null, false],
    ['parse', false],
  ])('isToWorker(%j) = %s', (data, expected) => {
    expect(isToWorker(data)).toBe(expected);
  });

  it.each([
    [{ type: 'html', htmls: ['<p>'] }, true],
    [{ type: 'html', htmls: [1] }, false],
    [{ type: 'result', result: { ok: false } }, true],
    [{ type: 'result', result: null }, false],
    [{ type: 'result' }, false],
    [{ type: 'failed' }, true],
    [{ type: 'progress' }, false],
    [undefined, false],
  ])('isFromWorker(%j) = %s', (data, expected) => {
    expect(isFromWorker(data)).toBe(expected);
  });
});

/** Collects what the worker side posts; resolves `next()` with the next message. */
function workerSide() {
  const posted: FromWorker[] = [];
  const waiters: ((message: FromWorker) => void)[] = [];
  const handle = createWorkerSide((message) => {
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else posted.push(message);
  });
  const next = (): Promise<FromWorker> => {
    const ready = posted.shift();
    return ready ? Promise.resolve(ready) : new Promise((resolve) => waiters.push(resolve));
  };
  return { handle, next, posted };
}

describe('createWorkerSide', () => {
  it('a plain-text message: one result, no HTML request', async () => {
    const side = workerSide();
    side.handle({ type: 'parse', name: 'plain.eml', kind: 'eml', bytes: encode(PLAIN_EML) });
    const message = await side.next();
    expect(message.type).toBe('result');
    expect(message.type === 'result' && message.result.ok && message.result.message.bodyText).toBe('The desks arrive on Thursday.\n');
  });

  it('an HTML message: asks the page, then answers with the converted text and the same warnings', async () => {
    const side = workerSide();
    side.handle({ type: 'parse', name: 'html.eml', kind: 'eml', bytes: encode(HTML_EML) });
    const ask = await side.next();
    // postal-mime ends the decoded part with a line break.
    expect(ask).toEqual({ type: 'html', htmls: ['<p>Three chair models</p>\n'] });
    side.handle({ type: 'conversions', outcomes: [{ ok: true, text: 'Three chair models', truncated: true }] });
    const answer = await side.next();
    expect(answer.type === 'result' && answer.result.ok && answer.result.message.bodyText).toBe('Three chair models');
    expect(answer.type === 'result' && answer.result.ok && [...answer.result.message.warnings]).toEqual(
      expect.arrayContaining(['html-converted-body', 'html-body-truncated']),
    );
  });

  it('ignores malformed messages, unexpected conversions and a second parse request', async () => {
    const side = workerSide();
    side.handle({ type: 'nonsense' });
    side.handle({ type: 'conversions', outcomes: [] }); // nobody is waiting
    side.handle({ type: 'parse', name: 'plain.eml', kind: 'eml', bytes: encode(PLAIN_EML) });
    side.handle({ type: 'parse', name: 'second.eml', kind: 'eml', bytes: encode(PLAIN_EML) });
    const message = await side.next();
    expect(message.type === 'result' && message.result.ok && message.result.message.source.fileName).toBe('plain.eml');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(side.posted).toEqual([]);
  });
});

/**
 * A fake WorkerFactory over createWorkerSide: messages go both ways
 * asynchronously and are copied with structuredClone (transferred buffers are
 * moved, as in the browser).
 */
const inMemoryWorker: WorkerFactory = (events) => {
  let terminated = false;
  const handle = createWorkerSide((message) => {
    const copy = structuredClone(message);
    setTimeout(() => {
      if (!terminated) events.message(copy);
    }, 0);
  });
  return {
    send: (message, transfer) => {
      const copy = structuredClone(message, { transfer });
      setTimeout(() => {
        if (!terminated) handle(copy);
      }, 0);
    },
    terminate: () => {
      terminated = true;
    },
  };
};

describe('round trip: runInWorker + createWorkerSide', () => {
  async function viaWorker(name: string, kind: 'eml' | 'msg', bytes: Uint8Array): Promise<ParseResult> {
    return runInWorker(
      { name, kind, bytes, sha256: await sha256Hex(bytes) },
      { createWorker: inMemoryWorker, htmlToText: stubConverter, timeoutMs: 10_000 },
    );
  }

  it.each([
    ['plain .eml', 'plain.eml', 'eml', () => encode(PLAIN_EML)],
    ['HTML-only .eml', 'html.eml', 'eml', () => encode(HTML_EML)],
    ['on-behalf .eml with Bcc', 'on-behalf.eml', 'eml', () => encode(ON_BEHALF_EML)],
    ...MSG_SPECS.map((spec) => [spec.id, `${spec.id}.msg`, 'msg', () => buildMsg(spec)] as const),
  ] as const)('%s gives exactly the result of a direct parse', async (_label, name, kind, make) => {
    const direct = await (kind === 'eml' ? createEmlParser({ htmlToText: stubConverter }) : createMsgParser({ htmlToText: stubConverter })).parse({
      name,
      bytes: make(),
    });
    expect(await viaWorker(name, kind, make())).toEqual(direct);
  });

  it('carries sender and bcc through the worker (.eml and .msg), and no sender key when there is none', async () => {
    const eml = await viaWorker('on-behalf.eml', 'eml', encode(ON_BEHALF_EML));
    if (!eml.ok) throw new Error(eml.detail);
    expect(eml.message.sender).toEqual({ name: 'Carol Test', address: 'carol@example.test' });
    expect(eml.message.bcc).toEqual([
      { name: 'Sample Furniture Planning', address: 'planning@example.test' },
      { name: '', address: 'erin@example.test' },
    ]);

    const spec = (id: string) => {
      const found = MSG_SPECS.find((s) => s.id === id);
      if (found === undefined) throw new Error(`missing spec ${id}`);
      return found;
    };
    const onBehalf = await viaWorker('a.msg', 'msg', buildMsg(spec('msg-10-on-behalf')));
    if (!onBehalf.ok) throw new Error(onBehalf.detail);
    expect(onBehalf.message.sender).toEqual({ name: 'Sample Furniture Planning', address: 'planning@furniture.example.test' });
    const bcc = await viaWorker('b.msg', 'msg', buildMsg(spec('msg-11-bcc-own-copy')));
    if (!bcc.ok) throw new Error(bcc.detail);
    expect(bcc.message.bcc).toEqual([{ name: 'Carol Test - Équipe Livraisons', address: 'carol@sample.invalid' }]);
    expect('sender' in bcc.message).toBe(false);

    const plain = await viaWorker('plain.eml', 'eml', encode(PLAIN_EML));
    if (!plain.ok) throw new Error(plain.detail);
    expect('sender' in plain.message).toBe(false);
    expect(plain.message.bcc).toEqual([]);
  });

  it("the caller's bytes are moved to the worker (the array is empty afterwards)", async () => {
    const bytes = encode(PLAIN_EML);
    const result = await viaWorker('plain.eml', 'eml', bytes);
    expect(result.ok).toBe(true);
    expect(bytes.byteLength).toBe(0);
  });
});
