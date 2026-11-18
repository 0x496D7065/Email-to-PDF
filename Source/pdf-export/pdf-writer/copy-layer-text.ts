// The copy layer: the text a PDF reader gets when copying or searching
// ("what you can copy is what you see"). Used by the layout to build each
// run's copy text, and enforced again by the backend on every ToUnicode
// entry, /ActualText and bookmark title it writes (defence in depth).
//
// The contract with the renderer (Source/pdf-export/text.ts) has three groups of
// special characters. Here:
// - group 1 (controls, bidi controls, noncharacters, lone surrogates, tag
//   characters outside the three kept flags...) never reaches the backend;
//   if it does anyway, each code point (each code unit for a lone
//   surrogate) becomes U+FFFD, so nothing that could hide or reorder text
//   is ever written. Tags outside a kept flag count as group 1 here, as in
//   text.ts ("any other tag run is coded in full");
// - group 2 (DRAWN_AS_NOTHING: ZWSP, ZWNJ, ZWJ, LRM / RLM / ALM, CGJ,
//   U+2060 to U+2064, BOM, variation selectors, tags) is dropped, EXCEPT
//   the parts of emoji:
//   * ZWJ U+200D between two emoji (the code point before it, skipping one
//     VS16 and one skin tone modifier, and the one after it are
//     Extended_Pictographic),
//   * one VS15 / VS16 (U+FE0E / U+FE0F) right after an ordinary character
//     (not after another variation selector, any group 2 character or a
//     soft hyphen),
//   * the tags of exactly the three kept flags (KEPT_FLAG_TAGS), with their
//     U+1F3F4 and U+E007F;
// - group 3 (soft hyphen U+00AD) is dropped: it is drawn only where the
//   line breaks at it, and there the layout already gives "-" as the copy
//   text, so a soft hyphen that reaches this point is one that is not seen;
// - every other character is kept as it is. Combining marks stay separate
//   code points ("e" + U+0301).
//
// The neighbours looked at are those in the INPUT, so the result never
// depends on what was dropped. Pure (README.md, rule R7).
import { isDrawnAsNothing, KEPT_FLAG_TAGS, SOFT_HYPHEN } from '../text';

const REPLACEMENT_CHARACTER = 0xfffd;
const ZWJ = 0x200d;
const VS15 = 0xfe0e;
const VS16 = 0xfe0f;
const BLACK_FLAG = 0x1f3f4;
const TAG_BASE = 0xe0000;
const CANCEL_TAG = 0xe007f;

const PICTOGRAPHIC_PATTERN = /^\p{Extended_Pictographic}$/u;

function isPictographic(codePoint: number | undefined): boolean
{
    return codePoint !== undefined && codePoint <= 0x10ffff && PICTOGRAPHIC_PATTERN.test(String.fromCodePoint(codePoint));
}

const isSkinTone = (codePoint: number | undefined): boolean => codePoint !== undefined && codePoint >= 0x1f3fb && codePoint <= 0x1f3ff;

/** Group 1 of the contract in Source/pdf-export/text.ts, for one code point (or one lone surrogate code unit). */
export function isGroup1(codePoint: number): boolean
{
    if (codePoint < 0x20)
    {
        return true;
    }
    if (codePoint >= 0x7f && codePoint <= 0x9f)
    {
        return true;
    }
    if (codePoint === 0x2028 || codePoint === 0x2029)
    {
        return true;
    }
    if ((codePoint >= 0x202a && codePoint <= 0x202e) || (codePoint >= 0x2066 && codePoint <= 0x2069))
    {
        return true;
    }
    if (codePoint >= 0xfdd0 && codePoint <= 0xfdef)
    {
        return true;
    }
    if (codePoint >= 0xfff9 && codePoint <= 0xfffb)
    {
        return true;
    }
    if ((codePoint & 0xfffe) === 0xfffe)
    {
        return true; // U+nFFFE, U+nFFFF in every plane
    }
    if (codePoint >= 0xd800 && codePoint <= 0xdfff)
    {
        return true; // only lone ones get here
    }
    if (codePoint >= TAG_BASE && codePoint <= CANCEL_TAG)
    {
        return true; // outside a kept flag
    }
    return false;
}

/** The code points of a text; a lone surrogate comes out as its own code unit value. */
function codePointsOf(text: string): number[]
{
    const result: number[] = [];
    for (const character of text)
    {
        result.push(character.codePointAt(0)!);
    }
    return result;
}

/** Length of the kept flag starting at `start` (7 code points), or 0. */
function keptFlagLengthAt(codePoints: readonly number[], start: number): number
{
    if (codePoints[start] !== BLACK_FLAG || codePoints[start + 6] !== CANCEL_TAG)
    {
        return 0;
    }
    let tagLetters = '';
    for (let position = start + 1; position < start + 6; position++)
    {
        const codePoint = codePoints[position];
        if (codePoint === undefined || codePoint < TAG_BASE + 0x61 || codePoint > TAG_BASE + 0x7a)
        {
            return 0;
        }
        tagLetters += String.fromCharCode(codePoint - TAG_BASE);
    }
    return KEPT_FLAG_TAGS.includes(tagLetters) ? 7 : 0;
}

/** An ordinary character: one a variation selector may follow (not a soft hyphen, which is dropped). */
function isOrdinary(codePoint: number | undefined): boolean
{
    return codePoint !== undefined && !isGroup1(codePoint) && !isDrawnAsNothing(codePoint) && codePoint !== SOFT_HYPHEN;
}

/** Is the code point before index `position` the end of an emoji (skipping one VS16, then one skin tone)? */
function emojiEndsBefore(codePoints: readonly number[], position: number): boolean
{
    let last = position - 1;
    if (codePoints[last] === VS16)
    {
        last--;
    }
    if (isSkinTone(codePoints[last]))
    {
        return true;
    }
    return isPictographic(codePoints[last]);
}

/** Is the code point at `position` a ZWJ the copy layer keeps (between two emoji)? */
function isKeptZwj(codePoints: readonly number[], position: number): boolean
{
    return codePoints[position] === ZWJ && emojiEndsBefore(codePoints, position) && isPictographic(codePoints[position + 1]);
}

/** Start of the emoji right before the ZWJ at `zwjPosition` (base, then one skin tone, then one VS16). */
function emojiStartBefore(codePoints: readonly number[], zwjPosition: number): number
{
    let start = zwjPosition - 1;
    if (codePoints[start] === VS16)
    {
        start--;
    }
    if (isSkinTone(codePoints[start]) && isPictographic(codePoints[start - 1]))
    {
        start--;
    }
    return start;
}

/** End (exclusive) of the emoji right after the ZWJ at `zwjPosition` (base, then one skin tone, then one VS16). */
function emojiEndAfter(codePoints: readonly number[], zwjPosition: number): number
{
    let end = zwjPosition + 2;
    if (isSkinTone(codePoints[end]))
    {
        end++;
    }
    if (codePoints[end] === VS16)
    {
        end++;
    }
    return end;
}

/**
 * Where to cut a text to at most `maxUnits` UTF-16 code units, as a code
 * unit index: never inside a surrogate pair, and never inside a kept flag
 * or a ZWJ emoji sequence (the cut then moves back to the start of that
 * sequence, so no part of one is left behind).
 */
export function copyLayerCutIndex(text: string, maxUnits: number): number
{
    if (text.length <= maxUnits)
    {
        return text.length;
    }
    // A window a little past the limit is enough to see every sequence around it.
    const codePoints = codePointsOf(text.slice(0, maxUnits + 32));
    const codeUnitCount = (codePoint: number): number => (codePoint > 0xffff ? 2 : 1);
    let cutPosition = 0;
    let unitCount = 0;
    while (cutPosition < codePoints.length && unitCount + codeUnitCount(codePoints[cutPosition]!) <= maxUnits)
    {
        unitCount += codeUnitCount(codePoints[cutPosition++]!);
    }

    // Inside a kept flag (7 code points): back to its U+1F3F4.
    for (let flagStart = Math.max(0, cutPosition - 6); flagStart < cutPosition; flagStart++)
    {
        if (keptFlagLengthAt(codePoints, flagStart) > 0)
        {
            cutPosition = flagStart;
            break;
        }
    }
    // Inside a ZWJ sequence: back to the start of its first emoji.
    for (let zwjPosition = Math.max(0, cutPosition - 4); zwjPosition <= cutPosition + 3; zwjPosition++)
    {
        if (isKeptZwj(codePoints, zwjPosition) && emojiStartBefore(codePoints, zwjPosition) < cutPosition &&
            cutPosition < emojiEndAfter(codePoints, zwjPosition))
        {
            let sequenceStart = emojiStartBefore(codePoints, zwjPosition);
            while (isKeptZwj(codePoints, sequenceStart - 1))
            {
                sequenceStart = emojiStartBefore(codePoints, sequenceStart - 1);
            }
            cutPosition = sequenceStart;
            break;
        }
    }

    let unitIndex = 0;
    for (let position = 0; position < cutPosition; position++)
    {
        unitIndex += codeUnitCount(codePoints[position]!);
    }
    return unitIndex;
}

/** The copy-layer form of a text (see the top of this file). Never throws. */
export function copyLayerText(text: string): string
{
    const codePoints = codePointsOf(text);
    const kept: number[] = [];
    for (let position = 0; position < codePoints.length; position++)
    {
        const codePoint = codePoints[position]!;
        const flagLength = keptFlagLengthAt(codePoints, position);
        if (flagLength > 0)
        {
            kept.push(...codePoints.slice(position, position + flagLength));
            position += flagLength - 1;
            continue;
        }
        if (isGroup1(codePoint))
        {
            kept.push(REPLACEMENT_CHARACTER);
        }
        else if (codePoint === ZWJ)
        {
            if (isKeptZwj(codePoints, position))
            {
                kept.push(codePoint);
            }
        }
        else if (codePoint === VS15 || codePoint === VS16)
        {
            if (isOrdinary(codePoints[position - 1]))
            {
                kept.push(codePoint);
            }
        }
        else if (!isDrawnAsNothing(codePoint) && codePoint !== SOFT_HYPHEN)
        {
            kept.push(codePoint);
        }
    }
    let result = '';
    // In slices, so a long text never exceeds the argument limit.
    for (let sliceStart = 0; sliceStart < kept.length; sliceStart += 4096)
    {
        result += String.fromCodePoint(...kept.slice(sliceStart, sliceStart + 4096));
    }
    return result;
}
