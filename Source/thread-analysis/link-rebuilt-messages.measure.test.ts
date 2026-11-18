// Measurement of thread rebuilding INSIDE the engine (milestone 7, task 7.5):
// every conversation of Helper/Test/test-support/thread-cases.ts is dropped as real
// files in several ways, runEngine runs, and the timeline is compared with
// the ground truth of Helper/Test/test-support/thread-builder.ts. Targets:
// 1. all messages dropped: 0 rebuilt entries in the timeline (each rebuilt
//    message linked to its own real file);
// 2. only the last message dropped: the timeline holds every earlier
//    message the splitter rebuilds, in conversation order, then the email;
// 3. partial drops: no conversation message twice, none missing (every
//    dropped one, and every one rebuilt from at least one dropped email),
//    in conversation order;
// and in every scenario 0 wrong links (a rebuilt message linked to another
// message's real file, or merged with another message's copy).
// Synthetic data only (README.md, rule R7).

import { describe, expect, it } from 'vitest';
import { buildThread, instantOf, isForwardStyle, QUOTE_STYLES, type QuoteStyle, type ThreadMessage } from '../../Helper/Test/test-support/thread-builder';
import { ALICE, BOB, CAROL, chain, DAVE, ERIN, THREAD_CASES, type ThreadCase } from '../../Helper/Test/test-support/thread-cases';
import { DEFAULT_PARTS, runEngine } from './analyze-thread';
import type { NormalizedMessage, ParseResult } from '../../Header/parsed-email';
import type { EngineResult } from '../../Header/thread-analysis-result';

/** Message `i` of a conversation as a real dropped file (its body quotes the ones before it). */
export function realFile(messages: readonly ThreadMessage[], i: number, tag: string): NormalizedMessage
{
    const message = messages[i];
    if (message === undefined)
    {
        throw new Error(`no message ${i}`);
    }
    const id = (k: number): string => `${tag}-${k}@example.test`;
    const utcMs = instantOf(message.sent, message.zone);
    return {
        messageId: id(i),
        inReplyTo: i === 0 ? null : id(i - 1),
        references: Array.from({ length: i }, (_, k) => id(k)),
        date: { utcMs, original: new Date(utcMs).toUTCString(), offsetMinutes: message.zone.offsetMinutes, zoneKnown: true },
        from: [message.from],
        to: message.to,
        cc: message.cc ?? [],
        bcc: [],
        subject: message.subject,
        bodyText: buildThread(messages.slice(0, i + 1)).body,
        attachments: [],
        source: { fileName: `${tag}-${i}.eml`, sha256: (i + 1).toString(16).padStart(64, '0'), kind: 'eml' },
        warnings: [],
    };
}

/** What one engine run says about one conversation. */
export interface Outcome
{
    /** Conversation index of each timeline entry, in timeline order (-1: a rebuilt entry at no true header). */
    readonly order: readonly number[];
    readonly rebuiltEntries: number;
    /** Links to the wrong real file or the wrong copy, and rebuilt entries at no true header. */
    readonly wrong: readonly string[];
    /** Conversation indices dropped or rebuilt (rightly) from a dropped email: the ones the timeline must hold. */
    readonly expected: ReadonlySet<number>;
    readonly result: EngineResult;
}

/** Drops the messages `dropped` (conversation indices, in that drop order) and reads the timeline. */
export function runScenario(threadCase: ThreadCase, dropped: readonly number[]): Outcome
{
    const messages = threadCase.messages;
    if (messages === undefined)
    {
        throw new Error(`${threadCase.id}: no messages`);
    }
    const tag = threadCase.id.replace(/[^a-z0-9]+/giu, '-');
    const results: ParseResult[] = dropped.map((i) => ({ ok: true, message: realFile(messages, i, tag) }));
    const result = runEngine(results);
    const convOfInput = (index: number): number => dropped[index] ?? -1;
    // Ground truth of each dropped body: header start -> conversation index.
    const truthOf = new Map<number, Map<number, number>>();
    dropped.forEach((i, input) => truthOf.set(input, new Map(buildThread(messages.slice(0, i + 1)).headers.map((h) => [h.start, h.index]))));
    const convOfRebuilt = (id: number): number =>
    {
        const entry = result.reconstructed[id];
        return entry === undefined ? -1 : (truthOf.get(entry.sourceIndex)?.get(entry.rebuilt.start) ?? -1);
    };

    const wrong: string[] = [];
    const expected = new Set<number>(dropped);
    for (const entry of result.reconstructed)
    {
        const conv = convOfRebuilt(entry.id);
        if (conv < 0)
        {
            wrong.push(`rebuilt #${entry.id} (from message ${convOfInput(entry.sourceIndex)}) is at no true header`);
            continue;
        }
        expected.add(conv);
        if (entry.link === 'real' && convOfInput(entry.realIndex ?? -1) !== conv)
        {
            wrong.push(`message ${conv} linked to real message ${convOfInput(entry.realIndex ?? -1)}`);
        }
        if (entry.link === 'same-as' && convOfRebuilt(entry.sameAs ?? -1) !== conv)
        {
            wrong.push(`message ${conv} merged with a copy of message ${convOfRebuilt(entry.sameAs ?? -1)}`);
        }
    }
    const order = result.timeline.map((e) => (e.kind === 'message' ? convOfInput(result.messages[e.position]?.index ?? -1) : convOfRebuilt(e.id)));
    return { order, rebuiltEntries: result.timeline.filter((e) => e.kind === 'rebuilt').length, wrong, expected, result };
}

const duplicatesIn = (order: readonly number[]): number[] => order.filter((v, k) => order.indexOf(v) !== k);
const missingIn = (o: Outcome): number[] => [...o.expected].filter((v) => !o.order.includes(v)).sort((a, b) => a - b);
const inOrder = (order: readonly number[]): boolean => order.every((v, k) => k === 0 || v > (order[k - 1] ?? -1));

/** Partial drops of a conversation of n messages (each a list of conversation indices, in drop order). */
function partialDrops(count: number): number[][]
{
    const all = Array.from({ length: count }, (_, k) => k);
    const sets = [
        all.filter((k) => (count - 1 - k) % 2 === 0), // every other one, ending with the last
        all.filter((k) => (count - 1 - k) % 2 === 1), // every other one, without the last
        [0, count - 1],
        [count - 2, count - 1],
        all.slice(0, -1), // all but the last
        [Math.floor(count / 2)],
        [Math.floor(count / 2), count - 1],
    ];
    const unique = new Map<string, number[]>();
    for (const dropSet of sets)
    {
        const clean = [...new Set(dropSet.filter((k) => k >= 0 && k < count))];
        if (clean.length > 0 && clean.length < count)
        {
            unique.set(clean.join(','), clean);
        }
    }
    // Each one also dropped in reverse order: the drop order must not matter.
    return [...unique.values()].flatMap((s) => [s, [...s].reverse()]);
}

const CASES = THREAD_CASES.filter((c) => c.messages !== undefined);

describe('thread rebuilding in the engine: milestone 7 targets (task 7.5)', () =>
{
    it('has every thread case with its messages', () =>
    {
        expect(CASES.length).toBe(THREAD_CASES.length);
    });

    it('(1) all messages dropped: 0 rebuilt entries, every rebuilt message linked to its own real file', () =>
    {
        const rows: string[] = [];
        let rebuilt = 0;
        let linked = 0;
        for (const threadCase of CASES)
        {
            const messageCount = threadCase.messages?.length ?? 0;
            const outcome = runScenario(threadCase, Array.from({ length: messageCount }, (_, k) => k));
            rebuilt += outcome.result.reconstructed.length;
            linked += outcome.result.reconstructed.filter((r) => r.link === 'real').length;
            const inSequence = outcome.order.join(' ') === Array.from({ length: messageCount }, (_, k) => k).join(' ');
            if (outcome.rebuiltEntries > 0 || outcome.wrong.length > 0 || !inSequence)
            {
                rows.push(`  ${threadCase.id}: ${outcome.rebuiltEntries} entries; order ${outcome.order.join(' ')}; ${outcome.wrong.join('; ')}`);
            }
        }
        console.log(`target 1 (all dropped): ${rebuilt} rebuilt messages, ${linked} linked to their real file${rows.length === 0 ? '' : `\n${rows.join('\n')}`}`);
        expect(rows).toEqual([]);
        expect(linked).toBe(rebuilt);
        expect(rebuilt).toBeGreaterThan(200);
    });

    it('(2) only the last message dropped: the full conversation the splitter rebuilds, in order', () =>
    {
        let entries = 0;
        let truths = 0;
        const short: string[] = [];
        for (const threadCase of CASES)
        {
            const messageCount = threadCase.messages?.length ?? 0;
            const outcome = runScenario(threadCase, [messageCount - 1]);
            expect(outcome.wrong, threadCase.id).toEqual([]);
            expect(duplicatesIn(outcome.order), threadCase.id).toEqual([]);
            expect(inOrder(outcome.order), `${threadCase.id}: ${outcome.order.join(' ')}`).toBe(true);
            expect(outcome.order[outcome.order.length - 1], threadCase.id).toBe(messageCount - 1);
            // Every rebuilt message is an entry (nothing to link to), so the timeline is the splitter's output.
            expect(outcome.rebuiltEntries, threadCase.id).toBe(outcome.result.reconstructed.length);
            expect(missingIn(outcome), threadCase.id).toEqual([]);
            entries += outcome.rebuiltEntries;
            truths += messageCount - 1;
            if (outcome.rebuiltEntries < messageCount - 1)
            {
                short.push(`  ${threadCase.id}: ${outcome.rebuiltEntries} of ${messageCount - 1}`);
            }
        }
        console.log(`target 2 (last dropped): ${entries} of ${truths} earlier messages in the timeline${short.length === 0 ? '' : `\n${short.join('\n')}`}`);
        expect(entries / truths).toBeGreaterThanOrEqual(0.9);
    });

    it('(3) partial drops: no duplicates, no missing entries, conversation order, no wrong link', () =>
    {
        let scenarios = 0;
        let linkedReal = 0;
        let sameAs = 0;
        const problems: string[] = [];
        for (const threadCase of CASES)
        {
            const messageCount = threadCase.messages?.length ?? 0;
            for (const dropped of partialDrops(messageCount))
            {
                scenarios++;
                const outcome = runScenario(threadCase, dropped);
                linkedReal += outcome.result.reconstructed.filter((r) => r.link === 'real').length;
                sameAs += outcome.result.reconstructed.filter((r) => r.link === 'same-as').length;
                const label = `${threadCase.id} [${dropped.join(',')}]`;
                const duplicates = duplicatesIn(outcome.order);
                const missing = missingIn(outcome);
                if (outcome.wrong.length > 0 || duplicates.length > 0 || missing.length > 0 || !inOrder(outcome.order))
                {
                    problems.push(`  ${label}: order ${outcome.order.join(' ')}; duplicates ${duplicates.join(',')}; missing ${missing.join(',')}; ${outcome.wrong.join('; ')}`);
                }
            }
        }
        console.log(`target 3 (partial drops): ${scenarios} scenarios, ${linkedReal} links to real files, ${sameAs} same-as links${problems.length === 0 ? '' : `\n${problems.join('\n')}`}`);
        expect(problems).toEqual([]);
        expect(scenarios).toBeGreaterThan(200);
        expect(linkedReal).toBeGreaterThan(100);
        expect(sameAs).toBeGreaterThan(100);
    });
});

describe('thread rebuilding in the engine: speed (task 7.5)', () =>
{
    const STYLES: readonly QuoteStyle[] = QUOTE_STYLES.filter((s) => !isForwardStyle(s));
    const PEOPLE = [ALICE, BOB, CAROL, DAVE, ERIN];

    /** Times the rebuilding stages of one engine run. */
    function timed(results: readonly ParseResult[]): { out: EngineResult; total: number; rebuild: number }
    {
        let stageStart = 0;
        let rebuild = 0;
        const startTime = performance.now();
        const out = runEngine(results, {
            ...DEFAULT_PARTS,
            onStage: (stage) =>
            {
                const now = performance.now();
                if (stage === 'reconstruct')
                {
                    stageStart = now;
                }
                if (stage === 'done')
                {
                    rebuild = now - stageStart;
                }
            },
        });
        return { out, total: performance.now() - startTime, rebuild };
    }

    it('200 dropped emails with 19-generation quoted histories stay within a generous bound', () =>
    {
        // 10 conversations of 20 messages, every message dropped (each quotes all the ones before it).
        const all: ParseResult[] = [];
        for (let k = 0; k < 10; k++)
        {
            const styles = Array.from({ length: 19 }, (_, i) => STYLES[(i + k) % STYLES.length] as QuoteStyle);
            const messages = chain(styles, { people: PEOPLE, subject: `Case ${k}`, start: Date.UTC(2025, 2, 3 + 2 * k, 8, 0) });
            for (let i = messages.length - 1; i >= 0; i--)
            {
                all.push({ ok: true, message: realFile(messages, i, `speed-${k}`) });
            }
        }
        const chars = all.reduce((n, r) => n + (r.ok ? r.message.bodyText.length : 0), 0);
        const { out, total, rebuild } = timed(all);
        // 200 identical-shaped last emails of one long conversation, each from its own export
        // (other ids, a minute apart): every quoted message is a copy 200 times over.
        const base = chain(Array.from({ length: 19 }, (_, i) => STYLES[i % STYLES.length] as QuoteStyle), { people: PEOPLE });
        const copies: ParseResult[] = Array.from({ length: 200 }, (_, k) =>
        {
            const message = realFile(base, base.length - 1, `copy-${k}`);
            return { ok: true, message: { ...message, date: { ...message.date, utcMs: (message.date.utcMs ?? 0) + k * 60_000 } } };
        });
        const many = timed(copies);
        console.log(
            `rebuild speed: ${all.length} emails, ${(chars / 1e6).toFixed(2)} MB, ${out.reconstructed.length} rebuilt, total ${total.toFixed(0)} ms, ` +
                `rebuilding ${rebuild.toFixed(0)} ms; 200 copies of one last email: ${many.out.reconstructed.length} rebuilt, ` +
                `${many.out.timeline.length - many.out.messages.length} entries, rebuilding ${many.rebuild.toFixed(0)} ms`,
        );
        expect(all.length).toBe(200);
        expect(out.reconstructed.length).toBeGreaterThan(1500);
        expect(out.reconstructed.every((r) => r.link === 'real')).toBe(true);
        expect(many.out.reconstructed.length).toBe(200 * 19);
        expect(many.out.timeline.length - many.out.messages.length).toBe(19);
        expect(total).toBeLessThan(20_000);
        expect(many.total).toBeLessThan(20_000);
    }, 60_000);
});
