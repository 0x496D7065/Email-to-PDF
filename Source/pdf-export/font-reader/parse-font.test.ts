// parseFont / readWoffFont on the bundled IBM Plex fonts, and on copies of
// them with one table changed in memory (pure, as in rule R7). The font files
// on disk are never touched.
import { beforeAll, describe, expect, it } from 'vitest';
import { PDF_FONTS } from '../bundled-fonts';
import { directoryChecksum, FontError } from './binary-reader';
import { parseFont, readWoffFont } from './parse-font';
import { readSfntDirectory } from './sfnt-directory';
import { unwrapWoff } from './unwrap-woff';
import type { ParsedFont, PdfFontName } from '../../../Header/pdf-fonts';

const fontNames = Object.keys(PDF_FONTS) as PdfFontName[];

const EXPECTED_POSTSCRIPT_NAMES: Record<PdfFontName, string> = {
    'sans-regular': 'IBMPlexSans',
    'sans-bold': 'IBMPlexSans-Bold',
    'sans-italic': 'IBMPlexSans-Italic',
    'mono-regular': 'IBMPlexMono',
};

// Code points the PDF must be able to draw (written as numbers, so this file
// stays ASCII): e with acute, grave, circumflex, diaeresis; a grave; c cedilla;
// i diaeresis; o circumflex; u diaeresis; sharp s; oe ligature; euro sign;
// the curly double and single quotes; the guillemets; en and em dash;
// ellipsis; and Latin Extended-A: l stroke, o double acute, s cedilla, g breve.
const LATIN_SAMPLES = [
    0xe9, 0xe8, 0xea, 0xeb, 0xe0, 0xe7, 0xef, 0xf4, 0xfc, 0xdf, 0x153, 0x20ac, 0x201c, 0x201d, 0x2018, 0x2019, 0xab, 0xbb,
    0x2013, 0x2014, 0x2026, 0x142, 0x151, 0x15f, 0x11f,
];
const ASCII_PRINTABLE = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => 0x20 + i);
const EMOJI = 0x1f600; // grinning face

const fonts = {} as Record<PdfFontName, ParsedFont>;
let readMilliseconds = 0;
beforeAll(async () =>
{
    const started = performance.now();
    for (const name of fontNames)
    {
        fonts[name] = await readWoffFont(PDF_FONTS[name]);
    }
    readMilliseconds = performance.now() - started;
});

describe('readWoffFont on the bundled Plex fonts', () =>
{
    it('reads all four quickly', () =>
    {
        expect(readMilliseconds).toBeLessThan(2000);
    });

    it.each(fontNames)('%s: basic metrics', (name) =>
    {
        const font = fonts[name];
        expect(font.postScriptName).toBe(EXPECTED_POSTSCRIPT_NAMES[name]);
        expect(font.unitsPerEm).toBe(1000);
        expect(font.numGlyphs).toBeGreaterThan(100);
        expect(font.hhea.ascender).toBeGreaterThan(0);
        expect(font.hhea.descender).toBeLessThan(0);
        expect(font.typo.ascender).toBeGreaterThan(0);
        expect(font.typo.descender).toBeLessThan(0);
        expect(font.win.ascent).toBeGreaterThan(0);
        expect(font.win.descent).toBeGreaterThan(0);
        expect(font.os2Version).toBeGreaterThanOrEqual(2);
        expect(font.capHeight).toBeGreaterThan(500);
        expect(font.xHeight).toBeGreaterThan(400);
        expect(font.capHeight).toBeGreaterThan(font.xHeight!);
        expect(font.bbox.xMin).toBeLessThan(font.bbox.xMax);
        expect(font.bbox.yMin).toBeLessThan(0);
        expect(font.bbox.yMax).toBeGreaterThan(font.capHeight!);
        expect(font.fsType & 0x0202).toBe(0); // embedding allowed, not bitmap-only
        expect(font.cmap.format === 4 || font.cmap.format === 12).toBe(true);
    });

    it('style flags: bold, italic, fixed pitch', () =>
    {
        expect(fonts['sans-regular']).toMatchObject({ weightClass: 400, isBold: false, isItalic: false, isFixedPitch: false, italicAngle: 0 });
        expect(fonts['sans-bold']).toMatchObject({ weightClass: 700, isBold: true, isItalic: false, isFixedPitch: false });
        expect(fonts['sans-italic']).toMatchObject({ weightClass: 400, isBold: false, isItalic: true, isFixedPitch: false });
        expect(fonts['sans-italic'].italicAngle).toBeLessThan(0);
        expect(fonts['mono-regular']).toMatchObject({ weightClass: 400, isBold: false, isItalic: false, isFixedPitch: true });
    });

    it.each(fontNames)('%s: has glyphs for ASCII and the Latin samples, none for an emoji', (name) =>
    {
        const font = fonts[name];
        for (const codePoint of [...ASCII_PRINTABLE, ...LATIN_SAMPLES])
        {
            expect(font.glyphFor(codePoint), `U+${codePoint.toString(16)}`).toBeGreaterThan(0);
        }
        expect(font.glyphFor(EMOJI)).toBe(0);
        expect(font.hasGlyph(EMOJI)).toBe(false);
        expect(font.hasGlyph(0x41)).toBe(true);
        expect(new Set(LATIN_SAMPLES.map((codePoint) => font.glyphFor(codePoint))).size).toBe(LATIN_SAMPLES.length);
    });

    it.each(fontNames)('%s: invalid code points and surrogates give glyph 0', (name) =>
    {
        const font = fonts[name];
        for (const codePoint of [-1, 0.5, Number.NaN, 0x110000, 0xd83d, 0xdc00])
        {
            expect(font.glyphFor(codePoint)).toBe(0);
        }
    });

    it('mono: every ASCII character has the same advance; sans: "W" is wider than "i"', () =>
    {
        const mono = fonts['mono-regular'];
        const widths = new Set(ASCII_PRINTABLE.map((codePoint) => mono.advance(mono.glyphFor(codePoint))));
        expect(widths.size).toBe(1);
        expect([...widths][0]).toBe(600);
        for (const name of ['sans-regular', 'sans-bold', 'sans-italic'] as const)
        {
            const font = fonts[name];
            expect(font.measure('W')).toBeGreaterThan(font.measure('i'));
            expect(font.measure(' ')).toBeGreaterThan(0);
        }
        expect(fonts['sans-bold'].measure('Hello')).toBeGreaterThan(fonts['sans-regular'].measure('Hello'));
    });

    it('measure sums code point advances: no kerning, combining marks, astral characters', () =>
    {
        const font = fonts['sans-regular'];
        const width = (codePoint: number): number => font.advance(font.glyphFor(codePoint));
        expect(font.measure('')).toBe(0);
        expect(font.measure('AV')).toBe(width(0x41) + width(0x56)); // no kerning
        expect(font.measure('e\u{301}')).toBe(width(0x65) + width(0x301));
        expect(font.measure('\u{1F600}')).toBe(font.advance(0)); // one code point, .notdef
        expect(font.measure('a\u{D83D}b')).toBe(width(0x61) + font.advance(0) + width(0x62)); // lone surrogate: .notdef
        const text = 'Synthetic sample text \u{E9}\u{20AC}\u{2026}';
        expect(font.measure(text)).toBe([...text].reduce((sum, c) => sum + width(c.codePointAt(0)!), 0));
    });

    it('advance rejects glyph ids not in the font', () =>
    {
        const font = fonts['sans-regular'];
        expect(font.advance(0)).toBeGreaterThan(0);
        expect(font.advance(font.numGlyphs - 1)).toBeGreaterThanOrEqual(0);
        for (const id of [-1, font.numGlyphs, 1.5, Number.NaN])
        {
            expect(() => font.advance(id)).toThrow(RangeError);
        }
    });

    it('the parsed font is frozen and keeps the sfnt bytes for embedding', async () =>
    {
        const font = fonts['sans-regular'];
        expect(Object.isFrozen(font)).toBe(true);
        expect(font.sfnt).toEqual(await unwrapWoff(PDF_FONTS['sans-regular']));
    });
});

describe('parseFont on damaged fonts', () =>
{
    let sfnt: Uint8Array<ArrayBuffer>;
    beforeAll(async () =>
    {
        sfnt = await unwrapWoff(PDF_FONTS['mono-regular']);
    });

    /** A copy of the font with one table changed and its checksum fixed, so only the change is tested. */
    const patched = (tag: string, change: (view: DataView, bytes: Uint8Array) => void): Uint8Array =>
    {
        const copy = sfnt.slice();
        const directory = readSfntDirectory(copy);
        const table = directory.tables.get(tag)!;
        const bytes = copy.subarray(table.offset, table.offset + table.length);
        change(new DataView(copy.buffer, table.offset, table.length), bytes);
        const directoryPosition = [...directory.tables.keys()].indexOf(tag);
        const tagValue = new DataView(copy.buffer).getUint32(12 + 16 * directoryPosition);
        new DataView(copy.buffer).setUint32(12 + 16 * directoryPosition + 4, directoryChecksum(tagValue, copy, table.offset, table.length));
        return copy;
    };

    /** A copy with one directory entry renamed (the table then counts as missing), checksum fixed. */
    const renamed = (tag: string, newTag: string): Uint8Array =>
    {
        const copy = sfnt.slice();
        const directory = readSfntDirectory(copy);
        const table = directory.tables.get(tag)!;
        const entryAt = 12 + 16 * [...directory.tables.keys()].indexOf(tag);
        for (let i = 0; i < 4; i++)
        {
            copy[entryAt + i] = newTag.charCodeAt(i);
        }
        const view = new DataView(copy.buffer);
        view.setUint32(entryAt + 4, directoryChecksum(view.getUint32(entryAt), copy, table.offset, table.length));
        return copy;
    };

    /**
     * A copy with one table replaced by `data` (no longer than the original),
     * written at the same offset, its directory length and checksum fixed.
     */
    const replaced = (tag: string, data: Uint8Array): Uint8Array =>
    {
        const copy = sfnt.slice();
        const directory = readSfntDirectory(copy);
        const table = directory.tables.get(tag)!;
        if (data.length > table.length)
        {
            throw new Error(`test table for ${tag} is too long`);
        }
        copy.fill(0, table.offset, table.offset + table.length);
        copy.set(data, table.offset);
        const entryAt = 12 + 16 * [...directory.tables.keys()].indexOf(tag);
        const view = new DataView(copy.buffer);
        view.setUint32(entryAt + 12, data.length);
        view.setUint32(entryAt + 4, directoryChecksum(view.getUint32(entryAt), copy, table.offset, data.length));
        return copy;
    };

    it('the unchanged copy parses (the helpers themselves are right)', () =>
    {
        expect(parseFont(patched('head', () => undefined)).postScriptName).toBe('IBMPlexMono');
        const nameTableEntry = readSfntDirectory(sfnt).tables.get('name')!;
        expect(parseFont(replaced('name', sfnt.subarray(nameTableEntry.offset, nameTableEntry.offset + nameTableEntry.length))).postScriptName)
            .toBe('IBMPlexMono');
    });

    it('decodes post italicAngle as a signed 16.16 Fixed', () =>
    {
        expect(parseFont(patched('post', (view) => view.setUint32(4, 0xfff38000))).italicAngle).toBe(-12.5);
        expect(parseFont(patched('post', (view) => view.setUint32(4, 0x000b4000))).italicAngle).toBe(11.25);
    });

    it('useTypoMetrics: fsSelection bit 7 counts from OS/2 version 4 on', () =>
    {
        const withBit = (version: number, bitOn: boolean): ParsedFont =>
            parseFont(
                patched('OS/2', (view) =>
                {
                    view.setUint16(0, version);
                    view.setUint16(62, bitOn ? view.getUint16(62) | 0x80 : view.getUint16(62) & ~0x80);
                }),
            );
        expect(withBit(4, true).useTypoMetrics).toBe(true);
        expect(withBit(5, true).useTypoMetrics).toBe(true);
        expect(withBit(4, false).useTypoMetrics).toBe(false);
        expect(withBit(3, true).useTypoMetrics).toBe(false);
        expect(withBit(1, true).useTypoMetrics).toBe(false);
    });

    it('rejects an OS/2 version 2 table cut to the 78 bytes of version 0', () =>
    {
        const os2TableEntry = readSfntDirectory(sfnt).tables.get('OS/2')!;
        const shortOs2 = sfnt.slice(os2TableEntry.offset, os2TableEntry.offset + 78);
        new DataView(shortOs2.buffer).setUint16(0, 2);
        const bytes = replaced('OS/2', shortOs2);
        expect(() => parseFont(bytes)).toThrow(FontError);
        expect(() => parseFont(bytes)).toThrow(/OS\/2 version 2 table/);
        new DataView(shortOs2.buffer).setUint16(0, 1);
        expect(parseFont(replaced('OS/2', shortOs2)).os2Version).toBe(1); // 78 bytes is enough before version 2
    });

    describe('PostScript name record choice', () =>
    {
        /** A synthetic name table with one name ID 6 record per [platformId, encodingId, text]. */
        const nameTable = (records: [number, number, string][]): Uint8Array =>
        {
            const strings = records.map(([platformId, , text]) =>
                platformId === 1
                    ? Uint8Array.from(text, (c) => c.charCodeAt(0))
                    : Uint8Array.from([...text].flatMap((c) => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 0xff])),
            );
            const stringStorageAt = 6 + 12 * records.length;
            const nameTableBytes = new Uint8Array(stringStorageAt + strings.reduce((sum, s) => sum + s.length, 0));
            const view = new DataView(nameTableBytes.buffer);
            view.setUint16(2, records.length);
            view.setUint16(4, stringStorageAt);
            let offset = 0;
            records.forEach(([platformId, encodingId], i) =>
            {
                const recordAt = 6 + 12 * i;
                view.setUint16(recordAt, platformId);
                view.setUint16(recordAt + 2, encodingId);
                view.setUint16(recordAt + 6, 6);
                view.setUint16(recordAt + 8, strings[i]!.length);
                view.setUint16(recordAt + 10, offset);
                nameTableBytes.set(strings[i]!, stringStorageAt + offset);
                offset += strings[i]!.length;
            });
            return nameTableBytes;
        };
        const chosenName = (records: [number, number, string][]): string => parseFont(replaced('name', nameTable(records))).postScriptName;

        it('prefers (3,1), then (1,0), then (0,*), whatever the record order', () =>
        {
            expect(chosenName([[0, 3, 'Uni'], [1, 0, 'Mac'], [3, 1, 'Win']])).toBe('Win');
            expect(chosenName([[3, 1, 'Win'], [1, 0, 'Mac'], [0, 3, 'Uni']])).toBe('Win');
            expect(chosenName([[0, 3, 'Uni'], [1, 0, 'Mac']])).toBe('Mac');
            expect(chosenName([[1, 0, 'Mac'], [0, 4, 'Uni']])).toBe('Mac');
            expect(chosenName([[0, 4, 'Uni']])).toBe('Uni');
        });

        it('skips other platforms and falls back when the preferred name has nothing usable', () =>
        {
            expect(chosenName([[3, 0, 'Sym'], [2, 1, 'Iso'], [0, 3, 'Uni']])).toBe('Uni');
            expect(chosenName([[3, 1, '()/%'], [1, 0, 'Mac']])).toBe('Mac');
            expect(() => chosenName([[3, 0, 'Sym']])).toThrow(/no usable PostScript name/);
        });
    });

    it.each(['head', 'hhea', 'maxp', 'hmtx', 'cmap', 'name', 'post', 'OS/2', 'glyf', 'loca'])('rejects a font without "%s"', (tag) =>
    {
        expect(() => parseFont(renamed(tag, 'zzzz'))).toThrow(new RegExp(`no "${tag.replace('/', '\\/')}" table`));
    });

    it('rejects damaged tables with a FontError', () =>
    {
        const cases: [Uint8Array, RegExp][] = [
            [patched('head', (view) => view.setUint32(12, 0)), /head: wrong magic number/],
            [patched('head', (view) => view.setUint16(18, 0)), /unitsPerEm 0 is out of range/],
            [patched('maxp', (view) => view.setUint16(4, 0)), /maxp: font has no glyphs/],
            [patched('hhea', (view) => view.setUint16(34, 0)), /numberOfHMetrics is 0/],
            [patched('hhea', (view) => view.setUint16(34, 65535)), /numberOfHMetrics is 0 or more than the glyph count/],
            [patched('maxp', (view) => view.setUint16(4, 65535)), /hmtx table .* past the end/],
            [patched('cmap', (view) => view.setUint16(0, 1)), /cmap: unknown table version/],
            [patched('name', (view) => view.setUint16(2, 0)), /no usable PostScript name/],
            [patched('name', (view) => view.setUint16(2, 0x7fff)), /name records .* past the end/],
            [sfnt.subarray(0, 100), /past the end/],
        ];
        for (const [bytes, error] of cases)
        {
            expect(() => parseFont(bytes), error.source).toThrow(FontError);
            expect(() => parseFont(bytes), error.source).toThrow(error);
        }
    });

    it('gives no cap height or x-height for an OS/2 table before version 2', () =>
    {
        const font = parseFont(patched('OS/2', (view) => view.setUint16(0, 1)));
        expect(font).toMatchObject({ os2Version: 1, capHeight: null, xHeight: null });
    });

    it('applies the hmtx last-width rule when numberOfHMetrics < numGlyphs', () =>
    {
        const font = parseFont(sfnt);
        const oneMetricFont = parseFont(patched('hhea', (view) => view.setUint16(34, 1)));
        expect(oneMetricFont.numGlyphs).toBe(font.numGlyphs);
        for (const id of [0, 1, 2, Math.floor(font.numGlyphs / 2), font.numGlyphs - 1])
        {
            expect(oneMetricFont.advance(id)).toBe(font.advance(0));
        }
        const halfGlyphCount = Math.floor(font.numGlyphs / 2);
        const halfMetricsFont = parseFont(patched('hhea', (view) => view.setUint16(34, halfGlyphCount)));
        expect(halfMetricsFont.advance(halfGlyphCount - 1)).toBe(font.advance(halfGlyphCount - 1));
        expect(halfMetricsFont.advance(font.numGlyphs - 1)).toBe(font.advance(halfGlyphCount - 1));
    });

    it('keeps only PDF-safe ASCII in the PostScript name', () =>
    {
        // Overwrite the start of every name ID 6 string with "A(B/C#D%" (UTF-16 or bytes).
        const font = parseFont(
            patched('name', (view, bytes) =>
            {
                const stringStorageAt = view.getUint16(4);
                for (let i = 0; i < view.getUint16(2); i++)
                {
                    const recordAt = 6 + 12 * i;
                    if (view.getUint16(recordAt + 6) !== 6)
                    {
                        continue;
                    }
                    const start = stringStorageAt + view.getUint16(recordAt + 10);
                    const text = 'A(B/C#D%';
                    const wide = view.getUint16(recordAt) !== 1;
                    for (let j = 0; j < text.length; j++)
                    {
                        if (wide)
                        {
                            view.setUint16(start + 2 * j, text.charCodeAt(j));
                        }
                        else
                        {
                            bytes[start + j] = text.charCodeAt(j);
                        }
                    }
                }
            }),
        );
        expect(font.postScriptName).toMatch(/^ABCD/);
        expect(font.postScriptName).toMatch(/^[\x21-\x7e]+$/);
        expect(font.postScriptName).not.toMatch(/[()<>[\]{}/%#]/);
    });

    it('fails every damaged case quickly (no hang)', () =>
    {
        const started = performance.now();
        for (let cutLength = 0; cutLength < sfnt.length; cutLength += 997)
        {
            expect(() => parseFont(sfnt.subarray(0, cutLength))).toThrow(FontError);
        }
        expect(performance.now() - started).toBeLessThan(2000);
    });
});
