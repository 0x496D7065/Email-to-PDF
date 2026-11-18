// Vite plugin, used by vite.config.ts (build only).
import type { Plugin } from 'vite';
import { cloudflareHeadersFile, cspForMeta, REFERRER_POLICY } from '../../Source/security-headers/headers.ts';

// Adds the security headers (README.md, rule R2) to the PRODUCTION BUILD only.
//
// Why build-only: the dev server (`npm run dev`) injects CSS with <style> tags
// and uses a WebSocket for hot reload. Our strict CSP blocks both, so applying
// it in dev would break the dev server. `apply: 'build'` keeps dev working
// while everything we actually publish (dist/) is strict.
export function securityHeaders(): Plugin
{
    return {
        name: 'security-headers',
        apply: 'build',
        // Fallback for hosts that cannot send HTTP headers: <meta> tags placed
        // right after <meta charset> (which must stay first), so the CSP is active
        // before any script or stylesheet tag is read.
        transformIndexHtml(html)
        {
            const charset = '<meta charset="UTF-8" />';
            if (!html.includes(charset))
            {
                throw new Error(`index.html must contain ${charset}`);
            }
            const tags =
                `
    <meta http-equiv="Content-Security-Policy" content="${cspForMeta()}" />` +
                `
    <meta name="referrer" content="${REFERRER_POLICY}" />`;
            return html.replace(charset, charset + tags);
        },
        // The real HTTP headers on Cloudflare Pages: write dist/_headers.
        generateBundle()
        {
            this.emitFile({ type: 'asset', fileName: '_headers', source: cloudflareHeadersFile() });
        },
    };
}
