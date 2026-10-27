// Browser test of the whole journey, end to end (README.md, rules R1, R2,
// R4, R5 and R6), in each test browser against the BUILT site served by
// `vite preview` (see playwright.config.ts). The other specs check each part
// on its own; this one runs them one after the other, the way a user does:
//
// 1. "the whole journey": EVERY synthetic fixture (each .eml of
//    tests/fixtures/eml and each .msg built from tests/fixtures/msg/specs.ts,
//    among them the HTML-only .msg "msg-13-html-only") is dropped on step 1
//    with a real DataTransfer and the drag events a browser fires. Then:
//    counts, date order, the HTML-only .msg shown as plain text, a folded
//    quote, the time zone, an unticked email, the notes of an undated email,
//    and finally "Clear everything". The expected values come from the
//    fixture manifest (tests/fixtures/manifest.ts), not from the app.
// 2. "keyboard only": from page load, every control is reached and operated
//    with Tab, Shift+Tab, Enter and Space only, with a visible focus outline
//    on each, in the order the steps are shown; every control has a name and
//    the heading levels do not skip.
//
// Throughout both tests (see e2e/support/watch.ts): no request after the
// page's own files other than the inlined workers' blob: URLs, no WebSocket,
// no console error, no dialog, every worker a parse or engine worker that
// ended. CSP: no violation in any worker. In the page, the only reports
// tolerated are those Chromium makes while DOMParser PARSES email HTML with
// inline handlers or <style> blocks (nothing runs or loads;
// e2e/html-to-text.spec.ts proves it with and without the CSP). Such a
// report has blockedURI "inline" and is fired at the document itself,
// because the parsed element is in no live page. The same directive fired at
// an element means an inline handler or style in the LIVE page, and fails
// the test, as does every other report (a blocked load, such as img-src, is
// fired at the document wherever it happens, so it is never tolerated). Each
// record is "directive blockedURI parse|live" ("parse": fired at the
// document). The console line Chromium writes for each
// tolerated report is tolerated too, never more lines than reports. Here, an
// email script or handler that ran would also change the page title or open
// a dialog, and both are checked.
//
// No accessibility library (such as axe-core) is used, to avoid a new
// dependency: names, focus outlines, order and headings are checked here.
//
// Test data is made up: the fixtures (README.md, rule R7: invented names,
// *.test / *.invalid domains).
import { readFileSync } from 'node:fs';
import { expect, test, type FileChooser, type Page } from '@playwright/test';
import { createServer } from 'vite';
import { en } from '../src/ui/i18n/en.ts';
import { FIXTURES, type FixtureExpectation } from '../tests/fixtures/manifest.ts';
import type * as Builder from '../tests/fixtures/msg/builder.ts';
import type * as Specs from '../tests/fixtures/msg/specs.ts';
import {
  engineOf,
  isParseTimeReport,
  PARSE_TIME_CONSOLE,
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
    __flowViolations: string[];
  }
}

/** Project root as a file path ("file:///C:/x/" -> "C:/x/"), as in vite.config.ts. */
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');

/**
 * The HTML-only .msg of the fixture set (no plain-text body): its text must
 * come from the inert converter, shown as plain text, with nothing in it run
 * or loaded (README.md, rule R4).
 */
const HTML_ONLY = ((): FixtureExpectation => {
  const f = FIXTURES.find((x) => x.id === 'msg-13-html-only');
  if (f === undefined) throw new Error('no fixture msg-13-html-only');
  return f;
})();
/** What its item must show (the manifest's snippets, and the sign-off) and must never show, on top of the manifest's exclusions. */
const HTML_ONLY_SHOWS = [...HTML_ONLY.bodyContains, 'Carol'];
const HTML_ONLY_NEVER = [...(HTML_ONLY.bodyExcludes ?? []), 'RAN', 'invalid', '<'];

/** One file to drop: its name, type and bytes (plain numbers: they cross into the page as JSON). */
interface DropFile {
  readonly name: string;
  readonly type: string;
  readonly bytes: number[];
}

/** One fixture, as the test expects it in the list. */
interface Expected {
  readonly id: string;
  readonly fileName: string;
  readonly utcMs: number | null;
  readonly subject: string;
  readonly group: string;
}

/** Built in beforeAll: every fixture as a file, in a shuffled (fixed) order. */
let dropFiles: DropFile[] = [];
let expected: Expected[] = [];

/** File name of a fixture in the drop: the .eml's own name, "<spec id>.msg" for a .msg. */
const fileNameOf = (f: Pick<FixtureExpectation, 'id' | 'kind'>): string => (f.kind === 'eml' ? f.id.slice('eml/'.length) : `${f.id}.msg`);

test.beforeAll(async () => {
  // The .msg builder needs Vite's module loader (see e2e/add-files.spec.ts):
  // middleware mode opens no port and serves nothing.
  const server = await createServer({
    root: ROOT,
    configFile: `${ROOT}vite.config.ts`,
    logLevel: 'warn',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false },
  });
  const files: DropFile[] = [];
  try {
    const { buildMsg } = (await server.ssrLoadModule('/tests/fixtures/msg/builder.ts')) as typeof Builder;
    const { MSG_SPECS } = (await server.ssrLoadModule('/tests/fixtures/msg/specs.ts')) as typeof Specs;
    for (const f of FIXTURES) {
      const name = fileNameOf(f);
      if (f.kind === 'eml') {
        // The fixtures are 7-bit ASCII text.
        files.push({ name, type: 'message/rfc822', bytes: Array.from(new TextEncoder().encode(readFileSync(`${ROOT}tests/fixtures/${f.id}`, 'utf8'))) });
      } else {
        const spec = MSG_SPECS.find((s) => s.id === f.id);
        if (spec === undefined) throw new Error(`no .msg spec ${f.id}`);
        files.push({ name, type: 'application/vnd.ms-outlook', bytes: Array.from(buildMsg(spec)) });
      }
    }
  } finally {
    await server.close();
  }
  // A fixed shuffle (every 7th file, wrapping round): the drop order is far
  // from both the manifest order and the date order.
  dropFiles = files.map((_, i) => files[(i * 7) % files.length]).filter((f): f is DropFile => f !== undefined);
  expect(new Set(dropFiles.map((f) => f.name)).size).toBe(files.length);

  expected = FIXTURES.map((f) => ({
    id: f.id,
    fileName: fileNameOf(f),
    utcMs: f.date.utcMs,
    subject: f.subject === null || f.subject.trim() === '' ? en.preview.noSubject : f.subject,
    group: f.duplicateGroup ?? f.id,
  }));
});

/**
 * The list the page must show: one email per duplicate group, by date, the
 * undated ones last in the order their files were dropped. Throws if two
 * different emails share a date: their order would not be known here.
 */
function expectedList(): Expected[] {
  const kept = new Map<string, Expected>();
  for (const e of expected) if (!kept.has(e.group)) kept.set(e.group, e);
  const list = [...kept.values()];
  const dated = list.filter((e) => e.utcMs !== null).sort((a, b) => (a.utcMs ?? 0) - (b.utcMs ?? 0));
  for (let i = 1; i < dated.length; i++) if (dated[i]?.utcMs === dated[i - 1]?.utcMs) throw new Error(`same date: ${dated[i]?.id ?? ''}`);
  const dropIndex = (e: Expected): number => dropFiles.findIndex((f) => f.name === e.fileName);
  const undated = list.filter((e) => e.utcMs === null).sort((a, b) => dropIndex(a) - dropIndex(b));
  return [...dated, ...undated];
}

/** "2025-03-03 08:15:00 UTC+00:00" shifted by `offsetMinutes`, as the preview writes a date. */
function dateText(utcMs: number, offsetMinutes: number): string {
  const shifted = new Date(utcMs + offsetMinutes * 60_000).toISOString();
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const offset = `${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${shifted.slice(0, 10)} ${shifted.slice(11, 19)} UTC${sign}${offset}`;
}

// A zone with a half-hour offset and no daylight saving time, so the dates
// shown at first are known and differ from every fixture's own zone.
const BROWSER_ZONE = 'Australia/Darwin';
const BROWSER_OFFSET = 570;
test.use({ timezoneId: BROWSER_ZONE });

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
  page.on('dialog', (dialog) => {
    problems.push(`dialog: ${dialog.message()}`);
    void dialog.dismiss();
  });
  page.on('download', (download) => problems.push(`download: ${download.suggestedFilename()}`));
  await page.addInitScript(() => {
    window.__flowViolations = [];
    // An inline report made while DOMParser parses is fired at the document;
    // an inline one about the live page at the element concerned (see the top).
    document.addEventListener('securitypolicyviolation', (event) => {
      // "select": WebKit's report about a <select> (see withoutSelectReports).
      const where = event.target === document ? 'parse' : event.target instanceof HTMLSelectElement ? 'select' : 'live';
      window.__flowViolations.push(`${event.effectiveDirective} ${event.blockedURI} ${where}`);
    });
  });
});

async function open(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.locator('#drop-zone')).toBeVisible();
  loadedAt = watch.requests.length;
}

/**
 * Drops `files` on the element at `selector` the way a browser does: a
 * DataTransfer made in the page holds the files, and dragenter, dragover and
 * drop are dispatched on the element (bubbling to the page-wide listeners).
 * Returns whether each event's default action (opening the file) was cancelled.
 */
async function drop(page: Page, selector: string, files: readonly DropFile[]): Promise<boolean[]> {
  const data = await page.evaluateHandle((list) => {
    const transfer = new DataTransfer();
    for (const f of list) transfer.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: f.type }));
    return transfer;
  }, files);
  return page.evaluate(
    ({ transfer, target }) => {
      const element = document.querySelector(target);
      if (!element) throw new Error(`no ${target}`);
      return ['dragenter', 'dragover', 'drop'].map(
        (type) => !element.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer })),
      );
    },
    { transfer: data, target: selector },
  );
}

/** The page's whole text, every form field's value and the whole page markup (attributes included). */
async function pageTextAndValues(page: Page): Promise<{ text: string; values: string[]; html: string }> {
  return page.evaluate(() => ({
    text: document.body.textContent ?? '',
    values: [...document.querySelectorAll('input, select, textarea')].map((f) => (f as HTMLInputElement).value),
    html: document.documentElement.outerHTML,
  }));
}

/**
 * Once everything has settled: nothing left the page, no WebSocket, no CSP
 * violation (beyond DOMParser's parse-time reports, fired at the document,
 * see the top of this file), every worker a parse or engine worker that ended, no console error,
 * no dialog, no download, and no script from an email ran.
 */
async function expectNothingLeftThePage(page: Page): Promise<void> {
  await page.waitForTimeout(1000);
  const workerUrls = new Set(watch.workers.map((w) => w.url()));
  for (const url of workerUrls) expect(url).toMatch(new RegExp(`^blob:${origin}/[0-9a-f-]+$`));
  expect(watch.requests.slice(loadedAt).filter((url) => !workerUrls.has(url))).toEqual([]);
  expect(watch.requests.every((url) => new URL(url).origin === origin)).toBe(true);
  expect(watch.websockets).toEqual([]);
  const browserName = engineOf(page.context());
  const violations = withoutSelectReports(browserName, await page.evaluate(() => window.__flowViolations));
  expect(untoleratedReports(browserName, violations)).toEqual([]);
  expect(workerCspReports(watch)).toEqual([]);
  const named = workersNamed(watch, watch.workers, 'parse-worker').length + workersNamed(watch, watch.workers, 'engine-worker').length;
  expect(named).toBe(watch.workers.length);
  await expect.poll(() => watch.closedWorkers.length).toBe(watch.workers.length);
  const directives = violations.filter(isParseTimeReport).map((v) => v.split(' ')[0] ?? '');
  const consoleProblems = withoutSelectConsole(browserName, problems);
  for (const known of PARSE_TIME_CONSOLE) {
    const lines = consoleProblems.filter((p) => known.line.test(p)).length;
    expect(lines).toBeLessThanOrEqual(directives.filter((d) => known.directives.includes(d)).length);
  }
  expect(consoleProblems.filter((p) => !PARSE_TIME_CONSOLE.some((known) => known.line.test(p)))).toEqual([]);
  expect(await page.title()).toBe(en.app.name);
}

test('the whole journey: drop every fixture, check the list, change the choices, clear everything', async ({ page }) => {
  test.setTimeout(180_000);
  await open(page);
  const url = page.url();
  const list = expectedList();
  const filesTotal = dropFiles.length;
  const merged = filesTotal - list.length;
  expect(merged).toBeGreaterThan(0);

  // --- A drop next to the zone adds nothing and opens nothing. -------------
  const [first] = dropFiles;
  if (first === undefined) throw new Error('no files');
  expect(await drop(page, '#step-check', [first])).toEqual([true, true, true]);
  await expect(page.getByRole('status')).toHaveText(en.drop.outside);
  await page.waitForTimeout(300);
  expect(page.url()).toBe(url);
  await expect(page.locator('#check-area')).toBeHidden();
  expect(watch.workers).toHaveLength(0);

  // --- Every fixture, dropped on the zone. ----------------------------------
  expect(await drop(page, '#drop-zone', dropFiles)).toEqual([true, true, true]);
  const summary = `${String(filesTotal)} files added. ${String(filesTotal)} emails found. ${String(merged)} identical copies merged.`;
  await expect(page.locator('#add-summary-text')).toHaveText(summary, { timeout: 120_000 });
  const items = page.locator('#preview-list > li');
  await expect(items).toHaveCount(list.length);
  await expect(page.locator('#preview-list')).not.toHaveAttribute('aria-busy', /.*/);
  expect(page.url()).toBe(url);
  await expect(page.locator('#add-failed')).toBeHidden();
  await expect(page.locator('#add-batch-error')).toBeHidden();

  // Counts: the engine's, matching the manifest.
  await expect(page.locator('#review-files-text')).toHaveText(`${String(filesTotal)} files.`);
  await expect(page.locator('#review-failed-pointer')).toBeHidden();
  await expect(page.locator('#review-messages')).toHaveText(`${String(filesTotal)} emails found, ${String(merged)} identical copies merged.`);
  await expect(page.locator('#review-included')).toHaveText(`${String(list.length)} of ${String(list.length)} emails will be in the PDF.`);
  await expect(page.locator('#review-notes')).toHaveText(/^\d+ emails have notes/);

  // Order: by date, the undated ones last; one item per duplicate group.
  await expect(items.locator('.message-subject')).toHaveText(list.map((e) => e.subject));
  await expect(items.locator('.message-number')).toHaveText(list.map((_, i) => `#${String(i + 1)}`));

  // Dates in the browser's zone at first.
  const dates = list.map((e) => (e.utcMs === null ? en.preview.noDate : dateText(e.utcMs, BROWSER_OFFSET)));
  await expect(items.locator('.message-date')).toHaveText(dates);
  await expect(page.getByLabel(en.preview.zone)).toHaveValue(BROWSER_ZONE);

  // Every email's text is in the page (folded or not), and no element was
  // made from email content: no link, image, frame, script or style.
  const before = await pageTextAndValues(page);
  for (const f of FIXTURES) for (const snippet of f.bodyContains) expect(before.text, f.id).toContain(snippet);
  for (const f of FIXTURES) for (const never of f.bodyExcludes ?? []) expect(before.text, f.id).not.toContain(never);
  await expect(page.locator('#preview-list :is(a, img, iframe, object, embed, script, style, link, form, b, p:not(.note))')).toHaveCount(0);

  // --- The HTML-only .msg: plain text only, nothing run or loaded. --------
  const htmlIndex = list.findIndex((e) => e.id === HTML_ONLY.id);
  expect(htmlIndex).toBeGreaterThanOrEqual(0);
  const htmlItem = items.nth(htmlIndex);
  await expect(htmlItem.locator('.message-subject')).toHaveText(HTML_ONLY.subject ?? '');
  const htmlBody = htmlItem.locator('.message-body');
  for (const text of HTML_ONLY_SHOWS) await expect(htmlBody).toContainText(text);
  const htmlText = (await htmlBody.textContent()) ?? '';
  for (const never of HTML_ONLY_NEVER) expect(htmlText).not.toContain(never);
  // Only the preview's own text blocks in its body.
  expect(await htmlBody.evaluate((body) => [...new Set([...body.querySelectorAll('*')].map((e) => e.tagName))])).toEqual(['DIV']);
  await expect(htmlItem.getByRole('list', { name: en.review.notesLabel }).locator('li')).toHaveText(
    HTML_ONLY.warnings.map((w) => en.warnings.parse[w]),
  );

  // --- A reply's quoted part is folded, and opens with its toggle. --------
  const replyIndex = list.findIndex((e) => e.group === 'order-2');
  const reply = items.nth(replyIndex);
  await expect(reply.locator('.message-body > .body-text').first()).toContainText('I can come by on Wednesday 5 March');
  const fold = reply.locator('details.fold').last();
  const quoted = fold.locator('.body-folded');
  await expect(quoted).toBeHidden();
  await expect(quoted).toContainText('We are furnishing a small office for four people');
  await fold.locator('summary').click();
  await expect(quoted).toBeVisible();
  await fold.locator('summary').click();
  await expect(quoted).toBeHidden();
  // The global toggle opens and closes every folded block.
  const toggle = page.getByLabel(en.preview.showFolded);
  const folds = await page.locator('#preview-list details.fold').count();
  expect(folds).toBeGreaterThan(10);
  await toggle.check();
  await expect(page.locator('#preview-list details.fold[open]')).toHaveCount(folds);
  await expect(quoted).toBeVisible();
  await toggle.uncheck();
  await expect(page.locator('#preview-list details.fold[open]')).toHaveCount(0);
  // The merged copies are named on the email kept.
  await expect(reply.locator('dd.meta-also-in')).toHaveCount(1);

  // --- Another zone rewrites every date, nothing else. --------------------
  await reply.locator('.message-body').evaluate((body) => body.setAttribute('data-test-mark', 'kept'));
  await page.getByLabel(en.preview.zone).selectOption('UTC');
  await expect(items.locator('.message-date')).toHaveText(list.map((e) => (e.utcMs === null ? en.preview.noDate : dateText(e.utcMs, 0))));
  await expect(items.locator('.message-subject')).toHaveText(list.map((e) => e.subject));
  await expect(reply.locator('.message-body')).toHaveAttribute('data-test-mark', 'kept');

  // --- Untick one email: it stays, dimmed; the count follows. -------------
  const untick = items.nth(1);
  await untick.getByRole('checkbox', { name: en.actions.include }).uncheck();
  const oneLess = `${String(list.length - 1)} of ${String(list.length)} emails will be in the PDF.`;
  await expect(page.locator('#review-included')).toHaveText(oneLess);
  await expect(page.getByRole('status')).toHaveText(oneLess);
  await expect(untick).toHaveAttribute('data-included', 'false');
  await expect(items).toHaveCount(list.length);

  // --- The undated email has its notes. -----------------------------------
  const undated = items.nth(list.findIndex((e) => e.id === 'eml/70-no-date.eml'));
  await expect(undated.locator('.message-subject')).toHaveText('Spare chair');
  await expect(undated.locator('.message-date')).toHaveText(en.preview.noDate);
  await expect(undated.getByRole('list', { name: en.review.notesLabel }).locator('li')).toHaveText([
    en.warnings.parse['missing-date'],
    en.preview.order['file-order'],
  ]);

  // --- Clear everything: the page is empty, no email text is left. --------
  const subjects = list.map((e) => e.subject).filter((s) => s !== en.preview.noSubject);
  const snippets = FIXTURES.flatMap((f) => f.bodyContains);
  const fileNames = dropFiles.map((f) => f.name);
  // What the page showed before: every subject, and the file names it is
  // meant to show. No file failed, so the only file names in the page are
  // those of the merged copies, in the "also in" row of the email kept: in
  // each duplicate group, every file but one (the one kept).
  for (const subject of subjects) expect(before.text).toContain(subject);
  await expect(page.locator('#add-failed-list > li')).toHaveCount(0);
  const alsoIn = page.locator('#preview-list dd.meta-also-in');
  const groups = new Map<string, string[]>();
  for (const e of expected) groups.set(e.group, [...(groups.get(e.group) ?? []), e.fileName]);
  const merges = [...groups.values()].filter((names) => names.length > 1);
  await expect(alsoIn).toHaveCount(merges.length);
  const alsoInText = (await alsoIn.allTextContents()).join('\n');
  const shownNames = merges.flatMap((names) => {
    const shown = names.filter((n) => alsoInText.includes(n));
    expect(shown, names.join(', ')).toHaveLength(names.length - 1);
    return shown;
  });
  expect(shownNames).toHaveLength(merged);
  for (const name of shownNames) expect(before.text).toContain(name);
  // Addresses were shown too (from, to, cc, bcc rows).
  expect(before.text).toMatch(/@example\.test|@sample\.invalid|@furniture\.example\.test/);
  await page.getByRole('button', { name: en.actions.clearEverything }).click();
  await expect(page.getByRole('status')).toHaveText(en.clear.done);
  await expect(page.getByRole('button', { name: en.actions.chooseFiles })).toBeFocused();
  await expect(items).toHaveCount(0);
  await expect(page.locator('#check-area')).toBeHidden();
  await expect(page.locator('#check-waiting')).toBeVisible();
  await expect(page.locator('#add-summary')).toBeHidden();
  await expect(page.locator('#clear-everything')).toHaveAttribute('aria-disabled', 'true');
  const after = await pageTextAndValues(page);
  // The whole page markup too, so attributes (labels, descriptions, titles,
  // data-*) are covered, in plain and in escaped form.
  const escaped = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  for (const text of [...subjects, ...snippets, ...fileNames]) {
    expect(after.text).not.toContain(text);
    for (const value of after.values) expect(value).not.toContain(text);
    expect(after.html, text).not.toContain(text);
    expect(after.html, text).not.toContain(escaped(text));
  }
  expect(after.text).not.toMatch(/@example\.test|@sample\.invalid|@furniture\.example\.test/);
  expect(after.html).not.toMatch(/@[\w.-]+\.(?:test|invalid)\b/);
  await expect(page.getByLabel(en.preview.zone)).toHaveValue(BROWSER_ZONE);
  await expect(toggle).not.toBeChecked();
  expect(page.url()).toBe(url);

  await expectNothingLeftThePage(page);
});

/** What the test learns about the focused element. */
interface Focus {
  readonly key: string;
  readonly tag: string;
  readonly step: string;
  readonly position: number;
  readonly outlineStyle: string;
  readonly outlineWidth: number;
  readonly top: number;
  readonly bottom: number;
}

/** The focused element, marked with a test key (data-test-focus) so it can be found again. */
async function focused(page: Page, key: string): Promise<Focus> {
  return page.evaluate((mark) => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || active === document.body) throw new Error('nothing focused');
    active.dataset.testFocus ??= mark;
    const style = getComputedStyle(active);
    const rect = active.getBoundingClientRect();
    return {
      key: active.dataset.testFocus,
      tag: active.tagName,
      step: active.closest('section.step')?.id ?? '',
      position: Number(active.closest('li.message')?.getAttribute('data-position') ?? '-1'),
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      top: rect.top + window.scrollY,
      bottom: rect.bottom + window.scrollY,
    };
  }, key);
}

test('keyboard only: every control is reached in order, shows its focus and works', async ({ page }) => {
  test.setTimeout(120_000);
  await open(page);
  // Listen for the file chooser first (see e2e/add-files.spec.ts).
  const choosers: FileChooser[] = [];
  page.on('filechooser', (chooser) => choosers.push(chooser));
  // Playwright turns on file-chooser interception asynchronously when the
  // first listener is added: one round trip to the page lets it finish, so
  // the Enter below cannot open a real chooser first.
  await page.evaluate(() => 0);

  // --- The language picker is the first stop: the ticked radio (English).
  // The other languages' radios are reached with the arrow keys, not Tab.
  await page.keyboard.press('Tab');
  const english = page.locator('#lang-en');
  await expect(english).toBeFocused();
  await expect(english).toBeChecked();
  await expect(english).toHaveAccessibleName('English');
  const languageFocus = await focused(page, 'language');
  expect(languageFocus.outlineStyle).not.toBe('none');

  // --- The privacy panel's summary is next: Enter opens it, Space closes it.
  await page.keyboard.press('Tab');
  const privacy = page.locator('#privacy-summary');
  await expect(privacy).toBeFocused();
  await expect(privacy).toHaveAccessibleName(en.privacy.summary);
  const privacyFocus = await focused(page, 'privacy');
  expect(privacyFocus.outlineStyle).not.toBe('none');
  await page.keyboard.press('Enter');
  await expect(page.locator('#privacy')).toHaveAttribute('open', '');
  await expect(page.locator('#privacy .privacy-body')).toBeVisible();
  await page.keyboard.press('Space');
  await expect(page.locator('#privacy')).not.toHaveAttribute('open', /.*/);

  // --- Step 1's help ("How do I get my email files?") is next: Enter opens it, Space closes it.
  await page.keyboard.press('Tab');
  const help = page.locator('#help-summary');
  await expect(help).toBeFocused();
  await expect(help).toHaveAccessibleName(en.help.summary);
  const helpFocus = await focused(page, 'help');
  expect(helpFocus.outlineStyle).not.toBe('none');
  await page.keyboard.press('Enter');
  await expect(page.locator('#help')).toHaveAttribute('open', '');
  await expect(page.locator('#help .help-body')).toBeVisible();
  await page.keyboard.press('Space');
  await expect(page.locator('#help')).not.toHaveAttribute('open', /.*/);

  // --- Step 1: the "choose" button is the next stop; Enter opens the chooser.
  await page.keyboard.press('Tab');
  const choose = page.getByRole('button', { name: en.actions.chooseFiles });
  await expect(choose).toBeFocused();
  const chooseFocus = await focused(page, 'choose');
  expect(chooseFocus.outlineStyle).not.toBe('none');
  await page.keyboard.press('Enter');
  await expect.poll(() => choosers.length).toBe(1);
  // A few emails: a thread with folds, an undated one and the HTML-only .msg.
  const names = ['10-order-1-alice.eml', '11-order-2-bob-outlook-en.eml', '12-order-3-alice-gmail.eml', '70-no-date.eml', fileNameOf(HTML_ONLY)];
  // Node's Buffer is what setFiles wants for in-memory files (see e2e/add-files.spec.ts).
  const NodeBuffer = (globalThis as unknown as { Buffer: { from(bytes: number[]): Uint8Array } }).Buffer;
  const chosen = names.map((name) => {
    const file = dropFiles.find((f) => f.name === name);
    if (file === undefined) throw new Error(`no ${name}`);
    return { name: file.name, mimeType: file.type, buffer: NodeBuffer.from(file.bytes) as never };
  });
  await choosers[0]?.setFiles(chosen);
  await expect(page.locator('#add-summary-text')).toHaveText('5 files added. 5 emails found.', { timeout: 60_000 });
  const items = page.locator('#preview-list > li');
  await expect(items).toHaveCount(5);
  await expect(page.locator('#preview-list')).not.toHaveAttribute('aria-busy', /.*/);
  await expect(choose).toBeFocused();

  // --- Every control has a name; the headings do not skip a level. --------
  // Links too: none today, but any added later must have a name and be a Tab stop.
  const controls = page.locator('a[href], button, select, input:not([type="hidden"]):not([hidden]), summary');
  const controlCount = await controls.count();
  expect(controlCount).toBeGreaterThan(10);
  for (const control of await controls.all()) await expect(control).toHaveAccessibleName(/\S/);
  for (const box of await page.getByRole('checkbox', { name: en.actions.include }).all()) {
    // Each include checkbox's name also says which email it is for.
    await expect(box).toHaveAccessibleName(new RegExp(`^${en.actions.include} #\\d+ \\S`));
  }
  // checkVisibility(), not getClientRects(): the headings of the privacy
  // panel and of step 1's help, closed again above, keep their boxes inside
  // the closed <details>.
  const headings = await page.locator('h1, h2, h3, h4, h5, h6').evaluateAll((list) =>
    list.filter((h) => h.checkVisibility()).map((h) => ({ level: Number(h.tagName.slice(1)), step: h.closest('section.step')?.id ?? '' })),
  );
  expect(headings.filter((h) => h.level === 1)).toHaveLength(1);
  expect(headings[0]?.level).toBe(1);
  for (let i = 1; i < headings.length; i++) expect(headings[i]?.level ?? 9).toBeLessThanOrEqual((headings[i - 1]?.level ?? 0) + 1);
  expect(headings.filter((h) => h.level === 2).map((h) => h.step)).toEqual(['step-add', 'step-check', 'step-download']);
  // One h3 per email, inside step 2.
  expect(headings.filter((h) => h.level === 3 && h.step === 'step-check')).toHaveLength(5);
  await expect(items.locator('h3')).toHaveCount(5);

  // --- Tab through the whole page, operating each control on the way. -----
  const walk: Focus[] = [languageFocus, privacyFocus, helpFocus, chooseFocus];
  const included = (n: number): string => `${String(n)} of 5 emails will be in the PDF.`;
  for (let i = 1; i < 200; i++) {
    await page.keyboard.press('Tab');
    const focus = await focused(page, `stop-${String(i)}`);
    walk.push(focus);
    const here = page.locator(`[data-test-focus="${focus.key}"]`);
    if (focus.tag === 'BUTTON' && (await here.getAttribute('id')) === 'clear-everything') {
      await expect(here).toHaveAccessibleName(en.actions.clearEverything);
      await expect(here).not.toHaveAttribute('aria-disabled', /.*/);
    } else if (focus.tag === 'SELECT') {
      // Typing picks an option, as on a closed native list: the first one
      // whose label starts with the typed text. Which one that is depends on
      // the zone list (its labels and order), which this test does not own,
      // so if typing picked another zone, choose "UTC" directly instead.
      // The value is asserted either way.
      await page.keyboard.type('UTC');
      if ((await here.inputValue()) !== 'UTC') {
        await here.selectOption('UTC');
        await here.focus();
      }
      await expect(here).toHaveValue('UTC');
      await expect(items.nth(0).locator('.message-date')).toHaveText('2025-03-03 08:15:00 UTC+00:00');
    } else if (focus.tag === 'INPUT' && (await here.getAttribute('id')) === 'preview-show-folded') {
      await page.keyboard.press('Space');
      await expect(page.locator('#preview-list details.fold:not([open])')).toHaveCount(0);
      await page.keyboard.press('Space');
      await expect(page.locator('#preview-list details.fold[open]')).toHaveCount(0);
    } else if (focus.tag === 'INPUT' && (await here.getAttribute('id')) === 'pdf-everything') {
      // "Put everything in the PDF": every label says "In the PDF", then back.
      await expect(here).toHaveAccessibleName(en.pdf.everything);
      const labels = page.locator('#preview-list .pdf-label:visible');
      const ready = page.locator('#preview-list[data-pdf-labels="ready"]');
      await page.keyboard.press('Space');
      await expect(here).toBeChecked();
      await expect(ready).toHaveCount(1);
      await expect(labels.filter({ hasText: /^Not in the PDF/ })).toHaveCount(0);
      expect(await labels.count()).toBeGreaterThan(0);
      await page.keyboard.press('Space');
      await expect(here).not.toBeChecked();
      await expect(ready).toHaveCount(1);
      await expect(labels.filter({ hasText: /^Not in the PDF/ }).first()).toBeVisible();
    } else if (focus.tag === 'INPUT') {
      // An include checkbox: Space unticks it, Space ticks it again.
      await page.keyboard.press('Space');
      await expect(here).not.toBeChecked();
      await expect(page.locator('#review-included')).toHaveText(included(4));
      await expect(items.nth(focus.position)).toHaveAttribute('data-included', 'false');
      await page.keyboard.press('Space');
      await expect(here).toBeChecked();
      await expect(page.locator('#review-included')).toHaveText(included(5));
    } else if (focus.tag === 'SUMMARY') {
      // A folded block: Enter opens it, Space closes it.
      const details = here.locator('xpath=..');
      await page.keyboard.press('Enter');
      await expect(details).toHaveAttribute('open', '');
      await expect(details.locator('.body-folded')).toBeVisible();
      await page.keyboard.press('Space');
      await expect(details).not.toHaveAttribute('open', /.*/);
    } else if (focus.tag === 'BUTTON' && (await here.getAttribute('id')) === 'download-button') {
      // Available and explained. It is not pressed here: making and
      // downloading the PDF with the keyboard is checked in e2e/download.spec.ts.
      await expect(here).toHaveAccessibleName(en.actions.makePdf);
      await expect(here).not.toHaveAttribute('aria-disabled', /.*/);
      await expect(here).toHaveAccessibleDescription(en.download.available);
      break;
    }
  }

  // The stops, in order: the language picker (its ticked radio), the privacy
  // panel's summary, step 1's help, choose, clear, zone, folded-text toggle,
  // "put everything in the PDF", then per email its checkbox and its folded
  // blocks, and the download button last.
  const tags = walk.map((f) => f.tag);
  expect(tags.slice(0, 8)).toEqual(['INPUT', 'SUMMARY', 'SUMMARY', 'BUTTON', 'BUTTON', 'SELECT', 'INPUT', 'INPUT']);
  expect(walk[0]?.key).toBe('language');
  expect(walk[2]?.key).toBe('help');
  expect(walk[7]?.key).toBe(await page.locator('#pdf-everything').getAttribute('data-test-focus'));
  expect(tags.at(-1)).toBe('BUTTON');
  expect(walk.filter((f) => f.tag === 'INPUT' && f.position >= 0).map((f) => f.position)).toEqual([0, 1, 2, 3, 4]);
  expect(walk.filter((f) => f.tag === 'SUMMARY').length).toBe(2 + (await page.locator('#preview-list summary').count()));
  // Every control is a stop, except the unticked language radios (one Tab stop per radio group).
  const languageRadios = await page.locator('#language input[type="radio"]').count();
  expect(languageRadios).toBe(3);
  expect(walk.length).toBe(controlCount - (languageRadios - 1));
  // Every stop shows a clear outline.
  for (const f of walk) {
    expect(f.outlineStyle, f.key).not.toBe('none');
    expect(f.outlineWidth, f.key).toBeGreaterThanOrEqual(2);
  }
  // The order follows the page: the header, then step by step, email by email, top to bottom
  // (a stop may share a line with the one before, never sit above it).
  const stepOrder = ['step-add', 'step-check', 'step-download'];
  for (let i = 1; i < walk.length; i++) {
    const [previous, current] = [walk[i - 1], walk[i]];
    if (previous === undefined || current === undefined) continue;
    expect(stepOrder.indexOf(current.step), current.key).toBeGreaterThanOrEqual(stepOrder.indexOf(previous.step));
    if (current.step === 'step-check' && previous.position >= 0) expect(current.position, current.key).toBeGreaterThanOrEqual(previous.position);
    expect(current.bottom, current.key).toBeGreaterThan(previous.top);
  }

  // --- Shift+Tab goes back through the same stops, in reverse. ------------
  for (let i = walk.length - 2; i >= 0; i--) {
    await page.keyboard.press('Shift+Tab');
    const key = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset.testFocus ?? '');
    expect(key).toBe(walk[i]?.key);
  }
  await expect(english).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(privacy).toBeFocused();

  // --- "Clear everything" with Enter: emptied, focus back on "choose". ----
  await page.keyboard.press('Tab');
  await expect(help).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(choose).toBeFocused();
  await page.keyboard.press('Tab');
  const clear = page.getByRole('button', { name: en.actions.clearEverything });
  await expect(clear).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toHaveText(en.clear.done);
  await expect(choose).toBeFocused();
  await expect(items).toHaveCount(0);
  await expect(page.locator('#check-area')).toBeHidden();
  await expect(clear).toHaveAttribute('aria-disabled', 'true');
  const after = await pageTextAndValues(page);
  for (const text of ['Office desks and chairs', 'Spare chair', HTML_ONLY.subject ?? '', ...names]) {
    expect(after.text).not.toContain(text);
    expect(after.html).not.toContain(text);
  }

  await expectNothingLeftThePage(page);
});
