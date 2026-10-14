// Step 2, around the list of emails (src/ui/preview.ts):
// - at the top, the counts: files given and how many could not be read
//   (pointing to step 1, which already lists them with the reasons), emails
//   found and identical copies merged, "N of M emails will be in the PDF"
//   and how many emails have notes. The numbers are the engine's own counts;
//   nothing is counted again here;
// - on each email (through the preview's `decorate` hook), an "Include in
//   the PDF" checkbox and the email's notes (src/ui-model/message-notes.ts).
//
// Include/exclude (README.md, rule R6: collapse, never delete): every email
// starts ticked. An unticked email stays in the list with all its text,
// dimmed and marked "Not in the PDF"; it is only left out of the PDF. The
// choices are kept by file hash (src/ui-model/selection.ts), so they survive
// adding more files (the whole set is run again) and are forgotten by
// reset(). They live in memory only (README.md, rule R5).
// includedPositions() / includedMessages() give the PDF step the emails to
// put in, in list order.
//
// Never silently excluded: what counts is what the page shows. Once the
// preview has finished building a list (its `onRendered` hook), an email
// without a decorated item counts as INCLUDED, whatever was chosen for its
// file before. Only a bug causes that: `decorate` failed on both the item
// and its stand-in, so the page shows a plain stand-in with all its text
// but no checkbox and no "Not in the PDF" mark. Such an email is never
// dropped either: it is in the counts and in the PDF. While the list is
// still being built, emails not yet in the page follow the choices.
//
// Safety: only our own words and numbers are added here, as text through
// el() (README.md, rule R4).
//
// Use (src/ui/page.ts): createReview(), then pass `element` as the
// preview's `header`, `decorate` as its `decorate` and `rendered` as its
// `onRendered`, and give each new result to review.showResult BEFORE
// preview.showResult, so the review knows the result before the preview
// reports it complete (an empty list is complete at once). decorate picks
// up a new result by itself, and showing the same result twice changes
// nothing. rendered only completes the result already shown (by decorate or
// showResult): it ignores any other. reset() is for "Clear everything".

import type { EngineCounts, EngineMessage, EngineResult } from '../engine/engine';
import type { ProcessResult } from '../pipeline/process-files';
import { messageNotes, type MessageNote } from '../ui-model/message-notes';
import { createSelection } from '../ui-model/selection';
import { el, setSafeAttribute } from './dom';
import { t } from './i18n';
import { headingId, joinList, messageNumberText } from './preview';

// ---------------------------------------------------------------------------
// Pure helpers (no DOM; unit tested directly).

/**
 * "See emails #3, #5." for a note about look-alike emails, plus "2 more files
 * are involved." when the engine cut its list; '' if none. `more` counts
 * files, not emails (see MessageNote in src/ui-model/message-notes.ts).
 */
export function relatedText(numbers: readonly number[], more: number): string {
  if (numbers.length === 0) return more > 0 ? t('review.relatedOnlyMore', { count: more }) : '';
  const list = joinList(numbers.map(messageNumberText));
  const see = numbers.length === 1 ? t('review.relatedOne', { list }) : t('review.relatedMany', { list });
  return more > 0 ? `${see} ${t('review.relatedMoreFiles', { count: more })}` : see;
}

/** The text of one note. */
export function noteText(note: MessageNote): string {
  switch (note.kind) {
    case 'parse':
      return t(`warnings.parse.${note.code}`);
    case 'order':
      return t(`preview.order.${note.code}`);
    case 'engine':
      return t(`warnings.engine.${note.code}`);
    case 'dedupe': {
      const label = t(`warnings.dedupe.${note.code}`);
      const related = relatedText(note.related, note.more);
      return related === '' ? label : `${label} ${related}`;
    }
  }
}

/** "12 files, 1 could not be read." */
export function filesText(counts: EngineCounts): string {
  const parts = [t('counts.files', { count: counts.filesGiven })];
  if (counts.filesFailed > 0) parts.push(t('counts.filesFailed', { count: counts.filesFailed }));
  return t('counts.sentence', { text: joinList(parts) });
}

/** "9 emails found, 2 identical copies merged." */
export function messagesText(counts: EngineCounts): string {
  const parts = [t('counts.messagesFound', { count: counts.messagesFound })];
  if (counts.duplicatesMerged > 0) parts.push(t('counts.duplicatesMerged', { count: counts.duplicatesMerged }));
  return t('counts.sentence', { text: joinList(parts) });
}

/** The notes of one email, or none if they cannot be worked out (a broken entry: never stops the page). */
export function safeNotes(m: EngineMessage, position: number, positionByIndex: readonly (number | null)[]): MessageNote[] {
  try {
    return messageNotes(m, position, positionByIndex);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The interface.

export interface Review {
  /** The counts box, for the preview's `header`. */
  readonly element: HTMLDivElement;
  /** The preview's `decorate` hook: adds the include checkbox and the notes to an email's item. */
  readonly decorate: (item: HTMLLIElement, message: EngineMessage, position: number, result: EngineResult) => void;
  /** Shows the counts of a new result. The include choices are kept. */
  show(result: EngineResult): void;
  /** A step 1 result: its counts, or nothing after a batch error (choices kept). */
  showResult(result: ProcessResult): void;
  /** The preview's `onRendered` hook: the list of `result` is complete (see the header comment). */
  readonly rendered: (result: EngineResult) => void;
  /** Forgets every include choice and empties the counts (for "Clear everything"). */
  reset(): void;
  /** List positions (0-based) of the emails to put in the PDF, in list (date) order. */
  includedPositions(): readonly number[];
  /** The emails to put in the PDF, in list (date) order. */
  includedMessages(): readonly EngineMessage[];
}

/** One decorated item. */
interface Entry {
  readonly item: HTMLLIElement;
  readonly message: EngineMessage;
  readonly checkbox: HTMLInputElement;
  readonly excludedNote: HTMLSpanElement;
}

export interface ReviewOptions {
  /**
   * Called with the "N of M emails will be in the PDF" line after each tick
   * or untick, so screen readers hear it (src/ui/page.ts: the shell's status
   * line, the page's one live region).
   */
  readonly announce?: (text: string) => void;
}

export function createReview(options: ReviewOptions = {}): Review {
  // --- State (memory only, README.md, rule R5) ------------------------------
  const selection = createSelection();
  let current: EngineResult | null = null;
  // The latest decorated item per position (a stand-in replaces a failed item).
  let entries = new Map<number, Entry>();
  // The result whose list the preview finished building (see `rendered`).
  let renderedResult: EngineResult | null = null;
  // The parts added to each item, so a second call on the same item adds nothing.
  const added = new WeakMap<HTMLLIElement, Pick<Entry, 'checkbox' | 'excludedNote'>>();

  // --- Counts box -----------------------------------------------------------
  const filesLine = el('span', { attrs: { id: 'review-files-text' } });
  // Plain text, not a link: the page has no links at all yet (see e2e/app-shell.spec.ts).
  const failedPointer = el('span', { attrs: { id: 'review-failed-pointer', hidden: true }, text: t('counts.seeFailed') });
  const messagesLine = el('p', { attrs: { id: 'review-messages', class: 'review-line' } });
  // Not a live region itself: the page has one (the shell's status line); see `announce`.
  const includedLine = el('p', { attrs: { id: 'review-included', class: 'review-line review-included' } });
  const notesLine = el('p', { attrs: { id: 'review-notes', class: 'review-line', hidden: true } });
  const element = el('div', {
    attrs: { id: 'review-summary', class: 'review-summary' },
    children: [
      el('p', { attrs: { id: 'review-files', class: 'review-line' }, children: [filesLine, ' ', failedPointer] }),
      messagesLine,
      includedLine,
      notesLine,
    ],
  });

  /** True if the email goes into the PDF. A broken entry counts as included: never silently left out. */
  function isIncluded(m: EngineMessage | undefined): boolean {
    try {
      return m === undefined || selection.isIncluded(m);
    } catch {
      return true;
    }
  }

  function positions(): number[] {
    if (current === null) return [];
    // Once the list is complete, an email without a registered item (its
    // stand-in could not be decorated, only a bug causes that) shows no
    // checkbox and no "Not in the PDF" mark: it counts as included.
    const complete = renderedResult === current;
    const found: number[] = [];
    current.messages.forEach((m, position) => {
      if ((complete && !entries.has(position)) || isIncluded(m)) found.push(position);
    });
    return found;
  }

  function showIncludedLine(): void {
    includedLine.textContent = current === null ? '' : t('counts.included', { included: positions().length, count: current.messages.length });
  }

  function apply(entry: Entry): void {
    const included = isIncluded(entry.message);
    entry.checkbox.checked = included;
    setSafeAttribute(entry.item, 'data-included', included ? 'true' : 'false');
    setSafeAttribute(entry.excludedNote, 'hidden', included);
  }

  function emptyCounts(): void {
    current = null;
    // Defensive only: each run gives a new result object, so an old
    // renderedResult could never match a later `current` anyway.
    renderedResult = null;
    entries = new Map();
    filesLine.textContent = '';
    setSafeAttribute(failedPointer, 'hidden', true);
    messagesLine.textContent = '';
    includedLine.textContent = '';
    notesLine.textContent = '';
    setSafeAttribute(notesLine, 'hidden', true);
  }

  /** Shows a result's counts; does nothing for the result already shown (its items stay registered). */
  function show(result: EngineResult): void {
    if (result === current) return;
    current = result;
    entries = new Map();
    filesLine.textContent = filesText(result.counts);
    setSafeAttribute(failedPointer, 'hidden', result.counts.filesFailed === 0);
    messagesLine.textContent = messagesText(result.counts);
    let withNotes = 0;
    result.messages.forEach((m, position) => {
      if (safeNotes(m, position, result.positionByIndex).length > 0) withNotes++;
    });
    notesLine.textContent = withNotes > 0 ? t('counts.withNotes', { count: withNotes }) : '';
    setSafeAttribute(notesLine, 'hidden', withNotes === 0);
    showIncludedLine();
  }

  /** Builds the checkbox and notes of one item (only once per item). */
  function build(item: HTMLLIElement, m: EngineMessage, position: number, result: EngineResult): Pick<Entry, 'checkbox' | 'excludedNote'> {
    const id = `include-${String(position)}`;
    const checkbox = el('input', { attrs: { type: 'checkbox', id, class: 'include-checkbox', 'aria-describedby': headingId(position) } });
    const excludedNote = el('span', { attrs: { class: 'excluded-note', hidden: true }, text: t('review.excluded') });
    const children: Node[] = [
      el('div', {
        attrs: { class: 'field field-checkbox message-include' },
        children: [checkbox, el('label', { attrs: { for: id }, text: t('actions.include') }), excludedNote],
      }),
    ];
    const notes = safeNotes(m, position, result.positionByIndex);
    if (notes.length > 0) {
      children.push(
        el('ul', {
          attrs: { class: 'message-notes', 'aria-label': t('review.notesLabel') },
          children: notes.map((note) => el('li', { attrs: { class: 'message-note', 'data-code': note.code }, text: noteText(note) })),
        }),
      );
    }
    checkbox.addEventListener('change', () => {
      selection.setIncluded(m, checkbox.checked);
      // Every shown item: two items can share a file (see selection.ts).
      for (const entry of entries.values()) apply(entry);
      showIncludedLine();
      options.announce?.(includedLine.textContent);
    });
    // Right after the heading (the item's first child), before the details.
    item.insertBefore(el('div', { attrs: { class: 'message-review' }, children }), item.children[1] ?? null);
    return { checkbox, excludedNote };
  }

  const decorate: Review['decorate'] = (item, m, position, result) => {
    if (result !== current) show(result);
    let parts = added.get(item);
    if (parts === undefined) {
      parts = build(item, m, position, result);
      added.set(item, parts);
    }
    // Recorded last: a call that threw above leaves no reference behind.
    const entry: Entry = { item, message: m, ...parts };
    apply(entry);
    entries.set(position, entry);
  };

  return {
    element,
    decorate,
    show,
    showResult(result) {
      if (result.ok) show(result.engine);
      else emptyCounts();
    },
    reset() {
      selection.clear();
      emptyCounts();
    },
    rendered: (result) => {
      // Only the result already shown can be complete: showResult
      // (src/ui/page.ts calls it before the preview's) and decorate (for
      // every email) show it first. Anything else is an older or unknown
      // list; adopting it would bring back old counts. (Should an empty list
      // ever be reported before showResult, it has nothing to complete, and
      // showResult still gives its counts.)
      if (result !== current) return;
      renderedResult = result;
      showIncludedLine();
    },
    includedPositions: positions,
    includedMessages() {
      const messages = current?.messages ?? [];
      return positions().flatMap((position) => {
        const m = messages[position];
        return m === undefined ? [] : [m];
      });
    },
  };
}
