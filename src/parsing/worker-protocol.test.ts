// Unit tests for the page <-> worker messages (worker-protocol.ts): the
// message checks, the worker's side, and a full round trip with
// runInWorker (worker-runner.ts) over an in-memory fake channel that copies
// every message with structuredClone, like the browser does.
//
// The HTML converter here is a stub (Node has no DOMParser); the real one
// is checked in Chromium by e2e/parse-files.spec.ts.

import { describe, expect, it } from 'vitest';
import { buildMsg, type MsgSpec } from '../../tests/fixtures/msg/builder';
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

/**
 * Emails attached inside: top --inline--> A (which holds C, sent as an
 * attachment, HTML only) and B sent as an attachment, which holds D inline.
 */
const ATTACHED_EML = [
    'X-Synthetic-Fixture: true',
    'From: Alice Example <alice@example.test>',
    'Subject: Two attached emails',
    'Date: Fri, 06 Jun 2025 10:00:00 +0200',
    'Message-ID: <proto-attached@example.test>',
    'Content-Type: multipart/mixed; boundary="top"',
    '',
    '--top',
    'Content-Type: text/plain',
    '',
    'See the two emails.',
    '--top',
    'Content-Type: message/rfc822',
    '',
    'From: carol@example.test',
    'Subject: A',
    'Content-Type: multipart/mixed; boundary="a"',
    '',
    '--a',
    'Content-Type: text/plain',
    '',
    'A body.',
    '--a',
    'Content-Type: message/rfc822',
    'Content-Disposition: attachment; filename="c.eml"',
    '',
    'From: erin@example.test',
    'Subject: C',
    'Content-Type: text/html',
    '',
    '<p>C body</p>',
    '--a--',
    '--top',
    'Content-Type: message/rfc822',
    'Content-Disposition: attachment; filename="b.eml"',
    '',
    'From: dave@example.test',
    'Subject: B',
    'Content-Type: multipart/mixed; boundary="b"',
    '',
    '--b',
    'Content-Type: text/plain',
    '',
    'B body.',
    '--b',
    'Content-Type: message/rfc822',
    '',
    'From: frank@example.test',
    'Subject: D',
    '',
    'D body.',
    '--b--',
    '--top--',
    '',
].join('\r\n');

const stubConverter = (html: string): HtmlToTextResult => ({ text: html.replace(/<[^>]*>/g, ''), truncated: false });

describe('isFromWorker: attached emails (strict)', () =>
{
    async function parsed(): Promise<ParseResult>
    {
        return createEmlParser({ htmlToText: stubConverter }).parse({ name: 'a.eml', bytes: encode(ATTACHED_EML) });
    }

    it('the real result is accepted, with the expected shape', async () =>
    {
        const result = await parsed();
        expect(isFromWorker({ type: 'result', result })).toBe(true);
        if (!result.ok) throw new Error(result.detail);
        expect(result.attached?.map((e) => [e.message.subject, e.parent, e.path, e.places.map((p) => p.holder)])).toEqual([
            ['A', -1, [1], [-1]],
            ['C', 0, [1, 1], []],
            ['B', -1, [2], []],
            ['D', 2, [2, 1], [2]],
        ]);
        // C is listed in A, and so in the top's flat list, marked as A's.
        expect(result.message.attachments.map((a) => [a.fileName, a.attachedIndex])).toEqual([
            ['c.eml', 0],
            ['b.eml', undefined],
        ]);
    });

    // A mutable, loosely typed copy of the result, for the mutations below.
    interface LooseMessage {
        bodyText: unknown;
        attachments: unknown;
        source: { attachedPath?: unknown; fileName?: unknown; sha256?: unknown; kind?: unknown };
    }
    interface LoosePlace {
        holder: unknown;
        start: number;
        end: number;
    }
    interface LooseEntry {
        parent: unknown;
        path: unknown;
        places: unknown;
        name?: unknown;
        message: LooseMessage;
    }
    interface LooseResult {
        ok: boolean;
        message?: LooseMessage;
        attached?: unknown;
    }
    function at<T>(list: unknown, index: number): T
    {
        const value = (list as T[])[index];
        if (value === undefined) throw new Error(`nothing at ${String(index)}`);
        return value;
    }
    const entry = (r: LooseResult, i: number): LooseEntry => at<LooseEntry>(r.attached, i);
    const place = (r: LooseResult, i: number): LoosePlace => at<LoosePlace>(entry(r, i).places, 0);
    const ownMessage = (r: LooseResult): LooseMessage =>
    {
        if (r.message === undefined) throw new Error('no message');
        return r.message;
    };
    const pushAttachment = (m: LooseMessage, attachedIndex: number): void =>
    {
        (m.attachments as unknown[]).push({ fileName: '', size: 1, mimeType: 'x/y', attachedIndex });
    };

    it.each<[string, (r: LooseResult) => void]>([
        ['attached on a failed result', (r) => ((r.ok = false), (r.attached = []))],
        ['an empty attached list', (r) => (r.attached = [])],
        ['attached not a list', (r) => (r.attached = {})],
        ['an entry that is not an object', (r) => ((r.attached as unknown[])[1] = 7)],
        ['a parent that is not earlier', (r) => (entry(r, 1).parent = 1)],
        ['no name (task 8.13b-3)', (r) => delete entry(r, 1).name],
        ['a name that is not a string', (r) => (entry(r, 0).name = 7)],
        ['a parent below -1', (r) => (entry(r, 0).parent = -2)],
        ['a parent that is not an integer', (r) => (entry(r, 1).parent = 0.5)],
        ['a path that does not extend the parent path', (r) => (entry(r, 1).path = [2, 1])],
        ['a path too long', (r) => (entry(r, 0).path = [1, 1])],
        ['a path number 0', (r) => (entry(r, 0).path = [0])],
        ['attachedPath missing', (r) => delete entry(r, 0).message.source.attachedPath],
        ['attachedPath not the path', (r) => (entry(r, 0).message.source.attachedPath = [3])],
        ['attachedPath on the file email', (r) => (ownMessage(r).source.attachedPath = [1])],
        ['places not a list', (r) => (entry(r, 0).places = null)],
        ['a place in a holder that is not the parent', (r) => (place(r, 3).holder = -1)],
        ['more places than ancestors', (r) => (entry(r, 0).places as unknown[]).push({ ...place(r, 0) })],
        ['a place past the end of the body', (r) => (place(r, 0).end = 1e6)],
        ['a place ending before it starts', (r) => (place(r, 0).end = place(r, 0).start - 1)],
        ['a place not at a forwarded separator', (r) => (place(r, 0).start += 1)],
        ['a body that is not text', (r) => (entry(r, 2).message.bodyText = 1)],
        ['an attachedIndex out of range', (r) => (at<{ attachedIndex: number }>(ownMessage(r).attachments, 0).attachedIndex = 4)],
        ['a negative attachedIndex', (r) => (at<{ attachedIndex: number }>(ownMessage(r).attachments, 0).attachedIndex = -1)],
        ['an attachedIndex that is not a descendant', (r) => pushAttachment(entry(r, 0).message, 2)],
        ['an attachedIndex pointing to itself', (r) => pushAttachment(entry(r, 0).message, 0)],
        ['an attachedIndex with no attached list', (r) => delete r.attached],
        ['attachments not a list', (r) => (entry(r, 1).message.attachments = 'c.eml')],
        ['a successful result without a message', (r) => delete r.message],
        ['an entry with another file name', (r) => (entry(r, 1).message.source.fileName = 'other.eml')],
        ['an entry with another hash', (r) => (entry(r, 1).message.source.sha256 = '0'.repeat(64))],
        ['an entry of another kind', (r) => (entry(r, 1).message.source.kind = 'msg')],
    ])('rejects %s', async (_label, mutate) =>
    {
        const result = structuredClone(await parsed()) as unknown as LooseResult;
        mutate(result);
        expect(isFromWorker({ type: 'result', result })).toBe(false);
    });
});

/**
 * A .msg file with attached Outlook items (task 8.13b-2): A (which holds
 * A1, and a text file) and B, after an ordinary attachment.
 */
const ATTACHED_MSG_SPEC: MsgSpec = (() =>
{
    const base: MsgSpec = {
        id: 'proto-attached-msg',
        description: 'attached Outlook items',
        strings: 'unicode',
        subject: 'Two attached items',
        sender: { name: 'Alice Example', smtp: 'alice@example.test' },
        recipients: [{ name: 'Bob Sample', smtp: 'bob@example.test', type: 'to' }],
        bodyText: 'See the two emails.',
        submitTime: '2025-06-06T08:00:00Z',
        messageId: '<proto-attached-msg@example.test>',
    };
    const inner = (subject: string, extra: Partial<MsgSpec> = {}): MsgSpec => ({ ...base, subject, bodyText: `${subject} body.`, messageId: `<${subject}@example.test>`, ...extra });
    return {
        ...base,
        attachments: [{ fileName: 'plan.txt', content: 'plan', mimeType: 'text/plain' }],
        attachedItems: [
            {
                displayName: 'A',
                message: inner('A', {
                    attachments: [{ fileName: 'notes.txt', content: 'notes' }],
                    attachedItems: [{ displayName: 'A1', message: inner('A1', { bodyText: undefined, bodyHtml: '<p>A1 body</p>' }) }],
                }),
            },
            { displayName: 'B', message: inner('B') },
        ],
    };
})();

describe('isFromWorker: attached Outlook items in a .msg file (strict)', () =>
{
    async function parsed(): Promise<ParseResult>
    {
        return createMsgParser({ htmlToText: stubConverter }).parse({ name: 'a.msg', bytes: buildMsg(ATTACHED_MSG_SPEC) });
    }

    it('the real result is accepted, with the expected shape', async () =>
    {
        const result = await parsed();
        expect(isFromWorker({ type: 'result', result })).toBe(true);
        if (!result.ok) throw new Error(result.detail);
        expect(result.attached?.map((e) => [e.message.subject, e.parent, e.path, e.places, e.message.source.kind])).toEqual([
            ['A', -1, [1], [], 'msg'],
            ['A1', 0, [1, 1], [], 'msg'],
            ['B', -1, [2], [], 'msg'],
        ]);
    });

    interface LooseMsgResult {
        message: { attachments: Record<string, unknown>[]; source: Record<string, unknown> };
        attached: { places: unknown[]; parent: unknown; message: { attachments: Record<string, unknown>[]; source: Record<string, unknown> } }[];
    }
    const entry = (r: LooseMsgResult, i: number): LooseMsgResult['attached'][number] =>
    {
        const value = r.attached[i];
        if (value === undefined) throw new Error(`nothing at ${String(i)}`);
        return value;
    };

    it.each<[string, (r: LooseMsgResult) => void]>([
        // An attached Outlook item is never printed in a body, so it can have no place.
        ['a place', (r) => entry(r, 0).places.push({ holder: -1, start: 0, end: 0 })],
        ['an attachedIndex on the file email', (r) => r.message.attachments.push({ fileName: 'x', size: 1, mimeType: 'x/y', attachedIndex: 1 })],
        ['an attachedIndex on an attached item, to its descendant', (r) => entry(r, 0).message.attachments.push({ fileName: 'x', size: 1, mimeType: 'x/y', attachedIndex: 1 })],
        ['an entry of another kind', (r) => (entry(r, 2).message.source.kind = 'eml')],
        ['an entry with another hash', (r) => (entry(r, 2).message.source.sha256 = '0'.repeat(64))],
        ['an entry whose parent is not earlier', (r) => (entry(r, 1).parent = 2)],
        ['an entry without its attachedPath', (r) => delete entry(r, 1).message.source.attachedPath],
    ])('rejects %s', async (_label, mutate) =>
    {
        const result = structuredClone(await parsed()) as unknown as LooseMsgResult;
        mutate(result);
        expect(isFromWorker({ type: 'result', result })).toBe(false);
    });
});

describe('isToWorker / isFromWorker', () =>
{
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
    ])('isToWorker(%j) = %s', (data, expected) =>
    {
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
    ])('isFromWorker(%j) = %s', (data, expected) =>
    {
        expect(isFromWorker(data)).toBe(expected);
    });
});

/** Collects what the worker side posts; resolves `next()` with the next message. */
function workerSide()
{
    const posted: FromWorker[] = [];
    const waiters: ((message: FromWorker) => void)[] = [];
    const handle = createWorkerSide((message) =>
    {
        const waiter = waiters.shift();
        if (waiter) waiter(message);
        else posted.push(message);
    });
    const next = (): Promise<FromWorker> =>
    {
        const ready = posted.shift();
        return ready ? Promise.resolve(ready) : new Promise((resolve) => waiters.push(resolve));
    };
    return { handle, next, posted };
}

describe('createWorkerSide', () =>
{
    it('a plain-text message: one result, no HTML request', async () =>
    {
        const side = workerSide();
        side.handle({ type: 'parse', name: 'plain.eml', kind: 'eml', bytes: encode(PLAIN_EML) });
        const message = await side.next();
        expect(message.type).toBe('result');
        expect(message.type === 'result' && message.result.ok && message.result.message.bodyText).toBe('The desks arrive on Thursday.\n');
    });

    it('an HTML message: asks the page, then answers with the converted text and the same warnings', async () =>
    {
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

    it('ignores malformed messages, unexpected conversions and a second parse request', async () =>
    {
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
const inMemoryWorker: WorkerFactory = (events) =>
{
    let terminated = false;
    const handle = createWorkerSide((message) =>
    {
        const copy = structuredClone(message);
        setTimeout(() =>
        {
            if (!terminated) events.message(copy);
        }, 0);
    });
    return {
        send: (message, transfer) =>
        {
            const copy = structuredClone(message, { transfer });
            setTimeout(() =>
            {
                if (!terminated) handle(copy);
            }, 0);
        },
        terminate: () =>
        {
            terminated = true;
        },
    };
};

describe('round trip: runInWorker + createWorkerSide', () =>
{
    async function viaWorker(name: string, kind: 'eml' | 'msg', bytes: Uint8Array): Promise<ParseResult>
    {
        return runInWorker(
            { name, kind, bytes, sha256: await sha256Hex(bytes) },
            { createWorker: inMemoryWorker, htmlToText: stubConverter, timeoutMs: 10_000 },
        );
    }

    it.each([
        ['plain .eml', 'plain.eml', 'eml', () => encode(PLAIN_EML)],
        ['HTML-only .eml', 'html.eml', 'eml', () => encode(HTML_EML)],
        ['on-behalf .eml with Bcc', 'on-behalf.eml', 'eml', () => encode(ON_BEHALF_EML)],
        // HTML only inside an email sent as an attachment: recorded and replayed too.
        ['.eml with attached emails', 'attached.eml', 'eml', () => encode(ATTACHED_EML)],
        // HTML only inside an attached Outlook item: recorded and replayed too.
        ['.msg with attached Outlook items', 'attached.msg', 'msg', () => buildMsg(ATTACHED_MSG_SPEC)],
        ...MSG_SPECS.map((spec) => [spec.id, `${spec.id}.msg`, 'msg', () => buildMsg(spec)] as const),
    ] as const)('%s gives exactly the result of a direct parse', async (_label, name, kind, make) =>
    {
        const direct = await (kind === 'eml' ? createEmlParser({ htmlToText: stubConverter }) : createMsgParser({ htmlToText: stubConverter })).parse({
            name,
            bytes: make(),
        });
        expect(await viaWorker(name, kind, make())).toEqual(direct);
    });

    it('carries sender and bcc through the worker (.eml and .msg), and no sender key when there is none', async () =>
    {
        const eml = await viaWorker('on-behalf.eml', 'eml', encode(ON_BEHALF_EML));
        if (!eml.ok) throw new Error(eml.detail);
        expect(eml.message.sender).toEqual({ name: 'Carol Test', address: 'carol@example.test' });
        expect(eml.message.bcc).toEqual([
            { name: 'Sample Furniture Planning', address: 'planning@example.test' },
            { name: '', address: 'erin@example.test' },
        ]);

        const spec = (id: string) =>
        {
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

    it("the caller's bytes are moved to the worker (the array is empty afterwards)", async () =>
    {
        const bytes = encode(PLAIN_EML);
        const result = await viaWorker('plain.eml', 'eml', bytes);
        expect(result.ok).toBe(true);
        expect(bytes.byteLength).toBe(0);
    });
});
