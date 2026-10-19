// The layout: the document model (src/pdf/model.ts) in, the laid-out
// document (src/pdf/writer/layout.ts) out, ready for a PdfBackend's
// render(). Everything is placed here; the backend draws exactly that.
//
// Order of the pages: the cover (its blocks), then the emails, starting on
// a new page. The index with page numbers, its links and the bookmarks come
// later (they need the page of each email, which `anchorPages` gives): they
// go between the cover and the emails, see the marked place in layoutPdf.
//
// Pagination rules:
// - emails follow each other on the same page, with a thin rule between
//   them (or each on a new page, option newPagePerEmail);
// - an email heading is never left alone at the bottom of a page: an email
//   starts on a page only if its heading, its whole header table, its notes
//   and its first keepBodyLines (2) body lines fit there; when that block is
//   taller than a page, only the heading and the first header row must fit;
// - a header row, a list item (cover) stays on one page when it fits on one;
//   a table may break between its rows, a body between its lines;
// - a cover section heading is kept with the start of its section;
// - every page gets the footer "Page X of Y" inside the bottom margin
//   (fixed height, so one pass is enough: the text is filled in at the end).
//
// Each email's heading is a named destination (its anchor, emailAnchor in
// model.ts). anchorPages maps each anchor to its page as a 0-based index,
// the same numbering as LaidOutDestination.page (the page shown to a reader
// is the index + 1).
//
// Pure: no DOM, no clock, no storage, worker-safe (README.md, rules R5,
// R7). Email text only ever becomes glyphs and copy text (rule R4).
import type { ParsedFont } from '../font/font';
import type { PdfFontName } from '../fonts';
import type { PdfBlock, PdfDocument, PdfEmail } from '../model';
import type { PdfStrings } from '../strings';
import type { LaidOutDocument, LaidOutPage } from '../writer/layout';
import { layItem, layRow, linesHeight, placeItem, placeRow, type LaidRow } from './blocks';
import { DEFAULT_LAYOUT_CONFIG, type LayoutConfig, validateLayoutConfig } from './config';
import { PageBuilder } from './page-builder';
import { Typesetter } from './typesetter';

/** The fixed texts the layout writes itself. */
export type LayoutStrings = Pick<PdfStrings, 'producer' | 'pageFooter'>;

export interface LayoutOptions {
  readonly strings: LayoutStrings;
  /** The look (default DEFAULT_LAYOUT_CONFIG). */
  readonly config?: LayoutConfig;
  /** Start every email on a new page (overrides config.newPagePerEmail). */
  readonly newPagePerEmail?: boolean;
}

/** The result: plain data (structured-clone safe). */
export interface PdfLayout {
  readonly document: LaidOutDocument;
  /** Email anchor -> 0-based page index of its heading. */
  readonly anchorPages: ReadonlyMap<string, number>;
  /** Characters drawn as "[U+XXXX]" because the font has no glyph for them (one per code point). */
  readonly placeholders: number;
}

/**
 * Lays out the whole document (see the top of this file). Throws an Error
 * only for an invalid config (validateLayoutConfig), a missing font, or a
 * page footer wider than the text area.
 */
export function layoutPdf(doc: PdfDocument, fonts: Readonly<Record<PdfFontName, ParsedFont>>, options: LayoutOptions): PdfLayout {
  const base = options.config ?? DEFAULT_LAYOUT_CONFIG;
  const config: LayoutConfig = options.newPagePerEmail === undefined ? base : { ...base, newPagePerEmail: options.newPagePerEmail };
  validateLayoutConfig(config);
  const typesetter = new Typesetter(fonts, config);
  const b = new PageBuilder(config, typesetter);

  for (const block of doc.cover.blocks) placeBlock(b, block);

  // The index (page numbers, links) and the bookmarks go here (milestone 5.5).

  const anchorPages = new Map<string, number>();
  for (const [k, email] of doc.emails.entries()) {
    if (k === 0 && !b.atTop) b.newPage(); // the emails start on a page of their own
    placeEmail(b, email, k === 0, anchorPages);
  }

  const pages = addFooters(b, options.strings);
  return {
    document: {
      pageSize: { width: config.page.width, height: config.page.height },
      pages,
      destinations: b.destinations,
      outline: [],
      info: { title: doc.title, producer: options.strings.producer },
    },
    anchorPages,
    placeholders: typesetter.placeholders,
  };
}

/** One cover block. */
function placeBlock(b: PageBuilder, block: PdfBlock): void {
  const ts = b.typesetter;
  const { spacing } = b.config;
  switch (block.kind) {
    case 'heading': {
      if (block.level === 1) {
        b.placeAll(ts.wrap(block.line, b.width, 'title'));
        b.space(spacing.afterTitle);
        return;
      }
      const lines = ts.wrap(block.line, b.width, 'heading');
      b.space(spacing.beforeSection);
      // Kept with the start of its section: two lines of text.
      b.ensure(linesHeight(lines) + spacing.afterHeading + 2 * ts.lineHeight('body'));
      b.placeAll(lines);
      b.space(spacing.afterHeading);
      return;
    }
    case 'fields':
      for (const row of block.rows) placeRow(b, layRow(b, row));
      b.space(spacing.betweenBlocks);
      return;
    case 'paragraph':
      b.placeAll(ts.wrap(block.line, b.width, 'body'));
      b.space(spacing.betweenBlocks);
      return;
    case 'list':
      for (const [k, item] of block.items.entries()) {
        if (k > 0) b.space(b.config.list.itemGap);
        placeItem(b, layItem(b, item));
      }
      b.space(spacing.betweenBlocks);
      return;
  }
}

/** One email (see the pagination rules at the top of this file). */
function placeEmail(b: PageBuilder, email: PdfEmail, first: boolean, anchorPages: Map<string, number>): void {
  const ts = b.typesetter;
  const { spacing } = b.config;
  const heading = ts.wrap([{ role: 'heading', text: email.heading }], b.width, 'heading');
  const rows: LaidRow[] = email.fields.map((row) => layRow(b, row));
  const notes = email.notes.flatMap((line) => ts.wrap(line, b.width, 'body'));
  const body = email.body.flatMap((line) => ts.wrap(line, b.width, 'body'));

  // The block kept together.
  const headingHeight = linesHeight(heading) + spacing.afterHeading;
  const tableHeight = rows.reduce((h, r) => h + r.height, 0);
  let keep =
    headingHeight +
    tableHeight +
    spacing.afterFields +
    (notes.length > 0 ? linesHeight(notes) + spacing.afterNotes : 0) +
    linesHeight(body.slice(0, b.config.keepBodyLines));
  if (keep > b.contentHeight) keep = headingHeight + (rows[0]?.height ?? 0);

  // After this, the keep block fits below the cursor (or the page is empty).
  if (!b.atTop) {
    if (b.config.newPagePerEmail && !first) b.newPage();
    else if (!b.fits(spacing.betweenEmails + keep)) b.newPage();
    else {
      b.rule(b.y + spacing.betweenEmails / 2);
      b.y += spacing.betweenEmails;
    }
  }

  b.destination(email.anchor, b.y - spacing.destinationAbove);
  anchorPages.set(email.anchor, b.pageIndex);
  b.placeAll(heading);
  b.space(spacing.afterHeading);
  for (const row of rows) placeRow(b, row);
  b.space(spacing.afterFields);
  if (notes.length > 0) {
    b.placeAll(notes);
    b.space(spacing.afterNotes);
  }
  b.placeAll(body);

  if (email.attachments !== null) {
    b.space(spacing.beforeAttachments);
    const label = ts.wrap([{ role: 'field-label', text: email.attachments.label }], b.width, 'field-label');
    const items = email.attachments.items.map((item) => layItem(b, [item]));
    b.ensure(linesHeight(label) + (items[0]?.lines[0]?.height ?? 0));
    b.placeAll(label);
    for (const item of items) placeItem(b, item);
  }
}

/**
 * The footer of every page, now that the page count is known: one line, at
 * most the width of the text area (an Error if it is wider, never cut).
 */
function addFooters(b: PageBuilder, strings: LayoutStrings): LaidOutPage[] {
  const ts = b.typesetter;
  const { footer, page } = b.config;
  const total = b.pages.length;
  return b.pages.map((p, index) => {
    const lines = ts.wrap([{ role: 'muted', text: strings.pageFooter(index + 1, total) }], b.width, 'muted', ts.footerStyle);
    if (lines.length !== 1) throw new Error('layout: the page footer is wider than the text area');
    const line = lines[0]!;
    const x = footer.align === 'right' ? b.left + b.width - line.width : b.left + (b.width - line.width) / 2;
    ts.emit(line, x, page.height - footer.baselineFromBottom - line.above, p.text);
    return p;
  });
}
