// Parses the four PDF fonts from WOFF bytes handed in by the caller. The
// PDF worker uses this (Source/worker-pipeline/pdf-worker.ts): the page passes it the
// bundled font bytes, so the worker never imports the font chunk (bundled-fonts.ts,
// about 1.2 MB of numbers that the build allows in one file only, see
// Helper/build-checks/font-rules.mjs). Nothing comes from bundled-fonts.ts here, not even
// types, so the font chunk is never pulled in.
//
// No DOM, no network (README.md, rule R1), so it is worker-safe.
import { readWoffFont } from './font-reader/parse-font';
import type { PdfFonts } from './generate-pdf';
import type { ParsedFont, PdfFontName } from '../../Header/pdf-fonts';

/** The font names in a fixed order (the result does not depend on key order). */
export const PDF_FONT_NAMES: readonly PdfFontName[] = ['sans-regular', 'sans-bold', 'sans-italic', 'mono-regular'];

/** Parses each WOFF file. Rejects with a FontError for a broken file. */
export async function parsePdfFonts(files: Readonly<Record<PdfFontName, Uint8Array>>): Promise<PdfFonts>
{
    const parsedFonts = await Promise.all(PDF_FONT_NAMES.map((name) => readWoffFont(files[name])));
    const fonts = {} as Record<PdfFontName, ParsedFont>;
    PDF_FONT_NAMES.forEach((name, position) =>
    {
        fonts[name] = parsedFonts[position]!;
    });
    return fonts;
}
