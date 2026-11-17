// Pure logic of the service worker (src/sw/service-worker.ts): which
// requests it may answer from its copy of the site's own files, and which
// caches are its own. No browser API is used here, so every rule is unit
// tested in Node (sw-logic.test.ts; README.md, rule R7).
//
// What the service worker keeps (README.md, rule R5): ONLY the site's own
// static files listed at build time (the precache list, see
// precache-list.ts), so that the page can also be opened again while
// offline. Never an email, a PDF, a file you added, or anything made from
// them: those live in the page's memory only, and the service worker never
// stores anything it is sent at run time.

/** Every cache this site's service worker makes starts with this. */
export const CACHE_PREFIX = 'email-to-pdf-offline-';

/** The precache list built into sw.js: a version and the paths it stores. */
export interface PrecacheManifest {
    /** Content hash of the listed files (and of the service worker's own code). */
    readonly version: string;
    /** URL paths, e.g. "/" (the page), "/assets/index-abc123.js". */
    readonly paths: readonly string[];
}

/** The cache of one version of the site. */
export function cacheNameFor(version: string): string
{
    return `${CACHE_PREFIX}${version}`;
}

/**
 * Should this cache be deleted when version `current` takes over? Only the
 * caches of this service worker (by prefix), never the current one. Caches
 * the site did not make are left alone.
 */
export function isOldCacheOfOurs(name: string, current: string): boolean
{
    return name.startsWith(CACHE_PREFIX) && name !== current;
}

const VERSION = /^[0-9a-f]{16,64}$/;
// A path of the site: "/" then letters, digits, ".", "_", "-" and "/" only
// (no query string, no fragment, no escapes, no ".." step).
const PATH = /^\/(?:[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*)?$/;

/** Is `path` a plain path of this site, as the precache list holds them? */
export function isPlainPath(path: string): boolean
{
    return PATH.test(path) && !path.split('/').includes('..');
}

/**
 * Reads the precache list written into sw.js by the build (JSON). Throws
 * if it is not exactly the expected shape, so a broken build never
 * installs (the page then simply works as without a service worker).
 */
export function parseManifest(json: string): PrecacheManifest
{
    const value: unknown = JSON.parse(json);
    if (typeof value !== 'object' || value === null)
    {
        throw new Error('precache list: not an object');
    }
    const { version, paths } = value as { version?: unknown; paths?: unknown };
    if (typeof version !== 'string' || !VERSION.test(version))
    {
        throw new Error('precache list: bad version');
    }
    if (!Array.isArray(paths) || paths.length === 0)
    {
        throw new Error('precache list: no paths');
    }
    const list: string[] = [];
    for (const path of paths as unknown[])
    {
        if (typeof path !== 'string' || !isPlainPath(path))
        {
            throw new Error('precache list: bad path');
        }
        list.push(path);
    }
    if (new Set(list).size !== list.length)
    {
        throw new Error('precache list: duplicate path');
    }
    if (Object.keys(value).length !== 2)
    {
        throw new Error('precache list: unexpected field');
    }
    return { version, paths: list };
}

/** What the request filter looks at: the request's method and full URL. */
export interface RequestLike {
    readonly method: string;
    readonly url: string;
}

/**
 * The precache path that answers `request`, or null to leave the request
 * alone (the browser then handles it as if there were no service worker,
 * and the page's CSP still applies).
 *
 * Answered: only a GET of this site (`origin`, http or https), with no
 * query string and no user name or password in the URL, whose path is
 * exactly one of `paths`. A navigation to "/" gets the stored page.
 * Everything else is left alone: other methods (POST, ...), other sites,
 * blob: and data: URLs, "?..." variants, and any path not in the list.
 */
export function precachedPathFor(request: RequestLike, origin: string, paths: ReadonlySet<string>): string | null
{
    if (request.method !== 'GET')
    {
        return null;
    }
    let url: URL;
    try
    {
        url = new URL(request.url);
    }
    catch
    {
        return null;
    }
    // A blob: URL reports the origin of the page that made it, so the scheme
    // is checked first.
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
    {
        return null;
    }
    if (url.origin !== origin)
    {
        return null;
    }
    if (url.search !== '' || url.username !== '' || url.password !== '')
    {
        return null;
    }
    // `url.search` is "" for a lone "?" too: refuse it on the raw text.
    if (request.url.includes('?'))
    {
        return null;
    }
    return paths.has(url.pathname) ? url.pathname : null;
}
