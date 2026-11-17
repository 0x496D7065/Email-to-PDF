// The fixed texts of the PDF, handed to the document model
// (src/pdf/model.ts) as one object, so the model stays a pure function of
// its inputs and a test (or another language) can pass its own.
//
// createPdfStrings(locale) builds them from the page's strings (src/ui/i18n)
// in the language asked for: the PDF's own texts live under `pdf.document`,
// and the labels it shares with the preview (From, To, "(no subject)", file
// sizes...) are the preview's, so the two always use the same words. The
// language is always given (the PDF worker gets it in its request): this
// never reads the page's active language.
//
// Every text here is OUR text. Values put into it (a name, a file name) come
// from the caller already sanitized by the model; the result is plain text
// the renderer writes as text, never markup (README.md, rule R4).

import { translator } from '../ui/i18n';

export interface PdfStrings {
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

/** One decimal under 10 (1.4 KB), whole numbers above (12 KB): the same rule as the preview (src/ui/preview.ts, sizeText). */
function roundSize(n: number): number
{
    return n < 10 ? Math.round(n * 10) / 10 : Math.round(n);
}

/** The PDF texts in `locale` (a language the page ships; throws for any other, see translator()). */
export function createPdfStrings(locale: string): PdfStrings
{
    const { t } = translator(locale);
    const size = (bytes: number | null): string =>
    {
        if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return t('preview.size.unknown');
        if (bytes < 1024) return t('preview.size.bytes', { count: bytes });
        const kb = bytes / 1024;
        if (kb < 1024) return t('preview.size.kb', { size: roundSize(kb) });
        return t('preview.size.mb', { size: roundSize(kb / 1024) });
    };
    return {
        locale,
        title: t('pdf.document.title'),
        producer: t('app.name'),
        // Strings, like the email numbers below.
        pageFooter: (page, total) => t('pdf.document.pageFooter', { page: String(page), total: String(total) }),
        coverBookmark: t('pdf.document.coverBookmark'),
        emailBookmark: (number, date, from, subject) => t('pdf.document.emailBookmark', { number: String(number), date, from, subject }),
        datesLabel: t('pdf.document.dates'),
        dateRange: (first, last) => t('pdf.document.dateRange', { first, last }),
        emailsLabel: t('pdf.document.emails'),
        emailCount: (count) => t('pdf.document.emailCount', { count }),
        generatedLabel: t('pdf.document.generated'),
        timeZoneLabel: t('pdf.document.timeZone'),
        peopleHeading: t('pdf.document.people'),
        noFileName: t('added.noName'),
        indexHeading: t('pdf.document.index'),
        columns: {
            number: t('pdf.document.column.number'),
            date: t('pdf.document.column.date'),
            from: t('pdf.document.column.from'),
            subject: t('pdf.document.column.subject'),
            attachments: t('pdf.document.column.attachments'),
            page: t('pdf.document.column.page'),
        },
        indexDateColumn: (zone) => t('pdf.document.column.dateInZone', { zone }),
        emailHeading: (number) => t('pdf.document.emailHeading', { number: String(number) }),
        fromLabel: t('preview.from'),
        senderLabel: t('preview.author.sender'),
        toLabel: t('preview.to'),
        ccLabel: t('preview.cc'),
        bccLabel: t('preview.bcc'),
        dateLabel: t('preview.date'),
        subjectLabel: t('preview.subject'),
        attachmentsLabel: t('preview.attachments'),
        fileLabel: t('pdf.document.file'),
        attachedNoName: (number) => t('pdf.document.attachedNoName', { number: String(number) }),
        noDate: t('preview.noDate'),
        noSubject: t('preview.noSubject'),
        noText: t('preview.noText'),
        unknownSender: t('preview.author.none'),
        noAttachmentName: t('preview.noAttachmentName'),
        senderLocal: (time) => t('preview.senderTime', { time }),
        mailbox: (name, address) => t('preview.mailbox', { name, address }),
        size,
        attachmentDetails: (sizeText, type) =>
            type.trim() === '' ? t('pdf.document.attachmentNoType', { size: sizeText }) : t('pdf.document.attachment', { size: sizeText, type }),
        fileName: (day) => (day === null ? t('pdf.document.fileNameNoDate') : t('pdf.document.fileName', { date: day })),
    };
}
