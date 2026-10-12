// defineConfig from 'vitest/config' is Vite's own defineConfig plus types for
// the `test` section below, so one file configures both the build and tests.
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import {
  cloudflareHeadersFile,
  cspForHeader,
  cspForMeta,
  PERMISSIONS_POLICY,
  REFERRER_POLICY,
} from './src/security/headers.ts';

// Adds the security headers (README.md, rule R2) to the PRODUCTION BUILD only.
//
// Why build-only: the dev server (`npm run dev`) injects CSS with <style> tags
// and uses a WebSocket for hot reload. Our strict CSP blocks both, so applying
// it in dev would break the dev server. `apply: 'build'` keeps dev working
// while everything we actually publish (dist/) is strict.
function securityHeaders(): Plugin {
  return {
    name: 'security-headers',
    apply: 'build',
    // Fallback for hosts that cannot send HTTP headers: <meta> tags placed
    // right after <meta charset> (which must stay first), so the CSP is active
    // before any script or stylesheet tag is read.
    transformIndexHtml(html) {
      const charset = '<meta charset="UTF-8" />';
      if (!html.includes(charset)) throw new Error(`index.html must contain ${charset}`);
      const tags =
        `
    <meta http-equiv="Content-Security-Policy" content="${cspForMeta()}" />` +
        `
    <meta name="referrer" content="${REFERRER_POLICY}" />`;
      return html.replace(charset, charset + tags);
    },
    // The real HTTP headers on Cloudflare Pages: write dist/_headers.
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: '_headers', source: cloudflareHeadersFile() });
    },
  };
}

// Absolute path of the iconv-lite shim (see resolve.alias below). It must be
// absolute so it also works for packages pre-bundled by Vitest.
// Same as Node's fileURLToPath(), written by hand because the project does not
// install Node's type definitions: "file:///C:/my%20dir/x.ts" -> "C:/my dir/x.ts"
// on Windows, "file:///home/me/x.ts" -> "/home/me/x.ts" on Linux (CI).
const shimUrl = new URL('./src/shims/iconv-lite.ts', import.meta.url);
const iconvLiteShim = decodeURIComponent(shimUrl.pathname).replace(/^\/([A-Za-z]:)/, '$1');

export default defineConfig({
  plugins: [securityHeaders()],
  resolve: {
    // @kenjiuno/msgreader (the .msg parser) requires 'iconv-lite', which needs
    // Node's Buffer and crashes in the browser. Every import of exactly
    // 'iconv-lite' is redirected to a tiny browser version built on
    // TextDecoder (see the comments in that file). Top-level `resolve`
    // applies to both `vite build` and Vitest.
    alias: [{ find: /^iconv-lite$/, replacement: iconvLiteShim }],
  },
  build: {
    // Vite normally injects a small "modulepreload" polyfill that calls fetch().
    // Every browser we target supports modulepreload natively, and README.md, rule R1
    // forbids network APIs in the shipped code, so we turn the polyfill off.
    modulePreload: { polyfill: false },
  },
  // `npm run preview` serves the BUILT site (dist/). These are the same HTTP
  // headers Cloudflare Pages sends from dist/_headers, so the browser test in
  // e2e/ checks the real header CSP, not only the <meta> fallback.
  // Only the preview server gets them: `npm run dev` stays without CSP
  // (see securityHeaders() above for why).
  preview: {
    headers: {
      'Content-Security-Policy': cspForHeader(),
      'Referrer-Policy': REFERRER_POLICY,
      'Permissions-Policy': PERMISSIONS_POLICY,
    },
  },
  test: {
    // Unit tests sit next to the code they test, e.g. src/lib/foo.test.ts.
    // They run in Node (no browser DOM): detection and parsing logic is kept
    // as pure functions (README.md, rule R7). The production build never
    // includes them because nothing in index.html/main.ts imports them.
    // scripts/ holds the self-test of the "no network" build check.
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
    environment: 'node',
    // Vitest normally hands packages from node_modules straight to Node, whose
    // require('iconv-lite') would skip the alias above and load the real
    // package. Pre-bundling msgreader (like `vite build` does) applies the
    // alias, so the tests run the same shim as the shipped site.
    // lib/DataStream is listed too because a test imports it directly.
    deps: {
      optimizer: {
        ssr: { enabled: true, include: ['@kenjiuno/msgreader', '@kenjiuno/msgreader/lib/DataStream'] },
      },
    },
  },
});
