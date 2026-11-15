// The PDF document model: everything the PDF will say, as plain data, before
// any layout. A renderer (our own PDF writer, or a library later) turns it
// into pages; this file knows nothing about pages, coordinates, fonts, sizes
// or PDF syntax, so the renderer can be replaced without touching it.
//
// buildPdfDocument() takes the engine result, the INCLUDED emails (list
// positions, in list order) with their output plans (src/engine/output-plan.ts,
// the same plans the preview labels show, src/ui/pdf-labels.ts), the policy,
// the time zone, the generation moment and the fixed texts, and returns a
// PdfDocument:
// - cover: title, date range, people, email count, generation date and time
//   zone (as `blocks` for the renderer, and as data); no source files and no
//   SHA-256 (user decision 2026-11-09, task 8.12);
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
// the two differ once an email is left out or a rebuilt email comes first:
// `pdfNumberByPosition` maps a list position to the PDF number of its real
// email (null when not in the PDF).
//
// Rebuilt emails (milestone 7, tasks 7.7 and 8.3; brief section 8.6):
// earlier emails rebuilt from the quoted text of an email
// (src/engine/rebuild-links.ts), the ones the reader chose (`rebuilt`,
// src/ui/review.ts includedRebuilt), at their place in the timeline
// (planPdfOrder). USER DECISION 2026-11-02 (task 8.3, an approved exception
// to brief section 8.6, for the PDF only): in the PDF a rebuilt email looks
// and is numbered exactly like a real one. Nothing in the PDF says or shows
// that it was rebuilt: the same heading ("Email N"), the same rows (From, To
// and Cc when there are any, Date, Subject; no File row, as it has no
// file), the same "Unknown sender", "(no subject)" and "no date" texts as a
// real email, its date shown as a real email's (a time in the chosen zone,
// a day alone as that day, a date that could not be read as written), no
// marker in the index or the bookmarks. On the cover it counts in "Emails", the date
// range and the people like a real email. The
// PREVIEW keeps marking rebuilt emails (src/ui/preview.ts), unchanged.
// PdfEmail.rebuilt and PdfIndexEntry.rebuilt still tell the two apart in
// the data (for tests and checks); the renderer never prints them.
// FOLLOW-SOURCE RULE (user decision Q1 (a)): a rebuilt email is in the PDF
// only while at least one email it was read from is (rebuiltInPdf in
// src/ui-model/rebuilt.ts); for a text quoted in several emails, the text
// and header shown are the ones read from its own source when that one is
// in the PDF, else from the source in the PDF that comes first.
// NO-REPEAT RULE (user decision 2026-11-06, task 8.10): when "Print full
// original text" is off, no email is printed twice. A part of a real
// email's body that the PDF prints as an email of its own is left out of
// that body, like quoted history (printedElsewhere,
// withoutPrintedElsewhere): the place a rebuilt email in the PDF was read
// from (it, or a copy of it), and the place of a rebuilt email linked to
// a real email that is in the PDF ("the real file wins"). This is what
// stops a forward from printing its forwarded emails inline when they are
// also printed on their own pages (the plan keeps a forwarded part, rule 1
// of src/engine/output-plan.ts). The preview labels each such part with
// the email that prints it, from the same calculation (noRepeat,
// printedElsewhereParts, pdfRanges; src/ui-model/printed-elsewhere.ts,
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
// forward with no text of its own then shows the "(no text)" placeholder
// (its forwarded emails are on their own pages). `flags.printedElsewhere`
// (data only) tells when the rule left something out. Known repeats this
// rule cannot remove (when unsure, the tool shows text twice rather than
// lose it): a rebuilt email that rebuild-links.ts could not prove to be
// the same as a real file (both are printed), a forwarded part that could
// not be rebuilt at all (the plan keeps it, even when its email is also in
// the PDF as a real file), the same old email kept inline in two real
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
// attached inside a dropped file is a real email of the engine's list
// (src/engine/engine.ts, EngineAttached), so it gets its own slot, number,
// index entry and page like any other (Q1, Q2: its own tick). Its File row
// names the file and each attachment down to it ("parent.eml ›
// forwarded.eml", fileRowLine, Q5). With "Print full original text" off,
// the no-repeat rule above also covers it: its printed block in the body of
// an email holding it (an inline forward in an .eml: EngineAttached.places)
// is left out of that body as follows (attachedBlockParts).
// - In the PDF (`printedAs` kind 'email'), ONLY THE PARTS ITS OWN PAGE
//   PRINTS are left out (task 8.13b-3, review round 4, M1, user decision
//   option a; blockClaims): its header lines, when its header rows show
//   all of its header data (EngineAttached.keptShowsHeader), and the pieces
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
//   attached email in the PDF inside it does not print itself.
// A merged copy: the block follows the kept copy (printed as it, or left
// out when it is unticked; Q8); a dropped file's copy is always the one
// kept (D2), and when it lacks header data the attached copy has (a Bcc
// line, a date), the block's header lines stay. A holder merged into
// another copy: the engine moves the place to the kept copy (S1,
// engine.ts settleAttached), so an unticked attached email is printed in
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
// (src/pdf/printed-check.ts: words only, whole sentences); one printed
// nowhere is printed where it is after all (NoRepeat.restored; the piece
// keeps the plan's reason, kept). Pieces are checked in PDF order and a
// restored one counts as printed for the next ones, so a paragraph two
// emails each leave out "because the other one has it" comes back once, in
// the first. It may still print twice (accepted: never nowhere). The same
// calculation gives the preview's labels (src/ui-model/printed-elsewhere.ts:
// a restored piece is labelled "In the PDF"). Quoted history under a reply
// header or behind ">" marks is not such a piece: it is left out by the
// plan's own rule, whether or not its email is in the PDF, as before.
// FULL ORIGINAL TEXT RULE ("Print full original text"; user decision
// 2026-10-28, task 7.8b, kept as a safety net in task 7.8c): with
// `policy.unfoldEverything` NO rebuilt email is in the PDF, whatever
// `rebuilt` says: every source email is then printed whole, quoted history
// included, so a rebuilt email would only print that text twice.
//
// Body: the plan's KEPT ranges, less the parts printed elsewhere (the
// no-repeat rule above), plus the pieces PRINTED SOMEWHERE restores,
// joined in order (src/pdf/text.ts, joinKept):
// nothing is written where a part is left out (README.md, rule R6, the
// exception for the PDF), except a line break when two kept parts would
// otherwise run together on one line. With `policy.unfoldEverything` the
// whole body is used, whatever the plan says. A plan that is missing or not
// a valid list of ranges (null included) keeps the whole body too (flag
// `planFallback`): when unsure, keep. Then the display-only transforms of
// src/pdf/text.ts apply (line ends, tabs, control and broken characters as
// codes in runs of role 'code', blank lines). That file also holds the
// contract with the renderer about invisible characters.
// Quote marks (user decisions 2026-11-02, task 8.1, and 2026-11-05, task
// 8.6, PDF only): a body line that starts with ">" quote marks is shown
// WITHOUT them (src/pdf/text.ts transform g). Quote levels are not kept:
// the renderer indents every body line by one fixed step, one tab (4 spaces
// of the body font; src/pdf/layout/config.ts, bodyIndentSpaces, task 8.9),
// quoted or not. Only the prefix is
// removed; the rest of the line is unchanged. This applies to the kept
// parts of a body, to the whole body under "Print full original text" and
// to the deeper quotes left in a rebuilt email's text (whose own quote
// marks the engine removed already). The preview and the original files
// (and their SHA-256) are unchanged.
//
// No notes in the PDF (user rule 2026-11-05, task 8.8): the PDF is the
// final product. Nothing in it says that something went wrong, may be
// missing or inaccurate, or how the tool works; the app says all of that in
// step 2 before the download (src/ui/review.ts, src/ui/preview.ts). The PDF
// keeps only the placeholders of blank fields ("(no subject)", "(no date)",
// "Unknown sender", "(no text)", "(attachment without a name)"), the page
// footer, headings, labels, the index and the bookmarks. The data behind the
// removed notes stays in the model (`flags`, `cover.undated`,
// `zoneFallback`, `controlChars`), for tests and checks; the renderer never
// prints it.
//
// Undated emails: shown with the "no date" text in the index; their Date
// row shows the date text as written when there is one, else "no date". The
// cover's date range covers the dated emails only (real and rebuilt; a
// rebuilt email dated by a day alone counts from the start of that day in
// the chosen zone, dayStartInZone, and shows as that day); with no dated
// email at all it shows "no date". Real undated emails are at the end of
// the list, in file order (src/engine/order.ts).
//
// No source files on the cover (user decision 2026-11-09, task 8.12, which
// replaces the list with SHA-256 of brief section 8.5): no heading, no file
// names, no hashes. The index follows the cover information directly
// (src/pdf/layout/index-table.ts). Each real email still names its file in
// its own File row. Files that could not be read are not in the PDF at all
// (step 1 of the app lists them with the reasons). The cover has no text
// about rebuilt emails either (task 8.3, checked again in task 8.7).
//
// Safety: email text is plain data here. It is never read as markup or
// code (README.md, rule R4); the renderer writes it as text. Nothing is
// stored (README.md, rule R5). The stored messages are never changed: every
// transform makes new strings. Pure function, no DOM, no clock (the caller
// passes `generatedAt`), README.md, rule R7.

import type { EngineAttached, EngineMessage, EngineRebuilt, EngineResult } from '../engine/engine';
import type { MessagePlan, OutputPolicy, PlanRange } from '../engine/output-plan';
import { headerLabelCounts } from '../engine/quoted-header';
import type { ReconstructedMessage } from '../engine/reconstruct';
import { comparableText, nameWordsOf, signatureStart, wordsOf } from '../engine/rebuild-links';
import { mapOffsets } from '../engine/same-text-offsets';
import { formatInZone, formatSenderLocal, isDisplayableMs } from '../engine/time-format';
import type { EmailAddress, NormalizedMessage } from '../parsing/types';
import { displayAuthor } from '../ui-model/display-author';
import { FILE_CHAIN_SEPARATOR, fileChain } from '../ui-model/file-chain';
import { joinMailboxes } from '../ui-model/mailbox-list';
import { previewOrder, rebuiltDate, rebuiltInPdf, type RebuiltInPdf } from '../ui-model/rebuilt';
import { printedText } from './printed-check';
import type { PdfStrings } from './strings';
import { bodyLines, inlineRuns, joinKeptLines, lineText, type PdfLine, type PdfRole } from './text';
// Pure and backend-neutral (it only reads src/pdf/text.ts): the bookmark cut follows the same rule as the copy layer.
import { copyLayerCutIndex } from './writer/copy-text';

export type { PdfLine, PdfRole, PdfRun } from './text';

// ---------------------------------------------------------------- the shape

/** A header row: a label and its value, one or more lines. */
export interface PdfFieldRow {
  readonly label: string;
  readonly value: readonly PdfLine[];
}

/**
 * A piece of free-form content (the cover). The renderer lays out each kind
 * its own way; every text is in runs with a semantic role.
 * - 'heading': level 1 = the document title (role 'title'), level 2 = a section;
 * - 'fields': label/value rows (a small two-column table);
 * - 'paragraph': one line of text, wrapped;
 * - 'list': items, each one or more lines (each line wrapped on its own).
 */
export type PdfBlock =
  | { readonly kind: 'heading'; readonly level: 1 | 2; readonly line: PdfLine }
  | { readonly kind: 'fields'; readonly rows: readonly PdfFieldRow[] }
  | { readonly kind: 'paragraph'; readonly line: PdfLine }
  | { readonly kind: 'list'; readonly items: readonly (readonly PdfLine[])[] };

/** A distinct person of the included emails (From, Sender, To, Cc). */
export interface PdfParticipant {
  readonly name: string;
  readonly address: string;
}

export interface PdfCover {
  /** What the cover shows, in order. */
  readonly blocks: readonly PdfBlock[];
  /** The data behind it. Texts here are as found (not sanitized); the blocks hold the display form. */
  readonly dateRange: { readonly first: string; readonly last: string } | null;
  readonly undated: number;
  /** Every email in the PDF, rebuilt ones included (task 8.3). */
  readonly emailCount: number;
  readonly generated: string;
  readonly participants: readonly PdfParticipant[];
}

/** One line of the index. The renderer adds the page of `anchor`. */
export interface PdfIndexEntry {
  /** The email's PDF number (1..n over every email in the PDF, rebuilt ones included). */
  readonly number: number;
  /** True for an email rebuilt from quoted text (data only: the PDF never shows it, task 8.3). */
  readonly rebuilt: boolean;
  readonly anchor: string;
  readonly date: PdfLine;
  readonly from: PdfLine;
  readonly subject: PdfLine;
  readonly attachments: number;
  /** One line per attachment, the same lines as the email's own list (PdfEmail.attachments.items). */
  readonly attachmentLines: readonly PdfLine[];
  /** The email's bookmark title: one line, at most MAX_BOOKMARK_LENGTH characters (bookmarkTitle). */
  readonly bookmark: string;
}

export interface PdfIndex {
  readonly heading: string;
  readonly columns: PdfStrings['columns'];
  readonly entries: readonly PdfIndexEntry[];
}

/** Facts about one email the renderer may want (all false / 0 usually). */
export interface PdfEmailFlags {
  /** No usable date: shown with the "no date" text. */
  readonly undated: boolean;
  /** The sender's time zone is not known (the time may be off by hours). */
  readonly zoneUnknown: boolean;
  /** Plan rule 4: nothing would have been left, so the whole body is shown. */
  readonly keptAllBecauseEmpty: boolean;
  /** The plan failed, was missing or invalid: the whole body is shown. */
  readonly planFallback: boolean;
  /** Some text was converted from HTML (the layout may differ from what the sender saw). */
  readonly htmlConverted: boolean;
  /** Control or broken characters of this email shown as codes (src/pdf/text.ts, group 1). */
  readonly controlChars: number;
  /** The no-repeat rule left out text of this body that the PDF prints as emails of their own (task 8.10; data only). */
  readonly printedElsewhere: boolean;
}

/** Where a rebuilt email in the PDF comes from (data only: the PDF never shows it, task 8.3). */
export interface PdfRebuiltInfo {
  /** The entry's id in `result.reconstructed` (link 'entry'). */
  readonly id: number;
  /** The id of the copy shown: the entry, or a copy read from an email in the PDF (rebuiltInPdf). */
  readonly shownId: number;
  /** The list position of the email it was taken from (in the PDF). */
  readonly sourcePosition: number;
  /**
   * How many blocks of original header lines were moved to the top of its
   * text (task 8.13a, Q4: the quoted header lines its header rows cannot
   * show; NoRepeat.moved). 0 usually.
   */
  readonly movedHeaders: number;
}

export interface PdfEmail {
  /** 1..n over every email in the PDF, in PDF order, rebuilt ones included (task 8.3). */
  readonly number: number;
  /** For links from the index (resolved by the renderer): emailAnchor(number). */
  readonly anchor: string;
  /** Its position in the engine's list (`result.messages`); null for a rebuilt email (see `rebuilt`). */
  readonly position: number | null;
  /** "Email 3", for a rebuilt email too. */
  readonly heading: string;
  /** null for a real email. */
  readonly rebuilt: PdfRebuiltInfo | null;
  /**
   * From, Sent by, To, Cc, Bcc (each when present), Date, Subject, File. A
   * rebuilt email: From, To, Cc (each when present), Date, Subject (no File
   * row: it has no file).
   */
  readonly fields: readonly PdfFieldRow[];
  /** Lines above the text (role 'muted'): only the "(no text)" placeholder of an empty text (task 8.8: the PDF has no notes). */
  readonly notes: readonly PdfLine[];
  /** The text: one entry per line, [] for an empty line (see src/pdf/text.ts). */
  readonly body: readonly PdfLine[];
  /** One line per attachment (listed only, never opened); null when there is none. */
  readonly attachments: { readonly label: string; readonly items: readonly PdfLine[] } | null;
  readonly flags: PdfEmailFlags;
}

export interface PdfDocument {
  readonly title: string;
  /** Suggested file name (pdfFileName). */
  readonly fileName: string;
  /** The zone the dates are shown in, as Intl names it ("UTC" after a fallback). */
  readonly timeZone: string;
  /** True when the asked-for zone was not valid and UTC was used (data only: the cover names just the zone used, task 8.8). */
  readonly zoneFallback: boolean;
  readonly cover: PdfCover;
  readonly index: PdfIndex;
  /** The real and the rebuilt emails, in PDF order (see planPdfOrder). */
  readonly emails: readonly PdfEmail[];
  /** For each list position of `result.messages`: its PDF number (counted over every email in the PDF), or null when it is not in the PDF. */
  readonly pdfNumberByPosition: readonly (number | null)[];
  /** Control or broken characters of the emails shown as codes, in total. */
  readonly controlChars: number;
}

export interface BuildPdfInput {
  readonly result: EngineResult;
  /** List positions of the included emails, in list order (src/ui/review.ts, includedPositions). */
  readonly positions: readonly number[];
  /** One plan per position, same order (src/ui/pdf-labels.ts, currentPlans). */
  readonly plans: readonly MessagePlan[];
  readonly policy: OutputPolicy;
  /** IANA zone name (an invalid one falls back to UTC; the cover then names UTC). */
  readonly timeZone: string;
  /** When the PDF is made, in ms since 1970 UTC. */
  readonly generatedAt: number;
  readonly strings: PdfStrings;
  /**
   * Ids (in `result.reconstructed`) of the rebuilt emails the reader wants in
   * the PDF (src/ui/review.ts, includedRebuilt; [] or absent when the switch
   * is off). Each still follows the emails it was read from (planPdfOrder).
   * Ignored (none in the PDF) when `policy.unfoldEverything` is true.
   */
  readonly rebuilt?: readonly number[];
  /**
   * True when "Rebuild conversation from replies" is off (src/ui/review.ts,
   * rebuiltShown false): no rebuilt email figures at all, so none counts as
   * unticked and a forwarded part stays in its forward as the plan says
   * (task 8.13a, Q2 applies only to a rebuilt email the reader UNTICKED):
   * `unticked` is ignored then. Absent: false.
   */
  readonly rebuildingOff?: boolean;
  /**
   * Ids (in `result.reconstructed`) of the rebuilt emails whose card the
   * reader saw and UNTICKED while the switch is on (src/ui/review.ts,
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

/**
 * The PDF file name in the PDF's language, from the date of `generatedAt`
 * in `timeZone`: "correspondence-YYYY-MM-DD.pdf" in English.
 */
export function pdfFileName(generatedAt: number, timeZone: string, strings: Pick<PdfStrings, 'fileName'>): string {
  const shown = formatInZone(generatedAt, timeZone);
  return strings.fileName(shown.kind === 'date' ? shown.text.slice(0, 10) : null);
}

/** Longest bookmark title, in code points (the "..." included). */
export const MAX_BOOKMARK_LENGTH = 120;

/** Characters that belong to the one before them: combining marks (variation selectors included) and skin tone modifiers. */
const ATTACHED = /^[\p{M}\p{Emoji_Modifier}]$/u;
function isRegionalIndicator(point: string | undefined): boolean {
  const cp = point?.codePointAt(0);
  return cp !== undefined && cp >= 0x1f1e6 && cp <= 0x1f1ff;
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
function bookmarkCut(points: readonly string[], limit: number): number {
  const text = points.join('');
  let cut = limit;
  for (;;) {
    let next = Array.from(text.slice(0, copyLayerCutIndex(text, points.slice(0, cut).join('').length))).length;
    // A dropped mark takes the character it belongs to along (and the marks before it).
    while (next > 0 && ATTACHED.test(points[next] ?? '')) next--;
    // Regional indicators pair from the start of their run: an odd count before the cut splits a pair.
    let run = 0;
    while (run < next && isRegionalIndicator(points[next - 1 - run])) run++;
    if (run % 2 === 1 && isRegionalIndicator(points[next])) next--;
    if (next === cut) return cut;
    cut = next;
  }
}

/**
 * A bookmark title from texts already made one-line by inlineRuns (no line
 * breaks, no tabs, control characters as codes, src/pdf/text.ts): cut to
 * MAX_BOOKMARK_LENGTH code points, ending with U+2026 when cut. The cut
 * never splits an emoji, a flag or a letter from its accents (bookmarkCut);
 * trailing spaces before the cut mark are dropped.
 */
export function bookmarkTitle(text: string): string {
  const points = Array.from(text);
  if (points.length <= MAX_BOOKMARK_LENGTH) return text;
  return `${points.slice(0, bookmarkCut(points, MAX_BOOKMARK_LENGTH - 1)).join('').trimEnd()}\u{2026}`;
}

/** The anchor of email `number` (for the index links), real or rebuilt. */
export function emailAnchor(number: number): string {
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
      readonly entry: EngineRebuilt;
      readonly number: number;
      /**
       * Where it was read from (rebuiltInPdf). Only `shown` is used: its
       * `number` and `also` count the real emails alone (1..k, in PDF
       * order), not the PDF numbers, and the PDF never prints them (task 8.3).
       */
      readonly source: RebuiltInPdf;
    };

export interface PdfOrder {
  readonly slots: readonly PdfSlot[];
  /** For each list position: the PDF number of its real email, or null when it is not in the PDF. */
  readonly pdfNumberByPosition: readonly (number | null)[];
}

/**
 * What goes in the PDF, in which order (see the top of this file):
 * - the real emails: `positions` in the given order, each existing one once;
 * - the rebuilt entries of `rebuiltIds` that exist, have their own
 *   timeline entry (link 'entry') and pass the follow-source rule
 *   (rebuiltInPdf: at least one email they were read from is in the PDF),
 *   each once, at their place in the timeline: just before the first real
 *   email in the PDF that comes after them, else at the end. A timeline
 *   that is not valid (previewOrder falls back) gives no rebuilt email at
 *   all: their text is in their source emails anyway.
 * Then every slot is numbered 1..n in that order (task 8.3: rebuilt emails
 * are numbered like real ones). rebuiltInPdf is given the real emails'
 * rank among themselves (1..k); the real emails keep their order, so the
 * copy it picks (the source that comes first) is the same as with the PDF
 * numbers.
 * Pure: `result` is never changed.
 */
export function planPdfOrder(result: EngineResult, positions: readonly number[], rebuiltIds: readonly number[] = []): PdfOrder {
  // The real emails, each once, and their rank among them (1..k).
  const realRank: (number | null)[] = result.messages.map(() => null);
  const real: { readonly position: number; readonly plan: number }[] = [];
  positions.forEach((position, k) => {
    if (result.messages[position] === undefined || realRank[position] !== null) return;
    realRank[position] = real.length + 1;
    real.push({ position, plan: k });
  });

  // The rebuilt entries chosen that follow a real email in the PDF, with their rank in the timeline.
  type Placed = { readonly kind: 'email'; readonly position: number; readonly plan: number } | { readonly kind: 'rebuilt'; readonly entry: EngineRebuilt; readonly source: RebuiltInPdf };
  const rebuilt: { readonly slot: Placed; readonly rank: number }[] = [];
  const rankOfPosition = new Map<number, number>();
  if (rebuiltIds.length > 0) {
    const wanted = new Set(rebuiltIds);
    previewOrder(result).forEach((slot, rank) => {
      if (slot.kind === 'message') {
        rankOfPosition.set(slot.position, rank);
        return;
      }
      const entry = result.reconstructed[slot.id];
      if (entry === undefined || !wanted.has(slot.id)) return;
      const source = rebuiltInPdf(entry, result, (p) => realRank[p] ?? null);
      if (source !== null) rebuilt.push({ slot: { kind: 'rebuilt', entry, source }, rank });
    });
  }

  const placed: Placed[] = [];
  let next = 0;
  for (const email of real) {
    const rank = rankOfPosition.get(email.position) ?? Number.POSITIVE_INFINITY;
    while (next < rebuilt.length && rebuilt[next]!.rank < rank) placed.push(rebuilt[next++]!.slot);
    placed.push({ kind: 'email', ...email });
  }
  while (next < rebuilt.length) placed.push(rebuilt[next++]!.slot);

  // One numbering over every slot.
  const pdfNumberByPosition: (number | null)[] = result.messages.map(() => null);
  const slots = placed.map((slot, k): PdfSlot => {
    if (slot.kind === 'email') pdfNumberByPosition[slot.position] = k + 1;
    return { ...slot, number: k + 1 };
  });
  return { slots, pdfNumberByPosition };
}

function isBlank(m: EmailAddress): boolean {
  return m.name.trim() === '' && m.address.trim() === '';
}

/** "Name <address>", or whichever of the two exists (as the preview shows it). */
function mailboxText(m: EmailAddress, strings: PdfStrings): string {
  const hasName = m.name.trim() !== '';
  const hasAddress = m.address.trim() !== '';
  if (hasName && hasAddress) return strings.mailbox(m.name, m.address);
  return hasName ? m.name : m.address;
}

/** A short form for the index: the name, or the address when there is no name. */
function shortMailbox(m: EmailAddress): string {
  return m.name.trim() !== '' ? m.name : m.address;
}

/**
 * A plan's ranges are usable: as MessagePlan promises, a contiguous cover of
 * [0, length), each range non-empty with a boolean `keep`. Anything else
 * (a gap would silently drop text) means the plan is not trusted.
 */
function validRanges(plan: MessagePlan | null | undefined, length: number): plan is MessagePlan {
  if (typeof plan !== 'object' || plan === null || !Array.isArray(plan.ranges)) return false;
  let last = 0;
  for (const r of plan.ranges as readonly unknown[]) {
    if (typeof r !== 'object' || r === null) return false;
    const { start, end, keep } = r as Record<string, unknown>;
    if (typeof keep !== 'boolean' || !Number.isInteger(start) || !Number.isInteger(end)) return false;
    if (start !== last || (end as number) <= last || (end as number) > length) return false;
    last = end as number;
  }
  return last === length;
}

/** Nothing joined: every line of the text starts a line of the body. */
const NO_JOINS: ReadonlySet<number> = new Set();

/** Code-unit intervals [start, end) of one body, sorted, not overlapping, not touching. */
export type BodyIntervals = readonly (readonly [number, number])[];

const NOWHERE: BodyIntervals = [];

/**
 * The header rows the PDF prints for a place left out: a rebuilt copy's (its
 * fields as read), or a real file's. `strong` (a real file only): the link
 * to that file has a strong date match (rebuild-links.ts, RealMatch.strong,
 * and not an ambiguous date): the quoted date, even without a zone of its
 * own, is that file's moment (user decision 2026-11-07, S4).
 */
export type PrintedHeader =
  | { readonly kind: 'rebuilt'; readonly rebuilt: ReconstructedMessage }
  | { readonly kind: 'real'; readonly message: NormalizedMessage; readonly strong?: boolean };

const trimmed = (s: string | null): string => (s ?? '').trim();
/** A display name compared: outer white space removed, inner runs of white space as one space. */
const nameKey = (name: string): string => name.trim().replace(/\s+/gu, ' ');
const sameMailbox = (a: EmailAddress, b: EmailAddress): boolean => a.name.trim() === b.name.trim() && a.address.trim().toLowerCase() === b.address.trim().toLowerCase();
const sameMailboxes = (a: readonly EmailAddress[], b: readonly EmailAddress[]): boolean => {
  const x = a.filter((m) => !isBlank(m));
  const y = b.filter((m) => !isBlank(m));
  return x.length === y.length && x.every((m, k) => sameMailbox(m, y[k]!));
};
/**
 * `m` is one of `list`: the same address (letter case ignored), and, when
 * both have a display name, the same name too (nameKey; task 8.11, review
 * finding G3: "Robert <bob@x>" is not shown by a row that says "Bob
 * <bob@x>", so its header lines stay, B2); or, when `m` has no address (an
 * Outlook header often writes names only: "To: Bob Sample"), a mailbox of
 * `list` with the same name (nameKey), with or without an address (task
 * 8.10, S3). The real file's row shows that name.
 */
const amongMailboxes = (m: EmailAddress, list: readonly EmailAddress[]): boolean => {
  const address = m.address.trim().toLowerCase();
  const name = nameKey(m.name);
  if (address !== '') {
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
 *   only estimated (no zone of its own: the date printed is not the one
 *   written). A day alone and a date that could not be read are printed as
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
export function headerShownInPdf(body: string, r: ReconstructedMessage, printed: PrintedHeader): boolean {
  const labels = headerLabelCounts(body, r.start, r.headerEnd);
  if ((labels.get('bcc') ?? 0) > 0) return false;
  for (const n of labels.values()) if (n > 1) return false;
  if (r.incomplete.length > 0) return false;
  const from = r.from.filter((m) => !isBlank(m));
  const sender = from[0];
  if (from.length !== 1 || sender === undefined) return false;
  if ((labels.get('subject') ?? 0) > 0 && trimmed(r.subject) === '') return false;
  const date = rebuiltDate({ rebuilt: r });
  if (date.kind === 'none') return false;
  const senderName = nameKey(sender.name);
  if (printed.kind === 'rebuilt') {
    if (senderName === '') return false;
    if (date.kind === 'moment' && date.approximate) return false;
    const p = printed.rebuilt;
    return (
      p === r ||
      (sameMailboxes(p.from, r.from) &&
        sameMailboxes(p.to, r.to) &&
        sameMailboxes(p.cc, r.cc) &&
        trimmed(p.subject) === trimmed(r.subject) &&
        trimmed(p.dateText) === trimmed(r.dateText) &&
        p.incomplete.length === 0)
    );
  }
  const m = printed.message;
  if (date.kind !== 'moment') return false;
  if (date.approximate && printed.strong !== true) return false;
  const senderAddress = sender.address.trim().toLowerCase();
  const sameAddress = (x: EmailAddress): boolean => x.address.trim().toLowerCase() === senderAddress;
  const senderShown =
    senderName === ''
      ? senderAddress !== '' && m.from.some(sameAddress)
      : m.from.some((x) => nameKey(x.name) === senderName && (senderAddress === '' || sameAddress(x)));
  if (!senderShown) return false;
  if (trimmed(r.subject) !== '' && trimmed(r.subject) !== m.subject.trim()) return false;
  const recipients = [...m.to, ...m.cc];
  return [...r.to, ...r.cc].every((x) => isBlank(x) || amongMailboxes(x, recipients));
}

/** The kept ranges of the writer's own: the writer's own text (B1) and a kept signature (S5). */
const isOwn = (r: PlanRange): boolean => r.keep && (r.reason === 'text' || r.reason === 'signature' || r.reason === 'repeated-signature');

/** The ranges the plan marks as a quote (kept or not): a quote of the writer, app quoted history, a forwarded part. */
const isQuoted = (r: PlanRange): boolean => r.reason === 'writer-quote' || r.reason === 'app-quoted-history' || r.reason === 'forwarded';

/** Whether [start, end) of `body` overlaps, with text other than white space, a range of `ranges` that passes `test`. */
function holdsText(body: string, ranges: readonly PlanRange[], start: number, end: number, test: (r: PlanRange) => boolean): boolean {
  for (const r of ranges) {
    if (r.end <= start || r.start >= end) continue;
    if (test(r) && /\S/u.test(body.slice(Math.max(r.start, start), Math.min(r.end, end)))) return true;
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
export function holdsOwnText(body: string, ranges: readonly PlanRange[], start: number, end: number): boolean {
  return holdsText(body, ranges, start, end, isOwn);
}

/**
 * Whether [start, end) of `body` overlaps, with text other than white
 * space, a range of `ranges` that the plan marks as a quote, kept or not
 * (reason 'writer-quote', 'app-quoted-history' or 'forwarded'; task
 * 8.13a). In a place that also holds own text (holdsOwnText), the plan
 * told the writer's answer from the quote around it there.
 */
export function holdsQuotedText(body: string, ranges: readonly PlanRange[], start: number, end: number): boolean {
  return holdsText(body, ranges, start, end, isQuoted);
}

/** Where the forwarded part of a plan starts (rule 1 of output-plan.ts: everything from there on), or null. */
function forwardedFrom(ranges: readonly PlanRange[]): number | null {
  return ranges.find((r) => r.reason === 'forwarded')?.start ?? null;
}

/**
 * Where the header lines of a rebuilt message's place end in `body`: its
 * `headerEnd`, or, when its header was read short (a To / Cc list that may
 * go on), after the lines left of that header at the top of its text (the
 * rest of a wrapped list, a Subject line) and the blank line below them, as
 * comparableText (rebuild-links.ts) skips them. Those lines are header
 * lines, not the quoted email's text and not an answer: the no-repeat rule
 * keeps them with the header lines. reconstructedText keeps every line
 * break of the body (reconstruct.ts, step 4), so the n-th "\n" of the text
 * skipped is the n-th "\n" from `headerEnd` in the body. Never past `end`.
 * Theoretical corner: when the header was read short and the writer's
 * answer directly under the quoted header looks like a leftover header
 * line (say "To: ..." or "Subject: ..."), it is taken for header lines and
 * stays (B1 holds), while the quote below it may be cut.
 */
export function headerLinesEnd(body: string, r: ReconstructedMessage): number {
  const { headerEnd, end } = r;
  let rest: string;
  try {
    rest = comparableText(r);
  } catch {
    return headerEnd; // malformed input: no leftover lines
  }
  const text = r.reconstructedText;
  if (typeof text !== 'string' || rest.length >= text.length) return headerEnd;
  if (rest === '') return end;
  const skipped = text.slice(0, text.length - rest.length);
  let at = headerEnd;
  for (let k = skipped.indexOf('\n'); k >= 0; k = skipped.indexOf('\n', k + 1)) {
    const nl = body.indexOf('\n', at);
    if (nl < 0 || nl >= end) return end;
    at = nl + 1;
  }
  return at;
}

/**
 * THE NO-REPEAT RULE (user decisions 2026-11-06, task 8.10, and
 * 2026-11-09, task 8.13a): which parts of each real email's body the PDF
 * leaves out because it prints them elsewhere AS AN EMAIL OF ITS OWN (or,
 * for a forwarded part, because the reader unticked its rebuilt email), per
 * list position (only emails in the PDF; an email with none is not in the
 * map). A part is the WHOLE place a rebuilt message was read from
 * (src/engine/reconstruct.ts), [start, end): its header lines and its
 * text, when that message is in the PDF:
 * - an entry (link 'entry') with a slot in this PDF;
 * - a copy of such an entry (link 'same-as'): the entry prints the same
 *   words (rebuild-links.ts, rule 2; only a signature block at the end of
 *   one copy may differ: see A DIFFERING SIGNATURE below);
 * - one linked to a real email (link 'real', "the real file wins") when
 *   that real email is in the PDF too: it prints the same words as its own
 *   text (rebuild-links.ts, rule 1c; only a signature block may differ).
 * HEADER LINES (task 8.13a, Q4; they no longer stay in the body, B2): the
 * header lines [start, headerLinesEnd) always leave the body with the
 * place. When the place is printed as a REBUILT email whose header rows do
 * not show everything they say (headerShownInPdf), or when the plan took
 * some of them for own text (a wrapped To / Cc line, a Subject line), they
 * are MOVED, as plain text, to the top of that rebuilt email's own text
 * (noRepeat, `moved`; buildRebuiltEmail), so nothing is lost and they sit
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
 * are given (noRepeat gives no `unticked` while the switch is off,
 * BuildPdfInput.rebuildingOff: then no forwarded part is cut).
 * A DIFFERING SIGNATURE (task 8.13a review round 2): a copy linked to the
 * email that prints it (link 'same-as', or 'real') may end with a signature
 * block the printed text does not have (rebuild-links.ts, rules 1c and 2:
 * one of the two texts may end with one). That block is printed nowhere
 * else, so it stays INLINE (the part ends where it starts, extraTail); only
 * the words the other email prints are cut. When it is unclear where in the
 * body the block starts, the whole place stays (when unsure, keep).
 * Kept INLINE, as the plan says (nothing else would show it): a rebuilt
 * message that is not in the PDF for any other reason (not a forwarded
 * part, its entry chosen but not placed, a real file linked to it that is
 * not in the PDF), and any quoted part the engine could not rebuild at all
 * (reconstruct.ts, REFUSAL: there is no place for it).
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
  result: EngineResult,
  slots: readonly PdfSlot[],
  pdfNumberByPosition: readonly (number | null)[],
  plans?: ReadonlyMap<number, MessagePlan | undefined>,
  unticked?: ReadonlySet<number>,
): Map<number, BodyIntervals> {
  const out = new Map<number, BodyIntervals>();
  for (const [position, parts] of printedElsewhereParts(result, slots, pdfNumberByPosition, plans, unticked)) out.set(position, mergeParts(parts));
  return out;
}

/**
 * Why the PDF leaves a part out of a body (the no-repeat rule, task 8.10),
 * for the preview's labels (task 8.11): it prints it as a rebuilt email in
 * the PDF (`id`: its entry in `result.reconstructed`, the one with a slot)
 * or as a real email in the PDF (`position`: its list position), `number`
 * being its PDF number (1..n over every email in the PDF); or (kind
 * 'unticked', task 8.13a, Q2) it does not print it at all: a forwarded part
 * whose rebuilt email (entry `id`) the reader unticked (BuildPdfInput.unticked);
 * or (kind 'unticked-attached', task 8.13b-3, Q3) the printed block of an
 * attached email whose kept copy (list position `position`) is not in the PDF.
 * The printed block of an attached email that IS in the PDF is kind 'email'.
 */
export type PrintedAs =
  | { readonly kind: 'rebuilt'; readonly id: number; readonly number: number }
  | { readonly kind: 'email'; readonly position: number; readonly number: number }
  | { readonly kind: 'unticked'; readonly id: number }
  // The printed block of an attached email whose kept copy (list position
  // `position`) the reader unticked: not printed anywhere (task 8.13b-3, Q3).
  | { readonly kind: 'unticked-attached'; readonly position: number };

/** A part [start, end) of one body that the PDF prints as the email `printedAs` (printedElsewhereParts). */
export interface PrintedPart {
  readonly start: number;
  readonly end: number;
  readonly printedAs: PrintedAs;
}

const samePrintedAs = (a: PrintedAs, b: PrintedAs): boolean => {
  switch (a.kind) {
    case 'rebuilt':
      return b.kind === 'rebuilt' && a.id === b.id;
    case 'email':
      return b.kind === 'email' && a.position === b.position;
    case 'unticked':
      return b.kind === 'unticked' && a.id === b.id;
    case 'unticked-attached':
      return b.kind === 'unticked-attached' && a.position === b.position;
  }
};

/** The parts of a body as BodyIntervals: sorted, overlapping or touching parts merged. */
function mergeParts(parts: readonly { readonly start: number; readonly end: number }[]): BodyIntervals {
  const list = parts.map((p): [number, number] => [p.start, p.end]).sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [a, b] of list) {
    const last = merged[merged.length - 1];
    if (last !== undefined && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
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
function disjointParts(found: readonly PrintedPart[]): PrintedPart[] {
  const bounds = [...new Set(found.flatMap((p) => [p.start, p.end]))].sort((a, b) => a - b);
  const out: PrintedPart[] = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const a = bounds[k]!;
    const b = bounds[k + 1]!;
    let best: PrintedPart | undefined;
    for (const p of found) {
      if (p.start > a || p.end < b) continue;
      if (best === undefined || p.start > best.start || (p.start === best.start && p.end < best.end)) best = p;
    }
    if (best === undefined) continue;
    const last = out[out.length - 1];
    if (last !== undefined && last.end === a && samePrintedAs(last.printedAs, best.printedAs)) out[out.length - 1] = { ...last, end: b };
    else out.push({ start: a, end: b, printedAs: best.printedAs });
  }
  return out;
}

/**
 * printedElsewhere with, for each part, the email the PDF prints it as
 * (task 8.11: the preview labels a part left out with that email; the PDF
 * and the preview read the same parts). Per list position: parts sorted,
 * not overlapping (disjointParts); mergeParts of them is printedElsewhere's
 * value. Same rules, same arguments (see printedElsewhere).
 * Pure: `result` and `plans` are never changed.
 */
export function printedElsewhereParts(
  result: EngineResult,
  slots: readonly PdfSlot[],
  pdfNumberByPosition: readonly (number | null)[],
  plans?: ReadonlyMap<number, MessagePlan | undefined>,
  unticked?: ReadonlySet<number>,
): Map<number, readonly PrintedPart[]> {
  return noRepeatParts(result, slots, pdfNumberByPosition, plans, unticked).parts;
}

/** A block of quoted header lines a place leaves behind for its rebuilt email (task 8.13a, Q4). */
interface MoveCandidate {
  readonly entry: number;
  /** The id of the place (its EngineRebuilt). */
  readonly copy: number;
  readonly position: number;
  readonly start: number;
  readonly headerEnd: number;
  readonly linesEnd: number;
}

/**
 * One line set of header lines, compared: line ends unified, the quote marks
 * at a line start and outer white space removed, blank lines dropped.
 */
function headerKey(text: string): string {
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
 * with a signature block the other lacks (rebuild-links.ts, rules 1c and 2;
 * signatureStart, with the place's sender names). Null when the place has
 * no such block, or when `printedText` holds all the place's words in the
 * same order (comparableText: the header leftovers a header read short
 * leaves at the top of its text aside), block included: then it is printed
 * there. Otherwise the block's offset: the start of its first line in `body`
 * (the place's text keeps its lines one for one, only quote marks are
 * removed, reconstruct.ts step 4). 'unsure' (task 8.13a final round) when
 * the block is there but its line cannot be found inside the place (the
 * lines do not map one for one: the place's text has more lines than the
 * place, or the line falls at or past its end), or the texts are not
 * strings: the caller then KEEPS the whole place (when unsure, keep; null
 * would cut it all, block included). Words are compared as the link rules
 * compare them (wordsOf).
 */
export function extraTail(body: string, place: ReconstructedMessage, printedText: string): number | null | 'unsure' {
  const text = place.reconstructedText;
  if (typeof text !== 'string' || typeof printedText !== 'string') return 'unsure';
  const at = signatureStart(text, nameWordsOf(Array.isArray(place.from) ? place.from : []));
  if (at === null) return null;
  const whole = wordsOf(comparableText(place)).tokens;
  if (whole.length === 0) return null;
  if (` ${wordsOf(printedText).tokens.join(' ')} `.includes(` ${whole.join(' ')} `)) return null;
  // The block's first line, counted from the start of the place's text.
  let lines = 0;
  for (let k = text.indexOf('\n'); k >= 0 && k < at; k = text.indexOf('\n', k + 1)) lines++;
  let offset = place.headerEnd;
  for (let k = 0; k < lines; k++) {
    const nl = body.indexOf('\n', offset);
    if (nl < 0 || nl >= place.end) return 'unsure';
    offset = nl + 1;
  }
  return offset < place.end ? offset : 'unsure';
}

/** `list` when it really is a list (data from a worker), else none. */
function listOrNone<T>(list: readonly T[] | undefined): readonly T[] {
  // A plain boolean check: Array.isArray as a type guard would turn the list into any[].
  const isList: boolean = Array.isArray(list);
  return isList && list !== undefined ? list : [];
}

/**
 * What the page of the email at list position `own` (an attached email in
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
function pagePieces(body: string, plan: MessagePlan | undefined, self: PrintedAs, ownParts: readonly PrintedPart[]): PrintedPart[] {
  if (!validRanges(plan, body.length) || plan.fallback) return body.length === 0 ? [] : [{ start: 0, end: body.length, printedAs: self }];
  const sorted = disjointParts(ownParts);
  const out: PrintedPart[] = [];
  for (const r of plan.ranges) {
    if (!r.keep) continue;
    let from = r.start;
    for (const part of sorted) {
      if (part.end <= from || part.start >= r.end) continue;
      if (part.start > from) out.push({ start: from, end: part.start, printedAs: self });
      const end = Math.min(part.end, r.end);
      out.push({ start: Math.max(part.start, from), end, printedAs: part.printedAs });
      from = end;
    }
    if (from < r.end) out.push({ start: from, end: r.end, printedAs: self });
  }
  return out;
}

/** Where the text of an attached email's printed block starts in it: after the first blank line (none: a block of header lines only, its end). */
function blockBodyStart(body: string, start: number, end: number): { readonly at: number; readonly hasBlank: boolean } {
  const blank = /(?:\r\n|\r|\n)[ \t]*(?:\r\n|\r|\n)/u.exec(body.slice(start, end));
  return blank === null ? { at: end, hasBlank: false } : { at: start + blank.index + blank[0].length, hasBlank: true };
}

/**
 * The parts of attached email `a`'s printed block `holderBody[start, end)`
 * that its own page prints, in the holder's offsets (task 8.13b-3, review
 * round 4, M1, user decision option a): the no-repeat rule leaves out of the
 * holder ONLY these; everything else of the block stays where the holder's
 * plan prints it (printed twice rather than nowhere).
 * - The forwarded separator and header lines (the block up to its first
 *   blank line, src/parsing/types.ts AttachedPlace): printed as the email,
 *   whose header rows show them, when those rows show all of its header
 *   data (EngineAttached.keptShowsHeader: not so when a dropped file's copy
 *   with less header data was kept, D2); otherwise they stay.
 * - Its text (after that blank line): the pieces its page prints
 *   (pagePieces of `pieces`, in the offsets of the kept copy's body
 *   `ownBody`), found in the block with mapOffsets (the block's text is the
 *   attached email's body as the parser wrote it; a kept copy merged with
 *   it has the same body as de-duplication compares them).
 * When the block's text cannot be matched to that body for certain, none
 * (the whole block stays: when unsure, keep).
 */
function blockClaims(holderBody: string, start: number, end: number, ownBody: string, pieces: readonly PrintedPart[], self: PrintedAs, showsHeader: boolean): PrintedPart[] {
  const { at, hasBlank } = blockBodyStart(holderBody, start, end);
  const text = holderBody.slice(at, end);
  if (!hasBlank && /\S/u.test(ownBody)) return [];
  const out: PrintedPart[] = [];
  if (pieces.length > 0) {
    const mapped = mapOffsets(ownBody, text, pieces.flatMap((p) => [p.start, p.end]));
    if (mapped === null) return [];
    pieces.forEach((p, k) => {
      const a = at + mapped[2 * k]!;
      const b = at + mapped[2 * k + 1]!;
      if (a < b) out.push({ start: a, end: b, printedAs: p.printedAs });
    });
  }
  if (showsHeader && at > start) out.push({ start, end: at, printedAs: self });
  return out;
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
 * A place is used only in the very body it names (the holder's own copy, or
 * the kept copy it was moved to, engine.ts settleAttached), in the PDF, with
 * valid offsets, and not in the email's own body.
 */
function attachedBlockParts(
  result: EngineResult,
  pdfNumberByPosition: readonly (number | null)[],
  plans: ReadonlyMap<number, MessagePlan | undefined> | undefined,
  found: Map<number, PrintedPart[]>,
): void {
  const list = listOrNone(result.attached);
  if (list.length === 0) return;
  const inPdf = (position: number | null | undefined): position is number => typeof position === 'number' && pdfNumberByPosition[position] != null;
  const add = (holder: number, part: PrintedPart): void => {
    let parts = found.get(holder);
    if (parts === undefined) found.set(holder, (parts = []));
    parts.push(part);
  };
  interface Block {
    readonly holder: number;
    readonly start: number;
    readonly end: number;
  }
  const unticked: (Block & { readonly printedAs: PrintedAs })[] = [];
  // The pieces of the blocks of emails in the PDF that their page does not print.
  const leftIn: (Block & { readonly pieces: [number, number][] })[] = [];
  // The parts of body `holder` left out with an unticked attached email (Q3): its block, less what an
  // attached email in the PDF inside it does not print, less nothing for the unticked ones inside that one.
  const untickedParts = (holder: number): PrintedPart[] => {
    const keep: [number, number][] = [];
    for (const b of leftIn) {
      if (b.holder !== holder) continue;
      // `inside` only matters when blockClaims returned nothing for this block (its text could not be
      // matched: the whole block is in b.pieces). Otherwise its claims already hold the unticked blocks
      // inside it (pagePieces gave them to its page with untickedParts), so b.pieces lacks them anyway.
      const inside = unticked.filter((u) => u.holder === holder && b.start <= u.start && u.end <= b.end && u.end - u.start < b.end - b.start).map((u): [number, number] => [u.start, u.end]);
      for (const [s, e] of b.pieces) for (const piece of without(s, e, inside)) keep.push(piece);
    }
    const out: PrintedPart[] = [];
    for (const u of unticked) if (u.holder === holder) for (const [start, end] of without(u.start, u.end, keep)) out.push({ start, end, printedAs: u.printedAs });
    return out;
  };
  // Deepest first (longest path): this assumes the blocks inside an email's own body belong to deeper
  // attached entries. With D2/S1 the kept body may be a dropped file, whose own attached entries have
  // depth 1. It still works: copies merge only when their bodies are equal (normalizeBody), so the kept
  // body holds the same blocks, and S1 (engine.ts settleAttached) moves the places of the entries
  // attached inside the merged copy to the kept body, where they keep their own (deeper) path.
  const depth = (a: EngineAttached): number => listOrNone(a.path).length;
  const order = list.map((a, k) => ({ a, k })).sort((x, y) => depth(y.a) - depth(x.a) || y.k - x.k);
  for (const { a } of order) {
    const own = result.positionByIndex[a.index];
    if (typeof own !== 'number') continue;
    const ownMessage = result.messages[own];
    if (ownMessage === undefined) continue;
    const ticked = inPdf(own);
    const self: PrintedAs = ticked ? { kind: 'email', position: own, number: pdfNumberByPosition[own]! } : { kind: 'unticked-attached', position: own };
    let pieces: PrintedPart[] | null = null;
    for (const p of listOrNone(a.places)) {
      const holder = result.positionByIndex[p.holderIndex];
      if (!inPdf(holder) || holder === own) continue;
      const m = result.messages[holder];
      // The offsets are those of that very body (engine.ts, EngineAttachedPlace).
      if (m === undefined || m.index !== p.holderIndex) continue;
      const body = m.message.bodyText;
      if (!Number.isInteger(p.start) || !Number.isInteger(p.end) || p.start < 0 || p.end <= p.start || p.end > body.length) continue;
      if (!ticked) {
        unticked.push({ holder, start: p.start, end: p.end, printedAs: self });
        continue;
      }
      // Every email attached inside this one is deeper, so done: its parts in this body are final.
      pieces ??= pagePieces(ownMessage.message.bodyText, plans?.get(own), self, [...(found.get(own) ?? []), ...untickedParts(own)]);
      const claims = blockClaims(body, p.start, p.end, ownMessage.message.bodyText, pieces, self, a.keptShowsHeader === true);
      for (const c of claims) add(holder, c);
      leftIn.push({ holder, start: p.start, end: p.end, pieces: without(p.start, p.end, claims.map((c): [number, number] => [c.start, c.end])) });
    }
  }
  for (const holder of new Set(unticked.map((u) => u.holder))) for (const part of untickedParts(holder)) add(holder, part);
}

/** [start, end) less every interval of `holes` (in any order, may overlap), as sorted pieces; none when nothing is left. */
function without(start: number, end: number, holes: readonly (readonly [number, number])[]): [number, number][] {
  const out: [number, number][] = [];
  let from = start;
  for (const [a, b] of [...holes].sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
    if (b <= from || a >= end) continue;
    if (a > from) out.push([from, a]);
    from = Math.max(from, b);
    if (from >= end) break;
  }
  if (from < end) out.push([from, end]);
  return out;
}

/** printedElsewhereParts, and the header lines moved to each rebuilt email (see noRepeat). */
function noRepeatParts(
  result: EngineResult,
  slots: readonly PdfSlot[],
  pdfNumberByPosition: readonly (number | null)[],
  plans: ReadonlyMap<number, MessagePlan | undefined> | undefined,
  unticked: ReadonlySet<number> | undefined,
): { readonly parts: Map<number, readonly PrintedPart[]>; readonly moved: Map<number, readonly string[]> } {
  const inPdf = (position: number | null | undefined): position is number => typeof position === 'number' && pdfNumberByPosition[position] != null;
  // Each entry in the PDF, with the copy whose header and text it prints (rebuiltInPdf), and its PDF number.
  const entries = new Map<number, { readonly copy: EngineRebuilt; readonly position: number; readonly number: number }>();
  for (const slot of slots) if (slot.kind === 'rebuilt') entries.set(slot.entry.id, { copy: slot.source.shown.rebuilt, position: slot.source.shown.position, number: slot.number });
  const found = new Map<number, PrintedPart[]>();
  const candidates: MoveCandidate[] = [];
  // The entries whose printed copy's header lines are printed nowhere (its plan leaves them out, its rows cannot show them).
  const unshown = new Set<number>();
  const reconstructed: readonly EngineRebuilt[] = Array.isArray(result.reconstructed) ? result.reconstructed : [];
  for (const r of reconstructed) {
    const position = result.positionByIndex[r.sourceIndex];
    if (!inPdf(position)) continue;
    const { start, headerEnd, end } = r.rebuilt;
    const body = result.messages[position]?.message.bodyText ?? '';
    if (!Number.isInteger(start) || !Number.isInteger(headerEnd) || !Number.isInteger(end) || start < 0 || headerEnd < start || end < headerEnd || end > body.length) continue;
    const plan = plans?.get(position);
    const own = plan !== undefined && validRanges(plan, body.length) && !plan.fallback ? plan.ranges : null;
    let shownAs: PrintedHeader | null = null;
    let printedAs: PrintedAs | null = null;
    // The text the other email prints (null: this place is that text, or nothing prints it).
    let printedText: string | null = null;
    if (r.link === 'entry' || r.link === 'same-as') {
      const id = r.link === 'entry' ? r.id : r.sameAs;
      const entry = id === null ? undefined : entries.get(id);
      if (id !== null && entry !== undefined) {
        shownAs = { kind: 'rebuilt', rebuilt: entry.copy.rebuilt };
        printedAs = { kind: 'rebuilt', id, number: entry.number };
        if (entry.copy.id !== r.id) printedText = entry.copy.rebuilt.reconstructedText;
      } else if (id !== null && unticked !== undefined && unticked.has(id) && reconstructed[id]?.link === 'entry' && own !== null) {
        // Q2: a forwarded part whose rebuilt email the reader unticked (only an id the reader really unticked).
        const forwarded = forwardedFrom(own);
        if (forwarded !== null && start >= forwarded) printedAs = { kind: 'unticked', id };
      }
    } else if (r.link === 'real' && r.realIndex !== null) {
      const real = result.positionByIndex[r.realIndex];
      const message = real === undefined || real === position || !inPdf(real) ? undefined : result.messages[real]?.message;
      if (message !== undefined && inPdf(real)) {
        shownAs = { kind: 'real', message, strong: r.match?.strong === true && !r.match.ambiguousDate };
        printedAs = { kind: 'email', position: real, number: pdfNumberByPosition[real]! };
        printedText = typeof message.bodyText === 'string' ? message.bodyText : '';
      }
    }
    if (printedAs === null) continue;
    // The header lines, with what is left of a header read short at the top of the text.
    const linesEnd = headerLinesEnd(body, r.rebuilt);
    // The writer's answer (Q3): own text and quoted text in the place's text keep the whole place.
    if (own !== null && holdsOwnText(body, own, linesEnd, end) && holdsQuotedText(body, own, linesEnd, end)) continue;
    // A signature block only this copy has stays inline: the other email does not print it (see printedElsewhere).
    const tail = printedText === null ? null : extraTail(body, r.rebuilt, printedText);
    // A block whose line cannot be found ('unsure'), or found where it cannot be (in the header lines):
    // when unsure, keep the whole place.
    if (tail === 'unsure' || (tail !== null && (tail < linesEnd || tail >= end))) continue;
    const cutEnd = tail ?? end;
    if (cutEnd <= start) continue;
    let list = found.get(position);
    if (list === undefined) {
      list = [];
      found.set(position, list);
    }
    list.push({ start, end: cutEnd, printedAs });
    // Q4: header lines the rebuilt email's rows cannot show (or that the plan took for own text) move to it,
    // when this body would have printed them (its trusted plan keeps some of them; lines the plan leaves
    // out, say the quoted history of a reply, were never printed and are not added; an untrusted plan
    // prints the body whole, lines included, so moving them would print them twice).
    if (printedAs.kind === 'rebuilt' && shownAs !== null && linesEnd > start) {
      const shown = !(own !== null && holdsOwnText(body, own, start, linesEnd)) && headerShownInPdf(body, r.rebuilt, shownAs);
      const kept = own !== null && holdsText(body, own, start, linesEnd, (x) => x.keep);
      if (!shown && kept) candidates.push({ entry: printedAs.id, copy: r.id, position, start, headerEnd, linesEnd });
      else if (!shown && own !== null && entries.get(printedAs.id)?.copy.id === r.id) unshown.add(printedAs.id);
    }
  }
  attachedBlockParts(result, pdfNumberByPosition, plans, found);
  const parts = new Map<number, readonly PrintedPart[]>();
  for (const [position, list] of found) parts.set(position, disjointParts(list));
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
  result: EngineResult,
  entries: ReadonlyMap<number, { readonly copy: EngineRebuilt; readonly position: number }>,
  candidates: readonly MoveCandidate[],
  unshown: ReadonlySet<number>,
  pdfNumberByPosition: readonly (number | null)[],
): Map<number, readonly string[]> {
  const out = new Map<number, readonly string[]>();
  const bodyAt = (position: number): string => result.messages[position]?.message.bodyText ?? '';
  for (const [id, entry] of entries) {
    const mine = candidates.filter((c) => c.entry === id);
    if (mine.length === 0) continue;
    const shownBody = bodyAt(entry.position);
    const shownCopy = entry.copy.rebuilt;
    const seen = new Set<string>(unshown.has(id) ? [] : [headerKey(shownBody.slice(shownCopy.start, headerLinesEnd(shownBody, shownCopy)))]);
    const texts: string[] = [];
    const take = (text: string): void => {
      if (text.trim() === '') return;
      texts.push(/[\r\n]$/u.test(text) ? text : `${text}\n`);
    };
    const own = mine.find((c) => c.copy === entry.copy.id && c.position === entry.position);
    if (own !== undefined) take(bodyAt(own.position).slice(own.start, own.headerEnd));
    const others = mine
      .filter((c) => c !== own)
      .sort((a, b) => (pdfNumberByPosition[a.position] ?? 0) - (pdfNumberByPosition[b.position] ?? 0) || a.start - b.start);
    for (const c of others) {
      const text = bodyAt(c.position).slice(c.start, c.linesEnd);
      const key = headerKey(text);
      if (seen.has(key)) continue;
      seen.add(key);
      take(text);
    }
    if (texts.length > 0) out.set(id, texts);
  }
  return out;
}

/**
 * `r` cut at the bounds of `intervals` (sorted), its pieces inside them left
 * out, whatever its reason (task 8.13a: printedElsewhere alone decides what
 * is cut; it keeps every place that holds the writer's answer, Q3). Returns
 * whether text other than white space was left out.
 */
function cutRange(body: string, r: PlanRange, intervals: BodyIntervals, out: CutRanges): boolean {
  let leftOut = false;
  let from = r.start;
  const push = (range: PlanRange, cut: boolean): void => {
    out.ranges.push(range);
    out.cut.push(cut);
  };
  for (const [a, b] of intervals) {
    if (b <= from) continue;
    if (a >= r.end || from >= r.end) break;
    const start = Math.max(a, from);
    const end = Math.min(b, r.end);
    const hasText = /\S/.test(body.slice(start, end));
    if (start > from) push({ ...r, start: from, end: start }, false);
    push({ ...r, start, end, keep: false }, true);
    if (hasText) leftOut = true;
    from = end;
  }
  if (from < r.end) push({ ...r, start: from, end: r.end }, false);
  return leftOut;
}

/** Ranges, and for each one whether the no-repeat rule left it out (same order). */
interface CutRanges {
  readonly ranges: PlanRange[];
  readonly cut: boolean[];
}

/** withoutPrintedElsewhere, with which ranges the rule left out. */
function cutPrintedElsewhere(body: string, ranges: readonly PlanRange[], parts: BodyIntervals): CutRanges & { readonly leftOut: boolean } {
  const out: CutRanges = { ranges: [], cut: [] };
  let leftOut = false;
  for (const r of ranges) {
    if (!r.keep) {
      out.ranges.push(r);
      out.cut.push(false);
      continue;
    }
    if (cutRange(body, r, near(parts, r.start, r.end), out)) leftOut = true;
  }
  return { ...out, leftOut };
}

/** The intervals of a sorted list that may touch [start, end), as a slice (binary search on the end). */
function near(intervals: BodyIntervals, start: number, end: number): BodyIntervals {
  let lo = 0;
  let hi = intervals.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((intervals[mid]?.[1] ?? 0) <= start) lo = mid + 1;
    else hi = mid;
  }
  let to = lo;
  while (to < intervals.length && (intervals[to]?.[0] ?? end) < end) to++;
  return intervals.slice(lo, to);
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
): { readonly ranges: readonly PlanRange[]; readonly leftOut: boolean } {
  if (parts.length === 0) return { ranges, leftOut: false };
  const cut = cutPrintedElsewhere(body, ranges, parts);
  return { ranges: cut.ranges, leftOut: cut.leftOut };
}

/** A range of a body as the PDF prints it: a plan range, or a piece of one the no-repeat rule left out (`printedAs`: where the PDF prints it). */
export interface PdfRange extends PlanRange {
  /** Set only on a piece the no-repeat rule left out (then `keep` is false): the email the PDF prints it as. */
  readonly printedAs: PrintedAs | null;
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
 * then what the PDF prints. `restored` (NoRepeat.restored, review round 3
 * of task 8.13b-3): pieces the plan leaves out that the PDF prints after
 * all, because their text is printed nowhere else; they come back kept
 * (printedAs null), with the plan's reason.
 */
export function pdfRanges(
  body: string,
  plan: MessagePlan | null | undefined,
  policy: Pick<OutputPolicy, 'unfoldEverything'>,
  parts: readonly PrintedPart[],
  restored: BodyIntervals = NOWHERE,
): readonly PdfRange[] | null {
  if (policy.unfoldEverything || (parts.length === 0 && restored.length === 0) || !validRanges(plan, body.length) || plan.fallback) return null;
  const cut = cutPrintedElsewhere(body, plan.ranges, mergeParts(parts));
  if (!cut.cut.includes(true) && restored.length === 0) return null;
  const out: PdfRange[] = [];
  cut.ranges.forEach((r, k) => {
    if (cut.cut[k] !== true) {
      out.push({ ...r, printedAs: null });
      return;
    }
    // A piece left out lies inside the union of the parts, which tile it.
    let from = r.start;
    for (const p of parts) {
      if (p.end <= from || p.start >= r.end) continue;
      const start = Math.max(from, p.start);
      const end = Math.min(r.end, p.end);
      if (start > from) out.push({ ...r, start: from, end: start, printedAs: null }); // not expected (parts tile it)
      out.push({ ...r, start, end, printedAs: p.printedAs });
      from = end;
    }
    if (from < r.end) out.push({ ...r, start: from, end: r.end, printedAs: null }); // not expected
  });
  return withRestored(out, restored);
}

/**
 * `ranges` (a cover of the body) with the pieces inside `restored` (sorted
 * intervals) kept: a range is cut at their bounds and its pieces inside
 * them get keep true (and no `printedAs`), whatever they were. The restored
 * pieces are always pieces the plan leaves out (printedNowhere), never
 * pieces the no-repeat rule cut.
 */
function withRestored<R extends PlanRange & { readonly printedAs?: PrintedAs | null }>(ranges: readonly R[], restored: BodyIntervals): R[] {
  if (restored.length === 0) return [...ranges];
  const out: R[] = [];
  for (const r of ranges) {
    let from = r.start;
    for (const [a, b] of near(restored, r.start, r.end)) {
      const start = Math.max(a, from);
      const end = Math.min(b, r.end);
      if (end <= start) continue;
      if (start > from) out.push({ ...r, start: from, end: start });
      out.push({ ...r, start, end, keep: true, ...('printedAs' in r ? { printedAs: null } : {}) });
      from = end;
    }
    if (from < r.end) out.push({ ...r, start: from, end: r.end });
  }
  return out;
}

/** What the no-repeat rule needs: the PDF's input, less what only the layout uses. */
export type NoRepeatInput = Pick<BuildPdfInput, 'result' | 'positions' | 'plans' | 'policy' | 'rebuilt' | 'rebuildingOff' | 'unticked'>;

/** The emails in the PDF and the parts of their bodies printed elsewhere (noRepeat). */
export interface NoRepeat {
  readonly order: PdfOrder;
  /** Per list position, the parts left out and where they are printed (printedElsewhereParts); empty under "Print full original text". */
  readonly parts: ReadonlyMap<number, readonly PrintedPart[]>;
  /** Per list position, the same parts merged: what bodyTextOf leaves out (printedElsewhere). */
  readonly elsewhere: ReadonlyMap<number, BodyIntervals>;
  /**
   * Per rebuilt entry in the PDF (its id), the blocks of original header
   * lines moved to the top of its text, in order (task 8.13a, Q4; see
   * printedElsewhere): each exactly as written in its source body (quote
   * marks included: the PDF drops them, src/pdf/text.ts), ending with a
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
 * checked against the text the PDF prints (src/pdf/printed-check.ts: every
 * real email's printed ranges after the no-repeat cut, every rebuilt
 * email's text with its moved header lines, and the pieces restored before
 * it); one that is not found is restored, and its text then counts as
 * printed for the pieces after it (so a text two emails each leave out
 * "because the other one has it" is printed once, in the first). What is
 * printed only grows, so a piece found stays found. Costs nothing when
 * there is no candidate; else about linear in the text of the PDF (see
 * printed-check.ts).
 */
function printedNowhere(
  result: EngineResult,
  order: PdfOrder,
  plans: ReadonlyMap<number, MessagePlan | undefined>,
  elsewhere: ReadonlyMap<number, BodyIntervals>,
  moved: ReadonlyMap<number, readonly string[]>,
): Map<number, BodyIntervals> {
  const restored = new Map<number, BodyIntervals>();
  const inPdf = (index: unknown): boolean => {
    const p = typeof index === 'number' ? result.positionByIndex[index] : undefined;
    return typeof p === 'number' && order.pdfNumberByPosition[p] != null;
  };
  const candidates: { readonly position: number; readonly start: number; readonly end: number }[] = [];
  for (const slot of order.slots) {
    if (slot.kind !== 'email') continue;
    const m = result.messages[slot.position];
    const plan = plans.get(slot.position);
    if (m === undefined || !validRanges(plan, m.message.bodyText.length) || plan.fallback) continue;
    // A plain boolean check: Array.isArray as a type guard would turn the list into any[].
    const isList: boolean = Array.isArray(m.segments);
    if (!isList) continue;
    // Segments are a sorted cover of the body: these intervals are sorted and do not overlap (as `near` needs).
    const linked = m.segments
      .filter(
        (s) =>
          s.folded &&
          Array.isArray(s.reasons) &&
          s.reasons.length > 0 &&
          s.reasons.every((reason) => reason === 'quoted-overlap') &&
          Array.isArray(s.related) &&
          s.related.some(inPdf),
      )
      .map((s): [number, number] => [s.start, s.end]);
    if (linked.length === 0) continue;
    let open: { start: number; end: number } | null = null;
    const close = (): void => {
      if (open !== null) candidates.push({ position: slot.position, start: open.start, end: open.end });
      open = null;
    };
    for (const r of plan.ranges) {
      if (r.keep || r.reason === 'signature' || r.reason === 'repeated-signature') continue;
      for (const s of near(linked, r.start, r.end)) {
        const start = Math.max(s[0], r.start);
        const end = Math.min(s[1], r.end);
        if (end <= start) continue;
        if (open !== null && open.end === start) open.end = end;
        else {
          close();
          open = { start, end };
        }
      }
    }
    close();
  }
  if (candidates.length === 0) return restored;

  // The text the PDF prints, before anything is restored.
  const printed = printedText();
  for (const slot of order.slots) {
    if (slot.kind === 'rebuilt') {
      printed.add((moved.get(slot.entry.id) ?? []).join('') + slot.source.shown.rebuilt.rebuilt.reconstructedText);
      continue;
    }
    const body = result.messages[slot.position]?.message.bodyText ?? '';
    const plan = plans.get(slot.position);
    if (!validRanges(plan, body.length) || plan.fallback) {
      printed.add(body);
      continue;
    }
    // Each run of kept ranges, as one piece of printed text.
    let from = -1;
    let to = -1;
    for (const r of withoutPrintedElsewhere(body, plan.ranges, elsewhere.get(slot.position) ?? NOWHERE).ranges) {
      if (!r.keep) continue;
      if (r.start !== to) {
        if (from >= 0) printed.add(body.slice(from, to));
        from = r.start;
      }
      to = r.end;
    }
    if (from >= 0) printed.add(body.slice(from, to));
  }

  const found = new Map<number, [number, number][]>();
  for (const c of candidates) {
    const text = (result.messages[c.position]?.message.bodyText ?? '').slice(c.start, c.end);
    if (printed.covers(text)) continue;
    printed.add(text);
    let list = found.get(c.position);
    if (list === undefined) found.set(c.position, (list = []));
    list.push([c.start, c.end]);
  }
  for (const [position, list] of found) restored.set(position, mergeParts(list.map(([start, end]) => ({ start, end }))));
  return restored;
}

/**
 * The order of the PDF (planPdfOrder, no rebuilt email under "Print full
 * original text") and the no-repeat rule's parts, exactly as
 * buildPdfDocument works them out: it calls this, and so does the preview
 * (src/ui-model/printed-elsewhere.ts, task 8.11), so the labels say what
 * the PDF does. Then the PRINTED SOMEWHERE check (printedNowhere), on the
 * same data, for both.
 */
export function noRepeat(input: NoRepeatInput): NoRepeat {
  const { result, positions, plans } = input;
  const unfold = input.policy.unfoldEverything === true;
  const order = planPdfOrder(result, positions, unfold ? [] : (input.rebuilt ?? []));
  if (unfold) return { order, parts: new Map(), elsewhere: new Map(), moved: new Map(), restored: new Map() };
  const planByPosition = new Map<number, MessagePlan | undefined>();
  for (const slot of order.slots) if (slot.kind === 'email') planByPosition.set(slot.position, plans[slot.plan]);
  // The rebuilt emails the reader really unticked, for the unticked forwarded parts (Q2; task 8.13a review
  // round 2: never inferred from what `rebuilt` lacks). The switch off: none is unticked. Chosen ones never are.
  const chosen = new Set(input.rebuilt ?? []);
  const unticked = input.rebuildingOff === true ? undefined : new Set((input.unticked ?? []).filter((id) => !chosen.has(id)));
  const { parts, moved } = noRepeatParts(result, order.slots, order.pdfNumberByPosition, planByPosition, unticked);
  const elsewhere = new Map<number, BodyIntervals>();
  for (const [position, list] of parts) elsewhere.set(position, mergeParts(list));
  const restored = printedNowhere(result, order, planByPosition, elsewhere, moved);
  return { order, parts, elsewhere, moved, restored };
}

/** pdfBodyText, and whether the no-repeat rule left something out. `restored`: see NoRepeat.restored. */
function bodyTextOf(
  body: string,
  plan: MessagePlan | null | undefined,
  policy: Pick<OutputPolicy, 'unfoldEverything'>,
  elsewhere: BodyIntervals,
  restored: BodyIntervals = NOWHERE,
): { readonly text: string; readonly planFallback: boolean; readonly notLineStarts: ReadonlySet<number>; readonly leftOutElsewhere: boolean } {
  if (policy.unfoldEverything) return { text: body, planFallback: false, notLineStarts: NO_JOINS, leftOutElsewhere: false };
  if (!validRanges(plan, body.length)) return { text: body, planFallback: true, notLineStarts: NO_JOINS, leftOutElsewhere: false };
  if (plan.fallback) return { text: body, planFallback: true, notLineStarts: NO_JOINS, leftOutElsewhere: false };
  const cut = withoutPrintedElsewhere(body, plan.ranges, elsewhere);
  const joined = joinKeptLines(body, withRestored(cut.ranges, restored));
  return { text: joined.text, planFallback: false, notLineStarts: joined.notLineStarts, leftOutElsewhere: cut.leftOut };
}

/**
 * What the PDF shows of a body, before the display transforms; with
 * `notLineStarts` for bodyLines (src/pdf/text.ts, joinKeptLines).
 * `elsewhere`: the parts of this body printed as emails of their own
 * (printedElsewhere), left out (withoutPrintedElsewhere) unless the whole
 * body is printed (see the top of this file).
 */
export function pdfBodyText(
  body: string,
  plan: MessagePlan | null | undefined,
  policy: Pick<OutputPolicy, 'unfoldEverything'>,
  elsewhere: BodyIntervals = NOWHERE,
): { readonly text: string; readonly planFallback: boolean; readonly notLineStarts: ReadonlySet<number> } {
  const { text, planFallback, notLineStarts } = bodyTextOf(body, plan, policy, elsewhere);
  return { text, planFallback, notLineStarts };
}

/** Sanitizes one-line texts (src/pdf/text.ts, inlineRuns) and adds up the characters replaced by a code. */
interface Sanitizer {
  count: number;
  line(text: string, role: PdfRole): PdfLine;
}

function sanitizer(): Sanitizer {
  const self: Sanitizer = {
    count: 0,
    line(text, role) {
      const s = inlineRuns(text, role);
      self.count += s.replaced;
      return s.runs;
    },
  };
  return self;
}

/** A line of one run of our own text (no sanitizing needed, but harmless). */
function own(text: string, role: PdfRole): PdfLine {
  return text === '' ? [] : [{ role, text }];
}

/** The mailboxes of one email that name its people: a real email, or a rebuilt one (no Sender). */
export type ParticipantSource = Pick<NormalizedMessage, 'from' | 'to' | 'cc'> & { readonly sender?: EmailAddress | undefined };

/**
 * Distinct people across From, Sender, To and Cc, deduplicated by address
 * (letter case ignored), sorted. Name and address spelling always come from
 * one mailbox: the first one seen with a name, else the first one seen.
 */
export function participantsOf(messages: readonly ParticipantSource[], locale: string): PdfParticipant[] {
  const byKey = new Map<string, { name: string; address: string }>();
  const add = (m: EmailAddress | undefined): void => {
    if (m === undefined || isBlank(m)) return;
    const address = m.address.trim();
    const name = m.name.trim();
    const key = address !== '' ? `a:${address.toLowerCase()}` : `n:${name.toLowerCase()}`;
    const found = byKey.get(key);
    if (found === undefined) byKey.set(key, { name, address });
    else if (found.name === '' && name !== '') {
      // The first name seen wins, with the address spelling of its own mailbox.
      found.name = name;
      found.address = address;
    }
  };
  for (const message of messages) {
    for (const m of message.from) add(m);
    add(message.sender);
    for (const m of message.to) add(m);
    for (const m of message.cc) add(m);
  }
  const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true });
  return [...byKey.values()].sort(
    (a, b) => collator.compare(a.name || a.address, b.name || b.address) || collator.compare(a.address, b.address) || (a.address < b.address ? -1 : a.address > b.address ? 1 : 0),
  );
}

// ---------------------------------------------------------------- one email

/** A date as the cover's date range uses it: a moment to compare, and its text. */
interface CoverDate {
  readonly ms: number;
  readonly text: string;
}

interface EmailParts {
  readonly email: PdfEmail;
  readonly entry: PdfIndexEntry;
  /** null: no usable date (counted as undated on the cover). */
  readonly when: CoverDate | null;
  /** Its people, for the cover. */
  readonly people: ParticipantSource;
}

/** Between the levels of an attached email's File row (src/ui-model/file-chain.ts). */
export { FILE_CHAIN_SEPARATOR };

/**
 * One line of an email's File row for the copy at input position `index`
 * (the kept copy or a merged one): its file name, or "(file without a name)";
 * for an email attached inside a file (task 8.13b-3, Q5), the file name and
 * then the attachment name at each level down to it (EngineAttached.names),
 * joined by FILE_CHAIN_SEPARATOR, an attachment without a name shown as
 * "(attached email N)" with its number at that level (EngineAttached.path:
 * the n-th attached email of the email holding it). The text comes from
 * src/ui-model/file-chain.ts, shared with the preview's "Also in" row (task
 * 8.13b-4, P2), so the two never disagree.
 */
function fileRowLine(result: EngineResult, index: number, fileName: string, strings: PdfStrings, s: Sanitizer): PdfLine {
  const chain = fileChain(result, index, fileName, strings);
  return chain.ownWords ? own(chain.text, 'muted') : s.line(chain.text, 'muted');
}

function buildEmail(
  m: EngineMessage,
  position: number,
  number: number,
  plan: MessagePlan | undefined,
  input: BuildPdfInput,
  elsewhere: BodyIntervals,
  restored: BodyIntervals,
): EmailParts {
  const { strings, policy, timeZone } = input;
  const message = m.message;
  const s = sanitizer();
  const index = sanitizer(); // the index repeats the header texts: not counted again

  // Header rows.
  const fields: PdfFieldRow[] = [];
  const list = (label: string, mailboxes: readonly EmailAddress[]): void => {
    const shown = mailboxes.filter((x) => !isBlank(x));
    if (shown.length > 0) fields.push({ label, value: [s.line(joinMailboxes(shown.map((x) => mailboxText(x, strings))), 'field-value')] });
  };
  const author = displayAuthor(message);
  const fromShown = message.from.filter((x) => !isBlank(x));
  if (fromShown.length > 0) list(strings.fromLabel, fromShown);
  else fields.push({ label: strings.fromLabel, value: [own(strings.unknownSender, 'muted')] });
  if (message.sender !== undefined && !isBlank(message.sender)) list(strings.senderLabel, [message.sender]);
  list(strings.toLabel, message.to);
  list(strings.ccLabel, message.cc);
  list(strings.bccLabel, message.bcc);

  const shown = formatInZone(message.date.utcMs, timeZone);
  const dated = shown.kind === 'date' && isDisplayableMs(message.date.utcMs);
  const zoneUnknown = dated && message.warnings.includes('unknown-time-zone');
  const dateLines: PdfLine[] = [];
  if (shown.kind === 'date' && dated) {
    dateLines.push(own(shown.text, 'field-value'));
    const local = formatSenderLocal(message.date);
    if (local.kind === 'local' && local.text !== shown.text) dateLines.push(own(strings.senderLocal(local.text), 'muted'));
  } else if (message.date.original.trim() !== '') {
    // A date that could not be read: its text as written, with no note (task 8.8).
    dateLines.push(s.line(message.date.original, 'field-value'));
  } else {
    dateLines.push(own(strings.noDate, 'muted'));
  }
  fields.push({ label: strings.dateLabel, value: dateLines });

  const hasSubject = message.subject.trim() !== '';
  fields.push({ label: strings.subjectLabel, value: [hasSubject ? s.line(message.subject, 'field-value') : own(strings.noSubject, 'muted')] });
  const files = [{ index: m.index, fileName: message.source.fileName }, ...m.duplicates.map((d) => ({ index: d.index, fileName: d.source.fileName }))];
  fields.push({ label: strings.fileLabel, value: files.map((f) => fileRowLine(input.result, f.index, f.fileName, strings, s)) });

  // Body.
  const { text, planFallback, notLineStarts, leftOutElsewhere } = bodyTextOf(message.bodyText, plan, policy, elsewhere, restored);
  const lines = bodyLines(text, { notLineStarts });
  s.count += lines.replaced;
  const keptAllBecauseEmpty = !policy.unfoldEverything && !planFallback && plan?.keptAllBecauseEmpty === true;

  // The only line above the text: the "(no text)" placeholder of an empty
  // text. What the tool was unsure about is said in the app, never in the
  // PDF (user rule, task 8.8).
  const notes: PdfLine[] = lines.lines.length === 0 ? [own(strings.noText, 'muted')] : [];
  const w = message.warnings;

  // Attachments.
  const items = message.attachments.map((a): PdfLine => {
    const name = a.fileName.trim() === '' ? own(strings.noAttachmentName, 'muted') : s.line(a.fileName, 'field-value');
    const details = s.line(strings.attachmentDetails(strings.size(a.size), a.mimeType), 'muted');
    return [...name, { role: 'muted', text: ' ' }, ...details];
  });

  // Index entry (texts without codes counted again).
  const anchor = emailAnchor(number);
  const fromIndex: PdfLine =
    author.source === 'none' ? own(strings.unknownSender, 'muted') : index.line(joinMailboxes(author.mailboxes.map(shortMailbox)), 'body');
  const subjectIndex = hasSubject ? index.line(message.subject, 'body') : own(strings.noSubject, 'muted');
  const day = shown.kind === 'date' && dated ? shown.text.slice(0, 10) : strings.noDate;
  const entry: PdfIndexEntry = {
    number,
    rebuilt: false,
    anchor,
    // Short ("2025-03-04 08:00", one line); the column title names the zone once.
    date: shown.kind === 'date' && dated ? own(shown.shortText, 'body') : own(strings.noDate, 'muted'),
    from: fromIndex,
    subject: subjectIndex,
    attachments: message.attachments.length,
    attachmentLines: items,
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
    attachments: items.length === 0 ? null : { label: strings.attachmentsLabel, items },
    flags: {
      undated: !dated,
      zoneUnknown,
      keptAllBecauseEmpty,
      planFallback,
      htmlConverted: w.includes('html-converted-body'),
      controlChars: s.count,
      printedElsewhere: leftOutElsewhere,
    },
  };
  const utcMs = message.date.utcMs;
  const when = shown.kind === 'date' && isDisplayableMs(utcMs) ? { ms: utcMs, text: shown.text } : null;
  return { email, entry, when, people: message };
}

// ---------------------------------------------------------------- one rebuilt email

/** A rebuilt email's date: the header's value lines, the index's short form, the bookmark's day and the cover's date. */
interface RebuiltDateParts {
  readonly lines: readonly PdfLine[];
  readonly index: PdfLine;
  readonly day: string;
  readonly when: CoverDate | null;
  /** A time read without a zone of its own (data only: the PDF does not say it, task 8.8). */
  readonly zoneUnknown: boolean;
}

/**
 * The first moment of `day` ("YYYY-MM-DD") in `zone` as the real emails'
 * dates are shown (formatInZone, UTC when the zone is not valid): the
 * smallest instant whose shown day is `day` or later, so that a real email
 * shown on an earlier day comes before it and one shown on that day or later
 * does not. Found by halving the interval from 26 hours before to 26 hours
 * after `day` 00:00 UTC (wider than any offset), to the millisecond: exact
 * across daylight-saving changes, a midnight that does not exist included.
 * In a zone whose clocks go back across midnight (e.g. older Sao Paulo
 * rules) the start found may be either midnight, at most an hour apart; the
 * search still ends.
 * null when `day` is not a date.
 */
export function dayStartInZone(day: string, zone: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const base = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(base)) return null;
  // Shown on `day` or later (instants that cannot be shown: by their side of `base`).
  const reached = (t: number): boolean => {
    const shown = formatInZone(t, zone);
    return shown.kind === 'date' ? shown.text.slice(0, 10) >= day : t >= base;
  };
  const HOURS_26 = 26 * 3_600_000;
  let lo = base - HOURS_26; // not reached
  let hi = base + HOURS_26; // reached
  if (reached(lo) || !reached(hi)) return base;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (reached(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * The date of a rebuilt email, shown as a real email's (task 8.3; see the
 * top of this file), from the best value read: a time in the chosen zone,
 * written as a real email's date (`zoneUnknown` when the quote gave no zone
 * of its own: data only, the app says it); a day alone as that day; a date
 * that could not be read as written; none: "no date".
 */
function rebuiltDateParts(r: EngineRebuilt, input: BuildPdfInput, s: Sanitizer): RebuiltDateParts {
  const { strings, timeZone } = input;
  const date = rebuiltDate(r);
  const undated = (lines: readonly PdfLine[]): RebuiltDateParts => ({ lines, index: own(strings.noDate, 'muted'), day: strings.noDate, when: null, zoneUnknown: false });
  if (date.kind === 'none') return undated([own(strings.noDate, 'muted')]);
  // A date that could not be read: its text as written, with no note (task 8.8).
  const unreadable = (): RebuiltDateParts => undated([date.text.trim() === '' ? own(strings.noDate, 'muted') : s.line(date.text, 'field-value')]);
  if (date.kind === 'unreadable') return unreadable();
  if (date.kind === 'day') {
    // The start of that day in the chosen zone, to place it in the cover's date range.
    const ms = dayStartInZone(date.day, timeZone);
    return {
      lines: [own(date.day, 'field-value')],
      index: own(date.day, 'body'),
      day: date.day,
      when: ms === null ? null : { ms, text: date.day },
      zoneUnknown: false,
    };
  }
  const shown = formatInZone(date.utcMs, timeZone);
  if (shown.kind !== 'date') return unreadable();
  return {
    lines: [own(shown.text, 'field-value')],
    index: own(shown.shortText, 'body'),
    day: shown.text.slice(0, 10),
    when: { ms: date.utcMs, text: shown.text },
    zoneUnknown: date.approximate,
  };
}

/**
 * One rebuilt email (see the top of this file): numbered and shown like a
 * real email (task 8.3), with the copy chosen by rebuiltInPdf. Its text is
 * the rebuilt text (its own quote marks already removed), whole: no plan
 * applies to it. Deeper quotes left in it (">" lines of an older email it
 * quoted) lose their quote marks like a real email's (src/pdf/text.ts, transform g).
 * `moved` (task 8.13a, Q4; NoRepeat.moved): original header lines its
 * header rows cannot show, left out of the emails that quote it; they come
 * first in its text, as plain text (the same role, font and indent as the
 * rest of its text), so nothing is lost and they sit under its header.
 */
function buildRebuiltEmail(entry: EngineRebuilt, source: RebuiltInPdf, number: number, input: BuildPdfInput, moved: readonly string[]): EmailParts {
  const { strings } = input;
  const r = source.shown.rebuilt;
  const m = r.rebuilt;
  const s = sanitizer();
  const index = sanitizer(); // the index repeats the header texts: not counted again

  const fields: PdfFieldRow[] = [];
  const shownOf = (list: readonly EmailAddress[]): EmailAddress[] => list.filter((x) => !isBlank(x));
  const list = (label: string, mailboxes: readonly EmailAddress[]): void => {
    if (mailboxes.length > 0) fields.push({ label, value: [s.line(joinMailboxes(mailboxes.map((x) => mailboxText(x, strings))), 'field-value')] });
  };
  const from = shownOf(m.from);
  const to = shownOf(m.to);
  const cc = shownOf(m.cc);
  // A From row is never empty: "Unknown sender" when the quote names none, as for a real email.
  if (from.length > 0) list(strings.fromLabel, from);
  else fields.push({ label: strings.fromLabel, value: [own(strings.unknownSender, 'muted')] });
  list(strings.toLabel, to);
  list(strings.ccLabel, cc);
  const date = rebuiltDateParts(r, input, s);
  fields.push({ label: strings.dateLabel, value: date.lines });
  const subject = m.subject !== null && m.subject.trim() !== '' ? m.subject : null;
  fields.push({ label: strings.subjectLabel, value: [subject !== null ? s.line(subject, 'field-value') : own(strings.noSubject, 'muted')] });

  const lines = bodyLines(moved.join('') + m.reconstructedText);
  s.count += lines.replaced;
  const notes: PdfLine[] = lines.lines.length === 0 ? [own(strings.noText, 'muted')] : [];

  const anchor = emailAnchor(number);
  const fromIndex: PdfLine = from.length > 0 ? index.line(joinMailboxes(from.map(shortMailbox)), 'body') : own(strings.unknownSender, 'muted');
  const subjectIndex: PdfLine = subject !== null ? index.line(subject, 'body') : own(strings.noSubject, 'muted');
  const entryOut: PdfIndexEntry = {
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
    rebuilt: { id: entry.id, shownId: r.id, sourcePosition: source.shown.position, movedHeaders: moved.length },
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
      controlChars: s.count,
      printedElsewhere: false,
    },
  };
  return { email, entry: entryOut, when: date.when, people: { from, to, cc } };
}

// ---------------------------------------------------------------- the document

/** Builds the whole PDF document model (see the top of this file). */
export function buildPdfDocument(input: BuildPdfInput): PdfDocument {
  const { result, positions, plans, strings, timeZone, generatedAt } = input;

  // The included emails: positions that exist, each once, in the given
  // order; the rebuilt ones chosen, at their place (planPdfOrder); none
  // under "Print full original text" (see the top of this file).
  // The no-repeat rule (task 8.10): nothing is printed twice unless the whole
  // text is. The preview's labels use the same call (noRepeat, task 8.11).
  const {
    order: { slots, pdfNumberByPosition },
    elsewhere,
    moved,
    restored,
  } = noRepeat({ result, positions, plans, policy: input.policy, rebuilt: input.rebuilt, rebuildingOff: input.rebuildingOff, unticked: input.unticked });
  const emails: PdfEmail[] = [];
  const entries: PdfIndexEntry[] = [];
  const people: ParticipantSource[] = [];
  // The cover counts every email alike, rebuilt ones included (task 8.3).
  let undated = 0;
  let first: CoverDate | null = null;
  let last: CoverDate | null = null;
  for (const slot of slots) {
    let parts: EmailParts;
    if (slot.kind === 'rebuilt') {
      parts = buildRebuiltEmail(slot.entry, slot.source, slot.number, input, moved.get(slot.entry.id) ?? []);
    } else {
      const m = result.messages[slot.position]!;
      parts = buildEmail(m, slot.position, slot.number, plans[slot.plan], input, elsewhere.get(slot.position) ?? NOWHERE, restored.get(slot.position) ?? NOWHERE);
    }
    emails.push(parts.email);
    entries.push(parts.entry);
    people.push(parts.people);
    const when = parts.when;
    if (when === null) undated++;
    else {
      if (first === null || when.ms < first.ms) first = when;
      if (last === null || when.ms > last.ms) last = when;
    }
  }
  const controlChars = emails.reduce((n, e) => n + e.flags.controlChars, 0);

  // Cover.
  const c = sanitizer(); // the cover repeats names from the emails: not counted
  const generatedShown = formatInZone(generatedAt, timeZone);
  const generated = generatedShown.kind === 'date' ? generatedShown.text : strings.noDate;
  const usedZone = generatedShown.kind === 'date' ? generatedShown.zone : 'UTC';
  const zoneFallback = generatedShown.kind === 'date' && generatedShown.zoneFallback;
  const dateRange = first === null || last === null ? null : { first: first.text, last: last.text };
  // The zone as the cover's "Time zone" row writes it (underscores as spaces).
  const zoneShown = usedZone.replaceAll('_', ' ');

  // No dated email: the same "(no date)" placeholder as an email's own Date row (task 8.8).
  const dateLine: PdfLine =
    dateRange === null
      ? own(strings.noDate, 'muted')
      : own(dateRange.first === dateRange.last ? dateRange.first : strings.dateRange(dateRange.first, dateRange.last), 'field-value');

  const participants = participantsOf(people, strings.locale);

  const blocks: PdfBlock[] = [
    { kind: 'heading', level: 1, line: own(strings.title, 'title') },
    {
      kind: 'fields',
      rows: [
        { label: strings.datesLabel, value: [dateLine] },
        { label: strings.emailsLabel, value: [own(strings.emailCount(emails.length), 'field-value')] },
        // Just the zone used (UTC after a fallback): the app says when the chosen zone was not recognized (task 8.8).
        { label: strings.timeZoneLabel, value: [c.line(zoneShown, 'field-value')] },
        { label: strings.generatedLabel, value: [own(generated, 'field-value')] },
      ],
    },
  ];
  if (participants.length > 0) {
    blocks.push({ kind: 'heading', level: 2, line: own(strings.peopleHeading, 'heading') });
    blocks.push({ kind: 'list', items: participants.map((p) => [c.line(mailboxText(p, strings), 'body')]) });
  }

  return {
    title: strings.title,
    fileName: pdfFileName(generatedAt, timeZone, strings),
    timeZone: usedZone,
    zoneFallback,
    cover: { blocks, dateRange, undated, emailCount: emails.length, generated, participants },
    index: {
      heading: strings.indexHeading,
      // The zone name passes the same sanitizer as on the cover (a title is plain text, so codes stay as their text).
      columns: { ...strings.columns, date: strings.indexDateColumn(lineText(c.line(zoneShown, 'field-label'))) },
      entries,
    },
    emails,
    pdfNumberByPosition,
    controlChars,
  };
}
