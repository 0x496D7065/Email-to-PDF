// Test support (task 8.13b-3, review round 3, finding M2): random small
// conversations in which emails QUOTE each other, for the "collapse, never
// delete" property tests (Source/pdf-export/model.quoting.property.test.ts) and for
// comparing two versions of the tool on the same inputs.
//
// Each case is a few emails (2 to 7). Each one has a sentence of its own
// (long enough for the overlap detector, found in no other email's own
// text) and may quote one earlier email of the case (a share of them, set
// by `quoteShare`):
// - with a reply header and ">" marks, English, French or Dutch (Gmail,
//   Apple, Thunderbird styles of Helper/Test/test-support/thread-builder.ts), or an
//   Outlook header block with no marks ("From: / Sent:", "De : / Envoyé :",
//   "Van: / Verzonden:", "-----Original Message-----" and its FR / NL
//   forms), or a forward header; the whole email it answers, with that
//   email's own quote below it (buildThread);
// - only the other email's own sentence, under an English reply header and
//   ">" marks (a part of it, like the reviewer's case);
// - pasted with no header and no marks at all (the whole text, or the
//   sentence alone).
// Headers: In-Reply-To (and References) right, missing, or pointing at a
// random email of the case. Dates: right, missing, unreadable, or a wrong
// clock (up to five steps too early: a reply dated before the email it
// quotes). Message-IDs always set, so copies of one email are merged.
// Synthetic data only: made-up names, *.test addresses (README.md, rule R7).

import { buildThread, formatQuotedDate, wallTimeOf, type Person, type QuoteStyle, type ThreadMessage, type Zone } from './thread-builder';
import { ALICE, BOB, CAROL, DAVE, ERIN, KOLKATA, LAGOS, TOKYO, UTC } from './thread-cases';
import type { NormalizedMessage } from '../../../Header/parsed-email';

const PEOPLE: readonly Person[] = [ALICE, BOB, CAROL, DAVE, ERIN];
const ZONES: readonly Zone[] = [UTC, LAGOS, TOKYO, KOLKATA];

/** How an email quotes the one it answers. */
export type QuoteKind = QuoteStyle | 'partial' | 'pasted' | 'pasted-partial';

const STYLES: readonly QuoteKind[] = [
    'gmail-en',
    'gmail-en-gb',
    'gmail-fr',
    'gmail-nl',
    'apple-en',
    'apple-fr',
    'apple-nl',
    'thunderbird-en',
    'outlook-en',
    'outlook-fr',
    'outlook-nl',
    'outlook-original-en',
    'outlook-original-fr',
    'outlook-original-nl',
    'gmail-forward-en',
    'partial',
    'partial',
    'pasted',
    'pasted-partial',
];

const WORDS = ['north', 'warehouse', 'shelf', 'label', 'oak', 'desk', 'invoice', 'route', 'mover', 'window', 'figure', 'total', 'chair', 'table', 'delivery', 'count'];

/** The sentence of its own of email `name`: 16 words, long enough to be matched as a quote, and unique. */
export function quotingSentence(name: string): string
{
    let h = 0;
    for (const c of name)
    {
        h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
    }
    const words = Array.from({ length: 10 }, (_, k) => WORDS[(h >>> (k * 3)) % WORDS.length]!);
    return `Own words of ${name}: the ${words.join(' ')} were checked again this week.`;
}

export interface QuotingCase
{
    /** The emails, in the order they were written (each one quotes only earlier ones). */
    readonly messages: readonly NormalizedMessage[];
    /** sentences[k]: the own sentence of messages[k]. */
    readonly sentences: readonly string[];
    /** quotes[k]: the email messages[k] quotes (an index into messages), or null. */
    readonly quotes: readonly (number | null)[];
}

const START = Date.UTC(2025, 5, 2, 8, 0);
const STEP = 3 * 3_600_000;

/** A random case (see the top of this file). `id` makes the names (and so the sentences) unique across cases. */
export function quotingCase(random: () => number, id: string, { quoteShare = 0.35 }: { readonly quoteShare?: number } = {}): QuotingCase
{
    const pick = <V>(list: readonly V[]): V => list[Math.floor(random() * list.length)]!;
    const n = 2 + Math.floor(random() * 6);
    const names: string[] = [];
    const from: Person[] = [];
    const to: Person[] = [];
    const zone: Zone[] = [];
    const own: string[] = [];
    const parent: (number | null)[] = [];
    const kind: (QuoteKind | null)[] = [];
    const subject: string[] = [];
    const bodies: string[] = [];
    const messages: NormalizedMessage[] = [];

    const threadMessage = (k: number, quote: QuoteStyle | null): ThreadMessage => ({
        from: from[k]!,
        to: [to[k]!],
        sent: wallTimeOf(START + k * STEP, zone[k]!),
        zone: zone[k]!,
        subject: subject[k]!,
        text: own[k]!,
        ...(quote === null ? {} : { quote: { style: quote } }),
    });

    for (let k = 0; k < n; k++)
    {
        const name = `${id}e${String(k)}`;
        names.push(name);
        const sender = pick(PEOPLE);
        from.push(sender);
        to.push(pick(PEOPLE.filter((p) => p !== sender)));
        zone.push(pick(ZONES));
        const first = sender.name.split(' ')[0]!;
        // Often the sentence is the last paragraph (no closing), after an opening: the reviewer's case.
        const opening = pick(['', `Hello ${to[k]!.name.split(' ')[0]!},\n\n`, `A short update from ${first} on the planning for the coming weeks.\n\n`]);
        const closing = pick(['', '', `\n\nKind regards,\n${first}`, `\n\nThanks,\n${first}`]);
        own.push(`${opening}${quotingSentence(name)}${closing}`);
        const p = k > 0 && random() < quoteShare ? Math.floor(random() * k) : null;
        parent.push(p);
        const how = p === null ? null : pick(STYLES);
        kind.push(how);
        subject.push(p === null ? `Topic ${name}` : how === 'gmail-forward-en' ? `Fwd: ${subject[p]!}` : `Re: ${subject[p]!}`);

        let body: string;
        if (p === null || how === null)
        {
            body = `${own[k]!}\n`;
        }
        else if (how === 'pasted')
        {
            body = `${own[k]!}\n\n${bodies[p]!}`;
        }
        else if (how === 'pasted-partial')
        {
            body = `${own[k]!}\n\n${quotingSentence(names[p]!)}\n`;
        }
        else if (how === 'partial')
        {
            const date = formatQuotedDate('gmail-en-gb', START + p * STEP, zone[k]!);
            body = `${own[k]!}\n\nOn ${date}, ${from[p]!.name} <${from[p]!.address}> wrote:\n> ${quotingSentence(names[p]!)}\n`;
        }
        else
        {
            // The chain up to the nearest email that does not quote with a thread-builder style.
            const chain: number[] = [k];
            let up: number = p;
            for (;;)
            {
                chain.unshift(up);
                const above = parent[up];
                const style = kind[up];
                if (above === null || above === undefined || style === null || style === undefined || ['partial', 'pasted', 'pasted-partial'].includes(style))
                {
                    break;
                }
                up = above;
            }
            body = buildThread(chain.map((c, at) => threadMessage(c, at === 0 ? null : (kind[c] as QuoteStyle)))).body;
        }
        bodies.push(body);

        // Headers: right, missing, or wrong.
        const r = random();
        const inReplyTo = p !== null && r < 0.5 ? `${names[p]!}@example.test` : r > 0.9 ? `${names[Math.floor(random() * names.length)]!}@example.test` : null;
        const d = random();
        const trueMs = START + k * STEP;
        const date =
            d < 0.55
                ? { utcMs: trueMs, original: new Date(trueMs).toUTCString(), offsetMinutes: 0, zoneKnown: true }
                : d < 0.7
                    ? { utcMs: null, original: '', offsetMinutes: null, zoneKnown: false }
                    : d < 0.8
                        ? { utcMs: null, original: 'sometime last week', offsetMinutes: null, zoneKnown: false }
                        : { utcMs: trueMs - Math.floor(random() * 5 * STEP), original: 'wrong clock', offsetMinutes: 0, zoneKnown: true };
        messages.push({
            messageId: `${name}@example.test`,
            inReplyTo,
            references: inReplyTo !== null && random() < 0.5 ? [inReplyTo] : [],
            date,
            from: [{ name: sender.name, address: sender.address }],
            to: [{ name: to[k]!.name, address: to[k]!.address }],
            cc: [],
            bcc: [],
            subject: subject[k]!,
            bodyText: body,
            attachments: [],
            source: { fileName: `${name}.eml`, sha256: k.toString(16).padStart(64, '0'), kind: 'eml' },
            warnings: [],
        });
    }
    return { messages, sentences: names.map(quotingSentence), quotes: parent };
}
