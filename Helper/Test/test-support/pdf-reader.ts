// A small, independent PDF reader for the tests only (never imported by the
// app, no dependency). It reads exactly the subset our writer
// (Source/pdf-export/pdf-writer/) emits, strictly: the header, the classic
// cross-reference table and trailer, every object at its xref offset (the
// offset must point exactly at "N 0 obj"), streams whose /Length must match
// (followed by "endstream"), FlateDecode streams inflated with the platform
// DecompressionStream, and helpers for pages, fonts, ToUnicode CMaps,
// content streams, annotations, bookmarks and named destinations.
// Anything unexpected throws, so a malformed file fails the test.

export class PdfName
{
    constructor(readonly value: string)
    {
    }
}

export class PdfRef
{
    constructor(readonly num: number)
    {
    }
}

export class PdfString
{
    constructor(
        readonly bytes: Uint8Array,
        readonly hex: boolean,
    )
    {
    }

    /** The text: UTF-16BE when it starts with the FEFF byte order mark, else Latin-1. */
    get text(): string
    {
        const stringBytes = this.bytes;
        if (stringBytes.length >= 2 && stringBytes[0] === 0xfe && stringBytes[1] === 0xff)
        {
            if (stringBytes.length % 2 !== 0)
            {
                throw new Error('odd UTF-16 string');
            }
            let decoded = '';
            for (let i = 2; i < stringBytes.length; i += 2)
            {
                decoded += String.fromCharCode((stringBytes[i]! << 8) | stringBytes[i + 1]!);
            }
            return decoded;
        }
        return String.fromCharCode(...stringBytes);
    }
}

export class PdfOp
{
    constructor(readonly op: string)
    {
    }
}

export type PdfValue = number | boolean | null | PdfName | PdfRef | PdfString | PdfValue[] | PdfDict | PdfStream;

export class PdfDict
{
    constructor(readonly entries: Map<string, PdfValue>)
    {
    }
    get(key: string): PdfValue | undefined
    {
        return this.entries.get(key);
    }
    has(key: string): boolean
    {
        return this.entries.has(key);
    }
    keys(): string[]
    {
        return [...this.entries.keys()];
    }
}

export class PdfStream
{
    constructor(
        readonly dict: PdfDict,
        readonly raw: Uint8Array,
    )
    {
    }
}

const WHITESPACE_CHARS = ' \t\r\n\f\0';
const DELIMITER_CHARS = '()<>[]{}/%';

/** A lexer + parser over a Latin-1 view of the bytes (one char per byte). */
class Lexer
{
    position: number;
    constructor(
        readonly source: string,
        readonly bytes: Uint8Array,
        start = 0,
    )
    {
        this.position = start;
    }

    skipWhite(): void
    {
        for (;;)
        {
            while (this.position < this.source.length && WHITESPACE_CHARS.includes(this.source[this.position]!))
            {
                this.position++;
            }
            if (this.source[this.position] === '%')
            {
                while (this.position < this.source.length && this.source[this.position] !== '\n' && this.source[this.position] !== '\r')
                {
                    this.position++;
                }
            }
            else
            {
                return;
            }
        }
    }

    atEnd(): boolean
    {
        this.skipWhite();
        return this.position >= this.source.length;
    }

    private word(): string
    {
        const start = this.position;
        while (this.position < this.source.length && !WHITESPACE_CHARS.includes(this.source[this.position]!)
            && !DELIMITER_CHARS.includes(this.source[this.position]!))
        {
            this.position++;
        }
        return this.source.slice(start, this.position);
    }

    /** One token as a value or an operator; `refs` turns "n 0 R" into a PdfRef. */
    value(refs = true): PdfValue | PdfOp
    {
        this.skipWhite();
        const firstChar = this.source[this.position];
        if (firstChar === undefined)
        {
            throw new Error('unexpected end of data');
        }
        if (firstChar === '/')
        {
            this.position++;
            const raw = this.word();
            if (/#/.test(raw))
            {
                throw new Error(`our writer never escapes names: /${raw}`);
            }
            return new PdfName(raw);
        }
        if (firstChar === '<' && this.source[this.position + 1] === '<')
        {
            this.position += 2;
            const entries = new Map<string, PdfValue>();
            for (;;)
            {
                this.skipWhite();
                if (this.source.startsWith('>>', this.position))
                {
                    this.position += 2;
                    return new PdfDict(entries);
                }
                const key = this.value(refs);
                if (!(key instanceof PdfName))
                {
                    throw new Error('dictionary key is not a name');
                }
                if (entries.has(key.value))
                {
                    throw new Error(`duplicate key /${key.value}`);
                }
                const entryValue = this.value(refs);
                if (entryValue instanceof PdfOp)
                {
                    throw new Error(`operator ${entryValue.op} inside a dictionary`);
                }
                entries.set(key.value, entryValue);
            }
        }
        if (firstChar === '<')
        {
            const end = this.source.indexOf('>', this.position);
            if (end < 0)
            {
                throw new Error('unterminated hex string');
            }
            const digits = this.source.slice(this.position + 1, end).replace(/\s/g, '');
            if (!/^[0-9A-Fa-f]*$/.test(digits) || digits.length % 2 !== 0)
            {
                throw new Error(`bad hex string <${digits.slice(0, 20)}>`);
            }
            this.position = end + 1;
            const bytes = new Uint8Array(digits.length / 2);
            for (let i = 0; i < bytes.length; i++)
            {
                bytes[i] = parseInt(digits.slice(2 * i, 2 * i + 2), 16);
            }
            return new PdfString(bytes, true);
        }
        if (firstChar === '(')
        {
            this.position++;
            let depth = 1;
            const literalBytes: number[] = [];
            while (depth > 0)
            {
                const char = this.source[this.position++];
                if (char === undefined)
                {
                    throw new Error('unterminated literal string');
                }
                if (char === '\\')
                {
                    const next = this.source[this.position++]!;
                    literalBytes.push(({ n: 10, r: 13, t: 9, b: 8, f: 12 } as Record<string, number>)[next] ?? next.charCodeAt(0));
                    continue;
                }
                if (char === '(')
                {
                    depth++;
                }
                if (char === ')' && --depth === 0)
                {
                    break;
                }
                literalBytes.push(char.charCodeAt(0));
            }
            return new PdfString(new Uint8Array(literalBytes), false);
        }
        if (firstChar === '[')
        {
            this.position++;
            const items: PdfValue[] = [];
            for (;;)
            {
                this.skipWhite();
                if (this.source[this.position] === ']')
                {
                    this.position++;
                    return items;
                }
                const item = this.value(refs);
                if (item instanceof PdfOp)
                {
                    throw new Error(`operator ${item.op} inside an array`);
                }
                items.push(item);
            }
        }
        if (firstChar === ']' || firstChar === '>' || firstChar === ')' || firstChar === '{' || firstChar === '}')
        {
            throw new Error(`unexpected "${firstChar}" at ${this.position}`);
        }
        const token = this.word();
        if (token === '')
        {
            throw new Error(`empty token at ${this.position}`);
        }
        if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(token))
        {
            const parsedNumber = Number(token);
            if (refs && /^\d+$/.test(token))
            {
                const savedPosition = this.position;
                const refMatch = /^\s+(\d+)\s+R(?![^\s()<>[\]{}/%])/.exec(this.source.slice(this.position, this.position + 24));
                if (refMatch)
                {
                    if (refMatch[1] !== '0')
                    {
                        throw new Error('generation must be 0');
                    }
                    this.position += refMatch[0].length;
                    return new PdfRef(parsedNumber);
                }
                this.position = savedPosition;
            }
            return parsedNumber;
        }
        if (/[eE]/.test(token) && /^[+-]?[\d.]+[eE]/.test(token))
        {
            throw new Error(`exponent notation is not PDF: ${token}`);
        }
        if (token === 'true')
        {
            return true;
        }
        if (token === 'false')
        {
            return false;
        }
        if (token === 'null')
        {
            return null;
        }
        return new PdfOp(token);
    }

    expectValue(): PdfValue
    {
        const parsed = this.value();
        if (parsed instanceof PdfOp)
        {
            throw new Error(`expected a value, got operator ${parsed.op} at ${this.position}`);
        }
        return parsed;
    }

    expect(text: string): void
    {
        this.skipWhite();
        if (!this.source.startsWith(text, this.position))
        {
            throw new Error(`expected "${text}" at ${this.position}, got ${JSON.stringify(this.source.slice(this.position, this.position + 20))}`);
        }
        this.position += text.length;
    }
}

export async function inflate(data: Uint8Array): Promise<Uint8Array>
{
    const stream = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

export class ParsedPdf
{
    readonly objects = new Map<number, PdfValue>();
    trailer!: PdfDict;
    xrefOffset = 0;
    readonly text: string;

    constructor(readonly bytes: Uint8Array)
    {
        // TextDecoder('latin1') is windows-1252, which changes 0x80-0x9F: build Latin-1 by hand.
        let latin1 = '';
        for (let i = 0; i < bytes.length; i += 8192)
        {
            latin1 += String.fromCharCode(...bytes.subarray(i, i + 8192));
        }
        this.text = latin1;
    }

    resolve(value: PdfValue | undefined): PdfValue | undefined
    {
        if (value instanceof PdfRef)
        {
            if (!this.objects.has(value.num))
            {
                throw new Error(`dangling reference ${value.num} 0 R`);
            }
            return this.objects.get(value.num);
        }
        return value;
    }

    dict(value: PdfValue | undefined): PdfDict
    {
        const resolved = this.resolve(value);
        if (resolved instanceof PdfDict)
        {
            return resolved;
        }
        if (resolved instanceof PdfStream)
        {
            return resolved.dict;
        }
        throw new Error('not a dictionary');
    }

    stream(value: PdfValue | undefined): PdfStream
    {
        const resolved = this.resolve(value);
        if (!(resolved instanceof PdfStream))
        {
            throw new Error('not a stream');
        }
        return resolved;
    }

    /** The decoded data of a stream (inflated when /FlateDecode). */
    async data(value: PdfValue | undefined): Promise<Uint8Array>
    {
        const streamObject = this.stream(value);
        const filter = streamObject.dict.get('Filter');
        if (filter === undefined)
        {
            return streamObject.raw;
        }
        if (filter instanceof PdfName && filter.value === 'FlateDecode')
        {
            return inflate(streamObject.raw);
        }
        throw new Error('unsupported filter');
    }

    async dataText(value: PdfValue | undefined): Promise<string>
    {
        const bytes = await this.data(value);
        let text = '';
        for (let i = 0; i < bytes.length; i += 8192)
        {
            text += String.fromCharCode(...bytes.subarray(i, i + 8192));
        }
        return text;
    }

    get catalog(): PdfDict
    {
        return this.dict(this.trailer.get('Root'));
    }

    get info(): PdfDict
    {
        return this.dict(this.trailer.get('Info'));
    }

    /** The page dictionaries in order, walking the page tree. */
    pages(): PdfDict[]
    {
        const pageDicts: PdfDict[] = [];
        const walk = (node: PdfDict, depth: number): void =>
        {
            if (depth > 64)
            {
                throw new Error('page tree too deep');
            }
            const type = node.get('Type');
            if (type instanceof PdfName && type.value === 'Page')
            {
                pageDicts.push(node);
                return;
            }
            const kids = node.get('Kids');
            if (!Array.isArray(kids))
            {
                throw new Error('Pages without Kids');
            }
            const before = pageDicts.length;
            for (const kid of kids)
            {
                walk(this.dict(kid), depth + 1);
            }
            if (node.get('Count') !== pageDicts.length - before)
            {
                throw new Error('Pages /Count does not match its kids');
            }
        };
        walk(this.dict(this.catalog.get('Pages')), 0);
        return pageDicts;
    }

    /** Object number of a page (to match destinations). */
    pageRefs(): number[]
    {
        const kids = this.dict(this.catalog.get('Pages')).get('Kids') as PdfValue[];
        return kids.map((k) => (k as PdfRef).num);
    }

    name(value: PdfValue | undefined): string
    {
        const resolved = this.resolve(value);
        if (!(resolved instanceof PdfName))
        {
            throw new Error('not a name');
        }
        return resolved.value;
    }
}

/** Parses a whole PDF strictly. */
export function readPdf(bytes: Uint8Array): ParsedPdf
{
    const pdf = new ParsedPdf(bytes);
    const pdfText = pdf.text;
    if (!pdfText.startsWith('%PDF-1.7\n%'))
    {
        throw new Error('header is not %PDF-1.7 + binary comment');
    }
    for (let i = 10; i < 14; i++)
    {
        if (bytes[i]! < 128)
        {
            throw new Error('binary comment needs 4 bytes above 127');
        }
    }
    if (pdfText[14] !== '\n')
    {
        throw new Error('binary comment line must end after 4 bytes');
    }
    if (!pdfText.endsWith('%%EOF\n'))
    {
        throw new Error('file must end with %%EOF');
    }
    const startxrefAt = pdfText.lastIndexOf('startxref\n');
    const startxrefMatch = /^startxref\n(\d+)\n%%EOF\n$/.exec(pdfText.slice(startxrefAt));
    if (!startxrefMatch)
    {
        throw new Error('bad startxref');
    }
    const xrefAt = Number(startxrefMatch[1]);
    pdf.xrefOffset = xrefAt;
    if (!pdfText.startsWith('xref\n', xrefAt))
    {
        throw new Error('startxref does not point at "xref"');
    }
    const head = /^xref\n0 (\d+)\n/.exec(pdfText.slice(xrefAt, xrefAt + 40));
    if (!head)
    {
        throw new Error('bad xref subsection header');
    }
    const count = Number(head[1]);
    let entryAt = xrefAt + head[0].length;
    const offsets: number[] = [];
    for (let objectNumber = 0; objectNumber < count; objectNumber++)
    {
        const entry = pdfText.slice(entryAt, entryAt + 20);
        const entryMatch = /^(\d{10}) (\d{5}) ([nf]) \n$/.exec(entry);
        if (!entryMatch)
        {
            throw new Error(`bad xref entry ${objectNumber}: ${JSON.stringify(entry)}`);
        }
        if (objectNumber === 0)
        {
            if (entry !== '0000000000 65535 f \n')
            {
                throw new Error('xref entry 0 must be free');
            }
        }
        else
        {
            if (entryMatch[3] !== 'n' || entryMatch[2] !== '00000')
            {
                throw new Error(`xref entry ${objectNumber} must be in use, generation 0`);
            }
            offsets[objectNumber] = Number(entryMatch[1]);
        }
        entryAt += 20;
    }
    const lexer = new Lexer(pdfText, bytes, entryAt);
    lexer.expect('trailer');
    const trailer = lexer.expectValue();
    if (!(trailer instanceof PdfDict))
    {
        throw new Error('trailer is not a dictionary');
    }
    lexer.expect('startxref');
    pdf.trailer = trailer;
    if (trailer.get('Size') !== count)
    {
        throw new Error('trailer /Size does not match the xref');
    }

    for (let objectNumber = 1; objectNumber < count; objectNumber++)
    {
        const offset = offsets[objectNumber]!;
        const prefix = `${objectNumber} 0 obj\n`;
        if (!pdfText.startsWith(prefix, offset))
        {
            throw new Error(`xref offset of object ${objectNumber} does not point at "${objectNumber} 0 obj"`);
        }
        const objectLexer = new Lexer(pdfText, bytes, offset + prefix.length);
        let value = objectLexer.expectValue();
        objectLexer.skipWhite();
        if (pdfText.startsWith('stream', objectLexer.position))
        {
            if (!(value instanceof PdfDict))
            {
                throw new Error('stream without dictionary');
            }
            if (!pdfText.startsWith('stream\n', objectLexer.position))
            {
                throw new Error('"stream" must be followed by LF');
            }
            const length = value.get('Length');
            if (typeof length !== 'number' || !Number.isInteger(length))
            {
                throw new Error('stream /Length must be a direct integer');
            }
            const start = objectLexer.position + 'stream\n'.length;
            if (!pdfText.startsWith('\nendstream', start + length))
            {
                throw new Error(`object ${objectNumber}: stream /Length does not match (no endstream after it)`);
            }
            value = new PdfStream(value, bytes.subarray(start, start + length));
            objectLexer.position = start + length + '\nendstream'.length;
        }
        objectLexer.expect('endobj');
        pdf.objects.set(objectNumber, value);
    }
    return pdf;
}

/** A ToUnicode CMap as glyph id -> text (bfchar and bfrange). */
export function parseToUnicode(cmap: string): Map<number, string>
{
    const map = new Map<number, string>();
    const utf16 = (hex: string): string =>
    {
        let text = '';
        for (let i = 0; i < hex.length; i += 4)
        {
            text += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
        }
        return text;
    };
    if (!/1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange/.test(cmap))
    {
        throw new Error('codespace must be <0000> <FFFF>');
    }
    for (const block of cmap.matchAll(/(\d+) beginbfchar\n([\s\S]*?)\nendbfchar/g))
    {
        const lines = block[2]!.split('\n');
        if (lines.length !== Number(block[1]) || lines.length > 100)
        {
            throw new Error('bfchar count mismatch');
        }
        for (const line of lines)
        {
            const bfcharMatch = /^<([0-9A-F]{4})> <([0-9A-F]+)>$/.exec(line);
            if (!bfcharMatch || bfcharMatch[2]!.length % 4 !== 0)
            {
                throw new Error(`bad bfchar ${line}`);
            }
            const gid = parseInt(bfcharMatch[1]!, 16);
            if (map.has(gid))
            {
                throw new Error(`glyph ${gid} mapped twice`);
            }
            map.set(gid, utf16(bfcharMatch[2]!));
        }
    }
    for (const block of cmap.matchAll(/(\d+) beginbfrange\n([\s\S]*?)\nendbfrange/g))
    {
        const lines = block[2]!.split('\n');
        if (lines.length !== Number(block[1]) || lines.length > 100)
        {
            throw new Error('bfrange count mismatch');
        }
        for (const line of lines)
        {
            const bfrangeMatch = /^<([0-9A-F]{4})> <([0-9A-F]{4})> <([0-9A-F]{4})>$/.exec(line);
            if (!bfrangeMatch)
            {
                throw new Error(`bad bfrange ${line}`);
            }
            const firstGlyph = parseInt(bfrangeMatch[1]!, 16);
            const lastGlyph = parseInt(bfrangeMatch[2]!, 16);
            const firstCode = parseInt(bfrangeMatch[3]!, 16);
            if (lastGlyph < firstGlyph || firstGlyph >> 8 !== lastGlyph >> 8 || (firstCode & 0xff) + (lastGlyph - firstGlyph) > 0xff)
            {
                throw new Error(`bfrange crosses a byte boundary: ${line}`);
            }
            for (let glyph = firstGlyph; glyph <= lastGlyph; glyph++)
            {
                if (map.has(glyph))
                {
                    throw new Error(`glyph ${glyph} mapped twice`);
                }
                map.set(glyph, String.fromCharCode(firstCode + glyph - firstGlyph));
            }
        }
    }
    return map;
}

/** One drawn text run, as read back from a content stream. */
export interface DrawnRun
{
    readonly font: string;
    readonly size: number;
    readonly x: number;
    readonly y: number;
    readonly glyphs: number[];
    readonly actualText: string | undefined;
    readonly fill: number[];
}

export interface ContentSummary
{
    readonly runs: DrawnRun[];
    readonly ops: { op: string; operands: PdfValue[] }[];
}

/** Tokenizes a content stream into operators and reads its text runs back. */
export function readContent(content: string): ContentSummary
{
    const lexer = new Lexer(content, new Uint8Array(0));
    const ops: { op: string; operands: PdfValue[] }[] = [];
    let operands: PdfValue[] = [];
    while (!lexer.atEnd())
    {
        const token = lexer.value(false);
        if (token instanceof PdfOp)
        {
            ops.push({ op: token.op, operands });
            operands = [];
        }
        else
        {
            operands.push(token);
        }
    }
    if (operands.length > 0)
    {
        throw new Error('operands left at the end of the content stream');
    }
    const allowed = new Set(['BT', 'ET', 'Tf', 'Tm', 'Tj', 'BDC', 'EMC', 'g', 'rg', 'G', 'RG', 'w', 're', 'f', 'm', 'l', 'S']);
    const runs: DrawnRun[] = [];
    let font = '';
    let size = 0;
    let x = 0;
    let y = 0;
    let fill = [0];
    let inText = false;
    const spans: (string | undefined)[] = [];
    for (const { op, operands: opOperands } of ops)
    {
        if (!allowed.has(op))
        {
            throw new Error(`unexpected operator ${op}`);
        }
        if (op === 'BT')
        {
            if (inText)
            {
                throw new Error('nested BT');
            }
            inText = true;
        }
        else if (op === 'ET')
        {
            if (!inText || spans.length > 0)
            {
                throw new Error('ET without BT or inside a span');
            }
            inText = false;
        }
        else if (op === 'Tf')
        {
            font = (opOperands[0] as PdfName).value;
            size = opOperands[1] as number;
        }
        else if (op === 'Tm')
        {
            // Positions only: a scaled, rotated or skewed matrix would make x, y and the run widths wrong.
            if (opOperands[0] !== 1 || opOperands[1] !== 0 || opOperands[2] !== 0 || opOperands[3] !== 1)
            {
                throw new Error('Tm must be 1 0 0 1 x y');
            }
            x = opOperands[4] as number;
            y = opOperands[5] as number;
        }
        else if (op === 'g' || op === 'rg')
        {
            fill = opOperands as number[];
        }
        else if (op === 'BDC')
        {
            const tag = opOperands[0] as PdfName;
            const props = opOperands[1] as PdfDict;
            if (tag.value !== 'Span')
            {
                throw new Error('only /Span marked content');
            }
            const actualTextValue = props.get('ActualText');
            if (!(actualTextValue instanceof PdfString) || !actualTextValue.hex)
            {
                throw new Error('ActualText must be a hex string');
            }
            spans.push(actualTextValue.text);
        }
        else if (op === 'EMC')
        {
            if (spans.pop() === undefined)
            {
                throw new Error('EMC without BDC');
            }
        }
        else if (op === 'Tj')
        {
            if (!inText)
            {
                throw new Error('Tj outside BT');
            }
            const hexString = opOperands[0] as PdfString;
            if (!hexString.hex || hexString.bytes.length % 2 !== 0)
            {
                throw new Error('Tj needs a 2-byte hex string');
            }
            const glyphs: number[] = [];
            for (let i = 0; i < hexString.bytes.length; i += 2)
            {
                glyphs.push((hexString.bytes[i]! << 8) | hexString.bytes[i + 1]!);
            }
            runs.push({ font, size, x, y, glyphs, actualText: spans.at(-1), fill });
        }
    }
    if (inText || spans.length > 0)
    {
        throw new Error('unclosed BT or BDC');
    }
    return { runs, ops };
}

/** The bookmark tree, checked for consistent /First /Last /Next /Prev /Parent links. */
export interface ReadOutline
{
    title: string;
    dest: string;
    count: number | undefined;
    children: ReadOutline[];
}

export function readOutline(pdf: ParsedPdf): { count: number; items: ReadOutline[] } | undefined
{
    const ref = pdf.catalog.get('Outlines');
    if (ref === undefined)
    {
        return undefined;
    }
    const root = pdf.dict(ref);
    const walk = (parentRef: PdfRef, parent: PdfDict): ReadOutline[] =>
    {
        const items: ReadOutline[] = [];
        let current = parent.get('First') as PdfRef | undefined;
        let previous: PdfRef | undefined;
        let last: PdfRef | undefined;
        while (current !== undefined)
        {
            const node = pdf.dict(current);
            if ((node.get('Parent') as PdfRef).num !== parentRef.num)
            {
                throw new Error('bad /Parent');
            }
            if ((node.get('Prev') as PdfRef | undefined)?.num !== previous?.num)
            {
                throw new Error('bad /Prev');
            }
            const title = node.get('Title');
            if (!(title instanceof PdfString) || !title.hex)
            {
                throw new Error('a title must be a hex string');
            }
            items.push({
                title: title.text,
                dest: pdf.name(node.get('Dest')),
                count: node.get('Count') as number | undefined,
                children: node.has('First') ? walk(current, node) : [],
            });
            previous = current;
            last = current;
            current = node.get('Next') as PdfRef | undefined;
        }
        if ((parent.get('Last') as PdfRef | undefined)?.num !== last?.num)
        {
            throw new Error('bad /Last');
        }
        return items;
    };
    return { count: root.get('Count') as number, items: walk(pdf.catalog.get('Outlines') as PdfRef, root) };
}

/** Named destinations: name -> { page index, top }. */
export function readDests(pdf: ParsedPdf): Map<string, { page: number; top: number }>
{
    const result = new Map<string, { page: number; top: number }>();
    const ref = pdf.catalog.get('Dests');
    if (ref === undefined)
    {
        return result;
    }
    const pages = pdf.pageRefs();
    for (const [key, value] of pdf.dict(ref).entries)
    {
        const destArray = value as PdfValue[];
        if (!(destArray[1] instanceof PdfName) || destArray[1].value !== 'XYZ' || destArray[4] !== null)
        {
            throw new Error('dest must be [page /XYZ left top null]');
        }
        const page = pages.indexOf((destArray[0] as PdfRef).num);
        if (page < 0)
        {
            throw new Error('dest to a non-page');
        }
        result.set(key, { page, top: destArray[3] as number });
    }
    return result;
}

/**
 * One drawn text run with its text read back: `shown` is what the glyphs
 * say through the font's ToUnicode map (what a reader SEES, e.g.
 * "[U+1F600]" for a placeholder), `copied` is what a reader gets when
 * copying or searching (the /ActualText of its span when there is one, else
 * `shown`). Coordinates are PDF ones (y up).
 */
export interface PageRun
{
    readonly font: string;
    readonly size: number;
    readonly x: number;
    readonly y: number;
    /** Advance width in points, from the font's /DW and /W (so where the run ends: x + width). */
    readonly width: number;
    readonly shown: string;
    readonly copied: string;
    readonly actualText: string | undefined;
}

/** A CIDFont's widths (1000 units per em): /DW, and /W in both forms ("c [w1 w2 ...]" and "c1 c2 w"). */
function cidWidths(pdf: ParsedPdf, type0: PdfDict): { dw: number; w: Map<number, number> }
{
    const descendants = pdf.resolve(type0.get('DescendantFonts'));
    if (!Array.isArray(descendants) || descendants.length !== 1)
    {
        throw new Error('a Type0 font needs one descendant font');
    }
    const cid = pdf.dict(descendants[0]);
    const dw = pdf.resolve(cid.get('DW')) ?? 1000;
    if (typeof dw !== 'number')
    {
        throw new Error('bad /DW');
    }
    const w = new Map<number, number>();
    const list = pdf.resolve(cid.get('W')) ?? [];
    if (!Array.isArray(list))
    {
        throw new Error('bad /W');
    }
    for (let i = 0; i < list.length; )
    {
        const first = list[i];
        const next = list[i + 1];
        if (typeof first !== 'number')
        {
            throw new Error('bad /W entry');
        }
        if (Array.isArray(next))
        {
            next.forEach((width, k) =>
            {
                if (typeof width !== 'number')
                {
                    throw new Error('bad /W width');
                }
                w.set(first + k, width);
            });
            i += 2;
        }
        else
        {
            const width = list[i + 2];
            if (typeof next !== 'number' || typeof width !== 'number' || next < first)
            {
                throw new Error('bad /W range');
            }
            for (let glyph = first; glyph <= next; glyph++)
            {
                w.set(glyph, width);
            }
            i += 3;
        }
    }
    return { dw, w };
}

/** The text runs of every page, in drawing order. A glyph missing from its font's ToUnicode map throws. */
export async function readPageRuns(pdf: ParsedPdf): Promise<PageRun[][]>
{
    const cmaps = new Map<number, Map<number, string>>();
    const allPageRuns: PageRun[][] = [];
    for (const pageDict of pdf.pages())
    {
        const fontDict = pdf.dict(pdf.dict(pageDict.get('Resources')).get('Font'));
        const fonts = new Map<string, { map: Map<number, string>; widths: { dw: number; w: Map<number, number> } }>();
        for (const key of fontDict.keys())
        {
            const type0 = pdf.dict(fontDict.get(key));
            const ref = type0.get('ToUnicode');
            if (!(ref instanceof PdfRef))
            {
                throw new Error(`font ${key} has no ToUnicode stream`);
            }
            let map = cmaps.get(ref.num);
            if (map === undefined)
            {
                map = parseToUnicode(await pdf.dataText(ref));
                cmaps.set(ref.num, map);
            }
            fonts.set(key, { map, widths: cidWidths(pdf, type0) });
        }
        const { runs } = readContent(await pdf.dataText(pageDict.get('Contents')));
        allPageRuns.push(
            runs.map((r) =>
            {
                const font = fonts.get(r.font);
                if (font === undefined)
                {
                    throw new Error(`run in unknown font ${r.font}`);
                }
                const shown = r.glyphs
                    .map((g) =>
                    {
                        const text = font.map.get(g);
                        if (text === undefined)
                        {
                            throw new Error(`glyph ${String(g)} of ${r.font} has no ToUnicode entry`);
                        }
                        return text;
                    })
                    .join('');
                const units = r.glyphs.reduce((sum, g) => sum + (font.widths.w.get(g) ?? font.widths.dw), 0);
                return { font: r.font, size: r.size, x: r.x, y: r.y, width: (units * r.size) / 1000, shown, copied: r.actualText ?? shown, actualText: r.actualText };
            }),
        );
    }
    return allPageRuns;
}

/**
 * Runs on one baseline, left to right, with their texts joined. Spaces are
 * glyphs in our files, so runs that touch are joined as they are; where a
 * visible gap separates two runs (two columns of a table, a label and its
 * value), one space is put between them, as a text extractor does.
 */
export interface TextLine
{
    readonly y: number;
    readonly runs: readonly PageRun[];
    readonly shown: string;
    readonly copied: string;
    /**
     * How many spaces were put between runs in `copied` (0 when the line is
     * the runs' own text, joined as drawn). Only a table row or a label/value
     * row should have any: inside a line of email text they would be spaces
     * the email does not have.
     */
    readonly insertedSpaces: number;
}

/** Smallest gap between two runs, in points, that counts as a space between them. */
const RUN_GAP = 1;

/** Groups a page's runs into lines: same baseline (within `tolerance` points), top to bottom, each left to right. */
export function textLines(runs: readonly PageRun[], tolerance = 0.01): TextLine[]
{
    const sorted = [...runs].sort((a, b) => b.y - a.y || a.x - b.x);
    const lines: PageRun[][] = [];
    for (const run of sorted)
    {
        const last = lines.at(-1);
        if (last !== undefined && Math.abs(last[0]!.y - run.y) <= tolerance)
        {
            last.push(run);
        }
        else
        {
            lines.push([run]);
        }
    }
    return lines.map((line) =>
    {
        const inOrder = [...line].sort((a, b) => a.x - b.x);
        const join = (pick: (r: PageRun) => string): { text: string; inserted: number } =>
            inOrder.reduce(
                ({ text, inserted }, r, k) =>
                {
                    const before = inOrder[k - 1];
                    const gap = before !== undefined && r.x - (before.x + before.width) >= RUN_GAP && !/\s$/.test(text) && !/^\s/.test(pick(r));
                    return { text: text + (gap ? ' ' : '') + pick(r), inserted: inserted + (gap ? 1 : 0) };
                },
                { text: '', inserted: 0 },
            );
        const copied = join((r) => r.copied);
        return { y: inOrder[0]!.y, runs: inOrder, shown: join((r) => r.shown).text, copied: copied.text, insertedSpaces: copied.inserted };
    });
}

/** A link annotation: its page, its rectangle [x1, y1, x2, y2] (PDF coordinates) and its named destination. */
export interface ReadLink
{
    readonly page: number;
    readonly rect: readonly [number, number, number, number];
    readonly dest: string;
}

/** Every link annotation of every page, in page order. Anything but a /Link with a /Rect and a named /Dest throws. */
export function readLinks(pdf: ParsedPdf): ReadLink[]
{
    const links: ReadLink[] = [];
    for (const [page, pageDict] of pdf.pages().entries())
    {
        const annots = pdf.resolve(pageDict.get('Annots'));
        if (annots === undefined)
        {
            continue;
        }
        if (!Array.isArray(annots))
        {
            throw new Error('/Annots is not an array');
        }
        for (const annotation of annots)
        {
            const link = pdf.dict(annotation);
            if (pdf.name(link.get('Subtype')) !== 'Link')
            {
                throw new Error('an annotation that is not a link');
            }
            const rect = link.get('Rect');
            if (!Array.isArray(rect) || rect.length !== 4 || !rect.every((n): n is number => typeof n === 'number'))
            {
                throw new Error('bad link /Rect');
            }
            const [x1, y1, x2, y2] = rect;
            links.push({ page, rect: [x1!, y1!, x2!, y2!], dest: pdf.name(link.get('Dest')) });
        }
    }
    return links;
}
