// Unit tests for .eml files that start with a UTF-8 byte order mark (task 9.7).
// Some tools save an .eml file with the mark EF BB BF in front of the first
// header; that header must be read exactly as without the mark, and the file
// hash must still be the one of the file's own bytes, mark included. Every
// message is built in memory from synthetic text (README.md, rule R7).

import { describe, expect, it } from 'vitest';
import { createEmlParser } from './eml-parser';
import { withoutLeadingBom } from './eml-tree';
import { sha256Hex } from './file-hash';
import type { HtmlToTextResult } from './html-to-text';
import type { NormalizedMessage, ParseResult } from '../../Header/parsed-email';

const BOM = [0xef, 0xbb, 0xbf];
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const crlf = (...lines: string[]): string => lines.join('\r\n');
/** Decodes UTF-8 and KEEPS a leading U+FEFF (a plain TextDecoder drops it). */
const decodeKeepingBom = (bytes: Uint8Array | ArrayBuffer): string => new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);

/** `fileBytes` with a UTF-8 byte order mark in front. */
function withBom(fileBytes: Uint8Array): Uint8Array
{
    const joined = new Uint8Array(BOM.length + fileBytes.length);
    joined.set(BOM, 0);
    joined.set(fileBytes, BOM.length);
    return joined;
}

const FROM = 'From: Alice Example <alice@example.test>';
const DATE = 'Date: Tue, 3 Jun 2025 14:05:09 +0200';
const SUBJECT = 'Subject: Byte order mark test';
const OTHERS = ['To: Bob Sample <bob@example.test>', 'Message-ID: <bom1@example.test>', 'MIME-Version: 1.0'];
const BODY = 'Hello Bob,\r\n\r\nThe first header must survive.\r\n';

const stub = (html: string): HtmlToTextResult => ({ text: `[html ${String(html.length)}]`, truncated: false });
const parser = createEmlParser({ htmlToText: stub });

type OkResult = Extract<ParseResult, { ok: true }>;

async function parseOk(fileBytes: Uint8Array, name = 'bom-test.eml'): Promise<OkResult>
{
    const result = await parser.parse({ name, bytes: fileBytes });
    if (!result.ok)
    {
        throw new Error(`expected ok, got ${result.error}: ${result.detail}`);
    }
    return result;
}

/** The message without its source hash, to compare two parses of the same text. */
function withoutHash(message: NormalizedMessage): NormalizedMessage
{
    return { ...message, source: { ...message.source, sha256: '' } };
}

/** A plain ArrayBuffer holding a copy of `bytes` (postal-mime accepts both kinds). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer
{
    const buffer = new ArrayBuffer(bytes.length);
    new Uint8Array(buffer).set(bytes);
    return buffer;
}

describe('createEmlParser: a UTF-8 byte order mark at the start of the file', () =>
{
    it.each([
        ['From', [FROM, DATE, SUBJECT]],
        ['Date', [DATE, FROM, SUBJECT]],
        ['Subject', [SUBJECT, FROM, DATE]],
    ])('keeps the first header (%s) exactly as without the mark; the body is unchanged; the hash covers the mark', async (_first, headers) =>
    {
        const plain = encode(crlf(...headers, ...OTHERS, '', BODY));
        const marked = withBom(plain);
        const without = (await parseOk(plain)).message;
        const message = (await parseOk(marked)).message;

        expect(message.from).toEqual([{ name: 'Alice Example', address: 'alice@example.test' }]);
        expect(message.date.original).toBe('Tue, 3 Jun 2025 14:05:09 +0200');
        expect(message.subject).toBe('Byte order mark test');
        expect(message.bodyText).toBe('Hello Bob,\n\nThe first header must survive.\n');
        expect(message.warnings).toEqual([]);
        expect(withoutHash(message)).toEqual(withoutHash(without));
        // The hash is the one of the file's own bytes, mark included.
        expect(message.source.sha256).toBe(await sha256Hex(marked));
        expect(message.source.sha256).not.toBe(await sha256Hex(plain));
    });

    it('only ONE mark is skipped: a second one is part of the first header name, as before', async () =>
    {
        const message = (await parseOk(withBom(withBom(encode(crlf(FROM, DATE, SUBJECT, '', BODY)))))).message;
        expect(message.from).toEqual([]);
        expect(message.subject).toBe('Byte order mark test');
    });

    it('a U+FEFF anywhere else is content and stays (header value and body)', async () =>
    {
        const fileBytes = withBom(encode(crlf(FROM, DATE, 'Subject: A\uFEFFB', '', 'Line one\r\n\uFEFFLine two\r\n')));
        const message = (await parseOk(fileBytes)).message;
        expect(message.from).toEqual([{ name: 'Alice Example', address: 'alice@example.test' }]);
        expect(message.subject).toBe('A\uFEFFB');
        expect(message.bodyText).toBe('Line one\n\uFEFFLine two\n');
    });

    it('bytes that only look like part of a mark (EF BB without BF) are not skipped', async () =>
    {
        const fileBytes = Uint8Array.from([0xef, 0xbb, ...encode(crlf(FROM, DATE, '', BODY))]);
        const message = (await parseOk(fileBytes)).message;
        expect(message.from).toEqual([]);
        expect(message.date.original).toBe('Tue, 3 Jun 2025 14:05:09 +0200');
    });
});

describe('createEmlParser: an attached email that starts with a UTF-8 byte order mark', () =>
{
    const OUTER = crlf(
        'From: Carol Example <carol@example.test>',
        'Date: Wed, 4 Jun 2025 09:00:00 +0200',
        'Subject: Outer',
        'Message-ID: <outer@example.test>',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="b"',
        '',
        '--b',
        'Content-Type: text/plain; charset=utf-8',
        '',
        'See below.',
        '',
    );
    const INNER = crlf(FROM, DATE, SUBJECT, 'Message-ID: <inner@example.test>', '', 'Inner body.');

    /** The whole file with the inner email as a message/rfc822 part, the mark in front of it if `bom`. */
    function file(disposition: string | null, bom: boolean): Uint8Array
    {
        const partHead = crlf(
            '--b',
            'Content-Type: message/rfc822',
            ...(disposition === null ? [] : [`Content-Disposition: ${disposition}`]),
            '',
            '',
        );
        const innerBytes = bom ? withBom(encode(INNER)) : encode(INNER);
        const head = encode(OUTER + partHead);
        const tail = encode('\r\n--b--\r\n');
        const joined = new Uint8Array(head.length + innerBytes.length + tail.length);
        joined.set(head, 0);
        joined.set(innerBytes, head.length);
        joined.set(tail, head.length + innerBytes.length);
        return joined;
    }

    it.each([
        ['inline (forwarded into the body)', null],
        ['sent as an attachment', 'attachment; filename="attached.eml"'],
    ])('%s: its first header (From) is read as without the mark', async (_label, disposition) =>
    {
        const marked = await parseOk(file(disposition, true));
        const plain = await parseOk(file(disposition, false));
        const entry = marked.attached?.[0];
        expect(entry?.message.from).toEqual([{ name: 'Alice Example', address: 'alice@example.test' }]);
        expect(entry?.message.subject).toBe('Byte order mark test');
        expect(entry?.message.bodyText).toBe(plain.attached?.[0]?.message.bodyText);
        expect(marked.message.bodyText).toBe(plain.message.bodyText);
        if (disposition === null)
        {
            // The forwarded header block in the outer body names the sender too.
            expect(marked.message.bodyText).toContain('From: Alice Example <alice@example.test>');
        }
    });
});

describe('withoutLeadingBom', () =>
{
    it('returns the very same object when there is no mark', () =>
    {
        const fileBytes = encode('From: a@example.test');
        expect(withoutLeadingBom(fileBytes)).toBe(fileBytes);
        const buffer = toArrayBuffer(fileBytes);
        expect(withoutLeadingBom(buffer)).toBe(buffer);
        const empty = new Uint8Array(0);
        expect(withoutLeadingBom(empty)).toBe(empty);
    });

    it('skips one mark from a Uint8Array and from an ArrayBuffer, without copying the source', () =>
    {
        const fileBytes = withBom(encode('From: a@example.test'));
        expect(decodeKeepingBom(withoutLeadingBom(fileBytes))).toBe('From: a@example.test');
        expect(decodeKeepingBom(withoutLeadingBom(toArrayBuffer(fileBytes)))).toBe('From: a@example.test');
        // The source bytes are not changed: the hash is taken from them.
        expect(Array.from(fileBytes.subarray(0, 3))).toEqual(BOM);
        expect(new Uint8Array(withoutLeadingBom(Uint8Array.from(BOM)))).toHaveLength(0);
    });

    it('needs all three bytes of the mark: a partial mark or a too short input is returned as is', () =>
    {
        const partial = Uint8Array.from([0xef, 0xbb, 0x46]);
        expect(withoutLeadingBom(partial)).toBe(partial);
        const tooShort = Uint8Array.from([0xef, 0xbb]);
        expect(withoutLeadingBom(tooShort)).toBe(tooShort);
    });
});
