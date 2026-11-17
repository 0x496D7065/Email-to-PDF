// The fonts of the PDF export: IBM Plex, bundled with the app (README.md,
// rule R1: no font is ever loaded from the network). The files in
// src/fonts/ are the official, unmodified WOFF files (SIL Open Font License
// 1.1, see src/fonts/LICENSE.txt), embedded whole in the PDF later (no
// subsetting).
//
// Each `?bytes` import is the file's exact bytes (see vite.config.ts). The
// build puts them in a chunk of their own, assets/pdf-fonts-[hash].js, which
// the page entry (src/main.ts) imports statically, so the fonts are in memory
// as soon as the page has loaded and the export works offline.
import plexMonoRegular from '../fonts/IBMPlexMono-Regular.woff?bytes';
import plexSansBold from '../fonts/IBMPlexSans-Bold.woff?bytes';
import plexSansItalic from '../fonts/IBMPlexSans-Italic.woff?bytes';
import plexSansRegular from '../fonts/IBMPlexSans-Regular.woff?bytes';

/** The four font styles the PDF uses. */
export type PdfFontName = 'sans-regular' | 'sans-bold' | 'sans-italic' | 'mono-regular';

/** Each PDF font's WOFF file, as bytes. Never modify them (Reserved Font Name "Plex"). */
export const PDF_FONTS: Readonly<Record<PdfFontName, Uint8Array<ArrayBuffer>>> = {
    'sans-regular': plexSansRegular,
    'sans-bold': plexSansBold,
    'sans-italic': plexSansItalic,
    'mono-regular': plexMonoRegular,
};

/** The original file name of each font (for the PDF and the tests). */
export const PDF_FONT_FILES: Readonly<Record<PdfFontName, string>> = {
    'sans-regular': 'IBMPlexSans-Regular.woff',
    'sans-bold': 'IBMPlexSans-Bold.woff',
    'sans-italic': 'IBMPlexSans-Italic.woff',
    'mono-regular': 'IBMPlexMono-Regular.woff',
};

/**
 * Does `bytes` look like a complete WOFF 1.0 file? Its header starts with
 * the signature "wOFF" and states the file's total length (bytes 8 to 11,
 * big-endian), which must match.
 */
export function isWoff(bytes: Uint8Array): boolean
{
    if (bytes.length < 44) return false; // a WOFF header is 44 bytes
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return view.getUint32(0) === 0x774f4646 && view.getUint32(8) === bytes.length;
}

/** True when every PDF font is present and a complete WOFF file. */
export function pdfFontsReady(fonts: Readonly<Record<PdfFontName, Uint8Array>> = PDF_FONTS): boolean
{
    return Object.values(fonts).every(isWoff);
}
