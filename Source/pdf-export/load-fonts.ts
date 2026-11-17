// Parses the four bundled PDF fonts (fonts.ts) into what the layout and the
// backend need. Call it once and keep the result: parsing unwraps each WOFF
// file (about 1 MB in all). Apart from the bundled bytes it uses nothing
// outside (no network, README.md, rule R1; no DOM), so it is worker-safe.
//
// Kept apart from generate.ts on purpose: importing this file imports the
// font bytes (fonts.ts), generate.ts does not (it takes parsed fonts). Code
// that gets the bytes another way (the PDF worker, which is handed them by
// the page) uses parsePdfFonts (parse-fonts.ts) and never pulls the font
// chunk in.
import { PDF_FONTS } from './fonts';
import type { PdfFonts } from './generate';
import { parsePdfFonts } from './parse-fonts';
import type { PdfFontName } from '../../Header/pdf-fonts';

/** Parses each WOFF file (default: the bundled ones). Rejects with a FontError for a broken file. */
export function loadPdfFonts(files: Readonly<Record<PdfFontName, Uint8Array>> = PDF_FONTS): Promise<PdfFonts>
{
    return parsePdfFonts(files);
}
