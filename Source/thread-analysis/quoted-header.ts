// Header fields of a quoted email (milestone 7, task 7.3).
//
// Input: a body text and one header found by findReplyHeaders
// (reply-header.ts). Output: what that header says about the quoted email:
// sender, recipients, subject and the date as written (quoted-date.ts reads
// the date later). Nothing is guessed: a field the header does not hold, or
// holds in a shape that cannot be split for sure, is left empty (null or []).
// In particular the subject is NEVER taken from the dropped email's own
// subject.
//
// Rules:
// 1. HEADER BLOCK (Outlook, Gmail / Apple / Outlook forwards). The first line
//    of the header with a From label starts the block. Each label line gives
//    one value (the labels and their roles come from reply-header.ts, so all
//    languages of reply-patterns.ts are read the same way). The first value
//    of each role wins. Blind-copy lines (the `bcc` labels of
//    reply-patterns.ts) are read past but never reported: they are not Cc.
//    A From value with more than one mailbox ("Bob <bob@x>, on behalf of
//    Carol <carol@x>") gives no sender (from = []): who wrote is not clear.
//    WRAPPED LISTS. Safety over coverage: a body line or a sender must never
//    be read as a recipient. When unsure, nothing is taken; nothing is lost,
//    the lines stay in the original text. Only a From / To / Cc / Bcc value
//    with an address (the label's value holds "@") may continue on the next
//    lines (long lists wrapped by the client at a space: no label, no
//    indent); a names-only list (no "@"), a Subject or a Sent / Date value
//    never does. The wrapped lines come after the end findReplyHeaders
//    gave. Each must have the header's own ">" depth, not be blank or an
//    intro line (separator, forward marker, row of underscores), and keep
//    the value a list in which every mailbox has an address. The line
//    before must end with ";" or "," or with the start of a mailbox whose
//    address comes on the next line ("...; Heidi" / "Stub <heidi@x.test>");
//    a complete mailbox with no separator after it ends the list. The
//    wrapped lines are taken only when ALL of these hold:
//    - they end right before a label line (same depth) whose role is not
//      From and not read yet in this block (Outlook: the Cc or Subject line
//      after the list);
//    - the list ends with a complete mailbox (not "...; Heidi");
//    - every mailbox that comes from the wrapped lines has a name of at
//      most MAX_NAME_WORDS words, none starting with a lowercase letter
//      ("Write to Dan <dan@x>" is refused), and not an empty name (a bare
//      "dan@x.test" line is refused).
//    Otherwise none is taken (the list stays as the label line wrote it;
//    the lines stay outside the header). After the end findReplyHeaders
//    gave, a label line is read only right after lines read this way (a
//    wrapped list, or another such label line), and only for a role not
//    read yet in this block and not From (a From label starts a new block).
//    The block ends at the first other line. `headerEnd` is the end of the
//    last line read (line break included), never before the header end
//    findReplyHeaders gave.
//    INCOMPLETE LISTS. A To / Cc value that no label line (same depth)
//    follows, and that ends with ";" or "," or is followed right away by a
//    line of text (same depth, not blank, not an intro line), may go on
//    where it was not read: the role is listed in `incomplete` (the UI says
//    "the list may be incomplete, see the original text"). This also covers
//    a list wrapped inside a name ("...; Ivan" / "Fixture; ..."): when such
//    a list does not end with ";" or ",", its last mailbox, if it has no
//    address, may be cut short and is left out ("Ivan" is not shown).
// 2. ATTRIBUTION ("On <date>, <name> <addr> wrote:", "Le ... a ecrit :",
//    "Op <date> schreef <name> <addr>:", one line or two). The language
//    whose ending matches gives the parts (reply-patterns.ts, `parts`). The
//    sender's address is the last address before the tail (rule 3 forms, or
//    a bare address), a trailing comment ("<addr> (Legal)") left aside.
//    Every address written in the attribution must be that same address
//    (case-insensitive): "Bob <bob@x>, Carol <carol@x> wrote:" or "Bob
//    <bob@x> <carol@x> wrote:" give no sender and no date at all, and so
//    does an "@" with no address read. The date and the name are split:
//    - Dutch: at the last verb ("schreef", "heeft");
//    - otherwise at the last comma not inside quotes; when the text after
//      that comma holds a time ("2:02 PM", Gmail en-US writes no comma
//      before the name), right after the last time.
//    The split is kept only when it is clear-cut: the date part is not
//    empty and ends with a digit or AM/PM, and the name holds no digit. A
//    name holding ";" or ":" (unquoted) is left empty, as in rule 3.
//    Otherwise the date is null and the name empty (the address, if any, is
//    still given: it is unambiguous). Without an address, in every
//    language, a clause can sit where the name is ("Bob forwarded what
//    Carol wrote:", "schreef Bob dat hij later komt:"), so the name is kept
//    only with at most MAX_NAME_WORDS words, every lowercase word a name
//    particle ("Jan van der Berg", "Jean de La Fontaine", "d'Arc"), not the
//    pronoun "I" / "Je" / "Ik" alone, and no "&" or "/" (two people). So
//    "my colleague Bob wrote:" gives no sender (accepted cost). WITH an
//    address the same name test applies (except the word count: the
//    address bounds the name), but only the name is dropped: "On
//    3 March 2025, my colleague Bob <bob@x> wrote:" gives the address with
//    an empty name (the address is unambiguous, the name is not).
//    Without an opener ("Bob <bob@x>
//    wrote:"), there is no date; the name is kept only without a comma or a
//    digit, and only when it passes the same name test (else the address
//    alone). Without an address and without a clear split: nothing.
// 3. MAILBOX LISTS are split at ";" and "," outside quotes, "<>", "[]" and
//    "()". A "," splits only after a mailbox WITH an address, so a name
//    written "Sample, Bob" (Outlook, names only) stays one name. A mailbox
//    without an address (Outlook writes names only for known contacts) keeps
//    its name with an empty address: addresses are never made up. So
//    "Carol Doe, Dan Roe <dan@x.test>" stays ONE mailbox (name "Carol Doe,
//    Dan Roe", address dan@x.test): the comma cannot be told apart from
//    the one in "Roe, Dan <dan@x.test>".
//    An address is written "<addr>", "<mailto:addr>", "[mailto:addr]",
//    "addr<mailto:addr>>" inside "<...>" (Outlook plain text: "Bob
//    <bob@x.test<mailto:bob@x.test>>", kept only when both addresses agree,
//    case-insensitive) or bare. A name is left empty when it still holds an
//    encoded word ("=?UTF-8?Q?...?=", not decoded here), "<", ">", "@" or
//    "mailto:" (it would show an address that is not the mailbox's own); a
//    mailbox left with neither name nor address is dropped, and so is one
//    whose text before its address holds another address ("carol@x.test
//    <bob@x.test>", "A <a@x.test> on behalf of B <b@x.test>"): whose
//    mailbox it is, is not clear.
//    Group syntax ("Team: a@x.test, b@x.test;") is not supported: it is
//    split like any list, so the group name and the first address are
//    dropped (a name holding "@"), the other addresses kept.
//    A To / Cc value that holds text (a letter, digit or "@") but yields no
//    mailbox at all ("Bob <bob@x.test<mailto:eve@x.test>>", "Bob
//    <bob@x.test> (Legal)") is not read further: the role is listed in
//    `incomplete`, so the UI says the list may be incomplete instead of
//    showing it empty.
//
// Values are read through the cleaned copy of reply-header.ts (whitespace
// runs made one space, trimmed, NFC). Wrapped lines are joined by one space.
//
// Cost: bounded and linear. Only the header's own lines are read, plus at
// most MAX_CONTINUATION_LINES lines after a list value (and the label line
// after them), each at most MAX_LINE_LENGTH characters long; each wrapped
// line is split once, with at most MAX_NAME_LENGTH characters carried over
// from the line before. A value longer than MAX_VALUE_LENGTH or a list of
// more than MAX_MAILBOXES is not read (left empty).
//
// Pure function: no DOM, no storage, never throws, the input is never
// modified (README.md, rule R7).

import { OUTLOOK_RULE, REPLY_LANGUAGES } from './reply-patterns';
import {
    ATTRIBUTION_MAX_LENGTH,
    clean,
    FORWARD_MARKERS,
    LABEL_HEAD_LENGTH,
    LABEL_PATTERN,
    LABEL_ROLE_OF,
    labelKey,
    LANGUAGES,
    SEPARATORS,
    type FoundHeader,
    type Role,
} from './reply-header';
import type { EmailAddress } from '../../Header/parsed-email';

/** The fields a quoted email's header holds (see the file comment). */
export interface QuotedHeaderFields
{
    readonly from: readonly EmailAddress[];
    readonly to: readonly EmailAddress[];
    readonly cc: readonly EmailAddress[];
    /** null = the header holds no subject (attributions never do). '' = an empty Subject line. */
    readonly subject: string | null;
    /** The date as written (cleaned), or null. Read it with parseQuotedDate. */
    readonly dateText: string | null;
    /** End of the header's own lines, line break included; >= the header's headEnd. */
    readonly headerEnd: number;
    /** To / Cc lists known to go on past what was read (file comment, rule 1, INCOMPLETE LISTS). */
    readonly incomplete: readonly ('to' | 'cc')[];
}

/** Most wrapped lines read after one label line. */
export const MAX_CONTINUATION_LINES = 20;
/** Longest line (raw characters) read as a continuation. */
export const MAX_LINE_LENGTH = 2000;
/** Longest value (cleaned characters) read; longer values are left empty. */
export const MAX_VALUE_LENGTH = 20_000;
/** Most mailboxes read from one list; a longer list is left empty. */
export const MAX_MAILBOXES = 500;
/** Longest display name kept (also the longest name piece carried over a wrapped line). */
const MAX_NAME_LENGTH = 200;
/** Most words in the name of a mailbox read from a wrapped line (rule 1). */
export const MAX_NAME_WORDS = 4;

/** Roles whose value is a mailbox list and may be wrapped (rule 1). */
const LIST_ROLES: ReadonlySet<Role> = new Set<Role>(['from', 'to', 'cc', 'bcc']);

/** Attribution patterns per language, with the parts used to split them. */
const ATTRIBUTIONS = LANGUAGES.flatMap((lang) =>
{
    const parts = REPLY_LANGUAGES.find((l) => l.code === lang.code)?.attribution.parts;
    if (parts === undefined)
    {
        return [];
    }
    return [{ opener: lang.opener, endings: lang.endings, tail: new RegExp(parts.tail.source, 'iu'), verbs: parts.verbs ?? [] }];
});

/** A time ("2:02", "14:02:00", "2:02 PM", "2:02 p.m."), for the en-US Gmail split. */
const TIME = /(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?: ?[ap]\.? ?m\.?(?![a-z]))?/giu;
/** What a clear-cut date part ends with. */
const DATE_END = /(?:\d|[ap]\.? ?m\.?)$/iu;
/** A bare address: one "@", no space or mailbox punctuation. */
const BARE_ADDRESS = /^[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:"]+$/u;
/** An encoded word left undecoded. */
const ENCODED_WORD = /=\?[^?\s]+\?[bq]\?/iu;
/** What a display name may not hold: it would show an address that is not the mailbox's own. */
const NOT_A_NAME = /[<>@]|mailto:/iu;
/** A word starting with a lowercase letter (not in a name read from a wrapped line). */
const LOWERCASE_START = /^\p{Ll}/u;
/** Salutations and titles (EN/FR/NL, lowercase): a greeting line after a wrapped list must not be read as a recipient. */
const GREETING_WORDS: ReadonlySet<string> = new Set([
    'madame', 'monsieur', 'mme', 'mlle', 'm', 'mr', 'mrs', 'ms', 'miss',
    'dear', 'hi', 'hello', 'hey', 'good',
    'bonjour', 'bonsoir', 'salut', 'cher','ch\u00E8re',
    'geachte', 'beste', 'hallo', 'hoi', 'goedemorgen', 'goedemiddag', 'goedenavond',
    'dhr', 'mevr',
]);
/**
 * Lowercase words a name may hold (NL "Jan van der Berg", "Piet in 't Veld";
 * FR "Jean de La Fontaine"): rule 2, names read without an address. "in" is
 * a particle only before "'t"; a word "d'" + uppercase ("d'Arc") is one too.
 */
const NAME_PARTICLES: ReadonlySet<string> = new Set([
    'van', 'de', 'der', 'den', 'het', 'ten', 'ter', 'te', "'t",
    'du', 'des', 'la', 'le', "d'", 'd\u2019',
]);
/** First-person pronouns (EN/FR/NL, lowercase): never a sender's name on their own. */
const PRONOUNS: ReadonlySet<string> = new Set(['i', 'je', 'ik']);
/** A French elided particle written onto the name: "d'Arc", "d\u2019Estaing". */
const ELIDED_PARTICLE = /^d['\u2019]\p{Lu}/u;
/** Splits an attribution into words to find every address written in it. */
const ADDRESS_SPLIT = /[\s<>()[\]{},;:"]+/u;

/** One line of the body, as this reader sees it. */
interface Line
{
    readonly start: number;
    readonly contentEnd: number;
    readonly end: number;
    /** Number of ">" markers before the text. */
    readonly depth: number;
    /** Offset of the first character after the markers and spaces. */
    readonly textStart: number;
    /** Nothing but whitespace after the markers. */
    readonly gap: boolean;
}

const isSpace = (ch: string): boolean => /\s/u.test(ch);

/** The line starting at `pos`, or null at the end of the text or when it is longer than `maxLength`. */
function lineAt(text: string, pos: number, maxLength: number): Line | null
{
    if (pos >= text.length)
    {
        return null;
    }
    let i = pos;
    const limit = Math.min(text.length, pos + maxLength);
    while (i < limit && text.charCodeAt(i) !== 0x0a && text.charCodeAt(i) !== 0x0d)
    {
        i++;
    }
    if (i === limit && limit < text.length && text.charCodeAt(i) !== 0x0a && text.charCodeAt(i) !== 0x0d)
    {
        return null;
    }
    const contentEnd = i;
    let end = i;
    if (end < text.length)
    {
        end += text.charCodeAt(end) === 0x0d && text.charCodeAt(end + 1) === 0x0a ? 2 : 1;
    }
    let k = pos;
    while (k < contentEnd && isSpace(text.charAt(k)))
    {
        k++;
    }
    let depth = 0;
    while (k < contentEnd && (text.charAt(k) === '>' || isSpace(text.charAt(k))))
    {
        if (text.charAt(k) === '>')
        {
            depth++;
        }
        k++;
    }
    return { start: pos, contentEnd, end, depth, textStart: k, gap: k === contentEnd };
}

/** The label of a line: its role and cleaned value; null when the line has no label. */
function labelOf(text: string, line: Line): { role: Role; value: string } | null
{
    if (line.gap)
    {
        return null;
    }
    // The role is decided on the same head findReplyHeaders reads.
    const head = clean(text, line.textStart, Math.min(line.contentEnd, line.textStart + LABEL_HEAD_LENGTH));
    const match = LABEL_PATTERN.exec(head);
    const word = match?.[1];
    if (match === null || word === undefined)
    {
        return null;
    }
    const role = LABEL_ROLE_OF.get(labelKey(word));
    if (role === undefined)
    {
        return null;
    }
    const full = clean(text, line.textStart, line.contentEnd);
    // "*From:* Bob": the star after the colon is not part of the value.
    const value = full.slice(match[0].length).replace(/^\*+/u, '').trim();
    return { role, value };
}

/** Whether a line is an intro line (separator, forward marker, row of underscores). */
function isIntro(text: string, line: Line): boolean
{
    if (line.contentEnd - line.textStart > 480)
    {
        return false;
    }
    const cleaned = clean(text, line.textStart, line.contentEnd);
    return OUTLOOK_RULE.test(cleaned) || SEPARATORS.some((re) => re.test(cleaned)) || FORWARD_MARKERS.some((re) => re.test(cleaned));
}

// ---------------------------------------------------------------------------
// Mailboxes

/** A display name without its quotes; '' when it still holds an encoded word, "<", ">", "@" or "mailto:", or is too long. */
function cleanName(raw: string): string
{
    let name = raw.trim();
    if (name.length >= 2 && name.startsWith('"') && name.endsWith('"'))
    {
        name = name.slice(1, -1).replace(/\\(.)/gu, '$1').trim();
    }
    else if (name.length >= 2 && name.startsWith("'") && name.endsWith("'"))
    {
        name = name.slice(1, -1).trim();
    }
    if (ENCODED_WORD.test(name) || NOT_A_NAME.test(name) || name.length > MAX_NAME_LENGTH)
    {
        return '';
    }
    return name;
}

/** The address in `raw`: "addr", or "mailto:addr" as `mailto` says; null when none. */
function plainAddress(raw: string, mailto: 'allowed' | 'required' | 'refused'): string | null
{
    let s = raw.trim();
    if (s.slice(0, 7).toLowerCase() === 'mailto:')
    {
        if (mailto === 'refused')
        {
            return null;
        }
        s = s.slice(7).trim();
    }
    else if (mailto === 'required')
    {
        return null;
    }
    return BARE_ADDRESS.test(s) ? s : null;
}

/**
 * The address written at the very end of `s` ("<addr>", "<mailto:addr>",
 * "<addr<mailto:addr>>", "[mailto:addr]": file comment, rule 3) and where
 * it starts; null when `s` does not end with one.
 */
function trailingAddress(s: string): { start: number; address: string } | null
{
    if (s.endsWith('>>'))
    {
        // Outlook plain text: "Bob <bob@x.test<mailto:bob@x.test>>". Kept only when both agree.
        const inner = s.lastIndexOf('<');
        const outer = inner > 0 ? s.lastIndexOf('<', inner - 1) : -1;
        if (outer < 0)
        {
            return null;
        }
        const shown = plainAddress(s.slice(outer + 1, inner), 'refused');
        const link = plainAddress(s.slice(inner + 1, -2), 'required');
        if (shown === null || link === null || shown.toLowerCase() !== link.toLowerCase())
        {
            return null;
        }
        return { start: outer, address: shown };
    }
    if (s.endsWith('>'))
    {
        const open = s.lastIndexOf('<');
        const address = open < 0 ? null : plainAddress(s.slice(open + 1, -1), 'allowed');
        return address === null ? null : { start: open, address };
    }
    if (s.endsWith(']'))
    {
        const open = s.lastIndexOf('[');
        const address = open < 0 ? null : plainAddress(s.slice(open + 1, -1), 'required');
        return address === null ? null : { start: open, address };
    }
    return null;
}

/** The address of one mailbox (trimmed text) and where it starts; null when it has none. */
function mailboxAddress(item: string): { start: number; address: string } | null
{
    const at = trailingAddress(item);
    if (at !== null)
    {
        return at;
    }
    const unquoted = item.replace(/^'(.*)'$/u, '$1');
    return BARE_ADDRESS.test(unquoted) ? { start: item.length, address: unquoted } : null;
}

/**
 * One mailbox ("Name <addr>", "Name [mailto:addr]", "addr", "Name"); null
 * when it has neither a name nor an address, or when the text before its
 * address holds another address ("carol@x.test <bob@x.test>", "A <a@x.test>
 * on behalf of B <b@x.test>"): whose mailbox it is, is not clear.
 */
function parseMailbox(raw: string): EmailAddress | null
{
    const item = raw.trim();
    if (item === '')
    {
        return null;
    }
    const at = mailboxAddress(item);
    if (at === null)
    {
        const name = cleanName(item);
        return name === '' ? null : { name, address: '' };
    }
    const before = item.slice(0, at.start);
    if (!onlyAddress(before, at.address))
    {
        return null;
    }
    return { name: cleanName(before), address: at.address };
}

/**
 * Splits a list into the raw text of its mailboxes (file comment, rule 3),
 * in order, blank ones left out. `open`: a quote or bracket is still open
 * at the end of `value`.
 */
function splitList(value: string): { items: string[]; open: boolean }
{
    const items: string[] = [];
    let pending = ''; // text of the mailbox being read (may hold commas)
    let piece = '';
    let quoted = false;
    let angle = 0;
    let square = 0;
    let paren = 0;
    const flush = (): void =>
    {
        if (pending.trim() !== '')
        {
            items.push(pending);
        }
        pending = '';
    };
    for (let i = 0; i <= value.length; i++)
    {
        const ch = i < value.length ? value.charAt(i) : ';';
        const top = !quoted && angle === 0 && square === 0 && paren === 0;
        if (i === value.length || (top && (ch === ';' || ch === ',')))
        {
            // A comma ends a mailbox only when that mailbox has an address. An
            // address is only read at the END of a mailbox ("<addr>", "[mailto:]")
            // or as the whole of it, so testing the last piece is enough (and keeps
            // the cost linear).
            const addressed = mailboxAddress(piece.trim()) !== null;
            const ends = ch === ';' || i === value.length || addressed;
            // A bare address is a mailbox of its own: what is pending before it is another one.
            if (pending !== '' && addressed && !/[>\]]$/u.test(piece.trim()))
            {
                flush();
            }
            pending = pending.trim() === '' ? piece : `${pending},${piece}`;
            piece = '';
            if (ends)
            {
                flush();
            }
            continue;
        }
        piece += ch;
        if (quoted)
        {
            if (ch === '\\')
            {
                i++;
                if (i < value.length)
                {
                    piece += value.charAt(i);
                }
            }
            else if (ch === '"')
            {
                quoted = false;
            }
        }
        else if (ch === '"')
        {
            quoted = true;
        }
        else if (ch === '<')
        {
            angle++;
        }
        else if (ch === '>' && angle > 0)
        {
            angle--;
        }
        else if (ch === '[')
        {
            square++;
        }
        else if (ch === ']' && square > 0)
        {
            square--;
        }
        else if (ch === '(')
        {
            paren++;
        }
        else if (ch === ')' && paren > 0)
        {
            paren--;
        }
    }
    return { items, open: quoted || angle > 0 || square > 0 || paren > 0 };
}

/**
 * Splits a From / To / Cc value into mailboxes (file comment, rule 3).
 * Never throws; an over-long value or list gives [].
 */
export function parseMailboxList(value: string): EmailAddress[]
{
    if (typeof (value as unknown) !== 'string' || value.length > MAX_VALUE_LENGTH)
    {
        return [];
    }
    const out: EmailAddress[] = [];
    for (const item of splitList(value).items)
    {
        const box = parseMailbox(item);
        if (box !== null)
        {
            out.push(box);
        }
        if (out.length > MAX_MAILBOXES)
        {
            return [];
        }
    }
    return out;
}

/**
 * Where a wrapped list stands at the end of a line (file comment, rule 1):
 * 'sep' = it ends with ";" or ",", so it goes on; 'part' = it ends with
 * the start of a mailbox (`tail`, at most MAX_NAME_LENGTH characters) that
 * the next line may complete;
 * 'closed' = it ends with a complete mailbox and no separator.
 */
interface ListState
{
    readonly kind: 'sep' | 'part' | 'closed';
    readonly tail: string;
}

/** A list with an address: every mailbox has one, but the last may be cut short (rule 1); null when not such a list. */
function addressedState(text: string): ListState | null
{
    const { items, open } = splitList(text);
    const last = items[items.length - 1];
    if (last === undefined)
    {
        return null;
    }
    for (let k = 0; k < items.length - 1; k++)
    {
        if ((parseMailbox(items[k] ?? '')?.address ?? '') === '')
        {
            return null;
        }
    }
    const ends = text.trimEnd();
    const separated = !open && (ends.endsWith(';') || ends.endsWith(','));
    if ((parseMailbox(last)?.address ?? '') !== '')
    {
        return { kind: separated ? 'sep' : 'closed', tail: '' };
    }
    // The start of a mailbox ("Heidi", "Sample,", "\"Doe,"): no address part yet, and no ";" after it.
    if (/[<>@[\]]/u.test(last) || last.length > MAX_NAME_LENGTH || (!open && ends.endsWith(';')))
    {
        return null;
    }
    return { kind: 'part', tail: last.trim() };
}

/**
 * Whether a mailbox read from a wrapped line looks like one (rule 1): an
 * address and a name of at most MAX_NAME_WORDS words, none starting with a
 * lowercase letter, the first not a salutation or title (GREETING_WORDS).
 */
function isWrappedMailbox(item: string): boolean
{
    const box = parseMailbox(item);
    if (box === null || box.address === '' || box.name === '')
    {
        return false;
    }
    const words = box.name.split(' ');
    const first = (words[0] ?? '').replace(/[.,]$/u, '').toLowerCase();
    if (GREETING_WORDS.has(first))
    {
        return false;
    }
    return words.length <= MAX_NAME_WORDS && !words.some((w) => LOWERCASE_START.test(w));
}

// ---------------------------------------------------------------------------
// Attributions

/**
 * Where the sender's address is at the end of `core` (file comment, rule 2):
 * where it starts and the address; null when none. A trailing comment
 * ("Carol <carol@x.test> (Legal)") is left aside.
 */
function lastAddress(core: string): { start: number; address: string } | null
{
    const open = core.endsWith(')') ? core.lastIndexOf('(') : -1;
    const withoutComment = open > 0 && !core.slice(open + 1, -1).includes(')') ? core.slice(0, open).trimEnd() : null;
    return (withoutComment === null ? null : addressAtEnd(withoutComment)) ?? addressAtEnd(core);
}

/** The address at the very end of `s` (rule 3 forms or a bare address) and where it starts; null when none. */
function addressAtEnd(s: string): { start: number; address: string } | null
{
    const written = trailingAddress(s);
    if (written !== null)
    {
        return written;
    }
    const space = s.lastIndexOf(' ');
    const token = s.slice(space + 1);
    return BARE_ADDRESS.test(token) ? { start: space + 1, address: token } : null;
}

/** Whether every address written in `core` is `address` (case-insensitive); with no address, whether none is written. */
function onlyAddress(core: string, address: string | null): boolean
{
    if (!core.includes('@'))
    {
        return true;
    }
    if (address === null)
    {
        return false;
    }
    const want = address.toLowerCase();
    for (const word of core.split(ADDRESS_SPLIT))
    {
        if (!word.includes('@'))
        {
            continue;
        }
        // "'bob@x.test'": quotes around a word are not part of it.
        let from = 0;
        let to = word.length;
        while (from < to && word.charAt(from) === "'")
        {
            from++;
        }
        while (to > from && word.charAt(to - 1) === "'")
        {
            to--;
        }
        if (word.slice(from, to).toLowerCase() !== want)
        {
            return false;
        }
    }
    return true;
}

/** Index of the last comma of `text` outside double quotes, or -1. */
function lastCommaOutsideQuotes(text: string): number
{
    let quoted = false;
    let last = -1;
    for (let i = 0; i < text.length; i++)
    {
        const ch = text.charAt(i);
        if (ch === '\\' && quoted)
        {
            i++;
        }
        else if (ch === '"')
        {
            quoted = !quoted;
        }
        else if (ch === ',' && !quoted)
        {
            last = i;
        }
    }
    return quoted ? -1 : last;
}

/** End of the last time in `text`, or -1. */
function lastTimeEnd(text: string): number
{
    let end = -1;
    TIME.lastIndex = 0;
    for (let m = TIME.exec(text); m !== null; m = TIME.exec(text))
    {
        end = m.index + m[0].length;
    }
    return end;
}

/**
 * The sender's name in an attribution: '' also when, unquoted, it holds
 * ";" or ":" (two people, or a line such as "Bob wrote: Carol").
 */
function attributionName(raw: string): string
{
    const name = raw.trim();
    return !name.startsWith('"') && /[;:]/u.test(name) ? '' : cleanName(name);
}

/**
 * Whether an attribution name looks like one (rule 2): at most
 * MAX_NAME_WORDS words when no address bounds it (`addressed` false; with
 * an address a longer name such as "Carol Test - Equipe Livraisons" is
 * kept), every word starting with a lowercase letter a name particle (NAME_PARTICLES; "in" only before "'t"; "d'Arc"), not a
 * pronoun alone (PRONOUNS) and without "&" or "/". Exported for
 * reconstruct.ts (rule R1: a sender without an address counts as evidence
 * only when its name is name-shaped).
 */
export function isPlainName(name: string, addressed: boolean): boolean
{
    const words = name.split(' ');
    if (!addressed && words.length > MAX_NAME_WORDS)
    {
        return false;
    }
    // "I wrote:", "Je ... a ecrit :", "Ik ...": the writer, not a name; "&" or "/": two people.
    if (PRONOUNS.has(name.toLowerCase()) || /[&/]/u.test(name))
    {
        return false;
    }
    return words.every(
        (w, i) =>
            !LOWERCASE_START.test(w) ||
            NAME_PARTICLES.has(w) ||
            ELIDED_PARTICLE.test(w) ||
            (w === 'in' && words[i + 1] === "'t"),
    );
}

/** Splits "DATE, NAME" / "DATE schreef NAME" (file comment, rule 2); null when not clear-cut. */
function splitDateName(before: string, verbs: readonly string[]): { date: string; name: string } | null
{
    let date: string;
    let name: string;
    if (verbs.length > 0)
    {
        const padded = ` ${before.toLowerCase()} `;
        let at = -1;
        let length = 0;
        for (const verb of verbs)
        {
            const k = padded.lastIndexOf(` ${verb} `);
            if (k > at)
            {
                at = k;
                length = verb.length;
            }
        }
        if (at < 0)
        {
            return null;
        }
        // `padded` has one extra space in front: index k in padded is k - 1 in before.
        date = before.slice(0, Math.max(0, at - 1)).trim();
        name = before.slice(at + length).trim();
    }
    else
    {
        const comma = lastCommaOutsideQuotes(before);
        const after = comma < 0 ? before : before.slice(comma + 1);
        const timeEnd = /\d/u.test(after) ? lastTimeEnd(after) : -1;
        const cut = timeEnd >= 0 ? comma + 1 + timeEnd : comma;
        if (cut < 0)
        {
            return null;
        }
        date = before.slice(0, cut).replace(/,\s*$/u, '').trim();
        name = before.slice(timeEnd >= 0 ? cut : cut + 1).trim();
    }
    if (date === '' || !DATE_END.test(date) || /\d/u.test(name))
    {
        return null;
    }
    return { date, name: attributionName(name) };
}

/** The sender and date of an attribution (cleaned, one or two lines joined); empty when unclear. */
function readAttribution(text: string): { from: EmailAddress[]; dateText: string | null }
{
    const none = { from: [], dateText: null };
    if (text.length > ATTRIBUTION_MAX_LENGTH)
    {
        return none;
    }
    for (const lang of ATTRIBUTIONS)
    {
        if (!lang.endings.some((re) => re.test(text)))
        {
            continue;
        }
        const tail = lang.tail.exec(text);
        if (tail === null)
        {
            continue;
        }
        const opener = lang.opener.exec(text);
        const core = text.slice(opener === null ? 0 : opener[0].length, tail.index).trim();
        const address = lastAddress(core);
        // Two addresses (two people, or a name holding another address): who wrote is not clear.
        if (!onlyAddress(core, address?.address ?? null))
        {
            return none;
        }
        const before = (address === null ? core : core.slice(0, address.start)).trim();
        if (opener === null)
        {
            // "Bob Sample <bob@x.test> wrote:": no date. The name only when nothing else can be in it.
            if (address === null)
            {
                return none;
            }
            const plain = /[\d,]/u.test(before) ? '' : attributionName(before);
            const name = isPlainName(plain, true) ? plain : '';
            return { from: [{ name, address: address.address }], dateText: null };
        }
        const split = splitDateName(before, lang.verbs);
        if (split === null)
        {
            return address === null ? none : { from: [{ name: '', address: address.address }], dateText: null };
        }
        // A clause can sit where the name is ("Bob forwarded what Carol wrote:",
        // "schreef Bob dat hij later komt:", "my colleague Bob <bob@x> wrote:").
        // Only a name-shaped name is kept; an address is kept either way.
        const name = isPlainName(split.name, address !== null) ? split.name : '';
        const from = name === '' && address === null ? [] : [{ name, address: address?.address ?? '' }];
        return { from, dateText: split.date };
    }
    return none;
}

// ---------------------------------------------------------------------------
// Entry point

/**
 * Reads the fields of the quoted email whose header `header` is (one result
 * of findReplyHeaders on the same `bodyText`). See the file comment. Never
 * throws: odd input gives empty fields and headerEnd = header.headEnd.
 */
export function readQuotedHeader(bodyText: string, header: Pick<FoundHeader, 'start' | 'headEnd'>): QuotedHeaderFields
{
    const given = header as Partial<FoundHeader> | null | undefined; // odd input: may be anything
    const headEnd = typeof given?.headEnd === 'number' && Number.isFinite(given.headEnd) ? given.headEnd : 0;
    if (typeof (bodyText as unknown) !== 'string')
    {
        return { from: [], to: [], cc: [], subject: null, dateText: null, headerEnd: headEnd, incomplete: [] };
    }
    // Odd input: the header end given may lie outside the text.
    const empty: QuotedHeaderFields = { from: [], to: [], cc: [], subject: null, dateText: null, headerEnd: Math.min(Math.max(headEnd, 0), bodyText.length), incomplete: [] };
    const start = given?.start;
    if (typeof start !== 'number' || !Number.isInteger(start) || !Number.isInteger(headEnd) || start < 0 || start >= headEnd || headEnd > bodyText.length)
    {
        return empty;
    }
    try
    {
        return readHeader(bodyText, start, headEnd) ?? empty;
    }
    catch
    {
        return empty; // never happens: the reader only slices and tests strings
    }
}

/**
 * How many label lines of each role (from, sent, to, cc, bcc, subject) the
 * header lines [start, headerEnd) of `bodyText` hold, read as readQuotedHeader
 * reads them (any ">" depth; lines that are not label lines are not
 * counted). The PDF uses it to know whether a rebuilt email's header rows
 * show everything its original header lines say (a Bcc line or a repeated
 * label is never shown: Source/pdf-export/model.ts, the no-repeat rule, task 8.10).
 * Odd input (not a string, bounds outside the text) gives an empty map.
 * Never throws.
 */
export function headerLabelCounts(bodyText: string, start: number, headerEnd: number): ReadonlyMap<Role, number>
{
    const counts = new Map<Role, number>();
    if (typeof (bodyText as unknown) !== 'string' || !Number.isInteger(start) || !Number.isInteger(headerEnd) || start < 0 || headerEnd > bodyText.length || start >= headerEnd)
    {
        return counts;
    }
    try
    {
        for (let pos = start; pos < headerEnd; )
        {
            const line = lineAt(bodyText, pos, headerEnd - pos);
            if (line === null)
            {
                break;
            }
            const label = labelOf(bodyText, line);
            if (label !== null)
            {
                counts.set(label.role, (counts.get(label.role) ?? 0) + 1);
            }
            pos = line.end;
        }
    }
    catch
    {
        // never happens: the reader only slices and tests strings
    }
    return counts;
}

function readHeader(text: string, start: number, headEnd: number): QuotedHeaderFields | null
{
    // The header's own lines.
    const own: Line[] = [];
    for (let pos = start; pos < headEnd; )
    {
        const line = lineAt(text, pos, headEnd - pos);
        if (line === null)
        {
            break;
        }
        own.push(line);
        pos = line.end;
    }
    const firstFrom = own.findIndex((line) => labelOf(text, line)?.role === 'from');
    if (firstFrom < 0)
    {
        const words = own.filter((line) => !line.gap);
        if (words.length === 0 || words.length > 2)
        {
            return null;
        }
        const joined = words.map((line) => clean(text, line.textStart, line.contentEnd)).join(' ');
        const { from, dateText } = readAttribution(joined);
        return { from, to: [], cc: [], subject: null, dateText, headerEnd: headEnd, incomplete: [] };
    }
    return readBlock(text, own[firstFrom] as Line, headEnd);
}

function readBlock(text: string, first: Line, headEnd: number): QuotedHeaderFields
{
    const values = new Map<Role, string>();
    const seen = new Set<Role>(); // roles whose label was read in this block (Bcc and repeats included)
    const depth = first.depth;
    let lastEnd = first.end;
    const incomplete: ('to' | 'cc')[] = [];
    for (let line: Line | null = first; line !== null; )
    {
        const label = line.depth === depth ? labelOf(text, line) : null;
        if (label === null)
        {
            break;
        }
        // After the end findReplyHeaders gave (reached only through a wrapped
        // list or another such label): a role not read yet, never From (rule 1).
        if (line.start >= headEnd && (label.role === 'from' || seen.has(label.role)))
        {
            break;
        }
        const fresh = !seen.has(label.role);
        seen.add(label.role);
        let value = label.value;
        lastEnd = line.end;
        if (LIST_ROLES.has(label.role) && line.end >= headEnd)
        {
            const wrapped = wrappedLines(text, line.end, depth, label.value, seen);
            if (wrapped.parts.length > 0)
            {
                value = [value, ...wrapped.parts].join(' ');
                lastEnd = wrapped.end;
            }
        }
        // The first value of each role wins; Bcc is read past, never reported.
        if (fresh && label.role !== 'bcc')
        {
            values.set(label.role, value);
        }
        // A To / Cc list that may go on where it was not read (rule 1, INCOMPLETE LISTS).
        if (fresh && (label.role === 'to' || label.role === 'cc') && mayGoOn(text, lastEnd, depth, value))
        {
            incomplete.push(label.role);
        }
        line = lineAt(text, lastEnd, lastEnd < headEnd ? headEnd - lastEnd : MAX_LINE_LENGTH);
    }
    const list = (r: Role): EmailAddress[] =>
    {
        const value = values.get(r);
        return value === undefined ? [] : parseMailboxList(value);
    };
    // A list that goes on unread with no separator at its end may end inside a
    // mailbox ("...; Ivan" / "Fixture; ..."): a last mailbox without an address
    // may be cut short, so it is left out (rule 1, INCOMPLETE LISTS).
    const recipients = (r: 'to' | 'cc'): EmailAddress[] =>
    {
        const boxes = list(r);
        const cut = incomplete.includes(r) && !/[;,]$/u.test(values.get(r) ?? '') && boxes[boxes.length - 1]?.address === '';
        return cut ? boxes.slice(0, -1) : boxes;
    };
    // A To / Cc value that holds text but yields no mailbox ("Bob <bob@x.test>
    // (Legal)"): flagged, so the list does not look empty (rule 3).
    for (const r of ['to', 'cc'] as const)
    {
        if (!incomplete.includes(r) && /[\p{L}\p{N}@]/u.test(values.get(r) ?? '') && list(r).length === 0)
        {
            incomplete.push(r);
        }
    }
    const subject = values.get('subject');
    const date = values.get('sent');
    const from = list('from');
    return {
        // More than one sender: who wrote is not clear (rule 1).
        from: from.length > 1 ? [] : from,
        to: recipients('to'),
        cc: recipients('cc'),
        subject: subject === undefined || subject.length > MAX_VALUE_LENGTH ? null : subject,
        dateText: date === undefined || date === '' || date.length > MAX_VALUE_LENGTH ? null : date,
        headerEnd: Math.max(headEnd, lastEnd),
        incomplete,
    };
}

/**
 * Whether the list `value`, whose last line read ends at `pos`, may go on
 * unread (file comment, rule 1, INCOMPLETE LISTS): no label line of the same
 * depth follows, and the value ends with ";" or "," or a text line of the
 * same depth (not blank, not an intro line) follows right after it.
 */
function mayGoOn(text: string, pos: number, depth: number, value: string): boolean
{
    if (pos >= text.length)
    {
        return /[;,]$/u.test(value);
    }
    const next = lineAt(text, pos, MAX_LINE_LENGTH);
    if (next === null)
    {
        return true; // an over-long line of text
    }
    const sameDepthText = !next.gap && next.depth === depth;
    if (sameDepthText && labelOf(text, next) !== null)
    {
        return false;
    }
    return /[;,]$/u.test(value) || (sameDepthText && !isIntro(text, next));
}

/**
 * The wrapped lines of a From / To / Cc / Bcc value with an address whose
 * label line ends at `pos` (file comment, rule 1): their cleaned text and
 * the end of the last one; none when they are not clearly part of the list.
 * `seen`: the roles read so far in this block, the value's own included.
 */
function wrappedLines(text: string, pos: number, depth: number, value: string, seen: ReadonlySet<Role>): { parts: string[]; end: number }
{
    const none = { parts: [], end: pos };
    // A names-only list never continues: a body line cannot be told apart from a name.
    if (!value.includes('@'))
    {
        return none;
    }
    let state = addressedState(value);
    if (state === null)
    {
        return none;
    }
    // Index of the first mailbox that comes (at least partly) from a wrapped line.
    const ownItems = splitList(value).items.length;
    const firstWrapped = state.kind === 'part' ? ownItems - 1 : ownItems;
    const parts: string[] = [];
    let end = pos;
    let length = value.length;
    let endLabel: Role | null = null; // role of the label line right after the wrapped lines
    for (;;)
    {
        const line = lineAt(text, end, MAX_LINE_LENGTH);
        if (line === null || line.gap || line.depth !== depth || isIntro(text, line))
        {
            break;
        }
        const label = labelOf(text, line);
        if (label !== null)
        {
            endLabel = label.role;
            break;
        }
        if (state.kind === 'closed' || parts.length >= MAX_CONTINUATION_LINES)
        {
            break;
        }
        const cleaned = clean(text, line.textStart, line.contentEnd);
        length += cleaned.length + 1;
        if (length > MAX_VALUE_LENGTH)
        {
            break;
        }
        // Only the mailbox cut short (at most MAX_NAME_LENGTH characters) is read again with the line.
        const next = addressedState(state.tail === '' ? cleaned : `${state.tail} ${cleaned}`);
        if (next === null)
        {
            break;
        }
        parts.push(cleaned);
        end = line.end;
        state = next;
    }
    // Taken only right before the label of a role not read yet (not From), with
    // the last mailbox complete and every wrapped mailbox shaped like one.
    const beforeLabel = endLabel !== null && endLabel !== 'from' && !seen.has(endLabel);
    if (parts.length === 0 || !beforeLabel || state.kind === 'part')
    {
        return none;
    }
    const items = splitList([value, ...parts].join(' ')).items;
    if (items.length <= firstWrapped)
    {
        return none;
    }
    for (let k = firstWrapped; k < items.length; k++)
    {
        if (!isWrappedMailbox(items[k] ?? ''))
        {
            return none;
        }
    }
    return { parts, end };
}
