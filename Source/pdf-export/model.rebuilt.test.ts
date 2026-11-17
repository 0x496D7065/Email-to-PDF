// Unit tests for the emails rebuilt from quoted text in the PDF document
// model (Source/pdf-export/model.ts: planPdfOrder, buildPdfDocument; tasks 7.7 and
// 8.3): their place, the numbering, the follow-source rule, the switch,
// what a rebuilt email shows, the index, the cover, and the hashes of real
// files only. USER DECISION 2026-11-02 (task 8.3, PDF only): a rebuilt email
// looks and is numbered exactly like a real one; nothing in the PDF says it
// was rebuilt (the preview still does). Synthetic fixtures only
// (Helper/Test/test-data/eml), run through the real engine and output plan, as the
// app does; a few results are edited by hand to reach rare cases (a day
// without a time, no sender, a list read short).
import { beforeAll, describe, expect, it } from 'vitest';
import { parseAllFixtures } from '../../Helper/Test/test-data/parse-all';
import { runEngine } from '../thread-analysis/engine';
import { DEFAULT_OUTPUT_POLICY, planOutput } from '../thread-analysis/output-plan';
import { translator } from '../page/translations';
import { previewOrder, rebuiltEntries } from '../page-logic/rebuilt';
import { buildPdfDocument, dayStartInZone, emailAnchor, planPdfOrder } from './model';
import { createPdfStrings } from './strings';
import { bodyLines, lineText } from './text';
import type { OutputPolicy } from '../../Header/output-plan';
import type { NormalizedMessage } from '../../Header/parsed-email';
import type { PdfBlock, PdfDocument, PdfEmail, PdfLine, PdfStrings } from '../../Header/pdf-document-model';
import type { EngineRebuilt, QuotedDate } from '../../Header/rebuilt-emails';
import type { EngineResult } from '../../Header/thread-analysis-result';

let fixtures: Map<string, NormalizedMessage>;
beforeAll(async () =>
{
    fixtures = new Map((await parseAllFixtures()).map((m) => [m.source.fileName, m]));
});
const fixture = (name: string): NormalizedMessage =>
{
    const m = fixtures.get(`eml/${name}`);
    if (m === undefined)
    {
        throw new Error(`no fixture ${name}`);
    }
    return m;
};
const engineOf = (...names: string[]): EngineResult => runEngine(names.map((n) => ({ ok: true as const, message: fixture(n) })));

/** The last email of a synthetic thread: alone, it gives 3 rebuilt entries (ids 2, 1, 0, oldest first) before it. */
const LAST = '13-order-4-bob-outlook-nl.eml';
/** The email before it: with LAST, the two older emails are quoted in both (an entry and a copy each). */
const THIRD = '12-order-3-alice-gmail.eml';
const EN = createPdfStrings('en');

/** A copy of `result` with rebuilt message `id` changed by `edit`. */
function withRebuilt(result: EngineResult, id: number, edit: (r: EngineRebuilt) => EngineRebuilt): EngineResult
{
    return { ...result, reconstructed: result.reconstructed.map((r) => (r.id === id ? edit(r) : r)) };
}

/** Builds the document of `result` with the given real positions (default all) and rebuilt ids (default every entry). */
function build(
    result: EngineResult,
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
const rebuiltOf = (doc: PdfDocument): PdfEmail[] => doc.emails.filter((e) => e.rebuilt !== null);
const rebuiltById = (doc: PdfDocument, id: number): PdfEmail => doc.emails.find((e) => e.rebuilt?.id === id)!;
const blockTexts = (blocks: readonly PdfBlock[]): string[] =>
    blocks.flatMap((b) =>
    {
        switch (b.kind)
        {
            case 'heading':
            case 'paragraph':
                return [text(b.line)];
            case 'fields':
                return b.rows.map((r) => `${r.label}: ${r.value.map(text).join(' / ')}`);
            case 'list':
                return b.items.map((item) => item.map(text).join(' / '));
        }
    });

/**
 * Every text the PDF writes for a document EXCEPT the email bodies (message
 * text, printed as it is): the cover, the index (column titles, rows,
 * bookmarks), every email's heading, header rows, notes and attachment list.
 */
function ownTexts(doc: PdfDocument): string[]
{
    const out = [doc.title, ...blockTexts(doc.cover.blocks), doc.index.heading, ...Object.values(doc.index.columns)];
    for (const e of doc.index.entries)
    {
        out.push(String(e.number), text(e.date), text(e.from), text(e.subject), e.bookmark, ...e.attachmentLines.map(text));
    }
    for (const e of doc.emails)
    {
        out.push(e.heading, ...e.fields.flatMap((f) => [f.label, ...f.value.map(text)]), ...e.notes.map(text));
        if (e.attachments !== null)
        {
            out.push(e.attachments.label, ...e.attachments.items.map(text));
        }
    }
    return out;
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
function sharedEntries(result: EngineResult): { entry: EngineRebuilt; own: number; other: number; copy: EngineRebuilt }[]
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
        const result = engineOf(LAST);
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
        const result = engineOf(LAST);
        for (const ids of [[], undefined])
        {
            const order = planPdfOrder(result, [0], ids);
            expect(order.slots).toEqual([{ kind: 'email', position: 0, number: 1, plan: 0 }]);
            expect(order.pdfNumberByPosition).toEqual([1]);
        }
    });

    it('follows the source email: none when the email they were taken from is not in the PDF (user decision Q1 (a))', () =>
    {
        const result = engineOf(LAST);
        expect(planPdfOrder(result, [], [0, 1, 2]).slots).toEqual([]);
        expect(planPdfOrder(result, [], [0, 1, 2]).pdfNumberByPosition).toEqual([null]);
    });

    it('ignores unknown, repeated and non-entry ids', () =>
    {
        const result = engineOf(LAST);
        const order = planPdfOrder(result, [0], [99, -1, 1.5, 1, 1, Number.NaN]);
        expect(order.slots.map((s) => (s.kind === 'email' ? 'email' : s.entry.id))).toEqual([1, 'email']);
        expect(order.slots.map((s) => s.number)).toEqual([1, 2]);
        // A copy ('same-as') or a rebuilt email matched to a real file ('real') never gets a place of its own.
        const two = engineOf(THIRD, LAST);
        const all = two.reconstructed.map((r) => r.id);
        const ids = planPdfOrder(two, [0, 1], all).slots.flatMap((s) => (s.kind === 'rebuilt' ? [s.entry.id] : []));
        expect(ids.length).toBeGreaterThan(0);
        for (const id of ids)
        {
            expect(two.reconstructed[id]!.link).toBe('entry');
        }
        expect(new Set(ids).size).toBe(ids.length);
        const files = engineOf('10-order-1-alice.eml', '11-order-2-bob-outlook-en.eml', THIRD, LAST);
        const real = planPdfOrder(files, [0, 1, 2, 3], files.reconstructed.map((r) => r.id));
        expect(real.slots.every((s) => s.kind === 'email')).toBe(true);
        expect(real.pdfNumberByPosition).toEqual([1, 2, 3, 4]);
    });

    it('gives no rebuilt email when the timeline is not valid (the real emails alone, as given)', () =>
    {
        const result = engineOf(LAST);
        const order = planPdfOrder({ ...result, timeline: [] }, [0], [0, 1, 2]);
        expect(order.slots.map((s) => s.kind)).toEqual(['email']);
        expect(order.pdfNumberByPosition).toEqual([1]);
    });

    it('numbers by place IN THE PDF, which differs from the preview number once an email is left out or a rebuilt one comes first', () =>
    {
        const result = engineOf(THIRD, LAST);
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
        const result = engineOf(THIRD, LAST);
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
        const result = engineOf(LAST);
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
        const doc = build(engineOf(LAST));
        expect(doc.emails.map((e) => e.heading)).toEqual(['Email 1', 'Email 2', 'Email 3', 'Email 4']);
        expect(doc.emails.map((e) => e.number)).toEqual([1, 2, 3, 4]);
        expect(doc.emails.map((e) => e.position)).toEqual([null, null, null, 0]);
        expect(doc.emails.map((e) => e.anchor)).toEqual([1, 2, 3, 4].map(emailAnchor));
        // Data only (never printed): which entry it is and where it was read.
        // No header lines moved to them (task 8.13a, Q4): the reply's plan leaves its quoted history out, header lines included.
        expect(rebuiltOf(doc).map((e) => e.rebuilt)).toEqual([2, 1, 0].map((id) => ({ id, shownId: id, sourcePosition: 0, movedHeaders: 0 })));
        expect(doc.pdfNumberByPosition).toEqual([4]);
    });

    it('shows the fields read from the quote as a real email does: no "Taken from" row, no File row (it has no file)', () =>
    {
        const doc = build(engineOf(LAST));
        const [, gmail, outlookNl] = rebuiltOf(doc);
        expect(outlookNl!.fields.map((f) => f.label)).toEqual(['From', 'To', 'Date', 'Subject']);
        expect(fieldOf(outlookNl!, 'From')).toEqual(['Alice Example <alice@example.test>']);
        expect(fieldOf(outlookNl!, 'Subject')).toEqual(['Re: Office desks and chairs']);
        // A time read without a zone of its own: written as a real email's date, alone (task 8.8: no
        // "time zone not given" line, the app says it); no "about", no "As written in the quote".
        expect(fieldOf(outlookNl!, 'Date')).toEqual([expect.stringMatching(/^2025-03-03 \d\d:40:00 UTC\+01:00$/)]);
        expect(outlookNl!.flags.zoneUnknown).toBe(true);
        for (const e of rebuiltOf(doc))
        {
            expect(fieldOf(e, 'File')).toBeUndefined();
            expect(fieldOf(e, 'Taken from')).toBeUndefined();
        }
        // An attribution has no subject: the real emails' "(no subject)", muted.
        expect(gmail!.fields.find((f) => f.label === 'Subject')!.value).toEqual([[{ role: 'muted', text: EN.noSubject }]]);
        expect(EN.noSubject).toBe('(no subject)');
    });

    it('carries no note of its own, and its rebuilt text, whole', () =>
    {
        const result = engineOf(LAST);
        const doc = build(result);
        expect(rebuiltOf(doc).map((e) => e.notes)).toEqual([[], [], []]);
        for (const e of rebuiltOf(doc))
        {
            const r = result.reconstructed[e.rebuilt!.id]!;
            const lines = bodyLines(r.rebuilt.reconstructedText);
            expect(e.body.map(text)).toEqual(lines.lines.map(text));
            expect(e.body.map(text).join('\n')).not.toMatch(/^>/m);
            expect(e.attachments).toBeNull();
        }
    });

    it('shows a deeper quote left in its text without its marks, as a real email does (tasks 8.1 and 8.6)', () =>
    {
        // A reply quoting Bob, whose own text quotes an older line with no header of its own (">>"):
        // the rebuilt email is Bob's text, its quote marks removed by the engine; the older line keeps one ">".
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
        const result = runEngine([{ ok: true, message: reply }]);
        const entry = rebuiltEntries(result)[0];
        expect(entry).toBeDefined();
        expect(entry!.rebuilt.reconstructedText).toBe('I agree with this point:\n\n> The desks are oak.\n> They arrive on Monday.\n\nBob\n');
        const doc = build(result);
        const e = rebuiltById(doc, entry!.id);
        expect(e.body.map(text)).toEqual(['I agree with this point:', '', 'The desks are oak.', 'They arrive on Monday.', '', 'Bob']);
        // The real email under "Print full original text": the same lines (one level deeper there, which the PDF does not show).
        const whole = build(result, { policy: { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true } }).emails[0]!;
        const k = whole.body.map(text).indexOf('The desks are oak.');
        expect(whole.body.map(text).slice(k - 2, k + 4)).toEqual(['I agree with this point:', '', 'The desks are oak.', 'They arrive on Monday.', '', 'Bob']);
    });

    it('says nowhere that the same text is quoted in another email', () =>
    {
        const result = engineOf(THIRD, LAST);
        expect(sharedEntries(result).length).toBeGreaterThan(0);
        const doc = build(result);
        for (const e of rebuiltOf(doc))
        {
            expect(e.notes).toEqual([]);
        }
        expect(ownTexts(doc).some((t) => t.includes('Same quoted text'))).toBe(false);
    });

    it('shows its date from the best value read, as for a real email: a day alone as that day, else "no date"', () =>
    {
        const base = engineOf(LAST);
        const day = Date.UTC(2025, 2, 3);
        const dated = (date: Partial<QuotedDate>, approximate: boolean) =>
            withRebuilt(base, 0, (r) => ({
                ...r,
                rebuilt: {
                    ...r.rebuilt,
                    dateText: '3 March 2025',
                    dateApproximate: approximate,
                    date: { text: '3 March 2025', wallMs: day, precision: 'day', estimatedUtcMs: day - 3_600_000, basis: 'source-offset', ...date },
                },
            }));
        for (const approximate of [true, false])
        {
            const e = rebuiltById(build(dated({}, approximate)), 0);
            expect(fieldOf(e, 'Date')).toEqual(['2025-03-03']);
            expect(e.flags.undated).toBe(false);
        }
        const doc = build(dated({}, true));
        const entry = doc.index.entries.find((x) => x.anchor === rebuiltById(doc, 0).anchor)!;
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
        const plain = rebuiltById(build(engineOf(LAST)), 0);
        const result = withRebuilt(engineOf(LAST), 0, (r) => ({ ...r, rebuilt: { ...r.rebuilt, from: [], incomplete: ['to', 'cc'], cc: [] } }));
        const doc = build(result);
        const e = rebuiltById(doc, 0);
        expect(fieldOf(e, 'From')).toEqual(['Unknown sender']);
        expect(e.fields.find((f) => f.label === 'From')!.value).toEqual([[{ role: 'muted', text: EN.unknownSender }]]);
        // To as read (the same as without the flag), no Cc row (nothing read).
        expect(fieldOf(e, 'To')).toEqual(fieldOf(plain, 'To'));
        expect(fieldOf(e, 'To')!.join(' ')).not.toContain('incomplete');
        expect(fieldOf(e, 'Cc')).toBeUndefined();
        const entry = doc.index.entries.find((x) => x.anchor === e.anchor)!;
        expect(entry.from).toEqual([{ role: 'muted', text: 'Unknown sender' }]);
    });

    it('counts the control characters of its text, shown as codes', () =>
    {
        const result = withRebuilt(engineOf(LAST), 0, (r) => ({ ...r, rebuilt: { ...r.rebuilt, reconstructedText: 'Hello\u0007 there' } }));
        const doc = build(result);
        expect(rebuiltById(doc, 0).flags.controlChars).toBe(1);
        expect(doc.controlChars).toBe(build(engineOf(LAST)).controlChars + 1);
    });

    it('is written in the PDF language, with the real emails\' words', () =>
    {
        const fr = createPdfStrings('fr');
        const doc = build(engineOf(LAST), { strings: fr });
        const e = rebuiltOf(doc)[0]!;
        expect(e.heading).toBe('E-mail 1');
        expect(e.heading).toBe(fr.emailHeading(1));
        expect(e.fields.map((f) => f.label)).toEqual([fr.fromLabel, fr.toLabel, fr.dateLabel, fr.subjectLabel]);
        expect(text(doc.index.entries[0]!.subject).startsWith('[')).toBe(false);
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
            let result = engineOf(THIRD, LAST);
            const ids = rebuiltEntries(result).map((r) => r.id);
            expect(ids.length).toBeGreaterThanOrEqual(2);
            result = withRebuilt(result, ids[0]!, (r) => ({ ...r, rebuilt: { ...r.rebuilt, from: [], incomplete: ['to', 'cc'], subject: null, dateText: 'gisteren', date: null } }));
            result = withRebuilt(result, ids[1]!, (r) => ({
                ...r,
                rebuilt: { ...r.rebuilt, dateText: '3 March 2025', date: { text: '3 March 2025', wallMs: Date.UTC(2025, 2, 3), precision: 'day', estimatedUtcMs: null, basis: 'source-offset' } },
            }));
            const doc = build(result, { strings });
            expect(rebuiltOf(doc).length).toBe(ids.length);
            const texts = ownTexts(doc);
            for (const t of texts)
            {
                expect(t, locale).not.toMatch(word);
                for (const f of fragments)
                {
                    expect(t, `${locale}: "${f}"`).not.toContain(f);
                }
            }
            // The anchors and bookmarks too.
            for (const e of doc.emails)
            {
                expect(e.anchor).toMatch(/^email-\d+$/);
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
        const result = engineOf(THIRD, LAST);
        const doc = build(result);
        const n = doc.emails.length;
        expect(n).toBeGreaterThan(2);
        // Timeline order (the preview's order, every entry in the PDF here), rebuilt older ones first.
        const order = previewOrder(result).map((s) => (s.kind === 'message' ? `email ${String(s.position)}` : `rebuilt ${String(s.id)}`));
        expect(doc.emails.map((e) => (e.rebuilt === null ? `email ${String(e.position)}` : `rebuilt ${String(e.rebuilt.id)}`))).toEqual(order);
        expect(doc.emails[0]!.rebuilt).not.toBeNull();
        const entries = doc.index.entries;
        const numbers = Array.from({ length: n }, (_, k) => k + 1);
        expect(doc.emails.map((e) => e.number)).toEqual(numbers);
        expect(entries.map((e) => e.number)).toEqual(numbers);
        expect(entries.map((e) => e.anchor)).toEqual(numbers.map(emailAnchor));
        expect(entries.map((e) => e.anchor)).toEqual(doc.emails.map((e) => e.anchor));
        for (const [k, e] of entries.entries())
        {
            expect(e.bookmark.startsWith(`${String(k + 1)}. `)).toBe(true);
        }
        // The real emails' numbers are the ones pdfNumberByPosition gives.
        for (const e of doc.emails)
        {
            if (e.position !== null)
            {
                expect(doc.pdfNumberByPosition[e.position]).toBe(e.number);
            }
        }
        // The rebuilt rows: the same form as a real one's.
        for (const e of entries.filter((x) => x.rebuilt))
        {
            expect(e.subject.every((r) => r.role !== 'field-label')).toBe(true);
            expect(e.attachments).toBe(0);
        }
    });

    it('bookmarks of the last email alone: rebuilt ones as real ones, with their numbers', () =>
    {
        const entries = build(engineOf(LAST)).index.entries;
        expect(entries.map((e) => e.rebuilt)).toEqual([true, true, true, false]);
        expect(entries[2]!.bookmark).toBe('3. 2025-03-03, Alice Example: Re: Office desks and chairs');
        expect(entries[1]!.bookmark).toMatch(/^2\. \d{4}-\d\d-\d\d, .+: \(no subject\)$/);
        expect(entries[3]!.bookmark.startsWith('4. ')).toBe(true);
    });

    it('cover: "Emails", the date range and the people count rebuilt emails like real ones; no count row or section of their own', () =>
    {
        const result = engineOf(LAST);
        const doc = build(result);
        const off = build(result, { rebuilt: [] });
        expect(doc.cover.emailCount).toBe(4);
        const texts = blockTexts(doc.cover.blocks);
        expect(texts).toContain('Emails: 4 emails');
        expect(texts.some((t) => /rebuilt/i.test(t))).toBe(false);
        // The same rows and sections as without rebuilt emails.
        expect(doc.cover.blocks.map((b) => (b.kind === 'fields' ? b.rows.map((r) => r.label) : b.kind))).toEqual(
            off.cover.blocks.map((b) => (b.kind === 'fields' ? b.rows.map((r) => r.label) : b.kind)),
        );
        // Date range: from the oldest rebuilt email (its date as its header shows it) to the real one.
        const oldest = doc.emails[0]!;
        expect(doc.cover.dateRange?.first).toBe(fieldOf(oldest, 'Date')![0]);
        expect(doc.cover.dateRange?.last).toBe(off.cover.dateRange?.last);
        expect(doc.cover.dateRange?.first).not.toBe(off.cover.dateRange?.first);
        expect(texts).toContain(`Dates: ${EN.dateRange(doc.cover.dateRange!.first, doc.cover.dateRange!.last)}`);
        // People: every real one, plus every sender read from a quote.
        const addresses = doc.cover.participants.map((p) => p.address.toLowerCase());
        for (const p of off.cover.participants)
        {
            expect(addresses).toContain(p.address.toLowerCase());
        }
        for (const r of rebuiltEntries(result))
        {
            for (const m of r.rebuilt.from)
            {
                if (m.address !== '')
                {
                    expect(addresses).toContain(m.address.toLowerCase());
                }
            }
        }
    });

    it('cover: a rebuilt email without a date counts as undated, like a real one', () =>
    {
        const result = withRebuilt(engineOf(LAST), 0, (r) => ({ ...r, rebuilt: { ...r.rebuilt, dateText: null, date: null } }));
        const doc = build(result);
        expect(doc.cover.undated).toBe(1);
        // Counted in the data only: the cover shows the date range alone (task 8.8).
        expect(blockTexts(doc.cover.blocks)).toContain(`Dates: ${EN.dateRange(doc.cover.dateRange!.first, doc.cover.dateRange!.last)}`);
    });

    it('cover: no source files and no SHA-256 (task 8.12); the real file is named in its own email only, a rebuilt email has no file', () =>
    {
        const doc = build(engineOf(LAST));
        const file = fixture(LAST).source;
        const texts = blockTexts(doc.cover.blocks).join('\n');
        expect(texts).not.toMatch(/[0-9a-f]{64}/);
        expect(texts).not.toContain(file.fileName);
        expect(fieldOf(doc.emails.find((e) => e.number === 4)!, EN.fileLabel)).toEqual([file.fileName]);
        for (const e of rebuiltOf(doc))
        {
            expect(fieldOf(e, EN.fileLabel)).toBeUndefined();
            expect(e.fields.map((f) => f.value.map(text).join(' ')).join(' ')).not.toMatch(/[0-9a-f]{64}/);
        }
    });

    it('cover: a rebuilt email dated by a day alone starts at the start of that day IN THE CHOSEN ZONE, so the range never runs backwards', () =>
    {
        /** LAST with rebuilt email 0 dated by the day 2025-03-03 and the real email at `realIso`; only rebuilt email 0 in the PDF. */
        const docOf = (realIso: string, timeZone: string): PdfDocument =>
        {
            const base = withRebuilt(engineOf(LAST), 0, (r) => ({
                ...r,
                rebuilt: {
                    ...r.rebuilt,
                    dateText: '3 March 2025',
                    dateApproximate: false,
                    date: { text: '3 March 2025', wallMs: Date.UTC(2025, 2, 3), precision: 'day', estimatedUtcMs: Date.UTC(2025, 2, 3), basis: 'source-offset' },
                },
            }));
            const result: EngineResult = {
                ...base,
                messages: base.messages.map((m) => ({ ...m, message: { ...m.message, date: { ...m.message.date, utcMs: Date.parse(realIso) } } })),
            };
            const doc = build(result, { rebuilt: [0], timeZone });
            expect(doc.emails.map((e) => (e.rebuilt === null ? 'real' : 'rebuilt'))).toEqual(['rebuilt', 'real']);
            return doc;
        };
        // West: the real email is shown on the day before (21:00 on 2 March in New York): it comes first.
        const west = docOf('2025-03-03T02:00:00Z', 'America/New_York');
        expect(fieldOf(west.emails[1]!, 'Date')![0]).toBe('2025-03-02 21:00:00 UTC-05:00');
        expect(west.cover.dateRange).toEqual({ first: '2025-03-02 21:00:00 UTC-05:00', last: '2025-03-03' });
        // West, the real email later the same day: the day comes first.
        expect(docOf('2025-03-03T06:00:00Z', 'America/New_York').cover.dateRange).toEqual({ first: '2025-03-03', last: '2025-03-03 01:00:00 UTC-05:00' });
        // East: the real email is shown on 3 March (05:00 in Tokyo) though it is still 2 March in UTC: the day comes first.
        const east = docOf('2025-03-02T20:00:00Z', 'Asia/Tokyo');
        expect(fieldOf(east.emails[1]!, 'Date')![0]).toBe('2025-03-03 05:00:00 UTC+09:00');
        expect(east.cover.dateRange).toEqual({ first: '2025-03-03', last: '2025-03-03 05:00:00 UTC+09:00' });
        // East, the real email on the day before in Tokyo (23:00 on 2 March): it comes first.
        expect(docOf('2025-03-02T14:00:00Z', 'Asia/Tokyo').cover.dateRange).toEqual({ first: '2025-03-02 23:00:00 UTC+09:00', last: '2025-03-03' });
    });

    it('several real files and rebuilt emails between them: each real file named in its own email, under its PDF number; none on the cover', () =>
    {
        const result = engineOf('10-order-1-alice.eml', LAST);
        const ids = rebuiltEntries(result).map((r) => r.id);
        const doc = build(result);
        const order = planPdfOrder(result, [0, 1], ids);
        const fileOf = (d: PdfDocument, n: number): string[] | undefined => fieldOf(d.emails.find((e) => e.number === n)!, EN.fileLabel);
        // Real #1, rebuilt #2 and #3, real #4.
        expect(doc.emails.map((e) => `${e.rebuilt === null ? 'real' : 'rebuilt'} ${String(e.number)}`)).toEqual(['real 1', 'rebuilt 2', 'rebuilt 3', 'real 4']);
        expect(order.pdfNumberByPosition).toEqual([1, 4]);
        expect(doc.pdfNumberByPosition).toEqual(order.pdfNumberByPosition);
        expect(fileOf(doc, 1)).toEqual([fixture('10-order-1-alice.eml').source.fileName]);
        expect(fileOf(doc, 4)).toEqual([fixture(LAST).source.fileName]);
        const texts = blockTexts(doc.cover.blocks).join('\n');
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
        const result = engineOf('10-order-1-alice.eml', '10-order-1-alice.eml', LAST);
        expect(result.messages).toHaveLength(2);
        const doc = build(result);
        expect(doc.emails.map((e) => `${e.rebuilt === null ? 'real' : 'rebuilt'} ${String(e.number)}`)).toEqual(['real 1', 'rebuilt 2', 'rebuilt 3', 'real 4']);
        const name = fixture('10-order-1-alice.eml').source.fileName;
        expect(fieldOf(doc.emails[0]!, EN.fileLabel)).toEqual([name, name]);
        expect(fieldOf(doc.emails[3]!, EN.fileLabel)).toEqual([fixture(LAST).source.fileName]);
        expect(doc.pdfNumberByPosition).toEqual([1, 4]);
    });

    it('nothing about rebuilt emails when none is chosen (switch off), and the real email is the same either way but for its number', () =>
    {
        const result = engineOf(LAST);
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
        const result = engineOf(THIRD, LAST);
        const doc = build(result, { positions: [] });
        expect(doc.emails).toEqual([]);
        expect(doc.cover.emailCount).toBe(0);
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
        const result = engineOf(LAST);
        const ids = rebuiltEntries(result).map((r) => r.id);
        expect(ids).toHaveLength(3);
        const doc = build(result, { rebuilt: ids, policy: EVERYTHING });
        expect(rebuiltOf(doc)).toEqual([]);
        expect(doc.emails.map((e) => e.number)).toEqual([1]);
        expect(doc.index.entries.map((e) => e.rebuilt)).toEqual([false]);
        expect(doc.cover.emailCount).toBe(1);
        expect(blockTexts(doc.cover.blocks).some((t) => /rebuilt/i.test(t))).toBe(false);
    });

    it('prints the source email whole, quoted history included (collapse, never delete), the same as with no rebuilt email chosen', () =>
    {
        const result = engineOf(LAST);
        const ids = rebuiltEntries(result).map((r) => r.id);
        const doc = build(result, { rebuilt: ids, policy: EVERYTHING });
        const body = doc.emails[0]!.body.map(text);
        expect(body).toEqual(bodyLines(result.messages[0]!.message.bodyText).lines.map(text));
        // Every rebuilt text is inside it, so nothing of them is lost.
        for (const r of rebuiltEntries(result))
        {
            const lines = r.rebuilt.reconstructedText.split('\n').filter((l) => l.trim() !== '');
            for (const line of lines)
            {
                expect(body.join('\n')).toContain(line.trim());
            }
        }
        expect(doc).toEqual(build(result, { rebuilt: [], policy: EVERYTHING }));
    });

    it('back to the default policy, the same choice gives the rebuilt emails again (nothing forgotten)', () =>
    {
        const result = engineOf(LAST);
        const ids = rebuiltEntries(result).map((r) => r.id);
        build(result, { rebuilt: ids, policy: EVERYTHING });
        const doc = build(result, { rebuilt: ids });
        expect(rebuiltOf(doc)).toHaveLength(3);
        expect(doc.cover.emailCount).toBe(4);
    });

    it('also when the text is quoted in several emails', () =>
    {
        const result = engineOf(THIRD, LAST);
        const doc = build(result, { policy: EVERYTHING });
        expect(rebuiltOf(doc)).toEqual([]);
        expect(doc.emails.map((e) => e.number)).toEqual([1, 2]);
        expect(rebuiltOf(build(result))).not.toEqual([]);
    });
});
