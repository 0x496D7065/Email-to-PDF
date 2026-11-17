// The PDF document model (src/pdf/model.ts) over every synthetic fixture
// (tests/fixtures), parsed, run through the engine and planned as the app
// does: the replies show their new text and not the quoted history, every
// file is a source, and with "include everything" every body is complete.

import { describe, expect, it } from 'vitest';
import { parseAllFixtures } from '../../tests/fixtures/parse-all';
import { runEngine, type EngineResult } from '../engine/engine';
import { DEFAULT_OUTPUT_POLICY, planOutput, type OutputPolicy } from '../engine/output-plan';
import { buildPdfDocument, type PdfDocument, type PdfEmail } from './model';
import { quotePrefixProblems, referenceDisplayLines, referenceDisplayText } from '../../tests/support/pdf-reference';
import { createPdfStrings } from './strings';
import { lineText } from './text';

const bodyOf = (e: PdfEmail): string => e.body.map(lineText).join('\n');
/** The real emails of a document with their list position (rebuilt emails have none: left out first). */
const realEmails = (d: PdfDocument): { e: PdfEmail; position: number }[] =>
    d.emails.flatMap((e) => (e.rebuilt === null && e.position !== null ? [{ e, position: e.position }] : []));

describe('PDF document model over the parsed fixtures', () =>
{
    let result: EngineResult | undefined;
    async function engine(): Promise<EngineResult>
    {
        result ??= runEngine((await parseAllFixtures()).map((message) => ({ ok: true as const, message })));
        return result;
    }
    async function doc(policy: OutputPolicy): Promise<{ doc: PdfDocument; result: EngineResult }>
    {
        const r = await engine();
        const positions = r.messages.map((_, k) => k);
        const plans = planOutput(r.messages, policy);
        return {
            result: r,
            doc: buildPdfDocument({ result: r, positions, plans, policy, timeZone: 'America/New_York', generatedAt: Date.UTC(2025, 5, 1, 12, 0, 0), strings: createPdfStrings('en') }),
        };
    }
    const emailOf = (d: PdfDocument, r: EngineResult, file: string): PdfEmail =>
    {
        const position = r.messages.findIndex((m) => m.message.source.fileName === file);
        const e = d.emails.find((x) => x.position === position);
        if (e === undefined)
        {
            throw new Error(`no email for ${file}`);
        }
        return e;
    };

    it('shows the new text of the known replies and leaves their quoted history out', async () =>
    {
        const { doc: d, result: r } = await doc(DEFAULT_OUTPUT_POLICY);
        // [file, new text that must be shown, quoted text that must not]
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
            const body = bodyOf(emailOf(d, r, file));
            expect(body, `${file}: new text`).toContain(fresh);
            expect(body, `${file}: quoted text`).not.toContain(quoted);
            // No blank line at either end, never more than 2 in a row.
            expect(body, file).toBe(body.trim() === '' ? '' : body.replace(/^\n+|\n+$/g, ''));
            expect(body, file).not.toMatch(/\n\n\n\n/);
        }
    });

    it('numbers every email, names every file in its email (merged copies too), no source list or hash on the cover', async () =>
    {
        const { doc: d, result: r } = await doc(DEFAULT_OUTPUT_POLICY);
        const s = createPdfStrings('en');
        expect(d.emails.map((e) => e.number)).toEqual(r.messages.map((_, k) => k + 1));
        // Collapse, never delete: every read file is still named, in the File row of the email it gave.
        const named = d.emails.flatMap((e) => e.fields.filter((f) => f.label === s.fileLabel).flatMap((f) => f.value.map(lineText)));
        expect(named).toHaveLength(r.counts.messagesFound);
        expect(r.counts.duplicatesMerged).toBeGreaterThan(0);
        // Task 8.12: the cover is the title, the summary and the people, nothing else.
        expect(d.cover.blocks.map((b) => b.kind)).toEqual(['heading', 'fields', 'heading', 'list']);
        expect(d.cover.blocks.flatMap((b) => (b.kind === 'list' ? b.items.flat().map(lineText) : [])).join('\n')).not.toMatch(/[0-9a-f]{64}/);
        expect(d.cover.participants.length).toBeGreaterThan(2);
        expect(d.cover.undated).toBe(r.counts.undated);
    });

    it('with "include everything", every body is the full text after the display transforms only', async () =>
    {
        const policy = { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true };
        const { doc: d, result: r } = await doc(policy);
        let quoted = 0;
        for (const { e, position } of realEmails(d))
        {
            const m = r.messages[position]!;
            expect(bodyOf(e), m.message.source.fileName).toBe(referenceDisplayText(m.message.bodyText));
            // Tasks 8.1 and 8.6: only the quote prefixes are missing; no line starts with a quote mark.
            expect(quotePrefixProblems(m.message.bodyText, e.body.map(lineText)), m.message.source.fileName).toEqual([]);
            expect(bodyOf(e), m.message.source.fileName).not.toMatch(/^\s*>/mu);
            quoted += referenceDisplayLines(m.message.bodyText, { quotes: false }).filter((l) => /^\s*>/u.test(l)).length;
            expect(e.flags.planFallback).toBe(false);
        }
        // The fixtures hold ">" quotes (Gmail, Thunderbird, HTML blockquotes).
        expect(quoted).toBeGreaterThan(10);
    });
});
