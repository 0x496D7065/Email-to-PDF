// The .msg adapter: turns one classic Outlook .msg file into a NormalizedMessage.
//
// @kenjiuno/msgreader does the file-format work (the "Compound File" container
// and its MAPI properties). This file is the only place that knows about
// msgreader: everything it returns is copied into our own NormalizedMessage
// shape, so the rest of the tool never sees the library and the library can be
// swapped without touching anything else.
//
// Email content is untrusted (README.md, rule R4):
// - HTML is never rendered, loaded or evaluated here. An HTML-only body is
//   handed as a plain string to the injected `htmlToText` function.
// - An RTF-only body is not converted (no RTF library, nothing is
//   decompressed): the message gets an empty bodyText and an 'rtf-only-body'
//   warning, and the text stays in the original file.
// - Attachments are reduced to name, size and type. Their contents are never
//   read (msgreader's getAttachment() is never called), and the result holds
//   no reference to any content bytes.
//   The one exception (a user decision, 2026-11-10, task 8.13b-2) is an
//   Outlook item attached as an item (an e-mail forwarded "as attachment"):
//   msgreader already reads its properties along with the file's own
//   (`innerMsgContentFields`), and this adapter turns them into an
//   AttachedMessage of its own (ParseResult.attached) with the same rules
//   and limits as a dropped file (HTML only through the injected inert
//   `htmlToText`), see readAttachedItems. Its text never joins the parent's
//   bodyText. Every other attachment type (PDF, Office documents, images,
//   ...) is never read, only listed.

import MsgReaderImport, { type FieldsData } from '@kenjiuno/msgreader';
import { MAX_EXPANDED_FORWARDS, MAX_FORWARD_DEPTH } from './attached-email-limits';
import { encodingForCodepage } from './codepage-encodings';
import { parseEmailDate } from './date-header';
import { sha256Hex } from './file-hash';
import { convertHtmlBody, HtmlConversionError } from './html-conversion';
import type { HtmlToTextResult } from './html-to-text';
import { parseIdList, parseSingleId } from './message-ids';
import { toLfLineEndings } from './line-endings';
import { senderIfDifferent } from './mailbox';
import type { AttachedMessage, AttachmentInfo, EmailAddress, EmailDate, EmailParser, InputFile, NormalizedMessage, ParseResult, ParseWarning } from '../../Header/parsed-email';

// msgreader is a CommonJS package. Its default export is the class, but how a
// CommonJS default export reaches an ES `import X from` differs by tool: in
// Vitest `MsgReaderImport` is the class, while the production `vite build`
// hands us the whole module object, with the class under `.default`. Both
// cases are handled here so the shipped site and the tests run the same code.
type MsgReaderClass = typeof MsgReaderImport;
const MsgReader: MsgReaderClass =
    typeof MsgReaderImport === 'function'
        ? MsgReaderImport
        : (MsgReaderImport as unknown as { readonly default: MsgReaderClass }).default;

/** What the .msg adapter needs from outside. */
export interface MsgParserOptions
{
    /**
     * Converts an HTML body to plain text. Called only when the message has no
     * plain-text body but has an HTML one. It must be inert: no rendering, no
     * script execution, no loading of images or styles (README.md, rule R4).
     * Injected so that this adapter stays testable in Node without a DOM. In
     * the browser this is htmlToTextWithDomParser (browser-html-to-text.ts, see
     * browser-parsers.ts).
     *
     * It returns the text and whether it was cut at the converter's length
     * limit; a cut adds the 'html-body-truncated' warning. If it throws or
     * returns anything else, the body is left empty (nothing is put in its
     * place) with the 'html-body-unreadable' warning, and the rest of the
     * message (headers, attachment list) is still read.
     */
    readonly htmlToText: (html: string) => HtmlToTextResult;
}

/** Longest error detail kept for the preview's error list. */
const MAX_DETAIL_LENGTH = 200;

/** Type given to an attached Outlook item (an e-mail attached as an item, not as a file). */
const OUTLOOK_ITEM_MIME_TYPE = 'application/vnd.ms-outlook';

/**
 * Text encoding for 8-bit strings when the file names no code page, or one the
 * browser cannot decode. Windows-1252 ("Western European") is the code page
 * classic Outlook uses for English, French, Dutch and German, and it decodes
 * every byte, so nothing is dropped: a wrong guess shows wrong accents, never
 * missing text.
 */
const FALLBACK_ANSI_ENCODING = 'windows-1252';

/**
 * How many times the whole file may be read again, each time with another
 * 8-bit text encoding, for attached Outlook items whose code page differs
 * from the one the file was read with (see readAttachedItems). Each read
 * costs a full parse of the file, so this bounds the work; real files rarely
 * mix more than two code pages. An item that would need one more read is
 * read with the encoding at hand and gets 'text-encoding-uncertain'.
 *
 * Memory: every read is kept until the file is done (the file's own read plus
 * up to this many more, so at most 5 full msgreader results at once). That is
 * acceptable because a dropped file is at most 50 MB (MAX_FILE_BYTES,
 * parse-files.ts) and parsing runs in an isolated worker that is terminated
 * at its time limit (PARSE_TIMEOUT_MS, parse-worker-runner.ts).
 */
const MAX_ENCODING_READS = 4;

/**
 * How the file's properties were read, and how to read them again (see
 * readFields and readAttachedItems).
 */
export interface FieldReads
{
    /**
     * The 8-bit text encoding the fields were read with; null for msgreader's
     * default (each byte becomes the character with the same number), used
     * when the file's own email has no 8-bit strings.
     */
    readonly encoding: string | null;
    /**
     * Reads the whole file again with another 8-bit text encoding. Absent when
     * that is not possible (unit tests that hand crafted msgreader output to
     * resultFromFields).
     */
    readonly reread?: (encoding: string) => FieldsData;
}

/** Creates the .msg parser. `htmlToText` is injected, see MsgParserOptions. */
export function createMsgParser(options: MsgParserOptions): EmailParser
{
    return { parse: (file) => parseMsg(file, options) };
}

/** Parses one .msg file. Never throws: any failure becomes a 'corrupt' result. */
async function parseMsg(file: InputFile, options: MsgParserOptions): Promise<ParseResult>
{
    // Hash first, so even a file that fails to parse is listed with its hash.
    let sha256: string | null = null;
    try
    {
        sha256 = await sha256Hex(file.bytes);
        const { fields, reads } = readFields(file.bytes);
        return resultFromFields(fields, file.name, sha256, options, reads);
    }
    catch (error)
    {
        // A TypeError or RangeError here comes from inside msgreader: a damaged
        // or cut-off file makes it look up a part of the file that is not there
        // (RangeError: "Offset is outside the bounds of the DataView").
        return { ok: false, error: 'corrupt', detail: errorDetail(error, 'unreadable file structure'), fileName: file.name, sha256 };
    }
}

/**
 * Turns msgreader's result into a ParseResult. Exported for unit tests, which
 * hand it crafted msgreader output (for example damaged, wrongly typed
 * properties). Never throws: any failure becomes a 'corrupt' result.
 *
 * The file's own email is built first, exactly as before attached items were
 * read; then the attached Outlook items (readAttachedItems), which can never
 * make the file fail. `reads` says how `fields` was read (default: with
 * msgreader's default encoding, no second read possible).
 */
export function resultFromFields(
    fields: FieldsData,
    fileName: string,
    sha256: string,
    options: MsgParserOptions,
    reads: FieldReads = { encoding: null },
): ParseResult
{
    const corrupt = (detail: string): ParseResult => ({ ok: false, error: 'corrupt', detail, fileName, sha256 });
    try
    {
        if (fields.error !== undefined)
        {
            return corrupt(shortDetail(String(fields.error)));
        }
        if (!looksLikeMessage(fields))
        {
            return corrupt('not an Outlook message: no message properties found');
        }
        const built = buildMessage(fields, { fileName, sha256, kind: 'msg' }, options);
        const { attached, allRead } = readAttachedItems(fields, reads, { fileName, sha256 }, options);
        // Every attached Outlook item was read as an email of its own: its text is
        // shown there, so the "not expanded" warning no longer applies (task 8.13b-3).
        const message = allRead ? withoutNotExpanded(built) : built;
        // No `attached` key at all when the file holds no readable attached item.
        return attached.length === 0 ? { ok: true, message } : { ok: true, message, attached };
    }
    catch (error)
    {
        return corrupt(errorDetail(error, 'unexpected value type'));
    }
}

/**
 * Reads all properties of the file with msgreader.
 *
 * 8-bit ("ANSI", type 001E) strings carry no encoding of their own: the
 * message's code page says how to read them, but msgreader needs the
 * encoding BEFORE it reads the file. So the file is read once to learn the
 * code page, and read again with that encoding only if it does contain 8-bit
 * strings. Modern Outlook stores Unicode (001F) strings only, which need
 * no second read.
 *
 * `includeRawProps` keeps every property, also the ones msgreader does not
 * name (In-Reply-To, References, the "sent representing" sender).
 *
 * Only the file's own email decides the encoding here. msgreader reads the
 * attached Outlook items in the same pass, with the same encoding; one whose
 * code page differs is handled later with `reads.reread` (see
 * readAttachedItems).
 */
function readFields(bytes: Uint8Array): { fields: FieldsData; reads: FieldReads }
{
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const reread = (encoding: string): FieldsData =>
    {
        const reader = new MsgReader(view);
        reader.parserConfig = { includeRawProps: true, ansiEncoding: encoding };
        return reader.getFileData();
    };
    const first = new MsgReader(view);
    first.parserConfig = { includeRawProps: true };
    const fields = first.getFileData();
    if (fields.error !== undefined || !hasAnsiStrings(fields))
    {
        return { fields, reads: { encoding: null, reread } };
    }

    const encoding = ansiEncodingOf(fields) ?? FALLBACK_ANSI_ENCODING;
    return { fields: reread(encoding), reads: { encoding, reread } };
}

/**
 * The encoding named by a message's own code page properties, or null if it
 * names none the browser can decode. PidTagMessageCodepage is the code page
 * of the 8-bit strings; PidTagInternetCodepage (the body's code page) is the
 * next best hint. Both are numbers, so they read the same whatever encoding
 * the strings were read with.
 */
function ansiEncodingOf(fields: FieldsData): string | null
{
    return encodingForCodepage(fields.messageCodepage) ?? encodingForCodepage(fields.internetCodepage);
}

/**
 * True if the message, a recipient or an attachment has an 8-bit string
 * property. Not the properties of an attached Outlook item: msgreader keeps
 * those apart (innerMsgContentFields), and each item is checked on its own
 * (see readAttachedItems).
 */
function hasAnsiStrings(fields: FieldsData): boolean
{
    const all = [fields, ...(fields.recipients ?? []), ...(fields.attachments ?? [])];
    return all.some((f) => (f.rawProps ?? []).some((p) => p.propertyTag?.endsWith('001e') === true));
}

/**
 * A Compound File that is not an Outlook item (for example a renamed Word
 * .doc) parses without error but has none of the message properties.
 */
function looksLikeMessage(fields: FieldsData): boolean
{
    return (
        fields.messageClass !== undefined ||
        fields.subject !== undefined ||
        fields.body !== undefined ||
        fields.senderName !== undefined ||
        fields.senderEmail !== undefined ||
        (fields.recipients ?? []).length > 0 ||
        (fields.attachments ?? []).length > 0
    );
}

/**
 * Copies what we need out of msgreader's result into a NormalizedMessage:
 * the file's own email, or an attached Outlook item's (see
 * readAttachedItems), with the same rules.
 */
function buildMessage(fields: FieldsData, source: NormalizedMessage['source'], options: MsgParserOptions): NormalizedMessage
{
    const headers = asString(fields.headers) ?? '';
    const messageId = parseSingleId(asString(fields.messageId) ?? headerValue(headers, 'message-id'));
    const date = readDate(fields, headers);
    const body = readBody(fields, options);
    const attachments = fields.attachments ?? [];
    const senders = readSenders(fields);

    const warnings: ParseWarning[] = [...date.warnings, ...body.warnings];
    if (messageId === null)
    {
        warnings.push('missing-message-id');
    }
    // Like the .eml adapter: an attached e-mail whose text is not part of
    // bodyText is flagged, so the preview can say that some text is missing.
    // Removed again (withoutNotExpanded) when every attached Outlook item of
    // this email was read as an email of its own: the PDF and the preview then
    // show its text there (task 8.13b-3, see readAttachedItems).
    if (attachments.some((a) => a.innerMsgContent === true))
    {
        warnings.push('forwarded-message-not-expanded');
    }

    return {
        messageId,
        // PidTagInReplyToId (0x1042) and PidTagInternetReferences (0x1039) have
        // no name in msgreader: read from the raw properties. A message saved
        // before sending has neither; then the received internet headers are
        // the fallback.
        inReplyTo: parseSingleId(rawString(fields, '1042') ?? headerValue(headers, 'in-reply-to')),
        references: parseIdList(rawString(fields, '1039') ?? headerValue(headers, 'references')),
        date: date.value,
        from: senders.from,
        // Only when it adds something: absent, not undefined, otherwise.
        ...(senders.sender === undefined ? {} : { sender: senders.sender }),
        ...readRecipients(fields),
        // A missing subject becomes '', like in the .eml adapter.
        subject: asString(fields.subject) ?? '',
        bodyText: body.text,
        attachments: attachments.map(attachmentInfo),
        source,
        warnings,
    };
}

/** One attached Outlook item that was read, while the file is still being read (see readAttachedItems). */
interface ItemNode
{
    readonly message: NormalizedMessage;
    /** Its own attached Outlook items, in attachment-list order. */
    readonly children: ItemSlot[];
}

/** One attached Outlook item of an email: read (node) or not (null: too deep, over the budget, unreadable, or nothing to show). */
interface ItemSlot
{
    /** Which attached Outlook item of its holder it is, from 1, in attachment-list order (see AttachedMessage.path). */
    readonly number: number;
    /** Its line's file name in the holder's attachment list (attachmentInfo), '' when none (see AttachedMessage.name). */
    readonly name: string;
    node: ItemNode | null;
}

/** An email whose attached Outlook items are still to be read (see readAttachedItems). */
interface ItemHolder
{
    /** Its properties, as read by the read made with `readEncoding`. */
    readonly fields: FieldsData;
    /** Where it sits in msgreader's result: its index in `attachments` at each level, [] for the file's own email. */
    readonly indexPath: readonly number[];
    /** The encoding the read that `fields` comes from used (see FieldReads.encoding). */
    readonly readEncoding: string | null;
    /**
     * The encoding an item inside it that names no code page is read with:
     * the nearest PidTagMessageCodepage (the code page of 8-bit strings) from
     * this email up, else FALLBACK_ANSI_ENCODING. Never taken from
     * PidTagInternetCodepage, which describes the body and is often UTF-8:
     * UTF-8 turns 8-bit accented letters into U+FFFD, losing them.
     */
    readonly inheritedEncoding: string;
    /** 0 for the file's own email, then one more per level. */
    readonly depth: number;
    /** Its AttachedMessage.path ([] for the file's own email). */
    readonly path: readonly number[];
    /** Where its items go. */
    readonly slots: ItemSlot[];
}

/**
 * Reads the Outlook items attached as items (an e-mail forwarded "as
 * attachment", innerMsgContent) as emails of their own: ParseResult.attached,
 * flat, depth first in attachment-list order. User decision 2026-11-10 (an
 * exception to README.md rule R4): an attached e-mail is read with the same
 * rules and limits as a dropped file; every other attachment type is never
 * read, only listed.
 *
 * Method: msgreader already reads an attached item's properties in the same
 * pass as the file's own (`innerMsgContentFields`, at any depth); they go
 * through buildMessage, exactly like the file's own. No attachment content
 * is extracted (getAttachment() is never called) and nothing is parsed
 * again from bytes, except the whole file for an encoding, see below.
 *
 * The file's own email is otherwise not changed: an item is still listed
 * in its attachments, its text never joins the parent's bodyText, and so
 * it has no places (`places` is always []) and no attachment line is marked
 * with an attachedIndex. Its `name` is its line's file name.
 *
 * Only emails are read (isEmailItem: message class IPM.Note or IPM.Note.*;
 * user decision 2026-11-12). Any other Outlook item (calendar item, contact,
 * task, ...) or one with no message class stays listed only, and the items
 * inside it are not reached. It does not use up the MAX_EXPANDED_FORWARDS
 * budget (it is not read), but it keeps its number: `path` counts every
 * Outlook item attachment of the holder, read or not, so [2] is always the
 * holder's second Outlook item line.
 *
 * Limits, shared with the .eml adapter (attached-email-limits.ts):
 * - MAX_FORWARD_DEPTH: items up to that many levels down are read; deeper
 *   ones stay listed in the item holding them and get no AttachedMessage.
 * - MAX_EXPANDED_FORWARDS: how many items are read per file, all levels
 *   together, counted before an item is read (an unreadable one counts too).
 *   Items are read level by level, in attachment-list order, like the .eml
 *   adapter's emails sent as attachments (eml-parser.ts, readDeferred).
 * An item over a limit, unreadable (any error while reading it), not an
 * Outlook message, or with nothing to show (no body, no subject, no sender,
 * no recipient, no date and no attachment) gets no AttachedMessage: it stays
 * listed in its holder, and the file still loads.
 *
 * 8-bit ("ANSI") text: msgreader reads the whole file, items included, with
 * ONE encoding (the file's own email's, see readFields). Each item is
 * checked on its own (hasAnsiStrings): one with 8-bit strings is read with
 * its own PidTagMessageCodepage; without one, with its
 * PidTagInternetCodepage if that is not a Unicode encoding (eightBitEncoding:
 * UTF-8 would turn 8-bit accented letters into U+FFFD); else with the one it
 * inherits (see ItemHolder.inheritedEncoding; windows-1252 at worst, which
 * decodes every byte). This is stricter than the file's own email
 * (ansiEncodingOf), which is left exactly as it was. When that differs from
 * the encoding its properties were read with, the whole file is read again
 * with that encoding (`reads.reread`, cached, at most MAX_ENCODING_READS
 * times) and the item's properties are taken from that read, at the same
 * place. The item gets 'text-encoding-uncertain' when its text may still be
 * wrongly decoded: it has 8-bit strings but no usable PidTagMessageCodepage
 * (the encoding is a guess), the read it needed was not possible, or its
 * text comes from an HTML body stored as bytes while it names no usable code
 * page at all (htmlFromBytesWithoutCodepage).
 *
 * 'forwarded-message-not-expanded' (task 8.13b-3): an email whose attached
 * Outlook items were ALL read as emails of their own loses that warning
 * (`allRead` for the file's own email, flattenItems for an item), since the
 * preview and the PDF then show their text as those emails. An email with
 * at least one item that was not read (not an email, over a limit,
 * unreadable) keeps it, as before.
 *
 * Never throws: an unexpected error here leaves the file with no attached
 * items (they all stay listed, `allRead` false), never a failed file.
 */
function readAttachedItems(
    ownFields: FieldsData,
    reads: FieldReads,
    file: { readonly fileName: string; readonly sha256: string },
    options: MsgParserOptions,
): { attached: AttachedMessage[]; allRead: boolean }
{
    try
    {
        // Every read by encoding (null: it failed); the file's own read included.
        const byEncoding = new Map<string, FieldsData | null>();
        if (reads.encoding !== null)
        {
            byEncoding.set(reads.encoding, ownFields);
        }
        let extraReads = 0;
        const fieldsWith = (encoding: string): FieldsData | null =>
        {
            const earlierRead = byEncoding.get(encoding);
            if (earlierRead !== undefined)
            {
                return earlierRead;
            }
            if (reads.reread === undefined || extraReads >= MAX_ENCODING_READS)
            {
                return null;
            }
            extraReads++;
            let fields: FieldsData | null = null;
            try
            {
                const rereadFields = reads.reread(encoding);
                if (rereadFields.error === undefined)
                {
                    fields = rereadFields;
                }
            }
            catch
            {
                // Not expected for bytes that were read once already: handled as "not possible".
            }
            byEncoding.set(encoding, fields);
            return fields;
        };

        let remaining = MAX_EXPANDED_FORWARDS;
        const roots: ItemSlot[] = [];
        const queue: ItemHolder[] = [
            {
                fields: ownFields,
                indexPath: [],
                readEncoding: reads.encoding,
                inheritedEncoding: encodingForCodepage(ownFields.messageCodepage) ?? FALLBACK_ANSI_ENCODING,
                depth: 0,
                path: [],
                slots: roots,
            },
        ];
        // An index, not shift(): the queue grows while it is read.
        for (let q = 0; q < queue.length; q++)
        {
            const holder = queue[q];
            if (holder === undefined)
            {
                continue;
            }
            const list = holder.fields.attachments ?? [];
            let number = 0;
            for (let index = 0; index < list.length; index++)
            {
                if (list[index]?.innerMsgContent !== true)
                {
                    continue;
                }
                // Numbered before anything else is checked: a skipped item (not an
                // email, too deep, over the budget, unreadable) keeps its number, so
                // `path` stays "the n-th Outlook item line of its holder".
                const slot: ItemSlot = { number: ++number, name: itemName(list[index]), node: null };
                holder.slots.push(slot);
                if (!isEmailItem(list[index]))
                {
                    continue;
                }
                if (holder.depth >= MAX_FORWARD_DEPTH || remaining <= 0)
                {
                    continue;
                }
                remaining--;
                const item = readAttachedItem(holder, index, slot.number, fieldsWith, file, options);
                if (item === null)
                {
                    continue;
                }
                const node: ItemNode = { message: item.message, children: [] };
                slot.node = node;
                queue.push({ ...item.holder, depth: holder.depth + 1, slots: node.children });
            }
        }
        return { attached: flattenItems(roots), allRead: allSlotsRead(roots) };
    }
    catch
    {
        return { attached: [], allRead: false };
    }
}

/** The file name of an attached Outlook item's line (attachmentInfo), '' when it cannot be read. */
function itemName(attachment: FieldsData | undefined): string
{
    try
    {
        return attachment === undefined ? '' : attachmentInfo(attachment).fileName;
    }
    catch
    {
        return '';
    }
}

/** True when an email has attached Outlook items and every one of them was read as an email of its own. */
function allSlotsRead(slots: readonly ItemSlot[]): boolean
{
    return slots.length > 0 && slots.every((s) => s.node !== null);
}

/** `message` without the 'forwarded-message-not-expanded' warning (a new object; the same one when it has none). */
function withoutNotExpanded(message: NormalizedMessage): NormalizedMessage
{
    if (!message.warnings.includes('forwarded-message-not-expanded'))
    {
        return message;
    }
    return { ...message, warnings: message.warnings.filter((w) => w !== 'forwarded-message-not-expanded') };
}

/**
 * Reads one attached Outlook item of `holder` (its attachment number
 * `index`), see readAttachedItems. null if it cannot be read or has nothing
 * to show; never throws.
 */
function readAttachedItem(
    holder: ItemHolder,
    index: number,
    number: number,
    fieldsWith: (encoding: string) => FieldsData | null,
    file: { readonly fileName: string; readonly sha256: string },
    options: MsgParserOptions,
): { message: NormalizedMessage; holder: Omit<ItemHolder, 'depth' | 'slots'> } | null
{
    try
    {
        const first: unknown = holder.fields.attachments?.[index]?.innerMsgContentFields;
        if (!isFieldsData(first) || first.error !== undefined || !looksLikeMessage(first))
        {
            return null;
        }
        let fields = first;
        const indexPath = [...holder.indexPath, index];
        const path = [...holder.path, number];
        const ownEncoding = encodingForCodepage(fields.messageCodepage);
        const ansiEncoding = ownEncoding ?? eightBitEncoding(encodingForCodepage(fields.internetCodepage)) ?? holder.inheritedEncoding;
        const inheritedEncoding = ownEncoding ?? holder.inheritedEncoding;
        let readEncoding = holder.readEncoding;
        let uncertain = false;
        if (hasAnsiStrings(fields))
        {
            // Only PidTagMessageCodepage names the code page of 8-bit strings:
            // without it, any choice is a guess.
            uncertain = ownEncoding === null;
            if (ansiEncoding !== readEncoding)
            {
                const rereadFields = fieldsWith(ansiEncoding);
                const found = rereadFields === null ? undefined : fieldsAt(rereadFields, indexPath);
                if (found === undefined)
                {
                    uncertain = true;
                }
                else
                {
                    fields = found;
                    readEncoding = ansiEncoding;
                }
            }
        }
        const built = buildMessage(fields, { ...file, kind: 'msg', attachedPath: [...path] }, options);
        if (hasNothingToShow(built))
        {
            return null;
        }
        // An HTML body stored as bytes is decoded with the item's code page
        // (htmlBody). msgreader loses both code page properties of an item with
        // no recipients (its fixed-size properties are read from the wrong
        // offset), and htmlBody then assumes UTF-8: 8-bit accented letters would
        // silently become U+FFFD. Flagged, so the preview says so.
        if (htmlFromBytesWithoutCodepage(fields, built))
        {
            uncertain = true;
        }
        const message = uncertain ? { ...built, warnings: [...built.warnings, 'text-encoding-uncertain' as const] } : built;
        return { message, holder: { fields, indexPath, readEncoding, inheritedEncoding, path } };
    }
    catch
    {
        // A damaged property, a value of the wrong type, ...: the item stays listed.
        return null;
    }
}

/** The properties of the attached item at `indexPath` (see ItemHolder.indexPath) in another read of the same file, if it is there. */
function fieldsAt(fields: FieldsData, indexPath: readonly number[]): FieldsData | undefined
{
    let current: FieldsData | undefined = fields;
    for (const index of indexPath)
    {
        const attachment: FieldsData | undefined = current?.attachments?.[index];
        if (attachment?.innerMsgContent !== true)
        {
            return undefined;
        }
        current = attachment.innerMsgContentFields;
    }
    return isFieldsData(current) ? current : undefined;
}

/**
 * The encoding, if it can be the code page of 8-bit strings; null for a
 * Unicode encoding (UTF-8, UTF-16). Used for PidTagInternetCodepage, the
 * body's code page, which is often UTF-8 even when the 8-bit strings are in a
 * Windows code page: reading them as UTF-8 turns accented letters into
 * U+FFFD, losing them, while a Windows code page decodes every byte.
 */
function eightBitEncoding(encoding: string | null): string | null
{
    return encoding === null || encoding.startsWith('utf-') ? null : encoding;
}

/**
 * True if the item's body text was converted from an HTML body stored as
 * bytes (PidTagHtml) while it names no usable code page, so htmlBody had to
 * assume UTF-8.
 */
function htmlFromBytesWithoutCodepage(fields: FieldsData, message: NormalizedMessage): boolean
{
    return (
        message.warnings.includes('html-converted-body') &&
        fields.bodyHtml === undefined &&
        fields.html instanceof Uint8Array &&
        encodingForCodepage(fields.internetCodepage) === null &&
        encodingForCodepage(fields.messageCodepage) === null
    );
}

/**
 * True if an attached Outlook item is an email: its message class
 * (PidTagMessageClass) is IPM.Note or IPM.Note.<anything> (signed, encrypted,
 * ...), letter case ignored. User decision 2026-11-12 (task 8.13b-2): only
 * emails are read as emails of their own; calendar items, contacts, tasks,
 * notes, reports (REPORT.IPM.Note.*), ... stay listed only, and so do the
 * items attached inside them. An item with no message class, or one that is
 * not a string, is NOT read (the safe side): Outlook always writes one, so
 * its absence means a damaged or unusual item, and it stays listed. Never
 * throws.
 */
function isEmailItem(attachment: FieldsData | undefined): boolean
{
    try
    {
        const inner: unknown = attachment?.innerMsgContentFields;
        if (!isFieldsData(inner))
        {
            return false;
        }
        const messageClass = asString(inner.messageClass)?.toLowerCase();
        return messageClass === 'ipm.note' || messageClass?.startsWith('ipm.note.') === true;
    }
    catch
    {
        return false;
    }
}

function isFieldsData(value: unknown): value is FieldsData
{
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True if an attached item holds nothing at all to show: no body, and no
 * subject, sender, recipient, date or attachment. Like the .eml adapter's
 * rule for an attached email with no body and no header lines (eml-parser.ts,
 * readAttachedEmail): no empty email is made of it.
 */
function hasNothingToShow(message: NormalizedMessage): boolean
{
    return (
        message.warnings.includes('no-body') &&
        message.subject === '' &&
        message.from.length === 0 &&
        message.sender === undefined &&
        message.to.length === 0 &&
        message.cc.length === 0 &&
        message.bcc.length === 0 &&
        message.date.utcMs === null &&
        message.date.original === '' &&
        message.attachments.length === 0
    );
}

/** The tree of items that were read, as the flat ParseResult.attached list: depth first, attachment-list order. */
function flattenItems(roots: readonly ItemSlot[]): AttachedMessage[]
{
    const attached: AttachedMessage[] = [];
    const walk = (slots: readonly ItemSlot[], parent: number): void =>
    {
        for (const { node, name } of slots)
        {
            if (node === null)
            {
                continue;
            }
            const index = attached.length;
            const path = [...(node.message.source.attachedPath ?? [])];
            // Its own items all read: their text is shown as emails of their own (see withoutNotExpanded).
            const message = allSlotsRead(node.children) ? withoutNotExpanded(node.message) : node.message;
            attached.push({ message, parent, places: [], path, name });
            walk(node.children, index);
        }
    };
    walk(roots, -1);
    return attached;
}

/** A string property from msgreader's raw list, by its 4-hex-digit id (Unicode or 8-bit). */
function rawString(fields: FieldsData, propertyId: string): string | undefined
{
    const tags = [`${propertyId}001f`, `${propertyId}001e`];
    const prop = (fields.rawProps ?? []).find((p) => p.propertyTag !== undefined && tags.includes(p.propertyTag));
    return typeof prop?.value === 'string' ? prop.value : undefined;
}

/**
 * The first header `name` (lower case) in PidTagTransportMessageHeaders: the
 * internet headers a RECEIVED message arrived with. Folded lines are joined.
 * undefined if absent (a message saved from the Sent folder has none).
 */
function headerValue(headers: string, name: string): string | undefined
{
    const lines = headers.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++)
    {
        const line = lines[i] ?? '';
        if (line === '')
        {
            return undefined; // end of the header block
        }
        const colon = line.indexOf(':');
        if (colon <= 0 || line.slice(0, colon).trim().toLowerCase() !== name)
        {
            continue;
        }
        let value = line.slice(colon + 1);
        // Continuation lines start with a space or tab (RFC 5322 folding).
        while (/^[ \t]/.test(lines[i + 1] ?? ''))
        {
            value += ` ${(lines[++i] ?? '').trim()}`;
        }
        return value.trim();
    }
    return undefined;
}

/**
 * The date of the message.
 *
 * A .msg stores times as exact UTC instants, not as a Date header text:
 * PidTagClientSubmitTime (when the sender sent it) and
 * PidTagMessageDeliveryTime (when it arrived). Neither records the sender's
 * time zone. msgreader gives them as "Wed, 02 Apr 2025 09:00:00 GMT", to the
 * second, which matches the one-second precision of a Date header, so the
 * same message saved as .eml and as .msg gets the same `utcMs`.
 *
 * Sources, in order:
 * 1. The sent time. If the received internet headers have a Date header for
 *    the same second with a real zone, that header is used instead: same
 *    instant, plus the sender's original text and offset.
 * 2. No sent time: the Date header of the received internet headers.
 * 3. Otherwise the received time.
 * A date taken from a property gets `zoneKnown: true` (the instant is exact),
 * `offsetMinutes: null` (the sender's zone is unknown) and as `original` the
 * instant written in ISO form, e.g. "2025-04-02T09:00:00.000Z", since the
 * file holds no date text of its own.
 *
 * A time property of the wrong type (a damaged file) counts as present but
 * unreadable, like a time that does not parse.
 */
function readDate(fields: FieldsData, headers: string): { value: EmailDate; warnings: ParseWarning[] }
{
    const rawHeader = headerValue(headers, 'date');
    const header = rawHeader === undefined ? null : parseEmailDate(rawHeader);
    const submitted = propertyTime(asString(fields.clientSubmitTime));
    const delivered = propertyTime(asString(fields.messageDeliveryTime));

    if (submitted !== null)
    {
        if (header !== null && header.zoneKnown && header.utcMs === submitted.utcMs)
        {
            return { value: header, warnings: [] };
        }
        return { value: submitted, warnings: [] };
    }
    if (header !== null && header.utcMs !== null)
    {
        // Read as UTC for sorting only if the zone is unknown: the preview flags it.
        return { value: header, warnings: header.zoneKnown ? [] : ['unknown-time-zone'] };
    }
    if (delivered !== null)
    {
        return { value: delivered, warnings: [] };
    }

    // A time that exists but cannot be read (a damaged property, or a Date
    // header that is not understood) is reported as unparseable, keeping its text.
    // A wrongly typed property has no text to keep: its original is ''.
    const unreadable: unknown = [fields.clientSubmitTime, rawHeader, fields.messageDeliveryTime].find((t) => t !== undefined);
    if (unreadable !== undefined)
    {
        const original = asString(unreadable) ?? '';
        return { value: { utcMs: null, original, offsetMinutes: null, zoneKnown: false }, warnings: ['unparseable-date'] };
    }
    return { value: { utcMs: null, original: '', offsetMinutes: null, zoneKnown: false }, warnings: ['missing-date'] };
}

/**
 * A time property as an EmailDate, or null if absent or unreadable. A
 * damaged value can give "Invalid Date" or a year before 1900; both are
 * rejected by parseEmailDate.
 */
function propertyTime(text: string | undefined): EmailDate | null
{
    if (text === undefined)
    {
        return null;
    }
    const { utcMs } = parseEmailDate(text);
    if (utcMs === null)
    {
        return null;
    }
    return { utcMs, original: new Date(utcMs).toISOString(), offsetMinutes: null, zoneKnown: true };
}

/** The author(s) and, when it is someone else, the actual sender (see NormalizedMessage.sender). */
interface Senders
{
    readonly from: EmailAddress[];
    readonly sender: EmailAddress | undefined;
}

/**
 * The From mailbox and the actual sender.
 *
 * Outlook keeps two senders: "sent representing" (PidTagSentRepresenting*,
 * the mailbox the message is FROM, what an .eml From header shows) and
 * "sender" (PidTagSender*, who actually pressed Send, e.g. an assistant
 * sending on behalf of a manager). msgreader names only the sender's
 * properties (senderName, senderEmail, senderAddressType, senderSmtpAddress)
 * and PidTagSentRepresentingSmtpAddress; the other "sent representing"
 * properties are read from the raw list.
 *
 * - With a "sent representing" mailbox: it is `from`, and the sender is
 *   `sender` unless it is the same mailbox (same stored address, or same
 *   SMTP address, letter case ignored; see senderIfDifferent).
 * - Without one: the sender is `from`, and there is no `sender`.
 * - With an EMPTY "sent representing" mailbox (properties present but no
 *   name and no address): treated like the .eml "Sender without From" case,
 *   `from` stays [] and the actual sender goes to `sender`, so nothing is lost.
 * Both addresses go through the same X.500 -> SMTP fallback (smtpAddress).
 */
function readSenders(fields: FieldsData): Senders
{
    const senderEmail = asString(fields.senderEmail);
    const senderName = asString(fields.senderName);
    const representingName = rawString(fields, '0042'); // PidTagSentRepresentingName
    const representingEmail = rawString(fields, '0065'); // PidTagSentRepresentingEmailAddress

    if (representingName === undefined && representingEmail === undefined)
    {
        const mailbox = {
            name: senderName ?? '',
            address: smtpAddress(senderEmail, asString(fields.senderAddressType), [
                asString(fields.senderSmtpAddress),
                asString(fields.sentRepresentingSmtpAddress),
            ]),
        };
        return { from: nonEmptyMailbox(mailbox), sender: undefined };
    }

    const sameAsSender =
        representingEmail !== undefined && senderEmail !== undefined && representingEmail.toLowerCase() === senderEmail.toLowerCase();
    const represented = {
        name: representingName ?? (sameAsSender ? (senderName ?? '') : ''),
        // 0x0064: PidTagSentRepresentingAddressType.
        address: smtpAddress(representingEmail, rawString(fields, '0064'), [
            asString(fields.sentRepresentingSmtpAddress),
            sameAsSender ? asString(fields.senderSmtpAddress) : undefined,
        ]),
    };
    const from = nonEmptyMailbox(represented);
    // A represented mailbox with a name but no address never matches a sender
    // that has an address (no address equals ''), so that sender is then always
    // reported: this may over-report, but never loses data.
    if (sameAsSender)
    {
        return { from, sender: undefined };
    }
    const actual = {
        name: senderName ?? '',
        // Only the sender's own SMTP property: PidTagSentRepresentingSmtpAddress
        // belongs to the represented mailbox.
        address: smtpAddress(senderEmail, asString(fields.senderAddressType), [asString(fields.senderSmtpAddress)]),
    };
    return { from, sender: senderIfDifferent(actual, from) };
}

/** [mailbox], or [] if it has neither a name nor an address (an unsent draft can have no sender at all). */
function nonEmptyMailbox(mailbox: EmailAddress): EmailAddress[]
{
    return mailbox.name === '' && mailbox.address === '' ? [] : [mailbox];
}

/**
 * The To, Cc and Bcc mailboxes, in file order. Bcc recipients are usually
 * only present in a sender's own copy. A recipient of unknown type is listed
 * under To, so that no recipient is silently dropped. A recipient with
 * neither a name nor an address (only possible in a damaged file) holds
 * nothing to show and is skipped, as an empty sender is in readSenders.
 *
 * PidTagDisplayTo / DisplayCc / DisplayBcc are not read: Outlook derives
 * these name-only summaries from the recipients, which are read here.
 */
function readRecipients(fields: FieldsData): { to: EmailAddress[]; cc: EmailAddress[]; bcc: EmailAddress[] }
{
    const to: EmailAddress[] = [];
    const cc: EmailAddress[] = [];
    const bcc: EmailAddress[] = [];
    for (const recipient of fields.recipients ?? [])
    {
        // Typed as 'to' | 'cc' | 'bcc', but msgreader passes any other number through unchanged.
        const type: unknown = recipient.recipType;
        const mailbox = {
            name: asString(recipient.name) ?? '',
            address: smtpAddress(asString(recipient.email), asString(recipient.addressType), [asString(recipient.smtpAddress)]),
        };
        if (mailbox.name === '' && mailbox.address === '')
        {
            continue;
        }
        (type === 'cc' ? cc : type === 'bcc' ? bcc : to).push(mailbox);
    }
    return { to, cc, bcc };
}

/**
 * The SMTP (internet) form of an address.
 *
 * Inside an Exchange organization, Outlook stores the address as an X.500
 * name ("/O=ORG/OU=.../CN=RECIPIENTS/CN=BOB", address type "EX"), which is
 * not an email address and would never match the same person in an .eml.
 * Then the first SMTP-looking value from `fallbacks` (PidTagSenderSmtpAddress,
 * PidTagSmtpAddress, ...) is used. If there is none, the X.500 name is kept
 * as is rather than dropped: it still identifies the mailbox.
 */
function smtpAddress(email: string | undefined, addressType: string | undefined, fallbacks: (string | undefined)[]): string
{
    const isExchange = addressType?.toUpperCase() === 'EX' || email?.startsWith('/') === true;
    if (email !== undefined && email !== '' && !isExchange)
    {
        return email;
    }
    const smtp = fallbacks.find((f) => f !== undefined && f.includes('@') && !f.startsWith('/'));
    return smtp ?? email ?? '';
}

/** Body text and body warnings. */
interface MessageBody
{
    readonly text: string;
    readonly warnings: ParseWarning[];
}

/**
 * The body, in this order:
 * 1. the plain-text body (PidTagBody), if it has any text;
 * 2. otherwise the HTML body (PidTagHtml), converted by the injected
 *    `htmlToText` ('html-converted-body', plus 'html-body-truncated' if the text
 *    was cut). If the converter fails: '' with 'html-body-unreadable' (no
 *    invented text; the preview says part of the email could not be shown);
 * 3. otherwise, if there is only an RTF body (PidTagRtfCompressed): '' with
 *    'rtf-only-body'. It is not converted (no RTF reader is bundled); the
 *    text stays in the original file and the preview flags the message;
 * 4. otherwise '' with 'no-body'.
 *
 * Outlook writes line ends as CRLF. Every CRLF and every lone CR becomes LF
 * (toLfLineEndings, line-endings.ts, shared with the .eml adapter), in the
 * plain-text body and in the converted HTML alike, so the same message from
 * both formats has the same text. No character other than CR is changed
 * (README.md, rule R6).
 *
 * A body property of the wrong type (a damaged file) is NOT treated as
 * absent, since that would silently lose the message text (README.md, rule
 * R6): the file is reported as corrupt instead.
 */
function readBody(fields: FieldsData, options: MsgParserOptions): MessageBody
{
    const plain: unknown = fields.body;
    if (plain !== undefined && typeof plain !== 'string')
    {
        throw new DamagedPropertyError('plain-text body');
    }
    if (plain !== undefined && plain.trim() !== '')
    {
        return { text: toLfLineEndings(plain), warnings: [] };
    }

    const html = htmlBody(fields);
    if (html !== undefined && html.trim() !== '')
    {
        let converted: HtmlToTextResult;
        try
        {
            converted = convertHtmlBody(options.htmlToText, html);
        }
        catch (error)
        {
            // Only a converter failure becomes a warning; anything else still fails the file.
            if (!(error instanceof HtmlConversionError))
            {
                throw error;
            }
            // Even if an RTF body is also present, only 'html-body-unreadable' is
            // given: the content is flagged as missing either way.
            return { text: '', warnings: ['html-body-unreadable'] };
        }
        const text = toLfLineEndings(converted.text);
        return { text, warnings: converted.truncated ? ['html-converted-body', 'html-body-truncated'] : ['html-converted-body'] };
    }

    const rtf: unknown = fields.compressedRtf;
    if (rtf !== undefined && !(rtf instanceof Uint8Array))
    {
        throw new DamagedPropertyError('RTF body');
    }
    if (rtf !== undefined && rtf.length > 0)
    {
        return { text: '', warnings: ['rtf-only-body'] };
    }
    // A body made only of spaces and line breaks is kept as it is.
    return { text: toLfLineEndings(plain ?? ''), warnings: ['no-body'] };
}

/**
 * The HTML body as a string. Outlook normally stores it as bytes
 * (PidTagHtml, type 0102) in the message's internet code page; a few writers
 * use a Unicode string instead. Without a usable code page, UTF-8 is assumed,
 * which decodes anything (unknown bytes become U+FFFD) and is what modern
 * Outlook writes.
 */
function htmlBody(fields: FieldsData): string | undefined
{
    const text: unknown = fields.bodyHtml;
    if (text !== undefined)
    {
        if (typeof text !== 'string')
        {
            throw new DamagedPropertyError('HTML body');
        }
        return text;
    }
    const bytes: unknown = fields.html;
    if (bytes === undefined)
    {
        return undefined;
    }
    if (!(bytes instanceof Uint8Array))
    {
        throw new DamagedPropertyError('HTML body');
    }
    const encoding =
        encodingForCodepage(fields.internetCodepage) ?? encodingForCodepage(fields.messageCodepage) ?? 'utf-8';
    return new TextDecoder(encoding).decode(bytes);
}

/**
 * Metadata only (README.md, rule R4). A new object is built from plain
 * values, so the result holds no reference to msgreader's data.
 *
 * - fileName: the long file name, else the short (8.3) one, else the
 *   attachment's display name; an attached Outlook item gets its display name
 *   (usually the item's subject) plus ".msg". '' if there is none.
 * - size: the stored data size in bytes, null when the format has no single
 *   data stream (an attached Outlook item, or an attachment by reference).
 * - mimeType: the stored MIME type, else 'application/vnd.ms-outlook' for an
 *   attached Outlook item, else 'application/octet-stream'.
 *
 * An attached Outlook item (for example a message forwarded "as
 * attachment") is listed, not expanded: its own text and attachments are
 * NOT in the message's bodyText. buildMessage flags that with
 * 'forwarded-message-not-expanded'. The item is read as an email of its own
 * apart from this list (see readAttachedItems).
 */
function attachmentInfo(attachment: FieldsData): AttachmentInfo
{
    const isOutlookItem = attachment.innerMsgContent === true;
    return {
        fileName:
            nonEmpty(asString(attachment.fileName)) ??
            nonEmpty(asString(attachment.fileNameShort)) ??
            displayFileName(asString(attachment.name), isOutlookItem),
        size: typeof attachment.contentLength === 'number' ? attachment.contentLength : null,
        mimeType: nonEmpty(asString(attachment.attachMimeTag)) ?? (isOutlookItem ? OUTLOOK_ITEM_MIME_TYPE : 'application/octet-stream'),
    };
}

/**
 * The file name made from an attachment's display name: '' if there is none,
 * the name plus ".msg" for an attached Outlook item, else the name as it is.
 */
function displayFileName(displayName: string | undefined, isOutlookItem: boolean): string
{
    if (displayName === undefined || displayName === '')
    {
        return '';
    }
    return isOutlookItem ? `${displayName}.msg` : displayName;
}

function nonEmpty(text: string | undefined): string | undefined
{
    return text === undefined || text === '' ? undefined : text;
}

/**
 * A header-like property as a string, or undefined if it is absent OR of the
 * wrong type. A damaged file can give a property the wrong type tag, and
 * msgreader then hands back bytes or a number where a string belongs; such a
 * value is treated as absent rather than failing the whole file.
 */
function asString(value: unknown): string | undefined
{
    return typeof value === 'string' ? value : undefined;
}

/** A property needed for the message text has the wrong type: the file is reported as corrupt. */
class DamagedPropertyError extends Error
{
    constructor(field: string)
    {
        super(`damaged property: ${field}`);
        this.name = 'DamagedPropertyError';
    }
}

/**
 * A short, single-line message for the preview's error list. Exported for
 * unit tests.
 *
 * - A failure of the injected HTML converter keeps its own message ("HTML
 *   body could not be converted: ..."): it is not damage in the file. It is
 *   checked first, so a TypeError or RangeError from inside the converter is
 *   never mistaken for one from msgreader. (readBody already turns such a
 *   failure into the 'html-body-unreadable' warning; this is a safety net.)
 * - A TypeError ("x.trim is not a function", "Cannot read properties of
 *   undefined") or a RangeError ("Offset is outside the bounds of the
 *   DataView", from a cut-off file) is a JavaScript internal that means
 *   nothing to the user: it becomes "damaged property: <reason>".
 */
export function errorDetail(error: unknown, reason: string): string
{
    if (error instanceof HtmlConversionError)
    {
        return shortDetail(error.message);
    }
    if (error instanceof DamagedPropertyError)
    {
        return shortDetail(error.message);
    }
    if (error instanceof TypeError || error instanceof RangeError)
    {
        return shortDetail(`damaged property: ${reason}`);
    }
    return shortDetail(error instanceof Error ? error.message : String(error));
}

function shortDetail(text: string): string
{
    return text.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_LENGTH) || 'unknown error';
}
