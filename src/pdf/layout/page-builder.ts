// The page builder: a cursor going down the text area of the current page,
// a new page when the next thing does not fit, and the pieces each page
// holds (text runs, rules, links). Coordinates as in src/pdf/writer/layout.ts:
// points, origin top-left, y downward. Pure (README.md, rule R7).
import type { LaidOutDestination, LaidOutFill, LaidOutLine, LaidOutLink, LaidOutTextRun } from '../writer/layout';
import type { LayoutConfig } from './config';
import type { LaidLine, Typesetter } from './typesetter';

/** A page while it is being filled. */
export interface PageInProgress {
    readonly fills: LaidOutFill[];
    readonly lines: LaidOutLine[];
    readonly text: LaidOutTextRun[];
    readonly links: LaidOutLink[];
}

/** Rounding slack, in points. */
const EPSILON = 1e-6;

/** Destination names the backend accepts (made by our code only). */
const DESTINATION_NAME = /^[A-Za-z0-9._-]{1,127}$/;

export class PageBuilder
{
    readonly pages: PageInProgress[] = [];
    readonly destinations: LaidOutDestination[] = [];
    /** Top of the next thing to place. */
    y: number;
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    /** Width of the text area. */
    readonly width: number;

    constructor(
        readonly config: LayoutConfig,
        readonly typesetter: Typesetter,
    )
    {
        this.top = config.margin.top;
        this.bottom = config.page.height - config.margin.bottom;
        this.left = config.margin.left;
        this.width = config.page.width - config.margin.left - config.margin.right;
        if (!(this.width > 0 && this.bottom > this.top)) throw new Error('layout: the margins leave no room for text');
        this.y = this.top;
        this.newPage();
    }

    /** Height of the text area. */
    get contentHeight(): number
    {
        return this.bottom - this.top;
    }

    get page(): PageInProgress
    {
        return this.pages[this.pages.length - 1]!;
    }

    /** 0-based index of the current page. */
    get pageIndex(): number
    {
        return this.pages.length - 1;
    }

    /** Nothing placed on the current page yet. */
    get atTop(): boolean
    {
        return this.y <= this.top + EPSILON;
    }

    newPage(): void
    {
        this.pages.push({ fills: [], lines: [], text: [], links: [] });
        this.y = this.top;
    }

    fits(height: number): boolean
    {
        return this.y + height <= this.bottom + EPSILON;
    }

    /** Starts a new page unless `height` fits below the cursor (or the page is still empty). */
    ensure(height: number): void
    {
        if (!this.atTop && !this.fits(height)) this.newPage();
    }

    /** Vertical space; none at the top of a page. */
    space(height: number): void
    {
        if (!this.atTop) this.y += height;
    }

    /** Places one line at `x` (a new page first if it does not fit). */
    place(line: LaidLine, x: number = this.left): void
    {
        this.ensure(line.height);
        this.typesetter.emit(line, x, this.y, this.page.text);
        this.y += line.height;
    }

    placeAll(lines: readonly LaidLine[], x: number = this.left): void
    {
        for (const line of lines) this.place(line, x);
    }

    /** A horizontal rule across the text area at height `y` of the current page. */
    rule(y: number): void
    {
        const { width, color } = this.config.rule;
        this.page.lines.push({ x1: this.left, y1: y, x2: this.left + this.width, y2: y, width, color });
    }

    /** A named destination at `y` of the current page (clamped to the page). */
    destination(name: string, y: number): void
    {
        if (!DESTINATION_NAME.test(name)) throw new Error(`layout: invalid destination name ${JSON.stringify(name).slice(0, 80)}`);
        this.destinations.push({ name, page: this.pageIndex, y: Math.max(0, y) });
    }
}
