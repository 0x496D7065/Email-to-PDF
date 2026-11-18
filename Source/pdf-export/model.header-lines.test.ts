// Task 8.13a (user rule 2026-11-09): with "Print full original text" off,
// the PDF shows no header-looking lines of another email inside an email's
// text. Checked as a general INVARIANT on the PDF document model, with the
// engine's own quoted-header detection (findReplyHeaders, the detector that
// reconstruct-quoted-messages.ts reads its places from), over every conversation of
// Helper/Test/test-support/thread-cases.ts (several sets of files, every rebuilt email
// ticked, none, every other one) and over the fixture set:
//
// 1. No header shown. For every real email of the PDF, no header block that
//    findReplyHeaders finds in its body ([start, headEnd): an "On ...
//    wrote:" line, a "From: / Sent: / To: / Subject:" block, a forward
//    marker with its lines) has a character printed, EXCEPT a header the
//    engine could not rebuild (no place of result.reconstructed starts
//    there: reconstruct-quoted-messages.ts refused it, or it lies in an attached email the
//    .eml reader writes after the forwarded-message separator, task 8.13b),
//    and a header whose email is not in the PDF at all (its rebuilt email
//    unticked, or the switch off, and not a forwarded part: nothing else
//    prints it, so it stays inline, collapse never delete). A forwarded
//    part of an unticked rebuilt email is never exempt (Q2: left out).
//    Nothing else is exempt: the writer's answer kept with its quote (B1,
//    Q3) does not occur in these conversations (a violation would say so;
//    that case is tested in Source/pdf-export/model.no-repeat.test.ts, B1).
// 2. A rebuilt email's text holds no header block below the header lines
//    moved to its top (Q4).
// 3. Collapse, never delete: every character a body loses to the no-repeat
//    rule is printed in the email it names (a rebuilt email: its text, the
//    header rows, or the header lines moved to its top; a real file: its
//    own text and header rows), or, for a forwarded part of an unticked
//    rebuilt email (Q2), nowhere in the PDF but in the preview and with
//    "Print full original text" (which prints every body whole). Header
//    lines moved to a rebuilt email are printed exactly once in the PDF.
// Every PDF email starting on a page of its own with its index line is
// checked on the written file (Source/pdf-export/generate.header-blocks.test.ts).
// Synthetic data only (README.md, rule R7).
import { beforeAll, describe, expect, it } from 'vitest';
import { parseAllFixtures } from '../../Helper/Test/test-data/parse-all';
import { buildThread, instantOf, type ThreadMessage } from '../../Helper/Test/test-support/thread-builder';
import { THREAD_CASES } from '../../Helper/Test/test-support/thread-cases';
import { analyzeThread } from '../thread-analysis/analyze-thread';
import { DEFAULT_OUTPUT_POLICY, planOutput } from '../thread-analysis/output-plan';
import { findReplyHeaders } from '../thread-analysis/reply-header';
import { rebuiltEntries } from '../web-page-logic/rebuilt-email-display';
import { buildPdfDocument, noRepeat, pdfRanges } from './model';
import { createPdfStrings } from './strings';
import { bodyLines, lineText } from './text';
import type { MessagePlan, OutputPolicy } from '../../Header/output-plan';
import type { NormalizedMessage } from '../../Header/parsed-email';
import type { PdfDocument, PdfEmail, PdfRange } from '../../Header/pdf-document-model';
import type { EngineResult } from '../../Header/thread-analysis-result';

const EN = createPdfStrings('en');
const FULL: OutputPolicy = { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true };

let fixtures: NormalizedMessage[];
beforeAll(async () =>
{
    fixtures = await parseAllFixtures();
});

/** Message `i` of a conversation as a real file (its body quotes the ones before it). */
function realFile(messages: readonly ThreadMessage[], i: number, tag: string): NormalizedMessage
{
    const m = messages[i]!;
    const id = (k: number): string => `${tag}-${String(k)}@example.test`;
    const utcMs = instantOf(m.sent, m.zone);
    return {
        messageId: id(i),
        inReplyTo: i === 0 ? null : id(i - 1),
        references: Array.from({ length: i }, (_, k) => id(k)),
        date: { utcMs, original: new Date(utcMs).toUTCString(), offsetMinutes: m.zone.offsetMinutes, zoneKnown: true },
        from: [m.from],
        to: m.to,
        cc: m.cc ?? [],
        bcc: [],
        subject: m.subject,
        bodyText: buildThread(messages.slice(0, i + 1)).body,
        attachments: [],
        source: { fileName: `${tag}-${String(i)}.eml`, sha256: (i + 1).toString(16).padStart(64, '0'), kind: 'eml' },
        warnings: [],
    };
}

/** A line set compared: quote marks at line starts and white space runs do not count. */
const squash = (s: string): string =>
    s
        .split(/\r\n?|\n/u)
        .map((l) => l.replace(/^(?:[ \t]*>)+[ \t]?/u, ''))
        .join(' ')
        .replace(/\s+/gu, ' ')
        .trim();
const bodyOf = (e: PdfEmail): string => e.body.map(lineText).join('\n');
const rowsOf = (e: PdfEmail): string => e.fields.map((f) => `${f.label} ${f.value.map(lineText).join(' ')}`).join('\n');

interface Made
{
    readonly result: EngineResult;
    readonly positions: readonly number[];
    readonly plans: readonly MessagePlan[];
    readonly rebuilt: readonly number[];
    /** "Rebuild conversation from replies" off (then `rebuilt` is []). */
    readonly rebuildingOff: boolean;
    /** The rebuilt emails the reader unticked: here every one not chosen (BuildPdfInput.unticked). */
    readonly unticked: readonly number[];
    readonly doc: PdfDocument;
}

function make(messages: readonly NormalizedMessage[], rebuilt: (ids: readonly number[]) => number[], policy: OutputPolicy = DEFAULT_OUTPUT_POLICY, rebuildingOff = false): Made
{
    const result = analyzeThread(messages.map((message) => ({ ok: true as const, message })));
    const positions = result.messages.map((_, k) => k);
    const plans = planOutput(
        positions.map((p) => result.messages[p]!),
        policy,
    );
    const ids = rebuiltEntries(result).map((r) => r.id);
    const chosen = rebuilt(ids);
    const unticked = ids.filter((id) => !chosen.includes(id));
    const doc = buildPdfDocument({ result, positions, plans, policy, rebuilt: chosen, rebuildingOff, unticked, timeZone: 'UTC', generatedAt: Date.UTC(2025, 5, 1, 12, 0, 0), strings: EN });
    return { result, positions, plans, rebuilt: chosen, rebuildingOff, unticked, doc };
}

/** What `made` prints of each real email's body, per character (the plan cut by the no-repeat rule), and the ranges. */
function printedOf(made: Made, k: number): { readonly kept: Uint8Array; readonly ranges: readonly PdfRange[] | null }
{
    const { result, positions, plans, rebuilt, rebuildingOff, unticked } = made;
    const position = positions[k]!;
    const body = result.messages[position]!.message.bodyText;
    const plan = plans[k]!;
    const kept = new Uint8Array(body.length);
    if (plan.fallback)
    {
        kept.fill(1);
        return { kept, ranges: null };
    }
    const parts = noRepeat({ result, positions, plans, policy: DEFAULT_OUTPUT_POLICY, rebuilt, rebuildingOff, unticked }).parts.get(position) ?? [];
    const ranges = pdfRanges(body, plan, DEFAULT_OUTPUT_POLICY, parts);
    for (const r of ranges ?? plan.ranges)
    {
        if (r.keep)
        {
            kept.fill(1, r.start, r.end);
        }
    }
    return { kept, ranges };
}

interface Stats
{
    /** Headers shown that the engine could not rebuild (no place). */
    exempt: number;
    /** Headers of a place whose email is not in the PDF (not an unticked forward): kept inline. */
    inline: number;
    /** Headers not shown (cut). */
    cut: number;
    /** Blocks of header lines moved to a rebuilt email. */
    moved: number;
    /** Parts left out with an unticked rebuilt email (Q2). */
    unticked: number;
}

/** Checks the invariant (top of this file) on `made` (folded); returns how many headers were found shown, exempt, and cut. */
function expectNoHeaderLines(made: Made, what: string): Stats
{
    const { result, positions, doc } = made;
    const stats: Stats = { exempt: 0, inline: 0, cut: 0, moved: 0, unticked: 0 };
    const violations: string[] = [];
    for (const [k, position] of positions.entries())
    {
        const message = result.messages[position]!.message;
        const body = message.bodyText;
        const email = doc.emails.find((e) => e.position === position);
        expect(email, `${what}: email at ${String(position)} in the PDF`).toBeDefined();
        const { kept, ranges } = printedOf(made, k);
        const places = new Set(result.reconstructed.filter((r) => result.positionByIndex[r.sourceIndex] === position).map((r) => r.rebuilt.start));
        // 1. No header block shown, except one the engine could not rebuild.
        for (const h of findReplyHeaders(body, message.subject))
        {
            let shown = false;
            for (let i = h.start; i < h.headEnd && !shown; i++)
            {
                shown = kept[i] === 1 && /\S/u.test(body[i]!);
            }
            if (!shown)
            {
                stats.cut++;
                continue;
            }
            if (!places.has(h.start))
            {
                stats.exempt++;
                continue;
            }
            const r = result.reconstructed.find((x) => result.positionByIndex[x.sourceIndex] === position && x.rebuilt.start === h.start)!;
            const plan = made.plans[k]!;
            // A place whose email is not in the PDF stays inline (nothing else prints it), unless it is a forwarded part of an unticked rebuilt email (Q2).
            const id = r.link === 'entry' ? r.id : r.link === 'same-as' ? r.sameAs : null;
            const realPosition = r.link === 'real' && r.realIndex !== null ? result.positionByIndex[r.realIndex] : undefined;
            const printed = id !== null ? doc.emails.some((e) => e.rebuilt?.id === id) : realPosition != null && doc.pdfNumberByPosition[realPosition] != null;
            const forwardedAt = plan.fallback ? null : (plan.ranges.find((x) => x.reason === 'forwarded')?.start ?? null);
            const untickedForward = !made.rebuildingOff && id !== null && made.unticked.includes(id) && forwardedAt !== null && r.rebuilt.start >= forwardedAt;
            if (!printed && !untickedForward)
            {
                stats.inline++;
                continue;
            }
            const reasons = [...new Set(plan.ranges.filter((x) => x.end > r.rebuilt.headerEnd && x.start < r.rebuilt.end && /\S/u.test(body.slice(Math.max(x.start, r.rebuilt.headerEnd), Math.min(x.end, r.rebuilt.end)))).map((x) => `${x.reason}${x.keep ? '+' : '-'}`))];
            const entryId = r.link === 'entry' ? r.id : r.sameAs;
            violations.push(`email ${String(email!.number)}: link ${r.link} ${entryId !== null ? (made.rebuilt.includes(entryId) ? 'ticked' : 'unticked') : `real in pdf ${String(made.doc.pdfNumberByPosition[result.positionByIndex[r.realIndex!]!] != null)}`} [${reasons.join(',')}] "${squash(body.slice(h.start, h.headEnd)).slice(0, 50)}"`);
        }
        // 3. Every character left out by the rule is printed where its label says (or nowhere: Q2).
        for (const r of ranges ?? [])
        {
            if (r.printedAs === null)
            {
                continue;
            }
            const text = squash(body.slice(r.start, r.end));
            if (text === '')
            {
                continue;
            }
            if (r.printedAs.kind === 'unticked')
            {
                stats.unticked++;
                expect(made.rebuilt, what).not.toContain(r.printedAs.id);
                expect(made.unticked, what).toContain(r.printedAs.id);
                expect(doc.emails.some((e) => squash(bodyOf(e)).includes(text)), `${what}: an unticked forwarded part is nowhere in the PDF`).toBe(false);
                continue;
            }
            if (r.printedAs.kind === 'unticked-attached')
            {
                // Q3 (task 8.13b-3): the block of an attached email (or of the copy it was merged into) that is not in the PDF.
                const untickedAt = r.printedAs.position;
                expect(doc.pdfNumberByPosition[untickedAt] ?? null, what).toBeNull();
                expect((result.attached ?? []).some((a) => result.positionByIndex[a.index] === untickedAt), what).toBe(true);
                continue;
            }
            const target = doc.emails[r.printedAs.number - 1]!;
            expect(target.number, what).toBe(r.printedAs.number);
            if (r.printedAs.kind === 'rebuilt')
            {
                expect(target.rebuilt?.id, what).toBe(r.printedAs.id);
            }
            else
            {
                expect(target.position, what).toBe(r.printedAs.position);
            }
            // Its text lines are in that email's text, its header lines in its text (moved) or its header rows.
            const there = squash(`${rowsOf(target)}\n${bodyOf(target)}`);
            for (const line of body.slice(r.start, r.end).split(/\r\n?|\n/u))
            {
                const l = squash(line);
                if (l === '')
                {
                    continue;
                }
                const value = l.replace(/^[^:]{1,40}:\s*/u, '');
                // A header line printed as a row shows its value (the row's own label may be another word). A
                // marker line with no value ("Begin forwarded message:") says only that a quoted email starts: the
                // rebuilt email's header rows and its "reconstructed" mark say so (as before task 8.13a). A date
                // line: the Date row shows that moment in the PDF's time zone (headerShownInPdf checked it).
                const dateLine = /^(?:date|sent|envoyé|datum|verzonden|gesendet)\s?:/iu.test(l) && /\bDate\b/u.test(rowsOf(target));
                expect(there.includes(l) || value === '' || dateLine || there.includes(value) || target.position !== null, `${what}: "${l}" of email at ${String(position)} printed in Email ${String(target.number)}`).toBe(true);
            }
        }
    }
    // 2. A rebuilt email: no header block in its text below the moved header lines; moved lines printed once.
    for (const e of doc.emails)
    {
        if (e.rebuilt === null)
        {
            continue;
        }
        const entry = result.reconstructed[e.rebuilt.shownId]!;
        const text = entry.rebuilt.reconstructedText;
        for (const h of findReplyHeaders(text))
        {
            violations.push(`rebuilt Email ${String(e.number)}: "${squash(text.slice(h.start, h.headEnd)).slice(0, 80)}"`);
        }
        if (e.rebuilt.movedHeaders > 0)
        {
            stats.moved += e.rebuilt.movedHeaders;
            const moved = noRepeat({ result, positions, plans: made.plans, policy: DEFAULT_OUTPUT_POLICY, rebuilt: made.rebuilt, rebuildingOff: made.rebuildingOff, unticked: made.unticked }).moved.get(e.rebuilt.id)!;
            expect(moved, what).toHaveLength(e.rebuilt.movedHeaders);
            for (const block of moved)
            {
                const b = squash(block);
                const inPdf = doc.emails.reduce((n, x) => n + (squash(bodyOf(x)).split(b).length - 1), 0);
                expect(inPdf, `${what}: moved header lines "${b.slice(0, 60)}" printed once`).toBe(1);
                expect(squash(bodyOf(e)).startsWith(b) || squash(bodyOf(e)).includes(b), what).toBe(true);
            }
            // At the top of its text.
            expect(squash(bodyOf(e)).startsWith(squash(moved[0]!)), `${what}: moved lines at the top of Email ${String(e.number)}`).toBe(true);
        }
    }
    expect(violations, `${what}: header lines of another email inside a body`).toEqual([]);
    return stats;
}

/** "Print full original text": every body printed whole, so everything left out above is still in the PDF. */
function expectFullTextWhole(messages: readonly NormalizedMessage[], what: string): void
{
    const made = make(messages, (ids) => [...ids], FULL);
    for (const position of made.positions)
    {
        const email = made.doc.emails.find((e) => e.position === position)!;
        // The body after the display transforms only (control characters shown as codes, quote marks dropped).
        const whole = bodyLines(made.result.messages[position]!.message.bodyText).lines.map(lineText).join('\n');
        expect(squash(bodyOf(email)), `${what}: full text`).toBe(squash(whole));
    }
}

describe('no header lines of another email inside a body, "Print full original text" off (task 8.13a)', () =>
{
    const totals: Stats = { exempt: 0, inline: 0, cut: 0, moved: 0, unticked: 0 };
    const add = (s: Stats): void =>
    {
        for (const key of Object.keys(totals) as (keyof Stats)[])
        {
            totals[key] += s[key];
        }
    };
    let switchOffInline = 0;
    const choices: [string, (ids: readonly number[]) => number[]][] = [
        ['every rebuilt email', (ids) => [...ids]],
        ['no rebuilt email', () => []],
        ['every other rebuilt email', (ids) => ids.filter((_, k) => (ids.length - 1 - k) % 2 === 0)],
    ];
    /** "Rebuild conversation from replies" off: no part is unticked (Q2 needs a card unticked), everything stays inline. */
    const expectSwitchOff = (files: readonly NormalizedMessage[], what: string): void =>
    {
        const s = expectNoHeaderLines(make(files, () => [], DEFAULT_OUTPUT_POLICY, true), `${what}, switch off`);
        expect(s.unticked, `${what}, switch off`).toBe(0);
        expect(s.moved, `${what}, switch off`).toBe(0);
        switchOffInline += s.inline;
    };

    for (const c of THREAD_CASES)
    {
        it(c.id, () =>
        {
            const ms = c.messages!;
            const n = ms.length;
            const tag = c.id.replace(/[^a-z0-9]+/giu, '-');
            const batches: [string, number[]][] = [
                ['last', [n - 1]],
                ['every email', ms.map((_, i) => i)],
                ['first and last', [0, n - 1]],
                ['last two', [n - 2, n - 1]],
            ];
            for (const [name, idx] of batches)
            {
                const files = idx.map((i) => realFile(ms, i, tag));
                for (const [choice, rebuilt] of choices)
                {
                    add(expectNoHeaderLines(make(files, rebuilt), `${c.id}, ${name}, ${choice}`));
                }
                expectSwitchOff(files, `${c.id}, ${name}`);
                expectFullTextWhole(files, `${c.id}, ${name}`);
            }
        });
    }

    it('the fixture set, all together and one by one', () =>
    {
        for (const [choice, rebuilt] of choices)
        {
            add(expectNoHeaderLines(make(fixtures, rebuilt), `all fixtures, ${choice}`));
            for (const f of fixtures)
            {
                add(expectNoHeaderLines(make([f], rebuilt), `${f.source.fileName}, ${choice}`));
            }
        }
        expectSwitchOff(fixtures, 'all fixtures');
        expectFullTextWhole(fixtures, 'all fixtures');
    });

    it('the cases exercise every branch', () =>
    {
        // At the time of writing: cut 2315, exempt 6, inline 34, moved 496, unticked 32, switch off inline 49.
        expect(totals.cut).toBeGreaterThan(100);
        expect(totals.moved).toBeGreaterThan(10);
        expect(totals.unticked).toBeGreaterThan(10);
        expect(totals.inline).toBeGreaterThan(10);
        expect(switchOffInline).toBeGreaterThan(10);
    });
});
