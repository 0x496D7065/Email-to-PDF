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

import MsgReaderImport, { type FieldsData } from '@kenjiuno/msgreader';
import { encodingForCodepage } from './codepages';
import { parseEmailDate } from './date';
import { sha256Hex } from './hash';
import { convertHtmlBody, HtmlConversionError } from './html-conversion';
import type { HtmlToTextResult } from './html-to-text';
import { parseIdList, parseSingleId } from './ids';
import { senderIfDifferent } from './mailbox';
import type {
  AttachmentInfo,
  EmailAddress,
  EmailDate,
  EmailParser,
  InputFile,
  NormalizedMessage,
  ParseResult,
  ParseWarning,
} from './types';

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
export interface MsgParserOptions {
  /**
   * Converts an HTML body to plain text. Called only when the message has no
   * plain-text body but has an HTML one. It must be inert: no rendering, no
   * script execution, no loading of images or styles (README.md, rule R4).
   * Injected so that this adapter stays testable in Node without a DOM. In
   * the browser this is htmlToTextWithDomParser (html-dom.ts, see
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

/** Creates the .msg parser. `htmlToText` is injected, see MsgParserOptions. */
export function createMsgParser(options: MsgParserOptions): EmailParser {
  return { parse: (file) => parseMsg(file, options) };
}

/** Parses one .msg file. Never throws: any failure becomes a 'corrupt' result. */
async function parseMsg(file: InputFile, options: MsgParserOptions): Promise<ParseResult> {
  // Hash first, so even a file that fails to parse is listed with its hash.
  let sha256: string | null = null;
  try {
    sha256 = await sha256Hex(file.bytes);
    const fields = readFields(file.bytes);
    return resultFromFields(fields, file.name, sha256, options);
  } catch (error) {
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
 */
export function resultFromFields(
  fields: FieldsData,
  fileName: string,
  sha256: string,
  options: MsgParserOptions,
): ParseResult {
  const corrupt = (detail: string): ParseResult => ({ ok: false, error: 'corrupt', detail, fileName, sha256 });
  try {
    if (fields.error !== undefined) return corrupt(shortDetail(String(fields.error)));
    if (!looksLikeMessage(fields)) return corrupt('not an Outlook message: no message properties found');
    return { ok: true, message: buildMessage(fields, fileName, sha256, options) };
  } catch (error) {
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
 */
function readFields(bytes: Uint8Array): FieldsData {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const first = new MsgReader(view);
  first.parserConfig = { includeRawProps: true };
  const fields = first.getFileData();
  if (fields.error !== undefined || !hasAnsiStrings(fields)) return fields;

  // PidTagMessageCodepage is the code page of the 8-bit strings;
  // PidTagInternetCodepage (the body's code page) is the next best hint.
  const encoding =
    encodingForCodepage(fields.messageCodepage) ??
    encodingForCodepage(fields.internetCodepage) ??
    FALLBACK_ANSI_ENCODING;
  const second = new MsgReader(view);
  second.parserConfig = { includeRawProps: true, ansiEncoding: encoding };
  return second.getFileData();
}

/** True if the message, a recipient or an attachment has an 8-bit string property. */
function hasAnsiStrings(fields: FieldsData): boolean {
  const all = [fields, ...(fields.recipients ?? []), ...(fields.attachments ?? [])];
  return all.some((f) => (f.rawProps ?? []).some((p) => p.propertyTag?.endsWith('001e') === true));
}

/**
 * A Compound File that is not an Outlook item (for example a renamed Word
 * .doc) parses without error but has none of the message properties.
 */
function looksLikeMessage(fields: FieldsData): boolean {
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

/** Copies what we need out of msgreader's result into a NormalizedMessage. */
function buildMessage(
  fields: FieldsData,
  fileName: string,
  sha256: string,
  options: MsgParserOptions,
): NormalizedMessage {
  const headers = asString(fields.headers) ?? '';
  const messageId = parseSingleId(asString(fields.messageId) ?? headerValue(headers, 'message-id'));
  const date = readDate(fields, headers);
  const body = readBody(fields, options);
  const attachments = fields.attachments ?? [];
  const senders = readSenders(fields);

  const warnings: ParseWarning[] = [...date.warnings, ...body.warnings];
  if (messageId === null) warnings.push('missing-message-id');
  // Like the .eml adapter: an attached e-mail whose text is not part of
  // bodyText is flagged, so the preview can say that some text is missing.
  if (attachments.some((a) => a.innerMsgContent === true)) warnings.push('forwarded-message-not-expanded');

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
    source: { fileName, sha256, kind: 'msg' },
    warnings,
  };
}

/** A string property from msgreader's raw list, by its 4-hex-digit id (Unicode or 8-bit). */
function rawString(fields: FieldsData, propId: string): string | undefined {
  const tags = [`${propId}001f`, `${propId}001e`];
  const prop = (fields.rawProps ?? []).find((p) => p.propertyTag !== undefined && tags.includes(p.propertyTag));
  return typeof prop?.value === 'string' ? prop.value : undefined;
}

/**
 * The first header `name` (lower case) in PidTagTransportMessageHeaders: the
 * internet headers a RECEIVED message arrived with. Folded lines are joined.
 * undefined if absent (a message saved from the Sent folder has none).
 */
function headerValue(headers: string, name: string): string | undefined {
  const lines = headers.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line === '') return undefined; // end of the header block
    const colon = line.indexOf(':');
    if (colon <= 0 || line.slice(0, colon).trim().toLowerCase() !== name) continue;
    let value = line.slice(colon + 1);
    // Continuation lines start with a space or tab (RFC 5322 folding).
    while (/^[ \t]/.test(lines[i + 1] ?? '')) value += ` ${(lines[++i] ?? '').trim()}`;
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
function readDate(fields: FieldsData, headers: string): { value: EmailDate; warnings: ParseWarning[] } {
  const rawHeader = headerValue(headers, 'date');
  const header = rawHeader === undefined ? null : parseEmailDate(rawHeader);
  const submitted = propertyTime(asString(fields.clientSubmitTime));
  const delivered = propertyTime(asString(fields.messageDeliveryTime));

  if (submitted !== null) {
    if (header !== null && header.zoneKnown && header.utcMs === submitted.utcMs) {
      return { value: header, warnings: [] };
    }
    return { value: submitted, warnings: [] };
  }
  if (header !== null && header.utcMs !== null) {
    // Read as UTC for sorting only if the zone is unknown: the preview flags it.
    return { value: header, warnings: header.zoneKnown ? [] : ['unknown-time-zone'] };
  }
  if (delivered !== null) return { value: delivered, warnings: [] };

  // A time that exists but cannot be read (a damaged property, or a Date
  // header that is not understood) is reported as unparseable, keeping its text.
  // A wrongly typed property has no text to keep: its original is ''.
  const unreadable: unknown = [fields.clientSubmitTime, rawHeader, fields.messageDeliveryTime].find((t) => t !== undefined);
  if (unreadable !== undefined) {
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
function propertyTime(text: string | undefined): EmailDate | null {
  if (text === undefined) return null;
  const { utcMs } = parseEmailDate(text);
  if (utcMs === null) return null;
  return { utcMs, original: new Date(utcMs).toISOString(), offsetMinutes: null, zoneKnown: true };
}

/** The author(s) and, when it is someone else, the actual sender (see NormalizedMessage.sender). */
interface Senders {
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
function readSenders(fields: FieldsData): Senders {
  const senderEmail = asString(fields.senderEmail);
  const senderName = asString(fields.senderName);
  const repName = rawString(fields, '0042'); // PidTagSentRepresentingName
  const repEmail = rawString(fields, '0065'); // PidTagSentRepresentingEmailAddress

  if (repName === undefined && repEmail === undefined) {
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
    repEmail !== undefined && senderEmail !== undefined && repEmail.toLowerCase() === senderEmail.toLowerCase();
  const represented = {
    name: repName ?? (sameAsSender ? (senderName ?? '') : ''),
    // 0x0064: PidTagSentRepresentingAddressType.
    address: smtpAddress(repEmail, rawString(fields, '0064'), [
      asString(fields.sentRepresentingSmtpAddress),
      sameAsSender ? asString(fields.senderSmtpAddress) : undefined,
    ]),
  };
  const from = nonEmptyMailbox(represented);
  // A represented mailbox with a name but no address never matches a sender
  // that has an address (no address equals ''), so that sender is then always
  // reported: this may over-report, but never loses data.
  if (sameAsSender) return { from, sender: undefined };
  const actual = {
    name: senderName ?? '',
    // Only the sender's own SMTP property: PidTagSentRepresentingSmtpAddress
    // belongs to the represented mailbox.
    address: smtpAddress(senderEmail, asString(fields.senderAddressType), [asString(fields.senderSmtpAddress)]),
  };
  return { from, sender: senderIfDifferent(actual, from) };
}

/** [mailbox], or [] if it has neither a name nor an address (an unsent draft can have no sender at all). */
function nonEmptyMailbox(mailbox: EmailAddress): EmailAddress[] {
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
function readRecipients(fields: FieldsData): { to: EmailAddress[]; cc: EmailAddress[]; bcc: EmailAddress[] } {
  const to: EmailAddress[] = [];
  const cc: EmailAddress[] = [];
  const bcc: EmailAddress[] = [];
  for (const recipient of fields.recipients ?? []) {
    // Typed as 'to' | 'cc' | 'bcc', but msgreader passes any other number through unchanged.
    const type: unknown = recipient.recipType;
    const mailbox = {
      name: asString(recipient.name) ?? '',
      address: smtpAddress(asString(recipient.email), asString(recipient.addressType), [asString(recipient.smtpAddress)]),
    };
    if (mailbox.name === '' && mailbox.address === '') continue;
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
function smtpAddress(email: string | undefined, addressType: string | undefined, fallbacks: (string | undefined)[]): string {
  const isExchange = addressType?.toUpperCase() === 'EX' || email?.startsWith('/') === true;
  if (email !== undefined && email !== '' && !isExchange) return email;
  const smtp = fallbacks.find((f) => f !== undefined && f.includes('@') && !f.startsWith('/'));
  return smtp ?? email ?? '';
}

/** Body text and body warnings. */
interface MessageBody {
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
 * Outlook writes line ends as CRLF. They become LF, as in the .eml adapter,
 * so the same message from both formats has the same text; no other
 * character is changed.
 *
 * A body property of the wrong type (a damaged file) is NOT treated as
 * absent, since that would silently lose the message text (README.md, rule
 * R6): the file is reported as corrupt instead.
 */
function readBody(fields: FieldsData, options: MsgParserOptions): MessageBody {
  const plain: unknown = fields.body;
  if (plain !== undefined && typeof plain !== 'string') throw new DamagedPropertyError('plain-text body');
  if (plain !== undefined && plain.trim() !== '') return { text: plain.replace(/\r\n/g, '\n'), warnings: [] };

  const html = htmlBody(fields);
  if (html !== undefined && html.trim() !== '') {
    let converted: HtmlToTextResult;
    try {
      converted = convertHtmlBody(options.htmlToText, html);
    } catch (error) {
      // Only a converter failure becomes a warning; anything else still fails the file.
      if (!(error instanceof HtmlConversionError)) throw error;
      // Even if an RTF body is also present, only 'html-body-unreadable' is
      // given: the content is flagged as missing either way.
      return { text: '', warnings: ['html-body-unreadable'] };
    }
    return { text: converted.text, warnings: converted.truncated ? ['html-converted-body', 'html-body-truncated'] : ['html-converted-body'] };
  }

  const rtf: unknown = fields.compressedRtf;
  if (rtf !== undefined && !(rtf instanceof Uint8Array)) throw new DamagedPropertyError('RTF body');
  if (rtf !== undefined && rtf.length > 0) {
    return { text: '', warnings: ['rtf-only-body'] };
  }
  // A body made only of spaces and line breaks is kept as it is.
  return { text: (plain ?? '').replace(/\r\n/g, '\n'), warnings: ['no-body'] };
}

/**
 * The HTML body as a string. Outlook normally stores it as bytes
 * (PidTagHtml, type 0102) in the message's internet code page; a few writers
 * use a Unicode string instead. Without a usable code page, UTF-8 is assumed,
 * which decodes anything (unknown bytes become U+FFFD) and is what modern
 * Outlook writes.
 */
function htmlBody(fields: FieldsData): string | undefined {
  const text: unknown = fields.bodyHtml;
  if (text !== undefined) {
    if (typeof text !== 'string') throw new DamagedPropertyError('HTML body');
    return text;
  }
  const bytes: unknown = fields.html;
  if (bytes === undefined) return undefined;
  if (!(bytes instanceof Uint8Array)) throw new DamagedPropertyError('HTML body');
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
 * attachment") is listed, not expanded: its own text and attachments are not
 * read here, so they are NOT in the message's bodyText. buildMessage flags
 * that with 'forwarded-message-not-expanded'.
 */
function attachmentInfo(attachment: FieldsData): AttachmentInfo {
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
function displayFileName(displayName: string | undefined, isOutlookItem: boolean): string {
  if (displayName === undefined || displayName === '') return '';
  return isOutlookItem ? `${displayName}.msg` : displayName;
}

function nonEmpty(text: string | undefined): string | undefined {
  return text === undefined || text === '' ? undefined : text;
}

/**
 * A header-like property as a string, or undefined if it is absent OR of the
 * wrong type. A damaged file can give a property the wrong type tag, and
 * msgreader then hands back bytes or a number where a string belongs; such a
 * value is treated as absent rather than failing the whole file.
 */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** A property needed for the message text has the wrong type: the file is reported as corrupt. */
class DamagedPropertyError extends Error {
  constructor(field: string) {
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
export function errorDetail(error: unknown, reason: string): string {
  if (error instanceof HtmlConversionError) return shortDetail(error.message);
  if (error instanceof DamagedPropertyError) return shortDetail(error.message);
  if (error instanceof TypeError || error instanceof RangeError) return shortDetail(`damaged property: ${reason}`);
  return shortDetail(error instanceof Error ? error.message : String(error));
}

function shortDetail(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_LENGTH) || 'unknown error';
}
