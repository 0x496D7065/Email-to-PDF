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
// Other languages (French: fr.ts; Dutch: nl.ts) get a sibling file with the
// same shape, typed as `Messages` (see index.ts), listed in catalog.ts.

import type { DedupeWarningCode } from '../../engine/dedupe';
import type { EngineWarningCode, ReconstructionWarningCode } from '../../engine/engine';
import type { OrderReason } from '../../engine/order';
import type { PlanReason } from '../../engine/output-plan';
import type { FoldReason } from '../../engine/segments';
import type { ParseErrorCode, ParseWarning } from '../../parsing/types';
import type { ProcessErrorCode } from '../../pipeline/process-files';
import type { AuthorSource } from '../../ui-model/display-author';
import type { PdfNoteCode } from '../../ui-model/message-notes';
import type { PdfStatus } from '../../ui-model/pdf-plan';
import type { PdfError, PdfUnavailable } from '../pdf-job';

export const en = {
  app: {
    name: 'Email to PDF',
    promise: 'Everything stays on your computer.',
  },

  // The language picker at the top of the page (src/ui/app.ts), shown only
  // when the page has two or more languages. Each language's own name
  // ("English", ...) is never translated: see src/ui/i18n/catalog.ts.
  language: {
    // The picker's group name (its <legend>).
    label: 'Language',
    // Announced (status line) after the reader picked this language, in
    // this language. A PDF made before is removed then (another sentence
    // is added to say so, see download.changedAfter).
    changed: 'The page is now in English.',
  },

  // The privacy panel at the top of the page (src/ui/app.ts): closed by
  // default, opened from its summary line. Each list item is its own key, so
  // another language can word each point its own way. Plain words: the
  // reader may not know what a "request" or a "server" is.
  privacy: {
    // The line that opens and closes the panel (also its accessible name).
    summary: 'Your privacy: how this page works',
    does: {
      title: 'What this page does',
      local: 'Your email files are read only inside this browser tab, on your computer.',
      noUpload: 'Nothing leaves your computer.',
      // The service worker (src/sw/) keeps the page's own files, never user data.
      noSaving:
        "This page saves nothing of yours: no cookies, and nothing from your emails in the browser. Your browser only keeps a copy of this page's own files, so the page can open without internet. Only the PDF you choose to download is saved, in your downloads folder.",
      wiped: 'Closing or reloading this tab, or pressing "Clear everything", removes everything from this page. A PDF you already downloaded stays in your downloads.',
      pdf: 'The PDF is made here too. Once you download it, it exists only on your computer.',
    },
    never: {
      title: 'What this page never does',
      upload: 'It never uploads anything, and there are no accounts.',
      tracking: 'It never tracks you: no analytics, nobody counts or follows what you do here.',
      remote: 'It never loads pictures or anything else from the internet that an email links to.',
      attachments: 'It never opens attached files (documents, pictures and so on): it only lists their name, size and type.',
    },
    check: {
      title: 'How to check it yourself',
      offline:
        "After the page has loaded, turn off your internet (or use airplane mode), then use the tool: it still works. In most browsers, once you have opened the page with the internet on, you can also reload it or open it again without internet: your browser keeps a copy of this page's own files (never your emails).",
      network:
        "For technical people: open your browser's developer tools and go to the Network tab. The page's own files load when it opens. Your browser may also fetch them again from this site in the background, to keep its copy for use without internet up to date, and it asks this site for the file \"/sw.js\" to see whether a new version is out. After that, watch while you use the tool: nothing goes out to the internet. A few entries whose address starts with \"blob:\" are parts of this page running inside your browser.",
      // The repository link is added next to this text later, in one place (src/ui/app.ts).
      source: "This page's code is open source: anyone can read it and check what it does.",
    },
    notes: {
      title: 'Good to know',
      trust: 'Your trust depends on the code this site sends to your browser. That is why the code is open source and can be checked. Like any website, the site that hosts this page can see that the page was loaded, but never your emails.',
      console:
        'Your browser\'s developer tools may show red error lines that mention a "Content Security Policy". That is the browser refusing styles, scripts or links, for example ones found inside your emails: the protection working. Nothing from your emails was run or loaded.',
      scripts:
        'In the PDF, some writing systems (for example Hebrew, Arabic, Chinese, Japanese, Korean, Thai or Hindi) and emoji show as codes such as [U+05D0], because the font used in the PDF does not include them. Latin, Greek and Cyrillic text shows normally. The text in your original files is unchanged.',
    },
  },

  // Shown under step 3 and repeated in the privacy panel. Draft wording.
  disclaimer: {
    text: 'This tool is provided as is, without any guarantee, and it is not legal advice. Check the PDF before you send it. Your original email files remain the reference.',
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
    },
  },

  // The "how to get your email files" help in step 1 (src/ui/app.ts): closed
  // by default, opened from its summary line. Classic Outlook for Windows:
  // dragging an email to the desktop or a folder was checked to give .eml
  // (2026-10); older versions reportedly give .msg. Everything else is
  // unverified, so every line stays hedged ("usually", "may"): never promise
  // that a menu or a drag works. No links, no URLs.
  help: {
    // The line that opens and closes the help (also its accessible name).
    summary: 'How do I get my email files?',
    intro: 'This tool reads .eml and .msg files. You can add several files at once.',
    // One entry per mail program, in the order shown: its name (a heading) and one or two short sentences.
    clients: {
      outlookClassic: {
        name: 'Outlook (classic, on Windows)',
        how: 'Dragging an email from the list to a folder or to the desktop usually makes a file: an .eml or a .msg file, depending on your Outlook version. Both work here. Save As in the File menu may also save one.',
      },
      outlookNew: {
        name: 'New Outlook and Outlook on the web',
        how: 'This varies. There may be a Download or Save option in the email\'s "..." menu that gives an .eml file; dragging an email may not make a file.',
      },
      thunderbird: {
        name: 'Thunderbird',
        how: 'Dragging an email to a folder, or using Save As in the File menu, usually gives an .eml file.',
      },
      appleMail: {
        name: 'Apple Mail',
        how: 'Dragging an email to a folder in Finder usually gives an .eml file.',
      },
      gmail: {
        name: 'Gmail (in a web browser)',
        how: 'Open the email, then look for "Download message" in its three-dot menu. This usually gives an .eml file.',
      },
    },
    note: 'Menu names can differ between versions and languages, so yours may not match exactly.',
  },

  // Step 3 (src/ui/download-step.ts). The note under the button is also its
  // accessible description: it always says what the button does now, or why
  // it is unavailable.
  download: {
    // Why the button is unavailable.
    unavailable: {
      'no-emails': 'Add your emails in step 1 first.',
      busy: 'Please wait: your emails are still being read and checked.',
      'none-included': 'Tick at least one email in step 2 to make a PDF.',
      'labels-failed': 'The PDF cannot be made: the tool could not work out what goes in it. To try again, reconnect to the internet, reload the page and add your files again.',
    } satisfies Record<PdfUnavailable, string>,
    available: 'Makes one PDF of the emails ticked in step 2, here on this computer.',
    // Shown (and announced in the status line) after a PDF being made or
    // ready was dropped because a choice changed (time zone, ticks, files...).
    changed: 'Your choices changed, so the previous PDF was removed. Make the PDF again to include them.',
    // One announcement when the same action also has news of its own, e.g.
    // "{2 of 3 emails will be in the PDF.} {Your choices changed, ...}".
    changedAfter: '{news} {changed}',
    making: 'Making your PDF... This can take a little while for many emails. The page stays usable.',
    ready: {
      one: 'Your PDF is ready: {fileName}, {count} page. The download has started.',
      other: 'Your PDF is ready: {fileName}, {count} pages. The download has started.',
    },
    // The link kept after the download started.
    again: 'Download again: {fileName}',
    // Why no PDF was made. Never says the emails are damaged.
    error: {
      timeout: 'Making the PDF took too long, so it was stopped. You can try again, or untick some emails in step 2 to make a smaller PDF.',
      'tool-error': 'The tool could not make the PDF. Your emails are still here: you can try again.',
      'not-started': 'The tool could not start making the PDF in this browser. To try again, reconnect to the internet, reload the page and add your files again.',
    } satisfies Record<PdfError, string>,
  },

  drop: {
    zone: 'Drag your email files here, or choose them.',
    accepted: 'Accepted: .eml and .msg files. You can add more files at any time.',
    // The visible progress line, which follows every file.
    reading: 'Reading file {done} of {total}...',
    // The status line while files are read: set once per round, with no
    // file number, so it never looks stuck while the progress line moves on.
    readingOne: 'Reading your file...',
    readingMany: 'Reading {total} files. This can take a moment; the progress bar below shows how far it is.',
    organizing: 'Putting your emails in order...',
    // Files added while others are still being read.
    queued: 'More files were added. They will be read as soon as the current ones are done.',
    // Files dropped somewhere on the page other than the drop zone.
    outside: 'Nothing was added. To add files, drop them on the dashed box in step 1.',
    // A drop with no file in it (a link or some text).
    nothing: 'Nothing was added: only files can be dropped here.',
    folders: {
      one: '{count} folder could not be added. Open it and add the email files inside it instead.',
      other: '{count} folders could not be added. Open them and add the email files inside them instead.',
    },
  },

  // Step 1 after the files were read: a short summary, then the files that failed.
  added: {
    files: { one: '{count} file added.', other: '{count} files added.' },
    failed: { one: '{count} could not be read.', other: '{count} could not be read.' },
    messages: { one: '{count} email found.', other: '{count} emails found.' },
    merged: { one: '{count} identical copy merged.', other: '{count} identical copies merged.' },
    failedTitle: 'Files that could not be read',
    details: 'Technical details',
    noName: '(file without a name)',
  },

  preview: {
    from: 'From',
    to: 'To',
    cc: 'Cc',
    bcc: 'Bcc',
    date: 'Date',
    subject: 'Subject',
    attachments: 'Attachments',
    noSubject: '(no subject)',
    noDate: '(no date)',
    noText: '(no text)',
    // An email whose item could not be built: its text is still shown under this note.
    itemFailed: 'Something went wrong while showing this email. Its text, if it has any, is shown below as it is.',
    // The toolbar above the list.
    zone: 'Show dates in this time zone',
    zoneThisComputer: '{zone} (this computer)',
    showFolded: 'Show quoted text and signatures',
    // Accessible name of the list of emails.
    listLabel: 'Your emails, oldest first',
    // An email's number in the list, e.g. "#3".
    messageNumber: '#{number}',
    // Shown under the date when the sender's own clock showed another time.
    senderTime: "Sender's local time: {time}",
    // One mailbox with both parts, e.g. "Alice Example <alice@example.test>".
    mailbox: '{name} <{address}>',
    // Files this email was also found in (identical copies merged into it).
    alsoIn: 'Also in',
    // One attachment: listed only, never opened.
    attachment: '{name} ({size}, {type})',
    attachmentNoType: '{name} ({size})',
    noAttachmentName: '(attachment without a name)',
    size: {
      bytes: { one: '{count} byte', other: '{count} bytes' },
      kb: '{size} KB',
      mb: '{size} MB',
      unknown: 'size unknown',
    },
    // A folded block's label, e.g. "Quoted text, 12 lines, from email #3":
    // its kind (fold below), its number of lines (foldLines) and, when known,
    // where the text comes from (foldFromOne / foldFromMany). Templates, not
    // a list: the language's list rule would join the parts with "and" in
    // some languages ("Quoted text and 12 lines").
    foldLabel: '{kind}, {lines}',
    foldLabelFrom: '{kind}, {lines}, {from}',
    foldLines: { one: '{count} line', other: '{count} lines' },
    foldFromOne: 'from email {list}',
    foldFromMany: 'from emails {list}',
    // A folded block without a known reason (not expected; a safe default).
    foldOther: 'Folded text',
    // How the shown author was found (see src/ui-model/display-author.ts).
    author: {
      from: 'From',
      sender: 'Sent by',
      none: 'Unknown sender',
    } satisfies Record<AuthorSource, string>,
    // Why a message sits where it is. Only 'file-order' needs a note. It is
    // shown after any note about the date, but carries its own reason: a
    // date outside the years 1 to 9999 gets this note without a date note.
    order: {
      'file-order': 'No usable date: placed at the end of the list, in the order the files were added.',
    } satisfies Record<Exclude<OrderReason, 'by-date'>, string>,
    // Label on a folded part of an email (README.md, rule R6).
    fold: {
      'quoted-overlap': 'Text from an earlier email',
      'quote-marker': 'Quoted text',
      'reply-header': 'Quoted earlier email',
      signature: 'Signature or repeated notice',
    } satisfies Record<FoldReason, string>,
  },

  // The summary at the top of step 2, e.g. "12 files, 1 could not be read".
  counts: {
    // A line made of the parts below joined, e.g. "{12 files, 1 could not be read}."
    sentence: '{text}.',
    files: { one: '{count} file', other: '{count} files' },
    filesFailed: { one: '{count} could not be read', other: '{count} could not be read' },
    // The two parts above when some files failed: the failed ones are among the {files}.
    filesWithFailed: '{files}, {failed}',
    // Points to the list of failed files (with the reasons) in step 1.
    seeFailed: 'See why in step 1.',
    messagesFound: { one: '{count} email found', other: '{count} emails found' },
    duplicatesMerged: { one: '{count} identical copy merged', other: '{count} identical copies merged' },
    // Earlier emails rebuilt from the quoted text of the emails added (task 7.6), a part of the line above.
    rebuiltFound: { one: '{count} earlier email rebuilt from quoted text', other: '{count} earlier emails rebuilt from quoted text' },
    // Updated (and announced) each time an email is ticked or unticked. {count} is the total.
    included: {
      one: '{included} of {count} email will be in the PDF.',
      other: '{included} of {count} emails will be in the PDF.',
    },
    // Shown (and announced on each change) only when emails were rebuilt from quoted text. {count} is the total.
    rebuiltIncluded: {
      one: '{included} of {count} rebuilt email will be in the PDF.',
      other: '{included} of {count} rebuilt emails will be in the PDF.',
    },
    withNotes: {
      one: '{count} email has notes, shown with it below.',
      other: '{count} emails have notes, shown with each email below.',
    },
  },

  // Per email in step 2: the include checkbox and the notes.
  review: {
    // Shown on an email that was unticked: it stays in the list, dimmed.
    excluded: 'Not in the PDF',
    // Accessible name of an email's list of notes.
    notesLabel: 'Notes about this email',
    // After a note about look-alike emails: which ones, e.g. "See emails #3, #5".
    relatedOne: 'See email {list}.',
    relatedMany: 'See emails {list}.',
    // When the list was cut, the rest is counted in FILES, not emails:
    // several files can be one merged email (maybe one already listed).
    relatedMoreFiles: { one: '{count} more file is involved.', other: '{count} more files are involved.' },
    relatedOnlyMore: { one: '{count} other file is involved.', other: '{count} other files are involved.' },
    // Shown at the top of an email's text when its PDF plan keeps it whole.
    pdfNote: {
      'pdf-kept-all-empty': 'The whole email will be in the PDF: the tool could not tell its own text from the quote.',
      'pdf-fallback': 'The whole email will be in the PDF: the tool could not work out which parts to leave out.',
    } satisfies Record<PdfNoteCode, string>,
  },

  // Step 2: earlier emails rebuilt from the quoted text of an email added
  // (src/ui/preview.ts, src/ui-model/rebuilt.ts). Drafts (user decision Q4,
  // 2026-10-27): the user proofreads them in task 7.8. A rebuilt card never
  // has a number of its own; its words always say it was rebuilt, never
  // only its dashed border.
  rebuilt: {
    // The text label at the start of every rebuilt card's heading.
    label: 'Rebuilt',
    // The quoted header has no subject (an "On ... wrote:" line never has one).
    noSubject: '(subject not in the quote)',
    // The fixed note on every rebuilt card. {number} is the source email's number, e.g. "#3".
    // noteMarks when quote marks (">") were removed from the text, noteNoMarks otherwise.
    noteMarks: 'Rebuilt from the quoted text in email {number}. Quote marks removed; may be incomplete or inexact.',
    noteNoMarks: 'Rebuilt from the quoted text in email {number}. May be incomplete or inexact.',
    // Other emails that quote the same earlier email, e.g. "Same quoted text also in emails #4, #6."
    alsoOne: 'Same quoted text also in email {list}.',
    alsoMany: 'Same quoted text also in emails {list}.',
    // A details row: the email the card was taken from, e.g. "Taken from: email #3".
    takenFrom: 'Taken from',
    takenFromValue: 'email {number}',
    // After a To or Cc list that may go on past what could be read.
    listIncomplete: '(list may be incomplete)',
    // A quoted date read without a time zone of its own: the time is a best guess.
    dateAbout: 'about {date}',
    // The date exactly as the quote wrote it, under the date shown.
    dateAsWritten: 'As written in the quote: {text}',
    // A quoted date the tool could not read (it is shown as written below).
    dateUnreadable: '(date could not be read)',
    // The checkbox in the step 2 toolbar, ticked by default. Unticking it leaves every rebuilt email out.
    includeAll: 'Include earlier emails rebuilt from quoted text',
    // A rebuilt card that could not be built (not expected).
    itemFailed: 'Something went wrong while showing this rebuilt email. Its text is still in the email it was taken from.',
    // On a rebuilt card that is ticked, while every email it was taken from is unticked (task 7.7: it follows them).
    sourceExcluded: 'Not in the PDF: the email it comes from is left out',
    // On a rebuilt card in the PDF whose own email (named in "Taken from") is
    // unticked while another email quoting the same text is ticked: the PDF
    // takes it from that email, e.g. "In the PDF: taken from #5" (task 7.7).
    pdfSource: 'In the PDF: taken from {number}',
  },

  // What the PDF will leave out, shown on each folded part in step 2
  // (src/ui/preview.ts, src/ui-model/pdf-plan.ts). Always words, not only colour.
  pdf: {
    // The checkbox in the step 2 toolbar (the "include everything" option).
    everything: 'Put everything in the PDF (leave nothing out)',
    // Shown while the labels are being worked out again (they are hidden meanwhile).
    // The line keeps its place when empty, so the list below never moves.
    updating: 'Checking what goes in the PDF...',
    // Not expected: the labels could not be worked out, so none is shown.
    failed: 'The tool could not work out which parts the PDF leaves out, so the folded parts are not marked.',
    // A folded part's label, e.g. "Not in the PDF: earlier email quoted by the mail app".
    // `as const` here too: a bare `satisfies` would widen the texts to string
    // and t() would no longer check the {reasons} placeholder.
    label: {
      in: 'In the PDF: {reasons}',
      out: 'Not in the PDF: {reasons}',
      // Not expected (the preview cuts such parts in two): a safe text all the same.
      partly: 'Partly in the PDF: {reasons}',
    } as const satisfies Record<PdfStatus, string>,
    // The reasons, joined into {reasons} above.
    reason: {
      text: 'text written in this email',
      'writer-quote': "quote that is part of the writer's text",
      forwarded: 'forwarded email',
      'app-quoted-history': 'earlier email quoted by the mail app',
      signature: 'signature',
      'repeated-signature': 'repeated signature',
    } satisfies Record<PlanReason, string>,
    // A repeated signature when the email where it is kept is known, e.g. "same signature as in email #2".
    repeatedFrom: 'same signature as in email {number}',
    // The same, when a part holds signatures kept in several emails, e.g. "same signature as in emails #1, #3".
    repeatedFromMany: 'same signature as in emails {list}',
    // Not expected: one email's labels could not be shown (the others are). Shown above that email's text.
    messageFailed: 'The tool could not show what the PDF leaves out for this email.',
    // The texts written in the PDF itself (src/pdf/model.ts, through src/pdf/strings.ts).
    document: {
      title: 'Email correspondence',
      // Cover page: the rows of the summary.
      dates: 'Dates',
      // E.g. "2025-03-01 09:00:00 UTC+01:00 to 2025-04-02 11:00:42 UTC+02:00".
      dateRange: '{first} to {last}',
      noDates: 'No email in this PDF has a usable date.',
      undated: {
        one: '{count} email has no usable date. It is placed after the dated emails, in the order the files were added.',
        other: '{count} emails have no usable date. They are placed after the dated emails, in the order the files were added.',
      },
      emails: 'Emails',
      emailCount: { one: '{count} email', other: '{count} emails' },
      generated: 'Made on',
      timeZone: 'Dates shown in',
      // The time zone asked for was not valid: UTC was used.
      zoneFallback: '{zone} (the chosen time zone was not recognized)',
      people: 'People',
      sources: 'Source files',
      sourcesIntro:
        'Every file that gave an email in this PDF, with its SHA-256 fingerprint. A file with the same fingerprint is exactly the same file.',
      // After a source file's name: which email it gave.
      sourceEmail: 'email {number}',
      // A file whose email was an identical copy of another file's email, merged into it.
      sourceCopy: 'email {number} (identical copy, merged)',
      unreadable: 'Files that could not be read',
      unreadableIntro: 'These files were added but could not be read. Nothing from them is in this PDF.',
      noFingerprint: 'no fingerprint (the file was not read)',
      controlChars: {
        one: '{count} control or broken character in the emails is shown as a code such as [U+0000].',
        other: '{count} control or broken characters in the emails are shown as codes such as [U+0000].',
      },
      // The index (table of contents).
      index: 'Index',
      column: {
        number: 'No.',
        date: 'Date',
        // The index's date column title: its dates are "YYYY-MM-DD HH:mm" in this zone, e.g. "Date (America/New York)".
        dateInZone: 'Date ({zone})',
        from: 'From',
        subject: 'Subject',
        attachments: 'Attachments',
        page: 'Page',
      },
      // One email.
      emailHeading: 'Email {number}',
      // The file the email came from (its fingerprint is on the cover page).
      file: 'File',
      // After an attachment's name (listed only, never opened), e.g. "(12 KB, application/pdf)".
      attachment: '({size}, {type})',
      attachmentNoType: '({size})',
      // A date the tool could not read, shown as it was written.
      dateAsWritten: 'Date as written in the email: {text}',
      keptAllEmpty: 'The whole email is shown: the tool could not tell its own text from the quote.',
      fallback: 'The whole email is shown: the tool could not work out which parts to leave out.',
      // The footer of every page, e.g. "Page 3 of 12".
      pageFooter: 'Page {page} of {total}',
      // Bookmarks (the side panel of a PDF reader): the cover page, then one per email,
      // e.g. "3. 2025-03-04, Alice Example: Desks for the office".
      coverBookmark: 'Cover',
      emailBookmark: '{number}. {date}, {from}: {subject}',
      // The PDF's file name, from the day it is made in the chosen zone
      // (YYYY-MM-DD). ASCII letters, digits and dashes only: some systems
      // mangle other characters in a file name.
      fileName: 'correspondence-{date}.pdf',
      // The same when that day cannot be worked out (not expected).
      fileNameNoDate: 'correspondence.pdf',
      // Earlier emails rebuilt from quoted text (task 7.7). They have no
      // number, no file and no fingerprint of their own. Their other texts
      // (note, "Taken from", "about", "As written in the quote", "list may
      // be incomplete") are the preview's (the rebuilt group above).
      // The heading of one, e.g. "Earlier email (rebuilt from quoted text in email 3)".
      rebuiltHeading: 'Earlier email (rebuilt from quoted text in email {number})',
      // In front of a rebuilt email's subject in the index, and of its bookmark.
      rebuiltMarker: '[Rebuilt]',
      // A rebuilt email's bookmark, e.g. "[Rebuilt] 2025-03-03, Alice Example: Desks".
      rebuiltBookmark: '{marker} {date}, {from}: {subject}',
      // Cover page: the row with their count, and a section that says what they are.
      rebuilt: 'Rebuilt emails',
      rebuiltCount: {
        one: '{count} earlier email rebuilt from quoted text',
        other: '{count} earlier emails rebuilt from quoted text',
      },
      rebuiltSection: 'Earlier emails rebuilt from quoted text',
      rebuiltIntro:
        'Rebuilt emails are earlier emails that were not among the files added: the tool rebuilt them from the text quoted in a later email. Each one says which email it was taken from and has no number, no file and no SHA-256 fingerprint of its own; in the index they are marked "[Rebuilt]". Any quote marks (>) were removed from their text, and they may be incomplete or inexact. They are not original files.',
    },
  },

  warnings: {
    // Things the file reader was unsure about (one email).
    parse: {
      'missing-date': 'No date was found in this email.',
      'unparseable-date': 'The date of this email could not be read.',
      'unknown-time-zone': "The sender's time zone is not given, so the time may be off by a few hours.",
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
    // Earlier emails quoted in this email could not (all) be rebuilt. Nothing is lost: the quote stays here.
    rebuild: {
      'reconstruct-failed': 'The earlier emails quoted in this email could not be rebuilt as separate emails. The quoted text is all still in this email.',
      'reconstruct-limit': 'Not every earlier email quoted in this email could be rebuilt (too many, or the email is too long). The quoted text is all still in this email.',
    } satisfies Record<ReconstructionWarningCode, string>,
  },

  errors: {
    // Why one file could not be read.
    file: {
      'too-large': 'This file is too large to read.',
      'unsupported-type': 'This is not an email file (.eml or .msg).',
      corrupt: 'This file could not be read. It may be damaged.',
      // Stopped at the time limit: says what happened without calling the file damaged.
      timeout: 'Reading this file took too long, so it was stopped. To try again, reconnect to the internet, reload the page and add it again. If it stops again, the file may be damaged.',
      // The tool failed, not the file. Ends like 'timeout': a hostile file
      // that crashes the reading step gets an honest answer without being
      // called damaged.
      'tool-error': 'The tool could not read this file. To try again, reconnect to the internet, reload the page and add it again. If it fails again, the tool cannot read this file.',
      // The browser could not open the file (moved, deleted or changed on
      // disk since it was chosen): not a damaged file, and no reload needed.
      unreadable: 'Your browser could not open this file. It may have been moved or changed since you chose it. Add it again.',
    } satisfies Record<ParseErrorCode, string>,
    // Why a whole batch has no result. Only actions that exist on the page
    // today are suggested (there is no "try again" button yet). Reload
    // advice always mentions the internet: an offline page can reload only
    // when the browser kept its offline copy (src/sw/), and that copy may be
    // missing (private browsing, service worker refused or not yet
    // installed, site data cleared), so reconnecting first stays the safe
    // advice.
    batch: {
      'engine-timeout': 'Putting your emails in order took too long. To try again, reconnect to the internet, reload the page and add fewer files.',
      'engine-failed': 'Your emails could not be put in order. To try again, reconnect to the internet, reload the page and add your files again.',
      unexpected: 'Something went wrong. To try again, reconnect to the internet, reload the page and add your files again.',
      // Only after "Clear everything", which throws the stopped batch away:
      // not expected on the page, a safe text all the same.
      cancelled: 'Reading was stopped because everything was cleared.',
    } satisfies Record<ProcessErrorCode, string>,
  },

  // The "Clear everything" button in step 1 (src/ui/page.ts).
  clear: {
    // Under the button, also its accessible description.
    note: 'Removes all your emails from this page at once. This page never saves them.',
    // Shown in front of the note (and read first in the button's description)
    // while the button is unavailable.
    unavailable: 'There is nothing to clear: no emails have been added.',
    // Announced (status line) after the button was pressed.
    done: 'Everything was cleared.',
  },

  actions: {
    chooseFiles: 'Choose email files',
    makePdf: 'Make the PDF',
    clearEverything: 'Clear everything',
    include: 'Include in the PDF',
  },

  footer: {
    note: 'Works in your browser: no upload, no account, no tracking.',
  },
} as const;
