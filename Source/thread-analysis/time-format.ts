// Date and time display helpers. Pure functions with no page or DOM access,
// so they can be unit tested in isolation (README.md, rule R7).
//
// Every date is shown AS WRITTEN (user decision, task 9.9c): the sender's own
// wall-clock date and time, never converted to another time zone. A Date
// header "Tue, 17 Feb 2026 13:59:00 +0100" shows 13:59, whatever the reader's
// zone or the season: people read it in their own time zone. Messages are
// still sorted by their true UTC moment (see chronological-order.ts); that
// moment is never shown. No date library, no Intl time zones, nothing loaded
// from the network (README.md, rule R1).
//
// Main format: "2026-02-17 13:59:00".
// - Year-month-day order and a 24-hour clock cannot be misread (is 02/04
//   April or February?), whatever the reader's country.
// - Seconds are always shown: in a legal record, two messages sent in the
//   same minute must not look as if they were sent at the same time. They
//   are cut from the exact moment, never rounded up (11:00:42.999 shows as
//   11:00:42, and a moment just before 1970 still rounds down), so the value
//   is always 00-59.
// - No offset or zone mark is shown (user decisions, task 9.9c): the time is
//   plain, as the sender's clock showed it. An exact moment whose sender
//   zone is not known at all (a .msg date kept as a UTC moment, with no Date
//   header text) has no "as written" time: its UTC time is shown, plain,
//   like any other date.
//
// These functions never throw and never return "Invalid Date": a missing
// date gives `{ kind: 'no-date' }`. The original Date header text is not
// touched: it stays on `message.date.original` (README.md, rule R6).

import type { EmailDate } from '../../Header/parsed-email';

/** 0001-01-01T00:00:00.000Z, the first moment of year 1. */
const YEAR_1_START_MS = -62_135_596_800_000;
/** 9999-12-31T23:59:59.999Z, the last moment of year 9999. */
const YEAR_9999_END_MS = 253_402_300_799_999;
/** One day in milliseconds. */
const ONE_DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/**
 * The moments we sort by date and display: years 0001 to 9999, minus one day
 * at each end. A JavaScript Date reaches much further (year -271821 to
 * 275760), but outside 0001-9999 a four-digit year cannot be written. The
 * one-day margin keeps a wall-clock time (the moment plus the sender's
 * offset, well under a day) inside 0001-9999. chronological-order.ts uses the
 * same range, so a moment outside it is never sorted by date yet shown as
 * "no date".
 */
export const MIN_DISPLAYABLE_MS = YEAR_1_START_MS + ONE_DAY_MS; // 0001-01-02T00:00:00.000Z
export const MAX_DISPLAYABLE_MS = YEAR_9999_END_MS - ONE_DAY_MS; // 9999-12-30T23:59:59.999Z

/** True if `utcMs` is a number inside the displayable range (null, NaN, Infinity and far-off moments are not). */
export function isDisplayableMs(utcMs: number | null): utcMs is number
{
    return utcMs !== null && Number.isFinite(utcMs) && utcMs >= MIN_DISPLAYABLE_MS && utcMs <= MAX_DISPLAYABLE_MS;
}

/** A wall-clock date and time, as written (see the top of this file). */
export type WallClockTime =
    | { readonly kind: 'no-date' }
    | {
        readonly kind: 'date';
        /** E.g. "2026-02-17 13:59:00". */
        readonly text: string;
        /**
         * Short form for tables, e.g. "2026-02-17 13:59": without seconds, always 16 characters, so it
         * fits the PDF index's date column on one line.
         */
        readonly shortText: string;
        /**
         * For <time datetime>: "2026-02-17T13:59:00", with the offset it was
         * written with when known ("+01:00"), "Z" for a UTC moment; no offset
         * when the writer's zone is not known (a local date and time).
         */
        readonly iso: string;
    };

/** Two digits, e.g. 7 -> "07". */
function pad2(n: number): string
{
    return String(n).padStart(2, '0');
}

/** "+01:00", "-05:30", "Z" for 0 (an ISO 8601 offset). Whole minutes only (header offsets are). */
function isoOffset(offsetMinutes: number): string
{
    if (offsetMinutes === 0)
    {
        return 'Z';
    }
    const sign = offsetMinutes < 0 ? '-' : '+';
    const total = Math.round(Math.abs(offsetMinutes));
    return `${sign}${pad2(Math.floor(total / 60))}:${pad2(total % 60)}`;
}

/**
 * The wall-clock time `wallMs` (the time as written, read as if it were UTC)
 * as text. `isoOffsetMinutes`: the offset it was written with, for `iso`
 * only (null: unknown). `wallMs` outside years 0001-9999 (or not a number)
 * gives `{ kind: 'no-date' }`.
 */
export function formatWallClock(wallMs: number | null, isoOffsetMinutes: number | null = null): WallClockTime
{
    if (wallMs === null || !Number.isFinite(wallMs) || wallMs < YEAR_1_START_MS || wallMs > YEAR_9999_END_MS)
    {
        return { kind: 'no-date' };
    }
    // The UTC getters cut to whole seconds, rounding down (also before 1970); round sub-millisecond fractions down first.
    const wall = new Date(Math.floor(wallMs));
    const day = `${String(wall.getUTCFullYear()).padStart(4, '0')}-${pad2(wall.getUTCMonth() + 1)}-${pad2(wall.getUTCDate())}`;
    const minutes = `${pad2(wall.getUTCHours())}:${pad2(wall.getUTCMinutes())}`;
    const seconds = pad2(wall.getUTCSeconds());
    const offset = isoOffsetMinutes === null || !Number.isFinite(isoOffsetMinutes) ? '' : isoOffset(isoOffsetMinutes);
    return {
        kind: 'date',
        text: `${day} ${minutes}:${seconds}`,
        shortText: `${day} ${minutes}`,
        iso: `${day}T${minutes}:${seconds}${offset}`,
    };
}

/**
 * The wall-clock time a Date header wrote, read as if it were UTC (ms), or
 * null without a displayable moment. The header's offset is added back to
 * its moment: parseEmailDate took it off (10:00 +0200 is 08:00 UTC, shown
 * 10:00). A header without a usable offset (none, "-0000", an unknown zone)
 * was read as UTC, so its moment IS the time as written. A header whose
 * zone name and offset disagree keeps the offset its moment was computed
 * with, so the result is still the time as written.
 */
export function emailWallClockMs(date: EmailDate): number | null
{
    if (!isDisplayableMs(date.utcMs))
    {
        return null;
    }
    const offset = typeof date.offsetMinutes === 'number' && Number.isFinite(date.offsetMinutes) ? date.offsetMinutes : 0;
    return date.utcMs + offset * MINUTE_MS;
}

/**
 * A real email's date, as written (see the top of this file and
 * emailWallClockMs). An exact moment of unknown sender zone (a .msg date:
 * zone known, offset null) has no time as written: its UTC time, plain, with
 * "Z" in `iso` only (its moment is exact UTC). Hence `offsetMinutes ?? 0`:
 * zone known but no offset means the moment is exact UTC, so `iso` gets "Z".
 */
export function formatEmailDate(date: EmailDate): WallClockTime
{
    const offset = date.zoneKnown ? (date.offsetMinutes ?? 0) : null;
    return formatWallClock(emailWallClockMs(date), offset);
}
