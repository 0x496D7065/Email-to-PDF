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
//   while there is nothing to clear: a visible reason in front of its note,
//   read first in its description.
// - "Clear everything" sits at the end of step 1: right under the files the
//   user added (where someone who wants them gone looks first), after the
//   "choose" button in the Tab order, and away from the other actions so it
//   is not pressed by mistake (it asks no confirmation). Its note says what
//   it does. src/ui/page.ts gives it its action.
// - The privacy panel is a native <details>/<summary> in the header, closed
//   by default: the summary is the first Tab stop of the page, and Enter or
//   Space opens and closes it with no script of ours. Nothing traps the
//   focus and nothing covers the steps (a dialog would need both handled).
//   Its topics are h2 headings, right under the page's h1 and before the
//   steps' h2 headings, so the heading levels never skip. It only shows text
//   (README.md, rules R1 and R5): no link yet.
// - A short disclaimer closes step 3 (repeated in the panel). It is on the
//   page from the start, under the download line that keeps its height, so
//   nothing moves when the PDF is made.
//
// Nothing here is stored anywhere (README.md, rule R5).

import { el, setSafeAttribute } from './dom';
import { LOCALE, t, type PlainMessageKey } from './i18n';

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

/** One topic of the privacy panel: an h2 heading and its points, in this order. */
interface PrivacyTopic {
  readonly id: string;
  readonly title: PlainMessageKey;
  readonly points: readonly PlainMessageKey[];
  /** 'list': a bulleted list; 'paragraphs': one short paragraph each. */
  readonly as: 'list' | 'paragraphs';
}

const PRIVACY_TOPICS: readonly PrivacyTopic[] = [
  {
    id: 'privacy-does',
    title: 'privacy.does.title',
    points: ['privacy.does.local', 'privacy.does.noUpload', 'privacy.does.noSaving', 'privacy.does.wiped', 'privacy.does.pdf'],
    as: 'list',
  },
  {
    id: 'privacy-never',
    title: 'privacy.never.title',
    points: ['privacy.never.upload', 'privacy.never.tracking', 'privacy.never.remote', 'privacy.never.attachments'],
    as: 'list',
  },
  {
    id: 'privacy-check',
    title: 'privacy.check.title',
    // privacy.check.source is the one place where the repository link will
    // be added (a plain link the user clicks, README.md, rule R1).
    points: ['privacy.check.offline', 'privacy.check.network', 'privacy.check.source'],
    as: 'list',
  },
  {
    id: 'privacy-notes',
    title: 'privacy.notes.title',
    points: ['privacy.notes.trust', 'privacy.notes.console', 'privacy.notes.scripts', 'disclaimer.text'],
    as: 'paragraphs',
  },
];

/** The privacy panel: a closed <details> whose summary opens it (see the top of this file). */
function privacyPanel(): HTMLDetailsElement {
  const topics = PRIVACY_TOPICS.map((topic) => {
    const headingId = `${topic.id}-title`;
    const points =
      topic.as === 'list'
        ? [el('ul', { attrs: { class: 'privacy-list' }, children: topic.points.map((key) => el('li', { text: t(key) })) })]
        : topic.points.map((key) => el('p', { attrs: { class: 'privacy-text' }, text: t(key) }));
    // A plain div, not a named section: four more landmarks would only
    // clutter the page's landmark list; the headings are enough to navigate.
    return el('div', {
      attrs: { id: topic.id, class: 'privacy-topic' },
      children: [el('h2', { attrs: { id: headingId, class: 'privacy-heading' }, text: t(topic.title) }), ...points],
    });
  });
  return el('details', {
    attrs: { id: 'privacy', class: 'privacy' },
    children: [
      el('summary', { attrs: { id: 'privacy-summary', class: 'privacy-summary' }, text: t('privacy.summary') }),
      el('div', { attrs: { class: 'privacy-body' }, children: topics }),
    ],
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
      privacyPanel(),
    ],
  });

  const status = el('p', { attrs: { id: 'status', class: 'status', role: 'status', 'aria-live': 'polite' } });

  const addArea = el('div', { attrs: { id: 'add-area', class: 'step-body' } });
  // Unavailable until there is something to clear (same aria-disabled
  // pattern as the download button below). Meanwhile a visible reason sits
  // in front of the note, and the button's description reads it first.
  const CLEAR_DESCRIBED_UNAVAILABLE = 'clear-unavailable clear-note';
  const clearButton = el('button', {
    attrs: {
      type: 'button',
      id: 'clear-everything',
      class: 'button button-secondary',
      'aria-disabled': 'true',
      'aria-describedby': CLEAR_DESCRIBED_UNAVAILABLE,
    },
    text: t('actions.clearEverything'),
  });
  const clearUnavailable = el('p', { attrs: { id: 'clear-unavailable', class: 'note clear-unavailable' }, text: t('clear.unavailable') });
  const addStep = stepSection('step-add', 1, t('steps.add.title'), [
    el('p', { attrs: { class: 'step-intro' }, text: t('steps.add.intro') }),
    addArea,
    el('div', {
      attrs: { id: 'clear-area', class: 'clear-area' },
      children: [clearButton, clearUnavailable, el('p', { attrs: { id: 'clear-note', class: 'note' }, text: t('clear.note') })],
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
    el('p', { attrs: { id: 'download-disclaimer', class: 'note disclaimer' }, text: t('disclaimer.text') }),
  ]);

  const main = el('main', { attrs: { id: 'main', class: 'steps' }, children: [status, addStep, checkStep, downloadStep] });

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
      setSafeAttribute(clearButton, 'aria-describedby', available ? 'clear-note' : CLEAR_DESCRIBED_UNAVAILABLE);
      setSafeAttribute(clearUnavailable, 'hidden', available);
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
