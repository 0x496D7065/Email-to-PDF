// Registers the service worker (Source/offline-copy/service-worker.ts, served as
// /sw.js) so that, after one visit with the internet on, the page can also
// be opened again while offline. Called from Source/main.ts in the BUILT site
// only (`npm run dev` has no sw.js).
//
// Calm by design: if the browser has no service workers (or not on this
// page, e.g. not https), refuses one, or sw.js cannot be loaded, nothing
// happens. The page works the same, it just cannot be reopened offline.
// Nothing is logged and nothing about you is stored: the service worker
// only keeps the site's own files (README.md, rule R5).

/** Address of the service worker script (dist/sw.js), and the part of the site it serves. */
export const SERVICE_WORKER_URL = '/sw.js';
export const SERVICE_WORKER_SCOPE = '/';

/** The part of `navigator` used here. */
export interface ServiceWorkerNavigator
{
    readonly serviceWorker?: {
        register(url: string, options?: { scope?: string; updateViaCache?: 'imports' | 'all' | 'none' }): Promise<unknown>;
    };
}

/**
 * Asks the browser to install the service worker. Never throws, and a
 * refusal (a rejected promise) is swallowed.
 */
export function registerServiceWorker(browserNavigator: ServiceWorkerNavigator | undefined): void
{
    // Inside a promise chain, so a register() that throws at once is caught too.
    Promise.resolve()
        .then(() =>
        {
            const serviceWorkerContainer = browserNavigator?.serviceWorker;
            if (serviceWorkerContainer === undefined || serviceWorkerContainer === null || typeof serviceWorkerContainer.register !== 'function')
            {
                return undefined;
            }
            // updateViaCache 'none': the browser always asks the site for a new
            // sw.js, so an update is noticed on the next visit.
            return serviceWorkerContainer.register(SERVICE_WORKER_URL, { scope: SERVICE_WORKER_SCOPE, updateViaCache: 'none' });
        })
        .catch(() => undefined);
}

/** The part of `window` used here. */
export interface PageWindow
{
    readonly document: { readonly readyState: string };
    addEventListener(type: 'load', listener: () => void, options: { once: true }): void;
}

/**
 * Registers once the page has fully loaded (so storing the site's files
 * never competes with opening the page), or at once if it already has.
 */
export function registerWhenLoaded(pageWindow: PageWindow, browserNavigator: ServiceWorkerNavigator | undefined): void
{
    if (pageWindow.document.readyState === 'complete')
    {
        registerServiceWorker(browserNavigator);
    }
    else
    {
        pageWindow.addEventListener('load', () => registerServiceWorker(browserNavigator), { once: true });
    }
}
