// Runs the whole engine over every synthetic fixture (Helper/Test/test-data), parsed
// by the real .eml and .msg adapters, as the app will do. It checks the
// collapse-never-delete invariants (README.md, rule R6), prints how much of
// each message is folded and why, and checks the key expectations of the
// detector fixture tests on the combined result (README.md, rule R7).

import { describe, expect, it } from 'vitest';
import { FIXTURES } from '../../Helper/Test/test-data/manifest';
import { parseAllFixtures } from '../../Helper/Test/test-data/parse-all';
import { normalizeBody } from './dedupe';
import { primaryReason, runEngine } from './analyze-thread';
import { checkSegments, FOLD_REASONS, joinSegments, visibleView } from './fold-segments';
import type { NormalizedMessage, ParseResult } from '../../Header/parsed-email';
import type { EngineMessage, EngineResult, FoldReason } from '../../Header/thread-analysis-result';

/** Whether every character of `snippet` (first occurrence) is folded, none is, or some are. */
function state(message: EngineMessage, snippet: string): 'folded' | 'shown' | 'mixed'
{
    const body = message.message.bodyText;
    const offset = body.indexOf(snippet);
    if (offset < 0)
    {
        throw new Error(`${message.message.source.fileName}: snippet not found: ${snippet}`);
    }
    let folded = 0;
    for (const segment of message.segments)
    {
        if (segment.folded)
        {
            folded += Math.max(0, Math.min(segment.end, offset + snippet.length) - Math.max(segment.start, offset));
        }
    }
    if (folded === 0)
    {
        return 'shown';
    }
    return folded === snippet.length ? 'folded' : 'mixed';
}

/** The display labels (primary reasons) of the folded segments overlapping `snippet`. */
function labels(message: EngineMessage, snippet: string): FoldReason[]
{
    const offset = message.message.bodyText.indexOf(snippet);
    if (offset < 0)
    {
        throw new Error(`${message.message.source.fileName}: snippet not found: ${snippet}`);
    }
    const found = new Set<FoldReason>();
    for (const segment of message.segments)
    {
        const label = primaryReason(segment.reasons);
        if (label !== null && segment.start < offset + snippet.length && segment.end > offset)
        {
            found.add(label);
        }
    }
    return [...found];
}

describe('engine over the parsed fixtures', () =>
{
    let cached: { messages: NormalizedMessage[]; results: ParseResult[]; out: EngineResult } | undefined;
    async function run(): Promise<NonNullable<typeof cached>>
    {
        if (cached === undefined)
        {
            const messages = await parseAllFixtures();
            const results: ParseResult[] = messages.map((message) => ({ ok: true, message }));
            cached = { messages, results, out: runEngine(results) };
        }
        return cached;
    }
    const get = (out: EngineResult, file: string): EngineMessage =>
    {
        const message = out.messages.find((x) => x.message.source.fileName === file);
        if (message === undefined)
        {
            throw new Error(`no kept message for ${file}`);
        }
        return message;
    };

    it('keeps every message fully recoverable (collapse, never delete)', async () =>
    {
        const { messages, out } = await run();
        for (const message of out.messages)
        {
            const body = message.message.bodyText;
            const file = message.message.source.fileName;
            expect(checkSegments(body, message.segments), file).toEqual([]);
            expect(joinSegments(body, message.segments), file).toBe(body);
            const unfolded = visibleView(body, message.segments, { unfoldAll: true });
            expect(unfolded.map((b) => b.text).join(''), file).toBe(body);
            expect(unfolded.some((b) => b.collapsed), file).toBe(false);
            expect(message.engineWarnings, file).toEqual([]);
            for (const duplicate of message.duplicates)
            {
                expect(normalizeBody(messages[duplicate.index]!.bodyText), duplicate.source.fileName).toBe(normalizeBody(body));
            }
        }
        // Every fixture is kept or merged into a kept message.
        expect(out.positionByIndex.every((p) => p !== null)).toBe(true);

        const groups = new Set(FIXTURES.map((f) => f.duplicateGroup ?? f.id));
        expect(out.counts).toEqual({
            filesGiven: FIXTURES.length,
            messagesFound: FIXTURES.length,
            duplicatesMerged: FIXTURES.length - groups.size,
            filesFailed: 0,
            undated: out.messages.filter((m) => m.message.date.utcMs === null).length,
            withFolds: out.messages.filter((m) => m.segments.some((s) => s.folded)).length,
        });
        expect(out.counts.undated).toBeGreaterThanOrEqual(2); // 70-no-date, 71-bad-date, msg-07
        expect(out.counts.withFolds).toBeGreaterThan(10);
    });

    it('merges the duplicate groups', async () =>
    {
        const { out } = await run();
        const merged = (file: string): string[] => get(out, file).duplicates.map((d) => d.source.fileName).sort();
        expect(merged('eml/11-order-2-bob-outlook-en.eml')).toEqual(['eml/30-dup-order-2-copy.eml', 'msg-09-dup-of-eml-order-2']);
        expect(merged('eml/31-dup-confirm-a.eml')).toEqual(['eml/32-dup-confirm-b-other-id.eml', 'eml/33-dup-confirm-c-no-id.eml']);
    });

    it('folds quoted history, reply headers and signatures with the right labels', async () =>
    {
        const { out } = await run();

        // Measurement: folded characters per message, by display label.
        const rows = out.messages.map((message) =>
        {
            const chars = new Map<FoldReason, number>();
            for (const segment of message.segments)
            {
                const label = primaryReason(segment.reasons);
                if (label !== null)
                {
                    chars.set(label, (chars.get(label) ?? 0) + segment.end - segment.start);
                }
            }
            const parts = FOLD_REASONS.filter((r) => chars.has(r)).map((r) => `${r} ${chars.get(r)}`);
            return `${message.message.source.fileName} [${message.order}]: ${message.message.bodyText.length} chars${parts.length > 0 ? `, folded: ${parts.join(', ')}` : ''}`;
        });
        console.log(`engine on fixtures (chronological):\n${rows.join('\n')}`);

        // Replies: [file, new text that must stay shown, quoted text that must be folded]
        const replies: [string, string, string][] = [
            ['eml/11-order-2-bob-outlook-en.eml', 'I can come by on Wednesday 5 March', 'We are furnishing a small office for four people'],
            ['eml/12-order-3-alice-gmail.eml', 'Wednesday at 10:00 works for me.', '> Thank you for your message.'],
            ['eml/13-order-4-bob-outlook-nl.eml', 'come to EUR 1,250, VAT included', 'Wednesday at 10:00 works for me.'],
            ['eml/21-delivery-2-alice-apple.eml', 'Please ring at the side d', "> Les bureaux et chaises d'essai"],
            ['eml/22-delivery-3-carol-gmail-fr.eml', 'le chauffeur sonnera', 'Please ring at the side d'],
            ['eml/23-delivery-4-alice-outlook-fr.eml', 'The trial desks and chairs arrived this morning', 'le chauffeur sonnera'],
            ['eml/83-setup-d-alice.eml', 'Thursday 9:00 is fine', 'Can we meet at the office on Thursday 12 June at 9:00'],
            ['eml/80-setup-a-carol.eml', 'avec les \u00E9chantillons de tissu', 'Thursday 9:00 is fine'],
            ['eml/82-setup-c-bob.eml', 'Perfect, see you Thursday.', 'avec les \u00E9chantillons de tissu'],
            ['msg-03-chain-2-alice-fr', 'the quote is accepted', 'Hierbij mijn offerte voor de vergadertafel'],
            ['msg-04-chain-3-bob-nl', 'ik noteer maandag 5 mei', 'the quote is accepted'],
        ];
        for (const [file, fresh, quoted] of replies)
        {
            const message = get(out, file);
            expect(state(message, fresh), `${file}: new text`).toBe('shown');
            expect(state(message, quoted), `${file}: quoted text`).toBe('folded');
        }

        // Outlook replies: from the row of underscores above the header block to the end.
        const outlook: [string, string][] = [
            ['eml/11-order-2-bob-outlook-en.eml', 'From: Alice Example'],
            ['eml/13-order-4-bob-outlook-nl.eml', 'Van: Alice Example'],
            ['eml/23-delivery-4-alice-outlook-fr.eml', 'De : Carol Test'],
            ['msg-03-chain-2-alice-fr', 'De : Bob Sample'],
            ['msg-04-chain-3-bob-nl', 'Van: Alice Example'],
        ];
        for (const [file, firstLabel] of outlook)
        {
            const message = get(out, file);
            const body = message.message.bodyText;
            const rule = body.lastIndexOf('____', body.indexOf(firstLabel));
            expect(state(message, body.slice(rule)), `${file}: header block to the end`).toBe('folded');
            expect(labels(message, firstLabel), `${file}: header label`).toEqual(['reply-header']);
        }

        // Bob's signature: labelled 'signature' wherever it is in his own text,
        // also in 81 where the overlap detector folds it too (it repeats his message 11).
        const bob = out.messages.filter((m) => m.message.from[0]?.address === 'bob@furniture.example.test');
        let bobChecked = 0;
        for (const message of bob)
        {
            const body = message.message.bodyText;
            const offset = body.indexOf('Met vriendelijke groeten,');
            const quoteAt = message.segments.find((s) => s.reasons.some((r) => r === 'quote-marker' || r === 'reply-header'))?.start ?? body.length;
            if (offset < 0 || offset > quoteAt)
            {
                continue;
            }
            const file = message.message.source.fileName;
            expect(state(message, 'Met vriendelijke groeten,\nBob Sample'), file).toBe('folded');
            expect(labels(message, 'Met vriendelijke groeten,\nBob Sample'), file).toEqual(['signature']);
            bobChecked++;
        }
        expect(bobChecked).toBeGreaterThanOrEqual(3);
        const setup = get(out, 'eml/81-setup-b-bob.eml');
        expect(labels(setup, 'DISCLAIMER: This e-mail and any attachments are confidential')).toEqual(['signature']);
        expect(state(setup, 'Can we meet at the office on Thursday 12 June at 9:00')).toBe('shown');

        // Gmail / Apple attributions: labelled as reply headers.
        expect(labels(get(out, 'eml/12-order-3-alice-gmail.eml'), 'On Mon, 3 Mar 2025 at 14:02, Bob Sample')).toEqual(['reply-header']);

        // Every message: its first non-empty line stays shown.
        for (const message of out.messages)
        {
            const firstLine = message.message.bodyText.split(/\r\n|\n|\r/).find((line) => line.trim() !== '');
            if (firstLine === undefined)
            {
                continue;
            }
            expect(state(message, firstLine), `${message.message.source.fileName}: first line`).toBe('shown');
        }
    });

    it('lists failed files next to the fixtures without changing the rest', async () =>
    {
        const { results, out } = await run();
        const broken: ParseResult = { ok: false, fileName: 'broken.eml', sha256: null, error: 'too-large', detail: 'over the size limit' };
        const withFailure = runEngine([broken, ...results]);
        expect(withFailure.failed).toEqual([{ index: 0, fileName: 'broken.eml', sha256: null, error: 'too-large', detail: 'over the size limit' }]);
        expect(withFailure.counts).toEqual({ ...out.counts, filesGiven: out.counts.filesGiven + 1, filesFailed: 1 });
        // Same messages, same segments; only the input positions moved by one.
        expect(withFailure.messages.map((m) => [m.message, m.segments.map((s) => ({ ...s, related: s.related.map((r) => r - 1) }))])).toEqual(
            out.messages.map((m) => [m.message, m.segments]),
        );
    });
});
