// Date and time display helpers. Pure functions with no page or DOM access,
// so they can be unit tested in isolation (README.md, rule R7).
//
// Messages are sorted by their true UTC moment (see chronological-order.ts) and shown in a
// time zone the user picks, by default the browser's own. Only the built-in
// `Intl.DateTimeFormat` is used: no date library, nothing loaded from the
// network (README.md, rule R1). The chosen zone is never saved anywhere
// (README.md, rule R5): the UI keeps it in memory and passes it in.
//
// Main format: "2025-04-02 11:00:42 UTC+02:00".
// - Year-month-day order and a 24-hour clock cannot be misread (is 02/04
//   April or February?), whatever the reader's country.
// - Seconds are always shown: in a legal record, two messages sent in the
//   same minute must not look as if they were sent at the same time. They
//   are cut from the exact moment, never rounded up (11:00:42.999 shows as
//   11:00:42, and a moment just before 1970 still rounds down), so the value
//   is always 00-59.
// - The offset is written as a number, not an abbreviation: "CST" can mean
//   China, US Central or Cuba time, but "UTC-06:00" means one thing.
// - We build this string ourselves from the numeric parts that Intl returns,
//   so it is identical in Node (the tests) and in every browser, whose
//   locale data differ slightly.
// A `localized` string in the reader's language is also returned for a
// friendlier display; its exact wording depends on the browser.
//
// These functions never throw and never return "Invalid Date": a missing
// date gives `{ kind: 'no-date' }`, an unknown zone falls back to UTC and
// says so. The original Date header text is not touched: it stays on
// `message.date.original` (README.md, rule R6).

import type { EmailDate } from '../../Header/parsed-email';

/** Language used when the caller gives none (real UI strings come with translations later). */
export const DEFAULT_LOCALE = 'en';

/** The zone used when the asked-for zone is invalid or the browser reports none. */
export const FALLBACK_ZONE = 'UTC';

/** 0001-01-01T00:00:00.000Z, the first moment of year 1. */
const YEAR_1_START_MS = -62_135_596_800_000;
/** 9999-12-31T23:59:59.999Z, the last moment of year 9999. */
const YEAR_9999_END_MS = 253_402_300_799_999;
/** One day in milliseconds. */
const ONE_DAY_MS = 86_400_000;

/**
 * The moments we sort by date and display: years 0001 to 9999, minus one day
 * at each end. A JavaScript Date reaches much further (year -271821 to
 * 275760), but outside 0001-9999 the display breaks: Intl drops the era for
 * years 0 and below (year 0 is shown as "0001"), and near the Date limits the
 * wall-clock time of a zone east or west of UTC no longer fits in a Date, so
 * its offset comes out as NaN or absurd. The one-day margin keeps the local
 * time inside 0001-9999 in every zone (real offsets stay well under 24 hours).
 * chronological-order.ts uses the same range, so a moment outside it is never sorted by date
 * yet shown as "no date".
 */
export const MIN_DISPLAYABLE_MS = YEAR_1_START_MS + ONE_DAY_MS; // 0001-01-02T00:00:00.000Z
export const MAX_DISPLAYABLE_MS = YEAR_9999_END_MS - ONE_DAY_MS; // 9999-12-30T23:59:59.999Z

/** True if `utcMs` is a number inside the displayable range (null, NaN, Infinity and far-off moments are not). */
export function isDisplayableMs(utcMs: number | null): utcMs is number
{
    return utcMs !== null && Number.isFinite(utcMs) && utcMs >= MIN_DISPLAYABLE_MS && utcMs <= MAX_DISPLAYABLE_MS;
}

/** Largest number of formatters kept per cache (see below). */
const MAX_CACHED_FORMATTERS = 500;

/** Short list used only if the browser cannot list its zones (Intl.supportedValuesOf is missing). */
const FALLBACK_ZONE_LIST = [
    'UTC',
    'America/Los_Angeles',
    'America/Chicago',
    'America/New_York',
    'America/Sao_Paulo',
    'Europe/London',
    'Africa/Lagos',
    'Europe/Moscow',
    'Africa/Johannesburg',
    'Asia/Dubai',
    'Asia/Kolkata',
    'Asia/Shanghai',
    'Asia/Tokyo',
    'Australia/Sydney',
    'Pacific/Auckland',
];

/** A moment shown in a chosen time zone. */
export type ZonedDateTime =
    | { readonly kind: 'no-date' }
    | {
        readonly kind: 'date';
        /** Fixed, unambiguous form, e.g. "2025-04-02 11:00:42 UTC+02:00" (same in every browser). */
        readonly text: string;
        /** Short form for tables, e.g. "2025-04-02 11:00": `text` without seconds and offset (always 16 characters). */
        readonly shortText: string;
        /** The same moment in the reader's language, e.g. "Apr 2, 2025, 11:00:42 GMT+2". Wording varies by browser. */
        readonly localized: string;
        /**
         * The zone actually used, as this engine names it (e.g. "Asia/Tokyo",
         * or "UTC" after a fallback). May be an old spelling of the asked-for
         * zone: Node reports "Asia/Kolkata" as "Asia/Calcutta".
         */
        readonly zone: string;
        /** That zone's offset from UTC at this moment, in minutes (e.g. 120). */
        readonly offsetMinutes: number;
        /** True if the asked-for zone was not valid and UTC was used instead. The UI should say so. */
        readonly zoneFallback: boolean;
    };

/** The sender's own local time, as written in their Date header. */
export type SenderLocalTime =
    | { readonly kind: 'no-date' }
    // There is a moment, but not the sender's offset (.msg dates, or a Date
    // header without a trustworthy zone): the UI shows "time zone unknown".
    | { readonly kind: 'zone-unknown' }
    | {
        readonly kind: 'local';
        /** E.g. "2025-04-02 11:00:42 UTC+02:00". */
        readonly text: string;
        readonly offsetMinutes: number;
    };

// Creating an Intl.DateTimeFormat is slow compared with using one, and a long
// thread formats thousands of dates in the same zone, so formatters are kept
// per zone (and per locale). They hold settings only, never message data.
const numericFormatters = new Map<string, Intl.DateTimeFormat>();
const localizedFormatters = new Map<string, Intl.DateTimeFormat>();

/** Stores a formatter, first emptying the cache if it is full, so odd inputs (every casing of a zone name) cannot grow it without limit. */
function remember(cache: Map<string, Intl.DateTimeFormat>, key: string, formatter: Intl.DateTimeFormat): void
{
    if (cache.size >= MAX_CACHED_FORMATTERS)
    {
        cache.clear();
    }
    cache.set(key, formatter);
}

/**
 * Formatter giving plain numbers: Latin digits, Gregorian calendar, 24-hour
 * clock ("h23", so midnight is 00, never 24), whatever the user's settings.
 * Throws RangeError if `zone` is not valid.
 */
function numericFormatter(zone: string): Intl.DateTimeFormat
{
    let formatter = numericFormatters.get(zone);
    if (formatter === undefined)
    {
        formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
            timeZone: zone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23',
        });
        remember(numericFormatters, zone, formatter);
    }
    return formatter;
}

/** Formatter for the reader's language. Falls back to DEFAULT_LOCALE if `locale` is not a valid locale string. */
function localizedFormatter(zone: string, requestedLocale: unknown): Intl.DateTimeFormat
{
    // Only a string is accepted: anything else (a Symbol would even throw in the
    // key below) uses the default language.
    const locale = typeof requestedLocale === 'string' ? requestedLocale : DEFAULT_LOCALE;
    const key = `${zone}\u0000${locale}`;
    let formatter = localizedFormatters.get(key);
    if (formatter === undefined)
    {
        const options: Intl.DateTimeFormatOptions = {
            timeZone: zone,
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            timeZoneName: 'short',
        };
        try
        {
            formatter = new Intl.DateTimeFormat(locale, options);
        }
        catch
        {
            formatter = new Intl.DateTimeFormat(DEFAULT_LOCALE, options);
        }
        remember(localizedFormatters, key, formatter);
    }
    return formatter;
}

/** Two digits, e.g. 7 -> "07". */
function pad2(n: number): string
{
    return String(n).padStart(2, '0');
}

/** "2025-04-02 11:00" from calendar fields. Years below 1000 get leading zeros (callers keep years in 1-9999). */
function shortWallClockText(year: number, month: number, day: number, hour: number, minute: number): string
{
    return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)} ${pad2(hour)}:${pad2(minute)}`;
}

/** "2025-04-02 11:00:42" from calendar fields (see shortWallClockText). */
function wallClockText(year: number, month: number, day: number, hour: number, minute: number, second: number): string
{
    return `${shortWallClockText(year, month, day, hour, minute)}:${pad2(second)}`;
}

/**
 * An offset in minutes as "UTC+02:00", "UTC-05:00", "UTC+05:45" or
 * "UTC+00:00". Historical local mean times (before about 1900) can have
 * seconds, e.g. "UTC+09:18:59".
 */
export function formatOffset(offsetMinutes: number): string
{
    const sign = offsetMinutes < 0 ? '-' : '+'; // 0 and -0 both give "+"
    const totalSeconds = Math.round(Math.abs(offsetMinutes) * 60);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return `UTC${sign}${pad2(hours)}:${pad2(minutes)}${seconds === 0 ? '' : `:${pad2(seconds)}`}`;
}

/** The browser's time zone (e.g. "Asia/Tokyo"), or "UTC" if it reports none or an invalid one. */
export function browserTimeZone(): string
{
    try
    {
        const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
        return typeof zone === 'string' && isValidTimeZone(zone) ? zone : FALLBACK_ZONE;
    }
    catch
    {
        return FALLBACK_ZONE;
    }
}

/**
 * True if Intl accepts `zone` as a time zone (an IANA name such as
 * "America/New_York", "UTC", or an offset such as "+02:00" in newer engines).
 * Intl ignores letter case: "asia/tokyo" is accepted.
 */
export function isValidTimeZone(zone: unknown): zone is string
{
    if (typeof zone !== 'string' || zone === '')
    {
        return false;
    }
    try
    {
        numericFormatter(zone);
        return true;
    }
    catch
    {
        return false;
    }
}

/**
 * The zones the user can pick from, sorted, without repeats, always
 * including "UTC" and the browser's own zone (some browsers leave "UTC" out
 * of their list, and the browser's zone may be an old alias such as
 * "Asia/Calcutta" that the list spells differently).
 *
 * Names come from the engine's own data, so some engines use old spellings
 * ("Asia/Calcutta" for "Asia/Kolkata", "Europe/Kiev" for "Europe/Kyiv").
 * Both spellings are valid input everywhere; we do not rename them, to avoid
 * keeping our own table of zone names.
 */
export function listTimeZones(): string[]
{
    let zones: string[] = [];
    const supportedValuesOf = (Intl as { supportedValuesOf?: (key: 'timeZone') => string[] }).supportedValuesOf;
    if (typeof supportedValuesOf === 'function')
    {
        try
        {
            zones = supportedValuesOf('timeZone');
        }
        catch
        {
            zones = [];
        }
    }
    if (zones.length === 0)
    {
        zones = FALLBACK_ZONE_LIST.filter((zone) => isValidTimeZone(zone));
    }
    const all = new Set([...zones, FALLBACK_ZONE, browserTimeZone()]);
    return [...all].sort();
}

/**
 * Shows `utcMs` in `zone`. An invalid zone falls back to UTC with
 * `zoneFallback: true`; a missing moment, or one outside the displayable range
 * (MIN_DISPLAYABLE_MS to MAX_DISPLAYABLE_MS), gives `{ kind: 'no-date' }`.
 */
export function formatInZone(utcMs: number | null, zone: string, locale: string = DEFAULT_LOCALE): ZonedDateTime
{
    if (!isDisplayableMs(utcMs))
    {
        return { kind: 'no-date' };
    }
    // Intl and Date cut sub-millisecond fractions toward zero; round down first so -0.5 is 23:59:59.
    utcMs = Math.floor(utcMs);

    const zoneFallback = !isValidTimeZone(zone);
    const usedZone = zoneFallback ? FALLBACK_ZONE : zone;
    const formatter = numericFormatter(usedZone);

    const fields: Record<string, number> = {};
    for (const part of formatter.formatToParts(utcMs))
    {
        if (part.type !== 'literal')
        {
            fields[part.type] = Number(part.value);
        }
    }
    const year = fields.year ?? 0;
    const month = fields.month ?? 1;
    const day = fields.day ?? 1;
    const hour = fields.hour ?? 0;
    const minute = fields.minute ?? 0;
    const second = fields.second ?? 0;

    // The zone's offset = (the wall-clock time read as if it were UTC) - (the
    // real UTC moment). Intl shows whole seconds, so compare with the moment
    // cut to whole seconds. setUTCFullYear is used because Date.UTC would turn
    // years 0-99 into 1900-1999.
    const wallClock = new Date(0);
    wallClock.setUTCFullYear(year, month - 1, day);
    wallClock.setUTCHours(hour, minute, second, 0);
    const offsetMinutes = (wallClock.getTime() - Math.floor(utcMs / 1000) * 1000) / 60_000;
    // Last guard: should the engine return odd parts, never print "UTC+NaN".
    if (!Number.isFinite(offsetMinutes))
    {
        return { kind: 'no-date' };
    }

    return {
        kind: 'date',
        // Intl already cuts the moment to whole seconds (rounding down, also before 1970).
        text: `${wallClockText(year, month, day, hour, minute, second)} ${formatOffset(offsetMinutes)}`,
        shortText: shortWallClockText(year, month, day, hour, minute),
        localized: localizedFormatter(usedZone, locale).format(utcMs),
        // The name as Intl spells it (e.g. "asia/tokyo" -> "Asia/Tokyo").
        zone: formatter.resolvedOptions().timeZone,
        offsetMinutes,
        zoneFallback,
    };
}

/**
 * The sender's own local time: the moment shifted by the offset from their
 * Date header. Only when that offset is trustworthy (`zoneKnown` and an
 * offset present); otherwise `{ kind: 'zone-unknown' }`. A .msg date has an
 * exact moment but no sender offset, so it is 'zone-unknown' too.
 */
export function formatSenderLocal(date: EmailDate): SenderLocalTime
{
    if (!isDisplayableMs(date.utcMs))
    {
        return { kind: 'no-date' };
    }
    // Date cuts sub-millisecond fractions toward zero; round down first so -0.5 is 23:59:59.
    const utcMs = Math.floor(date.utcMs);
    const offset = date.offsetMinutes;
    if (!date.zoneKnown || offset === null || !Number.isFinite(offset))
    {
        return { kind: 'zone-unknown' };
    }

    // The Date getters below cut to whole seconds, rounding down (also before 1970).
    const shifted = new Date(utcMs + offset * 60_000);
    // A header offset can reach +/-99:59, more than the one-day margin: if the
    // sender's clock falls outside years 1-9999 we cannot show it reliably.
    const year = shifted.getUTCFullYear();
    if (!Number.isFinite(year) || year < 1 || year > 9999)
    {
        return { kind: 'zone-unknown' };
    }
    const text = wallClockText(
        year,
        shifted.getUTCMonth() + 1,
        shifted.getUTCDate(),
        shifted.getUTCHours(),
        shifted.getUTCMinutes(),
        shifted.getUTCSeconds(),
    );
    return { kind: 'local', text: `${text} ${formatOffset(offset)}`, offsetMinutes: offset };
}
