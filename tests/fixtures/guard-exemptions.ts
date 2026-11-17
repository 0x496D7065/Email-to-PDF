// The ONLY places where the synthetic-data guard (README.md, rule R7)
// accepts a host that is not a reserved test name: exact, case-sensitive
// strings in one named file each, never a pattern. Every entry says why.
//
// All of them are in the self-test of the no-network build check, which
// must contain real URLs to prove that its allowlist accepts the approved
// license links and donation link and REJECTS everything else. None of them
// is personal data (the donation link holds only the project's public
// working name). Other tests take the donation link from the app's code
// (DONATION_URL in src/ui/dom.ts) instead of writing it out.
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
const DONATION = 'the Ko-fi donation link, the one entry of the global allowlist (user-approved), tested as allowed exactly';

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
    { file: NO_NETWORK_TEST, text: 'https://ko-fi.com/0x496d7065', reason: DONATION },
    { file: NO_NETWORK_TEST, text: String.raw`https:\/\/ko-fi.com\/0x496d7065`, reason: `${DONATION}, with escaped slashes as in a built script` },
    { file: NO_NETWORK_TEST, text: 'https://ko-fi.com/someone-else', reason: `${REJECTED}: another Ko-fi page` },
    { file: NO_NETWORK_TEST, text: 'http://ko-fi.com/0x496d7065', reason: `${REJECTED}: the donation link over http:` },
    { file: NO_NETWORK_TEST, text: 'https://storage.ko-fi.com/cdn/x.png', reason: `${REJECTED}: a Ko-fi image server address` },
    { file: NO_NETWORK_TEST, text: 'https://ko-fi.com/0X496D7065', reason: `${REJECTED}: the upper-case spelling of the donation link` },
];

/** The exempted strings for one file (path from the repository root). This file gets all of them. */
export function exemptionsFor(file: string): string[]
{
    return GUARD_EXEMPTIONS.filter((e) => file === EXEMPTIONS_FILE || e.file === file).map((e) => e.text);
}
