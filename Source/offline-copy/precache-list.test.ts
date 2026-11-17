import { describe, expect, it } from 'vitest';
import { cloudflareHeadersFile, PERMISSIONS_POLICY } from '../security-headers/headers';
import { injectManifest, MANIFEST_PLACEHOLDER, manifestVersion, precachePaths, readBuiltManifest, SW_FILE_NAME, VERSION_LENGTH } from './precache-list';
import swSource from './service-worker.ts?raw';
import { parseManifest } from './sw-logic';

const DIST = ['index.html', 'assets/index-abc123.js', 'assets/index-def456.css', 'assets/pdf-fonts-ghi789.js', 'THIRD_PARTY_NOTICES.txt', '_headers', 'sw.js'];

describe('precachePaths', () =>
{
    it('lists every built file, index.html as "/", sorted, without _headers and sw.js', () =>
    {
        expect(precachePaths(DIST)).toEqual(['/', '/THIRD_PARTY_NOTICES.txt', '/assets/index-abc123.js', '/assets/index-def456.css', '/assets/pdf-fonts-ghi789.js']);
    });

    it('gives the same list whatever the order of the files', () =>
    {
        expect(precachePaths([...DIST].reverse())).toEqual(precachePaths(DIST));
    });

    it('leaves out host settings files and source maps', () =>
    {
        expect(precachePaths(['index.html', '_redirects', '_routes.json', 'assets/index-abc123.js.map'])).toEqual(['/']);
    });

    it('never lists /index.html (hosts redirect it to "/")', () =>
    {
        expect(precachePaths(DIST)).not.toContain('/index.html');
    });

    it('uses the base path', () =>
    {
        expect(precachePaths(['index.html', 'assets/a.js'], '/tool/')).toEqual(['/tool/', '/tool/assets/a.js']);
        expect(() => precachePaths(['index.html'], 'tool')).toThrow(/base/);
    });

    it('throws without index.html', () =>
    {
        expect(() => precachePaths(['assets/a.js'])).toThrow(/index\.html/);
    });

    it('throws on a name that is not a plain file path', () =>
    {
        for (const name of ['a b.js', 'a?.js', 'a#.js', '../a.js', 'a/../b.js', '/a.js', 'a\\b.js', '.hidden', 'assets/'])
        {
            expect(() => precachePaths(['index.html', name]), name).toThrow(/plain file path/);
        }
    });

    it('throws on a duplicate', () =>
    {
        expect(() => precachePaths(['index.html', 'a.js', 'a.js'])).toThrow(/twice/);
    });
});

describe('manifestVersion', () =>
{
    const files = [
        { path: '/', bytes: new TextEncoder().encode('<html>') },
        { path: '/assets/a.js', bytes: new Uint8Array([1, 2, 3]) },
    ];

    const headers = cloudflareHeadersFile();

    it('is a fixed-length lowercase hex hash, the same for the same build', () =>
    {
        const version = manifestVersion(files, 'sw code', headers);
        expect(version).toMatch(new RegExp(`^[0-9a-f]{${String(VERSION_LENGTH)}}$`));
        expect(manifestVersion([...files].reverse(), 'sw code', headers)).toBe(version);
        expect(manifestVersion(files, 'sw code', new TextEncoder().encode(headers))).toBe(version);
    });

    it('changes when a file, a path, the service worker code or the headers change', () =>
    {
        const version = manifestVersion(files, 'sw code', headers);
        const changed = [
            manifestVersion([files[0]!, { path: '/assets/a.js', bytes: new Uint8Array([1, 2, 4]) }], 'sw code', headers),
            manifestVersion([files[0]!, { path: '/assets/b.js', bytes: new Uint8Array([1, 2, 3]) }], 'sw code', headers),
            manifestVersion([files[0]!], 'sw code', headers),
            manifestVersion(files, 'sw code 2', headers),
            manifestVersion(files, 'sw code', `${headers} `),
            manifestVersion(files, 'sw code', new Uint8Array()),
        ];
        for (const other of changed)
        {
            expect(other).not.toBe(version);
        }
        expect(new Set(changed).size).toBe(changed.length);
    });

    it('changes when only a header value changes (no file changed)', () =>
    {
        // The case that matters: one more feature switched off in
        // Permissions-Policy changes dist/_headers but no stored file.
        expect(headers).toContain(PERMISSIONS_POLICY);
        const stricter = headers.replace(PERMISSIONS_POLICY, `${PERMISSIONS_POLICY}, bluetooth=()`);
        expect(stricter).not.toBe(headers);
        expect(manifestVersion(files, 'sw code', stricter)).not.toBe(manifestVersion(files, 'sw code', headers));
    });

    it('is the same computed from the built sw.js as from the code before the list was written (what the build check does)', () =>
    {
        const manifest = { version: '0123456789abcdef0123', paths: ['/', '/assets/a.js'] };
        for (const quote of ['"', "'", '`'])
        {
            const before = `var c=a(${quote}${MANIFEST_PLACEHOLDER}${quote});`;
            const built = injectManifest(before, manifest);
            expect(manifestVersion(files, built, headers), quote).toBe(manifestVersion(files, before, headers));
            expect(readBuiltManifest(built)).toEqual(manifest);
        }
        // The code around the list still counts.
        expect(manifestVersion(files, injectManifest(`var d=a("${MANIFEST_PLACEHOLDER}");`, manifest), headers)).not.toBe(
            manifestVersion(files, `var c=a("${MANIFEST_PLACEHOLDER}");`, headers),
        );
    });

    it('changes when only a string in the service worker code changes (only the list itself is left out)', () =>
    {
        for (const quote of ['"', "'", '`'])
        {
            expect(manifestVersion(files, `a(${quote}x${quote})`, headers), quote).not.toBe(manifestVersion(files, `a(${quote}y${quote})`, headers));
        }
        // Strings that look like JSON but are not the written list still count:
        // the list is only a double-quoted {"version":...} string.
        const decoys = ['a("{}")', 'a("{\\"paths\\":[]}")', `a('{"version":1}')`, 'a(`{"version":1}`)'];
        for (const decoy of decoys)
        {
            expect(manifestVersion(files, decoy, headers), decoy).not.toBe(manifestVersion(files, 'a("")', headers));
        }
        expect(new Set(decoys.map((decoy) => manifestVersion(files, decoy, headers))).size).toBe(decoys.length);
    });
});

describe('readBuiltManifest', () =>
{
    it('throws unless the built list is there exactly once', () =>
    {
        const manifest = { version: '0123456789abcdef0123', paths: ['/'] };
        const one = injectManifest(`a("${MANIFEST_PLACEHOLDER}")`, manifest);
        expect(() => readBuiltManifest('a("x")')).toThrow(/exactly once/);
        expect(() => readBuiltManifest(`a("${MANIFEST_PLACEHOLDER}")`)).toThrow(/exactly once/);
        expect(() => readBuiltManifest(`${one};${one}`)).toThrow(/exactly once/);
    });
});

describe('injectManifest', () =>
{
    const manifest = { version: '0123456789abcdef0123', paths: ['/', '/assets/a.js'] };

    it('replaces the placeholder string with the list, readable by the service worker', () =>
    {
        for (const quote of ['"', "'", '`'])
        {
            const code = `var c=a(${quote}${MANIFEST_PLACEHOLDER}${quote});`;
            const out = injectManifest(code, manifest);
            expect(out).not.toContain(MANIFEST_PLACEHOLDER);
            const literal = /^var c=a\((".*")\);$/.exec(out)?.[1] ?? '';
            expect(parseManifest(JSON.parse(literal) as string)).toEqual(manifest);
        }
    });

    it('throws unless the placeholder is there exactly once, as a whole string', () =>
    {
        for (const code of ['var c=a("x");', `a("${MANIFEST_PLACEHOLDER}");b("${MANIFEST_PLACEHOLDER}");`, `a(${MANIFEST_PLACEHOLDER});`, `a("x${MANIFEST_PLACEHOLDER}");`, `a("${MANIFEST_PLACEHOLDER}'`])
        {
            expect(() => injectManifest(code, manifest), code).toThrow(/exactly once/);
        }
    });

    it('only writes the version and the paths', () =>
    {
        const out = injectManifest(`a("${MANIFEST_PLACEHOLDER}")`, { ...manifest, extra: 'x' } as typeof manifest);
        expect(out).not.toContain('extra');
    });
});

describe('the service worker source', () =>
{
    it('holds the placeholder exactly once, in the string it parses', () =>
    {
        expect(swSource.split(MANIFEST_PLACEHOLDER)).toHaveLength(2);
        expect(swSource).toContain(`parseManifest('${MANIFEST_PLACEHOLDER}')`);
    });

    it('never stores at run time: the only writes are the install-time addAll of the list', () =>
    {
        // Only code lines (comments may name things the worker does not do).
        const code = swSource
            .split('\n')
            .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/**'))
            .join('\n');
        expect(code.match(/\.put\(|\.add\(/g)).toBeNull();
        expect(code.match(/\.addAll\(/g)).toHaveLength(1);
        expect(code).toContain('cache.addAll(MANIFEST.paths.map(');
        // No other way to keep anything.
        expect(code).not.toMatch(/indexedDB|localStorage|sessionStorage|importScripts|postMessage|clients\.matchAll/);
    });

    it("stores the files straight from the site at install (cache: 'reload'), not from the browser's HTTP cache", () =>
    {
        const code = swSource
            .split('\n')
            .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/**'))
            .join('\n');
        // The one addAll stores one Request per listed path, each with cache: 'reload'.
        expect(code).toContain("cache.addAll(MANIFEST.paths.map((path) => new Request(path, { cache: 'reload' })))");
        expect(code.match(/new Request\(/g)).toHaveLength(1);
    });

    it('answers from the current cache only, without ever creating one (caches.open only at install)', () =>
    {
        const code = swSource
            .split('\n')
            .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/**'))
            .join('\n');
        // answer(): caches.match with cacheName (it never creates a cache);
        // caches.open would create the cache again if the browser cleared it.
        const answer = /async function answer\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(code)?.[1] ?? '';
        expect(answer).toContain('caches.match(path, { cacheName: CACHE })');
        expect(answer).not.toContain('caches.open(');
        // The one caches.open is the install-time store.
        expect(code.match(/caches\.open\(/g)).toHaveLength(1);
        const store = /async function storeOwnFiles\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(code)?.[1] ?? '';
        expect(store).toContain('caches.open(CACHE)');
    });

    it('is served as sw.js', () =>
    {
        expect(SW_FILE_NAME).toBe('sw.js');
    });
});
