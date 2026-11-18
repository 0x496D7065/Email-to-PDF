// Unit tests for the cards of emails rebuilt from quoted text in step 2
// (Source/web-page/preview.ts builds them, Source/web-page/review.ts adds their checkboxes,
// the switch and the counts), in Node with the recording fake DOM
// (Helper/Test/test-support/fake-dom.ts), wired like Source/web-page/mount-page.ts. Synthetic
// fixtures only (Helper/Test/test-data/eml), run through the real engine. The real
// page is checked in the browsers by Helper/Test/browser-tests/rebuilt.spec.ts.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDocument, FakeElement } from '../../Helper/Test/test-support/fake-dom';
import { parseAllFixtures } from '../../Helper/Test/test-data/parse-all';
import { analyzeThread } from '../thread-analysis/analyze-thread';
import { planPdfOrder } from '../pdf-export/model';
import { rebuiltEntries } from '../web-page-logic/rebuilt-email-display';
import { setLocale, t } from './translations';
import { mountPreview, rebuiltAlsoText, rebuiltDateTexts, rebuiltNoteText, type Preview, type PreviewOptions } from './preview';
import { createReview, messagesText, noteText, type Review, type ReviewOptions } from './review';
import type { NormalizedMessage } from '../../Header/parsed-email';
import type { EngineRebuilt } from '../../Header/rebuilt-emails';
import type { EngineResult } from '../../Header/thread-analysis-result';

// ------------------------------------------------------------------ data

let fixtures: Map<string, NormalizedMessage>;
beforeAll(async () =>
{
    fixtures = new Map((await parseAllFixtures()).map((m) => [m.source.fileName, m]));
});
const fixture = (name: string): NormalizedMessage =>
{
    const message = fixtures.get(`eml/${name}`);
    if (message === undefined)
    {
        throw new Error(`no fixture ${name}`);
    }
    return message;
};
const engineOf = (...names: string[]): EngineResult => analyzeThread(names.map((n) => ({ ok: true as const, message: fixture(n) })));
/** The last email of a thread alone: 3 earlier emails rebuilt from its quote. */
const LAST = '13-order-4-bob-outlook-nl.eml';

/** A copy of `result` with rebuilt message `id` changed by `edit`. */
function withRebuilt(result: EngineResult, id: number, edit: (r: EngineRebuilt) => EngineRebuilt): EngineResult
{
    return { ...result, reconstructed: result.reconstructed.map((r) => (r.id === id ? edit(r) : r)) };
}
/** The same result without anything rebuilt (as before task 7.6). */
const withoutRebuilt = (result: EngineResult): EngineResult => ({
    ...result,
    reconstructed: [],
    timeline: result.messages.map((_, position) => ({ kind: 'message' as const, position })),
});

// ------------------------------------------------------------------ fake page

let fakeDocument: FakeDocument;
let area: FakeElement;
let preview: Preview;
let review: Review;
let announced: string[];
let rendered: number;

/** Builds step 2 like Source/web-page/mount-page.ts (the switch in the toolbar). */
function mount(options: PreviewOptions = {}, reviewOptions: ReviewOptions = {}): void
{
    area = new FakeElement('div');
    announced = [];
    rendered = 0;
    review = createReview({
        onRebuiltChange: (line) =>
        {
            preview.refreshRebuilt();
            announced.push(line);
        },
        ...reviewOptions,
    });
    preview = mountPreview(
        { checkArea: area as unknown as HTMLDivElement },
        {
            zones: ['America/New_York', 'Asia/Tokyo'],
            initialZone: 'America/New_York',
            chunkSize: 1000,
            header: [review.element],
            toolbarItems: [review.rebuiltSwitch],
            decorate: review.decorate,
            decorateRebuilt: review.decorateRebuilt,
            rebuiltShown: () => review.rebuiltShown(),
            onRendered: (result) =>
            {
                rendered++;
                review.rendered(result);
            },
            ...options,
        },
    );
}

function show(result: EngineResult): void
{
    review.show(result);
    preview.show(result);
}

beforeEach(() =>
{
    fakeDocument = new FakeDocument();
    vi.stubGlobal('document', fakeDocument);
    vi.stubGlobal('window', { innerHeight: 600 });
    setLocale('en');
    mount();
});

afterEach(() =>
{
    preview.reset();
    setLocale('en');
    vi.unstubAllGlobals();
});

const hasClass = (e: FakeElement, name: string): boolean => (e.getAttribute('class') ?? '').split(' ').includes(name);
const withClass = (root: FakeElement, name: string): FakeElement[] => root.descendants().filter((e) => hasClass(e, name));
const one = (root: FakeElement, name: string): FakeElement =>
{
    const found = withClass(root, name);
    if (found.length !== 1)
    {
        throw new Error(`expected one .${name}, found ${String(found.length)}`);
    }
    return found[0] as FakeElement;
};
function byId(id: string): FakeElement
{
    const found = area.descendants().find((e) => e.getAttribute('id') === id);
    if (!found)
    {
        throw new Error(`no element with id ${id}`);
    }
    return found;
}
const items = (): FakeElement[] => byId('preview-list').children.filter((c): c is FakeElement => c instanceof FakeElement);
const rebuiltItems = (): FakeElement[] => items().filter((i) => hasClass(i, 'message-rebuilt'));
const realItems = (): FakeElement[] => items().filter((i) => !hasClass(i, 'message-rebuilt'));
const isHidden = (e: FakeElement): boolean => e.hasAttribute('hidden');
/** The dt/dd pairs of an item's details list, as "label: value". */
const metaRows = (item: FakeElement): string[] =>
{
    const dl = one(item, 'message-meta');
    const cells = dl.children.filter((c): c is FakeElement => c instanceof FakeElement);
    const rows: string[] = [];
    for (let i = 0; i + 1 < cells.length; i += 2)
    {
        rows.push(`${(cells[i] as FakeElement).textContent}: ${(cells[i + 1] as FakeElement).textContent}`);
    }
    return rows;
};
const tick = (box: FakeElement, on: boolean): void =>
{
    box.checked = on;
    box.fire('change');
};
/** A recursive picture of an element: tags, attributes and texts (to compare two builds). */
function shape(element: FakeElement): string
{
    const attrs = [...element.descendants()].map((d) => `${d.tagName}[${['class', 'id', 'hidden', 'data-position', 'aria-labelledby'].map((a) => d.getAttribute(a) ?? '').join('|')}]`);
    return `${element.textContent}\n${attrs.join('\n')}`;
}

// ------------------------------------------------------------------ cards

describe('rebuilt cards in the list', () =>
{
    it('appear at their place in the timeline, before the email they were taken from, oldest first', () =>
    {
        const result = engineOf(LAST);
        show(result);
        expect(items().map((i) => i.getAttribute('data-rebuilt-id') ?? `#${i.getAttribute('data-position') ?? '?'}`)).toEqual(['2', '1', '0', '#0']);
        expect(rendered).toBe(1);
    });

    it('have no number, a "Rebuilt" label first in the heading, and the fixed note with the source number', () =>
    {
        const result = engineOf(LAST);
        show(result);
        for (const card of rebuiltItems())
        {
            expect(withClass(card, 'message-number')).toEqual([]);
            const heading = card.descendants().find((d) => d.tagName === 'h3') as FakeElement;
            expect(heading.getAttribute('id')).toBe(`rebuilt-${card.getAttribute('data-rebuilt-id') ?? ''}-title`);
            expect(heading.textContent.startsWith('Rebuilt ')).toBe(true);
            expect(one(card, 'rebuilt-label').textContent).toBe('Rebuilt');
            expect(metaRows(card)).toContain('Taken from: email #1');
        }
        const notes = rebuiltItems().map((c) => one(c, 'rebuilt-note').textContent);
        // The newest (an Outlook block, no ">" marks) keeps its text as it was; the Gmail quote
        // and the Outlook block inside it had their marks removed.
        expect(notes).toEqual([
            'Rebuilt from the quoted text in email #1. Quote marks removed; may be incomplete or inexact.',
            'Rebuilt from the quoted text in email #1. Quote marks removed; may be incomplete or inexact.',
            'Rebuilt from the quoted text in email #1. May be incomplete or inexact.',
        ]);
    });

    it('show the fields read from the quote and the rebuilt text, as text', () =>
    {
        const result = engineOf(LAST);
        show(result);
        const [outlookEn, gmail, outlookNl] = rebuiltItems();
        expect(one(outlookNl as FakeElement, 'message-subject').textContent).toBe('Re: Office desks and chairs');
        const nlRows = metaRows(outlookNl as FakeElement);
        expect(nlRows[0]).toMatch(/^Date: about 2025-03-03 \d\d:40 UTC-05:00 As written in the quote: maandag 3 maart 2025 15:40$/);
        expect(nlRows[1]).toBe('From: Alice Example <alice@example.test>');
        // An attribution has no subject: our own placeholder, marked as such.
        const subject = one(gmail as FakeElement, 'message-subject');
        expect(subject.textContent).toBe('(subject not in the quote)');
        expect(hasClass(subject, 'placeholder')).toBe(true);
        for (const [card, rebuiltEmail] of [outlookEn, gmail, outlookNl].map((c, k) => [c, rebuiltEntries(result)[k]] as const))
        {
            expect(one(card as FakeElement, 'body-text').textContent).toBe(rebuiltEmail?.rebuilt.reconstructedText);
        }
        expect(one(gmail as FakeElement, 'body-text').textContent).not.toMatch(/^>/m);
    });

    it('leave the source email exactly as it was without rebuilt emails (collapse, never delete)', () =>
    {
        const result = engineOf(LAST);
        show(withoutRebuilt(result));
        const before = shape(realItems()[0] as FakeElement);
        show(result);
        expect(realItems()).toHaveLength(1);
        expect(shape(realItems()[0] as FakeElement)).toBe(before);
        expect((realItems()[0] as FakeElement).textContent).toContain(fixture(LAST).bodyText.trim().split('\n')[0] ?? 'x');
    });

    it('say which other emails quote the same text, on the one card shown', () =>
    {
        const result = engineOf('12-order-3-alice-gmail.eml', LAST);
        show(result);
        const also = rebuiltItems().flatMap((c) => withClass(c, 'rebuilt-also').map((p) => p.textContent));
        expect(also.length).toBeGreaterThan(0);
        for (const text of also)
        {
            expect(text).toMatch(/^Same quoted text also in email #[12]\.$/);
        }
        expect(rebuiltAlsoText([2, 5])).toBe('Same quoted text also in emails #2, #5.');
        expect(rebuiltAlsoText([])).toBe('');
    });

    it('say "Unknown sender" and "(list may be incomplete)" when the quote says no more', () =>
    {
        const base = engineOf(LAST);
        const result = withRebuilt(base, 0, (r) => ({ ...r, rebuilt: { ...r.rebuilt, from: [], incomplete: ['to', 'cc'], cc: [] } }));
        show(result);
        const card = rebuiltItems().find((c) => c.getAttribute('data-rebuilt-id') === '0') as FakeElement;
        const rows = metaRows(card);
        expect(rows).toContain('From: Unknown sender');
        expect(rows.find((r) => r.startsWith('To: '))).toMatch(/^To: .+ \(list may be incomplete\)$/);
        expect(rows).toContain('Cc: (list may be incomplete)');
    });

    it('show the date again in another zone when the zone changes', () =>
    {
        show(engineOf(LAST));
        const card = rebuiltItems()[2] as FakeElement;
        const time = card.descendants().find((d) => d.tagName === 'time') as FakeElement;
        const before = time.textContent;
        const zone = byId('preview-zone');
        zone.value = 'Asia/Tokyo';
        zone.fire('change');
        expect(time.textContent).not.toBe(before);
        expect(time.textContent).toMatch(/^about 2025-03-0\d \d\d:40 UTC\+09:00$/);
        expect(time.getAttribute('datetime')).toMatch(/^2025-03-03T\d\d:40:00\.000Z$/);
    });

    it('write the dates as the quote allows: "about" for a guessed time only, a day as written (never "about", user decision Q2), an unreadable one only as written', () =>
    {
        const timestamp = Date.parse('2025-03-03T14:40:00Z');
        expect(rebuiltDateTexts({ kind: 'moment', utcMs: timestamp, approximate: false, text: 'x' }, 'UTC')).toEqual({
            main: '2025-03-03 14:40 UTC+00:00',
            iso: '2025-03-03T14:40:00.000Z',
            asWritten: 'As written in the quote: x',
        });
        expect(rebuiltDateTexts({ kind: 'moment', utcMs: timestamp, approximate: true, text: 'x' }, 'UTC').main).toBe('about 2025-03-03 14:40 UTC+00:00');
        expect(rebuiltDateTexts({ kind: 'day', day: '2025-03-03', approximate: true, text: '3 maart 2025' }, 'UTC')).toEqual({
            main: '2025-03-03',
            iso: '2025-03-03',
            asWritten: 'As written in the quote: 3 maart 2025',
        });
        expect(rebuiltDateTexts({ kind: 'day', day: '2025-03-03', approximate: false, text: '3 March 2025' }, 'UTC').main).toBe('2025-03-03');
        expect(rebuiltDateTexts({ kind: 'unreadable', text: 'gisteren' }, 'UTC')).toEqual({
            main: '(date could not be read)',
            iso: null,
            asWritten: 'As written in the quote: gisteren',
        });
        expect(rebuiltDateTexts({ kind: 'none' }, 'UTC')).toEqual({ main: '(no date)', iso: null, asWritten: null });
        expect(() => rebuiltNoteText({ sourceNumber: null, quoteMarksRemoved: false })).toThrow();
    });

    it('are written again in another language, in place', () =>
    {
        show(engineOf(LAST));
        const card = rebuiltItems()[1] as FakeElement;
        const box = one(card, 'include-checkbox');
        setLocale('fr');
        preview.relabel();
        review.relabel();
        expect(one(card, 'rebuilt-label').textContent).toBe(t('rebuilt.label'));
        expect(one(card, 'rebuilt-note').textContent).toBe(t('rebuilt.noteMarks', { number: '#1' }));
        expect(metaRows(card)).toContain(`${t('rebuilt.takenFrom')}: ${t('rebuilt.takenFromValue', { number: '#1' })}`);
        expect(byId('review-rebuilt').textContent).toBe(t('counts.rebuiltIncluded', { included: 3, count: 3 }));
        expect(one(card, 'include-checkbox')).toBe(box); // nothing rebuilt
        expect(t('rebuilt.label')).not.toBe('Rebuilt');
    });

    it('a rebuilt email with no text says it is not in the PDF, is not counted in, and has no slot (task 8.14, Q4)', () =>
    {
        const base = engineOf(LAST);
        const id = rebuiltEntries(base)[1]!.id;
        for (const text of ['', '\n  \n'])
        {
            const result = withRebuilt(base, id, (r) => ({ ...r, rebuilt: { ...r.rebuilt, reconstructedText: text } }));
            show(result);
            const card = rebuiltItems().find((c) => c.getAttribute('data-rebuilt-id') === String(id))!;
            expect(one(card, 'body-empty').textContent).toBe('Not in the PDF: this email has no text.');
            // White space only: still shown (nothing is dropped from the page).
            expect(withClass(card, 'body-text').map((e) => e.textContent)).toEqual(text === '' ? [] : [text]);
            // Its tick box stays (Q5); it is not counted in, and its "taken from" line is not shown.
            expect(one(card, 'include-checkbox').checked).toBe(true);
            expect(byId('review-rebuilt').textContent).toBe('2 of 3 rebuilt emails will be in the PDF.');
            const ids = rebuiltEntries(result).map((r) => r.id);
            const slots = planPdfOrder(result, [0], ids).slots.flatMap((s) => (s.kind === 'rebuilt' ? [s.entry.id] : []));
            expect(slots).toEqual(ids.filter((x) => x !== id));
            for (const locale of ['fr', 'nl'] as const)
            {
                setLocale(locale);
                preview.relabel();
                review.relabel();
                expect(one(card, 'body-empty').textContent).toBe(t('preview.notInPdfNoText'));
            }
            setLocale('en');
            preview.relabel();
            review.relabel();
        }
        // Another card keeps its text and no note.
        show(base);
        for (const card of rebuiltItems())
        {
            expect(withClass(card, 'body-empty')).toEqual([]);
        }
    });

    it('give a stand-in with its label, a note and its text when a card cannot be built; the list is still complete', () =>
    {
        const base = engineOf(LAST);
        const result = withRebuilt(base, 1, (r) => ({ ...r, sourceIndex: 99 }));
        show(result);
        expect(items()).toHaveLength(4);
        const standIn = rebuiltItems()[1] as FakeElement;
        expect(hasClass(standIn, 'message-failed')).toBe(true);
        expect(one(standIn, 'message-failed-note').textContent).toBe(t('rebuilt.itemFailed'));
        expect(one(standIn, 'body-text').textContent).toBe(base.reconstructed[1]?.rebuilt.reconstructedText);
        expect(rendered).toBe(1);
    });
});

// ------------------------------------------------------------------ switch, ticks, counts

describe('the switch, the checkboxes and the counts', () =>
{
    it('show no switch and no rebuilt count when nothing was rebuilt', () =>
    {
        show(engineOf('10-order-1-alice.eml'));
        expect(isHidden(byId('rebuilt-switch'))).toBe(true);
        expect(isHidden(byId('review-rebuilt'))).toBe(true);
        expect(byId('review-messages').textContent).toBe('1 email found.');
    });

    it('explain under the switch what rebuilt emails are, read as its description, in the page language (task 8.8)', () =>
    {
        show(engineOf(LAST));
        const explain = byId('rebuilt-explain');
        expect(isHidden(byId('rebuilt-switch'))).toBe(false);
        expect(isHidden(explain)).toBe(false);
        expect(explain.textContent).toBe(
            'Rebuilt emails are earlier emails that the tool rebuilt from the text quoted in a reply. They may be incomplete or inexact, so check them before you make the PDF.',
        );
        expect(byId('rebuilt-include-all').getAttribute('aria-describedby')).toBe('rebuilt-explain');
        // Inside the switch's own field, so it is hidden with it when nothing was rebuilt.
        expect(byId('rebuilt-switch').descendants()).toContain(explain);
        setLocale('fr');
        review.relabel();
        expect(explain.textContent).toBe(t('rebuilt.explain'));
        expect(explain.textContent).toContain('peuvent être incomplets ou inexacts');
        setLocale('nl');
        review.relabel();
        expect(explain.textContent).toContain('onvolledig of onnauwkeurig');
    });

    it('include every rebuilt email by default, and count them', () =>
    {
        show(engineOf(LAST));
        expect(isHidden(byId('rebuilt-switch'))).toBe(false);
        expect(byId('rebuilt-include-all').checked).toBe(true);
        expect(byId('review-messages').textContent).toBe('1 email found, 3 earlier emails rebuilt from quoted text.');
        expect(byId('review-rebuilt').textContent).toBe('3 of 3 rebuilt emails will be in the PDF.');
        expect(byId('review-included').textContent).toBe('1 of 1 email will be in the PDF.');
        expect(review.includedRebuilt().map((r) => r.id)).toEqual([2, 1, 0]);
        for (const card of rebuiltItems())
        {
            expect(card.getAttribute('data-included')).toBe('true');
            expect(one(card, 'include-checkbox').checked).toBe(true);
        }
    });

    it('the switch leaves ALL rebuilt emails out (their cards leave the list) and brings them back', () =>
    {
        show(engineOf(LAST));
        const all = byId('rebuilt-include-all');
        tick(all, false);
        expect(rebuiltItems().every(isHidden)).toBe(true);
        expect(realItems().some(isHidden)).toBe(false);
        expect(review.rebuiltShown()).toBe(false);
        expect(review.includedRebuilt()).toEqual([]);
        // Off: the counts do not mention rebuilt emails at all, and the emails line is announced instead (so no older rebuilt line stays in the status line).
        expect(byId('review-rebuilt').textContent).toBe('');
        expect(isHidden(byId('review-rebuilt'))).toBe(true);
        expect(byId('review-messages').textContent).toBe('1 email found.');
        expect(announced).toEqual(['1 of 1 email will be in the PDF.']);
        expect(isHidden(byId('rebuilt-switch'))).toBe(false); // still there, to turn it back on
        expect(review.includedPositions()).toEqual([0]); // the real email is not touched
        tick(all, true);
        expect(rebuiltItems().some(isHidden)).toBe(false);
        expect(review.includedRebuilt()).toHaveLength(3);
        expect(announced.at(-1)).toBe('3 of 3 rebuilt emails will be in the PDF.');
        expect(isHidden(byId('review-rebuilt'))).toBe(false);
        expect(byId('review-messages').textContent).toBe('1 email found, 3 earlier emails rebuilt from quoted text.');
    });

    it('a card unticked stays in the list, dimmed and marked "Not in the PDF"', () =>
    {
        show(engineOf(LAST));
        const card = rebuiltItems()[0] as FakeElement;
        tick(one(card, 'include-checkbox'), false);
        expect(isHidden(card)).toBe(false);
        expect(card.getAttribute('data-included')).toBe('false');
        expect(isHidden(one(card, 'excluded-note'))).toBe(false);
        expect(review.includedRebuilt().map((r) => r.id)).toEqual([1, 0]);
        // Reported as unticked by the reader (task 8.13a review round 2); none while the switch is off.
        expect(review.untickedRebuilt()).toEqual([2]);
        tick(byId('rebuilt-include-all'), false);
        expect(review.untickedRebuilt()).toEqual([]);
        tick(byId('rebuilt-include-all'), true);
        expect(review.untickedRebuilt()).toEqual([2]);
        expect(byId('review-rebuilt').textContent).toBe('2 of 3 rebuilt emails will be in the PDF.');
        expect(byId('review-included').textContent).toBe('1 of 1 email will be in the PDF.');
        // Its checkbox is named by its label and its heading.
        expect(one(card, 'include-checkbox').getAttribute('aria-labelledby')).toBe('include-rebuilt-2-label rebuilt-2-title');
    });

    it('follow the email they were taken from: unticking it marks them "Not in the PDF" and counts them out (user decision Q1 (a))', () =>
    {
        const changes: string[] = [];
        mount({}, { onChange: (line) => changes.push(line) });
        show(engineOf(LAST));
        const own = one(rebuiltItems()[0] as FakeElement, 'include-checkbox');
        tick(own, false);
        const source = one(realItems()[0] as FakeElement, 'include-checkbox');
        tick(source, false);
        expect(byId('review-included').textContent).toBe('0 of 1 email will be in the PDF.');
        expect(byId('review-rebuilt').textContent).toBe('0 of 3 rebuilt emails will be in the PDF.');
        // One announcement with both lines (the rebuilt line changed too).
        expect(changes).toEqual(['0 of 1 email will be in the PDF. 0 of 3 rebuilt emails will be in the PDF.']);
        expect(review.includedRebuilt()).toEqual([]);
        // Only the card unticked by itself is reported as unticked; the others are out because of their source.
        expect(review.untickedRebuilt()).toEqual([2]);
        for (const card of rebuiltItems())
        {
            expect(isHidden(card)).toBe(false);
            expect(card.getAttribute('data-included')).toBe('false');
            expect(isHidden(one(card, 'excluded-note'))).toBe(false);
        }
        // Each card keeps its own tick; the mark says why it is out.
        expect(rebuiltItems().map((c) => one(c, 'include-checkbox').checked)).toEqual([false, true, true]);
        expect(rebuiltItems().map((c) => one(c, 'excluded-note').textContent)).toEqual([
            'Not in the PDF',
            'Not in the PDF: the email it comes from is left out',
            'Not in the PDF: the email it comes from is left out',
        ]);
        // The words follow the page language.
        setLocale('fr');
        review.relabel();
        expect(one(rebuiltItems()[1] as FakeElement, 'excluded-note').textContent).toBe(t('rebuilt.sourceExcluded'));
        expect(t('rebuilt.sourceExcluded')).toMatch(/^Pas dans le PDF/);
        setLocale('en');
        review.relabel();
        // Ticked again: back in, except the one unticked by itself.
        tick(source, true);
        expect(review.includedRebuilt().map((r) => r.id)).toEqual([1, 0]);
        expect(rebuiltItems().map((c) => c.getAttribute('data-included'))).toEqual(['false', 'true', 'true']);
        expect(isHidden(one(rebuiltItems()[1] as FakeElement, 'excluded-note'))).toBe(true);
        expect(changes.at(-1)).toBe('1 of 1 email will be in the PDF. 2 of 3 rebuilt emails will be in the PDF.');
    });

    it('a text quoted in two emails stays in while one of them is ticked (follow-source rule)', () =>
    {
        const result = engineOf('12-order-3-alice-gmail.eml', LAST);
        show(result);
        const shared = rebuiltEntries(result).filter((e) => e.copies.length > 0);
        expect(shared.length).toBeGreaterThan(0);
        const boxOf = (position: number): FakeElement =>
            one(realItems().find((i) => i.getAttribute('data-position') === String(position)) as FakeElement, 'include-checkbox');
        const cardOf = (id: number): FakeElement => rebuiltItems().find((c) => c.getAttribute('data-rebuilt-id') === String(id)) as FakeElement;
        const rebuiltEmail = shared[0]!;
        const own = result.positionByIndex[rebuiltEmail.sourceIndex]!;
        const other = result.positionByIndex[result.reconstructed[rebuiltEmail.copies[0]!]!.sourceIndex]!;
        tick(boxOf(own), false);
        expect(cardOf(rebuiltEmail.id).getAttribute('data-included')).toBe('true');
        expect(review.includedRebuilt().map((r) => r.id)).toContain(rebuiltEmail.id);
        tick(boxOf(other), false);
        expect(cardOf(rebuiltEmail.id).getAttribute('data-included')).toBe('false');
        expect(review.includedRebuilt()).toEqual([]);
    });

    it('say "In the PDF: taken from #K" only when the PDF takes the card from a copy in another email (task 7.7 review)', () =>
    {
        const result = engineOf('12-order-3-alice-gmail.eml', LAST);
        show(result);
        const rebuiltEmail = rebuiltEntries(result).find((x) => x.copies.length > 0)!;
        const own = result.positionByIndex[rebuiltEmail.sourceIndex]!;
        const other = result.positionByIndex[result.reconstructed[rebuiltEmail.copies[0]!]!.sourceIndex]!;
        expect(other).not.toBe(own);
        const boxOf = (position: number): FakeElement =>
            one(realItems().find((i) => i.getAttribute('data-position') === String(position)) as FakeElement, 'include-checkbox');
        const card = rebuiltItems().find((c) => c.getAttribute('data-rebuilt-id') === String(rebuiltEmail.id)) as FakeElement;
        const line = one(card, 'rebuilt-pdf-source');
        // Both emails ticked: the PDF takes it from its own email, the one its card names; no line.
        expect(isHidden(line)).toBe(true);
        for (const card of rebuiltItems())
        {
            expect(isHidden(one(card, 'rebuilt-pdf-source'))).toBe(true);
        }
        // Its own email unticked: still in the PDF, taken from the other email; the card says which.
        tick(boxOf(own), false);
        expect(card.getAttribute('data-included')).toBe('true');
        expect(metaRows(card)).toContain(`Taken from: email #${String(own + 1)}`);
        expect(isHidden(line)).toBe(false);
        expect(line.textContent).toBe(`In the PDF: taken from #${String(other + 1)}`);
        // The same email as the PDF itself picks (planPdfOrder, from the same choices).
        const slot = planPdfOrder(result, review.includedPositions(), review.includedRebuilt().map((r) => r.id)).slots.find(
            (s) => s.kind === 'rebuilt' && s.entry.id === rebuiltEmail.id,
        );
        expect(slot?.kind === 'rebuilt' ? slot.source.shown.position : null).toBe(other);
        // Written again in the page language.
        setLocale('fr');
        review.relabel();
        expect(line.textContent).toBe(t('rebuilt.pdfSource', { number: `#${String(other + 1)}` }));
        expect(line.textContent).toMatch(/^Dans le PDF/);
        setLocale('en');
        review.relabel();
        // Out of the PDF (the card unticked, or every source unticked): no line.
        tick(one(card, 'include-checkbox'), false);
        expect(isHidden(line)).toBe(true);
        tick(one(card, 'include-checkbox'), true);
        expect(isHidden(line)).toBe(false);
        tick(boxOf(other), false);
        expect(card.getAttribute('data-included')).toBe('false');
        expect(isHidden(line)).toBe(true);
        // Its own email ticked again: taken from it again; no line.
        tick(boxOf(own), true);
        expect(card.getAttribute('data-included')).toBe('true');
        expect(isHidden(line)).toBe(true);
        expect(line.textContent).toBe('');
    });

    it('"Print full original text" ticked: the switch is unticked and disabled, every card leaves the list, none in the PDF; unticked: exactly as before (user decision 2026-10-29, task 7.8c)', () =>
    {
        let everything = false;
        mount({}, { unfoldEverything: () => everything });
        /** What Source/web-page/mount-page.ts does after the full-text checkbox changed. */
        const changed = (): string =>
        {
            const line = review.everythingChanged();
            preview.refreshRebuilt();
            return line;
        };
        const result = engineOf('12-order-3-alice-gmail.eml', LAST);
        show(result);
        // A state worth restoring: one card unticked, and one card taken from a copy (its own email unticked).
        const rebuiltEmail = rebuiltEntries(result).find((x) => x.copies.length > 0)!;
        const own = result.positionByIndex[rebuiltEmail.sourceIndex]!;
        const boxOf = (position: number): FakeElement =>
            one(realItems().find((i) => i.getAttribute('data-position') === String(position)) as FakeElement, 'include-checkbox');
        tick(boxOf(own), false);
        const other = rebuiltItems().find((c) => c.getAttribute('data-rebuilt-id') !== String(rebuiltEmail.id))!;
        tick(one(other, 'include-checkbox'), false);
        const snapshot = (): string[] =>
            rebuiltItems().map(
                (c) =>
                    `${String(one(c, 'include-checkbox').checked)}|${c.getAttribute('data-included') ?? ''}|${String(isHidden(c))}|${String(isHidden(one(c, 'excluded-note')))}|${one(c, 'excluded-note').textContent}|${String(isHidden(one(c, 'rebuilt-pdf-source')))}|${one(c, 'rebuilt-pdf-source').textContent}`,
            );
        const before = snapshot();
        const beforeIds = review.includedRebuilt().map((r) => r.id);
        const beforeLine = byId('review-rebuilt').textContent;
        const beforePositions = review.includedPositions();
        const count = rebuiltItems().length;
        const all = byId('rebuilt-include-all');
        const hint = byId('rebuilt-off-hint');
        expect(beforeIds.length).toBeGreaterThan(0);
        expect(before.some((s) => s.includes('|In the PDF: taken from #'))).toBe(true);
        expect(all.checked).toBe(true);
        expect(all.hasAttribute('disabled')).toBe(false);
        expect(all.getAttribute('aria-describedby')).toBe('rebuilt-explain');
        expect(isHidden(hint)).toBe(true);
        expect(hint.textContent).toBe(t('rebuilt.offWhileFullText'));

        const beforeMessages = byId('review-messages').textContent;
        expect(beforeMessages).toBe(`2 emails found, ${String(count)} earlier emails rebuilt from quoted text.`);

        everything = true;
        // Nothing about rebuilt emails is said or counted while it is ticked: the emails line is announced instead.
        expect(changed()).toBe('1 of 2 emails will be in the PDF.');
        expect(byId('review-rebuilt').textContent).toBe('');
        expect(isHidden(byId('review-rebuilt'))).toBe(true);
        expect(byId('review-messages').textContent).toBe('2 emails found.');
        expect(review.includedRebuilt()).toEqual([]);
        expect(review.rebuiltShown()).toBe(false);
        // The switch: unticked, disabled, described by the hint (never shown itself).
        expect(all.checked).toBe(false);
        expect(all.hasAttribute('disabled')).toBe(true);
        expect(all.getAttribute('aria-describedby')).toBe('rebuilt-off-hint rebuilt-explain');
        expect(isHidden(hint)).toBe(true);
        expect(isHidden(byId('rebuilt-switch'))).toBe(false);
        // Every card leaves the list, exactly as with the switch off; none is dimmed and left in instead.
        expect(rebuiltItems().every(isHidden)).toBe(true);
        for (const card of rebuiltItems())
        {
            expect(card.getAttribute('data-included')).toBe('false');
        }
        // The real emails are not touched; their cards (with every character of their text) stay.
        expect(realItems().some(isHidden)).toBe(false);
        expect(review.includedPositions()).toEqual(beforePositions);
        // Every card's own tick is kept.
        expect(rebuiltItems().map((c) => one(c, 'include-checkbox').checked)).toEqual(before.map((s) => s.startsWith('true')));
        // A real email ticked meanwhile: still no rebuilt email shown or in the PDF.
        tick(boxOf(own), true);
        expect(review.includedRebuilt()).toEqual([]);
        expect(rebuiltItems().every(isHidden)).toBe(true);
        tick(boxOf(own), false);
        // Written again in the page language.
        setLocale('nl');
        review.relabel();
        expect(hint.textContent).toBe(t('rebuilt.offWhileFullText'));
        expect(hint.textContent).toMatch(/^Niet beschikbaar zolang/);
        expect(all.hasAttribute('disabled')).toBe(true);
        // The language change does not bring the rebuilt part of the counts back.
        expect(byId('review-messages').textContent).toBe(messagesText(result.counts));
        expect(isHidden(byId('review-rebuilt'))).toBe(true);
        setLocale('en');
        review.relabel();
        expect(byId('review-messages').textContent).toBe('2 emails found.');

        everything = false;
        expect(changed()).toBe(beforeLine);
        expect(byId('review-messages').textContent).toBe(beforeMessages);
        expect(isHidden(byId('review-rebuilt'))).toBe(false);
        expect(all.checked).toBe(true);
        expect(all.hasAttribute('disabled')).toBe(false);
        expect(all.getAttribute('aria-describedby')).toBe('rebuilt-explain');
        expect(snapshot()).toEqual(before);
        expect(review.includedRebuilt().map((r) => r.id)).toEqual(beforeIds);
        expect(review.rebuiltShown()).toBe(true);
    });

    it('"Print full original text" ticked while the switch was off, then unticked: the switch stays off (task 7.8c)', () =>
    {
        let everything = false;
        mount({}, { unfoldEverything: () => everything });
        const changed = (): string =>
        {
            const line = review.everythingChanged();
            preview.refreshRebuilt();
            return line;
        };
        show(engineOf(LAST));
        tick(one(rebuiltItems()[1] as FakeElement, 'include-checkbox'), false);
        const all = byId('rebuilt-include-all');
        tick(all, false);
        expect(rebuiltItems().every(isHidden)).toBe(true);
        everything = true;
        expect(changed()).toBe('1 of 1 email will be in the PDF.');
        expect(all.checked).toBe(false);
        expect(all.hasAttribute('disabled')).toBe(true);
        everything = false;
        // Still off: nothing about rebuilt emails.
        expect(changed()).toBe('1 of 1 email will be in the PDF.');
        expect(isHidden(byId('review-rebuilt'))).toBe(true);
        expect(byId('review-messages').textContent).toBe('1 email found.');
        expect(all.checked).toBe(false);
        expect(all.hasAttribute('disabled')).toBe(false);
        expect(rebuiltItems().every(isHidden)).toBe(true);
        expect(review.includedRebuilt()).toEqual([]);
        // Turned on by the reader: the cards come back with their own ticks.
        tick(all, true);
        expect(byId('review-messages').textContent).toBe('1 email found, 3 earlier emails rebuilt from quoted text.');
        expect(byId('review-rebuilt').textContent).toBe('2 of 3 rebuilt emails will be in the PDF.');
        expect(rebuiltItems().some(isHidden)).toBe(false);
        expect(rebuiltItems().map((c) => one(c, 'include-checkbox').checked)).toEqual([true, false, true]);
        expect(review.includedRebuilt()).toHaveLength(2);
    });

    it('a new result while "Print full original text" is ticked keeps the switch disabled; "Clear everything" enables it again (task 7.8c)', () =>
    {
        let everything = false;
        mount({}, { unfoldEverything: () => everything });
        show(engineOf(LAST));
        everything = true;
        review.everythingChanged();
        preview.refreshRebuilt();
        show(engineOf('70-no-date.eml', LAST));
        const all = byId('rebuilt-include-all');
        expect(all.checked).toBe(false);
        expect(all.hasAttribute('disabled')).toBe(true);
        expect(rebuiltItems()).toHaveLength(3);
        expect(rebuiltItems().every(isHidden)).toBe(true);
        expect(review.includedRebuilt()).toEqual([]);
        preview.reset();
        review.reset();
        everything = false; // pdfLabels.reset unticks it right after (Source/web-page/mount-page.ts)
        expect(all.checked).toBe(true);
        expect(all.hasAttribute('disabled')).toBe(false);
        expect(all.getAttribute('aria-describedby')).toBe('rebuilt-explain');
    });

    it('everythingChanged gives no line when nothing was rebuilt', () =>
    {
        mount({}, { unfoldEverything: () => true });
        show(engineOf('10-order-1-alice.eml'));
        expect(review.everythingChanged()).toBe('');
    });

    it('keep the choices when files are added, and forget them on "Clear everything"', () =>
    {
        show(engineOf(LAST));
        tick(one(rebuiltItems()[0] as FakeElement, 'include-checkbox'), false);
        tick(byId('rebuilt-include-all'), false);
        show(engineOf('70-no-date.eml', LAST));
        expect(byId('rebuilt-include-all').checked).toBe(false);
        expect(rebuiltItems().every(isHidden)).toBe(true);
        tick(byId('rebuilt-include-all'), true);
        expect(review.includedRebuilt()).toHaveLength(2);
        preview.reset();
        review.reset();
        expect(byId('rebuilt-include-all').checked).toBe(true);
        expect(isHidden(byId('rebuilt-switch'))).toBe(true);
        show(engineOf(LAST));
        expect(review.includedRebuilt()).toHaveLength(3);
    });

    it('counts a rebuilt card the page could not decorate as included once the list is complete (never silently left out), and hides it with the switch', () =>
    {
        let broken = false;
        mount({
            decorateRebuilt: (item, rebuiltEmail, result) =>
            {
                if (broken && rebuiltEmail.id === 0)
                {
                    throw new Error('boom');
                }
                review.decorateRebuilt(item, rebuiltEmail, result);
            },
        });
        show(engineOf(LAST));
        tick(one(rebuiltItems()[2] as FakeElement, 'include-checkbox'), false);
        expect(review.includedRebuilt().map((r) => r.id)).toEqual([2, 1]);
        expect(review.untickedRebuilt()).toEqual([0]);
        // The same files again, but this card's checkbox cannot be added: its plain stand-in shows no
        // checkbox and no "Not in the PDF" mark, so it counts as included.
        broken = true;
        show(engineOf(LAST));
        const standIn = rebuiltItems()[2] as FakeElement;
        expect(hasClass(standIn, 'message-failed')).toBe(true);
        expect(withClass(standIn, 'include-checkbox')).toEqual([]);
        expect(review.includedRebuilt().map((r) => r.id)).toEqual([2, 1, 0]);
        // Its kept choice is unticked, but the reader cannot see it: never reported as unticked (task 8.13a review round 2).
        expect(review.untickedRebuilt()).toEqual([]);
        expect(byId('review-rebuilt').textContent).toBe('3 of 3 rebuilt emails will be in the PDF.');
        // The switch leaves it out with the others: off -> the stand-in is hidden too, on -> shown again.
        const all = byId('rebuilt-include-all');
        tick(all, false);
        expect(byId('review-rebuilt').textContent).toBe('');
        expect(isHidden(byId('review-rebuilt'))).toBe(true);
        expect(byId('review-messages').textContent).toBe('1 email found.');
        expect(isHidden(standIn)).toBe(true);
        expect(rebuiltItems().every(isHidden)).toBe(true);
        expect(realItems().some(isHidden)).toBe(false);
        // Files added while the switch is off: the new stand-in is hidden as it is put in the list.
        show(engineOf(LAST));
        const newStandIn = rebuiltItems()[2] as FakeElement;
        expect(newStandIn).not.toBe(standIn);
        expect(hasClass(newStandIn, 'message-failed')).toBe(true);
        expect(rebuiltItems().every(isHidden)).toBe(true);
        // A new result while off: still nothing about rebuilt emails in the counts.
        expect(isHidden(byId('review-rebuilt'))).toBe(true);
        expect(byId('review-messages').textContent).toBe('1 email found.');
        tick(all, true);
        expect(isHidden(newStandIn)).toBe(false);
        expect(rebuiltItems().some(isHidden)).toBe(false);
        expect(byId('review-rebuilt').textContent).toBe('3 of 3 rebuilt emails will be in the PDF.');
        expect(byId('review-messages').textContent).toBe('1 email found, 3 earlier emails rebuilt from quoted text.');
    });

    it('a language change while the switch is off does not bring back the rebuilt part of the counts (task 7.8c)', () =>
    {
        show(engineOf(LAST));
        const all = byId('rebuilt-include-all');
        tick(all, false);
        setLocale('nl');
        review.relabel();
        expect(byId('review-messages').textContent).toBe(messagesText(engineOf(LAST).counts));
        expect(byId('review-messages').textContent).not.toBe(messagesText(engineOf(LAST).counts, 3));
        expect(byId('review-rebuilt').textContent).toBe('');
        expect(isHidden(byId('review-rebuilt'))).toBe(true);
        // Back on (still in Dutch): the rebuilt part comes back, in the page language.
        tick(all, true);
        expect(byId('review-messages').textContent).toBe(messagesText(engineOf(LAST).counts, 3));
        expect(byId('review-rebuilt').textContent).toBe(t('counts.rebuiltIncluded', { included: 3, count: 3 }));
        setLocale('en');
        review.relabel();
        expect(byId('review-messages').textContent).toBe('1 email found, 3 earlier emails rebuilt from quoted text.');
    });

    it('messagesText adds the rebuilt count only when there is one', () =>
    {
        const counts = engineOf(LAST).counts;
        expect(messagesText(counts)).toBe('1 email found.');
        expect(messagesText(counts, 1)).toBe('1 email found, 1 earlier email rebuilt from quoted text.');
    });
});

describe('problems while rebuilding', () =>
{
    it('are a calm note on the email whose quote could not (all) be rebuilt, counted with the notes', () =>
    {
        const base = engineOf('10-order-1-alice.eml');
        const email = base.messages[0];
        if (email === undefined)
        {
            throw new Error('no message');
        }
        show({ ...base, reconstructionWarnings: [{ index: email.index, code: 'reconstruct-limit' }] });
        const notes = withClass(realItems()[0] as FakeElement, 'message-note').map((n) => n.textContent);
        expect(notes).toEqual([t('warnings.rebuild.reconstruct-limit')]);
        expect(byId('review-notes').textContent).toBe('1 email has notes, shown with it below.');
        expect(noteText({ kind: 'rebuild', code: 'reconstruct-failed' })).toBe(t('warnings.rebuild.reconstruct-failed'));
    });

    /** LAST (3 rebuilt emails) with a "could not (all) be rebuilt" note on its email, and optionally a parse note too. */
    const withRebuildNote = (code: 'reconstruct-failed' | 'reconstruct-limit', parseNote = false): EngineResult =>
    {
        const base = engineOf(LAST);
        const email = base.messages[0];
        if (email === undefined)
        {
            throw new Error('no message');
        }
        const messages = parseNote ? [{ ...email, parserWarnings: [...email.parserWarnings, 'html-body-truncated' as const] }] : base.messages;
        return { ...base, messages, reconstructionWarnings: [{ index: email.index, code }] };
    };
    const notesOf = (item: FakeElement): FakeElement[] => withClass(item, 'message-note');
    const notesListOf = (item: FakeElement): FakeElement => one(item, 'message-notes');

    it.each(['reconstruct-failed', 'reconstruct-limit'] as const)(
        'the "%s" note is hidden and not counted while the switch is off, and back when it is on (PM decision, task 7.8c)',
        (code) =>
        {
            show(withRebuildNote(code));
            const item = realItems()[0] as FakeElement;
            expect(notesOf(item).map((n) => n.textContent)).toEqual([t(`warnings.rebuild.${code}`)]);
            expect(isHidden(notesListOf(item))).toBe(false);
            expect(byId('review-notes').textContent).toBe('1 email has notes, shown with it below.');
            const all = byId('rebuilt-include-all');
            tick(all, false);
            expect(notesOf(item).every(isHidden)).toBe(true);
            expect(isHidden(notesListOf(item))).toBe(true); // nothing left in the list
            expect(byId('review-notes').textContent).toBe('');
            expect(isHidden(byId('review-notes'))).toBe(true);
            // A language change keeps them hidden.
            setLocale('nl');
            review.relabel();
            expect(notesOf(item).every(isHidden)).toBe(true);
            expect(isHidden(byId('review-notes'))).toBe(true);
            setLocale('en');
            review.relabel();
            tick(all, true);
            expect(notesOf(item).some(isHidden)).toBe(false);
            expect(isHidden(notesListOf(item))).toBe(false);
            expect(byId('review-notes').textContent).toBe('1 email has notes, shown with it below.');
            expect(isHidden(byId('review-notes'))).toBe(false);
        },
    );

    it('the "could not be rebuilt" note is hidden and not counted while "Print full original text" is ticked; other notes stay (task 7.8c)', () =>
    {
        let everything = false;
        mount({}, { unfoldEverything: () => everything });
        show(withRebuildNote('reconstruct-limit', true));
        const item = realItems()[0] as FakeElement;
        const texts = [t('warnings.parse.html-body-truncated'), t('warnings.rebuild.reconstruct-limit')];
        expect(notesOf(item).map((n) => n.textContent)).toEqual(texts);
        everything = true;
        review.everythingChanged();
        // The parse note stays, so the email still has notes and is still counted.
        expect(notesOf(item).map((n) => `${n.textContent}|${String(isHidden(n))}`)).toEqual([`${texts[0]}|false`, `${texts[1]}|true`]);
        expect(isHidden(notesListOf(item))).toBe(false);
        expect(byId('review-notes').textContent).toBe('1 email has notes, shown with it below.');
        everything = false;
        review.everythingChanged();
        expect(notesOf(item).some(isHidden)).toBe(false);
    });

    it('an email whose only note is "could not be rebuilt", put in the list while the switch is off, shows no note and is not counted', () =>
    {
        show(engineOf(LAST));
        tick(byId('rebuilt-include-all'), false);
        // New files (the whole set is run again) while the switch is off.
        show(withRebuildNote('reconstruct-failed'));
        const item = realItems()[0] as FakeElement;
        expect(notesOf(item).every(isHidden)).toBe(true);
        expect(isHidden(notesListOf(item))).toBe(true);
        expect(isHidden(byId('review-notes'))).toBe(true);
        tick(byId('rebuilt-include-all'), true);
        expect(notesOf(item).some(isHidden)).toBe(false);
        expect(byId('review-notes').textContent).toBe('1 email has notes, shown with it below.');
    });

    /** One email with nothing rebuilt, only a "could not be rebuilt" note. */
    const notesOnly = (): EngineResult =>
    {
        const base = engineOf('10-order-1-alice.eml');
        const email = base.messages[0];
        if (email === undefined)
        {
            throw new Error('no message');
        }
        return { ...base, reconstructionWarnings: [{ index: email.index, code: 'reconstruct-failed' }] };
    };

    it('the switch stays shown for a note-only result while it is off, so the note can be shown again (task 7.8c review)', () =>
    {
        show(engineOf(LAST));
        tick(byId('rebuilt-include-all'), false);
        show(notesOnly());
        expect(rebuiltItems()).toHaveLength(0);
        const all = byId('rebuilt-include-all');
        expect(isHidden(byId('rebuilt-switch'))).toBe(false);
        expect(isHidden(all)).toBe(false);
        expect(all.checked).toBe(false);
        const item = realItems()[0] as FakeElement;
        expect(notesOf(item).every(isHidden)).toBe(true);
        expect(isHidden(byId('review-notes'))).toBe(true);
        tick(all, true);
        expect(notesOf(item).map((n) => `${n.textContent}|${String(isHidden(n))}`)).toEqual([`${t('warnings.rebuild.reconstruct-failed')}|false`]);
        expect(byId('review-notes').textContent).toBe('1 email has notes, shown with it below.');
        // Announced: the "N of M emails will be in the PDF" line (there is no rebuilt line).
        expect(announced.at(-1)).toBe(byId('review-included').textContent);
        expect(announced.at(-1)).not.toBe('');
    });

    it('the switch is shown, ticked, for a note-only result while it is on (task 7.8c review)', () =>
    {
        show(notesOnly());
        const all = byId('rebuilt-include-all');
        expect(isHidden(byId('rebuilt-switch'))).toBe(false);
        expect(isHidden(all)).toBe(false);
        expect(all.checked).toBe(true);
        const item = realItems()[0] as FakeElement;
        expect(notesOf(item).some(isHidden)).toBe(false);
        expect(byId('review-notes').textContent).toBe('1 email has notes, shown with it below.');
        expect(isHidden(byId('review-rebuilt'))).toBe(true);
    });

    it('the switch is hidden when nothing was rebuilt and no email has a "could not be rebuilt" note', () =>
    {
        show(engineOf('10-order-1-alice.eml'));
        expect(isHidden(byId('rebuilt-switch'))).toBe(true);
        expect(isHidden(byId('rebuilt-include-all'))).toBe(true);
    });
});
