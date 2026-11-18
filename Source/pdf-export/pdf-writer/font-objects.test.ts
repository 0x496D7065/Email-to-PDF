// Font embedding pieces: /W widths, the ToUnicode CMap layout, the
// FontDescriptor values, and the fsType embedding check.
import { beforeAll, describe, expect, it } from 'vitest';
import { parseToUnicode } from '../../../Helper/Test/test-support/pdf-reader';
import { readWoffFont } from '../font-reader/parse-font';
import { PDF_FONTS } from '../bundled-fonts';
import { checkEmbeddable, fontDescriptor, FontUsage, toUnicodeCmap, widthsArray } from './font-objects';
import { PdfWriteError } from './pdf-syntax';
import type { ParsedFont } from '../../../Header/pdf-fonts';

let sansRegular: ParsedFont;
let monoRegular: ParsedFont;
let sansBold: ParsedFont;
beforeAll(async () =>
{
    sansRegular = await readWoffFont(PDF_FONTS['sans-regular']);
    monoRegular = await readWoffFont(PDF_FONTS['mono-regular']);
    sansBold = await readWoffFont(PDF_FONTS['sans-bold']);
});

describe('widthsArray', () =>
{
    it('writes groups of consecutive ids, scaled to 1000 per em', () =>
    {
        const glyphIds = [sansRegular.glyphFor(0x41), sansRegular.glyphFor(0x42), sansRegular.glyphFor(0x61)];
        const text = widthsArray(sansRegular, glyphIds);
        expect(text.startsWith('[')).toBe(true);
        for (const glyphId of glyphIds)
        {
            expect(text).toContain(String((sansRegular.advance(glyphId) * 1000) / sansRegular.unitsPerEm));
        }
    });

    it('uses the "first last width" form for 3 or more equal widths (monospaced)', () =>
    {
        expect(widthsArray(monoRegular, [10, 11, 12, 13])).toBe(`[10 13 ${monoRegular.advance(10)}]`);
    });

    it('writes an empty array for no glyphs', () =>
    {
        expect(widthsArray(sansRegular, [])).toBe('[]');
    });
});

describe('toUnicodeCmap', () =>
{
    it('uses bfrange for consecutive single characters and bfchar otherwise', () =>
    {
        const toUnicode = new Map([
            [3, 'A'],
            [4, 'B'],
            [5, 'C'],
            [9, 'e\u{301}'],
            [10, '\u{1F600}'],
            [20, 'x'],
        ]);
        const cmap = toUnicodeCmap(toUnicode);
        expect(cmap).toContain('1 beginbfrange\n<0003> <0005> <0041>\nendbfrange');
        expect(cmap).toContain('<0009> <00650301>');
        expect(cmap).toContain('<000A> <D83DDE00>');
        expect(cmap).toContain('<0014> <0078>');
        expect(parseToUnicode(cmap)).toEqual(toUnicode);
    });

    it('never lets a bfrange cross a glyph or destination byte boundary', () =>
    {
        const toUnicode = new Map<number, string>();
        for (let glyph = 0xfc; glyph <= 0x104; glyph++)
        {
            toUnicode.set(glyph, String.fromCharCode(0x41 + glyph - 0xfc));
        }
        for (let glyph = 0x200; glyph <= 0x204; glyph++)
        {
            toUnicode.set(glyph, String.fromCharCode(0xfd + glyph - 0x200)); // U+00FD to U+0101
        }
        const cmap = toUnicodeCmap(toUnicode);
        expect(parseToUnicode(cmap)).toEqual(toUnicode);
        expect(cmap).toContain('<00FC> <00FF> <0041>');
        expect(cmap).toContain('<0100> <0104> <0045>');
        expect(cmap).toContain('<0200> <0202> <00FD>');
    });

    it('splits into blocks of at most 100 entries', () =>
    {
        const toUnicode = new Map<number, string>();
        for (let glyph = 0; glyph < 250; glyph++)
        {
            toUnicode.set(glyph * 2, String.fromCodePoint(0x1f600 + (glyph % 50)));
        }
        const cmap = toUnicodeCmap(toUnicode);
        expect(cmap.match(/beginbfchar/g)).toHaveLength(3);
        expect(parseToUnicode(cmap)).toEqual(toUnicode);
    });
});

describe('FontUsage', () =>
{
    it('keeps the first text of a glyph, in copy-layer form', () =>
    {
        const usage = new FontUsage(sansRegular, 'F1');
        usage.recordGlyph(7, '\u{200B}'); // drops to nothing: no mapping yet
        usage.recordGlyph(7, 'A');
        usage.recordGlyph(7, 'Z');
        usage.recordGlyph(8, '\u{7}');
        expect(usage.toUnicode.get(7)).toBe('A');
        expect(usage.toUnicode.get(8)).toBe('\u{FFFD}');
        expect(usage.toUnicodeTextOf([7, 8, 9])).toBe('A\u{FFFD}');
    });

    it('refuses glyph ids not in the font', () =>
    {
        const usage = new FontUsage(sansRegular, 'F1');
        expect(() => usage.recordGlyph(sansRegular.numGlyphs, 'x')).toThrow(PdfWriteError);
        expect(() => usage.recordGlyph(-1, 'x')).toThrow(PdfWriteError);
        expect(() => usage.recordGlyph(1.5, 'x')).toThrow(PdfWriteError);
    });
});

describe('fontDescriptor', () =>
{
    it('derives StemV from the weight class and uses hhea for Ascent / Descent', () =>
    {
        const regular = fontDescriptor(sansRegular, 99);
        expect(regular).toContain('/StemV 88');
        expect(regular).toContain(`/Ascent ${sansRegular.hhea.ascender}`);
        expect(regular).toContain(`/Descent ${sansRegular.hhea.descender}`);
        expect(regular).toContain(`/CapHeight ${sansRegular.capHeight}`);
        expect(regular).toContain('/Flags 32 ');
        expect(regular).toContain('/FontFile2 99 0 R');
        expect(fontDescriptor(sansBold, 1)).toContain('/StemV 166');
        expect(fontDescriptor(monoRegular, 1)).toContain('/Flags 33 ');
    });

    it('falls back to the bounding box top when there is no cap height', () =>
    {
        const noCapHeight = { ...sansRegular, capHeight: null, xHeight: null };
        const text = fontDescriptor(noCapHeight, 1);
        expect(text).toContain(`/CapHeight ${sansRegular.bbox.yMax}`);
        expect(text).not.toContain('/XHeight');
    });
});

describe('checkEmbeddable', () =>
{
    it('accepts the Plex fonts and refuses a restricted license', () =>
    {
        expect(() => checkEmbeddable(sansRegular)).not.toThrow();
        expect(() => checkEmbeddable({ ...sansRegular, fsType: 0x0002 })).toThrow(/restricted license/);
        expect(() => checkEmbeddable({ ...sansRegular, fsType: 0x0008 })).not.toThrow(); // editable embedding is fine
    });
});
