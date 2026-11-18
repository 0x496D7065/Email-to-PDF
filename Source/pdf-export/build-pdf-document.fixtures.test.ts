// The PDF document model (Source/pdf-export/build-pdf-document.ts) over every synthetic fixture
// (Helper/Test/test-data), parsed, run through the thread analysis and planned as the app
// does: the replies show their new text and not the quoted history, every
// file is a source, and with "include everything" every body is complete.

import { describe, expect, it } from 'vitest';
import { parseAllFixtures } from '../../Helper/Test/test-data/parse-all';
import { analyzeThread } from '../thread-analysis/analyze-thread';
import { DEFAULT_OUTPUT_POLICY, planOutput } from '../thread-analysis/output-plan';
import { buildPdfDocument } from './build-pdf-document';
import { quotePrefixProblems, referenceDisplayLines, referenceDisplayText } from '../../Helper/Test/test-support/pdf-reference';
import { createPdfStrings } from './pdf-strings';
import { lineText } from './pdf-text-transforms';
import type { OutputPolicy } from '../../Header/output-plan';
import type { PdfDocument, PdfEmail } from '../../Header/pdf-document-model';
import type { ThreadAnalysisResult } from '../../Header/thread-analysis-result';

const bodyOf = (e: PdfEmail): string => e.body.map(lineText).join('\n');
/** The real emails of a document with their list position (rebuilt emails have none: left out first). */
const realEmails = (pdfDocument: PdfDocument): { email: PdfEmail; position: number }[] =>
    pdfDocument.emails.flatMap((e) => (e.rebuilt === null && e.position !== null ? [{ email: e, position: e.position }] : []));

describe('PDF document model over the parsed fixtures', () =>
{
    let result: ThreadAnalysisResult | undefined;
    async function analyzeFixtures(): Promise<ThreadAnalysisResult>
    {
        result ??= analyzeThread((await parseAllFixtures()).map((message) => ({ ok: true as const, message })));
        return result;
    }
    async function buildFixtureDocument(policy: OutputPolicy): Promise<{ pdfDocument: PdfDocument; result: ThreadAnalysisResult }>
    {
        const threadAnalysis = await analyzeFixtures();
        const positions = threadAnalysis.messages.map((_, k) => k);
        const plans = planOutput(threadAnalysis.messages, policy);
        return {
            result: threadAnalysis,
            pdfDocument: buildPdfDocument({ result: threadAnalysis, positions, plans, policy, timeZone: 'America/New_York',
                generatedAt: Date.UTC(2025, 5, 1, 12, 0, 0), strings: createPdfStrings('en') }),
        };
    }
    const emailOf = (pdfDocument: PdfDocument, threadAnalysis: ThreadAnalysisResult, file: string): PdfEmail =>
    {
        const position = threadAnalysis.messages.findIndex((m) => m.message.source.fileName === file);
        const email = pdfDocument.emails.find((x) => x.position === position);
        if (email === undefined)
        {
            throw new Error(`no email for ${file}`);
        }
        return email;
    };

    it('shows the new text of the known replies and leaves their quoted history out', async () =>
    {
        const { pdfDocument, result: threadAnalysis } = await buildFixtureDocument(DEFAULT_OUTPUT_POLICY);
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
            const body = bodyOf(emailOf(pdfDocument, threadAnalysis, file));
            expect(body, `${file}: new text`).toContain(fresh);
            expect(body, `${file}: quoted text`).not.toContain(quoted);
            // No blank line at either end, never more than 2 in a row.
            expect(body, file).toBe(body.trim() === '' ? '' : body.replace(/^\n+|\n+$/g, ''));
            expect(body, file).not.toMatch(/\n\n\n\n/);
        }
    });

    it('numbers every email, names every file in its email (merged copies too), no source list or hash on the cover', async () =>
    {
        const { pdfDocument, result: threadAnalysis } = await buildFixtureDocument(DEFAULT_OUTPUT_POLICY);
        const strings = createPdfStrings('en');
        expect(pdfDocument.emails.map((e) => e.number)).toEqual(threadAnalysis.messages.map((_, k) => k + 1));
        // Collapse, never delete: every read file is still named, in the File row of the email it gave.
        const named = pdfDocument.emails.flatMap((e) => e.fields.filter((f) => f.label === strings.fileLabel).flatMap((f) => f.value.map(lineText)));
        expect(named).toHaveLength(threadAnalysis.counts.messagesFound);
        expect(threadAnalysis.counts.duplicatesMerged).toBeGreaterThan(0);
        // Task 8.12: the cover is the title, the summary and the people, nothing else.
        expect(pdfDocument.cover.blocks.map((b) => b.kind)).toEqual(['heading', 'fields', 'heading', 'list']);
        expect(
            pdfDocument.cover.blocks.flatMap((b) => (b.kind === 'list' ? b.items.flat().map(lineText) : [])).join('\n')).not.toMatch(/[0-9a-f]{64}/);
        expect(pdfDocument.cover.participants.length).toBeGreaterThan(2);
        expect(pdfDocument.cover.undated).toBe(threadAnalysis.counts.undated);
    });

    it('with "include everything", every body is the full text after the display transforms only', async () =>
    {
        const policy = { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true };
        const { pdfDocument, result: threadAnalysis } = await buildFixtureDocument(policy);
        let quoted = 0;
        for (const { email, position } of realEmails(pdfDocument))
        {
            const analyzedMessage = threadAnalysis.messages[position]!;
            expect(bodyOf(email), analyzedMessage.message.source.fileName).toBe(referenceDisplayText(analyzedMessage.message.bodyText));
            // Tasks 8.1 and 8.6: only the quote prefixes are missing; no line starts with a quote mark.
            expect(quotePrefixProblems(analyzedMessage.message.bodyText, email.body.map(lineText)),
                analyzedMessage.message.source.fileName).toEqual([]);
            expect(bodyOf(email), analyzedMessage.message.source.fileName).not.toMatch(/^\s*>/mu);
            quoted += referenceDisplayLines(analyzedMessage.message.bodyText, { quotes: false }).filter((l) => /^\s*>/u.test(l)).length;
            expect(email.flags.planFallback).toBe(false);
        }
        // The fixtures hold ">" quotes (Gmail, Thunderbird, HTML blockquotes).
        expect(quoted).toBeGreaterThan(10);
    });
});
