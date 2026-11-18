// Vite plugin, used by vite.config.ts (build only).
import type { Plugin } from 'vite';
import { injectManifest, manifestVersion, precachePaths, SERVICE_WORKER_FILE_NAME } from '../../Source/offline-copy/precache-list.ts';

// The service worker (Source/offline-copy/): the offline copy of the site's own files,
// PRODUCTION BUILD only. It is built as its own script, dist/sw.js, from
// Source/offline-copy/service-worker.ts. Once every other file of the build is final,
// its precache list is made from them (Source/offline-copy/precache-list.ts): every
// file of dist/ except the host settings files, source maps and sw.js,
// with index.html as "/", sorted, plus a version (a content hash of the
// files, of the service worker's code and of _headers; Helper/build-checks/service-worker-version.mjs,
// shared with the build check), and written into
// sw.js in place of its placeholder. The same build always gives the same
// sw.js. No library is used for this.
// Only for the site itself (its entry is index.html): the browser tests'
// own in-memory builds of a test entry (Helper/Test/browser-tests/parse-files.spec.ts,
// Helper/Test/browser-tests/html-to-text.spec.ts) have no page and get no service worker.
// The path is relative to this file, so it starts with ../../ (two folders up:
// Helper/vite-plugins/ to the project root); made like iconvLiteShim in vite.config.ts.
const swEntry = decodeURIComponent(new URL('../../Source/offline-copy/service-worker.ts', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
export function offlineCopy(): Plugin
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
                this.emitFile({ type: 'chunk', id: swEntry, fileName: SERVICE_WORKER_FILE_NAME });
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
                const sw = bundle[SERVICE_WORKER_FILE_NAME];
                if (sw?.type !== 'chunk')
                {
                    throw new Error(`offline-copy: ${SERVICE_WORKER_FILE_NAME} was not built`);
                }
                // A classic script: nothing imported from or shared with the page's code.
                if (sw.imports.length > 0 || sw.dynamicImports.length > 0 || sw.exports.length > 0)
                {
                    throw new Error(`offline-copy: ${SERVICE_WORKER_FILE_NAME} must not import or export anything`);
                }
                const files = new Map<string, Uint8Array>();
                for (const [fileName, output] of Object.entries(bundle))
                {
                    if (fileName === SERVICE_WORKER_FILE_NAME)
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
