// Unit tests for the page shell, in Node with the recording fake DOM
// (Helper/Test/test-support/fake-dom.ts). The real page is checked in Chromium by
// Helper/Test/browser-tests/app-shell.spec.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDocument, FakeElement, FakeText } from '../../Helper/Test/test-support/fake-dom';
import { HELP_CLIENTS, mountPageShell, type PageShell } from './page-shell';
import { DONATION_IMAGE, DONATION_URL } from './safe-dom';
import { setLocale, t } from './translations';
import { en } from './translations/en';
import { fr } from './translations/fr';

let fakeDocument: FakeDocument;
let root: FakeElement;
let shell: PageShell;

beforeEach(() =>
{
    fakeDocument = new FakeDocument();
    vi.stubGlobal('document', fakeDocument);
    root = new FakeElement('div');
    root.append(new FakeText('old content'));
    shell = mountPageShell(root as unknown as HTMLElement);
});

afterEach(() =>
{
    vi.unstubAllGlobals();
});

function all(tag: string): FakeElement[]
{
    return root.descendants().filter((e) => e.tagName === tag);
}

function byId(id: string): FakeElement
{
    const found = root.descendants().find((e) => e.getAttribute('id') === id);
    if (!found)
    {
        throw new Error(`no element with id ${id}`);
    }
    return found;
}

describe('mountPageShell', () =>
{
    it('replaces the root content with header, main and footer landmarks', () =>
    {
        expect(root.children.map((c) => (c instanceof FakeElement ? c.tagName : 'text'))).toEqual(['header', 'main', 'footer']);
    });

    it('sets the page language and title from the strings module', () =>
    {
        expect(fakeDocument.documentElement.getAttribute('lang')).toBe('en');
        expect(fakeDocument.title).toBe(t('app.name'));
    });

    it('shows the language picker first in the header: English, French and Dutch, each named in its own language', () =>
    {
        const header = root.children[0] as FakeElement;
        const fieldset = header.children[0] as FakeElement;
        expect(fieldset.tagName).toBe('fieldset');
        expect(fieldset.getAttribute('id')).toBe('language');
        expect(all('fieldset')).toEqual([fieldset]);
        const legend = fieldset.children[0] as FakeElement;
        expect(legend.tagName).toBe('legend');
        expect(legend.textContent).toBe('Language');
        const radios = fieldset.descendants().filter((e) => e.tagName === 'input');
        expect(radios.map((r) => [r.getAttribute('type'), r.getAttribute('name'), r.getAttribute('id'), r.getAttribute('value'), r.getAttribute('lang')])).toEqual([
            ['radio', 'language', 'lang-en', 'en', 'en'],
            ['radio', 'language', 'lang-fr', 'fr', 'fr'],
            ['radio', 'language', 'lang-nl', 'nl', 'nl'],
        ]);
        // The page language is the ticked one.
        expect(radios.map((r) => r.checked)).toEqual([true, false, false]);
        // Each radio has its own label, in its own language (lang on the label too).
        const labels = fieldset.descendants().filter((e) => e.tagName === 'label');
        expect(labels.map((l) => [l.getAttribute('for'), l.getAttribute('lang'), l.textContent])).toEqual([
            ['lang-en', 'en', 'English'],
            ['lang-fr', 'fr', 'Français'],
            ['lang-nl', 'nl', 'Nederlands'],
        ]);
        // Radios, never a <select> (WebKit reports each <select> as a CSP style violation).
        expect(all('select')).toEqual([]);
    });

    it('picking French calls onLanguageChange("fr"), Dutch "nl", and back to English "en"', () =>
    {
        const picked: string[] = [];
        const other = new FakeElement('div');
        mountPageShell(other as unknown as HTMLElement, { onLanguageChange: (locale) => picked.push(locale) });
        const radio = (id: string): FakeElement => other.descendants().find((e) => e.getAttribute('id') === id)!;
        radio('lang-fr').checked = true;
        radio('lang-fr').fire('change');
        radio('lang-nl').checked = true;
        radio('lang-nl').fire('change');
        radio('lang-en').checked = true;
        radio('lang-en').fire('change');
        // A change event on a radio that is not ticked (it was just unticked) picks nothing.
        radio('lang-fr').checked = false;
        radio('lang-fr').fire('change');
        expect(picked).toEqual(['fr', 'nl', 'en']);
    });

    it('has no language picker for a one-language list', () =>
    {
        const other = new FakeElement('div');
        mountPageShell(other as unknown as HTMLElement, { locales: ['en'] });
        expect(other.descendants().filter((e) => e.tagName === 'fieldset' || e.getAttribute('type') === 'radio')).toEqual([]);
    });

    it('relabel writes the same words again in the same language (nothing rebuilt)', () =>
    {
        const before = root.textContent;
        const heading = byId('step-add-title');
        shell.relabel();
        expect(root.textContent).toBe(before);
        expect(byId('step-add-title')).toBe(heading);
    });

    it('shows the app name as the only h1, with the promise', () =>
    {
        expect(all('h1').map((h) => h.textContent)).toEqual([t('app.name')]);
        expect(root.textContent).toContain(t('app.promise'));
    });

    it('has three step sections in order, each named by its heading', () =>
    {
        const sections = all('section');
        expect(sections.map((s) => s.getAttribute('id'))).toEqual(['step-add', 'step-check', 'step-download']);
        const main = all('main')[0];
        expect(main?.descendants().filter((e) => e.tagName === 'h2').map((h) => h.textContent)).toEqual([
            `${t('steps.number', { number: 1 })} ${t('steps.add.title')}`,
            `${t('steps.number', { number: 2 })} ${t('steps.check.title')}`,
            `${t('steps.number', { number: 3 })} ${t('steps.download.title')}`,
        ]);
        for (const section of sections)
        {
            const heading = byId(section.getAttribute('aria-labelledby') ?? '');
            expect(heading.tagName).toBe('h2');
            expect(section.descendants()).toContain(heading);
        }
    });

    it('has one polite live region, present from the start and empty', () =>
    {
        const live = root.descendants().filter((e) => e.hasAttribute('aria-live'));
        expect(live).toHaveLength(1);
        expect(live[0]?.getAttribute('aria-live')).toBe('polite');
        expect(live[0]?.getAttribute('role')).toBe('status');
        expect(live[0]?.textContent).toBe('');
        shell.setStatus('Reading file 1 of 2...');
        expect(live[0]?.textContent).toBe('Reading file 1 of 2...');
        shell.setStatus('');
        expect(live[0]?.textContent).toBe('');
    });

    it('starts step 2 in the waiting state and switches it', () =>
    {
        const step = byId('step-check');
        const waiting = byId('check-waiting');
        expect(step.getAttribute('data-state')).toBe('waiting');
        expect(waiting.hasAttribute('hidden')).toBe(false);
        expect(byId('check-area').hasAttribute('hidden')).toBe(true);
        expect(shell.checkArea).toBe(byId('check-area'));

        shell.setCheckReady(true);
        expect(step.getAttribute('data-state')).toBe('ready');
        expect(waiting.hasAttribute('hidden')).toBe(true);
        expect(byId('check-area').hasAttribute('hidden')).toBe(false);

        shell.setCheckReady(false);
        expect(step.getAttribute('data-state')).toBe('waiting');
        expect(waiting.hasAttribute('hidden')).toBe(false);
        expect(byId('check-area').hasAttribute('hidden')).toBe(true);
    });

    it('has an empty container for step 1', () =>
    {
        expect(shell.addArea).toBe(byId('add-area'));
        expect(byId('add-area').children).toEqual([]);
    });

    it('has a "Make the PDF" button that is unavailable but focusable, described by its note (why)', () =>
    {
        const button = byId('download-button');
        expect(shell.downloadButton).toBe(button);
        expect(button.tagName).toBe('button');
        expect(button.getAttribute('type')).toBe('button');
        expect(button.textContent).toBe(t('actions.makePdf'));
        expect(button.getAttribute('aria-disabled')).toBe('true');
        // Not `disabled`: a disabled button cannot be reached with Tab.
        expect(button.hasAttribute('disabled')).toBe(false);
        const note = byId(button.getAttribute('aria-describedby') ?? '');
        expect(shell.downloadNote).toBe(note);
        expect(note.textContent).toBe(t('download.unavailable.no-emails'));
        // The download link's container comes after the note, empty for now.
        expect(shell.downloadArea).toBe(byId('download-area'));
        expect(byId('download-area').children).toEqual([]);
    });

    it('has a "Clear everything" button at the end of step 1, unavailable but focusable, described by its note', () =>
    {
        const button = byId('clear-everything');
        expect(shell.clearButton).toBe(button);
        expect(button.tagName).toBe('button');
        expect(button.getAttribute('type')).toBe('button');
        expect(button.textContent).toBe(t('actions.clearEverything'));
        expect(button.getAttribute('aria-disabled')).toBe('true');
        expect(button.hasAttribute('disabled')).toBe(false);
        // Described by why it is unavailable first, then its note; both visible.
        expect(button.getAttribute('aria-describedby')).toBe('clear-unavailable clear-note');
        expect(byId('clear-unavailable').textContent).toBe(t('clear.unavailable'));
        expect(byId('clear-unavailable').hasAttribute('hidden')).toBe(false);
        expect(byId('clear-note').textContent).toBe(t('clear.note'));
        const area = byId('clear-area').children;
        expect(area.indexOf(byId('clear-unavailable'))).toBe(area.indexOf(byId('clear-note')) - 1);
        // In step 1, after the add area (so after the "choose" button in the Tab order).
        const step = byId('step-add');
        expect(step.descendants()).toContain(button);
        const order = step.descendants();
        expect(order.indexOf(button)).toBeGreaterThan(order.indexOf(byId('add-area')));
        expect(byId('add-area').contains(button)).toBe(false);
    });

    it('setClearAvailable switches the button between available and aria-disabled', () =>
    {
        const button = byId('clear-everything');
        shell.setClearAvailable(true);
        expect(button.hasAttribute('aria-disabled')).toBe(false);
        // Available: the reason is gone, the note alone describes it.
        expect(button.getAttribute('aria-describedby')).toBe('clear-note');
        expect(byId('clear-unavailable').hasAttribute('hidden')).toBe(true);
        shell.setClearAvailable(false);
        expect(button.getAttribute('aria-disabled')).toBe('true');
        expect(button.hasAttribute('disabled')).toBe(false);
        expect(button.getAttribute('aria-describedby')).toBe('clear-unavailable clear-note');
        expect(byId('clear-unavailable').hasAttribute('hidden')).toBe(false);
    });

    describe('privacy panel', () =>
    {
        const topics = [
            ['privacy.does.title', ['privacy.does.local', 'privacy.does.noUpload', 'privacy.does.noSaving', 'privacy.does.wiped', 'privacy.does.pdf']],
            ['privacy.never.title', ['privacy.never.upload', 'privacy.never.tracking', 'privacy.never.remote', 'privacy.never.attachments']],
            ['privacy.check.title', ['privacy.check.offline', 'privacy.check.network', 'privacy.check.source']],
            ['privacy.notes.title', ['privacy.notes.trust', 'privacy.notes.hostReports', 'privacy.notes.console', 'privacy.notes.scripts', 'disclaimer.text']],
        ] as const;

        it('is a closed <details> in the header, after the promise, opened by its summary', () =>
        {
            const panel = byId('privacy');
            expect(panel.tagName).toBe('details');
            expect(panel.hasAttribute('open')).toBe(false);
            const header = root.children[0] as FakeElement;
            // After the header's top row: the language picker (first) and the Ko-fi button.
            expect(header.children.map((c) => (c instanceof FakeElement ? c.getAttribute('class') : 'text'))).toEqual([
                'language',
                'donate',
                'app-name',
                'promise',
                'privacy',
            ]);
            // The summary comes first, so it is the line shown while closed (and the panel's name).
            const summary = panel.children[0] as FakeElement;
            expect(summary.tagName).toBe('summary');
            expect(summary.textContent).toBe(t('privacy.summary'));
            // The header's only summary (step 1's help has its own, see below).
            expect(header.descendants().filter((e) => e.tagName === 'summary')).toEqual([summary]);
        });

        it('has one h2 per topic, with its points in order, then the disclaimer', () =>
        {
            const panel = byId('privacy');
            const headings = panel.descendants().filter((e) => /^h\d$/.test(e.tagName));
            expect(headings.map((h) => h.tagName)).toEqual(['h2', 'h2', 'h2', 'h2']);
            expect(headings.map((h) => h.textContent)).toEqual(topics.map(([title]) => t(title)));
            for (const [title, points] of topics)
            {
                const heading = headings.find((h) => h.textContent === t(title));
                const topic = panel.descendants().find((e) => e.tagName === 'div' && e.children[0] === heading);
                const texts = topic?.descendants().filter((e) => e.tagName === 'li' || e.tagName === 'p').map((e) => e.textContent);
                expect(texts, title).toEqual(points.map((key) => t(key)));
            }
            // The first three topics are lists, the last one short paragraphs.
            expect(panel.descendants().filter((e) => e.tagName === 'ul')).toHaveLength(3);
        });

        it('says what the page does, never does, how to check it, and its limits', () =>
        {
            const text = byId('privacy').textContent;
            for (const phrase of [
                'only inside this browser tab',
                'Nothing from your files leaves your computer',
                'no cookies, and nothing from your emails in the browser',
                "a copy of this page's own files",
                'Only the PDF you choose to download is saved',
                '"Clear everything"',
                'A PDF you already downloaded stays in your downloads',
                'never opens attached files',
                'turn off your internet',
                'reload it or open it again without internet',
                '(never your emails)',
                'Network tab',
                "The page's own files load when it opens",
                'nothing from this page goes out to the internet',
                'open source',
                'can see that the page was loaded, but never your emails',
                'a file is missing), your browser may later send',
                'which web address failed',
                'the report never contains your files or your emails',
                'Nothing is reported when everything loads normally',
                'Content Security Policy',
                '[U+05D0]',
                'Latin, Greek and Cyrillic text shows normally',
                'not legal advice',
            ])
            {
                expect(text).toContain(phrase);
            }
        });

        it('has no link and no heading level other than h2 (the steps are h2 too)', () =>
        {
            const panel = byId('privacy');
            expect(panel.descendants().filter((e) => e.tagName === 'a')).toEqual([]);
            expect(panel.descendants().some((e) => ['h1', 'h3', 'h4'].includes(e.tagName))).toBe(false);
        });
    });

    describe('step 1 help (how to get your email files)', () =>
    {
        const clientKeys = HELP_CLIENTS.map((client) => [`help.clients.${client}.name`, `help.clients.${client}.how`] as const);

        it('is a closed <details> in step 1, between the intro and the drop zone area, opened by its summary', () =>
        {
            const help = byId('help');
            expect(help.tagName).toBe('details');
            expect(help.hasAttribute('open')).toBe(false);
            const step = byId('step-add');
            const classes = step.children.map((c) => (c instanceof FakeElement ? (c.getAttribute('id') ?? c.getAttribute('class')) : 'text'));
            expect(classes).toEqual(['step-add-title', 'step-intro', 'help', 'add-area', 'clear-area']);
            // The summary comes first: the line shown while closed, and the help's accessible name.
            const summary = help.children[0] as FakeElement;
            expect(summary.tagName).toBe('summary');
            expect(summary.getAttribute('id')).toBe('help-summary');
            expect(summary.textContent).toBe(t('help.summary'));
            expect(help.descendants().filter((e) => e.tagName === 'summary')).toEqual([summary]);
            // Two disclosures on the empty page: the privacy panel, then this help.
            expect(all('summary').map((e) => e.getAttribute('id'))).toEqual(['privacy-summary', 'help-summary']);
        });

        it('lists the five mail programs in order, each an h3 name and its text, between the intro and the note', () =>
        {
            const help = byId('help');
            const body = help.children[1] as FakeElement;
            expect(body.children.map((c) => (c as FakeElement).tagName)).toEqual(['p', 'ul', 'p']);
            expect((body.children[0] as FakeElement).textContent).toBe(t('help.intro'));
            expect((body.children[2] as FakeElement).textContent).toBe(t('help.note'));
            const list = byId('help-list');
            expect(list.tagName).toBe('ul');
            expect(list.children).toHaveLength(5);
            for (const [index, [name, how]] of clientKeys.entries())
            {
                const item = list.children[index] as FakeElement;
                expect(item.tagName).toBe('li');
                expect(item.children.map((c) => (c as FakeElement).tagName)).toEqual(['h3', 'p']);
                expect((item.children[0] as FakeElement).textContent).toBe(t(name));
                expect((item.children[1] as FakeElement).textContent).toBe(t(how));
            }
            expect(list.descendants().filter((e) => e.tagName === 'h3').map((h) => h.textContent)).toEqual([
                'Outlook (classic, on Windows)',
                'New Outlook and Outlook on the web',
                'Thunderbird',
                'Apple Mail',
                'Gmail (in a web browser)',
            ]);
        });

        it('uses only h3 headings (step 1 is an h2), and holds no link and no control', () =>
        {
            const help = byId('help');
            const headings = help.descendants().filter((e) => /^h\d$/.test(e.tagName));
            expect(headings.map((h) => h.tagName)).toEqual(['h3', 'h3', 'h3', 'h3', 'h3']);
            expect(byId('step-add-title').tagName).toBe('h2');
            const controls = help.descendants().filter((e) => ['a', 'button', 'input', 'select', 'textarea'].includes(e.tagName));
            expect(controls).toEqual([]);
            expect(help.descendants().some((e) => e.hasAttribute('tabindex') || e.hasAttribute('href'))).toBe(false);
        });

        it('says what the tool reads, that several files can be added, and that menus can differ', () =>
        {
            const text = byId('help').textContent;
            for (const phrase of ['.eml and .msg files', 'several files at once', 'Menu names can differ', 'versions and languages', 'Save As in the File menu', 'Download message', 'Finder'])
            {
                expect(text).toContain(phrase);
            }
        });

        it('hedges every mail program: each says "usually", "may" or "varies", and none promises it works', () =>
        {
            for (const [, how] of clientKeys)
            {
                expect(t(how), how).toMatch(/\b(usually|may|varies)\b/);
                expect(t(how), how).not.toMatch(/\b(always|guaranteed|will work|works)\b/i);
            }
        });

        it('has no URL, web address or jargon in any help string', () =>
        {
            const texts = [t('help.summary'), t('help.intro'), t('help.note'), ...clientKeys.flatMap(([name, how]) => [t(name), t(how)])];
            for (const text of texts)
            {
                expect(text).not.toMatch(/[a-z][a-z0-9+.-]*:\/\//i);
                expect(text).not.toMatch(/\/\/|www\./i);
                // A bare host name with a common ending (the ".eml" and ".msg" file types are not hosts: they start a word).
                expect(text).not.toMatch(/\w\.(com|net|org|fr|nl|be|io)\b/i);
                expect(text).not.toMatch(/\bRFC\b|MIME/);
            }
        });
    });

    it('ends step 3 with the disclaimer, after the download area', () =>
    {
        const step = byId('step-download');
        const disclaimer = byId('download-disclaimer');
        expect(disclaimer.tagName).toBe('p');
        expect(disclaimer.textContent).toBe(t('disclaimer.text'));
        expect(step.children.at(-1)).toBe(disclaimer);
        const order = step.descendants();
        expect(order.indexOf(disclaimer)).toBeGreaterThan(order.indexOf(byId('download-area')));
        // Not the button's description: that one says what the button does now.
        expect(byId('download-button').getAttribute('aria-describedby')).toBe('download-note');
    });

    it('has no inline styles or handlers, and no link or image but the Ko-fi button', () =>
    {
        const donate = byId('donate-link');
        const image = donate.children[0] as FakeElement;
        for (const element of fakeDocument.created)
        {
            for (const name of element.attributes.keys())
            {
                expect(name).not.toMatch(/^(on|style$)/);
                if (element === donate)
                {
                    expect(name, 'the Ko-fi link').not.toBe('src');
                }
                else if (element === image)
                {
                    expect(name, 'the Ko-fi image').not.toBe('href');
                }
                else
                {
                    expect(name, element.tagName).not.toMatch(/^(href|src)$/);
                }
            }
        }
        expect(all('a')).toEqual([donate]);
        expect(all('img')).toEqual([image]);
    });

    describe('Ko-fi button', () =>
    {
        it('sits in the header right after the language picker: a plain link to the donation page, opening a new tab', () =>
        {
            const header = root.children[0] as FakeElement;
            const donate = byId('donate-link');
            expect(header.children[1]).toBe(donate);
            expect(donate.tagName).toBe('a');
            expect([...donate.attributes]).toEqual([
                ['href', DONATION_URL],
                ['id', 'donate-link'],
                ['class', 'donate'],
                ['target', '_blank'],
                ['rel', 'noopener noreferrer'],
            ]);
        });

        it('holds only the bundled image, with its own pixel size and the label as alt text (also its name)', () =>
        {
            const donate = byId('donate-link');
            expect(donate.children).toHaveLength(1);
            const image = donate.children[0] as FakeElement;
            expect(image.tagName).toBe('img');
            expect(image.getAttribute('src')).toBe(DONATION_IMAGE.src);
            expect(image.getAttribute('width')).toBe('980');
            expect(image.getAttribute('height')).toBe('198');
            expect(image.getAttribute('alt')).toBe(t('donate.label'));
            expect(image.getAttribute('alt')).toBe('Support me on Ko-fi (opens in a new tab)');
            expect(donate.textContent).toBe('');
        });

        it('relabel writes the alt text again in the page language', () =>
        {
            const image = byId('donate-link').children[0] as FakeElement;
            setLocale('fr');
            try
            {
                shell.relabel();
                expect(image.getAttribute('alt')).toBe(fr.donate.label);
            }
            finally
            {
                setLocale('en');
            }
            shell.relabel();
            expect(image.getAttribute('alt')).toBe(en.donate.label);
        });
    });

    it('uses unique ids', () =>
    {
        const ids = root.descendants().flatMap((e) => e.getAttribute('id') ?? []);
        expect(new Set(ids).size).toBe(ids.length);
    });
});
