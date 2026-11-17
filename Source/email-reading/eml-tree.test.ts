// Guard tests for eml-tree.ts, which reads postal-mime's INTERNAL parts tree.
// If a postal-mime update changes those internals, these tests must fail
// loudly before any body text goes wrong. Synthetic messages only
// (README.md, rule R7).

import PostalMime, { type Email } from 'postal-mime';
import { describe, expect, it } from 'vitest';
import { parseEmlTree, PostalMimeInternalsError, readPartsTree } from './eml-tree';

const crlf = (...lines: string[]): string => lines.join('\r\n');
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const NESTED = crlf(
    'From: alice@example.test',
    'Subject: Tree',
    'Content-Type: multipart/mixed; boundary="m"',
    '',
    '--m',
    'Content-Type: multipart/alternative; boundary="a"',
    '',
    '--a',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    'Caf=C3=A9 plain.',
    '--a',
    'Content-Type: text/html; charset=utf-8',
    '',
    '<p>HTML</p>',
    '--a--',
    '--m',
    'Content-Type: message/rfc822',
    '',
    'From: carol@example.test',
    '',
    'Inner.',
    '--m',
    'Content-Type: text/plain; name="notes.txt"',
    '',
    'Text part with a file name but no disposition.',
    '--m',
    'Content-Type: text/plain',
    'Content-Disposition: attachment; filename="a.txt"',
    '',
    'abc',
    '--m--',
    '',
);

describe('postal-mime 4.0.8 internals used by eml-tree.ts', () =>
{
    it('a finished parser exposes root, and each node childNodes, contentType, contentDisposition, content, getTextContent', async () =>
    {
        const parser = new PostalMime({ forceRfc822Attachments: true });
        await parser.parse(encode(NESTED));
        const root = (parser as unknown as { root: Record<string, unknown> }).root;
        expect(Array.isArray(root.childNodes)).toBe(true);
        expect(root.contentType).toMatchObject({ parsed: { value: 'multipart/mixed' }, multipart: 'mixed' });
        expect(root.contentDisposition).toMatchObject({ parsed: { value: '' } });
        const leaf = (root.childNodes as Record<string, unknown>[])[2] as Record<string, unknown> & {
            getTextContent: () => string;
        };
        expect(leaf.contentType).toMatchObject({ parsed: { value: 'text/plain' }, multipart: false });
        expect(Object.prototype.toString.call(leaf.content)).toBe('[object ArrayBuffer]');
        expect(leaf.getTextContent()).toBe('Text part with a file name but no disposition.');
    });

    it('parseEmlTree copies the tree in file order, with postal-mime\'s own attachment objects', async () =>
    {
        const { email, root } = await parseEmlTree(encode(NESTED), {});
        expect(email.attachments.map((a) => a.mimeType)).toEqual(['message/rfc822', 'text/plain']);
        expect(root).toEqual({
            kind: 'multipart',
            subtype: 'mixed',
            children: [
                {
                    kind: 'multipart',
                    subtype: 'alternative',
                    children: [
                        // Transfer encoding and charset are undone.
                        { kind: 'text', type: 'plain', text: 'Café plain.' },
                        { kind: 'text', type: 'html', text: '<p>HTML</p>' },
                    ],
                },
                // message/rfc822 is always an attachment here (forceRfc822Attachments).
                { kind: 'attachment', attachment: email.attachments[0] },
                // postal-mime's rule: a file name alone does not make a text part an attachment.
                { kind: 'text', type: 'plain', text: 'Text part with a file name but no disposition.' },
                { kind: 'attachment', attachment: email.attachments[1] },
            ],
        });
        if (root.kind !== 'multipart')
        {
            throw new Error('expected multipart');
        }
        const forwarded = root.children[1];
        expect(forwarded?.kind === 'attachment' && forwarded.attachment).toBe(email.attachments[0]);
    });

    it('forceRfc822Attachments is always on, whatever the options say', async () =>
    {
        const { email } = await parseEmlTree(encode(NESTED), { forceRfc822Attachments: false });
        expect(email.attachments.map((a) => a.mimeType)).toEqual(['message/rfc822', 'text/plain']);
    });

    it('a single-part message is one text leaf', async () =>
    {
        const { root } = await parseEmlTree(encode('From: a@example.test\r\n\r\nHello.\r\n'), {});
        expect(root).toEqual({ kind: 'text', type: 'plain', text: 'Hello.\n' });
    });
});

describe('readPartsTree fails loudly when the internals change shape', () =>
{
    /** A fake internal node, as postal-mime 4.0.8 shapes it. */
    const node = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
        childNodes: [],
        contentType: { parsed: { value: 'text/plain' }, multipart: false },
        contentDisposition: { parsed: { value: '' } },
        content: new ArrayBuffer(1),
        getTextContent: () => 'x',
        ...overrides,
    });
    const noAttachments = { attachments: [] } as unknown as Email;

    it('accepts the expected shape', () =>
    {
        expect(readPartsTree({ root: node() }, noAttachments)).toEqual({ kind: 'text', type: 'plain', text: 'x' });
    });

    it.each([
        ['no root', {}],
        ['root is not an object', { root: 'x' }],
        ['no childNodes', { root: node({ childNodes: undefined }) }],
        ['no contentType.parsed', { root: node({ contentType: { value: 'text/plain', multipart: false } }) }],
        ['contentType.multipart missing', { root: node({ contentType: { parsed: { value: 'text/plain' } } }) }],
        ['no contentDisposition.parsed.value', { root: node({ contentDisposition: {} }) }],
        ['content is a string', { root: node({ content: 'x' }) }],
        ['no getTextContent', { root: node({ getTextContent: undefined }) }],
        ['getTextContent returns a non-string', { root: node({ getTextContent: () => 1 }) }],
        ['a bad child node', { root: node({ contentType: { parsed: { value: 'multipart/mixed' }, multipart: 'mixed' }, childNodes: [null] }) }],
    ])('%s', (_label, parser) =>
    {
        expect(() => readPartsTree(parser, noAttachments)).toThrow(PostalMimeInternalsError);
    });

    it('attachments that do not match the tree (count or MIME type) are rejected', () =>
    {
        const pdf = node({ contentType: { parsed: { value: 'application/pdf' }, multipart: false } });
        const listed = (mimeType: string): Email => ({ attachments: [{ mimeType }] }) as unknown as Email;
        expect(() => readPartsTree({ root: pdf }, noAttachments)).toThrow(PostalMimeInternalsError);
        expect(() => readPartsTree({ root: pdf }, listed('image/png'))).toThrow(PostalMimeInternalsError);
        expect(() => readPartsTree({ root: node() }, listed('text/plain'))).toThrow(/1 attachments listed but 0/);
        expect(readPartsTree({ root: pdf }, listed('application/pdf'))).toMatchObject({ kind: 'attachment' });
    });
});
