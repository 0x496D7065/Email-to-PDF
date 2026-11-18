// The PDF syntax our writer emits, as small checked helpers: numbers, names,
// and text strings. Text that can come from email data is untrusted
// (README.md, rule R4): it only ever becomes a hex string <FEFF...>
// (UTF-16BE with a byte order mark), never a literal (...) string and never
// PDF syntax. Names come from our code only and are checked against a strict
// pattern. Pure (README.md, rule R7).
import { copyLayerCutIndex, copyLayerText } from './copy-layer-text';

/** The one error type the PDF writer throws. */
export class PdfWriteError extends Error
{
    override name = 'PdfWriteError';
}

export function throwWriteError(message: string): never
{
    throw new PdfWriteError(message);
}

/** Largest absolute number written (well inside every viewer's real range). */
export const MAX_NUMBER = 1e7;

/** Decimals kept in numbers: 1/1000 point is far below anything visible. */
const NUMBER_DECIMALS = 3;

/**
 * A PDF number: finite, at most 3 decimals, never exponent notation (which
 * PDF does not have: "1e-7" would be a syntax error), never "-0". Throws for
 * NaN, Infinity, or a magnitude above MAX_NUMBER.
 */
export function pdfNumber(value: number): string
{
    if (typeof value !== 'number' || !Number.isFinite(value))
    {
        throwWriteError(`not a finite number: ${String(value)}`);
    }
    if (Math.abs(value) > MAX_NUMBER)
    {
        throwWriteError(`number out of range: ${value}`);
    }
    let text = value.toFixed(NUMBER_DECIMALS);
    if (text.includes('.'))
    {
        text = text.replace(/0+$/, '').replace(/\.$/, '');
    }
    return text === '-0' ? '0' : text;
}

/** A non-negative integer (object numbers, lengths, counts, glyph ids). */
export function pdfInteger(value: number): string
{
    if (!Number.isSafeInteger(value) || value < 0)
    {
        throwWriteError(`not a non-negative integer: ${String(value)}`);
    }
    return String(value);
}

/** The only characters allowed in names (destinations, resources, fonts). */
const NAME_PATTERN = /^[A-Za-z0-9._-]{1,127}$/;

/** True for a string usable as a PDF name by our writer. */
export function isValidPdfName(value: string): boolean
{
    return typeof value === 'string' && NAME_PATTERN.test(value);
}

/** "/Name". Throws unless the name is 1 to 127 of A-Z a-z 0-9 . _ - */
export function pdfName(value: string): string
{
    if (!isValidPdfName(value))
    {
        throwWriteError(`invalid PDF name: ${JSON.stringify(String(value)).slice(0, 80)}`);
    }
    return `/${value}`;
}

/**
 * Most UTF-16 code units in one text string: Acrobat's limit is 32767 bytes
 * per string; with the 2-byte BOM and 2 bytes per unit, 16000 stays below.
 */
export const MAX_TEXT_UNITS = 16000;

const HEX_DIGITS = '0123456789ABCDEF';

/** Four hex digits of a 16-bit value. */
export function fourHexDigits(value: number): string
{
    return HEX_DIGITS[(value >> 12) & 15]! + HEX_DIGITS[(value >> 8) & 15]! + HEX_DIGITS[(value >> 4) & 15]! + HEX_DIGITS[value & 15]!;
}

/**
 * UTF-16BE hex digits of a text (no BOM, no brackets). A lone surrogate
 * becomes U+FFFD (it is not a character). Callers pass copy-layer text.
 */
export function utf16Hex(text: string): string
{
    const parts: string[] = [];
    for (const character of text)
    {
        const codePoint = character.codePointAt(0)!;
        if (codePoint >= 0xd800 && codePoint <= 0xdfff)
        {
            parts.push('FFFD');
        }
        else if (codePoint < 0x10000)
        {
            parts.push(fourHexDigits(codePoint));
        }
        else
        {
            parts.push(fourHexDigits(0xd800 + ((codePoint - 0x10000) >> 10)) + fourHexDigits(0xdc00 + ((codePoint - 0x10000) & 0x3ff)));
        }
    }
    return parts.join('');
}

/**
 * A text string as a hex string with BOM: <FEFF...>. A text longer than
 * MAX_TEXT_UNITS is cut and ends with U+2026 (...). The cut never splits a
 * surrogate pair, a kept flag or a ZWJ emoji sequence: it moves back to
 * before the whole sequence (copyLayerCutIndex). The cut piece is still put
 * through copyLayerText again, so the copy layer stays clean whatever the
 * input (README.md, rule R4). Cleaning never makes a text longer, so the
 * result stays within MAX_TEXT_UNITS.
 */
export function hexTextString(text: string): string
{
    let value = text;
    if (value.length > MAX_TEXT_UNITS)
    {
        value = copyLayerText(value.slice(0, copyLayerCutIndex(value, MAX_TEXT_UNITS - 1))) + '\u{2026}';
    }
    return `<FEFF${utf16Hex(value)}>`;
}

/** Bytes of a string of ASCII PDF syntax. Throws on anything else (defence in depth). */
export function asciiBytes(text: string): Uint8Array<ArrayBuffer>
{
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++)
    {
        const unit = text.charCodeAt(i);
        if (unit > 0x7e || (unit < 0x20 && unit !== 0x0a && unit !== 0x0d))
        {
            throwWriteError('PDF syntax must be printable ASCII');
        }
        bytes[i] = unit;
    }
    return bytes;
}
