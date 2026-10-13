// Every user-visible string of the page, in English (the first language).
//
// Rules for this file:
// - Plain, calm words for someone who is not technical and may be stressed:
//   "email file", never "RFC 822 message". Short sentences.
// - A `{name}` placeholder is filled in by t() (see index.ts). The output only
//   ever goes into textContent, so a value can never become HTML
//   (README.md, rule R4).
// - An entry with `one` / `other` is a PLURAL: t() picks the form with the
//   browser's built-in plural rules (Intl.PluralRules) for `{count}`. French
//   and Dutch use the same two forms, with their own rules for which number
//   takes which form.
// - The label groups for warning and error codes use `satisfies Record<Code,
//   string>`: if a code is added to (or removed from) its type, this file
//   stops compiling until a label is written (or removed).
// - ASCII only: a non-ASCII character would be written as a \u escape.
//
// Other languages (French next, then Dutch) get a sibling file with the same
// shape, typed as `Messages` (see index.ts).

import type { DedupeWarningCode } from '../../engine/dedupe';
import type { EngineWarningCode } from '../../engine/engine';
import type { OrderReason } from '../../engine/order';
import type { FoldReason } from '../../engine/segments';
import type { ParseErrorCode, ParseWarning } from '../../parsing/types';
import type { ProcessErrorCode } from '../../pipeline/process-files';
import type { AuthorSource } from '../../ui-model/display-author';

export const en = {
  app: {
    name: 'Email to PDF',
    promise: 'Everything stays on your computer.',
  },

  steps: {
    // Small label above each step title, e.g. "Step 1".
    number: 'Step {number}',
    add: {
      title: 'Add your emails',
      intro: 'Use the email files you saved from your mail program (.eml or .msg files).',
    },
    check: {
      title: 'Check',
      intro: 'Look over your emails, in date order, before making the PDF.',
      waiting: 'Your emails will appear here once you have added them.',
    },
    download: {
      title: 'Download PDF',
      intro: 'Save one PDF with all your emails, oldest first.',
      comingSoon: 'Coming soon: making the PDF is not available yet.',
    },
  },

  drop: {
    zone: 'Drop your email files here',
    or: 'or',
    accepted: 'Accepted: .eml and .msg files.',
    reading: 'Reading file {done} of {total}...',
    organizing: 'Putting your emails in order...',
  },

  preview: {
    from: 'From',
    to: 'To',
    cc: 'Cc',
    date: 'Date',
    subject: 'Subject',
    attachments: 'Attachments',
    noSubject: '(no subject)',
    noDate: '(no date)',
    // How the shown author was found (see src/ui-model/display-author.ts).
    author: {
      from: 'From',
      sender: 'Sent by',
      none: 'Unknown sender',
    } satisfies Record<AuthorSource, string>,
    // Why a message sits where it is. Only 'file-order' needs a note.
    order: {
      'file-order': 'Date missing or unreadable: placed at the end, in the order the files were added.',
    } satisfies Record<Exclude<OrderReason, 'by-date'>, string>,
    // Label on a folded part of an email (README.md, rule R6).
    fold: {
      'quoted-overlap': 'Text from an earlier email',
      'quote-marker': 'Quoted text',
      'reply-header': 'Quoted earlier email',
      signature: 'Signature or repeated notice',
    } satisfies Record<FoldReason, string>,
  },

  counts: {
    filesRead: { one: '{count} file read', other: '{count} files read' },
    messagesFound: { one: '{count} email found', other: '{count} emails found' },
    duplicatesMerged: { one: '{count} identical copy merged', other: '{count} identical copies merged' },
    filesFailed: { one: '{count} file could not be read', other: '{count} files could not be read' },
    undated: { one: '{count} email has no date', other: '{count} emails have no date' },
  },

  warnings: {
    // Things the file reader was unsure about (one email).
    parse: {
      'missing-date': 'This email has no date.',
      'unparseable-date': 'The date of this email could not be read.',
      'unknown-time-zone': 'The time zone is not given, so the time may be off by a few hours.',
      'missing-message-id': 'This email has no hidden reference number, so identical copies are harder to spot.',
      'html-converted-body': 'This email was turned into plain text from its formatted version. The layout may look different.',
      'html-body-truncated': 'This email is very long, so its text was cut short here. The full text is still in the original file.',
      'html-body-unreadable': 'Part of this email could not be shown (the formatted version could not be read).',
      'rtf-only-body': 'The text of this email is saved in a format that cannot be shown here.',
      'no-body': 'This email has no text.',
      'forwarded-message-not-expanded': 'A forwarded email inside this one is listed as an attachment. Its text is not shown.',
    } satisfies Record<ParseWarning, string>,
    // Look-alike emails that were NOT merged, to be safe.
    dedupe: {
      'same-id-different-content': 'Another email looks like the same message, but its content differs, so both are kept.',
      'duplicate-date-differs': 'An almost identical copy has a different date, so both are kept.',
      'duplicate-recipients-differ': 'An almost identical copy lists different recipients, so both are kept.',
      'duplicate-sender-differs': 'An almost identical copy names a different sender, so both are kept.',
      'duplicate-threading-differs': 'An almost identical copy has different reply information, so both are kept.',
      'possible-duplicate-not-merged': 'This may be a copy of another email, but it was kept separately to be safe.',
    } satisfies Record<DedupeWarningCode, string>,
    // Something the tool had to work around; nothing was lost.
    engine: {
      'detector-failed': 'Some quoted or repeated text in this email could not be checked, so it is shown in full.',
      'folding-disabled': 'This email is shown in full; quoted text could not be tucked away.',
      'dedupe-failed': 'Identical copies could not be checked, so every email is kept.',
    } satisfies Record<EngineWarningCode, string>,
  },

  errors: {
    // Why one file could not be read.
    file: {
      'too-large': 'This file is too large to read.',
      'unsupported-type': 'This is not an email file (.eml or .msg).',
      corrupt: 'This file could not be read. It may be damaged.',
    } satisfies Record<ParseErrorCode, string>,
    // Why a whole batch has no result.
    batch: {
      'engine-timeout': 'Putting your emails in order took too long. Please try again with fewer files.',
      'engine-failed': 'Your emails could not be put in order. Please try again.',
      unexpected: 'Something went wrong. Please try again.',
    } satisfies Record<ProcessErrorCode, string>,
  },

  actions: {
    chooseFiles: 'Choose files',
    downloadPdf: 'Download PDF',
    clearEverything: 'Clear everything',
    showFolded: 'Show folded text',
    hideFolded: 'Fold quoted text again',
    include: 'Include in the PDF',
  },

  footer: {
    note: 'Works in your browser: no upload, no account, no tracking.',
  },
} as const;
