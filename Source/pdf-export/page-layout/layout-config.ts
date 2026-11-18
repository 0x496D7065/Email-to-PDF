// How the PDF looks: page size, margins, the font, size and colour of each
// text role, and the spacing between parts. One plain object, so a change of
// look is a change of numbers here (or a different object passed to
// layoutPdf), never a change of the layout code.
//
// All lengths are PDF points (1/72 inch). Line heights are multiples of the
// font size. Colours are grey levels (0 black, 1 white). layoutPdf checks
// the config first (validateLayoutConfig) and throws a clear Error for one
// it cannot lay out.
import { TAB_WIDTH } from '../text';
import type { LaidOutColor, LayoutConfig, TextStyle } from '../../../Header/laid-out-document';
import type { PdfRole } from '../../../Header/pdf-document-model';

const TEXT_COLOR: LaidOutColor = { gray: 0.1 };
const GREY_COLOR: LaidOutColor = { gray: 0.42 };

/** The default look (A4, IBM Plex). */
export const DEFAULT_LAYOUT_CONFIG: LayoutConfig = {
    page: { width: 595.28, height: 841.89 },
    margin: { top: 56, right: 56, bottom: 56, left: 56 },
    roles: {
        title: { font: 'sans-bold', size: 20, color: TEXT_COLOR, lineHeight: 1.3 },
        heading: { font: 'sans-bold', size: 13, color: TEXT_COLOR, lineHeight: 1.3 },
        'field-label': { font: 'sans-bold', size: 9.5, color: GREY_COLOR, lineHeight: 1.35 },
        'field-value': { font: 'sans-regular', size: 9.5, color: TEXT_COLOR, lineHeight: 1.35 },
        body: { font: 'sans-regular', size: 10, color: TEXT_COLOR, lineHeight: 1.35 },
        muted: { font: 'sans-italic', size: 9.5, color: GREY_COLOR, lineHeight: 1.35 },
        code: { font: 'mono-regular', size: 9, color: GREY_COLOR, lineHeight: 1.35 },
    },
    footer: { style: { font: 'sans-regular', size: 8.5, color: GREY_COLOR, lineHeight: 1.3 }, baselineFromBottom: 30, align: 'center' },
    fields: { labelWidth: 78, gap: 10, rowGap: 1.5 },
    list: { bullet: '\u{2022}', indent: 12, itemGap: 3 },
    // One tab: 4 spaces of IBM Plex Sans Regular (0.236 em each) at 10 pt, 9.44 pt (task 8.9).
    bodyIndentSpaces: TAB_WIDTH,
    index: { numberWidth: 30, dateWidth: 88, fromWidth: 104, pageWidth: 36, gap: 8, rowGap: 5, headerGap: 4 },
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
    newPagePerEmail: true,
    keepBodyLines: 2,
};

/** The longest index page number the page column is sized for (999,999 pages). */
export const INDEX_PAGE_DIGITS = 6;
/** The widest digit of the bundled sans fonts, in em (IBM Plex Sans figures are 600/1000 em; a layout test measures it). */
export const MAX_DIGIT_EM = 0.6;
/** The longest short date of the index ("YYYY-MM-DD HH:mm"), in em, measured from the same fonts (a layout test checks it). */
export const SHORT_DATE_EM = 8.6;

/** One check of validateLayoutConfig. */
function checkConfig(ok: boolean, problem: string): void
{
    if (!ok)
    {
        throw new Error(`layout: invalid config: ${problem}`);
    }
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const requirePositive = (value: unknown, field: string): void =>
    checkConfig(isFiniteNumber(value) && value > 0, `${field} must be a finite number > 0`);
const requireNonNegative = (value: unknown, field: string): void =>
    checkConfig(isFiniteNumber(value) && value >= 0, `${field} must be a finite number >= 0`);

function checkStyle(style: TextStyle | undefined, field: string): void
{
    checkConfig(typeof style === 'object' && style !== null, `${field} is missing`);
    requirePositive(style!.size, `${field}.size`);
    requirePositive(style!.lineHeight, `${field}.lineHeight`);
}

const ROLE_NAMES: readonly PdfRole[] = ['title', 'heading', 'field-label', 'field-value', 'body', 'muted', 'code'];

/**
 * Throws a clear Error when a config cannot be laid out: lengths that are
 * not finite numbers, sizes and line heights that are not > 0, margins and
 * spacings < 0, margins that leave no text area, a label column that leaves
 * no room for the values. Fonts and colours are checked by the backend.
 */
export function validateLayoutConfig(config: LayoutConfig): void
{
    requirePositive(config.page.width, 'page.width');
    requirePositive(config.page.height, 'page.height');
    for (const side of ['top', 'right', 'bottom', 'left'] as const)
    {
        requireNonNegative(config.margin[side], `margin.${side}`);
    }
    const contentWidth = config.page.width - config.margin.left - config.margin.right;
    checkConfig(contentWidth > 0, 'the left and right margins leave no room for text');
    checkConfig(config.page.height - config.margin.top - config.margin.bottom > 0, 'the top and bottom margins leave no room for text');
    for (const role of ROLE_NAMES)
    {
        checkStyle(config.roles[role], `roles.${role}`);
    }
    checkStyle(config.footer.style, 'footer.style');
    requireNonNegative(config.footer.baselineFromBottom, 'footer.baselineFromBottom');
    checkConfig(config.footer.baselineFromBottom < config.page.height, 'footer.baselineFromBottom must be inside the page');
    checkConfig(config.footer.align === 'center' || config.footer.align === 'right', "footer.align must be 'center' or 'right'");
    requirePositive(config.fields.labelWidth, 'fields.labelWidth');
    requireNonNegative(config.fields.gap, 'fields.gap');
    requireNonNegative(config.fields.rowGap, 'fields.rowGap');
    checkConfig(config.fields.labelWidth + config.fields.gap < contentWidth, 'fields.labelWidth + fields.gap must be less than the text area width');
    checkConfig(typeof config.list.bullet === 'string', 'list.bullet must be a string');
    requirePositive(config.list.indent, 'list.indent');
    checkConfig(config.list.indent < contentWidth, 'list.indent must be less than the text area width');
    requireNonNegative(config.list.itemGap, 'list.itemGap');
    checkConfig(Number.isInteger(config.bodyIndentSpaces) && config.bodyIndentSpaces >= 1, 'bodyIndentSpaces must be a whole number >= 1');
    const indexConfig = config.index;
    for (const name of ['numberWidth', 'dateWidth', 'fromWidth', 'pageWidth'] as const)
    {
        requirePositive(indexConfig[name], `index.${name}`);
    }
    for (const name of ['gap', 'rowGap', 'headerGap'] as const)
    {
        requireNonNegative(indexConfig[name], `index.${name}`);
    }
    checkConfig(
        indexConfig.numberWidth + indexConfig.dateWidth + indexConfig.fromWidth + indexConfig.pageWidth + 4 * indexConfig.gap < contentWidth,
        'the index columns and gaps must leave room for the subject column',
    );
    // A page number and a short date each stay on one line (see INDEX_PAGE_DIGITS, SHORT_DATE_EM).
    const bodySize = config.roles.body.size;
    checkConfig(indexConfig.pageWidth >= INDEX_PAGE_DIGITS * MAX_DIGIT_EM * bodySize - 1e-9, `index.pageWidth must hold a ${String(INDEX_PAGE_DIGITS)}-digit page number`);
    checkConfig(indexConfig.dateWidth >= SHORT_DATE_EM * bodySize - 1e-9, 'index.dateWidth must hold a date as "YYYY-MM-DD HH:mm" on one line');
    // The attachment lines of an index row run from the date column to the end of the subject column.
    checkConfig(config.list.indent < contentWidth - indexConfig.numberWidth - indexConfig.pageWidth - 2 * indexConfig.gap, 'list.indent must be less than the width of the index attachment lines');
    for (const [name, value] of Object.entries(config.spacing))
    {
        requireNonNegative(value, `spacing.${name}`);
    }
    requireNonNegative(config.rule.width, 'rule.width');
    checkConfig(typeof config.newPagePerEmail === 'boolean', 'newPagePerEmail must be true or false');
    checkConfig(Number.isInteger(config.keepBodyLines) && config.keepBodyLines >= 0, 'keepBodyLines must be a whole number >= 0');
}
