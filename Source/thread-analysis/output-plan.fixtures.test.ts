// Runs the PDF output plan (output-plan.ts) over every synthetic fixture
// (Helper/Test/test-data), parsed and run through the engine as the app does, with
// the default policy. Prints, per email, what the PDF would leave out, and
// checks the key expectations on the known fixture threads.

import { describe, expect, it } from 'vitest';
import { parseAllFixtures } from '../../Helper/Test/test-data/parse-all';
import { analyzeThread } from './analyze-thread';
import { planOutput } from './output-plan';
import type { MessagePlan } from '../../Header/output-plan';
import type { EngineMessage } from '../../Header/thread-analysis-result';

function keptText(message: EngineMessage, messagePlan: MessagePlan): string
{
    return messagePlan.ranges.filter((r) => r.keep).map((r) => message.message.bodyText.slice(r.start, r.end)).join('');
}

/** Whether every character of `snippet` (first occurrence) is kept, none is, or some are. */
function state(message: EngineMessage, messagePlan: MessagePlan, snippet: string): 'kept' | 'left out' | 'mixed'
{
    const offset = message.message.bodyText.indexOf(snippet);
    if (offset < 0)
    {
        throw new Error(`${message.message.source.fileName}: snippet not found: ${snippet}`);
    }
    let out = 0;
    for (const range of messagePlan.ranges)
    {
        if (!range.keep)
        {
            out += Math.max(0, Math.min(range.end, offset + snippet.length) - Math.max(range.start, offset));
        }
    }
    if (out === 0)
    {
        return 'kept';
    }
    return out === snippet.length ? 'left out' : 'mixed';
}

describe('output plan over the parsed fixtures', () =>
{
    let cached: { messages: readonly EngineMessage[]; plans: MessagePlan[] } | undefined;
    async function run(): Promise<NonNullable<typeof cached>>
    {
        if (cached === undefined)
        {
            const parsed = await parseAllFixtures();
            const out = analyzeThread(parsed.map((message) => ({ ok: true as const, message })));
            cached = { messages: out.messages, plans: planOutput(out.messages) };
        }
        return cached;
    }
    const find = (runResult: NonNullable<typeof cached>, file: string): [EngineMessage, MessagePlan] =>
    {
        const k = runResult.messages.findIndex((m) => m.message.source.fileName === file);
        if (k < 0)
        {
            throw new Error(`no kept message for ${file}`);
        }
        return [runResult.messages[k]!, runResult.plans[k]!];
    };

    it('keeps the first line of every email, and reports what is left out', async () =>
    {
        const runResult = await run();
        let tails = 0;
        let signatures = 0;
        const rows = runResult.messages.map((message, k) =>
        {
            const messagePlan = runResult.plans[k]!;
            const body = message.message.bodyText;
            expect(messagePlan.fallback, message.message.source.fileName).toBe(false);
            const firstLine = body.split(/\r\n|\n|\r/).find((line) => line.trim() !== '');
            if (firstLine !== undefined)
            {
                expect(state(message, messagePlan, firstLine), `${message.message.source.fileName}: first line`).toBe('kept');
            }
            const left = messagePlan.ranges.filter((r) => !r.keep).reduce((n, r) => n + r.end - r.start, 0);
            if (messagePlan.tailStart !== null)
            {
                tails++;
            }
            signatures += messagePlan.omittedSignatures;
            const notes = [
                messagePlan.tailStart === null ? '' : `quoted history from ${messagePlan.tailStart}`,
                messagePlan.omittedSignatures > 0 ? `${messagePlan.omittedSignatures} signature(s)` : '',
                messagePlan.ranges.some((r) => r.reason === 'forwarded') ? 'has forwarded part' : '',
                messagePlan.keptAllBecauseEmpty ? 'KEPT WHOLE (nothing else left)' : '',
            ].filter((s) => s !== '');
            return `${message.message.source.fileName}: ${body.length} chars, ${left} left out${notes.length > 0 ? ` (${notes.join(', ')})` : ''}`;
        });
        console.log(`output plan on fixtures: ${tails} of ${runResult.messages.length} emails lose a quoted tail, ${signatures} signature(s) left out\n${rows.join('\n')}`);
        expect(tails).toBeGreaterThanOrEqual(8);
        expect(runResult.plans.some((p) => p.keptAllBecauseEmpty)).toBe(false);
    });

    it('leaves out the quoted history of the known replies, keeps their new text', async () =>
    {
        const runResult = await run();
        // [file, new text that must be kept, quoted text that must be left out]
        const replies: [string, string, string][] = [
            ['eml/11-order-2-bob-outlook-en.eml', 'I can come by on Wednesday 5 March', 'We are furnishing a small office for four people'],
            ['eml/12-order-3-alice-gmail.eml', 'Wednesday at 10:00 works for me.', '> Thank you for your message.'],
            ['eml/13-order-4-bob-outlook-nl.eml', 'come to EUR 1,250, VAT included', 'Wednesday at 10:00 works for me.'],
            ['eml/22-delivery-3-carol-gmail-fr.eml', 'le chauffeur sonnera', 'Please ring at the side d'],
            ['eml/23-delivery-4-alice-outlook-fr.eml', 'The trial desks and chairs arrived this morning', 'le chauffeur sonnera'],
            ['msg-03-chain-2-alice-fr', 'the quote is accepted', 'Hierbij mijn offerte voor de vergadertafel'],
            ['msg-04-chain-3-bob-nl', 'ik noteer maandag 5 mei', 'the quote is accepted'],
        ];
        for (const [file, fresh, quoted] of replies)
        {
            const [message, messagePlan] = find(runResult, file);
            expect(state(message, messagePlan, fresh), `${file}: new text`).toBe('kept');
            expect(state(message, messagePlan, quoted), `${file}: quoted text`).toBe('left out');
            expect(keptText(message, messagePlan).trim().length, file).toBeGreaterThan(0);
        }
    });
});
