// Emails with no text are left out of the PDF (task 8.14; user decisions
// 2026-11-09 and 2026-11-15). A NARROW, deliberate exception to README.md,
// rule R6 (collapse, never delete) and to brief section 8.5, for the PDF
// only: an email whose text holds nothing but white space has nothing to
// print, so it gets no page, no index entry, no bookmark and no number, and
// it does not count on the cover (its dates and people included). That holds
// even when it has attachments, and in both modes ("Print full original
// text" on or off). The preview keeps it, with a note that says so
// (Source/web-page/preview.ts), and step 2's count says how many are left out
// (Source/web-page/review.ts).
//
// The rule (hasNoPrintableText) is the only place that decides it. The PDF
// model (Source/pdf-export/model.ts, planPdfOrder), the preview's note, the counts and
// the download button (Source/web-page/mount-page.ts) all ask it, so they cannot disagree.
// It depends on the email alone: never on the mode, the ticks or the plans.
// - "No text" is exactly what the PDF would show as an empty text: the body
//   after the PDF's display transforms (Source/pdf-export/text.ts, bodyLines) has no
//   line at all. A line with only white space as JavaScript's `\s` defines
//   it (spaces, tabs, line breaks, U+00A0, U+FEFF and the other Unicode
//   spaces) is blank. Anything else is TEXT and keeps the email in the PDF:
//   a lone ">" quote mark, U+200B (zero width space), the VT and FF controls
//   or any other control character (the PDF shows those as a code).
// - An email whose text could not be read, or not in full, is NOT left out
//   (Q2): it keeps the "(no text)" placeholder in the PDF as before, since
//   its real text may be in the original file. These are the parser
//   warnings 'html-body-unreadable', 'rtf-only-body' and
//   'forwarded-message-not-expanded' (UNREADABLE_BODY_WARNINGS).
// - A rebuilt email (Source/web-page-logic/rebuilt-email-display.ts) whose rebuilt text has no
//   text (a quoted header with nothing under it) is left out the same way
//   (Q4, rebuiltHasNoPrintableText). Its header lines stay in the email it
//   was read from as quoted history, so the normal PDF folds them out with
//   the rest of the quote; they are printed only with "Print full original
//   text", and stay visible in the preview and in the original file.
// - An .eml with no text that holds an email attached as a FILE that could
//   not be read is left out too (user decision 2026-11-15): the unread file
//   is then not named in the PDF, but the preview shows its note
//   (Source/web-page-logic/attached-links.ts) and the file is still in the original
//   email.
// When unsure (a body that is not a string, warnings that are not a list),
// the email is NOT left out.
//
// Pure functions, no DOM (README.md, rule R7). Nothing is stored.

import { bodyLines } from '../pdf-export/text';
import type { NormalizedMessage, ParseWarning } from '../../Header/parsed-email';
import type { EngineRebuilt } from '../../Header/rebuilt-emails';
import type { EngineResult } from '../../Header/thread-analysis-result';

/** The parser warnings that mean the text could not be read (in full): such an email is never left out (Q2). */
export const UNREADABLE_BODY_WARNINGS: readonly ParseWarning[] = ['html-body-unreadable', 'rtf-only-body', 'forwarded-message-not-expanded'];

/** True when `text` is a string the PDF would show as an empty text (bodyLines gives no line). */
function isEmptyText(text: unknown): boolean
{
    return typeof text === 'string' && bodyLines(text).lines.length === 0;
}

/**
 * True when the PDF leaves this email out because it has no text (see the
 * top of this file): its body has no printable text and no warning says its
 * text could not be read.
 */
export function hasNoPrintableText(message: Pick<NormalizedMessage, 'bodyText' | 'warnings'>): boolean
{
    if (!isEmptyText(message.bodyText))
    {
        return false;
    }
    // A plain boolean check: Array.isArray as a type guard would turn the list into any[].
    const isList: boolean = Array.isArray(message.warnings);
    if (!isList)
    {
        return false;
    }
    return !message.warnings.some((w) => UNREADABLE_BODY_WARNINGS.includes(w));
}

/** True when the PDF leaves this rebuilt email out because its rebuilt text has no text (Q4). */
export function rebuiltHasNoPrintableText(rebuiltEmail: Pick<EngineRebuilt, 'rebuilt'>): boolean
{
    return isEmptyText(rebuiltEmail.rebuilt?.reconstructedText);
}

/**
 * The ticked list positions whose email the PDF prints: `positions` (in the
 * given order) less the emails left out because they have no text, and less
 * any position without an email.
 */
export function pdfPositions(result: Pick<EngineResult, 'messages'>, positions: readonly number[]): number[]
{
    return positions.filter((position) =>
    {
        const email = result.messages[position];
        return email !== undefined && !hasNoPrintableText(email.message);
    });
}
