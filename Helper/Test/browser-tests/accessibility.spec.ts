// Browser test of the accessibility basics (WCAG 2.2 AA) in every state of
// the page, in each test browser against the BUILT site served by `vite preview` (see
// playwright.config.ts). No accessibility library (such as axe-core) is
// used, to avoid a new dependency: each check is written out here.
//
// States: the empty page, the privacy panel open, step 1's help open, files
// being read, the list ready (with a file that failed, notes, a very long
// email, folded text shown, an email left out), "Print full original text",
// a PDF made, a PDF that could not be made, and after "Clear everything";
// also earlier emails rebuilt from quoted text (one left out, then all of
// them with the switch, then "Print full original text" ticked: the switch
// disabled, named, described, still 24 x 24, and skipped by Tab). In each:
// - every control is at least 24 x 24 CSS pixels (2.5.8), has a name, and
//   shows a focus outline of at least 2 px with 3:1 contrast against what
//   is around it (2.4.7, 2.4.11, 1.4.11);
// - every text has enough contrast (1.4.3, Helper/Test/browser-tests/support/contrast.ts);
// - the page does not scroll sideways at 1280 and 320 CSS pixels wide (320
//   is 1280 at 400% zoom, 1.4.10), even with long unbroken words;
// - the headings never skip a level;
// - after each action the focus stays on a control (never lost to <body>).
// Also: the status line is not read out file by file during a long batch
// (one stable text, no file number), a new result that removes the focused
// control puts the focus on "choose" (and leaves it alone otherwise: focus
// elsewhere, page just loaded, a mouse click on plain text far down the list),
// text spacing (1.4.12), forced colours (Windows High Contrast) and reduced
// motion. The keyboard order of every control is checked in
// Helper/Test/browser-tests/full-flow.spec.ts.
//
// Throughout (Helper/Test/browser-tests/support/network-and-csp-watch.ts): nothing leaves the page but the page's
// own files and the inlined workers' blob: URLs, no CSP violation, no
// console error. Only the text-spacing test turns the CSP off (bypassCSP):
// it must add a stylesheet of its own, as a user's browser extension would.
//
// Test data is made up: Helper/Test/test-data/eml and emails written here
// (README.md, rule R7: invented people, example.test addresses).
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { en } from '../../../Source/web-page/translations/en.ts';
import { contrastFailures } from './support/contrast.ts';
import { browserEngineOf, watchPage, withoutSelectConsole, withoutSelectReports, workerCspReports,
    type PageWatch } from './support/network-and-csp-watch.ts';

declare global
{
    interface Window
    {
        __a11yViolations: string[];
        /** Every text the status line showed, in order. */
        __a11yStatuses: string[];
        /** Every text the visible progress line showed, in order. */
        __a11yProgress: string[];
        /** Long-batch test only: lets the held thread-analysis worker start (see that test). */
        __a11yRelease: () => void;
    }
}

/** Project root as a file path ("file:///C:/x/" -> "C:/x/"), as in vite.config.ts. */
const ROOT = decodeURIComponent(new URL('../../..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');

/** Node's Buffer (see Helper/Test/browser-tests/add-files.spec.ts): what setInputFiles wants for in-memory files. */
const NodeBuffer = (globalThis as unknown as { Buffer: { from(bytes: Uint8Array): Uint8Array } }).Buffer;
type InputFile = { name: string; mimeType: string; buffer: never };
const textFile = (name: string, text: string, mimeType = 'message/rfc822'): InputFile => ({
    name,
    mimeType,
    buffer: NodeBuffer.from(new TextEncoder().encode(text)) as never,
});
const fixture = (name: string): InputFile => textFile(name, readFileSync(`${ROOT}Helper/Test/test-data/eml/${name}`, 'utf8'));

/** A long word with no place to break it, like a hash or a pasted link. */
const LONG = 'a1b2c3d4e5'.repeat(30);

/** An email full of long unbroken words: subject, sender, text, quote and attachment name. */
const LONG_EMAIL = textFile(
    'long-words.eml',
    [
        `From: Dana Longname <${'dana'.repeat(20)}@example.test>`,
        'To: Bob Sample <bob@example.test>',
        `Subject: ${LONG}`,
        'Date: Mon, 03 Mar 2025 10:00:00 +0000',
        'Message-ID: <long-words-1@example.test>',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="BOUNDARY"',
        '',
        '--BOUNDARY',
        'Content-Type: text/plain; charset=utf-8',
        '',
        `Hello, the reference is ${LONG} and that is all.`,
        '',
        `> quoted ${LONG}`,
        '',
        '--BOUNDARY',
        `Content-Type: text/plain; name="${LONG}.txt"`,
        `Content-Disposition: attachment; filename="${LONG}.txt"`,
        '',
        'x',
        '--BOUNDARY--',
        '',
    ].join('\r\n'),
);

// A thread with folded quotes, an undated email (notes), the long email and
// a file that is not an email (with a long name), which fails.
const FILES = [
    fixture('10-order-1-alice.eml'),
    fixture('11-order-2-bob-outlook-en.eml'),
    fixture('12-order-3-alice-gmail.eml'),
    fixture('70-no-date.eml'),
    LONG_EMAIL,
    textFile(`${LONG}.txt`, 'Just some text, not an email.', 'text/plain'),
];
const EMAILS = 5;

/** One small made-up email of the long batch. */
function batchEmail(emailNumber: number): InputFile
{
    const numberText = String(emailNumber);
    return textFile(
        `batch-${numberText}.eml`,
        [
            'From: Alice Example <alice@example.test>',
            'To: Bob Sample <bob@example.test>',
            `Subject: Bench note ${numberText}`,
            `Date: ${new Date(Date.UTC(2024, 0, 1) + emailNumber * 3_600_000).toUTCString().replace('GMT', '+0000')}`,
            `Message-ID: <bench-note-${numberText}@example.test>`,
            'Content-Type: text/plain; charset=utf-8',
            '',
            `Note ${numberText} about the garden benches.`,
            '',
        ].join('\r\n'),
    );
}

test.use({ timezoneId: 'Africa/Lagos' });

let origin = '';
let watch: PageWatch;
let loadedAt = 0;
let problems: string[] = [];

test.beforeEach(async ({ context, page, baseURL }) =>
{
    origin = new URL(baseURL ?? '').origin;
    problems = [];
    watch = await watchPage(context, page, origin);
    page.on('console', (message) =>
    {
        if (message.type() === 'error')
        {
            problems.push(`console: ${message.text()}`);
        }
    });
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    page.on('dialog', (dialog) =>
    {
        problems.push(`dialog: ${dialog.message()}`);
        void dialog.dismiss();
    });
    await page.addInitScript(() =>
    {
        window.__a11yViolations = [];
        window.__a11yStatuses = [];
        window.__a11yProgress = [];
        document.addEventListener('securitypolicyviolation', (event) =>
        {
            // "select": WebKit's report about a <select> (see withoutSelectReports).
            window.__a11yViolations.push(`${event.effectiveDirective} ${event.blockedURI}${event.target instanceof HTMLSelectElement ? ' select' : ''}`);
        });
        // Records each text the status line and the progress line show (each
        // change, also the same text set again), from before the app starts.
        const seen = (records: MutationRecord[], id: string, list: string[]): void =>
        {
            const element = document.getElementById(id);
            if (element === null || !records.some((r) => element === r.target || element.contains(r.target)))
            {
                return;
            }
            list.push(element.textContent ?? '');
        };
        new MutationObserver((records) =>
        {
            seen(records, 'status', window.__a11yStatuses);
            seen(records, 'add-progress-label', window.__a11yProgress);
        }).observe(document, { childList: true, subtree: true, characterData: true });
    });
});

async function open(page: Page): Promise<void>
{
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.locator('#drop-zone')).toBeVisible();
    loadedAt = watch.requests.length;
}

/** The emails of step 2's list. */
const items = (page: Page) => page.locator('#preview-list > li');

/** Adds FILES and waits until the list and its PDF plans are ready (the PDF button is available). */
async function addFiles(page: Page): Promise<void>
{
    await page.locator('#file-input').setInputFiles(FILES);
    await expect(items(page)).toHaveCount(EMAILS, { timeout: 60_000 });
    await expect(page.locator('#preview-list')).not.toHaveAttribute('aria-busy', /.*/);
    await expect(page.locator('#download-button')).not.toHaveAttribute('aria-disabled', /.*/, { timeout: 30_000 });
}

/**
 * Nothing left the page: after loading, only the inlined workers' own blob:
 * URLs; before, only the page's own files. No WebSocket, no console error.
 */
async function expectNoRequestLeftThePage(page: Page, cspPolicies = 2): Promise<void>
{
    await page.waitForTimeout(500);
    const ownBlob = new RegExp(`^blob:${origin}/[0-9a-f-]+$`);
    for (const url of watch.requests.slice(loadedAt))
    {
        expect(url).toMatch(ownBlob);
    }
    expect(watch.requests.every((url) => url.startsWith('blob:') || new URL(url).origin === origin)).toBe(true);
    expect(watch.websockets).toEqual([]);
    expect(withoutSelectConsole(browserEngineOf(page.context()), problems, cspPolicies)).toEqual([]);
}

/** Nothing left the page, no CSP violation, no console error (see Helper/Test/browser-tests/preview.spec.ts). */
async function expectNothingLeftThePage(page: Page): Promise<void>
{
    await expectNoRequestLeftThePage(page);
    expect(withoutSelectReports(browserEngineOf(page.context()), await page.evaluate(() => window.__a11yViolations))).toEqual([]);
    expect(workerCspReports(watch)).toEqual([]);
}

/** Every control a user can reach: links, buttons, fields and disclosure summaries. */
const CONTROLS = 'a[href], button, select, input:not([type="hidden"]):not([hidden]), summary';

/** What the test learns about one visible control. */
interface Control
{
    readonly what: string;
    readonly width: number;
    readonly height: number;
    readonly outlineStyle: string;
    readonly outlineWidth: number;
    /** Contrast of the focus outline against the background around the control. */
    readonly outlineContrast: number;
}

/**
 * Focuses each visible control in turn (after a key press, so the browser
 * shows the keyboard focus style) and measures it. The focus is put back
 * where it was afterwards.
 */
async function measureControls(page: Page): Promise<Control[]>
{
    // The key press must MOVE the focus (Tab): Chromium shows the keyboard
    // focus style after any key, even Shift, but Firefox only once the focus
    // was moved with the keyboard (WebKit: after a key that is not a modifier).
    // Where the focus was is noted first, so it is put back there.
    const before = await page.evaluateHandle(() => document.activeElement);
    await page.keyboard.press('Tab');
    return page.evaluate(([selector, previouslyFocused]) =>
    {
        const parse = (color: string): number[] => color.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 1];
        const luminance = (rgb: number[]): number =>
        {
            const channel = (channelValue: number): number =>
            {
                const scaled = channelValue / 255;
                return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
            };
            return 0.2126 * channel(rgb[0] ?? 0) + 0.7152 * channel(rgb[1] ?? 0) + 0.0722 * channel(rgb[2] ?? 0);
        };
        // The outline is drawn outside the control (outline-offset), over its parent's background.
        const background = (start: Element | null): number[] =>
        {
            for (let element = start; element; element = element.parentElement)
            {
                const backgroundRgba = parse(getComputedStyle(element).backgroundColor);
                if ((backgroundRgba[3] ?? 1) > 0)
                {
                    return backgroundRgba;
                }
            }
            return [255, 255, 255, 1];
        };
        // A disabled control cannot take the focus, so it has no focus outline
        // to measure (the one disabled control, the rebuilt switch while "Print
        // full original text" is ticked, is checked on its own below).
        const found = [...document.querySelectorAll<HTMLElement>(selector)]
            .filter((e) => e.checkVisibility() && !(e instanceof HTMLInputElement && e.disabled))
            .map((e) =>
            {
                const rect = e.getBoundingClientRect();
                e.focus();
                const style = getComputedStyle(e);
                const outline = luminance(parse(style.outlineColor));
                const around = luminance(background(e.parentElement));
                return {
                    what: `${e.tagName} #${e.id} "${(e.textContent ?? '').trim().slice(0, 40)}"`,
                    width: rect.width,
                    height: rect.height,
                    outlineStyle: style.outlineStyle,
                    outlineWidth: Number.parseFloat(style.outlineWidth),
                    outlineContrast: (Math.max(outline, around) + 0.05) / (Math.min(outline, around) + 0.05),
                };
            });
        if (previouslyFocused instanceof HTMLElement)
        {
            previouslyFocused.focus();
        }
        else
        {
            (document.activeElement as HTMLElement | null)?.blur();
        }
        return found;
    }, [CONTROLS, before] as const);
}

/** Pixels the page scrolls sideways (0: none). */
const sidewaysScroll = (page: Page): Promise<number> =>
    page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

/** The visible headings' levels, in page order. */
const headingLevels = (page: Page): Promise<number[]> =>
    page.locator('h1, h2, h3, h4, h5, h6').evaluateAll((list) => list.filter((h) => h.checkVisibility()).map((h) => Number(h.tagName.slice(1))));

/** The checks every state must pass (see the top of this file). */
async function expectAccessibleState(page: Page, state: string, minControls: number): Promise<void>
{
    const controls = await measureControls(page);
    expect(controls.length, state).toBeGreaterThanOrEqual(minControls);
    const small = controls.filter((c) => c.width < 24 || c.height < 24).map((c) => `${c.what} ${c.width.toFixed(1)}x${c.height.toFixed(1)}`);
    expect(small, `${state}: controls under 24 x 24 px`).toEqual([]);
    const unclear = controls
        .filter((c) => c.outlineStyle === 'none' || c.outlineWidth < 2 || c.outlineContrast < 3)
        .map((c) => `${c.what} ${c.outlineStyle} ${String(c.outlineWidth)}px ${c.outlineContrast.toFixed(2)}:1`);
    expect(unclear, `${state}: focus outlines`).toEqual([]);
    for (const control of await page.locator(CONTROLS).filter({ visible: true }).all())
    {
        await expect(control, state).toHaveAccessibleName(/\S/);
    }
    expect(await contrastFailures(page), `${state}: text contrast`).toEqual([]);
    expect(await sidewaysScroll(page), `${state}: sideways scroll`).toBeLessThanOrEqual(0);
    const levels = await headingLevels(page);
    expect(levels.filter((level) => level === 1), state).toHaveLength(1);
    for (let i = 1; i < levels.length; i++)
    {
        expect(levels[i] ?? 9, `${state}: heading ${String(i)}`).toBeLessThanOrEqual((levels[i - 1] ?? 0) + 1);
    }
}

/** The focused element's id ('' for none, 'BODY' when the focus was lost). */
const focusedId = (page: Page): Promise<string> =>
    page.evaluate(() => (document.activeElement === document.body ? 'BODY' : (document.activeElement?.id ?? '')));

for (const width of [1280, 320])
{
    test(`every state at ${String(width)} px: target size, names, focus outline, contrast, reflow, headings, focus kept`, async ({ page }) =>
    {
        test.setTimeout(120_000);
        await page.setViewportSize({ width, height: 800 });
        await open(page);

        // --- Empty page. The drop zone has a keyboard way in: the "choose" button.
        await expectAccessibleState(page, 'empty', 5);
        await expect(page.locator('#drop-zone').getByRole('button', { name: en.actions.chooseFiles })).toBeVisible();

        // --- Privacy panel open.
        await page.locator('#privacy-summary').focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('#privacy .privacy-body')).toBeVisible();
        await expectAccessibleState(page, 'privacy open', 4);
        await page.keyboard.press('Enter');
        await expect(page.locator('#privacy .privacy-body')).toBeHidden();

        // --- Step 1's help open: its h3 names sit under step 1's h2.
        await page.locator('#help-summary').focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('#help .help-body')).toBeVisible();
        await expectAccessibleState(page, 'help open', 5);
        expect(await focusedId(page)).toBe('help-summary');
        await page.keyboard.press('Enter');
        await expect(page.locator('#help .help-body')).toBeHidden();

        // --- The list ready: a failed file, notes, long words. ------------------
        await page.locator('#choose-files').focus();
        await addFiles(page);
        // Adding files keeps the focus on the "choose" button.
        expect(await focusedId(page)).toBe('choose-files');
        // Each include checkbox's name says which email it is for.
        const boxes = page.locator('#preview-list .include-checkbox');
        await expect(boxes).toHaveCount(EMAILS);
        for (const [i, box] of (await boxes.all()).entries())
        {
            await expect(box).toHaveAccessibleName(new RegExp(`^${en.actions.include} #${String(i + 1)} \\S`));
        }
        await expect(page.getByRole('checkbox', { name: `${en.actions.include} #2 ${LONG}` })).toHaveCount(1);
        // The failed file's "Technical details" says which file it is about.
        const details = page.locator('#add-failed-list summary');
        await expect(details).toHaveAccessibleName(en.added.details);
        await expect(details).toHaveAccessibleDescription(`${LONG}.txt ${en.errors.file['unsupported-type']}`);
        await details.focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('#add-failed-list .failed-detail')).toBeVisible();
        // Folded text shown, and one email left out of the PDF (Space, from the keyboard).
        await page.locator('#preview-show-folded').focus();
        await page.keyboard.press('Space');
        await expect(page.locator('#preview-list details.fold:not([open])')).toHaveCount(0);
        const third = items(page).nth(2).locator('.include-checkbox');
        await third.focus();
        await page.keyboard.press('Space');
        await expect(third).not.toBeChecked();
        await expect(page.getByRole('status')).toHaveText(`${String(EMAILS - 1)} of ${String(EMAILS)} emails will be in the PDF.`);
        await expect(page.locator('#preview-list')).toHaveAttribute('data-pdf-labels', 'ready');
        await expect(items(page).nth(2).locator('.excluded-note')).toBeVisible();
        expect(await focusedId(page)).toBe('include-2');
        await expectAccessibleState(page, 'list ready', 12);

        // --- "Print full original text": every label says "In the PDF". -------
        await page.locator('#pdf-everything').focus();
        await page.keyboard.press('Space');
        await expect(page.locator('#preview-list')).toHaveAttribute('data-pdf-labels', 'ready');
        await expect(page.locator('#preview-list .pdf-label:visible').first()).toHaveText(/^In the PDF/);
        expect(await focusedId(page)).toBe('pdf-everything');
        await expectAccessibleState(page, 'everything in the PDF', 12);

        // --- The PDF, made with the keyboard: the focus stays on the button. ----
        const download = page.waitForEvent('download');
        await page.locator('#download-button').focus();
        await page.keyboard.press('Enter');
        await download;
        await expect(page.locator('#download-area')).toHaveAttribute('data-state', 'ready');
        await expect(page.getByRole('status')).toHaveText(/^Your PDF is ready: /);
        expect(await focusedId(page)).toBe('download-button');
        await expect(page.locator('#download-link')).toBeVisible();
        await expectAccessibleState(page, 'PDF ready', 13);

        // --- "Clear everything": the focus goes to "choose". ---------------------
        await page.locator('#clear-everything').focus();
        await page.keyboard.press('Enter');
        await expect(page.getByRole('status')).toHaveText(en.clear.done);
        expect(await focusedId(page)).toBe('choose-files');
        await expectAccessibleState(page, 'cleared', 5);

        await expectNothingLeftThePage(page);
    });
}

test('a long batch: the progress line follows every file, the status line has one stable text and is not read out file by file', async ({ page }) =>
{
    test.setTimeout(180_000);
    // Test only: the batch's "putting in order" step (the thread-analysis worker, runtime name 'engine-worker') waits
    // until the test releases it, so the busy state is checked while it is
    // surely still going. Its own time limit (60 s) is far away.
    await page.addInitScript(() =>
    {
        const held: (() => void)[] = [];
        let holding = true;
        window.__a11yRelease = () =>
        {
            holding = false;
            for (const send of held.splice(0))
            {
                send();
            }
        };
        const RealWorker = window.Worker;
        window.Worker = class extends RealWorker
        {
            constructor(url: string | URL, options?: WorkerOptions)
            {
                super(url, options);
                if (options?.name !== 'engine-worker')
                {
                    return;
                }
                const send = this.postMessage.bind(this) as (...args: unknown[]) => void;
                Object.defineProperty(this, 'postMessage', {
                    value: (...args: unknown[]) =>
                    {
                        if (holding)
                        {
                            held.push(() => send(...args));
                        }
                        else
                        {
                            send(...args);
                        }
                    },
                });
            }
        };
    });
    await open(page);
    const COUNT = 120;
    const batch = Array.from({ length: COUNT }, (_, i) => batchEmail(i));
    await page.locator('#choose-files').focus();
    await page.locator('#file-input').setInputFiles(batch);
    // Being read: the "choose" button is unavailable and says why (the progress line first).
    const choose = page.locator('#choose-files');
    const progressLine = `(Reading file \\d+ of ${String(COUNT)}\\.\\.\\.|${en.drop.organizing.replaceAll('.', '\\.')})`;
    await expect(page.locator('#add-progress')).toBeVisible();
    await expect(choose).toHaveAttribute('aria-disabled', 'true');
    await expect(choose).toHaveAccessibleDescription(new RegExp(`^${progressLine} ${en.drop.accepted.replaceAll('.', '\\.')}$`));
    await expect(page.locator('#add-progress-bar')).toHaveAccessibleName(new RegExp(`^${progressLine}$`));
    await expectAccessibleStateWhileBusy(page);
    // Still busy after the checks (the thread analysis is held): they did check the busy state.
    await expect(page.locator('#add-progress')).toBeVisible();
    await expect(choose).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('#add-summary')).toBeHidden();
    await expect(page.locator('#add-progress-label')).toHaveText(en.drop.organizing, { timeout: 60_000 });
    await page.evaluate(() => window.__a11yRelease());

    const summary = `${String(COUNT)} files added. ${String(COUNT)} emails found.`;
    await expect(page.locator('#add-summary-text')).toHaveText(summary, { timeout: 150_000 });
    await expect(choose).not.toHaveAttribute('aria-disabled', /.*/);
    await expect(choose).toHaveAccessibleDescription(en.drop.accepted);
    expect(await focusedId(page)).toBe('choose-files');

    const statuses = await page.evaluate(() => window.__a11yStatuses);
    const progress = await page.evaluate(() => window.__a11yProgress);
    // The status line: one stable text while reading (no file number), then
    // "putting in order", then the result. Nothing else.
    expect(statuses).toEqual([en.drop.readingMany.replace('{total}', String(COUNT)), en.drop.organizing, summary]);
    expect(statuses.filter((s) => /Reading file|\d+ of \d+/.test(s))).toEqual([]);
    // The visible progress line followed the files.
    expect(new Set(progress.filter((p) => p.startsWith('Reading file'))).size).toBeGreaterThan(20);

    await expectNothingLeftThePage(page);
});

/** While files are read: the controls and texts are fine too (same control checks as expectAccessibleState). */
async function expectAccessibleStateWhileBusy(page: Page): Promise<void>
{
    const controls = await measureControls(page);
    expect(
        controls.filter((c) => c.width < 24 || c.height < 24 || c.outlineStyle === 'none' || c.outlineWidth < 2 || c.outlineContrast < 3),
    ).toEqual([]);
    expect(await contrastFailures(page), 'busy: text contrast').toEqual([]);
}

test('a new result that removes the focused control puts the focus on "choose"; focus elsewhere stays', async ({ page }) =>
{
    test.setTimeout(120_000);
    await open(page);
    await addFiles(page);
    const summary = page.locator('#add-summary-text');

    // Focus on an include checkbox: the new result rebuilds the list and takes it away.
    await page.locator('#include-1').focus();
    expect(await focusedId(page)).toBe('include-1');
    await page.locator('#file-input').setInputFiles([batchEmail(1)]);
    await expect(summary).toHaveText(`${String(FILES.length + 1)} files added. 1 could not be read. ${String(EMAILS + 1)} emails found.`, {
        timeout: 60_000,
    });
    await expect.poll(() => focusedId(page)).toBe('choose-files');

    // Focus outside the rebuilt parts (the time-zone select, the privacy panel's
    // and step 1's help summaries): left where it is.
    for (const [id, added] of [
        ['preview-zone', 2],
        ['privacy-summary', 3],
        ['help-summary', 4],
    ] as const)
    {
        await page.locator(`#${id}`).focus();
        await page.locator('#file-input').setInputFiles([batchEmail(added)]);
        await expect(summary).toHaveText(`${String(FILES.length + added)} files added. 1 could not be read. ${String(EMAILS + added)} emails found.`, {
            timeout: 60_000,
        });
        await expect(items(page)).toHaveCount(EMAILS + added, { timeout: 60_000 });
        expect(await focusedId(page)).toBe(id);
    }
    await expectNothingLeftThePage(page);
});

/** Adds `files` and waits until step 2 shows `count` emails, fully built. */
async function addAndWait(page: Page, files: InputFile[], count: number): Promise<void>
{
    await page.locator('#file-input').setInputFiles(files);
    await expect(items(page)).toHaveCount(count, { timeout: 60_000 });
    await expect(page.locator('#preview-list')).not.toHaveAttribute('aria-busy', /.*/);
    await expect(page.locator('#download-button')).not.toHaveAttribute('aria-disabled', /.*/, { timeout: 30_000 });
}

test('a focus on <body> that no removal caused is never moved: page just loaded, a mouse click on plain text, a control blurred', async ({ page }) =>
{
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page);

    // Page just loaded (focus on <body>), files added: the focus is not put on "choose".
    expect(await focusedId(page)).toBe('BODY');
    await addAndWait(page, [batchEmail(0)], 1);
    expect(await focusedId(page)).not.toBe('choose-files');

    // A mouse user reads far down the list and clicks plain text in an email,
    // after having ticked a checkbox with the mouse (that box keeps no focus).
    await addAndWait(page, Array.from({ length: 17 }, (_, i) => batchEmail(i + 1)), 18);
    await items(page).nth(14).locator('.include-checkbox').click();
    await items(page).nth(14).locator('.include-checkbox').click();
    await items(page).nth(14).locator('.body-text').click();
    expect(await focusedId(page)).toBe('BODY');
    const before = await page.evaluate(() => window.scrollY);
    expect(before).toBeGreaterThan(1000);
    // A new file (its email goes last): the page does not jump, the focus is not moved.
    await addAndWait(page, [batchEmail(18)], 19);
    expect(await focusedId(page)).not.toBe('choose-files');
    expect(Math.abs((await page.evaluate(() => window.scrollY)) - before)).toBeLessThanOrEqual(4);

    // A control that lost the focus to <body> without being removed (and
    // without a mouse press): a new result does not move the focus either.
    await page.locator('#preview-zone').focus();
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    expect(await focusedId(page)).toBe('BODY');
    await addAndWait(page, [batchEmail(19)], 20);
    expect(await focusedId(page)).not.toBe('choose-files');
    await expectNothingLeftThePage(page);
});

test('a PDF that could not be made: the error is announced, readable, and the focus stays on the button', async ({ page }) =>
{
    test.setTimeout(120_000);
    // Test only: the browser refuses to start the PDF worker (the other workers start as usual).
    await page.addInitScript(() =>
    {
        const RealWorker = window.Worker;
        window.Worker = class extends RealWorker
        {
            constructor(url: string | URL, options?: WorkerOptions)
            {
                if (options?.name === 'pdf-worker')
                {
                    throw new Error('test: no PDF worker');
                }
                super(url, options);
            }
        };
    });
    await open(page);
    await addFiles(page);
    await page.locator('#download-button').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#download-area')).toHaveAttribute('data-state', 'error');
    await expect(page.getByRole('status')).toHaveText(en.download.error['not-started']);
    await expect(page.locator('#download-note')).toHaveText(en.download.error['not-started']);
    await expect(page.locator('#download-button')).toHaveAccessibleDescription(en.download.error['not-started']);
    expect(await focusedId(page)).toBe('download-button');
    await expectAccessibleState(page, 'PDF error', 12);
    await expectNothingLeftThePage(page);
});

test.describe('with larger text spacing (WCAG 1.4.12)', () =>
{
    // The CSP would block the test's own stylesheet (style-src 'self'); a
    // user's extension or browser setting adds such styles the same way.
    test.use({ bypassCSP: true });

    test('nothing is cut off and the page does not scroll sideways', async ({ page }) =>
    {
        test.setTimeout(120_000);
        await open(page);
        await addFiles(page);
        await page.locator('#add-failed-list summary').click();
        await page.locator('#help-summary').click();
        await expect(page.locator('#help .help-body')).toBeVisible();
        await page.locator('#preview-show-folded').check();
        await page.addStyleTag({
            content: '* { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; } p { margin-bottom: 2em !important; }',
        });
        for (const width of [1280, 320])
        {
            await page.setViewportSize({ width, height: 800 });
            const cut = await page.evaluate(() =>
                [...document.querySelectorAll<HTMLElement>('body *')]
                    .filter((e) =>
                    {
                        if (!e.checkVisibility())
                        {
                            return false;
                        }
                        const style = getComputedStyle(e);
                        const clips = /hidden|clip/.test(`${style.overflowX} ${style.overflowY}`);
                        return clips && (e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1);
                    })
                    .map((e) => `${e.tagName}.${e.className}`),
            );
            expect(cut, String(width)).toEqual([]);
            expect(await sidewaysScroll(page), String(width)).toBeLessThanOrEqual(0);
        }
        // The CSP is off here, so only the requests can be checked: still none leave the page.
        await expectNoRequestLeftThePage(page, 0);
    });
});

test('forced colours (Windows High Contrast): focus outlines, checkboxes, borders and unavailable buttons still show', async ({ page }) =>
{
    test.setTimeout(120_000);
    await page.emulateMedia({ forcedColors: 'active' });
    await open(page);
    // Unavailable buttons look different from an available one (GrayText).
    const colours = await page.evaluate(() =>
        ['#choose-files', '#clear-everything', '#download-button'].map((id) =>
        {
            const style = getComputedStyle(document.querySelector(id) ?? document.body);
            return `${style.color} ${style.borderTopColor}`;
        }),
    );
    expect(colours[1]).toBe(colours[2]);
    expect(colours[1]).not.toBe(colours[0]);

    await addFiles(page);
    await items(page).nth(1).locator('.include-checkbox').uncheck();
    await expect(page.locator('#preview-list')).toHaveAttribute('data-pdf-labels', 'ready');
    for (const control of await measureControls(page))
    {
        expect(control.outlineStyle, control.what).not.toBe('none');
        expect(control.outlineWidth, control.what).toBeGreaterThanOrEqual(2);
        expect(control.width, control.what).toBeGreaterThanOrEqual(24);
        expect(control.height, control.what).toBeGreaterThanOrEqual(24);
    }
    // "Not in the PDF" keeps its border and its words; the folded parts their labels.
    const note = items(page).nth(1).locator('.excluded-note');
    await expect(note).toBeVisible();
    await expect(note).toHaveText(en.review.excluded);
    expect(await note.evaluate((e) => getComputedStyle(e).borderTopStyle)).toBe('solid');
    await expect(page.locator('#preview-list .pdf-label:visible').first()).toHaveText(/^(Not in|In) the PDF: /);
    await expectNothingLeftThePage(page);
});

test('reduced motion: nothing on the page moves by itself', async ({ page }) =>
{
    test.setTimeout(120_000);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    await addFiles(page);
    await page.locator('#preview-show-folded').check();
    const moving = await page.evaluate(() =>
        [...document.querySelectorAll('*')]
            .filter((e) =>
            {
                const style = getComputedStyle(e);
                const longest = (list: string): number => Math.max(...list.split(',').map((d) => Number.parseFloat(d) * (d.trim().endsWith('ms') ? 0.001 : 1)));
                return longest(style.transitionDuration) > 0.001 || longest(style.animationDuration) > 0.001 || style.scrollBehavior === 'smooth';
            })
            .map((e) => `${e.tagName}.${e.className}`),
    );
    expect(moving).toEqual([]);
    await expectNothingLeftThePage(page);
});

// Earlier emails rebuilt from quoted text (task 7.6): the last email of a
// thread alone gives three rebuilt cards before its own.
for (const width of [1280, 320])
{
    test(`rebuilt cards at ${String(width)} px: target size, names, focus outline, contrast, reflow, headings`, async ({ page }) =>
    {
        test.setTimeout(120_000);
        await page.setViewportSize({ width, height: 800 });
        await open(page);
        await page.locator('#file-input').setInputFiles([fixture('13-order-4-bob-outlook-nl.eml')]);
        await expect(items(page)).toHaveCount(4, { timeout: 60_000 });
        await expect(page.locator('#preview-list > li.message-rebuilt')).toHaveCount(3);
        await expect(page.locator('#preview-list')).not.toHaveAttribute('aria-busy', /.*/);
        await expect(page.locator('#download-button')).not.toHaveAttribute('aria-disabled', /.*/, { timeout: 30_000 });
        await expectAccessibleState(page, 'rebuilt cards', 10);
        // One card left out: dimmed, marked in words.
        await page.locator('#include-rebuilt-1').focus();
        await page.keyboard.press('Space');
        await expect(page.locator('#preview-list > li.message-rebuilt').nth(1)).toHaveAttribute('data-included', 'false');
        await expectAccessibleState(page, 'a rebuilt card left out', 10);
        expect(await focusedId(page)).toBe('include-rebuilt-1');
        // Every rebuilt email left out with the switch: the focus stays on it.
        await page.locator('#rebuilt-include-all').focus();
        await page.keyboard.press('Space');
        await expect(page.locator('#preview-list > li.message-rebuilt').first()).toBeHidden();
        await expectAccessibleState(page, 'rebuilt emails left out', 8);
        expect(await focusedId(page)).toBe('rebuilt-include-all');
        // Switch back on, then "Print full original text" ticked with the
        // keyboard: the switch is unticked and disabled, the focus stays on the
        // full-text checkbox, and Tab skips the switch and the hidden cards.
        await page.keyboard.press('Space');
        await expect(page.locator('#preview-list > li.message-rebuilt').first()).toBeVisible();
        await page.locator('#pdf-everything').focus();
        await page.keyboard.press('Space');
        const rebuildSwitch = page.locator('#rebuilt-include-all');
        await expect(rebuildSwitch).toBeDisabled();
        await expect(rebuildSwitch).not.toBeChecked();
        await expect(rebuildSwitch).toHaveAccessibleName(en.rebuilt.rebuildConversation);
        await expect(rebuildSwitch).toHaveAccessibleDescription(`${en.rebuilt.offWhileFullText} ${en.rebuilt.explain}`);
        const switchBox = await rebuildSwitch.boundingBox();
        expect(switchBox!.width).toBeGreaterThanOrEqual(24);
        expect(switchBox!.height).toBeGreaterThanOrEqual(24);
        await expect(page.locator('#preview-list > li.message-rebuilt').first()).toBeHidden();
        await expectAccessibleState(page, 'full original text, rebuilt switch disabled', 7);
        expect(await focusedId(page)).toBe('pdf-everything');
        await page.keyboard.press('Tab');
        expect(await focusedId(page)).toBe('include-0');
        await expectNothingLeftThePage(page);
    });
}
