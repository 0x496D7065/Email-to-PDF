# Local Email-to-PDF Tool

A free, open-source web page that turns exported email files (`.eml` and
`.msg`) into one clean PDF, **entirely inside your browser**. It is made for
people who must hand over an email exchange to a lawyer, notary, insurer or
employer. There is no server, no account and no upload: your emails never
leave your computer.

## Contents

- [What it does](#what-it-does)
- [Getting your email files](#getting-your-email-files)
- [How the privacy model works](#how-the-privacy-model-works)
- [How to verify it](#how-to-verify-it)
- [Collapse, never delete](#collapse-never-delete)
- [Earlier emails rebuilt from quoted text](#earlier-emails-rebuilt-from-quoted-text)
- [Known limits](#known-limits)
- [Disclaimer](#disclaimer)
- [Privacy and security rules (R1 to R7)](#privacy-and-security-rules-r1-to-r7)
- [Offline copy (service worker)](#offline-copy-service-worker)
- [For developers](#for-developers)
- [Security note for maintainers](#security-note-for-maintainers)
- [License](#license)

## What it does

You give it the email files of a conversation. It merges copies that are
exactly the same, puts the emails in date order, folds quoted earlier
emails and repeated signatures, and makes one PDF with a cover page, an
index and page numbers. One screen, three steps:

1. **Add your emails:** drag the files onto the page, or choose them. You
   can add more at any time.
2. **Check:** look over the emails, oldest first. Untick any email you do
   not want in the PDF, pick the time zone for the dates, and see what each
   folded part is and whether it goes into the PDF.
3. **Download PDF:** the PDF is made on your computer and saved as
   `correspondence-YYYY-MM-DD.pdf`.

**Languages:** English, French and Dutch, for the page and the PDF. The
page starts in your browser's first (preferred) language if it is one of
these, otherwise in English. A switch at the top changes it. The choice is
not saved.

If you add only the last email of a conversation, the earlier emails quoted
inside it are also shown as separate emails, clearly marked "Rebuilt" in
the preview; in the PDF they are not marked (see
[Earlier emails rebuilt from quoted text](#earlier-emails-rebuilt-from-quoted-text)).

**Status:** working and tested, not yet released.

## Getting your email files

The page has the same help under "How do I get my email files?". Only
dragging an email out of classic Outlook was tried; the rest is what these
programs usually do, and menu names differ between versions and languages.

- **Outlook (classic, on Windows):** dragging an email from the list to a
  folder or to the desktop usually makes a file: an `.eml` or a `.msg`
  file, depending on your Outlook version. Both work. Save As in the File
  menu may also save one.
- **New Outlook and Outlook on the web:** this varies. There may be a
  Download or Save option in the email's "..." menu that gives an `.eml`
  file; dragging an email may not make a file.
- **Thunderbird:** dragging an email to a folder, or File > Save As,
  usually gives an `.eml` file.
- **Apple Mail:** dragging an email to a folder in Finder usually gives an
  `.eml` file.
- **Gmail (in a web browser):** open the email, then look for "Download
  message" in its three-dot menu. This usually gives an `.eml` file.

You can add several files at once. Folders cannot be added: open them and
add the files inside.

## How the privacy model works

- **Everything runs in your browser tab.** The files are read, sorted and
  turned into a PDF on your computer. Nothing is uploaded; there is no
  account, no analytics and no third-party script.
- **No network requests after the page has loaded.** Once the page's own
  files (code, styles, PDF fonts) are loaded, the page sends nothing
  anywhere. Pictures and other content that emails link to are never
  loaded. The browser itself enforces this through a strict Content
  Security Policy (CSP, see [R2](#r2-strict-content-security-policy)).
- **Nothing is stored.** Your emails and everything made from them stay in
  the page's memory only: no cookies, no browser storage. Closing or
  reloading the tab wipes them, and so does the "Clear everything" button.
  Only the PDF you choose to download is saved, in your downloads folder.
- **The offline copy holds only the site's own files.** After one visit
  with the internet on, the browser keeps a copy of the page's own files
  (a service worker), so the page can be opened again without internet. It
  never holds your emails or the PDF. See
  [Offline copy](#offline-copy-service-worker).
- **What the host still sees:** like any website, the site that serves the
  page sees that the page was loaded (and the browser's periodic check for
  a new version, below). It never sees your emails.

**Trust ultimately depends on the code that is served.** If the site, its
hosting, its domain or the project's account were ever taken over, a
different, malicious version could be served under the same address. That
is why the project is open source and why everything above can be checked
by anyone, as described next.

## How to verify it

1. **Watch the network.** Open your browser's developer tools (DevTools),
   go to the Network tab, reload the page, then add emails and make a PDF.
   You will see:
   - the page's own files loading when it opens (the page, its script and
     style in `assets/`, the PDF fonts script);
   - possibly the site's own files (the same ones, plus
     `THIRD_PARTY_NOTICES.txt`) fetched from the same site, in the
     background, by the service worker that keeps the offline copy, and a
     request for `/sw.js`, which the browser makes to see whether a new
     version is out;
   - a few entries whose address starts with `blob:`. These are parts of
     the page running inside your browser (the background workers that read
     the files and make the PDF, and the PDF itself). They never leave your
     computer.

   Nothing else: no request to another site, and no request caused by
   adding emails or making the PDF.
2. **Run it offline.** Open the page, then turn off your internet (or tick
   "Offline" in DevTools) and use the tool: everything still works. After
   one visit with the internet on, you can also reload or reopen the page
   while offline: it then comes from the offline copy.
3. **Read the source.** The security headers are in
   `src/security/headers.ts`, the build checks in `scripts/`, the browser
   tests in `e2e/`, and the offline copy in `src/sw/`.
4. **Check the CSP.** In DevTools, on a host that sends headers, the
   response headers of the page show the policy listed under
   [R2](#r2-strict-content-security-policy); the served page repeats it in
   a `<meta>` tag.

**Red "Content Security Policy" lines in the console.** DevTools may show
red error lines that mention a Content Security Policy. That is the browser
refusing styles, scripts or links, for example ones found inside your
emails: the protection working. Nothing from your emails was run or loaded.
In WebKit (the engine behind Safari) the browser tests also see
one such line per policy when the page opens, caused by the page's own
time-zone drop-down list; it blocks nothing the page needs.

## Collapse, never delete

The tool never throws message text away on its own:

- **Folded, not deleted.** Quoted earlier emails ("On ... wrote:", "> "
  lines, Outlook-style "From: / Sent: / To:" blocks, also in French and
  Dutch) and signatures or notices (disclaimers) that a sender repeats are
  folded in the preview: greyed out, with a label, and can be opened. Every
  email can still be read in full in the preview, and your files are never
  changed.
- **What the PDF leaves out by default:** the quoted history the mail
  program added under a reply header, a signature or notice a sender
  repeats (it is kept the first time), and any part of an email that the
  PDF already prints as an email of its own (such as the emails a forward
  passes on), so no email is printed twice (an answer the writer typed
  next to a quote always stays, so a few can repeat). A forwarded email
  whose rebuilt email you unticked is left out too. A quoted part inside
  such a forwarded email that the tool could not rebuild is left out with
  it. Each folded part in the preview says
  "In the PDF" or "Not in the PDF" and why. The details, including the
  known edge cases, are under [R6](#r6-collapse-never-delete).
- **"Print full original text (quoted replies and signatures
  included)"**: this checkbox in step 2 puts every part of every ticked
  email in the PDF, quoted earlier emails included, so the same text may
  appear more than once. A short note under the checkbox says so, and that
  leaving it unticked gives a cleaner PDF. While it is ticked, "Rebuild
  conversation from replies" is unticked and greyed out, so no
  [rebuilt email](#earlier-emails-rebuilt-from-quoted-text) is shown or
  printed: their text is already in full in the email they come from.
- **Duplicates are merged only when provably identical:** same text,
  subject, attachment names and sender, plus the same Message-ID (with
  close dates) or the same date, and one copy's recipients and other
  header data must cover the other's (so nothing is lost by keeping it).
  Anything less, and both copies are kept, with a note. The page says how
  many copies were merged.
- **The cover page and the index.** The PDF's first page shows the title,
  the date range, the number of emails, the time zone used, the date the
  PDF was made and the people (rebuilt emails count in the number of
  emails, the date range and the people). The index follows directly
  below, on the same page when it fits, and goes on over as many pages as
  it needs. The PDF has no list of source files and no SHA-256
  fingerprints; each email you added names its file (and any identical
  copy merged into it) in its own "File" row. The cover says nothing about
  rebuilt emails. Files that could not be read are not in the PDF (step 1
  lists them, with the reason).
- **The PDF holds no notes.** The PDF is the final document: nothing in it
  says that something went wrong, may be missing or may be inaccurate, or
  explains how the tool works. All of that is shown in step 2 before you
  download: emails without a usable date and where they are placed, a
  date that could not be read (the PDF shows it as written), a sender's
  time zone that is not given, a time zone that was not recognized (the
  PDF then names just UTC), characters the PDF shows as codes such as
  "[U+0000]", an email the PDF prints whole because the tool could not tell
  what to leave out, text that could not be shown in full, identical
  copies merged (the "Also in" line), and what rebuilt emails are (under
  "Rebuild conversation from replies"). The PDF keeps only the
  placeholders for blank fields ("(no subject)", "(no date)", "Unknown
  sender", "(no text)"), its headings, labels, index, bookmarks and page
  numbers.
  After the cover information come the index (number, date, sender,
  subject, attachments, page) and the emails, with page numbers and PDF
  bookmarks. Every email
  (rebuilt ones included) starts at the top of a new page, its header
  included, so a short email may leave the rest of its page blank; a long
  one goes on over as many pages as it needs.
- Message text is never rewritten or summarised. (Rebuilt emails, below,
  lose only their "> " quote marks.)
- **No "> " quote marks in the PDF, one indent for every email text.** In
  the PDF, a line that starts with "> " quote marks (any number, in any
  form: ">", ">>", "> >", ">  >") is printed without them. The header of
  each email (Date, From, To, Subject and so on) stays at the left margin,
  and every line of its text is indented by the same single step, one tab
  (the width of 4 spaces of the text's font), quoted or not, whatever the
  quote level, wrapped lines too; so is "(no text)" for an email with no
  text. The attachment list stays at the margin
  with the header. Rebuilt emails look
  exactly like the others. The rest of each line is printed exactly as
  written (a ">" inside a line, as in "a > b", stays). Any line that starts
  with ">" is read as a quote, so a line starting with ">>> " (for example
  a pasted command prompt) is shown without the marks. Text copied out of
  the PDF has no quote levels. Only the PDF changes: the preview and your
  original files are unchanged.

## Earlier emails rebuilt from quoted text

People often have only the last email of a conversation, with the earlier
ones quoted inside it. The tool then reads those quotes and shows each
earlier email it can find as a separate email, in date order, in the
preview and in the PDF. In the preview, the email you added is not
changed: its quoted history stays in it, folded as usual. In the PDF, the
part of it that a rebuilt email prints is left out of it, so the same
email is not printed twice, except an answer the writer typed next to a
quote (see [R6](#r6-collapse-never-delete)); quoted header lines the
rebuilt email's header cannot show are printed, as written, at the top of
the rebuilt email's text. A forwarded email whose rebuilt email you
untick is left out of the forward in the PDF. With "Print full original
text" the email you added is printed whole.

**How they are marked.**

- **Preview:** a dashed card whose heading starts with "Rebuilt", with no
  number of its own, a "Taken from: email N" line and a fixed note: rebuilt
  from the quoted text of email N, may be incomplete or inexact. A short
  explanation under "Rebuild conversation from replies" says what rebuilt
  emails are. Check them here before you make the PDF.
- **PDF: not marked, by the user's choice.** In the PDF a rebuilt email
  looks exactly like an email you added: the same "Email N" heading, the
  same rows (From, To, Cc, Date, Subject), the same index line and
  bookmark, and nothing saying it was rebuilt (no note, no "Taken from",
  no marker, nothing on the cover). All emails in the PDF, rebuilt or not,
  are numbered 1, 2, 3... in date order, so two rebuilt earlier emails and
  the email you added are emails 1, 2 and 3 (the preview's "#N" numbers
  count only the emails you added, so they can differ). Its date is shown
  like a real email's: a quoted time without a time zone of its own is
  shown in the chosen zone with no note (the preview says "about ..."), a
  quoted day alone is shown as that day. The cover's number of emails, date range and people include
  rebuilt emails. A rebuilt email has no file, so it has no File row:
  only the File row shows which emails came from a file.

**What is changed, and what is not.** Sender, recipients, subject and date
are read from the quoted header ("From: / Sent: / To:", "On ... wrote:",
and their French and Dutch forms). In the text, only the "> " quote marks at
the start of the lines (and the spaces before them) are removed; words and
line breaks are kept exactly as quoted. A quoted date usually has no time
zone, so the time is a best guess, shown in the preview as "about ..." with
the date as written; a date that could be read two ways (such as
`03/04/2025`) is shown only as written (in the PDF too, alone in its Date
row, as for an email you added).

**When you also add the real earlier email**, the real file is used and
the rebuilt copy is not shown. This needs the same sender, dates that agree
and the same words (only a signature may differ); when in doubt, both are
shown, so an email may appear twice but is never wrongly hidden. An earlier
email quoted in several of your emails is shown once when the copies agree,
with a note naming the other emails.

**Choosing what goes in the PDF.** "Rebuild conversation from replies" in
step 2 (ticked by default) turns this on or off. Ticked: the emails you
added (their quoted history folded as usual) plus one rebuilt email per
earlier reply found. Unticked: only the emails you added, with no rebuilt
email in the list or in the PDF (the counts then do not mention rebuilt
emails at all, and an email's note that its quoted emails could not be
rebuilt is hidden too; both come back when you tick it again). The
switch is shown when rebuilt emails were found, and also when an email's
quoted emails could not be rebuilt (so that note can be shown again). Each
rebuilt email also has its own
checkbox. A rebuilt email stays in the PDF only while at least one ticked
email quotes it: when every email that quotes it is unticked, it leaves
the PDF too (its card says so). When the email named
in its "Taken from" line is unticked but another ticked email quotes the
same text, the PDF takes it from that other email, and the card says which.

**"Print full original text".** When this is ticked, every ticked email
is printed whole, its quoted earlier emails and signatures included.
"Rebuild conversation from replies" is then unticked and greyed out (a
screen reader hears why), so no rebuilt email is shown or printed, exactly
as when you untick it yourself: they would only repeat that quoted text.
The quoted text itself stays in the email it comes from, folded in the
preview and printed in full in the PDF. Nothing you chose is changed:
untick "Print full original text" and "Rebuild conversation from replies"
and every rebuilt email's checkbox come back exactly as you had set them
(if you had unticked "Rebuild conversation from replies" before, it stays
unticked).

**Limits.**

- It may be incomplete or inexact, and it is never a substitute for the
  original files: if a rebuilt email matters, find the original.
- When unsure, it rebuilds fewer emails rather than wrong ones. It stops at
  answers typed between quoted lines, replies written under the quote, and
  unusual quote formats; those quotes stay folded in the email that holds
  them.
- Quote headers are read in English, French and Dutch only.
- Text typed under an Outlook-style quote (without "> " marks) cannot be
  told apart from the quote: it ends up in the oldest rebuilt email.
- In an Outlook-style quote whose To or Cc list wraps over several lines
  and has names without addresses, only the first line of that list is
  read (marked "list may be incomplete" in the preview; not marked in the
  PDF). The header lines after it are then not read: **that rebuilt email
  has no subject** (the preview shows "subject not in the quote", the PDF
  "(no subject)"), and no Cc when the To list is the one that wraps.
  Those lines appear at the top of its text instead. In the
  test conversations this happened in Dutch Outlook quotes (2 of 11), but
  the rule is the same in every language. The text itself is not lost: it
  is all still in the email that quotes it.

### Accuracy on synthetic test conversations

Measured by `src/engine/reconstruct-measure.test.ts` and
`src/engine/rebuild-links.measure.test.ts` on 42 **synthetic**
conversations (166 emails, 124 of them quoted inside later ones), written
to imitate each mail program's quote style. These numbers say nothing
certain about real emails.

| Quote style | Quoted emails | Found | Precision | Text exact |
| --- | --- | --- | --- | --- |
| Outlook, English | 27 | 100% | 100% | 100% |
| Outlook, French | 17 | 100% | 100% | 100% |
| Outlook, Dutch | 11 | 100% | 100% | 82% (9 of 11) |
| Gmail, English | 22 | 100% | 100% | 100% |
| Gmail, French | 9 | 100% | 100% | 100% |
| Gmail, Dutch | 6 | 100% | 100% | 100% |
| Apple Mail, EN / FR / NL | 18 | 100% | 100% | 100% |
| Thunderbird, English | 6 | 100% | 100% | 100% |
| Forwards (Gmail, Apple Mail, Outlook) | 8 | 100% | 100% | 100% |

Precision 100%: every split was at a real quote header.
The two inexact texts (Outlook, Dutch) are the wrapped names-only list
described above: for those two, the subject and the end of the recipient
list were not read, and those lines are part of the rebuilt text.

- **False splits:** 0 on 8 texts that look like quotes but are not (the
  header finder used for folding alone would have split 4 of them).
- **Refused on purpose:** answers typed between quoted lines and replies
  under the quote (2 texts), and 2 conversations in shapes the tool does
  not rebuild (4 quoted emails): nothing rebuilt, nothing wrong.
- **All emails added (42 conversations):** 285 rebuilt emails, all 285
  matched to their real file, so none shown twice.
- **Only the last email added:** 124 of 124 earlier emails rebuilt, in the
  right order.
- **Some emails added (438 combinations):** no added or rebuilt email
  missing, none shown twice, all in the right order, and 0 wrong matches
  (678 matched to a real file, 314 to a copy quoted in another email).

## Known limits

- **Some writing systems show as codes in the PDF.** The PDF fonts (IBM
  Plex) cover Latin (accents included), Greek and Cyrillic. Other scripts,
  such as Hebrew, Arabic, Chinese, Japanese, Korean, Thai or Hindi, and
  emoji show as codes such as `[U+05D0]`. The monospaced font, used only
  for those codes, has no Greek. Control or
  broken characters are also shown as codes; step 2 notes it on each email
  that has them. The preview and your files are unchanged.
- **Attachments are listed, not included:** name, size and type only. They
  are never opened. A forwarded email attached to another one is listed
  the same way; its text is not shown.
- **File types:** `.eml` and `.msg` only. Mailbox files (`.mbox`, `.pst`,
  `.ost`) and Apple Mail's `.emlx` are not read.
- **A single email does not give the whole conversation.** If you add only
  the last email of a thread, the tool rebuilds the earlier emails quoted
  inside it when it safely can, but they are not the original emails and
  some may be missing (see
  [Earlier emails rebuilt from quoted text](#earlier-emails-rebuilt-from-quoted-text)).
  Add the earlier emails too when you have them.
- **Some email text cannot be shown:** a `.msg` whose text is saved only in
  Outlook's RTF format shows no text, and a very long formatted (HTML)
  email is cut short. The email carries a note saying so in step 2 (not
  in the PDF); the original file keeps everything.
- **Size and time limits:** 50 MB per file, 500 MB per batch; reading one
  file is stopped after 20 seconds. A file built to exhaust memory can
  still crash the tab, which is why `.msg` files get a structure check
  before they are read.
- **Safari and the keyboard:** by default, Safari's Tab key may skip links
  and some controls, such as the fold toggles. Use Option+Tab, or turn on
  "Press Tab to highlight each item on a webpage" in Safari's settings
  (Advanced).
- **After an update**, the first visit may still show the previous version
  (from the offline copy); the new one is used from the next reload.
- **CSP from a `<meta>` tag only:** on a host that cannot send HTTP
  headers (such as GitHub Pages), the page keeps its CSP through the
  `<meta>` tag. However, nothing stops other sites from showing it in a
  frame, there is no `Permissions-Policy`, and the service worker runs with
  no CSP at all (see [R2](#r2-strict-content-security-policy)).

## Disclaimer

This tool is provided as is, without any guarantee, and it is not legal
advice. Check the PDF before you send it. Your original email files remain
the reference.

## Privacy and security rules (R1 to R7)

These rules are non-negotiable and override convenience. The IDs are
stable: the code and tests cite them (for example `README.md, rule R1`).
R1 to R3 are enforced by the build check, lint and the browser tests. R4
and R5 are partly enforced the same way (HTML injection and storage APIs
are banned); the rest is followed by design. R6 and R7 are checked by the
unit tests; the synthetic-data part of R7 also by a guard test.

### R1: No network requests after the page loads

Once its own static files are loaded, the page makes no network requests:
no `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `sendBeacon`,
remote images, scripts, styles, fonts or frames. Everything is bundled and
self-hosted; no CDN. Remote content inside emails is never loaded. The only
outbound thing ever allowed is a plain link (donation or project
repository, with `rel="noopener noreferrer"`) that you click yourself.

One approved exception: the service worker fetches the site's own listed
files (when it installs, and again if a stored copy is missing), and the
browser asks for `/sw.js` to check for a new version. This site only.

### R2: Strict Content Security Policy

The browser enforces R1 through this policy, sent as an HTTP header (one
line, shown one directive per line here):

```text
default-src 'none';
script-src 'self';
style-src 'self';
img-src 'self' data: blob:;
font-src 'self';
connect-src 'none';
worker-src 'self' blob:;
form-action 'none';
base-uri 'none';
object-src 'none';
frame-src 'none';
frame-ancestors 'none'
```

No inline code and no `eval`. The policy may be tightened, never loosened.
The site also sends `Referrer-Policy: no-referrer` and a
`Permissions-Policy` that turns off features the page never uses (camera,
microphone, location, and so on). The single source of all of these is
`src/security/headers.ts`; the build writes them to `dist/_headers`
(Cloudflare Pages format).

- **Why `blob:`:** the files are read, and the PDF made, in Web Workers
  (separate, stoppable background tasks). Their code is built into the
  page's own script and started from `blob:` addresses, so they work
  offline right after the page has loaded. Such a worker takes the CSP of
  the page that started it, header and `<meta>` alike.
- **`/sw.js` has its own policy.** A service worker does not use the
  page's CSP but the one sent with its own script, and `connect-src
  'none'` would stop it from storing the site's files. So `/sw.js`, and
  only `/sw.js`, gets the same policy with `connect-src 'self'` (this site
  only). Its rule in `_headers` first removes the policy of `/*`
  (`! Content-Security-Policy`): otherwise both would be sent and the
  browser would apply both.
- **`<meta>` fallback and its limits.** The policy is repeated in a
  `<meta http-equiv="Content-Security-Policy">` tag, for hosts that cannot
  send headers. Browsers ignore some directives there (`frame-ancestors`,
  `report-uri`, `sandbox`). This project uses only `frame-ancestors`, which
  is therefore left out of the `<meta>` tag: protection against other sites
  showing the page in a frame exists only with the HTTP header. Also
  header-only: `Permissions-Policy` (it has no `<meta>` form) and the
  policy of `/sw.js`. A `<meta>` tag cannot reach a service worker script,
  so on a host that sends no headers the service worker runs with no CSP
  at all: its code is still the same build-checked file, but the browser
  no longer enforces its limits. The referrer policy is repeated as
  `<meta name="referrer" content="no-referrer">`.

### R3: Automated checks in the build and CI

- `npm run build` ends with `scripts/check-no-network.mjs`, which scans
  `src/`, `index.html` and the whole built site (`dist/`). It fails on a
  network API, a browser storage API, an HTML injection API in the build
  (`innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`), test
  code in the build, missing or wrong security headers, a missing or stale
  `dist/sw.js`, long encoded text (such as base64) that could hide code,
  or an `http(s)://` / `ws(s)://` URL not on a tiny allowlist. The workers
  are built into the page's script as text, so each built file is scanned
  twice: as it is, and with its text escapes undone.
- **URL allowlist** (`scripts/no-network-rules.mjs`): it may only ever hold
  the donation link, the repository link and license links. Today it holds
  only the Apache License and SIL Open Font License links, each allowed in
  `THIRD_PARTY_NOTICES.txt` only (and the SIL link in
  `src/fonts/LICENSE.txt`), rejected anywhere else.
- **One file exempt from two scans:** the service worker
  (`src/sw/service-worker.ts`, built as `dist/sw.js`) may call `fetch(`
  and use Cache Storage (`caches.`), to keep the site's own files. Every
  other rule applies to it, and both stay banned everywhere else
  (`RULE_EXEMPTIONS`).
- **Fonts:** the PDF fonts are built in as lists of numbers. The check
  fails if such a list appears anywhere but the font script, if a list is
  not exactly one of the committed font files (by SHA-256), if a font file
  in `src/fonts/` changed, or if the page does not load the font script at
  startup. This makes hiding code in numbers harder but does not catch
  every way of writing data down; the real barrier is the CSP (hidden code
  could neither send anything nor load more code).
- **Lint** (ESLint) bans network and storage APIs, HTML injection and
  every way to run a string as code.
- **Browser tests** (Playwright, `e2e/`) load the built site with its real
  headers and fail on any request outside the site, or any CSP violation,
  in the page or its workers. They also switch the network off after
  loading and check that the tool still works, and one test reloads the
  page offline from the service worker's copy and checks that copy holds
  exactly the site's own files. They run in Chromium, Firefox and WebKit.
  WebKit is Safari's engine but not Safari, so real Safari is checked by
  hand before a release.
- Dependencies are minimal, pinned to exact versions, with a committed
  lockfile; CI runs `npm audit`.

### R4: Email content is untrusted

HTML bodies are turned into plain text with an inert parser (one that runs
no scripts and loads nothing) and shown with `textContent`, never as HTML.
The page builds elements only through `src/ui/dom.ts`, which sets text only
through `textContent` and refuses event handler attributes and unsafe
URLs. Attachments are never opened or processed, only listed. Each file is
size-checked and read in a separate worker that is stopped after a time
limit, so a broken file gives an error message, not a crash (see
[Known limits](#known-limits) for the memory case).

### R5: In memory only

Message data, and anything made from it, stays in memory only: no
`localStorage`, `sessionStorage`, `IndexedDB`, cookies or Cache Storage.
Closing or reloading the tab wipes everything; "Clear everything" does the
same at any time. The language, time zone and checkbox choices are not
saved either. The offline copy keeps only the site's own static files.

### R6: Collapse, never delete

The tool never silently discards message content. Quoted history,
repeated signatures and disclaimers are folded, not removed. Message text
is never rewritten. Only provably identical duplicates are merged
(`src/engine/dedupe.ts`), and the page says how many were merged.

One deliberate exception, in the PDF only (`src/engine/output-plan.ts`):
by default the PDF shows what each writer actually wrote.

- **Left out:** the quoted history the mail program adds under a reply
  header ("On ... wrote:", or an Outlook-style "From: / Sent: / To:"
  block), and a signature or disclaimer a sender repeats (shown the first
  time). Also text pasted at the very end of an email, without "> " marks
  or a reply header, when it comes from another email that is in the PDF
  too.
- **No email twice:** a part of an email that the PDF prints as an email
  of its own is left out of it: an earlier email rebuilt from it (see
  [Earlier emails rebuilt from quoted text](#earlier-emails-rebuilt-from-quoted-text))
  that is in the PDF, or one the tool found to be an email you added that
  is in the PDF too. So a forward no longer prints the emails it passes on
  inside its own text when they also have their own pages; a forward with
  nothing of its own then shows "(no text)". Who wrote what comes first:
  - An answer the writer typed inside or below the part of a quoted email,
    which the tool told apart from the quote around it (text it takes for
    the writer's own, or a signature the PDF keeps, next to quoted text it
    could check), stays in the writer's own email with that whole part
    (its header lines, the quoted text and the answer), even where the
    rebuilt email prints it too, so an answer is never printed right under
    the quoted sender's "From:" line. A part the tool could not check at
    all (it holds no text it knows to be quoted, such as a middle email of
    an Outlook-style conversation when only the first and the last email
    are added) is left out like any other part: its rebuilt email prints
    it.
  - Two copies of one email may differ by a signature block at the end of
    one of them (a name and contact lines). When the copy left out has
    such a block and the email printed in its place does not, that block
    stays in the email it comes from, so it is not lost (where a quote is
    folded, it stays in that fold); only the words
    printed elsewhere are left out. The kept block sits under the other
    writer's own text, with no header above it; its name line shows who
    wrote it.
  - The quoted header lines ("From:", "Sent:", "To:", "Subject:"...) leave
    the email with that part. When the header the PDF prints for a
    rebuilt email cannot show everything they say, they are printed
    exactly as written at the top of that rebuilt email's text (only lines
    the PDF would have printed in the email they come from). That is the
    case when they hold a "Bcc:" line or a label written twice, when there
    is not exactly one sender ("Unknown sender", several senders), when no
    date could be found, when a To or Cc list may be incomplete, when the
    sender has no name (an "On ... wrote:" line that could not be read),
    when the date has no time zone of its own (the PDF shows an estimate),
    or when the tool read a wrapped To or Cc line or a Subject line of the
    header as the writer's own text. When the email they match is one you
    added, they are not printed again: that email's own header rows are
    its header. When the part's email is not in the PDF at all (see
    "Kept"), they stay where they are.
- **Left out on your choice:** a forwarded email whose rebuilt email you
  unticked (while "Rebuild conversation from replies" is on) is left out
  of the forward too: you chose not to have it in the PDF. A quoted part
  inside it that the tool could not rebuild is left out with it. Only a
  card you untick counts: a rebuilt email that is not in the PDF for
  another reason (its card could not be shown, say) leaves its forwarded
  text in the forward. The preview marks it "Not in the PDF: forwarded
  email whose rebuilt email is unticked", and "Print full original text"
  prints it.
- **Kept:** the writer's own text, quotes pasted without a reply header
  (except the case above), forwarded emails that are not printed as
  emails of their own for another reason (a forwarded part the tool could
  not rebuild at all, or all of them with "Rebuild conversation from
  replies" unticked: they stay inside the forward), quoted emails whose
  rebuilt email you unticked when they are not forwarded (they stay where
  the plan puts them), and answers typed between or below quoted lines. For an
  Outlook-style quote (no "> " marks), the tool compares the quote with
  the quoted email: when that email is in the PDF and anything after the
  "From: / Sent:" lines (a signature aside) is not part of it or of the
  emails it quotes, the whole email is kept, quote included, except the
  parts printed as emails of their own (above): a quoted email's part with
  no answer in it is left out when a rebuilt email or an email you added
  prints it; a part with an answer in it stays whole. One word, number or
  emoji is enough; a line of only punctuation (such as "--") is not. A
  short line such as "Yes." counts as part of the quote only where it
  stands, in the same order, in the quoted email. Text that only repeats
  the quoted emails is left out with the quote. An email is never left
  empty: if nothing else would remain, it is shown in full.
- **Known limit:** when the email quoted in an Outlook-style quote is not
  in the PDF, or is too short to check (a line or two), the tool cannot
  tell where the quote ends, so text typed inside or below it is left out
  with it. Rarely, a one-word answer such as "OK" right under a quoted line
  ending in "ok?" is taken for part of the quote, and a paragraph repeated
  from an earlier email of your own, placed between the "From: / Sent:"
  lines and the quote, is left out with it. Check the preview.
- **Known limit (repeats):** when unsure, the tool prints a text twice
  rather than lose it. An email can still appear twice when a rebuilt
  email could not be proved to be the same as an email you added (both
  are printed), when a forwarded part could not be rebuilt at all (it
  stays in the forward even if you added that email too), and when two of
  your emails both keep the same earlier email inside them because its
  rebuilt email is unticked. Also, by the rule above, the writer's own
  answer typed inside or below an Outlook-style quote is printed twice: in
  the writer's email, with the quoted part around it, and inside the
  rebuilt email of the quoted sender (the tool cannot tell where that
  quoted email ended).
- **Known limit (who wrote what):** when you add the first and the last
  email of an Outlook-style conversation but not the ones in between, the
  tool cannot check those middle emails, so it prints each once, as its
  rebuilt email, and leaves it out of the last email. If the last writer
  typed an answer inside such a middle email's quoted text, with nothing
  around it the tool knows to be quoted, that answer is printed inside
  the rebuilt email, under the quoted sender's header. Add the middle
  emails, or check the preview (it shows every email whole).

The preview marks each folded part "In the PDF" or "Not in the PDF" with
the reason, using the same rules as the PDF. Each part the PDF leaves out
of an email or folds in it because it prints that part as an email of its
own (see "No email twice" above) is marked "Not in this email in the PDF: printed as
email #N" (an email you added, by its number in the list) or "printed as a
rebuilt email (Email N in the PDF)" (a rebuilt email, by its heading in the
PDF); a forwarded email left out because you unticked its rebuilt email
is marked "Not in the PDF: forwarded email whose rebuilt email is
unticked". A quoted email's header lines and its text that get the same
mark are shown as one part with one mark (folded only when both were folded). When the tool keeps a whole email because it could not tell
its own text from the quote, the preview says so above it; if parts of
it are printed as emails of their own, the note says that everything
else is in the PDF. These marks come from the same calculation the PDF makes, so they
follow, after a short moment, when you tick or untick an email or a
rebuilt email, switch "Rebuild conversation from replies" on or off, or
switch "Print full original text (quoted replies and signatures
included)": turning it on removes the "printed as" marks, turning it off
brings them back. "Print full original text" puts every part in. While it is
ticked, "Rebuild conversation from replies" is unticked and greyed out and
no email rebuilt from quoted text is shown or printed: their text is then
already there, in full, in the email that quotes them, which keeps all of
it (folded in the preview, whole in the PDF). Unticking it brings back the
earlier choices exactly.

A second display change, in the PDF only (`src/pdf/text.ts`): the quote
marks at the start of a line (one or more ">", the spaces and invisible
characters before each, and one space or no-break space after the last)
are not printed. The invisible characters are the ones the PDF draws as
nothing: zero-width space and joiners, direction marks, the word joiner,
the soft hyphen and all variation selectors (U+FE00 to U+FE0F and U+E0100
to U+E01EF). Quote levels are not shown: every line of an email's text is
indented by one fixed step, one tab: the width of 4 normal spaces of the
body font at the body size, measured from the font
(`src/pdf/layout/config.ts`, `bodyIndentSpaces`; 9.44 pt with the
default 10 pt IBM Plex Sans), quoted or not, and so is the "(no text)"
placeholder; the header rows and the attachment list stay at the margin. The PDF stops
reading the marks at a vertical tab or form feed control, or at any other
character it prints as a code (such as a tag character, or a Hangul
filler or braille blank, which the PDF fonts cannot draw), except
whitespace (such as U+3000, which the fonts lack but which counts as a
space and is removed with the marks): that character is always printed
as its code. A ">" further on in a line is printed as it is, and so is
the rest of the line. A ">" where a printed part begins in the middle of
a line of the email is text, not a quote mark, and is printed. The text
copied out of the PDF follows the printed text (no ">" marks, no added
spaces). The preview and the original files are unchanged.

### R7: Detection logic is pure and testable

Detection logic (quotes, signatures, duplicates, ordering) is written as
pure functions with no page or DOM access, unit tested in isolation with
**synthetic** test emails. Real emails are never committed.

A guard test checks this on every `npm test`, for the test emails in
`tests/fixtures/` and the test code (`src/**/*.test.ts`, `e2e/`,
`tests/support/`, `scripts/**/*.test.*`). It fails on any email address,
web address or host name that is not a reserved test name (`*.test`,
`*.invalid`), any IP address outside the documentation and loopback
ranges, any home-folder path that could name a person, and any time-zone
name outside a short list of neutral zones. The few real addresses the
build-check tests need are listed one by one, with a reason, in
`tests/fixtures/guard-exemptions.ts`. See `tests/fixtures/README.md`.

## Offline copy (service worker)

The built site registers a service worker, `/sw.js` (source in `src/sw/`),
from its own script (no inline script), so the page can be reopened
without internet. `npm run dev` has none. If the browser refuses it, the
page works as before; it just cannot be reopened offline.

- **What it keeps:** only the site's own static files, in Cache Storage:
  the page (`/`), its scripts and styles (`assets/`, the PDF fonts script
  included) and `THIRD_PARTY_NOTICES.txt`. The build makes the list from
  the files it writes (every file of `dist/` except `_headers`,
  `_redirects`, `_routes.json`, `*.map` and `sw.js`), and versions it with
  a content hash of those files, the worker's code and `_headers`. The same
  build always gives the same `sw.js`.
- **What it never keeps:** your emails, the PDF, or anything made from
  them; they never reach it. It writes to its cache only when it installs,
  with exactly the listed files.
- **What it answers:** only `GET` requests of this site for a listed file,
  without a query string (`?...`, also after `#`). Everything else goes to
  the browser as if there were no service worker, under the page's CSP. A
  new version is stored under a new name, then its own older copies are
  deleted (never another cache). After an update, the first visit still
  shows the previous version; the next reload uses the new one.
- **"Clear everything"** does not touch it: it holds nothing of yours.
- **How to remove it:** delete this site's data in your browser (Chrome:
  Settings, Privacy and security, Site settings, the site, "Delete data";
  Firefox: the padlock in the address bar, "Clear cookies and site data").
  DevTools shows it under Application (Chrome) or Storage (Firefox).

## For developers

**Requirements:** Node.js 22 (the version CI uses) and npm. The browser
tests need Playwright's browsers, installed by a repo script (below).

| Command | What it does |
| --- | --- |
| `npm ci` | Install the exact dependency versions from the lockfile. |
| `npm run dev` | Local development server (without the CSP, which would block hot reload; no service worker). |
| `npm run build` | Build the site into `dist/`, then run the no-network check. |
| `npm run preview` | Serve `dist/` locally with the same security headers as production. Build first. |
| `npm run check:network` | Run the no-network check on the source and an existing `dist/`, without rebuilding. |
| `npm test` | Unit tests (Vitest), including the synthetic-data guard. `npm run test:watch` re-runs on change. |
| `npm run test:e2e:install` | Download Chromium, Firefox and WebKit into Playwright's own folder, outside the project (once, and after a Playwright update). On Linux, add `-- --with-deps` for the system packages. One browser only: `test:e2e:install:chromium`, `:firefox` or `:webkit`. |
| `npm run test:e2e` | Build, serve with the real headers, and run the browser tests in all three engines. |
| `npm run test:e2e:chromium` | The same in one engine (also `test:e2e:firefox`, `test:e2e:webkit`). |
| `npm run lint` | ESLint, including the privacy rules. |
| `npm run typecheck` | TypeScript type check. |

**Test data is synthetic only.** Never add, copy or "anonymize" a real
email. `.gitignore` ignores email files (`.eml`, `.msg`, `.mbox`, `.pst`,
`.emlx`, `.ost`, `.oft`, in any letter case) everywhere, with one narrow
exception for hand-written `.eml` fixtures in `tests/fixtures/`; `.msg`
fixtures are built in memory at test time. The guard test (R7) rejects
anything that looks real. Rules for new fixtures: `tests/fixtures/README.md`.

**Dependencies:** two direct run-time ones, `postal-mime` (reads `.eml`)
and `@kenjiuno/msgreader` (reads `.msg`, bundled with its own dependency
`@kenjiuno/decompressrtf`; its `iconv-lite` dependency is not shipped,
replaced by `src/shims/iconv-lite.ts`); the rest are development tools.
Direct dependencies are pinned to exact versions (`.npmrc` has
`save-exact=true`); the committed `package-lock.json` fixes every indirect
one, and `npm ci` installs exactly that. Add a dependency only when it is
clearly needed.

**CI** (`.github/workflows/ci.yml`, on every push and pull request): one
job runs `npm ci`, `npm audit`, type check, lint, unit tests and the build
with its no-network check; then one browser-test job per engine (Chromium,
Firefox, WebKit). Actions are pinned to full commit SHAs, and the workflow
can only read the repository.

**Bundled fonts:** the PDF uses IBM Plex Sans (Regular, Bold, Italic) and
IBM Plex Mono (Regular), stored unmodified in `src/fonts/` with their
license. They are not used for the page itself. The build turns them into
a script of their own, `assets/pdf-fonts-[hash].js` (about 1.2 MB, 440 kB
compressed), loaded with the page, because nothing can be downloaded once
the page has loaded. See R3 for how this script is checked.

**Third-party notices:** the licenses of the bundled libraries and fonts
are in `public/THIRD_PARTY_NOTICES.txt`, shipped with the site.

## Security note for maintainers

The most likely real-world attack is not on the code but on the accounts
around it: a hijacked domain, hosting or repository account could serve a
malicious version. Enable two-factor authentication on the domain
registrar, the hosting and the code hosting account, and keep the project
open source so anyone can compare what is served with the code.

## License

MIT, copyright 0x496D7065. See `LICENSE`.

The IBM Plex fonts are under the SIL Open Font License 1.1, copyright 2017
IBM Corp., with Reserved Font Name "Plex" (`src/fonts/LICENSE.txt`). Other
bundled libraries: see `public/THIRD_PARTY_NOTICES.txt`.
