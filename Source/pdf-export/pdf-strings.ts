// The fixed texts of the PDF, handed to the document model
// (Source/pdf-export/build-pdf-document.ts) as one object, so the model stays a pure function of
// its inputs and a test (or another language) can pass its own.
//
// createPdfStrings(locale) builds them from the page's strings (Source/web-page/translations)
// in the language asked for: the PDF's own texts live under `pdf.document`,
// and the labels it shares with the preview (From, To, "(no subject)", file
// sizes...) are the preview's, so the two always use the same words. The
// language is always given (the PDF worker gets it in its request): this
// never reads the page's active language.
//
// Every text here is OUR text. Values put into it (a name, a file name) come
// from the caller already sanitized by the model; the result is plain text
// the renderer writes as text, never markup (README.md, rule R4).

import { translator } from '../web-page/translations';
import type { PdfStrings } from '../../Header/pdf-document-model';

/** One decimal under 10 (1.4 KB), whole numbers above (12 KB): the same rule as the preview (Source/web-page/preview.ts, sizeText). */
function roundSize(value: number): number
{
    return value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
}

/** The PDF texts in `locale` (a language the page ships; throws for any other, see translator()). */
export function createPdfStrings(locale: string): PdfStrings
{
    const { t } = translator(locale);
    const formatSize = (bytes: number | null): string =>
    {
        if (bytes === null || !Number.isFinite(bytes) || bytes < 0)
        {
            return t('preview.size.unknown');
        }
        if (bytes < 1024)
        {
            return t('preview.size.bytes', { count: bytes });
        }
        const kilobytes = bytes / 1024;
        if (kilobytes < 1024)
        {
            return t('preview.size.kb', { size: roundSize(kilobytes) });
        }
        return t('preview.size.mb', { size: roundSize(kilobytes / 1024) });
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
        mailbox: (name, address) => t('preview.mailbox', { name, address }),
        size: formatSize,
        attachmentDetails: (sizeText, type) =>
            type.trim() === '' ? t('pdf.document.attachmentNoType', { size: sizeText }) : t('pdf.document.attachment', { size: sizeText, type }),
        fileName: (day) => (day === null ? t('pdf.document.fileNameNoDate') : t('pdf.document.fileName', { date: day })),
    };
}
