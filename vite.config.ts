// defineConfig from 'vitest/config' is Vite's own defineConfig plus types for
// the `test` section below, so one file configures both the build and tests.
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { isBytesImportAllowed } from './scripts/font-rules.mjs';
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

// `import bytes from './X.woff?bytes'` gives the file's exact bytes as a
// Uint8Array, written in the bundle as `new Uint8Array([119,79,70,70,...])`.
// Used for the PDF fonts (src/pdf/fonts.ts). Why not Vite's built-in ways:
// `?url` would load the file later with fetch(), which the CSP forbids
// (connect-src 'none'); `?inline` writes base64, which the build check
// rejects (it could hide code); `?raw` reads the file as UTF-8 text, which
// corrupts binary data. A plain number array is readable, and the build
// check proves each one is exactly a committed font (scripts/font-rules.mjs).
// Only .woff files directly in this project's src/fonts/ may be imported
// this way (fontsDir, built like iconvLiteShim below; the check itself is
// isBytesImportAllowed in scripts/font-rules.mjs, which has a self-test).
// `enforce: 'pre'` runs this before Vite's own asset handling of .woff files.
const BYTES_SUFFIX = '?bytes';
const fontsDir = decodeURIComponent(new URL('./src/fonts/', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
function bytesImport(): Plugin {
  return {
    name: 'bytes-import',
    enforce: 'pre',
    async load(id) {
      if (!id.endsWith(BYTES_SUFFIX)) return null;
      const file = id.slice(0, -BYTES_SUFFIX.length);
      if (!isBytesImportAllowed(file, fontsDir)) {
        throw new Error(`${BYTES_SUFFIX} is only for the .woff files in src/fonts/, not ${file}`);
      }
      this.addWatchFile(file);
      const bytes = await this.fs.readFile(file);
      // moduleSideEffects: false: a font nobody imports is left out.
      return { code: `export default new Uint8Array([${bytes.join(',')}]);\n`, moduleSideEffects: false };
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
  plugins: [bytesImport(), securityHeaders()],
  // The inlined workers are bundled separately and do NOT get the plugins
  // above. Without bytesImport() there, a worker importing a font by
  // mistake would get the font's asset URL as a string (and a .woff file
  // in dist/), which no build check sees. With it, the bytes would be a
  // long number array inside the page's script, outside the font chunk,
  // and the build check fails (scripts/font-rules.mjs). The PDF worker
  // gets the font bytes from the page instead (src/pipeline/pdf-protocol.ts).
  worker: { plugins: () => [bytesImport()] },
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
    // The font chunk (below) is about 1.2 MB of numbers, which is expected;
    // the limit (in kB) is raised just above it so a warning still means
    // something unexpected grew.
    chunkSizeWarningLimit: 1300,
    rolldownOptions: {
      output: {
        // The PDF fonts (the `?bytes` modules, about 1.2 MB of numbers) get a
        // chunk of their own, assets/pdf-fonts-[hash].js: the main script
        // stays small, and the build check knows the one file where long
        // number arrays are allowed (scripts/font-rules.mjs). The page entry
        // imports it statically (src/main.ts), so the browser loads it with
        // the page, as a normal script under `script-src 'self'`.
        // This option applies to the page only; the inlined workers are
        // built separately and never import the fonts.
        codeSplitting: {
          groups: [{ name: 'pdf-fonts', test: (id) => id.endsWith(BYTES_SUFFIX) }],
        },
      },
    },
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
    // tests/ holds the synthetic fixture set and its privacy guard test.
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts', 'tests/**/*.test.ts'],
    environment: 'node',
    // Vitest's persistent transform cache (node_modules/.vitest-cache) does
    // not notice NEW files matched by import.meta.glob, so the privacy guard
    // (tests/fixtures/synthetic-guard.test.ts) could silently skip a newly
    // added fixture on a developer machine. Off: always transform fresh.
    fsModuleCache: false,
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
