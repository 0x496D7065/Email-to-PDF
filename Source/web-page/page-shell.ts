// The page structure: one screen, three steps (add, check, download).
//
// This builds the empty, accessible shell; the steps are filled in later:
// step 1 gets the file picker, step 2 the preview, step 3 the PDF button's
// action (Source/web-page/download-step.ts). Every visible word comes from the
// strings module (translations/) and is set with textContent through createSafeElement()
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
//   it does. Source/web-page/mount-page.ts gives it its action.
// - The privacy panel is a native <details>/<summary> in the header, closed
//   by default: the summary is the first Tab stop after the header's top
//   row (the language picker and the Ko-fi button), and Enter or
//   Space opens and closes it with no script of ours. Nothing traps the
//   focus and nothing covers the steps (a dialog would need both handled).
//   Its topics are h2 headings, right under the page's h1 and before the
//   steps' h2 headings, so the heading levels never skip. It only shows text
//   (README.md, rules R1 and R5): no link yet.
// - The Ko-fi donation button (donationLink in Source/web-page/safe-dom.ts): a plain link
//   around Ko-fi's own button image, bundled with the site, that opens Ko-fi
//   in a new tab. Nothing is loaded from Ko-fi until the reader clicks it
//   (README.md, rule R1). It sits at the top right, in the language
//   picker's row (app.css), and comes right after the picker in the page
//   too, so the Tab order and screen readers follow what is seen: picker,
//   Ko-fi button, then the title and the privacy panel. Its name is the
//   image's alt text, which also says that it opens a new tab.
// - The step 1 help ("How do I get my email files?") is the same kind of
//   native <details>, closed by default, between step 1's intro and the drop
//   zone: it is the Tab stop right before the "choose" button, and holds no
//   control. Its mail programs are a list (so a screen reader says how many
//   there are), each with its name as an h3 heading: the help sits inside
//   step 1, whose title is an h2, so the levels never skip (the failed-files
//   title further down step 1 is an h3 too). Every line is hedged: nothing
//   has been checked against the real mail programs yet. No links, no URLs.
//   Whether it is open is never stored (README.md, rule R5).
// - A short disclaimer closes step 3 (repeated in the panel). It is on the
//   page from the start, under the download line that keeps its height, so
//   nothing moves when the PDF is made.
//
// - The language picker (Source/web-page/mount-page.ts switches the language): a
//   <fieldset> with a <legend> and one native radio per language, first in
//   the header (at the top left), so its place in the page, on screen and
//   in the Tab order agree. Radios, not a <select>: WebKit reports every <select> as a CSP
//   style violation (see Helper/Test/browser-tests/support/network-and-csp-watch.ts), and the arrow keys move
//   between radios with no script of ours. Each radio and its label carry
//   their language's lang attribute, and the label shows the language's own
//   name (never translated). The radios are never rebuilt, so the focus
//   stays on the one just picked. With a single language the picker is not
//   built at all: the page and its Tab order are as before.
//
// Switching language: relabel() writes every fixed word of the shell again
// in the new language (Source/web-page/static-labels.ts). The steps' own texts belong to
// their modules (each has a relabel()).
//
// Nothing here is stored anywhere (README.md, rule R5).

import { donationLink, createSafeElement, setSafeAttribute } from './safe-dom';
import { getLocale, languageName, SUPPORTED_LOCALES, t, type PlainMessageKey } from './translations';
import { createStaticLabels, type StaticLabels } from './static-labels';

/** What later tasks use to fill the page. */
export interface PageShell
{
    /** Step 1 container: the file picker goes here. */
    readonly addArea: HTMLDivElement;
    /** Step 2 container: the preview goes here. Hidden until setCheckReady(true). */
    readonly checkArea: HTMLDivElement;
    /** Step 3 button, "Make the PDF". aria-disabled="true" until Source/web-page/download-step.ts makes it available. */
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
    /** What the status line says now (step 3 checks it still says its own words before correcting them). */
    statusText(): string;
    /** Switches step 2 between "waiting for emails" and showing its container. */
    setCheckReady(ready: boolean): void;
    /** Writes the shell's own words again in the page language now (and ticks its radio in the picker). */
    relabel(): void;
}

export interface PageShellOptions
{
    /** The reader picked another language in the picker (Source/web-page/mount-page.ts). */
    readonly onLanguageChange?: (locale: string) => void;
    /** The languages offered (default: SUPPORTED_LOCALES). The picker is built only for two or more. */
    readonly locales?: readonly string[];
}

/** Sets <html lang> and the tab's title for the page language. The app's name is the same in every language. */
export function applyDocumentLanguage(): void
{
    setSafeAttribute(document.documentElement, 'lang', getLocale());
    document.title = t('app.name');
}

/** A step heading: a small "Step N" label above the title, both in the accessible name. */
function stepHeading(labels: StaticLabels, id: string, number: number, title: PlainMessageKey): HTMLHeadingElement
{
    return createSafeElement('h2', {
        attrs: { id, class: 'step-title' },
        children: [
            labels.text(createSafeElement('span', { attrs: { class: 'step-number' } }), 'steps.number', { number }),
            // A real space, so the accessible name reads "Step 1 Add your emails"
            // and not "Step 1Add your emails" (the label is shown on its own line).
            ' ',
            labels.text(createSafeElement('span', { attrs: { class: 'step-name' } }), title),
        ],
    });
}

/** One step section, named by its heading (so it is a navigable region). */
function stepSection(labels: StaticLabels, id: string, number: number, title: PlainMessageKey, body: readonly Node[]): HTMLElement
{
    const headingId = `${id}-title`;
    return createSafeElement('section', {
        attrs: { id, class: 'step', 'aria-labelledby': headingId },
        children: [stepHeading(labels, headingId, number, title), ...body],
    });
}

/** One topic of the privacy panel: an h2 heading and its points, in this order. */
interface PrivacyTopic
{
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
        points: ['privacy.notes.trust', 'privacy.notes.hostReports', 'privacy.notes.console', 'privacy.notes.scripts', 'disclaimer.text'],
        as: 'paragraphs',
    },
];

/** The privacy panel: a closed <details> whose summary opens it (see the top of this file). */
function privacyPanel(labels: StaticLabels): HTMLDetailsElement
{
    const topics = PRIVACY_TOPICS.map((topic) =>
    {
        const headingId = `${topic.id}-title`;
        const points =
            topic.as === 'list'
                ? [createSafeElement('ul', { attrs: { class: 'privacy-list' }, children: topic.points.map((key) => labels.text(createSafeElement('li'), key)) })]
                : topic.points.map((key) => labels.text(createSafeElement('p', { attrs: { class: 'privacy-text' } }), key));
        // A plain div, not a named section: four more landmarks would only
        // clutter the page's landmark list; the headings are enough to navigate.
        return createSafeElement('div', {
            attrs: { id: topic.id, class: 'privacy-topic' },
            children: [labels.text(createSafeElement('h2', { attrs: { id: headingId, class: 'privacy-heading' } }), topic.title), ...points],
        });
    });
    return createSafeElement('details', {
        attrs: { id: 'privacy', class: 'privacy' },
        children: [
            labels.text(createSafeElement('summary', { attrs: { id: 'privacy-summary', class: 'privacy-summary' } }), 'privacy.summary'),
            createSafeElement('div', { attrs: { class: 'privacy-body' }, children: topics }),
        ],
    });
}

/** The mail programs of the step 1 help, in the order shown (keys under help.clients in en.ts). */
export const HELP_CLIENTS = ['outlookClassic', 'outlookNew', 'thunderbird', 'appleMail', 'gmail'] as const;

/**
 * The step 1 help, "How do I get my email files?": a closed <details> right
 * above the drop zone (see the top of this file). A short intro, one list
 * item per mail program (its name as an h3, then one or two sentences), and
 * a closing note.
 */
function helpPanel(labels: StaticLabels): HTMLDetailsElement
{
    const items = HELP_CLIENTS.map((client) =>
        createSafeElement('li', {
            attrs: { class: 'help-client' },
            children: [
                labels.text(createSafeElement('h3', { attrs: { class: 'help-heading' } }), `help.clients.${client}.name`),
                labels.text(createSafeElement('p', { attrs: { class: 'help-text' } }), `help.clients.${client}.how`),
            ],
        }),
    );
    return createSafeElement('details', {
        attrs: { id: 'help', class: 'help' },
        children: [
            labels.text(createSafeElement('summary', { attrs: { id: 'help-summary', class: 'help-summary' } }), 'help.summary'),
            createSafeElement('div', {
                attrs: { class: 'help-body' },
                children: [
                    labels.text(createSafeElement('p', { attrs: { class: 'help-text' } }), 'help.intro'),
                    createSafeElement('ul', { attrs: { id: 'help-list', class: 'help-list' }, children: items }),
                    labels.text(createSafeElement('p', { attrs: { class: 'help-text' } }), 'help.note'),
                ],
            }),
        ],
    });
}

/** The id of one language's radio in the picker (also what its label points at). */
export function languageRadioId(locale: string): string
{
    return `lang-${locale}`;
}

/**
 * The language picker (see the top of this file): one radio per language,
 * the page language ticked. Picking one calls `onChange` with its code.
 */
function languagePicker(
    labels: StaticLabels,
    locales: readonly string[],
    onChange: (locale: string) => void,
): { readonly fieldset: HTMLFieldSetElement; readonly radios: ReadonlyMap<string, HTMLInputElement> }
{
    const radios = new Map<string, HTMLInputElement>();
    const options = locales.map((locale) =>
    {
        const id = languageRadioId(locale);
        const ticked = locale === getLocale();
        const radio = createSafeElement('input', { attrs: { type: 'radio', id, name: 'language', value: locale, lang: locale, checked: ticked } });
        radio.checked = ticked;
        radio.addEventListener('change', () =>
        {
            if (radio.checked)
            {
                onChange(locale);
            }
        });
        radios.set(locale, radio);
        // The language's own name, in its own language (never translated).
        return createSafeElement('div', {
            attrs: { class: 'language-option' },
            children: [radio, createSafeElement('label', { attrs: { for: id, lang: locale }, text: languageName(locale) })],
        });
    });
    const fieldset = createSafeElement('fieldset', {
        attrs: { id: 'language', class: 'language' },
        children: [labels.text(createSafeElement('legend', { attrs: { class: 'language-legend' } }), 'language.label'), ...options],
    });
    return { fieldset, radios };
}

/** Builds the shell inside `root` (replacing anything in it) and returns its handles. */
export function mountPageShell(root: HTMLElement, options: PageShellOptions = {}): PageShell
{
    applyDocumentLanguage();
    const labels = createStaticLabels();

    // Built only when there is a choice to make (see the top of this file).
    const locales = options.locales ?? SUPPORTED_LOCALES;
    const picker = locales.length >= 2 ? languagePicker(labels, locales, (locale) => options.onLanguageChange?.(locale)) : null;

    // The Ko-fi button (see the top of this file): named by its image's alt text.
    const donate = donationLink('donate-link');
    labels.attr(donate.image, 'alt', 'donate.label');

    const header = createSafeElement('header', {
        attrs: { class: 'site-header' },
        children: [
            ...(picker === null ? [] : [picker.fieldset]),
            donate.link,
            labels.text(createSafeElement('h1', { attrs: { class: 'app-name' } }), 'app.name'),
            labels.text(createSafeElement('p', { attrs: { class: 'promise' } }), 'app.promise'),
            privacyPanel(labels),
        ],
    });

    const status = createSafeElement('p', { attrs: { id: 'status', class: 'status', role: 'status', 'aria-live': 'polite' } });

    const addArea = createSafeElement('div', { attrs: { id: 'add-area', class: 'step-body' } });
    // Unavailable until there is something to clear (same aria-disabled
    // pattern as the download button below). Meanwhile a visible reason sits
    // in front of the note, and the button's description reads it first.
    const CLEAR_DESCRIBED_UNAVAILABLE = 'clear-unavailable clear-note';
    const clearButton = createSafeElement('button', {
        attrs: {
            type: 'button',
            id: 'clear-everything',
            class: 'button button-secondary',
            'aria-disabled': 'true',
            'aria-describedby': CLEAR_DESCRIBED_UNAVAILABLE,
        },
    });
    labels.text(clearButton, 'actions.clearEverything');
    const clearUnavailable = labels.text(createSafeElement('p', { attrs: { id: 'clear-unavailable', class: 'note clear-unavailable' } }), 'clear.unavailable');
    const addStep = stepSection(labels, 'step-add', 1, 'steps.add.title', [
        labels.text(createSafeElement('p', { attrs: { class: 'step-intro' } }), 'steps.add.intro'),
        helpPanel(labels),
        addArea,
        createSafeElement('div', {
            attrs: { id: 'clear-area', class: 'clear-area' },
            children: [clearButton, clearUnavailable, labels.text(createSafeElement('p', { attrs: { id: 'clear-note', class: 'note' } }), 'clear.note')],
        }),
    ]);

    const checkWaiting = labels.text(createSafeElement('p', { attrs: { id: 'check-waiting', class: 'note' } }), 'steps.check.waiting');
    const checkArea = createSafeElement('div', { attrs: { id: 'check-area', class: 'step-body', hidden: true } });
    const checkStep = stepSection(labels, 'step-check', 2, 'steps.check.title', [
        labels.text(createSafeElement('p', { attrs: { class: 'step-intro' } }), 'steps.check.intro'),
        checkWaiting,
        checkArea,
    ]);
    setSafeAttribute(checkStep, 'data-state', 'waiting');

    const downloadButton = createSafeElement('button', {
        attrs: {
            type: 'button',
            id: 'download-button',
            class: 'button button-primary',
            'aria-disabled': 'true',
            'aria-describedby': 'download-note',
        },
    });
    labels.text(downloadButton, 'actions.makePdf');
    // Its text follows step 3's state: Source/web-page/download-step.ts writes it (again on a language change too).
    const downloadNote = createSafeElement('p', { attrs: { id: 'download-note', class: 'note download-note' }, text: t('download.unavailable.no-emails') });
    const downloadArea = createSafeElement('div', { attrs: { id: 'download-area', class: 'download-area' } });
    const downloadStep = stepSection(labels, 'step-download', 3, 'steps.download.title', [
        labels.text(createSafeElement('p', { attrs: { class: 'step-intro' } }), 'steps.download.intro'),
        downloadButton,
        downloadNote,
        downloadArea,
        labels.text(createSafeElement('p', { attrs: { id: 'download-disclaimer', class: 'note disclaimer' } }), 'disclaimer.text'),
    ]);

    const main = createSafeElement('main', { attrs: { id: 'main', class: 'steps' }, children: [status, addStep, checkStep, downloadStep] });

    const footer = createSafeElement('footer', {
        attrs: { class: 'site-footer' },
        children: [labels.text(createSafeElement('p'), 'footer.note')],
    });

    root.replaceChildren(header, main, footer);

    return {
        addArea,
        checkArea,
        downloadButton,
        downloadNote,
        downloadArea,
        clearButton,
        setClearAvailable(available)
        {
            setSafeAttribute(clearButton, 'aria-disabled', available ? false : 'true');
            setSafeAttribute(clearButton, 'aria-describedby', available ? 'clear-note' : CLEAR_DESCRIBED_UNAVAILABLE);
            setSafeAttribute(clearUnavailable, 'hidden', available);
        },
        setStatus(message)
        {
            status.textContent = message;
        },
        statusText: () => status.textContent ?? '',
        setCheckReady(ready)
        {
            setSafeAttribute(checkStep, 'data-state', ready ? 'ready' : 'waiting');
            setSafeAttribute(checkWaiting, 'hidden', ready);
            setSafeAttribute(checkArea, 'hidden', !ready);
        },
        relabel()
        {
            labels.relabel();
            // Defensive: the page language's radio is the ticked one (it already
            // is when the reader picked it: the radios are never rebuilt).
            if (picker !== null)
            {
                for (const [locale, radio] of picker.radios)
                {
                    radio.checked = locale === getLocale();
                }
            }
        },
    };
}
