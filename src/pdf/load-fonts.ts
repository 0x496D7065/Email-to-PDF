// Parses the four bundled PDF fonts (fonts.ts) into what the layout and the
// backend need. Call it once and keep the result: parsing unwraps each WOFF
// file (about 1 MB in all). Apart from the bundled bytes it uses nothing
// outside (no network, README.md, rule R1; no DOM), so it is worker-safe.
//
// Kept apart from generate.ts on purpose: importing this file imports the
// font bytes (fonts.ts), generate.ts does not (it takes parsed fonts). So
// code that gets the bytes another way (e.g. a worker that is handed them)
// can use generatePdf without pulling the font chunk in.
import { type ParsedFont, readWoffFont } from './font/font';
import { PDF_FONTS, type PdfFontName } from './fonts';
import type { PdfFonts } from './generate';

/** The font names in a fixed order (the result does not depend on key order). */
const NAMES: readonly PdfFontName[] = ['sans-regular', 'sans-bold', 'sans-italic', 'mono-regular'];

/** Parses each WOFF file (default: the bundled ones). Rejects with a FontError for a broken file. */
export async function loadPdfFonts(files: Readonly<Record<PdfFontName, Uint8Array>> = PDF_FONTS): Promise<PdfFonts> {
  const parsed = await Promise.all(NAMES.map((name) => readWoffFont(files[name])));
  const fonts = {} as Record<PdfFontName, ParsedFont>;
  NAMES.forEach((name, k) => {
    fonts[name] = parsed[k]!;
  });
  return fonts;
}
