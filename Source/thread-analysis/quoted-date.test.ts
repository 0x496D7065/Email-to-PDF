// Tests for the quote header date reader (milestone 7, task 7.2; README.md,
// rule R7). Synthetic dates only. The round-trip tests read back every date
// form the ground-truth builder (Helper/Test/test-support/thread-builder.ts) writes.
//
// Non-ASCII letters are written as \u escapes so this file stays ASCII:
// \u00e0 = a grave, \u00e9 = e acute, \u00fb = u circumflex,
// \u00a0 = no-break space, \u202f = narrow no-break space.

import { describe, expect, it } from 'vitest';
import { formatQuotedDate, QUOTE_STYLES, type Zone } from '../../Helper/Test/test-support/thread-builder';
import { THREAD_CASES } from '../../Helper/Test/test-support/thread-cases';
import { DATE_LANGUAGES } from './date-words';
import { hasWrittenZone, MAX_QUOTED_DATE_LENGTH, parseQuotedDate, type QuotedDate } from './quoted-date';

/** Milliseconds of a UTC calendar time (month 1-12). */
const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number => Date.UTC(y, mo - 1, d, h, mi, s);
const HOUR = 3_600_000;

/** The wall time read, as an ISO string (or null). */
function wall(text: string): string | null
{
    const q = parseQuotedDate(text, null);
    return q.wallMs === null ? null : new Date(q.wallMs).toISOString();
}

function expectUnreadable(q: QuotedDate): void
{
    expect(q.wallMs).toBeNull();
    expect(q.precision).toBeNull();
    expect(q.estimatedUtcMs).toBeNull();
    expect(q.basis).toBe('none');
}

describe('parseQuotedDate: RFC 5322 dates with a zone (exact)', () =>
{
    it('reads a forward-block date and ignores the source offset', () =>
    {
        const q = parseQuotedDate('Mon, 3 Mar 2025 14:02:00 +0900', -300);
        expect(q).toEqual({
            text: 'Mon, 3 Mar 2025 14:02:00 +0900',
            wallMs: utc(2025, 3, 3, 14, 2),
            precision: 'minute',
            estimatedUtcMs: utc(2025, 3, 3, 5, 2),
            basis: 'rfc-zone',
        });
        expect(hasWrittenZone(q)).toBe(true);
    });

    it('keeps seconds, negative zones, comments and named zones', () =>
    {
        expect(parseQuotedDate('Tue, 4 Mar 2025 09:00:42 -0500 (EST)', null).estimatedUtcMs).toBe(utc(2025, 3, 4, 14, 0, 42));
        expect(parseQuotedDate('4 Mar 2025 09:00 GMT', 120)).toMatchObject({ estimatedUtcMs: utc(2025, 3, 4, 9), basis: 'rfc-zone' });
        expect(parseQuotedDate('4 Mar 2025 09:00 EST', null)).toMatchObject({ estimatedUtcMs: utc(2025, 3, 4, 14), basis: 'rfc-zone' });
    });

    it('crosses the day and the year with the written zone', () =>
    {
        expect(parseQuotedDate('Thu, 1 Jan 2026 05:00:00 +0900', null).estimatedUtcMs).toBe(utc(2025, 12, 31, 20));
        expect(parseQuotedDate('Wed, 31 Dec 2025 20:00:00 -1100', null).estimatedUtcMs).toBe(utc(2026, 1, 1, 7));
    });

    it('refuses a weekday that does not match the date', () =>
    {
        expectUnreadable(parseQuotedDate('Tue, 3 Mar 2025 14:02:00 +0900', 0));
    });

    it('accepts a localized weekday before an RFC date ("mar.," is Tuesday)', () =>
    {
        expect(parseQuotedDate('mar., 4 Mar 2025 14:02:00 +0100', null)).toMatchObject({ basis: 'rfc-zone', estimatedUtcMs: utc(2025, 3, 4, 13, 2) });
        expectUnreadable(parseQuotedDate('mar., 3 Mar 2025 14:02:00 +0100', null));
    });

    it('reads "-0000" as UTC with the local zone unknown (approximate, source offset not used)', () =>
    {
        for (const source of [60, -300, null])
        {
            const q = parseQuotedDate('Mon, 3 Mar 2025 14:02 -0000', source);
            expect(q).toEqual({ text: 'Mon, 3 Mar 2025 14:02 -0000', wallMs: utc(2025, 3, 3, 14, 2), precision: 'minute', estimatedUtcMs: utc(2025, 3, 3, 14, 2), basis: 'none' });
            expect(hasWrittenZone(q)).toBe(false);
        }
        expect(parseQuotedDate('3 Mar 2025 14:02 -0000 (unknown zone)', 60)).toMatchObject({ estimatedUtcMs: utc(2025, 3, 3, 14, 2), basis: 'none' });
        expectUnreadable(parseQuotedDate('Tue, 3 Mar 2025 14:02 -0000', 60)); // wrong weekday
        // After a zone name, parseEmailDate ignores "-0000" and trusts the name.
        expect(parseQuotedDate('3 Mar 2025 14:02 GMT -0000', 60)).toMatchObject({ estimatedUtcMs: utc(2025, 3, 3, 14, 2), basis: 'rfc-zone' });
    });

    it('reads "-0000" in other forms the same way', () =>
    {
        expect(parseQuotedDate('3 March 2025 at 14:02 -0000', 60)).toMatchObject({ wallMs: utc(2025, 3, 3, 14, 2), estimatedUtcMs: utc(2025, 3, 3, 14, 2), basis: 'none' });
        expect(parseQuotedDate('lundi 3 mars 2025 14:02 -00:00', -300)).toMatchObject({ estimatedUtcMs: utc(2025, 3, 3, 14, 2), basis: 'none' });
        expect(parseQuotedDate('3 Mar 2025 2:02 PM -0000', 60)).toMatchObject({ estimatedUtcMs: utc(2025, 3, 3, 14, 2), basis: 'none' });
        // "+0000" is a real zone (UTC): exact.
        expect(parseQuotedDate('3 March 2025 at 14:02 +0000', 60)).toMatchObject({ estimatedUtcMs: utc(2025, 3, 3, 14, 2), basis: 'written-zone' });
        expect(parseQuotedDate('3 Mar 2025 14:02 +0000', 60)).toMatchObject({ estimatedUtcMs: utc(2025, 3, 3, 14, 2), basis: 'rfc-zone' });
    });

    it('refuses every one-letter zone except "Z" (military zones are not read; a lone letter may be a cut AM/PM)', () =>
    {
        for (const letter of ['B', 'm', 'N', 'y', 'h', 'M'])
        {
            expectUnreadable(parseQuotedDate(`Mon, 3 Mar 2025 14:02 ${letter}`, 60));
        }
        expect(parseQuotedDate('3 Mar 2025 14:02 Z', 60)).toMatchObject({ estimatedUtcMs: utc(2025, 3, 3, 14, 2), basis: 'rfc-zone' });
        for (const text of ['3 Mar 2025 2:02 p', '3 Mar 2025 2:02 P', '3 Mar 2025 2:02 a', '3 Mar 2025 2:02 j', '3 March 2025 at 14:02 B', '3 Mar 2025 14:02 B +0100'])
        {
            expectUnreadable(parseQuotedDate(text, 60));
        }
    });

    it.each([
        '3 Mar 2025 2:02 (P)M',
        '3 Mar 2025 2:02 (P) M',
        '3 Mar 2025 2:02 (p)m',
        '3 Mar 2025 2:02 (P.)M',
        '3 Mar 2025 2:02 (A)M',
        'Mon, 3 Mar 2025 2:02 (P)M',
        '3 Mar 2025 2:02 m',
        '3 Mar 2025 14:02 h',
        '3 Mar 2025 14:02 B',
    ])('refuses %j (a lone letter left by a comment or a one-letter zone)', (text) =>
    {
        expectUnreadable(parseQuotedDate(text, 60));
        expectUnreadable(parseQuotedDate(text, null));
    });

    it.each(['3 Mar 2025 2:02 (2:02pm)', '3 Mar 2025 2:02 (2pm)', 'Mon, 3 Mar 2025 2:02 +0100 (2 p.m.)'])(
        'refuses %j (an AM/PM word after a digit in a comment)',
        (text) =>
        {
            expectUnreadable(parseQuotedDate(text, 60));
        },
    );

    it('refuses other unknown zone names (real zones of unknown offset)', () =>
    {
        expectUnreadable(parseQuotedDate('3 Mar 2025 14:02 CET', 60));
        expectUnreadable(parseQuotedDate('3 Mar 2025 14:02 JST', 60));
    });

    it('refuses three-digit years (RFC 5322: 049 is 1949, parseEmailDate says 2049)', () =>
    {
        for (const text of ['3 Mar 049 14:02 +0100', 'Mon, 3 Mar 125 14:02 +0100', '3 Mar 125 14:02 +0100', '3 Mar 999 14:02 GMT +0100', '3 Mar 049 14:02 -0000', '3 Mar 049 14:02', '3 mars 049 14:02', '3 March 125 at 14:02 GMT+1'])
        {
            expectUnreadable(parseQuotedDate(text, 60));
        }
    });

    it('keeps reading two- and four-digit RFC years', () =>
    {
        expect(parseQuotedDate('Mon, 3 Mar 25 14:02 +0100', null)).toMatchObject({ estimatedUtcMs: utc(2025, 3, 3, 13, 2), basis: 'rfc-zone' });
        expect(parseQuotedDate('Wed, 3 Mar 99 14:02 +0100', null)).toMatchObject({ estimatedUtcMs: utc(1999, 3, 3, 13, 2), basis: 'rfc-zone' });
    });

    // A comment is dropped when reading; an AM/PM word in it would be lost.
    it.each([
        'Mon, 3 Mar 2025 2:02 +0100 (PM)',
        'Mon, 3 Mar 2025 2:02 +0100 (p.m.)',
        'Mon, 3 Mar 2025 2:02 +0100 (p. m.)',
        'Mon, 3 Mar 2025 2:02 (pm) +0100',
        'Mon, 3 Mar 2025 2:02 +0100 (CET, a.m.)',
        'Mon, 3 Mar 2025 2:02 +0100 ((am))',
        'Mon, 3 Mar 2025 2:02 -0000 (PM)',
        '3 March 2025 at 2:02 (PM)',
        '3 March 2025 at 2:02 (p. m.)',
        '3 March 2025 at 2:02 (P.M)',
        '3 mars 2025 \u00e0 2:02 (a m)',
        'lundi 3 mars 2025 2:02(pm)',
        'ma 3 mrt 2025 om 2:02 (pm.)',
    ])('refuses %j (AM/PM word in a comment)', (text) =>
    {
        expectUnreadable(parseQuotedDate(text, 0));
    });

    it('still ignores comments without an AM/PM word', () =>
    {
        expect(parseQuotedDate('Mon, 3 Mar 2025 14:02 +0100 (Amsterdam)', null)).toMatchObject({ estimatedUtcMs: utc(2025, 3, 3, 13, 2), basis: 'rfc-zone' });
        expect(parseQuotedDate('3 March 2025 at 14:02 (map, camp, 12pmx)', 0)).toMatchObject({ wallMs: utc(2025, 3, 3, 14, 2), basis: 'source-offset' });
    });

    it('does not take AM/PM for a zone (2:02 PM is 14:02)', () =>
    {
        expect(parseQuotedDate('3 Mar 2025 2:02 PM +0900', null)).toMatchObject({ wallMs: utc(2025, 3, 3, 14, 2), basis: 'written-zone', estimatedUtcMs: utc(2025, 3, 3, 5, 2) });
        // Without a zone, parseEmailDate would read 02:02 with an unknown zone.
        expect(parseQuotedDate('3 Mar 2025 2:02 PM', 0)).toMatchObject({ wallMs: utc(2025, 3, 3, 14, 2), basis: 'source-offset' });
    });

    // parseEmailDate reads only its first words and takes any word before a
    // comma for a weekday: its result must not be used when the text has more.
    // None of these is read by step 2 either (unknown or misplaced words).
    it.each([
        'Mon, 3 Mar 2025 2:02 +0100 p. m.', // 14:02 meant, parseEmailDate reads 02:02
        'Mon, 3 Mar 2025 2:02 +0100 pm.',
        'Mon, 3 Mar 2025 14:02 +0100 2026',
        'Mon, 3 Mar 2025 14:02 +0100 foo bar',
        '3 Mar 2025 14:02 +0100 Tue',
        '3 Mar 2025 14:02 GMT +0900 junk',
        'Foo, 3 Mar 2025 14:02 +0100',
        'Yesterday, 3 Mar 2025 14:02 +0100',
        '3 Mar 2025 2:02 p +0100', // a one-letter "zone" could be a meridiem
        'Mon, 3 Mar 2025 14:02 +0100 (unclosed',
    ])('refuses %j (words beyond the RFC fields)', (text) =>
    {
        expectUnreadable(parseQuotedDate(text, 0));
    });

    it('still reads a zone name followed by an offset, and a weekday without a comma', () =>
    {
        expect(parseQuotedDate('3 Mar 2025 14:02 GMT +0900', null)).toMatchObject({ basis: 'rfc-zone', estimatedUtcMs: utc(2025, 3, 3, 5, 2) });
        expect(parseQuotedDate('Mon 3 Mar 2025 14:02 JST +0900', null)).toMatchObject({ basis: 'rfc-zone', estimatedUtcMs: utc(2025, 3, 3, 5, 2) });
        expect(parseQuotedDate('3 Mar 2025 14:02 PST -0800', null)).toMatchObject({ basis: 'rfc-zone', estimatedUtcMs: utc(2025, 3, 3, 22, 2) });
        expect(parseQuotedDate('3 Mar 2025 14:02 (CET) +0100', null)).toMatchObject({ basis: 'rfc-zone', estimatedUtcMs: utc(2025, 3, 3, 13, 2) });
        expect(parseQuotedDate('3 Mar 2025 14:02 AEST +1000', null)).toMatchObject({ basis: 'rfc-zone', estimatedUtcMs: utc(2025, 3, 3, 4, 2) });
        expect(parseQuotedDate('lun., 3 Mar 2025 14:02 +0100', null)).toMatchObject({ basis: 'rfc-zone', estimatedUtcMs: utc(2025, 3, 3, 13, 2) });
    });

    // parseEmailDate takes any word before an offset for a zone name: only
    // 2-5 letters that are not a month, weekday, connector or AM/PM word.
    it.each([
        '3 Mar 2025 14:02 Mon +0100',
        '3 Mar 2025 14:02 at +0100',
        '3 Mar 2025 14:02 uur +0100',
        '3 Mar 2025 14:02 om +0100',
        '3 Mar 2025 14:02 mars +0100',
        '3 Mar 2025 14:02 dec +0100',
        '3 Mar 2025 14:02 lundi +0100',
        '3 Mar 2025 14:02 zondag +0100',
        '3 Mar 2025 14:02 pm +0100',
        '3 Mar 2025 14:02 central +0100',
        '3 Mar 2025 14:02 jst +0900', // zone names are written in capitals
    ])('refuses %j (not a zone name before the offset)', (text) =>
    {
        expectUnreadable(parseQuotedDate(text, 0));
    });

    it('reads a lower-case "gmt +0900" as a written zone (step 2), not through the RFC gate', () =>
    {
        expect(parseQuotedDate('3 Mar 2025 14:02 gmt +0900', null)).toMatchObject({ basis: 'written-zone', estimatedUtcMs: utc(2025, 3, 3, 5, 2) });
    });

    it('refuses an RFC date after 2100', () =>
    {
        expectUnreadable(parseQuotedDate('3 Mar 9999 14:02 +0100', 0));
    });

    it('reads an RFC date without a zone as a wall time (approximate)', () =>
    {
        expect(parseQuotedDate('Mon, 3 Mar 2025 14:02:00', 330)).toMatchObject({ wallMs: utc(2025, 3, 3, 14, 2), basis: 'source-offset', estimatedUtcMs: utc(2025, 3, 3, 8, 32) });
    });
});

describe('parseQuotedDate: written zones in other forms (exact)', () =>
{
    it.each([
        ['3 March 2025 at 14:02:00 GMT+9', 540],
        ['3 March 2025 at 14:02:00 GMT-11', -660],
        ['3 March 2025 at 14:02:00 GMT+5:45', 345],
        ['3 March 2025 at 14:02 UTC+05:30', 330],
        ['3 March 2025 at 14:02 UTC+0530', 330],
        ['3 March 2025 at 14:02 GMT +2', 120],
        ['3 March 2025 at 14:02 GMT  +9', 540],
        ['3 March 2025 at 14:02 GMT\u00a0+9', 540],
        ['3 March 2025 at 14:02 GMT\u202f+9', 540],
        ['3 March 2025 at 14:02 UTC \t -5:30', -330],
        ['3 March 2025 at 14:02 GMT', 0],
        ['3 March 2025 at 14:02 UTC', 0],
        ['lundi 3 mars 2025 14:02 +0100', 60],
        ['maandag 3 maart 2025 14:02 -03:00', -180],
    ] as const)('%s', (text, offset) =>
    {
        const q = parseQuotedDate(text, 999);
        expect(q.wallMs).toBe(utc(2025, 3, 3, 14, 2));
        expect(q.estimatedUtcMs).toBe(utc(2025, 3, 3, 14, 2) - offset * 60_000);
        expect(q.basis).toBe('written-zone');
        expect(hasWrittenZone(q)).toBe(true);
    });

    it('refuses out-of-range or repeated zones', () =>
    {
        expectUnreadable(parseQuotedDate('3 March 2025 at 14:02 GMT+25', 0));
        expectUnreadable(parseQuotedDate('3 March 2025 at 14:02 +0960', 0));
        expectUnreadable(parseQuotedDate('3 March 2025 at 14:02 GMT+1 GMT+2', 0));
    });

    it('refuses a 3-digit offset after a zone name (not +01:23 or +09:00)', () =>
    {
        expectUnreadable(parseQuotedDate('3 March 2025 at 14:02 GMT+123', 0));
        expectUnreadable(parseQuotedDate('3 March 2025 at 14:02 GMT+900', 0));
        expectUnreadable(parseQuotedDate('3 March 2025 at 14:02 GMT+5:4', 0));
        expectUnreadable(parseQuotedDate('3 March 2025 at 14:02 UTC+05:60', 0));
    });

    it('refuses a zone or a time out of order', () =>
    {
        expectUnreadable(parseQuotedDate('+0900 3 March 2025 14:02', 0));
        expectUnreadable(parseQuotedDate('3 March 2025 +0900 14:02', 0));
        expectUnreadable(parseQuotedDate('3 March 2025 GMT+9', 0)); // zone without a time
        expectUnreadable(parseQuotedDate('2:02 PM 3 March 2025', 0));
        expectUnreadable(parseQuotedDate('3 March 14:02 2025', 0));
        expectUnreadable(parseQuotedDate('2025 3 March', 0));
        expectUnreadable(parseQuotedDate('3 2025 March', 0));
        expectUnreadable(parseQuotedDate('3 March 2025 14:02 at', 0));
        expectUnreadable(parseQuotedDate('3 March at 2025 14:02', 0));
        expectUnreadable(parseQuotedDate('3 March 2025 at at 14:02', 0));
        expectUnreadable(parseQuotedDate('3 March 2025 2:02 +0100 PM', 0));
    });

    it('ignores a zone in (parentheses), like an RFC comment', () =>
    {
        expect(parseQuotedDate('Monday, March 3, 2025 2:02 PM (UTC+01:00)', 0).basis).toBe('source-offset');
    });
});

describe('parseQuotedDate: month and weekday names', () =>
{
    // Every month word of every language, in "day word year" and "word day, year" orders.
    const monthCases = DATE_LANGUAGES.flatMap((lang) => lang.months.flatMap((words, index) => words.map((word) => [lang.code, word, index] as const)));
    it.each(monthCases)('%s month "%s" is month %i (0-based)', (_code, word, index) =>
    {
        const expected = new Date(utc(2024, index + 1, 9, 14, 2)).toISOString();
        expect(wall(`9 ${word} 2024 14:02`)).toBe(expected);
        expect(wall(`9 ${word}. 2024 14:02`)).toBe(expected);
        expect(wall(`${word.toUpperCase()} 9, 2024 14:02`)).toBe(expected);
    });

    // 2025-03-02 is a Sunday, so 2 + w March 2025 has weekday w (0 = Sunday).
    const weekdayCases = DATE_LANGUAGES.flatMap((lang) => lang.weekdays.flatMap((words, index) => words.map((word) => [lang.code, word, index] as const)));
    it.each(weekdayCases)('%s weekday "%s" (%i) matches its date and only that one', (_code, word, index) =>
    {
        const ok = new Date(utc(2025, 3, 2 + index)).toISOString();
        expect(wall(`${word} ${2 + index} mars 2025`)).toBe(ok);
        expect(wall(`${word}., ${2 + index} maart 2025`)).toBe(ok);
        expect(wall(`${word} ${3 + index} mars 2025`)).toBeNull();
    });

    it('takes "mar" as Tuesday only when a month follows, else as March', () =>
    {
        expect(wall('mar. 4 mars 2025 \u00e0 13:05')).toBe('2025-03-04T13:05:00.000Z');
        expect(wall('mar 4 mars 2025')).toBe('2025-03-04T00:00:00.000Z');
        expect(wall('Mar 4, 2025')).toBe('2025-03-04T00:00:00.000Z');
        expect(wall('mar. 3 mars 2025')).toBeNull(); // 3 March 2025 is a Monday
    });

    it('reads accented months with and without their accent', () =>
    {
        expect(wall('14 f\u00e9vrier 2025 \u00e0 10:30')).toBe('2025-02-14T10:30:00.000Z');
        expect(wall('14 fevrier 2025 a 10:30')).toBe('2025-02-14T10:30:00.000Z');
        expect(wall('15 ao\u00fbt 2025')).toBe('2025-08-15T00:00:00.000Z');
        expect(wall('15 aout 2025')).toBe('2025-08-15T00:00:00.000Z');
        expect(wall('31 d\u00e9c. 2025 23:59')).toBe('2025-12-31T23:59:00.000Z');
        // Decomposed accent (e + combining acute) is normalized to NFC first.
        expect(wall('14 fe\u0301vrier 2025')).toBe('2025-02-14T00:00:00.000Z');
    });

    it('reads Dutch abbreviations with and without a period', () =>
    {
        expect(wall('ma 3 mrt 2025 om 14:02')).toBe('2025-03-03T14:02:00.000Z');
        expect(wall('3 mrt. 2025 om 14:02')).toBe('2025-03-03T14:02:00.000Z');
        expect(wall('za 3 mei 2025')).toBe('2025-05-03T00:00:00.000Z');
        expect(wall('vr 3 okt. 2025 om 09:15')).toBe('2025-10-03T09:15:00.000Z');
    });

    it('reads ordinal days and odd spacing', () =>
    {
        expect(wall('March 3rd, 2025 at 9:15 AM')).toBe('2025-03-03T09:15:00.000Z');
        expect(wall('samedi 1er mars 2025')).toBe('2025-03-01T00:00:00.000Z');
        expect(wall('  Mon,\u00a0Mar 3,  2025\tat 2:02\u202fPM ')).toBe('2025-03-03T14:02:00.000Z');
    });

    it.each([
        [1, 'st'], [2, 'nd'], [3, 'rd'], [4, 'th'], [11, 'th'], [12, 'th'], [13, 'th'],
        [21, 'st'], [22, 'nd'], [23, 'rd'], [24, 'th'], [30, 'th'], [31, 'st'],
    ] as const)('reads day %i with suffix "%s"', (day, suffix) =>
    {
        expect(wall(`${day}${suffix} January 2025`)).toBe(new Date(utc(2025, 1, day)).toISOString());
    });

    it.each(['2er janv. 2025', '3th March 2025', '1th March 2025', '11st March 2025', '12nd March 2025', '13rd March 2025', '21th March 2025', '22rd March 2025', '4rd March 2025'])(
        'refuses a suffix that does not fit its day: %j',
        (text) =>
        {
            expectUnreadable(parseQuotedDate(text, 0));
        },
    );

    it('has no word naming two different months or two different weekdays', () =>
    {
        for (const key of ['months', 'weekdays'] as const)
        {
            const seen = new Map<string, number>();
            for (const lang of DATE_LANGUAGES)
            {
                lang[key].forEach((words, index) =>
                {
                    for (const word of words)
                    {
                        expect(seen.get(word) ?? index, `${key}: ${word}`).toBe(index);
                        seen.set(word, index);
                        expect(word).toBe(word.toLowerCase().normalize('NFC'));
                        expect(word.endsWith('.')).toBe(false);
                    }
                });
            }
        }
    });
});

describe('parseQuotedDate: clocks', () =>
{
    it.each([
        ['Monday, March 3, 2025 12:05 AM', '2025-03-03T00:05:00.000Z'],
        ['Monday, March 3, 2025 12:30 PM', '2025-03-03T12:30:00.000Z'],
        ['Monday, March 3, 2025 1:00 PM', '2025-03-03T13:00:00.000Z'],
        ['Monday, March 3, 2025 11:59 PM', '2025-03-03T23:59:00.000Z'],
        ['Mon, Mar 3, 2025 at 2:02pm', '2025-03-03T14:02:00.000Z'],
        ['Mon, Mar 3, 2025 at 2:02 p.m.', '2025-03-03T14:02:00.000Z'],
        ['Mon, Mar 3, 2025 at 9:02 a.m.', '2025-03-03T09:02:00.000Z'],
        ['lundi 3 mars 2025 00:00', '2025-03-03T00:00:00.000Z'],
        ['lundi 3 mars 2025 23:59', '2025-03-03T23:59:00.000Z'],
        ['3 March 2025 at 14:02:59', '2025-03-03T14:02:59.000Z'],
    ])('%s', (text, iso) =>
    {
        expect(wall(text)).toBe(iso);
        expect(parseQuotedDate(text, 0).precision).toBe('minute');
    });

    it.each([
        'Monday, March 3, 2025 13:00 PM',
        'Monday, March 3, 2025 0:30 AM',
        'Monday, March 3, 2025 PM 2:00',
        'Monday, March 3, 2025 2:00 PM PM',
        'lundi 3 mars 2025 24:00',
        'lundi 3 mars 2025 14:60',
        'lundi 3 mars 2025 14:02:60',
        'lundi 3 mars 2025 14:02 15:00',
    ])('refuses %s', (text) =>
    {
        expectUnreadable(parseQuotedDate(text, 0));
    });
});

describe('parseQuotedDate: day-only dates', () =>
{
    it.each(['3 mars 2025', 'lundi 3 mars 2025', 'March 3, 2025', 'ma 3 mrt. 2025', '2025-03-03', '03/03/2025'])('%s', (text) =>
    {
        expect(parseQuotedDate(text, 60)).toMatchObject({ wallMs: utc(2025, 3, 3), precision: 'day', estimatedUtcMs: utc(2025, 3, 2, 23), basis: 'source-offset' });
    });
});

describe('parseQuotedDate: numeric dates (read only when unambiguous)', () =>
{
    it.each([
        ['2025-03-04 14:02', '2025-03-04T14:02:00.000Z'],
        ['2025/12/31', '2025-12-31T00:00:00.000Z'],
        ['2025.1.9', '2025-01-09T00:00:00.000Z'],
        ['31/12/2025 23:00', '2025-12-31T23:00:00.000Z'],
        ['12/31/2025 11:00 PM', '2025-12-31T23:00:00.000Z'],
        ['13.03.2025', '2025-03-13T00:00:00.000Z'],
        ['3-13-2025', '2025-03-13T00:00:00.000Z'],
        ['03/03/2025 14:02', '2025-03-03T14:02:00.000Z'],
        ['Mon 03/03/2025', '2025-03-03T00:00:00.000Z'],
    ])('%s', (text, iso) =>
    {
        expect(wall(text)).toBe(iso);
    });

    it.each([
        '03/04/2025', // 3 April or 4 March?
        '12/11/2025 14:02',
        '1.2.2025',
        '3/3/25', // two-digit year: refused
        '13/03/25',
        '3/13/25 12:58 PM',
        '3 mars 25',
        '03/03-2025', // mixed separators
        '31/02/2025', // no 31 February
        '13/13/2025',
        '0/0/2025',
        '25/03/203',
        '2025-3',
        'Tue 03/03/2025', // wrong weekday
    ])('refuses %s', (text) =>
    {
        expectUnreadable(parseQuotedDate(text, 0));
    });
});

describe('parseQuotedDate: unreadable and inconsistent input', () =>
{
    it.each([
        '',
        '   ',
        'hello',
        'yesterday at 14:02',
        '3 Foo 2025',
        '3 mars',
        'mars 2025',
        '3 mars 2025 2026',
        '3 mars avril 2025',
        '32 mars 2025',
        '31 avril 2025',
        '29 Feb 2025',
        '3 mars 1899',
        '3 mars 9999',
        '3 mars 2101 14:02',
        '9999-03-03',
        'March 3, 2025 Monday', // weekday not first
        'Tuesday, March 3, 2025 2:02 PM', // 3 March 2025 is a Monday
        'dinsdag 3 maart 2025 om 14:02',
        'On Mon, Mar 3, 2025 at 2:02 PM', // the attribution opener is not part of the date
        '3 mars 2025 (unclosed comment 14:02',
    ])('refuses %j', (text) =>
    {
        expectUnreadable(parseQuotedDate(text, 0));
    });

    it('reads 29 February in a leap year', () =>
    {
        expect(wall('Thursday, February 29, 2024 8:00 AM')).toBe('2024-02-29T08:00:00.000Z');
    });

    it('keeps the text as given', () =>
    {
        expect(parseQuotedDate('  3 mars 2025 ', 0).text).toBe('  3 mars 2025 ');
        expect(parseQuotedDate('nonsense', 0).text).toBe('nonsense');
    });
});

describe('parseQuotedDate: estimate from the source offset', () =>
{
    it('subtracts a positive offset, crossing back into the previous day and year', () =>
    {
        expect(parseQuotedDate('1 Jan 2026 at 05:00', 540)).toMatchObject({ wallMs: utc(2026, 1, 1, 5), estimatedUtcMs: utc(2025, 12, 31, 20), basis: 'source-offset' });
    });

    it('adds a negative offset, crossing into the next day and year', () =>
    {
        expect(parseQuotedDate('mercredi 31 d\u00e9cembre 2025 20:00', -660)).toMatchObject({ estimatedUtcMs: utc(2026, 1, 1, 7), basis: 'source-offset' });
        expect(parseQuotedDate('31 december 2025', -300).estimatedUtcMs).toBe(utc(2025, 12, 31, 5));
    });

    it('handles fractional-hour offsets', () =>
    {
        expect(parseQuotedDate('3 mrt. 2025 om 14:02', 345).estimatedUtcMs).toBe(utc(2025, 3, 3, 8, 17));
    });

    it('takes the wall time as UTC when the source offset is unknown or not a sane number', () =>
    {
        for (const offset of [null, Number.NaN, Infinity, 1.5, 24 * 60, -24 * 60, 1e12] as const)
        {
            expect(parseQuotedDate('3 mars 2025 \u00e0 14:02', offset)).toMatchObject({ wallMs: utc(2025, 3, 3, 14, 2), estimatedUtcMs: utc(2025, 3, 3, 14, 2), basis: 'none' });
        }
        expect(hasWrittenZone(parseQuotedDate('3 mars 2025', null))).toBe(false);
    });

    it('accepts the extreme offsets +-23:59', () =>
    {
        expect(parseQuotedDate('3 mars 2025', 23 * 60 + 59).basis).toBe('source-offset');
        expect(parseQuotedDate('3 mars 2025', -(23 * 60 + 59)).basis).toBe('source-offset');
    });
});

describe('parseQuotedDate: robustness', () =>
{
    it('refuses input over the length bound without reading it', () =>
    {
        const long = `3 mars 2025 ${' '.repeat(MAX_QUOTED_DATE_LENGTH)}`;
        expectUnreadable(parseQuotedDate(long, 0));
        expect(parseQuotedDate(long, 0).text).toBe(long);
    });

    it('stays fast on long and adversarial strings', () =>
    {
        const inputs = [
            'a'.repeat(1_000_000),
            '1:'.repeat(99),
            '1/'.repeat(99),
            '('.repeat(199),
            ')'.repeat(199),
            'gmt+'.repeat(49),
            ' '.repeat(199),
            '9'.repeat(199),
            `${'1'.repeat(150)}:${'0'.repeat(48)}`,
            'mar. '.repeat(39),
            `${'3 mars 2025 '.repeat(16)}`,
            '\ud800'.repeat(199), // lone surrogates
            '\u0000'.repeat(199),
        ];
        const started = performance.now();
        for (let round = 0; round < 20; round++)
        {
            for (const text of inputs)
            {
                expectUnreadable(parseQuotedDate(text, 0));
            }
        }
        // Very generous bound (slow CI, parallel workers): the real guarantee is
        // MAX_QUOTED_DATE_LENGTH, which caps every regular expression's input at
        // 200 characters; this only catches a gross regression.
        expect(performance.now() - started).toBeLessThan(5000);
    });

    it('never throws on wrong types', () =>
    {
        expectUnreadable(parseQuotedDate(undefined as unknown as string, 0));
        expectUnreadable(parseQuotedDate(42 as unknown as string, 0));
        expect(parseQuotedDate('3 mars 2025', 'x' as unknown as number).basis).toBe('none');
    });
});

// ---------------------------------------------------------------------------
// Round trip against the ground-truth builder (Helper/Test/test-support/thread-builder.ts)

type DateFormat = Parameters<typeof formatQuotedDate>[0];
const FORMATS: readonly DateFormat[] = [
    'outlook-en',
    'outlook-fr',
    'outlook-nl',
    'gmail-en',
    'gmail-en-gb',
    'gmail-fr',
    'gmail-nl',
    'apple-en',
    'apple-fr',
    'apple-nl',
    'apple-forward-en',
    'thunderbird',
];

const ZONES: readonly Zone[] = [
    { name: 'Africa/Lagos', offsetMinutes: 60 },
    { name: 'Asia/Tokyo', offsetMinutes: 540 },
    { name: 'Asia/Kolkata', offsetMinutes: 330 },
    { name: 'Asia/Kathmandu', offsetMinutes: 345 },
    { name: 'Etc/UTC', offsetMinutes: 0 },
    { name: 'Pacific/Pago_Pago', offsetMinutes: -660 },
];

/** Instants over two years, stepping 37 h 13 min (every month, weekday and many hours), plus midnight and noon edges. */
const INSTANTS: readonly number[] = [
    ...Array.from({ length: 480 }, (_, k) => utc(2024, 12, 30, 0, 7) + k * (37 * HOUR + 13 * 60_000)),
    utc(2025, 2, 28, 23, 0),
    utc(2025, 12, 31, 23, 59),
    utc(2026, 1, 1, 0, 0),
    utc(2025, 3, 3, 12, 0),
    utc(2025, 3, 3, 0, 0),
];

/** Thunderbird writes dd/mm/yyyy: readable only when day > 12 or day = month. */
function thunderbirdReadable(text: string): boolean
{
    const [d = 0, m = 0] = text.split(/[/ ]/).map(Number);
    return d > 12 || d === m;
}

describe('parseQuotedDate: round trip of every builder date format', () =>
{
    it.each(FORMATS)('%s', (format) =>
    {
        let read = 0;
        for (const zone of ZONES)
        {
            for (const instant of INSTANTS)
            {
                const text = formatQuotedDate(format, instant, zone);
                const q = parseQuotedDate(text, zone.offsetMinutes);
                if (format === 'thunderbird' && !thunderbirdReadable(text))
                {
                    expect(q.wallMs, text).toBeNull();
                    continue;
                }
                read++;
                expect(q.wallMs, text).toBe(instant + zone.offsetMinutes * 60_000);
                expect(q.estimatedUtcMs, text).toBe(instant);
                expect(q.precision, text).toBe('minute');
                expect(q.basis, text).toBe(format === 'apple-forward-en' ? 'written-zone' : 'source-offset');
                // With the source offset unknown, a written zone still gives the exact moment.
                expect(parseQuotedDate(text, null).estimatedUtcMs, text).toBe(format === 'apple-forward-en' ? instant : instant + zone.offsetMinutes * 60_000);
            }
        }
        expect(read).toBeGreaterThan(format === 'thunderbird' ? 1000 : ZONES.length * INSTANTS.length - 1);
    });
});

describe('parseQuotedDate: round trip of every thread case header', () =>
{
    const headers = THREAD_CASES.flatMap((c) => c.thread.headers.map((h) => ({ id: c.id, group: c.group, h })));

    it.each(headers.map((x) => [x.id, x.h.index, x] as const))('%s, message %i', (_id, _index, { h }) =>
    {
        const q = parseQuotedDate(h.fields.date, h.shownIn.offsetMinutes);
        const thunderbird = h.style === 'thunderbird-en';
        if (thunderbird && !thunderbirdReadable(h.fields.date))
        {
            expectUnreadable(q);
            return;
        }
        expect(q.estimatedUtcMs, h.fields.date).toBe(Date.parse(h.instantUtc));
        expect(q.basis).toBe(h.style === 'apple-forward-en' ? 'written-zone' : 'source-offset');
    });

    it('covers every quote style of the builder', () =>
    {
        expect(new Set(headers.map((x) => x.h.style))).toEqual(new Set(QUOTE_STYLES));
    });

    it('reads every date of the "dates" group (February, August, 31 December into 1 January)', () =>
    {
        const dates = headers.filter((x) => x.group === 'dates');
        expect(dates.length).toBeGreaterThan(5);
        for (const { h } of dates)
        {
            const q = parseQuotedDate(h.fields.date, h.shownIn.offsetMinutes);
            expect(q.estimatedUtcMs, h.fields.date).toBe(Date.parse(h.instantUtc));
        }
    });
});
