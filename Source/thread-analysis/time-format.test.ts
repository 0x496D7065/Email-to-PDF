// Tests for the date display helpers (README.md, rule R7). Synthetic dates only.
//
// Every date is shown as written (task 9.9c): the sender's own wall-clock
// time, never converted. The helpers only use UTC arithmetic, so the result
// is the same on every computer, whatever its time zone: the last block
// checks that no local-time API is even called.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseEmailDate } from '../email-reading/date-header';
import {
    emailWallClockMs,
    formatEmailDate,
    formatWallClock,
    isDisplayableMs,
    MAX_DISPLAYABLE_MS,
    MIN_DISPLAYABLE_MS,
    type WallClockTime,
} from './time-format';
import type { EmailDate } from '../../Header/parsed-email';

const T = (iso: string): number => Date.parse(iso);

/** The `text` of a formatted date, failing the test if there was none. */
function textOf(result: WallClockTime): string
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

describe('formatWallClock', () =>
{
    it('writes the wall-clock fields as they are, with seconds, a short form and an ISO form', () =>
    {
        expect(formatWallClock(T('2026-02-17T13:59:07Z'))).toEqual({
            kind: 'date',
            text: '2026-02-17 13:59:07',
            shortText: '2026-02-17 13:59',
            iso: '2026-02-17T13:59:07',
        });
    });

    it('adds the written offset to the ISO form only', () =>
    {
        expect(formatWallClock(T('2026-02-17T13:59:00Z'), 60)).toMatchObject({ text: '2026-02-17 13:59:00', iso: '2026-02-17T13:59:00+01:00' });
        expect(formatWallClock(T('2026-04-21T13:54:00Z'), -330)).toMatchObject({ text: '2026-04-21 13:54:00', iso: '2026-04-21T13:54:00-05:30' });
        expect(formatWallClock(T('2026-04-21T13:54:00Z'), 0)).toMatchObject({ iso: '2026-04-21T13:54:00Z' });
        expect(formatWallClock(T('2026-04-21T13:54:00Z'), Number.NaN)).toMatchObject({ iso: '2026-04-21T13:54:00' });
    });

    it('cuts milliseconds off without rounding up (never "60")', () =>
    {
        expect(textOf(formatWallClock(T('2025-04-02T11:00:42.999Z')))).toBe('2025-04-02 11:00:42');
        expect(textOf(formatWallClock(T('2025-12-31T23:59:59.999Z')))).toBe('2025-12-31 23:59:59');
    });

    it('rounds down, not toward zero, before 1970 (negative and sub-millisecond values)', () =>
    {
        expect(textOf(formatWallClock(-500))).toBe('1969-12-31 23:59:59');
        expect(textOf(formatWallClock(-0.5))).toBe('1969-12-31 23:59:59');
    });

    it('writes years below 1000 with four digits and keeps 29 February', () =>
    {
        expect(textOf(formatWallClock(T('0999-03-04T05:06:07Z')))).toBe('0999-03-04 05:06:07');
        expect(textOf(formatWallClock(T('2024-02-29T00:00:00Z')))).toBe('2024-02-29 00:00:00');
    });

    it('returns no-date outside years 0001-9999 or for a value that is not a number, never "Invalid Date"', () =>
    {
        for (const bad of [null, Number.NaN, Number.POSITIVE_INFINITY, 9e15, -9e15, T('0000-12-31T23:59:59Z'), T('+010000-01-01T00:00:00Z')])
        {
            expect(formatWallClock(bad)).toEqual({ kind: 'no-date' });
        }
        expect(textOf(formatWallClock(T('0001-01-01T00:00:00Z')))).toBe('0001-01-01 00:00:00');
        expect(textOf(formatWallClock(T('9999-12-31T23:59:59.999Z')))).toBe('9999-12-31 23:59:59');
    });
});

describe('isDisplayableMs', () =>
{
    it('defines the displayable range as years 0001-9999 minus one day at each end', () =>
    {
        expect(new Date(MIN_DISPLAYABLE_MS).toISOString()).toBe('0001-01-02T00:00:00.000Z');
        expect(new Date(MAX_DISPLAYABLE_MS).toISOString()).toBe('9999-12-30T23:59:59.999Z');
        expect(isDisplayableMs(MIN_DISPLAYABLE_MS)).toBe(true);
        expect(isDisplayableMs(MAX_DISPLAYABLE_MS)).toBe(true);
        expect(isDisplayableMs(MIN_DISPLAYABLE_MS - 1)).toBe(false);
        expect(isDisplayableMs(MAX_DISPLAYABLE_MS + 1)).toBe(false);
        expect(isDisplayableMs(null)).toBe(false);
        expect(isDisplayableMs(Number.NaN)).toBe(false);
    });
});

describe('formatEmailDate (a real Date header, as written)', () =>
{
    it.each([
        // A winter and a summer date in Brussels, and offsets far from any test machine's zone.
        ['Tue, 17 Feb 2026 13:59:00 +0100', '2026-02-17 13:59:00', '2026-02-17T13:59:00+01:00'],
        ['Tue, 21 Apr 2026 13:54:00 +0200', '2026-04-21 13:54:00', '2026-04-21T13:54:00+02:00'],
        ['Mon, 13 Jul 2026 13:59:00 -0700', '2026-07-13 13:59:00', '2026-07-13T13:59:00-07:00'],
        ['Thu, 15 Jan 2026 13:59:00 +1345', '2026-01-15 13:59:00', '2026-01-15T13:59:00+13:45'],
        ['Thu, 15 Jan 2026 13:59:00 +0000', '2026-01-15 13:59:00', '2026-01-15T13:59:00Z'],
        ['Thu, 15 Jan 2026 13:59:00 GMT', '2026-01-15 13:59:00', '2026-01-15T13:59:00Z'],
        ['Thu, 15 Jan 2026 13:59:00 EST', '2026-01-15 13:59:00', '2026-01-15T13:59:00-05:00'],
        ['Sat, 31 Dec 2022 23:59:59 -1200', '2022-12-31 23:59:59', '2022-12-31T23:59:59-12:00'],
    ])('%s -> %s (no conversion, no offset shown)', (header, text, iso) =>
    {
        expect(formatEmailDate(parseEmailDate(header))).toEqual({ kind: 'date', text, shortText: text.slice(0, 16), iso });
    });

    it('shows the time as written for a header without a usable zone (read as UTC for sorting only)', () =>
    {
        // No zone, "-0000", an unknown zone: no offset for <time datetime> either.
        for (const header of ['Tue, 17 Feb 2026 13:59:00', 'Tue, 17 Feb 2026 13:59:00 -0000', 'Tue, 17 Feb 2026 13:59:00 XYZ'])
        {
            expect(formatEmailDate(parseEmailDate(header))).toEqual({
                kind: 'date', text: '2026-02-17 13:59:00', shortText: '2026-02-17 13:59', iso: '2026-02-17T13:59:00',
            });
        }
    });

    it('shows the time as written when the zone name and the offset disagree (the offset was used for the moment)', () =>
    {
        const parsed = parseEmailDate('Tue, 17 Feb 2026 13:59:00 PST +0100');
        expect(parsed.zoneKnown).toBe(false);
        expect(formatEmailDate(parsed)).toEqual({ kind: 'date', text: '2026-02-17 13:59:00', shortText: '2026-02-17 13:59', iso: '2026-02-17T13:59:00' });
    });

    it('gives two emails written at the same clock time in different zones the same text, though their moments differ', () =>
    {
        const brussels = parseEmailDate('Tue, 17 Feb 2026 13:59:00 +0100');
        const tokyo = parseEmailDate('Tue, 17 Feb 2026 13:59:00 +0900');
        expect(brussels.utcMs).not.toBe(tokyo.utcMs);
        expect(textOf(formatEmailDate(brussels))).toBe(textOf(formatEmailDate(tokyo)));
    });

    it('shows an exact moment of unknown sender zone (a .msg date) as its plain UTC time, with no mark (only iso says Z)', () =>
    {
        const messageDate = date({ utcMs: T('2025-04-02T09:00:00Z'), original: '2025-04-02T09:00:00.000Z', offsetMinutes: null, zoneKnown: true });
        expect(formatEmailDate(messageDate)).toEqual({
            kind: 'date', text: '2025-04-02 09:00:00', shortText: '2025-04-02 09:00', iso: '2025-04-02T09:00:00Z',
        });
    });

    it('cuts seconds, never rounding up, and crosses the year boundary as written', () =>
    {
        expect(textOf(formatEmailDate(date({ utcMs: T('2025-04-02T09:00:59.999Z'), offsetMinutes: 120 })))).toBe('2025-04-02 11:00:59');
        expect(textOf(formatEmailDate(date({ utcMs: T('2025-01-01T02:00:00Z'), offsetMinutes: -300 })))).toBe('2024-12-31 21:00:00');
    });

    it('returns no-date without a displayable moment', () =>
    {
        expect(formatEmailDate(date({ utcMs: null, offsetMinutes: null, zoneKnown: false }))).toEqual({ kind: 'no-date' });
        for (const utcMs of [Number.NaN, 8.64e15, -8.64e15, 1e20, MIN_DISPLAYABLE_MS - 1, MAX_DISPLAYABLE_MS + 1])
        {
            expect(formatEmailDate(date({ utcMs }))).toEqual({ kind: 'no-date' });
        }
        expect(formatEmailDate(parseEmailDate('Someday, around noon'))).toEqual({ kind: 'no-date' });
    });

    it('returns no-date rather than a broken year when a huge offset would push the clock out of 0001-9999', () =>
    {
        expect(textOf(formatEmailDate(date({ utcMs: MIN_DISPLAYABLE_MS, offsetMinutes: -720 })))).toBe('0001-01-01 12:00:00');
        expect(textOf(formatEmailDate(date({ utcMs: MAX_DISPLAYABLE_MS, offsetMinutes: 840 })))).toBe('9999-12-31 13:59:59');
        expect(formatEmailDate(date({ utcMs: MIN_DISPLAYABLE_MS, offsetMinutes: -(99 * 60 + 59) }))).toEqual({ kind: 'no-date' });
        expect(formatEmailDate(date({ utcMs: MAX_DISPLAYABLE_MS, offsetMinutes: 99 * 60 + 59 }))).toEqual({ kind: 'no-date' });
    });

    it('emailWallClockMs adds the offset back to the moment (0 when it is unknown)', () =>
    {
        expect(emailWallClockMs(date({ utcMs: T('2026-02-17T12:59:00Z'), offsetMinutes: 60 }))).toBe(T('2026-02-17T13:59:00Z'));
        expect(emailWallClockMs(date({ utcMs: T('2026-02-17T12:59:00Z'), offsetMinutes: null, zoneKnown: false }))).toBe(T('2026-02-17T12:59:00Z'));
        expect(emailWallClockMs(date({ utcMs: null }))).toBeNull();
    });

    it('does not modify the date it is given', () =>
    {
        const input = Object.freeze(date({}));
        formatEmailDate(input);
        expect(input).toEqual(date({}));
    });
});

describe('no time zone of the computer is ever used', () =>
{
    it('gives the same text with every local-time API of Date and Intl broken', () =>
    {
        const boom = (): never =>
        {
            throw new Error('a local-time API was used');
        };
        for (const name of ['getTimezoneOffset', 'getHours', 'getDate', 'getMonth', 'getFullYear', 'getMinutes', 'getSeconds', 'toLocaleString', 'toString'] as const)
        {
            vi.spyOn(Date.prototype, name).mockImplementation(boom);
        }
        vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(boom);
        expect(textOf(formatEmailDate(parseEmailDate('Tue, 17 Feb 2026 13:59:00 +0100')))).toBe('2026-02-17 13:59:00');
        expect(textOf(formatEmailDate(parseEmailDate('Tue, 21 Apr 2026 13:54:00 +0200')))).toBe('2026-04-21 13:54:00');
        expect(textOf(formatWallClock(T('2026-04-21T13:54:00Z')))).toBe('2026-04-21 13:54:00');
    });
});
