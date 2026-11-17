// Test-only builder for SYNTHETIC Outlook .msg files (README.md, rule R7).
//
// A .msg file is a "Compound File" (a small file system inside one file):
// every MAPI property is a stream named "__substg1.0_<TAG><TYPE>", fixed-size
// properties (times, numbers) sit in one "__properties_version1.0" stream, and
// each recipient / attachment is a sub-folder with the same layout
// ([MS-OXMSG] sections 2.1-2.4). We write that layout with msgreader's own
// writer (`burn`), entirely in memory, from the plain TypeScript specs in
// specs.ts. No opaque binary fixture is committed: the specs ARE the fixtures.
//
// Synthetic marker: every built file carries a string property with id
// SYNTHETIC_MARKER_PROP_ID = 0x6800 (from the "message class-defined" range,
// which msgreader does not map to a name), type 001F (or 001E for ANSI
// specs), with the value "X-Synthetic-Fixture: true": the same text as the
// header every .eml fixture carries. Read it back with
// `parserConfig.includeRawProps = true`: it shows up in `rawProps` with a
// propertyTag starting with "6800".

import { burn, type Entry } from '@kenjiuno/msgreader/lib/Burner';
import { TypeEnum } from '@kenjiuno/msgreader/lib/Reader';

/** Property id (first 4 hex digits of msgreader's rawProps propertyTag) of the synthetic marker. */
export const SYNTHETIC_MARKER_PROP_ID = '6800';
export const SYNTHETIC_MARKER_VALUE = 'X-Synthetic-Fixture: true';

export interface MsgMailboxSpec {
    readonly name: string;
    /** SMTP address. Always a *.test / *.invalid domain. */
    readonly smtp: string;
    /**
     * Exchange X.500 distinguished name. When set, the mailbox is written the
     * way classic Outlook writes internal Exchange users: address type "EX",
     * the X.500 DN as the address, and the SMTP address only as a separate
     * fallback property (sender: 0x5D01, recipient: 0x39FE).
     */
    readonly exchangeDn?: string;
    /**
     * Only with `exchangeDn`: false leaves out the separate SMTP property, so
     * the X.500 DN is the only address in the file. Default: written.
     */
    readonly smtpFallback?: boolean;
}

export interface MsgRecipientSpec extends MsgMailboxSpec {
    readonly type: 'to' | 'cc' | 'bcc';
}

export interface MsgAttachmentSpec {
    readonly fileName: string;
    /** PR_ATTACH_MIME_TAG (0x370E). Omit to leave the property out. */
    readonly mimeType?: string;
    /** ASCII text content (kept tiny and readable). */
    readonly content: string;
}

export interface MsgSpec {
    /** Stable id, used as the fixture id in manifest.ts and as "<id>.msg" file name. */
    readonly id: string;
    readonly description: string;
    /**
     * How string properties are stored:
     * - 'unicode': PT_UNICODE (type 001F, UTF-16LE), like every modern Outlook.
     * - 'ansi-1252': PT_STRING8 (type 001E, 8-bit) in code page 1252, with
     *   PR_MESSAGE_CODEPAGE (0x3FFD) = 1252. Characters must be in U+0000-U+00FF
     *   but NOT U+0080-U+009F: Node's TextDecoder maps those bytes to control
     *   characters while browsers map them to symbols such as the euro sign.
     */
    readonly strings: 'unicode' | 'ansi-1252';
    /** PR_MESSAGE_CLASS (0x001A). Default 'IPM.Note'; null leaves the property out. */
    readonly messageClass?: string | null;
    readonly subject: string;
    /** The actual sender (PR_SENDER_*: who pressed Send). */
    readonly sender: MsgMailboxSpec;
    /**
     * The mailbox the message is sent on behalf of (PR_SENT_REPRESENTING_*:
     * name 0x0042, address type 0x0064, address 0x0065, SMTP fallback 0x5D02).
     * Omit to leave all four out, as for a message sent from one's own mailbox
     * by a writer that does not repeat the sender there.
     */
    readonly sentRepresenting?: MsgMailboxSpec;
    readonly recipients: readonly MsgRecipientSpec[];
    /** Plain-text body with "\n" line ends; written with "\r\n" like Outlook does. */
    readonly bodyText?: string;
    /** HTML body, stored as PR_HTML (0x10130102, binary) in UTF-8. */
    readonly bodyHtml?: string;
    /** PR_CLIENT_SUBMIT_TIME (sent time), ISO-8601 with "Z". Omit for "no sent time". */
    readonly submitTime?: string;
    /** PR_MESSAGE_DELIVERY_TIME (received time), ISO-8601 with "Z". */
    readonly deliveryTime?: string;
    /** Header form, with < >. PR_INTERNET_MESSAGE_ID (0x1035). */
    readonly messageId?: string;
    /** Header form, with < >. PR_IN_REPLY_TO_ID (0x1042), not named by msgreader: read it from rawProps. */
    readonly inReplyTo?: string;
    /** Header form, "<a> <b>". PR_INTERNET_REFERENCES (0x1039), not named by msgreader: read it from rawProps. */
    readonly references?: string;
    /** PR_TRANSPORT_MESSAGE_HEADERS (0x007D): the internet headers of a received message. */
    readonly transportHeaders?: string;
    readonly attachments?: readonly MsgAttachmentSpec[];
    /**
     * Outlook items attached as items (ATTACH_EMBEDDED_MSG), written after
     * `attachments`, each with a display name on the attachment. See
     * MsgAttachedItemSpec for the inner message.
     */
    readonly attachedItems?: readonly MsgAttachedItemSpec[];
    /**
     * ASCII RTF text, stored as PR_RTF_COMPRESSED (0x10090102) in its
     * "uncompressed" container form (compression type "MELA", see
     * [MS-OXRTFCP]). Combine with no bodyText/bodyHtml for an RTF-only message.
     */
    readonly bodyRtf?: string;
    /**
     * Overrides the code page properties: `message` = PR_MESSAGE_CODEPAGE
     * (0x3FFD), `internet` = PR_INTERNET_CPID (0x3FDE); null leaves the property
     * out. The string bytes do not change: for 'ansi-1252' specs each character
     * is still written as its Latin-1 byte, so a test can check how a reader
     * decodes those bytes under another code page.
     */
    readonly codepages?: { readonly message?: number | null; readonly internet?: number | null };
    /** Extra top-level string properties, e.g. PR_SENT_REPRESENTING_NAME (0x0042). Typed by `strings`. */
    readonly extraStrings?: readonly { readonly propId: number; readonly value: string }[];
    /**
     * Extra top-level binary (type 0102) properties. Writing a property that
     * should be a string as binary imitates a damaged file: msgreader then
     * returns bytes where a string belongs (e.g. 0x1000, the plain-text body).
     */
    readonly extraBinaries?: readonly { readonly propId: number; readonly bytes: Uint8Array }[];
}

/**
 * One attached Outlook item:
 * - with `subject`: a tiny inner message that has only a message class and
 *   that subject (its properties stream holds no fixed-size property);
 * - with `message`: a full inner message written from that spec exactly like
 *   a top-level one (its own string mode, recipients, attachments and
 *   attached items, so items can nest), except that its properties stream
 *   has the 24-byte header of an embedded message ([MS-OXMSG] 2.4.1,
 *   "embedded message object storage").
 *   The spec's `id` and `description` are not written.
 */
export type MsgAttachedItemSpec =
    | { readonly displayName: string; readonly subject: string }
    | { readonly displayName: string; readonly message: MsgSpec };

// ---------------------------------------------------------------- encoding

function utf16le(text: string): Uint8Array
{
    const bytes = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++)
    {
        const code = text.charCodeAt(i);
        bytes[2 * i] = code & 0xff;
        bytes[2 * i + 1] = code >> 8;
    }
    return bytes;
}

/** Code page 1252, restricted to the range where it equals Latin-1 and Node agrees with browsers. */
function cp1252(text: string): Uint8Array
{
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++)
    {
        const code = text.charCodeAt(i);
        if (code > 0xff || (code >= 0x80 && code <= 0x9f))
        {
            throw new Error(`character U+${code.toString(16)} not allowed in an ansi-1252 fixture`);
        }
        bytes[i] = code;
    }
    return bytes;
}

/** Plain 7-bit ASCII bytes (attachment contents); throws on any character above 0x7F. */
function ascii(text: string): Uint8Array
{
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++)
    {
        const code = text.charCodeAt(i);
        if (code > 0x7f) throw new Error(`character U+${code.toString(16)} not allowed in an ASCII attachment`);
        bytes[i] = code;
    }
    return bytes;
}

/**
 * RTF in the "uncompressed" PR_RTF_COMPRESSED container ([MS-OXRTFCP],
 * header section): COMPSIZE, RAWSIZE, COMPTYPE "MELA" (0x414C454D), CRC 0,
 * then the RTF bytes as they are.
 */
function uncompressedRtf(rtf: string): Uint8Array
{
    const raw = ascii(rtf);
    const out = new Uint8Array(16 + raw.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, out.length - 4, true); // COMPSIZE: everything after this field
    view.setUint32(4, raw.length, true); // RAWSIZE
    view.setUint32(8, 0x414c454d, true); // COMPTYPE "MELA" = not compressed
    view.setUint32(12, 0, true); // CRC: always 0 for MELA
    out.set(raw, 16);
    return out;
}

function utf8(text: string): Uint8Array
{
    return new TextEncoder().encode(text);
}

/** Milliseconds since 1970 -> Windows FILETIME (100 ns units since 1601), as 8 little-endian bytes. */
function fileTime(iso: string): Uint8Array
{
    const ms = Date.parse(iso);
    if (Number.isNaN(ms) || !iso.endsWith('Z')) throw new Error(`bad ISO UTC time: ${iso}`);
    const ticks = (BigInt(ms) + 11_644_473_600_000n) * 10_000n;
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, ticks, true);
    return out;
}

function int32(value: number): Uint8Array
{
    const out = new Uint8Array(8); // fixed-size slot is always 8 bytes
    new DataView(out.buffer).setUint32(0, value, true);
    return out;
}

/** A fixed-size property for a __properties_version1.0 stream. */
interface FixedProp {
    readonly tag: number;
    readonly value: Uint8Array;
}

/**
 * __properties_version1.0: a header (32 bytes for the top-level message,
 * 24 for an attached Outlook item's message, 8 for recipients/attachments),
 * then one 16-byte entry per property: tag, flags, 8-byte value
 * ([MS-OXMSG] 2.4).
 */
function propertiesStream(headerSize: 8 | 24 | 32, props: readonly FixedProp[], counts?: { recipients: number; attachments: number }): Uint8Array
{
    const out = new Uint8Array(headerSize + 16 * props.length);
    const view = new DataView(out.buffer);
    // The 24-byte header of an embedded message has the same four counts at
    // the same offsets ([MS-OXMSG] 2.4.1).
    if (headerSize !== 8 && counts)
    {
        view.setUint32(8, counts.recipients, true); // next recipient id
        view.setUint32(12, counts.attachments, true); // next attachment id
        view.setUint32(16, counts.recipients, true); // recipient count
        view.setUint32(20, counts.attachments, true); // attachment count
    }
    props.forEach((prop, i) =>
    {
        const at = headerSize + 16 * i;
        view.setUint32(at, prop.tag, true);
        view.setUint32(at + 4, 0x6, true); // PROPATTR_READABLE | PROPATTR_WRITABLE
        out.set(prop.value.subarray(0, 8), at + 8);
    });
    return out;
}

// ---------------------------------------------------------------- folders

/** One folder of the compound file: named streams and sub-folders. */
interface Folder {
    readonly streams: Map<string, Uint8Array>;
    readonly folders: Map<string, Folder>;
}

function newFolder(): Folder
{
    return { streams: new Map(), folders: new Map() };
}

function hex4(n: number): string
{
    return n.toString(16).toUpperCase().padStart(4, '0');
}

/** Adds a string property, typed by the spec's string mode. */
function putString(folder: Folder, mode: MsgSpec['strings'], propId: number, text: string): void
{
    if (mode === 'unicode') folder.streams.set(`__substg1.0_${hex4(propId)}001F`, utf16le(text));
    else folder.streams.set(`__substg1.0_${hex4(propId)}001E`, cp1252(text));
}

function putBinary(folder: Folder, propId: number, bytes: Uint8Array): void
{
    folder.streams.set(`__substg1.0_${hex4(propId)}0102`, bytes);
}

/** Flattens the folder tree into burn()'s entry list (index 0 = Root Entry). */
function toEntries(root: Folder): Entry[]
{
    const entries: Entry[] = [{ name: 'Root Entry', type: TypeEnum.ROOT, children: [], length: 0 }];
    const add = (folder: Folder, index: number): void =>
    {
        for (const [name, bytes] of folder.streams)
        {
            entries[index]?.children?.push(entries.length);
            entries.push({ name, type: TypeEnum.DOCUMENT, binaryProvider: () => bytes, length: bytes.length });
        }
        for (const [name, sub] of folder.folders)
        {
            const subIndex = entries.length;
            entries[index]?.children?.push(subIndex);
            entries.push({ name, type: TypeEnum.DIRECTORY, children: [], length: 0 });
            add(sub, subIndex);
        }
    };
    add(root, 0);
    return entries;
}

// ---------------------------------------------------------------- builder

const CODEPAGE_UTF8 = 65001;
const CODEPAGE_1252 = 1252;

/** Builds the bytes of one synthetic .msg file from its spec. */
export function buildMsg(spec: MsgSpec): Uint8Array
{
    const root = newFolder();
    writeMessage(root, spec, 32);
    return burn(toEntries(root));
}

/**
 * Writes one message into `root`: the file's own message (headerSize 32) or
 * the inner message of an attached Outlook item (headerSize 24).
 */
function writeMessage(root: Folder, spec: MsgSpec, headerSize: 24 | 32): void
{
    const mode = spec.strings;
    const fixed: FixedProp[] = [];

    if (spec.messageClass !== null) putString(root, mode, 0x001a, spec.messageClass ?? 'IPM.Note'); // message class
    putString(root, mode, 0x0037, spec.subject);
    putString(root, mode, 0x6800, SYNTHETIC_MARKER_VALUE); // synthetic marker (see top of file)

    // Sender (PR_SENDER_*). Exchange users: type "EX" + X.500 DN, SMTP as fallback.
    putString(root, mode, 0x0c1a, spec.sender.name);
    putString(root, mode, 0x0c1e, spec.sender.exchangeDn ? 'EX' : 'SMTP');
    putString(root, mode, 0x0c1f, spec.sender.exchangeDn ?? spec.sender.smtp);
    if (spec.sender.exchangeDn && spec.sender.smtpFallback !== false) putString(root, mode, 0x5d01, spec.sender.smtp);
    // Sent representing (PR_SENT_REPRESENTING_*), same layout as the sender.
    const represented = spec.sentRepresenting;
    if (represented !== undefined)
    {
        putString(root, mode, 0x0042, represented.name);
        putString(root, mode, 0x0064, represented.exchangeDn ? 'EX' : 'SMTP');
        putString(root, mode, 0x0065, represented.exchangeDn ?? represented.smtp);
        if (represented.exchangeDn && represented.smtpFallback !== false) putString(root, mode, 0x5d02, represented.smtp);
    }
    for (const extra of spec.extraStrings ?? []) putString(root, mode, extra.propId, extra.value);
    for (const extra of spec.extraBinaries ?? []) putBinary(root, extra.propId, extra.bytes);

    if (spec.bodyText !== undefined) putString(root, mode, 0x1000, spec.bodyText.replace(/\r?\n/g, '\r\n'));
    if (spec.bodyHtml !== undefined)
    {
        if (mode !== 'unicode') throw new Error('bodyHtml is only supported for unicode specs');
        putBinary(root, 0x1013, utf8(spec.bodyHtml));
    }
    if (spec.messageId !== undefined) putString(root, mode, 0x1035, spec.messageId);
    if (spec.inReplyTo !== undefined) putString(root, mode, 0x1042, spec.inReplyTo);
    if (spec.references !== undefined) putString(root, mode, 0x1039, spec.references);
    if (spec.transportHeaders !== undefined) putString(root, mode, 0x007d, spec.transportHeaders.replace(/\r?\n/g, '\r\n'));

    if (spec.bodyRtf !== undefined) putBinary(root, 0x1009, uncompressedRtf(spec.bodyRtf));

    if (spec.submitTime !== undefined) fixed.push({ tag: 0x00390040, value: fileTime(spec.submitTime) });
    if (spec.deliveryTime !== undefined) fixed.push({ tag: 0x0e060040, value: fileTime(spec.deliveryTime) });
    const messageCodepage = spec.codepages?.message !== undefined ? spec.codepages.message : mode === 'ansi-1252' ? CODEPAGE_1252 : null;
    const internetCodepage = spec.codepages?.internet !== undefined ? spec.codepages.internet : mode === 'unicode' ? CODEPAGE_UTF8 : CODEPAGE_1252;
    if (messageCodepage !== null) fixed.push({ tag: 0x3ffd0003, value: int32(messageCodepage) }); // PR_MESSAGE_CODEPAGE
    if (internetCodepage !== null) fixed.push({ tag: 0x3fde0003, value: int32(internetCodepage) }); // PR_INTERNET_CPID

    spec.recipients.forEach((recipient, i) =>
    {
        const folder = newFolder();
        putString(folder, mode, 0x3001, recipient.name);
        putString(folder, mode, 0x3002, recipient.exchangeDn ? 'EX' : 'SMTP');
        putString(folder, mode, 0x3003, recipient.exchangeDn ?? recipient.smtp);
        if (recipient.exchangeDn && recipient.smtpFallback !== false) putString(folder, mode, 0x39fe, recipient.smtp);
        folder.streams.set(
            '__properties_version1.0',
            propertiesStream(8, [
                { tag: 0x0c150003, value: int32({ to: 1, cc: 2, bcc: 3 }[recipient.type]) }, // PR_RECIPIENT_TYPE
                { tag: 0x30000003, value: int32(i) }, // PR_ROWID
            ]),
        );
        root.folders.set(`__recip_version1.0_#${i.toString(16).toUpperCase().padStart(8, '0')}`, folder);
    });

    const attachments = spec.attachments ?? [];
    attachments.forEach((attachment, i) =>
    {
        const folder = newFolder();
        const data = ascii(attachment.content);
        putString(folder, mode, 0x3707, attachment.fileName); // long file name
        putString(folder, mode, 0x3704, attachment.fileName); // short file name (same, kept simple)
        putString(folder, mode, 0x3703, /\.[^.]*$/.exec(attachment.fileName)?.[0] ?? ''); // extension: last one only (a.b.txt -> .txt)
        if (attachment.mimeType !== undefined) putString(folder, mode, 0x370e, attachment.mimeType);
        putBinary(folder, 0x3701, data);
        folder.streams.set(
            '__properties_version1.0',
            propertiesStream(8, [
                { tag: 0x37050003, value: int32(1) }, // PR_ATTACH_METHOD = ATTACH_BY_VALUE
                { tag: 0x0e200003, value: int32(data.length) }, // PR_ATTACH_SIZE (simplified: data size)
                { tag: 0x0e210003, value: int32(i) }, // PR_ATTACH_NUM
            ]),
        );
        root.folders.set(`__attach_version1.0_#${i.toString(16).toUpperCase().padStart(8, '0')}`, folder);
    });

    // Attached Outlook items: the attachment folder holds the inner message as
    // a sub-folder "__substg1.0_3701000D" (type 000D = object), see
    // [MS-OXMSG] "Embedded Message Object Storage".
    const items = spec.attachedItems ?? [];
    items.forEach((item, j) =>
    {
        const i = attachments.length + j;
        const folder = newFolder();
        putString(folder, mode, 0x3001, item.displayName); // PR_DISPLAY_NAME
        const inner = newFolder();
        if ('message' in item)
        {
            writeMessage(inner, item.message, 24);
        }
        else
        {
            putString(inner, mode, 0x001a, 'IPM.Note');
            putString(inner, mode, 0x0037, item.subject);
            inner.streams.set('__properties_version1.0', propertiesStream(24, []));
        }
        folder.folders.set('__substg1.0_3701000D', inner);
        folder.streams.set(
            '__properties_version1.0',
            propertiesStream(8, [
                { tag: 0x37050003, value: int32(5) }, // PR_ATTACH_METHOD = ATTACH_EMBEDDED_MSG
                { tag: 0x0e210003, value: int32(i) }, // PR_ATTACH_NUM
            ]),
        );
        root.folders.set(`__attach_version1.0_#${i.toString(16).toUpperCase().padStart(8, '0')}`, folder);
    });

    const attachmentCount = attachments.length + items.length;
    root.streams.set(
        '__properties_version1.0',
        propertiesStream(headerSize, fixed, { recipients: spec.recipients.length, attachments: attachmentCount }),
    );
}

/** The built bytes as the DataView/ArrayBuffer form msgreader's constructor accepts. */
export function buildMsgView(spec: MsgSpec): DataView
{
    const bytes = buildMsg(spec);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
