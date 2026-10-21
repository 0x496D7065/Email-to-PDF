import { describe, expect, it } from 'vitest';
import { parseEmailDate } from './date';

// All dates below are synthetic examples of real-world header styles.

/** The expected UTC instant, written as an ISO string for readability. */
const utc = (iso: string) => Date.parse(iso);

describe('parseEmailDate: valid headers', () => {
  it('parses the standard form with a positive offset', () => {
    const raw = 'Tue, 3 Jun 2025 14:05:09 +0200';
    expect(parseEmailDate(raw)).toEqual({
      utcMs: utc('2025-06-03T12:05:09Z'),
      original: raw,
      offsetMinutes: 120,
      zoneKnown: true,
    });
  });

  it('parses a negative offset', () => {
    const d = parseEmailDate('Mon, 10 Mar 2025 08:00:00 -0500');
    expect(d.utcMs).toBe(utc('2025-03-10T13:00:00Z'));
    expect(d.offsetMinutes).toBe(-300);
  });

  it('parses a half-hour offset', () => {
    const d = parseEmailDate('Fri, 7 Feb 2025 09:30:00 +0530');
    expect(d.utcMs).toBe(utc('2025-02-07T04:00:00Z'));
    expect(d.offsetMinutes).toBe(330);
  });

  it('accepts a missing weekday and missing seconds', () => {
    const d = parseEmailDate('3 Jun 2025 14:05 +0200');
    expect(d.utcMs).toBe(utc('2025-06-03T12:05:00Z'));
  });

  it('ignores comments such as (JST), even nested ones', () => {
    expect(parseEmailDate('Tue, 3 Jun 2025 14:05:09 +0900 (JST)').utcMs).toBe(utc('2025-06-03T05:05:09Z'));
    expect(parseEmailDate('Tue, 3 Jun 2025 14:05:09 +0900 (local (standard time))').utcMs).toBe(
      utc('2025-06-03T05:05:09Z'),
    );
  });

  // Styles seen from French/Dutch-locale clients: two-digit day with leading
  // zero, double spaces, lowercase month, comment with a long zone name.
  // All still valid RFC 5322 (month names are case-insensitive).
  it('handles French/Dutch-client formatting quirks', () => {
    expect(parseEmailDate('Wed,  05 Mar 2025  09:03:00 +0100').utcMs).toBe(utc('2025-03-05T08:03:00Z'));
    expect(parseEmailDate('05 mar 2025 09:03:00 +0100 (Romance Standard Time)').utcMs).toBe(
      utc('2025-03-05T08:03:00Z'),
    );
    expect(parseEmailDate('Thu, 6 Mar 2025 16:45:00 +0100 (W. Europe Standard Time)').offsetMinutes).toBe(60);
  });

  // Deliberate decision: ANY word followed by a comma is skipped as a weekday,
  // so localized weekdays work; the fields after it are still checked strictly.
  it('skips a localized weekday when a comma follows it', () => {
    // French "mer." (mercredi), Dutch "wo" (woensdag), accented letters.
    expect(parseEmailDate('mer., 14 oct 2026 09:03:00 +0200').utcMs).toBe(utc('2026-10-14T07:03:00Z'));
    expect(parseEmailDate('wo, 14 Oct 2026 09:03:00 +0200').utcMs).toBe(utc('2026-10-14T07:03:00Z'));
    expect(parseEmailDate('Mié., 14 Oct 2026 09:03:00 +0200').utcMs).toBe(utc('2026-10-14T07:03:00Z'));
  });

  it('only skips English weekdays when no comma follows', () => {
    expect(parseEmailDate('Wed 14 Oct 2026 09:03:00 +0200').utcMs).toBe(utc('2026-10-14T07:03:00Z'));
    expect(parseEmailDate('mer. 14 oct 2026 09:03:00 +0200').utcMs).toBe(null);
  });

  it('still rejects a localized month name (flagged downstream as unparseable-date)', () => {
    for (const raw of ['wo, 14 okt 2026 09:03:00 +0200', 'jeu., 7 mai 2026 09:03:00 +0200']) {
      expect(parseEmailDate(raw)).toEqual({ utcMs: null, original: raw, offsetMinutes: null, zoneKnown: false });
    }
  });

  it('handles a date that crosses midnight in UTC (both directions)', () => {
    // Late evening in New York is already the next day (and year) in UTC.
    expect(parseEmailDate('Tue, 31 Dec 2024 23:30:00 -0500').utcMs).toBe(utc('2025-01-01T04:30:00Z'));
    // Just after midnight in Tokyo is still the previous day in UTC.
    expect(parseEmailDate('Wed, 1 Jan 2025 00:30:00 +0900').utcMs).toBe(utc('2024-12-31T15:30:00Z'));
  });

  it('understands legacy named zones', () => {
    const at = (zone: string) => parseEmailDate(`Mon, 6 Jan 2025 12:00:00 ${zone}`);
    expect(at('GMT')).toMatchObject({ utcMs: utc('2025-01-06T12:00:00Z'), offsetMinutes: 0 });
    expect(at('UT')).toMatchObject({ utcMs: utc('2025-01-06T12:00:00Z'), offsetMinutes: 0 });
    expect(at('Z')).toMatchObject({ utcMs: utc('2025-01-06T12:00:00Z'), offsetMinutes: 0 });
    expect(at('EST')).toMatchObject({ utcMs: utc('2025-01-06T17:00:00Z'), offsetMinutes: -300 });
    expect(at('EDT').offsetMinutes).toBe(-240);
    expect(at('CST').offsetMinutes).toBe(-360);
    expect(at('CDT').offsetMinutes).toBe(-300);
    expect(at('MST').offsetMinutes).toBe(-420);
    expect(at('MDT').offsetMinutes).toBe(-360);
    expect(at('pst')).toMatchObject({ utcMs: utc('2025-01-06T20:00:00Z'), offsetMinutes: -480 });
    expect(at('PDT').offsetMinutes).toBe(-420);
  });

  it('marks the zone as known for numeric offsets (incl. +0000) and recognized names', () => {
    const zones = ['+0000', '+0200', '-0500', '+0530', 'GMT', 'Z', 'UT', 'UTC', 'utc'];
    zones.push('EST', 'EDT', 'CST', 'CDT', 'MST', 'MDT', 'PST', 'PDT');
    for (const zone of zones) {
      expect(parseEmailDate(`Mon, 6 Jan 2025 12:00:00 ${zone}`).zoneKnown, zone).toBe(true);
    }
  });

  it('reads -0000, unknown zones and a missing zone as UTC, with zoneKnown false', () => {
    for (const raw of [
      'Mon, 6 Jan 2025 12:00:00 -0000',
      'Mon, 6 Jan 2025 12:00:00 XYZ',
      'Mon, 6 Jan 2025 12:00:00 A', // military zone letter: the RFC says treat as unknown
      'Mon, 6 Jan 2025 12:00:00',
      'Mon, 6 Jan 2025 12:00:00 (no zone, only a comment)',
    ]) {
      expect(parseEmailDate(raw)).toEqual({
        utcMs: utc('2025-01-06T12:00:00Z'),
        original: raw,
        offsetMinutes: null,
        zoneKnown: false,
      });
    }
  });

  it('expands obsolete 2-digit years', () => {
    expect(parseEmailDate('6 Jan 25 12:00:00 +0000').utcMs).toBe(utc('2025-01-06T12:00:00Z'));
    expect(parseEmailDate('6 Jan 99 12:00:00 +0000').utcMs).toBe(utc('1999-01-06T12:00:00Z'));
  });

  it('accepts obsolete spaces around the colons', () => {
    expect(parseEmailDate('6 Jan 2025 12 : 00 : 30 +0000').utcMs).toBe(utc('2025-01-06T12:00:30Z'));
  });
});

describe('parseEmailDate: missing or broken headers', () => {
  it('returns null for a missing header and keeps an empty original', () => {
    expect(parseEmailDate(undefined)).toEqual({ utcMs: null, original: '', offsetMinutes: null, zoneKnown: false });
    expect(parseEmailDate(null)).toEqual({ utcMs: null, original: '', offsetMinutes: null, zoneKnown: false });
    expect(parseEmailDate('   ')).toEqual({ utcMs: null, original: '   ', offsetMinutes: null, zoneKnown: false });
  });

  it('returns null for garbage but keeps the original text', () => {
    for (const raw of [
      'not a date',
      'yesterday afternoon',
      '2025-06-03T12:05:09Z', // ISO is not an email Date header
      'Tue, 3 Foo 2025 14:05:09 +0200', // unknown month
      'Tue, 31 Feb 2025 14:05:09 +0200', // day does not exist
      'Tue, 3 Jun 2025 25:05:09 +0200', // hour out of range
      'Tue, 3 Jun 2025 14:05:09 +2500', // offset out of range
      'Tue, 3 Jun 2025 14:05:09 +02', // truncated offset
      'Tue, 3 Jun 2025', // no time
    ]) {
      expect(parseEmailDate(raw)).toEqual({ utcMs: null, original: raw, offsetMinutes: null, zoneKnown: false });
    }
  });
});

describe('parseEmailDate: boundary cases', () => {
  it('accepts 29 Feb in a leap year and rejects it otherwise', () => {
    expect(parseEmailDate('29 Feb 2024 12:00:00 +0000').utcMs).toBe(utc('2024-02-29T12:00:00Z'));
    expect(parseEmailDate('29 Feb 2023 12:00:00 +0000').utcMs).toBe(null);
  });

  it('splits two-digit years at 49/50 and adds 1900 to three-digit years', () => {
    expect(parseEmailDate('6 Jan 49 12:00:00 +0000').utcMs).toBe(utc('2049-01-06T12:00:00Z'));
    expect(parseEmailDate('6 Jan 50 12:00:00 +0000').utcMs).toBe(utc('1950-01-06T12:00:00Z'));
    expect(parseEmailDate('6 Jan 125 12:00:00 +0000').utcMs).toBe(utc('2025-01-06T12:00:00Z'));
  });

  it('rejects four-digit years before 1900', () => {
    expect(parseEmailDate('6 Jan 1899 12:00:00 +0000').utcMs).toBe(null);
    expect(parseEmailDate('6 Jan 0099 12:00:00 +0000').utcMs).toBe(null);
  });

  it('parses a folded header (CRLF + whitespace between fields)', () => {
    const raw = 'Tue,\r\n 1 Jul\t2003\r\n\t10:52:37\r\n +0200';
    expect(parseEmailDate(raw).utcMs).toBe(utc('2003-07-01T08:52:37Z'));
  });

  it('accepts a single-digit hour', () => {
    expect(parseEmailDate('6 Jan 2025 9:05 +0000').utcMs).toBe(utc('2025-01-06T09:05:00Z'));
  });

  it('handles the extreme real-world offsets +1400 and -1200, and rejects +9999', () => {
    expect(parseEmailDate('6 Jan 2025 12:00:00 +1400')).toMatchObject({
      utcMs: utc('2025-01-05T22:00:00Z'),
      offsetMinutes: 840,
    });
    expect(parseEmailDate('6 Jan 2025 12:00:00 -1200')).toMatchObject({
      utcMs: utc('2025-01-07T00:00:00Z'),
      offsetMinutes: -720,
    });
    expect(parseEmailDate('6 Jan 2025 12:00:00 +9999').utcMs).toBe(null);
  });

  it('ignores a separate trailing word but rejects text glued to the offset', () => {
    expect(parseEmailDate('6 Jan 2025 12:00:00 +0200 garbage').utcMs).toBe(utc('2025-01-06T10:00:00Z'));
    expect(parseEmailDate('6 Jan 2025 12:00:00 +0200garbage').utcMs).toBe(null);
  });

  it('skips any word before a comma as a weekday (broad comma rule)', () => {
    // Deliberate decision (localized weekdays); the fields after it are still strict.
    expect(parseEmailDate('Junk, 6 Jan 2025 12:00:00 +0000').utcMs).toBe(utc('2025-01-06T12:00:00Z'));
  });

  it('uses the numeric offset that follows an unknown zone name', () => {
    expect(parseEmailDate('6 Jan 2025 12:00:00 JST +0900')).toMatchObject({
      utcMs: utc('2025-01-06T03:00:00Z'),
      offsetMinutes: 540,
      zoneKnown: true,
    });
  });

  it('keeps an unknown zone name alone as zoneKnown false', () => {
    expect(parseEmailDate('6 Jan 2025 12:00:00 JST')).toMatchObject({
      utcMs: utc('2025-01-06T12:00:00Z'),
      offsetMinutes: null,
      zoneKnown: false,
    });
  });

  it('reads "GMT/UT/UTC + offset" as GMT-relative and trusts it', () => {
    const base = 'Tue, 3 Jun 2025 12:00:00';
    expect(parseEmailDate(`${base} GMT +0200`)).toMatchObject({
      utcMs: utc('2025-06-03T10:00:00Z'),
      offsetMinutes: 120,
      zoneKnown: true,
    });
    expect(parseEmailDate(`${base} UT +0200`)).toMatchObject({
      utcMs: utc('2025-06-03T10:00:00Z'),
      offsetMinutes: 120,
      zoneKnown: true,
    });
    expect(parseEmailDate(`${base} UTC -0300`)).toMatchObject({
      utcMs: utc('2025-06-03T15:00:00Z'),
      offsetMinutes: -180,
      zoneKnown: true,
    });
  });

  it('trusts a US zone name followed by the same offset', () => {
    expect(parseEmailDate('Tue, 3 Jun 2025 12:00:00 EST -0500')).toMatchObject({
      utcMs: utc('2025-06-03T17:00:00Z'),
      offsetMinutes: -300,
      zoneKnown: true,
    });
  });

  it('uses the offset but flags zoneKnown false when a US zone name contradicts it', () => {
    expect(parseEmailDate('Tue, 3 Jun 2025 12:00:00 EST +0200')).toMatchObject({
      utcMs: utc('2025-06-03T10:00:00Z'),
      offsetMinutes: 120,
      zoneKnown: false,
    });
  });

  it('ignores "-0000" after GMT (not a valid following offset)', () => {
    expect(parseEmailDate('Tue, 3 Jun 2025 12:00:00 GMT -0000')).toMatchObject({
      utcMs: utc('2025-06-03T12:00:00Z'),
      offsetMinutes: 0,
      zoneKnown: true,
    });
  });

  it('keeps the name offset but flags zoneKnown false when an out-of-range offset follows it', () => {
    expect(parseEmailDate('Tue, 3 Jun 2025 12:00:00 GMT +2500')).toMatchObject({
      utcMs: utc('2025-06-03T12:00:00Z'),
      offsetMinutes: 0,
      zoneKnown: false,
    });
    expect(parseEmailDate('Tue, 3 Jun 2025 12:00:00 EST +2500')).toMatchObject({
      utcMs: utc('2025-06-03T17:00:00Z'),
      offsetMinutes: -300,
      zoneKnown: false,
    });
  });
});
