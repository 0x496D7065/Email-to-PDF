// Our own PDF backend: writes a laid-out document (layout.ts) as a PDF 1.7
// file. Objects plus a classic cross-reference table (pdf-file.ts); content
// streams and font files deflated; the four Plex fonts embedded whole when
// used (font-objects.ts); internal links, named destinations and bookmarks
// only.
//
// Safe by construction (README.md, rule R4): the file never gets /URI,
// /Launch, /JavaScript, /OpenAction, /AA, embedded files or forms; email
// text only ever becomes hex string data. No network (rule R1), nothing
// stored (rule R5), no dates, no author: the Info dictionary holds only
// /Title and /Producer.
import type { PdfFontName } from '../fonts';
import { copyLayerText } from './copy-text';
import { pageContent } from './content';
import { deflate } from './deflate';
import { checkEmbeddable, cidFont, fontDescriptor, FontUsage, toUnicodeCmap, type0Font, widthsArray } from './font-objects';
import type { LaidOutDocument, LaidOutOutlineItem, LaidOutTextRun, PdfBackend, PdfFontSet } from './layout';
import { MAX_OUTPUT_BYTES, PdfFile } from './pdf-file';
import { ascii, fail, hexText, int, name, num, PdfWriteError } from './syntax';

/** Most pages in one PDF. */
export const MAX_PAGES = 100_000;

/** Deepest bookmark nesting accepted. */
export const MAX_OUTLINE_DEPTH = 32;

/** Smallest and largest page side, in points (PDF's own limits: 3 to 14400). */
const MIN_PAGE_SIDE = 3;
const MAX_PAGE_SIDE = 14_400;

/** Fixed order and resource names of the fonts, so the output never depends on use order. */
const FONT_ORDER: readonly PdfFontName[] = ['sans-regular', 'sans-bold', 'sans-italic', 'mono-regular'];

export interface OwnPdfWriterOptions {
  /** Largest output, in bytes (default MAX_OUTPUT_BYTES, 256 MiB). */
  readonly maxBytes?: number;
  /** Most pages (default MAX_PAGES). */
  readonly maxPages?: number;
}

/** The hand-written PDF backend. */
export class OwnPdfWriter implements PdfBackend {
  constructor(private readonly options: OwnPdfWriterOptions = {}) {}

  /** Rejects only with a PdfWriteError: any other failure (a malformed shape the checks missed) is wrapped. */
  async render(doc: LaidOutDocument, fonts: PdfFontSet): Promise<Uint8Array> {
    try {
      return await writePdf(doc, fonts, this.options);
    } catch (error) {
      if (error instanceof PdfWriteError) throw error;
      throw new PdfWriteError('invalid laid-out document', { cause: error });
    }
  }
}

/** Array.isArray without narrowing a readonly array to any[] (the input may not match its type at run time). */
function isArray(value: unknown): boolean {
  return Array.isArray(value);
}

/** A non-null object (the input may not match its type at run time). */
function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

function checkPageSize(doc: LaidOutDocument): { width: number; height: number } {
  if (!isObject(doc) || !isObject(doc.pageSize)) fail('the document needs a page size');
  const { width, height } = doc.pageSize;
  for (const side of [width, height]) {
    if (typeof side !== 'number' || !(side >= MIN_PAGE_SIDE && side <= MAX_PAGE_SIDE)) {
      fail(`page size must be between ${MIN_PAGE_SIDE} and ${MAX_PAGE_SIDE} points, not ${String(side)}`);
    }
  }
  return { width, height };
}

/** Pass 1: every run's font and glyphs, so each ToUnicode map is final before any page is written. */
function collectFonts(doc: LaidOutDocument, fonts: PdfFontSet): Map<PdfFontName, FontUsage> {
  const usages = new Map<PdfFontName, FontUsage>();
  for (const page of doc.pages) {
    for (const run of page.text) {
      if (!isObject(run)) fail('a text run must be an object');
      if (!FONT_ORDER.includes(run.font)) fail(`unknown font: ${JSON.stringify(String(run.font)).slice(0, 40)}`);
      if (!isArray(run.glyphs) || !isArray(run.glyphText) || run.glyphs.length !== run.glyphText.length) {
        fail('a text run needs as many glyphText entries as glyphs');
      }
      if (typeof run.copyText !== 'string' || (run.actualText !== undefined && typeof run.actualText !== 'string')) {
        fail('a text run needs a copyText string (and actualText, if set, must be a string)');
      }
      if (run.glyphs.length === 0) continue;
      let usage = usages.get(run.font);
      if (usage === undefined) {
        const font = fonts[run.font];
        if (font === undefined) fail(`font ${run.font} is used but was not given`);
        checkEmbeddable(font);
        usage = new FontUsage(font, `F${FONT_ORDER.indexOf(run.font) + 1}`);
        usages.set(run.font, usage);
      }
      for (let i = 0; i < run.glyphs.length; i++) {
        const text = run.glyphText[i];
        if (typeof text !== 'string') fail('glyphText entries must be strings');
        usage.use(run.glyphs[i]!, text);
      }
    }
  }
  return usages;
}

interface OutlineNode {
  readonly item: LaidOutOutlineItem;
  readonly number: number;
  readonly children: OutlineNode[];
}

/** Object numbers for the bookmark tree (checked: depth, destinations). */
function allocOutline(
  file: PdfFile,
  items: readonly LaidOutOutlineItem[],
  destinations: ReadonlySet<string>,
  depth: number,
): OutlineNode[] {
  // Only items count as a level (a leaf's empty children list is not one).
  if (items.length > 0 && depth > MAX_OUTLINE_DEPTH) fail(`bookmarks are nested deeper than ${MAX_OUTLINE_DEPTH} levels`);
  return items.map((item) => {
    if (!isObject(item) || !isArray(item.children)) fail('a bookmark must be an object with a children array');
    if (typeof item.title !== 'string') fail('a bookmark title must be a string');
    if (!destinations.has(item.destination)) fail(`bookmark to an unknown destination: ${JSON.stringify(String(item.destination)).slice(0, 80)}`);
    return { item, number: file.alloc(), children: allocOutline(file, item.children, destinations, depth + 1) };
  });
}

/** Bookmarks shown under a node when it is open: its children and, recursively, those of open children. */
function openDescendants(node: OutlineNode): number {
  return node.children.reduce((sum, child) => sum + 1 + (child.item.open === true ? openDescendants(child) : 0), 0);
}

function writeOutline(file: PdfFile, nodes: readonly OutlineNode[], parent: number): void {
  nodes.forEach((node, index) => {
    const entries = [`/Title ${hexText(copyLayerText(node.item.title))}`, `/Parent ${parent} 0 R`, `/Dest ${name(node.item.destination)}`];
    const previous = nodes[index - 1];
    const next = nodes[index + 1];
    if (previous !== undefined) entries.push(`/Prev ${previous.number} 0 R`);
    if (next !== undefined) entries.push(`/Next ${next.number} 0 R`);
    if (node.children.length > 0) {
      const count = openDescendants(node);
      entries.push(`/First ${node.children[0]!.number} 0 R`, `/Last ${node.children.at(-1)!.number} 0 R`);
      entries.push(`/Count ${node.item.open === true ? count : -count}`);
    }
    file.object(node.number, `<< ${entries.join(' ')} >>`);
    writeOutline(file, node.children, node.number);
  });
}

/**
 * Writes the PDF. Throws a PdfWriteError for invalid input or a limit reached.
 * Internal: use OwnPdfWriter.render(), which guarantees PdfWriteError-only;
 * this function can throw other errors for shapes its checks miss.
 */
export async function writePdf(doc: LaidOutDocument, fonts: PdfFontSet, options: OwnPdfWriterOptions = {}): Promise<Uint8Array> {
  const maxPages = options.maxPages ?? MAX_PAGES;
  const { width, height } = checkPageSize(doc);
  if (!isArray(doc.pages) || doc.pages.length === 0) fail('a PDF needs at least one page');
  if (doc.pages.length > maxPages) fail(`the PDF would have ${doc.pages.length} pages, more than the limit of ${maxPages}`);
  if (typeof doc.info?.title !== 'string' || typeof doc.info.producer !== 'string') fail('info needs a title and a producer string');
  if (!isArray(doc.destinations)) fail('destinations must be an array');
  if (!isArray(doc.outline)) fail('the outline must be an array');
  for (const page of doc.pages) {
    if (!isObject(page) || !isArray(page.fills) || !isArray(page.lines) || !isArray(page.text) || !isArray(page.links)) {
      fail('a page needs fills, lines, text and links arrays');
    }
  }

  // Named destinations: our names only, each once, on an existing page.
  const destinations = new Map<string, { page: number; y: number }>();
  for (const destination of doc.destinations) {
    if (!isObject(destination)) fail('a destination must be an object');
    name(destination.name); // throws unless it is a valid name
    if (destinations.has(destination.name)) fail(`destination ${destination.name} is defined twice`);
    if (!Number.isInteger(destination.page) || destination.page < 0 || destination.page >= doc.pages.length) {
      fail(`destination ${destination.name} points to page ${String(destination.page)}, which does not exist`);
    }
    num(destination.y);
    destinations.set(destination.name, { page: destination.page, y: destination.y });
  }

  const usages = collectFonts(doc, fonts);
  const file = new PdfFile(options.maxBytes ?? MAX_OUTPUT_BYTES);
  const catalog = file.alloc();
  const pagesRoot = file.alloc();
  const info = file.alloc();
  const resources = file.alloc();
  const pageNumbers = doc.pages.map(() => file.alloc());

  // Fonts, in the fixed order (only the used ones).
  const fontEntries: string[] = [];
  for (const fontName of FONT_ORDER) {
    const usage = usages.get(fontName);
    if (usage === undefined) continue;
    const font = usage.font;
    const [type0, descendant, descriptor, fontFile, toUnicode] = [file.alloc(), file.alloc(), file.alloc(), file.alloc(), file.alloc()];
    file.object(type0, type0Font(font, descendant, toUnicode));
    file.object(descendant, cidFont(font, descriptor, widthsArray(font, usage.glyphs)));
    file.object(descriptor, fontDescriptor(font, fontFile));
    file.stream(fontFile, `/Filter /FlateDecode /Length1 ${int(font.sfnt.length)}`, await deflate(font.sfnt));
    file.stream(toUnicode, '/Filter /FlateDecode', await deflate(ascii(toUnicodeCmap(usage.toUnicode))));
    fontEntries.push(`${name(usage.resourceName)} ${type0} 0 R`);
  }
  file.object(resources, `<< /Font << ${fontEntries.join(' ')} >> >>`);

  // Pages: content stream and link annotations each.
  const usageOf = (run: LaidOutTextRun): FontUsage => usages.get(run.font)!;
  for (const [index, page] of doc.pages.entries()) {
    const content = file.alloc();
    const annots: number[] = [];
    for (const link of page.links) {
      if (!isObject(link) || !isObject(link.rect)) fail('a link needs a rect');
      if (!destinations.has(link.destination)) fail(`link to an unknown destination: ${JSON.stringify(String(link.destination)).slice(0, 80)}`);
      const { x, y, width: w, height: h } = link.rect;
      const annot = file.alloc();
      file.object(
        annot,
        `<< /Type /Annot /Subtype /Link /Rect [${num(x)} ${num(height - y - h)} ${num(x + w)} ${num(height - y)}] /Border [0 0 0] /Dest ${name(link.destination)} >>`,
      );
      annots.push(annot);
    }
    file.stream(content, '/Filter /FlateDecode', await deflate(ascii(pageContent(page, height, usageOf))));
    file.object(
      pageNumbers[index]!,
      `<< /Type /Page /Parent ${pagesRoot} 0 R /MediaBox [0 0 ${num(width)} ${num(height)}] /Resources ${resources} 0 R /Contents ${content} 0 R` +
        (annots.length > 0 ? ` /Annots [${annots.map((n) => `${n} 0 R`).join(' ')}]` : '') +
        ' >>',
    );
  }
  file.object(pagesRoot, `<< /Type /Pages /Kids [${pageNumbers.map((n) => `${n} 0 R`).join(' ')}] /Count ${doc.pages.length} >>`);

  // Named destinations: one /Dests dictionary (keys are names), in sorted order.
  const catalogEntries = ['/Type /Catalog', `/Pages ${pagesRoot} 0 R`, '/ViewerPreferences << /DisplayDocTitle true >>'];
  if (destinations.size > 0) {
    const dests = file.alloc();
    const entries = [...destinations.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, { page, y }]) => `${name(key)} [${pageNumbers[page]} 0 R /XYZ 0 ${num(height - y)} null]`);
    file.object(dests, `<< ${entries.join(' ')} >>`);
    catalogEntries.push(`/Dests ${dests} 0 R`);
  }

  // Bookmarks.
  if (doc.outline.length > 0) {
    const outlines = file.alloc();
    const nodes = allocOutline(file, doc.outline, new Set(destinations.keys()), 1);
    const visible = nodes.reduce((sum, node) => sum + 1 + (node.item.open === true ? openDescendants(node) : 0), 0);
    file.object(outlines, `<< /Type /Outlines /First ${nodes[0]!.number} 0 R /Last ${nodes.at(-1)!.number} 0 R /Count ${visible} >>`);
    writeOutline(file, nodes, outlines);
    catalogEntries.push(`/Outlines ${outlines} 0 R`, '/PageMode /UseOutlines');
  }

  file.object(catalog, `<< ${catalogEntries.join(' ')} >>`);
  file.object(info, `<< /Title ${hexText(copyLayerText(doc.info.title))} /Producer ${hexText(copyLayerText(doc.info.producer))} >>`);
  return file.finish(catalog, info);
}
