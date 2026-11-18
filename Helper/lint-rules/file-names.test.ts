// File-name check (task 9.6): every file under Source/, Header/ and Helper/
// has a lowercase kebab-case name (words joined by "-") with one of the
// project's endings, and so has every folder below the top folders
// Source/, Header/, Helper/ and Helper/Test/ (whose capital letters are the
// chosen layout, README.md "Where things are"). ESLint checks names inside
// the code; this test checks the names of the files and folders.
//
// The synthetic test emails in Helper/Test/test-data/eml/ are data: there,
// and only there, a lowercase kebab-case name ending in .eml is accepted.
//
// Not checked: files whose names come from outside, kept as they are:
//   Source/pdf-export/fonts/    the font files and their LICENSE.txt (upstream names),
//   Source/public/               files copied into the site as they are (third-party notices, Ko-fi button),
// and any file named README.md.
//
// The paths come from Vite's import.meta.glob (names only: the files are
// never read); a glob starting with "/" is relative to the repository root.

import { describe, expect, it } from 'vitest';

/** Every file of the three top folders except the ones listed above, keyed "/Source/main.ts" and so on. */
const files = Object.keys(import.meta.glob(['/Source/**/*', '/Header/**/*', '/Helper/**/*',
    '!/Source/pdf-export/fonts/**', '!/Source/public/**'], { exhaustive: true })).sort();

/** One kebab-case word group: lowercase letters and digits, joined by single "-". */
const KEBAB = '[a-z0-9]+(?:-[a-z0-9]+)*';
/** The accepted file names: code, its tests (also with a part name), declarations, styles and the page. */
const FILE_NAME_PATTERNS = [
    // pdf-job.ts, build-checks.mjs, app.css, index.html
    new RegExp(`^${KEBAB}\\.(?:ts|mjs|css|html)$`),
    // pdf-job.test.ts, eml-parser.attached.test.ts, analyze-thread.attached.property.test.ts, clear.spec.ts
    new RegExp(`^${KEBAB}(?:\\.${KEBAB})*\\.(?:test|spec)\\.ts$`),
    // vite-bytes-import.d.ts, font-rules.d.mts
    new RegExp(`^${KEBAB}\\.d\\.(?:ts|mts)$`),
];
/** The folder of the synthetic test emails, and the names accepted there (01-plain-english.eml). */
const EML_FOLDER = 'Helper/Test/test-data/eml';
const EML_NAME_PATTERN = new RegExp(`^${KEBAB}\\.eml$`);
/** The top folders, kept with their capital letters; every folder below them is kebab-case. */
const TOP_FOLDERS = ['Source', 'Header', 'Helper', 'Helper/Test'];
/** File names kept as they are wherever they are. */
const KEPT_NAMES = new Set(['README.md']);

/** Why `path` ("/Source/web-page/pdf-job.ts") breaks the naming rule, or null when it does not. */
function fileNameProblem(path: string): string | null
{
    const parts = path.replace(/^\//, '').split('/');
    const name = parts.pop() ?? '';
    for (let depth = 1; depth <= parts.length; depth++)
    {
        const folder = parts.slice(0, depth).join('/');
        if (!TOP_FOLDERS.includes(folder) && !new RegExp(`^${KEBAB}$`).test(parts[depth - 1] ?? ''))
        {
            return `folder "${folder}" is not lowercase kebab-case`;
        }
    }
    if (!TOP_FOLDERS.includes(parts[0] ?? ''))
    {
        return 'not under Source/, Header/ or Helper/';
    }
    if (parts.join('/') === EML_FOLDER && EML_NAME_PATTERN.test(name))
    {
        return null;
    }
    if (KEPT_NAMES.has(name) || FILE_NAME_PATTERNS.some((pattern) => pattern.test(name)))
    {
        return null;
    }
    return `file name "${name}" is not lowercase kebab-case with a known ending (.ts, .test.ts, .spec.ts, .d.ts, .d.mts, .mjs, .css, .html; .eml in ${EML_FOLDER}/)`;
}

describe('file names', () =>
{
    it('accepts the names the project uses', () =>
    {
        for (const path of ['/Source/main.ts', '/Source/index.html', '/Source/web-page/app.css', '/Source/web-page/pdf-job.ts',
            '/Source/web-page/pdf-job.test.ts', '/Source/email-reading/eml-parser.attached.test.ts',
            '/Source/pdf-export/build-pdf-document.attached.property.test.ts', '/Source/pdf-export/font-reader/cmap-table.ts',
            '/Header/vite-bytes-import.d.ts', '/Helper/build-checks/font-rules.d.mts', '/Helper/build-checks/font-rules.mjs',
            '/Helper/Test/browser-tests/clear.spec.ts', '/Helper/Test/browser-tests/support/keyboard.ts',
            '/Helper/Test/test-data/msg/builder.ts', '/Helper/Test/test-data/README.md',
            '/Helper/Test/test-data/eml/01-plain-english.eml'])
        {
            expect(fileNameProblem(path), path).toBeNull();
        }
    });

    it('refuses other names, for files and for folders', () =>
    {
        for (const path of ['/Source/web-page/PdfJob.ts', '/Source/web-page/pdf_job.ts', '/Source/web-page/pdfJob.ts',
            '/Source/web-page/pdf--job.ts', '/Source/web-page/-pdf-job.ts', '/Source/web-page/pdf-job-.ts',
            '/Source/web-page/pdf-job.TS', '/Source/web-page/pdf-job.js', '/Source/web-page/pdf-job.tsx',
            '/Source/web-page/pdf-job.extra.ts', '/Source/web-page/pdf-job.Attached.test.ts', '/Source/web-page/pdf-job..test.ts',
            '/Source/web-page/pdf job.ts', '/Source/web-page/notes.txt', '/Source/web-page/README.txt', '/Header/types.d.js',
            '/Source/WebPage/pdf-job.ts', '/Source/web_page/pdf-job.ts', '/Helper/Test/Browser-tests/clear.spec.ts',
            '/Helper/Test-data/manifest.ts', '/Header/Test/types.ts', '/Other/pdf-job.ts',
            '/Helper/Test/test-data/eml/Bad_Name.eml', '/Helper/Test/test-data/eml/01-plain-english.EML',
            '/Helper/Test/test-data/eml/notes.txt', '/Helper/Test/test-data/eml/sub/01-plain-english.eml',
            '/Helper/Test/test-data/01-plain-english.eml', '/Source/web-page/sample.eml'])
        {
            expect(fileNameProblem(path), path).not.toBeNull();
        }
    });

    it('finds the files of every checked folder, and none of the folders left out', () =>
    {
        for (const path of ['/Source/main.ts', '/Source/index.html', '/Source/web-page/app.css', '/Header/parsed-email.ts',
            '/Header/vite-bytes-import.d.ts', '/Helper/build-checks/font-rules.d.mts', '/Helper/lint-rules/body-brace-style.mjs',
            '/Helper/Test/browser-tests/clear.spec.ts', '/Helper/Test/test-data/msg/builder.ts', '/Helper/Test/test-support/fake-dom.ts',
            '/Helper/Test/test-data/eml/01-plain-english.eml'])
        {
            expect(files, path).toContain(path);
        }
        expect(files.filter((path) => path.startsWith(`/${EML_FOLDER}/`) && path.endsWith('.eml')).length).toBeGreaterThanOrEqual(34);
        expect(files.filter((path) => /^\/(?:Source\/pdf-export\/fonts|Source\/public)\//.test(path))).toEqual([]);
        expect(files.length).toBeGreaterThan(300);
    });

    it('every file and folder name follows the rule', () =>
    {
        expect(files.map((path) => [path, fileNameProblem(path)]).filter(([, problem]) => problem !== null)).toEqual([]);
    });
});
