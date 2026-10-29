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
//
// Language change (relabel): the counts are written again from the result
// shown and the number of emails with notes; each decorated item's label,
// "Not in the PDF" mark and notes are rewritten in place from the codes
// kept with them, so no checkbox is rebuilt (ticks and focus stay).
//
// Rebuilt emails (milestone 7, task 7.6; src/ui-model/rebuilt.ts): earlier
// emails rebuilt from quoted text get cards of their own in the preview
// (decorateRebuilt adds their checkbox, like a real email's). All are in
// the PDF by default. One switch, `rebuiltSwitch` (for the preview's
// toolbar, shown only when the result has rebuilt emails or a "could not
// be rebuilt" note, see switchNeeded), leaves ALL of
// them out: their cards are then hidden (each is only a second view of a
// part of an email still in the list, whose card keeps all its text). An
// unticked card stays, dimmed and marked "Not in the PDF", like a real
// email. A rebuilt email follows the emails it was read from (user decision
// Q1 (a), task 7.7; rebuiltInPdf in src/ui-model/rebuilt.ts): while every
// one of them is unticked, its card is dimmed and marked "Not in the PDF:
// the email it comes from is left out" too, whatever its own tick (which is
// kept). A card in the PDF whose own email is unticked, but whose text is
// also quoted in a ticked email, gets a muted "In the PDF: taken from #K"
// line naming the email the PDF takes it from. The counts say how many were found and how many will be in the
// PDF. includedRebuilt() gives the PDF step (task 7.7) the ones to put in.
// A change of the switch or of a card is told through `onRebuiltChange`
// (not `onChange`: the PDF labels of the real emails do not depend on it);
// a real email's tick is told through `onChange`, with the rebuilt line
// added when it changed.
//
// "Print full original text (quoted replies and signatures included)"
// (pdf.everything, read from src/ui/pdf-labels.ts as `unfoldEverything`;
// user decision 2026-10-29, task 7.8c): while it is ticked, the switch
// ("Rebuild conversation from replies", rebuilt.rebuildConversation) shows
// unticked and is disabled, and NO rebuilt email is shown or put in the
// PDF, exactly as with the switch off: every card leaves the list and
// includedRebuilt() is empty. The quoted text stays in the email it comes from, folded
// as usual (collapse, never delete). The reader's own choices are never
// changed by it: the switch's own state and every card's tick are kept, and
// unticking the full-text checkbox brings both back exactly (a switch the
// reader had turned off stays off). While disabled, the switch is described
// (aria-describedby) by a short hidden hint saying why. The page calls
// everythingChanged() after the checkbox changed.
//
// Rebuilding off (the switch off, or "Print full original text" ticked;
// user rule: rebuilt emails then do not figure at all): the counts do not
// mention rebuilt emails (no "N earlier emails rebuilt" part, no "X of N
// rebuilt emails" line), and an email's notes that its quote "could not be
// rebuilt" (reconstruct-failed, reconstruct-limit) are hidden and not
// counted in "N emails with notes" (PM decision, task 7.8c). All of it comes
// back as soon as rebuilding is on again (showRebuiltLine writes it all).
// A change that turns rebuilding off announces the "N of M emails will be
// in the PDF" line instead of the rebuilt one (rebuiltAnnouncement), so an
// older rebuilt line never stays in the status line.

import type { EngineCounts, EngineMessage, EngineRebuilt, EngineResult, ReconstructionWarning } from '../engine/engine';
import type { ProcessResult } from '../pipeline/process-files';
import { messageNotes, type MessageNote } from '../ui-model/message-notes';
import { createRebuiltSelection, rebuiltEntries, rebuiltInPdf } from '../ui-model/rebuilt';
import { createSelection } from '../ui-model/selection';
import { el, setSafeAttribute } from './dom';
import { t } from './i18n';
import { createStaticLabels } from './labels';
import { headingId, joinList, messageNumberText, rebuiltHeadingId } from './preview';

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
    case 'rebuild':
      return t(`warnings.rebuild.${note.code}`);
    case 'dedupe': {
      const label = t(`warnings.dedupe.${note.code}`);
      const related = relatedText(note.related, note.more);
      return related === '' ? label : `${label} ${related}`;
    }
  }
}

/** "12 files, 1 could not be read." */
export function filesText(counts: EngineCounts): string {
  const files = t('counts.files', { count: counts.filesGiven });
  if (counts.filesFailed === 0) return t('counts.sentence', { text: files });
  // A template, not a list: the failed files are among the given ones
  // ("12 fichiers, dont 1", not "12 fichiers et 1").
  const failed = t('counts.filesFailed', { count: counts.filesFailed });
  return t('counts.sentence', { text: t('counts.filesWithFailed', { files, failed }) });
}

/** "9 emails found, 2 identical copies merged, 3 earlier emails rebuilt from quoted text." `rebuilt`: rebuilt cards. */
export function messagesText(counts: EngineCounts, rebuilt = 0): string {
  const parts = [t('counts.messagesFound', { count: counts.messagesFound })];
  if (counts.duplicatesMerged > 0) parts.push(t('counts.duplicatesMerged', { count: counts.duplicatesMerged }));
  if (rebuilt > 0) parts.push(t('counts.rebuiltFound', { count: rebuilt }));
  return t('counts.sentence', { text: joinList(parts) });
}

/** The notes of one email, or none if they cannot be worked out (a broken entry: never stops the page). */
export function safeNotes(
  m: EngineMessage,
  position: number,
  positionByIndex: readonly (number | null)[],
  rebuildWarnings: readonly ReconstructionWarning[] = [],
): MessageNote[] {
  try {
    return messageNotes(m, position, positionByIndex, rebuildWarnings);
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
  /** Writes the counts and every item's words again in the page language now (nothing is rebuilt). */
  relabel(): void;
  /**
   * The "include rebuilt emails" switch field, for the preview's toolbar
   * (hidden when the result has no rebuilt email and no "could not be
   * rebuilt" note).
   */
  readonly rebuiltSwitch: HTMLDivElement;
  /** The preview's `decorateRebuilt` hook: adds the include checkbox to a rebuilt email's card. */
  readonly decorateRebuilt: (item: HTMLLIElement, rebuilt: EngineRebuilt, result: EngineResult) => void;
  /** True while rebuilt cards are shown: the switch is on and "Print full original text" is unticked. */
  rebuiltShown(): boolean;
  /** The rebuilt emails to put in the PDF, in list (timeline) order: ticked, and an email they were read from included; [] when the switch is off or "Print full original text" is ticked. */
  includedRebuilt(): readonly EngineRebuilt[];
  /**
   * "Print full original text" was ticked or unticked: the switch (unticked
   * and disabled while it is ticked, its own state back after), every
   * rebuilt card and the counts are written again. Returns the line to
   * announce: '' only when the switch is hidden; the new "N of M rebuilt
   * emails will be in the PDF" line while rebuilding is on and there are
   * rebuilt emails; else (no rebuilt email, "Print full original text"
   * ticked or the switch off: rebuilt emails then not mentioned) the "N of
   * M emails will be in the PDF" line, which replaces an older rebuilt line
   * in the status line. The page then shows or hides the cards
   * (preview.refreshRebuilt, which asks rebuiltShown).
   */
  everythingChanged(): string;
}

/** What build() added to an item (see Entry). */
interface Parts {
  readonly checkbox: HTMLInputElement;
  readonly excludedNote: HTMLSpanElement;
  /** The checkbox's visible label. */
  readonly label: HTMLLabelElement;
  /** The list of notes (null: the email has none), and each note's item with the note it shows. */
  readonly notesList: HTMLUListElement | null;
  readonly notes: readonly { readonly element: HTMLLIElement; readonly note: MessageNote }[];
}

/** One decorated item. */
interface Entry extends Parts {
  readonly item: HTMLLIElement;
  readonly message: EngineMessage;
}

/** What buildRebuilt() added to a rebuilt card. */
interface RebuiltParts {
  readonly checkbox: HTMLInputElement;
  readonly excludedNote: HTMLSpanElement;
  readonly label: HTMLLabelElement;
  /** "In the PDF: taken from #K": shown only when the card is in the PDF but its own email is not (see applyRebuilt). */
  readonly pdfSourceNote: HTMLParagraphElement;
}

/** One decorated rebuilt card. */
interface RebuiltEntry extends RebuiltParts {
  readonly item: HTMLLIElement;
  readonly rebuilt: EngineRebuilt;
}

export interface ReviewOptions {
  /**
   * Called after each tick or untick, once the choice is recorded, with the
   * new "N of M emails will be in the PDF" line to announce, so screen
   * readers hear it. src/ui/page.ts: the PDF labels are worked out again
   * (src/ui/pdf-labels.ts), and step 3 announces the line in the shell's
   * status line (the page's one live region), together with "the previous
   * PDF was removed" when the change dropped one (src/ui/download-step.ts),
   * so neither announcement replaces the other.
   */
  readonly onChange?: (announcement: string) => void;
  /**
   * Called after the switch or a rebuilt card's checkbox changed, with the
   * new "N of M rebuilt emails will be in the PDF" line to announce (the
   * switch turned off: the "N of M emails will be in the PDF" line, see
   * rebuiltAnnouncement). src/ui/page.ts: step 3 drops a PDF made before
   * and announces the line ('' announces nothing but the drop).
   */
  readonly onRebuiltChange?: (announcement: string) => void;
  /**
   * True while "Print full original text" is ticked (src/ui/page.ts: the
   * PDF labels' policy): no rebuilt email is shown or in the PDF then, and
   * the switch is unticked and disabled (see the top).
   * Default: never ticked. If it throws, it counts as unticked.
   */
  readonly unfoldEverything?: () => boolean;
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
  const added = new WeakMap<HTMLLIElement, Parts>();
  // How many emails of the result shown have notes (for the counts line):
  // any note, and any note other than "could not be rebuilt" (the count
  // shown while rebuilding is off, see the top of this file).
  let withNotes = 0;
  let withNotesNoRebuild = 0;
  // True if an email of the result shown has a "could not be rebuilt" note
  // (the switch is then shown even without rebuilt emails, see switchNeeded).
  let hasRebuildNote = false;
  const labels = createStaticLabels();
  // Rebuilt emails: the choices, the cards decorated (by id) and the cards of the result shown.
  const rebuiltSelection = createRebuiltSelection();
  let rebuiltItems = new Map<number, RebuiltEntry>();
  const addedRebuilt = new WeakMap<HTMLLIElement, RebuiltParts>();
  let rebuiltList: readonly EngineRebuilt[] = [];

  // --- Counts box -----------------------------------------------------------
  const filesLine = el('span', { attrs: { id: 'review-files-text' } });
  // Plain text, not a link: the page has no links at all yet (see e2e/app-shell.spec.ts).
  const failedPointer = labels.text(el('span', { attrs: { id: 'review-failed-pointer', hidden: true } }), 'counts.seeFailed');
  const messagesLine = el('p', { attrs: { id: 'review-messages', class: 'review-line' } });
  // Not a live region itself: the page has one (the shell's status line); see `onChange`.
  const includedLine = el('p', { attrs: { id: 'review-included', class: 'review-line review-included' } });
  const notesLine = el('p', { attrs: { id: 'review-notes', class: 'review-line', hidden: true } });
  const rebuiltLine = el('p', { attrs: { id: 'review-rebuilt', class: 'review-line review-included', hidden: true } });
  const element = el('div', {
    attrs: { id: 'review-summary', class: 'review-summary' },
    children: [
      el('p', { attrs: { id: 'review-files', class: 'review-line' }, children: [filesLine, ' ', failedPointer] }),
      messagesLine,
      includedLine,
      rebuiltLine,
      notesLine,
    ],
  });

  // The switch (ticked: every rebuilt email that is ticked goes in the PDF).
  // Hidden with its field while the result has no rebuilt email and no "could
  // not be rebuilt" note (both: a hidden input is never taken for a control).
  const rebuiltCheckbox = el('input', { attrs: { type: 'checkbox', id: 'rebuilt-include-all', checked: true, hidden: true } });
  rebuiltCheckbox.checked = true;
  // Why the switch is disabled: never shown, only read as the switch's
  // description while "Print full original text" is ticked (see syncSwitch).
  const rebuiltOffHint = labels.text(el('span', { attrs: { id: 'rebuilt-off-hint', hidden: true } }), 'rebuilt.offWhileFullText');
  const rebuiltSwitch = el('div', {
    attrs: { id: 'rebuilt-switch', class: 'field field-checkbox', hidden: true },
    children: [rebuiltCheckbox, labels.text(el('label', { attrs: { for: 'rebuilt-include-all' } }), 'rebuilt.rebuildConversation'), rebuiltOffHint],
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

  /** Shows or hides the switch (shown only when switchNeeded). */
  function showSwitch(shown: boolean): void {
    setSafeAttribute(rebuiltSwitch, 'hidden', !shown);
    setSafeAttribute(rebuiltCheckbox, 'hidden', !shown);
  }

  /**
   * The switch is shown when the result has rebuilt emails or a "could not
   * be rebuilt" note (both depend on it): else a reader who turned it off
   * could not turn it back on to see such a note.
   */
  function switchNeeded(): boolean {
    return current !== null && (rebuiltList.length > 0 || hasRebuildNote);
  }

  /** True while "Print full original text" is ticked (see the top of this file). */
  function everythingOn(): boolean {
    try {
      return options.unfoldEverything?.() === true;
    } catch {
      return false;
    }
  }

  /** True while rebuilt emails are shown and may go in the PDF: the switch is on and the full text is not asked for. */
  function rebuiltOn(): boolean {
    return rebuiltSelection.includeAll() && !everythingOn();
  }

  /**
   * The switch as it must look now: while "Print full original text" is
   * ticked, unticked, disabled and described by the hint; else enabled with
   * the reader's own choice (kept in rebuiltSelection, never changed here).
   */
  function syncSwitch(): void {
    const everything = everythingOn();
    rebuiltCheckbox.checked = rebuiltSelection.includeAll() && !everything;
    setSafeAttribute(rebuiltCheckbox, 'disabled', everything);
    setSafeAttribute(rebuiltCheckbox, 'aria-describedby', everything ? 'rebuilt-off-hint' : false);
  }

  /** True if this rebuilt card is ticked (a broken entry counts as ticked, as for real emails). */
  function isRebuiltTicked(r: EngineRebuilt): boolean {
    try {
      return current === null || rebuiltSelection.isTicked(r, current);
    } catch {
      return true;
    }
  }

  /**
   * The follow-source rule (src/ui-model/rebuilt.ts, rebuiltInPdf): true
   * while at least one email the rebuilt email was read from is in the PDF.
   * `included`: the list positions in the PDF (positions()), worked out once
   * by the caller. A broken entry counts as in the PDF (never silently left out).
   */
  function sourceInPdf(r: EngineRebuilt, included: ReadonlySet<number>): boolean {
    if (current === null) return true;
    try {
      return rebuiltInPdf(r, current, (p) => (included.has(p) ? p + 1 : null)) !== null;
    } catch {
      return true;
    }
  }

  /**
   * The preview number (#K) of the email the PDF takes this rebuilt email
   * from, when that is NOT the email named on its card (its own email is
   * left out, a copy's email is in): the same choice as the PDF
   * (rebuiltInPdf; the PDF numbers follow the list order, so the smallest
   * list position is the smallest PDF number). Null otherwise, or when it
   * cannot be worked out (then the card simply shows no extra line).
   * Only asked while the card is in the PDF.
   */
  function pdfSourceNumber(r: EngineRebuilt, included: ReadonlySet<number>): number | null {
    if (current === null) return null;
    try {
      const source = rebuiltInPdf(r, current, (p) => (included.has(p) ? p + 1 : null));
      return source === null || source.shown.rebuilt === r ? null : source.shown.position + 1;
    } catch {
      return null;
    }
  }

  /**
   * The rebuilt emails that go in the PDF, in list order: none when the
   * switch is off; else the ticked ones, and (once the list is complete) any
   * card the page could not decorate, as for real emails (see `positions`);
   * in both cases only while an email they were read from is in the PDF
   * (user decision Q1 (a): a rebuilt email follows its source email).
   * None while "Print full original text" is ticked (user decision 2026-10-29).
   */
  function rebuiltIncluded(): EngineRebuilt[] {
    if (current === null || !rebuiltOn()) return [];
    const complete = renderedResult === current;
    const included = new Set(positions());
    return rebuiltList.filter((r) => ((complete && !rebuiltItems.has(r.id)) || isRebuiltTicked(r)) && sourceInPdf(r, included));
  }

  /** True for a note shown only while rebuilding is on ("could not be rebuilt"). */
  function isRebuildNote(note: MessageNote): boolean {
    return note.kind === 'rebuild';
  }

  /** Shows or hides an item's "could not be rebuilt" notes (and its notes list when nothing is left in it). */
  function applyNotes(parts: Parts, on: boolean = rebuiltOn()): void {
    if (parts.notesList === null) return;
    let shown = 0;
    for (const { element, note } of parts.notes) {
      const visible = on || !isRebuildNote(note);
      setSafeAttribute(element, 'hidden', !visible);
      if (visible) shown++;
    }
    setSafeAttribute(parts.notesList, 'hidden', shown === 0);
  }

  /**
   * Everything in the counts and notes that depends on whether rebuilding
   * is on (see the top of this file): the rebuilt part of the messages line,
   * the "X of N rebuilt emails will be in the PDF" line, the "N emails with
   * notes" line and every item's "could not be rebuilt" notes. Called after
   * any change of the switch, of "Print full original text", of a tick, and
   * on a new result or language.
   */
  function showRebuiltLine(): void {
    const on = rebuiltOn();
    const shown = current !== null && rebuiltList.length > 0 && on;
    rebuiltLine.textContent = shown ? t('counts.rebuiltIncluded', { included: rebuiltIncluded().length, count: rebuiltList.length }) : '';
    setSafeAttribute(rebuiltLine, 'hidden', !shown);
    if (current === null) return;
    messagesLine.textContent = messagesText(current.counts, shown ? rebuiltList.length : 0);
    const notes = on ? withNotes : withNotesNoRebuild;
    notesLine.textContent = notes > 0 ? t('counts.withNotes', { count: notes }) : '';
    setSafeAttribute(notesLine, 'hidden', notes === 0);
    for (const entry of entries.values()) applyNotes(entry, on);
  }

  /**
   * What to announce after the switch, a rebuilt card or "Print full
   * original text" changed: the rebuilt line; while rebuilding is off (no
   * rebuilt line), the "N of M emails will be in the PDF" line instead, so
   * the status line never keeps an older rebuilt line; '' when the result
   * switch is hidden (nothing to say). Call after showRebuiltLine.
   */
  function rebuiltAnnouncement(): string {
    if (rebuiltLine.textContent !== '') return rebuiltLine.textContent;
    return switchNeeded() ? includedLine.textContent : '';
  }

  /**
   * Shows a rebuilt card's state: its own tick, and "Not in the PDF" when it
   * is unticked, or when every email it was read from is unticked (then the
   * mark says so; the card's own tick is kept, and counts again once one of
   * those emails is ticked back). `included`: positions() (see sourceInPdf).
   * While the switch is off or "Print full original text" is ticked, the
   * card leaves the list (its own tick is kept, see the top of this file).
   */
  function applyRebuilt(entry: RebuiltEntry, included: ReadonlySet<number> = new Set(positions())): void {
    const ticked = isRebuiltTicked(entry.rebuilt);
    const on = rebuiltOn();
    const sourceIn = sourceInPdf(entry.rebuilt, included);
    const inPdf = ticked && on && sourceIn;
    entry.checkbox.checked = ticked;
    setSafeAttribute(entry.item, 'data-included', inPdf ? 'true' : 'false');
    setSafeAttribute(entry.excludedNote, 'hidden', ticked && sourceIn);
    // Hidden when ticked with a source in the PDF; else the reason.
    entry.excludedNote.textContent = ticked ? t('rebuilt.sourceExcluded') : t('review.excluded');
    // In the PDF, but taken from a copy in another email (its own is left
    // out): the card's "Taken from #N" names the left-out email, so say which
    // email the PDF uses (task 7.7 review).
    const pdfSource = inPdf ? pdfSourceNumber(entry.rebuilt, included) : null;
    setSafeAttribute(entry.pdfSourceNote, 'hidden', pdfSource === null);
    entry.pdfSourceNote.textContent = pdfSource === null ? '' : t('rebuilt.pdfSource', { number: messageNumberText(pdfSource) });
    // Switch off or full text: the card leaves the list (its text stays in its source email's card).
    setSafeAttribute(entry.item, 'hidden', !on);
  }

  /** Every decorated rebuilt card again (after any change of what goes in the PDF). */
  function applyAllRebuilt(): void {
    const included = new Set(positions());
    for (const entry of rebuiltItems.values()) applyRebuilt(entry, included);
  }

  function apply(entry: Entry): void {
    const included = isIncluded(entry.message);
    entry.checkbox.checked = included;
    setSafeAttribute(entry.item, 'data-included', included ? 'true' : 'false');
    setSafeAttribute(entry.excludedNote, 'hidden', included);
  }

  /** The counts lines of the result shown, in the page language. */
  function writeCounts(result: EngineResult): void {
    filesLine.textContent = filesText(result.counts);
    showIncludedLine();
    // Also the messages line and the notes line (both depend on whether rebuilding is on).
    showRebuiltLine();
  }

  /** An item's own words (label, "Not in the PDF", notes), in the page language. */
  function writeParts(parts: Parts): void {
    parts.label.textContent = t('actions.include');
    parts.excludedNote.textContent = t('review.excluded');
    if (parts.notesList !== null) setSafeAttribute(parts.notesList, 'aria-label', t('review.notesLabel'));
    for (const { element, note } of parts.notes) element.textContent = noteText(note);
  }

  function emptyCounts(): void {
    current = null;
    withNotes = 0;
    withNotesNoRebuild = 0;
    hasRebuildNote = false;
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
    rebuiltList = [];
    rebuiltItems = new Map();
    rebuiltLine.textContent = '';
    setSafeAttribute(rebuiltLine, 'hidden', true);
    showSwitch(false);
  }

  /** Shows a result's counts; does nothing for the result already shown (its items stay registered). */
  function show(result: EngineResult): void {
    if (result === current) return;
    current = result;
    entries = new Map();
    setSafeAttribute(failedPointer, 'hidden', result.counts.filesFailed === 0);
    withNotes = 0;
    withNotesNoRebuild = 0;
    hasRebuildNote = false;
    result.messages.forEach((m, position) => {
      const notes = safeNotes(m, position, result.positionByIndex, result.reconstructionWarnings);
      if (notes.length > 0) withNotes++;
      if (notes.some((note) => !isRebuildNote(note))) withNotesNoRebuild++;
      if (notes.some(isRebuildNote)) hasRebuildNote = true;
    });
    rebuiltItems = new Map();
    try {
      rebuiltList = rebuiltEntries(result);
    } catch {
      rebuiltList = []; // not expected; the real emails are shown either way
    }
    // The rebuilt line and the notes line are shown or hidden by showRebuiltLine (through writeCounts).
    showSwitch(switchNeeded());
    syncSwitch();
    writeCounts(result);
  }

  /** Builds the checkbox and notes of one item (only once per item). */
  function build(item: HTMLLIElement, m: EngineMessage, position: number, result: EngineResult): Parts {
    const id = `include-${String(position)}`;
    const labelId = `${id}-label`;
    // Named by its visible label AND the email's heading: "Include in the PDF
    // #3 Desks for the office". Each checkbox's name then says which email it
    // is for, also in a screen reader's list of form controls, where only
    // names are shown. The visible words come first (WCAG 2.5.3).
    const checkbox = el('input', {
      attrs: { type: 'checkbox', id, class: 'include-checkbox', 'aria-labelledby': `${labelId} ${headingId(position)}` },
    });
    const excludedNote = el('span', { attrs: { class: 'excluded-note', hidden: true } });
    const label = el('label', { attrs: { id: labelId, for: id } });
    const children: Node[] = [
      el('div', {
        attrs: { class: 'field field-checkbox message-include' },
        children: [checkbox, label, excludedNote],
      }),
    ];
    const notes = safeNotes(m, position, result.positionByIndex, result.reconstructionWarnings).map((note) => ({
      element: el('li', { attrs: { class: 'message-note', 'data-code': note.code } }),
      note,
    }));
    const notesList = notes.length === 0 ? null : el('ul', { attrs: { class: 'message-notes' }, children: notes.map((n) => n.element) });
    if (notesList !== null) children.push(notesList);
    const parts: Parts = { checkbox, excludedNote, label, notesList, notes };
    writeParts(parts);
    checkbox.addEventListener('change', () => {
      const rebuiltBefore = rebuiltLine.textContent;
      selection.setIncluded(m, checkbox.checked);
      // Every shown item: two items can share a file (see selection.ts).
      for (const entry of entries.values()) apply(entry);
      showIncludedLine();
      // The rebuilt emails follow the emails they were read from (rebuiltInPdf).
      applyAllRebuilt();
      showRebuiltLine();
      // One announcement: the rebuilt line too when this changed it.
      const rebuiltAfter = rebuiltLine.textContent;
      options.onChange?.(rebuiltAfter !== rebuiltBefore && rebuiltAfter !== '' ? `${includedLine.textContent} ${rebuiltAfter}` : includedLine.textContent);
    });
    // Right after the heading (the item's first child), before the details.
    item.insertBefore(el('div', { attrs: { class: 'message-review' }, children }), item.children[1] ?? null);
    return parts;
  }

  /** Builds a rebuilt card's checkbox (only once per card), right after its heading. */
  function buildRebuilt(item: HTMLLIElement, r: EngineRebuilt): RebuiltParts {
    const id = `include-rebuilt-${String(r.id)}`;
    const labelId = `${id}-label`;
    // Named by its label and the card's heading ("Include in the PDF Rebuilt Desks"), as for real emails.
    const checkbox = el('input', {
      attrs: { type: 'checkbox', id, class: 'include-checkbox', 'aria-labelledby': `${labelId} ${rebuiltHeadingId(r.id)}` },
    });
    const excludedNote = el('span', { attrs: { class: 'excluded-note', hidden: true } });
    const label = el('label', { attrs: { id: labelId, for: id } });
    // Filled in by applyRebuilt (its words depend on which emails are ticked).
    const pdfSourceNote = el('p', { attrs: { class: 'rebuilt-pdf-source', hidden: true } });
    const parts: RebuiltParts = { checkbox, excludedNote, label, pdfSourceNote };
    writeRebuiltParts(parts);
    checkbox.addEventListener('change', () => {
      if (current !== null) rebuiltSelection.setTicked(r, current, checkbox.checked);
      // Every shown card: two cards could share a key (see src/ui-model/rebuilt.ts).
      applyAllRebuilt();
      showRebuiltLine();
      options.onRebuiltChange?.(rebuiltAnnouncement());
    });
    const field = el('div', { attrs: { class: 'field field-checkbox message-include' }, children: [checkbox, label, excludedNote] });
    item.insertBefore(el('div', { attrs: { class: 'message-review' }, children: [field, pdfSourceNote] }), item.children[1] ?? null);
    return parts;
  }

  /** A rebuilt card's label, in the page language ("Not in the PDF" is applyRebuilt's: its words depend on why). */
  function writeRebuiltParts(parts: RebuiltParts): void {
    parts.label.textContent = t('actions.include');
  }

  const decorateRebuilt: Review['decorateRebuilt'] = (item, r, result) => {
    if (result !== current) show(result);
    let parts = addedRebuilt.get(item);
    if (parts === undefined) {
      parts = buildRebuilt(item, r);
      addedRebuilt.set(item, parts);
    }
    // Recorded last: a call that threw above leaves no reference behind.
    const entry: RebuiltEntry = { item, rebuilt: r, ...parts };
    applyRebuilt(entry);
    rebuiltItems.set(r.id, entry);
  };

  rebuiltCheckbox.addEventListener('change', () => {
    rebuiltSelection.setIncludeAll(rebuiltCheckbox.checked);
    applyAllRebuilt();
    showRebuiltLine();
    options.onRebuiltChange?.(rebuiltAnnouncement());
  });

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
    applyNotes(entry);
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
      rebuiltSelection.clear();
      // "Clear everything" also unticks "Print full original text" (src/ui/page.ts), so the switch is enabled again.
      // Set directly, not through syncSwitch: the PDF labels may be reset after the review, so unfoldEverything could still say ticked here.
      rebuiltCheckbox.checked = true;
      setSafeAttribute(rebuiltCheckbox, 'disabled', false);
      setSafeAttribute(rebuiltCheckbox, 'aria-describedby', false);
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
      // An email without a decorated item now counts as included: its rebuilt emails follow.
      applyAllRebuilt();
      showRebuiltLine();
    },
    relabel() {
      labels.relabel();
      if (current !== null) writeCounts(current);
      for (const entry of entries.values()) writeParts(entry);
      for (const entry of rebuiltItems.values()) writeRebuiltParts(entry);
      applyAllRebuilt();
    },
    rebuiltSwitch,
    decorateRebuilt,
    rebuiltShown: rebuiltOn,
    includedRebuilt: rebuiltIncluded,
    everythingChanged() {
      syncSwitch();
      applyAllRebuilt();
      showRebuiltLine();
      return rebuiltAnnouncement();
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
