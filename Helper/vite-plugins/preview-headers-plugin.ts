// Vite plugin, used by vite.config.ts (`npm run preview` only).
import type { Plugin } from 'vite';
import { securityHeadersFor } from '../../Source/security-headers/headers.ts';

// `npm run preview` serves the BUILT site (dist/) with the same HTTP headers
// Cloudflare Pages sends from dist/_headers, so the browser tests in Helper/Test/browser-tests/
// check the real header CSP, not only the <meta> fallback, including the
// service worker's own CSP on /sw.js (securityHeadersFor). Preview only:
// `npm run dev` stays without CSP (see securityHeaders() in security-headers-plugin.ts for why).
// The headers are set before the files are served, on every answer.
export function previewHeaders(): Plugin
{
    return {
        name: 'preview-security-headers',
        apply: (_config, env) => env.isPreview === true,
        configurePreviewServer(server)
        {
            server.middlewares.use((req, res, next) =>
            {
                // Node's request and response, described by hand: the project does
                // not install Node's type definitions (see iconvLiteShim in vite.config.ts).
                const url = (req as unknown as { url?: string }).url ?? '/';
                const response = res as unknown as { setHeader(name: string, value: string): void };
                const pathname = url.split(/[?#]/, 1)[0] ?? '/';
                for (const [name, value] of Object.entries(securityHeadersFor(pathname)))
                {
                    response.setHeader(name, value);
                }
                next();
            });
        },
    };
}
