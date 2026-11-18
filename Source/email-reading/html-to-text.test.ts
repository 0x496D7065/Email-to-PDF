// Unit tests for the pure HTML-to-text converter. The trees are built by hand
// with the small helpers below (README.md, rule R7): no DOM library, no real
// email. The browser path (DOMParser) is tested in Helper/Test/browser-tests/html-to-text.spec.ts.

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
function elementNode(name: string, attributes: Record<string, string> = {}, ...children: Child[]): HtmlNode
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
function documentNode(...children: Child[]): HtmlNode
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
const convert = (...children: Child[]): string => textOf(documentNode(...children));

describe('htmlTreeToText: block layout', () =>
{
    it('separates paragraphs by one blank line', () =>
    {
        expect(convert(elementNode('p', {}, 'Hello'), elementNode('p', {}, 'World'))).toBe('Hello\n\nWorld');
    });

    it('puts div content on its own lines, without blank lines', () =>
    {
        expect(convert(elementNode('div', {}, 'one'), elementNode('div', {}, 'two'), 'three')).toBe('one\ntwo\nthree');
    });

    it('nested blocks do not pile up empty lines', () =>
    {
        expect(convert(elementNode('div', {}, elementNode('div', {}, elementNode('p', {}, 'a')), elementNode('div', {}, elementNode('div', {}, 'b'))))).toBe('a\n\nb');
    });

    it('a heading is followed by a blank line', () =>
    {
        expect(convert(elementNode('h1', {}, 'Title'), 'Text')).toBe('Title\n\nText');
    });

    it('<br> breaks a line; two give a blank line; more never give more than one', () =>
    {
        expect(convert('a', elementNode('br'), 'b')).toBe('a\nb');
        expect(convert('a', elementNode('br'), elementNode('br'), 'b')).toBe('a\n\nb');
        expect(convert('a', elementNode('br'), elementNode('br'), elementNode('br'), elementNode('br'), 'b')).toBe('a\n\nb');
    });

    it('has no blank lines at the start or end, and only \\n line ends', () =>
    {
        const text = convert(elementNode('br'), elementNode('p', {}, ''), elementNode('p', {}, 'x'), elementNode('br'), elementNode('br'), elementNode('p', {}, ' '));
        expect(text).toBe('x');
        expect(convert(elementNode('pre', {}, 'a\r\nb\rc'))).toBe('a\nb\nc');
    });

    it('walks a document fragment and a bare element the same way', () =>
    {
        const fragment: HtmlNode = { nodeType: 11, nodeName: '#document-fragment', nodeValue: null, childNodes: [elementNode('p', {}, 'x')] };
        expect(textOf(fragment)).toBe('x');
        expect(textOf(elementNode('div', {}, elementNode('p', {}, 'y')))).toBe('y');
    });
});

describe('htmlTreeToText: whitespace', () =>
{
    it('collapses spaces, tabs and line breaks like a browser and trims each line', () =>
    {
        expect(convert(elementNode('p', {}, '  Hello \n\t  world  '))).toBe('Hello world');
    });

    it('collapses across inline elements, and never adds a space between them', () =>
    {
        expect(convert(elementNode('p', {}, 'a ', elementNode('b', {}, ' b '), ' c'))).toBe('a b c');
        expect(convert(elementNode('p', {}, 'un', elementNode('b', {}, 'break'), 'able'))).toBe('unbreakable');
    });

    it('keeps a no-break space inside a line, drops it at the ends of a line', () =>
    {
        expect(convert(elementNode('p', {}, '10 %'), elementNode('p', {}, ' '), elementNode('p', {}, ' x '))).toBe('10 %\n\nx');
    });

    it('<pre> keeps spaces, tabs and line breaks (lines trimmed at the end only)', () =>
    {
        const text = convert(elementNode('p', {}, 'Before'), elementNode('pre', {}, '  indented  \n\tTab ', elementNode('b', {}, 'bold'), '\n\nend'), 'After');
        expect(text).toBe('Before\n\n  indented\n\tTab bold\n\nend\n\nAfter');
    });

    it('collapses runs of blank lines inside <pre> too', () =>
    {
        expect(convert(elementNode('pre', {}, 'a\n\n\n\nb'))).toBe('a\n\nb');
    });

    it('<textarea> keeps its whitespace like <pre>', () =>
    {
        expect(convert(elementNode('textarea', {}, 'a  b\n c'))).toBe('a  b\n c');
    });
});

describe('htmlTreeToText: skipped content', () =>
{
    it.each(['script', 'style', 'template', 'head', 'title', 'iframe', 'frame', 'frameset', 'embed'])(
        '<%s> content never reaches the text',
        (tag) =>
        {
            expect(convert(elementNode('p', {}, 'before ', elementNode(tag, {}, 'SKIPPED-CONTENT'), ' after'))).toBe('before after');
        },
    );

    it('script and style code never leak, even with a markup-like body', () =>
    {
        const text = convert(
            elementNode('head', {}, elementNode('style', {}, 'body { font-family: sans-serif; }')),
            elementNode('body', {}, elementNode('script', {}, "document.title = 'SCRIPT-RAN';"), elementNode('p', {}, 'Visible')),
        );
        expect(text).toBe('Visible');
    });

    it('skips comments', () =>
    {
        expect(convert(elementNode('p', {}, 'a', commentNode(' secret note '), 'b'))).toBe('ab');
    });

    it('ignores the hidden attribute, like CSS: that text is KEPT (never silently lost)', () =>
    {
        expect(convert(elementNode('p', {}, 'shown'), elementNode('p', { hidden: '' }, 'Hidden one'), elementNode('div', { hidden: 'until-found' }, 'Hidden two'))).toBe(
            'shown\n\nHidden one\n\nHidden two',
        );
    });

    it('ignores CSS: text hidden with an inline display:none is KEPT (never silently lost)', () =>
    {
        expect(convert(elementNode('p', { style: 'display:none' }, 'Preheader'), elementNode('p', {}, 'Body'))).toBe('Preheader\n\nBody');
    });

    it('skips doctypes and processing instructions', () =>
    {
        const doctype: HtmlNode = { nodeType: 10, nodeName: 'html', nodeValue: null, childNodes: [] };
        const processingInstruction: HtmlNode = { nodeType: 7, nodeName: 'xml', nodeValue: 'version="1.0"', childNodes: [] };
        expect(convert(doctype, processingInstruction, elementNode('p', {}, 'x'))).toBe('x');
    });
});

describe('htmlTreeToText: fallback text is kept (an email reader shows it: scripts off, nothing loads)', () =>
{
    /** An element whose name keeps its case, as a browser reports SVG and MathML names ("text", "foreignObject"). */
    function foreignElementNode(name: string, ...children: Child[]): HtmlNode
    {
        return { ...elementNode('x', {}, ...children), nodeName: name };
    }

    it.each(['noscript', 'object', 'applet', 'canvas', 'audio', 'video', 'svg', 'math', 'noframes'])(
        '<%s> fallback content reaches the text',
        (tag) =>
        {
            expect(convert(elementNode('p', {}, 'before ', elementNode(tag, {}, 'Fallback'), ' after'))).toBe('before Fallback after');
        },
    );

    it('<noscript> holds normal markup (DOMParser documents have scripting off): its blocks keep their layout', () =>
    {
        expect(convert(elementNode('noscript', {}, elementNode('p', {}, 'Please read this message in a browser.')), elementNode('p', {}, 'Body'))).toBe(
            'Please read this message in a browser.\n\nBody',
        );
    });

    it('SVG <text> is kept; <style>, <script> and <title> inside SVG stay skipped', () =>
    {
        const svg = foreignElementNode(
            'svg',
            foreignElementNode('title', 'SVG-TITLE'),
            foreignElementNode('style', '.a { fill: red; }'),
            foreignElementNode('script', "window.__e2eFlags.push('svg-script')"),
            foreignElementNode('text', 'Sales up 10%'),
            foreignElementNode('foreignObject', foreignElementNode('div', 'Inside')),
        );
        expect(convert(elementNode('p', {}, 'Chart: '), svg)).toBe('Chart:\n\nSales up 10%\nInside');
    });

    it('MathML keeps its text', () =>
    {
        expect(
            convert(
                elementNode(
                    'p',
                    {},
                    'Total: ',
                    foreignElementNode('math', foreignElementNode('mi', 'x'), foreignElementNode('mo', '='), foreignElementNode('mn', '42'))
                )
            )
        ).toBe('Total: x=42');
    });

    it('<video>, <audio> and <object> fallback text is kept; their src, poster and data never appear', () =>
    {
        const text = convert(
            elementNode(
                'video',
                { src: 'https://video.invalid/v.mp4', poster: 'https://poster.invalid/p.png' },
                elementNode('source', { src: 'https://video.invalid/s.mp4' }),
                'Video fallback'
            ),
            ' ',
            elementNode('audio', { src: 'https://audio.invalid/a.mp3' }, 'Audio fallback'),
            ' ',
            elementNode('object', { data: 'https://object.invalid/o.bin' }, elementNode('param', { name: 'movie', value: 'https://object.invalid/m' }), 'Object fallback'),
        );
        expect(text).toBe('Video fallback Audio fallback Object fallback');
    });
});

describe('htmlTreeToText: links, images and attributes', () =>
{
    it('keeps only the visible link text: never the href, never a javascript: URL, never on* handlers', () =>
    {
        const text = convert(
            elementNode(
                'p',
                { onclick: "alert('CLICK-RAN')" },
                elementNode('a', { href: 'https://shop.example.invalid/spring?ref=42', onclick: "alert('CLICK-RAN')" }, 'Book a visit'),
                ' - ',
                elementNode('a', { href: "javascript:alert('JS-LINK-RAN')" }, 'unsubscribe'),
            ),
        );
        expect(text).toBe('Book a visit - unsubscribe');
    });

    it('a link with no visible text gives nothing (its href is not written)', () =>
    {
        expect(convert(elementNode('p', {}, 'a', elementNode('a', { href: 'https://example.invalid/x' }), 'b'))).toBe('ab');
    });

    it('an image becomes its alt text; its src (a remote URL) and onerror never appear', () =>
    {
        const text = convert(
            elementNode('p', {}, 'Logo: ', elementNode('img', { src: 'https://tracker.invalid/logo.png', alt: 'Sample Furniture', onerror: "alert('ONERROR-RAN')" })),
        );
        expect(text).toBe('Logo: Sample Furniture');
    });

    it('an image with no alt (a tracking pixel) gives nothing', () =>
    {
        const text = convert(elementNode('p', {}, 'x', elementNode('img', { src: 'https://tracker.invalid/p.png', width: '1', height: '1' }), 'y'));
        expect(text).toBe('xy');
    });

    it('background attributes and inline CSS urls never appear', () =>
    {
        const text = convert(
            elementNode(
                'table',
                { background: 'https://tracker.invalid/bg.png' },
                elementNode('tr', {}, elementNode('td', { style: "background:url('https://tracker.invalid/c.png')" }, 'cell'))
            ),
        );
        expect(text).toBe('cell');
    });

    it('a submit, button or reset input gives its value; an image input its alt; other inputs nothing', () =>
    {
        const text = convert(
            elementNode(
                'form',
                { action: 'https://form.invalid/submit' },
                elementNode('input', { type: 'text', value: 'TYPED-VALUE', name: 'q' }),
                elementNode('input', { value: 'NO-TYPE-VALUE' }),
                elementNode('input', { type: 'hidden', value: 'HIDDEN-TOKEN' }),
                elementNode('input', { type: 'SUBMIT', value: 'Confirm' }),
                ' ',
                elementNode('input', { type: ' button ', value: 'Details', onclick: "alert('CLICK-RAN')" }),
                ' ',
                elementNode('input', { type: 'reset', value: 'Clear' }),
                ' ',
                elementNode('input', { type: 'image', src: 'https://tracker.invalid/b.png', alt: 'Buy now', formaction: 'https://form.invalid/x' }),
                elementNode('input', { type: 'image', src: 'https://tracker.invalid/c.png' }),
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
            elementNode('p', {}, 'My answer.'),
            elementNode('blockquote', {}, elementNode('p', {}, 'First quoted line', elementNode('br'), 'second'), elementNode('p', {}, 'Quoted paragraph')),
            elementNode('p', {}, 'After'),
        );
        expect(text).toBe('My answer.\n\n> First quoted line\n> second\n>\n> Quoted paragraph\n\nAfter');
    });

    it('nested quotes add one "> " per level, and the levels stay separate', () =>
    {
        const text = convert(
            elementNode('blockquote', {}, 'Level one', elementNode('blockquote', {}, 'Level two', elementNode('blockquote', {}, 'Level three')), 'Back to one'),
        );
        // Going from level 3 straight back to level 1 gives one blank line, at level 1.
        expect(text).toBe('> Level one\n>\n> > Level two\n> >\n> > > Level three\n>\n> Back to one');
    });

    it('a blank line between two levels belongs to the outer level', () =>
    {
        expect(convert(elementNode('blockquote', {}, 'a', elementNode('blockquote', {}, 'b')))).toBe('> a\n>\n> > b');
    });
});

describe('htmlTreeToText: lists', () =>
{
    it('bullet list items start with "- "', () =>
    {
        expect(convert(elementNode('ul', {}, elementNode('li', {}, 'one'), elementNode('li', {}, 'two')))).toBe('- one\n- two');
    });

    it('numbered list items start with "1. ", "2. ", ...; `start` is respected', () =>
    {
        expect(convert(elementNode('ol', {}, elementNode('li', {}, 'one'), elementNode('li', {}, 'two')))).toBe('1. one\n2. two');
        expect(convert(elementNode('ol', { start: '3' }, elementNode('li', {}, 'c'), elementNode('li', {}, 'd')))).toBe('3. c\n4. d');
        expect(convert(elementNode('ol', { start: 'x' }, elementNode('li', {}, 'a')))).toBe('1. a');
    });

    it('nested lists are indented by two spaces per level', () =>
    {
        const text = convert(
            elementNode(
                'ul',
                {},
                elementNode(
                    'li',
                    {},
                    'parent',
                    elementNode('ol', {}, elementNode('li', {}, 'child'), elementNode('li', {}, elementNode('p', {}, 'para child')))
                ),
                elementNode('li', {}, 'next')
            ),
        );
        // A paragraph inside an item gets its blank lines, as in a browser.
        expect(text).toBe('- parent\n  1. child\n\n  2. para child\n\n- next');
    });

    it('an empty item gives no marker line; a <br> inside an item continues without a marker', () =>
    {
        expect(convert(elementNode('ul', {}, elementNode('li', {}), elementNode('li', {}, 'a', elementNode('br'), 'b')))).toBe('- a\nb');
    });

    it('a list inside a quote gets both prefixes', () =>
    {
        expect(convert(elementNode('blockquote', {}, elementNode('ul', {}, elementNode('li', {}, 'x'))))).toBe('> - x');
    });
});

describe('htmlTreeToText: tables', () =>
{
    it('separates cells with " | " and rows with line breaks', () =>
    {
        const text = convert(
            elementNode(
                'table',
                {},
                elementNode('thead', {}, elementNode('tr', {}, elementNode('th', {}, 'Item'), elementNode('th', {}, 'Price'))),
                elementNode(
                    'tbody',
                    {},
                    elementNode('tr', {}, elementNode('td', {}, 'Chair'), elementNode('td', {}, 'EUR 120')),
                    elementNode('tr', {}, elementNode('td', {}, 'Desk'), elementNode('td', {}, 'EUR 300'))
                ),
            ),
        );
        expect(text).toBe('Item | Price\nChair | EUR 120\nDesk | EUR 300');
    });

    it('keeps an empty cell visible', () =>
    {
        expect(convert(elementNode('table', {}, elementNode('tr', {}, elementNode('td', {}, 'a'), elementNode('td', {}), elementNode('td', {}, 'c'))))).toBe('a | | c');
    });

    it('a nested table counts its own cells; the next outer cell starts a new line, so it gets no separator', () =>
    {
        const inner = elementNode('table', {}, elementNode('tr', {}, elementNode('td', {}, 'x'), elementNode('td', {}, 'y')));
        expect(convert(elementNode('table', {}, elementNode('tr', {}, elementNode('td', {}, inner), elementNode('td', {}, 'b'))))).toBe('x | y\nb');
    });

    it('Outlook style: a <p class="MsoNormal"> in each cell gives no lone "|" line', () =>
    {
        const paragraph = (text: string): HtmlNode => elementNode('p', { class: 'MsoNormal' }, text);
        const whitespace = '\n  '; // the whitespace between Outlook's tags
        const table = elementNode(
            'table',
            { class: 'MsoNormalTable' },
            elementNode(
                'tbody',
                {},
                whitespace,
                elementNode(
                    'tr',
                    {},
                    whitespace,
                    elementNode('td', {}, whitespace, paragraph('Name'), whitespace),
                    whitespace,
                    elementNode('td', {}, whitespace, paragraph('Value'), whitespace),
                    whitespace
                ),
                whitespace
            ),
        );
        expect(convert(table)).toBe('Name\n\nValue');
    });

    it('plain cells with whitespace between the tags still share one line', () =>
    {
        const whitespace = '\n  ';
        const row = (a: string, b: string): HtmlNode =>
            elementNode('tr', {}, whitespace, elementNode('td', {}, ` ${a} `), whitespace, elementNode('td', {}, whitespace, b, whitespace), whitespace);
        expect(
            convert(elementNode('table', {}, elementNode('tbody', {}, whitespace, row('Name', 'Value'), whitespace, row('Date', '2 June'), whitespace)))
        ).toBe('Name | Value\nDate | 2 June');
    });

    it('a plain cell next to a <p> cell: the separator is dropped because the <p> starts a new line', () =>
    {
        expect(convert(elementNode('table', {}, elementNode('tr', {}, elementNode('td', {}, 'Name'), elementNode('td', {}, elementNode('p', {}, 'Value')))))).toBe('Name\n\nValue');
        expect(convert(elementNode('table', {}, elementNode('tr', {}, elementNode('td', {}, elementNode('p', {}, 'Name')), elementNode('td', {}, 'Value'))))).toBe('Name\n\nValue');
    });

    it('a <br> at the start of a cell drops the separator; inline markup in a cell keeps it', () =>
    {
        expect(convert(elementNode('table', {}, elementNode('tr', {}, elementNode('td', {}, 'a'), elementNode('td', {}, elementNode('br'), 'b'))))).toBe('a\nb');
        expect(convert(elementNode('table', {}, elementNode('tr', {}, elementNode('td', {}, 'a'), elementNode('td', {}, elementNode('b', {}, 'bold'), ' b'))))).toBe('a | bold b');
    });

    it('leading empty cells stay visible; a trailing empty cell adds nothing', () =>
    {
        expect(convert(elementNode('table', {}, elementNode('tr', {}, elementNode('td', {}), elementNode('td', {}, 'b'))))).toBe('| b');
        expect(
            convert(
                elementNode('p', {}, 'before'),
                elementNode('table', {}, elementNode('tr', {}, elementNode('td', {}), elementNode('td', {}), elementNode('td', {}, 'c')))
            )
        ).toBe('before\n\n| | c');
        expect(
            convert(
                elementNode('table', {}, elementNode('tr', {}, elementNode('td', {}, 'a'), elementNode('td', {})), elementNode('tr', {}, elementNode('td', {}, 'c')))
            )
        ).toBe('a\nc');
    });
});

describe('htmlTreeToText: depth limit', () =>
{
    /** `levels` nested elements of `tag`, the innermost holding `inner`. */
    function nested(tag: string, levels: number, inner: Child[]): HtmlNode
    {
        let node = elementNode(tag, {}, ...inner);
        for (let i = 1; i < levels; i++)
        {
            node = elementNode(tag, {}, node);
        }
        return node;
    }

    const small: HtmlToTextLimits = { maxDepth: 3, maxOutputLength: DEFAULT_LIMITS.maxOutputLength };

    it('keeps the text below the limit, flattened into running text (layout dropped, words kept apart)', () =>
    {
        const deep = nested('div', 5, [
            elementNode('p', {}, 'deep one'),
            elementNode('p', {}, 'deep', elementNode('b', {}, 'er')),
            elementNode('ul', {}, elementNode('li', {}, 'item'))
        ]);
        const text = textOf(documentNode(elementNode('p', {}, 'top'), deep), small);
        expect(text).toBe('top\n\ndeep one deeper item');
    });

    it('below the limit, skipped elements stay skipped, hidden and fallback text is kept, images give their alt, buttons their value', () =>
    {
        const deep = nested('div', 5, [
            elementNode('script', {}, 'SCRIPT'),
            elementNode('style', {}, 'STYLE'),
            elementNode('p', { hidden: '' }, 'Hidden'),
            elementNode('noscript', {}, 'Fallback'),
            ' text',
            elementNode('img', { alt: 'pic', src: 'https://tracker.invalid/p.png' }),
            elementNode('input', { type: 'submit', value: 'Go' }),
        ]);
        expect(textOf(documentNode(deep), small)).toBe('Hidden Fallback textpicGo');
    });

    it('a tree 100 000 levels deep is converted without a stack overflow, its text kept', () =>
    {
        const deep = nested('div', 100_000, ['bottom']);
        expect(textOf(documentNode('top', deep))).toBe('top\nbottom');
    });

    it('the layout is kept up to exactly maxDepth levels', () =>
    {
        // Depth 3 (the limit) still gets blocks; its children at depth 4 are flattened.
        const tree = elementNode('div', {}, elementNode('div', {}, elementNode('p', {}, elementNode('b', {}, 'x'), elementNode('div', {}, 'flat'))));
        expect(textOf(documentNode(tree, elementNode('div', {}, elementNode('div', {}, elementNode('p', {}, 'a'), elementNode('p', {}, 'b')))), small)).toBe('x flat\n\na\n\nb');
    });
});

describe('htmlTreeToText: output limit', () =>
{
    it('cuts the text at maxOutputLength and says so in a note line', () =>
    {
        const limits: HtmlToTextLimits = { maxDepth: 500, maxOutputLength: 50 };
        const text = textOf(documentNode(...Array.from({ length: 100 }, (_, i) => elementNode('p', {}, `Paragraph ${String(i)}`))), limits);
        expect(text.endsWith(`\n\n${truncationNote(50)}`)).toBe(true);
        const body = text.slice(0, -truncationNote(50).length - 2);
        expect(body.length).toBeLessThanOrEqual(50);
        expect(body.startsWith('Paragraph 0\n\nParagraph 1\n\n')).toBe(true);
    });

    it('reports the cut: truncated is true only when the text was cut', () =>
    {
        const tree = documentNode(elementNode('p', {}, 'x'.repeat(20)));
        expect(htmlTreeToText(tree, { maxDepth: 500, maxOutputLength: 10 })).toEqual({
            text: `${'x'.repeat(10)}\n\n${truncationNote(10)}`,
            truncated: true,
        });
        expect(htmlTreeToText(tree)).toEqual({ text: 'x'.repeat(20), truncated: false });
    });

    it('a text exactly at the limit is not cut', () =>
    {
        expect(htmlTreeToText(documentNode(elementNode('p', {}, 'x'.repeat(10))), { maxDepth: 500, maxOutputLength: 10 })).toEqual({
            text: 'x'.repeat(10),
            truncated: false,
        });
    });

    it('never cuts a surrogate pair (an emoji) in half', () =>
    {
        const text = textOf(documentNode(elementNode('p', {}, 'ab\u{1F600}cd')), { maxDepth: 500, maxOutputLength: 3 });
        expect(text).toBe(`ab\n\n${truncationNote(3)}`);
        expect(textOf(documentNode(elementNode('p', {}, 'ab\u{1F600}cd')), { maxDepth: 500, maxOutputLength: 4 })).toBe(`ab\u{1F600}\n\n${truncationNote(4)}`);
    });

    it('counts line ends, blank lines, quote prefixes and list markers exactly (the worked example in append)', () =>
    {
        // "a\n\n> > - x" is 10 characters: fits a limit of 10, is cut at 9.
        const tree = documentNode(elementNode('p', {}, 'a'), elementNode('blockquote', {}, elementNode('blockquote', {}, elementNode('ul', {}, elementNode('li', {}, 'x')))));
        expect(htmlTreeToText(tree, { maxDepth: 500, maxOutputLength: 10 })).toEqual({ text: 'a\n\n> > - x', truncated: false });
        expect(htmlTreeToText(tree, { maxDepth: 500, maxOutputLength: 9 }).truncated).toBe(true);
    });

    it('quote prefixes count towards the limit: deep quotes cannot blow up the output', () =>
    {
        let tree = elementNode('p', {}, ...Array.from({ length: 1000 }, () => [elementNode('br'), 'x']).flat());
        for (let i = 0; i < 400; i++)
        {
            tree = elementNode('blockquote', {}, tree);
        }
        const limits: HtmlToTextLimits = { maxDepth: 500, maxOutputLength: 10_000 };
        const text = textOf(documentNode(tree), limits);
        expect(text.length).toBeLessThanOrEqual(10_000 + truncationNote(10_000).length + 2);
        expect(text.endsWith(truncationNote(10_000))).toBe(true);
        expect(text.startsWith(`${'> '.repeat(400)}x`)).toBe(true);
    });
});
