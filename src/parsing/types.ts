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
  | 'html-only-body' // no plain-text part: body text was converted from HTML
  | 'html-body-truncated' // the converted HTML text hit the length limit and was cut (a note line says so)
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
  readonly from: readonly EmailAddress[];
  readonly to: readonly EmailAddress[];
  readonly cc: readonly EmailAddress[];
  readonly subject: string;
  /** Plain-text body, never HTML (README.md, rule R4). */
  readonly bodyText: string;
  readonly attachments: readonly AttachmentInfo[];
  /** Which dropped file this came from, and the SHA-256 of that file's bytes (for the PDF cover page). */
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
  | 'corrupt'; // the parser library failed on it

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
