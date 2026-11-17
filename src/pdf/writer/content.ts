// One page's content stream: fills, then lines, then text, exactly as laid
// out (no layout decision here). Coordinates are converted from the layout's
// top-left origin to PDF's bottom-left one. Text is drawn by glyph id
// (Identity-H: 4 hex digits per glyph, so no email text is ever written as
// PDF syntax, README.md, rule R4); a run whose copy text differs from what
// ToUnicode yields gets a /Span with /ActualText (copy-text.ts). Pure
// (README.md, rule R7).
import { copyLayerText } from './copy-text';
import type { FontUsage } from './font-objects';
import type { LaidOutColor, LaidOutPage, LaidOutTextRun } from './layout';
import { fail, hex4, hexText, name, num } from './syntax';

/** Largest font size accepted, in points. */
export const MAX_FONT_SIZE = 1000;

/** A non-null object (the input may not match its type at run time). */
function isObject(value: unknown): boolean
{
    return typeof value === 'object' && value !== null;
}

function unit(value: number, what: string): string
{
    if (typeof value !== 'number' || !(value >= 0 && value <= 1)) fail(`${what} must be between 0 and 1, not ${String(value)}`);
    return num(value);
}

/** The colour operator: "g" / "rg" for filling, "G" / "RG" for stroking. */
export function colorOperator(color: LaidOutColor, stroke: boolean): string
{
    if (typeof color === 'object' && color !== null && 'gray' in color)
    {
        return `${unit(color.gray, 'grey level')} ${stroke ? 'G' : 'g'}`;
    }
    if (typeof color === 'object' && color !== null && 'rgb' in color && Array.isArray(color.rgb) && color.rgb.length === 3)
    {
        return `${color.rgb.map((c) => unit(c, 'colour component')).join(' ')} ${stroke ? 'RG' : 'rg'}`;
    }
    fail('a colour must be { gray } or { rgb: [r, g, b] }');
}

/** The ActualText a run needs, in copy-layer form, or undefined when ToUnicode already gives its copy text. */
export function actualTextFor(run: LaidOutTextRun, usage: FontUsage): string | undefined
{
    if (run.actualText !== undefined) return copyLayerText(run.actualText);
    const copy = copyLayerText(run.copyText);
    return copy === usage.yields(run.glyphs) ? undefined : copy;
}

/**
 * The content stream of one page (ASCII). `usageOf` gives each font's usage
 * (already filled from every run of the document, so ToUnicode is final).
 */
export function pageContent(page: LaidOutPage, pageHeight: number, usageOf: (run: LaidOutTextRun) => FontUsage): string
{
    const out: string[] = [];
    let fill = '';
    let stroke = '';
    let lineWidth = '';
    const setFill = (color: LaidOutColor): void =>
    {
        const op = colorOperator(color, false);
        if (op !== fill) out.push(op);
        fill = op;
    };

    for (const rect of page.fills)
    {
        if (!isObject(rect)) fail('a fill must be an object');
        setFill(rect.color);
        out.push(`${num(rect.x)} ${num(pageHeight - rect.y - rect.height)} ${num(rect.width)} ${num(rect.height)} re f`);
    }
    for (const line of page.lines)
    {
        if (!isObject(line)) fail('a line must be an object');
        const op = colorOperator(line.color, true);
        if (op !== stroke) out.push(op);
        stroke = op;
        if (!(line.width >= 0)) fail(`line width must be 0 or more, not ${String(line.width)}`);
        const width = `${num(line.width)} w`;
        if (width !== lineWidth) out.push(width);
        lineWidth = width;
        out.push(`${num(line.x1)} ${num(pageHeight - line.y1)} m ${num(line.x2)} ${num(pageHeight - line.y2)} l S`);
    }

    let font = '';
    let inText = false;
    for (const run of page.text)
    {
        if (run.glyphs.length === 0) continue; // nothing drawn, nothing to copy
        const usage = usageOf(run);
        if (!(run.size > 0 && run.size <= MAX_FONT_SIZE)) fail(`font size must be above 0 and at most ${MAX_FONT_SIZE}, not ${String(run.size)}`);
        if (!inText) out.push('BT');
        inText = true;
        const actual = actualTextFor(run, usage);
        if (actual !== undefined) out.push(`/Span << /ActualText ${hexText(actual)} >> BDC`);
        const tf = `${name(usage.resourceName)} ${num(run.size)} Tf`;
        if (tf !== font) out.push(tf);
        font = tf;
        setFill(run.color);
        out.push(`1 0 0 1 ${num(run.x)} ${num(pageHeight - run.y)} Tm`);
        let glyphs = '';
        for (const glyph of run.glyphs) glyphs += hex4(glyph);
        out.push(`<${glyphs}> Tj`);
        if (actual !== undefined) out.push('EMC');
    }
    if (inText) out.push('ET');
    out.push('');
    return out.join('\n');
}
