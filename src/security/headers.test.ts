import { describe, expect, it } from 'vitest';
import { cloudflareHeadersFile, cspForHeader, cspForMeta, PERMISSIONS_POLICY } from './headers';

// The exact policy from PROJECT_BRIEF.md 6.2. If this test fails, the policy
// was changed: loosening it needs the user's explicit approval.
const EXPECTED: Record<string, string> = {
  'default-src': "'none'",
  'script-src': "'self'",
  'style-src': "'self'",
  'img-src': "'self' data: blob:",
  'font-src': "'self'",
  'connect-src': "'none'",
  'worker-src': "'self' blob:",
  'form-action': "'none'",
  'base-uri': "'none'",
  'object-src': "'none'",
  'frame-src': "'none'",
};

/** "a x; b y z" -> { a: "x", b: "y z" } */
function parse(policy: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of policy.split(';')) {
    const [name = '', ...sources] = part.trim().split(/\s+/);
    if (name) result[name] = sources.join(' ');
  }
  return result;
}

describe('Content Security Policy', () => {
  it('meta version is exactly the brief policy', () => {
    expect(parse(cspForMeta())).toEqual(EXPECTED);
  });

  it('header version adds only frame-ancestors none', () => {
    expect(parse(cspForHeader())).toEqual({ ...EXPECTED, 'frame-ancestors': "'none'" });
  });

  it('never allows inline code, eval, remote hosts or wildcards', () => {
    for (const policy of [cspForHeader(), cspForMeta()]) {
      expect(policy).not.toMatch(/unsafe-|http:|https:|\*|nonce-|sha\d+-/);
      // It is written inside a double-quoted HTML attribute.
      expect(policy).not.toContain('"');
    }
  });
});

describe('_headers file', () => {
  it('sends the CSP, referrer and permissions headers for every path', () => {
    const lines = cloudflareHeadersFile().split('\n');
    expect(lines).toContain('/*');
    expect(lines).toContain(`  Content-Security-Policy: ${cspForHeader()}`);
    expect(lines).toContain('  Referrer-Policy: no-referrer');
    expect(lines).toContain(`  Permissions-Policy: ${PERMISSIONS_POLICY}`);
  });

  it('disables powerful features like camera and geolocation', () => {
    expect(PERMISSIONS_POLICY).toContain('camera=()');
    expect(PERMISSIONS_POLICY).toContain('geolocation=()');
    expect(PERMISSIONS_POLICY).not.toMatch(/\*|self|"/);
  });
});
