// Unit tests for the emails rebuilt from quoted text in the PDF document
// model (Source/pdf-export/build-pdf-document.ts: planPdfOrder, buildPdfDocument; tasks 7.7 and
// 8.3): their place, the numbering, the follow-source rule, the switch,
// what a rebuilt email shows, the index, the cover, and the hashes of real
// files only. USER DECISION 2026-11-02 (task 8.3, PDF only): a rebuilt email
// looks and is numbered exactly like a real one; nothing in the PDF says it
// was rebuilt (the preview still does). Synthetic fixtures only
// (Helper/Test/test-data/eml), run through the real thread analysis and output plan, as the
// app does; a few results are edited by hand to reach rare cases (a day
// without a time, no sender, a list read short).
import { beforeAll, describe, expect, it } from 'vitest';
import { parseAllFixtures } from '../../Helper/Test/test-data/parse-all-fixtures';
import { analyzeThread } from '../thread-analysis/analyze-thread';
import { DEFAULT_OUTPUT_POLICY, planOutput } from '../thread-analysis/output-plan';
import { translator } from '../web-page/translations';
import { pdfCut } from '../web-page-logic/printed-elsewhere';
import { previewOrder, rebuiltEntries } from '../web-page-logic/rebuilt-email-display';
import { applyNoRepeatRule, buildPdfDocument, dayStartInZone, emailAnchor, planPdfOrder, type NoRepeatInput } from './build-pdf-document';
import { createPdfStrings } from './pdf-strings';
import { bodyLines, lineText } from './pdf-text-transforms';
import type { MessagePlan, OutputPolicy } from '../../Header/output-plan';
import type { NormalizedMessage } from '../../Header/parsed-email';
import type { PdfBlock, PdfDocument, PdfEmail, PdfLine, PdfStrings } from '../../Header/pdf-document-model';
import type { AnalyzedRebuiltMessage, QuotedDate } from '../../Header/rebuilt-emails';
import type { Segment, ThreadAnalysisResult } from '../../Header/thread-analysis-result';

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
const analysisOf = (...names: string[]): ThreadAnalysisResult => analyzeThread(names.map((n) => ({ ok: true as const, message: fixture(n) })));

/** The last email of a synthetic thread: alone, it gives 3 rebuilt entries (ids 2, 1, 0, oldest first) before it. */
const LAST = '13-order-4-bob-outlook-nl.eml';
/** The email before it: with LAST, the two older emails are quoted in both (an entry and a copy each). */
const THIRD = '12-order-3-alice-gmail.eml';
const EN = createPdfStrings('en');

/** A copy of `result` with rebuilt message `rebuiltId` changed by `edit`. */
function withRebuilt(
    result: ThreadAnalysisResult, rebuiltId: number, edit: (rebuiltEntry: AnalyzedRebuiltMessage) => AnalyzedRebuiltMessage): ThreadAnalysisResult
{
    return { ...result, reconstructed: result.reconstructed.map((r) => (r.id === rebuiltId ? edit(r) : r)) };
}

/** Builds the document of `result` with the given real positions (default all) and rebuilt ids (default every entry). */
function build(
    result: ThreadAnalysisResult,
    options: { positions?: readonly number[]; rebuilt?: readonly number[] | null; timeZone?: string; strings?: PdfStrings; policy?: OutputPolicy } = {},
): PdfDocument
{
    const positions = options.positions ?? result.messages.map((_, k) => k);
    const policy = options.policy ?? DEFAULT_OUTPUT_POLICY;
    const plans = planOutput(
        positions.map((p) => result.messages[p]!),
        policy,
    );
    const rebuilt = options.rebuilt === undefined ? rebuiltEntries(result).map((r) => r.id) : options.rebuilt;
    return buildPdfDocument({
        result,
        positions,
        plans,
        policy,
        timeZone: options.timeZone ?? 'Africa/Lagos',
        generatedAt: Date.UTC(2025, 5, 1, 12, 0, 0),
        strings: options.strings ?? EN,
        ...(rebuilt === null ? {} : { rebuilt }),
    });
}

const text = (line: PdfLine): string => lineText(line);
const fieldOf = (e: PdfEmail, label: string): string[] | undefined => e.fields.find((f) => f.label === label)?.value.map(text);
const rebuiltOf = (pdfDocument: PdfDocument): PdfEmail[] => pdfDocument.emails.filter((e) => e.rebuilt !== null);
const rebuiltById = (pdfDocument: PdfDocument, id: number): PdfEmail => pdfDocument.emails.find((e) => e.rebuilt?.id === id)!;
const blockTexts = (blocks: readonly PdfBlock[]): string[] =>
    blocks.flatMap((block) =>
    {
        switch (block.kind)
        {
            case 'heading':
            case 'paragraph':
                return [text(block.line)];
            case 'fields':
                return block.rows.map((r) => `${r.label}: ${r.value.map(text).join(' / ')}`);
            case 'list':
                return block.items.map((item) => item.map(text).join(' / '));
        }
    });

/**
 * Every text the PDF writes for a document EXCEPT the email bodies (message
 * text, printed as it is): the cover, the index (column titles, rows,
 * bookmarks), every email's heading, header rows, notes and attachment list.
 */
function ownTexts(pdfDocument: PdfDocument): string[]
{
    const texts = [pdfDocument.title, ...blockTexts(pdfDocument.cover.blocks), pdfDocument.index.heading,
        ...Object.values(pdfDocument.index.columns)];
    for (const indexEntry of pdfDocument.index.entries)
    {
        texts.push(String(indexEntry.number), text(indexEntry.date), text(indexEntry.from), text(indexEntry.subject), indexEntry.bookmark,
            ...indexEntry.attachmentLines.map(text));
    }
    for (const email of pdfDocument.emails)
    {
        texts.push(email.heading, ...email.fields.flatMap((f) => [f.label, ...f.value.map(text)]), ...email.notes.map(text));
        if (email.attachments !== null)
        {
            texts.push(email.attachments.label, ...email.attachments.items.map(text));
        }
    }
    return texts;
}

/**
 * What the PDF used to write for a rebuilt email (before task 8.3), in
 * `locale`: the preview's rebuilt texts it reused (still used by the
 * preview, so read from there) and its own removed texts (written out).
 */
function removedTexts(locale: 'en' | 'fr' | 'nl'): { fragments: string[]; word: RegExp }
{
    const { t } = translator(locale);
    const before = (s: string): string => s.split('\u0000')[0]!.trim();
    const own: Record<typeof locale, string[]> = {
        en: ['Earlier email (rebuilt', '[Rebuilt]', 'Rebuilt emails', 'Earlier emails rebuilt from quoted text', 'They are not original files.'],
        fr: ['E-mail antérieur (reconstitué', '[Reconstitué]', 'E-mails reconstitués', 'Ce ne sont pas des fichiers d’origine.'],
        nl: ['Eerdere e-mail (gereconstrueerd', '[Gereconstrueerd]', 'Gereconstrueerde e-mails', 'Het zijn geen originele bestanden.'],
    };
    return {
        fragments: [
            ...own[locale],
            before(t('rebuilt.noteMarks', { number: '\u0000' })),
            before(t('rebuilt.noteNoMarks', { number: '\u0000' })),
            before(t('rebuilt.alsoOne', { list: '\u0000' })),
            before(t('rebuilt.alsoMany', { list: '\u0000' })),
            t('rebuilt.takenFrom'),
            t('rebuilt.listIncomplete'),
            t('rebuilt.noSubject'),
            t('rebuilt.dateUnreadable'),
            before(t('rebuilt.dateAsWritten', { text: '\u0000' })),
            // "about 2025-...": the dates shown all start with their year.
            t('rebuilt.dateAbout', { date: '2025' }),
        ],
        word: { en: /rebuilt/i, fr: /reconstitu/i, nl: /gereconstrueerd/i }[locale],
    };
}

/** Entries with a copy in the other email, and where each copy was read (list positions). */
function sharedEntries(result: ThreadAnalysisResult): { entry: AnalyzedRebuiltMessage; own: number; other: number; copy: AnalyzedRebuiltMessage }[]
{
    return rebuiltEntries(result)
        .filter((e) => e.copies.length > 0)
        .map((entry) =>
        {
            const copy = result.reconstructed[entry.copies[0]!]!;
            return { entry, copy, own: result.positionByIndex[entry.sourceIndex]!, other: result.positionByIndex[copy.sourceIndex]! };
        });
}

// ---------------------------------------------------------------- the plan

describe('planPdfOrder', () =>
{
    it('puts each rebuilt email chosen at its place in the timeline, before the email it was taken from, numbered with the real ones', () =>
    {
        const result = analysisOf(LAST);
        const order = planPdfOrder(result, [0], [0, 1, 2]);
        expect(order.slots.map((s) => `${s.kind === 'email' ? 'email' : `rebuilt ${String(s.entry.id)}`} #${String(s.number)}`)).toEqual([
            'rebuilt 2 #1',
            'rebuilt 1 #2',
            'rebuilt 0 #3',
            'email #4',
        ]);
        // The real email is number 4 in this PDF (task 8.3): every email counts.
        expect(order.pdfNumberByPosition).toEqual([4]);
        for (const slot of order.slots)
        {
            if (slot.kind !== 'rebuilt')
            {
                continue;
            }
            // The source's rank among the real emails (not printed; the PDF number is in pdfNumberByPosition).
            expect(slot.source.number).toBe(1);
            expect(slot.source.also).toEqual([]);
            expect(slot.source.shown.rebuilt).toBe(slot.entry);
        }
    });

    it('gives none with the switch off ([] or nothing given), and the real emails exactly as before', () =>
    {
        const result = analysisOf(LAST);
        for (const ids of [[], undefined])
        {
            const order = planPdfOrder(result, [0], ids);
            expect(order.slots).toEqual([{ kind: 'email', position: 0, number: 1, plan: 0 }]);
            expect(order.pdfNumberByPosition).toEqual([1]);
        }
    });

    it('follows the source email: none when the email they were taken from is not in the PDF (user decision Q1 (a))', () =>
    {
        const result = analysisOf(LAST);
        expect(planPdfOrder(result, [], [0, 1, 2]).slots).toEqual([]);
        expect(planPdfOrder(result, [], [0, 1, 2]).pdfNumberByPosition).toEqual([null]);
    });

    it('ignores unknown, repeated and non-entry ids', () =>
    {
        const result = analysisOf(LAST);
        const order = planPdfOrder(result, [0], [99, -1, 1.5, 1, 1, Number.NaN]);
        expect(order.slots.map((s) => (s.kind === 'email' ? 'email' : s.entry.id))).toEqual([1, 'email']);
        expect(order.slots.map((s) => s.number)).toEqual([1, 2]);
        // A copy ('same-as') or a rebuilt email matched to a real file ('real') never gets a place of its own.
        const two = analysisOf(THIRD, LAST);
        const all = two.reconstructed.map((r) => r.id);
        const ids = planPdfOrder(two, [0, 1], all).slots.flatMap((s) => (s.kind === 'rebuilt' ? [s.entry.id] : []));
        expect(ids.length).toBeGreaterThan(0);
        for (const id of ids)
        {
            expect(two.reconstructed[id]!.link).toBe('entry');
        }
        expect(new Set(ids).size).toBe(ids.length);
        const files = analysisOf('10-order-1-alice.eml', '11-order-2-bob-outlook-en.eml', THIRD, LAST);
        const real = planPdfOrder(files, [0, 1, 2, 3], files.reconstructed.map((r) => r.id));
        expect(real.slots.every((s) => s.kind === 'email')).toBe(true);
        expect(real.pdfNumberByPosition).toEqual([1, 2, 3, 4]);
    });

    it('gives no rebuilt email when the timeline is not valid (the real emails alone, as given)', () =>
    {
        const result = analysisOf(LAST);
        const order = planPdfOrder({ ...result, timeline: [] }, [0], [0, 1, 2]);
        expect(order.slots.map((s) => s.kind)).toEqual(['email']);
        expect(order.pdfNumberByPosition).toEqual([1]);
    });

    it('numbers by place IN THE PDF, which differs from the preview number once an email is left out or a rebuilt one comes first', () =>
    {
        const result = analysisOf(THIRD, LAST);
        expect(result.messages).toHaveLength(2);
        expect(sharedEntries(result).length).toBeGreaterThan(0);
        // Only the second email (preview #2) in the PDF: after its rebuilt emails.
        const order = planPdfOrder(result, [1], rebuiltEntries(result).map((r) => r.id));
        const rebuilt = order.slots.filter((s) => s.kind === 'rebuilt');
        expect(rebuilt.length).toBeGreaterThan(0);
        expect(order.pdfNumberByPosition).toEqual([null, order.slots.length]);
        expect(order.slots.map((s) => s.number)).toEqual(order.slots.map((_, k) => k + 1));
        for (const slot of rebuilt)
        {
            expect(slot.source.shown.position).toBe(1);
            expect(slot.source.number).toBe(1); // its rank among the real emails
            expect(slot.source.also).toEqual([]);
        }
    });

    it('keeps a text quoted in several emails while one of them is in the PDF, taken from one in the PDF (follow-source rule)', () =>
    {
        const result = analysisOf(THIRD, LAST);
        expect(sharedEntries(result).length).toBeGreaterThan(0);
        for (const { entry, copy, own, other } of sharedEntries(result))
        {
            expect(own).not.toBe(other);
            const plan = (positions: number[]) =>
            {
                const order = planPdfOrder(result, positions, [entry.id]);
                const slot = order.slots.find((s) => s.kind === 'rebuilt');
                return slot?.kind === 'rebuilt' ? { source: slot.source, numbers: order.pdfNumberByPosition } : null;
            };
            // Both in: its own source, the other one "also in", by their rank among the real emails (positions 0, 1: ranks 1, 2).
            const both = plan([0, 1]);
            expect(both?.source.shown.rebuilt).toBe(entry);
            expect(both?.source.number).toBe(own + 1);
            expect(both?.source.also).toEqual([other + 1]);
            // Its own source left out: shown as read from the other email.
            const otherOnly = plan([other]);
            expect(otherOnly?.source.shown.rebuilt).toBe(copy);
            expect(otherOnly?.source.shown.position).toBe(other);
            expect(otherOnly?.source.number).toBe(1);
            expect(otherOnly?.numbers[other]).not.toBeNull();
            expect(otherOnly?.source.also).toEqual([]);
            // Neither: not in the PDF.
            expect(plan([])).toBeNull();
        }
    });

    it('keeps the real emails in the order given (positions not in list order), the rebuilt ones placed before the first later email', () =>
    {
        const result = analysisOf(LAST);
        const order = planPdfOrder(result, [0, 0, 7], [2]);
        expect(order.slots.map((s) => s.kind)).toEqual(['rebuilt', 'email']);
        expect(order.slots.map((s) => s.number)).toEqual([1, 2]);
        expect(order.pdfNumberByPosition).toEqual([2]);
    });
});

// ---------------------------------------------------------------- the document

describe('a rebuilt email in the PDF document (task 8.3: shown like a real email)', () =>
{
    it('is numbered 1..n with the real ones, in timeline order, with the same heading and an "email-N" anchor', () =>
    {
        const pdfDocument = build(analysisOf(LAST));
        expect(pdfDocument.emails.map((e) => e.heading)).toEqual(['Email 1', 'Email 2', 'Email 3', 'Email 4']);
        expect(pdfDocument.emails.map((e) => e.number)).toEqual([1, 2, 3, 4]);
        expect(pdfDocument.emails.map((e) => e.position)).toEqual([null, null, null, 0]);
        expect(pdfDocument.emails.map((e) => e.anchor)).toEqual([1, 2, 3, 4].map(emailAnchor));
        // Data only (never printed): which entry it is and where it was read.
        // No header lines moved to them (task 8.13a, Q4): the reply's plan leaves its quoted history out, header lines included.
        expect(rebuiltOf(pdfDocument).map((e) => e.rebuilt)).toEqual(
            [2, 1, 0].map((id) => ({ id, shownId: id, sourcePosition: 0, movedHeaders: 0 })));
        expect(pdfDocument.pdfNumberByPosition).toEqual([4]);
    });

    it('shows the fields read from the quote as a real email does: no "Taken from" row, no File row (it has no file)', () =>
    {
        const pdfDocument = build(analysisOf(LAST));
        const [, gmail, outlookNl] = rebuiltOf(pdfDocument);
        expect(outlookNl!.fields.map((f) => f.label)).toEqual(['From', 'To', 'Date', 'Subject']);
        expect(fieldOf(outlookNl!, 'From')).toEqual(['Alice Example <alice@example.test>']);
        expect(fieldOf(outlookNl!, 'Subject')).toEqual(['Re: Office desks and chairs']);
        // A time read without a zone of its own: written as a real email's date, alone (task 8.8: no
        // "time zone not given" line, the app says it); no "about", no "As written in the quote".
        expect(fieldOf(outlookNl!, 'Date')).toEqual([expect.stringMatching(/^2025-03-03 \d\d:40:00 UTC\+01:00$/)]);
        expect(outlookNl!.flags.zoneUnknown).toBe(true);
        for (const email of rebuiltOf(pdfDocument))
        {
            expect(fieldOf(email, 'File')).toBeUndefined();
            expect(fieldOf(email, 'Taken from')).toBeUndefined();
        }
        // An attribution holds no subject: it takes the subject of the nearest newer header in the chain
        // (user decision F3, task 9.9a: the Outlook NL block above it), printed as it is, not muted.
        expect(gmail!.fields.find((f) => f.label === 'Subject')!.value).toEqual([[{ role: 'field-value', text: 'Re: Office desks and chairs' }]]);
    });

    it('carries no note of its own, and its rebuilt text, whole but for a signature block already printed (task 9.9b-2)', () =>
    {
        const result = analysisOf(LAST);
        const pdfDocument = build(result);
        expect(rebuiltOf(pdfDocument).map((e) => e.notes)).toEqual([[], [], []]);
        // Oldest first: Alice's request, Bob's answer, Alice's "Wednesday" reply. Both of Alice's texts end
        // with the same block (her closing name and her "-- " signature): folded in both (the frequency
        // rule counts her two rebuilt emails), printed the first time only, as for real emails (rule 3).
        const signature = ['Alice', '', '-- ', 'Alice Example', 'Sent from my laptop'];
        const [request, answer, reply] = rebuiltOf(pdfDocument);
        expect(reply!.body.map(text)).toEqual(['Wednesday at 10:00 works for me. See you then.']);
        expect(request!.body.map(text).slice(-signature.length)).toEqual(signature);
        for (const email of [request!, answer!])
        {
            const rebuiltEntry = result.reconstructed[email.rebuilt!.id]!;
            expect(rebuiltEntry.segments?.some((s) => s.folded && s.reasons.includes('signature'))).toBe(true);
            const lines = bodyLines(rebuiltEntry.rebuilt.reconstructedText);
            expect(email.body.map(text)).toEqual(lines.lines.map(text));
        }
        for (const email of rebuiltOf(pdfDocument))
        {
            expect(email.body.map(text).join('\n')).not.toMatch(/^>/m);
            expect(email.attachments).toBeNull();
        }
        // Policy 'all' (rule 3): every signature printed, so every rebuilt text whole.
        const all = build(result, { policy: { ...DEFAULT_OUTPUT_POLICY, signatures: 'all' } });
        for (const email of rebuiltOf(all))
        {
            expect(email.body.map(text)).toEqual(bodyLines(result.reconstructed[email.rebuilt!.id]!.rebuilt.reconstructedText).lines.map(text));
        }
    });

    it('shows a deeper quote left in its text without its marks, as a real email does (tasks 8.1 and 8.6)', () =>
    {
        // A reply quoting Bob, whose own text quotes an older line with no header of its own (">>"):
        // the rebuilt email is Bob's text, its quote marks removed by the thread analysis; the older line keeps one ">".
        const reply: NormalizedMessage = {
            ...fixture(LAST),
            messageId: 'quote-levels-1@example.test',
            inReplyTo: null,
            references: [],
            subject: 'Re: Oak desks',
            bodyText:
                'Thanks, Bob.\n\nAlice\n\nOn Tue, 4 Mar 2025 at 09:00, Bob Sample <bob@furniture.example.test> wrote:\n> I agree with this point:\n>\n>> The desks are oak.\n>> They arrive on Monday.\n>\n> Bob\n',
            attachments: [],
        };
        const result = analyzeThread([{ ok: true, message: reply }]);
        const entry = rebuiltEntries(result)[0];
        expect(entry).toBeDefined();
        expect(entry!.rebuilt.reconstructedText).toBe('I agree with this point:\n\n> The desks are oak.\n> They arrive on Monday.\n\nBob\n');
        const pdfDocument = build(result);
        const email = rebuiltById(pdfDocument, entry!.id);
        expect(email.body.map(text)).toEqual(['I agree with this point:', '', 'The desks are oak.', 'They arrive on Monday.', '', 'Bob']);
        // The real email under "Print full original text": the same lines (one level deeper there, which the PDF does not show).
        const whole = build(result, { policy: { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true } }).emails[0]!;
        const lineIndex = whole.body.map(text).indexOf('The desks are oak.');
        expect(whole.body.map(text).slice(lineIndex - 2, lineIndex + 4)).toEqual(
            ['I agree with this point:', '', 'The desks are oak.', 'They arrive on Monday.', '', 'Bob']);
    });

    it('says nowhere that the same text is quoted in another email', () =>
    {
        const result = analysisOf(THIRD, LAST);
        expect(sharedEntries(result).length).toBeGreaterThan(0);
        const pdfDocument = build(result);
        for (const email of rebuiltOf(pdfDocument))
        {
            expect(email.notes).toEqual([]);
        }
        expect(ownTexts(pdfDocument).some((t) => t.includes('Same quoted text'))).toBe(false);
    });

    it('shows its date from the best value read, as for a real email: a day alone as that day, else "no date"', () =>
    {
        const base = analysisOf(LAST);
        const day = Date.UTC(2025, 2, 3);
        const dated = (date: Partial<QuotedDate>, approximate: boolean) =>
            withRebuilt(base, 0, (rebuiltEntry) => ({
                ...rebuiltEntry,
                rebuilt: {
                    ...rebuiltEntry.rebuilt,
                    dateText: '3 March 2025',
                    dateApproximate: approximate,
                    date: { text: '3 March 2025', wallMs: day, precision: 'day', estimatedUtcMs: day - 3_600_000, basis: 'source-offset', ...date },
                },
            }));
        for (const approximate of [true, false])
        {
            const email = rebuiltById(build(dated({}, approximate)), 0);
            expect(fieldOf(email, 'Date')).toEqual(['2025-03-03']);
            expect(email.flags.undated).toBe(false);
        }
        const pdfDocument = build(dated({}, true));
        const entry = pdfDocument.index.entries.find((x) => x.anchor === rebuiltById(pdfDocument, 0).anchor)!;
        expect(text(entry.date)).toBe('2025-03-03');
        // A time: the index's short form, as for a real email (no "about").
        const timeDoc = build(base);
        const timeEntry = timeDoc.index.entries.find((x) => x.anchor === rebuiltById(timeDoc, 0).anchor)!;
        expect(text(timeEntry.date)).toMatch(/^2025-03-03 \d\d:40$/);
        // Unreadable: the date text as written, alone in its row (task 8.8: no note).
        const unreadable = withRebuilt(base, 0, (r) => ({ ...r, rebuilt: { ...r.rebuilt, dateText: 'gisteren', date: null } }));
        const unreadableEmail = rebuiltById(build(unreadable), 0);
        expect(fieldOf(unreadableEmail, 'Date')).toEqual(['gisteren']);
        expect(unreadableEmail.flags.undated).toBe(true);
        // None.
        const none = withRebuilt(base, 0, (r) => ({ ...r, rebuilt: { ...r.rebuilt, dateText: null, date: null } }));
        const noneEmail = rebuiltById(build(none), 0);
        expect(fieldOf(noneEmail, 'Date')).toEqual([EN.noDate]);
        expect(noneEmail.flags.undated).toBe(true);
    });

    it('says "Unknown sender" when the quote names none (a From row is never empty); a list read short is shown as read, unmarked', () =>
    {
        const plain = rebuiltById(build(analysisOf(LAST)), 0);
        const result = withRebuilt(analysisOf(LAST), 0, (r) => ({ ...r, rebuilt: { ...r.rebuilt, from: [], incomplete: ['to', 'cc'], cc: [] } }));
        const pdfDocument = build(result);
        const email = rebuiltById(pdfDocument, 0);
        expect(fieldOf(email, 'From')).toEqual(['Unknown sender']);
        expect(email.fields.find((f) => f.label === 'From')!.value).toEqual([[{ role: 'muted', text: EN.unknownSender }]]);
        // To as read (the same as without the flag), no Cc row (nothing read).
        expect(fieldOf(email, 'To')).toEqual(fieldOf(plain, 'To'));
        expect(fieldOf(email, 'To')!.join(' ')).not.toContain('incomplete');
        expect(fieldOf(email, 'Cc')).toBeUndefined();
        const entry = pdfDocument.index.entries.find((x) => x.anchor === email.anchor)!;
        expect(entry.from).toEqual([{ role: 'muted', text: 'Unknown sender' }]);
    });

    it('counts the control characters of its text, shown as codes', () =>
    {
        const result = withRebuilt(analysisOf(LAST), 0, (r) => ({ ...r, rebuilt: { ...r.rebuilt, reconstructedText: 'Hello\u0007 there' } }));
        const pdfDocument = build(result);
        expect(rebuiltById(pdfDocument, 0).flags.controlChars).toBe(1);
        expect(pdfDocument.controlChars).toBe(build(analysisOf(LAST)).controlChars + 1);
    });

    it('is written in the PDF language, with the real emails\' words', () =>
    {
        const frenchStrings = createPdfStrings('fr');
        const pdfDocument = build(analysisOf(LAST), { strings: frenchStrings });
        const email = rebuiltOf(pdfDocument)[0]!;
        expect(email.heading).toBe('E-mail 1');
        expect(email.heading).toBe(frenchStrings.emailHeading(1));
        expect(email.fields.map((f) => f.label)).toEqual(
            [frenchStrings.fromLabel, frenchStrings.toLabel, frenchStrings.dateLabel, frenchStrings.subjectLabel]);
        expect(text(pdfDocument.index.entries[0]!.subject).startsWith('[')).toBe(false);
    });
});

describe('nothing in the PDF says an email was rebuilt (task 8.3), in every language', () =>
{
    for (const locale of ['en', 'fr', 'nl'] as const)
    {
        it(`${locale}: none of the removed texts, anywhere outside the email bodies`, () =>
        {
            const strings = createPdfStrings(locale);
            const { fragments, word } = removedTexts(locale);
            expect(fragments.every((f) => f.trim().length >= 3)).toBe(true);
            // The three rebuilt emails with every rare case at once: no sender, lists read short, no subject, a date that could not be read, a day alone.
            let result = analysisOf(THIRD, LAST);
            const ids = rebuiltEntries(result).map((r) => r.id);
            expect(ids.length).toBeGreaterThanOrEqual(2);
            result = withRebuilt(result, ids[0]!, (r) => ({ ...r, rebuilt: { ...r.rebuilt, from: [], incomplete: ['to', 'cc'], subject: null, dateText: 'gisteren', date: null } }));
            result = withRebuilt(result, ids[1]!, (rebuiltEntry) => ({
                ...rebuiltEntry,
                rebuilt: { ...rebuiltEntry.rebuilt, dateText: '3 March 2025',
                    date: { text: '3 March 2025', wallMs: Date.UTC(2025, 2, 3), precision: 'day', estimatedUtcMs: null, basis: 'source-offset' } },
            }));
            const pdfDocument = build(result, { strings });
            expect(rebuiltOf(pdfDocument).length).toBe(ids.length);
            const texts = ownTexts(pdfDocument);
            for (const ownText of texts)
            {
                expect(ownText, locale).not.toMatch(word);
                for (const fragment of fragments)
                {
                    expect(ownText, `${locale}: "${fragment}"`).not.toContain(fragment);
                }
            }
            // The anchors and bookmarks too.
            for (const email of pdfDocument.emails)
            {
                expect(email.anchor).toMatch(/^email-\d+$/);
            }
            // A date that could not be read: shown as written, alone in its row (task 8.8: no note).
            expect(texts).toContain('gisteren');
        });
    }
});

describe('the index, the bookmarks and the cover with rebuilt emails', () =>
{
    it('index and bookmarks: every email numbered 1..n in PDF order, rebuilt first when older, no marker; links match', () =>
    {
        const result = analysisOf(THIRD, LAST);
        const pdfDocument = build(result);
        const emailCount = pdfDocument.emails.length;
        expect(emailCount).toBeGreaterThan(2);
        // Timeline order (the preview's order, every entry in the PDF here), rebuilt older ones first.
        const order = previewOrder(result).map((s) => (s.kind === 'message' ? `email ${String(s.position)}` : `rebuilt ${String(s.id)}`));
        expect(
            pdfDocument.emails.map((e) => (e.rebuilt === null ? `email ${String(e.position)}` : `rebuilt ${String(e.rebuilt.id)}`))).toEqual(order);
        expect(pdfDocument.emails[0]!.rebuilt).not.toBeNull();
        const entries = pdfDocument.index.entries;
        const numbers = Array.from({ length: emailCount }, (_, k) => k + 1);
        expect(pdfDocument.emails.map((e) => e.number)).toEqual(numbers);
        expect(entries.map((e) => e.number)).toEqual(numbers);
        expect(entries.map((e) => e.anchor)).toEqual(numbers.map(emailAnchor));
        expect(entries.map((e) => e.anchor)).toEqual(pdfDocument.emails.map((e) => e.anchor));
        for (const [k, indexEntry] of entries.entries())
        {
            expect(indexEntry.bookmark.startsWith(`${String(k + 1)}. `)).toBe(true);
        }
        // The real emails' numbers are the ones pdfNumberByPosition gives.
        for (const email of pdfDocument.emails)
        {
            if (email.position !== null)
            {
                expect(pdfDocument.pdfNumberByPosition[email.position]).toBe(email.number);
            }
        }
        // The rebuilt rows: the same form as a real one's.
        for (const indexEntry of entries.filter((x) => x.rebuilt))
        {
            expect(indexEntry.subject.every((r) => r.role !== 'field-label')).toBe(true);
            expect(indexEntry.attachments).toBe(0);
        }
    });

    it('bookmarks of the last email alone: rebuilt ones as real ones, with their numbers', () =>
    {
        const entries = build(analysisOf(LAST)).index.entries;
        expect(entries.map((e) => e.rebuilt)).toEqual([true, true, true, false]);
        expect(entries[2]!.bookmark).toBe('3. 2025-03-03, Alice Example: Re: Office desks and chairs');
        // The attribution's subject is the chain's (user decision F3, task 9.9a).
        expect(entries[1]!.bookmark).toMatch(/^2\. \d{4}-\d\d-\d\d, .+: Re: Office desks and chairs$/);
        expect(entries[3]!.bookmark.startsWith('4. ')).toBe(true);
    });

    it('cover: "Emails", the date range and the people count rebuilt emails like real ones; no count row or section of their own', () =>
    {
        const result = analysisOf(LAST);
        const pdfDocument = build(result);
        const off = build(result, { rebuilt: [] });
        expect(pdfDocument.cover.emailCount).toBe(4);
        const texts = blockTexts(pdfDocument.cover.blocks);
        expect(texts).toContain('Emails: 4 emails');
        expect(texts.some((t) => /rebuilt/i.test(t))).toBe(false);
        // The same rows and sections as without rebuilt emails.
        expect(pdfDocument.cover.blocks.map((b) => (b.kind === 'fields' ? b.rows.map((r) => r.label) : b.kind))).toEqual(
            off.cover.blocks.map((b) => (b.kind === 'fields' ? b.rows.map((r) => r.label) : b.kind)),
        );
        // Date range: from the oldest rebuilt email (its date as its header shows it) to the real one.
        const oldest = pdfDocument.emails[0]!;
        expect(pdfDocument.cover.dateRange?.first).toBe(fieldOf(oldest, 'Date')![0]);
        expect(pdfDocument.cover.dateRange?.last).toBe(off.cover.dateRange?.last);
        expect(pdfDocument.cover.dateRange?.first).not.toBe(off.cover.dateRange?.first);
        expect(texts).toContain(`Dates: ${EN.dateRange(pdfDocument.cover.dateRange!.first, pdfDocument.cover.dateRange!.last)}`);
        // People: every real one, plus every sender read from a quote.
        const addresses = pdfDocument.cover.participants.map((p) => p.address.toLowerCase());
        for (const participant of off.cover.participants)
        {
            expect(addresses).toContain(participant.address.toLowerCase());
        }
        for (const rebuiltEntry of rebuiltEntries(result))
        {
            for (const mailbox of rebuiltEntry.rebuilt.from)
            {
                if (mailbox.address !== '')
                {
                    expect(addresses).toContain(mailbox.address.toLowerCase());
                }
            }
        }
    });

    it('cover: a rebuilt email without a date counts as undated, like a real one', () =>
    {
        const result = withRebuilt(analysisOf(LAST), 0, (r) => ({ ...r, rebuilt: { ...r.rebuilt, dateText: null, date: null } }));
        const pdfDocument = build(result);
        expect(pdfDocument.cover.undated).toBe(1);
        // Counted in the data only: the cover shows the date range alone (task 8.8).
        expect(blockTexts(pdfDocument.cover.blocks)).toContain(
            `Dates: ${EN.dateRange(pdfDocument.cover.dateRange!.first, pdfDocument.cover.dateRange!.last)}`);
    });

    it('cover: no source files and no SHA-256 (task 8.12); the real file is named in its own email only, a rebuilt email has no file', () =>
    {
        const pdfDocument = build(analysisOf(LAST));
        const file = fixture(LAST).source;
        const texts = blockTexts(pdfDocument.cover.blocks).join('\n');
        expect(texts).not.toMatch(/[0-9a-f]{64}/);
        expect(texts).not.toContain(file.fileName);
        expect(fieldOf(pdfDocument.emails.find((e) => e.number === 4)!, EN.fileLabel)).toEqual([file.fileName]);
        for (const email of rebuiltOf(pdfDocument))
        {
            expect(fieldOf(email, EN.fileLabel)).toBeUndefined();
            expect(email.fields.map((f) => f.value.map(text).join(' ')).join(' ')).not.toMatch(/[0-9a-f]{64}/);
        }
    });

    it('cover: a rebuilt email dated by a day alone starts at the start of that day IN THE CHOSEN ZONE, so the range never runs backwards', () =>
    {
        /** LAST with rebuilt email 0 dated by the day 2025-03-03 and the real email at `realIso`; only rebuilt email 0 in the PDF. */
        const pdfDocumentFor = (realIso: string, timeZone: string): PdfDocument =>
        {
            const base = withRebuilt(analysisOf(LAST), 0, (rebuiltEntry) => ({
                ...rebuiltEntry,
                rebuilt: {
                    ...rebuiltEntry.rebuilt,
                    dateText: '3 March 2025',
                    dateApproximate: false,
                    date: { text: '3 March 2025', wallMs: Date.UTC(2025, 2, 3), precision: 'day', estimatedUtcMs: Date.UTC(2025, 2, 3), basis: 'source-offset' },
                },
            }));
            const result: ThreadAnalysisResult = {
                ...base,
                messages: base.messages.map((m) => ({ ...m, message: { ...m.message, date: { ...m.message.date, utcMs: Date.parse(realIso) } } })),
            };
            const pdfDocument = build(result, { rebuilt: [0], timeZone });
            expect(pdfDocument.emails.map((e) => (e.rebuilt === null ? 'real' : 'rebuilt'))).toEqual(['rebuilt', 'real']);
            return pdfDocument;
        };
        // West: the real email is shown on the day before (21:00 on 2 March in New York): it comes first.
        const west = pdfDocumentFor('2025-03-03T02:00:00Z', 'America/New_York');
        expect(fieldOf(west.emails[1]!, 'Date')![0]).toBe('2025-03-02 21:00:00 UTC-05:00');
        expect(west.cover.dateRange).toEqual({ first: '2025-03-02 21:00:00 UTC-05:00', last: '2025-03-03' });
        // West, the real email later the same day: the day comes first.
        expect(pdfDocumentFor('2025-03-03T06:00:00Z', 'America/New_York').cover.dateRange).toEqual(
            { first: '2025-03-03', last: '2025-03-03 01:00:00 UTC-05:00' });
        // East: the real email is shown on 3 March (05:00 in Tokyo) though it is still 2 March in UTC: the day comes first.
        const east = pdfDocumentFor('2025-03-02T20:00:00Z', 'Asia/Tokyo');
        expect(fieldOf(east.emails[1]!, 'Date')![0]).toBe('2025-03-03 05:00:00 UTC+09:00');
        expect(east.cover.dateRange).toEqual({ first: '2025-03-03', last: '2025-03-03 05:00:00 UTC+09:00' });
        // East, the real email on the day before in Tokyo (23:00 on 2 March): it comes first.
        expect(pdfDocumentFor('2025-03-02T14:00:00Z', 'Asia/Tokyo').cover.dateRange).toEqual(
            { first: '2025-03-02 23:00:00 UTC+09:00', last: '2025-03-03' });
    });

    it('several real files and rebuilt emails between them: each real file named in its own email, under its PDF number; none on the cover', () =>
    {
        const result = analysisOf('10-order-1-alice.eml', LAST);
        const ids = rebuiltEntries(result).map((r) => r.id);
        const pdfDocument = build(result);
        const order = planPdfOrder(result, [0, 1], ids);
        const fileOf = (builtDocument: PdfDocument, n: number): string[] | undefined =>
            fieldOf(builtDocument.emails.find((e) => e.number === n)!, EN.fileLabel);
        // Real #1, rebuilt #2 and #3, real #4.
        expect(pdfDocument.emails.map((e) => `${e.rebuilt === null ? 'real' : 'rebuilt'} ${String(e.number)}`)).toEqual(
            ['real 1', 'rebuilt 2', 'rebuilt 3', 'real 4']);
        expect(order.pdfNumberByPosition).toEqual([1, 4]);
        expect(pdfDocument.pdfNumberByPosition).toEqual(order.pdfNumberByPosition);
        expect(fileOf(pdfDocument, 1)).toEqual([fixture('10-order-1-alice.eml').source.fileName]);
        expect(fileOf(pdfDocument, 4)).toEqual([fixture(LAST).source.fileName]);
        const texts = blockTexts(pdfDocument.cover.blocks).join('\n');
        expect(texts).not.toMatch(/[0-9a-f]{64}/);
        expect(texts).not.toContain(fixture(LAST).source.fileName);

        // The first real email unticked: LAST and the rebuilt emails read from it stay; LAST is the last email.
        const without = build(result, { positions: [1] });
        const withoutOrder = planPdfOrder(result, [1], ids);
        expect(without.emails.map((e) => e.rebuilt === null)).toEqual([false, false, true]);
        expect(withoutOrder.pdfNumberByPosition).toEqual([null, 3]);
        expect(fileOf(without, 3)).toEqual([fixture(LAST).source.fileName]);
        // LAST unticked: its rebuilt emails go with it (follow-source rule); the first email is number 1.
        const first = build(result, { positions: [0] });
        expect(first.emails.map((e) => e.rebuilt)).toEqual([null]);
        expect(fileOf(first, 1)).toEqual([fixture('10-order-1-alice.eml').source.fileName]);
    });

    it('a merged duplicate copy is named in the File row of the email it was merged into, rebuilt emails between', () =>
    {
        const result = analysisOf('10-order-1-alice.eml', '10-order-1-alice.eml', LAST);
        expect(result.messages).toHaveLength(2);
        const pdfDocument = build(result);
        expect(pdfDocument.emails.map((e) => `${e.rebuilt === null ? 'real' : 'rebuilt'} ${String(e.number)}`)).toEqual(
            ['real 1', 'rebuilt 2', 'rebuilt 3', 'real 4']);
        const name = fixture('10-order-1-alice.eml').source.fileName;
        expect(fieldOf(pdfDocument.emails[0]!, EN.fileLabel)).toEqual([name, name]);
        expect(fieldOf(pdfDocument.emails[3]!, EN.fileLabel)).toEqual([fixture(LAST).source.fileName]);
        expect(pdfDocument.pdfNumberByPosition).toEqual([1, 4]);
    });

    it('nothing about rebuilt emails when none is chosen (switch off), and the real email is the same either way but for its number', () =>
    {
        const result = analysisOf(LAST);
        const off = build(result, { rebuilt: [] });
        const absent = build(result, { rebuilt: null });
        const on = build(result);
        expect(off).toEqual(absent);
        expect(off.emails.map((e) => e.heading)).toEqual(['Email 1']);
        expect(off.cover.emailCount).toBe(1);
        expect(blockTexts(off.cover.blocks).some((t) => /rebuilt/i.test(t))).toBe(false);
        // The source email is the same (a reply: its quoted history is left out by its plan
        // either way, so the no-repeat rule of task 8.10 has nothing more to leave out);
        // only its number (and so its heading and anchor) follows its place.
        const real = on.emails.find((e) => e.position === 0)!;
        expect(real.number).toBe(4);
        expect(real).toEqual({ ...off.emails[0]!, number: 4, anchor: emailAnchor(4), heading: 'Email 4' });
        const entry = on.index.entries.find((e) => !e.rebuilt)!;
        const offEntry = off.index.entries[0]!;
        expect(entry).toEqual({ ...offEntry, number: 4, anchor: emailAnchor(4), bookmark: `4.${offEntry.bookmark.slice(2)}` });
    });

    it('the source email unticked: no rebuilt email at all (it follows its source)', () =>
    {
        const result = analysisOf(THIRD, LAST);
        const pdfDocument = build(result, { positions: [] });
        expect(pdfDocument.emails).toEqual([]);
        expect(pdfDocument.cover.emailCount).toBe(0);
    });
});

describe('dayStartInZone (a rebuilt email dated by a day alone, on the cover)', () =>
{
    it("gives the first moment of the day as the real emails' dates are shown in that zone", () =>
    {
        expect(dayStartInZone('2025-03-03', 'UTC')).toBe(Date.parse('2025-03-03T00:00:00Z'));
        expect(dayStartInZone('2025-03-03', 'America/New_York')).toBe(Date.parse('2025-03-03T05:00:00Z'));
        expect(dayStartInZone('2025-07-03', 'America/New_York')).toBe(Date.parse('2025-07-03T04:00:00Z'));
        expect(dayStartInZone('2025-03-03', 'Asia/Tokyo')).toBe(Date.parse('2025-03-02T15:00:00Z'));
        expect(dayStartInZone('2025-03-03', 'Asia/Kolkata')).toBe(Date.parse('2025-03-02T18:30:00Z'));
        expect(dayStartInZone('2025-03-03', 'Pacific/Kiritimati')).toBe(Date.parse('2025-03-02T10:00:00Z'));
        // The day daylight-saving time starts (at 02:00, after midnight).
        expect(dayStartInZone('2025-03-09', 'America/New_York')).toBe(Date.parse('2025-03-09T05:00:00Z'));
    });

    it('is exact when the day does not exist in that zone, and falls back to UTC for a zone that is not valid', () =>
    {
        // Kiritimati skipped 31 December 1994: 1994-12-30 23:59:59 UTC-10:00 is followed by 1995-01-01 00:00:00 UTC+14:00.
        expect(dayStartInZone('1994-12-31', 'Pacific/Kiritimati')).toBe(Date.parse('1994-12-31T10:00:00Z'));
        expect(dayStartInZone('1995-01-01', 'Pacific/Kiritimati')).toBe(Date.parse('1994-12-31T10:00:00Z'));
        expect(dayStartInZone('1994-12-30', 'Pacific/Kiritimati')).toBe(Date.parse('1994-12-30T10:00:00Z'));
        // The day daylight-saving time ends (Sydney, 03:00 back to 02:00): still from midnight.
        expect(dayStartInZone('2025-04-06', 'Australia/Sydney')).toBe(Date.parse('2025-04-05T13:00:00Z'));
        expect(dayStartInZone('2025-03-03', 'Not/AZone')).toBe(Date.parse('2025-03-03T00:00:00Z'));
    });

    it('gives null for a text that is not a day', () =>
    {
        for (const bad of ['', '2025-3-3', '2025-03-03x', 'gisteren', '2025-13-45'])
        {
            expect(dayStartInZone(bad, 'UTC')).toBeNull();
        }
    });
});

describe('"Print full original text" (policy.unfoldEverything; user decision 2026-10-28, task 7.8b)', () =>
{
    const EVERYTHING: OutputPolicy = { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true };

    it('leaves every rebuilt email out, whatever was chosen: the real emails alone, numbered 1..k', () =>
    {
        const result = analysisOf(LAST);
        const ids = rebuiltEntries(result).map((r) => r.id);
        expect(ids).toHaveLength(3);
        const pdfDocument = build(result, { rebuilt: ids, policy: EVERYTHING });
        expect(rebuiltOf(pdfDocument)).toEqual([]);
        expect(pdfDocument.emails.map((e) => e.number)).toEqual([1]);
        expect(pdfDocument.index.entries.map((e) => e.rebuilt)).toEqual([false]);
        expect(pdfDocument.cover.emailCount).toBe(1);
        expect(blockTexts(pdfDocument.cover.blocks).some((t) => /rebuilt/i.test(t))).toBe(false);
    });

    it('prints the source email whole, quoted history included (collapse, never delete), the same as with no rebuilt email chosen', () =>
    {
        const result = analysisOf(LAST);
        const ids = rebuiltEntries(result).map((r) => r.id);
        const pdfDocument = build(result, { rebuilt: ids, policy: EVERYTHING });
        const body = pdfDocument.emails[0]!.body.map(text);
        expect(body).toEqual(bodyLines(result.messages[0]!.message.bodyText).lines.map(text));
        // Every rebuilt text is inside it, so nothing of them is lost.
        for (const rebuiltEntry of rebuiltEntries(result))
        {
            const lines = rebuiltEntry.rebuilt.reconstructedText.split('\n').filter((l) => l.trim() !== '');
            for (const line of lines)
            {
                expect(body.join('\n')).toContain(line.trim());
            }
        }
        expect(pdfDocument).toEqual(build(result, { rebuilt: [], policy: EVERYTHING }));
    });

    it('back to the default policy, the same choice gives the rebuilt emails again (nothing forgotten)', () =>
    {
        const result = analysisOf(LAST);
        const ids = rebuiltEntries(result).map((r) => r.id);
        build(result, { rebuilt: ids, policy: EVERYTHING });
        const pdfDocument = build(result, { rebuilt: ids });
        expect(rebuiltOf(pdfDocument)).toHaveLength(3);
        expect(pdfDocument.cover.emailCount).toBe(4);
    });

    it('also when the text is quoted in several emails', () =>
    {
        const result = analysisOf(THIRD, LAST);
        const pdfDocument = build(result, { policy: EVERYTHING });
        expect(rebuiltOf(pdfDocument)).toEqual([]);
        expect(pdfDocument.emails.map((e) => e.number)).toEqual([1, 2]);
        expect(rebuiltOf(build(result))).not.toEqual([]);
    });
});

describe('signatures of rebuilt emails in the PDF (task 9.9b-2, user decision F4: as for real emails)', () =>
{
    const ALICE = { name: 'Alice Example', address: 'alice@example.test' };
    const CAROL = { name: 'Carol Writer', address: 'carol@client.test' };
    const BLOCK = 'Kind regards,\nAlice Example\nExample Office Supplies\nPhone: +00 0 000 00 00\n';
    let serial = 0;
    const mail = (from: typeof ALICE, minutes: number, bodyText: string): NormalizedMessage => ({
        ...fixture(LAST),
        messageId: `rebuilt-signature-pdf-${String(++serial)}@example.test`,
        inReplyTo: null,
        references: [],
        date: { utcMs: Date.UTC(2025, 2, 10, 9, minutes), original: '', offsetMinutes: 0, zoneKnown: true },
        from: [from],
        to: [],
        cc: [],
        subject: 'Re: Paper order',
        bodyText,
        source: { fileName: `rebuilt-signature-pdf-${String(serial)}.eml`, sha256: serial.toString(16).padStart(64, '0'), kind: 'eml' },
    });
    // Two files of Alice's (her block folded there: two real messages), then Carol quoting a THIRD email of Alice's.
    const first = (): NormalizedMessage => mail(ALICE, 0, `Hello Carol,\nThe paper is ordered.\n\n${BLOCK}`);
    const second = (): NormalizedMessage => mail(ALICE, 10, `Hello Carol,\nIt ships on Monday.\n\n${BLOCK}`);
    const quoting = (): NormalizedMessage => mail(CAROL, 40, [
        'Thanks Alice, noted.',
        '',
        'On Mon, 10 Mar 2025 at 09:20, Alice Example <alice@example.test> wrote:',
        ...`Hello Carol,\nThe invoice follows tomorrow.\n\n${BLOCK}`.split('\n').map((line) => (line === '' ? '>' : `> ${line}`)),
        '',
    ].join('\n'));
    const bodyText = (email: PdfEmail): string => email.body.map(text).join('\n');

    it('a rebuilt email leaves out a block its sender\'s REAL email printed earlier in the PDF', () =>
    {
        const result = analyzeThread([first(), second(), quoting()].map((message) => ({ ok: true as const, message })));
        expect(result.reconstructed.map((r) => r.link)).toEqual(['entry']);
        expect(result.reconstructed[0]!.segments?.some((s) => s.folded)).toBe(true);
        const pdfDocument = build(result);
        expect(pdfDocument.emails.map((e) => (e.rebuilt === null ? 'real' : 'rebuilt'))).toEqual(['real', 'real', 'rebuilt', 'real']);
        const [one, two, rebuilt] = pdfDocument.emails;
        expect(bodyText(one!)).toContain('Example Office Supplies');
        // Rule 3 for the real ones (unchanged) and, now, for the rebuilt one: printed once, in the first email.
        expect(bodyText(two!)).not.toContain('Example Office Supplies');
        expect(bodyText(rebuilt!)).toBe('Hello Carol,\nThe invoice follows tomorrow.');
        // Her files out of the PDF: the rebuilt email is the first of hers, so it prints the block.
        const without = build(result, { positions: [2] });
        expect(bodyText(without.emails.find((e) => e.rebuilt !== null)!)).toContain('Example Office Supplies');
    });

    it('a real email AFTER a rebuilt one keeps its own plan (known limit: printed twice rather than lost)', () =>
    {
        // Alice's quoted email is the oldest: the rebuilt one keeps the block; her later files (their own
        // plans, made from the real emails only) keep it in the first of them, as before task 9.9b-2.
        const early = mail(CAROL, 40, quoting().bodyText.replace('09:20', '08:00'));
        const result = analyzeThread([first(), second(), early].map((message) => ({ ok: true as const, message })));
        const pdfDocument = build(result);
        const texts = pdfDocument.emails.map(bodyText);
        expect(texts.filter((t) => t.includes('Example Office Supplies'))).toHaveLength(2);
        expect(pdfDocument.emails.findIndex((e) => e.rebuilt !== null)).toBe(0);
    });

    /** The reasons of a plan's folded ranges, "+" kept, "-" left out. */
    const foldReasons = (plan: MessagePlan | undefined): string[] =>
        (plan?.ranges ?? []).filter((r) => r.reason !== 'text').map((r) => `${r.reason}${r.keep ? '+' : '-'}`);
    /** The no-repeat input the PDF step gets for `positions` and the rebuilt ids `rebuilt`. */
    const noRepeatInput = (result: ThreadAnalysisResult, positions: readonly number[], rebuilt: readonly number[]): NoRepeatInput => ({
        result,
        positions,
        plans: planOutput(positions.map((p) => result.messages[p]!), DEFAULT_OUTPUT_POLICY),
        policy: DEFAULT_OUTPUT_POLICY,
        rebuilt,
    });
    /** Carol quoting Alice's email of 09:20 ("> " marks), its middle line given. */
    const quotingAs = (minutes: number, note: string, line: string): NormalizedMessage => mail(CAROL, minutes, [
        note,
        '',
        'On Mon, 10 Mar 2025 at 09:20, Alice Example <alice@example.test> wrote:',
        ...`Hello Carol,\n${line}\n\n${BLOCK}`.split('\n').map((l) => (l === '' ? '>' : `> ${l}`)),
        '',
    ].join('\n'));

    it('a card whose entry the PDF prints as another copy: each plan decided on what was printed BEFORE it, the preview gets the card\'s own', () =>
    {
        // Alice's email quoted in two of Carol's files, one with an extra blank line; her files (her block) are not in the PDF.
        const result = analyzeThread([first(), second(), quotingAs(40, 'Thanks Alice, noted.', 'The invoice follows tomorrow.'),
            quotingAs(50, 'Great, thank you.', 'The invoice follows tomorrow.\n')].map((message) => ({ ok: true as const, message })));
        const entry = result.reconstructed.find((r) => r.link === 'entry')!;
        const copy = result.reconstructed.find((r) => r.link === 'same-as')!;
        expect(result.reconstructed).toHaveLength(2);
        expect(copy.sameAs).toBe(entry.id);
        expect(entry.rebuilt.reconstructedText).not.toBe(copy.rebuilt.reconstructedText);
        expect([entry, copy].every((r) => r.segments?.some((s) => s.folded && s.reasons.includes('signature')) === true)).toBe(true);
        // Only the COPY's file in the PDF: the entry is printed as that copy.
        const positions = [result.positionByIndex[copy.sourceIndex]!];
        const input = noRepeatInput(result, positions, [entry.id]);
        const plans = applyNoRepeatRule(input).rebuiltPlans.get(entry.id)!;
        expect(plans.shown).not.toBe(plans.own);
        expect(plans.shown.ranges.at(-1)!.end).toBe(copy.rebuilt.reconstructedText.length);
        expect(plans.own.ranges.at(-1)!.end).toBe(entry.rebuilt.reconstructedText.length);
        // Nothing of Alice's printed before: the printed copy keeps her block (the card's own plan, decided first on
        // a COPY of what was printed, must not mark it as printed), and so does the card's own plan.
        expect(foldReasons(plans.shown)).toEqual(['signature+']);
        expect(foldReasons(plans.own)).toEqual(['signature+']);
        const printedCopy = rebuiltById(build(result, { positions, rebuilt: [entry.id] }), entry.id);
        expect(bodyText(printedCopy)).toContain('Kind regards,\nAlice Example\nExample Office Supplies');
        // The preview's card shows the entry's own text: it gets `own`, not the printed copy's plan.
        const cardPlans = pdfCut({ ...input, rebuilt: [entry.id] }).rebuiltPlans;
        expect(cardPlans.get(entry.id)).toEqual(plans.own);
        expect(cardPlans.get(entry.id)).not.toEqual(plans.shown);
    });

    /** `result` with the segments of the real email at list position `position` replaced (a hand-made case). */
    const withSegments = (result: ThreadAnalysisResult, position: number, segments: readonly Segment[]): ThreadAnalysisResult =>
        ({ ...result, messages: result.messages.map((m, k) => (k === position ? { ...m, segments } : m)) });
    /** A cover of `body`: shown up to `start`, folded from there to the end for `reasons`. */
    const foldFrom = (body: string, start: number, reasons: Segment['reasons'], related: readonly number[]): Segment[] => [
        { start: 0, end: start, folded: false, reasons: [], related: [] },
        { start, end: body.length, folded: true, reasons, related },
    ];

    it('the PRINTED SOMEWHERE check reads a rebuilt email as printed, without the signature block it leaves out', () =>
    {
        // Hand-made (output-plan.ts rule 2, an overlap start): Carol's later file holds Alice's 09:20 email
        // pasted without quote marks, folded as 'quoted-overlap' linked to Alice's file in the PDF. Its words
        // are printed nowhere in a row (the rebuilt email prints her text WITHOUT the block her file printed
        // first), so the check must give the piece back to Carol's file.
        const pasted = `Hello Carol,\nThe invoice follows tomorrow.\n\n${BLOCK}`;
        const forwardedBy = mail(CAROL, 50, `FYI, below is what Alice wrote.\n\n${pasted}`);
        const analysed = analyzeThread([first(), second(), quoting(), forwardedBy].map((message) => ({ ok: true as const, message })));
        expect(analysed.reconstructed.map((r) => r.link)).toEqual(['entry']);
        const position = analysed.positionByIndex[3]!;
        const body = forwardedBy.bodyText;
        const result = withSegments(analysed, position, foldFrom(body, body.indexOf('Hello Carol'), ['quoted-overlap'], [0]));
        const positions = result.messages.map((_, k) => k);
        const ids = [result.reconstructed[0]!.id];
        const rebuiltPlan = applyNoRepeatRule(noRepeatInput(result, positions, ids)).rebuiltPlans.get(ids[0]!)!;
        expect(foldReasons(rebuiltPlan.shown)).toEqual(['repeated-signature-']);
        const restored = applyNoRepeatRule(noRepeatInput(result, positions, ids)).restored.get(position);
        expect(restored).toEqual([[body.indexOf('Hello Carol'), body.length]]);
        const pdfDocument = build(result, { positions, rebuilt: ids });
        const carolsFile = pdfDocument.emails.find((e) => e.rebuilt === null && bodyText(e).startsWith('FYI'))!;
        expect(bodyText(carolsFile)).toContain('The invoice follows tomorrow.');
    });

    it('a real email\'s kept block counts as printed only where the no-repeat cut leaves it in that email', () =>
    {
        // Hand-made (the plan of her file is set by hand): Alice forwards her own 09:05 email, rebuilt and in the
        // PDF. Her file's plan takes the forwarded part for her own text (no quote in it, so the PDF cuts that
        // part whole: it is printed as the rebuilt email) and keeps a signature block at its end, INSIDE that
        // part. The rebuilt 09:05 email has no folds (set by hand) and keeps no block. So no email before it
        // printed her block as a signature: her later rebuilt 09:20 email (quoted by Carol) must print it.
        const forward = mail(ALICE, 10, [
            'Carol, my note again, see below.',
            '',
            '---------- Forwarded message ---------',
            'From: Alice Example <alice@example.test>',
            'Date: Mon, 10 Mar 2025 at 09:05',
            'Subject: Paper order',
            'To: Carol Writer <carol@client.test>',
            '',
            `Hello Carol,\nThe paper is ordered.\n\n${BLOCK}`,
        ].join('\n'));
        const analysed = analyzeThread([forward, quoting()].map((message) => ({ ok: true as const, message })));
        const forwarded = analysed.reconstructed.find((r) => r.rebuilt.reconstructedText.includes('The paper is ordered.'))!;
        const later = analysed.reconstructed.find((r) => r.rebuilt.reconstructedText.includes('The invoice follows tomorrow.'))!;
        expect([forwarded.link, later.link]).toEqual(['entry', 'entry']);
        expect(later.segments?.some((s) => s.folded && s.reasons.includes('signature'))).toBe(true);
        const result = withRebuilt(analysed, forwarded.id, (r) => ({ ...r, segments: undefined }));
        const position = result.positionByIndex[0]!;
        const body = forward.bodyText;
        const blockStart = body.indexOf('Kind regards,');
        const positions = result.messages.map((_, k) => k);
        const ids = [forwarded.id, later.id];
        const input = noRepeatInput(result, positions, ids);
        const k = positions.indexOf(position);
        const plan = input.plans[k]!;
        expect(foldReasons(plan)).toEqual(['forwarded+']);
        const handMade: MessagePlan = { ...plan, ranges: [
            { start: 0, end: blockStart, keep: true, reason: 'text' },
            { start: blockStart, end: body.length, keep: true, reason: 'signature' },
        ] };
        const plans = input.plans.map((p, j) => (j === k ? handMade : p));
        const cut = applyNoRepeatRule({ ...input, plans });
        // Her block lies in the part of her file the PDF prints as the rebuilt 09:05 email: cut there.
        expect((cut.elsewhere.get(position) ?? []).some(([start, end]) => start <= blockStart && end >= body.length - 1)).toBe(true);
        // So it was not printed as a signature before the 09:20 email: kept there.
        expect(foldReasons(cut.rebuiltPlans.get(later.id)?.shown)).toEqual(['signature+']);
        const pdfDocument = buildPdfDocument({ ...input, plans, timeZone: 'Africa/Lagos', generatedAt: Date.UTC(2025, 5, 1, 12, 0, 0), strings: EN });
        expect(bodyText(rebuiltById(pdfDocument, later.id))).toContain('Example Office Supplies');
    });
});
