// The building blocks shared by the cover and the emails: label/value tables
// (a header row: label in the left column, value lines in the right one,
// each wrapping within its column) and bulleted lists. Each is measured
// first (so a caller can keep things together), then placed. Pure
// (README.md, rule R7).
import type { PageBuilder } from './page-builder';
import type { LaidLine } from './typesetter';
import type { PdfFieldRow, PdfLine } from '../../../Header/pdf-document-model';

/** A table row, wrapped: its label lines and its value lines. */
export interface LaidFieldRow
{
    readonly label: readonly LaidLine[];
    readonly value: readonly LaidLine[];
    /** Height when not broken across pages (row gap included). */
    readonly height: number;
}

const sumHeights = (lines: readonly LaidLine[]): number => lines.reduce((total, line) => total + line.height, 0);

/** Total height of some lines. */
export function linesHeight(lines: readonly LaidLine[]): number
{
    return sumHeights(lines);
}

/** Wraps a row of a label/value table. */
export function layFieldRow(builder: PageBuilder, row: PdfFieldRow): LaidFieldRow
{
    const typesetter = builder.typesetter;
    const { labelWidth, gap, rowGap } = builder.config.fields;
    const valueWidth = Math.max(1, builder.contentWidth - labelWidth - gap);
    const label = typesetter.wrap(row.label === '' ? [] : [{ role: 'field-label', text: row.label }], labelWidth, 'field-label');
    const values: readonly PdfLine[] = row.value.length === 0 ? [[]] : row.value;
    const value = values.flatMap((line) => typesetter.wrap(line, valueWidth, 'field-value'));
    return { label, value, height: Math.max(sumHeights(label), sumHeights(value)) + rowGap };
}

/**
 * Places a row. It is kept on one page when it fits on one; a taller row
 * breaks between its lines (the k-th label line and the k-th value line
 * share one band, so the first ones stay on one baseline).
 */
export function placeFieldRow(builder: PageBuilder, row: LaidFieldRow): void
{
    const { labelWidth, gap, rowGap } = builder.config.fields;
    if (row.height <= builder.contentHeight)
    {
        builder.newPageUnlessFits(row.height);
    }
    const valueX = builder.left + labelWidth + gap;
    const bandCount = Math.max(row.label.length, row.value.length);
    for (let band = 0; band < bandCount; band++)
    {
        const label = row.label[band];
        const value = row.value[band];
        const height = Math.max(label?.height ?? 0, value?.height ?? 0);
        builder.newPageUnlessFits(height);
        if (label !== undefined)
        {
            builder.typesetter.drawLine(label, builder.left, builder.cursorY, builder.currentPage.text);
        }
        if (value !== undefined)
        {
            builder.typesetter.drawLine(value, valueX, builder.cursorY, builder.currentPage.text);
        }
        builder.cursorY += height;
    }
    builder.cursorY += rowGap;
}

/** A list item, wrapped (each of its lines wrapped on its own). */
export interface LaidListItem
{
    readonly bullet: LaidLine;
    readonly lines: readonly LaidLine[];
    readonly height: number;
}

export function layListItem(builder: PageBuilder, item: readonly PdfLine[]): LaidListItem
{
    const typesetter = builder.typesetter;
    const { bullet, indent } = builder.config.list;
    const lines = (item.length === 0 ? [[]] : item).flatMap((line) => typesetter.wrap(line, Math.max(1, builder.contentWidth - indent), 'body'));
    return { bullet: typesetter.wrap([{ role: 'body', text: bullet }], indent, 'body')[0]!, lines, height: sumHeights(lines) };
}

/** Places a list item: kept on one page when it fits on one; the bullet on the first line's baseline. */
export function placeListItem(builder: PageBuilder, item: LaidListItem): void
{
    const { indent } = builder.config.list;
    if (item.height <= builder.contentHeight)
    {
        builder.newPageUnlessFits(item.height);
    }
    const [first, ...rest] = item.lines;
    if (first !== undefined)
    {
        builder.newPageUnlessFits(first.height);
        builder.typesetter.drawLine(item.bullet, builder.left, builder.cursorY + first.above - item.bullet.above, builder.currentPage.text);
        builder.placeLine(first, builder.left + indent);
    }
    builder.placeLines(rest, builder.left + indent);
}
