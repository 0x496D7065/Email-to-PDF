// Text for the PDF: the display-only transforms every PDF text goes through
// (README.md, rule R6: the stored message is never changed; these functions
// return new strings and never touch their input).
//
// The transforms, in this order:
// (a) line ends: CRLF, lone CR, U+2028 (line separator) and U+2029
//     (paragraph separator) become LF (bodyText is LF-only already,
//     src/parsing/line-endings.ts, but may still hold U+2028/U+2029; other
//     texts may hold anything). In a one-line field each of them becomes one
//     space instead (inlineRuns);
// (b) tabs: each tab becomes TAB_WIDTH (4) spaces. A fixed width, not tab
//     stops: the PDF uses a proportional font, where "column 8" means
//     nothing, and a fixed width is simple to explain and to test;
// (c) characters that must not be written as they are become a visible
//     code such as "[U+0000]", in a run of role 'code' (see "The contract
//     with the renderer" below). They are counted, so the cover can say how
//     many were replaced;
// (d) combining marks are left exactly as they are ("e" + U+0301 stays two
//     code points): the renderer shapes them;
// (e) email bodies only: leading and trailing blank lines are removed, and
//     a run of 3 or more blank lines becomes 2 (Outlook's double spacing).
//     A blank line is one with only white space as JavaScript's `\s` (and
//     String.prototype.trim) defines it: spaces, tabs, U+00A0, U+FEFF and
//     the other Unicode spaces. It is shown as an empty line (its spaces are
//     invisible anyway). A line with a code is never blank. A line holding
//     only characters of group 2 below (e.g. only U+200B) is NOT blank
//     either: it is kept as it is, so nothing but white space is ever
//     dropped (it looks empty in the PDF);
// (f) characters the font lacks (emoji, rare scripts) are NOT handled here:
//     that is the renderer's job. Text is split into runs only by meaning
//     (normal / muted / code / mono), never by font coverage.
//
// The contract with the renderer (src/pdf/ writer, milestone 5.4). Three
// groups of special characters:
// 1. Written as a visible code (transform c), so the reader knows something
//    is there and the PDF never holds a character that could hide, reorder
//    or garble text: the C0 controls except LF (U+0000 to U+001F; tabs are
//    expanded first; CR and LF never reach a run, lines are split first),
//    DEL (U+007F), the C1 controls (U+0080 to U+009F, so U+0085 NEL too),
//    the bidi embedding / override / isolate controls (U+202A to U+202E,
//    U+2066 to U+2069), the interlinear annotation characters (U+FFF9 to
//    U+FFFB), the tag characters (U+E0000 to U+E007F) EXCEPT inside one of
//    the three standard (RGI) subdivision flags, matched exactly and kept
//    whole: England (U+1F3F4, the tags "gbeng", U+E007F), Scotland
//    ("gbsct") and Wales ("gbwls"), see KEPT_FLAG_TAGS. Any other tag run
//    (longer, upper case, spaces, another subdivision, no U+E007F at the
//    end, with or without U+1F3F4 before it) is coded in full, so tags can
//    never hide text in the PDF; the noncharacters (U+FDD0 to
//    U+FDEF, and U+nFFFE / U+nFFFF in every plane, U+FFFE to U+10FFFF), and
//    lone surrogates (half of a broken emoji or other character outside the
//    BMP, e.g. "[U+D83D]"). One code per code point ("[U+E0041]",
//    "[U+1FFFE]"), one per code unit for a lone surrogate.
// 2. Kept unchanged in the model; the renderer draws them as NOTHING (no
//    glyph, no code, no width), see DRAWN_AS_NOTHING and isDrawnAsNothing:
//    ZWSP U+200B (also a place where a line may break), ZWNJ U+200C, ZWJ
//    U+200D (emoji sequences such as "woman + ZWJ + laptop" are left
//    untouched for the shaper), LRM / RLM / ALM U+200E, U+200F, U+061C
//    (very common in Hebrew and Arabic mail; our writer does no bidi
//    reordering, so they have no effect and are simply not drawn), CGJ
//    U+034F, U+2060 to U+2064, variation selectors U+FE00 to U+FE0F and
//    U+E0100 to U+E01EF (VS16 after an emoji stays), BOM / ZWNBSP U+FEFF
//    inside text, and the tag characters U+E0020 to U+E007F, which only
//    ever reach the renderer inside one of the three kept flags (England,
//    Scotland, Wales: at most 6 tags, never free text; if the font cannot
//    draw the flag, the black flag U+1F3F4 is drawn and the tags are not).
// 3. Soft hyphen U+00AD (SOFT_HYPHEN): kept; the renderer draws a hyphen
//    only where it breaks the line there, nothing otherwise.
//
// Pure functions, no DOM (README.md, rule R7). Email text stays plain data:
// it is never read as markup or code (README.md, rule R4).

/** Spaces per tab (transform b). */
export const TAB_WIDTH = 4;

/**
 * The semantic role of a piece of text. No sizes, no fonts: the renderer
 * decides how each role looks.
 * - 'title': the document title; 'heading': a section or email heading;
 * - 'field-label' / 'field-value': a header row ("From" / "Alice <a@x.test>");
 * - 'body': email text; 'muted': secondary text (notes, "(no subject)");
 * - 'code': the visible code of a replaced character ("[U+0007]", transform
 *   c): the renderer shows it greyed and may give it the original character
 *   as ActualText; text that merely looks like a code stays in its own role;
 * - 'mono': fixed-width text (SHA-256 hashes).
 */
export type PdfRole = 'title' | 'heading' | 'field-label' | 'field-value' | 'body' | 'muted' | 'code' | 'mono';

/** A run of text with one role. `text` never contains a line break and is never empty. */
export interface PdfRun {
  readonly role: PdfRole;
  readonly text: string;
}

/** One line: its runs in order. [] is an empty line. The renderer wraps a long line. */
export type PdfLine = readonly PdfRun[];

/** Group 3 of the contract: drawn as a hyphen only at a line break. */
export const SOFT_HYPHEN = 0x00ad;

/** Group 2 of the contract: a place where a line may break, drawn as nothing. */
export const ZERO_WIDTH_SPACE = 0x200b;

/**
 * Group 2 of the contract: code points (inclusive ranges, sorted) kept in the
 * model that the renderer draws as nothing. Shared with the renderer so both
 * use one list.
 */
export const DRAWN_AS_NOTHING: readonly (readonly [number, number])[] = [
  [0x034f, 0x034f], // combining grapheme joiner
  [0x061c, 0x061c], // Arabic letter mark
  [0x200b, 0x200f], // ZWSP, ZWNJ, ZWJ, LRM, RLM
  [0x2060, 0x2064], // word joiner, invisible operators
  [0xfe00, 0xfe0f], // variation selectors
  [0xfeff, 0xfeff], // BOM / zero-width no-break space
  [0xe0020, 0xe007f], // tag characters (only ever inside one of the three KEPT_FLAG_TAGS flags)
  [0xe0100, 0xe01ef], // variation selectors supplement
];

/**
 * The tags (as ASCII letters; each letter L is the tag character U+E0000 +
 * L) of the only flags kept whole: U+1F3F4, these tags, then U+E007F.
 * England, Scotland, Wales: the three standard (RGI) subdivision flags.
 * Every other tag character is coded (group 1).
 */
export const KEPT_FLAG_TAGS: readonly string[] = ['gbeng', 'gbsct', 'gbwls'];

/** True for a code point of group 2 (DRAWN_AS_NOTHING). */
export function isDrawnAsNothing(codePoint: number): boolean {
  return DRAWN_AS_NOTHING.some(([from, to]) => codePoint >= from && codePoint <= to);
}

/**
 * The characters of group 1 (transform c), plus the three kept flags (group
 * FLAG, see KEPT_FLAG_TAGS) so they are skipped whole. Built without the `u`
 * flag on purpose: with it, a lone surrogate could not be matched on its
 * own, so characters outside the BMP are written as surrogate pairs:
 * - U+1F3F4 is the pair D83C DFF4; tag characters U+E0000 to U+E007F are
 *   DB40 then DC00 to DC7F (tag "g" U+E0067: DC67, "b": DC62, "e": DC65,
 *   "n": DC6E, "s": DC73, "c": DC63, "t": DC74, "w": DC77, "l": DC6C;
 *   U+E007F: DC7F);
 * - U+nFFFE / U+nFFFF of planes 1 to 16: high surrogate D83F, D87F, ...
 *   DBFF (every 0x40), then DFFE or DFFF.
 * (The patterns are written with doubled backslashes inside strings, so the
 * file itself holds no invisible character.)
 * Tabs are expanded before this runs; LF, CR, U+2028 and U+2029 are listed
 * so that a run never holds a line break (callers split lines first, see
 * bodyLines and inlineRuns). Order matters: the flag first, so its tags are
 * never coded; a pair is never split (the lone-surrogate parts look around).
 */
const SPECIAL = new RegExp(
  [
    // U+1F3F4, the tags "gb", then "eng" / "sct" / "wls", then U+E007F.
    '(?<flag>\\uD83C\\uDFF4\\uDB40\\uDC67\\uDB40\\uDC62\\uDB40(?:\\uDC65\\uDB40\\uDC6E\\uDB40\\uDC67|\\uDC73\\uDB40\\uDC63\\uDB40\\uDC74|\\uDC77\\uDB40\\uDC6C\\uDB40\\uDC73)\\uDB40\\uDC7F)',
    '\\uDB40[\\uDC00-\\uDC7F]',
    '[\\uD83F\\uD87F\\uD8BF\\uD8FF\\uD93F\\uD97F\\uD9BF\\uD9FF\\uDA3F\\uDA7F\\uDABF\\uDAFF\\uDB3F\\uDB7F\\uDBBF\\uDBFF][\\uDFFE\\uDFFF]',
    '[\\u0000-\\u0008\\u000A-\\u001F\\u007F-\\u009F\\u2028\\u2029\\u202A-\\u202E\\u2066-\\u2069\\uFDD0-\\uFDEF\\uFFF9-\\uFFFB\\uFFFE\\uFFFF]',
    '[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])',
    '(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]',
  ].join('|'),
  'g',
);

/** "[U+0000]", "[U+E0041]": the visible code of one replaced code point (at least 4 hex digits, upper case). */
export function controlMarker(codePoint: number): string {
  return `[U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}]`;
}

/** True for a code unit that ends a line in transform (a): LF, CR, U+2028, U+2029. */
export function isLineBreak(codeUnit: number): boolean {
  return codeUnit === 0x0a || codeUnit === 0x0d || codeUnit === 0x2028 || codeUnit === 0x2029;
}

/** Transform (a): CRLF, lone CR, U+2028 and U+2029 as LF. */
export function normalizeLineEnds(text: string): string {
  return text.replace(/\r\n?|[\u{2028}\u{2029}]/gu, '\n');
}

/** Transform (b): every tab as TAB_WIDTH spaces. */
export function expandTabs(text: string): string {
  return text.replaceAll('\t', ' '.repeat(TAB_WIDTH));
}

/** Runs and how many characters were replaced by a code. */
export interface SanitizedRuns {
  readonly runs: PdfRun[];
  readonly replaced: number;
}

/**
 * Transforms (b) and (c) on one line: tabs expanded, then each character of
 * group 1 (line breaks included: split lines first) as a 'code' run; the
 * rest in runs of `role`. Codes next to each other share one run. Empty
 * text gives no run.
 */
export function sanitizeRuns(text: string, role: PdfRole): SanitizedRuns {
  const expanded = expandTabs(text);
  const runs: PdfRun[] = [];
  let replaced = 0;
  let from = 0;
  SPECIAL.lastIndex = 0;
  for (let m = SPECIAL.exec(expanded); m !== null; m = SPECIAL.exec(expanded)) {
    if (m.groups?.['flag'] !== undefined) continue; // a valid flag: kept as text
    if (m.index > from) runs.push({ role, text: expanded.slice(from, m.index) });
    const marker = controlMarker(m[0].codePointAt(0)!);
    const last = runs[runs.length - 1];
    // Join a code to the codes just before it. `m.index === from` only matters when the caller's own `role` is
    // 'code': then the text pushed just above is also a 'code' run, and it must stay apart from the markers.
    if (last !== undefined && last.role === 'code' && m.index === from) runs[runs.length - 1] = { role: 'code', text: last.text + marker };
    else runs.push({ role: 'code', text: marker });
    replaced++;
    from = m.index + m[0].length;
  }
  if (from < expanded.length) runs.push({ role, text: expanded.slice(from) });
  return { runs, replaced };
}

/**
 * A one-line field (subject, name, file name): each line break (CRLF, CR,
 * LF, U+2028, U+2029) as one space, then transforms (b) and (c).
 */
export function inlineRuns(text: string, role: PdfRole): SanitizedRuns {
  return sanitizeRuns(text.replace(/\r\n|[\r\n\u{2028}\u{2029}]/gu, ' '), role);
}

/** The plain text of a line (its runs joined). */
export function lineText(line: PdfLine): string {
  return line.map((r) => r.text).join('');
}

/** Body lines and how many characters were replaced by a code. */
export interface BodyLines {
  readonly lines: PdfLine[];
  readonly replaced: number;
}

/** Most blank lines kept in a row (transform e). */
export const MAX_BLANK_LINES = 2;

/**
 * An email's text as lines of 'body' runs: transforms (a), (b), (c) and
 * (e). A line with a code is never blank (the code is shown).
 */
export function bodyLines(text: string): BodyLines {
  const lines: PdfLine[] = [];
  let replaced = 0;
  let blanks = 0; // blank lines waiting (written only when a non-blank line follows: trailing ones are dropped)
  for (const raw of normalizeLineEnds(text).split('\n')) {
    const s = sanitizeRuns(raw, 'body');
    replaced += s.replaced;
    if (s.replaced === 0 && /^\s*$/u.test(raw)) {
      if (lines.length > 0) blanks++; // leading blank lines are dropped
      continue;
    }
    for (let k = Math.min(blanks, MAX_BLANK_LINES); k > 0; k--) lines.push([]);
    blanks = 0;
    lines.push(s.runs);
  }
  return { lines, replaced };
}

/** A plan range, as far as joining needs it. */
export interface KeptRange {
  readonly start: number;
  readonly end: number;
  readonly keep: boolean;
}

/**
 * The kept ranges of `body`, joined in order. Nothing is ever inserted for
 * the parts left out, except one LF where two kept parts that were not next
 * to each other would otherwise run together on one line (the first does
 * not end with a line break and the second does not start with one; line
 * breaks as in transform a). `ranges` must be sorted, inside the body and
 * not overlapping (the caller checks it). Linear in the number of ranges.
 */
export function joinKept(body: string, ranges: readonly KeptRange[]): string {
  const parts: string[] = [];
  let lastEnd = -1;
  let endsLine = false; // the last kept piece ends with a line break
  for (const r of ranges) {
    if (!r.keep || r.end <= r.start) continue;
    const piece = body.slice(r.start, r.end);
    if (parts.length > 0 && r.start !== lastEnd && !endsLine && !isLineBreak(piece.charCodeAt(0))) parts.push('\n');
    parts.push(piece);
    endsLine = isLineBreak(piece.charCodeAt(piece.length - 1));
    lastEnd = r.end;
  }
  return parts.join('');
}
