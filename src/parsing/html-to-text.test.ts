// Unit tests for the pure HTML-to-text converter. The trees are built by hand
// with the small helpers below (README.md, rule R7): no DOM library, no real
// email. The browser path (DOMParser) is tested in e2e/html-to-text.spec.ts.

import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS, htmlTreeToText, truncationNote, type HtmlNode, type HtmlToTextLimits } from './html-to-text';

type Child = HtmlNode | string;

function textNode(value: string): HtmlNode
{
    return { nodeType: 3, nodeName: '#text', nodeValue: value, childNodes: [] };
}

function commentNode(value: string): HtmlNode
{
    return { nodeType: 8, nodeName: '#comment', nodeValue: value, childNodes: [] };
}

/** An element. Tag names are written in upper case, as a browser reports them for HTML. */
function h(name: string, attributes: Record<string, string> = {}, ...children: Child[]): HtmlNode
{
    return {
        nodeType: 1,
        nodeName: name.toUpperCase(),
        nodeValue: null,
        childNodes: children.map((c) => (typeof c === 'string' ? textNode(c) : c)),
        getAttribute: (attribute) => (Object.hasOwn(attributes, attribute) ? (attributes[attribute] ?? null) : null),
    };
}

/** A document (nodeType 9) holding the children. */
function doc(...children: Child[]): HtmlNode
{
    return {
        nodeType: 9,
        nodeName: '#document',
        nodeValue: null,
        childNodes: children.map((c) => (typeof c === 'string' ? textNode(c) : c)),
    };
}

/** The text only (most tests do not hit the output limit). */
const textOf = (root: HtmlNode, limits?: HtmlToTextLimits): string => htmlTreeToText(root, limits).text;
const convert = (...children: Child[]): string => textOf(doc(...children));

describe('htmlTreeToText: block layout', () =>
{
    it('separates paragraphs by one blank line', () =>
    {
        expect(convert(h('p', {}, 'Hello'), h('p', {}, 'World'))).toBe('Hello\n\nWorld');
    });

    it('puts div content on its own lines, without blank lines', () =>
    {
        expect(convert(h('div', {}, 'one'), h('div', {}, 'two'), 'three')).toBe('one\ntwo\nthree');
    });

    it('nested blocks do not pile up empty lines', () =>
    {
        expect(convert(h('div', {}, h('div', {}, h('p', {}, 'a')), h('div', {}, h('div', {}, 'b'))))).toBe('a\n\nb');
    });

    it('a heading is followed by a blank line', () =>
    {
        expect(convert(h('h1', {}, 'Title'), 'Text')).toBe('Title\n\nText');
    });

    it('<br> breaks a line; two give a blank line; more never give more than one', () =>
    {
        expect(convert('a', h('br'), 'b')).toBe('a\nb');
        expect(convert('a', h('br'), h('br'), 'b')).toBe('a\n\nb');
        expect(convert('a', h('br'), h('br'), h('br'), h('br'), 'b')).toBe('a\n\nb');
    });

    it('has no blank lines at the start or end, and only \\n line ends', () =>
    {
        const text = convert(h('br'), h('p', {}, ''), h('p', {}, 'x'), h('br'), h('br'), h('p', {}, ' '));
        expect(text).toBe('x');
        expect(convert(h('pre', {}, 'a\r\nb\rc'))).toBe('a\nb\nc');
    });

    it('walks a document fragment and a bare element the same way', () =>
    {
        const fragment: HtmlNode = { nodeType: 11, nodeName: '#document-fragment', nodeValue: null, childNodes: [h('p', {}, 'x')] };
        expect(textOf(fragment)).toBe('x');
        expect(textOf(h('div', {}, h('p', {}, 'y')))).toBe('y');
    });
});

describe('htmlTreeToText: whitespace', () =>
{
    it('collapses spaces, tabs and line breaks like a browser and trims each line', () =>
    {
        expect(convert(h('p', {}, '  Hello \n\t  world  '))).toBe('Hello world');
    });

    it('collapses across inline elements, and never adds a space between them', () =>
    {
        expect(convert(h('p', {}, 'a ', h('b', {}, ' b '), ' c'))).toBe('a b c');
        expect(convert(h('p', {}, 'un', h('b', {}, 'break'), 'able'))).toBe('unbreakable');
    });

    it('keeps a no-break space inside a line, drops it at the ends of a line', () =>
    {
        expect(convert(h('p', {}, '10 %'), h('p', {}, ' '), h('p', {}, ' x '))).toBe('10 %\n\nx');
    });

    it('<pre> keeps spaces, tabs and line breaks (lines trimmed at the end only)', () =>
    {
        const text = convert(h('p', {}, 'Before'), h('pre', {}, '  indented  \n\tTab ', h('b', {}, 'bold'), '\n\nend'), 'After');
        expect(text).toBe('Before\n\n  indented\n\tTab bold\n\nend\n\nAfter');
    });

    it('collapses runs of blank lines inside <pre> too', () =>
    {
        expect(convert(h('pre', {}, 'a\n\n\n\nb'))).toBe('a\n\nb');
    });

    it('<textarea> keeps its whitespace like <pre>', () =>
    {
        expect(convert(h('textarea', {}, 'a  b\n c'))).toBe('a  b\n c');
    });
});

describe('htmlTreeToText: skipped content', () =>
{
    it.each(['script', 'style', 'template', 'head', 'title', 'iframe', 'frame', 'frameset', 'embed'])(
        '<%s> content never reaches the text',
        (tag) =>
        {
            expect(convert(h('p', {}, 'before ', h(tag, {}, 'SKIPPED-CONTENT'), ' after'))).toBe('before after');
        },
    );

    it('script and style code never leak, even with a markup-like body', () =>
    {
        const text = convert(
            h('head', {}, h('style', {}, 'body { font-family: sans-serif; }')),
            h('body', {}, h('script', {}, "document.title = 'SCRIPT-RAN';"), h('p', {}, 'Visible')),
        );
        expect(text).toBe('Visible');
    });

    it('skips comments', () =>
    {
        expect(convert(h('p', {}, 'a', commentNode(' secret note '), 'b'))).toBe('ab');
    });

    it('ignores the hidden attribute, like CSS: that text is KEPT (never silently lost)', () =>
    {
        expect(convert(h('p', {}, 'shown'), h('p', { hidden: '' }, 'Hidden one'), h('div', { hidden: 'until-found' }, 'Hidden two'))).toBe(
            'shown\n\nHidden one\n\nHidden two',
        );
    });

    it('ignores CSS: text hidden with an inline display:none is KEPT (never silently lost)', () =>
    {
        expect(convert(h('p', { style: 'display:none' }, 'Preheader'), h('p', {}, 'Body'))).toBe('Preheader\n\nBody');
    });

    it('skips doctypes and processing instructions', () =>
    {
        const doctype: HtmlNode = { nodeType: 10, nodeName: 'html', nodeValue: null, childNodes: [] };
        const pi: HtmlNode = { nodeType: 7, nodeName: 'xml', nodeValue: 'version="1.0"', childNodes: [] };
        expect(convert(doctype, pi, h('p', {}, 'x'))).toBe('x');
    });
});

describe('htmlTreeToText: fallback text is kept (an email reader shows it: scripts off, nothing loads)', () =>
{
    /** An element whose name keeps its case, as a browser reports SVG and MathML names ("text", "foreignObject"). */
    function el(name: string, ...children: Child[]): HtmlNode
    {
        return { ...h('x', {}, ...children), nodeName: name };
    }

    it.each(['noscript', 'object', 'applet', 'canvas', 'audio', 'video', 'svg', 'math', 'noframes'])(
        '<%s> fallback content reaches the text',
        (tag) =>
        {
            expect(convert(h('p', {}, 'before ', h(tag, {}, 'Fallback'), ' after'))).toBe('before Fallback after');
        },
    );

    it('<noscript> holds normal markup (DOMParser documents have scripting off): its blocks keep their layout', () =>
    {
        expect(convert(h('noscript', {}, h('p', {}, 'Please read this message in a browser.')), h('p', {}, 'Body'))).toBe(
            'Please read this message in a browser.\n\nBody',
        );
    });

    it('SVG <text> is kept; <style>, <script> and <title> inside SVG stay skipped', () =>
    {
        const svg = el(
            'svg',
            el('title', 'SVG-TITLE'),
            el('style', '.a { fill: red; }'),
            el('script', "window.__e2eFlags.push('svg-script')"),
            el('text', 'Sales up 10%'),
            el('foreignObject', el('div', 'Inside')),
        );
        expect(convert(h('p', {}, 'Chart: '), svg)).toBe('Chart:\n\nSales up 10%\nInside');
    });

    it('MathML keeps its text', () =>
    {
        expect(convert(h('p', {}, 'Total: ', el('math', el('mi', 'x'), el('mo', '='), el('mn', '42'))))).toBe('Total: x=42');
    });

    it('<video>, <audio> and <object> fallback text is kept; their src, poster and data never appear', () =>
    {
        const text = convert(
            h('video', { src: 'https://video.invalid/v.mp4', poster: 'https://poster.invalid/p.png' }, h('source', { src: 'https://video.invalid/s.mp4' }), 'Video fallback'),
            ' ',
            h('audio', { src: 'https://audio.invalid/a.mp3' }, 'Audio fallback'),
            ' ',
            h('object', { data: 'https://object.invalid/o.bin' }, h('param', { name: 'movie', value: 'https://object.invalid/m' }), 'Object fallback'),
        );
        expect(text).toBe('Video fallback Audio fallback Object fallback');
    });
});

describe('htmlTreeToText: links, images and attributes', () =>
{
    it('keeps only the visible link text: never the href, never a javascript: URL, never on* handlers', () =>
    {
        const text = convert(
            h(
                'p',
                { onclick: "alert('CLICK-RAN')" },
                h('a', { href: 'https://shop.example.invalid/spring?ref=42', onclick: "alert('CLICK-RAN')" }, 'Book a visit'),
                ' - ',
                h('a', { href: "javascript:alert('JS-LINK-RAN')" }, 'unsubscribe'),
            ),
        );
        expect(text).toBe('Book a visit - unsubscribe');
    });

    it('a link with no visible text gives nothing (its href is not written)', () =>
    {
        expect(convert(h('p', {}, 'a', h('a', { href: 'https://example.invalid/x' }), 'b'))).toBe('ab');
    });

    it('an image becomes its alt text; its src (a remote URL) and onerror never appear', () =>
    {
        const text = convert(
            h('p', {}, 'Logo: ', h('img', { src: 'https://tracker.invalid/logo.png', alt: 'Sample Furniture', onerror: "alert('ONERROR-RAN')" })),
        );
        expect(text).toBe('Logo: Sample Furniture');
    });

    it('an image with no alt (a tracking pixel) gives nothing', () =>
    {
        const text = convert(h('p', {}, 'x', h('img', { src: 'https://tracker.invalid/p.png', width: '1', height: '1' }), 'y'));
        expect(text).toBe('xy');
    });

    it('background attributes and inline CSS urls never appear', () =>
    {
        const text = convert(
            h('table', { background: 'https://tracker.invalid/bg.png' }, h('tr', {}, h('td', { style: "background:url('https://tracker.invalid/c.png')" }, 'cell'))),
        );
        expect(text).toBe('cell');
    });

    it('a submit, button or reset input gives its value; an image input its alt; other inputs nothing', () =>
    {
        const text = convert(
            h(
                'form',
                { action: 'https://form.invalid/submit' },
                h('input', { type: 'text', value: 'TYPED-VALUE', name: 'q' }),
                h('input', { value: 'NO-TYPE-VALUE' }),
                h('input', { type: 'hidden', value: 'HIDDEN-TOKEN' }),
                h('input', { type: 'SUBMIT', value: 'Confirm' }),
                ' ',
                h('input', { type: ' button ', value: 'Details', onclick: "alert('CLICK-RAN')" }),
                ' ',
                h('input', { type: 'reset', value: 'Clear' }),
                ' ',
                h('input', { type: 'image', src: 'https://tracker.invalid/b.png', alt: 'Buy now', formaction: 'https://form.invalid/x' }),
                h('input', { type: 'image', src: 'https://tracker.invalid/c.png' }),
            ),
        );
        expect(text).toBe('Confirm Details Clear Buy now');
    });
});

describe('htmlTreeToText: blockquotes', () =>
{
    it('prefixes every quoted line with "> "; a blank line inside a quote becomes ">"', () =>
    {
        const text = convert(
            h('p', {}, 'My answer.'),
            h('blockquote', {}, h('p', {}, 'First quoted line', h('br'), 'second'), h('p', {}, 'Quoted paragraph')),
            h('p', {}, 'After'),
        );
        expect(text).toBe('My answer.\n\n> First quoted line\n> second\n>\n> Quoted paragraph\n\nAfter');
    });

    it('nested quotes add one "> " per level, and the levels stay separate', () =>
    {
        const text = convert(
            h('blockquote', {}, 'Level one', h('blockquote', {}, 'Level two', h('blockquote', {}, 'Level three')), 'Back to one'),
        );
        // Going from level 3 straight back to level 1 gives one blank line, at level 1.
        expect(text).toBe('> Level one\n>\n> > Level two\n> >\n> > > Level three\n>\n> Back to one');
    });

    it('a blank line between two levels belongs to the outer level', () =>
    {
        expect(convert(h('blockquote', {}, 'a', h('blockquote', {}, 'b')))).toBe('> a\n>\n> > b');
    });
});

describe('htmlTreeToText: lists', () =>
{
    it('bullet list items start with "- "', () =>
    {
        expect(convert(h('ul', {}, h('li', {}, 'one'), h('li', {}, 'two')))).toBe('- one\n- two');
    });

    it('numbered list items start with "1. ", "2. ", ...; `start` is respected', () =>
    {
        expect(convert(h('ol', {}, h('li', {}, 'one'), h('li', {}, 'two')))).toBe('1. one\n2. two');
        expect(convert(h('ol', { start: '3' }, h('li', {}, 'c'), h('li', {}, 'd')))).toBe('3. c\n4. d');
        expect(convert(h('ol', { start: 'x' }, h('li', {}, 'a')))).toBe('1. a');
    });

    it('nested lists are indented by two spaces per level', () =>
    {
        const text = convert(
            h('ul', {}, h('li', {}, 'parent', h('ol', {}, h('li', {}, 'child'), h('li', {}, h('p', {}, 'para child')))), h('li', {}, 'next')),
        );
        // A paragraph inside an item gets its blank lines, as in a browser.
        expect(text).toBe('- parent\n  1. child\n\n  2. para child\n\n- next');
    });

    it('an empty item gives no marker line; a <br> inside an item continues without a marker', () =>
    {
        expect(convert(h('ul', {}, h('li', {}), h('li', {}, 'a', h('br'), 'b')))).toBe('- a\nb');
    });

    it('a list inside a quote gets both prefixes', () =>
    {
        expect(convert(h('blockquote', {}, h('ul', {}, h('li', {}, 'x'))))).toBe('> - x');
    });
});

describe('htmlTreeToText: tables', () =>
{
    it('separates cells with " | " and rows with line breaks', () =>
    {
        const text = convert(
            h(
                'table',
                {},
                h('thead', {}, h('tr', {}, h('th', {}, 'Item'), h('th', {}, 'Price'))),
                h('tbody', {}, h('tr', {}, h('td', {}, 'Chair'), h('td', {}, 'EUR 120')), h('tr', {}, h('td', {}, 'Desk'), h('td', {}, 'EUR 300'))),
            ),
        );
        expect(text).toBe('Item | Price\nChair | EUR 120\nDesk | EUR 300');
    });

    it('keeps an empty cell visible', () =>
    {
        expect(convert(h('table', {}, h('tr', {}, h('td', {}, 'a'), h('td', {}), h('td', {}, 'c'))))).toBe('a | | c');
    });

    it('a nested table counts its own cells; the next outer cell starts a new line, so it gets no separator', () =>
    {
        const inner = h('table', {}, h('tr', {}, h('td', {}, 'x'), h('td', {}, 'y')));
        expect(convert(h('table', {}, h('tr', {}, h('td', {}, inner), h('td', {}, 'b'))))).toBe('x | y\nb');
    });

    it('Outlook style: a <p class="MsoNormal"> in each cell gives no lone "|" line', () =>
    {
        const p = (text: string): HtmlNode => h('p', { class: 'MsoNormal' }, text);
        const ws = '\n  '; // the whitespace between Outlook's tags
        const table = h(
            'table',
            { class: 'MsoNormalTable' },
            h('tbody', {}, ws, h('tr', {}, ws, h('td', {}, ws, p('Name'), ws), ws, h('td', {}, ws, p('Value'), ws), ws), ws),
        );
        expect(convert(table)).toBe('Name\n\nValue');
    });

    it('plain cells with whitespace between the tags still share one line', () =>
    {
        const ws = '\n  ';
        const row = (a: string, b: string): HtmlNode => h('tr', {}, ws, h('td', {}, ` ${a} `), ws, h('td', {}, ws, b, ws), ws);
        expect(convert(h('table', {}, h('tbody', {}, ws, row('Name', 'Value'), ws, row('Date', '2 June'), ws)))).toBe('Name | Value\nDate | 2 June');
    });

    it('a plain cell next to a <p> cell: the separator is dropped because the <p> starts a new line', () =>
    {
        expect(convert(h('table', {}, h('tr', {}, h('td', {}, 'Name'), h('td', {}, h('p', {}, 'Value')))))).toBe('Name\n\nValue');
        expect(convert(h('table', {}, h('tr', {}, h('td', {}, h('p', {}, 'Name')), h('td', {}, 'Value'))))).toBe('Name\n\nValue');
    });

    it('a <br> at the start of a cell drops the separator; inline markup in a cell keeps it', () =>
    {
        expect(convert(h('table', {}, h('tr', {}, h('td', {}, 'a'), h('td', {}, h('br'), 'b'))))).toBe('a\nb');
        expect(convert(h('table', {}, h('tr', {}, h('td', {}, 'a'), h('td', {}, h('b', {}, 'bold'), ' b'))))).toBe('a | bold b');
    });

    it('leading empty cells stay visible; a trailing empty cell adds nothing', () =>
    {
        expect(convert(h('table', {}, h('tr', {}, h('td', {}), h('td', {}, 'b'))))).toBe('| b');
        expect(convert(h('p', {}, 'before'), h('table', {}, h('tr', {}, h('td', {}), h('td', {}), h('td', {}, 'c'))))).toBe('before\n\n| | c');
        expect(convert(h('table', {}, h('tr', {}, h('td', {}, 'a'), h('td', {})), h('tr', {}, h('td', {}, 'c'))))).toBe('a\nc');
    });
});

describe('htmlTreeToText: depth limit', () =>
{
    /** `levels` nested elements of `tag`, the innermost holding `inner`. */
    function nested(tag: string, levels: number, inner: Child[]): HtmlNode
    {
        let node = h(tag, {}, ...inner);
        for (let i = 1; i < levels; i++)
        {
            node = h(tag, {}, node);
        }
        return node;
    }

    const small: HtmlToTextLimits = { maxDepth: 3, maxOutputLength: DEFAULT_LIMITS.maxOutputLength };

    it('keeps the text below the limit, flattened into running text (layout dropped, words kept apart)', () =>
    {
        const deep = nested('div', 5, [h('p', {}, 'deep one'), h('p', {}, 'deep', h('b', {}, 'er')), h('ul', {}, h('li', {}, 'item'))]);
        const text = textOf(doc(h('p', {}, 'top'), deep), small);
        expect(text).toBe('top\n\ndeep one deeper item');
    });

    it('below the limit, skipped elements stay skipped, hidden and fallback text is kept, images give their alt, buttons their value', () =>
    {
        const deep = nested('div', 5, [
            h('script', {}, 'SCRIPT'),
            h('style', {}, 'STYLE'),
            h('p', { hidden: '' }, 'Hidden'),
            h('noscript', {}, 'Fallback'),
            ' text',
            h('img', { alt: 'pic', src: 'https://tracker.invalid/p.png' }),
            h('input', { type: 'submit', value: 'Go' }),
        ]);
        expect(textOf(doc(deep), small)).toBe('Hidden Fallback textpicGo');
    });

    it('a tree 100 000 levels deep is converted without a stack overflow, its text kept', () =>
    {
        const deep = nested('div', 100_000, ['bottom']);
        expect(textOf(doc('top', deep))).toBe('top\nbottom');
    });

    it('the layout is kept up to exactly maxDepth levels', () =>
    {
        // Depth 3 (the limit) still gets blocks; its children at depth 4 are flattened.
        const tree = h('div', {}, h('div', {}, h('p', {}, h('b', {}, 'x'), h('div', {}, 'flat'))));
        expect(textOf(doc(tree, h('div', {}, h('div', {}, h('p', {}, 'a'), h('p', {}, 'b')))), small)).toBe('x flat\n\na\n\nb');
    });
});

describe('htmlTreeToText: output limit', () =>
{
    it('cuts the text at maxOutputLength and says so in a note line', () =>
    {
        const limits: HtmlToTextLimits = { maxDepth: 500, maxOutputLength: 50 };
        const text = textOf(doc(...Array.from({ length: 100 }, (_, i) => h('p', {}, `Paragraph ${String(i)}`))), limits);
        expect(text.endsWith(`\n\n${truncationNote(50)}`)).toBe(true);
        const body = text.slice(0, -truncationNote(50).length - 2);
        expect(body.length).toBeLessThanOrEqual(50);
        expect(body.startsWith('Paragraph 0\n\nParagraph 1\n\n')).toBe(true);
    });

    it('reports the cut: truncated is true only when the text was cut', () =>
    {
        const tree = doc(h('p', {}, 'x'.repeat(20)));
        expect(htmlTreeToText(tree, { maxDepth: 500, maxOutputLength: 10 })).toEqual({
            text: `${'x'.repeat(10)}\n\n${truncationNote(10)}`,
            truncated: true,
        });
        expect(htmlTreeToText(tree)).toEqual({ text: 'x'.repeat(20), truncated: false });
    });

    it('a text exactly at the limit is not cut', () =>
    {
        expect(htmlTreeToText(doc(h('p', {}, 'x'.repeat(10))), { maxDepth: 500, maxOutputLength: 10 })).toEqual({
            text: 'x'.repeat(10),
            truncated: false,
        });
    });

    it('never cuts a surrogate pair (an emoji) in half', () =>
    {
        const text = textOf(doc(h('p', {}, 'ab\u{1F600}cd')), { maxDepth: 500, maxOutputLength: 3 });
        expect(text).toBe(`ab\n\n${truncationNote(3)}`);
        expect(textOf(doc(h('p', {}, 'ab\u{1F600}cd')), { maxDepth: 500, maxOutputLength: 4 })).toBe(`ab\u{1F600}\n\n${truncationNote(4)}`);
    });

    it('counts line ends, blank lines, quote prefixes and list markers exactly (the worked example in append)', () =>
    {
        // "a\n\n> > - x" is 10 characters: fits a limit of 10, is cut at 9.
        const tree = doc(h('p', {}, 'a'), h('blockquote', {}, h('blockquote', {}, h('ul', {}, h('li', {}, 'x')))));
        expect(htmlTreeToText(tree, { maxDepth: 500, maxOutputLength: 10 })).toEqual({ text: 'a\n\n> > - x', truncated: false });
        expect(htmlTreeToText(tree, { maxDepth: 500, maxOutputLength: 9 }).truncated).toBe(true);
    });

    it('quote prefixes count towards the limit: deep quotes cannot blow up the output', () =>
    {
        let tree = h('p', {}, ...Array.from({ length: 1000 }, () => [h('br'), 'x']).flat());
        for (let i = 0; i < 400; i++)
        {
            tree = h('blockquote', {}, tree);
        }
        const limits: HtmlToTextLimits = { maxDepth: 500, maxOutputLength: 10_000 };
        const text = textOf(doc(tree), limits);
        expect(text.length).toBeLessThanOrEqual(10_000 + truncationNote(10_000).length + 2);
        expect(text.endsWith(truncationNote(10_000))).toBe(true);
        expect(text.startsWith(`${'> '.repeat(400)}x`)).toBe(true);
    });
});
