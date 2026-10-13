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
//   The one exception is an inline forwarded message (message/rfc822 without
//   "Content-Disposition: attachment"): its bytes are parsed again as an email
//   so its text can join the body, then dropped.

import { addressParser, decodeWords, type Address, type Attachment, type Email, type PostalMimeOptions } from 'postal-mime';
import { parseEmailDate } from './date';
import { parseEmlTree, PostalMimeInternalsError, type EmlPart, type EmlTree } from './eml-tree';
import { sha256Hex } from './hash';
import { convertHtmlBody } from './html-conversion';
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

/** What the .eml adapter needs from outside. */
export interface EmlParserOptions {
  /**
   * Converts an HTML body part to plain text. Called once for every HTML part
   * whose text goes into the body: an HTML part in multipart/mixed (or
   * related, or any multipart other than alternative), and the HTML of the
   * first version holding HTML of a multipart/alternative in which no version
   * is plain only (plain text and no HTML; whitespace-only text does not
   * count), see alternativeHtmlVersion. Inline forwarded messages follow the
   * same rules. It must be
   * inert: no rendering, no script execution, no loading of images or styles
   * (README.md, rule R4). Injected so that this adapter stays testable in Node
   * without a DOM. In the browser this is htmlToTextWithDomParser
   * (html-dom.ts, see browser-parsers.ts).
   *
   * It returns the text and whether it was cut at the converter's length
   * limit; a cut adds the 'html-body-truncated' warning. If it throws or
   * returns anything else, the file is reported as 'corrupt' with the detail
   * "HTML body could not be converted: ...", never as a damaged file.
   */
  readonly htmlToText: (html: string) => HtmlToTextResult;
}

// postal-mime's built-in safety limits (README.md, rule R4: guard against
// malformed or hostile files). Exceeding them makes postal-mime reject the
// file, which we report as 'corrupt'. Real mail stays far below all of them;
// the file size itself is limited before parsing. Each inline forwarded
// message is parsed again with the same limits.
const POSTAL_MIME_OPTIONS: PostalMimeOptions = {
  // Multipart inside multipart...: real mail rarely goes past 10 levels.
  maxNestingDepth: 64,
  // Total header bytes across all parts (postal-mime's default, 2 MiB).
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
  // inline forwarded message, parse it again).
  attachmentEncoding: 'arraybuffer',
};

/**
 * How many levels of inline forwarded messages are expanded into the body.
 * Deeper ones are listed as attachments with a 'forwarded-message-not-expanded'
 * warning: their text stays in the original file, nothing is lost silently.
 */
const MAX_FORWARD_DEPTH = 5;

/**
 * How many inline forwarded messages are expanded per file, all levels
 * together. Each one is a full parse of its bytes, so this bounds the work a
 * hostile file can cause. The rest are listed as attachments with a
 * 'forwarded-message-not-expanded' warning.
 */
const MAX_EXPANDED_FORWARDS = 200;

/** Expansions still allowed for the file being parsed (see MAX_EXPANDED_FORWARDS). */
interface ForwardBudget {
  remaining: number;
}

/** The line that starts each expanded forwarded message in bodyText. */
const FORWARDED_SEPARATOR = '---------- Forwarded message ----------';

/** MIME types that mark a delivery or feedback report (a bounce, an abuse report). */
const REPORT_TYPES: ReadonlySet<string> = new Set(['message/delivery-status', 'message/feedback-report']);

/** Longest error detail kept for the preview's error list. */
const MAX_DETAIL_LENGTH = 200;

/** Creates the .eml parser. `htmlToText` is injected, see EmlParserOptions. */
export function createEmlParser(options: EmlParserOptions): EmailParser {
  return { parse: (file) => parseEml(file, options) };
}

/** Parses one .eml file. Never throws: any failure becomes a 'corrupt' result. */
async function parseEml(file: InputFile, options: EmlParserOptions): Promise<ParseResult> {
  // Hash first, so even a file that fails to parse is listed with its hash.
  let sha256: string | null = null;
  try {
    sha256 = await sha256Hex(file.bytes);
    const tree = await parseEmlTree(file.bytes, POSTAL_MIME_OPTIONS);
    const message = await buildMessage(tree, file.name, sha256, options);
    return { ok: true, message };
  } catch (error) {
    return { ok: false, error: 'corrupt', detail: errorDetail(error), fileName: file.name, sha256 };
  }
}

/** Copies what we need out of postal-mime's result into a NormalizedMessage. */
async function buildMessage(
  tree: EmlTree,
  fileName: string,
  sha256: string,
  options: EmlParserOptions,
): Promise<NormalizedMessage> {
  const { email } = tree;
  const messageId = parseSingleId(email.messageId);
  const date = readDate(email);
  const content = await readContent(tree, options, 0, { remaining: MAX_EXPANDED_FORWARDS });

  const warnings: ParseWarning[] = [...dateWarnings(date), ...content.warnings];
  if (messageId === null) warnings.push('missing-message-id');

  const from = readFrom(email);
  const sender = senderIfDifferent(readSender(email), from);
  return {
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
    bodyText: content.text,
    attachments: content.attachments,
    source: { fileName, sha256, kind: 'eml' },
    warnings,
  };
}

/**
 * Reads the RAW Date header. postal-mime's own `email.date` is already
 * converted to UTC, which loses the sender's time zone, so it is not used.
 */
function readDate(email: Email): { value: EmailDate; hadHeader: boolean } {
  const header = email.headers.find((h) => h.key === 'date');
  return { value: parseEmailDate(header?.value ?? null), hadHeader: header !== undefined };
}

function dateWarnings(date: { value: EmailDate; hadHeader: boolean }): ParseWarning[] {
  if (!date.hadHeader) return ['missing-date'];
  if (date.value.utcMs === null) return ['unparseable-date'];
  // Read as UTC for sorting only: the preview must flag it.
  if (!date.value.zoneKnown) return ['unknown-time-zone'];
  return [];
}

/**
 * All mailboxes of the first From header. postal-mime's `email.from` keeps
 * only the first one, but RFC 5322 allows several authors in one From.
 */
function readFrom(email: Email): EmailAddress[] {
  const header = email.headers.find((h) => h.key === 'from');
  if (header === undefined || header.value.trim() === '') return [];
  return mailboxes(addressParser(header.value));
}

/**
 * The first mailbox of the first Sender header (RFC 5322: the one mailbox
 * that actually sent the message, e.g. on behalf of the From author), or
 * undefined. The header allows one mailbox only; should a malformed one hold
 * more, the rest stay in the original file. Whether it is kept depends on
 * the From mailboxes, see senderIfDifferent.
 */
function readSender(email: Email): EmailAddress | undefined {
  const header = email.headers.find((h) => h.key === 'sender');
  if (header === undefined || header.value.trim() === '') return undefined;
  return mailboxes(addressParser(header.value))[0];
}

/**
 * Flattens address groups ("Team: carol@example.test, dave@example.test;")
 * into their members. Missing -> [].
 */
function mailboxes(list: readonly Address[] | undefined): EmailAddress[] {
  return (list ?? [])
    .flatMap((entry) => (entry.group ? entry.group : [entry]))
    .map((mailbox) => ({ name: mailbox.name ?? '', address: mailbox.address ?? '' }));
}

/** Body text, attachments and body warnings of one message, its inline forwarded messages included. */
interface MessageContent {
  readonly text: string;
  readonly attachments: AttachmentInfo[];
  readonly warnings: ParseWarning[];
}

/**
 * The body text and attachment list of one message. `depth` is 0 for the
 * file itself and grows by one for each level of inline forwarded message.
 *
 * The body is built from the MIME parts tree, depth-first, in file order:
 * - an inline text/plain part adds its text;
 * - an inline text/html part adds its text converted by the injected
 *   `htmlToText` ('html-converted-body', plus 'html-body-truncated' if cut);
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
 * - everything else is listed as an attachment.
 * Empty text parts are skipped. Two text parts are joined by a line break;
 * a forwarded message block is separated from what comes before and after
 * it by a blank line. If there is no text and no forwarded block, the text is
 * '' with a 'no-body' warning. An HTML part that converts to '' still counts
 * as a body (no 'no-body'), as its 'html-converted-body' warning says where to look.
 *
 * postal-mime's own `email.text` and `email.html` are never used.
 *
 * `budget` is shared by the whole file, see MAX_EXPANDED_FORWARDS.
 */
async function readContent(
  tree: EmlTree,
  options: EmlParserOptions,
  depth: number,
  budget: ForwardBudget,
): Promise<MessageContent> {
  // A bounce or feedback report carries the original message as evidence:
  // it stays a listed attachment, as postal-mime itself would do.
  const isReport = tree.email.attachments.some((a) => REPORT_TYPES.has(a.mimeType));

  const segments: BodySegment[] = [];
  const attachments: AttachmentInfo[] = [];
  const warnings: ParseWarning[] = [];
  let hasOwnBody = false;
  let expandedAny = false;

  // `hideHtml` is true inside a multipart/alternative whose HTML is not used
  // (see alternativeHtmlVersion): its HTML parts are skipped. Plain-text parts
  // are never skipped.
  const visit = async (part: EmlPart, hideHtml: boolean): Promise<void> => {
    if (part.kind === 'multipart') {
      if (part.subtype !== 'alternative') {
        for (const child of part.children) await visit(child, hideHtml);
        return;
      }
      // null: no version's HTML is used, so every child hides its HTML.
      const htmlVersion = alternativeHtmlVersion(part.children);
      for (const child of part.children) await visit(child, hideHtml || child !== htmlVersion);
      return;
    }

    if (part.kind === 'text') {
      if (part.text === '' || (part.type === 'html' && hideHtml)) return;
      hasOwnBody = true;
      if (part.type === 'plain') {
        segments.push({ text: part.text, isBlock: false });
        return;
      }
      const converted = convertHtmlBody(options.htmlToText, part.text);
      addWarning(warnings, 'html-converted-body');
      if (converted.truncated) addWarning(warnings, 'html-body-truncated');
      if (converted.text !== '') segments.push({ text: converted.text, isBlock: false });
      return;
    }

    const { attachment } = part;
    if (isReport || !isInlineForwarded(attachment)) {
      attachments.push(attachmentInfo(attachment));
      return;
    }
    const inner = await expandForwarded(attachment, options, depth, budget);
    if (inner === null) {
      // Too deep, over the budget, unreadable or empty: listed, so it stays
      // recoverable from the file.
      attachments.push(attachmentInfo(attachment));
      addWarning(warnings, 'forwarded-message-not-expanded');
      return;
    }
    segments.push({ text: inner.text, isBlock: true });
    attachments.push(...inner.attachments);
    for (const warning of inner.warnings) addWarning(warnings, warning);
    expandedAny = true;
  };
  await visit(tree.root, false);

  if (!hasOwnBody && !expandedAny) warnings.push('no-body');
  return { text: joinSegments(segments), attachments, warnings };
}

/** One piece of a body: the text of one part, or one forwarded message block. */
interface BodySegment {
  readonly text: string;
  /** True for a forwarded message block (see expandForwarded). */
  readonly isBlock: boolean;
}

/**
 * Joins body pieces in order: text parts with one line break between them
 * (as postal-mime joins them), a forwarded message block with a blank line
 * before and after it (see appendBlock).
 */
function joinSegments(segments: readonly BodySegment[]): string {
  let text = '';
  let previousIsBlock = false;
  for (const segment of segments) {
    if (text === '') text = segment.text;
    else if (segment.isBlock || previousIsBlock) text = appendBlock(text, segment.text);
    else text = `${text}\n${segment.text}`;
    previousIsBlock = segment.isBlock;
  }
  return text;
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
function alternativeHtmlVersion(versions: readonly EmlPart[]): EmlPart | null {
  if (versions.some((v) => holdsText(v, 'plain') && !holdsText(v, 'html'))) return null;
  return versions.find((v) => holdsText(v, 'html')) ?? null;
}

/**
 * True if `part` holds, at any depth, a text part of `type` with more than
 * spaces and line breaks (as the .msg adapter treats a whitespace-only body).
 */
function holdsText(part: EmlPart, type: 'plain' | 'html'): boolean {
  if (part.kind === 'text') return part.type === type && part.text.trim() !== '';
  if (part.kind === 'multipart') return part.children.some((child) => holdsText(child, type));
  return false;
}

/** A message/rfc822 part meant to be shown in the body: no Content-Disposition, or "inline". */
function isInlineForwarded(attachment: Attachment): boolean {
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
 * outer bodyText.
 *
 * Returns null, so that the caller lists the part as an attachment, if:
 * `depth` already reached MAX_FORWARD_DEPTH; the file's budget of expansions
 * is used up; the inner bytes cannot be parsed; or the inner message has
 * nothing to show: no body ('no-body'), none of the header lines below and no
 * attachments. Then no empty block is added and the part stays visible in the
 * attachment list.
 *
 * An inner message with no body but with header lines or attachments (a
 * common forward: From, Date, Subject and only a PDF) IS expanded: the block
 * is the separator and header lines, with no body after them, and its
 * attachments are listed by name. Its 'no-body' warning is not passed on.
 *
 * The inner bytes are only used inside this call.
 */
async function expandForwarded(
  attachment: Attachment,
  options: EmlParserOptions,
  depth: number,
  budget: ForwardBudget,
): Promise<MessageContent | null> {
  const { content } = attachment;
  // postal-mime sets rfc822DepthExceeded only when it expands forwarded
  // messages itself, which forceRfc822Attachments turns off. Checked anyway.
  if (depth >= MAX_FORWARD_DEPTH || attachment.rfc822DepthExceeded === true || typeof content === 'string') {
    return null;
  }
  // Counted before parsing: an attempt costs a parse even if it then fails.
  if (budget.remaining <= 0) return null;
  budget.remaining--;

  let inner: EmlTree;
  try {
    inner = await parseEmlTree(content, POSTAL_MIME_OPTIONS);
  } catch (error) {
    // A changed library must fail loudly, not hide as an unreadable forward.
    if (error instanceof PostalMimeInternalsError) throw error;
    return null;
  }
  const body = await readContent(inner, options, depth + 1, budget);
  const headerLines = forwardedHeaderLines(inner.email);
  const noBody = body.warnings.includes('no-body');
  if (noBody && headerLines.length === 0 && body.attachments.length === 0) return null;
  const header = [FORWARDED_SEPARATOR, ...headerLines].join('\n');
  return {
    // No body: the block ends with the header lines, no trailing blank line.
    text: noBody ? header : `${header}\n\n${body.text}`,
    attachments: body.attachments,
    // readContent only ever gives body warnings ('html-converted-body',
    // 'html-body-truncated', 'forwarded-message-not-expanded', and
    // 'no-body'). 'no-body' describes
    // the inner message only: the outer one now has this block as text, so it
    // is dropped here. Date and Message-ID warnings come from buildMessage,
    // which never runs for an inner message. This allow-list also guards
    // against a body warning being added later without deciding whether it
    // applies to the outer message.
    warnings: body.warnings.filter(
      (w) => w === 'html-converted-body' || w === 'html-body-truncated' || w === 'forwarded-message-not-expanded',
    ),
  };
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
 */
function forwardedHeaderLines(email: Email): string[] {
  const first = (key: string): string | undefined => email.headers.find((h) => h.key === key)?.value;
  const all = (key: string): string | undefined => {
    const values = email.headers.filter((h) => h.key === key && h.value !== '').map((h) => h.value);
    return values.length > 0 ? values.join(', ') : undefined;
  };
  const lines: string[] = [];
  const add = (label: string, value: string | undefined, decode: boolean): void => {
    if (value === undefined) return;
    // Headers arrive unfolded. A decoded encoded word could still hold a line
    // break: it becomes a space, so one header stays one line in the block.
    const shown = (decode ? decodeWords(value) : value).replace(/[\r\n]+/g, ' ');
    lines.push(`${label}: ${shown}`);
  };
  add('From', first('from'), true);
  if (senderIfDifferent(readSender(email), readFrom(email)) !== undefined) add('Sender', first('sender'), true);
  add('Date', first('date'), false);
  add('Subject', first('subject'), true);
  add('To', all('to'), true);
  add('Cc', all('cc'), true);
  add('Bcc', all('bcc'), true);
  return lines;
}

/** Adds `block` after `text`, separated by one blank line. */
function appendBlock(text: string, block: string): string {
  if (text === '') return block;
  return `${text.endsWith('\n') ? text : `${text}\n`}\n${block}`;
}

function addWarning(warnings: ParseWarning[], warning: ParseWarning): void {
  if (!warnings.includes(warning)) warnings.push(warning);
}

/**
 * Metadata only (README.md, rule R4). A new object is built, so the result
 * holds no reference to postal-mime's content buffer. Every part postal-mime
 * lists is kept, including inline images of an HTML body, forwarded messages
 * sent as attachments, and inline forwarded messages that were not expanded:
 * the list stays complete.
 */
function attachmentInfo(attachment: Attachment): AttachmentInfo {
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

/**
 * A short, single-line message for the preview's error list. A failure of the
 * injected HTML converter keeps its own message ("HTML body could not be
 * converted: ..."), so it is never mistaken for a damaged file.
 */
function errorDetail(error: unknown): string {
  return shortDetail(error instanceof Error ? error.message : String(error));
}

function shortDetail(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_LENGTH) || 'unknown error';
}
