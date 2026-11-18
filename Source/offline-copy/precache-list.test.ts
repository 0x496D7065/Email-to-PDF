import { describe, expect, it } from 'vitest';
import { cloudflareHeadersFile, PERMISSIONS_POLICY } from '../security-headers/headers';
import { injectManifest, MANIFEST_PLACEHOLDER, manifestVersion, precachePaths, readBuiltManifest, SERVICE_WORKER_FILE_NAME,
    VERSION_LENGTH } from './precache-list';
import serviceWorkerSource from './service-worker.ts?raw';
import { parseManifest } from './service-worker-logic';

const DIST_FILE_NAMES = ['index.html', 'assets/index-abc123.js', 'assets/index-def456.css', 'assets/pdf-fonts-ghi789.js', 'THIRD_PARTY_NOTICES.txt',
    '_headers', 'sw.js'];

describe('precachePaths', () =>
{
    it('lists every built file, index.html as "/", sorted, without _headers and sw.js', () =>
    {
        expect(precachePaths(DIST_FILE_NAMES)).toEqual(
            ['/', '/THIRD_PARTY_NOTICES.txt', '/assets/index-abc123.js', '/assets/index-def456.css', '/assets/pdf-fonts-ghi789.js']);
    });

    it('gives the same list whatever the order of the files', () =>
    {
        expect(precachePaths([...DIST_FILE_NAMES].reverse())).toEqual(precachePaths(DIST_FILE_NAMES));
    });

    it('leaves out host settings files and source maps', () =>
    {
        expect(precachePaths(['index.html', '_redirects', '_routes.json', 'assets/index-abc123.js.map'])).toEqual(['/']);
    });

    it('never lists /index.html (hosts redirect it to "/")', () =>
    {
        expect(precachePaths(DIST_FILE_NAMES)).not.toContain('/index.html');
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

    const headersFile = cloudflareHeadersFile();

    it('is a fixed-length lowercase hex hash, the same for the same build', () =>
    {
        const version = manifestVersion(files, 'sw code', headersFile);
        expect(version).toMatch(new RegExp(`^[0-9a-f]{${String(VERSION_LENGTH)}}$`));
        expect(manifestVersion([...files].reverse(), 'sw code', headersFile)).toBe(version);
        expect(manifestVersion(files, 'sw code', new TextEncoder().encode(headersFile))).toBe(version);
    });

    it('changes when a file, a path, the service worker code or the headers change', () =>
    {
        const version = manifestVersion(files, 'sw code', headersFile);
        const changedVersions = [
            manifestVersion([files[0]!, { path: '/assets/a.js', bytes: new Uint8Array([1, 2, 4]) }], 'sw code', headersFile),
            manifestVersion([files[0]!, { path: '/assets/b.js', bytes: new Uint8Array([1, 2, 3]) }], 'sw code', headersFile),
            manifestVersion([files[0]!], 'sw code', headersFile),
            manifestVersion(files, 'sw code 2', headersFile),
            manifestVersion(files, 'sw code', `${headersFile} `),
            manifestVersion(files, 'sw code', new Uint8Array()),
        ];
        for (const changedVersion of changedVersions)
        {
            expect(changedVersion).not.toBe(version);
        }
        expect(new Set(changedVersions).size).toBe(changedVersions.length);
    });

    it('changes when only a header value changes (no file changed)', () =>
    {
        // The case that matters: one more feature switched off in
        // Permissions-Policy changes dist/_headers but no stored file.
        expect(headersFile).toContain(PERMISSIONS_POLICY);
        const stricterHeaders = headersFile.replace(PERMISSIONS_POLICY, `${PERMISSIONS_POLICY}, bluetooth=()`);
        expect(stricterHeaders).not.toBe(headersFile);
        expect(manifestVersion(files, 'sw code', stricterHeaders)).not.toBe(manifestVersion(files, 'sw code', headersFile));
    });

    it('is the same computed from the built sw.js as from the code before the list was written (what the build check does)', () =>
    {
        const manifest = { version: '0123456789abcdef0123', paths: ['/', '/assets/a.js'] };
        for (const quote of ['"', "'", '`'])
        {
            const before = `var c=a(${quote}${MANIFEST_PLACEHOLDER}${quote});`;
            const built = injectManifest(before, manifest);
            expect(manifestVersion(files, built, headersFile), quote).toBe(manifestVersion(files, before, headersFile));
            expect(readBuiltManifest(built)).toEqual(manifest);
        }
        // The code around the list still counts.
        expect(manifestVersion(files, injectManifest(`var d=a("${MANIFEST_PLACEHOLDER}");`, manifest), headersFile)).not.toBe(
            manifestVersion(files, `var c=a("${MANIFEST_PLACEHOLDER}");`, headersFile),
        );
    });

    it('changes when only a string in the service worker code changes (only the list itself is left out)', () =>
    {
        for (const quote of ['"', "'", '`'])
        {
            expect(manifestVersion(files, `a(${quote}x${quote})`, headersFile), quote).not.toBe(
                manifestVersion(files, `a(${quote}y${quote})`, headersFile));
        }
        // Strings that look like JSON but are not the written list still count:
        // the list is only a double-quoted {"version":...} string.
        const decoys = ['a("{}")', 'a("{\\"paths\\":[]}")', `a('{"version":1}')`, 'a(`{"version":1}`)'];
        for (const decoy of decoys)
        {
            expect(manifestVersion(files, decoy, headersFile), decoy).not.toBe(manifestVersion(files, 'a("")', headersFile));
        }
        expect(new Set(decoys.map((decoy) => manifestVersion(files, decoy, headersFile))).size).toBe(decoys.length);
    });
});

describe('readBuiltManifest', () =>
{
    it('throws unless the built list is there exactly once', () =>
    {
        const manifest = { version: '0123456789abcdef0123', paths: ['/'] };
        const builtOnce = injectManifest(`a("${MANIFEST_PLACEHOLDER}")`, manifest);
        expect(() => readBuiltManifest('a("x")')).toThrow(/exactly once/);
        expect(() => readBuiltManifest(`a("${MANIFEST_PLACEHOLDER}")`)).toThrow(/exactly once/);
        expect(() => readBuiltManifest(`${builtOnce};${builtOnce}`)).toThrow(/exactly once/);
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
            const injected = injectManifest(code, manifest);
            expect(injected).not.toContain(MANIFEST_PLACEHOLDER);
            const writtenLiteral = /^var c=a\((".*")\);$/.exec(injected)?.[1] ?? '';
            expect(parseManifest(JSON.parse(writtenLiteral) as string)).toEqual(manifest);
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
        const injected = injectManifest(`a("${MANIFEST_PLACEHOLDER}")`, { ...manifest, extra: 'x' } as typeof manifest);
        expect(injected).not.toContain('extra');
    });
});

describe('the service worker source', () =>
{
    it('holds the placeholder exactly once, in the string it parses', () =>
    {
        expect(serviceWorkerSource.split(MANIFEST_PLACEHOLDER)).toHaveLength(2);
        expect(serviceWorkerSource).toContain(`parseManifest('${MANIFEST_PLACEHOLDER}')`);
    });

    it('never stores at run time: the only writes are the install-time addAll of the list', () =>
    {
        // Only code lines (comments may name things the worker does not do).
        const codeWithoutComments = serviceWorkerSource
            .split('\n')
            .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/**'))
            .join('\n');
        expect(codeWithoutComments.match(/\.put\(|\.add\(/g)).toBeNull();
        expect(codeWithoutComments.match(/\.addAll\(/g)).toHaveLength(1);
        expect(codeWithoutComments).toContain('cache.addAll(MANIFEST.paths.map(');
        // No other way to keep anything.
        expect(codeWithoutComments).not.toMatch(/indexedDB|localStorage|sessionStorage|importScripts|postMessage|clients\.matchAll/);
    });

    it("stores the files straight from the site at install (cache: 'reload'), not from the browser's HTTP cache", () =>
    {
        const codeWithoutComments = serviceWorkerSource
            .split('\n')
            .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/**'))
            .join('\n');
        // The one addAll stores one Request per listed path, each with cache: 'reload'.
        expect(codeWithoutComments).toContain("cache.addAll(MANIFEST.paths.map((path) => new Request(path, { cache: 'reload' })))");
        expect(codeWithoutComments.match(/new Request\(/g)).toHaveLength(1);
    });

    it('answers from the current cache only, without ever creating one (caches.open only at install)', () =>
    {
        const codeWithoutComments = serviceWorkerSource
            .split('\n')
            .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/**'))
            .join('\n');
        // answer(): caches.match with cacheName (it never creates a cache);
        // caches.open would create the cache again if the browser cleared it.
        const answerBody = /async function answer\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(codeWithoutComments)?.[1] ?? '';
        expect(answerBody).toContain('caches.match(path, { cacheName: CACHE })');
        expect(answerBody).not.toContain('caches.open(');
        // The one caches.open is the install-time store.
        expect(codeWithoutComments.match(/caches\.open\(/g)).toHaveLength(1);
        const storeBody = /async function storeOwnFiles\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(codeWithoutComments)?.[1] ?? '';
        expect(storeBody).toContain('caches.open(CACHE)');
    });

    it('is served as sw.js', () =>
    {
        expect(SERVICE_WORKER_FILE_NAME).toBe('sw.js');
    });
});
