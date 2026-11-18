import { describe, expect, it } from 'vitest';
import { CACHE_PREFIX, cacheNameFor, isOldCacheOfOurs, isPlainPath, parseManifest, precachedPathFor } from './service-worker-logic';

const SITE_ORIGIN = 'https://tool.example.test';
const LISTED_PATHS: ReadonlySet<string> = new Set(['/', '/assets/index-abc123.js', '/assets/index-def456.css', '/THIRD_PARTY_NOTICES.txt']);
const getRequest = (url: string) => ({ method: 'GET', url });

describe('precachedPathFor (which requests the service worker answers)', () =>
{
    it('answers a GET of a listed path of this site, the page included', () =>
    {
        expect(precachedPathFor(getRequest(`${SITE_ORIGIN}/`), SITE_ORIGIN, LISTED_PATHS)).toBe('/');
        expect(precachedPathFor(getRequest(`${SITE_ORIGIN}/assets/index-abc123.js`), SITE_ORIGIN, LISTED_PATHS)).toBe('/assets/index-abc123.js');
        expect(precachedPathFor(getRequest(`${SITE_ORIGIN}/THIRD_PARTY_NOTICES.txt`), SITE_ORIGIN, LISTED_PATHS)).toBe('/THIRD_PARTY_NOTICES.txt');
    });

    it('works on a local http address too (the preview server)', () =>
    {
        const localOrigin = 'http://127.0.0.1:4173';
        expect(precachedPathFor(getRequest(`${localOrigin}/`), localOrigin, LISTED_PATHS)).toBe('/');
    });

    it('leaves every method but GET alone', () =>
    {
        for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'get'])
        {
            expect(precachedPathFor({ method, url: `${SITE_ORIGIN}/` }, SITE_ORIGIN, LISTED_PATHS), method).toBeNull();
        }
    });

    it('leaves other sites alone, even for a listed path', () =>
    {
        for (const url of [
            'https://other.example.test/',
            'https://cdn.invalid/assets/index-abc123.js',
            'http://tool.example.test/', // same host, other scheme
            'https://tool.example.test:8443/', // same host, other port
            'https://sub.tool.example.test/',
        ])
        {
            expect(precachedPathFor(getRequest(url), SITE_ORIGIN, LISTED_PATHS), url).toBeNull();
        }
    });

    it('leaves blob:, data: and other schemes alone', () =>
    {
        for (const url of [`blob:${SITE_ORIGIN}/0b8f5f43-3c8e-4a52-9b8a-2a6a1b4e7f10`, 'data:text/plain,hello', 'about:blank',
            `ws://tool.example.test/`, 'file:///index.html'])
        {
            expect(precachedPathFor(getRequest(url), SITE_ORIGIN, LISTED_PATHS), url).toBeNull();
        }
    });

    it('leaves query-string variants alone, even an empty "?"', () =>
    {
        for (const url of [`${SITE_ORIGIN}/?x=1`, `${SITE_ORIGIN}/?`, `${SITE_ORIGIN}/assets/index-abc123.js?v=2`, `${SITE_ORIGIN}/?email=someone`])
        {
            expect(precachedPathFor(getRequest(url), SITE_ORIGIN, LISTED_PATHS), url).toBeNull();
        }
    });

    it('leaves URLs with a user name or password alone', () =>
    {
        expect(precachedPathFor(getRequest('https://user:secret@tool.example.test/'), SITE_ORIGIN, LISTED_PATHS)).toBeNull();
        expect(precachedPathFor(getRequest('https://user@tool.example.test/'), SITE_ORIGIN, LISTED_PATHS)).toBeNull();
    });

    it('leaves every unlisted path alone', () =>
    {
        for (const path of ['/index.html', '/sw.js', '/_headers', '/assets/', '/assets/index-abc123.JS', '/assets/other.js', '/favicon.ico', '/x/', '//'])
        {
            expect(precachedPathFor(getRequest(`${SITE_ORIGIN}${path}`), SITE_ORIGIN, LISTED_PATHS), path).toBeNull();
        }
    });

    it('leaves an unreadable URL alone', () =>
    {
        expect(precachedPathFor(getRequest('not a url'), SITE_ORIGIN, LISTED_PATHS)).toBeNull();
        expect(precachedPathFor(getRequest(''), SITE_ORIGIN, LISTED_PATHS)).toBeNull();
    });

    it('matches the normalised path ("/./" and "/a/../" steps are resolved by URL, as a browser does)', () =>
    {
        expect(precachedPathFor(getRequest(`${SITE_ORIGIN}/./assets/index-abc123.js`), SITE_ORIGIN, LISTED_PATHS)).toBe('/assets/index-abc123.js');
        expect(precachedPathFor(getRequest(`${SITE_ORIGIN}/x/../`), SITE_ORIGIN, LISTED_PATHS)).toBe('/');
    });

    it('ignores a fragment, but a "?" after "#" still leaves the request alone (README, "Offline copy")', () =>
    {
        expect(precachedPathFor(getRequest('https://site.test/#top'), 'https://site.test', LISTED_PATHS)).toBe('/');
        expect(precachedPathFor(getRequest('https://site.test/#a?b'), 'https://site.test', LISTED_PATHS)).toBeNull();
    });
});

describe('cache names', () =>
{
    it('are the prefix plus the version', () =>
    {
        expect(cacheNameFor('0123456789abcdef0123')).toBe(`${CACHE_PREFIX}0123456789abcdef0123`);
    });

    it('deletes only older caches of this service worker', () =>
    {
        const currentCacheName = cacheNameFor('aaaaaaaaaaaaaaaaaaaa');
        expect(isOldCacheOfOurs(cacheNameFor('bbbbbbbbbbbbbbbbbbbb'), currentCacheName)).toBe(true);
        expect(isOldCacheOfOurs(currentCacheName, currentCacheName)).toBe(false);
        for (const otherCacheName of ['workbox-precache-v2', 'other-site-cache', '', `x-${currentCacheName}`])
        {
            expect(isOldCacheOfOurs(otherCacheName, currentCacheName), otherCacheName).toBe(false);
        }
    });
});

describe('isPlainPath', () =>
{
    it('accepts plain site paths', () =>
    {
        for (const path of ['/', '/a.js', '/assets/index-abc_123.js', '/THIRD_PARTY_NOTICES.txt', '/a/b/c.css'])
        {
            expect(isPlainPath(path), path).toBe(true);
        }
    });

    it('refuses anything else', () =>
    {
        for (const path of ['', 'a.js', '//', '/a//b', '/a/', '/../a', '/a/../b', '/./a', '/.hidden', '/a?b', '/a#b', '/a%20b', '/a b', '/a\\b', 'https://x.invalid/a'])
        {
            expect(isPlainPath(path), path).toBe(false);
        }
    });
});

describe('parseManifest', () =>
{
    const validManifest = { version: '0123456789abcdef0123', paths: ['/', '/assets/a.js'] };

    it('reads a well-formed list', () =>
    {
        expect(parseManifest(JSON.stringify(validManifest))).toEqual(validManifest);
    });

    it('throws on the unreplaced placeholder (a build without the plugin)', () =>
    {
        expect(() => parseManifest('__SW_PRECACHE_MANIFEST__')).toThrow();
    });

    it('throws on anything not exactly the expected shape', () =>
    {
        for (const bad of [
            null,
            [],
            'x',
            { paths: validManifest.paths },
            { version: 'XYZ', paths: validManifest.paths },
            { version: '0123', paths: validManifest.paths },
            { version: validManifest.version },
            { version: validManifest.version, paths: [] },
            { version: validManifest.version, paths: ['/', 1] },
            { version: validManifest.version, paths: ['/', '/a.js?x'] },
            { version: validManifest.version, paths: ['/', 'https://cdn.invalid/a.js'] },
            { version: validManifest.version, paths: ['/', '/'] },
            { ...validManifest, extra: true },
        ])
        {
            expect(() => parseManifest(JSON.stringify(bad)), JSON.stringify(bad)).toThrow();
        }
    });
});
