// Browser test of the page shell: one screen, three steps (add, check,
// download), accessible and working under the strict CSP (README.md, rules
// R1, R2 and R4). Runs in each test browser against the built site served by
// `vite preview` (see playwright.config.ts).
//
// No accessibility library (such as axe-core) is used, to avoid a new
// dependency: landmarks, names, keyboard order, focus outlines and colour
// contrast are checked explicitly below (contrast: e2e/support/contrast.ts).
import { expect, test, type Page } from '@playwright/test';
import { DONATION_IMAGE, DONATION_URL } from '../src/ui/dom.ts';
import { en } from '../src/ui/i18n/en.ts';
import { contrastFailures } from './support/contrast.ts';
import { tabSkipsLinks } from './support/keyboard.ts';
import { withoutSelectConsole, withoutSelectReports } from './support/watch.ts';

declare global
{
    interface Window {
        __shellViolations: string[];
        __focusables: Element[];
    }
}

/** Console errors and uncaught page errors, collected per test. */
let problems: string[] = [];

test.beforeEach(async ({ page }) =>
{
    problems = [];
    page.on('console', (message) =>
    {
        if (message.type() === 'error')
        {
            problems.push(`console: ${message.text()}`);
        }
    });
    page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
    // Records CSP violations before any of the app's scripts run.
    await page.addInitScript(() =>
    {
        window.__shellViolations = [];
        document.addEventListener('securitypolicyviolation', (event) =>
        {
            // "select": WebKit's report about a <select> (see withoutSelectReports).
            window.__shellViolations.push(`${event.effectiveDirective} ${event.blockedURI}${event.target instanceof HTMLSelectElement ? ' select' : ''}`);
        });
    });
});

/** Opens the page and waits until the shell is built. */
async function open(page: Page): Promise<void>
{
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.getByRole('main')).toBeVisible();
}

test('shows the three steps in order, with landmarks, language and title', async ({ page }) =>
{
    await open(page);

    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page).toHaveTitle(en.app.name);

    await expect(page.getByRole('banner')).toHaveCount(1);
    await expect(page.getByRole('main')).toHaveCount(1);
    await expect(page.getByRole('contentinfo')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(en.app.name);
    await expect(page.getByRole('banner')).toContainText(en.app.promise);

    const steps = [en.steps.add.title, en.steps.check.title, en.steps.download.title];
    const headings = page.getByRole('main').getByRole('heading', { level: 2 });
    await expect(headings).toHaveText(steps.map((title, i) => `Step ${String(i + 1)} ${title}`));

    // Each step is a region named by its heading, so it can be reached directly.
    for (const [i, title] of steps.entries())
    {
        await expect(page.getByRole('region', { name: `Step ${String(i + 1)} ${title}` })).toBeVisible();
    }
});

test('starts with step 2 waiting and the download unavailable but explained', async ({ page, browserName }) =>
{
    await open(page);

    await expect(page.locator('#check-waiting')).toHaveText(en.steps.check.waiting);
    await expect(page.locator('#check-area')).toBeHidden();

    const download = page.getByRole('button', { name: en.actions.makePdf });
    await expect(download).toHaveAttribute('aria-disabled', 'true');
    await expect(download).toHaveAccessibleDescription(en.download.unavailable['no-emails']);
    // Assistive technology (and Playwright) see it as disabled...
    await expect(download).toBeDisabled();
    // ...yet it can still be focused, and pressing it does nothing (no
    // navigation, no error). The keyboard is used because Playwright refuses
    // to click a button it considers disabled.
    const url = page.url();
    await download.focus();
    await expect(download).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    expect(page.url()).toBe(url);
    await expect(page.locator('#download-area')).toHaveAttribute('data-state', 'idle');
    await expect(page.locator('#download-link')).toBeHidden();
    expect(withoutSelectConsole(browserName, problems)).toEqual([]);
});

test('has one polite live region for status messages', async ({ page }) =>
{
    await open(page);
    const live = page.locator('[aria-live]');
    await expect(live).toHaveCount(1);
    await expect(live).toHaveAttribute('aria-live', 'polite');
    await expect(live).toHaveAttribute('role', 'status');
    await expect(page.getByRole('status')).toHaveCount(1);
});

test('gives every control an accessible name', async ({ page }) =>
{
    await open(page);
    const roles = ['button', 'link', 'checkbox', 'radio', 'textbox', 'combobox'] as const;
    let controls = 0;
    for (const role of roles)
    {
        for (const control of await page.getByRole(role).all())
        {
            await expect(control).toHaveAccessibleName(/\S/);
            controls++;
        }
    }
    expect(controls).toBeGreaterThan(0);
});

test('reaches every interactive element with Tab, in page order, with a visible focus outline', async ({ page, browserName }) =>
{
    await open(page);

    const count = await page.evaluate((skipLinks) =>
    {
        const selector = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]';
        // A radio group is one Tab stop: its ticked radio (the language picker;
        // the arrow keys move to the others). WebKit's Tab skips links (the
        // Ko-fi button), see e2e/support/keyboard.ts.
        window.__focusables = [...document.querySelectorAll(selector)].filter(
            (e) =>
                !(e as HTMLButtonElement).disabled &&
                e.getAttribute('tabindex') !== '-1' &&
                e.getClientRects().length > 0 &&
                !(e instanceof HTMLInputElement && e.type === 'radio' && !e.checked) &&
                !(skipLinks && e instanceof HTMLAnchorElement),
        );
        // A positive tabindex would break the natural order: there must be none.
        return document.querySelectorAll('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])').length === 0
            ? window.__focusables.length
            : -1;
    }, tabSkipsLinks(browserName));
    expect(count).toBeGreaterThan(0);

    for (let i = 0; i < count; i++)
    {
        await page.keyboard.press('Tab');
        const focus = await page.evaluate(() =>
        {
            const active = document.activeElement;
            const style = active ? getComputedStyle(active) : null;
            return {
                index: active ? window.__focusables.indexOf(active) : -1,
                outlineStyle: style?.outlineStyle ?? 'none',
                outlineWidth: Number.parseFloat(style?.outlineWidth ?? '0'),
            };
        });
        expect(focus.index).toBe(i);
        expect(focus.outlineStyle).not.toBe('none');
        expect(focus.outlineWidth).toBeGreaterThanOrEqual(2);
    }
});

test('has enough colour contrast for every text (WCAG AA)', async ({ page }) =>
{
    await open(page);
    expect(await contrastFailures(page)).toEqual([]);
});

test('fits a narrow phone screen without sideways scrolling', async ({ page }) =>
{
    await page.setViewportSize({ width: 320, height: 640 });
    await open(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
});

test('has no inline styles, no inline handlers and no links to other sites but the Ko-fi button', async ({ page }) =>
{
    await open(page);
    const found = await page.evaluate(() =>
        [...document.querySelectorAll('*')].flatMap((e) =>
            [...e.attributes]
                .filter((a) => a.name === 'style' || a.name.startsWith('on') || /^(href|src)$/.test(a.name))
                .map((a) => `${e.tagName}${e.id === '' ? '' : `#${e.id}`} ${a.name}=${a.value}`)
                // The page's own scripts and stylesheet (in assets/) are allowed src/href.
                .filter((s) => !/^(?:SCRIPT src|LINK href)=\/assets\/[\w-]+\.(?:js|css)$/.test(s)),
        ),
    );
    // Besides them, only the Ko-fi button (e2e/no-network.spec.ts checks it
    // further): its link to the donation page and its bundled image.
    expect(found).toEqual([`A#donate-link href=${DONATION_URL}`, `IMG src=${DONATION_IMAGE.src}`]);
});

test('loads without console errors, page errors or CSP violations', async ({ page, browserName }) =>
{
    await open(page);
    await page.keyboard.press('Tab');
    expect(withoutSelectReports(browserName, await page.evaluate(() => window.__shellViolations))).toEqual([]);
    expect(withoutSelectConsole(browserName, problems)).toEqual([]);
});

test.describe('without JavaScript', () =>
{
    test.use({ javaScriptEnabled: false });

    test('explains that JavaScript is needed', async ({ page }) =>
    {
        await page.goto('/');
        await expect(page.locator('.noscript')).toContainText('needs JavaScript');
        expect(problems).toEqual([]);
    });
});
