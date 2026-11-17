// Unit tests for the file type decision (file-type.ts). Synthetic bytes only.

import { describe, expect, it } from 'vitest';
import { detectFileType, extensionOf, hasCfbSignature, startsLikeEmailHeader } from './file-type';

const CFB = Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0);
const EML = new TextEncoder().encode('From: Alice Example <alice@example.test>\r\nSubject: Hi\r\n\r\nBody\r\n');
const TEXT_NOT_HEADER = new TextEncoder().encode('Just some notes, not an email.\n');
const BINARY = Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0, 0, 0x14, 0); // starts like a zip

describe('extensionOf', () =>
{
    it.each([
        ['mail.eml', 'eml'],
        ['Mail.EML', 'eml'],
        ['a.b.Msg', 'msg'],
        ['no-extension', ''],
        ['trailing.', ''],
        ['.eml', 'eml'],
    ])('%s -> "%s"', (name, ext) =>
    {
        expect(extensionOf(name)).toBe(ext);
    });
});

describe('sniffing', () =>
{
    it('recognizes the Compound File signature, and only all 8 bytes of it', () =>
    {
        expect(hasCfbSignature(CFB)).toBe(true);
        expect(hasCfbSignature(CFB.subarray(0, 7))).toBe(false);
        expect(hasCfbSignature(Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe0))).toBe(false);
    });

    it.each([
        ['From: a', true],
        ['Received: from x', true],
        ['X-Synthetic-Fixture: true', true],
        ['﻿Subject: with a byte order mark', true],
        [': no name', false],
        ['Not a header line', false],
        ['From alice@example.test Mon Jan 1', false],
        ['', false],
    ])('startsLikeEmailHeader(%j) = %s', (text, expected) =>
    {
        expect(startsLikeEmailHeader(new TextEncoder().encode(text))).toBe(expected);
    });
});

describe('detectFileType', () =>
{
    it.each([
        ['a .eml with email text', 'mail.eml', EML, { kind: 'eml' }],
        ['an upper-case .EML', 'MAIL.EML', EML, { kind: 'eml' }],
        ['a .msg Compound File', 'mail.msg', CFB, { kind: 'msg' }],
        ['a mixed-case .Msg Compound File', 'mail.Msg', CFB, { kind: 'msg' }],
        ['a Compound File named .eml (read as .msg)', 'mail.eml', CFB, { kind: 'msg' }],
        ['a .msg holding internet message text (read as .eml)', 'mail.msg', EML, { kind: 'eml' }],
        ['a .eml with plain text that is not a header (postal-mime decides)', 'notes.eml', TEXT_NOT_HEADER, { kind: 'eml' }],
    ] as const)('%s', (_label, name, bytes, expected) =>
    {
        expect(detectFileType(name, bytes)).toEqual(expected);
    });

    it.each([
        ['a .pdf', 'scan.pdf', EML],
        ['a Compound File named .doc', 'report.doc', CFB],
        ['no extension', 'mail', EML],
        ['an .mbox (not supported yet)', 'box.mbox', EML],
    ])('%s -> unsupported-type', (_label, name, bytes) =>
    {
        expect(detectFileType(name, bytes)).toEqual({
            error: 'unsupported-type',
            detail: 'not an email file: only .eml and .msg files can be read',
        });
    });

    it('a .eml holding binary data -> unsupported-type', () =>
    {
        expect(detectFileType('photo.eml', BINARY)).toEqual({
            error: 'unsupported-type',
            detail: 'not an email file: the file holds binary data',
        });
    });

    it('a .msg that is neither a Compound File nor email text -> corrupt', () =>
    {
        for (const bytes of [BINARY, TEXT_NOT_HEADER, CFB.subarray(0, 4)])
        {
            expect(detectFileType('mail.msg', bytes)).toEqual({
                error: 'corrupt',
                detail: 'damaged file structure: this is not a readable Outlook message file',
            });
        }
    });

    it('an empty .eml or .msg -> corrupt', () =>
    {
        for (const name of ['a.eml', 'a.msg'])
        {
            expect(detectFileType(name, new Uint8Array(0))).toEqual({ error: 'corrupt', detail: 'the file is empty' });
        }
    });
});
