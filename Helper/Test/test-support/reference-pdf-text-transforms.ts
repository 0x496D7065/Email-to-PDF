// A second, independent implementation of the PDF display transforms
// (Source/pdf-export/pdf-text-transforms.ts), for the tests only: the "include everything" checks
// (README.md, rule R6) compare the model's body text with it. Written
// differently on purpose (a loop over code points, no regular expression for
// the special characters), so a mistake in one is not repeated in the other.
// Test-only: never imported by the app.

/** Spaces per tab, as documented in Source/pdf-export/pdf-text-transforms.ts. */
const TAB_SPACES = '    ';

function isHigh(codeUnit: number): boolean
{
    return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLow(codeUnit: number): boolean
{
    return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/** Group 1 of the contract in Source/pdf-export/pdf-text-transforms.ts, for one whole code point (tags handled by the caller). */
function isCoded(codePoint: number): boolean
{
    if (codePoint < 0x20)
    {
        return true; // tab and line breaks never get here
    }
    if (codePoint >= 0x7f && codePoint <= 0x9f)
    {
        return true;
    }
    if ((codePoint >= 0x202a && codePoint <= 0x202e) || (codePoint >= 0x2066 && codePoint <= 0x2069))
    {
        return true;
    }
    if (codePoint >= 0xfff9 && codePoint <= 0xfffb)
    {
        return true;
    }
    if (codePoint >= 0xfdd0 && codePoint <= 0xfdef)
    {
        return true;
    }
    if ((codePoint & 0xfffe) === 0xfffe)
    {
        return true; // U+nFFFE and U+nFFFF in every plane
    }
    return false;
}

const isTag = (cp: number): boolean => cp >= 0xe0000 && cp <= 0xe007f;

/** The tags of the only flags kept whole, written out here again (not imported). */
const KEPT_FLAG_TAGS = ['gbeng', 'gbsct', 'gbwls'];

const codeLabel = (cp: number): string => `[U+${cp.toString(16).toUpperCase().padStart(4, '0')}]`;

/** One line: tabs as 4 spaces, the characters of group 1 as "[U+XXXX]". */
function displayLine(line: string): { text: string; codes: number }
{
    // Code points, lone surrogates as themselves.
    const codePoints: number[] = [];
    for (let i = 0; i < line.length; i++)
    {
        const codeUnit = line.charCodeAt(i);
        if (isHigh(codeUnit) && i + 1 < line.length && isLow(line.charCodeAt(i + 1)))
        {
            codePoints.push(0x10000 + ((codeUnit - 0xd800) << 10) + (line.charCodeAt(i + 1) - 0xdc00));
            i++;
        }
        else
        {
            codePoints.push(codeUnit);
        }
    }
    let text = '';
    let codes = 0;
    for (let k = 0; k < codePoints.length; k++)
    {
        const codePoint = codePoints[k]!;
        if (codePoint === 0x1f3f4)
        {
            // Only the England, Scotland and Wales flags are kept: U+1F3F4, the
            // tags "gbeng" / "gbsct" / "gbwls" (exactly 5), then U+E007F.
            const spelled = codePoints
                .slice(k + 1, k + 6)
                .map((t) => String.fromCharCode(t - 0xe0000))
                .join('');
            if (KEPT_FLAG_TAGS.includes(spelled) && codePoints.slice(k + 1, k + 6).every(isTag) && codePoints[k + 6] === 0xe007f)
            {
                text += String.fromCodePoint(...codePoints.slice(k, k + 7));
                k += 6;
                continue;
            }
        }
        if (codePoint === 9)
        {
            text += TAB_SPACES;
        }
        else if (isHigh(codePoint) || isLow(codePoint) || isTag(codePoint) || isCoded(codePoint))
        {
            text += codeLabel(codePoint);
            codes++;
        }
        else
        {
            text += String.fromCodePoint(codePoint);
        }
    }
    return { text, codes };
}

/**
 * May this code point come before or between the ">" of a quote prefix,
 * as Source/pdf-export/pdf-text-transforms.ts (transform g) documents it? Whitespace (\s) except VT
 * and FF (the PDF stops the prefix there so they stay visible as codes),
 * and the invisible characters drawn as nothing: soft hyphen, CGJ, ALM,
 * ZWSP to RLM (U+200B to U+200F), U+2060 to U+2064, the variation
 * selectors U+FE00 to U+FE0F and the variation selectors supplement
 * U+E0100 to U+E01EF (written out here again, not imported). Not the tag
 * characters (codes), not the blank-looking characters the PDF fonts print
 * as codes (Hangul fillers U+115F, U+1160, U+3164, U+FFA0, braille blank
 * U+2800, U+180E), not a lone surrogate.
 */
function inPrefix(codePoint: number): boolean
{
    if (codePoint === 0x0b || codePoint === 0x0c)
    {
        return false;
    }
    if (codePoint === 0xad || codePoint === 0x34f || codePoint === 0x61c || (codePoint >= 0x200b && codePoint <= 0x200f)
        || (codePoint >= 0x2060 && codePoint <= 0x2064) || (codePoint >= 0xfe00 && codePoint <= 0xfe0f))
    {
        return true;
    }
    if (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
    {
        return true;
    }
    return codePoint <= 0xffff && /\s/u.test(String.fromCharCode(codePoint));
}

/**
 * Quote marks at the start of a line, read here differently from
 * Source/pdf-export/pdf-text-transforms.ts: first the longest start made only of ">" and inPrefix
 * characters (by code point), then back to its last ">"; then one plain or
 * no-break space when there is one. Gives whether there was a prefix and
 * the rest of the line (the line itself when there is none).
 */
function splitQuote(line: string): { quoted: boolean; rest: string }
{
    let prefixEnd = 0; // line[0, prefixEnd) holds only ">" and inPrefix characters
    for (const char of line)
    {
        if (char !== '>' && !inPrefix(char.codePointAt(0)!))
        {
            break;
        }
        prefixEnd += char.length;
    }
    const end = prefixEnd === 0 ? 0 : line.lastIndexOf('>', prefixEnd - 1) + 1;
    if (end === 0)
    {
        return { quoted: false, rest: line };
    }
    const rest = line.slice(end);
    return { quoted: true, rest: rest.startsWith(' ') || rest.startsWith('\u{00A0}') ? rest.slice(1) : rest };
}

/**
 * The whole body as the PDF shows it with nothing left out, line by line:
 * lines (CRLF, CR, LF, U+2028 and U+2029 all end a line); with `quotes`
 * (the default, as the PDF does since tasks 8.1 and 8.6), the quote marks
 * at the start of every line are removed; each line transformed; blank
 * lines (white space only, no code, no quote mark) at both ends dropped, at
 * most 2 blank lines in a row, blank lines written empty. A quoted line
 * with nothing but white space after its marks is written empty and never
 * dropped. `quotes: false` gives the text as it was before task 8.1 (every
 * quote mark kept), for the "only the prefixes were removed" checks.
 */
export function referenceDisplayLines(body: string, options: { quotes?: boolean } = {}): string[]
{
    const quotes = options.quotes ?? true;
    // Pieces at odd indexes are the line breaks.
    const pieces = body.split(/(\r\n|\r|\n|\u{2028}|\u{2029})/u);
    const lines: { text: string; codes: number; quoted: boolean }[] = [];
    for (let k = 0; k < pieces.length; k += 2)
    {
        const split = quotes ? splitQuote(pieces[k]!) : { quoted: false, rest: pieces[k]! };
        lines.push({ ...displayLine(split.rest), quoted: split.quoted });
    }
    const blank = (l: { text: string; codes: number; quoted: boolean }): boolean => !l.quoted && l.codes === 0 && l.text.trim() === '';
    let from = 0;
    let to = lines.length;
    while (from < to && blank(lines[from]!))
    {
        from++;
    }
    while (to > from && blank(lines[to - 1]!))
    {
        to--;
    }
    const shownLines: string[] = [];
    let run = 0;
    for (const line of lines.slice(from, to))
    {
        if (blank(line))
        {
            run++;
            if (run <= 2)
            {
                shownLines.push('');
            }
        }
        else
        {
            run = 0;
            shownLines.push(line.quoted && line.codes === 0 && line.text.trim() === '' ? '' : line.text);
        }
    }
    return shownLines;
}

/** referenceDisplayLines joined with LF. */
export function referenceDisplayText(body: string, options: { quotes?: boolean } = {}): string
{
    return referenceDisplayLines(body, options).join('\n');
}

/**
 * What separates the PDF's lines (`shown`: a whole body, nothing left out)
 * from the body with every quote mark kept: line by line, the kept-marks
 * line must END with the shown line, and what comes before it may hold
 * only white space, invisible characters and ">" (never a code: VT and FF
 * end the prefix and stay visible). So the only characters missing are the
 * quote prefixes (and the white space after the marks of a quoted line
 * with no text). Returns the problems found ([] when none).
 */
export function quotePrefixProblems(body: string, shown: readonly string[]): string[]
{
    const kept = referenceDisplayLines(body, { quotes: false });
    if (kept.length !== shown.length)
    {
        return [`${String(shown.length)} lines shown, ${String(kept.length)} with the marks kept`];
    }
    const problems: string[] = [];
    kept.forEach((k, i) =>
    {
        const line = shown[i]!;
        if (!k.endsWith(line))
        {
            problems.push(`line ${String(i)}: ${JSON.stringify(line)} is not the end of ${JSON.stringify(k)}`);
            return;
        }
        const head = k.slice(0, k.length - line.length);
        if (![...head].every((ch) => ch === '>' || inPrefix(ch.codePointAt(0)!)))
        {
            problems.push(`line ${String(i)}: removed ${JSON.stringify(head)}, not a quote prefix`);
        }
        else if (head !== '' && !head.includes('>'))
        {
            problems.push(`line ${String(i)}: removed ${JSON.stringify(head)} without a quote mark`);
        }
    });
    return problems;
}
