// Signature and disclaimer detection (README.md, rules R6 and R7).
//
// Idea: a signature ("Best regards, / Bob Sample / Sample Furniture") or a
// legal disclaimer sits at the end of what the sender wrote, and the same
// sender repeats it in many messages. Two rules find it, and both only
// produce fold ranges (reason 'signature'); text is never changed or removed
// (README.md, rule R6: collapse, never delete).
//
// OWN TEXT. Each message comes with `ownTextEnd`: the offset where the
// sender's own text ends (the start of the quoted history, found by the quote
// detectors; the whole body when not given). Only lines lying completely
// before it are "own lines". Folds never go past `ownTextEnd`, so a
// signature is never stretched over the quote below it, and a signature
// inside quoted history is left to the quote detectors.
//
// 1. DELIMITER RULE. RFC 3676 says a signature starts after a line that is
//    exactly "-- " (dash, dash, space). Such a line (also "--" followed by
//    several spaces, tabs or nbsp, as editors and HTML-to-text leave them)
//    folds from that line down to the last non-blank own line, at most
//    MAX_SIGNATURE_LINES lines. A bare "--" (no space) is also used as a
//    separator in normal prose, so it counts only when everything after it
//    fits in MAX_SIGNATURE_LINES lines. Lines with more dashes ("---",
//    "-----Original Message-----") are separators or forward markers, the
//    reply-header detector's job, never a signature delimiter here. The line
//    must start at the first column: "  -- " or "> -- " is something else.
//    Nothing is folded when no non-blank own line follows the delimiter, and
//    a delimiter on the FIRST non-blank own line is not a delimiter (see
//    SAFETY below): a message that is only "-- / Dana Writer / Sales" stays
//    shown.
// 2. FREQUENCY RULE. For every sender (`senderKey`, '' = unknown, then this
//    rule is skipped) with at least MIN_MESSAGES_PER_SENDER messages:
//    a. Own lines are compared NORMALIZED: Unicode NFC, every run of
//       whitespace (nbsp, tabs, CR included) made one space, trimmed. Case
//       is kept: a block must be identical after this cleaning, so a changed
//       word or letter case means "different text" and it stays shown (the
//       safe direction). There are no ">" markers to strip: quoted lines lie
//       after `ownTextEnd`.
//    b. Blank lines are skipped, so each message is a list of non-blank own
//       lines. Every PAIR of neighbouring lines in that list is counted once
//       per message (a pair repeated inside one message counts once).
//    c. A pair is REPEATED when it occurs in at least minRepeat(n) messages
//       of that sender (see `minRepeat`). A BLOCK is a maximal chain of
//       repeated pairs in one message, i.e. at least MIN_BLOCK_LINES (2)
//       non-blank lines. One repeated line alone ("Hi Bob,", "Thanks,") is
//       never a block. Blank lines between two lines of a block fold with it.
//       Note: each link of a chain is repeated, but the chain as a whole need
//       not occur elsewhere (lines A-B repeated in two messages, B-C in two
//       others give the block A-B-C). Counting pairs instead of whole blocks
//       keeps the cost linear, and every folded line is still part of
//       repeated boilerplate of that sender.
//    d. Guards (a repeated block is not always a signature):
//       - at least MIN_BLOCK_CHARS non-space characters (so "Thanks, / Bob"
//         stays shown);
//       - it may not start at the first non-blank own line (see SAFETY);
//       - it must sit at the END of the own text. Let `before` be the number
//         of non-blank own lines before the block and `after` the number of
//         non-blank own lines after it that are not part of another repeated
//         block. Then: its last line lies in the second half of the own
//         non-blank lines (see END_PART), after <= MAX_TRAILING_LINES, and
//         after <= before. The last test keeps END_PART sensible for short
//         texts: in "Hi Bob, / Thanks for the update. / We agreed on X. /
//         new line / new line" the repeated middle pair ends in the second
//         half but has more new text after it than before it, so it stays
//         shown. So a standard opening paragraph the sender pastes at the top
//         of every mail stays shown, while a signature followed by a separate
//         disclaimer block (or a short "P.S.") still counts.
//         Known limit (safe direction): a signature followed by a P.S. of
//         more than MAX_TRAILING_LINES lines is not folded, also when a
//         repeated disclaimer comes between them ("sig / disclaimer / 4-line
//         P.S." stays shown). Side effect of `after <= before` (also safe
//         direction): a signature followed by a 2-3 line P.S. with only one
//         own line before it is not folded.
//    Every block of the message that passes the guards is folded.
//
// SAFETY (README.md, rule R6: never hide the sender's own new words). Both
// rules keep at least one non-blank own line of every message shown:
//   a. a fold never starts at the first non-blank own line: at least one own
//      non-blank line comes before it (the "-- " on the first line and the
//      frequency block starting there are skipped). So a short reminder sent
//      twice ("Any update on this? / Thanks, / Dana"), a 4-line note sent
//      twice, or 1000 identical messages are not folded at all: when the
//      whole own text repeats, it is the message, not a signature;
//   b. per message, when the folds together would still cover every
//      non-blank own line, the frequency folds of that message are dropped;
//      if the delimiter folds alone still cover everything, they are dropped
//      too. With (a) this cannot happen; it is kept as a second guard.
// Known limit (documented, accepted): templated lines the sender repeats
// right above the closing fold with it. A weekly "Hi team, / Done this week:
// task N / Status: on track / Blockers: none / Thanks, / Dana" folds
// "Status / Blockers / Thanks / Dana". Every folded line is repeated verbatim
// in the sender's other messages, nothing unique is hidden, and the fold can
// be opened. Variant: a reminder whose greeting changes between messages
// ("Hi Bob, / Any update on this? / Thanks, / Dana" then "Hi Carol, / ...")
// folds everything except the greeting (all folded lines are repeated
// verbatim).
//
// Interplay: the overlap detector (overlap-quote-detection.ts) also folds a signature the
// sender repeats, as 'quoted-overlap', because it matches the same text in
// the sender's earlier messages. buildSegments unions the reasons of both;
// the pipeline shows 'signature' as the label when both apply.
//
// Cost: linear in the total body length. Each own line is normalized once,
// each pair is counted once per message in one Map per sender, and each
// message is walked once more to build its blocks. No message is compared
// with another message directly.
//
// Pure functions: no DOM, no storage, inputs are never modified (README.md,
// rule R7).

import { authorKey } from './dedupe';
import { lineRanges, type FoldRange, type LineRange } from './fold-segments';
import type { NormalizedMessage } from '../../Header/parsed-email';

/**
 * Longest fold of the delimiter rule, in lines, the "-- " line and blank
 * lines included. Real signatures are 2 to 8 lines (RFC 1855 even asks for
 * at most 4); 12 leaves room for a long one with an address, while a "-- "
 * typed in front of a long text does not hide all of it.
 */
export const MAX_SIGNATURE_LINES = 12;

/** The frequency rule only runs for senders with at least this many messages. */
export const MIN_MESSAGES_PER_SENDER = 2;

/** A repeated block needs at least this many non-blank lines (one repeated line is a greeting or closing). */
export const MIN_BLOCK_LINES = 2;

/**
 * A repeated block needs at least this many non-space characters. "Thanks, /
 * Bob" (10) stays shown; "Best regards, / Bob Sample" (22) is a signature.
 */
export const MIN_BLOCK_CHARS = 20;

/**
 * Share of a sender's messages a pair of lines must occur in, with a minimum
 * of 2 (see `minRepeat`). Not 100%: senders drop their signature in quick
 * replies or change it over time. Not 2 messages in a large set: two
 * messages out of fifty sharing a block is more likely pasted content (an
 * address, a list) than a signature.
 */
export const MIN_REPEAT_SHARE = 0.3;

/** The last line of a block must come after this share of the own non-blank lines. */
export const END_PART = 0.5;

/**
 * At most this many non-blank own lines after a block may be other text
 * (not another repeated block): room for a "P.S." or "Sent from my phone".
 */
export const MAX_TRAILING_LINES = 3;

/** What the detector needs from each message. */
export interface SignatureInput
{
    readonly bodyText: string;
    /** Lower-cased sender address (see `senderKeyOf`); '' when unknown. */
    readonly senderKey: string;
    /** Offset where the sender's own text ends (start of the quoted history). Default: body length. */
    readonly ownTextEnd?: number;
}

/**
 * The sender key for `detectSignatures`: the lower-cased address of the
 * first From mailbox (as `authorKey` in dedupe.ts), or of `sender` when From
 * has none. '' when there is no address at all.
 */
export function senderKeyOf(message: NormalizedMessage): string
{
    const key = authorKey(message);
    if (key !== '')
    {
        return key;
    }
    // authorKey only falls back to `sender` when From is empty. A From mailbox
    // without an address (a bare display name) gives '' there; Sender, when
    // present, still names the author, so it is used rather than leaving the
    // message out of the frequency rule.
    return message.sender?.address.toLowerCase() ?? '';
}

/** Messages of one sender a pair must occur in: max(2, ceil(30% of them)). */
export function minRepeat(senderMessages: number): number
{
    return Math.max(2, Math.ceil(MIN_REPEAT_SHARE * senderMessages));
}

/** One message, prepared: its own lines and the normalized text of each. */
interface Prepared
{
    readonly body: string;
    readonly senderKey: string;
    readonly ownTextEnd: number;
    readonly lines: readonly LineRange[];
    /** Indices (into `lines`) of the non-blank own lines, in order. */
    readonly nonBlank: readonly number[];
    /** Normalized text of each entry of `nonBlank`. */
    readonly keys: readonly string[];
}

/** NFC, whitespace runs (nbsp, tabs included) made one space, trimmed. */
function normalizeLine(raw: string): string
{
    return raw.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * A block of text as the frequency rule compares it: each line normalized
 * (see normalizeLine), blank lines dropped, joined with "\n". Two blocks are
 * "the same signature" when their keys are equal. Used by the PDF output
 * plan (output-plan.ts) to recognize a repeated signature.
 */
export function signatureBlockKey(text: string): string
{
    const keys: string[] = [];
    for (const line of lineRanges(text))
    {
        const key = normalizeLine(text.slice(line.start, line.contentEnd));
        if (key !== '')
        {
            keys.push(key);
        }
    }
    return keys.join('\n');
}

function prepare(input: SignatureInput): Prepared | null
{
    if (typeof (input as unknown) !== 'object' || (input as unknown) === null)
    {
        return null;
    }
    const body: unknown = input.bodyText;
    if (typeof body !== 'string')
    {
        return null;
    }
    const rawKey: unknown = input.senderKey;
    // Lower-cased again defensively: callers may build the key themselves
    // rather than through senderKeyOf, and "Bob@" and "bob@" are one sender.
    const senderKey = typeof rawKey === 'string' ? rawKey.toLowerCase() : '';
    const rawEnd: unknown = input.ownTextEnd;
    const ownTextEnd =
        typeof rawEnd === 'number' && !Number.isNaN(rawEnd) ? Math.min(Math.max(rawEnd, 0), body.length) : body.length;
    const lines = lineRanges(body);
    // Lines are contiguous, so the own lines (ending before ownTextEnd) are a prefix.
    let ownCount = 0;
    while (ownCount < lines.length && (lines[ownCount]?.contentEnd ?? Infinity) <= ownTextEnd)
    {
        ownCount++;
    }
    const nonBlank: number[] = [];
    const keys: string[] = [];
    for (let i = 0; i < ownCount; i++)
    {
        const line = lines[i];
        if (line === undefined)
        {
            continue;
        }
        const key = normalizeLine(body.slice(line.start, line.contentEnd));
        if (key === '')
        {
            continue;
        }
        nonBlank.push(i);
        keys.push(key);
    }
    return { body, senderKey, ownTextEnd, lines, nonBlank, keys };
}

/** "--" then at least one space, tab or nbsp, nothing else: the RFC 3676 delimiter. */
const STRONG_DELIMITER = /^--[ \t\u00A0]+$/;

/** The fold for lines [first, last] (line breaks included), never past ownTextEnd. */
function foldFor(message: Prepared, first: number, last: number): FoldRange | null
{
    const start = message.lines[first]?.start;
    const lineEnd = message.lines[last]?.end;
    if (start === undefined || lineEnd === undefined)
    {
        return null;
    }
    const end = Math.min(lineEnd, message.ownTextEnd);
    return end > start ? { start, end, reason: 'signature' } : null;
}

/** Rule 1: folds starting at a "-- " (or short "--") line. */
function delimiterFolds(message: Prepared): FoldRange[]
{
    const folds: FoldRange[] = [];
    const lastNonBlank = message.nonBlank[message.nonBlank.length - 1];
    if (lastNonBlank === undefined)
    {
        return folds;
    }
    // k starts at 1: a delimiter on the first non-blank own line is not one
    // (SAFETY a: some own text must come before a signature).
    for (let k = 1; k < message.nonBlank.length; k++)
    {
        const i = message.nonBlank[k] ?? 0;
        const line = message.lines[i];
        if (line === undefined)
        {
            continue;
        }
        const content = message.body.slice(line.start, line.contentEnd);
        const strong = STRONG_DELIMITER.test(content);
        if (!strong && content !== '--')
        {
            continue;
        }
        if (lastNonBlank === i)
        {
            continue; // nothing after the delimiter
        }
        const remaining = lastNonBlank - i + 1;
        if (!strong && remaining > MAX_SIGNATURE_LINES)
        {
            continue; // "--" inside prose
        }
        // Cap, then step back to the last non-blank line within the cap, so
        // blank lines after the signature stay shown.
        const capped = Math.min(lastNonBlank, i + MAX_SIGNATURE_LINES - 1);
        let end = k;
        while (end + 1 < message.nonBlank.length && (message.nonBlank[end + 1] ?? Infinity) <= capped)
        {
            end++;
        }
        const fold = foldFor(message, i, message.nonBlank[end] ?? i);
        if (fold !== null)
        {
            folds.push(fold);
        }
    }
    return folds;
}

/** Key of a pair of normalized lines. A normalized line never holds "\n" (whitespace was collapsed), so the key is unambiguous. */
function pairKey(a: string, b: string): string
{
    return `${a}\n${b}`;
}

/** The pairs of one message, each once. */
function pairsOf(message: Prepared): Set<string>
{
    const set = new Set<string>();
    for (let k = 0; k + 1 < message.keys.length; k++)
    {
        set.add(pairKey(message.keys[k] ?? '', message.keys[k + 1] ?? ''));
    }
    return set;
}

/** A chain of repeated pairs: entries [from, to] of `nonBlank` (both included). */
interface Block
{
    readonly from: number;
    readonly to: number;
}

/** Rule 2 for one message, given which of its pairs are repeated. */
function frequencyFolds(message: Prepared, repeated: (key: string) => boolean): FoldRange[]
{
    // Maximal chains of repeated pairs.
    const chains: Block[] = [];
    let k = 0;
    while (k + 1 < message.keys.length)
    {
        if (!repeated(pairKey(message.keys[k] ?? '', message.keys[k + 1] ?? '')))
        {
            k++;
            continue;
        }
        const from = k;
        while (k + 1 < message.keys.length && repeated(pairKey(message.keys[k] ?? '', message.keys[k + 1] ?? '')))
        {
            k++;
        }
        chains.push({ from, to: k });
    }
    // Size guard. MIN_BLOCK_LINES needs no test: a chain holds at least one
    // pair, so at least 2 lines.
    const blocks = chains.filter((block) =>
    {
        let chars = 0;
        for (let j = block.from; j <= block.to; j++)
        {
            chars += (message.keys[j] ?? '').replace(/ /g, '').length;
        }
        return chars >= MIN_BLOCK_CHARS;
    });
    // Position guard. `otherAfter[j]` = non-blank lines from entry j to the end
    // that are not in any block.
    const inBlock = new Array<boolean>(message.keys.length).fill(false);
    for (const block of blocks)
    {
        for (let j = block.from; j <= block.to; j++)
        {
            inBlock[j] = true;
        }
    }
    const otherAfter = new Array<number>(message.keys.length + 1).fill(0);
    for (let j = message.keys.length - 1; j >= 0; j--)
    {
        otherAfter[j] = (otherAfter[j + 1] ?? 0) + (inBlock[j] ? 0 : 1);
    }
    const folds: FoldRange[] = [];
    for (const block of blocks)
    {
        if (block.from === 0)
        {
            continue; // SAFETY a: some own text must come before it
        }
        const after = otherAfter[block.to + 1] ?? 0;
        const nearEnd = block.to + 1 > END_PART * message.keys.length;
        const fewAfter = after <= MAX_TRAILING_LINES && after <= block.from; // block.from = own non-blank lines before it
        if (!nearEnd || !fewAfter)
        {
            continue;
        }
        const fold = foldFor(message, message.nonBlank[block.from] ?? 0, message.nonBlank[block.to] ?? 0);
        if (fold !== null)
        {
            folds.push(fold);
        }
    }
    return folds;
}

/**
 * Finds signatures and disclaimers. Returns, for each input message (same
 * order), its folds (reason 'signature', no `related`), sorted by start.
 * Folds of the two rules may overlap; buildSegments merges them. The result
 * for a message does not depend on the order of the input. Never throws:
 * bad entries get [].
 */
export function detectSignatures(messages: readonly SignatureInput[]): FoldRange[][]
{
    if (!Array.isArray(messages))
    {
        return [];
    }
    const prepared = messages.map((m: SignatureInput) => prepare(m));

    // Per sender: how many messages, and in how many of them each pair occurs.
    const senders = new Map<string, { messages: number; pairs: Map<string, number> }>();
    const pairSets = prepared.map((message) => (message !== null && message.senderKey !== '' ? pairsOf(message) : null));
    prepared.forEach((message, i) =>
    {
        if (message === null || message.senderKey === '')
        {
            return;
        }
        let entry = senders.get(message.senderKey);
        if (entry === undefined)
        {
            entry = { messages: 0, pairs: new Map() };
            senders.set(message.senderKey, entry);
        }
        entry.messages++;
        for (const key of pairSets[i] ?? [])
        {
            entry.pairs.set(key, (entry.pairs.get(key) ?? 0) + 1);
        }
    });

    return prepared.map((message) =>
    {
        if (message === null)
        {
            return [];
        }
        let delimiter = delimiterFolds(message);
        let frequency: FoldRange[] = [];
        const entry = message.senderKey === '' ? undefined : senders.get(message.senderKey);
        if (entry !== undefined && entry.messages >= MIN_MESSAGES_PER_SENDER)
        {
            const needed = minRepeat(entry.messages);
            frequency = frequencyFolds(message, (key) => (entry.pairs.get(key) ?? 0) >= needed);
        }
        // SAFETY b: at least one non-blank own line stays outside all folds.
        if (coversAllOwnText(message, [...delimiter, ...frequency]))
        {
            frequency = [];
        }
        if (coversAllOwnText(message, delimiter))
        {
            delimiter = [];
        }
        return [...delimiter, ...frequency].sort((a, b) => a.start - b.start || a.end - b.end);
    });
}

/**
 * True when every non-blank own line lies completely inside the union of
 * `folds` (always false without own text). Folds are merged after sorting
 * and the lines walked once, so the cost is O(lines + folds log folds).
 */
function coversAllOwnText(message: Prepared, folds: readonly FoldRange[]): boolean
{
    if (message.nonBlank.length === 0 || folds.length === 0)
    {
        return false;
    }
    const merged: { start: number; end: number }[] = [];
    for (const fold of [...folds].sort((a, b) => a.start - b.start))
    {
        const last = merged[merged.length - 1];
        if (last !== undefined && fold.start <= last.end)
        {
            last.end = Math.max(last.end, fold.end);
        }
        else
        {
            merged.push({ start: fold.start, end: fold.end });
        }
    }
    let mergedIndex = 0;
    for (const i of message.nonBlank)
    {
        const line = message.lines[i];
        if (line === undefined)
        {
            return false;
        }
        while (mergedIndex < merged.length && (merged[mergedIndex]?.end ?? 0) < line.contentEnd)
        {
            mergedIndex++;
        }
        const span = merged[mergedIndex];
        if (span === undefined || span.start > line.start)
        {
            return false;
        }
    }
    return true;
}
