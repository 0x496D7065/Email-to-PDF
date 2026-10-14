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
// emails. A new result or reset() cancels the chunks still waiting. If one
// email's item cannot be built, a stand-in with its number and whole text
// takes its place and the rest of the list is still built: no email is ever
// silently missing.
//
// Not here (later tasks): warnings, include/exclude checkboxes and counts.
// `decorate` is the hook they use to add to each email's item.

import type { EngineMessage, EngineResult } from '../engine/engine';
import { browserTimeZone, formatInZone, formatSenderLocal, isDisplayableMs, listTimeZones } from '../engine/time-format';
import type { AttachmentInfo, EmailAddress, EmailDate } from '../parsing/types';
import type { ProcessResult } from '../pipeline/process-files';
import { displayAuthor } from '../ui-model/display-author';
import { displayBlocks, type DisplayBlock } from '../ui-model/display-blocks';
import type { AppShell } from './app';
import { el, setSafeAttribute } from './dom';
import { LOCALE, t } from './i18n';

/** Emails built per chunk (at least one per chunk, see MAX_CHUNK_CHARS). */
export const DEFAULT_CHUNK_SIZE = 40;
/** A chunk also ends once its bodies hold this many characters, so a few huge emails do not freeze the page. */
export const MAX_CHUNK_CHARS = 500_000;

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
  /**
   * Hook for later tasks (warnings, include/exclude): called for each
   * email's list item after it is built. If building or decorating fails,
   * it is called again with that email's stand-in (`.message-failed`), so
   * it must not assume one call per position and must not keep references
   * from a call that threw.
   */
  readonly decorate?: (item: HTMLLIElement, message: EngineMessage, position: number) => void;
}

export interface Preview {
  /** Shows the emails of a result (replacing what was shown). */
  show(result: EngineResult): void;
  /** Shows a step 1 result: its emails, or nothing after a batch error. */
  showResult(result: ProcessResult): void;
  /** Empties the list and cancels any chunk still waiting. */
  reset(): void;
  /** The selected time zone. */
  zone(): string;
  /** True while chunks are still waiting to be built. */
  isRendering(): boolean;
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
  let folds: HTMLDetailsElement[] = [];
  let pending: { handle: unknown } | null = null;
  // Increased by each show() and reset(): a chunk of an older list does nothing.
  let generation = 0;

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
    ],
  });

  // role="list": some screen readers drop the list role when the numbers are hidden by CSS.
  const list = el('ol', { attrs: { id: 'preview-list', class: 'message-list', role: 'list', 'aria-label': t('preview.listLabel') } });
  shell.checkArea.replaceChildren(toolbar, list);

  // --- Building one email ---------------------------------------------------
  function applyDate(slot: DateSlot): void {
    const texts = dateTexts(slot.date, zone);
    slot.time.textContent = texts.main;
    setSafeAttribute(slot.time, 'datetime', texts.iso ?? false);
    slot.senderNote.textContent = texts.senderLocal ?? '';
    setSafeAttribute(slot.senderNote, 'hidden', texts.senderLocal === null);
  }

  function bodyOf(m: EngineMessage, position: number, positionByIndex: readonly (number | null)[]): HTMLDivElement {
    const blocks = displayBlocks(m.message.bodyText, m.segments, { unfoldAll: false });
    const children: Node[] = blocks.map((block) => {
      if (!block.folded) return el('div', { attrs: { class: 'body-text' }, text: block.text });
      const details = el('details', {
        attrs: { class: 'fold', open: showFolded },
        children: [
          el('summary', { attrs: { class: 'fold-label' }, text: foldSummaryText(block, position, positionByIndex) }),
          el('div', { attrs: { class: 'body-text body-folded' }, text: block.text }),
        ],
      });
      folds.push(details);
      return details;
    });
    if (children.length === 0) children.push(el('p', { attrs: { class: 'note body-empty' }, text: t('preview.noText') }));
    return el('div', { attrs: { class: 'message-body' }, children });
  }

  function itemOf(m: EngineMessage, position: number, result: EngineResult): HTMLLIElement {
    const message = m.message;
    const hasSubject = message.subject.trim() !== '';
    const heading = el('h3', {
      attrs: { class: 'message-heading' },
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

    const item = el('li', {
      attrs: { class: 'message', 'data-position': String(position) },
      children: [heading, el('dl', { attrs: { class: 'message-meta' }, children: meta }), bodyOf(m, position, result.positionByIndex)],
    });
    options.decorate?.(item, m, position);
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
    return el('li', {
      attrs: { class: 'message message-failed', 'data-position': String(position) },
      children: [
        el('h3', {
          attrs: { class: 'message-heading' },
          children: [el('span', { attrs: { class: 'message-number' }, text: messageNumberText(position + 1) })],
        }),
        el('p', { attrs: { class: 'note message-failed-note' }, text: t('preview.itemFailed') }),
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
  function decoratedFallbackOf(m: EngineMessage | undefined, position: number): HTMLLIElement {
    const item = fallbackItemOf(m, position);
    if (m === undefined || options.decorate === undefined) return item;
    try {
      options.decorate(item, m, position);
      return item;
    } catch {
      return fallbackItemOf(m, position);
    }
  }

  /** One email's item, or its stand-in if building it failed. Never throws for one bad email. */
  function safeItemOf(m: EngineMessage | undefined, position: number, result: EngineResult): HTMLLIElement {
    const slotCount = slots.length;
    const foldCount = folds.length;
    try {
      if (m === undefined) throw new Error('missing message');
      return itemOf(m, position, result);
    } catch {
      // Forget the half-built item's dates and folds: they are not in the page.
      slots.length = slotCount;
      folds.length = foldCount;
      return decoratedFallbackOf(m, position);
    }
  }

  // --- Chunked building -----------------------------------------------------
  function stopPending(): void {
    if (pending !== null) cancel(pending.handle);
    pending = null;
    setSafeAttribute(list, 'aria-busy', false);
  }

  function clear(): void {
    stopPending();
    generation++;
    slots = [];
    folds = [];
    list.replaceChildren();
  }

  function show(result: EngineResult): void {
    clear();
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
        }
      }
    };
    buildChunk();
  }

  // --- Controls -------------------------------------------------------------
  zoneSelect.addEventListener('change', () => {
    zone = zoneSelect.value;
    for (const slot of slots) applyDate(slot);
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
    reset: clear,
    zone: () => zone,
    isRendering: () => pending !== null,
  };
}
