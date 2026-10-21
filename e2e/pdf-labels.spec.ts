// Browser test of the preview's PDF labels (src/ui/preview.ts,
// src/ui/pdf-labels.ts): each folded part says, in words, whether it will be
// in the PDF, exactly as the PDF's own plan (src/engine/output-plan.ts)
// decides; unticking an email or ticking "Put everything in the PDF" changes
// the labels, and a label that may be stale is never shown. In Chromium,
// against the BUILT site, with the real pipeline.
//
// Emails: four fixtures of tests/fixtures/eml (a thread with an
// Outlook-style and a Gmail-style reply, and repeated signatures), plus two
// synthetic emails written here, in memory: a forward and a reply that
// quotes with "> " and answers between the quoted lines. Every test also
// checks that nothing left the page, no CSP violation and no console error
// (e2e/support/watch.ts).
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { en } from '../src/ui/i18n/en.ts';
import { contrastFailures } from './support/contrast.ts';
import { watchPage, workerCspReports, type Watch } from './support/watch.ts';

declare global {
  interface Window {
    __labelViolations: string[];
  }
}

/** Project root as a file path ("file:///C:/x/" -> "C:/x/"), as in vite.config.ts. */
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');

// Node's Buffer is what setInputFiles wants for in-memory files (see e2e/add-files.spec.ts).
const NodeBuffer = (globalThis as unknown as { Buffer: { from(text: string, encoding: 'utf8'): Uint8Array } }).Buffer;
const payload = (name: string, bytes: Uint8Array) => ({ name, mimeType: 'message/rfc822', buffer: bytes as never });
// The .eml fixtures are 7-bit ASCII (tests/fixtures/README.md), so reading them as text keeps every byte.
const fixture = (name: string) => payload(name, NodeBuffer.from(readFileSync(`${ROOT}tests/fixtures/eml/${name}`, 'utf8'), 'utf8'));

/** A synthetic plain-text .eml (reserved test domains, made-up people). */
function eml(headers: Readonly<Record<string, string>>, body: string): string {
  const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
  return `${[...lines, 'X-Synthetic-Fixture: true', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset="us-ascii"', 'Content-Transfer-Encoding: 7bit'].join('\r\n')}\r\n\r\n${body.replaceAll('\n', '\r\n')}`;
}

const FORWARD = eml(
  {
    Date: 'Mon, 24 Mar 2025 10:00:00 +0100',
    From: 'Carol Test <carol@example.test>',
    To: 'Bob Sample <bob@furniture.example.test>',
    Subject: 'Fwd: Delivery slot',
    'Message-ID': '<labels-forward@example.test>',
  },
  `Bob, see the message from the depot below.

Carol

---------- Forwarded message ---------
From: Depot Desk <depot@example.test>
Date: Fri, 21 Mar 2025 at 09:00
Subject: Delivery slot
To: Carol Test <carol@example.test>

The delivery slot is Tuesday morning, between eight and ten.
The driver will ring at the side door.
`,
);

const WRITER_QUOTE = eml(
  {
    Date: 'Tue, 25 Mar 2025 11:30:00 +0100',
    From: 'Dave Sample <dave@example.test>',
    To: 'Carol Test <carol@example.test>',
    Subject: 'Re: Chair colours',
    'Message-ID': '<labels-writer-quote@example.test>',
  },
  `Hi Carol,

> Which colour would you like for the four chairs
> in the meeting room?
Grey, please, the same as the ones in the hall.

> And should the desks be light oak
> or white?
Light oak for all of them.

Dave
`,
);

const FILES = [
  fixture('13-order-4-bob-outlook-nl.eml'),
  payload('labels-writer-quote.eml', NodeBuffer.from(WRITER_QUOTE, 'utf8')),
  fixture('10-order-1-alice.eml'),
  fixture('12-order-3-alice-gmail.eml'),
  payload('labels-forward.eml', NodeBuffer.from(FORWARD, 'utf8')),
  fixture('11-order-2-bob-outlook-en.eml'),
];
// By date: 10 (#1, Alice), 11 (#2, Bob, Outlook), 12 (#3, Alice, Gmail), 13 (#4, Bob, Outlook NL), forward (#5), writer quote (#6).
const SUBJECTS_IN_ORDER = [
  'Office desks and chairs',
  'RE: Office desks and chairs',
  'Re: Office desks and chairs',
  'RE: Office desks and chairs',
  'Fwd: Delivery slot',
  'Re: Chair colours',
];

const R = en.pdf.reason;
const IN = (reasons: string): string => en.pdf.label.in.replace('{reasons}', reasons);
const OUT = (reasons: string): string => en.pdf.label.out.replace('{reasons}', reasons);
const SAME_SIGNATURE = (n: number): string => en.pdf.repeatedFrom.replace('{number}', `#${String(n)}`);

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
    window.__labelViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__labelViolations.push(`${event.effectiveDirective} ${event.blockedURI}`);
    });
  });
});

/** Opens the page, adds the emails and waits until the labels are ready. */
async function openWithEmails(page: Page): Promise<Locator> {
  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.locator('#drop-zone')).toBeVisible();
  loadedAt = watch.requests.length;
  await page.locator('#file-input').setInputFiles(FILES);
  await expect(page.locator('#add-summary-text')).toHaveText('6 files added. 6 emails found.', { timeout: 30_000 });
  const items = page.locator('#preview-list > li');
  await expect(items).toHaveCount(6);
  await expect(items.locator('.message-subject')).toHaveText(SUBJECTS_IN_ORDER);
  await expectReady(page);
  return items;
}

async function expectReady(page: Page): Promise<void> {
  await expect(page.locator('#preview-list')).toHaveAttribute('data-pdf-labels', 'ready', { timeout: 15_000 });
  // The status line keeps its place (so the list does not move), with no text.
  await expect(page.locator('#pdf-labels-status')).toHaveText('');
}

/** The visible PDF labels of one email, in order. */
async function labelsOf(item: Locator): Promise<string[]> {
  const texts = await item.locator('.pdf-label:visible').allTextContents();
  return texts.map((s) => s.trim());
}

/** Nothing left the page, no CSP violation, no console error (see e2e/preview.spec.ts). */
async function expectNothingLeftThePage(page: Page): Promise<void> {
  await page.waitForTimeout(500);
  const workerUrls = new Set(watch.workers.map((w) => w.url()));
  for (const url of workerUrls) expect(url).toMatch(new RegExp(`^blob:${origin}/[0-9a-f-]+$`));
  expect(watch.requests.slice(loadedAt).filter((url) => !workerUrls.has(url))).toEqual([]);
  expect(watch.requests.every((url) => new URL(url).origin === origin)).toBe(true);
  expect(watch.websockets).toEqual([]);
  expect(await page.evaluate(() => window.__labelViolations)).toEqual([]);
  expect(workerCspReports(watch)).toEqual([]);
  expect(problems).toEqual([]);
}

test('each folded part says whether it will be in the PDF', async ({ page }) => {
  test.setTimeout(60_000);
  const items = await openWithEmails(page);

  // #1, Alice's first email: her signature, kept the first time.
  expect(await labelsOf(items.nth(0))).toEqual([IN(R.signature)]);
  // #2, Bob's Outlook-style reply: his first signature is kept, the quoted
  // email below it is not. The two were one folded part; it is cut in two
  // so that each label is right for all of its text.
  expect(await labelsOf(items.nth(1))).toEqual([IN(R.signature), OUT(R['app-quoted-history'])]);
  await expect(items.nth(1).locator('details.fold').nth(0).locator('.body-folded')).toContainText('DISCLAIMER');
  await expect(items.nth(1).locator('details.fold').nth(1).locator('.body-folded')).toContainText('From: Alice Example');
  // #3, Alice's Gmail-style reply: the same signature as in #1, and the quote, both left out.
  expect(await labelsOf(items.nth(2))).toEqual([OUT(`${SAME_SIGNATURE(1)}, ${R['app-quoted-history']}`)]);
  // #4, Bob's second Outlook reply: his signature again (as in #2) and the quote.
  expect(await labelsOf(items.nth(3))).toEqual([OUT(`${SAME_SIGNATURE(2)}, ${R['app-quoted-history']}`)]);
  // #5, a forward: the forwarded email stays in the PDF.
  expect(await labelsOf(items.nth(4))).toEqual([IN(R.forwarded)]);
  // #6, quotes the writer put between their own answers: they stay.
  const writerLabels = await labelsOf(items.nth(5));
  expect(writerLabels.length).toBeGreaterThan(0);
  for (const text of writerLabels) expect(text).toBe(IN(R['writer-quote']));

  // Labels are text in the summary, so screen readers read them with the fold.
  await expect(items.nth(2).locator('summary')).toHaveAccessibleName(new RegExp(`^${OUT('').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.* \\d+ lines`));
  // Nothing is removed from the preview: every character is still in the page.
  await page.getByLabel(en.preview.showFolded).check();
  const total = await page.locator('details.fold').count();
  await expect(page.locator('details.fold[open]')).toHaveCount(total);
  const shown = await items.nth(1).evaluate((li) => [...li.querySelectorAll('.message-body .body-text')].map((b) => b.textContent).join(''));
  const raw = readFileSync(`${ROOT}tests/fixtures/eml/11-order-2-bob-outlook-en.eml`, 'utf8').replaceAll('\r\n', '\n');
  expect(shown).toBe(raw.slice(raw.indexOf('\n\n') + 2));
  // Readable: the labels (and everything else in step 2) meet the contrast rules.
  expect(await contrastFailures(page, '#step-check', 20)).toEqual([]);

  await expectNothingLeftThePage(page);
});

test('unticking an email moves the "first" signature; ticking it back restores the labels', async ({ page }) => {
  test.setTimeout(60_000);
  const items = await openWithEmails(page);
  const before = await labelsOf(items.nth(2));

  // Untick #1. In the same task, the labels are already hidden (never stale).
  const state = await page.evaluate(() => {
    document.querySelector<HTMLInputElement>('#include-0')?.click();
    return document.querySelector('#preview-list')?.getAttribute('data-pdf-labels');
  });
  expect(state).toBe('updating');
  await expect(page.locator('#pdf-labels-status')).toHaveText(en.pdf.updating);
  await expect(page.locator('#preview-list .pdf-label:visible')).toHaveCount(0);
  await expectReady(page);

  // #1 is out of the PDF as a whole: no labels of its own.
  await expect(items.nth(0)).toHaveAttribute('data-included', 'false');
  expect(await labelsOf(items.nth(0))).toEqual([]);
  // #3 now has the first copy of Alice's signature: kept, cut apart from the quote.
  expect(await labelsOf(items.nth(2))).toEqual([IN(R.signature), OUT(R['app-quoted-history'])]);
  // Bob's labels do not change.
  expect(await labelsOf(items.nth(3))).toEqual([OUT(`${SAME_SIGNATURE(2)}, ${R['app-quoted-history']}`)]);

  await page.locator('#include-0').check();
  await expectReady(page);
  expect(await labelsOf(items.nth(2))).toEqual(before);
  expect(await labelsOf(items.nth(0))).toEqual([IN(R.signature)]);

  await expectNothingLeftThePage(page);
});

test('ticking an email never moves the list: the status line keeps its place', async ({ page }) => {
  test.setTimeout(60_000);
  await openWithEmails(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  const top = (id: string): Promise<number> => page.locator(id).evaluate((e) => e.getBoundingClientRect().top);
  const ready = { first: await top('#include-0'), third: await top('#include-2') };

  // "updating", read in the same task as the click, before anything else can run.
  const updating = await page.evaluate(() => {
    document.querySelector<HTMLInputElement>('#include-0')?.click();
    const at = (id: string): number => document.querySelector(id)?.getBoundingClientRect().top ?? Number.NaN;
    return {
      state: document.querySelector('#preview-list')?.getAttribute('data-pdf-labels'),
      status: document.querySelector('#pdf-labels-status')?.textContent,
      first: at('#include-0'),
      third: at('#include-2'),
    };
  });
  expect(updating.state).toBe('updating');
  expect(updating.status).toBe(en.pdf.updating);
  expect(updating.first).toBe(ready.first);
  expect(updating.third).toBe(ready.third);

  // "ready" again (with #1 unticked): still the same place.
  await expectReady(page);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  // (Emails below #3 may move here: #3's labels changed, its fold now cut in
  // two. #1's own hidden labels keep their place, see the next test.)
  expect(await top('#include-0')).toBe(ready.first);

  // And back (clicked in the page: Playwright's check() would scroll it into view first).
  await page.evaluate(() => document.querySelector<HTMLInputElement>('#include-0')?.click());
  await expect(page.locator('#include-0')).toBeChecked();
  await expectReady(page);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await top('#include-0')).toBe(ready.first);

  await expectNothingLeftThePage(page);
});

test('unticking an email in the middle never moves the emails below, nor does ticking it back', async ({ page }) => {
  test.setTimeout(60_000);
  const items = await openWithEmails(page);
  // #3 (Alice's Gmail reply): leaving it out changes no other email's labels
  // (#4 names #2's signature), so only #3's own labels could move the list.
  const third = items.nth(2);
  const thirdLabels = await labelsOf(third);
  expect(thirdLabels).toEqual([OUT(`${SAME_SIGNATURE(1)}, ${R['app-quoted-history']}`)]);
  const labelCount = await third.locator('.pdf-label').count();

  /**
   * The top of #4, #5 and #6 in the document (not the viewport), and the
   * labels state, read in one task. With `clickThird`, first clicks #3's
   * checkbox in the page (Playwright's check() would scroll it into view),
   * in that same task.
   */
  const readTops = (clickThird = false): Promise<{ state: string | null | undefined; tops: number[] }> =>
    page.evaluate((click) => {
      if (click) document.querySelector<HTMLInputElement>('#include-2')?.click();
      return {
        state: document.querySelector('#preview-list')?.getAttribute('data-pdf-labels'),
        tops: [3, 4, 5].map((k) => (document.querySelector(`#preview-list > li[data-position="${String(k)}"]`)?.getBoundingClientRect().top ?? Number.NaN) + window.scrollY),
      };
    }, clickThird);
  const below = (): ReturnType<typeof readTops> => readTops();
  const clickThird = (): ReturnType<typeof readTops> => readTops(true);
  const expectSameTops = (actual: readonly number[], expected: readonly number[]): void => {
    expect(actual).toHaveLength(expected.length);
    actual.forEach((top, k) => expect(Math.abs(top - (expected[k] ?? Number.NaN))).toBeLessThanOrEqual(1));
  };

  const ready = await below();
  expect(ready.state).toBe('ready');
  for (const top of ready.tops) expect(Number.isFinite(top)).toBe(true);

  // Unticked: "updating" at once, nothing below moved.
  const unticked = await clickThird();
  expect(unticked.state).toBe('updating');
  expectSameTops(unticked.tops, ready.tops);
  // The labels settle (#3 out of the PDF): still nothing moved.
  await expectReady(page);
  await expect(third).toHaveAttribute('data-included', 'false');
  expectSameTops((await below()).tops, ready.tops);
  // #3 shows no label (none visible, none read out), but its label lines keep their place.
  expect(await labelsOf(third)).toEqual([]);
  await expect(third.locator('.pdf-label')).toHaveCount(labelCount);
  for (const mark of await third.locator('.pdf-label').all()) await expect(mark).toHaveCSS('visibility', 'hidden');
  await expect(third.locator('summary').first()).not.toHaveAccessibleName(new RegExp(en.pdf.label.out.replace('{reasons}', '').trim()));
  // The other emails' labels did not change.
  expect(await labelsOf(items.nth(3))).toEqual([OUT(`${SAME_SIGNATURE(2)}, ${R['app-quoted-history']}`)]);

  // Ticked back: "updating", then the same labels; nothing below moved at any point.
  const ticked = await clickThird();
  expect(ticked.state).toBe('updating');
  expectSameTops(ticked.tops, ready.tops);
  await expectReady(page);
  await expect(third).toHaveAttribute('data-included', 'true');
  expectSameTops((await below()).tops, ready.tops);
  expect(await labelsOf(third)).toEqual(thirdLabels);

  await expectNothingLeftThePage(page);
});

test('"Put everything in the PDF" makes every label say so, and Clear everything unticks it', async ({ page }) => {
  test.setTimeout(60_000);
  const items = await openWithEmails(page);
  const everything = page.getByLabel(en.pdf.everything);
  await expect(everything).not.toBeChecked();

  await everything.check();
  await expectReady(page);
  const all = await page.locator('#preview-list .pdf-label:visible').allTextContents();
  expect(all.length).toBe(await page.locator('#preview-list details.fold').count());
  for (const text of all) expect(text.trim().startsWith(en.pdf.label.in.replace('{reasons}', ''))).toBe(true);
  expect(await labelsOf(items.nth(2))).toEqual([IN(`${SAME_SIGNATURE(1)}, ${R['app-quoted-history']}`)]);

  await everything.uncheck();
  await expectReady(page);
  expect(await labelsOf(items.nth(2))).toEqual([OUT(`${SAME_SIGNATURE(1)}, ${R['app-quoted-history']}`)]);

  await everything.check();
  await page.getByRole('button', { name: en.actions.clearEverything }).click();
  await expect(items).toHaveCount(0);
  await expect(everything).not.toBeChecked();

  // Added again: the defaults are back.
  await page.locator('#file-input').setInputFiles(FILES);
  await expect(items).toHaveCount(6, { timeout: 30_000 });
  await expectReady(page);
  expect(await labelsOf(items.nth(2))).toEqual([OUT(`${SAME_SIGNATURE(1)}, ${R['app-quoted-history']}`)]);

  await expectNothingLeftThePage(page);
});
