// The fixed texts of the PDF, handed to the document model
// (src/pdf/model.ts) as one object, so the model stays a pure function of
// its inputs and a test (or another language) can pass its own.
//
// createPdfStrings() builds them from the page's strings (src/ui/i18n):
// the PDF's own texts live under `pdf.document`, and the labels it shares
// with the preview (From, To, "(no subject)", file sizes...) are the
// preview's, so the two always use the same words.
//
// Every text here is OUR text. Values put into it (a name, a file name) come
// from the caller already sanitized by the model; the result is plain text
// the renderer writes as text, never markup (README.md, rule R4).

import { LOCALE, t } from '../ui/i18n';

export interface PdfStrings {
  /** BCP 47 tag of the language, for sorting names and joining lists. */
  readonly locale: string;
  readonly title: string;
  /** The tool's name, written as the PDF's producer. */
  readonly producer: string;
  /** The footer of every page: "Page 3 of 12" (both 1-based). */
  pageFooter(page: number, total: number): string;

  // Cover page.
  readonly datesLabel: string;
  dateRange(first: string, last: string): string;
  readonly noDates: string;
  undated(count: number): string;
  readonly emailsLabel: string;
  emailCount(count: number): string;
  readonly generatedLabel: string;
  readonly timeZoneLabel: string;
  zoneFallback(zone: string): string;
  readonly peopleHeading: string;
  readonly sourcesHeading: string;
  readonly sourcesIntro: string;
  sourceEmail(number: number): string;
  sourceCopy(number: number): string;
  readonly unreadableHeading: string;
  readonly unreadableIntro: string;
  readonly noFingerprint: string;
  readonly noFileName: string;
  controlChars(count: number): string;

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
  readonly noDate: string;
  readonly noSubject: string;
  readonly noText: string;
  readonly unknownSender: string;
  readonly noAttachmentName: string;
  senderLocal(time: string): string;
  dateAsWritten(text: string): string;
  readonly zoneUnknown: string;
  readonly keptAllEmpty: string;
  readonly fallback: string;
  /** Notes about content the reader cannot see in full (parser warnings). */
  readonly contentNotes: {
    readonly htmlBodyTruncated: string;
    readonly htmlBodyUnreadable: string;
    readonly rtfOnlyBody: string;
    readonly forwardedNotExpanded: string;
  };

  // Small pieces.
  /** "Name <address>" (both parts present). */
  mailbox(name: string, address: string): string;
  /** "512 bytes", "1.4 KB", "12 MB", "size unknown". */
  size(bytes: number | null): string;
  /** "(12 KB, application/pdf)" after an attachment name; type may be ''. */
  attachmentDetails(size: string, type: string): string;
  /** Joins texts the local way ("a, b, c"). */
  joinList(items: readonly string[]): string;
  /** The separator between a source file's name and its email. */
  readonly separator: string;
}

/** One decimal under 10 (1.4 KB), whole numbers above (12 KB): the same rule as the preview (src/ui/preview.ts, sizeText). */
function roundSize(n: number): number {
  return n < 10 ? Math.round(n * 10) / 10 : Math.round(n);
}

/** The PDF texts in the page language. */
export function createPdfStrings(): PdfStrings {
  const listFormat = new Intl.ListFormat(LOCALE, { style: 'short', type: 'unit' });
  const size = (bytes: number | null): string => {
    if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return t('preview.size.unknown');
    if (bytes < 1024) return t('preview.size.bytes', { count: bytes });
    const kb = bytes / 1024;
    if (kb < 1024) return t('preview.size.kb', { size: roundSize(kb) });
    return t('preview.size.mb', { size: roundSize(kb / 1024) });
  };
  return {
    locale: LOCALE,
    title: t('pdf.document.title'),
    producer: t('app.name'),
    // Strings, like the email numbers below.
    pageFooter: (page, total) => t('pdf.document.pageFooter', { page: String(page), total: String(total) }),
    datesLabel: t('pdf.document.dates'),
    dateRange: (first, last) => t('pdf.document.dateRange', { first, last }),
    noDates: t('pdf.document.noDates'),
    undated: (count) => t('pdf.document.undated', { count }),
    emailsLabel: t('pdf.document.emails'),
    emailCount: (count) => t('pdf.document.emailCount', { count }),
    generatedLabel: t('pdf.document.generated'),
    timeZoneLabel: t('pdf.document.timeZone'),
    zoneFallback: (zone) => t('pdf.document.zoneFallback', { zone }),
    peopleHeading: t('pdf.document.people'),
    sourcesHeading: t('pdf.document.sources'),
    sourcesIntro: t('pdf.document.sourcesIntro'),
    // Strings, so an email number is never written with a thousands separator.
    sourceEmail: (number) => t('pdf.document.sourceEmail', { number: String(number) }),
    sourceCopy: (number) => t('pdf.document.sourceCopy', { number: String(number) }),
    unreadableHeading: t('pdf.document.unreadable'),
    unreadableIntro: t('pdf.document.unreadableIntro'),
    noFingerprint: t('pdf.document.noFingerprint'),
    noFileName: t('added.noName'),
    controlChars: (count) => t('pdf.document.controlChars', { count }),
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
    noDate: t('preview.noDate'),
    noSubject: t('preview.noSubject'),
    noText: t('preview.noText'),
    unknownSender: t('preview.author.none'),
    noAttachmentName: t('preview.noAttachmentName'),
    senderLocal: (time) => t('preview.senderTime', { time }),
    dateAsWritten: (text) => t('pdf.document.dateAsWritten', { text }),
    zoneUnknown: t('warnings.parse.unknown-time-zone'),
    keptAllEmpty: t('pdf.document.keptAllEmpty'),
    fallback: t('pdf.document.fallback'),
    contentNotes: {
      htmlBodyTruncated: t('warnings.parse.html-body-truncated'),
      htmlBodyUnreadable: t('warnings.parse.html-body-unreadable'),
      rtfOnlyBody: t('warnings.parse.rtf-only-body'),
      forwardedNotExpanded: t('warnings.parse.forwarded-message-not-expanded'),
    },
    mailbox: (name, address) => t('preview.mailbox', { name, address }),
    size,
    attachmentDetails: (sizeText, type) =>
      type.trim() === '' ? t('pdf.document.attachmentNoType', { size: sizeText }) : t('pdf.document.attachment', { size: sizeText, type }),
    joinList: (items) => listFormat.format(items),
    separator: ' - ',
  };
}
