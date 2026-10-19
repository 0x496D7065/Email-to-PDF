// The typesetter: one PdfLine (runs with roles, src/pdf/text.ts) in, wrapped
// lines out (wrap), each then drawn at a place as text runs for the backend
// (emit). It owns the styles, the shaper and the line breaker.
//
// Line box and baseline: each style's line box is `size x lineHeight` high.
// The font's glyph box is hhea ascender to hhea descender (lineGap ignored;
// it is 0 in IBM Plex) and sits in the middle of the line box (the extra
// space split above and below, as CSS does). A line mixing styles is as
// high as needed for all of them on one shared baseline; the default style
// of the context (body text in a body, a value in a field) always counts,
// so lines keep one even pitch whatever their content (an empty line too).
//
// Runs: one per stretch of items with the same style on a line that draws
// at least one glyph. Each run's glyphText gives the text of each glyph (a
// composed glyph: its NFC text; a placeholder: the characters of
// "[U+XXXX]"); its copyText is the original text of its items (the backend
// writes it as /ActualText when the glyphs say something else,
// src/pdf/writer/layout.ts). A stretch with no glyph at all (only group 2
// characters, e.g. a line holding only an LRM or a ZWSP, or a ZWSP between
// an emoji's codes and the end of the line) makes no run, so its copy text
// is not written: nothing is seen there, and the copy layer would drop
// those characters anyway (src/pdf/writer/copy-text.ts).
// "What you copy is what you see": a soft hyphen where the line breaks is
// drawn as "-" and copies as "-"; elsewhere it is not drawn and is not in
// the copy text either. Pure (README.md, rule R7).
import type { ParsedFont } from '../font/font';
import type { PdfFontName } from '../fonts';
import type { PdfLine, PdfRole } from '../text';
import type { LaidOutTextRun } from '../writer/layout';
import type { LayoutConfig, TextStyle } from './config';
import { FontMetrics } from './font-metrics';
import { breakLines, SHY_NONE } from './line-break';
import { type ResolvedStyle, type ShapedText, Shaper, SOFT_HYPHEN_ITEM, type StyledText } from './shape';

const ROLES: readonly PdfRole[] = ['title', 'heading', 'field-label', 'field-value', 'body', 'muted', 'code', 'mono'];
const HYPHEN = 0x2d;

/** One wrapped line, ready to be drawn. */
export interface LaidLine {
  readonly text: ShapedText;
  readonly start: number;
  readonly end: number;
  readonly hyphenAt: number;
  /** Drawn width in points (trailing spaces not counted). */
  readonly width: number;
  /** Height of the line box in points. */
  readonly height: number;
  /** From the top of the line box to the baseline. */
  readonly above: number;
}

export class Typesetter {
  private readonly styles: ResolvedStyle[] = [];
  private readonly roleStyle = new Map<PdfRole, number>();
  private readonly shaper: Shaper;

  constructor(fonts: Readonly<Record<PdfFontName, ParsedFont>>, config: LayoutConfig) {
    const metrics = new Map<PdfFontName, FontMetrics>();
    const metricsOf = (name: PdfFontName): FontMetrics => {
      let m = metrics.get(name);
      if (m === undefined) {
        const font = fonts[name];
        if (font === undefined) throw new Error(`layout: font ${name} was not given`);
        m = new FontMetrics(font);
        metrics.set(name, m);
      }
      return m;
    };
    for (const role of ROLES) this.roleStyle.set(role, this.addStyle(config.roles[role], metricsOf));
    this.footerStyle = this.addStyle(config.footer.style, metricsOf);
    this.shaper = new Shaper(this.styles, this.styleOf('code'));
  }

  /** The style index of the page footer. */
  readonly footerStyle: number;

  /** Characters drawn as "[U+XXXX]" codes so far (one per code point). */
  get placeholders(): number {
    return this.shaper.placeholders;
  }

  private addStyle(style: TextStyle, metricsOf: (name: PdfFontName) => FontMetrics): number {
    const m = metricsOf(style.font);
    const box = style.size * style.lineHeight;
    const glyphBox = (m.ascent - m.descent) * style.size;
    const above = (box - glyphBox) / 2 + m.ascent * style.size;
    this.styles.push({ style, metrics: m, above, below: box - above });
    return this.styles.length - 1;
  }

  styleOf(role: PdfRole): number {
    return this.roleStyle.get(role)!;
  }

  /** Height of one line of a role's style alone (an empty line). */
  lineHeight(role: PdfRole): number {
    const s = this.styles[this.styleOf(role)]!;
    return s.above + s.below;
  }

  /**
   * Wraps one line to `maxWidth` points. Runs use the style of their role,
   * or `style` for all of them when given (the footer). `strut` is the
   * context's role (its line box always counts).
   */
  wrap(line: PdfLine, maxWidth: number, strut: PdfRole, style?: number): LaidLine[] {
    const runs: StyledText[] = line.map((r) => ({ style: style ?? this.styleOf(r.role), text: r.text }));
    const shaped = this.shaper.shape(runs);
    const strutStyle = this.styles[style ?? this.styleOf(strut)]!;
    const ranges = breakLines(shaped, maxWidth, (i) => this.hyphenWidth(shaped.style[i]!));
    return ranges.map((r) => {
      let above = strutStyle.above;
      let below = strutStyle.below;
      let last = -1;
      for (let i = r.start; i < r.end; i++) {
        const s = shaped.style[i]!;
        if (s === last) continue;
        last = s;
        const st = this.styles[s]!;
        if (st.above > above) above = st.above;
        if (st.below > below) below = st.below;
      }
      return { text: shaped, start: r.start, end: r.end, hyphenAt: r.hyphenAt, width: r.width, height: above + below, above };
    });
  }

  private hyphenWidth(style: number): number {
    const { metrics, style: look } = this.styles[style]!;
    return metrics.advance(metrics.glyph(HYPHEN)) * look.size;
  }

  /** Draws a wrapped line with its left end at `x` and its top at `top`: appends its runs to `out`. */
  emit(line: LaidLine, x: number, top: number, out: LaidOutTextRun[]): void {
    const { text } = line;
    const baseline = top + line.above;
    let runStyle = -1;
    let runX = x;
    let pen = x;
    let glyphs: number[] = [];
    let glyphText: string[] = [];
    let copy = '';
    const flush = (): void => {
      if (glyphs.length > 0) {
        const { style } = this.styles[runStyle]!;
        out.push({ font: style.font, size: style.size, x: runX, y: baseline, color: style.color, glyphs, glyphText, copyText: copy });
      }
      glyphs = [];
      glyphText = [];
      copy = '';
    };
    for (let i = line.start; i < line.end; i++) {
      const s = text.style[i]!;
      if (s !== runStyle) {
        flush();
        runStyle = s;
        runX = pen;
      }
      for (let g = text.glyphStart(i); g < text.glyphEnd[i]!; g++) {
        glyphs.push(text.glyphs[g]!);
        glyphText.push(text.glyphText[g]!);
      }
      pen += text.width[i]!;
      if (i === line.hyphenAt && line.hyphenAt !== SHY_NONE) {
        const { metrics } = this.styles[s]!;
        glyphs.push(metrics.glyph(HYPHEN));
        glyphText.push('-');
        copy += '-';
        pen += this.hyphenWidth(s);
      } else if ((text.kind[i]! & SOFT_HYPHEN_ITEM) === 0) {
        // A soft hyphen not at the break is not drawn, so it is not copied either.
        // So "letter + U+00AD + VS16" copies as "letter + VS16": the VS16 now follows
        // the letter and the copy layer keeps it (invisible, stable), unlike
        // copyLayerText on the raw text, which drops a VS16 after a soft hyphen.
        copy += text.copy[i]!;
      }
    }
    flush();
  }
}
