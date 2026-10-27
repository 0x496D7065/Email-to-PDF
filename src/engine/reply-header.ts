// Reply-header detection (README.md, rules R6 and R7).
//
// Idea: mail clients write a recognizable header above the text they quote
// or forward: an ATTRIBUTION line ("On <date>, <name> wrote:", "Le ... a
// ecrit :", "Op ... schreef ...:") or an Outlook-style HEADER BLOCK
// ("From: / Sent: / To: / Subject:", "De : / Envoye : / A : / Objet :",
// "Van: / Verzonden: / Aan: / Onderwerp:"). This detector finds them and
// returns fold ranges (reason 'reply-header'); it never changes or removes
// text (README.md, rule R6: collapse, never delete). The words per language
// live in reply-patterns.ts, so a language is added there, not here.
//
// Rules:
// 1. Lines are read through a CLEANED copy (see reply-patterns.ts): ">"
//    markers removed, whitespace runs (nbsp included) made one space,
//    trimmed. A line is MARKED when its first non-space character is ">"
//    (as in quote-markers.ts). A ">" block is a run of marked lines, with
//    blank lines between two marked lines joining it.
// 2. ATTRIBUTION. A line (at most ATTRIBUTION_MAX_LENGTH characters once
//    cleaned) that starts with a language's opener and ends with one of its
//    endings ("On ... wrote:") is a STRONG attribution. Gmail wraps long
//    ones, so two lines joined also count when the first starts with the
//    opener. A line that only ends with an ending ("Bob wrote:") is a BARE
//    attribution.
//    - If a ">" block follows (blank lines in between allowed), the
//      attribution and that block are folded, and nothing after the block:
//      a reply written below the quote stays shown.
//    - Otherwise a strong attribution folds alone (its quote may have no
//      markers; overlap detection handles that text), but only when it
//      holds a digit, "@" or "<": real attributions carry a date or an
//      address, while "On Monday, Bob wrote:" followed by "that he would
//      come." is the sender's own story and stays shown. A bare one is
//      ignored: "... as Carol wrote:" followed by normal text is just a
//      sentence.
//    The opener alone is never enough: "On Monday I wrote: see below" does
//    not end with "wrote:", so nothing is folded.
// 3. HEADER BLOCK. At least MIN_HEADER_LINES consecutive label lines, the
//    first a From label, the set holding a Sent/Date label and a To or
//    Subject label. It may be introduced by an INTRO line just above it (at
//    most MAX_GAP_LINES blank lines in between): an "original message"
//    separator, Outlook's row of underscores, or a forward marker. The
//    intro is folded with the block.
//    - WITHOUT an intro, the label lines must also look like a real header,
//      not a letter or a label quoted in the sender's own text ("From: the
//      warehouse / Date: Monday / To: the office"): a From, To or Cc (or
//      Bcc) value holds an address ("@", which covers "<addr>" and
//      "[mailto:...]"), or the Sent/Date value holds a 4-digit year or an
//      hh:mm time. This
//      applies to a block inside a ">" quote too. With an intro, the shape
//      above is enough.
//    - REPLY: the fold runs from the intro (or the block) to the end of the
//      body. Outlook quotes carry no ">" markers and the reply is on top, so
//      the end of the quote cannot be seen. Trade-off: text typed BELOW an
//      Outlook quote is folded too; it is reversible, nothing is lost.
//    - A block of marked lines (a header inside a ">" quote) folds only to
//      the end of its ">" block, never into the unquoted text after it.
//    - The end-of-body fold also stops before the next forwarded block that
//      the .eml adapter wrote (see rule 5): that block is another message.
// 4. FORWARDS ARE NOT QUOTED HISTORY. Forwarded content is often the very
//    thing the sender wants read. If the intro is a forward marker, or the
//    message subject starts with a forward prefix ("Fwd:", "TR:",
//    "Doorst:"..., possibly after one or more tags such as "[EXT]"), only
//    the intro and the label lines are folded, not the
//    content after them. The subject rule applies to the FIRST unmarked
//    block only: blocks further down are the forwarded message's own
//    replies. (Overlap detection may still fold forwarded text that is also
//    a message of the batch.)
//    An intro without a usable block: an "original message" separator
//    followed within MAX_GAP_LINES lines by a From label (but fewer label
//    lines than a block needs) is handled like a block (to the end for a
//    reply, the label lines only for a forward); a separator or forward
//    marker with no From label after it folds alone; a row of underscores
//    alone is left shown (signatures use it as a divider).
// 5. The .eml adapter writes its own block for each inline forwarded
//    message it expands: a line exactly equal to FORWARDED_SEPARATOR, then
//    English label lines (FORWARDED_HEADER_LABELS) in a fixed order. That is
//    the tool's own output, not a client's header, so it is skipped: never
//    folded, never taken for a block. Side effect: an old Gmail forward line
//    with exactly the same dashes, at the start of a line and not quoted, is
//    skipped too (its header stays shown, the safe direction). Current Gmail
//    writes one dash fewer at the end, so it is still recognized.
//
// Cost: linear in the body length. Every line is looked at a bounded number
// of times: a run of label lines is scanned once (when it is not a block, a
// later From line inside the same run is not scanned again: it would start
// a shorter run with fewer labels and values, which cannot be a block
// either); intros look ahead at most MAX_GAP_LINES + 1 lines and
// attributions at most 2. Only the first characters of a line are cleaned
// to read a label, and long lines are never tested as attributions or
// markers.
//
// Pure function: no DOM, no storage, the input is never modified (README.md,
// rule R7).

import { FORWARDED_HEADER_LABELS, FORWARDED_SEPARATOR } from '../parsing/forwarded-block';
import { OUTLOOK_RULE, REPLY_LANGUAGES, type HeaderLabels } from './reply-patterns';
import { lineRanges, type FoldRange, type LineRange } from './segments';

/**
 * Longest attribution, in characters after cleaning (both lines when
 * wrapped). Real ones hold a date, a time, a name and an address: about 60
 * to 150 characters. A longer line is ordinary text that happens to end in
 * "wrote:".
 */
export const ATTRIBUTION_MAX_LENGTH = 300;

/**
 * A header block needs at least this many label lines. Real blocks have 4
 * or 5 (From, Sent, To, Cc, Subject); two "Label:" lines in a row
 * ("From: the warehouse" / "To: the office") are common in normal text.
 */
export const MIN_HEADER_LINES = 3;

/** Blank lines allowed between an intro line and the From label below it (Apple Mail leaves one). */
export const MAX_GAP_LINES = 2;

/** Longest cleaned line tested as a separator or forward marker. */
const MAX_INTRO_LENGTH = 120;

/** Characters read at the start of a line to find a label ("Onderwerp :" with stars and spaces fits). */
export const LABEL_HEAD_LENGTH = 40;

/** The role of a header label line (from, sent, to, cc, bcc, subject). */
export type Role = keyof HeaderLabels;

const ROLES: readonly Role[] = ['from', 'sent', 'to', 'cc', 'bcc', 'subject'];

/** Escapes a plain word for use inside a regular expression. */
function escapeRegExp(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Lower case + NFC: the key used to compare labels. */
export function labelKey(word: string): string {
  return word.normalize('NFC').toLowerCase();
}

// Built once from the data file. Patterns are recompiled case-insensitive
// with Unicode semantics ("i" + "u").
const ci = (re: RegExp): RegExp => new RegExp(re.source, 'iu');

/** Attribution patterns per language, compiled (same order as REPLY_LANGUAGES). Also read by quoted-header.ts. */
export const LANGUAGES: readonly { readonly code: string; readonly opener: RegExp; readonly endings: readonly RegExp[] }[] = REPLY_LANGUAGES.map((lang) => ({
  code: lang.code,
  opener: ci(lang.attribution.opener),
  endings: lang.attribution.endings.map(ci),
}));

export const SEPARATORS: readonly RegExp[] = REPLY_LANGUAGES.flatMap((lang) => lang.separators.map(ci));
export const FORWARD_MARKERS: readonly RegExp[] = REPLY_LANGUAGES.flatMap((lang) => lang.forwardMarkers.map(ci));

/** Label word (labelKey) -> role. The first language listing a word wins. */
const LABEL_ROLES = new Map<string, Role>();
/** Read-only view of LABEL_ROLES, for quoted-header.ts. */
export const LABEL_ROLE_OF: ReadonlyMap<string, Role> = LABEL_ROLES;
for (const lang of REPLY_LANGUAGES) {
  for (const role of ROLES) {
    for (const word of lang.labels[role]) {
      if (!LABEL_ROLES.has(labelKey(word))) LABEL_ROLES.set(labelKey(word), role);
    }
  }
}

// "Label:" at the start of a cleaned line, with optional stars around the
// label and one optional space before the colon ("De :", "*From:*").
// Longest words first, so "Aan" is tried before "A".
export const LABEL_PATTERN = new RegExp(
  `^\\*?(${[...LABEL_ROLES.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|')}) ?\\*? ?:`,
  'iu',
);

// Leading tags added by mail gateways ("[EXT] FW: ...") are skipped.
const FORWARD_SUBJECT = new RegExp(
  `^\\s*(?:\\[[^\\]]*\\]\\s*)*(?:${REPLY_LANGUAGES.flatMap((lang) => lang.forwardSubjectPrefixes).map(escapeRegExp).join('|')})\\s*:`,
  'iu',
);

/** A 4-digit year or an hh:mm time: what a real Sent/Date value holds. */
const DATE_EVIDENCE = /(?<!\d)\d{4}(?!\d)|(?<!\d)\d{1,2}:\d{2}(?!\d)/u;

/** A date or an address: what a real attribution line holds (rule 2). */
const ATTRIBUTION_EVIDENCE = /[\d@<]/u;

/** True when `subject` starts with a forward prefix ("Fwd:", "TR:", ...), after optional "[...]" tags. */
export function isForwardSubject(subject: unknown): boolean {
  return typeof subject === 'string' && FORWARD_SUBJECT.test(subject);
}

/** What one line is, for this detector. */
interface LineInfo {
  readonly range: LineRange;
  /** First non-space character is ">". */
  readonly marked: boolean;
  /** Nothing but whitespace after the markers (a blank line or a bare ">"). */
  readonly gap: boolean;
  /** Offset of the first character after the markers and spaces. */
  readonly textStart: number;
}

function isSpace(ch: string): boolean {
  return /\s/.test(ch);
}

function readLine(text: string, range: LineRange): LineInfo {
  let i = range.start;
  while (i < range.contentEnd && isSpace(text.charAt(i))) i++;
  const marked = i < range.contentEnd && text.charAt(i) === '>';
  while (i < range.contentEnd && (text.charAt(i) === '>' || isSpace(text.charAt(i)))) i++;
  return { range, marked, gap: i === range.contentEnd, textStart: i };
}

/** The cleaned copy of text[from, to) (see the header comment, rule 1). */
export function clean(text: string, from: number, to: number): string {
  return text.slice(from, to).replace(/\s+/g, ' ').trim().normalize('NFC');
}

/**
 * One header found by `findReplyHeaders`: the same range as the fold
 * `detectReplyHeaders` returns for it, plus what kind of header it is.
 * - kind 'forward': a forward header (rule 4: a forward marker intro, or the
 *   first unmarked block of a message with a forward subject). Its range
 *   covers the header lines only, never the forwarded content.
 * - kind 'reply': everything else (attributions, reply blocks, a separator
 *   alone). A reply block's range may run to the end of the body (rule 3).
 * - marked: the header's first line is inside a ">" quote.
 * - headEnd: where the header's OWN lines end (the attribution line or
 *   lines, or the intro and label lines of a block), line break included.
 *   [start, headEnd) is the header itself; [headEnd, end) is the quoted text
 *   the fold also covers (empty for a forward, a lone separator, or an
 *   attribution with no ">" block after it).
 */
export interface FoundHeader {
  readonly start: number;
  readonly end: number;
  readonly headEnd: number;
  readonly kind: 'reply' | 'forward';
  readonly marked: boolean;
}

/**
 * Finds reply-header and forward-header blocks in `bodyText` and returns
 * fold ranges (reason 'reply-header', no `related`), sorted by position.
 * `subject` is the message subject, used only to recognize a forward.
 * Never throws: a non-string body gives [].
 */
export function detectReplyHeaders(bodyText: string, subject?: string): FoldRange[] {
  return findReplyHeaders(bodyText, subject).map((h) => ({ start: h.start, end: h.end, reason: 'reply-header' }));
}

/**
 * The same search as `detectReplyHeaders` (same ranges, same order), but
 * each range also says whether it is a reply or a forward header (see
 * FoundHeader). Used by the PDF output plan (output-plan.ts) to tell
 * forwarded content from quoted history. Never throws: a non-string body
 * gives [].
 */
export function findReplyHeaders(bodyText: string, subject?: string): FoundHeader[] {
  if (typeof (bodyText as unknown) !== 'string') return [];
  const text = bodyText;
  const lines = lineRanges(text).map((range) => readLine(text, range));
  const n = lines.length;
  const folds: FoundHeader[] = [];
  const fold = (start: number, end: number, headEnd: number, kind: FoundHeader['kind'], marked: boolean): void => {
    if (start < end) folds.push({ start, end, headEnd: Math.min(headEnd, end), kind, marked });
  };
  const at = (i: number): LineInfo => {
    const line = lines[i];
    if (line === undefined) throw new Error('line index out of range'); // never happens: callers check bounds
    return line;
  };

  // runEnd[i]: for a marked line, the last marked line of its ">" block.
  // nextTool[i]: the first line >= i that starts an adapter forwarded block (or n).
  const runEnd = new Array<number>(n).fill(-1);
  const nextTool = new Array<number>(n + 1).fill(n);
  const isTool = lines.map(
    (line) => !line.marked && text.slice(line.range.start, line.range.contentEnd) === FORWARDED_SEPARATOR,
  );
  let lastMarked = -1;
  for (let i = n - 1; i >= 0; i--) {
    const line = at(i);
    if (line.marked) {
      if (lastMarked < 0) lastMarked = i;
      runEnd[i] = lastMarked;
    } else if (!line.gap) {
      lastMarked = -1; // a line with other text ends the block
    }
    nextTool[i] = isTool[i] ? i : (nextTool[i + 1] ?? n);
  }

  /** The role of line i's label, or null when it does not start with a label. */
  const roleOf = (i: number): Role | null => {
    const line = at(i);
    if (line.gap) return null;
    const head = clean(text, line.textStart, Math.min(line.range.contentEnd, line.textStart + LABEL_HEAD_LENGTH));
    const match = LABEL_PATTERN.exec(head);
    return match?.[1] === undefined ? null : (LABEL_ROLES.get(labelKey(match[1])) ?? null);
  };

  /** The cleaned text of line i, or null when it is too long to be `limit` characters once cleaned. */
  const cleanedLine = (i: number, limit: number): string | null => {
    const line = at(i);
    // Whitespace runs shrink when cleaned; four times the limit is a generous bound.
    if (line.range.contentEnd - line.textStart > limit * 4) return null;
    const cleaned = clean(text, line.textStart, line.range.contentEnd);
    return cleaned.length <= limit ? cleaned : null;
  };

  /** The end offset of a reply fold whose block starts at line `first`. */
  const replyEnd = (first: number, lastHeader: number): number => {
    const line = at(first);
    if (line.marked) return at(Math.max(runEnd[first] ?? first, lastHeader)).range.end;
    const tool = nextTool[lastHeader + 1] ?? n;
    return tool < n ? at(tool).range.start : text.length;
  };

  /** Whether label line i (of the given role) holds an address or a date (rule 3, no intro). */
  const hasEvidence = (i: number, role: Role): boolean => {
    // Only this line is read (never text.indexOf over the rest of the body).
    const value = text.slice(at(i).textStart, at(i).range.contentEnd);
    if (role === 'sent') return DATE_EVIDENCE.test(value);
    // Bcc counts exactly like Cc (it was one role with it before the field reader needed them apart).
    if (role === 'from' || role === 'to' || role === 'cc' || role === 'bcc') return value.includes('@');
    return false;
  };

  let forwardSubjectPending = isForwardSubject(subject);
  // End (exclusive) of the last run of label lines found NOT to be a block:
  // a From line before it is inside that run and is not scanned again.
  let labelRunEnd = 0;
  let i = 0;
  while (i < n) {
    const line = at(i);
    if (line.gap) {
      i++;
      continue;
    }

    // Rule 5: the adapter's own forwarded block. Skip the separator and its
    // label lines, written in a fixed order, each at most once.
    if (isTool[i]) {
      let j = i + 1;
      let next = 0;
      while (j < n) {
        const content = text.slice(at(j).range.start, at(j).range.contentEnd);
        const k = FORWARDED_HEADER_LABELS.findIndex((label, idx) => idx >= next && content.startsWith(`${label}: `));
        if (k < 0) break;
        next = k + 1;
        j++;
      }
      i = j;
      continue;
    }

    // Intro line (separator, forward marker, underscores), then a From label?
    const introText = cleanedLine(i, MAX_INTRO_LENGTH);
    const isSeparator = introText !== null && SEPARATORS.some((re) => re.test(introText));
    const isForwardMarker = introText !== null && FORWARD_MARKERS.some((re) => re.test(introText));
    const isRule = introText !== null && OUTLOOK_RULE.test(introText);
    let intro = -1;
    let first = i;
    if (isSeparator || isForwardMarker || isRule) {
      let k = i + 1;
      while (k < n && k <= i + MAX_GAP_LINES && at(k).gap) k++;
      if (k < n && at(k).marked === line.marked && roleOf(k) === 'from') {
        intro = i;
        first = k;
      } else {
        // Rule 4, last part: a separator or marker alone folds alone; a row
        // of underscores alone stays shown.
        if (!isRule) fold(line.range.start, line.range.end, line.range.end, isForwardMarker ? 'forward' : 'reply', line.marked);
        i++;
        continue;
      }
    }

    // Header block starting at `first`?
    if (first >= labelRunEnd && roleOf(first) === 'from') {
      const marked = at(first).marked;
      const roles = new Set<Role>();
      let evidence = false;
      let j = first;
      while (j < n && at(j).marked === marked) {
        const role = roleOf(j);
        if (role === null) break;
        roles.add(role);
        if (!evidence && intro < 0) evidence = hasEvidence(j, role);
        j++;
      }
      const last = j - 1; // last label line
      const shaped = j - first >= MIN_HEADER_LINES && roles.has('sent') && (roles.has('to') || roles.has('subject'));
      // Without an intro, the values must look like a real header (rule 3).
      const isBlock = shaped && (intro >= 0 || evidence);
      // An "original message" separator plus a From label is enough (rule 4).
      if (isBlock || (intro >= 0 && isSeparator)) {
        const start = at(intro >= 0 ? intro : first).range.start;
        let forward = intro >= 0 && isForwardMarker;
        if (!marked && forwardSubjectPending) {
          forward = true;
          forwardSubjectPending = false;
        }
        fold(start, forward ? at(last).range.end : replyEnd(first, last), at(last).range.end, forward ? 'forward' : 'reply', marked);
        i = j;
        continue;
      }
      if (intro >= 0) {
        // A forward marker with a short label list: still header lines only.
        if (isForwardMarker) fold(line.range.start, at(last).range.end, at(last).range.end, 'forward', line.marked);
        i = j;
        continue;
      }
      // Not a block: line i may still be an attribution (below), but no
      // later line of this run is tested as a block start again (linear cost).
      labelRunEnd = j;
    }

    // Attribution (rule 2).
    const one = cleanedLine(i, ATTRIBUTION_MAX_LENGTH);
    let lastLine = -1;
    let strong = false;
    let attribution = '';
    if (one !== null) {
      for (const lang of LANGUAGES) {
        if (!lang.endings.some((re) => re.test(one))) continue;
        lastLine = i;
        attribution = one;
        if (lang.opener.test(one)) strong = true;
      }
      if (lastLine < 0 && i + 1 < n && !at(i + 1).gap && at(i + 1).marked === line.marked) {
        // Wrapped over two lines: only with an opener on the first line.
        const two = cleanedLine(i + 1, ATTRIBUTION_MAX_LENGTH);
        const joined = two === null ? '' : `${one} ${two}`;
        if (two !== null && joined.length <= ATTRIBUTION_MAX_LENGTH) {
          const wrapped = LANGUAGES.some((lang) => lang.opener.test(one) && lang.endings.some((re) => re.test(joined)));
          if (wrapped) {
            lastLine = i + 1;
            attribution = joined;
            strong = true;
          }
        }
      }
    }
    if (lastLine >= 0) {
      // The ">" block that follows, if any.
      let blockEnd = -1;
      if (at(lastLine).marked) {
        const end = runEnd[lastLine] ?? lastLine;
        if (end > lastLine) blockEnd = end;
      } else {
        let k = lastLine + 1;
        while (k < n && at(k).gap && !at(k).marked) k++;
        if (k < n && at(k).marked) blockEnd = runEnd[k] ?? k;
      }
      if (blockEnd >= 0) fold(line.range.start, at(blockEnd).range.end, at(lastLine).range.end, 'reply', line.marked);
      else if (strong && ATTRIBUTION_EVIDENCE.test(attribution)) fold(line.range.start, at(lastLine).range.end, at(lastLine).range.end, 'reply', line.marked);
      i = lastLine + 1;
      continue;
    }
    i++;
  }

  return folds.sort((a, b) => a.start - b.start || a.end - b.end);
}
