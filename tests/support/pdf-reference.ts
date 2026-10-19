// A second, independent implementation of the PDF display transforms
// (src/pdf/text.ts), for the tests only: the "include everything" checks
// (README.md, rule R6) compare the model's body text with it. Written
// differently on purpose (a loop over code points, no regular expression for
// the special characters), so a mistake in one is not repeated in the other.
// Test-only: never imported by the app.

/** Spaces per tab, as documented in src/pdf/text.ts. */
const TAB = '    ';

function isHigh(c: number): boolean {
  return c >= 0xd800 && c <= 0xdbff;
}

function isLow(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff;
}

/** Group 1 of the contract in src/pdf/text.ts, for one whole code point (tags handled by the caller). */
function isCoded(cp: number): boolean {
  if (cp < 0x20) return true; // tab and line breaks never get here
  if (cp >= 0x7f && cp <= 0x9f) return true;
  if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) return true;
  if (cp >= 0xfff9 && cp <= 0xfffb) return true;
  if (cp >= 0xfdd0 && cp <= 0xfdef) return true;
  if ((cp & 0xfffe) === 0xfffe) return true; // U+nFFFE and U+nFFFF in every plane
  return false;
}

const isTag = (cp: number): boolean => cp >= 0xe0000 && cp <= 0xe007f;

/** The tags of the only flags kept whole, written out here again (not imported). */
const KEPT = ['gbeng', 'gbsct', 'gbwls'];

const code = (cp: number): string => `[U+${cp.toString(16).toUpperCase().padStart(4, '0')}]`;

/** One line: tabs as 4 spaces, the characters of group 1 as "[U+XXXX]". */
function displayLine(line: string): { text: string; codes: number } {
  // Code points, lone surrogates as themselves.
  const cps: number[] = [];
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (isHigh(c) && i + 1 < line.length && isLow(line.charCodeAt(i + 1))) {
      cps.push(0x10000 + ((c - 0xd800) << 10) + (line.charCodeAt(i + 1) - 0xdc00));
      i++;
    } else {
      cps.push(c);
    }
  }
  let text = '';
  let codes = 0;
  for (let k = 0; k < cps.length; k++) {
    const cp = cps[k]!;
    if (cp === 0x1f3f4) {
      // Only the England, Scotland and Wales flags are kept: U+1F3F4, the
      // tags "gbeng" / "gbsct" / "gbwls" (exactly 5), then U+E007F.
      const spelled = cps
        .slice(k + 1, k + 6)
        .map((t) => String.fromCharCode(t - 0xe0000))
        .join('');
      if (KEPT.includes(spelled) && cps.slice(k + 1, k + 6).every(isTag) && cps[k + 6] === 0xe007f) {
        text += String.fromCodePoint(...cps.slice(k, k + 7));
        k += 6;
        continue;
      }
    }
    if (cp === 9) {
      text += TAB;
    } else if (isHigh(cp) || isLow(cp) || isTag(cp) || isCoded(cp)) {
      text += code(cp);
      codes++;
    } else {
      text += String.fromCodePoint(cp);
    }
  }
  return { text, codes };
}

/**
 * The whole body as the PDF shows it with nothing left out: lines (CRLF, CR,
 * LF, U+2028 and U+2029 all end a line), each transformed, blank lines
 * (white space only, no code) at both ends dropped, at most 2 blank lines in
 * a row, blank lines written empty. Lines joined with LF.
 */
export function referenceDisplayText(body: string): string {
  const lines = body.split(/\r\n|\r|\n|\u{2028}|\u{2029}/u).map(displayLine);
  const blank = (l: { text: string; codes: number }): boolean => l.codes === 0 && l.text.trim() === '';
  let from = 0;
  let to = lines.length;
  while (from < to && blank(lines[from]!)) from++;
  while (to > from && blank(lines[to - 1]!)) to--;
  const out: string[] = [];
  let run = 0;
  for (const l of lines.slice(from, to)) {
    if (blank(l)) {
      run++;
      if (run <= 2) out.push('');
    } else {
      run = 0;
      out.push(l.text);
    }
  }
  return out.join('\n');
}
