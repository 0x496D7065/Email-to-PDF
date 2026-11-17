// HTML-to-plain-text conversion for HTML-only email bodies.
//
// Email HTML is untrusted (README.md, rule R4). This converter never renders
// anything, never runs code and never loads anything: it only reads an
// already-parsed node tree and writes text. It works on a MINIMAL node
// interface (HtmlNode below) instead of the browser's DOM types, so that:
// - the unit tests can hand it small trees built by hand, in Node, without a
//   DOM library (README.md, rule R7);
// - in the browser, the tree comes from DOMParser, which is inert (see
//   html-dom.ts), and is passed in as it is.
//
// What it keeps and drops:
// - Visible text is kept. Only code and content that is never shown is
//   skipped: script, style, template, head, title, iframe, frame, frameset
//   and embed elements, and comments. (Tag names are compared in lower case,
//   so a <script> or <style> inside <svg> is skipped too.)
// - Fallback content is KEPT: the text inside noscript, object, applet,
//   canvas, audio, video, svg (e.g. <text>), math and noframes. In an email
//   reader scripts are off and nothing loads, so the fallback is exactly what
//   the reader sees (DOMParser documents have scripting off as well, so
//   <noscript> holds normal markup). Dropping it would silently lose text
//   (README.md, rule R6).
// - Neither CSS nor the `hidden` attribute is applied: text hidden with an
//   inline `style="display:none"` (for example a newsletter "preheader") or
//   with `hidden` is KEPT. Both are only presentation; deciding what a reader
//   saw from them is easy to fool, and keeping too much text is safer than
//   silently losing some (README.md, rule R6).
// - Links: only the visible text is kept. The link target (href) is never
//   written, not even when the visible text is empty: a target is not message
//   text, is often a long tracking address, and can be a `javascript:` or
//   `data:` URL. It stays in the original file.
// - Images: never loaded. An image becomes its `alt` text if it has one,
//   otherwise nothing.
// - Form buttons keep their visible label: <input type="submit|button|reset">
//   gives its `value`, <input type="image"> its `alt`.
// - Attributes: only `alt`, `start` (numbered lists), and `type` and `value`
//   (inputs) are ever read. Every other attribute (`src`, `href`, `srcset`,
//   `on*` event handlers, `background`, `style`, ...) is never read.
// - Layout: block elements start new lines (paragraphs, headings, quotes and
//   preformatted blocks are surrounded by a blank line); `<br>` breaks a line;
//   list items start with "- " (or "1. ", "2. ", ... in a numbered list),
//   nested lists are indented by two spaces per level; table cells are
//   separated by " | " when they share an output line (a cell that starts a
//   new line, for example one holding a <p>, gets no separator) and rows by
//   line breaks; every line inside a
//   <blockquote> starts with "> " per quote level (used later to fold quoted
//   history); whitespace is collapsed like a browser does, except inside
//   <pre> (and textarea, listing, xmp, plaintext), where it is kept.
// - Output: lines are trimmed (inside <pre>, only at the end), there is at
//   most one blank line in a row (also inside <pre>), no blank line at the
//   start or end, and every line ends with "\n" (no trailing "\n").
//
// Hard limits against hostile input (README.md, rule R4):
// - Nesting deeper than `maxDepth` elements is not dropped: the text of the
//   deeper part is kept, flattened into running text (block elements become
//   spaces, the skip rules above still apply), so nothing is lost
//   (README.md, rule R6). The walk below the limit uses a loop, not
//   recursion, so a deep tree cannot overflow the call stack.
// - Output longer than `maxOutputLength` characters is cut, and a note line
//   saying so is added at the end; the result also says `truncated: true`,
//   so the adapters can warn ('html-body-truncated'). The full text stays in
//   the original file.

/**
 * The few node properties the converter reads. A browser DOM Node (and a
 * Document) fits this shape as it is; tests build plain objects.
 */
export interface HtmlNode {
    /** 1 element, 3 text, 4 CDATA, 8 comment, 9 document, 10 doctype, 11 fragment. */
    readonly nodeType: number;
    /** Tag name for an element (any case), '#text' etc. otherwise. */
    readonly nodeName: string;
    /** The text of a text node; null for elements. */
    readonly nodeValue: string | null;
    readonly childNodes: ArrayLike<HtmlNode>;
    /** Present on elements only. */
    getAttribute?(name: string): string | null;
}

export interface HtmlToTextLimits {
    /** Element nesting depth walked with full layout; deeper text is flattened. */
    readonly maxDepth: number;
    /** Longest output, in characters, before the text is cut with a note. */
    readonly maxOutputLength: number;
}

/**
 * Default limits. Real email HTML nests a few dozen levels (layout tables
 * inside layout tables); 500 is far above that. 5 million characters is
 * thousands of printed pages, far beyond any real message.
 */
export const DEFAULT_LIMITS: HtmlToTextLimits = { maxDepth: 500, maxOutputLength: 5_000_000 };

/** The note added after a body cut at maxOutputLength. */
export function truncationNote(maxOutputLength: number): string
{
    return `[Text cut here: this HTML body is longer than ${String(maxOutputLength)} characters. The full text stays in the original email file.]`;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const CDATA_SECTION_NODE = 4;
const DOCUMENT_NODE = 9;
const DOCUMENT_FRAGMENT_NODE = 11;

/**
 * Elements whose content is code or never shown, so never message text (see
 * the header comment). Fallback containers (noscript, object, video, svg,
 * ...) are deliberately NOT listed: their text is what a reader sees.
 */
const SKIPPED: ReadonlySet<string> = new Set(['script', 'style', 'template', 'head', 'title', 'iframe', 'frame', 'frameset', 'embed']);

/** Input types whose `value` is the visible button label. */
const BUTTON_INPUTS: ReadonlySet<string> = new Set(['submit', 'button', 'reset']);

/** Block elements surrounded by a blank line. */
const PARAGRAPH_BLOCKS: ReadonlySet<string> = new Set([
    'p',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'blockquote',
    'pre',
    'hr',
    'listing',
    'xmp',
    'plaintext',
]);

/** Block elements that start and end a line. */
const LINE_BLOCKS: ReadonlySet<string> = new Set([
    'address',
    'article',
    'aside',
    'body',
    'caption',
    'center',
    'dd',
    'details',
    'dialog',
    'dir',
    'div',
    'dl',
    'dt',
    'fieldset',
    'figcaption',
    'figure',
    'footer',
    'form',
    'header',
    'hgroup',
    'html',
    'legend',
    'li',
    'main',
    'menu',
    'nav',
    'ol',
    'search',
    'section',
    'summary',
    'table',
    'tbody',
    'tfoot',
    'thead',
    'tr',
    'ul',
]);

/** Elements whose whitespace is kept as it is. */
const PREFORMATTED: ReadonlySet<string> = new Set(['pre', 'textarea', 'listing', 'xmp', 'plaintext']);

/** Lists whose items get a number instead of "- ". */
const ORDERED_LISTS: ReadonlySet<string> = new Set(['ol']);
const LISTS: ReadonlySet<string> = new Set(['ul', 'ol', 'menu', 'dir']);

/** The converted text, and whether it was cut at maxOutputLength. */
export interface HtmlToTextResult {
    /** Plain text; when cut, it ends with the truncationNote line. */
    readonly text: string;
    /** True if the text was cut at maxOutputLength (the note is then in `text` too). */
    readonly truncated: boolean;
}

/** Converts a parsed HTML tree (a document, fragment or element) to plain text. */
export function htmlTreeToText(root: HtmlNode, limits: HtmlToTextLimits = DEFAULT_LIMITS): HtmlToTextResult
{
    const writer = new TextWriter(limits.maxOutputLength);
    new Walker(writer, limits.maxDepth).walkChildren(root, 0);
    const text = writer.finish();
    if (!writer.full) return { text, truncated: false };
    let kept = text.slice(0, limits.maxOutputLength);
    // Never keep half of a surrogate pair (an emoji, for example): the cut
    // moves back one character instead.
    if (/[\uD800-\uDBFF]$/.test(kept)) kept = kept.slice(0, -1);
    return { text: `${kept.trimEnd()}\n\n${truncationNote(limits.maxOutputLength)}`, truncated: true };
}

/** One finished output line, before the quote prefix and trimming are applied. */
interface Line {
    readonly text: string;
    /** Blockquote level: the number of "> " prefixes. */
    readonly quote: number;
    /** List indentation and marker, written before the trimmed text. */
    readonly lead: string;
    /** Holds preformatted text: trimmed at the end only. */
    readonly pre: boolean;
}

/**
 * Builds lines from text pieces and break requests. Breaks are requested
 * lazily ("at least one line break" / "at least a blank line before the next
 * text") and only applied when more text arrives, so empty elements and
 * nested blocks never pile up empty lines.
 */
class TextWriter
{
    /** Set once the output reached the length limit: nothing more is written. */
    full = false;
    /** Current blockquote level. */
    quote = 0;

    private readonly lines: Line[] = [];
    private current = '';
    private currentQuote = 0;
    private currentLead = '';
    private currentPre = false;
    /** Pending break before the next text: 0 none, 1 new line, 2 blank line. */
    private pending = 0;
    /**
     * Table cell separators (" | ") held back until the next text. They are
     * written only if that text lands on the same output line; any break
     * requested before it drops them (see Walker.cell).
     */
    private separators = 0;
    /** List marker (with indentation) waiting for the first text of a list item. */
    private marker: string | null = null;
    private length = 0;

    constructor(private readonly maxLength: number)
    {}

    /** Number of text pieces written so far (only ever grows). */
    pieces = 0;

    /** A line break is waiting to be applied before the next text. */
    get breakPending(): boolean
    {
        return this.pending > 0;
    }

    /** Asks for a line break (1) or a blank line (2) before the next text; drops held cell separators. */
    requestBreak(kind: 1 | 2): void
    {
        this.pending = Math.max(this.pending, kind);
        this.separators = 0;
    }

    /** Holds back one " | " cell separator until the next text (see `separators`). */
    holdSeparator(): void
    {
        this.separators++;
    }

    setMarker(marker: string | null): void
    {
        this.marker = marker;
    }

    /** Text that follows the browser's whitespace collapsing. */
    inline(text: string): void
    {
        let piece = text.replace(/[ \t\n\f\r]+/g, ' ');
        // Only whitespace while separators are held: the separators bring their
        // own spaces, and writing this space now would flush them too early.
        if (this.separators > 0 && /^ *$/.test(piece)) return;
        // A space at the start of a line, or after another space, is dropped.
        if (piece.startsWith(' ') && (this.pending > 0 || this.current === '' || this.current.endsWith(' ')))
        {
            piece = piece.slice(1);
        }
        this.append(piece, false);
    }

    /** Preformatted text: every space is kept, each line break starts a new line. */
    preformatted(text: string): void
    {
        text.split(/\r\n?|\n/).forEach((segment, index) =>
        {
            if (index > 0) this.lineBreak();
            this.append(segment, true);
        });
    }

    /** A forced line break (<br>, or a line end inside <pre>). Two in a row give a blank line. */
    lineBreak(): void
    {
        this.separators = 0;
        if (this.full) return;
        this.applyPending();
        this.pushLine();
    }

    /** All lines, rendered: quote prefixes, trimming, at most one blank line in a row. */
    finish(): string
    {
        if (this.current !== '') this.pushLine();
        const out: string[] = [];
        let previousBlank = true; // drops blank lines at the start
        for (const line of this.lines)
        {
            const content = line.pre ? line.text.trimEnd() : line.text.trim();
            const prefix = '> '.repeat(line.quote);
            if (content === '')
            {
                if (!previousBlank) out.push(prefix.trimEnd());
                previousBlank = true;
            }
            else
            {
                out.push(`${prefix}${line.lead}${content}`);
                previousBlank = false;
            }
        }
        if (previousBlank && out.length > 0) out.pop(); // a blank line at the end
        return out.join('\n');
    }

    private append(piece: string, pre: boolean): void
    {
        if (piece === '' || this.full) return;
        this.applyPending();
        let text = piece;
        if (this.separators > 0)
        {
            // No break came since the separators were held: this text shares the
            // line with the previous cell. One space before the first "|" unless
            // there is one already (or the line is empty), one after each.
            const before = this.current === '' || this.current.endsWith(' ') ? '' : ' ';
            text = `${before}${'| '.repeat(this.separators)}${pre ? piece : piece.replace(/^ /, '')}`;
            this.separators = 0;
        }
        this.pieces++;
        if (this.current === '')
        {
            this.currentQuote = this.quote;
            this.currentLead = this.marker ?? '';
            this.marker = null;
            // The line end before this line, the quote prefix and the list marker
            // count too: 500 quote levels would otherwise multiply a short text a
            // thousandfold. Blank lines made by <br> are not counted: runs of
            // blank lines collapse to one in finish(), so at most every other
            // output line is blank.
            //
            // Worked example: <p>a</p><blockquote><blockquote><ul><li>x gives
            // "a\n\n> > - x", 10 characters. Counted: 1 for "a" (the first line,
            // so no line end before it); 1 for the blank line (in applyPending);
            // then here 1 (the "\n" before this line) + 2 * 2 ("> > ") + 2 ("- ");
            // and 1 for "x" below. Total 1 + 1 + 7 + 1 = 10.
            this.count((this.lines.length > 0 ? 1 : 0) + 2 * this.quote + this.currentLead.length);
        }
        this.current += text;
        this.currentPre ||= pre;
        this.count(text.length);
    }

    /** Adds to the output length; at the limit, the writer stops taking text. */
    private count(characters: number): void
    {
        this.length += characters;
        if (this.length > this.maxLength) this.full = true;
    }

    private applyPending(): void
    {
        if (this.pending === 0) return;
        if (this.current !== '') this.pushLine();
        const last = this.lines.at(-1);
        if (this.pending === 2 && last !== undefined && last.text.trim() !== '')
        {
            // A blank line between two quote levels belongs to the outer one.
            const quote = Math.min(last.quote, this.quote);
            this.lines.push({ text: '', quote, lead: '', pre: false });
            // Its "\n" plus its quote prefix: at quote level 0 that is exactly 1
            // (an empty line). At level 2 the line is "> >" plus "\n", 4
            // characters, counted as 5: an upper bound is enough.
            this.count(2 * quote + 1);
        }
        this.pending = 0;
    }

    private pushLine(): void
    {
        const empty = this.current === '';
        this.lines.push({
            text: this.current,
            quote: empty ? this.quote : this.currentQuote,
            lead: empty ? '' : this.currentLead,
            pre: this.currentPre,
        });
        this.current = '';
        this.currentLead = '';
        this.currentPre = false;
    }
}

/** Numbering state of one open list. */
interface ListState {
    readonly ordered: boolean;
    next: number;
}

/** Walks the tree and feeds the writer. */
class Walker
{
    private preDepth = 0;
    private readonly lists: ListState[] = [];
    /**
     * Each open table row, innermost last: its cell count, and writer.pieces
     * when the row began (to tell whether the row has written text yet).
     */
    private readonly rows: { cells: number; piecesAtStart: number }[] = [];

    constructor(
        private readonly writer: TextWriter,
        private readonly maxDepth: number,
    )
    {}

    /** Walks the children of `node`, which sits at element depth `depth`. */
    walkChildren(node: HtmlNode, depth: number): void
    {
        const children = node.childNodes;
        for (let i = 0; i < children.length && !this.writer.full; i++)
        {
            const child = children[i];
            if (child === undefined) continue;
            if (child.nodeType === ELEMENT_NODE && depth >= this.maxDepth)
            {
                flattenText(child, this.writer);
            }
            else
            {
                this.walk(child, depth);
            }
        }
    }

    private walk(node: HtmlNode, depth: number): void
    {
        switch (node.nodeType)
        {
            case TEXT_NODE:
            case CDATA_SECTION_NODE:
                if (this.preDepth > 0) this.writer.preformatted(node.nodeValue ?? '');
                else this.writer.inline(node.nodeValue ?? '');
                return;
            case DOCUMENT_NODE:
            case DOCUMENT_FRAGMENT_NODE:
                this.walkChildren(node, depth);
                return;
            case ELEMENT_NODE:
                this.element(node, depth + 1);
                return;
            default:
                // Comments, doctypes, processing instructions: never text.
                return;
        }
    }

    /** An element at element depth `depth` (1 for a top-level element). */
    private element(node: HtmlNode, depth: number): void
    {
        const name = node.nodeName.toLowerCase();
        if (isSkipped(name)) return;
        const writer = this.writer;

        if (name === 'br')
        {
            writer.lineBreak();
            return;
        }
        if (name === 'img')
        {
            writer.inline(altText(node));
            return;
        }
        if (name === 'input')
        {
            writer.inline(inputText(node));
            return;
        }

        const breakKind = PARAGRAPH_BLOCKS.has(name) ? 2 : LINE_BLOCKS.has(name) ? 1 : 0;
        if (breakKind > 0) writer.requestBreak(breakKind as 1 | 2);

        if (name === 'blockquote') writer.quote++;
        if (PREFORMATTED.has(name)) this.preDepth++;
        if (LISTS.has(name)) this.lists.push({ ordered: ORDERED_LISTS.has(name), next: listStart(node) });
        if (name === 'li') writer.setMarker(this.listMarker());
        if (name === 'tr') this.rows.push({ cells: 0, piecesAtStart: writer.pieces });
        if (name === 'td' || name === 'th') this.cell();

        this.walkChildren(node, depth);

        if (name === 'tr') this.rows.pop();
        if (name === 'li') writer.setMarker(null); // an item with no text gets no marker line
        if (LISTS.has(name)) this.lists.pop();
        if (PREFORMATTED.has(name)) this.preDepth--;
        if (name === 'blockquote') writer.quote--;

        if (breakKind > 0) writer.requestBreak(breakKind as 1 | 2);
    }

    /** "- " in a bullet list, "N. " in a numbered list, indented two spaces per nesting level. */
    private listMarker(): string
    {
        const list = this.lists.at(-1);
        const indent = '  '.repeat(Math.max(0, this.lists.length - 1));
        if (list === undefined || !list.ordered) return `${indent}- `;
        return `${indent}${String(list.next++)}. `;
    }

    /**
     * Separates a table cell from the previous cell of the same row with " | ",
     * but only when both end up on the same output line. The separator is held
     * back by the writer and dropped if a line break comes before the cell's
     * first text. Example (Outlook writes every cell's text in a <p>):
     * <td><p>Name</p></td><td><p>Value</p></td> gives "Name", a blank line,
     * "Value", never a lone "|" line between them.
     *
     * A break already pending when the cell starts drops it too, unless the
     * row has written no text yet: that break only starts the row, so leading
     * empty cells stay visible ("| b").
     */
    private cell(): void
    {
        const row = this.rows.at(-1);
        if (row === undefined) return;
        const rowHasText = this.writer.pieces > row.piecesAtStart;
        if (row.cells > 0 && !(rowHasText && this.writer.breakPending)) this.writer.holdSeparator();
        row.cells++;
    }
}

/** Skipped element: code or never-shown content (SKIPPED). No attribute is checked. */
function isSkipped(name: string): boolean
{
    return SKIPPED.has(name);
}

function altText(node: HtmlNode): string
{
    return node.getAttribute?.('alt') ?? '';
}

/**
 * The visible label of an <input>: the `value` of a submit, button or reset
 * input, the `alt` of an image input, else nothing. Only `type`, `value` and
 * `alt` are read (never `src`, `formaction` or handlers).
 */
function inputText(node: HtmlNode): string
{
    const type = node.getAttribute?.('type')?.trim().toLowerCase() ?? '';
    if (BUTTON_INPUTS.has(type)) return node.getAttribute?.('value') ?? '';
    if (type === 'image') return altText(node);
    return '';
}

/** The first number of an ordered list: its `start` attribute, else 1. */
function listStart(node: HtmlNode): number
{
    const start = node.getAttribute?.('start')?.trim() ?? '';
    return /^-?\d{1,9}$/.test(start) ? Number(start) : 1;
}

/**
 * The text of a subtree below the depth limit, as running text: no layout,
 * but the same skip rules, so code and styles never leak in. Uses an explicit
 * stack instead of recursion, so any depth is safe.
 */
function flattenText(root: HtmlNode, writer: TextWriter): void
{
    const SPACE = ' ';
    const stack: (HtmlNode | typeof SPACE)[] = [root];
    while (stack.length > 0 && !writer.full)
    {
        const item = stack.pop();
        if (item === undefined) break;
        if (item === SPACE)
        {
            writer.inline(SPACE);
            continue;
        }
        if (item.nodeType === TEXT_NODE || item.nodeType === CDATA_SECTION_NODE)
        {
            writer.inline(item.nodeValue ?? '');
            continue;
        }
        if (item.nodeType !== ELEMENT_NODE) continue;
        const name = item.nodeName.toLowerCase();
        if (isSkipped(name)) continue;
        if (name === 'img' || name === 'input')
        {
            writer.inline(name === 'img' ? altText(item) : inputText(item));
            continue;
        }
        // A block or line break becomes a space, so words of two blocks never merge.
        const block = name === 'br' || PARAGRAPH_BLOCKS.has(name) || LINE_BLOCKS.has(name) || name === 'td' || name === 'th';
        if (block) stack.push(SPACE);
        const children = item.childNodes;
        for (let i = children.length - 1; i >= 0; i--)
        {
            const child = children[i];
            if (child !== undefined) stack.push(child);
        }
        if (block) stack.push(SPACE);
    }
}
