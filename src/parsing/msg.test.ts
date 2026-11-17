// Unit tests for the .msg adapter. Every .msg is built in memory from
// synthetic specs with tests/fixtures/msg/builder.ts (README.md, rule R7);
// nothing is read from disk and no .msg file is ever written.

import type { FieldsData } from '@kenjiuno/msgreader';
import { burn } from '@kenjiuno/msgreader/lib/Burner';
import { TypeEnum } from '@kenjiuno/msgreader/lib/Reader';
import { describe, expect, it, vi } from 'vitest';
import { buildMsg, type MsgSpec } from '../../tests/fixtures/msg/builder';
import { sha256Hex } from './hash';
import { HtmlConversionError } from './html-conversion';
import type { HtmlToTextResult } from './html-to-text';
import { createMsgParser, errorDetail, resultFromFields } from './msg';
import type { NormalizedMessage, ParseResult } from './types';

/** A stub, NOT a converter: it only shows that the HTML path was taken. */
const stubHtmlToText = (html: string): HtmlToTextResult => ({ text: `[stub] ${html.length}`, truncated: false });
const parser = createMsgParser({ htmlToText: stubHtmlToText });

const ALICE = { name: 'Alice Example', smtp: 'alice@example.test' };
const BOB = { name: 'Bob Sample', smtp: 'bob@example.test' };
const CAROL = { name: 'Carol Test', smtp: 'carol@example.test' };
const DAVE = { name: 'Dave Demo', smtp: 'dave@example.test' };
const DN = (cn: string): string => `/O=EXAMPLE TEST ORGANIZATION/OU=EXCHANGE ADMINISTRATIVE GROUP (FYDIBOHF23SPDLT)/CN=RECIPIENTS/CN=${cn}`;

const BASE: MsgSpec = {
    id: 'unit',
    description: 'unit test message',
    strings: 'unicode',
    subject: 'Test message',
    sender: ALICE,
    recipients: [{ ...BOB, type: 'to' }],
    bodyText: 'Hello.\nSecond line.',
    submitTime: '2025-06-03T12:05:09Z',
    messageId: '<m1@example.test>',
};

const spec = (overrides: Partial<MsgSpec>): MsgSpec => ({ ...BASE, ...overrides });

async function parse(data: Uint8Array, name = 'test.msg'): Promise<ParseResult>
{
    return parser.parse({ name, bytes: data });
}

async function parseOk(s: MsgSpec): Promise<NormalizedMessage>
{
    const result = await parse(buildMsg(s));
    if (!result.ok)
    {
        throw new Error(`expected ok, got ${result.error}: ${result.detail}`);
    }
    return result.message;
}

describe('createMsgParser: basic fields', () =>
{
    it('fills source with the file name, the SHA-256 of the bytes and kind "msg"', async () =>
    {
        const data = buildMsg(BASE);
        const result = await parse(data);
        if (!result.ok)
        {
            throw new Error(result.detail);
        }
        expect(result.message.source).toEqual({ fileName: 'test.msg', sha256: await sha256Hex(data), kind: 'msg' });
        expect(result.message.subject).toBe('Test message');
        expect(result.message.from).toEqual([{ name: 'Alice Example', address: 'alice@example.test' }]);
        expect(result.message.to).toEqual([{ name: 'Bob Sample', address: 'bob@example.test' }]);
        expect(result.message.cc).toEqual([]);
        expect(result.message.attachments).toEqual([]);
        expect(result.message.warnings).toEqual([]);
    });

    it('turns Outlook CRLF line ends into LF and changes nothing else in the body', async () =>
    {
        const message = await parseOk(spec({ bodyText: 'Hello.\n\n  Indented, trailing spaces  \n\tTab.\n' }));
        expect(message.bodyText).toBe('Hello.\n\n  Indented, trailing spaces  \n\tTab.\n');
    });

    it('reads a file given as a view into a larger buffer (non-zero byteOffset)', async () =>
    {
        const data = buildMsg(BASE);
        const big = new Uint8Array(data.length + 100);
        big.set(data, 37);
        const view = big.subarray(37, 37 + data.length);
        const result = await parse(view);
        if (!result.ok)
        {
            throw new Error(result.detail);
        }
        expect(result.message.subject).toBe('Test message');
        expect(result.message.source.sha256).toBe(await sha256Hex(data));
    });

    it('an empty subject stays ""', async () =>
    {
        const message = await parseOk(spec({ subject: '' }));
        expect(message.subject).toBe('');
    });
});

describe('createMsgParser: Message-ID, In-Reply-To, References', () =>
{
    it('normalizes ids from the properties: no < >, trimmed, References in order', async () =>
    {
        const message = await parseOk(
            spec({
                messageId: '  <  m3@example.test >  ',
                inReplyTo: '<m2@example.test> (message from Bob)',
                references: '<m1@example.test>\r\n <m2@example.test>',
            }),
        );
        expect(message.messageId).toBe('m3@example.test');
        expect(message.inReplyTo).toBe('m2@example.test');
        expect(message.references).toEqual(['m1@example.test', 'm2@example.test']);
    });

    it('reads In-Reply-To and References from 8-bit (ANSI) properties too', async () =>
    {
        const message = await parseOk(
            spec({ strings: 'ansi-1252', inReplyTo: '<m2@example.test>', references: '<m1@example.test> <m2@example.test>' }),
        );
        expect(message.inReplyTo).toBe('m2@example.test');
        expect(message.references).toEqual(['m1@example.test', 'm2@example.test']);
    });

    it('falls back to the received internet headers when the id properties are missing', async () =>
    {
        const message = await parseOk(
            spec({
                messageId: undefined,
                transportHeaders:
                    'Received: by mx.example.test; Tue, 3 Jun 2025 14:05:10 +0200\n' +
                    'Message-ID: <h3@example.test>\n' +
                    'In-Reply-To: <h2@example.test>\n' +
                    'References: <h1@example.test>\n' +
                    '\t<h2@example.test>\n' +
                    '\n',
            }),
        );
        expect(message.messageId).toBe('h3@example.test');
        expect(message.inReplyTo).toBe('h2@example.test');
        expect(message.references).toEqual(['h1@example.test', 'h2@example.test']);
        expect(message.warnings).toEqual([]);
    });

    it('warns "missing-message-id" when there is no Message-ID anywhere', async () =>
    {
        const message = await parseOk(spec({ messageId: undefined }));
        expect(message.messageId).toBeNull();
        expect(message.inReplyTo).toBeNull();
        expect(message.references).toEqual([]);
        expect(message.warnings).toEqual(['missing-message-id']);
    });
});

describe('createMsgParser: dates', () =>
{
    it('uses the sent time as an exact UTC instant: zone known, offset unknown, ISO original', async () =>
    {
        const message = await parseOk(spec({ submitTime: '2025-06-03T12:05:09Z', deliveryTime: '2025-06-03T12:05:30Z' }));
        expect(message.date).toEqual({
            utcMs: Date.UTC(2025, 5, 3, 12, 5, 9),
            original: '2025-06-03T12:05:09.000Z',
            offsetMinutes: null,
            zoneKnown: true,
        });
        expect(message.warnings).toEqual([]);
    });

    it('keeps the sender\'s Date header text and offset when it names the same instant', async () =>
    {
        const message = await parseOk(
            spec({ submitTime: '2025-06-03T12:05:09Z', transportHeaders: 'Date: Tue, 3 Jun 2025 14:05:09 +0200\n\n' }),
        );
        expect(message.date).toEqual({
            utcMs: Date.UTC(2025, 5, 3, 12, 5, 9),
            original: 'Tue, 3 Jun 2025 14:05:09 +0200',
            offsetMinutes: 120,
            zoneKnown: true,
        });
    });

    it('ignores a Date header that disagrees with the sent time', async () =>
    {
        const message = await parseOk(
            spec({ submitTime: '2025-06-03T12:05:09Z', transportHeaders: 'Date: Tue, 3 Jun 2025 14:07:00 +0200\n\n' }),
        );
        expect(message.date.utcMs).toBe(Date.UTC(2025, 5, 3, 12, 5, 9));
        expect(message.date.original).toBe('2025-06-03T12:05:09.000Z');
        expect(message.date.offsetMinutes).toBeNull();
    });

    it('without a sent time, uses the Date header (flagged if its zone is unknown)', async () =>
    {
        const message = await parseOk(
            spec({ submitTime: undefined, deliveryTime: '2025-06-03T12:09:00Z', transportHeaders: 'Date: Tue, 3 Jun 2025 12:05:09 -0000\n\n' }),
        );
        expect(message.date).toEqual({
            utcMs: Date.UTC(2025, 5, 3, 12, 5, 9),
            original: 'Tue, 3 Jun 2025 12:05:09 -0000',
            offsetMinutes: null,
            zoneKnown: false,
        });
        expect(message.warnings).toEqual(['unknown-time-zone']);
    });

    it('without a sent time or Date header, uses the received time', async () =>
    {
        const message = await parseOk(spec({ submitTime: undefined, deliveryTime: '2025-06-03T12:09:00Z' }));
        expect(message.date.utcMs).toBe(Date.UTC(2025, 5, 3, 12, 9, 0));
        expect(message.date.zoneKnown).toBe(true);
        expect(message.warnings).toEqual([]);
    });

    it('reports "missing-date" when there is no time at all, never inventing one', async () =>
    {
        const message = await parseOk(spec({ submitTime: undefined }));
        expect(message.date).toEqual({ utcMs: null, original: '', offsetMinutes: null, zoneKnown: false });
        expect(message.warnings).toEqual(['missing-date']);
    });

    it('reports "unparseable-date" for a damaged time (FILETIME 0 = year 1601), keeping its text', async () =>
    {
        const message = await parseOk(spec({ submitTime: '1601-01-01T00:00:00Z' }));
        expect(message.date.utcMs).toBeNull();
        expect(message.date.original).toBe('Mon, 01 Jan 1601 00:00:00 GMT');
        expect(message.warnings).toEqual(['unparseable-date']);
    });
});

describe('createMsgParser: sender and recipients', () =>
{
    it('replaces an Exchange X.500 sender address with the SMTP fallback property', async () =>
    {
        const message = await parseOk(spec({ sender: { ...BOB, exchangeDn: DN('BOB') } }));
        expect(message.from).toEqual([{ name: 'Bob Sample', address: 'bob@example.test' }]);
    });

    it('keeps the X.500 address when the file has no SMTP address for that mailbox', async () =>
    {
        const message = await parseOk(
            spec({
                sender: { ...BOB, exchangeDn: DN('BOB'), smtpFallback: false },
                recipients: [{ ...CAROL, exchangeDn: DN('CAROL'), smtpFallback: false, type: 'to' }],
            }),
        );
        expect(message.from).toEqual([{ name: 'Bob Sample', address: DN('BOB') }]);
        expect(message.to).toEqual([{ name: 'Carol Test', address: DN('CAROL') }]);
    });

    it('uses PR_SENT_REPRESENTING_SMTP_ADDRESS when PR_SENDER_SMTP_ADDRESS is missing', async () =>
    {
        const message = await parseOk(
            spec({
                sender: { ...BOB, exchangeDn: DN('BOB'), smtpFallback: false },
                extraStrings: [{ propId: 0x5d02, value: 'bob@example.test' }],
            }),
        );
        expect(message.from).toEqual([{ name: 'Bob Sample', address: 'bob@example.test' }]);
    });

    it('prefers the "sent representing" mailbox (the From) over the actual sender (on behalf of)', async () =>
    {
        const message = await parseOk(
            spec({
                sender: { ...DAVE, exchangeDn: DN('DAVE') }, // the assistant who pressed Send
                extraStrings: [
                    { propId: 0x0042, value: 'Carol Test' }, // PR_SENT_REPRESENTING_NAME
                    { propId: 0x0064, value: 'EX' }, // PR_SENT_REPRESENTING_ADDRTYPE
                    { propId: 0x0065, value: DN('CAROL') }, // PR_SENT_REPRESENTING_EMAIL_ADDRESS
                    { propId: 0x5d02, value: 'carol@example.test' }, // PR_SENT_REPRESENTING_SMTP_ADDRESS
                ],
            }),
        );
        expect(message.from).toEqual([{ name: 'Carol Test', address: 'carol@example.test' }]);
        // The assistant is kept as the actual sender, with its SMTP address.
        expect(message.sender).toEqual({ name: 'Dave Demo', address: 'dave@example.test' });
    });

    it('on behalf of: the sender keeps its X.500 address when it has no SMTP property (never the represented one)', async () =>
    {
        const message = await parseOk(
            spec({
                sender: { ...DAVE, exchangeDn: DN('DAVE'), smtpFallback: false },
                sentRepresenting: { ...CAROL, exchangeDn: DN('CAROL') },
            }),
        );
        expect(message.from).toEqual([{ name: 'Carol Test', address: 'carol@example.test' }]);
        expect(message.sender).toEqual({ name: 'Dave Demo', address: DN('DAVE') });
    });

    it('no sender key without "sent representing" properties: the sender is the From', async () =>
    {
        const message = await parseOk(spec({}));
        expect(message.from).toEqual([{ name: 'Alice Example', address: 'alice@example.test' }]);
        expect('sender' in message).toBe(false);
    });

    it('no sender key when "sent representing" is the same SMTP address in other letter case', async () =>
    {
        const message = await parseOk(spec({ sentRepresenting: { name: 'Alice E.', smtp: 'ALICE@example.test' } }));
        expect(message.from).toEqual([{ name: 'Alice E.', address: 'ALICE@example.test' }]);
        expect('sender' in message).toBe(false);
    });

    it('no sender key when the Exchange sender resolves to the represented SMTP address', async () =>
    {
        const message = await parseOk(spec({ sender: { ...BOB, exchangeDn: DN('BOB') }, sentRepresenting: BOB }));
        expect(message.from).toEqual([{ name: 'Bob Sample', address: 'bob@example.test' }]);
        expect('sender' in message).toBe(false);
    });

    it('keeps the sender when the "sent representing" mailbox is empty (it is then the only author information)', async () =>
    {
        const message = await parseOk(spec({ sentRepresenting: { name: '', smtp: '' } }));
        expect(message.from).toEqual([]);
        expect(message.sender).toEqual({ name: 'Alice Example', address: 'alice@example.test' });
    });

    it('a "sent representing" mailbox equal to the sender borrows the sender\'s SMTP address', async () =>
    {
        const message = await parseOk(
            spec({
                sender: { ...BOB, exchangeDn: DN('BOB') },
                extraStrings: [
                    { propId: 0x0042, value: 'Bob Sample' },
                    { propId: 0x0064, value: 'EX' },
                    { propId: 0x0065, value: DN('BOB').toLowerCase() },
                ],
            }),
        );
        expect(message.from).toEqual([{ name: 'Bob Sample', address: 'bob@example.test' }]);
        expect('sender' in message).toBe(false);
    });

    it('splits recipients into To, Cc and Bcc in file order, resolves Exchange recipients', async () =>
    {
        const message = await parseOk(
            spec({
                recipients: [
                    { ...BOB, type: 'to' },
                    { ...CAROL, exchangeDn: DN('CAROL'), type: 'cc' },
                    { ...DAVE, type: 'to' },
                    { name: 'Hidden Copy', smtp: 'hidden@example.test', type: 'bcc' },
                    { name: '', smtp: 'noname@example.test', type: 'cc' },
                    { name: 'Erin Archive', smtp: 'erin@example.test', exchangeDn: DN('ERIN'), type: 'bcc' },
                ],
            }),
        );
        expect(message.bcc).toEqual([
            { name: 'Hidden Copy', address: 'hidden@example.test' },
            { name: 'Erin Archive', address: 'erin@example.test' },
        ]);
        expect(message.to).toEqual([
            { name: 'Bob Sample', address: 'bob@example.test' },
            { name: 'Dave Demo', address: 'dave@example.test' },
        ]);
        expect(message.cc).toEqual([
            { name: 'Carol Test', address: 'carol@example.test' },
            { name: '', address: 'noname@example.test' },
        ]);
    });

    it('skips a recipient with neither a name nor an address, keeps one with only a name', async () =>
    {
        const message = await parseOk(
            spec({
                recipients: [
                    { name: '', smtp: '', type: 'to' },
                    { ...BOB, type: 'to' },
                    { name: 'Name Only', smtp: '', type: 'cc' },
                    { name: '', smtp: '', type: 'cc' },
                    { name: '', smtp: '', type: 'bcc' },
                ],
            }),
        );
        expect(message.to).toEqual([{ name: 'Bob Sample', address: 'bob@example.test' }]);
        expect(message.cc).toEqual([{ name: 'Name Only', address: '' }]);
        expect(message.bcc).toEqual([]);
    });
});

describe('createMsgParser: 8-bit (ANSI) strings', () =>
{
    // The builder writes each character of an 'ansi-1252' spec as its Latin-1
    // byte. Bytes C0 E1 E2 are "Àáâ" in code page 1252 but "Абв" in 1251.
    const CYRILLIC_TEST = spec({ strings: 'ansi-1252', subject: 'Àáâ', bodyText: 'Àáâ é' });

    it('decodes with PR_MESSAGE_CODEPAGE (here 1251, Cyrillic)', async () =>
    {
        const message = await parseOk({ ...CYRILLIC_TEST, codepages: { message: 1251, internet: 1252 } });
        expect(message.subject).toBe('Абв');
        expect(message.bodyText).toBe('Абв й');
    });

    it('uses PR_INTERNET_CPID when PR_MESSAGE_CODEPAGE is missing', async () =>
    {
        const message = await parseOk({ ...CYRILLIC_TEST, codepages: { message: null, internet: 1251 } });
        expect(message.subject).toBe('Абв');
    });

    it('falls back to windows-1252 for an unknown code page', async () =>
    {
        const message = await parseOk({ ...CYRILLIC_TEST, codepages: { message: 99999, internet: 99999 } });
        expect(message.subject).toBe('Àáâ');
    });

    it('falls back to windows-1252 when no code page is given', async () =>
    {
        const message = await parseOk({ ...CYRILLIC_TEST, codepages: { message: null, internet: null } });
        expect(message.subject).toBe('Àáâ');
        expect(message.from).toEqual([{ name: 'Alice Example', address: 'alice@example.test' }]);
    });

    it('code page 1200 (UTF-16LE) is passed on to the reader of 8-bit strings', async () =>
    {
        // Byte pairs 41 00 42 00 read as UTF-16LE give "AB" (as Latin-1 they would be "A\0B\0").
        const message = await parseOk({ ...spec({ strings: 'ansi-1252', subject: 'A\u0000B\u0000' }), codepages: { message: 1200 } });
        expect(message.subject).toBe('AB');
    });

    it('decodes recipient and attachment strings with the same code page', async () =>
    {
        const message = await parseOk({
            ...CYRILLIC_TEST,
            codepages: { message: 1251 },
            recipients: [{ name: 'Àáâ', smtp: 'cyr@example.test', type: 'to' }],
            attachments: [{ fileName: 'Àáâ.txt', mimeType: 'text/plain', content: 'x' }],
        });
        expect(message.to).toEqual([{ name: 'Абв', address: 'cyr@example.test' }]);
        expect(message.attachments).toEqual([{ fileName: 'Абв.txt', size: 1, mimeType: 'text/plain' }]);
    });
});

describe('createMsgParser: body', () =>
{
    const HTML = '<p>Hello <b>Alice</b></p><script>alert(1)</script><img src="https://tracker.invalid/p.png">';

    it('uses the plain body when there is one; the HTML converter is never called', async () =>
    {
        const htmlToText = vi.fn(stubHtmlToText);
        const result = await createMsgParser({ htmlToText }).parse({
            name: 'a.msg',
            bytes: buildMsg(spec({ bodyText: 'Plain text.', bodyHtml: HTML })),
        });
        if (!result.ok)
        {
            throw new Error(result.detail);
        }
        expect(result.message.bodyText).toBe('Plain text.');
        expect(result.message.warnings).toEqual([]);
        expect(htmlToText).not.toHaveBeenCalled();
    });

    it('HTML only: hands the exact HTML string to htmlToText and warns "html-converted-body"', async () =>
    {
        const htmlToText = vi.fn((html: string) => ({ text: `converted ${html.length}`, truncated: false }));
        const result = await createMsgParser({ htmlToText }).parse({
            name: 'a.msg',
            bytes: buildMsg(spec({ bodyText: undefined, bodyHtml: HTML })),
        });
        if (!result.ok)
        {
            throw new Error(result.detail);
        }
        expect(htmlToText).toHaveBeenCalledTimes(1);
        expect(htmlToText).toHaveBeenCalledWith(HTML);
        expect(result.message.bodyText).toBe(`converted ${HTML.length}`);
        expect(result.message.warnings).toEqual(['html-converted-body']);
    });

    it('HTML only, cut at the converter limit: also warns "html-body-truncated" (the note stays in the text)', async () =>
    {
        const htmlToText = (): HtmlToTextResult => ({ text: 'start\n\n[Text cut here: ...]', truncated: true });
        const result = await createMsgParser({ htmlToText }).parse({
            name: 'a.msg',
            bytes: buildMsg(spec({ bodyText: undefined, bodyHtml: HTML })),
        });
        if (!result.ok)
        {
            throw new Error(result.detail);
        }
        expect(result.message.bodyText).toBe('start\n\n[Text cut here: ...]');
        expect(result.message.warnings).toEqual(['html-converted-body', 'html-body-truncated']);
    });

    it('a plain body of only whitespace does not hide the HTML body', async () =>
    {
        const message = await parseOk(spec({ bodyText: '\n \n', bodyHtml: HTML }));
        expect(message.bodyText).toBe(`[stub] ${HTML.length}`);
        expect(message.warnings).toEqual(['html-converted-body']);
    });

    it('RTF only: empty text with "rtf-only-body"; the RTF is neither converted nor copied', async () =>
    {
        const htmlToText = vi.fn(stubHtmlToText);
        const rtf = '{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Arial;}} \\f0 RTF-ONLY-SECRET-TEXT\\par }';
        const result = await createMsgParser({ htmlToText }).parse({
            name: 'a.msg',
            bytes: buildMsg(spec({ bodyText: undefined, bodyRtf: rtf })),
        });
        if (!result.ok)
        {
            throw new Error(result.detail);
        }
        expect(result.message.bodyText).toBe('');
        expect(result.message.warnings).toEqual(['rtf-only-body']);
        expect(htmlToText).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toContain('RTF-ONLY-SECRET-TEXT');
    });

    it('no body at all: empty text with "no-body"', async () =>
    {
        const message = await parseOk(spec({ bodyText: undefined }));
        expect(message.bodyText).toBe('');
        expect(message.warnings).toEqual(['no-body']);
    });

    describe('line ends: LF only, only CR is changed', () =>
    {
        // The builder writes each "\n" as CRLF and leaves a lone "\r" as it is.
        it('CRLF (as Outlook writes it) becomes LF', async () =>
        {
            const message = await parseOk(spec({ bodyText: 'one\ntwo\n\nthree\n' }));
            expect(message.bodyText).toBe('one\ntwo\n\nthree\n');
        });

        it('a lone CR becomes LF, also mixed with CRLF, doubled, and at the start or end', async () =>
        {
            const message = await parseOk(spec({ bodyText: '\rone\rtwo\nthree\r\rfour\r' }));
            expect(message.bodyText).toBe('\none\ntwo\nthree\n\nfour\n');
        });

        it('a whitespace-only body ("no-body") is kept with LF line ends', async () =>
        {
            const message = await parseOk(spec({ bodyText: ' \r\t\n' }));
            expect(message.bodyText).toBe(' \n\t\n');
            expect(message.warnings).toEqual(['no-body']);
        });

        it('converted HTML text with CR becomes LF', async () =>
        {
            const htmlToText = (): HtmlToTextResult => ({ text: 'a\rb\r\nc\u2028d', truncated: false });
            const result = await createMsgParser({ htmlToText }).parse({ name: 'a.msg', bytes: buildMsg(spec({ bodyText: undefined, bodyHtml: '<p>x</p>' })) });
            if (!result.ok)
            {
                throw new Error(result.detail);
            }
            expect(result.message.bodyText).toBe('a\nb\nc\u2028d');
        });

        it('the SHA-256 is still the one of the file bytes', async () =>
        {
            const data = buildMsg(spec({ bodyText: 'one\rtwo' }));
            const result = await parse(data);
            if (!result.ok)
            {
                throw new Error(result.detail);
            }
            expect(result.message.source.sha256).toBe(await sha256Hex(data));
        });
    });
});

describe('createMsgParser: attachments (metadata only, README.md rule R4)', () =>
{
    it('lists name, size and type, and keeps no attachment content anywhere in the result', async () =>
    {
        const result = await parse(
            buildMsg(
                spec({
                    attachments: [
                        { fileName: 'invoice.txt', mimeType: 'text/plain', content: 'ATTACHMENT-CONTENT-MARKER 1' },
                        { fileName: 'blob.bin', content: 'ATTACHMENT-CONTENT-MARKER 2 longer' },
                    ],
                }),
            ),
        );
        if (!result.ok)
        {
            throw new Error(result.detail);
        }
        expect(result.message.attachments).toEqual([
            { fileName: 'invoice.txt', size: 27, mimeType: 'text/plain' },
            { fileName: 'blob.bin', size: 34, mimeType: 'application/octet-stream' },
        ]);
        for (const attachment of result.message.attachments)
        {
            expect(Object.keys(attachment).sort()).toEqual(['fileName', 'mimeType', 'size']);
        }
        expect(JSON.stringify(result)).not.toContain('ATTACHMENT-CONTENT-MARKER');
    });

    it('lists an attached Outlook item without expanding it into the body; read as an email of its own, no warning', async () =>
    {
        const message = await parseOk(
            spec({ attachedItems: [{ displayName: 'Earlier order', subject: 'INNER-SUBJECT-MARKER' }] }),
        );
        expect(message.attachments).toEqual([
            { fileName: 'Earlier order.msg', size: null, mimeType: 'application/vnd.ms-outlook' },
        ]);
        expect(message.bodyText).toBe('Hello.\nSecond line.');
        expect(message.subject).toBe('Test message');
        expect(JSON.stringify(message)).not.toContain('INNER-SUBJECT-MARKER');
        // Task 8.13b-3: the item is read as an email of its own (msg.attached.test.ts), so its text is shown there.
        expect(message.warnings).toEqual([]);
    });

    it('warns only once for several attached Outlook items not read as emails, and not for ordinary attachments', async () =>
    {
        // A calendar item is only listed, never read (task 8.13b-2), so its text is shown nowhere.
        const appointment = (subject: string): MsgSpec => spec({ subject, messageClass: 'IPM.Appointment' });
        const withItems = await parseOk(
            spec({
                attachments: [{ fileName: 'a.txt', content: 'x' }],
                attachedItems: [
                    { displayName: 'First', message: appointment('one') },
                    { displayName: 'Second', message: appointment('two') },
                ],
            }),
        );
        expect(withItems.warnings).toEqual(['forwarded-message-not-expanded']);
        const filesOnly = await parseOk(spec({ attachments: [{ fileName: 'a.txt', content: 'x' }] }));
        expect(filesOnly.warnings).toEqual([]);
    });
});

describe('createMsgParser: broken files never throw', () =>
{
    async function expectCorrupt(data: Uint8Array, name = 'bad.msg'): Promise<string>
    {
        const result = await parse(data, name);
        expect(result.ok).toBe(false);
        if (result.ok)
        {
            return '';
        }
        expect(result.error).toBe('corrupt');
        expect(result.fileName).toBe(name);
        expect(result.sha256).toBe(await sha256Hex(data));
        expect(result.detail.length).toBeGreaterThan(0);
        expect(result.detail.length).toBeLessThanOrEqual(200);
        expect(result.detail).not.toMatch(/[\r\n]/);
        return result.detail;
    }

    it('empty file', async () =>
    {
        await expectCorrupt(new Uint8Array(0));
    });

    it('random bytes (not a Compound File)', async () =>
    {
        const detail = await expectCorrupt(Uint8Array.from({ length: 3000 }, (_, i) => (i * 7919 + 13) & 0xff));
        expect(detail).toBe('Unsupported file type!');
    });

    it('a text file renamed to .msg', async () =>
    {
        await expectCorrupt(new TextEncoder().encode('From: alice@example.test\r\nSubject: hi\r\n\r\nBody\r\n'));
    });

    it.each([8, 64, 512, 600, 1024, 2048])('a .msg cut off after %i bytes', async (length) =>
    {
        await expectCorrupt(buildMsg(BASE).slice(0, length));
    });

    it('a cut-off .msg (msgreader fails inside with a RangeError) gives a plain detail', async () =>
    {
        // Cut in the middle: msgreader reads past the end of its DataView and
        // throws "RangeError: Offset is outside the bounds of the DataView".
        const full = buildMsg(BASE);
        const detail = await expectCorrupt(full.slice(0, Math.floor(full.length / 2)));
        expect(detail).toBe('damaged property: unreadable file structure');
    });

    it('a valid Compound File that is not an Outlook message (e.g. a renamed .doc)', async () =>
    {
        const stream = new TextEncoder().encode('not a message');
        const data = burn([
            { name: 'Root Entry', type: TypeEnum.ROOT, children: [1], length: 0 },
            { name: 'WordDocument', type: TypeEnum.DOCUMENT, binaryProvider: () => stream, length: stream.length },
        ]);
        const detail = await expectCorrupt(data);
        expect(detail).toBe('not an Outlook message: no message properties found');
    });

    // A converter failure is not a damaged file: the message is still read with
    // an EMPTY body (nothing invented) and 'html-body-unreadable', so the
    // preview can say part of it could not be shown (README.md, rule R6).
    it('a throwing htmlToText gives an empty body with html-body-unreadable; headers and attachments are still read', async () =>
    {
        const throwing = createMsgParser({
            htmlToText: () =>
            {
                throw new Error('converter failed\non two lines');
            },
        });
        const data = buildMsg(spec({ bodyText: undefined, bodyHtml: '<p>x</p>', attachments: [{ fileName: 'plan.pdf', content: 'x' }] }));
        const result = await throwing.parse({ name: 'x.msg', bytes: data });
        if (!result.ok)
        {
            throw new Error(result.detail);
        }
        expect(result.message.bodyText).toBe('');
        expect(result.message.warnings).toEqual(['html-body-unreadable']);
        expect(result.message.subject).toBe('Test message');
        expect(result.message.attachments.map((a) => a.fileName)).toEqual(['plan.pdf']);
        expect(result.message.source).toEqual({ fileName: 'x.msg', sha256: await sha256Hex(data), kind: 'msg' });
    });

    it.each([
        ['a TypeError', new TypeError('x.trim is not a function')],
        ['a RangeError (e.g. a stack overflow)', new RangeError('Maximum call stack size exceeded')],
    ])('%s thrown by htmlToText gives html-body-unreadable, never "damaged property"', async (_label, thrown) =>
    {
        const throwing = createMsgParser({
            htmlToText: () =>
            {
                throw thrown;
            },
        });
        const data = buildMsg(spec({ bodyText: undefined, bodyHtml: '<p>x</p>' }));
        const result = await throwing.parse({ name: 'x.msg', bytes: data });
        expect(result.ok && result.message.warnings).toEqual(['html-body-unreadable']);
        expect(result.ok && result.message.bodyText).toBe('');
    });

    it('an htmlToText that returns something other than a { text, truncated } result gives html-body-unreadable', async () =>
    {
        const broken = createMsgParser({ htmlToText: () => null as unknown as HtmlToTextResult });
        const data = buildMsg(spec({ bodyText: undefined, bodyHtml: '<p>x</p>' }));
        const result = await broken.parse({ name: 'x.msg', bytes: data });
        expect(result.ok && result.message.warnings).toEqual(['html-body-unreadable']);
        expect(result.ok && result.message.bodyText).toBe('');
    });

    it('a damaged directory entry (msgreader fails inside with a TypeError) gives a plain detail', async () =>
    {
        const data = buildMsg(BASE);
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        const directoryAt = (view.getUint32(0x30, true) + 1) * 512; // first directory sector (512-byte sectors)
        view.setUint32(directoryAt + 0x4c, 0x1000, true); // Root Entry's child -> an entry that does not exist
        const detail = await expectCorrupt(data);
        expect(detail).toBe('damaged property: unreadable file structure');
    });

    it('a plain-text body stored with the wrong type is reported, never silently dropped', async () =>
    {
        const data = buildMsg(spec({ bodyText: undefined, extraBinaries: [{ propId: 0x1000, bytes: Uint8Array.of(1, 2, 3) }] }));
        const detail = await expectCorrupt(data);
        expect(detail).toBe('damaged property: plain-text body');
    });

    it('a Message-ID stored with the wrong type is treated as absent', async () =>
    {
        const message = await parseOk(
            spec({ messageId: undefined, extraBinaries: [{ propId: 0x1035, bytes: Uint8Array.of(0x3c, 0x61, 0x3e) }] }),
        );
        expect(message.messageId).toBeNull();
        expect(message.warnings).toEqual(['missing-message-id']);
        expect(message.bodyText).toBe('Hello.\nSecond line.');
    });

    // Not tested HERE: some damaged files make msgreader loop forever or use up
    // all memory, which try/catch cannot stop. Two known causes: a sector chain
    // or directory tree that loops back on itself (msgreader follows them
    // without a loop check), and a damaged size field, which makes msgreader
    // reserve a huge buffer (`new Uint8Array(size)` in its Reader.js). The
    // second is not rare: in a fuzzing run, about 3 in 560 randomly damaged .msg
    // files did it. This adapter does not guard against them itself: files
    // reach it through the dispatcher (parse-files.ts), which first runs the
    // Compound File check (cfb-check.ts, tested in cfb-check.test.ts) and
    // parses each file in a Web Worker with a time limit (worker-runner.ts,
    // tested in worker-runner.test.ts and e2e/parse-files.spec.ts).
});

describe('resultFromFields: wrongly typed properties from a damaged file', () =>
{
    // msgreader returns bytes or numbers where a string belongs when a damaged
    // file gives a property the wrong type tag. These objects imitate that.
    const BYTES = Uint8Array.of(0x41, 0x42);
    const GOOD: FieldsData = {
        dataType: 'msg',
        messageClass: 'IPM.Note',
        subject: 'Good subject',
        body: 'Body text.\r\n',
        senderName: 'Alice Example',
        senderEmail: 'alice@example.test',
        senderAddressType: 'SMTP',
        messageId: '<m1@example.test>',
        clientSubmitTime: 'Tue, 03 Jun 2025 12:05:09 GMT',
        recipients: [{ dataType: 'recipient', name: 'Bob Sample', email: 'bob@example.test', addressType: 'SMTP', recipType: 'to' }],
        attachments: [],
    };
    const options = { htmlToText: stubHtmlToText };
    const damaged = (overrides: Record<string, unknown>): FieldsData => ({ ...GOOD, ...overrides });
    const map = (fields: FieldsData): ParseResult => resultFromFields(fields, 'd.msg', 'f'.repeat(64), options);
    const ok = (fields: FieldsData): NormalizedMessage =>
    {
        const result = map(fields);
        if (!result.ok)
        {
            throw new Error(`expected ok, got ${result.detail}`);
        }
        return result.message;
    };

    it('the undamaged object maps normally (control)', () =>
    {
        const message = ok(GOOD);
        expect(message.subject).toBe('Good subject');
        expect(message.bodyText).toBe('Body text.\n');
        expect(message.from).toEqual([{ name: 'Alice Example', address: 'alice@example.test' }]);
        expect(message.to).toEqual([{ name: 'Bob Sample', address: 'bob@example.test' }]);
        expect(message.bcc).toEqual([]);
        expect('sender' in message).toBe(false);
        expect(message.messageId).toBe('m1@example.test');
        expect(message.warnings).toEqual([]);
    });

    it('header-like fields of the wrong type are treated as absent', () =>
    {
        const message = ok(
            damaged({
                subject: 42,
                messageId: BYTES,
                headers: BYTES,
                senderName: BYTES,
                senderEmail: 7,
                senderAddressType: BYTES,
                senderSmtpAddress: BYTES,
                sentRepresentingSmtpAddress: 3,
            }),
        );
        expect(message.subject).toBe('');
        expect(message.messageId).toBeNull();
        expect(message.from).toEqual([]);
        expect(message.bodyText).toBe('Body text.\n');
        expect(message.warnings).toEqual(['missing-message-id']);
    });

    it('one wrongly typed sender field does not hide the others', () =>
    {
        const message = ok(damaged({ senderName: BYTES }));
        expect(message.from).toEqual([{ name: '', address: 'alice@example.test' }]);
    });

    it('on behalf of: wrongly typed sender fields are treated as absent, the represented From is kept', () =>
    {
        const represented = [
            { propertyTag: '0042001f', value: 'Carol Test' },
            { propertyTag: '0065001f', value: 'carol@example.test' },
        ];
        const message = ok(damaged({ rawProps: represented, senderName: BYTES }));
        expect(message.from).toEqual([{ name: 'Carol Test', address: 'carol@example.test' }]);
        expect(message.sender).toEqual({ name: '', address: 'alice@example.test' });
        const noSender = ok(damaged({ rawProps: represented, senderName: BYTES, senderEmail: 7 }));
        expect('sender' in noSender).toBe(false);
    });

    it('a recipient type msgreader did not map (a raw number) is listed under To, never dropped', () =>
    {
        const message = ok(
            damaged({ recipients: [{ dataType: 'recipient', name: 'Odd Type', email: 'odd@example.test', recipType: 7 as unknown as 'to' }] }),
        );
        expect(message.to).toEqual([{ name: 'Odd Type', address: 'odd@example.test' }]);
        expect(message.bcc).toEqual([]);
    });

    it('recipient fields of the wrong type are treated as absent; an empty recipient is skipped', () =>
    {
        const message = ok(
            damaged({
                recipients: [
                    { dataType: 'recipient', name: BYTES, email: 'bob@example.test', addressType: 'SMTP', recipType: 'to' },
                    { dataType: 'recipient', name: 'Carol Test', email: BYTES, addressType: BYTES, smtpAddress: 5, recipType: 'cc' },
                    { dataType: 'recipient', name: BYTES, email: BYTES, recipType: 'to' },
                ],
            }),
        );
        expect(message.to).toEqual([{ name: '', address: 'bob@example.test' }]);
        expect(message.cc).toEqual([{ name: 'Carol Test', address: '' }]);
    });

    it('attachment fields of the wrong type are treated as absent', () =>
    {
        const message = ok(
            damaged({
                attachments: [{ dataType: 'attachment', fileName: BYTES, fileNameShort: 9, name: 'shown.txt', attachMimeTag: BYTES, contentLength: 4 }],
            }),
        );
        expect(message.attachments).toEqual([{ fileName: 'shown.txt', size: 4, mimeType: 'application/octet-stream' }]);
    });

    it('a sent time of the wrong type counts as an unreadable date, not a missing one', () =>
    {
        const message = ok(damaged({ clientSubmitTime: BYTES }));
        expect(message.date).toEqual({ utcMs: null, original: '', offsetMinutes: null, zoneKnown: false });
        expect(message.warnings).toEqual(['unparseable-date']);
    });

    it.each([
        ['plain-text body', { body: BYTES }],
        ['plain-text body', { body: 12 }],
        ['HTML body', { body: undefined, bodyHtml: BYTES }],
        ['HTML body', { body: undefined, html: 'not bytes' }],
        ['RTF body', { body: undefined, compressedRtf: 'not bytes' }],
    ])('a %s of the wrong type makes the file "corrupt" (%o), never an empty body', (field, overrides) =>
    {
        expect(map(damaged(overrides))).toEqual({
            ok: false,
            error: 'corrupt',
            detail: `damaged property: ${field}`,
            fileName: 'd.msg',
            sha256: 'f'.repeat(64),
        });
    });

    it('any other TypeError becomes "damaged property: ...", not a JavaScript message', () =>
    {
        const result = map(damaged({ recipients: [null] }));
        expect(result).toMatchObject({ ok: false, error: 'corrupt', detail: 'damaged property: unexpected value type' });
    });

    it('a reader error is passed on as a short single line', () =>
    {
        const result = map({ dataType: null, error: 'Unsupported file type!' });
        expect(result).toMatchObject({ ok: false, error: 'corrupt', detail: 'Unsupported file type!' });
    });
});

describe('errorDetail', () =>
{
    it('a TypeError or RangeError from msgreader becomes "damaged property: <reason>"', () =>
    {
        expect(errorDetail(new TypeError("Cannot read properties of undefined (reading 'x')"), 'r')).toBe('damaged property: r');
        expect(errorDetail(new RangeError('Offset is outside the bounds of the DataView'), 'r')).toBe('damaged property: r');
    });

    it('a conversion failure keeps its own message, even when the converter threw a TypeError', () =>
    {
        const error = new HtmlConversionError(new TypeError('x is not a function').message);
        expect(errorDetail(error, 'r')).toBe('HTML body could not be converted: x is not a function');
    });

    it('any other error is passed on as one short line', () =>
    {
        expect(errorDetail(new Error(`a\n${'b'.repeat(300)}`), 'r')).toBe(`a ${'b'.repeat(198)}`);
        expect(errorDetail('text', 'r')).toBe('text');
        expect(errorDetail(new Error('  '), 'r')).toBe('unknown error');
    });
});
