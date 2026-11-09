// The normalized message structure: the one shape every parser produces.
//
// Every parser (.eml, .msg, later maybe .mbox) turns its file into exactly
// this shape, so the rest of the tool (de-duplication, sorting, folding, PDF)
// never needs to know which library or file format a message came from.
//
// Everything is `readonly`: once parsed, a message is never modified. Later
// steps build new data next to it instead, which keeps the original text
// recoverable (README.md, rule R6: collapse, never delete).

/** One mailbox, e.g. `"Alice Example" <alice@example.test>`. Either part may be empty. */
export interface EmailAddress {
  readonly name: string;
  readonly address: string;
}

/** A Date header, kept in three forms. */
export interface EmailDate {
  /** The true moment in time, in milliseconds since 1970-01-01 UTC (for sorting). null if missing/unparseable. */
  readonly utcMs: number | null;
  /**
   * The date as text. For .eml: the Date header text exactly as found. For a
   * .msg date taken from a property (the file holds no date text): that
   * instant in ISO 8601 form, e.g. "2025-04-02T09:00:00.000Z". Empty string
   * if there was no date, or if a damaged .msg time property had no text to keep.
   */
  readonly original: string;
  /** The sender's time-zone offset from UTC in minutes (e.g. +0200 -> 120), null if unknown. */
  readonly offsetMinutes: number | null;
  /**
   * True only if the header named a real zone: a numeric offset other than
   * "-0000", or a recognized name (UT, UTC, GMT, Z, EST, PDT, ...). When false
   * but `utcMs` is set, the time was read as UTC for sorting only and may be
   * off by the sender's real offset; the preview must flag it.
   */
  readonly zoneKnown: boolean;
}

/** Attachment metadata only. Attachment contents are never opened or kept (README.md, rule R4). */
export interface AttachmentInfo {
  readonly fileName: string;
  /** Size in bytes, null if the format does not tell us. */
  readonly size: number | null;
  readonly mimeType: string;
}

/** Things the parser was unsure about. Shown as warnings in the preview; never fatal. */
export type ParseWarning =
  | 'missing-date' // no Date header at all
  | 'unparseable-date' // a Date header exists but could not be understood
  // Date was read, but its zone is missing, "-0000" or unknown, so it was read
  // as UTC and may be off by hours. Adapters (2.4/2.5) emit this when
  // `date.utcMs !== null && !date.zoneKnown`.
  | 'unknown-time-zone'
  | 'missing-message-id' // no Message-ID header (duplicate detection gets weaker)
  // Some or all of the body text was converted from HTML: an HTML part with no
  // plain-text version (.msg: the whole body; .eml: any HTML body part that
  // was used, e.g. an HTML-only message, or an HTML part next to a text part
  // in multipart/mixed, so the body may also hold plain text). The converted
  // text can differ from what the sender saw.
  | 'html-converted-body'
  | 'html-body-truncated' // the converted HTML text hit the length limit and was cut (a note line says so)
  // An HTML body part could not be converted (the converter failed on it, for
  // example a document nested too deeply). The rest of the message (headers,
  // other text parts, attachment list) is still read, but that part's text is
  // MISSING from bodyText: nothing is put in its place (no invented text). The
  // preview must say that part of the email could not be shown (README.md,
  // rule R6). The text stays in the original file.
  | 'html-body-unreadable'
  | 'rtf-only-body' // .msg with only an RTF body
  | 'no-body' // no body text found at all
  // A forwarded message whose text was not expanded (.eml: nested too deep or
  // unreadable; .msg: any attached Outlook item): listed as an attachment, not in bodyText.
  | 'forwarded-message-not-expanded';

/** One email in the normalized form. */
export interface NormalizedMessage {
  /**
   * Message-ID header, without the surrounding < >, trimmed.
   * `messageId`, `inReplyTo` and every `references` entry use this same form,
   * so all adapters must normalize them identically: threading and duplicate
   * detection compare these strings directly.
   */
  readonly messageId: string | null;
  /** In-Reply-To id, stored like `messageId`: without < >, trimmed. */
  readonly inReplyTo: string | null;
  /** References ids in header order, each stored like `messageId`: without < >, trimmed. */
  readonly references: readonly string[];
  readonly date: EmailDate;
  /**
   * The author(s): the From header (.eml), or the mailbox the message was
   * sent on behalf of (.msg: PidTagSentRepresenting*, else PidTagSender*).
   * [] if missing.
   */
  readonly from: readonly EmailAddress[];
  /**
   * The mailbox that actually sent the message, when it is not one of `from`
   * ("sent on behalf of": an assistant sending for a manager, a shared
   * mailbox, a list server). .eml: the first mailbox of the Sender header.
   * .msg: PidTagSender* when PidTagSentRepresenting* is a different mailbox.
   * Absent (no key at all) when the file has no such sender or it is the same
   * mailbox as one of `from` (same address, letter case ignored).
   */
  readonly sender?: EmailAddress;
  /** To recipients in file order, address groups flattened. [] if missing. */
  readonly to: readonly EmailAddress[];
  /** Cc recipients, like `to`. [] if missing. */
  readonly cc: readonly EmailAddress[];
  /**
   * Bcc recipients, like `to`. Usually only the sender's own copy has them
   * (.eml: Bcc header; .msg: recipients of type Bcc). [] if missing.
   */
  readonly bcc: readonly EmailAddress[];
  readonly subject: string;
  /**
   * Plain-text body, never HTML (README.md, rule R4). Line ends are LF only:
   * both adapters turn CRLF and lone CR into LF (src/parsing/line-endings.ts).
   */
  readonly bodyText: string;
  readonly attachments: readonly AttachmentInfo[];
  /** Which dropped file this came from, and the SHA-256 of that file's bytes (the app's key for the file: src/parsing/hash.ts; not printed in the PDF). */
  readonly source: {
    readonly fileName: string;
    readonly sha256: string;
    readonly kind: 'eml' | 'msg';
  };
  readonly warnings: readonly ParseWarning[];
}

/** Why a whole file could not be read. */
export type ParseErrorCode =
  | 'too-large' // over the size limit (README.md, rule R4: guard against huge files)
  | 'unsupported-type' // not an .eml/.msg file
  // The file itself could not be read: damaged, or the parser rejected it.
  // `detail` says what was wrong. (An HTML body the converter could not
  // handle is NOT a failed file: the message is read without it and gets the
  // 'html-body-unreadable' warning.)
  | 'corrupt'
  // Reading the file took longer than the time limit, so its worker was
  // stopped. Kept apart from 'corrupt' because a valid file on a slow
  // computer could hit it too: the preview must not call the file damaged,
  // only say it was stopped.
  | 'timeout'
  // The TOOL failed, not the file: its worker could not start or stopped
  // unexpectedly, the bytes had already been handed over to an earlier
  // worker, or an unexpected error (a bug). Reloading the page and adding
  // the file again is the honest advice.
  | 'tool-error'
  // The BROWSER could not open the file (moved, deleted or changed on disk
  // since it was chosen, or a folder in older browsers). Kept apart from
  // 'corrupt': nothing says the file is damaged; adding it again may work.
  | 'unreadable';

/**
 * The result of parsing one file. A "tagged union": check `ok` first, then
 * TypeScript knows which of the two shapes you have. A failed file never
 * throws, so one bad file cannot stop the others from loading.
 */
export type ParseResult =
  | { readonly ok: true; readonly message: NormalizedMessage }
  | {
      readonly ok: false;
      readonly fileName: string;
      /** null if the failure happened before hashing (e.g. the file was too large). */
      readonly sha256: string | null;
      readonly error: ParseErrorCode;
      /** Short technical detail for the preview's error list. */
      readonly detail: string;
    };

/** One dropped file, already read into memory. */
export interface InputFile {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/**
 * The seam around each parsing library: the
 * .eml and .msg adapters both implement this, so a library can be swapped
 * without touching the rest of the tool.
 */
export interface EmailParser {
  parse(file: InputFile): Promise<ParseResult>;
}
