// Header: the laid-out document and the layout settings. Shared types only,
// no code (README.md, "Where things are"). pdf-export/page-layout/ produces
// the document (with LayoutConfig, whose defaults are DEFAULT_LAYOUT_CONFIG in
// Source/pdf-export/page-layout/config.ts); a PdfBackend in
// pdf-export/pdf-writer/ writes it; pdf-export/generate.ts connects the two.
//
// The laid-out document: the contract between the layout (milestone 5.4c,
// which wraps lines and fills pages) and a PDF backend (which only writes
// bytes). Everything is already placed: the backend makes no layout
// decision, it draws exactly what is here.
//
// Plain data only (numbers, strings, arrays, plain objects): structured-clone
// safe, so it can cross a worker boundary, and renderer-neutral, so another
// backend (e.g. one built on pdfkit) could consume the same type.
//
// Coordinates are PDF points (1/72 inch) with the origin at the TOP-LEFT
// corner of the page and y growing DOWNWARD (as a layout thinks, and as
// pdfkit uses); the backend converts to PDF's bottom-left origin.
//
// Text in here may come from email data and is untrusted (README.md, rule
// R4): a backend only ever writes it as hex-encoded string data, never as
// PDF syntax.

import type { PdfRole } from './pdf-document-model';
import type { ParsedFont, PdfFontName } from './pdf-fonts';

/** A grey level (0 black to 1 white) or an RGB colour (each 0 to 1). */
export type LaidOutColor = { readonly gray: number } | { readonly rgb: readonly [number, number, number] };

/** A rectangle: top-left corner and size, in points (y downward). */
export interface LaidOutRect
{
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

/**
 * One run of glyphs in one font, size and colour, on one baseline.
 *
 * `glyphs` are glyph ids of the font (already shaped by the layout: one per
 * code point in our simple layout). `glyphText[i]` is the text glyph i
 * stands for ("e", U+0301 for a combining acute, "[" for the first glyph of a
 * drawn code "[U+1F600]"): the backend builds each font's ToUnicode map from
 * it (the first text seen for a glyph wins).
 *
 * `copyText` is what a reader gets when copying or searching this run (the
 * copy layer, "what you can copy is what you see"). When it differs from
 * what the ToUnicode map yields for the glyphs, the backend wraps the run in
 * a marked-content span with this text as /ActualText.
 *
 * `actualText`, when set, is ALWAYS written as /ActualText (and `copyText`
 * is then only informative).
 *
 * Both are passed through copyLayerText (copy-text.ts) by the backend.
 */
export interface LaidOutTextRun
{
    readonly font: PdfFontName;
    /** Font size in points. */
    readonly size: number;
    /** Start of the baseline. */
    readonly x: number;
    readonly y: number;
    readonly color: LaidOutColor;
    readonly glyphs: readonly number[];
    /** Same length as `glyphs`. */
    readonly glyphText: readonly string[];
    readonly copyText: string;
    readonly actualText?: string;
}

/** A filled rectangle (grey bars, backgrounds). */
export interface LaidOutFill extends LaidOutRect
{
    readonly color: LaidOutColor;
}

/** A straight line (rules). */
export interface LaidOutLine
{
    readonly x1: number;
    readonly y1: number;
    readonly x2: number;
    readonly y2: number;
    /** Line width in points. */
    readonly width: number;
    readonly color: LaidOutColor;
}

/** A clickable area that jumps to a named destination (internal only: no URLs). */
export interface LaidOutLink
{
    readonly rect: LaidOutRect;
    readonly destination: string;
}

/**
 * One page. The backend paints fills first, then lines, then text, so text
 * is always on top of grey bars.
 */
export interface LaidOutPage
{
    readonly fills: readonly LaidOutFill[];
    readonly lines: readonly LaidOutLine[];
    readonly text: readonly LaidOutTextRun[];
    readonly links: readonly LaidOutLink[];
}

/**
 * A named place a link or bookmark jumps to: the top of the view is put at
 * `y` (points from the top of the page) on page `page` (0-based index).
 * Names are made by our code, never from email data: only A-Z a-z 0-9 . _ -
 */
export interface LaidOutDestination
{
    readonly name: string;
    readonly page: number;
    readonly y: number;
}

/**
 * A bookmark. `title` may come from email data (subjects, senders). Outline
 * titles and info.title must already be one-line text (tabs and line breaks
 * normalized by the caller, as inlineRuns in Source/pdf-export/text.ts does):
 * copyLayerText turns any left into U+FFFD.
 */
export interface LaidOutOutlineItem
{
    readonly title: string;
    readonly destination: string;
    readonly children: readonly LaidOutOutlineItem[];
    /** Shown expanded when the file opens (default: collapsed). */
    readonly open?: boolean;
}

/**
 * Document information: the title and the producing tool's name. Nothing
 * else on purpose (no dates, no author, no keywords).
 */
export interface LaidOutInfo
{
    readonly title: string;
    readonly producer: string;
}

/** The whole laid-out document: the input of a PdfBackend. */
export interface LaidOutDocument
{
    /** Size of every page, in points. */
    readonly pageSize: { readonly width: number; readonly height: number };
    readonly pages: readonly LaidOutPage[];
    readonly destinations: readonly LaidOutDestination[];
    readonly outline: readonly LaidOutOutlineItem[];
    readonly info: LaidOutInfo;
}

/** The parsed fonts a backend may embed (only the ones the document uses are). */
export type PdfFontSet = Readonly<Partial<Record<PdfFontName, ParsedFont>>>;

/**
 * Turns a laid-out document into PDF file bytes. Rejects only with an Error.
 * (The method is `render`, not `write`: the lint rules ban any `.write`
 * property, a backstop against document.write, README.md, rule R4.)
 */
export interface PdfBackend
{
    render(doc: LaidOutDocument, fonts: PdfFontSet): Promise<Uint8Array>;
}

/** How one kind of text looks. */
export interface TextStyle
{
    readonly font: PdfFontName;
    /** Font size in points. */
    readonly size: number;
    readonly color: LaidOutColor;
    /** Line height as a multiple of the size (see the top of typesetter.ts for the baseline). */
    readonly lineHeight: number;
}

export interface LayoutConfig
{
    /** Page size in points (A4 by default). */
    readonly page: { readonly width: number; readonly height: number };
    /** Text area margins. The footer sits inside the bottom margin. */
    readonly margin: { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number };
    /** The look of each text role (Header/pdf-document-model.ts, PdfRole). 'code' is also used for missing-glyph placeholders. */
    readonly roles: Readonly<Record<PdfRole, TextStyle>>;
    /** The page footer ("Page 3 of 12"): its style, and its baseline's distance from the page bottom. */
    readonly footer: { readonly style: TextStyle; readonly baselineFromBottom: number; readonly align: 'center' | 'right' };
    /** Label/value tables (email header rows, the cover summary). */
    readonly fields: { readonly labelWidth: number; readonly gap: number; readonly rowGap: number };
    /** Lists (cover): the bullet and the indent of the item text. */
    readonly list: { readonly bullet: string; readonly indent: number; readonly itemGap: number };
    /**
     * How far every line of an email body is indented from the left margin,
     * as a number of normal spaces (U+0020) of the body style: the indent is
     * this many times the space's advance in roles.body's font at roles.body's
     * size, measured from the font when the layout starts (pdf-layout.ts,
     * bodyIndentWidth). Default TAB_WIDTH (4): one tab, as a tab in the text
     * is printed (Source/pdf-export/text.ts transform b; user decision 2026-11-06, task
     * 8.9; before it a fixed 14 pt, task 8.6). One step for every body line,
     * wrapped lines included, whatever its quote level (quote marks are
     * removed, Source/pdf-export/text.ts transform g), for real and rebuilt emails
     * alike. The heading, the header rows and the attachments stay at the
     * margin. A whole number >= 1 (validateLayoutConfig); the width it gives
     * must be at most half the text area width (checked by layoutPdf, which
     * has the fonts).
     */
    readonly bodyIndentSpaces: number;
    /**
     * The index table: the widths of its fixed columns (the subject column
     * takes the rest of the text area), the gap between two columns, the space
     * below each row and below the column titles. The date column holds the
     * short date "YYYY-MM-DD HH:mm" (body style) on one line; the page column
     * holds a page number of up to INDEX_PAGE_DIGITS digits (body style).
     */
    readonly index: {
        readonly numberWidth: number;
        readonly dateWidth: number;
        readonly fromWidth: number;
        readonly pageWidth: number;
        readonly gap: number;
        readonly rowGap: number;
        readonly headerGap: number;
    };
    readonly spacing: {
        /** After the document title. */
        readonly afterTitle: number;
        /** Before a section heading of the cover (not at the top of a page). */
        readonly beforeSection: number;
        /** After a section heading or an email heading. */
        readonly afterHeading: number;
        /** Between two cover blocks. */
        readonly betweenBlocks: number;
        /** After an email's header table. */
        readonly afterFields: number;
        /** After an email's notes. */
        readonly afterNotes: number;
        /** Before an email's attachment list. */
        readonly beforeAttachments: number;
        /** Between two emails on one page; the rule is drawn in the middle. */
        readonly betweenEmails: number;
        /** A destination (link or bookmark target) is put this far above its heading. */
        readonly destinationAbove: number;
    };
    /** The thin rule between two emails. */
    readonly rule: { readonly width: number; readonly color: LaidOutColor };
    /**
     * Start every email on a new page (default true, user decision 2026-11-02);
     * false: emails follow each other, a rule between.
     */
    readonly newPagePerEmail: boolean;
    /** An email starts on a page only if its heading, header table, notes and this many body lines fit there. */
    readonly keepBodyLines: number;
}
