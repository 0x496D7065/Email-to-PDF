// The building blocks shared by the cover and the emails: label/value tables
// (a header row: label in the left column, value lines in the right one,
// each wrapping within its column) and bulleted lists. Each is measured
// first (so a caller can keep things together), then placed. Pure
// (README.md, rule R7).
import type { PdfFieldRow } from '../model';
import type { PdfLine } from '../text';
import type { PageBuilder } from './page-builder';
import type { LaidLine } from './typesetter';

/** A table row, wrapped: its label lines and its value lines. */
export interface LaidRow {
    readonly label: readonly LaidLine[];
    readonly value: readonly LaidLine[];
    /** Height when not broken across pages (row gap included). */
    readonly height: number;
}

const sum = (lines: readonly LaidLine[]): number => lines.reduce((h, l) => h + l.height, 0);

/** Total height of some lines. */
export function linesHeight(lines: readonly LaidLine[]): number
{
    return sum(lines);
}

/** Wraps a row of a label/value table. */
export function layRow(b: PageBuilder, row: PdfFieldRow): LaidRow
{
    const ts = b.typesetter;
    const { labelWidth, gap, rowGap } = b.config.fields;
    const valueWidth = Math.max(1, b.width - labelWidth - gap);
    const label = ts.wrap(row.label === '' ? [] : [{ role: 'field-label', text: row.label }], labelWidth, 'field-label');
    const values: readonly PdfLine[] = row.value.length === 0 ? [[]] : row.value;
    const value = values.flatMap((line) => ts.wrap(line, valueWidth, 'field-value'));
    return { label, value, height: Math.max(sum(label), sum(value)) + rowGap };
}

/**
 * Places a row. It is kept on one page when it fits on one; a taller row
 * breaks between its lines (the k-th label line and the k-th value line
 * share one band, so the first ones stay on one baseline).
 */
export function placeRow(b: PageBuilder, row: LaidRow): void
{
    const { labelWidth, gap, rowGap } = b.config.fields;
    if (row.height <= b.contentHeight)
    {
        b.ensure(row.height);
    }
    const valueX = b.left + labelWidth + gap;
    const bands = Math.max(row.label.length, row.value.length);
    for (let k = 0; k < bands; k++)
    {
        const label = row.label[k];
        const value = row.value[k];
        const height = Math.max(label?.height ?? 0, value?.height ?? 0);
        b.ensure(height);
        if (label !== undefined)
        {
            b.typesetter.emit(label, b.left, b.y, b.page.text);
        }
        if (value !== undefined)
        {
            b.typesetter.emit(value, valueX, b.y, b.page.text);
        }
        b.y += height;
    }
    b.y += rowGap;
}

/** A list item, wrapped (each of its lines wrapped on its own). */
export interface LaidItem {
    readonly bullet: LaidLine;
    readonly lines: readonly LaidLine[];
    readonly height: number;
}

export function layItem(b: PageBuilder, item: readonly PdfLine[]): LaidItem
{
    const ts = b.typesetter;
    const { bullet, indent } = b.config.list;
    const lines = (item.length === 0 ? [[]] : item).flatMap((line) => ts.wrap(line, Math.max(1, b.width - indent), 'body'));
    return { bullet: ts.wrap([{ role: 'body', text: bullet }], indent, 'body')[0]!, lines, height: sum(lines) };
}

/** Places a list item: kept on one page when it fits on one; the bullet on the first line's baseline. */
export function placeItem(b: PageBuilder, item: LaidItem): void
{
    const { indent } = b.config.list;
    if (item.height <= b.contentHeight)
    {
        b.ensure(item.height);
    }
    const [first, ...rest] = item.lines;
    if (first !== undefined)
    {
        b.ensure(first.height);
        b.typesetter.emit(item.bullet, b.left, b.y + first.above - item.bullet.above, b.page.text);
        b.place(first, b.left + indent);
    }
    b.placeAll(rest, b.left + indent);
}
