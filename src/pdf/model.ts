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
//   zone, the source files with their SHA-256, and the files that could not
//   be read (as `blocks` for the renderer, and as data);
// - index: one entry per email (number, date, author, subject, attachment
//   count and lines, anchor, bookmark title); the renderer resolves each
//   anchor to a page number;
// - emails: per email its header rows, notes, body lines and attachments.
//
// Numbering: emails are numbered 1..k over the INCLUDED emails, in list
// order. The preview's "#N" is the list number (every email, included or
// not), so the two differ once an email is left out: `pdfNumberByPosition`
// maps a list position to its PDF number (null when not in the PDF), for a
// preview that wants to show it later.
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
//
// Undated emails: shown with the "no date" text in the index and their
// header (plus the date text as written, when there is one); the cover's
// date range covers the dated emails only and says how many have no date
// (they are at the end of the list, in file order, src/engine/order.ts).
//
// Source files: every file that gave an included email: the kept copy and
// every identical copy merged into it (src/engine/dedupe.ts), one entry per
// dropped file, in PDF order, each with the email it gave. A file is not
// opened again: name, SHA-256 and format come from the parse result (its
// size is not known there). Files that could not be read are NOT sources
// (nothing of theirs is in the PDF); they are listed apart, "could not be
// read", so the reader knows the set given was larger (option
// `listUnreadable`, on by default).
//
// Safety: email text is plain data here. It is never read as markup or
// code (README.md, rule R4); the renderer writes it as text. Nothing is
// stored (README.md, rule R5). The stored messages are never changed: every
// transform makes new strings. Pure function, no DOM, no clock (the caller
// passes `generatedAt`), README.md, rule R7.

import type { EngineMessage, EngineResult } from '../engine/engine';
import type { MessagePlan, OutputPolicy } from '../engine/output-plan';
import { formatInZone, formatSenderLocal, isDisplayableMs } from '../engine/time-format';
import type { EmailAddress, NormalizedMessage, ParseErrorCode } from '../parsing/types';
import { displayAuthor } from '../ui-model/display-author';
import { joinMailboxes } from '../ui-model/mailbox-list';
import type { PdfStrings } from './strings';
import { bodyLines, inlineRuns, joinKept, lineText, type PdfLine, type PdfRole } from './text';
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

/** A dropped file that could not be read (not a source: nothing of it is in the PDF). */
export interface PdfUnreadableFile {
  readonly fileName: string;
  readonly sha256: string | null;
  readonly error: ParseErrorCode;
  readonly inputIndex: number;
}

export interface PdfCover {
  /** What the cover shows, in order. */
  readonly blocks: readonly PdfBlock[];
  /** The data behind it. Texts here are as found (not sanitized); the blocks hold the display form. */
  readonly dateRange: { readonly first: string; readonly last: string } | null;
  readonly undated: number;
  readonly emailCount: number;
  readonly generated: string;
  readonly participants: readonly PdfParticipant[];
  readonly sources: readonly PdfSourceFile[];
  readonly unreadable: readonly PdfUnreadableFile[];
}

/** One line of the index. The renderer adds the page of `anchor`. */
export interface PdfIndexEntry {
  readonly number: number;
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

export interface PdfEmail {
  /** 1..k over the included emails. */
  readonly number: number;
  /** For links from the index (resolved by the renderer). */
  readonly anchor: string;
  /** Its position in the engine's list (`result.messages`). */
  readonly position: number;
  /** "Email 3". */
  readonly heading: string;
  /** From, Sent by, To, Cc, Bcc (each when present), Date, Subject, File. */
  readonly fields: readonly PdfFieldRow[];
  /** Short notes above the text (role 'muted'), e.g. "The whole email is shown: ...". */
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
  /** True when the asked-for zone was not valid and UTC was used. */
  readonly zoneFallback: boolean;
  readonly cover: PdfCover;
  readonly index: PdfIndex;
  readonly emails: readonly PdfEmail[];
  /** For each list position of `result.messages`: its PDF number, or null when it is not in the PDF. */
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
  /** IANA zone name (an invalid one falls back to UTC, and the cover says so). */
  readonly timeZone: string;
  /** When the PDF is made, in ms since 1970 UTC. */
  readonly generatedAt: number;
  readonly strings: PdfStrings;
  /** List the files that could not be read on the cover (default true). */
  readonly listUnreadable?: boolean;
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

/** The anchor of email `number` (for the index links). */
export function emailAnchor(number: number): string {
  return `email-${String(number)}`;
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

/** What the PDF shows of a body, before the display transforms. */
export function pdfBodyText(
  body: string,
  plan: MessagePlan | null | undefined,
  policy: Pick<OutputPolicy, 'unfoldEverything'>,
): { readonly text: string; readonly planFallback: boolean } {
  if (policy.unfoldEverything) return { text: body, planFallback: false };
  if (!validRanges(plan, body.length)) return { text: body, planFallback: true };
  if (plan.fallback) return { text: body, planFallback: true };
  return { text: joinKept(body, plan.ranges), planFallback: false };
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

/**
 * Distinct people across From, Sender, To and Cc, deduplicated by address
 * (letter case ignored), sorted. Name and address spelling always come from
 * one mailbox: the first one seen with a name, else the first one seen.
 */
export function participantsOf(messages: readonly NormalizedMessage[], locale: string): PdfParticipant[] {
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

interface EmailParts {
  readonly email: PdfEmail;
  readonly entry: PdfIndexEntry;
  readonly utcMs: number | null;
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
    if (zoneUnknown) dateLines.push(own(strings.zoneUnknown, 'muted'));
  } else {
    dateLines.push(own(strings.noDate, 'muted'));
    if (message.date.original.trim() !== '') dateLines.push(s.line(strings.dateAsWritten(message.date.original), 'muted'));
  }
  fields.push({ label: strings.dateLabel, value: dateLines });

  const hasSubject = message.subject.trim() !== '';
  fields.push({ label: strings.subjectLabel, value: [hasSubject ? s.line(message.subject, 'field-value') : own(strings.noSubject, 'muted')] });
  const files = [message.source.fileName, ...m.duplicates.map((d) => d.source.fileName)];
  fields.push({ label: strings.fileLabel, value: files.map((f) => (f.trim() === '' ? own(strings.noFileName, 'muted') : s.line(f, 'muted'))) });

  // Body.
  const { text, planFallback } = pdfBodyText(message.bodyText, plan, policy);
  const lines = bodyLines(text);
  s.count += lines.replaced;
  const keptAllBecauseEmpty = !policy.unfoldEverything && !planFallback && plan?.keptAllBecauseEmpty === true;

  // Notes.
  const notes: PdfLine[] = [];
  if (planFallback) notes.push(own(strings.fallback, 'muted'));
  else if (keptAllBecauseEmpty) notes.push(own(strings.keptAllEmpty, 'muted'));
  const w = message.warnings;
  if (w.includes('html-body-truncated')) notes.push(own(strings.contentNotes.htmlBodyTruncated, 'muted'));
  if (w.includes('html-body-unreadable')) notes.push(own(strings.contentNotes.htmlBodyUnreadable, 'muted'));
  if (w.includes('rtf-only-body')) notes.push(own(strings.contentNotes.rtfOnlyBody, 'muted'));
  if (w.includes('forwarded-message-not-expanded')) notes.push(own(strings.contentNotes.forwardedNotExpanded, 'muted'));
  if (lines.lines.length === 0) notes.push(own(strings.noText, 'muted'));

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
  return { email, entry, utcMs: dated ? message.date.utcMs : null };
}

// ---------------------------------------------------------------- the document

/** Builds the whole PDF document model (see the top of this file). */
export function buildPdfDocument(input: BuildPdfInput): PdfDocument {
  const { result, positions, plans, strings, timeZone, generatedAt } = input;

  // The included emails: positions that exist, each once, in the given order.
  const pdfNumberByPosition: (number | null)[] = result.messages.map(() => null);
  const emails: PdfEmail[] = [];
  const entries: PdfIndexEntry[] = [];
  const included: EngineMessage[] = [];
  let first: number | null = null;
  let last: number | null = null;
  positions.forEach((position, k) => {
    const m = result.messages[position];
    if (m === undefined || pdfNumberByPosition[position] !== null) return;
    const number = emails.length + 1;
    pdfNumberByPosition[position] = number;
    const parts = buildEmail(m, position, number, plans[k], input);
    emails.push(parts.email);
    entries.push(parts.entry);
    included.push(m);
    if (parts.utcMs !== null) {
      if (first === null || parts.utcMs < first) first = parts.utcMs;
      if (last === null || parts.utcMs > last) last = parts.utcMs;
    }
  });
  const controlChars = emails.reduce((n, e) => n + e.flags.controlChars, 0);
  const undated = emails.filter((e) => e.flags.undated).length;

  // Cover.
  const c = sanitizer(); // the cover repeats names from the emails: not counted
  const fileNameLine = (name: string): PdfLine => (name.trim() === '' ? own(strings.noFileName, 'muted') : c.line(name, 'body'));
  const generatedShown = formatInZone(generatedAt, timeZone);
  const generated = generatedShown.kind === 'date' ? generatedShown.text : strings.noDate;
  const usedZone = generatedShown.kind === 'date' ? generatedShown.zone : 'UTC';
  const zoneFallback = generatedShown.kind === 'date' && generatedShown.zoneFallback;
  const textAt = (ms: number | null): string => {
    const f = formatInZone(ms, timeZone);
    return f.kind === 'date' ? f.text : strings.noDate;
  };
  const dateRange = first === null || last === null ? null : { first: textAt(first), last: textAt(last) };
  // The zone as the cover's "Time zone" row writes it (underscores as spaces).
  const zoneShown = usedZone.replaceAll('_', ' ');

  const dateLines: PdfLine[] = [];
  if (dateRange === null) dateLines.push(own(strings.noDates, 'muted'));
  else dateLines.push(own(dateRange.first === dateRange.last ? dateRange.first : strings.dateRange(dateRange.first, dateRange.last), 'field-value'));
  if (undated > 0 && dateRange !== null) dateLines.push(own(strings.undated(undated), 'muted'));

  const participants = participantsOf(
    included.map((m) => m.message),
    strings.locale,
  );

  const sources: PdfSourceFile[] = [];
  included.forEach((m, k) => {
    const email = k + 1;
    const s = m.message.source;
    sources.push({ fileName: s.fileName, sha256: s.sha256, kind: s.kind, inputIndex: m.index, email, mergedCopy: false });
    for (const d of [...m.duplicates].sort((a, b) => a.index - b.index)) {
      sources.push({ fileName: d.source.fileName, sha256: d.source.sha256, kind: d.source.kind, inputIndex: d.index, email, mergedCopy: true });
    }
  });
  const unreadable: PdfUnreadableFile[] =
    input.listUnreadable === false ? [] : result.failed.map((f) => ({ fileName: f.fileName, sha256: f.sha256, error: f.error, inputIndex: f.index }));

  const blocks: PdfBlock[] = [
    { kind: 'heading', level: 1, line: own(strings.title, 'title') },
    {
      kind: 'fields',
      rows: [
        { label: strings.datesLabel, value: dateLines },
        { label: strings.emailsLabel, value: [own(strings.emailCount(emails.length), 'field-value')] },
        { label: strings.timeZoneLabel, value: [c.line(zoneFallback ? strings.zoneFallback(usedZone) : zoneShown, 'field-value')] },
        { label: strings.generatedLabel, value: [own(generated, 'field-value')] },
      ],
    },
  ];
  if (controlChars > 0) blocks.push({ kind: 'paragraph', line: own(strings.controlChars(controlChars), 'muted') });
  if (participants.length > 0) {
    blocks.push({ kind: 'heading', level: 2, line: own(strings.peopleHeading, 'heading') });
    blocks.push({ kind: 'list', items: participants.map((p) => [c.line(mailboxText(p, strings), 'body')]) });
  }
  if (sources.length > 0) {
    blocks.push({ kind: 'heading', level: 2, line: own(strings.sourcesHeading, 'heading') });
    blocks.push({ kind: 'paragraph', line: own(strings.sourcesIntro, 'muted') });
    blocks.push({
      kind: 'list',
      items: sources.map((f) => [
        [...fileNameLine(f.fileName), ...own(strings.separator + (f.mergedCopy ? strings.sourceCopy(f.email) : strings.sourceEmail(f.email)), 'muted')],
        c.line(f.sha256, 'mono'),
      ]),
    });
  }
  if (unreadable.length > 0) {
    blocks.push({ kind: 'heading', level: 2, line: own(strings.unreadableHeading, 'heading') });
    blocks.push({ kind: 'paragraph', line: own(strings.unreadableIntro, 'muted') });
    blocks.push({
      kind: 'list',
      items: unreadable.map((f) => [fileNameLine(f.fileName), f.sha256 === null ? own(strings.noFingerprint, 'muted') : c.line(f.sha256, 'mono')]),
    });
  }

  return {
    title: strings.title,
    fileName: pdfFileName(generatedAt, timeZone, strings),
    timeZone: usedZone,
    zoneFallback,
    cover: { blocks, dateRange, undated, emailCount: emails.length, generated, participants, sources, unreadable },
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
