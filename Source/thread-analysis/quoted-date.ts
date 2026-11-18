// Read the date written in a quote header ("Sent: Monday, March 3, 2025
// 9:15 AM", "Le lun. 3 mars 2025 \u00e0 14:02, ... a \u00e9crit :") so a message
// rebuilt from quoted text (milestone 7) can be placed in time. Pure: no
// DOM, no network, no storage, and no Date.parse (its reading of non-ISO
// text differs between browsers); only Date.UTC for calendar arithmetic.
//
// What a quote header date tells us:
// - Usually only a WALL-CLOCK time, with no zone: clients write the quoted
//   moment in the QUOTING client's zone. We do not know that zone either,
//   so (user decision, milestone 7) the time is read in the zone of the
//   DROPPED email (the source file, whose Date header has an offset), and
//   the result is marked approximate: basis 'source-offset'. If the source
//   offset is unknown too, the wall time is taken as UTC: basis 'none'.
// - Sometimes the text carries its own zone: an RFC 5322 date in a forward
//   block ("Mon, 3 Mar 2025 14:02:00 +0900", basis 'rfc-zone') or a written
//   offset ("3 March 2025 at 14:02:00 GMT+9" from Apple Mail, "+0100",
//   "UTC+05:30", basis 'written-zone'). Then the moment is exact.
//
// Accepted forms (case-insensitive, any whitespace incl. nbsp, commas free):
//   [weekday] day month year [connector] [time [zone]]
//   [weekday] month day year [connector] [time [zone]]
//   [weekday] numeric-date [connector] [time [zone]]
// in this order only, with month and weekday names in English, French or
// Dutch (month-and-weekday-names.ts), full or abbreviated, with or without a final ".",
// with or without accents; day as "3", "03", "3rd", "1er" (a suffix must
// match its day: "1st", "2nd", "3rd", "4th", "11th", "21st", "1er" only on
// day 1); connector "at", "\u00e0", "a", "om"; time "14:02", "14:02:00",
// "2:02 PM", "2:02pm", "2:02 p.m."; zone "GMT+9", "UTC+05:30", "+0100".
// (Comments) in parentheses are ignored, as in RFC 5322, except that a
// comment holding an AM/PM word ("(PM)", "(p. m.)", "(am)") makes the date
// unreadable: dropping it could shift the time by 12 hours.
// Every word must be recognized: one unknown word makes the date unreadable.
// An RFC 5322 date is read by parseEmailDate only when it has no word
// beyond its own fields (see isWholeRfcDate).
//
// Safety rules (never guess, README.md rule R6 / brief section 7):
// - Numeric dates are read only when the order cannot be misread:
//   year first ("2025-03-03", "2025/3/3"), or a 4-digit year last with
//   either one part above 12 ("31/12/2025" and "12/31/2025" are both
//   31 December) or both parts equal ("03/03/2025"). "03/04/2025" (3 April
//   or 4 March?) is unreadable.
// - Two-digit years are refused outside RFC 5322 dates: "3/13/25" and
//   "13/03/25" could also be year-month-day, and "3 mars 25" is not a form
//   clients write. (RFC 5322 dates keep that standard's own rule, 00-49 ->
//   2000s, 50-99 -> 1900s, through parseEmailDate, because its field order
//   is fixed.) Three-digit years are refused everywhere, RFC 5322 dates
//   included: "3 Mar 049" is 1949 for the RFC, 2049 for parseEmailDate.
// - A weekday that does not match the date makes it unreadable: one of the
//   two is wrong and we cannot tell which.
// - "-0000" (and "-00:00") means, in RFC 5322, "this time is in UTC, the
//   sender's local zone is unknown": the wall time is read as UTC, basis
//   'none' (approximate, not a written zone; the source offset is not used).
//   Military one-letter zones are not read: they never appear in quote
//   headers, and a lone letter may be what is left of a cut AM/PM word
//   ("2:02 (P)M" -> "2:02 M", "2:02 p"). Any one-letter zone other than "Z"
//   makes the date unreadable. "Z" is UTC (exact). Other unknown zone
//   names ("14:02 CET" alone) are unreadable: they are real zones whose
//   offset we do not know.
// - Years outside 1900-2100 are unreadable.
// - Input longer than MAX_QUOTED_DATE_LENGTH is unreadable. Every regular
//   expression runs on one short token or is a single linear pass, and the
//   function never throws.

import { parseEmailDate } from '../email-reading/date-header';
import { DATE_LANGUAGES } from './month-and-weekday-names';
import type { QuotedDate } from '../../Header/rebuilt-emails';

/** Longer text is not read at all (a real quote header date is under 60 characters). */
export const MAX_QUOTED_DATE_LENGTH = 200;

/** True when the moment comes from a zone written in the date itself, not from an assumption. */
export function hasWrittenZone(date: QuotedDate): boolean
{
    return date.basis === 'rfc-zone' || date.basis === 'written-zone';
}

const MINUTE_MS = 60_000;
/** Offsets beyond +-23:59 do not exist in mail (RFC 5322 allows 2 hour digits). */
const MAX_OFFSET_MINUTES = 23 * 60 + 59;
/** Earliest year read (as parseEmailDate). */
const MIN_YEAR = 1900;
/** Latest year read: a later year is a typo or junk, not a mail date. */
const MAX_YEAR = 2100;
/** No real date has this many words; stops early on long junk. */
const MAX_TOKENS = 12;

// ---------------------------------------------------------------------------
// Word lookup tables, built once from month-and-weekday-names.ts.

function lookup(pick: (lang: (typeof DATE_LANGUAGES)[number]) => readonly (readonly string[])[]): ReadonlyMap<string, number>
{
    const map = new Map<string, number>();
    for (const lang of DATE_LANGUAGES)
    {
        pick(lang).forEach((words, index) =>
        {
            for (const word of words)
            {
                map.set(word, index);
            }
        });
    }
    return map;
}

const MONTH_OF = lookup((lang) => lang.months);
const WEEKDAY_OF = lookup((lang) => lang.weekdays);
const CONNECTORS: ReadonlySet<string> = new Set(DATE_LANGUAGES.flatMap((lang) => lang.connectors));
const MERIDIEM: Readonly<Record<string, 'am' | 'pm'>> = { am: 'am', 'a.m.': 'am', pm: 'pm', 'p.m.': 'pm' };
/**
 * An AM/PM word anywhere in a comment: "am", "pm", "a.m.", "p.m", "p. m.",
 * "a m" (lower-case text). Not inside a longer word ("Amsterdam", "map").
 * Linear: each "a"/"p" start scans only the spaces right after it.
 */
const MERIDIEM_IN_COMMENT = /(?<!\p{L})[ap]\.?\s*m\.?(?![\p{L}\p{N}])/u;
/** A one-letter zone word other than "z" (UTC, exact): unreadable (file comment). */
const SINGLE_LETTER = /^[a-y]$/i;
/** A zone name allowed before a numeric offset in an RFC 5322 date ("GMT +0900", "JST +0900"), as written (capitals). */
const ZONE_NAME = /^[A-Z]{2,5}$/;

// ---------------------------------------------------------------------------
// Results

const unreadable = (text: string): QuotedDate => ({ text, wallMs: null, precision: null, estimatedUtcMs: null, basis: 'none' });

/** A valid source offset in minutes, or null (unknown, or not a sane number). */
function cleanOffset(offset: number | null): number | null
{
    if (typeof offset !== 'number' || !Number.isInteger(offset) || Math.abs(offset) > MAX_OFFSET_MINUTES)
    {
        return null;
    }
    return offset;
}

/**
 * Written zone of a reading: an offset in minutes, 'utc-unknown' for "-0000"
 * (UTC, local zone unknown: file comment), or null when none is written.
 */
type WrittenZone = number | 'utc-unknown' | null;

/** The result for a readable wall time. */
function readable(
    text: string,
    wallMs: number,
    precision: 'minute' | 'day',
    zoneOffset: WrittenZone,
    zoneBasis: 'rfc-zone' | 'written-zone',
    sourceOffset: number | null,
): QuotedDate
{
    if (zoneOffset === 'utc-unknown')
    {
        return { text, wallMs, precision, estimatedUtcMs: wallMs, basis: 'none' };
    }
    if (zoneOffset !== null)
    {
        return { text, wallMs, precision, estimatedUtcMs: wallMs - zoneOffset * MINUTE_MS, basis: zoneBasis };
    }
    if (sourceOffset !== null)
    {
        return { text, wallMs, precision, estimatedUtcMs: wallMs - sourceOffset * MINUTE_MS, basis: 'source-offset' };
    }
    return { text, wallMs, precision, estimatedUtcMs: wallMs, basis: 'none' };
}

// ---------------------------------------------------------------------------
// Cleaning and tokens

interface Stripped
{
    /** The text without its comments. */
    readonly text: string;
    /** The text of the comments, each "(" and ")" turned into a space. */
    readonly comments: string;
}

/**
 * Splits (comments), which may be nested, from the text. One linear pass.
 * Returns null when a "(" is never closed: part of the text would be lost,
 * so it is not read. A stray ")" is kept and makes its word unknown.
 */
function stripComments(text: string): Stripped | null
{
    let out = '';
    let comments = '';
    let depth = 0;
    for (const character of text)
    {
        if (character === '(')
        {
            depth++;
            comments += ' ';
        }
        else if (character === ')' && depth > 0)
        {
            depth--;
            comments += ' ';
        }
        else if (depth === 0)
        {
            out += character;
        }
        else
        {
            comments += character;
        }
    }
    return depth === 0 ? { text: out, comments } : null;
}

/**
 * Words of the date (text already lower-case, comments removed):
 * "mon, 3 mar 2025 at 2:02\u202fpm" -> ["mon", "3", "mar", "2025", "at",
 * "2:02", "pm"]. "gmt +9" (any spaces) is joined into one token "gmt+9".
 */
function tokenize(clean: string): string[]
{
    return clean
        .replace(/\b(gmt|utc|ut)\s*([+-])/g, '$1$2')
        .split(/[\s,]+/)
        .filter((t) => t !== '');
}

/** "mrt." -> "mrt" (one final period only). */
const withoutDot = (token: string): string => (token.endsWith('.') ? token.slice(0, -1) : token);

/**
 * True when tokens[0] is a weekday. A word that is also a month ("mar") is a
 * weekday only if a month word follows it (see month-and-weekday-names.ts).
 */
function startsWithWeekday(tokens: readonly string[]): boolean
{
    const first = withoutDot(tokens[0] ?? '');
    if (!WEEKDAY_OF.has(first))
    {
        return false;
    }
    if (!MONTH_OF.has(first))
    {
        return true;
    }
    return tokens.slice(1).some((t) => MONTH_OF.has(withoutDot(t)));
}

/**
 * A written zone token, in minutes from UTC: "gmt", "utc", "ut" (0),
 * "gmt+9", "gmt-11", "gmt+5:45", "utc+05:30", "gmt+0900", "+0900", "+09:00".
 * After a name: 1-2 hour digits with optional ":mm", or exactly 4 digits
 * ("gmt+123" and "gmt+900" are refused, not read as +01:23 or +09:00).
 * `null` = "-0000" (zone explicitly unknown), `undefined` = not a zone
 * token, or out of range.
 */
function readZoneToken(token: string): number | null | undefined
{
    if (token === 'gmt' || token === 'utc' || token === 'ut')
    {
        return 0;
    }
    let sign: string | undefined;
    let hoursDigits: string | undefined;
    let minutesDigits: string | undefined;
    const named = /^(?:gmt|utc|ut)([+-])(?:(\d{1,2})(?::(\d\d))?|(\d\d)(\d\d))$/.exec(token);
    if (named !== null)
    {
        sign = named[1];
        hoursDigits = named[2] ?? named[4];
        minutesDigits = named[3] ?? named[5];
    }
    else
    {
        const bare = /^([+-])(\d\d):?(\d\d)$/.exec(token);
        if (bare === null)
        {
            return undefined;
        }
        [, sign, hoursDigits, minutesDigits] = bare;
    }
    const hours = Number(hoursDigits);
    const minutes = minutesDigits === undefined ? 0 : Number(minutesDigits);
    if (!Number.isInteger(hours) || hours > 23 || minutes > 59)
    {
        return undefined;
    }
    if (named === null && hours === 0 && minutes === 0 && sign === '-')
    {
        return null;
    }
    return (sign === '-' ? -1 : 1) * (hours * 60 + minutes);
}

/** True when a day suffix fits its day: "1st", "2nd", "3rd", "4th", "11th", "21st", "1er". */
function suffixFits(day: number, suffix: string | undefined): boolean
{
    if (suffix === undefined)
    {
        return true;
    }
    if (suffix === 'er')
    {
        return day === 1;
    }
    const lastTwo = day % 100;
    const last = day % 10;
    if (lastTwo >= 11 && lastTwo <= 13)
    {
        return suffix === 'th';
    }
    if (last === 1)
    {
        return suffix === 'st';
    }
    if (last === 2)
    {
        return suffix === 'nd';
    }
    if (last === 3)
    {
        return suffix === 'rd';
    }
    return suffix === 'th';
}

interface CalendarDate
{
    readonly year: number;
    readonly month: number; // 1-12
    readonly day: number;
}

/**
 * A numeric date, only when its order cannot be misread (see the file
 * comment). Returns null for ambiguous, two-digit-year or malformed dates;
 * the day and month ranges are checked later.
 */
function readNumericDate(token: string): CalendarDate | null
{
    const match = /^(\d{1,4})([./-])(\d{1,2})\2(\d{1,4})$/.exec(token);
    if (match === null)
    {
        return null;
    }
    const [, firstDigits = '', , middleDigits = '', lastDigits = ''] = match;
    if (firstDigits.length === 4 && lastDigits.length <= 2)
    {
        return { year: Number(firstDigits), month: Number(middleDigits), day: Number(lastDigits) };
    }
    if (firstDigits.length > 2 || lastDigits.length !== 4)
    {
        return null; // two- or three-digit years: refused
    }
    const first = Number(firstDigits);
    const second = Number(middleDigits);
    const year = Number(lastDigits);
    if (first === second)
    {
        return { year, month: first, day: first };
    }
    if (first > 12 && second <= 12)
    {
        return { year, month: second, day: first }; // day/month/year
    }
    if (second > 12 && first <= 12)
    {
        return { year, month: first, day: second }; // month/day/year
    }
    return null; // both 12 or less (ambiguous), or both above 12 (invalid)
}

/** Milliseconds of a calendar date at midnight UTC, or null if the day does not exist (31 April, 29 Feb 2025). */
function dateMs(calendarDate: CalendarDate): number | null
{
    const { year, month, day } = calendarDate;
    if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 || day < 1 || day > 31)
    {
        return null;
    }
    const ms = Date.UTC(year, month - 1, day);
    return new Date(ms).getUTCDate() === day ? ms : null;
}

const weekdayOf = (ms: number): number => new Date(ms).getUTCDay();

interface Clock
{
    readonly hour: number; // as written
    readonly minute: number;
    readonly second: number;
    meridiem: 'am' | 'pm' | null;
}

/** "14:02", "14:02:00", "2:02pm", "2:02p.m." */
function readClock(token: string): Clock | null
{
    const match = /^(\d{1,2}):(\d\d)(?::(\d\d))?(am|pm|a\.m\.|p\.m\.)?$/.exec(token);
    if (match === null)
    {
        return null;
    }
    return {
        hour: Number(match[1]),
        minute: Number(match[2]),
        second: match[3] === undefined ? 0 : Number(match[3]),
        meridiem: match[4] === undefined ? null : (MERIDIEM[match[4]] ?? null),
    };
}

/** Milliseconds since midnight, or null when out of range (12-hour clocks: hour 1-12; 24-hour: 0-23). */
function clockMs(clock: Clock): number | null
{
    const { minute, second, meridiem } = clock;
    let hour = clock.hour;
    if (minute > 59 || second > 59)
    {
        return null;
    }
    if (meridiem === null)
    {
        if (hour > 23)
        {
            return null;
        }
    }
    else
    {
        if (hour < 1 || hour > 12)
        {
            return null;
        }
        hour = (hour % 12) + (meridiem === 'pm' ? 12 : 0); // 12 AM = 00, 12 PM = 12
    }
    return ((hour * 60 + minute) * 60 + second) * 1000;
}

// ---------------------------------------------------------------------------
// The localized reader

interface Reading
{
    readonly wallMs: number;
    readonly precision: 'minute' | 'day';
    readonly zone: WrittenZone;
}

/** Reads the tokens of a localized or numeric date; null = unreadable. */
function readLocalized(tokens: readonly string[]): Reading | null
{
    if (tokens.length === 0 || tokens.length > MAX_TOKENS)
    {
        return null;
    }
    let weekday: number | null = null;
    let month: number | null = null;
    let day: number | null = null;
    let year: number | null = null;
    let numeric = false;
    let clock: Clock | null = null;
    let zone: number | null | undefined; // undefined = none written yet
    let connector = false;
    let previousWasClock = false;
    // The order is enforced (file comment): date words first (the year last,
    // or one numeric date), then an optional connector, the time, the zone.
    const dateDone = (): boolean => day !== null && month !== null && year !== null;

    for (let i = 0; i < tokens.length; i++)
    {
        const token = tokens[i] ?? '';
        const wasClock = previousWasClock;
        previousWasClock = false;

        if (i === 0 && startsWithWeekday(tokens))
        {
            weekday = WEEKDAY_OF.get(withoutDot(token)) ?? null;
            continue;
        }
        // AM/PM: only right after a time without one.
        const meridiem = MERIDIEM[token];
        if (meridiem !== undefined)
        {
            if (!wasClock || clock === null || clock.meridiem !== null)
            {
                return null;
            }
            clock.meridiem = meridiem;
            continue;
        }
        if (/^\d{4}$/.test(token))
        {
            // The year closes "day month year" or "month day year".
            if (numeric || year !== null || day === null || month === null)
            {
                return null;
            }
            year = Number(token);
            continue;
        }
        const dayMatch = /^(\d{1,2})(st|nd|rd|th|er)?$/.exec(token);
        if (dayMatch !== null)
        {
            // A second small number would be a two-digit year ("3 Mar 25"): refused.
            if (day !== null || year !== null)
            {
                return null;
            }
            day = Number(dayMatch[1]);
            if (!suffixFits(day, dayMatch[2]))
            {
                return null;
            }
            continue;
        }
        const numericDate = readNumericDate(token);
        if (numericDate !== null)
        {
            if (numeric || day !== null || month !== null || year !== null)
            {
                return null;
            }
            ({ day, year } = numericDate);
            month = numericDate.month - 1;
            numeric = true;
            continue;
        }
        const time = readClock(token);
        if (time !== null)
        {
            if (!dateDone() || clock !== null || zone !== undefined)
            {
                return null;
            }
            clock = time;
            previousWasClock = true;
            continue;
        }
        const written = readZoneToken(token);
        if (written !== undefined)
        {
            if (clock === null || zone !== undefined)
            {
                return null;
            }
            zone = written;
            continue;
        }
        const word = withoutDot(token);
        const monthIndex = MONTH_OF.get(word);
        if (monthIndex !== undefined)
        {
            if (month !== null || year !== null)
            {
                return null;
            }
            month = monthIndex;
            continue;
        }
        if (CONNECTORS.has(token))
        {
            if (!dateDone() || connector || clock !== null || zone !== undefined)
            {
                return null;
            }
            connector = true;
            continue;
        }
        return null; // unknown word (a misplaced weekday included)
    }

    if (day === null || month === null || year === null)
    {
        return null;
    }
    const midnight = dateMs({ year, month: month + 1, day });
    if (midnight === null)
    {
        return null;
    }
    if (weekday !== null && weekday !== weekdayOf(midnight))
    {
        return null;
    }
    // A zone is only accepted after a time, so a day-only date has none.
    if (clock === null)
    {
        return { wallMs: midnight, precision: 'day', zone: null };
    }
    const sinceMidnight = clockMs(clock);
    if (sinceMidnight === null)
    {
        return null;
    }
    const written: WrittenZone = zone === undefined ? null : zone === null ? 'utc-unknown' : zone;
    return { wallMs: midnight + sinceMidnight, precision: 'minute', zone: written };
}

// ---------------------------------------------------------------------------
// RFC 5322 dates

/**
 * parseEmailDate reads only its first 5-6 words, ignores the rest, and takes
 * any word before a comma for a weekday. Its result is used only when it
 * read every word of the text: an optional KNOWN weekday, then day, month,
 * a 2- or 4-digit year, time, zone, and at most a numeric offset after a
 * zone name ("GMT +0900", "JST +0900"). That name must be written in capitals,
 * 2-5 letters, and not be a month, weekday, connector or AM/PM word: a word
 * like "uur", "at" or "Mon" there is not a zone. `cased` is the text without
 * comments, case kept. Returns the weekday written (index, or null when
 * none) and the zone word, lower-case (undefined when none), or undefined
 * when the text has anything else ("+0100 p. m.", "+0100 2026", "Foo, 3 Mar
 * ...", "14:02 Mon +0100", "3 Mar 049"): step 2 reads it then.
 */
function wholeRfcDate(cased: string): { readonly weekday: number | null; readonly zone: string | undefined } | undefined
{
    // Words before the first comma: parseEmailDate drops one as a weekday.
    const lead = /^\s*(\p{L}+\.?)\s*,/u.exec(cased);
    if (lead !== null && !WEEKDAY_OF.has(withoutDot((lead[1] ?? '').toLowerCase())))
    {
        return undefined;
    }
    // Tokens as parseEmailDate makes them.
    const casedTokens = cased
        .replace(/\s*:\s*/g, ':')
        .split(/[\s,]+/)
        .filter((t) => t !== '');
    const tokens = casedTokens.map((t) => t.toLowerCase());
    let weekday: number | null = null;
    if (startsWithWeekday(tokens))
    {
        weekday = WEEKDAY_OF.get(withoutDot(tokens[0] ?? '')) ?? null;
        tokens.shift();
        casedTokens.shift();
    }
    // parseEmailDate maps 3-digit years by adding 1900 only from 050 up
    // ("049" -> 2049, the RFC says 1949): refused.
    if (!/^(?:\d\d|\d{4})$/.test(tokens[2] ?? ''))
    {
        return undefined;
    }
    const zone = tokens[4];
    if (tokens.length <= 5)
    {
        return { weekday, zone };
    }
    const name = zone ?? '';
    if (
        tokens.length === 6 &&
        ZONE_NAME.test(casedTokens[4] ?? '') &&
        !MONTH_OF.has(name) &&
        !WEEKDAY_OF.has(name) &&
        !CONNECTORS.has(name) &&
        MERIDIEM[name] === undefined &&
        /^[+-]\d{4}$/.test(tokens[5] ?? '')
    )
    {
        return { weekday, zone };
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Entry point

/**
 * Reads a quote header date. `sourceOffsetMinutes` is the UTC offset of the
 * DROPPED email's Date header (null if unknown); it is used only when the
 * text carries no zone. Never throws; an unreadable date has wallMs null.
 */
export function parseQuotedDate(text: string, sourceOffsetMinutes: number | null): QuotedDate
{
    if (typeof text !== 'string')
    {
        return unreadable('');
    }
    if (text.length > MAX_QUOTED_DATE_LENGTH)
    {
        return unreadable(text);
    }
    const source = cleanOffset(sourceOffsetMinutes);
    // An unclosed comment loses part of the text; an AM/PM word in a comment
    // ("2:02 (PM)") would be lost too and shift the time: unreadable.
    const stripped = stripComments(text.normalize('NFC'));
    if (stripped === null || MERIDIEM_IN_COMMENT.test(stripped.comments.toLowerCase()))
    {
        return unreadable(text);
    }
    const tokens = tokenize(stripped.text.toLowerCase());

    // Step 1: an RFC 5322 date (forward blocks), only when parseEmailDate used
    // every word (wholeRfcDate). Not when an AM/PM word is present:
    // parseEmailDate would take "PM" for an unknown zone and read 2:02 PM as
    // 02:02. Read with a real zone (exact), or with "-0000" (UTC, local zone
    // unknown: approximate, file comment). A one-letter military zone other
    // than "Z" is refused (unreadable, below).
    const rfcDate = parseEmailDate(text);
    const whole = wholeRfcDate(stripped.text);
    if (rfcDate.utcMs !== null && whole !== undefined && !tokens.some((t) => MERIDIEM[t] !== undefined))
    {
        let zone: WrittenZone | undefined;
        if (rfcDate.zoneKnown && rfcDate.offsetMinutes !== null)
        {
            zone = rfcDate.offsetMinutes;
        }
        else if (rfcDate.offsetMinutes === null && whole.zone === '-0000')
        {
            zone = 'utc-unknown';
        }
        else if (SINGLE_LETTER.test(whole.zone ?? ''))
        {
            // A one-letter zone other than "Z" may be what is left of a cut AM/PM
            // ("2:02 (P)M" -> "2:02 M"): unreadable, never a guess (file comment).
            return unreadable(text);
        }
        if (zone !== undefined)
        {
            const wallMs = rfcDate.utcMs + (typeof zone === 'number' ? zone : 0) * MINUTE_MS;
            // parseEmailDate ignores the weekday; we check it.
            if (whole.weekday !== null && whole.weekday !== weekdayOf(wallMs))
            {
                return unreadable(text);
            }
            if (new Date(wallMs).getUTCFullYear() > MAX_YEAR)
            {
                return unreadable(text);
            }
            return readable(text, wallMs, 'minute', zone, 'rfc-zone', source);
        }
    }

    // Step 2: localized and numeric forms.
    const reading = readLocalized(tokens);
    if (reading === null)
    {
        return unreadable(text);
    }
    return readable(text, reading.wallMs, reading.precision, reading.zone, 'written-zone', source);
}
