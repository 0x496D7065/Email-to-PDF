# Test fixtures (synthetic only)

Every file in this folder is **made up** for the tests. None of it is, or may
ever be, a real email.

Rules for adding a fixture:

- Write it by hand (or generate it) from scratch. Never copy, edit or
  "anonymize" a real email: anonymizing by hand is easy to get wrong.
- Use only reserved test domains that can never belong to a real person:
  `example.test` and `.invalid` (for example `alice@example.test`,
  `bob@mail.invalid`).
- Use obviously fake names (Alice, Bob, Carol...) and invented content.
- No real phone numbers, postal addresses, account numbers or names.

Why here and not in `src/`: nothing in this folder is part of the app, so it is
never bundled into the published site.

`.gitignore` ignores `.eml` and `.msg` files, in any letter case, everywhere (to protect real emails)
except inside this folder, so fixtures can be committed. Do not widen that
exception.
