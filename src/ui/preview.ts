// Step 2: the preview. A list of the emails in the engine's (chronological)
// order, each with its date, author, recipients, subject, attachments and body.
//
// What it shows, and how:
// - Dates in the time zone picked in the toolbar (default: the browser's).
//   When the sender's own clock (from their Date header) differs from the
//   shown time, it is shown too. Changing the zone only rewrites the date
//   texts; the bodies are not rebuilt.
// - The body as display blocks (src/ui-model/display-blocks.ts). Shown text
//   goes into the page as text. Each folded block is a <details> element
//   with a short label (why it was folded, how long it is, which earlier
//   email it repeats): the folded text is always in the page, one click away
//   (README.md, rule R6: collapse, never delete). The "show quoted text"
//   checkbox opens or closes every folded block at once, and blocks built
//   later follow its current state.
// - Attachments as names, sizes and types only: never opened, never turned
//   into links (README.md, rule R4).
//
// Safety: every email field is untrusted. It only ever reaches the page as
// text, through el() (src/ui/dom.ts), never as HTML (README.md, rule R4).
// Nothing is stored: the zone and the checkbox live in memory only
// (README.md, rule R5).
//
// Big batches: the list is built in chunks (the first one at once, the
// others in later tasks), so the page stays responsive with thousands of
// emails. A new result or reset() cancels the chunks still waiting; reset()
// ("Clear everything") also puts the zone and the checkbox back to their
// defaults. If one
// email's item cannot be built, a stand-in with its number and whole text
// takes its place and the rest of the list is still built: no email is ever
// silently missing.
//
// What the PDF leaves out: each folded block also carries a text label, "In
// the PDF: ..." or "Not in the PDF: ...", from the PDF's own plan
// (src/engine/output-plan.ts, mapped by src/ui-model/pdf-plan.ts). The plans
// are worked out by src/ui/pdf-labels.ts and handed over with setPdfPlans().
// Rules:
// - A folded block is all in the PDF or all left out: when the plan changes
//   inside one, the block is cut in two (its text is not changed).
// - Never a stale label: setPdfPlans(null) marks the list as updating
//   (`data-pdf-labels="updating"` on the list), which hides every label and
//   PDF note at once (app.css) and shows "Checking what goes in the PDF...".
//   New plans are applied in chunks; the labels show again only once every
//   email built so far has its new labels. Emails built later get them as
//   they are built.
// - An email left out of the PDF (unticked) gets no PDF labels: the whole
//   email is already marked "Not in the PDF" (src/ui/review.ts). Its body
//   is not redrawn: the labels and note it had stay in place but hidden,
//   from screen readers too (`data-pdf-out` on its body and note, app.css),
//   so unticking it does not move the emails below up, and ticking it back
//   (same plan: nothing to redraw) does not move them down. An email built
//   while left out simply has no labels.
// - An email the plan keeps whole (rules 4 and 5 of output-plan.ts) gets a
//   short note above its text (src/ui-model/message-notes.ts, pdfPlanNote).
// - Never silent: when one email's labels cannot be shown (a failed update,
//   or a stand-in item of an email that is in the PDF), a note above its
//   text says so (pdf.messageFailed).
// - The status line keeps its place while a list is shown, so ticking an
//   email never moves the list under the reader's pointer.
// - The keyboard focus is never lost to a redraw: when new plans redraw a
//   body whose fold summary had the focus, the focus goes to the summary of
//   the new fold over the same text (or to the body itself if no fold is
//   left there), never back to the top of the page, and the new summary is
//   scrolled into view if the old one could be seen. Focus anywhere else is
//   not touched. (A new result is src/ui/page.ts's job: it rebuilds the
//   whole list.)
// The labels only add words: every character stays in the page.
//
// Not here: the counts, the include/exclude checkboxes and the notes
// (src/ui/review.ts). They reach the page through three options: `header`
// (nodes above the toolbar), `decorate` (adds to each email's item) and
// `onRendered` (told when a list is complete). `toolbarItems` adds controls
// to the toolbar (the "Put everything in the PDF" checkbox of
// src/ui/pdf-labels.ts).

import type { EngineMessage, EngineResult } from '../engine/engine';
import type { PlanReason } from '../engine/output-plan';
import { browserTimeZone, formatInZone, formatSenderLocal, isDisplayableMs, listTimeZones } from '../engine/time-format';
import type { AttachmentInfo, EmailAddress, EmailDate } from '../parsing/types';
import type { ProcessResult } from '../pipeline/process-files';
import { displayAuthor } from '../ui-model/display-author';
import type { DisplayBlock } from '../ui-model/display-blocks';
import { pdfPlanNote } from '../ui-model/message-notes';
import { pdfBlocks, viewKey, type PdfBlock, type PdfLabel, type PdfView } from '../ui-model/pdf-plan';
import type { AppShell } from './app';
import { el, setSafeAttribute } from './dom';
import { LOCALE, t } from './i18n';

/** Emails built per chunk (at least one per chunk, see MAX_CHUNK_CHARS). */
export const DEFAULT_CHUNK_SIZE = 40;
/** A chunk also ends once its bodies hold this many characters, so a few huge emails do not freeze the page. */
export const MAX_CHUNK_CHARS = 500_000;
/**
 * New PDF labels are applied to this many times `chunkSize` emails per chunk
 * (also capped by MAX_CHUNK_CHARS): updating a label is much cheaper than
 * building an email's item.
 */
export const PDF_CHUNK_FACTOR = 4;

// ---------------------------------------------------------------------------
// Pure helpers (no DOM; unit tested directly).

// "a, b, c" in the page language, from the browser's own list rules.
const listFormat = new Intl.ListFormat(LOCALE, { style: 'short', type: 'unit' });

/** Joins texts the local way ("a, b, c"). */
export function joinList(items: readonly string[]): string {
  return listFormat.format(items);
}

/** True if a mailbox has neither a name nor an address. */
function isBlankMailbox(m: EmailAddress): boolean {
  return m.name.trim() === '' && m.address.trim() === '';
}

/** "Name <address>", or whichever of the two exists. The texts are shown as they are. */
export function mailboxText(m: EmailAddress): string {
  const hasName = m.name.trim() !== '';
  const hasAddress = m.address.trim() !== '';
  if (hasName && hasAddress) return t('preview.mailbox', { name: m.name, address: m.address });
  return hasName ? m.name : m.address;
}

/** The mailboxes of a list as one line; blank entries left out. '' if none. */
export function mailboxListText(list: readonly EmailAddress[]): string {
  return joinList(list.filter((m) => !isBlankMailbox(m)).map(mailboxText));
}

/** One decimal under 10 (1.4 KB), whole numbers above (12 KB). */
function roundSize(n: number): number {
  return n < 10 ? Math.round(n * 10) / 10 : Math.round(n);
}

/** A file size for people: "512 bytes", "1.4 KB", "12 MB"; "size unknown" if not given. */
export function sizeText(size: number | null): string {
  if (size === null || !Number.isFinite(size) || size < 0) return t('preview.size.unknown');
  if (size < 1024) return t('preview.size.bytes', { count: size });
  const kb = size / 1024;
  if (kb < 1024) return t('preview.size.kb', { size: roundSize(kb) });
  return t('preview.size.mb', { size: roundSize(kb / 1024) });
}

/** "report.pdf (12 KB, application/pdf)": metadata only, the file is never opened. */
export function attachmentText(a: AttachmentInfo): string {
  const name = a.fileName.trim() === '' ? t('preview.noAttachmentName') : a.fileName;
  const size = sizeText(a.size);
  if (a.mimeType.trim() === '') return t('preview.attachmentNoType', { name, size });
  return t('preview.attachment', { name, size, type: a.mimeType });
}

/** The date texts of one email in `zone`. */
export interface DateTexts {
  /** "2025-03-03 09:15:00 UTC+01:00", or the "no date" text. */
  readonly main: string;
  /** The moment for <time datetime>, null without a date. */
  readonly iso: string | null;
  /** "Sender's local time: ...", only when known and different from `main`; else null. */
  readonly senderLocal: string | null;
}

export function dateTexts(date: EmailDate, zone: string): DateTexts {
  const shown = formatInZone(date.utcMs, zone, LOCALE);
  if (shown.kind === 'no-date' || !isDisplayableMs(date.utcMs)) return { main: t('preview.noDate'), iso: null, senderLocal: null };
  const sender = formatSenderLocal(date);
  const senderLocal = sender.kind === 'local' && sender.text !== shown.text ? t('preview.senderTime', { time: sender.text }) : null;
  return { main: shown.text, iso: new Date(Math.floor(date.utcMs)).toISOString(), senderLocal };
}

/**
 * Lines in a block of text: "a\nb" is 2, "a\nb\n" too (a final line break
 * starts no new line). Only LF is counted: bodyText has LF line ends only
 * (src/parsing/line-endings.ts), so this matches the engine's lines.
 */
export function lineCount(text: string): number {
  if (text === '') return 0;
  const breaks = text.split('\n').length - 1;
  return text.endsWith('\n') ? breaks : breaks + 1;
}

/**
 * The numbers (1-based, as shown in the list) of the other emails a folded
 * block repeats. `related` holds input positions; `positionByIndex` turns
 * them into list positions (see src/engine/engine.ts). The email itself and
 * unknown positions are left out.
 */
export function relatedNumbers(block: DisplayBlock, ownPosition: number, positionByIndex: readonly (number | null)[]): number[] {
  const numbers = new Set<number>();
  for (const index of block.related) {
    const position = positionByIndex[index];
    if (position !== null && position !== undefined && position !== ownPosition) numbers.add(position + 1);
  }
  return [...numbers].sort((a, b) => a - b);
}

/** "#3": an email's number in the list. */
export function messageNumberText(number: number): string {
  // A string, so the number is not written with a thousands separator.
  return t('preview.messageNumber', { number: String(number) });
}

/** The label of a folded block: "Quoted text, 12 lines, from email #3". */
export function foldSummaryText(block: DisplayBlock, ownPosition: number, positionByIndex: readonly (number | null)[]): string {
  const parts = [block.label === null ? t('preview.foldOther') : t(`preview.fold.${block.label}`), t('preview.foldLines', { count: lineCount(block.text) })];
  const numbers = relatedNumbers(block, ownPosition, positionByIndex);
  if (numbers.length > 0) {
    const list = joinList(numbers.map(messageNumberText));
    parts.push(numbers.length === 1 ? t('preview.foldFromOne', { list }) : t('preview.foldFromMany', { list }));
  }
  return joinList(parts);
}

/**
 * One reason of a PDF label: "earlier email quoted by the mail app", "same
 * signature as in email #2", "same signature as in emails #1, #3".
 * `signaturesFrom`: the list numbers of the emails where the repeated
 * signatures are kept (see PdfLabel).
 */
export function pdfReasonText(reason: PlanReason, signaturesFrom: readonly number[]): string {
  if (reason !== 'repeated-signature' || signaturesFrom.length === 0) return t(`pdf.reason.${reason}`);
  const list = joinList(signaturesFrom.map(messageNumberText));
  return signaturesFrom.length === 1 ? t('pdf.repeatedFrom', { number: list }) : t('pdf.repeatedFromMany', { list });
}

/** A block's PDF label: "Not in the PDF: earlier email quoted by the mail app". */
export function pdfLabelText(label: PdfLabel): string {
  const list = label.reasons.length === 0 ? ['text' as const] : label.reasons;
  const reasons = joinList(list.map((r) => pdfReasonText(r, label.signaturesFrom)));
  switch (label.status) {
    case 'in':
      return t('pdf.label.in', { reasons });
    case 'out':
      return t('pdf.label.out', { reasons });
    case 'partly':
      return t('pdf.label.partly', { reasons });
  }
}

/** The id of an email's heading in the list (unique: one item per position). */
export function headingId(position: number): string {
  return `message-${String(position)}-title`;
}

/** The shown time-zone name: underscores as spaces, and the browser's own zone marked. */
export function zoneLabel(zone: string, browserZone: string): string {
  const name = zone.replaceAll('_', ' ');
  return zone === browserZone ? t('preview.zoneThisComputer', { zone: name }) : name;
}

// ---------------------------------------------------------------------------
// The step 2 interface.

export interface PreviewOptions {
  /** Emails per chunk. Default DEFAULT_CHUNK_SIZE. */
  readonly chunkSize?: number;
  /** Runs a task later (default: setTimeout 0). Returns a handle for `cancel`. */
  readonly schedule?: (task: () => void) => unknown;
  /** Cancels a scheduled task (default: clearTimeout). */
  readonly cancel?: (handle: unknown) => void;
  /** The zones offered (default: listTimeZones()). */
  readonly zones?: readonly string[];
  /** The zone selected at the start, also marked "this computer" (default: browserTimeZone()). */
  readonly initialZone?: string;
  /** Nodes shown above the toolbar (the counts of src/ui/review.ts). Default: none. */
  readonly header?: readonly Node[];
  /**
   * Hook that adds to each email's list item (src/ui/review.ts: include
   * checkbox, notes), called after the item is built, with the result it
   * belongs to. If building or decorating fails, it is called again with
   * that email's stand-in (`.message-failed`), so it must not assume one
   * call per position and must not keep references from a call that threw.
   * Each item's heading has the id `message-<position>-title`.
   */
  readonly decorate?: (item: HTMLLIElement, message: EngineMessage, position: number, result: EngineResult) => void;
  /**
   * Called once the last item of a result is in the page (src/ui/review.ts:
   * an email with no decorated item then counts as included). Not called
   * for a list replaced or reset before it was finished. If it throws, the
   * list is not affected.
   */
  readonly onRendered?: (result: EngineResult) => void;
  /** Controls added at the end of the toolbar (src/ui/pdf-labels.ts). Default: none. */
  readonly toolbarItems?: readonly Node[];
  /** Called after the user picked another time zone (src/ui/page.ts: a PDF made before is dropped). */
  readonly onZoneChange?: () => void;
}

/** The PDF plans of a result, for the labels (see the top of this file). */
export interface PreviewPdfPlans {
  /** The result they were made for: plans for another result are ignored. */
  readonly result: EngineResult;
  /** List position -> its plan. An email that is not in the map is not in the PDF (no labels). */
  readonly views: ReadonlyMap<number, PdfView>;
}

/**
 * The state of the PDF labels: 'off' (no plans asked for yet), 'updating'
 * (labels hidden), 'ready' (every label shown is up to date), 'failed' (the
 * plans could not be worked out; labels hidden, a note says so).
 */
export type PdfLabelState = 'off' | 'updating' | 'ready' | 'failed';

export interface Preview {
  /** Shows the emails of a result (replacing what was shown). */
  show(result: EngineResult): void;
  /** Shows a step 1 result: its emails, or nothing after a batch error. */
  showResult(result: ProcessResult): void;
  /**
   * Empties the list, cancels any chunk still waiting and puts the toolbar
   * back to its defaults (the start zone, folded text closed), for "Clear
   * everything".
   */
  reset(): void;
  /** The selected time zone. */
  zone(): string;
  /** True while chunks are still waiting to be built. */
  isRendering(): boolean;
  /**
   * New PDF plans for the labels, or null while they are being worked out
   * again (the labels are hidden at once). Plans for another result than
   * the one shown count as null.
   */
  setPdfPlans(plans: PreviewPdfPlans | null): void;
  /** The plans could not be worked out: labels hidden, a note says so. */
  pdfPlansFailed(): void;
  /** See PdfLabelState. */
  pdfLabelState(): PdfLabelState;
}

/** One block of a shown body, as built (to update its label in place). */
interface BuiltBlock {
  readonly start: number;
  readonly end: number;
  readonly details: HTMLDetailsElement | null;
  /** A folded block's <summary> (where the focus goes after a redraw, see drawBlocks); null for shown text. */
  readonly summary: HTMLElement | null;
  /** The block's own elements in the body (to find the block the focus is in). */
  readonly nodes: readonly HTMLElement[];
  /** The PDF label element (a folded block always has one, hidden when there is no label). */
  readonly label: HTMLElement | null;
}

/**
 * Where the keyboard focus was before a redraw: the text range of its block
 * (null: in the body, but in no known block), and whether the focused
 * element could be seen in the window.
 */
interface FocusSpot {
  readonly range: { readonly start: number; readonly end: number } | null;
  readonly wasVisible: boolean;
}

/** One email's body in the page, redrawn when its PDF plan changes. */
interface BodySlot {
  readonly m: EngineMessage;
  readonly position: number;
  readonly positionByIndex: readonly (number | null)[];
  readonly body: HTMLDivElement;
  readonly note: HTMLParagraphElement;
  /** viewKey of the view drawn. */
  key: string;
  /** The blocks' places and kinds (see shapeOf). */
  shape: string;
  blocks: BuiltBlock[];
}

/** The shape of a body not drawn yet (never a real shape, so its first update draws). */
const NOT_DRAWN = 'not drawn yet';

/** Where the blocks are and which of them carry a label element: equal shapes can be updated in place. */
function shapeOf(blocks: readonly PdfBlock[]): string {
  return blocks.map((b) => `${String(b.block.start)}:${String(b.block.end)}:${b.block.folded ? 'f' : b.label === null ? 's' : 'l'}`).join(',');
}

/** Sets a PDF label element's text and state (hidden without a label). */
function applyLabel(element: HTMLElement, label: PdfLabel | null): void {
  // The trailing space keeps the label and the fold's own text apart when read as one line.
  element.textContent = label === null ? '' : `${pdfLabelText(label)} `;
  setSafeAttribute(element, 'data-pdf', label === null ? false : label.status);
  setSafeAttribute(element, 'hidden', label === null);
}

/** One email's date element, rewritten when the zone changes. */
interface DateSlot {
  readonly time: HTMLTimeElement;
  readonly senderNote: HTMLSpanElement;
  readonly date: EmailDate;
}

/** One "label: value" row of an email's details. */
function row(name: string, label: string, value: readonly (Node | string)[]): Node[] {
  return [el('dt', { attrs: { class: `meta-${name}` }, text: label }), el('dd', { attrs: { class: `meta-${name}` }, children: value })];
}

/** Builds step 2 inside shell.checkArea. */
export function mountPreview(shell: Pick<AppShell, 'checkArea'>, options: PreviewOptions = {}): Preview {
  const chunkSize = Math.max(1, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const schedule = options.schedule ?? ((task: () => void): unknown => setTimeout(task, 0));
  const cancel = options.cancel ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const homeZone = options.initialZone ?? browserTimeZone();
  const zones = [...(options.zones ?? listTimeZones())];
  if (!zones.includes(homeZone)) zones.unshift(homeZone);

  // --- State (memory only, README.md, rule R5) ------------------------------
  let zone = homeZone;
  let showFolded = false;
  let slots: DateSlot[] = [];
  let folds = new Set<HTMLDetailsElement>();
  let pending: { handle: unknown } | null = null;
  // Increased by each show() and reset(): a chunk of an older list does nothing.
  let generation = 0;
  // The result shown (null when the list is empty).
  let currentResult: EngineResult | null = null;
  // The bodies built so far, by list position.
  let bodies = new Map<number, BodySlot>();
  // The PDF notes of the stand-ins in the page, by list position.
  let standIns = new Map<number, HTMLParagraphElement>();
  // The PDF plans in use (null: none, or being worked out again), and their state.
  let pdfPlans: PreviewPdfPlans | null = null;
  let pdfState: PdfLabelState = 'off';
  let pdfPending: { handle: unknown } | null = null;
  // Increased by each setPdfPlans() and clear(): a chunk of older plans does nothing.
  let pdfGeneration = 0;

  // --- Toolbar --------------------------------------------------------------
  const zoneSelect = el('select', {
    attrs: { id: 'preview-zone', class: 'zone-select' },
    children: zones.map((z) => el('option', { attrs: { value: z, selected: z === zone }, text: zoneLabel(z, homeZone) })),
  });
  zoneSelect.value = zone;
  const foldToggle = el('input', { attrs: { type: 'checkbox', id: 'preview-show-folded' } });
  const toolbar = el('div', {
    attrs: { id: 'preview-toolbar', class: 'preview-toolbar' },
    children: [
      el('div', {
        attrs: { class: 'field' },
        children: [el('label', { attrs: { for: 'preview-zone' }, text: t('preview.zone') }), zoneSelect],
      }),
      el('div', {
        attrs: { class: 'field field-checkbox' },
        children: [foldToggle, el('label', { attrs: { for: 'preview-show-folded' }, text: t('preview.showFolded') })],
      }),
      ...(options.toolbarItems ?? []),
    ],
  });
  // Not a live region: the labels it stands for are hidden meanwhile, so nothing wrong can be read.
  // Shown (with or without text) whenever a list is shown, and one line high
  // even when empty (app.css): ticking an email never moves the list below.
  const pdfStatus = el('p', { attrs: { id: 'pdf-labels-status', class: 'note pdf-labels-status', hidden: true } });
  toolbar.append(pdfStatus);

  // role="list": some screen readers drop the list role when the numbers are hidden by CSS.
  const list = el('ol', { attrs: { id: 'preview-list', class: 'message-list', role: 'list', 'aria-label': t('preview.listLabel') } });
  shell.checkArea.replaceChildren(...(options.header ?? []), toolbar, list);

  /**
   * Shows the PDF label state on the list (app.css hides every label unless
   * 'ready') and in the status line. The line is hidden only when no email
   * is shown (it changes with the list itself, never on a tick); otherwise it
   * keeps its place and only its text changes, so the list does not move.
   */
  function setPdfState(state: PdfLabelState): void {
    pdfState = state;
    setSafeAttribute(list, 'data-pdf-labels', state);
    pdfStatus.textContent = state === 'updating' ? t('pdf.updating') : state === 'failed' ? t('pdf.failed') : '';
    setSafeAttribute(pdfStatus, 'hidden', currentResult === null || currentResult.messages.length === 0);
  }
  setPdfState('off');

  // --- Building one email ---------------------------------------------------
  function applyDate(slot: DateSlot): void {
    const texts = dateTexts(slot.date, zone);
    slot.time.textContent = texts.main;
    setSafeAttribute(slot.time, 'datetime', texts.iso ?? false);
    slot.senderNote.textContent = texts.senderLocal ?? '';
    setSafeAttribute(slot.senderNote, 'hidden', texts.senderLocal === null);
  }

  /** The PDF view of one email under the plans in use; null: no labels (not in the PDF, or no plans). */
  function viewFor(position: number): PdfView | null {
    if (pdfPlans === null || pdfPlans.result !== currentResult) return null;
    return pdfPlans.views.get(position) ?? null;
  }

  /**
   * Where the keyboard focus is in a body about to be redrawn: the range of
   * the block it is in (null if it is in the body but in no known block),
   * and whether the focused element could be seen (any part of it in the
   * window); or null if the focus is not in this body's blocks at all (it is
   * then never moved). The body element itself is not redrawn, so focus on
   * it is null.
   */
  function focusSpotIn(slot: BodySlot): FocusSpot | null {
    const active = document.activeElement;
    if (active === null || active === slot.body || !slot.body.contains(active)) return null;
    const block = slot.blocks.find((b) => b.nodes.some((n) => n.contains(active)));
    const rect = active.getBoundingClientRect();
    return {
      range: block === undefined ? null : { start: block.start, end: block.end },
      wasVisible: rect.bottom > 0 && rect.top < window.innerHeight,
    };
  }

  /**
   * Puts the focus back after a redraw took the focused element away (WCAG
   * 2.4.3 focus order): on the summary of the first new folded block that
   * overlaps the old block's text, else on the body itself (made focusable
   * only for this, until the focus leaves it). Never on <body>, at the top of
   * the page.
   * Scrolling (WCAG 2.4.7 / 2.4.11, focus visible and not hidden): after a
   * cut, the new summary starts where the old block started, but after a
   * merge ([a,m] + [m,b] into [a,b]) it starts at `a`, which can be far above
   * the window when the first fold was open. So the focus moves without
   * scrolling (preventScroll), then the new summary is scrolled into view
   * (only as far as needed) if the old focused element could be seen and the
   * new summary cannot be seen in full. A reader who scrolled away while the
   * focus stayed behind (a mouse click on a summary, then the wheel) is not
   * pulled back.
   */
  function restoreFocus(slot: BodySlot, spot: FocusSpot): void {
    const range = spot.range;
    const target = range === null ? undefined : slot.blocks.find((b) => b.summary !== null && b.start < range.end && range.start < b.end);
    if (target?.summary) {
      target.summary.focus({ preventScroll: true });
      if (spot.wasVisible) {
        const rect = target.summary.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > window.innerHeight) target.summary.scrollIntoView({ block: 'nearest' });
      }
      return;
    }
    // (If "Clear everything" removes this body before the focus leaves it,
    // its tabindex="-1" stays on an element no longer in the page: harmless.)
    setSafeAttribute(slot.body, 'tabindex', '-1');
    slot.body.addEventListener('blur', () => setSafeAttribute(slot.body, 'tabindex', false), { once: true });
    slot.body.focus({ preventScroll: true });
  }

  /**
   * Draws the blocks of a body (all of it). A new folded block is open when
   * "show quoted text" is ticked, or when a block it overlaps was open in
   * the body drawn before (`wasOpen`), so redrawing never closes what the
   * reader opened. If the keyboard focus was in one of the old blocks (a
   * fold's summary), it is put back on the matching new one (restoreFocus);
   * focus anywhere else is left alone.
   */
  function drawBlocks(slot: BodySlot, blocks: readonly PdfBlock[], wasOpen: readonly { start: number; end: number }[]): void {
    const focusSpot = focusSpotIn(slot);
    const built: BuiltBlock[] = [];
    const children: Node[] = [];
    for (const { block, label } of blocks) {
      if (!block.folded) {
        const text = el('div', { attrs: { class: 'body-text' }, text: block.text });
        if (label === null) {
          children.push(text);
          built.push({ start: block.start, end: block.end, details: null, summary: null, nodes: [text], label: null });
          continue;
        }
        // Shown text the plan leaves out (a bug, never expected): said all the same.
        const mark = el('p', { attrs: { class: 'pdf-label pdf-label-shown' } });
        applyLabel(mark, label);
        children.push(mark, text);
        built.push({ start: block.start, end: block.end, details: null, summary: null, nodes: [mark, text], label: mark });
        continue;
      }
      const mark = el('span', { attrs: { class: 'pdf-label' } });
      applyLabel(mark, label);
      const open = showFolded || wasOpen.some((o) => o.start < block.end && block.start < o.end);
      const summary = el('summary', {
        attrs: { class: 'fold-label' },
        children: [mark, el('span', { attrs: { class: 'fold-what' }, text: foldSummaryText(block, slot.position, slot.positionByIndex) })],
      });
      const details = el('details', {
        attrs: { class: 'fold', open },
        children: [summary, el('div', { attrs: { class: 'body-text body-folded' }, text: block.text })],
      });
      children.push(details);
      built.push({ start: block.start, end: block.end, details, summary, nodes: [details], label: mark });
    }
    if (blocks.length === 0) children.push(el('p', { attrs: { class: 'note body-empty' }, text: t('preview.noText') }));
    slot.body.replaceChildren(...children);
    // Recorded only once in the page: a build that threw above leaves nothing behind.
    for (const b of slot.blocks) if (b.details !== null) folds.delete(b.details);
    for (const b of built) if (b.details !== null) folds.add(b.details);
    slot.blocks = built;
    if (focusSpot !== null) restoreFocus(slot, focusSpot);
  }

  /** Brings one body up to date with the plans in use: labels in place when the blocks stay the same, else redrawn. */
  function updateBody(slot: BodySlot): void {
    const view = viewFor(slot.position);
    // Left out of the PDF (unticked): what was drawn stays, its labels and
    // note hidden (see `data-pdf-out` at the top of this file).
    const out = view === null && pdfPlans !== null && slot.shape !== NOT_DRAWN;
    setSafeAttribute(slot.body, 'data-pdf-out', out);
    setSafeAttribute(slot.note, 'data-pdf-out', out);
    if (out) return;
    const key = viewKey(view);
    if (key === slot.key) return;
    const m = slot.m;
    const blocks = pdfBlocks(m.message.bodyText, m.segments, view);
    const shape = shapeOf(blocks);
    if (shape === slot.shape) {
      blocks.forEach((b, i) => {
        const element = slot.blocks[i]?.label ?? null;
        if (element !== null) applyLabel(element, b.label);
      });
    } else {
      const wasOpen = slot.blocks.filter((b) => b.details?.hasAttribute('open') === true);
      drawBlocks(slot, blocks, wasOpen);
      slot.shape = shape;
    }
    const note = view === null ? null : pdfPlanNote(view.plan);
    slot.note.textContent = note === null ? '' : t(`review.pdfNote.${note}`);
    setSafeAttribute(slot.note, 'hidden', note === null);
    slot.key = key;
  }

  /** An email's body, with its PDF note (placed just above the body, outside the email's text). */
  function bodyOf(m: EngineMessage, position: number, positionByIndex: readonly (number | null)[]): BodySlot {
    const slot: BodySlot = {
      m,
      position,
      positionByIndex,
      body: el('div', { attrs: { class: 'message-body' } }),
      note: el('p', { attrs: { class: 'note pdf-note', hidden: true } }),
      key: '',
      shape: NOT_DRAWN, // never a real shape, so the first update draws
      blocks: [],
    };
    updateBody(slot);
    bodies.set(position, slot);
    return slot;
  }

  function itemOf(m: EngineMessage, position: number, result: EngineResult): HTMLLIElement {
    const message = m.message;
    const hasSubject = message.subject.trim() !== '';
    const heading = el('h3', {
      attrs: { id: headingId(position), class: 'message-heading' },
      children: [
        el('span', { attrs: { class: 'message-number' }, text: messageNumberText(position + 1) }),
        ' ',
        el('span', {
          attrs: { class: hasSubject ? 'message-subject' : 'message-subject placeholder' },
          text: hasSubject ? message.subject : t('preview.noSubject'),
        }),
      ],
    });

    const time = el('time', { attrs: { class: 'message-date' } });
    const senderNote = el('span', { attrs: { class: 'sender-time' } });
    const slot: DateSlot = { time, senderNote, date: message.date };
    applyDate(slot);
    slots.push(slot);

    const author = displayAuthor(message);
    const meta: Node[] = [
      ...row('date', t('preview.date'), [time, ' ', senderNote]),
      ...(author.source === 'none'
        ? row('author', t('preview.from'), [el('span', { attrs: { class: 'placeholder' }, text: t('preview.author.none') })])
        : row('author', t(`preview.author.${author.source}`), [mailboxListText(author.mailboxes)])),
    ];
    for (const [name, label, mailboxes] of [
      ['to', t('preview.to'), message.to],
      ['cc', t('preview.cc'), message.cc],
      ['bcc', t('preview.bcc'), message.bcc],
    ] as const) {
      const text = mailboxListText(mailboxes);
      if (text !== '') meta.push(...row(name, label, [text]));
    }
    if (message.attachments.length > 0) {
      const items = message.attachments.map((a) => el('li', { attrs: { class: 'attachment' }, text: attachmentText(a) }));
      meta.push(...row('attachments', t('preview.attachments'), [el('ul', { attrs: { class: 'attachment-list' }, children: items })]));
    }
    if (m.duplicates.length > 0) {
      const names = m.duplicates.map((d) => (d.source.fileName === '' ? t('added.noName') : d.source.fileName));
      meta.push(...row('also-in', t('preview.alsoIn'), [joinList(names)]));
    }

    const body = bodyOf(m, position, result.positionByIndex);
    const item = el('li', {
      attrs: { class: 'message', 'data-position': String(position) },
      children: [heading, el('dl', { attrs: { class: 'message-meta' }, children: meta }), body.note, body.body],
    });
    options.decorate?.(item, m, position, result);
    return item;
  }

  /**
   * Stand-in for an email whose item could not be built (a bug, or a
   * `decorate` hook that failed): its number, a calm note and its whole text
   * unfolded, so no email is ever silently missing from the list (README.md,
   * rule R6). Built from the plainest parts only. See decoratedFallbackOf
   * for the `decorate` hook.
   */
  function fallbackItemOf(m: EngineMessage | undefined, position: number): HTMLLIElement {
    const text = typeof m?.message?.bodyText === 'string' ? m.message.bodyText : '';
    // Its text is shown whole, without PDF labels: when the email is in the
    // PDF, a note says so (hidden while the labels are, see app.css).
    const pdfNote = el('p', { attrs: { class: 'note pdf-note', hidden: true }, text: t('pdf.messageFailed') });
    updateStandIn(position, pdfNote);
    // The last stand-in built for a position is the one in the page (see decoratedFallbackOf).
    standIns.set(position, pdfNote);
    return el('li', {
      attrs: { class: 'message message-failed', 'data-position': String(position) },
      children: [
        el('h3', {
          attrs: { id: headingId(position), class: 'message-heading' },
          children: [el('span', { attrs: { class: 'message-number' }, text: messageNumberText(position + 1) })],
        }),
        el('p', { attrs: { class: 'note message-failed-note' }, text: t('preview.itemFailed') }),
        pdfNote,
        el('div', { attrs: { class: 'message-body' }, children: text === '' ? [] : [el('div', { attrs: { class: 'body-text' }, text })] }),
      ],
    });
  }

  /**
   * The stand-in, passed to `decorate` too, so what later tasks add to each
   * item (warnings, include/exclude) covers every email, this one included.
   * If `decorate` fails again, a fresh, undecorated stand-in is used, so a
   * half-done decoration never reaches the page. Without a message (only a
   * bug can cause that) there is nothing to hand to `decorate`.
   */
  function decoratedFallbackOf(m: EngineMessage | undefined, position: number, result: EngineResult): HTMLLIElement {
    const item = fallbackItemOf(m, position);
    if (m === undefined || options.decorate === undefined) return item;
    try {
      options.decorate(item, m, position, result);
      return item;
    } catch {
      return fallbackItemOf(m, position);
    }
  }

  /** One email's item, or its stand-in if building it failed. Never throws for one bad email. */
  function safeItemOf(m: EngineMessage | undefined, position: number, result: EngineResult): HTMLLIElement {
    const slotCount = slots.length;
    try {
      if (m === undefined) throw new Error('missing message');
      return itemOf(m, position, result);
    } catch {
      // Forget the half-built item's dates, body and folds: they are not in the page.
      slots.length = slotCount;
      const body = bodies.get(position);
      if (body !== undefined) for (const b of body.blocks) if (b.details !== null) folds.delete(b.details);
      bodies.delete(position);
      return decoratedFallbackOf(m, position, result);
    }
  }

  // --- Chunked building -----------------------------------------------------
  function stopPending(): void {
    if (pending !== null) cancel(pending.handle);
    pending = null;
    setSafeAttribute(list, 'aria-busy', false);
  }

  function stopPdfPending(): void {
    if (pdfPending !== null) cancel(pdfPending.handle);
    pdfPending = null;
  }

  function clear(): void {
    stopPending();
    stopPdfPending();
    generation++;
    pdfGeneration++;
    slots = [];
    folds = new Set();
    bodies = new Map();
    standIns = new Map();
    currentResult = null;
    pdfPlans = null;
    setPdfState('off');
    list.replaceChildren();
  }

  /**
   * updateBody, never throwing: on a failure that email's labels are hidden
   * (never a stale one), its note says the labels could not be shown (so
   * the preview never silently says nothing), and it is tried again next time.
   */
  function safeUpdateBody(slot: BodySlot): void {
    try {
      updateBody(slot);
    } catch {
      for (const b of slot.blocks) if (b.label !== null) applyLabel(b.label, null);
      slot.note.textContent = t('pdf.messageFailed');
      setSafeAttribute(slot.note, 'hidden', false);
      slot.key = 'failed';
    }
  }

  /** A stand-in's PDF note: shown when its email is in the PDF plans (its text is shown whole, unlabelled). */
  function updateStandIn(position: number, note: HTMLParagraphElement): void {
    setSafeAttribute(note, 'hidden', viewFor(position) === null);
  }

  function setPdfPlans(plans: PreviewPdfPlans | null): void {
    stopPdfPending();
    pdfGeneration++;
    if (plans === null || currentResult === null || plans.result !== currentResult) {
      // Hidden at once; the bodies keep their old labels until new plans come.
      pdfPlans = null;
      setPdfState(currentResult === null ? 'off' : 'updating');
      return;
    }
    pdfPlans = plans;
    setPdfState('updating');
    // Stand-ins are few (only a bug makes one) and cheap: updated at once.
    for (const [position, note] of standIns) updateStandIn(position, note);
    const myGeneration = pdfGeneration;
    // The bodies built so far; those built later get the new labels as they are built.
    const todo = [...bodies.values()];
    let next = 0;
    const applyChunk = (): void => {
      if (myGeneration !== pdfGeneration) return; // newer plans, or clear(), came meanwhile
      pdfPending = null;
      let chars = 0;
      const first = next;
      const stop = Math.min(todo.length, next + chunkSize * PDF_CHUNK_FACTOR);
      while (next < stop && (next === first || chars < MAX_CHUNK_CHARS)) {
        const slot = todo[next];
        next++;
        if (slot === undefined) continue;
        safeUpdateBody(slot);
        chars += slot.m.message.bodyText.length;
      }
      if (next < todo.length) pdfPending = { handle: schedule(applyChunk) };
      else setPdfState('ready');
    };
    applyChunk();
  }

  function show(result: EngineResult): void {
    clear();
    currentResult = result;
    setPdfState(pdfState); // the status line takes its place now, before any tick
    const myGeneration = generation;
    const messages = result.messages;
    let next = 0;
    const buildChunk = (): void => {
      if (myGeneration !== generation) return; // a newer list or reset() came meanwhile
      pending = null;
      const items: HTMLLIElement[] = [];
      let chars = 0;
      try {
        while (next < messages.length && items.length < chunkSize && (items.length === 0 || chars < MAX_CHUNK_CHARS)) {
          const m = messages[next];
          const position = next;
          next++; // moved on first: an email is never tried twice
          items.push(safeItemOf(m, position, result));
          const body = m?.message?.bodyText;
          chars += typeof body === 'string' ? body.length : 0;
        }
      } finally {
        // Whatever happened above, what was built is shown and the rest of
        // the list is still scheduled: no email is silently left out.
        list.append(...items);
        if (next < messages.length) {
          setSafeAttribute(list, 'aria-busy', 'true');
          pending = { handle: schedule(buildChunk) };
        } else {
          setSafeAttribute(list, 'aria-busy', false);
          try {
            options.onRendered?.(result);
          } catch {
            // The list is complete either way.
          }
        }
      }
    };
    buildChunk();
  }

  // --- Controls -------------------------------------------------------------
  zoneSelect.addEventListener('change', () => {
    zone = zoneSelect.value;
    for (const slot of slots) applyDate(slot);
    try {
      options.onZoneChange?.();
    } catch {
      // The dates are shown in the new zone either way.
    }
  });
  foldToggle.addEventListener('change', () => {
    showFolded = foldToggle.checked;
    for (const details of folds) setSafeAttribute(details, 'open', showFolded);
  });

  return {
    show,
    showResult(result) {
      if (result.ok) show(result.engine);
      else clear();
    },
    reset() {
      clear();
      // Back to the start: the next person or batch begins from the defaults.
      zone = homeZone;
      zoneSelect.value = homeZone;
      showFolded = false;
      foldToggle.checked = false;
    },
    zone: () => zone,
    isRendering: () => pending !== null,
    setPdfPlans,
    pdfPlansFailed() {
      stopPdfPending();
      pdfGeneration++;
      pdfPlans = null;
      setPdfState(currentResult === null ? 'off' : 'failed');
    },
    pdfLabelState: () => pdfState,
  };
}
