// Runs overlap-based quote detection over every synthetic fixture
// (tests/fixtures), parsed by the real .eml and .msg adapters, de-duplicated
// and put in chronological order as the app will do. It measures how much of
// each message is folded and checks the key expectations (README.md, rule R7).

import { describe, expect, it } from 'vitest';
import { parseAllFixtures } from '../../tests/fixtures/parse-all';
import { dedupe } from './dedupe';
import { orderMessages } from './order';
import { detectQuotedOverlap } from './overlap';
import { buildSegments, checkSegments, reconstruct, type FoldRange } from './segments';

interface Measured {
    readonly file: string;
    readonly body: string;
    readonly folds: readonly FoldRange[];
    readonly foldedChars: number;
    /** File names of the related messages, sorted. */
    readonly related: readonly string[];
}

/** Parse, de-duplicate, order, detect: the same steps as the app's pipeline. */
async function measure(): Promise<Map<string, Measured>>
{
    const messages = await parseAllFixtures();
    const ordered = orderMessages(dedupe(messages).kept);
    const results = detectQuotedOverlap(
        ordered.map(({ item }) => ({
            bodyText: item.message.bodyText,
            messageId: item.message.messageId,
            inReplyTo: item.message.inReplyTo,
            references: item.message.references,
            index: item.index,
        })),
    );
    const byFile = new Map<string, Measured>();
    ordered.forEach(({ item }, k) =>
    {
        const body = item.message.bodyText;
        const folds = results[k] ?? [];
        const segments = buildSegments(body, folds);
        expect(checkSegments(body, segments)).toEqual([]);
        expect(reconstruct(body, segments)).toBe(body);
        const foldedChars = segments.filter((s) => s.folded).reduce((n, s) => n + s.end - s.start, 0);
        const related = [...new Set(folds.map((f) => messages[f.related ?? -1]?.source.fileName ?? '?'))].sort();
        byFile.set(item.message.source.fileName, { file: item.message.source.fileName, body, folds, foldedChars, related });
    });
    return byFile;
}

/** True when every character of `snippet` (first occurrence) is folded / shown. */
function state(m: Measured, snippet: string): 'folded' | 'shown' | 'mixed'
{
    const at = m.body.indexOf(snippet);
    if (at < 0) throw new Error(`${m.file}: snippet not found: ${snippet}`);
    const covered = (i: number): boolean => m.folds.some((f) => f.start <= i && i < f.end);
    let foldedCount = 0;
    for (let i = at; i < at + snippet.length; i++) if (covered(i)) foldedCount++;
    if (foldedCount === 0) return 'shown';
    return foldedCount === snippet.length ? 'folded' : 'mixed';
}

describe('overlap detection over the parsed fixtures', () =>
{
    it('folds quoted history in every reply and keeps the new text shown', async () =>
    {
        const all = await measure();
        const get = (file: string): Measured =>
        {
            const m = all.get(file);
            if (m === undefined) throw new Error(`no result for ${file}`);
            return m;
        };

        // Measurement (the README asks to measure detection, not assume it).
        const rows = [...all.values()]
            .filter((m) => m.foldedChars > 0)
            .map((m) => `${m.file}: ${m.foldedChars}/${m.body.length} chars folded, related: ${m.related.join(', ')}`);
        console.log(`overlap on fixtures (messages with folds):\n${rows.join('\n')}`);

        // Listed threads: [file, new text that must stay shown, quoted text that must be folded, related file]
        const replies: [string, string, string, string][] = [
            ['eml/11-order-2-bob-outlook-en.eml', 'I can come by on Wednesday 5 March', 'We are furnishing a small office for four people', 'eml/10-order-1-alice.eml'],
            ['eml/12-order-3-alice-gmail.eml', 'Wednesday at 10:00 works for me.', '> Thank you for your message.', 'eml/11-order-2-bob-outlook-en.eml'],
            ['eml/13-order-4-bob-outlook-nl.eml', 'come to EUR 1,250, VAT included', 'Wednesday at 10:00 works for me.', 'eml/12-order-3-alice-gmail.eml'],
            ['eml/21-delivery-2-alice-apple.eml', 'Please ring at the side d', "> Les bureaux et chaises d'essai", 'eml/20-delivery-1-carol.eml'],
            ['eml/22-delivery-3-carol-gmail-fr.eml', 'le chauffeur sonnera', 'Please ring at the side d', 'eml/21-delivery-2-alice-apple.eml'],
            ['eml/23-delivery-4-alice-outlook-fr.eml', 'The trial desks and chairs arrived this morning', 'le chauffeur sonnera', 'eml/22-delivery-3-carol-gmail-fr.eml'],
            ['eml/83-setup-d-alice.eml', 'Thursday 9:00 is fine', 'Can we meet at the office on Thursday 12 June at 9:00', 'eml/81-setup-b-bob.eml'],
            ['eml/80-setup-a-carol.eml', 'avec les \u00E9chantillons de tissu', 'Thursday 9:00 is fine', 'eml/83-setup-d-alice.eml'],
            ['eml/82-setup-c-bob.eml', 'Perfect, see you Thursday.', 'avec les \u00E9chantillons de tissu', 'eml/80-setup-a-carol.eml'],
            ['msg-03-chain-2-alice-fr', 'the quote is accepted', 'Hierbij mijn offerte voor de vergadertafel', 'msg-02-chain-1-bob'],
            ['msg-04-chain-3-bob-nl', 'ik noteer maandag 5 mei', 'the quote is accepted', 'msg-03-chain-2-alice-fr'],
        ];
        for (const [file, fresh, quoted, related] of replies)
        {
            const m = get(file);
            expect(state(m, fresh), `${file}: new text`).toBe('shown');
            expect(state(m, quoted), `${file}: quoted text`).toBe('folded');
            expect(m.related, file).toContain(related);
        }

        // Every message: its first non-empty line (the start of its own new text
        // in every fixture) stays shown. Manifest `bodyContains` snippets are not
        // used here because some of them are quoted history.
        expect(all.size).toBeGreaterThan(0);
        for (const m of all.values())
        {
            const firstLine = m.body.split(/\r\n|\n|\r/).find((line) => line.trim() !== '');
            if (firstLine === undefined) continue; // no text at all: nothing to fold
            expect(state(m, firstLine), `${m.file}: first line`).toBe('shown');
        }

        // First messages of each thread: their own text stays shown.
        const firsts: [string, string][] = [
            ['eml/10-order-1-alice.eml', 'We are furnishing a small office for four people'],
            ['eml/20-delivery-1-carol.eml', "Les bureaux et chaises d'essai"],
            ['eml/81-setup-b-bob.eml', 'Can we meet at the office on Thursday 12 June at 9:00'],
            ['msg-02-chain-1-bob', 'Hierbij mijn offerte voor de vergadertafel'],
        ];
        for (const [file, text] of firsts) expect(state(get(file), text), file).toBe('shown');
        expect(get('eml/10-order-1-alice.eml').folds).toEqual([]);
        expect(get('eml/20-delivery-1-carol.eml').folds).toEqual([]);

        // Known limitation (see overlap.ts): Bob repeats his signature and
        // disclaimer, so in his first setup message they match his earlier
        // message 11 and are folded as quoted-overlap. The signature detector
        // and the pipeline will relabel this; the rest of the message stays shown.
        const setup1 = get('eml/81-setup-b-bob.eml');
        expect(setup1.related).toEqual(['eml/11-order-2-bob-outlook-en.eml']);
        expect(state(setup1, 'DISCLAIMER: This e-mail and any attachments are confidential')).toBe('folded');
    });
});
