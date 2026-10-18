# Local Email-to-PDF Tool

A free, MIT-licensed web app that runs **100% in your browser**. You drop in
exported email files (`.eml` and `.msg`), check a preview, and download one
clean PDF: messages in chronological order, duplicates merged, repeated quoted
text folded, and an index on the first page. **Nothing leaves your computer**:
there is no server, no account, and no upload.

## Status

Early development. Milestone 1 (project skeleton with security checks) is in
place: an empty page, a strict Content Security Policy, and automated checks
that no network code is shipped. Email parsing, the preview and the PDF export
are **not built yet**, so the tool is **not usable yet**.

## Privacy & security rules

These rules are non-negotiable and override convenience. The IDs (`R1` to `R7`)
are stable: the code and tests cite them, e.g. `README.md, rule R1`.

R1 to R3 are enforced mechanically, by the build check, lint and browser
tests. R4 and R5 are partly enforced the same way (HTML injection and
browser storage APIs are banned by lint and the build check); the rest of them
is followed by design. R6 and R7 are followed by design and checked by the
unit tests of the detection code in `src/engine/`. All code must follow every
rule.

### R1: No network requests after the page loads

Once its own static files are loaded, the tool page makes no network requests
at all. No `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
`sendBeacon`, remote images, scripts, styles, fonts or frames. Everything
(code, styles, fonts) is bundled and self-hosted; no CDN. Remote content inside
emails (tracking pixels, remote images) is never loaded. The only outbound
thing ever allowed is a plain link (the donation or project repository link,
with `rel="noopener noreferrer"`) that you click yourself, never a script,
widget or frame.

### R2: Strict Content Security Policy

The browser itself enforces R1 through a strict Content Security Policy (CSP):
`default-src 'none'`, `connect-src 'none'`, scripts, styles and fonts only from
the site itself, no inline code, no `eval`. It is sent as an HTTP header and
repeated in a `<meta>` tag as a fallback (see the CSP note below). The site
also sends `Referrer-Policy: no-referrer` and a `Permissions-Policy` that turns
off features the app never uses (camera, microphone, location, ...). The policy
may be tightened, never loosened.

The full policy, as sent in the HTTP header (one line in reality, with the
directives separated by `; `; shown one per line here for readability):

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

`frame-ancestors 'none'` is header-only: it is left out of the `<meta>`
fallback because browsers ignore it there.

### R3: Automated checks in the build and CI

- `npm run build` fails if the source or the built site contains a network
  API, a browser storage API, an `http(s)://` or `ws(s)://` URL that is not on
  a tiny allowlist, test code, or missing security headers. The allowlist may
  only ever hold the donation link, the project's repository link, and license
  links, only in code comments, in the shipped third-party license notices
  file, or in a license file kept next to the bundled files it covers.
  Today it holds only license links: the Apache License links
  `http://www.apache.org/licenses/` and
  `http://www.apache.org/licenses/LICENSE-2.0`, allowed only inside
  `THIRD_PARTY_NOTICES.txt`, and the SIL Open Font License link
  `http://scripts.sil.org/OFL`, allowed only inside
  `THIRD_PARTY_NOTICES.txt` and `src/fonts/LICENSE.txt`. Each is rejected
  anywhere else.
- The PDF fonts are built into the site as plain lists of numbers (see
  "Bundled fonts" below). A long list of numbers could hide code just as
  well, so the build check fails if one appears anywhere but the font file,
  if a list there is not exactly one of the official font files (compared by
  SHA-256), if a font file in `src/fonts/` was changed, or if the page does
  not load the font file at startup. Any way of writing a number counts
  (negative, decimal, hex, and so on). This makes hiding code in lists of
  numbers harder, but it is not the real barrier: that is the CSP
  (`connect-src 'none'` and `script-src 'self'`, so hidden code could
  neither send anything out nor load more code) together with the scans for
  network APIs above. This check does not catch every possible way of
  writing data down, for example many short lists joined together, or
  numbers written as text.
- The same build check also fails if the built site contains an HTML
  injection API (such as `innerHTML`, `outerHTML`, `insertAdjacentHTML` or
  `document.write`), as a backstop for rule R4.
- The Web Worker code is built into the page's script as text (see the CSP
  note), so the check scans each built file twice: as it is, and with its
  text escapes (such as `\n`) undone, so the worker code is checked too.
- A browser test (Playwright, Chromium) loads the built site and fails if it
  makes any request outside its own site or triggers any CSP violation. It
  also switches the network off right after loading and checks that adding
  files still gives the full result.
- CI runs `npm audit`, type checking, lint, unit tests, the build check and
  the browser test on every push.
- Dependencies are kept minimal, pinned to exact versions, with a committed
  lockfile.

### R4: Email content is untrusted

Email content is treated as untrusted input. HTML bodies are converted to plain
text with an inert parser (one that runs no scripts and loads nothing) and
shown with `textContent`, never injected as HTML. Attachments are never
opened, executed or processed: they are only listed (name, size, type).
Broken or huge files produce a clear error message instead of a crash: each
file is checked, size-limited, and read in a separate worker that is stopped
after a time limit. One known limit: a file that makes a parser exhaust
memory can still crash the tab, which is why `.msg` files get a structure
check before they are read.

ESLint rejects every HTML injection API and every way to run a string as code
(`eval`, `new Function`, string timers). The one way the interface builds
elements is `src/ui/dom.ts`, which sets text only through `textContent` and
refuses event handler attributes and unsafe URLs.

### R5: In memory only

Message data, and anything derived from it, stays in memory only: no
`localStorage`, `sessionStorage`, `IndexedDB`, cookies or cache storage.
Closing or reloading the tab wipes everything, and the visible "Clear
everything" button does the same at any time. If an offline (service worker)
version is added, it caches only the app's own files, never your data.

### R6: Collapse, never delete

The tool never silently discards message content. Quoted history, repeated
signatures and disclaimers are **folded** (greyed out, expandable), not
removed, so a wrong guess loses nothing. Message text is never rewritten. Only
**provably identical** duplicate messages are merged, and the preview says how
many were merged. You can choose to include everything unfolded.

### R7: Detection logic is pure and testable

Detection logic (quotes, signatures, duplicates, ordering) is written as pure
functions with no page or DOM access, so each one can be unit tested in
isolation with synthetic test emails. Real emails are never committed.

## Non-goals

- No AI, LLM or cloud processing.
- No accounts, login or backend.
- No analytics, telemetry or third-party scripts.
- No email-client integration (no mailbox login): input is files only.
- No editing, composing or sending of email.
- No payments, license keys or usage limits.

## How the privacy model works, and how to verify it

Everything happens in your browser tab: the files you drop are read locally
and the PDF is generated locally. The rules above are enforced three ways: by
the code itself, by the browser (the CSP blocks network requests even if code
tried to make them), and by automated tests that fail the build.

Be aware that trust ultimately depends on **the code that is actually served**.
If the hosting or the repository were ever compromised, a different version
could be served. You do not have to take our word for it; a technical person
can check:

1. **Watch the network:** open your browser's DevTools, go to the Network tab,
   then use the tool. After the page has loaded, no new requests should appear.
2. **Run it offline:** open the page, disconnect from the internet (or
   enable "Offline" in DevTools), then add your files: everything still
   works, because the tool never needs the network once the page has loaded.
   Do not reload the page while offline: reloading has to download the page
   again, which needs the network (a version that can also start offline may
   come later).
3. **Read the source:** the code is MIT-licensed; once the repository is
   public you can read it. The security headers live in
   `src/security/headers.ts`, the build check in `scripts/`, and the browser
   test in `e2e/`.

## CSP note

The Content Security Policy is delivered twice: as a real HTTP header (through
the `_headers` file that the build writes for Cloudflare Pages) and as a
`<meta>` tag in the page, as a fallback for hosts that cannot send headers.
Browsers **ignore** some directives in a `<meta>` tag (`frame-ancestors`,
`report-uri`, `sandbox`). This means protection against other sites embedding
the page in a frame only exists when the HTTP header is served.

The tool reads each file in a Web Worker (a separate, stoppable background
task). The worker code is built into the page's own script and started from a
`blob:` URL, which `worker-src 'self' blob:` allows; this is what lets the
tool keep working offline right after the page has loaded. A worker started
this way takes the CSP of the page that started it, from the HTTP header and
from the `<meta>` tag alike, so the workers are covered by the same policy
even on a host that can only use the `<meta>` fallback.

The referrer policy is covered by both: the build also adds
`<meta name="referrer" content="no-referrer">` to the page. `Permissions-Policy`
has no `<meta>` form at all, so it only applies when the HTTP headers are
served.

## Bundled fonts

The PDF uses the IBM Plex fonts (Sans Regular, Bold and Italic, and Mono
Regular), stored in `src/fonts/` as the official, unmodified WOFF files,
with their license (SIL Open Font License 1.1) in `src/fonts/LICENSE.txt`.
They are not used to display the page itself.

The build turns each font file into a list of numbers (its exact bytes) in a
script file of its own, `assets/pdf-fonts-[hash].js` (about 1.2 MB, 440 kB
compressed), and the page's main script imports it, so the browser loads it
together with the page, like any other script of the site. Why this way:
the tool never downloads anything once the page has loaded (the CSP's
`connect-src 'none'` would block it anyway), so the fonts have to arrive with
the page. The build check rejects long encoded text (such as base64) because
it could hide code; the lists of numbers are checked instead, and must be
exactly the official font files and nothing else (see rule R3).

## Development

Tested with Node.js 22 (the version CI uses).

| Command | What it does |
| --- | --- |
| `npm ci` | Install the exact dependency versions from the lockfile. |
| `npm run dev` | Start the local development server (without the CSP, which would block hot reload). |
| `npm run build` | Build the site into `dist/`, then run the no-network check. |
| `npm run preview` | Serve the built site from `dist/` locally, with the same security headers as production. Run `npm run build` first. |
| `npm run check:network` | Run the no-network check on the source and an existing `dist/`, without rebuilding. |
| `npm test` | Run the unit tests (Vitest). |
| `npm run test:e2e` | Build the site, then run the browser test against it (Playwright). Run `npx playwright install chromium` once first. |
| `npm run lint` | Run ESLint, including the privacy early-warning rules. |
| `npm run typecheck` | Check the TypeScript types. |

## License

MIT, copyright 0x496D7065. See `LICENSE`.

Licenses of the bundled third-party libraries and fonts are in
`public/THIRD_PARTY_NOTICES.txt`, shipped with the site as `THIRD_PARTY_NOTICES.txt`.
The IBM Plex fonts are under the SIL Open Font License 1.1, copyright 2017
IBM Corp., with Reserved Font Name "Plex" (see `src/fonts/LICENSE.txt`).

This tool is provided as is, without warranty, and is not legal advice. Always
check the generated PDF before relying on it.
