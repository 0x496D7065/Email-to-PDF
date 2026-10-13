// The engine pipeline: from parsed files to the ordered, folded messages the
// preview and the PDF will show (README.md, rules R6 and R7).
//
// Steps:
// 1. Split the parse results into messages and failed files. A failed file
//    is listed with its reason and never stops the others.
// 2. De-duplicate (dedupe.ts): only provably identical copies are merged,
//    and every merged copy stays listed next to its kept message.
// 3. Order chronologically (order.ts).
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
//
// Indices: every `index` and `related` number in the result (EngineMessage.index,
// MergedCopy.index, DedupeWarning.related, Segment.related) is a position in
// the array given to `runEngine`, i.e. the order the files were dropped in.
// `positionByIndex` turns such a number into a position in `messages`, so the
// preview can resolve "quoted from message N" or "duplicate of ..." directly.
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
// not merged. Long lists are appended with loops, never spread into a call
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
import { dedupe, type DedupeResult, type DedupeWarning, type MergedCopy } from './dedupe';
import { orderMessages, type OrderReason } from './order';
import { detectQuotedOverlap } from './overlap';
import { detectQuoteMarkers } from './quote-markers';
import { detectReplyHeaders } from './reply-header';
import { buildSegments, checkSegments, reconstruct, type FoldRange, type FoldReason, type Segment } from './segments';
import { detectSignatures, senderKeyOf } from './signature';

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
  /** Placed by its date, or after all dated messages by file order (date missing or unusable). */
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
  /** Messages read successfully, duplicates included. */
  readonly messagesFound: number;
  /** Copies merged into another message (messagesFound - messages.length). */
  readonly duplicatesMerged: number;
  /** Files that could not be read (listed in `failed`). */
  readonly filesFailed: number;
  /** Kept messages placed by file order (no usable date). */
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
  /** Called when a stage starts ('dedupe', 'order', ...) and with 'done' at the end. */
  readonly onStage?: (stage: EngineStage) => void;
}

export type EngineStage = 'dedupe' | 'order' | 'overlap' | 'quote-markers' | 'reply-headers' | 'signatures' | 'segments' | 'done';

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

  // 2. De-duplicate (checked by isValidDedupe; the fallback merges nothing).
  parts.onStage?.('dedupe');
  let deduped: DedupeResult;
  let dedupeFailed = false;
  try {
    deduped = (parts.dedupe ?? dedupe)(parsed);
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

  // 3. Order.
  parts.onStage?.('order');
  const work: Work[] = orderMessages(kept).map(({ item, order }) => ({
    ...item,
    order,
    folds: [],
    warnings: new Set<EngineWarningCode>(dedupeFailed ? ['dedupe-failed'] : []),
  }));

  // 4a. Overlap, over the ordered set (it needs chronological order).
  parts.onStage?.('overlap');
  addFolds(
    work,
    guarded(work, () =>
      parts.detectQuotedOverlap(
        work.map((w) => ({
          bodyText: w.message.bodyText,
          messageId: w.message.messageId,
          inReplyTo: w.message.inReplyTo,
          references: w.message.references,
          index: w.index,
        })),
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

  const positionByIndex: (number | null)[] = results.map(() => null);
  messages.forEach((m, position) => {
    positionByIndex[m.index] = position;
    for (const d of m.duplicates) positionByIndex[d.index] = position;
  });

  parts.onStage?.('done');
  return {
    messages,
    failed,
    counts: {
      filesGiven: results.length,
      messagesFound: parsed.length,
      duplicatesMerged: deduped.mergedCount,
      filesFailed: failed.length,
      undated: messages.filter((m) => m.order === 'file-order').length,
      withFolds: messages.filter((m) => m.segments.some((s) => s.folded)).length,
    },
    positionByIndex,
  };
}
