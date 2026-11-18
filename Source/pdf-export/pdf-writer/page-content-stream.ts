// One page's content stream: fills, then lines, then text, exactly as laid
// out (no layout decision here). Coordinates are converted from the layout's
// top-left origin to PDF's bottom-left one. Text is drawn by glyph id
// (Identity-H: 4 hex digits per glyph, so no email text is ever written as
// PDF syntax, README.md, rule R4); a run whose copy text differs from what
// ToUnicode yields gets a /Span with /ActualText (copy-layer-text.ts). Pure
// (README.md, rule R7).
import { copyLayerText } from './copy-layer-text';
import type { FontUsage } from './font-objects';
import { throwWriteError, fourHexDigits, hexTextString, pdfName, pdfNumber } from './pdf-syntax';
import type { LaidOutColor, LaidOutPage, LaidOutTextRun } from '../../../Header/laid-out-document';

/** Largest font size accepted, in points. */
export const MAX_FONT_SIZE = 1000;

/** A non-null object (the input may not match its type at run time). */
function isObject(value: unknown): boolean
{
    return typeof value === 'object' && value !== null;
}

function colorComponent(value: number, description: string): string
{
    if (typeof value !== 'number' || !(value >= 0 && value <= 1))
    {
        throwWriteError(`${description} must be between 0 and 1, not ${String(value)}`);
    }
    return pdfNumber(value);
}

/** The colour operator: "g" / "rg" for filling, "G" / "RG" for stroking. */
export function colorOperator(color: LaidOutColor, stroke: boolean): string
{
    if (typeof color === 'object' && color !== null && 'gray' in color)
    {
        return `${colorComponent(color.gray, 'grey level')} ${stroke ? 'G' : 'g'}`;
    }
    if (typeof color === 'object' && color !== null && 'rgb' in color && Array.isArray(color.rgb) && color.rgb.length === 3)
    {
        return `${color.rgb.map((component) => colorComponent(component, 'colour component')).join(' ')} ${stroke ? 'RG' : 'rg'}`;
    }
    throwWriteError('a colour must be { gray } or { rgb: [r, g, b] }');
}

/** The ActualText a run needs, in copy-layer form, or undefined when ToUnicode already gives its copy text. */
export function actualTextFor(run: LaidOutTextRun, usage: FontUsage): string | undefined
{
    if (run.actualText !== undefined)
    {
        return copyLayerText(run.actualText);
    }
    const copyText = copyLayerText(run.copyText);
    return copyText === usage.toUnicodeTextOf(run.glyphs) ? undefined : copyText;
}

/**
 * The content stream of one page (ASCII). `usageOf` gives each font's usage
 * (already filled from every run of the document, so ToUnicode is final).
 */
export function pageContentStream(page: LaidOutPage, pageHeight: number, usageOf: (run: LaidOutTextRun) => FontUsage): string
{
    const operations: string[] = [];
    let currentFill = '';
    let currentStroke = '';
    let currentLineWidth = '';
    const setFill = (color: LaidOutColor): void =>
    {
        const operator = colorOperator(color, false);
        if (operator !== currentFill)
        {
            operations.push(operator);
        }
        currentFill = operator;
    };

    for (const rect of page.fills)
    {
        if (!isObject(rect))
        {
            throwWriteError('a fill must be an object');
        }
        setFill(rect.color);
        operations.push(
            `${pdfNumber(rect.x)} ${pdfNumber(pageHeight - rect.y - rect.height)} ${pdfNumber(rect.width)} ${pdfNumber(rect.height)} re f`);
    }
    for (const line of page.lines)
    {
        if (!isObject(line))
        {
            throwWriteError('a line must be an object');
        }
        const operator = colorOperator(line.color, true);
        if (operator !== currentStroke)
        {
            operations.push(operator);
        }
        currentStroke = operator;
        if (!(line.width >= 0))
        {
            throwWriteError(`line width must be 0 or more, not ${String(line.width)}`);
        }
        const widthOperator = `${pdfNumber(line.width)} w`;
        if (widthOperator !== currentLineWidth)
        {
            operations.push(widthOperator);
        }
        currentLineWidth = widthOperator;
        operations.push(`${pdfNumber(line.x1)} ${pdfNumber(pageHeight - line.y1)} m ${pdfNumber(line.x2)} ${pdfNumber(pageHeight - line.y2)} l S`);
    }

    let currentFont = '';
    let inTextObject = false;
    for (const run of page.text)
    {
        if (run.glyphs.length === 0)
        {
            continue; // nothing drawn, nothing to copy
        }
        const usage = usageOf(run);
        if (!(run.size > 0 && run.size <= MAX_FONT_SIZE))
        {
            throwWriteError(`font size must be above 0 and at most ${MAX_FONT_SIZE}, not ${String(run.size)}`);
        }
        if (!inTextObject)
        {
            operations.push('BT');
        }
        inTextObject = true;
        const actualText = actualTextFor(run, usage);
        if (actualText !== undefined)
        {
            operations.push(`/Span << /ActualText ${hexTextString(actualText)} >> BDC`);
        }
        const fontOperator = `${pdfName(usage.resourceName)} ${pdfNumber(run.size)} Tf`;
        if (fontOperator !== currentFont)
        {
            operations.push(fontOperator);
        }
        currentFont = fontOperator;
        setFill(run.color);
        operations.push(`1 0 0 1 ${pdfNumber(run.x)} ${pdfNumber(pageHeight - run.y)} Tm`);
        let glyphHex = '';
        for (const glyph of run.glyphs)
        {
            glyphHex += fourHexDigits(glyph);
        }
        operations.push(`<${glyphHex}> Tj`);
        if (actualText !== undefined)
        {
            operations.push('EMC');
        }
    }
    if (inTextObject)
    {
        operations.push('ET');
    }
    operations.push('');
    return operations.join('\n');
}
