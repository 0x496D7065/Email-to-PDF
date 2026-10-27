// Unit tests for what step 2 shows of the emails rebuilt from quoted text
// (src/ui-model/rebuilt.ts). Synthetic fixtures only (tests/fixtures/eml),
// run through the real engine; a few results are then edited by hand to
// reach the rare cases (no sender, a list read short, a bad timeline).
import { beforeAll, describe, expect, it } from 'vitest';
import { parseAllFixtures } from '../../tests/fixtures/parse-all';
import { runEngine, type EngineRebuilt, type EngineResult } from '../engine/engine';
import type { QuotedDate } from '../engine/quoted-date';
import type { NormalizedMessage } from '../parsing/types';
import {
  alsoNumbers,
  createRebuiltSelection,
  includedRebuilt,
  previewOrder,
  rebuiltCard,
  rebuiltDate,
  rebuiltEntries,
  rebuiltInPdf,
  rebuiltSelectionKeys,
  rebuiltSources,
  sourceNumber,
} from './rebuilt';

let fixtures: Map<string, NormalizedMessage>;

beforeAll(async () => {
  fixtures = new Map((await parseAllFixtures()).map((m) => [m.source.fileName, m]));
});

const fixture = (name: string): NormalizedMessage => {
  const m = fixtures.get(`eml/${name}`);
  if (m === undefined) throw new Error(`no fixture ${name}`);
  return m;
};
const engineOf = (...names: string[]): EngineResult => runEngine(names.map((n) => ({ ok: true as const, message: fixture(n) })));

/** A copy of `result` with rebuilt message `id` changed by `edit`. */
function withRebuilt(result: EngineResult, id: number, edit: (r: EngineRebuilt) => EngineRebuilt): EngineResult {
  return { ...result, reconstructed: result.reconstructed.map((r) => (r.id === id ? edit(r) : r)) };
}

describe('previewOrder and rebuiltEntries', () => {
  it('follow the timeline: rebuilt entries before the email that quotes them, oldest first', () => {
    const result = engineOf('13-order-4-bob-outlook-nl.eml');
    expect(result.messages).toHaveLength(1);
    const order = previewOrder(result);
    expect(order).toEqual([
      { kind: 'rebuilt', id: 2 },
      { kind: 'rebuilt', id: 1 },
      { kind: 'rebuilt', id: 0 },
      { kind: 'message', position: 0 },
    ]);
    expect(rebuiltEntries(result).map((r) => r.id)).toEqual([2, 1, 0]);
  });

  it('give no card to a rebuilt email that matches a real file (the real file wins)', () => {
    const result = engineOf('10-order-1-alice.eml', '11-order-2-bob-outlook-en.eml', '12-order-3-alice-gmail.eml', '13-order-4-bob-outlook-nl.eml');
    expect(result.reconstructed.length).toBeGreaterThan(0);
    expect(result.reconstructed.every((r) => r.link === 'real')).toBe(true);
    expect(rebuiltEntries(result)).toEqual([]);
    expect(previewOrder(result)).toEqual(result.messages.map((_, position) => ({ kind: 'message', position })));
  });

  it('give one card per quoted text: copies quoted in several emails are listed on the entry, not shown twice', () => {
    const result = engineOf('12-order-3-alice-gmail.eml', '13-order-4-bob-outlook-nl.eml');
    const entries = rebuiltEntries(result);
    const sameAs = result.reconstructed.filter((r) => r.link === 'same-as');
    expect(sameAs.length).toBeGreaterThan(0);
    for (const copy of sameAs) expect(entries.map((e) => e.id)).not.toContain(copy.id);
    const shared = entries.filter((e) => e.alsoQuotedIn.length > 0);
    expect(shared.length).toBeGreaterThan(0);
    for (const e of shared) expect(alsoNumbers(e, result)).toHaveLength(1);
  });

  it('fall back to the real emails alone, in list order, when the timeline is broken (never an email missing)', () => {
    const result = engineOf('13-order-4-bob-outlook-nl.eml');
    const plain = [{ kind: 'message', position: 0 }];
    expect(previewOrder({ ...result, timeline: [] })).toEqual(plain);
    expect(previewOrder({ ...result, timeline: [...result.timeline, { kind: 'message', position: 0 }] })).toEqual(plain);
    expect(previewOrder({ ...result, timeline: [{ kind: 'rebuilt', id: 99, placement: 'by-date' }, { kind: 'message', position: 0 }] })).toEqual(plain);
    expect(previewOrder({ ...result, timeline: undefined as never })).toEqual(plain);
    // A rebuilt message that is not an entry never gets a place of its own.
    const notEntry = withRebuilt(result, 2, (r) => ({ ...r, link: 'same-as', sameAs: 1 }));
    expect(previewOrder(notEntry)).toEqual(plain);
  });
});

describe('source and "also in" numbers', () => {
  it('give the list number of the email a rebuilt email was taken from', () => {
    const result = engineOf('70-no-date.eml', '13-order-4-bob-outlook-nl.eml');
    const position = result.messages.findIndex((m) => m.message.source.fileName.endsWith('13-order-4-bob-outlook-nl.eml'));
    for (const r of rebuiltEntries(result)) expect(sourceNumber(r, result)).toBe(position + 1);
  });

  it('never list the source itself or unknown positions as "also in"', () => {
    const result = engineOf('13-order-4-bob-outlook-nl.eml');
    const r = rebuiltEntries(result)[0] as EngineRebuilt;
    expect(alsoNumbers({ ...r, alsoQuotedIn: [r.sourceIndex, 42, r.sourceIndex] }, result)).toEqual([]);
  });
});

describe('the include choices', () => {
  it('include every rebuilt email by default; the switch leaves them ALL out, and back', () => {
    const result = engineOf('13-order-4-bob-outlook-nl.eml');
    const selection = createRebuiltSelection();
    expect(selection.includeAll()).toBe(true);
    expect(includedRebuilt(result, selection).map((r) => r.id)).toEqual([2, 1, 0]);
    selection.setIncludeAll(false);
    expect(includedRebuilt(result, selection)).toEqual([]);
    for (const r of rebuiltEntries(result)) {
      expect(selection.isIncluded(r, result)).toBe(false);
      expect(selection.isTicked(r, result)).toBe(true); // the cards' own ticks are kept
    }
    selection.setIncludeAll(true);
    expect(includedRebuilt(result, selection)).toHaveLength(3);
  });

  it('leave one card out with its own checkbox, and forget every choice on clear()', () => {
    const result = engineOf('13-order-4-bob-outlook-nl.eml');
    const selection = createRebuiltSelection();
    const one = rebuiltEntries(result)[1] as EngineRebuilt;
    selection.setTicked(one, result, false);
    expect(includedRebuilt(result, selection).map((r) => r.id)).toEqual([2, 0]);
    selection.setIncludeAll(false);
    selection.clear();
    expect(selection.includeAll()).toBe(true);
    expect(includedRebuilt(result, selection)).toHaveLength(3);
  });

  it('remember a choice by source file and place, so it survives adding more files (ids change)', () => {
    const before = engineOf('13-order-4-bob-outlook-nl.eml');
    const selection = createRebuiltSelection();
    const bob = rebuiltEntries(before).find((r) => r.rebuilt.from[0]?.address === 'bob@furniture.example.test') as EngineRebuilt;
    selection.setTicked(bob, before, false);
    // More files: an undated email and one that quotes the same text.
    const after = engineOf('70-no-date.eml', '12-order-3-alice-gmail.eml', '13-order-4-bob-outlook-nl.eml');
    const bobAfter = rebuiltEntries(after).filter((r) => r.rebuilt.from[0]?.address === 'bob@furniture.example.test');
    expect(bobAfter).toHaveLength(1);
    expect(selection.isTicked(bobAfter[0] as EngineRebuilt, after)).toBe(false);
    // Its keys cover every copy (the entry and the copy quoted in the other email).
    const keys = rebuiltSelectionKeys(bobAfter[0] as EngineRebuilt, after);
    expect(keys.length).toBe(1 + (bobAfter[0] as EngineRebuilt).copies.length);
    for (const key of keys) expect(key).toMatch(/^[0-9a-f]{64}@\d+$/);
    // The others stay included.
    expect(includedRebuilt(after, selection).every((r) => r !== bobAfter[0])).toBe(true);
    expect(includedRebuilt(after, selection).length).toBe(rebuiltEntries(after).length - 1);
  });
});

describe('rebuiltDate', () => {
  const r = (dateText: string | null, date: Partial<QuotedDate> | null, dateApproximate = true): Pick<EngineRebuilt, 'rebuilt'> =>
    ({
      rebuilt: {
        dateText,
        dateApproximate,
        date: date === null ? null : { text: dateText ?? '', wallMs: null, precision: null, estimatedUtcMs: null, basis: 'none', ...date },
      },
    }) as unknown as Pick<EngineRebuilt, 'rebuilt'>;

  it('has no date without a date text, and shows an unreadable one as written only', () => {
    expect(rebuiltDate(r(null, null))).toEqual({ kind: 'none' });
    expect(rebuiltDate(r('  ', null))).toEqual({ kind: 'none' });
    expect(rebuiltDate(r('yesterday', { wallMs: null }))).toEqual({ kind: 'unreadable', text: 'yesterday' });
  });

  it('gives a moment with "approximate" when the date has a time, and a day as written when it has none', () => {
    const ms = Date.parse('2025-03-03T14:40:00Z');
    expect(rebuiltDate(r('maandag 3 maart 2025 15:40', { wallMs: ms, precision: 'minute', estimatedUtcMs: ms }))).toEqual({
      kind: 'moment',
      utcMs: ms,
      approximate: true,
      text: 'maandag 3 maart 2025 15:40',
    });
    const day = Date.parse('2025-03-03T00:00:00Z');
    expect(rebuiltDate(r('3 March 2025', { wallMs: day, precision: 'day', estimatedUtcMs: day - 3_600_000 }, false))).toEqual({
      kind: 'day',
      day: '2025-03-03',
      approximate: false,
      text: '3 March 2025',
    });
  });
});

describe('rebuiltCard', () => {
  it('gives the fields read from the quoted header, the source number and the text', () => {
    const result = engineOf('13-order-4-bob-outlook-nl.eml');
    const [outlookNl, gmail, outlookEn] = rebuiltEntries(result).map((r) => rebuiltCard(r, result)).reverse();
    // The newest quoted email (an Outlook block in Dutch): a subject, no quote marks.
    expect(outlookNl?.subject).toBe('Re: Office desks and chairs');
    expect(outlookNl?.from.map((m) => m.address)).toEqual(['alice@example.test']);
    expect(outlookNl?.quoteMarksRemoved).toBe(false);
    expect(outlookNl?.sourceNumber).toBe(1);
    expect(outlookNl?.date.kind).toBe('moment');
    // A Gmail attribution: never a subject; ">" marks removed from its text.
    expect(gmail?.subject).toBeNull();
    expect(gmail?.quoteMarksRemoved).toBe(true);
    expect(gmail?.text).toContain('I can come by on W');
    expect(gmail?.text).not.toMatch(/^>/m);
    expect(outlookEn?.subject).toBe('Office desks and chairs');
  });

  it('flags a list that may go on and leaves blank mailboxes out (no sender: "unknown")', () => {
    const result = engineOf('13-order-4-bob-outlook-nl.eml');
    const edited = withRebuilt(result, 0, (r) => ({
      ...r,
      rebuilt: { ...r.rebuilt, from: [{ name: ' ', address: '' }], incomplete: ['cc'], subject: '  ' },
    }));
    const card = rebuiltCard(edited.reconstructed[0] as EngineRebuilt, edited);
    expect(card.from).toEqual([]);
    expect(card.ccIncomplete).toBe(true);
    expect(card.toIncomplete).toBe(false);
    expect(card.subject).toBeNull();
  });
});

describe('the follow-source rule (rebuiltSources, rebuiltInPdf; task 7.7, user decision Q1 (a))', () => {
  /** Entries quoted in both emails, with their copy. */
  const shared = (result: EngineResult) => rebuiltEntries(result).filter((e) => e.copies.length > 0);

  it('lists the entry first, then its copies, each with the list position of the email it was read from', () => {
    const result = engineOf('12-order-3-alice-gmail.eml', '13-order-4-bob-outlook-nl.eml');
    const entries = shared(result);
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      const sources = rebuiltSources(e, result);
      expect(sources[0]).toEqual({ rebuilt: e, position: result.positionByIndex[e.sourceIndex] });
      expect(sources.slice(1).map((s) => s.rebuilt.id)).toEqual(e.copies);
    }
    // A copy that does not point back to the entry is not one of its sources (not expected).
    const e = entries[0]!;
    const broken = { ...result, reconstructed: result.reconstructed.map((r) => (r.id === e.copies[0] ? { ...r, sameAs: 999 } : r)) };
    expect(rebuiltSources(e, broken).map((s) => s.rebuilt.id)).toEqual([e.id, ...e.copies.slice(1)]);
  });

  it('keeps an entry while one of its emails is in the PDF, names that one, and lists the others as "also in"', () => {
    const result = engineOf('12-order-3-alice-gmail.eml', '13-order-4-bob-outlook-nl.eml');
    for (const e of shared(result)) {
      const own = result.positionByIndex[e.sourceIndex]!;
      const copy = result.reconstructed[e.copies[0]!]!;
      const other = result.positionByIndex[copy.sourceIndex]!;
      // PDF numbers: own = 7, other = 3 (any numbers: the rule uses what it is given).
      const numbers = new Map([
        [own, 7],
        [other, 3],
      ]);
      const both = rebuiltInPdf(e, result, (p) => numbers.get(p) ?? null);
      expect(both).toEqual({ shown: { rebuilt: e, position: own }, number: 7, also: [3] });
      const otherOnly = rebuiltInPdf(e, result, (p) => (p === other ? 3 : null));
      expect(otherOnly).toEqual({ shown: { rebuilt: copy, position: other }, number: 3, also: [] });
      expect(rebuiltInPdf(e, result, () => null)).toBeNull();
    }
  });

  it('a rebuilt email quoted in one email only: in the PDF exactly while that email is', () => {
    const result = engineOf('13-order-4-bob-outlook-nl.eml');
    for (const e of rebuiltEntries(result)) {
      expect(rebuiltInPdf(e, result, () => 1)).toEqual({ shown: { rebuilt: e, position: 0 }, number: 1, also: [] });
      expect(rebuiltInPdf(e, result, () => null)).toBeNull();
    }
  });
});
