// The service worker (built as dist/sw.js by the offline-copy plugin in
// vite.config.ts; registered by src/sw/register.ts in the built site only).
//
// What it is for: after the page has been opened once with the internet
// on, the page can be opened (or reloaded) again while offline. For that it
// keeps a copy of the site's OWN static files, exactly those in the
// precache list the build writes into this file (src/sw/precache-list.ts),
// and nothing else (README.md, rule R5):
// - install: stores every listed file, from this site only, in a cache
//   named after the list's content hash;
// - activate: deletes the older caches of this service worker (and only
//   those), then takes charge of the open page;
// - fetch: answers ONLY a GET of this site for a listed path, from that
//   copy (rules in sw-logic.ts). Every other request is left to the
//   browser (no respondWith), and the page's CSP still blocks what it
//   blocks. Nothing is ever added to the cache here: no email, no PDF, no
//   file you add ever reaches this worker (they never leave the page's
//   memory), and nothing it answers is stored again.
//
// Network: it fetches this site's own listed files only. That is the one
// exception to "no network API in the shipped code" (README.md, rules R1 and
// R3): the build check allows the network call and the cache storage call
// in this file and in dist/sw.js only (scripts/no-network-rules.mjs). Its
// CSP is the page's, with `connect-src 'self'` (src/security/headers.ts,
// cspForServiceWorker), so it cannot reach any other site.
//
// This file is a classic script once built (no import or export left; the
// plugin checks it), so no browser needs module service workers.

import { cacheNameFor, isOldCacheOfOurs, parseManifest, precachedPathFor } from './sw-logic';

/**
 * The parts of a service worker's global scope used here. The project's
 * TypeScript setup has the page's types (DOM), not the worker's, so they
 * are described by hand (as in src/parsing/parse-worker.ts).
 */
interface ExtendableEvent extends Event
{
    waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent
{
    readonly request: Request;
    respondWith(response: Promise<Response>): void;
}
interface ServiceWorkerScope
{
    readonly location: { readonly origin: string };
    readonly clients: { claim(): Promise<void> };
    skipWaiting(): Promise<void>;
    addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEvent) => void): void;
    addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
}

const scope = self as unknown as ServiceWorkerScope;

// Replaced by the build with the precache list (src/sw/precache-list.ts,
// injectManifest). Left as is (e.g. a build without the plugin), JSON.parse
// throws, the worker never installs, and the page works as without it.
const MANIFEST = parseManifest('__SW_PRECACHE_MANIFEST__');
const CACHE = cacheNameFor(MANIFEST.version);
const PATHS: ReadonlySet<string> = new Set(MANIFEST.paths);

/** Stores every listed file. All or nothing: one failed file fails the install. */
async function storeOwnFiles(): Promise<void>
{
    const cache = await caches.open(CACHE);
    // cache: 'reload': straight from the site, not from the browser's HTTP
    // cache, so the copy matches this version of the list.
    await cache.addAll(MANIFEST.paths.map((path) => new Request(path, { cache: 'reload' })));
}

/** Deletes the caches of older versions of this service worker. */
async function deleteOldCopies(): Promise<void>
{
    for (const name of await caches.keys())
    {
        if (isOldCacheOfOurs(name, CACHE))
        {
            await caches.delete(name);
        }
    }
}

/**
 * The stored copy of `path`. If it is missing (the browser may clear
 * stored site data at any time), the request goes to this site as usual,
 * and the answer is NOT stored. caches.match with cacheName (not
 * caches.open, which would create the cache if it is gone): answering a
 * request never creates anything.
 */
async function answer(path: string, request: Request): Promise<Response>
{
    const copy = await caches.match(path, { cacheName: CACHE });
    return copy ?? fetch(request);
}

scope.addEventListener('install', (event) =>
{
    // A new version takes over at once: the page loads all its files when it
    // opens, so an open page never needs a file of the old version later.
    event.waitUntil(storeOwnFiles().then(() => scope.skipWaiting()));
});

scope.addEventListener('activate', (event) =>
{
    event.waitUntil(deleteOldCopies().then(() => scope.clients.claim()));
});

scope.addEventListener('fetch', (event) =>
{
    const path = precachedPathFor(event.request, scope.location.origin, PATHS);
    if (path === null)
    {
        return;
    }
    event.respondWith(answer(path, event.request));
});
