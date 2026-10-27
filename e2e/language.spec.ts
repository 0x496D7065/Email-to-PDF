// Browser test of the language picker and the French page (src/ui/app.ts,
// src/ui/page.ts, src/ui/i18n/fr.ts), in each test browser against the
// BUILT site served by `vite preview` (see playwright.config.ts):
//
// - in an English browser (the pinned en-US of playwright.config.ts): the
//   picker is the first Tab stop; with emails loaded, the arrow key switches
//   the page to French in place (words, <html lang>, the announcement), and
//   back to English;
// - in a French browser (a fr-FR context): the page starts in French, and
//   the PDF is made in French, with its French file name.
//
// Throughout (see e2e/support/watch.ts): after the page's own files, the
// only requests are the blob: URLs of the inlined workers and of the PDF (in
// memory, never the network), no WebSocket, no console error, no CSP
// violation in the page or a worker, and nothing stored (not the language
// either). Test data is made up (tests/fixtures/eml: invented people,
// *.test addresses).
import { readFileSync } from 'node:fs';
import { expect, test, type Download, type Page } from '@playwright/test';
import { en } from '../src/ui/i18n/en.ts';
import { fr } from '../src/ui/i18n/fr.ts';
import { readOutline, readPdf } from '../tests/support/pdf-reader.ts';
import { contrastFailures } from './support/contrast.ts';
import {
  engineOf,
  untoleratedReports,
  watchPage,
  withoutSelectConsole,
  withoutSelectReports,
  workerCspReports,
  workersNamed,
  type Watch,
} from './support/watch.ts';

declare global {
  interface Window {
    __languageViolations: string[];
  }
}

/** Project root as a file path ("file:///C:/x/" -> "C:/x/"), as in vite.config.ts. */
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
/** Node's Buffer (see e2e/add-files.spec.ts): what setInputFiles wants for in-memory files. */
const NodeBuffer = (globalThis as unknown as { Buffer: { from(bytes: Uint8Array): Uint8Array } }).Buffer;

type InputFile = { name: string; mimeType: string; buffer: never };

/** A fixture as an in-memory file (the fixtures are 7-bit ASCII text). */
const fixture = (name: string): InputFile => ({
  name,
  mimeType: 'message/rfc822',
  buffer: NodeBuffer.from(new TextEncoder().encode(readFileSync(`${ROOT}tests/fixtures/eml/${name}`, 'utf8'))) as never,
});

// A thread of three emails (with quoted history to fold) and one without a date.
const FILES = [fixture('10-order-1-alice.eml'), fixture('11-order-2-bob-outlook-en.eml'), fixture('12-order-3-alice-gmail.eml'), fixture('70-no-date.eml')];

// Fixed zone and clock, so the PDF's file name is known: 2025-06-01 20:00 UTC = 2025-06-02 in Tokyo.
const ZONE = 'Asia/Tokyo';
test.use({ timezoneId: ZONE });
const FIXED_NOW = new Date('2025-06-01T20:00:00Z');

let origin = '';
let watch: Watch;
let loadedAt = 0;
let problems: string[] = [];
let downloads: Download[] = [];

test.beforeEach(async ({ context, page, baseURL }) => {
  origin = new URL(baseURL ?? '').origin;
  problems = [];
  downloads = [];
  watch = await watchPage(context, page, origin);
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('dialog', (dialog) => {
    problems.push(`dialog: ${dialog.message()}`);
    void dialog.dismiss();
  });
  page.on('download', (download) => downloads.push(download));
  await page.addInitScript(() => {
    window.__languageViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      // "select": WebKit's report about a <select> (see withoutSelectReports).
      const where = event.target === document ? 'parse' : event.target instanceof HTMLSelectElement ? 'select' : 'live';
      window.__languageViolations.push(`${event.effectiveDirective} ${event.blockedURI} ${where}`);
    });
  });
});

async function open(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.locator('#drop-zone')).toBeVisible();
  loadedAt = watch.requests.length;
}

/** Adds the files and waits until the list and its PDF plans are ready (the button is available). */
async function addFiles(page: Page): Promise<void> {
  await page.locator('#file-input').setInputFiles([...FILES]);
  await expect(page.locator('#preview-list > li')).toHaveCount(FILES.length, { timeout: 60_000 });
  await expect(page.locator('#preview-list')).not.toHaveAttribute('aria-busy', /.*/, { timeout: 60_000 });
  await expect(page.locator('#download-button')).not.toHaveAttribute('aria-disabled', /.*/, { timeout: 60_000 });
}

/** "{count} files added." and the like, for a count other than 0 or 1 (French plural "other"). */
const many = (text: string, count: number): string => text.replace('{count}', String(count));

/**
 * Once everything has settled: only blob: requests after the page's files,
 * no WebSocket, no CSP violation, every worker a known one that ended, no
 * console error or dialog, nothing stored (the language neither).
 */
async function expectNothingLeftThePage(page: Page): Promise<void> {
  await page.waitForTimeout(500);
  const ownBlob = new RegExp(`^blob:${origin}/[0-9a-f-]+$`);
  for (const url of watch.requests.slice(loadedAt)) expect(url).toMatch(ownBlob);
  expect(watch.requests.every((url) => url.startsWith('blob:') || new URL(url).origin === origin)).toBe(true);
  expect(watch.websockets).toEqual([]);
  const browserName = engineOf(page.context());
  const violations = withoutSelectReports(browserName, await page.evaluate(() => window.__languageViolations));
  expect(untoleratedReports(browserName, violations)).toEqual([]);
  expect(workerCspReports(watch)).toEqual([]);
  const named = (['parse-worker', 'engine-worker', 'pdf-worker'] as const).reduce((sum, name) => sum + workersNamed(watch, watch.workers, name).length, 0);
  expect(named).toBe(watch.workers.length);
  await expect.poll(() => watch.closedWorkers.length).toBe(watch.workers.length);
  expect(withoutSelectConsole(browserName, problems)).toEqual([]);
  const stored = await page.evaluate(async () => ({
    localStorage: localStorage.length,
    sessionStorage: sessionStorage.length,
    indexedDB: (await indexedDB.databases()).length,
    caches: (await caches.keys()).length,
    cookie: document.cookie,
  }));
  expect(stored).toEqual({ localStorage: 0, sessionStorage: 0, indexedDB: 0, caches: 0, cookie: '' });
}

test('English browser: the picker is the first Tab stop; the arrow keys switch to French with emails loaded, and back', async ({ page }) => {
  test.setTimeout(120_000);
  await open(page);
  await addFiles(page);
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  // The picker: a group named "Language", English ticked, each name in its own language.
  const picker = page.getByRole('group', { name: en.language.label });
  await expect(picker).toBeVisible();
  // By id: the group's own name changes with the language.
  const english = page.locator('#lang-en');
  const french = page.locator('#lang-fr');
  await expect(english).toHaveAccessibleName('English');
  await expect(french).toHaveAccessibleName('Fran\u00e7ais');
  await expect(english).toBeChecked();
  await expect(french).not.toBeChecked();
  // The shipped languages only: the test-only one (tests/support/test-locale.ts) is never bundled.
  await expect(picker.getByRole('radio')).toHaveCount(2);
  await expect(page.locator('#lang-xx')).toHaveCount(0);
  await expect(page.locator('label[for="lang-fr"]')).toHaveAttribute('lang', 'fr');
  await expect(french).toHaveAttribute('lang', 'fr');
  expect(await contrastFailures(page, '#language', 3)).toEqual([]);

  // The keyboard reaches the picker first (its ticked radio); an arrow key picks French.
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('Tab');
  await expect(english).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(french).toBeChecked();
  await expect(french).toBeFocused();

  // The page is in French: its language, headings, summary, buttons, labels and the announcement.
  await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
  await expect(page).toHaveTitle(en.app.name);
  await expect(page.getByRole('status')).toHaveText(fr.language.changed);
  await expect(page.getByRole('main').getByRole('heading', { level: 2 })).toHaveText(
    [fr.steps.add.title, fr.steps.check.title, fr.steps.download.title].map((title, i) => `\u00c9tape ${String(i + 1)} ${title}`),
  );
  await expect(page.locator('#add-summary-text')).toHaveText(`${many(fr.added.files.other, 4)} ${many(fr.added.messages.other, 4)}`);
  await expect(page.getByRole('group', { name: fr.language.label })).toBeVisible();
  await expect(page.getByRole('button', { name: fr.actions.makePdf })).toHaveAccessibleDescription(fr.download.available);
  await expect(page.getByRole('button', { name: fr.actions.clearEverything })).toBeVisible();
  await expect(page.locator('#privacy-summary')).toHaveText(fr.privacy.summary);
  await expect(page.locator('#preview-list .pdf-label:visible').filter({ hasText: /^Pas dans le PDF\u00a0: / }).first()).toBeVisible();
  await expect(page.getByRole('main')).not.toContainText(en.steps.add.title);

  // Back to English with the other arrow key: the same page, nothing rebuilt or lost.
  await page.keyboard.press('ArrowLeft');
  await expect(english).toBeChecked();
  await expect(english).toBeFocused();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('status')).toHaveText(en.language.changed);
  await expect(page.locator('#add-summary-text')).toHaveText('4 files added. 4 emails found.');
  await expect(page.locator('#preview-list > li')).toHaveCount(FILES.length);

  await expectNothingLeftThePage(page);
});

test.describe('French browser', () => {
  test.use({ locale: 'fr-FR' });

  test('starts in French and makes the PDF in French, named correspondance-YYYY-MM-DD.pdf', async ({ page }) => {
    test.setTimeout(120_000);
    await page.clock.setFixedTime(FIXED_NOW);
    await open(page);

    await expect(page.locator('html')).toHaveAttribute('lang', 'fr');
    await expect(page).toHaveTitle(en.app.name);
    const french = page.getByRole('radio', { name: 'Fran\u00e7ais' });
    await expect(french).toBeChecked();
    await expect(page.getByRole('radio', { name: 'English' })).not.toBeChecked();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(en.app.name);
    await expect(page.getByRole('banner')).toContainText(fr.app.promise);
    await expect(page.locator('#download-note')).toHaveText(fr.download.unavailable['no-emails']);
    // The first Tab stop is the ticked radio: French here.
    await page.keyboard.press('Tab');
    await expect(french).toBeFocused();

    await addFiles(page);
    const fileName = 'correspondance-2025-06-02.pdf';
    const first = page.waitForEvent('download');
    await page.getByRole('button', { name: fr.actions.makePdf }).focus();
    await page.keyboard.press('Enter');
    const download = await first;
    expect(download.suggestedFilename()).toBe(fileName);
    const status = (await page.getByRole('status').textContent()) ?? '';
    expect(status).toMatch(new RegExp(`^Votre PDF est pr\u00eat\u00a0: ${fileName.replaceAll('.', '\\.')}, \\d+ pages\\. Le t\u00e9l\u00e9chargement a commenc\u00e9\\.$`));
    await expect(page.locator('#download-link')).toHaveText(`T\u00e9l\u00e9charger de nouveau\u00a0: ${fileName}`);

    // The PDF's own words are French too.
    const pdf = readPdf(new Uint8Array(readFileSync(await download.path())));
    const titles = (readOutline(pdf)?.items ?? []).map((item) => item.title);
    expect(titles[0]).toBe(fr.pdf.document.coverBookmark);
    // One bookmark per email ("3. 2025-03-04, Alice Example : ..."), the undated one with the French "no date" text.
    expect(titles.filter((title) => /^\d+\. /.test(title))).toHaveLength(FILES.length);
    expect(titles.some((title) => title.includes(fr.preview.noDate))).toBe(true);
    expect(downloads).toHaveLength(1);
    expect(workersNamed(watch, watch.workers, 'pdf-worker')).toHaveLength(1);

    await expectNothingLeftThePage(page);
  });
});
