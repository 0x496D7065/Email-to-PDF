// Embedding one TrueType font, whole (no subsetting), as a Type0 font with a
// CIDFontType2 descendant: /Encoding /Identity-H (each glyph is drawn by its
// 2-byte glyph id) and /CIDToGIDMap /Identity. Also builds the font's /W
// widths (only the glyphs used) and its ToUnicode CMap (the copy layer, see
// copy-text.ts). Pure apart from deflate (README.md, rule R7).
import type { ParsedFont } from '../font/font';
import { copyLayerText } from './copy-text';
import { fail, hex4, int, name, num, utf16Hex } from './syntax';

/** fsType bit 1: "restricted license embedding", the font must not be embedded. */
const FS_TYPE_RESTRICTED = 0x0002;

/** Most UTF-16 code units one glyph maps to in ToUnicode (a CMap allows 512 bytes); longer texts use /ActualText. */
const MAX_GLYPH_TEXT_UNITS = 256;

/** Entries per bfchar / bfrange block (the CMap format's limit). */
const CMAP_BLOCK = 100;

/** What the document uses of one font: glyphs, and the text each stands for (first one wins). */
export class FontUsage {
  readonly glyphs = new Set<number>();
  readonly toUnicode = new Map<number, string>();

  constructor(
    readonly font: ParsedFont,
    readonly resourceName: string,
  ) {}

  /** Records a glyph and, if it has none yet, the copy-layer text it stands for. */
  use(glyph: number, text: string): void {
    if (!Number.isInteger(glyph) || glyph < 0 || glyph >= this.font.numGlyphs) {
      fail(`glyph id ${String(glyph)} is not in font ${this.font.postScriptName} (0 to ${this.font.numGlyphs - 1})`);
    }
    this.glyphs.add(glyph);
    if (this.toUnicode.has(glyph)) return;
    const copy = copyLayerText(text);
    if (copy !== '' && copy.length <= MAX_GLYPH_TEXT_UNITS) this.toUnicode.set(glyph, copy);
  }

  /** What a reader gets from ToUnicode for these glyphs. */
  yields(glyphs: readonly number[]): string {
    let text = '';
    for (const glyph of glyphs) text += this.toUnicode.get(glyph) ?? '';
    return text;
  }
}

/** Font units to PDF glyph space (1000 per em). */
function scale(font: ParsedFont, value: number): number {
  return (value * 1000) / font.unitsPerEm;
}

/** Throws unless the font's license allows embedding. */
export function checkEmbeddable(font: ParsedFont): void {
  if ((font.fsType & FS_TYPE_RESTRICTED) !== 0) {
    fail(`font ${font.postScriptName} has a restricted license (fsType bit 0x0002): it may not be embedded`);
  }
}

/**
 * The FontDescriptor values. Choices:
 * - Ascent / Descent: hhea ascender / descender, the values most PDF writers
 *   (pdfkit / fontkit among them) and macOS use; viewers only use them as a
 *   hint for selection boxes when the font is embedded;
 * - CapHeight: OS/2 sCapHeight; when the font has none (OS/2 version below
 *   2), the bounding box top (yMax), a safe upper bound (Plex has it);
 * - StemV: TrueType stores no stem width, so it is estimated from the weight
 *   class as 50 + (weightClass / 65)^2 (400 gives 88, 700 gives 166), the
 *   usual heuristic; viewers use it only to fake a missing font;
 * - Flags: Nonsymbolic (32), plus FixedPitch (1) and Italic (64) from the
 *   font; never Serif (Plex Sans and Mono have none).
 */
export function fontDescriptor(font: ParsedFont, fontFile: number): string {
  const flags = 32 | (font.isFixedPitch ? 1 : 0) | (font.isItalic || font.italicAngle !== 0 ? 64 : 0);
  const { xMin, yMin, xMax, yMax } = font.bbox;
  const capHeight = font.capHeight ?? yMax;
  const stemV = Math.round(50 + (font.weightClass / 65) ** 2);
  const entries = [
    '/Type /FontDescriptor',
    `/FontName ${name(font.postScriptName)}`,
    `/Flags ${flags}`,
    `/FontBBox [${[xMin, yMin, xMax, yMax].map((v) => num(scale(font, v))).join(' ')}]`,
    `/ItalicAngle ${num(font.italicAngle)}`,
    `/Ascent ${num(scale(font, font.hhea.ascender))}`,
    `/Descent ${num(scale(font, font.hhea.descender))}`,
    `/CapHeight ${num(scale(font, capHeight))}`,
    ...(font.xHeight === null ? [] : [`/XHeight ${num(scale(font, font.xHeight))}`]),
    `/StemV ${int(stemV)}`,
    `/MissingWidth ${num(scale(font, font.advance(0)))}`,
    `/FontFile2 ${fontFile} 0 R`,
  ];
  return `<< ${entries.join(' ')} >>`;
}

/**
 * The /W array for the used glyphs, compact: consecutive ids form one
 * group; a group of 3 or more equal widths is written "first last width",
 * any other group "first [w1 w2 ...]".
 */
export function widthsArray(font: ParsedFont, glyphs: Iterable<number>): string {
  const ids = [...glyphs].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < ids.length) {
    let end = i;
    while (end + 1 < ids.length && ids[end + 1] === ids[end]! + 1) end++;
    const widths = ids.slice(i, end + 1).map((id) => num(scale(font, font.advance(id))));
    if (widths.length >= 3 && widths.every((w) => w === widths[0])) {
      parts.push(`${ids[i]} ${ids[end]} ${widths[0]}`);
    } else {
      parts.push(`${ids[i]} [${widths.join(' ')}]`);
    }
    i = end + 1;
  }
  return `[${parts.join(' ')}]`;
}

/** The CIDFontType2 dictionary. */
export function cidFont(font: ParsedFont, descriptor: number, widths: string): string {
  return (
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont ${name(font.postScriptName)}` +
    ` /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>` +
    ` /FontDescriptor ${descriptor} 0 R /DW ${num(scale(font, font.advance(0)))} /W ${widths} /CIDToGIDMap /Identity >>`
  );
}

/** The Type0 font dictionary (what pages refer to). */
export function type0Font(font: ParsedFont, descendant: number, toUnicode: number): string {
  return (
    `<< /Type /Font /Subtype /Type0 /BaseFont ${name(font.postScriptName)} /Encoding /Identity-H` +
    ` /DescendantFonts [${descendant} 0 R] /ToUnicode ${toUnicode} 0 R >>`
  );
}

/** One code unit when a text is a single BMP character (usable in a bfrange), else undefined. */
function singleUnit(text: string): number | undefined {
  if (text.length !== 1) return undefined;
  const unit = text.charCodeAt(0);
  return unit >= 0xd800 && unit <= 0xdfff ? undefined : unit;
}

/**
 * The ToUnicode CMap: glyph id (2 bytes, Identity-H) to UTF-16BE text.
 * Runs of 2 or more consecutive glyph ids (same high byte) that map to
 * consecutive single BMP code units (without the last byte wrapping) become
 * one bfrange entry; everything else (one glyph, a pair, several code
 * points) a bfchar entry. At most 100 entries per block.
 */
export function toUnicodeCmap(map: ReadonlyMap<number, string>): string {
  const ids = [...map.keys()].sort((a, b) => a - b);
  const ranges: string[] = [];
  const chars: string[] = [];
  let i = 0;
  while (i < ids.length) {
    const first = ids[i]!;
    const start = singleUnit(map.get(first)!);
    let end = i;
    if (start !== undefined) {
      while (end + 1 < ids.length) {
        const next = ids[end + 1]!;
        const step = next - first;
        if (next !== ids[end]! + 1 || next >> 8 !== first >> 8) break;
        if (singleUnit(map.get(next)!) !== start + step || (start & 0xff) + step > 0xff) break;
        end++;
      }
    }
    if (end > i) {
      ranges.push(`<${hex4(first)}> <${hex4(ids[end]!)}> <${hex4(start!)}>`);
    } else {
      chars.push(`<${hex4(first)}> <${utf16Hex(map.get(first)!)}>`);
    }
    i = end + 1;
  }
  const blocks: string[] = [];
  for (let k = 0; k < chars.length; k += CMAP_BLOCK) {
    const block = chars.slice(k, k + CMAP_BLOCK);
    blocks.push(`${block.length} beginbfchar\n${block.join('\n')}\nendbfchar`);
  }
  for (let k = 0; k < ranges.length; k += CMAP_BLOCK) {
    const block = ranges.slice(k, k + CMAP_BLOCK);
    blocks.push(`${block.length} beginbfrange\n${block.join('\n')}\nendbfrange`);
  }
  return [
    '/CIDInit /ProcSet findresource begin',
    '12 dict begin',
    'begincmap',
    '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def',
    '/CMapName /Adobe-Identity-UCS def',
    '/CMapType 2 def',
    '1 begincodespacerange',
    '<0000> <FFFF>',
    'endcodespacerange',
    ...blocks,
    'endcmap',
    'CMapName currentdict /CIDResource defineresource pop',
    'end',
    'end',
    '',
  ].join('\n');
}
