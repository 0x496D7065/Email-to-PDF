// Unit tests for the cards of emails rebuilt from quoted text in step 2
// (src/ui/preview.ts builds them, src/ui/review.ts adds their checkboxes,
// the switch and the counts), in Node with the recording fake DOM
// (tests/support/fake-dom.ts), wired like src/ui/page.ts. Synthetic
// fixtures only (tests/fixtures/eml), run through the real engine. The real
// page is checked in the browsers by e2e/rebuilt.spec.ts.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDocument, FakeElement } from '../../tests/support/fake-dom';
import { parseAllFixtures } from '../../tests/fixtures/parse-all';
import { runEngine, type EngineRebuilt, type EngineResult } from '../engine/engine';
import type { NormalizedMessage } from '../parsing/types';
import { planPdfOrder } from '../pdf/model';
import { rebuiltEntries } from '../ui-model/rebuilt';
import { setLocale, t } from './i18n';
import { mountPreview, rebuiltAlsoText, rebuiltDateTexts, rebuiltNoteText, type Preview, type PreviewOptions } from './preview';
import { createReview, messagesText, noteText, type Review, type ReviewOptions } from './review';

// ------------------------------------------------------------------ data

let fixtures: Map<string, NormalizedMessage>;
beforeAll(async () => {
  fixtures = new Map((await parseAllFixtures()).map((m) => [m.source.fileName, m]));
});
const fixture = (name: string): NormalizedMessage => {
  const m = fixtures.get(`eml/${name}`);
  if (m === undefined) throw new Error(`no fixture ${name}`);
  return m;
};
const engineOf = (...names: string[]): EngineResult => runEngine(names.map((n) => ({ ok: true as const, message: fixture(n) })));
/** The last email of a thread alone: 3 earlier emails rebuilt from its quote. */
const LAST = '13-order-4-bob-outlook-nl.eml';

/** A copy of `result` with rebuilt message `id` changed by `edit`. */
function withRebuilt(result: EngineResult, id: number, edit: (r: EngineRebuilt) => EngineRebuilt): EngineResult {
  return { ...result, reconstructed: result.reconstructed.map((r) => (r.id === id ? edit(r) : r)) };
}
/** The same result without anything rebuilt (as before task 7.6). */
const withoutRebuilt = (result: EngineResult): EngineResult => ({
  ...result,
  reconstructed: [],
  timeline: result.messages.map((_, position) => ({ kind: 'message' as const, position })),
});

// ------------------------------------------------------------------ fake page

let doc: FakeDocument;
let area: FakeElement;
let preview: Preview;
let review: Review;
let announced: string[];
let rendered: number;

/** Builds step 2 like src/ui/page.ts (the switch in the toolbar). */
function mount(options: PreviewOptions = {}, reviewOptions: ReviewOptions = {}): void {
  area = new FakeElement('div');
  announced = [];
  rendered = 0;
  review = createReview({
    onRebuiltChange: (line) => {
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
      rebuiltShown: () => review.rebuiltIncludeAll(),
      onRendered: (result) => {
        rendered++;
        review.rendered(result);
      },
      ...options,
    },
  );
}

function show(result: EngineResult): void {
  review.show(result);
  preview.show(result);
}

beforeEach(() => {
  doc = new FakeDocument();
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', { innerHeight: 600 });
  setLocale('en');
  mount();
});

afterEach(() => {
  preview.reset();
  setLocale('en');
  vi.unstubAllGlobals();
});

const hasClass = (e: FakeElement, name: string): boolean => (e.getAttribute('class') ?? '').split(' ').includes(name);
const withClass = (root: FakeElement, name: string): FakeElement[] => root.descendants().filter((e) => hasClass(e, name));
const one = (root: FakeElement, name: string): FakeElement => {
  const found = withClass(root, name);
  if (found.length !== 1) throw new Error(`expected one .${name}, found ${String(found.length)}`);
  return found[0] as FakeElement;
};
function byId(id: string): FakeElement {
  const found = area.descendants().find((e) => e.getAttribute('id') === id);
  if (!found) throw new Error(`no element with id ${id}`);
  return found;
}
const items = (): FakeElement[] => byId('preview-list').children.filter((c): c is FakeElement => c instanceof FakeElement);
const rebuiltItems = (): FakeElement[] => items().filter((i) => hasClass(i, 'message-rebuilt'));
const realItems = (): FakeElement[] => items().filter((i) => !hasClass(i, 'message-rebuilt'));
const isHidden = (e: FakeElement): boolean => e.hasAttribute('hidden');
/** The dt/dd pairs of an item's details list, as "label: value". */
const metaRows = (item: FakeElement): string[] => {
  const dl = one(item, 'message-meta');
  const cells = dl.children.filter((c): c is FakeElement => c instanceof FakeElement);
  const rows: string[] = [];
  for (let i = 0; i + 1 < cells.length; i += 2) rows.push(`${(cells[i] as FakeElement).textContent}: ${(cells[i + 1] as FakeElement).textContent}`);
  return rows;
};
const tick = (box: FakeElement, on: boolean): void => {
  box.checked = on;
  box.fire('change');
};
/** A recursive picture of an element: tags, attributes and texts (to compare two builds). */
function shape(e: FakeElement): string {
  const attrs = [...e.descendants()].map((d) => `${d.tagName}[${['class', 'id', 'hidden', 'data-position', 'aria-labelledby'].map((a) => d.getAttribute(a) ?? '').join('|')}]`);
  return `${e.textContent}\n${attrs.join('\n')}`;
}

// ------------------------------------------------------------------ cards

describe('rebuilt cards in the list', () => {
  it('appear at their place in the timeline, before the email they were taken from, oldest first', () => {
    const result = engineOf(LAST);
    show(result);
    expect(items().map((i) => i.getAttribute('data-rebuilt-id') ?? `#${i.getAttribute('data-position') ?? '?'}`)).toEqual(['2', '1', '0', '#0']);
    expect(rendered).toBe(1);
  });

  it('have no number, a "Rebuilt" label first in the heading, and the fixed note with the source number', () => {
    const result = engineOf(LAST);
    show(result);
    for (const card of rebuiltItems()) {
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

  it('show the fields read from the quote and the rebuilt text, as text', () => {
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
    for (const [card, r] of [outlookEn, gmail, outlookNl].map((c, k) => [c, rebuiltEntries(result)[k]] as const)) {
      expect(one(card as FakeElement, 'body-text').textContent).toBe(r?.rebuilt.reconstructedText);
    }
    expect(one(gmail as FakeElement, 'body-text').textContent).not.toMatch(/^>/m);
  });

  it('leave the source email exactly as it was without rebuilt emails (collapse, never delete)', () => {
    const result = engineOf(LAST);
    show(withoutRebuilt(result));
    const before = shape(realItems()[0] as FakeElement);
    show(result);
    expect(realItems()).toHaveLength(1);
    expect(shape(realItems()[0] as FakeElement)).toBe(before);
    expect((realItems()[0] as FakeElement).textContent).toContain(fixture(LAST).bodyText.trim().split('\n')[0] ?? 'x');
  });

  it('say which other emails quote the same text, on the one card shown', () => {
    const result = engineOf('12-order-3-alice-gmail.eml', LAST);
    show(result);
    const also = rebuiltItems().flatMap((c) => withClass(c, 'rebuilt-also').map((p) => p.textContent));
    expect(also.length).toBeGreaterThan(0);
    for (const text of also) expect(text).toMatch(/^Same quoted text also in email #[12]\.$/);
    expect(rebuiltAlsoText([2, 5])).toBe('Same quoted text also in emails #2, #5.');
    expect(rebuiltAlsoText([])).toBe('');
  });

  it('say "Unknown sender" and "(list may be incomplete)" when the quote says no more', () => {
    const base = engineOf(LAST);
    const result = withRebuilt(base, 0, (r) => ({ ...r, rebuilt: { ...r.rebuilt, from: [], incomplete: ['to', 'cc'], cc: [] } }));
    show(result);
    const card = rebuiltItems().find((c) => c.getAttribute('data-rebuilt-id') === '0') as FakeElement;
    const rows = metaRows(card);
    expect(rows).toContain('From: Unknown sender');
    expect(rows.find((r) => r.startsWith('To: '))).toMatch(/^To: .+ \(list may be incomplete\)$/);
    expect(rows).toContain('Cc: (list may be incomplete)');
  });

  it('show the date again in another zone when the zone changes', () => {
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

  it('write the dates as the quote allows: "about" for a guessed time only, a day as written (never "about", user decision Q2), an unreadable one only as written', () => {
    const ms = Date.parse('2025-03-03T14:40:00Z');
    expect(rebuiltDateTexts({ kind: 'moment', utcMs: ms, approximate: false, text: 'x' }, 'UTC')).toEqual({
      main: '2025-03-03 14:40 UTC+00:00',
      iso: '2025-03-03T14:40:00.000Z',
      asWritten: 'As written in the quote: x',
    });
    expect(rebuiltDateTexts({ kind: 'moment', utcMs: ms, approximate: true, text: 'x' }, 'UTC').main).toBe('about 2025-03-03 14:40 UTC+00:00');
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

  it('are written again in another language, in place', () => {
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

  it('give a stand-in with its label, a note and its text when a card cannot be built; the list is still complete', () => {
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

describe('the switch, the checkboxes and the counts', () => {
  it('show no switch and no rebuilt count when nothing was rebuilt', () => {
    show(engineOf('10-order-1-alice.eml'));
    expect(isHidden(byId('rebuilt-switch'))).toBe(true);
    expect(isHidden(byId('review-rebuilt'))).toBe(true);
    expect(byId('review-messages').textContent).toBe('1 email found.');
  });

  it('include every rebuilt email by default, and count them', () => {
    show(engineOf(LAST));
    expect(isHidden(byId('rebuilt-switch'))).toBe(false);
    expect(byId('rebuilt-include-all').checked).toBe(true);
    expect(byId('review-messages').textContent).toBe('1 email found, 3 earlier emails rebuilt from quoted text.');
    expect(byId('review-rebuilt').textContent).toBe('3 of 3 rebuilt emails will be in the PDF.');
    expect(byId('review-included').textContent).toBe('1 of 1 email will be in the PDF.');
    expect(review.includedRebuilt().map((r) => r.id)).toEqual([2, 1, 0]);
    for (const card of rebuiltItems()) {
      expect(card.getAttribute('data-included')).toBe('true');
      expect(one(card, 'include-checkbox').checked).toBe(true);
    }
  });

  it('the switch leaves ALL rebuilt emails out (their cards leave the list) and brings them back', () => {
    show(engineOf(LAST));
    const all = byId('rebuilt-include-all');
    tick(all, false);
    expect(rebuiltItems().every(isHidden)).toBe(true);
    expect(realItems().some(isHidden)).toBe(false);
    expect(review.rebuiltIncludeAll()).toBe(false);
    expect(review.includedRebuilt()).toEqual([]);
    expect(byId('review-rebuilt').textContent).toBe('0 of 3 rebuilt emails will be in the PDF.');
    expect(announced).toEqual(['0 of 3 rebuilt emails will be in the PDF.']);
    expect(review.includedPositions()).toEqual([0]); // the real email is not touched
    tick(all, true);
    expect(rebuiltItems().some(isHidden)).toBe(false);
    expect(review.includedRebuilt()).toHaveLength(3);
    expect(announced.at(-1)).toBe('3 of 3 rebuilt emails will be in the PDF.');
  });

  it('a card unticked stays in the list, dimmed and marked "Not in the PDF"', () => {
    show(engineOf(LAST));
    const card = rebuiltItems()[0] as FakeElement;
    tick(one(card, 'include-checkbox'), false);
    expect(isHidden(card)).toBe(false);
    expect(card.getAttribute('data-included')).toBe('false');
    expect(isHidden(one(card, 'excluded-note'))).toBe(false);
    expect(review.includedRebuilt().map((r) => r.id)).toEqual([1, 0]);
    expect(byId('review-rebuilt').textContent).toBe('2 of 3 rebuilt emails will be in the PDF.');
    expect(byId('review-included').textContent).toBe('1 of 1 email will be in the PDF.');
    // Its checkbox is named by its label and its heading.
    expect(one(card, 'include-checkbox').getAttribute('aria-labelledby')).toBe('include-rebuilt-2-label rebuilt-2-title');
  });

  it('follow the email they were taken from: unticking it marks them "Not in the PDF" and counts them out (user decision Q1 (a))', () => {
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
    for (const card of rebuiltItems()) {
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

  it('a text quoted in two emails stays in while one of them is ticked (follow-source rule)', () => {
    const result = engineOf('12-order-3-alice-gmail.eml', LAST);
    show(result);
    const shared = rebuiltEntries(result).filter((e) => e.copies.length > 0);
    expect(shared.length).toBeGreaterThan(0);
    const boxOf = (position: number): FakeElement =>
      one(realItems().find((i) => i.getAttribute('data-position') === String(position)) as FakeElement, 'include-checkbox');
    const cardOf = (id: number): FakeElement => rebuiltItems().find((c) => c.getAttribute('data-rebuilt-id') === String(id)) as FakeElement;
    const e = shared[0]!;
    const own = result.positionByIndex[e.sourceIndex]!;
    const other = result.positionByIndex[result.reconstructed[e.copies[0]!]!.sourceIndex]!;
    tick(boxOf(own), false);
    expect(cardOf(e.id).getAttribute('data-included')).toBe('true');
    expect(review.includedRebuilt().map((r) => r.id)).toContain(e.id);
    tick(boxOf(other), false);
    expect(cardOf(e.id).getAttribute('data-included')).toBe('false');
    expect(review.includedRebuilt()).toEqual([]);
  });

  it('say "In the PDF: taken from #K" only when the PDF takes the card from a copy in another email (task 7.7 review)', () => {
    const result = engineOf('12-order-3-alice-gmail.eml', LAST);
    show(result);
    const e = rebuiltEntries(result).find((x) => x.copies.length > 0)!;
    const own = result.positionByIndex[e.sourceIndex]!;
    const other = result.positionByIndex[result.reconstructed[e.copies[0]!]!.sourceIndex]!;
    expect(other).not.toBe(own);
    const boxOf = (position: number): FakeElement =>
      one(realItems().find((i) => i.getAttribute('data-position') === String(position)) as FakeElement, 'include-checkbox');
    const card = rebuiltItems().find((c) => c.getAttribute('data-rebuilt-id') === String(e.id)) as FakeElement;
    const line = one(card, 'rebuilt-pdf-source');
    // Both emails ticked: the PDF takes it from its own email, the one its card names; no line.
    expect(isHidden(line)).toBe(true);
    for (const c of rebuiltItems()) expect(isHidden(one(c, 'rebuilt-pdf-source'))).toBe(true);
    // Its own email unticked: still in the PDF, taken from the other email; the card says which.
    tick(boxOf(own), false);
    expect(card.getAttribute('data-included')).toBe('true');
    expect(metaRows(card)).toContain(`Taken from: email #${String(own + 1)}`);
    expect(isHidden(line)).toBe(false);
    expect(line.textContent).toBe(`In the PDF: taken from #${String(other + 1)}`);
    // The same email as the PDF itself picks (planPdfOrder, from the same choices).
    const slot = planPdfOrder(result, review.includedPositions(), review.includedRebuilt().map((r) => r.id)).slots.find(
      (s) => s.kind === 'rebuilt' && s.entry.id === e.id,
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

  it('keep the choices when files are added, and forget them on "Clear everything"', () => {
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

  it('counts a rebuilt card the page could not decorate as included once the list is complete (never silently left out), and hides it with the switch', () => {
    let broken = false;
    mount({
      decorateRebuilt: (item, r, res) => {
        if (broken && r.id === 0) throw new Error('boom');
        review.decorateRebuilt(item, r, res);
      },
    });
    show(engineOf(LAST));
    tick(one(rebuiltItems()[2] as FakeElement, 'include-checkbox'), false);
    expect(review.includedRebuilt().map((r) => r.id)).toEqual([2, 1]);
    // The same files again, but this card's checkbox cannot be added: its plain stand-in shows no
    // checkbox and no "Not in the PDF" mark, so it counts as included.
    broken = true;
    show(engineOf(LAST));
    const standIn = rebuiltItems()[2] as FakeElement;
    expect(hasClass(standIn, 'message-failed')).toBe(true);
    expect(withClass(standIn, 'include-checkbox')).toEqual([]);
    expect(review.includedRebuilt().map((r) => r.id)).toEqual([2, 1, 0]);
    expect(byId('review-rebuilt').textContent).toBe('3 of 3 rebuilt emails will be in the PDF.');
    // The switch leaves it out with the others: off -> the stand-in is hidden too, on -> shown again.
    const all = byId('rebuilt-include-all');
    tick(all, false);
    expect(byId('review-rebuilt').textContent).toBe('0 of 3 rebuilt emails will be in the PDF.');
    expect(isHidden(standIn)).toBe(true);
    expect(rebuiltItems().every(isHidden)).toBe(true);
    expect(realItems().some(isHidden)).toBe(false);
    // Files added while the switch is off: the new stand-in is hidden as it is put in the list.
    show(engineOf(LAST));
    const newStandIn = rebuiltItems()[2] as FakeElement;
    expect(newStandIn).not.toBe(standIn);
    expect(hasClass(newStandIn, 'message-failed')).toBe(true);
    expect(rebuiltItems().every(isHidden)).toBe(true);
    tick(all, true);
    expect(isHidden(newStandIn)).toBe(false);
    expect(rebuiltItems().some(isHidden)).toBe(false);
    expect(byId('review-rebuilt').textContent).toBe('3 of 3 rebuilt emails will be in the PDF.');
  });

  it('messagesText adds the rebuilt count only when there is one', () => {
    const counts = engineOf(LAST).counts;
    expect(messagesText(counts)).toBe('1 email found.');
    expect(messagesText(counts, 1)).toBe('1 email found, 1 earlier email rebuilt from quoted text.');
  });
});

describe('problems while rebuilding', () => {
  it('are a calm note on the email whose quote could not (all) be rebuilt, counted with the notes', () => {
    const base = engineOf('10-order-1-alice.eml');
    const m = base.messages[0];
    if (m === undefined) throw new Error('no message');
    show({ ...base, reconstructionWarnings: [{ index: m.index, code: 'reconstruct-limit' }] });
    const notes = withClass(realItems()[0] as FakeElement, 'message-note').map((n) => n.textContent);
    expect(notes).toEqual([t('warnings.rebuild.reconstruct-limit')]);
    expect(byId('review-notes').textContent).toBe('1 email has notes, shown with it below.');
    expect(noteText({ kind: 'rebuild', code: 'reconstruct-failed' })).toBe(t('warnings.rebuild.reconstruct-failed'));
  });
});
