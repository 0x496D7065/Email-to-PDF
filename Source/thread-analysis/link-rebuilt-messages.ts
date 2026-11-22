// Links the messages rebuilt from quoted text (reconstruct-quoted-messages.ts) to the real
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
//    EMPTY COPIES (task 9.9b-4). A rebuilt message with NO text (its text
//    is white space only: a header with nothing under it, such as an empty
//    forward block) has no words, so the text rule above never links it,
//    and the same empty header quoted in four dropped emails gave four
//    entries. Such a message is linked by its header alone (emptyHeaderKey)
//    to an earlier empty entry of a DIFFERENT dropped email (as above, never
//    two of one email), when ALL of these are known and equal:
//    - the sender: exactly one From mailbox WITH an address (sender key
//      'a:', as above; a name alone is not enough);
//    - the date and time: a readable date with minutes, the same wall-clock
//      time as written (QuotedDate.wallMs) AND the same estimated moment
//      (so the same zone assumed), and both exact or both approximate. No
//      zone allowance: a time read in another zone, or a date without
//      minutes, is no link;
//    - the subject (white space squashed, NFC, letter case kept), and taken
//      from the chain on both or on neither (subjectFromChain: an
//      attribution borrows it, so it is only compared with another
//      borrowed one);
//    - the To and the Cc lists, as sets of mailbox keys (address, else
//      name), with no list read short (`incomplete`). An empty email IS its
//      header: a copy with other recipients says something the entry does
//      not, so it stays an entry of its own. Two attributions (no To / Cc
//      at all) agree here.
//    Anything missing or unsure: no link (a visible repeat). Why this is
//    safe (brief section 8.2, only provably identical messages are merged):
//    the two copies show the very same header facts and no text at all, so
//    the link hides no word, and no fact beyond how names and the date
//    are written (addresses and the instant are compared, not their
//    wording); each copy's own header stays in its email. A
//    rebuilt message WITH text never takes this path: it is linked by the
//    text rule above only, and an empty message never joins one with text
//    (no words, no link), nor one with text an empty one.
// 3. Timeline (TimelineEntry). Real messages keep their order (the order of
//    ThreadAnalysisResult.messages, dated first, then undated by file order). Each
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
import type { AnalyzedRebuiltMessage, QuotedDate, RealMatch, RebuiltPlacement, ReconstructedMessage,
    TimelineEntry } from '../../Header/rebuilt-emails';

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

/** One kept real message, in ThreadAnalysisResult.messages order. */
export interface LinkSource
{
    /** Input position (AnalyzedMessage.index). */
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
    readonly reconstructed: AnalyzedRebuiltMessage[];
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

function shingles(words: Words, size: number): ReadonlySet<string>
{
    let set = words.sets.get(size);
    if (set === undefined)
    {
        const created = new Set<string>();
        const tokens = words.tokens;
        for (let i = 0; i + size <= tokens.length; i++)
        {
            let shingle = tokens[i] as string;
            for (let j = 1; j < size; j++)
            {
                shingle += ` ${tokens[i + j] as string}`;
            }
            created.add(shingle);
        }
        words.sets.set(size, created);
        set = created;
    }
    return set;
}

/** Number of distinct shingles of SHINGLE_WORDS words (0 for a text shorter than that). */
export function distinctShingles(words: Words): number
{
    return shingles(words, SHINGLE_WORDS).size;
}

const joinedCache = new WeakMap<Words, string>();

/**
 * The words joined by single spaces, with a space before and after. A word
 * never holds a space, so " a b " is found in " x a b y " only as the whole
 * words a, b in this order (never as a part of a word).
 */
function joined(words: Words): string
{
    let joinedText = joinedCache.get(words);
    if (joinedText === undefined)
    {
        joinedText = ` ${words.tokens.join(' ')} `;
        joinedCache.set(words, joinedText);
    }
    return joinedText;
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
function vetoWord(word: string): boolean
{
    return VETO_WORDS.has(word) || VETO_PREFIXES.some((p) => word.startsWith(p));
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
    const trimmed = line.trim().normalize('NFC');
    if (trimmed === '' || trimmed.length > MAX_SIGNATURE_LINE_LENGTH || /[?!;\u00bf\u00a1]/u.test(trimmed))
    {
        return false;
    }
    const colon = trimmed.indexOf(':');
    const label = colon < 0 ? [] : (trimmed.slice(0, colon).match(WORD) ?? []);
    if (label.length > 2 || label.some((w) => vetoWord(w.toLowerCase())))
    {
        return false;
    }
    const rest = (colon < 0 ? trimmed : trimmed.slice(colon + 1)).replace(/\S+@\S+/gu, ' ').replace(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/giu, ' ');
    const words = rest.match(WORD) ?? [];
    if (words.length > MAX_SIGNATURE_LINE_WORDS)
    {
        return false;
    }
    return words.every((word) =>
    {
        const lower = word.toLowerCase();
        if (vetoWord(lower))
        {
            return false;
        }
        return !/^\p{Ll}/u.test(word) || CONNECTORS.has(lower);
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
    let text = line.trim().normalize('NFC');
    let labelled = false;
    const label = /^([\p{L}][\p{L}-]*)\.?\s*:?\s*/u.exec(text);
    if (label && MARKER_LABELS.has((label[1] as string).toLowerCase()) && label[0].length < text.length)
    {
        text = text.slice(label[0].length);
        labelled = true;
    }
    if (/^<?[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+>?$/u.test(text))
    {
        return true;
    }
    if (/^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+$/iu.test(text))
    {
        return true;
    }
    if (!/^\+?\(?\d[\d .()-]*\d\)?$/u.test(text))
    {
        return false;
    }
    if (/^\d{1,4}[.-]\d{1,2}[.-]\d{1,4}$/u.test(text))
    {
        return false;
    }
    if ((text.match(/\d/gu) ?? []).length < 6)
    {
        return false;
    }
    return labelled || /^[+(0]/u.test(text);
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
    let lineStart = 0;
    for (const raw of text.split('\n'))
    {
        lines.push({ start: lineStart, text: raw });
        lineStart += raw.length + 1;
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
    const signatureAt = signatureStart(text, senderWords);
    return { full: wordsOf(text), core: signatureAt === null ? null : wordsOf(text.slice(0, signatureAt)) };
}

/** The words of display names, for signatureStart. */
export function nameWordsOf(mailboxes: readonly Pick<EmailAddress, 'name'>[]): Set<string>
{
    const out = new Set<string>();
    for (const mailbox of mailboxes)
    {
        for (const word of wordsOf(mailbox.name).tokens)
        {
            out.add(word);
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
    const aWordCount = a.full.tokens.length;
    const bWordCount = b.full.tokens.length;
    if (aWordCount === 0 || bWordCount === 0)
    {
        return null;
    }
    if (sameWords(a.full, b.full))
    {
        return { a: 1, b: 1, words: a.full };
    }
    if (a.core !== null && a.core.tokens.length > 0 && sameWords(a.core, b.full))
    {
        return { a: a.core.tokens.length / aWordCount, b: 1, words: a.core };
    }
    if (b.core !== null && b.core.tokens.length > 0 && sameWords(a.full, b.core))
    {
        return { a: 1, b: b.core.tokens.length / bWordCount, words: b.core };
    }
    return null;
}

const DIGITS = /\p{N}+/gu;
const digitCache = new WeakMap<Words, string>();

/** The digit runs of a text in text order, as one string (file comment, 1d). */
export function digitsOf(words: Words): string
{
    let digits = digitCache.get(words);
    if (digits === undefined)
    {
        const runs: string[] = [];
        for (const token of words.tokens)
        {
            for (const run of token.match(DIGITS) ?? [])
            {
                runs.push(run);
            }
        }
        digits = runs.join(' ');
        digitCache.set(words, digits);
    }
    return digits;
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
function textAgreement(a: Compared, b: Compared, rule: TextRule): { forward: number; reverse: number } | null
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
    const aDigits = digitsOf(shares.a === 1 ? a.full : (a.core as Words));
    const bDigits = digitsOf(shares.b === 1 ? b.full : (b.core as Words));
    if (aDigits !== bDigits)
    {
        return null;
    }
    return { forward: shares.a, reverse: shares.b };
}

// ---------------------------------------------------------------- people and dates

function normalName(name: string): string
{
    return name.normalize('NFC').toLowerCase().replace(/^["'\s]+|["'\s]+$/gu, '').replace(/\s+/gu, ' ');
}

/** 'a:' + address, or 'n:' + name when there is no address; null when empty. */
function mailboxKey(mailbox: EmailAddress, useName: boolean): string | null
{
    const address = mailbox.address.trim().toLowerCase();
    if (!useName)
    {
        return address === '' ? null : `a:${address}`;
    }
    const name = normalName(mailbox.name);
    return name === '' ? null : `n:${name}`;
}

/** The rebuilt message's sender key (file comment, 1a); null without exactly one From mailbox. */
export function rebuiltSenderKey(rebuilt: Pick<ReconstructedMessage, 'from'>): string | null
{
    if (rebuilt.from.length !== 1)
    {
        return null;
    }
    const mailbox = rebuilt.from[0] as EmailAddress;
    return mailboxKey(mailbox, false) ?? mailboxKey(mailbox, true);
}

/** Every key a real message's From mailboxes answer to (address keys and name keys). */
export function realSenderKeys(message: Pick<NormalizedMessage, 'from'>): string[]
{
    const keys = new Set<string>();
    for (const mailbox of message.from)
    {
        for (const useName of [false, true])
        {
            const key = mailboxKey(mailbox, useName);
            if (key !== null)
            {
                keys.add(key);
            }
        }
    }
    return [...keys];
}

const MINUTE_MS = 60_000;

/** Distance of |diff| to the nearest whole number of ZONE_STEP_MS. */
function offGrid(diffMs: number): number
{
    const remainder = Math.abs(diffMs) % ZONE_STEP_MS;
    return Math.min(remainder, ZONE_STEP_MS - remainder);
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
    const shiftA = a.zoneMinutes * MINUTE_MS;
    const shiftB = b.zoneMinutes * MINUTE_MS;
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
        const allowanceA = spanB === 0 ? spanA : 0;
        const allowanceB = spanA === 0 ? spanB : 0;
        if (within(diffMs, -allowanceB, allowanceA, ZONE_SLACK_MS))
        {
            return minutes ? 'exact' : 'strict';
        }
        if (within(diffMs, shiftA - shiftB - allowanceB, shiftA - shiftB + allowanceA, ZONE_SLACK_MS))
        {
            return minutes ? 'zone' : 'strict';
        }
        return null;
    }
    // One exact (its W is its S: no shift), one approximate with W in [-12 h, +14 h].
    const lo = a.approximate ? shiftA - MAX_EAST_MS : -(shiftB + MAX_WEST_MS);
    const hi = a.approximate ? shiftA + MAX_WEST_MS : -(shiftB - MAX_EAST_MS);
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
    readonly rebuilt: ReconstructedMessage;
    readonly key: string | null;
    readonly estimate: number | null;
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
    const normalized = line.replace(/\s+/gu, ' ').trim().normalize('NFC');
    if (normalized === '')
    {
        return false;
    }
    const label = LABEL_PATTERN.exec(normalized.slice(0, LABEL_HEAD_LENGTH))?.[1];
    if (label !== undefined && LABEL_ROLE_OF.has(labelKey(label)))
    {
        return true;
    }
    // A mailbox list goes on with ";" (Outlook) or with addresses.
    if (!/[;@]/u.test(normalized))
    {
        return false;
    }
    const items = normalized
        .split(/[;,]/u)
        .map((x) => x.trim())
        .filter((x) => x !== '');
    return (
        items.length > 0 &&
        items.every((part) =>
        {
            if (/^[^<>@]*<[^<>\s]*@[^\s]*>$/u.test(part) || /^(?:mailto:)?[^\s<>@]+@[^\s<>@]+$/iu.test(part))
            {
                return true;
            }
            const name = part.replace(/"/gu, '').trim();
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
export function comparableText(rebuilt: Pick<ReconstructedMessage, 'incomplete' | 'reconstructedText' | 'to' | 'cc'>): string
{
    const text = rebuilt.reconstructedText;
    if (rebuilt.incomplete.length === 0)
    {
        return text;
    }
    if (rebuilt.incomplete.some((role) => (role === 'to' ? rebuilt.to : rebuilt.cc).length === 0))
    {
        return text;
    }
    const line = /[^\n]*(?:\n|$)/gu;
    let skipped = 0;
    for (let at = 0; at < text.length; )
    {
        line.lastIndex = at;
        const match = line.exec(text) as RegExpExecArray;
        const next = at + match[0].length;
        if (match[0].trim() === '')
        {
            return skipped === 0 ? text : text.slice(next);
        }
        if (!leftoverLine(match[0]))
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
    const match = dateText === null ? null : SWAPPABLE.exec(dateText);
    if (match === null)
    {
        return [];
    }
    const [, firstNumber, , secondNumber, year, rest] = match as unknown as [string, string, string, string, string, string];
    const out: QuotedDate[] = [];
    for (const text of [`${year}-${secondNumber}-${firstNumber}${rest}`, `${year}-${firstNumber}-${secondNumber}${rest}`])
    {
        const reading = parseQuotedDate(text, sourceOffsetMinutes);
        const ms = reading.estimatedUtcMs;
        if (ms !== null && Number.isFinite(ms) && !out.some((x) => x.estimatedUtcMs === ms))
        {
            out.push(reading);
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
function estimateOf(rebuilt: ReconstructedMessage): number | null
{
    const ms = rebuilt.date?.estimatedUtcMs;
    return typeof ms === 'number' && Number.isFinite(ms) ? ms : null;
}

/**
 * The header facts that link an EMPTY rebuilt message to an empty copy (file comment, 2, EMPTY
 * COPIES), as one string; null when the message has text, or any fact is missing or unsure.
 */
export function emptyHeaderKey(rebuilt: ReconstructedMessage): string | null
{
    if (!/^\s*$/u.test(rebuilt.reconstructedText) || rebuilt.incomplete.length !== 0)
    {
        return null;
    }
    const sender = rebuiltSenderKey(rebuilt);
    const date = rebuilt.date;
    const wallMs = date?.wallMs;
    const estimate = date?.estimatedUtcMs;
    if (sender === null || !sender.startsWith('a:') || date === null || date.precision !== 'minute'
        || typeof wallMs !== 'number' || !Number.isFinite(wallMs) || typeof estimate !== 'number' || !Number.isFinite(estimate))
    {
        return null;
    }
    const subject = rebuilt.subject?.normalize('NFC').replace(/\s+/gu, ' ').trim() ?? '';
    if (subject === '')
    {
        return null;
    }
    // Each mailbox by its address, else its name; a mailbox with neither makes the list unsure.
    const listKeys = (list: readonly EmailAddress[]): string[] | null =>
    {
        const keys = list.map((mailbox) => mailboxKey(mailbox, false) ?? mailboxKey(mailbox, true));
        return keys.some((key) => key === null) ? null : [...new Set(keys as string[])].sort();
    };
    const to = listKeys(rebuilt.to);
    const cc = listKeys(rebuilt.cc);
    if (to === null || cc === null)
    {
        return null;
    }
    return JSON.stringify([sender, wallMs, estimate, rebuilt.dateApproximate, subject, rebuilt.subjectFromChain, to, cc]);
}

/** Known fields, for the best-copy order. */
function completeness(item: Item): number
{
    const rebuilt = item.rebuilt;
    return (
        (item.key !== null ? 1 : 0) +
        (rebuilt.to.length > 0 ? 1 : 0) +
        // A subject taken from the chain (an attribution) is not a field of this copy.
        (rebuilt.subject !== null && !rebuilt.subjectFromChain ? 1 : 0) +
        (item.estimate !== null ? 1 : 0) +
        (item.estimate !== null && !rebuilt.dateApproximate ? 1 : 0)
    );
}

/** Index of the first entry of `list` (sorted by `sortKey`) with sortKey >= `value`. */
function lowerBound<T>(list: readonly T[], value: number, sortKey: (entry: T) => number): number
{
    let lo = 0;
    let hi = list.length;
    while (lo < hi)
    {
        const mid = (lo + hi) >> 1;
        if (sortKey(list[mid] as T) < value)
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
        const offset = (sources[pos] as LinkSource).message.date.offsetMinutes;
        return typeof offset === 'number' && Number.isFinite(offset) ? offset : null;
    };
    // Every rebuilt message, by source position, then newest first.
    const items: Item[] = [];
    const bySource: Item[][] = sources.map((source, pos) =>
        source.rebuilt.map((rebuilt) =>
        {
            const zoneMinutes = rebuilt.date?.basis === 'source-offset' ? (offsetOf(pos) ?? 0) : 0;
            const item: Item = { id: items.length, pos, rebuilt, key: rebuiltSenderKey(rebuilt), estimate: estimateOf(rebuilt), zoneMinutes, words: null, realPos: null, match: null, groupOf: null };
            items.push(item);
            return item;
        }),
    );
    const wordsOfItem = (item: Item): Compared => (item.words ??= compared(comparableText(item.rebuilt), nameWordsOf(item.rebuilt.from)));
    const ownWords: (Compared | null)[] = sources.map(() => null);
    const ownWordsOf = (pos: number): Compared =>
    {
        let words = ownWords[pos];
        if (words === null || words === undefined)
        {
            const source = sources[pos] as LinkSource;
            words = compared(source.message.bodyText.slice(0, source.ownEnd), nameWordsOf(source.message.from));
            ownWords[pos] = words;
        }
        return words;
    };

    // 1. The real file wins.
    const realByKey = new Map<string, { readonly pos: number; readonly utc: number }[]>();
    sources.forEach((source, pos) =>
    {
        if (source.utcMs === null)
        {
            return;
        }
        for (const key of realSenderKeys(source.message))
        {
            let list = realByKey.get(key);
            if (list === undefined)
            {
                realByKey.set(key, (list = []));
            }
            list.push({ pos, utc: source.utcMs });
        }
    });
    for (const list of realByKey.values())
    {
        list.sort((a, b) => a.utc - b.utc || a.pos - b.pos);
    }

    for (const item of items)
    {
        if (item.key === null)
        {
            continue;
        }
        const list = realByKey.get(item.key);
        if (list === undefined)
        {
            continue;
        }
        const addressed = item.key.startsWith('a:');
        const ambiguous = item.estimate === null;
        const dates: QuotedDate[] = ambiguous ? ambiguousDates(item.rebuilt.dateText, offsetOf(item.pos)) : [item.rebuilt.date as QuotedDate];
        // Real position -> the closest reading that agrees, with its level.
        const nearest = new Map<number, { diff: number; level: DateAgreement }>();
        for (const date of dates)
        {
            const estimate = date.estimatedUtcMs as number;
            const approximate = ambiguous ? !hasWrittenZone(date) : item.rebuilt.dateApproximate;
            // The zone the estimate assumed (S, file comment 1b): known only for basis 'source-offset'.
            const sourceOffset = date.basis === 'source-offset' ? offsetOf(item.pos) : null;
            for (let i = lowerBound(list, estimate - MATCH_WINDOW_MS, (e) => e.utc); i < list.length; i++)
            {
                const real = list[i] as { pos: number; utc: number };
                if (real.utc > estimate + MATCH_WINDOW_MS)
                {
                    break;
                }
                if (real.pos === item.pos)
                {
                    continue;
                }
                const diff = real.utc - estimate;
                const realOffset = offsetOf(real.pos);
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
                const previous = nearest.get(real.pos);
                if (previous === undefined || Math.abs(diff) < Math.abs(previous.diff))
                {
                    nearest.set(real.pos, { diff, level });
                }
            }
        }
        const near = [...nearest].map(([pos, v]) => ({ pos, ...v }));
        near.sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff) || a.pos - b.pos);
        let best: { pos: number; match: RealMatch } | null = null;
        for (const candidate of near.slice(0, MAX_CANDIDATES))
        {
            const agreed = textAgreement(wordsOfItem(item), ownWordsOf(candidate.pos), REAL_RULES[candidate.level]);
            if (agreed === null)
            {
                continue;
            }
            const better =
                best === null ||
                agreed.forward > best.match.coverage ||
                (agreed.forward === best.match.coverage && Math.abs(candidate.diff) < Math.abs(best.match.dateDiffMs));
            if (better)
            {
                const strong = candidate.level === 'exact' || candidate.level === 'strong';
                best = { pos: candidate.pos, match: { coverage: agreed.forward, reverseCoverage: agreed.reverse, dateDiffMs: candidate.diff, strong, ambiguousDate: ambiguous } };
            }
        }
        if (best !== null)
        {
            item.realPos = best.pos;
            item.match = best.match;
        }
    }

    // 2. Rebuilt vs rebuilt, in best-copy order.
    const unmatched = items.filter((item) => item.realPos === null);
    unmatched.sort(
        (a, b) =>
            a.rebuilt.incomplete.length - b.rebuilt.incomplete.length ||
            completeness(b) - completeness(a) ||
            a.rebuilt.generation - b.rebuilt.generation ||
            a.pos - b.pos ||
            a.id - b.id,
    );
    const copyDate = (item: Item): CopyDate => ({ precision: (item.rebuilt.date as QuotedDate).precision, approximate: item.rebuilt.dateApproximate, zoneMinutes: item.zoneMinutes });
    const sourceTime = (item: Item): number | null =>
    {
        const time = (sources[item.pos] as LinkSource).message.date.utcMs;
        return typeof time === 'number' && Number.isFinite(time) ? time : null;
    };
    const entriesByKey = new Map<string, Item[]>();
    // Entries without a readable date, by sender key and date text as written.
    const undatedEntries = new Map<string, Item[]>();
    const undatedKey = (item: Item): string | null =>
    {
        const text = item.rebuilt.dateText?.replace(/\s+/gu, ' ').trim() ?? '';
        return item.key === null || item.estimate !== null || !datedText(text) || sourceTime(item) === null ? null : JSON.stringify([item.key, text]);
    };
    // Empty entries (no text) by their header facts (emptyHeaderKey), in best-copy order.
    const emptyEntries = new Map<string, Item[]>();
    const groupSources = new Map<number, Set<number>>();
    const members = new Map<number, number[]>();
    for (const item of unmatched)
    {
        let best: { entry: Item; score: number; diff: number } | null = null;
        const consider = (candidate: Item, diff: number, level: DateAgreement): void =>
        {
            const agreed = textAgreement(wordsOfItem(item), wordsOfItem(candidate), COPY_RULES[level]);
            if (agreed === null)
            {
                return;
            }
            const score = Math.min(agreed.forward, agreed.reverse);
            if (best === null || score > best.score || (score === best.score && Math.abs(diff) < Math.abs(best.diff)))
            {
                best = { entry: candidate, score, diff };
            }
        };
        if (item.key !== null && item.estimate !== null)
        {
            const estimate = item.estimate;
            const addressed = item.key.startsWith('a:');
            // Entries of this sender, sorted by date: only those within the window are read.
            const list = entriesByKey.get(item.key) ?? [];
            const inWindow: Item[] = [];
            for (let i = lowerBound(list, estimate - MATCH_WINDOW_MS, (e) => e.estimate as number); i < list.length; i++)
            {
                const candidate = list[i] as Item;
                if ((candidate.estimate as number) > estimate + MATCH_WINDOW_MS)
                {
                    break;
                }
                if (!(groupSources.get(candidate.id) as Set<number>).has(item.pos))
                {
                    inWindow.push(candidate);
                }
            }
            const near = inWindow
                .sort((a, b) => Math.abs((a.estimate as number) - estimate) - Math.abs((b.estimate as number) - estimate) || a.id - b.id)
                .slice(0, MAX_CANDIDATES);
            for (const candidate of near)
            {
                const diff = (candidate.estimate as number) - estimate;
                let level = copyDateAgreement(copyDate(item), copyDate(candidate), diff);
                if (level === null)
                {
                    continue;
                }
                if (!addressed && level === 'exact')
                {
                    level = 'zone';
                }
                consider(candidate, diff, level);
            }
        }
        const undatedTextKey = undatedKey(item);
        if (undatedTextKey !== null)
        {
            // No readable date: only a copy with the very same (precise) date text, sources within 26 h.
            const sourceMs = sourceTime(item) as number;
            const same = (undatedEntries.get(undatedTextKey) ?? []).filter(
                (x) => !(groupSources.get(x.id) as Set<number>).has(item.pos) && Math.abs((sourceTime(x) as number) - sourceMs) <= MATCH_WINDOW_MS,
            );
            for (const candidate of same.slice(0, MAX_CANDIDATES))
            {
                consider(candidate, 0, 'strict');
            }
        }
        // An empty message (no words: the text rule above never links it) joins an empty entry of another email
        // with the very same header facts (file comment, 2, EMPTY COPIES), the first in best-copy order.
        const emptyKey = emptyHeaderKey(item.rebuilt);
        let chosen = best as { entry: Item } | null;
        if (chosen === null && emptyKey !== null)
        {
            const entry = (emptyEntries.get(emptyKey) ?? []).find((x) => !(groupSources.get(x.id) as Set<number>).has(item.pos));
            if (entry !== undefined)
            {
                chosen = { entry };
            }
        }
        if (chosen !== null)
        {
            item.groupOf = chosen.entry.id;
            (groupSources.get(chosen.entry.id) as Set<number>).add(item.pos);
            (members.get(chosen.entry.id) as number[]).push(item.id);
        }
        else
        {
            item.groupOf = item.id;
            groupSources.set(item.id, new Set([item.pos]));
            members.set(item.id, []);
            if (item.key !== null && item.estimate !== null)
            {
                let list = entriesByKey.get(item.key);
                if (list === undefined)
                {
                    entriesByKey.set(item.key, (list = []));
                }
                // Kept sorted by date (then id), for the window search above.
                const estimate = item.estimate;
                const id = item.id;
                let insertAt = lowerBound(list, estimate, (e) => e.estimate as number);
                while (insertAt < list.length && (list[insertAt] as Item).estimate === estimate && (list[insertAt] as Item).id < id)
                {
                    insertAt++;
                }
                list.splice(insertAt, 0, item);
            }
            if (undatedTextKey !== null)
            {
                let list = undatedEntries.get(undatedTextKey);
                if (list === undefined)
                {
                    undatedEntries.set(undatedTextKey, (list = []));
                }
                list.push(item);
            }
            if (emptyKey !== null)
            {
                let list = emptyEntries.get(emptyKey);
                if (list === undefined)
                {
                    emptyEntries.set(emptyKey, (list = []));
                }
                list.push(item);
            }
        }
    }
    const isEntry = (item: Item): boolean => item.realPos === null && item.groupOf === item.id;

    // 3. Time keys and anchors along each chain.
    // A key is (time, side): side -1 = just before a real message at that
    // time (capped by its quoter), +1 = just after it (raised to the message
    // it quotes), 0 = by its own date (before a real message at the same time).
    const keyOf = new Map<number, { key: number; side: number; placement: RebuiltPlacement }>();
    const anchorOf = new Map<number, string>(); // id -> 'm<pos>' or 'r<id>'
    const realTime = (item: Item): number | null => (item.realPos === null ? null : (sources[item.realPos] as LinkSource).utcMs);
    bySource.forEach((chain, pos) =>
    {
        // Real times bound each rebuilt message: no later than the newer real
        // messages of its chain (the source, matched ones), no earlier than the
        // older matched ones. The newer bound wins if they disagree.
        const upper: (number | null)[] = [];
        let upperTime = (sources[pos] as LinkSource).utcMs;
        for (const item of chain)
        {
            upper.push(upperTime);
            const time = realTime(item);
            if (time !== null)
            {
                upperTime = upperTime === null ? time : Math.min(upperTime, time);
            }
        }
        const lower: (number | null)[] = chain.map(() => null);
        let lowerTime: number | null = null;
        for (let k = chain.length - 1; k >= 0; k--)
        {
            lower[k] = lowerTime;
            const time = realTime(chain[k] as Item);
            if (time !== null)
            {
                lowerTime = lowerTime === null ? time : Math.max(lowerTime, time);
            }
        }
        // Clamp, then keep the chain order: never after the newer rebuilt message.
        let prev: { key: number; side: number } | null = null;
        chain.forEach((item, k) =>
        {
            if (item.realPos !== null || item.estimate === null)
            {
                return;
            }
            const lo = lower[k] ?? null;
            const hi = upper[k] ?? null;
            let key = item.estimate;
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
            const placement: RebuiltPlacement = key < item.estimate ? 'capped-by-quoter' : key > item.estimate ? 'after-quoted' : 'by-date';
            keyOf.set(item.id, { key, side, placement });
            prev = { key, side };
        });
        chain.forEach((item, k) =>
        {
            if (item.realPos !== null || item.estimate !== null)
            {
                return;
            }
            let anchor = `m${pos}`;
            for (let j = k - 1; j >= 0; j--)
            {
                const older = chain[j] as Item;
                if (older.realPos !== null)
                {
                    anchor = `m${older.realPos}`;
                    break;
                }
                if (isEntry(older))
                {
                    anchor = `r${older.id}`;
                    break;
                }
            }
            anchorOf.set(item.id, anchor);
        });
    });

    // Keyed entries merged into the dated real messages.
    const keyed = items.filter((item) => isEntry(item) && keyOf.has(item.id));
    const keyFor = (item: Item): number => (keyOf.get(item.id) as { key: number }).key;
    const sideFor = (item: Item): number => (keyOf.get(item.id) as { side: number }).side;
    keyed.sort((a, b) =>
        keyFor(a) - keyFor(b) || sideFor(a) - sideFor(b) || b.rebuilt.generation - a.rebuilt.generation || a.pos - b.pos || a.id - b.id);
    // Before a real message at time t: an earlier key, or the same time unless placed just after (side +1).
    const before = (item: Item, t: number): boolean => keyFor(item) < t || (keyFor(item) === t && sideFor(item) <= 0);
    const base: string[] = [];
    let j = 0;
    sources.forEach((source, pos) =>
    {
        if (source.utcMs !== null)
        {
            while (j < keyed.length && before(keyed[j] as Item, source.utcMs))
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
    for (const item of items)
    {
        const anchor = anchorOf.get(item.id);
        if (anchor === undefined || !isEntry(item))
        {
            continue;
        }
        let list = children.get(anchor);
        if (list === undefined)
        {
            children.set(anchor, (list = []));
        }
        list.push(item);
    }
    for (const list of children.values())
    {
        list.sort((a, b) => b.rebuilt.generation - a.rebuilt.generation || a.pos - b.pos || a.id - b.id);
    }

    const timeline: TimelineEntry[] = [];
    const emit = (anchor: string): void =>
    {
        for (const child of children.get(anchor) ?? [])
        {
            emit(`r${child.id}`);
        }
        if (anchor.startsWith('m'))
        {
            timeline.push({ kind: 'message', position: Number(anchor.slice(1)) });
        }
        else
        {
            const id = Number(anchor.slice(1));
            timeline.push({ kind: 'rebuilt', id, placement: keyOf.get(id)?.placement ?? 'before-quoter' });
        }
    };
    for (const anchor of base)
    {
        emit(anchor);
    }

    const reconstructed: AnalyzedRebuiltMessage[] = items.map((item) =>
    {
        const source = sources[item.pos] as LinkSource;
        if (item.realPos !== null)
        {
            return { id: item.id, sourceIndex: source.index, rebuilt: item.rebuilt, link: 'real', realIndex: (sources[item.realPos] as LinkSource).index, match: item.match, sameAs: null, copies: [], alsoQuotedIn: [] };
        }
        if (item.groupOf !== item.id)
        {
            return { id: item.id, sourceIndex: source.index, rebuilt: item.rebuilt, link: 'same-as', realIndex: null, match: null, sameAs: item.groupOf, copies: [], alsoQuotedIn: [] };
        }
        const copies = [...(members.get(item.id) ?? [])].sort((a, b) => a - b);
        const also = [...new Set(copies.map((c) => (sources[(items[c] as Item).pos] as LinkSource).index))].sort((a, b) => a - b);
        return { id: item.id, sourceIndex: source.index, rebuilt: item.rebuilt, link: 'entry', realIndex: null, match: null, sameAs: null, copies, alsoQuotedIn: also };
    });
    return { reconstructed, timeline };
}
