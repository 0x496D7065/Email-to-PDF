// Pure checks behind synthetic-guard.test.ts and test-code-guard.test.ts:
// the privacy safety net that keeps every test fixture, and the test code
// itself, obviously SYNTHETIC (README.md, rule R7).
//
// Hosts: only reserved test names may appear, i.e. names ending in ".test"
// or ".invalid" (RFC 2606 / RFC 6761). They can never belong to a real
// person or company, so a fixture using them cannot expose a real address.
// IP addresses: only the documentation ranges (RFC 5737, RFC 3849) and
// loopback.
//
// Encoded text is checked too: an address hidden in a base64 body (also
// inside an attached message), in a quoted-printable line split by a soft
// line break, in an RFC 2047 encoded header, behind HTML character
// references or percent-encoding would otherwise slip past a plain search.

/** True if `host` is a reserved test name (ends in .test or .invalid): `mail.example.test` yes, `test.example` no. */
export function isReservedTestHost(host: string): boolean
{
    return /\.(test|invalid)$/i.test(host.replace(/\.+$/, ''));
}

/** True for IPv4 documentation ranges 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 and loopback 127.0.0.0/8. */
export function isAllowedIPv4(ip: string): boolean
{
    const octets = ip.split('.').map(Number);
    if (octets.length !== 4 || octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255))
    {
        return false;
    }
    const [a, b, c] = octets;
    return (
        a === 127 || (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
    );
}

/** True for the IPv6 documentation prefix 2001:db8::/32 and loopback ::1. */
export function isAllowedIPv6(ip: string): boolean
{
    const lower = ip.toLowerCase();
    if (lower === '::1')
    {
        return true;
    }
    const groups = lower.split(':');
    return groups[0] === '2001' && parseInt(groups[1] ?? '', 16) === 0xdb8;
}

/** A URL or address host is allowed if it is a reserved test name or an allowed IP literal. */
export function isAllowedHost(host: string): boolean
{
    const bare = host.replace(/^\[|\]$/g, '');
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(bare))
    {
        return isAllowedIPv4(bare);
    }
    if (bare.includes(':'))
    {
        return isAllowedIPv6(bare);
    }
    return isReservedTestHost(bare);
}

/** True if any segment of a path (e.g. "./eml/.x.eml") is a hidden (dot) file or folder. "." and ".." do not count. */
export function hasHiddenSegment(path: string): boolean
{
    return path.split(/[\\/]/).some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..');
}

/** The header marker every .eml fixture must carry in its top-level header block. */
export function hasSyntheticMarker(eml: string): boolean
{
    const end = eml.search(/\r?\n\r?\n/);
    const headers = end === -1 ? eml : eml.slice(0, end);
    return /^X-Synthetic-Fixture:[ \t]*true[ \t]*\r?$/im.test(headers);
}

/** True if the text has only printable 7-bit ASCII plus tab, CR and LF (so no byte was lost when read as a string). */
export function isSevenBitAscii(text: string): boolean
{
    return /^[\t\r\n\x20-\x7e]*$/.test(text);
}

/** Bytes (from atob) as a string with one char per byte: enough to search ASCII addresses in. Tolerates missing padding. */
function decodeBase64Loose(b64: string): string
{
    let clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
    if (clean.length % 4 === 1)
    {
        clean = clean.slice(0, -1);
    }
    try
    {
        return atob(clean.padEnd(Math.ceil(clean.length / 4) * 4, '='));
    }
    catch
    {
        return '';
    }
}

/** Quoted-printable escapes: `a=40b.test` becomes `a@b.test`. */
function decodeQpEscapes(text: string): string
{
    return text.replace(/=([0-9A-Fa-f]{2})/g, (_, hh: string) => String.fromCharCode(parseInt(hh, 16)));
}

/** Percent-encoding: `a%40b.test` becomes `a@b.test`. */
function decodePercent(text: string): string
{
    return text.replace(/%([0-9A-Fa-f]{2})/g, (_, hh: string) => String.fromCharCode(parseInt(hh, 16)));
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = { commat: '@', period: '.', sol: '/', colon: ':' };

/**
 * Decodes numeric HTML character references (&#64; &#x40;) and a few named ones that spell addresses:
 * `a&#64;b.test` and `a&commat;b&period;test` both become `a@b.test`; `&eacute;` is left alone.
 */
function decodeHtmlEntities(text: string): string
{
    return text.replace(/&#(?:([0-9]{1,7})|[xX]([0-9A-Fa-f]{1,6}));?|&(commat|period|sol|colon);/g, (match, dec?: string, hex?: string, name?: string) =>
    {
        if (name !== undefined)
        {
            return NAMED_ENTITIES[name] ?? match;
        }
        const code = dec !== undefined ? parseInt(dec, 10) : parseInt(hex ?? '', 16);
        return code <= 0x10ffff ? String.fromCodePoint(code) : match;
    });
}

/**
 * Decodes RFC 2047 encoded words (=?charset?B|Q?...?=) to one char per byte:
 * `=?UTF-8?Q?a=40b.test?=` becomes `a@b.test`, `=?UTF-8?B?YUBi?=` becomes `a@b`.
 */
function decodeEncodedWords(text: string): string
{
    return text.replace(/=\?[^?\s]+\?([BbQq])\?([^?\s]*)\?=/g, (_, kind: string, data: string) =>
        kind.toUpperCase() === 'B' ? decodeBase64Loose(data) : decodeQpEscapes(data.replace(/_/g, ' ')),
    );
}

/**
 * Bodies of MIME parts declared "Content-Transfer-Encoding: base64", decoded.
 * Headers are unfolded first, and anything after "base64" (parameters,
 * comments) is tolerated. Over-matching (e.g. the phrase inside a body) only
 * adds an extra view to scan, which is harmless.
 */
function decodeBase64Parts(text: string): string[]
{
    const lines = text.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/);
    const out: string[] = [];
    let base64Header = false;
    for (let i = 0; i < lines.length; i++)
    {
        const line = lines[i] ?? '';
        // Matches `Content-Transfer-Encoding: base64` and `content-transfer-encoding: "BASE64"; x=y`, not `...: 7bit`.
        if (/^content-transfer-encoding[ \t]*:[ \t]*"?base64\b/i.test(line))
        {
            base64Header = true;
        }
        if (line.trim() === '' && base64Header)
        {
            base64Header = false;
            const body: string[] = [];
            while (i + 1 < lines.length && (lines[i + 1] ?? '').trim() !== '' && !(lines[i + 1] ?? '').startsWith('--'))
            {
                body.push(lines[++i] ?? '');
            }
            out.push(decodeBase64Loose(body.join('')));
        }
    }
    return out;
}

/** Nesting limit for decoding base64 inside base64 (e.g. a base64 message/rfc822 attachment with base64 parts). */
const MAX_DEPTH = 3;

/**
 * Every view of a file that must be scanned: the raw text with
 * quoted-printable soft line breaks joined, its =XX escapes decoded,
 * RFC 2047 words decoded (after header unfolding), HTML character
 * references and percent-encoding decoded (on the raw text, on the
 * quoted-printable decoded text and on the RFC 2047 decoded text), and each
 * base64 MIME part decoded. A decoded
 * base64 part is itself expanded the same way, so an attached message
 * (message/rfc822), encoded or not, is covered with its own base64 parts.
 */
export function decodedViews(text: string, depth = 0): string[]
{
    // QP soft line breaks: "=" at the end of a line joins it to the next one.
    const joined = text.replace(/=\r?\n/g, '');
    const qp = decodeQpEscapes(joined);
    // The main RFC 2047 view is NOT decoded from `joined`: joining soft breaks there
    // eats the "=" of a closing "?=" at the end of a line. Here soft breaks are
    // joined except right after "?" (a "?=" line end closes an encoded word;
    // `joined` above already covers a body line ending in "?="), so a URL split
    // by a soft break in a QP body is not cut in two. Folded header lines are
    // then unfolded, and the whitespace BETWEEN two adjacent encoded words is
    // dropped (RFC 2047 section 6.2), so an address split over two words comes
    // back in one piece:
    // `=?UTF-8?Q?a=40?=` + line break + ` =?UTF-8?Q?b.test?=` becomes `a@b.test`.
    // A second RFC 2047 view is decoded from `joined` (ALL soft breaks joined),
    // so a word split by a soft break right after one of its own "?"
    // (`=?UTF-8?=` + line break + `B?...?=`) is decoded too. Known limit: a word
    // split that way AND ending its line (`?=` + line end) is cut in both views.
    // Both decoded views are also run through HTML-reference and percent
    // decoding (an encoded word can hide `a&#64;b` or `a%40b`).
    const headerText = text
        .replace(/(?<!\?)=\r?\n/g, '')
        .replace(/\r?\n[ \t]+/g, ' ')
        .replace(/(\?=)\s+(?==\?)/g, '$1');
    const words = decodeEncodedWords(headerText);
    const joinedWords = decodeEncodedWords(joined.replace(/\r?\n[ \t]+/g, ' ').replace(/(\?=)\s+(?==\?)/g, '$1'));
    const views = [
        joined,
        qp,
        words,
        joinedWords,
        decodeHtmlEntities(words),
        decodePercent(words),
        decodeHtmlEntities(joinedWords),
        decodePercent(joinedWords),
        decodeHtmlEntities(joined),
        decodePercent(joined),
        // Layered encodings: QP first, then entities or percent (`a=26#64;b` is QP for `a&#64;b`).
        decodeHtmlEntities(qp),
        decodePercent(qp),
    ];
    if (depth < MAX_DEPTH)
    {
        for (const part of decodeBase64Parts(text))
        {
            views.push(...decodedViews(part, depth + 1));
        }
    }
    return views;
}

/**
 * Top-level domains of real-world hosts that must never appear bare (without
 * a scheme) in a fixture. A plain list on purpose: a generic "any dotted
 * name" rule would also flag file names like `manifest.ts`.
 */
const REAL_TLDS =
    /^(?:com|net|org|edu|gov|ac|int|mil|be|fr|nl|eu|de|uk|io|co|info|biz|lu|ch|at|es|it|ru|me|app|us|ca|au|pl|pt|se|dk|no|fi|ie|cz|jp|cn|in|br|xyz|online|site|dev|ai|tv|ly|lt|lv|ro|gr|hu|sk|si|hr|is|nz|za|mx|ar|kr)$/i;

/**
 * How a text is read. 'fixture': a test email or its spec. 'code': test
 * source code, where an identifier followed by `.at(-1)` (the array
 * method) or `.info` (a property) is a member access, not a host. In
 * 'code' mode the BARE-host rule skips a name ending in `.at` or `.info`
 * only when it looks like a member access (isCodeMemberAccess); email
 * addresses, URLs and `www.` names are still flagged, and every other rule
 * is the same.
 */
export type ScanMode = 'fixture' | 'code';

/** One JS identifier (no `-`, not starting with a digit), then `.at` or `.info`. A name with a `-` in it is a host. */
const CODE_MEMBER_NAME = /^[A-Za-z_$][\w$]*\.(?:at|info)$/;
/** A chain of JS identifiers ending in `.at` or `.info`, e.g. `run`, `glyphs`, `at` joined by dots. */
const CODE_MEMBER_CHAIN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.(?:at|info)$/;

/**
 * True if the bare name `host`, followed in its text by `next`, reads as a
 * TypeScript member access rather than a host: two labels whose first one is
 * an identifier (a list, then `.at`), or a longer chain of identifiers that
 * is called right away (two identifiers, then `.at(-1)`). Three labels that
 * are not called, or a label with a `-`, are read as a host.
 */
function isCodeMemberAccess(host: string, next: string): boolean
{
    return CODE_MEMBER_NAME.test(host) || (next === '(' && CODE_MEMBER_CHAIN.test(host));
}

/** One label of a host name: anything but separators, so non-ASCII (IDN) labels match too (`example` or `bücher`). */
const LABEL = `[^\\s.@<>"'\`,;:()\\[\\]{}/\\\\|=?!*&%$#+~^]+`;

/** Problems found in one text: email, URL, bare host and IP literals that are not reserved test names / documentation IPs. */
export function findForbiddenHosts(text: string, mode: ScanMode = 'fixture'): string[]
{
    const problems = new Set<string>();
    for (const view of decodedViews(text))
    {
        // Email addresses (also catches Message-IDs and cid: references, which use the same form).
        // Finds `a@mail.example.test` and `<id.1@host.invalid>` (then checks the domain), not a lone `@`.
        for (const m of view.matchAll(new RegExp(`[A-Za-z0-9._%+-]+@(${LABEL}(?:\\.${LABEL})+)`, 'g')))
        {
            const domain = m[1] ?? '';
            if (!isAllowedHost(domain))
            {
                problems.add(`email domain "${domain}" in "${m[0]}"`);
            }
        }
        // URLs with a scheme: host after "://", without user info and port.
        // In `https://user@cdn.invalid:8080/x` it checks `cdn.invalid`; `cid:part1` has no "//", so it is skipped.
        for (const m of view.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/([^\s/?#"'<>()\\]+)/gi))
        {
            const host = (m[1] ?? '').replace(/^.*@/, '').replace(/:\d*$/, '');
            if (!isAllowedHost(host))
            {
                problems.add(`URL host "${host}" in "${m[0]}"`);
            }
        }
        // Protocol-relative URLs "//host/...": not after a scheme colon, a word char or another slash.
        // Finds `src="//cdn.invalid/p.png"` (checks `cdn.invalid`), not `// a comment` (no dotted host).
        for (const m of view.matchAll(new RegExp(`(?<![\\w:/])//(?:[^\\s/@]*@)?(\\[[0-9A-Fa-f:.]+\\]|${LABEL}(?:\\.${LABEL})+)`, 'g')))
        {
            const host = m[1] ?? '';
            if (!isAllowedHost(host))
            {
                problems.add(`protocol-relative URL host "${host}" in "${m[0]}"`);
            }
        }
        // Bare host names: any dotted name starting with "www", or ending in a common real TLD.
        // Flags `shop.example` + `.de` written together; allows `www.shop.test`, `manifest.ts` and `version 1.2`.
        for (const m of view.matchAll(/(?<![\w.-])[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?![\w-]|\.[A-Za-z0-9])/g))
        {
            const host = m[0];
            const tld = host.slice(host.lastIndexOf('.') + 1);
            const next = view.charAt(m.index + host.length);
            const realTld = REAL_TLDS.test(tld) && !(mode === 'code' && isCodeMemberAccess(host, next));
            if ((/^www\./i.test(host) || realTld) && !isReservedTestHost(host))
            {
                problems.add(`host name "${host}"`);
            }
        }
        // Bare IPv4 literals. Finds `192.0.2.10` (then checks the range), not `1.2.3` or `1.2.3.4.5`.
        for (const m of view.matchAll(/(?<![\w.])\d{1,3}(?:\.\d{1,3}){3}(?![\w]|\.\d)/g))
        {
            if (m[0].split('.').every((o) => Number(o) <= 255) && !isAllowedIPv4(m[0]))
            {
                problems.add(`IPv4 address "${m[0]}"`);
            }
        }
        // Bare IPv6 literals: compressed ("::") with a hex digit, or the full 8-group form (times like 10:00:00 never match).
        // Finds `2001:db8::25` and `[::1]` (then checks the prefix), not `10:00:00`.
        for (const m of view.matchAll(/(?<![\w:])[0-9A-Fa-f]{0,4}(?::[0-9A-Fa-f]{0,4}){2,7}(?![\w:])/g))
        {
            const ip = m[0];
            const full = /^[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){7}$/.test(ip);
            const compressed = ip.includes('::') && /[0-9A-Fa-f]/.test(ip);
            if ((full || compressed) && !isAllowedIPv6(ip))
            {
                problems.add(`IPv6 address "${ip}"`);
            }
        }
    }
    return [...problems];
}

/**
 * Folder names allowed right after a home-folder root: generic placeholders
 * that cannot name a real person. Anything else (a first name, a login, a
 * nickname) is flagged. Template and environment placeholders such as
 * `<name>`, `%USERNAME%` or `${user}` never match the path rule at all.
 */
const PLACEHOLDER_USER_NAMES: ReadonlySet<string> = new Set(['dev', 'user', 'username', 'example', 'test']);

/**
 * Home-folder paths: an optional drive (`C:`, or the mount-style `/c` of
 * Git Bash and `/mnt/c` of WSL), then `Users` or `home` (any case) between
 * separators, then the folder name. Separators may be `/`, `\`, an escaped
 * `\\` or a JSON-escaped `\/`. The root must start the path (no letter,
 * digit, dot, `~` or `-` just before), so `Source/users/x`, `a/b/users/x` or
 * the path of a URL like `https://example.test/users/x` is not a home folder.
 * Flags a name after `/home/`, `C:\Users\` (also with `\\` or `/`),
 * `/c/Users/` or `/mnt/c/Users/`; `/home/dev`, `C:\Users\<name>` and
 * `%USERPROFILE%` pass.
 */
const HOME_PATH =
    /(?<![\w.~-])(?:[A-Za-z]:|(?:[\\/]+mnt)?[\\/]+[A-Za-z])?[\\/]+(?:Users|home)[\\/]+([^\s\\/'"`<>:|?*%$&{}()[\],;=]+)/gi;

/** Home-folder paths (Windows, macOS, Linux) whose folder name is not a generic placeholder: they could name a real person. */
export function findPersonalPaths(text: string): string[]
{
    const problems = new Set<string>();
    for (const view of decodedViews(text))
    {
        for (const m of view.matchAll(HOME_PATH))
        {
            const name = (m[1] ?? '').replace(/\.+$/, '');
            if (!PLACEHOLDER_USER_NAMES.has(name.toLowerCase()))
            {
                problems.add(`home-folder path "${m[0]}"`);
            }
        }
    }
    return [...problems];
}

/**
 * The only time zones tests may name: a short list of neutral zones (and
 * `UTC`, which has no area and is always fine). A zone name could hint at
 * where the author lives, so any other zone is rejected. Add a zone here only
 * if a test really needs its particular offset or rules.
 *
 * Known limit: only `Area/Location` names are checked. Single-word legacy
 * names (abbreviations such as JST or EST) and legacy `US/...`-style areas
 * are not, so keep to the neutral zones by hand there.
 */
export const ALLOWED_TIME_ZONES: readonly string[] = [
    'Etc/UTC',
    'Africa/Lagos',
    'America/Los_Angeles',
    'America/New_York',
    'America/St_Johns',
    'Asia/Kathmandu',
    'Asia/Katmandu', // the old name of Asia/Kathmandu, to test that aliases are resolved
    'Asia/Kolkata',
    'Asia/Shanghai',
    'Asia/Tokyo',
    'Australia/Darwin',
    'Australia/Sydney',
    'Pacific/Kiritimati',
    'Pacific/Pago_Pago',
];

/** The areas (first part) of IANA time-zone names. */
const ZONE_AREA = 'Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc';
/** Between area and location: `/`, `\`, `\/`, `\\`, `_` or `-` (percent and HTML encodings are decoded first). */
const ZONE_SEP = '[\\\\/_-]+';
/** Anything that starts like a zone name, any case: `Asia/Tokyo`, `asia\/tokyo`, `ASIA_TOKYO`; not `Asian` or `Indiana/x`. */
const ZONE_START = new RegExp(`(?<![A-Za-z0-9])(?:${ZONE_AREA})${ZONE_SEP}[A-Za-z][A-Za-z0-9_+-]*`, 'gi');
/**
 * One allowed zone at a given position, in any case and with any separator.
 * The `_` inside a location may also be a space, as in the label
 * "America/New York". The name must end there: an allowed zone followed by
 * more letters, digits or another `/Part` is a different (unlisted) name.
 */
const ALLOWED_ZONE_AT = new RegExp(
    `(?:${ALLOWED_TIME_ZONES.map((zone) =>
    {
        const [area = '', ...location] = zone.split('/');
        return `${area}${ZONE_SEP}${location.join('/').replace(/_/g, '[_ ]')}`;
    }).join('|')})(?![A-Za-z0-9_+-]|/[A-Za-z])`,
    'iy',
);

/** Time-zone names (`Area/Location`) not in ALLOWED_TIME_ZONES, in the text or any decoded view of it. */
export function findUnlistedTimeZones(text: string): string[]
{
    const problems = new Set<string>();
    for (const view of decodedViews(text))
    {
        for (const m of view.matchAll(ZONE_START))
        {
            ALLOWED_ZONE_AT.lastIndex = m.index;
            if (!ALLOWED_ZONE_AT.test(view))
            {
                problems.add(`time zone "${m[0]}" (not in the allowed list)`);
            }
        }
    }
    return [...problems];
}

/**
 * The text with every exempted string blanked out (longest first, so a
 * shorter exempted string inside a longer one does not cut it in two).
 * Exemptions are exact, case-sensitive strings: see privacy-guard-exemptions.ts.
 * An exempted string that ends like a host name is only blanked where the
 * host really ends there: exempting a URL `U` that ends in its host does
 * not blank the start of `U` + `.more.labels` or `U` + `x`, which name a
 * different host (`U` + a sentence-ending dot is still blanked), nor
 * `U` + `@other.host` or `U` + `%2E...` (user info or an encoded dot).
 * Likewise, one that starts with a host name `H` (`H` or `H/x`; not a URL
 * with a scheme or a code snippet like `includes('x')`) is only blanked
 * where nothing host-like (a letter, digit, `.`, `@`, `%`, `+` or `-`)
 * comes just before, so exempting `H` does not blank it in `someone@H`
 * or `www.` + `H`.
 */
export function withoutExemptions(text: string, exempt: readonly string[]): string
{
    return [...exempt]
        .filter((s) => s !== '')
        .sort((a, b) => b.length - a.length)
        .reduce((out, s) =>
        {
            const escaped = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const hostStart = /^[\w-]+(?:\.[\w-]+)+(?![\w-])/.test(s) ? '(?<![\\w.@%+-])' : '';
            const hostEnd = /[\w.-]$/.test(s) ? '(?![\\w@%-]|\\.[\\w-])' : '';
            return out.replace(new RegExp(hostStart + escaped + hostEnd, 'g'), ' ');
        }, text);
}

/** Every problem the guard finds in one text: hosts (in the given mode), home-folder paths and time zones outside the allowed list. */
export function findPrivacyProblems(text: string, mode: ScanMode): string[]
{
    return [...findForbiddenHosts(text, mode), ...findPersonalPaths(text), ...findUnlistedTimeZones(text)];
}
