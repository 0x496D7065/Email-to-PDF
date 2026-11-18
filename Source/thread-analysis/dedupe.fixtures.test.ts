// Runs de-duplication over every synthetic fixture (Helper/Test/test-data), parsed
// by the real .eml and .msg adapters, and checks the groups against the
// manifest's `duplicateGroup` marks (README.md, rule R7).

import { describe, expect, it } from 'vitest';
import { FIXTURES } from '../../Helper/Test/test-data/manifest';
import { parseAllFixtures } from '../../Helper/Test/test-data/parse-all-fixtures';
import { dedupe, normalizeBody } from './dedupe';

describe('dedupe over the parsed fixtures', () =>
{
    it('merges exactly the manifest duplicate groups', async () =>
    {
        const messages = await parseAllFixtures();
        const result = dedupe(messages);

        // Expected: one group per `duplicateGroup` value, every other fixture alone.
        const expected = new Map<string, string[]>();
        for (const fixture of FIXTURES)
        {
            const key = fixture.duplicateGroup ?? `single:${fixture.id}`;
            expected.set(key, [...(expected.get(key) ?? []), fixture.id]);
        }
        const actual = result.kept.map((k) => [k.message.source.fileName, ...k.duplicates.map((d) => d.source.fileName)].sort());
        expect(actual.sort()).toEqual([...expected.values()].map((ids) => ids.sort()).sort());
        expect(result.mergedCount).toBe(FIXTURES.length - expected.size);

        // No fixture triggers a thread analysis warning.
        for (const keptEntry of result.kept)
        {
            expect(keptEntry.warnings).toEqual([]);
        }

        // Every merged copy has the representative's normalized body.
        for (const keptEntry of result.kept)
        {
            for (const duplicate of keptEntry.duplicates)
            {
                expect(normalizeBody(messages[duplicate.index]!.bodyText)).toBe(normalizeBody(keptEntry.message.bodyText));
            }
        }
    });

    it('records which rule merged each copy', async () =>
    {
        const result = dedupe(await parseAllFixtures());
        const rules = new Map(result.kept.flatMap((k) => k.duplicates.map((d) => [d.source.fileName, d.rule] as const)));
        expect(Object.fromEntries(rules)).toEqual({
            // order-2: .eml 11 is kept; the received copy 30 and the .msg export share its Message-ID.
            'eml/30-dup-order-2-copy.eml': 'message-id',
            'msg-09-dup-of-eml-order-2': 'message-id',
            // confirm-0305: 31 is kept; 32 (other id) and 33 (no id) match by author + date + body.
            'eml/32-dup-confirm-b-other-id.eml': 'author-date-body',
            'eml/33-dup-confirm-c-no-id.eml': 'author-date-body',
        });
        const keptNames = result.kept.map((k) => k.message.source.fileName);
        expect(keptNames).toContain('eml/11-order-2-bob-outlook-en.eml');
        expect(keptNames).toContain('eml/31-dup-confirm-a.eml');
    });
});
