// Privacy safety net for the TEST CODE (README.md, rule R7: test data is
// synthetic only). synthetic-guard.test.ts checks everything under
// Helper/Test/test-data/; this file checks the code of all the other tests:
//   Source/**/*.test.ts, Helper/Test/browser-tests/** (specs and support files),
//   Helper/Test/** outside Helper/Test/test-data/ (e.g. Helper/Test/test-support/),
//   Helper/build-checks/**/*.test.*, Helper/lint-rules/**/*.test.*
// (the same folders as vitest's test.include in vite.config.ts and
// Playwright's testDir; the first test below checks a file from each).
// A file fails if it has:
//   1. an email address, URL (also "//host"), www host or bare host with a
//      common real TLD that is not a reserved test name (*.test, *.invalid),
//      or an IP outside the documentation and loopback ranges. Same rules
//      and decoding as for the fixtures (privacy-guard-rules.ts), in 'code' mode:
//      member accesses ending in `.at` or `.info` are not taken for bare hosts,
//   2. a home-folder path (Windows, macOS, Linux, also Git Bash `/c/Users/`
//      and WSL `/mnt/c/Users/`) whose folder name is not a generic
//      placeholder (dev, user, username, example, test),
//   3. a time-zone name (`Area/Location`) that is not in the short list of
//      neutral zones the tests use (ALLOWED_TIME_ZONES in privacy-guard-rules.ts).
// The only accepted exceptions are the exact strings in privacy-guard-exemptions.ts.
// Also scanned: Header/node-fs-for-browser-tests.d.ts, the test-only
// declaration file that lives with the shared types. App code (Source/
// files that are not tests) and the other shared types (Header/) are not
// scanned here; the build check (Helper/build-checks/check-no-network.mjs)
// covers their URLs.
//
// Files are read with Vite's import.meta.glob + "?raw"; a glob starting
// with "/" is relative to the repository root.

import { describe, expect, it } from 'vitest';
import { EXEMPTIONS_FILE, exemptionsFor, GUARD_EXEMPTIONS } from './privacy-guard-exemptions';
import {
    ALLOWED_TIME_ZONES,
    findForbiddenHosts,
    findPersonalPaths,
    findPrivacyProblems,
    findUnlistedTimeZones,
    withoutExemptions,
} from './privacy-guard-rules';

/** Test code as text, keyed by its path from the repository root with a leading "/", e.g. "/Helper/Test/browser-tests/clear.spec.ts". */
// Each Helper/ subfolder is listed by name: add any new Helper/ folder with
// tests here (and in the vitest "include" list in vite.config.ts).
const code = import.meta.glob<string>(['/Source/**/*.test.ts', '/Helper/Test/**/*', '!/Helper/Test/test-data/**', '/Helper/build-checks/**/*.test.*', '/Helper/lint-rules/**/*.test.*', '/Header/node-fs-for-browser-tests.d.ts'], {
    query: '?raw',
    import: 'default',
    eager: true,
    exhaustive: true,
});
const codePaths = Object.keys(code).sort();
/** The fixtures, keyed the same way: only to check that each exemption still matches its file. */
const fixtures = import.meta.glob<string>('/Helper/Test/test-data/**/*', { query: '?raw', import: 'default', eager: true, exhaustive: true });

describe('test code guard', () =>
{
    it('finds the test code in every scanned folder, and no app code or fixture', () =>
    {
        for (const path of ['/Source/web-page/page-shell.test.ts', '/Helper/Test/browser-tests/no-network.spec.ts', '/Helper/Test/browser-tests/support/network-and-csp-watch.ts', '/Helper/Test/test-support/pdf-reader.ts', '/Helper/build-checks/no-network-rules.test.ts', '/Helper/lint-rules/body-brace-style.test.ts'])
        {
            expect(codePaths, path).toContain(path);
        }
        expect(codePaths.filter((p) => p.startsWith('/Source/')).length).toBeGreaterThan(50);
        expect(codePaths.filter((p) => p.startsWith('/Source/') && !p.endsWith('.test.ts'))).toEqual([]);
        expect(codePaths.filter((p) => p.startsWith('/Helper/Test/test-data/'))).toEqual([]);
    });

    it.each(codePaths)('%s has no real-looking personal data', (path) =>
    {
        const text = withoutExemptions(code[path] ?? '', exemptionsFor(path.slice(1)));
        expect(findPrivacyProblems(text, 'code'), path).toEqual([]);
    });
});

describe('guard exemptions', () =>
{
    it.each(GUARD_EXEMPTIONS.map((e) => [`${e.file}: ${e.text}`, e] as const))('%s is needed, explained and found at least once in its file', (_, e) =>
    {
        expect(e.reason.length).toBeGreaterThan(10);
        expect(e.file).not.toBe(EXEMPTIONS_FILE);
        // Needed: without the exemption the guard would flag the string.
        expect(findPrivacyProblems(e.text, 'code')).not.toEqual([]);
        // Still used: the exact string is found at least once in its file.
        expect(code[`/${e.file}`] ?? fixtures[`/${e.file}`] ?? '').toContain(e.text);
    });

    it('lists each string once per file', () =>
    {
        const keys = GUARD_EXEMPTIONS.map((e) => `${e.file}\n${e.text}`);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it('applies to the named file only (and to the exemption list itself)', () =>
    {
        const [first] = GUARD_EXEMPTIONS;
        expect(first).toBeDefined();
        if (first === undefined)
        {
            return;
        }
        expect(exemptionsFor(first.file)).toContain(first.text);
        expect(exemptionsFor('Source/web-page/page-shell.test.ts')).toEqual([]);
        expect(exemptionsFor(EXEMPTIONS_FILE)).toEqual(GUARD_EXEMPTIONS.map((e) => e.text));
    });
});

// The guard must itself be trustworthy: prove each rule catches a planted
// problem. Bad samples are assembled from pieces at run time, so this file's
// own source (which the guard scans as a fixture) never contains one.
describe('test code guard rules (self-test)', () =>
{
    const bad = ['mail', 'example', 'com'].join('.');
    const badAddress = `someone@${bad}`;
    const hidden = ['planted', 'example'].join('.');
    const join = (sep: string, ...parts: string[]): string => parts.join(sep);

    it('flags addresses, URLs and bare hosts in code', () =>
    {
        expect(findForbiddenHosts(`const from = '${badAddress}';`, 'code')).not.toEqual([]);
        expect(findForbiddenHosts(`await page.goto('${'https:'}//${hidden}/x');`, 'code')).not.toEqual([]);
        expect(findForbiddenHosts(`// see ${bad}`, 'code')).not.toEqual([]);
        expect(findForbiddenHosts(`const host = 'www.${hidden}';`, 'code')).not.toEqual([]);
        expect(findForbiddenHosts(`const a = '${badAddress.replace('@', '%40')}';`, 'code')).not.toEqual([]);
        expect(findForbiddenHosts(`const a = '${badAddress.replace('@', '&#64;')}';`, 'code')).not.toEqual([]);
        expect(findForbiddenHosts(`const ip = '${join('.', '10', '1', '2', '3')}';`, 'code')).not.toEqual([]);
    });

    it('reads member names like .at and .info as code, but still flags such hosts in addresses, URLs and fixtures', () =>
    {
        // Assembled: this file is also scanned as a fixture, where these would count as hosts.
        const members = [`list.${'at'}(-1)`, `line.${'at'} + 1`, `document.${'info'}`, `run.glyphs.${'at'}(-1)`, `$x.${'at'}(0)`].join('; ');
        expect(findForbiddenHosts(members, 'code')).toEqual([]);
        expect(findForbiddenHosts(members)).not.toEqual([]);
        // Not member-like: three labels that are not called, or a label with a "-".
        for (const host of [`shop.example.${'at'}`, `mail-x.${'at'}`, `shop.mail-x.${'at'}(1)`, `mail-x.${'info'}`])
        {
            expect(findForbiddenHosts(`see ${host}`, 'code'), host).not.toEqual([]);
        }
        expect(findForbiddenHosts(`to: 'someone@shop.${'at'}'`, 'code')).not.toEqual([]);
        expect(findForbiddenHosts(`${'https:'}//shop.${'info'}/x`, 'code')).not.toEqual([]);
        expect(findForbiddenHosts(`${'www'}.shop.${'at'}`, 'code')).not.toEqual([]);
        expect(findForbiddenHosts(`Visit shop.${'at'} today`)).not.toEqual([]);
        expect(findForbiddenHosts('http://127.0.0.1:4173/ a@example.test https://cdn.invalid/x', 'code')).toEqual([]);
    });

    it('flags home-folder paths with a real-looking name', () =>
    {
        const planted = [
            join('\\', 'C:', 'Users', 'someone', 'x.ts'),
            join('/', 'C:', 'Users', 'someone'),
            join('\\\\', 'C:', 'Users', 'someone'),
            join('\\', 'D:', 'users', 'Some One'),
            join('/', '', 'home', 'someone', 'proj'),
            join('\\/', '', 'home', 'someone'),
            join('/', '', 'Users', 'someone', 'proj'),
            `file:///${join('/', 'C:', 'Users', 'someone')}/x`,
            join('%5C', 'C:', 'Users', 'someone'),
            `'${join('\\', '', 'Users', 'someone')}'`,
            // Git Bash and WSL mount-style drives.
            join('/', '', 'c', 'Users', 'someone'),
            join('/', '', 'mnt', 'c', 'Users', 'someone'),
            join('\\/', '', 'c', 'Users', 'someone'),
            `cd ${join('/', '', 'D', 'home', 'someone', 'proj')}`,
        ];
        for (const sample of planted)
        {
            expect(findPersonalPaths(sample), sample).not.toEqual([]);
        }
    });

    it('accepts generic placeholders and paths that are not home folders', () =>
    {
        const clean = [
            '/home/dev/proj/Source/pdf-export/fonts/A.woff',
            'C:\\Users\\user\\x',
            'C:/Users/Example/x',
            '/home/test.',
            'C:\\Users\\<name>\\x',
            '%USERPROFILE%\\x',
            '/home/${user}/x',
            'Source/users/someone',
            'a/b/users/x',
            'https://example.test/users/someone',
            'https://example.test/c/users/someone',
            '/c/Users/user/x',
            '~/proj',
        ];
        for (const sample of clean)
        {
            expect(findPersonalPaths(sample), sample).toEqual([]);
        }
    });

    it('accepts the allowed time zones in any case and spelling, and names that are not zones', () =>
    {
        for (const zone of ALLOWED_TIME_ZONES)
        {
            expect(findUnlistedTimeZones(`timeZone: '${zone}'`), zone).toEqual([]);
            expect(findUnlistedTimeZones(zone.toLowerCase().replace('/', '\\/')), zone).toEqual([]);
        }
        const clean = ["'UTC'", 'Date (America/New York)', 'ASIA_TOKYO', 'Asia%2FTokyo', 'Asian food, Indiana/x, Mars/Olympus_Mons, Pacific Standard Time'];
        for (const sample of clean)
        {
            expect(findUnlistedTimeZones(sample), sample).toEqual([]);
        }
    });

    it('flags any other time zone in any case and spelling', () =>
    {
        // Assembled: this file's own source is scanned too.
        const planted = [
            join('/', 'America', 'Chicago'),
            join('/', 'america', 'chicago'),
            join('\\/', 'America', 'Chicago'),
            join('\\', 'America', 'Chicago'),
            join('%2F', 'America', 'Chicago'),
            join('&sol;', 'America', 'Chicago'),
            join('_', 'AMERICA', 'CHICAGO'),
            join('-', 'America', 'Chicago'),
            `timeZone: '${join('/', 'Asia', 'Seoul')}'`,
            join('/', 'Etc', 'GMT+5'),
            join('/', 'America', 'Argentina', 'Salta'),
            // An allowed zone with something more is a different name.
            `${join('/', 'Asia', 'Tokyo')}2`,
            join('/', 'America', 'New_York', 'X'),
            `${join('/', 'America', 'New')} Jersey`,
        ];
        for (const sample of planted)
        {
            expect(findUnlistedTimeZones(sample), sample).not.toEqual([]);
        }
    });

    it('combines all rules in findPrivacyProblems', () =>
    {
        const text = [badAddress, join('/', '', 'home', 'someone'), join('/', 'America', 'Chicago')].join('\n');
        expect(findPrivacyProblems(text, 'code')).toHaveLength(4); // email domain + bare host + path + zone
    });

    it('blanks only exact exempted strings, and never a longer host', () =>
    {
        const url = `${'http:'}//${bad}`;
        expect(findForbiddenHosts(withoutExemptions(`see ${url}. or ${url}/x`, [url]), 'code')).toEqual([]);
        // Other case, other host, longer host: still flagged.
        expect(findForbiddenHosts(withoutExemptions(url.toUpperCase(), [url]), 'code')).not.toEqual([]);
        expect(findForbiddenHosts(withoutExemptions(`${url}.more.labels/x`, [url]), 'code')).not.toEqual([]);
        expect(findForbiddenHosts(withoutExemptions(`${url}x/y`, [url]), 'code')).not.toEqual([]);
        expect(findForbiddenHosts(withoutExemptions(`${'http:'}//${hidden}/`, [url]), 'code')).not.toEqual([]);
        // User info or an encoded dot right after the exempted host: a different host, still flagged.
        // (`x.example` and `evil` alone are not flagged, so only the URL itself can be caught.)
        expect(findForbiddenHosts(withoutExemptions(`${url}@x.example/y`, [url]), 'code')).not.toEqual([]);
        expect(findForbiddenHosts(withoutExemptions(`${url}%2Eevil/y`, [url]), 'code')).not.toEqual([]);
        expect(findForbiddenHosts(withoutExemptions(`${url}@x.${'edu'}`, [url]), 'code')).not.toEqual([]);
        // An exempted host name is not blanked inside an address or a longer name.
        expect(findForbiddenHosts(withoutExemptions(`see ${bad} and someone@${bad}`, [bad]), 'code')).not.toEqual([]);
        expect(findForbiddenHosts(withoutExemptions(`www.${bad}`, [bad]), 'code')).not.toEqual([]);
        expect(findForbiddenHosts(withoutExemptions(`see ${bad}/x, (${bad}).`, [bad]), 'code')).toEqual([]);
        // A shorter exempted string inside a longer exempted one does not cut it in two.
        expect(withoutExemptions(`${url}/a/b`, [url, `${url}/a/b`])).toBe(' ');
    });
});
