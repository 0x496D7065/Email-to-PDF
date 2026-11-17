// Unit tests for rebuild-links.ts: matching rebuilt messages to real ones,
// merging copies, and the timeline order. Synthetic data only (README.md,
// rule R7). The run over the generated conversations is in
// rebuild-links.measure.test.ts; the engine wiring in engine.test.ts; the
// cases that must NOT link in rebuild-links.adversarial.test.ts.

import { describe, expect, it } from 'vitest';
import type { EmailAddress, NormalizedMessage } from '../parsing/types';
import {
    ambiguousReadings,
    comparableText,
    copyDateAgreement,
    datedText,
    digitsOf,
    distinctShingles,
    linkRebuilt,
    MATCH_WINDOW_MS,
    MIN_SHINGLES,
    realDateAgreement,
    realSenderKeys,
    rebuiltSenderKey,
    sameWords,
    sharedWords,
    signatureStart,
    contactLine,
    contactMarker,
    compared,
    nameWordsOf,
    wordsOf,
    type LinkSource,
    type TimelineEntry,
} from './rebuild-links';
import type { QuotedDate } from './quoted-date';
import type { ReconstructedMessage } from './reconstruct';

const ALICE: EmailAddress = { name: 'Alice Example', address: 'alice@example.test' };
const BOB: EmailAddress = { name: 'Bob Sample', address: 'bob@furniture.example.test' };
const CAROL: EmailAddress = { name: 'Carol Test', address: 'carol@sample.invalid' };

const HOUR = 3_600_000;
const T0 = Date.parse('2025-03-03T08:00:00Z');

const TEXT_A = 'Hello Bob,\n\nCould you send me a quote for four desks and four chairs?\n\nBest regards,\nAlice\n';
const TEXT_B = 'Hello Alice,\n\nI can come by on Wednesday at ten to measure the room.\n\nBest regards,\nBob\n';
const TEXT_C = 'Hello Bob,\n\nWednesday works for me. Someone will open the side door.\n\nBest regards,\nAlice\n';

let counter = 0;
function make(fields: Partial<NormalizedMessage> = {}): NormalizedMessage
{
    counter++;
    return {
        messageId: `links-${counter}@example.test`,
        inReplyTo: null,
        references: [],
        date: { utcMs: T0, original: '', offsetMinutes: 0, zoneKnown: true },
        from: [ALICE],
        to: [BOB],
        cc: [],
        bcc: [],
        subject: 'Desks',
        bodyText: TEXT_A,
        attachments: [],
        source: { fileName: `links-${counter}.eml`, sha256: counter.toString(16).padStart(64, '0'), kind: 'eml' },
        warnings: [],
        ...fields,
    };
}

interface RbOptions {
    readonly from?: readonly EmailAddress[];
    /** Estimated moment; null = unreadable date. */
    readonly est?: number | null;
    readonly exact?: boolean;
    readonly precision?: 'minute' | 'day';
    readonly generation?: number;
    readonly incomplete?: readonly ('to' | 'cc')[];
    readonly to?: readonly EmailAddress[];
    readonly subject?: string | null;
    readonly dateText?: string | null;
}

/** A rebuilt message (offsets are not used by linkRebuilt). */
function rb(text: string, o: RbOptions = {}): ReconstructedMessage
{
    const est = o.est === undefined ? T0 : o.est;
    const date: QuotedDate | null =
        est === null
            ? o.dateText === undefined || o.dateText === null
                ? null
                : { text: o.dateText, wallMs: null, precision: null, estimatedUtcMs: null, basis: 'none' }
            : { text: 'd', wallMs: est, precision: o.precision ?? 'minute', estimatedUtcMs: est, basis: o.exact === true ? 'rfc-zone' : 'source-offset' };
    return {
        start: 0,
        headerEnd: 1,
        end: 1 + text.length,
        depth: 1,
        generation: o.generation ?? 1,
        kind: 'reply',
        from: o.from ?? [ALICE],
        to: o.to ?? [BOB],
        cc: [],
        subject: o.subject === undefined ? 'Desks' : o.subject,
        dateText: o.dateText === undefined ? 'd' : o.dateText,
        incomplete: o.incomplete ?? [],
        date,
        dateApproximate: o.exact !== true,
        reconstructedText: text,
        quoteMarksRemoved: true,
    };
}

/** A real message as a link source. */
function src(index: number, message: NormalizedMessage, rebuilt: readonly ReconstructedMessage[] = [], ownEnd?: number): LinkSource
{
    return { index, message, utcMs: message.date.utcMs, ownEnd: ownEnd ?? message.bodyText.length, rebuilt };
}

const dated = (utcMs: number | null): NormalizedMessage['date'] => ({ utcMs, original: '', offsetMinutes: 0, zoneKnown: utcMs !== null });

/** The timeline as short labels: "m<position>" and "r<id>". */
const labels = (t: readonly TimelineEntry[]): string[] => t.map((e) => (e.kind === 'message' ? `m${e.position}` : `r${e.id}`));

// ------------------------------------------------------------------ text

const NAME = nameWordsOf([ALICE]);
const plain = (text: string): ReturnType<typeof compared> => compared(text, new Set());
const shares = (a: string, b: string): { a: number; b: number } | null =>
{
    const r = sharedWords(compared(a, NAME), compared(b, NAME));
    return r === null ? null : { a: r.a, b: r.b };
};

describe('wordsOf and sameWords', () =>
{
    it('ignores case, punctuation, quote marks and spacing', () =>
    {
        const a = wordsOf('> Hello,  BOB!\n> The desks: four.');
        expect(a.tokens).toEqual(['hello', 'bob', 'the', 'desks', 'four']);
        expect(sameWords(a, wordsOf('hello bob the desks four'))).toBe(true);
    });

    it('treats composed and decomposed accents alike (NFC)', () =>
    {
        expect(sameWords(wordsOf('la cre\u0300me du caf\u00e9 ici'), wordsOf('la cr\u00e8me du cafe\u0301 ici'))).toBe(true);
    });

    it('needs the very same words: nothing added, dropped, changed or moved anywhere', () =>
    {
        expect(sameWords(wordsOf('one two three four five'), wordsOf('one two three four'))).toBe(false);
        expect(sameWords(wordsOf('two three four'), wordsOf('zero one two three four'))).toBe(false);
        expect(sameWords(wordsOf('we decided to accept the offer today'), wordsOf('we decided to reject the offer today'))).toBe(false);
        expect(sameWords(wordsOf('from ten to two'), wordsOf('from two to ten'))).toBe(false);
        expect(sameWords(wordsOf('ab c'), wordsOf('a bc'))).toBe(false);
        expect(sameWords(wordsOf('ok'), wordsOf('not ok'))).toBe(false);
    });
});

describe('signature blocks and sharedWords (policy (b))', () =>
{
    it('finds a block of contact lines after the last blank line, opening with the sender name', () =>
    {
        const text = 'Approved.\n\nAlice Example\nSales Manager\nExample Furniture Ltd.\nRue de l\u2019Exemple 12, 1000 Brussels\nPhone +32 2 555 01 23\nalice@example.test\n';
        expect(signatureStart(text, NAME)).toBe('Approved.\n\n'.length);
        expect(signatureStart('Approved.\n\nAlice\n\n', NAME)).toBe('Approved.\n\n'.length);
        // After a "-- " separator line.
        expect(signatureStart('Approved.\n-- \nAlice\nTel: +32 2 555 01 23\n', NAME)).toBe('Approved.\n'.length);
    });

    it('finds no block in doubt', () =>
    {
        // No sender name (no name words), or a first line that is not the name.
        expect(signatureStart('Approved.\n\nAlice\n', new Set())).toBeNull();
        expect(signatureStart('Approved.\n\nCancelled\n', NAME)).toBeNull();
        expect(signatureStart('Approved.\n\nBest regards,\nAlice\n', NAME)).toBeNull();
        // A line that is a sentence, holds a veto word, a question, or "PS:".
        expect(signatureStart('Approved.\n\nAlice\nlegal says this is off\n', NAME)).toBeNull();
        expect(signatureStart('Approved.\n\nAlice\nNot Approved\n', NAME)).toBeNull();
        expect(signatureStart('Approved.\n\nAlice\nCancelled\n', NAME)).toBeNull();
        expect(signatureStart('Approved.\n\nAlice\nReally?\n', NAME)).toBeNull();
        expect(signatureStart('Approved.\n-- \nAlice\nPS: We Decline\n', NAME)).toBeNull();
        // Nothing before the block, no blank line, or too many lines.
        expect(signatureStart('Alice\n', NAME)).toBeNull();
        expect(signatureStart('Approved.\nAlice\n', NAME)).toBeNull();
        expect(signatureStart(`Approved.\n\nAlice\n${'Example Street\n'.repeat(8)}`, NAME)).toBeNull();
        // The name line and more, but no contact marker after it (in both forms).
        for (const extra of ['Afgelast', 'Rescinded', 'Disregard This Email', '12 March 2025', 'Total 950 EUR', 'Sales Manager'])
        {
            expect(signatureStart(`Approved.\n\nAlice\n${extra}\n`, NAME), extra).toBeNull();
            expect(signatureStart(`Approved.\n-- \nAlice\n${extra}\n`, NAME), extra).toBeNull();
        }
        // The name line alone, or with a marker, is a block.
        expect(signatureStart('Approved.\n-- \nAlice\n', NAME)).toBe('Approved.\n'.length);
        expect(signatureStart('Approved.\n\nAlice\nSales Manager\nalice@example.test\n', NAME)).toBe('Approved.\n\n'.length);
    });

    it('contact markers: a mail address, a web address or a phone number, nothing else', () =>
    {
        for (const ok of [
            'alice@example.test',
            'E-mail: alice@example.test',
            '<alice@example.test>',
            'www.example.test',
            'Web: www.example.test/team',
            '+32 2 123 45 67',
            'Phone +32 2 555 01 23',
            'Tel: (02) 123.45.67',
            '0470 12 34 56',
            'M. 0470-12-34-56',
        ])
        {
            expect(contactMarker(ok), ok).toBe(true);
        }
        for (const no of [
            'Afgelast',
            'Rescinded',
            'Sales Manager',
            '12 March 2025',
            'Total 950 EUR',
            'Total 1 250 000',
            '1250000',
            '12.03.2025',
            'Tel: 2025-03-12',
            'Phone 12345',
            'Invoice 2025031',
            'alice@example',
        ])
        {
            expect(contactMarker(no), no).toBe(false);
        }
    });

    it('contact lines: names, titles, companies, addresses, phones, mail and web addresses only', () =>
    {
        for (const ok of ['Sales Manager', 'Head of Sales', 'Example Furniture Ltd.', 'Phone +32 2 555 01 23', 'E-mail: alice@example.test', 'www.example.test', 'Rue de l\u2019Exemple 12'])
        {
            expect(contactLine(ok), ok).toBe(true);
        }
        for (const no of ['we decline', 'Not Approved', 'Cancelled', 'Update: Legal Did Not Approve', 'Yes', 'OK', 'Call Me?', 'Niet Akkoord', 'Pas Possible'])
        {
            expect(contactLine(no), no).toBe(false);
        }
    });

    it('the same words, or the same words plus a trailing signature block on ONE side', () =>
    {
        expect(shares('Approved.\n', 'Approved.\n')).toEqual({ a: 1, b: 1 });
        expect(shares('Approved.\n\nAlice\nSales Manager\nalice@example.test\n', 'Approved.\n')).toEqual({ a: 1 / 7, b: 1 });
        expect(shares('Approved.\n', 'Approved.\n\nAlice\nSales Manager\nalice@example.test\n')).toEqual({ a: 1, b: 1 / 7 });
        // The name line and a title but no contact marker: no block, nothing shared.
        expect(shares('Approved.\n\nAlice\nSales Manager\n', 'Approved.\n')).toBeNull();
        // Any other extra words, at the start or the end: nothing shared.
        expect(shares('Approved.\n', 'Not approved.\n')).toBeNull();
        expect(shares('Approved.\n\nAlice\n', 'Not approved.\n\nAlice\n')).toBeNull();
        expect(shares('Yes\n', 'Yes, cancelled\n')).toBeNull();
        expect(shares('Yes\n', 'No.\n\nYes\n')).toBeNull();
        expect(shares('Yes\n', 'Yes\n\nPS: we decline.\n')).toBeNull();
        // Two different blocks: one side only may have extra lines.
        expect(shares('Approved.\n\nAlice\n', 'Approved.\n\nAlice Example\n')).toBeNull();
        // No word at all.
        expect(sharedWords(plain('> --- !'), plain('anything'))).toBeNull();
    });
});

describe('comparableText', () =>
{
    it('leaves a complete header text unchanged', () =>
    {
        expect(comparableText(rb('Frank Mockup; Grace Dummy\n\nHello Bob,\n'))).toBe('Frank Mockup; Grace Dummy\n\nHello Bob,\n');
    });

    it('skips the leftover header lines of an incomplete header, up to the first blank line', () =>
    {
        const r = rb('Frank Mockup; Grace Dummy\nOnderwerp: Desks\n\nHello Bob,\n\nAlice\n', { incomplete: ['to'] });
        expect(comparableText(r)).toBe('Hello Bob,\n\nAlice\n');
        const addresses = rb('frank@sample.invalid, Grace Dummy <grace@sample.invalid>\nSubject: Desks\n\nHello Bob,\n', { incomplete: ['to'] });
        expect(comparableText(addresses)).toBe('Hello Bob,\n');
        // Leftover lines up to the end: nothing to compare.
        expect(comparableText(rb('Frank Mockup; Grace Dummy\n', { incomplete: ['to'] }))).toBe('');
    });

    it('skips nothing when the text opens with a blank line', () =>
    {
        expect(comparableText(rb('\nHello Bob,\n', { incomplete: ['to'] }))).toBe('\nHello Bob,\n');
    });

    it('skips nothing when a line does not look like a header leftover, or no blank line follows the leftovers', () =>
    {
        // No ";" or "@": a body line may be a name ("Thanks Bob").
        expect(comparableText(rb('Frank Mockup\n\nHello Bob,\n', { incomplete: ['to'] }))).toBe('Frank Mockup\n\nHello Bob,\n');
        // A body line with a comma, or with ";" and words that are no names.
        expect(comparableText(rb('No, the delivery on Friday does not work.\n\nAlice\n', { incomplete: ['to'] }))).toBe('No, the delivery on Friday does not work.\n\nAlice\n');
        expect(comparableText(rb('Fine; see the plan below.\n\nAlice\n', { incomplete: ['to'] }))).toBe('Fine; see the plan below.\n\nAlice\n');
        // Leftover-shaped lines, then body text without a blank line between.
        expect(comparableText(rb('Frank Mockup; Grace Dummy\nHello Bob,\n\nAlice\n', { incomplete: ['to'] }))).toBe('Frank Mockup; Grace Dummy\nHello Bob,\n\nAlice\n');
    });

    it('skips nothing when an incomplete list is EMPTY (it may come from the "yields no mailbox" rule: the header was read whole)', () =>
    {
        const text = 'Frank Mockup; Grace Dummy\n\nHello Bob,\n';
        expect(comparableText(rb(text, { incomplete: ['to'], to: [] }))).toBe(text);
        expect(comparableText(rb(text, { incomplete: ['to', 'cc'] }))).toBe(text); // cc is empty
    });
});

// ------------------------------------------------------------------ people and dates

describe('sender keys', () =>
{
    it('uses the address (lower case), else the name; none without exactly one mailbox', () =>
    {
        expect(rebuiltSenderKey({ from: [{ name: 'Alice', address: 'Alice@Example.TEST' }] })).toBe('a:alice@example.test');
        expect(rebuiltSenderKey({ from: [{ name: '  "Alice   Example" ', address: '' }] })).toBe('n:alice example');
        expect(rebuiltSenderKey({ from: [] })).toBeNull();
        expect(rebuiltSenderKey({ from: [ALICE, BOB] })).toBeNull();
        expect(rebuiltSenderKey({ from: [{ name: '', address: '' }] })).toBeNull();
    });

    it('a real message answers to the addresses and names of all its From mailboxes', () =>
    {
        expect(realSenderKeys({ from: [ALICE, { name: '', address: 'Bob@Furniture.Example.TEST' }] }).sort()).toEqual([
            'a:alice@example.test',
            'a:bob@furniture.example.test',
            'n:alice example',
        ]);
    });
});

describe('realDateAgreement', () =>
{
    const MINUTE = { precision: 'minute' } as const;
    const DAY = { precision: 'day' } as const;
    it('exact date: within two minutes, else no agreement at all', () =>
    {
        expect(realDateAgreement(MINUTE, false, 119_000, 0)).toBe('exact');
        expect(realDateAgreement(MINUTE, false, -119_000, 0)).toBe('exact');
        expect(realDateAgreement(MINUTE, false, 121_000, 0)).toBeNull();
        expect(realDateAgreement(MINUTE, false, 5 * HOUR, 0)).toBeNull();
    });

    it('approximate date: exact within one minute, strong at the offset to the sender zone, zone on the quarter-hour grid', () =>
    {
        expect(realDateAgreement(MINUTE, true, 31_000, 0)).toBe('exact');
        expect(realDateAgreement(MINUTE, true, -2 * HOUR + 30_000, 0, -2 * HOUR)).toBe('strong');
        expect(realDateAgreement(MINUTE, true, 5 * HOUR + 45 * 60_000 + 30_000, 0)).toBe('zone');
        expect(realDateAgreement(MINUTE, true, -9 * HOUR, 0, -2 * HOUR)).toBe('zone');
        expect(realDateAgreement(MINUTE, true, 5 * HOUR + 40 * 60_000, 0)).toBeNull();
    });

    it('approximate date with minutes: the diff is S - W, with the writer zone W in [-12 h, +14 h]', () =>
    {
        // Source zone S = UTC: diff in [-14 h, +12 h] (a minute of slack).
        expect(realDateAgreement(MINUTE, true, -14 * HOUR, 0)).toBe('zone');
        expect(realDateAgreement(MINUTE, true, -14 * HOUR - 15 * 60_000, 0)).toBeNull();
        expect(realDateAgreement(MINUTE, true, 12 * HOUR + 30_000, 0)).toBe('zone');
        expect(realDateAgreement(MINUTE, true, 12 * HOUR + 15 * 60_000, 0)).toBeNull();
        // The same time a day later or earlier (a daily message): never.
        expect(realDateAgreement(MINUTE, true, -24 * HOUR + 12_000, 0)).toBeNull();
        expect(realDateAgreement(MINUTE, true, 24 * HOUR + 12_000, 0)).toBeNull();
        // Source zone S = UTC+10: diff in [-4 h, +22 h].
        expect(realDateAgreement(MINUTE, true, 22 * HOUR, 10 * HOUR)).toBe('zone');
        expect(realDateAgreement(MINUTE, true, -5 * HOUR, 10 * HOUR)).toBeNull();
        expect(realDateAgreement(MINUTE, true, MATCH_WINDOW_MS + 15 * 60_000, 14 * HOUR)).toBeNull();
    });

    it('a date without minutes: strict, the diff in [S - 14 h, S + 36 h] and within 26 h', () =>
    {
        expect(realDateAgreement(DAY, true, 0, 0)).toBe('strict');
        expect(realDateAgreement(DAY, true, 10 * HOUR + 7 * 60_000, 0)).toBe('strict');
        expect(realDateAgreement(DAY, true, 25 * HOUR, 0)).toBe('strict');
        expect(realDateAgreement(DAY, true, -14 * HOUR, 0)).toBe('strict');
        // The day after the real message ("On 4 March" for a 3 March 09:00 UTC message).
        expect(realDateAgreement(DAY, true, -15 * HOUR, 0)).toBeNull();
        expect(realDateAgreement(DAY, true, MATCH_WINDOW_MS + 1, 0)).toBeNull();
        expect(realDateAgreement({ precision: null }, true, 0, 0)).toBeNull();
    });

    it('the source zone unknown: read as UTC, so the writer zone gives diff in [-14 h, +12 h], never better than strict', () =>
    {
        expect(realDateAgreement(MINUTE, true, 0, null)).toBe('strict');
        expect(realDateAgreement(MINUTE, true, -14 * HOUR, null)).toBe('strict');
        expect(realDateAgreement(MINUTE, true, 12 * HOUR, null)).toBe('strict');
        expect(realDateAgreement(MINUTE, true, -14 * HOUR - 2 * 60_000, null)).toBeNull();
        expect(realDateAgreement(MINUTE, true, 12 * HOUR + 2 * 60_000, null)).toBeNull();
        // A daily message a day apart: never.
        expect(realDateAgreement(MINUTE, true, -24 * HOUR, null)).toBeNull();
        expect(realDateAgreement(MINUTE, true, 24 * HOUR, null)).toBeNull();
        // A day only: still at most 14 h either way.
        expect(realDateAgreement(DAY, true, 14 * HOUR, null)).toBe('strict');
        expect(realDateAgreement(DAY, true, 15 * HOUR, null)).toBeNull();
        expect(realDateAgreement(MINUTE, true, MATCH_WINDOW_MS + 1, null)).toBeNull();
        // An exact date does not need it.
        expect(realDateAgreement(MINUTE, false, 0, null)).toBe('exact');
    });
});

describe('copyDateAgreement', () =>
{
    const approx = (zoneMinutes: number, precision: 'minute' | 'day' = 'minute') => ({ precision, approximate: true, zoneMinutes });
    const exact = { precision: 'minute', approximate: false, zoneMinutes: 0 } as const;
    it('two exact dates: within two minutes', () =>
    {
        expect(copyDateAgreement(exact, exact, 90_000)).toBe('exact');
        expect(copyDateAgreement(exact, exact, 3 * 60_000)).toBeNull();
    });

    it('two approximate dates of sources in the same zone: the same minute only', () =>
    {
        expect(copyDateAgreement(approx(60), approx(60), 0)).toBe('exact');
        expect(copyDateAgreement(approx(60), approx(60), 8 * HOUR)).toBeNull();
    });

    it('sources in different zones, or one exact date: on the grid within 26 h', () =>
    {
        expect(copyDateAgreement(approx(60), approx(-300), 6 * HOUR)).toBe('zone');
        expect(copyDateAgreement(approx(60), approx(-300), 6 * HOUR + 7 * 60_000)).toBeNull();
        expect(copyDateAgreement(exact, approx(60), -HOUR)).toBe('zone');
        expect(copyDateAgreement(exact, approx(60), 30_000)).toBe('exact');
        expect(copyDateAgreement(approx(60), approx(-300), MATCH_WINDOW_MS + 15 * 60_000)).toBeNull();
    });

    it('two approximate dates: the same moment, or the same wall time read in the two source zones; nothing else', () =>
    {
        // Bob (UTC) "Mon 09:00" and Carol (UTC+1) "Tue 10:00": 24 h apart, not S_a - S_b (+1 h).
        expect(copyDateAgreement(approx(0), approx(60), 24 * HOUR)).toBeNull();
        expect(copyDateAgreement(approx(0), approx(60), -HOUR)).toBe('zone');
        expect(copyDateAgreement(approx(0), approx(60), HOUR)).toBeNull();
        expect(copyDateAgreement(approx(0), approx(60), 30_000)).toBe('exact');
    });

    it('one exact date: the approximate one written in a zone of [-12 h, +14 h]', () =>
    {
        // b approximate in UTC: diff = W_b, in [-12 h, +14 h].
        expect(copyDateAgreement(exact, approx(0), 14 * HOUR)).toBe('zone');
        expect(copyDateAgreement(exact, approx(0), -12 * HOUR)).toBe('zone');
        expect(copyDateAgreement(exact, approx(0), -13 * HOUR)).toBeNull();
        expect(copyDateAgreement(exact, approx(0), 24 * HOUR)).toBeNull();
        // a approximate in UTC: diff = -W_a.
        expect(copyDateAgreement(approx(0), exact, 12 * HOUR)).toBe('zone');
        expect(copyDateAgreement(approx(0), exact, 13 * HOUR)).toBeNull();
    });

    it('a date without minutes: strict, and with the same zone the same day only', () =>
    {
        expect(copyDateAgreement(approx(60, 'day'), approx(-300, 'day'), 6 * HOUR)).toBe('strict');
        expect(copyDateAgreement(approx(60, 'day'), approx(60, 'day'), 24 * HOUR)).toBeNull();
        expect(copyDateAgreement(approx(60, 'day'), approx(60, 'day'), 0)).toBe('strict');
        expect(copyDateAgreement(approx(60, 'day'), approx(60), 10 * HOUR)).toBe('strict');
    });
});

describe('evidence helpers', () =>
{
    it('counts distinct shingles of three words', () =>
    {
        expect(distinctShingles(wordsOf('OK'))).toBe(0);
        expect(distinctShingles(wordsOf('one two three four'))).toBe(2);
        expect(distinctShingles(wordsOf('a b c a b c'))).toBe(3);
    });

    it('reads the digit runs in text order', () =>
    {
        expect(digitsOf(wordsOf('Invoice 2025-031: 1200 euro'))).toBe('2025 031 1200');
        expect(digitsOf(wordsOf('1200 euro, invoice 2025-031'))).not.toBe(digitsOf(wordsOf('Invoice 2025-031: 1200 euro')));
        expect(digitsOf(wordsOf('moved from 10:00 to 14:00'))).not.toBe(digitsOf(wordsOf('moved from 14:00 to 10:00')));
        expect(digitsOf(wordsOf('invoice 2025-030, 950 euro'))).not.toBe(digitsOf(wordsOf('invoice 2025-031, 1200 euro')));
        expect(digitsOf(wordsOf('1 1 2'))).not.toBe(digitsOf(wordsOf('1 2 2')));
    });

    it('a date text is precise enough to merge copies only with a 4-digit year and a day number', () =>
    {
        expect(datedText('04/03/2025 05:21')).toBe(true);
        expect(datedText('lundi 3 mars 2025 14h02 CET')).toBe(true);
        expect(datedText('yesterday')).toBe(false);
        expect(datedText('Monday 10:00')).toBe(false);
        expect(datedText('March 2025')).toBe(false);
        expect(datedText('3 March 14:02')).toBe(false);
    });
});

describe('ambiguousReadings', () =>
{
    it('gives both readings of a day/month that could be swapped', () =>
    {
        expect(ambiguousReadings('04/03/2025 05:21', 0)).toEqual([Date.parse('2025-03-04T05:21:00Z'), Date.parse('2025-04-03T05:21:00Z')]);
        expect(ambiguousReadings('04.03.2025 05:21', 60)).toEqual([Date.parse('2025-03-04T04:21:00Z'), Date.parse('2025-04-03T04:21:00Z')]);
    });

    it('gives nothing for other texts', () =>
    {
        expect(ambiguousReadings(null, 0)).toEqual([]);
        expect(ambiguousReadings('Mon, Mar 3, 2025 at 2:02 PM', 0)).toEqual([]);
        expect(ambiguousReadings('04/03/25 05:21', 0)).toEqual([]);
        expect(ambiguousReadings('04/03/20251', 0)).toEqual([]);
    });
});

// ------------------------------------------------------------------ the real file wins

describe('linkRebuilt: rebuilt vs real', () =>
{
    /** Real message A (Alice, T0) and a later email from Bob that quotes it. */
    function pair(rebuilt: ReconstructedMessage, real: Partial<NormalizedMessage> = {}): ReturnType<typeof linkRebuilt>
    {
        const a = make({ bodyText: TEXT_A, ...real });
        const b = make({ from: [BOB], to: [ALICE], date: dated(T0 + 5 * HOUR), bodyText: `${TEXT_B}\n> quoted\n` });
        return linkRebuilt([src(0, a), src(1, b, [rebuilt])]);
    }

    it('links a rebuilt message to its real file: no entry of its own', () =>
    {
        const out = pair(rb(TEXT_A, { est: T0 + 2 * HOUR }));
        expect(out.reconstructed[0]).toMatchObject({ id: 0, sourceIndex: 1, link: 'real', realIndex: 0, sameAs: null });
        // Two hours apart on the quarter-hour grid: a 'zone' agreement (not strong).
        expect(out.reconstructed[0]?.match).toEqual({ coverage: 1, reverseCoverage: 1, dateDiffMs: -2 * HOUR, strong: false, ambiguousDate: false });
        expect(labels(out.timeline)).toEqual(['m0', 'm1']);
        // The same minute: an 'exact' agreement.
        expect(pair(rb(TEXT_A)).reconstructed[0]?.match).toMatchObject({ dateDiffMs: 0, strong: true });
    });

    it('matches a sender by name when the quote has no address', () =>
    {
        expect(pair(rb(TEXT_A, { from: [{ name: 'alice  example', address: '' }] })).reconstructed[0]?.link).toBe('real');
    });

    it('does not match another sender, or the same name with another address', () =>
    {
        expect(pair(rb(TEXT_A, { from: [CAROL] })).reconstructed[0]?.link).toBe('entry');
        expect(pair(rb(TEXT_A, { from: [{ name: 'Alice Example', address: 'alice@sample.invalid' }] })).reconstructed[0]?.link).toBe('entry');
        expect(pair(rb(TEXT_A, { from: [] })).reconstructed[0]?.link).toBe('entry');
    });

    it('dates: a zone offset apart only (writer zone in [-12 h, +14 h]), and a readable (or ambiguous) date is needed', () =>
    {
        // Source in UTC: real minus estimate in [-14 h, +12 h].
        expect(pair(rb(TEXT_A, { est: T0 + 14 * HOUR })).reconstructed[0]?.link).toBe('real');
        expect(pair(rb(TEXT_A, { est: T0 + 14 * HOUR + 15 * 60_000 })).reconstructed[0]?.link).toBe('entry');
        expect(pair(rb(TEXT_A, { est: T0 - 12 * HOUR })).reconstructed[0]?.link).toBe('real');
        expect(pair(rb(TEXT_A, { est: T0 - 12 * HOUR - 15 * 60_000 })).reconstructed[0]?.link).toBe('entry');
        expect(pair(rb(TEXT_A, { est: T0 + 24 * HOUR })).reconstructed[0]?.link).toBe('entry');
        expect(pair(rb(TEXT_A, { est: T0 - MATCH_WINDOW_MS - 1 })).reconstructed[0]?.link).toBe('entry');
        expect(pair(rb(TEXT_A, { est: null, dateText: 'next week' })).reconstructed[0]?.link).toBe('entry');
        expect(pair(rb(TEXT_A), { date: dated(null) }).reconstructed[0]?.link).toBe('entry');
    });

    it('an ambiguous numeric date matches when one reading is within 26 h (never strong)', () =>
    {
        const out = pair(rb(TEXT_A, { est: null, dateText: '03/04/2025 09:00' }), { date: dated(Date.parse('2025-04-03T08:00:00Z')) });
        expect(out.reconstructed[0]).toMatchObject({ link: 'real', match: { strong: false, ambiguousDate: true, dateDiffMs: -HOUR } });
        const far = pair(rb(TEXT_A, { est: null, dateText: '03/04/2025 09:00' }), { date: dated(Date.parse('2025-06-03T08:00:00Z')) });
        expect(far.reconstructed[0]?.link).toBe('entry');
    });

    // Letter-only words (no figures): wa wb ... and xa xb ...
    const letters = (prefix: string, n: number): string => Array.from({ length: n }, (_, k) => `${prefix}${String.fromCharCode(97 + k)}`).join(' ');
    // 12 words in the real text; the rebuilt text adds a signature block of `extra` words at its tail
    // ("Alice", then capitalised contact lines of up to four words, then a
    // phone number of one word, the contact marker a block needs; extra >= 2).
    const REAL = letters('w', 12);
    const block = (extra: number): string =>
    {
        const rest = Array.from({ length: extra - 2 }, (_, k) => `X${String.fromCharCode(97 + (k % 26))}${String.fromCharCode(97 + Math.floor(k / 26))}`);
        const lines = ['Alice'];
        for (let k = 0; k < rest.length; k += 4)
        {
            lines.push(rest.slice(k, k + 4).join(' '));
        }
        lines.push('+3221234567');
        return `\n\n${lines.join('\n')}\n`;
    };
    const withExtra = (extra: number): string => `${REAL}${block(extra)}`;
    const QUARTER = 15 * 60_000;

    it('needs 80% of the rebuilt text in the real one, or 50% when the dates agree exactly or strongly', () =>
    {
        // A quarter of an hour apart (a zone agreement): 12 of 12 + 4 words = 75% (below 80%).
        expect(pair(rb(withExtra(4), { est: T0 + QUARTER }), { bodyText: REAL }).reconstructed[0]?.link).toBe('entry');
        // 12 of 12 + 3 words: 80%.
        expect(pair(rb(withExtra(3), { est: T0 + QUARTER }), { bodyText: REAL }).reconstructed[0]?.link).toBe('real');
        // The same minute (exact, with an address): 12/24 = 50% is enough, 12/25 = 48% is not.
        expect(pair(rb(withExtra(12), { est: T0 }), { bodyText: REAL }).reconstructed[0]).toMatchObject({ link: 'real', match: { strong: true } });
        expect(pair(rb(withExtra(13), { est: T0 }), { bodyText: REAL }).reconstructed[0]?.link).toBe('entry');
        // Strong: two hours off, the offset between the source zone (UTC) and the real sender's zone (UTC+2).
        const plus2 = { date: { utcMs: T0, original: '', offsetMinutes: 120, zoneKnown: true }, bodyText: REAL };
        expect(pair(rb(withExtra(12), { est: T0 + 2 * HOUR }), plus2).reconstructed[0]).toMatchObject({ link: 'real', match: { strong: true, dateDiffMs: -2 * HOUR } });
        // The same 50% with a mere grid match (not strong), off the grid, or a name only.
        expect(pair(rb(withExtra(12), { est: T0 + 2 * HOUR }), { bodyText: REAL }).reconstructed[0]?.link).toBe('entry');
        expect(pair(rb(withExtra(12), { est: T0 + 2 * HOUR + 7 * 60_000 }), { bodyText: REAL }).reconstructed[0]?.link).toBe('entry');
        expect(pair(rb(withExtra(12), { est: T0, from: [{ name: 'Alice Example', address: '' }] }), { bodyText: REAL }).reconstructed[0]?.link).toBe('entry');
    });

    it('needs the very same words: other words anywhere but a trailing signature block mean no link', () =>
    {
        const words = REAL.split(' ');
        words[6] = 'zz';
        expect(pair(rb(words.join(' ')), { bodyText: REAL }).reconstructed[0]?.link).toBe('entry');
        // Extra words at the head or the tail that are no signature block: no link.
        expect(pair(rb(`${letters('x', 2)} ${REAL}`), { bodyText: REAL }).reconstructed[0]?.link).toBe('entry');
        expect(pair(rb(`${REAL} ${letters('x', 2)}`), { bodyText: REAL }).reconstructed[0]?.link).toBe('entry');
        expect(pair(rb(`${REAL}\n\nWe Decline`),{ bodyText: REAL }).reconstructed[0]?.link).toBe('entry');
        // A trailing signature block on either side: a link.
        expect(pair(rb(withExtra(2)), { bodyText: REAL }).reconstructed[0]?.link).toBe('real');
        expect(pair(rb(REAL), { bodyText: withExtra(2) }).reconstructed[0]?.link).toBe('real');
    });

    it('needs 50% of the real message own text in the rebuilt one too', () =>
    {
        // 12 of 25 words in common (a signature block of 13), then 12 of 24.
        expect(pair(rb(REAL), { bodyText: withExtra(13) }).reconstructed[0]?.link).toBe('entry');
        expect(pair(rb(REAL), { bodyText: withExtra(12) }).reconstructed[0]?.link).toBe('real');
    });

    it('an exact date must be within two minutes; an approximate one on the quarter-hour grid', () =>
    {
        expect(pair(rb(TEXT_A, { exact: true, est: T0 - 90_000 })).reconstructed[0]?.link).toBe('real');
        expect(pair(rb(TEXT_A, { exact: true, est: T0 - 3 * 60_000 })).reconstructed[0]?.link).toBe('entry');
        expect(pair(rb(TEXT_A, { exact: true, est: T0 - HOUR })).reconstructed[0]?.link).toBe('entry');
        expect(pair(rb(TEXT_A, { est: T0 - HOUR - 5 * 60_000 })).reconstructed[0]?.link).toBe('entry');
    });

    it('a short text (fewer than 10 distinct shingles) links only when the dates agree exactly', () =>
    {
        const short = 'Fine, see you on Wednesday then.\n\nAlice\n'; // 7 words, 5 shingles
        expect(distinctShingles(wordsOf(short))).toBeLessThan(MIN_SHINGLES);
        expect(pair(rb(short), { bodyText: short }).reconstructed[0]?.link).toBe('real');
        expect(pair(rb(short, { exact: true, est: T0 + 60_000 }), { bodyText: short }).reconstructed[0]?.link).toBe('real');
        expect(pair(rb(short, { est: T0 + HOUR }), { bodyText: short }).reconstructed[0]?.link).toBe('entry');
        // Not with a name-only sender either (never exact).
        expect(pair(rb(short, { from: [{ name: 'Alice Example', address: '' }] }), { bodyText: short }).reconstructed[0]?.link).toBe('entry');
    });

    it('never links texts whose figures differ, however similar the rest', () =>
    {
        const real = `${TEXT_A}Order 4471, delivery in week 12.\n`;
        expect(pair(rb(real), { bodyText: real }).reconstructed[0]?.link).toBe('real');
        expect(pair(rb(`${TEXT_A}Order 4471, delivery in week 13.\n`), { bodyText: real }).reconstructed[0]?.link).toBe('entry');
        expect(pair(rb(`${TEXT_A}Order 4471, delivery in week 12 or 12.\n`), { bodyText: real }).reconstructed[0]?.link).toBe('entry');
    });

    it('a date without minutes needs the strict text rule: 80% each way', () =>
    {
        const day = { precision: 'day', est: T0 - 8 * HOUR } as const;
        expect(pair(rb(TEXT_A, day)).reconstructed[0]).toMatchObject({ link: 'real', match: { strong: false } });
        // All of the rebuilt text in the real one, but the real one has more: 12 of its 16 words (75%) in the rebuilt text.
        expect(pair(rb(REAL, day), { bodyText: withExtra(4) }).reconstructed[0]?.link).toBe('entry');
        expect(pair(rb(REAL, { est: T0 - 8 * HOUR }), { bodyText: withExtra(4) }).reconstructed[0]?.link).toBe('real');
    });

    it('compares with the real message OWN text only, not the history it quotes', () =>
    {
        // A later message from Alice quotes TEXT_A below its own (different) text.
        const later = make({ date: dated(T0 + 10 * HOUR), bodyText: `${TEXT_C}\n> earlier\n${TEXT_A}` });
        const quoter = make({ from: [BOB], date: dated(T0 + 12 * HOUR), bodyText: TEXT_B });
        const out = linkRebuilt([src(0, later, [], TEXT_C.length), src(1, quoter, [rb(TEXT_A, { est: T0 })])]);
        expect(out.reconstructed[0]?.link).toBe('entry');
    });

    it('never links a rebuilt message to its own source', () =>
    {
        const self = make({ bodyText: `${TEXT_A}\n${TEXT_A}` });
        const out = linkRebuilt([src(0, self, [rb(TEXT_A, { est: T0 - HOUR })], TEXT_A.length)]);
        expect(out.reconstructed[0]?.link).toBe('entry');
    });

    it('with several qualifying real messages, the highest coverage wins, then the closest date', () =>
    {
        const exact = make({ date: dated(T0 + 3 * HOUR), bodyText: TEXT_A });
        const partial = make({ date: dated(T0), bodyText: `${TEXT_A}\nPS: one more line here.` });
        const quoter = make({ from: [BOB], date: dated(T0 + 20 * HOUR), bodyText: TEXT_B });
        const out = linkRebuilt([src(0, partial), src(1, exact), src(2, quoter, [rb(`${TEXT_A}\nPS: one more line here.`, { est: T0 })])]);
        expect(out.reconstructed[0]).toMatchObject({ link: 'real', realIndex: 0 });
        const twins = linkRebuilt([src(0, make({ date: dated(T0 + 3 * HOUR) })), src(1, make({ date: dated(T0 + HOUR) })), src(2, quoter, [rb(TEXT_A, { est: T0 })])]);
        expect(twins.reconstructed[0]).toMatchObject({ link: 'real', realIndex: 1 });
    });
});

// ------------------------------------------------------------------ rebuilt vs rebuilt

describe('linkRebuilt: the same quoted text in several emails', () =>
{
    const quoter = (k: number, body = TEXT_B): NormalizedMessage => make({ from: [BOB], date: dated(T0 + (5 + k) * HOUR), bodyText: body });

    it('becomes one entry; the other copies point to it, and it lists them', () =>
    {
        const out = linkRebuilt([src(3, quoter(0), [rb(TEXT_A)]), src(7, quoter(1), [rb(TEXT_A)])]);
        expect(out.reconstructed.map((r) => r.link)).toEqual(['entry', 'same-as']);
        expect(out.reconstructed[0]).toMatchObject({ copies: [1], alsoQuotedIn: [7] });
        expect(out.reconstructed[1]).toMatchObject({ sameAs: 0, copies: [], alsoQuotedIn: [] });
        expect(labels(out.timeline)).toEqual(['r0', 'm0', 'm1']);
    });

    it('the entry is the best copy: complete fields first, then more known fields, then the lower generation', () =>
    {
        const incomplete = rb(TEXT_A, { incomplete: ['to'] });
        const complete = rb(TEXT_A, { generation: 3 });
        expect(linkRebuilt([src(0, quoter(0), [incomplete]), src(1, quoter(1), [complete])]).reconstructed.map((r) => r.link)).toEqual(['same-as', 'entry']);
        const noSubject = rb(TEXT_A, { subject: null });
        expect(linkRebuilt([src(0, quoter(0), [noSubject]), src(1, quoter(1), [rb(TEXT_A, { generation: 2 })])]).reconstructed.map((r) => r.link)).toEqual(['same-as', 'entry']);
        const gen2 = rb(TEXT_A, { generation: 2 });
        expect(linkRebuilt([src(0, quoter(0), [rb('Other words from Bob in between.', { from: [BOB] }), gen2]), src(1, quoter(1), [rb(TEXT_A)])]).reconstructed.map((r) => r.link)).toEqual(['entry', 'same-as', 'entry']);
    });

    it('never merges two messages rebuilt from the same email', () =>
    {
        const same = linkRebuilt([src(0, quoter(0), [rb(TEXT_A), rb(TEXT_A, { generation: 2 })])]);
        expect(same.reconstructed.map((r) => r.link)).toEqual(['entry', 'entry']);
    });

    it('merges copies without a readable date only when their date text is the same', () =>
    {
        const links = (a: string | null, b: string | null): string[] =>
            linkRebuilt([src(0, quoter(0), [rb(TEXT_A, { est: null, dateText: a })]), src(1, quoter(1), [rb(TEXT_A, { est: null, dateText: b })])]).reconstructed.map((r) => r.link);
        expect(links('04/03/2025  05:21', '04/03/2025 05:21')).toEqual(['entry', 'same-as']);
        expect(links('04/03/2025 05:21', '04/03/2025 05:22')).toEqual(['entry', 'entry']);
        expect(links(null, null)).toEqual(['entry', 'entry']);
        // A readable copy and an unreadable one are not compared.
        const mixed = linkRebuilt([src(0, quoter(0), [rb(TEXT_A)]), src(1, quoter(1), [rb(TEXT_A, { est: null, dateText: 'd' })])]);
        expect(mixed.reconstructed.map((r) => r.link)).toEqual(['entry', 'entry']);
    });

    it('does not merge different texts of one sender, or texts more than 26 h apart', () =>
    {
        expect(linkRebuilt([src(0, quoter(0), [rb(TEXT_A)]), src(1, quoter(1), [rb(TEXT_C)])]).reconstructed.map((r) => r.link)).toEqual(['entry', 'entry']);
        const far = linkRebuilt([src(0, quoter(0), [rb(TEXT_A)]), src(1, quoter(1), [rb(TEXT_A, { est: T0 + MATCH_WINDOW_MS + 1 })])]);
        expect(far.reconstructed.map((r) => r.link)).toEqual(['entry', 'entry']);
    });

    it('sources in one zone: another estimate is another message; sources in two zones: a zone offset apart is fine', () =>
    {
        const links = (offsetB: number, estB: number): string[] =>
        {
            const b = make({ from: [BOB], date: { utcMs: T0 + 6 * HOUR, original: '', offsetMinutes: offsetB, zoneKnown: true }, bodyText: TEXT_B });
            return linkRebuilt([src(0, quoter(0), [rb(TEXT_A)]), src(1, b, [rb(TEXT_A, { est: estB })])]).reconstructed.map((r) => r.link);
        };
        expect(links(0, T0 + 5 * HOUR)).toEqual(['entry', 'entry']);
        expect(links(0, T0)).toEqual(['entry', 'same-as']);
        expect(links(-300, T0 + 5 * HOUR)).toEqual(['entry', 'same-as']);
        expect(links(-300, T0 + 5 * HOUR + 7 * 60_000)).toEqual(['entry', 'entry']);
    });

    it('short copies merge only when their dates agree exactly', () =>
    {
        const short = 'OK, thanks.\n';
        const b = make({ from: [BOB], date: { utcMs: T0 + 6 * HOUR, original: '', offsetMinutes: -300, zoneKnown: true }, bodyText: TEXT_B });
        expect(linkRebuilt([src(0, quoter(0), [rb(short)]), src(1, quoter(1), [rb(short)])]).reconstructed.map((r) => r.link)).toEqual(['entry', 'same-as']);
        expect(linkRebuilt([src(0, quoter(0), [rb(short)]), src(1, b, [rb(short, { est: T0 + 5 * HOUR })])]).reconstructed.map((r) => r.link)).toEqual(['entry', 'entry']);
    });

    it('copies without a readable date: a date text with a year and a day, sources within 26 h, the strict text rule', () =>
    {
        const links = (dateText: string, text: string, sourceGap: number): string[] =>
        {
            const b = make({ from: [BOB], date: dated(T0 + 5 * HOUR + sourceGap), bodyText: TEXT_B });
            return linkRebuilt([src(0, quoter(0), [rb(text, { est: null, dateText })]), src(1, b, [rb(text, { est: null, dateText })])]).reconstructed.map((r) => r.link);
        };
        expect(links('04/03/2025 05:21', TEXT_A, 20 * HOUR)).toEqual(['entry', 'same-as']);
        expect(links('04/03/2025 05:21', TEXT_A, 27 * HOUR)).toEqual(['entry', 'entry']);
        expect(links('yesterday', TEXT_A, HOUR)).toEqual(['entry', 'entry']);
        expect(links('04/03/2025 05:21', 'OK, thanks.', HOUR)).toEqual(['entry', 'entry']);
    });
});

// ------------------------------------------------------------------ timeline

describe('linkRebuilt: timeline', () =>
{
    it('places rebuilt entries by their date among the real messages; a tie puts the rebuilt one first', () =>
    {
        const early = make({ date: dated(T0) });
        const late = make({ from: [BOB], date: dated(T0 + 10 * HOUR), bodyText: TEXT_B });
        const out = linkRebuilt([src(0, early), src(1, late, [rb(TEXT_C, { est: T0 + 4 * HOUR }), rb('Other words entirely here.', { est: T0, generation: 2 })])]);
        expect(labels(out.timeline)).toEqual(['r1', 'm0', 'r0', 'm1']);
        expect(out.timeline.filter((e) => e.kind === 'rebuilt').map((e) => e.kind === 'rebuilt' && e.placement)).toEqual(['by-date', 'by-date']);
    });

    it('caps a rebuilt message at its quoter: never after the email that quotes it', () =>
    {
        const quoter = make({ from: [BOB], date: dated(T0), bodyText: TEXT_B });
        const after = make({ date: dated(T0 + HOUR), bodyText: TEXT_C });
        const out = linkRebuilt([src(0, quoter, [rb(TEXT_A, { est: T0 + 5 * HOUR })]), src(1, after)]);
        expect(labels(out.timeline)).toEqual(['r0', 'm0', 'm1']);
        expect(out.timeline[0]).toEqual({ kind: 'rebuilt', id: 0, placement: 'capped-by-quoter' });
    });

    it('keeps the chain order: an older generation never after a newer one', () =>
    {
        const quoter = make({ from: [BOB], date: dated(T0 + 20 * HOUR), bodyText: TEXT_B });
        const out = linkRebuilt([src(0, quoter, [rb(TEXT_A, { est: T0 }), rb(TEXT_C, { est: T0 + 5 * HOUR, generation: 2 })])]);
        expect(labels(out.timeline)).toEqual(['r1', 'r0', 'm0']);
        expect(out.timeline[0]).toEqual({ kind: 'rebuilt', id: 1, placement: 'capped-by-quoter' });
    });

    it('raises a rebuilt message to the real message it quotes (an older generation linked to a real file)', () =>
    {
        const first = make({ date: dated(T0 + 4 * HOUR), bodyText: TEXT_A });
        const other = make({ from: [CAROL], date: dated(T0 + 2 * HOUR), bodyText: 'Unrelated note from Carol.' });
        const last = make({ date: dated(T0 + 9 * HOUR), bodyText: TEXT_C });
        // last quotes Bob's reply (estimated too early, at T0), which quotes `first`.
        const out = linkRebuilt([src(0, other), src(1, first), src(2, last, [rb(TEXT_B, { from: [BOB], est: T0 }), rb(TEXT_A, { est: T0 + 4 * HOUR, generation: 2 })])]);
        expect(out.reconstructed.map((r) => r.link)).toEqual(['entry', 'real']);
        expect(labels(out.timeline)).toEqual(['m0', 'm1', 'r0', 'm2']);
        expect(out.timeline[2]).toEqual({ kind: 'rebuilt', id: 0, placement: 'after-quoted' });
    });

    it('places a rebuilt message with no readable date just before its quoter, older first', () =>
    {
        const quoter = make({ from: [BOB], date: dated(T0 + 20 * HOUR), bodyText: TEXT_B });
        const before = make({ from: [CAROL], date: dated(T0 + 19 * HOUR), bodyText: 'Unrelated note from Carol.' });
        const out = linkRebuilt([
            src(0, before),
            src(1, quoter, [rb(TEXT_A, { est: null }), rb(TEXT_C, { est: null, generation: 2 }), rb('Very first words.', { est: T0, generation: 3 })]),
        ]);
        expect(labels(out.timeline)).toEqual(['r2', 'm0', 'r1', 'r0', 'm1']);
        expect(out.timeline[2]).toEqual({ kind: 'rebuilt', id: 1, placement: 'before-quoter' });
    });

    it('an undated rebuilt message whose quoter is linked to a real file goes just before that real message', () =>
    {
        const real = make({ from: [BOB], date: dated(T0 + 5 * HOUR), bodyText: TEXT_B });
        const middle = make({ from: [CAROL], date: dated(T0 + 3 * HOUR), bodyText: 'Unrelated note from Carol.' });
        const last = make({ date: dated(T0 + 9 * HOUR), bodyText: TEXT_C });
        const out = linkRebuilt([src(0, middle), src(1, real), src(2, last, [rb(TEXT_B, { from: [BOB], est: T0 + 5 * HOUR }), rb(TEXT_A, { est: null, generation: 2 })])]);
        expect(out.reconstructed.map((r) => r.link)).toEqual(['real', 'entry']);
        expect(labels(out.timeline)).toEqual(['m0', 'r1', 'm1', 'm2']);
    });

    it('undated real messages stay last, in their order; rebuilt entries of an undated email go before it', () =>
    {
        const dates = make({ date: dated(T0) });
        const undatedA = make({ from: [BOB], date: dated(null), bodyText: TEXT_B });
        const undatedB = make({ from: [CAROL], date: dated(null), bodyText: 'Unrelated note from Carol.' });
        const out = linkRebuilt([
            src(0, dates),
            { ...src(1, undatedA, [rb(TEXT_C, { est: T0 + HOUR })]), utcMs: null },
            { ...src(2, undatedB, [rb('Undated quote words.', { est: null, from: [BOB] })]), utcMs: null },
        ]);
        expect(labels(out.timeline)).toEqual(['m0', 'r0', 'm1', 'r1', 'm2']);
    });

    it('every real message stays in the timeline, once and in order, with or without rebuilt messages', () =>
    {
        expect(linkRebuilt([])).toEqual({ reconstructed: [], timeline: [] });
        const out = linkRebuilt([src(0, make({ date: dated(T0 + HOUR) })), src(1, make({ date: dated(T0 + 2 * HOUR), bodyText: TEXT_C }), [rb(TEXT_A)])]);
        expect(labels(out.timeline).filter((l) => l.startsWith('m'))).toEqual(['m0', 'm1']);
    });

    it('does not modify its input, and its result survives a structured clone', () =>
    {
        const sources = [src(0, make()), src(1, make({ from: [BOB], date: dated(T0 + HOUR), bodyText: TEXT_B }), [rb(TEXT_A), rb(TEXT_C, { est: null, generation: 2 })])];
        const before = JSON.stringify(sources);
        const out = linkRebuilt(sources);
        expect(JSON.stringify(sources)).toBe(before);
        expect(structuredClone(out)).toEqual(out);
    });
});
