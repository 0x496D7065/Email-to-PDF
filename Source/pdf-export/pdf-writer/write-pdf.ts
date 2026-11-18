// Our own PDF backend: writes a laid-out document (Header/laid-out-document.ts) as a PDF 1.7
// file. Objects plus a classic cross-reference table (pdf-file-builder.ts); content
// streams and font files deflated; the four Plex fonts embedded whole when
// used (font-objects.ts); internal links, named destinations and bookmarks
// only.
//
// Safe by construction (README.md, rule R4): the file never gets /URI,
// /Launch, /JavaScript, /OpenAction, /AA, embedded files or forms; email
// text only ever becomes hex string data. No network (rule R1), nothing
// stored (rule R5), no dates, no author: the Info dictionary holds only
// /Title and /Producer.
import { copyLayerText } from './copy-layer-text';
import { pageContentStream } from './page-content-stream';
import { deflate } from './deflate';
import { checkEmbeddable, cidFont, fontDescriptor, FontUsage, toUnicodeCmap, type0Font, widthsArray } from './font-objects';
import { MAX_OUTPUT_BYTES, PdfFileBuilder } from './pdf-file-builder';
import { asciiBytes, throwWriteError, hexTextString, pdfInteger, pdfName, pdfNumber, PdfWriteError } from './pdf-syntax';
import type { LaidOutDocument, LaidOutOutlineItem, LaidOutTextRun, PdfBackend, PdfFontSet } from '../../../Header/laid-out-document';
import type { PdfFontName } from '../../../Header/pdf-fonts';

/** Most pages in one PDF. */
export const MAX_PAGES = 100_000;

/** Deepest bookmark nesting accepted. */
export const MAX_OUTLINE_DEPTH = 32;

/** Smallest and largest page side, in points (PDF's own limits: 3 to 14400). */
const MIN_PAGE_SIDE = 3;
const MAX_PAGE_SIDE = 14_400;

/** Fixed order and resource names of the fonts, so the output never depends on use order. */
const FONT_ORDER: readonly PdfFontName[] = ['sans-regular', 'sans-bold', 'sans-italic', 'mono-regular'];

export interface PdfWriterOptions
{
    /** Largest output, in bytes (default MAX_OUTPUT_BYTES, 256 MiB). */
    readonly maxBytes?: number;
    /** Most pages (default MAX_PAGES). */
    readonly maxPages?: number;
}

/** The hand-written PDF backend. */
export class PdfWriter implements PdfBackend
{
    constructor(private readonly options: PdfWriterOptions = {})
    {
    }

    /** Rejects only with a PdfWriteError: any other failure (a malformed shape the checks missed) is wrapped. */
    async render(doc: LaidOutDocument, fonts: PdfFontSet): Promise<Uint8Array>
    {
        try
        {
            return await writePdf(doc, fonts, this.options);
        }
        catch (error)
        {
            if (error instanceof PdfWriteError)
            {
                throw error;
            }
            throw new PdfWriteError('invalid laid-out document', { cause: error });
        }
    }
}

/** Array.isArray without narrowing a readonly array to any[] (the input may not match its type at run time). */
function isArray(value: unknown): boolean
{
    return Array.isArray(value);
}

/** A non-null object (the input may not match its type at run time). */
function isObject(value: unknown): boolean
{
    return typeof value === 'object' && value !== null;
}

function checkPageSize(doc: LaidOutDocument): { width: number; height: number }
{
    if (!isObject(doc) || !isObject(doc.pageSize))
    {
        throwWriteError('the document needs a page size');
    }
    const { width, height } = doc.pageSize;
    for (const side of [width, height])
    {
        if (typeof side !== 'number' || !(side >= MIN_PAGE_SIDE && side <= MAX_PAGE_SIDE))
        {
            throwWriteError(`page size must be between ${MIN_PAGE_SIDE} and ${MAX_PAGE_SIDE} points, not ${String(side)}`);
        }
    }
    return { width, height };
}

/** Pass 1: every run's font and glyphs, so each ToUnicode map is final before any page is written. */
function collectFontUsage(doc: LaidOutDocument, fonts: PdfFontSet): Map<PdfFontName, FontUsage>
{
    const usageByFont = new Map<PdfFontName, FontUsage>();
    for (const page of doc.pages)
    {
        for (const run of page.text)
        {
            if (!isObject(run))
            {
                throwWriteError('a text run must be an object');
            }
            if (!FONT_ORDER.includes(run.font))
            {
                throwWriteError(`unknown font: ${JSON.stringify(String(run.font)).slice(0, 40)}`);
            }
            if (!isArray(run.glyphs) || !isArray(run.glyphText) || run.glyphs.length !== run.glyphText.length)
            {
                throwWriteError('a text run needs as many glyphText entries as glyphs');
            }
            if (typeof run.copyText !== 'string' || (run.actualText !== undefined && typeof run.actualText !== 'string'))
            {
                throwWriteError('a text run needs a copyText string (and actualText, if set, must be a string)');
            }
            if (run.glyphs.length === 0)
            {
                continue;
            }
            let usage = usageByFont.get(run.font);
            if (usage === undefined)
            {
                const font = fonts[run.font];
                if (font === undefined)
                {
                    throwWriteError(`font ${run.font} is used but was not given`);
                }
                checkEmbeddable(font);
                usage = new FontUsage(font, `F${FONT_ORDER.indexOf(run.font) + 1}`);
                usageByFont.set(run.font, usage);
            }
            for (let i = 0; i < run.glyphs.length; i++)
            {
                const text = run.glyphText[i];
                if (typeof text !== 'string')
                {
                    throwWriteError('glyphText entries must be strings');
                }
                usage.recordGlyph(run.glyphs[i]!, text);
            }
        }
    }
    return usageByFont;
}

interface OutlineNode
{
    readonly item: LaidOutOutlineItem;
    readonly objectNumber: number;
    readonly children: OutlineNode[];
}

/** Object numbers for the bookmark tree (checked: depth, destinations). */
function reserveOutlineObjects(
    file: PdfFileBuilder,
    items: readonly LaidOutOutlineItem[],
    destinations: ReadonlySet<string>,
    depth: number,
): OutlineNode[]
{
    // Only items count as a level (a leaf's empty children list is not one).
    if (items.length > 0 && depth > MAX_OUTLINE_DEPTH)
    {
        throwWriteError(`bookmarks are nested deeper than ${MAX_OUTLINE_DEPTH} levels`);
    }
    return items.map((item) =>
    {
        if (!isObject(item) || !isArray(item.children))
        {
            throwWriteError('a bookmark must be an object with a children array');
        }
        if (typeof item.title !== 'string')
        {
            throwWriteError('a bookmark title must be a string');
        }
        if (!destinations.has(item.destination))
        {
            throwWriteError(`bookmark to an unknown destination: ${JSON.stringify(String(item.destination)).slice(0, 80)}`);
        }
        return { item, objectNumber: file.reserveObject(), children: reserveOutlineObjects(file, item.children, destinations, depth + 1) };
    });
}

/** Bookmarks shown under a node when it is open: its children and, recursively, those of open children. */
function openDescendantCount(node: OutlineNode): number
{
    return node.children.reduce((sum, child) => sum + 1 + (child.item.open === true ? openDescendantCount(child) : 0), 0);
}

function writeOutline(file: PdfFileBuilder, nodes: readonly OutlineNode[], parentObjectNumber: number): void
{
    nodes.forEach((node, index) =>
    {
        const entries = [`/Title ${hexTextString(copyLayerText(node.item.title))}`, `/Parent ${parentObjectNumber} 0 R`,
            `/Dest ${pdfName(node.item.destination)}`];
        const previous = nodes[index - 1];
        const next = nodes[index + 1];
        if (previous !== undefined)
        {
            entries.push(`/Prev ${previous.objectNumber} 0 R`);
        }
        if (next !== undefined)
        {
            entries.push(`/Next ${next.objectNumber} 0 R`);
        }
        if (node.children.length > 0)
        {
            const openCount = openDescendantCount(node);
            entries.push(`/First ${node.children[0]!.objectNumber} 0 R`, `/Last ${node.children.at(-1)!.objectNumber} 0 R`);
            entries.push(`/Count ${node.item.open === true ? openCount : -openCount}`);
        }
        file.writeObject(node.objectNumber, `<< ${entries.join(' ')} >>`);
        writeOutline(file, node.children, node.objectNumber);
    });
}

/**
 * Writes the PDF. Throws a PdfWriteError for invalid input or a limit reached.
 * Internal: use PdfWriter.render(), which guarantees PdfWriteError-only;
 * this function can throw other errors for shapes its checks miss.
 */
export async function writePdf(doc: LaidOutDocument, fonts: PdfFontSet, options: PdfWriterOptions = {}): Promise<Uint8Array>
{
    const maxPages = options.maxPages ?? MAX_PAGES;
    const { width, height } = checkPageSize(doc);
    if (!isArray(doc.pages) || doc.pages.length === 0)
    {
        throwWriteError('a PDF needs at least one page');
    }
    if (doc.pages.length > maxPages)
    {
        throwWriteError(`the PDF would have ${doc.pages.length} pages, more than the limit of ${maxPages}`);
    }
    if (typeof doc.info?.title !== 'string' || typeof doc.info.producer !== 'string')
    {
        throwWriteError('info needs a title and a producer string');
    }
    if (!isArray(doc.destinations))
    {
        throwWriteError('destinations must be an array');
    }
    if (!isArray(doc.outline))
    {
        throwWriteError('the outline must be an array');
    }
    for (const page of doc.pages)
    {
        if (!isObject(page) || !isArray(page.fills) || !isArray(page.lines) || !isArray(page.text) || !isArray(page.links))
        {
            throwWriteError('a page needs fills, lines, text and links arrays');
        }
    }

    // Named destinations: our names only, each once, on an existing page.
    const destinations = new Map<string, { page: number; y: number }>();
    for (const destination of doc.destinations)
    {
        if (!isObject(destination))
        {
            throwWriteError('a destination must be an object');
        }
        pdfName(destination.name); // throws unless it is a valid name
        if (destinations.has(destination.name))
        {
            throwWriteError(`destination ${destination.name} is defined twice`);
        }
        if (!Number.isInteger(destination.page) || destination.page < 0 || destination.page >= doc.pages.length)
        {
            throwWriteError(`destination ${destination.name} points to page ${String(destination.page)}, which does not exist`);
        }
        pdfNumber(destination.y);
        destinations.set(destination.name, { page: destination.page, y: destination.y });
    }

    const usageByFont = collectFontUsage(doc, fonts);
    const file = new PdfFileBuilder(options.maxBytes ?? MAX_OUTPUT_BYTES);
    const catalogObjectNumber = file.reserveObject();
    const pagesObjectNumber = file.reserveObject();
    const infoObjectNumber = file.reserveObject();
    const resourcesObjectNumber = file.reserveObject();
    const pageObjectNumbers = doc.pages.map(() => file.reserveObject());

    // Fonts, in the fixed order (only the used ones).
    const fontEntries: string[] = [];
    for (const fontName of FONT_ORDER)
    {
        const usage = usageByFont.get(fontName);
        if (usage === undefined)
        {
            continue;
        }
        const font = usage.font;
        const [type0ObjectNumber, descendantObjectNumber, descriptorObjectNumber, fontFileObjectNumber, toUnicodeObjectNumber] = [
            file.reserveObject(), file.reserveObject(), file.reserveObject(), file.reserveObject(), file.reserveObject()
        ];
        file.writeObject(type0ObjectNumber, type0Font(font, descendantObjectNumber, toUnicodeObjectNumber));
        file.writeObject(descendantObjectNumber, cidFont(font, descriptorObjectNumber, widthsArray(font, usage.glyphs)));
        file.writeObject(descriptorObjectNumber, fontDescriptor(font, fontFileObjectNumber));
        file.writeStream(fontFileObjectNumber, `/Filter /FlateDecode /Length1 ${pdfInteger(font.sfnt.length)}`, await deflate(font.sfnt));
        file.writeStream(toUnicodeObjectNumber, '/Filter /FlateDecode', await deflate(asciiBytes(toUnicodeCmap(usage.toUnicode))));
        fontEntries.push(`${pdfName(usage.resourceName)} ${type0ObjectNumber} 0 R`);
    }
    file.writeObject(resourcesObjectNumber, `<< /Font << ${fontEntries.join(' ')} >> >>`);

    // Pages: content stream and link annotations each.
    const usageOf = (run: LaidOutTextRun): FontUsage => usageByFont.get(run.font)!;
    for (const [index, page] of doc.pages.entries())
    {
        const contentObjectNumber = file.reserveObject();
        const annotObjectNumbers: number[] = [];
        for (const link of page.links)
        {
            if (!isObject(link) || !isObject(link.rect))
            {
                throwWriteError('a link needs a rect');
            }
            if (!destinations.has(link.destination))
            {
                throwWriteError(`link to an unknown destination: ${JSON.stringify(String(link.destination)).slice(0, 80)}`);
            }
            const { x, y, width: linkWidth, height: linkHeight } = link.rect;
            const annotObjectNumber = file.reserveObject();
            file.writeObject(
                annotObjectNumber,
                `<< /Type /Annot /Subtype /Link /Rect [${pdfNumber(x)} ${pdfNumber(height - y - linkHeight)} ${pdfNumber(x + linkWidth)} ${pdfNumber(height - y)}] /Border [0 0 0] /Dest ${pdfName(link.destination)} >>`,
            );
            annotObjectNumbers.push(annotObjectNumber);
        }
        file.writeStream(contentObjectNumber, '/Filter /FlateDecode', await deflate(asciiBytes(pageContentStream(page, height, usageOf))));
        file.writeObject(
            pageObjectNumbers[index]!,
            `<< /Type /Page /Parent ${pagesObjectNumber} 0 R /MediaBox [0 0 ${pdfNumber(width)} ${pdfNumber(height)}] /Resources ${resourcesObjectNumber} 0 R /Contents ${contentObjectNumber} 0 R` +
                (annotObjectNumbers.length > 0 ? ` /Annots [${annotObjectNumbers.map((objectNumber) => `${objectNumber} 0 R`).join(' ')}]` : '') +
                ' >>',
        );
    }
    file.writeObject(pagesObjectNumber,
        `<< /Type /Pages /Kids [${pageObjectNumbers.map((objectNumber) => `${objectNumber} 0 R`).join(' ')}] /Count ${doc.pages.length} >>`);

    // Named destinations: one /Dests dictionary (keys are names), in sorted order.
    const catalogEntries = ['/Type /Catalog', `/Pages ${pagesObjectNumber} 0 R`, '/ViewerPreferences << /DisplayDocTitle true >>'];
    if (destinations.size > 0)
    {
        const destsObjectNumber = file.reserveObject();
        const entries = [...destinations.entries()]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([destinationName, { page, y }]) =>
                `${pdfName(destinationName)} [${pageObjectNumbers[page]} 0 R /XYZ 0 ${pdfNumber(height - y)} null]`);
        file.writeObject(destsObjectNumber, `<< ${entries.join(' ')} >>`);
        catalogEntries.push(`/Dests ${destsObjectNumber} 0 R`);
    }

    // Bookmarks.
    if (doc.outline.length > 0)
    {
        const outlinesObjectNumber = file.reserveObject();
        const nodes = reserveOutlineObjects(file, doc.outline, new Set(destinations.keys()), 1);
        const visibleCount = nodes.reduce((sum, node) => sum + 1 + (node.item.open === true ? openDescendantCount(node) : 0), 0);
        file.writeObject(outlinesObjectNumber,
            `<< /Type /Outlines /First ${nodes[0]!.objectNumber} 0 R /Last ${nodes.at(-1)!.objectNumber} 0 R /Count ${visibleCount} >>`);
        writeOutline(file, nodes, outlinesObjectNumber);
        catalogEntries.push(`/Outlines ${outlinesObjectNumber} 0 R`, '/PageMode /UseOutlines');
    }

    file.writeObject(catalogObjectNumber, `<< ${catalogEntries.join(' ')} >>`);
    file.writeObject(infoObjectNumber,
        `<< /Title ${hexTextString(copyLayerText(doc.info.title))} /Producer ${hexTextString(copyLayerText(doc.info.producer))} >>`);
    return file.finish(catalogObjectNumber, infoObjectNumber);
}
