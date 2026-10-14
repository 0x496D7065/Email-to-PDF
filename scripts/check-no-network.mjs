// The "no network" build check (README.md, rule R3).
// Run: npm run check:network   (also runs automatically at the end of npm run build)
//
// Fails (exit code 1) if the source or the built site contains a network API,
// a browser storage API, an http(s) URL that is not allowlisted, or test code,
// if the built site contains an HTML injection API such as innerHTML
// (README.md, rule R4), or if the built security headers are missing. The
// matching rules live in no-network-rules.mjs.
//
// Plain JavaScript using only Node built-ins: no extra dependency or
// TypeScript runner is needed to run it.
//
// What is scanned:
//   - src/ (every file) and index.html: catches problems early, in the code
//     you write.
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
// What is NOT scanned:
//   - scripts/: these check files must contain the banned words to look for them.
//   - src/**/*.test.ts: tests legitimately mention banned words as strings
//     (e.g. the CSP test checks that "http:" is absent). They are never
//     shipped, and this cannot hide real app code: anything the app imports
//     ends up in dist/, which is scanned with the same rules PLUS a check that
//     no test code ("vitest", "describe(") leaked into the build.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { checkBuiltHtml, checkHeadersFile, findEmbeddedViolations, findOpaquePayloads, findViolations } from './no-network-rules.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');

/** All files under `dir`, recursively. */
function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

/** Path relative to the project root, with forward slashes for readability. */
function display(path) {
  return relative(root, path).split(sep).join('/');
}

if (!existsSync(dist)) {
  console.error('check-no-network: dist/ does not exist. Run "npm run build" first.');
  process.exit(1);
}

const sourceFiles = [
  ...listFiles(join(root, 'src')).filter((path) => !path.endsWith('.test.ts')),
  join(root, 'index.html'),
];
const distFiles = listFiles(dist);

const errors = [];

for (const [files, isDist] of [
  [sourceFiles, false],
  [distFiles, true],
]) {
  for (const path of files) {
    // For dist/ files: the path inside dist/ (e.g. 'THIRD_PARTY_NOTICES.txt'),
    // used by the per-file URL allowlist.
    const distFile = isDist ? relative(dist, path).split(sep).join('/') : undefined;
    const text = readFileSync(path, 'utf8');
    const findings = findViolations(text, { isDist, distFile });
    // dist/ only: code embedded in strings (the inlined workers, see the top).
    if (isDist) findings.push(...findEmbeddedViolations(text, { isDist, distFile }));
    // dist/ only: a long base64 literal would hide code from both scans above
    // (e.g. if a future Vite inlined workers as base64): fail so a person looks.
    if (isDist) findings.push(...findOpaquePayloads(text));
    for (const { line, match, reason } of findings) {
      // Minified lines can be huge; cap what we print.
      const shown = match.length > 80 ? `${match.slice(0, 80)}...` : match;
      errors.push(`${display(path)}:${line}: "${shown}" -> ${reason}`);
    }
  }
}

// Structural checks on the built security headers.
const indexHtml = join(dist, 'index.html');
const headersFile = join(dist, '_headers');
for (const [path, check] of [
  [indexHtml, checkBuiltHtml],
  [headersFile, checkHeadersFile],
]) {
  if (!existsSync(path)) {
    errors.push(`${display(path)}: file is missing (README.md, rule R2)`);
    continue;
  }
  for (const problem of check(readFileSync(path, 'utf8'))) {
    errors.push(`${display(path)}: ${problem}`);
  }
}

const scanned = sourceFiles.length + distFiles.length;
if (errors.length > 0) {
  console.error(`check-no-network: FAILED with ${errors.length} problem(s):`);
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}
console.log(`check-no-network: OK (${scanned} files scanned, security headers present).`);
