// The own PDF backend, end to end: every file is read back with the
// independent test reader (Helper/Test/test-support/pdf-reader.ts), which checks the
// structure strictly (xref offsets, stream lengths, links between objects).
// Synthetic data only. Email-like text is untrusted (README.md, rule R4): it
// must appear only as hex string data. Special characters are written as
// braced escapes, so this file stays ASCII.
import { beforeAll, describe, expect, it } from 'vitest';
import {
    type ParsedPdf,
    PdfDict,
    PdfName,
    PdfRef,
    PdfStream,
    PdfString,
    type PdfValue,
    parseToUnicode,
    readContent,
    readDests,
    readOutline,
    readPdf,
} from '../../../Helper/Test/test-support/pdf-reader';
import { directoryChecksum } from '../font-reader/binary-reader';
import { parseFont, readWoffFont } from '../font-reader/parse-font';
import { readSfntDirectory } from '../font-reader/sfnt-directory';
import { unwrapWoff } from '../font-reader/unwrap-woff';
import { PDF_FONTS } from '../bundled-fonts';
import { isDrawnAsNothing } from '../text';
import { MAX_OUTLINE_DEPTH, MAX_PAGES, OwnPdfWriter, writePdf } from './own-writer';
import { MAX_OUTPUT_BYTES } from './pdf-file';
import { PdfWriteError } from './syntax';
import type { LaidOutDocument, LaidOutOutlineItem, LaidOutPage, LaidOutTextRun, PdfFontSet } from '../../../Header/laid-out-document';
import type { ParsedFont, PdfFontName } from '../../../Header/pdf-fonts';

const FONT_NAMES = Object.keys(PDF_FONTS) as PdfFontName[];
const fonts = {} as Record<PdfFontName, ParsedFont>;
beforeAll(async () =>
{
    for (const font of FONT_NAMES)
    {
        fonts[font] = await readWoffFont(PDF_FONTS[font]);
    }
});

const A4 = { width: 595.28, height: 841.89 };
const BLACK = { gray: 0 } as const;
const PRODUCER = 'Local Email-to-PDF Tool';

/** A run as the layout would make it: one glyph per code point, group 2 not drawn. */
function run(text: string, options: Partial<LaidOutTextRun> = {}): LaidOutTextRun
{
    const font = options.font ?? 'sans-regular';
    const glyphs: number[] = [];
    const glyphText: string[] = [];
    for (const character of text)
    {
        if (isDrawnAsNothing(character.codePointAt(0)!))
        {
            continue;
        }
        glyphs.push(fonts[font].glyphFor(character.codePointAt(0)!));
        glyphText.push(character);
    }
    return { font, size: 10, x: 50, y: 100, color: BLACK, glyphs, glyphText, copyText: text, ...options };
}

function page(text: LaidOutTextRun[] = [], extra: Partial<LaidOutPage> = {}): LaidOutPage
{
    return { fills: [], lines: [], text, links: [], ...extra };
}

function doc(pages: LaidOutPage[], extra: Partial<LaidOutDocument> = {}): LaidOutDocument
{
    return { pageSize: A4, pages, destinations: [], outline: [], info: { title: 'Mail of Alice Example', producer: PRODUCER }, ...extra };
}

async function write(d: LaidOutDocument, set: PdfFontSet = fonts): Promise<{ bytes: Uint8Array; pdf: ParsedPdf }>
{
    const bytes = await new OwnPdfWriter().render(d, set);
    return { bytes, pdf: readPdf(bytes) };
}

/** The fonts of a page's resources: resource name -> Type0 dictionary. */
function pageFonts(pdf: ParsedPdf, pageDict: PdfDict): Map<string, PdfDict>
{
    const fontDict = pdf.dict(pdf.dict(pageDict.get('Resources')).get('Font'));
    return new Map(fontDict.keys().map((key) => [key, pdf.dict(fontDict.get(key))]));
}

async function toUnicodeOf(pdf: ParsedPdf, type0: PdfDict): Promise<Map<number, string>>
{
    return parseToUnicode(await pdf.dataText(type0.get('ToUnicode')));
}

/** What a reader copies from each drawn run of a page: ActualText if any, else ToUnicode of the glyphs. */
async function copiedRuns(pdf: ParsedPdf, index = 0): Promise<{ copied: string; actualText: string | undefined; glyphs: number[] }[]>
{
    const pageDict = pdf.pages()[index]!;
    const fontsOfPage = pageFonts(pdf, pageDict);
    const maps = new Map<string, Map<number, string>>();
    for (const [key, type0] of fontsOfPage)
    {
        maps.set(key, await toUnicodeOf(pdf, type0));
    }
    const { runs } = readContent(await pdf.dataText(pageDict.get('Contents')));
    return runs.map((r) =>
    {
        const map = maps.get(r.font)!;
        const viaToUnicode = r.glyphs.map((g) => map.get(g) ?? '').join('');
        return { copied: r.actualText ?? viaToUnicode, actualText: r.actualText, glyphs: r.glyphs };
    });
}

/** Every value in every object (streams' dictionaries included), recursively. */
function* allValues(pdf: ParsedPdf): Generator<PdfValue>
{
    const stack: PdfValue[] = [...pdf.objects.values(), pdf.trailer];
    while (stack.length > 0)
    {
        const value = stack.pop()!;
        yield value;
        if (Array.isArray(value))
        {
            stack.push(...value);
        }
        else if (value instanceof PdfDict)
        {
            stack.push(...value.entries.values(), ...value.keys().map((k) => new PdfName(k)));
        }
        else if (value instanceof PdfStream)
        {
            stack.push(value.dict);
        }
    }
}

const latin1 = (bytes: Uint8Array): string =>
{
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192)
    {
        s += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return s;
};

describe('OwnPdfWriter: structure', () =>
{
    it('writes a minimal one-page document', async () =>
    {
        const { pdf } = await write(doc([page([run('Hello Alice Example', { x: 72, y: 90, size: 12 })])]));
        const pages = pdf.pages();
        expect(pages).toHaveLength(1);
        expect(pages[0]!.get('MediaBox')).toEqual([0, 0, 595.28, 841.89]);
        expect([...pageFonts(pdf, pages[0]!).keys()]).toEqual(['F1']);
        const { runs } = readContent(await pdf.dataText(pages[0]!.get('Contents')));
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({ font: 'F1', size: 12, x: 72, y: 751.89, actualText: undefined });
        expect((await copiedRuns(pdf))[0]!.copied).toBe('Hello Alice Example');
        // Catalog: no outline, no destinations, nothing that runs or opens anything.
        expect(pdf.catalog.keys().sort()).toEqual(['Pages', 'Type', 'ViewerPreferences']);
    });

    it('writes several pages, each with its own content', async () =>
    {
        const texts = ['Page one', 'Page two', 'Page three'];
        const { pdf } = await write(doc(texts.map((t) => page([run(t)]))));
        expect(pdf.pages()).toHaveLength(3);
        for (const [i, t] of texts.entries())
        {
            expect((await copiedRuns(pdf, i))[0]!.copied).toBe(t);
        }
    });

    it('draws fills and lines below the text, converting y to the PDF origin', async () =>
    {
        const fills = [{ x: 10, y: 20, width: 100, height: 30, color: { gray: 0.9 } }];
        const lines = [{ x1: 10, y1: 60, x2: 200, y2: 60, width: 0.5, color: { rgb: [0.2, 0.4, 0.6] as const } }];
        const { pdf } = await write(doc([page([run('Text', { color: { rgb: [0, 0, 0.5] } })], { fills, lines })]));
        const { ops, runs } = readContent(await pdf.dataText(pdf.pages()[0]!.get('Contents')));
        const names = ops.map((o) => o.op);
        expect(names.indexOf('re')).toBeLessThan(names.indexOf('S'));
        expect(names.indexOf('S')).toBeLessThan(names.indexOf('BT'));
        expect(ops.find((o) => o.op === 're')!.operands).toEqual([10, 791.89, 100, 30]);
        expect(ops.find((o) => o.op === 'g')!.operands).toEqual([0.9]);
        expect(ops.find((o) => o.op === 'RG')!.operands).toEqual([0.2, 0.4, 0.6]);
        expect(ops.find((o) => o.op === 'm')!.operands).toEqual([10, 781.89]);
        expect(runs[0]!.fill).toEqual([0, 0, 0.5]);
    });

    it('has an Info dictionary with only /Title and /Producer, as hex strings', async () =>
    {
        const { pdf, bytes } = await write(doc([page([run('x')])]));
        expect(pdf.info.keys().sort()).toEqual(['Producer', 'Title']);
        const title = pdf.info.get('Title') as PdfString;
        const producer = pdf.info.get('Producer') as PdfString;
        expect(title.hex && producer.hex).toBe(true);
        expect(title.text).toBe('Mail of Alice Example');
        expect(producer.text).toBe(PRODUCER);
        const raw = latin1(bytes);
        for (const key of ['CreationDate', 'ModDate', 'Author', 'Creator', 'Keywords', 'Subject', 'Metadata'])
        {
            expect(raw).not.toContain(`/${key}`);
        }
    });

    it('writes a deterministic /ID: two equal values from SHA-256 of the body', async () =>
    {
        const d = doc([page([run('Same input')])]);
        const { bytes, pdf } = await write(d);
        const again = await new OwnPdfWriter().render(d, fonts);
        expect(again).toEqual(bytes);
        const [first, second] = pdf.trailer.get('ID') as PdfString[];
        expect(first!.hex && second!.hex).toBe(true);
        expect(first!.bytes).toHaveLength(16);
        expect(second!.bytes).toEqual(first!.bytes);
        const bodyEnd = latin1(bytes).lastIndexOf('trailer\n');
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice(0, bodyEnd)));
        expect(first!.bytes).toEqual(digest.subarray(0, 16));
        // A different input gives a different /ID.
        const other = readPdf(await new OwnPdfWriter().render(doc([page([run('Other input')])]), fonts));
        expect((other.trailer.get('ID') as PdfString[])[0]!.bytes).not.toEqual(first!.bytes);
    });

    it('never writes anything that acts (JavaScript, actions, URIs, files, forms)', async () =>
    {
        const d = doc([page([run('x')], { links: [{ rect: { x: 1, y: 1, width: 5, height: 5 }, destination: 'top' }] })], {
            destinations: [{ name: 'top', page: 0, y: 0 }],
            outline: [{ title: 'Top', destination: 'top', children: [] }],
        });
        const { pdf } = await write(d);
        const forbidden = ['JavaScript', 'JS', 'URI', 'Launch', 'OpenAction', 'AA', 'A', 'EmbeddedFile', 'EmbeddedFiles', 'AcroForm', 'XFA', 'GoToR', 'SubmitForm'];
        for (const value of allValues(pdf))
        {
            if (value instanceof PdfName)
            {
                expect(forbidden).not.toContain(value.value);
            }
            // The only literal strings are our fixed CIDSystemInfo ones.
            if (value instanceof PdfString && !value.hex)
            {
                expect(['Adobe', 'Identity']).toContain(value.text);
            }
        }
    });
});

describe('OwnPdfWriter: fonts', () =>
{
    it('embeds all four fonts whole, with widths from the font', async () =>
    {
        const runs = FONT_NAMES.map((font, i) => run(`Alice ${font} 0123 \u{E9}`, { font, y: 100 + 20 * i }));
        const { pdf } = await write(doc([page(runs)]));
        const embedded = pageFonts(pdf, pdf.pages()[0]!);
        expect([...embedded.keys()]).toEqual(['F1', 'F2', 'F3', 'F4']);
        for (const [index, font] of FONT_NAMES.entries())
        {
            const parsed = fonts[font];
            const type0 = embedded.get(`F${index + 1}`)!;
            expect(pdf.name(type0.get('Subtype'))).toBe('Type0');
            expect(pdf.name(type0.get('Encoding'))).toBe('Identity-H');
            expect(pdf.name(type0.get('BaseFont'))).toBe(parsed.postScriptName);
            const cid = pdf.dict((type0.get('DescendantFonts') as PdfValue[])[0]);
            expect(pdf.name(cid.get('Subtype'))).toBe('CIDFontType2');
            expect(pdf.name(cid.get('CIDToGIDMap'))).toBe('Identity');
            const descriptor = pdf.dict(cid.get('FontDescriptor'));
            expect(pdf.name(descriptor.get('FontName'))).toBe(parsed.postScriptName);
            const flags = descriptor.get('Flags') as number;
            expect(flags & 32).toBe(32); // Nonsymbolic
            expect(flags & 2).toBe(0); // not Serif
            expect((flags & 1) !== 0).toBe(font === 'mono-regular');
            expect((flags & 64) !== 0).toBe(font === 'sans-italic');
            expect(descriptor.get('ItalicAngle')).toBe(parsed.italicAngle);
            expect(descriptor.get('MissingWidth')).toBe((parsed.advance(0) * 1000) / parsed.unitsPerEm);
            // FontFile2: exactly the sfnt bytes.
            const fontFile = pdf.stream(descriptor.get('FontFile2'));
            expect(fontFile.dict.get('Length1')).toBe(parsed.sfnt.length);
            expect(await pdf.data(descriptor.get('FontFile2'))).toEqual(parsed.sfnt);
            // /W: exactly the used glyphs, with the font's advances.
            const widths = readWidths(cid.get('W') as PdfValue[]);
            const used = new Set(runs[index]!.glyphs);
            expect(new Set(widths.keys())).toEqual(used);
            for (const glyph of used)
            {
                expect(widths.get(glyph)).toBe((parsed.advance(glyph) * 1000) / parsed.unitsPerEm);
            }
        }
    }, 60_000); // four whole fonts: slow on a busy machine

    it('embeds only the fonts that are used', async () =>
    {
        const { pdf, bytes } = await write(doc([page([run('Bold only', { font: 'sans-bold' })])]));
        const embedded = pageFonts(pdf, pdf.pages()[0]!);
        expect([...embedded.keys()]).toEqual(['F2']);
        let fontFiles = 0;
        for (const value of pdf.objects.values())
        {
            if (value instanceof PdfDict && value.has('FontFile2'))
            {
                fontFiles++;
            }
        }
        expect(fontFiles).toBe(1);
        const raw = latin1(bytes);
        expect(raw).toContain('/IBMPlexSans-Bold');
        for (const other of ['/IBMPlexSans ', '/IBMPlexSans-Italic', '/IBMPlexMono'])
        {
            expect(raw).not.toContain(other);
        }
    });

    it('only needs the fonts it uses', async () =>
    {
        const { pdf } = await write(doc([page([run('Mono', { font: 'mono-regular' })])]), { 'mono-regular': fonts['mono-regular'] });
        expect([...pageFonts(pdf, pdf.pages()[0]!).keys()]).toEqual(['F4']);
    });

    it('refuses a font whose license forbids embedding (fsType 0x0002), only when used', async () =>
    {
        const restricted = await patchedFsType(0x0002);
        expect(restricted.fsType).toBe(0x0002);
        const set = { ...fonts, 'sans-regular': restricted };
        await expect(new OwnPdfWriter().render(doc([page([run('x')])]), set)).rejects.toThrow(/restricted license/);
        await expect(new OwnPdfWriter().render(doc([page([run('x', { font: 'sans-bold' })])]), set)).resolves.toBeInstanceOf(Uint8Array);
    });
});

describe('OwnPdfWriter: copy layer', () =>
{
    it('maps accents and punctuation back through ToUnicode, without ActualText', async () =>
    {
        const text = '\u{E9} \u{E7} \u{DF} \u{153} \u{20AC} \u{201C} \u{201D} \u{AB} \u{BB} \u{2013} \u{2026} \u{142} \u{151}';
        const { pdf } = await write(doc([page([run(text), run(text, { font: 'sans-bold' })])]));
        for (const r of await copiedRuns(pdf))
        {
            expect(r.copied).toBe(text);
            expect(r.actualText).toBeUndefined();
        }
    });

    it('keeps a combining mark as its own code point', async () =>
    {
        const { pdf } = await write(doc([page([run('e\u{301}')])]));
        const [r] = await copiedRuns(pdf);
        expect(r!.glyphs).toHaveLength(2);
        expect(r!.copied).toBe('e\u{301}');
        expect([...r!.copied]).toHaveLength(2);
        expect(r!.actualText).toBeUndefined();
    });

    it('gives a drawn placeholder its emoji as ActualText (ZWJ and VS16 kept, other group 2 dropped)', async () =>
    {
        const emoji = '\u{1F469}\u{200D}\u{1F4BB}';
        const heart = '\u{2764}\u{FE0F}';
        const placeholder = run('[U+1F469 U+200D U+1F4BB]', { copyText: `${emoji}\u{200B}${heart}\u{200E}\u{FEFF}` });
        const plain = run('[U+1F469 U+200D U+1F4BB]', { y: 120 });
        const { pdf } = await write(doc([page([placeholder, plain])]));
        const [first, second] = await copiedRuns(pdf);
        expect(first!.actualText).toBe(`${emoji}${heart}`);
        expect(second!.actualText).toBeUndefined();
        expect(second!.copied).toBe('[U+1F469 U+200D U+1F4BB]');
    });

    it('uses the first text of a glyph in ToUnicode, and ActualText for the others', async () =>
    {
        const a = fonts['sans-regular'].glyphFor(0x41);
        const one = run('A');
        const other: LaidOutTextRun = { ...run('A'), glyphs: [a], glyphText: ['Z'], copyText: 'Z' };
        const { pdf } = await write(doc([page([one, other])]));
        const [r1, r2] = await copiedRuns(pdf);
        expect(r1).toMatchObject({ copied: 'A', actualText: undefined });
        expect(r2).toMatchObject({ copied: 'Z', actualText: 'Z' });
    });

    it('always writes an explicit actualText', async () =>
    {
        const { pdf } = await write(doc([page([run('Alice', { actualText: 'Alice' })])]));
        expect((await copiedRuns(pdf))[0]!.actualText).toBe('Alice');
    });

    it('puts an explicit actualText through the copy layer (bidi override replaced, ZWSP dropped)', async () =>
    {
        const { pdf } = await write(doc([page([run('ab', { actualText: 'a\u{202E}\u{200B}b' })])]));
        const [r] = await copiedRuns(pdf);
        expect(r!.actualText).toBe('a\u{FFFD}b');
    });

    it('puts info.title through the copy layer (bidi override replaced, ZWSP dropped)', async () =>
    {
        const { pdf } = await write(doc([page([run('x')])], { info: { title: 'Mail\u{202E} of\u{200B} Alice', producer: PRODUCER } }));
        const title = pdf.info.get('Title') as PdfString;
        expect(title.hex).toBe(true);
        expect(title.text).toBe('Mail\u{FFFD} of Alice');
    });

    it('puts info.producer through the copy layer (bidi override replaced)', async () =>
    {
        const { pdf } = await write(doc([page([run('x')])], { info: { title: 'Mail', producer: 'Tool\u{202E} 1.0' } }));
        const producer = pdf.info.get('Producer') as PdfString;
        expect(producer.hex).toBe(true);
        expect(producer.text).toBe('Tool\u{FFFD} 1.0');
    });

    it('writes group 1 characters that reached the backend as U+FFFD, never as themselves', async () =>
    {
        const hostile = run('ab', { copyText: 'a\u{7}\u{202E}\u{D800}b', glyphText: ['a\u{0}', 'b'] });
        const { pdf } = await write(doc([page([hostile])]));
        const [r] = await copiedRuns(pdf);
        expect(r!.actualText).toBe('a\u{FFFD}\u{FFFD}\u{FFFD}b');
        const map = await toUnicodeOf(pdf, pageFonts(pdf, pdf.pages()[0]!).get('F1')!);
        expect(map.get(hostile.glyphs[0]!)).toBe('a\u{FFFD}');
        for (const text of map.values())
        {
            for (const character of text)
            {
                const cp = character.codePointAt(0)!;
                expect(cp < 0x20 || (cp >= 0x202a && cp <= 0x202e)).toBe(false);
            }
        }
    });

    it('skips a run without glyphs', async () =>
    {
        const empty: LaidOutTextRun = { ...run(''), copyText: '\u{200B}' };
        const { pdf } = await write(doc([page([empty, run('x')])]));
        expect(await copiedRuns(pdf)).toHaveLength(1);
    });
});

describe('OwnPdfWriter: links, destinations, bookmarks', () =>
{
    it('links to named destinations on the right pages', async () =>
    {
        const d = doc(
            [
                page([run('Index')], { links: [{ rect: { x: 50, y: 90, width: 200, height: 14 }, destination: 'email-2' }] }),
                page([run('Email 1')]),
                page([run('Email 2')], { links: [{ rect: { x: 0, y: 0, width: 10, height: 10 }, destination: 'index' }] }),
            ],
            {
                destinations: [
                    { name: 'index', page: 0, y: 0 },
                    { name: 'email-1', page: 1, y: 40 },
                    { name: 'email-2', page: 2, y: 72.5 },
                ],
            },
        );
        const { pdf } = await write(d);
        const dests = readDests(pdf);
        expect(dests.get('index')).toEqual({ page: 0, top: 841.89 });
        expect(dests.get('email-1')).toEqual({ page: 1, top: 801.89 });
        expect(dests.get('email-2')).toEqual({ page: 2, top: 769.39 });
        const annots = (pdf.pages()[0]!.get('Annots') as PdfValue[]).map((a) => pdf.dict(a));
        expect(annots).toHaveLength(1);
        const link = annots[0]!;
        expect(link.keys().sort()).toEqual(['Border', 'Dest', 'Rect', 'Subtype', 'Type']);
        expect(pdf.name(link.get('Subtype'))).toBe('Link');
        expect(link.get('Border')).toEqual([0, 0, 0]);
        expect(link.get('Rect')).toEqual([50, 737.89, 250, 751.89]);
        expect(dests.get(pdf.name(link.get('Dest')))!.page).toBe(2);
        expect(pdf.pages()[1]!.has('Annots')).toBe(false);
        const back = (pdf.pages()[2]!.get('Annots') as PdfValue[]).map((a) => pdf.dict(a));
        expect(back).toHaveLength(1);
        expect(pdf.name(back[0]!.get('Dest'))).toBe('index');
        // Annotations are indirect objects.
        expect((pdf.pages()[0]!.get('Annots') as PdfValue[])[0]).toBeInstanceOf(PdfRef);
    });

    it('writes nested bookmarks with counts and hostile titles only as hex', async () =>
    {
        const hostile = [
            'Re: (hello) \\ back\\slash',
            'Alice )>> /JS (app.alert(1)) << /S /JavaScript',
            'broken \u{D800} half',
            '\u{202E}reversed\u{200B} zero',
            'Lunch \u{1F355}',
            'long '.repeat(5000),
        ];
        const outline: LaidOutOutlineItem[] = [
            {
                title: 'Cover',
                destination: 'cover',
                open: true,
                children: [
                    { title: hostile[0]!, destination: 'e1', children: [] },
                    { title: hostile[1]!, destination: 'e1', children: [{ title: hostile[2]!, destination: 'e2', children: [] }] },
                ],
            },
            { title: hostile[3]!, destination: 'e2', children: [{ title: hostile[4]!, destination: 'e2', children: [] }] },
            { title: hostile[5]!, destination: 'cover', children: [] },
        ];
        const d = doc([page([run('Cover')]), page([run('Email')])], {
            outline,
            destinations: [
                { name: 'cover', page: 0, y: 0 },
                { name: 'e1', page: 1, y: 0 },
                { name: 'e2', page: 1, y: 300 },
            ],
            info: { title: hostile[1]!, producer: PRODUCER },
        });
        const { pdf, bytes } = await write(d);
        expect(pdf.name(pdf.catalog.get('PageMode'))).toBe('UseOutlines');
        const read = readOutline(pdf)!;
        // Visible: Cover, its 2 children (open), then 2 more top-level items.
        expect(read.count).toBe(5);
        expect(read.items.map((i) => i.count)).toEqual([2, -1, undefined]);
        expect(read.items[0]!.children[1]!.count).toBe(-1);
        expect(read.items[0]!.children.map((c) => c.title)).toEqual([hostile[0], hostile[1]]);
        expect(read.items[0]!.children[1]!.children[0]!.title).toBe('broken \u{FFFD} half');
        expect(read.items[1]!.title).toBe('\u{FFFD}reversed zero');
        expect(read.items[1]!.children[0]!.title).toBe('Lunch \u{1F355}');
        expect(read.items[1]!.children[0]!.dest).toBe('e2');
        const long = read.items[2]!.title;
        expect(long.length).toBeLessThanOrEqual(16000);
        expect(long.endsWith('\u{2026}')).toBe(true);
        expect((pdf.info.get('Title') as PdfString).text).toBe(hostile[1]);
        const raw = latin1(bytes);
        for (const fragment of ['app.alert', '/JavaScript', ')>> /JS', 'back\\slash', '(hello)'])
        {
            expect(raw).not.toContain(fragment);
        }
    });
});

describe('OwnPdfWriter: invalid input', () =>
{
    const cases: [string, () => LaidOutDocument, RegExp][] = [
        ['NaN coordinate', () => doc([page([run('x', { x: NaN })])]), /finite/],
        ['Infinity size', () => doc([page([run('x', { size: Infinity })])]), /font size/],
        ['zero size', () => doc([page([run('x', { size: 0 })])]), /font size/],
        ['coordinate out of range', () => doc([page([run('x', { y: 1e12 })])]), /out of range/],
        ['NaN fill', () => doc([page([], { fills: [{ x: 0, y: 0, width: NaN, height: 1, color: BLACK }] })]), /finite/],
        ['grey above 1', () => doc([page([run('x', { color: { gray: 2 } })])]), /between 0 and 1/],
        ['bad colour', () => doc([page([run('x', { color: {} as { gray: number } })])]), /colour/],
        ['bad destination name', () => doc([page([run('x')])], { destinations: [{ name: 'a b', page: 0, y: 0 }] }), /invalid PDF name/],
        ['name with a slash', () => doc([page([run('x')])], { destinations: [{ name: 'a/JS', page: 0, y: 0 }] }), /invalid PDF name/],
        ['destination twice', () => doc([page()], { destinations: [{ name: 'a', page: 0, y: 0 }, { name: 'a', page: 0, y: 1 }] }), /twice/],
        ['destination on a missing page', () => doc([page()], { destinations: [{ name: 'a', page: 1, y: 0 }] }), /does not exist/],
        ['NaN destination', () => doc([page()], { destinations: [{ name: 'a', page: 0, y: NaN }] }), /finite/],
        ['link to an unknown destination', () => doc([page([], { links: [{ rect: { x: 0, y: 0, width: 1, height: 1 }, destination: 'nowhere' }] })]), /unknown destination/],
        ['bookmark to an unknown destination', () => doc([page()], { outline: [{ title: 't', destination: 'nowhere', children: [] }] }), /unknown destination/],
        ['unknown font', () => doc([page([{ ...run('x'), font: 'comic' as PdfFontName }])]), /unknown font/],
        ['glyph id out of range', () => doc([page([{ ...run('x'), glyphs: [70000] }])]), /not in font/],
        ['glyphText length mismatch', () => doc([page([{ ...run('xy'), glyphText: ['x'] }])]), /as many glyphText/],
        ['no pages', () => doc([]), /at least one page/],
        ['page too small', () => ({ ...doc([page()]), pageSize: { width: 1, height: 100 } }), /page size/],
        ['page size NaN', () => ({ ...doc([page()]), pageSize: { width: NaN, height: 100 } }), /page size/],
        ['bad line width', () => doc([page([], { lines: [{ x1: 0, y1: 0, x2: 1, y2: 1, width: -1, color: BLACK }] })]), /line width/],
        // Malformed shapes (the input may not match its type at run time).
        ['no document', () => null as unknown as LaidOutDocument, /page size/],
        ['no page size', () => malformed({ pageSize: undefined }), /page size/],
        ['destinations missing', () => malformed({ destinations: undefined }), /destinations must be an array/],
        ['destination null', () => malformed({ destinations: [null] }), /destination must be an object/],
        ['outline missing', () => malformed({ outline: undefined }), /outline must be an array/],
        ['outline not an array', () => malformed({ outline: { title: 't' } }), /outline must be an array/],
        ['bookmark null', () => malformed({ outline: [null] }), /children array/],
        [
            'bookmark without children',
            () => malformed({ destinations: [{ name: 'a', page: 0, y: 0 }], outline: [{ title: 't', destination: 'a' }] }),
            /children array/,
        ],
        ['page null', () => malformed({ pages: [null] }), /page needs/],
        ['page without fills', () => malformed({ pages: [{ lines: [], text: [], links: [] }] }), /page needs/],
        ['page without lines', () => malformed({ pages: [{ fills: [], text: [], links: [] }] }), /page needs/],
        ['page without text', () => malformed({ pages: [{ fills: [], lines: [], links: [] }] }), /page needs/],
        ['page without links', () => malformed({ pages: [{ fills: [], lines: [], text: [] }] }), /page needs/],
        ['text run null', () => malformed({ pages: [{ fills: [], lines: [], text: [null], links: [] }] }), /text run must be an object/],
        ['link null', () => malformed({ pages: [{ fills: [], lines: [], text: [], links: [null] }] }), /link needs a rect/],
        ['link without rect', () => malformed({ pages: [{ fills: [], lines: [], text: [], links: [{ destination: 'a' }] }] }), /link needs a rect/],
        ['fill null', () => malformed({ pages: [{ fills: [null], lines: [], text: [], links: [] }] }), /fill must be an object/],
        ['fill a number', () => malformed({ pages: [{ fills: [1], lines: [], text: [], links: [] }] }), /fill must be an object/],
        ['line null', () => malformed({ pages: [{ fills: [], lines: [null], text: [], links: [] }] }), /line must be an object/],
        ['line a string', () => malformed({ pages: [{ fills: [], lines: ['x'], text: [], links: [] }] }), /line must be an object/],
        // Anything the checks miss is still a PdfWriteError.
        ['fill that fails when read', () => malformed({ pages: [{ fills: [throwingFill()], lines: [], text: [], links: [] }] }), /invalid laid-out document/],
    ];

    /** A fill whose x throws a TypeError when read: a failure no check is written for. */
    function throwingFill(): unknown
    {
        return {
            get x(): number
            {
                throw new TypeError('synthetic failure');
            },
            y: 0,
            width: 1,
            height: 1,
            color: BLACK,
        };
    }

    /** A one-page document with some fields replaced by values of the wrong shape. */
    function malformed(fields: Record<string, unknown>): LaidOutDocument
    {
        const value: unknown = { ...doc([page()]), ...fields };
        return value as LaidOutDocument;
    }

    it.each(cases)('%s throws a PdfWriteError', async (_label, make, message) =>
    {
        const error: unknown = await new OwnPdfWriter().render(make(), fonts).then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(PdfWriteError);
        expect((error as Error).message).toMatch(message);
    });

    it('refuses a font that is used but not given', async () =>
    {
        await expect(new OwnPdfWriter().render(doc([page([run('x')])]), {})).rejects.toThrow(/not given/);
    });

    it('wraps an unexpected failure as a PdfWriteError, keeping the cause', async () =>
    {
        const d = { ...doc([page()]), pages: [{ fills: [throwingFill()], lines: [], text: [], links: [] }] } as unknown as LaidOutDocument;
        const error: unknown = await new OwnPdfWriter().render(d, fonts).then(
            () => undefined,
            (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(PdfWriteError);
        expect((error as Error).cause).toBeInstanceOf(TypeError);
    });

    it('accepts bookmarks exactly MAX_OUTLINE_DEPTH levels deep and refuses one more', async () =>
    {
        const nested = (levels: number): LaidOutDocument =>
        {
            let item: LaidOutOutlineItem = { title: 'leaf', destination: 'a', children: [] };
            for (let i = 1; i < levels; i++)
            {
                item = { title: `level ${i}`, destination: 'a', children: [item] };
            }
            return doc([page()], { destinations: [{ name: 'a', page: 0, y: 0 }], outline: [item] });
        };
        const { pdf } = await write(nested(MAX_OUTLINE_DEPTH));
        let depth = 0;
        for (let items = readOutline(pdf)!.items; items.length > 0; items = items[0]!.children)
        {
            depth++;
        }
        expect(depth).toBe(MAX_OUTLINE_DEPTH);
        await expect(new OwnPdfWriter().render(nested(MAX_OUTLINE_DEPTH + 1), fonts)).rejects.toThrow(/nested deeper/);
    });
});

describe('OwnPdfWriter: limits and scale', () =>
{
    it('has the documented limits', () =>
    {
        expect(MAX_PAGES).toBe(100_000);
        expect(MAX_OUTPUT_BYTES).toBe(256 * 1024 * 1024);
    });

    it('refuses more pages than the limit', async () =>
    {
        const d = doc([page(), page(), page()]);
        await expect(new OwnPdfWriter({ maxPages: 2 }).render(d, fonts)).rejects.toThrow(/more than the limit of 2/);
        await expect(writePdf(d, fonts, { maxPages: 3 })).resolves.toBeInstanceOf(Uint8Array);
    });

    it('refuses output larger than the limit', async () =>
    {
        const d = doc([page([run('x')])]);
        await expect(new OwnPdfWriter({ maxBytes: 50_000 }).render(d, fonts)).rejects.toThrow(PdfWriteError);
        await expect(new OwnPdfWriter({ maxBytes: 50_000 }).render(d, fonts)).rejects.toThrow(/larger than/);
    });

    it('writes a 2000-page document in bounded time', async () =>
    {
        const line = 'Alice Example wrote: the quarterly numbers look fine, see the attached sheet. \u{E9}\u{20AC}';
        const pages: LaidOutPage[] = [];
        const destinations = [];
        const outline: LaidOutOutlineItem[] = [];
        for (let p = 0; p < 2000; p++)
        {
            const text = Array.from({ length: 50 }, (_, i) => run(`${p + 1}.${i + 1} ${line}`, { y: 60 + 14 * i, font: i === 0 ? 'sans-bold' : 'sans-regular' }));
            pages.push(page(text, { fills: [{ x: 40, y: 40, width: 515, height: 16, color: { gray: 0.93 } }] }));
            if (p % 2 === 0)
            {
                destinations.push({ name: `email-${p / 2 + 1}`, page: p, y: 40 });
                outline.push({ title: `Email ${p / 2 + 1} from Alice Example`, destination: `email-${p / 2 + 1}`, children: [] });
            }
        }
        const started = performance.now();
        const bytes = await new OwnPdfWriter().render(doc(pages, { destinations, outline }), fonts);
        const ms = performance.now() - started;
        const pdf = readPdf(bytes);
        expect(pdf.pages()).toHaveLength(2000);
        expect(readOutline(pdf)!.items).toHaveLength(1000);
        console.log(`2000 pages: ${Math.round(ms)} ms, ${(bytes.length / (1024 * 1024)).toFixed(2)} MiB`);
        expect(ms).toBeLessThan(30_000);
    }, 60_000);
});

/** /W array -> glyph id -> width. */
function readWidths(w: PdfValue[]): Map<number, number>
{
    const result = new Map<number, number>();
    for (let i = 0; i < w.length; )
    {
        const first = w[i] as number;
        const next = w[i + 1];
        if (Array.isArray(next))
        {
            next.forEach((width, k) => result.set(first + k, width as number));
            i += 2;
        }
        else
        {
            for (let g = first; g <= (next as number); g++)
            {
                result.set(g, w[i + 2] as number);
            }
            i += 3;
        }
    }
    return result;
}

/** Plex Sans Regular with OS/2 fsType changed (table checksum fixed), parsed. */
async function patchedFsType(fsType: number): Promise<ParsedFont>
{
    const copy = (await unwrapWoff(PDF_FONTS['sans-regular'])).slice();
    const directory = readSfntDirectory(copy);
    const table = directory.tables.get('OS/2')!;
    const view = new DataView(copy.buffer);
    view.setUint16(table.offset + 8, fsType);
    const index = [...directory.tables.keys()].indexOf('OS/2');
    const tag = view.getUint32(12 + 16 * index);
    view.setUint32(12 + 16 * index + 4, directoryChecksum(tag, copy, table.offset, table.length));
    return parseFont(copy);
}
