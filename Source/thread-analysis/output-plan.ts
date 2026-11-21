// The PDF output plan: which parts of each email go into the PDF.
//
// The preview shows every email in full, with quoted history and signatures
// folded (README.md, rule R6). The PDF, by default, shows only what each
// writer actually wrote:
// - the quoted history that the MAIL APP added under a reply header ("On ...
//   wrote:", an Outlook "From: / Sent: / To:" block) is left out, with no
//   marker (the user adds the earlier emails themselves when they want them;
//   the tool does not try to rebuild them);
// - a signature or disclaimer is kept the first time a sender uses it, and
//   left out when the same block comes again later;
// - everything else stays: the writer's own text, point-by-point answers
//   between quoted lines, quotes pasted without a reply header, forwarded
//   emails, and text typed inside or below an Outlook-style quote when the
//   tool can check that quote against the quoted email (rule 2b).
// Also left out (accepted): text the writer pasted at the very END of the
// email, without a reply header, when it is the text of another sender's
// email that is in the PDF too (rule 2, an overlap start): it is in the PDF
// once already. The PDF model checks that afterwards (PRINTED SOMEWHERE in
// Source/pdf-export/build-pdf-document.ts, task 8.13b-3, review round 3): such text that the PDF
// prints nowhere after all (a missing or wrong date can make two emails
// each leave it out because of the other one) is printed where it is.
// Known limit (accepted): an Outlook-style quote has no ">" markers, so where
// it ends can only be checked against the quoted email itself. When that
// email is not among the included emails, text typed inside or below such a
// quote is left out with it. The preview shows what is left out.
// On top of this plan, the PDF leaves out of a body every part it prints as
// an email of its own (a rebuilt email in the PDF, or the real file a
// rebuilt one is linked to), forwarded parts included: the no-repeat rule
// of Source/pdf-export/build-pdf-document.ts (printedElsewhere, user decision 2026-11-06, task
// 8.10). This plan does not know which rebuilt emails are chosen, so it
// still says 'forwarded', kept, for such a part. A range this plan labels
// 'text' (the writer's own, rule 2b included) or a kept signature is never
// left out that way, and a part that holds one is not cut at all (its
// header lines and quote stay around it); quoted header lines stay unless
// the header printed shows all they say (user decisions 2026-11-06, B1 and
// B2; review round 3 of task 8.10). The same rule leaves out of a forwarded
// part the header lines of a rebuilt email with no text, and the pieces
// the preview folds where the rebuild failed (user decisions F2 and F6,
// task 9.9b): this plan still says 'forwarded', kept, for them.
// This plan never changes text: it only marks ranges of the original body as
// kept or left out. The preview, the original files and the "include
// everything" option still give the full text. When a case is not covered by
// a rule below, the text is KEPT.
//
// Everything is driven by OutputPolicy, and each rule is one small function
// (forwardBoundary, quoteBelowHeader, appQuoteTailStart, classifyPieces,
// decideSignature, keepsKind), so a rule can be changed on its own.
//
// Input: the INCLUDED emails, in their final (PDF) order, each with its
// thread analysis segments (fold-segments.ts) and its input position (`index`). The result
// depends on that list (which emails are included, which one is the "first"
// with a signature), so call it again whenever the selection changes. No
// hidden state.
//
// RULES
// 1. Forwards (forwardBoundary). The writer's OWN PART of a body ends at the
//    first forward boundary; everything from there on is FORWARDED and always
//    kept by this plan, folded or not (even when the overlap detector folded
//    it because the forwarded email is also in the batch; the PDF then
//    leaves out the parts it prints as emails of their own, see the
//    no-repeat rule above). A forward boundary is:
//    a. a forward header found by the reply-header detector (findReplyHeaders,
//       kind 'forward': a "Forwarded message" / "Begin forwarded message"
//       / FR / NL marker with its header lines, or the first unmarked header
//       block of a message whose subject starts with "Fwd:", "FW:", "TR:",
//       "Doorst:"...), when it is not inside a ">" quote and not inside an
//       earlier reply header's range (an Outlook reply quoting a forward:
//       there the forward is part of the quoted history);
//    b. the forwarded-message block the .eml reader writes for an attached
//       email (a line equal to FORWARDED_SEPARATOR): another email, always kept.
//    A "-----Original Message-----" block is a forward only when the subject
//    is a forward subject (that is how reply-header.ts tells them apart).
//    And when the SUBJECT is a forward subject, no app quoted history is left
//    out of that email at all (when unsure, keep): what looks like a quote in
//    a forward is the forwarded email.
// 2. App quoted history (appQuoteTailStart). Inside the own part, the TAIL is
//    a suffix [s, ownEnd) of the own part such that:
//    - piece s is a START: either the header lines of a reply header (kind
//      'reply', [start, headEnd) of findReplyHeaders: an attribution, an
//      Outlook block with its intro, a lone "original message" separator),
//      or a fold whose only quote reason is 'quoted-overlap' and that is
//      linked to an INCLUDED email of another sender (that text is in the
//      PDF anyway). Not a start: ">" lines without a reply header (likely
//      pasted by the writer), overlap linked only to emails that are not
//      included (that text would be nowhere in the PDF), overlap linked
//      only to emails of the same sender (a resend, or a disclaimer the
//      signature detector missed), a signature (overlap-quote-detection.ts also folds a
//      sender's repeated signature);
//    - from s to ownEnd there is only folded text and whitespace (signature
//      folds count as folded). So a quote followed by the writer's own,
//      unfolded text (interleaved answers, bottom-posting) is not a tail.
//    The EARLIEST such s is used. The tail is left out (policy
//    appQuotedHistory 'omit'), except whitespace-only text in it that is not
//    folded (rule 4).
// 2b. Text inside or below an Outlook-style quote (quoteBelowHeader).
//    reply-header.ts folds an unmarked header block (and everything below
//    it) to the end of the body, so own text typed inside or below that
//    quote is folded too, and would end up in the tail. For the FIRST
//    unmarked reply header whose quoted region [headEnd, end) runs to the end
//    of the own part:
//    - the FIRST CONFIRMING piece is the first piece of the region with text
//      that is folded 'quoted-overlap' and linked to an INCLUDED email of
//      ANOTHER sender (the writer's own repeated signature, disclaimer or
//      earlier text says nothing about where someone else's quote ends).
//      When there is none, the quote is NOT CONFIRMED (last point).
//    - the QUOTED CHAIN (quotedChain) is the emails that piece is linked to
//      (included, other sender) plus, again and again, every included email
//      they quote (the 'quoted-overlap' links of their own segments): the
//      quoted email and its own history, as far as it is in the PDF.
//    - every other piece of the region (from headEnd to the end of the own
//      part) with a letter, a digit or an emoji that nothing covers is the
//      writer's OWN TEXT. Always covered: the header lines of any header
//      (inside [start, headEnd) of a header), 'quote-marker', 'signature'.
//      Also covered:
//      . AFTER the first confirming piece: 'quoted-overlap' linked to an
//        email of the quoted chain. Not covered there: an answer typed
//        between the quoted lines or below them, text from an email that is
//        not in the quoted chain (another email, or one not in the PDF).
//      . BEFORE it (between the header lines and the first confirming
//        piece): any 'quoted-overlap', and a piece that passes the LINE
//        CHECK (linesInChain). That is the quoted email's own opening, too
//        short for overlap-quote-detection.ts to match ("Hi Bob,", "Friday ok?": a match
//        needs MIN_RUN_WORDS words in a row, and a line typed under it, or a
//        nested header the mail app rewrote, cuts the run). The line check:
//        take the piece's WORD LINES (wordLines: the lines with a letter, a
//        digit or an emoji, normalizeLine: spaces aside); they must be, in
//        the same order and with no other word line between them, word
//        lines of ONE email of the quoted chain, each one a whole line. When
//        no earlier piece of the region (from headEnd) has a word or emoji,
//        they must be that email's FIRST word lines. So a line typed inside
//        that opening, or straight under the header lines, is own text even
//        when the same line ("Yes.", "Thanks,") stands somewhere else in the
//        quoted emails.
//      When there is own text, the email has no tail at all (the whole
//      region is kept, those pieces are labelled 'text'). When unsure, keep:
//      a quoted line the mail app changed also keeps the whole email. A
//      piece with no letter, digit or emoji ("--", "* * *") does not count:
//      it proves nothing either way. An emoji counts (a "thumbs up" answer)
//      although overlap-quote-detection.ts never matches one: an emoji-only line inside a
//      quote lies between quoted lines and is folded with them.
//    - confirmed and no own text (normal top-posting): rule 2 as usual, the
//      quote is left out. Also left out then (accepted): text below the
//      quote that only repeats text of the quoted chain, even text that
//      the PDF does not show elsewhere (a quoted email's own quoted
//      history whose source email is not loaded). Accepted limits too:
//      (a) before the first confirming piece ANY 'quoted-overlap' counts as
//      covered, whatever email it is linked to, so a standard paragraph the
//      writer pastes between the header lines and the quote, repeating an
//      earlier email of their own, is left out with the quote, even when
//      that earlier email is not in the PDF (rare);
//      (b) overlap-quote-detection.ts matches words, ignoring case and punctuation, so a
//      one-word answer such as "OK" typed right under a quoted line that
//      ends in "ok?" can be matched as part of the quote and left out.
//    - not confirmed (the quoted email is not included, so nothing can check
//      where the quote ends): the region counts as folded and rule 2
//      applies: the header and everything below it in the own part are left
//      out. That is the accepted limit described at the top.
// 3. Signatures (decideSignature). A run of folded pieces with reason
//    'signature' outside the tail and the forwarded part is one signature
//    block. With 'first-per-sender', walking the emails in the given order, a
//    block is left out only when the same block (signatureBlockKey, the
//    normalization of signature-detection.ts) was already KEPT in an earlier email of the
//    same sender (senderKeyOf, as signature-detection.ts). A changed signature is kept
//    once. Unknown sender (''): always kept. Signatures inside a left-out tail
//    are left out with it and do not count as kept. (Cosmetic, not handled: a
//    signature fold that includes the closing name can leave the "Thanks,"
//    above it dangling.)
// 4. Never left out: text that is not folded, and anything at all when
//    unfoldEverything is true. If the plan would leave an email with no
//    non-whitespace text kept, the WHOLE body is kept instead and
//    `keptAllBecauseEmpty` is true.
//    Folded whitespace-only pieces outside the tail are labelled 'text'.
// 5. Safety net: if the segments are not a valid cover of the body, or a rule
//    throws, that email is kept whole (`fallback: true`).
//
// Cost: linear in the total body length (the reply-header search is linear,
// every segment is looked at a bounded number of times), plus, for each email
// with a confirmed Outlook-style quote, one walk of the quoted chain (at most
// every included email and its links once) and, for each piece line-checked
// before the first confirming piece, the places of its rarest word line times
// its word lines at most (the line index of the included emails, linear in
// their length, is built once, when first needed).
//
// Pure functions: no DOM, no storage, inputs are never modified (README.md,
// rule R7).

import { FORWARDED_SEPARATOR } from '../email-reading/forwarded-block';
import { findReplyHeaders, isForwardSubject, type FoundHeader } from './reply-header';
import { checkSegments, lineRanges } from './fold-segments';
import { senderKeyOf, signatureBlockKey } from './signature-detection';
import type { MessagePlan, OutputPolicy, PlanRange, PlanReason } from '../../Header/output-plan';
import type { NormalizedMessage } from '../../Header/parsed-email';
import type { FoldReason, Segment } from '../../Header/thread-analysis-result';

export const DEFAULT_OUTPUT_POLICY: OutputPolicy = Object.freeze({
    appQuotedHistory: 'omit',
    signatures: 'first-per-sender',
    unfoldEverything: false,
});

/** What the plan needs per email (an AnalyzedMessage fits). */
export interface PlanInput
{
    readonly message: NormalizedMessage;
    readonly segments: readonly Segment[];
    /**
     * Input position (AnalyzedMessage.index). The `related` links of the
     * segments use these numbers: an email whose index is in the list is
     * INCLUDED (rule 2). Without it, the email is never the target of a link.
     */
    readonly index?: number;
}

/** What rule 2 needs to know about the other emails. */
export interface QuoteContext
{
    /** Whether the email at input position `index` is included (in the PDF). */
    readonly isIncluded: (index: number) => boolean;
    /** Whether the INCLUDED email at input position `index` has this email's sender (both known). */
    readonly sameSender: (index: number) => boolean;
    /**
     * The emails the INCLUDED email at input position `index` quotes: the
     * `related` links of its 'quoted-overlap' segments ([] for an email that
     * is not included). Rule 2b follows them to find a quote's own history.
     */
    readonly quotedLinks: (index: number) => readonly number[];
    /**
     * The word lines (see wordLines) of the INCLUDED email at input position
     * `index` ([] for an email that is not included). Rule 2b checks the quoted
     * opening against the quoted emails with them.
     */
    readonly wordLinesOf: (index: number) => readonly string[];
    /** Where the word line `line` (already normalized) occurs in the INCLUDED emails: see wordLinesOf. */
    readonly linePlaces: (line: string) => readonly LinePlace[];
}

// ------------------------------------------------------------------ rule 1

/**
 * Rule 1: where the writer's own part ends (`ownEnd`, the start of the first
 * forward boundary, or the body length), and whether app quoted history may
 * be left out of this email at all (not for a forward subject).
 * `headers`: findReplyHeaders(bodyText, subject), when already computed.
 */
export function forwardBoundary(
    bodyText: string,
    subject: string,
    headers: readonly FoundHeader[] = findReplyHeaders(bodyText, subject),
): { readonly ownEnd: number; readonly tailAllowed: boolean }
{
    let ownEnd = bodyText.length;
    // a. Forward headers of the detector, sorted by start.
    let replyEnd = 0; // furthest end of an unmarked reply header seen so far
    for (const header of headers)
    {
        if (header.marked)
        {
            continue;
        }
        if (header.kind === 'reply')
        {
            replyEnd = Math.max(replyEnd, header.end);
        }
        else if (header.start >= replyEnd)
        {
            ownEnd = header.start;
            break;
        }
    }
    // b. The .eml reader's own forwarded block.
    for (const line of lineRanges(bodyText))
    {
        if (line.start >= ownEnd)
        {
            break;
        }
        if (bodyText.slice(line.start, line.contentEnd) === FORWARDED_SEPARATOR)
        {
            ownEnd = line.start;
            break;
        }
    }
    return { ownEnd, tailAllowed: !isForwardSubject(subject) };
}

// ------------------------------------------------------------------ pieces

/** A piece of the body: a segment, split at ownEnd and at every header's start and headEnd. */
export interface Piece
{
    readonly start: number;
    readonly end: number;
    readonly folded: boolean;
    readonly reasons: readonly FoldReason[];
    readonly related: readonly number[];
    /** Inside the header lines [start, headEnd) of a reply header (rule 2: a start). */
    readonly replyHeaderLines: boolean;
    /** Inside the header lines of any header, reply or forward (rule 2b: covered). */
    readonly headerLines: boolean;
}

/** Sorted, merged [start, end) intervals. */
function mergeIntervals(list: readonly (readonly [number, number])[]): [number, number][]
{
    const sorted = list.filter(([a, b]) => a < b).sort((x, y) => x[0] - y[0]);
    const out: [number, number][] = [];
    for (const [start, end] of sorted)
    {
        const last = out[out.length - 1];
        if (last !== undefined && start <= last[1])
        {
            last[1] = Math.max(last[1], end);
        }
        else
        {
            out.push([start, end]);
        }
    }
    return out;
}

/** For each piece (sorted, contiguous), whether it lies inside one of `intervals` (pieces never straddle a bound). */
function insideFlags(pieces: readonly { start: number; end: number }[], intervals: readonly [number, number][]): boolean[]
{
    let k = 0;
    return pieces.map((piece) =>
    {
        while (k < intervals.length && (intervals[k]?.[1] ?? 0) <= piece.start)
        {
            k++;
        }
        const interval = intervals[k];
        return interval !== undefined && interval[0] <= piece.start && piece.end <= interval[1];
    });
}

/** The segments as pieces: split at `ownEnd` and at every header's start and headEnd, with the header flags. */
export function toPieces(segments: readonly Segment[], ownEnd: number, headers: readonly FoundHeader[]): Piece[]
{
    const cuts = new Set<number>([ownEnd]);
    for (const header of headers)
    {
        cuts.add(header.start);
        cuts.add(header.headEnd);
    }
    const points = [...cuts].sort((a, b) => a - b);
    const raw: { start: number; end: number; folded: boolean; reasons: readonly FoldReason[]; related: readonly number[] }[] = [];
    let pointIndex = 0;
    for (const segment of segments)
    {
        let from = segment.start;
        while (pointIndex < points.length && (points[pointIndex] ?? 0) <= from)
        {
            pointIndex++;
        }
        while (pointIndex < points.length && (points[pointIndex] ?? 0) < segment.end)
        {
            const cut = points[pointIndex] ?? segment.end;
            raw.push({ start: from, end: cut, folded: segment.folded, reasons: segment.reasons, related: segment.related });
            from = cut;
            pointIndex++;
        }
        raw.push({ start: from, end: segment.end, folded: segment.folded, reasons: segment.reasons, related: segment.related });
    }
    const lines = (keep: (header: FoundHeader) => boolean): [number, number][] =>
        mergeIntervals(headers.filter(keep).map((h) => [h.start, h.headEnd] as const));
    const reply = insideFlags(raw, lines((h) => h.kind === 'reply'));
    const anyHeader = insideFlags(raw, lines(() => true));
    return raw.map((p, i) => ({ ...p, replyHeaderLines: reply[i] === true, headerLines: anyHeader[i] === true }));
}

function hasText(bodyText: string, piece: { start: number; end: number }): boolean
{
    return /\S/.test(bodyText.slice(piece.start, piece.end));
}

/** A letter, a digit (a word, as overlap-quote-detection.ts counts words) or an emoji / pictograph. */
const WORD_OR_EMOJI = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;

/** Whether the piece has a letter, a digit or an emoji (rule 2b: something a writer may have typed). */
function hasWord(bodyText: string, piece: { start: number; end: number }): boolean
{
    return WORD_OR_EMOJI.test(bodyText.slice(piece.start, piece.end));
}

/**
 * Rule 2b: a line as compared with the lines of the quoted emails: NFC, every
 * run of white space (no-break spaces included) as one space, trimmed.
 */
export function normalizeLine(line: string): string
{
    return line.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/**
 * Rule 2b: the WORD LINES of a text: its lines with a letter, a digit or an
 * emoji, normalized (normalizeLine), in order. Lines without one (blank,
 * "--") are skipped, so they never break a run of word lines.
 */
export function wordLines(text: string): string[]
{
    const out: string[] = [];
    for (const line of text.split(/\r\n|\n|\r/))
    {
        if (WORD_OR_EMOJI.test(line))
        {
            out.push(normalizeLine(line));
        }
    }
    return out;
}

/** Rule 2b: where a word line occurs: an email (input position) and the line's place among that email's word lines. */
export interface LinePlace
{
    readonly email: number;
    readonly pos: number;
}

/**
 * Rule 2b: the word lines of every body (input position -> wordLines) and,
 * for every word line, the places where it occurs.
 * Cost: linear in the total length of the bodies.
 */
export function lineIndex(bodies: ReadonlyMap<number, string>): {
    readonly lines: Map<number, string[]>;
    readonly places: Map<string, LinePlace[]>;
}
{
    const lines = new Map<number, string[]>();
    const places = new Map<string, LinePlace[]>();
    for (const [email, text] of bodies)
    {
        const own = wordLines(text);
        lines.set(email, own);
        own.forEach((line, pos) =>
        {
            let list = places.get(line);
            if (list === undefined)
            {
                list = [];
                places.set(line, list);
            }
            list.push({ email, pos });
        });
    }
    return { lines, places };
}

/**
 * Rule 2b, the line check: whether the word lines of `piece` occur, in the
 * same order and with no other word line between them, as word lines of ONE
 * email of `chain`; with `atTop`, they must be that email's FIRST word lines.
 * Cost: the places of the piece's rarest word line, times its word lines at
 * most (a candidate is dropped at its first different line).
 */
function linesInChain(
    bodyText: string,
    piece: { start: number; end: number },
    chain: ReadonlySet<number>,
    atTop: boolean,
    context: QuoteContext,
): boolean
{
    const mine = wordLines(bodyText.slice(piece.start, piece.end));
    if (mine.length === 0)
    {
        return false; // not reached (the caller checks hasWord); when unsure, own text
    }
    // Anchor on the rarest line: every match goes through one of its places.
    let anchor = 0;
    let places = context.linePlaces(mine[0] ?? '');
    for (let k = 1; k < mine.length && places.length > 0; k++)
    {
        const list = context.linePlaces(mine[k] ?? '');
        if (list.length < places.length)
        {
            anchor = k;
            places = list;
        }
    }
    for (const { email, pos } of places)
    {
        const from = pos - anchor; // where the piece's first word line would be in that email
        if (from < 0 || (atTop && from !== 0) || !chain.has(email))
        {
            continue;
        }
        const theirs = context.wordLinesOf(email);
        if (from + mine.length > theirs.length)
        {
            continue;
        }
        let same = true;
        for (let k = 0; k < mine.length && same; k++)
        {
            same = theirs[from + k] === mine[k];
        }
        if (same)
        {
            return true;
        }
    }
    return false;
}

/**
 * Rule 2b: the quoted chain of `start`: those emails and, following
 * QuoteContext.quotedLinks again and again, every INCLUDED email they quote.
 * Cost: at most once per included email.
 */
export function quotedChain(start: readonly number[], context: QuoteContext): ReadonlySet<number>
{
    const chain = new Set<number>(start.filter((r) => context.isIncluded(r)));
    const queue = [...chain];
    for (let q = 0; q < queue.length; q++)
    {
        for (const quoted of context.quotedLinks(queue[q] ?? -1))
        {
            if (!chain.has(quoted) && context.isIncluded(quoted))
            {
                chain.add(quoted);
                queue.push(quoted);
            }
        }
    }
    return chain;
}

// ----------------------------------------------------------------- rule 2b

/**
 * Rule 2b: the writer's own text inside or below the first unmarked reply
 * header whose quoted region runs to the end of the own part. `ownText`: indices
 * (in `pieces`) of the own-text pieces found; empty when the quote is not
 * confirmed or every piece of the region is covered.
 * `confirmed`: the quote could be checked against an included email.
 */
export function quoteBelowHeader(
    bodyText: string,
    pieces: readonly Piece[],
    ownEnd: number,
    headers: readonly FoundHeader[],
    context: QuoteContext,
): { readonly confirmed: boolean; readonly ownText: readonly number[] }
{
    const header = headers.find((x) => x.kind === 'reply' && !x.marked && x.start < ownEnd && x.headEnd < ownEnd && x.end >= ownEnd);
    if (header === undefined)
    {
        return { confirmed: false, ownText: [] };
    }
    // The first confirming piece: text quoted from an included email of ANOTHER sender.
    const first = pieces.findIndex(
        (piece) =>
            piece.start >= header.headEnd &&
            piece.start < ownEnd &&
            hasText(bodyText, piece) &&
            piece.reasons.includes('quoted-overlap') &&
            piece.related.some((r) => context.isIncluded(r) && !context.sameSender(r)),
    );
    if (first < 0)
    {
        return { confirmed: false, ownText: [] };
    }
    const quotedEmails = (pieces[first]?.related ?? []).filter((r) => context.isIncluded(r) && !context.sameSender(r));
    const chain = quotedChain(quotedEmails, context);
    const ownText: number[] = [];
    let atTop = true; // no piece of the region with a word or emoji yet
    for (let i = 0; i < pieces.length; i++)
    {
        const piece = pieces[i];
        if (piece === undefined || piece.start >= ownEnd)
        {
            break;
        }
        if (i === first || piece.start < header.headEnd)
        {
            continue;
        }
        if (!hasWord(bodyText, piece))
        {
            continue; // no word or emoji: proves nothing either way
        }
        const before = i < first; // between the header lines and the first confirming piece
        const covered =
            piece.headerLines ||
            piece.reasons.includes('quote-marker') ||
            piece.reasons.includes('signature') ||
            (piece.reasons.includes('quoted-overlap') && (before || piece.related.some((r) => chain.has(r)))) ||
            (before && linesInChain(bodyText, piece, chain, atTop, context));
        if (!covered)
        {
            ownText.push(i);
        }
        atTop = false;
    }
    return { confirmed: true, ownText };
}

// ------------------------------------------------------------------ rule 2

const QUOTE_REASONS: readonly FoldReason[] = ['reply-header', 'quote-marker', 'quoted-overlap'];

/** Rule 2: whether `piece` may start the tail. */
function isTailStart(piece: Piece, context: QuoteContext): boolean
{
    if (piece.replyHeaderLines)
    {
        return true;
    }
    const quoteReasons = piece.reasons.filter((r) => QUOTE_REASONS.includes(r));
    if (quoteReasons.length !== 1 || quoteReasons[0] !== 'quoted-overlap')
    {
        return false;
    }
    return piece.related.some((r) => context.isIncluded(r) && !context.sameSender(r));
}

/**
 * Rule 2: the index (in `pieces`) of the first piece of the app quoted
 * history, or null. Pieces from `ownEnd` on are not looked at. `ownText`:
 * pieces rule 2b found to be the writer's own text (they stop the tail).
 */
export function appQuoteTailStart(
    bodyText: string,
    pieces: readonly Piece[],
    ownEnd: number,
    context: QuoteContext,
    ownText: readonly number[] = [],
): number | null
{
    if (ownText.length > 0)
    {
        return null; // rule 2b: the whole region is kept, and it runs to ownEnd
    }
    let last = pieces.length - 1;
    while (last >= 0 && (pieces[last]?.start ?? 0) >= ownEnd)
    {
        last--;
    }
    let found: number | null = null;
    for (let i = last; i >= 0; i--)
    {
        const piece = pieces[i];
        if (piece === undefined)
        {
            break;
        }
        if (!piece.folded)
        {
            if (hasText(bodyText, piece))
            {
                break; // the writer's own text: the tail cannot go above it
            }
            continue;
        }
        if (piece.reasons.includes('signature'))
        {
            continue;
        }
        if (isTailStart(piece, context))
        {
            found = i;
        }
    }
    return found;
}

// ------------------------------------------------------------------ rule 3

/**
 * Rule 3: whether a signature block is kept, and how it is labelled.
 * `alreadyKept`: the same block was kept in an earlier email of this sender.
 */
export function decideSignature(
    policy: OutputPolicy,
    alreadyKept: boolean,
): { readonly keep: boolean; readonly reason: 'signature' | 'repeated-signature' }
{
    const reason = alreadyKept ? 'repeated-signature' : 'signature';
    if (policy.unfoldEverything)
    {
        return { keep: true, reason };
    }
    if (policy.signatures === 'none')
    {
        return { keep: false, reason: 'signature' };
    }
    if (policy.signatures === 'first-per-sender')
    {
        return { keep: !alreadyKept, reason };
    }
    return { keep: true, reason }; // 'all' (and, when unsure, an unknown value)
}

// --------------------------------------------------------- other kinds

/** Whether a range of a kind other than a signature is kept. */
export function keepsKind(policy: OutputPolicy, reason: Exclude<PlanReason, 'signature' | 'repeated-signature'>): boolean
{
    if (policy.unfoldEverything)
    {
        return true;
    }
    // Only an explicit 'omit' leaves it out (when unsure, keep).
    if (reason === 'app-quoted-history')
    {
        return policy.appQuotedHistory !== 'omit';
    }
    return true; // 'text', 'writer-quote', 'forwarded'
}

// ------------------------------------------------------------ classifying

/** A piece with its kind, before the signature decision. */
interface Classified
{
    readonly start: number;
    readonly end: number;
    readonly kind: 'text' | 'writer-quote' | 'forwarded' | 'app-quoted-history' | 'signature';
}

/** One email, classified (no policy; other emails only through `context`). */
export interface ClassifiedMessage
{
    readonly pieces: readonly Classified[];
    readonly tailStart: number | null;
}

/** Rules 1, 2 and 2b for one email: the kind of every piece of its body. */
export function classifyPieces(
    bodyText: string,
    subject: string,
    segments: readonly Segment[],
    context: QuoteContext,
): ClassifiedMessage
{
    const headers = findReplyHeaders(bodyText, subject);
    const { ownEnd, tailAllowed } = forwardBoundary(bodyText, subject, headers);
    const pieces = toPieces(segments, ownEnd, headers);
    const below = quoteBelowHeader(bodyText, pieces, ownEnd, headers, context);
    const ownText = new Set(below.ownText);
    const tailIndex = tailAllowed ? appQuoteTailStart(bodyText, pieces, ownEnd, context, below.ownText) : null;
    const tailStart = tailIndex === null ? null : (pieces[tailIndex]?.start ?? null);
    const classified = pieces.map((piece, i): Classified =>
    {
        let kind: Classified['kind'];
        if (piece.start >= ownEnd)
        {
            kind = 'forwarded';
        }
        else if (!piece.folded || ownText.has(i))
        {
            kind = 'text';
        }
        else if (tailStart !== null && piece.start >= tailStart)
        {
            kind = 'app-quoted-history';
        }
        else if (piece.reasons.includes('signature'))
        {
            kind = 'signature';
        }
        else if (!hasText(bodyText, piece))
        {
            kind = 'text';
        }
        else
        {
            kind = 'writer-quote';
        }
        return { start: piece.start, end: piece.end, kind };
    });
    return { pieces: classified, tailStart };
}

// --------------------------------------------------------------- the plan

function wholeBody(body: string, fallback: boolean): MessagePlan
{
    return {
        ranges: body.length === 0 ? [] : [{ start: 0, end: body.length, keep: true, reason: 'text' }],
        tailStart: null,
        omittedSignatures: 0,
        keptAllBecauseEmpty: false,
        fallback,
    };
}

/** Appends a range, merging it into the previous one when keep and reason match. */
function push(ranges: PlanRange[], range: PlanRange): void
{
    const last = ranges[ranges.length - 1];
    if (last !== undefined && last.keep === range.keep && last.reason === range.reason && last.end === range.start)
    {
        ranges[ranges.length - 1] = { ...last, end: range.end };
    }
    else
    {
        ranges.push(range);
    }
}

/**
 * Plans the PDF text of every included email (see the rules at the top).
 * `messages`: the included emails in PDF order. Returns one plan per email,
 * same order. Never throws for one bad email (it is kept whole).
 */
export function planOutput(messages: readonly PlanInput[], policy: OutputPolicy = DEFAULT_OUTPUT_POLICY): MessagePlan[]
{
    return Array.from(planOutputSteps(messages, policy));
}

/**
 * planOutput one email at a time: yields the plan of each email, in order
 * (the same plans, by the same code). The page uses it to spread the work
 * over several short tasks (Source/web-page/pdf-labels.ts), so it never freezes. The
 * caller must not change `messages` while it runs.
 */
export function* planOutputSteps(messages: readonly PlanInput[], policy: OutputPolicy = DEFAULT_OUTPUT_POLICY): Generator<MessagePlan, void, undefined>
{
    const senderKeys = messages.map((input) =>
    {
        try
        {
            return senderKeyOf(input.message);
        }
        catch
        {
            return '';
        }
    });
    // Input position -> sender key, for the included emails.
    const keyByIndex = new Map<number, string>();
    // Input position -> the emails it quotes (its 'quoted-overlap' links), for the included emails.
    const linksByIndex = new Map<number, readonly number[]>();
    // Input position -> body, for the included emails; their line index is built once, when rule 2b first needs it.
    const bodyByIndex = new Map<number, string>();
    let lines: ReturnType<typeof lineIndex> | undefined;
    const wordLinesOf = (email: number): readonly string[] =>
    {
        lines ??= lineIndex(bodyByIndex);
        return lines.lines.get(email) ?? [];
    };
    const linePlaces = (line: string): readonly LinePlace[] =>
    {
        lines ??= lineIndex(bodyByIndex);
        return lines.places.get(line) ?? [];
    };
    messages.forEach((input, k) =>
    {
        if (typeof input.index !== 'number')
        {
            return;
        }
        keyByIndex.set(input.index, senderKeys[k] ?? '');
        bodyByIndex.set(input.index, input.message.bodyText);
        const links = new Set<number>();
        try
        {
            for (const segment of input.segments)
            {
                if (segment.reasons.includes('quoted-overlap'))
                {
                    for (const linked of segment.related)
                    {
                        links.add(linked);
                    }
                }
            }
        }
        catch
        {
            // Malformed segments: no links (that email is kept whole anyway, rule 5).
        }
        linksByIndex.set(input.index, [...links]);
    });

    // Sender key -> signature blocks (signatureBlockKey) kept so far.
    const keptSignatures = new Map<string, Set<string>>();

    for (const [k, input] of messages.entries())
    {
        yield planOne(input, k);
    }

    function planOne(input: PlanInput, k: number): MessagePlan
    {
        const body = input.message.bodyText;
        if (body.length === 0)
        {
            return wholeBody(body, false);
        }
        const sender = senderKeys[k] ?? '';
        const context: QuoteContext = {
            isIncluded: (index) => keyByIndex.has(index),
            sameSender: (index) => sender !== '' && keyByIndex.get(index) === sender,
            quotedLinks: (index) => linksByIndex.get(index) ?? [],
            wordLinesOf,
            linePlaces,
        };
        let classified: ClassifiedMessage;
        try
        {
            if (checkSegments(body, input.segments).length > 0)
            {
                return wholeBody(body, true);
            }
            classified = classifyPieces(body, input.message.subject, input.segments, context);
        }
        catch
        {
            return wholeBody(body, true);
        }

        let ranges: PlanRange[] = [];
        const newlyKept: string[] = [];
        let omittedSignatures = 0;
        const pieces = classified.pieces;
        let i = 0;
        while (i < pieces.length)
        {
            const piece = pieces[i];
            if (piece === undefined)
            {
                break;
            }
            if (piece.kind !== 'signature')
            {
                push(ranges, { start: piece.start, end: piece.end, keep: keepsKind(policy, piece.kind), reason: piece.kind });
                i++;
                continue;
            }
            // A run of signature pieces is one block.
            let j = i;
            while (j + 1 < pieces.length && pieces[j + 1]?.kind === 'signature')
            {
                j++;
            }
            const end = pieces[j]?.end ?? piece.end;
            const key = signatureBlockKey(body.slice(piece.start, end));
            const alreadyKept = sender !== '' && (keptSignatures.get(sender)?.has(key) ?? false);
            const decision = decideSignature(policy, alreadyKept);
            if (decision.keep)
            {
                newlyKept.push(key);
            }
            else
            {
                omittedSignatures++;
            }
            push(ranges, { start: piece.start, end, keep: decision.keep, reason: decision.reason });
            i = j + 1;
        }

        // Rule 4: nothing with text left -> keep the whole body.
        const keptAllBecauseEmpty = /\S/.test(body) && !ranges.some((r) => r.keep && /\S/.test(body.slice(r.start, r.end)));
        if (keptAllBecauseEmpty)
        {
            const all: PlanRange[] = [];
            for (const range of ranges)
            {
                push(all, { ...range, keep: true });
            }
            ranges = all;
            omittedSignatures = 0; // a block left out was already kept earlier: nothing new to record
        }

        // Recorded after the whole email: a block repeated inside one email is not "earlier".
        if (sender !== '')
        {
            let set = keptSignatures.get(sender);
            if (set === undefined)
            {
                set = new Set();
                keptSignatures.set(sender, set);
            }
            for (const key of newlyKept)
            {
                set.add(key);
            }
        }

        return { ranges, tailStart: classified.tailStart, omittedSignatures, keptAllBecauseEmpty, fallback: false };
    }
}
