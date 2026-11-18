// The case set for thread reconstruction (milestone 7): conversations built
// with thread-builder.ts, grouped by the style under test, plus negative
// bodies where nothing (or nothing safe) can be rebuilt. Used by the
// measurement test (Source/thread-analysis/reconstruct-quoted-messages.measure.test.ts) and the builder's
// own test. Synthetic data only (README.md, rule R7).

import { buildThread, isForwardStyle, wallTimeOf, type BuiltThread, type ExpectedHeader, type Person, type QuoteOptions, type QuoteStyle, type ThreadMessage, type Zone } from './thread-builder';

export const ALICE: Person = { name: 'Alice Example', address: 'alice@example.test' };
export const BOB: Person = { name: 'Bob Sample', address: 'bob@furniture.example.test' };
export const CAROL: Person = { name: 'Carol Test', address: 'carol@sample.invalid' };
export const DAVE: Person = { name: 'Dave Placeholder', address: 'dave@example.test' };
export const ERIN: Person = { name: 'Erin Fictive', address: 'erin@sample.invalid' };
/** Extra recipients, for long To/Cc values. */
export const CROWD: readonly Person[] = [
    { name: 'Frank Mockup', address: 'frank.mockup@example.test' },
    { name: 'Grace Dummy', address: 'grace.dummy@example.test' },
    { name: 'Heidi Stub', address: 'heidi.stub@sample.invalid' },
    { name: 'Ivan Fixture', address: 'ivan.fixture@example.test' },
    { name: 'Judy Synthetic', address: 'judy.synthetic@sample.invalid' },
];

export const TOKYO: Zone = { name: 'Asia/Tokyo', offsetMinutes: 540 };
export const LAGOS: Zone = { name: 'Africa/Lagos', offsetMinutes: 60 };
export const KOLKATA: Zone = { name: 'Asia/Kolkata', offsetMinutes: 330 };
export const KATHMANDU: Zone = { name: 'Asia/Kathmandu', offsetMinutes: 345 };
export const UTC: Zone = { name: 'Etc/UTC', offsetMinutes: 0 };
export const PAGO_PAGO: Zone = { name: 'Pacific/Pago_Pago', offsetMinutes: -660 };

const ZONES: readonly Zone[] = [LAGOS, TOKYO, KOLKATA, UTC, KATHMANDU, PAGO_PAGO];
const PEOPLE: readonly Person[] = [ALICE, BOB, CAROL, DAVE, ERIN];

/** Own texts, used in turn. No line starts with ">" or looks like a header label. */
const SENTENCES: readonly string[] = [
    'We are furnishing a small office for four people and need four desks\nand four chairs. Could you send me a quote?',
    'Thank you for your message. I can come by on Wednesday at 10:00\nto measure the room.',
    'Wednesday works for me. Someone will open the side door.',
    'The quote is attached: four desks and four chairs, delivery included.',
    'That looks fine. Please plan the delivery for next week.',
    'Delivery is planned for Thursday morning between 8:00 and 12:00.',
    'Thursday is confirmed. Please ring at the side door.',
    'The desks arrived in good condition. Thank you!',
    'Glad to hear it. The invoice will follow by post.',
];

function ownText(k: number, from: Person, to: Person): string
{
    const first = to.name.split(' ')[0] ?? 'there';
    const sentence = SENTENCES[k % SENTENCES.length] ?? '';
    return `Hello ${first},\n\n${sentence}\n\nBest regards,\n${from.name.split(' ')[0] ?? ''}`;
}

/**
 * Reply or forward prefix the quoting client puts on the subject.
 * UNCERTAIN (not checked against a real Outlook): French Outlook is taken to
 * write "RE :" and "TR :" (space before the colon, French typography);
 * English and Dutch Outlook "RE:" and "FW:".
 */
function nextSubject(prev: string, style: QuoteStyle): string
{
    const frenchOutlook = style.startsWith('outlook') && style.endsWith('-fr');
    if (isForwardStyle(style))
    {
        if (style === 'outlook-forward-fr')
        {
            return `TR : ${prev}`;
        }
        return `${style === 'outlook-forward-en' ? 'FW' : 'Fwd'}: ${prev}`;
    }
    if (/^(re|aw|antw) ?:/i.test(prev))
    {
        return prev;
    }
    if (frenchOutlook)
    {
        return `RE : ${prev}`;
    }
    const prefix = style.startsWith('outlook') ? 'RE' : 'Re';
    return `${prefix}: ${prev}`;
}

/** Default moment of a chain's first message: 2025-03-03 08:15 UTC (a Monday). */
const DEFAULT_START = Date.UTC(2025, 2, 3, 8, 15);
/** Time between two messages of a chain: 5 h 07 min (the same UTC step for every sender, whatever their zone). */
const STEP = (5 * 60 + 7) * 60_000;

export interface ChainOptions
{
    /** Senders in turn (default Alice and Bob). */
    readonly people?: readonly Person[];
    /** Zones in turn (default a rotation of neutral zones). */
    readonly zones?: readonly Zone[];
    /** Extra options for every quote (people style, wrapping). */
    readonly quote?: Omit<QuoteOptions, 'style'>;
    /** Cc on every message. */
    readonly cc?: readonly Person[];
    /** Extra To recipients on every message. */
    readonly moreTo?: readonly Person[];
    readonly subject?: string;
    /** Moment of the first message, milliseconds since the epoch (default DEFAULT_START). */
    readonly start?: number;
}

/** A conversation of styles.length + 1 messages; message i quotes message i-1 with styles[i-1]. */
export function chain(styles: readonly QuoteStyle[], options: ChainOptions = {}): ThreadMessage[]
{
    const people = options.people ?? [ALICE, BOB];
    const zones = options.zones ?? ZONES;
    const messages: ThreadMessage[] = [];
    let subject = options.subject ?? 'Office desks and chairs';
    for (let i = 0; i <= styles.length; i++)
    {
        const from = people[i % people.length] ?? ALICE;
        const to = people[(i + 1) % people.length] ?? BOB;
        const style = i === 0 ? undefined : styles[i - 1];
        if (style !== undefined)
        {
            subject = nextSubject(subject, style);
        }
        // Step the UTC moment, then write it in the sender's zone: stepping the
        // wall clock instead would put a reply before the message it answers
        // when the senders are in different zones.
        const zone = zones[i % zones.length] ?? UTC;
        messages.push({
            from,
            to: [to, ...(options.moreTo ?? [])],
            ...(options.cc === undefined ? {} : { cc: options.cc }),
            sent: wallTimeOf((options.start ?? DEFAULT_START) + i * STEP, zone),
            zone,
            subject,
            text: ownText(i, from, to),
            ...(style === undefined ? {} : { quote: { ...options.quote, style } }),
        });
    }
    return messages;
}

/** One positive case: a built conversation and the group it is measured in. */
export interface ThreadCase
{
    readonly id: string;
    /** Measurement group (one row of the table). */
    readonly group: string;
    readonly thread: BuiltThread;
    /**
     * The conversation, oldest first (thread = buildThread(messages)). Lets a
     * test drop earlier messages as real files (buildThread of a prefix).
     * Absent where the built body was edited afterwards (REFUSAL_COST_CASES).
     */
    readonly messages?: readonly ThreadMessage[];
}

const repeat = (style: QuoteStyle, n: number): QuoteStyle[] => Array.from({ length: n }, () => style);

const REPLY_STYLES: readonly QuoteStyle[] = ['outlook-en', 'gmail-fr', 'apple-en', 'outlook-nl', 'thunderbird-en', 'gmail-nl', 'outlook-fr', 'apple-nl', 'gmail-en', 'apple-fr'];

function makeCases(): ThreadCase[]
{
    const c = (group: string, id: string, messages: readonly ThreadMessage[]): ThreadCase => ({ id, group, thread: buildThread(messages), messages });
    return [
        // Outlook classic, one language per chain, no ">".
        c('outlook-en', 'outlook-en x3', chain(repeat('outlook-en', 3))),
        c('outlook-en', 'outlook-en names only', chain(repeat('outlook-en', 2), { quote: { people: 'name' } })),
        c('outlook-en', 'outlook-en mailto + cc', chain(repeat('outlook-en', 2), { quote: { people: 'mailto' }, cc: [CAROL] })),
        c('outlook-en', 'outlook-original-en x2', chain(repeat('outlook-original-en', 2))),
        c('outlook-fr', 'outlook-fr x3', chain(repeat('outlook-fr', 3), { cc: [CAROL] })),
        c('outlook-fr', 'outlook-fr names only', chain(repeat('outlook-fr', 2), { quote: { people: 'name' } })),
        c('outlook-fr', 'outlook-original-fr x2', chain(repeat('outlook-original-fr', 2))),
        c('outlook-nl', 'outlook-nl x3', chain(repeat('outlook-nl', 3))),
        c('outlook-nl', 'outlook-nl names only + cc', chain(repeat('outlook-nl', 2), { quote: { people: 'name' }, cc: [DAVE] })),
        c('outlook-nl', 'outlook-original-nl x2', chain(repeat('outlook-original-nl', 2))),
        // Long To/Cc values wrapped over several lines.
        c('outlook-wrapped', 'outlook-en wrapped to/cc', chain(repeat('outlook-en', 3), { moreTo: CROWD, cc: [CAROL, DAVE, ERIN], quote: { wrapAt: 76 } })),
        c('outlook-wrapped', 'outlook-fr wrapped to/cc', chain(repeat('outlook-fr', 2), { moreTo: CROWD.slice(0, 3), cc: [ERIN, ...CROWD.slice(3)], quote: { wrapAt: 76 } })),
        c('outlook-wrapped', 'outlook-nl wrapped names only', chain(repeat('outlook-nl', 2), { moreTo: CROWD, quote: { people: 'name', wrapAt: 60 } })),
        // Gmail: attribution line + ">" quote, nested ">>".
        c('gmail-en', 'gmail-en x3', chain(repeat('gmail-en', 3))),
        c('gmail-en', 'gmail-en wrapped attribution', chain(repeat('gmail-en', 2), { quote: { wrapAt: 60 } })),
        c('gmail-en', 'gmail-en-gb x3', chain(repeat('gmail-en-gb', 3))),
        c('gmail-fr', 'gmail-fr x3', chain(repeat('gmail-fr', 3))),
        c('gmail-fr', 'gmail-fr wrapped attribution', chain(repeat('gmail-fr', 2), { quote: { wrapAt: 60 } })),
        c('gmail-nl', 'gmail-nl x3', chain(repeat('gmail-nl', 3))),
        // Apple Mail: attribution inside the quote.
        c('apple', 'apple-en x3', chain(repeat('apple-en', 3))),
        c('apple', 'apple-fr x2', chain(repeat('apple-fr', 2))),
        c('apple', 'apple-nl x2', chain(repeat('apple-nl', 2))),
        // Thunderbird: numeric date, name only.
        c('thunderbird', 'thunderbird-en x3', chain(repeat('thunderbird-en', 3))),
        // Mixed clients. The first one has the shape of fixture 13 (Outlook NL
        // over a Gmail quote over an Outlook EN block).
        c('mixed', 'fixture-13 shape', chain(['outlook-en', 'gmail-en', 'outlook-nl'])),
        c('mixed', 'gmail-fr/apple/outlook-fr/thunderbird', chain(['gmail-fr', 'apple-en', 'outlook-fr', 'thunderbird-en'], { people: [ALICE, BOB, CAROL] })),
        c('mixed', 'apple-nl/outlook-en/gmail-nl', chain(['apple-nl', 'outlook-en', 'gmail-nl'], { people: [CAROL, DAVE] })),
        c('mixed', 'outlook over gmail over outlook (original)', chain(['gmail-en', 'outlook-original-en', 'gmail-en', 'outlook-fr'], { people: [ALICE, BOB, ERIN] })),
        // Deep nesting.
        c('deep', 'gmail-en 6 generations', chain(repeat('gmail-en', 6), { people: PEOPLE })),
        c('deep', 'outlook-en 7 generations', chain(repeat('outlook-en', 7), { people: PEOPLE })),
        c('deep', 'mixed 8 generations', chain(REPLY_STYLES.slice(0, 8), { people: PEOPLE })),
        c('deep', 'apple-en 5 generations', chain(repeat('apple-en', 5), { people: [ALICE, BOB, CAROL] })),
        // Forwards.
        c('forward', 'gmail forward of an outlook thread', chain(['outlook-en', 'gmail-forward-en'], { people: [ALICE, BOB, CAROL] })),
        c('forward', 'apple forward of a gmail thread', chain(['gmail-en', 'apple-forward-en'], { people: [ALICE, BOB, CAROL] })),
        c('forward', 'outlook forward (FW: subject)', chain(['outlook-en', 'outlook-forward-en'], { people: [ALICE, BOB, DAVE] })),
        c('forward', 'gmail-fr forward, then outlook-fr reply', chain(['gmail-forward-fr', 'outlook-fr'], { people: [ALICE, BOB, CAROL] })),
        c('forward', 'gmail-nl forward', chain(['gmail-en', 'gmail-forward-nl'], { people: [ALICE, BOB, DAVE] })),
        c('forward', 'forward in the middle', chain(['gmail-en', 'gmail-forward-en', 'gmail-en'], { people: [ALICE, BOB, CAROL] })),
        c('forward', 'outlook forward in the middle', chain(['outlook-en', 'outlook-forward-en', 'outlook-en'], { people: [ALICE, BOB, CAROL] })),
        c('forward', 'outlook-fr forward (TR : subject)', chain(['outlook-fr', 'outlook-forward-fr'], { people: [ALICE, BOB, CAROL] })),
        // Other dates: accented months (f\u00e9vrier, ao\u00fbt, d\u00e9cembre) and a
        // conversation running from 31 December 2025 into 1 January 2026. The
        // zones have no daylight saving time, so their offsets hold all year.
        c('dates', 'outlook-fr in February', chain(repeat('outlook-fr', 2), { start: Date.UTC(2025, 1, 14, 9, 30) })),
        c('dates', 'gmail-fr and apple-fr in August', chain(['gmail-fr', 'apple-fr', 'gmail-fr'], { start: Date.UTC(2025, 7, 15, 6, 45), people: [ALICE, BOB, CAROL] })),
        c('dates', 'mixed, 31 December into 1 January', chain(['outlook-fr', 'gmail-nl', 'thunderbird-en', 'apple-en', 'gmail-en-gb'], { start: Date.UTC(2025, 11, 31, 13, 40), people: PEOPLE })),
    ];
}

export const THREAD_CASES: readonly ThreadCase[] = makeCases();

/** Shifts every offset of a header at or after `at` by `delta` (the text before `at` is unchanged). */
function shiftHeader(h: ExpectedHeader, at: number, delta: number): ExpectedHeader
{
    const s = (n: number): number => (n >= at ? n + delta : n);
    return { ...h, start: s(h.start), headEnd: s(h.headEnd), ownStart: s(h.ownStart), ownEnd: s(h.ownEnd) };
}

/**
 * Real threads in shapes the splitter (task 7.4) refuses on purpose, so the
 * recall cost of "drop the holder on refusal" stays visible. Measured apart
 * (Source/thread-analysis/reconstruct-quoted-messages.measure.test.ts), NOT in the per-style recall
 * targets of THREAD_CASES. The builder forbids own text with ">" lines or
 * no own text, so both bodies are built, then edited; the ground truth is
 * edited with them.
 * - a quoted message that quotes a list itself ("> Here is what the agent
 *   wrote:" then "> > ..."): the list's bare "wrote:" line is a weak header
 *   (no sender, no date), so its holder and every older message are dropped;
 * - a Gmail attribution followed directly by a quoted "-----Original
 *   Message-----" block (passed on without a comment): the attribution has no
 *   text of its own, so its body depth cannot be read and it is refused.
 */
function makeRefusalCostCases(): ThreadCase[]
{
    const group = 'refusal-cost';
    // (a) Message 1 holds a ">" list. "@ " stands for "> " while building (same length: no offset moves).
    const listed = chain(repeat('gmail-en', 2)).map((m, i) =>
        i === 1 ? { ...m, text: 'Hello Alice,\n\nHere is what the agent wrote:\n@ keys for the side door\n@ parking card\n\nBest regards,\nBob' } : m,
    );
    const a = buildThread(listed);
    const listBody = a.body.replace(/^> @ /gmu, '> > ');
    const listThread: BuiltThread = {
        ...a,
        body: listBody,
        headers: a.headers.map((h) => ({ ...h, ownText: h.ownText.replace(/^@ /gmu, '> ') })),
    };

    // (b) Message 1 forwards message 0 with no comment: its own text (a placeholder line and the gap after it) is cut out.
    const placeholder = 'PLACEHOLDER-NO-COMMENT';
    const passed = chain(['outlook-original-en', 'gmail-en']).map((m, i) => (i === 1 ? { ...m, text: placeholder } : m));
    const b = buildThread(passed);
    const cut = `> ${placeholder}\n>\n`;
    const at = b.body.indexOf(cut);
    if (at < 0 || b.body.indexOf(cut, at + 1) >= 0)
    {
        throw new Error('refusal-cost: placeholder not found once');
    }
    const passedThread: BuiltThread = {
        ...b,
        body: b.body.slice(0, at) + b.body.slice(at + cut.length),
        headers: b.headers.map((h) =>
        {
            const moved = shiftHeader(h, at + cut.length, -cut.length);
            return h.ownText === placeholder ? { ...moved, ownStart: at, ownEnd: at, ownText: '' } : moved;
        }),
    };

    return [
        { id: 'quoted message quoting a ">" list after "wrote:"', group, thread: listThread },
        { id: 'gmail reply over "-----Original Message-----" with no comment', group, thread: passedThread },
    ];
}

export const REFUSAL_COST_CASES: readonly ThreadCase[] = makeRefusalCostCases();

/**
 * A body where splitting must NOT happen.
 * - 'no-header': nothing in it is a quote header; any boundary found is a false split.
 * - 'refuse': it does quote an earlier email, but in a shape a splitter must
 *   refuse to cut into messages (interleaved answers, bottom-posting). Folding
 *   the real header is fine; `realHeaders` lists where those headers start.
 */
export interface NegativeCase
{
    readonly id: string;
    readonly expect: 'no-header' | 'refuse';
    readonly body: string;
    readonly subject: string;
    readonly realHeaders: readonly number[];
}

function negative(id: string, expect: NegativeCase['expect'], lines: readonly string[], headerLines: readonly string[] = []): NegativeCase
{
    const body = `${lines.join('\n')}\n`;
    const realHeaders = headerLines.map((h) =>
    {
        const at = body.indexOf(`${h}\n`);
        if (at < 0)
        {
            throw new Error(`${id}: header line not found: ${h}`);
        }
        return at;
    });
    return { id, expect, body, subject: 'Re: Office desks and chairs', realHeaders };
}

const INLINE_ATTRIBUTION = 'On Mon, Mar 3, 2025 at 2:02 PM Bob Sample <bob@furniture.example.test> wrote:';

export const NEGATIVE_CASES: readonly NegativeCase[] = [
    negative('single message', 'no-header', ['Hello Bob,', '', 'Could you send me a quote for four desks?', '', 'Thanks,', 'Alice']),
    negative('header-like prose', 'no-header', [
        'Hello Bob,',
        '',
        'From: the accounting team',
        'Date: next Monday at the latest',
        'To: everyone who ordered furniture',
        '',
        'That is the note they pinned in the kitchen. From: the accounting team, again.',
        '',
        'Alice',
    ]),
    negative('header-like prose with a year', 'no-header', [
        'Hello Bob,',
        '',
        'From: the accounting team',
        'Sent: in March 2025',
        'Subject: missing receipts',
        '',
        'Could you send yours?',
        '',
        'Alice',
    ]),
    negative('header-like prose under an underscore row', 'no-header', [
        'Hello Bob,',
        '',
        'See you.',
        '',
        '________________________________',
        'From: the accounting team',
        'Sent: in March 2025',
        'Subject: missing receipts',
        '',
        'Could you send yours?',
    ]),
    negative('">" list that is not a quote', 'no-header', ['Hello Bob,', '', 'The checklist for Thursday:', '> keys for the side door', '> parking card', '> signed delivery note', '', 'Alice']),
    negative('">" list after a "wrote:" sentence', 'no-header', [
        'Hello Bob,',
        '',
        'Here is the checklist that the office manager wrote:',
        '> keys for the side door',
        '> parking card',
        '',
        'Alice',
    ]),
    negative('story with a dated "wrote:"', 'no-header', ['Hello Bob,', '', 'On 3 March the landlord wrote:', 'that the heating would be fixed by Friday.', '', 'Alice']),
    negative('underscore signature', 'no-header', [
        'Hello Bob,',
        '',
        'See you on Thursday.',
        '',
        'Alice Example',
        '________________________________',
        'Example Office Supplies (fictional company)',
        'Phone: 555 0100',
    ]),
    negative('interleaved answers', 'refuse', [
        'Hello Bob, answers below.',
        '',
        INLINE_ATTRIBUTION,
        '> Can I come on Wednesday at 10:00?',
        'Yes, that works.',
        '> Do you need a parking place?',
        'No, the street is fine.',
        '',
        'Alice',
    ], [INLINE_ATTRIBUTION]),
    negative('bottom-posting', 'refuse', [
        INLINE_ATTRIBUTION,
        '> Hello Alice,',
        '>',
        '> I can come by on Wednesday at 10:00 to measure the room.',
        '>',
        '> Bob',
        '',
        'Wednesday works for me. See you then.',
        '',
        'Alice',
    ], [INLINE_ATTRIBUTION]),
];
