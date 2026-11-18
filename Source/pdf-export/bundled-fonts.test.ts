// The bundled PDF fonts: each export is the complete, official WOFF file
// (README.md, rule R1: fonts are bundled, never loaded from the network).
// The `?bytes` imports run through the same Vite plugin as the build.
import { describe, expect, it } from 'vitest';
import notices from '../public/THIRD_PARTY_NOTICES.txt?raw';
import { PDF_FONT_FILES as PINNED_FONT_FILES } from '../../Helper/build-checks/font-rules.mjs';
import license from './fonts/LICENSE.txt?raw';
import { isWoff, PDF_FONT_FILES, PDF_FONTS, pdfFontsReady } from './bundled-fonts';
import type { PdfFontName } from '../../Header/pdf-fonts';

const fontNames = Object.keys(PDF_FONTS) as PdfFontName[];

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string>
{
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('PDF_FONTS', () =>
{
    it('has the four styles, each from its own file', () =>
    {
        expect(fontNames.sort()).toEqual(['mono-regular', 'sans-bold', 'sans-italic', 'sans-regular']);
        expect(new Set(Object.values(PDF_FONT_FILES)).size).toBe(4);
    });

    it.each(fontNames)('%s is a complete WOFF file: signature "wOFF", header length = file length', (name) =>
    {
        const bytes = PDF_FONTS[name];
        expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('wOFF');
        expect(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8)).toBe(bytes.length);
        expect(isWoff(bytes)).toBe(true);
    });

    it.each(fontNames)('%s has the SHA-256 of the official file', async (name) =>
    {
        const pinned = PINNED_FONT_FILES.find((font) => font.file === `Source/pdf-export/fonts/${PDF_FONT_FILES[name]}`);
        expect(pinned).toBeDefined();
        expect(await sha256(PDF_FONTS[name])).toBe(pinned?.sha256);
    });

    it('exports every pinned font, and only those', () =>
    {
        expect(Object.values(PDF_FONT_FILES).map((file) => `Source/pdf-export/fonts/${file}`).sort())
            .toEqual(PINNED_FONT_FILES.map((font) => font.file).sort());
    });

    it('reports the fonts as ready', () =>
    {
        expect(pdfFontsReady()).toBe(true);
    });
});

describe('isWoff', () =>
{
    const woffHeader = (signature: number, length: number, size = 44): Uint8Array =>
    {
        const bytes = new Uint8Array(size);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, signature);
        view.setUint32(8, length);
        return bytes;
    };

    it('accepts a header whose length matches', () =>
    {
        expect(isWoff(woffHeader(0x774f4646, 44))).toBe(true);
    });

    it('rejects a wrong signature, a cut-off or padded file, and a too-short buffer', () =>
    {
        expect(isWoff(woffHeader(0x774f4632, 44))).toBe(false); // 'wOF2': WOFF 2, not WOFF 1
        expect(isWoff(woffHeader(0x774f4646, 100))).toBe(false); // claims 100 bytes, has 44
        expect(isWoff(woffHeader(0x774f4646, 44, 45))).toBe(false); // one extra byte
        expect(isWoff(new Uint8Array([0x77, 0x4f, 0x46, 0x46]))).toBe(false);
    });

    it('reads the header of a view into a larger buffer correctly', () =>
    {
        const inner = woffHeader(0x774f4646, 44);
        const outer = new Uint8Array(50);
        outer.set(inner, 3);
        expect(isWoff(outer.subarray(3, 47))).toBe(true);
    });

    it('makes pdfFontsReady false when one font is not a WOFF file', () =>
    {
        expect(pdfFontsReady({ ...PDF_FONTS, 'sans-bold': new Uint8Array(44) })).toBe(false);
    });
});

describe('font license', () =>
{
    it('is shipped unchanged in the third-party notices', () =>
    {
        expect(license).toMatch(/^Copyright © 2017 IBM Corp\. with Reserved Font Name "Plex"/);
        expect(license).toContain('SIL OPEN FONT LICENSE Version 1.1');
        // Compared line by line, ignoring line endings and spaces at line ends
        // (the official text has one invisible trailing space, on line 20).
        const normalize = (text: string): string => text.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '');
        expect(normalize(notices)).toContain(normalize(license));
    });
});
