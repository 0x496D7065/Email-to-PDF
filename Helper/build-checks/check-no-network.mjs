// The "no network" build check (README.md, rule R3).
// Run: npm run check:network   (also runs automatically at the end of npm run build)
//
// Fails (exit code 1) if the source or the built site contains a network API,
// a browser storage API, an http(s) URL that is not allowlisted, or test code,
// if the built site contains an HTML injection API such as innerHTML
// (README.md, rule R4), if the built security headers are missing, or if
// the version in dist/sw.js is not the one computed from dist/. The
// matching rules live in no-network-rules.mjs.
//
// Plain JavaScript using only Node built-ins: no extra dependency or
// TypeScript runner is needed to run it.
//
// What is scanned:
//   - Source/ (every file, Source/index.html included, except Source/public/,
//     which is copied into dist/ as is and scanned there): catches problems
//     early, in the code you write.
//   - Header/ (every file): the shared type definitions, scanned like Source/.
//   - dist/ (every file, including _headers): the code that is actually
//     published. This is the real guarantee, because it also covers code
//     added by Vite or by any future dependency.
//     The web workers have no file of their own: Vite inlines each one into
//     the page's script as a string literal (`?worker&inline`, so they start
//     offline). Each dist/ file is therefore scanned twice: as it is, and
//     with its string escapes undone (decodeJsEscapes), so the worker code is
//     checked as the browser will run it. A long base64-looking literal
//     fails the check (findOpaquePayloads): that format would hide the
//     worker code from both scans.
//   - The PDF fonts (Helper/build-checks/font-rules.mjs): Source/pdf-export/fonts/*.woff are binary,
//     so they are not scanned as text but must have their pinned SHA-256.
//     In the build they are long number arrays, allowed only in the font
//     chunk (dist/assets/pdf-fonts-*.js) and only if each one is exactly a
//     committed font; anywhere else (Source/ included) a long number array
//     fails, like a long base64 literal. The page's entry script must
//     import the font chunk statically, so it loads with the page.
//   - One exception, for one file: the service worker (Source/offline-copy/service-worker.ts,
//     built as dist/sw.js) may use the network call and Cache Storage, to keep
//     and serve a copy of the site's own files (RULE_EXEMPTIONS in
//     no-network-rules.mjs). Every other rule still applies to it, and both
//     rules still apply to every other file.
// What is NOT scanned:
//   - Helper/build-checks/: these check files must contain the banned words to look for them.
//   - Source/**/*.test.ts: tests legitimately mention banned words as strings
//     (e.g. the CSP test checks that "http:" is absent). They are never
//     shipped, and this cannot hide real app code: anything the app imports
//     ends up in dist/, which is scanned with the same rules PLUS a check that
//     no test code ("vitest", "describe(") leaked into the build.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { checkFontChunkLoadedAtStartup, checkNumberArrays, checkSourceFonts, findNumberArrays, isFontFile } from './font-rules.mjs';
import { checkBuiltHtml, checkHeadersFile, findEmbeddedViolations, findOpaquePayloads, findViolations } from './no-network-rules.mjs';
import { manifestVersion, readBuiltManifest } from './sw-version.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dist = join(root, 'dist');

/** All files under `dir`, recursively. */
function listFiles(dir)
{
    return readdirSync(dir).flatMap((name) =>
    {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? listFiles(path) : [path];
    });
}

/** Path relative to the project root, with forward slashes for readability. */
function display(path)
{
    return relative(root, path).split(sep).join('/');
}

if (!existsSync(dist))
{
    console.error('check-no-network: dist/ does not exist. Run "npm run build" first.');
    process.exit(1);
}

// Font files (Source/pdf-export/fonts/*.woff) are binary: they are not scanned as text but
// checked against their pinned SHA-256 (Helper/build-checks/font-rules.mjs).
// Source/public/ is skipped here: Vite copies those files into dist/ as they
// are, and they are scanned there byte for byte (with the dist/ rules).
// Source/index.html is scanned here like any other Source/ file.
// Header/ (the shared type definitions) is scanned as source too: it holds
// types only, but a comment or a string type could still hold a URL.
const publicDir = join(root, 'Source', 'public');
const srcFiles = [...listFiles(join(root, 'Source')), ...listFiles(join(root, 'Header'))].filter((path) => !path.endsWith('.test.ts') && !path.startsWith(publicDir + sep));
const fontFiles = srcFiles.filter((path) => isFontFile(path));
const sourceFiles = srcFiles.filter((path) => !isFontFile(path));
const distFiles = listFiles(dist);

const errors = [];

// Every dist/ file as text, for the font checks after the loop.
const distTexts = [];

for (const [files, isDist] of [
    [sourceFiles, false],
    [distFiles, true],
])
{
    for (const path of files)
    {
        // For dist/ files: the path inside dist/ (e.g. 'THIRD_PARTY_NOTICES.txt'),
        // used by the per-file URL allowlist. For source files: the path from
        // the project root (e.g. 'Source/pdf-export/fonts/LICENSE.txt'), same purpose.
        const distFile = isDist ? relative(dist, path).split(sep).join('/') : undefined;
        const sourceFile = isDist ? undefined : display(path);
        const text = readFileSync(path, 'utf8');
        if (isDist)
        {
            distTexts.push({ path: distFile, text });
        }
        // Source only: no long number array at all (the fonts are .woff files
        // there; in dist/ they are checked by checkNumberArrays below).
        if (!isDist)
        {
            for (const array of findNumberArrays(text))
            {
                errors.push(`${display(path)}:${array.line}: a ${array.values.length}-number array: data hidden this way escapes every other check (README.md, rule R3)`);
            }
        }
        const findings = findViolations(text, { isDist, distFile, sourceFile });
        // dist/ only: code embedded in strings (the inlined workers, see the top).
        if (isDist)
        {
            findings.push(...findEmbeddedViolations(text, { isDist, distFile }));
        }
        // dist/ only: a long base64 literal would hide code from both scans above
        // (e.g. if a future Vite inlined workers as base64): fail so a person looks.
        if (isDist)
        {
            findings.push(...findOpaquePayloads(text));
        }
        for (const { line, match, reason } of findings)
        {
            // Minified lines can be huge; cap what we print.
            const shown = match.length > 80 ? `${match.slice(0, 80)}...` : match;
            errors.push(`${display(path)}:${line}: "${shown}" -> ${reason}`);
        }
    }
}

// The bundled PDF fonts (Helper/build-checks/font-rules.mjs): the committed files are the
// official ones, long number arrays appear only in the font chunk and are
// exactly those fonts, and the page loads that chunk at startup.
errors.push(...checkSourceFonts(fontFiles.map((path) => ({ path: display(path), bytes: readFileSync(path) }))));
errors.push(...checkNumberArrays(distTexts));
if (existsSync(join(dist, 'index.html')))
{
    errors.push(...checkFontChunkLoadedAtStartup(readFileSync(join(dist, 'index.html'), 'utf8'), distTexts));
}

// Structural checks on the built security headers.
const indexHtml = join(dist, 'index.html');
const headersFile = join(dist, '_headers');
for (const [path, check] of [
    [indexHtml, checkBuiltHtml],
    [headersFile, checkHeadersFile],
])
{
    if (!existsSync(path))
    {
        errors.push(`${display(path)}: file is missing (README.md, rule R2)`);
        continue;
    }
    for (const problem of check(readFileSync(path, 'utf8')))
    {
        errors.push(`${display(path)}: ${problem}`);
    }
}

// The service worker script must be there: dist/_headers has a rule for it
// (checked above), and its two rule exceptions (RULE_EXEMPTIONS) are for it.
if (!existsSync(join(dist, 'sw.js')))
{
    errors.push('dist/sw.js: file is missing (README.md, "How the privacy model works")');
}
else
{
    // Its version must be the one computed from what dist/ really holds: the
    // listed files, the service worker's code and dist/_headers (the same
    // manifestVersion the build uses, Helper/build-checks/sw-version.mjs). A build that
    // left a file or the real headers out of the version fails here, because
    // returning visitors would then keep an old copy.
    try
    {
        const swJs = readFileSync(join(dist, 'sw.js'), 'utf8');
        const { version, paths } = readBuiltManifest(swJs);
        const files = paths.map((path) => ({ path, bytes: readFileSync(join(dist, path === '/' ? 'index.html' : path.slice(1))) }));
        const expected = manifestVersion(files, swJs, readFileSync(headersFile));
        if (version !== expected)
        {
            errors.push(`dist/sw.js: version ${version} is not the one computed from dist/ (${expected}): the build left something out of it`);
        }
    }
    catch (error)
    {
        errors.push(`dist/sw.js: its version cannot be checked: ${error instanceof Error ? error.message : String(error)}`);
    }
}

const scanned = sourceFiles.length + distFiles.length;
if (errors.length > 0)
{
    console.error(`check-no-network: FAILED with ${errors.length} problem(s):`);
    for (const error of errors)
    {
        console.error(`  ${error}`);
    }
    process.exit(1);
}
console.log(`check-no-network: OK (${scanned} files scanned, ${fontFiles.length} fonts verified, security headers present).`);
