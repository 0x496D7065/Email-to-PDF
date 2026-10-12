// The .eml adapter: turns one .eml file into a NormalizedMessage.
//
// postal-mime does the MIME work (headers, encoded words, quoted-printable,
// base64, charsets, multipart trees). This file is the only place that knows
// about postal-mime: everything it returns is copied into our own
// NormalizedMessage shape, so the rest of the tool never sees the library and
// the library can be swapped without touching anything else.
//
// Email content is untrusted (README.md, rule R4):
// - HTML is never rendered, loaded or evaluated here. An HTML-only body is
//   handed as a plain string to the injected `htmlToText` function.
// - Attachments are reduced to name, size and type. Their contents are never
//   opened, and no reference to the content bytes is kept in the result.
//   The one exception is an inline forwarded message (message/rfc822 without
//   "Content-Disposition: attachment"): its bytes are parsed again as an email
//   so its text can join the body, then dropped.

import PostalMime, {
  addressParser,
  decodeWords,
  type Address,
  type Attachment,
  type Email,
  type PostalMimeOptions,
} from 'postal-mime';
import { parseEmailDate } from './date';
import { sha256Hex } from './hash';
import { parseIdList, parseSingleId } from './ids';
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
   * Converts an HTML body to plain text. Called when a message (or an inline
   * forwarded message) has an HTML part but no plain-text part. It must be
   * inert: no rendering, no script execution, no loading of images or styles
   * (README.md, rule R4). Injected so that this adapter stays testable in Node
   * without a DOM.
   *
   * Known limitation: when a text/plain part and a SEPARATE text/html part
   * sit side by side in multipart/mixed (not multipart/alternative),
   * postal-mime converts that HTML itself with its own simple converter and
   * appends the result to the plain text. This function is then not called
   * and no 'html-only-body' warning is given, even when the HTML is the main
   * body and the plain part is only a footer. That text can contain link
   * targets and the contents of <style> blocks. Nothing is rendered, so this
   * is a text-quality problem, not a security one. It is planned to go away
   * when the real HTML-to-text step lands and the adapter assembles the body
   * part by part.
   */
  readonly htmlToText: (html: string) => string;
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
  // itself instead, see expandForwarded.
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
    const email = await PostalMime.parse(file.bytes, POSTAL_MIME_OPTIONS);
    const message = await buildMessage(email, file.name, sha256, options);
    return { ok: true, message };
  } catch (error) {
    return { ok: false, error: 'corrupt', detail: errorDetail(error), fileName: file.name, sha256 };
  }
}

/** Copies what we need out of postal-mime's result into a NormalizedMessage. */
async function buildMessage(
  email: Email,
  fileName: string,
  sha256: string,
  options: EmlParserOptions,
): Promise<NormalizedMessage> {
  const messageId = parseSingleId(email.messageId);
  const date = readDate(email);
  const content = await readContent(email, options, 0, { remaining: MAX_EXPANDED_FORWARDS });

  const warnings: ParseWarning[] = [...dateWarnings(date), ...content.warnings];
  if (messageId === null) warnings.push('missing-message-id');

  return {
    messageId,
    inReplyTo: parseSingleId(email.inReplyTo),
    references: parseIdList(email.references),
    date: date.value,
    from: readFrom(email),
    to: mailboxes(email.to),
    cc: mailboxes(email.cc),
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
 * The body is, in this order:
 * 1. the message's own text:
 *    - `email.text` if postal-mime found any text/plain part. postal-mime
 *      joins all inline text parts of the message there, see the known
 *      limitation on EmlParserOptions.htmlToText for an HTML part that sits
 *      next to a text/plain part in multipart/mixed;
 *    - otherwise the HTML, converted by the injected `htmlToText`
 *      ('html-only-body');
 *    - otherwise nothing;
 * 2. then each inline forwarded message, in file order, see expandForwarded.
 * If both are empty, the text is '' with a 'no-body' warning.
 *
 * Known limitation: because all of the message's own text parts come first
 * and every forwarded message is appended after them, the body is not in file
 * order when a text part comes after a forwarded message. "T1, forward A, T2,
 * forward B, T3" becomes "T1 T2 T3, A, B". Nothing is lost, only moved. This
 * is planned to be fixed by walking the MIME parts tree directly.
 *
 * `budget` is shared by the whole file, see MAX_EXPANDED_FORWARDS.
 */
async function readContent(
  email: Email,
  options: EmlParserOptions,
  depth: number,
  budget: ForwardBudget,
): Promise<MessageContent> {
  const warnings: ParseWarning[] = [];
  let text = '';
  let hasOwnBody = true;
  if (email.text !== undefined) {
    text = email.text;
  } else if (email.html !== undefined) {
    text = options.htmlToText(email.html);
    warnings.push('html-only-body');
  } else {
    hasOwnBody = false;
  }

  // A bounce or feedback report carries the original message as evidence:
  // it stays a listed attachment, as postal-mime itself would do.
  const isReport = email.attachments.some((a) => REPORT_TYPES.has(a.mimeType));

  const attachments: AttachmentInfo[] = [];
  let expandedAny = false;
  for (const attachment of email.attachments) {
    if (isReport || !isInlineForwarded(attachment)) {
      attachments.push(attachmentInfo(attachment));
      continue;
    }
    const inner = await expandForwarded(attachment, options, depth, budget);
    if (inner === null) {
      // Too deep, over the budget, unreadable or empty: listed, so it stays
      // recoverable from the file.
      attachments.push(attachmentInfo(attachment));
      addWarning(warnings, 'forwarded-message-not-expanded');
      continue;
    }
    text = appendBlock(text, inner.text);
    attachments.push(...inner.attachments);
    for (const warning of inner.warnings) addWarning(warnings, warning);
    expandedAny = true;
  }

  if (!hasOwnBody && !expandedAny) warnings.push('no-body');
  return { text, attachments, warnings };
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

  let inner: Email;
  try {
    inner = await PostalMime.parse(content, POSTAL_MIME_OPTIONS);
  } catch {
    return null;
  }
  const body = await readContent(inner, options, depth + 1, budget);
  const headerLines = forwardedHeaderLines(inner);
  const noBody = body.warnings.includes('no-body');
  if (noBody && headerLines.length === 0 && body.attachments.length === 0) return null;
  const header = [FORWARDED_SEPARATOR, ...headerLines].join('\n');
  return {
    // No body: the block ends with the header lines, no trailing blank line.
    text: noBody ? header : `${header}\n\n${body.text}`,
    attachments: body.attachments,
    // readContent only ever gives body warnings ('html-only-body',
    // 'forwarded-message-not-expanded', and 'no-body'). 'no-body' describes
    // the inner message only: the outer one now has this block as text, so it
    // is dropped here. Date and Message-ID warnings come from buildMessage,
    // which never runs for an inner message. This allow-list also guards
    // against a body warning being added later without deciding whether it
    // applies to the outer message.
    warnings: body.warnings.filter((w) => w === 'html-only-body' || w === 'forwarded-message-not-expanded'),
  };
}

/**
 * Header lines for a forwarded message block, built from the RAW header
 * strings: encoded words (=?utf-8?...?=) are decoded, nothing else is
 * reformatted. The Date line is the header text exactly as in the file, never
 * a date reformatted for a locale or time zone. Missing headers are skipped.
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
  add('Date', first('date'), false);
  add('Subject', first('subject'), true);
  add('To', all('to'), true);
  add('Cc', all('cc'), true);
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

/** A short, single-line message for the preview's error list. */
function errorDetail(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL_LENGTH) || 'unknown error';
}
