// Runs signature detection over every synthetic fixture (Helper/Test/test-data),
// parsed by the real .eml and .msg adapters and de-duplicated as the app will
// do. It measures how much of each message is folded and checks the key
// expectations (README.md, rule R7).
//
// ownTextEnd: the start of the first quote-marker or reply-header fold. The
// overlap folds are left out on purpose: overlap-quote-detection.ts also folds the sender's
// own repeated signature (as 'quoted-overlap'), so its first fold may start
// AT the signature, which would hide the signature from this detector. The
// pipeline will make that choice properly; this test uses the simple rule.

import { describe, expect, it } from 'vitest';
import { parseAllFixtures } from '../../Helper/Test/test-data/parse-all';
import { dedupe } from './dedupe';
import { detectQuoteMarkers } from './quote-markers';
import { detectReplyHeaders } from './reply-header';
import { buildSegments, checkSegments, joinSegments, type FoldRange } from './fold-segments';
import { detectSignatures, senderKeyOf } from './signature-detection';

interface Measured
{
    readonly file: string;
    readonly sender: string;
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

describe('signature detection over the parsed fixtures', () =>
{
    it("folds Bob's signature and disclaimer and keeps each message's first line shown", async () =>
    {
        const messages = dedupe(await parseAllFixtures()).kept.map((k) => k.message);
        const inputs = messages.map((message) =>
        {
            const body = message.bodyText;
            const quoteStarts = [...detectQuoteMarkers(body), ...detectReplyHeaders(body, message.subject)].map((f) => f.start);
            return { bodyText: body, senderKey: senderKeyOf(message), ownTextEnd: Math.min(body.length, ...quoteStarts) };
        });
        const results = detectSignatures(inputs);
        const all = new Map<string, Measured>();
        messages.forEach((message, i) =>
        {
            const body = message.bodyText;
            const folds = results[i] ?? [];
            const segments = buildSegments(body, folds);
            expect(checkSegments(body, segments)).toEqual([]);
            expect(joinSegments(body, segments)).toBe(body);
            for (const fold of folds)
            {
                expect(fold.reason).toBe('signature');
            }
            const foldedChars = segments.filter((s) => s.folded).reduce((n, s) => n + s.end - s.start, 0);
            const file = message.source.fileName;
            all.set(file, { file, sender: inputs[i]?.senderKey ?? '', body, folds, foldedChars });
        });
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
            .map((m) => `${m.file} (${m.sender}): ${m.foldedChars}/${m.body.length} chars folded in ${m.folds.length} fold(s)`);
        console.log(`signatures on fixtures (messages with folds):\n${rows.join('\n')}`);

        // Bob's signature + disclaimer: folded in every message of his where it
        // is in his own text (above any quote).
        const bob = [...all.values()].filter((m) => m.sender === 'bob@furniture.example.test');
        expect(bob.length).toBeGreaterThanOrEqual(3);
        let bobFolded = 0;
        for (const measured of bob)
        {
            const offset = measured.body.indexOf('Met vriendelijke groeten,');
            const ownEnd = inputs[messages.findIndex((x) => x.source.fileName === measured.file)]?.ownTextEnd ?? 0;
            if (offset < 0 || offset > ownEnd)
            {
                continue;
            }
            expect(state(measured, 'Met vriendelijke groeten,\nBob Sample'), measured.file).toBe('folded');
            const disclaimer = 'DISCLAIMER: This e-mail and any attachments are confidential';
            if (measured.body.includes(disclaimer))
            {
                expect(state(measured, disclaimer), measured.file).toBe('folded');
            }
            bobFolded++;
        }
        expect(bobFolded).toBeGreaterThanOrEqual(3);
        expect(state(get('eml/81-setup-b-bob.eml'), 'Can we meet at the office on Thursday 12 June at 9:00')).toBe('shown');

        // Carol's repeated two-line signature (frequency rule, no delimiter).
        expect(state(get('eml/20-delivery-1-carol.eml'), 'Cordialement,\nCarol Test')).toBe('folded');

        // Alice's "-- " signature (delimiter rule).
        expect(state(get('eml/10-order-1-alice.eml'), 'Alice Example\nSent from my laptop')).toBe('folded');

        // Every message: its first non-empty line stays shown.
        for (const measured of all.values())
        {
            const firstLine = measured.body.split(/\r\n|\n|\r/).find((line) => line.trim() !== '');
            if (firstLine === undefined)
            {
                continue;
            }
            expect(state(measured, firstLine), `${measured.file}: first line`).toBe('shown');
        }
    });
});
