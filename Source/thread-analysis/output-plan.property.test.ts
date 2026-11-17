// Property and speed tests for the PDF output plan (output-plan.ts).
//
// Random synthetic emails (seeded, so every run is the same) get segments
// either from random folds (buildSegments, any range, any reason) or from the
// real engine (runEngine), and every plan is checked:
// - the ranges cover [0, length) with no gap or overlap, and joining kept and
//   left-out ranges gives the exact body back;
// - every left-out range lies inside folded segments (text that is not
//   folded is never left out, README.md, rule R6);
// - unfoldEverything leaves nothing out;
// - switching appQuotedHistory from 'omit' to 'keep' only ever brings text
//   back, and signatures 'none' leaves out at least what 'first-per-sender'
//   does;
// - the result is the same when computed twice, and the (frozen) input is not
//   modified.
// The random generator is mulberry32 (a few lines), so no dependency is needed.
// Synthetic data only: made-up names, *.test addresses.

import { describe, expect, it } from 'vitest';
import { FORWARDED_SEPARATOR } from '../email-reading/forwarded-block';
import type { EmailAddress, NormalizedMessage } from '../email-reading/types';
import { runEngine } from './engine';
import { DEFAULT_OUTPUT_POLICY, planOutput, type MessagePlan, type OutputPolicy, type PlanInput } from './output-plan';
import { detectQuoteMarkers } from './quote-markers';
import { detectReplyHeaders } from './reply-header';
import { buildSegments, FOLD_REASONS, type FoldRange, type Segment } from './segments';
import { signatureBlockKey } from './signature';

/** mulberry32: a tiny seeded generator, returns numbers in [0, 1). */
function makeRandom(seed: number): () => number
{
    let a = seed >>> 0;
    return () =>
    {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function pick<V>(random: () => number, list: readonly V[]): V
{
    return list[Math.floor(random() * list.length)]!;
}

const SENDERS: readonly (readonly EmailAddress[])[] = [
    [{ name: 'Alice Example', address: 'alice@example.test' }],
    [{ name: 'Bob Sample', address: 'bob@furniture.example.test' }],
    [{ name: 'Carol Test', address: 'carol@sample.test' }],
    [{ name: 'No Address', address: '' }],
    [],
];

const SUBJECTS = ['Office furniture', 'RE: Office furniture', 'Fwd: Office furniture', 'TR: Bureau', '[EXT] FW: Stock'];

const LINES = [
    'desk chair table office delivery invoice quote room measure visit',
    'monday morning truck driver floor door key plan week order',
    'caf\u{E9} \u{E9}t\u{E9} na\u{EF}ve gr\u{FC}\u{DF}e r\u{E9}union \u{1F600} \u{1F4E6}',
    '> quoted desk chair table office delivery',
    '> > nested quoted line about the invoice',
    '>',
    '',
    '   ',
    '-- ',
    'Bob Sample',
    'Sample Furniture (fictional company)',
    'On Mon, 3 Mar 2025 at 14:02, Alice Example <alice@example.test> wrote:',
    '________________________________',
    'From: Alice Example <alice@example.test>',
    'Sent: Monday, March 3, 2025 9:15 AM',
    'To: Bob Sample <bob@furniture.example.test>',
    'Subject: Office furniture',
    '---------- Forwarded message ---------',
    '-----Original Message-----',
    FORWARDED_SEPARATOR,
    'Date: Mon, 3 Mar 2025 10:00:00 +0000',
];

function randomBody(random: () => number): string
{
    if (random() < 0.05)
    {
        return '';
    }
    const count = 1 + Math.floor(random() * 25);
    const breaks = ['\n', '\n', '\n', '\r\n', '\r'];
    let body = '';
    for (let i = 0; i < count; i++)
    {
        body += pick(random, LINES) + pick(random, breaks);
    }
    if (random() < 0.3)
    {
        body = body.slice(0, Math.floor(random() * body.length)); // may cut an emoji in half
    }
    return body;
}

let serial = 0;
function randomMessage(random: () => number): NormalizedMessage
{
    serial++;
    const ms = Date.parse('2025-03-01T08:00:00Z') + serial * 60_000;
    return {
        messageId: `p${serial}@example.test`,
        inReplyTo: null,
        references: [],
        date: { utcMs: ms, original: new Date(ms).toUTCString(), offsetMinutes: 0, zoneKnown: true },
        from: pick(random, SENDERS),
        to: [],
        cc: [],
        bcc: [],
        subject: pick(random, SUBJECTS),
        bodyText: randomBody(random),
        attachments: [],
        source: { fileName: `p-${serial}.eml`, sha256: serial.toString(16).padStart(64, '0'), kind: 'eml' },
        warnings: [],
    };
}

/** Random folds: any range (also reversed, out of bounds, inside an emoji), any reason. */
function randomFolds(random: () => number, length: number): FoldRange[]
{
    const folds: FoldRange[] = [];
    const count = Math.floor(random() * 6);
    for (let i = 0; i < count; i++)
    {
        const a = Math.floor(random() * (length + 2)) - 1;
        const b = random() < 0.3 ? length : Math.floor(random() * (length + 2)) - 1;
        const fold: FoldRange = { start: a, end: b, reason: pick(random, FOLD_REASONS) };
        folds.push(random() < 0.7 ? { ...fold, related: Math.floor(random() * 12) } : fold);
    }
    return folds;
}

function deepFreeze<T>(value: T): T
{
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value))
    {
        Object.freeze(value);
        for (const v of Object.values(value))
        {
            deepFreeze(v);
        }
    }
    return value;
}

/** Left-out mask of one plan: 1 for every left-out code unit. */
function mask(length: number, plan: MessagePlan): Uint8Array
{
    const out = new Uint8Array(length);
    for (const r of plan.ranges)
    {
        if (!r.keep)
        {
            out.fill(1, r.start, r.end);
        }
    }
    return out;
}

function foldedMask(length: number, segments: readonly Segment[]): Uint8Array
{
    const out = new Uint8Array(length);
    for (const s of segments)
    {
        if (s.folded)
        {
            out.fill(1, s.start, s.end);
        }
    }
    return out;
}

function checkPlans(inputs: readonly PlanInput[], plans: readonly MessagePlan[], policy: OutputPolicy, where: string): void
{
    expect(plans.length, where).toBe(inputs.length);
    plans.forEach((p, k) =>
    {
        const body = inputs[k]!.message.bodyText;
        const at = `${where} message ${k}`;
        let next = 0;
        p.ranges.forEach((r, i) =>
        {
            expect(r.start, at).toBe(next);
            expect(r.end, at).toBeGreaterThan(r.start);
            const prev = p.ranges[i - 1];
            if (prev !== undefined)
            {
                expect(prev.keep === r.keep && prev.reason === r.reason, `${at}: unmerged neighbours`).toBe(false);
            }
            if (!r.keep)
            {
                expect(['app-quoted-history', 'signature', 'repeated-signature'], at).toContain(r.reason);
            }
            next = r.end;
        });
        expect(next, at).toBe(body.length);
        expect(p.ranges.map((r) => body.slice(r.start, r.end)).join(''), at).toBe(body);

        const left = mask(body.length, p);
        const folded = foldedMask(body.length, inputs[k]!.segments);
        if (!p.fallback)
        {
            for (let i = 0; i < body.length; i++)
            {
                if (left[i] === 1 && folded[i] !== 1)
                {
                    expect.fail(`${at}: unfolded offset ${i} left out`);
                }
            }
        }
        if (policy.unfoldEverything)
        {
            expect(left.includes(1), at).toBe(false);
        }

        // Rule 4: an email with text always keeps some of it; when nothing else was left, everything is kept.
        const keptText = p.ranges.some((r) => r.keep && /\S/.test(body.slice(r.start, r.end)));
        if (/\S/.test(body))
        {
            expect(keptText, at).toBe(true);
        }
        if (p.keptAllBecauseEmpty)
        {
            expect(left.includes(1), at).toBe(false);
        }
    });
}

/** Checks all policies against each other for one list of inputs. */
function checkAllPolicies(inputs: readonly PlanInput[], where: string): void
{
    deepFreeze(inputs);
    const policies: OutputPolicy[] = [];
    for (const appQuotedHistory of ['omit', 'keep'] as const)
    {
        for (const signatures of ['first-per-sender', 'all', 'none'] as const)
        {
            for (const unfoldEverything of [false, true])
            {
                policies.push({ appQuotedHistory, signatures, unfoldEverything });
            }
        }
    }
    const results = new Map<string, MessagePlan[]>();
    for (const policy of policies)
    {
        const plans = planOutput(inputs, policy);
        checkPlans(inputs, plans, policy, `${where} ${JSON.stringify(policy)}`);
        results.set(JSON.stringify(policy), plans);
    }
    const get = (policy: OutputPolicy): MessagePlan[] => results.get(JSON.stringify(policy))!;
    // Same result when computed twice.
    expect(planOutput(inputs, DEFAULT_OUTPUT_POLICY)).toEqual(get(DEFAULT_OUTPUT_POLICY));

    // A stricter policy leaves out at least as much, except when it emptied the
    // email and rule 4 kept the whole body (keptAllBecauseEmpty).
    inputs.forEach((input, k) =>
    {
        const length = input.message.bodyText.length;
        for (const signatures of ['first-per-sender', 'all', 'none'] as const)
        {
            const omitPlan = get({ appQuotedHistory: 'omit', signatures, unfoldEverything: false })[k]!;
            if (omitPlan.keptAllBecauseEmpty)
            {
                continue;
            }
            const omit = mask(length, omitPlan);
            const keep = mask(length, get({ appQuotedHistory: 'keep', signatures, unfoldEverything: false })[k]!);
            for (let i = 0; i < length; i++)
            {
                if (keep[i] === 1 && omit[i] !== 1)
                {
                    expect.fail(`${where} message ${k}: 'keep' left out more at ${i}`);
                }
            }
        }
        for (const appQuotedHistory of ['omit', 'keep'] as const)
        {
            const nonePlan = get({ appQuotedHistory, signatures: 'none', unfoldEverything: false })[k]!;
            if (nonePlan.keptAllBecauseEmpty)
            {
                continue;
            }
            const first = mask(length, get({ appQuotedHistory, signatures: 'first-per-sender', unfoldEverything: false })[k]!);
            const none = mask(length, nonePlan);
            for (let i = 0; i < length; i++)
            {
                if (first[i] === 1 && none[i] !== 1)
                {
                    expect.fail(`${where} message ${k}: 'none' left out less at ${i}`);
                }
            }
        }
    });
}

const FOLD_SEEDS = Array.from({ length: 300 }, (_, k) => 1 + k);
const ENGINE_SEEDS = Array.from({ length: 150 }, (_, k) => 1000 + k);

/**
 * One set of random folds for `seed`. Everything depends on the seed only
 * (`serial` is reset too), so a test gives the same sets when run alone.
 */
function foldSet(seed: number): PlanInput[]
{
    serial = seed * 100;
    const random = makeRandom(seed);
    const count = 1 + Math.floor(random() * 6);
    const inputs: PlanInput[] = [];
    for (let k = 0; k < count; k++)
    {
        let message = randomMessage(random);
        const folds = randomFolds(random, message.bodyText.length);
        if (random() < 0.5)
        {
            // A fixed signature, folded, at the start or the end: repeated signatures.
            const sig = '-- \nBob Sample\nSample Furniture\n';
            // Mostly at the start: at the end it often lands in a forwarded part, which is always kept.
            const atStart = random() < 0.7;
            const body = atStart ? `${sig}${message.bodyText}` : `${message.bodyText}\n${sig}`;
            const start = atStart ? 0 : body.length - sig.length;
            folds.push({ start, end: start + sig.length, reason: 'signature' });
            message = { ...message, bodyText: body };
        }
        inputs.push({ message, segments: buildSegments(message.bodyText, folds), index: k });
    }
    return inputs;
}

/** One set of random emails for `seed`, through the real engine (same seed-only rule as foldSet). */
function engineSet(seed: number): readonly PlanInput[]
{
    serial = seed * 100;
    const random = makeRandom(seed);
    const count = 1 + Math.floor(random() * 5);
    const messages = Array.from({ length: count }, () => randomMessage(random));
    return runEngine(messages.map((message) => ({ ok: true as const, message }))).messages;
}

/** An included subset of an engine set (every other email). */
const subset = (inputs: readonly PlanInput[]): PlanInput[] => inputs.filter((_, k) => k % 2 === 0);

describe('planOutput: properties', () =>
{
    it('holds the invariants over random folds (300 seeded sets)', () =>
    {
        for (const seed of FOLD_SEEDS)
        {
            checkAllPolicies(foldSet(seed), `seed ${seed}`);
        }
    });

    it('holds the invariants over the real engine (150 seeded sets), and for every subset of included emails', () =>
    {
        for (const seed of ENGINE_SEEDS)
        {
            const inputs = engineSet(seed);
            checkAllPolicies(inputs, `seed ${seed}`);
            checkAllPolicies(subset(inputs), `seed ${seed} subset`);
        }
    }, 60_000); // 150 engine runs: slow on a busy machine

    it('the random sets above do exercise every rule', () =>
    {
        // Counts its own sets (the same seeds as above), so it also passes when run alone.
        const seen = { tails: 0, signatures: 0, forwarded: 0 };
        const count = (inputs: readonly PlanInput[]): void =>
        {
            for (const p of planOutput(inputs))
            {
                if (p.ranges.some((r) => !r.keep && r.reason === 'app-quoted-history'))
                {
                    seen.tails++;
                }
                if (p.omittedSignatures > 0)
                {
                    seen.signatures++;
                }
                if (p.ranges.some((r) => r.reason === 'forwarded'))
                {
                    seen.forwarded++;
                }
            }
        };
        for (const seed of FOLD_SEEDS)
        {
            count(foldSet(seed));
        }
        for (const seed of ENGINE_SEEDS)
        {
            const inputs = engineSet(seed);
            count(inputs);
            count(subset(inputs));
        }
        console.log(`output plan properties: ${JSON.stringify(seen)} emails with a left-out tail / signature / forwarded part`);
        // Thresholds: about half of the counts measured when this test was written
        // (tails 57, signatures 25, forwarded 956), so a small change to the
        // generator or the engine does not break it, but a rule that stops firing does.
        expect(seen.tails).toBeGreaterThan(25);
        expect(seen.signatures).toBeGreaterThan(12);
        expect(seen.forwarded).toBeGreaterThan(450);
    });

    it('signatureBlockKey ignores blank lines and whitespace runs, keeps case', () =>
    {
        expect(signatureBlockKey('-- \r\nBob  Sample\n\n\u{A0}Sample\tFurniture \n')).toBe('--\nBob Sample\nSample Furniture');
        expect(signatureBlockKey('Bob Sample')).not.toBe(signatureBlockKey('bob sample'));
        expect(signatureBlockKey('')).toBe('');
    });
});

describe('planOutput: speed', () =>
{
    /** A batch of replies: own text, a signature, an Outlook block and a long quote. */
    function batch(count: number): PlanInput[]
    {
        const random = makeRandom(count);
        const inputs: PlanInput[] = [];
        for (let k = 0; k < count; k++)
        {
            const own = Array.from({ length: 5 }, () => `${pick(random, LINES.slice(0, 3))} ${k}`).join('\n');
            const quote = Array.from({ length: 30 }, () => pick(random, LINES.slice(0, 3))).join('\n');
            const body = `${own}\n\n-- \nBob Sample\nSample Furniture (fictional company)\n\n________________________________\nFrom: Alice Example <alice@example.test>\nSent: Monday, March 3, 2025 9:15 AM\nTo: Bob Sample <bob@furniture.example.test>\nSubject: Office\n\n${quote}\n> a\n> b\n`;
            const sigStart = body.indexOf('-- ');
            const folds: FoldRange[] = [
                ...detectReplyHeaders(body),
                ...detectQuoteMarkers(body),
                { start: sigStart, end: body.indexOf('\n\n____', sigStart) + 1, reason: 'signature' },
            ];
            const message: NormalizedMessage = { ...randomMessage(random), from: SENDERS[k % 3]!, subject: 'RE: Office', bodyText: body };
            inputs.push({ message, segments: buildSegments(body, folds), index: k });
        }
        return inputs;
    }

    it('plans 2000 emails (several MB) about linearly', () =>
    {
        const small = batch(500);
        const large = batch(2000);
        const chars = large.reduce((n, m) => n + m.message.bodyText.length, 0);
        planOutput(small); // warm-up
        const t0 = performance.now();
        planOutput(small);
        const t1 = performance.now();
        const plans = planOutput(large);
        const t2 = performance.now();
        console.log(
            `output plan speed: 500 emails ${(t1 - t0).toFixed(0)} ms; 2000 emails, ${(chars / 1e6).toFixed(2)} MB: ${(t2 - t1).toFixed(0)} ms`,
        );
        expect(chars).toBeGreaterThan(3_000_000);
        expect(plans.filter((p) => p.tailStart !== null)).toHaveLength(2000);
        expect(plans.reduce((n, p) => n + p.omittedSignatures, 0)).toBe(2000 - 3);
        // No absolute bound (it failed on a busy machine); only the ratio.
        // About linear: four times the emails, well under sixteen times the time.
        expect(t2 - t1).toBeLessThan(10 * (t1 - t0) + 100);
    });
});
