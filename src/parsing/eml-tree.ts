// The MIME parts tree of one .eml file, read from postal-mime's parser.
//
// postal-mime's public result joins all body text into `email.text` and
// `email.html`, so it cannot tell which text came from which part, or where
// a forwarded message sat between two text parts. The .eml adapter needs both
// to build the body in file order and to send every HTML part through our own
// inert converter. So this module reads the parser's INTERNAL parts tree
// after parsing and copies it into the small typed tree below.
//
// This relies on postal-mime 4.0.8 internals, which are not public API:
// `parser.root` and, on every node, `childNodes`, `contentType`,
// `contentDisposition`, `content` and `getTextContent()`. The version is
// pinned exactly in package.json. Every internal field is checked here before
// it is used, and any surprise throws PostalMimeInternalsError, so a changed
// library fails loudly (eml-tree.test.ts guards this) instead of producing a
// wrong body. This file is the only place that touches those internals.

import PostalMime, { type Attachment, type Email, type PostalMimeOptions } from 'postal-mime';

/** One part of the MIME tree, in file order. */
export type EmlPart =
    /** A multipart/* container. `subtype` is lower case, e.g. 'mixed', 'alternative'. */
    | { readonly kind: 'multipart'; readonly subtype: string; readonly children: readonly EmlPart[] }
    /**
     * An inline text/plain or text/html part: a body part, not an attachment.
     * `text` is decoded (transfer encoding and charset undone). For 'html' it is
     * the HTML source: it must go through the injected converter, never be shown.
     */
    | { readonly kind: 'text'; readonly type: 'plain' | 'html'; readonly text: string }
    /**
     * Any other part: an attachment as postal-mime lists it in
     * `email.attachments` (the same object), message/rfc822 included.
     */
    | { readonly kind: 'attachment'; readonly attachment: Attachment };

/** postal-mime's internals are not what this module expects (library changed). */
export class PostalMimeInternalsError extends Error
{
    constructor(reason: string)
    {
        super(`postal-mime internals changed (expected 4.0.8): ${reason}`);
        this.name = 'PostalMimeInternalsError';
    }
}

/** postal-mime's result plus its parts tree. */
export interface EmlTree
{
    readonly email: Email;
    readonly root: EmlPart;
}

/**
 * Parses `bytes` with postal-mime and returns its result and parts tree.
 * `forceRfc822Attachments` is always on: every message/rfc822 part stays an
 * attachment (the adapter expands inline forwarded messages itself), which is
 * also what lets the tree's attachments be matched one to one with
 * `email.attachments`. Throws on a malformed file (postal-mime's own errors)
 * and PostalMimeInternalsError if the internals do not look as expected.
 */
export async function parseEmlTree(bytes: Uint8Array | ArrayBuffer, options: PostalMimeOptions): Promise<EmlTree>
{
    const parser = new PostalMime({ ...options, forceRfc822Attachments: true });
    const email = await parser.parse(bytes);
    return { email, root: readPartsTree(parser, email) };
}

/**
 * Copies the internal tree of a parser that has finished `parse()` into
 * EmlPart form. Exported for the guard test only.
 *
 * Each leaf is sorted the way postal-mime 4.0.8 sorts it (collectNode and
 * isInlineTextNode, with forceRfc822Attachments on):
 * - text/plain or text/html without "Content-Disposition: attachment" is
 *   body text. A file name alone does not make it an attachment;
 * - any other leaf with content is an attachment, and postal-mime pushed it
 *   to `email.attachments` in this same depth-first order, so the n-th
 *   attachment leaf is `email.attachments[n]`. Both the count and each MIME
 *   type are checked.
 */
export function readPartsTree(parser: unknown, email: Email): EmlPart
{
    if (!isObject(parser) || !('root' in parser))
    {
        throw new PostalMimeInternalsError('parser.root is missing');
    }
    let next = 0;
    const takeAttachment = (mimeType: string): Attachment =>
    {
        const attachment = email.attachments[next];
        if (attachment?.mimeType !== mimeType)
        {
            throw new PostalMimeInternalsError(`attachment ${String(next)} does not match its MIME part`);
        }
        next++;
        return attachment;
    };

    const read = (raw: unknown): EmlPart | null =>
    {
        const node = checkNode(raw);
        if (node.multipart !== false)
        {
            const children: EmlPart[] = [];
            for (const child of node.childNodes)
            {
                const part = read(child);
                if (part !== null)
                {
                    children.push(part);
                }
            }
            return { kind: 'multipart', subtype: node.multipart, children };
        }
        if (node.disposition !== 'attachment' && (node.mimeType === 'text/plain' || node.mimeType === 'text/html'))
        {
            return { kind: 'text', type: node.mimeType === 'text/html' ? 'html' : 'plain', text: node.getText() };
        }
        // postal-mime skips a leaf without content; it never lists it.
        if (node.content === null)
        {
            return null;
        }
        return { kind: 'attachment', attachment: takeAttachment(node.mimeType) };
    };

    const root = read(parser.root) ?? { kind: 'multipart', subtype: 'mixed', children: [] };
    if (next !== email.attachments.length)
    {
        throw new PostalMimeInternalsError(
            `${String(email.attachments.length)} attachments listed but ${String(next)} found in the parts tree`,
        );
    }
    return root;
}

/** The fields of one internal MimeNode that this module reads, checked. */
interface CheckedNode
{
    readonly childNodes: readonly unknown[];
    /** Subtype ('mixed', 'alternative', ...) for a multipart node, else false. */
    readonly multipart: string | false;
    /** Lower-case MIME type, e.g. 'text/plain'. */
    readonly mimeType: string;
    /** Lower-case Content-Disposition value, '' if none. */
    readonly disposition: string;
    readonly content: ArrayBuffer | null;
    readonly getText: () => string;
}

function checkNode(raw: unknown): CheckedNode
{
    if (!isObject(raw))
    {
        throw new PostalMimeInternalsError('a MIME node is not an object');
    }
    const { childNodes, contentType, contentDisposition, content, getTextContent } = raw as Record<string, unknown>;
    if (!Array.isArray(childNodes))
    {
        throw new PostalMimeInternalsError('node.childNodes is not an array');
    }
    const mimeType = parsedValue(contentType, 'contentType');
    const disposition = parsedValue(contentDisposition, 'contentDisposition');
    const multipart = (contentType as Record<string, unknown>).multipart;
    if (multipart !== false && typeof multipart !== 'string')
    {
        throw new PostalMimeInternalsError('node.contentType.multipart is not a string or false');
    }
    // Tag check rather than instanceof, which fails across JavaScript realms.
    if (content !== null && Object.prototype.toString.call(content) !== '[object ArrayBuffer]')
    {
        throw new PostalMimeInternalsError('node.content is not an ArrayBuffer or null');
    }
    if (typeof getTextContent !== 'function')
    {
        throw new PostalMimeInternalsError('node.getTextContent is not a function');
    }
    const getText = (): string =>
    {
        const text: unknown = getTextContent.call(raw);
        if (typeof text !== 'string')
        {
            throw new PostalMimeInternalsError('node.getTextContent() did not return a string');
        }
        return text;
    };
    return { childNodes, multipart, mimeType, disposition, content: content as ArrayBuffer | null, getText };
}

/** `header.parsed.value` of a structured header field, which must be a string. */
function parsedValue(header: unknown, name: string): string
{
    const parsed = isObject(header) ? (header as Record<string, unknown>).parsed : undefined;
    const value = isObject(parsed) ? (parsed as Record<string, unknown>).value : undefined;
    if (typeof value !== 'string')
    {
        throw new PostalMimeInternalsError(`node.${name}.parsed.value is not a string`);
    }
    return value;
}

function isObject(value: unknown): value is object
{
    return typeof value === 'object' && value !== null;
}
