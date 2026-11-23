// The index: a table of the emails (number, date, sender, subject, page),
// each row followed by the email's attachments (listed only, the same lines
// as in the email itself), each row a link to its email's heading.
//
// The rows are wrapped once (layIndex), then placed (placeIndex) as often
// as the layout needs to find the final page numbers (see the top of
// pdf-layout.ts). A row's height never depends on its page number: the
// number is drawn as one line of body text (never wrapped), right-aligned
// in the page column, and that line is never taller than the row's first
// band (all cells have a body line box). So placing the same rows with other
// numbers gives the same pages. The column is wide enough for numbers of up
// to INDEX_PAGE_DIGITS digits (validateLayoutConfig checks it: 36 pt holds
// 6 digits at 10 pt); a longer number would reach into the subject column,
// still on one line, so even then no row grows.
//
// The date column holds the short form "YYYY-MM-DD HH:mm" on one line (as
// written, task 9.9c); its title, like any column title, may wrap: the
// titles are wrapped once, so they are equally tall on every index page.
//
// Pagination: the index starts right after the cover information, on the
// same page when its heading, column titles and first row fit there, else
// on a new page (task 8.12); the column titles are repeated
// at the top of every index page; a row stays on one page when it fits on
// one, else it breaks between its lines (its link is then split in one area
// per page). Pure (README.md, rule R7); email text only ever becomes glyphs
// and copy text (rule R4).
import { linesHeight } from './field-rows-and-lists';
import type { PageBuilder } from './page-builder';
import type { LaidLine, Typesetter } from './typesetter';
import type { LayoutConfig } from '../../../Header/laid-out-document';
import type { PdfIndex, PdfLine } from '../../../Header/pdf-document-model';

/** The destination of the index heading (the "Index" bookmark). Never an email anchor ("email-N"). */
export const INDEX_DESTINATION = 'index';

interface Column
{
    readonly x: number;
    readonly width: number;
}

/** Where each column is, for a text area starting at `left`, `width` wide. */
export interface IndexColumns
{
    readonly number: Column;
    readonly date: Column;
    readonly from: Column;
    readonly subject: Column;
    readonly page: Column;
    /** The attachment lines: from the date column to the end of the subject column. */
    readonly attachments: Column;
}

export function indexColumns(config: LayoutConfig, left: number, width: number): IndexColumns
{
    const { numberWidth, dateWidth, fromWidth, pageWidth, gap } = config.index;
    const number = { x: left, width: numberWidth };
    const date = { x: number.x + numberWidth + gap, width: dateWidth };
    const from = { x: date.x + dateWidth + gap, width: fromWidth };
    const page = { x: left + width - pageWidth, width: pageWidth };
    const subject = { x: from.x + fromWidth + gap, width: page.x - gap - (from.x + fromWidth + gap) };
    return { number, date, from, subject, page, attachments: { x: date.x, width: subject.x + subject.width - date.x } };
}

/** A cell: its column, its wrapped lines, and its alignment. */
interface LaidCell
{
    readonly column: Column;
    readonly lines: readonly LaidLine[];
    readonly alignRight: boolean;
}

/** One line under a row (the attachments label, or a line of an attachment), with its bullet on an item's first line. */
interface LaidAttachmentLine
{
    readonly line: LaidLine;
    readonly x: number;
    readonly bullet: { readonly line: LaidLine; readonly x: number } | null;
    /** Kept on the page of the next line (the label with the first item). */
    readonly keepWithNext: boolean;
}

export interface LaidIndexRow
{
    readonly anchor: string;
    /** Number, date, from, subject. */
    readonly cells: readonly LaidCell[];
    readonly attachmentLines: readonly LaidAttachmentLine[];
    /** The height of each band (the k-th lines of the cells; band 0 also holds the page number). */
    readonly bands: readonly number[];
    /** Total height, without the row gap. */
    readonly height: number;
}

export interface LaidIndex
{
    readonly heading: readonly LaidLine[];
    /** The column titles (the page title included). */
    readonly columnTitles: readonly LaidCell[];
    readonly columnTitlesHeight: number;
    readonly rows: readonly LaidIndexRow[];
}

/** Bands of cells: the k-th lines share one band, as tall as the tallest of them. */
function bandsOf(cells: readonly LaidCell[], minFirstBand: number): number[]
{
    const bandCount = Math.max(1, ...cells.map((cell) => cell.lines.length));
    const bands: number[] = [];
    for (let band = 0; band < bandCount; band++)
    {
        bands.push(Math.max(band === 0 ? minFirstBand : 0, ...cells.map((cell) => cell.lines[band]?.height ?? 0)));
    }
    return bands;
}

const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);

/** Wraps the index (heading, column titles, rows); nothing is placed yet. */
export function layIndex(typesetter: Typesetter, config: LayoutConfig, left: number, width: number, pdfIndex: PdfIndex): LaidIndex
{
    const columns = indexColumns(config, left, width);
    const { bullet, indent } = config.list;
    const cell = (column: Column, line: PdfLine, alignRight = false, strut: 'body' | 'field-label' = 'body'): LaidCell => ({
        column,
        lines: typesetter.wrap(line, column.width, strut),
        alignRight,
    });
    const columnTitle = (column: Column, text: string, alignRight = false): LaidCell =>
        cell(column, [{ role: 'field-label', text }], alignRight, 'field-label');
    const columnTitles = [
        columnTitle(columns.number, pdfIndex.columns.number, true),
        columnTitle(columns.date, pdfIndex.columns.date),
        columnTitle(columns.from, pdfIndex.columns.from),
        columnTitle(columns.subject, pdfIndex.columns.subject),
        columnTitle(columns.page, pdfIndex.columns.page, true),
    ];
    const bodyLineHeight = typesetter.lineHeight('body');
    const bulletLine = typesetter.wrap([{ role: 'body', text: bullet }], indent, 'body')[0]!;
    const attachmentItemWidth = Math.max(1, columns.attachments.width - indent);

    const rows = pdfIndex.entries.map((entry): LaidIndexRow =>
    {
        const cells = [
            // Every email has its number, rebuilt ones too (task 8.3).
            cell(columns.number, [{ role: 'body', text: String(entry.number) }], true),
            cell(columns.date, entry.date),
            cell(columns.from, entry.from),
            cell(columns.subject, entry.subject),
        ];
        const attachmentLines: LaidAttachmentLine[] = [];
        if (entry.attachmentLines.length > 0)
        {
            for (const line of typesetter.wrap([{ role: 'field-label', text: pdfIndex.columns.attachments }],
                columns.attachments.width, 'field-label'))
            {
                attachmentLines.push({ line, x: columns.attachments.x, bullet: null, keepWithNext: true });
            }
            for (const item of entry.attachmentLines)
            {
                typesetter.wrap(item, attachmentItemWidth, 'body').forEach((line, position) =>
                {
                    attachmentLines.push({ line, x: columns.attachments.x + indent, bullet: position === 0 ? { line: bulletLine, x: columns.attachments.x } : null, keepWithNext: false });
                });
            }
        }
        // Band 0 is at least one body line: the page number's line box (never taller, whatever the number).
        const bands = bandsOf(cells, bodyLineHeight);
        return {
            anchor: entry.anchor,
            cells,
            attachmentLines,
            bands,
            height: sum(bands) + sum(attachmentLines.map((attachmentLine) => attachmentLine.line.height))
        };
    });

    return {
        heading: typesetter.wrap([{ role: 'heading', text: pdfIndex.heading }], width, 'heading'),
        columnTitles,
        columnTitlesHeight: sum(bandsOf(columnTitles, 0)),
        rows,
    };
}

/** Draws one line of a cell at `top`. */
function drawCell(builder: PageBuilder, cell: LaidCell, line: LaidLine, top: number): void
{
    const x = cell.alignRight ? cell.column.x + cell.column.width - line.width : cell.column.x;
    builder.typesetter.drawLine(line, x, top, builder.currentPage.text);
}

/** The column titles at the cursor, then a rule below them. */
function placeColumnTitles(builder: PageBuilder, laidIndex: LaidIndex): void
{
    const top = builder.cursorY;
    for (const cell of laidIndex.columnTitles)
    {
        cell.lines.forEach((line, position) => drawCell(builder, cell, line, top + linesHeight(cell.lines.slice(0, position))));
    }
    builder.cursorY += laidIndex.columnTitlesHeight;
    const gap = builder.config.index.headerGap;
    builder.drawRule(builder.cursorY + gap / 2);
    builder.cursorY += gap;
}

/**
 * Places the index below the cover (see the top of this file). `pageOf`
 * gives the page number shown for an email anchor (1-based, as the footer
 * counts). Every row gets a link to its anchor.
 */
export function placeIndex(builder: PageBuilder, laidIndex: LaidIndex, pageOf: (anchor: string) => number): void
{
    const typesetter = builder.typesetter;
    const { spacing, index: indexConfig } = builder.config;
    const roomBelowColumnTitles = builder.contentHeight - laidIndex.columnTitlesHeight - indexConfig.headerGap;
    // Right after the cover information, like a cover section (task 8.12): its
    // heading, the column titles and the first row are kept together, else
    // they start on a new page.
    builder.addSpace(spacing.beforeSection);
    const firstRow = laidIndex.rows[0];
    const firstRowKeepHeight = firstRow === undefined ? 0 : firstRow.height <= roomBelowColumnTitles ? firstRow.height : firstRow.bands[0]!;
    builder.newPageUnlessFits(linesHeight(laidIndex.heading) + spacing.afterHeading + laidIndex.columnTitlesHeight +
        indexConfig.headerGap + firstRowKeepHeight);
    builder.addDestination(INDEX_DESTINATION, builder.cursorY - spacing.destinationAbove);
    builder.placeLines(laidIndex.heading);
    builder.addSpace(spacing.afterHeading);
    placeColumnTitles(builder, laidIndex);

    for (const row of laidIndex.rows)
    {
        let segmentTop = builder.cursorY;
        const addRowLink = (): void =>
        {
            if (builder.cursorY > segmentTop)
            {
                builder.currentPage.links.push({
                    rect: { x: builder.left, y: segmentTop, width: builder.contentWidth, height: builder.cursorY - segmentTop },
                    destination: row.anchor
                });
            }
        };
        /** A new index page (column titles first) unless `height` fits below the cursor. */
        const newIndexPageUnlessFits = (height: number): void =>
        {
            if (builder.fits(height))
            {
                return;
            }
            addRowLink();
            builder.newPage();
            placeColumnTitles(builder, laidIndex);
            segmentTop = builder.cursorY;
        };
        // Kept on one page when it fits on one (below the column titles).
        newIndexPageUnlessFits(row.height <= roomBelowColumnTitles ? row.height : row.bands[0]!);
        segmentTop = builder.cursorY;

        const pageNumberLine = typesetter.wrap([{ role: 'body', text: String(pageOf(row.anchor)) }], builder.contentWidth, 'body')[0]!;
        row.bands.forEach((height, band) =>
        {
            newIndexPageUnlessFits(height);
            for (const cell of row.cells)
            {
                const line = cell.lines[band];
                if (line !== undefined)
                {
                    drawCell(builder, cell, line, builder.cursorY);
                }
            }
            if (band === 0)
            {
                typesetter.drawLine(pageNumberLine, builder.left + builder.contentWidth - pageNumberLine.width, builder.cursorY,
                    builder.currentPage.text); // right-aligned in the page column
            }
            builder.cursorY += height;
        });
        row.attachmentLines.forEach((attachmentLine, position) =>
        {
            const nextLine = row.attachmentLines[position + 1];
            newIndexPageUnlessFits(attachmentLine.line.height + (attachmentLine.keepWithNext && nextLine !== undefined ? nextLine.line.height : 0));
            if (attachmentLine.bullet !== null)
            {
                typesetter.drawLine(attachmentLine.bullet.line, attachmentLine.bullet.x,
                    builder.cursorY + attachmentLine.line.above - attachmentLine.bullet.line.above, builder.currentPage.text);
            }
            typesetter.drawLine(attachmentLine.line, attachmentLine.x, builder.cursorY, builder.currentPage.text);
            builder.cursorY += attachmentLine.line.height;
        });
        addRowLink();
        builder.cursorY += indexConfig.rowGap;
    }
}
