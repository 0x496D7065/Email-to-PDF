// Browser test of "Clear everything" and of "nothing is kept"
// (src/ui/page.ts; README.md, rules R1, R2, R5 and R6), in Chromium against
// the BUILT site served by `vite preview` (see playwright.config.ts). The
// real pipeline runs on synthetic fixtures from tests/fixtures/eml, plus a
// large batch of made-up emails built in this file (invented names,
// example.test addresses).
//
// Every test also checks, once everything has settled, that nothing left the
// page (only the inlined workers' blob: URLs), that there was no CSP
// violation (page or worker) and no console error. See e2e/support/watch.ts.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { en } from '../src/ui/i18n/en.ts';
import { contrastFailures } from './support/contrast.ts';
import { watchPage, workerCspReports, workersNamed, type Watch } from './support/watch.ts';

declare global {
  interface Window {
    __clearViolations: string[];
  }
}

/** Project root as a file path ("file:///C:/x/" -> "C:/x/"), as in vite.config.ts. */
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');

/** Node's Buffer (see e2e/add-files.spec.ts): what setInputFiles wants for in-memory files. */
const NodeBuffer = (globalThis as unknown as { Buffer: { from(bytes: Uint8Array): Uint8Array } }).Buffer;

type InputFile = { name: string; mimeType: string; buffer: never };

const textFile = (name: string, text: string, mimeType = 'message/rfc822'): InputFile => ({
  name,
  mimeType,
  buffer: NodeBuffer.from(new TextEncoder().encode(text)) as never,
});

/** A fixture as an in-memory file (the fixtures are 7-bit ASCII text). */
const fixture = (name: string): InputFile => textFile(name, readFileSync(`${ROOT}tests/fixtures/eml/${name}`, 'utf8'));

// 7 email files (one is an identical copy of another) and one file that is not an email.
const FILES = [
  fixture('13-order-4-bob-outlook-nl.eml'),
  fixture('70-no-date.eml'),
  fixture('10-order-1-alice.eml'),
  fixture('30-dup-order-2-copy.eml'),
  fixture('60-attachment.eml'),
  fixture('12-order-3-alice-gmail.eml'),
  fixture('11-order-2-bob-outlook-en.eml'),
  textFile('notes.txt', 'Order notes, not an email.', 'text/plain'),
];

/** One made-up email of the large batch. */
function syntheticEmail(i: number): InputFile {
  const n = String(i);
  const minute = String(i % 60).padStart(2, '0');
  const hour = String(8 + Math.floor(i / 60) % 10).padStart(2, '0');
  const text = [
    'From: Garden Club Example <club@example.test>',
    `To: Member ${n} <member${n}@example.test>`,
    `Subject: Bench painting slot ${n}`,
    `Date: Mon, 3 Mar 2025 ${hour}:${minute}:00 +0000`,
    `Message-ID: <bench-slot-${n}@example.test>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    `Hello member ${n},`,
    '',
    `Your bench painting slot number ${n} is on Saturday morning.`,
    '',
    'Garden Club Example',
    '',
  ].join('\r\n');
  return textFile(`bench-slot-${n}.eml`, text);
}

/** A batch large enough to take several seconds (one parse worker per file). */
const LARGE_BATCH = Array.from({ length: 300 }, (_, i) => syntheticEmail(i + 1));

test.use({ timezoneId: 'America/New_York' });

let origin = '';
let watch: Watch;
let loadedAt = 0;
let problems: string[] = [];

test.beforeEach(async ({ context, page, baseURL }) => {
  origin = new URL(baseURL ?? '').origin;
  problems = [];
  watch = await watchPage(context, page, origin);
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  await page.addInitScript(() => {
    window.__clearViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__clearViolations.push(`${event.effectiveDirective} ${event.blockedURI}`);
    });
  });
});

async function open(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.locator('#drop-zone')).toBeVisible();
  loadedAt = watch.requests.length;
}

/** Adds the fixtures and waits for the whole list. */
async function addFixtures(page: Page): Promise<void> {
  await page.locator('#file-input').setInputFiles(FILES);
  await expect(page.locator('#add-summary-text')).toHaveText('8 files added. 1 could not be read. 7 emails found. 1 identical copy merged.', {
    timeout: 30_000,
  });
  await expect(page.locator('#preview-list > li')).toHaveCount(6);
  await expect(page.locator('#preview-list')).not.toHaveAttribute('aria-busy', /.*/);
}

/** What the browser keeps for this site: must be nothing at all (README.md, rule R5). */
async function storedState(page: Page) {
  return page.evaluate(async () => ({
    localStorage: localStorage.length,
    sessionStorage: sessionStorage.length,
    indexedDB: (await indexedDB.databases()).map((d) => d.name ?? ''),
    caches: await caches.keys(),
    cookie: document.cookie,
  }));
}
const NOTHING_STORED = { localStorage: 0, sessionStorage: 0, indexedDB: [], caches: [], cookie: '' };

/** The page's whole text and every form field's value (the file input's too, with its file count). */
async function pageTextAndValues(page: Page): Promise<{ text: string; values: string[]; chosenFiles: number }> {
  return page.evaluate(() => {
    const fields = [...document.querySelectorAll('input, select, textarea')] as (HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement)[];
    const fileInput = document.querySelector<HTMLInputElement>('#file-input');
    return {
      text: document.body.textContent ?? '',
      values: fields.map((f) => f.value),
      chosenFiles: fileInput?.files?.length ?? -1,
    };
  });
}

/** The page shows no email and nothing about one; "Clear everything" is unavailable. */
async function expectEmptyApp(page: Page): Promise<void> {
  await expect(page.locator('#preview-list > li')).toHaveCount(0);
  await expect(page.locator('#check-area')).toBeHidden();
  await expect(page.locator('#check-waiting')).toBeVisible();
  await expect(page.locator('#add-summary')).toBeHidden();
  await expect(page.locator('#add-failed-list > li')).toHaveCount(0);
  await expect(page.locator('#add-progress')).toBeHidden();
  for (const id of ['review-files-text', 'review-messages', 'review-included', 'review-notes']) await expect(page.locator(`#${id}`)).toHaveText('');
  await expect(page.locator('#clear-everything')).toHaveAttribute('aria-disabled', 'true');
}

/** Nothing left the page, no CSP violation, no console error (see e2e/review.spec.ts). */
async function expectNothingLeftThePage(page: Page): Promise<void> {
  await page.waitForTimeout(500);
  const workerUrls = new Set(watch.workers.map((w) => w.url()));
  for (const url of workerUrls) expect(url).toMatch(new RegExp(`^blob:${origin}/[0-9a-f-]+$`));
  expect(watch.requests.slice(loadedAt).filter((url) => !workerUrls.has(url))).toEqual([]);
  expect(watch.requests.every((url) => new URL(url).origin === origin)).toBe(true);
  expect(watch.websockets).toEqual([]);
  expect(await page.evaluate(() => window.__clearViolations)).toEqual([]);
  expect(workerCspReports(watch)).toEqual([]);
  expect(problems).toEqual([]);
}

test('"Clear everything" is there from the start, unavailable but focusable and explained', async ({ page }) => {
  await open(page);
  const clear = page.getByRole('button', { name: en.actions.clearEverything });
  await expect(clear).toBeVisible();
  await expect(clear).toHaveAttribute('aria-disabled', 'true');
  await expect(clear).toBeDisabled(); // as assistive technology sees it...
  await expect(clear).toHaveAccessibleDescription(en.clear.note);
  // ...yet reachable with Tab, right after the "choose" button, and pressing it does nothing.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: en.actions.chooseFiles })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(clear).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toHaveText('');
  await page.keyboard.press('Space');
  await expect(page.getByRole('status')).toHaveText('');
  await expect(clear).toBeFocused();
  await expect(clear).toHaveAttribute('aria-disabled', 'true');
  await expectNothingLeftThePage(page);
});

test('after adding files, Clear removes every email text, file name and count; adding again works', async ({ page }) => {
  test.setTimeout(90_000);
  await open(page);
  expect(await storedState(page)).toEqual(NOTHING_STORED);
  await addFixtures(page);

  // Some choices: one email unticked, folded text shown, another zone.
  const items = page.locator('#preview-list > li');
  await items.nth(1).getByRole('checkbox', { name: en.actions.include }).uncheck();
  await page.getByLabel(en.preview.showFolded).check();
  const zone = page.getByLabel(en.preview.zone);
  const homeZone = await zone.inputValue();
  expect(homeZone).toBe('America/New_York');
  await zone.selectOption('Asia/Tokyo');

  // The texts that must disappear: every subject, a piece of every shown and
  // folded text block, every attachment line and every file name.
  const subjects = await page.locator('#preview-list .message-subject').allTextContents();
  const bodies = (await page.locator('#preview-list .body-text').allTextContents()).map((b) => b.trim().slice(0, 40)).filter((b) => b !== '');
  const attachments = await page.locator('#preview-list .attachment').allTextContents();
  const fileNames = FILES.map((f) => f.name);
  expect(subjects.length).toBeGreaterThanOrEqual(5);
  expect(bodies.length).toBeGreaterThanOrEqual(6);
  // File names shown before: the failed file, and the merged copy's (under "Also in").
  const alsoIn = await page.locator('#preview-list dd.meta-also-in').allTextContents();
  expect(alsoIn).toHaveLength(1);
  expect(['11-order-2-bob-outlook-en.eml', '30-dup-order-2-copy.eml']).toContain(alsoIn[0]);
  const before = await pageTextAndValues(page);
  const secret = [...subjects, ...bodies, ...attachments, ...alsoIn, 'notes.txt'];
  for (const text of secret) expect(before.text).toContain(text);

  const clear = page.getByRole('button', { name: en.actions.clearEverything });
  await expect(clear).not.toHaveAttribute('aria-disabled', /.*/);
  // The available button (and step 1 with its summary) meet the contrast rules.
  expect(await contrastFailures(page, '#step-add', 6)).toEqual([]);
  await clear.click();

  await expect(page.getByRole('status')).toHaveText(en.clear.done);
  await expect(page.getByRole('button', { name: en.actions.chooseFiles })).toBeFocused();
  await expectEmptyApp(page);
  const after = await pageTextAndValues(page);
  for (const text of [...secret, ...fileNames]) expect(after.text).not.toContain(text);
  for (const value of after.values) for (const text of [...secret, ...fileNames]) expect(value).not.toContain(text);
  expect(after.chosenFiles).toBe(0);
  await expect(page.locator('#file-input')).toHaveValue('');
  // The toolbar is back to its defaults.
  await expect(zone).toHaveValue(homeZone);
  await expect(page.getByLabel(en.preview.showFolded)).not.toBeChecked();
  expect(await contrastFailures(page, '#step-add', 6)).toEqual([]);

  // Adding the same files again works, with every email included again.
  await addFixtures(page);
  await expect(page.locator('#review-included')).toHaveText('6 of 6 emails will be in the PDF.');
  await expect(page.locator('#preview-list > li[data-included="false"]')).toHaveCount(0);
  await expect(clear).not.toHaveAttribute('aria-disabled', /.*/);

  expect(await storedState(page)).toEqual(NOTHING_STORED);
  await expectNothingLeftThePage(page);
});

test('Clear while a large batch is being read: the reading stops, its workers end, and the page stays empty', async ({ page }) => {
  test.setTimeout(180_000);
  await open(page);
  await page.locator('#file-input').setInputFiles(LARGE_BATCH);
  // Well into the batch (several files read), but far from its end.
  await expect(page.locator('#add-progress-label')).toHaveText(/^Reading file ([5-9]|\d\d) of 300\.\.\.$/, { timeout: 60_000 });
  const clear = page.getByRole('button', { name: en.actions.clearEverything });
  await clear.click();
  const startedAtClear = watch.workers.length;

  await expect(page.getByRole('status')).toHaveText(en.clear.done);
  await expect(page.getByRole('button', { name: en.actions.chooseFiles })).toBeFocused();
  await expectEmptyApp(page);

  // Every worker started so far ends (the running one is terminated), and no
  // new one starts: the batch really stopped.
  await expect.poll(() => watch.closedWorkers.length, { timeout: 10_000 }).toBe(watch.workers.length);
  await page.waitForTimeout(5_000);
  expect(watch.workers.length).toBeLessThanOrEqual(startedAtClear + 1);
  expect(workersNamed(watch, watch.workers, 'engine-worker')).toEqual([]);
  expect(watch.closedWorkers.length).toBe(watch.workers.length);

  // Still empty, and still nothing about the batch anywhere.
  await expectEmptyApp(page);
  await expect(page.getByRole('status')).toHaveText(en.clear.done);
  const after = await pageTextAndValues(page);
  expect(after.text).not.toMatch(/Bench painting slot|bench-slot-|member\d+@example\.test|Reading file/);
  expect(after.chosenFiles).toBe(0);

  // The page still works: a small batch is read normally.
  await addFixtures(page);
  expect(await storedState(page)).toEqual(NOTHING_STORED);
  await expectNothingLeftThePage(page);
});

test('reloading after adding files shows an empty app: nothing was kept', async ({ page }) => {
  test.setTimeout(90_000);
  await open(page);
  expect(await storedState(page)).toEqual(NOTHING_STORED);
  await addFixtures(page);
  expect(await storedState(page)).toEqual(NOTHING_STORED);

  await page.reload({ waitUntil: 'networkidle' });
  // The reload fetches the page's own files again: only those, from this site.
  loadedAt = watch.requests.length;
  await expect(page.locator('#drop-zone')).toBeVisible();
  await expectEmptyApp(page);
  await expect(page.getByRole('status')).toHaveText('');
  const after = await pageTextAndValues(page);
  for (const name of FILES.map((f) => f.name)) expect(after.text).not.toContain(name);
  expect(after.text).not.toContain('Office desks');
  expect(after.chosenFiles).toBe(0);
  expect(await storedState(page)).toEqual(NOTHING_STORED);
  await expectNothingLeftThePage(page);
});
