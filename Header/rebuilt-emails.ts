// Header: earlier emails rebuilt from quoted text, and where they fit in the
// timeline. Shared types only, no code (README.md, "Where things are").
// thread-analysis/ (reconstruct-quoted-messages, quoted-date, link-rebuilt-messages) produces them as
// part of ThreadAnalysisResult; web-page-logic/, web-page/ and pdf-export/ show and print them.

import type { EmailAddress } from './parsed-email';

/** One message rebuilt from quoted text, with its links. Plain data. */
export interface AnalyzedRebuiltMessage
{
    /** Its position in ThreadAnalysisResult.reconstructed. */
    readonly id: number;
    /** Input position of the email whose body quotes it (offsets in `rebuilt` are into that body). */
    readonly sourceIndex: number;
    /** As reconstructQuotedMessages returned it (incomplete fields, date, text, offsets). */
    readonly rebuilt: ReconstructedMessage;
    readonly link: RebuiltLink;
    /** link 'real': input position of the real message. */
    readonly realIndex: number | null;
    /** link 'real': the evidence. */
    readonly match: RealMatch | null;
    /** link 'same-as': id of the entry with the same quoted text. */
    readonly sameAs: number | null;
    /** link 'entry': ids of the other copies of the same quoted text, ascending. */
    readonly copies: readonly number[];
    /** link 'entry': input positions of the other emails that quote the same text, ascending, unique. */
    readonly alsoQuotedIn: readonly number[];
}

export type TimelineEntry =
    /** A real message: `position` in ThreadAnalysisResult.messages. */
    | { readonly kind: 'message'; readonly position: number }
    /** A rebuilt message: `id` in ThreadAnalysisResult.reconstructed (always link 'entry'). */
    | { readonly kind: 'rebuilt'; readonly id: number; readonly placement: RebuiltPlacement };

/**
 * - 'real': corresponds to a real dropped message (`realIndex`): no entry.
 * - 'same-as': the same quoted text as rebuilt message `sameAs` (an entry): no entry.
 * - 'entry': its own timeline entry.
 */
export type RebuiltLink = 'real' | 'same-as' | 'entry';

/** Why a link to a real message was made. */
export interface RealMatch
{
    /** Share of the rebuilt text's words in the words compared with the real message's own text (file comment, 1c). */
    readonly coverage: number;
    /** Share of the real message's own text's words in the words compared. */
    readonly reverseCoverage: number;
    /** Real date minus the rebuilt (estimated) date, milliseconds. */
    readonly dateDiffMs: number;
    /** The dates agree 'exact' or 'strong' (the 50% thresholds applied). */
    readonly strong: boolean;
    /** The quoted date is ambiguous (day and month could be swapped); one of its readings agreed (ambiguousReadings). */
    readonly ambiguousDate: boolean;
}

/**
 * Where a rebuilt entry was placed: by its own date, at its quoter's date
 * because its own estimate was later, or just before its quoter (no
 * readable date).
 */
export type RebuiltPlacement = 'by-date' | 'capped-by-quoter' | 'after-quoted' | 'before-quoter';

/** One earlier message rebuilt from quoted text. NOT a real message: it has no source file and no hash. */
export interface ReconstructedMessage
{
    /** Offset of the header's first line in the source body (quote marks included). */
    readonly start: number;
    /** End of the header's own lines, line break included (readQuotedHeader). [start, headerEnd) is the raw header text. */
    readonly headerEnd: number;
    /** End of the message's part: the next rebuilt header's start, or the end of the quoted history. */
    readonly end: number;
    /** Number of ">" levels of the body (removed from each line of reconstructedText). */
    readonly depth: number;
    /** 1 = the message the source replied to or forwarded, 2 = the one before, ... */
    readonly generation: number;
    /** As findReplyHeaders reports it. */
    readonly kind: 'reply' | 'forward';
    readonly from: readonly EmailAddress[];
    readonly to: readonly EmailAddress[];
    readonly cc: readonly EmailAddress[];
    /**
     * The subject its header holds. An attribution never holds one: it gets the subject of the
     * nearest newer header in the chain that has one, else the dropped email's own
     * (subjectFromChain). null = none known.
     */
    readonly subject: string | null;
    /**
     * The subject was taken from the chain (an attribution: user decision F3, task 9.9a). Shown
     * as it is, NOT marked as borrowed; only the linking reads it (it is not a field of this copy).
     */
    readonly subjectFromChain: boolean;
    /** The date as written, or null. */
    readonly dateText: string | null;
    /** To / Cc lists that may go on past what was read (quoted-header.ts). */
    readonly incomplete: readonly ('to' | 'cc')[];
    /** The date read from dateText (null when there is none; wallMs null when unreadable). */
    readonly date: QuotedDate | null;
    /** True unless the date carries its own zone (an RFC 5322 or a written offset): then the moment is exact. */
    readonly dateApproximate: boolean;
    /** Body [headerEnd, end) with `depth` quote marks and their indentation removed per line (file comment, step 4). */
    readonly reconstructedText: string;
    /** depth > 0: the text differs from the source slice by its quote marks and their indentation (show RECONSTRUCTED_FORM_NOTE). */
    readonly quoteMarksRemoved: boolean;
    /**
     * Its part holds no text line (only blank lines and quote marks): a header followed directly
     * by the next header (user decision F2, task 9.9a). Still rebuilt, so the chain goes on; the
     * PDF leaves it out, as any rebuilt email with no text (task 8.14).
     */
    readonly noOwnText: boolean;
}

export interface QuotedDate
{
    /** The date text as given. */
    readonly text: string;
    /** The wall-clock time as written, as if it were UTC (milliseconds); null = unreadable. */
    readonly wallMs: number | null;
    /** 'minute' when a time is written, 'day' for a date alone (wallMs is then midnight); null = unreadable. */
    readonly precision: 'minute' | 'day' | null;
    /** Best estimate of the true moment (milliseconds since the epoch, UTC); null = unreadable. */
    readonly estimatedUtcMs: number | null;
    readonly basis: QuotedDateBasis;
}

/**
 * How `estimatedUtcMs` was obtained.
 * - 'rfc-zone': an RFC 5322 date with its zone (exact).
 * - 'written-zone': another form with a written offset, e.g. "GMT+9" (exact).
 * - 'source-offset': no zone written; read in the dropped email's zone (approximate).
 * - 'none': no zone written and the dropped email's zone unknown, or the
 *   zone written as "-0000" (UTC, local zone unknown): wall time taken as
 *   UTC (approximate). Also the basis of an unreadable date.
 */
export type QuotedDateBasis = 'rfc-zone' | 'written-zone' | 'source-offset' | 'none';
