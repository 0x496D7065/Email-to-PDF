// Overlap-based quote detection (README.md, rules R6 and R7).
//
// Idea: when a message body contains the text of another message of the set,
// that part is quoted history. This needs no list of languages or mail
// clients ("On ... wrote:", "Van:", "Le ... a ecrit :"), so it is the main
// quote detector. It only produces fold ranges (reason 'quoted-overlap'); it
// never changes or removes text (README.md, rule R6: collapse, never delete).
//
// How it works:
// 1. Each body is cut into WORDS: a Unicode letter or digit followed by
//    letters, digits and combining marks, compared after NFC normalization
//    and lower-casing.
//    Quote markers ("> "), punctuation, spaces, nbsp and line breaks are not
//    words, so a quote still matches after re-wrapping, "> " prefixes,
//    indentation, extra blank lines or HTML-to-text spacing changes. Each word
//    keeps its offsets in the ORIGINAL body, so folds point at the real text.
// 2. Every run of SHINGLE_WORDS consecutive words (a "shingle") of every
//    message goes into one index: shingle -> where it occurs.
// 3. For each message M, we walk its words. Where a shingle of M also occurs
//    in an eligible message O, we extend the match word by word to the longest
//    run of identical consecutive words. A run long enough (see `accepted`)
//    is a candidate fold, linked (`related`) to O's `index`. The walk then jumps
//    to the end of the run. Exception: when the run starts mid-line and goes
//    on into a later line, the line rule (step 4) may shrink or drop it, so
//    the walk goes on at the first word of the next line instead; a real
//    quote starting there (against another message) is then still found.
//    Runs may therefore overlap.
// 4. Runs are turned into whole lines (line breaks included), so the "> "
//    markers and indentation on those lines are folded too. The line rule
//    (README.md, rule R6: never hide the sender's new words):
//    a. A line with words is folded only when EVERY word on it lies inside
//       a candidate run (any run, of any related message: the union counts).
//       A run that starts or ends mid-line is shrunk to its fully covered
//       lines. Word-less lines at the ends of what remains are dropped too.
//    b. The shrunk run must still pass the acceptance test: at least
//       MIN_RUN_WORDS of its own words left, or, for a whole short message,
//       all of its words left. Otherwise it is dropped (its text stays shown).
//    c. Word-less lines (blank lines, a bare ">", "--") lying between two
//       folded lines with only word-less lines in between are folded with
//       them, linked like the folded line above them.
//    d. Directly above or below a folded block, lines made only of ">"
//       markers and spaces (a bare "> ") are folded with it. Other word-less
//       lines there (blank lines, "--") stay shown.
//
// Which message gets the link: the one giving the longest run (ties: the
// earliest in the input order). For a normal reply that is the message it
// answers, because that message's whole body appears in one piece in the
// quote, including its own quoted history. When runs from different messages
// overlap, the lines they share are linked to all of those messages.
//
// Direction (who may fold whose text): M's text is folded only because of an
// ELIGIBLE message O (see `isEligible`). Holding wins over everything: an
// email that holds another one (an attached email, `holds`) is the one
// folded (task 8.13b-3, review round 2). Then the reference headers win over the
// clocks: if exactly one of the two lists the other in In-Reply-To or
// References, only that one (the reply) gets folded, whatever the dates say
// (covers wrong clocks). An email that holds others also lists what they
// list (withHeldReferences, task 8.13b-3, review round 3): it prints them,
// so it quotes what they quote. Otherwise, only the later message of the two is
// folded. So M's text is never folded because a LATER message quoted M, and
// of two copies of the same text, the earliest stays shown.
//
// Trade-offs (when unsure, quoted text stays shown rather than new text
// being folded; a fold is reversible, a hidden new word may go unread):
// - A quote that shares a line with new text stays shown on that line, so a
//   body with no line breaks at all (e.g. some HTML-to-text output) gets no
//   quote folding here.
// - The walk jumps past a run that starts at the beginning of a line (or
//   stays on one line) even when the line rule drops it, so a shorter match
//   inside it is not tried. A run starting mid-line is retried from the next
//   line only once per stretch of text: a mid-line run that starts inside
//   the span of an earlier retried run is jumped past (keeps the cost about
//   linear; the text stays shown).
// - A quoted paragraph of fewer than MIN_RUN_WORDS words (for example one
//   short sentence answered inline) stays shown, unless it is the whole text
//   of a short message.
// - A signature or disclaimer the sender repeats in every message matches
//   the same block in their earlier messages and is folded here as
//   'quoted-overlap'. The signature detector and the pipeline (later tasks)
//   relabel it.
// - Text that only appears in the same message twice is never folded here.
//
// Cost: about linear in the total number of words, thanks to the jump in step
// 3 and the MAX_POSTINGS cap (see there for what the cap may miss). The walk
// always moves forward, so each word is a walk start at most once; retryFloor
// bounds how often the same words are re-scanned while extending matches
// (about twice).
//
// Pure function: no DOM, no storage, inputs are never modified (README.md,
// rule R7).

import { lineRanges, type FoldRange, type LineRange } from './segments';

/** Words per shingle (index key). Must be <= SHORT_MESSAGE_MIN_WORDS, or short messages could never match. */
export const SHINGLE_WORDS = 4;

/**
 * A run of at least this many identical consecutive words is quoted history.
 * 12 words is about one sentence: two people rarely write the same 12 words
 * in a row by chance, while common phrases ("thank you for your message",
 * "let me know if you have any questions") are shorter.
 */
export const MIN_RUN_WORDS = 12;

/**
 * A message shorter than MIN_RUN_WORDS still counts as quoted when its WHOLE
 * text appears in another message and it has at least this many words. So a
 * short reply quoted in full ("Yes, Wednesday works for me.") is folded, but
 * a two- or three-word message ("Thanks a lot") is not: such phrases are too
 * common to tell a quote from new text.
 */
export const SHORT_MESSAGE_MIN_WORDS = 4;

/**
 * At most this many occurrences are remembered per shingle (the first ones,
 * in input order). Without a cap, boilerplate repeated thousands of times
 * would make the search quadratic. What it may miss: a quote whose shingles
 * already occur more than MAX_POSTINGS times in messages that are not
 * eligible for it (or in its own message); such text stays shown. Because
 * the earliest occurrences are kept, the first message that contained a text
 * is always remembered.
 */
export const MAX_POSTINGS = 64;

/** What the detector needs from each message. Array position = chronological position. */
export interface OverlapInput {
  readonly bodyText: string;
  readonly messageId: string | null;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  /** Stable message number, copied into `FoldRange.related`. */
  readonly index: number;
  /**
   * The `index` of every message this one HOLDS: emails attached inside it,
   * at any depth (task 8.13b-3, review round 2). A holder always quotes the
   * emails it holds, so this link wins over the reference headers and the
   * clocks (see `isEligible`). Optional: none by default.
   */
  readonly holds?: readonly number[];
}

/** One word of a body: its comparison key and its offsets [start, end) in the original text. */
export interface Word {
  readonly key: string;
  readonly start: number;
  readonly end: number;
}

// A letter or digit, then letters, digits and combining marks. Marks are
// included so that a decomposed "e" + U+0301 stays inside its word and, after
// NFC, equals the precomposed letter. A mark only counts when attached to a
// word: an isolated combining mark or an emoji variation selector (U+FE0F)
// is not a word.
const WORD_PATTERN = /[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu;

/** The words of `text`, in order. Pure; never throws for strings. */
export function tokenizeWords(text: string): Word[] {
  const words: Word[] = [];
  for (const match of text.matchAll(WORD_PATTERN)) {
    const start = match.index;
    const raw = match[0];
    words.push({ key: raw.normalize('NFC').toLowerCase(), start, end: start + raw.length });
  }
  return words;
}

/** The ids M points at (In-Reply-To and References). */
function referencedIds(message: OverlapInput): Set<string> {
  const ids = new Set<string>();
  if (typeof message.inReplyTo === 'string' && message.inReplyTo !== '') ids.add(message.inReplyTo);
  if (Array.isArray(message.references)) {
    for (const id of message.references) if (typeof id === 'string' && id !== '') ids.add(id);
  }
  return ids;
}

/** True when `m` lists `o`'s Message-ID in its In-Reply-To or References. */
function points(refs: readonly Set<string>[], messages: readonly OverlapInput[], m: number, o: number): boolean {
  const id = messages[o]?.messageId;
  return typeof id === 'string' && id !== '' && (refs[m]?.has(id) ?? false);
}

/** The `holds` lists as sets (an entry that is not a number is ignored). */
function heldIndices(message: OverlapInput): Set<number> {
  const out = new Set<number>();
  const list: unknown = message.holds;
  if (Array.isArray(list)) for (const i of list as readonly unknown[]) if (typeof i === 'number') out.add(i);
  return out;
}

/**
 * The ids each message points at, for `isEligible` (task 8.13b-3, review
 * round 3, finding M2): its own (In-Reply-To and References, `own`) plus
 * those of every message it holds (`holds`, at any depth), as found in this
 * list by `index`. A holder prints the emails it holds, so it quotes what
 * they quote: when a reply attached inside C quotes A, C counts as
 * referencing A, and C, not A, is folded where they share text (whatever
 * the clocks say). Only the messages' own ids are added (not what a held
 * message got from holding others: `holds` already lists every depth).
 */
function withHeldReferences(messages: readonly OverlapInput[], own: readonly Set<string>[], holds: readonly Set<number>[]): Set<string>[] {
  const at = new Map<number, number>();
  messages.forEach((m, k) => {
    const index = m?.index;
    if (typeof index === 'number' && !at.has(index)) at.set(index, k);
  });
  return own.map((ids, m) => {
    const held = holds[m];
    if (held === undefined || held.size === 0) return ids;
    const out = new Set(ids);
    for (const index of held) {
      const k = at.get(index);
      if (k === undefined || k === m) continue;
      for (const id of own[k] ?? []) out.add(id);
    }
    return out;
  });
}

/**
 * May message `m`'s text be folded because it matches message `o`?
 * First, holding (task 8.13b-3, review round 2): if exactly one of them
 * holds the other (an attached email, at any depth), the holder is folded:
 * it quotes the email it holds, whatever the headers and the clocks say, so
 * an attached email's own text is never folded as quoted from the email
 * holding it. Then the reference headers: if exactly one of them references
 * the other (a holder also through the emails it holds, withHeldReferences),
 * the referencing one (the reply) is folded. If neither or both
 * do, the later one (higher position). For any two different messages
 * exactly one direction is eligible.
 */
function isEligible(refs: readonly Set<string>[], holds: readonly Set<number>[], messages: readonly OverlapInput[], m: number, o: number): boolean {
  const mHoldsO = holds[m]?.has(messages[o]?.index ?? Number.NaN) ?? false;
  const oHoldsM = holds[o]?.has(messages[m]?.index ?? Number.NaN) ?? false;
  if (mHoldsO !== oHoldsM) return mHoldsO;
  const mToO = points(refs, messages, m, o);
  const oToM = points(refs, messages, o, m);
  if (mToO !== oToM) return mToO;
  return o < m;
}

/** A 32-bit hash of the SHINGLE_WORDS word ids starting at `at` (FNV-1a style). Collisions are checked later. */
function shingleHash(ids: Int32Array, at: number): number {
  let h = 0x811c9dc5;
  for (let t = 0; t < SHINGLE_WORDS; t++) h = Math.imul(h ^ (ids[at + t] ?? 0), 0x01000193);
  return h;
}

/** A candidate match in message M: its words first..last (both included, positions in M's word list). */
interface Run {
  readonly first: number;
  readonly last: number;
  /** `index` of the message the words were found in. */
  readonly related: number;
  /** True when the run is the whole text of that message. */
  readonly wholeShortMessage: boolean;
}

// A line made only of ">" quote markers and spaces (at least one ">").
const MARKER_ONLY_LINE = /^[\s>]*>[\s>]*$/;

/** The line number (in `lines`) of each word. Words come in text order. */
function wordLines(lines: readonly LineRange[], words: readonly Word[]): Int32Array {
  const lineOf = new Int32Array(words.length);
  let at = 0;
  words.forEach((w, k) => {
    while (at + 1 < lines.length && (lines[at + 1]?.start ?? Infinity) <= w.start) at++;
    lineOf[k] = at;
  });
  return lineOf;
}

/**
 * Turns the runs found in one body into whole-line fold ranges, following
 * the line rule (step 4 in the header comment). Ranges for the same related
 * message never overlap or touch.
 */
function runsToFolds(body: string, lines: readonly LineRange[], lineOf: Int32Array, runs: readonly Run[]): FoldRange[] {
  if (runs.length === 0) return [];
  const lineCount = lines.length;
  if (lineCount === 0) return [];

  // Words covered by at least one run (runs may overlap, see step 3), then
  // per line its number of words and of covered words.
  const covered = new Uint8Array(lineOf.length);
  for (const r of runs) covered.fill(1, r.first, r.last + 1);
  const wordCount = new Int32Array(lineCount);
  const coveredCount = new Int32Array(lineCount);
  lineOf.forEach((l, k) => {
    wordCount[l] = (wordCount[l] ?? 0) + 1;
    coveredCount[l] = (coveredCount[l] ?? 0) + (covered[k] ?? 0);
  });
  const full = (l: number): boolean => (wordCount[l] ?? 0) > 0 && coveredCount[l] === wordCount[l];

  // Rule a and b: shrink each run to its fully covered lines, then re-check it.
  const lineRelated: (number[] | undefined)[] = new Array<number[] | undefined>(lineCount);
  for (const r of runs) {
    let a = lineOf[r.first] ?? 0;
    let b = lineOf[r.last] ?? 0;
    // Only the first and last lines can be partly covered (the lines in
    // between hold only words of this run); word-less lines are skipped too.
    while (a <= b && !full(a)) a++;
    while (b >= a && !full(b)) b--;
    if (a > b) continue;
    let lo = r.first;
    let hi = r.last;
    while ((lineOf[lo] ?? 0) < a) lo++;
    while ((lineOf[hi] ?? 0) > b) hi--;
    const kept = hi - lo + 1;
    const accepted = kept >= MIN_RUN_WORDS || (r.wholeShortMessage && kept === r.last - r.first + 1);
    if (!accepted) continue;
    for (let l = a; l <= b; l++) {
      const list = lineRelated[l];
      if (list === undefined) lineRelated[l] = [r.related];
      else if (!list.includes(r.related)) list.push(r.related);
    }
  }

  // Rule c: word-less lines between two folded lines join them (linked like the line above).
  let lastFolded = -1;
  let gapHasWords = false;
  for (let l = 0; l < lineCount; l++) {
    const list = lineRelated[l];
    if (list !== undefined) {
      const above = lineRelated[lastFolded];
      if (lastFolded >= 0 && !gapHasWords && above !== undefined) {
        for (let g = lastFolded + 1; g < l; g++) lineRelated[g] = [...above];
      }
      lastFolded = l;
      gapHasWords = false;
    } else if ((wordCount[l] ?? 0) > 0) {
      gapHasWords = true;
    }
  }

  // Rule d: bare ">" lines directly above or below a folded block join it.
  const markerOnly = (l: number): boolean => {
    const line = lines[l];
    return (
      line !== undefined &&
      (wordCount[l] ?? 0) === 0 &&
      lineRelated[l] === undefined &&
      MARKER_ONLY_LINE.test(body.slice(line.start, line.contentEnd))
    );
  };
  for (let l = 0; l < lineCount; l++) {
    const list = lineRelated[l];
    if (list === undefined) continue;
    if (l === 0 || lineRelated[l - 1] === undefined) {
      for (let g = l - 1; g >= 0 && markerOnly(g); g--) lineRelated[g] = [...list];
    }
    // Below. `l` moves past the lines added here, so the outer loop does not
    // visit them again (they are marker-only: nothing more would join them).
    while (l + 1 < lineCount && markerOnly(l + 1)) {
      lineRelated[l + 1] = [...list];
      l++;
    }
  }

  // One range per related message and per block of consecutive lines.
  const blocks = new Map<number, { a: number; b: number }[]>();
  for (let l = 0; l < lineCount; l++) {
    for (const related of lineRelated[l] ?? []) {
      const list = blocks.get(related);
      const last = list?.[list.length - 1];
      if (last && last.b === l - 1) last.b = l;
      else if (list) list.push({ a: l, b: l });
      else blocks.set(related, [{ a: l, b: l }]);
    }
  }
  const folds: FoldRange[] = [];
  for (const [related, list] of blocks) {
    for (const { a, b } of list) {
      const start = lines[a]?.start ?? 0;
      const end = lines[b]?.end ?? body.length;
      folds.push({ start, end, reason: 'quoted-overlap', related });
    }
  }
  return folds.sort((x, y) => x.start - y.start || x.end - y.end || (x.related ?? 0) - (y.related ?? 0));
}

/**
 * Finds quoted history in each message. `messages` must be in chronological
 * order. Returns one list of fold ranges per message (same positions), each
 * with reason 'quoted-overlap' and `related` = the `index` of the message the
 * text was found in. Ranges for the same related message never overlap;
 * ranges for different related messages may (buildSegments unions them).
 */
export function detectQuotedOverlap(messages: readonly OverlapInput[]): FoldRange[][] {
  const list: readonly OverlapInput[] = Array.isArray(messages) ? messages : [];
  const bodies = list.map((m) => (typeof m?.bodyText === 'string' ? m.bodyText : ''));
  const words = bodies.map(tokenizeWords);
  const holds = list.map((m) => (m ? heldIndices(m) : new Set<number>()));
  const refs = withHeldReferences(
    list,
    list.map((m) => (m ? referencedIds(m) : new Set<string>())),
    holds,
  );

  // All words of all messages in one array of numeric ids (one id per
  // distinct key), so comparing two words is comparing two numbers.
  // Message k owns global positions [first[k], first[k + 1]).
  const vocabulary = new Map<string, number>();
  const first: number[] = [0];
  let total = 0;
  for (const w of words) {
    total += w.length;
    first.push(total);
  }
  const ids = new Int32Array(total);
  const owner = new Int32Array(total);
  words.forEach((ws, k) => {
    let at = first[k] ?? 0;
    for (const w of ws) {
      let id = vocabulary.get(w.key);
      if (id === undefined) {
        id = vocabulary.size;
        vocabulary.set(w.key, id);
      }
      ids[at] = id;
      owner[at] = k;
      at++;
    }
  });

  // Shingle index: hash -> global start positions, in input order, capped.
  const index = new Map<number, number[]>();
  for (let k = 0; k < words.length; k++) {
    const end = first[k + 1] ?? 0;
    for (let g = first[k] ?? 0; g + SHINGLE_WORDS <= end; g++) {
      const h = shingleHash(ids, g);
      const postings = index.get(h);
      if (postings === undefined) index.set(h, [g]);
      else if (postings.length < MAX_POSTINGS) postings.push(g);
    }
  }

  return list.map((_, m): FoldRange[] => {
    const mStart = first[m] ?? 0;
    const mEnd = first[m + 1] ?? 0;
    const body = bodies[m] ?? '';
    const lines = lineRanges(body);
    const lineOf = wordLines(lines, words[m] ?? []);
    const runs: Run[] = [];
    // A mid-line run starting before this (global) position causes no retry.
    // The walk always moves forward, so each word is a walk start at most
    // once; this floor bounds how often the same words are re-scanned while
    // extending matches (about twice).
    let retryFloor = mStart;

    let i = mStart;
    while (i + SHINGLE_WORDS <= mEnd) {
      let bestLen = 0;
      let bestOwner = -1;
      let bestWhole = false;
      for (const g of index.get(shingleHash(ids, i)) ?? []) {
        const o = owner[g] ?? -1;
        if (o === m || o < 0 || !isEligible(refs, holds, list, m, o)) continue;
        const oStart = first[o] ?? 0;
        const oEnd = first[o + 1] ?? 0;
        // Longest run of equal words starting at i (in M) and g (in O).
        const maxLen = Math.min(mEnd - i, oEnd - g);
        let len = 0;
        while (len < maxLen && ids[i + len] === ids[g + len]) len++;
        if (len < SHINGLE_WORDS) continue; // hash collision, not a real match
        const wholeShortMessage = g === oStart && len === oEnd - oStart && len >= SHORT_MESSAGE_MIN_WORDS;
        const accepted = len >= MIN_RUN_WORDS || wholeShortMessage;
        // Strictly longer wins, so on a tie the earliest posting (earliest message) stays.
        if (accepted && len > bestLen) {
          bestLen = len;
          bestOwner = o;
          bestWhole = wholeShortMessage;
        }
      }
      if (bestOwner < 0) {
        i++;
        continue;
      }
      const firstWord = i - mStart;
      const lastWord = firstWord + bestLen - 1;
      runs.push({
        first: firstWord,
        last: lastWord,
        related: list[bestOwner]?.index ?? bestOwner,
        wholeShortMessage: bestWhole,
      });
      const line = lineOf[firstWord] ?? 0;
      const midLine = firstWord > 0 && lineOf[firstWord - 1] === line;
      if (midLine && (lineOf[lastWord] ?? 0) > line && i >= retryFloor) {
        // The line rule may shrink or drop this run: walk on from the first
        // word of the next line, so a quote starting there is still found.
        retryFloor = i + bestLen;
        let next = firstWord + 1;
        while (lineOf[next] === line) next++;
        i = mStart + next;
      } else {
        i += bestLen;
      }
    }

    return runsToFolds(body, lines, lineOf, runs);
  });
}
