// Rebuild the earlier messages of a thread from the quoted text inside ONE
// dropped email (milestone 7, task 7.4; brief section 8.6).
//
// Input: the body text of one source message, its subject (findReplyHeaders
// uses it to spot a forward) and the UTC offset of its own Date header (used
// to estimate the time of a quoted date written without a zone: user
// decision, see quoted-date.ts). Output: one ReconstructedMessage per earlier
// message, newest first (= in body order). The thread analysis links them
// (link-rebuilt-messages.ts); the preview (Source/web-page/preview.ts) and the PDF
// (Source/pdf-export/build-pdf-document.ts) show them, marked as rebuilt.
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
//      of its header lines; for a FORWARD block whose text lines are all
//      one level deeper than its header lines, that deeper level (P1, task
//      9.9a: Android mail nests the forwarded email in a blockquote under
//      its header lines; only forward blocks, user decision F7);
//    - for an ATTRIBUTION ("On ... wrote:"), the depth of the first line of
//      text after it: one more than the attribution (Gmail) or the same
//      depth inside a ">" quote (Apple Mail, "> On ... wrote:"). A FLAT
//      attribution (its text at its own depth, no ">" level added, as
//      phones write a forwarded thread) is accepted only when it is STRICT
//      (F1, task 9.9a): its whole line(s) are the attribution (opener to
//      ending, isStrongAttribution in reply-header.ts), its date is readable
//      with a time, and its sender has an address. Ordinary prose that ends
//      with "wrote:" is never one. A flat attribution that has text must
//      have ALL its text lines at its own depth: a deeper (quoted) line in
//      its part means the unquoted lines are the writer's own answer around
//      a quote, so it is refused (review 9.9a). Known limit: in a flat
//      block, text after the quoted message (e.g. the forwarder's own
//      signature) becomes part of the last rebuilt message, because plain
//      text cannot tell them apart; the original stays complete in the source;
//    - for a header with no text in its part (R6), an attribution or a
//      forward block (marker line first) takes the next header's depth when
//      that is one deeper, else its own (an attribution must then be strict,
//      as above).
// 4. reconstructedText (user decision, option A) is the body slice
//    [headerEnd, end) with exactly `depth` leading ">" marks removed from
//    each line (with the spaces before each mark, and one space after the
//    last one when there is one); a blank line with fewer marks loses the
//    marks it has. So quote marks and their indentation are removed; words,
//    line breaks and everything else are untouched.
//    This is the ONLY form change, made for rebuilt views; the source text
//    is never changed. RECONSTRUCTED_FORM_NOTE tells the UI/PDF to say so.
//    One no-break space right after the last mark goes like a space (P3:
//    HTML converted to text writes "> &nbsp;").
// 5. SUBJECT. A header block gives its own Subject. An attribution holds
//    none: it takes the subject of the conversation, the one of the nearest
//    NEWER header in the chain that has one, else the dropped email's own
//    (user decision F3, task 9.9a). It is shown as it is (not marked as
//    borrowed); subjectFromChain records it for the linking only.
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
//     at depth p + 1 (inside the quote) has its body at p + 1 too. A forward
//     block may have its body at its header depth + 1 (step 3, P1); a strict
//     attribution at depth p may have its body at p (step 3, F1). Anything
//     else (depth going back, skipping a level, a non-strict attribution
//     followed by unquoted text) is refused.
// R4. No text line of the message's own part [headerEnd, next header) is
//     less deep than its body: unquoted text between or after quoted lines
//     (interleaved answers, bottom-posting) means the quote is not one
//     message. Blank lines (only marks and spaces) are allowed.
// R5. Bounds: a body depth above MAX_QUOTE_DEPTH is refused; at most
//     MAX_RECONSTRUCTED messages are rebuilt (the last one kept still ends
//     at the next header, so nothing is merged); a body longer than
//     MAX_SOURCE_LENGTH is not read at all.
// R6. A header whose part has no text line (only blank lines and marks:
//     a header directly followed by the next one) is NOT refused: it gives
//     an empty rebuilt message (noOwnText) and the chain goes on past it
//     (user decision F2, task 9.9a). The rules above still apply to it.
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

import { FORWARDED_SEPARATOR } from '../email-reading/forwarded-block';
import { hasWrittenZone, parseQuotedDate } from './quoted-date';
import { isPlainName, readQuotedHeader } from './quoted-header';
import {
    clean,
    findReplyHeaders,
    FORWARD_MARKERS,
    isStrongAttribution,
    joinAttributionLines,
    LABEL_HEAD_LENGTH,
    LABEL_PATTERN,
    LABEL_ROLE_OF,
    labelKey,
} from './reply-header';
import { lineRanges } from './fold-segments';
import type { ReconstructedMessage } from '../../Header/rebuilt-emails';

/** A body longer than this (characters) is not read: no rebuilt message. */
export const MAX_SOURCE_LENGTH = 10_000_000;
/** Most messages rebuilt from one body. */
export const MAX_RECONSTRUCTED = 500;
/** Deepest body depth (">" levels) rebuilt; real threads stay far below. */
export const MAX_QUOTE_DEPTH = 100;
/** A longer line is never read as a forward marker (as reply-header.ts reads intro lines). */
const MAX_MARKER_LENGTH = 120;

/**
 * The fixed note the UI and the PDF show next to a rebuilt message whose
 * text had quote marks and their indentation removed (quoteMarksRemoved):
 * the only form change (file comment, step 4). An i18n key would be chosen
 * by the UI task; this constant names the change itself.
 */
export const RECONSTRUCTED_FORM_NOTE = 'quote-marks-removed' as const;

export interface ReconstructOptions
{
    /** The source message's subject (spots a forward). */
    readonly subject?: string;
    /** UTC offset (minutes) of the source message's Date header; null when unknown. */
    readonly sourceOffsetMinutes: number | null;
}

/** One line of the body. */
interface QuotedLine
{
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
function isSpace(code: number): boolean
{
    if (code === 0x20 || code === 0x09)
    {
        return true;
    }
    if (code < 0x80 && code !== 0x0b && code !== 0x0c)
    {
        return false;
    }
    return /\s/u.test(String.fromCharCode(code));
}

function classify(text: string, start: number, contentEnd: number, end: number): QuotedLine
{
    let k = start;
    let depth = 0;
    while (k < contentEnd)
    {
        const code = text.charCodeAt(k);
        if (code === 0x3e)
        {
            depth++;
        }
        else if (!isSpace(code))
        {
            break;
        }
        k++;
    }
    return { start, contentEnd, end, depth, gap: k === contentEnd, textStart: k };
}

/**
 * The text of lines [from, to) with up to `depth` quote marks and their
 * indentation removed per line, plus one space or no-break space after the
 * last mark removed (file comment, step 4). Exported for the tests.
 */
export function removeQuoteMarks(text: string, from: number, to: number, depth: number): string
{
    if (depth <= 0)
    {
        return text.slice(from, to);
    }
    const parts: string[] = [];
    for (const range of lineRanges(text.slice(from, to)))
    {
        const lineStart = from + range.start;
        const contentEnd = from + range.contentEnd;
        let i = lineStart;
        let removed = 0;
        while (removed < depth)
        {
            let j = i;
            while (j < contentEnd && text.charCodeAt(j) !== 0x3e && isSpace(text.charCodeAt(j)))
            {
                j++;
            }
            if (j >= contentEnd || text.charCodeAt(j) !== 0x3e)
            {
                break;
            }
            i = j + 1;
            removed++;
        }
        // One plain space or one no-break space after the last mark (as quotePrefixLength in pdf-text-transforms.ts).
        if (removed > 0 && i < contentEnd && (text.charCodeAt(i) === 0x20 || text.charCodeAt(i) === 0xa0))
        {
            i++;
        }
        parts.push(text.slice(i, from + range.end));
    }
    return parts.join('');
}

/** Index of the line starting at `offset` (binary search), or -1. */
function lineIndexAt(lines: readonly QuotedLine[], offset: number): number
{
    let lo = 0;
    let hi = lines.length - 1;
    while (lo <= hi)
    {
        const mid = (lo + hi) >> 1;
        const line = lines[mid] as QuotedLine;
        if (line.start === offset)
        {
            return mid;
        }
        if (line.start < offset)
        {
            lo = mid + 1;
        }
        else
        {
            hi = mid - 1;
        }
    }
    return -1;
}

/** Whether the line starts with a From label (as reply-header.ts reads labels). */
function isFromLabel(text: string, line: QuotedLine): boolean
{
    if (line.gap)
    {
        return false;
    }
    const head = clean(text, line.textStart, Math.min(line.contentEnd, line.textStart + LABEL_HEAD_LENGTH));
    const word = LABEL_PATTERN.exec(head)?.[1];
    return word !== undefined && LABEL_ROLE_OF.get(labelKey(word)) === 'from';
}

/**
 * Rebuilds the earlier messages quoted in `bodyText` (see the file comment).
 * Newest first. Never throws: odd input or an internal failure gives [].
 */
export function reconstructQuotedMessages(bodyText: string, options: ReconstructOptions): ReconstructedMessage[]
{
    if (typeof (bodyText as unknown) !== 'string' || bodyText.length > MAX_SOURCE_LENGTH)
    {
        return [];
    }
    const offset = typeof options?.sourceOffsetMinutes === 'number' ? options.sourceOffsetMinutes : null;
    const subject = typeof options?.subject === 'string' ? options.subject : undefined;
    try
    {
        return rebuild(bodyText, subject, offset);
    }
    catch
    {
        return []; // never happens: everything is bounded slicing and testing
    }
}

function rebuild(text: string, subject: string | undefined, sourceOffset: number | null): ReconstructedMessage[]
{
    const lines = lineRanges(text).map((r) => classify(text, r.start, r.contentEnd, r.end));
    // The quoted history ends at the first forwarded block the .eml adapter wrote (another message).
    const tool = lines.find((l) => l.depth === 0 && text.slice(l.start, l.contentEnd) === FORWARDED_SEPARATOR);
    const limit = tool === undefined ? text.length : tool.start;
    const headers = findReplyHeaders(text, subject).filter((h) => h.start < limit);

    const kept: ReconstructedMessage[] = [];
    let parentDepth = 0;
    // Step 5: the subject of the nearest newer header that has one (at first the source's own).
    let chainSubject = subject !== undefined && subject.trim() !== '' ? subject : null;
    for (let k = 0; k < headers.length && kept.length < MAX_RECONSTRUCTED; k++)
    {
        const header = headers[k];
        if (header === undefined)
        {
            break;
        }
        const next = headers[k + 1];
        const segmentEnd = Math.min(next?.start ?? limit, limit);
        const nextLine = next === undefined || next.start >= limit ? undefined : lines[lineIndexAt(lines, next.start)];
        const context: ChainContext = { parentDepth, nextHeaderDepth: nextLine === undefined ? null : nextLine.depth };
        const found = candidate(text, lines, header, segmentEnd, context, sourceOffset, kept.length + 1);
        if (found === null)
        {
            kept.pop(); // R1-R4: the holder's end is not known (file comment, REFUSAL)
            break;
        }
        const message = found.message;
        if (found.attribution && chainSubject !== null)
        {
            kept.push({ ...message, subject: chainSubject, subjectFromChain: true });
        }
        else
        {
            kept.push(message);
            if (message.subject !== null && message.subject.trim() !== '')
            {
                chainSubject = message.subject;
            }
        }
        parentDepth = message.depth;
    }
    return kept;
}

/** What the chain above a header says about it (rules R3 and R6). */
interface ChainContext
{
    /** Body depth of the message that holds the header (0 for the source's own text). */
    readonly parentDepth: number;
    /** Depth of the next header's first line; null when the quoted history ends first. */
    readonly nextHeaderDepth: number | null;
}

/** Whether the line is a forward marker ("---------- Forwarded message ---------"), as reply-header.ts reads intros. */
function isForwardMarkerLine(text: string, line: QuotedLine): boolean
{
    if (line.gap || line.contentEnd - line.textStart > MAX_MARKER_LENGTH)
    {
        return false;
    }
    const cleaned = clean(text, line.textStart, line.contentEnd);
    return FORWARD_MARKERS.some((re) => re.test(cleaned));
}

/** Whether every text line of lines [first, ...) before `segmentEnd` is at `depth` (at least one text line). */
function allTextAt(lines: readonly QuotedLine[], first: number, segmentEnd: number, depth: number): boolean
{
    let seen = false;
    for (let j = first; j < lines.length && (lines[j] as QuotedLine).start < segmentEnd; j++)
    {
        const line = lines[j] as QuotedLine;
        if (line.gap)
        {
            continue;
        }
        if (line.depth !== depth)
        {
            return false;
        }
        seen = true;
    }
    return seen;
}

/** The header's own text lines, cleaned and joined as findReplyHeaders joins a wrapped attribution. */
function attributionText(text: string, lines: readonly QuotedLine[], first: number, headerEnd: number): string
{
    const parts: string[] = [];
    for (let j = first; j < lines.length && (lines[j] as QuotedLine).start < headerEnd; j++)
    {
        const line = lines[j] as QuotedLine;
        if (!line.gap)
        {
            parts.push(clean(text, line.textStart, line.contentEnd));
        }
    }
    return joinAttributionLines(parts);
}

/** Message for `header` whose part ends at `segmentEnd`, or null when refused (rules R1-R6). */
function candidate(
    text: string,
    lines: readonly QuotedLine[],
    header: { readonly start: number; readonly headEnd: number; readonly kind: 'reply' | 'forward' },
    segmentEnd: number,
    context: ChainContext,
    sourceOffset: number | null,
    generation: number,
): { readonly message: ReconstructedMessage; readonly attribution: boolean } | null
{
    const parentDepth = context.parentDepth;
    const fields = readQuotedHeader(text, header);
    const headerEnd = fields.headerEnd;
    // R2: the fields end inside the message's part.
    if (headerEnd <= header.start || headerEnd > segmentEnd)
    {
        return null;
    }
    const first = lineIndexAt(lines, header.start);
    if (first < 0)
    {
        return null;
    }

    // R2: header lines at one depth; block or attribution.
    let headerDepth = -1;
    let block = false;
    let introFirst = false;
    let forwardMarker = false;
    let k = first;
    for (; k < lines.length && (lines[k] as QuotedLine).start < headerEnd; k++)
    {
        const line = lines[k] as QuotedLine;
        if (line.gap)
        {
            continue;
        }
        if (headerDepth < 0)
        {
            headerDepth = line.depth;
            introFirst = !isFromLabel(text, line);
            forwardMarker = introFirst && isForwardMarkerLine(text, line);
        }
        else if (line.depth !== headerDepth)
        {
            return null;
        }
        if (!block && isFromLabel(text, line))
        {
            block = true;
        }
    }
    if (headerDepth < 0)
    {
        return null;
    }
    const bodyFirst = k; // first line of [headerEnd, segmentEnd)
    let firstText = -1;
    for (let j = bodyFirst; j < lines.length && (lines[j] as QuotedLine).start < segmentEnd; j++)
    {
        if (!(lines[j] as QuotedLine).gap)
        {
            firstText = j;
            break;
        }
    }
    const noOwnText = firstText < 0; // R6

    // R1: evidence.
    const date = fields.dateText === null ? null : parseQuotedDate(fields.dateText, sourceOffset);
    const dateOk = date !== null && date.wallMs !== null;
    const sender = fields.from.length === 1 ? fields.from[0] : undefined;
    const senderOk = sender !== undefined;
    // Without a readable date, a sender is evidence only with an address or a name-shaped name.
    const senderStrong = sender !== undefined && (sender.address !== '' || (sender.name !== '' && isPlainName(sender.name, false)));
    const evidence = block && !introFirst ? dateOk && senderOk : dateOk || senderStrong;
    if (!evidence)
    {
        return null;
    }

    // Body depth (step 3) and R3.
    let depth: number;
    if (block)
    {
        if (headerDepth !== parentDepth && headerDepth !== parentDepth + 1)
        {
            return null;
        }
        // P1: a forward (marker line first) whose body is nested one level deeper than its header lines
        // (Android mail). Not an Outlook block, even in a forwarded email (user decision F7).
        // Trade-off: a forward whose whole body is ">" lines is rebuilt one level deeper with its marks removed;
        // in plain text that cannot be told apart from the Android shape. No text is lost.
        // With no text of its own (R6), the next header one level deeper tells the same.
        const deeper = noOwnText ? context.nextHeaderDepth === headerDepth + 1 : allTextAt(lines, bodyFirst, segmentEnd, headerDepth + 1);
        const nested = header.kind === 'forward' && forwardMarker && deeper;
        depth = nested ? headerDepth + 1 : headerDepth;
    }
    else
    {
        // A body at the header's own depth (no quote marks added): only with strong evidence (R3).
        const flatAllowed = date !== null && date.wallMs !== null && date.precision === 'minute' &&
            sender !== undefined && sender.address !== '' && isStrongAttribution(attributionText(text, lines, first, headerEnd));
        if (headerDepth === parentDepth + 1)
        {
            // Apple Mail: the attribution is inside the quote, its text at the same depth (none skips a level).
            depth = headerDepth;
            if (!noOwnText && (lines[firstText] as QuotedLine).depth !== headerDepth)
            {
                return null;
            }
        }
        else if (headerDepth !== parentDepth)
        {
            return null;
        }
        else if (noOwnText)
        {
            // R6: no text to read the depth from: the next header's depth tells.
            depth = context.nextHeaderDepth === parentDepth + 1 ? parentDepth + 1 : parentDepth;
        }
        else
        {
            depth = (lines[firstText] as QuotedLine).depth; // Gmail: parentDepth + 1
        }
        if (depth !== parentDepth + 1 && depth !== headerDepth)
        {
            return null;
        }
        if (headerDepth === parentDepth && depth === parentDepth && !flatAllowed)
        {
            return null;
        }
        // F1: a flat attribution with text owns only text at its own depth: a deeper line in its part
        // (a quote) means the unquoted text is the writer's answer around a quote, not a quoted body.
        if (headerDepth === parentDepth && depth === parentDepth && !noOwnText && !allTextAt(lines, bodyFirst, segmentEnd, depth))
        {
            return null;
        }
    }
    if (depth > MAX_QUOTE_DEPTH)
    {
        return null;
    }

    // R4: no text line of the part less deep than the body.
    for (let j = bodyFirst; j < lines.length && (lines[j] as QuotedLine).start < segmentEnd; j++)
    {
        const line = lines[j] as QuotedLine;
        if (!line.gap && line.depth < depth)
        {
            return null;
        }
    }

    const message: ReconstructedMessage = {
        start: header.start,
        headerEnd,
        end: segmentEnd,
        depth,
        generation,
        kind: header.kind,
        from: fields.from,
        to: fields.to,
        cc: fields.cc,
        subject: fields.subject,
        subjectFromChain: false,
        dateText: fields.dateText,
        incomplete: fields.incomplete,
        date,
        dateApproximate: date === null || date.wallMs === null || !hasWrittenZone(date),
        reconstructedText: removeQuoteMarks(text, headerEnd, segmentEnd, depth),
        quoteMarksRemoved: depth > 0,
        noOwnText,
    };
    return { message, attribution: !block };
}
