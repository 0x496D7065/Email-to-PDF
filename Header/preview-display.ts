// Header: what the preview list shows of each email (author, notes, attached
// emails, rebuilt-email cards and their places). Shared types only, no code
// (README.md, "Where things are"). web-page-logic/ (display-author,
// message-notes, attached-links, rebuilt-email-display) computes it; web-page/ (preview,
// review) shows it; pdf-export/build-pdf-document.ts reads RebuiltInPdf.

import type { EmailAddress, ParseWarning } from './parsed-email';
import type { AnalyzedRebuiltMessage } from './rebuilt-emails';
import type { DedupeWarningCode, ThreadAnalysisWarningCode, ReconstructionWarningCode } from './thread-analysis-result';

/** Where the shown author comes from. */
export type AuthorSource =
    // The From mailboxes (the usual case).
    | 'from'
    // No usable From, but the message names the mailbox that actually sent it
    // (Sender header / .msg sender): shown instead, so the reader still sees who
    // sent it. The preview may label it, e.g. "sent by".
    | 'sender'
    // Neither: the preview shows an "unknown sender" marker.
    | 'none';

/** The unread-attached note of one email (see the top of Source/web-page-logic/attached-links.ts). */
export type UnreadAttachedCode = 'attached-unread' | 'attached-unread-inside';

export interface AttachedLinks
{
    /** By list position: the list numbers (1-based) of the emails it is attached to, ascending, unique; [] if none. */
    readonly attachedTo: readonly (readonly number[])[];
    /** By list position: the list numbers of the emails attached to it, ascending, unique; [] if none. */
    readonly attachedEmails: readonly (readonly number[])[];
    /** By list position: its unread-attached note, or null. */
    readonly unread: readonly (UnreadAttachedCode | null)[];
}

/** One note of one email. */
export type MessageNote =
    | { readonly kind: 'parse'; readonly code: ParseWarning }
    // No usable date: placed after the dated emails, in file order; or, an
    // attached email, just before the email it is attached to (task 8.13b-3, Q7).
    | { readonly kind: 'order'; readonly code: 'file-order' | 'before-parent' }
    | {
        readonly kind: 'dedupe';
        readonly code: DedupeWarningCode;
        /** The other emails' numbers in the list (1-based), ascending; never this email. */
        readonly related: readonly number[];
        /**
         * How many more FILES are involved but not listed (the thread analysis caps its
         * list). Files, not emails: several files can be one merged email,
         * possibly one already listed, so this is never worded as emails.
         */
        readonly more: number;
    }
    // 'engine' is the old name of thread analysis, kept because it is a translation key.
    | { readonly kind: 'engine'; readonly code: ThreadAnalysisWarningCode }
    // Some of its characters will show in the PDF as codes such as "[U+0000]" (task 8.8: said here, not in the PDF).
    | { readonly kind: 'chars'; readonly code: 'coded-characters' }
    // Earlier emails in its quote could not (all) be rebuilt; the quote itself is untouched.
    | { readonly kind: 'rebuild'; readonly code: ReconstructionWarningCode }
    // An email sent as an attachment, in it or in an email inside it, could not be read (task 8.13b-4, P3; Source/web-page-logic/attached-links.ts).
    | { readonly kind: 'attached'; readonly code: UnreadAttachedCode };

/** One place in the preview list: a real email (its list position) or a rebuilt entry (its id). */
export type PreviewSlot = { readonly kind: 'message'; readonly position: number } | { readonly kind: 'rebuilt'; readonly id: number };

/** One place the text of a rebuilt entry was read: the entry itself or one of its copies, and the list position of the email quoting it. */
export interface RebuiltSource
{
    readonly rebuilt: AnalyzedRebuiltMessage;
    readonly position: number;
}

/** Where a rebuilt entry in the PDF was taken from (rebuiltInPdf). */
export interface RebuiltInPdf
{
    /** The copy shown: the entry's own when its email is in the PDF, else the copy from the first such email. */
    readonly shown: RebuiltSource;
    /** The number (as given by `numberOf`) of the email `shown` was taken from. The PDF never prints it (task 8.3). */
    readonly number: number;
    /**
     * The numbers (as given by `numberOf`: the real-email rank from the PDF
     * model, the list number from the preview) of the OTHER emails in the PDF
     * quoting the same text, ascending, unique.
     */
    readonly also: readonly number[];
}

/**
 * A rebuilt message's date, as the card shows it: as written, never
 * converted to another time zone (user decision, task 9.9c). `utcMs` is the
 * estimated true moment (QuotedDate.estimatedUtcMs), for ordering only (the
 * PDF cover's first and last dates); it is never shown.
 */
export type RebuiltDate =
    /** The quoted header has no date. */
    | { readonly kind: 'none' }
    /** A date text that could not be read: shown as written only. */
    | { readonly kind: 'unreadable'; readonly text: string }
    /**
     * A date with a time: shown as its wall-clock time (`wallMs`, the time as
     * written read as if it were UTC). `writtenOffsetMinutes`: the zone the
     * date itself wrote (an RFC 5322 or a written offset), for <time datetime>
     * only; null when it wrote none. `approximate`: the moment `utcMs` is a
     * guess (no zone written), for the linking checks only: never shown.
     */
    | {
        readonly kind: 'moment';
        readonly utcMs: number;
        readonly wallMs: number;
        readonly writtenOffsetMinutes: number | null;
        readonly approximate: boolean;
        readonly text: string;
    }
    /** A day without a time: shown as written (YYYY-MM-DD). `utcMs`: the estimated start of that day (null: none), for ordering only. */
    | { readonly kind: 'day'; readonly day: string; readonly utcMs: number | null; readonly approximate: boolean; readonly text: string };

/** What a rebuilt card shows (no DOM; the words come from the strings module). */
export interface RebuiltCard
{
    readonly id: number;
    /** null: the quoted header has no subject (an "On ... wrote:" line never has one). */
    readonly subject: string | null;
    /** The sender's mailboxes, blank ones left out; [] = sender unknown. */
    readonly from: readonly EmailAddress[];
    readonly to: readonly EmailAddress[];
    readonly cc: readonly EmailAddress[];
    /** The To / Cc lists that may go on past what was read: "list may be incomplete". */
    readonly toIncomplete: boolean;
    readonly ccIncomplete: boolean;
    readonly date: RebuiltDate;
    /** The list number of the email it was taken from (null: unknown, not expected). */
    readonly sourceNumber: number | null;
    /** The other emails quoting the same text ("same quoted text also in email #K, #L"). */
    readonly alsoNumbers: readonly number[];
    /** Quote marks were removed from the text (the note says so). */
    readonly quoteMarksRemoved: boolean;
    /** The rebuilt text (shown as it is, as text). */
    readonly text: string;
}
