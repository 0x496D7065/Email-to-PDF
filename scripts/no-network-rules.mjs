// Pure matching logic for the "no network" build check (README.md, rule R3).
//
// No file system access here: every function takes a string and returns a
// list of findings, so it can be unit tested with synthetic strings
// (see no-network-rules.test.ts). check-no-network.mjs does the file reading.
//
// This file necessarily contains the banned words (as regexes and messages),
// so the check never scans the scripts/ folder itself.

/**
 * URLs (http, https, ws, wss) that are allowed to appear anywhere in src/,
 * index.html or dist/. Compared EXACTLY (after trimming trailing punctuation).
 * See also FILE_URL_ALLOWLIST below, for URLs allowed in one dist/ file only.
 *
 * README.md, rule R3: the ONLY URLs ever allowed here are
 *   - the donation link (a plain <a href> the user clicks deliberately),
 *   - the GitHub repository link,
 *   - license links in comments.
 * Nothing else: no CDN, font, analytics or API URL, ever.
 * Empty for now because none of those links exist yet. Example entry:
 *   'https://github.com/OWNER/REPO',
 */
export const URL_ALLOWLIST = [];

/**
 * URLs allowed ONLY inside one specific file of dist/ (path relative to dist/).
 * Anywhere else (src/, index.html, any other dist/ file) they are still errors.
 *
 * The two Apache links are part of the Apache-2.0 license text of
 * @kenjiuno/msgreader, which must be shipped unchanged in the third-party
 * notices (public/THIRD_PARTY_NOTICES.txt, copied to dist/ by Vite).
 * They are plain text there, never loaded by the page.
 */
export const FILE_URL_ALLOWLIST = [
  { url: 'http://www.apache.org/licenses/', onlyIn: 'THIRD_PARTY_NOTICES.txt' },
  { url: 'http://www.apache.org/licenses/LICENSE-2.0', onlyIn: 'THIRD_PARTY_NOTICES.txt' },
];

/**
 * Is `url` allowed in this file?
 * @param {string} url  Already normalized (see normalizeUrl).
 * @param {string | undefined} distFile  Path relative to dist/ with forward
 *   slashes, e.g. 'THIRD_PARTY_NOTICES.txt'; undefined for files outside dist/.
 * @returns {boolean}
 */
export function isUrlAllowed(url, distFile) {
  if (URL_ALLOWLIST.includes(url)) return true;
  return FILE_URL_ALLOWLIST.some((entry) => entry.url === url && entry.onlyIn === distFile);
}

const network = 'Network API (README.md, rules R1 and R3)';
const storage = 'Browser storage API: message data must stay in memory (README.md, rule R5)';
const testCode = 'Test code in the build output (tests must never ship)';
const htmlInjection = 'HTML injection API in the build output: use textContent (README.md, rule R4)';

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
  // HTML injection (README.md, rule R4). dist/ only, because comments in src/
  // legitimately say "never innerHTML"; the source is covered by ESLint
  // (eslint.config.js), and minified dist/ code has no comments left.
  // Stricter than "innerHTML=": ANY mention of these names fails, because a
  // minifier can write an assignment in many shapes (e.g. Object.assign).
  // If a bundled library ever needs one, do not loosen this: add a narrow,
  // file-scoped exception with a comment saying where and why.
  { pattern: /\b(?:inner|outer)HTML\b/g, reason: htmlInjection, distOnly: true },
  { pattern: /\binsertAdjacentHTML\b/g, reason: htmlInjection, distOnly: true },
  { pattern: /\bcreateContextualFragment\b/g, reason: htmlInjection, distOnly: true },
  { pattern: /\bsrcdoc\b/g, reason: htmlInjection, distOnly: true },
  { pattern: /\b(?:setHTMLUnsafe|parseHTMLUnsafe)\b/g, reason: htmlInjection, distOnly: true },
  { pattern: /\bdocument\s*\.\s*write(?:ln)?\s*\(/g, reason: htmlInjection, distOnly: true },
];

// A URL runs until whitespace, a quote, a backtick, <, > or a closing bracket.
// Schemes: http(s) and ws(s) (WebSocket, README.md rule R1). Each slash may be
// escaped as \/ (minified bundles, embedded JSON); normalizeUrl() undoes that.
const URL_PATTERN = /(?:https?|wss?):(?:\\?\/){2}[^\s"'`<>)\]]*/gi;
const URL_REASON = 'URL not in the allowlist in scripts/no-network-rules.mjs (README.md, rule R3)';

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
 * @param {{ isDist: boolean, distFile?: string }} options  isDist enables the
 *   dist-only rules. distFile (dist/ files only) is the path relative to dist/,
 *   used for FILE_URL_ALLOWLIST.
 * @returns {{ line: number, match: string, reason: string }[]}  line is 1-based.
 */
export function findViolations(text, { isDist, distFile }) {
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
      // A file-scoped entry only counts for dist/ files, never for src/.
      if (!isUrlAllowed(url, isDist ? distFile : undefined)) {
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
    return [`missing ${metaStart} ... > (README.md, rule R2)`];
  }
  // A <meta> CSP only protects what comes AFTER it in the document.
  for (const tag of ['<script', '<link']) {
    const tagIndex = html.indexOf(tag);
    if (tagIndex !== -1 && tagIndex < metaIndex) {
      problems.push(`the CSP <meta> must come before the first ${tag} tag (README.md, rule R2)`);
    }
  }
  const content = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? '';
  for (const directive of ["default-src 'none'", "connect-src 'none'"]) {
    if (!content.includes(directive)) {
      problems.push(`the CSP <meta> is missing "${directive}" (README.md, rule R2)`);
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
    problems.push('missing Content-Security-Policy: header (README.md, rule R2)');
  } else {
    for (const directive of ["default-src 'none'", "connect-src 'none'", "frame-ancestors 'none'"]) {
      if (!csp.includes(directive)) {
        problems.push(`Content-Security-Policy header is missing "${directive}" (README.md, rule R2)`);
      }
    }
  }
  if (!lines.includes('Referrer-Policy: no-referrer')) {
    problems.push('missing "Referrer-Policy: no-referrer" header (README.md, rule R2)');
  }
  if (!lines.some((line) => line.startsWith('Permissions-Policy:'))) {
    problems.push('missing Permissions-Policy: header (README.md, rule R2)');
  }
  return problems;
}
