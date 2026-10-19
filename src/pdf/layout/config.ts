// How the PDF looks: page size, margins, the font, size and colour of each
// text role, and the spacing between parts. One plain object, so a change of
// look is a change of numbers here (or a different object passed to
// layoutPdf), never a change of the layout code.
//
// All lengths are PDF points (1/72 inch). Line heights are multiples of the
// font size. Colours are grey levels (0 black, 1 white). layoutPdf checks
// the config first (validateLayoutConfig) and throws a clear Error for one
// it cannot lay out.
import type { PdfFontName } from '../fonts';
import type { PdfRole } from '../text';
import type { LaidOutColor } from '../writer/layout';

/** How one kind of text looks. */
export interface TextStyle {
  readonly font: PdfFontName;
  /** Font size in points. */
  readonly size: number;
  readonly color: LaidOutColor;
  /** Line height as a multiple of the size (see the top of typesetter.ts for the baseline). */
  readonly lineHeight: number;
}

export interface LayoutConfig {
  /** Page size in points (A4 by default). */
  readonly page: { readonly width: number; readonly height: number };
  /** Text area margins. The footer sits inside the bottom margin. */
  readonly margin: { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number };
  /** The look of each text role (src/pdf/text.ts, PdfRole). 'code' is also used for missing-glyph placeholders. */
  readonly roles: Readonly<Record<PdfRole, TextStyle>>;
  /** The page footer ("Page 3 of 12"): its style, and its baseline's distance from the page bottom. */
  readonly footer: { readonly style: TextStyle; readonly baselineFromBottom: number; readonly align: 'center' | 'right' };
  /** Label/value tables (email header rows, the cover summary). */
  readonly fields: { readonly labelWidth: number; readonly gap: number; readonly rowGap: number };
  /** Lists (cover): the bullet and the indent of the item text. */
  readonly list: { readonly bullet: string; readonly indent: number; readonly itemGap: number };
  readonly spacing: {
    /** After the document title. */
    readonly afterTitle: number;
    /** Before a section heading of the cover (not at the top of a page). */
    readonly beforeSection: number;
    /** After a section heading or an email heading. */
    readonly afterHeading: number;
    /** Between two cover blocks. */
    readonly betweenBlocks: number;
    /** After an email's header table. */
    readonly afterFields: number;
    /** After an email's notes. */
    readonly afterNotes: number;
    /** Before an email's attachment list. */
    readonly beforeAttachments: number;
    /** Between two emails on one page; the rule is drawn in the middle. */
    readonly betweenEmails: number;
    /** A destination (link or bookmark target) is put this far above its heading. */
    readonly destinationAbove: number;
  };
  /** The thin rule between two emails. */
  readonly rule: { readonly width: number; readonly color: LaidOutColor };
  /** Start every email on a new page (default: emails follow each other). */
  readonly newPagePerEmail: boolean;
  /** An email starts on a page only if its heading, header table, notes and this many body lines fit there. */
  readonly keepBodyLines: number;
}

const TEXT: LaidOutColor = { gray: 0.1 };
const GREY: LaidOutColor = { gray: 0.42 };

/** The default look (A4, IBM Plex). */
export const DEFAULT_LAYOUT_CONFIG: LayoutConfig = {
  page: { width: 595.28, height: 841.89 },
  margin: { top: 56, right: 56, bottom: 56, left: 56 },
  roles: {
    title: { font: 'sans-bold', size: 20, color: TEXT, lineHeight: 1.3 },
    heading: { font: 'sans-bold', size: 13, color: TEXT, lineHeight: 1.3 },
    'field-label': { font: 'sans-bold', size: 9.5, color: GREY, lineHeight: 1.35 },
    'field-value': { font: 'sans-regular', size: 9.5, color: TEXT, lineHeight: 1.35 },
    body: { font: 'sans-regular', size: 10, color: TEXT, lineHeight: 1.35 },
    muted: { font: 'sans-italic', size: 9.5, color: GREY, lineHeight: 1.35 },
    code: { font: 'mono-regular', size: 9, color: GREY, lineHeight: 1.35 },
    mono: { font: 'mono-regular', size: 8.5, color: TEXT, lineHeight: 1.35 },
  },
  footer: { style: { font: 'sans-regular', size: 8.5, color: GREY, lineHeight: 1.3 }, baselineFromBottom: 30, align: 'center' },
  fields: { labelWidth: 78, gap: 10, rowGap: 1.5 },
  list: { bullet: '\u{2022}', indent: 12, itemGap: 3 },
  spacing: {
    afterTitle: 14,
    beforeSection: 16,
    afterHeading: 6,
    betweenBlocks: 8,
    afterFields: 8,
    afterNotes: 6,
    beforeAttachments: 8,
    betweenEmails: 28,
    destinationAbove: 8,
  },
  rule: { width: 0.5, color: { gray: 0.75 } },
  newPagePerEmail: false,
  keepBodyLines: 2,
};

/** One check of validateLayoutConfig. */
function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`layout: invalid config: ${what}`);
}

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const positive = (value: unknown, what: string): void => check(isNumber(value) && value > 0, `${what} must be a finite number > 0`);
const nonNegative = (value: unknown, what: string): void => check(isNumber(value) && value >= 0, `${what} must be a finite number >= 0`);

function checkStyle(style: TextStyle | undefined, what: string): void {
  check(typeof style === 'object' && style !== null, `${what} is missing`);
  positive(style!.size, `${what}.size`);
  positive(style!.lineHeight, `${what}.lineHeight`);
}

const ROLE_NAMES: readonly PdfRole[] = ['title', 'heading', 'field-label', 'field-value', 'body', 'muted', 'code', 'mono'];

/**
 * Throws a clear Error when a config cannot be laid out: lengths that are
 * not finite numbers, sizes and line heights that are not > 0, margins and
 * spacings < 0, margins that leave no text area, a label column that leaves
 * no room for the values. Fonts and colours are checked by the backend.
 */
export function validateLayoutConfig(config: LayoutConfig): void {
  positive(config.page.width, 'page.width');
  positive(config.page.height, 'page.height');
  for (const side of ['top', 'right', 'bottom', 'left'] as const) nonNegative(config.margin[side], `margin.${side}`);
  const contentWidth = config.page.width - config.margin.left - config.margin.right;
  check(contentWidth > 0, 'the left and right margins leave no room for text');
  check(config.page.height - config.margin.top - config.margin.bottom > 0, 'the top and bottom margins leave no room for text');
  for (const role of ROLE_NAMES) checkStyle(config.roles[role], `roles.${role}`);
  checkStyle(config.footer.style, 'footer.style');
  nonNegative(config.footer.baselineFromBottom, 'footer.baselineFromBottom');
  check(config.footer.baselineFromBottom < config.page.height, 'footer.baselineFromBottom must be inside the page');
  check(config.footer.align === 'center' || config.footer.align === 'right', "footer.align must be 'center' or 'right'");
  positive(config.fields.labelWidth, 'fields.labelWidth');
  nonNegative(config.fields.gap, 'fields.gap');
  nonNegative(config.fields.rowGap, 'fields.rowGap');
  check(config.fields.labelWidth + config.fields.gap < contentWidth, 'fields.labelWidth + fields.gap must be less than the text area width');
  check(typeof config.list.bullet === 'string', 'list.bullet must be a string');
  positive(config.list.indent, 'list.indent');
  check(config.list.indent < contentWidth, 'list.indent must be less than the text area width');
  nonNegative(config.list.itemGap, 'list.itemGap');
  for (const [name, value] of Object.entries(config.spacing)) nonNegative(value, `spacing.${name}`);
  nonNegative(config.rule.width, 'rule.width');
  check(typeof config.newPagePerEmail === 'boolean', 'newPagePerEmail must be true or false');
  check(Number.isInteger(config.keepBodyLines) && config.keepBodyLines >= 0, 'keepBodyLines must be a whole number >= 0');
}
