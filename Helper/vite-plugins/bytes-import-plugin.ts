// Vite plugin, used by vite.config.ts (for the page and for the inlined workers).
import type { Plugin } from 'vite';
import { isBytesImportAllowed } from '../build-checks/font-rules.mjs';

// `import bytes from './X.woff?bytes'` gives the file's exact bytes as a
// Uint8Array, written in the bundle as `new Uint8Array([119,79,70,70,...])`.
// Used for the PDF fonts (Source/pdf-export/bundled-fonts.ts). Why not Vite's built-in ways:
// `?url` would load the file later with fetch(), which the CSP forbids
// (connect-src 'none'); `?inline` writes base64, which the build check
// rejects (it could hide code); `?raw` reads the file as UTF-8 text, which
// corrupts binary data. A plain number array is readable, and the build
// check proves each one is exactly a committed font (Helper/build-checks/font-rules.mjs).
// Only .woff files directly in this project's Source/pdf-export/fonts/ may be imported
// this way (fontsDir, relative to this file, so it starts with ../../ (two folders up:
// Helper/vite-plugins/ to the project root), and built like iconvLiteShim in vite.config.ts;
// the check itself is isBytesImportAllowed in Helper/build-checks/font-rules.mjs, which has a self-test).
// `enforce: 'pre'` runs this before Vite's own asset handling of .woff files.
// BYTES_SUFFIX is exported for vite.config.ts, which puts these modules in the font chunk.
export const BYTES_SUFFIX = '?bytes';
const fontsDir = decodeURIComponent(new URL('../../Source/pdf-export/fonts/', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
export function bytesImport(): Plugin
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
