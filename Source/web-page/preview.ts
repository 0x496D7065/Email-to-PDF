// Step 2: the preview. A list of the emails in the thread analysis's (chronological)
// order, each with its date, author, recipients, subject, attachments and body.
//
// What it shows, and how:
// - Dates as written (user decision, task 9.9c): the sender's own
//   wall-clock date and time, never converted to another time zone, with no
//   offset (Source/thread-analysis/time-format.ts); the same text as in the
//   PDF. A date that could not be read shows "(no date)" and the date as
//   written (the PDF shows that text alone). Task 8.8: the PDF has no
//   notes, so the page says this.
// - The body as display blocks (Source/web-page-logic/display-blocks.ts). Shown text
//   goes into the page as text. Each folded block is a <details> element
//   with a short label (why it was folded, how long it is, which earlier
//   email it repeats): the folded text is always in the page, one click away
//   (README.md, rule R6: collapse, never delete). The "show quoted text"
//   checkbox opens or closes every folded block at once, and blocks built
//   later follow its current state.
// - Attachments as names, sizes and types only: never opened, never turned
//   into links (README.md, rule R4).
//
// Safety: every email field is untrusted. It only ever reaches the page as
// text, through createSafeElement() (Source/web-page/safe-dom.ts), never as HTML (README.md, rule R4).
// Nothing is stored: the checkbox lives in memory only
// (README.md, rule R5).
//
// Big batches: the list is built in chunks (the first one at once, the
// others in later tasks), so the page stays responsive with thousands of
// emails. A new result or reset() cancels the chunks still waiting; reset()
// ("Clear everything") also puts the checkbox back to its
// default. If one
// email's item cannot be built, a stand-in with its number and whole text
// takes its place and the rest of the list is still built: no email is ever
// silently missing.
//
// What the PDF leaves out: each folded block also carries a text label, "In
// the PDF: ..." or "Not in the PDF: ...", from the PDF's own plan
// (Source/thread-analysis/output-plan.ts, mapped by Source/web-page-logic/pdf-plan.ts). The plans
// are worked out by Source/web-page/pdf-labels.ts and handed over with setPdfPlans().
// With "Print full original text" off, a part the PDF prints as an email of
// its own (the no-repeat rule of Source/pdf-export/build-pdf-document.ts, task 8.10) is labelled
// "Not in this email in the PDF: printed as email #N" instead (task 8.11;
// the views carry the PDF's own cut, Source/web-page-logic/printed-elsewhere.ts).
// Rules:
// - A folded block is all in the PDF or all left out: when the plan changes
//   inside one, the block is cut in two (its text is not changed).
// - Never a stale label: setPdfPlans(null) marks the list as updating
//   (`data-pdf-labels="updating"` on the list), which hides every label and
//   PDF note at once (app.css) and shows "Checking what goes in the PDF...".
//   New plans are applied in chunks; the labels show again only once every
//   email built so far has its new labels. Emails built later get them as
//   they are built.
// - An email left out of the PDF (unticked) gets no PDF labels: the whole
//   email is already marked "Not in the PDF" (Source/web-page/review.ts). Its body
//   is not redrawn: the labels and note it had stay in place but hidden,
//   from screen readers too (`data-pdf-out` on its body and note, app.css),
//   so unticking it does not move the emails below up, and ticking it back
//   (same plan: nothing to redraw) does not move them down. An email built
//   while left out simply has no labels.
// - An email with no text (task 8.14, Source/web-page-logic/no-printable-text.ts: its body is
//   empty or white space only, and its text was read) is never in the PDF,
//   ticked or not: it gets no PDF labels and no PDF note, and its body says
//   "Not in the PDF: this email has no text." instead of "(no text)" (under
//   its blank text when it is white space only). Its tick box stays. The
//   same for a rebuilt card whose rebuilt text has no text (Q4). An empty
//   body whose text could not be read stays in the PDF and keeps "(no text)".
// - An email the plan keeps whole (rules 4 and 5 of output-plan.ts) gets a
//   short note above its text (Source/web-page-logic/message-notes.ts, pdfPlanNote).
// - Never silent: when one email's labels cannot be shown (a failed update,
//   or a stand-in item of an email that is in the PDF), a note above its
//   text says so (pdf.messageFailed).
// - The status line keeps its place while a list is shown, so ticking an
//   email never moves the list under the reader's pointer.
// - The keyboard focus is never lost to a redraw: when new plans redraw a
//   body whose fold summary had the focus, the focus goes to the summary of
//   the new fold over the same text (or to the body itself if no fold is
//   left there), never back to the top of the page, and the new summary is
//   scrolled into view if the old one could be seen. Focus anywhere else is
//   not touched. (A new result is Source/web-page/mount-page.ts's job: it rebuilds the
//   whole list.)
// The labels only add words: every character stays in the page.
//
// Language change (relabel): nothing is rebuilt, and no body is redrawn, so
// open folds, the focus and the scroll position stay. Written again in
// place, from what the preview keeps anyway: the toolbar's words, the
// status line, each email's number, its
// "(no subject)" placeholder, its details list (<dl>: labels and mailbox,
// attachment and "also in" lines, the date elements kept),
// each fold's "what" line and PDF label, the PDF and "no text" notes, and
// the stand-ins' notes. The dates' numbers are the same in every language.
//
// Rebuilt emails (milestone 7, task 7.6; Source/web-page-logic/rebuilt-email-display.ts): the
// list follows the thread analysis's timeline, so an earlier email rebuilt from the
// quoted text of an email added gets its own card at its place in time.
// Only rebuilt emails with their own timeline entry get one (one that is
// the same as a real email added gets none: the real file wins). A rebuilt
// card:
// - has NO number of its own (numbers belong to the real emails), a dashed
//   border AND the word "Rebuilt" in its heading (never colour alone);
// - says, in a fixed note, which email it was taken from and that it may be
//   incomplete or inexact (and that quote marks were removed, when they
//   were), plus "same quoted text also in email #K" for copies;
// - shows the sender, recipients ("list may be incomplete" when the quoted
//   list may go on), subject and date read from the quoted header. A quoted
//   time is shown as written (its wall-clock time, never converted and
//   never marked as a guess, task 9.9c); a day alone as written; both with
//   the date text as written too; a date that could not be read only as
//   written;
// - shows the rebuilt text as text (quote marks removed, the one form change
//   the user allowed). Its signature blocks (task 9.9b-2, user decision F4:
//   folded as in a real email; AnalyzedRebuiltMessage.segments) are folded
//   blocks with their PDF labels (PreviewPdfPlans.rebuiltViews: the PDF's
//   own plan of that text, "Not in the PDF: repeated signature" once the
//   sender's block was printed earlier); nothing else of it is folded.
// Nothing of the source email changes: its card is built exactly as before,
// with all its text (README.md, rule R6). The rebuilt cards' checkboxes and
// the switch that leaves them all out are Source/web-page/review.ts's
// (`decorateRebuilt`). A rebuilt card that cannot be built is replaced by
// a stand-in with its label, a note and its text. While the switch is off
// or "Print full original text" is ticked (`rebuiltShown`), EVERY rebuilt card in the list is hidden, a stand-in the
// review could not decorate too (`refreshRebuilt` after each change).
//
// Emails attached inside other emails (task 8.13b-4; Source/web-page-logic/attached-links.ts):
// the card of an attached email has an "Attached to: email #N" row and the
// card holding it an "Attached emails: #4, #6" row, the list numbers as
// plain text (never links). They are worked out once per result (show()),
// forgotten by clear(), and written again by relabel() with the details
// list. "Also in" names each merged copy by the same chain as the PDF's
// File row ("parent.eml › forwarded.eml", Source/web-page-logic/file-chain.ts).
// None of it is in the PDF.
//
// Not here: the counts, the include/exclude checkboxes and the notes
// (Source/web-page/review.ts). They reach the page through three options: `header`
// (nodes above the toolbar), `decorate` (adds to each email's item) and
// `onRendered` (told when a list is complete). `toolbarItems` adds controls
// to the toolbar (the "Print full original text" checkbox of
// Source/web-page/pdf-labels.ts).

import { checkSegments, joinSegments } from '../thread-analysis/fold-segments';
import { formatEmailDate, formatWallClock, isDisplayableMs } from '../thread-analysis/time-format';
import { attachedLinks } from '../web-page-logic/attached-links';
import { displayAuthor } from '../web-page-logic/display-author';
import { fileChain } from '../web-page-logic/file-chain';
import { joinMailboxes, joinPlain } from '../web-page-logic/mailbox-list';
import { pdfPlanNote, type PdfNoteCode } from '../web-page-logic/message-notes';
import { hasNoPrintableText, rebuiltHasNoPrintableText } from '../web-page-logic/no-printable-text';
import { pdfBlocks, printedAsEmailOfItsOwn, viewKey } from '../web-page-logic/pdf-plan';
import { previewOrder, rebuiltCard } from '../web-page-logic/rebuilt-email-display';
import type { PageShell } from './page-shell';
import { createSafeElement, setSafeAttribute } from './safe-dom';
import { getLocale, t, translator } from './translations';
import { createStaticLabels } from './static-labels';
import type { ProcessResult } from '../../Header/file-processing';
import type { PlanReason } from '../../Header/output-plan';
import type { AttachmentInfo, EmailAddress, EmailDate } from '../../Header/parsed-email';
import type { DisplayBlock, LabeledBlock, PdfLabel, PdfView } from '../../Header/pdf-plan';
import type { AttachedLinks, PreviewSlot, RebuiltCard, RebuiltDate } from '../../Header/preview-display';
import type { AnalyzedRebuiltMessage } from '../../Header/rebuilt-emails';
import type { AnalyzedMessage, ThreadAnalysisResult, MergedCopy, Segment } from '../../Header/thread-analysis-result';

/** Emails built per chunk (at least one per chunk, see MAX_CHUNK_CHARS). */
export const DEFAULT_CHUNK_SIZE = 40;
/** A chunk also ends once its bodies hold this many characters, so a few huge emails do not freeze the page. */
export const MAX_CHUNK_CHARS = 500_000;
/**
 * New PDF labels are applied to this many times `chunkSize` emails per chunk
 * (also capped by MAX_CHUNK_CHARS): updating a label is much cheaper than
 * building an email's item.
 */
export const PDF_CHUNK_FACTOR = 4;

// ---------------------------------------------------------------------------
// Pure helpers (no DOM; unit tested directly).

/** Joins texts the local way ("a, b, c"), with the page language's own list rules. */
export function joinList(items: readonly string[]): string
{
    return translator(getLocale()).list(items);
}

/** True if a mailbox has neither a name nor an address. */
function isBlankMailbox(mailbox: EmailAddress): boolean
{
    return mailbox.name.trim() === '' && mailbox.address.trim() === '';
}

/** "Name <address>", or whichever of the two exists. The texts are shown as they are. */
export function mailboxText(mailbox: EmailAddress): string
{
    const hasName = mailbox.name.trim() !== '';
    const hasAddress = mailbox.address.trim() !== '';
    if (hasName && hasAddress)
    {
        return t('preview.mailbox', { name: mailbox.name, address: mailbox.address });
    }
    return hasName ? mailbox.name : mailbox.address;
}

/**
 * The mailboxes of a list as one line; blank entries left out. '' if none.
 * Joined with a plain ", " in every language: an address field is not a
 * sentence (Source/web-page-logic/mailbox-list.ts).
 */
export function mailboxListText(list: readonly EmailAddress[]): string
{
    return joinMailboxes(list.filter((m) => !isBlankMailbox(m)).map(mailboxText));
}

/** One decimal under 10 (1.4 KB), whole numbers above (12 KB). */
function roundSize(amount: number): number
{
    return amount < 10 ? Math.round(amount * 10) / 10 : Math.round(amount);
}

/** A file size for people: "512 bytes", "1.4 KB", "12 MB"; "size unknown" if not given. */
export function sizeText(size: number | null): string
{
    if (size === null || !Number.isFinite(size) || size < 0)
    {
        return t('preview.size.unknown');
    }
    if (size < 1024)
    {
        return t('preview.size.bytes', { count: size });
    }
    const kilobytes = size / 1024;
    if (kilobytes < 1024)
    {
        return t('preview.size.kb', { size: roundSize(kilobytes) });
    }
    return t('preview.size.mb', { size: roundSize(kilobytes / 1024) });
}

/** "report.pdf (12 KB, application/pdf)": metadata only, the file is never opened. */
export function attachmentText(attachment: AttachmentInfo): string
{
    const name = attachment.fileName.trim() === '' ? t('preview.noAttachmentName') : attachment.fileName;
    const size = sizeText(attachment.size);
    if (attachment.mimeType.trim() === '')
    {
        return t('preview.attachmentNoType', { name, size });
    }
    return t('preview.attachment', { name, size, type: attachment.mimeType });
}

/** The date texts of one email. */
export interface DateTexts
{
    /** "2025-03-03 09:15:00", as written (the sender's own clock, never converted), or the "no date" text. */
    readonly main: string;
    /** For <time datetime>: the time as written, with its offset when known; null without a date. */
    readonly iso: string | null;
    /** "As written in the email: ...": without a usable date, the date text the email gave, if any; else null. */
    readonly asWritten: string | null;
}

export function dateTexts(date: EmailDate): DateTexts
{
    const shown = formatEmailDate(date);
    if (shown.kind === 'no-date' || !isDisplayableMs(date.utcMs))
    {
        // The PDF shows this text alone in the Date row (task 8.8): the reader sees it here first.
        const original = typeof date.original === 'string' ? date.original : '';
        const asWritten = original.trim() === '' ? null : t('preview.dateAsWritten', { text: original });
        return { main: t('preview.noDate'), iso: null, asWritten };
    }
    return { main: shown.text, iso: shown.iso, asWritten: null };
}

/**
 * Lines in a block of text: "a\nb" is 2, "a\nb\n" too (a final line break
 * starts no new line). Only LF is counted: bodyText has LF line ends only
 * (Source/email-reading/line-endings.ts), so this matches the thread analysis's lines.
 */
export function lineCount(text: string): number
{
    if (text === '')
    {
        return 0;
    }
    const breaks = text.split('\n').length - 1;
    return text.endsWith('\n') ? breaks : breaks + 1;
}

/**
 * The numbers (1-based, as shown in the list) of the other emails a folded
 * block repeats. `related` holds input positions; `positionByIndex` turns
 * them into list positions (see Source/thread-analysis/analyze-thread.ts). The email itself and
 * unknown positions are left out.
 */
export function relatedNumbers(block: DisplayBlock, ownPosition: number, positionByIndex: readonly (number | null)[]): number[]
{
    const numbers = new Set<number>();
    for (const index of block.related)
    {
        const position = positionByIndex[index];
        if (position !== null && position !== undefined && position !== ownPosition)
        {
            numbers.add(position + 1);
        }
    }
    return [...numbers].sort((a, b) => a - b);
}

/** "#3": an email's number in the list. */
export function messageNumberText(number: number): string
{
    // A string, so the number is not written with a thousands separator.
    return t('preview.messageNumber', { number: String(number) });
}

/** The label of a folded block: "Quoted text, 12 lines, from email #3". */
export function foldSummaryText(block: DisplayBlock, ownPosition: number, positionByIndex: readonly (number | null)[]): string
{
    const kind = block.label === null ? t('preview.foldOther') : t(`preview.fold.${block.label}`);
    const lines = t('preview.foldLines', { count: lineCount(block.text) });
    const numbers = relatedNumbers(block, ownPosition, positionByIndex);
    if (numbers.length === 0)
    {
        return t('preview.foldLabel', { kind, lines });
    }
    // The email numbers ARE a list: "from emails #1, #3" ("#1 et #3" in French).
    const list = joinList(numbers.map(messageNumberText));
    const from = numbers.length === 1 ? t('preview.foldFromOne', { list }) : t('preview.foldFromMany', { list });
    return t('preview.foldLabelFrom', { kind, lines, from });
}

/**
 * One reason of a PDF label: "earlier email quoted by the mail app", "same
 * signature as in email #2", "same signature as in emails #1, #3".
 * `signaturesFrom`: the list numbers of the emails where the repeated
 * signatures are kept (see PdfLabel).
 */
export function pdfReasonText(reason: PlanReason, signaturesFrom: readonly number[]): string
{
    if (reason !== 'repeated-signature' || signaturesFrom.length === 0)
    {
        return t(`pdf.reason.${reason}`);
    }
    const list = joinList(signaturesFrom.map(messageNumberText));
    return signaturesFrom.length === 1 ? t('pdf.repeatedFrom', { number: list }) : t('pdf.repeatedFromMany', { list });
}

/**
 * A block's PDF label: "Not in the PDF: earlier email quoted by the mail
 * app"; for a part the PDF prints as an email of its own (task 8.11):
 * "Not in this email in the PDF: printed as email #5" (a real email, by its
 * list number) or "... printed as a rebuilt email (Email 3 in the PDF)" (a
 * rebuilt email has no list number: its heading in the PDF); for a
 * forwarded part left out with its unticked rebuilt email (task 8.13a, Q2):
 * "Not in the PDF: forwarded email whose rebuilt email is unticked"; for the
 * printed block of an unticked attached email (task 8.13b-3, Q3): "Not in
 * the PDF: email #4 (attached here) is unticked" (#4 may be the dropped
 * file's copy it was merged into); for the printed block of an attached
 * email with no text and no attachments (user decision Q5): "Not in the
 * PDF: email #4 (attached here) has no text" (one with attachments keeps
 * its block, so it has no label). The parts of the block of an attached
 * email in the PDF that its own page prints read like a real file's:
 * "... printed as email #4"; the parts its page does not print stay in
 * this email, with their own label (review round 4 of task 8.13b-3).
 * Task 9.9b: the header lines of a quoted email with no text (F2): "Not in
 * the PDF: quoted email with no text (header lines only)"; a folded part of
 * a forward whose rebuild failed (F6): "Not in the PDF: quoted part that
 * could not be rebuilt as an email".
 */
export function pdfLabelText(label: PdfLabel): string
{
    const printedAs = label.status === 'out' ? (label.printedAs ?? null) : null;
    if (printedAs !== null)
    {
        switch (printedAs.kind)
        {
            case 'email':
                return t('pdf.printedAs.email', { number: messageNumberText(printedAs.position + 1) });
            case 'rebuilt':
                return t('pdf.printedAs.rebuilt', { number: String(printedAs.number) });
            case 'unticked':
                return t('pdf.printedAs.unticked');
            case 'unticked-attached':
                return t('pdf.printedAs.untickedAttached', { number: messageNumberText(printedAs.position + 1) });
            case 'no-text-attached':
                return t('pdf.printedAs.noTextAttached', { number: messageNumberText(printedAs.position + 1) });
            case 'no-text':
                return t('pdf.printedAs.noText');
            case 'not-rebuilt':
                return t('pdf.printedAs.notRebuilt');
        }
    }
    const list = label.reasons.length === 0 ? ['text' as const] : label.reasons;
    // The reasons are parts, not a list: a plain ", " (no "et" in French; a
    // reason may itself hold a list of email numbers, "#1 et #3").
    const reasons = joinPlain(list.map((r) => pdfReasonText(r, label.signaturesFrom)));
    switch (label.status)
    {
        case 'in':
            return t('pdf.label.in', { reasons });
        case 'out':
            return t('pdf.label.out', { reasons });
        case 'partly':
            return t('pdf.label.partly', { reasons });
    }
}

/** The id of an email's heading in the list (unique: one item per position). */
export function headingId(position: number): string
{
    return `message-${String(position)}-title`;
}

/** The id of a rebuilt card's heading (unique: one card per rebuilt id). */
export function rebuiltHeadingId(id: number): string
{
    return `rebuilt-${String(id)}-title`;
}

/** The date texts of a rebuilt email. */
export interface RebuiltDateTexts
{
    /** "2025-03-03 09:15" (as written), "2025-03-03", or a "no date" / "could not be read" text. */
    readonly main: string;
    /** For <time datetime>: the moment, or the day; null without a readable date. */
    readonly iso: string | null;
    /** "As written in the quote: ..." when the quote has a date text; else null. */
    readonly asWritten: string | null;
}

/**
 * A rebuilt email's date. A quoted time is shown as written, its
 * wall-clock time, never converted and never marked as a guess (task
 * 9.9c); it has no seconds, so none are shown. A day alone is shown as
 * written. The date text as written is always given too.
 */
export function rebuiltDateTexts(date: RebuiltDate): RebuiltDateTexts
{
    if (date.kind === 'none')
    {
        return { main: t('preview.noDate'), iso: null, asWritten: null };
    }
    const asWritten = t('rebuilt.dateAsWritten', { text: date.text });
    const unreadable = { main: t('rebuilt.dateUnreadable'), iso: null, asWritten };
    if (date.kind === 'unreadable')
    {
        return unreadable;
    }
    // A day alone is shown as written, never "about" (user decision Q2, task 7.7): only a time can be off.
    if (date.kind === 'day')
    {
        return { main: date.day, iso: date.day, asWritten };
    }
    const shown = formatWallClock(date.wallMs, date.writtenOffsetMinutes);
    if (shown.kind === 'no-date')
    {
        return unreadable;
    }
    return { main: shown.shortText, iso: shown.iso, asWritten };
}

/** The fixed note of a rebuilt card: where it was taken from, may be incomplete or inexact (quote marks removed, if so). */
export function rebuiltNoteText(card: Pick<RebuiltCard, 'sourceNumber' | 'quoteMarksRemoved'>): string
{
    if (card.sourceNumber === null)
    {
        throw new Error('rebuilt email without a source'); // a stand-in is shown instead
    }
    const number = messageNumberText(card.sourceNumber);
    return card.quoteMarksRemoved ? t('rebuilt.noteMarks', { number }) : t('rebuilt.noteNoMarks', { number });
}

/** "Same quoted text also in emails #4, #6."; '' if none. */
export function rebuiltAlsoText(numbers: readonly number[]): string
{
    if (numbers.length === 0)
    {
        return '';
    }
    const list = joinList(numbers.map(messageNumberText));
    return numbers.length === 1 ? t('rebuilt.alsoOne', { list }) : t('rebuilt.alsoMany', { list });
}

// ---------------------------------------------------------------------------
// The step 2 interface.

export interface PreviewOptions
{
    /** Emails per chunk. Default DEFAULT_CHUNK_SIZE. */
    readonly chunkSize?: number;
    /** Runs a task later (default: setTimeout 0). Returns a handle for `cancel`. */
    readonly schedule?: (task: () => void) => unknown;
    /** Cancels a scheduled task (default: clearTimeout). */
    readonly cancel?: (handle: unknown) => void;
    /** Nodes shown above the toolbar (the counts of Source/web-page/review.ts). Default: none. */
    readonly header?: readonly Node[];
    /**
     * Hook that adds to each email's list item (Source/web-page/review.ts: include
     * checkbox, notes), called after the item is built, with the result it
     * belongs to. If building or decorating fails, it is called again with
     * that email's stand-in (`.message-failed`), so it must not assume one
     * call per position and must not keep references from a call that threw.
     * Each item's heading has the id `message-<position>-title`.
     */
    readonly decorate?: (item: HTMLLIElement, message: AnalyzedMessage, position: number, result: ThreadAnalysisResult) => void;
    /**
     * The same for a rebuilt email's card (Source/web-page/review.ts: its include
     * checkbox). Called after the card is built; if building or decorating
     * fails, called again with the card's stand-in. Each card's heading has
     * the id `rebuilt-<id>-title`.
     */
    readonly decorateRebuilt?: (item: HTMLLIElement, rebuilt: AnalyzedRebuiltMessage, result: ThreadAnalysisResult) => void;
    /**
     * False while no rebuilt email is shown (Source/web-page/review.ts: its switch is
     * off, or "Print full original text" is ticked). Then EVERY rebuilt card is hidden, decorated or not (a
     * stand-in the hook could not decorate too). Read when a card is put in
     * the list and by refreshRebuilt(). Default: always shown. If it throws,
     * the cards are shown.
     */
    readonly rebuiltShown?: () => boolean;
    /**
     * Called once the last item of a result is in the page (Source/web-page/review.ts:
     * an email with no decorated item then counts as included). Not called
     * for a list replaced or reset before it was finished. If it throws, the
     * list is not affected.
     */
    readonly onRendered?: (result: ThreadAnalysisResult) => void;
    /** Controls added at the end of the toolbar (Source/web-page/pdf-labels.ts). Default: none. */
    readonly toolbarItems?: readonly Node[];
}

/** The PDF plans of a result, for the labels (see the top of this file). */
export interface PreviewPdfPlans
{
    /** The result they were made for: plans for another result are ignored. */
    readonly result: ThreadAnalysisResult;
    /** List position -> its plan. An email that is not in the map is not in the PDF (no labels). */
    readonly views: ReadonlyMap<number, PdfView>;
    /**
     * Rebuilt id -> the signature plan of its card's text (task 9.9b-2; Source/web-page-logic/printed-elsewhere.ts,
     * pdfCut). A rebuilt card that is not in the map has no labels. Absent: none.
     */
    readonly rebuiltViews?: ReadonlyMap<number, PdfView>;
}

/**
 * The state of the PDF labels: 'off' (no plans asked for yet), 'updating'
 * (labels hidden), 'ready' (every label shown is up to date), 'failed' (the
 * plans could not be worked out; labels hidden, a note says so).
 */
export type PdfLabelState = 'off' | 'updating' | 'ready' | 'failed';

export interface Preview
{
    /** Shows the emails of a result (replacing what was shown). */
    show(result: ThreadAnalysisResult): void;
    /** Shows a step 1 result: its emails, or nothing after a batch error. */
    showResult(result: ProcessResult): void;
    /**
     * Empties the list, cancels any chunk still waiting and puts the toolbar
     * back to its defaults (folded text closed), for "Clear
     * everything".
     */
    reset(): void;
    /** True while chunks are still waiting to be built. */
    isRendering(): boolean;
    /**
     * New PDF plans for the labels, or null while they are being worked out
     * again (the labels are hidden at once). Plans for another result than
     * the one shown count as null.
     */
    setPdfPlans(plans: PreviewPdfPlans | null): void;
    /** The plans could not be worked out: labels hidden, a note says so. */
    pdfPlansFailed(): void;
    /** See PdfLabelState. */
    pdfLabelState(): PdfLabelState;
    /** Writes step 2's words again in the page language now (see the top of this file: nothing is rebuilt). */
    relabel(): void;
    /** Shows or hides every rebuilt card in the list now, as `rebuiltShown` says (after the switch changed). */
    refreshRebuilt(): void;
}

/** One block of a shown body, as built (to update its label in place). */
interface BuiltBlock
{
    readonly start: number;
    readonly end: number;
    readonly details: HTMLDetailsElement | null;
    /** A folded block's <summary> (where the focus goes after a redraw, see drawBlocks); null for shown text. */
    readonly summary: HTMLElement | null;
    /** The block's own elements in the body (to find the block the focus is in). */
    readonly nodes: readonly HTMLElement[];
    /** The PDF label element (a folded block always has one, hidden when there is no label). */
    readonly label: HTMLElement | null;
    /** The PDF label shown in `label` (to write it again in another language). */
    pdf: PdfLabel | null;
    /** A folded block's "what" line ("Quoted text, 12 lines, ...") and the block it describes; null for shown text. */
    readonly what: { readonly element: HTMLSpanElement; readonly block: DisplayBlock } | null;
}

/**
 * Where the keyboard focus was before a redraw: the text range of its block
 * (null: in the body, but in no known block), and whether the focused
 * element could be seen in the window.
 */
interface FocusSpot
{
    readonly range: { readonly start: number; readonly end: number } | null;
    readonly wasVisible: boolean;
}

/** One email's body in the page, redrawn when its PDF plan changes. */
interface BodySlot
{
    readonly email: AnalyzedMessage;
    readonly position: number;
    readonly positionByIndex: readonly (number | null)[];
    readonly body: HTMLDivElement;
    readonly note: HTMLParagraphElement;
    /** viewKey of the view drawn. */
    key: string;
    /** The blocks' places and kinds (see shapeOf). */
    shape: string;
    blocks: BuiltBlock[];
    /** What `note` says: a PDF note's code, 'failed' (pdf.messageFailed) or null (empty). */
    noteCode: PdfNoteCode | 'failed' | null;
    /** The "(no text)" note of a body without blocks, or "Not in the PDF: this email has no text." (task 8.14), else null. */
    empty: HTMLParagraphElement | null;
}

/** One email's item in the page (not a stand-in): what relabel() writes again. */
interface ItemSlot
{
    readonly email: AnalyzedMessage;
    readonly number: HTMLSpanElement;
    /** The "(no subject)" placeholder, or null when the email has a subject (shown as it is). */
    readonly noSubject: HTMLSpanElement | null;
    readonly meta: HTMLDListElement;
    readonly date: DateSlot;
    /** Its attached-email links (list numbers), for its details list. */
    readonly links: ItemLinks;
}

/** A rebuilt card's date element, rewritten when the language changes. */
interface RebuiltDateSlot
{
    readonly time: HTMLTimeElement;
    readonly asWritten: HTMLSpanElement;
    readonly date: RebuiltDate;
}

/** One rebuilt card in the page (not a stand-in): what relabel() writes again. */
interface RebuiltSlot
{
    readonly card: RebuiltCard;
    readonly label: HTMLSpanElement;
    /** The "(subject not in the quote)" placeholder, or null when the quote has a subject. */
    readonly noSubject: HTMLSpanElement | null;
    readonly note: HTMLParagraphElement;
    /** "Same quoted text also in ...", or null when no other email quotes it. */
    readonly also: HTMLParagraphElement | null;
    readonly meta: HTMLDListElement;
    readonly date: RebuiltDateSlot;
    /** The "(no text)" note of an empty text (or "Not in the PDF: this email has no text.", see `noText`), else null. */
    readonly empty: HTMLParagraphElement | null;
    /** Its rebuilt text has no text, so the PDF leaves it out (task 8.14, Source/web-page-logic/no-printable-text.ts). */
    readonly noText: boolean;
    /** Its body with signature folds (task 9.9b-2), or null: the text is one shown block. */
    readonly body: RebuiltBody | null;
}

/** A rebuilt card's body with folds (task 9.9b-2), redrawn when its PDF plan changes (drawRebuiltBody). */
interface RebuiltBody
{
    readonly id: number;
    readonly text: string;
    readonly segments: readonly Segment[];
    /** The card's message-body element. */
    readonly element: HTMLDivElement;
    /** The note under the text ("(no text)" and the like), or null. */
    readonly tail: HTMLParagraphElement | null;
    readonly positionByIndex: readonly (number | null)[];
    blocks: BuiltBlock[];
    /** As BodySlot.shape and BodySlot.key. */
    shape: string;
    key: string;
}

/**
 * The signature folds of a rebuilt card's text (AnalyzedRebuiltMessage.segments, task 9.9b-2), or
 * null when there is none or they are not a valid cover of the text (data from a worker: then the
 * text is shown as one block, as before; when unsure, show).
 */
export function rebuiltFolds(text: string, segments: readonly Segment[] | undefined): readonly Segment[] | null
{
    // A plain boolean check: Array.isArray as a type guard would turn the list into any[].
    const isList: boolean = Array.isArray(segments);
    if (!isList || segments === undefined || !segments.some((s) => s.folded))
    {
        return null;
    }
    return checkSegments(text, segments).length === 0 && joinSegments(text, segments) === text ? segments : null;
}

/** A rebuilt card's stand-in: its own words. */
interface RebuiltStandIn
{
    readonly label: HTMLSpanElement;
    readonly failedNote: HTMLParagraphElement;
}

/** A stand-in's own notes (see fallbackItemOf). */
interface StandIn
{
    readonly number: HTMLSpanElement;
    readonly failedNote: HTMLParagraphElement;
    readonly pdfNote: HTMLParagraphElement;
}

/** The shape of a body not drawn yet (never a real shape, so its first update draws). */
const NOT_DRAWN = 'not drawn yet';

/** Where the blocks are and which of them carry a label element: equal shapes can be updated in place. */
function shapeOf(blocks: readonly LabeledBlock[]): string
{
    return blocks.map((b) => `${String(b.block.start)}:${String(b.block.end)}:${b.block.folded ? 'f' : b.label === null ? 's' : 'l'}`).join(',');
}

/**
 * The note of a body: "Not in the PDF: this email has no text." for an email
 * the PDF leaves out because it has no text (task 8.14,
 * Source/web-page-logic/no-printable-text.ts), else "(no text)" (an empty body that stays in
 * the PDF: its text could not be read).
 */
function emptyKey(noText: boolean): 'preview.notInPdfNoText' | 'preview.noText'
{
    return noText ? 'preview.notInPdfNoText' : 'preview.noText';
}

/** Sets a block's PDF label: its element's text and state (hidden without a label). */
function setBlockLabel(block: BuiltBlock, label: PdfLabel | null): void
{
    block.pdf = label;
    if (block.label !== null)
    {
        applyLabel(block.label, label);
    }
}

/** Sets a PDF label element's text and state (hidden without a label). */
function applyLabel(element: HTMLElement, label: PdfLabel | null): void
{
    // The trailing space keeps the label and the fold's own text apart when read as one line.
    element.textContent = label === null ? '' : `${pdfLabelText(label)} `;
    setSafeAttribute(element, 'data-pdf', label === null ? false : label.status);
    setSafeAttribute(element, 'hidden', label === null);
}

/** One email's date element, rewritten when the language changes. */
interface DateSlot
{
    readonly time: HTMLTimeElement;
    /** The date as written, under a date that could not be read (hidden otherwise). */
    readonly asWritten: HTMLSpanElement;
    readonly date: EmailDate;
}

/** One "label: value" row of an email's details. */
function row(name: string, label: string, value: readonly (Node | string)[]): Node[]
{
    return [createSafeElement('dt', { attrs: { class: `meta-${name}` }, text: label }), createSafeElement('dd', { attrs: { class: `meta-${name}` }, children: value })];
}

/** "email #2" or "emails #2, #5": the value of an "Attached to" row; '' if none. */
export function attachedToText(numbers: readonly number[]): string
{
    if (numbers.length === 0)
    {
        return '';
    }
    const list = joinList(numbers.map(messageNumberText));
    return numbers.length === 1 ? t('preview.attachedToOne', { list }) : t('preview.attachedToMany', { list });
}

/** "#4, #6": the value of an "Attached emails" row; '' if none. */
export function attachedEmailsText(numbers: readonly number[]): string
{
    return numbers.length === 0 ? '' : joinList(numbers.map(messageNumberText));
}

/** The file chain of one merged copy for the "Also in" row (the PDF File row's own text, Source/web-page-logic/file-chain.ts). */
export function alsoInText(result: Pick<ThreadAnalysisResult, 'attached' | 'counts'>, copy: MergedCopy): string
{
    return fileChain(result, copy.index, copy.source.fileName, {
        noFileName: t('added.noName'),
        attachedNoName: (number) => t('pdf.document.attachedNoName', { number: String(number) }),
    }).text;
}

/**
 * The rows of an email's details list, in the page language: date (with
 * the given date elements, which are kept across a language change), shown
 * author, recipients, attachments, the emails attached to it and the ones
 * it is attached to (`links`, task 8.13b-4; plain list numbers), and the
 * files it was also found in (each copy's chain, as in the PDF's File row).
 */
function metaRows(email: AnalyzedMessage, date: DateSlot, result: ThreadAnalysisResult | null, links: ItemLinks): Node[]
{
    const message = email.message;
    const author = displayAuthor(message);
    const meta: Node[] = [
        ...row('date', t('preview.date'), [date.time, ' ', date.asWritten]),
        ...(author.source === 'none'
            ? row('author', t('preview.from'), [createSafeElement('span', { attrs: { class: 'placeholder' }, text: t('preview.author.none') })])
            : row('author', t(`preview.author.${author.source}`), [mailboxListText(author.mailboxes)])),
    ];
    for (const [name, label, mailboxes] of [
        ['to', t('preview.to'), message.to],
        ['cc', t('preview.cc'), message.cc],
        ['bcc', t('preview.bcc'), message.bcc],
    ] as const)
    {
        const text = mailboxListText(mailboxes);
        if (text !== '')
        {
            meta.push(...row(name, label, [text]));
        }
    }
    if (message.attachments.length > 0)
    {
        const items = message.attachments.map((a) => createSafeElement('li', { attrs: { class: 'attachment' }, text: attachmentText(a) }));
        meta.push(...row('attachments', t('preview.attachments'), [createSafeElement('ul', { attrs: { class: 'attachment-list' }, children: items })]));
    }
    if (links.attachedEmails.length > 0)
    {
        meta.push(...row('attached-emails', t('preview.attachedEmails'), [attachedEmailsText(links.attachedEmails)]));
    }
    if (links.attachedTo.length > 0)
    {
        meta.push(...row('attached-to', t('preview.attachedTo'), [attachedToText(links.attachedTo)]));
    }
    if (email.duplicates.length > 0)
    {
        // Without a result (not expected) the chain cannot be worked out: the file names alone, as before.
        const names = email.duplicates.map((d) =>
            result === null ? (d.source.fileName.trim() === '' ? t('added.noName') : d.source.fileName) : alsoInText(result, d),
        );
        meta.push(...row('also-in', t('preview.alsoIn'), [joinPlain(names)]));
    }
    return meta;
}

/** The attached-email links of one email (see Source/web-page-logic/attached-links.ts). */
interface ItemLinks
{
    readonly attachedTo: readonly number[];
    readonly attachedEmails: readonly number[];
}

const NO_LINKS: ItemLinks = { attachedTo: [], attachedEmails: [] };

/** One rebuilt card's date element texts. */
function applyRebuiltDate(slot: RebuiltDateSlot): void
{
    const texts = rebuiltDateTexts(slot.date);
    slot.time.textContent = texts.main;
    setSafeAttribute(slot.time, 'datetime', texts.iso ?? false);
    slot.asWritten.textContent = texts.asWritten ?? '';
    setSafeAttribute(slot.asWritten, 'hidden', texts.asWritten === null);
}

/** A To / Cc row of a rebuilt card: the list, and "(list may be incomplete)" when it may go on; none when empty and complete. */
function rebuiltListRow(name: 'to' | 'cc', label: string, list: readonly EmailAddress[], incomplete: boolean): Node[]
{
    const text = mailboxListText(list);
    if (text === '' && !incomplete)
    {
        return [];
    }
    const value: (Node | string)[] = text === '' ? [] : [text];
    if (incomplete)
    {
        if (text !== '')
        {
            value.push(' ');
        }
        value.push(createSafeElement('span', { attrs: { class: 'placeholder list-incomplete' }, text: t('rebuilt.listIncomplete') }));
    }
    return row(name, label, value);
}

/**
 * The rows of a rebuilt card's details list, in the page language: date
 * (with the given date elements), sender (or "Unknown sender"), To, Cc, and
 * the email it was taken from.
 */
function rebuiltMetaRows(card: RebuiltCard, date: RebuiltDateSlot): Node[]
{
    if (card.sourceNumber === null)
    {
        throw new Error('rebuilt email without a source'); // a stand-in is shown instead
    }
    return [
        ...row('date', t('preview.date'), [date.time, ' ', date.asWritten]),
        ...(card.from.length === 0
            ? row('author', t('preview.from'), [createSafeElement('span', { attrs: { class: 'placeholder' }, text: t('preview.author.none') })])
            : row('author', t('preview.author.from'), [mailboxListText(card.from)])),
        ...rebuiltListRow('to', t('preview.to'), card.to, card.toIncomplete),
        ...rebuiltListRow('cc', t('preview.cc'), card.cc, card.ccIncomplete),
        ...row('source', t('rebuilt.takenFrom'), [t('rebuilt.takenFromValue', { number: messageNumberText(card.sourceNumber) })]),
    ];
}

/** Builds step 2 inside shell.checkArea. */
export function mountPreview(shell: Pick<PageShell, 'checkArea'>, options: PreviewOptions = {}): Preview
{
    const chunkSize = Math.max(1, options.chunkSize ?? DEFAULT_CHUNK_SIZE);
    const schedule = options.schedule ?? ((task: () => void): unknown => setTimeout(task, 0));
    const cancel = options.cancel ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));

    // --- State (memory only, README.md, rule R5) ------------------------------
    let showFolded = false;
    let slots: DateSlot[] = [];
    let folds = new Set<HTMLDetailsElement>();
    let pending: { handle: unknown } | null = null;
    // Increased by each show() and reset(): a chunk of an older list does nothing.
    let generation = 0;
    // The result shown (null when the list is empty).
    let currentResult: ThreadAnalysisResult | null = null;
    // The attached-email links of the result shown (task 8.13b-4), worked out once per result; null: none.
    let currentLinks: AttachedLinks | null = null;
    // The bodies built so far, by list position.
    let bodies = new Map<number, BodySlot>();
    // The items built so far (not stand-ins), by list position.
    let itemSlots = new Map<number, ItemSlot>();
    // The notes of the stand-ins in the page, by list position.
    let standIns = new Map<number, StandIn>();
    // The rebuilt cards built so far (not stand-ins), and the rebuilt stand-ins, by rebuilt id.
    let rebuiltSlots = new Map<number, RebuiltSlot>();
    let rebuiltStandIns = new Map<number, RebuiltStandIn>();
    // Every rebuilt card in the list, decorated or a stand-in (shown or hidden together, see refreshRebuilt).
    let rebuiltCards: HTMLLIElement[] = [];
    // The PDF plans in use (null: none, or being worked out again), and their state.
    let pdfPlans: PreviewPdfPlans | null = null;
    let pdfState: PdfLabelState = 'off';
    let pdfPending: { handle: unknown } | null = null;
    // Increased by each setPdfPlans() and clear(): a chunk of older plans does nothing.
    let pdfGeneration = 0;

    // --- Toolbar --------------------------------------------------------------
    const labels = createStaticLabels();
    const foldToggle = createSafeElement('input', { attrs: { type: 'checkbox', id: 'preview-show-folded' } });
    const toolbar = createSafeElement('div', {
        attrs: { id: 'preview-toolbar', class: 'preview-toolbar' },
        children: [
            createSafeElement('div', {
                attrs: { class: 'field field-checkbox' },
                children: [foldToggle, labels.text(createSafeElement('label', { attrs: { for: 'preview-show-folded' } }), 'preview.showFolded')],
            }),
            ...(options.toolbarItems ?? []),
        ],
    });
    // Not a live region: the labels it stands for are hidden meanwhile, so nothing wrong can be read.
    // Shown (with or without text) whenever a list is shown, and one line high
    // even when empty (app.css): ticking an email never moves the list below.
    const pdfStatus = createSafeElement('p', { attrs: { id: 'pdf-labels-status', class: 'note pdf-labels-status', hidden: true } });
    toolbar.append(pdfStatus);

    // role="list": some screen readers drop the list role when the numbers are hidden by CSS.
    const list = labels.attr(createSafeElement('ol', { attrs: { id: 'preview-list', class: 'message-list', role: 'list' } }), 'aria-label', 'preview.listLabel');
    shell.checkArea.replaceChildren(...(options.header ?? []), toolbar, list);

    /**
     * Shows the PDF label state on the list (app.css hides every label unless
     * 'ready') and in the status line. The line is hidden only when no email
     * is shown (it changes with the list itself, never on a tick); otherwise it
     * keeps its place and only its text changes, so the list does not move.
     */
    function setPdfState(state: PdfLabelState): void
    {
        pdfState = state;
        setSafeAttribute(list, 'data-pdf-labels', state);
        pdfStatus.textContent = state === 'updating' ? t('pdf.updating') : state === 'failed' ? t('pdf.failed') : '';
        setSafeAttribute(pdfStatus, 'hidden', currentResult === null || currentResult.messages.length === 0);
    }
    setPdfState('off');

    // --- Building one email ---------------------------------------------------
    function applyDate(slot: DateSlot): void
    {
        const texts = dateTexts(slot.date);
        slot.time.textContent = texts.main;
        setSafeAttribute(slot.time, 'datetime', texts.iso ?? false);
        // One line under the date: the date as written, when it could not be read.
        slot.asWritten.textContent = texts.asWritten ?? '';
        setSafeAttribute(slot.asWritten, 'hidden', texts.asWritten === null);
    }

    /** The attached-email links of the email at `position` in the result shown. */
    function linksOf(position: number): ItemLinks
    {
        if (currentLinks === null)
        {
            return NO_LINKS;
        }
        return { attachedTo: currentLinks.attachedTo[position] ?? [], attachedEmails: currentLinks.attachedEmails[position] ?? [] };
    }

    /** The PDF view of one email under the plans in use; null: no labels (not in the PDF, or no plans). */
    function viewFor(position: number): PdfView | null
    {
        if (pdfPlans === null || pdfPlans.result !== currentResult)
        {
            return null;
        }
        return pdfPlans.views.get(position) ?? null;
    }

    /**
     * Where the keyboard focus is in a body about to be redrawn: the range of
     * the block it is in (null if it is in the body but in no known block),
     * and whether the focused element could be seen (any part of it in the
     * window); or null if the focus is not in this body's blocks at all (it is
     * then never moved). The body element itself is not redrawn, so focus on
     * it is null.
     */
    function focusSpotIn(slot: BodySlot): FocusSpot | null
    {
        const active = document.activeElement;
        if (active === null || active === slot.body || !slot.body.contains(active))
        {
            return null;
        }
        const block = slot.blocks.find((b) => b.nodes.some((n) => n.contains(active)));
        const rect = active.getBoundingClientRect();
        return {
            range: block === undefined ? null : { start: block.start, end: block.end },
            wasVisible: rect.bottom > 0 && rect.top < window.innerHeight,
        };
    }

    /**
     * Puts the focus back after a redraw took the focused element away (WCAG
     * 2.4.3 focus order): on the summary of the first new folded block that
     * overlaps the old block's text, else on the body itself (made focusable
     * only for this, until the focus leaves it). Never on <body>, at the top of
     * the page.
     * Scrolling (WCAG 2.4.7 / 2.4.11, focus visible and not hidden): after a
     * cut, the new summary starts where the old block started, but after a
     * merge ([a,m] + [m,b] into [a,b]) it starts at `a`, which can be far above
     * the window when the first fold was open. So the focus moves without
     * scrolling (preventScroll), then the new summary is scrolled into view
     * (only as far as needed) if the old focused element could be seen and the
     * new summary cannot be seen in full. A reader who scrolled away while the
     * focus stayed behind (a mouse click on a summary, then the wheel) is not
     * pulled back.
     */
    function restoreFocus(slot: BodySlot, spot: FocusSpot): void
    {
        const range = spot.range;
        const target = range === null ? undefined : slot.blocks.find((b) => b.summary !== null && b.start < range.end && range.start < b.end);
        if (target?.summary)
        {
            target.summary.focus({ preventScroll: true });
            if (spot.wasVisible)
            {
                const rect = target.summary.getBoundingClientRect();
                if (rect.top < 0 || rect.bottom > window.innerHeight)
                {
                    target.summary.scrollIntoView({ block: 'nearest' });
                }
            }
            return;
        }
        // (If "Clear everything" removes this body before the focus leaves it,
        // its tabindex="-1" stays on an element no longer in the page: harmless.)
        setSafeAttribute(slot.body, 'tabindex', '-1');
        slot.body.addEventListener('blur', () => setSafeAttribute(slot.body, 'tabindex', false), { once: true });
        slot.body.focus({ preventScroll: true });
    }

    /**
     * Draws the blocks of a body (all of it). A new folded block is open when
     * "show quoted text" is ticked, or when a block it overlaps was open in
     * the body drawn before (`wasOpen`), so redrawing never closes what the
     * reader opened. If the keyboard focus was in one of the old blocks (a
     * fold's summary), it is put back on the matching new one (restoreFocus);
     * focus anywhere else is left alone.
     */
    function drawBlocks(slot: BodySlot, blocks: readonly LabeledBlock[], wasOpen: readonly { start: number; end: number }[]): void
    {
        const focusSpot = focusSpotIn(slot);
        const { built, children } = blockNodes(blocks, wasOpen, slot.position, slot.positionByIndex);
        // An email with no text (task 8.14): "Not in the PDF: this email has no text." instead of "(no text)",
        // also under a body of white space only (its blank block stays: nothing is ever dropped from the page).
        const noText = hasNoPrintableText(slot.email.message);
        const empty = noText || blocks.length === 0 ? createSafeElement('p', { attrs: { class: 'note body-empty' }, text: t(emptyKey(noText)) }) : null;
        if (empty !== null)
        {
            children.push(empty);
        }
        slot.body.replaceChildren(...children);
        slot.empty = empty;
        // Recorded only once in the page: a build that threw above leaves nothing behind.
        swapFolds(slot.blocks, built);
        slot.blocks = built;
        if (focusSpot !== null)
        {
            restoreFocus(slot, focusSpot);
        }
    }

    /**
     * The elements of a body's blocks (see drawBlocks), and the blocks as built. A folded block is open
     * when "show folded text" is ticked or it overlaps a block in `wasOpen`. `position` and
     * `positionByIndex`: for the fold's "from email #N" (foldSummaryText).
     */
    function blockNodes(blocks: readonly LabeledBlock[], wasOpen: readonly { start: number; end: number }[], position: number,
        positionByIndex: readonly (number | null)[]): { readonly built: BuiltBlock[]; readonly children: Node[] }
    {
        const built: BuiltBlock[] = [];
        const children: Node[] = [];
        for (const { block, label } of blocks)
        {
            if (!block.folded)
            {
                const text = createSafeElement('div', { attrs: { class: 'body-text' }, text: block.text });
                if (label === null)
                {
                    children.push(text);
                    built.push({ start: block.start, end: block.end, details: null, summary: null, nodes: [text], label: null, pdf: null, what: null });
                    continue;
                }
                // Shown text the PDF leaves out (by the plan: a bug, never expected;
                // or printed as an email of its own, task 8.11): said all the same.
                const mark = createSafeElement('p', { attrs: { class: 'pdf-label pdf-label-shown' } });
                applyLabel(mark, label);
                children.push(mark, text);
                built.push({ start: block.start, end: block.end, details: null, summary: null, nodes: [mark, text], label: mark, pdf: label, what: null });
                continue;
            }
            const mark = createSafeElement('span', { attrs: { class: 'pdf-label' } });
            applyLabel(mark, label);
            const open = showFolded || wasOpen.some((o) => o.start < block.end && block.start < o.end);
            const what = createSafeElement('span', { attrs: { class: 'fold-what' }, text: foldSummaryText(block, position, positionByIndex) });
            const summary = createSafeElement('summary', { attrs: { class: 'fold-label' }, children: [mark, what] });
            const details = createSafeElement('details', {
                attrs: { class: 'fold', open },
                children: [summary, createSafeElement('div', { attrs: { class: 'body-text body-folded' }, text: block.text })],
            });
            children.push(details);
            built.push({ start: block.start, end: block.end, details, summary, nodes: [details], label: mark, pdf: label, what: { element: what, block } });
        }
        return { built, children };
    }

    /** The folds the "show folded text" checkbox opens and closes: those of `old` out, those of `built` in. */
    function swapFolds(old: readonly BuiltBlock[], built: readonly BuiltBlock[]): void
    {
        for (const builtBlock of old)
        {
            if (builtBlock.details !== null)
            {
                folds.delete(builtBlock.details);
            }
        }
        for (const builtBlock of built)
        {
            if (builtBlock.details !== null)
            {
                folds.add(builtBlock.details);
            }
        }
    }

    /** Brings one body up to date with the plans in use: labels in place when the blocks stay the same, else redrawn. */
    function updateBody(slot: BodySlot): void
    {
        // An email with no text is never in the PDF (task 8.14): no PDF labels and no PDF note, ticked or not;
        // its body says so instead (drawBlocks).
        const view = hasNoPrintableText(slot.email.message) ? null : viewFor(slot.position);
        // Left out of the PDF (unticked): what was drawn stays, its labels and
        // note hidden (see `data-pdf-out` at the top of this file).
        const out = view === null && pdfPlans !== null && slot.shape !== NOT_DRAWN;
        setSafeAttribute(slot.body, 'data-pdf-out', out);
        setSafeAttribute(slot.note, 'data-pdf-out', out);
        if (out)
        {
            return;
        }
        const key = viewKey(view);
        if (key === slot.key)
        {
            return;
        }
        const email = slot.email;
        const blocks = pdfBlocks(email.message.bodyText, email.segments, view);
        const shape = shapeOf(blocks);
        if (shape === slot.shape)
        {
            blocks.forEach((pdfBlock, i) =>
            {
                const built = slot.blocks[i];
                if (built !== undefined)
                {
                    setBlockLabel(built, pdfBlock.label);
                }
            });
        }
        else
        {
            const wasOpen = slot.blocks.filter((b) => b.details?.hasAttribute('open') === true);
            drawBlocks(slot, blocks, wasOpen);
            slot.shape = shape;
        }
        // Parts printed as emails of their own (task 8.11, S1): the note does not say "the whole email".
        // Task 9.9e: an email all of whose text is printed as other emails is left out of the PDF, and the note says so.
        const note = view === null ? null : pdfPlanNote(view.plan, printedAsEmailOfItsOwn(view, email.message.bodyText), view.printedAllElsewhere === true);
        slot.noteCode = note;
        writeNote(slot);
        setSafeAttribute(slot.note, 'hidden', note === null);
        slot.key = key;
    }

    /** A body's PDF note, in the page language (see BodySlot.noteCode). */
    function writeNote(slot: BodySlot): void
    {
        const code = slot.noteCode;
        slot.note.textContent = code === null ? '' : code === 'failed' ? t('pdf.messageFailed') : t(`review.pdfNote.${code}`);
    }

    /** An email's body, with its PDF note (placed just above the body, outside the email's text). */
    function bodyOf(email: AnalyzedMessage, position: number, positionByIndex: readonly (number | null)[]): BodySlot
    {
        const slot: BodySlot = {
            email: email,
            position,
            positionByIndex,
            body: createSafeElement('div', { attrs: { class: 'message-body' } }),
            note: createSafeElement('p', { attrs: { class: 'note pdf-note', hidden: true } }),
            key: '',
            shape: NOT_DRAWN, // never a real shape, so the first update draws
            blocks: [],
            noteCode: null,
            empty: null,
        };
        updateBody(slot);
        bodies.set(position, slot);
        return slot;
    }

    function itemOf(email: AnalyzedMessage, position: number, result: ThreadAnalysisResult): HTMLLIElement
    {
        const message = email.message;
        const hasSubject = message.subject.trim() !== '';
        const number = createSafeElement('span', { attrs: { class: 'message-number' }, text: messageNumberText(position + 1) });
        const subject = createSafeElement('span', {
            attrs: { class: hasSubject ? 'message-subject' : 'message-subject placeholder' },
            text: hasSubject ? message.subject : t('preview.noSubject'),
        });
        const heading = createSafeElement('h3', {
            attrs: { id: headingId(position), class: 'message-heading' },
            children: [number, ' ', subject],
        });

        const time = createSafeElement('time', { attrs: { class: 'message-date' } });
        const asWritten = createSafeElement('span', { attrs: { class: 'date-as-written' } });
        const slot: DateSlot = { time, asWritten, date: message.date };
        applyDate(slot);
        slots.push(slot);

        const links = linksOf(position);
        const meta = createSafeElement('dl', { attrs: { class: 'message-meta' }, children: metaRows(email, slot, result, links) });
        const body = bodyOf(email, position, result.positionByIndex);
        const item = createSafeElement('li', {
            attrs: { class: 'message', 'data-position': String(position) },
            children: [heading, meta, body.note, body.body],
        });
        options.decorate?.(item, email, position, result);
        // Recorded last: an item whose decoration threw is not in the page (safeItemOf).
        itemSlots.set(position, { email: email, number, noSubject: hasSubject ? null : subject, meta, date: slot, links });
        return item;
    }

    /**
     * Stand-in for an email whose item could not be built (a bug, or a
     * `decorate` hook that failed): its number, a calm note and its whole text
     * unfolded, so no email is ever silently missing from the list (README.md,
     * rule R6). Built from the plainest parts only. See decoratedFallbackOf
     * for the `decorate` hook.
     */
    function fallbackItemOf(email: AnalyzedMessage | undefined, position: number): HTMLLIElement
    {
        const text = typeof email?.message?.bodyText === 'string' ? email.message.bodyText : '';
        // Its text is shown whole, without PDF labels: when the email is in the
        // PDF, a note says so (hidden while the labels are, see app.css).
        const pdfNote = createSafeElement('p', { attrs: { class: 'note pdf-note', hidden: true }, text: t('pdf.messageFailed') });
        updateStandIn(position, pdfNote);
        const number = createSafeElement('span', { attrs: { class: 'message-number' }, text: messageNumberText(position + 1) });
        const failedNote = createSafeElement('p', { attrs: { class: 'note message-failed-note' }, text: t('preview.itemFailed') });
        // The last stand-in built for a position is the one in the page (see decoratedFallbackOf).
        standIns.set(position, { number, failedNote, pdfNote });
        return createSafeElement('li', {
            attrs: { class: 'message message-failed', 'data-position': String(position) },
            children: [
                createSafeElement('h3', {
                    attrs: { id: headingId(position), class: 'message-heading' },
                    children: [number],
                }),
                failedNote,
                pdfNote,
                createSafeElement('div', { attrs: { class: 'message-body' }, children: text === '' ? [] : [createSafeElement('div', { attrs: { class: 'body-text' }, text })] }),
            ],
        });
    }

    /**
     * The stand-in, passed to `decorate` too, so what later tasks add to each
     * item (warnings, include/exclude) covers every email, this one included.
     * If `decorate` fails again, a fresh, undecorated stand-in is used, so a
     * half-done decoration never reaches the page. Without a message (only a
     * bug can cause that) there is nothing to hand to `decorate`.
     */
    function decoratedFallbackOf(email: AnalyzedMessage | undefined, position: number, result: ThreadAnalysisResult): HTMLLIElement
    {
        const item = fallbackItemOf(email, position);
        if (email === undefined || options.decorate === undefined)
        {
            return item;
        }
        try
        {
            options.decorate(item, email, position, result);
            return item;
        }
        catch
        {
            return fallbackItemOf(email, position);
        }
    }

    /** One email's item, or its stand-in if building it failed. Never throws for one bad email. */
    function safeItemOf(email: AnalyzedMessage | undefined, position: number, result: ThreadAnalysisResult): HTMLLIElement
    {
        const slotCount = slots.length;
        try
        {
            if (email === undefined)
            {
                throw new Error('missing message');
            }
            return itemOf(email, position, result);
        }
        catch
        {
            // Forget the half-built item's dates, body and folds: they are not in the page.
            slots.length = slotCount;
            const body = bodies.get(position);
            if (body !== undefined)
            {
                for (const builtBlock of body.blocks)
                {
                    if (builtBlock.details !== null)
                    {
                        folds.delete(builtBlock.details);
                    }
                }
            }
            bodies.delete(position);
            itemSlots.delete(position);
            return decoratedFallbackOf(email, position, result);
        }
    }

    // --- Building one rebuilt email (see the top of this file) ---------------
    function rebuiltLabel(): HTMLSpanElement
    {
        return createSafeElement('span', { attrs: { class: 'rebuilt-label' }, text: t('rebuilt.label') });
    }

    function rebuiltItemOf(rebuiltEmail: AnalyzedRebuiltMessage, result: ThreadAnalysisResult): HTMLLIElement
    {
        const card = rebuiltCard(rebuiltEmail, result);
        const label = rebuiltLabel();
        const hasSubject = card.subject !== null;
        const subject = createSafeElement('span', {
            attrs: { class: hasSubject ? 'message-subject' : 'message-subject placeholder' },
            text: card.subject ?? t('rebuilt.noSubject'),
        });
        const heading = createSafeElement('h3', { attrs: { id: rebuiltHeadingId(rebuiltEmail.id), class: 'message-heading' }, children: [label, ' ', subject] });
        const note = createSafeElement('p', { attrs: { class: 'note rebuilt-note' }, text: rebuiltNoteText(card) });
        const alsoText = rebuiltAlsoText(card.alsoNumbers);
        const also = alsoText === '' ? null : createSafeElement('p', { attrs: { class: 'note rebuilt-also' }, text: alsoText });
        const date: RebuiltDateSlot = {
            time: createSafeElement('time', { attrs: { class: 'message-date' } }),
            asWritten: createSafeElement('span', { attrs: { class: 'date-as-written' } }),
            date: card.date,
        };
        applyRebuiltDate(date);
        const meta = createSafeElement('dl', { attrs: { class: 'message-meta' }, children: rebuiltMetaRows(card, date) });
        // The rebuilt text, as text; "(no text)" if there is none. A rebuilt email with no text
        // (task 8.14, Q4) says "Not in the PDF: this email has no text." instead, under its text when that is
        // white space only (shown all the same: nothing is ever dropped from the page). Its signature
        // folds (task 9.9b-2, AnalyzedRebuiltMessage.segments) are folded blocks with their PDF labels,
        // as in a real email's body (drawRebuiltBody); without folds the text is one block, as before.
        const noText = rebuiltHasNoPrintableText(rebuiltEmail);
        const empty = noText || card.text === '' ? createSafeElement('p', { attrs: { class: 'note body-empty' }, text: t(emptyKey(noText)) }) : null;
        const segments = card.text === '' ? null : rebuiltFolds(card.text, rebuiltEmail.segments);
        const text = card.text === '' || segments !== null ? null : createSafeElement('div', { attrs: { class: 'body-text' }, text: card.text });
        const body = createSafeElement('div', {
            attrs: { class: 'message-body' },
            children: [...(text === null ? [] : [text]), ...(empty === null ? [] : [empty])],
        });
        const foldedBody: RebuiltBody | null = segments === null ? null
            : { id: rebuiltEmail.id, text: card.text, segments, element: body, tail: empty, positionByIndex: result.positionByIndex,
                blocks: [], shape: NOT_DRAWN, key: NOT_DRAWN };
        if (foldedBody !== null)
        {
            drawRebuiltBody(foldedBody);
        }
        const item = createSafeElement('li', {
            attrs: { class: 'message message-rebuilt', 'data-rebuilt-id': String(rebuiltEmail.id) },
            children: [heading, note, ...(also === null ? [] : [also]), meta, body],
        });
        options.decorateRebuilt?.(item, rebuiltEmail, result);
        // Recorded last: a card whose decoration threw is not in the page (safeRebuiltItemOf).
        rebuiltSlots.set(rebuiltEmail.id, { card, label, noSubject: hasSubject ? null : subject, note, also, meta, date, empty, noText, body: foldedBody });
        return item;
    }

    /** The PDF view of a rebuilt card's own text under the plans in use (task 9.9b-2); null: no labels (not in the PDF, or no plans). */
    function rebuiltViewFor(id: number): PdfView | null
    {
        if (pdfPlans === null || pdfPlans.result !== currentResult)
        {
            return null;
        }
        return pdfPlans.rebuiltViews?.get(id) ?? null;
    }

    /**
     * Brings a rebuilt card's folded body up to date with the plans in use (task 9.9b-2), like
     * updateBody for a real email: labels changed in place when the blocks stay the same, else the
     * body is drawn again (the folds the reader opened stay open). Left out of the PDF (unticked):
     * what was drawn stays, its labels hidden (`data-pdf-out`, as for a real email), so the cards
     * below do not move; a card drawn while left out simply has no labels.
     */
    function drawRebuiltBody(rebuiltBody: RebuiltBody): void
    {
        const view = rebuiltViewFor(rebuiltBody.id);
        const out = view === null && pdfPlans !== null && rebuiltBody.shape !== NOT_DRAWN;
        setSafeAttribute(rebuiltBody.element, 'data-pdf-out', out);
        if (out)
        {
            return;
        }
        const key = viewKey(view);
        if (key === rebuiltBody.key)
        {
            return;
        }
        const blocks = pdfBlocks(rebuiltBody.text, rebuiltBody.segments, view);
        const shape = shapeOf(blocks);
        if (shape === rebuiltBody.shape)
        {
            blocks.forEach((pdfBlock, i) =>
            {
                const built = rebuiltBody.blocks[i];
                if (built !== undefined)
                {
                    setBlockLabel(built, pdfBlock.label);
                }
            });
        }
        else
        {
            const wasOpen = rebuiltBody.blocks.filter((b) => b.details?.hasAttribute('open') === true);
            const { built, children } = blockNodes(blocks, wasOpen, -1, rebuiltBody.positionByIndex);
            rebuiltBody.element.replaceChildren(...children, ...(rebuiltBody.tail === null ? [] : [rebuiltBody.tail]));
            swapFolds(rebuiltBody.blocks, built);
            rebuiltBody.blocks = built;
            rebuiltBody.shape = shape;
        }
        rebuiltBody.key = key;
    }

    /** drawRebuiltBody for every rebuilt card with folds, never throwing (a card that fails keeps what it shows). */
    function updateRebuiltBodies(): void
    {
        for (const slot of rebuiltSlots.values())
        {
            if (slot.body === null)
            {
                continue;
            }
            try
            {
                drawRebuiltBody(slot.body);
            }
            catch
            {
                // Not expected. Its text stays in the page; its labels are hidden (never a stale one).
                for (const builtBlock of slot.body.blocks)
                {
                    setBlockLabel(builtBlock, null);
                }
                slot.body.key = NOT_DRAWN;
            }
        }
    }

    /** A rebuilt card's stand-in: its label, a calm note and its text (the text is in its source email's card anyway). */
    function rebuiltFallbackOf(rebuiltEmail: AnalyzedRebuiltMessage | undefined, id: number): HTMLLIElement
    {
        const text = typeof rebuiltEmail?.rebuilt?.reconstructedText === 'string' ? rebuiltEmail.rebuilt.reconstructedText : '';
        const label = rebuiltLabel();
        const failedNote = createSafeElement('p', { attrs: { class: 'note message-failed-note' }, text: t('rebuilt.itemFailed') });
        rebuiltStandIns.set(id, { label, failedNote });
        return createSafeElement('li', {
            attrs: { class: 'message message-rebuilt message-failed', 'data-rebuilt-id': String(id) },
            children: [
                createSafeElement('h3', { attrs: { id: rebuiltHeadingId(id), class: 'message-heading' }, children: [label] }),
                failedNote,
                createSafeElement('div', { attrs: { class: 'message-body' }, children: text === '' ? [] : [createSafeElement('div', { attrs: { class: 'body-text' }, text })] }),
            ],
        });
    }

    /** A rebuilt card, or its stand-in (decorated if possible, as for real emails). Never throws for one bad card. */
    function safeRebuiltItemOf(rebuiltEmail: AnalyzedRebuiltMessage | undefined, id: number, result: ThreadAnalysisResult): HTMLLIElement
    {
        try
        {
            if (rebuiltEmail === undefined)
            {
                throw new Error('missing rebuilt email');
            }
            return rebuiltItemOf(rebuiltEmail, result);
        }
        catch
        {
            rebuiltSlots.delete(id);
            const item = rebuiltFallbackOf(rebuiltEmail, id);
            if (rebuiltEmail === undefined || options.decorateRebuilt === undefined)
            {
                return item;
            }
            try
            {
                options.decorateRebuilt(item, rebuiltEmail, result);
                return item;
            }
            catch
            {
                return rebuiltFallbackOf(rebuiltEmail, id);
            }
        }
    }

    /** The `rebuiltShown` option now (shown by default, and if it throws: never hidden by mistake). */
    function rebuiltShownNow(): boolean
    {
        try
        {
            return options.rebuiltShown?.() ?? true;
        }
        catch
        {
            return true;
        }
    }

    /** Shows or hides every rebuilt card in the list (decorated or stand-in), as `rebuiltShown` says. */
    function refreshRebuilt(): void
    {
        const shown = rebuiltShownNow();
        for (const card of rebuiltCards)
        {
            setSafeAttribute(card, 'hidden', !shown);
        }
    }

    // --- Chunked building -----------------------------------------------------
    function stopPending(): void
    {
        if (pending !== null)
        {
            cancel(pending.handle);
        }
        pending = null;
        setSafeAttribute(list, 'aria-busy', false);
    }

    function stopPdfPending(): void
    {
        if (pdfPending !== null)
        {
            cancel(pdfPending.handle);
        }
        pdfPending = null;
    }

    function clear(): void
    {
        stopPending();
        stopPdfPending();
        generation++;
        pdfGeneration++;
        slots = [];
        folds = new Set();
        bodies = new Map();
        itemSlots = new Map();
        standIns = new Map();
        rebuiltSlots = new Map();
        rebuiltStandIns = new Map();
        rebuiltCards = [];
        currentResult = null;
        currentLinks = null;
        pdfPlans = null;
        setPdfState('off');
        list.replaceChildren();
    }

    /**
     * updateBody, never throwing: on a failure that email's labels are hidden
     * (never a stale one), its note says the labels could not be shown (so
     * the preview never silently says nothing), and it is tried again next time.
     */
    function safeUpdateBody(slot: BodySlot): void
    {
        try
        {
            updateBody(slot);
        }
        catch
        {
            for (const builtBlock of slot.blocks)
            {
                setBlockLabel(builtBlock, null);
            }
            slot.noteCode = 'failed';
            writeNote(slot);
            setSafeAttribute(slot.note, 'hidden', false);
            slot.key = 'failed';
        }
    }

    /** A stand-in's PDF note: shown when its email is in the PDF plans (its text is shown whole, unlabelled). */
    function updateStandIn(position: number, note: HTMLParagraphElement): void
    {
        setSafeAttribute(note, 'hidden', viewFor(position) === null);
    }

    function setPdfPlans(plans: PreviewPdfPlans | null): void
    {
        stopPdfPending();
        pdfGeneration++;
        if (plans === null || currentResult === null || plans.result !== currentResult)
        {
            // Hidden at once; the bodies keep their old labels until new plans come.
            pdfPlans = null;
            setPdfState(currentResult === null ? 'off' : 'updating');
            return;
        }
        pdfPlans = plans;
        setPdfState('updating');
        // Rebuilt cards with folds (task 9.9b-2) are few and small: updated at once.
        updateRebuiltBodies();
        // Stand-ins are few (only a bug makes one) and cheap: updated at once.
        for (const [position, standIn] of standIns)
        {
            updateStandIn(position, standIn.pdfNote);
        }
        const myGeneration = pdfGeneration;
        // The bodies built so far; those built later get the new labels as they are built.
        const todo = [...bodies.values()];
        let next = 0;
        const applyChunk = (): void =>
        {
            if (myGeneration !== pdfGeneration)
            {
                return; // newer plans, or clear(), came meanwhile
            }
            pdfPending = null;
            let chars = 0;
            const first = next;
            const stop = Math.min(todo.length, next + chunkSize * PDF_CHUNK_FACTOR);
            while (next < stop && (next === first || chars < MAX_CHUNK_CHARS))
            {
                const slot = todo[next];
                next++;
                if (slot === undefined)
                {
                    continue;
                }
                safeUpdateBody(slot);
                chars += slot.email.message.bodyText.length;
            }
            if (next < todo.length)
            {
                pdfPending = { handle: schedule(applyChunk) };
            }
            else
            {
                setPdfState('ready');
            }
        };
        applyChunk();
    }

    function show(result: ThreadAnalysisResult): void
    {
        clear();
        currentResult = result;
        try
        {
            currentLinks = attachedLinks(result);
        }
        catch
        {
            currentLinks = null; // not expected: no attached rows rather than wrong ones
        }
        setPdfState(pdfState); // the status line takes its place now, before any tick
        const myGeneration = generation;
        const messages = result.messages;
        // The timeline: the real emails in list order, rebuilt ones in between (Source/web-page-logic/rebuilt-email-display.ts).
        let order: PreviewSlot[];
        try
        {
            order = previewOrder(result);
        }
        catch
        {
            order = messages.map((_, position) => ({ kind: 'message', position })); // not expected
        }
        let next = 0;
        const buildChunk = (): void =>
        {
            if (myGeneration !== generation)
            {
                return; // a newer list or reset() came meanwhile
            }
            pending = null;
            const items: HTMLLIElement[] = [];
            let chars = 0;
            try
            {
                while (next < order.length && items.length < chunkSize && (items.length === 0 || chars < MAX_CHUNK_CHARS))
                {
                    const slot = order[next] as PreviewSlot;
                    next++; // moved on first: an email is never tried twice
                    if (slot.kind === 'rebuilt')
                    {
                        const rebuiltEmail = result.reconstructed[slot.id];
                        const card = safeRebuiltItemOf(rebuiltEmail, slot.id, result);
                        rebuiltCards.push(card);
                        // Switch off: hidden too, even a stand-in the review never saw.
                        if (!rebuiltShownNow())
                        {
                            setSafeAttribute(card, 'hidden', true);
                        }
                        items.push(card);
                        const text = rebuiltEmail?.rebuilt?.reconstructedText;
                        chars += typeof text === 'string' ? text.length : 0;
                        continue;
                    }
                    const email = messages[slot.position];
                    items.push(safeItemOf(email, slot.position, result));
                    const body = email?.message?.bodyText;
                    chars += typeof body === 'string' ? body.length : 0;
                }
            }
            finally
            {
                // Whatever happened above, what was built is shown and the rest of
                // the list is still scheduled: no email is silently left out.
                list.append(...items);
                if (next < order.length)
                {
                    setSafeAttribute(list, 'aria-busy', 'true');
                    pending = { handle: schedule(buildChunk) };
                }
                else
                {
                    setSafeAttribute(list, 'aria-busy', false);
                    try
                    {
                        options.onRendered?.(result);
                    }
                    catch
                    {
                        // The list is complete either way.
                    }
                }
            }
        };
        buildChunk();
    }

    // --- Language change ------------------------------------------------------
    /**
     * Writes every word of ours again in the page language, in place (see the
     * top of this file). The <dl> of each email is refilled (it holds nothing
     * focusable); its date elements are kept and rewritten. Bodies are never
     * redrawn: only their fold "what" lines, PDF labels and notes change.
     */
    function relabel(): void
    {
        labels.relabel();
        setPdfState(pdfState);
        for (const [position, item] of itemSlots)
        {
            item.number.textContent = messageNumberText(position + 1);
            if (item.noSubject !== null)
            {
                item.noSubject.textContent = t('preview.noSubject');
            }
            try
            {
                item.meta.replaceChildren(...metaRows(item.email, item.date, currentResult, item.links));
            }
            catch
            {
                // Not expected (the same rows were built once): this email keeps its details as they were;
                // swallowed so one bad email never stops the rest of the page from being relabelled.
            }
        }
        for (const slot of slots)
        {
            applyDate(slot);
        }
        for (const slot of bodies.values())
        {
            for (const builtBlock of slot.blocks)
            {
                try
                {
                    if (builtBlock.what !== null)
                    {
                        builtBlock.what.element.textContent = foldSummaryText(builtBlock.what.block, slot.position, slot.positionByIndex);
                    }
                    if (builtBlock.label !== null)
                    {
                        applyLabel(builtBlock.label, builtBlock.pdf);
                    }
                }
                catch
                {
                    // Not expected (the same texts were made once): this block keeps its words as they were;
                    // swallowed so one bad block never stops the rest of the page from being relabelled.
                }
            }
            if (slot.empty !== null)
            {
                slot.empty.textContent = t(emptyKey(hasNoPrintableText(slot.email.message)));
            }
            writeNote(slot);
        }
        for (const [position, standIn] of standIns)
        {
            standIn.number.textContent = messageNumberText(position + 1);
            standIn.failedNote.textContent = t('preview.itemFailed');
            standIn.pdfNote.textContent = t('pdf.messageFailed');
        }
        for (const slot of rebuiltSlots.values())
        {
            try
            {
                slot.label.textContent = t('rebuilt.label');
                if (slot.noSubject !== null)
                {
                    slot.noSubject.textContent = t('rebuilt.noSubject');
                }
                slot.note.textContent = rebuiltNoteText(slot.card);
                if (slot.also !== null)
                {
                    slot.also.textContent = rebuiltAlsoText(slot.card.alsoNumbers);
                }
                slot.meta.replaceChildren(...rebuiltMetaRows(slot.card, slot.date));
                applyRebuiltDate(slot.date);
                for (const builtBlock of slot.body?.blocks ?? [])
                {
                    if (builtBlock.what !== null)
                    {
                        builtBlock.what.element.textContent = foldSummaryText(builtBlock.what.block, -1, slot.body?.positionByIndex ?? []);
                    }
                    if (builtBlock.label !== null)
                    {
                        applyLabel(builtBlock.label, builtBlock.pdf);
                    }
                }
                if (slot.empty !== null)
                {
                    slot.empty.textContent = t(emptyKey(slot.noText));
                }
            }
            catch
            {
                // Not expected (the same texts were made once): this card keeps its words as they were;
                // swallowed so one bad card never stops the rest of the page from being relabelled.
            }
        }
        for (const standIn of rebuiltStandIns.values())
        {
            standIn.label.textContent = t('rebuilt.label');
            standIn.failedNote.textContent = t('rebuilt.itemFailed');
        }
    }

    // --- Controls -------------------------------------------------------------
    foldToggle.addEventListener('change', () =>
    {
        showFolded = foldToggle.checked;
        for (const details of folds)
        {
            setSafeAttribute(details, 'open', showFolded);
        }
    });

    return {
        show,
        showResult(result)
        {
            if (result.ok)
            {
                show(result.threadAnalysis);
            }
            else
            {
                clear();
            }
        },
        reset()
        {
            clear();
            // Back to the start: the next person or batch begins from the defaults.
            showFolded = false;
            foldToggle.checked = false;
        },
        isRendering: () => pending !== null,
        setPdfPlans,
        pdfPlansFailed()
        {
            stopPdfPending();
            pdfGeneration++;
            pdfPlans = null;
            setPdfState(currentResult === null ? 'off' : 'failed');
        },
        pdfLabelState: () => pdfState,
        relabel,
        refreshRebuilt,
    };
}
