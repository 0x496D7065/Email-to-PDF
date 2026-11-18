// The PDF syntax helpers: numbers never in exponent notation and never
// NaN / Infinity, strict names, text only as UTF-16BE hex (README.md, rule R4).
import { describe, expect, it } from 'vitest';
import { copyLayerText } from './copy-layer-text';
import { ascii, hexText, MAX_TEXT_UNITS, name, num, PdfWriteError, utf16Hex } from './pdf-syntax';

describe('num', () =>
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
        expect(num(value)).toBe(text);
    });

    it.each([NaN, Infinity, -Infinity, 1e8, -1e21, 1e300])('throws for %s', (value) =>
    {
        expect(() => num(value)).toThrow(PdfWriteError);
    });

    it('never writes exponent notation', () =>
    {
        for (let e = -30; e <= 6; e++)
        {
            expect(num(10 ** e)).not.toMatch(/e/i);
        }
    });
});

describe('name', () =>
{
    it.each(['F1', 'email-1', 'a.b_c', 'IBMPlexSans-Bold', 'x'.repeat(127)])('accepts %s', (value) =>
    {
        expect(name(value)).toBe(`/${value}`);
    });

    it.each(['', 'a b', 'a/b', 'a(b', 'a)b', 'a#41', 'a<b', 'a%b', '\u{E9}', 'x'.repeat(128), 'a\nb'])('rejects %j', (value) =>
    {
        expect(() => name(value)).toThrow(PdfWriteError);
    });
});

describe('hexText', () =>
{
    it('writes UTF-16BE with a byte order mark', () =>
    {
        expect(hexText('A')).toBe('<FEFF0041>');
        expect(hexText('')).toBe('<FEFF>');
        expect(hexText('\u{E9}\u{20AC}')).toBe('<FEFF00E920AC>');
        expect(hexText('\u{1F600}')).toBe('<FEFFD83DDE00>');
    });

    it('writes a lone surrogate as U+FFFD', () =>
    {
        expect(hexText('\u{D800}x')).toBe('<FEFFFFFD0078>');
        expect(utf16Hex('\u{DC00}')).toBe('FFFD');
    });

    it('writes PDF delimiters as plain data', () =>
    {
        expect(hexText(')>> /JS (x)')).toBe('<FEFF' + utf16Hex(')>> /JS (x)') + '>');
        expect(hexText(')>> /JS (x)')).toMatch(/^<FEFF[0-9A-F]*>$/);
    });

    it('cuts a very long text with an ellipsis, never splitting a pair', () =>
    {
        const long = hexText('a'.repeat(MAX_TEXT_UNITS * 2));
        expect((long.length - 6) / 4).toBe(MAX_TEXT_UNITS);
        expect(long.endsWith('2026>')).toBe(true);
        const emoji = hexText('\u{1F600}'.repeat(MAX_TEXT_UNITS));
        expect(emoji.endsWith('DE002026>')).toBe(true);
        expect((emoji.length - 6) / 4).toBeLessThanOrEqual(MAX_TEXT_UNITS);
    });

    // The cut keeps MAX_TEXT_UNITS - 1 units, then adds the ellipsis.
    const KEPT = MAX_TEXT_UNITS - 1;

    const FLAG = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';

    it('moves a cut inside a kept flag back to before the flag', () =>
    {
        // U+1F3F4 and U+E0067 (4 units) would be the last ones before the cut.
        const text = 'a'.repeat(KEPT - 4) + FLAG + 'b'.repeat(20);
        expect(copyLayerText(text)).toBe(text); // the input is clean copy-layer text
        expect(decodeHex(hexText(text))).toBe('a'.repeat(KEPT - 4) + '\u{2026}');
        // One unit short of the whole flag (13 of 14 units): still back to before it.
        const almost = 'a'.repeat(KEPT - 13) + FLAG + 'b'.repeat(20);
        expect(decodeHex(hexText(almost))).toBe('a'.repeat(KEPT - 13) + '\u{2026}');
    });

    it('keeps a kept flag that ends exactly at the cut', () =>
    {
        const text = 'a'.repeat(KEPT - 14) + FLAG + 'b'.repeat(20);
        expect(decodeHex(hexText(text))).toBe('a'.repeat(KEPT - 14) + FLAG + '\u{2026}');
    });

    it('moves a cut right after a ZWJ back to before the whole sequence', () =>
    {
        const sequence = '\u{2764}\u{FE0F}\u{200D}\u{1F525}';
        // U+2764 U+FE0F U+200D (3 units) would be the last ones before the cut.
        const text = 'a'.repeat(KEPT - 3) + sequence + 'b'.repeat(20);
        expect(copyLayerText(text)).toBe(text);
        expect(decodeHex(hexText(text))).toBe('a'.repeat(KEPT - 3) + '\u{2026}');
    });

    it('moves any cut inside a ZWJ sequence back to before it, and keeps a whole one', () =>
    {
        const sequence = '\u{1F469}\u{200D}\u{2764}\u{FE0F}\u{200D}\u{1F468}'; // 8 units
        for (let inside = 1; inside < 8; inside++)
        {
            const text = 'a'.repeat(KEPT - inside) + sequence + 'b'.repeat(20);
            expect(decodeHex(hexText(text))).toBe('a'.repeat(KEPT - inside) + '\u{2026}');
        }
        const whole = 'a'.repeat(KEPT - 8) + sequence + 'b'.repeat(20);
        expect(decodeHex(hexText(whole))).toBe('a'.repeat(KEPT - 8) + sequence + '\u{2026}');
    });

    it('moves a cut inside a ZWJ sequence that starts with a skin-toned emoji back to its start', () =>
    {
        const sequence = '\u{1F469}\u{1F3FD}\u{200D}\u{1F4BB}'; // 7 units
        for (let inside = 1; inside < 7; inside++)
        {
            const text = 'a'.repeat(KEPT - inside) + sequence + 'b'.repeat(20);
            expect(decodeHex(hexText(text))).toBe('a'.repeat(KEPT - inside) + '\u{2026}');
        }
    });

    it('the cut piece is always copy-layer text and never holds part of a sequence', () =>
    {
        const tricky = ['\u{1F469}\u{1F3FD}\u{200D}\u{1F4BB}', '\u{2764}\u{FE0F}', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}'];
        for (const piece of tricky)
        {
            for (let shift = 0; shift < 16; shift++)
            {
                const cut = decodeHex(hexText('a'.repeat(KEPT - shift) + piece.repeat(12)));
                expect(cut.length).toBeLessThanOrEqual(MAX_TEXT_UNITS);
                const body = cut.slice(0, -1);
                expect(cut.endsWith('\u{2026}')).toBe(true);
                expect(copyLayerText(body)).toBe(body);
                expect(body).not.toMatch(/\u{1F3F4}\u{FFFD}/u);
                expect(body.endsWith('\u{200D}')).toBe(false);
                if (piece !== tricky[1])
                {
                    // ZWJ sequence and flag: only whole copies are left.
                    const rest = body.slice(KEPT - shift);
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

describe('ascii', () =>
{
    it('refuses anything but printable ASCII and line ends', () =>
    {
        expect([...ascii('BT\n')]).toEqual([66, 84, 10]);
        expect(() => ascii('\u{E9}')).toThrow(PdfWriteError);
        expect(() => ascii('\u{0}')).toThrow(PdfWriteError);
    });
});
