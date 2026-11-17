// Offsets between two copies of the same text (task 8.13b-3, review round 4).
//
// Two copies of one email that de-duplication merged (src/engine/dedupe.ts)
// have bodies that are equal as normalizeBody compares them: the same lines,
// but maybe with other line ends (CRLF or LF), other spaces or tabs at the
// end of a line, accents stored in another Unicode form (NFC), or other blank
// lines at the very start and end. An offset found in one copy (where the
// block of an attached email sits, say) must then be found in the other one.
// mapOffsets does that line by line, and says null whenever it is not sure.
//
// Pure: no DOM, nothing stored (README.md, rule R7).

/** One line of a text: where it starts, where its content ends (before the line end), and where the next one starts. */
interface Line {
    readonly start: number;
    readonly contentEnd: number;
    readonly next: number;
}

/** The lines of `text`; a line end is CRLF, CR or LF (as normalizeBody reads them). Always at least one line. */
function linesOf(text: string): Line[]
{
    const out: Line[] = [];
    const re = /\r\n|\r|\n/gu;
    let start = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text))
    {
        out.push({ start, contentEnd: m.index, next: m.index + m[0].length });
        start = m.index + m[0].length;
    }
    out.push({ start, contentEnd: text.length, next: text.length });
    return out;
}

/** A line as normalizeBody compares it: spaces and tabs at its end dropped, NFC. */
const lineKey = (text: string, l: Line): string => text.slice(l.start, l.contentEnd).replace(/[ \t]+$/u, '').normalize('NFC');

/** The first and one past the last line that is not blank (as normalizeBody sees them); [n, n) when every line is blank. */
function contentLines(text: string, lines: readonly Line[]): [number, number]
{
    let a = 0;
    let b = lines.length;
    while (a < b && lineKey(text, lines[a]!) === '') a++;
    while (b > a && lineKey(text, lines[b - 1]!) === '') b--;
    return a === b ? [lines.length, lines.length] : [a, b];
}

/** The line holding offset `at` (its start <= at, and at < its next line's start, or the last line). */
function lineAt(lines: readonly Line[], at: number): number
{
    let lo = 0;
    let hi = lines.length - 1;
    while (lo < hi)
    {
        const mid = (lo + hi + 1) >> 1;
        if (lines[mid]!.start <= at) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

/**
 * The offsets `offsets` of text `from`, as offsets of text `to`, when the two
 * texts are the same text as de-duplication compares bodies (normalizeBody,
 * src/engine/dedupe.ts: the same lines once line ends are unified, spaces and
 * tabs at line ends dropped and NFC applied, blank lines at the very start
 * and end ignored); null when they are not, or when an offset cannot be
 * placed for certain. Identical texts: the same offsets.
 * An offset maps to the same line of `to`, at the same column when that
 * line is written exactly the same up to there, at its start (column 0), or
 * at its end when it is at (or after) the end of its line's content. An
 * offset in the blank lines at the start maps to the start of `to`'s first
 * line with text; one in the blank lines at the end, to the end of `to`'s
 * last line with text (or the very end, for the very end). Every offset
 * must be an integer from 0 to from.length.
 */
export function mapOffsets(from: string, to: string, offsets: readonly number[]): number[] | null
{
    if (offsets.some((o) => !Number.isInteger(o) || o < 0 || o > from.length)) return null;
    if (from === to) return [...offsets];
    const a = linesOf(from);
    const b = linesOf(to);
    const [a0, a1] = contentLines(from, a);
    const [b0, b1] = contentLines(to, b);
    if (a1 - a0 !== b1 - b0) return null;
    for (let k = 0; a0 + k < a1; k++) if (lineKey(from, a[a0 + k]!) !== lineKey(to, b[b0 + k]!)) return null;
    const out: number[] = [];
    for (const o of offsets)
    {
        if (o === from.length)
        {
            out.push(to.length);
            continue;
        }
        const i = lineAt(a, o);
        if (a0 === a.length)
        {
            // No text at all: only blank lines on both sides.
            out.push(o === 0 ? 0 : to.length);
            continue;
        }
        if (i < a0)
        {
            out.push(b[b0]!.start);
            continue;
        }
        if (i >= a1)
        {
            out.push(b[b1 - 1]!.contentEnd);
            continue;
        }
        const la = a[i]!;
        const lb = b[b0 + (i - a0)]!;
        const column = o - la.start;
        const fromLine = from.slice(la.start, la.contentEnd);
        const toLine = to.slice(lb.start, lb.contentEnd);
        if (column === 0) out.push(lb.start);
        else if (o >= la.contentEnd) out.push(lb.contentEnd);
        else if (fromLine.slice(0, column) === toLine.slice(0, column)) out.push(lb.start + column);
        else return null;
    }
    return out;
}
