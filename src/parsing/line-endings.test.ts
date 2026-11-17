import { describe, expect, it } from 'vitest';
import { toLfLineEndings } from './line-endings';

describe('toLfLineEndings', () =>
{
    it('turns CRLF, lone CR and mixed line ends into LF', () =>
    {
        expect(toLfLineEndings('a\r\nb')).toBe('a\nb');
        expect(toLfLineEndings('a\rb')).toBe('a\nb');
        expect(toLfLineEndings('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
    });

    it('keeps blank lines: CR CR LF is two line ends, LF CR is two too', () =>
    {
        expect(toLfLineEndings('a\r\r\nb')).toBe('a\n\nb');
        expect(toLfLineEndings('a\n\rb')).toBe('a\n\nb');
        expect(toLfLineEndings('a\r\rb')).toBe('a\n\nb');
    });

    it('handles a CR at the start or end', () =>
    {
        expect(toLfLineEndings('\ra')).toBe('\na');
        expect(toLfLineEndings('a\r')).toBe('a\n');
        expect(toLfLineEndings('\r')).toBe('\n');
    });

    it('changes nothing but CR', () =>
    {
        const text = 'Tab\there, NBSP\u00a0, LS\u2028, PS\u2029, VT\u000b, FF\u000c, NEL\u0085, emoji 😀\n';
        expect(toLfLineEndings(text)).toBe(text);
        expect(toLfLineEndings('')).toBe('');
        // Only the CRs go; U+2028 and NEL stay as they are.
        const withCr = 'x\r\ny\rz\u2028\u0085';
        expect(toLfLineEndings(withCr)).toBe('x\ny\nz\u2028\u0085');
    });
});
