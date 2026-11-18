import { describe, expect, it } from 'vitest';
import { allCodepageLabels, encodingForCodepage } from './codepage-encodings';

describe('encodingForCodepage', () =>
{
    it.each([
        [1252, 'windows-1252'],
        [1250, 'windows-1250'],
        [1251, 'windows-1251'],
        [28591, 'iso-8859-1'],
        [28605, 'iso-8859-15'],
        [20127, 'us-ascii'],
        [65001, 'utf-8'],
        [932, 'shift_jis'],
        [1200, 'utf-16le'],
        [1201, 'utf-16be'],
    ])('code page %i -> %s', (codepage, label) =>
    {
        expect(encodingForCodepage(codepage)).toBe(label);
    });

    it.each([undefined, 0, 65000, 99999, '1252', null])('unknown or unusable code page %s -> null', (codepage) =>
    {
        expect(encodingForCodepage(codepage)).toBeNull();
    });

    it('every label in the table is one TextDecoder accepts', () =>
    {
        for (const label of allCodepageLabels())
        {
            expect(() => new TextDecoder(label), label).not.toThrow();
        }
    });

    it('the UTF-16 code pages decode in the right byte order', () =>
    {
        const littleEndianText = new TextDecoder(encodingForCodepage(1200) ?? '').decode(Uint8Array.of(0x41, 0x00, 0xe9, 0x00));
        const bigEndianText = new TextDecoder(encodingForCodepage(1201) ?? '').decode(Uint8Array.of(0x00, 0x41, 0x00, 0xe9));
        expect(littleEndianText).toBe('Aé');
        expect(bigEndianText).toBe('Aé');
    });
});
