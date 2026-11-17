// Measurement for thread reconstruction (milestone 7). Runs a boundary
// detector over every generated conversation (tests/support/thread-cases.ts,
// built with tests/support/thread-builder.ts, so the true header offsets are
// known) and reports, per group and per quote style:
// - recall: true headers whose start the detector found exactly,
// - precision: found headers that start at a true header,
// - kind / headEnd: of the found true headers, how many have the right kind
//   (reply or forward) and the right end of the header lines,
// - fields / hdrEnd*: of the found true headers, how many have every field
//   read right by readQuotedHeader (quoted-header.ts: from, to, cc, subject,
//   date text, header end, compared with the builder's ground truth), and how
//   many have the right header end once read (it fixes wrapped To/Cc),
// - extra: found boundaries that start at no true header (precision's
//   complement, as a count),
// - false splits: boundaries found in the negative bodies that hold no
//   header at all; on the 'refuse' negatives, boundaries found anywhere but
//   at the real header.
//
// Two detectors are measured:
// - findReplyHeaders (reply-header.ts), the boundary finder: a BASELINE of
//   what it does (asserted as a ratchet, so detection may improve but not
//   regress);
// - the splitter of task 7.4, reconstructQuotedMessages (reconstruct.ts),
//   against the milestone targets (recall >= 90% per quote style, precision
//   100%, 0 extra boundaries, 0 false splits, the 'refuse' negatives refused).
//   For it the table also gives, of the found true headers: gen/depth (the
//   right generation and body depth) and text (reconstructedText, trimmed,
//   equals the message's own text as written).

import { describe, expect, it } from 'vitest';
import { NEGATIVE_CASES, REFUSAL_COST_CASES, THREAD_CASES, type ThreadCase } from '../../tests/support/thread-cases';
import type { QuoteStyle } from '../../tests/support/thread-builder';
import { fieldDiffs } from '../../tests/support/quoted-header-truth';
import { readQuotedHeader, type QuotedHeaderFields } from './quoted-header';
import { reconstructQuotedMessages } from './reconstruct';
import { findReplyHeaders } from './reply-header';

/** What a boundary detector reports for one header. */
interface Boundary {
    readonly start: number;
    readonly headEnd: number;
    readonly kind: 'reply' | 'forward';
    /** The splitter's own reading of the header (else readQuotedHeader is run here). */
    readonly fields?: QuotedHeaderFields;
    /** The splitter only: generation, body depth and rebuilt text. */
    readonly rebuilt?: { readonly generation: number; readonly depth: number; readonly text: string };
}
type Detect = (body: string, subject: string) => readonly Boundary[];

interface Tally {
    truths: number;
    found: number;
    matched: number;
    kindOk: number;
    headEndOk: number;
    /** All fields read right (readQuotedHeader). */
    fieldsOk: number;
    /** Header end right once read (readQuotedHeader). */
    headerEndOk: number;
    /** Found boundaries at no true header. */
    extra: number;
    /** The splitter only: right generation and body depth. */
    structureOk: number;
    /** The splitter only: rebuilt text (trimmed) equals the own text. */
    textOk: number;
}

const empty = (): Tally => ({ truths: 0, found: 0, matched: 0, kindOk: 0, headEndOk: 0, fieldsOk: 0, headerEndOk: 0, extra: 0, structureOk: 0, textOk: 0 });

interface Measurement {
    readonly byGroup: ReadonlyMap<string, Tally>;
    readonly byStyle: ReadonlyMap<QuoteStyle, Tally>;
    /** Missed true headers, "case id: generation style". */
    readonly misses: readonly string[];
    /** Found true headers with a field read wrong, "case id: generation style: differences". */
    readonly fieldMisses: readonly string[];
    /** The splitter only: found true headers whose rebuilt text differs from the own text. */
    readonly textMisses: readonly string[];
    /** The detector rebuilds messages (gen/depth and text are measured). */
    readonly rebuilds: boolean;
    /** Boundaries found in 'no-header' negatives, per case. */
    readonly falseSplits: ReadonlyMap<string, number>;
    /** Real headers found in 'refuse' negatives, per case (folding them is fine). */
    readonly refuseFound: ReadonlyMap<string, number>;
    /** Boundaries found in 'refuse' negatives at no real header, per case. */
    readonly refuseExtra: ReadonlyMap<string, number>;
}

function measure(detect: Detect, cases: readonly ThreadCase[] = THREAD_CASES): Measurement
{
    const byGroup = new Map<string, Tally>();
    const byStyle = new Map<QuoteStyle, Tally>();
    const misses: string[] = [];
    const fieldMisses: string[] = [];
    const textMisses: string[] = [];
    let rebuilds = false;
    const tally = <K>(map: Map<K, Tally>, key: K): Tally =>
    {
        let t = map.get(key);
        if (t === undefined)
        {
            map.set(key, (t = empty()));
        }
        return t;
    };
    for (const c of cases)
    {
        const found = detect(c.thread.body, c.thread.subject);
        const g = tally(byGroup, c.group);
        g.found += found.length;
        const truthStarts = new Set(c.thread.headers.map((h) => h.start));
        g.extra += found.filter((f) => !truthStarts.has(f.start)).length;
        for (const h of c.thread.headers)
        {
            const s = tally(byStyle, h.style);
            const hit = found.find((f) => f.start === h.start);
            const read = hit === undefined ? undefined : (hit.fields ?? readQuotedHeader(c.thread.body, hit));
            const rebuilt = hit?.rebuilt;
            if (rebuilt !== undefined)
            {
                rebuilds = true;
            }
            const textOk = rebuilt !== undefined && rebuilt.text.trim() === h.ownText;
            const diffs = read === undefined ? [] : fieldDiffs(h, read);
            for (const t of [g, s])
            {
                t.truths++;
                if (hit === undefined)
                {
                    continue;
                }
                t.matched++;
                if (hit.kind === h.kind)
                {
                    t.kindOk++;
                }
                if (hit.headEnd === h.headEnd)
                {
                    t.headEndOk++;
                }
                if (diffs.length === 0)
                {
                    t.fieldsOk++;
                }
                if (read?.headerEnd === h.headEnd)
                {
                    t.headerEndOk++;
                }
                if (rebuilt !== undefined && rebuilt.generation === h.generation && rebuilt.depth === h.textDepth)
                {
                    t.structureOk++;
                }
                if (textOk)
                {
                    t.textOk++;
                }
            }
            if (rebuilt !== undefined && !textOk)
            {
                textMisses.push(`${c.id}: generation ${h.generation} (${h.style})`);
            }
            if (hit === undefined)
            {
                misses.push(`${c.id}: generation ${h.generation} (${h.style})`);
            }
            else if (diffs.length > 0)
            {
                fieldMisses.push(`${c.id}: generation ${h.generation} (${h.style}): ${diffs.join('; ')}`);
            }
        }
    }
    const falseSplits = new Map<string, number>();
    const refuseFound = new Map<string, number>();
    const refuseExtra = new Map<string, number>();
    for (const n of NEGATIVE_CASES)
    {
        const found = detect(n.body, n.subject);
        if (n.expect === 'no-header')
        {
            falseSplits.set(n.id, found.length);
            continue;
        }
        const real = found.filter((f) => n.realHeaders.includes(f.start)).length;
        refuseFound.set(n.id, real);
        refuseExtra.set(n.id, found.length - real);
    }
    return { byGroup, byStyle, misses, fieldMisses, textMisses, rebuilds, falseSplits, refuseFound, refuseExtra };
}

const pct = (part: number, whole: number): string => (whole === 0 ? '-' : `${Math.round((100 * part) / whole)}%`);

function table(m: Measurement): string
{
    const row = (name: string, t: Tally): string =>
        `${name.padEnd(20)} ${String(t.truths).padStart(3)} ${pct(t.matched, t.truths).padStart(6)} ${pct(t.matched, t.found).padStart(6)} ${String(t.extra).padStart(5)} ${pct(t.kindOk, t.matched).padStart(6)} ${pct(t.headEndOk, t.matched).padStart(7)} ${pct(t.fieldsOk, t.matched).padStart(6)} ${pct(t.headerEndOk, t.matched).padStart(7)} ${(m.rebuilds ? pct(t.structureOk, t.matched) : '-').padStart(9)} ${(m.rebuilds ? pct(t.textOk, t.matched) : '-').padStart(5)}`;
    const head = `${'group'.padEnd(20)} hdr recall  prec. extra   kind headEnd fields hdrEnd* gen/depth  text`;
    const byStyle = [...m.byStyle].map(([s, t]) => `${s.padEnd(20)} ${String(t.truths).padStart(3)} ${pct(t.matched, t.truths).padStart(6)} ${pct(t.fieldsOk, t.matched).padStart(6)}`);
    const negatives = [...m.falseSplits].map(([id, n]) => `  ${id}: ${n}`);
    const refuse = [...m.refuseFound].map(([id, n]) => `  ${id}: ${n} at the real header, ${m.refuseExtra.get(id) ?? 0} elsewhere`);
    return [
        head,
        ...[...m.byGroup].map(([g, t]) => row(g, t)),
        `${'style'.padEnd(20)} hdr recall fields`,
        ...byStyle,
        'false splits on no-header negatives:',
        ...negatives,
        'real headers found on refuse negatives (fold only; 7.4 must not split):',
        ...refuse,
        ...(m.misses.length === 0 ? [] : ['missed:', ...m.misses.map((s) => `  ${s}`)]),
        ...(m.fieldMisses.length === 0 ? [] : ['fields read wrong:', ...m.fieldMisses.map((s) => `  ${s}`)]),
        ...(m.textMisses.length === 0 ? [] : ['rebuilt text differs from the own text:', ...m.textMisses.map((s) => `  ${s}`)]),
    ].join('\n');
}

const current: Detect = (body, subject) => findReplyHeaders(body, subject);

/** The splitter of task 7.4. The source offset does not change boundaries; UTC is used. */
const splitter: Detect = (body, subject) =>
    reconstructQuotedMessages(body, { subject, sourceOffsetMinutes: 0 }).map((r) => ({
        start: r.start,
        headEnd: r.headerEnd,
        kind: r.kind,
        fields: { from: r.from, to: r.to, cc: r.cc, subject: r.subject, dateText: r.dateText, headerEnd: r.headerEnd, incomplete: r.incomplete },
        rebuilt: { generation: r.generation, depth: r.depth, text: r.reconstructedText },
    }));

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
    /**
     * Every field read right by readQuotedHeader (task 7.3), of the found true
     * headers, per group. Safety over coverage (quoted-header.ts, rule 1): a
     * names-only To list wrapped over several lines is never continued, since
     * a body line cannot be told apart from a name. In 'outlook-wrapped' the
     * two headers of the "outlook-nl wrapped names only" case are read short
     * (the names of the label line only, flagged incomplete; the Subject after
     * the wrapped lines is not read): 5 of 7. Nothing is lost, the lines stay
     * in the original text.
     */
    fields: { 'outlook-wrapped': 5 / 7 } as Readonly<Record<string, number>>,
    /** The same per quote style: the two refused headers are outlook-nl (7 of 9). */
    fieldsByStyle: { 'outlook-nl': 7 / 9 } as Readonly<Record<string, number>>,
    /** Right header end once read by readQuotedHeader, per group: the wrapped To/Cc gap of headEnd is closed, except for the refused names-only lists above (5 of 7). */
    headerEnd: { 'outlook-wrapped': 5 / 7 } as Readonly<Record<string, number>>,
    /** Found boundaries at no true header, per group (target: 0 each). Groups not listed must stay at 0. */
    extra: {} as Readonly<Record<string, number>>,
    /** Boundaries found per 'no-header' negative (target: 0 each). */
    falseSplits: {
        'header-like prose with a year': 1, // "From: / Sent: in March 2025 / Subject:" has date evidence
        'header-like prose under an underscore row': 1, // the same lines under a separator (case added in 7.4; the splitter refuses it)
        '">" list after a "wrote:" sentence': 1, // a bare "... wrote:" followed by a ">" block
        'story with a dated "wrote:"': 1, // "On 3 March the landlord wrote:" is a strong attribution with a digit
    } as Readonly<Record<string, number>>,
};

describe('thread reconstruction: measurement of the current boundary detector', () =>
{
    const m = measure(current);

    it('prints the table', () =>
    {
        console.log(`reconstruction baseline (findReplyHeaders):\n${table(m)}`);
        expect(m.byGroup.size).toBeGreaterThan(0);
    });

    it('keeps the baseline recall, kind and header end per group', () =>
    {
        for (const [group, t] of m.byGroup)
        {
            expect(t.matched / t.truths, `${group} recall`).toBeGreaterThanOrEqual(BASELINE.recall[group] ?? 1);
            expect(t.kindOk / t.matched, `${group} kind`).toBeGreaterThanOrEqual(BASELINE.kind[group] ?? 1);
            expect(t.headEndOk / t.matched, `${group} headEnd`).toBeGreaterThanOrEqual(BASELINE.headEnd[group] ?? 1);
        }
    });

    it('keeps the baseline field accuracy of readQuotedHeader per group and per style (task 7.3)', () =>
    {
        for (const [group, t] of m.byGroup)
        {
            expect(t.fieldsOk / t.matched, `${group} fields`).toBeGreaterThanOrEqual(BASELINE.fields[group] ?? 1);
            expect(t.headerEndOk / t.matched, `${group} header end once read`).toBeGreaterThanOrEqual(BASELINE.headerEnd[group] ?? 1);
        }
        for (const [style, t] of m.byStyle)
        {
            expect(t.fieldsOk / t.matched, `${style} fields`).toBeGreaterThanOrEqual(BASELINE.fieldsByStyle[style] ?? 1);
        }
    });

    it('keeps the baseline extra boundaries per group (boundaries at no true header)', () =>
    {
        for (const [group, t] of m.byGroup)
        {
            expect(t.extra, `${group} extra`).toBeLessThanOrEqual(BASELINE.extra[group] ?? 0);
        }
    });

    it('keeps the baseline false splits on negative bodies', () =>
    {
        for (const [id, n] of m.falseSplits)
        {
            expect(n, id).toBeLessThanOrEqual(BASELINE.falseSplits[id] ?? 0);
        }
        for (const id of Object.keys(BASELINE.falseSplits))
        {
            expect(m.falseSplits.has(id), id).toBe(true);
        }
    });

    it('finds the real header of the refuse negatives (folding it is fine)', () =>
    {
        for (const [id, n] of m.refuseFound)
        {
            expect(n, id).toBe(1);
        }
    });

    it('finds no other boundary in the refuse negatives (today: none)', () =>
    {
        expect(m.refuseExtra.size).toBeGreaterThan(0);
        for (const [id, n] of m.refuseExtra)
        {
            expect(n, id).toBe(0);
        }
    });
});

// Milestone 7 targets, met by the splitter of task 7.4.
describe('thread reconstruction: milestone 7 targets (task 7.4, reconstructQuotedMessages)', () =>
{
    const m = measure(splitter);

    it('prints the table', () =>
    {
        console.log(`reconstruction (reconstructQuotedMessages):
${table(m)}`);
        expect(m.byStyle.size).toBeGreaterThan(0);
    });

    it('boundary recall >= 90% for every supported style', () =>
    {
        for (const [style, t] of m.byStyle)
        {
            expect(t.matched / t.truths, style).toBeGreaterThanOrEqual(0.9);
        }
    });

    // Precision and extra follow from "false splits 0" (design 7.0): a
    // boundary at no true header is a false split inside a real thread.
    it('precision 100% and no extra boundary in every group', () =>
    {
        for (const [group, t] of m.byGroup)
        {
            expect(t.extra, `${group} extra`).toBe(0);
            expect(t.matched / t.found, `${group} precision`).toBe(1);
        }
    });

    it('no boundary in the refuse negatives other than (at most) the real header', () =>
    {
        for (const [id, n] of m.refuseExtra)
        {
            expect(n, id).toBe(0);
        }
    });

    it('no false splits on negative bodies', () =>
    {
        for (const [id, n] of m.falseSplits)
        {
            expect(n, id).toBe(0);
        }
    });

    it('refuses the "refuse" negatives (interleaved answers, bottom-posting): no rebuilt message', () =>
    {
        expect(m.refuseFound.size).toBeGreaterThan(0);
        for (const [id, n] of m.refuseFound)
        {
            expect(n, id).toBe(0);
        }
    });

    it('every rebuilt true header has the right generation and body depth', () =>
    {
        for (const [group, t] of m.byGroup)
        {
            expect(t.structureOk, group).toBe(t.matched);
        }
    });

    it('keeps the field accuracy of readQuotedHeader (same baseline as the boundary finder)', () =>
    {
        for (const [group, t] of m.byGroup)
        {
            expect(t.fieldsOk / t.matched, `${group} fields`).toBeGreaterThanOrEqual(BASELINE.fields[group] ?? 1);
        }
        for (const [style, t] of m.byStyle)
        {
            expect(t.fieldsOk / t.matched, `${style} fields`).toBeGreaterThanOrEqual(BASELINE.fieldsByStyle[style] ?? 1);
        }
    });

    // A ratchet like BASELINE: groups not listed must stay at 1 (100%).
    const TEXT_BASELINE: Readonly<Record<string, number>> = { 'outlook-wrapped': 5 / 7 };
    it('rebuilt text equals the own text (trimmed), except where a header is read short', () =>
    {
        for (const [group, t] of m.byGroup)
        {
            expect(t.textOk / t.matched, `${group} text`).toBeGreaterThanOrEqual(TEXT_BASELINE[group] ?? 1);
        }
    });
});

// The cost of refusing (REFUSAL_COST_CASES, tests/support/thread-cases.ts):
// real threads in shapes the splitter refuses on purpose, and with them the
// messages that hold the refused header. Measured apart from the per-style
// targets above (they are not a supported style); recorded as a ratchet.
describe('thread reconstruction: recall cost of refusing (task 7.4, measured apart)', () =>
{
    const boundary = measure(current, REFUSAL_COST_CASES);
    const split = measure(splitter, REFUSAL_COST_CASES);
    const only = (m: Measurement): Tally => m.byGroup.get('refusal-cost') ?? empty();

    it('prints the table', () =>
    {
        const rows = (m: Measurement): string => table(m).split('\nfalse splits')[0] ?? '';
        console.log(`refusal cost, findReplyHeaders:\n${rows(boundary)}\nrefusal cost, reconstructQuotedMessages:\n${rows(split)}`);
        expect(only(split).truths).toBe(4);
    });

    it('the boundary finder finds every true header', () =>
    {
        expect(only(boundary).matched).toBe(only(boundary).truths);
    });

    it('the splitter rebuilds nothing wrong: no extra boundary, and what it keeps is right', () =>
    {
        const t = only(split);
        expect(t.extra).toBe(0);
        expect(t.structureOk).toBe(t.matched);
        expect(t.textOk).toBe(t.matched);
    });

    // Recorded when the cases were added: both shapes are refused whole (0 of 4).
    // A ratchet: may go up if a later task rebuilds them safely.
    it('recall today (ratchet)', () =>
    {
        expect(only(split).matched).toBeGreaterThanOrEqual(0);
    });
});

// "0 wrong suppressions" (no rebuilt message linked to a real file or merged
// with a copy of another message) is measured in the engine, with the other
// task 7.5 targets: src/engine/rebuild-links.measure.test.ts.
