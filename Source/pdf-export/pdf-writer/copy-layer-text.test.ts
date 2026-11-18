// copyLayerText: the copy layer's rules for the three groups of
// Source/pdf-export/pdf-text-transforms.ts (README.md, rule R4: nothing that can hide or reorder
// text reaches the PDF's copy layer). Special characters are written as
// braced escapes, so this file stays ASCII.
import { describe, expect, it } from 'vitest';
import { DRAWN_AS_NOTHING, isDrawnAsNothing } from '../pdf-text-transforms';
import { copyLayerCutIndex, copyLayerText, isGroup1 } from './copy-layer-text';

const FFFD = '\u{FFFD}';
const tags = (letters: string): string => [...letters].map((letter) => String.fromCodePoint(0xe0000 + letter.charCodeAt(0))).join('');
const tagFlag = (letters: string): string => `\u{1F3F4}${tags(letters)}\u{E007F}`;

describe('copyLayerText', () =>
{
    it.each([
        ['plain text', 'Alice Example', 'Alice Example'],
        [
            'accents and punctuation',
            '\u{E9} \u{E7} \u{DF} \u{153} \u{20AC} \u{201C} \u{201D} \u{AB} \u{BB} \u{2013} \u{2026} \u{142} \u{151}',
            '\u{E9} \u{E7} \u{DF} \u{153} \u{20AC} \u{201C} \u{201D} \u{AB} \u{BB} \u{2013} \u{2026} \u{142} \u{151}',
        ],
        ['a combining mark stays a separate code point', 'e\u{301}', 'e\u{301}'],
        ['soft hyphen dropped (not seen; at a line break the layout gives "-")', 'mes\u{AD}sage', 'message'],
        ['two soft hyphens dropped', '\u{AD}a\u{AD}\u{AD}b\u{AD}', 'ab'],
        ['VS16 after a soft hyphen dropped', 'a\u{AD}\u{FE0F}b', 'ab'],
        ['a plain hyphen kept', 'well-known', 'well-known'],
        ['emoji kept', '\u{1F600}', '\u{1F600}'],
        ['U+FFFD kept', FFFD, FFFD],
        ['ZWSP dropped', 'a\u{200B}b', 'ab'],
        ['ZWNJ dropped', 'a\u{200C}b', 'ab'],
        ['LRM, RLM, ALM dropped', '\u{200E}a\u{200F}b\u{61C}', 'ab'],
        ['BOM inside text dropped', 'a\u{FEFF}b', 'ab'],
        ['CGJ and U+2060 to U+2064 dropped', 'a\u{34F}\u{2060}\u{2061}\u{2062}\u{2063}\u{2064}b', 'ab'],
        ['VS16 after an emoji kept', '\u{2764}\u{FE0F}', '\u{2764}\u{FE0F}'],
        ['VS15 after a character kept', '\u{263A}\u{FE0E}', '\u{263A}\u{FE0E}'],
        ['stray VS16 at the start dropped', '\u{FE0F}a', 'a'],
        ['two VS16 in a row: only the first kept', '\u{2764}\u{FE0F}\u{FE0F}', '\u{2764}\u{FE0F}'],
        ['VS15 then VS16: only the first kept', '\u{2764}\u{FE0E}\u{FE0F}', '\u{2764}\u{FE0E}'],
        ['VS after ZWSP dropped', 'a\u{200B}\u{FE0F}', 'a'],
        ['other variation selectors dropped', 'a\u{FE00}b\u{E0100}c\u{E01EF}', 'abc'],
        ['ZWJ sequence kept', '\u{1F469}\u{200D}\u{1F4BB}', '\u{1F469}\u{200D}\u{1F4BB}'],
        ['ZWJ after a skin tone kept', '\u{1F469}\u{1F3FD}\u{200D}\u{1F4BB}', '\u{1F469}\u{1F3FD}\u{200D}\u{1F4BB}'],
        ['ZWJ after emoji + VS16 kept', '\u{2764}\u{FE0F}\u{200D}\u{1F525}', '\u{2764}\u{FE0F}\u{200D}\u{1F525}'],
        ['ZWJ between letters dropped', 'a\u{200D}b', 'ab'],
        ['ZWJ from emoji to letter dropped', '\u{1F469}\u{200D}b', '\u{1F469}b'],
        ['ZWJ from letter to emoji dropped', 'a\u{200D}\u{1F4BB}', 'a\u{1F4BB}'],
        ['ZWJ at the end dropped', '\u{1F469}\u{200D}', '\u{1F469}'],
        ['two ZWJ in a row both dropped', '\u{1F469}\u{200D}\u{200D}\u{1F4BB}', '\u{1F469}\u{1F4BB}'],
        ['England flag kept whole', tagFlag('gbeng'), tagFlag('gbeng')],
        ['Scotland flag kept whole', tagFlag('gbsct'), tagFlag('gbsct')],
        ['Wales flag kept whole', tagFlag('gbwls'), tagFlag('gbwls')],
        ['flag in text', `x${tagFlag('gbeng')}y`, `x${tagFlag('gbeng')}y`],
        ['another subdivision: tags replaced', tagFlag('gbfoo'), `\u{1F3F4}${FFFD.repeat(6)}`],
        ['upper case tags replaced', tagFlag('GBENG'), `\u{1F3F4}${FFFD.repeat(6)}`],
        ['tags without the black flag replaced', `x${tags('gbeng')}\u{E007F}`, `x${FFFD.repeat(6)}`],
        ['flag without cancel tag: tags replaced', `\u{1F3F4}${tags('gbeng')}`, `\u{1F3F4}${FFFD.repeat(5)}`],
        ['VS16 after a kept flag dropped', `${tagFlag('gbeng')}\u{FE0F}`, tagFlag('gbeng')],
        // U+10067... minus the tag base wraps around to "gbeng" in fromCharCode: only real tags spell a flag.
        [
            'non-tag code points that wrap around to "gbeng" are not a flag',
            '\u{1F3F4}\u{10067}\u{10062}\u{10065}\u{1006E}\u{10067}\u{E007F}',
            '\u{1F3F4}\u{10067}\u{10062}\u{10065}\u{1006E}\u{10067}\u{FFFD}',
        ],
    ])('%s', (_label, input, expected) =>
    {
        expect(copyLayerText(input)).toBe(expected);
    });

    it.each([
        ['NUL', '\u{0}'],
        ['BEL', '\u{7}'],
        ['tab', '\t'],
        ['LF', '\n'],
        ['CR', '\r'],
        ['DEL', '\u{7F}'],
        ['NEL', '\u{85}'],
        ['U+2028', '\u{2028}'],
        ['RLO', '\u{202E}'],
        ['LRI', '\u{2066}'],
        ['interlinear annotation', '\u{FFF9}'],
        ['noncharacter U+FDD0', '\u{FDD0}'],
        ['noncharacter U+FFFE', '\u{FFFE}'],
        ['noncharacter U+1FFFF', '\u{1FFFF}'],
        ['lone high surrogate', '\u{D83D}'],
        ['lone low surrogate', '\u{DE00}'],
        ['language tag U+E0001', '\u{E0001}'],
    ])('group 1 (%s) becomes U+FFFD', (_label, character) =>
    {
        expect(copyLayerText(`a${character}b`)).toBe(`a${FFFD}b`);
    });

    it('keeps a valid surrogate pair', () =>
    {
        expect(copyLayerText('\u{D83D}\u{DE00}')).toBe('\u{1F600}');
    });

    it('handles long text', () =>
    {
        const long = 'Alice '.repeat(10_000);
        expect(copyLayerText(long)).toBe(long);
    });

    // Random strings from a pool of tricky code points (fixed seed): the
    // output never holds group 1 or a soft hyphen, and holds group 2 only as
    // emoji parts.
    it('never lets group 1 or a soft hyphen through, and group 2 only as emoji parts (fuzz)', () =>
    {
        const pool = [
            0x41, 0x65, 0x301, 0x20, 0x1f469, 0x1f4bb, 0x2764, 0x1f3fd, 0x1f3f4, 0x200d, 0xfe0f, 0xfe0e, 0xfe00, 0x200b, 0x200e, 0xfeff,
            0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe007f, 0xe0041, 0x0, 0x9, 0x202e, 0xd800, 0xdc00, 0xfffe, 0xad, 0x34f,
        ];
        let seed = 12345;
        const random = (n: number): number =>
        {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed % n;
        };
        for (let round = 0; round < 3000; round++)
        {
            let input = '';
            const length = 1 + random(12);
            for (let i = 0; i < length; i++)
            {
                input += String.fromCharCode(...codeUnitsOf(pool[random(pool.length)]!));
            }
            // Sometimes a whole kept flag.
            if (random(5) === 0)
            {
                input += tagFlag('gbeng');
            }
            const output = copyLayerText(input);
            const codePoints = [...output].map((character) => character.codePointAt(0)!);
            for (const [position, codePoint] of codePoints.entries())
            {
                if (codePoint >= 0xe0000 && codePoint <= 0xe007f)
                {
                    // Only the tags of a kept flag: U+1F3F4 at most 6 code points before.
                    expect(codePoint).toBeGreaterThanOrEqual(0xe0020);
                    expect(codePoints.slice(Math.max(0, position - 6), position).includes(0x1f3f4)).toBe(true);
                    continue;
                }
                expect(isGroup1(codePoint)).toBe(false);
                expect(codePoint).not.toBe(0xad);
                if (codePoint === 0x200d || codePoint === 0xfe0e || codePoint === 0xfe0f)
                {
                    continue;
                }
                expect(isDrawnAsNothing(codePoint)).toBe(false);
            }
            // Stable: the copy layer of copy-layer text is itself.
            expect(copyLayerText(output)).toBe(output);
        }
    });

    it('every DRAWN_AS_NOTHING range is dropped when alone between letters (VS15 / VS16 aside)', () =>
    {
        for (const [from, to] of DRAWN_AS_NOTHING)
        {
            for (const codePoint of [from, to].filter((rangeEnd) => rangeEnd !== 0xfe0e && rangeEnd !== 0xfe0f))
            {
                expect(copyLayerText(`a${String.fromCodePoint(codePoint)}b`)).toMatch(/^a(\u{FFFD})?b$/u);
            }
        }
    });
});

/** UTF-16 code units of a code point, or of a lone surrogate as itself. */
function codeUnitsOf(codePoint: number): number[]
{
    if (codePoint < 0x10000)
    {
        return [codePoint];
    }
    return [0xd800 + ((codePoint - 0x10000) >> 10), 0xdc00 + ((codePoint - 0x10000) & 0x3ff)];
}

describe('copyLayerCutIndex', () =>
{
    it('keeps a short text whole', () =>
    {
        expect(copyLayerCutIndex('abc', 3)).toBe(3);
        expect(copyLayerCutIndex('', 0)).toBe(0);
    });

    it('cuts plain text at the limit, but never inside a surrogate pair', () =>
    {
        expect(copyLayerCutIndex('abcdef', 4)).toBe(4);
        expect(copyLayerCutIndex('abc\u{1F600}x', 4)).toBe(3);
    });

    it('moves back to the start of a whole ZWJ chain, across several ZWJs', () =>
    {
        const family = '\u{1F468}\u{200D}\u{1F469}\u{200D}\u{1F467}\u{200D}\u{1F466}'; // 11 units
        for (let limit = 3; limit < 13; limit++)
        {
            expect(copyLayerCutIndex('ab' + family + 'cd', limit)).toBe(2);
        }
        expect(copyLayerCutIndex('ab' + family + 'cd', 13)).toBe(13);
    });

    it('moves back to before a kept flag, and before a ZWJ chain the flag ends', () =>
    {
        expect(copyLayerCutIndex('ab' + tagFlag('gbeng') + 'cd', 10)).toBe(2);
        expect(copyLayerCutIndex('ab' + tagFlag('gbeng') + 'cd', 16)).toBe(16);
        // A ZWJ before the flag joins it to the emoji before (both are emoji).
        expect(copyLayerCutIndex('ab\u{1F600}\u{200D}' + tagFlag('gbeng') + 'cd', 10)).toBe(2);
    });

    it('leaves a ZWJ that the copy layer drops alone (not between two emoji)', () =>
    {
        expect(copyLayerCutIndex('ab\u{200D}cdef', 4)).toBe(4);
    });
});
