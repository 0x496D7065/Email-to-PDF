// Build-time half of the service worker: the precache list, made from the
// files the build writes into dist/. Used ONLY by the build (the
// offline-copy plugin, Helper/vite-plugins/offline-copy-plugin.ts), never by the page. Pure functions (the plugin does
// the file reading), unit tested in precache-list.test.ts.
//
// The list is every file the site serves, minus the ones that are not
// part of the page: the Cloudflare Pages settings files and the service
// worker script itself. dist/index.html is listed as the site's address,
// "/" (what the browser asks for when the page is opened), never as
// "/index.html": hosts such as Cloudflare Pages redirect that to "/", and a
// redirected copy cannot be used to open the page.

// With its extension: the offline-copy plugin loads this file, and Vite's future
// native config loader needs it (as for Source/security-headers/headers.ts).
import { MANIFEST_PLACEHOLDER } from '../../Helper/build-checks/service-worker-version.mjs';
import { isPlainPath, type PrecacheManifest } from './service-worker-logic.ts';

// The version and the placeholder live in a plain-JS module shared with the
// build check, which computes the version again from dist/
// (Helper/build-checks/check-no-network.mjs): one function, so the two cannot drift.
export { MANIFEST_PLACEHOLDER, manifestVersion, readBuiltManifest, VERSION_LENGTH } from '../../Helper/build-checks/service-worker-version.mjs';

/** File name of the service worker script in dist/ (served as /sw.js). */
export const SERVICE_WORKER_FILE_NAME = 'sw.js';

/** dist/ files that are never stored: host settings files and the service worker itself. */
const NEVER_PRECACHED: ReadonlySet<string> = new Set(['_headers', '_redirects', '_routes.json', SERVICE_WORKER_FILE_NAME]);

/**
 * The precache paths for the files of dist/ (`fileNames`: paths relative
 * to dist/, with forward slashes), for a site served at `base` ("/").
 * Sorted, so the same build always gives the same list. Source maps are
 * left out. Throws on a name that is not a plain path, on a duplicate, and
 * if there is no index.html (the page itself).
 */
export function precachePaths(fileNames: readonly string[], base = '/'): string[]
{
    if (!base.startsWith('/') || !base.endsWith('/'))
    {
        throw new Error(`precache list: base must start and end with "/", not ${base}`);
    }
    const paths: string[] = [];
    let hasIndexHtml = false;
    for (const fileName of fileNames)
    {
        if (NEVER_PRECACHED.has(fileName) || fileName.endsWith('.map'))
        {
            continue;
        }
        const path = fileName === 'index.html' ? base : `${base}${fileName}`;
        if (fileName === 'index.html')
        {
            hasIndexHtml = true;
        }
        else if (!isPlainPath(path))
        {
            throw new Error(`precache list: "${fileName}" is not a plain file path`);
        }
        paths.push(path);
    }
    if (!hasIndexHtml)
    {
        throw new Error('precache list: dist/index.html is missing');
    }
    if (new Set(paths).size !== paths.length)
    {
        throw new Error('precache list: a file is listed twice');
    }
    return paths.sort();
}

/**
 * `code` (the built sw.js) with the placeholder string literal replaced by
 * the precache list, as a JSON text in a JavaScript string. Throws unless
 * the placeholder appears exactly once, as a whole string literal.
 */
export function injectManifest(code: string, manifest: PrecacheManifest): string
{
    const placeholderLiteralPattern = new RegExp(`(["'\`])${MANIFEST_PLACEHOLDER}\\1`, 'g');
    const quotedCount = code.match(placeholderLiteralPattern)?.length ?? 0;
    const anywhereCount = code.split(MANIFEST_PLACEHOLDER).length - 1;
    if (quotedCount !== 1 || anywhereCount !== 1)
    {
        throw new Error(`sw.js must contain the precache placeholder exactly once (found ${String(anywhereCount)})`);
    }
    const manifestJson = JSON.stringify({ version: manifest.version, paths: manifest.paths });
    return code.replace(placeholderLiteralPattern, () => JSON.stringify(manifestJson));
}
