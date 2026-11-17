// Tests for the date display helpers (README.md, rule R7). Synthetic dates only.
//
// Node ships its own copy of the time-zone and locale data, which can differ
// in wording from browsers. So the exact-string checks below are only on
// `text`, which the module builds itself from numeric parts; `localized` is
// only checked loosely.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    browserTimeZone,
    FALLBACK_ZONE,
    formatInZone,
    formatOffset,
    formatSenderLocal,
    isDisplayableMs,
    isValidTimeZone,
    MAX_DISPLAYABLE_MS,
    MIN_DISPLAYABLE_MS,
    listTimeZones,
    type ZonedDateTime,
} from './time-format';
import type { EmailDate } from '../../Header/parsed-email';

const T = (iso: string): number => Date.parse(iso);

/** The `text` of a formatted date, failing the test if there was none. */
function textOf(result: ZonedDateTime): string
{
    if (result.kind !== 'date')
    {
        throw new Error(`expected a date, got ${result.kind}`);
    }
    return result.text;
}

function date(fields: Partial<EmailDate>): EmailDate
{
    return { utcMs: T('2025-04-02T09:00:00Z'), original: 'synthetic', offsetMinutes: 120, zoneKnown: true, ...fields };
}

afterEach(() =>
{
    vi.restoreAllMocks();
});

describe('formatOffset', () =>
{
    it.each([
        [0, 'UTC+00:00'],
        [-0, 'UTC+00:00'],
        [120, 'UTC+02:00'],
        [-300, 'UTC-05:00'],
        [330, 'UTC+05:30'],
        [345, 'UTC+05:45'],
        [-210, 'UTC-03:30'],
        [840, 'UTC+14:00'],
        [-720, 'UTC-12:00'],
        [-0.5, 'UTC-00:00:30'], // between -1 and 0 minutes: still a minus sign
        [33_539 / 60, 'UTC+09:18:59'], // historical local mean time with seconds (Asia/Tokyo before 1888)
    ])('%d minutes -> %s', (minutes, expected) =>
    {
        expect(formatOffset(minutes)).toBe(expected);
    });
});

describe('formatInZone', () =>
{
    it('shows UTC as UTC+00:00', () =>
    {
        const result = formatInZone(T('2025-04-02T09:00:00Z'), 'UTC');
        expect(result).toMatchObject({
            kind: 'date',
            text: '2025-04-02 09:00:00 UTC+00:00',
            offsetMinutes: 0,
            zoneFallback: false,
        });
    });

    it('shows seconds, cutting milliseconds off without rounding up (never "60")', () =>
    {
        expect(textOf(formatInZone(T('2025-04-02T09:00:42Z'), 'UTC'))).toBe('2025-04-02 09:00:42 UTC+00:00');
        expect(textOf(formatInZone(T('2025-04-02T09:00:59.999Z'), 'UTC'))).toBe('2025-04-02 09:00:59 UTC+00:00');
        const tokyo = formatInZone(T('2025-04-02T09:00:59.999Z'), 'Asia/Tokyo');
        expect(textOf(tokyo)).toBe('2025-04-02 18:00:59 UTC+09:00');
    });

    it('crosses the 59-second boundary into the next minute, hour and day', () =>
    {
        expect(textOf(formatInZone(T('2025-04-02T09:00:59Z'), 'UTC'))).toBe('2025-04-02 09:00:59 UTC+00:00');
        expect(textOf(formatInZone(T('2025-04-02T09:01:00Z'), 'UTC'))).toBe('2025-04-02 09:01:00 UTC+00:00');
        const lastMoment = formatInZone(T('2024-12-31T14:59:59.999Z'), 'Asia/Tokyo');
        expect(textOf(lastMoment)).toBe('2024-12-31 23:59:59 UTC+09:00');
        expect(textOf(formatInZone(T('2024-12-31T15:00:00Z'), 'Asia/Tokyo'))).toBe('2025-01-01 00:00:00 UTC+09:00');
    });

    it('gives two messages sent in the same minute different text', () =>
    {
        const first = textOf(formatInZone(T('2025-04-02T09:00:05Z'), 'Asia/Tokyo'));
        const second = textOf(formatInZone(T('2025-04-02T09:00:48Z'), 'Asia/Tokyo'));
        expect(first).toBe('2025-04-02 18:00:05 UTC+09:00');
        expect(second).toBe('2025-04-02 18:00:48 UTC+09:00');
        expect(first).not.toBe(second);
    });

    it('rounds down, not toward zero, before 1970 (negative milliseconds)', () =>
    {
        expect(textOf(formatInZone(-500, 'UTC'))).toBe('1969-12-31 23:59:59 UTC+00:00');
        expect(textOf(formatInZone(-1, 'UTC'))).toBe('1969-12-31 23:59:59 UTC+00:00');
        expect(textOf(formatInZone(-1000, 'UTC'))).toBe('1969-12-31 23:59:59 UTC+00:00');
        expect(textOf(formatInZone(-1001, 'UTC'))).toBe('1969-12-31 23:59:58 UTC+00:00');
        expect(formatInZone(-500, 'UTC')).toMatchObject({ offsetMinutes: 0 });
    });

    it('rounds sub-millisecond fractions down before 1970 and keeps the offset exact', () =>
    {
        expect(formatInZone(-0.5, 'UTC')).toMatchObject({
            kind: 'date',
            text: '1969-12-31 23:59:59 UTC+00:00',
            offsetMinutes: 0,
        });
        expect(formatInZone(-1000.5, 'Asia/Tokyo')).toMatchObject({
            kind: 'date',
            text: '1970-01-01 08:59:58 UTC+09:00',
            offsetMinutes: 540,
        });
    });

    it('keeps the two passes of a repeated (DST overlap) time apart, to the second', () =>
    {
        const zone = 'America/New_York';
        const summer = textOf(formatInZone(T('2025-11-02T05:30:15Z'), zone));
        const winter = textOf(formatInZone(T('2025-11-02T06:30:15Z'), zone));
        expect(summer).toBe('2025-11-02 01:30:15 UTC-04:00');
        expect(winter).toBe('2025-11-02 01:30:15 UTC-05:00');
        expect(summer).not.toBe(winter);
    });

    it('gives a short form without seconds and offset, in the chosen zone, cut not rounded', () =>
    {
        const short = (utcMs: number, zone: string): string =>
        {
            const result = formatInZone(utcMs, zone);
            if (result.kind !== 'date')
            {
                throw new Error('expected a date');
            }
            return result.shortText;
        };
        expect(short(T('2025-04-02T09:00:59.999Z'), 'UTC')).toBe('2025-04-02 09:00');
        expect(short(T('2025-06-02T02:00:00Z'), 'America/New_York')).toBe('2025-06-01 22:00');
        expect(short(T('2024-12-31T15:00:00Z'), 'Asia/Tokyo')).toBe('2025-01-01 00:00');
        expect(short(-1, 'UTC')).toBe('1969-12-31 23:59');
        expect(short(MIN_DISPLAYABLE_MS, 'UTC')).toBe('0001-01-02 00:00');
        expect(short(T('2025-04-02T09:00:00Z'), 'Not/A_Zone')).toBe('2025-04-02 09:00'); // UTC fallback
    });

    it('shows a historical offset with seconds next to the wall-clock seconds', () =>
    {
        // Before 18 November 1883 New York used local mean time, UTC-04:56:02 (-17,762 seconds).
        const result = formatInZone(T('1880-06-01T12:00:00Z'), 'America/New_York');
        expect(result).toMatchObject({ kind: 'date', text: '1880-06-01 07:03:58 UTC-04:56:02', offsetMinutes: -17_762 / 60 });
    });

    describe('America/New_York across daylight saving time in 2024 (second Sunday of March, first Sunday of November)', () =>
    {
        const zone = 'America/New_York';
        it.each([
            ['2024-03-10T06:59:00Z', '2024-03-10 01:59:00 UTC-05:00', -300], // last minute of winter time
            ['2024-03-10T07:00:00Z', '2024-03-10 03:00:00 UTC-04:00', -240], // clocks jump 02:00 -> 03:00
            ['2024-07-15T12:00:00Z', '2024-07-15 08:00:00 UTC-04:00', -240],
            // 01:30 happens twice on 3 November: only the offset tells them apart.
            ['2024-11-03T05:30:00Z', '2024-11-03 01:30:00 UTC-04:00', -240],
            ['2024-11-03T06:30:00Z', '2024-11-03 01:30:00 UTC-05:00', -300],
        ])('%s -> %s', (iso, expected, offset) =>
        {
            expect(formatInZone(T(iso), zone)).toMatchObject({ kind: 'date', text: expected, offsetMinutes: offset, zone });
        });
    });

    describe('America/New_York across daylight saving time (negative offsets)', () =>
    {
        const zone = 'America/New_York';
        it.each([
            ['2025-03-09T06:59:00Z', '2025-03-09 01:59:00 UTC-05:00', -300],
            ['2025-03-09T07:00:00Z', '2025-03-09 03:00:00 UTC-04:00', -240], // clocks jump 02:00 -> 03:00
            ['2025-11-02T05:30:00Z', '2025-11-02 01:30:00 UTC-04:00', -240],
            ['2025-11-02T06:30:00Z', '2025-11-02 01:30:00 UTC-05:00', -300], // the repeated hour
        ])('%s -> %s', (iso, expected, offset) =>
        {
            expect(formatInZone(T(iso), zone)).toMatchObject({ kind: 'date', text: expected, offsetMinutes: offset });
        });
    });

    describe('Australia/Sydney across daylight saving time in 2025 (positive offsets, southern hemisphere)', () =>
    {
        // Summer time (UTC+11:00) ends on the first Sunday of April and starts on the first Sunday of October.
        const zone = 'Australia/Sydney';
        it.each([
            ['2025-01-15T00:00:00Z', '2025-01-15 11:00:00 UTC+11:00', 660], // mid summer
            // 6 April: clocks go back 03:00 -> 02:00, so 02:30 happens twice: only the offset tells them apart.
            ['2025-04-05T15:30:00Z', '2025-04-06 02:30:00 UTC+11:00', 660],
            ['2025-04-05T16:30:00Z', '2025-04-06 02:30:00 UTC+10:00', 600],
            ['2025-07-15T00:00:00Z', '2025-07-15 10:00:00 UTC+10:00', 600], // mid winter
            ['2025-10-04T15:59:00Z', '2025-10-05 01:59:00 UTC+10:00', 600], // last minute of winter time
            ['2025-10-04T16:00:00Z', '2025-10-05 03:00:00 UTC+11:00', 660], // clocks jump 02:00 -> 03:00
        ])('%s -> %s', (iso, expected, offset) =>
        {
            expect(formatInZone(T(iso), zone)).toMatchObject({ kind: 'date', text: expected, offsetMinutes: offset, zone });
        });
    });

    it.each([
        ['Asia/Kolkata', '2025-04-02 14:30:00 UTC+05:30', 330],
        ['Asia/Kathmandu', '2025-04-02 14:45:00 UTC+05:45', 345],
        ['America/St_Johns', '2025-04-02 06:30:00 UTC-02:30', -150], // Newfoundland summer time
    ])('handles the half-hour / 45-minute zone %s', (zone, expected, offset) =>
    {
        expect(formatInZone(T('2025-04-02T09:00:00Z'), zone)).toMatchObject({ text: expected, offsetMinutes: offset });
    });

    it.each([
        ['2024-12-31T14:59:00Z', 'Asia/Tokyo', '2024-12-31 23:59:00 UTC+09:00'],
        ['2024-12-31T15:00:00Z', 'Asia/Tokyo', '2025-01-01 00:00:00 UTC+09:00'], // midnight is 00, never 24
        ['2025-01-01T03:00:00Z', 'America/New_York', '2024-12-31 22:00:00 UTC-05:00'], // still last year there
        ['2024-12-31T20:00:00Z', 'Asia/Kathmandu', '2025-01-01 01:45:00 UTC+05:45'],
    ])('crosses the year boundary: %s in %s', (iso, zone, expected) =>
    {
        expect(textOf(formatInZone(T(iso), zone))).toBe(expected);
    });

    it('handles 29 February and dates before 1970', () =>
    {
        expect(textOf(formatInZone(T('2024-02-29T15:30:00Z'), 'Asia/Tokyo'))).toBe('2024-03-01 00:30:00 UTC+09:00');
        expect(textOf(formatInZone(T('1969-07-20T20:17:00Z'), 'UTC'))).toBe('1969-07-20 20:17:00 UTC+00:00');
    });

    it('falls back to UTC for an invalid zone and says so, without throwing', () =>
    {
        for (const bad of ['Mars/Olympus_Mons', '', 'not a zone', 'Asia/Tokyo; drop'])
        {
            expect(formatInZone(T('2025-04-02T09:00:00Z'), bad)).toMatchObject({
                kind: 'date',
                text: '2025-04-02 09:00:00 UTC+00:00',
                zone: FALLBACK_ZONE,
                zoneFallback: true,
            });
        }
    });

    it('reports the zone name as Intl spells it', () =>
    {
        expect(formatInZone(T('2025-04-02T09:00:00Z'), 'asia/tokyo')).toMatchObject({
            zone: 'Asia/Tokyo',
            text: '2025-04-02 18:00:00 UTC+09:00',
            zoneFallback: false,
        });
    });

    it('returns no-date for a missing or impossible moment, never "Invalid Date"', () =>
    {
        for (const bad of [null, Number.NaN, Number.POSITIVE_INFINITY, 9e15, -9e15])
        {
            expect(formatInZone(bad, 'Asia/Tokyo')).toEqual({ kind: 'no-date' });
        }
    });

    it('defines the displayable range as years 0001-9999 minus one day at each end', () =>
    {
        expect(new Date(MIN_DISPLAYABLE_MS).toISOString()).toBe('0001-01-02T00:00:00.000Z');
        expect(new Date(MAX_DISPLAYABLE_MS).toISOString()).toBe('9999-12-30T23:59:59.999Z');
        expect(isDisplayableMs(MIN_DISPLAYABLE_MS)).toBe(true);
        expect(isDisplayableMs(MAX_DISPLAYABLE_MS)).toBe(true);
        expect(isDisplayableMs(MIN_DISPLAYABLE_MS - 1)).toBe(false);
        expect(isDisplayableMs(MAX_DISPLAYABLE_MS + 1)).toBe(false);
        expect(isDisplayableMs(null)).toBe(false);
    });

    it.each([
        ['the largest Date, in a zone east of UTC', 8.64e15, 'Asia/Tokyo'],
        ['the largest Date, in a zone west of UTC', 8.64e15, 'America/New_York'],
        ['the smallest Date', -8.64e15, 'America/New_York'],
        ['the smallest Date, in a zone east of UTC', -8.64e15, 'Asia/Tokyo'],
        ['year 0', T('0000-06-15T12:00:00Z'), 'Asia/Tokyo'],
        ['the last millisecond of year 0', T('0001-01-01T00:00:00Z') - 1, 'Asia/Shanghai'],
        ['1e20 (beyond any Date)', 1e20, 'UTC'],
        ['one millisecond below the range', MIN_DISPLAYABLE_MS - 1, 'UTC'],
        ['one millisecond above the range', MAX_DISPLAYABLE_MS + 1, 'UTC'],
    ])('returns no-date for %s instead of a broken string', (_label, utcMs, zone) =>
    {
        expect(formatInZone(utcMs, zone)).toEqual({ kind: 'no-date' });
    });

    it.each(['UTC', 'Asia/Tokyo', 'America/New_York', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Asia/Shanghai'])(
        'shows both range boundaries in %s with a plausible offset and a year in 0001-9999',
        (zone) =>
        {
            for (const utcMs of [MIN_DISPLAYABLE_MS, MAX_DISPLAYABLE_MS])
            {
                const result = formatInZone(utcMs, zone);
                if (result.kind !== 'date')
                {
                    throw new Error(`expected a date for ${utcMs} in ${zone}`);
                }
                expect(Number.isFinite(result.offsetMinutes)).toBe(true);
                expect(Math.abs(result.offsetMinutes)).toBeLessThan(24 * 60);
                // Year, then the offset: hours and minutes, plus seconds for an old local mean time.
                expect(result.text).toMatch(/^(0001|9999)-\d\d-\d\d \d\d:\d\d:\d\d UTC[+-]\d\d:\d\d(:\d\d)?$/);
                expect(result.text).not.toContain('NaN');
                expect(result.shortText).toBe(result.text.slice(0, 16));
                expect(result.shortText).toMatch(/^(0001|9999)-\d\d-\d\d \d\d:\d\d$/);
            }
        },
    );

    it('shows the exact boundaries in UTC', () =>
    {
        expect(textOf(formatInZone(MIN_DISPLAYABLE_MS, 'UTC'))).toBe('0001-01-02 00:00:00 UTC+00:00');
        expect(textOf(formatInZone(MAX_DISPLAYABLE_MS, 'UTC'))).toBe('9999-12-30 23:59:59 UTC+00:00');
    });

    it('never throws for a locale that is not a string, and uses the default language', () =>
    {
        const utcMs = T('2025-04-02T09:00:00Z');
        const reference = formatInZone(utcMs, 'Asia/Tokyo');
        if (reference.kind !== 'date')
        {
            throw new Error('expected a date');
        }
        for (const locale of [Symbol('not a locale'), 42, null, {}, ['fr']])
        {
            // The type says string; JavaScript callers can still pass anything.
            const result = formatInZone(utcMs, 'Asia/Tokyo', locale as unknown as string);
            expect(result).toMatchObject({ kind: 'date', text: '2025-04-02 18:00:00 UTC+09:00' });
            if (result.kind === 'date')
            {
                expect(result.localized).toBe(reference.localized);
            }
        }
    });

    it('keeps returning correct results after the caches overflow', () =>
    {
        const utcMs = T('2025-04-02T09:00:00Z');
        // 640 distinct casings of one zone (bit 7 toggles the '/', which changes nothing) and 1,200 distinct
        // locale strings: more than the 500 formatters each cache holds.
        const name = 'america/new_york';
        for (let i = 0; i < 1200; i++)
        {
            const casing = [...name].map((c, k) => ((i >> k) & 1 ? c.toUpperCase() : c)).join('');
            expect(isValidTimeZone(casing)).toBe(true);
            formatInZone(utcMs, 'UTC', `en-x-p${i}`);
        }
        expect(textOf(formatInZone(utcMs, 'America/New_York'))).toBe('2025-04-02 05:00:00 UTC-04:00');
    });

    it('includes seconds in the localized string', () =>
    {
        const result = formatInZone(T('2025-04-02T09:00:42Z'), 'Asia/Tokyo', 'en');
        if (result.kind !== 'date')
        {
            throw new Error('expected a date');
        }
        expect(result.localized).toContain('42');
    });

    it('gives a localized string in the requested language, and survives an invalid locale', () =>
    {
        const utcMs = T('2025-04-02T09:00:00Z');
        for (const locale of ['en', 'fr', 'de', 'nl', 'this is not a locale'])
        {
            const result = formatInZone(utcMs, 'Asia/Tokyo', locale);
            if (result.kind !== 'date')
            {
                throw new Error('expected a date');
            }
            expect(result.localized).not.toBe('');
            expect(result.localized).not.toContain('Invalid');
            expect(result.localized).toContain('2025');
            expect(result.text).toBe('2025-04-02 18:00:00 UTC+09:00'); // the fixed form ignores the locale
        }
    });

    it('formats 10,000 dates in one zone quickly (formatters are reused)', () =>
    {
        const base = T('2025-01-01T00:00:00Z');
        const start = performance.now();
        for (let i = 0; i < 10_000; i++)
        {
            formatInZone(base + i * 3_600_000, 'America/New_York');
        }
        // Generous bound: well under a second in practice.
        expect(performance.now() - start).toBeLessThan(5000);
    });
});

describe('formatSenderLocal', () =>
{
    it('shows the sender clock time with their offset when the zone is known', () =>
    {
        expect(formatSenderLocal(date({ offsetMinutes: 120 }))).toEqual({
            kind: 'local',
            text: '2025-04-02 11:00:00 UTC+02:00',
            offsetMinutes: 120,
        });
    });

    it.each([
        [-300, '2025-04-02 04:00:00 UTC-05:00'],
        [345, '2025-04-02 14:45:00 UTC+05:45'],
        [-210, '2025-04-02 05:30:00 UTC-03:30'],
    ])('offset %d -> %s', (offsetMinutes, expected) =>
    {
        expect(formatSenderLocal(date({ offsetMinutes }))).toMatchObject({ kind: 'local', text: expected });
    });

    it('shows seconds, rounding down, and tells same-minute messages apart', () =>
    {
        const first = formatSenderLocal(date({ utcMs: T('2025-04-02T09:00:05.999Z'), offsetMinutes: 120 }));
        const second = formatSenderLocal(date({ utcMs: T('2025-04-02T09:00:59.999Z'), offsetMinutes: 120 }));
        expect(first).toMatchObject({ kind: 'local', text: '2025-04-02 11:00:05 UTC+02:00' });
        expect(second).toMatchObject({ kind: 'local', text: '2025-04-02 11:00:59 UTC+02:00' });
    });

    it('rounds down, not toward zero, before 1970 (negative milliseconds)', () =>
    {
        expect(formatSenderLocal(date({ utcMs: -500, offsetMinutes: 0 }))).toMatchObject({
            kind: 'local',
            text: '1969-12-31 23:59:59 UTC+00:00',
        });
        expect(formatSenderLocal(date({ utcMs: -500, offsetMinutes: -300 }))).toMatchObject({
            kind: 'local',
            text: '1969-12-31 18:59:59 UTC-05:00',
        });
    });

    it('rounds sub-millisecond fractions down before 1970', () =>
    {
        expect(formatSenderLocal(date({ utcMs: -0.5, offsetMinutes: 0 }))).toMatchObject({
            kind: 'local',
            text: '1969-12-31 23:59:59 UTC+00:00',
        });
    });

    it('crosses the year boundary with a negative offset', () =>
    {
        const result = formatSenderLocal(date({ utcMs: T('2025-01-01T02:00:00Z'), offsetMinutes: -300 }));
        expect(result).toMatchObject({ kind: 'local', text: '2024-12-31 21:00:00 UTC-05:00' });
    });

    it('treats offset 0 as known only when zoneKnown is true', () =>
    {
        expect(formatSenderLocal(date({ offsetMinutes: 0, zoneKnown: true }))).toMatchObject({
            kind: 'local',
            text: '2025-04-02 09:00:00 UTC+00:00',
        });
        // "-0000" or no zone at all: the parser read it as UTC for sorting only.
        expect(formatSenderLocal(date({ offsetMinutes: 0, zoneKnown: false }))).toEqual({ kind: 'zone-unknown' });
        expect(formatSenderLocal(date({ offsetMinutes: null, zoneKnown: false }))).toEqual({ kind: 'zone-unknown' });
    });

    it('says zone-unknown for an offset the parser did not trust (zoneKnown false)', () =>
    {
        expect(formatSenderLocal(date({ offsetMinutes: 120, zoneKnown: false }))).toEqual({ kind: 'zone-unknown' });
    });

    it('says zone-unknown for a .msg date: exact moment, no sender offset', () =>
    {
        const msgDate = date({ original: '2025-04-02T09:00:00.000Z', offsetMinutes: null, zoneKnown: true });
        expect(formatSenderLocal(msgDate)).toEqual({ kind: 'zone-unknown' });
    });

    it('returns no-date when there is no moment', () =>
    {
        expect(formatSenderLocal(date({ utcMs: null, offsetMinutes: null, zoneKnown: false }))).toEqual({ kind: 'no-date' });
        expect(formatSenderLocal(date({ utcMs: Number.NaN }))).toEqual({ kind: 'no-date' });
    });

    it.each([
        ['year 0', T('0000-06-15T12:00:00Z')],
        ['a negative year', T('-000001-01-01T00:00:00Z')],
        ['the smallest Date', -8.64e15],
        ['the largest Date', 8.64e15],
        ['1e20', 1e20],
        ['one millisecond below the range', MIN_DISPLAYABLE_MS - 1],
        ['one millisecond above the range', MAX_DISPLAYABLE_MS + 1],
    ])('returns no-date for %s (outside the displayable range)', (_label, utcMs) =>
    {
        expect(formatSenderLocal(date({ utcMs }))).toEqual({ kind: 'no-date' });
    });

    it('shows the range boundaries, and says zone-unknown if a large offset pushes the clock out of 0001-9999', () =>
    {
        expect(formatSenderLocal(date({ utcMs: MIN_DISPLAYABLE_MS, offsetMinutes: -720 }))).toMatchObject({
            kind: 'local',
            text: '0001-01-01 12:00:00 UTC-12:00',
        });
        expect(formatSenderLocal(date({ utcMs: MAX_DISPLAYABLE_MS, offsetMinutes: 840 }))).toMatchObject({
            kind: 'local',
            text: '9999-12-31 13:59:59 UTC+14:00',
        });
        // A header such as "-9959" is allowed by the grammar: the sender's clock would be in year 0.
        expect(formatSenderLocal(date({ utcMs: MIN_DISPLAYABLE_MS, offsetMinutes: -(99 * 60 + 59) }))).toEqual({
            kind: 'zone-unknown',
        });
        expect(formatSenderLocal(date({ utcMs: MAX_DISPLAYABLE_MS, offsetMinutes: 99 * 60 + 59 }))).toEqual({
            kind: 'zone-unknown',
        });
    });

    it('does not modify the date it is given', () =>
    {
        const input = Object.freeze(date({}));
        formatSenderLocal(input);
        expect(input.original).toBe('synthetic');
    });
});

describe('isValidTimeZone', () =>
{
    it.each(['UTC', 'Asia/Tokyo', 'America/New_York', 'Asia/Kathmandu', 'asia/tokyo'])('accepts %s', (zone) =>
    {
        expect(isValidTimeZone(zone)).toBe(true);
    });

    // A real area with an unknown location, assembled so that the test-code guard
    // (README.md, rule R7) does not take it for a zone outside its allowed list.
    it.each(['', 'Mars/Olympus_Mons', `${'Asia'}/Nowhere`, 'not a zone'])('rejects %j', (zone) =>
    {
        expect(isValidTimeZone(zone)).toBe(false);
    });

    it('rejects non-strings', () =>
    {
        for (const value of [null, undefined, 42, {}, ['UTC']])
        {
            expect(isValidTimeZone(value)).toBe(false);
        }
    });
});

describe('browserTimeZone', () =>
{
    it('returns a valid zone', () =>
    {
        expect(isValidTimeZone(browserTimeZone())).toBe(true);
    });

    it('falls back to UTC if the browser reports no zone', () =>
    {
        vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
            timeZone: undefined,
        } as unknown as Intl.ResolvedDateTimeFormatOptions);
        expect(browserTimeZone()).toBe('UTC');
    });

    it('falls back to UTC if the browser reports an invalid zone', () =>
    {
        vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
            timeZone: 'Mars/Olympus_Mons',
        } as unknown as Intl.ResolvedDateTimeFormatOptions);
        expect(browserTimeZone()).toBe('UTC');
    });
});

describe('listTimeZones', () =>
{
    it('lists zones sorted, without repeats, including UTC and the browser zone', () =>
    {
        const zones = listTimeZones();
        expect(zones).toContain('UTC');
        expect(zones).toContain('Asia/Tokyo');
        // Engines differ on old spellings: Node lists "Asia/Katmandu", newer data "Asia/Kathmandu".
        expect(zones.some((zone) => zone === 'Asia/Kathmandu' || zone === 'Asia/Katmandu')).toBe(true);
        expect(zones).toContain(browserTimeZone());
        expect(new Set(zones).size).toBe(zones.length);
        expect([...zones].sort()).toEqual(zones);
        expect(zones.every((zone) => isValidTimeZone(zone))).toBe(true);
    });

    it('falls back to a short valid list if the browser cannot list zones', () =>
    {
        vi.spyOn(Intl, 'supportedValuesOf').mockImplementation(() =>
        {
            throw new RangeError('not supported');
        });
        const zones = listTimeZones();
        expect(zones).toContain('UTC');
        expect(zones).toContain('Asia/Tokyo');
        expect(zones.length).toBeLessThan(30);
        expect(zones.every((zone) => isValidTimeZone(zone))).toBe(true);
    });

    it('falls back to the short list if the browser returns an empty list', () =>
    {
        vi.spyOn(Intl, 'supportedValuesOf').mockReturnValue([]);
        expect(listTimeZones()).toContain('America/New_York');
    });
});
