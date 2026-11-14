// De-duplication of parsed messages (README.md, rules R6 and R7).
//
// The same email often arrives more than once: the copy in the inbox and the
// copy in "Sent", an .eml and an .msg export of one message, a message re-sent
// through a relay. This module finds copies that are PROVABLY identical and
// keeps one of them. Nothing is thrown away: every merged copy is listed next
// to the kept message (file name, SHA-256, which rule matched), so the
// preview and the kept email's File row in the PDF can still name every
// source file (README.md, rule R6: collapse, never delete).
//
// Pure function: no DOM, no workers, no storage, and the input is never
// modified (README.md, rule R7).
//
// Two messages are duplicates only if ALL of these hold:
// 1. Their normalized bodies are equal (see `normalizeBody`).
// 2. Their subjects are equal after `subjectKey` (only spaces are tidied).
// 3. Their attachments have the same file names, counted with repeats
//    (sizes and types are ignored: .eml and .msg encode them differently).
// 4. Either both or neither have the parser warning 'html-body-unreadable',
//    either both or neither have 'html-body-truncated', and either both or
//    neither have 'rtf-only-body'. A copy whose HTML body could not be read,
//    or was cut, may hold text the other copy shows, and an RTF-only .msg has
//    an empty text like a copy with no body at all; merging would hide that
//    this copy's content is missing or cannot be shown (README.md, rule R6),
//    because a merged copy keeps no parser warnings.
// 5. Their whole From lists are equal (see `fromKey`), and
//    a. they have the same non-null Message-ID, and their dates are at most
//       DATE_TOLERANCE_MS apart if both have one (rule "message-id"), or
//    b. both have an author (see `authorKey`) and they have the same
//       non-null date (rule "author-date-body").
// 6. One copy's header data covers the other's, so keeping that copy loses
//    nothing (see `covers`): its To, Cc and Bcc sets are each a superset of
//    the other copy's, it has the same `sender` or the other has none, the
//    same In-Reply-To or the other has none, all of the other's References,
//    and a date if the other has one (so a missing date never wins over a
//    known one). (Typical case: the sender's own copy has a Bcc line the
//    recipient's copy lacks; the Bcc copy is kept.)
//    EXCEPTION, a dropped file against an attached copy (user decision
//    2026-11-13, task 8.13b-3 review round 4, D2): when `firstAttached` is
//    given, the messages from that position on are emails attached inside
//    dropped files (src/engine/engine.ts). In a group holding both, the
//    copy kept is always one of the dropped files' own emails (the one
//    covering the other dropped copies), even when an attached copy holds
//    strictly more header data (say a Bcc line or a date): those attached
//    copies are merged into it all the same (keepsHeaderData tells the
//    caller when that happened). Which messages are duplicates does not
//    change, only which copy is kept.
//
// Anything less is not "provably identical", so both messages stay, and a
// warning tells the preview why they were not merged.
//
// Known limit: thousands of copies sharing one Message-ID (or one author and
// date) whose recipients all differ make grouping quadratic (seconds, not
// milliseconds). Callers should run it off the main thread or behind a time
// or size limit.

import type { NormalizedMessage } from '../parsing/types';

/** Which rule proved that a merged copy is the same message as the kept one. */
export type DuplicateRule = 'message-id' | 'author-date-body';

/** Why the engine did NOT merge messages that look alike. Shown in the preview. */
export type DedupeWarningCode =
  // Another message has the same Message-ID but a different body, subject,
  // attachment names or From list, or only one of them has a body-missing
  // parser warning (rule 4). Merging would lose text, so both are kept.
  | 'same-id-different-content'
  // Another message has the same Message-ID and content, but the dates are
  // more than DATE_TOLERANCE_MS apart; or one copy has no date and the dated
  // copy lacks other header data the undated one has (e.g. a Bcc line), so
  // keeping either would lose the date or that data.
  | 'duplicate-date-differs'
  // Another message is identical except that neither copy's To/Cc/Bcc covers
  // the other's (e.g. Carol is in Cc in one copy and in Bcc in the other).
  | 'duplicate-recipients-differ'
  // Another message is identical except for the "sent on behalf of" sender
  // (both have one, and they differ), or the copy with more recipients is
  // the one without a sender, so no single copy holds all the header data.
  | 'duplicate-sender-differs'
  // Another message is identical except for the threading headers: the
  // In-Reply-To ids differ, neither References list holds the other, or the
  // copy with more threading data lacks other header data.
  | 'duplicate-threading-differs'
  // This message is a duplicate of a message in another group, but not of
  // every member of that group, so it could not join it (see `dedupe`).
  | 'possible-duplicate-not-merged';

/** One engine warning, with the other messages it is about. */
export interface DedupeWarning {
  readonly code: DedupeWarningCode;
  /**
   * Input positions of the other messages involved, ascending, without
   * repeats: at most MAX_RELATED of them, the lowest positions first.
   */
  readonly related: readonly number[];
  /**
   * How many other messages are involved in total (at least `related.length`),
   * so the preview can say "and N more" when the list was cut.
   */
  readonly relatedTotal: number;
}

/** One copy that was merged into a kept message. */
export interface MergedCopy {
  /** The copy's file name, SHA-256 and format, for the PDF cover page. */
  readonly source: NormalizedMessage['source'];
  /** Position of the copy in the input array. */
  readonly index: number;
  /** Which rule matched between this copy and the kept message. */
  readonly rule: DuplicateRule;
}

/** One message that stays in the output. */
export interface KeptMessage {
  /** The representative copy, unchanged (same object as in the input). */
  readonly message: NormalizedMessage;
  /** Position of `message` in the input array. */
  readonly index: number;
  /** Every other copy merged into this one, in input order. Empty if none. */
  readonly duplicates: readonly MergedCopy[];
  /**
   * Engine warnings for this message and its merged copies, sorted by code,
   * one entry per code. The parser's own warnings stay on `message.warnings`, untouched.
   */
  readonly warnings: readonly DedupeWarning[];
}

export interface DedupeResult {
  /** Kept messages, in the input order of their representative. */
  readonly kept: readonly KeptMessage[];
  /** How many copies were merged in total (the sum of every `duplicates` length). */
  readonly mergedCount: number;
}

/**
 * How far apart two dates may be under the Message-ID rule: a .msg submit
 * time can differ slightly from the .eml Date header of the same message.
 */
export const DATE_TOLERANCE_MS = 120_000;

/**
 * At most this many positions are listed in a warning's `related`
 * (`relatedTotal` keeps the true count). Thousands of conflicting copies of
 * one message would otherwise make every warning, and the memory to build
 * it, grow with the square of the number of copies.
 */
export const MAX_RELATED = 20;

/**
 * The body text as compared for de-duplication. Deliberately conservative,
 * so only differences that come from the file format are ignored:
 * - CRLF and lone CR line ends become LF (.msg stores CRLF, .eml often LF),
 * - Unicode NFC (an "e" with an acute accent stored as one code point or as "e" + accent is the same text),
 * - trailing spaces/tabs at the end of each line are dropped (mail software
 *   adds or strips them, e.g. format=flowed),
 * - blank lines at the very start and end are dropped (an .eml body ends
 *   with a line break, an Outlook body property does not).
 * Nothing else: no case folding, no collapsing of inner blank lines or
 * spaces, no quote stripping. Two bodies that differ in any other way are
 * different messages.
 *
 * Only used for comparing: the message's own `bodyText` is never replaced.
 */
export function normalizeBody(bodyText: string): string {
  const lines = bodyText
    .replace(/\r\n?/g, '\n')
    .normalize('NFC')
    .split('\n')
    // `\s` would also eat non-breaking and other Unicode spaces; only plain
    // spaces and tabs are trailing "format noise".
    .map((line) => line.replace(/[ \t]+$/, ''));
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === '') start++;
  while (end > start && lines[end - 1] === '') end--;
  return lines.slice(start, end).join('\n');
}

/**
 * The subject as compared: NFC, outer spaces dropped, inner runs of spaces
 * (and folded header line breaks) made one space. No case folding and no
 * stripping of "Re:" or "[External]": those make it a different subject.
 */
export function subjectKey(subject: string): string {
  return subject.normalize('NFC').trim().replace(/\s+/g, ' ');
}

/**
 * The whole From list as compared: lower-cased addresses, sorted (order
 * ignored, repeats kept); a mailbox without an address counts by its name.
 */
export function fromKey(message: NormalizedMessage): string {
  return JSON.stringify(message.from.map(mailboxKey).sort());
}

/**
 * The author: the lower-cased address of the first From mailbox, or of
 * `sender` when there is no From (then `sender` is the only author
 * information, see NormalizedMessage.sender). '' if neither has an address.
 * The author-date rule needs it to be non-empty.
 */
export function authorKey(message: NormalizedMessage): string {
  const first = message.from[0];
  if (first !== undefined) return first.address.toLowerCase();
  return message.sender?.address.toLowerCase() ?? '';
}

// ---------------------------------------------------------------- internals

/** One mailbox as compared: its lower-cased address, or `name:<name>` if it has none. */
function mailboxKey(m: { readonly name: string; readonly address: string }): string {
  return m.address !== '' ? m.address.toLowerCase() : `name:${m.name}`;
}

/** Everything about one input message that the comparison needs, computed once. */
interface Prepared {
  readonly message: NormalizedMessage;
  readonly index: number;
  /**
   * Body, subject, attachment names, From list and the body-missing parser
   * warnings together: two messages can only be duplicates if these are
   * equal, so they are bucketed by it.
   */
  readonly bucketKey: string;
  readonly author: string;
  readonly to: ReadonlySet<string>;
  readonly cc: ReadonlySet<string>;
  readonly bcc: ReadonlySet<string>;
  /** See `mailboxKey`; null if there is no sender. */
  readonly sender: string | null;
  readonly references: ReadonlySet<string>;
  /**
   * Everything `compareInBucket` looks at besides the bucket key: Message-ID,
   * date, author, recipient sets, sender and threading headers. Two copies
   * in one bucket with the same signature compare the same way with every
   * other message (see `Twins`).
   */
  readonly signature: string;
}

function prepare(message: NormalizedMessage, index: number): Prepared {
  // The parts are compared as plain strings. No hash is needed: everything
  // is in memory anyway, and comparing strings cannot collide. JSON quotes
  // and escapes each part, so the combined key is unambiguous.
  const names = message.attachments.map((a) => a.fileName).sort();
  const bucketKey = JSON.stringify([
    names,
    fromKey(message),
    subjectKey(message.subject),
    normalizeBody(message.bodyText),
    message.warnings.includes('html-body-unreadable'),
    message.warnings.includes('html-body-truncated'),
    message.warnings.includes('rtf-only-body'),
  ]);
  const author = authorKey(message);
  const to = new Set(message.to.map(mailboxKey));
  const cc = new Set(message.cc.map(mailboxKey));
  const bcc = new Set(message.bcc.map(mailboxKey));
  const sender = message.sender === undefined ? null : mailboxKey(message.sender);
  const references = new Set(message.references);
  const sorted = (set: ReadonlySet<string>) => [...set].sort();
  const signature = JSON.stringify([
    message.messageId,
    message.date.utcMs,
    author,
    sorted(to),
    sorted(cc),
    sorted(bcc),
    sender,
    message.inReplyTo,
    sorted(references),
  ]);
  return { message, index, bucketKey, author, to, cc, bcc, sender, references, signature };
}

function isSuperset(big: ReadonlySet<string>, small: ReadonlySet<string>): boolean {
  for (const item of small) if (!big.has(item)) return false;
  return true;
}

/** True if `a`'s To, Cc and Bcc each contain all of `b`'s. */
function recipientsCover(a: Prepared, b: Prepared): boolean {
  return isSuperset(a.to, b.to) && isSuperset(a.cc, b.cc) && isSuperset(a.bcc, b.bcc);
}

/** True if `b` has no sender or the same one as `a`. */
function senderCovers(a: Prepared, b: Prepared): boolean {
  return b.sender === null || b.sender === a.sender;
}

/** True if `b` has no In-Reply-To or the same as `a`, and `a` has all of `b`'s References. */
function threadingCovers(a: Prepared, b: Prepared): boolean {
  const reply = b.message.inReplyTo;
  return (reply === null || reply === a.message.inReplyTo) && isSuperset(a.references, b.references);
}

/** True if `b` has no date or `a` has one: a known date is never dropped. */
function dateCovers(a: Prepared, b: Prepared): boolean {
  return b.message.date.utcMs === null || a.message.date.utcMs !== null;
}

/**
 * True if keeping `a` instead of `b` loses no header data.
 *
 * "Covers" is a partial order (each part is an inclusion). So in a group
 * where every pair is comparable, one copy covers all the others; that
 * copy becomes the representative.
 */
function covers(a: Prepared, b: Prepared): boolean {
  return recipientsCover(a, b) && senderCovers(a, b) && threadingCovers(a, b) && dateCovers(a, b);
}

/**
 * True if keeping `kept` instead of `other` loses no header data (rule 6:
 * To, Cc, Bcc, sender, In-Reply-To, References, a date when `other` has
 * one) AND both have the same date (the same instant, or both none). Used
 * for a copy kept by the D2 exception above (task 8.13b-3, review round 4):
 * when false, `other` held something the kept copy's header rows do not
 * show.
 */
export function keepsHeaderData(kept: NormalizedMessage, other: NormalizedMessage): boolean {
  return kept.date.utcMs === other.date.utcMs && covers(prepare(kept, 0), prepare(other, 1));
}

/** Options of `dedupe`. */
export interface DedupeOptions {
  /**
   * Input position of the first email attached inside a dropped file: every
   * message from there on is one (src/engine/engine.ts puts them after the
   * files' own emails). Absent: none (every message is a dropped file's own
   * email). See the D2 exception at the top of this file.
   */
  readonly firstAttached?: number;
}

/** Why neither copy covers the other (see the warning codes). */
function whyNotCovered(a: Prepared, b: Prepared): DedupeWarningCode {
  if (!recipientsCover(a, b) && !recipientsCover(b, a)) return 'duplicate-recipients-differ';
  if (!senderCovers(a, b) && !senderCovers(b, a)) return 'duplicate-sender-differs';
  // Each part alone is comparable, but no copy holds all of them. Name the
  // threading headers if they are part of the problem, then the date (one
  // copy has none), else the sender. (Dates alone are always comparable.)
  if (!threadingCovers(a, b) || !threadingCovers(b, a)) return 'duplicate-threading-differs';
  if (!dateCovers(a, b) || !dateCovers(b, a)) return 'duplicate-date-differs';
  // Only a sender-vs-recipients mix is left, e.g. one copy has a sender and
  // the other has no sender but more recipients.
  return 'duplicate-sender-differs';
}

/**
 * The result of comparing two messages: the rule that proves they are
 * duplicates, or the warning that explains why they are not (null when they
 * are simply unrelated).
 */
type Comparison = { readonly rule: DuplicateRule } | { readonly warning: DedupeWarningCode | null };

/**
 * Compares two messages of the SAME bucket (so body, subject, attachment
 * names, From and the body-missing warnings are already equal).
 */
function compareInBucket(a: Prepared, b: Prepared): Comparison {
  const sameId = a.message.messageId !== null && a.message.messageId === b.message.messageId;
  const aMs = a.message.date.utcMs;
  const bMs = b.message.date.utcMs;
  const sameAuthorDate = a.author !== '' && b.author !== '' && aMs !== null && aMs === bMs;
  if (!sameId && !sameAuthorDate) return { warning: null };
  if (!sameAuthorDate && aMs !== null && bMs !== null && Math.abs(aMs - bMs) > DATE_TOLERANCE_MS) {
    return { warning: 'duplicate-date-differs' };
  }
  if (!covers(a, b) && !covers(b, a)) return { warning: whyNotCovered(a, b) };
  return { rule: sameId ? 'message-id' : 'author-date-body' };
}

function isDuplicate(a: Prepared, b: Prepared): boolean {
  return 'rule' in compareInBucket(a, b);
}

/** Canonical order for grouping: by file hash, then name, then input position (see `dedupe`). */
function canonicalOrder(a: Prepared, b: Prepared): number {
  const sa = a.message.source;
  const sb = b.message.source;
  if (sa.sha256 !== sb.sha256) return sa.sha256 < sb.sha256 ? -1 : 1;
  if (sa.fileName !== sb.fileName) return sa.fileName < sb.fileName ? -1 : 1;
  return a.index - b.index;
}

/** Adds `item` to the list stored under `key`, creating the list if needed. */
function pushTo<K, V>(map: Map<K, V[]>, key: K, item: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [item]);
  else list.push(item);
}

/**
 * Copies in one bucket with the same `signature` that are duplicates of each
 * other (they share a Message-ID, or an author and a date). Such copies
 * compare the same way with every other message, so they always end up in
 * the same group, and the engine compares one of them (`first`) on behalf
 * of all. Thousands of identical copies then cost one comparison, not
 * millions. Copies with neither a Message-ID nor an author and date are
 * never duplicates, so each one is its own `Twins`.
 */
interface Twins {
  /** The first member in canonical order; stands for all members in comparisons. */
  readonly first: Prepared;
  /** All members, in canonical order. */
  readonly members: Prepared[];
}

/** A warning in the making: the true count and the lowest MAX_RELATED positions. */
interface Related {
  readonly total: number;
  readonly first: readonly number[];
}

/**
 * The MAX_RELATED smallest numbers of several lists that share no number.
 * Only the first MAX_RELATED entries of each list are read, so the result is
 * correct only if each list is ascending AND already starts with that list's
 * own lowest MAX_RELATED numbers (true for a full sorted list or for a list
 * of its lowest MAX_RELATED numbers; false for an arbitrary ascending subset).
 */
function lowest(lists: readonly (readonly number[])[]): number[] {
  const all: number[] = [];
  for (const list of lists) for (let i = 0; i < list.length && i < MAX_RELATED; i++) all.push(list[i]!);
  return all.sort((a, b) => a - b).slice(0, MAX_RELATED);
}

/** One group of duplicates, with the warnings found inside its bucket. */
interface Group {
  readonly twins: readonly Twins[];
  readonly related: ReadonlyMap<DedupeWarningCode, Related>;
}

/**
 * Groups one bucket (listed in canonical order) and finds the warnings of
 * each group against the other messages of the bucket.
 */
function groupBucket(bucket: readonly Prepared[]): Group[] {
  // The date only counts for messages with an author (rule b).
  const useDate = (p: Prepared) => p.author !== '' && p.message.date.utcMs !== null;
  const all: Twins[] = [];
  const twinsByKey = new Map<string, Twins>();
  for (const p of bucket) {
    // A signature is a JSON array, so it never starts with '#'.
    const key = p.message.messageId !== null || useDate(p) ? p.signature : `#${String(p.index)}`;
    const twins = twinsByKey.get(key);
    if (twins !== undefined) twins.members.push(p);
    else {
      const created = { first: p, members: [p] };
      twinsByKey.set(key, created);
      all.push(created);
    }
  }
  /** Each Twins' lowest MAX_RELATED input positions, ascending. */
  const lowestOf = new Map(all.map((t) => [t, lowest([t.members.map((p) => p.index).sort((a, b) => a - b)])]));

  // Index by Message-ID and by date.
  const idIndex = new Map<string, Twins[]>();
  const dateIndex = new Map<number, Twins[]>();
  for (const t of all) {
    if (t.first.message.messageId !== null) pushTo(idIndex, t.first.message.messageId, t);
    if (useDate(t.first)) pushTo(dateIndex, t.first.message.date.utcMs!, t); // `!`: checked by useDate
  }
  /** Calls `visit` once for every other Twins sharing t's Message-ID or date. */
  const forEachCandidate = (t: Twins, visit: (u: Twins) => void): void => {
    const p = t.first;
    const id = p.message.messageId;
    if (id !== null) for (const u of idIndex.get(id)!) if (u !== t) visit(u);
    if (!useDate(p)) return;
    for (const u of dateIndex.get(p.message.date.utcMs!)!) {
      if (u !== t && (id === null || u.first.message.messageId !== id)) visit(u); // skip those seen by id
    }
  };

  // 1. Groups, in canonical order. A group can only take t if all its
  // members are duplicates of t, so only groups holding a candidate are
  // tried. All members of a Twins join together (see `Twins`).
  const groups: Twins[][] = [];
  const groupNumber = new Map<Twins, number>();
  for (const t of all) {
    const tried = new Set<number>();
    forEachCandidate(t, (u) => {
      const n = groupNumber.get(u);
      if (n !== undefined) tried.add(n);
    });
    const n = [...tried].sort((x, y) => x - y).find((k) => groups[k]!.every((u) => isDuplicate(t.first, u.first)));
    let groupIndex: number;
    if (n === undefined) {
      groupIndex = groups.length;
      groups.push([]);
    } else {
      groupIndex = n;
    }
    groups[groupIndex]!.push(t);
    groupNumber.set(t, groupIndex);
  }

  // 2. Warnings, one group at a time, so only one group's sets are in
  // memory: why candidates outside the group were not merged with it. A
  // candidate that IS a duplicate of a member was kept apart only because
  // of a third message ('possible-duplicate-not-merged').
  return groups.map((twins, number) => {
    const found = new Map<DedupeWarningCode, Set<Twins>>();
    for (const t of twins) {
      forEachCandidate(t, (u) => {
        if (groupNumber.get(u) === number) return;
        const result = compareInBucket(t.first, u.first);
        const code = 'rule' in result ? 'possible-duplicate-not-merged' : result.warning;
        if (code === null) return;
        const set = found.get(code);
        if (set === undefined) found.set(code, new Set([u]));
        else set.add(u);
      });
    }
    const related = new Map<DedupeWarningCode, Related>();
    for (const [code, set] of found) {
      let total = 0;
      for (const u of set) total += u.members.length;
      related.set(code, { total, first: lowest([...set].map((u) => lowestOf.get(u)!)) });
    }
    return { twins, related };
  });
}

/**
 * Merges provably identical messages (see the rules at the top of this file).
 *
 * `messages`: the successfully parsed messages, in input order. They are not
 * modified; the result refers to the same objects.
 *
 * Grouping: "is a duplicate of" is NOT transitive. A can match B by
 * Message-ID and B match C by author + date while A and C differ, or two
 * copies can each be covered by a third without covering each other. A plain
 * union-find would then chain A and C together. So a message joins a group
 * only if it is a duplicate of EVERY member already in it; otherwise it
 * tries the next group, or starts a new one. Messages are placed in a
 * canonical order (by SHA-256 of the file, then file name), so the groups do
 * not depend on the order the files were dropped in.
 *
 * Speed: messages are first bucketed by `bucketKey`, which every duplicate
 * pair must share. Inside a bucket only messages sharing a Message-ID or a
 * date can match, so only those pairs are compared, copies with identical
 * header data are compared once for all (see `Twins`), and nothing is stored
 * per pair. A thousand "Thanks!" replies with different dates cost almost
 * nothing. Messages sharing a Message-ID across buckets get the
 * 'same-id-different-content' warning. Each warning lists at most
 * MAX_RELATED positions.
 */
export function dedupe(messages: readonly NormalizedMessage[], options: DedupeOptions = {}): DedupeResult {
  const prepared = messages.map(prepare);
  const firstAttached = typeof options.firstAttached === 'number' ? options.firstAttached : messages.length;

  // Buckets, each listed in canonical order.
  const buckets = new Map<string, Prepared[]>();
  for (const p of [...prepared].sort(canonicalOrder)) pushTo(buckets, p.bucketKey, p);
  const groups: Group[] = [];
  // Appended one by one: a spread into push overflows the stack for very long lists.
  for (const bucket of buckets.values()) for (const group of groupBucket(bucket)) groups.push(group);

  const sameId = sameIdDifferentContent(prepared);
  const reps = groups.map((group) => {
    const members = group.twins.flatMap((t) => t.members);
    return { group, members, rep: pickRepresentative(members, firstAttached) };
  });
  reps.sort((a, b) => a.rep.index - b.rep.index);

  // One kept message per group, in the input order of its representative.
  const kept: KeptMessage[] = [];
  let mergedCount = 0;
  for (const { group, members, rep } of reps) {
    const others = members.filter((p) => p !== rep).sort((a, b) => a.index - b.index);
    const related = new Map(group.related);
    const other = sameId(rep.bucketKey, members);
    if (other.total > 0) related.set('same-id-different-content', other);
    kept.push({
      message: rep.message,
      index: rep.index,
      duplicates: others.map((p) => ({ source: p.message.source, index: p.index, rule: ruleBetween(rep, p) })),
      warnings: [...related]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([code, r]) => ({ code, related: r.first, relatedTotal: r.total })),
    });
    mergedCount += others.length;
  }
  return { kept, mergedCount };
}

/**
 * Returns a function giving, for a group (its bucket key and members), the
 * messages that share a Message-ID with a member but are in another bucket
 * (so their content differs). Nothing is stored per pair: for each
 * Message-ID only its messages and a count per bucket are kept.
 */
function sameIdDifferentContent(prepared: readonly Prepared[]): (bucketKey: string, members: readonly Prepared[]) => Related {
  /** Per Message-ID: its messages in input order, and how many are in each bucket. */
  const byId = new Map<string, { readonly list: Prepared[]; readonly perBucket: Map<string, number> }>();
  for (const p of prepared) {
    const id = p.message.messageId;
    if (id === null) continue;
    let entry = byId.get(id);
    if (entry === undefined) byId.set(id, (entry = { list: [], perBucket: new Map<string, number>() }));
    entry.list.push(p);
    entry.perBucket.set(p.bucketKey, (entry.perBucket.get(p.bucketKey) ?? 0) + 1);
  }
  /** Memo: Message-ID -> bucket key -> lowest MAX_RELATED positions outside that bucket. */
  const memo = new Map<string, Map<string, number[]>>();
  return (bucketKey, members) => {
    let total = 0;
    const lists: number[][] = [];
    for (const id of new Set(members.map((p) => p.message.messageId))) {
      if (id === null) continue;
      const entry = byId.get(id)!; // `!`: every id was indexed
      const outside = entry.list.length - entry.perBucket.get(bucketKey)!;
      if (outside === 0) continue;
      total += outside;
      let perBucket = memo.get(id);
      if (perBucket === undefined) memo.set(id, (perBucket = new Map<string, number[]>()));
      let first = perBucket.get(bucketKey);
      if (first === undefined) {
        first = [];
        for (const p of entry.list) {
          if (first.length === MAX_RELATED) break;
          if (p.bucketKey !== bucketKey) first.push(p.index);
        }
        perBucket.set(bucketKey, first);
      }
      lists.push(first);
    }
    return { total, first: lowest(lists) };
  };
}

/**
 * The copy to keep: the one that covers every other copy (largest recipient
 * sets; has the sender and threading data if any copy has them). Copies that
 * cover each other hold the same header data; then the earliest in input order wins.
 * D2 (see the top of this file): when the group holds a dropped file's own
 * email (input position below `firstAttached`) and an attached copy, the
 * choice is made among the dropped files' emails only.
 */
function pickRepresentative(group: readonly Prepared[], firstAttached: number): Prepared {
  const dropped = group.filter((p) => p.index < firstAttached);
  const byIndex = [...(dropped.length > 0 ? dropped : group)].sort((a, b) => a.index - b.index);
  // In a valid group every pair is comparable, so one pass finds the top:
  // switch only to a copy that strictly covers the current best.
  let top = byIndex[0]!; // `!`: a group is never empty
  for (const p of byIndex) if (covers(p, top) && !covers(top, p)) top = p;
  if (!byIndex.every((other) => covers(top, other))) {
    throw new Error('dedupe: group without a representative (internal error)');
  }
  return top;
}

function ruleBetween(a: Prepared, b: Prepared): DuplicateRule {
  const result = compareInBucket(a, b);
  if (!('rule' in result)) throw new Error('dedupe: group members are not duplicates (internal error)');
  return result.rule;
}
