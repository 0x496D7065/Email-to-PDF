// Browser test of the step 1 help, "How do I get my email files?"
// (src/ui/app.ts), in each test browser against the BUILT site served by
// `vite preview` (see playwright.config.ts).
//
// The help is a native <details>/<summary> right above the drop zone: closed
// at first, the Tab stop right after the privacy panel's summary and right
// before the "choose" button, opened and closed with Enter or Space, holding
// no control and no link. Its mail programs are a list with h3 names under
// step 1's h2. Opening it loads nothing and triggers no CSP violation
// (e2e/support/watch.ts). No accessibility library is used (no new
// dependency): names, focus, headings and contrast are checked explicitly.
import { expect, test, type Page } from '@playwright/test';
import { en } from '../src/ui/i18n/en.ts';
import { contrastFailures } from './support/contrast.ts';
import { tabSkipsLinks } from './support/keyboard.ts';
import { watchPage, withoutSelectConsole, withoutSelectReports, type Watch } from './support/watch.ts';

declare global
{
    interface Window
    {
        __helpViolations: string[];
    }
}

let origin = '';
let watch: Watch;
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
        window.__helpViolations = [];
        document.addEventListener('securitypolicyviolation', (event) =>
        {
            // "select": WebKit's report about a <select> (see withoutSelectReports).
            window.__helpViolations.push(`${event.effectiveDirective} ${event.blockedURI}${event.target instanceof HTMLSelectElement ? ' select' : ''}`);
        });
    });
});

/** Opens the page; returns how many requests the load itself made. */
async function open(page: Page): Promise<number>
{
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.getByRole('main')).toBeVisible();
    return watch.requests.length;
}

const CLIENTS = Object.values(en.help.clients);

/** Every text of the open help, in order: intro, each program's name and text, the note. */
const HELP_TEXTS = [en.help.intro, ...CLIENTS.flatMap((client) => [client.name, client.how]), en.help.note];

test('the help sits by step 1, opens and closes with Enter and Space, and reads well', async ({ page, browserName }) =>
{
    const loaded = await open(page);
    const step = page.getByRole('region', { name: `Step 1 ${en.steps.add.title}` });
    const help = page.locator('details#help');
    const summary = help.locator('summary');
    const body = help.locator('.help-body');

    // Closed at first, inside step 1, right above the drop zone, named by its summary.
    await expect(step.locator('details#help')).toHaveCount(1);
    await expect(help).not.toHaveAttribute('open', /.*/);
    await expect(body).toBeHidden();
    await expect(summary).toBeVisible();
    await expect(summary).toHaveAccessibleName(en.help.summary);
    const above = await page.evaluate(() =>
    {
        const helpBox = document.querySelector('#help')?.getBoundingClientRect();
        const zone = document.querySelector('#drop-zone')?.getBoundingClientRect();
        return helpBox !== undefined && zone !== undefined && helpBox.bottom <= zone.top;
    });
    expect(above).toBe(true);

    // The Tab stop after the language picker, the Ko-fi button (skipped by Tab
    // in WebKit, see e2e/support/keyboard.ts) and the privacy panel's summary, with a visible outline.
    await page.keyboard.press('Tab');
    await expect(page.locator('#lang-en')).toBeFocused();
    if (!tabSkipsLinks(browserName))
    {
        await page.keyboard.press('Tab');
        await expect(page.locator('#donate-link')).toBeFocused();
    }
    await page.keyboard.press('Tab');
    await expect(page.locator('#privacy-summary')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(summary).toBeFocused();
    const outline = await summary.evaluate((e) =>
    {
        const style = getComputedStyle(e);
        return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
    });
    expect(outline.style).not.toBe('none');
    expect(outline.width).toBeGreaterThanOrEqual(2);

    // Enter opens it: every text is shown, in order, and the focus stays on the summary.
    await page.keyboard.press('Enter');
    await expect(help).toHaveAttribute('open', '');
    await expect(body).toBeVisible();
    await expect(body.locator('h3, p')).toHaveText(HELP_TEXTS);
    await expect(summary).toBeFocused();

    // A list of the five mail programs, each named by an h3 heading.
    await expect(body.getByRole('list')).toHaveCount(1);
    await expect(body.getByRole('listitem')).toHaveCount(5);
    await expect(body.getByRole('heading', { level: 3 })).toHaveText(CLIENTS.map((client) => client.name));

    // Headings: one h1, then step 1's h2 right before the help's h3 names; no level skipped.
    const headings = await page.locator('h1, h2, h3, h4, h5, h6').evaluateAll((list) =>
        list.filter((h) => h.checkVisibility()).map((h) => ({ level: Number(h.tagName.slice(1)), text: h.textContent ?? '' })),
    );
    expect(headings[0]).toEqual({ level: 1, text: en.app.name });
    expect(headings.filter((h) => h.level === 1)).toHaveLength(1);
    for (let i = 1; i < headings.length; i++)
    {
        expect(headings[i]?.level ?? 9).toBeLessThanOrEqual((headings[i - 1]?.level ?? 0) + 1);
    }
    const stepIndex = headings.findIndex((h) => h.level === 2 && h.text.endsWith(en.steps.add.title));
    expect(headings.slice(stepIndex + 1, stepIndex + 6)).toEqual(CLIENTS.map((client) => ({ level: 3, text: client.name })));

    // Readable: enough contrast, no link and no control inside.
    expect(await contrastFailures(page, '#help', 13)).toEqual([]);
    await expect(help.locator('a, button, input, select, textarea, [tabindex]')).toHaveCount(0);

    // The next Tab stop is step 1's "choose" button: nothing traps the focus.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: en.actions.chooseFiles })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(summary).toBeFocused();

    // Space closes it.
    await page.keyboard.press('Space');
    await expect(help).not.toHaveAttribute('open', /.*/);
    await expect(body).toBeHidden();
    // And opens it again; Enter closes it.
    await page.keyboard.press('Space');
    await expect(body).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(body).toBeHidden();

    // The drop zone is unchanged: still the "choose" button inside it, and step 2 still waiting.
    await expect(page.locator('#drop-zone').getByRole('button', { name: en.actions.chooseFiles })).toBeVisible();
    await expect(page.locator('#check-waiting')).toBeVisible();

    // Nothing was loaded and nothing was blocked.
    expect(watch.requests.slice(loaded)).toEqual([]);
    expect(watch.websockets).toEqual([]);
    expect(withoutSelectReports(browserName, await page.evaluate(() => window.__helpViolations))).toEqual([]);
    expect(withoutSelectConsole(browserName, problems)).toEqual([]);
});

test('whether the help is open is not kept: a reload shows it closed, and nothing is stored', async ({ page }) =>
{
    await open(page);
    await page.locator('#help-summary').click();
    await expect(page.locator('#help .help-body')).toBeVisible();
    const stored = await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, cookies: document.cookie }));
    expect(stored).toEqual({ local: 0, session: 0, cookies: '' });
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.locator('details#help')).not.toHaveAttribute('open', /.*/);
    await expect(page.locator('#help .help-body')).toBeHidden();
});

for (const [label, size] of [
    ['a narrow phone screen', { width: 320, height: 640 }],
    ['200% zoom (640 CSS px wide)', { width: 640, height: 400 }],
] as const)
{
    test(`the open help fits ${label}`, async ({ page, browserName }) =>
    {
        await page.setViewportSize(size);
        await open(page);
        await page.locator('#help-summary').click();
        await expect(page.locator('#help .help-body')).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow).toBeLessThanOrEqual(0);
        expect(await contrastFailures(page, '#help', 13)).toEqual([]);
        expect(withoutSelectConsole(browserName, problems)).toEqual([]);
    });
}
