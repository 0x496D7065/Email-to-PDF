// Rebuild the earlier messages of a thread from the quoted text inside ONE
// dropped email (milestone 7, task 7.4; brief section 8.6).
//
// Input: the body text of one source message, its subject (findReplyHeaders
// uses it to spot a forward) and the UTC offset of its own Date header (used
// to estimate the time of a quoted date written without a zone: user
// decision, see quoted-date.ts). Output: one ReconstructedMessage per earlier
// message, newest first (= in body order). The engine links them
// (rebuild-links.ts); the preview (src/ui/preview.ts) and the PDF
// (src/pdf/model.ts) show them, marked as rebuilt.
//
// How it works:
// 1. findReplyHeaders (reply-header.ts) finds the quote headers, with its own
//    evidence rules (a single "From:" sentence in prose is never a header).
//    readQuotedHeader (quoted-header.ts) reads their fields and the true end
//    of their lines; parseQuotedDate (quoted-date.ts) reads the date.
// 2. The headers form a CHAIN, in body order: header k is the message the
//    message of header k-1 replied to or forwarded (generation k). Message k
//    runs from its header's first line (`start`) to the start of the next
//    header found (`end`), or to the end of the quoted history (the end of
//    the body, or the first forwarded block the .eml adapter wrote: that is
//    another message, see reply-header.ts rule 5). So the rebuilt messages
//    cover the quoted history from the first header on, end to end, with no
//    gap and no overlap; nothing is lost (brief section 7). The raw header
//    text stays [start, headerEnd) in the source body.
// 3. Every line has a quote DEPTH: the number of ">" marks before its text
//    (spaces between them allowed, as in quote-markers.ts). A message's body
//    depth (`depth`) is:
//    - for a header BLOCK (Outlook, forwards: a From label line), the depth
//      of its header lines;
//    - for an ATTRIBUTION ("On ... wrote:"), the depth of the first line of
//      text after it: one more than the attribution (Gmail) or the same
//      depth inside a ">" quote (Apple Mail, "> On ... wrote:").
// 4. reconstructedText (user decision, option A) is the body slice
//    [headerEnd, end) with exactly `depth` leading ">" marks removed from
//    each line (with the spaces before each mark, and one space after the
//    last one when there is one); a blank line with fewer marks loses the
//    marks it has. So quote marks and their indentation are removed; words,
//    line breaks and everything else are untouched.
//    This is the ONLY form change, made for rebuilt views; the source text
//    is never changed. RECONSTRUCTED_FORM_NOTE tells the UI/PDF to say so.
//
// REFUSAL (never guess: fewer rebuilt messages, never wrong ones). The chain
// STOPS at the first header that fails one of the rules below, and the
// message that holds that header is dropped too: its end is no longer known
// (the failing header may be a real boundary, or the holder may go on with
// interleaved text). Messages before it are kept.
// R1. Evidence: the header must give a sender (exactly one mailbox) or a
//     readable date. Without a readable date, the sender counts only when
//     it has an address or a name-shaped name (isPlainName, quoted-header.ts):
//     "From: the accounting team / Sent: in March 2025" under a row of
//     underscores is not a header. A header block WITHOUT an intro line
//     (separator, row of underscores, forward marker) needs both a sender
//     and a readable date: the same lines in prose are not a header.
// R2. The header's own lines all have the same depth, and its fields end
//     (headerEnd) before the next header.
// R3. Depth must follow the chain: with the holder's body depth p (0 for
//     the source's own text), a block starts at depth p or p + 1 (body at
//     the same depth); an attribution at depth p has its body at p + 1, one
//     at depth p + 1 (inside the quote) has its body at p + 1 too. Anything
//     else (depth going back, skipping a level, an attribution followed by
//     unquoted text) is refused.
// R4. No text line of the message's own part [headerEnd, next header) is
//     less deep than its body: unquoted text between or after quoted lines
//     (interleaved answers, bottom-posting) means the quote is not one
//     message. Blank lines (only marks and spaces) are allowed.
// R5. Bounds: a body depth above MAX_QUOTE_DEPTH is refused; at most
//     MAX_RECONSTRUCTED messages are rebuilt (the last one kept still ends
//     at the next header, so nothing is merged); a body longer than
//     MAX_SOURCE_LENGTH is not read at all.
// Text typed BELOW an unmarked Outlook quote cannot be seen (no ">" marks):
// it ends up in the last rebuilt message, as in reply-header.ts rule 3. It
// stays in the source; nothing is lost.
//
// Cost: linear in the body length. findReplyHeaders and readQuotedHeader are
// linear and bounded; each line is classified once, and the depth checks
// read every line of the history once (the messages do not overlap).
//
// Pure function: no DOM, no storage, never throws (an internal failure gives
// []), the input is never modified (README.md, rule R7).

import { FORWARDED_SEPARATOR } from '../parsing/forwarded-block';
import type { EmailAddress } from '../parsing/types';
import { hasWrittenZone, parseQuotedDate, type QuotedDate } from './quoted-date';
import { isPlainName, readQuotedHeader } from './quoted-header';
import { clean, findReplyHeaders, LABEL_HEAD_LENGTH, LABEL_PATTERN, LABEL_ROLE_OF, labelKey } from './reply-header';
import { lineRanges } from './segments';

/** A body longer than this (characters) is not read: no rebuilt message. */
export const MAX_SOURCE_LENGTH = 10_000_000;
/** Most messages rebuilt from one body. */
export const MAX_RECONSTRUCTED = 500;
/** Deepest body depth (">" levels) rebuilt; real threads stay far below. */
export const MAX_QUOTE_DEPTH = 100;

/**
 * The fixed note the UI and the PDF show next to a rebuilt message whose
 * text had quote marks and their indentation removed (quoteMarksRemoved):
 * the only form change (file comment, step 4). An i18n key would be chosen
 * by the UI task; this constant names the change itself.
 */
export const RECONSTRUCTED_FORM_NOTE = 'quote-marks-removed' as const;

/** One earlier message rebuilt from quoted text. NOT a real message: it has no source file and no hash. */
export interface ReconstructedMessage {
  /** Offset of the header's first line in the source body (quote marks included). */
  readonly start: number;
  /** End of the header's own lines, line break included (readQuotedHeader). [start, headerEnd) is the raw header text. */
  readonly headerEnd: number;
  /** End of the message's part: the next rebuilt header's start, or the end of the quoted history. */
  readonly end: number;
  /** Number of ">" levels of the body (removed from each line of reconstructedText). */
  readonly depth: number;
  /** 1 = the message the source replied to or forwarded, 2 = the one before, ... */
  readonly generation: number;
  /** As findReplyHeaders reports it. */
  readonly kind: 'reply' | 'forward';
  readonly from: readonly EmailAddress[];
  readonly to: readonly EmailAddress[];
  readonly cc: readonly EmailAddress[];
  /** null = the header holds no subject (attributions never do). */
  readonly subject: string | null;
  /** The date as written, or null. */
  readonly dateText: string | null;
  /** To / Cc lists that may go on past what was read (quoted-header.ts). */
  readonly incomplete: readonly ('to' | 'cc')[];
  /** The date read from dateText (null when there is none; wallMs null when unreadable). */
  readonly date: QuotedDate | null;
  /** True unless the date carries its own zone (an RFC 5322 or a written offset): then the moment is exact. */
  readonly dateApproximate: boolean;
  /** Body [headerEnd, end) with `depth` quote marks and their indentation removed per line (file comment, step 4). */
  readonly reconstructedText: string;
  /** depth > 0: the text differs from the source slice by its quote marks and their indentation (show RECONSTRUCTED_FORM_NOTE). */
  readonly quoteMarksRemoved: boolean;
}

export interface ReconstructOptions {
  /** The source message's subject (spots a forward). */
  readonly subject?: string;
  /** UTC offset (minutes) of the source message's Date header; null when unknown. */
  readonly sourceOffsetMinutes: number | null;
}

/** One line of the body. */
interface QLine {
  readonly start: number;
  readonly contentEnd: number;
  readonly end: number;
  /** ">" marks before the text. */
  readonly depth: number;
  /** Nothing but marks and whitespace. */
  readonly gap: boolean;
  /** First character after the marks and spaces. */
  readonly textStart: number;
}

/** Whitespace as \s sees it (nbsp and BOM included), with a fast path for the common ones. */
function isSpace(code: number): boolean {
  if (code === 0x20 || code === 0x09) return true;
  if (code < 0x80 && code !== 0x0b && code !== 0x0c) return false;
  return /\s/u.test(String.fromCharCode(code));
}

function classify(text: string, start: number, contentEnd: number, end: number): QLine {
  let k = start;
  let depth = 0;
  while (k < contentEnd) {
    const code = text.charCodeAt(k);
    if (code === 0x3e) depth++;
    else if (!isSpace(code)) break;
    k++;
  }
  return { start, contentEnd, end, depth, gap: k === contentEnd, textStart: k };
}

/**
 * The text of lines [from, to) with up to `depth` quote marks and their
 * indentation removed per line (file comment, step 4). Exported for the tests.
 */
export function removeQuoteMarks(text: string, from: number, to: number, depth: number): string {
  if (depth <= 0) return text.slice(from, to);
  const parts: string[] = [];
  for (const range of lineRanges(text.slice(from, to))) {
    const s = from + range.start;
    const contentEnd = from + range.contentEnd;
    let i = s;
    let removed = 0;
    while (removed < depth) {
      let j = i;
      while (j < contentEnd && text.charCodeAt(j) !== 0x3e && isSpace(text.charCodeAt(j))) j++;
      if (j >= contentEnd || text.charCodeAt(j) !== 0x3e) break;
      i = j + 1;
      removed++;
    }
    if (removed > 0 && i < contentEnd && text.charCodeAt(i) === 0x20) i++;
    parts.push(text.slice(i, from + range.end));
  }
  return parts.join('');
}

/**
 * The quote prefix at the start of one line (its content, line break
 * excluded): the same reading as `classify` and `removeQuoteMarks` with no
 * depth limit, so the PDF (src/pdf/text.ts, task 8.1) and the rebuilt texts
 * agree on what is a quote mark. The prefix is every ">" before the first
 * other character, with the whitespace before each (isSpace: JavaScript's
 * \s), then one plain space after the last ">" when there is one. (The PDF
 * reads the prefix only up to the first VT or FF, so those controls stay
 * visible as codes there; this function does not.) `level` is the number of
 * ">" (0: no prefix, `length` 0: whitespace that is not followed by a ">"
 * is never part of a prefix). The rest of the
 * line, `line.slice(length)`, never starts with whitespace and a ">".
 * Linear in the prefix length. Pure.
 */
export function quotePrefix(line: string): { readonly level: number; readonly length: number } {
  let level = 0;
  let length = 0;
  let k = 0;
  while (k < line.length) {
    const code = line.charCodeAt(k);
    if (code === 0x3e) {
      level++;
      length = k + 1;
    } else if (!isSpace(code)) break;
    k++;
  }
  if (level > 0 && line.charCodeAt(length) === 0x20) length++;
  return { level, length };
}

/** Index of the line starting at `offset` (binary search), or -1. */
function lineIndexAt(lines: readonly QLine[], offset: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const line = lines[mid] as QLine;
    if (line.start === offset) return mid;
    if (line.start < offset) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** Whether the line starts with a From label (as reply-header.ts reads labels). */
function isFromLabel(text: string, line: QLine): boolean {
  if (line.gap) return false;
  const head = clean(text, line.textStart, Math.min(line.contentEnd, line.textStart + LABEL_HEAD_LENGTH));
  const word = LABEL_PATTERN.exec(head)?.[1];
  return word !== undefined && LABEL_ROLE_OF.get(labelKey(word)) === 'from';
}

/**
 * Rebuilds the earlier messages quoted in `bodyText` (see the file comment).
 * Newest first. Never throws: odd input or an internal failure gives [].
 */
export function reconstructQuotedMessages(bodyText: string, options: ReconstructOptions): ReconstructedMessage[] {
  if (typeof (bodyText as unknown) !== 'string' || bodyText.length > MAX_SOURCE_LENGTH) return [];
  const offset = typeof options?.sourceOffsetMinutes === 'number' ? options.sourceOffsetMinutes : null;
  const subject = typeof options?.subject === 'string' ? options.subject : undefined;
  try {
    return rebuild(bodyText, subject, offset);
  } catch {
    return []; // never happens: everything is bounded slicing and testing
  }
}

function rebuild(text: string, subject: string | undefined, sourceOffset: number | null): ReconstructedMessage[] {
  const lines = lineRanges(text).map((r) => classify(text, r.start, r.contentEnd, r.end));
  // The quoted history ends at the first forwarded block the .eml adapter wrote (another message).
  const tool = lines.find((l) => l.depth === 0 && text.slice(l.start, l.contentEnd) === FORWARDED_SEPARATOR);
  const limit = tool === undefined ? text.length : tool.start;
  const headers = findReplyHeaders(text, subject).filter((h) => h.start < limit);

  const kept: ReconstructedMessage[] = [];
  let parentDepth = 0;
  for (let k = 0; k < headers.length && kept.length < MAX_RECONSTRUCTED; k++) {
    const h = headers[k];
    if (h === undefined) break;
    const segEnd = Math.min(headers[k + 1]?.start ?? limit, limit);
    const message = candidate(text, lines, h, segEnd, parentDepth, sourceOffset, kept.length + 1);
    if (message === null) {
      kept.pop(); // R1-R4: the holder's end is not known (file comment, REFUSAL)
      break;
    }
    kept.push(message);
    parentDepth = message.depth;
  }
  return kept;
}

/** Message for header `h` whose part ends at `segEnd`, or null when refused (rules R1-R5). */
function candidate(
  text: string,
  lines: readonly QLine[],
  h: { readonly start: number; readonly headEnd: number; readonly kind: 'reply' | 'forward' },
  segEnd: number,
  parentDepth: number,
  sourceOffset: number | null,
  generation: number,
): ReconstructedMessage | null {
  const fields = readQuotedHeader(text, h);
  const headerEnd = fields.headerEnd;
  // R2: the fields end inside the message's part.
  if (headerEnd <= h.start || headerEnd > segEnd) return null;
  const first = lineIndexAt(lines, h.start);
  if (first < 0) return null;

  // R2: header lines at one depth; block or attribution.
  let headerDepth = -1;
  let block = false;
  let introFirst = false;
  let k = first;
  for (; k < lines.length && (lines[k] as QLine).start < headerEnd; k++) {
    const line = lines[k] as QLine;
    if (line.gap) continue;
    if (headerDepth < 0) {
      headerDepth = line.depth;
      introFirst = !isFromLabel(text, line);
    } else if (line.depth !== headerDepth) return null;
    if (!block && isFromLabel(text, line)) block = true;
  }
  if (headerDepth < 0) return null;
  const bodyFirst = k; // first line of [headerEnd, segEnd)

  // Body depth (step 3) and R3.
  let depth: number;
  if (block) {
    depth = headerDepth;
    if (headerDepth !== parentDepth && headerDepth !== parentDepth + 1) return null;
  } else {
    let firstText = -1;
    for (let j = bodyFirst; j < lines.length && (lines[j] as QLine).start < segEnd; j++) {
      if (!(lines[j] as QLine).gap) {
        firstText = j;
        break;
      }
    }
    if (firstText < 0) return null;
    depth = (lines[firstText] as QLine).depth;
    const gmail = headerDepth === parentDepth && depth === parentDepth + 1;
    const apple = headerDepth === parentDepth + 1 && depth === headerDepth;
    if (!gmail && !apple) return null;
  }
  if (depth > MAX_QUOTE_DEPTH) return null;

  // R4: no text line of the part less deep than the body.
  for (let j = bodyFirst; j < lines.length && (lines[j] as QLine).start < segEnd; j++) {
    const line = lines[j] as QLine;
    if (!line.gap && line.depth < depth) return null;
  }

  // R1: evidence.
  const date = fields.dateText === null ? null : parseQuotedDate(fields.dateText, sourceOffset);
  const dateOk = date !== null && date.wallMs !== null;
  const sender = fields.from.length === 1 ? fields.from[0] : undefined;
  const senderOk = sender !== undefined;
  // Without a readable date, a sender is evidence only with an address or a name-shaped name.
  const senderStrong = sender !== undefined && (sender.address !== '' || (sender.name !== '' && isPlainName(sender.name, false)));
  const evidence = block && !introFirst ? dateOk && senderOk : dateOk || senderStrong;
  if (!evidence) return null;

  return {
    start: h.start,
    headerEnd,
    end: segEnd,
    depth,
    generation,
    kind: h.kind,
    from: fields.from,
    to: fields.to,
    cc: fields.cc,
    subject: fields.subject,
    dateText: fields.dateText,
    incomplete: fields.incomplete,
    date,
    dateApproximate: date === null || date.wallMs === null || !hasWrittenZone(date),
    reconstructedText: removeQuoteMarks(text, headerEnd, segEnd, depth),
    quoteMarksRemoved: depth > 0,
  };
}
