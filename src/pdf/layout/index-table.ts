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
// The date column holds the short form "YYYY-MM-DD HH:mm" on one line (its
// title names the zone); its title, like any column title, may wrap: the
// titles are wrapped once, so they are equally tall on every index page.
//
// Pagination: the index starts right after the cover information, on the
// same page when its heading, column titles and first row fit there, else
// on a new page (task 8.12); the column titles are repeated
// at the top of every index page; a row stays on one page when it fits on
// one, else it breaks between its lines (its link is then split in one area
// per page). Pure (README.md, rule R7); email text only ever becomes glyphs
// and copy text (rule R4).
import type { PdfIndex } from '../model';
import type { PdfLine } from '../text';
import { linesHeight } from './blocks';
import type { LayoutConfig } from './config';
import type { PageBuilder } from './page-builder';
import type { LaidLine, Typesetter } from './typesetter';

/** The destination of the index heading (the "Index" bookmark). Never an email anchor ("email-N"). */
export const INDEX_DESTINATION = 'index';

interface Column {
  readonly x: number;
  readonly width: number;
}

/** Where each column is, for a text area starting at `left`, `width` wide. */
export interface IndexColumns {
  readonly number: Column;
  readonly date: Column;
  readonly from: Column;
  readonly subject: Column;
  readonly page: Column;
  /** The attachment lines: from the date column to the end of the subject column. */
  readonly attachments: Column;
}

export function indexColumns(config: LayoutConfig, left: number, width: number): IndexColumns {
  const { numberWidth, dateWidth, fromWidth, pageWidth, gap } = config.index;
  const number = { x: left, width: numberWidth };
  const date = { x: number.x + numberWidth + gap, width: dateWidth };
  const from = { x: date.x + dateWidth + gap, width: fromWidth };
  const page = { x: left + width - pageWidth, width: pageWidth };
  const subject = { x: from.x + fromWidth + gap, width: page.x - gap - (from.x + fromWidth + gap) };
  return { number, date, from, subject, page, attachments: { x: date.x, width: subject.x + subject.width - date.x } };
}

/** A cell: its column, its wrapped lines, and its alignment. */
interface LaidCell {
  readonly column: Column;
  readonly lines: readonly LaidLine[];
  readonly right: boolean;
}

/** One line under a row (the attachments label, or a line of an attachment), with its bullet on an item's first line. */
interface LaidExtra {
  readonly line: LaidLine;
  readonly x: number;
  readonly bullet: { readonly line: LaidLine; readonly x: number } | null;
  /** Kept on the page of the next line (the label with the first item). */
  readonly keepWithNext: boolean;
}

export interface LaidIndexRow {
  readonly anchor: string;
  /** Number, date, from, subject. */
  readonly cells: readonly LaidCell[];
  readonly extras: readonly LaidExtra[];
  /** The height of each band (the k-th lines of the cells; band 0 also holds the page number). */
  readonly bands: readonly number[];
  /** Total height, without the row gap. */
  readonly height: number;
}

export interface LaidIndex {
  readonly heading: readonly LaidLine[];
  /** The column titles (the page title included). */
  readonly header: readonly LaidCell[];
  readonly headerHeight: number;
  readonly rows: readonly LaidIndexRow[];
}

/** Bands of cells: the k-th lines share one band, as tall as the tallest of them. */
function bandsOf(cells: readonly LaidCell[], minFirst: number): number[] {
  const count = Math.max(1, ...cells.map((c) => c.lines.length));
  const bands: number[] = [];
  for (let k = 0; k < count; k++) bands.push(Math.max(k === 0 ? minFirst : 0, ...cells.map((c) => c.lines[k]?.height ?? 0)));
  return bands;
}

const sum = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);

/** Wraps the index (heading, column titles, rows); nothing is placed yet. */
export function layIndex(ts: Typesetter, config: LayoutConfig, left: number, width: number, index: PdfIndex): LaidIndex {
  const cols = indexColumns(config, left, width);
  const { bullet, indent } = config.list;
  const cell = (column: Column, line: PdfLine, right = false, strut: 'body' | 'field-label' = 'body'): LaidCell => ({
    column,
    lines: ts.wrap(line, column.width, strut),
    right,
  });
  const title = (column: Column, text: string, right = false): LaidCell => cell(column, [{ role: 'field-label', text }], right, 'field-label');
  const header = [
    title(cols.number, index.columns.number, true),
    title(cols.date, index.columns.date),
    title(cols.from, index.columns.from),
    title(cols.subject, index.columns.subject),
    title(cols.page, index.columns.page, true),
  ];
  const bodyLine = ts.lineHeight('body');
  const bulletLine = ts.wrap([{ role: 'body', text: bullet }], indent, 'body')[0]!;
  const itemWidth = Math.max(1, cols.attachments.width - indent);

  const rows = index.entries.map((entry): LaidIndexRow => {
    const cells = [
      // Every email has its number, rebuilt ones too (task 8.3).
      cell(cols.number, [{ role: 'body', text: String(entry.number) }], true),
      cell(cols.date, entry.date),
      cell(cols.from, entry.from),
      cell(cols.subject, entry.subject),
    ];
    const extras: LaidExtra[] = [];
    if (entry.attachmentLines.length > 0) {
      for (const line of ts.wrap([{ role: 'field-label', text: index.columns.attachments }], cols.attachments.width, 'field-label')) {
        extras.push({ line, x: cols.attachments.x, bullet: null, keepWithNext: true });
      }
      for (const item of entry.attachmentLines) {
        ts.wrap(item, itemWidth, 'body').forEach((line, k) => {
          extras.push({ line, x: cols.attachments.x + indent, bullet: k === 0 ? { line: bulletLine, x: cols.attachments.x } : null, keepWithNext: false });
        });
      }
    }
    // Band 0 is at least one body line: the page number's line box (never taller, whatever the number).
    const bands = bandsOf(cells, bodyLine);
    return { anchor: entry.anchor, cells, extras, bands, height: sum(bands) + sum(extras.map((e) => e.line.height)) };
  });

  return {
    heading: ts.wrap([{ role: 'heading', text: index.heading }], width, 'heading'),
    header,
    headerHeight: sum(bandsOf(header, 0)),
    rows,
  };
}

/** Draws one line of a cell at `top`. */
function emitCell(b: PageBuilder, c: LaidCell, line: LaidLine, top: number): void {
  const x = c.right ? c.column.x + c.column.width - line.width : c.column.x;
  b.typesetter.emit(line, x, top, b.page.text);
}

/** The column titles at the cursor, then a rule below them. */
function placeHeader(b: PageBuilder, laid: LaidIndex): void {
  const top = b.y;
  for (const c of laid.header) c.lines.forEach((line, k) => emitCell(b, c, line, top + linesHeight(c.lines.slice(0, k))));
  b.y += laid.headerHeight;
  const gap = b.config.index.headerGap;
  b.rule(b.y + gap / 2);
  b.y += gap;
}

/**
 * Places the index below the cover (see the top of this file). `pageOf`
 * gives the page number shown for an email anchor (1-based, as the footer
 * counts). Every row gets a link to its anchor.
 */
export function placeIndex(b: PageBuilder, laid: LaidIndex, pageOf: (anchor: string) => number): void {
  const ts = b.typesetter;
  const { spacing, index } = b.config;
  const roomBelowHeader = b.contentHeight - laid.headerHeight - index.headerGap;
  // Right after the cover information, like a cover section (task 8.12): its
  // heading, the column titles and the first row are kept together, else
  // they start on a new page.
  b.space(spacing.beforeSection);
  const firstRow = laid.rows[0];
  const firstRowKeep = firstRow === undefined ? 0 : firstRow.height <= roomBelowHeader ? firstRow.height : firstRow.bands[0]!;
  b.ensure(linesHeight(laid.heading) + spacing.afterHeading + laid.headerHeight + index.headerGap + firstRowKeep);
  b.destination(INDEX_DESTINATION, b.y - spacing.destinationAbove);
  b.placeAll(laid.heading);
  b.space(spacing.afterHeading);
  placeHeader(b, laid);

  for (const row of laid.rows) {
    let segmentTop = b.y;
    const link = (): void => {
      if (b.y > segmentTop) b.page.links.push({ rect: { x: b.left, y: segmentTop, width: b.width, height: b.y - segmentTop }, destination: row.anchor });
    };
    /** A new index page (column titles first) unless `height` fits below the cursor. */
    const ensure = (height: number): void => {
      if (b.fits(height)) return;
      link();
      b.newPage();
      placeHeader(b, laid);
      segmentTop = b.y;
    };
    // Kept on one page when it fits on one (below the column titles).
    ensure(row.height <= roomBelowHeader ? row.height : row.bands[0]!);
    segmentTop = b.y;

    const page = ts.wrap([{ role: 'body', text: String(pageOf(row.anchor)) }], b.width, 'body')[0]!;
    row.bands.forEach((height, k) => {
      ensure(height);
      for (const c of row.cells) {
        const line = c.lines[k];
        if (line !== undefined) emitCell(b, c, line, b.y);
      }
      if (k === 0) ts.emit(page, b.left + b.width - page.width, b.y, b.page.text); // right-aligned in the page column
      b.y += height;
    });
    row.extras.forEach((extra, k) => {
      const next = row.extras[k + 1];
      ensure(extra.line.height + (extra.keepWithNext && next !== undefined ? next.line.height : 0));
      if (extra.bullet !== null) ts.emit(extra.bullet.line, extra.bullet.x, b.y + extra.line.above - extra.bullet.line.above, b.page.text);
      ts.emit(extra.line, extra.x, b.y, b.page.text);
      b.y += extra.line.height;
    });
    link();
    b.y += index.rowGap;
  }
}
