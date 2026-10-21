// Unit tests for step 2's counts, include checkboxes and notes (review.ts),
// in Node with the recording fake DOM (tests/support/fake-dom.ts), wired to
// the real preview and the real engine like src/ui/page.ts does. Synthetic
// messages only. The real page is checked in Chromium by e2e/review.spec.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDocument, FakeElement } from '../../tests/support/fake-dom';
import { parseAllFixtures } from '../../tests/fixtures/parse-all';
import { runEngine, type EngineMessage, type EngineResult } from '../engine/engine';
import type { EmailAddress, NormalizedMessage, ParseResult } from '../parsing/types';
import { DEDUPE_WARNINGS, ENGINE_WARNINGS, PARSE_WARNINGS, type MessageNote } from '../ui-model/message-notes';
import { SAFE_TAGS } from './dom';
import { t } from './i18n';
import { headingId, mountPreview, type Preview, type PreviewOptions } from './preview';
import { createReview, filesText, messagesText, noteText, relatedText, type Review, type ReviewOptions } from './review';

// ------------------------------------------------------------------ factory

const ALICE: EmailAddress = { name: 'Alice Example', address: 'alice@example.test' };
const BOB: EmailAddress = { name: 'Bob Sample', address: 'bob@example.test' };
const CAROL: EmailAddress = { name: 'Carol Test', address: 'carol@example.test' };

let counter = 0;
/** A synthetic message from Alice to Bob; `fields` overrides any field. */
function make(fields: Partial<NormalizedMessage> = {}): NormalizedMessage {
  counter++;
  return {
    messageId: `r${String(counter)}@example.test`,
    inReplyTo: null,
    references: [],
    date: { utcMs: Date.parse('2025-03-03T08:15:00Z') + counter * 60_000, original: 'synthetic', offsetMinutes: -300, zoneKnown: true },
    from: [ALICE],
    to: [BOB],
    cc: [],
    bcc: [],
    subject: `Lamps ${String(counter)}`,
    bodyText: `Hello Bob,\n\nThe lamps arrive on Friday, note ${String(counter)}.\n\nAlice\n`,
    attachments: [],
    source: { fileName: `lamp-${String(counter)}.eml`, sha256: counter.toString(16).padStart(64, '0'), kind: 'eml' },
    warnings: [],
    ...fields,
  };
}
const NO_DATE: NormalizedMessage['date'] = { utcMs: null, original: '', offsetMinutes: null, zoneKnown: false };
const failedFile = (fileName: string): ParseResult => ({ ok: false, fileName, sha256: null, error: 'unsupported-type', detail: 'not an email file' });
const ok = (message: NormalizedMessage): ParseResult => ({ ok: true, message });
const engineOf = (messages: readonly NormalizedMessage[], extra: readonly ParseResult[] = []): EngineResult =>
  runEngine([...messages.map(ok), ...extra]);

// ------------------------------------------------------------------ fake page

let doc: FakeDocument;
let area: FakeElement;
let preview: Preview;
let review: Review;

/** Builds step 2 like src/ui/page.ts: the review's box as header, its decorate hook. */
function mount(options: PreviewOptions = {}, reviewOptions: ReviewOptions = {}): void {
  area = new FakeElement('div');
  review = createReview(reviewOptions);
  preview = mountPreview(
    { checkArea: area as unknown as HTMLDivElement },
    {
      zones: ['America/New_York', 'Asia/Tokyo'],
      initialZone: 'America/New_York',
      chunkSize: 1000,
      header: [review.element],
      decorate: review.decorate,
      onRendered: review.rendered,
      ...options,
    },
  );
}

/** Shows a result like src/ui/page.ts does: the review first, then the list. */
function show(result: EngineResult): void {
  review.show(result);
  preview.show(result);
}

beforeEach(() => {
  doc = new FakeDocument();
  vi.stubGlobal('document', doc);
  mount();
});

afterEach(() => {
  preview.reset();
  vi.unstubAllGlobals();
});

const hasClass = (e: FakeElement, name: string): boolean => (e.getAttribute('class') ?? '').split(' ').includes(name);
const withClass = (root: FakeElement, name: string): FakeElement[] => root.descendants().filter((e) => hasClass(e, name));
function byId(id: string): FakeElement {
  const found = area.descendants().find((e) => e.getAttribute('id') === id);
  if (!found) throw new Error(`no element with id ${id}`);
  return found;
}
const items = (): FakeElement[] => byId('preview-list').children.filter((c): c is FakeElement => c instanceof FakeElement);
const checkboxes = (item: FakeElement): FakeElement[] => withClass(item, 'include-checkbox');
const checkbox = (item: FakeElement): FakeElement => {
  const found = checkboxes(item);
  if (found.length !== 1) throw new Error(`expected one checkbox, found ${String(found.length)}`);
  return found[0]!;
};
function toggle(item: FakeElement, on: boolean): void {
  const box = checkbox(item);
  box.checked = on;
  box.fire('change');
}
const includedLine = (): string => byId('review-included').textContent;
const notesOf = (item: FakeElement): string[] => withClass(item, 'message-note').map((n) => n.textContent);
const subjects = (): string[] => items().map((i) => withClass(i, 'message-subject')[0]?.textContent ?? '');
/** Every body text block of an item, joined: the email's whole text as the page holds it. */
const renderedBody = (item: FakeElement): string =>
  withClass(item, 'body-text')
    .map((e) => e.textContent)
    .join('');

// ------------------------------------------------------------------ pure helpers

describe('texts', () => {
  it('writes the counts lines from the engine counts', () => {
    const counts = { filesGiven: 12, filesFailed: 1, messagesFound: 11, duplicatesMerged: 2, undated: 0, withFolds: 0 };
    expect(filesText(counts)).toBe('12 files, 1 could not be read.');
    expect(filesText({ ...counts, filesGiven: 1, filesFailed: 0 })).toBe('1 file.');
    expect(messagesText(counts)).toBe('11 emails found, 2 identical copies merged.');
    expect(messagesText({ ...counts, messagesFound: 1, duplicatesMerged: 0 })).toBe('1 email found.');
  });

  it('gives every note code a readable, non-empty label', () => {
    const notes: MessageNote[] = [
      ...PARSE_WARNINGS.map((code): MessageNote => ({ kind: 'parse', code })),
      { kind: 'order', code: 'file-order' },
      ...DEDUPE_WARNINGS.map((code): MessageNote => ({ kind: 'dedupe', code, related: [], more: 0 })),
      ...ENGINE_WARNINGS.map((code): MessageNote => ({ kind: 'engine', code })),
    ];
    const texts = notes.map(noteText);
    for (const [k, text] of texts.entries()) {
      expect(text.trim(), notes[k]!.code).not.toBe('');
      // Not the key itself (what t() returns for a missing entry).
      expect(text, notes[k]!.code).not.toMatch(/^(warnings|preview)\./);
    }
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('names the related emails, and counts the rest in files (several files can be one email)', () => {
    expect(relatedText([], 0)).toBe('');
    expect(relatedText([3], 0)).toBe('See email #3.');
    expect(relatedText([3, 5], 0)).toBe('See emails #3, #5.');
    expect(relatedText([3, 5], 2)).toBe('See emails #3, #5. 2 more files are involved.');
    expect(relatedText([3], 1)).toBe('See email #3. 1 more file is involved.');
    expect(relatedText([], 1)).toBe('1 other file is involved.');
    expect(relatedText([], 4)).toBe('4 other files are involved.');
    // Numbers are not written with a thousands separator.
    expect(relatedText([1234], 0)).toBe('See email #1234.');
    expect(noteText({ kind: 'dedupe', code: 'same-id-different-content', related: [2], more: 0 })).toBe(
      `${t('warnings.dedupe.same-id-different-content')} See email #2.`,
    );
  });
});

// ------------------------------------------------------------------ the page

describe('counts', () => {
  it('sits above the toolbar and the list', () => {
    const top = area.children.filter((c): c is FakeElement => c instanceof FakeElement).map((c) => c.getAttribute('id'));
    expect(top).toEqual(['review-summary', 'preview-toolbar', 'preview-list']);
  });

  it('match the engine counts exactly, for every fixture plus a failed file', async () => {
    const parsed = await parseAllFixtures();
    const result = runEngine([...parsed.map(ok), failedFile('notes.txt')]);
    show(result);
    const c = result.counts;
    expect(c.filesFailed).toBe(1);
    expect(c.duplicatesMerged).toBeGreaterThan(0);
    expect(byId('review-files-text').textContent).toBe(`${String(c.filesGiven)} files, 1 could not be read.`);
    expect(byId('review-messages').textContent).toBe(
      `${String(c.messagesFound)} emails found, ${String(c.duplicatesMerged)} ${c.duplicatesMerged === 1 ? 'identical copy' : 'identical copies'} merged.`,
    );
    expect(includedLine()).toBe(`${String(result.messages.length)} of ${String(result.messages.length)} emails will be in the PDF.`);
    // The failed files are listed in step 1 only: a short text points there.
    const pointer = byId('review-failed-pointer');
    expect([pointer.textContent, pointer.hasAttribute('hidden')]).toEqual([t('counts.seeFailed'), false]);
    // Every email with at least one note is counted.
    const withNotes = items().filter((i) => notesOf(i).length > 0).length;
    expect(withNotes).toBeGreaterThan(3);
    expect(byId('review-notes').textContent).toBe(t('counts.withNotes', { count: withNotes }));
    expect(byId('review-notes').hasAttribute('hidden')).toBe(false);
  });

  it('hides the pointer and the notes line when there is nothing to point to', () => {
    show(engineOf([make(), make()]));
    expect(byId('review-files-text').textContent).toBe('2 files.');
    expect(byId('review-failed-pointer').hasAttribute('hidden')).toBe(true);
    expect(byId('review-notes').hasAttribute('hidden')).toBe(true);
    expect(byId('review-messages').textContent).toBe('2 emails found.');
  });

  it('empties after a batch error but keeps the choices', () => {
    const a = make();
    show(engineOf([a, make()]));
    toggle(items()[0]!, false);
    review.showResult({ ok: false, error: 'engine-failed', detail: 'synthetic', parsed: [] });
    preview.showResult({ ok: false, error: 'engine-failed', detail: 'synthetic', parsed: [] });
    expect(byId('review-files-text').textContent).toBe('');
    expect(includedLine()).toBe('');
    expect(review.includedPositions()).toEqual([]);
    show(engineOf([a, make()]));
    expect(review.includedPositions()).toEqual([1]);
  });
});

describe('include checkboxes', () => {
  it('gives every email one labelled checkbox, ticked, right after its heading', () => {
    show(engineOf([make(), make(), make()]));
    items().forEach((item, position) => {
      const box = checkbox(item);
      expect(box.getAttribute('type')).toBe('checkbox');
      expect(box.checked).toBe(true);
      const id = box.getAttribute('id') ?? '';
      const label = item.descendants().find((e) => e.tagName === 'label' && e.getAttribute('for') === id);
      expect(label?.textContent).toBe(t('actions.include'));
      // Named by its label, then the email's heading ("#2 Lamps ..."), which exists in the item.
      expect(label?.getAttribute('id')).toBe(`${id}-label`);
      expect(box.getAttribute('aria-labelledby')).toBe(`${id}-label ${headingId(position)}`);
      expect(box.hasAttribute('aria-describedby')).toBe(false);
      const children = item.children as FakeElement[];
      expect(children[0]!.getAttribute('id')).toBe(headingId(position));
      expect(hasClass(children[1]!, 'message-review')).toBe(true);
      expect(item.getAttribute('data-included')).toBe('true');
    });
    expect(new Set(items().map((i) => checkbox(i).getAttribute('id'))).size).toBe(3);
    expect(includedLine()).toBe('3 of 3 emails will be in the PDF.');
  });

  it('unticking dims the email, keeps all its text, and updates the line and the selection', () => {
    const messages = [make({ subject: 'One' }), make({ subject: 'Two' }), make({ subject: 'Three' })];
    const result = engineOf(messages);
    show(result);
    const second = items()[1]!;
    toggle(second, false);
    expect(includedLine()).toBe('2 of 3 emails will be in the PDF.');
    expect(review.includedPositions()).toEqual([0, 2]);
    expect(review.includedMessages().map((m) => m.message.subject)).toEqual(['One', 'Three']);
    expect(second.getAttribute('data-included')).toBe('false');
    const mark = withClass(second, 'excluded-note')[0]!;
    expect([mark.textContent, mark.hasAttribute('hidden')]).toEqual([t('review.excluded'), false]);
    // Still in the list, with its subject and its whole text (README.md, rule R6).
    expect(items()).toHaveLength(3);
    expect(subjects()).toEqual(['One', 'Two', 'Three']);
    expect(renderedBody(second)).toBe(result.messages[1]!.message.bodyText);

    toggle(second, true);
    expect(includedLine()).toBe('3 of 3 emails will be in the PDF.');
    expect(review.includedPositions()).toEqual([0, 1, 2]);
    expect(second.getAttribute('data-included')).toBe('true');
    expect(mark.hasAttribute('hidden')).toBe(true);
  });

  it('gives onChange the new line to announce after each tick or untick (the page has one live region, the status line)', () => {
    const announced: string[] = [];
    mount({}, { onChange: (text) => announced.push(text) });
    show(engineOf([make(), make()]));
    expect(announced).toEqual([]);
    expect(area.descendants().some((e) => e.hasAttribute('aria-live'))).toBe(false);
    toggle(items()[0]!, false);
    toggle(items()[0]!, true);
    expect(announced).toEqual(['1 of 2 emails will be in the PDF.', '2 of 2 emails will be in the PDF.']);
  });

  it('tells onChange after each tick or untick, once the choice is recorded (the PDF labels are worked out again)', () => {
    const seen: [readonly number[], boolean][] = [];
    // The choice is recorded, and the line given is the one shown.
    mount({}, { onChange: (text) => seen.push([review.includedPositions(), text === includedLine()]) });
    show(engineOf([make(), make()]));
    expect(seen).toEqual([]);
    toggle(items()[0]!, false);
    toggle(items()[0]!, true);
    expect(seen).toEqual([
      [[1], true],
      [[0, 1], true],
    ]);
  });

  it('keeps the choices when more files are added (the whole set runs again)', () => {
    const one = make({ subject: 'One' });
    const two = make({ subject: 'Two' });
    show(engineOf([one, two]));
    toggle(items()[1]!, false);
    // An earlier email arrives: "Two" moves from #2 to #3.
    const zero = make({ subject: 'Zero', date: { ...one.date, utcMs: (one.date.utcMs ?? 0) - 86_400_000 } });
    show(engineOf([one, two, zero]));
    expect(subjects()).toEqual(['Zero', 'One', 'Two']);
    expect(items().map((i) => checkbox(i).checked)).toEqual([true, true, false]);
    expect(items()[2]!.getAttribute('data-included')).toBe('false');
    expect(review.includedPositions()).toEqual([0, 1]);
    expect(includedLine()).toBe('2 of 3 emails will be in the PDF.');
  });

  it('keeps the choice when a new copy of the same email becomes the kept one', () => {
    const own = make({ subject: 'Lamps', bcc: [] });
    show(engineOf([own, make()]));
    const position = subjects().indexOf('Lamps');
    toggle(items()[position]!, false);
    // The sender's own copy with a Bcc line: provably the same email, and kept instead.
    const withBcc: NormalizedMessage = { ...own, bcc: [CAROL], source: { ...own.source, fileName: 'sent.eml', sha256: 'f'.repeat(64) } };
    const result = engineOf([own, make(), withBcc]);
    expect(result.counts.duplicatesMerged).toBe(1);
    show(result);
    const now = subjects().indexOf('Lamps');
    expect(result.messages[now]!.message.source.fileName).toBe('sent.eml');
    expect(checkbox(items()[now]!).checked).toBe(false);
    expect(review.includedPositions()).not.toContain(now);
  });

  it('forgets the choices on reset()', () => {
    const messages = [make(), make()];
    show(engineOf(messages));
    toggle(items()[0]!, false);
    preview.reset();
    review.reset();
    expect(review.includedPositions()).toEqual([]);
    expect(includedLine()).toBe('');
    show(engineOf(messages));
    expect(items().map((i) => checkbox(i).checked)).toEqual([true, true]);
    expect(review.includedPositions()).toEqual([0, 1]);
  });

  it('adds the checkbox once when decorate runs twice on the same item', () => {
    mount({
      decorate: (item, m, position, result) => {
        review.decorate(item, m, position, result);
        review.decorate(item, m, position, result);
      },
    });
    show(engineOf([make(), make()]));
    for (const item of items()) {
      expect(checkboxes(item)).toHaveLength(1);
      expect(withClass(item, 'message-review')).toHaveLength(1);
    }
    toggle(items()[0]!, false);
    expect(includedLine()).toBe('1 of 2 emails will be in the PDF.');
  });

  it('decorates the stand-in of an email whose item failed, exactly once, and it works', () => {
    // Fails after decorating the full item of "Broken": the stand-in replaces it.
    mount({
      decorate: (item, m, position, result) => {
        review.decorate(item, m, position, result);
        if (m.message.subject === 'Broken' && !hasClass(item as unknown as FakeElement, 'message-failed')) throw new Error('synthetic decorate failure');
      },
    });
    const result = engineOf([make({ subject: 'Fine' }), make({ subject: 'Broken' }), make({ subject: 'Fine too' })]);
    show(result);
    const standIn = items()[1]!;
    expect(hasClass(standIn, 'message-failed')).toBe(true);
    for (const item of items()) expect(checkboxes(item)).toHaveLength(1);
    expect(renderedBody(standIn)).toBe(result.messages[1]!.message.bodyText);
    // The stand-in's checkbox is the live one (the failed item's is not in the page).
    toggle(standIn, false);
    expect(includedLine()).toBe('2 of 3 emails will be in the PDF.');
    expect(review.includedPositions()).toEqual([0, 2]);
    expect(standIn.getAttribute('data-included')).toBe('false');
  });

  it('counts an email whose stand-in could not be decorated as included, once the list is complete (a bug)', () => {
    // decorate fails on both the item and the stand-in of "Broken": the page
    // shows a plain stand-in, with no checkbox and no "Not in the PDF" mark.
    let failing = false;
    mount({
      decorate: (item, m, position, result) => {
        if (failing && m.message.subject === 'Broken') throw new Error('synthetic decorate failure');
        review.decorate(item, m, position, result);
      },
    });
    const messages = [make({ subject: 'Fine' }), make({ subject: 'Broken' }), make({ subject: 'Fine too' })];
    show(engineOf(messages));
    toggle(items()[1]!, false);
    expect(review.includedPositions()).toEqual([0, 2]);
    failing = true;
    const result = engineOf(messages);
    show(result);
    const standIn = items()[1]!;
    expect(hasClass(standIn, 'message-failed')).toBe(true);
    expect(checkboxes(standIn)).toHaveLength(0);
    expect(withClass(standIn, 'excluded-note')).toHaveLength(0);
    expect(renderedBody(standIn)).toBe(result.messages[1]!.message.bodyText);
    // Not silently left out: it is counted and goes into the PDF.
    expect(review.includedPositions()).toEqual([0, 1, 2]);
    expect(review.includedMessages().map((m) => m.message.subject)).toEqual(['Fine', 'Broken', 'Fine too']);
    expect(includedLine()).toBe('3 of 3 emails will be in the PDF.');
    // The other checkboxes still work.
    toggle(items()[0]!, false);
    expect(review.includedPositions()).toEqual([1, 2]);
    expect(includedLine()).toBe('2 of 3 emails will be in the PDF.');
  });

  it('follows the choices for emails not in the page yet while the list is still being built', () => {
    const queue: (() => void)[] = [];
    mount({ chunkSize: 1, schedule: (task) => queue.push(task), cancel: () => undefined });
    const messages = [make(), make(), make()];
    show(engineOf(messages));
    while (queue.length > 0) queue.shift()!();
    toggle(items()[2]!, false);
    show(engineOf(messages));
    expect(items()).toHaveLength(1);
    expect(review.includedPositions()).toEqual([0, 1]);
    expect(includedLine()).toBe('2 of 3 emails will be in the PDF.');
    while (queue.length > 0) queue.shift()!();
    expect(items().map((i) => checkbox(i).checked)).toEqual([true, true, false]);
    expect(review.includedPositions()).toEqual([0, 1]);
    expect(includedLine()).toBe('2 of 3 emails will be in the PDF.');
  });

  it('forgets the items of the previous list: a tick only touches items in the page', () => {
    // Made in date order: A, B, C.
    const [a, b, c] = [make({ subject: 'A' }), make({ subject: 'B' }), make({ subject: 'C' })];
    show(engineOf([a, b, c]));
    expect(subjects()).toEqual(['A', 'B', 'C']);
    const oldItems = items();
    expect(oldItems.map((i) => i.getAttribute('data-included'))).toEqual(['true', 'true', 'true']);
    // A new, shorter list where C is #1: the old items are gone from the page.
    show(engineOf([c, make({ subject: 'D' })]));
    expect(subjects()).toEqual(['C', 'D']);
    for (const old of oldItems) expect(items()).not.toContain(old);
    toggle(items()[0]!, false);
    // The old item #3 (also C) is not touched: only the page's items are.
    expect(oldItems.map((i) => i.getAttribute('data-included'))).toEqual(['true', 'true', 'true']);
    expect(oldItems.map((i) => checkbox(i).checked)).toEqual([true, true, true]);
    expect(withClass(oldItems[2]!, 'excluded-note')[0]!.hasAttribute('hidden')).toBe(true);
    expect(items()[0]!.getAttribute('data-included')).toBe('false');
    expect(review.includedPositions()).toEqual([1]);
    expect(includedLine()).toBe('1 of 2 emails will be in the PDF.');
  });

  it('picks up a new result through decorate even if review.show() was not called first', () => {
    const result = engineOf([make(), make()]);
    preview.show(result); // no review.show()
    expect(includedLine()).toBe('2 of 2 emails will be in the PDF.');
    toggle(items()[1]!, false);
    review.show(result); // same result again: nothing is reset
    expect(review.includedPositions()).toEqual([0]);
    toggle(items()[1]!, true);
    expect(review.includedPositions()).toEqual([0, 1]);
  });

  it('ignores rendered() for a result that is not the one shown (an older or unknown list)', () => {
    const older = engineOf([make(), make(), make()]);
    show(older);
    const result = engineOf([make({ subject: 'One' }), make({ subject: 'Two' })]);
    show(result);
    toggle(items()[1]!, false);
    const before = {
      files: byId('review-files-text').textContent,
      messages: byId('review-messages').textContent,
      included: includedLine(),
      positions: review.includedPositions(),
    };
    expect(before.included).toBe('1 of 2 emails will be in the PDF.');
    for (const stale of [older, engineOf([make(), make(), make(), make()])]) {
      review.rendered(stale);
      expect(byId('review-files-text').textContent).toBe(before.files);
      expect(byId('review-messages').textContent).toBe(before.messages);
      expect(includedLine()).toBe(before.included);
      expect(review.includedPositions()).toEqual(before.positions);
      expect(review.includedMessages().map((m) => m.message.subject)).toEqual(['One']);
    }
  });

  it.each([
    ['the review first, as src/ui/page.ts does (the list is then reported complete for the shown result)', true],
    ['the list first (rendered comes before the review knows the result)', false],
  ])('shows the counts of an empty list given in either order: %s', (_label, reviewFirst) => {
    show(engineOf([make(), make()]));
    const empty = engineOf([], [failedFile('notes.txt')]);
    expect(empty.messages).toHaveLength(0);
    // An empty list is complete at once.
    if (reviewFirst) {
      review.showResult({ ok: true, engine: empty });
      preview.showResult({ ok: true, engine: empty });
    } else {
      preview.showResult({ ok: true, engine: empty });
      review.showResult({ ok: true, engine: empty });
    }
    expect(items()).toHaveLength(0);
    expect(byId('review-files-text').textContent).toBe('1 file, 1 could not be read.');
    expect(byId('review-messages').textContent).toBe('0 emails found.');
    expect(includedLine()).toBe('0 of 0 emails will be in the PDF.');
    expect(review.includedPositions()).toEqual([]);
    expect(review.includedMessages()).toEqual([]);
  });

  it('works with emails built in later chunks', () => {
    const queue: (() => void)[] = [];
    mount({ chunkSize: 1, schedule: (task) => queue.push(task), cancel: () => undefined });
    show(engineOf([make(), make(), make()]));
    expect(items()).toHaveLength(1);
    expect(includedLine()).toBe('3 of 3 emails will be in the PDF.');
    toggle(items()[0]!, false);
    while (queue.length > 0) queue.shift()!();
    expect(items().map((i) => checkbox(i).checked)).toEqual([false, true, true]);
    toggle(items()[2]!, false);
    expect(review.includedPositions()).toEqual([1]);
    expect(includedLine()).toBe('1 of 3 emails will be in the PDF.');
  });
});

describe('notes', () => {
  it('shows an undated email\'s notes: no date found, placed at the end', () => {
    show(engineOf([make({ subject: 'Undated', date: NO_DATE, warnings: ['missing-date'] }), make({ subject: 'Dated' })]));
    expect(subjects()).toEqual(['Dated', 'Undated']);
    expect(notesOf(items()[0]!)).toEqual([]);
    expect(withClass(items()[0]!, 'message-notes')).toHaveLength(0);
    expect(notesOf(items()[1]!)).toEqual([t('warnings.parse.missing-date'), t('preview.order.file-order')]);
    const list = withClass(items()[1]!, 'message-notes')[0]!;
    expect([list.tagName, list.getAttribute('aria-label')]).toEqual(['ul', t('review.notesLabel')]);
    expect(byId('review-notes').textContent).toBe('1 email has notes, shown with it below.');
  });

  it('shows each parser and engine note of an email', () => {
    const m = make({ warnings: ['unknown-time-zone', 'html-converted-body', 'html-body-unreadable', 'rtf-only-body', 'forwarded-message-not-expanded'] });
    const result = engineOf([m]);
    const withEngine: EngineResult = {
      ...result,
      messages: [{ ...result.messages[0]!, engineWarnings: ['detector-failed', 'folding-disabled'] }],
    };
    show(withEngine);
    expect(notesOf(items()[0]!)).toEqual([
      t('warnings.parse.unknown-time-zone'),
      t('warnings.parse.html-body-unreadable'),
      t('warnings.parse.rtf-only-body'),
      t('warnings.parse.html-converted-body'),
      t('warnings.parse.forwarded-message-not-expanded'),
      t('warnings.engine.detector-failed'),
      t('warnings.engine.folding-disabled'),
    ]);
  });

  it('points look-alike notes to the other email\'s number, never to itself', () => {
    const a = make({ subject: 'Same id A', messageId: 'same@example.test', bodyText: 'First text.\n' });
    const b = make({ subject: 'Same id B', messageId: 'same@example.test', bodyText: 'Different text.\n' });
    const c = make({ subject: 'Other' });
    // Input order c, b, a; list order by date: a (#1), b (#2), c (#3).
    show(engineOf([c, b, a]));
    expect(subjects()).toEqual(['Same id A', 'Same id B', 'Other']);
    const label = t('warnings.dedupe.same-id-different-content');
    expect(notesOf(items()[0]!)).toContain(`${label} See email #2.`);
    expect(notesOf(items()[1]!)).toContain(`${label} See email #1.`);
    expect(notesOf(items()[2]!)).toEqual([]);
  });

  it('counts the files left out in files when the engine capped the list of related ones', () => {
    const result = engineOf([make(), make(), make()]);
    const capped: EngineResult = {
      ...result,
      messages: result.messages.map((m, k) =>
        k === 0 ? { ...m, dedupeWarnings: [{ code: 'possible-duplicate-not-merged', related: [0, 1, 2], relatedTotal: 25 }] } : m,
      ),
    };
    show(capped);
    expect(notesOf(items()[0]!)).toEqual([`${t('warnings.dedupe.possible-duplicate-not-merged')} See emails #2, #3. 22 more files are involved.`]);
  });

  it('never claims more emails than there are when many files merge into one (real engine)', () => {
    // Email A, then 22 copies of email B: same Message-ID as A but another
    // text. The copies are identical, so they merge into one email: 2 emails
    // in all. The engine lists 20 of the 22 files; the 2 others are files of
    // that same email #2, so the note must not say "2 more" emails.
    const a = make({ subject: 'First', messageId: 'shared@example.test', bodyText: 'First.\n' });
    const b = make({ subject: 'Second', messageId: 'shared@example.test', bodyText: 'Second.\n' });
    const copies = Array.from({ length: 22 }, (_, k): NormalizedMessage => ({
      ...b,
      source: { fileName: `second-${String(k)}.eml`, sha256: (0xb000 + k).toString(16).padStart(64, '0'), kind: 'eml' },
    }));
    const result = engineOf([a, ...copies]);
    expect(result.messages).toHaveLength(2);
    expect(result.counts.duplicatesMerged).toBe(21);
    show(result);
    expect(subjects()).toEqual(['First', 'Second']);
    const label = t('warnings.dedupe.same-id-different-content');
    expect(notesOf(items()[0]!)).toContain(`${label} See email #2. 2 more files are involved.`);
    expect(notesOf(items()[1]!)).toContain(`${label} See email #1.`);
  });
});

describe('safety', () => {
  it('keeps hostile subjects and file names as text', () => {
    const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const own = make({ subject: hostile, source: { fileName: `${hostile}.eml`, sha256: 'a'.repeat(64), kind: 'eml' } });
    const copy: NormalizedMessage = { ...own, source: { fileName: `copy ${hostile}.eml`, sha256: 'b'.repeat(64), kind: 'eml' } };
    const result = engineOf([own, copy], [failedFile(`${hostile}.txt`)]);
    expect(result.counts.duplicatesMerged).toBe(1);
    show(result);
    const item = items()[0]!;
    expect(item.textContent).toContain(hostile);
    expect(item.textContent).toContain(`copy ${hostile}.eml`);
    toggle(item, false);
    expect(review.includedPositions()).toEqual([]);
    // Only allowed tags were ever created; nothing from the strings became an element.
    for (const created of doc.created) expect(SAFE_TAGS as readonly string[]).toContain(created.tagName);
    expect(doc.created.some((e) => e.tagName === 'img' || e.tagName === 'script')).toBe(false);
  });

  it('never stops the counts for a broken entry (a bug): it is counted as included', () => {
    const result = engineOf([make(), make()]);
    const broken = { ...result, messages: [result.messages[0]!, { message: null } as unknown as EngineMessage] };
    review.show(broken);
    expect(includedLine()).toBe('2 of 2 emails will be in the PDF.');
    expect(review.includedPositions()).toEqual([0, 1]);
  });
});
