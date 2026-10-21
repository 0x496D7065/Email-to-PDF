// Browser test of the privacy panel at the top of the page and the
// disclaimer of step 3 (src/ui/app.ts; README.md, rules R1, R2 and R4), in
// each test browser against the BUILT site served by `vite preview` (see
// playwright.config.ts).
//
// The panel is a native <details>/<summary>: closed at first, the first Tab
// stop of the page, opened and closed with Enter or Space, with headings that
// fit the page's levels. Opening it loads nothing and triggers no CSP
// violation (e2e/support/watch.ts). No accessibility library is used (no new
// dependency): names, focus, headings and contrast are checked explicitly.
import { expect, test, type Page } from '@playwright/test';
import { en } from '../src/ui/i18n/en.ts';
import { contrastFailures } from './support/contrast.ts';
import { watchPage, withoutSelectConsole, withoutSelectReports, type Watch } from './support/watch.ts';

declare global {
  interface Window {
    __privacyViolations: string[];
  }
}

let origin = '';
let watch: Watch;
let problems: string[] = [];

test.beforeEach(async ({ context, page, baseURL }) => {
  origin = new URL(baseURL ?? '').origin;
  problems = [];
  watch = await watchPage(context, page, origin);
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('dialog', (dialog) => {
    problems.push(`dialog: ${dialog.message()}`);
    void dialog.dismiss();
  });
  await page.addInitScript(() => {
    window.__privacyViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      // "select": WebKit's report about a <select> (see withoutSelectReports).
      window.__privacyViolations.push(`${event.effectiveDirective} ${event.blockedURI}${event.target instanceof HTMLSelectElement ? ' select' : ''}`);
    });
  });
});

/** Opens the page; returns how many requests the load itself made. */
async function open(page: Page): Promise<number> {
  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.getByRole('main')).toBeVisible();
  return watch.requests.length;
}

/** Every text of the panel, in order. */
const PANEL_TEXTS = [
  en.privacy.does.title,
  ...Object.values(en.privacy.does).filter((text) => text !== en.privacy.does.title),
  en.privacy.never.title,
  ...Object.values(en.privacy.never).filter((text) => text !== en.privacy.never.title),
  en.privacy.check.title,
  ...Object.values(en.privacy.check).filter((text) => text !== en.privacy.check.title),
  en.privacy.notes.title,
  ...Object.values(en.privacy.notes).filter((text) => text !== en.privacy.notes.title),
  en.disclaimer.text,
];

test('the panel is the first Tab stop, opens and closes with Enter and Space, and reads well', async ({ page, browserName }) => {
  const loaded = await open(page);
  const panel = page.locator('details#privacy');
  const summary = panel.locator('summary');
  const body = panel.locator('.privacy-body');

  // Closed at first, inside the header, named by its summary.
  await expect(page.getByRole('banner').locator('details#privacy')).toHaveCount(1);
  await expect(panel).not.toHaveAttribute('open', /.*/);
  await expect(body).toBeHidden();
  await expect(summary).toHaveAccessibleName(en.privacy.summary);

  // First Tab stop, with a visible outline.
  await page.keyboard.press('Tab');
  await expect(summary).toBeFocused();
  const outline = await summary.evaluate((e) => {
    const style = getComputedStyle(e);
    return { style: style.outlineStyle, width: Number.parseFloat(style.outlineWidth) };
  });
  expect(outline.style).not.toBe('none');
  expect(outline.width).toBeGreaterThanOrEqual(2);

  // Enter opens it: every text is shown, in order.
  await page.keyboard.press('Enter');
  await expect(panel).toHaveAttribute('open', '');
  await expect(body).toBeVisible();
  await expect(body.locator('h2, li, p')).toHaveText(PANEL_TEXTS);
  await expect(summary).toBeFocused();

  // Headings: one h1, the panel's h2 topics, then the three steps' h2; no level skipped.
  const headings = await page.locator('h1, h2, h3, h4, h5, h6').evaluateAll((list) =>
    list.filter((h) => h.getClientRects().length > 0).map((h) => ({ level: Number(h.tagName.slice(1)), text: h.textContent ?? '' })),
  );
  expect(headings[0]).toEqual({ level: 1, text: en.app.name });
  expect(headings.filter((h) => h.level === 1)).toHaveLength(1);
  for (let i = 1; i < headings.length; i++) expect(headings[i]?.level ?? 9).toBeLessThanOrEqual((headings[i - 1]?.level ?? 0) + 1);
  expect(headings.slice(1, 5)).toEqual(
    [en.privacy.does.title, en.privacy.never.title, en.privacy.check.title, en.privacy.notes.title].map((text) => ({ level: 2, text })),
  );
  // The panel's headings are reachable by role, like the steps'.
  await expect(page.getByRole('heading', { level: 2, name: en.privacy.check.title })).toBeVisible();

  // Readable: enough contrast, and no link (the repository link comes later).
  expect(await contrastFailures(page, '#privacy', 15)).toEqual([]);
  await expect(panel.locator('a')).toHaveCount(0);

  // The next Tab stop is still step 1's "choose" button: the panel holds no control.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: en.actions.chooseFiles })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(summary).toBeFocused();

  // Space closes it.
  await page.keyboard.press('Space');
  await expect(panel).not.toHaveAttribute('open', /.*/);
  await expect(body).toBeHidden();
  // And opens it again.
  await page.keyboard.press('Space');
  await expect(body).toBeVisible();

  // Nothing was loaded and nothing was blocked.
  expect(watch.requests.slice(loaded)).toEqual([]);
  expect(watch.websockets).toEqual([]);
  expect(withoutSelectReports(browserName, await page.evaluate(() => window.__privacyViolations))).toEqual([]);
  expect(withoutSelectConsole(browserName, problems)).toEqual([]);
});

test('the open panel fits a narrow phone screen', async ({ page, browserName }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await open(page);
  await page.locator('#privacy-summary').click();
  await expect(page.locator('.privacy-body')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(withoutSelectConsole(browserName, problems)).toEqual([]);
});

test('step 3 ends with the disclaimer, shown from the start, readable', async ({ page, browserName }) => {
  const loaded = await open(page);
  const step = page.getByRole('region', { name: `Step 3 ${en.steps.download.title}` });
  const disclaimer = step.locator('#download-disclaimer');
  await expect(disclaimer).toBeVisible();
  await expect(disclaimer).toHaveText(en.disclaimer.text);
  // The button's description is still what the button does now, not the disclaimer.
  await expect(page.getByRole('button', { name: en.actions.makePdf })).toHaveAccessibleDescription(en.download.unavailable['no-emails']);
  expect(await contrastFailures(page, '#download-disclaimer', 1)).toEqual([]);
  expect(watch.requests.slice(loaded)).toEqual([]);
  expect(withoutSelectReports(browserName, await page.evaluate(() => window.__privacyViolations))).toEqual([]);
  expect(withoutSelectConsole(browserName, problems)).toEqual([]);
});
