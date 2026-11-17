// Unit tests for switching the page language with files loaded (page.ts,
// setLanguage, and each part's relabel), in Node with the recording fake DOM
// (Helper/Test/test-support/fake-dom.ts), the real steps and engine, a controllable
// fake processFiles and a fake PDF maker. Synthetic messages only.
//
// The shipped page has English, French and Dutch. Here a synthetic test
// language, 'xx' (every English string with accented look-alike letters,
// in brackets; see Helper/Test/test-support/test-locale.ts), is also added to the
// catalog for this file only: since every one of its strings differs from
// English, it shows any word of ours that a switch did not rewrite. What
// changes (every word of ours, <html lang>, the title, one announcement,
// the PDF dropped) and what must not (ticks, time zone, open folds, focus, the
// elements themselves, stand-ins, the plans).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDocument, FakeElement, FakeEventTarget, FakeText } from '../../Helper/Test/test-support/fake-dom';
import { testLanguageName, TEST_LOCALE } from '../../Helper/Test/test-support/test-locale';
import { runEngine, type EngineResult } from '../thread-analysis/engine';
import type { EmailAddress, NormalizedMessage, ParseResult } from '../email-reading/types';
import type { ProcessOptions, ProcessResult } from '../worker-pipeline/process-files';
import type { MakePdfRequest, PdfFontBytes } from '../worker-pipeline/pdf-protocol';
import type { PdfOutcome } from '../worker-pipeline/pdf-runner';
import type { FileLike } from '../worker-pipeline/read-files';
import type { ListenerTarget } from './add-files';
import { en } from './translations/en';
import { getLocale, isPluralForms, setLocale, SUPPORTED_LOCALES, t } from './translations';
import { mountPage, type Page } from './page';

vi.mock('./translations/catalog', async (importOriginal) =>
{
    const { withTestLocales } = await import('../../Helper/Test/test-support/test-locale');
    return withTestLocales(await importOriginal());
});

// ------------------------------------------------------------------ synthetic data

const ALICE: EmailAddress = { name: 'Alice Example', address: 'alice@example.test' };
const BOB: EmailAddress = { name: 'Bob Sample', address: 'bob@example.test' };
const CAROL: EmailAddress = { name: 'Carol Test', address: 'carol@other.test' };
const ORIGIN = 'http://127.0.0.1:4173';
const NOW = Date.UTC(2025, 5, 1, 12, 0, 0);
const FONTS = { 'sans-regular': new Uint8Array(1) } as unknown as PdfFontBytes;
const SIGNATURE = '\n-- \nAlice Example\nGarden Benches (fictional company)\n';

let counter = 0;
function make(fields: Partial<NormalizedMessage> = {}): NormalizedMessage
{
    counter++;
    return {
        messageId: `l${String(counter)}@example.test`,
        inReplyTo: null,
        references: [],
        date: { utcMs: Date.UTC(2025, 2, 3, 8, 15) + counter * 60_000, original: 'synthetic', offsetMinutes: 0, zoneKnown: true },
        from: [ALICE],
        to: [BOB],
        cc: [],
        bcc: [],
        subject: `Garden bench ${String(counter)}`,
        bodyText: `Hello Bob,\n\nThe bench is painted green, note ${String(counter)}.\n\n> Earlier: is the bench ready?\n${SIGNATURE}`,
        attachments: [],
        source: { fileName: `bench-${String(counter)}.eml`, sha256: counter.toString(16).padStart(64, '0'), kind: 'eml' },
        warnings: [],
        ...fields,
    };
}

function fakeFile(name: string): FileLike
{
    return { name, size: 10, arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The emails of these tests: an email with a cc, an attachment, a quote and
 * a signature; an identical copy of it in another file ("Also in"); a reply
 * without a subject and with the sender's own clock at +01:00; an email
 * without a date (a note); an email whose item cannot be built (a stand-in);
 * a file that is not an email and one without a name.
 */
function emails(): { messages: NormalizedMessage[]; result: EngineResult; standInSubject: string }
{
    const first = make({ cc: [CAROL], attachments: [{ fileName: 'plan.pdf', size: 2048, mimeType: 'application/pdf' }] });
    const copy: NormalizedMessage = { ...first, source: { fileName: 'bench-copy.eml', sha256: 'f'.repeat(64), kind: 'eml' } };
    const reply = make({
        subject: '',
        from: [BOB],
        to: [ALICE],
        date: { utcMs: Date.UTC(2025, 2, 3, 9, 0), original: 'synthetic', offsetMinutes: 60, zoneKnown: true },
        bodyText: `Thanks Alice.\n${SIGNATURE}`,
    });
    const undated = make({ date: { utcMs: null, original: '', offsetMinutes: null, zoneKnown: false }, warnings: ['missing-date'] });
    const broken = make({ subject: 'Broken item', bodyText: 'Text of the broken item.\n' });
    const messages = [first, reply, undated, broken];
    const result = runEngine([
        ...[...messages, copy].map((message): ParseResult => ({ ok: true, message })),
        { ok: false, fileName: 'notes.txt', sha256: null, error: 'unsupported-type', detail: 'not an email file' },
        { ok: false, fileName: '', sha256: null, error: 'corrupt', detail: 'damaged file structure: synthetic' },
    ]);
    // The item of this email cannot be built (only a bug does that): the preview shows a stand-in.
    const target = result.messages.find((m) => m.message.subject === 'Broken item');
    if (target === undefined)
    {
        throw new Error('no broken item');
    }
    (target as { message: NormalizedMessage }).message = { ...target.message, attachments: null as unknown as [] };
    return { messages, result, standInSubject: 'Broken item' };
}

// ------------------------------------------------------------------ fake page

let doc: FakeDocument;
let root: FakeElement;
let page: Page;
let calls: { files: readonly FileLike[]; options: ProcessOptions; resolve: (r: ProcessResult) => void }[];
let tasks: { task: () => void; handle: number }[];
let runs: { request: MakePdfRequest; signal: AbortSignal; resolve: (o: PdfOutcome) => void }[];
let revoked: string[];

function mount(): void
{
    root = new FakeElement('div');
    calls = [];
    tasks = [];
    runs = [];
    revoked = [];
    let next = 0;
    let urls = 0;
    const schedule = (task: () => void): number =>
    {
        const handle = ++next;
        tasks.push({ task, handle });
        return handle;
    };
    const cancel = (handle: unknown): void =>
    {
        tasks = tasks.filter((x) => x.handle !== handle);
    };
    page = mountPage(root as unknown as HTMLElement, {
        addFiles: {
            process: (files, options) => new Promise((resolve) => calls.push({ files, options, resolve })),
            listenerTarget: new FakeEventTarget() as unknown as ListenerTarget,
        },
        preview: { zones: ['America/New_York', 'Asia/Tokyo', 'UTC'], initialZone: 'America/New_York', schedule, cancel },
        pdfLabels: { schedule, cancel },
        download: {
            run: (request, signal) => new Promise((resolve) => runs.push({ request, signal, resolve })),
            createUrl: () => `blob:${ORIGIN}/0000-${String(++urls)}`,
            revokeUrl: (url) => revoked.push(url),
            origin: ORIGIN,
            now: () => NOW,
            fonts: FONTS,
        },
    });
}

beforeEach(() =>
{
    setLocale('en');
    doc = new FakeDocument();
    vi.stubGlobal('document', doc);
    mount();
});

afterEach(() =>
{
    page.addFiles.destroy();
    page.preview.reset();
    page.pdfLabels.reset();
    vi.unstubAllGlobals();
    setLocale('en');
});

function byId(id: string): FakeElement
{
    const found = root.descendants().find((e) => e.getAttribute('id') === id);
    if (!found)
    {
        throw new Error(`no element with id ${id}`);
    }
    return found;
}
const hasClass = (e: FakeElement, name: string): boolean => (e.getAttribute('class') ?? '').split(' ').includes(name);
const byClass = (name: string, within: FakeElement = root): FakeElement[] => within.descendants().filter((e) => hasClass(e, name));
const items = (): FakeElement[] => byId('preview-list').children.filter((c): c is FakeElement => c instanceof FakeElement);
const status = (): string => byId('status').textContent;
const runAll = (): void =>
{
    while (tasks.length > 0)
    {
        tasks.shift()?.task();
    }
};

/** Adds the emails of emails() and waits until everything is shown and the PDF labels are ready. */
async function addAndShow(): Promise<ReturnType<typeof emails>>
{
    const data = emails();
    const input = byId('file-input');
    input.files = [...data.messages.map((m) => m.source.fileName), 'bench-copy.eml', 'notes.txt', ''].map(fakeFile);
    input.fire('change');
    calls.at(-1)?.resolve({ ok: true, engine: data.result });
    await settle();
    runAll();
    expect(page.preview.pdfLabelState()).toBe('ready');
    return data;
}

/** Picks a language in the picker, as the reader does (a click or an arrow key ticks its radio). */
function pick(locale: string): void
{
    const radio = byId(`lang-${locale}`);
    radio.checked = true;
    radio.fire('change');
}

/** Makes the PDF (fake maker) and waits until it is ready. */
async function makeReadyPdf(): Promise<void>
{
    byId('download-button').click();
    expect(runs).toHaveLength(1);
    runs[0]?.resolve({ ok: true, bytes: new Uint8Array([1]), fileName: 'correspondence-2025-06-01.pdf', pageCount: 3 });
    await settle();
    expect(page.download.state().kind).toBe('ready');
}

// ------------------------------------------------------------------ "no English left" check

/** Every English text of en.ts cut at its placeholders: the literal parts with at least two letters. */
function englishFragments(): string[]
{
    const out = new Set<string>();
    const walk = (value: unknown, path: string): void =>
    {
        if (typeof value === 'string' || isPluralForms(value))
        {
            // The app's name is never translated (a user decision).
            if (path === 'app.name')
            {
                return;
            }
            const texts = typeof value === 'string' ? [value] : [value.one, value.other];
            for (const text of texts)
            {
                for (const part of text.split(/\{\w+\}/))
                {
                    const trimmed = part.trim();
                    if (/[A-Za-z].*[A-Za-z]|[A-Za-z]{2}/.test(trimmed))
                    {
                        out.add(trimmed);
                    }
                }
            }
            return;
        }
        for (const [key, inner] of Object.entries(value as Record<string, unknown>))
        {
            walk(inner, path === '' ? key : `${path}.${key}`);
        }
    };
    walk(en, '');
    return [...out];
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The English words of ours still on the page: every text piece and
 * aria-label / aria-description, without what is allowed to stay as it is
 * (the emails' own content, file names, the parser's technical details,
 * time zone names, dates and MIME types, the app's name, the languages' own
 * names). Empty when every word of ours was rewritten.
 */
function englishLeft(data: ReturnType<typeof emails>, sameInBoth: readonly string[] = []): string[]
{
    const allowed = [
        ...sameInBoth,
        t('app.name'),
        'English',
        testLanguageName(TEST_LOCALE),
        'America/New York',
        'Asia/Tokyo',
        'UTC',
        'application/pdf',
        'plan.pdf',
        'notes.txt',
        'bench-copy.eml',
        ...[ALICE, BOB, CAROL].flatMap((m) => [m.name, m.address]),
        ...data.messages.flatMap((m) => [m.subject, m.source.fileName]),
    ].filter((x) => x !== '');
    // Elements whose whole text is email content or technical detail (never translated).
    const skipped = new Set(
        root
            .descendants()
            .filter(
                (e) =>
                    hasClass(e, 'body-text') ||
                    hasClass(e, 'failed-detail') ||
                    e.tagName === 'time' ||
                    (hasClass(e, 'message-subject') && !hasClass(e, 'placeholder')),
            )
            .flatMap((e) => [e, ...e.descendants()]),
    );
    const pieces: string[] = [];
    for (const e of [root, ...root.descendants()])
    {
        if (skipped.has(e))
        {
            continue;
        }
        for (const name of ['aria-label', 'aria-description'])
        {
            const value = e.getAttribute(name);
            if (value !== null)
            {
                pieces.push(value);
            }
        }
        const childElements = e.children.filter((c) => c instanceof FakeElement);
        if (childElements.length === 0)
        {
            pieces.push(e.textContent);
        }
        else
        {
            for (const c of e.children)
            {
                if (c instanceof FakeText)
                {
                    pieces.push(c.data);
                }
            }
        }
    }
    const cleaned = pieces.map((piece) =>
    {
        let text = piece.replace(/\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?( UTC[+-]\d{2}:\d{2})?/g, ' ');
        for (const a of allowed)
        {
            text = text.replaceAll(a, ' ');
        }
        return text;
    });
    const found: string[] = [];
    for (const fragment of englishFragments())
    {
        const pattern = new RegExp(`(?<![A-Za-z])${escape(fragment)}(?![A-Za-z])`);
        for (const piece of cleaned)
        {
            if (pattern.test(piece))
            {
                found.push(`"${fragment}" in "${piece}"`);
            }
        }
    }
    return found;
}

// ------------------------------------------------------------------ tests

describe('the language picker (English, French, Dutch, and the test-only language added to the catalog)', () =>
{
    it('is a fieldset first in the header, with a legend and one radio per language', () =>
    {
        expect(SUPPORTED_LOCALES).toEqual(['en', 'fr', 'nl', TEST_LOCALE]);
        const header = root.children[0] as FakeElement;
        expect(header.tagName).toBe('header');
        const fieldset = header.children[0] as FakeElement;
        expect(fieldset.tagName).toBe('fieldset');
        expect(fieldset.getAttribute('class')).toBe('language');
        // Before the privacy panel's summary: the first Tab stops of the page are the radios.
        const order = header.descendants().map((e) => e.getAttribute('id'));
        expect(order.indexOf('lang-en')).toBeLessThan(order.indexOf('privacy-summary'));
        const legend = fieldset.children[0] as FakeElement;
        expect(legend.tagName).toBe('legend');
        expect(legend.textContent).toBe('Language');
        const radios = fieldset.descendants().filter((e) => e.tagName === 'input');
        expect(radios.map((r) => [r.getAttribute('type'), r.getAttribute('name'), r.getAttribute('id'), r.getAttribute('lang'), r.getAttribute('value')])).toEqual([
            ['radio', 'language', 'lang-en', 'en', 'en'],
            ['radio', 'language', 'lang-fr', 'fr', 'fr'],
            ['radio', 'language', 'lang-nl', 'nl', 'nl'],
            ['radio', 'language', `lang-${TEST_LOCALE}`, TEST_LOCALE, TEST_LOCALE],
        ]);
        expect(radios.map((r) => r.checked)).toEqual([true, false, false, false]);
        const labels = fieldset.descendants().filter((e) => e.tagName === 'label');
        expect(labels.map((l) => [l.getAttribute('for'), l.getAttribute('lang'), l.textContent])).toEqual([
            ['lang-en', 'en', 'English'],
            ['lang-fr', 'fr', 'Français'],
            ['lang-nl', 'nl', 'Nederlands'],
            [`lang-${TEST_LOCALE}`, TEST_LOCALE, testLanguageName(TEST_LOCALE)],
        ]);
        // Radios, never a <select> (WebKit reports each <select> as a CSP style violation).
        expect(fieldset.descendants().filter((e) => e.tagName === 'select')).toEqual([]);
    });

    it('switches the language; the radios stay the same elements, the picked one ticked; endonyms never change', () =>
    {
        const fieldset = byId('language');
        const radios = fieldset.descendants().filter((e) => e.tagName === 'input');
        pick(TEST_LOCALE);
        expect(getLocale()).toBe(TEST_LOCALE);
        expect(byId('language')).toBe(fieldset);
        expect(fieldset.descendants().filter((e) => e.tagName === 'input')).toEqual(radios);
        expect(radios.map((r) => r.checked)).toEqual([false, false, false, true]);
        expect((fieldset.children[0] as FakeElement).textContent).toBe(t('language.label'));
        expect((fieldset.children[0] as FakeElement).textContent).not.toBe('Language');
        expect(fieldset.descendants().filter((e) => e.tagName === 'label').map((l) => l.textContent)).toEqual([
            'English',
            'Français',
            'Nederlands',
            testLanguageName(TEST_LOCALE),
        ]);
        pick('en');
        expect(getLocale()).toBe('en');
        expect(radios.map((r) => r.checked)).toEqual([true, false, false, false]);
        expect((fieldset.children[0] as FakeElement).textContent).toBe('Language');
    });
});

describe('setLanguage with files loaded', () =>
{
    it('rewrites every word of ours and keeps ticks, zone, open folds, focus, elements, stand-ins and plans', async () =>
    {
        const data = await addAndShow();
        const list = items();
        expect(list).toHaveLength(4);

        // The reader's choices: one email unticked, another zone, a fold opened by hand.
        const boxes = byClass('include-checkbox');
        boxes[0]!.checked = false;
        boxes[0]!.fire('change');
        runAll();
        const zone = byId('preview-zone');
        zone.value = 'Asia/Tokyo';
        zone.fire('change');
        const folds = byClass('fold');
        expect(folds.length).toBeGreaterThan(1);
        folds[0]!.setAttribute('open', '');
        const openBefore = folds.map((f) => f.hasAttribute('open'));
        const included = [...page.review.includedPositions()];
        const plans = page.pdfLabels.currentPlans();
        expect(plans).not.toBeNull();
        const standIn = list.find((i) => hasClass(i, 'message-failed'));
        expect(standIn).toBeDefined();
        // Every control and disclosure of the page: none may be replaced.
        const controlsBefore = root.descendants().filter((e) => ['details', 'summary', 'input', 'select', 'button', 'option'].includes(e.tagName));
        const radio = byId(`lang-${TEST_LOCALE}`);
        doc.activeElement = radio;
        doc.fire('focusin', { target: radio });
        doc.title = 'stale';
        expect(englishLeft(data)).not.toEqual([]); // the check finds English before the switch

        pick(TEST_LOCALE);

        // Nothing English of ours is left.
        expect(englishLeft(data)).toEqual([]);
        expect(doc.documentElement.getAttribute('lang')).toBe(TEST_LOCALE);
        expect(doc.title).toBe(t('app.name'));
        expect(doc.title).toBe('Email to PDF');

        // The same list items, folds and checkboxes: nothing rebuilt.
        expect(items()).toEqual(list);
        expect(byClass('fold')).toEqual(folds);
        expect(byClass('include-checkbox')).toEqual(boxes);
        expect(byClass('fold').map((f) => f.hasAttribute('open'))).toEqual(openBefore);
        expect(folds[0]!.hasAttribute('open')).toBe(true);
        expect(root.descendants().filter((e) => ['details', 'summary', 'input', 'select', 'button', 'option'].includes(e.tagName))).toEqual(controlsBefore);
        // Ticks, zone, "show quoted text", "Print full original text" and the plans are untouched.
        expect(page.review.includedPositions()).toEqual(included);
        expect(boxes.map((b) => b.checked)).toEqual([false, true, true, true]);
        expect(page.preview.zone()).toBe('Asia/Tokyo');
        expect(zone.value).toBe('Asia/Tokyo');
        expect(byId('preview-show-folded').checked).toBe(false);
        expect(byId('pdf-everything').checked).toBe(false);
        expect(page.pdfLabels.currentPlans()).toBe(plans);
        expect(page.preview.pdfLabelState()).toBe('ready');
        expect(tasks).toEqual([]);
        // The stand-in is still there, its notes in the new language.
        expect(items()).toContain(standIn);
        expect(byClass('message-failed-note', standIn)[0]?.textContent).toBe(t('preview.itemFailed'));
        expect(standIn!.textContent).toContain('Text of the broken item.');
        // Focus and scrolling: nothing was focused or scrolled by the switch.
        expect(doc.activeElement).toBe(radio);
        expect(root.contains(radio)).toBe(true);
        for (const e of root.descendants())
        {
            if (e !== radio)
            {
                expect(e.focuses, e.tagName).toBe(0);
            }
            expect(e.scrollIntoViewCalls, e.tagName).toEqual([]);
        }
        // The emails' own text is unchanged; the technical details stay English, marked so.
        expect(root.textContent).toContain('The bench is painted green');
        const detail = byClass('failed-detail')[0]!;
        expect(detail.getAttribute('lang')).toBe('en');
        expect(detail.textContent).toBe('not an email file');

        // Some exact texts in the new language.
        expect(byId('review-included').textContent).toBe(t('counts.included', { included: 3, count: 4 }));
        expect(byId('review-included').textContent).not.toContain('emails will be in the PDF');
        expect(byId('add-summary-text').textContent).toContain(t('added.files', { count: 7 }));
        expect(byClass('placeholder').some((e) => e.textContent === t('preview.noSubject'))).toBe(true);
        expect(byId('download-note').textContent).toBe(t('download.available'));

        // And back to English: the same texts as before the switch.
        pick('en');
        expect(englishLeft(data)).not.toEqual([]);
        expect(byId('review-included').textContent).toBe('3 of 4 emails will be in the PDF.');
        expect(byId('step-add-title').textContent).toBe('Step 1 Add your emails');
        expect(doc.documentElement.getAttribute('lang')).toBe('en');
        expect(items()).toEqual(list);
    });

    it('drops a ready PDF with ONE announcement in the new language, and never makes it again by itself', async () =>
    {
        await addAndShow();
        await makeReadyPdf();
        const setStatus = vi.spyOn(page.shell, 'setStatus');

        pick(TEST_LOCALE);

        expect(setStatus).toHaveBeenCalledTimes(1);
        const announced = t('download.changedAfter', { news: t('language.changed'), changed: t('download.changed') });
        expect(setStatus).toHaveBeenCalledWith(announced);
        expect(status()).toBe(announced);
        expect(page.download.state()).toEqual({ kind: 'idle', changed: true });
        expect(revoked).toEqual([`blob:${ORIGIN}/0000-1`]);
        expect(byId('download-link').hasAttribute('hidden')).toBe(true);
        expect(byId('download-note').textContent).toBe(t('download.changed'));
        // Not made again: the reader presses the button when ready.
        await settle();
        runAll();
        expect(runs).toHaveLength(1);
        expect(page.download.state().kind).toBe('idle');
    });

    it('stops a PDF being made; the next one is made in the new language', async () =>
    {
        await addAndShow();
        byId('download-button').click();
        expect(runs[0]?.request.input.locale).toBe('en');
        pick(TEST_LOCALE);
        expect(runs[0]?.signal.aborted).toBe(true);
        expect(page.download.state()).toEqual({ kind: 'idle', changed: true });
        expect(status()).toBe(t('download.changedAfter', { news: t('language.changed'), changed: t('download.changed') }));
        byId('download-button').click();
        expect(runs).toHaveLength(2);
        expect(runs[1]?.request.input.locale).toBe(TEST_LOCALE);
    });

    it('without a PDF: one announcement, the news alone', async () =>
    {
        await addAndShow();
        const setStatus = vi.spyOn(page.shell, 'setStatus');
        pick(TEST_LOCALE);
        expect(setStatus).toHaveBeenCalledTimes(1);
        expect(status()).toBe(t('language.changed'));
        expect(page.download.state()).toEqual({ kind: 'idle', changed: false });
    });

    it('does nothing for the language already shown or one the page does not ship', async () =>
    {
        await addAndShow();
        const setStatus = vi.spyOn(page.shell, 'setStatus');
        page.setLanguage('en');
        page.setLanguage('de');
        page.setLanguage('nl-BE');
        page.setLanguage('fr-BE');
        page.setLanguage('EN');
        expect(setStatus).not.toHaveBeenCalled();
        expect(getLocale()).toBe('en');
    });

    it('"Clear everything" keeps the chosen language', async () =>
    {
        await addAndShow();
        pick(TEST_LOCALE);
        byId('clear-everything').click();
        expect(getLocale()).toBe(TEST_LOCALE);
        expect(status()).toBe(t('clear.done'));
        expect(status()).not.toBe('Everything was cleared.');
        expect(byId(`lang-${TEST_LOCALE}`).checked).toBe(true);
        expect(byId('download-note').textContent).toBe(t('download.unavailable.no-emails'));
    });
});

/**
 * Words written the same in English and French (see SAME_AS_ENGLISH in
 * Source/page/translations/fr.test.ts): two mail program names, and three words that
 * are French too.
 */
const SAME_IN_FRENCH = ['Thunderbird', 'Apple Mail', 'Cc', 'Date', 'signature'];

describe('French (shipped)', () =>
{
    it('rewrites the page in French with files loaded, keeping every choice, then back to English', async () =>
    {
        const data = await addAndShow();
        const list = items();
        const boxes = byClass('include-checkbox');
        boxes[1]!.checked = false;
        boxes[1]!.fire('change');
        runAll();
        const radio = byId('lang-fr');
        doc.activeElement = radio;
        const setStatus = vi.spyOn(page.shell, 'setStatus');

        pick('fr');

        expect(getLocale()).toBe('fr');
        expect(byId('lang-fr').checked).toBe(true);
        expect(byId('lang-en').checked).toBe(false);
        // Only the words that are the same in both languages are left.
        expect(englishLeft(data, SAME_IN_FRENCH)).toEqual([]);
        expect(englishLeft(data)).not.toEqual([]); // ...and the check does see them
        expect(doc.documentElement.getAttribute('lang')).toBe('fr');
        expect(doc.title).toBe('Email to PDF');
        // One announcement, in French.
        expect(setStatus).toHaveBeenCalledTimes(1);
        expect(status()).toBe('La page est maintenant en français.');
        // A few exact French texts, numbers written the French way by t().
        expect(byId('step-add-title').textContent).toBe('Étape 1 Ajoutez vos e-mails');
        expect(byId('review-included').textContent).toBe('E-mails dans le PDF\u00A0: 3 sur 4.');
        expect(byId('add-summary-text').textContent).toContain('7 fichiers ajoutés.');
        expect(byId('download-note').textContent).toBe(t('download.available'));
        expect((byId('language').children[0] as FakeElement).textContent).toBe('Langue');
        // Nothing rebuilt, the tick kept, the focus left on the radio.
        expect(items()).toEqual(list);
        expect(boxes.map((b) => b.checked)).toEqual([true, false, true, true]);
        expect(doc.activeElement).toBe(radio);

        pick('en');
        expect(getLocale()).toBe('en');
        expect(byId('step-add-title').textContent).toBe('Step 1 Add your emails');
        expect(byId('review-included').textContent).toBe('3 of 4 emails will be in the PDF.');
        expect(doc.documentElement.getAttribute('lang')).toBe('en');
        expect(status()).toBe('The page is now in English.');
        expect(items()).toEqual(list);
    });

    it('the next PDF is asked for in French', async () =>
    {
        await addAndShow();
        pick('fr');
        byId('download-button').click();
        expect(runs).toHaveLength(1);
        expect(runs[0]?.request.input.locale).toBe('fr');
    });

    it('"Clear everything" keeps French', async () =>
    {
        await addAndShow();
        pick('fr');
        byId('clear-everything').click();
        expect(getLocale()).toBe('fr');
        expect(status()).toBe('Tout a été effacé.');
        expect(byId('lang-fr').checked).toBe(true);
    });
});

/**
 * Words written the same in English and Dutch (see SAME_AS_ENGLISH in
 * Source/page/translations/nl.test.ts): two mail program names, words and units that
 * are Dutch too, and "of" (the Dutch "or", an English word as well).
 */
const SAME_IN_DUTCH = ['Thunderbird', 'Apple Mail', 'Cc', 'Bcc', 'KB', 'of'];

describe('Dutch (shipped)', () =>
{
    it('rewrites the page in Dutch with files loaded, keeping every choice, then back to English', async () =>
    {
        const data = await addAndShow();
        const list = items();
        const boxes = byClass('include-checkbox');
        boxes[1]!.checked = false;
        boxes[1]!.fire('change');
        runAll();
        const radio = byId('lang-nl');
        doc.activeElement = radio;
        const setStatus = vi.spyOn(page.shell, 'setStatus');

        pick('nl');

        expect(getLocale()).toBe('nl');
        expect(byId('lang-nl').checked).toBe(true);
        expect(byId('lang-en').checked).toBe(false);
        expect(byId('lang-fr').checked).toBe(false);
        // Only the words that are the same in both languages are left.
        expect(englishLeft(data, SAME_IN_DUTCH)).toEqual([]);
        expect(englishLeft(data)).not.toEqual([]); // ...and the check does see them
        expect(doc.documentElement.getAttribute('lang')).toBe('nl');
        expect(doc.title).toBe('Email to PDF');
        // One announcement, in Dutch.
        expect(setStatus).toHaveBeenCalledTimes(1);
        expect(status()).toBe('De pagina is nu in het Nederlands.');
        // A few exact Dutch texts.
        expect(byId('step-add-title').textContent).toBe('Stap 1 Voeg uw e-mails toe');
        expect(byId('review-included').textContent).toBe('In de PDF: 3 van 4 e-mails.');
        expect(byId('add-summary-text').textContent).toContain('7 bestanden toegevoegd.');
        expect(byId('download-note').textContent).toBe(t('download.available'));
        expect((byId('language').children[0] as FakeElement).textContent).toBe('Taal');
        // Nothing rebuilt, the tick kept, the focus left on the radio.
        expect(items()).toEqual(list);
        expect(boxes.map((b) => b.checked)).toEqual([true, false, true, true]);
        expect(doc.activeElement).toBe(radio);

        // Straight to French, then back to English: each switch rewrites everything.
        pick('fr');
        expect(byId('step-add-title').textContent).toBe('Étape 1 Ajoutez vos e-mails');
        pick('en');
        expect(getLocale()).toBe('en');
        expect(byId('step-add-title').textContent).toBe('Step 1 Add your emails');
        expect(byId('review-included').textContent).toBe('3 of 4 emails will be in the PDF.');
        expect(doc.documentElement.getAttribute('lang')).toBe('en');
        expect(items()).toEqual(list);
    });

    it('the next PDF is asked for in Dutch', async () =>
    {
        await addAndShow();
        pick('nl');
        byId('download-button').click();
        expect(runs).toHaveLength(1);
        expect(runs[0]?.request.input.locale).toBe('nl');
    });

    it('"Clear everything" keeps Dutch', async () =>
    {
        await addAndShow();
        pick('nl');
        byId('clear-everything').click();
        expect(getLocale()).toBe('nl');
        expect(status()).toBe('Alles is gewist.');
        expect(byId('lang-nl').checked).toBe(true);
    });
});

describe('setLanguage while the PDF-label status line shows text', () =>
{
    it("rewrites 'updating' (plans not made yet)", async () =>
    {
        const data = emails();
        const input = byId('file-input');
        input.files = [...data.messages.map((m) => m.source.fileName), 'bench-copy.eml', 'notes.txt', ''].map(fakeFile);
        input.fire('change');
        calls.at(-1)?.resolve({ ok: true, engine: data.result });
        await settle();
        // No runAll(): the plans are still being made.
        expect(page.preview.pdfLabelState()).toBe('updating');
        expect(byId('pdf-labels-status').textContent).toBe(en.pdf.updating);

        pick(TEST_LOCALE);

        expect(page.preview.pdfLabelState()).toBe('updating');
        expect(byId('pdf-labels-status').textContent).toBe(t('pdf.updating'));
        expect(byId('pdf-labels-status').textContent).not.toBe(en.pdf.updating);
        expect(englishLeft(data)).toEqual([]);
    });

    it("rewrites 'failed' (after pdfPlansFailed)", async () =>
    {
        const data = await addAndShow();
        page.preview.pdfPlansFailed();
        expect(page.preview.pdfLabelState()).toBe('failed');
        expect(byId('pdf-labels-status').textContent).toBe(en.pdf.failed);

        pick(TEST_LOCALE);

        expect(page.preview.pdfLabelState()).toBe('failed');
        expect(byId('pdf-labels-status').textContent).toBe(t('pdf.failed'));
        expect(byId('pdf-labels-status').textContent).not.toBe(en.pdf.failed);
        expect(englishLeft(data)).toEqual([]);
    });
});

describe('setLanguage while files are being read', () =>
{
    it('rewrites the progress line and the "waiting" notice from their numbers', () =>
    {
        const input = byId('file-input');
        input.files = [fakeFile('a.eml'), fakeFile('b.eml')];
        input.fire('change');
        calls[0]?.options.onProgress?.({ stage: 'reading', filesDone: 0, filesTotal: 2 });
        input.files = [fakeFile('c.eml')];
        input.fire('change'); // waits for the next round
        expect(byId('add-progress-label').textContent).toBe('Reading file 1 of 2...');
        expect(byId('add-notice').textContent).toBe(en.drop.queued);

        pick(TEST_LOCALE);

        expect(byId('add-progress-label').textContent).toBe(t('drop.reading', { done: 1, total: 2 }));
        expect(byId('add-notice').textContent).toBe(t('drop.queued'));
        expect(byId('add-progress-label').textContent).not.toContain('Reading');
        expect(byId('download-note').textContent).toBe(t('download.unavailable.busy'));
    });
});

describe('the "no English left" check itself', () =>
{
    it('finds a word of ours that was not rewritten', async () =>
    {
        const data = await addAndShow();
        pick(TEST_LOCALE);
        expect(englishLeft(data)).toEqual([]);
        byId('check-waiting').textContent = en.steps.check.waiting;
        const left = englishLeft(data);
        expect(left).toContainEqual(expect.stringContaining('"Your emails will appear here once you have added them."'));
        expect(left.every((x) => x.endsWith('in "Your emails will appear here once you have added them."'))).toBe(true);
    });
});
