// Links the messages rebuilt from quoted text (reconstruct.ts) to the real
// dropped messages and to each other, and builds the timeline: one ordered
// list of real messages and rebuilt messages (milestone 7, task 7.5; brief
// section 8.6). Pure: no DOM, no storage, no clock; the input is never
// modified (README.md, rule R7). The result is plain data.
//
// Nothing here changes or hides a real message or any source text (brief
// section 7): every real message stays in the timeline, and a rebuilt
// message is only ever a VIEW of a slice of its source body, which stays
// whole (and folded) in the source message. Linking only decides whether a
// rebuilt message gets its own timeline entry.
//
// THE RULE: a wrong link is never acceptable, a visible repeat is. A link
// says "this is the very same message", so the rebuilt one gets no entry;
// when in doubt there is no link, and the message shows twice (once as the
// real file or copy, once rebuilt). So every link needs the same sender,
// dates that agree, and enough text that agrees, with no figure changed.
//
// 1. "The real file wins". A rebuilt message R that corresponds to a real
//    message M (not its own source) is linked to M and gets no entry. All of:
//    a. Same sender: R has exactly one From mailbox; with an address, one of
//       M's From mailboxes has the same address (letter case ignored);
//       without an address, the same display name (senderKey below). A
//       sender without an address never counts as an 'exact' or 'strong'
//       date agreement (they become 'zone').
//    b. Dates (realDateAgreement). M has a usable date; R's date is
//       readable (or ambiguous, below); `diff` = M's date minus R's
//       estimate. A quoted date is a wall-clock time read in the source's
//       zone S (quoted-date.ts, basis 'source-offset'). If it was in fact
//       written in zone W, the estimate is off by W - S, so for an
//       APPROXIMATE date diff = S - W (plus the seconds the quote drops).
//       Real zones run from UTC-12 to UTC+14, so with S known diff must lie
//       in [S - 14 h, S + 12 h] (ZONE_SLACK_MS of slack at both ends). A
//       date without minutes is read as its midnight and M may be at any
//       moment of that day: [S - 14 h, S + 36 h]. Outside, the same text is
//       ANOTHER message: a daily reminder sent at 09:00 on Monday is not the
//       one quoted as "Tue 09:00" (diff -24 h). Any diff must also stay
//       within MATCH_WINDOW_MS (26 h; the candidate search window).
//       Levels, best first:
//       - 'exact': an exact date (it carries its own zone) at most
//         EXACT_SLACK_MS (2 min) from M; or an approximate one with minutes
//         at most ZONE_SLACK_MS (1 min) from M (written in the source's
//         own zone, as the estimate assumes).
//       - 'strong': an approximate date with minutes whose diff is the
//         offset between the source's zone and M's own zone, within
//         ZONE_SLACK_MS (the time was written in the sender's zone). A
//         mere match of the 15-min grid is NOT strong (chance about 1 in 8).
//       - 'zone': an approximate date with minutes on the grid (within
//         ZONE_SLACK_MS of a whole number of ZONE_STEP_MS, 15 min) and in
//         the range above.
//       - 'strict': a date without minutes in the range above (an exact
//         one: within that day in its own zone); an approximate date whose
//         source zone S is unknown (basis 'none': the wall time was read
//         as UTC, so diff = -W, in [-14 h, +12 h] plus up to a day for a
//         day only, and never more than 14 h either way: a daily reminder
//         quoted as the next day's 09:00 is another message; never better
//         than 'strict'); or an AMBIGUOUS numeric date ("04/03/2025 05:21": day
//         and month could be swapped, unreadable for quoted-date.ts) of
//         which one reading agrees at some level (ambiguousReadings).
//       Anything else (an exact date further than 2 min, an approximate one
//       off the grid or out of range, no readable date): no link.
//    c. Text, policy (b) (user decision, review round 4): the two texts
//       hold the IDENTICAL word sequence (words: letters/digits runs, lower
//       case, NFC; wordsOf; punctuation, quote marks and spacing do not
//       count), except only for what quoting or sending can produce:
//       - at the START of R's text, the leftover header lines that
//         comparableText leaves out (see there);
//       - at the END of ONE of the two texts (never both), a signature
//         block (signatureStart): either everything after the last
//         signature separator line ("--" or "-- "), or, without one, the
//         lines after the last blank line; in both cases at most
//         MAX_SIGNATURE_LINES (8) non-blank lines, the first made ONLY of
//         words of that text's sender's display name ("Alice", "Alice
//         Example"; no digits, "@" or ":"), and every line a contact line
//         (contactLine: at most 80 characters and 8 words outside mail and
//         web addresses, no "?", "!" or ";", a ":" only after a label of
//         one or two words, every word capitalised, a digit run or a
//         lower-case name/address particle, and no veto word: negations,
//         decisions and afterthoughts in EN/FR/NL such as "not", "no",
//         "cancel...", "declin...", "approv...", "PS", "pas", "niet").
//         In both forms, a block is either the name line alone, or has at
//         least one contact marker line after the name line (contactMarker:
//         a mail address, a web address, or a phone number of 6+ digits,
//         optionally after a label such as "Tel:"); so "Alice" + "Afgelast",
//         "Rescinded", "12 March 2025" or "Total 950 EUR" is no block (user
//         policy (b), review round 4 follow-up).
//         Without a sender name there is never a block. A signature that
//         is not recognised this way means no link (a visible repeat).
//       Any other difference, anywhere, means no link: one word changed,
//       added or dropped ("accept" / "reject", "Approved." / "Not
//       approved.", "Yes" / "Yes, cancelled", "Hello Bob" / "Hello
//       Carol"), a line added at the start ("No.") or the end ("PS: ...
//       we decline.", "Update: ... cancelled."), or a text that is only a
//       part of the other. R's text is comparableText(R). M's text is its
//       OWN text only: its body up to its first quoted part (ownEnd: the
//       first message rebuilt from M itself, or the first quote-marker or
//       reply-header fold). Comparing with M's whole body would match R
//       with any later message that merely QUOTES R.
//       The words compared (a text without its signature block) must also
//       be a large enough share of the words of BOTH whole texts (a short
//       text with a long signature may stay an entry). Per date level
//       (REAL_RULES), share of R / share of M:
//         'exact'  >= 50% / >= 50%, any length;
//         'strong' >= 50% / >= 50%, at least MIN_SHINGLES (10) distinct
//                  shingles of SHINGLE_WORDS (3) words in each text;
//         'zone'   >= 80% / >= 50%, at least MIN_SHINGLES;
//         'strict' >= 80% / >= 80%, at least MIN_SHINGLES.
//       So a short text ("OK", "Thanks!") links only with an exact date
//       agreement. The share of M guards against a later message whose own
//       text holds R's text because it quotes it without marks.
//    d. Figures: the digit runs of the compared words, in text order, are
//       the same (digitsOf; kept as a second check, though identical words
//       imply it). "invoice 2025-031, 1200 euro" never links to "invoice
//       2025-030, 950 euro", nor "from 10:00 to 14:00" to "from 14:00 to
//       10:00". The figures of a signature block left out (a phone number)
//       are not compared.
//    Among several real messages that qualify, the highest share of R
//    wins, then the closest date, then the lowest list position. Only the
//    MAX_CANDIDATES real messages closest in time are compared (more is only
//    possible with hundreds of messages of one sender within 26 h; then a
//    rebuilt message may stay an entry: a visible repeat, never a loss).
//    De-duplication of real files (dedupe.ts) is not touched.
// 2. Rebuilt vs rebuilt. The same earlier message quoted in several dropped
//    emails becomes ONE entry; the other copies are linked to it ("same-as")
//    and listed in its `copies` / `alsoQuotedIn` ("same quoted text also in
//    email #K"). Unmatched rebuilt messages are taken in BEST-COPY order:
//      fewer `incomplete` fields, then more known fields (a sender, a To
//      list, a subject, a readable date, an exact date), then the lower
//      generation (quoted fewer times), then the source's list position,
//      then the id.
//    Each joins the existing entry that agrees with it best (below), else
//    becomes an entry itself (so the entry is the best copy). Agreement:
//    the same sender key; a different source email than every copy already
//    in the group; the same figures (1d); and dates (copyDateAgreement).
//    A copy's estimate is off by (W - S) as in 1b, so two copies of one
//    message are diff = (S_a - W_a) - (S_b - W_b) apart (plus up to a day
//    for a date without minutes). Accepted, with |diff| at most
//    MATCH_WINDOW_MS:
//    - both exact: within EXACT_SLACK_MS ('exact'; days: 'strict');
//    - both approximate: within ZONE_SLACK_MS of 0 (each shows the moment
//      in its own source's zone: 'exact') or of S_a - S_b (both show the
//      same wall clock: 'zone'); nothing else. Being in different zones is
//      not enough: Bob (UTC) quoting "Mon 09:00" and Carol (UTC+1) quoting
//      "Tue 10:00" are 24 h apart, two days of a daily message. With a date
//      without minutes, 'strict' (two days only: the same two shifts, no
//      day part; one day and one time: the time within that day);
//    - one exact: the approximate one's W in [-12 h, +14 h] as in 1b,
//      within ZONE_SLACK_MS of 0 ('exact'), else on the grid ('zone');
//      with a day, 'strict';
//    - or both unreadable with the very same date text (spacing tidied)
//      holding a 4-digit year and a day number, and the two SOURCES' own
//      dates at most MATCH_WINDOW_MS apart ('strict'; "yesterday" or
//      "Monday" never merges).
//    Text: policy (b) of 1c (identical words, a signature block at the
//    end of one copy only); 'exact' >= 50% of each text, any
//    length; otherwise >= 80% of each and at least MIN_SHINGLES in each
//    (COPY_RULES). Best agreement wins (higher
//    lower share, closer date, lower id). Again at most MAX_CANDIDATES
//    entries are compared. A rebuilt message without a sender is never
//    linked; one without any date text is never merged with another copy.
// 3. Timeline (TimelineEntry). Real messages keep their order (the order of
//    EngineResult.messages, dated first, then undated by file order). Each
//    rebuilt message with a readable date gets a time KEY from its own
//    estimate, kept inside the order of its own chain (a message is written
//    after the one it quotes, before the one that quotes it):
//    - not later than the newer REAL messages of its chain (its source, a
//      newer generation matched to a real file): capped to the nearest one,
//      placed just before it ('capped-by-quoter');
//    - not earlier than the older ones (an older generation matched to a
//      real file): raised to it, placed just after it ('after-quoted');
//      when both bounds disagree, the newer one wins;
//    - then never later than the newer rebuilt message of its chain (capped
//      to its key and placed with it, older first).
//    Real dates are exact; quoted ones are approximate (their zone is
//    assumed), hence these bounds. Keyed entries are merged into the dated
//    real messages: on an equal time a rebuilt entry comes BEFORE the real
//    message unless it was raised to it, and rebuilt entries among
//    themselves go by generation (older first), source position, id.
//    Remaining keyed entries come after the dated real messages, before the
//    undated ones (file order).
//    A rebuilt entry with no readable date ('before-quoter') is placed just
//    before its quoter's place: the nearest message up its own chain that is
//    in the timeline (an entry, or the real message a rebuilt one is matched
//    to), or its source. Several before one place go older first.
//
// Cost: tokenizing is linear in the text; comparisons are bounded by
// MAX_CANDIDATES per rebuilt message; the joined words and the shingle
// sets are built once per text; a text test is one string comparison
// (plus a signature block search, linear in the text).

import { isPlainName } from './quoted-header';
import { hasWrittenZone, parseQuotedDate } from './quoted-date';
import { LABEL_HEAD_LENGTH, LABEL_PATTERN, LABEL_ROLE_OF, labelKey } from './reply-header';
import type { EmailAddress, NormalizedMessage } from '../../Header/parsed-email';
import type { EngineRebuilt, QuotedDate, RealMatch, RebuiltPlacement, ReconstructedMessage, TimelineEntry } from '../../Header/rebuilt-emails';

/** Dates further apart than this never match (26 h; the zone ranges of the file comment, 1b, are narrower still). */
export const MATCH_WINDOW_MS = 26 * 60 * 60_000;
/** Words per shingle (only to count the evidence: MIN_SHINGLES). */
export const SHINGLE_WORDS = 3;
/** Share of each text needed in general (file comment, 1c and 2). */
export const MIN_COVERAGE = 0.8;
/** Share needed when the dates agree 'exact' or 'strong'. */
export const MIN_COVERAGE_STRONG = 0.5;
/** Share of the real message's own text needed in the compared words ('zone' level). */
export const MIN_REVERSE_COVERAGE = 0.5;
/** Fewer distinct shingles than this in either text: no link unless the dates agree 'exact'. */
export const MIN_SHINGLES = 10;
/** An exact quoted date (it has its own zone) agrees with a moment this close. */
export const EXACT_SLACK_MS = 2 * 60_000;
/** Slack for an approximate date with minutes (quoted times have no seconds). */
export const ZONE_SLACK_MS = 60_000;
/** Every real zone offset is a whole number of these. */
export const ZONE_STEP_MS = 15 * 60_000;
/** The easternmost zone offset in use (UTC+14). */
export const MAX_EAST_MS = 14 * 60 * 60_000;
/** The westernmost zone offset in use (UTC-12), as a positive number. */
export const MAX_WEST_MS = 12 * 60 * 60_000;
/** A day: a date without minutes may be any moment of it. */
const DAY_MS = 24 * 60 * 60_000;
/** Most candidates compared per rebuilt message (the closest in time first). */
export const MAX_CANDIDATES = 64;

/** One kept real message, in EngineResult.messages order. */
export interface LinkSource
{
    /** Input position (EngineMessage.index). */
    readonly index: number;
    readonly message: NormalizedMessage;
    /** Its date when it is placed by date; null when placed by file order. */
    readonly utcMs: number | null;
    /** End of its own text in bodyText (see the file comment, 1c). */
    readonly ownEnd: number;
    /** Messages rebuilt from its body, newest first (as reconstructQuotedMessages returns them). */
    readonly rebuilt: readonly ReconstructedMessage[];
}

/**
 * How well two dates agree, best first (file comment, 1b and 2): 'exact'
 * (the same moment), 'strong' (the same moment in the real sender's zone),
 * 'zone' (a zone offset apart), 'strict' (a day only, or an ambiguous date).
 */
export type DateAgreement = 'exact' | 'strong' | 'zone' | 'strict';

export interface RebuildLinks
{
    readonly reconstructed: EngineRebuilt[];
    readonly timeline: TimelineEntry[];
}

// ---------------------------------------------------------------- text

/** The words of a text, with its shingle sets and joined form built on demand. */
export interface Words
{
    readonly tokens: readonly string[];
    readonly sets: Map<number, ReadonlySet<string>>;
}

const WORD = /[\p{L}\p{M}\p{N}]+/gu;

/** Letters, marks and digits runs, lower case, NFC. Punctuation, quote marks and spacing do not count. */
export function wordsOf(text: string): Words
{
    return { tokens: text.toLowerCase().normalize('NFC').match(WORD) ?? [], sets: new Map() };
}

function shingles(w: Words, k: number): ReadonlySet<string>
{
    let set = w.sets.get(k);
    if (set === undefined)
    {
        const s = new Set<string>();
        const t = w.tokens;
        for (let i = 0; i + k <= t.length; i++)
        {
            let shingle = t[i] as string;
            for (let j = 1; j < k; j++)
            {
                shingle += ` ${t[i + j] as string}`;
            }
            s.add(shingle);
        }
        w.sets.set(k, s);
        set = s;
    }
    return set;
}

/** Number of distinct shingles of SHINGLE_WORDS words (0 for a text shorter than that). */
export function distinctShingles(w: Words): number
{
    return shingles(w, SHINGLE_WORDS).size;
}

const joinedCache = new WeakMap<Words, string>();

/**
 * The words joined by single spaces, with a space before and after. A word
 * never holds a space, so " a b " is found in " x a b y " only as the whole
 * words a, b in this order (never as a part of a word).
 */
function joined(w: Words): string
{
    let j = joinedCache.get(w);
    if (j === undefined)
    {
        j = ` ${w.tokens.join(' ')} `;
        joinedCache.set(w, j);
    }
    return j;
}

/** Whether two word lists are the very same words in the same order (file comment, 1c). */
export function sameWords(a: Words, b: Words): boolean
{
    return a.tokens.length === b.tokens.length && joined(a) === joined(b);
}

/** Most non-blank lines in a trailing signature block (file comment, 1c). */
export const MAX_SIGNATURE_LINES = 8;
/** Most words (outside addresses and web addresses) on one line of a signature block. */
const MAX_SIGNATURE_LINE_WORDS = 8;
/** Longest line of a signature block, in characters. */
const MAX_SIGNATURE_LINE_LENGTH = 80;
/** Lower-case words a contact line may hold (name particles, address and title connectors). */
const CONNECTORS: ReadonlySet<string> = new Set([
    'of', 'and', 'the', 'for', 'at', 'in', 'on', 'to', 'de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'et', 'van', 'der', 'den', 'het', 'en', 'von', 'y', 'e',
]);
/**
 * Words that may change the meaning of the text above them (a negation, a
 * decision, an afterthought), EN / FR / NL: a block holding one is never a
 * signature. Prefixes (any word starting with one) and whole words.
 */
const VETO_PREFIXES: readonly string[] = [
    'cancel', 'declin', 'reject', 'refus', 'deni', 'withdr', 'revok', 'revoc', 'postpon', 'approv', 'accept', 'agre', 'confirm', 'disagre',
    'annul', 'aucun', 'weiger', 'afgewez', 'goedgek', 'geannul', 'akkoord', 'uitgestel', 'report', 'stop', 'updat',
];
const VETO_WORDS: ReadonlySet<string> = new Set([
    'not', 'no', 'never', 'nothing', 'none', 'nor', 'cannot', 'can', 'don', 'doesn', 'didn', 'won', 'isn', 'aren', 'wasn', 'weren', 'shouldn', 'couldn', 'wouldn',
    'yes', 'ok', 'okay', 'but', 'however', 'unless', 'except', 'ps', 'pps', 'nb', 'deny', 'void', 'hold', 'wait', 'off', 'instead', 'only',
    'non', 'pas', 'ne', 'n', 'jamais', 'rien', 'oui', 'mais', 'sauf', 'accord', 'plus',
    'nee', 'niet', 'geen', 'nooit', 'niets', 'ja', 'maar', 'behalve', 'alleen',
]);

/** Whether a word (lower case) may change the meaning (VETO_PREFIXES, VETO_WORDS). */
function vetoWord(w: string): boolean
{
    return VETO_WORDS.has(w) || VETO_PREFIXES.some((p) => w.startsWith(p));
}

/**
 * Whether a line is a contact line of a signature block (file comment, 1c):
 * at most MAX_SIGNATURE_LINE_LENGTH characters; no "?", "!" or ";"; a ":"
 * only after a label of one or two words ("Tel:", "E-mail:"; the label
 * itself may be in lower case, but holds no veto word); outside mail
 * and web addresses at most MAX_SIGNATURE_LINE_WORDS words, each starting
 * with a capital letter or a digit, or a lower-case CONNECTOR; no veto word.
 * So "Sales Manager", "Example Furniture Ltd.", "Rue de l'Exemple 12, 1000
 * Brussels", "Phone +32 2 555 01 23", "alice@example.test" are contact
 * lines; "we decline", "PS: ...", "Not Approved", "Cancelled" are not.
 */
export function contactLine(line: string): boolean
{
    const s = line.trim().normalize('NFC');
    if (s === '' || s.length > MAX_SIGNATURE_LINE_LENGTH || /[?!;\u00bf\u00a1]/u.test(s))
    {
        return false;
    }
    const colon = s.indexOf(':');
    const label = colon < 0 ? [] : (s.slice(0, colon).match(WORD) ?? []);
    if (label.length > 2 || label.some((w) => vetoWord(w.toLowerCase())))
    {
        return false;
    }
    const rest = (colon < 0 ? s : s.slice(colon + 1)).replace(/\S+@\S+/gu, ' ').replace(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/giu, ' ');
    const words = rest.match(WORD) ?? [];
    if (words.length > MAX_SIGNATURE_LINE_WORDS)
    {
        return false;
    }
    return words.every((w) =>
    {
        const lower = w.toLowerCase();
        if (vetoWord(lower))
        {
            return false;
        }
        return !/^\p{Ll}/u.test(w) || CONNECTORS.has(lower);
    });
}

/** Labels a contact marker line may start with ("Tel:", "E-mail", "M."), lower case. */
const MARKER_LABELS: ReadonlySet<string> = new Set([
    'tel', 't\u00e9l', 'phone', 'telephone', 't\u00e9l\u00e9phone', 'telefoon', 'mobile', 'mob', 'mobiel', 'gsm', 'cell', 'portable', 'fax', 'office', 'direct',
    't', 'm', 'f', 'p', 'e', 'w', 'email', 'e-mail', 'mail', 'courriel', 'web', 'website', 'site',
]);

/**
 * Whether a line is a contact marker (file comment, 1c): apart from an
 * optional label (MARKER_LABELS, then "." and/or ":"), the line is exactly
 * - a mail address ("alice@example.test", "<alice@example.test>"),
 * - a web address (a scheme then "://", or "www." first), or
 * - a phone number: digits with only spaces, ".", "-", "(", ")" and a
 *   leading "+" between them, at least 6 digits, not shaped like a date
 *   ("12.03.2025", "2025-03-12"); without a label it must start with "+",
 *   "(" or "0" ("+32 2 123 45 67", "0470 12 34 56").
 * So "Total 950 EUR", "12 March 2025", "Total 1 250 000" are not markers.
 */
export function contactMarker(line: string): boolean
{
    let s = line.trim().normalize('NFC');
    let labelled = false;
    const label = /^([\p{L}][\p{L}-]*)\.?\s*:?\s*/u.exec(s);
    if (label && MARKER_LABELS.has((label[1] as string).toLowerCase()) && label[0].length < s.length)
    {
        s = s.slice(label[0].length);
        labelled = true;
    }
    if (/^<?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/u.test(s))
    {
        return true;
    }
    if (/^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+$/iu.test(s))
    {
        return true;
    }
    if (!/^\+?\(?\d[\d .()-]*\d\)?$/u.test(s))
    {
        return false;
    }
    if (/^\d{1,4}[.-]\d{1,2}[.-]\d{1,4}$/u.test(s))
    {
        return false;
    }
    if ((s.match(/\d/gu) ?? []).length < 6)
    {
        return false;
    }
    return labelled || /^[+(0]/u.test(s);
}

/**
 * Where a trailing signature block starts in `text` (an offset), or null
 * when the text does not end with one (file comment, 1c). `senderWords`:
 * the words (wordsOf) of the sender's display name(s); without a name there
 * is never a block. The block is either
 * - everything after the LAST signature separator line ("--" or "-- "), or,
 *   without such a line,
 * - the lines after the last blank line (trailing blank lines aside), with
 *   at least one word before that blank line;
 * and, in both cases, at most MAX_SIGNATURE_LINES non-blank lines, the first
 * of them made only of words of the sender's name ("Alice", "Alice
 * Example"), every one a contactLine; a block of more than that name line
 * also needs at least one contactMarker line after the name line ("Alice"
 * alone is a block, "Alice\nAfgelast" or "Alice\nTotal 950 EUR" is not).
 * Anything else: null (in doubt, no block, so no link).
 */
export function signatureStart(text: string, senderWords: ReadonlySet<string>): number | null
{
    if (senderWords.size === 0)
    {
        return null;
    }
    const lines: { start: number; text: string }[] = [];
    let at = 0;
    for (const raw of text.split('\n'))
    {
        lines.push({ start: at, text: raw });
        at += raw.length + 1;
    }
    const blank = (k: number): boolean => (lines[k] as { text: string }).text.trim() === '';
    let end = lines.length;
    while (end > 0 && blank(end - 1))
    {
        end--;
    }
    let first = -1; // first line of the block content
    let start = -1; // offset where the block starts (the separator, or the first content line)
    for (let k = end - 1; k >= 0; k--)
    {
        if (/^--[ \t]?\r?$/u.test((lines[k] as { text: string }).text))
        {
            first = k + 1;
            start = (lines[k] as { start: number }).start;
            break;
        }
    }
    if (first < 0)
    {
        let b = end - 1;
        while (b >= 0 && !blank(b))
        {
            b--;
        }
        if (b < 0)
        {
            return null;
        }
        first = b + 1;
        start = (lines[first] as { start: number }).start;
    }
    const content: string[] = [];
    for (let k = first; k < end; k++)
    {
        if (!blank(k))
        {
            content.push((lines[k] as { text: string }).text);
        }
    }
    if (content.length === 0 || content.length > MAX_SIGNATURE_LINES)
    {
        return null;
    }
    const nameWords = wordsOf(content[0] as string).tokens;
    if (nameWords.length === 0 || !nameWords.every((w) => senderWords.has(w)) || /[\p{N}@:]/u.test(content[0] as string))
    {
        return null;
    }
    if (!content.every(contactLine))
    {
        return null;
    }
    if (content.length > 1 && !content.slice(1).some(contactMarker))
    {
        return null;
    }
    if (wordsOf(text.slice(0, start)).tokens.length === 0)
    {
        return null;
    }
    return start;
}

/** A text as compared (file comment, 1c): all its words, and the words before its signature block when it ends with one. */
export interface Compared
{
    readonly full: Words;
    readonly core: Words | null;
}

/** The Compared form of `text`, sent by a sender whose name words are `senderWords`. */
export function compared(text: string, senderWords: ReadonlySet<string>): Compared
{
    const at = signatureStart(text, senderWords);
    return { full: wordsOf(text), core: at === null ? null : wordsOf(text.slice(0, at)) };
}

/** The words of display names, for signatureStart. */
export function nameWordsOf(mailboxes: readonly Pick<EmailAddress, 'name'>[]): Set<string>
{
    const out = new Set<string>();
    for (const m of mailboxes)
    {
        for (const w of wordsOf(m.name).tokens)
        {
            out.add(w);
        }
    }
    return out;
}

/**
 * Policy (b) (file comment, 1c): the very same words in the same order,
 * except that ONE of the two texts may also end with its signature block.
 * The share of each text's words in the words compared (`a` first), or
 * null. Null too when there is no word to compare.
 */
export function sharedWords(a: Compared, b: Compared): { readonly a: number; readonly b: number; readonly words: Words } | null
{
    const na = a.full.tokens.length;
    const nb = b.full.tokens.length;
    if (na === 0 || nb === 0)
    {
        return null;
    }
    if (sameWords(a.full, b.full))
    {
        return { a: 1, b: 1, words: a.full };
    }
    if (a.core !== null && a.core.tokens.length > 0 && sameWords(a.core, b.full))
    {
        return { a: a.core.tokens.length / na, b: 1, words: a.core };
    }
    if (b.core !== null && b.core.tokens.length > 0 && sameWords(a.full, b.core))
    {
        return { a: 1, b: b.core.tokens.length / nb, words: b.core };
    }
    return null;
}

const DIGITS = /\p{N}+/gu;
const digitCache = new WeakMap<Words, string>();

/** The digit runs of a text in text order, as one string (file comment, 1d). */
export function digitsOf(w: Words): string
{
    let d = digitCache.get(w);
    if (d === undefined)
    {
        const runs: string[] = [];
        for (const t of w.tokens)
        {
            for (const run of t.match(DIGITS) ?? [])
            {
                runs.push(run);
            }
        }
        d = runs.join(' ');
        digitCache.set(w, d);
    }
    return d;
}

/** Shares needed (each way) and whether MIN_SHINGLES applies, per date level (file comment, 1c and 2). */
interface TextRule
{
    readonly forward: number;
    readonly reverse: number;
    readonly minEvidence: boolean;
}

const REAL_RULES: Readonly<Record<DateAgreement, TextRule>> = {
    exact: { forward: MIN_COVERAGE_STRONG, reverse: MIN_REVERSE_COVERAGE, minEvidence: false },
    strong: { forward: MIN_COVERAGE_STRONG, reverse: MIN_REVERSE_COVERAGE, minEvidence: true },
    zone: { forward: MIN_COVERAGE, reverse: MIN_REVERSE_COVERAGE, minEvidence: true },
    strict: { forward: MIN_COVERAGE, reverse: MIN_COVERAGE, minEvidence: true },
};

const COPY_RULES: Readonly<Record<DateAgreement, TextRule>> = {
    exact: { forward: MIN_COVERAGE_STRONG, reverse: MIN_COVERAGE_STRONG, minEvidence: false },
    strong: { forward: MIN_COVERAGE, reverse: MIN_COVERAGE, minEvidence: true }, // never given for copies
    zone: { forward: MIN_COVERAGE, reverse: MIN_COVERAGE, minEvidence: true },
    strict: { forward: MIN_COVERAGE, reverse: MIN_COVERAGE, minEvidence: true },
};

/** Both shares when texts A and B agree under `rule` (file comment, 1c, 1d and 2), else null. */
function textAgreement(a: Compared, b: Compared, rule: TextRule): { fwd: number; rev: number } | null
{
    if (rule.minEvidence && (distinctShingles(a.full) < MIN_SHINGLES || distinctShingles(b.full) < MIN_SHINGLES))
    {
        return null;
    }
    const shares = sharedWords(a, b);
    if (shares === null || shares.a < rule.forward || shares.b < rule.reverse)
    {
        return null;
    }
    // The figures of the compared words (1d). A figure in a signature block (a phone number) is not compared.
    if (rule.minEvidence && distinctShingles(shares.words) < MIN_SHINGLES)
    {
        return null;
    }
    const da = digitsOf(shares.a === 1 ? a.full : (a.core as Words));
    const db = digitsOf(shares.b === 1 ? b.full : (b.core as Words));
    if (da !== db)
    {
        return null;
    }
    return { fwd: shares.a, rev: shares.b };
}

// ---------------------------------------------------------------- people and dates

function normalName(name: string): string
{
    return name.normalize('NFC').toLowerCase().replace(/^["'\s]+|["'\s]+$/gu, '').replace(/\s+/gu, ' ');
}

/** 'a:' + address, or 'n:' + name when there is no address; null when empty. */
function mailboxKey(m: EmailAddress, useName: boolean): string | null
{
    const address = m.address.trim().toLowerCase();
    if (!useName)
    {
        return address === '' ? null : `a:${address}`;
    }
    const name = normalName(m.name);
    return name === '' ? null : `n:${name}`;
}

/** The rebuilt message's sender key (file comment, 1a); null without exactly one From mailbox. */
export function rebuiltSenderKey(r: Pick<ReconstructedMessage, 'from'>): string | null
{
    if (r.from.length !== 1)
    {
        return null;
    }
    const m = r.from[0] as EmailAddress;
    return mailboxKey(m, false) ?? mailboxKey(m, true);
}

/** Every key a real message's From mailboxes answer to (address keys and name keys). */
export function realSenderKeys(message: Pick<NormalizedMessage, 'from'>): string[]
{
    const keys = new Set<string>();
    for (const m of message.from)
    {
        for (const useName of [false, true])
        {
            const k = mailboxKey(m, useName);
            if (k !== null)
            {
                keys.add(k);
            }
        }
    }
    return [...keys];
}

const MINUTE_MS = 60_000;

/** Distance of |diff| to the nearest whole number of ZONE_STEP_MS. */
function offGrid(diffMs: number): number
{
    const m = Math.abs(diffMs) % ZONE_STEP_MS;
    return Math.min(m, ZONE_STEP_MS - m);
}

/** Whether `diffMs` lies in [lo, hi], widened by `slack` at both ends. */
function within(diffMs: number, lo: number, hi: number, slack: number): boolean
{
    return diffMs >= lo - slack && diffMs <= hi + slack;
}

/**
 * How a quoted date agrees with a real message's date `diffMs` away (real
 * minus estimate; file comment, 1b), or null. `sourceOffsetMs`: the zone
 * offset the estimate assumed (the source's, basis 'source-offset'), null
 * when unknown (basis 'none'). `senderDiffMs`: the diff that means
 * "written in the real sender's zone" (the source's offset minus the real
 * message's; null when unknown).
 */
export function realDateAgreement(
    date: Pick<QuotedDate, 'precision'>,
    approximate: boolean,
    diffMs: number,
    sourceOffsetMs: number | null,
    senderDiffMs: number | null = null,
): DateAgreement | null
{
    if (!Number.isFinite(diffMs) || Math.abs(diffMs) > MATCH_WINDOW_MS)
    {
        return null;
    }
    if (date.precision !== 'minute' && date.precision !== 'day')
    {
        return null;
    }
    const span = date.precision === 'day' ? DAY_MS : 0;
    if (!approximate)
    {
        // It carries its own zone: the moment itself (a day: that day, in that zone).
        if (!within(diffMs, 0, span, EXACT_SLACK_MS))
        {
            return null;
        }
        return span === 0 ? 'exact' : 'strict';
    }
    // Zone of the source unknown: the wall time was read as UTC, so diff = -W
    // with W in [-12 h, +14 h] (plus up to a day for a day only), and never
    // more than MAX_EAST_MS (14 h) either way; only the strict text rule.
    if (sourceOffsetMs === null)
    {
        if (Math.abs(diffMs) > MAX_EAST_MS + ZONE_SLACK_MS)
        {
            return null;
        }
        return within(diffMs, -MAX_EAST_MS, MAX_WEST_MS + span, ZONE_SLACK_MS) ? 'strict' : null;
    }
    // Written in a zone W of [-12 h, +14 h]: diff = S - W (plus up to a day for a day only).
    if (!within(diffMs, sourceOffsetMs - MAX_EAST_MS, sourceOffsetMs + MAX_WEST_MS + span, ZONE_SLACK_MS))
    {
        return null;
    }
    if (span !== 0)
    {
        return 'strict';
    }
    if (Math.abs(diffMs) <= ZONE_SLACK_MS)
    {
        return 'exact';
    }
    if (senderDiffMs !== null && Math.abs(diffMs - senderDiffMs) <= ZONE_SLACK_MS)
    {
        return 'strong';
    }
    return offGrid(diffMs) <= ZONE_SLACK_MS ? 'zone' : null;
}

/** One copy's date, for copyDateAgreement. */
export interface CopyDate
{
    readonly precision: QuotedDate['precision'];
    readonly approximate: boolean;
    /** The zone offset its estimate assumed (minutes): the source's for basis 'source-offset', else 0. */
    readonly zoneMinutes: number;
}

/**
 * How two copies' readable dates agree, `diffMs` apart (b's estimate minus
 * a's; file comment, 2), or null. With S the zone a copy's estimate assumed
 * and W the zone its time was written in, a copy's estimate is the moment
 * plus (W - S), minus up to a day for a day only, so
 * diff = (S_a - W_a) - (S_b - W_b) + (a's day part) - (b's day part):
 * - both exact (W = S): the day parts only;
 * - both approximate: either each was shown in its own source's zone
 *   (W_a = S_a, W_b = S_b: the day parts only), or both show one same wall
 *   clock (W_a = W_b: S_a - S_b plus the day parts; two days only are two
 *   midnights, so no day part at all). Nothing else: another
 *   time in another zone is just as likely another message (a daily
 *   reminder, 24 h on);
 * - one exact: the approximate one's W is in [-12 h, +14 h], as in 1b.
 */
export function copyDateAgreement(a: CopyDate, b: CopyDate, diffMs: number): DateAgreement | null
{
    if (!Number.isFinite(diffMs) || Math.abs(diffMs) > MATCH_WINDOW_MS)
    {
        return null;
    }
    if (a.precision === null || b.precision === null)
    {
        return null;
    }
    const spanA = a.precision === 'day' ? DAY_MS : 0;
    const spanB = b.precision === 'day' ? DAY_MS : 0;
    const minutes = spanA === 0 && spanB === 0;
    const sa = a.zoneMinutes * MINUTE_MS;
    const sb = b.zoneMinutes * MINUTE_MS;
    if (!a.approximate && !b.approximate)
    {
        if (!within(diffMs, -spanB, spanA, EXACT_SLACK_MS))
        {
            return null;
        }
        return minutes ? 'exact' : 'strict';
    }
    if (a.approximate && b.approximate)
    {
        // Two days only are two midnights: the very same shift, no day part.
        const da = spanB === 0 ? spanA : 0;
        const db = spanA === 0 ? spanB : 0;
        if (within(diffMs, -db, da, ZONE_SLACK_MS))
        {
            return minutes ? 'exact' : 'strict';
        }
        if (within(diffMs, sa - sb - db, sa - sb + da, ZONE_SLACK_MS))
        {
            return minutes ? 'zone' : 'strict';
        }
        return null;
    }
    // One exact (its W is its S: no shift), one approximate with W in [-12 h, +14 h].
    const lo = a.approximate ? sa - MAX_EAST_MS : -(sb + MAX_WEST_MS);
    const hi = a.approximate ? sa + MAX_WEST_MS : -(sb - MAX_EAST_MS);
    if (!within(diffMs, lo - spanB, hi + spanA, ZONE_SLACK_MS))
    {
        return null;
    }
    if (!minutes)
    {
        return 'strict';
    }
    if (Math.abs(diffMs) <= ZONE_SLACK_MS)
    {
        return 'exact';
    }
    return offGrid(diffMs) <= ZONE_SLACK_MS ? 'zone' : null;
}

// ---------------------------------------------------------------- linking

interface Item
{
    readonly id: number;
    /** Source position in the sources list. */
    readonly pos: number;
    readonly r: ReconstructedMessage;
    readonly key: string | null;
    readonly est: number | null;
    /** The zone offset its estimate assumed, minutes (CopyDate.zoneMinutes). */
    readonly zoneMinutes: number;
    words: Compared | null;
    realPos: number | null;
    match: RealMatch | null;
    /** Entry id of its group (itself when it is an entry), null while unset. */
    groupOf: number | null;
}

/** A line that can be what is left of a header read short (comparableText). */
function leftoverLine(line: string): boolean
{
    const s = line.replace(/\s+/gu, ' ').trim().normalize('NFC');
    if (s === '')
    {
        return false;
    }
    const label = LABEL_PATTERN.exec(s.slice(0, LABEL_HEAD_LENGTH))?.[1];
    if (label !== undefined && LABEL_ROLE_OF.has(labelKey(label)))
    {
        return true;
    }
    // A mailbox list goes on with ";" (Outlook) or with addresses.
    if (!/[;@]/u.test(s))
    {
        return false;
    }
    const items = s
        .split(/[;,]/u)
        .map((x) => x.trim())
        .filter((x) => x !== '');
    return (
        items.length > 0 &&
        items.every((x) =>
        {
            if (/^[^<>@]*<[^<>\s]*@[^\s]*>$/u.test(x) || /^(?:mailto:)?[^\s<>@]+@[^\s<>@]+$/iu.test(x))
            {
                return true;
            }
            const name = x.replace(/"/gu, '').trim();
            return name !== '' && !/[\p{N}<>@()[\]]/u.test(name) && isPlainName(name, false);
        })
    );
}

/**
 * The part of a rebuilt text compared with other texts (file comment, 1c).
 * Only the comparison: the text itself is unchanged. When the header was
 * read short (a To / Cc list in `incomplete`), what is left of it (the rest
 * of a wrapped list, a Subject line) may open the text; those lines are
 * left out, but only when ALL of:
 * - every incomplete list has at least one mailbox. An EMPTY one may come
 *   from the rule "the value yields no mailbox" (quoted-header.ts, rule 3):
 *   then the header was read whole, nothing is left over, and the text
 *   opens with the body itself;
 * - the text opens with one or more lines shaped like header leftovers (a
 *   header label line, or a list holding ";" or "@" whose every item is an
 *   address or a plain name; leftoverLine);
 * - a blank line (or the end of the text) comes right after them.
 * Otherwise nothing is left out (in doubt, the whole text is compared: more
 * words, so fewer links, never more). Left out up to the end: nothing is
 * compared (no words, no link).
 */
export function comparableText(r: Pick<ReconstructedMessage, 'incomplete' | 'reconstructedText' | 'to' | 'cc'>): string
{
    const text = r.reconstructedText;
    if (r.incomplete.length === 0)
    {
        return text;
    }
    if (r.incomplete.some((role) => (role === 'to' ? r.to : r.cc).length === 0))
    {
        return text;
    }
    const line = /[^\n]*(?:\n|$)/gu;
    let skipped = 0;
    for (let at = 0; at < text.length; )
    {
        line.lastIndex = at;
        const m = line.exec(text) as RegExpExecArray;
        const next = at + m[0].length;
        if (m[0].trim() === '')
        {
            return skipped === 0 ? text : text.slice(next);
        }
        if (!leftoverLine(m[0]))
        {
            return text;
        }
        skipped++;
        at = next;
    }
    return '';
}

const SWAPPABLE = /^\s*(\d{1,2})([./-])(\d{1,2})\2(\d{4})(?![\d])(.*)$/su;

/** The readable readings of an ambiguous numeric date (ambiguousReadings), as dates. */
function ambiguousDates(dateText: string | null, sourceOffsetMinutes: number | null): QuotedDate[]
{
    const m = dateText === null ? null : SWAPPABLE.exec(dateText);
    if (m === null)
    {
        return [];
    }
    const [, a, , b, year, rest] = m as unknown as [string, string, string, string, string, string];
    const out: QuotedDate[] = [];
    for (const text of [`${year}-${b}-${a}${rest}`, `${year}-${a}-${b}${rest}`])
    {
        const d = parseQuotedDate(text, sourceOffsetMinutes);
        const ms = d.estimatedUtcMs;
        if (ms !== null && Number.isFinite(ms) && !out.some((x) => x.estimatedUtcMs === ms))
        {
            out.push(d);
        }
    }
    return out;
}

/**
 * The possible moments of an AMBIGUOUS numeric date: "04/03/2025 05:21" is
 * unreadable for quoted-date.ts (4 March or 3 April?), so it never places a
 * message. For MATCHING only (file comment, 1b), both readings are tried,
 * each read by parseQuotedDate in year-first form ("2025-03-04 05:21",
 * "2025-04-03 05:21"); the date agrees when one of them agrees (never
 * better than 'strict'). [] for any other text.
 */
export function ambiguousReadings(dateText: string | null, sourceOffsetMinutes: number | null): number[]
{
    return ambiguousDates(dateText, sourceOffsetMinutes).map((d) => d.estimatedUtcMs as number);
}

/**
 * Whether an unreadable date text is precise enough to merge two copies by
 * the text alone (file comment, 2): a 4-digit year and a day number (a 1-
 * or 2-digit number outside a time of day).
 */
export function datedText(text: string): boolean
{
    const noTime = text.replace(/\d{1,2}[:.h]\d{2}(?:[:.]\d{2})?/giu, ' ');
    return /(?<!\d)\d{4}(?!\d)/u.test(noTime) && /(?<!\d)\d{1,2}(?!\d)/u.test(noTime);
}

/** The estimate of a readable date, or null. */
function estimateOf(r: ReconstructedMessage): number | null
{
    const ms = r.date?.estimatedUtcMs;
    return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
}

/** Known fields, for the best-copy order. */
function completeness(it: Item): number
{
    const r = it.r;
    return (
        (it.key !== null ? 1 : 0) +
        (r.to.length > 0 ? 1 : 0) +
        (r.subject !== null ? 1 : 0) +
        (it.est !== null ? 1 : 0) +
        (it.est !== null && !r.dateApproximate ? 1 : 0)
    );
}

/** Index of the first entry of `list` (sorted by `at`) with at >= `value`. */
function lowerBound<T>(list: readonly T[], value: number, at: (t: T) => number): number
{
    let lo = 0;
    let hi = list.length;
    while (lo < hi)
    {
        const mid = (lo + hi) >> 1;
        if (at(list[mid] as T) < value)
        {
            lo = mid + 1;
        }
        else
        {
            hi = mid;
        }
    }
    return lo;
}


/** Links the rebuilt messages and builds the timeline (see the file comment). */
export function linkRebuilt(sources: readonly LinkSource[]): RebuildLinks
{
    const offsetOf = (pos: number): number | null =>
    {
        const o = (sources[pos] as LinkSource).message.date.offsetMinutes;
        return typeof o === 'number' && Number.isFinite(o) ? o : null;
    };
    // Every rebuilt message, by source position, then newest first.
    const items: Item[] = [];
    const bySource: Item[][] = sources.map((s, pos) =>
        s.rebuilt.map((r) =>
        {
            const zoneMinutes = r.date?.basis === 'source-offset' ? (offsetOf(pos) ?? 0) : 0;
            const it: Item = { id: items.length, pos, r, key: rebuiltSenderKey(r), est: estimateOf(r), zoneMinutes, words: null, realPos: null, match: null, groupOf: null };
            items.push(it);
            return it;
        }),
    );
    const wordsOfItem = (it: Item): Compared => (it.words ??= compared(comparableText(it.r), nameWordsOf(it.r.from)));
    const ownWords: (Compared | null)[] = sources.map(() => null);
    const ownWordsOf = (pos: number): Compared =>
    {
        let w = ownWords[pos];
        if (w === null || w === undefined)
        {
            const s = sources[pos] as LinkSource;
            w = compared(s.message.bodyText.slice(0, s.ownEnd), nameWordsOf(s.message.from));
            ownWords[pos] = w;
        }
        return w;
    };

    // 1. The real file wins.
    const realByKey = new Map<string, { readonly pos: number; readonly utc: number }[]>();
    sources.forEach((s, pos) =>
    {
        if (s.utcMs === null)
        {
            return;
        }
        for (const k of realSenderKeys(s.message))
        {
            let list = realByKey.get(k);
            if (list === undefined)
            {
                realByKey.set(k, (list = []));
            }
            list.push({ pos, utc: s.utcMs });
        }
    });
    for (const list of realByKey.values())
    {
        list.sort((a, b) => a.utc - b.utc || a.pos - b.pos);
    }

    for (const it of items)
    {
        if (it.key === null)
        {
            continue;
        }
        const list = realByKey.get(it.key);
        if (list === undefined)
        {
            continue;
        }
        const addressed = it.key.startsWith('a:');
        const ambiguous = it.est === null;
        const dates: QuotedDate[] = ambiguous ? ambiguousDates(it.r.dateText, offsetOf(it.pos)) : [it.r.date as QuotedDate];
        // Real position -> the closest reading that agrees, with its level.
        const nearest = new Map<number, { diff: number; level: DateAgreement }>();
        for (const date of dates)
        {
            const est = date.estimatedUtcMs as number;
            const approximate = ambiguous ? !hasWrittenZone(date) : it.r.dateApproximate;
            // The zone the estimate assumed (S, file comment 1b): known only for basis 'source-offset'.
            const sourceOffset = date.basis === 'source-offset' ? offsetOf(it.pos) : null;
            for (let i = lowerBound(list, est - MATCH_WINDOW_MS, (e) => e.utc); i < list.length; i++)
            {
                const e = list[i] as { pos: number; utc: number };
                if (e.utc > est + MATCH_WINDOW_MS)
                {
                    break;
                }
                if (e.pos === it.pos)
                {
                    continue;
                }
                const diff = e.utc - est;
                const realOffset = offsetOf(e.pos);
                const senderDiff = realOffset === null || sourceOffset === null ? null : (sourceOffset - realOffset) * MINUTE_MS;
                let level = realDateAgreement(date, approximate, diff, sourceOffset === null ? null : sourceOffset * MINUTE_MS, senderDiff);
                if (level === null)
                {
                    continue;
                }
                if (ambiguous || (!addressed && (level === 'exact' || level === 'strong')))
                {
                    level = ambiguous ? 'strict' : 'zone';
                }
                const old = nearest.get(e.pos);
                if (old === undefined || Math.abs(diff) < Math.abs(old.diff))
                {
                    nearest.set(e.pos, { diff, level });
                }
            }
        }
        const near = [...nearest].map(([pos, v]) => ({ pos, ...v }));
        near.sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff) || a.pos - b.pos);
        let best: { pos: number; match: RealMatch } | null = null;
        for (const c of near.slice(0, MAX_CANDIDATES))
        {
            const agreed = textAgreement(wordsOfItem(it), ownWordsOf(c.pos), REAL_RULES[c.level]);
            if (agreed === null)
            {
                continue;
            }
            const better =
                best === null ||
                agreed.fwd > best.match.coverage ||
                (agreed.fwd === best.match.coverage && Math.abs(c.diff) < Math.abs(best.match.dateDiffMs));
            if (better)
            {
                const strong = c.level === 'exact' || c.level === 'strong';
                best = { pos: c.pos, match: { coverage: agreed.fwd, reverseCoverage: agreed.rev, dateDiffMs: c.diff, strong, ambiguousDate: ambiguous } };
            }
        }
        if (best !== null)
        {
            it.realPos = best.pos;
            it.match = best.match;
        }
    }

    // 2. Rebuilt vs rebuilt, in best-copy order.
    const unmatched = items.filter((it) => it.realPos === null);
    unmatched.sort(
        (a, b) =>
            a.r.incomplete.length - b.r.incomplete.length ||
            completeness(b) - completeness(a) ||
            a.r.generation - b.r.generation ||
            a.pos - b.pos ||
            a.id - b.id,
    );
    const copyDate = (it: Item): CopyDate => ({ precision: (it.r.date as QuotedDate).precision, approximate: it.r.dateApproximate, zoneMinutes: it.zoneMinutes });
    const sourceTime = (it: Item): number | null =>
    {
        const t = (sources[it.pos] as LinkSource).message.date.utcMs;
        return typeof t === 'number' && Number.isFinite(t) ? t : null;
    };
    const entriesByKey = new Map<string, Item[]>();
    // Entries without a readable date, by sender key and date text as written.
    const undatedEntries = new Map<string, Item[]>();
    const undatedKey = (it: Item): string | null =>
    {
        const text = it.r.dateText?.replace(/\s+/gu, ' ').trim() ?? '';
        return it.key === null || it.est !== null || !datedText(text) || sourceTime(it) === null ? null : JSON.stringify([it.key, text]);
    };
    const groupSources = new Map<number, Set<number>>();
    const members = new Map<number, number[]>();
    for (const it of unmatched)
    {
        let best: { entry: Item; score: number; diff: number } | null = null;
        const consider = (e: Item, diff: number, level: DateAgreement): void =>
        {
            const agreed = textAgreement(wordsOfItem(it), wordsOfItem(e), COPY_RULES[level]);
            if (agreed === null)
            {
                return;
            }
            const score = Math.min(agreed.fwd, agreed.rev);
            if (best === null || score > best.score || (score === best.score && Math.abs(diff) < Math.abs(best.diff)))
            {
                best = { entry: e, score, diff };
            }
        };
        if (it.key !== null && it.est !== null)
        {
            const est = it.est;
            const addressed = it.key.startsWith('a:');
            // Entries of this sender, sorted by date: only those within the window are read.
            const list = entriesByKey.get(it.key) ?? [];
            const inWindow: Item[] = [];
            for (let i = lowerBound(list, est - MATCH_WINDOW_MS, (e) => e.est as number); i < list.length; i++)
            {
                const e = list[i] as Item;
                if ((e.est as number) > est + MATCH_WINDOW_MS)
                {
                    break;
                }
                if (!(groupSources.get(e.id) as Set<number>).has(it.pos))
                {
                    inWindow.push(e);
                }
            }
            const near = inWindow
                .sort((a, b) => Math.abs((a.est as number) - est) - Math.abs((b.est as number) - est) || a.id - b.id)
                .slice(0, MAX_CANDIDATES);
            for (const e of near)
            {
                const diff = (e.est as number) - est;
                let level = copyDateAgreement(copyDate(it), copyDate(e), diff);
                if (level === null)
                {
                    continue;
                }
                if (!addressed && level === 'exact')
                {
                    level = 'zone';
                }
                consider(e, diff, level);
            }
        }
        const uk = undatedKey(it);
        if (uk !== null)
        {
            // No readable date: only a copy with the very same (precise) date text, sources within 26 h.
            const t = sourceTime(it) as number;
            const same = (undatedEntries.get(uk) ?? []).filter(
                (x) => !(groupSources.get(x.id) as Set<number>).has(it.pos) && Math.abs((sourceTime(x) as number) - t) <= MATCH_WINDOW_MS,
            );
            for (const e of same.slice(0, MAX_CANDIDATES))
            {
                consider(e, 0, 'strict');
            }
        }
        const chosen = best as { entry: Item } | null;
        if (chosen !== null)
        {
            it.groupOf = chosen.entry.id;
            (groupSources.get(chosen.entry.id) as Set<number>).add(it.pos);
            (members.get(chosen.entry.id) as number[]).push(it.id);
        }
        else
        {
            it.groupOf = it.id;
            groupSources.set(it.id, new Set([it.pos]));
            members.set(it.id, []);
            if (it.key !== null && it.est !== null)
            {
                let list = entriesByKey.get(it.key);
                if (list === undefined)
                {
                    entriesByKey.set(it.key, (list = []));
                }
                // Kept sorted by date (then id), for the window search above.
                const est = it.est;
                const id = it.id;
                let at = lowerBound(list, est, (e) => e.est as number);
                while (at < list.length && (list[at] as Item).est === est && (list[at] as Item).id < id)
                {
                    at++;
                }
                list.splice(at, 0, it);
            }
            if (uk !== null)
            {
                let list = undatedEntries.get(uk);
                if (list === undefined)
                {
                    undatedEntries.set(uk, (list = []));
                }
                list.push(it);
            }
        }
    }
    const isEntry = (it: Item): boolean => it.realPos === null && it.groupOf === it.id;

    // 3. Time keys and anchors along each chain.
    // A key is (time, side): side -1 = just before a real message at that
    // time (capped by its quoter), +1 = just after it (raised to the message
    // it quotes), 0 = by its own date (before a real message at the same time).
    const keyOf = new Map<number, { key: number; side: number; placement: RebuiltPlacement }>();
    const anchorOf = new Map<number, string>(); // id -> 'm<pos>' or 'r<id>'
    const realTime = (it: Item): number | null => (it.realPos === null ? null : (sources[it.realPos] as LinkSource).utcMs);
    bySource.forEach((chain, pos) =>
    {
        // Real times bound each rebuilt message: no later than the newer real
        // messages of its chain (the source, matched ones), no earlier than the
        // older matched ones. The newer bound wins if they disagree.
        const upper: (number | null)[] = [];
        let u = (sources[pos] as LinkSource).utcMs;
        for (const it of chain)
        {
            upper.push(u);
            const t = realTime(it);
            if (t !== null)
            {
                u = u === null ? t : Math.min(u, t);
            }
        }
        const lower: (number | null)[] = chain.map(() => null);
        let l: number | null = null;
        for (let k = chain.length - 1; k >= 0; k--)
        {
            lower[k] = l;
            const t = realTime(chain[k] as Item);
            if (t !== null)
            {
                l = l === null ? t : Math.max(l, t);
            }
        }
        // Clamp, then keep the chain order: never after the newer rebuilt message.
        let prev: { key: number; side: number } | null = null;
        chain.forEach((it, k) =>
        {
            if (it.realPos !== null || it.est === null)
            {
                return;
            }
            const lo = lower[k] ?? null;
            const hi = upper[k] ?? null;
            let key = it.est;
            let side = 0;
            if (lo !== null && key < lo)
            {
                key = lo;
                side = 1;
            }
            if (hi !== null && key > hi)
            {
                key = hi;
                side = -1;
            }
            if (prev !== null && (key > prev.key || (key === prev.key && side > prev.side)))
            {
                key = prev.key;
                side = prev.side;
            }
            const placement: RebuiltPlacement = key < it.est ? 'capped-by-quoter' : key > it.est ? 'after-quoted' : 'by-date';
            keyOf.set(it.id, { key, side, placement });
            prev = { key, side };
        });
        chain.forEach((it, k) =>
        {
            if (it.realPos !== null || it.est !== null)
            {
                return;
            }
            let anchor = `m${pos}`;
            for (let j = k - 1; j >= 0; j--)
            {
                const q = chain[j] as Item;
                if (q.realPos !== null)
                {
                    anchor = `m${q.realPos}`;
                    break;
                }
                if (isEntry(q))
                {
                    anchor = `r${q.id}`;
                    break;
                }
            }
            anchorOf.set(it.id, anchor);
        });
    });

    // Keyed entries merged into the dated real messages.
    const keyed = items.filter((it) => isEntry(it) && keyOf.has(it.id));
    const keyFor = (it: Item): number => (keyOf.get(it.id) as { key: number }).key;
    const sideFor = (it: Item): number => (keyOf.get(it.id) as { side: number }).side;
    keyed.sort((a, b) => keyFor(a) - keyFor(b) || sideFor(a) - sideFor(b) || b.r.generation - a.r.generation || a.pos - b.pos || a.id - b.id);
    // Before a real message at time t: an earlier key, or the same time unless placed just after (side +1).
    const before = (it: Item, t: number): boolean => keyFor(it) < t || (keyFor(it) === t && sideFor(it) <= 0);
    const base: string[] = [];
    let j = 0;
    sources.forEach((s, pos) =>
    {
        if (s.utcMs !== null)
        {
            while (j < keyed.length && before(keyed[j] as Item, s.utcMs))
            {
                base.push(`r${(keyed[j++] as Item).id}`);
            }
        }
        else
        {
            while (j < keyed.length)
            {
                base.push(`r${(keyed[j++] as Item).id}`);
            }
        }
        base.push(`m${pos}`);
    });
    while (j < keyed.length)
    {
        base.push(`r${(keyed[j++] as Item).id}`);
    }

    // Undated entries just before their anchor, older first.
    const children = new Map<string, Item[]>();
    for (const it of items)
    {
        const anchor = anchorOf.get(it.id);
        if (anchor === undefined || !isEntry(it))
        {
            continue;
        }
        let list = children.get(anchor);
        if (list === undefined)
        {
            children.set(anchor, (list = []));
        }
        list.push(it);
    }
    for (const list of children.values())
    {
        list.sort((a, b) => b.r.generation - a.r.generation || a.pos - b.pos || a.id - b.id);
    }

    const timeline: TimelineEntry[] = [];
    const emit = (ref: string): void =>
    {
        for (const child of children.get(ref) ?? [])
        {
            emit(`r${child.id}`);
        }
        if (ref.startsWith('m'))
        {
            timeline.push({ kind: 'message', position: Number(ref.slice(1)) });
        }
        else
        {
            const id = Number(ref.slice(1));
            timeline.push({ kind: 'rebuilt', id, placement: keyOf.get(id)?.placement ?? 'before-quoter' });
        }
    };
    for (const ref of base)
    {
        emit(ref);
    }

    const reconstructed: EngineRebuilt[] = items.map((it) =>
    {
        const source = sources[it.pos] as LinkSource;
        if (it.realPos !== null)
        {
            return { id: it.id, sourceIndex: source.index, rebuilt: it.r, link: 'real', realIndex: (sources[it.realPos] as LinkSource).index, match: it.match, sameAs: null, copies: [], alsoQuotedIn: [] };
        }
        if (it.groupOf !== it.id)
        {
            return { id: it.id, sourceIndex: source.index, rebuilt: it.r, link: 'same-as', realIndex: null, match: null, sameAs: it.groupOf, copies: [], alsoQuotedIn: [] };
        }
        const copies = [...(members.get(it.id) ?? [])].sort((a, b) => a - b);
        const also = [...new Set(copies.map((c) => (sources[(items[c] as Item).pos] as LinkSource).index))].sort((a, b) => a - b);
        return { id: it.id, sourceIndex: source.index, rebuilt: it.r, link: 'entry', realIndex: null, match: null, sameAs: null, copies, alsoQuotedIn: also };
    });
    return { reconstructed, timeline };
}
