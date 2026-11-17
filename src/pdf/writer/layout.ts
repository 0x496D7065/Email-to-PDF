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
import type { ParsedFont } from '../font/font';
import type { PdfFontName } from '../fonts';

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
 * normalized by the caller, as inlineRuns in src/pdf/text.ts does):
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
