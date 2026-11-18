// defineConfig from 'vitest/config' is Vite's own defineConfig plus types for
// the `test` section below, so one file configures both the build and tests.
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';
import { isBytesImportAllowed } from './Helper/build-checks/font-rules.mjs';
import { cloudflareHeadersFile, cspForMeta, REFERRER_POLICY, securityHeadersFor } from './Source/security-headers/headers.ts';
import { injectManifest, manifestVersion, precachePaths, SW_FILE_NAME } from './Source/offline-copy/precache-list.ts';

// Adds the security headers (README.md, rule R2) to the PRODUCTION BUILD only.
//
// Why build-only: the dev server (`npm run dev`) injects CSS with <style> tags
// and uses a WebSocket for hot reload. Our strict CSP blocks both, so applying
// it in dev would break the dev server. `apply: 'build'` keeps dev working
// while everything we actually publish (dist/) is strict.
function securityHeaders(): Plugin
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

// `npm run preview` serves the BUILT site (dist/) with the same HTTP headers
// Cloudflare Pages sends from dist/_headers, so the browser tests in Helper/Test/browser-tests/
// check the real header CSP, not only the <meta> fallback, including the
// service worker's own CSP on /sw.js (securityHeadersFor). Preview only:
// `npm run dev` stays without CSP (see securityHeaders() above for why).
// The headers are set before the files are served, on every answer.
function previewHeaders(): Plugin
{
    return {
        name: 'preview-security-headers',
        apply: (_config, env) => env.isPreview === true,
        configurePreviewServer(server)
        {
            server.middlewares.use((req, res, next) =>
            {
                // Node's request and response, described by hand: the project does
                // not install Node's type definitions (see iconvLiteShim below).
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

// The service worker (Source/offline-copy/): the offline copy of the site's own files,
// PRODUCTION BUILD only. It is built as its own script, dist/sw.js, from
// Source/offline-copy/service-worker.ts. Once every other file of the build is final,
// its precache list is made from them (Source/offline-copy/precache-list.ts): every
// file of dist/ except the host settings files, source maps and sw.js,
// with index.html as "/", sorted, plus a version (a content hash of the
// files, of the service worker's code and of _headers; Helper/build-checks/sw-version.mjs,
// shared with the build check), and written into
// sw.js in place of its placeholder. The same build always gives the same
// sw.js. No library is used for this.
// Only for the site itself (its entry is index.html): the browser tests'
// own in-memory builds of a test entry (Helper/Test/browser-tests/parse-files.spec.ts,
// Helper/Test/browser-tests/html-to-text.spec.ts) have no page and get no service worker.
const swEntry = decodeURIComponent(new URL('./Source/offline-copy/service-worker.ts', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
function offlineCopy(): Plugin
{
    let base = '/';
    let publicDir = '';
    let site = false;
    return {
        name: 'offline-copy',
        apply: 'build',
        configResolved(config)
        {
            base = config.base;
            publicDir = config.build.copyPublicDir ? config.publicDir : '';
            site = config.build.lib === false && config.build.rolldownOptions.input === undefined;
        },
        buildStart()
        {
            if (site)
            {
                this.emitFile({ type: 'chunk', id: swEntry, fileName: SW_FILE_NAME });
            }
        },
        // 'post': after every other plugin has written its files (index.html, _headers).
        generateBundle: {
            order: 'post',
            async handler(_options, bundle)
            {
                if (!site)
                {
                    return;
                }
                const sw = bundle[SW_FILE_NAME];
                if (sw?.type !== 'chunk')
                {
                    throw new Error(`offline-copy: ${SW_FILE_NAME} was not built`);
                }
                // A classic script: nothing imported from or shared with the page's code.
                if (sw.imports.length > 0 || sw.dynamicImports.length > 0 || sw.exports.length > 0)
                {
                    throw new Error(`offline-copy: ${SW_FILE_NAME} must not import or export anything`);
                }
                const files = new Map<string, Uint8Array>();
                for (const [fileName, output] of Object.entries(bundle))
                {
                    if (fileName === SW_FILE_NAME)
                    {
                        continue;
                    }
                    const content = output.type === 'chunk' ? output.code : output.source;
                    files.set(fileName, typeof content === 'string' ? new TextEncoder().encode(content) : content);
                }
                // Source/public/ is copied into dist/ as is, outside the bundle.
                if (publicDir !== '')
                {
                    const walk = async (dir: string, prefix: string): Promise<void> =>
                    {
                        for (const entry of await this.fs.readdir(dir, { withFileTypes: true }))
                        {
                            const path = `${dir}/${entry.name}`;
                            if (entry.isDirectory())
                            {
                                await walk(path, `${prefix}${entry.name}/`);
                            }
                            else if (files.has(`${prefix}${entry.name}`))
                            {
                                throw new Error(`offline-copy: ${prefix}${entry.name} is both built and in Source/public/`);
                            }
                            else
                            {
                                files.set(`${prefix}${entry.name}`, await this.fs.readFile(path));
                            }
                        }
                    };
                    if (await this.fs.stat(publicDir).then(() => true, () => false))
                    {
                        await walk(publicDir, '');
                    }
                }
                const paths = precachePaths([...files.keys()], base);
                const pathOf = (fileName: string): string => (fileName === 'index.html' ? base : `${base}${fileName}`);
                const listed = [...files].filter(([fileName]) => paths.includes(pathOf(fileName)));
                // _headers is not stored, but the copy of "/" keeps the headers it
                // was served with: a header change must change the version too.
                const headersFile = files.get('_headers');
                if (headersFile === undefined)
                {
                    throw new Error('offline-copy: _headers was not built');
                }
                // The build check computes this version again from dist/ and fails
                // if sw.js holds another one (Helper/build-checks/check-no-network.mjs).
                const version = manifestVersion(
                    listed.map(([fileName, bytes]) => ({ path: pathOf(fileName), bytes })),
                    sw.code,
                    headersFile,
                );
                sw.code = injectManifest(sw.code, { version, paths });
            },
        },
    };
}

// `import bytes from './X.woff?bytes'` gives the file's exact bytes as a
// Uint8Array, written in the bundle as `new Uint8Array([119,79,70,70,...])`.
// Used for the PDF fonts (Source/pdf-export/bundled-fonts.ts). Why not Vite's built-in ways:
// `?url` would load the file later with fetch(), which the CSP forbids
// (connect-src 'none'); `?inline` writes base64, which the build check
// rejects (it could hide code); `?raw` reads the file as UTF-8 text, which
// corrupts binary data. A plain number array is readable, and the build
// check proves each one is exactly a committed font (Helper/build-checks/font-rules.mjs).
// Only .woff files directly in this project's Source/pdf-export/fonts/ may be imported
// this way (fontsDir, built like iconvLiteShim below; the check itself is
// isBytesImportAllowed in Helper/build-checks/font-rules.mjs, which has a self-test).
// `enforce: 'pre'` runs this before Vite's own asset handling of .woff files.
const BYTES_SUFFIX = '?bytes';
const fontsDir = decodeURIComponent(new URL('./Source/pdf-export/fonts/', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
function bytesImport(): Plugin
{
    return {
        name: 'bytes-import',
        enforce: 'pre',
        async load(id)
        {
            if (!id.endsWith(BYTES_SUFFIX))
            {
                return null;
            }
            const file = id.slice(0, -BYTES_SUFFIX.length);
            if (!isBytesImportAllowed(file, fontsDir))
            {
                throw new Error(`${BYTES_SUFFIX} is only for the .woff files in Source/pdf-export/fonts/, not ${file}`);
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
    // above (per path, so /sw.js gets its own CSP), not by `preview.headers`.
    test: {
        // Unit tests sit next to the code they test, e.g. Source/email-reading/date-header.test.ts.
        // They run in Node (no browser DOM): detection and parsing logic is kept
        // as pure functions (README.md, rule R7). The production build never
        // includes them because nothing in index.html/main.ts imports them.
        // Helper/build-checks/ holds the self-test of the "no network" build check,
        // Helper/lint-rules/ the self-test of the project's own lint rules.
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
