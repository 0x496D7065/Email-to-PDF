// The ONLY places where the synthetic-data guard (README.md, rule R7)
// accepts a host that is not a reserved test name: exact, case-sensitive
// strings in one named file each, never a pattern. Every entry says why.
//
// All of them are in the self-test of the no-network build check, which
// must contain real URLs to prove that its allowlist accepts the approved
// license links and REJECTS everything else. None of them is personal data.
//
// This file itself necessarily contains every exempted string, so the guard
// blanks all of them here too (exemptionsFor below). test-code-guard.test.ts
// fails if an entry is no longer found in its file, so the list cannot grow
// stale.

/** One exemption: `text` is ignored by the guard, but only inside `file` (a path from the repository root). */
export interface GuardExemption {
  readonly file: string;
  readonly text: string;
  readonly reason: string;
}

/** This file, as a path from the repository root. */
export const EXEMPTIONS_FILE = 'tests/fixtures/guard-exemptions.ts';

const NO_NETWORK_TEST = 'scripts/no-network-rules.test.ts';
const REJECTED = 'a URL the no-network build check must REJECT (not on its allowlist)';
const LICENSE = 'a license URL on the build check allowlist (approved), tested as allowed in its own file only';

export const GUARD_EXEMPTIONS: readonly GuardExemption[] = [
  { file: NO_NETWORK_TEST, text: 'https://example.com/x.png', reason: REJECTED },
  { file: NO_NETWORK_TEST, text: 'http://example.org', reason: REJECTED },
  { file: NO_NETWORK_TEST, text: 'http://www.apache.org/licenses/', reason: LICENSE },
  { file: NO_NETWORK_TEST, text: 'HTTP://WWW.APACHE.ORG/licenses/', reason: `${REJECTED}: the upper-case spelling of a license URL` },
  { file: NO_NETWORK_TEST, text: 'http://scripts.sil.org/OFL', reason: LICENSE },
  { file: NO_NETWORK_TEST, text: 'https://scripts.sil.org/OFL', reason: `${REJECTED}: a variant of a license URL` },
  { file: NO_NETWORK_TEST, text: 'http://scripts.sil.org/', reason: `${REJECTED}: a variant of a license URL` },
  { file: NO_NETWORK_TEST, text: 'https://openfontlicense.org', reason: `${REJECTED}: a look-alike of a license URL` },
  { file: NO_NETWORK_TEST, text: "includes('sil.org')", reason: 'selects the font license entries from the allowlist' },
];

/** The exempted strings for one file (path from the repository root). This file gets all of them. */
export function exemptionsFor(file: string): string[] {
  return GUARD_EXEMPTIONS.filter((e) => file === EXEMPTIONS_FILE || e.file === file).map((e) => e.text);
}
