// The "no text" rule of task 8.14 (Source/web-page-logic/no-printable-text.ts): which emails
// the PDF leaves out because they have no text. Synthetic data only.

import { describe, expect, it } from 'vitest';
import { analyzeThread } from '../thread-analysis/analyze-thread';
import { hasNoPrintableText, pdfPositions, rebuiltHasNoPrintableText, UNREADABLE_BODY_WARNINGS } from './no-printable-text';
import type { NormalizedMessage, ParseWarning } from '../../Header/parsed-email';

const rule = (bodyText: string, warnings: readonly ParseWarning[] = []): boolean => hasNoPrintableText({ bodyText, warnings: [...warnings] });

let counter = 0;
function make(fields: Partial<NormalizedMessage> = {}): NormalizedMessage
{
    counter++;
    return {
        messageId: `rule-${String(counter)}@example.test`,
        inReplyTo: null,
        references: [],
        date: { utcMs: Date.UTC(2025, 3, 10) + counter * 3_600_000, original: 'synthetic', offsetMinutes: 60, zoneKnown: true },
        from: [{ name: 'Erin Sample', address: 'erin@example.test' }],
        to: [],
        cc: [],
        bcc: [],
        subject: `Subject ${String(counter)}`,
        bodyText: `Text number ${String(counter)}.`,
        attachments: [],
        source: { fileName: `rule-${String(counter)}.eml`, sha256: (0xd000 + counter).toString(16).padStart(64, '0'), kind: 'eml' },
        warnings: [],
        ...fields,
    };
}

describe('hasNoPrintableText', () =>
{
    it('no text: empty, or white space only as JavaScript \\s defines it', () =>
    {
        for (const body of ['', ' ', '\t', '\n', ' \t\n\n  \n', ' ', '﻿', ' 　', '  ', '\n \t﻿\n'])
        {
            expect(rule(body), JSON.stringify(body)).toBe(true);
        }
    });

    it('text: anything the PDF would show, even if it looks empty', () =>
    {
        // U+200B is not \s; ">" is a quote mark (an empty line in the PDF); VT, FF and U+0000 are shown as codes.
        for (const body of ['​', '>', '> ', ' >\n', '\u000b', '\u000c', '\u0000', '\u0007', '­', 'x', '\n\n.\n'])
        {
            expect(rule(body), JSON.stringify(body)).toBe(false);
        }
    });

    it('an empty body whose text could not be read is never left out (Q2)', () =>
    {
        expect(UNREADABLE_BODY_WARNINGS).toEqual(['html-body-unreadable', 'rtf-only-body', 'forwarded-message-not-expanded']);
        for (const warning of UNREADABLE_BODY_WARNINGS)
        {
            expect(rule('', [warning]), warning).toBe(false);
            expect(rule('  \n', ['no-body', warning]), warning).toBe(false);
        }
    });

    it('other warnings do not matter: no body at all, or an HTML body converted to nothing', () =>
    {
        expect(rule('', ['no-body'])).toBe(true);
        expect(rule('', ['html-converted-body'])).toBe(true);
        expect(rule(' \n', ['html-converted-body', 'missing-date', 'unknown-time-zone'])).toBe(true);
        expect(rule('', ['html-body-truncated'])).toBe(true);
    });

    it('when unsure, not left out: a body that is not a string, warnings that are not a list', () =>
    {
        expect(hasNoPrintableText({ bodyText: undefined as unknown as string, warnings: [] })).toBe(false);
        expect(hasNoPrintableText({ bodyText: null as unknown as string, warnings: [] })).toBe(false);
        expect(hasNoPrintableText({ bodyText: '', warnings: undefined as unknown as ParseWarning[] })).toBe(false);
    });
});

describe('rebuiltHasNoPrintableText', () =>
{
    const entry = (reconstructedText: unknown) => ({ rebuilt: { reconstructedText } }) as unknown as Parameters<typeof rebuiltHasNoPrintableText>[0];
    it('the rebuilt text alone decides (Q4)', () =>
    {
        expect(rebuiltHasNoPrintableText(entry(''))).toBe(true);
        expect(rebuiltHasNoPrintableText(entry('\n\n'))).toBe(true);
        expect(rebuiltHasNoPrintableText(entry('  \n'))).toBe(true);
        expect(rebuiltHasNoPrintableText(entry('Old text.'))).toBe(false);
        expect(rebuiltHasNoPrintableText(entry('​'))).toBe(false);
        expect(rebuiltHasNoPrintableText(entry(undefined))).toBe(false);
    });
});

describe('pdfPositions', () =>
{
    it('the ticked positions less the emails with no text, in the given order', () =>
    {
        const result = analyzeThread([make(), make({ bodyText: '' }), make(), make({ bodyText: ' \n' }), make({ bodyText: '', warnings: ['rtf-only-body'] })].map((message) => ({ ok: true as const, message })));
        const empties = result.messages.flatMap((m, k) => (hasNoPrintableText(m.message) ? [k] : []));
        expect(empties).toHaveLength(2);
        const all = result.messages.map((_, k) => k);
        expect(pdfPositions(result, all)).toEqual(all.filter((k) => !empties.includes(k)));
        expect(pdfPositions(result, [...all].reverse())).toEqual([...all].reverse().filter((k) => !empties.includes(k)));
        expect(pdfPositions(result, empties)).toEqual([]);
        expect(pdfPositions(result, [])).toEqual([]);
        // A position without an email is not printed either.
        expect(pdfPositions(result, [99])).toEqual([]);
    });
});
