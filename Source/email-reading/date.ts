// Parse an email Date header (RFC 5322 section 3.3, plus its "obsolete"
// forms from section 4.3, which old and odd mail clients still send).
//
// Why not just `Date.parse(raw)`? Its behaviour for non-ISO strings is not
// specified by the JavaScript standard: browsers disagree, and some silently
// guess (e.g. treat a missing zone as the computer's local time). For legal
// use the order of messages must be the same on every computer, so we read
// the fields ourselves and only use `Date.UTC` for the calendar arithmetic.
//
// Accepted shape (case-insensitive, extra spaces and (comments) allowed):
//   [Weekday,] Day Month Year HH:MM[:SS] [Zone]
//   e.g. "Tue, 3 Jun 2025 14:05:09 +0900 (JST)"
// The weekday may also be localized ("mer.,", "wo,") as long as a comma
// follows it. Month names must stay English: a localized month ("okt")
// is not RFC-valid, so such a header is reported as unparseable.

import type { EmailDate } from '../../Header/parsed-email';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

// Named zones allowed by RFC 5322 section 4.3, as minutes from UTC.
// "UTC" is not in the RFC but is common in the wild and unambiguous.
const NAMED_ZONES: Readonly<Record<string, number>> = {
    ut: 0, utc: 0, gmt: 0, z: 0,
    edt: -4 * 60, est: -5 * 60,
    cdt: -5 * 60, cst: -6 * 60,
    mdt: -6 * 60, mst: -7 * 60,
    pdt: -7 * 60, pst: -8 * 60,
};

/** Removes (comments), which may be nested, e.g. "+0900 (JST)" -> "+0900 ". */
function stripComments(text: string): string
{
    let out = '';
    let depth = 0;
    for (const ch of text)
    {
        if (ch === '(')
        {
            depth++;
        }
        else if (ch === ')' && depth > 0)
        {
            depth--;
        }
        else if (depth === 0)
        {
            out += ch;
        }
        // Inside a comment: the character is dropped.
    }
    return out;
}

/** Parses a whole number made only of digits, with a length between min and max. */
function readInt(token: string | undefined, minLen: number, maxLen: number): number | null
{
    if (token === undefined || token.length < minLen || token.length > maxLen)
    {
        return null;
    }
    return /^\d+$/.test(token) ? Number(token) : null;
}

/**
 * Reads the zone token.
 * Returns `{ offset }` with offset in minutes, or offset null when the zone is
 * missing/unknown (then the time is read as UTC, see below), or null if the
 * token is clearly broken (e.g. "+2500").
 */
function readZone(token: string | undefined): { offset: number | null } | null
{
    // RFC 5322 4.3: a missing zone, "-0000" and unknown letter zones all mean
    // "this is UTC, but the sender's local zone is unknown".
    if (token === undefined)
    {
        return { offset: null };
    }
    const numeric = /^([+-])(\d\d)(\d\d)$/.exec(token);
    if (numeric)
    {
        const [, sign, hh, mm] = numeric;
        const hours = Number(hh);
        const minutes = Number(mm);
        if (hours > 23 || minutes > 59)
        {
            return null;
        }
        if (token === '-0000')
        {
            return { offset: null };
        }
        return { offset: (sign === '-' ? -1 : 1) * (hours * 60 + minutes) };
    }
    const named = NAMED_ZONES[token.toLowerCase()];
    if (named !== undefined)
    {
        return { offset: named };
    }
    if (/^[a-z]+$/i.test(token))
    {
        return { offset: null }; // unknown letters, e.g. military zones
    }
    return null;
}

/** The Date header as one value; `utcMs` is null if missing or unparseable (`original` is always kept). */
export function parseEmailDate(raw: string | null | undefined): EmailDate
{
    const original = raw ?? '';
    const failed: EmailDate = { utcMs: null, original, offsetMinutes: null, zoneKnown: false };

    // The weekday is optional and ignored: the date itself is what counts.
    // Any single word of letters (accents included, optional final ".") directly
    // followed by a comma is taken as a weekday in any language, e.g. "mer.,",
    // "wo,", "Tue,". Without a comma, only English weekdays are skipped (below).
    const text = stripComments(original).replace(/^\s*\p{L}+\.?\s*,/u, '');

    // "3 Jun 2025 14 : 05 " -> ["3", "Jun", "2025", "14:05"]
    const tokens = text
        .replace(/\s*:\s*/g, ':') // obsolete form allows spaces around ':'
        .split(/[\s,]+/)
        .filter((t) => t !== '');

    if (tokens[0] !== undefined && WEEKDAYS.includes(tokens[0].toLowerCase().replace(/\.$/, '')))
    {
        tokens.shift();
    }
    const [dayToken, monthToken, yearToken, timeToken, zoneToken, afterZoneToken] = tokens;

    const day = readInt(dayToken, 1, 2);
    const month = MONTHS.indexOf((monthToken ?? '').toLowerCase());
    let year = readInt(yearToken, 2, 4);
    if (day === null || month === -1 || year === null)
    {
        return failed;
    }
    // Obsolete 2- and 3-digit years (RFC 5322 4.3): 00-49 -> 2000s, 50-999 -> add 1900.
    if (yearToken !== undefined && yearToken.length < 4)
    {
        year += year < 50 ? 2000 : 1900;
    }
    if (year < 1900)
    {
        return failed;
    }

    const time = /^(\d\d?):(\d\d)(?::(\d\d))?$/.exec(timeToken ?? '');
    if (!time)
    {
        return failed;
    }
    const hour = Number(time[1]);
    const minute = Number(time[2]);
    const second = time[3] === undefined ? 0 : Number(time[3]);
    // second 60 is a leap second, allowed by the RFC; Date.UTC rolls it into the next minute.
    if (hour > 23 || minute > 59 || second > 60)
    {
        return failed;
    }

    const zone = readZone(zoneToken);
    if (zone === null)
    {
        return failed;
    }
    let offset = zone.offset;
    let zoneKnown = offset !== null; // null offset = missing, "-0000" or unknown zone
    // Some clients write a zone NAME followed by a numeric offset, e.g.
    // "12:00:00 JST +0900" or "12:00:00 GMT +0200". When the next token is a
    // valid offset (in range, and not "-0000"):
    //   - GMT, UT, UTC or Z: "GMT +0200" means "GMT plus 2 hours", so the
    //     numeric offset is used and is trusted (zoneKnown true).
    //   - unknown name (e.g. JST): the numeric offset is used and trusted.
    //   - US zone (EST, EDT, CST, CDT, MST, MDT, PST, PDT): if its value equals
    //     the offset, that offset is trusted. If they contradict each other, the
    //     numeric offset is still used for sorting, but zoneKnown is false so the
    //     date gets flagged: never claim certainty when the header contradicts itself.
    // If the next token looks like an offset but is out of range (e.g. "+2500"),
    // the header contradicts itself: the name's offset is kept, but zoneKnown
    // is set to false so the date gets flagged.
    // "-0000" after a name is ignored (the name is trusted).
    // Otherwise the token after the zone (e.g. a bare "JST") is ignored.
    if (/^[a-z]+$/i.test(zoneToken ?? '') && /^[+-]\d{4}$/.test(afterZoneToken ?? ''))
    {
        const next = readZone(afterZoneToken);
        if (next === null)
        {
            zoneKnown = false;
        }
        else if (next.offset !== null)
        {
            const isUtcName = ['gmt', 'ut', 'utc', 'z'].includes((zoneToken ?? '').toLowerCase());
            // Unknown name (offset null) or GMT-style name: trust the offset.
            // Known US zone: trust it only if the name agrees with the offset.
            zoneKnown = offset === null || isUtcName || offset === next.offset;
            offset = next.offset;
        }
    }

    // Date.UTC accepts "31 Feb" and silently moves it to March, so check the day exists.
    const local = Date.UTC(year, month, day, hour, minute, second);
    if (new Date(Date.UTC(year, month, day)).getUTCDate() !== day)
    {
        return failed;
    }

    // The header shows local time at `offset`; subtract the offset to get UTC.
    // Example: 10:00 +0200 is 08:00 UTC.
    const utcMs = local - (offset ?? 0) * 60_000;
    return { utcMs, original, offsetMinutes: offset, zoneKnown };
}
