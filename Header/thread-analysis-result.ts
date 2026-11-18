// Header: the thread analysis result (duplicates, order, folded parts,
// warnings). Shared types only, no code (README.md, "Where things are").
// thread-analysis/ (engine.ts, runEngine) produces EngineResult; it crosses
// the engine worker (engine-worker-messages.ts) and is read by web-page-logic/,
// web-page/ and pdf-export/.

import type { NormalizedMessage, ParseErrorCode, ParseWarning } from './parsed-email';
import type { EngineRebuilt, TimelineEntry } from './rebuilt-emails';

/**
 * Something that went wrong while rebuilding messages from the quoted text
 * of one kept message (step 6). Kept apart from EngineWarningCode: the real
 * message itself is not affected (its segments are the same), and the
 * preview does not show these yet (task 7.6).
 * - 'reconstruct-failed': rebuilding threw or returned something invalid,
 *   so nothing was rebuilt from this message (or, if linking failed, from
 *   any message).
 * - 'reconstruct-limit': the body is longer than MAX_SOURCE_LENGTH (nothing
 *   rebuilt) or MAX_RECONSTRUCTED messages were rebuilt (there may be more).
 */
export type ReconstructionWarningCode = 'reconstruct-failed' | 'reconstruct-limit';

/** Something the engine itself had to work around for one message. */
export type EngineWarningCode =
    // A fold detector threw an error for this message; its folds were skipped
    // (the other detectors' folds still apply).
    | 'detector-failed'
    // The folds could not be turned into a valid cover of the body (or building
    // the segments threw), so all of them were dropped and the whole body is
    // shown unfolded.
    | 'folding-disabled'
    // De-duplication threw or returned an inconsistent result, so no message
    // was merged (every message is kept on its own).
    | 'dedupe-failed';

/** One kept message, ready for the preview. */
export interface EngineMessage
{
    /** The kept copy, unchanged (same object as in the input). */
    readonly message: NormalizedMessage;
    /** Its position in the input of `runEngine`. */
    readonly index: number;
    /**
     * Placed by its date; or, date missing or unusable, after all dated
     * messages by file order, or (an attached email) just before the email it
     * is attached to ('before-parent').
     */
    readonly order: OrderReason;
    /** Merged copies (see dedupe.ts), `index` = position in the input of `runEngine`. */
    readonly duplicates: readonly MergedCopy[];
    /** Why look-alike messages were NOT merged (see dedupe.ts), `related` = input positions. */
    readonly dedupeWarnings: readonly DedupeWarning[];
    /** The parser's warnings (same array as `message.warnings`), here for convenience. */
    readonly parserWarnings: readonly ParseWarning[];
    /** See EngineWarningCode; sorted, unique; usually empty. */
    readonly engineWarnings: readonly EngineWarningCode[];
    /** Cover of `message.bodyText`, shown or folded (see segments.ts). [] for an empty body. */
    readonly segments: readonly Segment[];
}

/** A file that could not be read. */
export interface FailedFile
{
    /** Its position in the input of `runEngine`. */
    readonly index: number;
    readonly fileName: string;
    readonly sha256: string | null;
    readonly error: ParseErrorCode;
    readonly detail: string;
}

/** The numbers the preview shows. */
export interface EngineCounts
{
    /** Every file given to the engine, read or failed (preview: "N files, M could not be read"). */
    readonly filesGiven: number;
    /** Messages read successfully, duplicates and attached emails (task 8.13b-3) included. */
    readonly messagesFound: number;
    /** Copies merged into another message (messagesFound - messages.length). */
    readonly duplicatesMerged: number;
    /** Files that could not be read (listed in `failed`). */
    readonly filesFailed: number;
    /** Kept messages with no usable date (placed by file order, or before their parent). */
    readonly undated: number;
    /** Kept messages with at least one folded segment. */
    readonly withFolds: number;
}

export interface ReconstructionWarning
{
    /** Input position of the kept message (EngineMessage.index). */
    readonly index: number;
    readonly code: ReconstructionWarningCode;
}

/** One email attached inside a dropped file (ParseResult.attached), as the engine numbers it. */
export interface EngineAttached
{
    /** Its input position (see Indices at the top). */
    readonly index: number;
    /** Input position of the email it is attached to: its file's own email, or another attached email of that file. */
    readonly parentIndex: number;
    /** Input position of the dropped file it came from (that file's own email). */
    readonly fileIndex: number;
    /** AttachedMessage.path: its attachment number at each level, from the file's own email down. */
    readonly path: readonly number[];
    /** The attachment name at each level of `path` (AttachedMessage.name of it and of each attached email above it), '' when none. */
    readonly names: readonly string[];
    /** AttachedMessage.places that are valid ranges of their holder's body, nearest holder first; [] when its text is in no body. */
    readonly places: readonly EngineAttachedPlace[];
    /**
     * Whether the header rows of the kept copy holding it show every header
     * datum its own copy has: true when it is kept itself, or when the copy it
     * was merged into keeps its header data with the same date (dedupe.ts,
     * keepsHeaderData). False when a dropped file's copy was kept although
     * this copy held more (a Bcc line, a date: D2, task 8.13b-3 review round
     * 4); then its block's header lines stay printed in the emails holding it.
     */
    readonly keptShowsHeader: boolean;
}

/** Where one attached email's printed block sits in the body of an email holding it (AttachedPlace, with input positions). */
export interface EngineAttachedPlace
{
    /**
     * Input position of the email whose bodyText holds the block: its parent,
     * or the parent's parent, ...; or, when that one was merged into another
     * copy (dedupe.ts), the kept copy, with the offsets found again in its
     * body (task 8.13b-3, review round 4, S1: settleAttached). When they
     * cannot be found for certain there, the place stays on the merged copy
     * (then no kept message has this index, and the PDF leaves the kept
     * body as its plan says).
     */
    readonly holderIndex: number;
    /** `bodyText.slice(start, end)` of the message at `holderIndex` (that very message object) is the whole block. */
    readonly start: number;
    readonly end: number;
}

/** The whole engine output: plain, structured-clone-safe data. */
export interface EngineResult
{
    /** Kept messages, in chronological order. */
    readonly messages: readonly EngineMessage[];
    /** Failed files, in input order. */
    readonly failed: readonly FailedFile[];
    readonly counts: EngineCounts;
    /**
     * For each input position: the position in `messages` of the kept message
     * that holds it (the message itself, or the one it was merged into); null
     * for a failed file. Use it to resolve `index` and `related` numbers.
     */
    readonly positionByIndex: readonly (number | null)[];
    /**
     * Messages rebuilt from quoted text (step 6), by source (in `messages`
     * order), newest first; each says whether it is linked to a real message,
     * the same as another rebuilt one, or its own timeline entry. The preview
     * shows the entries (Source/web-page-logic/rebuilt-email-display.ts), and so does the PDF
     * (Source/pdf-export/model.ts, the ones the reader chose).
     */
    readonly reconstructed: readonly EngineRebuilt[];
    /** Every kept message (each once, in `messages` order) and every rebuilt entry, in time order (rebuild-links.ts). */
    readonly timeline: readonly TimelineEntry[];
    /** Problems while rebuilding, in `messages` order. Usually empty. */
    readonly reconstructionWarnings: readonly ReconstructionWarning[];
    /**
     * Every email attached inside a dropped file that the engine read as a
     * message of its own (task 8.13b-3), by input position: entry k has
     * index `counts.filesGiven + k`. No key at all when there are none, so
     * the result for files without attached emails is what it always was.
     */
    readonly attached?: readonly EngineAttached[];
}

/** Why the engine did NOT merge messages that look alike. Shown in the preview. */
export type DedupeWarningCode =
    // Another message has the same Message-ID but a different body, subject,
    // attachment names or From list, or only one of them has a body-missing
    // parser warning (rule 4). Merging would lose text, so both are kept.
    | 'same-id-different-content'
    // Another message has the same Message-ID and content, but the dates are
    // more than DATE_TOLERANCE_MS apart; or one copy has no date and the dated
    // copy lacks other header data the undated one has (e.g. a Bcc line), so
    // keeping either would lose the date or that data.
    | 'duplicate-date-differs'
    // Another message is identical except that neither copy's To/Cc/Bcc covers
    // the other's (e.g. Carol is in Cc in one copy and in Bcc in the other).
    | 'duplicate-recipients-differ'
    // Another message is identical except for the "sent on behalf of" sender
    // (both have one, and they differ), or the copy with more recipients is
    // the one without a sender, so no single copy holds all the header data.
    | 'duplicate-sender-differs'
    // Another message is identical except for the threading headers: the
    // In-Reply-To ids differ, neither References list holds the other, or the
    // copy with more threading data lacks other header data.
    | 'duplicate-threading-differs'
    // This message is a duplicate of a message in another group, but not of
    // every member of that group, so it could not join it (see `dedupe`).
    | 'possible-duplicate-not-merged';

/** One copy that was merged into a kept message. */
export interface MergedCopy
{
    /** The copy's file name, SHA-256 and format, for the PDF cover page. */
    readonly source: NormalizedMessage['source'];
    /** Position of the copy in the input array. */
    readonly index: number;
    /** Which rule matched between this copy and the kept message. */
    readonly rule: DuplicateRule;
}

/** Which rule proved that a merged copy is the same message as the kept one. */
export type DuplicateRule = 'message-id' | 'author-date-body';

/** One engine warning, with the other messages it is about. */
export interface DedupeWarning
{
    readonly code: DedupeWarningCode;
    /**
     * Input positions of the other messages involved, ascending, without
     * repeats: at most MAX_RELATED of them, the lowest positions first.
     */
    readonly related: readonly number[];
    /**
     * How many other messages are involved in total (at least `related.length`),
     * so the preview can say "and N more" when the list was cut.
     */
    readonly relatedTotal: number;
}

/** Why an entry is where it is. */
export type OrderReason =
    | 'by-date' // placed by its date (utcMs)
    | 'file-order' // no usable date: placed after all dated messages, in input order
    // No usable date, and attached inside another email: placed just before the
    // email it is attached to (user decision 2026-11-10, Q7, task 8.13b-3). Set
    // by the engine (Source/thread-analysis/engine.ts, placeUndatedAttached), never by
    // orderMessages.
    | 'before-parent';

/**
 * Why a part of a body is folded. Extensible: new detectors add a value here
 * (and to FOLD_REASONS in Source/thread-analysis/segments.ts).
 * - 'quoted-overlap': text that also appears in another message of the
 *   thread (typically the history below a reply). `related` names it.
 * - 'quote-marker': lines starting with `>` (classic plain-text quoting).
 * - 'reply-header': a "On ... wrote:" / "Le ... a ecrit :" / "Op ... schreef"
 *   block, or an Outlook "From: / Sent: / To:" block, that introduces quoted text.
 * - 'signature': a signature or disclaimer block at the end of a message.
 */
export type FoldReason = 'quoted-overlap' | 'quote-marker' | 'reply-header' | 'signature';

/** One piece of the body: code units [start, end), shown or folded. */
export interface Segment
{
    readonly start: number;
    readonly end: number;
    /** True exactly when `reasons` is not empty. */
    readonly folded: boolean;
    /** Why it is folded: sorted (FOLD_REASONS order), unique; empty when shown. */
    readonly reasons: readonly FoldReason[];
    /** Linked message indices from the folds covering it: sorted ascending, unique; empty when shown. */
    readonly related: readonly number[];
}
