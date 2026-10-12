# Test fixtures (synthetic only)

Every fixture in this folder is **made up** for the tests. None of it is, or
may ever be, a real email. Nothing here is part of the app, so it is never
bundled into the published site.

## What lives here

| Path                      | What it is                                                         |
| ------------------------- | ------------------------------------------------------------------ |
| `eml/*.eml`               | Hand-written `.eml` test emails, stored on disk.                   |
| `msg/specs.ts`            | `.msg` test emails as plain data (one spec per message).           |
| `msg/builder.ts`          | Turns a spec into real `.msg` bytes **in memory** at test time.    |
| `manifest.ts`             | The expected parse result of every fixture (`.eml` and `.msg`).    |
| `manifest.test.ts`        | Checks that `manifest.ts` matches the fixtures.                    |
| `guard-rules.ts`          | The privacy checks (pure functions).                               |
| `synthetic-guard.test.ts` | Runs the privacy checks on every file here, plus their self-tests. |

There are **no `.msg` files on disk**, and there must never be: `.gitignore`
ignores `.msg` everywhere, including here. Only `.eml` has an exception, and
only inside `tests/fixtures/`. Do not widen it.

## Adding a fixture

1. Write it from scratch. Never copy, edit or "anonymize" a real email:
   anonymizing by hand is easy to get wrong.
2. `.eml`: save it in `eml/`. It must
   - be 7-bit ASCII only (encode accents with quoted-printable, base64 or
     RFC 2047 encoded words),
   - have the header `X-Synthetic-Fixture: true` in its top-level headers.
3. `.msg`: add a spec to `msg/specs.ts`. The builder adds the synthetic
   marker property for you.
4. Add one entry for it to `manifest.ts` (every fixture must be listed, once).
5. Run `npm test`.

## Content rules

- Domains: only reserved test names ending in `.test` or `.invalid`
  (for example `alice@example.test`, `https://cdn.invalid/x.png`).
- IP addresses: only documentation ranges `192.0.2.0/24`, `198.51.100.0/24`,
  `203.0.113.0/24`, `2001:db8::/32`, and loopback (`127.0.0.0/8`, `::1`).
- Obviously fake names (Alice Example, Bob Sample, Carol Test...) and bland,
  invented content (for example an office-furniture order and delivery).
- No real phone numbers, postal addresses, account numbers or names.
- Nothing that points to a specific country (tax rates, local rules, place
  names).
- Allowed file types here: `.eml`, `.ts`, `.md`. No hidden (dot) files or
  folders.

## What the guard test rejects

`synthetic-guard.test.ts` fails if any file here has:

- a file type other than `.eml`, `.ts` or `.md`, or a dot-file / dot-folder,
- an `.eml` that is not 7-bit ASCII or lacks `X-Synthetic-Fixture: true`,
- an email address, Message-ID, URL (also `//host/...`), `www.` host or
  bare host name with a common real top-level domain (`.com`, `.fr`, ...)
  that is not `*.test` / `*.invalid`, or an IP outside the ranges above.
  It also looks inside base64 (including attached messages),
  quoted-printable, RFC 2047, HTML character references (`&#64;`) and
  percent-encoding (`%40`),
- a `.msg` spec that breaks these rules, or a built `.msg` without the marker,
- a `manifest.ts` that does not list exactly the `.eml` files and `.msg` specs.
