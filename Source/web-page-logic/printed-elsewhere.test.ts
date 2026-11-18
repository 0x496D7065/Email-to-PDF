// Unit tests for the preview's no-repeat labels (task 8.11;
// printed-elsewhere.ts with pdf-plan.ts): over every conversation of
// Helper/Test/test-support/thread-cases.ts, with "Print full original text" off and
// several sets of files and rebuilt emails chosen, the parts the preview
// labels "printed as email #N" are EXACTLY the parts the PDF leaves out of
// that email because it prints them as an email of its own, and N names the
// email of the PDF that prints them. With "Print full original text" on,
// nothing is labelled that way. The PDF side is read from the PDF model's
// own output (buildPdfDocument): the body of each email it prints.
// Synthetic data only (README.md, rule R7).
import { describe, expect, it } from 'vitest';
import { buildThread, instantOf, type ThreadMessage } from '../../Helper/Test/test-support/thread-builder';
import { THREAD_CASES, type ThreadCase } from '../../Helper/Test/test-support/thread-cases';
import { analyzeThread } from '../thread-analysis/analyze-thread';
import { DEFAULT_OUTPUT_POLICY, planOutput } from '../thread-analysis/output-plan';
import { attachedResult } from '../../Helper/Test/test-support/attached-builder';
import { buildPdfDocument, noRepeat, pdfBodyText, withoutPrintedElsewhere } from '../pdf-export/build-pdf-document';
import { createPdfStrings } from '../pdf-export/pdf-strings';
import { bodyLines, lineText } from '../pdf-export/pdf-text-transforms';
import { pdfBlocks, signatureSources } from './pdf-plan';
import { printedElsewhereRanges } from './printed-elsewhere';
import { rebuiltEntries } from './rebuilt-email-display';
import type { MessagePlan, OutputPolicy } from '../../Header/output-plan';
import type { NormalizedMessage, ParseResult } from '../../Header/parsed-email';
import type { PdfDocument, PdfEmail, PrintedAs } from '../../Header/pdf-document-model';
import type { PdfView } from '../../Header/pdf-plan';
import type { EngineResult } from '../../Header/thread-analysis-result';

const EN = createPdfStrings('en');

/** Message `i` of a conversation as a real file (its body quotes the ones before it). */
function realFile(messages: readonly ThreadMessage[], i: number, tag: string): NormalizedMessage
{
    const threadMessage = messages[i]!;
    const id = (k: number): string => `${tag}-${String(k)}@example.test`;
    const utcMs = instantOf(threadMessage.sent, threadMessage.zone);
    return {
        messageId: id(i),
        inReplyTo: i === 0 ? null : id(i - 1),
        references: Array.from({ length: i }, (_, k) => id(k)),
        date: { utcMs, original: new Date(utcMs).toUTCString(), offsetMinutes: threadMessage.zone.offsetMinutes, zoneKnown: true },
        from: [threadMessage.from],
        to: threadMessage.to,
        cc: threadMessage.cc ?? [],
        bcc: [],
        subject: threadMessage.subject,
        bodyText: buildThread(messages.slice(0, i + 1)).body,
        attachments: [],
        source: { fileName: `${tag}-${String(i)}.eml`, sha256: (i + 1).toString(16).padStart(64, '0'), kind: 'eml' },
        warnings: [],
    };
}

const squash = (s: string): string => s.replace(/\s+/gu, ' ').trim();
const bodyOf = (e: PdfEmail): string => e.body.map(lineText).join('\n');
const keyOf = (printedAs: PrintedAs): string =>
{
    switch (printedAs.kind)
    {
        case 'rebuilt':
            return `rebuilt ${String(printedAs.id)} = Email ${String(printedAs.number)}`;
        case 'email':
            return `email #${String(printedAs.position + 1)} = Email ${String(printedAs.number)}`;
        case 'unticked':
            return `unticked rebuilt ${String(printedAs.id)} (not in the PDF)`;
        case 'unticked-attached':
            return `unticked attached email #${String(printedAs.position + 1)} (not in the PDF)`;
    }
};

/** Where `sentence` (white space squashed) starts in `body`, white space and ">" quote marks between its words allowed; -1 if not found. */
function placeOf(body: string, sentence: string): number
{
    const words = sentence.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
    return body.search(new RegExp(words.join('(?:\\s|>)+'), 'u'));
}

/** The own sentence of each email of the conversation, white space squashed. */
function sentences(threadCase: ThreadCase): string[]
{
    return threadCase.messages!.map((m) => squash(m.text.split('\n\n')[1]!));
}

interface Scenario
{
    readonly name: string;
    /** Conversation indices dropped as files. */
    readonly dropped: (last: number) => number[];
    /** The rebuilt ids chosen, from all of them in timeline order. */
    readonly rebuilt: (ids: readonly number[]) => number[];
}

const SCENARIOS: readonly Scenario[] = [
    { name: 'the last email alone, every rebuilt email ticked', dropped: (l) => [l], rebuilt: (ids) => [...ids] },
    { name: 'the last email alone, no rebuilt email ticked', dropped: (l) => [l], rebuilt: () => [] },
    { name: 'the last email alone, every other rebuilt email ticked', dropped: (l) => [l], rebuilt: (ids) => ids.filter((_, k) => (ids.length - 1 - k) % 2 === 0) },
    { name: 'every email as a file, every rebuilt email ticked', dropped: (l) => Array.from({ length: l + 1 }, (_, k) => k), rebuilt: (ids) => [...ids] },
    { name: 'every email as a file, no rebuilt email ticked', dropped: (l) => Array.from({ length: l + 1 }, (_, k) => k), rebuilt: () => [] },
    { name: 'the first and the last, every rebuilt email ticked', dropped: (l) => [0, l], rebuilt: (ids) => [...ids] },
    { name: 'the first and the last, no rebuilt email ticked', dropped: (l) => [0, l], rebuilt: () => [] },
];

/** The engine result, plans and PDF of a scenario (every email ticked), as the app makes them. */
function setUp(threadCase: ThreadCase, scenario: Scenario, policy: OutputPolicy = DEFAULT_OUTPUT_POLICY)
{
    const tag = threadCase.id.replace(/[^a-z0-9]+/giu, '-');
    const last = threadCase.messages!.length - 1;
    const result: EngineResult = analyzeThread(scenario.dropped(last).map((i) => ({ ok: true as const, message: realFile(threadCase.messages!, i, tag) })));
    return prepare(result, result.messages.map((_, k) => k), scenario.rebuilt, policy);
}

/** The plans, PDF and preview views for the emails at `positions` of `result`, as the app makes them. */
function prepare(result: EngineResult, positions: readonly number[], chooseRebuilt: (ids: readonly number[]) => number[], policy: OutputPolicy = DEFAULT_OUTPUT_POLICY)
{
    const plans = planOutput(
        positions.map((p) => result.messages[p]!),
        policy,
    );
    const ids = rebuiltEntries(result).map((r) => r.id);
    const rebuilt = chooseRebuilt(ids);
    // Every rebuilt email not chosen is one the reader unticked (Source/web-page/review.ts, untickedRebuilt, with every card shown).
    const unticked = ids.filter((id) => !rebuilt.includes(id));
    const input = { result, positions, plans, policy, rebuilt, unticked };
    const pdfDocument: PdfDocument = buildPdfDocument({ ...input, timeZone: 'UTC', generatedAt: Date.UTC(2025, 5, 1, 12, 0, 0), strings: EN });
    // The preview's views, as Source/web-page/pdf-labels.ts makes them.
    const sources = signatureSources(
        positions.map((p) => ({ message: result.messages[p]!.message, position: p })),
        plans,
    );
    const cut = printedElsewhereRanges(input);
    const views = new Map<number, PdfView>();
    positions.forEach((position, k) =>
    {
        const ranges = cut.get(position);
        views.set(position, { plan: plans[k]!, signatureFrom: sources.get(position) ?? new Map(), ...(ranges === undefined ? {} : { pdfRanges: ranges }) });
    });
    return { result, positions, plans, input, doc: pdfDocument, views };
}

/** Per non-blank character of a body: where the preview says it is printed instead (only characters so labelled). */
function labelled(body: string, result: EngineResult, position: number, view: PdfView): Map<number, PrintedAs>
{
    const out = new Map<number, PrintedAs>();
    for (const { block, label } of pdfBlocks(body, result.messages[position]!.segments, view))
    {
        const printedAs = label?.printedAs ?? null;
        if (printedAs === null)
        {
            continue;
        }
        expect(label!.status).toBe('out');
        for (let i = block.start; i < block.end; i++)
        {
            if (/\S/u.test(body[i]!))
            {
                out.set(i, printedAs);
            }
        }
    }
    return out;
}

/** Per non-blank character of a body: kept by `plan` but left out of the PDF (the cut the PDF makes, read from `ranges`). */
function cutChars(body: string, plan: MessagePlan, ranges: readonly { start: number; end: number; keep: boolean }[]): Set<number>
{
    const keptByPlan = new Uint8Array(body.length);
    for (const range of plan.ranges)
    {
        if (range.keep)
        {
            keptByPlan.fill(1, range.start, range.end);
        }
    }
    const out = new Set<number>();
    for (const range of ranges)
    {
        if (range.keep)
        {
            continue;
        }
        for (let i = range.start; i < range.end; i++)
        {
            if (keptByPlan[i] === 1 && /\S/u.test(body[i]!))
            {
                out.add(i);
            }
        }
    }
    return out;
}

interface Counts
{
    labelledSomewhere: number;
    rebuiltTargets: number;
    realTargets: number;
    untickedTargets: number;
    /** Task 8.13b-3: an attached email's block, printed as that email (kind 'email') or left out with it ('unticked-attached'). */
    attachedTargets: number;
    untickedAttachedTargets: number;
    sentencesLabelled: number;
    sentencesKept: number;
}
const newCounts = (): Counts => ({ labelledSomewhere: 0, rebuiltTargets: 0, realTargets: 0, untickedTargets: 0, attachedTargets: 0, untickedAttachedTargets: 0, sentencesLabelled: 0, sentencesKept: 0 });

/**
 * The checks of this file for one prepared input (every email in `positions`
 * is checked). `all`: the conversation's own sentences; `ownOf`: the index
 * in `all` of the sentence of its own of the email at a list position (none
 * for an email that is not a message of the conversation).
 */
function checkLabels(where: string, prepared: ReturnType<typeof prepare>, all: readonly string[], ownOf: (position: number) => number | undefined, counts: Counts): void
{
    const { result, positions, plans, input, doc: pdfDocument, views } = prepared;
    const { elsewhere } = noRepeat(input);
    for (const [k, position] of positions.entries())
    {
        const body = result.messages[position]!.message.bodyText;
        const plan = plans[k]!;
        const email = pdfDocument.emails.find((e) => e.position === position)!;
        // The PDF model's own body is the plan cut by the no-repeat parts (ties the parts to the real output).
        const parts = elsewhere.get(position) ?? [];
        const printed = pdfBodyText(body, plan, DEFAULT_OUTPUT_POLICY, parts);
        expect(email.body.map(lineText), `${where} #${String(position + 1)} body`).toEqual(bodyLines(printed.text, { notLineStarts: printed.notLineStarts }).lines.map(lineText));
        // 1. The characters labelled are exactly the characters the PDF leaves out by this rule.
        const marks = labelled(body, result, position, views.get(position)!);
        const cut = cutChars(body, plan, withoutPrintedElsewhere(body, plan.ranges, parts).ranges);
        expect([...marks.keys()].sort((a, b) => a - b), `${where} #${String(position + 1)} labelled`).toEqual([...cut].sort((a, b) => a - b));
        expect(email.flags.printedElsewhere).toBe(cut.size > 0);
        counts.labelledSomewhere += marks.size > 0 ? 1 : 0;
        // The printed blocks of attached emails in this body (task 8.13b-3).
        const index = result.messages[position]!.index;
        const blocks = (result.attached ?? []).flatMap((a) => a.places.filter((p) => p.holderIndex === index));
        const inBlock = (i: number): boolean => blocks.some((p) => p.start <= i && i < p.end);
        // 2. N names the email the PDF prints it as.
        for (const target of new Map([...marks.values()].map((p) => [keyOf(p), p])).values())
        {
            if (target.kind === 'unticked')
            {
                // Q2 (task 8.13a): a forwarded part of an unticked rebuilt email, printed nowhere.
                counts.untickedTargets++;
                expect(input.rebuilt, keyOf(target)).not.toContain(target.id);
                expect(input.unticked, keyOf(target)).toContain(target.id);
                expect(pdfDocument.emails.some((e) => e.rebuilt?.id === target.id), keyOf(target)).toBe(false);
                continue;
            }
            if (target.kind === 'unticked-attached')
            {
                // Q3 (task 8.13b-3): the block of an attached email whose kept copy is unticked: that copy is
                // not in the PDF, and it is the kept copy of an email attached inside this one.
                counts.untickedAttachedTargets++;
                expect(positions, keyOf(target)).not.toContain(target.position);
                expect(pdfDocument.pdfNumberByPosition[target.position] ?? null, keyOf(target)).toBeNull();
                expect(
                    (result.attached ?? []).some((a) => result.positionByIndex[a.index] === target.position && a.places.some((p) => p.holderIndex === index)),
                    keyOf(target),
                ).toBe(true);
                continue;
            }
            const shown = pdfDocument.emails[target.number - 1]!;
            expect(shown.number, keyOf(target)).toBe(target.number);
            if (target.kind === 'rebuilt')
            {
                counts.rebuiltTargets++;
                expect(shown.rebuilt?.id, keyOf(target)).toBe(target.id);
            }
            else
            {
                counts.realTargets++;
                expect(shown.position, keyOf(target)).toBe(target.position);
                expect(pdfDocument.pdfNumberByPosition[target.position]).toBe(target.number);
            }
        }
        // 3. Read on the emails' own sentences: one labelled is gone from this email and in the email named;
        //    one kept by the plan and not labelled is still in this email.
        const shownHere = squash(bodyOf(email));
        const printedNowhere = (sentence: string): boolean => pdfDocument.emails.every((e) => !squash(bodyOf(e)).includes(sentence));
        for (const [sentenceIndex, sentence] of all.entries())
        {
            const start = placeOf(body, sentence);
            if (start < 0)
            {
                continue;
            }
            const target = marks.get(start);
            if (target !== undefined)
            {
                counts.sentencesLabelled++;
                expect(shownHere, `${where}: "${sentence}" labelled ${keyOf(target)}`).not.toContain(sentence);
                if (target.kind === 'unticked')
                {
                    expect(printedNowhere(sentence), `${where}: "${sentence}" nowhere in the PDF`).toBe(true);
                }
                else if (target.kind === 'unticked-attached')
                {
                    // Q3: the unticked email's own text is nowhere in the PDF (a quote inside its block may be the
                    // own text of another email, printed there).
                    if (ownOf(target.position) === sentenceIndex)
                    {
                        expect(printedNowhere(sentence), `${where}: "${sentence}" nowhere in the PDF`).toBe(true);
                    }
                }
                else if (target.kind === 'email' && inBlock(start))
                {
                    // An attached email's block holds its whole text, quotes included: its own text is printed in
                    // it, every other sentence wherever the email named prints its place.
                    counts.attachedTargets++;
                    const named = squash(bodyOf(pdfDocument.emails[target.number - 1]!));
                    const targetBody = result.messages[target.position]!.message.bodyText;
                    const at = placeOf(targetBody, sentence);
                    const targetPlan = plans[positions.indexOf(target.position)]!;
                    const targetRanges = withoutPrintedElsewhere(targetBody, targetPlan.ranges, elsewhere.get(target.position) ?? []).ranges;
                    const printedThere = at >= 0 && targetRanges.some((r) => r.keep && r.start <= at && at < r.end);
                    if (ownOf(target.position) === sentenceIndex || printedThere)
                    {
                        expect(named, `${where}: "${sentence}" in ${keyOf(target)}`).toContain(sentence);
                    }
                }
                else
                {
                    expect(squash(bodyOf(pdfDocument.emails[target.number - 1]!)), `${where}: "${sentence}" in ${keyOf(target)}`).toContain(sentence);
                }
            }
            else if (plan.ranges.some((r) => r.keep && r.start <= start && start < r.end))
            {
                counts.sentencesKept++;
                expect(shownHere, `${where}: "${sentence}" kept`).toContain(sentence);
            }
        }
    }
}

describe('"printed as email #N" labels say exactly what the PDF leaves out (task 8.11), every conversation of thread-cases.ts', () =>
{
    const counts = newCounts();

    for (const threadCase of THREAD_CASES)
    {
        describe(threadCase.id, () =>
        {
            for (const scenario of SCENARIOS)
            {
                it(scenario.name, () =>
                {
                    checkLabels(threadCase.id, setUp(threadCase, scenario), sentences(threadCase), () => undefined, counts);
                });
            }

            it('"Print full original text": nothing is labelled "printed as" (every email is printed whole)', () =>
            {
                const everything = { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true };
                const { result, positions, input, views } = setUp(threadCase, SCENARIOS[0]!, everything);
                expect(printedElsewhereRanges(input).size).toBe(0);
                for (const position of positions)
                {
                    expect(views.get(position)!.pdfRanges).toBeUndefined();
                    expect(labelled(result.messages[position]!.message.bodyText, result, position, views.get(position)!).size).toBe(0);
                }
            });
        });
    }

    it('the cases really exercise the labels, with both kinds of email named', () =>
    {
        // At the time of writing: 64 emails with labels, 23 rebuilt and 74 real emails named, 97 sentences labelled, 683 kept.
        expect(counts.labelledSomewhere).toBeGreaterThan(50);
        expect(counts.rebuiltTargets).toBeGreaterThan(15);
        expect(counts.realTargets).toBeGreaterThan(50);
        // Task 8.13a, Q2: forwarded parts left out with their unticked rebuilt emails.
        expect(counts.untickedTargets).toBeGreaterThan(5);
        expect(counts.sentencesLabelled).toBeGreaterThan(80);
        expect(counts.sentencesKept).toBeGreaterThan(500);
        // No attached email in these inputs (see the next block).
        expect(counts.attachedTargets + counts.untickedAttachedTargets).toBe(0);
    });
});

/**
 * Task 8.13b-3 (review round 2): the same checks with an email attached
 * inside a dropped file. Per conversation, a forwarder's file holds the last
 * email inline (an inline forward: its printed block is in the forwarder's
 * text) and the first email sent as a file (no block); the forwarder is dated
 * a day after the last email, or (M1) a day before it, so the attached email
 * comes after the email holding it. Scenarios: the forwarder's file alone, or
 * with every email of the conversation also dropped as a file (the dropped
 * copies are kept, the attached ones merged into them, Q8); every email
 * ticked, the last email unticked (Q3: its block is left out of the
 * forwarder too), or the forwarder unticked; every rebuilt email chosen, or
 * none.
 */
describe('"printed as email #N" labels with an email attached inside a dropped file (task 8.13b-3)', () =>
{
    const counts = newCounts();
    const DAY = 86_400_000;

    /** The forwarder's file, holding the last email inline and the first one as a file. */
    function forwarderFile(threadCase: ThreadCase, tag: string, before: boolean): ParseResult
    {
        const messages = threadCase.messages!;
        const last = messages.length - 1;
        const lastFile = realFile(messages, last, tag);
        const utcMs = lastFile.date.utcMs! + (before ? -DAY : DAY);
        const forwarder: NormalizedMessage = {
            ...lastFile,
            messageId: `${tag}-forwarder@example.test`,
            inReplyTo: null,
            references: [],
            date: { utcMs, original: new Date(utcMs).toUTCString(), offsetMinutes: 0, zoneKnown: true },
            from: [{ name: 'Fiona Forward', address: 'fiona@example.test' }],
            subject: `Fwd: ${lastFile.subject}`,
            bodyText: 'Forwarder note: the whole conversation is below, the first email of it is attached as a file.\n',
            source: { fileName: `${tag}-forwarder.eml`, sha256: 'f'.repeat(64), kind: 'eml' },
        };
        return attachedResult({
            message: forwarder,
            children: [
                { node: { message: lastFile }, inline: true },
                { node: { message: realFile(messages, 0, tag) }, inline: false, name: 'first.eml' },
            ],
        });
    }

    /** Which email is unticked: none, the kept copy of the last email, or the forwarder. */
    const SELECTIONS: readonly { readonly name: string; readonly unticked: 'none' | 'last' | 'forwarder' }[] = [
        { name: 'every email ticked', unticked: 'none' },
        { name: 'the last email unticked', unticked: 'last' },
        { name: 'the forwarder unticked', unticked: 'forwarder' },
    ];

    for (const threadCase of THREAD_CASES)
    {
        describe(threadCase.id, () =>
        {
            const tag = threadCase.id.replace(/[^a-z0-9]+/giu, '-');
            const last = threadCase.messages!.length - 1;
            for (const before of [false, true])
            {
                for (const alsoDropped of [false, true])
                {
                    for (const selection of SELECTIONS)
                    {
                        for (const [chosen, choose] of [
                            ['every rebuilt email chosen', (ids: readonly number[]) => [...ids]],
                            ['no rebuilt email chosen', () => []],
                        ] as const)
                        {
                            const name = `forwarder ${before ? 'before' : 'after'} the last email${alsoDropped ? ', every email also dropped' : ''}, ${selection.name}, ${chosen}`;
                            it(name, () =>
                            {
                                const files: ParseResult[] = [forwarderFile(threadCase, tag, before), ...(alsoDropped ? threadCase.messages!.map((_, i) => ({ ok: true as const, message: realFile(threadCase.messages!, i, tag) })) : [])];
                                const result = analyzeThread(files);
                                expect(result.attached).toHaveLength(2);
                                const lastAt = result.messages.findIndex((m) => m.message.messageId === `${tag}-${String(last)}@example.test`);
                                const forwarderAt = result.messages.findIndex((m) => m.message.messageId === `${tag}-forwarder@example.test`);
                                expect(lastAt).toBeGreaterThanOrEqual(0);
                                expect(forwarderAt).toBeGreaterThanOrEqual(0);
                                const unticked = selection.unticked === 'last' ? lastAt : selection.unticked === 'forwarder' ? forwarderAt : -1;
                                const positions = result.messages.map((_, k) => k).filter((p) => p !== unticked);
                                const ownOf = (position: number): number | undefined =>
                                {
                                    const id = result.messages[position]?.message.messageId ?? '';
                                    const match = new RegExp(`^${tag}-(\\d+)@example\\.test$`, 'u').exec(id);
                                    return match === null ? undefined : Number(match[1]);
                                };
                                const prepared = prepare(result, positions, choose);
                                checkLabels(`${threadCase.id} (${name})`, prepared, sentences(threadCase), ownOf, counts);
                                // The last email's own text (M1): printed in the PDF exactly when its kept copy is ticked.
                                const own = sentences(threadCase)[last]!;
                                const pdfDocument = prepared.doc;
                                const times = pdfDocument.emails.filter((e) => squash(bodyOf(e)).includes(own)).length;
                                if (positions.includes(lastAt))
                                {
                                    expect(times, `${name}: the last email's own text`).toBeGreaterThan(0);
                                }
                                else
                                {
                                    expect(times, `${name}: the last email's own text`).toBe(0);
                                }
                            });
                        }
                    }
                }
            }
        });
    }

    it('the cases really exercise attached emails, printed as themselves and left out with them', () =>
    {
        console.log(`printed-elsewhere with attached emails: ${JSON.stringify(counts)}`);
        expect(counts.attachedTargets).toBeGreaterThan(20);
        expect(counts.untickedAttachedTargets).toBeGreaterThan(5);
        expect(counts.sentencesLabelled).toBeGreaterThan(50);
    });
});
