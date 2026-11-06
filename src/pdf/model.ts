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
// - cover: title, date range, people, email count, generation date, time
//   zone and the source files with their SHA-256 (as `blocks` for the
//   renderer, and as data);
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
// range and the people like a real email; it is NOT in the source files and
// their SHA-256 (it has no file: no entry is ever made up for it). The
// PREVIEW keeps marking rebuilt emails (src/ui/preview.ts), unchanged.
// PdfEmail.rebuilt and PdfIndexEntry.rebuilt still tell the two apart in
// the data (for tests and checks); the renderer never prints them.
// FOLLOW-SOURCE RULE (user decision Q1 (a)): a rebuilt email is in the PDF
// only while at least one email it was read from is (rebuiltInPdf in
// src/ui-model/rebuilt.ts); for a text quoted in several emails, the text
// and header shown are the ones read from its own source when that one is
// in the PDF, else from the source in the PDF that comes first. The source
// email itself is unchanged: its quoted history is folded or kept by its
// plan exactly as before (collapse, never delete).
// FULL ORIGINAL TEXT RULE ("Print full original text"; user decision
// 2026-10-28, task 7.8b, kept as a safety net in task 7.8c): with
// `policy.unfoldEverything` NO rebuilt email is in the PDF, whatever
// `rebuilt` says: every source email is then printed whole, quoted history
// included, so a rebuilt email would only print that text twice.
//
// Body: the plan's KEPT ranges joined in order (src/pdf/text.ts, joinKept):
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
// footer, headings, labels, the index, the bookmarks and the file list with
// its SHA-256. The data behind the removed notes stays in the model
// (`flags`, `cover.undated`, `zoneFallback`, `controlChars`, `mergedCopy`),
// for tests and checks; the renderer never prints it.
//
// Undated emails: shown with the "no date" text in the index; their Date
// row shows the date text as written when there is one, else "no date". The
// cover's date range covers the dated emails only (real and rebuilt; a
// rebuilt email dated by a day alone counts from the start of that day in
// the chosen zone, dayStartInZone, and shows as that day); with no dated
// email at all it shows "no date". Real undated emails are at the end of
// the list, in file order (src/engine/order.ts).
//
// Source files: every file that gave an included email: the kept copy and
// every identical copy merged into it (src/engine/dedupe.ts), one entry per
// dropped file, in PDF order, each with the email it gave, listed alike (a
// merged copy is not marked). A file is not opened again: name, SHA-256 and
// format come from the parse result (its size is not known there). Files
// that could not be read are not in the PDF at all (step 1 of the app lists
// them with the reasons).
// The cover's "Source files" heading is followed by the list itself, with
// no note of ours (user decision 2026-11-05, task 8.7): the file names and
// their SHA-256 stay (brief section 8.5). The cover has no text about
// rebuilt emails either (task 8.3, checked again in task 8.7).
//
// Safety: email text is plain data here. It is never read as markup or
// code (README.md, rule R4); the renderer writes it as text. Nothing is
// stored (README.md, rule R5). The stored messages are never changed: every
// transform makes new strings. Pure function, no DOM, no clock (the caller
// passes `generatedAt`), README.md, rule R7.

import type { EngineMessage, EngineRebuilt, EngineResult } from '../engine/engine';
import type { MessagePlan, OutputPolicy } from '../engine/output-plan';
import { formatInZone, formatSenderLocal, isDisplayableMs } from '../engine/time-format';
import type { EmailAddress, NormalizedMessage } from '../parsing/types';
import { displayAuthor } from '../ui-model/display-author';
import { joinMailboxes } from '../ui-model/mailbox-list';
import { previewOrder, rebuiltDate, rebuiltInPdf, type RebuiltInPdf } from '../ui-model/rebuilt';
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

/** A dropped file that gave an included email. */
export interface PdfSourceFile {
  readonly fileName: string;
  readonly sha256: string;
  readonly kind: 'eml' | 'msg';
  /** Its position in the engine input (drop order). */
  readonly inputIndex: number;
  /** The PDF number of the email it gave. */
  readonly email: number;
  /** True: its email was an identical copy merged into the email of another file. */
  readonly mergedCopy: boolean;
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
  readonly sources: readonly PdfSourceFile[];
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
}

/** Where a rebuilt email in the PDF comes from (data only: the PDF never shows it, task 8.3). */
export interface PdfRebuiltInfo {
  /** The entry's id in `result.reconstructed` (link 'entry'). */
  readonly id: number;
  /** The id of the copy shown: the entry, or a copy read from an email in the PDF (rebuiltInPdf). */
  readonly shownId: number;
  /** The list position of the email it was taken from (in the PDF). */
  readonly sourcePosition: number;
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

/**
 * What the PDF shows of a body, before the display transforms; with
 * `notLineStarts` for bodyLines (src/pdf/text.ts, joinKeptLines).
 */
export function pdfBodyText(
  body: string,
  plan: MessagePlan | null | undefined,
  policy: Pick<OutputPolicy, 'unfoldEverything'>,
): { readonly text: string; readonly planFallback: boolean; readonly notLineStarts: ReadonlySet<number> } {
  if (policy.unfoldEverything) return { text: body, planFallback: false, notLineStarts: NO_JOINS };
  if (!validRanges(plan, body.length)) return { text: body, planFallback: true, notLineStarts: NO_JOINS };
  if (plan.fallback) return { text: body, planFallback: true, notLineStarts: NO_JOINS };
  const joined = joinKeptLines(body, plan.ranges);
  return { text: joined.text, planFallback: false, notLineStarts: joined.notLineStarts };
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

function buildEmail(
  m: EngineMessage,
  position: number,
  number: number,
  plan: MessagePlan | undefined,
  input: BuildPdfInput,
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
  const files = [message.source.fileName, ...m.duplicates.map((d) => d.source.fileName)];
  fields.push({ label: strings.fileLabel, value: files.map((f) => (f.trim() === '' ? own(strings.noFileName, 'muted') : s.line(f, 'muted'))) });

  // Body.
  const { text, planFallback, notLineStarts } = pdfBodyText(message.bodyText, plan, policy);
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
 */
function buildRebuiltEmail(entry: EngineRebuilt, source: RebuiltInPdf, number: number, input: BuildPdfInput): EmailParts {
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

  const lines = bodyLines(m.reconstructedText);
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
    rebuilt: { id: entry.id, shownId: r.id, sourcePosition: source.shown.position },
    fields,
    notes,
    body: lines.lines,
    attachments: null,
    flags: { undated: date.when === null, zoneUnknown: date.zoneUnknown, keptAllBecauseEmpty: false, planFallback: false, htmlConverted: false, controlChars: s.count },
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
  const rebuiltIds = input.policy.unfoldEverything === true ? [] : (input.rebuilt ?? []);
  const { slots, pdfNumberByPosition } = planPdfOrder(result, positions, rebuiltIds);
  const emails: PdfEmail[] = [];
  const entries: PdfIndexEntry[] = [];
  const people: ParticipantSource[] = [];
  // The real emails in the PDF and their PDF numbers (for the source files: real files only).
  const included: { readonly m: EngineMessage; readonly number: number }[] = [];
  // The cover counts every email alike, rebuilt ones included (task 8.3).
  let undated = 0;
  let first: CoverDate | null = null;
  let last: CoverDate | null = null;
  for (const slot of slots) {
    let parts: EmailParts;
    if (slot.kind === 'rebuilt') {
      parts = buildRebuiltEmail(slot.entry, slot.source, slot.number, input);
    } else {
      const m = result.messages[slot.position]!;
      parts = buildEmail(m, slot.position, slot.number, plans[slot.plan], input);
      included.push({ m, number: slot.number });
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
  const fileNameLine = (name: string): PdfLine => (name.trim() === '' ? own(strings.noFileName, 'muted') : c.line(name, 'body'));
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

  // Real files only: a rebuilt email has no file, so no entry is ever made for it.
  const sources: PdfSourceFile[] = [];
  included.forEach(({ m, number: email }) => {
    const s = m.message.source;
    sources.push({ fileName: s.fileName, sha256: s.sha256, kind: s.kind, inputIndex: m.index, email, mergedCopy: false });
    for (const d of [...m.duplicates].sort((a, b) => a.index - b.index)) {
      sources.push({ fileName: d.source.fileName, sha256: d.source.sha256, kind: d.source.kind, inputIndex: d.index, email, mergedCopy: true });
    }
  });

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
  if (sources.length > 0) {
    blocks.push({ kind: 'heading', level: 2, line: own(strings.sourcesHeading, 'heading') });
    blocks.push({
      kind: 'list',
      items: sources.map((f) => [
        // A merged identical copy is listed like any other file, with no explanation (task 8.8).
        [...fileNameLine(f.fileName), ...own(strings.separator + strings.sourceEmail(f.email), 'muted')],
        c.line(f.sha256, 'mono'),
      ]),
    });
  }

  return {
    title: strings.title,
    fileName: pdfFileName(generatedAt, timeZone, strings),
    timeZone: usedZone,
    zoneFallback,
    cover: { blocks, dateRange, undated, emailCount: emails.length, generated, participants, sources },
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
