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

**Status:** working and tested, not yet released. Rebuilding a whole
conversation from a single email (from the quotes inside it) is planned for
later.

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

**Red "Content Security Policy" lines in the console.** While emails are
read, DevTools may show red error lines that mention a Content Security
Policy. That is the browser blocking styles, scripts or links found inside
the emails: the protection working. Nothing from the emails was run or
loaded. In WebKit (the engine behind Safari) the browser tests also see
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
  program added under a reply header, and a signature or notice a sender
  repeats (it is kept the first time). Each folded part in the preview says
  "In the PDF" or "Not in the PDF" and why. The details, including the
  known edge cases, are under [R6](#r6-collapse-never-delete).
- **"Put everything in the PDF (leave nothing out)"**: this checkbox in
  step 2 puts every part of every ticked email in the PDF.
- **Duplicates are merged only when provably identical:** same text,
  subject, attachment names and sender, plus the same Message-ID (with
  close dates) or the same date, and one copy's recipients and other
  header data must cover the other's (so nothing is lost by keeping it).
  Anything less, and both copies are kept, with a note. The page says how
  many copies were merged.
- **Every source file in the PDF is accounted for.** The PDF's cover page
  lists the date range, the people, the number of emails, the time zone
  used, and every file that gave an email in the PDF (merged copies
  included) with its SHA-256 fingerprint, so anyone can check that a file
  is exactly the one used. Files that could not be read are listed too.
  Then come the index (number, date, sender, subject, attachments, page)
  and the emails, with page numbers and PDF bookmarks.
- Message text is never rewritten or summarised.

## Known limits

- **Some writing systems show as codes in the PDF.** The PDF fonts (IBM
  Plex) cover Latin (accents included), Greek and Cyrillic. Other scripts,
  such as Hebrew, Arabic, Chinese, Japanese, Korean, Thai or Hindi, and
  emoji show as codes such as `[U+05D0]`. The monospaced font, used only
  for the SHA-256 fingerprints and those codes, has no Greek. Control or
  broken characters are also shown as codes, and the cover page counts
  them. The preview and your files are unchanged.
- **Attachments are listed, not included:** name, size and type only. They
  are never opened. A forwarded email attached to another one is listed
  the same way; its text is not shown.
- **File types:** `.eml` and `.msg` only. Mailbox files (`.mbox`, `.pst`,
  `.ost`) and Apple Mail's `.emlx` are not read.
- **A single email does not give the whole conversation.** If you add only
  the last email of a thread, the earlier emails quoted inside it are
  folded and, by default, left out of the PDF. Add the earlier emails too,
  or tick "Put everything in the PDF".
- **Some email text cannot be shown:** a `.msg` whose text is saved only in
  Outlook's RTF format shows no text, and a very long formatted (HTML)
  email is cut short. The email carries a note saying so; the original file
  keeps everything.
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
- **Kept:** the writer's own text, quotes pasted without a reply header
  (except the case above), forwarded emails, and answers typed between or
  below quoted lines. For an Outlook-style quote (no "> " marks), the tool
  compares the quote with the quoted email: when that email is in the PDF
  and anything after the "From: / Sent:" lines (a signature aside) is not
  part of it or of the emails it quotes, the whole email is kept, quote
  included. One word, number or emoji is enough; a line of only
  punctuation (such as "--") is not. A short line such as "Yes." counts as
  part of the quote only where it stands, in the same order, in the quoted
  email. Text that only repeats the quoted emails is left out with the
  quote. An email is never left empty: if nothing else would remain, it is
  shown in full.
- **Known limit:** when the email quoted in an Outlook-style quote is not
  in the PDF, or is too short to check (a line or two), the tool cannot
  tell where the quote ends, so text typed inside or below it is left out
  with it. Rarely, a one-word answer such as "OK" right under a quoted line
  ending in "ok?" is taken for part of the quote, and a paragraph repeated
  from an earlier email of your own, placed between the "From: / Sent:"
  lines and the quote, is left out with it. Check the preview.

The preview marks each folded part "In the PDF" or "Not in the PDF" with
the reason, using the same rules as the PDF, and "Put everything in the PDF
(leave nothing out)" puts every part in.

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
