// The layout end to end: documents built with buildPdfDocument from synthetic
// emails (made-up names, *.test addresses, UTC), laid out with the real IBM
// Plex fonts, checked for pagination, footers, destinations, and written
// with the own backend and read back with the test reader. Plus time bounds.
// Special characters are written as braced escapes (ASCII file).
import { beforeAll, describe, expect, it } from 'vitest';
import { parseToUnicode, readContent, readDests, readPdf, type ParsedPdf, PdfString } from '../../../tests/support/pdf-reader';
import { runEngine } from '../../engine/engine';
import { DEFAULT_OUTPUT_POLICY, planOutput } from '../../engine/output-plan';
import type { EmailAddress, NormalizedMessage, ParseResult } from '../../parsing/types';
import { type ParsedFont, readWoffFont } from '../font/font';
import { PDF_FONTS, type PdfFontName } from '../fonts';
import { buildPdfDocument, emailAnchor, type PdfBlock, type PdfDocument, type PdfEmail, type PdfFieldRow } from '../model';
import { createPdfStrings } from '../strings';
import { OwnPdfWriter } from '../writer';
import type { LaidOutDocument, LaidOutTextRun } from '../writer/layout';
import { DEFAULT_LAYOUT_CONFIG as CONFIG, INDEX_PAGE_DIGITS, type LayoutConfig, MAX_DIGIT_EM, SHORT_DATE_EM, type TextStyle } from './config';
import { layoutPdf, type PdfLayout } from './pdf-layout';
import { Typesetter } from './typesetter';

const fonts = {} as Record<PdfFontName, ParsedFont>;
beforeAll(async () => {
  for (const name of Object.keys(PDF_FONTS) as PdfFontName[]) fonts[name] = await readWoffFont(PDF_FONTS[name]);
});

const strings = createPdfStrings('en');
const ALICE: EmailAddress = { name: 'Alice Example', address: 'alice@example.test' };
const BOB: EmailAddress = { name: 'Bob Sample', address: 'bob@furniture.example.test' };
const BASE_MS = Date.UTC(2025, 2, 4, 8, 0, 0);
let counter = 0;

function make(fields: Partial<NormalizedMessage> = {}): NormalizedMessage {
  counter++;
  return {
    messageId: `pdf-layout-${String(counter)}@example.test`,
    inReplyTo: null,
    references: [],
    date: { utcMs: BASE_MS + counter * 3_600_000, original: 'Tue, 4 Mar 2025 08:00:00 +0000', offsetMinutes: 0, zoneKnown: true },
    from: [ALICE],
    to: [BOB],
    cc: [],
    bcc: [],
    subject: `Desks ${String(counter)}`,
    bodyText: `Hello Bob,\n\nThe desks arrive on Monday, note ${String(counter)}.\n\nAlice\n`,
    attachments: [],
    source: { fileName: `file-${String(counter)}.eml`, sha256: counter.toString(16).padStart(64, '0'), kind: 'eml' },
    warnings: [],
    ...fields,
  };
}

function build(messages: readonly NormalizedMessage[]): PdfDocument {
  const results: ParseResult[] = messages.map((message) => ({ ok: true, message }));
  const result = runEngine(results);
  const positions = result.messages.map((_, k) => k);
  const plans = planOutput(
    positions.map((p) => result.messages[p]!),
    DEFAULT_OUTPUT_POLICY,
  );
  return buildPdfDocument({ result, positions, plans, policy: DEFAULT_OUTPUT_POLICY, timeZone: 'UTC', generatedAt: Date.UTC(2025, 5, 1, 12, 0, 0), strings });
}

const lay = (doc: PdfDocument, newPagePerEmail?: boolean): PdfLayout =>
  layoutPdf(doc, fonts, { strings, ...(newPagePerEmail === undefined ? {} : { newPagePerEmail }) });

/** Lines of body text, each unique ("Line 3 of email 7"). */
const lines = (email: number, count: number): string => Array.from({ length: count }, (_, i) => `Line ${String(i + 1)} of email ${String(email)}.`).join('\n');

const TOP = CONFIG.margin.top;
const BOTTOM = CONFIG.page.height - CONFIG.margin.bottom;
const isFooter = (run: LaidOutTextRun): boolean => run.y > BOTTOM;

/** The page (0-based) of the first run whose copy text is `text`, from page `from` on (e.g. the first email page). */
function pageOf(doc: LaidOutDocument, text: string, from = 0): number {
  const k = doc.pages.slice(from).findIndex((p) => p.text.some((r) => r.copyText === text));
  return k < 0 ? -1 : from + k;
}

/** The destinations of the emails (not the cover's nor the index's). */
const emailDestinations = (doc: LaidOutDocument) => doc.destinations.filter((d) => d.name.startsWith('email-'));

function runWidth(run: LaidOutTextRun): number {
  const font = fonts[run.font];
  let end = run.glyphs.length;
  while (end > 0 && run.glyphText[end - 1] === ' ') end--;
  let w = 0;
  for (let i = 0; i < end; i++) w += font.advance(run.glyphs[i]!);
  return (w * run.size) / font.unitsPerEm;
}

function expectInsideTextArea(doc: LaidOutDocument): void {
  for (const page of doc.pages) {
    for (const run of page.text) {
      if (isFooter(run)) continue;
      expect(run.y).toBeGreaterThan(TOP);
      expect(run.y).toBeLessThanOrEqual(BOTTOM);
      expect(run.x).toBeGreaterThanOrEqual(CONFIG.margin.left - 1e-6);
      expect(run.x + runWidth(run)).toBeLessThanOrEqual(CONFIG.page.width - CONFIG.margin.right + 1e-6);
    }
  }
}

describe('layoutPdf: document', () => {
  it('lays out the cover, the index from a new page, then the emails from a new page; info and outline', () => {
    const doc = build([make(), make(), make()]);
    const { document, anchorPages, placeholders, frontPages, passes } = lay(doc);
    expect(document.pageSize).toEqual({ width: 595.28, height: 841.89 });
    expect(document.info).toEqual({ title: 'Email correspondence', producer: 'Email to PDF' });
    expect(document.outline.map((o) => [o.title, o.destination])).toEqual([
      ['Cover', 'cover'],
      ['Index', 'index'],
      ...doc.index.entries.map((e) => [e.bookmark, e.anchor]),
    ]);
    expect(pageOf(document, 'Email correspondence')).toBe(0);
    expect(pageOf(document, 'Source files')).toBe(0);
    expect(pageOf(document, 'Index')).toBe(1);
    expect(frontPages).toBe(2);
    expect(passes).toBe(2);
    // Each email on a page of its own (the default, task 8.4).
    expect([...anchorPages.entries()]).toEqual([
      ['email-1', 2],
      ['email-2', 3],
      ['email-3', 4],
    ]);
    expect(placeholders).toBe(0);
    expectInsideTextArea(document);
    // Plain data: survives structured cloning unchanged.
    expect(structuredClone(document)).toEqual(document);
  });

  it('counts each placeholder once, though the cover is laid out on every pass', () => {
    // A file name with a character the fonts lack: drawn as a code on the cover (source list) and in the email (File row).
    const doc = build([make({ source: { fileName: '\u{4E00}.eml', sha256: 'a'.repeat(64), kind: 'eml' } })]);
    const { document, placeholders, passes } = lay(doc);
    expect(passes).toBe(2);
    const drawn = document.pages.flatMap((p) => p.text).filter((r) => r.glyphText.join('').includes('[U+4E00]'));
    expect(drawn.map((r) => r.copyText)).toEqual(['\u{4E00}', '\u{4E00}']);
    expect(pageOf(document, '\u{4E00}')).toBe(0);
    expect(placeholders).toBe(2);
  });

  it('writes "Page X of Y" in the footer of every page, centred', () => {
    const doc = build(Array.from({ length: 30 }, (_, k) => make({ bodyText: lines(k + 1, 12) })));
    const { document } = lay(doc);
    const total = document.pages.length;
    expect(total).toBeGreaterThan(3);
    for (const [i, page] of document.pages.entries()) {
      const footers = page.text.filter(isFooter);
      expect(footers.map((r) => r.copyText)).toEqual([`Page ${String(i + 1)} of ${String(total)}`]);
      const run = footers[0]!;
      expect(run.y).toBeCloseTo(CONFIG.page.height - CONFIG.footer.baselineFromBottom, 6);
      expect(run.x + runWidth(run) / 2).toBeCloseTo(CONFIG.page.width / 2, 4);
      expect(run.font).toBe(CONFIG.footer.style.font);
    }
    expectInsideTextArea(document);
  });

  it('puts one destination per email at its heading; anchorPages gives its 0-based page', () => {
    const doc = build(Array.from({ length: 25 }, (_, k) => make({ bodyText: lines(k + 1, 15) })));
    const { document, anchorPages } = lay(doc);
    expect(document.destinations.map((d) => d.name)).toEqual(['cover', 'index', ...doc.emails.map((e) => e.anchor)]);
    // The heading's baseline is this far below the top of its line box.
    const above = new Typesetter(fonts, CONFIG).wrap([{ role: 'heading', text: 'Email 1' }], 1e6, 'heading')[0]!.above;
    for (const d of emailDestinations(document)) {
      expect(anchorPages.get(d.name)).toBe(d.page);
      const heading = document.pages[d.page]!.text.find((r) => r.copyText === `Email ${d.name.slice('email-'.length)}`);
      expect(heading).toBeDefined();
      expect(d.y).toBeCloseTo(heading!.y - above - CONFIG.spacing.destinationAbove, 6);
    }
    // The first email starts at the top of its page.
    expect(emailDestinations(document)[0]!.y).toBeCloseTo(TOP - CONFIG.spacing.destinationAbove, 6);
    expect(emailAnchor(25)).toMatch(/^[A-Za-z0-9._-]+$/);
  });
});

describe('layoutPdf: pagination', () => {
  it('never leaves a heading alone: header table and the first two body lines are on its page', () => {
    // Bodies of varying length, so emails start all over the page when they follow each other (option off).
    const doc = build(Array.from({ length: 60 }, (_, k) => make({ bodyText: lines(k + 1, 1 + ((k * 7) % 23)) })));
    for (const newPagePerEmail of [false, true]) {
      const { document, anchorPages } = lay(doc, newPagePerEmail);
      expect(document.pages.length).toBeGreaterThan(5);
      for (const email of doc.emails) {
        const page = anchorPages.get(email.anchor)!;
        const n = String(email.number);
        expect(pageOf(document, `Email ${n}`)).toBe(page);
        expect(pageOf(document, `Line 1 of email ${n}.`)).toBe(page);
        if (email.body.length > 1) expect(pageOf(document, `Line 2 of email ${n}.`)).toBe(page);
      }
      expectInsideTextArea(document);
    }
  });

  it('puts each email on its own page by default; with newPagePerEmail off, emails follow each other with a rule between', () => {
    const doc = build(Array.from({ length: 5 }, () => make()));
    expect(CONFIG.newPagePerEmail).toBe(true);
    const apart = lay(doc);
    expect(apart.frontPages).toBe(2);
    expect([...apart.anchorPages.values()]).toEqual([2, 3, 4, 5, 6]);
    expect(apart.document.pages).toHaveLength(7);
    for (const page of apart.document.pages.slice(2)) expect(page.lines).toHaveLength(0);
    // The explicit option does the same.
    expect([...lay(doc, true).anchorPages.values()]).toEqual([2, 3, 4, 5, 6]);
    // Switched off (option or config): four short emails start on the first email page (after the cover and
    // the index), the fifth on the next one, below the end of the fourth; a rule between each two.
    const together = lay(doc, false);
    expect(together.frontPages).toBe(2);
    expect([...together.anchorPages.values()]).toEqual([2, 2, 2, 2, 3]);
    expect(together.document.pages.slice(2).flatMap((p) => p.lines)).toHaveLength(4);
    const rules = together.document.pages[2]!.lines;
    for (const rule of rules) expect(rule).toMatchObject({ x1: CONFIG.margin.left, x2: CONFIG.page.width - CONFIG.margin.right, width: CONFIG.rule.width });
    const viaConfig = layoutPdf(doc, fonts, { strings, config: { ...CONFIG, newPagePerEmail: false } });
    expect([...viaConfig.anchorPages.values()]).toEqual([2, 2, 2, 2, 3]);
  });

  it('by default starts every email at the top of a new page, with no empty page, whatever the length of the one before', () => {
    // The email before ends anywhere on its page, its last page full too; one longer than a page.
    const above = new Typesetter(fonts, CONFIG).wrap([{ role: 'heading', text: 'Email 1' }], 1e6, 'heading')[0]!.above;
    for (let n = 1; n <= 130; n += 3) {
      const counts = [n, 1, 2 * n, 3];
      const doc = build(counts.map((c, k) => make({ bodyText: lines(k + 1, c) })));
      const { document, anchorPages, frontPages } = lay(doc);
      const starts = doc.emails.map((e) => anchorPages.get(e.anchor)!);
      expect(starts[0]).toBe(frontPages);
      for (let k = 1; k < starts.length; k++) expect(starts[k]).toBeGreaterThan(starts[k - 1]!);
      for (const [k, email] of doc.emails.entries()) {
        const page = document.pages[starts[k]!]!;
        // The heading is the first line of its page, at the top of the text area; its destination just above it.
        const first = page.text.filter((r) => !isFooter(r)).reduce((a, b) => (b.y < a.y ? b : a));
        expect(first.copyText).toBe(`Email ${String(email.number)}`);
        expect(first.y).toBeCloseTo(TOP + above, 6);
        const dest = document.destinations.find((d) => d.name === email.anchor)!;
        expect(dest.page).toBe(starts[k]);
        expect(dest.y).toBeCloseTo(TOP - CONFIG.spacing.destinationAbove, 6);
        // Each email's pages hold only that email: its last body line is before the next email's page.
        const lastLine = pageOf(document, `Line ${String(counts[k])} of email ${String(email.number)}.`, frontPages);
        expect(lastLine).toBeGreaterThanOrEqual(starts[k]!);
        if (k + 1 < starts.length) expect(lastLine).toBe(starts[k + 1]! - 1);
      }
      // No empty page: every page has text besides its footer, and no rules between emails.
      for (const page of document.pages) expect(page.text.some((r) => !isFooter(r))).toBe(true);
      for (const page of document.pages.slice(frontPages)) expect(page.lines).toHaveLength(0);
      expectInsideTextArea(document);
    }
  });

  it('breaks a header row taller than a page between its lines, then goes on', () => {
    const many = Array.from({ length: 600 }, (_, k) => ({ name: `Person ${String(k)} Example`, address: `person${String(k)}@example.test` }));
    const doc = build([make({ to: many, bodyText: 'Short body.' })]);
    const { document, anchorPages, frontPages } = lay(doc);
    // The cover lists all 601 people, over several pages.
    const first = anchorPages.get('email-1')!;
    expect(first).toBeGreaterThan(2);
    expect(first).toBe(frontPages);
    const toPage = pageOf(document, 'To', frontPages);
    const datePage = pageOf(document, 'Date', frontPages);
    expect(toPage).toBe(first);
    expect(datePage).toBeGreaterThan(toPage + 1);
    expect(pageOf(document, 'Short body.')).toBe(datePage);
    // The To value starts beside its label and goes on, page after page.
    const toLabel = document.pages[toPage]!.text.find((r) => r.copyText === 'To')!;
    const toValue = document.pages[toPage]!.text.find((r) => r.copyText.startsWith('Person 0 Example'))!;
    expect(toValue.y).toBe(toLabel.y);
    for (let p = toPage + 1; p < datePage; p++) expect(document.pages[p]!.text.some((r) => r.copyText.includes('@example.test'))).toBe(true);
    expectInsideTextArea(document);
  });

  it('keeps a header row that fits on one page in one piece, breaking the table between rows', () => {
    // Twelve medium rows of 30 lines each: the table is taller than a page.
    const people = Array.from({ length: 140 }, (_, k) => ({ name: `Person ${String(k)} Example`, address: `p${String(k)}@example.test` }));
    const doc = build([make({ to: people, cc: people.slice(0, 120), bcc: people.slice(0, 100), bodyText: 'Body here.' })]);
    const { document, frontPages } = lay(doc);
    const labels = ['From', 'To', 'Cc', 'Bcc', 'Date', 'Subject', 'File'];
    // Searched from the first email page: the index has columns named like some of them.
    const pages = labels.map((label) => pageOf(document, label, frontPages));
    for (const p of pages) expect(p).toBeGreaterThanOrEqual(frontPages);
    // Each value line sits on the page of its label or later, and rows are in order.
    expect([...pages].sort((a, b) => a - b)).toEqual(pages);
    expect(new Set(pages).size).toBeGreaterThan(1);
    expectInsideTextArea(document);
  });

  it('handles an email with no body text, notes, attachments and an empty cover-less document', () => {
    const doc = build([
      make({
        bodyText: '',
        attachments: [
          { fileName: 'plan.pdf', size: 12_345, mimeType: 'application/pdf' },
          { fileName: '', size: null, mimeType: '' },
        ],
      }),
    ]);
    const { document } = lay(doc);
    // In the index (page 1) and in the email (page 2).
    expect(pageOf(document, 'Attachments')).toBe(1);
    expect(pageOf(document, 'plan.pdf')).toBe(1);
    expect(pageOf(document, 'Attachments', 2)).toBe(2);
    expect(pageOf(document, 'plan.pdf', 2)).toBe(2);
    const empty: PdfDocument = { ...doc, cover: { ...doc.cover, blocks: [] }, index: { ...doc.index, entries: [] }, emails: [] };
    const laidEmpty = lay(empty);
    expect(laidEmpty.document.pages).toHaveLength(1);
    // Only the cover bookmark (no index without entries).
    expect(laidEmpty.document.outline.map((o) => o.destination)).toEqual(['cover']);
    // An index entry whose email is not there is a clear Error (its link and page would be wrong).
    expect(() => lay({ ...empty, index: doc.index })).toThrow(/^layout: the index entry email-1 has no email$/);
  });
});

/** A header row of `count` value lines ("R1 value line 3."). */
function tallRow(label: string, count: number): PdfFieldRow {
  return { label, value: Array.from({ length: count }, (_, j) => [{ role: 'field-value' as const, text: `${label} value line ${String(j + 1)}.` }]) };
}

/** The pages (0-based) holding a run whose copy text is `label` or starts with `label` + " ". */
function pagesOfRow(doc: LaidOutDocument, label: string): Set<number> {
  const pages = new Set<number>();
  for (const [i, page] of doc.pages.entries()) if (page.text.some((r) => r.copyText === label || r.copyText.startsWith(`${label} `))) pages.add(i);
  return pages;
}

describe('layoutPdf: keeping things together', () => {
  it('keeps every line of a header row that fits on a page on one page, in a table taller than a page', () => {
    // Five rows of 30 lines (about 386 pt each): the second one would cross the end of the first page.
    const labels = ['R1', 'R2', 'R3', 'R4', 'R5'];
    const email: PdfEmail = { ...syntheticEmail(1, ['Body.']), fields: labels.map((l) => tallRow(l, 30)) };
    const { document } = lay(syntheticDoc([email]));
    const all = new Set<number>();
    for (const label of labels) {
      const pages = pagesOfRow(document, label);
      expect([...pages]).toHaveLength(1);
      all.add([...pages][0]!);
    }
    expect(all.size).toBeGreaterThan(2);
    // The label column at the left margin, the value column after the label width and the gap.
    const page = document.pages[pageOf(document, 'R1')]!;
    expect(page.text.find((r) => r.copyText === 'R1')!.x).toBe(CONFIG.margin.left);
    for (const run of page.text.filter((r) => r.copyText.startsWith('R1 value line'))) {
      expect(run.x).toBeCloseTo(CONFIG.margin.left + CONFIG.fields.labelWidth + CONFIG.fields.gap, 6);
    }
    expectInsideTextArea(document);
  });

  it('starts an email whose keep block is taller than a page where its heading and first header row fit, together', () => {
    // First row 10 lines, second row 70 lines (taller than a page): only the heading and the first row are kept together.
    // Emails following each other (newPagePerEmail off): the only case where an email may start below another.
    let shared = 0;
    for (let n = 1; n <= 60; n++) {
      const before = syntheticEmail(1, Array.from({ length: n }, (_, i) => `Line ${String(i + 1)} of email 1.`));
      const email: PdfEmail = { ...syntheticEmail(2, ['Body.']), fields: [tallRow('A', 10), tallRow('B', 70)] };
      const { document, anchorPages } = lay(syntheticDoc([before, email]), false);
      const headingPage = pageOf(document, 'Email 2');
      expect(headingPage).toBe(anchorPages.get('email-2'));
      expect([...pagesOfRow(document, 'A')]).toEqual([headingPage]);
      // The tall row may start on the next page (it is broken between its lines anyway).
      expect(pageOf(document, 'B value line 1.') - headingPage).toBeOneOf([0, 1]);
      if (anchorPages.get('email-2') === anchorPages.get('email-1')) shared++;
    }
    // Not always on a new page: it follows the email before when the heading and the first row fit.
    expect(shared).toBeGreaterThan(10);
  });

  it('never leaves the attachments label alone at the bottom of a page', () => {
    // Body lengths over more than a page, so the label lands on every place of the page, the last line too.
    for (let n = 1; n <= 120; n++) {
      const email: PdfEmail = {
        ...syntheticEmail(1, Array.from({ length: n }, (_, i) => `Line ${String(i + 1)} of email 1.`)),
        attachments: { label: 'Attachments', items: [[{ role: 'body', text: 'plan.pdf' }]] },
      };
      const { document } = lay(syntheticDoc([email]));
      expect(pageOf(document, 'Attachments')).toBe(pageOf(document, 'plan.pdf'));
      expectInsideTextArea(document);
    }
  });

  it('keeps a cover section heading with the start of its section', () => {
    // Filler rows of about 14 pt, so the heading lands on every place of the page, the last line too.
    const base = build([make()]);
    const paragraph = (text: string): PdfBlock => ({ kind: 'paragraph', line: [{ role: 'body', text }] });
    for (let n = 1; n <= 60; n++) {
      const filler: PdfBlock = { kind: 'fields', rows: Array.from({ length: n }, (_, i) => ({ label: `K${String(i)}`, value: [[{ role: 'field-value', text: 'value' }]] })) };
      const blocks: PdfBlock[] = [filler, { kind: 'heading', level: 2, line: [{ role: 'heading', text: 'Section' }] }, paragraph('First of section.'), paragraph('Second of section.')];
      const { document } = lay({ ...base, cover: { ...base.cover, blocks }, index: { ...base.index, entries: [] }, emails: [] });
      expect(pageOf(document, 'Section')).toBe(pageOf(document, 'First of section.'));
      expect(pageOf(document, 'Section')).toBe(pageOf(document, 'Second of section.'));
    }
  });
});

describe('layoutPdf: config and footer checks', () => {
  const doc = (): PdfDocument => build([make()]);
  const withConfig = (config: LayoutConfig) => () => layoutPdf(doc(), fonts, { strings, config });
  const role = (patch: Partial<TextStyle>): LayoutConfig => ({ ...CONFIG, roles: { ...CONFIG.roles, body: { ...CONFIG.roles.body, ...patch } } });

  it.each<[string, LayoutConfig, RegExp]>([
    ['page width NaN', { ...CONFIG, page: { ...CONFIG.page, width: Number.NaN } }, /page\.width/],
    ['page height 0', { ...CONFIG, page: { ...CONFIG.page, height: 0 } }, /page\.height/],
    ['negative margin', { ...CONFIG, margin: { ...CONFIG.margin, left: -1 } }, /margin\.left/],
    ['infinite margin', { ...CONFIG, margin: { ...CONFIG.margin, top: Number.POSITIVE_INFINITY } }, /margin\.top/],
    ['margins wider than the page', { ...CONFIG, margin: { ...CONFIG.margin, left: 300, right: 300 } }, /no room for text/],
    ['margins taller than the page', { ...CONFIG, margin: { ...CONFIG.margin, top: 500, bottom: 400 } }, /no room for text/],
    ['font size 0', role({ size: 0 }), /roles\.body\.size/],
    ['line height negative', role({ lineHeight: -1 }), /roles\.body\.lineHeight/],
    ['footer size NaN', { ...CONFIG, footer: { ...CONFIG.footer, style: { ...CONFIG.footer.style, size: Number.NaN } } }, /footer\.style\.size/],
    ['footer baseline negative', { ...CONFIG, footer: { ...CONFIG.footer, baselineFromBottom: -5 } }, /footer\.baselineFromBottom/],
    ['footer baseline at the page top', { ...CONFIG, footer: { ...CONFIG.footer, baselineFromBottom: CONFIG.page.height } }, /footer\.baselineFromBottom must be inside the page/],
    ['label width 0', { ...CONFIG, fields: { ...CONFIG.fields, labelWidth: 0 } }, /fields\.labelWidth/],
    ['label width as wide as the text area', { ...CONFIG, fields: { ...CONFIG.fields, labelWidth: 500 } }, /less than the text area width/],
    ['negative row gap', { ...CONFIG, fields: { ...CONFIG.fields, rowGap: -1 } }, /fields\.rowGap/],
    ['list indent 0', { ...CONFIG, list: { ...CONFIG.list, indent: 0 } }, /list\.indent/],
    ['list indent wider than the text area', { ...CONFIG, list: { ...CONFIG.list, indent: 500 } }, /list\.indent must be less than the text area width/],
    ['negative spacing', { ...CONFIG, spacing: { ...CONFIG.spacing, betweenEmails: -2 } }, /spacing\.betweenEmails/],
    ['index page column 0', { ...CONFIG, index: { ...CONFIG.index, pageWidth: 0 } }, /index\.pageWidth/],
    ['index date column NaN', { ...CONFIG, index: { ...CONFIG.index, dateWidth: Number.NaN } }, /index\.dateWidth/],
    ['negative index row gap', { ...CONFIG, index: { ...CONFIG.index, rowGap: -1 } }, /index\.rowGap/],
    ['index columns leaving no subject column', { ...CONFIG, index: { ...CONFIG.index, fromWidth: 300 } }, /room for the subject column/],
    ['list indent wider than the index attachment lines', { ...CONFIG, list: { ...CONFIG.list, indent: 420 } }, /index attachment lines/],
    ['keepBodyLines not whole', { ...CONFIG, keepBodyLines: 1.5 }, /keepBodyLines/],
    ['index page column too narrow for 6 digits', { ...CONFIG, index: { ...CONFIG.index, pageWidth: 35 } }, /index\.pageWidth must hold a 6-digit page number/],
    ['index page column too narrow for a bigger body size', role({ size: 11 }), /index\.pageWidth must hold/],
    ['index date column too narrow for a short date', { ...CONFIG, index: { ...CONFIG.index, dateWidth: 60 } }, /index\.dateWidth must hold a date/],
  ])('rejects an invalid config with a clear Error (%s)', (_label, config, message) => {
    expect(withConfig(config)).toThrow(/^layout: invalid config: /);
    expect(withConfig(config)).toThrow(message);
  });

  it('accepts the default config, and zero margins and spacings', () => {
    expect(withConfig(CONFIG)).not.toThrow();
    const zero: LayoutConfig = {
      ...CONFIG,
      margin: { top: 0, right: 0, bottom: 0, left: 0 },
      spacing: Object.fromEntries(Object.keys(CONFIG.spacing).map((k) => [k, 0])) as unknown as LayoutConfig['spacing'],
    };
    expect(withConfig(zero)).not.toThrow();
  });

  it('fits the longest page footer on one line; a footer wider than the text area is an Error, never cut', () => {
    const ts = new Typesetter(fonts, CONFIG);
    const width = CONFIG.page.width - CONFIG.margin.left - CONFIG.margin.right;
    expect(ts.wrap([{ role: 'muted', text: strings.pageFooter(99_999, 99_999) }], width, 'muted', ts.footerStyle)).toHaveLength(1);
    const tooWide = { ...strings, pageFooter: () => 'Page '.repeat(200) };
    expect(() => layoutPdf(doc(), fonts, { strings: tooWide })).toThrow(/^layout: the page footer is wider than the text area$/);
  });

  it('measures what the index column checks assume: the widest digit, the widest short date', () => {
    const ts = new Typesetter(fonts, CONFIG);
    const size = CONFIG.roles.body.size;
    const width = (text: string): number => ts.wrap([{ role: 'body', text }], 1e6, 'body')[0]!.width;
    for (let d = 0; d <= 9; d++) {
      const digit = String(d);
      expect(width(digit)).toBeLessThanOrEqual(MAX_DIGIT_EM * size + 1e-9);
      // Six of them on one line in the page column (the default config holds exactly that).
      expect(width(digit.repeat(INDEX_PAGE_DIGITS))).toBeLessThanOrEqual(CONFIG.index.pageWidth + 1e-9);
      const date = `${digit.repeat(4)}-${digit.repeat(2)}-${digit.repeat(2)} ${digit.repeat(2)}:${digit.repeat(2)}`;
      expect(width(date)).toBeLessThanOrEqual(SHORT_DATE_EM * size + 1e-9);
      expect(ts.wrap([{ role: 'body', text: date }], CONFIG.index.dateWidth, 'body')).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------- end to end

async function pageTexts(pdf: ParsedPdf): Promise<string[]> {
  const out: string[] = [];
  for (const pageDict of pdf.pages()) {
    const fontDict = pdf.dict(pdf.dict(pageDict.get('Resources')).get('Font'));
    const maps = new Map<string, Map<number, string>>();
    for (const key of fontDict.keys()) {
      const type0 = pdf.dict(fontDict.get(key));
      maps.set(key, parseToUnicode(await pdf.dataText(type0.get('ToUnicode'))));
    }
    const { runs } = readContent(await pdf.dataText(pageDict.get('Contents')));
    out.push(runs.map((r) => r.actualText ?? r.glyphs.map((g) => maps.get(r.font)!.get(g) ?? '').join('')).join(''));
  }
  return out;
}

describe('layoutPdf + OwnPdfWriter', () => {
  it('gives a valid PDF whose copy text holds the original body texts', async () => {
    const special = [
      'Caf\u{E9} cr\u{E8}me, na\u{EF}ve fa\u{E7}ade, \u{201C}quoted\u{201D} \u{2013} \u{20AC}12 \u{2026}',
      'Composed: Cafe\u{301} and q\u{301} stay as written.',
      'Emoji: \u{1F600} and \u{1F469}\u{200D}\u{1F4BB} copy back as emoji.',
      'Soft\u{AD}hyphen not copied when not at a break.',
      '    Indented by four spaces.',
      'A long line that has to wrap: ' + 'alpha beta gamma delta epsilon '.repeat(12).trim(),
    ];
    const messages = [make({ bodyText: special.join('\n') }), ...Array.from({ length: 11 }, (_, k) => make({ bodyText: lines(k + 2, 30) }))];
    const doc = build(messages);
    const { document } = lay(doc);
    // Already in the layout's own copy texts, before the backend's copy layer.
    for (const page of document.pages) for (const run of page.text) expect(run.copyText).not.toContain('\u{AD}');
    const bytes = await new OwnPdfWriter().render(document, fonts);
    const pdf = readPdf(bytes);
    expect(pdf.pages()).toHaveLength(document.pages.length);
    expect(document.pages.length).toBeGreaterThan(2);
    const all = (await pageTexts(pdf)).join('\n');
    // What you copy is what you see: a soft hyphen not at a line break is not drawn, so not copied.
    for (const line of special) expect(all).toContain(line.trimStart().replaceAll('\u{AD}', ''));
    expect(all).toContain('Softhyphen not copied');
    expect(all).not.toContain('\u{AD}');
    expect(all).toContain('    Indented');
    for (let n = 2; n <= 12; n++) expect(all).toContain(`Line 30 of email ${String(n)}.`);
    expect(all).toContain(`Page 1 of ${String(document.pages.length)}`);
    // The destinations, as the reader sees them.
    const dests = readDests(pdf);
    expect([...dests.keys()].sort()).toEqual(['cover', 'index', ...doc.emails.map((e) => e.anchor)].sort());
    for (const d of document.destinations) expect(dests.get(d.name)!.page).toBe(d.page);
    // Info: title and producer only.
    expect(pdf.info.keys().sort()).toEqual(['Producer', 'Title']);
    expect((pdf.info.get('Producer') as PdfString).text).toBe('Email to PDF');
    expect((pdf.info.get('Title') as PdfString).text).toBe('Email correspondence');
  });
});

// ---------------------------------------------------------------- time bounds

function syntheticEmail(n: number, body: readonly string[]): PdfEmail {
  const value = (text: string) => [[{ role: 'field-value' as const, text }]];
  return {
    number: n,
    anchor: emailAnchor(n),
    position: n - 1,
    heading: `Email ${String(n)}`,
    rebuilt: null,
    fields: [
      { label: 'From', value: value('Alice Example <alice@example.test>') },
      { label: 'To', value: value('Bob Sample <bob@furniture.example.test>') },
      { label: 'Date', value: value('2025-03-04 08:00:00 UTC') },
      { label: 'Subject', value: value(`Desks ${String(n)}`) },
    ],
    notes: [],
    body: body.map((text) => (text === '' ? [] : [{ role: 'body' as const, text }])),
    attachments: null,
    flags: { undated: false, zoneUnknown: false, keptAllBecauseEmpty: false, planFallback: false, htmlConverted: false, controlChars: 0 },
  };
}

function syntheticDoc(emails: readonly PdfEmail[]): PdfDocument {
  const doc = build([make()]);
  return { ...doc, emails, pdfNumberByPosition: emails.map((e) => e.number) };
}

describe('layoutPdf: time bounds', () => {
  it('lays out a 1 MB line with spaces, and one without, in bounded time', () => {
    const words = 'the desks arrive on monday morning '.repeat(30_000).slice(0, 1_000_000);
    const solid = 'abcdefghij'.repeat(100_000);
    for (const text of [words, solid]) {
      const start = performance.now();
      const { document } = lay(syntheticDoc([syntheticEmail(1, [text])]));
      const ms = performance.now() - start;
      console.log(`1 MB line (${text === words ? 'words' : 'no spaces'}): ${ms.toFixed(0)} ms, ${String(document.pages.length)} pages`);
      expect(ms).toBeLessThan(5_000); // about 0.2 s on a developer machine
      const copied = document.pages.flatMap((p) => p.text.filter((r) => !isFooter(r) && r.font === 'sans-regular').map((r) => r.copyText));
      expect(copied.join('').endsWith(text.slice(-50))).toBe(true);
    }
  });

  it('lays out 2000 emails of 200 lines each in bounded time', () => {
    const body = Array.from({ length: 200 }, (_, i) => (i % 10 === 9 ? '' : `Line ${String(i)}: the desks arrive on Monday, says Alice Example.`));
    const emails = Array.from({ length: 2000 }, (_, k) => syntheticEmail(k + 1, body));
    const start = performance.now();
    const { document, anchorPages } = lay(syntheticDoc(emails));
    const ms = performance.now() - start;
    console.log(`2000 emails x 200 lines: ${ms.toFixed(0)} ms, ${String(document.pages.length)} pages`);
    expect(ms).toBeLessThan(20_000); // about 2 s on a developer machine
    expect(anchorPages.size).toBe(2000);
    expect(document.pages.length).toBeGreaterThan(2000 * 3);
  }, 120_000);
});
