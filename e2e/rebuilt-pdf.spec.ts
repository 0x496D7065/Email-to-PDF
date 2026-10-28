// Browser test of the emails rebuilt from quoted text IN THE PDF (milestone
// 7, task 7.7: src/pdf/model.ts, src/ui/review.ts, src/ui/page.ts), in each
// test browser against the BUILT site served by `vite preview` (see
// playwright.config.ts), with the real pipeline and the real workers. The
// downloaded file is read back as text (tests/support/pdf-reader.ts: the
// glyphs through ToUnicode, what a reader sees).
//
// The file added is the LAST email of a synthetic thread
// (tests/fixtures/eml/13-order-4-bob-outlook-nl.eml): alone, it gives three
// rebuilt cards before its own (e2e/rebuilt.spec.ts checks the cards).
// 1. By default, the three rebuilt emails are in the PDF: the cover's count
//    and paragraph, the index marker, each one's heading, "Taken from" row
//    and fixed note; the SHA-256 of the real file only.
// 2. The switch off: none of it is in the PDF.
// 3. The email they were taken from unticked (another email added, so a
//    PDF can still be made): the cards are marked "Not in the PDF", and
//    nothing rebuilt is in the PDF (user decision Q1 (a)).
// 4. "Put everything in the PDF" ticked (user decision 2026-10-28, task
//    7.8b): its note is shown and read with it, the cards stay but are
//    marked out, the PDF holds the email whole (each quoted text once) and
//    nothing rebuilt; unticked, the earlier choices come back exactly.
// 5. That note at 320 px wide: it wraps, no sideways scrolling.
//
// Throughout (see e2e/support/watch.ts): after the page's own files, only
// the own-origin blob: URLs of the inlined workers and, at most once, the
// PDF's; no WebSocket, no CSP violation in the page or a worker, no console
// error, nothing stored. Test data is made up (README.md, rule R7).
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { en } from '../src/ui/i18n/en.ts';
import { readPageRuns, readPdf, textLines } from '../tests/support/pdf-reader.ts';
import { engineOf, watchPage, withoutSelectConsole, withoutSelectReports, workerCspReports, type Watch } from './support/watch.ts';

declare global {
  interface Window {
    __rebuiltPdfViolations: string[];
  }
}

/** Project root as a file path ("file:///C:/x/" -> "C:/x/"), as in vite.config.ts. */
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');

/** Node's Buffer (see e2e/add-files.spec.ts): what setInputFiles wants for in-memory files. */
const NodeBuffer = (globalThis as unknown as { Buffer: { from(bytes: Uint8Array): Uint8Array } }).Buffer;

/** A fixture as an in-memory file (the fixtures are 7-bit ASCII text), and its bytes. */
const fixture = (name: string): { name: string; mimeType: string; buffer: never } => ({
  name,
  mimeType: 'message/rfc822',
  buffer: NodeBuffer.from(new TextEncoder().encode(readFileSync(`${ROOT}tests/fixtures/eml/${name}`, 'utf8'))) as never,
});

const LAST = fixture('13-order-4-bob-outlook-nl.eml');
/** An email of another conversation, with nothing quoted: no rebuilt email of its own. */
const OTHER = fixture('70-no-date.eml');

const HEADING = en.pdf.document.rebuiltHeading.replace('{number}', '1');
const MARKER = en.pdf.document.rebuiltMarker;

test.use({ timezoneId: 'Africa/Lagos' });

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
    window.__rebuiltPdfViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      // "select": WebKit's report about a <select> (see withoutSelectReports).
      window.__rebuiltPdfViolations.push(`${event.effectiveDirective} ${event.blockedURI}${event.target instanceof HTMLSelectElement ? ' select' : ''}`);
    });
  });
});

const makeButton = (page: Page) => page.getByRole('button', { name: en.actions.makePdf });

/** Opens the page, adds the files and waits for the whole list (`items` cards and emails). */
async function open(page: Page, files: ReturnType<typeof fixture>[], items: number): Promise<void> {
  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.locator('#drop-zone')).toBeVisible();
  loadedAt = watch.requests.length;
  await page.locator('#file-input').setInputFiles(files);
  await expect(page.locator('#preview-list > li')).toHaveCount(items, { timeout: 30_000 });
  await expect(page.locator('#preview-list')).not.toHaveAttribute('aria-busy', /.*/);
}

/** Presses "Make the PDF" once it is available and returns the PDF's text: one string per page, lines joined by spaces. */
async function makePdfText(page: Page): Promise<string[]> {
  await expect(makeButton(page)).not.toHaveAttribute('aria-disabled', /.*/, { timeout: 60_000 });
  const next = page.waitForEvent('download', { timeout: 60_000 });
  await makeButton(page).click();
  const download = await next;
  const bytes = new Uint8Array(readFileSync(await download.path()));
  const pages = await readPageRuns(readPdf(bytes));
  return pages.map((runs) => textLines(runs).map((l) => l.shown).join(' '));
}

/** Nothing left the page but the workers and (at most `pdfs` times) the PDF, no CSP violation, no console error, nothing stored. */
async function expectNothingLeftThePage(page: Page, pdfs = 1): Promise<void> {
  await page.waitForTimeout(500);
  const ownBlob = new RegExp(`^blob:${origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/[0-9a-f-]+$`);
  const workerUrls = new Set(watch.workers.map((w) => w.url()));
  for (const url of workerUrls) expect(url).toMatch(ownBlob);
  // The PDFs' own blob: URLs (Chromium may list a blob: download as a request), nothing else.
  const others = watch.requests.slice(loadedAt).filter((url) => !workerUrls.has(url));
  expect(others.length).toBeLessThanOrEqual(pdfs);
  for (const url of others) expect(url).toMatch(ownBlob);
  expect(watch.requests.every((url) => url.startsWith('blob:') || new URL(url).origin === origin)).toBe(true);
  expect(watch.websockets).toEqual([]);
  const browserName = engineOf(page.context());
  expect(withoutSelectReports(browserName, await page.evaluate(() => window.__rebuiltPdfViolations))).toEqual([]);
  expect(workerCspReports(watch)).toEqual([]);
  expect(withoutSelectConsole(browserName, problems)).toEqual([]);
  const stored = await page.evaluate(async () => ({
    localStorage: localStorage.length,
    sessionStorage: sessionStorage.length,
    indexedDB: (await indexedDB.databases()).length,
    cookie: document.cookie,
  }));
  expect(stored).toEqual({ localStorage: 0, sessionStorage: 0, indexedDB: 0, cookie: '' });
}

test('by default the PDF holds the three rebuilt emails, marked, before the email they were taken from', async ({ page }) => {
  test.setTimeout(90_000);
  await open(page, [LAST], 4);
  await expect(page.locator('#review-rebuilt')).toHaveText('3 of 3 rebuilt emails will be in the PDF.');
  const pages = await makePdfText(page);
  const all = pages.join(' ');
  // The cover: the count and the paragraph saying what they are.
  expect(pages[0]).toContain('Emails 1 email');
  expect(pages[0]).toContain('Rebuilt emails 3 earlier emails rebuilt from quoted text');
  expect(pages[0]).toContain(en.pdf.document.rebuiltSection);
  expect(pages[0]).toContain('They are not original files.');
  // The index: three marked rows (no number), then email 1.
  expect(pages[1]!.split(MARKER)).toHaveLength(4);
  expect(pages[1]).toContain(`${MARKER} Re: Office desks and chairs`);
  // Each one: its heading, "Taken from", its note; then the real email.
  expect(all.split(HEADING)).toHaveLength(4);
  expect(all.split('Taken from email 1')).toHaveLength(4);
  expect(all).toContain(en.rebuilt.noteNoMarks.replace('{number}', '1'));
  expect(all).toContain(en.rebuilt.noteMarks.replace('{number}', '1'));
  expect(all).toMatch(/Date about 2025-03-03 \d\d:40 UTC\+01:00 As written in the quote: maandag 3 maart 2025 15:40/);
  expect(all.lastIndexOf(HEADING)).toBeLessThan(all.indexOf('Email 1 From'));
  // The SHA-256 of the real file only.
  expect(all.match(/\b[0-9a-f]{64}\b/g)).toHaveLength(1);
  await expectNothingLeftThePage(page);
});

test('the switch off: nothing rebuilt in the PDF', async ({ page }) => {
  test.setTimeout(90_000);
  await open(page, [LAST], 4);
  await page.getByRole('checkbox', { name: en.rebuilt.includeAll }).uncheck();
  await expect(page.locator('#review-rebuilt')).toHaveText('0 of 3 rebuilt emails will be in the PDF.');
  const all = (await makePdfText(page)).join(' ');
  expect(all).toContain('Email 1');
  expect(all).not.toContain(HEADING);
  expect(all).not.toContain(MARKER);
  expect(all).not.toMatch(/rebuilt/i);
  await expectNothingLeftThePage(page);
});

test('the email they were taken from unticked: the cards say so, and nothing rebuilt is in the PDF', async ({ page }) => {
  test.setTimeout(90_000);
  await open(page, [OTHER, LAST], 5);
  const source = page.locator('#preview-list > li:not(.message-rebuilt)').filter({ hasText: 'RE: Office desks and chairs' });
  await source.getByRole('checkbox', { name: en.actions.include }).uncheck();
  await expect(page.locator('#review-rebuilt')).toHaveText('0 of 3 rebuilt emails will be in the PDF.');
  const cards = page.locator('#preview-list > li.message-rebuilt');
  for (const card of await cards.all()) {
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-included', 'false');
    await expect(card.locator('.excluded-note')).toHaveText(en.rebuilt.sourceExcluded);
    // Its own tick is kept.
    await expect(card.getByRole('checkbox')).toBeChecked();
  }
  const all = (await makePdfText(page)).join(' ');
  expect(all).toContain('Email 1');
  expect(all).not.toContain('Email 2');
  expect(all).not.toContain(HEADING);
  expect(all).not.toContain(MARKER);
  expect(all).not.toContain('Office desks and chairs');
  // Ticked again: the rebuilt emails come back (the source is email 1: the undated email comes last).
  await source.getByRole('checkbox', { name: en.actions.include }).check();
  await expect(page.locator('#review-rebuilt')).toHaveText('3 of 3 rebuilt emails will be in the PDF.');
  const again = (await makePdfText(page)).join(' ');
  expect(again.split(HEADING)).toHaveLength(4);
  await expectNothingLeftThePage(page, 2);
});

test('"Put everything in the PDF" ticked: a note says why, the cards stay but are out, and the PDF holds the email whole with nothing rebuilt; unticked: back (task 7.8b)', async ({ page }) => {
  test.setTimeout(120_000);
  await open(page, [LAST], 4);
  const everything = page.getByRole('checkbox', { name: en.pdf.everything });
  const note = page.locator('#pdf-everything-note');
  // The note is always there, read with the checkbox.
  await expect(note).toBeVisible();
  await expect(note).toHaveText(en.pdf.everythingNote);
  await expect(everything).toHaveAttribute('aria-describedby', 'pdf-everything-note');
  await expect(everything).toHaveAccessibleDescription(en.pdf.everythingNote);
  const cards = page.locator('#preview-list > li.message-rebuilt');
  // One card unticked first: the state to come back to.
  await cards.first().getByRole('checkbox').uncheck();
  await expect(page.locator('#review-rebuilt')).toHaveText('2 of 3 rebuilt emails will be in the PDF.');

  await everything.check();
  await expect(page.locator('#review-rebuilt')).toHaveText('0 of 3 rebuilt emails will be in the PDF.');
  await expect(page.locator('#status')).toContainText('0 of 3 rebuilt emails will be in the PDF.');
  await expect(cards).toHaveCount(3);
  const ticks: boolean[] = [];
  for (const card of await cards.all()) {
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-included', 'false');
    const ticked = await card.getByRole('checkbox').isChecked();
    ticks.push(ticked);
    await expect(card.locator('.excluded-note')).toHaveText(ticked ? en.rebuilt.everythingExcluded : en.review.excluded);
    await expect(card.locator('.rebuilt-pdf-source')).toBeHidden();
  }
  expect(ticks).toEqual([false, true, true]);
  await expect(page.getByRole('checkbox', { name: en.rebuilt.includeAll })).toBeChecked();
  const all = (await makePdfText(page)).join(' ');
  expect(all).toContain('Email 1');
  expect(all).not.toContain(HEADING);
  expect(all).not.toContain(MARKER);
  expect(all).not.toMatch(/rebuilt/i);
  // The source email is printed whole: its quoted history (the earlier emails' text) is in, once each.
  for (const quoted of ['Wednesday at 10:00 works for me.', 'I can come by on Wednesday 5 March', 'We are furnishing a small office']) {
    expect(all.split(quoted), quoted).toHaveLength(2);
  }
  expect(all.match(/\b[0-9a-f]{64}\b/g)).toHaveLength(1);

  await everything.uncheck();
  await expect(page.locator('#review-rebuilt')).toHaveText('2 of 3 rebuilt emails will be in the PDF.');
  for (const [k, card] of (await cards.all()).entries()) {
    await expect(card.getByRole('checkbox')).toBeChecked({ checked: ticks[k]! });
    await expect(card).toHaveAttribute('data-included', ticks[k]! ? 'true' : 'false');
  }
  const again = (await makePdfText(page)).join(' ');
  expect(again.split(HEADING)).toHaveLength(3);
  expect(again).toContain('Rebuilt emails 2 earlier emails rebuilt from quoted text');
  await expectNothingLeftThePage(page, 2);
});

test('the "Put everything" note fits a 320 px wide screen and wraps, with no sideways scrolling', async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 320, height: 640 });
  await open(page, [LAST], 4);
  const note = page.locator('#pdf-everything-note');
  await expect(note).toBeVisible();
  const box = await note.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  // It wraps over several lines rather than running off the page.
  expect(box!.height).toBeGreaterThan(40);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expectNothingLeftThePage(page, 0);
});
