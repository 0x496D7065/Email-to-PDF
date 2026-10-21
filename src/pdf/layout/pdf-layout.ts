// The layout: the document model (src/pdf/model.ts) in, the laid-out
// document (src/pdf/writer/layout.ts) out, ready for a PdfBackend's
// render(). Everything is placed here; the backend draws exactly that.
//
// Order of the pages: the cover (its blocks), then the index from a new
// page (src/pdf/layout/index-table.ts: one row per email with its page
// number, each row a link to the email), then the emails, from a new page.
//
// Page numbers in the index: the emails are laid out once, on pages of
// their own, counted from 0; the cover and the index ("the front") come
// before them, so an email on its page p is on page front + p + 1 of the
// file. But the front's length is only known once the index is laid out
// with its numbers. Rows have the same height whatever their number (see
// index-table.ts), so: the front is laid out with a guess of its length,
// and again with the length it really had, until both agree (twice in
// practice, the second time is exact). A hard bound (maxPasses, default 4)
// stops a run that does not settle with a clear Error instead of a PDF with
// wrong page numbers (settlePageCount).
//
// Bookmarks (the outline): "Cover", "Index" (when there is one), then one
// per email (PdfIndexEntry.bookmark, one line, already cut to length), all
// at one level.
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
//   (fixed height: the text is filled in at the end, once Y is known).
//
// Each email's heading is a named destination (its anchor, emailAnchor in
// model.ts), and so are the top of the cover ("cover") and the index
// heading ("index"). anchorPages maps each email anchor to its page as a
// 0-based index, the same numbering as LaidOutDestination.page (the page
// shown to a reader, and in the index, is the index + 1).
//
// Pure: no DOM, no clock, no storage, worker-safe (README.md, rules R5,
// R7). Email text only ever becomes glyphs and copy text (rule R4).
import type { ParsedFont } from '../font/font';
import type { PdfFontName } from '../fonts';
import type { PdfBlock, PdfDocument, PdfEmail } from '../model';
import type { PdfStrings } from '../strings';
import type { LaidOutDocument, LaidOutOutlineItem, LaidOutPage } from '../writer/layout';
import { layItem, layRow, linesHeight, placeItem, placeRow, type LaidRow } from './blocks';
import { DEFAULT_LAYOUT_CONFIG, type LayoutConfig, validateLayoutConfig } from './config';
import { INDEX_DESTINATION, layIndex, placeIndex } from './index-table';
import { PageBuilder, type PageInProgress } from './page-builder';
import { Typesetter } from './typesetter';

/** The fixed texts the layout writes itself. */
export type LayoutStrings = Pick<PdfStrings, 'producer' | 'pageFooter' | 'coverBookmark'>;

/** The destination at the top of the cover (the "Cover" bookmark). Never an email anchor ("email-N"). */
export const COVER_DESTINATION = 'cover';

/** Default bound on the front layouts (see the top of this file). */
export const MAX_FRONT_PASSES = 4;

export interface LayoutOptions {
  readonly strings: LayoutStrings;
  /** The look (default DEFAULT_LAYOUT_CONFIG). */
  readonly config?: LayoutConfig;
  /** Start every email on a new page (overrides config.newPagePerEmail). */
  readonly newPagePerEmail?: boolean;
  /** Most layouts of the cover and index before giving up (default MAX_FRONT_PASSES). */
  readonly maxPasses?: number;
}

/** The result: plain data (structured-clone safe). */
export interface PdfLayout {
  readonly document: LaidOutDocument;
  /** Email anchor -> 0-based page index of its heading. */
  readonly anchorPages: ReadonlyMap<string, number>;
  /** Characters drawn as "[U+XXXX]" because the font has no glyph for them (one per code point). */
  readonly placeholders: number;
  /** Pages before the first email: the cover and the index. */
  readonly frontPages: number;
  /** How many times the cover and index were laid out (2 in practice). */
  readonly passes: number;
}

/**
 * Finds the front's page count: `layFront(guess)` lays the front out with
 * the email pages counted after `guess` front pages and says how many pages
 * it really took. Repeats with that count until the guess is right, at most
 * `maxPasses` times; then throws a clear Error, never a wrong guess.
 */
export function settlePageCount<T extends { readonly pages: number }>(
  layFront: (guess: number) => T,
  maxPasses: number,
  firstGuess = 1,
): { readonly front: T; readonly passes: number } {
  if (!Number.isInteger(maxPasses) || maxPasses < 1) throw new Error('layout: maxPasses must be a whole number >= 1');
  let guess = firstGuess;
  for (let pass = 1; pass <= maxPasses; pass++) {
    const front = layFront(guess);
    if (front.pages === guess) return { front, passes: pass };
    guess = front.pages;
  }
  throw new Error(`layout: the index page numbers did not settle after ${String(maxPasses)} passes`);
}

/**
 * Lays out the whole document (see the top of this file). Throws an Error
 * only for an invalid config (validateLayoutConfig), a missing font, a page
 * footer wider than the text area, an index entry without its email, or
 * index page numbers that do not settle (settlePageCount).
 */
export function layoutPdf(doc: PdfDocument, fonts: Readonly<Record<PdfFontName, ParsedFont>>, options: LayoutOptions): PdfLayout {
  const base = options.config ?? DEFAULT_LAYOUT_CONFIG;
  const config: LayoutConfig = options.newPagePerEmail === undefined ? base : { ...base, newPagePerEmail: options.newPagePerEmail };
  validateLayoutConfig(config);
  const typesetter = new Typesetter(fonts, config);

  // The emails, once, on pages of their own (page numbers relative to the first email page).
  const emails = new PageBuilder(config, typesetter);
  const emailPages = new Map<string, number>();
  for (const [k, email] of doc.emails.entries()) placeEmail(emails, email, k === 0, emailPages);
  const emailPageList = doc.emails.length > 0 ? emails.pages : [];

  const entries = doc.index.entries;
  for (const entry of entries) {
    if (!emailPages.has(entry.anchor)) throw new Error(`layout: the index entry ${entry.anchor} has no email`);
  }
  const laidIndex = entries.length > 0 ? layIndex(typesetter, config, emails.left, emails.width, doc.index) : null;

  // The cover and the index, until the page numbers settle. Placeholders of a discarded pass are not counted.
  let discarded = 0;
  let last = 0;
  const { front, passes } = settlePageCount((guess) => {
    discarded += last;
    const before = typesetter.placeholders;
    const b = new PageBuilder(config, typesetter);
    b.destination(COVER_DESTINATION, 0);
    for (const block of doc.cover.blocks) placeBlock(b, block);
    if (laidIndex !== null) placeIndex(b, laidIndex, (anchor) => guess + emailPages.get(anchor)! + 1);
    last = typesetter.placeholders - before;
    return { builder: b, pages: b.pages.length };
  }, options.maxPasses ?? MAX_FRONT_PASSES);

  const frontPages = front.pages;
  const allPages = [...front.builder.pages, ...emailPageList];
  const anchorPages = new Map<string, number>();
  for (const [anchor, page] of emailPages) anchorPages.set(anchor, frontPages + page);
  const destinations = [...front.builder.destinations, ...emails.destinations.map((d) => ({ ...d, page: frontPages + d.page }))];

  const outline: LaidOutOutlineItem[] = [{ title: options.strings.coverBookmark, destination: COVER_DESTINATION, children: [] }];
  if (laidIndex !== null) outline.push({ title: doc.index.heading, destination: INDEX_DESTINATION, children: [] });
  for (const entry of entries) outline.push({ title: entry.bookmark, destination: entry.anchor, children: [] });

  const pages = addFooters(front.builder, allPages, options.strings);
  return {
    document: {
      pageSize: { width: config.page.width, height: config.page.height },
      pages,
      destinations,
      outline,
      info: { title: doc.title, producer: options.strings.producer },
    },
    anchorPages,
    placeholders: typesetter.placeholders - discarded,
    frontPages,
    passes,
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
function addFooters(b: PageBuilder, all: readonly PageInProgress[], strings: LayoutStrings): LaidOutPage[] {
  const ts = b.typesetter;
  const { footer, page } = b.config;
  const total = all.length;
  return all.map((p, index) => {
    const lines = ts.wrap([{ role: 'muted', text: strings.pageFooter(index + 1, total) }], b.width, 'muted', ts.footerStyle);
    if (lines.length !== 1) throw new Error('layout: the page footer is wider than the text area');
    const line = lines[0]!;
    const x = footer.align === 'right' ? b.left + b.width - line.width : b.left + (b.width - line.width) / 2;
    ts.emit(line, x, page.height - footer.baselineFromBottom - line.above, p.text);
    return p;
  });
}
