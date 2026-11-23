// The PDF document model: everything the PDF will say, as plain data, before
// any layout. A renderer (our own PDF writer, or a library later) turns it
// into pages; this file knows nothing about pages, coordinates, fonts, sizes
// or PDF syntax, so the renderer can be replaced without touching it.
//
// buildPdfDocument() takes the thread analysis result, the INCLUDED emails (list
// positions, in list order) with their output plans (Source/thread-analysis/output-plan.ts,
// the same plans the preview labels show, Source/web-page/pdf-labels.ts), the policy,
// the generation moment and the fixed texts, and returns a
// PdfDocument:
// - cover: title, date range, people, email count and generation date (as
//   `blocks` for the renderer, and as data), of the emails in the
//   PDF (an email left out for having no text does not count, task 8.14);
//   no source files and no SHA-256 (user decision 2026-11-09, task 8.12);
// - index: one entry per email (number, date, author, subject, attachment
//   count and lines, anchor, bookmark title); the renderer resolves each
//   anchor to a page number;
// - emails: per email its header rows, notes, body lines and attachments.
//
// Numbering: every email in the PDF, real or rebuilt, is numbered 1..n in
// PDF order (the timeline, planPdfOrder): two rebuilt older emails and the
// email they were read from are emails 1, 2 and 3. Headings, the index, the
// bookmarks and the links ("email-N" anchors) all use these numbers. The
// preview's "#N" is the list number (every real email, included or not), so
// the two differ once an email is left out (unticked, or with no text: see
// NO-TEXT EMAILS below) or a rebuilt email comes first:
// `pdfNumberByPosition` maps a list position to the PDF number of its real
// email (null when not in the PDF).
//
// Rebuilt emails (milestone 7, tasks 7.7 and 8.3; brief section 8.6):
// earlier emails rebuilt from the quoted text of an email
// (Source/thread-analysis/link-rebuilt-messages.ts), the ones the reader chose (`rebuilt`,
// Source/web-page/review.ts includedRebuilt), at their place in the timeline
// (planPdfOrder). USER DECISION 2026-11-02 (task 8.3, an approved exception
// to brief section 8.6, for the PDF only): in the PDF a rebuilt email looks
// and is numbered exactly like a real one. Nothing in the PDF says or shows
// that it was rebuilt: the same heading ("Email N"), the same rows (From, To
// and Cc when there are any, Date, Subject; no File row, as it has no
// file), the same "Unknown sender", "(no subject)" and "no date" texts as a
// real email, its date shown as a real email's (a time as written, never
// converted, task 9.9c; a day alone as that day; a date that could not be
// read as written), no
// marker in the index or the bookmarks. On the cover it counts in "Emails", the date
// range and the people like a real email. The
// PREVIEW keeps marking rebuilt emails (Source/web-page/preview.ts), unchanged.
// PdfEmail.rebuilt and PdfIndexEntry.rebuilt still tell the two apart in
// the data (for tests and checks); the renderer never prints them.
// FOLLOW-SOURCE RULE (user decision Q1 (a)): a rebuilt email is in the PDF
// only while at least one email it was read from is (rebuiltInPdf in
// Source/web-page-logic/rebuilt-email-display.ts); for a text quoted in several emails, the text
// and header shown are the ones read from its own source when that one is
// in the PDF, else from the source in the PDF that comes first.
// Its text is the rebuilt text (under the moved header lines, see below)
// less the signature blocks rule 3 of Source/thread-analysis/output-plan.ts
// leaves out, applied across the real and rebuilt emails in PDF order
// (task 9.9b-2, user decision F4; rebuiltPlans, SIGNATURES IN REBUILT EMAILS).
// NO-REPEAT RULE (user decision 2026-11-06, task 8.10): when "Print full
// original text" is off, no email is printed twice. A part of a real
// email's body that the PDF prints as an email of its own is left out of
// that body, like quoted history (printedElsewhere,
// withoutPrintedElsewhere): the place a rebuilt email in the PDF was read
// from (it, or a copy of it), and the place of a rebuilt email linked to
// a real email that is in the PDF ("the real file wins"). This is what
// stops a forward from printing its forwarded emails inline when they are
// also printed on their own pages (the plan keeps a forwarded part, rule 1
// of Source/thread-analysis/output-plan.ts). The preview labels each such part with
// the email that prints it, from the same calculation (applyNoRepeatRule,
// printedElsewhereParts, pdfRanges; Source/web-page-logic/printed-elsewhere.ts,
// task 8.11).
// - THE WRITER'S OWN TEXT STAYS, ATTRIBUTION FIRST (user decision
//   2026-11-06, B1; review round 3 of task 8.10, findings 1 and S5): text
//   the plan calls the writer's own (reason 'text') or a kept signature is
//   never left out this way. A place whose text (after its header lines,
//   headerLinesEnd) holds any of it (text other than white space) is NOT
//   CUT AT ALL: its header lines and quoted text stay around that text
//   exactly as the plan says (holdsOwnText), so the writer's answer is
//   never printed right under the quoted sender's header lines. When only
//   the place's header lines hold it (a wrapped To / Cc line or a Subject
//   line the plan took for own text), those header lines stay whole and
//   its text may still go. The plan labels 'text' an answer typed
//   inside or below an unmarked Outlook quote (output-plan.ts rule 2b).
//   ALLOWED REPEAT: the rebuilt email prints that place too (it cannot tell
//   where the quoted email ends). When unsure, keep.
// - HEADER LINES (B2): the header lines of a place that is cut ([start,
//   headerEnd) of the rebuilt message) are left out only when the header
//   rows printed for it show everything they say (headerShownInPdf): no
//   Bcc line, no label written twice, exactly one sender, a date read, no
//   list that may go on, a subject when the lines hold one; for a rebuilt
//   email printed, also a sender name and a date with its own zone (or a
//   day, or a date shown as written); for a part linked to a real file in
//   the PDF, a moment with its own zone, or an estimated one when the link
//   has a strong date match (user decision 2026-11-07, S4), the sender in
//   that file's From, the same subject, and every recipient in that file's
//   To or Cc (by address, with the same display name when both have one,
//   task 8.11, G3; or by name for a name-only recipient, S3).
//   Otherwise they stay in the body (ALLOWED REPEAT: only header lines may
//   repeat, never email text), so that, say, an estimated date or a Bcc
//   line is still printed as written somewhere.
// A rebuilt email NOT in the PDF (its card unticked, the switch off, its
// source not in the PDF) leaves its text exactly where the plan puts it,
// so nothing printed elsewhere is left out twice and nothing is lost: what
// is left out is always printed as another email, and "Print full original
// text", the preview and the original files still give every character. A
// forward with no text of its own whose forwarded emails are all on their
// own pages shows the "(no text)" placeholder (it is NOT left out like an
// email with no text: its body has text, printed elsewhere; Q6 of task
// 8.14). `flags.printedElsewhere` (data only) tells when the rule left
// something out. Known repeats this
// rule cannot remove (when unsure, the tool shows text twice rather than
// lose it): a rebuilt email that link-rebuilt-messages.ts could not prove to be
// the same as a real file (both are printed), the text a forwarded part
// that could not be rebuilt at all shows unfolded (even when its email is
// also in the PDF as a real file; its folded pieces are left out, F6 below),
// the same old email kept inline in two real
// emails while its rebuilt email is unticked, a body whose plan failed
// (printed whole), the allowed repeats of B1 and B2 above, and, from B1, a
// KNOWN, DELIBERATE REPEAT (user decision 2026-11-07, option A of review
// finding 3a): a middle email of an unmarked Outlook chain whose own file
// is not in the PDF (say only the first and the last files are added).
// Rule 2b cannot check it against its file, so it cannot prove that piece
// is only a quote; it labels it the writer's own text, so its whole place
// stays in the quoting email while its rebuilt email prints it too (as
// before task 8.10; the user unticks that rebuilt email or adds the file).
// ATTACHED EMAILS (task 8.13b-3, user decisions 2026-11-10): an email
// attached inside a dropped file is a real email of the thread analysis's list
// (Header/thread-analysis-result.ts, AnalyzedAttachedMessage), so it gets its own slot, number,
// index entry and page like any other (Q1, Q2: its own tick). Its File row
// names the file and each attachment down to it ("parent.eml ›
// forwarded.eml", fileRowLine, Q5). With "Print full original text" off,
// the no-repeat rule above also covers it: its printed block in the body of
// an email holding it (an inline forward in an .eml: AnalyzedAttachedMessage.places)
// is left out of that body as follows (attachedBlockParts).
// - In the PDF (`printedAs` kind 'email'), ONLY THE PARTS ITS OWN PAGE
//   PRINTS are left out (task 8.13b-3, review round 4, M1, user decision
//   option a; blockClaims): its header lines, when its header rows show
//   all of its header data (AnalyzedAttachedMessage.keptShowsHeader), and the pieces
//   of its text its page prints (its plan's kept ranges; a piece its page
//   leaves out as printed by another email keeps that email as its label).
//   Whatever its page leaves out (quoted history of an older email that is
//   not in the PDF, say, with rebuilding off, nothing chosen or nothing
//   rebuilt) stays in the holder's body, as the holder's plan says: printed
//   twice rather than nowhere. The block's text is the attached email's
//   body as the parser wrote it (or, for a merged copy, the same text as
//   de-duplication compares bodies), found with mapOffsets; when it cannot
//   be matched for certain, the whole block stays.
// - Not in the PDF (the reader unticked it; kind 'unticked-attached', Q3):
//   the whole block, like an unticked forward of task 8.13a, less what an
//   attached email in the PDF inside it does not print itself. Not in the
//   PDF for having no text and no attachments (kind 'no-text-attached'):
//   the whole block too; one with attachments keeps its block (see NO-TEXT
//   EMAILS below).
// A merged copy: the block follows the kept copy (printed as it, or left
// out when it is unticked; Q8); a dropped file's copy is always the one
// kept (D2), and when it lacks header data the attached copy has (a Bcc
// line, a date), the block's header lines stay. A holder merged into
// another copy: the thread analysis moves the place to the kept copy (S1,
// analyze-thread.ts settleAttached), so an unticked attached email is printed in
// no copy of it. The block is exactly the attached email's text as the
// parser wrote it, so no writer's answer can sit inside it: the B1 check
// above does not apply to it. When the attached email could not be read,
// there is no attached email and no block to cut. With "Print full
// original text" on, every body is printed whole and every attached email
// ALSO as its own email (Q4).
// PRINTED SOMEWHERE (task 8.13b-3, review round 3, finding M2; collapse,
// never delete): the plan leaves out text with no quote mark and no reply
// header of its own when another email in the PDF holds it (output-plan.ts
// rule 2, an overlap start: "that text is in the PDF anyway"), and the
// no-repeat rule cuts blocks printed as other emails. Each decision is
// right on its own, but they can point at each other: with a missing or
// wrong date, email X's paragraph is folded as quoted from its reply Y,
// while Y's page leaves its own "> " quote of it out as quoted history:
// printed nowhere (in round 3 the same happened through the block of an
// attached reply; since round 4 that block keeps what the reply's page
// leaves out). So, after every other decision, each such piece the plan leaves
// out (printedNowhere) is checked against the text the PDF really prints
// (Source/pdf-export/printed-somewhere-check.ts: words only, whole sentences); one printed
// nowhere is printed where it is after all (NoRepeatResult.restored; the piece
// keeps the plan's reason, kept). Pieces are checked in PDF order and a
// restored one counts as printed for the next ones, so a paragraph two
// emails each leave out "because the other one has it" comes back once, in
// the first. It may still print twice (accepted: never nowhere). The same
// calculation gives the preview's labels (Source/web-page-logic/printed-elsewhere.ts:
// a restored piece is labelled "In the PDF"). Quoted history under a reply
// header or behind ">" marks is not such a piece: it is left out by the
// plan's own rule, whether or not its email is in the PDF, as before.
// NO-TEXT EMAILS (task 8.14; user decisions 2026-11-09 and 2026-11-15, a
// NARROW, deliberate exception to README.md, rule R6, and to brief section
// 8.5): an email with no text (Source/web-page-logic/no-printable-text.ts, hasNoPrintableText:
// its body is only white space, and no parser warning says its text could
// not be read) is left out of the PDF entirely, attachments or not, in both
// modes: no slot (planPdfOrder), so no number (the others are numbered
// 1..n without a gap), no index entry, no bookmark, and it does not count on
// the cover (count, date range, people; Q1). Nothing it holds is lost: it
// holds only white space. Its pdfNumberByPosition is null, so the preview's
// "Email N in the PDF" labels never name it. A rebuilt email whose rebuilt
// text has no text is left out the same way (Q4,
// rebuiltHasNoPrintableText): it gets no slot. And its quoted header lines
// (its whole place: header lines only) are printed nowhere either (user
// decision F2, 2026-11-19, task 9.9b: "no lone header lines anywhere in
// the PDF"): the no-repeat rule leaves them out of the email it was read
// from (`printedAs` kind 'no-text'), wherever its plan put them (a forward,
// whose forwarded part the plan keeps, included), whatever the reader
// ticked, with "Rebuild conversation from replies" on or off. Before task
// 9.9b they stayed where the plan put them, so a forward printed them. They
// are printed only with `policy.unfoldEverything` ("Print full original
// text"), and stay visible in the preview (labelled "Not in the PDF") and in
// the original file. An attached email left out this way (no text) that
// has NO attachments has its printed block (the attached-email separator
// line and its header lines) printed nowhere either (user decision Q5,
// 2026-11-21: F2 for attached emails): the no-repeat rule leaves it out of
// every email holding it (`printedAs` kind 'no-text-attached',
// attachedBlockParts). One WITH attachments (a phone forward of a PDF, say)
// keeps its block in every email holding it, as the holder's plan says
// (user decision 2026-11-22): the PDF still says who sent the files and
// when, and the preview labels nothing of it as left out. One the reader
// unticked is cut either way (kind 'unticked-attached', Q3). Its
// attachments stay listed where they were (the holder's list); "Print full
// original text" prints the block, as before.
// The "(no text)" placeholder stays for a text that could not be read (Q2:
// the warnings of Source/web-page-logic/no-printable-text.ts) and for a body with text whose
// every part is printed elsewhere (a forward whose forwarded emails are on
// pages of their own, see the no-repeat rule; Q6).
// FULL ORIGINAL TEXT RULE ("Print full original text"; user decision
// 2026-10-28, task 7.8b, kept as a safety net in task 7.8c): with
// `policy.unfoldEverything` NO rebuilt email is in the PDF, whatever
// `rebuilt` says: every source email is then printed whole, quoted history
// included, so a rebuilt email would only print that text twice.
//
// Body: the plan's KEPT ranges, less the parts printed elsewhere (the
// no-repeat rule above), plus the pieces PRINTED SOMEWHERE restores,
// joined in order (Source/pdf-export/pdf-text-transforms.ts, joinKept):
// nothing is written where a part is left out (README.md, rule R6, the
// exception for the PDF), except a line break when two kept parts would
// otherwise run together on one line. With `policy.unfoldEverything` the
// whole body is used, whatever the plan says. A plan that is missing or not
// a valid list of ranges (null included) keeps the whole body too (flag
// `planFallback`): when unsure, keep. Then the display-only transforms of
// Source/pdf-export/pdf-text-transforms.ts apply (line ends, tabs, control and broken characters as
// codes in runs of role 'code', blank lines). That file also holds the
// contract with the renderer about invisible characters.
// Quote marks (user decisions 2026-11-02, task 8.1, and 2026-11-05, task
// 8.6, PDF only): a body line that starts with ">" quote marks is shown
// WITHOUT them (Source/pdf-export/pdf-text-transforms.ts transform g). Quote levels are not kept:
// the renderer indents every body line by one fixed step, one tab (4 spaces
// of the body font; Source/pdf-export/page-layout/layout-config.ts, bodyIndentSpaces, task 8.9),
// quoted or not. Only the prefix is
// removed; the rest of the line is unchanged. This applies to the kept
// parts of a body, to the whole body under "Print full original text" and
// to the deeper quotes left in a rebuilt email's text (whose own quote
// marks the thread analysis removed already). The preview and the original files
// (and their SHA-256) are unchanged.
//
// No notes in the PDF (user rule 2026-11-05, task 8.8): the PDF is the
// final product. Nothing in it says that something went wrong, may be
// missing or inaccurate, or how the tool works; the app says all of that in
// step 2 before the download (Source/web-page/review.ts, Source/web-page/preview.ts). The PDF
// keeps only the placeholders of blank fields ("(no subject)", "(no date)",
// "Unknown sender", "(no text)" (only where NO-TEXT EMAILS above keeps it),
// "(attachment without a name)"), the page
// footer, headings, labels, the index and the bookmarks. The data behind the
// removed notes stays in the model (`flags`, `cover.undated`,
// `controlChars`), for tests and checks; the renderer never prints it.
//
// Dates (user decision, task 9.9c): every date is printed AS WRITTEN, the
// sender's own wall-clock time, never converted to another time zone, with
// no offset and no time-zone row (Source/thread-analysis/time-format.ts). A
// rebuilt email's date is its quoted time as written, never marked as a
// guess. Only the ORDER uses true moments: the cover's first and last dates
// are the earliest and latest moments (a real email's UTC moment, a rebuilt
// email's estimated one, QuotedDate.estimatedUtcMs), printed as written.
// The generation date is the reader's own clock (`generatedOffsetMinutes`).
//
// Undated emails: shown with the "no date" text in the index; their Date
// row shows the date text as written when there is one, else "no date". The
// cover's date range covers the dated emails only (real and rebuilt; a
// rebuilt email dated by a day alone counts from the estimated start of
// that day and shows as that day); with no dated
// email at all it shows "no date". Real undated emails are at the end of
// the list, in file order (Source/thread-analysis/chronological-order.ts).
//
// No source files on the cover (user decision 2026-11-09, task 8.12, which
// replaces the list with SHA-256 of brief section 8.5): no heading, no file
// names, no hashes. The index follows the cover information directly
// (Source/pdf-export/page-layout/email-index-table.ts). Each real email still names its file in
// its own File row. Files that could not be read are not in the PDF at all
// (step 1 of the app lists them with the reasons). The cover has no text
// about rebuilt emails either (task 8.3, checked again in task 8.7).
//
// Safety: email text is plain data here. It is never read as markup or
// code (README.md, rule R4); the renderer writes it as text. Nothing is
// stored (README.md, rule R5). The stored messages are never changed: every
// transform makes new strings. Pure function, no DOM, no clock (the caller
// passes `generatedAt`), README.md, rule R7.

import { FORWARDED_SEPARATOR } from '../email-reading/forwarded-block';
import { lineRanges } from '../thread-analysis/fold-segments';
import { headerLabelCounts } from '../thread-analysis/quoted-header';
import { comparableText, nameWordsOf, signatureStart, wordsOf } from '../thread-analysis/link-rebuilt-messages';
import { planRebuiltText } from '../thread-analysis/output-plan';
import { mapOffsets } from '../thread-analysis/same-text-offsets';
import { senderKeyOf, senderKeyOfMailboxes, signatureBlockKey } from '../thread-analysis/signature-detection';
import { formatEmailDate, formatWallClock, isDisplayableMs, type WallClockTime } from '../thread-analysis/time-format';
import { displayAuthor } from '../web-page-logic/display-author';
import { FILE_CHAIN_SEPARATOR, fileChain } from '../web-page-logic/file-chain';
import { joinMailboxes } from '../web-page-logic/mailbox-list';
import { hasNoPrintableText, rebuiltHasNoPrintableText } from '../web-page-logic/no-printable-text';
import { previewOrder, rebuiltDate, rebuiltInPdf } from '../web-page-logic/rebuilt-email-display';
import { createPrintedText } from './printed-somewhere-check';
import { bodyLines, inlineRuns, joinKeptLines, lineText } from './pdf-text-transforms';
// Pure and backend-neutral (it only reads Source/pdf-export/pdf-text-transforms.ts): the bookmark cut follows the same rule as the copy layer.
import { copyLayerCutIndex } from './pdf-writer/copy-layer-text';
import type { MessagePlan, OutputPolicy, PlanRange } from '../../Header/output-plan';
import type { EmailAddress, NormalizedMessage } from '../../Header/parsed-email';
import type { PdfBlock, PdfDocument, PdfEmail, PdfFieldRow, PdfIndexEntry, PdfLine, PdfParticipant, PdfRange, PdfRole, PdfStrings, PrintedAs } from '../../Header/pdf-document-model';
import type { RebuiltInPdf } from '../../Header/preview-display';
import type { AnalyzedRebuiltMessage, ReconstructedMessage } from '../../Header/rebuilt-emails';
import type { AnalyzedAttachedMessage, AnalyzedMessage, Segment, ThreadAnalysisResult } from '../../Header/thread-analysis-result';

// ---------------------------------------------------------------- the shape

export interface BuildPdfInput
{
    readonly result: ThreadAnalysisResult;
    /** List positions of the included emails, in list order (Source/web-page/review.ts, includedPositions). */
    readonly positions: readonly number[];
    /** One plan per position, same order (Source/web-page/pdf-labels.ts, currentPlans). */
    readonly plans: readonly MessagePlan[];
    readonly policy: OutputPolicy;
    /** When the PDF is made, in ms since 1970 UTC. */
    readonly generatedAt: number;
    /**
     * The offset of the reader's clock from UTC at `generatedAt`, in minutes
     * (e.g. 60 in Brussels in winter): the generation date is printed on the
     * reader's own clock. Not a finite number: UTC.
     */
    readonly generatedOffsetMinutes: number;
    readonly strings: PdfStrings;
    /**
     * Ids (in `result.reconstructed`) of the rebuilt emails the reader wants in
     * the PDF (Source/web-page/review.ts, includedRebuilt; [] or absent when the switch
     * is off). Each still follows the emails it was read from (planPdfOrder).
     * Ignored (none in the PDF) when `policy.unfoldEverything` is true.
     */
    readonly rebuilt?: readonly number[];
    /**
     * True when "Rebuild conversation from replies" is off (Source/web-page/review.ts,
     * rebuiltShown false): no rebuilt email figures at all, so none counts as
     * unticked and a forwarded part stays in its forward as the plan says
     * (task 8.13a, Q2 applies only to a rebuilt email the reader UNTICKED):
     * `unticked` is ignored then. Absent: false.
     */
    readonly rebuildingOff?: boolean;
    /**
     * Ids (in `result.reconstructed`) of the rebuilt emails whose card the
     * reader saw and UNTICKED while the switch is on (Source/web-page/review.ts,
     * untickedRebuilt; task 8.13a review round 2): only a forwarded part of
     * one of these is left out of its forward (Q2). An entry merely missing
     * from `rebuilt` (a card that could not be shown, a list that fell back
     * to the plain order) is NOT unticked: its text stays where the plan puts
     * it. Absent or []: none (when unsure, keep). An id also in `rebuilt`
     * does not count. Ignored when `rebuildingOff` or
     * `policy.unfoldEverything` is true.
     */
    readonly unticked?: readonly number[];
}

// ---------------------------------------------------------------- helpers

/** The reader's clock at `generatedAt` (see BuildPdfInput.generatedOffsetMinutes), as a wall-clock time. */
function generatedTime(generatedAt: number, generatedOffsetMinutes: number): WallClockTime
{
    if (!isDisplayableMs(generatedAt))
    {
        return { kind: 'no-date' };
    }
    const offset = Number.isFinite(generatedOffsetMinutes) ? generatedOffsetMinutes : 0;
    return formatWallClock(generatedAt + offset * 60_000);
}

/**
 * The PDF file name in the PDF's language, from the date of `generatedAt`
 * on the reader's clock: "correspondence-YYYY-MM-DD.pdf" in English.
 */
export function pdfFileName(generatedAt: number, generatedOffsetMinutes: number, strings: Pick<PdfStrings, 'fileName'>): string
{
    const shown = generatedTime(generatedAt, generatedOffsetMinutes);
    return strings.fileName(shown.kind === 'date' ? shown.text.slice(0, 10) : null);
}

/** Longest bookmark title, in code points (the "..." included). */
export const MAX_BOOKMARK_LENGTH = 120;

/** Characters that belong to the one before them: combining marks (variation selectors included) and skin tone modifiers. */
const ATTACHED_TO_PREVIOUS = /^[\p{M}\p{Emoji_Modifier}]$/u;
function isRegionalIndicator(character: string | undefined): boolean
{
    const codePoint = character?.codePointAt(0);
    return codePoint !== undefined && codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

/**
 * How many of `points` a bookmark keeps, at most `limit`: the cut moves back
 * until it splits nothing a reader sees as one character. The copy layer's
 * own rule (copyLayerCutIndex: never inside a surrogate pair, a kept flag or
 * a ZWJ emoji chain), plus: never between a character and the marks or skin
 * tone after it, never inside a regional-indicator pair (a flag). Not full
 * Unicode grapheme segmentation (Intl.Segmenter is not used, as its data
 * differs between engines and versions); these are the cases whose split
 * would change or break what is drawn.
 * A subject made only of combining marks / skin tones, or of one huge ZWJ
 * chain, can be cut to nothing: that email's bookmark then shows only
 * "N. date, From: ..." (acceptable; the text itself is untouched on the pages).
 */
function bookmarkKeptCount(points: readonly string[], limit: number): number
{
    const text = points.join('');
    let cut = limit;
    for (;;)
    {
        let nextCut = Array.from(text.slice(0, copyLayerCutIndex(text, points.slice(0, cut).join('').length))).length;
        // A dropped mark takes the character it belongs to along (and the marks before it).
        while (nextCut > 0 && ATTACHED_TO_PREVIOUS.test(points[nextCut] ?? ''))
        {
            nextCut--;
        }
        // Regional indicators pair from the start of their run: an odd count before the cut splits a pair.
        let indicatorsBefore = 0;
        while (indicatorsBefore < nextCut && isRegionalIndicator(points[nextCut - 1 - indicatorsBefore]))
        {
            indicatorsBefore++;
        }
        if (indicatorsBefore % 2 === 1 && isRegionalIndicator(points[nextCut]))
        {
            nextCut--;
        }
        if (nextCut === cut)
        {
            return cut;
        }
        cut = nextCut;
    }
}

/**
 * A bookmark title from texts already made one-line by inlineRuns (no line
 * breaks, no tabs, control characters as codes, Source/pdf-export/pdf-text-transforms.ts): cut to
 * MAX_BOOKMARK_LENGTH code points, ending with U+2026 when cut. The cut
 * never splits an emoji, a flag or a letter from its accents (bookmarkKeptCount);
 * trailing spaces before the cut mark are dropped.
 */
export function bookmarkTitle(text: string): string
{
    const points = Array.from(text);
    if (points.length <= MAX_BOOKMARK_LENGTH)
    {
        return text;
    }
    return `${points.slice(0, bookmarkKeptCount(points, MAX_BOOKMARK_LENGTH - 1)).join('').trimEnd()}\u{2026}`;
}

/** The anchor of email `number` (for the index links), real or rebuilt. */
export function emailAnchor(number: number): string
{
    return `email-${String(number)}`;
}

/**
 * One place in the PDF, with its PDF number (1..n over every slot): a real
 * email (its list position and plan) or a rebuilt one.
 */
export type PdfSlot =
    | { readonly kind: 'email'; readonly position: number; readonly number: number; /** Index into `plans`. */ readonly plan: number }
    | {
        readonly kind: 'rebuilt';
        readonly entry: AnalyzedRebuiltMessage;
        readonly number: number;
        /**
         * Where it was read from (rebuiltInPdf). Only `shown` is used: its
         * `number` and `also` count the real emails alone (1..k, in PDF
         * order), not the PDF numbers, and the PDF never prints them (task 8.3).
         */
        readonly source: RebuiltInPdf;
    };

export interface PdfOrder
{
    readonly slots: readonly PdfSlot[];
    /** For each list position: the PDF number of its real email, or null when it is not in the PDF. */
    readonly pdfNumberByPosition: readonly (number | null)[];
}

/**
 * What goes in the PDF, in which order (see the top of this file):
 * - the real emails: `positions` in the given order, each existing one once,
 *   less those with no text (task 8.14, hasNoPrintableText; see NO-TEXT
 *   EMAILS at the top): they get no slot and no number;
 * - the rebuilt entries of `rebuiltIds` that exist, have their own
 *   timeline entry (link 'entry'), have text (rebuiltHasNoPrintableText)
 *   and pass the follow-source rule
 *   (rebuiltInPdf: at least one email they were read from is in the PDF),
 *   each once, at their place in the timeline: just before the first real
 *   email in the PDF that comes after them, else at the end. A timeline
 *   that is not valid (previewOrder falls back) gives no rebuilt email at
 *   all: their text is in their source emails anyway.
 * Then every slot is numbered 1..n in that order, without gaps (task 8.3:
 * rebuilt emails are numbered like real ones). rebuiltInPdf is given the real emails'
 * rank among themselves (1..k); the real emails keep their order, so the
 * copy it picks (the source that comes first) is the same as with the PDF
 * numbers.
 * Pure: `result` is never changed.
 */
export function planPdfOrder(result: ThreadAnalysisResult, positions: readonly number[], rebuiltIds: readonly number[] = []): PdfOrder
{
    // The real emails, each once, and their rank among them (1..k).
    const realRank: (number | null)[] = result.messages.map(() => null);
    const realEmails: { readonly position: number; readonly plan: number }[] = [];
    positions.forEach((position, planIndex) =>
    {
        const analyzedMessage = result.messages[position];
        if (analyzedMessage === undefined || realRank[position] !== null)
        {
            return;
        }
        // An email with no text is left out of the PDF (task 8.14, see NO-TEXT EMAILS at the top).
        if (hasNoPrintableText(analyzedMessage.message))
        {
            return;
        }
        realRank[position] = realEmails.length + 1;
        realEmails.push({ position, plan: planIndex });
    });

    // The rebuilt entries chosen that follow a real email in the PDF, with their rank in the timeline.
    type UnnumberedSlot = { readonly kind: 'email'; readonly position: number; readonly plan: number }
        | { readonly kind: 'rebuilt'; readonly entry: AnalyzedRebuiltMessage; readonly source: RebuiltInPdf };
    const chosenRebuilt: { readonly slot: UnnumberedSlot; readonly rank: number }[] = [];
    const rankOfPosition = new Map<number, number>();
    if (rebuiltIds.length > 0)
    {
        const chosenIds = new Set(rebuiltIds);
        previewOrder(result).forEach((slot, rank) =>
        {
            if (slot.kind === 'message')
            {
                rankOfPosition.set(slot.position, rank);
                return;
            }
            const entry = result.reconstructed[slot.id];
            if (entry === undefined || !chosenIds.has(slot.id) || rebuiltHasNoPrintableText(entry))
            {
                return;
            }
            const source = rebuiltInPdf(entry, result, (p) => realRank[p] ?? null);
            if (source !== null)
            {
                chosenRebuilt.push({ slot: { kind: 'rebuilt', entry, source }, rank });
            }
        });
    }

    const placed: UnnumberedSlot[] = [];
    let nextRebuilt = 0;
    for (const email of realEmails)
    {
        const rank = rankOfPosition.get(email.position) ?? Number.POSITIVE_INFINITY;
        while (nextRebuilt < chosenRebuilt.length && chosenRebuilt[nextRebuilt]!.rank < rank)
        {
            placed.push(chosenRebuilt[nextRebuilt++]!.slot);
        }
        placed.push({ kind: 'email', ...email });
    }
    while (nextRebuilt < chosenRebuilt.length)
    {
        placed.push(chosenRebuilt[nextRebuilt++]!.slot);
    }

    // One numbering over every slot.
    const pdfNumberByPosition: (number | null)[] = result.messages.map(() => null);
    const slots = placed.map((slot, slotIndex): PdfSlot =>
    {
        if (slot.kind === 'email')
        {
            pdfNumberByPosition[slot.position] = slotIndex + 1;
        }
        return { ...slot, number: slotIndex + 1 };
    });
    return { slots, pdfNumberByPosition };
}

function isBlankMailbox(mailbox: EmailAddress): boolean
{
    return mailbox.name.trim() === '' && mailbox.address.trim() === '';
}

/** "Name <address>", or whichever of the two exists (as the preview shows it). */
function mailboxText(mailbox: EmailAddress, strings: PdfStrings): string
{
    const hasName = mailbox.name.trim() !== '';
    const hasAddress = mailbox.address.trim() !== '';
    if (hasName && hasAddress)
    {
        return strings.mailbox(mailbox.name, mailbox.address);
    }
    return hasName ? mailbox.name : mailbox.address;
}

/** A short form for the index: the name, or the address when there is no name. */
function shortMailbox(mailbox: EmailAddress): string
{
    return mailbox.name.trim() !== '' ? mailbox.name : mailbox.address;
}

/**
 * A plan's ranges are usable: as MessagePlan promises, a contiguous cover of
 * [0, length), each range non-empty with a boolean `keep`. Anything else
 * (a gap would silently drop text) means the plan is not trusted.
 */
function hasValidRanges(plan: MessagePlan | null | undefined, length: number): plan is MessagePlan
{
    if (typeof plan !== 'object' || plan === null || !Array.isArray(plan.ranges))
    {
        return false;
    }
    let coveredTo = 0;
    for (const range of plan.ranges as readonly unknown[])
    {
        if (typeof range !== 'object' || range === null)
        {
            return false;
        }
        const { start, end, keep } = range as Record<string, unknown>;
        if (typeof keep !== 'boolean' || !Number.isInteger(start) || !Number.isInteger(end))
        {
            return false;
        }
        if (start !== coveredTo || (end as number) <= coveredTo || (end as number) > length)
        {
            return false;
        }
        coveredTo = end as number;
    }
    return coveredTo === length;
}

/** Nothing joined: every line of the text starts a line of the body. */
const NO_JOINS: ReadonlySet<number> = new Set();

/** Code-unit intervals [start, end) of one body, sorted, not overlapping, not touching. */
export type BodyIntervals = readonly (readonly [number, number])[];

const NO_INTERVALS: BodyIntervals = [];

/**
 * The header rows the PDF prints for a place left out: a rebuilt copy's (its
 * fields as read), or a real file's. `strong` (a real file only): the link
 * to that file has a strong date match (Header/rebuilt-emails.ts, RealMatch.strong,
 * and not an ambiguous date): the quoted date, even without a zone of its
 * own, is that file's moment (user decision 2026-11-07, S4).
 */
export type PrintedHeader =
    | { readonly kind: 'rebuilt'; readonly rebuilt: ReconstructedMessage }
    | { readonly kind: 'real'; readonly message: NormalizedMessage; readonly strong?: boolean };

const trimmedOrEmpty = (s: string | null): string => (s ?? '').trim();
/** A display name compared: outer white space removed, inner runs of white space as one space. */
const nameKey = (name: string): string => name.trim().replace(/\s+/gu, ' ');
const sameMailbox = (a: EmailAddress, b: EmailAddress): boolean => a.name.trim() === b.name.trim() && a.address.trim().toLowerCase() === b.address.trim().toLowerCase();
const sameMailboxes = (a: readonly EmailAddress[], b: readonly EmailAddress[]): boolean =>
{
    const nonBlankA = a.filter((m) => !isBlankMailbox(m));
    const nonBlankB = b.filter((m) => !isBlankMailbox(m));
    return nonBlankA.length === nonBlankB.length && nonBlankA.every((m, k) => sameMailbox(m, nonBlankB[k]!));
};
/**
 * `mailbox` is one of `list`: the same address (letter case ignored), and,
 * when both have a display name, the same name too (nameKey; task 8.11,
 * review finding G3: "Robert <bob@x>" is not shown by a row that says "Bob
 * <bob@x>", so its header lines stay, B2); or, when `mailbox` has no address
 * (an Outlook header often writes names only: "To: Bob Sample"), a mailbox of
 * `list` with the same name (nameKey), with or without an address (task
 * 8.10, S3). The real file's row shows that name.
 */
const amongMailboxes = (mailbox: EmailAddress, list: readonly EmailAddress[]): boolean =>
{
    const address = mailbox.address.trim().toLowerCase();
    const name = nameKey(mailbox.name);
    if (address !== '')
    {
        return list.some((x) => x.address.trim().toLowerCase() === address && (name === '' || nameKey(x.name) === '' || nameKey(x.name) === name));
    }
    return name !== '' && list.some((x) => nameKey(x.name) === name);
};

/**
 * Whether the header rows printed for a rebuilt message's place (`printed`)
 * show everything its header lines [start, headerEnd) of `body` say, so that
 * those lines may be left out with its text (the no-repeat rule, user
 * decision 2026-11-06, B2; see the top of this file). When unsure: false,
 * the header lines stay in the body (only header lines repeat, never text).
 * Always false when the lines hold a Bcc line (its value is never read
 * from quoted lines, so no header row can be checked against it) or a
 * label written twice (only the first value is read); when the sender is
 * not exactly one mailbox ("Unknown sender", a From value with several
 * mailboxes); when there is no date read (an attribution not split, a date
 * line not read); when a To / Cc list may go on unread; when the lines hold
 * a Subject line that was not read.
 * - `printed` a rebuilt copy: also false when the sender has no name (an
 *   attribution whose name could not be split from the date) or the time is
 *   only estimated (no zone of its own). That last rule dates from before
 *   task 9.9c, when such a time was printed converted; it is printed as
 *   written now, and the rule is kept so that task changed only the dates
 *   shown (when unsure, keep). A day alone and a date that could not be read are printed as
 *   written: they do not stop it. That copy's fields must be the ones read
 *   here (a copy read from another email may differ in its header).
 * - `printed` a real file: the date must be a moment that carries its own
 *   zone, or, when the link has a strong date match (`printed.strong`, user
 *   decision 2026-11-07, S4), an estimated one: that file's Date row shows
 *   the moment written. The sender must be in the file's From: the same
 *   name (and address, when one was read), or, with no name read, the same
 *   address. A subject read must be the file's, and every To / Cc mailbox
 *   read must be in the file's To or Cc (by address, with the same name
 *   when both have one, G3; or by name when it has no address, S3).
 */
export function headerShownInPdf(body: string, rebuiltMessage: ReconstructedMessage, printed: PrintedHeader): boolean
{
    const labels = headerLabelCounts(body, rebuiltMessage.start, rebuiltMessage.headerEnd);
    if ((labels.get('bcc') ?? 0) > 0)
    {
        return false;
    }
    for (const count of labels.values())
    {
        if (count > 1)
        {
            return false;
        }
    }
    if (rebuiltMessage.incomplete.length > 0)
    {
        return false;
    }
    const from = rebuiltMessage.from.filter((m) => !isBlankMailbox(m));
    const sender = from[0];
    if (from.length !== 1 || sender === undefined)
    {
        return false;
    }
    if ((labels.get('subject') ?? 0) > 0 && trimmedOrEmpty(rebuiltMessage.subject) === '')
    {
        return false;
    }
    const date = rebuiltDate({ rebuilt: rebuiltMessage });
    if (date.kind === 'none')
    {
        return false;
    }
    const senderName = nameKey(sender.name);
    if (printed.kind === 'rebuilt')
    {
        if (senderName === '')
        {
            return false;
        }
        if (date.kind === 'moment' && date.approximate)
        {
            return false;
        }
        const printedCopy = printed.rebuilt;
        return (
            printedCopy === rebuiltMessage ||
            (sameMailboxes(printedCopy.from, rebuiltMessage.from) &&
                sameMailboxes(printedCopy.to, rebuiltMessage.to) &&
                sameMailboxes(printedCopy.cc, rebuiltMessage.cc) &&
                trimmedOrEmpty(printedCopy.subject) === trimmedOrEmpty(rebuiltMessage.subject) &&
                trimmedOrEmpty(printedCopy.dateText) === trimmedOrEmpty(rebuiltMessage.dateText) &&
                printedCopy.incomplete.length === 0)
        );
    }
    const realMessage = printed.message;
    if (date.kind !== 'moment')
    {
        return false;
    }
    if (date.approximate && printed.strong !== true)
    {
        return false;
    }
    const senderAddress = sender.address.trim().toLowerCase();
    const sameAddress = (x: EmailAddress): boolean => x.address.trim().toLowerCase() === senderAddress;
    const senderShown =
        senderName === ''
            ? senderAddress !== '' && realMessage.from.some(sameAddress)
            : realMessage.from.some((x) => nameKey(x.name) === senderName && (senderAddress === '' || sameAddress(x)));
    if (!senderShown)
    {
        return false;
    }
    if (trimmedOrEmpty(rebuiltMessage.subject) !== '' && trimmedOrEmpty(rebuiltMessage.subject) !== realMessage.subject.trim())
    {
        return false;
    }
    const recipients = [...realMessage.to, ...realMessage.cc];
    return [...rebuiltMessage.to, ...rebuiltMessage.cc].every((x) => isBlankMailbox(x) || amongMailboxes(x, recipients));
}

/** The kept ranges of the writer's own: the writer's own text (B1) and a kept signature (S5). */
const isOwnRange = (r: PlanRange): boolean => r.keep && (r.reason === 'text' || r.reason === 'signature' || r.reason === 'repeated-signature');

/** The ranges the plan marks as a quote (kept or not): a quote of the writer, app quoted history, a forwarded part. */
const isQuoteRange = (r: PlanRange): boolean => r.reason === 'writer-quote' || r.reason === 'app-quoted-history' || r.reason === 'forwarded';

/** Whether [start, end) of `body` overlaps, with text other than white space, a range of `ranges` that passes `test`. */
function holdsText(body: string, ranges: readonly PlanRange[], start: number, end: number, test: (r: PlanRange) => boolean): boolean
{
    for (const range of ranges)
    {
        if (range.end <= start || range.start >= end)
        {
            continue;
        }
        if (test(range) && /\S/u.test(body.slice(Math.max(range.start, start), Math.min(range.end, end))))
        {
            return true;
        }
    }
    return false;
}

/**
 * Whether [start, end) of `body` overlaps, with text other than white
 * space, a kept range of `ranges` of the writer's own (reason 'text', the
 * writer's own text, B1; or a kept 'signature' / 'repeated-signature', S5).
 * printedElsewhere uses it, with holdsQuotedText, on a place's text: a
 * place that holds both is not cut at all (the writer's answer, see
 * printedElsewhere).
 */
export function holdsOwnText(body: string, ranges: readonly PlanRange[], start: number, end: number): boolean
{
    return holdsText(body, ranges, start, end, isOwnRange);
}

/**
 * Whether [start, end) of `body` overlaps, with text other than white
 * space, a range of `ranges` that the plan marks as a quote, kept or not
 * (reason 'writer-quote', 'app-quoted-history' or 'forwarded'; task
 * 8.13a). In a place that also holds own text (holdsOwnText), the plan
 * told the writer's answer from the quote around it there.
 */
export function holdsQuotedText(body: string, ranges: readonly PlanRange[], start: number, end: number): boolean
{
    return holdsText(body, ranges, start, end, isQuoteRange);
}

/** Where the forwarded part of a plan starts (rule 1 of output-plan.ts: everything from there on), or null. */
function forwardedPartStart(ranges: readonly PlanRange[]): number | null
{
    return ranges.find((r) => r.reason === 'forwarded')?.start ?? null;
}

/**
 * Where the header lines of a rebuilt message's place end in `body`: its
 * `headerEnd`, or, when its header was read short (a To / Cc list that may
 * go on), after the lines left of that header at the top of its text (the
 * rest of a wrapped list, a Subject line) and the blank line below them, as
 * comparableText (link-rebuilt-messages.ts) skips them. Those lines are header
 * lines, not the quoted email's text and not an answer: the no-repeat rule
 * keeps them with the header lines. reconstructedText keeps every line
 * break of the body (reconstruct-quoted-messages.ts, step 4), so the n-th "\n" of the text
 * skipped is the n-th "\n" from `headerEnd` in the body. Never past `end`.
 * Theoretical corner: when the header was read short and the writer's
 * answer directly under the quoted header looks like a leftover header
 * line (say "To: ..." or "Subject: ..."), it is taken for header lines and
 * stays (B1 holds), while the quote below it may be cut.
 */
export function headerLinesEnd(body: string, rebuiltMessage: ReconstructedMessage): number
{
    const { headerEnd, end } = rebuiltMessage;
    let comparable: string;
    try
    {
        comparable = comparableText(rebuiltMessage);
    }
    catch
    {
        return headerEnd; // malformed input: no leftover lines
    }
    const reconstructedText = rebuiltMessage.reconstructedText;
    if (typeof reconstructedText !== 'string' || comparable.length >= reconstructedText.length)
    {
        return headerEnd;
    }
    if (comparable === '')
    {
        return end;
    }
    const skipped = reconstructedText.slice(0, reconstructedText.length - comparable.length);
    let lineStart = headerEnd;
    for (let skippedNewline = skipped.indexOf('\n'); skippedNewline >= 0; skippedNewline = skipped.indexOf('\n', skippedNewline + 1))
    {
        const bodyNewline = body.indexOf('\n', lineStart);
        if (bodyNewline < 0 || bodyNewline >= end)
        {
            return end;
        }
        lineStart = bodyNewline + 1;
    }
    return lineStart;
}

/**
 * THE NO-REPEAT RULE (user decisions 2026-11-06, task 8.10, and
 * 2026-11-09, task 8.13a): which parts of each real email's body the PDF
 * leaves out because it prints them elsewhere AS AN EMAIL OF ITS OWN (or,
 * for a forwarded part, because the reader unticked its rebuilt email), per
 * list position (only emails in the PDF; an email with none is not in the
 * map). A part is the WHOLE place a rebuilt message was read from
 * (Source/thread-analysis/reconstruct-quoted-messages.ts), [start, end): its header lines and its
 * text, when that message is in the PDF:
 * - an entry (link 'entry') with a slot in this PDF;
 * - a copy of such an entry (link 'same-as'): the entry prints the same
 *   words (link-rebuilt-messages.ts, rule 2; only a signature block at the end of
 *   one copy may differ: see A DIFFERING SIGNATURE below);
 * - one linked to a real email (link 'real', "the real file wins") when
 *   that real email is in the PDF too: it prints the same words as its own
 *   text (link-rebuilt-messages.ts, rule 1c; only a signature block may differ).
 * HEADER LINES (task 8.13a, Q4; they no longer stay in the body, B2): the
 * header lines [start, headerLinesEnd) always leave the body with the
 * place. When the place is printed as a REBUILT email whose header rows do
 * not show everything they say (headerShownInPdf), or when the plan took
 * some of them for own text (a wrapped To / Cc line, a Subject line), they
 * are MOVED, as plain text, to the top of that rebuilt email's own text
 * (applyNoRepeatRule, `moved`; buildRebuiltEmail), so nothing is lost and they sit
 * under a real header. Only lines the body would have printed are moved:
 * its trusted plan keeps some of them (lines the plan leaves out anyway,
 * say the quoted history of a reply, are not added to the rebuilt email).
 * When it is printed as a REAL FILE, they are dropped:
 * that file's own header rows are the real header.
 * UNTICKED FORWARDED PARTS (task 8.13a, Q2): a place inside the forwarded
 * part of its source's plan (rule 1 of output-plan.ts: from the forward
 * boundary on) whose rebuilt email the reader unticked (its id, or the id
 * of the entry it is a copy of, is in `unticked`: its card seen and
 * unticked while "Rebuild conversation from replies" is on,
 * BuildPdfInput.unticked) is left out too, header lines and text
 * (`printedAs` kind 'unticked'): the PDF does not show it; the preview,
 * "Print full original text" and the original files still do. Only ids
 * actually in `unticked` count (task 8.13a review round 2): an entry merely
 * not chosen is never taken for unticked. Only when `unticked` and `plans`
 * are given (applyNoRepeatRule gives no `unticked` while the switch is off,
 * BuildPdfInput.rebuildingOff: then no forwarded part is cut).
 * A DIFFERING SIGNATURE (task 8.13a review round 2): a copy linked to the
 * email that prints it (link 'same-as', or 'real') may end with a signature
 * block the printed text does not have (link-rebuilt-messages.ts, rules 1c and 2:
 * one of the two texts may end with one). That block is printed nowhere
 * else, so it stays INLINE (the part ends where it starts, unprintedSignatureStart); only
 * the words the other email prints are cut. When it is unclear where in the
 * body the block starts, the whole place stays (when unsure, keep).
 * EMPTY PLACES (user decision F2, task 9.9b): the place of a rebuilt
 * message with no text (rebuiltHasNoPrintableText: header lines only) is
 * left out too (`printedAs` kind 'no-text'), unless a real file in the
 * PDF prints it (kind 'email'): no lone header lines in the PDF.
 * NOT REBUILT (user decision F6, task 9.9b; applyNoRepeatRule only, while
 * rebuilding is on): in the forwarded part of a body, the pieces the
 * preview folds that lie in no place (the rebuild failed there:
 * notRebuiltParts) are left out (kind 'not-rebuilt'), so the PDF folds them
 * as the preview does; the text the preview shows stays, and so do the
 * header lines right above it that say who wrote it (Q3, review round 1 of
 * task 9.9b-1); header lines whose text is only under a later block of
 * header lines are left out (review rounds 2 and 3 of task 9.9b-1; a block
 * starts after anything that is not header lines, folded or not; two blocks
 * with no gap at all count as one and are kept, see notRebuiltParts). A body
 * with a place whose bounds are malformed is not cut this
 * way at all (when unsure, keep).
 * Kept INLINE, as the plan says (nothing else would show it): a rebuilt
 * message that is not in the PDF for any other reason (not a forwarded
 * part, its entry chosen but not placed, a real file linked to it that is
 * not in the PDF), and any quoted part the thread analysis could not rebuild at all
 * (reconstruct-quoted-messages.ts, REFUSAL: there is no place for it) that
 * the preview shows unfolded, or that is not in a forwarded part.
 * THE WRITER'S ANSWER STAYS (task 8.10, B1, review round 3, as narrowed by
 * task 8.13a, Q3): a place whose text holds BOTH text the plan calls the
 * writer's own ('text', or a kept signature: holdsOwnText) AND text the
 * plan marks as a quote (holdsQuotedText) covers nothing: there the plan
 * told the writer's answer apart from the quote around it (an answer typed
 * inside or below a quote it could check, output-plan.ts rule 2b), so the
 * whole place stays as the plan says, header lines included, and the answer
 * is never printed right under the quoted sender's header lines (an allowed
 * repeat: the rebuilt email prints it too). A place whose text holds own
 * text and NO quoted text IS CUT like any other: the plan could not check
 * any of it and only labelled it 'text' because it could not prove it a
 * quote (rule 2b, say a middle email of an unmarked Outlook chain whose own
 * file is not in the PDF: the deliberate repeat of task 8.10, 3a, option A,
 * is gone). Its rebuilt email (or the real file) prints that text, under
 * the quoted header. An email whose plan is missing or not trusted is
 * printed whole anyway; no `plans` given (some tests): no such check.
 * Malformed entries (offsets outside the body) are skipped: when unsure,
 * keep.
 * Pure: `result` and `plans` are never changed.
 */
export function printedElsewhere(
    result: ThreadAnalysisResult,
    slots: readonly PdfSlot[],
    pdfNumberByPosition: readonly (number | null)[],
    plans?: ReadonlyMap<number, MessagePlan | undefined>,
    unticked?: ReadonlySet<number>,
): Map<number, BodyIntervals>
{
    const intervalsByPosition = new Map<number, BodyIntervals>();
    for (const [position, parts] of printedElsewhereParts(result, slots, pdfNumberByPosition, plans, unticked))
    {
        intervalsByPosition.set(position, mergeParts(parts));
    }
    return intervalsByPosition;
}

/** A part [start, end) of one body that the PDF prints as the email `printedAs` (printedElsewhereParts). */
export interface PrintedPart
{
    readonly start: number;
    readonly end: number;
    readonly printedAs: PrintedAs;
}

const samePrintedAs = (a: PrintedAs, b: PrintedAs): boolean =>
{
    switch (a.kind)
    {
        case 'rebuilt':
            return b.kind === 'rebuilt' && a.id === b.id;
        case 'email':
            return b.kind === 'email' && a.position === b.position;
        case 'unticked':
            return b.kind === 'unticked' && a.id === b.id;
        case 'unticked-attached':
            return b.kind === 'unticked-attached' && a.position === b.position;
        case 'no-text-attached':
            return b.kind === 'no-text-attached' && a.position === b.position;
        case 'no-text':
            return b.kind === 'no-text' && a.id === b.id;
        case 'not-rebuilt':
            return b.kind === 'not-rebuilt';
    }
};

/** The parts of a body as BodyIntervals: sorted, overlapping or touching parts merged. */
function mergeParts(parts: readonly { readonly start: number; readonly end: number }[]): BodyIntervals
{
    const sortedPairs = parts.map((p): [number, number] => [p.start, p.end]).sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const [start, end] of sortedPairs)
    {
        const last = merged[merged.length - 1];
        if (last !== undefined && start <= last[1])
        {
            last[1] = Math.max(last[1], end);
        }
        else
        {
            merged.push([start, end]);
        }
    }
    return merged;
}

/**
 * The places found for one body, made into parts that do not overlap: each
 * piece of text covered goes to the innermost place covering it (the one
 * that starts last; then the one that ends first; then the first found),
 * and touching pieces of the same email are joined. Their union is exactly
 * the union of the places (so mergeParts of the result is mergeParts of the
 * places).
 */
function disjointParts(places: readonly PrintedPart[]): PrintedPart[]
{
    const bounds = [...new Set(places.flatMap((p) => [p.start, p.end]))].sort((a, b) => a - b);
    const disjoint: PrintedPart[] = [];
    for (let k = 0; k + 1 < bounds.length; k++)
    {
        const pieceStart = bounds[k]!;
        const pieceEnd = bounds[k + 1]!;
        let innermost: PrintedPart | undefined;
        for (const place of places)
        {
            if (place.start > pieceStart || place.end < pieceEnd)
            {
                continue;
            }
            if (innermost === undefined || place.start > innermost.start || (place.start === innermost.start && place.end < innermost.end))
            {
                innermost = place;
            }
        }
        if (innermost === undefined)
        {
            continue;
        }
        const previous = disjoint[disjoint.length - 1];
        if (previous !== undefined && previous.end === pieceStart && samePrintedAs(previous.printedAs, innermost.printedAs))
        {
            disjoint[disjoint.length - 1] = { ...previous, end: pieceEnd };
        }
        else
        {
            disjoint.push({ start: pieceStart, end: pieceEnd, printedAs: innermost.printedAs });
        }
    }
    return disjoint;
}

/**
 * printedElsewhere with, for each part, the email the PDF prints it as
 * (task 8.11: the preview labels a part left out with that email; the PDF
 * and the preview read the same parts). Per list position: parts sorted,
 * not overlapping (disjointParts); mergeParts of them is printedElsewhere's
 * value. Same rules, same arguments (see printedElsewhere).
 * Without `readerTicked`, an attached email with no text counts as ticked:
 * its block is 'no-text-attached' (same cut as 'unticked-attached', other
 * label), or kept when it has attachments. applyNoRepeatRule, which the PDF
 * and the preview use, passes the ticked positions.
 * Pure: `result` and `plans` are never changed.
 */
export function printedElsewhereParts(
    result: ThreadAnalysisResult,
    slots: readonly PdfSlot[],
    pdfNumberByPosition: readonly (number | null)[],
    plans?: ReadonlyMap<number, MessagePlan | undefined>,
    unticked?: ReadonlySet<number>,
): Map<number, readonly PrintedPart[]>
{
    return noRepeatParts(result, slots, pdfNumberByPosition, plans, unticked).parts;
}

/** A block of quoted header lines a place leaves behind for its rebuilt email (task 8.13a, Q4). */
interface MoveCandidate
{
    readonly entryId: number;
    /** The id of the place (its AnalyzedRebuiltMessage). */
    readonly copyId: number;
    readonly position: number;
    readonly start: number;
    readonly headerEnd: number;
    readonly linesEnd: number;
}

/**
 * One line set of header lines, compared: line ends unified, the quote marks
 * at a line start and outer white space removed, blank lines dropped.
 */
function headerKey(text: string): string
{
    return text
        .split(/\r\n?|\n/u)
        .map((line) => line.replace(/^(?:[ \t]*>)+[ \t]?/u, '').trim())
        .filter((line) => line !== '')
        .join('\n');
}

/**
 * Where, in `body`, a signature block starts that ends the text of `place`
 * and that `printedText` (the text the email printing this place prints: the
 * copy a rebuilt email shows, or a real file's body) does not print, or null
 * (task 8.13a review round 2). The link rules let ONE of two linked texts end
 * with a signature block the other lacks (link-rebuilt-messages.ts, rules 1c and 2;
 * signatureStart, with the place's sender names). Null when the place has
 * no such block, or when `printedText` holds all the place's words in the
 * same order (comparableText: the header leftovers a header read short
 * leaves at the top of its text aside), block included: then it is printed
 * there. Otherwise the block's offset: the start of its first line in `body`
 * (the place's text keeps its lines one for one, only quote marks are
 * removed, reconstruct-quoted-messages.ts step 4). 'unsure' (task 8.13a final round) when
 * the block is there but its line cannot be found inside the place (the
 * lines do not map one for one: the place's text has more lines than the
 * place, or the line falls at or past its end), or the texts are not
 * strings: the caller then KEEPS the whole place (when unsure, keep; null
 * would cut it all, block included). Words are compared as the link rules
 * compare them (wordsOf).
 */
export function unprintedSignatureStart(body: string, place: ReconstructedMessage, printedText: string): number | null | 'unsure'
{
    const text = place.reconstructedText;
    if (typeof text !== 'string' || typeof printedText !== 'string')
    {
        return 'unsure';
    }
    const signatureAt = signatureStart(text, nameWordsOf(Array.isArray(place.from) ? place.from : []));
    if (signatureAt === null)
    {
        return null;
    }
    const placeWords = wordsOf(comparableText(place)).tokens;
    if (placeWords.length === 0)
    {
        return null;
    }
    if (` ${wordsOf(printedText).tokens.join(' ')} `.includes(` ${placeWords.join(' ')} `))
    {
        return null;
    }
    // The block's first line, counted from the start of the place's text.
    let linesBefore = 0;
    for (let textNewline = text.indexOf('\n'); textNewline >= 0 && textNewline < signatureAt; textNewline = text.indexOf('\n', textNewline + 1))
    {
        linesBefore++;
    }
    let offset = place.headerEnd;
    for (let k = 0; k < linesBefore; k++)
    {
        const bodyNewline = body.indexOf('\n', offset);
        if (bodyNewline < 0 || bodyNewline >= place.end)
        {
            return 'unsure';
        }
        offset = bodyNewline + 1;
    }
    return offset < place.end ? offset : 'unsure';
}

/** `list` when it really is a list (data from a worker), else none. */
function listOrNone<T>(list: readonly T[] | undefined): readonly T[]
{
    // A plain boolean check: Array.isArray as a type guard would turn the list into any[].
    const isList: boolean = Array.isArray(list);
    return isList && list !== undefined ? list : [];
}

/**
 * What the page of the email at list position `attachedPosition` (an attached email in
 * the PDF, or the copy it was merged into) prints of its body, as pieces of
 * that body with the email each piece is printed as (task 8.13b-3, review
 * round 4, M1): its plan's KEPT ranges, printed as itself, except the parts
 * the no-repeat rule found so far (`ownParts`) leave out of them, which keep
 * the reason they are left out: printed as another email in the PDF (a
 * rebuilt email, a real file, an attached email inside it), or left out on
 * purpose (kind 'unticked': a forwarded part whose rebuilt email the reader
 * unticked, Q2 of task 8.13a, left out of every email that prints it the
 * same way). Whatever the plan leaves out (quoted history, folded
 * signatures) is no piece: that page does not print it. A body printed
 * whole (no plan, a plan that is not valid or failed; bodyTextOf) is one
 * piece. Sorted, not overlapping.
 */
function pagePieces(body: string, plan: MessagePlan | undefined, printedAsItself: PrintedAs, ownParts: readonly PrintedPart[]): PrintedPart[]
{
    if (!hasValidRanges(plan, body.length) || plan.fallback)
    {
        return body.length === 0 ? [] : [{ start: 0, end: body.length, printedAs: printedAsItself }];
    }
    const sorted = disjointParts(ownParts);
    const pieces: PrintedPart[] = [];
    for (const range of plan.ranges)
    {
        if (!range.keep)
        {
            continue;
        }
        let from = range.start;
        for (const part of sorted)
        {
            if (part.end <= from || part.start >= range.end)
            {
                continue;
            }
            if (part.start > from)
            {
                pieces.push({ start: from, end: part.start, printedAs: printedAsItself });
            }
            const end = Math.min(part.end, range.end);
            pieces.push({ start: Math.max(part.start, from), end, printedAs: part.printedAs });
            from = end;
        }
        if (from < range.end)
        {
            pieces.push({ start: from, end: range.end, printedAs: printedAsItself });
        }
    }
    return pieces;
}

/** Where the text of an attached email's printed block starts in it: after the first blank line (none: a block of header lines only, its end). */
function blockBodyStart(body: string, start: number, end: number): { readonly at: number; readonly hasBlank: boolean }
{
    const blankLine = /(?:\r\n|\r|\n)[ \t]*(?:\r\n|\r|\n)/u.exec(body.slice(start, end));
    return blankLine === null ? { at: end, hasBlank: false } : { at: start + blankLine.index + blankLine[0].length, hasBlank: true };
}

/**
 * The parts of an attached email's printed block `holderBody[start, end)`
 * that its own page prints, in the holder's offsets (task 8.13b-3, review
 * round 4, M1, user decision option a): the no-repeat rule leaves out of the
 * holder ONLY these; everything else of the block stays where the holder's
 * plan prints it (printed twice rather than nowhere).
 * - The forwarded separator and header lines (the block up to its first
 *   blank line, Header/parsed-email.ts AttachedPlace): printed as the email,
 *   whose header rows show them, when those rows show all of its header
 *   data (AnalyzedAttachedMessage.keptShowsHeader: not so when a dropped file's copy
 *   with less header data was kept, D2); otherwise they stay.
 * - Its text (after that blank line): the pieces its page prints
 *   (pagePieces of `pieces`, in the offsets of the kept copy's body
 *   `ownBody`), found in the block with mapOffsets (the block's text is the
 *   attached email's body as the parser wrote it; a kept copy merged with
 *   it has the same body as de-duplication compares them).
 * When the block's text cannot be matched to that body for certain, none
 * (the whole block stays: when unsure, keep).
 */
function blockClaims(holderBody: string, start: number, end: number, ownBody: string, pieces: readonly PrintedPart[], printedAsItself: PrintedAs,
    showsHeader: boolean): PrintedPart[]
{
    const { at: bodyStart, hasBlank } = blockBodyStart(holderBody, start, end);
    const text = holderBody.slice(bodyStart, end);
    if (!hasBlank && /\S/u.test(ownBody))
    {
        return [];
    }
    const claims: PrintedPart[] = [];
    if (pieces.length > 0)
    {
        const mapped = mapOffsets(ownBody, text, pieces.flatMap((p) => [p.start, p.end]));
        if (mapped === null)
        {
            return [];
        }
        pieces.forEach((piece, pieceIndex) =>
        {
            const claimStart = bodyStart + mapped[2 * pieceIndex]!;
            const claimEnd = bodyStart + mapped[2 * pieceIndex + 1]!;
            if (claimStart < claimEnd)
            {
                claims.push({ start: claimStart, end: claimEnd, printedAs: piece.printedAs });
            }
        });
    }
    if (showsHeader && bodyStart > start)
    {
        claims.push({ start, end: bodyStart, printedAs: printedAsItself });
    }
    return claims;
}

/**
 * The no-repeat rule for attached emails (see ATTACHED EMAILS at the top;
 * task 8.13b-3, review rounds 2 to 4): adds to `found` the parts of the
 * bodies in the PDF that are the printed blocks of attached emails.
 * - An attached email in the PDF: only the parts of its block that its own
 *   page prints (blockClaims), each printed as the email that prints it.
 *   Emails attached deepest first, so the parts found inside an email's
 *   own body (the blocks of the emails attached inside it) are known when
 *   its own block is worked out.
 * - One NOT in the PDF (unticked, Q3): its whole block, kind
 *   'unticked-attached', less what an attached email in the PDF inside it
 *   does not print (those parts stay: its text is never left out because
 *   the email around it is unticked), less nothing for the emails attached
 *   inside it that are unticked too.
 * - One NOT in the PDF because it has no text (task 8.14, see NO-TEXT
 *   EMAILS at the top) and NOT unticked by the reader (ticked in
 *   `readerTicked`, or `readerTicked` not known):
 *   - with no attachments: its whole block too, kind 'no-text-attached'
 *     (user decision Q5, 2026-11-21: rule F2, no lone header lines in the
 *     PDF). Such a block is only its separator line, its header lines and
 *     white space: an email with no text has no email printed inside it (an
 *     inline one would give it text), and the block is the parser's own
 *     text, so no writer's answer sits in it.
 *   - with attachments (or when unsure whether it has any): nothing of its
 *     block is left out (user decision 2026-11-22): its header lines stay in
 *     the holder's body as the holder's plan says, so the PDF still says
 *     who sent the files (listed in the holder's list) and when.
 *   One the reader unticked keeps kind 'unticked-attached', as above.
 * A place is used only in the very body it names (the holder's own copy, or
 * the kept copy it was moved to, analyze-thread.ts settleAttached), in the PDF, with
 * valid offsets, and not in the email's own body.
 */
function attachedBlockParts(
    result: ThreadAnalysisResult,
    pdfNumberByPosition: readonly (number | null)[],
    plans: ReadonlyMap<number, MessagePlan | undefined> | undefined,
    found: Map<number, PrintedPart[]>,
    readerTicked: ReadonlySet<number> | undefined,
): void
{
    const attachedEmails = listOrNone(result.attached);
    if (attachedEmails.length === 0)
    {
        return;
    }
    const inPdf = (position: number | null | undefined): position is number => typeof position === 'number' && pdfNumberByPosition[position] != null;
    const addPart = (holder: number, part: PrintedPart): void =>
    {
        let parts = found.get(holder);
        if (parts === undefined)
        {
            found.set(holder, (parts = []));
        }
        parts.push(part);
    };
    interface Block
    {
        readonly holder: number;
        readonly start: number;
        readonly end: number;
    }
    const untickedBlocks: (Block & { readonly printedAs: PrintedAs })[] = [];
    // The pieces of the blocks of emails in the PDF that their page does not print.
    const leftInBlocks: (Block & { readonly pieces: [number, number][] })[] = [];
    // The parts of body `holder` left out with an unticked attached email (Q3): its block, less what an
    // attached email in the PDF inside it does not print, less nothing for the unticked ones inside that one.
    const untickedParts = (holder: number): PrintedPart[] =>
    {
        const keptPieces: [number, number][] = [];
        for (const block of leftInBlocks)
        {
            if (block.holder !== holder)
            {
                continue;
            }
            // `inside` only matters when blockClaims returned nothing for this block (its text could not be
            // matched: the whole block is in block.pieces). Otherwise its claims already hold the unticked blocks
            // inside it (pagePieces gave them to its page with untickedParts), so block.pieces lacks them anyway.
            const inside = untickedBlocks.filter((u) => u.holder === holder && block.start <= u.start && u.end <= block.end
                && u.end - u.start < block.end - block.start).map((u): [number, number] => [u.start, u.end]);
            for (const [pieceStart, pieceEnd] of block.pieces)
            {
                for (const piece of subtractIntervals(pieceStart, pieceEnd, inside))
                {
                    keptPieces.push(piece);
                }
            }
        }
        const parts: PrintedPart[] = [];
        for (const untickedBlock of untickedBlocks)
        {
            if (untickedBlock.holder === holder)
            {
                for (const [start, end] of subtractIntervals(untickedBlock.start, untickedBlock.end, keptPieces))
                {
                    parts.push({ start, end, printedAs: untickedBlock.printedAs });
                }
            }
        }
        return parts;
    };
    // Deepest first (longest path): this assumes the blocks inside an email's own body belong to deeper
    // attached entries. With D2/S1 the kept body may be a dropped file, whose own attached entries have
    // depth 1. It still works: copies merge only when their bodies are equal (normalizeBody), so the kept
    // body holds the same blocks, and S1 (analyze-thread.ts settleAttached) moves the places of the entries
    // attached inside the merged copy to the kept body, where they keep their own (deeper) path.
    const depth = (a: AnalyzedAttachedMessage): number => listOrNone(a.path).length;
    const deepestFirst = attachedEmails.map((a, k) => ({ a, k })).sort((x, y) => depth(y.a) - depth(x.a) || y.k - x.k);
    for (const { a: attached } of deepestFirst)
    {
        const attachedPosition = result.positionByIndex[attached.index];
        if (typeof attachedPosition !== 'number')
        {
            continue;
        }
        const attachedMessage = result.messages[attachedPosition];
        if (attachedMessage === undefined)
        {
            continue;
        }
        const ticked = inPdf(attachedPosition);
        // Left out for having no text, not by the reader (task 8.14).
        const noText = !ticked && hasNoPrintableText(attachedMessage.message) && (readerTicked === undefined || readerTicked.has(attachedPosition));
        // With attachments: its block stays in every holder, it says who sent them and when (decision 2026-11-22).
        if (noText && listsAttachments(attachedMessage.message))
        {
            continue;
        }
        // With none: its block is printed nowhere (Q5, F2).
        const printedAsItself: PrintedAs = ticked ? { kind: 'email', position: attachedPosition, number: pdfNumberByPosition[attachedPosition]! }
            : noText ? { kind: 'no-text-attached', position: attachedPosition }
                : { kind: 'unticked-attached', position: attachedPosition };
        let pieces: PrintedPart[] | null = null;
        for (const place of listOrNone(attached.places))
        {
            const holder = result.positionByIndex[place.holderIndex];
            if (!inPdf(holder) || holder === attachedPosition)
            {
                continue;
            }
            const holderMessage = result.messages[holder];
            // The offsets are those of that very body (Header/thread-analysis-result.ts, AnalyzedAttachedPlace).
            if (holderMessage === undefined || holderMessage.index !== place.holderIndex)
            {
                continue;
            }
            const body = holderMessage.message.bodyText;
            if (!Number.isInteger(place.start) || !Number.isInteger(place.end) || place.start < 0 || place.end <= place.start
                || place.end > body.length)
            {
                continue;
            }
            if (!ticked)
            {
                untickedBlocks.push({ holder, start: place.start, end: place.end, printedAs: printedAsItself });
                continue;
            }
            // Every email attached inside this one is deeper, so done: its parts in this body are final.
            pieces ??= pagePieces(attachedMessage.message.bodyText, plans?.get(attachedPosition), printedAsItself,
                [...(found.get(attachedPosition) ?? []), ...untickedParts(attachedPosition)]);
            const claims = blockClaims(body, place.start, place.end, attachedMessage.message.bodyText, pieces, printedAsItself,
                attached.keptShowsHeader === true);
            for (const claim of claims)
            {
                addPart(holder, claim);
            }
            leftInBlocks.push({ holder, start: place.start, end: place.end,
                pieces: subtractIntervals(place.start, place.end, claims.map((c): [number, number] => [c.start, c.end])) });
        }
    }
    for (const holder of new Set(untickedBlocks.map((u) => u.holder)))
    {
        for (const part of untickedParts(holder))
        {
            addPart(holder, part);
        }
    }
}

/**
 * Whether `message` lists attachments; when unsure (no list), true, so its
 * block is kept. Any listed attachment counts, inline images included: that
 * keeps the header lines (who sent the file), the safe direction.
 */
function listsAttachments(message: Pick<NormalizedMessage, 'attachments'>): boolean
{
    // A plain boolean check: Array.isArray as a type guard would turn the list into any[].
    const isList: boolean = Array.isArray(message.attachments);
    return !isList || message.attachments.length > 0;
}

/** [start, end) less every interval of `holes` (in any order, may overlap), as sorted pieces; none when nothing is left. */
function subtractIntervals(start: number, end: number, holes: readonly (readonly [number, number])[]): [number, number][]
{
    const remaining: [number, number][] = [];
    let from = start;
    for (const [holeStart, holeEnd] of [...holes].sort((x, y) => x[0] - y[0] || x[1] - y[1]))
    {
        if (holeEnd <= from || holeStart >= end)
        {
            continue;
        }
        if (holeStart > from)
        {
            remaining.push([from, holeStart]);
        }
        from = Math.max(from, holeEnd);
        if (from >= end)
        {
            break;
        }
    }
    if (from < end)
    {
        remaining.push([from, end]);
    }
    return remaining;
}

/**
 * F6 (user decision 2026-11-19, task 9.9b): the pieces of a body's FORWARDED
 * part (rule 1 of Source/thread-analysis/output-plan.ts, read from `ranges`) that the
 * preview folds (folded `segments`) and that lie in no place rebuilt from
 * this body (`places`: [start, end) of every rebuilt message read from it):
 * what is left of a forward whose rebuild failed
 * (Source/thread-analysis/reconstruct-quoted-messages.ts refused a header and the chain
 * stopped, a limit was reached, or rebuilding threw). The PDF leaves them
 * out as the preview folds them (kind 'not-rebuilt': printed nowhere), so
 * the preview and the PDF agree; text the preview shows unfolded stays.
 * HEADER LINES WITH TEXT UNDER THEM STAY (user decision Q3, 2026-11-21,
 * review round 1 of task 9.9b-1): a folded piece of header lines (a
 * segment with reason 'reply-header': a reply or forward header) is NOT
 * left out when text the preview shows (in no folded segment, not blank)
 * follows it before the next place, the next block of header lines or the
 * end of the forwarded part: it says who wrote that text, so the PDF prints
 * it, and the preview labels it "In the PDF" (the plan keeps it:
 * 'forwarded'). Only header lines with nothing printed under them (F2: no
 * lone header lines) and folded pieces that are not header lines are left
 * out. A block of header lines starts at a folded 'reply-header' segment
 * whose previous segment is not header lines (review round 2 of task
 * 9.9b-1, narrowed in review round 3): the text under a later block (after a
 * blank line, or after a folded quote that is not header lines, say) is not
 * under this one, so a header with no text of its own right above another
 * header is cut.
 * Known corner (when unsure, keep): two header blocks with no gap at all
 * between them (no shown line, not even a blank one) count as one block, so
 * the upper one is kept when the lower one has text under it.
 * A block of header lines the header detector did not recognise, folded
 * only as 'quoted-overlap', is treated as a plain folded piece: it can be
 * cut only when another email quotes those header lines without the text
 * under them; that text stays printed, the preview labels the cut lines
 * "Not in the PDF", and "Print full original text" prints them.
 * The block of an attached email the .eml reader wrote (from the first
 * FORWARDED_SEPARATOR line of the forwarded part on) is another email,
 * never such a piece. None when the body has no forwarded part. Malformed
 * segments are skipped (when unsure, keep): they cut nothing and hide no
 * shown text.
 */
export function notRebuiltParts(
    body: string,
    segments: readonly Segment[],
    ranges: readonly PlanRange[],
    places: readonly (readonly [number, number])[],
): PrintedPart[]
{
    const from = forwardedPartStart(ranges);
    if (from === null || !Array.isArray(segments))
    {
        return [];
    }
    const segmentList: readonly Segment[] = segments;
    let to = body.length;
    for (const line of lineRanges(body))
    {
        if (line.start >= from && body.slice(line.start, line.contentEnd) === FORWARDED_SEPARATOR)
        {
            to = line.start;
            break;
        }
    }
    const foldedSegments = segmentList.filter((s) => s.folded && Number.isInteger(s.start) && Number.isInteger(s.end) && s.start < s.end);
    const foldedSpans: [number, number][] = foldedSegments.map((s) => [s.start, s.end]);
    // Where each block of header lines starts: a folded 'reply-header' segment right after a segment that is not
    // header lines (review rounds 2 and 3 of task 9.9b-1): shown, or folded for another reason only (a quote
    // marker, an overlap). A 'reply-header' segment right after a piece of header lines is a later piece of the
    // same block (buildSegments splits a fold where another overlaps it, and every piece keeps 'reply-header'),
    // never a block of its own.
    const isHeaderLines = (s: Segment | undefined): boolean => s !== undefined && Array.isArray(s.reasons) && s.reasons.includes('reply-header');
    const headerRunStarts = foldedSegments
        .filter((s) => isHeaderLines(s) && !isHeaderLines(segmentList.find((p) => p.end === s.start)))
        .map((s) => s.start);
    // Whether text the preview shows (not blank, in no folded segment) lies between `at` and the next place, the
    // next block of header lines (that text is under those, not under these) or `to`. `at` is the end of a piece of
    // the current header block, so the block's own start (before `at`) is never its own limit.
    const shownTextBelow = (at: number): boolean =>
    {
        const nextPlace = places.reduce((min, [placeStart]) => (placeStart >= at && placeStart < min ? placeStart : min), to);
        const limit = headerRunStarts.reduce((min, runStart) => (runStart >= at && runStart < min ? runStart : min), nextPlace);
        return subtractIntervals(at, limit, foldedSpans).some(([shownStart, shownEnd]) => /\S/u.test(body.slice(shownStart, shownEnd)));
    };
    const parts: PrintedPart[] = [];
    for (const segment of foldedSegments)
    {
        const start = Math.max(segment.start, from);
        const end = Math.min(segment.end, to);
        if (start >= end)
        {
            continue;
        }
        const headerLines = segment.reasons.includes('reply-header');
        for (const [pieceStart, pieceEnd] of subtractIntervals(start, end, places))
        {
            if (headerLines && shownTextBelow(pieceEnd))
            {
                continue;
            }
            parts.push({ start: pieceStart, end: pieceEnd, printedAs: { kind: 'not-rebuilt' } });
        }
    }
    return parts;
}

/**
 * printedElsewhereParts, and the header lines moved to each rebuilt email (see applyNoRepeatRule).
 * `cutNotRebuilt`: also the folded pieces of a forward whose rebuild failed (notRebuiltParts, F6); only
 * applyNoRepeatRule asks for them, while "Rebuild conversation from replies" is on.
 */
function noRepeatParts(
    result: ThreadAnalysisResult,
    slots: readonly PdfSlot[],
    pdfNumberByPosition: readonly (number | null)[],
    plans: ReadonlyMap<number, MessagePlan | undefined> | undefined,
    unticked: ReadonlySet<number> | undefined,
    readerTicked?: ReadonlySet<number>,
    cutNotRebuilt = false,
): { readonly parts: Map<number, readonly PrintedPart[]>; readonly moved: Map<number, readonly string[]> }
{
    const inPdf = (position: number | null | undefined): position is number => typeof position === 'number' && pdfNumberByPosition[position] != null;
    // Each entry in the PDF, with the copy whose header and text it prints (rebuiltInPdf), and its PDF number.
    const entries = new Map<number, { readonly copy: AnalyzedRebuiltMessage; readonly position: number; readonly number: number }>();
    for (const slot of slots)
    {
        if (slot.kind === 'rebuilt')
        {
            entries.set(slot.entry.id, { copy: slot.source.shown.rebuilt, position: slot.source.shown.position, number: slot.number });
        }
    }
    const found = new Map<number, PrintedPart[]>();
    const candidates: MoveCandidate[] = [];
    // The entries whose printed copy's header lines are printed nowhere (its plan leaves them out, its rows cannot show them).
    const unshown = new Set<number>();
    const reconstructed: readonly AnalyzedRebuiltMessage[] = Array.isArray(result.reconstructed) ? result.reconstructed : [];
    // Per list position in the PDF, the places [start, end) rebuilt from its body (F6: what is in none was not rebuilt).
    const placesByPosition = new Map<number, [number, number][]>();
    // The list positions with a place whose bounds are malformed (F6 skips those bodies).
    const unsurePlaces = new Set<number>();
    for (const rebuiltEntry of reconstructed)
    {
        const position = result.positionByIndex[rebuiltEntry.sourceIndex];
        if (!inPdf(position))
        {
            continue;
        }
        const { start, headerEnd, end } = rebuiltEntry.rebuilt;
        const body = result.messages[position]?.message.bodyText ?? '';
        if (!Number.isInteger(start) || !Number.isInteger(headerEnd) || !Number.isInteger(end) || start < 0 || headerEnd < start || end < headerEnd || end > body.length)
        {
            // Where this place lies is unknown: F6 cuts nothing in this body (when unsure, keep).
            unsurePlaces.add(position);
            continue;
        }
        let placesHere = placesByPosition.get(position);
        if (placesHere === undefined)
        {
            placesHere = [];
            placesByPosition.set(position, placesHere);
        }
        placesHere.push([start, end]);
        const plan = plans?.get(position);
        const trustedRanges = plan !== undefined && hasValidRanges(plan, body.length) && !plan.fallback ? plan.ranges : null;
        let shownAs: PrintedHeader | null = null;
        let printedAs: PrintedAs | null = null;
        // The text the other email prints (null: this place is that text, or nothing prints it).
        let printedText: string | null = null;
        if (rebuiltEntry.link === 'entry' || rebuiltEntry.link === 'same-as')
        {
            const entryId = rebuiltEntry.link === 'entry' ? rebuiltEntry.id : rebuiltEntry.sameAs;
            const entry = entryId === null ? undefined : entries.get(entryId);
            if (entryId !== null && entry !== undefined)
            {
                shownAs = { kind: 'rebuilt', rebuilt: entry.copy.rebuilt };
                printedAs = { kind: 'rebuilt', id: entryId, number: entry.number };
                if (entry.copy.id !== rebuiltEntry.id)
                {
                    printedText = entry.copy.rebuilt.reconstructedText;
                }
            }
            else if (entryId !== null && unticked !== undefined && unticked.has(entryId) && reconstructed[entryId]?.link === 'entry'
                && trustedRanges !== null)
            {
                // Q2: a forwarded part whose rebuilt email the reader unticked (only an id the reader really unticked).
                const forwarded = forwardedPartStart(trustedRanges);
                if (forwarded !== null && start >= forwarded)
                {
                    printedAs = { kind: 'unticked', id: entryId };
                }
            }
        }
        else if (rebuiltEntry.link === 'real' && rebuiltEntry.realIndex !== null)
        {
            const realPosition = result.positionByIndex[rebuiltEntry.realIndex];
            const message = realPosition === undefined || realPosition === position || !inPdf(realPosition) ? undefined
                : result.messages[realPosition]?.message;
            if (message !== undefined && inPdf(realPosition))
            {
                shownAs = { kind: 'real', message, strong: rebuiltEntry.match?.strong === true && !rebuiltEntry.match.ambiguousDate };
                printedAs = { kind: 'email', position: realPosition, number: pdfNumberByPosition[realPosition]! };
                printedText = typeof message.bodyText === 'string' ? message.bodyText : '';
            }
        }
        // F2 (task 9.9b): a rebuilt email with no text (its place is header lines only) is printed nowhere (no slot,
        // planPdfOrder), and its header lines are not printed in this body either: no lone header lines in the PDF.
        // Unless a real file in the PDF prints it (kind 'email' above: its header rows are the real header).
        if (rebuiltHasNoPrintableText(rebuiltEntry) && (printedAs === null || printedAs.kind === 'unticked'))
        {
            printedAs = { kind: 'no-text', id: rebuiltEntry.id };
        }
        if (printedAs === null)
        {
            continue;
        }
        // The header lines, with what is left of a header read short at the top of the text.
        const linesEnd = headerLinesEnd(body, rebuiltEntry.rebuilt);
        // The writer's answer (Q3): own text and quoted text in the place's text keep the whole place.
        if (trustedRanges !== null && holdsOwnText(body, trustedRanges, linesEnd, end) && holdsQuotedText(body, trustedRanges, linesEnd, end))
        {
            continue;
        }
        // A signature block only this copy has stays inline: the other email does not print it (see printedElsewhere).
        const tail = printedText === null ? null : unprintedSignatureStart(body, rebuiltEntry.rebuilt, printedText);
        // A block whose line cannot be found ('unsure'), or found where it cannot be (in the header lines):
        // when unsure, keep the whole place.
        if (tail === 'unsure' || (tail !== null && (tail < linesEnd || tail >= end)))
        {
            continue;
        }
        const cutEnd = tail ?? end;
        if (cutEnd <= start)
        {
            continue;
        }
        let partsHere = found.get(position);
        if (partsHere === undefined)
        {
            partsHere = [];
            found.set(position, partsHere);
        }
        partsHere.push({ start, end: cutEnd, printedAs });
        // Q4: header lines the rebuilt email's rows cannot show (or that the plan took for own text) move to it,
        // when this body would have printed them (its trusted plan keeps some of them; lines the plan leaves
        // out, say the quoted history of a reply, were never printed and are not added; an untrusted plan
        // prints the body whole, lines included, so moving them would print them twice).
        if (printedAs.kind === 'rebuilt' && shownAs !== null && linesEnd > start)
        {
            const headerShown = !(trustedRanges !== null && holdsOwnText(body, trustedRanges, start, linesEnd))
                && headerShownInPdf(body, rebuiltEntry.rebuilt, shownAs);
            const headerKept = trustedRanges !== null && holdsText(body, trustedRanges, start, linesEnd, (x) => x.keep);
            if (!headerShown && headerKept)
            {
                candidates.push({ entryId: printedAs.id, copyId: rebuiltEntry.id, position, start, headerEnd, linesEnd });
            }
            else if (!headerShown && trustedRanges !== null && entries.get(printedAs.id)?.copy.id === rebuiltEntry.id)
            {
                unshown.add(printedAs.id);
            }
        }
    }
    if (cutNotRebuilt && Array.isArray(result.reconstructed))
    {
        for (const slot of slots)
        {
            if (slot.kind !== 'email')
            {
                continue;
            }
            const analyzedMessage = result.messages[slot.position];
            const body = analyzedMessage?.message.bodyText ?? '';
            const plan = plans?.get(slot.position);
            if (analyzedMessage === undefined || plan === undefined || !hasValidRanges(plan, body.length) || plan.fallback || unsurePlaces.has(slot.position))
            {
                continue;
            }
            const notRebuilt = notRebuiltParts(body, analyzedMessage.segments, plan.ranges, placesByPosition.get(slot.position) ?? []);
            if (notRebuilt.length > 0)
            {
                found.set(slot.position, [...(found.get(slot.position) ?? []), ...notRebuilt]);
            }
        }
    }
    attachedBlockParts(result, pdfNumberByPosition, plans, found, readerTicked);
    const parts = new Map<number, readonly PrintedPart[]>();
    for (const [position, list] of found)
    {
        parts.set(position, disjointParts(list));
    }
    return { parts, moved: movedHeaders(result, entries, candidates, unshown, pdfNumberByPosition) };
}

/**
 * The header lines moved to each rebuilt email in the PDF (task 8.13a, Q4),
 * by entry id, in the order printed: first those of the copy it prints
 * (its own [start, headerEnd): what is left of a header read short is
 * already at the top of its text), then those of the other places that
 * print as it, in PDF order ([start, headerLinesEnd)). Lines that say the
 * same as lines already printed or shown there (headerKey: the copy
 * printed, moved, kept in its body or shown by the header rows; or a block
 * taken before) are not taken twice: they are printed once. When the
 * printed copy's own lines are printed nowhere (`unshown`: its plan leaves
 * them out and the rows cannot show them), the same lines of another copy
 * are taken.
 */
function movedHeaders(
    result: ThreadAnalysisResult,
    entries: ReadonlyMap<number, { readonly copy: AnalyzedRebuiltMessage; readonly position: number }>,
    candidates: readonly MoveCandidate[],
    unshown: ReadonlySet<number>,
    pdfNumberByPosition: readonly (number | null)[],
): Map<number, readonly string[]>
{
    const movedByEntry = new Map<number, readonly string[]>();
    const bodyAt = (position: number): string => result.messages[position]?.message.bodyText ?? '';
    for (const [entryId, entry] of entries)
    {
        const entryCandidates = candidates.filter((c) => c.entryId === entryId);
        if (entryCandidates.length === 0)
        {
            continue;
        }
        const shownBody = bodyAt(entry.position);
        const shownCopy = entry.copy.rebuilt;
        const seen = new Set<string>(unshown.has(entryId) ? [] : [headerKey(shownBody.slice(shownCopy.start, headerLinesEnd(shownBody, shownCopy)))]);
        const movedTexts: string[] = [];
        const addMoved = (text: string): void =>
        {
            if (text.trim() === '')
            {
                return;
            }
            movedTexts.push(/[\r\n]$/u.test(text) ? text : `${text}\n`);
        };
        const ownCandidate = entryCandidates.find((c) => c.copyId === entry.copy.id && c.position === entry.position);
        if (ownCandidate !== undefined)
        {
            addMoved(bodyAt(ownCandidate.position).slice(ownCandidate.start, ownCandidate.headerEnd));
        }
        const others = entryCandidates
            .filter((c) => c !== ownCandidate)
            .sort((a, b) => (pdfNumberByPosition[a.position] ?? 0) - (pdfNumberByPosition[b.position] ?? 0) || a.start - b.start);
        for (const candidate of others)
        {
            const text = bodyAt(candidate.position).slice(candidate.start, candidate.linesEnd);
            const key = headerKey(text);
            if (seen.has(key))
            {
                continue;
            }
            seen.add(key);
            addMoved(text);
        }
        if (movedTexts.length > 0)
        {
            movedByEntry.set(entryId, movedTexts);
        }
    }
    return movedByEntry;
}

/**
 * `range` cut at the bounds of `intervals` (sorted), its pieces inside them
 * left out, whatever its reason (task 8.13a: printedElsewhere alone decides
 * what is cut; it keeps every place that holds the writer's answer, Q3). Returns
 * whether text other than white space was left out.
 */
function cutRange(body: string, range: PlanRange, intervals: BodyIntervals, cutRanges: CutRanges): boolean
{
    let leftOut = false;
    let from = range.start;
    const push = (piece: PlanRange, cut: boolean): void =>
    {
        cutRanges.ranges.push(piece);
        cutRanges.cut.push(cut);
    };
    for (const [intervalStart, intervalEnd] of intervals)
    {
        if (intervalEnd <= from)
        {
            continue;
        }
        if (intervalStart >= range.end || from >= range.end)
        {
            break;
        }
        const start = Math.max(intervalStart, from);
        const end = Math.min(intervalEnd, range.end);
        const hasText = /\S/.test(body.slice(start, end));
        if (start > from)
        {
            push({ ...range, start: from, end: start }, false);
        }
        push({ ...range, start, end, keep: false }, true);
        if (hasText)
        {
            leftOut = true;
        }
        from = end;
    }
    if (from < range.end)
    {
        push({ ...range, start: from, end: range.end }, false);
    }
    return leftOut;
}

/** Ranges, and for each one whether the no-repeat rule left it out (same order). */
interface CutRanges
{
    readonly ranges: PlanRange[];
    readonly cut: boolean[];
}

/** withoutPrintedElsewhere, with which ranges the rule left out. */
function cutPrintedElsewhere(body: string, ranges: readonly PlanRange[], parts: BodyIntervals): CutRanges & { readonly leftOut: boolean }
{
    const cutRanges: CutRanges = { ranges: [], cut: [] };
    let leftOut = false;
    for (const range of ranges)
    {
        if (!range.keep)
        {
            cutRanges.ranges.push(range);
            cutRanges.cut.push(false);
            continue;
        }
        if (cutRange(body, range, overlappingIntervals(parts, range.start, range.end), cutRanges))
        {
            leftOut = true;
        }
    }
    return { ...cutRanges, leftOut };
}

/** The intervals of a sorted list that may touch [start, end), as a slice (binary search on the end). */
function overlappingIntervals(intervals: BodyIntervals, start: number, end: number): BodyIntervals
{
    let lo = 0;
    let hi = intervals.length;
    while (lo < hi)
    {
        const mid = (lo + hi) >> 1;
        if ((intervals[mid]?.[1] ?? 0) <= start)
        {
            lo = mid + 1;
        }
        else
        {
            hi = mid;
        }
    }
    let endIndex = lo;
    while (endIndex < intervals.length && (intervals[endIndex]?.[0] ?? end) < end)
    {
        endIndex++;
    }
    return intervals.slice(lo, endIndex);
}

/**
 * A plan's ranges with the parts printed elsewhere (`parts`, from
 * printedElsewhere) left out: a kept range is cut at the bounds of those
 * parts and its pieces inside them are left out, whatever their reason.
 * Which text may go is decided by printedElsewhere alone (task 8.13a): it
 * gives no part for a place that holds the writer's answer (own text next
 * to quoted text, B1 / Q3), while a place whose own text is only text the
 * plan could not check (Q3) is cut whole, 'text' ranges included (before
 * task 8.13a, a 'text' range or a kept signature was never cut here).
 * `leftOut`: some text other than white space was left out by this rule.
 */
export function withoutPrintedElsewhere(
    body: string,
    ranges: readonly PlanRange[],
    parts: BodyIntervals,
): { readonly ranges: readonly PlanRange[]; readonly leftOut: boolean }
{
    if (parts.length === 0)
    {
        return { ranges, leftOut: false };
    }
    const cut = cutPrintedElsewhere(body, ranges, parts);
    return { ranges: cut.ranges, leftOut: cut.leftOut };
}

/**
 * The ranges of a real email's body as the PDF prints them (task 8.11, for
 * the preview's labels): the plan's ranges cut exactly as bodyTextOf cuts
 * them (withoutPrintedElsewhere with mergeParts of `parts`, the same call
 * the PDF makes), each piece the rule left out carrying the email the PDF
 * prints it as (from `parts`, printedElsewhereParts; a piece that spans two
 * parts is split between them). null when the PDF prints the body whole
 * ("Print full original text", a plan missing, not valid or failed: see
 * bodyTextOf), or when nothing is left out this way: the plan's ranges are
 * then what the PDF prints. `restored` (NoRepeatResult.restored, review round 3
 * of task 8.13b-3): pieces the plan leaves out that the PDF prints after
 * all, because their text is printed nowhere else; they come back kept
 * (printedAs null), with the plan's reason.
 */
export function pdfRanges(
    body: string,
    plan: MessagePlan | null | undefined,
    policy: Pick<OutputPolicy, 'unfoldEverything'>,
    parts: readonly PrintedPart[],
    restored: BodyIntervals = NO_INTERVALS,
): readonly PdfRange[] | null
{
    if (policy.unfoldEverything || (parts.length === 0 && restored.length === 0) || !hasValidRanges(plan, body.length) || plan.fallback)
    {
        return null;
    }
    const cut = cutPrintedElsewhere(body, plan.ranges, mergeParts(parts));
    if (!cut.cut.includes(true) && restored.length === 0)
    {
        return null;
    }
    const printedRanges: PdfRange[] = [];
    cut.ranges.forEach((range, rangeIndex) =>
    {
        if (cut.cut[rangeIndex] !== true)
        {
            printedRanges.push({ ...range, printedAs: null });
            return;
        }
        // A piece left out lies inside the union of the parts, which tile it.
        let from = range.start;
        for (const part of parts)
        {
            if (part.end <= from || part.start >= range.end)
            {
                continue;
            }
            const start = Math.max(from, part.start);
            const end = Math.min(range.end, part.end);
            if (start > from)
            {
                printedRanges.push({ ...range, start: from, end: start, printedAs: null }); // not expected (parts tile it)
            }
            printedRanges.push({ ...range, start, end, printedAs: part.printedAs });
            from = end;
        }
        if (from < range.end)
        {
            printedRanges.push({ ...range, start: from, end: range.end, printedAs: null }); // not expected
        }
    });
    return withRestored(printedRanges, restored);
}

/**
 * `ranges` (a cover of the body) with the pieces inside `restored` (sorted
 * intervals) kept: a range is cut at their bounds and its pieces inside
 * them get keep true (and no `printedAs`), whatever they were. The restored
 * pieces are always pieces the plan leaves out (printedNowhere), never
 * pieces the no-repeat rule cut.
 */
function withRestored<R extends PlanRange & { readonly printedAs?: PrintedAs | null }>(ranges: readonly R[], restored: BodyIntervals): R[]
{
    if (restored.length === 0)
    {
        return [...ranges];
    }
    const split: R[] = [];
    for (const range of ranges)
    {
        let from = range.start;
        for (const [restoredStart, restoredEnd] of overlappingIntervals(restored, range.start, range.end))
        {
            const start = Math.max(restoredStart, from);
            const end = Math.min(restoredEnd, range.end);
            if (end <= start)
            {
                continue;
            }
            if (start > from)
            {
                split.push({ ...range, start: from, end: start });
            }
            split.push({ ...range, start, end, keep: true, ...('printedAs' in range ? { printedAs: null } : {}) });
            from = end;
        }
        if (from < range.end)
        {
            split.push({ ...range, start: from, end: range.end });
        }
    }
    return split;
}

/** What the no-repeat rule needs: the PDF's input, less what only the layout uses. */
export type NoRepeatInput = Pick<BuildPdfInput, 'result' | 'positions' | 'plans' | 'policy' | 'rebuilt' | 'rebuildingOff' | 'unticked'>;

/** The emails in the PDF and the parts of their bodies printed elsewhere (applyNoRepeatRule). */
export interface NoRepeatResult
{
    readonly order: PdfOrder;
    /** Per list position, the parts left out and where they are printed (printedElsewhereParts); empty under "Print full original text". */
    readonly parts: ReadonlyMap<number, readonly PrintedPart[]>;
    /** Per list position, the same parts merged: what bodyTextOf leaves out (printedElsewhere). */
    readonly elsewhere: ReadonlyMap<number, BodyIntervals>;
    /**
     * Per rebuilt entry in the PDF (its id), the blocks of original header
     * lines moved to the top of its text, in order (task 8.13a, Q4; see
     * printedElsewhere): each exactly as written in its source body (quote
     * marks included: the PDF drops them, Source/pdf-export/pdf-text-transforms.ts), ending with a
     * line break. An entry with none is not in the map.
     */
    readonly moved: ReadonlyMap<number, readonly string[]>;
    /**
     * Per list position, the pieces of its body that its plan leaves out but
     * the PDF prints after all, because their text is printed nowhere else
     * (printedNowhere; PRINTED SOMEWHERE at the top of this file). Sorted
     * intervals; a position with none is not in the map. Empty under "Print
     * full original text".
     */
    readonly restored: ReadonlyMap<number, BodyIntervals>;
    /**
     * Per rebuilt entry in the PDF (its id), its signature plans (rebuiltPlans, task 9.9b-2). Empty
     * under "Print full original text" (no rebuilt email is in the PDF then).
     */
    readonly rebuiltPlans: ReadonlyMap<number, RebuiltPlan>;
}

/** The signature plans of one rebuilt entry in the PDF (NoRepeatResult.rebuiltPlans). */
export interface RebuiltPlan
{
    /** Over the text of the copy the PDF prints (slot.source.shown, rebuiltInPdf). */
    readonly shown: MessagePlan;
    /** Over the entry's own text (what its preview card shows); the same plan when the PDF prints the entry itself. */
    readonly own: MessagePlan;
}

/**
 * SIGNATURES IN REBUILT EMAILS (task 9.9b-2, user decision F4: "the same way as real emails"). The
 * thread analysis folds a rebuilt email's signature by the rules of a real email
 * (AnalyzedRebuiltMessage.segments); this decides which of those blocks the PDF prints, as rule 3
 * of Source/thread-analysis/output-plan.ts does for a real email: walking the PDF order, a block is
 * left out when the same block (signatureBlockKey) was already KEPT for the same sender in an email
 * before it, real or rebuilt (a real one as the PDF prints it: its plan's kept ranges after the
 * no-repeat cut `elsewhere`, as printedNowhere reads them; a rebuilt one as planRebuiltText keeps
 * it); the first one is printed. The card's own plan (`own`) and the printed copy's plan
 * (`shown`) are each decided on what was kept BEFORE this email (also when the PDF prints the entry
 * as another copy); `own` works on a copy of the kept set, so it never marks a block as printed that
 * only the card holds. The sender of a rebuilt email is the address of its quoted From
 * (senderKeyOfMailboxes), compared as a real email's (senderKeyOf). The real emails' plans are
 * not changed: a real email AFTER a rebuilt one still prints a block that only the rebuilt one kept
 * (printed twice rather than lost). A rebuilt email with no folds is printed whole, as before.
 * The preview labels the folds of a rebuilt card from these plans
 * (Source/web-page-logic/printed-elsewhere.ts), so it says what the PDF does.
 */
function rebuiltPlans(
    result: ThreadAnalysisResult,
    slots: readonly PdfSlot[],
    plans: ReadonlyMap<number, MessagePlan | undefined>,
    elsewhere: ReadonlyMap<number, BodyIntervals>,
    policy: OutputPolicy,
): Map<number, RebuiltPlan>
{
    const out = new Map<number, RebuiltPlan>();
    const kept = new Map<string, Set<string>>();
    const senderOf = (read: () => string): string =>
    {
        try
        {
            return read();
        }
        catch
        {
            return '';
        }
    };
    for (const slot of slots)
    {
        if (slot.kind === 'email')
        {
            const message = result.messages[slot.position]?.message;
            const plan = plans.get(slot.position);
            if (message === undefined || !hasValidRanges(plan, message.bodyText.length) || plan.fallback)
            {
                continue;
            }
            const sender = senderOf(() => senderKeyOf(message));
            if (sender === '')
            {
                continue;
            }
            // What the PDF prints of it: its plan after the no-repeat cut, as printedNowhere reads it (a kept
            // block inside a part printed elsewhere is not printed HERE, so it does not count as printed before).
            for (const range of withoutPrintedElsewhere(message.bodyText, plan.ranges, elsewhere.get(slot.position) ?? NO_INTERVALS).ranges)
            {
                if (range.keep && range.reason === 'signature')
                {
                    let set = kept.get(sender);
                    if (set === undefined)
                    {
                        set = new Set();
                        kept.set(sender, set);
                    }
                    set.add(signatureBlockKey(message.bodyText.slice(range.start, range.end)));
                }
            }
            continue;
        }
        const planFor = (rebuiltEntry: AnalyzedRebuiltMessage, memory: Map<string, Set<string>>): MessagePlan =>
            planRebuiltText(rebuiltEntry.rebuilt.reconstructedText, rebuiltEntry.segments,
                senderOf(() => senderKeyOfMailboxes(rebuiltEntry.rebuilt.from)), policy, memory);
        const shownCopy = slot.source.shown.rebuilt;
        // The card's own text when the PDF prints another copy: decided on a copy of what was kept so far.
        const own = shownCopy.id === slot.entry.id ? null : planFor(slot.entry, new Map([...kept].map(([sender, set]) => [sender, new Set(set)])));
        const shown = planFor(shownCopy, kept);
        out.set(slot.entry.id, { shown, own: own ?? shown });
    }
    return out;
}

/** What the PDF prints of a rebuilt email's text: its signature plan's kept ranges (rebuiltPlans); the whole text without a usable plan. */
function rebuiltPrintedText(text: string, plan: MessagePlan | undefined): { readonly text: string; readonly notLineStarts: ReadonlySet<number> }
{
    if (!hasValidRanges(plan, text.length) || plan.fallback)
    {
        return { text, notLineStarts: NO_JOINS };
    }
    return joinKeptLines(text, plan.ranges);
}

/**
 * The PRINTED SOMEWHERE check (see the top of this file; task 8.13b-3,
 * review round 3, finding M2): the pieces of the real emails in the PDF that
 * their plan leaves out only because another email in the PDF holds the
 * same text, and that are printed nowhere in the PDF. Candidates: in each
 * email whose plan is used (valid, not a fallback), each part of a range
 * the plan leaves out (not a signature) that lies in a folded segment whose
 * ONLY reason is 'quoted-overlap', linked (`related`) to an email in the
 * PDF: text with no quote mark and no reply header of its own, left out
 * only because that other email holds it (output-plan.ts rule 2, an overlap
 * start: "that text is in the PDF anyway"). Quoted history under a reply
 * header or behind ">" marks is not a candidate: it is left out as the
 * mail app's quoted history (rule 2), as before, whether or not its email
 * is in the PDF. Touching parts are joined into one piece. Each piece, in PDF order, is
 * checked against the text the PDF prints (Source/pdf-export/printed-somewhere-check.ts: every
 * real email's printed ranges after the no-repeat cut, every rebuilt
 * email's text with its moved header lines, and the pieces restored before
 * it); one that is not found is restored, and its text then counts as
 * printed for the pieces after it (so a text two emails each leave out
 * "because the other one has it" is printed once, in the first). What is
 * printed only grows, so a piece found stays found. Costs nothing when
 * there is no candidate; else about linear in the text of the PDF (see
 * printed-somewhere-check.ts).
 */
function printedNowhere(
    result: ThreadAnalysisResult,
    order: PdfOrder,
    plans: ReadonlyMap<number, MessagePlan | undefined>,
    elsewhere: ReadonlyMap<number, BodyIntervals>,
    moved: ReadonlyMap<number, readonly string[]>,
    plansOfRebuilt: ReadonlyMap<number, RebuiltPlan>,
): Map<number, BodyIntervals>
{
    const restored = new Map<number, BodyIntervals>();
    const inPdf = (index: unknown): boolean =>
    {
        const position = typeof index === 'number' ? result.positionByIndex[index] : undefined;
        return typeof position === 'number' && order.pdfNumberByPosition[position] != null;
    };
    const candidates: { readonly position: number; readonly start: number; readonly end: number }[] = [];
    for (const slot of order.slots)
    {
        if (slot.kind !== 'email')
        {
            continue;
        }
        const analyzedMessage = result.messages[slot.position];
        const plan = plans.get(slot.position);
        if (analyzedMessage === undefined || !hasValidRanges(plan, analyzedMessage.message.bodyText.length) || plan.fallback)
        {
            continue;
        }
        // A plain boolean check: Array.isArray as a type guard would turn the list into any[].
        const isList: boolean = Array.isArray(analyzedMessage.segments);
        if (!isList)
        {
            continue;
        }
        // Segments are a sorted cover of the body: these intervals are sorted and do not overlap (as `overlappingIntervals` needs).
        const linked = analyzedMessage.segments
            .filter(
                (segment) =>
                    segment.folded &&
                    Array.isArray(segment.reasons) &&
                    segment.reasons.length > 0 &&
                    segment.reasons.every((reason) => reason === 'quoted-overlap') &&
                    Array.isArray(segment.related) &&
                    segment.related.some(inPdf),
            )
            .map((s): [number, number] => [s.start, s.end]);
        if (linked.length === 0)
        {
            continue;
        }
        let openCandidate: { start: number; end: number } | null = null;
        const closeCandidate = (): void =>
        {
            if (openCandidate !== null)
            {
                candidates.push({ position: slot.position, start: openCandidate.start, end: openCandidate.end });
            }
            openCandidate = null;
        };
        for (const range of plan.ranges)
        {
            if (range.keep || range.reason === 'signature' || range.reason === 'repeated-signature')
            {
                continue;
            }
            for (const linkedInterval of overlappingIntervals(linked, range.start, range.end))
            {
                const start = Math.max(linkedInterval[0], range.start);
                const end = Math.min(linkedInterval[1], range.end);
                if (end <= start)
                {
                    continue;
                }
                if (openCandidate !== null && openCandidate.end === start)
                {
                    openCandidate.end = end;
                }
                else
                {
                    closeCandidate();
                    openCandidate = { start, end };
                }
            }
        }
        closeCandidate();
    }
    if (candidates.length === 0)
    {
        return restored;
    }

    // The text the PDF prints, before anything is restored.
    const printed = createPrintedText();
    for (const slot of order.slots)
    {
        if (slot.kind === 'rebuilt')
        {
            const shownText = slot.source.shown.rebuilt.rebuilt.reconstructedText;
            printed.add((moved.get(slot.entry.id) ?? []).join('') + rebuiltPrintedText(shownText, plansOfRebuilt.get(slot.entry.id)?.shown).text);
            continue;
        }
        const body = result.messages[slot.position]?.message.bodyText ?? '';
        const plan = plans.get(slot.position);
        if (!hasValidRanges(plan, body.length) || plan.fallback)
        {
            printed.add(body);
            continue;
        }
        // Each run of kept ranges, as one piece of printed text.
        let runStart = -1;
        let runEnd = -1;
        for (const range of withoutPrintedElsewhere(body, plan.ranges, elsewhere.get(slot.position) ?? NO_INTERVALS).ranges)
        {
            if (!range.keep)
            {
                continue;
            }
            if (range.start !== runEnd)
            {
                if (runStart >= 0)
                {
                    printed.add(body.slice(runStart, runEnd));
                }
                runStart = range.start;
            }
            runEnd = range.end;
        }
        if (runStart >= 0)
        {
            printed.add(body.slice(runStart, runEnd));
        }
    }

    const notFound = new Map<number, [number, number][]>();
    for (const candidate of candidates)
    {
        const text = (result.messages[candidate.position]?.message.bodyText ?? '').slice(candidate.start, candidate.end);
        if (printed.covers(text))
        {
            continue;
        }
        printed.add(text);
        let notFoundHere = notFound.get(candidate.position);
        if (notFoundHere === undefined)
        {
            notFound.set(candidate.position, (notFoundHere = []));
        }
        notFoundHere.push([candidate.start, candidate.end]);
    }
    for (const [position, list] of notFound)
    {
        restored.set(position, mergeParts(list.map(([start, end]) => ({ start, end }))));
    }
    return restored;
}

/**
 * The order of the PDF (planPdfOrder, no rebuilt email under "Print full
 * original text") and the no-repeat rule's parts, exactly as
 * buildPdfDocument works them out: it calls this, and so does the preview
 * (Source/web-page-logic/printed-elsewhere.ts, task 8.11), so the labels say what
 * the PDF does. Then the PRINTED SOMEWHERE check (printedNowhere), on the
 * same data, for both.
 */
export function applyNoRepeatRule(input: NoRepeatInput): NoRepeatResult
{
    const { result, positions, plans } = input;
    const unfoldEverything = input.policy.unfoldEverything === true;
    const order = planPdfOrder(result, positions, unfoldEverything ? [] : (input.rebuilt ?? []));
    if (unfoldEverything)
    {
        return { order, parts: new Map(), elsewhere: new Map(), moved: new Map(), restored: new Map(), rebuiltPlans: new Map() };
    }
    const planByPosition = new Map<number, MessagePlan | undefined>();
    for (const slot of order.slots)
    {
        if (slot.kind === 'email')
        {
            planByPosition.set(slot.position, plans[slot.plan]);
        }
    }
    // The rebuilt emails the reader really unticked, for the unticked forwarded parts (Q2; task 8.13a review
    // round 2: never inferred from what `rebuilt` lacks). The switch off: none is unticked. Chosen ones never are.
    const chosenIds = new Set(input.rebuilt ?? []);
    const unticked = input.rebuildingOff === true ? undefined : new Set((input.unticked ?? []).filter((id) => !chosenIds.has(id)));
    // The emails the reader ticked (an attached email left out only for having no text, and with no attachments:
    // its block is labelled 'no-text-attached', one the reader unticked 'unticked-attached').
    // F6 (task 9.9b): a forward whose rebuild failed is folded as the preview folds it, while rebuilding is on.
    const { parts, moved } = noRepeatParts(result, order.slots, order.pdfNumberByPosition, planByPosition, unticked, new Set(positions),
        input.rebuildingOff !== true);
    const elsewhere = new Map<number, BodyIntervals>();
    for (const [position, list] of parts)
    {
        elsewhere.set(position, mergeParts(list));
    }
    const plansOfRebuilt = rebuiltPlans(result, order.slots, planByPosition, elsewhere, input.policy);
    const restored = printedNowhere(result, order, planByPosition, elsewhere, moved, plansOfRebuilt);
    return { order, parts, elsewhere, moved, restored, rebuiltPlans: plansOfRebuilt };
}

/** pdfBodyText, and whether the no-repeat rule left something out. `restored`: see NoRepeatResult.restored. */
function bodyTextOf(
    body: string,
    plan: MessagePlan | null | undefined,
    policy: Pick<OutputPolicy, 'unfoldEverything'>,
    elsewhere: BodyIntervals,
    restored: BodyIntervals = NO_INTERVALS,
): { readonly text: string; readonly planFallback: boolean; readonly notLineStarts: ReadonlySet<number>; readonly leftOutElsewhere: boolean }
{
    if (policy.unfoldEverything)
    {
        return { text: body, planFallback: false, notLineStarts: NO_JOINS, leftOutElsewhere: false };
    }
    if (!hasValidRanges(plan, body.length))
    {
        return { text: body, planFallback: true, notLineStarts: NO_JOINS, leftOutElsewhere: false };
    }
    if (plan.fallback)
    {
        return { text: body, planFallback: true, notLineStarts: NO_JOINS, leftOutElsewhere: false };
    }
    const cut = withoutPrintedElsewhere(body, plan.ranges, elsewhere);
    const joined = joinKeptLines(body, withRestored(cut.ranges, restored));
    return { text: joined.text, planFallback: false, notLineStarts: joined.notLineStarts, leftOutElsewhere: cut.leftOut };
}

/**
 * What the PDF shows of a body, before the display transforms; with
 * `notLineStarts` for bodyLines (Source/pdf-export/pdf-text-transforms.ts, joinKeptLines).
 * `elsewhere`: the parts of this body printed as emails of their own
 * (printedElsewhere), left out (withoutPrintedElsewhere) unless the whole
 * body is printed (see the top of this file).
 */
export function pdfBodyText(
    body: string,
    plan: MessagePlan | null | undefined,
    policy: Pick<OutputPolicy, 'unfoldEverything'>,
    elsewhere: BodyIntervals = NO_INTERVALS,
): { readonly text: string; readonly planFallback: boolean; readonly notLineStarts: ReadonlySet<number> }
{
    const { text, planFallback, notLineStarts } = bodyTextOf(body, plan, policy, elsewhere);
    return { text, planFallback, notLineStarts };
}

/** Sanitizes one-line texts (Source/pdf-export/pdf-text-transforms.ts, inlineRuns) and adds up the characters replaced by a code. */
interface Sanitizer
{
    codedCount: number;
    line(text: string, role: PdfRole): PdfLine;
}

function createSanitizer(): Sanitizer
{
    const sanitizer: Sanitizer = {
        codedCount: 0,
        line(text, role)
        {
            const sanitized = inlineRuns(text, role);
            sanitizer.codedCount += sanitized.codedCount;
            return sanitized.runs;
        },
    };
    return sanitizer;
}

/** A line of one run of our own text (no sanitizing needed, but harmless). */
function ownTextLine(text: string, role: PdfRole): PdfLine
{
    return text === '' ? [] : [{ role, text }];
}

/** The mailboxes of one email that name its people: a real email, or a rebuilt one (no Sender). */
export type ParticipantSource = Pick<NormalizedMessage, 'from' | 'to' | 'cc'> & { readonly sender?: EmailAddress | undefined };

/**
 * Distinct people across From, Sender, To and Cc, deduplicated by address
 * (letter case ignored), sorted. Name and address spelling always come from
 * one mailbox: the first one seen with a name, else the first one seen.
 */
export function participantsOf(messages: readonly ParticipantSource[], locale: string): PdfParticipant[]
{
    const byKey = new Map<string, { name: string; address: string }>();
    const addMailbox = (mailbox: EmailAddress | undefined): void =>
    {
        if (mailbox === undefined || isBlankMailbox(mailbox))
        {
            return;
        }
        const address = mailbox.address.trim();
        const name = mailbox.name.trim();
        const key = address !== '' ? `a:${address.toLowerCase()}` : `n:${name.toLowerCase()}`;
        const found = byKey.get(key);
        if (found === undefined)
        {
            byKey.set(key, { name, address });
        }
        else if (found.name === '' && name !== '')
        {
            // The first name seen wins, with the address spelling of its own mailbox.
            found.name = name;
            found.address = address;
        }
    };
    for (const message of messages)
    {
        for (const mailbox of message.from)
        {
            addMailbox(mailbox);
        }
        addMailbox(message.sender);
        for (const mailbox of message.to)
        {
            addMailbox(mailbox);
        }
        for (const mailbox of message.cc)
        {
            addMailbox(mailbox);
        }
    }
    const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
    return [...byKey.values()].sort(
        (a, b) => collator.compare(a.name || a.address, b.name || b.address) || collator.compare(a.address, b.address) || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0),
    );
}

// ---------------------------------------------------------------- one email

/** A date as the cover's date range uses it: a moment to compare, and its text. */
interface CoverDate
{
    readonly utcMs: number;
    readonly text: string;
}

interface EmailParts
{
    readonly email: PdfEmail;
    readonly entry: PdfIndexEntry;
    /** null: no usable date (counted as undated on the cover). */
    readonly when: CoverDate | null;
    /** Its people, for the cover. */
    readonly people: ParticipantSource;
}

/** Between the levels of an attached email's File row (Source/web-page-logic/file-chain.ts). */
export { FILE_CHAIN_SEPARATOR };

/**
 * One line of an email's File row for the copy at input position `index`
 * (the kept copy or a merged one): its file name, or "(file without a name)";
 * for an email attached inside a file (task 8.13b-3, Q5), the file name and
 * then the attachment name at each level down to it (AnalyzedAttachedMessage.names),
 * joined by FILE_CHAIN_SEPARATOR, an attachment without a name shown as
 * "(attached email N)" with its number at that level (AnalyzedAttachedMessage.path:
 * the n-th attached email of the email holding it). The text comes from
 * Source/web-page-logic/file-chain.ts, shared with the preview's "Also in" row (task
 * 8.13b-4, P2), so the two never disagree.
 */
function fileRowLine(result: ThreadAnalysisResult, index: number, fileName: string, strings: PdfStrings, sanitizer: Sanitizer): PdfLine
{
    const chain = fileChain(result, index, fileName, strings);
    return chain.ownWords ? ownTextLine(chain.text, 'muted') : sanitizer.line(chain.text, 'muted');
}

function buildEmail(
    analyzedMessage: AnalyzedMessage,
    position: number,
    number: number,
    plan: MessagePlan | undefined,
    input: BuildPdfInput,
    elsewhere: BodyIntervals,
    restored: BodyIntervals,
): EmailParts
{
    const { strings, policy } = input;
    const message = analyzedMessage.message;
    const sanitizer = createSanitizer();
    const indexSanitizer = createSanitizer(); // the index repeats the header texts: not counted again

    // Header rows.
    const fields: PdfFieldRow[] = [];
    const addMailboxRow = (label: string, mailboxes: readonly EmailAddress[]): void =>
    {
        const shown = mailboxes.filter((x) => !isBlankMailbox(x));
        if (shown.length > 0)
        {
            fields.push({ label, value: [sanitizer.line(joinMailboxes(shown.map((x) => mailboxText(x, strings))), 'field-value')] });
        }
    };
    const author = displayAuthor(message);
    const fromShown = message.from.filter((x) => !isBlankMailbox(x));
    if (fromShown.length > 0)
    {
        addMailboxRow(strings.fromLabel, fromShown);
    }
    else
    {
        fields.push({ label: strings.fromLabel, value: [ownTextLine(strings.unknownSender, 'muted')] });
    }
    if (message.sender !== undefined && !isBlankMailbox(message.sender))
    {
        addMailboxRow(strings.senderLabel, [message.sender]);
    }
    addMailboxRow(strings.toLabel, message.to);
    addMailboxRow(strings.ccLabel, message.cc);
    addMailboxRow(strings.bccLabel, message.bcc);

    // As written: the sender's own clock, never converted (task 9.9c).
    const shown = formatEmailDate(message.date);
    const dated = shown.kind === 'date' && isDisplayableMs(message.date.utcMs);
    const zoneUnknown = dated && message.warnings.includes('unknown-time-zone');
    const dateLines: PdfLine[] = [];
    if (shown.kind === 'date' && dated)
    {
        dateLines.push(ownTextLine(shown.text, 'field-value'));
    }
    else if (message.date.original.trim() !== '')
    {
        // A date that could not be read: its text as written, with no note (task 8.8).
        dateLines.push(sanitizer.line(message.date.original, 'field-value'));
    }
    else
    {
        dateLines.push(ownTextLine(strings.noDate, 'muted'));
    }
    fields.push({ label: strings.dateLabel, value: dateLines });

    const hasSubject = message.subject.trim() !== '';
    fields.push({ label: strings.subjectLabel,
        value: [hasSubject ? sanitizer.line(message.subject, 'field-value') : ownTextLine(strings.noSubject, 'muted')] });
    const files = [{ index: analyzedMessage.index, fileName: message.source.fileName },
        ...analyzedMessage.duplicates.map((d) => ({ index: d.index, fileName: d.source.fileName }))];
    fields.push({ label: strings.fileLabel, value: files.map((f) => fileRowLine(input.result, f.index, f.fileName, strings, sanitizer)) });

    // Body.
    const { text, planFallback, notLineStarts, leftOutElsewhere } = bodyTextOf(message.bodyText, plan, policy, elsewhere, restored);
    const lines = bodyLines(text, { notLineStarts });
    sanitizer.codedCount += lines.codedCount;
    const keptAllBecauseEmpty = !policy.unfoldEverything && !planFallback && plan?.keptAllBecauseEmpty === true;

    // The only line above the text: the "(no text)" placeholder of an empty
    // text. What the tool was unsure about is said in the app, never in the
    // PDF (user rule, task 8.8). An email with no text at all never gets here
    // (task 8.14, planPdfOrder): the placeholder is for a text that could not
    // be read (Q2) or whose every part is printed elsewhere (Q6).
    const notes: PdfLine[] = lines.lines.length === 0 ? [ownTextLine(strings.noText, 'muted')] : [];
    const warnings = message.warnings;

    // Attachments.
    const attachmentLines = message.attachments.map((a): PdfLine =>
    {
        const name = a.fileName.trim() === '' ? ownTextLine(strings.noAttachmentName, 'muted') : sanitizer.line(a.fileName, 'field-value');
        const details = sanitizer.line(strings.attachmentDetails(strings.size(a.size), a.mimeType), 'muted');
        return [...name, { role: 'muted', text: ' ' }, ...details];
    });

    // Index entry (texts without codes counted again).
    const anchor = emailAnchor(number);
    const fromIndex: PdfLine =
        author.source === 'none' ? ownTextLine(strings.unknownSender, 'muted')
            : indexSanitizer.line(joinMailboxes(author.mailboxes.map(shortMailbox)), 'body');
    const subjectIndex = hasSubject ? indexSanitizer.line(message.subject, 'body') : ownTextLine(strings.noSubject, 'muted');
    const day = shown.kind === 'date' && dated ? shown.text.slice(0, 10) : strings.noDate;
    const indexEntry: PdfIndexEntry = {
        number,
        rebuilt: false,
        anchor,
        // Short ("2025-03-04 08:00", one line), as written.
        date: shown.kind === 'date' && dated ? ownTextLine(shown.shortText, 'body') : ownTextLine(strings.noDate, 'muted'),
        from: fromIndex,
        subject: subjectIndex,
        attachments: message.attachments.length,
        attachmentLines,
        bookmark: bookmarkTitle(strings.emailBookmark(number, day, lineText(fromIndex), lineText(subjectIndex))),
    };

    const email: PdfEmail = {
        number,
        anchor,
        position,
        heading: strings.emailHeading(number),
        rebuilt: null,
        fields,
        notes,
        body: lines.lines,
        attachments: attachmentLines.length === 0 ? null : { label: strings.attachmentsLabel, items: attachmentLines },
        flags: {
            undated: !dated,
            zoneUnknown,
            keptAllBecauseEmpty,
            planFallback,
            htmlConverted: warnings.includes('html-converted-body'),
            controlChars: sanitizer.codedCount,
            printedElsewhere: leftOutElsewhere,
        },
    };
    const utcMs = message.date.utcMs;
    const when = shown.kind === 'date' && isDisplayableMs(utcMs) ? { utcMs, text: shown.text } : null;
    return { email, entry: indexEntry, when, people: message };
}

// ---------------------------------------------------------------- one rebuilt email

/** A rebuilt email's date: the header's value lines, the index's short form, the bookmark's day and the cover's date. */
interface RebuiltDateParts
{
    readonly lines: readonly PdfLine[];
    readonly index: PdfLine;
    readonly day: string;
    readonly when: CoverDate | null;
    /** A time read without a zone of its own, so its place in the order is a guess (data only: the PDF does not say it, task 8.8). */
    readonly zoneUnknown: boolean;
}

/**
 * The date of a rebuilt email, shown as a real email's (task 8.3; see the
 * top of this file), from the best value read: a time as written, never
 * converted and never marked as a guess (task 9.9c; `zoneUnknown` when the
 * quote gave no zone of its own: data only); a day alone as that day; a date
 * that could not be read as written; none: "no date". The cover places it by
 * its estimated moment (`when.utcMs`).
 */
function rebuiltDateParts(rebuiltEntry: AnalyzedRebuiltMessage, input: BuildPdfInput, sanitizer: Sanitizer): RebuiltDateParts
{
    const { strings } = input;
    const date = rebuiltDate(rebuiltEntry);
    const undated = (lines: readonly PdfLine[]): RebuiltDateParts =>
        ({ lines, index: ownTextLine(strings.noDate, 'muted'), day: strings.noDate, when: null, zoneUnknown: false });
    if (date.kind === 'none')
    {
        return undated([ownTextLine(strings.noDate, 'muted')]);
    }
    // A date that could not be read: its text as written, with no note (task 8.8).
    const unreadable = (): RebuiltDateParts =>
        undated([date.text.trim() === '' ? ownTextLine(strings.noDate, 'muted') : sanitizer.line(date.text, 'field-value')]);
    if (date.kind === 'unreadable')
    {
        return unreadable();
    }
    if (date.kind === 'day')
    {
        // The estimated start of that day, to place it in the cover's date range.
        return {
            lines: [ownTextLine(date.day, 'field-value')],
            index: ownTextLine(date.day, 'body'),
            day: date.day,
            when: date.utcMs === null ? null : { utcMs: date.utcMs, text: date.day },
            zoneUnknown: false,
        };
    }
    const shown = formatWallClock(date.wallMs);
    if (shown.kind !== 'date')
    {
        return unreadable();
    }
    return {
        lines: [ownTextLine(shown.text, 'field-value')],
        index: ownTextLine(shown.shortText, 'body'),
        day: shown.text.slice(0, 10),
        when: { utcMs: date.utcMs, text: shown.text },
        zoneUnknown: date.approximate,
    };
}

/**
 * One rebuilt email (see the top of this file): numbered and shown like a
 * real email (task 8.3), with the copy chosen by rebuiltInPdf. Its text is
 * the rebuilt text (its own quote marks already removed), whole: no plan
 * applies to it. Deeper quotes left in it (">" lines of an older email it
 * quoted) lose their quote marks like a real email's (Source/pdf-export/pdf-text-transforms.ts, transform g).
 * `moved` (task 8.13a, Q4; NoRepeatResult.moved): original header lines its
 * header rows cannot show, left out of the emails that quote it; they come
 * first in its text, as plain text (the same role, font and indent as the
 * rest of its text), so nothing is lost and they sit under its header.
 */
function buildRebuiltEmail(entry: AnalyzedRebuiltMessage, source: RebuiltInPdf, number: number, input: BuildPdfInput,
    moved: readonly string[], plan: MessagePlan | undefined): EmailParts
{
    const { strings } = input;
    const shownEntry = source.shown.rebuilt;
    const shownMessage = shownEntry.rebuilt;
    const sanitizer = createSanitizer();
    const indexSanitizer = createSanitizer(); // the index repeats the header texts: not counted again

    const fields: PdfFieldRow[] = [];
    const nonBlankMailboxes = (list: readonly EmailAddress[]): EmailAddress[] => list.filter((x) => !isBlankMailbox(x));
    const addMailboxRow = (label: string, mailboxes: readonly EmailAddress[]): void =>
    {
        if (mailboxes.length > 0)
        {
            fields.push({ label, value: [sanitizer.line(joinMailboxes(mailboxes.map((x) => mailboxText(x, strings))), 'field-value')] });
        }
    };
    const from = nonBlankMailboxes(shownMessage.from);
    const to = nonBlankMailboxes(shownMessage.to);
    const cc = nonBlankMailboxes(shownMessage.cc);
    // A From row is never empty: "Unknown sender" when the quote names none, as for a real email.
    if (from.length > 0)
    {
        addMailboxRow(strings.fromLabel, from);
    }
    else
    {
        fields.push({ label: strings.fromLabel, value: [ownTextLine(strings.unknownSender, 'muted')] });
    }
    addMailboxRow(strings.toLabel, to);
    addMailboxRow(strings.ccLabel, cc);
    const date = rebuiltDateParts(shownEntry, input, sanitizer);
    fields.push({ label: strings.dateLabel, value: date.lines });
    const subject = shownMessage.subject !== null && shownMessage.subject.trim() !== '' ? shownMessage.subject : null;
    fields.push({ label: strings.subjectLabel,
        value: [subject !== null ? sanitizer.line(subject, 'field-value') : ownTextLine(strings.noSubject, 'muted')] });

    // Its text less the signature blocks its plan leaves out (rebuiltPlans, task 9.9b-2), under the moved header lines.
    const movedText = moved.join('');
    const printed = rebuiltPrintedText(shownMessage.reconstructedText, plan);
    const notLineStarts = new Set([...printed.notLineStarts].map((offset) => offset + movedText.length));
    const lines = bodyLines(movedText + printed.text, { notLineStarts });
    sanitizer.codedCount += lines.codedCount;
    // Not expected since task 8.14 (an entry whose rebuilt text is empty gets no slot, planPdfOrder): only
    // a copy shown in its place (rebuiltInPdf) could still be empty. Kept as the placeholder, never dropped.
    const notes: PdfLine[] = lines.lines.length === 0 ? [ownTextLine(strings.noText, 'muted')] : [];

    const anchor = emailAnchor(number);
    const fromIndex: PdfLine = from.length > 0 ? indexSanitizer.line(joinMailboxes(from.map(shortMailbox)), 'body')
        : ownTextLine(strings.unknownSender, 'muted');
    const subjectIndex: PdfLine = subject !== null ? indexSanitizer.line(subject, 'body') : ownTextLine(strings.noSubject, 'muted');
    const indexEntry: PdfIndexEntry = {
        number,
        rebuilt: true,
        anchor,
        date: date.index,
        from: fromIndex,
        subject: subjectIndex,
        attachments: 0,
        attachmentLines: [],
        bookmark: bookmarkTitle(strings.emailBookmark(number, date.day, lineText(fromIndex), lineText(subjectIndex))),
    };
    const email: PdfEmail = {
        number,
        anchor,
        position: null,
        heading: strings.emailHeading(number),
        rebuilt: { id: entry.id, shownId: shownEntry.id, sourcePosition: source.shown.position, movedHeaders: moved.length },
        fields,
        notes,
        body: lines.lines,
        attachments: null,
        flags: {
            undated: date.when === null,
            zoneUnknown: date.zoneUnknown,
            keptAllBecauseEmpty: false,
            planFallback: false,
            htmlConverted: false,
            controlChars: sanitizer.codedCount,
            printedElsewhere: false,
        },
    };
    return { email, entry: indexEntry, when: date.when, people: { from, to, cc } };
}

// ---------------------------------------------------------------- the document

/** Builds the whole PDF document model (see the top of this file). */
export function buildPdfDocument(input: BuildPdfInput): PdfDocument
{
    const { result, positions, plans, strings, generatedAt, generatedOffsetMinutes } = input;

    // The included emails: positions that exist, each once, in the given
    // order; the rebuilt ones chosen, at their place (planPdfOrder); none
    // under "Print full original text" (see the top of this file).
    // The no-repeat rule (task 8.10): nothing is printed twice unless the whole
    // text is. The preview's labels use the same call (applyNoRepeatRule, task 8.11).
    const {
        order: { slots, pdfNumberByPosition },
        elsewhere,
        moved,
        restored,
        rebuiltPlans: plansOfRebuilt,
    } = applyNoRepeatRule(
        { result, positions, plans, policy: input.policy, rebuilt: input.rebuilt, rebuildingOff: input.rebuildingOff, unticked: input.unticked });
    const emails: PdfEmail[] = [];
    const entries: PdfIndexEntry[] = [];
    const people: ParticipantSource[] = [];
    // The cover counts every email alike, rebuilt ones included (task 8.3).
    let undated = 0;
    let first: CoverDate | null = null;
    let last: CoverDate | null = null;
    for (const slot of slots)
    {
        let parts: EmailParts;
        if (slot.kind === 'rebuilt')
        {
            parts = buildRebuiltEmail(slot.entry, slot.source, slot.number, input, moved.get(slot.entry.id) ?? [], plansOfRebuilt.get(slot.entry.id)?.shown);
        }
        else
        {
            const analyzedMessage = result.messages[slot.position]!;
            parts = buildEmail(analyzedMessage, slot.position, slot.number, plans[slot.plan], input, elsewhere.get(slot.position) ?? NO_INTERVALS,
                restored.get(slot.position) ?? NO_INTERVALS);
        }
        emails.push(parts.email);
        entries.push(parts.entry);
        people.push(parts.people);
        const when = parts.when;
        if (when === null)
        {
            undated++;
        }
        else
        {
            if (first === null || when.utcMs < first.utcMs)
            {
                first = when;
            }
            if (last === null || when.utcMs > last.utcMs)
            {
                last = when;
            }
        }
    }
    const controlChars = emails.reduce((n, e) => n + e.flags.controlChars, 0);

    // Cover.
    const coverSanitizer = createSanitizer(); // the cover repeats names from the emails: not counted
    const generatedShown = generatedTime(generatedAt, generatedOffsetMinutes);
    const generated = generatedShown.kind === 'date' ? generatedShown.text : strings.noDate;
    const dateRange = first === null || last === null ? null : { first: first.text, last: last.text };

    // No dated email: the same "(no date)" placeholder as an email's own Date row (task 8.8).
    const dateLine: PdfLine =
        dateRange === null
            ? ownTextLine(strings.noDate, 'muted')
            : ownTextLine(dateRange.first === dateRange.last ? dateRange.first : strings.dateRange(dateRange.first, dateRange.last), 'field-value');

    const participants = participantsOf(people, strings.locale);

    const blocks: PdfBlock[] = [
        { kind: 'heading', level: 1, line: ownTextLine(strings.title, 'title') },
        {
            kind: 'fields',
            rows: [
                { label: strings.datesLabel, value: [dateLine] },
                { label: strings.emailsLabel, value: [ownTextLine(strings.emailCount(emails.length), 'field-value')] },
                { label: strings.generatedLabel, value: [ownTextLine(generated, 'field-value')] },
            ],
        },
    ];
    if (participants.length > 0)
    {
        blocks.push({ kind: 'heading', level: 2, line: ownTextLine(strings.peopleHeading, 'heading') });
        blocks.push({ kind: 'list', items: participants.map((p) => [coverSanitizer.line(mailboxText(p, strings), 'body')]) });
    }

    return {
        title: strings.title,
        fileName: pdfFileName(generatedAt, generatedOffsetMinutes, strings),
        cover: { blocks, dateRange, undated, emailCount: emails.length, generated, participants },
        index: {
            heading: strings.indexHeading,
            columns: strings.columns,
            entries,
        },
        emails,
        pdfNumberByPosition,
        controlChars,
    };
}
