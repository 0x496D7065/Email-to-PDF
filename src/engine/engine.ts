// The engine pipeline: from parsed files to the ordered, folded messages the
// preview and the PDF will show (README.md, rules R6 and R7).
//
// Steps:
// 1. Split the parse results into messages and failed files. A failed file
//    is listed with its reason and never stops the others. Every email
//    attached inside a dropped file (ParseResult.attached: inline forwards
//    and emails sent as attachments in .eml, attached Outlook emails in
//    .msg) becomes a message of its own (task 8.13b-3, option A, user
//    decisions 2026-11-10; an approved exception to README.md rule R4), after
//    the files' own emails: see ATTACHED EMAILS below.
// 2. De-duplicate (dedupe.ts): only provably identical copies are merged,
//    and every merged copy stays listed next to its kept message.
// 3. Order chronologically (order.ts). An attached email with no usable
//    date goes just before the email it is attached to (placeUndatedAttached).
// 4. Run the fold detectors on the ordered kept messages:
//    a. overlap (overlap.ts), the main quote detector, over the whole set;
//    b. quote markers (quote-markers.ts) and reply headers (reply-header.ts,
//       which also gets the subject), per message;
//    c. signatures (signature.ts) over the whole set, with `ownTextEnd` =
//       the first quote-marker or reply-header fold of the message. Overlap
//       folds are left out on purpose: overlap.ts also folds the sender's own
//       repeated signature (it matches the same lines in their earlier
//       messages), so its first fold can start AT the signature and would
//       hide the signature from the signature detector.
// 5. Per message, turn all folds into segments (segments.ts).
// 6. Rebuild earlier messages from the quoted text of every kept message
//    (reconstruct.ts), link them to the real messages and to each other, and
//    build the timeline (rebuild-links.ts). Always on, but it only ADDS
//    `reconstructed`, `timeline` and `reconstructionWarnings` to the
//    result: messages, segments, counts and positionByIndex are exactly
//    what they would be without it. A rebuilt message is a view of a slice
//    of its source body; the source body stays whole in `messages`.
//
// Indices: every `index` and `related` number in the result (EngineMessage.index,
// MergedCopy.index, DedupeWarning.related, Segment.related) is an INPUT
// POSITION: for a file's own email, its position in the array given to
// `runEngine`, i.e. the order the files were dropped in; for an attached
// email, `results.length` plus its place among all attached emails (files in
// drop order, each file's attached emails in ParseResult.attached order),
// see EngineAttached. `positionByIndex` turns such a number into a position
// in `messages`, so the preview can resolve "quoted from message N" or
// "duplicate of ..." directly.
//
// ATTACHED EMAILS (task 8.13b-3): each one goes through every step above
// exactly like a dropped file's email. Consequences:
// - De-duplication: when an attached email and a dropped file's email are
//   copies, the dropped file's copy is ALWAYS kept (Q8; D2, user decision
//   2026-11-13, review round 4: even when the attached copy holds strictly
//   more header data, say a Bcc line or a date; dedupe.ts, `firstAttached`),
//   and the attached copy is listed as merged. EngineAttached.keptShowsHeader
//   says when the kept copy's header rows lack something the attached copy
//   had: the PDF then leaves that copy's block header lines where they are
//   printed (an inline forward), so they are still printed there. A holder
//   merged into another copy: its attached emails' places are moved to the
//   kept copy (S1, settleAttached).
// - Folding, rebuilding and linking see it as a real email: the overlap
//   detector folds its text where another email quotes it (its own parent's
//   printed block included). An email holding it (its parent, the parent's
//   parent, ..., or the copies they were merged into) always counts as
//   quoting it, whatever the dates and reference headers say (heldByKept,
//   overlap.ts `holds`; task 8.13b-3, review round 2), so its own text is
//   never folded as quoted from a holder; and a holder counts as
//   referencing whatever the emails it holds reference (overlap.ts,
//   withHeldReferences; review round 3), so the text of an email they
//   reply to is folded in the holder rather than in that email. A rebuilt copy of it in another email can
//   be linked to it ("the real file wins", rebuild-links.ts). The .eml
//   adapter's own forwarded block is never rebuilt (reconstruct.ts stops
//   there), so a parent never yields a rebuilt copy of its own inline
//   forward.
// - `attached` (EngineAttached) keeps where each one came from (its parent,
//   its file, its attachment names for the PDF's File row) and its printed
//   blocks in the bodies holding it (places), for the PDF's no-repeat rule
//   (src/pdf/model.ts): the engine itself never cuts any body.
// Attached entries that break ParseResult's contract (normally rejected by
// the worker validator already) are skipped, with the ones attached inside
// them: their text then simply stays where its parent prints it.
//
// Safety net (README.md, rule R6: collapse, never delete): the detectors are
// tested, but the engine does not rely on them being bug-free. If a detector
// throws, or returns something that is not the expected list (or list of
// lists), its folds are skipped for the messages concerned and they get a
// 'detector-failed' warning; entries that are not objects are ignored, and
// buildSegments ignores bad ranges. If the segments of a message are not a
// valid cover of its body (checkSegments finds a problem, joining them does
// not give the body back, or building them throws), all its folds are
// dropped and the whole body is shown as one segment, with a
// 'folding-disabled' warning. If de-duplication throws or returns an
// inconsistent result, no message is merged and every message gets a
// 'dedupe-failed' warning. Text is never lost, at worst it is not folded or
// not merged. Rebuilding (step 6) has its own net: if it throws or returns
// anything invalid for a message (see validRebuilt), nothing is rebuilt
// from that message and it gets a 'reconstruct-failed'
// ReconstructionWarning; a limit reached gives 'reconstruct-limit' (with
// what was rebuilt up to the limit). If linking throws or gives an invalid
// timeline, nothing is rebuilt at all and every kept message gets
// 'reconstruct-failed'. The real messages are never affected.
// Long lists are appended with loops, never spread into a call
// (`push(...list)` overflows the stack for a few hundred thousand items).
//
// Not solved here (notes for the preview milestone):
// - dedupe.ts has a known worst case (thousands of copies of one message with
//   differing recipients make grouping quadratic). Together with the size of
//   the overlap index, this means the preview should run the engine off the
//   main thread (in a worker) or behind a time/size limit. The result is
//   plain data (no classes, no functions, no Maps), so it can be sent from a
//   worker with postMessage (structured clone).
// - Blank lines are not normalised here; that is a layout question for the PDF.
//
// Pure function: no DOM, no storage, no clock; the input array and the
// messages in it are never modified (README.md, rule R7).

import type { NormalizedMessage, ParseErrorCode, ParseResult, ParseWarning } from '../parsing/types';
import { dedupe, keepsHeaderData, type DedupeResult, type DedupeWarning, type MergedCopy } from './dedupe';
import { orderMessages, type OrderReason } from './order';
import { detectQuotedOverlap } from './overlap';
import { detectQuoteMarkers } from './quote-markers';
import { detectReplyHeaders } from './reply-header';
import { mapOffsets } from './same-text-offsets';
import { buildSegments, checkSegments, reconstruct, type FoldRange, type FoldReason, type Segment } from './segments';
import { detectSignatures, senderKeyOf } from './signature';
import { linkRebuilt, type EngineRebuilt, type LinkSource, type TimelineEntry } from './rebuild-links';
import { MAX_QUOTE_DEPTH, MAX_RECONSTRUCTED, MAX_SOURCE_LENGTH, reconstructQuotedMessages, removeQuoteMarks, type ReconstructedMessage } from './reconstruct';

export type { EngineRebuilt, RealMatch, RebuiltLink, RebuiltPlacement, TimelineEntry } from './rebuild-links';

/**
 * Something that went wrong while rebuilding messages from the quoted text
 * of one kept message (step 6). Kept apart from EngineWarningCode: the real
 * message itself is not affected (its segments are the same), and the
 * preview does not show these yet (task 7.6).
 * - 'reconstruct-failed': rebuilding threw or returned something invalid,
 *   so nothing was rebuilt from this message (or, if linking failed, from
 *   any message).
 * - 'reconstruct-limit': the body is longer than MAX_SOURCE_LENGTH (nothing
 *   rebuilt) or MAX_RECONSTRUCTED messages were rebuilt (there may be more).
 */
export type ReconstructionWarningCode = 'reconstruct-failed' | 'reconstruct-limit';

export interface ReconstructionWarning {
  /** Input position of the kept message (EngineMessage.index). */
  readonly index: number;
  readonly code: ReconstructionWarningCode;
}

/** Something the engine itself had to work around for one message. */
export type EngineWarningCode =
  // A fold detector threw an error for this message; its folds were skipped
  // (the other detectors' folds still apply).
  | 'detector-failed'
  // The folds could not be turned into a valid cover of the body (or building
  // the segments threw), so all of them were dropped and the whole body is
  // shown unfolded.
  | 'folding-disabled'
  // De-duplication threw or returned an inconsistent result, so no message
  // was merged (every message is kept on its own).
  | 'dedupe-failed';

/** One kept message, ready for the preview. */
export interface EngineMessage {
  /** The kept copy, unchanged (same object as in the input). */
  readonly message: NormalizedMessage;
  /** Its position in the input of `runEngine`. */
  readonly index: number;
  /**
   * Placed by its date; or, date missing or unusable, after all dated
   * messages by file order, or (an attached email) just before the email it
   * is attached to ('before-parent').
   */
  readonly order: OrderReason;
  /** Merged copies (see dedupe.ts), `index` = position in the input of `runEngine`. */
  readonly duplicates: readonly MergedCopy[];
  /** Why look-alike messages were NOT merged (see dedupe.ts), `related` = input positions. */
  readonly dedupeWarnings: readonly DedupeWarning[];
  /** The parser's warnings (same array as `message.warnings`), here for convenience. */
  readonly parserWarnings: readonly ParseWarning[];
  /** See EngineWarningCode; sorted, unique; usually empty. */
  readonly engineWarnings: readonly EngineWarningCode[];
  /** Cover of `message.bodyText`, shown or folded (see segments.ts). [] for an empty body. */
  readonly segments: readonly Segment[];
}

/** A file that could not be read. */
export interface FailedFile {
  /** Its position in the input of `runEngine`. */
  readonly index: number;
  readonly fileName: string;
  readonly sha256: string | null;
  readonly error: ParseErrorCode;
  readonly detail: string;
}

/** The numbers the preview shows. */
export interface EngineCounts {
  /** Every file given to the engine, read or failed (preview: "N files, M could not be read"). */
  readonly filesGiven: number;
  /** Messages read successfully, duplicates and attached emails (task 8.13b-3) included. */
  readonly messagesFound: number;
  /** Copies merged into another message (messagesFound - messages.length). */
  readonly duplicatesMerged: number;
  /** Files that could not be read (listed in `failed`). */
  readonly filesFailed: number;
  /** Kept messages with no usable date (placed by file order, or before their parent). */
  readonly undated: number;
  /** Kept messages with at least one folded segment. */
  readonly withFolds: number;
}

/** The whole engine output: plain, structured-clone-safe data. */
export interface EngineResult {
  /** Kept messages, in chronological order. */
  readonly messages: readonly EngineMessage[];
  /** Failed files, in input order. */
  readonly failed: readonly FailedFile[];
  readonly counts: EngineCounts;
  /**
   * For each input position: the position in `messages` of the kept message
   * that holds it (the message itself, or the one it was merged into); null
   * for a failed file. Use it to resolve `index` and `related` numbers.
   */
  readonly positionByIndex: readonly (number | null)[];
  /**
   * Messages rebuilt from quoted text (step 6), by source (in `messages`
   * order), newest first; each says whether it is linked to a real message,
   * the same as another rebuilt one, or its own timeline entry. The preview
   * shows the entries (src/ui-model/rebuilt.ts), and so does the PDF
   * (src/pdf/model.ts, the ones the reader chose).
   */
  readonly reconstructed: readonly EngineRebuilt[];
  /** Every kept message (each once, in `messages` order) and every rebuilt entry, in time order (rebuild-links.ts). */
  readonly timeline: readonly TimelineEntry[];
  /** Problems while rebuilding, in `messages` order. Usually empty. */
  readonly reconstructionWarnings: readonly ReconstructionWarning[];
  /**
   * Every email attached inside a dropped file that the engine read as a
   * message of its own (task 8.13b-3), by input position: entry k has
   * index `counts.filesGiven + k`. No key at all when there are none, so
   * the result for files without attached emails is what it always was.
   */
  readonly attached?: readonly EngineAttached[];
}

/** Where one attached email's printed block sits in the body of an email holding it (AttachedPlace, with input positions). */
export interface EngineAttachedPlace {
  /**
   * Input position of the email whose bodyText holds the block: its parent,
   * or the parent's parent, ...; or, when that one was merged into another
   * copy (dedupe.ts), the kept copy, with the offsets found again in its
   * body (task 8.13b-3, review round 4, S1: settleAttached). When they
   * cannot be found for certain there, the place stays on the merged copy
   * (then no kept message has this index, and the PDF leaves the kept
   * body as its plan says).
   */
  readonly holderIndex: number;
  /** `bodyText.slice(start, end)` of the message at `holderIndex` (that very message object) is the whole block. */
  readonly start: number;
  readonly end: number;
}

/** One email attached inside a dropped file (ParseResult.attached), as the engine numbers it. */
export interface EngineAttached {
  /** Its input position (see Indices at the top). */
  readonly index: number;
  /** Input position of the email it is attached to: its file's own email, or another attached email of that file. */
  readonly parentIndex: number;
  /** Input position of the dropped file it came from (that file's own email). */
  readonly fileIndex: number;
  /** AttachedMessage.path: its attachment number at each level, from the file's own email down. */
  readonly path: readonly number[];
  /** The attachment name at each level of `path` (AttachedMessage.name of it and of each attached email above it), '' when none. */
  readonly names: readonly string[];
  /** AttachedMessage.places that are valid ranges of their holder's body, nearest holder first; [] when its text is in no body. */
  readonly places: readonly EngineAttachedPlace[];
  /**
   * Whether the header rows of the kept copy holding it show every header
   * datum its own copy has: true when it is kept itself, or when the copy it
   * was merged into keeps its header data with the same date (dedupe.ts,
   * keepsHeaderData). False when a dropped file's copy was kept although
   * this copy held more (a Bcc line, a date: D2, task 8.13b-3 review round
   * 4); then its block's header lines stay printed in the emails holding it.
   */
  readonly keptShowsHeader: boolean;
}

/** The EngineAttached entry of input position `index`, or undefined (a file's own email, or no such entry). */
export function attachedAt(result: Pick<EngineResult, 'attached' | 'counts'>, index: number): EngineAttached | undefined {
  const entry = result.attached?.[index - result.counts.filesGiven];
  return entry !== undefined && entry.index === index ? entry : undefined;
}

/**
 * The replaceable parts of the pipeline. TESTS ONLY: the app always uses
 * DEFAULT_PARTS. Tests swap in a broken part to prove the safety net works,
 * and use `onStage` to time each stage (the engine itself reads no clock).
 */
export interface EngineParts {
  readonly detectQuotedOverlap: typeof detectQuotedOverlap;
  readonly detectQuoteMarkers: typeof detectQuoteMarkers;
  readonly detectReplyHeaders: typeof detectReplyHeaders;
  readonly detectSignatures: typeof detectSignatures;
  readonly buildSegments: typeof buildSegments;
  /** Optional, default: dedupe.ts. */
  readonly dedupe?: typeof dedupe;
  /** Optional, default: reconstruct.ts. */
  readonly reconstructQuotedMessages?: typeof reconstructQuotedMessages;
  /** Optional, default: rebuild-links.ts. */
  readonly linkRebuilt?: typeof linkRebuilt;
  /** Called when a stage starts ('dedupe', 'order', ...) and with 'done' at the end. */
  readonly onStage?: (stage: EngineStage) => void;
}

export type EngineStage =
  | 'dedupe'
  | 'order'
  | 'overlap'
  | 'quote-markers'
  | 'reply-headers'
  | 'signatures'
  | 'segments'
  | 'reconstruct'
  | 'link-rebuilt'
  | 'done';

export const DEFAULT_PARTS: EngineParts = Object.freeze({
  detectQuotedOverlap,
  detectQuoteMarkers,
  detectReplyHeaders,
  detectSignatures,
  buildSegments,
});

/**
 * The reason to show as a folded part's label when several detectors folded
 * it. Most specific first:
 * - 'signature' wins: overlap.ts also folds a signature the sender repeats in
 *   every message (as 'quoted-overlap', because it matches their earlier
 *   messages), but "signature" is what the reader should see;
 * - 'reply-header' and 'quote-marker' describe what the text looks like;
 * - 'quoted-overlap' is the generic one (its `related` link still says which
 *   message the text came from).
 * null when there is no reason (a shown segment).
 */
export function primaryReason(reasons: readonly FoldReason[]): FoldReason | null {
  for (const r of LABEL_PRECEDENCE) if (reasons.includes(r)) return r;
  return null;
}

const LABEL_PRECEDENCE: readonly FoldReason[] = ['signature', 'reply-header', 'quote-marker', 'quoted-overlap'];

/** A kept message while the pipeline runs. */
interface Work {
  readonly message: NormalizedMessage;
  readonly index: number;
  readonly order: OrderReason;
  readonly duplicates: readonly MergedCopy[];
  readonly dedupeWarnings: readonly DedupeWarning[];
  readonly folds: FoldRange[];
  readonly warnings: Set<EngineWarningCode>;
}

/** Runs `detect`; if it throws, marks every message in `targets` and returns null. */
function guarded<T>(targets: readonly Work[], detect: () => T): T | null {
  try {
    return detect();
  } catch {
    for (const w of targets) w.warnings.add('detector-failed');
    return null;
  }
}

/** A runtime check of one fold entry: an object (buildSegments then ignores a bad range in it). */
function isFoldObject(f: unknown): f is FoldRange {
  return typeof f === 'object' && f !== null;
}

/**
 * Adds the folds of `result` (one list per message, or null after a throw) to
 * each message. Runtime guards against a buggy detector: a result that is not
 * an array marks every message 'detector-failed'; an entry that is not an
 * array marks that message; folds that are not objects are ignored. Appended
 * one by one: a spread into push overflows the stack for very long lists.
 */
function addFolds(work: readonly Work[], result: unknown): void {
  if (result === null) return; // the detector threw; guarded() already warned
  if (!Array.isArray(result)) {
    for (const w of work) w.warnings.add('detector-failed');
    return;
  }
  const lists: readonly unknown[] = result;
  work.forEach((w, k) => {
    const folds = lists[k];
    if (!Array.isArray(folds)) {
      w.warnings.add('detector-failed');
      return;
    }
    for (const f of folds as readonly unknown[]) if (isFoldObject(f)) w.folds.push(f);
  });
}

/**
 * Runs one per-message detector for `w` and adds its folds; returns the
 * smallest valid fold start (for `ownTextEnd`), or the body length if none.
 * Everything, including reading the folds (a getter could throw), happens
 * inside guarded(), and nothing is added unless the whole list was read.
 */
function addMessageFolds(w: Work, detect: () => unknown): number {
  const length = w.message.bodyText.length;
  const outcome = guarded([w], () => {
    const result = detect();
    if (!Array.isArray(result)) return null;
    const folds: FoldRange[] = [];
    let firstStart = length;
    for (const f of result as readonly unknown[]) {
      if (!isFoldObject(f)) continue;
      const start: unknown = f.start;
      if (typeof start === 'number' && Number.isInteger(start) && start >= 0 && start < firstStart) firstStart = start;
      folds.push(f);
    }
    return { folds, firstStart };
  });
  if (outcome === null) {
    // Threw (already warned) or not a list: warn in both cases (a Set, so once).
    w.warnings.add('detector-failed');
    return length;
  }
  for (const f of outcome.folds) w.folds.push(f);
  return outcome.firstStart;
}

/**
 * True if `result` is a consistent de-duplication of `messages`: every
 * position 0..count-1 appears exactly once (kept or merged), each kept entry
 * carries the very message object at its position and each merged copy that
 * message's source, every `related` number is a valid position, and
 * mergedCount matches. Every list must be a real array (the caller maps them).
 */
function isValidDedupe(result: DedupeResult, messages: readonly NormalizedMessage[]): boolean {
  const count = messages.length;
  const seen = new Uint8Array(count);
  const valid = (i: unknown): i is number => typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < count;
  const mark = (i: unknown): boolean => {
    if (!valid(i) || seen[i] === 1) return false;
    seen[i] = 1;
    return true;
  };
  // A plain boolean check: Array.isArray as a type guard would turn the lists into any[].
  const isList = (v: unknown): boolean => Array.isArray(v);
  if (!isList(result.kept)) return false;
  let merged = 0;
  for (const k of result.kept) {
    if (!mark(k.index)) return false;
    if (k.message !== messages[k.index]) return false;
    if (!isList(k.duplicates) || !isList(k.warnings)) return false;
    for (const d of k.duplicates) {
      if (!mark(d.index)) return false;
      if (d.source !== messages[d.index]!.source) return false;
      merged++;
    }
    for (const w of k.warnings) {
      if (!isList(w.related)) return false;
      for (const r of w.related) if (!valid(r)) return false;
    }
  }
  return merged === result.mergedCount && result.kept.length + merged === count;
}

/** Every message kept on its own (the fallback when de-duplication fails). */
function noDedupe(messages: readonly NormalizedMessage[]): DedupeResult {
  return { kept: messages.map((message, index) => ({ message, index, duplicates: [], warnings: [] })), mergedCount: 0 };
}

/** One segment showing the whole body (or none for an empty body). */
function wholeBody(body: string): Segment[] {
  return body.length === 0 ? [] : [{ start: 0, end: body.length, folded: false, reasons: [], related: [] }];
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isNumOrNull = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isFinite(v));
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

/** A plain copy of a mailbox list, or null if it is not one. */
function mailboxes(v: unknown): ReconstructedMessage['from'] | null {
  if (!Array.isArray(v)) return null;
  const out: { name: string; address: string }[] = [];
  for (const m of v as readonly unknown[]) {
    if (typeof m !== 'object' || m === null) return null;
    const { name, address } = m as Record<string, unknown>;
    if (typeof name !== 'string' || typeof address !== 'string') return null;
    out.push({ name, address });
  }
  return out;
}

/**
 * A plain copy of one rebuilt message, or null if it breaks the contract of
 * reconstruct.ts: offsets inside the body, in order, after `minStart`;
 * `generation` = its rank; and its text exactly the body slice
 * [headerEnd, end) with `depth` quote marks removed (checked by recomputing
 * it). The engine never trusts the part blindly (README.md, rule R6).
 */
function validRebuilt(body: string, v: unknown, minStart: number, generation: number): ReconstructedMessage | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  const { start, headerEnd, end, depth, kind, subject, dateText, date, dateApproximate, reconstructedText, quoteMarksRemoved } = r;
  if (!isInt(start) || !isInt(headerEnd) || !isInt(end) || !isInt(depth)) return null;
  if (start < minStart || headerEnd <= start || end < headerEnd || end > body.length) return null;
  if (r.generation !== generation || depth < 0 || depth > MAX_QUOTE_DEPTH) return null;
  if ((kind !== 'reply' && kind !== 'forward') || !isStrOrNull(subject) || !isStrOrNull(dateText)) return null;
  if (typeof dateApproximate !== 'boolean' || quoteMarksRemoved !== depth > 0 || typeof reconstructedText !== 'string') return null;
  const from = mailboxes(r.from);
  const to = mailboxes(r.to);
  const cc = mailboxes(r.cc);
  if (from === null || to === null || cc === null || !Array.isArray(r.incomplete)) return null;
  const incomplete = (r.incomplete as readonly unknown[]).filter((x): x is 'to' | 'cc' => x === 'to' || x === 'cc');
  if (incomplete.length !== r.incomplete.length) return null;
  let quotedDate: ReconstructedMessage['date'] = null;
  if (date !== null) {
    if (typeof date !== 'object') return null;
    const d = date as Record<string, unknown>;
    const basis = d.basis;
    if (typeof d.text !== 'string' || !isNumOrNull(d.wallMs) || !isNumOrNull(d.estimatedUtcMs)) return null;
    if (d.precision !== 'minute' && d.precision !== 'day' && d.precision !== null) return null;
    if (basis !== 'rfc-zone' && basis !== 'written-zone' && basis !== 'source-offset' && basis !== 'none') return null;
    quotedDate = { text: d.text, wallMs: d.wallMs, precision: d.precision, estimatedUtcMs: d.estimatedUtcMs, basis };
  }
  if (reconstructedText !== removeQuoteMarks(body, headerEnd, end, depth)) return null;
  return {
    start,
    headerEnd,
    end,
    depth,
    generation,
    kind,
    from,
    to,
    cc,
    subject,
    dateText,
    incomplete,
    date: quotedDate,
    dateApproximate,
    reconstructedText,
    quoteMarksRemoved,
  };
}

/** Rebuilds from one message (step 6), with the safety net; adds its warnings to `warnings`. */
function rebuildFrom(
  w: { readonly message: NormalizedMessage; readonly index: number },
  rebuild: typeof reconstructQuotedMessages,
  warnings: ReconstructionWarning[],
): ReconstructedMessage[] {
  const body = w.message.bodyText;
  if (body.length > MAX_SOURCE_LENGTH) {
    warnings.push({ index: w.index, code: 'reconstruct-limit' });
    return [];
  }
  let raw: unknown;
  try {
    raw = rebuild(body, { subject: w.message.subject, sourceOffsetMinutes: w.message.date.offsetMinutes });
  } catch {
    warnings.push({ index: w.index, code: 'reconstruct-failed' });
    return [];
  }
  const out: ReconstructedMessage[] = [];
  let ok = Array.isArray(raw) && raw.length <= MAX_RECONSTRUCTED;
  if (ok) {
    try {
      let minStart = 0;
      for (const v of raw as readonly unknown[]) {
        const r = validRebuilt(body, v, minStart, out.length + 1);
        if (r === null) {
          ok = false;
          break;
        }
        out.push(r);
        minStart = r.end;
      }
    } catch {
      ok = false; // a getter that throws
    }
  }
  if (!ok) {
    // Keep nothing: a later entry being wrong casts doubt on the chain.
    warnings.push({ index: w.index, code: 'reconstruct-failed' });
    return [];
  }
  if (out.length >= MAX_RECONSTRUCTED) warnings.push({ index: w.index, code: 'reconstruct-limit' });
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * The attached emails of every successful result (step 1), checked, with
 * their input positions (from `results.length` on). An entry is skipped,
 * with every entry attached inside it, when it breaks ParseResult's
 * contract (not an object, no message with a text, a parent that is not an
 * earlier entry kept here, a path that is not its parent's path plus one
 * number); a place that is not a range of its holder's text, or whose holder
 * is not the next email up, is dropped (its block then stays printed in that
 * body). A result whose list cannot be read at all gives none. Never throws.
 */
function readAttached(results: readonly ParseResult[]): { readonly messages: NormalizedMessage[]; readonly entries: EngineAttached[] } {
  const messages: NormalizedMessage[] = [];
  const entries: EngineAttached[] = [];
  const base = results.length;
  results.forEach((r, fileIndex) => {
    if (!r.ok || r.attached === undefined) return;
    const fileMessages: NormalizedMessage[] = [];
    const fileEntries: EngineAttached[] = [];
    try {
      const list: unknown = r.attached;
      if (!Array.isArray(list)) return;
      // Per entry of the file's list: its place in fileEntries (undefined when
      // skipped), and its parent in the file's numbering (-1: the file's own email).
      const kept: (number | undefined)[] = [];
      const parents: number[] = [];
      const entryOf = (k: number): EngineAttached | undefined => fileEntries[kept[k] ?? -1];
      // The body text of entry `holder` of the file's list (-1: the file's own email); undefined when skipped.
      const bodyOf = (holder: number): string | undefined => {
        if (holder === -1) return r.message.bodyText;
        const at = kept[holder];
        return at === undefined ? undefined : fileMessages[at]?.bodyText;
      };
      (list as readonly unknown[]).forEach((raw, k) => {
        kept.push(undefined);
        parents.push(-1);
        if (!isRecord(raw) || !isRecord(raw.message) || typeof raw.message.bodyText !== 'string') return;
        const { parent, path, places, name } = raw;
        if (!isInt(parent) || parent < -1 || parent >= k) return;
        const parentEntry = parent === -1 ? null : entryOf(parent);
        if (parentEntry === undefined) return; // its parent was skipped
        const parentPath = parentEntry?.path ?? [];
        if (!Array.isArray(path) || path.length !== parentPath.length + 1) return;
        const ownPath = (path as readonly unknown[]).filter(isInt);
        if (ownPath.length !== path.length || ownPath.some((n, i) => n < 1 || (i < parentPath.length && n !== parentPath[i]))) return;
        const index = base + entries.length + fileEntries.length;
        // Places: nearest holder first (its parent, then the parent's parent, ...); stop at the first one out of line.
        const okPlaces: EngineAttachedPlace[] = [];
        let holder = parent;
        for (const p of Array.isArray(places) ? (places as readonly unknown[]) : []) {
          if (!isRecord(p) || p.holder !== holder) break;
          const holderEntry = holder === -1 ? null : entryOf(holder);
          const body = bodyOf(holder);
          const { start, end } = p;
          if (holderEntry !== undefined && typeof body === 'string' && isInt(start) && isInt(end) && start >= 0 && start < end && end <= body.length) {
            okPlaces.push({ holderIndex: holderEntry === null ? fileIndex : holderEntry.index, start, end });
          }
          if (holder === -1) break;
          holder = parents[holder] ?? -1;
        }
        kept[k] = fileEntries.length;
        parents[k] = parent;
        fileMessages.push(raw.message as unknown as NormalizedMessage);
        fileEntries.push({
          index,
          parentIndex: parentEntry === null ? fileIndex : parentEntry.index,
          fileIndex,
          path: ownPath,
          names: [...(parentEntry?.names ?? []), typeof name === 'string' ? name : ''],
          places: okPlaces,
          // Known once de-duplication ran (settleAttached).
          keptShowsHeader: true,
        });
      });
    } catch {
      return; // a list that cannot be read: none of this file's attached emails
    }
    for (const m of fileMessages) messages.push(m);
    for (const e of fileEntries) entries.push(e);
  });
  return { messages, entries };
}

/**
 * After de-duplication (task 8.13b-3, review round 4): the attached entries
 * as the result gives them. `parsed[k]` is the message at input position
 * `inputPosition[k]`; `keptIndexOf` gives the kept copy of an input position.
 * - S1: a place whose holder was merged into another copy is moved to that
 *   kept copy, its offsets found again in the kept body (mapOffsets: the two
 *   bodies are equal as normalizeBody compares them), so the PDF's
 *   no-repeat rule can still leave the block out there (an unticked
 *   attached email is then never printed inside any copy of its holder).
 *   When the offsets cannot be found for certain, the place stays as it was.
 * - keptShowsHeader (D2): whether the kept copy holding it shows all of its
 *   header data (dedupe.ts, keepsHeaderData).
 * Never throws: an entry it cannot settle is given as it was, with
 * keptShowsHeader false (its header lines then stay where they are printed).
 */
function settleAttached(
  read: { readonly messages: readonly NormalizedMessage[]; readonly entries: readonly EngineAttached[] },
  parsed: readonly NormalizedMessage[],
  inputPosition: readonly number[],
  keptIndexOf: (index: number) => number | undefined,
): EngineAttached[] {
  const messageAt = new Map<number, NormalizedMessage>();
  inputPosition.forEach((index, k) => {
    const m = parsed[k];
    if (m !== undefined) messageAt.set(index, m);
  });
  return read.entries.map((e) => {
    try {
      const own = messageAt.get(e.index);
      const keptIndex = keptIndexOf(e.index);
      const kept = keptIndex === undefined ? undefined : messageAt.get(keptIndex);
      const keptShowsHeader = keptIndex === e.index || (own !== undefined && kept !== undefined && keepsHeaderData(kept, own));
      const places = e.places.map((p): EngineAttachedPlace => {
        const holderKept = keptIndexOf(p.holderIndex);
        if (holderKept === undefined || holderKept === p.holderIndex) return p;
        const from = messageAt.get(p.holderIndex)?.bodyText;
        const to = messageAt.get(holderKept)?.bodyText;
        if (typeof from !== 'string' || typeof to !== 'string') return p;
        const mapped = mapOffsets(from, to, [p.start, p.end]);
        if (mapped === null) return p;
        const [start, end] = mapped as [number, number];
        return start < end ? { holderIndex: holderKept, start, end } : p;
      });
      return { ...e, places, keptShowsHeader };
    } catch {
      return { ...e, keptShowsHeader: false };
    }
  });
}

/**
 * Step 3, Q7 (user decision 2026-11-10, task 8.13b-3): every attached email
 * with no usable date (orderMessages put it at the end, 'file-order') moves
 * to just before the kept email holding its parent (the parent itself, or
 * the copy it was merged into), with order 'before-parent'; several before
 * one email keep their input order, and one attached inside it comes before
 * it in turn. Left at the end, as 'file-order': one whose parent is not
 * there, or whose chain of parents leads back to itself through merged
 * copies, or leads INTO such a cycle further up without coming back to
 * itself (both not expected). Those are dropped from the moves only: they
 * stay where orderMessages put them (at the end, in file order), with all
 * their content, in the list exactly once. Every entry is kept exactly
 * once.
 */
function placeUndatedAttached<T extends { readonly index: number }>(
  ordered: readonly { readonly item: T; readonly order: OrderReason }[],
  parentOf: (index: number) => number | undefined,
  keptIndexOf: (index: number) => number | undefined,
): { readonly item: T; readonly order: OrderReason }[] {
  const at = new Map<number, number>();
  ordered.forEach((e, i) => at.set(e.item.index, i));
  // Entry -> the entry it goes before.
  const before = new Map<number, number>();
  ordered.forEach((e, i) => {
    if (e.order !== 'file-order') return;
    const parent = parentOf(e.item.index);
    if (parent === undefined) return;
    const kept = keptIndexOf(parent);
    const j = kept === undefined ? undefined : at.get(kept);
    if (j !== undefined && j !== i) before.set(i, j);
  });
  if (before.size === 0) return [...ordered];
  // Cycles (not expected): an entry whose chain comes back to itself, or leads INTO such a cycle
  // further on, is dropped from the map. It then stays where orderMessages put it (at the end,
  // 'file-order') and, as a root of the walk below, is still listed exactly once there.
  for (const i of [...before.keys()]) {
    const seen = new Set<number>([i]);
    let j = before.get(i);
    while (j !== undefined && before.has(j) && !seen.has(j)) {
      seen.add(j);
      j = before.get(j);
    }
    if (j !== undefined && seen.has(j)) before.delete(i);
  }
  const children = new Map<number, number[]>();
  for (const [i, j] of before) {
    let list = children.get(j);
    if (list === undefined) children.set(j, (list = []));
    list.push(i);
  }
  for (const list of children.values()) list.sort((a, b) => a - b);
  const out: { readonly item: T; readonly order: OrderReason }[] = [];
  // Iterative: an entry's children first (each with its own children first), then the entry.
  for (let root = 0; root < ordered.length; root++) {
    if (before.has(root)) continue;
    const stack: { i: number; next: number }[] = [{ i: root, next: 0 }];
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const kids = children.get(top.i) ?? [];
      if (top.next < kids.length) {
        stack.push({ i: kids[top.next++]!, next: 0 });
        continue;
      }
      stack.pop();
      const e = ordered[top.i]!;
      out.push(before.has(top.i) ? { item: e.item, order: 'before-parent' } : e);
    }
  }
  return out;
}

/**
 * Step 4a (task 8.13b-3, review round 2): per kept message (its input
 * position), the input positions of the kept messages it HOLDS: for every
 * attached email, the kept copy of each email above it (its parent, the
 * parent's parent, ... up to its file's own email) holds the kept copy of
 * it. Mapped through `keptIndexOf` (merged copies), so the copy an attached
 * email was merged into, a dropped file say, is held too. A copy never holds
 * itself. The walk up stops at an email it has seen (not expected: parents
 * are always earlier entries). No entry for a message that holds none.
 */
function heldByKept(
  entries: readonly EngineAttached[],
  byIndex: ReadonlyMap<number, EngineAttached>,
  keptIndexOf: (index: number) => number | undefined,
): Map<number, Set<number>> {
  const out = new Map<number, Set<number>>();
  for (const e of entries) {
    const held = keptIndexOf(e.index);
    if (held === undefined) continue;
    const seen = new Set<number>([e.index]);
    let up: number | undefined = e.parentIndex;
    while (up !== undefined && !seen.has(up)) {
      seen.add(up);
      const holder = keptIndexOf(up);
      if (holder !== undefined && holder !== held) {
        let set = out.get(holder);
        if (set === undefined) out.set(holder, (set = new Set<number>()));
        set.add(held);
      }
      up = byIndex.get(up)?.parentIndex;
    }
  }
  return out;
}

/**
 * Runs the whole engine (see the steps at the top of this file).
 * `results`: one parse result per dropped file, in drop order.
 * `parts`: tests only (see EngineParts).
 */
export function runEngine(results: readonly ParseResult[], parts: EngineParts = DEFAULT_PARTS): EngineResult {
  // 1. Split. `inputPosition[i]` = input position of the i-th parsed message.
  const parsed: NormalizedMessage[] = [];
  const inputPosition: number[] = [];
  const failed: FailedFile[] = [];
  results.forEach((r, index) => {
    if (r.ok) {
      parsed.push(r.message);
      inputPosition.push(index);
    } else {
      failed.push({ index, fileName: r.fileName, sha256: r.sha256, error: r.error, detail: r.detail });
    }
  });
  // The attached emails, after every file's own email (see ATTACHED EMAILS at the top).
  const firstAttached = parsed.length;
  const read = readAttached(results);
  read.messages.forEach((m, k) => {
    parsed.push(m);
    inputPosition.push(read.entries[k]!.index);
  });
  const attachedByIndex = new Map<number, EngineAttached>();
  for (const e of read.entries) attachedByIndex.set(e.index, e);
  const inputCount = results.length + read.entries.length;

  // 2. De-duplicate (checked by isValidDedupe; the fallback merges nothing).
  // A dropped file's copy always wins over an attached one (D2, dedupe.ts).
  parts.onStage?.('dedupe');
  let deduped: DedupeResult;
  let dedupeFailed = false;
  try {
    deduped = (parts.dedupe ?? dedupe)(parsed, { firstAttached });
    if (!isValidDedupe(deduped, parsed)) throw new Error('invalid dedupe result');
  } catch {
    deduped = noDedupe(parsed);
    dedupeFailed = true;
  }
  // dedupe numbers messages by their place in `parsed`; the result uses input
  // positions. isValidDedupe checked that every number passed here is in
  // 0..parsed.length-1, and inputPosition has exactly parsed.length entries,
  // so the lookup always hits. The `?? -1` is only for the type checker; if it
  // ever happened, -1 is never a valid position, so it could not silently
  // point at another file.
  const toInput = (i: number): number => inputPosition[i] ?? -1;
  const kept = deduped.kept.map((k) => ({
    message: k.message,
    index: toInput(k.index),
    duplicates: k.duplicates.map((d) => ({ ...d, index: toInput(d.index) })),
    dedupeWarnings: k.warnings.map((w) => ({ ...w, related: w.related.map(toInput) })),
  }));

  // 3. Order (undated attached emails just before their parent, Q7).
  parts.onStage?.('order');
  const keptOf = new Map<number, number>(); // input position -> input position of the kept message holding it
  for (const k of kept) {
    keptOf.set(k.index, k.index);
    for (const d of k.duplicates) keptOf.set(d.index, k.index);
  }
  const attached = settleAttached(read, parsed, inputPosition, (index) => keptOf.get(index));
  const ordered = placeUndatedAttached(
    orderMessages(kept),
    (index) => attachedByIndex.get(index)?.parentIndex,
    (index) => keptOf.get(index),
  );
  const work: Work[] = ordered.map(({ item, order }) => ({
    ...item,
    order,
    folds: [],
    warnings: new Set<EngineWarningCode>(dedupeFailed ? ['dedupe-failed'] : []),
  }));

  // 4a. Overlap, over the ordered set (it needs chronological order). A holder
  // always quotes the emails it holds (heldByKept), so their text is never
  // folded as quoted from it.
  parts.onStage?.('overlap');
  const holds = heldByKept(attached, attachedByIndex, (index) => keptOf.get(index));
  addFolds(
    work,
    guarded(work, () =>
      parts.detectQuotedOverlap(
        work.map((w) => {
          const held = holds.get(w.index);
          return {
            bodyText: w.message.bodyText,
            messageId: w.message.messageId,
            inReplyTo: w.message.inReplyTo,
            references: w.message.references,
            index: w.index,
            ...(held === undefined ? {} : { holds: [...held] }),
          };
        }),
      ),
    ),
  );

  // 4b. Per-message detectors. Their fold starts also give `ownTextEnd` for 4c.
  parts.onStage?.('quote-markers');
  const ownTextEnd = work.map((w) => addMessageFolds(w, () => parts.detectQuoteMarkers(w.message.bodyText)));
  parts.onStage?.('reply-headers');
  work.forEach((w, k) => {
    const first = addMessageFolds(w, () => parts.detectReplyHeaders(w.message.bodyText, w.message.subject));
    ownTextEnd[k] = Math.min(ownTextEnd[k] ?? first, first);
  });

  // 4c. Signatures (overlap folds deliberately not part of ownTextEnd, see the top).
  parts.onStage?.('signatures');
  addFolds(
    work,
    guarded(work, () =>
      parts.detectSignatures(
        work.map((w, k) => ({ bodyText: w.message.bodyText, senderKey: senderKeyOf(w.message), ownTextEnd: ownTextEnd[k] })),
      ),
    ),
  );

  // 5. Segments, with the safety net.
  parts.onStage?.('segments');
  const messages: EngineMessage[] = work.map((w) => {
    const body = w.message.bodyText;
    let segments: Segment[];
    try {
      segments = parts.buildSegments(body, w.folds);
      // Both checks: checkSegments looks at the shape, reconstruct at the text itself.
      if (checkSegments(body, segments).length > 0 || reconstruct(body, segments) !== body) throw new Error('invalid segments');
    } catch {
      segments = wholeBody(body);
      w.warnings.add('folding-disabled');
    }
    return {
      message: w.message,
      index: w.index,
      order: w.order,
      duplicates: w.duplicates,
      dedupeWarnings: w.dedupeWarnings,
      parserWarnings: w.message.warnings,
      engineWarnings: [...w.warnings].sort(),
      segments,
    };
  });

  const positionByIndex: (number | null)[] = new Array<number | null>(inputCount).fill(null);
  messages.forEach((m, position) => {
    positionByIndex[m.index] = position;
    for (const d of m.duplicates) positionByIndex[d.index] = position;
  });

  // 6. Rebuild, link, timeline (the real messages above are final already).
  parts.onStage?.('reconstruct');
  const reconstructionWarnings: ReconstructionWarning[] = [];
  const rebuild = parts.reconstructQuotedMessages ?? reconstructQuotedMessages;
  const sources: LinkSource[] = work.map((w, k) => {
    const rebuilt = rebuildFrom(w, rebuild, reconstructionWarnings);
    // Its own text ends at its first quoted part: the first rebuilt message, or the first quote fold.
    const ownEnd = Math.min(rebuilt[0]?.start ?? w.message.bodyText.length, ownTextEnd[k] ?? w.message.bodyText.length);
    return { index: w.index, message: w.message, utcMs: w.order === 'by-date' ? w.message.date.utcMs : null, ownEnd, rebuilt };
  });
  parts.onStage?.('link-rebuilt');
  let reconstructed: readonly EngineRebuilt[];
  let timeline: readonly TimelineEntry[];
  try {
    ({ reconstructed, timeline } = (parts.linkRebuilt ?? linkRebuilt)(sources));
    if (!isValidTimeline(timeline, reconstructed, messages.length)) throw new Error('invalid timeline');
  } catch {
    reconstructed = [];
    timeline = messages.map((_, position) => ({ kind: 'message', position }));
    reconstructionWarnings.length = 0;
    for (const w of work) reconstructionWarnings.push({ index: w.index, code: 'reconstruct-failed' });
  }

  parts.onStage?.('done');
  return {
    messages,
    failed,
    counts: {
      filesGiven: results.length,
      messagesFound: parsed.length,
      duplicatesMerged: deduped.mergedCount,
      filesFailed: failed.length,
      undated: messages.filter((m) => m.order !== 'by-date').length,
      withFolds: messages.filter((m) => m.segments.some((s) => s.folded)).length,
    },
    positionByIndex,
    reconstructed,
    timeline,
    reconstructionWarnings,
    // No key when there are none: the result for files without attached emails is unchanged.
    ...(attached.length === 0 ? {} : { attached }),
  };
}

/**
 * True if the timeline holds every message position 0..count-1 exactly once,
 * in order, and exactly the rebuilt entries with link 'entry', once each,
 * and the reconstructed list is numbered by position. Guards the rule that
 * linking never removes or reorders a real message. Called inside a try: an
 * entry that is not an object throws, which counts as invalid.
 */
function isValidTimeline(timeline: readonly TimelineEntry[], reconstructed: readonly EngineRebuilt[], count: number): boolean {
  // A plain boolean check: Array.isArray as a type guard would turn the lists into any[].
  const isList = (v: unknown): boolean => Array.isArray(v);
  if (!isList(timeline) || !isList(reconstructed)) return false;
  if (!reconstructed.every((r, id) => r.id === id)) return false;
  let next = 0;
  const seen = new Set<number>();
  for (const e of timeline) {
    if (e.kind === 'message') {
      if (e.position !== next) return false;
      next++;
    } else {
      if (e.kind !== 'rebuilt' || seen.has(e.id) || reconstructed[e.id]?.link !== 'entry') return false;
      seen.add(e.id);
    }
  }
  return next === count && seen.size === reconstructed.filter((r) => r.link === 'entry').length;
}
