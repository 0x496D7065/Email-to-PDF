// Random tests of collapse, never delete when emails QUOTE each other (task
// 8.13b-3, review round 3, finding M2). Seeded random conversations
// (Helper/Test/test-support/quoting-builder.ts: reply headers in English, French and
// Dutch with ">" marks, Outlook header blocks, "-----Original Message-----",
// forwards, a quoted sentence alone, text pasted with no header; right,
// missing and wrong In-Reply-To; right, missing, unreadable and wrong
// dates) are run through the real thread analysis, output plan and PDF model with
// "Print full original text" off, dropped:
// - each email as a file of its own (plain files: the loss that existed
//   before task 8.13b-3, an undated or wrong-clock email whose paragraph a
//   reply quotes without In-Reply-To);
// - grouped into files with emails attached inside them, inline or as a
//   file, up to three levels deep (Helper/Test/test-support/attached-builder.ts), with
//   some attached emails also dropped as files of their own (copies, merged).
// Random ticks and random rebuilt emails chosen. Checked:
// - every ticked email's own sentence is printed at least once in the PDF
//   (the PRINTED SOMEWHERE check, Source/pdf-export/build-pdf-document.ts, and the thread analysis's
//   withHeldReferences, Source/thread-analysis/overlap-quote-detection.ts); how often one is printed
//   twice is counted and reported (allowed: restoring may print twice);
// - an unticked email's sentence is printed nowhere when no ticked email's
//   own text quotes it (Q3: an unticked attached email is left out of the
//   emails holding it too);
// - with "Print full original text" on, every ticked email's whole text.
// Synthetic data only: made-up names, *.test addresses (README.md, rule R7).

import { describe, expect, it } from 'vitest';
import { groupAsAttached } from '../../Helper/Test/test-support/attached-builder';
import { referenceDisplayText } from '../../Helper/Test/test-support/pdf-reference';
import { quotingCase, quotingSentence, type QuotingCase } from '../../Helper/Test/test-support/quoting-builder';
import { DEFAULT_THREAD_ANALYSIS_PARTS, analyzeThread, type ThreadAnalysisParts } from '../thread-analysis/analyze-thread';
import { detectQuotedOverlap } from '../thread-analysis/overlap-quote-detection';
import { DEFAULT_OUTPUT_POLICY, planOutput } from '../thread-analysis/output-plan';
import { rebuiltEntries } from '../web-page-logic/rebuilt-email-display';
import { buildPdfDocument, applyNoRepeatRule } from './build-pdf-document';
import { createPdfStrings } from './pdf-strings';
import { lineText } from './pdf-text-transforms';
import type { MessagePlan, OutputPolicy } from '../../Header/output-plan';
import type { NormalizedMessage, ParseResult } from '../../Header/parsed-email';
import type { PdfEmail } from '../../Header/pdf-document-model';
import type { ThreadAnalysisResult } from '../../Header/thread-analysis-result';

/** mulberry32: a tiny seeded generator, returns numbers in [0, 1). */
function makeRandom(seed: number): () => number
{
    let state = seed >>> 0;
    return () =>
    {
        state = (state + 0x6d2b79f5) >>> 0;
        let bits = state;
        bits = Math.imul(bits ^ (bits >>> 15), bits | 1);
        bits ^= bits + Math.imul(bits ^ (bits >>> 7), bits | 61);
        return ((bits ^ (bits >>> 14)) >>> 0) / 4294967296;
    };
}

const strings = createPdfStrings('en');
const squash = (s: string): string => s.replace(/\s+/gu, ' ').trim();
const bodyOf = (e: PdfEmail): string => e.body.map(lineText).join('\n');

type Dropped = 'files' | 'attached';

/**
 * The parse results of a case: each email a file, or grouped with emails attached inside files (and some
 * copies dropped too). The emails of `missing` (indices into testCase.messages) are in no file at all: emails
 * the reader did not add, whose text is only in the quotes of others (review round 4, M1).
 */
function filesOf(testCase: QuotingCase, dropped: Dropped, random: () => number, missing: ReadonlySet<number>): ParseResult[]
{
    const present = testCase.messages.filter((_, k) => !missing.has(k));
    if (dropped === 'files')
    {
        return present.map((message) => ({ ok: true as const, message }));
    }
    const files: ParseResult[] = groupAsAttached(present, random, { mode: 'random', attachShare: 0.6 });
    // Copies: some attached emails with none attached inside them also dropped as files of their own
    // (merged with them by Message-ID). One holding others would come with its own attached list, as a
    // parser gives it; a file whose inline forwards were not read as attached emails is another case.
    for (const file of [...files])
    {
        if (!file.ok)
        {
            continue;
        }
        const list = file.attached ?? [];
        list.forEach((attached, k) =>
        {
            if (list.some((x) => x.parent === k) || random() >= 0.2)
            {
                return;
            }
            files.push({ ok: true, message: { ...attached.message,
                source: { fileName: `copy-${attached.message.messageId ?? ''}.eml`, sha256: 'c'.repeat(64), kind: 'eml' } } });
        });
    }
    return files;
}

interface Tally
{
    cases: number;
    ticked: number;
    lost: number;
    twice: number;
    unticked: number;
    attached: number;
    /** Sentences that the plan of a ticked email keeps (outside parts left out on purpose: an unticked email's block or forwarded part). */
    keptChecked: number;
    /** ... of which printed nowhere in the PDF (expected: 0). */
    keptLost: number;
    /** Sentences of emails the reader did not add (in no file), kept by the plan of a ticked email (quoted history, review round 4, M1). */
    missingChecked: number;
    /** ... of which printed nowhere in the PDF (expected: 0). */
    missingLost: number;
    failures: string[];
}

const tally = (): Tally => ({ cases: 0, ticked: 0, lost: 0, twice: 0, unticked: 0, attached: 0, keptChecked: 0, keptLost: 0, missingChecked: 0, missingLost: 0, failures: [] });

/**
 * Per email in the PDF (list position): the text its plan KEEPS, less the parts the no-repeat rule leaves
 * out on purpose (kind 'unticked': a forwarded part of an unticked rebuilt email, Q2 of task 8.13a;
 * 'unticked-attached': the block of an unticked attached email, Q3), as display text (no ">" marks).
 * Every sentence in it must be printed somewhere in the PDF: the no-repeat rule may move text to another
 * email, never lose it (review round 4, M1).
 */
function keptTexts(result: ThreadAnalysisResult, positions: readonly number[], plans: readonly MessagePlan[], rebuilt: readonly number[],
    unticked: readonly number[]): Map<number, string>
{
    const { parts } = applyNoRepeatRule({ result, positions, plans, policy: DEFAULT_OUTPUT_POLICY, rebuilt, unticked });
    const texts = new Map<number, string>();
    positions.forEach((position, k) =>
    {
        const body = result.messages[position]!.message.bodyText;
        const onPurpose = (parts.get(position) ?? []).filter((p) => p.printedAs.kind === 'unticked' || p.printedAs.kind === 'unticked-attached');
        const pieces: string[] = [];
        for (const range of plans[k]!.ranges)
        {
            if (!range.keep)
            {
                continue;
            }
            let from = range.start;
            for (const part of [...onPurpose].sort((a, b) => a.start - b.start))
            {
                if (part.end <= from || part.start >= range.end)
                {
                    continue;
                }
                if (part.start > from)
                {
                    pieces.push(body.slice(from, part.start));
                }
                from = Math.min(part.end, range.end);
            }
            if (from < range.end)
            {
                pieces.push(body.slice(from, range.end));
            }
        }
        texts.set(position, squash(pieces.map((piece) => referenceDisplayText(piece)).join('\n')));
    });
    return texts;
}

/** One case: the folded PDF of a random selection, every own sentence checked; then the full text. */
function check(testCase: QuotingCase, result: ThreadAnalysisResult, random: () => number, where: string, tallyCounts: Tally,
    missing: ReadonlySet<number>): void
{
    tallyCounts.cases++;
    tallyCounts.attached += result.attached?.length ?? 0;
    const positions = result.messages.map((_, k) => k).filter(() => random() < 0.75);
    const ids = rebuiltEntries(result).map((r) => r.id);
    const rebuilt = ids.filter(() => random() < 0.5);
    const unticked = ids.filter((id) => !rebuilt.includes(id));
    const plansOf = (policy: OutputPolicy): MessagePlan[] =>
        planOutput(
            positions.map((p) => result.messages[p]!),
            policy,
        );
    const make = (policy: OutputPolicy) =>
        buildPdfDocument({
            result,
            positions,
            plans: plansOf(policy),
            policy,
            timeZone: 'UTC',
            generatedAt: 0,
            strings,
            rebuilt,
            unticked,
        });
    const pdfDocument = make(DEFAULT_OUTPUT_POLICY);
    const bodies = pdfDocument.emails.map((e) => squash(bodyOf(e)));
    const ticked = new Set(positions);
    const tickedIds = new Set(positions.map((p) => result.messages[p]!.message.messageId));
    // No text kept by a ticked email's plan is printed nowhere (the no-repeat rule only moves text).
    const kept = [...keptTexts(result, positions, plansOf(DEFAULT_OUTPUT_POLICY), rebuilt, unticked).values()];
    testCase.sentences.forEach((sentenceText, k) =>
    {
        const sentence = squash(sentenceText);
        if (!kept.some((text) => text.includes(sentence)))
        {
            return;
        }
        const isMissing = missing.has(k);
        tallyCounts.keptChecked++;
        if (isMissing)
        {
            tallyCounts.missingChecked++;
        }
        if (bodies.some((b) => b.includes(sentence)))
        {
            return;
        }
        tallyCounts.keptLost++;
        if (isMissing)
        {
            tallyCounts.missingLost++;
        }
        tallyCounts.failures.push(`${where}: email ${String(k)}${isMissing ? ' (not added)' : ''}: kept by a ticked email's plan, printed nowhere`);
    });
    testCase.messages.forEach((message, k) =>
    {
        if (missing.has(k))
        {
            return;
        }
        const sentence = squash(testCase.sentences[k]!);
        const times = bodies.filter((b) => b.includes(sentence)).length;
        const position = result.messages.findIndex((x) => x.message.messageId === message.messageId);
        if (ticked.has(position))
        {
            tallyCounts.ticked++;
            if (times === 0)
            {
                tallyCounts.lost++;
                tallyCounts.failures.push(`${where}: email ${String(k)} (ticked) printed nowhere`);
            }
            if (times > 1)
            {
                tallyCounts.twice++;
            }
        }
        else
        {
            tallyCounts.unticked++;
            // Quoted in the own text of a ticked email (not only in the block of an email holding it): it may be printed there.
            const quoted = testCase.messages.some((x, j) => j !== k && tickedIds.has(x.messageId)
                && squash(referenceDisplayText(x.bodyText)).includes(sentence));
            if (!quoted && times !== 0)
            {
                tallyCounts.failures.push(`${where}: email ${String(k)} (unticked, quoted by no ticked email) printed ${String(times)} times`);
            }
        }
    });
    // "Print full original text": every ticked email whole.
    const full = make({ ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true });
    for (const email of full.emails)
    {
        if (email.position === null)
        {
            continue;
        }
        if (bodyOf(email) !== referenceDisplayText(result.messages[email.position]!.message.bodyText))
        {
            tallyCounts.failures.push(`${where}: full text of position ${String(email.position)} not whole`);
        }
    }
}

/** The real overlap detector, told nothing about which email holds which (the thread analysis's fixes for attached emails undone). */
const NO_HOLDS: ThreadAnalysisParts = {
    ...DEFAULT_THREAD_ANALYSIS_PARTS,
    detectQuotedOverlap: (messages) => detectQuotedOverlap(messages.map((m) => ({ bodyText: m.bodyText, messageId: m.messageId, inReplyTo: m.inReplyTo, references: m.references, index: m.index }))),
};

function run(dropped: Dropped, seeds: number, quoteShare: number, parts: ThreadAnalysisParts = DEFAULT_THREAD_ANALYSIS_PARTS, label = ''): Tally
{
    const tallyCounts = tally();
    for (let seed = 1; seed <= seeds; seed++)
    {
        const random = makeRandom(seed * 7 + Math.round(quoteShare * 100));
        const testCase = quotingCase(random, `q${String(seed)}`, { quoteShare });
        // Some emails not added at all (review round 4, M1): never all of them.
        const missing = new Set<number>();
        testCase.messages.forEach((_, k) =>
        {
            if (random() < 0.25 && missing.size + 1 < testCase.messages.length)
            {
                missing.add(k);
            }
        });
        const result = analyzeThread(filesOf(testCase, dropped, random, missing), parts);
        check(testCase, result, random, `${dropped}${label} share ${String(quoteShare)} seed ${String(seed)}`, tallyCounts, missing);
    }
    console.log(
        `quoting random cases (${dropped}${label}, quote share ${String(quoteShare)}): ${String(tallyCounts.cases)} cases, ${String(tallyCounts.attached)} attached emails, ${String(tallyCounts.ticked)} ticked emails checked: lost ${String(tallyCounts.lost)}, printed twice ${String(tallyCounts.twice)}; ${String(tallyCounts.unticked)} unticked; kept text checked ${String(tallyCounts.keptChecked)}, printed nowhere ${String(tallyCounts.keptLost)}; quoted text of emails not added checked ${String(tallyCounts.missingChecked)}, printed nowhere ${String(tallyCounts.missingLost)}`,
    );
    return tallyCounts;
}

describe('collapse, never delete, with emails quoting each other: random cases (task 8.13b-3, review round 3, M2)', () =>
{
    for (const share of [0.35, 0.7])
    {
        it(`plain files, quote share ${String(share)}: every ticked email's own text, and all text kept by a ticked email's plan, printed at least once (600 cases)`, () =>
        {
            const tallyCounts = run('files', 600, share);
            expect(tallyCounts.failures.slice(0, 10)).toEqual([]);
            expect(tallyCounts.lost).toBe(0);
            expect(tallyCounts.keptLost).toBe(0);
            expect(tallyCounts.missingLost).toBe(0);
            expect(tallyCounts.ticked).toBeGreaterThan(1000);
            expect(tallyCounts.unticked).toBeGreaterThan(300);
        }, 120_000);

        it(`emails attached inside files, quote share ${String(share)}: every ticked email's own text, and all text kept by a ticked email's plan (quoted history of emails not added included), printed at least once (600 cases)`, () =>
        {
            const tallyCounts = run('attached', 600, share);
            expect(tallyCounts.failures.slice(0, 10)).toEqual([]);
            expect(tallyCounts.lost).toBe(0);
            expect(tallyCounts.keptLost).toBe(0);
            expect(tallyCounts.missingLost).toBe(0);
            expect(tallyCounts.attached).toBeGreaterThan(600);
            expect(tallyCounts.ticked).toBeGreaterThan(1000);
            // The cases must really hold quoted history of emails not added, kept inside forwards.
            expect(tallyCounts.missingChecked).toBeGreaterThan(15);
        }, 120_000);
    }

    it('speed: 2000 emails, each pasting the text of the one before, none dated (a candidate in every email): the PDF model in well under a second', () =>
    {
        const messages: NormalizedMessage[] = [];
        for (let k = 0; k < 2000; k++)
        {
            const name = `speed${String(k)}`;
            const before = k === 0 ? '' : `\n\n${quotingSentence(`speed${String(k - 1)}`)}\n${quotingSentence(`speed${String(k - 1)}`)}`;
            messages.push({
                messageId: `${name}@example.test`,
                inReplyTo: null,
                references: [],
                date: { utcMs: null, original: '', offsetMinutes: null, zoneKnown: false },
                from: [{ name: `Person ${String(k % 5)}`, address: `p${String(k % 5)}@example.test` }],
                to: [{ name: 'Team', address: 'team@example.test' }],
                cc: [],
                bcc: [],
                subject: `Note ${String(k)}`,
                bodyText: `Hello team,\n\n${quotingSentence(name)}\n${quotingSentence(name)}${before}\n`,
                attachments: [],
                source: { fileName: `${name}.eml`, sha256: k.toString(16).padStart(64, '0'), kind: 'eml' },
                warnings: [],
            });
        }
        const result = analyzeThread(messages.map((message) => ({ ok: true as const, message })));
        const positions = result.messages.map((_, k) => k);
        const plans = planOutput(result.messages, DEFAULT_OUTPUT_POLICY);
        const input = { result, positions, plans, policy: DEFAULT_OUTPUT_POLICY, timeZone: 'UTC', generatedAt: 0, strings };
        buildPdfDocument(input); // warm-up
        const start = performance.now();
        const pdfDocument = buildPdfDocument(input);
        const elapsedMs = performance.now() - start;
        const restored = applyNoRepeatRule({ ...input, rebuilt: [] }).restored.size;
        console.log(`quoting speed case: 2000 emails in ${elapsedMs.toFixed(1)} ms, ${String(restored)} emails with restored text`);
        expect(pdfDocument.emails).toHaveLength(2000);
        const bodies = pdfDocument.emails.map((e) => squash(bodyOf(e)));
        for (let k = 0; k < 2000; k += 97)
        {
            expect(bodies.some((b) => b.includes(squash(quotingSentence(`speed${String(k)}`))))).toBe(true);
        }
        expect(elapsedMs).toBeLessThan(1500);
    }, 120_000);

    it('the PRINTED SOMEWHERE check alone (the thread analysis\'s holder links undone): still at least once (400 cases with attached emails)', () =>
    {
        const tallyCounts = run('attached', 400, 0.5, NO_HOLDS, ' no holds');
        expect(tallyCounts.failures.slice(0, 10)).toEqual([]);
        expect(tallyCounts.lost).toBe(0);
        expect(tallyCounts.keptLost).toBe(0);
    }, 120_000);
});
