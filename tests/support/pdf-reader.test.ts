// The test PDF reader must itself be strict, or the writer tests prove
// nothing: a file with a wrong xref offset, a wrong stream /Length or an
// exponent number is rejected. The text helpers (readPageRuns, textLines,
// readLinks) read back exactly what a hand-made page draws: the glyphs
// through ToUnicode, an /ActualText span as the copied text, lines by
// baseline, link rectangles and destinations.
import { describe, expect, it } from 'vitest';
import { readContent, readLinks, readPageRuns, readPdf, textLines } from './pdf-reader';

const enc = (s: string): Uint8Array =>
{
    const b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return b;
};

/** A tiny hand-made PDF in our writer's layout (objects, xref, trailer). */
function tinyPdf(options: { shift?: number; length?: number } = {}): Uint8Array
{
    const header = '%PDF-1.7\n%\u{E2}\u{E3}\u{CF}\u{D3}\n';
    const objects = [
        '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
        '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
        '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R >>\nendobj\n',
        `4 0 obj\n<< /Length ${options.length ?? 2} >>\nstream\nBT\nendstream\nendobj\n`,
        '5 0 obj\n<< /Title <FEFF0041> /Producer <FEFF0042> >>\nendobj\n',
    ];
    let body = header;
    const offsets: number[] = [];
    for (const o of objects)
    {
        offsets.push(body.length);
        body += o;
    }
    const xrefAt = body.length;
    body += `xref\n0 6\n0000000000 65535 f \n`;
    for (const [i, off] of offsets.entries()) body += `${String(off + (i === 2 ? (options.shift ?? 0) : 0)).padStart(10, '0')} 00000 n \n`;
    body += `trailer\n<< /Size 6 /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    return enc(body);
}

describe('test PDF reader', () =>
{
    it('reads a well-formed file', () =>
    {
        const pdf = readPdf(tinyPdf());
        expect(pdf.pages()).toHaveLength(1);
    });

    it('rejects an xref offset that does not point at "N 0 obj"', () =>
    {
        expect(() => readPdf(tinyPdf({ shift: 1 }))).toThrow(/does not point/);
    });

    it('rejects a wrong stream /Length', () =>
    {
        expect(() => readPdf(tinyPdf({ length: 3 }))).toThrow(/Length does not match/);
    });

    it('rejects exponent notation and unknown operators in content', () =>
    {
        expect(() => readContent('1e-7 w')).toThrow(/exponent/);
        expect(() => readContent('(x) Tj')).toThrow(/Tj/);
        expect(() => readContent('BT /F1 1 Tf 0 0 Td ET')).toThrow(/unexpected operator Td/);
    });
});

/** A one-page file in our writer's layout with one font (ToUnicode only), `content` as its page, and one link. */
function textPdf(content: string): Uint8Array
{
    const cmap = [
        '1 begincodespacerange',
        '<0000> <FFFF>',
        'endcodespacerange',
        '7 beginbfchar',
        '<0001> <0043>',
        '<0002> <00E9>',
        '<0003> <005B>',
        '<0004> <0055>',
        '<0005> <002B>',
        '<0006> <005D>',
        '<0007> <0044>',
        'endbfchar',
    ].join('\n');
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>',
        '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R' +
            ' /Annots [<< /Type /Annot /Subtype /Link /Rect [72 190 200 210] /Dest /email-1 >>] >>',
        `<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream`,
        '<< /Type /Font /Subtype /Type0 /ToUnicode 6 0 R /DescendantFonts [7 0 R] >>',
        `<< /Length ${String(cmap.length)} >>\nstream\n${cmap}\nendstream`,
        // Glyph 1: 600, glyph 2: 500 (list form); 3 to 6: 250 (range form); others: /DW.
        '<< /Type /Font /Subtype /CIDFontType2 /DW 1000 /W [1 [600 500] 3 6 250] >>',
    ];
    let body = '%PDF-1.7\n%\u{E2}\u{E3}\u{CF}\u{D3}\n';
    const offsets: number[] = [];
    for (const [i, o] of objects.entries())
    {
        offsets.push(body.length);
        body += `${String(i + 1)} 0 obj\n${o}\nendobj\n`;
    }
    const xrefAt = body.length;
    body += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
    for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
    body += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xrefAt)}\n%%EOF\n`;
    return enc(body);
}

describe('test PDF reader: text and links', () =>
{
    // Line 1: "C" + e-acute (11 pt wide at 10 pt), right after it a placeholder
    // "[U+]" (10 pt) whose copy text is an emoji, then after a gap glyph 7
    // ("D", no /W entry: /DW width); line 2: e-acute alone.
    const content = [
        'BT',
        '/F1 10 Tf',
        '0 g',
        '1 0 0 1 72 200 Tm',
        '<00010002> Tj',
        '1 0 0 1 83 200 Tm',
        '/Span << /ActualText <FEFFD83DDE00> >> BDC',
        '<0003000400050006> Tj',
        'EMC',
        '1 0 0 1 120 200 Tm',
        '<0007> Tj',
        '1 0 0 1 72 180 Tm',
        '<0002> Tj',
        'ET',
    ].join('\n');

    it('reads each run as shown (ToUnicode) and as copied (ActualText first), with its width', async () =>
    {
        const [page] = await readPageRuns(readPdf(textPdf(content)));
        expect(page?.map((r) => [r.x, r.y, r.width, r.shown, r.copied])).toEqual([
            [72, 200, 11, 'C\u{E9}', 'C\u{E9}'],
            [83, 200, 10, '[U+]', '\u{1F600}'],
            [120, 200, 10, 'D', 'D'],
            [72, 180, 5, '\u{E9}', '\u{E9}'],
        ]);
    });

    it('groups runs into lines by baseline, top to bottom, left to right, a space only where there is a gap', async () =>
    {
        const [page] = await readPageRuns(readPdf(textPdf(content)));
        const lines = textLines([...(page ?? [])].reverse());
        expect(lines.map((l) => [l.y, l.shown, l.copied, l.insertedSpaces])).toEqual([
            [200, 'C\u{E9}[U+] D', 'C\u{E9}\u{1F600} D', 1],
            [180, '\u{E9}', '\u{E9}', 0],
        ]);
    });

    it('counts the spaces it puts between runs: one per gap, none where runs touch', async () =>
    {
        // "C" (6 pt wide at 10 pt) at 72, touching e-acute at 78, then gaps before "D" and before another e-acute.
        const runs = 'BT\n/F1 10 Tf\n1 0 0 1 72 200 Tm\n<0001> Tj\n1 0 0 1 78 200 Tm\n<0002> Tj\n1 0 0 1 100 200 Tm\n<0007> Tj\n1 0 0 1 130 200 Tm\n<0002> Tj\nET';
        const [page] = await readPageRuns(readPdf(textPdf(runs)));
        expect(textLines(page ?? []).map((l) => [l.copied, l.insertedSpaces])).toEqual([['C\u{E9} D \u{E9}', 2]]);
    });

    it('rejects a text matrix that scales, rotates or skews', () =>
    {
        expect(readContent('BT /F1 10 Tf 1 0 0 1 72 200 Tm <0001> Tj ET').runs).toHaveLength(1);
        for (const m of ['2 0 0 1', '1 0.5 0 1', '1 0 0.5 1', '1 0 0 -1', '0 1 -1 0'])
        {
            expect(() => readContent(`BT /F1 10 Tf ${m} 72 200 Tm <0001> Tj ET`), m).toThrow(/Tm must be 1 0 0 1/);
        }
    });

    it('reads /W widths in both forms, /DW for the others', async () =>
    {
        const [page] = await readPageRuns(readPdf(textPdf('BT\n/F1 20 Tf\n1 0 0 1 0 0 Tm\n<00010002000300060007> Tj\nET')));
        // 600 + 500 + 250 + 250 + 1000 (/DW) units at 20 pt.
        expect(page?.[0]?.width).toBeCloseTo(52);
    });

    it('rejects a glyph with no ToUnicode entry', async () =>
    {
        await expect(readPageRuns(readPdf(textPdf('BT\n/F1 10 Tf\n1 0 0 1 72 200 Tm\n<0008> Tj\nET')))).rejects.toThrow(/no ToUnicode entry/);
    });

    it('reads link rectangles and their named destinations', () =>
    {
        expect(readLinks(readPdf(textPdf(content)))).toEqual([{ page: 0, rect: [72, 190, 200, 210], dest: 'email-1' }]);
    });
});
