// The .eml adapter: turns one .eml file into a NormalizedMessage.
//
// postal-mime does the MIME work (headers, encoded words, quoted-printable,
// base64, charsets, multipart trees). This file and eml-tree.ts are the only
// places that know about postal-mime: everything it returns is copied into
// our own NormalizedMessage shape, so the rest of the tool never sees the
// library and the library can be swapped without touching anything else.
//
// The body is built here, part by part, from the MIME parts tree (see
// eml-tree.ts), never from postal-mime's joined `email.text` / `email.html`:
// postal-mime converts some HTML parts to text with its own simple converter,
// and it moves text parts ahead of forwarded messages.
//
// Email content is untrusted (README.md, rule R4):
// - HTML is never rendered, loaded or evaluated here. Every HTML body part is
//   handed as a plain string to the injected `htmlToText` function.
// - Attachments are reduced to name, size and type. Their contents are never
//   opened, and no reference to the content bytes is kept in the result.
//   The one exception (a user decision, 2026-11-10) is an email attached to
//   the email (a message/rfc822 part), whether inline or sent with
//   "Content-Disposition: attachment": its bytes are parsed again as an
//   email, by this same adapter with the same limits as a dropped file
//   (HTML only through the injected inert `htmlToText`), then dropped. It
//   becomes an AttachedMessage of its own (ParseResult.attached), and an
//   inline one also joins the body as a forwarded block. Every other
//   attachment type (PDF, Office documents, images, ...) is never parsed,
//   only listed.

import { addressParser, decodeWords, type Address, type Attachment, type Email, type PostalMimeOptions } from 'postal-mime';
import { MAX_EXPANDED_FORWARDS, MAX_FORWARD_DEPTH } from './attached-email-limits';
import { parseEmailDate } from './date-header';
import { parseEmlTree, PostalMimeInternalsError, type EmlPart, type EmlTree } from './eml-tree';
import { FORWARDED_SEPARATOR } from './forwarded-block';
import { sha256Hex } from './file-hash';
import { convertHtmlBody, HtmlConversionError } from './html-conversion';
import type { HtmlToTextResult } from './html-to-text';
import { parseIdList, parseSingleId } from './message-ids';
import { toLfLineEndings } from './line-endings';
import { senderIfDifferent } from './mailbox';
import type { AttachedMessage, AttachedPlace, AttachmentInfo, EmailAddress, EmailDate, EmailParser, InputFile, NormalizedMessage, ParseResult, ParseWarning } from '../../Header/parsed-email';

/** What the .eml adapter needs from outside. */
export interface EmlParserOptions
{
    /**
     * Converts an HTML body part to plain text. Called once for every HTML part
     * whose text goes into the body: an HTML part in multipart/mixed (or
     * related, or any multipart other than alternative), and the HTML of the
     * first version holding HTML of a multipart/alternative in which no version
     * is plain only (plain text and no HTML; whitespace-only text does not
     * count), see alternativeHtmlVersion. Attached emails (inline or sent as
     * attachments) follow the same rules; the ones sent as attachments are
     * read last, see readDeferred. It must be
     * inert: no rendering, no script execution, no loading of images or styles
     * (README.md, rule R4). Injected so that this adapter stays testable in Node
     * without a DOM. In the browser this is htmlToTextWithDomParser
     * (browser-html-to-text.ts, see browser-parsers.ts).
     *
     * It returns the text and whether it was cut at the converter's length
     * limit; a cut adds the 'html-body-truncated' warning. If it throws or
     * returns anything else, that part's text is left out (nothing is put in
     * its place), the 'html-body-unreadable' warning is added, and the rest of
     * the message is still read: one bad HTML part never fails the whole file.
     */
    readonly htmlToText: (html: string) => HtmlToTextResult;
}

// postal-mime's built-in safety limits (README.md, rule R4: guard against
// malformed or hostile files). Exceeding them makes postal-mime reject the
// file, which we report as 'corrupt'. Real mail stays far below all of them;
// the file size itself is limited before parsing. Each attached email
// (inline or sent as an attachment) is parsed again with the same limits.
const POSTAL_MIME_OPTIONS: PostalMimeOptions = {
    // Multipart inside multipart...: real mail rarely goes past 10 levels.
    maxNestingDepth: 64,
    // Header budget across all parts (postal-mime's default, 2 MiB). Every
    // header line counts as at least 64 bytes, so a file holds at most about
    // 32,768 header lines in all; more and the whole file is 'corrupt' (an
    // error, nothing dropped silently).
    maxHeadersSize: 2 * 1024 * 1024,
    // Number of MIME parts: a few dozen is typical, thousands is an attack.
    maxPartCount: 2000,
    // Every message/rfc822 part comes back as an attachment, never merged into
    // `email.text`. postal-mime's own merge writes a From/Subject/Date block
    // whose date is reformatted in the machine's locale and time zone, which
    // would rewrite the message text and make the output machine-dependent
    // (README.md, rule R6). This adapter expands inline forwarded messages
    // itself instead, see expandForwarded. (parseEmlTree also forces it on.)
    forceRfc822Attachments: true,
    // Attachment bytes as an ArrayBuffer: we only read its length (and, for an
    // attached email, parse it again).
    attachmentEncoding: 'arraybuffer',
};

// The limits on attached emails, MAX_FORWARD_DEPTH and MAX_EXPANDED_FORWARDS
// (attached-email-limits.ts, shared with the .msg adapter), apply here like this:
// - MAX_FORWARD_DEPTH: how many levels of attached emails are read (inline
//   ones expanded into the body, ones sent as attachments read on their
//   own), both kinds counted together. Deeper inline ones are listed as
//   attachments with a 'forwarded-message-not-expanded' warning: their text
//   stays in the original file, nothing is lost silently. Deeper ones sent
//   as attachments stay listed, as they always were, and get no
//   AttachedMessage. Each attached email's bodyText also holds its inline
//   descendants' blocks, so text in memory grows by up to this factor
//   (bounded).
// - MAX_EXPANDED_FORWARDS: how many attached emails are read per file, all
//   levels and both kinds together. Each one is a full parse of its bytes,
//   so this bounds the work a hostile file can cause. Inline ones are read
//   first, in file order, then the ones sent as attachments (see
//   readDeferred), so these never take the place of a block printed in a
//   body. Inline ones over the budget are listed as attachments with a
//   'forwarded-message-not-expanded' warning; ones sent as attachments stay
//   listed and get no AttachedMessage.

/** Parses still allowed for the file being parsed (see MAX_EXPANDED_FORWARDS). */
interface ForwardBudget
{
    remaining: number;
}

/** What every level of one file's parse shares. */
interface ReadContext
{
    readonly options: EmlParserOptions;
    readonly budget: ForwardBudget;
    /**
     * Emails sent as attachments, found so far and not read yet, in the order
     * found. They are read after every inline one (see readDeferred).
     */
    readonly deferred: ChildSlot[];
}

/**
 * The header fields of one email (the file's own or an attached one) and
 * the warnings they cause, ready to be put into a NormalizedMessage.
 */
interface MessageHead
{
    readonly fields: Pick<
        NormalizedMessage,
        'messageId' | 'inReplyTo' | 'references' | 'date' | 'from' | 'sender' | 'to' | 'cc' | 'bcc' | 'subject'
    >;
    readonly dateWarnings: ParseWarning[];
    readonly missingMessageId: boolean;
}

/** One attached email that was read, while the file is still being parsed (indexes are given at the end, see flattenAttached). */
interface AttachedNode
{
    readonly head: MessageHead;
    readonly content: MessageContent;
    /**
     * Inline only: where its block sits in its parent's bodyText ([start, end)),
     * and where its own body starts inside that block (offset from the block
     * start). Set by readContent once the parent's body is joined. null for
     * an email sent as an attachment: it has no block anywhere.
     */
    block: { start: number; end: number; bodyStart: number } | null;
}

/** One message/rfc822 part of an email that was (or will be) read as an attached email. */
interface ChildSlot
{
    /** Which message/rfc822 part of its parent it is, from 1, in file order (see AttachedMessage.path). */
    readonly number: number;
    /** The part's file name, '' when it has none (see AttachedMessage.name). */
    readonly name: string;
    /** null until read, and for good if it could not be read. */
    node: AttachedNode | null;
    /** Sent as an attachment and not read yet: its part and its parent's depth. */
    pending: { readonly attachment: Attachment; readonly depth: number } | null;
}

/**
 * An attachment line while the file is being parsed. `owner` is the inline
 * attached email it belongs to, null if it is the listing email's own; it
 * becomes AttachmentInfo.attachedIndex at the end.
 */
interface PendingAttachment
{
    readonly info: AttachmentInfo;
    readonly owner: AttachedNode | null;
}

/** MIME types that mark a delivery or feedback report (a bounce, an abuse report). */
const REPORT_TYPES: ReadonlySet<string> = new Set(['message/delivery-status', 'message/feedback-report']);

/** Longest error detail kept for the preview's error list. */
const MAX_DETAIL_LENGTH = 200;

/** Creates the .eml parser. `htmlToText` is injected, see EmlParserOptions. */
export function createEmlParser(options: EmlParserOptions): EmailParser
{
    return { parse: (file) => parseEml(file, options) };
}

/** Parses one .eml file. Never throws: any failure becomes a 'corrupt' result. */
async function parseEml(file: InputFile, options: EmlParserOptions): Promise<ParseResult>
{
    // Hash first, so even a file that fails to parse is listed with its hash.
    let sha256: string | null = null;
    try
    {
        sha256 = await sha256Hex(file.bytes);
        const tree = await parseEmlTree(file.bytes, POSTAL_MIME_OPTIONS);
        const { message, attached } = await buildMessage(tree, file.name, sha256, options);
        // No `attached` key at all when the file holds no attached email.
        return attached.length === 0 ? { ok: true, message } : { ok: true, message, attached };
    }
    catch (error)
    {
        return { ok: false, error: 'corrupt', detail: errorDetail(error), fileName: file.name, sha256 };
    }
}

/** Copies what we need out of postal-mime's result into a NormalizedMessage, and reads the attached emails. */
async function buildMessage(
    tree: EmlTree,
    fileName: string,
    sha256: string,
    options: EmlParserOptions,
): Promise<{ message: NormalizedMessage; attached: AttachedMessage[] }>
{
    const context: ReadContext = { options, budget: { remaining: MAX_EXPANDED_FORWARDS }, deferred: [] };
    const content = await readContent(tree, context, 0);
    await readDeferred(context);
    const { attached, resolve } = flattenAttached(content.children, fileName, sha256);
    const message = assembleMessage(readHead(tree.email), content, resolve, { fileName, sha256, kind: 'eml' });
    return { message, attached };
}

/** The header fields of one email, see MessageHead. */
function readHead(email: Email): MessageHead
{
    const date = readDate(email);
    const from = readFrom(email);
    const sender = senderIfDifferent(readSender(email), from);
    const messageId = parseSingleId(email.messageId);
    return {
        fields: {
            messageId,
            inReplyTo: parseSingleId(email.inReplyTo),
            references: parseIdList(email.references),
            date: date.value,
            from,
            // Only when it adds something: absent, not undefined, otherwise.
            ...(sender === undefined ? {} : { sender }),
            to: mailboxes(email.to),
            cc: mailboxes(email.cc),
            bcc: mailboxes(email.bcc),
            // A missing Subject header (and an empty one) becomes ''. NormalizedMessage
            // keeps `subject: string` so later steps never need a null check.
            subject: email.subject ?? '',
        },
        dateWarnings: dateWarnings(date),
        missingMessageId: messageId === null,
    };
}

/** One NormalizedMessage from its header fields and its content (`resolve` turns the attachment lines into AttachmentInfo). */
function assembleMessage(
    head: MessageHead,
    content: MessageContent,
    resolve: (attachments: readonly PendingAttachment[]) => AttachmentInfo[],
    source: NormalizedMessage['source'],
): NormalizedMessage
{
    const warnings: ParseWarning[] = [...head.dateWarnings, ...content.warnings];
    if (head.missingMessageId)
    {
        warnings.push('missing-message-id');
    }
    return { ...head.fields, bodyText: content.text, attachments: resolve(content.attachments), source, warnings };
}

/**
 * Reads the emails sent as attachments (ReadContext.deferred), in the order
 * found, after every inline one of the file: they add nothing to any body,
 * so reading them last means they never use up the budget
 * (MAX_EXPANDED_FORWARDS) before a block that is printed in a body. An
 * email read here can hold more of them: they join the end of the queue.
 *
 * The part itself stays listed in its parent exactly as before (readContent
 * listed it); no text and no warning is added to the parent. When it cannot
 * be read (too deep, over the budget, unreadable, nothing to show, or a
 * PostalMimeInternalsError while reading it, see readAttachedEmail) it
 * simply gets no AttachedMessage, and the file still loads.
 */
async function readDeferred(context: ReadContext): Promise<void>
{
    // An index, not shift(): the queue grows while it is read.
    for (let i = 0; i < context.deferred.length; i++)
    {
        const slot = context.deferred[i];
        if (slot === undefined || slot.pending === null)
        {
            continue;
        }
        const { attachment, depth } = slot.pending;
        slot.pending = null;
        const read = await readAttachedEmail(attachment, context, depth, false);
        slot.node = read === null ? null : { head: read.head, content: read.content, block: null };
    }
}

/**
 * Turns the tree of attached emails that were read into the flat
 * ParseResult.attached list (depth first, file order), and gives the
 * function that turns attachment lines into AttachmentInfo with their
 * `attachedIndex`.
 *
 * Places: an inline email's block is at `block` in its parent's body. Its
 * parent's body sits, in each email that prints the parent, at some offset
 * (`frames`); so its block is there too, at that offset plus `block`.
 *
 * Example: the top email holds inline A, whose block is at 10..90 with its
 * body starting 30 into the block; A holds inline B at 5..20 of A's body.
 * A gets the place (top, 10..90). B gets (A, 5..20) and, since A's body sits
 * at 10 + 30 = 40 in the top body, (top, 45..60).
 */
function flattenAttached(
    topChildren: readonly ChildSlot[],
    fileName: string,
    sha256: string,
): { attached: AttachedMessage[]; resolve: (attachments: readonly PendingAttachment[]) => AttachmentInfo[] }
{
    interface Entry
    {
        readonly node: AttachedNode;
        readonly parent: number;
        readonly places: AttachedPlace[];
        readonly path: number[];
        readonly name: string;
    }
    /** Where the body of the email whose children are walked sits, in each email that prints it. */
    interface Frame
    {
        readonly holder: number;
        readonly offset: number;
    }
    const entries: Entry[] = [];
    const indexOf = new Map<AttachedNode, number>();
    const walk = (slots: readonly ChildSlot[], parent: number, frames: readonly Frame[], path: readonly number[]): void =>
    {
        for (const slot of slots)
        {
            const { node } = slot;
            if (node === null)
            {
                continue;
            }
            const index = entries.length;
            indexOf.set(node, index);
            const ownPath = [...path, slot.number];
            const { block } = node;
            const places =
                block === null ? [] : frames.map((frame) => ({ holder: frame.holder, start: frame.offset + block.start, end: frame.offset + block.end }));
            entries.push({ node, parent, places, path: ownPath, name: slot.name });
            const inner: Frame[] = [{ holder: index, offset: 0 }];
            if (block !== null)
            {
                for (const frame of frames)
                {
                    inner.push({ holder: frame.holder, offset: frame.offset + block.start + block.bodyStart });
                }
            }
            walk(node.content.children, index, inner, ownPath);
        }
    };
    walk(topChildren, -1, [{ holder: -1, offset: 0 }], []);

    const resolve = (attachments: readonly PendingAttachment[]): AttachmentInfo[] =>
        attachments.map(({ info, owner }) =>
        {
            const index = owner === null ? undefined : indexOf.get(owner);
            // The email's own attachments keep exactly the object readContent built.
            return index === undefined ? info : { ...info, attachedIndex: index };
        });
    const attached = entries.map(
        (entry): AttachedMessage => ({
            message: assembleMessage(entry.node.head, entry.node.content, resolve, {
                fileName,
                sha256,
                kind: 'eml',
                attachedPath: [...entry.path],
            }),
            parent: entry.parent,
            places: entry.places,
            path: entry.path,
            name: entry.name,
        }),
    );
    return { attached, resolve };
}

/**
 * Reads the RAW Date header. postal-mime's own `email.date` is already
 * converted to UTC, which loses the sender's time zone, so it is not used.
 */
function readDate(email: Email): { value: EmailDate; hadHeader: boolean }
{
    const header = email.headers.find((h) => h.key === 'date');
    return { value: parseEmailDate(header?.value ?? null), hadHeader: header !== undefined };
}

function dateWarnings(date: { value: EmailDate; hadHeader: boolean }): ParseWarning[]
{
    if (!date.hadHeader)
    {
        return ['missing-date'];
    }
    if (date.value.utcMs === null)
    {
        return ['unparseable-date'];
    }
    // Read as UTC for sorting only: the preview must flag it.
    if (!date.value.zoneKnown)
    {
        return ['unknown-time-zone'];
    }
    return [];
}

/**
 * All mailboxes of the first From header. postal-mime's `email.from` keeps
 * only the first one, but RFC 5322 allows several authors in one From.
 */
function readFrom(email: Email): EmailAddress[]
{
    const header = email.headers.find((h) => h.key === 'from');
    if (header === undefined || header.value.trim() === '')
    {
        return [];
    }
    return mailboxes(addressParser(header.value));
}

/**
 * The first mailbox of the first Sender header (RFC 5322: the one mailbox
 * that actually sent the message, e.g. on behalf of the From author), or
 * undefined. The header allows one mailbox only; should a malformed one hold
 * more, the rest stay in the original file. Whether it is kept depends on
 * the From mailboxes, see senderIfDifferent.
 */
function readSender(email: Email): EmailAddress | undefined
{
    const header = email.headers.find((h) => h.key === 'sender');
    if (header === undefined || header.value.trim() === '')
    {
        return undefined;
    }
    return mailboxes(addressParser(header.value))[0];
}

/**
 * Flattens address groups ("Team: carol@example.test, dave@example.test;")
 * into their members. Missing -> [].
 */
function mailboxes(addresses: readonly Address[] | undefined): EmailAddress[]
{
    return (addresses ?? [])
        .flatMap((entry) => (entry.group ? entry.group : [entry]))
        .map((mailbox) => ({ name: mailbox.name ?? '', address: mailbox.address ?? '' }));
}

/** Body text, attachments and body warnings of one message, its inline forwarded messages included. */
interface MessageContent
{
    readonly text: string;
    readonly attachments: PendingAttachment[];
    readonly warnings: ParseWarning[];
    /**
     * The emails attached to this one (its own message/rfc822 parts, inline or
     * sent as attachments, not deeper ones), in file order. A part sent as an
     * attachment is read later (see readDeferred).
     */
    readonly children: ChildSlot[];
}

/**
 * The body text and attachment list of one message. `depth` is 0 for the
 * file itself and grows by one for each level of attached email.
 *
 * The body is built from the MIME parts tree, depth-first, in file order:
 * - an inline text/plain part adds its text;
 * - an inline text/html part adds its text converted by the injected
 *   `htmlToText` ('html-converted-body', plus 'html-body-truncated' if cut).
 *   If the converter fails on it, the part adds no text and the message gets
 *   'html-body-unreadable' instead (it still counts as a body: no 'no-body');
 * - an inline forwarded message adds its block where it sits in the file,
 *   see expandForwarded;
 * - multipart/alternative holds several versions of the same content: the
 *   plain text of all versions is always used; if some version is plain only
 *   (plain text, no HTML) no HTML is converted, otherwise the HTML of the
 *   first version holding HTML, see alternativeHtmlVersion. So
 *   alternative{plain, html} gives the plain text, and alternative{html,
 *   mixed{html, plain notes}} gives the first HTML converted, then the
 *   notes. Attachments and forwarded messages inside every
 *   version are still listed or expanded, so nothing they hold is lost. A
 *   forwarded message that sits in two versions is therefore expanded twice
 *   (its block appears twice in the body): duplication is accepted over loss
 *   (README.md, rule R6);
 * - every other multipart (mixed, related, ...) gives the text of all its
 *   parts, in order;
 * - a message/rfc822 part sent as an attachment (any Content-Disposition
 *   other than inline) is listed, exactly like any attachment, and queued to
 *   be read as an attached email of its own (see readDeferred). It adds no
 *   text and no warning here;
 * - everything else is listed as an attachment.
 * Every message/rfc822 part also gets its number (see ChildSlot), counted
 * whether it is read or not, so the numbers follow the file.
 * Line ends are LF only: postal-mime turns CRLF into LF but leaves a lone
 * CR, so each part's text (plain, or HTML converted) goes through
 * toLfLineEndings (line-endings.ts) before it is joined. Only CR changes, no
 * other character (README.md, rule R6). The forwarded header lines hold no
 * line break (see forwardedHeaderLines) and the joins below add only LF, so
 * the whole body, forwarded blocks included, is LF only.
 *
 * Empty text parts are skipped. Two text parts are joined by a line break;
 * a forwarded message block is separated from what comes before and after
 * it by a blank line. If there is no text and no forwarded block, the text is
 * '' with a 'no-body' warning. An HTML part that converts to '' still counts
 * as a body (no 'no-body'), as its 'html-converted-body' warning says where to look.
 *
 * postal-mime's own `email.text` and `email.html` are never used.
 *
 * `context` is shared by the whole file: the budget (see
 * MAX_EXPANDED_FORWARDS) and the queue of emails sent as attachments.
 */
async function readContent(tree: EmlTree, context: ReadContext, depth: number): Promise<MessageContent>
{
    const { options } = context;
    // A bounce or feedback report carries the original message as evidence:
    // it stays a listed attachment, as postal-mime itself would do, and is not
    // read as an attached email.
    const isReport = tree.email.attachments.some((a) => REPORT_TYPES.has(a.mimeType));

    const segments: BodySegment[] = [];
    const attachments: PendingAttachment[] = [];
    const warnings: ParseWarning[] = [];
    const children: ChildSlot[] = [];
    let hasOwnBody = false;
    let expandedAny = false;
    let rfc822Parts = 0;

    // `hideHtml` is true inside a multipart/alternative whose HTML is not used
    // (see alternativeHtmlVersion): its HTML parts are skipped. Plain-text parts
    // are never skipped.
    const visit = async (part: EmlPart, hideHtml: boolean): Promise<void> =>
    {
        if (part.kind === 'multipart')
        {
            if (part.subtype !== 'alternative')
            {
                for (const child of part.children)
                {
                    await visit(child, hideHtml);
                }
                return;
            }
            // null: no version's HTML is used, so every child hides its HTML.
            const htmlVersion = alternativeHtmlVersion(part.children);
            for (const child of part.children)
            {
                await visit(child, hideHtml || child !== htmlVersion);
            }
            return;
        }

        if (part.kind === 'text')
        {
            if (part.text === '' || (part.type === 'html' && hideHtml))
            {
                return;
            }
            hasOwnBody = true;
            if (part.type === 'plain')
            {
                segments.push({ text: toLfLineEndings(part.text), isBlock: false, node: null });
                return;
            }
            let converted: HtmlToTextResult;
            try
            {
                converted = convertHtmlBody(options.htmlToText, part.text);
            }
            catch (error)
            {
                // Only a converter failure is turned into a warning; anything else is
                // a real problem with the file and still fails it.
                if (!(error instanceof HtmlConversionError))
                {
                    throw error;
                }
                // No text is invented for the missing part; the warning tells the
                // preview that content is missing (README.md, rule R6).
                addWarning(warnings, 'html-body-unreadable');
                return;
            }
            addWarning(warnings, 'html-converted-body');
            if (converted.truncated)
            {
                addWarning(warnings, 'html-body-truncated');
            }
            if (converted.text !== '')
            {
                segments.push({ text: toLfLineEndings(converted.text), isBlock: false, node: null });
            }
            return;
        }

        const { attachment } = part;
        const number = attachment.mimeType === 'message/rfc822' ? ++rfc822Parts : 0;
        if (isReport || attachment.mimeType !== 'message/rfc822')
        {
            attachments.push({ info: attachmentInfo(attachment), owner: null });
            return;
        }
        if (!isInlineForwarded(attachment))
        {
            // Sent as an attachment: listed exactly as before, read later.
            attachments.push({ info: attachmentInfo(attachment), owner: null });
            const slot: ChildSlot = { number, name: attachment.filename ?? '', node: null, pending: { attachment, depth } };
            children.push(slot);
            context.deferred.push(slot);
            return;
        }
        const inner = await expandForwarded(attachment, context, depth);
        if (inner === null)
        {
            // Too deep, over the budget, unreadable or empty: listed, so it stays
            // recoverable from the file.
            attachments.push({ info: attachmentInfo(attachment), owner: null });
            addWarning(warnings, 'forwarded-message-not-expanded');
            return;
        }
        const node: AttachedNode = { head: inner.head, content: inner.content, block: null };
        segments.push({ text: inner.text, isBlock: true, node, bodyStart: inner.bodyStart });
        children.push({ number, name: attachment.filename ?? '', node, pending: null });
        // One by one: a spread into push overflows the stack for very long lists.
        // Its lines are listed here too, marked as belonging to it (or to an
        // email inside it).
        for (const innerAttachment of inner.content.attachments)
        {
            attachments.push({ info: innerAttachment.info, owner: innerAttachment.owner ?? node });
        }
        for (const warning of inner.warnings)
        {
            addWarning(warnings, warning);
        }
        expandedAny = true;
    };
    await visit(tree.root, false);

    if (!hasOwnBody && !expandedAny)
    {
        warnings.push('no-body');
    }
    const { text, starts } = joinSegments(segments);
    segments.forEach((segment, i) =>
    {
        if (segment.node === null)
        {
            return;
        }
        const start = starts[i] ?? 0;
        segment.node.block = { start, end: start + segment.text.length, bodyStart: segment.bodyStart };
    });
    return { text, attachments, warnings, children };
}

/** One piece of a body: the text of one part, or one forwarded message block. */
type BodySegment =
    | { readonly text: string; readonly isBlock: false; readonly node: null }
    | {
        readonly text: string;
        /** A forwarded message block (see expandForwarded). */
        readonly isBlock: true;
        /** The attached email the block prints. */
        readonly node: AttachedNode;
        /** Where its body starts inside the block. */
        readonly bodyStart: number;
    };

/**
 * Joins body pieces in order: text parts with one line break between them
 * (as postal-mime joins them), a forwarded message block with a blank line
 * before and after it (see appendBlock). `starts[i]` is where segment i
 * starts in the joined text.
 */
function joinSegments(segments: readonly BodySegment[]): { text: string; starts: number[] }
{
    let text = '';
    let previousIsBlock = false;
    const starts: number[] = [];
    for (const segment of segments)
    {
        if (text === '')
        {
            text = segment.text;
        }
        else if (segment.isBlock || previousIsBlock)
        {
            text = appendBlock(text, segment.text);
        }
        else
        {
            text = `${text}\n${segment.text}`;
        }
        // Every join adds the segment at the very end of the text.
        starts.push(text.length - segment.text.length);
        previousIsBlock = segment.isBlock;
    }
    return { text, starts };
}

/**
 * The one version of a multipart/alternative whose HTML goes into the body,
 * or null if none does.
 *
 * "Holds" below means at any depth, and ignores text parts made only of
 * spaces and line breaks (see holdsText).
 *
 * - If some version is a plain rendering, i.e. holds plain text and no HTML,
 *   null: no HTML of this alternative is converted. Plain text is kept even
 *   when it is only a short stub such as "view this message in a browser":
 *   the HTML is never preferred over it.
 * - Otherwise, the first version that holds HTML (then converted,
 *   'html-converted-body'). The HTML of the other versions is dropped: they
 *   are other renderings of the same content.
 * In both cases EVERY inline text/plain part of ALL versions still goes into
 * the body, in file order (readContent never skips a plain part). A plain
 * part can sit next to the HTML inside one version (Apple Mail puts an
 * inline text attachment or a plain footer there): skipping it would
 * silently delete it, and letting it hide the HTML would silently delete the
 * main body (README.md, rule R6).
 *
 * Examples:
 * - alternative{plain, html} or alternative{html, plain} -> the plain text
 *   only;
 * - alternative{plain, mixed{html, plain notes.txt (inline), html}} (Apple
 *   Mail) -> the plain text, then the notes text; no HTML converted;
 * - alternative{html V1, mixed{html V2, plain notes.txt (inline)}} -> V1
 *   converted, then the notes text;
 * - alternative{whitespace-only plain, html} -> the HTML converted (the
 *   whitespace part is still appended before it, as any plain part);
 * - alternative{html A, html B} -> A converted, B dropped.
 *
 * Duplication is accepted over loss: alternative{plain, plain} gives both
 * texts, one after the other, and alternative{html, alternative{plain, html}}
 * gives the outer HTML converted, then the inner plain text.
 */
function alternativeHtmlVersion(versions: readonly EmlPart[]): EmlPart | null
{
    if (versions.some((v) => holdsText(v, 'plain') && !holdsText(v, 'html')))
    {
        return null;
    }
    return versions.find((v) => holdsText(v, 'html')) ?? null;
}

/**
 * True if `part` holds, at any depth, a text part of `type` with more than
 * spaces and line breaks (as the .msg adapter treats a whitespace-only body).
 */
function holdsText(part: EmlPart, type: 'plain' | 'html'): boolean
{
    if (part.kind === 'text')
    {
        return part.type === type && part.text.trim() !== '';
    }
    if (part.kind === 'multipart')
    {
        return part.children.some((child) => holdsText(child, type));
    }
    return false;
}

/** A message/rfc822 part meant to be shown in the body: no Content-Disposition, or "inline". */
function isInlineForwarded(attachment: Attachment): boolean
{
    return (
        attachment.mimeType === 'message/rfc822' &&
        (attachment.disposition === null || attachment.disposition === 'inline')
    );
}

/**
 * Parses an inline forwarded message and returns it as one text block:
 * FORWARDED_SEPARATOR, the inner header lines, a blank line, then the inner
 * body (built by readContent, so the same rules apply, its own forwarded
 * messages included). Its attachments come back flattened, and its body
 * warnings are passed on, since they describe text that is now part of the
 * outer bodyText. The inner email itself (`head`, `content`) also becomes an
 * attached email of its own (see flattenAttached); `bodyStart` is where its
 * body starts inside the block.
 *
 * Returns null, so that the caller lists the part as an attachment, when
 * readAttachedEmail does. Then no empty block is added and the part stays
 * visible in the attachment list. A PostalMimeInternalsError is re-thrown
 * (rethrowInternals true): the whole file fails, as before.
 *
 * An inner message with no body but with header lines or attachments (a
 * common forward: From, Date, Subject and only a PDF) IS expanded: the block
 * is the separator and header lines, with no body after them, and its
 * attachments are listed by name. Its 'no-body' warning is not passed on.
 */
async function expandForwarded(
    attachment: Attachment,
    context: ReadContext,
    depth: number,
): Promise<{
    text: string;
    bodyStart: number;
    head: MessageHead;
    content: MessageContent;
    warnings: ParseWarning[];
} | null>
{
    const read = await readAttachedEmail(attachment, context, depth, true);
    if (read === null)
    {
        return null;
    }
    const { head, content: body, headerLines, noBody } = read;
    const header = [FORWARDED_SEPARATOR, ...headerLines].join('\n');
    return {
        // No body: the block ends with the header lines, no trailing blank line.
        text: noBody ? header : `${header}\n\n${body.text}`,
        bodyStart: noBody ? header.length : header.length + 2,
        head,
        content: body,
        // readContent only ever gives body warnings ('html-converted-body',
        // 'html-body-truncated', 'html-body-unreadable',
        // 'forwarded-message-not-expanded', and 'no-body'). 'no-body' describes
        // the inner message only: the outer one now has this block as text, so it
        // is dropped here. Date and Message-ID warnings come from readHead and
        // are not in `body.warnings`: they stay on the inner email's own
        // AttachedMessage, never the outer one. This allow-list also guards
        // against a body warning being added later without deciding whether it
        // applies to the outer message.
        warnings: body.warnings.filter(
            (warning) =>
                warning === 'html-converted-body' ||
                warning === 'html-body-truncated' ||
                warning === 'html-body-unreadable' ||
                warning === 'forwarded-message-not-expanded',
        ),
    };
}

/**
 * Parses the bytes of one attached email (inline or sent as an attachment)
 * with the same parser and limits as a dropped file, and reads its content
 * (readContent, so the same rules apply, its own attached emails included).
 *
 * Returns null if: `depth` already reached MAX_FORWARD_DEPTH; the file's
 * budget is used up; the inner bytes cannot be parsed; or the inner message
 * has nothing to show: no body ('no-body'), none of the forwarded header
 * lines (see forwardedHeaderLines) and no attachments.
 *
 * A PostalMimeInternalsError (postal-mime changed under us) is re-thrown when
 * `rethrowInternals` is true, so the whole file fails loudly: expandForwarded
 * passes true, as inline forwards always did. readDeferred passes false: an
 * email sent as an attachment was never parsed before attached emails were
 * read, so a file that loaded then must still load. The error, raised by its
 * own parse or by anything read inside it, then only leaves it listed (null).
 *
 * The inner bytes are only used inside this call: only text and metadata are
 * kept (README.md, rule R4).
 */
async function readAttachedEmail(
    attachment: Attachment,
    context: ReadContext,
    depth: number,
    rethrowInternals: boolean,
): Promise<{ head: MessageHead; content: MessageContent; headerLines: string[]; noBody: boolean } | null>
{
    const { content } = attachment;
    // postal-mime sets rfc822DepthExceeded only when it expands forwarded
    // messages itself, which forceRfc822Attachments turns off. Checked anyway.
    if (depth >= MAX_FORWARD_DEPTH || attachment.rfc822DepthExceeded === true || typeof content === 'string')
    {
        return null;
    }
    // Counted before parsing: an attempt costs a parse even if it then fails.
    if (context.budget.remaining <= 0)
    {
        return null;
    }
    context.budget.remaining--;

    let inner: EmlTree;
    try
    {
        inner = await parseEmlTree(content, POSTAL_MIME_OPTIONS);
    }
    catch (error)
    {
        // For an inline forward a changed library must fail loudly, not hide as
        // an unreadable forward (see rethrowInternals above).
        if (error instanceof PostalMimeInternalsError && rethrowInternals)
        {
            throw error;
        }
        return null;
    }
    let body: MessageContent;
    try
    {
        body = await readContent(inner, context, depth + 1);
    }
    catch (error)
    {
        // An inline forward inside it re-threw (see rethrowInternals above).
        if (error instanceof PostalMimeInternalsError && !rethrowInternals)
        {
            return null;
        }
        throw error;
    }
    const headerLines = forwardedHeaderLines(inner.email);
    const noBody = body.warnings.includes('no-body');
    if (noBody && headerLines.length === 0 && body.attachments.length === 0)
    {
        return null;
    }
    return { head: readHead(inner.email), content: body, headerLines, noBody };
}

/**
 * Header lines for a forwarded message block, built from the RAW header
 * strings: encoded words (=?utf-8?...?=) are decoded, nothing else is
 * reformatted. The Date line is the header text exactly as in the file, never
 * a date reformatted for a locale or time zone. Missing headers are skipped.
 *
 * The lines are the address and summary fields a top-level message keeps in
 * NormalizedMessage, in this order: From, Sender, Date, Subject, To, Cc, Bcc.
 * The block is the only place an expanded message's headers are kept, so
 * Sender and Bcc follow the same rules as for a top-level message: a Sender
 * line only when that mailbox is not one of the From mailboxes (see
 * senderIfDifferent), a Bcc line only when the header is there.
 *
 * Keep the labels and their order in sync with FORWARDED_HEADER_LABELS
 * (forwarded-block.ts): the reply-header detector relies on them to skip
 * this block (its tests check the real output).
 */
function forwardedHeaderLines(email: Email): string[]
{
    const firstHeader = (key: string): string | undefined => email.headers.find((h) => h.key === key)?.value;
    const allHeaders = (key: string): string | undefined =>
    {
        const values = email.headers.filter((h) => h.key === key && h.value !== '').map((h) => h.value);
        return values.length > 0 ? values.join(', ') : undefined;
    };
    const lines: string[] = [];
    const addLine = (label: string, value: string | undefined, decode: boolean): void =>
    {
        if (value === undefined)
        {
            return;
        }
        // Headers arrive unfolded. A decoded encoded word could still hold a line
        // break: it becomes a space, so one header stays one line in the block.
        const shown = (decode ? decodeWords(value) : value).replace(/[\r\n]+/g, ' ');
        lines.push(`${label}: ${shown}`);
    };
    addLine('From', firstHeader('from'), true);
    if (senderIfDifferent(readSender(email), readFrom(email)) !== undefined)
    {
        addLine('Sender', firstHeader('sender'), true);
    }
    addLine('Date', firstHeader('date'), false);
    addLine('Subject', firstHeader('subject'), true);
    addLine('To', allHeaders('to'), true);
    addLine('Cc', allHeaders('cc'), true);
    addLine('Bcc', allHeaders('bcc'), true);
    return lines;
}

/** Adds `block` after `text`, separated by one blank line. */
function appendBlock(text: string, block: string): string
{
    if (text === '')
    {
        return block;
    }
    return `${text.endsWith('\n') ? text : `${text}\n`}\n${block}`;
}

function addWarning(warnings: ParseWarning[], warning: ParseWarning): void
{
    if (!warnings.includes(warning))
    {
        warnings.push(warning);
    }
}

/**
 * Metadata only (README.md, rule R4). A new object is built, so the result
 * holds no reference to postal-mime's content buffer. Every part postal-mime
 * lists is kept, including inline images of an HTML body, forwarded messages
 * sent as attachments (even when they were read as attached emails), and
 * inline forwarded messages that were not expanded: the list stays complete.
 */
function attachmentInfo(attachment: Attachment): AttachmentInfo
{
    const { content } = attachment;
    return {
        // A part without a file name gets '': the preview chooses how to label it.
        fileName: attachment.filename ?? '',
        // Decoded size. With attachmentEncoding 'arraybuffer' the content is never
        // a string; if it ever were, the byte size would be unknown.
        size: typeof content === 'string' ? null : content.byteLength,
        mimeType: attachment.mimeType,
    };
}

/** A short, single-line message for the preview's error list. */
function errorDetail(error: unknown): string
{
    return shortDetail(error instanceof Error ? error.message : String(error));
}

function shortDetail(text: string): string
{
    return text.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_LENGTH) || 'unknown error';
}
