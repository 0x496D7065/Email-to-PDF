// Pure checks for the bundled PDF fonts, part of the build check
// (README.md, rule R3). check-no-network.mjs does the file reading.
//
// The fonts (src/fonts/*.woff, official IBM Plex files) are built into one
// JS chunk as plain number arrays: `new Uint8Array([119,79,70,70,...])`
// (see the `?bytes` plugin in vite.config.ts). A long number array is as
// opaque to the text rules as a base64 string, so it could hide code. Hence:
//   - a long number array is allowed ONLY in the font chunk,
//   - every long number array there must decode to the exact bytes of one of
//     the committed fonts (SHA-256), and each font must be there once,
//   - the committed font files must have the SHA-256 pinned below,
//   - the font chunk must be loaded by the page at startup (a static import
//     from the entry script), so the app still works offline once loaded.
import { createHash } from 'node:crypto';

/**
 * The bundled fonts, with the SHA-256 of the official, unmodified files
 * (@ibm/plex-sans 1.1.0 and @ibm/plex-mono 2.5.0, fonts/complete/woff/).
 * "Plex" is a Reserved Font Name under the SIL Open Font License: the files
 * must never be modified or renamed.
 */
export const PDF_FONT_FILES = [
  {
    file: 'src/fonts/IBMPlexSans-Regular.woff',
    sha256: 'b731cf56514a4bd711ab2f9acf641f9311707f4386772eb306d25c2b29b73b1a',
  },
  {
    file: 'src/fonts/IBMPlexSans-Bold.woff',
    sha256: '5c8bcd6be12df67acd529819b92f36febeff4df059a9603c4ecd578f01cf4062',
  },
  {
    file: 'src/fonts/IBMPlexSans-Italic.woff',
    sha256: 'ed06e0a2cfa973492c7ee61e5f1bf3be7db4d3d5c1551c889ec458ba2972db99',
  },
  {
    file: 'src/fonts/IBMPlexMono-Regular.woff',
    sha256: '3a0d6e1587e8dc784be5a75e1c55b1a5533919b04072a29c750bb29cfe4a4b74',
  },
];

/** The font chunk in dist/ (path relative to dist/). Named in vite.config.ts. */
export const FONT_CHUNK_PATTERN = /^assets\/pdf-fonts-[A-Za-z0-9_-]+\.js$/;

/**
 * Shortest run of comma-separated integers treated as a "long number array".
 * The app's own minified code has none longer than 16 today; 64 leaves room
 * for ordinary small tables while far too short to hide anything useful.
 */
export const NUMBER_ARRAY_MIN_LENGTH = 64;

/**
 * How much text the font chunk may hold besides its number arrays (the
 * `new Uint8Array(...)` wrappers and the export list are about 150 characters).
 */
export const FONT_CHUNK_MAX_OTHER_TEXT = 1000;

/** File extensions treated as font files in src/. */
const FONT_EXTENSIONS = /\.(?:woff2?|ttf|otf|eot)$/i;

/** SHA-256 of `bytes`, as lowercase hex. */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

// What this guard does and does not do: it makes it harder to hide code in
// a list of numbers, but it is not the real barrier. The real barrier is the
// CSP (connect-src 'none' and script-src 'self': hidden code could neither
// send anything nor load other code) plus the scans for network APIs. This
// guard does not catch every way of writing numbers down, for example many
// short lists joined together, or numbers written as text ("104" or "1,2,3"
// in quotes count as text, not numbers, unless a run of them is unquoted).
//
// One number, written any way JavaScript allows: optional sign (-1, +1),
// decimals and floats (104, 104.0, .5), exponents (1e2), hex, binary and
// octal (0x68, 0b1, 0o7), BigInt (104n) and digit separators (1_04).
const NUM = String.raw`[-+]?(?:0[xXbBoO][0-9a-fA-F_]+n?|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][-+]?\d+)?n?)`;
// A run: one number, then any number of ", number" where the number may be
// missing (a hole, as in [1,,2]). Not preceded by a word character, $ or
// '.', so `a1,2` does not start a run inside a name. No trailing lookahead,
// so the scan stays linear on a huge line.
const NUMBER_RUN = new RegExp(String.raw`(?<![\w$.])${NUM}(?:\s*,\s*(?:${NUM})?)*`, 'g');

/**
 * The value of one item of a run: NaN for a hole or anything that is not a
 * plain number (so it never counts as a byte), otherwise the number.
 * @param {string} part
 */
function numberValue(part) {
  let s = part.trim().replace(/_/g, '');
  if (s === '') return NaN;
  let sign = 1;
  if (s[0] === '-' || s[0] === '+') {
    if (s[0] === '-') sign = -1;
    s = s.slice(1);
  }
  if (s.endsWith('n')) s = s.slice(0, -1);
  return sign * Number(s);
}

/**
 * Finds runs of at least `minLength` comma-separated number literals (holes
 * count as items too).
 * @param {string} text
 * @param {number} [minLength]
 * @returns {{ line: number, start: number, end: number, values: number[] }[]}
 *   line is 1-based; start/end are offsets in `text`; a hole is NaN.
 */
export function findNumberArrays(text, minLength = NUMBER_ARRAY_MIN_LENGTH) {
  const found = [];
  for (const m of text.matchAll(NUMBER_RUN)) {
    // Cheap pre-filter: a run of minLength numbers has minLength - 1 commas.
    let commas = 0;
    for (let i = 0; i < m[0].length && commas < minLength - 1; i += 1) if (m[0].charCodeAt(i) === 44) commas += 1;
    if (commas < minLength - 1) continue;
    const values = m[0].split(',').map(numberValue);
    let line = 1;
    for (let i = 0; i < m.index; i += 1) if (text.charCodeAt(i) === 10) line += 1;
    found.push({ line, start: m.index, end: m.index + m[0].length, values });
  }
  return found;
}

/**
 * Checks the long number arrays of the built site.
 * @param {{ path: string, text: string }[]} files  Every dist/ file; path relative to dist/, forward slashes.
 * @param {{ file: string, sha256: string }[]} [fonts]  Expected fonts.
 * @param {number} [minLength]
 * @returns {string[]}  Problems (empty = OK).
 */
export function checkNumberArrays(files, fonts = PDF_FONT_FILES, minLength = NUMBER_ARRAY_MIN_LENGTH) {
  const problems = [];
  const fontChunks = files.filter((f) => FONT_CHUNK_PATTERN.test(f.path));
  if (fontChunks.length !== 1) {
    problems.push(`expected exactly one font chunk (dist/assets/pdf-fonts-*.js), found ${fontChunks.length} (README.md, rule R3)`);
  }
  const seen = new Map(fonts.map((font) => [font.sha256, 0]));
  for (const { path, text } of files) {
    const arrays = findNumberArrays(text, minLength);
    if (!FONT_CHUNK_PATTERN.test(path)) {
      for (const a of arrays) {
        problems.push(
          `dist/${path}:${a.line}: a ${a.values.length}-number array outside the font chunk: data hidden this way escapes every other check (README.md, rule R3)`,
        );
      }
      continue;
    }
    let otherText = text.length;
    for (const a of arrays) {
      otherText -= a.end - a.start;
      if (!a.values.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) {
        problems.push(`dist/${path}:${a.line}: a number array in the font chunk holds values that are not bytes (README.md, rule R3)`);
        continue;
      }
      const hash = sha256Hex(Uint8Array.from(a.values));
      if (!seen.has(hash)) {
        problems.push(
          `dist/${path}:${a.line}: a ${a.values.length}-byte array in the font chunk matches no committed font (SHA-256 ${hash}) (README.md, rule R3)`,
        );
        continue;
      }
      seen.set(hash, (seen.get(hash) ?? 0) + 1);
    }
    if (otherText > FONT_CHUNK_MAX_OTHER_TEXT) {
      problems.push(
        `dist/${path}: ${otherText} characters besides the font arrays (at most ${FONT_CHUNK_MAX_OTHER_TEXT}): the font chunk must hold the fonts only (README.md, rule R3)`,
      );
    }
  }
  if (fontChunks.length === 1) {
    for (const font of fonts) {
      const count = seen.get(font.sha256) ?? 0;
      if (count !== 1) problems.push(`${font.file} must be in the font chunk exactly once, found ${count} time(s) (README.md, rule R3)`);
    }
  }
  return problems;
}

/**
 * Checks that the font chunk is loaded at startup: the page's entry script
 * (the <script type="module" src=...> of dist/index.html) must import it
 * statically. A dynamic import() would only load it later, which needs the
 * network, and the tool must keep working offline once the page has loaded.
 * @param {string} html  dist/index.html
 * @param {{ path: string, text: string }[]} files  dist/ files, as for checkNumberArrays.
 * @returns {string[]}  Problems (empty = OK).
 */
export function checkFontChunkLoadedAtStartup(html, files) {
  const entry = /<script type="module"[^>]*\ssrc="\/([^"]+)"/.exec(html)?.[1];
  const entryFile = files.find((f) => f.path === entry);
  if (entryFile === undefined) return ['dist/index.html: no entry <script type="module" src=...> found (README.md, rule R3)'];
  const chunk = files.find((f) => FONT_CHUNK_PATTERN.test(f.path));
  if (chunk === undefined) return []; // reported by checkNumberArrays
  const name = chunk.path.slice('assets/'.length).replace(/[.]/g, '\\.');
  // `import"./x.js"` or `import{a as b}from"./x.js"`, never `import("./x.js")`.
  // This is only a text check on the minified output, not a real parse. The
  // offline browser test (e2e/add-files.spec.ts) backs it up: it sees the
  // font chunk being requested while the page loads.
  const staticImport = new RegExp(String.raw`(?<![\w$.])import\s*(?:[\w$\s{},*]+from\s*)?["']\./${name}["']`);
  if (!staticImport.test(entryFile.text)) {
    return [`dist/${entryFile.path}: the entry script does not statically import dist/${chunk.path}, so the fonts would not load with the page (README.md, rule R3)`];
  }
  return [];
}

/**
 * Checks the font files of src/: each must be one of `fonts` with its exact
 * SHA-256, and each of `fonts` must be present.
 * @param {{ path: string, bytes: Uint8Array }[]} files  src/ files whose name
 *   has a font extension (see isFontFile); path relative to the project root.
 * @param {{ file: string, sha256: string }[]} [fonts]
 * @returns {string[]}  Problems (empty = OK).
 */
export function checkSourceFonts(files, fonts = PDF_FONT_FILES) {
  const problems = [];
  for (const { path, bytes } of files) {
    const font = fonts.find((f) => f.file === path);
    if (font === undefined) {
      problems.push(`${path}: font file not listed in scripts/font-rules.mjs (README.md, rule R3)`);
    } else if (sha256Hex(bytes) !== font.sha256) {
      problems.push(`${path}: SHA-256 ${sha256Hex(bytes)} is not the official file's ${font.sha256}; the font must not be modified (README.md, rule R3)`);
    }
  }
  for (const font of fonts) {
    if (!files.some((f) => f.path === font.file)) problems.push(`${font.file}: font file is missing (README.md, rule R3)`);
  }
  return problems;
}

/**
 * May the `?bytes` plugin of vite.config.ts load this file? Only a .woff
 * file directly inside `fontsDir` (this project's absolute src/fonts/
 * folder), so not e.g. node_modules/x/src/fonts/ or another project's.
 * Back slashes (Windows) count as forward slashes; on Windows the drive
 * letter is compared without regard to case.
 * @param {string} file  Absolute path of the imported file (without `?bytes`).
 * @param {string} fontsDir  Absolute path of src/fonts/, with or without a trailing slash.
 */
export function isBytesImportAllowed(file, fontsDir) {
  const norm = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `${d.toLowerCase()}:`);
  const dir = norm(fontsDir).replace(/\/*$/, '/');
  const f = norm(file);
  return f.startsWith(dir) && /^[^/]+\.woff$/.test(f.slice(dir.length));
}

/** Is this file name a font file (checked by hash, not scanned as text)? */
export function isFontFile(path) {
  return FONT_EXTENSIONS.test(path);
}
