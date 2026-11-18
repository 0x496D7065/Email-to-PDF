// defineConfig from 'vitest/config' is Vite's own defineConfig plus types for
// the `test` section below, so one file configures both the build and tests.
import { defineConfig } from 'vitest/config';
// The project's own Vite plugins, one per file (Helper/vite-plugins/).
import { BYTES_SUFFIX, bytesImport } from './Helper/vite-plugins/bytes-import-plugin.ts';
import { offlineCopy } from './Helper/vite-plugins/offline-copy-plugin.ts';
import { previewHeaders } from './Helper/vite-plugins/preview-headers-plugin.ts';
import { securityHeaders } from './Helper/vite-plugins/security-headers-plugin.ts';

// Absolute path of the iconv-lite shim (see resolve.alias below). It must be
// absolute so it also works for packages pre-bundled by Vitest.
// Same as Node's fileURLToPath(), written by hand because the project does not
// install Node's type definitions: "file:///C:/my%20dir/x.ts" -> "C:/my dir/x.ts"
// on Windows, "file:///home/me/x.ts" -> "/home/me/x.ts" on Linux (CI).
const shimUrl = new URL('./Source/library-shims/iconv-lite.ts', import.meta.url);
const iconvLiteShim = decodeURIComponent(shimUrl.pathname).replace(/^\/([A-Za-z]:)/, '$1');

// The project folder (with a trailing slash), made the same way. The site
// (its code, index.html and the files copied as they are) lives in Source/,
// which is Vite's root; the build still goes to dist/ at the project root,
// and the tests (Vitest) run from the project root, so Source/ and Helper/
// are both theirs.
// Absolute paths, so they do not depend on the folder a command is run from.
const projectDir = decodeURIComponent(new URL('./', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');

export default defineConfig({
    root: `${projectDir}Source`,
    // Files copied into dist/ as they are (THIRD_PARTY_NOTICES.txt, the Ko-fi button image).
    publicDir: `${projectDir}Source/public`,
    plugins: [bytesImport(), securityHeaders(), previewHeaders(), offlineCopy()],
    // The inlined workers are bundled separately and do NOT get the plugins
    // above. Without bytesImport() there, a worker importing a font by
    // mistake would get the font's asset URL as a string (and a .woff file
    // in dist/), which no build check sees. With it, the bytes would be a
    // long number array inside the page's script, outside the font chunk,
    // and the build check fails (Helper/build-checks/font-rules.mjs). The PDF worker
    // gets the font bytes from the page instead (Source/worker-pipeline/pdf-worker-protocol.ts).
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
        // dist/ is outside the root (Source/): emptyOutDir clears it before each build anyway.
        outDir: `${projectDir}dist`,
        emptyOutDir: true,
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
                // number arrays are allowed (Helper/build-checks/font-rules.mjs). The page entry
                // imports it statically (Source/main.ts), so the browser loads it with
                // the page, as a normal script under `script-src 'self'`.
                // This option applies to the page only; the inlined workers are
                // built separately and never import the fonts.
                codeSplitting: {
                    groups: [{ name: 'pdf-fonts', test: (id) => id.endsWith(BYTES_SUFFIX) }],
                },
            },
        },
    },
    // The security headers of `npm run preview` are set by previewHeaders()
    // (Helper/vite-plugins/preview-headers-plugin.ts; per path, so /sw.js gets
    // its own CSP), not by `preview.headers`.
    test: {
        // Unit tests sit next to the code they test, e.g. Source/email-reading/date-header.test.ts.
        // They run in Node (no browser DOM): detection and parsing logic is kept
        // as pure functions (README.md, rule R7). The production build never
        // includes them because nothing in index.html/main.ts imports them.
        // Helper/build-checks/ holds the self-test of the "no network" build check,
        // Helper/lint-rules/ the self-test of the project's own lint rules and the file-name check.
        // Helper/Test/test-data/ holds the synthetic fixture set and its privacy guard
        // test, Helper/Test/test-support/ the shared test helpers (and their tests).
        // root: the project folder, not Vite's root (Source/), so these paths
        // and the "/Helper/..." globs in the tests start from the project folder.
        root: projectDir,
        // Each Helper/ subfolder is listed by name: add any new Helper/ folder
        // with tests here (and in Helper/Test/test-data/test-code-guard.test.ts).
        include: [
            'Source/**/*.test.ts',
            'Helper/build-checks/**/*.test.ts',
            'Helper/lint-rules/**/*.test.ts',
            'Helper/Test/test-data/**/*.test.ts',
            'Helper/Test/test-support/**/*.test.ts',
        ],
        environment: 'node',
        // Vitest's persistent transform cache (node_modules/.vitest-cache) does
        // not notice NEW files matched by import.meta.glob, so the privacy guard
        // (Helper/Test/test-data/synthetic-guard.test.ts) could silently skip a newly
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
