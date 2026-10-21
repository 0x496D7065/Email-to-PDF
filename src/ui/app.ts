// The page structure: one screen, three steps (add, check, download).
//
// This builds the empty, accessible shell; the steps are filled in later:
// step 1 gets the file picker, step 2 the preview, step 3 the PDF button's
// action (src/ui/download-step.ts). Every visible word comes from the
// strings module (i18n/) and is set with textContent through el()
// (README.md, rule R4).
//
// Accessibility choices:
// - Landmarks: <header> (banner), <main>, <footer> (contentinfo). Each step
//   is a <section> named by its heading, so screen reader users can jump
//   between the three steps.
// - One live region (role="status", aria-live="polite") for progress and
//   results. It exists from the start: screen readers only announce changes
//   to a live region that was already on the page.
// - The "Make the PDF" button is NOT `disabled` but aria-disabled="true"
//   while it is unavailable, linked with aria-describedby to its note, which
//   says why (at first: add your emails). A disabled button cannot be
//   reached with the Tab key, so a keyboard or screen reader user would never
//   learn why it is unavailable. "Clear everything" uses the same pattern
//   while there is nothing to clear.
// - "Clear everything" sits at the end of step 1: right under the files the
//   user added (where someone who wants them gone looks first), after the
//   "choose" button in the Tab order, and away from the other actions so it
//   is not pressed by mistake (it asks no confirmation). Its note says what
//   it does. src/ui/page.ts gives it its action.
//
// Nothing here is stored anywhere (README.md, rule R5).

import { el, setSafeAttribute } from './dom';
import { LOCALE, t } from './i18n';

/** What later tasks use to fill the page. */
export interface AppShell {
  /** Step 1 container: the file picker goes here. */
  readonly addArea: HTMLDivElement;
  /** Step 2 container: the preview goes here. Hidden until setCheckReady(true). */
  readonly checkArea: HTMLDivElement;
  /** Step 3 button, "Make the PDF". aria-disabled="true" until src/ui/download-step.ts makes it available. */
  readonly downloadButton: HTMLButtonElement;
  /** Step 3 note under the button, its accessible description: what it does now, or why it is unavailable. */
  readonly downloadNote: HTMLParagraphElement;
  /** Step 3 container under the note: the "Download again" link goes here. */
  readonly downloadArea: HTMLDivElement;
  /** "Clear everything", at the end of step 1. aria-disabled="true" until setClearAvailable(true). */
  readonly clearButton: HTMLButtonElement;
  /** Makes "Clear everything" available (there is something to clear) or not. */
  setClearAvailable(available: boolean): void;
  /** Shows (and lets screen readers announce) a short status message. '' clears it. */
  setStatus(message: string): void;
  /** Switches step 2 between "waiting for emails" and showing its container. */
  setCheckReady(ready: boolean): void;
}

/** A step heading: a small "Step N" label above the title, both in the accessible name. */
function stepHeading(id: string, number: number, title: string): HTMLHeadingElement {
  return el('h2', {
    attrs: { id, class: 'step-title' },
    children: [
      el('span', { attrs: { class: 'step-number' }, text: t('steps.number', { number }) }),
      // A real space, so the accessible name reads "Step 1 Add your emails"
      // and not "Step 1Add your emails" (the label is shown on its own line).
      ' ',
      el('span', { attrs: { class: 'step-name' }, text: title }),
    ],
  });
}

/** One step section, named by its heading (so it is a navigable region). */
function stepSection(id: string, number: number, title: string, body: readonly Node[]): HTMLElement {
  const headingId = `${id}-title`;
  return el('section', {
    attrs: { id, class: 'step', 'aria-labelledby': headingId },
    children: [stepHeading(headingId, number, title), ...body],
  });
}

/** Builds the shell inside `root` (replacing anything in it) and returns its handles. */
export function mountApp(root: HTMLElement): AppShell {
  setSafeAttribute(document.documentElement, 'lang', LOCALE);
  document.title = t('app.name');

  const header = el('header', {
    attrs: { class: 'site-header' },
    children: [
      el('h1', { attrs: { class: 'app-name' }, text: t('app.name') }),
      el('p', { attrs: { class: 'promise' }, text: t('app.promise') }),
    ],
  });

  const status = el('p', { attrs: { id: 'status', class: 'status', role: 'status', 'aria-live': 'polite' } });

  const addArea = el('div', { attrs: { id: 'add-area', class: 'step-body' } });
  // Unavailable until there is something to clear (same aria-disabled
  // pattern as the download button below).
  const clearButton = el('button', {
    attrs: {
      type: 'button',
      id: 'clear-everything',
      class: 'button button-secondary',
      'aria-disabled': 'true',
      'aria-describedby': 'clear-note',
    },
    text: t('actions.clearEverything'),
  });
  const addStep = stepSection('step-add', 1, t('steps.add.title'), [
    el('p', { attrs: { class: 'step-intro' }, text: t('steps.add.intro') }),
    addArea,
    el('div', {
      attrs: { id: 'clear-area', class: 'clear-area' },
      children: [clearButton, el('p', { attrs: { id: 'clear-note', class: 'note' }, text: t('clear.note') })],
    }),
  ]);

  const checkWaiting = el('p', { attrs: { id: 'check-waiting', class: 'note' }, text: t('steps.check.waiting') });
  const checkArea = el('div', { attrs: { id: 'check-area', class: 'step-body', hidden: true } });
  const checkStep = stepSection('step-check', 2, t('steps.check.title'), [
    el('p', { attrs: { class: 'step-intro' }, text: t('steps.check.intro') }),
    checkWaiting,
    checkArea,
  ]);
  setSafeAttribute(checkStep, 'data-state', 'waiting');

  const downloadButton = el('button', {
    attrs: {
      type: 'button',
      id: 'download-button',
      class: 'button button-primary',
      'aria-disabled': 'true',
      'aria-describedby': 'download-note',
    },
    text: t('actions.makePdf'),
  });
  const downloadNote = el('p', { attrs: { id: 'download-note', class: 'note download-note' }, text: t('download.unavailable.no-emails') });
  const downloadArea = el('div', { attrs: { id: 'download-area', class: 'download-area' } });
  const downloadStep = stepSection('step-download', 3, t('steps.download.title'), [
    el('p', { attrs: { class: 'step-intro' }, text: t('steps.download.intro') }),
    downloadButton,
    downloadNote,
    downloadArea,
  ]);

  const main = el('main', { attrs: { id: 'main', class: 'steps' }, children: [status, addStep, checkStep, downloadStep] });

  // The privacy panel link comes here later (no external link yet).
  const footer = el('footer', {
    attrs: { class: 'site-footer' },
    children: [el('p', { text: t('footer.note') })],
  });

  root.replaceChildren(header, main, footer);

  return {
    addArea,
    checkArea,
    downloadButton,
    downloadNote,
    downloadArea,
    clearButton,
    setClearAvailable(available) {
      setSafeAttribute(clearButton, 'aria-disabled', available ? false : 'true');
    },
    setStatus(message) {
      status.textContent = message;
    },
    setCheckReady(ready) {
      setSafeAttribute(checkStep, 'data-state', ready ? 'ready' : 'waiting');
      setSafeAttribute(checkWaiting, 'hidden', ready);
      setSafeAttribute(checkArea, 'hidden', !ready);
    },
  };
}
