// Parses the four PDF fonts from WOFF bytes handed in by the caller. The
// PDF worker uses this (src/pipeline/pdf-worker.ts): the page passes it the
// bundled font bytes, so the worker never imports the font chunk (fonts.ts,
// about 1.2 MB of numbers that the build allows in one file only, see
// scripts/font-rules.mjs). Only TYPES come from fonts.ts here: a type import
// is erased by the build and pulls nothing in.
//
// No DOM, no network (README.md, rule R1), so it is worker-safe.
import { type ParsedFont, readWoffFont } from './font/font';
import type { PdfFontName } from './fonts';
import type { PdfFonts } from './generate';

/** The font names in a fixed order (the result does not depend on key order). */
export const PDF_FONT_NAMES: readonly PdfFontName[] = ['sans-regular', 'sans-bold', 'sans-italic', 'mono-regular'];

/** Parses each WOFF file. Rejects with a FontError for a broken file. */
export async function parsePdfFonts(files: Readonly<Record<PdfFontName, Uint8Array>>): Promise<PdfFonts>
{
    const parsed = await Promise.all(PDF_FONT_NAMES.map((name) => readWoffFont(files[name])));
    const fonts = {} as Record<PdfFontName, ParsedFont>;
    PDF_FONT_NAMES.forEach((name, k) =>
    {
        fonts[name] = parsed[k]!;
    });
    return fonts;
}
