import { describe, expect, it, vi } from 'vitest';
import { SERVICE_WORKER_PATH } from '../security-headers/headers';
import { SERVICE_WORKER_FILE_NAME } from './precache-list';
import { registerServiceWorker, registerWhenLoaded, SERVICE_WORKER_SCOPE, SERVICE_WORKER_URL, type PageWindow } from './register-service-worker';

/** Lets pending promise callbacks run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('registerServiceWorker', () =>
{
    it('registers /sw.js for the whole site, always asking the site for a new sw.js', async () =>
    {
        const registerSpy = vi.fn(() => Promise.resolve({}));
        registerServiceWorker({ serviceWorker: { register: registerSpy } });
        await settle();
        expect(registerSpy).toHaveBeenCalledExactlyOnceWith('/sw.js', { scope: '/', updateViaCache: 'none' });
    });

    it('uses the same address as the build and the headers', () =>
    {
        expect(SERVICE_WORKER_URL).toBe(SERVICE_WORKER_PATH);
        expect(SERVICE_WORKER_URL).toBe(`/${SERVICE_WORKER_FILE_NAME}`);
        expect(SERVICE_WORKER_SCOPE).toBe('/');
    });

    it('does nothing without service workers (old browser, not https)', async () =>
    {
        expect(() => registerServiceWorker(undefined)).not.toThrow();
        expect(() => registerServiceWorker({})).not.toThrow();
        expect(() => registerServiceWorker({ serviceWorker: null as never })).not.toThrow();
        expect(() => registerServiceWorker({ serviceWorker: {} as never })).not.toThrow();
        await settle();
    });

    // Vitest fails the whole run on an unhandled rejection, so a refusal that
    // escaped would be caught here.
    it('stays calm when the browser refuses or register() throws', async () =>
    {
        const refusingRegister = vi.fn(() => Promise.reject(new Error('refused')));
        const throwingRegister = vi.fn(() =>
        {
            throw new Error('thrown');
        });
        expect(() => registerServiceWorker({ serviceWorker: { register: refusingRegister } })).not.toThrow();
        expect(() => registerServiceWorker({ serviceWorker: { register: throwingRegister } })).not.toThrow();
        // Playwright's "block" replaces register() with one that resolves to nothing.
        expect(() => registerServiceWorker({ serviceWorker: { register: () => Promise.resolve(undefined) } })).not.toThrow();
        await settle();
        await settle();
        expect(refusingRegister).toHaveBeenCalledOnce();
        expect(throwingRegister).toHaveBeenCalledOnce();
    });
});

describe('registerWhenLoaded', () =>
{
    const makeFakeWindow = (readyState: string): PageWindow & { listeners: (() => void)[] } =>
    {
        const listeners: (() => void)[] = [];
        return { document: { readyState }, listeners, addEventListener: (_type, listener) => listeners.push(listener) };
    };

    it('waits for the page to finish loading', async () =>
    {
        const registerSpy = vi.fn(() => Promise.resolve({}));
        const fakeWindow = makeFakeWindow('interactive');
        registerWhenLoaded(fakeWindow, { serviceWorker: { register: registerSpy } });
        await settle();
        expect(registerSpy).not.toHaveBeenCalled();
        expect(fakeWindow.listeners).toHaveLength(1);
        fakeWindow.listeners[0]?.();
        await settle();
        expect(registerSpy).toHaveBeenCalledOnce();
    });

    it('registers at once if the page has already loaded', async () =>
    {
        const registerSpy = vi.fn(() => Promise.resolve({}));
        const fakeWindow = makeFakeWindow('complete');
        registerWhenLoaded(fakeWindow, { serviceWorker: { register: registerSpy } });
        await settle();
        expect(registerSpy).toHaveBeenCalledOnce();
        expect(fakeWindow.listeners).toEqual([]);
    });
});
