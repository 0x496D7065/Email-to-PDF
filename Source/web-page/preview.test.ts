// Unit tests for step 2, the preview, in Node with the recording fake DOM
// (Helper/Test/test-support/fake-dom.ts). Synthetic messages only, run through the real
// thread analysis so the folds are the ones the page will show. The real page is
// checked in Chromium by Helper/Test/browser-tests/preview.spec.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDocument, FakeElement } from '../../Helper/Test/test-support/fake-dom';
import { parseAllFixtures } from '../../Helper/Test/test-data/parse-all-fixtures';
import { analyzeThread } from '../thread-analysis/analyze-thread';
import { DEFAULT_OUTPUT_POLICY, planOutput } from '../thread-analysis/output-plan';
import { buildThread, instantOf } from '../../Helper/Test/test-support/thread-builder';
import { THREAD_CASES } from '../../Helper/Test/test-support/thread-cases';
import { signatureSources } from '../web-page-logic/pdf-plan';
import { printedElsewhereRanges } from '../web-page-logic/printed-elsewhere';
import { rebuiltEntries } from '../web-page-logic/rebuilt-email-display';
import { setLocale, t } from './translations';
import {
    attachmentText,
    dateTexts,
    foldSummaryText,
    lineCount,
    mailboxListText,
    mailboxText,
    MAX_CHUNK_CHARS,
    mountPreview,
    PDF_CHUNK_FACTOR,
    pdfLabelText,
    pdfReasonText,
    relatedNumbers,
    sizeText,
    zoneLabel,
    type Preview,
    type PreviewOptions,
    type PreviewPdfPlans,
} from './preview';
import type { EmailAddress, NormalizedMessage, ParseResult } from '../../Header/parsed-email';
import type { DisplayBlock } from '../../Header/pdf-plan';
import type { ThreadAnalysisResult } from '../../Header/thread-analysis-result';

// ------------------------------------------------------------------ factory

const ALICE: EmailAddress = { name: 'Alice Example', address: 'alice@example.test' };
const BOB: EmailAddress = { name: 'Bob Sample', address: 'bob@furniture.example.test' };

let counter = 0;

/** A synthetic message from Alice to Bob; `fields` overrides any field. */
function make(fields: Partial<NormalizedMessage> = {}): NormalizedMessage
{
    counter++;
    return {
        messageId: `p${counter}@example.test`,
        inReplyTo: null,
        references: [],
        date: { utcMs: Date.parse('2025-03-03T08:15:00Z') + counter * 60_000, original: 'synthetic', offsetMinutes: 60, zoneKnown: true },
        from: [ALICE],
        to: [BOB],
        cc: [],
        bcc: [],
        subject: `Desks ${counter}`,
        bodyText: `Hello Bob,\n\nThe desks arrive on Monday, note ${counter}.\n\nAlice\n`,
        attachments: [],
        source: { fileName: `file-${counter}.eml`, sha256: counter.toString(16).padStart(64, '0'), kind: 'eml' },
        warnings: [],
        ...fields,
    };
}

const analysisOf = (messages: readonly NormalizedMessage[]): ThreadAnalysisResult =>
    analyzeThread(messages.map((message): ParseResult => ({ ok: true, message })));

const dateAt = (iso: string, offsetMinutes: number | null = -300, zoneKnown = true): NormalizedMessage['date'] => ({
    utcMs: Date.parse(iso),
    original: 'synthetic',
    offsetMinutes,
    zoneKnown,
});
const NO_DATE: NormalizedMessage['date'] = { utcMs: null, original: '', offsetMinutes: null, zoneKnown: false };

// Alice asks; Bob replies above a full copy of her text (folded by the overlap detector).
const ASK =
    'Hi Bob,\n\nWe are furnishing a small office for four people and need four desks and four chairs. ' +
    'Could you send me a quote? Someone is at the office most mornings if you want to see the room first.\n\nThanks,\nAlice\n';
let threads = 0;
/** A new thread each call (its own day, so two threads are never merged as identical copies). */
function thread(): NormalizedMessage[]
{
    threads++;
    const day = Date.parse('2025-03-03T08:15:00Z') + threads * 86_400_000;
    const ask = make({ subject: 'Office desks', bodyText: ASK, date: { ...dateAt('2025-03-03T08:15:00Z'), utcMs: day } });
    const reply = make({
        subject: 'RE: Office desks',
        from: [BOB],
        to: [ALICE],
        inReplyTo: ask.messageId,
        references: [ask.messageId ?? ''],
        bodyText: `Hello Alice,\n\nI can come by on Wednesday to measure the room.\n\nBob\n\n${ASK}`,
        date: { ...dateAt('2025-03-03T08:15:00Z'), utcMs: day + 5 * 3_600_000 },
    });
    return [reply, ask];
}

// ------------------------------------------------------------------ fake page

let fakeDocument: FakeDocument;
let area: FakeElement;
let preview: Preview;

const ZONES = ['America/New_York', 'Asia/Tokyo', 'UTC'];

function mount(options: PreviewOptions = {}): Preview
{
    area = new FakeElement('div');
    preview = mountPreview({ checkArea: area as unknown as HTMLDivElement }, { zones: ZONES, initialZone: 'America/New_York', ...options });
    return preview;
}

beforeEach(() =>
{
    fakeDocument = new FakeDocument();
    vi.stubGlobal('document', fakeDocument);
    vi.stubGlobal('window', { innerHeight: 600 }); // (only the window's height is read)
    mount();
});

afterEach(() =>
{
    // No chunk may run after the fake document is gone.
    preview.reset();
    vi.unstubAllGlobals();
});

const fake = (e: Element | Node): FakeElement => e as unknown as FakeElement;

function byId(id: string): FakeElement
{
    const found = area.descendants().find((e) => e.getAttribute('id') === id);
    if (!found)
    {
        throw new Error(`no element with id ${id}`);
    }
    return found;
}

const hasClass = (e: FakeElement, name: string): boolean => (e.getAttribute('class') ?? '').split(' ').includes(name);
const withClass = (root: FakeElement, name: string): FakeElement[] => root.descendants().filter((e) => hasClass(e, name));
const one = (root: FakeElement, name: string): FakeElement =>
{
    const found = withClass(root, name);
    if (found.length !== 1)
    {
        throw new Error(`expected one .${name}, found ${String(found.length)}`);
    }
    return found[0]!;
};

const items = (): FakeElement[] => byId('preview-list').children.filter((c): c is FakeElement => c instanceof FakeElement);
/** The body text as the page holds it: every shown and folded text block, in order (labels excluded). */
const renderedBody = (item: FakeElement): string =>
    withClass(one(item, 'message-body'), 'body-text')
        .map((e) => e.textContent)
        .join('');
/** The value of one details row ("date", "to", ...) of an item, or null if absent. */
function meta(item: FakeElement, name: string): string | null
{
    const dd = item.descendants().find((e) => e.tagName === 'dd' && hasClass(e, `meta-${name}`));
    return dd === undefined ? null : dd.textContent;
}
const label = (item: FakeElement, name: string): string | undefined =>
    item.descendants().find((e) => e.tagName === 'dt' && hasClass(e, `meta-${name}`))?.textContent;

function chooseZone(zone: string): void
{
    const select = byId('preview-zone');
    select.value = zone;
    select.fire('change');
}

function setShowFolded(on: boolean): void
{
    const box = byId('preview-show-folded');
    box.checked = on;
    box.fire('change');
}

const folds = (): FakeElement[] => area.descendants().filter((e) => e.tagName === 'details');

// ------------------------------------------------------------------ pure helpers

describe('helpers', () =>
{
    it('writes mailboxes with whatever parts exist, untouched', () =>
    {
        expect(mailboxText(ALICE)).toBe('Alice Example <alice@example.test>');
        expect(mailboxText({ name: '', address: 'bob@example.test' })).toBe('bob@example.test');
        expect(mailboxText({ name: ' Carol ', address: ' ' })).toBe(' Carol ');
        expect(mailboxListText([ALICE, { name: '', address: '' }, BOB])).toBe(
            'Alice Example <alice@example.test>, Bob Sample <bob@furniture.example.test>',
        );
        expect(mailboxListText([{ name: ' ', address: '' }])).toBe('');
    });

    it('joins three recipients with a plain ", " in English (unchanged) and in French (no "et")', () =>
    {
        const carol: EmailAddress = { name: 'Carol Test', address: 'carol@example.test' };
        const expected = 'Alice Example <alice@example.test>, Bob Sample <bob@furniture.example.test>, Carol Test <carol@example.test>';
        expect(mailboxListText([ALICE, BOB, carol])).toBe(expected);
        setLocale('fr');
        try
        {
            expect(mailboxListText([ALICE, BOB, carol])).toBe(expected);
        }
        finally
        {
            setLocale('en');
        }
    });

    it('writes sizes for people', () =>
    {
        expect(sizeText(null)).toBe('size unknown');
        expect(sizeText(Number.NaN)).toBe('size unknown');
        expect(sizeText(-1)).toBe('size unknown');
        expect(sizeText(1)).toBe('1 byte');
        expect(sizeText(512)).toBe('512 bytes');
        expect(sizeText(1024)).toBe('1 KB');
        expect(sizeText(1434)).toBe('1.4 KB');
        expect(sizeText(12_800)).toBe('13 KB');
        expect(sizeText(1.5 * 1024 * 1024)).toBe('1.5 MB');
        expect(sizeText(40 * 1024 * 1024)).toBe('40 MB');
    });

    it('lists attachments as metadata only', () =>
    {
        expect(attachmentText({ fileName: 'quote.pdf', size: 2048, mimeType: 'application/pdf' })).toBe('quote.pdf (2 KB, application/pdf)');
        expect(attachmentText({ fileName: 'notes.txt', size: null, mimeType: '' })).toBe('notes.txt (size unknown)');
        expect(attachmentText({ fileName: '  ', size: 3, mimeType: 'text/plain' })).toBe(`${t('preview.noAttachmentName')} (3 bytes, text/plain)`);
    });

    it('counts lines', () =>
    {
        expect(lineCount('')).toBe(0);
        expect(lineCount('a')).toBe(1);
        expect(lineCount('a\nb')).toBe(2);
        expect(lineCount('a\nb\n')).toBe(2);
        expect(lineCount('a\r\nb\r\n')).toBe(2);
        expect(lineCount('\n\n')).toBe(2);
    });

    it('turns related input positions into list numbers, without the email itself', () =>
    {
        const block: DisplayBlock = { start: 0, end: 4, text: 'a\nb\n', folded: true, reasons: ['quoted-overlap'], related: [0, 2, 3, 9], label: 'quoted-overlap', collapsed: true };
        // Input 0 -> list position 1 (#2), 2 -> 0 (the email itself), 3 -> 1 again, 9 unknown.
        expect(relatedNumbers(block, 0, [1, null, 0, 1])).toEqual([2]);
        expect(foldSummaryText(block, 0, [1, null, 0, 1])).toBe(`${t('preview.fold.quoted-overlap')}, 2 lines, from email #2`);
        expect(foldSummaryText({ ...block, related: [0, 1] }, 5, [0, 2])).toBe(`${t('preview.fold.quoted-overlap')}, 2 lines, from emails #1, #3`);
        expect(foldSummaryText({ ...block, related: [], label: 'signature', text: 'x' }, 0, [])).toBe(`${t('preview.fold.signature')}, 1 line`);
        expect(foldSummaryText({ ...block, related: [], label: null }, 0, [])).toBe(`${t('preview.foldOther')}, 2 lines`);
    });

    it('writes a fold label in French as parts, not as a list joined with "et"; only the email numbers are a list', () =>
    {
        const block: DisplayBlock = { start: 0, end: 4, text: 'a\nb\n', folded: true, reasons: ['quote-marker'], related: [0], label: 'quote-marker', collapsed: true };
        const list = (items: string[]): string => new Intl.ListFormat('fr', { style: 'short', type: 'unit' }).format(items);
        setLocale('fr');
        try
        {
            const quoted = t('preview.fold.quote-marker');
            expect(foldSummaryText({ ...block, related: [] }, 0, [])).toBe(`${quoted}, 2 lignes`);
            expect(foldSummaryText(block, 5, [1])).toBe(`${quoted}, 2 lignes, de l’e-mail #2`);
            expect(foldSummaryText({ ...block, related: [0, 1] }, 5, [0, 2])).toBe(`${quoted}, 2 lignes, des e-mails ${list(['#1', '#3'])}`);
        }
        finally
        {
            setLocale('en');
        }
    });

    it('names zones readably and marks this computer', () =>
    {
        expect(zoneLabel('America/New_York', 'Asia/Tokyo')).toBe('America/New York');
        expect(zoneLabel('America/New_York', 'America/New_York')).toBe('America/New York (this computer)');
    });

    it('shows dates in the zone, the sender time only when known and different', () =>
    {
        const date = dateAt('2025-03-03T08:15:00Z', -300);
        expect(dateTexts(date, 'America/New_York')).toEqual({ main: '2025-03-03 03:15:00 UTC-05:00', iso: '2025-03-03T08:15:00.000Z', senderLocal: null, asWritten: null });
        expect(dateTexts(date, 'Asia/Tokyo')).toEqual({
            main: '2025-03-03 17:15:00 UTC+09:00',
            iso: '2025-03-03T08:15:00.000Z',
            senderLocal: "Sender's local time: 2025-03-03 03:15:00 UTC-05:00",
            asWritten: null,
        });
        expect(dateTexts(dateAt('2025-03-03T08:15:00Z', null, false), 'Asia/Tokyo').senderLocal).toBeNull();
        expect(dateTexts(NO_DATE, 'UTC')).toEqual({ main: t('preview.noDate'), iso: null, senderLocal: null, asWritten: null });
        expect(dateTexts({ ...NO_DATE, utcMs: 1e18 }, 'UTC').main).toBe(t('preview.noDate'));
    });

    it('gives the date as written when it could not be read (task 8.8: the PDF shows that text alone)', () =>
    {
        const bad = { ...NO_DATE, original: 'Someday, around noon' };
        expect(dateTexts(bad, 'UTC')).toEqual({ main: '(no date)', iso: null, senderLocal: null, asWritten: 'As written in the email: Someday, around noon' });
        expect(dateTexts({ ...bad, original: '   ' }, 'UTC').asWritten).toBeNull();
        // A usable date never shows it.
        expect(dateTexts(dateAt('2025-03-03T08:15:00Z'), 'UTC').asWritten).toBeNull();
    });
});

describe('task 8.8: what the PDF no longer says, shown in step 2', () =>
{
    it('shows the date as written under "(no date)" on the card, in the page language', () =>
    {
        const bad = make({ date: { ...NO_DATE, original: 'Someday, around noon' }, warnings: ['unparseable-date'] });
        preview.show(analysisOf([bad]));
        const note = one(items()[0]!, 'sender-time');
        expect(note.textContent).toBe('As written in the email: Someday, around noon');
        expect(note.hasAttribute('hidden')).toBe(false);
        setLocale('fr');
        try
        {
            preview.relabel();
            expect(note.textContent).toBe('Date telle qu’écrite dans l’e-mail : Someday, around noon');
        }
        finally
        {
            setLocale('en');
            preview.relabel();
        }
    });

    it('says when the zone picked is not recognized (dates in UTC), and only then', () =>
    {
        expect(byId('preview-zone-note').hasAttribute('hidden')).toBe(true);
        expect(byId('preview-zone').hasAttribute('aria-describedby')).toBe(false);
        mount({ zones: ['UTC', 'Not/A_Zone'], initialZone: 'Not/A_Zone' });
        const note = byId('preview-zone-note');
        expect(note.hasAttribute('hidden')).toBe(false);
        expect(note.textContent).toBe('This time zone was not recognized, so dates are shown in UTC, here and in the PDF.');
        expect(byId('preview-zone').getAttribute('aria-describedby')).toBe('preview-zone-note');
        // Picking a zone the browser knows hides it.
        const select = byId('preview-zone');
        select.value = 'UTC';
        select.fire('change');
        expect(note.hasAttribute('hidden')).toBe(true);
        expect(select.hasAttribute('aria-describedby')).toBe(false);
    });
});

// ------------------------------------------------------------------ the page

describe('mountPreview', () =>
{
    it('builds a labelled time-zone list and a labelled checkbox', () =>
    {
        const select = byId('preview-zone');
        expect(select.tagName).toBe('select');
        expect(select.value).toBe('America/New_York');
        const options = select.children as FakeElement[];
        expect(options.map((o) => o.getAttribute('value'))).toEqual(ZONES);
        expect(options.filter((o) => o.hasAttribute('selected')).map((o) => o.getAttribute('value'))).toEqual(['America/New_York']);
        expect(options.map((o) => o.textContent)).toContain('America/New York (this computer)');
        const labels = area.descendants().filter((e) => e.tagName === 'label');
        expect(labels.map((l) => [l.getAttribute('for'), l.textContent])).toEqual([
            ['preview-zone', t('preview.zone')],
            ['preview-show-folded', t('preview.showFolded')],
        ]);
        expect(byId('preview-show-folded').getAttribute('type')).toBe('checkbox');
        expect(byId('preview-list').getAttribute('aria-label')).toBe(t('preview.listLabel'));
        expect(preview.zone()).toBe('America/New_York');
    });

    it('adds the starting zone to the list if it is missing', () =>
    {
        mount({ zones: ['UTC'], initialZone: 'Asia/Tokyo' });
        expect((byId('preview-zone').children as FakeElement[]).map((o) => o.getAttribute('value'))).toEqual(['Asia/Tokyo', 'UTC']);
    });

    it('shows the emails in the thread analysis order, numbered', () =>
    {
        const late = make({ subject: 'Late', date: dateAt('2025-03-05T10:00:00Z') });
        const early = make({ subject: 'Early', date: dateAt('2025-03-01T10:00:00Z') });
        const undated = make({ subject: 'Undated', date: NO_DATE });
        const middle = make({ subject: 'Middle', date: dateAt('2025-03-03T10:00:00Z') });
        const result = analysisOf([undated, late, early, middle]);
        preview.show(result);
        expect(items().map((i) => one(i, 'message-subject').textContent)).toEqual(result.messages.map((m) => m.message.subject));
        expect(items().map((i) => one(i, 'message-subject').textContent)).toEqual(['Early', 'Middle', 'Late', 'Undated']);
        expect(items().map((i) => one(i, 'message-number').textContent)).toEqual(['#1', '#2', '#3', '#4']);
        expect(items().map((i) => i.getAttribute('data-position'))).toEqual(['0', '1', '2', '3']);
        for (const item of items())
        {
            expect(item.descendants().find((e) => e.tagName === 'h3')?.textContent).toMatch(/^#\d /);
        }
    });

    it('shows author, recipients and dates; the sender time only when it differs', () =>
    {
        const carol: EmailAddress = { name: '', address: 'carol@example.test' };
        preview.show(analysisOf([make({ cc: [carol], bcc: [BOB], date: dateAt('2025-03-03T08:15:00Z', -300) })]));
        const item = items()[0]!;
        expect(label(item, 'author')).toBe(t('preview.author.from'));
        expect(meta(item, 'author')).toBe('Alice Example <alice@example.test>');
        expect(meta(item, 'to')).toBe('Bob Sample <bob@furniture.example.test>');
        expect(meta(item, 'cc')).toBe('carol@example.test');
        expect(meta(item, 'bcc')).toBe('Bob Sample <bob@furniture.example.test>');
        expect(label(item, 'bcc')).toBe(t('preview.bcc'));
        const time = one(item, 'message-date');
        expect(time.tagName).toBe('time');
        expect(time.textContent).toBe('2025-03-03 03:15:00 UTC-05:00');
        expect(time.getAttribute('datetime')).toBe('2025-03-03T08:15:00.000Z');
        expect(one(item, 'sender-time').hasAttribute('hidden')).toBe(true);
    });

    it('shows a three-recipient To row with a plain ", " in English and in French', () =>
    {
        const carol: EmailAddress = { name: 'Carol Test', address: 'carol@example.test' };
        const expected = 'Alice Example <alice@example.test>, Bob Sample <bob@furniture.example.test>, Carol Test <carol@example.test>';
        preview.show(analysisOf([make({ to: [ALICE, BOB, carol] })]));
        expect(meta(items()[0]!, 'to')).toBe(expected);
        setLocale('fr');
        try
        {
            preview.show(analysisOf([make({ to: [ALICE, BOB, carol] })]));
            expect(meta(items()[0]!, 'to')).toBe(expected);
        }
        finally
        {
            setLocale('en');
        }
    });

    it('leaves out empty To, Cc and Bcc rows', () =>
    {
        preview.show(analysisOf([make({ to: [], cc: [{ name: ' ', address: '' }] })]));
        const item = items()[0]!;
        expect([meta(item, 'to'), meta(item, 'cc'), meta(item, 'bcc'), meta(item, 'attachments'), meta(item, 'also-in')]).toEqual([null, null, null, null, null]);
    });

    it('uses the "sent by" mailbox when there is no From', () =>
    {
        const sender: EmailAddress = { name: 'Assistant', address: 'assistant@example.test' };
        preview.show(analysisOf([make({ from: [], sender })]));
        expect(label(items()[0]!, 'author')).toBe(t('preview.author.sender'));
        expect(meta(items()[0]!, 'author')).toBe('Assistant <assistant@example.test>');
    });

    it('handles an email with no subject, no date, no author and no text', () =>
    {
        preview.show(analysisOf([make({ subject: '   ', date: NO_DATE, from: [], to: [], bodyText: '' })]));
        const item = items()[0]!;
        const subject = one(item, 'message-subject');
        expect(subject.textContent).toBe(t('preview.noSubject'));
        expect(hasClass(subject, 'placeholder')).toBe(true);
        expect(one(item, 'message-date').textContent).toBe(t('preview.noDate'));
        expect(one(item, 'message-date').hasAttribute('datetime')).toBe(false);
        expect(label(item, 'author')).toBe(t('preview.from'));
        expect(meta(item, 'author')).toBe(t('preview.author.none'));
        expect(withClass(item, 'body-text')).toEqual([]);
        // Task 8.14: an email with no text at all is left out of the PDF, and says so instead of "(no text)".
        expect(one(item, 'body-empty').textContent).toBe(t('preview.notInPdfNoText'));
    });

    it('lists attachments as text only: no link, no image, no file access', () =>
    {
        preview.show(
            analysisOf([
                make({
                    attachments: [
                        { fileName: 'quote.pdf', size: 2048, mimeType: 'application/pdf' },
                        { fileName: 'photo.jpg', size: null, mimeType: 'image/jpeg' },
                    ],
                }),
            ]),
        );
        const item = items()[0]!;
        expect(withClass(item, 'attachment').map((e) => e.textContent)).toEqual(['quote.pdf (2 KB, application/pdf)', 'photo.jpg (size unknown, image/jpeg)']);
        expect(label(item, 'attachments')).toBe(t('preview.attachments'));
        for (const element of fakeDocument.created)
        {
            expect(['a', 'img']).not.toContain(element.tagName);
            expect(element.hasAttribute('href') || element.hasAttribute('src')).toBe(false);
        }
    });

    it('names the files of merged identical copies', () =>
    {
        const original = make({ messageId: 'same@example.test' });
        const copy = { ...original, source: { ...original.source, fileName: 'copy-from-sent.eml', sha256: 'e'.repeat(64) } };
        const result = analysisOf([original, copy]);
        expect(result.counts.duplicatesMerged).toBe(1);
        preview.show(result);
        expect(items()).toHaveLength(1);
        expect(label(items()[0]!, 'also-in')).toBe(t('preview.alsoIn'));
        expect(meta(items()[0]!, 'also-in')).toBe('copy-from-sent.eml');
    });

    it('names the files of three merged copies with a plain ", " in English and in French', () =>
    {
        const original = make({ messageId: 'same@example.test' });
        const copyOf = (fileName: string, hash: string): NormalizedMessage => ({ ...original, source: { ...original.source, fileName, sha256: hash.repeat(64) } });
        const emails = [original, copyOf('copy-a.eml', 'a'), copyOf('copy-b.eml', 'b'), copyOf('copy-c.eml', 'c')];
        const expected = 'copy-a.eml, copy-b.eml, copy-c.eml';
        preview.show(analysisOf(emails));
        expect(meta(items()[0]!, 'also-in')).toBe(expected);
        setLocale('fr');
        try
        {
            preview.show(analysisOf(emails));
            expect(meta(items()[0]!, 'also-in')).toBe(expected);
        }
        finally
        {
            setLocale('en');
        }
    });

    it('folds quoted text in a labelled <details>, with the email it repeats', () =>
    {
        const result = analysisOf(thread());
        preview.show(result);
        const [ask, reply] = items();
        expect(folds()).toHaveLength(1);
        expect(withClass(ask!, 'fold')).toEqual([]);
        const details = one(reply!, 'fold');
        expect(details.tagName).toBe('details');
        expect(details.hasAttribute('open')).toBe(false);
        const summary = details.children[0] as FakeElement;
        expect(summary.tagName).toBe('summary');
        expect(summary.textContent).toBe(`${t('preview.fold.quoted-overlap')}, ${String(lineCount(ASK))} lines, from email #1`);
        expect(one(details, 'body-folded').textContent).toBe(ASK);
        // The reply's own words are shown outside the fold.
        expect(withClass(one(reply!, 'message-body'), 'body-text')[0]?.textContent).toContain('I can come by on Wednesday');
    });

    it('opens and closes every fold with the checkbox; new folds follow it', () =>
    {
        preview.show(analysisOf([...thread(), ...thread()]));
        expect(folds().length).toBeGreaterThanOrEqual(2);
        expect(folds().every((d) => !d.hasAttribute('open'))).toBe(true);
        setShowFolded(true);
        expect(folds().every((d) => d.hasAttribute('open'))).toBe(true);
        preview.show(analysisOf(thread()));
        expect(folds().length).toBeGreaterThanOrEqual(1);
        expect(folds().every((d) => d.hasAttribute('open'))).toBe(true);
        setShowFolded(false);
        expect(folds().every((d) => !d.hasAttribute('open'))).toBe(true);
    });

    it('keeps every character of every body in the page (collapse, never delete)', () =>
    {
        const messages = [
            ...thread(),
            make({ bodyText: 'Line one\r\n> quoted\r\n> more quoted\r\n\r\n-- \r\nAlice\r\n' }),
            make({ bodyText: '   leading spaces\n\n\n\ttabs\t\nno final break' }),
            make({ bodyText: '' }),
        ];
        const result = analysisOf(messages);
        preview.show(result);
        setShowFolded(true);
        items().forEach((item, k) => expect(renderedBody(item)).toBe(result.messages[k]!.message.bodyText));
        expect(folds().every((d) => d.hasAttribute('open'))).toBe(true);
    });

    it('keeps every character of every synthetic fixture, run through the thread analysis', async () =>
    {
        const parsed = await parseAllFixtures();
        const result = analyzeThread(parsed.map((message): ParseResult => ({ ok: true, message })));
        expect(result.counts.withFolds).toBeGreaterThan(5);
        mount({ chunkSize: result.messages.length });
        preview.show(result);
        setShowFolded(true);
        expect(items()).toHaveLength(result.messages.length);
        items().forEach((item, k) =>
        {
            const email = result.messages[k]!;
            expect(renderedBody(item), email.message.source.fileName).toBe(email.message.bodyText);
            expect(one(item, 'message-subject').textContent === email.message.subject || email.message.subject.trim() === '').toBe(true);
        });
        expect(folds().length).toBeGreaterThan(5);
        expect(folds().every((d) => d.hasAttribute('open'))).toBe(true);
    });

    it('rewrites only the dates when the zone changes', () =>
    {
        const result = analysisOf([make({ date: dateAt('2025-03-03T08:15:00Z', -300) }), make({ date: NO_DATE }), ...thread()]);
        preview.show(result);
        const bodies = items().map((i) => one(i, 'message-body'));
        const bodyNodes = bodies.map((b) => [...b.descendants()]);
        const created = fakeDocument.created.length;

        chooseZone('Asia/Tokyo');
        expect(preview.zone()).toBe('Asia/Tokyo');
        const first = items()[0]!;
        expect(one(first, 'message-date').textContent).toBe('2025-03-03 17:15:00 UTC+09:00');
        expect(one(first, 'sender-time').textContent).toBe("Sender's local time: 2025-03-03 03:15:00 UTC-05:00");
        expect(one(first, 'sender-time').hasAttribute('hidden')).toBe(false);
        expect(items().map((i) => one(i, 'message-date').textContent).filter((d) => d === t('preview.noDate'))).toHaveLength(1);
        // Same body elements, same children, nothing new built.
        expect(items().map((i) => one(i, 'message-body'))).toEqual(bodies);
        items().forEach((i, k) => expect(one(i, 'message-body').descendants()).toEqual(bodyNodes[k]));
        expect(fakeDocument.created.length).toBe(created);

        chooseZone('UTC');
        expect(one(items()[0]!, 'message-date').textContent).toBe('2025-03-03 08:15:00 UTC+00:00');
        // The zone stays for the next result.
        preview.show(analysisOf([make({ date: dateAt('2025-03-03T08:15:00Z', -300) })]));
        expect(one(items()[0]!, 'message-date').textContent).toBe('2025-03-03 08:15:00 UTC+00:00');
    });

    it('shows hostile content as literal text and builds no element from it', () =>
    {
        const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
        preview.show(
            analysisOf([
                make({
                    subject: evil,
                    from: [{ name: evil, address: '"><svg onload=alert(3)>@example.test' }],
                    to: [{ name: '<b>bold</b>', address: 'x@example.test' }],
                    bodyText: `Before\n${evil}\n> <iframe srcdoc="<script>alert(4)</script>">\nAfter`,
                    attachments: [{ fileName: '<img src=x onerror=alert(5)>.pdf', size: 1, mimeType: 'text/html"><script>' }],
                }),
            ]),
        );
        setShowFolded(true);
        const item = items()[0]!;
        expect(one(item, 'message-subject').textContent).toBe(evil);
        expect(meta(item, 'author')).toBe(`${evil} <"><svg onload=alert(3)>@example.test>`);
        expect(renderedBody(item)).toContain(evil);
        expect(one(item, 'attachment').textContent).toContain('<img src=x onerror=alert(5)>.pdf');
        const tags = new Set(fakeDocument.created.map((e) => e.tagName));
        for (const tag of ['img', 'script', 'svg', 'iframe', 'b'])
        {
            expect(tags.has(tag), tag).toBe(false);
        }
        for (const element of fakeDocument.created)
        {
            for (const name of element.attributes.keys())
            {
                expect(name).not.toMatch(/^(on|src|href|style)/);
            }
        }
    });

    it('calls the decorate hook once per email, after building its item', () =>
    {
        const seen: [string, number, string][] = [];
        mount({ decorate: (item, m, position) => seen.push([m.message.subject, position, fake(item).tagName]) });
        const result = analysisOf(thread());
        preview.show(result);
        expect(seen).toEqual(result.messages.map((m, k) => [m.message.subject, k, 'li']));
    });
});

describe('chunked building', () =>
{
    let tasks: { task: () => void; handle: number }[];
    let cancelled: number[];

    beforeEach(() =>
    {
        tasks = [];
        cancelled = [];
        let next = 0;
        mount({
            chunkSize: 2,
            schedule: (task) =>
            {
                const handle = ++next;
                tasks.push({ task, handle });
                return handle;
            },
            cancel: (handle) => cancelled.push(handle as number),
        });
    });

    /** Runs the oldest scheduled task. */
    function runNext(): void
    {
        const next = tasks.shift();
        if (next === undefined)
        {
            throw new Error('nothing scheduled');
        }
        next.task();
    }

    const many = (n: number): ThreadAnalysisResult => analysisOf(Array.from({ length: n }, (_, k) => make({ subject: `Mail ${String(k)}` })));

    it('builds the first chunk at once and the rest later, in order', () =>
    {
        const result = many(5);
        preview.show(result);
        expect(items()).toHaveLength(2);
        expect(preview.isRendering()).toBe(true);
        expect(byId('preview-list').getAttribute('aria-busy')).toBe('true');
        runNext();
        expect(items()).toHaveLength(4);
        runNext();
        expect(items()).toHaveLength(5);
        expect(tasks).toEqual([]);
        expect(preview.isRendering()).toBe(false);
        expect(byId('preview-list').hasAttribute('aria-busy')).toBe(false);
        expect(items().map((i) => one(i, 'message-subject').textContent)).toEqual(result.messages.map((m) => m.message.subject));
    });

    it('builds later chunks with the zone and fold state of the moment', () =>
    {
        preview.show(analysisOf([...thread(), ...thread(), ...thread()]));
        chooseZone('Asia/Tokyo');
        setShowFolded(true);
        while (tasks.length > 0)
        {
            runNext();
        }
        expect(items()).toHaveLength(6);
        expect(items().every((i) => one(i, 'message-date').textContent.endsWith('UTC+09:00'))).toBe(true);
        // Folds built in the later chunks (emails 3 to 6) are open too.
        expect(items().slice(2).flatMap((i) => withClass(i, 'fold')).length).toBeGreaterThanOrEqual(2);
        expect(folds().every((d) => d.hasAttribute('open'))).toBe(true);
    });

    it('a new result cancels the chunks of the old one', () =>
    {
        preview.show(many(5));
        const stale = tasks[0]!;
        preview.show(many(3));
        expect(cancelled).toEqual([stale.handle]);
        // Even if the old task still ran, it adds nothing.
        stale.task();
        expect(items().map((i) => one(i, 'message-subject').textContent)).toEqual(['Mail 0', 'Mail 1']);
        tasks = tasks.filter((x) => x !== stale);
        runNext();
        expect(items()).toHaveLength(3);
    });

    it('calls onRendered once the last item is in the page, never for a replaced list, and survives it throwing', () =>
    {
        const queue: (() => void)[] = [];
        const seen: { result: ThreadAnalysisResult; count: number }[] = [];
        mount({
            chunkSize: 2,
            schedule: (task) => queue.push(task),
            cancel: () => undefined,
            onRendered: (result) =>
            {
                seen.push({ result, count: items().length });
                throw new Error('synthetic hook failure');
            },
        });
        const replaced = many(5);
        preview.show(replaced);
        const stale = queue.shift()!;
        const result = many(3);
        preview.show(result);
        stale(); // the replaced list's chunk: does nothing
        expect(seen).toEqual([]);
        while (queue.length > 0)
        {
            queue.shift()!();
        }
        expect(seen).toEqual([{ result, count: 3 }]);
        expect(preview.isRendering()).toBe(false);
        // A list built in one go, and an empty one, are complete at once.
        const small = many(1);
        preview.show(small);
        const empty = analysisOf([]);
        preview.show(empty);
        expect(seen.map((s) => s.result)).toEqual([result, small, empty]);
        expect(items()).toEqual([]);
    });

    it('reset() empties the list and cancels waiting chunks', () =>
    {
        preview.show(many(5));
        const stale = tasks[0]!;
        preview.reset();
        expect(cancelled).toEqual([stale.handle]);
        expect(items()).toEqual([]);
        expect(preview.isRendering()).toBe(false);
        stale.task();
        expect(items()).toEqual([]);
    });

    it('reset() during chunked building leaves an empty list, also after every stale chunk ran', () =>
    {
        preview.show(many(7));
        runNext();
        expect(items()).toHaveLength(4);
        preview.reset();
        expect(items()).toEqual([]);
        expect(byId('preview-list').hasAttribute('aria-busy')).toBe(false);
        while (tasks.length > 0)
        {
            runNext();
        }
        expect(items()).toEqual([]);
        expect(preview.isRendering()).toBe(false);
    });

    it('reset() puts the zone and the "show quoted text" checkbox back to their defaults', () =>
    {
        preview.show(analysisOf([...thread(), ...thread()]));
        chooseZone('Asia/Tokyo');
        setShowFolded(true);
        preview.reset();
        expect(preview.zone()).toBe('America/New_York');
        expect(byId('preview-zone').value).toBe('America/New_York');
        expect(byId('preview-show-folded').checked).toBe(false);
        // The next list follows the defaults: dates in the start zone, folds closed.
        preview.show(analysisOf(thread()));
        // New York: UTC-05:00, or UTC-04:00 once summer time starts (the synthetic thread moves on a day per call).
        expect(items().every((i) => /UTC-0[45]:00$/.test(one(i, 'message-date').textContent))).toBe(true);
        expect(folds().length).toBeGreaterThan(0);
        expect(folds().some((d) => d.hasAttribute('open'))).toBe(false);
    });

    it('a failed batch keeps the zone and checkbox (only reset() restores them)', () =>
    {
        chooseZone('Asia/Tokyo');
        setShowFolded(true);
        preview.showResult({ ok: false, error: 'engine-failed', detail: 'synthetic', parsed: [] });
        expect(preview.zone()).toBe('Asia/Tokyo');
        expect(byId('preview-show-folded').checked).toBe(true);
    });

    it('a failed batch (no thread analysis result) empties the list too', () =>
    {
        preview.showResult({ ok: true, threadAnalysis: many(5) });
        expect(items()).toHaveLength(2);
        preview.showResult({ ok: false, error: 'engine-failed', detail: 'synthetic', parsed: [] });
        expect(items()).toEqual([]);
        expect(cancelled).toHaveLength(1);
    });

    it('an email whose item fails to build gets a stand-in; every other email is still built', () =>
    {
        // Fails for "Mail 3": in the second chunk (chunk size 2), so later chunks must still come.
        // The full item built for it before the failure is kept, to check that it left nothing behind.
        let halfBuilt: FakeElement | undefined;
        mount({
            chunkSize: 2,
            schedule: (task) =>
            {
                const handle = tasks.length + 100;
                tasks.push({ task, handle });
                return handle;
            },
            cancel: () => undefined,
            decorate: (item, email) =>
            {
                if (email.message.subject !== 'Mail 3')
                {
                    return;
                }
                // Fails on the full item and on its stand-in too.
                if (!hasClass(fake(item), 'message-failed'))
                {
                    halfBuilt = fake(item);
                }
                throw new Error('synthetic decorate failure');
            },
        });
        const result = analysisOf(
            Array.from({ length: 6 }, (_, k) => make({ subject: `Mail ${String(k)}`, bodyText: `Body ${String(k)}\n\n-- \nSender ${String(k)}\n` })));
        preview.show(result);
        while (tasks.length > 0)
        {
            runNext();
        }
        expect(preview.isRendering()).toBe(false);
        const list = items();
        expect(list).toHaveLength(6);
        expect(list.map((i) => i.getAttribute('data-position'))).toEqual(['0', '1', '2', '3', '4', '5']);
        expect(list.map((i) => one(i, 'message-number').textContent)).toEqual(['#1', '#2', '#3', '#4', '#5', '#6']);
        const failed = list[3]!;
        expect(hasClass(failed, 'message-failed')).toBe(true);
        expect(one(failed, 'message-failed-note').textContent).toBe(t('preview.itemFailed'));
        // Its text is still in the page, whole (README.md, rule R6).
        expect(renderedBody(failed)).toBe(result.messages[3]!.message.bodyText);
        for (const [k, item] of list.entries())
        {
            if (k === 3)
            {
                continue;
            }
            expect(hasClass(item, 'message-failed')).toBe(false);
            expect(one(item, 'message-subject').textContent).toBe(`Mail ${String(k)}`);
        }
        // The half-built item left nothing behind: changing the zone and showing
        // the folded sections still work, and no longer reach that item.
        expect(halfBuilt).toBeDefined();
        const halfBuiltDate = one(halfBuilt!, 'message-date').textContent;
        const halfBuiltFolds = withClass(halfBuilt!, 'fold');
        expect(halfBuiltFolds.length).toBeGreaterThan(0);
        chooseZone('UTC');
        setShowFolded(true);
        expect(list.filter((i) => i !== failed).every((i) => one(i, 'message-date').textContent === t('preview.noDate') || one(i, 'message-date').textContent.endsWith('UTC+00:00'))).toBe(true);
        expect(one(halfBuilt!, 'message-date').textContent).toBe(halfBuiltDate);
        expect(halfBuiltDate.endsWith('UTC+00:00')).toBe(false);
        expect(halfBuiltFolds.every((d) => !d.hasAttribute('open'))).toBe(true);
    });

    it('a stand-in for an email without text has no body text', () =>
    {
        mount({
            decorate: () =>
            {
                throw new Error('synthetic decorate failure');
            },
        });
        preview.show(analysisOf([make({ subject: 'Empty', bodyText: '' })]));
        const failed = items()[0]!;
        expect(hasClass(failed, 'message-failed')).toBe(true);
        expect(withClass(failed, 'body-text')).toEqual([]);
    });

    it('the stand-in is passed to decorate too, so later controls cover every email', () =>
    {
        const calls: [string, number, boolean][] = [];
        mount({
            decorate: (item, email, position) =>
            {
                const isStandIn = hasClass(fake(item), 'message-failed');
                calls.push([email.message.subject, position, isStandIn]);
                // Fails on the full item of "Mail 1" only; its stand-in is decorated.
                if (email.message.subject === 'Mail 1' && !isStandIn)
                {
                    throw new Error('synthetic decorate failure');
                }
                item.setAttribute('data-decorated', 'yes');
            },
        });
        const result = analysisOf([make({ subject: 'Mail 0' }), make({ subject: 'Mail 1' }), make({ subject: 'Mail 2' })]);
        preview.show(result);
        expect(calls).toEqual([
            ['Mail 0', 0, false],
            ['Mail 1', 1, false],
            ['Mail 1', 1, true],
            ['Mail 2', 2, false],
        ]);
        const list = items();
        expect(list.map((i) => hasClass(i, 'message-failed'))).toEqual([false, true, false]);
        expect(list.map((i) => i.getAttribute('data-decorated'))).toEqual(['yes', 'yes', 'yes']);
        expect(renderedBody(list[1]!)).toBe(result.messages[1]!.message.bodyText);
    });

    it('if decorate fails on the stand-in too, an undecorated stand-in is shown (no half-done decoration)', () =>
    {
        let calls = 0;
        mount({
            decorate: (item) =>
            {
                calls++;
                item.setAttribute('data-half-done', 'yes');
                throw new Error('synthetic decorate failure');
            },
        });
        const result = analysisOf([make({ subject: 'Only', bodyText: 'Kept text.\n' })]);
        preview.show(result);
        expect(calls).toBe(2);
        const failed = items()[0]!;
        expect(hasClass(failed, 'message-failed')).toBe(true);
        expect(failed.hasAttribute('data-half-done')).toBe(false);
        expect(one(failed, 'message-number').textContent).toBe('#1');
        expect(renderedBody(failed)).toBe('Kept text.\n');
    });

    it('a missing message gets a stand-in without calling decorate (there is nothing to hand it)', () =>
    {
        const decorate = vi.fn();
        mount({ decorate });
        const result = analysisOf([make({ subject: 'Mail 0' })]);
        preview.show({ ...result, messages: [result.messages[0]!, undefined as unknown as ThreadAnalysisResult['messages'][number]] });
        expect(decorate).toHaveBeenCalledTimes(1);
        const list = items();
        expect(list.map((i) => hasClass(i, 'message-failed'))).toEqual([false, true]);
        expect(one(list[1]!, 'message-number').textContent).toBe('#2');
    });

    it('ends a chunk early when its bodies are very long, but always builds one email', () =>
    {
        preview.show(analysisOf([make({ bodyText: 'a'.repeat(MAX_CHUNK_CHARS) }), make({ bodyText: 'b'.repeat(MAX_CHUNK_CHARS) }), make()]));
        expect(items()).toHaveLength(1);
        runNext();
        expect(items()).toHaveLength(2);
        runNext();
        expect(items()).toHaveLength(3);
    });
});

// ------------------------------------------------------------------ PDF labels

describe('PDF labels', () =>
{
    let tasks: (() => void)[];

    beforeEach(() =>
    {
        tasks = [];
        mount({ chunkSize: 1, schedule: (task) => tasks.push(task), cancel: () => undefined });
    });

    const runAll = (): void =>
    {
        while (tasks.length > 0)
        {
            tasks.shift()?.();
        }
    };
    const list = (): FakeElement => byId('preview-list');
    const state = (): string | null => list().getAttribute('data-pdf-labels');
    /** The PDF label texts of an item, trimmed; '' for a folded block without a label. */
    const labelsOf = (item: FakeElement): string[] =>
        withClass(item, 'pdf-label').map((e) => (e.hasAttribute('hidden') ? '' : e.textContent.trim()));

    const BOB_SIGNATURE = '-- \nBob Sample\nBench Workshop (fictional company)\n';
    const ALICE_SIGNATURE = '-- \nAlice Example\nGarden Benches (fictional company)\n';
    const QUESTION = 'Could you paint the garden bench green before Friday, please? The old paint is coming off.\n';
    /** Alice asks (signed); Bob answers above a quote of her email (signed); Alice writes again (same signature). */
    function benchThread(): NormalizedMessage[]
    {
        const ask = make({ subject: 'Bench', bodyText: `${QUESTION}\n${ALICE_SIGNATURE}`, date: dateAt('2025-03-03T08:00:00Z') });
        const quoted = `${QUESTION}\n${ALICE_SIGNATURE}`
            .split('\n')
            .map((l) => (l === '' ? '>' : `> ${l}`))
            .join('\n');
        const reply = make({
            subject: 'Re: Bench',
            from: [BOB],
            to: [ALICE],
            bodyText: `Yes, green it is. It will be ready on Thursday.\n\n${BOB_SIGNATURE}\nOn Mon, 3 Mar 2025 at 09:00, Alice Example wrote:\n${quoted}\n`,
            date: dateAt('2025-03-03T10:00:00Z'),
        });
        const again = make({ subject: 'Bench delivery', bodyText: `Thursday is fine, thank you.\n\n${ALICE_SIGNATURE}`, date: dateAt('2025-03-03T12:00:00Z') });
        return [ask, reply, again];
    }
    /** The plans of `positions` of a result, as Source/web-page/pdf-labels.ts makes them. */
    function plansFor(result: ThreadAnalysisResult, positions: readonly number[], unfoldEverything = false): PreviewPdfPlans
    {
        const plans = planOutput(
            positions.map((p) => result.messages[p]!),
            { ...DEFAULT_OUTPUT_POLICY, unfoldEverything },
        );
        const sources = signatureSources(
            positions.map((p) => ({ message: result.messages[p]!.message, position: p })),
            plans,
        );
        return { result, views: new Map(positions.map((p, k) => [p, { plan: plans[k]!, signatureFrom: sources.get(p) ?? new Map<number, number>() }])) };
    }
    /**
     * plansFor with the PDF's no-repeat cut for the rebuilt emails `rebuilt`, as Source/web-page/pdf-labels.ts hands them over
     * (task 8.11); `unticked` (default: every rebuilt email not in `rebuilt`, as when the reader unticked their cards).
     */
    function plansWithCut(
        result: ThreadAnalysisResult,
        positions: readonly number[],
        rebuilt: readonly number[],
        unfoldEverything = false,
        rebuildingOff = false,
        unticked: readonly number[] = rebuiltEntries(result)
            .map((r) => r.id)
            .filter((id) => !rebuilt.includes(id)),
    ): PreviewPdfPlans
    {
        const base = plansFor(result, positions, unfoldEverything);
        const policy = { ...DEFAULT_OUTPUT_POLICY, unfoldEverything };
        const plans = positions.map((p) => base.views.get(p)!.plan);
        const cut = printedElsewhereRanges({ result, positions, plans, policy, rebuilt, rebuildingOff, unticked });
        const views = new Map(base.views);
        for (const [position, pdfRanges] of cut)
        {
            views.set(position, { ...views.get(position)!, pdfRanges });
        }
        return { result, views };
    }

    it('helpers: a part printed as an email of its own names that email (task 8.11), in every language', () =>
    {
        const asReal = { status: 'out' as const, reasons: ['forwarded' as const], signaturesFrom: [], printedAs: { kind: 'email' as const, position: 4, number: 3 } };
        const asRebuilt = { ...asReal, printedAs: { kind: 'rebuilt' as const, id: 7, number: 2 } };
        expect(pdfLabelText(asReal)).toBe('Not in this email in the PDF: printed as email #5');
        expect(pdfLabelText(asRebuilt)).toBe('Not in this email in the PDF: printed as a rebuilt email (Email 2 in the PDF)');
        // Only for a part left out: another status keeps its own label.
        expect(pdfLabelText({ ...asReal, status: 'in' })).toBe('In the PDF: forwarded email');
        expect(pdfLabelText({ ...asReal, printedAs: null })).toBe('Not in the PDF: forwarded email');
        // A forwarded part of an unticked rebuilt email (task 8.13a, Q2): printed nowhere.
        const asUnticked = { ...asReal, printedAs: { kind: 'unticked' as const, id: 7 } };
        expect(pdfLabelText(asUnticked)).toBe('Not in the PDF: forwarded email whose rebuilt email is unticked');
        // The printed block of an unticked attached email (task 8.13b-3, Q3): printed nowhere, named by its list number.
        const asUntickedAttached = { ...asReal, printedAs: { kind: 'unticked-attached' as const, position: 3 } };
        expect(pdfLabelText(asUntickedAttached)).toBe('Not in the PDF: email #4 (attached here) is unticked');
        setLocale('fr');
        try
        {
            expect(pdfLabelText(asUntickedAttached)).toBe('Pas dans le PDF : l’e-mail #4 (joint ici) est décoché');
            expect(pdfLabelText(asReal)).toBe('Pas dans cet e-mail dans le PDF : imprimé comme e-mail #5');
            expect(pdfLabelText(asRebuilt)).toBe('Pas dans cet e-mail dans le PDF : imprimé comme e-mail reconstitué (E-mail 2 du PDF)');
            expect(pdfLabelText(asUnticked)).toBe('Pas dans le PDF : e-mail transféré dont l’e-mail reconstitué est décoché');
            setLocale('nl');
            expect(pdfLabelText(asUntickedAttached)).toBe('Niet in de PDF: e-mail #4 (hier bijgevoegd) is niet aangevinkt');
            expect(pdfLabelText(asReal)).toBe('Niet in deze e-mail in de PDF: afgedrukt als e-mail #5');
            expect(pdfLabelText(asRebuilt)).toBe('Niet in deze e-mail in de PDF: afgedrukt als gereconstrueerde e-mail (E-mail 2 in de PDF)');
            expect(pdfLabelText(asUnticked)).toBe('Niet in de PDF: doorgestuurde e-mail waarvan de gereconstrueerde e-mail niet is aangevinkt');
        }
        finally
        {
            setLocale('en');
        }
    });

    describe('a forward whose forwarded emails are printed as emails of their own (task 8.11)', () =>
    {
        const FORWARD = THREAD_CASES.find((c) => c.id === 'gmail forward of an outlook thread')!;
        /** Message `i` of FORWARD as a real file (its body quotes the ones before it). */
        const realFile = (i: number): NormalizedMessage =>
        {
            const threadMessage = FORWARD.messages![i]!;
            const utcMs = instantOf(threadMessage.sent, threadMessage.zone);
            return make({
                from: [threadMessage.from],
                to: [...threadMessage.to],
                subject: threadMessage.subject,
                bodyText: buildThread(FORWARD.messages!.slice(0, i + 1)).body,
                date: { utcMs, original: new Date(utcMs).toUTCString(), offsetMinutes: threadMessage.zone.offsetMinutes, zoneKnown: true },
            });
        };
        const forwardText = (k: number): string => FORWARD.messages![k]!.text.split('\n\n')[1]!.split('\n')[0]!;

        it('the forward alone, its rebuilt emails ticked: each forwarded part says which PDF email prints it; unticked, "not in the PDF" (task 8.13a, Q2); the switch off, back to "In the PDF: forwarded email"', () =>
        {
            const result = analysisOf([realFile(2)]);
            const ids = rebuiltEntries(result).map((r) => r.id);
            expect(ids).toHaveLength(2);
            preview.show(result);
            runAll();
            const forward = items().find((i) => i.getAttribute('data-position') === '0')!;
            preview.setPdfPlans(plansWithCut(result, [0], ids));
            runAll();
            expect(state()).toBe('ready');
            // Rebuilt emails 1 and 2 come before the forward (email 3) in the PDF.
            const labels = labelsOf(forward).filter((s) => s !== '');
            expect(labels).toContain('Not in this email in the PDF: printed as a rebuilt email (Email 1 in the PDF)');
            expect(labels).toContain('Not in this email in the PDF: printed as a rebuilt email (Email 2 in the PDF)');
            // Each forwarded email's header lines and text are one block with one label (task 8.13a review round 2).
            expect(labels.filter((s) => s.includes('(Email 1 in the PDF)'))).toHaveLength(1);
            expect(labels.filter((s) => s.includes('(Email 2 in the PDF)'))).toHaveLength(1);
            // The header lines go with the forwarded parts (task 8.13a, Q4: moved to the rebuilt emails); nothing of them stays.
            expect(labels.some((s) => s.startsWith('In the PDF: forwarded email'))).toBe(false);
            // A real label element, text only, marked "out" like any part left out.
            const marks = withClass(forward, 'pdf-label').filter((e) => e.textContent.includes('printed as'));
            for (const mark of marks)
            {
                expect(mark.getAttribute('data-pdf')).toBe('out');
            }
            // The forwarded texts sit under those labels (a fold, or shown text with its mark above it,
            // as the forwarded email shown unfolded); every character is still in the page.
            const parts = one(forward, 'message-body').children.filter((c): c is FakeElement => c instanceof FakeElement);
            const under = (emailNumber: number): string =>
                parts
                    .flatMap((child, k) =>
                    {
                        if (!child.textContent.includes(`(Email ${String(emailNumber)} in the PDF)`))
                        {
                            return [];
                        }
                        return hasClass(child, 'pdf-label-shown') ? [parts[k + 1]!.textContent] : [child.textContent];
                    })
                    .join('');
            expect(under(1)).toContain(forwardText(0));
            expect(under(2)).toContain(forwardText(1));
            expect(under(2)).not.toContain(forwardText(0));
            expect(renderedBody(forward)).toBe(result.messages[0]!.message.bodyText);

            // Only the older one ticked: the newer part (its rebuilt email unticked) is not in the PDF at all (Q2).
            const older = rebuiltEntries(result).find((r) => r.rebuilt.generation === 2)!;
            preview.setPdfPlans(plansWithCut(result, [0], [older.id]));
            runAll();
            const some = labelsOf(forward).filter((s) => s !== '');
            expect(some).toContain('Not in this email in the PDF: printed as a rebuilt email (Email 1 in the PDF)');
            expect(some).toContain('Not in the PDF: forwarded email whose rebuilt email is unticked');
            expect(some.some((s) => s.includes('Email 2'))).toBe(false);
            expect(renderedBody(forward)).toBe(result.messages[0]!.message.bodyText);
            // None ticked: both forwarded parts are not in the PDF; the preview still shows every character.
            preview.setPdfPlans(plansWithCut(result, [0], []));
            runAll();
            const none = labelsOf(forward).filter((s) => s !== '');
            // One label per forwarded email (two unticked emails: two labels, never merged across them).
            expect(none).toHaveLength(2);
            expect(none.every((s) => s === 'Not in the PDF: forwarded email whose rebuilt email is unticked')).toBe(true);
            expect(renderedBody(forward)).toBe(result.messages[0]!.message.bodyText);
            // None chosen but none reported unticked either (a card list that fell back, review round 2): kept inline.
            preview.setPdfPlans(plansWithCut(result, [0], [], false, false, []));
            runAll();
            const kept = labelsOf(forward).filter((s) => s !== '');
            expect(kept.length).toBeGreaterThan(0);
            expect(kept.every((s) => s.startsWith('In the PDF: '))).toBe(true);
            // The switch off: as before task 8.11.
            preview.setPdfPlans(plansWithCut(result, [0], [], false, true));
            runAll();
            expect(labelsOf(forward).filter((s) => s !== '')).toEqual(labelsOf(forward).filter((s) => s !== '').map(() => 'In the PDF: forwarded email'));
            expect(renderedBody(forward)).toBe(result.messages[0]!.message.bodyText);
        });

        it('every email as a file: the forwarded parts name the real emails by their list number', () =>
        {
            const result = analysisOf([realFile(0), realFile(1), realFile(2)]);
            preview.show(result);
            runAll();
            preview.setPdfPlans(plansWithCut(result, [0, 1, 2], []));
            runAll();
            const forward = items().find((i) => i.getAttribute('data-position') === '2')!;
            const labels = labelsOf(forward).filter((s) => s !== '');
            expect(labels).toContain('Not in this email in the PDF: printed as email #1');
            expect(labels).toContain('Not in this email in the PDF: printed as email #2');
            // #2 unticked: its part is no longer printed elsewhere (its own file is out).
            preview.setPdfPlans(plansWithCut(result, [0, 2], []));
            runAll();
            const after = labelsOf(forward).filter((s) => s !== '');
            expect(after).toContain('Not in this email in the PDF: printed as email #1');
            expect(after.some((s) => s.includes('#2'))).toBe(false);
        });

        it('"Print full original text": nothing changes compared with before task 8.11, every label "In the PDF: ..."', () =>
        {
            const result = analysisOf([realFile(2)]);
            const ids = rebuiltEntries(result).map((r) => r.id);
            preview.show(result);
            runAll();
            preview.setPdfPlans(plansWithCut(result, [0], ids, true));
            runAll();
            const texts = labelsOf(items().find((i) => i.getAttribute('data-position') === '0')!).filter((s) => s !== '');
            expect(texts.length).toBeGreaterThan(0);
            for (const text of texts)
            {
                expect(text.startsWith('In the PDF: ')).toBe(true);
            }
            const plain = plansFor(result, [0], true);
            expect(plansWithCut(result, [0], ids, true).views.get(0)).toEqual(plain.views.get(0));
        });
    });

    it('helpers: label and reason texts', () =>
    {
        expect(pdfLabelText({ status: 'out', reasons: ['app-quoted-history'], signaturesFrom: [] })).toBe(
            'Not in the PDF: earlier email quoted by the mail app',
        );
        expect(pdfLabelText({ status: 'in', reasons: ['forwarded'], signaturesFrom: [] })).toBe('In the PDF: forwarded email');
        expect(pdfLabelText({ status: 'out', reasons: ['repeated-signature', 'app-quoted-history'], signaturesFrom: [3] })).toBe(
            'Not in the PDF: same signature as in email #3, earlier email quoted by the mail app',
        );
        // Signatures kept in two different emails: both are named.
        expect(pdfLabelText({ status: 'out', reasons: ['repeated-signature'], signaturesFrom: [1, 3] })).toBe(
            'Not in the PDF: same signature as in emails #1, #3',
        );
        expect(pdfLabelText({ status: 'out', reasons: ['repeated-signature'], signaturesFrom: [] })).toBe('Not in the PDF: repeated signature');
        expect(pdfLabelText({ status: 'partly', reasons: [], signaturesFrom: [] })).toBe('Partly in the PDF: text written in this email');
        expect(pdfReasonText('writer-quote', [])).toBe("quote that is part of the writer's text");
        expect(pdfReasonText('signature', [2])).toBe('signature');
    });

    it('helpers: in French the reasons are joined with ", " (only the email numbers are a list)', () =>
    {
        const list = (items: string[]): string => new Intl.ListFormat('fr', { style: 'short', type: 'unit' }).format(items);
        setLocale('fr');
        try
        {
            const signature = t('pdf.reason.signature');
            const same = t('pdf.repeatedFromMany', { list: list(['#1', '#3']) });
            expect(pdfLabelText({ status: 'out', reasons: ['signature', 'repeated-signature'], signaturesFrom: [1, 3] })).toBe(
                t('pdf.label.out', { reasons: `${signature}, ${same}` }),
            );
            // One "et" at most: the one inside the email numbers.
            expect(pdfLabelText({ status: 'out', reasons: ['signature', 'repeated-signature'], signaturesFrom: [1, 3] }).split(' et ')).toHaveLength(2);
        }
        finally
        {
            setLocale('en');
        }
    });

    it('starts "off": no labels, no status text; the fold texts are unchanged', () =>
    {
        expect(byId('pdf-labels-status').hasAttribute('hidden')).toBe(true); // no list yet
        preview.show(analysisOf(benchThread()));
        runAll();
        expect(state()).toBe('off');
        expect(preview.pdfLabelState()).toBe('off');
        // The line takes its place with the list (empty), so a tick later does not move the list.
        expect(byId('pdf-labels-status').hasAttribute('hidden')).toBe(false);
        expect(byId('pdf-labels-status').textContent).toBe('');
        for (const item of items())
        {
            expect(labelsOf(item).every((s) => s === '')).toBe(true);
        }
    });

    it('the status line keeps its place through updating and ready (only its text changes)', () =>
    {
        const result = analysisOf(benchThread());
        preview.show(result);
        runAll();
        const status = byId('pdf-labels-status');
        const seen: [string | null, boolean, string][] = [];
        const look = (): void =>
        {
            seen.push([state(), status.hasAttribute('hidden'), status.textContent]);
        };
        preview.setPdfPlans(null);
        look();
        preview.setPdfPlans(plansFor(result, [0, 1, 2]));
        runAll();
        look();
        preview.setPdfPlans(null);
        look();
        preview.setPdfPlans(plansFor(result, [1, 2]));
        runAll();
        look();
        expect(seen).toEqual([
            ['updating', false, 'Checking what goes in the PDF...'],
            ['ready', false, ''],
            ['updating', false, 'Checking what goes in the PDF...'],
            ['ready', false, ''],
        ]);
        // An empty list: no line at all.
        preview.show(analysisOf([]));
        expect(status.hasAttribute('hidden')).toBe(true);
    });

    it('an email whose labels cannot be updated says so (never silent), and is tried again next time', () =>
    {
        const result = analysisOf(benchThread());
        preview.show(result);
        runAll();
        const plans = plansFor(result, [0, 1, 2]);
        const view = plans.views.get(1)!;
        const views = new Map(plans.views);
        // A plan that cannot even be read (a bug): only email #2 is affected.
        const broken = Object.defineProperty({ ...view.plan }, 'ranges', {
            get: () =>
            {
                throw new Error('synthetic broken plan');
            },
        });
        views.set(1, { ...view, plan: broken });
        preview.setPdfPlans({ result, views });
        runAll();
        expect(state()).toBe('ready');
        const [ask, reply, again] = items();
        expect(labelsOf(reply!).every((s) => s === '')).toBe(true);
        const note = one(reply!, 'pdf-note');
        expect(note.hasAttribute('hidden')).toBe(false);
        expect(note.textContent).toBe(t('pdf.messageFailed'));
        expect(note.textContent).toBe('The tool could not show what the PDF leaves out for this email.');
        // The other emails have their labels.
        expect(labelsOf(ask!)).toEqual(['In the PDF: signature']);
        expect(labelsOf(again!)).toEqual(['Not in the PDF: same signature as in email #1']);
        expect(renderedBody(reply!)).toBe(result.messages[1]!.message.bodyText);
        // Good plans next time: the labels come back, the note goes.
        preview.setPdfPlans(plansFor(result, [0, 1, 2]));
        runAll();
        expect(labelsOf(reply!)).toEqual(['In the PDF: signature', 'Not in the PDF: earlier email quoted by the mail app']);
        expect(one(reply!, 'pdf-note').hasAttribute('hidden')).toBe(true);
    });

    it('an email with no text says it is not in the PDF, with no PDF label or note, ticked or not (task 8.14)', () =>
    {
        const spaces = ' \t\n \n﻿\n';
        const result = analysisOf([
            make({ subject: 'Has text', date: dateAt('2025-03-03T08:00:00Z') }),
            make({ subject: 'Empty', bodyText: '', date: dateAt('2025-03-03T09:00:00Z'), attachments: [{ fileName: 'plan.pdf', size: 10, mimeType: 'application/pdf' }] }),
            make({ subject: 'Spaces', bodyText: spaces, date: dateAt('2025-03-03T10:00:00Z') }),
            make({ subject: 'Unreadable', bodyText: '', warnings: ['rtf-only-body'], date: dateAt('2025-03-03T11:00:00Z') }),
        ]);
        preview.show(result);
        runAll();
        for (const positions of [[0, 1, 2, 3], [0, 3]])
        {
            preview.setPdfPlans(plansFor(result, positions));
            runAll();
            expect(state()).toBe('ready');
            const [text, empty, spaced, unreadable] = items();
            expect(withClass(text!, 'body-empty')).toEqual([]);
            for (const item of [empty!, spaced!])
            {
                expect(one(item, 'body-empty').textContent).toBe('Not in the PDF: this email has no text.');
                expect(labelsOf(item).every((s) => s === '')).toBe(true);
                expect(one(item, 'pdf-note').hasAttribute('hidden')).toBe(true);
            }
            // White space only: its blank text stays in the page, the note after it.
            expect(renderedBody(spaced!)).toBe(spaces);
            expect(renderedBody(empty!)).toBe('');
            // A text that could not be read stays in the PDF: "(no text)" as before.
            expect(one(unreadable!, 'body-empty').textContent).toBe(t('preview.noText'));
        }
        // Even a plan that fell back (whose note says the whole email is printed) gives it no PDF note: it is not printed.
        const base = plansFor(result, [0, 1, 2, 3]);
        const views = new Map(base.views);
        for (const position of [1, 2, 3])
        {
            views.set(position, { ...views.get(position)!, plan: { ...views.get(position)!.plan, fallback: true } });
        }
        preview.setPdfPlans({ result, views });
        runAll();
        const [, emptyItem, spacedItem, unreadableItem] = items();
        for (const item of [emptyItem!, spacedItem!])
        {
            expect(one(item, 'pdf-note').hasAttribute('hidden')).toBe(true);
        }
        expect(one(unreadableItem!, 'pdf-note').hasAttribute('hidden')).toBe(false);
        const noted = (): string[] => items().flatMap((i) => withClass(i, 'body-empty').map((e) => e.textContent));
        try
        {
            setLocale('fr');
            preview.relabel();
            expect(noted()).toEqual(['Pas dans le PDF\u{00A0}: cet e-mail n’a pas de texte.', 'Pas dans le PDF\u{00A0}: cet e-mail n’a pas de texte.', '(aucun texte)']);
            setLocale('nl');
            preview.relabel();
            expect(noted()).toEqual(['Niet in de PDF: deze e-mail heeft geen tekst.', 'Niet in de PDF: deze e-mail heeft geen tekst.', '(geen tekst)']);
        }
        finally
        {
            setLocale('en');
            preview.relabel();
        }
        expect(noted()).toEqual(['Not in the PDF: this email has no text.', 'Not in the PDF: this email has no text.', '(no text)']);
    });

    it('a stand-in of an email in the PDF says its labels cannot be shown; not when it is left out', () =>
    {
        mount({
            chunkSize: 1,
            schedule: (task) => tasks.push(task),
            cancel: () => undefined,
            decorate: (item, email) =>
            {
                if (email.message.subject === 'Re: Bench' && !hasClass(fake(item), 'message-failed'))
                {
                    throw new Error('synthetic decorate failure');
                }
            },
        });
        const result = analysisOf(benchThread());
        preview.show(result);
        runAll();
        const standIn = items()[1]!;
        expect(hasClass(standIn, 'message-failed')).toBe(true);
        const note = one(standIn, 'pdf-note');
        expect(note.textContent).toBe(t('pdf.messageFailed'));
        expect(note.hasAttribute('hidden')).toBe(true); // no plans yet
        preview.setPdfPlans(plansFor(result, [0, 1, 2]));
        runAll();
        expect(state()).toBe('ready');
        expect(note.hasAttribute('hidden')).toBe(false);
        // Unticked (not in the plans): the whole email is already marked "Not in the PDF" by the review.
        preview.setPdfPlans(plansFor(result, [0, 2]));
        runAll();
        expect(note.hasAttribute('hidden')).toBe(true);
        // Its whole text is still there, unfolded.
        expect(renderedBody(standIn)).toBe(result.messages[1]!.message.bodyText);
    });

    it('shows the plans as labels, cutting a block that is partly in the PDF', () =>
    {
        const result = analysisOf(benchThread());
        preview.show(result);
        runAll();
        preview.setPdfPlans(null);
        expect(state()).toBe('updating');
        const status = byId('pdf-labels-status');
        expect(status.hasAttribute('hidden')).toBe(false);
        expect(status.textContent).toBe('Checking what goes in the PDF...');

        preview.setPdfPlans(plansFor(result, [0, 1, 2]));
        runAll();
        expect(state()).toBe('ready');
        expect(status.hasAttribute('hidden')).toBe(false); // keeps its place, empty
        expect(status.textContent).toBe('');
        const [ask, reply, again] = items();
        expect(labelsOf(ask!)).toEqual(['In the PDF: signature']);
        // Bob's first signature (kept) and the quote below it (left out) were one folded block: now two.
        expect(labelsOf(reply!)).toEqual(['In the PDF: signature', 'Not in the PDF: earlier email quoted by the mail app']);
        expect(labelsOf(again!)).toEqual(['Not in the PDF: same signature as in email #1']);
        // The label is part of the fold's summary, before its own description.
        const summary = withClass(reply!, 'fold-label')[1]!;
        expect(summary.textContent).toMatch(/^Not in the PDF: earlier email quoted by the mail app \S/);
        expect(one(withClass(reply!, 'fold')[1]!, 'pdf-label').getAttribute('data-pdf')).toBe('out');
        // Nothing removed: every character is still in the page.
        items().forEach((item, k) => expect(renderedBody(item)).toBe(result.messages[k]!.message.bodyText));
    });

    it('an email left out of the PDF (not in the plans) gets no labels; plans for another result are ignored', () =>
    {
        const result = analysisOf(benchThread());
        preview.show(result);
        runAll();
        preview.setPdfPlans(plansFor(result, [1, 2]));
        runAll();
        expect(labelsOf(items()[0]!).every((s) => s === '')).toBe(true);
        // #3 now holds Alice's first kept signature.
        expect(labelsOf(items()[2]!)).toEqual(['In the PDF: signature']);

        preview.setPdfPlans(plansFor(analysisOf(benchThread()), [0, 1, 2]));
        expect(state()).toBe('updating');
        expect(preview.pdfLabelState()).toBe('updating');
    });

    it('an email unticked after its labels were shown keeps them in place but hidden, so the list below does not move', () =>
    {
        const result = analysisOf(benchThread());
        preview.show(result);
        runAll();
        preview.setPdfPlans(plansFor(result, [0, 1, 2]));
        runAll();
        const reply = items()[1]!;
        const folds = withClass(reply, 'fold');
        const marks = withClass(reply, 'pdf-label');
        const body = one(reply, 'message-body');
        const note = one(reply, 'pdf-note');
        expect(labelsOf(reply)).toEqual(['In the PDF: signature', 'Not in the PDF: earlier email quoted by the mail app']);
        expect(body.hasAttribute('data-pdf-out')).toBe(false);

        // #2 unticked: nothing redrawn (same blocks, same label elements, same
        // texts), only marked so that app.css hides its labels and note.
        preview.setPdfPlans(null);
        preview.setPdfPlans(plansFor(result, [0, 2]));
        runAll();
        expect(state()).toBe('ready');
        expect(withClass(reply, 'fold')).toEqual(folds);
        expect(withClass(reply, 'pdf-label')).toEqual(marks);
        expect(labelsOf(reply)).toEqual(['In the PDF: signature', 'Not in the PDF: earlier email quoted by the mail app']);
        expect(body.hasAttribute('data-pdf-out')).toBe(true);
        expect(note.hasAttribute('data-pdf-out')).toBe(true);
        // The others are not marked.
        for (const k of [0, 2])
        {
            expect(one(items()[k]!, 'message-body').hasAttribute('data-pdf-out')).toBe(false);
        }
        expect(renderedBody(reply)).toBe(result.messages[1]!.message.bodyText);

        // Ticked back: the same plan, so the same elements, shown again.
        preview.setPdfPlans(null);
        preview.setPdfPlans(plansFor(result, [0, 1, 2]));
        runAll();
        expect(withClass(reply, 'fold')).toEqual(folds);
        expect(withClass(reply, 'pdf-label')).toEqual(marks);
        expect(body.hasAttribute('data-pdf-out')).toBe(false);
        expect(note.hasAttribute('data-pdf-out')).toBe(false);
        expect(labelsOf(reply)).toEqual(['In the PDF: signature', 'Not in the PDF: earlier email quoted by the mail app']);
    });

    it('updates labels in place when the blocks stay the same, and keeps what the reader opened when they change', () =>
    {
        const result = analysisOf(benchThread());
        preview.show(result);
        runAll();
        preview.setPdfPlans(plansFor(result, [0, 1, 2]));
        runAll();
        const third = items()[2]!;
        const fold = one(third, 'fold');
        preview.setPdfPlans(plansFor(result, [1, 2]));
        runAll();
        expect(state()).toBe('ready');
        expect(one(third, 'fold')).toBe(fold); // same element, new label
        expect(labelsOf(third)).toEqual(['In the PDF: signature']);

        // Bob's reply: the reader opens the quote; a new shape (one block, all in) keeps it open.
        const reply = items()[1]!;
        const quote = withClass(reply, 'fold')[1]!;
        quote.setAttribute('open', '');
        preview.setPdfPlans(plansFor(result, [0, 1, 2], true));
        runAll();
        const after = withClass(reply, 'fold');
        expect(after).toHaveLength(1);
        expect(after[0]).not.toBe(quote);
        expect(after[0]!.hasAttribute('open')).toBe(true);
        expect(labelsOf(reply)).toEqual(['In the PDF: signature, earlier email quoted by the mail app']);
        expect(renderedBody(reply)).toBe(result.messages[1]!.message.bodyText);
        // The "show quoted text" checkbox still reaches the new block.
        setShowFolded(true);
        setShowFolded(false);
        expect(after[0]!.hasAttribute('open')).toBe(false);
        // "Print full original text": every label says "In the PDF".
        for (const item of items())
        {
            for (const text of labelsOf(item))
            {
                expect(text.startsWith('In the PDF: ')).toBe(true);
            }
        }
    });

    describe('keyboard focus through a redraw', () =>
    {
        /** Shows benchThread with its first plans; returns the result and Bob's reply (#2: two folds, signature in, quote out). */
        function ready(): { result: ThreadAnalysisResult; reply: FakeElement }
        {
            const result = analysisOf(benchThread());
            preview.show(result);
            runAll();
            preview.setPdfPlans(plansFor(result, [0, 1, 2]));
            runAll();
            const reply = items()[1]!;
            expect(withClass(reply, 'fold')).toHaveLength(2);
            return { result, reply };
        }
        const allFocuses = (): number => area.descendants().reduce((n, e) => n + e.focuses, 0);

        it('a focused fold summary that is redrawn: the focus goes to the new fold over the same text, without scrolling', () =>
        {
            const { result, reply } = ready();
            // The keyboard focus is on the quote's summary (the second fold).
            const oldSummary = withClass(reply, 'fold-label')[1]!;
            fakeDocument.activeElement = oldSummary;
            // "Print full original text": the two folds become one (a redraw).
            preview.setPdfPlans(plansFor(result, [0, 1, 2], true));
            runAll();
            const after = withClass(reply, 'fold-label');
            expect(after).toHaveLength(1);
            expect(after[0]).not.toBe(oldSummary);
            expect(after[0]!.focuses).toBe(1);
            expect(after[0]!.focusOptions).toEqual({ preventScroll: true });
            expect(allFocuses()).toBe(1);
            expect(renderedBody(reply)).toBe(result.messages[1]!.message.bodyText);

            // Back to the default: one fold cut in two; the focus goes to the first piece (where the fold starts).
            fakeDocument.activeElement = after[0]!;
            preview.setPdfPlans(plansFor(result, [0, 1, 2]));
            runAll();
            const cut = withClass(reply, 'fold-label');
            expect(cut).toHaveLength(2);
            expect(cut[0]!.focuses).toBe(1);
            expect(cut[1]!.focuses).toBe(0);
            expect(allFocuses()).toBe(1); // (the merged fold focused before is gone from the page)
        });

        it('focus elsewhere (or a body that is only relabelled) is never moved', () =>
        {
            const { result, reply } = ready();
            // On a control outside the list (or nowhere): nothing is focused by the redraw.
            for (const active of [byId('preview-zone'), fakeDocument.body, null])
            {
                fakeDocument.activeElement = active;
                preview.setPdfPlans(plansFor(result, [0, 1, 2], true));
                runAll();
                preview.setPdfPlans(plansFor(result, [0, 1, 2]));
                runAll();
            }
            expect(withClass(reply, 'fold')).toHaveLength(2); // redrawn each time
            // On another email's fold, whose body is only relabelled (same blocks): left alone.
            const third = items()[2]!;
            fakeDocument.activeElement = one(third, 'fold-label');
            preview.setPdfPlans(plansFor(result, [1, 2]));
            runAll();
            expect(allFocuses()).toBe(0);
            expect(one(reply, 'message-body').hasAttribute('tabindex')).toBe(false);
        });

        it('focus on the email body itself (not redrawn) is left alone', () =>
        {
            const { result, reply } = ready();
            const body = one(reply, 'message-body');
            fakeDocument.activeElement = body;
            preview.setPdfPlans(plansFor(result, [0, 1, 2], true));
            runAll();
            expect(withClass(reply, 'fold')).toHaveLength(1); // redrawn
            expect(allFocuses()).toBe(0);
            expect(body.hasAttribute('tabindex')).toBe(false);
        });

        describe('scrolling the new summary into view', () =>
        {
            type Rect = { top: number; bottom: number };
            /**
             * Focuses Bob's quote summary placed at `oldRect` (window: 600 high),
             * merges the two folds (a redraw), and returns how many scrollIntoView
             * calls were made in the whole check area, and the new summary (placed
             * at `newRect`: the fake has no layout, so every summary built by the
             * redraw reports it).
             */
            function merge(oldRect: Rect, newRect: Rect): { scrolls: number; summary: FakeElement }
            {
                const { result, reply } = ready();
                const oldSummary = withClass(reply, 'fold-label')[1]!;
                oldSummary.rect = oldRect;
                fakeDocument.activeElement = oldSummary;
                const create = fakeDocument.createElement.bind(fakeDocument);
                const spy = vi.spyOn(fakeDocument, 'createElement').mockImplementation((tag: string) =>
                {
                    const made = create(tag);
                    if (tag === 'summary')
                    {
                        made.rect = newRect;
                    }
                    return made;
                });
                preview.setPdfPlans(plansFor(result, [0, 1, 2], true));
                runAll();
                spy.mockRestore();
                const after = withClass(reply, 'fold-label');
                expect(after).toHaveLength(1);
                expect(after[0]!.focuses).toBe(1);
                expect(after[0]!.focusOptions).toEqual({ preventScroll: true });
                return { scrolls: area.descendants().reduce((n, e) => n + e.scrollIntoViewCalls.length, 0), summary: after[0]! };
            }

            it('old summary in view, new one above the window (a merge with the first fold open): scrolled, only as far as needed', () =>
            {
                const { scrolls, summary } = merge({ top: 10, bottom: 30 }, { top: -304, bottom: -284 });
                expect(summary.scrollIntoViewCalls).toEqual([{ block: 'nearest' }]);
                expect(scrolls).toBe(1);
            });

            it('old summary partly in view, new one partly below the window: scrolled too', () =>
            {
                const { scrolls, summary } = merge({ top: -10, bottom: 10 }, { top: 590, bottom: 610 });
                expect(summary.scrollIntoViewCalls).toEqual([{ block: 'nearest' }]);
                expect(scrolls).toBe(1);
            });

            it('old summary out of view (the reader scrolled away): never scrolled back', () =>
            {
                expect(merge({ top: -500, bottom: -480 }, { top: -900, bottom: -880 }).scrolls).toBe(0);
                expect(merge({ top: 700, bottom: 720 }, { top: 650, bottom: 670 }).scrolls).toBe(0);
            });

            it('new summary fully in view: not scrolled', () =>
            {
                expect(merge({ top: 300, bottom: 320 }, { top: 0, bottom: 20 }).scrolls).toBe(0);
                expect(merge({ top: 300, bottom: 320 }, { top: 580, bottom: 600 }).scrolls).toBe(0);
            });
        });

        it('no fold left over the focused block: the focus goes to the email body itself, never to the top of the page', () =>
        {
            const { result, reply } = ready();
            // Focus in shown text (as with caret browsing): no fold covers that text after the redraw.
            fakeDocument.activeElement = withClass(reply, 'body-text')[0]!;
            const body = one(reply, 'message-body');
            preview.setPdfPlans(plansFor(result, [0, 1, 2], true));
            runAll();
            expect(body.focuses).toBe(1);
            expect(body.focusOptions).toEqual({ preventScroll: true });
            expect(body.getAttribute('tabindex')).toBe('-1');
            expect(allFocuses()).toBe(1);
            // Made focusable only for this: once the focus leaves it, it is not focusable any more.
            body.fire('blur');
            expect(body.hasAttribute('tabindex')).toBe(false);
        });
    });

    it('applies new plans in chunks, and emails built later get their labels as they are built', () =>
    {
        const result = analysisOf(benchThread());
        preview.show(result);
        expect(items()).toHaveLength(1);
        preview.setPdfPlans(plansFor(result, [0, 1, 2]));
        expect(state()).toBe('ready'); // the one email built so far is done
        expect(labelsOf(items()[0]!)).toEqual(['In the PDF: signature']);
        runAll();
        expect(labelsOf(items()[2]!)).toEqual(['Not in the PDF: same signature as in email #1']);

        // Every email built: PDF_CHUNK_FACTOR emails per chunk (chunk size 1); ready only at the end.
        const many = analysisOf(
            Array.from({ length: PDF_CHUNK_FACTOR + 2 }, (_, k) => make({ subject: `Mail ${String(k)}`, bodyText: `Note ${String(k)}.\n\n${ALICE_SIGNATURE}` })),
        );
        preview.show(many);
        runAll();
        const all = many.messages.map((_, p) => p);
        preview.setPdfPlans(plansFor(many, all));
        expect(state()).toBe('updating');
        expect(tasks).toHaveLength(1);
        // A newer change before the next chunk: the old chunk does nothing.
        preview.setPdfPlans(null);
        runAll();
        expect(state()).toBe('updating');
        preview.setPdfPlans(plansFor(many, all));
        runAll();
        expect(state()).toBe('ready');
        expect(labelsOf(items().at(-1)!)).toEqual(['Not in the PDF: same signature as in email #1']);
    });

    it('notes an email the PDF keeps whole', () =>
    {
        const result = analysisOf(benchThread());
        preview.show(result);
        runAll();
        const plans = plansFor(result, [0, 1, 2]);
        const view = plans.views.get(1)!;
        const views = new Map(plans.views);
        views.set(1, { ...view, plan: { ...view.plan, ranges: view.plan.ranges.map((r) => ({ ...r, keep: true })), keptAllBecauseEmpty: true } });
        preview.setPdfPlans({ result, views });
        runAll();
        const note = one(items()[1]!, 'pdf-note');
        expect(note.hasAttribute('hidden')).toBe(false);
        expect(note.textContent).toBe('The whole email will be in the PDF: the tool could not tell its own text from the quote.');
        expect(one(items()[0]!, 'pdf-note').hasAttribute('hidden')).toBe(true);
        // The note is not part of the email's text.
        expect(renderedBody(items()[1]!)).toBe(result.messages[1]!.message.bodyText);
    });

    it('failed plans: labels hidden, a note says so; reset() turns everything off', () =>
    {
        const result = analysisOf(benchThread());
        preview.show(result);
        runAll();
        preview.setPdfPlans(plansFor(result, [0, 1, 2]));
        runAll();
        preview.pdfPlansFailed();
        expect(state()).toBe('failed');
        expect(byId('pdf-labels-status').textContent).toBe(t('pdf.failed'));
        expect(byId('pdf-labels-status').hasAttribute('hidden')).toBe(false);
        preview.reset();
        expect(state()).toBe('off');
        expect(byId('pdf-labels-status').hasAttribute('hidden')).toBe(true);
        expect(items()).toHaveLength(0);
    });

    it('adds the toolbar items at the end of the toolbar', () =>
    {
        const extra = fakeDocument.createElement('div');
        mount({ toolbarItems: [extra as unknown as Node] });
        const toolbar = byId('preview-toolbar');
        expect(toolbar.children.at(-2)).toBe(extra);
        expect(toolbar.children.at(-1)).toBe(byId('pdf-labels-status'));
    });
});
