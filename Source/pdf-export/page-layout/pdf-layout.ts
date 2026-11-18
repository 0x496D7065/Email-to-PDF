// The layout: the document model (Source/pdf-export/build-pdf-document.ts) in, the laid-out
// document (Header/laid-out-document.ts) out, ready for a PdfBackend's
// render(). Everything is placed here; the backend draws exactly that.
//
// Order of the pages: the cover (its blocks), then the index right below
// them, on the same page when its start fits there (task 8.12;
// Source/pdf-export/page-layout/email-index-table.ts: one row per email with its page number,
// each row a link to the email), then the emails, from a new page.
//
// Page numbers in the index: the emails are laid out once, on pages of
// their own, counted from 0; the cover and the index ("the front") come
// before them, so an email on its page p is on page front + p + 1 of the
// file. But the front's length is only known once the index is laid out
// with its numbers. Rows have the same height whatever their number (see
// email-index-table.ts), so: the front is laid out with a guess of its length,
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
// - every email, real or rebuilt from quoted text, starts at the top of a
//   new page, its heading and header rows included, however much of the
//   page before stays blank (option newPagePerEmail, on by default and
//   never switched off by the app, user decisions 2026-11-02 and
//   2026-11-06); never an empty page: an email already at the top of a
//   page (the first one, right after the index) gets no extra break. With
//   the option off (tests and other callers only), emails follow each other
//   on the same page, with a thin rule between them;
// - an email heading is never left alone at the bottom of a page: an email
//   starts on a page only if its heading, its whole header table, its notes
//   and its first keepBodyLines (2) body lines fit there; when that block is
//   taller than a page, only the heading and the first header row must fit
//   (this matters mainly with newPagePerEmail off, or when a header table
//   is taller than a page);
// - a header row, a list item (cover) stays on one page when it fits on one;
//   a table may break between its rows, a body between its lines;
// - a cover section heading is kept with the start of its section;
// - every page gets the footer "Page X of Y" inside the bottom margin
//   (fixed height: the text is filled in at the end, once Y is known).
//
// Email bodies (tasks 8.6 and 8.9): every body line, wrapped lines
// included, is placed one tab to the right of the margin (bodyIndentWidth:
// config.bodyIndentSpaces, default 4, normal spaces of the body font at the
// body size, measured from the font) and wrapped to the width left. One
// step for every line, quoted or not (quote marks are removed,
// Source/pdf-export/pdf-text-transforms.ts transform g), for real and rebuilt emails alike. The
// "(no text)" placeholder of an empty text (the email's notes) is indented
// the same way, where the text would be (task 8.10). The heading, header
// rows and attachments stay at the margin.
//
// Each email's heading is a named destination (its anchor, emailAnchor in
// build-pdf-document.ts), and so are the top of the cover ("cover") and the index
// heading ("index"). anchorPages maps each email anchor to its page as a
// 0-based index, the same numbering as LaidOutDestination.page (the page
// shown to a reader, and in the index, is the index + 1).
//
// Pure: no DOM, no clock, no storage, worker-safe (README.md, rules R5,
// R7). Email text only ever becomes glyphs and copy text (rule R4).
import { layListItem, layFieldRow, linesHeight, placeListItem, placeFieldRow, type LaidFieldRow } from './field-rows-and-lists';
import { DEFAULT_LAYOUT_CONFIG, validateLayoutConfig } from './layout-config';
import { INDEX_DESTINATION, layIndex, placeIndex } from './email-index-table';
import { PageBuilder, type PageInProgress } from './page-builder';
import { Typesetter } from './typesetter';
import type { LaidOutDocument, LaidOutOutlineItem, LaidOutPage, LayoutConfig } from '../../../Header/laid-out-document';
import type { PdfBlock, PdfDocument, PdfEmail, PdfStrings } from '../../../Header/pdf-document-model';
import type { ParsedFont, PdfFontName } from '../../../Header/pdf-fonts';

/** The fixed texts the layout writes itself. */
export type LayoutStrings = Pick<PdfStrings, 'producer' | 'pageFooter' | 'coverBookmark'>;

/** The destination at the top of the cover (the "Cover" bookmark). Never an email anchor ("email-N"). */
export const COVER_DESTINATION = 'cover';

/** Default bound on the front layouts (see the top of this file). */
export const MAX_FRONT_PASSES = 4;

export interface LayoutOptions
{
    readonly strings: LayoutStrings;
    /** The look (default DEFAULT_LAYOUT_CONFIG). */
    readonly config?: LayoutConfig;
    /** Start every email on a new page (overrides config.newPagePerEmail). */
    readonly newPagePerEmail?: boolean;
    /** Most layouts of the cover and index before giving up (default MAX_FRONT_PASSES). */
    readonly maxPasses?: number;
}

/** The result: plain data (structured-clone safe). */
export interface PdfLayout
{
    readonly document: LaidOutDocument;
    /** Email anchor -> 0-based page index of its heading. */
    readonly anchorPages: ReadonlyMap<string, number>;
    /** Characters drawn as "[U+XXXX]" because the font has no glyph for them (one per code point). */
    readonly placeholders: number;
    /** Pages before the first email: the cover and the index. */
    readonly frontPages: number;
    /** How many times the cover and index were laid out (2 in practice). */
    readonly passes: number;
    /** How far every email body line is from the left margin, in points (bodyIndentWidth). */
    readonly bodyIndent: number;
}

/**
 * The body indent in points: config.bodyIndentSpaces normal spaces of the
 * body style (its font, its size), as the typesetter measures them. Throws
 * a clear Error when that is wider than half the text area.
 */
export function bodyIndentWidth(typesetter: Typesetter, config: LayoutConfig): number
{
    const width = config.bodyIndentSpaces * typesetter.spaceWidth('body');
    const textWidth = config.page.width - config.margin.left - config.margin.right;
    if (!(width <= textWidth / 2))
    {
        throw new Error('layout: invalid config: bodyIndentSpaces makes the body indent wider than half the text area width');
    }
    return width;
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
): { readonly front: T; readonly passes: number }
{
    if (!Number.isInteger(maxPasses) || maxPasses < 1)
    {
        throw new Error('layout: maxPasses must be a whole number >= 1');
    }
    let guess = firstGuess;
    for (let pass = 1; pass <= maxPasses; pass++)
    {
        const front = layFront(guess);
        if (front.pages === guess)
        {
            return { front, passes: pass };
        }
        guess = front.pages;
    }
    throw new Error(`layout: the index page numbers did not settle after ${String(maxPasses)} passes`);
}

/**
 * Lays out the whole document (see the top of this file). Throws an Error
 * only for an invalid config (validateLayoutConfig), a missing font, a page
 * footer wider than the text area, an index entry without its email, an
 * email without its index entry, or
 * index page numbers that do not settle (settlePageCount).
 */
export function layoutPdf(doc: PdfDocument, fonts: Readonly<Record<PdfFontName, ParsedFont>>, options: LayoutOptions): PdfLayout
{
    const baseConfig = options.config ?? DEFAULT_LAYOUT_CONFIG;
    const config: LayoutConfig = options.newPagePerEmail === undefined ? baseConfig : { ...baseConfig, newPagePerEmail: options.newPagePerEmail };
    validateLayoutConfig(config);
    const typesetter = new Typesetter(fonts, config);
    const bodyIndent = bodyIndentWidth(typesetter, config);

    // The emails, once, on pages of their own (page numbers relative to the first email page).
    const emailBuilder = new PageBuilder(config, typesetter);
    const emailPageByAnchor = new Map<string, number>();
    for (const [position, email] of doc.emails.entries())
    {
        placeEmail(emailBuilder, email, position === 0, bodyIndent, emailPageByAnchor);
    }
    const emailPages = doc.emails.length > 0 ? emailBuilder.pages : [];

    const indexEntries = doc.index.entries;
    for (const entry of indexEntries)
    {
        if (!emailPageByAnchor.has(entry.anchor))
        {
            throw new Error(`layout: the index entry ${entry.anchor} has no email`);
        }
    }
    // And the other way (task 8.13): every email laid out, with its heading and header rows, has its own index entry.
    const indexedAnchors = new Set(indexEntries.map((entry) => entry.anchor));
    for (const email of doc.emails)
    {
        if (!indexedAnchors.has(email.anchor))
        {
            throw new Error(`layout: the email ${email.anchor} has no index entry`);
        }
    }
    const laidIndex = indexEntries.length > 0 ? layIndex(typesetter, config, emailBuilder.left, emailBuilder.contentWidth, doc.index) : null;

    // The cover and the index, until the page numbers settle. Placeholders of a discarded pass are not counted.
    let discardedPlaceholders = 0;
    let lastPassPlaceholders = 0;
    const { front, passes } = settlePageCount((guess) =>
    {
        discardedPlaceholders += lastPassPlaceholders;
        const placeholdersBefore = typesetter.placeholders;
        const frontBuilder = new PageBuilder(config, typesetter);
        frontBuilder.addDestination(COVER_DESTINATION, 0);
        for (const block of doc.cover.blocks)
        {
            placeBlock(frontBuilder, block);
        }
        if (laidIndex !== null)
        {
            placeIndex(frontBuilder, laidIndex, (anchor) => guess + emailPageByAnchor.get(anchor)! + 1);
        }
        lastPassPlaceholders = typesetter.placeholders - placeholdersBefore;
        return { builder: frontBuilder, pages: frontBuilder.pages.length };
    }, options.maxPasses ?? MAX_FRONT_PASSES);

    const frontPages = front.pages;
    const allPages = [...front.builder.pages, ...emailPages];
    const anchorPages = new Map<string, number>();
    for (const [anchor, page] of emailPageByAnchor)
    {
        anchorPages.set(anchor, frontPages + page);
    }
    const destinations = [
        ...front.builder.destinations,
        ...emailBuilder.destinations.map((destination) => ({ ...destination, page: frontPages + destination.page }))
    ];

    const outline: LaidOutOutlineItem[] = [{ title: options.strings.coverBookmark, destination: COVER_DESTINATION, children: [] }];
    if (laidIndex !== null)
    {
        outline.push({ title: doc.index.heading, destination: INDEX_DESTINATION, children: [] });
    }
    for (const entry of indexEntries)
    {
        outline.push({ title: entry.bookmark, destination: entry.anchor, children: [] });
    }

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
        placeholders: typesetter.placeholders - discardedPlaceholders,
        frontPages,
        passes,
        bodyIndent,
    };
}

/** One cover block. */
function placeBlock(builder: PageBuilder, block: PdfBlock): void
{
    const typesetter = builder.typesetter;
    const { spacing } = builder.config;
    switch (block.kind)
    {
        case 'heading': {
            if (block.level === 1)
            {
                builder.placeLines(typesetter.wrap(block.line, builder.contentWidth, 'title'));
                builder.addSpace(spacing.afterTitle);
                return;
            }
            const lines = typesetter.wrap(block.line, builder.contentWidth, 'heading');
            builder.addSpace(spacing.beforeSection);
            // Kept with the start of its section: two lines of text.
            builder.newPageUnlessFits(linesHeight(lines) + spacing.afterHeading + 2 * typesetter.lineHeight('body'));
            builder.placeLines(lines);
            builder.addSpace(spacing.afterHeading);
            return;
        }
        case 'fields':
            for (const row of block.rows)
            {
                placeFieldRow(builder, layFieldRow(builder, row));
            }
            builder.addSpace(spacing.betweenBlocks);
            return;
        case 'paragraph':
            builder.placeLines(typesetter.wrap(block.line, builder.contentWidth, 'body'));
            builder.addSpace(spacing.betweenBlocks);
            return;
        case 'list':
            for (const [position, item] of block.items.entries())
            {
                if (position > 0)
                {
                    builder.addSpace(builder.config.list.itemGap);
                }
                placeListItem(builder, layListItem(builder, item));
            }
            builder.addSpace(spacing.betweenBlocks);
            return;
    }
}

/** One email (see the pagination rules at the top of this file). */
function placeEmail(builder: PageBuilder, email: PdfEmail, isFirstEmail: boolean, bodyIndent: number, emailPageByAnchor: Map<string, number>): void
{
    const typesetter = builder.typesetter;
    const { spacing } = builder.config;
    const heading = typesetter.wrap([{ role: 'heading', text: email.heading }], builder.contentWidth, 'heading');
    const rows: LaidFieldRow[] = email.fields.map((row) => layFieldRow(builder, row));
    // Every body line one tab in (tasks 8.6 and 8.9), wrapped lines too, wrapped to the width left;
    // the notes too (only the "(no text)" placeholder, where the text would be: task 8.10).
    const bodyX = builder.left + bodyIndent;
    const notes = email.notes.flatMap((line) => typesetter.wrap(line, builder.contentWidth - bodyIndent, 'body'));
    const body = email.body.flatMap((line) => typesetter.wrap(line, builder.contentWidth - bodyIndent, 'body'));

    // The block kept together.
    const headingHeight = linesHeight(heading) + spacing.afterHeading;
    const tableHeight = rows.reduce((total, row) => total + row.height, 0);
    let keepHeight =
        headingHeight +
        tableHeight +
        spacing.afterFields +
        (notes.length > 0 ? linesHeight(notes) + spacing.afterNotes : 0) +
        linesHeight(body.slice(0, builder.config.keepBodyLines));
    if (keepHeight > builder.contentHeight)
    {
        keepHeight = headingHeight + (rows[0]?.height ?? 0);
    }

    // After this, the keep block fits below the cursor (or the page is empty).
    // `isFirstEmail` is only a safeguard: the first email starts on a fresh PageBuilder, so `!builder.atTop` is already false for it.
    if (!builder.atTop)
    {
        if (builder.config.newPagePerEmail && !isFirstEmail)
        {
            builder.newPage();
        }
        else if (!builder.fits(spacing.betweenEmails + keepHeight))
        {
            builder.newPage();
        }
        else
        {
            builder.drawRule(builder.cursorY + spacing.betweenEmails / 2);
            builder.cursorY += spacing.betweenEmails;
        }
    }

    builder.addDestination(email.anchor, builder.cursorY - spacing.destinationAbove);
    emailPageByAnchor.set(email.anchor, builder.pageIndex);
    builder.placeLines(heading);
    builder.addSpace(spacing.afterHeading);
    for (const row of rows)
    {
        placeFieldRow(builder, row);
    }
    builder.addSpace(spacing.afterFields);
    if (notes.length > 0)
    {
        builder.placeLines(notes, bodyX);
        builder.addSpace(spacing.afterNotes);
    }
    for (const bodyLine of body)
    {
        builder.placeLine(bodyLine, bodyX);
    }

    if (email.attachments !== null)
    {
        builder.addSpace(spacing.beforeAttachments);
        const label = typesetter.wrap([{ role: 'field-label', text: email.attachments.label }], builder.contentWidth, 'field-label');
        const items = email.attachments.items.map((item) => layListItem(builder, [item]));
        builder.newPageUnlessFits(linesHeight(label) + (items[0]?.lines[0]?.height ?? 0));
        builder.placeLines(label);
        for (const item of items)
        {
            placeListItem(builder, item);
        }
    }
}

/**
 * The footer of every page, now that the page count is known: one line, at
 * most the width of the text area (an Error if it is wider, never cut).
 */
function addFooters(builder: PageBuilder, allPages: readonly PageInProgress[], strings: LayoutStrings): LaidOutPage[]
{
    const typesetter = builder.typesetter;
    const { footer, page: pageConfig } = builder.config;
    const pageCount = allPages.length;
    return allPages.map((page, position) =>
    {
        const lines = typesetter.wrap([{ role: 'muted', text: strings.pageFooter(position + 1, pageCount) }], builder.contentWidth,
            'muted', typesetter.footerStyleIndex);
        if (lines.length !== 1)
        {
            throw new Error('layout: the page footer is wider than the text area');
        }
        const line = lines[0]!;
        const x = footer.align === 'right'
            ? builder.left + builder.contentWidth - line.width
            : builder.left + (builder.contentWidth - line.width) / 2;
        typesetter.drawLine(line, x, pageConfig.height - footer.baselineFromBottom - line.above, page.text);
        return page;
    });
}
