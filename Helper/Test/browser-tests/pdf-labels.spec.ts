// Browser test of the preview's PDF labels (Source/page/preview.ts,
// Source/page/pdf-labels.ts): each folded part says, in words, whether it will be
// in the PDF, exactly as the PDF's own plan (Source/thread-analysis/output-plan.ts)
// decides; unticking an email or ticking "Print full original text" changes
// the labels, and a label that may be stale is never shown. In each test
// browser, against the BUILT site, with the real pipeline.
//
// Emails: four fixtures of Helper/Test/test-data/eml (a thread with an
// Outlook-style and a Gmail-style reply, and repeated signatures), plus two
// synthetic emails written here, in memory: a forward and a reply that
// quotes with "> " and answers between the quoted lines. Every test also
// checks that nothing left the page, no CSP violation and no console error
// (Helper/Test/browser-tests/support/watch.ts).
import { readFileSync } from 'node:fs';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { en } from '../../../Source/page/translations/en.ts';
import { contrastFailures } from './support/contrast.ts';
import { engineOf, watchPage, withoutSelectConsole, withoutSelectReports, workerCspReports, type Watch } from './support/watch.ts';

declare global
{
    interface Window
    {
        __labelViolations: string[];
    }
}

/** Project root as a file path ("file:///C:/x/" -> "C:/x/"), as in vite.config.ts. */
const ROOT = decodeURIComponent(new URL('../../..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');

// Node's Buffer is what setInputFiles wants for in-memory files (see Helper/Test/browser-tests/add-files.spec.ts).
const NodeBuffer = (globalThis as unknown as { Buffer: { from(text: string, encoding: 'utf8'): Uint8Array } }).Buffer;
const payload = (name: string, bytes: Uint8Array) => ({ name, mimeType: 'message/rfc822', buffer: bytes as never });
// The .eml fixtures are 7-bit ASCII (Helper/Test/test-data/README.md), so reading them as text keeps every byte.
const fixture = (name: string) => payload(name, NodeBuffer.from(readFileSync(`${ROOT}Helper/Test/test-data/eml/${name}`, 'utf8'), 'utf8'));

/** A synthetic plain-text .eml (reserved test domains, made-up people). */
function eml(headers: Readonly<Record<string, string>>, body: string): string
{
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
const PRINTED_AS_REBUILT = (n: number): string => en.pdf.printedAs.rebuilt.replace('{number}', String(n));

test.use({ timezoneId: 'Africa/Lagos' });

let origin = '';
let watch: Watch;
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
    await page.addInitScript(() =>
    {
        window.__labelViolations = [];
        document.addEventListener('securitypolicyviolation', (event) =>
        {
            // "select": WebKit's report about a <select> (see withoutSelectReports).
            window.__labelViolations.push(`${event.effectiveDirective} ${event.blockedURI}${event.target instanceof HTMLSelectElement ? ' select' : ''}`);
        });
    });
});

/** Opens the page, adds the emails and waits until the labels are ready. */
async function openWithEmails(page: Page): Promise<Locator>
{
    await page.goto('/', { waitUntil: 'networkidle' });
    await expect(page.locator('#drop-zone')).toBeVisible();
    loadedAt = watch.requests.length;
    await page.locator('#file-input').setInputFiles(FILES);
    await expect(page.locator('#add-summary-text')).toHaveText('6 files added. 6 emails found.', { timeout: 30_000 });
    // The real emails' items. The forwarded email's quote also gives one earlier
    // email rebuilt from quoted text (task 7.6), with a card of its own: not
    // what this file checks (see Helper/Test/browser-tests/rebuilt.spec.ts).
    const items = page.locator('#preview-list > li:not(.message-rebuilt)');
    await expect(items).toHaveCount(6);
    await expect(page.locator('#preview-list > li.message-rebuilt')).toHaveCount(1);
    await expect(items.locator('.message-subject')).toHaveText(SUBJECTS_IN_ORDER);
    await expectReady(page);
    return items;
}

async function expectReady(page: Page): Promise<void>
{
    await expect(page.locator('#preview-list')).toHaveAttribute('data-pdf-labels', 'ready', { timeout: 15_000 });
    // The status line keeps its place (so the list does not move), with no text.
    await expect(page.locator('#pdf-labels-status')).toHaveText('');
}

/** The visible PDF labels of one email, in order. */
async function labelsOf(item: Locator): Promise<string[]>
{
    const texts = await item.locator('.pdf-label:visible').allTextContents();
    return texts.map((s) => s.trim());
}

/** Nothing left the page, no CSP violation, no console error (see Helper/Test/browser-tests/preview.spec.ts). */
async function expectNothingLeftThePage(page: Page): Promise<void>
{
    await page.waitForTimeout(500);
    const workerUrls = new Set(watch.workers.map((w) => w.url()));
    for (const url of workerUrls)
    {
        expect(url).toMatch(new RegExp(`^blob:${origin}/[0-9a-f-]+$`));
    }
    expect(watch.requests.slice(loadedAt).filter((url) => !workerUrls.has(url))).toEqual([]);
    expect(watch.requests.every((url) => new URL(url).origin === origin)).toBe(true);
    expect(watch.websockets).toEqual([]);
    const browserName = engineOf(page.context());
    expect(withoutSelectReports(browserName, await page.evaluate(() => window.__labelViolations))).toEqual([]);
    expect(workerCspReports(watch)).toEqual([]);
    expect(withoutSelectConsole(browserName, problems)).toEqual([]);
}

test('each folded part says whether it will be in the PDF', async ({ page }) =>
{
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
    // #5, a forward: the forwarded email is rebuilt from it and printed as an
    // email of its own (Email 5 in the PDF, before the forward), so its text is
    // not in the forward in the PDF (task 8.11); its header lines go too (task
    // 8.13a, Q4: their date has no zone of its own, so they are printed at the
    // top of the rebuilt email): header lines and text, both printed as Email 5,
    // are one block with one label (task 8.13a review round 2).
    expect(await labelsOf(items.nth(4))).toEqual([PRINTED_AS_REBUILT(5)]);
    // The header lines were folded, the text shown: the one block is SHOWN
    // (user decision, task 8.13a final round, option (a)), so the header lines
    // are visible with the text, in no fold.
    const forwardShown = await items.nth(4).evaluate((li) =>
        [...li.querySelectorAll('.message-body .body-text')].filter((b) => b.closest('details.fold') === null).map((b) => b.textContent).join(''),
    );
    expect(forwardShown).toContain('---------- Forwarded message ---------\nFrom: Depot Desk <depot@example.test>');
    expect(forwardShown).toContain('The delivery slot is Tuesday morning, between eight and ten.');
    await expect(items.nth(4).locator('details.fold', { hasText: 'Forwarded message' })).toHaveCount(0);
    // #6, quotes the writer put between their own answers: they stay.
    const writerLabels = await labelsOf(items.nth(5));
    expect(writerLabels.length).toBeGreaterThan(0);
    for (const text of writerLabels)
    {
        expect(text).toBe(IN(R['writer-quote']));
    }

    // Labels are text in the summary, so screen readers read them with the fold.
    await expect(items.nth(2).locator('summary')).toHaveAccessibleName(new RegExp(`^${OUT('').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.* \\d+ lines`));
    // Nothing is removed from the preview: every character is still in the page.
    await page.getByLabel(en.preview.showFolded).check();
    const total = await page.locator('details.fold').count();
    await expect(page.locator('details.fold[open]')).toHaveCount(total);
    const shown = await items.nth(1).evaluate((li) => [...li.querySelectorAll('.message-body .body-text')].map((b) => b.textContent).join(''));
    const raw = readFileSync(`${ROOT}Helper/Test/test-data/eml/11-order-2-bob-outlook-en.eml`, 'utf8').replaceAll('\r\n', '\n');
    expect(shown).toBe(raw.slice(raw.indexOf('\n\n') + 2));
    // Readable: the labels (and everything else in step 2) meet the contrast rules.
    expect(await contrastFailures(page, '#step-check', 20)).toEqual([]);

    // "Rebuild conversation from replies" off: no rebuilt email in the PDF, so the
    // forwarded email stays in the forward; on again: printed as its own email again.
    await page.locator('#rebuilt-include-all').uncheck();
    await expectReady(page);
    expect(await labelsOf(items.nth(4))).toEqual([IN(R.forwarded)]);
    await page.locator('#rebuilt-include-all').check();
    await expectReady(page);
    expect(await labelsOf(items.nth(4))).toEqual([PRINTED_AS_REBUILT(5)]);
    // Its rebuilt card unticked (the switch on): the forwarded email is left out of the PDF (task 8.13a, Q2), one label.
    const card = page.locator('#preview-list > li.message-rebuilt').locator('input.include-checkbox');
    await card.uncheck();
    await expectReady(page);
    expect(await labelsOf(items.nth(4))).toEqual([en.pdf.printedAs.unticked]);
    await card.check();
    await expectReady(page);
    expect(await labelsOf(items.nth(4))).toEqual([PRINTED_AS_REBUILT(5)]);

    await expectNothingLeftThePage(page);
});

test('unticking an email moves the "first" signature; ticking it back restores the labels', async ({ page }) =>
{
    test.setTimeout(60_000);
    const items = await openWithEmails(page);
    const before = await labelsOf(items.nth(2));

    // Untick #1. In the same task, the labels are already hidden (never stale).
    const state = await page.evaluate(() =>
    {
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

test('ticking an email never moves the list: the status line keeps its place', async ({ page }) =>
{
    test.setTimeout(60_000);
    await openWithEmails(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const top = (id: string): Promise<number> => page.locator(id).evaluate((e) => e.getBoundingClientRect().top);
    const ready = { first: await top('#include-0'), third: await top('#include-2') };

    // "updating", read in the same task as the click, before anything else can run.
    const updating = await page.evaluate(() =>
    {
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

test('unticking an email in the middle never moves the emails below, nor does ticking it back', async ({ page }) =>
{
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
        page.evaluate((click) =>
        {
            if (click)
            {
                document.querySelector<HTMLInputElement>('#include-2')?.click();
            }
            return {
                state: document.querySelector('#preview-list')?.getAttribute('data-pdf-labels'),
                tops: [3, 4, 5].map((k) => (document.querySelector(`#preview-list > li[data-position="${String(k)}"]`)?.getBoundingClientRect().top ?? Number.NaN) + window.scrollY),
            };
        }, clickThird);
    const below = (): ReturnType<typeof readTops> => readTops();
    const clickThird = (): ReturnType<typeof readTops> => readTops(true);
    const expectSameTops = (actual: readonly number[], expected: readonly number[]): void =>
    {
        expect(actual).toHaveLength(expected.length);
        actual.forEach((top, k) => expect(Math.abs(top - (expected[k] ?? Number.NaN))).toBeLessThanOrEqual(1));
    };

    const ready = await below();
    expect(ready.state).toBe('ready');
    for (const top of ready.tops)
    {
        expect(Number.isFinite(top)).toBe(true);
    }

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
    for (const mark of await third.locator('.pdf-label').all())
    {
        await expect(mark).toHaveCSS('visibility', 'hidden');
    }
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

test('new labels that redraw a focused fold keep the keyboard focus on it (never lost to the top of the page)', async ({ page }) =>
{
    test.setTimeout(60_000);
    const items = await openWithEmails(page);
    /** What has the focus: its tag, the email it is in (-1: none), and its index among that email's summaries (-1: not one). */
    const focused = (): Promise<{ tag: string; position: number; summary: number }> =>
        page.evaluate(() =>
        {
            const active = document.activeElement;
            const item = active?.closest('#preview-list > li');
            const position = Number(item?.getAttribute('data-position') ?? '-1');
            const summaries = item === null || item === undefined ? [] : [...item.querySelectorAll('.message-body summary')];
            return { tag: active?.tagName ?? '', position, summary: summaries.indexOf(active as Element) };
        });

    // 1. #3 (Alice's Gmail reply): one fold. Reached with the keyboard: Tab from its include checkbox.
    const third = items.nth(2);
    await expect(third.locator('details.fold')).toHaveCount(1);
    await page.locator('#include-2').focus();
    await page.keyboard.press('Tab');
    expect(await focused()).toEqual({ tag: 'SUMMARY', position: 2, summary: 0 });
    // Untick #1 inside the page (the focus stays on the summary): #3's fold now holds
    // the first copy of Alice's signature, so the new labels cut it in two (a redraw).
    const marked = await page.evaluate(() =>
    {
        document.activeElement?.setAttribute('data-test-old', '');
        document.querySelector<HTMLInputElement>('#include-0')?.click();
        return document.querySelector('#preview-list')?.getAttribute('data-pdf-labels');
    });
    expect(marked).toBe('updating');
    await expectReady(page);
    await expect(third.locator('details.fold')).toHaveCount(2);
    await expect(page.locator('[data-test-old]')).toHaveCount(0); // the old summary is gone from the page
    // The focus is on the new fold over the same text (the first piece), not on <body>.
    expect(await focused()).toEqual({ tag: 'SUMMARY', position: 2, summary: 0 });
    // So the next key works: Enter opens it, Enter closes it.
    const firstFold = third.locator('details.fold').first();
    await expect(firstFold).not.toHaveAttribute('open', /.*/);
    await page.keyboard.press('Enter');
    await expect(firstFold).toHaveAttribute('open', '');
    expect(await focused()).toEqual({ tag: 'SUMMARY', position: 2, summary: 0 });
    await page.keyboard.press('Enter');
    await expect(firstFold).not.toHaveAttribute('open', /.*/);

    // 2. #2 (Bob's Outlook reply): two folds; the focus on the second (the quote).
    // "Print full original text", ticked inside the page: the two become one fold.
    const second = items.nth(1);
    await expect(second.locator('details.fold')).toHaveCount(2);
    await second.locator('details.fold').nth(1).locator('summary').focus();
    expect(await focused()).toEqual({ tag: 'SUMMARY', position: 1, summary: 1 });
    const scrollBefore = await page.evaluate(() =>
    {
        document.querySelector<HTMLInputElement>('#pdf-everything')?.click();
        return window.scrollY;
    });
    await expect(page.getByLabel(en.pdf.everything)).toBeChecked();
    await expectReady(page);
    await expect(second.locator('details.fold')).toHaveCount(1);
    expect(await focused()).toEqual({ tag: 'SUMMARY', position: 1, summary: 0 });
    // Not scrolled by the move (focus with preventScroll).
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    // Space toggles the new fold.
    const merged = second.locator('details.fold').first();
    await page.keyboard.press(' ');
    await expect(merged).toHaveAttribute('open', '');
    expect(await focused()).toEqual({ tag: 'SUMMARY', position: 1, summary: 0 });

    await expectNothingLeftThePage(page);
});

test('a merge that moves the focused fold summary above the window scrolls it back into view', async ({ page }) =>
{
    test.setTimeout(60_000);
    const items = await openWithEmails(page);
    // A short window, so the open first fold of #2 pushes its second summary far down.
    await page.setViewportSize({ width: 800, height: 240 });
    const second = items.nth(1);
    const folds = second.locator('details.fold');
    await expect(folds).toHaveCount(2);
    await folds.first().locator('summary').click();
    await expect(folds.first()).toHaveAttribute('open', '');
    // The second summary near the top of the window, with the focus (as reached with the keyboard).
    const old = await page.evaluate(() =>
    {
        const summary = document.querySelectorAll<HTMLElement>('#preview-list > li:nth-child(2) .message-body summary')[1]!;
        summary.scrollIntoView({ block: 'start' });
        window.scrollBy(0, -20);
        summary.setAttribute('data-test-old', '');
        summary.focus({ preventScroll: true });
        const rect = summary.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom };
    });
    expect(old.top).toBeGreaterThan(0);
    expect(old.bottom).toBeLessThan(240);
    // "Print full original text", ticked inside the page: the two folds become one,
    // whose summary is where the first fold starts (above the window).
    await page.evaluate(() => document.querySelector<HTMLInputElement>('#pdf-everything')?.click());
    await expect(page.getByLabel(en.pdf.everything)).toBeChecked();
    await expectReady(page);
    await expect(folds).toHaveCount(1);
    await expect(page.locator('[data-test-old]')).toHaveCount(0);
    await expect(folds.first()).toHaveAttribute('open', ''); // (kept open: it overlaps the open fold)
    // The focus is on the new summary, and it can be seen in full (give or take
    // a pixel fraction: the page scrolls by whole pixels).
    const after = await page.evaluate(() =>
    {
        const active = document.activeElement as HTMLElement | null;
        const summary = document.querySelector('#preview-list > li:nth-child(2) .message-body summary');
        const rect = active?.getBoundingClientRect();
        return { same: active === summary, top: rect?.top ?? -1, bottom: rect?.bottom ?? -1, height: window.innerHeight };
    });
    expect(after.same).toBe(true);
    expect(after.top).toBeGreaterThan(-1);
    expect(after.bottom).toBeLessThan(after.height + 1);

    await expectNothingLeftThePage(page);
});

test('"Print full original text" makes every label say so, and Clear everything unticks it', async ({ page }) =>
{
    test.setTimeout(60_000);
    const items = await openWithEmails(page);
    const everything = page.getByLabel(en.pdf.everything);
    await expect(everything).not.toBeChecked();

    await everything.check();
    await expectReady(page);
    const all = await page.locator('#preview-list .pdf-label:visible').allTextContents();
    expect(all.length).toBe(await page.locator('#preview-list details.fold').count());
    for (const text of all)
    {
        expect(text.trim().startsWith(en.pdf.label.in.replace('{reasons}', ''))).toBe(true);
    }
    expect(await labelsOf(items.nth(2))).toEqual([IN(`${SAME_SIGNATURE(1)}, ${R['app-quoted-history']}`)]);
    // The forward is printed whole: its forwarded email is in it (task 8.11: no "printed as" label).
    expect(await labelsOf(items.nth(4))).toEqual([IN(R.forwarded)]);

    await everything.uncheck();
    await expectReady(page);
    expect(await labelsOf(items.nth(2))).toEqual([OUT(`${SAME_SIGNATURE(1)}, ${R['app-quoted-history']}`)]);
    expect(await labelsOf(items.nth(4))).toEqual([PRINTED_AS_REBUILT(5)]);

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
