// The service worker's cache version (Source/offline-copy/): one function shared by the
// build, which writes the version into dist/sw.js (vite.config.ts, through
// Source/offline-copy/precache-list.ts), and by the build check, which computes it again
// from dist/ and fails if dist/sw.js holds another one
// (check-no-network.mjs). Plain JavaScript so the build check can run it
// without a TypeScript runner; unit tested in Source/offline-copy/precache-list.test.ts.
import { TextEncoder } from 'node:util';
import { sha256Hex } from './font-rules.mjs';

/**
 * Text in the service worker's source that the build replaces with the
 * precache list (as a JSON string). It must appear exactly once in sw.js.
 */
export const MANIFEST_PLACEHOLDER = '__SW_PRECACHE_MANIFEST__';

/** Length of the version (hex characters of the SHA-256). */
export const VERSION_LENGTH = 20;

// The placeholder as a whole string literal, in any quote the bundler uses.
const PLACEHOLDER_LITERAL = new RegExp(`(["'\`])${MANIFEST_PLACEHOLDER}\\1`, 'g');
// The precache list as the build writes it (injectManifest in
// precache-list.ts): a double-quoted JavaScript string holding the JSON
// {"version":"...","paths":[...]}. The paths are plain (no quote, no
// backslash), so the only escapes in it are \".
const BUILT_LITERAL = /"\{\\"version\\":(?:[^"\\]|\\")*\}"/g;

/**
 * The service worker code without its precache list: the placeholder
 * literal (before the build writes the list) or the written list (in
 * dist/sw.js) becomes "". So the version can be computed from either
 * form, and the same code gives the same version before and after.
 */
function withoutManifest(swCode)
{
    return swCode.replace(PLACEHOLDER_LITERAL, '""').replace(BUILT_LITERAL, '""');
}

/**
 * The cache version: a content hash of every listed file (path and bytes),
 * of the service worker's own code (`swCode`, without the precache list,
 * see withoutManifest) and of the site's HTTP headers file (`headersFile`,
 * dist/_headers). Any change to a file, to the list, to the service worker
 * or to a header gives a new version, hence a new cache; the same build
 * gives the same version. `files`: each precache path with the bytes
 * served for it.
 *
 * Why the headers: the copy of "/" is stored with the headers it was served
 * with (its CSP among them) and is answered from the copy first, so a
 * header-only change (no file changed) must still give a new sw.js, or a
 * returning visitor would keep the old headers.
 */
export function manifestVersion(files, swCode, headersFile)
{
    const lines = [];
    for (const { path, bytes } of [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)))
    {
        lines.push(`${path} ${sha256Hex(bytes)}`);
    }
    lines.push(`sw.js ${sha256Hex(new TextEncoder().encode(withoutManifest(swCode)))}`);
    lines.push(`_headers ${sha256Hex(typeof headersFile === 'string' ? new TextEncoder().encode(headersFile) : headersFile)}`);
    return sha256Hex(new TextEncoder().encode(lines.join('\n'))).slice(0, VERSION_LENGTH);
}

/**
 * The precache list written into a built sw.js: { version, paths }.
 * Throws unless it is there exactly once, in the expected shape.
 */
export function readBuiltManifest(swJs)
{
    const found = swJs.match(BUILT_LITERAL) ?? [];
    if (found.length !== 1)
    {
        throw new Error(`sw.js must hold the precache list exactly once (found ${String(found.length)})`);
    }
    const value = JSON.parse(JSON.parse(found[0]));
    const { version, paths } = value;
    if (typeof version !== 'string' || !/^[0-9a-f]+$/.test(version))
    {
        throw new Error('sw.js: the precache list has a bad version');
    }
    if (!Array.isArray(paths) || !paths.every((path) => typeof path === 'string'))
    {
        throw new Error('sw.js: the precache list has bad paths');
    }
    return { version, paths };
}
