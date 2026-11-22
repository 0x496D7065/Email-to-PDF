// Why a rebuilt email is not in the PDF (task 9.9b-3, Source/web-page-logic/rebuilt-left-out.ts):
// one reason per email, in a fixed priority order, and counts that add up.
// No email data at all: only the three facts.

import { describe, expect, it } from 'vitest';
import { REASON_ORDER, rebuiltPdfStatus, tallyRebuiltPdf, type RebuiltPdfFacts } from './rebuilt-left-out';

const IN: RebuiltPdfFacts = { noText: false, ticked: true, sourceInPdf: true };

describe('rebuiltPdfStatus', () =>
{
    it('in the PDF only when it has text, is ticked and an email it comes from is in the PDF', () =>
    {
        expect(rebuiltPdfStatus(IN)).toBe('in-pdf');
    });

    it('one reason each, when only that one applies', () =>
    {
        expect(rebuiltPdfStatus({ ...IN, noText: true })).toBe('no-text');
        expect(rebuiltPdfStatus({ ...IN, ticked: false })).toBe('unticked');
        expect(rebuiltPdfStatus({ ...IN, sourceInPdf: false })).toBe('source-left-out');
    });

    it('several reasons: no text first, then unticked, then the source left out', () =>
    {
        expect(REASON_ORDER).toEqual(['no-text', 'unticked', 'source-left-out']);
        expect(rebuiltPdfStatus({ noText: true, ticked: false, sourceInPdf: false })).toBe('no-text');
        expect(rebuiltPdfStatus({ noText: true, ticked: false, sourceInPdf: true })).toBe('no-text');
        expect(rebuiltPdfStatus({ noText: true, ticked: true, sourceInPdf: false })).toBe('no-text');
        expect(rebuiltPdfStatus({ noText: false, ticked: false, sourceInPdf: false })).toBe('unticked');
    });

    it('every combination: in the PDF exactly when the PDF rule says so, else the first reason that applies', () =>
    {
        for (const noText of [false, true])
        {
            for (const ticked of [false, true])
            {
                for (const sourceInPdf of [false, true])
                {
                    const status = rebuiltPdfStatus({ noText, ticked, sourceInPdf });
                    const applies = { 'no-text': noText, unticked: !ticked, 'source-left-out': !sourceInPdf };
                    const first = REASON_ORDER.find((reason) => applies[reason]);
                    expect(status, JSON.stringify({ noText, ticked, sourceInPdf })).toBe(first ?? 'in-pdf');
                    // The rule the count used before task 9.9b-3: ticked, follows its source, has text.
                    expect(status === 'in-pdf').toBe(ticked && sourceInPdf && !noText);
                }
            }
        }
    });
});

describe('tallyRebuiltPdf', () =>
{
    it('nothing left out: no reasons', () =>
    {
        expect(tallyRebuiltPdf([])).toEqual({ inPdf: 0, leftOut: [] });
        expect(tallyRebuiltPdf(['in-pdf', 'in-pdf'])).toEqual({ inPdf: 2, leftOut: [] });
    });

    it('counts each reason, in the priority order whatever the list order, only those above 0', () =>
    {
        expect(tallyRebuiltPdf(['source-left-out', 'in-pdf', 'no-text', 'source-left-out', 'unticked', 'no-text', 'no-text'])).toEqual({
            inPdf: 1,
            leftOut: [{ reason: 'no-text', count: 3 }, { reason: 'unticked', count: 1 }, { reason: 'source-left-out', count: 2 }],
        });
        expect(tallyRebuiltPdf(['source-left-out', 'in-pdf'])).toEqual({ inPdf: 1, leftOut: [{ reason: 'source-left-out', count: 1 }] });
    });

    it('the reason counts add up to the number left out', () =>
    {
        const statuses = ['in-pdf', 'no-text', 'unticked', 'source-left-out'] as const;
        // A fixed pseudo-random sequence: reproducible.
        let seed = 7;
        for (let round = 0; round < 50; round++)
        {
            const list = Array.from({ length: round % 9 }, () =>
            {
                seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
                return statuses[seed % statuses.length]!;
            });
            const tally = tallyRebuiltPdf(list);
            const sum = tally.leftOut.reduce((total, part) => total + part.count, 0);
            expect(tally.inPdf + sum).toBe(list.length);
            expect(tally.inPdf).toBe(list.filter((s) => s === 'in-pdf').length);
        }
    });
});
