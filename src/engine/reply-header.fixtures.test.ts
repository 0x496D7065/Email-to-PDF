// Runs reply-header detection over every synthetic fixture (tests/fixtures),
// parsed by the real .eml and .msg adapters. It measures how much of each
// message is folded and checks the key expectations (README.md, rule R7).

import { describe, expect, it } from 'vitest';
import { parseAllFixtures } from '../../tests/fixtures/parse-all';
import { detectReplyHeaders } from './reply-header';
import { buildSegments, checkSegments, reconstruct, type FoldRange } from './segments';

interface Measured
{
    readonly file: string;
    readonly body: string;
    readonly folds: readonly FoldRange[];
    readonly foldedChars: number;
}

/** Whether every character of `snippet` (first occurrence) is folded, none is, or some are. */
function state(m: Measured, snippet: string): 'folded' | 'shown' | 'mixed'
{
    const at = m.body.indexOf(snippet);
    if (at < 0)
    {
        throw new Error(`${m.file}: snippet not found: ${snippet}`);
    }
    const covered = (i: number): boolean => m.folds.some((f) => f.start <= i && i < f.end);
    let foldedCount = 0;
    for (let i = at; i < at + snippet.length; i++)
    {
        if (covered(i))
        {
            foldedCount++;
        }
    }
    if (foldedCount === 0)
    {
        return 'shown';
    }
    return foldedCount === snippet.length ? 'folded' : 'mixed';
}

describe('reply-header detection over the parsed fixtures', () =>
{
    it('folds the reply headers and keeps each message\'s own first line shown', async () =>
    {
        const messages = await parseAllFixtures();
        const all = new Map<string, Measured>();
        for (const message of messages)
        {
            const body = message.bodyText;
            const folds = detectReplyHeaders(body, message.subject ?? undefined);
            const segments = buildSegments(body, folds);
            expect(checkSegments(body, segments)).toEqual([]);
            expect(reconstruct(body, segments)).toBe(body);
            const foldedChars = segments.filter((s) => s.folded).reduce((n, s) => n + s.end - s.start, 0);
            const file = message.source.fileName;
            all.set(file, { file, body, folds, foldedChars });
        }
        const get = (file: string): Measured =>
        {
            const m = all.get(file);
            if (m === undefined)
            {
                throw new Error(`no result for ${file}`);
            }
            return m;
        };

        // Measurement (the README asks to measure detection, not assume it).
        const rows = [...all.values()]
            .filter((m) => m.foldedChars > 0)
            .map((m) => `${m.file}: ${m.foldedChars}/${m.body.length} chars folded in ${m.folds.length} fold(s)`);
        console.log(`reply headers on fixtures (messages with folds):\n${rows.join('\n')}`);

        // Every message: its first non-empty line (the start of its own new
        // text in every fixture) stays shown.
        expect(all.size).toBe(messages.length);
        for (const m of all.values())
        {
            const firstLine = m.body.split(/\r\n|\n|\r/).find((line) => line.trim() !== '');
            if (firstLine === undefined)
            {
                continue; // no text at all: nothing to fold
            }
            expect(state(m, firstLine), `${m.file}: first line`).toBe('shown');
        }

        // Outlook replies: the whole header block and everything after it folded.
        const outlook: [string, string, string][] = [
            ['eml/11-order-2-bob-outlook-en.eml', 'Sample Furniture accepts no liability', 'From: Alice Example'],
            ['eml/13-order-4-bob-outlook-nl.eml', 'Sample Furniture accepts no liability', 'Van: Alice Example'],
            ['eml/23-delivery-4-alice-outlook-fr.eml', 'Thank you!', 'De : Carol Test'],
            ['msg-03-chain-2-alice-fr', 'Could you deliver in May?', 'De : Bob Sample'],
            ['msg-04-chain-3-bob-nl', 'ik noteer maandag 5 mei', 'Van: Alice Example'],
        ];
        for (const [file, fresh, firstLabel] of outlook)
        {
            const m = get(file);
            expect(state(m, fresh), `${file}: new text`).toBe('shown');
            const rule = m.body.lastIndexOf('____', m.body.indexOf(firstLabel));
            expect(state(m, m.body.slice(rule)), `${file}: header block to the end`).toBe('folded');
        }

        // msg-04: the whole Dutch block, line by line.
        const msg04 = get('msg-04-chain-3-bob-nl');
        for (const label of ['Van: Alice Example', 'Verzonden: woensdag', 'Aan: Bob Sample', 'Onderwerp: RE: Offerte'])
        {
            expect(state(msg04, label), `msg-04: ${label}`).toBe('folded');
        }

        // Gmail and Apple attributions fold with their ">" quote.
        const attributions: [string, string, string][] = [
            ['eml/12-order-3-alice-gmail.eml', 'Wednesday at 10:00 works for me.', 'On Mon, 3 Mar 2025 at 14:02, Bob Sample'],
            ['eml/21-delivery-2-alice-apple.eml', 'Please ring at the side d', '> On 4 Mar 2025, at 11:20, Carol Test'],
            ['eml/22-delivery-3-carol-gmail-fr.eml', 'le chauffeur sonnera', 'Le mar. 4 mars 2025'],
        ];
        for (const [file, fresh, attribution] of attributions)
        {
            const m = get(file);
            expect(state(m, fresh), `${file}: new text`).toBe('shown');
            expect(state(m, attribution), `${file}: attribution`).toBe('folded');
        }
    });
});
