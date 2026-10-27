// The messages rebuilt from quoted text, as step 2 shows them (milestone 7,
// task 7.6; brief section 8.6). The engine rebuilds them and places them in
// one timeline with the real emails (src/engine/rebuild-links.ts); this file
// only decides what the preview shows of them, in which order, and which of
// them the reader wants in the PDF. It decides nothing about the text.
//
// What is shown (user decisions 2026-10-27):
// - Only rebuilt messages with their own timeline entry (link 'entry') get a
//   card, at their place in the timeline. One linked to a real dropped email
//   ('real') gets none: the real file wins. A copy of another rebuilt one
//   ('same-as') gets none either: its entry says "same quoted text also in
//   email #K" instead (alsoNumbers).
// - A card shows the rebuilt text (quote marks and their indentation
//   removed: the one form change the user allowed, with a fixed note), its
//   sender, recipients, subject and date as read from the quoted header,
//   and the number of the email it was taken from. It has NO number of its
//   own: numbers belong to the real emails.
// - Collapse, never delete (brief section 7): a card is only a second view
//   of a part of its source email. The source email's own card is not
//   changed and keeps every character of its text.
//
// Which rebuilt messages go into the PDF (RebuiltSelection): all of them by
// default; one switch leaves ALL of them out, and each card has its own
// checkbox, like a real email. Like src/ui-model/selection.ts, a choice is
// remembered by stable keys that survive adding more files (the list is then
// worked out again and ids change): the SHA-256 of the source file plus the
// offset where the quoted header starts in its body, for the entry and for
// every copy of it (and for every file merged into a source). A rebuilt
// message is left out if ANY of its keys was left out. The PDF step (task
// 7.7) reads includedRebuilt(). Memory only (README.md, rule R5).
//
// Pure functions, no DOM (README.md, rule R7).

import type { EngineMessage, EngineRebuilt, EngineResult, TimelineEntry } from '../engine/engine';
import type { EmailAddress } from '../parsing/types';
import { selectionKeys } from './selection';

/** One place in the preview list: a real email (its list position) or a rebuilt entry (its id). */
export type PreviewSlot = { readonly kind: 'message'; readonly position: number } | { readonly kind: 'rebuilt'; readonly id: number };

/**
 * The preview's order: the engine's timeline. Defensive: if the timeline is
 * missing or does not hold every real email exactly once, or names a rebuilt
 * message that is not an entry, the real emails alone in list order (never
 * an email missing because of a bad timeline).
 */
export function previewOrder(result: Pick<EngineResult, 'messages' | 'timeline' | 'reconstructed'>): PreviewSlot[] {
  const plain = (): PreviewSlot[] => result.messages.map((_, position) => ({ kind: 'message', position }));
  // (Array.isArray would turn a readonly array's type into any[]: hence the typed copies.)
  const timeline: readonly TimelineEntry[] | undefined = Array.isArray(result.timeline) ? result.timeline : undefined;
  const reconstructed: readonly EngineRebuilt[] = Array.isArray(result.reconstructed) ? result.reconstructed : [];
  if (timeline === undefined) return plain();
  const seen = new Set<number>();
  const seenIds = new Set<number>();
  const out: PreviewSlot[] = [];
  for (const entry of timeline) {
    if (entry.kind === 'message') {
      const p = entry.position;
      if (!Number.isInteger(p) || p < 0 || p >= result.messages.length || seen.has(p)) return plain();
      seen.add(p);
      out.push({ kind: 'message', position: p });
    } else {
      const r = reconstructed[entry.id];
      if (r === undefined || r.id !== entry.id || r.link !== 'entry' || seenIds.has(entry.id)) return plain();
      seenIds.add(entry.id);
      out.push({ kind: 'rebuilt', id: entry.id });
    }
  }
  return seen.size === result.messages.length ? out : plain();
}

/** The rebuilt messages that get a card (link 'entry'), in preview order. */
export function rebuiltEntries(result: Pick<EngineResult, 'messages' | 'timeline' | 'reconstructed'>): EngineRebuilt[] {
  const out: EngineRebuilt[] = [];
  for (const slot of previewOrder(result)) {
    if (slot.kind !== 'rebuilt') continue;
    const r = result.reconstructed[slot.id];
    if (r !== undefined) out.push(r);
  }
  return out;
}

/** The kept email a rebuilt message was taken from, or undefined (not expected). */
export function sourceMessageOf(r: Pick<EngineRebuilt, 'sourceIndex'>, result: Pick<EngineResult, 'messages' | 'positionByIndex'>): EngineMessage | undefined {
  const position = result.positionByIndex[r.sourceIndex];
  return typeof position === 'number' ? result.messages[position] : undefined;
}

/** The list number (1-based, "#3") of the email a rebuilt message was taken from; null if unknown (not expected). */
export function sourceNumber(r: Pick<EngineRebuilt, 'sourceIndex'>, result: Pick<EngineResult, 'positionByIndex'>): number | null {
  const position = result.positionByIndex[r.sourceIndex];
  return typeof position === 'number' ? position + 1 : null;
}

/**
 * The list numbers of the OTHER emails that quote the same text
 * (alsoQuotedIn, input positions), ascending, unique, without the source
 * itself and without unknown positions.
 */
export function alsoNumbers(r: Pick<EngineRebuilt, 'sourceIndex' | 'alsoQuotedIn'>, result: Pick<EngineResult, 'positionByIndex'>): number[] {
  const own = sourceNumber(r, result);
  const numbers = new Set<number>();
  for (const index of r.alsoQuotedIn) {
    const position = result.positionByIndex[index];
    if (typeof position === 'number' && position + 1 !== own) numbers.add(position + 1);
  }
  return [...numbers].sort((a, b) => a - b);
}

/** The keys of one rebuilt entry: source file hash + "@" + header offset, for it and every copy (see the top). */
export function rebuiltSelectionKeys(r: EngineRebuilt, result: Pick<EngineResult, 'messages' | 'positionByIndex' | 'reconstructed'>): string[] {
  const keys = new Set<string>();
  const add = (x: EngineRebuilt | undefined): void => {
    if (x === undefined) return;
    const source = sourceMessageOf(x, result);
    if (source === undefined) return;
    for (const hash of selectionKeys(source)) keys.add(`${hash}@${String(x.rebuilt.start)}`);
  };
  add(r);
  for (const id of r.copies) add(result.reconstructed[id]);
  return [...keys];
}

/** The rebuilt messages' include choices (memory only). */
export interface RebuiltSelection {
  /** The switch: false leaves every rebuilt message out of the PDF (and out of the preview list). */
  includeAll(): boolean;
  setIncludeAll(included: boolean): void;
  /** The card's own checkbox: true unless the reader left it out (whatever the switch says). */
  isTicked(r: EngineRebuilt, result: EngineResult): boolean;
  setTicked(r: EngineRebuilt, result: EngineResult, ticked: boolean): void;
  /** Goes into the PDF: the switch is on and the card is ticked. */
  isIncluded(r: EngineRebuilt, result: EngineResult): boolean;
  /** Back to the defaults: switch on, every card ticked. */
  clear(): void;
}

export function createRebuiltSelection(): RebuiltSelection {
  const excluded = new Set<string>();
  let all = true;
  const isTicked = (r: EngineRebuilt, result: EngineResult): boolean => !rebuiltSelectionKeys(r, result).some((k) => excluded.has(k));
  return {
    includeAll: () => all,
    setIncludeAll(included) {
      all = included;
    },
    isTicked,
    setTicked(r, result, ticked) {
      for (const key of rebuiltSelectionKeys(r, result)) {
        if (ticked) excluded.delete(key);
        else excluded.add(key);
      }
    },
    isIncluded: (r, result) => all && isTicked(r, result),
    clear() {
      excluded.clear();
      all = true;
    },
  };
}

/** The rebuilt entries going into the PDF, in preview (timeline) order. */
export function includedRebuilt(result: EngineResult, selection: RebuiltSelection): EngineRebuilt[] {
  if (!selection.includeAll()) return [];
  return rebuiltEntries(result).filter((r) => selection.isIncluded(r, result));
}

/** A rebuilt message's date, as the card shows it. */
export type RebuiltDate =
  /** The quoted header has no date. */
  | { readonly kind: 'none' }
  /** A date text that could not be read: shown as written only. */
  | { readonly kind: 'unreadable'; readonly text: string }
  /** A date with a time: shown in the chosen zone, "about" when approximate. */
  | { readonly kind: 'moment'; readonly utcMs: number; readonly approximate: boolean; readonly text: string }
  /** A day without a time: shown as written (YYYY-MM-DD), "about" when approximate. */
  | { readonly kind: 'day'; readonly day: string; readonly approximate: boolean; readonly text: string };

/** The date of a rebuilt message (see RebuiltDate). */
export function rebuiltDate(r: Pick<EngineRebuilt, 'rebuilt'>): RebuiltDate {
  const { dateText, date, dateApproximate } = r.rebuilt;
  if (dateText === null || dateText.trim() === '') return { kind: 'none' };
  const text = dateText;
  if (date === null) return { kind: 'unreadable', text };
  if (date.precision === 'minute' && typeof date.estimatedUtcMs === 'number' && Number.isFinite(date.estimatedUtcMs)) {
    return { kind: 'moment', utcMs: date.estimatedUtcMs, approximate: dateApproximate, text };
  }
  if (date.precision === 'day' && typeof date.wallMs === 'number' && Number.isFinite(date.wallMs)) {
    const d = new Date(date.wallMs);
    if (!Number.isNaN(d.getTime())) return { kind: 'day', day: d.toISOString().slice(0, 10), approximate: dateApproximate, text };
  }
  return { kind: 'unreadable', text };
}

const blank = (m: EmailAddress): boolean => m.name.trim() === '' && m.address.trim() === '';

/** What a rebuilt card shows (no DOM; the words come from the strings module). */
export interface RebuiltCard {
  readonly id: number;
  /** null: the quoted header has no subject (an "On ... wrote:" line never has one). */
  readonly subject: string | null;
  /** The sender's mailboxes, blank ones left out; [] = sender unknown. */
  readonly from: readonly EmailAddress[];
  readonly to: readonly EmailAddress[];
  readonly cc: readonly EmailAddress[];
  /** The To / Cc lists that may go on past what was read: "list may be incomplete". */
  readonly toIncomplete: boolean;
  readonly ccIncomplete: boolean;
  readonly date: RebuiltDate;
  /** The list number of the email it was taken from (null: unknown, not expected). */
  readonly sourceNumber: number | null;
  /** The other emails quoting the same text ("same quoted text also in email #K, #L"). */
  readonly alsoNumbers: readonly number[];
  /** Quote marks were removed from the text (the note says so). */
  readonly quoteMarksRemoved: boolean;
  /** The rebuilt text (shown as it is, as text). */
  readonly text: string;
}

export function rebuiltCard(r: EngineRebuilt, result: Pick<EngineResult, 'positionByIndex'>): RebuiltCard {
  const m = r.rebuilt;
  return {
    id: r.id,
    subject: m.subject !== null && m.subject.trim() !== '' ? m.subject : null,
    from: m.from.filter((x) => !blank(x)),
    to: m.to.filter((x) => !blank(x)),
    cc: m.cc.filter((x) => !blank(x)),
    toIncomplete: m.incomplete.includes('to'),
    ccIncomplete: m.incomplete.includes('cc'),
    date: rebuiltDate(r),
    sourceNumber: sourceNumber(r, result),
    alsoNumbers: alsoNumbers(r, result),
    quoteMarksRemoved: m.quoteMarksRemoved,
    text: m.reconstructedText,
  };
}
