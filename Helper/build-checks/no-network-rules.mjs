// Pure matching logic for the "no network" build check (README.md, rule R3).
//
// No file system access here: every function takes a string and returns a
// list of findings, so it can be unit tested with synthetic strings
// (see no-network-rules.test.ts). check-no-network.mjs does the file reading.
//
// This file necessarily contains the banned words (as regexes and messages),
// so the check never scans the Helper/build-checks/ folder itself.

/**
 * URLs (http, https, ws, wss) that are allowed to appear anywhere in Source/
 * (Source/index.html included) or dist/. Compared EXACTLY (after trimming trailing punctuation).
 * See also FILE_URL_ALLOWLIST below, for URLs allowed in one dist/ file only.
 *
 * README.md, rule R3: the ONLY URLs ever allowed here are
 *   - the donation link (a plain <a href> the user clicks deliberately),
 *   - the GitHub repository link,
 *   - license links in comments.
 * Nothing else: no CDN, font, analytics or API URL, ever.
 *
 * The Ko-fi donation page is the one entry: exactly this URL (no other
 * Ko-fi page, no http:, no longer path, no query), the href of the plain
 * link built by donationLink in Source/page/dom.ts. The page never loads it: the
 * browser only goes there, in a new tab, when the reader clicks the link.
 * The repository link will be the next entry, at publish time, e.g.
 *   'https://github.com/OWNER/REPO',
 */
export const URL_ALLOWLIST = ['https://ko-fi.com/0x496d7065'];

/**
 * URLs allowed ONLY inside one specific file of dist/ (path relative to dist/).
 * Anywhere else (Source/, any other dist/ file) they are still errors.
 *
 * The two Apache links are part of the Apache-2.0 license text of
 * @kenjiuno/msgreader, which must be shipped unchanged in the third-party
 * notices (Source/public/THIRD_PARTY_NOTICES.txt, copied to dist/ by Vite).
 * They are plain text there, never loaded by the page.
 *
 * The SIL link is part of the copyright and license text of the IBM Plex
 * fonts (SIL Open Font License 1.1), which must be shipped with the fonts:
 * same file, same reason.
 */
export const FILE_URL_ALLOWLIST = [
    { url: 'http://www.apache.org/licenses/', onlyIn: 'THIRD_PARTY_NOTICES.txt' },
    { url: 'http://www.apache.org/licenses/LICENSE-2.0', onlyIn: 'THIRD_PARTY_NOTICES.txt' },
    { url: 'http://scripts.sil.org/OFL', onlyIn: 'THIRD_PARTY_NOTICES.txt' },
];

/**
 * URLs allowed ONLY inside one specific SOURCE file (path relative to the
 * project root, forward slashes). Anywhere else they are still errors.
 *
 * Source/pdf-export/fonts/LICENSE.txt is the fonts' license file, kept unchanged next to
 * them, as the license requires; its SIL link is plain text, never loaded.
 */
export const SOURCE_FILE_URL_ALLOWLIST = [{ url: 'http://scripts.sil.org/OFL', onlyIn: 'Source/pdf-export/fonts/LICENSE.txt' }];

/**
 * Is `url` allowed in this file?
 * @param {string} url  Already normalized (see normalizeUrl).
 * @param {string | undefined} distFile  Path relative to dist/ with forward
 *   slashes, e.g. 'THIRD_PARTY_NOTICES.txt'; undefined for files outside dist/.
 * @param {string | undefined} [sourceFile]  Path relative to the project
 *   root with forward slashes, e.g. 'Source/pdf-export/fonts/LICENSE.txt'; undefined for
 *   dist/ files.
 * @returns {boolean}
 */
export function isUrlAllowed(url, distFile, sourceFile)
{
    if (URL_ALLOWLIST.includes(url))
    {
        return true;
    }
    if (distFile !== undefined && FILE_URL_ALLOWLIST.some((entry) => entry.url === url && entry.onlyIn === distFile))
    {
        return true;
    }
    return sourceFile !== undefined && SOURCE_FILE_URL_ALLOWLIST.some((entry) => entry.url === url && entry.onlyIn === sourceFile);
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
    { id: 'fetch', pattern: /(?<![\w$])fetch\s*\(/g, reason: network },
    { pattern: /\bXMLHttpRequest\b/g, reason: network },
    { pattern: /\bWebSocket\b/g, reason: network },
    { pattern: /\bEventSource\b/g, reason: network },
    { pattern: /\bsendBeacon\b/g, reason: network },
    { pattern: /\bimportScripts\b/g, reason: network },
    { pattern: /\blocalStorage\b/g, reason: storage },
    { pattern: /\bsessionStorage\b/g, reason: storage },
    { pattern: /\bindexedDB\b/g, reason: storage },
    { pattern: /\bdocument\s*\.\s*cookie\b/g, reason: storage },
    { id: 'caches', pattern: /(?<![\w$])caches\s*\./g, reason: storage },
    { pattern: /\bvitest\b/g, reason: testCode, distOnly: true },
    { pattern: /(?<![\w$])describe\s*\(/g, reason: testCode, distOnly: true },
    // HTML injection (README.md, rule R4). dist/ only, because comments in Source/
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

/**
 * The ONLY exceptions to RULES, each for one rule in exactly one file:
 * the service worker (README.md, "How the privacy model works"). It is the
 * one piece of shipped code that may use the network and Cache Storage, and
 * only to keep and serve a copy of the site's OWN static files, so the page
 * can be reopened offline:
 *   - 'fetch': when a listed file is missing from its copy, the request
 *     goes on to this site (the answer is not stored). Its CSP
 *     (`connect-src 'self'`, sent with /sw.js only) stops any other site.
 *   - 'caches': the copy itself (precache list made at build time; nothing
 *     is ever stored at run time).
 * `distFile` is the built file (path relative to dist/), `sourceFile` its
 * source (path relative to the project root). Anywhere else, including
 * every other file of Source/, Header/ and dist/ (the page's scripts, the inlined
 * workers), both rules still fail the build. Every other rule (XHR,
 * WebSocket, script loading, the other storage APIs, URLs, ...) still
 * applies to these two files too. Never add an entry without the user's
 * approval.
 */
export const RULE_EXEMPTIONS = [
    { rule: 'fetch', distFile: 'sw.js', sourceFile: 'Source/offline-copy/service-worker.ts' },
    { rule: 'caches', distFile: 'sw.js', sourceFile: 'Source/offline-copy/service-worker.ts' },
];

/**
 * Is `rule` switched off for this file (RULE_EXEMPTIONS)? A dist/ entry
 * only counts for dist/ files, a source entry only for source files.
 * @param {{ id?: string }} rule
 * @param {boolean} isDist
 * @param {string | undefined} distFile
 * @param {string | undefined} sourceFile
 * @returns {boolean}
 */
export function isRuleExempt(rule, isDist, distFile, sourceFile)
{
    if (rule.id === undefined)
    {
        return false;
    }
    return RULE_EXEMPTIONS.some((entry) =>
        entry.rule === rule.id && (isDist ? distFile !== undefined && entry.distFile === distFile : sourceFile !== undefined && entry.sourceFile === sourceFile),
    );
}

// A URL runs until whitespace, a quote, a backtick, <, > or a closing bracket.
// Schemes: http(s) and ws(s) (WebSocket, README.md rule R1). Each slash may be
// escaped as \/ (minified bundles, embedded JSON); normalizeUrl() undoes that.
const URL_PATTERN = /(?:https?|wss?):(?:\\?\/){2}[^\s"'`<>)\]]*/gi;
const URL_REASON = 'URL not in the allowlist in Helper/build-checks/no-network-rules.mjs (README.md, rule R3)';

/**
 * Turns a raw URL match into the form compared against URL_ALLOWLIST:
 * unescapes \/ to /, then drops trailing sentence punctuation and any
 * trailing backslash (left over from an escaped quote) that is probably
 * not part of the URL.
 * @param {string} raw
 * @returns {string}
 */
export function normalizeUrl(raw)
{
    return raw.replace(/\\\//g, '/').replace(/[.,;:!?\\]+$/, '');
}

/**
 * Finds every forbidden pattern and non-allowlisted URL in `text`.
 * @param {string} text  File contents.
 * @param {{ isDist: boolean, distFile?: string, sourceFile?: string }} options
 *   isDist enables the dist-only rules. distFile (dist/ files only) is the
 *   path relative to dist/, used for FILE_URL_ALLOWLIST. sourceFile (source
 *   files only) is the path relative to the project root, used for
 *   SOURCE_FILE_URL_ALLOWLIST.
 * @returns {{ line: number, match: string, reason: string }[]}  line is 1-based.
 */
export function findViolations(text, { isDist, distFile, sourceFile })
{
    const findings = [];
    const lines = text.split(/\r?\n/);
    lines.forEach((lineText, index) =>
    {
        for (const rule of RULES)
        {
            if (rule.distOnly && !isDist)
            {
                continue;
            }
            if (isRuleExempt(rule, isDist, distFile, sourceFile))
            {
                continue;
            }
            for (const m of lineText.matchAll(rule.pattern))
            {
                findings.push({ line: index + 1, match: m[0], reason: rule.reason });
            }
        }
        for (const m of lineText.matchAll(URL_PATTERN))
        {
            const url = normalizeUrl(m[0]);
            // A dist/ file-scoped entry only counts for dist/ files, a source
            // file-scoped entry only for source files.
            if (!isUrlAllowed(url, isDist ? distFile : undefined, isDist ? undefined : sourceFile))
            {
                findings.push({ line: index + 1, match: url, reason: URL_REASON });
            }
        }
    });
    return findings;
}

// One JavaScript string escape: \u{1F600}, \u00e9, \x41, a line
// continuation (backslash + line break), or backslash + any other character.
const ESCAPE_PATTERN = /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r\n|[\s\S]))/g;
const SIMPLE_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };

/**
 * Undoes JavaScript string escapes everywhere in `text`, in one pass.
 *
 * Why: the web workers are inlined into the page's script (Vite
 * `?worker&inline`), each as ONE string literal holding the worker's whole
 * code. Inside that string a line break is written `\n` and a quote `\"`.
 * Seen as raw text, `\nXMLHttpRequest` does not match /\bXMLHttpRequest\b/
 * (the "n" before it looks like part of the word), so worker code could
 * hide from the rules. Scanning the decoded text sees the worker code as the
 * browser will run it. Decoding is done on the whole file, not only inside
 * strings: it can only reveal more matches, and a false alarm is fixed by
 * looking at it, not by loosening the check.
 * @param {string} text
 * @returns {string}
 */
export function decodeJsEscapes(text)
{
    return text.replace(ESCAPE_PATTERN, (_all, braced, hex4, hex2, other) =>
    {
        if (braced !== undefined)
        {
            const code = Number.parseInt(braced, 16);
            return code <= 0x10ffff ? String.fromCodePoint(code) : '';
        }
        if (hex4 !== undefined)
        {
            return String.fromCharCode(Number.parseInt(hex4, 16));
        }
        if (hex2 !== undefined)
        {
            return String.fromCharCode(Number.parseInt(hex2, 16));
        }
        if (other === '\n' || other === '\r' || other === '\r\n' || other === '\u2028' || other === '\u2029')
        {
            return '';
        }
        return Object.hasOwn(SIMPLE_ESCAPES, other) ? SIMPLE_ESCAPES[other] : other;
    });
}

/**
 * Findings that only appear once string escapes are undone (decodeJsEscapes):
 * code embedded as a string, such as an inlined worker. Findings already
 * visible in the raw text are left out (findViolations reports those), so
 * nothing is reported twice. `line` is a line of the DECODED text.
 * @param {string} text  File contents.
 * @param {{ isDist: boolean, distFile?: string }} options  As for findViolations.
 * @returns {{ line: number, match: string, reason: string }[]}
 */
export function findEmbeddedViolations(text, options)
{
    const decoded = decodeJsEscapes(text);
    if (decoded === text)
    {
        return [];
    }
    const key = (finding) => `${finding.reason}\u0000${finding.match}`;
    // How many times each (reason, match) is already reported in the raw text.
    const seen = new Map();
    for (const finding of findViolations(text, options))
    {
        seen.set(key(finding), (seen.get(key(finding)) ?? 0) + 1);
    }
    const extra = [];
    for (const finding of findViolations(decoded, options))
    {
        const left = seen.get(key(finding)) ?? 0;
        if (left > 0)
        {
            seen.set(key(finding), left - 1);
        }
        else
        {
            extra.push({ ...finding, reason: `${finding.reason} [inside a string, e.g. inlined worker code; decoded line ${finding.line}]` });
        }
    }
    return extra;
}

/** Shortest run of base64 characters treated as an opaque payload. */
export const OPAQUE_PAYLOAD_MIN_LENGTH = 10000;

/**
 * Finds long base64-looking runs ([A-Za-z0-9+/], optional '=' padding) of at
 * least OPAQUE_PAYLOAD_MIN_LENGTH characters. Code hidden that way (for
 * example a worker inlined as base64, which older Vite versions did) cannot
 * be seen by the rules above, not even after decodeJsEscapes, so the build
 * must fail and a person must look.
 *
 * Why this guard rather than counting Vite's inline-worker wrapper marker:
 * it does not depend on Vite's wrapper wording or on the number of workers
 * (no false alarm on a harmless upgrade, no edit when a worker is added), and
 * it catches the actual risk whatever produced it and however it is decoded
 * later (atob, a hand-written decoder, ...), not only Vite's own format.
 * Ordinary minified code never has 10k characters without punctuation.
 *
 * Linear scan (no regex backtracking on large bundles).
 * @param {string} text
 * @param {number} [minLength]
 * @returns {{ line: number, match: string, reason: string }[]}
 */
export function findOpaquePayloads(text, minLength = OPAQUE_PAYLOAD_MIN_LENGTH)
{
    const isBase64 = (code) =>
        (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47;
    const findings = [];
    let line = 1;
    let start = -1;
    let startLine = 1;
    for (let i = 0; i <= text.length; i += 1)
    {
        const code = i < text.length ? text.charCodeAt(i) : -1;
        if (isBase64(code))
        {
            if (start < 0)
            {
                start = i;
                startLine = line;
            }
            continue;
        }
        if (start >= 0)
        {
            let end = i;
            while (end < text.length && end - i < 2 && text.charCodeAt(end) === 61)
            {
                end += 1; // '=' padding
            }
            if (end - start >= minLength)
            {
                findings.push({
                    line: startLine,
                    match: text.slice(start, end),
                    reason: `a ${end - start}-character base64-looking literal: code hidden this way (e.g. a worker inlined as base64) escapes every check (README.md, rule R3)`,
                });
            }
            start = -1;
        }
        if (code === 10)
        {
            line += 1;
        }
    }
    return findings;
}

/**
 * Structural checks on dist/index.html. Returns a list of problems (empty = OK).
 * @param {string} html
 * @returns {string[]}
 */
export function checkBuiltHtml(html)
{
    const problems = [];
    const metaStart = '<meta http-equiv="Content-Security-Policy"';
    const metaIndex = html.indexOf(metaStart);
    if (metaIndex === -1)
    {
        return [`missing ${metaStart} ... > (README.md, rule R2)`];
    }
    // A <meta> CSP only protects what comes AFTER it in the document.
    for (const tag of ['<script', '<link'])
    {
        const tagIndex = html.indexOf(tag);
        if (tagIndex !== -1 && tagIndex < metaIndex)
        {
            problems.push(`the CSP <meta> must come before the first ${tag} tag (README.md, rule R2)`);
        }
    }
    const content = /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? '';
    for (const directive of ["default-src 'none'", "connect-src 'none'"])
    {
        if (!content.includes(directive))
        {
            problems.push(`the CSP <meta> is missing "${directive}" (README.md, rule R2)`);
        }
    }
    return problems;
}

/**
 * Structural checks on dist/_headers (Cloudflare Pages). Returns problems.
 * The `/*` rule must send the strict CSP, the referrer and permissions
 * policies; the `/sw.js` rule must replace the CSP with the service
 * worker's (the same with connect-src 'self') and change nothing else.
 * @param {string} text
 * @returns {string[]}
 */
export function checkHeadersFile(text)
{
    const problems = [];
    // Rules: a path line (not indented), then its indented header lines.
    /** @type {{ path: string, lines: string[] }[]} */
    const rules = [];
    for (const raw of text.split(/\r?\n/))
    {
        if (raw.trim() === '' || raw.trim().startsWith('#'))
        {
            continue;
        }
        if (/^\s/.test(raw))
        {
            rules.at(-1)?.lines.push(raw.trim());
        }
        else
        {
            rules.push({ path: raw.trim(), lines: [] });
        }
    }
    const cspOf = (rule) => rule.lines.filter((line) => line.startsWith('Content-Security-Policy:'));
    const all = rules.find((rule) => rule.path === '/*');
    const lines = all?.lines ?? [];
    const csp = all === undefined ? [] : cspOf(all);
    if (csp.length !== 1)
    {
        problems.push('missing Content-Security-Policy: header (README.md, rule R2)');
    }
    else
    {
        for (const directive of ["default-src 'none'", "connect-src 'none'", "frame-ancestors 'none'"])
        {
            if (!csp[0].includes(directive))
            {
                problems.push(`Content-Security-Policy header is missing "${directive}" (README.md, rule R2)`);
            }
        }
    }
    if (!lines.includes('Referrer-Policy: no-referrer'))
    {
        problems.push('missing "Referrer-Policy: no-referrer" header (README.md, rule R2)');
    }
    if (!lines.some((line) => line.startsWith('Permissions-Policy:')))
    {
        problems.push('missing Permissions-Policy: header (README.md, rule R2)');
    }
    // The service worker script's own CSP (README.md, "How the privacy model
    // works"): exactly the page's policy with connect-src 'self' instead of
    // 'none', after detaching the page's (Cloudflare would otherwise send
    // both, comma-joined). No other rule may set or remove a CSP.
    const sw = rules.filter((rule) => rule.path === '/sw.js');
    for (const rule of rules)
    {
        if (rule.path === '/*' || rule.path === '/sw.js')
        {
            continue;
        }
        if (rule.lines.some((line) => /^!?\s*Content-Security-Policy\b/.test(line)))
        {
            problems.push(`the rule for ${rule.path} changes the Content-Security-Policy: only /sw.js may (README.md, rule R2)`);
        }
    }
    if (sw.length !== 1)
    {
        problems.push('needs exactly one rule for /sw.js, with its own Content-Security-Policy (README.md, rule R2)');
    }
    else
    {
        const swLines = sw[0].lines;
        const detach = swLines.indexOf('! Content-Security-Policy');
        const swCsp = cspOf(sw[0]);
        const expected = csp.length === 1 ? csp[0].replace("connect-src 'none'", "connect-src 'self'") : undefined;
        if (detach === -1 || swCsp.length !== 1 || swLines.indexOf(swCsp[0]) < detach)
        {
            problems.push('the /sw.js rule must remove the page CSP ("! Content-Security-Policy") and then set exactly one of its own (README.md, rule R2)');
        }
        else if (expected === undefined || swCsp[0] !== expected || expected === csp[0])
        {
            problems.push("the /sw.js Content-Security-Policy must be the page's with only connect-src 'self' instead of 'none' (README.md, rule R2)");
        }
        if (swLines.some((line) => !line.startsWith('Content-Security-Policy:') && line !== '! Content-Security-Policy'))
        {
            problems.push('the /sw.js rule may only replace the Content-Security-Policy (README.md, rule R2)');
        }
    }
    return problems;
}
