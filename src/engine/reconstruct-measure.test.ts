// Measurement for thread reconstruction (milestone 7). Runs a boundary
// detector over every generated conversation (tests/support/thread-cases.ts,
// built with tests/support/thread-builder.ts, so the true header offsets are
// known) and reports, per group and per quote style:
// - recall: true headers whose start the detector found exactly,
// - precision: found headers that start at a true header,
// - kind / headEnd: of the found true headers, how many have the right kind
//   (reply or forward) and the right end of the header lines,
// - extra: found boundaries that start at no true header (precision's
//   complement, as a count),
// - false splits: boundaries found in the negative bodies that hold no
//   header at all; on the 'refuse' negatives, boundaries found anywhere but
//   at the real header.
//
// Today the detector is findReplyHeaders (reply-header.ts). This file only
// records a BASELINE: what it does now (asserted as a ratchet, so detection
// may improve but not regress). The milestone targets (recall >= 90% per
// supported style, 0 false splits) are in the skipped test at the bottom,
// for task 7.4 to switch on with its splitter plugged in as `detect`.

import { describe, expect, it } from 'vitest';
import { NEGATIVE_CASES, THREAD_CASES } from '../../tests/support/thread-cases';
import type { QuoteStyle } from '../../tests/support/thread-builder';
import { findReplyHeaders } from './reply-header';

/** What a boundary detector reports for one header. */
interface Boundary {
  readonly start: number;
  readonly headEnd: number;
  readonly kind: 'reply' | 'forward';
}
type Detect = (body: string, subject: string) => readonly Boundary[];

interface Tally {
  truths: number;
  found: number;
  matched: number;
  kindOk: number;
  headEndOk: number;
  /** Found boundaries at no true header. */
  extra: number;
}

const empty = (): Tally => ({ truths: 0, found: 0, matched: 0, kindOk: 0, headEndOk: 0, extra: 0 });

interface Measurement {
  readonly byGroup: ReadonlyMap<string, Tally>;
  readonly byStyle: ReadonlyMap<QuoteStyle, Tally>;
  /** Missed true headers, "case id: generation style". */
  readonly misses: readonly string[];
  /** Boundaries found in 'no-header' negatives, per case. */
  readonly falseSplits: ReadonlyMap<string, number>;
  /** Real headers found in 'refuse' negatives, per case (folding them is fine). */
  readonly refuseFound: ReadonlyMap<string, number>;
  /** Boundaries found in 'refuse' negatives at no real header, per case. */
  readonly refuseExtra: ReadonlyMap<string, number>;
}

function measure(detect: Detect): Measurement {
  const byGroup = new Map<string, Tally>();
  const byStyle = new Map<QuoteStyle, Tally>();
  const misses: string[] = [];
  const tally = <K>(map: Map<K, Tally>, key: K): Tally => {
    let t = map.get(key);
    if (t === undefined) map.set(key, (t = empty()));
    return t;
  };
  for (const c of THREAD_CASES) {
    const found = detect(c.thread.body, c.thread.subject);
    const g = tally(byGroup, c.group);
    g.found += found.length;
    const truthStarts = new Set(c.thread.headers.map((h) => h.start));
    g.extra += found.filter((f) => !truthStarts.has(f.start)).length;
    for (const h of c.thread.headers) {
      const s = tally(byStyle, h.style);
      const hit = found.find((f) => f.start === h.start);
      for (const t of [g, s]) {
        t.truths++;
        if (hit === undefined) continue;
        t.matched++;
        if (hit.kind === h.kind) t.kindOk++;
        if (hit.headEnd === h.headEnd) t.headEndOk++;
      }
      if (hit === undefined) misses.push(`${c.id}: generation ${h.generation} (${h.style})`);
    }
  }
  const falseSplits = new Map<string, number>();
  const refuseFound = new Map<string, number>();
  const refuseExtra = new Map<string, number>();
  for (const n of NEGATIVE_CASES) {
    const found = detect(n.body, n.subject);
    if (n.expect === 'no-header') {
      falseSplits.set(n.id, found.length);
      continue;
    }
    const real = found.filter((f) => n.realHeaders.includes(f.start)).length;
    refuseFound.set(n.id, real);
    refuseExtra.set(n.id, found.length - real);
  }
  return { byGroup, byStyle, misses, falseSplits, refuseFound, refuseExtra };
}

const pct = (part: number, whole: number): string => (whole === 0 ? '-' : `${Math.round((100 * part) / whole)}%`);

function table(m: Measurement): string {
  const row = (name: string, t: Tally): string =>
    `${name.padEnd(20)} ${String(t.truths).padStart(3)} ${pct(t.matched, t.truths).padStart(6)} ${pct(t.matched, t.found).padStart(6)} ${String(t.extra).padStart(5)} ${pct(t.kindOk, t.matched).padStart(6)} ${pct(t.headEndOk, t.matched).padStart(7)}`;
  const head = `${'group'.padEnd(20)} hdr recall  prec. extra   kind headEnd`;
  const byStyle = [...m.byStyle].map(([s, t]) => `${s.padEnd(20)} ${String(t.truths).padStart(3)} ${pct(t.matched, t.truths).padStart(6)}`);
  const negatives = [...m.falseSplits].map(([id, n]) => `  ${id}: ${n}`);
  const refuse = [...m.refuseFound].map(([id, n]) => `  ${id}: ${n} at the real header, ${m.refuseExtra.get(id) ?? 0} elsewhere`);
  return [
    head,
    ...[...m.byGroup].map(([g, t]) => row(g, t)),
    `${'style'.padEnd(20)} hdr recall`,
    ...byStyle,
    'false splits on no-header negatives:',
    ...negatives,
    'real headers found on refuse negatives (fold only; 7.4 must not split):',
    ...refuse,
    ...(m.misses.length === 0 ? [] : ['missed:', ...m.misses.map((s) => `  ${s}`)]),
  ].join('\n');
}

const current: Detect = (body, subject) => findReplyHeaders(body, subject);

/**
 * Baseline of findReplyHeaders, measured when the case set was written
 * (task 7.1). A ratchet: rates may only go up, false splits only down.
 * Groups not listed must stay at 1 (100%). Update the numbers when
 * detection improves; a new case may need its own entry.
 */
const BASELINE = {
  /** Every true header's start is found today, in every group. */
  recall: {} as Readonly<Record<string, number>>,
  /** Right kind, of the found true headers: an Outlook forward that is not the first block reads as a reply (only the last subject says "FW:"). */
  kind: { forward: 17 / 18 } as Readonly<Record<string, number>>,
  /** Right header end, of the found true headers: a wrapped To/Cc line ends the label run early. */
  headEnd: { 'outlook-wrapped': 0 } as Readonly<Record<string, number>>,
  /** Found boundaries at no true header, per group (target: 0 each). Groups not listed must stay at 0. */
  extra: {} as Readonly<Record<string, number>>,
  /** Boundaries found per 'no-header' negative (target: 0 each). */
  falseSplits: {
    'header-like prose with a year': 1, // "From: / Sent: in March 2025 / Subject:" has date evidence
    '">" list after a "wrote:" sentence': 1, // a bare "... wrote:" followed by a ">" block
    'story with a dated "wrote:"': 1, // "On 3 March the landlord wrote:" is a strong attribution with a digit
  } as Readonly<Record<string, number>>,
};

describe('thread reconstruction: measurement of the current boundary detector', () => {
  const m = measure(current);

  it('prints the table', () => {
    console.log(`reconstruction baseline (findReplyHeaders):\n${table(m)}`);
    expect(m.byGroup.size).toBeGreaterThan(0);
  });

  it('keeps the baseline recall, kind and header end per group', () => {
    for (const [group, t] of m.byGroup) {
      expect(t.matched / t.truths, `${group} recall`).toBeGreaterThanOrEqual(BASELINE.recall[group] ?? 1);
      expect(t.kindOk / t.matched, `${group} kind`).toBeGreaterThanOrEqual(BASELINE.kind[group] ?? 1);
      expect(t.headEndOk / t.matched, `${group} headEnd`).toBeGreaterThanOrEqual(BASELINE.headEnd[group] ?? 1);
    }
  });

  it('keeps the baseline extra boundaries per group (boundaries at no true header)', () => {
    for (const [group, t] of m.byGroup) expect(t.extra, `${group} extra`).toBeLessThanOrEqual(BASELINE.extra[group] ?? 0);
  });

  it('keeps the baseline false splits on negative bodies', () => {
    for (const [id, n] of m.falseSplits) expect(n, id).toBeLessThanOrEqual(BASELINE.falseSplits[id] ?? 0);
    for (const id of Object.keys(BASELINE.falseSplits)) expect(m.falseSplits.has(id), id).toBe(true);
  });

  it('finds the real header of the refuse negatives (folding it is fine)', () => {
    for (const [id, n] of m.refuseFound) expect(n, id).toBe(1);
  });

  it('finds no other boundary in the refuse negatives (today: none)', () => {
    expect(m.refuseExtra.size).toBeGreaterThan(0);
    for (const [id, n] of m.refuseExtra) expect(n, id).toBe(0);
  });
});

// Milestone 7 targets. Switched on by task 7.4, with its splitter as `detect`.
describe.skip('thread reconstruction: milestone 7 targets (task 7.4)', () => {
  const m = measure(current);

  it('boundary recall >= 90% for every supported style', () => {
    for (const [style, t] of m.byStyle) expect(t.matched / t.truths, style).toBeGreaterThanOrEqual(0.9);
  });

  // Precision and extra follow from "false splits 0" (design 7.0): a
  // boundary at no true header is a false split inside a real thread.
  it('precision 100% and no extra boundary in every group', () => {
    for (const [group, t] of m.byGroup) {
      expect(t.extra, `${group} extra`).toBe(0);
      expect(t.matched / t.found, `${group} precision`).toBe(1);
    }
  });

  it('no boundary in the refuse negatives other than (at most) the real header', () => {
    for (const [id, n] of m.refuseExtra) expect(n, id).toBe(0);
  });

  it('no false splits on negative bodies', () => {
    for (const [id, n] of m.falseSplits) expect(n, id).toBe(0);
  });
});

describe('thread reconstruction: targets for later tasks', () => {
  it.todo('7.4: the splitter refuses the "refuse" negatives (interleaved answers, bottom-posting): no reconstructed message');
  it.todo('7.4/7.5: 0 wrong suppressions (no reconstructed message hidden as a duplicate when it is not one)');
  it.todo('7.3: header fields (from, date, to, cc, subject) equal ExpectedHeader.fields, wrapped To/Cc included');
});
