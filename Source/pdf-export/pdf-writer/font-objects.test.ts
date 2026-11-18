// Font embedding pieces: /W widths, the ToUnicode CMap layout, the
// FontDescriptor values, and the fsType embedding check.
import { beforeAll, describe, expect, it } from 'vitest';
import { parseToUnicode } from '../../../Helper/Test/test-support/pdf-reader';
import { readWoffFont } from '../font-reader/parse-font';
import { PDF_FONTS } from '../bundled-fonts';
import { checkEmbeddable, fontDescriptor, FontUsage, toUnicodeCmap, widthsArray } from './font-objects';
import { PdfWriteError } from './pdf-syntax';
import type { ParsedFont } from '../../../Header/pdf-fonts';

let sans: ParsedFont;
let mono: ParsedFont;
let bold: ParsedFont;
beforeAll(async () =>
{
    sans = await readWoffFont(PDF_FONTS['sans-regular']);
    mono = await readWoffFont(PDF_FONTS['mono-regular']);
    bold = await readWoffFont(PDF_FONTS['sans-bold']);
});

describe('widthsArray', () =>
{
    it('writes groups of consecutive ids, scaled to 1000 per em', () =>
    {
        const ids = [sans.glyphFor(0x41), sans.glyphFor(0x42), sans.glyphFor(0x61)];
        const text = widthsArray(sans, ids);
        expect(text.startsWith('[')).toBe(true);
        for (const id of ids)
        {
            expect(text).toContain(String((sans.advance(id) * 1000) / sans.unitsPerEm));
        }
    });

    it('uses the "first last width" form for 3 or more equal widths (monospaced)', () =>
    {
        expect(widthsArray(mono, [10, 11, 12, 13])).toBe(`[10 13 ${mono.advance(10)}]`);
    });

    it('writes an empty array for no glyphs', () =>
    {
        expect(widthsArray(sans, [])).toBe('[]');
    });
});

describe('toUnicodeCmap', () =>
{
    it('uses bfrange for consecutive single characters and bfchar otherwise', () =>
    {
        const map = new Map([
            [3, 'A'],
            [4, 'B'],
            [5, 'C'],
            [9, 'e\u{301}'],
            [10, '\u{1F600}'],
            [20, 'x'],
        ]);
        const cmap = toUnicodeCmap(map);
        expect(cmap).toContain('1 beginbfrange\n<0003> <0005> <0041>\nendbfrange');
        expect(cmap).toContain('<0009> <00650301>');
        expect(cmap).toContain('<000A> <D83DDE00>');
        expect(cmap).toContain('<0014> <0078>');
        expect(parseToUnicode(cmap)).toEqual(map);
    });

    it('never lets a bfrange cross a glyph or destination byte boundary', () =>
    {
        const map = new Map<number, string>();
        for (let g = 0xfc; g <= 0x104; g++)
        {
            map.set(g, String.fromCharCode(0x41 + g - 0xfc));
        }
        for (let g = 0x200; g <= 0x204; g++)
        {
            map.set(g, String.fromCharCode(0xfd + g - 0x200)); // U+00FD to U+0101
        }
        const cmap = toUnicodeCmap(map);
        expect(parseToUnicode(cmap)).toEqual(map);
        expect(cmap).toContain('<00FC> <00FF> <0041>');
        expect(cmap).toContain('<0100> <0104> <0045>');
        expect(cmap).toContain('<0200> <0202> <00FD>');
    });

    it('splits into blocks of at most 100 entries', () =>
    {
        const map = new Map<number, string>();
        for (let g = 0; g < 250; g++)
        {
            map.set(g * 2, String.fromCodePoint(0x1f600 + (g % 50)));
        }
        const cmap = toUnicodeCmap(map);
        expect(cmap.match(/beginbfchar/g)).toHaveLength(3);
        expect(parseToUnicode(cmap)).toEqual(map);
    });
});

describe('FontUsage', () =>
{
    it('keeps the first text of a glyph, in copy-layer form', () =>
    {
        const usage = new FontUsage(sans, 'F1');
        usage.use(7, '\u{200B}'); // drops to nothing: no mapping yet
        usage.use(7, 'A');
        usage.use(7, 'Z');
        usage.use(8, '\u{7}');
        expect(usage.toUnicode.get(7)).toBe('A');
        expect(usage.toUnicode.get(8)).toBe('\u{FFFD}');
        expect(usage.yields([7, 8, 9])).toBe('A\u{FFFD}');
    });

    it('refuses glyph ids not in the font', () =>
    {
        const usage = new FontUsage(sans, 'F1');
        expect(() => usage.use(sans.numGlyphs, 'x')).toThrow(PdfWriteError);
        expect(() => usage.use(-1, 'x')).toThrow(PdfWriteError);
        expect(() => usage.use(1.5, 'x')).toThrow(PdfWriteError);
    });
});

describe('fontDescriptor', () =>
{
    it('derives StemV from the weight class and uses hhea for Ascent / Descent', () =>
    {
        const regular = fontDescriptor(sans, 99);
        expect(regular).toContain('/StemV 88');
        expect(regular).toContain(`/Ascent ${sans.hhea.ascender}`);
        expect(regular).toContain(`/Descent ${sans.hhea.descender}`);
        expect(regular).toContain(`/CapHeight ${sans.capHeight}`);
        expect(regular).toContain('/Flags 32 ');
        expect(regular).toContain('/FontFile2 99 0 R');
        expect(fontDescriptor(bold, 1)).toContain('/StemV 166');
        expect(fontDescriptor(mono, 1)).toContain('/Flags 33 ');
    });

    it('falls back to the bounding box top when there is no cap height', () =>
    {
        const noCap = { ...sans, capHeight: null, xHeight: null };
        const text = fontDescriptor(noCap, 1);
        expect(text).toContain(`/CapHeight ${sans.bbox.yMax}`);
        expect(text).not.toContain('/XHeight');
    });
});

describe('checkEmbeddable', () =>
{
    it('accepts the Plex fonts and refuses a restricted license', () =>
    {
        expect(() => checkEmbeddable(sans)).not.toThrow();
        expect(() => checkEmbeddable({ ...sans, fsType: 0x0002 })).toThrow(/restricted license/);
        expect(() => checkEmbeddable({ ...sans, fsType: 0x0008 })).not.toThrow(); // editable embedding is fine
    });
});
