// The PDF syntax helpers: numbers never in exponent notation and never
// NaN / Infinity, strict names, text only as UTF-16BE hex (README.md, rule R4).
import { describe, expect, it } from 'vitest';
import { copyLayerText } from './copy-layer-text';
import { asciiBytes, hexTextString, MAX_TEXT_UNITS, pdfName, pdfNumber, PdfWriteError, utf16Hex } from './pdf-syntax';

describe('pdfNumber', () =>
{
    it.each([
        [0, '0'],
        [-0, '0'],
        [1, '1'],
        [1.5, '1.5'],
        [-2.25, '-2.25'],
        [1 / 3, '0.333'],
        [2 / 3, '0.667'],
        [1e-7, '0'],
        [-0.0004, '0'],
        [123456.7891, '123456.789'],
        [841.89, '841.89'],
        [1e7, '10000000'],
    ])('%s -> %s', (value, text) =>
    {
        expect(pdfNumber(value)).toBe(text);
    });

    it.each([NaN, Infinity, -Infinity, 1e8, -1e21, 1e300])('throws for %s', (value) =>
    {
        expect(() => pdfNumber(value)).toThrow(PdfWriteError);
    });

    it('never writes exponent notation', () =>
    {
        for (let exponent = -30; exponent <= 6; exponent++)
        {
            expect(pdfNumber(10 ** exponent)).not.toMatch(/e/i);
        }
    });
});

describe('pdfName', () =>
{
    it.each(['F1', 'email-1', 'a.b_c', 'IBMPlexSans-Bold', 'x'.repeat(127)])('accepts %s', (value) =>
    {
        expect(pdfName(value)).toBe(`/${value}`);
    });

    it.each(['', 'a b', 'a/b', 'a(b', 'a)b', 'a#41', 'a<b', 'a%b', '\u{E9}', 'x'.repeat(128), 'a\nb'])('rejects %j', (value) =>
    {
        expect(() => pdfName(value)).toThrow(PdfWriteError);
    });
});

describe('hexTextString', () =>
{
    it('writes UTF-16BE with a byte order mark', () =>
    {
        expect(hexTextString('A')).toBe('<FEFF0041>');
        expect(hexTextString('')).toBe('<FEFF>');
        expect(hexTextString('\u{E9}\u{20AC}')).toBe('<FEFF00E920AC>');
        expect(hexTextString('\u{1F600}')).toBe('<FEFFD83DDE00>');
    });

    it('writes a lone surrogate as U+FFFD', () =>
    {
        expect(hexTextString('\u{D800}x')).toBe('<FEFFFFFD0078>');
        expect(utf16Hex('\u{DC00}')).toBe('FFFD');
    });

    it('writes PDF delimiters as plain data', () =>
    {
        expect(hexTextString(')>> /JS (x)')).toBe('<FEFF' + utf16Hex(')>> /JS (x)') + '>');
        expect(hexTextString(')>> /JS (x)')).toMatch(/^<FEFF[0-9A-F]*>$/);
    });

    it('cuts a very long text with an ellipsis, never splitting a pair', () =>
    {
        const long = hexTextString('a'.repeat(MAX_TEXT_UNITS * 2));
        expect((long.length - 6) / 4).toBe(MAX_TEXT_UNITS);
        expect(long.endsWith('2026>')).toBe(true);
        const emoji = hexTextString('\u{1F600}'.repeat(MAX_TEXT_UNITS));
        expect(emoji.endsWith('DE002026>')).toBe(true);
        expect((emoji.length - 6) / 4).toBeLessThanOrEqual(MAX_TEXT_UNITS);
    });

    // The cut keeps MAX_TEXT_UNITS - 1 units, then adds the ellipsis.
    const KEPT_UNITS = MAX_TEXT_UNITS - 1;

    const ENGLAND_FLAG = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';

    it('moves a cut inside a kept flag back to before the flag', () =>
    {
        // U+1F3F4 and U+E0067 (4 units) would be the last ones before the cut.
        const text = 'a'.repeat(KEPT_UNITS - 4) + ENGLAND_FLAG + 'b'.repeat(20);
        expect(copyLayerText(text)).toBe(text); // the input is clean copy-layer text
        expect(decodeHex(hexTextString(text))).toBe('a'.repeat(KEPT_UNITS - 4) + '\u{2026}');
        // One unit short of the whole flag (13 of 14 units): still back to before it.
        const almost = 'a'.repeat(KEPT_UNITS - 13) + ENGLAND_FLAG + 'b'.repeat(20);
        expect(decodeHex(hexTextString(almost))).toBe('a'.repeat(KEPT_UNITS - 13) + '\u{2026}');
    });

    it('keeps a kept flag that ends exactly at the cut', () =>
    {
        const text = 'a'.repeat(KEPT_UNITS - 14) + ENGLAND_FLAG + 'b'.repeat(20);
        expect(decodeHex(hexTextString(text))).toBe('a'.repeat(KEPT_UNITS - 14) + ENGLAND_FLAG + '\u{2026}');
    });

    it('moves a cut right after a ZWJ back to before the whole sequence', () =>
    {
        const sequence = '\u{2764}\u{FE0F}\u{200D}\u{1F525}';
        // U+2764 U+FE0F U+200D (3 units) would be the last ones before the cut.
        const text = 'a'.repeat(KEPT_UNITS - 3) + sequence + 'b'.repeat(20);
        expect(copyLayerText(text)).toBe(text);
        expect(decodeHex(hexTextString(text))).toBe('a'.repeat(KEPT_UNITS - 3) + '\u{2026}');
    });

    it('moves any cut inside a ZWJ sequence back to before it, and keeps a whole one', () =>
    {
        const sequence = '\u{1F469}\u{200D}\u{2764}\u{FE0F}\u{200D}\u{1F468}'; // 8 units
        for (let inside = 1; inside < 8; inside++)
        {
            const text = 'a'.repeat(KEPT_UNITS - inside) + sequence + 'b'.repeat(20);
            expect(decodeHex(hexTextString(text))).toBe('a'.repeat(KEPT_UNITS - inside) + '\u{2026}');
        }
        const whole = 'a'.repeat(KEPT_UNITS - 8) + sequence + 'b'.repeat(20);
        expect(decodeHex(hexTextString(whole))).toBe('a'.repeat(KEPT_UNITS - 8) + sequence + '\u{2026}');
    });

    it('moves a cut inside a ZWJ sequence that starts with a skin-toned emoji back to its start', () =>
    {
        const sequence = '\u{1F469}\u{1F3FD}\u{200D}\u{1F4BB}'; // 7 units
        for (let inside = 1; inside < 7; inside++)
        {
            const text = 'a'.repeat(KEPT_UNITS - inside) + sequence + 'b'.repeat(20);
            expect(decodeHex(hexTextString(text))).toBe('a'.repeat(KEPT_UNITS - inside) + '\u{2026}');
        }
    });

    it('the cut piece is always copy-layer text and never holds part of a sequence', () =>
    {
        const tricky = ['\u{1F469}\u{1F3FD}\u{200D}\u{1F4BB}', '\u{2764}\u{FE0F}', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}'];
        for (const piece of tricky)
        {
            for (let shift = 0; shift < 16; shift++)
            {
                const cutText = decodeHex(hexTextString('a'.repeat(KEPT_UNITS - shift) + piece.repeat(12)));
                expect(cutText.length).toBeLessThanOrEqual(MAX_TEXT_UNITS);
                const body = cutText.slice(0, -1);
                expect(cutText.endsWith('\u{2026}')).toBe(true);
                expect(copyLayerText(body)).toBe(body);
                expect(body).not.toMatch(/\u{1F3F4}\u{FFFD}/u);
                expect(body.endsWith('\u{200D}')).toBe(false);
                if (piece !== tricky[1])
                {
                    // ZWJ sequence and flag: only whole copies are left.
                    const rest = body.slice(KEPT_UNITS - shift);
                    expect(rest).toBe(piece.repeat(rest.length / piece.length));
                }
            }
        }
    });
});

/** The text of a <FEFF...> hex string. */
function decodeHex(hex: string): string
{
    expect(hex).toMatch(/^<FEFF([0-9A-F]{4})*>$/);
    let text = '';
    for (let i = 5; i < hex.length - 1; i += 4)
    {
        text += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    }
    return text;
}

describe('asciiBytes', () =>
{
    it('refuses anything but printable ASCII and line ends', () =>
    {
        expect([...asciiBytes('BT\n')]).toEqual([66, 84, 10]);
        expect(() => asciiBytes('\u{E9}')).toThrow(PdfWriteError);
        expect(() => asciiBytes('\u{0}')).toThrow(PdfWriteError);
    });
});
