// Unit tests for step 2's counts, include checkboxes and notes (review.ts),
// in Node with the recording fake DOM (Helper/Test/test-support/fake-dom.ts), wired to
// the real preview and the real thread analysis like Source/web-page/mount-page.ts does. Synthetic
// messages only. The real page is checked in Chromium by Helper/Test/browser-tests/review.spec.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDocument, FakeElement } from '../../Helper/Test/test-support/fake-dom';
import { parseAllFixtures } from '../../Helper/Test/test-data/parse-all-fixtures';
import { attachedResult } from '../../Helper/Test/test-support/attached-builder';
import { analyzeThread } from '../thread-analysis/analyze-thread';
import { DEDUPE_WARNINGS, THREAD_ANALYSIS_WARNINGS, PARSE_WARNINGS } from '../web-page-logic/message-notes';
import { rebuiltEntries } from '../web-page-logic/rebuilt-email-display';
import { SAFE_TAGS } from './safe-dom';
import { setLocale, t } from './translations';
import { headingId, mountPreview, type Preview, type PreviewOptions } from './preview';
import { createReview, filesText, includedText, messagesText, rebuiltIncludedText, noteText, relatedText, type Review, type ReviewOptions } from './review';
import type { EmailAddress, NormalizedMessage, ParseResult } from '../../Header/parsed-email';
import type { MessageNote } from '../../Header/preview-display';
import type { AnalyzedMessage, ThreadAnalysisResult } from '../../Header/thread-analysis-result';

// ------------------------------------------------------------------ factory

const ALICE: EmailAddress = { name: 'Alice Example', address: 'alice@example.test' };
const BOB: EmailAddress = { name: 'Bob Sample', address: 'bob@example.test' };
const CAROL: EmailAddress = { name: 'Carol Test', address: 'carol@example.test' };

let counter = 0;
/** A synthetic message from Alice to Bob; `fields` overrides any field. */
function make(fields: Partial<NormalizedMessage> = {}): NormalizedMessage
{
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
const analysisOf = (messages: readonly NormalizedMessage[], extra: readonly ParseResult[] = []): ThreadAnalysisResult =>
    analyzeThread([...messages.map(ok), ...extra]);

// ------------------------------------------------------------------ fake page

let fakeDocument: FakeDocument;
let area: FakeElement;
let preview: Preview;
let review: Review;

/** Builds step 2 like Source/web-page/mount-page.ts: the review's box as header, its decorate hook. */
function mount(options: PreviewOptions = {}, reviewOptions: ReviewOptions = {}): void
{
    area = new FakeElement('div');
    review = createReview(reviewOptions);
    preview = mountPreview(
        { checkArea: area as unknown as HTMLDivElement },
        {
            chunkSize: 1000,
            header: [review.element],
            decorate: review.decorate,
            onRendered: review.rendered,
            ...options,
        },
    );
}

/** Shows a result like Source/web-page/mount-page.ts does: the review first, then the list. */
function show(result: ThreadAnalysisResult): void
{
    review.show(result);
    preview.show(result);
}

beforeEach(() =>
{
    fakeDocument = new FakeDocument();
    vi.stubGlobal('document', fakeDocument);
    mount();
});

afterEach(() =>
{
    preview.reset();
    vi.unstubAllGlobals();
});

const hasClass = (e: FakeElement, name: string): boolean => (e.getAttribute('class') ?? '').split(' ').includes(name);
const withClass = (root: FakeElement, name: string): FakeElement[] => root.descendants().filter((e) => hasClass(e, name));
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
const checkboxes = (item: FakeElement): FakeElement[] => withClass(item, 'include-checkbox');
const checkbox = (item: FakeElement): FakeElement =>
{
    const found = checkboxes(item);
    if (found.length !== 1)
    {
        throw new Error(`expected one checkbox, found ${String(found.length)}`);
    }
    return found[0]!;
};
function toggle(item: FakeElement, on: boolean): void
{
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

describe('texts', () =>
{
    it('writes the counts lines from the thread analysis counts', () =>
    {
        const counts = { filesGiven: 12, filesFailed: 1, messagesFound: 11, duplicatesMerged: 2, undated: 0, withFolds: 0 };
        expect(filesText(counts)).toBe('12 files, 1 could not be read.');
        expect(filesText({ ...counts, filesGiven: 1, filesFailed: 0 })).toBe('1 file.');
        expect(messagesText(counts)).toBe('11 emails found, 2 identical copies merged.');
        expect(messagesText({ ...counts, messagesFound: 1, duplicatesMerged: 0 })).toBe('1 email found.');
        expect(filesText({ ...counts, filesGiven: 12, filesFailed: 3 })).toBe('12 files, 3 could not be read.');
    });

    it('says how many emails found were attached inside other emails, only when there are some (task 8.13b-4, P4)', () =>
    {
        const counts = { filesGiven: 3, filesFailed: 0, messagesFound: 5, duplicatesMerged: 0, undated: 0, withFolds: 0 };
        expect(messagesText(counts, 0, 0)).toBe('5 emails found.');
        expect(messagesText(counts, 0, 1)).toBe('5 emails found (1 attached inside another email).');
        expect(messagesText(counts, 0, 2)).toBe('5 emails found (2 attached inside other emails).');
        expect(messagesText({ ...counts, duplicatesMerged: 1 }, 3, 2)).toBe(
            '5 emails found (2 attached inside other emails), 1 identical copy merged, 3 earlier emails rebuilt from quoted text.',
        );
        setLocale('fr');
        try
        {
            expect(messagesText(counts, 0, 2)).toBe('5 e-mails trouvés (2 joints à d’autres e-mails).');
            expect(messagesText(counts, 0, 1)).toBe('5 e-mails trouvés (1 joint à un autre e-mail).');
        }
        finally
        {
            setLocale('en');
        }
        setLocale('nl');
        try
        {
            expect(messagesText(counts, 0, 2)).toBe('5 e-mails gevonden (2 bijgevoegd bij andere e-mails).');
        }
        finally
        {
            setLocale('en');
        }
    });

    it('counts only the ticked emails the PDF prints, and says how many are left out for having no text (task 8.14, Q3)', () =>
    {
        const result = analysisOf(
            [make(), make({ bodyText: '' }), make(), make({ bodyText: ' \n ' }), make({ bodyText: '', warnings: ['rtf-only-body'] })]);
        const empty = result.messages.flatMap((m, k) => (m.message.bodyText.trim() === '' && m.message.warnings.length === 0 ? [k] : []));
        expect(empty).toHaveLength(2);
        const all = result.messages.map((_, k) => k);
        const withText = all.filter((k) => !empty.includes(k));
        expect(includedText(result, withText)).toBe('3 of 5 emails will be in the PDF.');
        expect(includedText(result, [...withText, empty[0]!].sort())).toBe('3 of 5 emails will be in the PDF. 1 left out because it has no text.');
        expect(includedText(result, all)).toBe('3 of 5 emails will be in the PDF. 2 left out because they have no text.');
        expect(includedText(result, empty)).toBe('0 of 5 emails will be in the PDF. 2 left out because they have no text.');
        expect(includedText(result, [])).toBe('0 of 5 emails will be in the PDF.');
        setLocale('fr');
        try
        {
            expect(includedText(result, withText)).toBe('E-mails dans le PDF\u{00A0}: 3 sur 5.');
            expect(includedText(result, [...withText, empty[0]!].sort())).toBe('E-mails dans le PDF\u{00A0}: 3 sur 5. 1 exclu car sans texte.');
            expect(includedText(result, all)).toBe('E-mails dans le PDF\u{00A0}: 3 sur 5. 2 exclus car sans texte.');
        }
        finally
        {
            setLocale('en');
        }
        setLocale('nl');
        try
        {
            expect(includedText(result, withText)).toBe('In de PDF: 3 van 5 e-mails.');
            expect(includedText(result, [...withText, empty[0]!].sort())).toBe('In de PDF: 3 van 5 e-mails. 1 weggelaten omdat er geen tekst in staat.');
            expect(includedText(result, all)).toBe('In de PDF: 3 van 5 e-mails. 2 weggelaten omdat er geen tekst in staat.');
        }
        finally
        {
            setLocale('en');
        }
    });

    it('counts out the ticked emails whose text is all printed as other emails, with a sentence of its own, in every language (task 9.9f)', () =>
    {
        const result = analysisOf([make(), make(), make({ bodyText: '' }), make()]);
        const empty = result.messages.findIndex((m) => m.message.bodyText === '');
        const withText = [0, 1, 2, 3].filter((k) => k !== empty);
        const [a, b, c] = withText as [number, number, number];
        expect(includedText(result, withText, new Set([a]))).toBe('2 of 4 emails will be in the PDF. 1 left out: all of its text is printed as other emails.');
        expect(includedText(result, withText, new Set([a, c]))).toBe('1 of 4 emails will be in the PDF. 2 left out: all of their text is printed as other emails.');
        // An email not ticked is not counted out again; an email with no text is counted under that reason only.
        expect(includedText(result, [a, b], new Set([c]))).toBe('2 of 4 emails will be in the PDF.');
        expect(includedText(result, [a, b, c, empty].sort(), new Set([a, b, c, empty])))
            .toBe('0 of 4 emails will be in the PDF. 1 left out because it has no text. 3 left out: all of their text is printed as other emails.');
        // No set (or an empty one): the line as before.
        expect(includedText(result, withText, new Set())).toBe(includedText(result, withText));
        expect(includedText(result, withText)).toBe('3 of 4 emails will be in the PDF.');
        setLocale('fr');
        try
        {
            expect(includedText(result, withText, new Set([a]))).toBe('E-mails dans le PDF\u{00A0}: 2 sur 4. 1 exclu\u{00A0}: tout son texte est imprimé dans d’autres e-mails.');
            expect(includedText(result, [a, b, c, empty].sort(), new Set([a, c]))).toBe('E-mails dans le PDF\u{00A0}: 1 sur 4. 1 exclu car sans texte. '
                + '2 exclus\u{00A0}: tout leur texte est imprimé dans d’autres e-mails.');
        }
        finally
        {
            setLocale('en');
        }
        setLocale('nl');
        try
        {
            expect(includedText(result, withText, new Set([a]))).toBe('In de PDF: 2 van 4 e-mails. 1 weggelaten: de tekst ervan staat al in andere e-mails.');
            expect(includedText(result, withText, new Set([a, c]))).toBe('In de PDF: 1 van 4 e-mails. 2 weggelaten: hun tekst staat al in andere e-mails.');
        }
        finally
        {
            setLocale('en');
        }
    });

    it('says why rebuilt emails are not in the PDF, each counted once, in the priority order, in every language (task 9.9b-3)', () =>
    {
        // All in: the line alone, as before.
        expect(rebuiltIncludedText(['in-pdf', 'in-pdf'])).toBe('2 of 2 rebuilt emails will be in the PDF.');
        expect(rebuiltIncludedText(['in-pdf'])).toBe('1 of 1 rebuilt email will be in the PDF.');
        // One reason each, singular and plural.
        expect(rebuiltIncludedText(['no-text'])).toBe('0 of 1 rebuilt email will be in the PDF. Left out: 1 has no text.');
        expect(rebuiltIncludedText(['no-text', 'in-pdf', 'no-text'])).toBe('1 of 3 rebuilt emails will be in the PDF. Left out: 2 have no text.');
        expect(rebuiltIncludedText(['unticked', 'in-pdf'])).toBe('1 of 2 rebuilt emails will be in the PDF. Left out: 1 is unticked.');
        expect(rebuiltIncludedText(['unticked', 'unticked'])).toBe('0 of 2 rebuilt emails will be in the PDF. Left out: 2 are unticked.');
        expect(rebuiltIncludedText(['source-left-out', 'in-pdf']))
            .toBe('1 of 2 rebuilt emails will be in the PDF. Left out: 1 comes from an email that is left out.');
        expect(rebuiltIncludedText(['source-left-out', 'source-left-out']))
            .toBe('0 of 2 rebuilt emails will be in the PDF. Left out: 2 come from emails that are left out.');
        // Several reasons: always in the priority order, whatever the list order.
        const mixed = ['source-left-out', 'in-pdf', 'unticked', 'no-text', 'unticked'] as const;
        expect(rebuiltIncludedText(mixed))
            .toBe('1 of 5 rebuilt emails will be in the PDF. Left out: 1 has no text, 2 are unticked, 1 comes from an email that is left out.');
        setLocale('fr');
        try
        {
            expect(rebuiltIncludedText(['in-pdf', 'in-pdf'])).toBe('E-mails reconstitués dans le PDF\u{00A0}: 2 sur 2.');
            expect(rebuiltIncludedText(['no-text'])).toBe('E-mail reconstitué dans le PDF\u{00A0}: 0 sur 1. Hors du PDF\u{00A0}: 1 n’a pas de texte.');
            expect(rebuiltIncludedText(['no-text', 'no-text', 'in-pdf'])).toBe('E-mails reconstitués dans le PDF\u{00A0}: 1 sur 3. Hors du PDF\u{00A0}: 2 n’ont pas de texte.');
            expect(rebuiltIncludedText(mixed)).toBe('E-mails reconstitués dans le PDF\u{00A0}: 1 sur 5. '
                + 'Hors du PDF\u{00A0}: 1 n’a pas de texte, 2 sont décochés et 1 vient d’un e-mail laissé de côté.');
            expect(rebuiltIncludedText(['unticked', 'source-left-out', 'source-left-out'])).toBe('E-mails reconstitués dans le PDF\u{00A0}: 0 sur 3. '
                + 'Hors du PDF\u{00A0}: 1 est décoché et 2 viennent d’e-mails laissés de côté.');
        }
        finally
        {
            setLocale('en');
        }
        setLocale('nl');
        try
        {
            expect(rebuiltIncludedText(['in-pdf', 'in-pdf'])).toBe('In de PDF: 2 van 2 gereconstrueerde e-mails.');
            expect(rebuiltIncludedText(['no-text'])).toBe('In de PDF: 0 van 1 gereconstrueerde e-mail. Weggelaten: 1 heeft geen tekst.');
            expect(rebuiltIncludedText(['no-text', 'no-text', 'in-pdf'])).toBe('In de PDF: 1 van 3 gereconstrueerde e-mails. Weggelaten: 2 hebben geen tekst.');
            expect(rebuiltIncludedText(mixed)).toBe('In de PDF: 1 van 5 gereconstrueerde e-mails. '
                + 'Weggelaten: 1 heeft geen tekst, 2 zijn niet aangevinkt, 1 komt uit een e-mail die wordt weggelaten.');
            expect(rebuiltIncludedText(['unticked', 'source-left-out', 'source-left-out'])).toBe('In de PDF: 0 van 3 gereconstrueerde e-mails. '
                + 'Weggelaten: 1 is niet aangevinkt, 2 komen uit e-mails die worden weggelaten.');
        }
        finally
        {
            setLocale('en');
        }
    });

    it('writes the files line in French with "dont": the failed files are among the given ones', () =>
    {
        const counts = { filesGiven: 12, filesFailed: 1, messagesFound: 11, duplicatesMerged: 2, undated: 0, withFolds: 0 };
        setLocale('fr');
        try
        {
            expect(filesText(counts)).toBe('12 fichiers, dont 1 n’a pas pu être lu.');
            expect(filesText({ ...counts, filesFailed: 3 })).toBe('12 fichiers, dont 3 n’ont pas pu être lus.');
            expect(filesText({ ...counts, filesGiven: 1, filesFailed: 0 })).toBe('1 fichier.');
        }
        finally
        {
            setLocale('en');
        }
    });

    it('gives every note code a readable, non-empty label', () =>
    {
        const notes: MessageNote[] = [
            ...PARSE_WARNINGS.map((code): MessageNote => ({ kind: 'parse', code })),
            { kind: 'order', code: 'file-order' },
            ...DEDUPE_WARNINGS.map((code): MessageNote => ({ kind: 'dedupe', code, related: [], more: 0 })),
            ...THREAD_ANALYSIS_WARNINGS.map((code): MessageNote => ({ kind: 'engine', code })),
            { kind: 'chars', code: 'coded-characters' },
            { kind: 'attached', code: 'attached-unread' },
            { kind: 'attached', code: 'attached-unread-inside' },
        ];
        const texts = notes.map(noteText);
        for (const [k, text] of texts.entries())
        {
            expect(text.trim(), notes[k]!.code).not.toBe('');
            // Not the key itself (what t() returns for a missing entry).
            expect(text, notes[k]!.code).not.toMatch(/^(warnings|preview)\./);
        }
        expect(new Set(texts).size).toBe(texts.length);
    });

    it('names the related emails, and counts the rest in files (several files can be one email)', () =>
    {
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

describe('counts', () =>
{
    it('sits above the toolbar and the list', () =>
    {
        const top = area.children.filter((c): c is FakeElement => c instanceof FakeElement).map((c) => c.getAttribute('id'));
        expect(top).toEqual(['review-summary', 'preview-toolbar', 'preview-list']);
    });

    it('match the thread analysis counts exactly, for every fixture plus a failed file', async () =>
    {
        const parsed = await parseAllFixtures();
        const result = analyzeThread([...parsed.map(ok), failedFile('notes.txt')]);
        show(result);
        const counts = result.counts;
        expect(counts.filesFailed).toBe(1);
        expect(counts.duplicatesMerged).toBeGreaterThan(0);
        expect(byId('review-files-text').textContent).toBe(`${String(counts.filesGiven)} files, 1 could not be read.`);
        // The emails rebuilt from quoted text are counted on the same line (the phone forward fixtures of task 9.9a give some).
        const rebuilt = rebuiltEntries(result).length;
        expect(rebuilt).toBeGreaterThan(0);
        expect(byId('review-messages').textContent).toBe(
            `${String(counts.messagesFound)} emails found, ${String(counts.duplicatesMerged)} ${counts.duplicatesMerged === 1 ? 'identical copy' : 'identical copies'} merged, ` +
                `${String(rebuilt)} earlier emails rebuilt from quoted text.`,
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

    it('hides the pointer and the notes line when there is nothing to point to', () =>
    {
        show(analysisOf([make(), make()]));
        expect(byId('review-files-text').textContent).toBe('2 files.');
        expect(byId('review-failed-pointer').hasAttribute('hidden')).toBe(true);
        expect(byId('review-notes').hasAttribute('hidden')).toBe(true);
        expect(byId('review-messages').textContent).toBe('2 emails found.');
    });

    it('empties after a batch error but keeps the choices', () =>
    {
        const first = make();
        show(analysisOf([first, make()]));
        toggle(items()[0]!, false);
        review.showResult({ ok: false, error: 'engine-failed', detail: 'synthetic', parsed: [] });
        preview.showResult({ ok: false, error: 'engine-failed', detail: 'synthetic', parsed: [] });
        expect(byId('review-files-text').textContent).toBe('');
        expect(includedLine()).toBe('');
        expect(review.includedPositions()).toEqual([]);
        show(analysisOf([first, make()]));
        expect(review.includedPositions()).toEqual([1]);
    });
});

describe('include checkboxes', () =>
{
    it('gives every email one labelled checkbox, ticked, right after its heading', () =>
    {
        show(analysisOf([make(), make(), make()]));
        items().forEach((item, position) =>
        {
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

    it('unticking dims the email, keeps all its text, and updates the line and the selection', () =>
    {
        const messages = [make({ subject: 'One' }), make({ subject: 'Two' }), make({ subject: 'Three' })];
        const result = analysisOf(messages);
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

    it('counts out the emails the PDF labels\' cut says are printed as other emails, only for the choices it was made for (task 9.9f)', () =>
    {
        const result = analysisOf([make({ subject: 'One' }), make({ subject: 'Two' }), make({ subject: 'Three' })]);
        show(result);
        const line = byId('review-included');
        // No cut yet: the count without it, marked busy.
        expect(includedLine()).toBe('3 of 3 emails will be in the PDF.');
        expect(line.getAttribute('aria-busy')).toBe('true');
        // The cut for these choices: #2 is left out, the line is final.
        review.printedAllElsewhereKnown(result, new Set([1]));
        expect(includedLine()).toBe('2 of 3 emails will be in the PDF. 1 left out: all of its text is printed as other emails.');
        expect(line.hasAttribute('aria-busy')).toBe(false);
        // A cut for another result changes nothing.
        review.printedAllElsewhereKnown(analysisOf([make()]), new Set([0]));
        expect(includedLine()).toBe('2 of 3 emails will be in the PDF. 1 left out: all of its text is printed as other emails.');
        // Another choice: busy until its own cut comes, #2 still counted out (the last cut said so of it).
        toggle(items()[0]!, false);
        expect(includedLine()).toBe('1 of 3 emails will be in the PDF. 1 left out: all of its text is printed as other emails.');
        expect(line.getAttribute('aria-busy')).toBe('true');
        // The cut for this choice: it is what the line says.
        review.printedAllElsewhereKnown(result, new Set());
        expect(includedLine()).toBe('2 of 3 emails will be in the PDF.');
        expect(line.hasAttribute('aria-busy')).toBe(false);
        // Ticked back: #1 counted in (the last cut that saw it ticked said so) until the new cut comes.
        toggle(items()[0]!, true);
        expect(includedLine()).toBe('3 of 3 emails will be in the PDF.');
        expect(line.getAttribute('aria-busy')).toBe('true');
        review.printedAllElsewhereKnown(result, new Set([0, 1]));
        expect(includedLine()).toBe('1 of 3 emails will be in the PDF. 2 left out: all of their text is printed as other emails.');
        // #2 unticked and back: counted out again at once (what a cut said of it is kept while it is unticked).
        toggle(items()[1]!, false);
        expect(includedLine()).toBe('1 of 3 emails will be in the PDF. 1 left out: all of its text is printed as other emails.');
        review.printedAllElsewhereKnown(result, new Set([0]));
        toggle(items()[1]!, true);
        expect(includedLine()).toBe('1 of 3 emails will be in the PDF. 2 left out: all of their text is printed as other emails.');
        // A new result starts with no cut.
        const next = analysisOf([make(), make()]);
        show(next);
        expect(includedLine()).toBe('2 of 2 emails will be in the PDF.');
        expect(byId('review-included').getAttribute('aria-busy')).toBe('true');
        review.reset();
        expect(includedLine()).toBe('');
        expect(byId('review-included').hasAttribute('aria-busy')).toBe(false);
    });

    it('under "Print full original text" no email is counted out as printed as other emails (task 9.9f)', () =>
    {
        let everything = false;
        preview.reset();
        mount({}, { unfoldEverything: () => everything });
        const result = analysisOf([make(), make()]);
        show(result);
        review.printedAllElsewhereKnown(result, new Set([0]));
        expect(includedLine()).toBe('1 of 2 emails will be in the PDF. 1 left out: all of its text is printed as other emails.');
        everything = true;
        review.everythingChanged();
        expect(includedLine()).toBe('2 of 2 emails will be in the PDF.');
        expect(byId('review-included').getAttribute('aria-busy')).toBe('true');
        review.printedAllElsewhereKnown(result, new Set());
        expect(byId('review-included').hasAttribute('aria-busy')).toBe(false);
        // Unticked again: what the last cut made without it said, until the new cut comes.
        everything = false;
        review.everythingChanged();
        expect(includedLine()).toBe('1 of 2 emails will be in the PDF. 1 left out: all of its text is printed as other emails.');
        expect(byId('review-included').getAttribute('aria-busy')).toBe('true');
    });

    it('a tick announced while the line was busy is announced again once the cut makes the line word otherwise, once (task 9.9f review)', () =>
    {
        const said: string[] = [];
        const corrected: [string, string][] = [];
        preview.reset();
        mount({}, { onChange: (text) => said.push(text), onAnnouncementCorrected: (before, now) => corrected.push([before, now]) });
        const result = analysisOf([make({ subject: 'One' }), make({ subject: 'Two' }), make({ subject: 'Three' })]);
        show(result);
        // The first cut, on load: nothing was announced, nothing is said again.
        review.printedAllElsewhereKnown(result, new Set([1]));
        expect(corrected).toEqual([]);
        // #1 unticked: the provisional line (#2 still counted out) is announced at once...
        toggle(items()[0]!, false);
        expect(said).toEqual(['1 of 3 emails will be in the PDF. 1 left out: all of its text is printed as other emails.']);
        // ...the cut for it puts #2 back in: the final line is announced again, in place of the provisional one.
        review.printedAllElsewhereKnown(result, new Set());
        expect(includedLine()).toBe('2 of 3 emails will be in the PDF.');
        expect(corrected).toEqual([[said[0], '2 of 3 emails will be in the PDF.']]);
        // A second cut for the same choices says nothing more.
        review.printedAllElsewhereKnown(result, new Set());
        expect(corrected).toHaveLength(1);
        // #3 unticked: the cut agrees with the provisional line, nothing is said again.
        toggle(items()[2]!, false);
        expect(said.at(-1)).toBe('1 of 3 emails will be in the PDF.');
        review.printedAllElsewhereKnown(result, new Set());
        expect(corrected).toHaveLength(1);
        // A new result forgets an announcement still waiting for its cut.
        toggle(items()[2]!, true);
        const next = analysisOf([make(), make()]);
        show(next);
        review.printedAllElsewhereKnown(next, new Set([0]));
        expect(corrected).toHaveLength(1);
    });

    it('the PDF labels failing leave the line final without a cut, not busy; a tick waiting for it is announced again if it changed (task 9.9f review)', () =>
    {
        const corrected: [string, string][] = [];
        preview.reset();
        mount({}, { onChange: () => undefined, onAnnouncementCorrected: (before, now) => corrected.push([before, now]) });
        const result = analysisOf([make(), make(), make()]);
        show(result);
        const line = byId('review-included');
        expect(line.getAttribute('aria-busy')).toBe('true');
        review.cutUnavailable();
        expect(includedLine()).toBe('3 of 3 emails will be in the PDF.');
        expect(line.hasAttribute('aria-busy')).toBe(false);
        expect(corrected).toEqual([]);
        // A cut says #2 is left out; then #1 unticked, and the labels fail: the count without the cut, as before task 9.9f.
        review.printedAllElsewhereKnown(result, new Set([1]));
        toggle(items()[0]!, false);
        expect(includedLine()).toBe('1 of 3 emails will be in the PDF. 1 left out: all of its text is printed as other emails.');
        expect(line.getAttribute('aria-busy')).toBe('true');
        review.cutUnavailable();
        expect(includedLine()).toBe('2 of 3 emails will be in the PDF.');
        expect(line.hasAttribute('aria-busy')).toBe(false);
        expect(corrected).toEqual([['1 of 3 emails will be in the PDF. 1 left out: all of its text is printed as other emails.', '2 of 3 emails will be in the PDF.']]);
        // Nothing shown: nothing to do.
        review.reset();
        review.cutUnavailable();
        expect(includedLine()).toBe('');
        expect(line.hasAttribute('aria-busy')).toBe(false);
    });

    it('an email with no text keeps its tick box; the line counts it out and says why, following its tick (task 8.14)', () =>
    {
        const result = analysisOf([make({ subject: 'One' }), make({ subject: 'Empty', bodyText: '' }), make({ subject: 'Three' })]);
        show(result);
        const empty = items()[1]!;
        expect(checkbox(empty).checked).toBe(true);
        expect(includedLine()).toBe('2 of 3 emails will be in the PDF. 1 left out because it has no text.');
        // The PDF step still gets the reader's ticks: the PDF model leaves it out itself.
        expect(review.includedPositions()).toEqual([0, 1, 2]);
        toggle(empty, false);
        expect(includedLine()).toBe('2 of 3 emails will be in the PDF.');
        toggle(empty, true);
        setLocale('fr');
        try
        {
            review.relabel();
            expect(includedLine()).toBe('E-mails dans le PDF\u{00A0}: 2 sur 3. 1 exclu car sans texte.');
        }
        finally
        {
            setLocale('en');
            review.relabel();
        }
    });

    it('gives onChange the new line to announce after each tick or untick (the page has one live region, the status line)', () =>
    {
        const announced: string[] = [];
        mount({}, { onChange: (text) => announced.push(text) });
        show(analysisOf([make(), make()]));
        expect(announced).toEqual([]);
        expect(area.descendants().some((e) => e.hasAttribute('aria-live'))).toBe(false);
        toggle(items()[0]!, false);
        toggle(items()[0]!, true);
        expect(announced).toEqual(['1 of 2 emails will be in the PDF.', '2 of 2 emails will be in the PDF.']);
    });

    it('tells onChange after each tick or untick, once the choice is recorded (the PDF labels are worked out again)', () =>
    {
        const seen: [readonly number[], boolean][] = [];
        // The choice is recorded, and the line given is the one shown.
        mount({}, { onChange: (text) => seen.push([review.includedPositions(), text === includedLine()]) });
        show(analysisOf([make(), make()]));
        expect(seen).toEqual([]);
        toggle(items()[0]!, false);
        toggle(items()[0]!, true);
        expect(seen).toEqual([
            [[1], true],
            [[0, 1], true],
        ]);
    });

    it('keeps the choices when more files are added (the whole set runs again)', () =>
    {
        const one = make({ subject: 'One' });
        const two = make({ subject: 'Two' });
        show(analysisOf([one, two]));
        toggle(items()[1]!, false);
        // An earlier email arrives: "Two" moves from #2 to #3.
        const zero = make({ subject: 'Zero', date: { ...one.date, utcMs: (one.date.utcMs ?? 0) - 86_400_000 } });
        show(analysisOf([one, two, zero]));
        expect(subjects()).toEqual(['Zero', 'One', 'Two']);
        expect(items().map((i) => checkbox(i).checked)).toEqual([true, true, false]);
        expect(items()[2]!.getAttribute('data-included')).toBe('false');
        expect(review.includedPositions()).toEqual([0, 1]);
        expect(includedLine()).toBe('2 of 3 emails will be in the PDF.');
    });

    it('keeps the choice when a new copy of the same email becomes the kept one', () =>
    {
        const own = make({ subject: 'Lamps', bcc: [] });
        show(analysisOf([own, make()]));
        const position = subjects().indexOf('Lamps');
        toggle(items()[position]!, false);
        // The sender's own copy with a Bcc line: provably the same email, and kept instead.
        const withBcc: NormalizedMessage = { ...own, bcc: [CAROL], source: { ...own.source, fileName: 'sent.eml', sha256: 'f'.repeat(64) } };
        const result = analysisOf([own, make(), withBcc]);
        expect(result.counts.duplicatesMerged).toBe(1);
        show(result);
        const now = subjects().indexOf('Lamps');
        expect(result.messages[now]!.message.source.fileName).toBe('sent.eml');
        expect(checkbox(items()[now]!).checked).toBe(false);
        expect(review.includedPositions()).not.toContain(now);
    });

    it('forgets the choices on reset()', () =>
    {
        const messages = [make(), make()];
        show(analysisOf(messages));
        toggle(items()[0]!, false);
        preview.reset();
        review.reset();
        expect(review.includedPositions()).toEqual([]);
        expect(includedLine()).toBe('');
        show(analysisOf(messages));
        expect(items().map((i) => checkbox(i).checked)).toEqual([true, true]);
        expect(review.includedPositions()).toEqual([0, 1]);
    });

    it('adds the checkbox once when decorate runs twice on the same item', () =>
    {
        mount({
            decorate: (item, email, position, result) =>
            {
                review.decorate(item, email, position, result);
                review.decorate(item, email, position, result);
            },
        });
        show(analysisOf([make(), make()]));
        for (const item of items())
        {
            expect(checkboxes(item)).toHaveLength(1);
            expect(withClass(item, 'message-review')).toHaveLength(1);
        }
        toggle(items()[0]!, false);
        expect(includedLine()).toBe('1 of 2 emails will be in the PDF.');
    });

    it('decorates the stand-in of an email whose item failed, exactly once, and it works', () =>
    {
        // Fails after decorating the full item of "Broken": the stand-in replaces it.
        mount({
            decorate: (item, email, position, result) =>
            {
                review.decorate(item, email, position, result);
                if (email.message.subject === 'Broken' && !hasClass(item as unknown as FakeElement, 'message-failed'))
                {
                    throw new Error('synthetic decorate failure');
                }
            },
        });
        const result = analysisOf([make({ subject: 'Fine' }), make({ subject: 'Broken' }), make({ subject: 'Fine too' })]);
        show(result);
        const standIn = items()[1]!;
        expect(hasClass(standIn, 'message-failed')).toBe(true);
        for (const item of items())
        {
            expect(checkboxes(item)).toHaveLength(1);
        }
        expect(renderedBody(standIn)).toBe(result.messages[1]!.message.bodyText);
        // The stand-in's checkbox is the live one (the failed item's is not in the page).
        toggle(standIn, false);
        expect(includedLine()).toBe('2 of 3 emails will be in the PDF.');
        expect(review.includedPositions()).toEqual([0, 2]);
        expect(standIn.getAttribute('data-included')).toBe('false');
    });

    it('counts an email whose stand-in could not be decorated as included, once the list is complete (a bug)', () =>
    {
        // decorate fails on both the item and the stand-in of "Broken": the page
        // shows a plain stand-in, with no checkbox and no "Not in the PDF" mark.
        let failing = false;
        mount({
            decorate: (item, email, position, result) =>
            {
                if (failing && email.message.subject === 'Broken')
                {
                    throw new Error('synthetic decorate failure');
                }
                review.decorate(item, email, position, result);
            },
        });
        const messages = [make({ subject: 'Fine' }), make({ subject: 'Broken' }), make({ subject: 'Fine too' })];
        show(analysisOf(messages));
        toggle(items()[1]!, false);
        expect(review.includedPositions()).toEqual([0, 2]);
        failing = true;
        const result = analysisOf(messages);
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

    it('follows the choices for emails not in the page yet while the list is still being built', () =>
    {
        const queue: (() => void)[] = [];
        mount({ chunkSize: 1, schedule: (task) => queue.push(task), cancel: () => undefined });
        const messages = [make(), make(), make()];
        show(analysisOf(messages));
        while (queue.length > 0)
        {
            queue.shift()!();
        }
        toggle(items()[2]!, false);
        show(analysisOf(messages));
        expect(items()).toHaveLength(1);
        expect(review.includedPositions()).toEqual([0, 1]);
        expect(includedLine()).toBe('2 of 3 emails will be in the PDF.');
        while (queue.length > 0)
        {
            queue.shift()!();
        }
        expect(items().map((i) => checkbox(i).checked)).toEqual([true, true, false]);
        expect(review.includedPositions()).toEqual([0, 1]);
        expect(includedLine()).toBe('2 of 3 emails will be in the PDF.');
    });

    it('forgets the items of the previous list: a tick only touches items in the page', () =>
    {
        // Made in date order: A, B, C.
        const [messageA, messageB, messageC] = [make({ subject: 'A' }), make({ subject: 'B' }), make({ subject: 'C' })];
        show(analysisOf([messageA, messageB, messageC]));
        expect(subjects()).toEqual(['A', 'B', 'C']);
        const oldItems = items();
        expect(oldItems.map((i) => i.getAttribute('data-included'))).toEqual(['true', 'true', 'true']);
        // A new, shorter list where C is #1: the old items are gone from the page.
        show(analysisOf([messageC, make({ subject: 'D' })]));
        expect(subjects()).toEqual(['C', 'D']);
        for (const old of oldItems)
        {
            expect(items()).not.toContain(old);
        }
        toggle(items()[0]!, false);
        // The old item #3 (also C) is not touched: only the page's items are.
        expect(oldItems.map((i) => i.getAttribute('data-included'))).toEqual(['true', 'true', 'true']);
        expect(oldItems.map((i) => checkbox(i).checked)).toEqual([true, true, true]);
        expect(withClass(oldItems[2]!, 'excluded-note')[0]!.hasAttribute('hidden')).toBe(true);
        expect(items()[0]!.getAttribute('data-included')).toBe('false');
        expect(review.includedPositions()).toEqual([1]);
        expect(includedLine()).toBe('1 of 2 emails will be in the PDF.');
    });

    it('picks up a new result through decorate even if review.show() was not called first', () =>
    {
        const result = analysisOf([make(), make()]);
        preview.show(result); // no review.show()
        expect(includedLine()).toBe('2 of 2 emails will be in the PDF.');
        toggle(items()[1]!, false);
        review.show(result); // same result again: nothing is reset
        expect(review.includedPositions()).toEqual([0]);
        toggle(items()[1]!, true);
        expect(review.includedPositions()).toEqual([0, 1]);
    });

    it('ignores rendered() for a result that is not the one shown (an older or unknown list)', () =>
    {
        const older = analysisOf([make(), make(), make()]);
        show(older);
        const result = analysisOf([make({ subject: 'One' }), make({ subject: 'Two' })]);
        show(result);
        toggle(items()[1]!, false);
        const before = {
            files: byId('review-files-text').textContent,
            messages: byId('review-messages').textContent,
            included: includedLine(),
            positions: review.includedPositions(),
        };
        expect(before.included).toBe('1 of 2 emails will be in the PDF.');
        for (const stale of [older, analysisOf([make(), make(), make(), make()])])
        {
            review.rendered(stale);
            expect(byId('review-files-text').textContent).toBe(before.files);
            expect(byId('review-messages').textContent).toBe(before.messages);
            expect(includedLine()).toBe(before.included);
            expect(review.includedPositions()).toEqual(before.positions);
            expect(review.includedMessages().map((m) => m.message.subject)).toEqual(['One']);
        }
    });

    it.each([
        ['the review first, as Source/web-page/mount-page.ts does (the list is then reported complete for the shown result)', true],
        ['the list first (rendered comes before the review knows the result)', false],
    ])('shows the counts of an empty list given in either order: %s', (_label, reviewFirst) =>
    {
        show(analysisOf([make(), make()]));
        const empty = analysisOf([], [failedFile('notes.txt')]);
        expect(empty.messages).toHaveLength(0);
        // An empty list is complete at once.
        if (reviewFirst)
        {
            review.showResult({ ok: true, threadAnalysis: empty });
            preview.showResult({ ok: true, threadAnalysis: empty });
        }
        else
        {
            preview.showResult({ ok: true, threadAnalysis: empty });
            review.showResult({ ok: true, threadAnalysis: empty });
        }
        expect(items()).toHaveLength(0);
        expect(byId('review-files-text').textContent).toBe('1 file, 1 could not be read.');
        expect(byId('review-messages').textContent).toBe('0 emails found.');
        expect(includedLine()).toBe('0 of 0 emails will be in the PDF.');
        expect(review.includedPositions()).toEqual([]);
        expect(review.includedMessages()).toEqual([]);
    });

    it('works with emails built in later chunks', () =>
    {
        const queue: (() => void)[] = [];
        mount({ chunkSize: 1, schedule: (task) => queue.push(task), cancel: () => undefined });
        show(analysisOf([make(), make(), make()]));
        expect(items()).toHaveLength(1);
        expect(includedLine()).toBe('3 of 3 emails will be in the PDF.');
        toggle(items()[0]!, false);
        while (queue.length > 0)
        {
            queue.shift()!();
        }
        expect(items().map((i) => checkbox(i).checked)).toEqual([false, true, true]);
        toggle(items()[2]!, false);
        expect(review.includedPositions()).toEqual([1]);
        expect(includedLine()).toBe('1 of 3 emails will be in the PDF.');
    });
});

describe('emails attached inside other emails (task 8.13b-4)', () =>
{
    const RFC822_FILE = { fileName: 'broken.eml', size: 2, mimeType: 'message/rfc822' };

    it('explains the attached emails in the counts, in the page language', () =>
    {
        const bob = make({ subject: 'Bob' });
        const carol = make({ subject: 'Carol' });
        show(analyzeThread([attachedResult({ message: carol, children: [{ node: { message: bob }, inline: false, name: 'bob.eml' }] }), ok(make({ subject: 'Dan' }))]));
        expect(byId('review-messages').textContent).toBe('3 emails found (1 attached inside another email).');
        setLocale('fr');
        try
        {
            review.relabel();
            expect(byId('review-messages').textContent).toBe('3 e-mails trouvés (1 joint à un autre e-mail).');
        }
        finally
        {
            setLocale('en');
            review.relabel();
        }
        show(analysisOf([make(), make()]));
        expect(byId('review-messages').textContent).toBe('2 emails found.');
    });

    it('notes an email sent as a file that could not be read on its holder and on the emails printing it inline', () =>
    {
        const bob = make({ subject: 'Bob', attachments: [RFC822_FILE] });
        const carol = make({ subject: 'Carol' });
        show(analyzeThread(
            [attachedResult({ message: carol, children: [{ node: { message: bob }, inline: true }] }), ok(make({ subject: 'Plain' }))]));
        const card = (subject: string): FakeElement => items()[subjects().indexOf(subject)]!;
        expect(notesOf(card('Bob'))).toEqual([t('warnings.attached.attached-unread')]);
        expect(notesOf(card('Carol'))).toEqual([t('warnings.attached.attached-unread-inside')]);
        expect(notesOf(card('Plain'))).toEqual([]);
        expect(withClass(card('Bob'), 'message-note')[0]?.getAttribute('data-code')).toBe('attached-unread');
        expect(byId('review-notes').textContent).toBe(t('counts.withNotes', { count: 2 }));
        setLocale('nl');
        try
        {
            review.relabel();
            expect(notesOf(card('Bob'))).toEqual([t('warnings.attached.attached-unread')]);
            expect(notesOf(card('Bob'))[0]).toContain('is niet gelezen');
        }
        finally
        {
            setLocale('en');
        }
    });

    it('forgets the notes with "Clear everything" and with a new result', () =>
    {
        show(analysisOf([make({ subject: 'Holder', attachments: [RFC822_FILE] })]));
        expect(notesOf(items()[0]!)).toEqual([t('warnings.attached.attached-unread')]);
        review.reset();
        preview.reset();
        expect(byId('review-notes').hasAttribute('hidden')).toBe(true);
        show(analysisOf([make({ subject: 'Other' })]));
        expect(notesOf(items()[0]!)).toEqual([]);
        expect(byId('review-notes').hasAttribute('hidden')).toBe(true);
    });
});

describe('notes', () =>
{
    it('says on the card when the PDF will show some characters as codes (task 8.8: not in the PDF), in the page language', () =>
    {
        show(analysisOf([make({ subject: 'Odd', bodyText: 'Line\u0000one\n' }), make({ subject: 'Plain' })]));
        const odd = items().find((i) => i.descendants().some((e) => e.textContent === 'Odd'))!;
        const plain = items().find((i) => i.descendants().some((e) => e.textContent === 'Plain'))!;
        expect(notesOf(odd)).toEqual(['This email contains hidden or damaged characters. In the PDF they may appear as codes such as [U+0000].']);
        expect(notesOf(plain)).toEqual([]);
        expect(byId('review-notes').textContent).toBe('1 email has notes, shown with it below.');
        setLocale('nl');
        try
        {
            review.relabel();
            expect(notesOf(odd)).toEqual([t('review.codedCharacters')]);
            expect(notesOf(odd)[0]).toContain('beschadigde tekens');
        }
        finally
        {
            setLocale('en');
        }
    });

    it('shows an undated email\'s notes: no date found, placed at the end', () =>
    {
        show(analysisOf([make({ subject: 'Undated', date: NO_DATE, warnings: ['missing-date'] }), make({ subject: 'Dated' })]));
        expect(subjects()).toEqual(['Dated', 'Undated']);
        expect(notesOf(items()[0]!)).toEqual([]);
        expect(withClass(items()[0]!, 'message-notes')).toHaveLength(0);
        expect(notesOf(items()[1]!)).toEqual([t('warnings.parse.missing-date'), t('preview.order.file-order')]);
        const list = withClass(items()[1]!, 'message-notes')[0]!;
        expect([list.tagName, list.getAttribute('aria-label')]).toEqual(['ul', t('review.notesLabel')]);
        expect(byId('review-notes').textContent).toBe('1 email has notes, shown with it below.');
    });

    it('shows each parser and thread analysis note of an email', () =>
    {
        const message = make({ warnings: ['unknown-time-zone', 'html-converted-body', 'html-body-unreadable', 'rtf-only-body', 'forwarded-message-not-expanded'] });
        const result = analysisOf([message]);
        const withAnalysisWarnings: ThreadAnalysisResult = {
            ...result,
            messages: [{ ...result.messages[0]!, threadAnalysisWarnings: ['detector-failed', 'folding-disabled'] }],
        };
        show(withAnalysisWarnings);
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

    it('points look-alike notes to the other email\'s number, never to itself', () =>
    {
        const sameIdA = make({ subject: 'Same id A', messageId: 'same@example.test', bodyText: 'First text.\n' });
        const sameIdB = make({ subject: 'Same id B', messageId: 'same@example.test', bodyText: 'Different text.\n' });
        const other = make({ subject: 'Other' });
        // Input order other, sameIdB, sameIdA; list order by date: sameIdA (#1), sameIdB (#2), other (#3).
        show(analysisOf([other, sameIdB, sameIdA]));
        expect(subjects()).toEqual(['Same id A', 'Same id B', 'Other']);
        const label = t('warnings.dedupe.same-id-different-content');
        expect(notesOf(items()[0]!)).toContain(`${label} See email #2.`);
        expect(notesOf(items()[1]!)).toContain(`${label} See email #1.`);
        expect(notesOf(items()[2]!)).toEqual([]);
    });

    it('counts the files left out in files when the thread analysis capped the list of related ones', () =>
    {
        const result = analysisOf([make(), make(), make()]);
        const capped: ThreadAnalysisResult = {
            ...result,
            messages: result.messages.map((m, k) =>
                k === 0 ? { ...m, dedupeWarnings: [{ code: 'possible-duplicate-not-merged', related: [0, 1, 2], relatedTotal: 25 }] } : m,
            ),
        };
        show(capped);
        expect(notesOf(items()[0]!)).toEqual([`${t('warnings.dedupe.possible-duplicate-not-merged')} See emails #2, #3. 22 more files are involved.`]);
    });

    it('never claims more emails than there are when many files merge into one (real thread analysis)', () =>
    {
        // Email A, then 22 copies of email B: same Message-ID as A but another
        // text. The copies are identical, so they merge into one email: 2 emails
        // in all. The thread analysis lists 20 of the 22 files; the 2 others are files of
        // that same email #2, so the note must not say "2 more" emails.
        const first = make({ subject: 'First', messageId: 'shared@example.test', bodyText: 'First.\n' });
        const second = make({ subject: 'Second', messageId: 'shared@example.test', bodyText: 'Second.\n' });
        const copies = Array.from({ length: 22 }, (_, k): NormalizedMessage => ({
            ...second,
            source: { fileName: `second-${String(k)}.eml`, sha256: (0xb000 + k).toString(16).padStart(64, '0'), kind: 'eml' },
        }));
        const result = analysisOf([first, ...copies]);
        expect(result.messages).toHaveLength(2);
        expect(result.counts.duplicatesMerged).toBe(21);
        show(result);
        expect(subjects()).toEqual(['First', 'Second']);
        const label = t('warnings.dedupe.same-id-different-content');
        expect(notesOf(items()[0]!)).toContain(`${label} See email #2. 2 more files are involved.`);
        expect(notesOf(items()[1]!)).toContain(`${label} See email #1.`);
    });
});

describe('safety', () =>
{
    it('keeps hostile subjects and file names as text', () =>
    {
        const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
        const own = make({ subject: hostile, source: { fileName: `${hostile}.eml`, sha256: 'a'.repeat(64), kind: 'eml' } });
        const copy: NormalizedMessage = { ...own, source: { fileName: `copy ${hostile}.eml`, sha256: 'b'.repeat(64), kind: 'eml' } };
        const result = analysisOf([own, copy], [failedFile(`${hostile}.txt`)]);
        expect(result.counts.duplicatesMerged).toBe(1);
        show(result);
        const item = items()[0]!;
        expect(item.textContent).toContain(hostile);
        expect(item.textContent).toContain(`copy ${hostile}.eml`);
        toggle(item, false);
        expect(review.includedPositions()).toEqual([]);
        // Only allowed tags were ever created; nothing from the strings became an element.
        for (const created of fakeDocument.created)
        {
            expect(SAFE_TAGS as readonly string[]).toContain(created.tagName);
        }
        expect(fakeDocument.created.some((e) => e.tagName === 'img' || e.tagName === 'script')).toBe(false);
    });

    it('never stops the counts for a broken entry (a bug): it is counted as included', () =>
    {
        const result = analysisOf([make(), make()]);
        const broken = { ...result, messages: [result.messages[0]!, { message: null } as unknown as AnalyzedMessage] };
        review.show(broken);
        expect(includedLine()).toBe('2 of 2 emails will be in the PDF.');
        expect(review.includedPositions()).toEqual([0, 1]);
    });
});
