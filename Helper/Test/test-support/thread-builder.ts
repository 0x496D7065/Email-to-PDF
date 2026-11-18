// Ground-truth builder for thread reconstruction (milestone 7, task 7.1).
//
// Input: a known conversation, oldest message first. Every message after the
// first quotes the WHOLE body of the message before it, the way one mail
// client renders it (its QuoteStyle). Output: the body text of the LAST
// message as that chain of clients would produce it, plus the ground truth
// for every earlier message: where its header starts and ends in the body,
// where its own text is, how deep it is quoted (">" depth), how many replies
// away it is (generation), the header fields as written, and whether it was
// replied to or forwarded.
//
// Because each message quotes the full body before it, styles mix naturally
// (an Outlook block inside a Gmail ">" quote, like fixture
// Helper/Test/test-data/eml/13-order-4-bob-outlook-nl.eml), and ">" depth is not the
// generation: Outlook quotes without ">" at all.
//
// How it works: the body is kept as a list of LINES, each one remembering
// the message it belongs to and whether it is that message's header, own
// text or a blank gap. Quoting only adds a prefix to each line and one to
// its depth. Offsets are computed once, when the lines are joined, so the
// ground truth cannot drift from the text.
//
// The date shown in a quote header is the quoted message's moment in the
// QUOTING message's time zone (what clients do), so a header can show
// another wall-clock time than the one the sender saw.
//
// Synthetic data only (README.md, rule R7): invented people, example.test
// and sample.invalid addresses, time zones from ALLOWED_TIME_ZONES
// (Helper/Test/test-data/privacy-guard-rules.ts). Fixed UTC offsets, no daylight saving
// rules: pick a zone and a date where the offset given is correct.
//
// Non-ASCII letters are written as \u escapes so this file stays ASCII:
// \u00e9 = e acute, \u00e0 = a grave, \u00c0 = capital A grave,
// \u00fb = u circumflex.

/** A person as a client knows them. */
export interface Person
{
    readonly name: string;
    readonly address: string;
}

/** A fixed UTC offset with the zone it stands for (offset correct for the dates used). */
export interface Zone
{
    readonly name: string;
    readonly offsetMinutes: number;
}

/** A wall-clock time, month 1-12. */
export interface WallTime
{
    readonly year: number;
    readonly month: number;
    readonly day: number;
    readonly hour: number;
    readonly minute: number;
}

/**
 * How a message quotes (or forwards) the message before it.
 * - outlook-xx: classic Outlook reply: a row of underscores, then a
 *   From/Sent/To/Cc/Subject block in the language, then the old body
 *   WITHOUT ">".
 * - outlook-original-xx: older Outlook: "-----Original Message-----" instead
 *   of the underscores.
 * - outlook-forward-xx: an Outlook forward (same block as a reply; only the
 *   "FW:" / "TR :" subject tells them apart).
 * - gmail-xx: an attribution line above a ">" quote ("On ... wrote:").
 *   gmail-en is the en-US form ("On Mon, Mar 3, 2025 at 2:02 PM ..."),
 *   gmail-en-gb the en-GB one ("On Mon, 3 Mar 2025 at 14:02, ..."), as in
 *   the comment of Source/thread-analysis/reply-header-patterns.ts.
 * - gmail-forward-xx: "---------- Forwarded message ---------" + block, no ">".
 * - apple-xx: the attribution is INSIDE the ">" quote, then a ">" line.
 * - apple-forward-en: "Begin forwarded message:" + block (From, Subject,
 *   Date, To), no ">".
 * - thunderbird-en: numeric-date attribution without an address, ">" quote.
 */
export type QuoteStyle =
    | 'outlook-en'
    | 'outlook-fr'
    | 'outlook-nl'
    | 'outlook-original-en'
    | 'outlook-original-fr'
    | 'outlook-original-nl'
    | 'outlook-forward-en'
    | 'outlook-forward-fr'
    | 'gmail-en'
    | 'gmail-en-gb'
    | 'gmail-fr'
    | 'gmail-nl'
    | 'gmail-forward-en'
    | 'gmail-forward-fr'
    | 'gmail-forward-nl'
    | 'apple-en'
    | 'apple-fr'
    | 'apple-nl'
    | 'apple-forward-en'
    | 'thunderbird-en';

export const QUOTE_STYLES: readonly QuoteStyle[] = [
    'outlook-en',
    'outlook-fr',
    'outlook-nl',
    'outlook-original-en',
    'outlook-original-fr',
    'outlook-original-nl',
    'outlook-forward-en',
    'outlook-forward-fr',
    'gmail-en',
    'gmail-en-gb',
    'gmail-fr',
    'gmail-nl',
    'gmail-forward-en',
    'gmail-forward-fr',
    'gmail-forward-nl',
    'apple-en',
    'apple-fr',
    'apple-nl',
    'apple-forward-en',
    'thunderbird-en',
];

/** True for the styles that forward rather than reply. */
export function isForwardStyle(style: QuoteStyle): boolean
{
    return style.includes('forward');
}

export interface QuoteOptions
{
    readonly style: QuoteStyle;
    /**
     * How header BLOCKS write a person: 'angle' "Name <address>" (default),
     * 'name' the name only (classic Outlook for known contacts), 'mailto'
     * "Name [mailto:address]" (older Outlook). Attributions are not affected.
     */
    readonly people?: 'angle' | 'name' | 'mailto';
    /**
     * Wrap header lines longer than this many characters at a space (the
     * space is dropped; continuation lines have no label and no indent).
     * Applies to block label lines and attribution lines.
     */
    readonly wrapAt?: number;
}

export interface ThreadMessage
{
    readonly from: Person;
    readonly to: readonly Person[];
    readonly cc?: readonly Person[];
    /** When it was sent, in the sender's own zone. */
    readonly sent: WallTime;
    readonly zone: Zone;
    readonly subject: string;
    /** The message's own text, "\n" line breaks, no trailing line break, no line starting with ">" or a space. */
    readonly text: string;
    /** How this message quotes the one before it. Required for every message but the first. */
    readonly quote?: QuoteOptions;
}

/** The header fields of a quoted message, exactly as written in the body (wrapped lines joined by one space). */
export interface ExpectedFields
{
    readonly from: string;
    readonly date: string;
    /** Header blocks only (not attributions). */
    readonly to?: string;
    readonly cc?: string;
    readonly subject?: string;
}

/** Ground truth for one earlier message of the built body. */
export interface ExpectedHeader
{
    /** Position of the message in the conversation (0 = oldest). */
    readonly index: number;
    /** 1 = quoted by the last message, 2 = quoted inside that quote, ... */
    readonly generation: number;
    /** Number of ">" markers on the header's first line. */
    readonly depth: number;
    /** Number of ">" markers on the lines of its own text. */
    readonly textDepth: number;
    readonly kind: 'reply' | 'forward';
    /** The style that wrote this header (the quoting message's style). */
    readonly style: QuoteStyle;
    /** Offset of the first header line (at a line start, quote markers included). */
    readonly start: number;
    /** End of the last header line, line break included. */
    readonly headEnd: number;
    /** [ownStart, ownEnd): the message's own text as rendered (with its quote markers), no trailing line break. */
    readonly ownStart: number;
    readonly ownEnd: number;
    /** The message's own text as written (no quote markers). */
    readonly ownText: string;
    readonly fields: ExpectedFields;
    readonly sender: Person;
    readonly to: readonly Person[];
    readonly cc: readonly Person[];
    readonly subject: string;
    /** The sending moment, ISO 8601 in UTC ("2025-03-03T05:02:00.000Z"). */
    readonly instantUtc: string;
    /** The zone the header's date is shown in (the quoting message's zone). */
    readonly shownIn: Zone;
}

export interface BuiltThread
{
    /** Body of the last message, "\n" line breaks, ends with one "\n". */
    readonly body: string;
    /** Subject of the last message (findReplyHeaders uses it to spot a forward). */
    readonly subject: string;
    /** One entry per earlier message, newest first (= in body order). */
    readonly headers: readonly ExpectedHeader[];
    /** The last message's own text: [0, ownEnd). */
    readonly ownEnd: number;
    /** The last message's sending moment, ISO 8601 in UTC (later than every header's). */
    readonly instantUtc: string;
}

// ---------------------------------------------------------------------------
// Dates

const EN_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const FR_DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const FR_MONTHS = ['janvier', 'f\u00e9vrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'ao\u00fbt', 'septembre', 'octobre', 'novembre', 'd\u00e9cembre'];
const NL_DAYS = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
const NL_DAYS_SHORT = ['zo', 'ma', 'di', 'wo', 'do', 'vr', 'za'];
const NL_MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const NL_MONTHS_SHORT = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

const pick = (list: readonly string[], i: number): string => list[i] ?? '?';
const two = (n: number): string => String(n).padStart(2, '0');

/** Milliseconds since the epoch of a wall time in a zone. */
export function instantOf(wall: WallTime, zone: Zone): number
{
    return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) - zone.offsetMinutes * 60_000;
}

/** The wall time of an instant (milliseconds since the epoch) in a zone; the inverse of instantOf (seconds dropped). */
export function wallTimeOf(instant: number, zone: Zone): WallTime
{
    const d = new Date(instant + zone.offsetMinutes * 60_000);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

/** The parts of an instant as seen in a zone. */
interface Shown
{
    readonly year: number;
    readonly month: number; // 0-11
    readonly day: number;
    readonly weekday: number; // 0 = Sunday
    readonly hour: number;
    readonly minute: number;
}

function shownIn(instant: number, zone: Zone): Shown
{
    const d = new Date(instant + zone.offsetMinutes * 60_000);
    return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate(), weekday: d.getUTCDay(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

/** "9:15 AM" */
function clock12(s: Shown): string
{
    const h = s.hour % 12 === 0 ? 12 : s.hour % 12;
    return `${h}:${two(s.minute)} ${s.hour < 12 ? 'AM' : 'PM'}`;
}

/** "14:02" */
const clock24 = (s: Shown): string => `${two(s.hour)}:${two(s.minute)}`;

/** "GMT+9", "GMT+5:45", "GMT-11" */
function gmtOffset(zone: Zone): string
{
    const sign = zone.offsetMinutes < 0 ? '-' : '+';
    const abs = Math.abs(zone.offsetMinutes);
    const minutes = abs % 60;
    return `GMT${sign}${Math.floor(abs / 60)}${minutes === 0 ? '' : `:${two(minutes)}`}`;
}

type DateFormat =
    | 'outlook-en'
    | 'outlook-fr'
    | 'outlook-nl'
    | 'gmail-en'
    | 'gmail-en-gb'
    | 'gmail-fr'
    | 'gmail-nl'
    | 'apple-en'
    | 'apple-fr'
    | 'apple-nl'
    | 'apple-forward-en'
    | 'thunderbird';

/** A date as a client writes it in a quote header. */
export function formatQuotedDate(format: DateFormat, instant: number, zone: Zone): string
{
    const s = shownIn(instant, zone);
    switch (format)
    {
        case 'outlook-en': // "Monday, March 3, 2025 9:15 AM"
            return `${pick(EN_DAYS, s.weekday)}, ${pick(EN_MONTHS, s.month)} ${s.day}, ${s.year} ${clock12(s)}`;
        case 'outlook-fr': // "lundi 3 mars 2025 15:40"
            return `${pick(FR_DAYS, s.weekday)} ${s.day} ${pick(FR_MONTHS, s.month)} ${s.year} ${clock24(s)}`;
        case 'outlook-nl': // "maandag 3 maart 2025 15:40"
            return `${pick(NL_DAYS, s.weekday)} ${s.day} ${pick(NL_MONTHS, s.month)} ${s.year} ${clock24(s)}`;
        case 'gmail-en': // "Mon, Mar 3, 2025 at 2:02 PM"
            return `${pick(EN_DAYS, s.weekday).slice(0, 3)}, ${pick(EN_MONTHS, s.month).slice(0, 3)} ${s.day}, ${s.year} at ${clock12(s)}`;
        case 'gmail-en-gb': // "Mon, 3 Mar 2025 at 14:02"
            return `${pick(EN_DAYS, s.weekday).slice(0, 3)}, ${s.day} ${pick(EN_MONTHS, s.month).slice(0, 3)} ${s.year} at ${clock24(s)}`;
        case 'gmail-fr': // "lun. 3 mars 2025 \u00e0 14:02"
            return `${pick(FR_DAYS, s.weekday).slice(0, 3)}. ${s.day} ${pick(FR_MONTHS, s.month)} ${s.year} \u00e0 ${clock24(s)}`;
        case 'gmail-nl': // "ma 3 mrt 2025 om 14:02"
            return `${pick(NL_DAYS_SHORT, s.weekday)} ${s.day} ${pick(NL_MONTHS_SHORT, s.month)} ${s.year} om ${clock24(s)}`;
        case 'apple-en': // "3 Mar 2025, at 14:02"
            return `${s.day} ${pick(EN_MONTHS, s.month).slice(0, 3)} ${s.year}, at ${clock24(s)}`;
        case 'apple-fr': // "3 mars 2025 \u00e0 14:02"
            return `${s.day} ${pick(FR_MONTHS, s.month)} ${s.year} \u00e0 ${clock24(s)}`;
        case 'apple-nl': // "3 mrt. 2025 om 14:02"
            return `${s.day} ${pick(NL_MONTHS_SHORT, s.month)}. ${s.year} om ${clock24(s)}`;
        case 'apple-forward-en': // "3 March 2025 at 14:02:00 GMT+9"
            // UNCERTAIN (not checked against a real Apple Mail): this is an
            // en-GB-like form; an en-US system would likely write
            // "March 3, 2025 at 2:02:00 PM GMT+9".
            return `${s.day} ${pick(EN_MONTHS, s.month)} ${s.year} at ${clock24(s)}:00 ${gmtOffset(zone)}`;
        case 'thunderbird': // "03/03/2025 14:02"
            // UNCERTAIN (not checked against a real Thunderbird): the date follows
            // the system locale; this is an en-GB-like form, en-US would be
            // "3/3/25 12:58 PM".
            return `${two(s.day)}/${two(s.month + 1)}/${s.year} ${clock24(s)}`;
    }
}

// ---------------------------------------------------------------------------
// Header lines per style

interface Line
{
    readonly text: string;
    /** Number of ">" markers added by quoting. */
    readonly depth: number;
    /** Index of the message the line belongs to. */
    readonly owner: number;
    readonly part: 'own' | 'header' | 'gap';
}

/** One label line, wrapped at spaces when longer than `wrapAt`. */
function wrapLine(text: string, wrapAt: number | undefined): string[]
{
    if (wrapAt === undefined)
    {
        return [text];
    }
    const out: string[] = [];
    let rest = text;
    while (rest.length > wrapAt)
    {
        const cut = rest.lastIndexOf(' ', wrapAt);
        if (cut <= 0)
        {
            break;
        }
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut + 1);
    }
    out.push(rest);
    return out;
}

type PeopleStyle = NonNullable<QuoteOptions['people']>;

function person(p: Person, how: PeopleStyle): string
{
    if (how === 'name')
    {
        return p.name;
    }
    if (how === 'mailto')
    {
        return `${p.name} [mailto:${p.address}]`;
    }
    return `${p.name} <${p.address}>`;
}

interface BlockSpec
{
    /** Intro line(s) above the labels ('' = a blank line). */
    readonly intro: readonly string[];
    readonly date: DateFormat;
    /** Label text with its colon and spacing, per role, in the order written. */
    readonly labels: readonly (readonly ['from' | 'date' | 'to' | 'cc' | 'subject', string])[];
    /** Separator between several people. */
    readonly join: string;
}

const UNDERSCORES = '_'.repeat(32);
const OUTLOOK_EN_LABELS = [['from', 'From: '], ['date', 'Sent: '], ['to', 'To: '], ['cc', 'Cc: '], ['subject', 'Subject: ']] as const;
const OUTLOOK_FR_LABELS = [['from', 'De : '], ['date', 'Envoy\u00e9 : '], ['to', '\u00c0 : '], ['cc', 'Cc : '], ['subject', 'Objet : ']] as const;
const OUTLOOK_NL_LABELS = [['from', 'Van: '], ['date', 'Verzonden: '], ['to', 'Aan: '], ['cc', 'CC: '], ['subject', 'Onderwerp: ']] as const;

const BLOCKS: Partial<Record<QuoteStyle, BlockSpec>> = {
    'outlook-en': { intro: [UNDERSCORES], date: 'outlook-en', labels: OUTLOOK_EN_LABELS, join: '; ' },
    'outlook-fr': { intro: [UNDERSCORES], date: 'outlook-fr', labels: OUTLOOK_FR_LABELS, join: '; ' },
    'outlook-nl': { intro: [UNDERSCORES], date: 'outlook-nl', labels: OUTLOOK_NL_LABELS, join: '; ' },
    'outlook-forward-en': { intro: [UNDERSCORES], date: 'outlook-en', labels: OUTLOOK_EN_LABELS, join: '; ' },
    'outlook-forward-fr': { intro: [UNDERSCORES], date: 'outlook-fr', labels: OUTLOOK_FR_LABELS, join: '; ' },
    'outlook-original-en': { intro: ['-----Original Message-----'], date: 'outlook-en', labels: OUTLOOK_EN_LABELS, join: '; ' },
    'outlook-original-fr': { intro: ["-----Message d'origine-----"], date: 'outlook-fr', labels: OUTLOOK_FR_LABELS, join: '; ' },
    'outlook-original-nl': { intro: ['-----Oorspronkelijk bericht-----'], date: 'outlook-nl', labels: OUTLOOK_NL_LABELS, join: '; ' },
    'gmail-forward-en': {
        intro: ['---------- Forwarded message ---------'],
        date: 'gmail-en',
        labels: [['from', 'From: '], ['date', 'Date: '], ['subject', 'Subject: '], ['to', 'To: '], ['cc', 'Cc: ']],
        join: ', ',
    },
    // UNCERTAIN (not checked against a real Gmail): the French and Dutch
    // forward intros and labels below are guesses; real Gmail may keep the
    // English "Forwarded message" / From / Date / Subject / To labels in
    // other interface languages.
    'gmail-forward-fr': {
        intro: ['---------- Message transf\u00e9r\u00e9 ---------'],
        date: 'gmail-fr',
        labels: [['from', 'De : '], ['date', 'Date : '], ['subject', 'Objet : '], ['to', '\u00c0 : '], ['cc', 'Cc : ']],
        join: ', ',
    },
    'gmail-forward-nl': {
        intro: ['---------- Doorgestuurd bericht ---------'],
        date: 'gmail-nl',
        labels: [['from', 'Van: '], ['date', 'Datum: '], ['subject', 'Onderwerp: '], ['to', 'Aan: '], ['cc', 'CC: ']],
        join: ', ',
    },
    'apple-forward-en': {
        intro: ['Begin forwarded message:', ''],
        date: 'apple-forward-en',
        labels: [['from', 'From: '], ['subject', 'Subject: '], ['date', 'Date: '], ['to', 'To: '], ['cc', 'Cc: ']],
        join: ', ',
    },
};

/** Attribution styles: the line written above (or at the top of) the ">" quote. */
const ATTRIBUTIONS: Partial<Record<QuoteStyle, { readonly date: DateFormat; readonly line: (date: string, who: Person) => { text: string; from: string } }>> = {
    'gmail-en': { date: 'gmail-en', line: (d, p) => ({ text: `On ${d} ${person(p, 'angle')} wrote:`, from: person(p, 'angle') }) },
    'gmail-en-gb': { date: 'gmail-en-gb', line: (d, p) => ({ text: `On ${d}, ${person(p, 'angle')} wrote:`, from: person(p, 'angle') }) },
    'gmail-fr': { date: 'gmail-fr', line: (d, p) => ({ text: `Le ${d}, ${person(p, 'angle')} a \u00e9crit :`, from: person(p, 'angle') }) },
    'gmail-nl': { date: 'gmail-nl', line: (d, p) => ({ text: `Op ${d} schreef ${person(p, 'angle')}:`, from: person(p, 'angle') }) },
    'apple-en': { date: 'apple-en', line: (d, p) => ({ text: `On ${d}, ${person(p, 'angle')} wrote:`, from: person(p, 'angle') }) },
    'apple-fr': { date: 'apple-fr', line: (d, p) => ({ text: `Le ${d}, ${person(p, 'angle')} a \u00e9crit :`, from: person(p, 'angle') }) },
    'apple-nl': { date: 'apple-nl', line: (d, p) => ({ text: `Op ${d} heeft ${person(p, 'angle')} het volgende geschreven:`, from: person(p, 'angle') }) },
    'thunderbird-en': { date: 'thunderbird', line: (d, p) => ({ text: `On ${d}, ${p.name} wrote:`, from: p.name }) },
};

/** How a style places the old body: below an unquoted block, below an attribution with ">", or with the attribution inside ">". */
function layoutOf(style: QuoteStyle): 'block' | 'attribution' | 'apple'
{
    if (BLOCKS[style] !== undefined)
    {
        return 'block';
    }
    return style.startsWith('apple-') ? 'apple' : 'attribution';
}

/** The header lines one style writes for message `quoted`, shown in `zone`, plus the fields as written. */
function headerFor(quoted: ThreadMessage, options: QuoteOptions, zone: Zone): { lines: string[]; fields: ExpectedFields }
{
    const instant = instantOf(quoted.sent, quoted.zone);
    const block = BLOCKS[options.style];
    if (block !== undefined)
    {
        const how = options.people ?? 'angle';
        const values: Record<'from' | 'date' | 'to' | 'cc' | 'subject', string | undefined> = {
            from: person(quoted.from, how),
            date: formatQuotedDate(block.date, instant, zone),
            to: quoted.to.map((p) => person(p, how)).join(block.join),
            cc: quoted.cc === undefined || quoted.cc.length === 0 ? undefined : quoted.cc.map((p) => person(p, how)).join(block.join),
            subject: quoted.subject,
        };
        const lines = [...block.intro];
        for (const [role, label] of block.labels)
        {
            const value = values[role];
            if (value !== undefined)
            {
                lines.push(...wrapLine(`${label}${value}`, options.wrapAt));
            }
        }
        const fields: ExpectedFields = {
            from: values.from ?? '',
            date: values.date ?? '',
            to: values.to,
            subject: values.subject,
            ...(values.cc === undefined ? {} : { cc: values.cc }),
        };
        return { lines, fields };
    }
    const attribution = ATTRIBUTIONS[options.style];
    if (attribution === undefined)
    {
        throw new Error(`unknown style ${options.style}`);
    }
    const date = formatQuotedDate(attribution.date, instant, zone);
    const { text, from } = attribution.line(date, quoted.from);
    return { lines: wrapLine(text, options.wrapAt), fields: { from, date } };
}

/**
 * Adds one ">" level the way the style does: Gmail/Thunderbird ">>" nesting,
 * Apple "> >". UNCERTAIN (not checked against real clients): plain-text
 * copies of both are seen in either form; the split here is a guess that
 * gives the case set both shapes.
 */
function quoteLines(lines: readonly Line[], style: QuoteStyle): Line[]
{
    const apple = style.startsWith('apple-');
    return lines.map((line) =>
    {
        let text: string;
        if (line.text === '')
        {
            text = '>';
        }
        else if (!apple && line.text.startsWith('>'))
        {
            text = `>${line.text}`;
        }
        else
        {
            text = `> ${line.text}`;
        }
        return { ...line, text, depth: line.depth + 1 };
    });
}

const ownLines = (text: string, owner: number): Line[] => text.split('\n').map((t) => ({ text: t, depth: 0, owner, part: t === '' ? 'gap' : 'own' }));

/** Removes `depth` quote levels ("> " or ">") from each line of `rendered`. */
export function unquote(rendered: string, depth: number): string
{
    if (depth === 0)
    {
        return rendered;
    }
    const prefix = new RegExp(`^(?:> ?){${depth}}`);
    return rendered
        .split('\n')
        .map((line) => line.replace(prefix, ''))
        .join('\n');
}

/** Builds the last message's body and the ground truth (see the file comment). */
export function buildThread(messages: readonly ThreadMessage[]): BuiltThread
{
    const last = messages[messages.length - 1];
    if (last === undefined)
    {
        throw new Error('empty conversation');
    }
    for (const m of messages)
    {
        if (m.text.split('\n').some((line) => line.startsWith('>') || line.startsWith(' ')))
        {
            throw new Error(`own text must not start a line with ">" or a space: ${m.text}`);
        }
    }
    let lines: Line[] = ownLines(messages[0]?.text ?? '', 0);
    const fieldsOf = new Map<number, ExpectedFields>();
    for (let i = 1; i < messages.length; i++)
    {
        const msg = messages[i];
        const prev = messages[i - 1];
        if (msg === undefined || prev === undefined)
        {
            throw new Error('unreachable');
        }
        if (msg.quote === undefined)
        {
            throw new Error(`message ${i} has no quote style`);
        }
        const style = msg.quote.style;
        const { lines: head, fields } = headerFor(prev, msg.quote, msg.zone);
        fieldsOf.set(i - 1, fields);
        const header: Line[] = head.map((text) => ({ text, depth: 0, owner: i - 1, part: 'header' }));
        const gap: Line = { text: '', depth: 0, owner: i, part: 'gap' };
        const layout = layoutOf(style);
        if (layout === 'block')
        {
            lines = [...ownLines(msg.text, i), gap, ...header, { ...gap, owner: i - 1 }, ...lines];
        }
        else if (layout === 'attribution')
        {
            lines = [...ownLines(msg.text, i), gap, ...header, ...quoteLines(lines, style)];
        }
        else
        {
            lines = [...ownLines(msg.text, i), gap, ...quoteLines([...header, { ...gap, owner: i - 1 }, ...lines], style)];
        }
    }

    const starts: number[] = [];
    let offset = 0;
    for (const line of lines)
    {
        starts.push(offset);
        offset += line.text.length + 1;
    }
    const body = `${lines.map((l) => l.text).join('\n')}\n`;
    const endOf = (k: number): number => (starts[k] ?? 0) + (lines[k]?.text.length ?? 0);

    const headers: ExpectedHeader[] = [];
    for (let j = messages.length - 2; j >= 0; j--)
    {
        const msg = messages[j];
        const quoting = messages[j + 1];
        const fields = fieldsOf.get(j);
        if (msg === undefined || quoting?.quote === undefined || fields === undefined)
        {
            throw new Error('unreachable');
        }
        const headIdx = lines.flatMap((l, k) => (l.owner === j && l.part === 'header' ? [k] : []));
        const ownIdx = lines.flatMap((l, k) => (l.owner === j && l.part === 'own' ? [k] : []));
        const h0 = headIdx[0];
        const h1 = headIdx[headIdx.length - 1];
        const o0 = ownIdx[0];
        const o1 = ownIdx[ownIdx.length - 1];
        if (h0 === undefined || h1 === undefined || o0 === undefined || o1 === undefined)
        {
            throw new Error(`message ${j}: no header or no text`);
        }
        headers.push({
            index: j,
            generation: messages.length - 1 - j,
            depth: lines[h0]?.depth ?? 0,
            textDepth: lines[o0]?.depth ?? 0,
            kind: isForwardStyle(quoting.quote.style) ? 'forward' : 'reply',
            style: quoting.quote.style,
            start: starts[h0] ?? 0,
            headEnd: endOf(h1) + 1,
            ownStart: starts[o0] ?? 0,
            ownEnd: endOf(o1),
            ownText: msg.text,
            fields,
            sender: msg.from,
            to: msg.to,
            cc: msg.cc ?? [],
            subject: msg.subject,
            instantUtc: new Date(instantOf(msg.sent, msg.zone)).toISOString(),
            shownIn: quoting.zone,
        });
    }
    const lastOwn = lines.flatMap((l, k) => (l.owner === messages.length - 1 && l.part === 'own' ? [k] : []));
    return {
        body,
        subject: last.subject,
        headers,
        ownEnd: endOf(lastOwn[lastOwn.length - 1] ?? 0),
        instantUtc: new Date(instantOf(last.sent, last.zone)).toISOString(),
    };
}
