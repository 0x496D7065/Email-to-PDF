// Runs quote-marker detection over every synthetic fixture (Helper/Test/test-data),
// parsed by the real .eml and .msg adapters. It measures how much of each
// message is folded and checks the key expectations (README.md, rule R7).

import { describe, expect, it } from 'vitest';
import { parseAllFixtures } from '../../Helper/Test/test-data/parse-all-fixtures';
import { detectQuoteMarkers } from './quote-markers';
import { buildSegments, checkSegments, joinSegments, type FoldRange } from './fold-segments';

interface Measured
{
    readonly file: string;
    readonly body: string;
    readonly folds: readonly FoldRange[];
    readonly foldedChars: number;
}

/** True when every character of `snippet` (first occurrence) is folded / shown. */
function state(measured: Measured, snippet: string): 'folded' | 'shown' | 'mixed'
{
    const offset = measured.body.indexOf(snippet);
    if (offset < 0)
    {
        throw new Error(`${measured.file}: snippet not found: ${snippet}`);
    }
    const covered = (i: number): boolean => measured.folds.some((f) => f.start <= i && i < f.end);
    let foldedCount = 0;
    for (let i = offset; i < offset + snippet.length; i++)
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

describe('quote-marker detection over the parsed fixtures', () =>
{
    it('folds the ">" quotes and keeps each message\'s own first line shown', async () =>
    {
        const messages = await parseAllFixtures();
        const all = new Map<string, Measured>();
        for (const message of messages)
        {
            const body = message.bodyText;
            const folds = detectQuoteMarkers(body);
            const segments = buildSegments(body, folds);
            expect(checkSegments(body, segments)).toEqual([]);
            expect(joinSegments(body, segments)).toBe(body);
            const foldedChars = segments.filter((s) => s.folded).reduce((n, s) => n + s.end - s.start, 0);
            const file = message.source.fileName;
            all.set(file, { file, body, folds, foldedChars });
        }
        const get = (file: string): Measured =>
        {
            const measured = all.get(file);
            if (measured === undefined)
            {
                throw new Error(`no result for ${file}`);
            }
            return measured;
        };

        // Measurement (the README asks to measure detection, not assume it).
        const rows = [...all.values()]
            .filter((m) => m.foldedChars > 0)
            .map((m) => `${m.file}: ${m.foldedChars}/${m.body.length} chars folded in ${m.folds.length} block(s)`);
        console.log(`quote markers on fixtures (messages with folds):\n${rows.join('\n')}`);

        // [file, new text that must stay shown, ">"-quoted text that must be folded]
        const replies: [string, string, string][] = [
            ['eml/12-order-3-alice-gmail.eml', 'Wednesday at 10:00 works for me.', '> Thank you for your message.'],
            ['eml/21-delivery-2-alice-apple.eml', 'Please ring at the side d', "> Les bureaux et chaises d'essai"],
        ];
        for (const [file, fresh, quoted] of replies)
        {
            const measured = get(file);
            expect(state(measured, fresh), `${file}: new text`).toBe('shown');
            expect(state(measured, quoted), `${file}: quoted text`).toBe('folded');
        }

        // Every message: its first non-empty line (the start of its own new
        // text in every fixture) stays shown.
        expect(all.size).toBe(messages.length);
        for (const measured of all.values())
        {
            const firstLine = measured.body.split(/\r\n|\n|\r/).find((line) => line.trim() !== '');
            if (firstLine === undefined)
            {
                continue; // no text at all: nothing to fold
            }
            expect(state(measured, firstLine), `${measured.file}: first line`).toBe('shown');
        }

        // Messages without any ">" line get no fold.
        for (const measured of all.values())
        {
            if (!/^\s*>/m.test(measured.body))
            {
                expect(measured.folds, measured.file).toEqual([]);
            }
        }
    });
});
