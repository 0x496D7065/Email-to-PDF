// Why a rebuilt email is not in the PDF (task 9.9b-3, user decision F5):
// step 2's line "X of N rebuilt emails will be in the PDF." is followed by
// the reasons, counted, when X < N (Source/web-page/review.ts, rebuiltIncludedText).
//
// This file does NOT decide anything new. It only names the decision the
// PDF already makes, from the same three facts the review and the PDF use:
// - `noText`: rebuiltHasNoPrintableText (Source/web-page-logic/no-printable-text.ts),
//   the very rule planPdfOrder (Source/pdf-export/build-pdf-document.ts) applies;
// - `ticked`: the card's own tick as the review counts it (a broken or
//   undecorated card counts as ticked; Source/web-page/review.ts, rebuiltIncluded);
// - `sourceInPdf`: the follow-source rule (rebuiltInPdf in
//   Source/web-page-logic/rebuilt-email-display.ts, user decision Q1 (a)): at least one email
//   it was read from is in the PDF.
// A rebuilt email is in the PDF exactly when it is ticked, follows a source
// in the PDF and has text: the same as review.ts's count before this task
// (rebuiltIncluded less the ones with no text).
//
// Only these three reasons can apply to a rebuilt email in the count: the
// count holds only rebuilt emails with a card (link 'entry',
// rebuiltEntries). One that is the same as an email file added (link
// 'real') or as another rebuilt email (link 'same-as') has no card and is
// not counted at all; quoted text that could not be rebuilt is a note, not
// a rebuilt email; and with the switch off or "Print full original text"
// ticked the line is not shown.
//
// ONE reason per email left out, so the counts add up to N - X. When
// several apply, the first in this order wins (REASON_ORDER):
// 1. 'no-text': the email itself has nothing to print. It comes first
//    because no tick can change it: ticking the card or its email back
//    would still leave it out, so naming any other reason would mislead.
// 2. 'unticked': the reader unticked this card. Its own choice comes
//    before its source's, as on the card itself (Source/web-page/review.ts,
//    applyRebuilt: an unticked card says "Not in the PDF", the "email it
//    comes from is left out" mark is only on a ticked card).
// 3. 'source-left-out': every email it was read from is left out of the PDF.
//
// Pure functions, no DOM (README.md, rule R7). Nothing is stored.

/** Why a rebuilt email is not in the PDF (see the top of this file for the order). */
export type RebuiltLeftOutReason = 'no-text' | 'unticked' | 'source-left-out';

/** The reasons in priority order, also the order they are written in. */
export const REASON_ORDER: readonly RebuiltLeftOutReason[] = ['no-text', 'unticked', 'source-left-out'];

/** The facts about one rebuilt email (see the top of this file for where each comes from). */
export interface RebuiltPdfFacts
{
    readonly noText: boolean;
    readonly ticked: boolean;
    readonly sourceInPdf: boolean;
}

/** 'in-pdf', or the one reason it is left out (the first that applies, REASON_ORDER). */
export function rebuiltPdfStatus(facts: RebuiltPdfFacts): 'in-pdf' | RebuiltLeftOutReason
{
    if (facts.noText)
    {
        return 'no-text';
    }
    if (!facts.ticked)
    {
        return 'unticked';
    }
    if (!facts.sourceInPdf)
    {
        return 'source-left-out';
    }
    return 'in-pdf';
}

/** How many are in the PDF, and how many are left out for each reason (in REASON_ORDER, only reasons with a count above 0). */
export interface RebuiltPdfTally
{
    readonly inPdf: number;
    readonly leftOut: readonly { readonly reason: RebuiltLeftOutReason; readonly count: number }[];
}

/** Counts the statuses of rebuiltPdfStatus. The left-out counts add up to statuses.length - inPdf. */
export function tallyRebuiltPdf(statuses: readonly ('in-pdf' | RebuiltLeftOutReason)[]): RebuiltPdfTally
{
    const counts = new Map<RebuiltLeftOutReason, number>();
    let inPdf = 0;
    for (const status of statuses)
    {
        if (status === 'in-pdf')
        {
            inPdf++;
        }
        else
        {
            counts.set(status, (counts.get(status) ?? 0) + 1);
        }
    }
    const leftOut = REASON_ORDER.flatMap((reason) =>
    {
        const count = counts.get(reason) ?? 0;
        return count > 0 ? [{ reason, count }] : [];
    });
    return { inPdf, leftOut };
}
