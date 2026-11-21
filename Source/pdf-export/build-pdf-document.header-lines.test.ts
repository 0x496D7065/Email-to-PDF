// Task 8.13a (user rule 2026-11-09): with "Print full original text" off,
// the PDF shows no header-looking lines of another email inside an email's
// text. Checked as a general INVARIANT on the PDF document model, with the
// thread analysis's own quoted-header detection (findReplyHeaders, the detector that
// reconstruct-quoted-messages.ts reads its places from), over every conversation of
// Helper/Test/test-support/thread-cases.ts (several sets of files, every rebuilt email
// ticked, none, every other one) and over the fixture set:
//
// 1. No header shown. For every real email of the PDF, no header block that
//    findReplyHeaders finds in its body ([start, headEnd): an "On ...
//    wrote:" line, a "From: / Sent: / To: / Subject:" block, a forward
//    marker with its lines) has a character printed, EXCEPT a header the
//    thread analysis could not rebuild (no place of result.reconstructed starts
//    there: reconstruct-quoted-messages.ts refused it, or it lies in an attached email the
//    .eml reader writes after the forwarded-message separator, task 8.13b),
//    and a header whose email is not in the PDF at all (its rebuilt email
//    unticked, or the switch off, and not a forwarded part: nothing else
//    prints it, so it stays inline, collapse never delete). A forwarded
//    part of an unticked rebuilt email is never exempt (Q2: left out).
//    Nothing else is exempt: the writer's answer kept with its quote (B1,
//    Q3) does not occur in these conversations (a violation would say so;
//    that case is tested in Source/pdf-export/build-pdf-document.no-repeat.test.ts, B1).
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
// checked on the written file (Source/pdf-export/generate-pdf.header-blocks.test.ts).
// Synthetic data only (README.md, rule R7).
import { beforeAll, describe, expect, it } from 'vitest';
import { parseAllFixtures } from '../../Helper/Test/test-data/parse-all-fixtures';
import { buildThread, instantOf, type ThreadMessage } from '../../Helper/Test/test-support/thread-builder';
import { THREAD_CASES } from '../../Helper/Test/test-support/thread-cases';
import { analyzeThread } from '../thread-analysis/analyze-thread';
import { DEFAULT_OUTPUT_POLICY, planOutput } from '../thread-analysis/output-plan';
import { findReplyHeaders } from '../thread-analysis/reply-header';
import { rebuiltEntries } from '../web-page-logic/rebuilt-email-display';
import { buildPdfDocument, applyNoRepeatRule, pdfRanges } from './build-pdf-document';
import { createPdfStrings } from './pdf-strings';
import { bodyLines, lineText } from './pdf-text-transforms';
import type { MessagePlan, OutputPolicy } from '../../Header/output-plan';
import type { NormalizedMessage } from '../../Header/parsed-email';
import type { PdfDocument, PdfEmail, PdfRange } from '../../Header/pdf-document-model';
import type { ThreadAnalysisResult } from '../../Header/thread-analysis-result';

const EN = createPdfStrings('en');
const FULL: OutputPolicy = { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true };

let fixtures: NormalizedMessage[];
beforeAll(async () =>
{
    fixtures = await parseAllFixtures();
});

/** Message `messageIndex` of a conversation as a real file (its body quotes the ones before it). */
function realFile(messages: readonly ThreadMessage[], messageIndex: number, tag: string): NormalizedMessage
{
    const threadMessage = messages[messageIndex]!;
    const messageId = (k: number): string => `${tag}-${String(k)}@example.test`;
    const utcMs = instantOf(threadMessage.sent, threadMessage.zone);
    return {
        messageId: messageId(messageIndex),
        inReplyTo: messageIndex === 0 ? null : messageId(messageIndex - 1),
        references: Array.from({ length: messageIndex }, (_, k) => messageId(k)),
        date: { utcMs, original: new Date(utcMs).toUTCString(), offsetMinutes: threadMessage.zone.offsetMinutes, zoneKnown: true },
        from: [threadMessage.from],
        to: threadMessage.to,
        cc: threadMessage.cc ?? [],
        bcc: [],
        subject: threadMessage.subject,
        bodyText: buildThread(messages.slice(0, messageIndex + 1)).body,
        attachments: [],
        source: { fileName: `${tag}-${String(messageIndex)}.eml`, sha256: (messageIndex + 1).toString(16).padStart(64, '0'), kind: 'eml' },
        warnings: [],
    };
}

/** A line set compared: quote marks at line starts and white space runs do not count. */
const squash = (text: string): string =>
    text
        .split(/\r\n?|\n/u)
        .map((l) => l.replace(/^(?:[ \t]*>)+[ \t]?/u, ''))
        .join(' ')
        .replace(/\s+/gu, ' ')
        .trim();
const bodyOf = (e: PdfEmail): string => e.body.map(lineText).join('\n');
const rowsOf = (e: PdfEmail): string => e.fields.map((f) => `${f.label} ${f.value.map(lineText).join(' ')}`).join('\n');

interface Made
{
    readonly result: ThreadAnalysisResult;
    readonly positions: readonly number[];
    readonly plans: readonly MessagePlan[];
    readonly rebuilt: readonly number[];
    /** "Rebuild conversation from replies" off (then `rebuilt` is []). */
    readonly rebuildingOff: boolean;
    /** The rebuilt emails the reader unticked: here every one not chosen (BuildPdfInput.unticked). */
    readonly unticked: readonly number[];
    readonly pdfDocument: PdfDocument;
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
    const pdfDocument = buildPdfDocument({ result, positions, plans, policy, rebuilt: chosen, rebuildingOff, unticked, timeZone: 'UTC',
        generatedAt: Date.UTC(2025, 5, 1, 12, 0, 0), strings: EN });
    return { result, positions, plans, rebuilt: chosen, rebuildingOff, unticked, pdfDocument };
}

/** What `made` prints of each real email's body, per character (the plan cut by the no-repeat rule), and the ranges. */
function printedOf(made: Made, planIndex: number): { readonly kept: Uint8Array; readonly ranges: readonly PdfRange[] | null }
{
    const { result, positions, plans, rebuilt, rebuildingOff, unticked } = made;
    const position = positions[planIndex]!;
    const body = result.messages[position]!.message.bodyText;
    const plan = plans[planIndex]!;
    const kept = new Uint8Array(body.length);
    if (plan.fallback)
    {
        kept.fill(1);
        return { kept, ranges: null };
    }
    const parts = applyNoRepeatRule(
        { result, positions, plans, policy: DEFAULT_OUTPUT_POLICY, rebuilt, rebuildingOff, unticked }).parts.get(position) ?? [];
    const ranges = pdfRanges(body, plan, DEFAULT_OUTPUT_POLICY, parts);
    for (const range of ranges ?? plan.ranges)
    {
        if (range.keep)
        {
            kept.fill(1, range.start, range.end);
        }
    }
    return { kept, ranges };
}

interface Stats
{
    /** Headers shown that the thread analysis could not rebuild (no place). */
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
    const { result, positions, pdfDocument } = made;
    const stats: Stats = { exempt: 0, inline: 0, cut: 0, moved: 0, unticked: 0 };
    const violations: string[] = [];
    for (const [k, position] of positions.entries())
    {
        const message = result.messages[position]!.message;
        const body = message.bodyText;
        const email = pdfDocument.emails.find((e) => e.position === position);
        expect(email, `${what}: email at ${String(position)} in the PDF`).toBeDefined();
        const { kept, ranges } = printedOf(made, k);
        const places = new Set(result.reconstructed.filter((r) => result.positionByIndex[r.sourceIndex] === position).map((r) => r.rebuilt.start));
        // 1. No header block shown, except one the thread analysis could not rebuild.
        for (const header of findReplyHeaders(body, message.subject))
        {
            let shown = false;
            for (let i = header.start; i < header.headEnd && !shown; i++)
            {
                shown = kept[i] === 1 && /\S/u.test(body[i]!);
            }
            if (!shown)
            {
                stats.cut++;
                continue;
            }
            if (!places.has(header.start))
            {
                stats.exempt++;
                continue;
            }
            const rebuiltEntry = result.reconstructed.find((x) => result.positionByIndex[x.sourceIndex] === position
                && x.rebuilt.start === header.start)!;
            const plan = made.plans[k]!;
            // A place whose email is not in the PDF stays inline (nothing else prints it), unless it is a forwarded part of an unticked rebuilt email (Q2).
            const printedEntryId = rebuiltEntry.link === 'entry' ? rebuiltEntry.id : rebuiltEntry.link === 'same-as' ? rebuiltEntry.sameAs : null;
            const realPosition = rebuiltEntry.link === 'real' && rebuiltEntry.realIndex !== null ? result.positionByIndex[rebuiltEntry.realIndex]
                : undefined;
            const printed = printedEntryId !== null
                ? pdfDocument.emails.some((e) => e.rebuilt?.id === printedEntryId)
                : realPosition != null && pdfDocument.pdfNumberByPosition[realPosition] != null;
            const forwardedAt = plan.fallback ? null : (plan.ranges.find((x) => x.reason === 'forwarded')?.start ?? null);
            const untickedForward = !made.rebuildingOff && printedEntryId !== null && made.unticked.includes(printedEntryId) && forwardedAt !== null
                && rebuiltEntry.rebuilt.start >= forwardedAt;
            if (!printed && !untickedForward)
            {
                stats.inline++;
                continue;
            }
            const reasons = [...new Set(plan.ranges
                .filter((x) => x.end > rebuiltEntry.rebuilt.headerEnd && x.start < rebuiltEntry.rebuilt.end
                    && /\S/u.test(body.slice(Math.max(x.start, rebuiltEntry.rebuilt.headerEnd), Math.min(x.end, rebuiltEntry.rebuilt.end))))
                .map((x) => `${x.reason}${x.keep ? '+' : '-'}`))];
            const entryId = rebuiltEntry.link === 'entry' ? rebuiltEntry.id : rebuiltEntry.sameAs;
            violations.push(
                `email ${String(email!.number)}: link ${rebuiltEntry.link} ${entryId !== null ? (made.rebuilt.includes(entryId) ? 'ticked' : 'unticked') : `real in pdf ${String(made.pdfDocument.pdfNumberByPosition[result.positionByIndex[rebuiltEntry.realIndex!]!] != null)}`} [${reasons.join(',')}] "${squash(body.slice(header.start, header.headEnd)).slice(0, 50)}"`);
        }
        // 3. Every character left out by the rule is printed where its label says (or nowhere: Q2).
        for (const range of ranges ?? [])
        {
            if (range.printedAs === null)
            {
                continue;
            }
            const text = squash(body.slice(range.start, range.end));
            if (text === '')
            {
                continue;
            }
            if (range.printedAs.kind === 'unticked')
            {
                stats.unticked++;
                expect(made.rebuilt, what).not.toContain(range.printedAs.id);
                expect(made.unticked, what).toContain(range.printedAs.id);
                // An empty part (header lines only, task 9.9a) whose very words are the header of ANOTHER rebuilt
                // place cannot be told apart from it by its text: fixtures 94 to 97 hold the same empty forward
                // once per file (an empty rebuilt email is not printed, task 8.14: its lines stay in that file's
                // text), and the duplicate pair (14 Jul 16:53) one empty attribution over the same line with text.
                const sameWordsElsewhere = result.reconstructed.some((r) =>
                {
                    const at = result.positionByIndex[r.sourceIndex];
                    const itself = at === position && r.rebuilt.start >= range.start && r.rebuilt.start < range.end;
                    return !itself && at != null && squash(result.messages[at]!.message.bodyText.slice(r.rebuilt.start, r.rebuilt.headerEnd)) === text;
                });
                expect(!sameWordsElsewhere && pdfDocument.emails.some((e) => squash(bodyOf(e)).includes(text)),
                    `${what}: an unticked forwarded part is nowhere in the PDF`).toBe(false);
                continue;
            }
            if (range.printedAs.kind === 'unticked-attached')
            {
                // Q3 (task 8.13b-3): the block of an attached email (or of the copy it was merged into) that is not in the PDF.
                const untickedAt = range.printedAs.position;
                expect(pdfDocument.pdfNumberByPosition[untickedAt] ?? null, what).toBeNull();
                expect((result.attached ?? []).some((a) => result.positionByIndex[a.index] === untickedAt), what).toBe(true);
                continue;
            }
            const target = pdfDocument.emails[range.printedAs.number - 1]!;
            expect(target.number, what).toBe(range.printedAs.number);
            if (range.printedAs.kind === 'rebuilt')
            {
                expect(target.rebuilt?.id, what).toBe(range.printedAs.id);
            }
            else
            {
                expect(target.position, what).toBe(range.printedAs.position);
            }
            // Its text lines are in that email's text, its header lines in its text (moved) or its header rows.
            const there = squash(`${rowsOf(target)}\n${bodyOf(target)}`);
            for (const line of body.slice(range.start, range.end).split(/\r\n?|\n/u))
            {
                const squashedLine = squash(line);
                if (squashedLine === '')
                {
                    continue;
                }
                const value = squashedLine.replace(/^[^:]{1,40}:\s*/u, '');
                // A header line printed as a row shows its value (the row's own label may be another word). A
                // marker line with no value ("Begin forwarded message:") says only that a quoted email starts: the
                // rebuilt email's header rows and its "reconstructed" mark say so (as before task 8.13a). A date
                // line: the Date row shows that moment in the PDF's time zone (headerShownInPdf checked it).
                const dateLine = /^(?:date|sent|envoyé|datum|verzonden|gesendet)\s?:/iu.test(squashedLine) && /\bDate\b/u.test(rowsOf(target));
                expect(there.includes(squashedLine) || value === '' || dateLine || there.includes(value) || target.position !== null,
                    `${what}: "${squashedLine}" of email at ${String(position)} printed in Email ${String(target.number)}`).toBe(true);
            }
        }
    }
    // 2. A rebuilt email: no header block in its text below the moved header lines; moved lines printed once
    // per copy moved. Two copies of one email linked together (fixtures 94 and 97, task 9.9a: the same thread
    // in two files) may move the very same lines: then they are printed twice, once per copy, nothing more.
    // And an empty rebuilt email (no text: not printed, task 8.14) leaves its header lines in its source's
    // text when it is ticked (unticked, they are left out: Q2): when they are word for word the lines of
    // another one (the duplicate pair of fixtures 94 to 97), they are printed there too (how empty ones
    // show is task 9.9b).
    const keptEmpty = new Map<string, number>();
    for (const r of result.reconstructed)
    {
        const position = result.positionByIndex[r.sourceIndex];
        if (r.rebuilt.noOwnText && position != null && pdfDocument.pdfNumberByPosition[position] != null)
        {
            const lines = squash(result.messages[position]!.message.bodyText.slice(r.rebuilt.start, r.rebuilt.headerEnd));
            keptEmpty.set(lines, (keptEmpty.get(lines) ?? 0) + 1);
        }
    }
    const movedAll = applyNoRepeatRule({ result, positions, plans: made.plans, policy: DEFAULT_OUTPUT_POLICY, rebuilt: made.rebuilt,
        rebuildingOff: made.rebuildingOff, unticked: made.unticked }).moved;
    const timesMoved = new Map<string, number>();
    for (const blocks of movedAll.values())
    {
        for (const block of blocks)
        {
            timesMoved.set(squash(block), (timesMoved.get(squash(block)) ?? 0) + 1);
        }
    }
    for (const email of pdfDocument.emails)
    {
        if (email.rebuilt === null)
        {
            continue;
        }
        const entry = result.reconstructed[email.rebuilt.shownId]!;
        const text = entry.rebuilt.reconstructedText;
        for (const header of findReplyHeaders(text))
        {
            violations.push(`rebuilt Email ${String(email.number)}: "${squash(text.slice(header.start, header.headEnd)).slice(0, 80)}"`);
        }
        if (email.rebuilt.movedHeaders > 0)
        {
            stats.moved += email.rebuilt.movedHeaders;
            const moved = movedAll.get(email.rebuilt.id)!;
            expect(moved, what).toHaveLength(email.rebuilt.movedHeaders);
            for (const block of moved)
            {
                const squashedBlock = squash(block);
                const inPdf = pdfDocument.emails.reduce((n, x) => n + (squash(bodyOf(x)).split(squashedBlock).length - 1), 0);
                // Once per copy moved, plus at most once per empty place with the same words (kept when ticked).
                const once = `${what}: moved header lines "${squashedBlock.slice(0, 60)}" printed once per copy moved`;
                expect(inPdf, once).toBeGreaterThanOrEqual(timesMoved.get(squashedBlock) ?? 0);
                expect(inPdf, once).toBeLessThanOrEqual((timesMoved.get(squashedBlock) ?? 0) + (keptEmpty.get(squashedBlock) ?? 0));
                expect(squash(bodyOf(email)).startsWith(squashedBlock) || squash(bodyOf(email)).includes(squashedBlock), what).toBe(true);
            }
            // At the top of its text.
            expect(squash(bodyOf(email)).startsWith(squash(moved[0]!)),
                `${what}: moved lines at the top of Email ${String(email.number)}`).toBe(true);
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
        const email = made.pdfDocument.emails.find((e) => e.position === position)!;
        // The body after the display transforms only (control characters shown as codes, quote marks dropped).
        const whole = bodyLines(made.result.messages[position]!.message.bodyText).lines.map(lineText).join('\n');
        expect(squash(bodyOf(email)), `${what}: full text`).toBe(squash(whole));
    }
}

describe('no header lines of another email inside a body, "Print full original text" off (task 8.13a)', () =>
{
    const totals: Stats = { exempt: 0, inline: 0, cut: 0, moved: 0, unticked: 0 };
    const add = (stats: Stats): void =>
    {
        for (const key of Object.keys(totals) as (keyof Stats)[])
        {
            totals[key] += stats[key];
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
        const stats = expectNoHeaderLines(make(files, () => [], DEFAULT_OUTPUT_POLICY, true), `${what}, switch off`);
        expect(stats.unticked, `${what}, switch off`).toBe(0);
        expect(stats.moved, `${what}, switch off`).toBe(0);
        switchOffInline += stats.inline;
    };

    for (const threadCase of THREAD_CASES)
    {
        it(threadCase.id, () =>
        {
            const threadMessages = threadCase.messages!;
            const messageCount = threadMessages.length;
            const tag = threadCase.id.replace(/[^a-z0-9]+/giu, '-');
            const batches: [string, number[]][] = [
                ['last', [messageCount - 1]],
                ['every email', threadMessages.map((_, i) => i)],
                ['first and last', [0, messageCount - 1]],
                ['last two', [messageCount - 2, messageCount - 1]],
            ];
            for (const [name, fileIndexes] of batches)
            {
                const files = fileIndexes.map((i) => realFile(threadMessages, i, tag));
                for (const [choice, rebuilt] of choices)
                {
                    add(expectNoHeaderLines(make(files, rebuilt), `${threadCase.id}, ${name}, ${choice}`));
                }
                expectSwitchOff(files, `${threadCase.id}, ${name}`);
                expectFullTextWhole(files, `${threadCase.id}, ${name}`);
            }
        });
    }

    it('the fixture set, all together and one by one', () =>
    {
        for (const [choice, rebuilt] of choices)
        {
            add(expectNoHeaderLines(make(fixtures, rebuilt), `all fixtures, ${choice}`));
            for (const fixture of fixtures)
            {
                add(expectNoHeaderLines(make([fixture], rebuilt), `${fixture.source.fileName}, ${choice}`));
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
