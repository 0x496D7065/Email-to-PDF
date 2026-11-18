// Header: the PDF's content before layout (cover, index, emails as lines of
// text with roles), its fixed texts, and the finished PDF. Shared types only,
// no code (README.md, "Where things are"). pdf-export/build-pdf-document.ts
// (buildPdfDocument) builds it; pdf-export/page-layout/ lays it out;
// web-page-logic/ reads the printed ranges for the preview;
// pdf-export/generate-pdf.ts returns GeneratedPdf to the PDF worker.

import type { PlanRange } from './output-plan';

/** A header row: a label and its value, one or more lines. */
export interface PdfFieldRow
{
    readonly label: string;
    readonly value: readonly PdfLine[];
}

/**
 * A piece of free-form content (the cover). The renderer lays out each kind
 * its own way; every text is in runs with a semantic role.
 * - 'heading': level 1 = the document title (role 'title'), level 2 = a section;
 * - 'fields': label/value rows (a small two-column table);
 * - 'paragraph': one line of text, wrapped;
 * - 'list': items, each one or more lines (each line wrapped on its own).
 */
export type PdfBlock =
    | { readonly kind: 'heading'; readonly level: 1 | 2; readonly line: PdfLine }
    | { readonly kind: 'fields'; readonly rows: readonly PdfFieldRow[] }
    | { readonly kind: 'paragraph'; readonly line: PdfLine }
    | { readonly kind: 'list'; readonly items: readonly (readonly PdfLine[])[] };

/** A distinct person of the included emails (From, Sender, To, Cc). */
export interface PdfParticipant
{
    readonly name: string;
    readonly address: string;
}

export interface PdfCover
{
    /** What the cover shows, in order. */
    readonly blocks: readonly PdfBlock[];
    /** The data behind it. Texts here are as found (not sanitized); the blocks hold the display form. */
    readonly dateRange: { readonly first: string; readonly last: string } | null;
    readonly undated: number;
    /** Every email in the PDF, rebuilt ones included (task 8.3); not those left out for having no text (task 8.14). */
    readonly emailCount: number;
    readonly generated: string;
    readonly participants: readonly PdfParticipant[];
}

/** One line of the index. The renderer adds the page of `anchor`. */
export interface PdfIndexEntry
{
    /** The email's PDF number (1..n over every email in the PDF, rebuilt ones included). */
    readonly number: number;
    /** True for an email rebuilt from quoted text (data only: the PDF never shows it, task 8.3). */
    readonly rebuilt: boolean;
    readonly anchor: string;
    readonly date: PdfLine;
    readonly from: PdfLine;
    readonly subject: PdfLine;
    readonly attachments: number;
    /** One line per attachment, the same lines as the email's own list (PdfEmail.attachments.items). */
    readonly attachmentLines: readonly PdfLine[];
    /** The email's bookmark title: one line, at most MAX_BOOKMARK_LENGTH characters (bookmarkTitle). */
    readonly bookmark: string;
}

export interface PdfIndex
{
    readonly heading: string;
    readonly columns: PdfStrings['columns'];
    readonly entries: readonly PdfIndexEntry[];
}

/** Facts about one email the renderer may want (all false / 0 usually). */
export interface PdfEmailFlags
{
    /** No usable date: shown with the "no date" text. */
    readonly undated: boolean;
    /** The sender's time zone is not known (the time may be off by hours). */
    readonly zoneUnknown: boolean;
    /** Plan rule 4: nothing would have been left, so the whole body is shown. */
    readonly keptAllBecauseEmpty: boolean;
    /** The plan failed, was missing or invalid: the whole body is shown. */
    readonly planFallback: boolean;
    /** Some text was converted from HTML (the layout may differ from what the sender saw). */
    readonly htmlConverted: boolean;
    /** Control or broken characters of this email shown as codes (Source/pdf-export/pdf-text-transforms.ts, group 1). */
    readonly controlChars: number;
    /** The no-repeat rule left out text of this body that the PDF prints as emails of their own (task 8.10; data only). */
    readonly printedElsewhere: boolean;
}

/** Where a rebuilt email in the PDF comes from (data only: the PDF never shows it, task 8.3). */
export interface PdfRebuiltInfo
{
    /** The entry's id in `result.reconstructed` (link 'entry'). */
    readonly id: number;
    /** The id of the copy shown: the entry, or a copy read from an email in the PDF (rebuiltInPdf). */
    readonly shownId: number;
    /** The list position of the email it was taken from (in the PDF). */
    readonly sourcePosition: number;
    /**
     * How many blocks of original header lines were moved to the top of its
     * text (task 8.13a, Q4: the quoted header lines its header rows cannot
     * show; NoRepeatResult.moved). 0 usually.
     */
    readonly movedHeaders: number;
}

export interface PdfEmail
{
    /** 1..n over every email in the PDF, in PDF order, rebuilt ones included (task 8.3). */
    readonly number: number;
    /** For links from the index (resolved by the renderer): emailAnchor(number). */
    readonly anchor: string;
    /** Its position in the engine's list (`result.messages`); null for a rebuilt email (see `rebuilt`). */
    readonly position: number | null;
    /** "Email 3", for a rebuilt email too. */
    readonly heading: string;
    /** null for a real email. */
    readonly rebuilt: PdfRebuiltInfo | null;
    /**
     * From, Sent by, To, Cc, Bcc (each when present), Date, Subject, File. A
     * rebuilt email: From, To, Cc (each when present), Date, Subject (no File
     * row: it has no file).
     */
    readonly fields: readonly PdfFieldRow[];
    /** Lines above the text (role 'muted'): only the "(no text)" placeholder of an empty text (task 8.8: the PDF has no notes; task 8.14: see NO-TEXT EMAILS at the top of Source/pdf-export/build-pdf-document.ts). */
    readonly notes: readonly PdfLine[];
    /** The text: one entry per line, [] for an empty line (see Source/pdf-export/pdf-text-transforms.ts). */
    readonly body: readonly PdfLine[];
    /** One line per attachment (listed only, never opened); null when there is none. */
    readonly attachments: { readonly label: string; readonly items: readonly PdfLine[] } | null;
    readonly flags: PdfEmailFlags;
}

export interface PdfDocument
{
    readonly title: string;
    /** Suggested file name (pdfFileName). */
    readonly fileName: string;
    /** The zone the dates are shown in, as Intl names it ("UTC" after a fallback). */
    readonly timeZone: string;
    /** True when the asked-for zone was not valid and UTC was used (data only: the cover names just the zone used, task 8.8). */
    readonly zoneFallback: boolean;
    readonly cover: PdfCover;
    readonly index: PdfIndex;
    /** The real and the rebuilt emails, in PDF order (see planPdfOrder). */
    readonly emails: readonly PdfEmail[];
    /** For each list position of `result.messages`: its PDF number (counted over every email in the PDF), or null when it is not in the PDF. */
    readonly pdfNumberByPosition: readonly (number | null)[];
    /** Control or broken characters of the emails shown as codes, in total. */
    readonly controlChars: number;
}

/**
 * Why the PDF leaves a part out of a body (the no-repeat rule, task 8.10),
 * for the preview's labels (task 8.11): it prints it as a rebuilt email in
 * the PDF (`id`: its entry in `result.reconstructed`, the one with a slot)
 * or as a real email in the PDF (`position`: its list position), `number`
 * being its PDF number (1..n over every email in the PDF); or (kind
 * 'unticked', task 8.13a, Q2) it does not print it at all: a forwarded part
 * whose rebuilt email (entry `id`) the reader unticked (BuildPdfInput.unticked);
 * or (kind 'unticked-attached', task 8.13b-3, Q3) the printed block of an
 * attached email whose kept copy (list position `position`) is not in the PDF.
 * The printed block of an attached email that IS in the PDF is kind 'email'.
 */
export type PrintedAs =
    | { readonly kind: 'rebuilt'; readonly id: number; readonly number: number }
    | { readonly kind: 'email'; readonly position: number; readonly number: number }
    | { readonly kind: 'unticked'; readonly id: number }
    // The printed block of an attached email whose kept copy (list position
    // `position`) the reader unticked: not printed anywhere (task 8.13b-3, Q3).
    | { readonly kind: 'unticked-attached'; readonly position: number };

/** A range of a body as the PDF prints it: a plan range, or a piece of one the no-repeat rule left out (`printedAs`: where the PDF prints it). */
export interface PdfRange extends PlanRange
{
    /** Set only on a piece the no-repeat rule left out (then `keep` is false): the email the PDF prints it as. */
    readonly printedAs: PrintedAs | null;
}

/**
 * The semantic role of a piece of text. No sizes, no fonts: the renderer
 * decides how each role looks.
 * - 'title': the document title; 'heading': a section or email heading;
 * - 'field-label' / 'field-value': a header row ("From" / "Alice <a@x.test>");
 * - 'body': email text; 'muted': secondary text (notes, "(no subject)");
 * - 'code': the visible code of a replaced character ("[U+0007]", transform
 *   c): the renderer shows it greyed and may give it the original character
 *   as ActualText; text that merely looks like a code stays in its own role.
 */
export type PdfRole = 'title' | 'heading' | 'field-label' | 'field-value' | 'body' | 'muted' | 'code';

/** A run of text with one role. `text` never contains a line break and is never empty. */
export interface PdfRun
{
    readonly role: PdfRole;
    readonly text: string;
}

/** One line: its runs in order. [] is an empty line. The renderer wraps a long line. */
export type PdfLine = readonly PdfRun[];

export interface PdfStrings
{
    /** BCP 47 tag of the language, for sorting names. */
    readonly locale: string;
    readonly title: string;
    /** The tool's name, written as the PDF's producer. */
    readonly producer: string;
    /** The footer of every page: "Page 3 of 12" (both 1-based). */
    pageFooter(page: number, total: number): string;
    /** The bookmark of the cover page. */
    readonly coverBookmark: string;
    /** The bookmark of one email: its number, its day (or the "no date" text), its sender and its subject. */
    emailBookmark(number: number, date: string, from: string, subject: string): string;

    // Cover page.
    readonly datesLabel: string;
    dateRange(first: string, last: string): string;
    readonly emailsLabel: string;
    emailCount(count: number): string;
    readonly generatedLabel: string;
    readonly timeZoneLabel: string;
    readonly peopleHeading: string;
    /** An email's File row when the file has no name. */
    readonly noFileName: string;

    // Index.
    readonly indexHeading: string;
    readonly columns: {
        readonly number: string;
        readonly date: string;
        readonly from: string;
        readonly subject: string;
        readonly attachments: string;
        readonly page: string;
    };
    /** The index's date column title, naming the zone its short dates are in: "Date (America/New York)". */
    indexDateColumn(zone: string): string;

    // One email.
    emailHeading(number: number): string;
    readonly fromLabel: string;
    readonly senderLabel: string;
    readonly toLabel: string;
    readonly ccLabel: string;
    readonly bccLabel: string;
    readonly dateLabel: string;
    readonly subjectLabel: string;
    readonly attachmentsLabel: string;
    readonly fileLabel: string;
    /** In an attached email's File row (task 8.13b-3): an attachment without a name, by its number at that level, "(attached email 2)". */
    attachedNoName(number: number): string;
    readonly noDate: string;
    readonly noSubject: string;
    readonly noText: string;
    readonly unknownSender: string;
    readonly noAttachmentName: string;
    /** "Sender's local time: ..." under the date, when the sender's clock showed another time. */
    senderLocal(time: string): string;
    // No note of any kind: what the tool was unsure about is said in the app,
    // never in the PDF (user rule 2026-11-05, task 8.8).
    // Emails rebuilt from quoted text use the texts above, like real emails:
    // the PDF has no text of its own for them (user decision 2026-11-02, task 8.3).

    // Small pieces.
    /** "Name <address>" (both parts present). */
    mailbox(name: string, address: string): string;
    /** "512 bytes", "1.4 KB", "12 MB", "size unknown". */
    size(bytes: number | null): string;
    /** "(12 KB, application/pdf)" after an attachment name; type may be ''. */
    attachmentDetails(size: string, type: string): string;
    /** The PDF's file name for the day it is made ("YYYY-MM-DD"), or without a day (null). ASCII only. */
    fileName(day: string | null): string;
}

export interface GeneratedPdf
{
    readonly bytes: Uint8Array;
    /** "correspondence-YYYY-MM-DD.pdf" in English: the generation date in the chosen zone, the name in the PDF's language. */
    readonly fileName: string;
    /** How many pages the PDF has (for the page's "ready" message). */
    readonly pageCount: number;
}
