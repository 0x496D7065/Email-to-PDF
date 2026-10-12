// Pure matching logic for the "no network" build check (PROJECT_BRIEF.md 6.3).
//
// No file system access here: every function takes a string and returns a
// list of findings, so it can be unit tested with synthetic strings
// (see no-network-rules.test.ts). check-no-network.mjs does the file reading.
//
// This file necessarily contains the banned words (as regexes and messages),
// so the check never scans the scripts/ folder itself.

/**
 * http:// and https:// URLs that are allowed to appear anywhere in src/,
 * index.html or dist/. Compared EXACTLY (after trimming trailing punctuation).
 *
 * PROJECT_BRIEF.md 6.3: the ONLY URLs ever allowed here are
 *   - the donation link (a plain <a href> the user clicks deliberately),
 *   - the GitHub repository link,
 *   - license links in comments.
 * Nothing else: no CDN, font, analytics or API URL, ever.
 * Empty for now because none of those links exist yet. Example entry:
 *   'https://github.com/OWNER/REPO',
 */
export const URL_ALLOWLIST = [];

const network = 'Network API (PROJECT_BRIEF.md 6.1, 6.3)';
const storage = 'Browser storage API: message data must stay in memory (PROJECT_BRIEF.md 6.5)';
const testCode = 'Test code in the build output (tests must never ship)';

/**
 * Forbidden patterns. `distOnly` rules are applied to dist/ only.
 * `(?<![\w$])` = "not preceded by a letter, digit, _ or $", so `fetch(`,
 * `fetch (` and `window.fetch(` all match but `prefetch(` does not.
 */
export const RULES = [
  { pattern: /(?<![\w$])fetch\s*\(/g, reason: network },
  { pattern: /\bXMLHttpRequest\b/g, reason: network },
  { pattern: /\bWebSocket\b/g, reason: network },
  { pattern: /\bEventSource\b/g, reason: network },
  { pattern: /\bsendBeacon\b/g, reason: network },
  { pattern: /\bimportScripts\b/g, reason: network },
  { pattern: /\blocalStorage\b/g, reason: storage },
  { pattern: /\bsessionStorage\b/g, reason: storage },
  { pattern: /\bindexedDB\b/g, reason: storage },
  { pattern: /\bdocument\s*\.\s*cookie\b/g, reason: storage },
  { pattern: /(?<![\w$])caches\s*\./g, reason: storage },
  { pattern: /\bvitest\b/g, reason: testCode, distOnly: true },
  { pattern: /(?<![\w$])describe\s*\(/g, reason: testCode, distOnly: true },
];

// A URL runs until whitespace, a quote, a backtick, <, > or a closing bracket.
// Schemes: http(s) and ws(s) (WebSocket, PROJECT_BRIEF.md 6.1). Each slash may be
// escaped as \/ (minified bundles, embedded JSON); normalizeUrl() undoes that.
const URL_PATTERN = /(?:https?|wss?):(?:\\?\/){2}[^\s"'`<>)\]]*/gi;
const URL_REASON = 'URL not in the allowlist in scripts/no-network-rules.mjs (PROJECT_BRIEF.md 6.3)';

/**
 * Turns a raw URL match into the form compared against URL_ALLOWLIST:
 * unescapes \/ to /, then drops trailing sentence punctuation and any
 * trailing backslash (left over from an escaped quote) that is probably
 * not part of the URL.
 * @param {string} raw
 * @returns {string}
 */
export function normalizeUrl(raw) {
  return raw.replace(/\\\//g, '/').replace(/[.,;:!?\\]+$/, '');
}

/**
 * Finds every forbidden pattern and non-allowlisted URL in `text`.
 * @param {string} text  File contents.
 * @param {{ isDist: boolean }} options  isDist enables the dist-only rules.
 * @returns {{ line: number, match: string, reason: string }[]}  line is 1-based.
 */
export function findViolations(text, { isDist }) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((lineText, index) => {
    for (const rule of RULES) {
      if (rule.distOnly && !isDist) continue;
      for (const m of lineText.matchAll(rule.pattern)) {
        findings.push({ line: index + 1, match: m[0], reason: rule.reason });
      }
    }
    for (const m of lineText.matchAll(URL_PATTERN)) {
      const url = normalizeUrl(m[0]);
      if (!URL_ALLOWLIST.includes(url)) {
        findings.push({ line: index + 1, match: url, reason: URL_REASON });
      }
    }
  });
  return findings;
}

/**
 * Structural checks on dist/index.html. Returns a list of problems (empty = OK).
 * @param {string} html
 * @returns {string[]}
 */
export function checkBuiltHtml(html) {
  const problems = [];
  const metaStart = '<meta http-equiv="Content-Security-Policy"';
  const metaIndex = html.indexOf(metaStart);
  if (metaIndex === -1) {
    return [`missing ${metaStart} ... > (PROJECT_BRIEF.md 6.2)`];
  }
  // A <meta> CSP only protects what comes AFTER it in the document.
  for (const tag of ['<script', '<link']) {
    const tagIndex = html.indexOf(tag);
    if (tagIndex !== -1 && tagIndex < metaIndex) {
      problems.push(`the CSP <meta> must come before the first ${tag} tag (PROJECT_BRIEF.md 6.2)`);
    }
  }
  const content = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? '';
  for (const directive of ["default-src 'none'", "connect-src 'none'"]) {
    if (!content.includes(directive)) {
      problems.push(`the CSP <meta> is missing "${directive}" (PROJECT_BRIEF.md 6.2)`);
    }
  }
  return problems;
}

/**
 * Structural checks on dist/_headers (Cloudflare Pages). Returns problems.
 * @param {string} text
 * @returns {string[]}
 */
export function checkHeadersFile(text) {
  const problems = [];
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const csp = lines.find((line) => line.startsWith('Content-Security-Policy:'));
  if (csp === undefined) {
    problems.push('missing Content-Security-Policy: header (PROJECT_BRIEF.md 6.2)');
  } else {
    for (const directive of ["default-src 'none'", "connect-src 'none'", "frame-ancestors 'none'"]) {
      if (!csp.includes(directive)) {
        problems.push(`Content-Security-Policy header is missing "${directive}" (PROJECT_BRIEF.md 6.2)`);
      }
    }
  }
  if (!lines.includes('Referrer-Policy: no-referrer')) {
    problems.push('missing "Referrer-Policy: no-referrer" header (PROJECT_BRIEF.md 6.2)');
  }
  if (!lines.some((line) => line.startsWith('Permissions-Policy:'))) {
    problems.push('missing Permissions-Policy: header (PROJECT_BRIEF.md 6.2)');
  }
  return problems;
}
