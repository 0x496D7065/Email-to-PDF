// Tests for overlap-based quote detection (README.md, rules R6 and R7).
// Synthetic text only; non-ASCII characters are written as \u escapes.

import { describe, expect, it } from 'vitest';
import {
    MAX_POSTINGS,
    MIN_RUN_WORDS,
    SHINGLE_WORDS,
    SHORT_MESSAGE_MIN_WORDS,
    detectQuotedOverlap,
    tokenizeWords,
    type OverlapInput,
} from './overlap-quote-detection';
import { buildSegments, checkSegments, joinSegments, type FoldRange } from './fold-segments';

interface Spec
{
    readonly body: string;
    readonly id?: string;
    readonly inReplyTo?: string;
    readonly references?: readonly string[];
    /** OverlapInput.holds (the `index` values of the messages it holds); no key when absent. */
    readonly holds?: readonly unknown[];
}

/** Builds inputs in chronological order; `index` is 10 * (position + 1) so it differs from the position. */
function inputs(specs: readonly Spec[]): OverlapInput[]
{
    return specs.map((spec, k) => ({
        bodyText: spec.body,
        messageId: spec.id ?? null,
        inReplyTo: spec.inReplyTo ?? null,
        references: spec.references ?? [],
        index: 10 * (k + 1),
        ...(spec.holds === undefined ? {} : { holds: spec.holds as readonly number[] }),
    }));
}

/** Runs the detector and checks every result against the segment model. */
function detect(specs: readonly Spec[]): FoldRange[][]
{
    const messages = inputs(specs);
    const result = detectQuotedOverlap(messages);
    expect(result).toHaveLength(messages.length);
    result.forEach((folds, k) =>
    {
        const body = messages[k]?.bodyText ?? '';
        const segments = buildSegments(body, folds);
        expect(checkSegments(body, segments)).toEqual([]);
        expect(joinSegments(body, segments)).toBe(body);
        for (const fold of folds)
        {
            expect(fold.reason).toBe('quoted-overlap');
            expect(fold.start).toBeLessThan(fold.end);
        }
    });
    return result;
}

/** The text that stays shown (not folded) in `body`. */
function shown(body: string, folds: readonly FoldRange[]): string
{
    return buildSegments(body, folds)
        .filter((s) => !s.folded)
        .map((s) => body.slice(s.start, s.end))
        .join('');
}

/** The folded text in `body`. */
function folded(body: string, folds: readonly FoldRange[]): string
{
    return buildSegments(body, folds)
        .filter((s) => s.folded)
        .map((s) => body.slice(s.start, s.end))
        .join('');
}

/** Whether every character of `snippet` (first occurrence) is folded, none is, or some are. */
function state(body: string, folds: readonly FoldRange[], snippet: string): 'folded' | 'shown' | 'mixed'
{
    const offset = body.indexOf(snippet);
    expect(offset, snippet).toBeGreaterThanOrEqual(0);
    let count = 0;
    for (let i = offset; i < offset + snippet.length; i++)
    {
        if (folds.some((f) => f.start <= i && i < f.end))
        {
            count++;
        }
    }
    if (count === 0)
    {
        return 'shown';
    }
    return count === snippet.length ? 'folded' : 'mixed';
}

/** Quotes every line with `prefix` (a final line break stays a plain line break). */
function quote(text: string, prefix = '> '): string
{
    const ends = text.endsWith('\n');
    const lines = (ends ? text.slice(0, -1) : text).split('\n');
    return lines.map((line) => (line === '' ? prefix.trimEnd() : prefix + line)).join('\n') + (ends ? '\n' : '');
}

const ALICE_1 = `Hi Bob,

We are furnishing a small office for four people and need four desks
and four chairs. Could you send me a quote? Someone is at the office
most mornings if you want to see the room first.

Thanks,
Alice
`;

const BOB_HEAD = `Hello Alice,

I can come by on Wednesday at 10:00 to measure the room.

Bob

On Mon, 3 Mar 2025 at 09:15, Alice Example <alice@example.test> wrote:
`;

const BOB_2 = `${BOB_HEAD}${quote(ALICE_1)}`;

describe('tokenizeWords', () =>
{
    it('keeps letters and digits, with offsets into the original text', () =>
    {
        const text = '> Hello, Bob!\n> Room 2 at 10:00.';
        const words = tokenizeWords(text);
        expect(words.map((w) => w.key)).toEqual(['hello', 'bob', 'room', '2', 'at', '10', '00']);
        for (const word of words)
        {
            expect(text.slice(word.start, word.end).toLowerCase()).toBe(word.key);
        }
    });

    it('normalizes case and composed/decomposed accents, and treats nbsp as a space', () =>
    {
        const composed = tokenizeWords('\u00C9quipe\u00A0livr\u00E9e');
        const decomposed = tokenizeWords('E\u0301QUIPE LIVRE\u0301E');
        expect(composed.map((w) => w.key)).toEqual(['\u00E9quipe', 'livr\u00E9e']);
        expect(decomposed.map((w) => w.key)).toEqual(composed.map((w) => w.key));
        // Offsets still point at the original (decomposed) text.
        expect(decomposed[0]).toMatchObject({ start: 0, end: 7 });
    });

    it('counts combining marks only when attached to a letter or digit', () =>
    {
        // An isolated combining acute accent, an emoji with a variation selector, a lone selector.
        expect(tokenizeWords('\u0301 \u2764\uFE0F \uFE0F')).toEqual([]);
        expect(tokenizeWords('a \uFE0F b').map((w) => w.key)).toEqual(['a', 'b']);
        expect(tokenizeWords('cafe\u0301 \u0301x').map((w) => w.key)).toEqual(['caf\u00E9', 'x']);
    });

    it('ignores punctuation, quote markers and emoji; empty text has no words', () =>
    {
        expect(tokenizeWords('>> -- \uD83D\uDE00 ... !!')).toEqual([]);
        expect(tokenizeWords('')).toEqual([]);
        expect(tokenizeWords("don't").map((w) => w.key)).toEqual(['don', 't']);
    });
});

describe('detectQuotedOverlap: constants', () =>
{
    it('has a shingle no longer than the short-message floor, and a floor below the minimum run', () =>
    {
        expect(SHINGLE_WORDS).toBeLessThanOrEqual(SHORT_MESSAGE_MIN_WORDS);
        expect(SHORT_MESSAGE_MIN_WORDS).toBeLessThan(MIN_RUN_WORDS);
        expect(MAX_POSTINGS).toBeGreaterThan(1);
    });
});

describe('detectQuotedOverlap: common reply styles', () =>
{
    it('folds a Gmail-style "> " quote and keeps the new text and attribution line shown', () =>
    {
        const [first, reply] = detect([{ body: ALICE_1 }, { body: BOB_2 }]);
        expect(first).toEqual([]);
        expect(shown(BOB_2, reply!)).toBe(BOB_HEAD);
        expect(folded(BOB_2, reply!)).toBe(quote(ALICE_1));
        expect(reply!.map((f) => f.related)).toEqual([10]);
    });

    it('folds an Outlook-style quote with no markers below a header block', () =>
    {
        const head = `Dear Alice,

The quote is attached. Delivery takes one day.

________________________________
From: Alice Example <alice@example.test>
Sent: Monday, March 3, 2025 9:15 AM
To: Bob Sample <bob@furniture.example.test>
Subject: Office desks and chairs

`;
        const body = head + ALICE_1;
        const [, reply] = detect([{ body: ALICE_1 }, { body }]);
        expect(shown(body, reply!)).toBe(head);
        expect(reply).toEqual([{ start: head.length, end: body.length, reason: 'quoted-overlap', related: 10 }]);
    });

    it('folds a quote that was re-wrapped with different line breaks and extra blank lines', () =>
    {
        const rewrapped = `Noted, thanks.

> Hi Bob,
>
>
> We are furnishing a small office for four
> people and need four desks and four chairs. Could you
> send me a quote?   Someone is at the office most mornings
> if you want to see the room first.
>
> Thanks, Alice
`;
        const [, reply] = detect([{ body: ALICE_1 }, { body: rewrapped }]);
        expect(shown(rewrapped, reply!)).toBe('Noted, thanks.\n\n');
    });

    it('folds nested quotes, linking the whole history to the message replied to', () =>
    {
        const third = `Wednesday at 10:00 works for me. See you then.

Alice

On Mon, 3 Mar 2025 at 14:02, Bob Sample wrote:
${quote(BOB_2)}`;
        expect(third).toContain('> > We are furnishing');
        const [, second, last] = detect([{ body: ALICE_1 }, { body: BOB_2 }, { body: third }]);
        expect(second!.map((f) => f.related)).toEqual([10]);
        expect(last!.map((f) => f.related)).toEqual([20]);
        expect(folded(third, last!)).toBe(quote(BOB_2));
    });

    it('folds only the quoted paragraphs of an inline reply', () =>
    {
        const original = `Hi Bob,

The four desks should be light grey and the chairs should have armrests and wheels.

Delivery could be on a Monday or a Thursday morning, before eleven if possible.

Alice
`;
        const inline = `Hi Alice, answers below.

> The four desks should be light grey and the chairs should have armrests and wheels.

Light grey is in stock; armrests cost extra.

> Delivery could be on a Monday or a Thursday morning, before eleven if possible.

Thursday works.

Bob
`;
        const [, reply] = detect([{ body: original }, { body: inline }]);
        expect(shown(inline, reply!)).toBe(
            'Hi Alice, answers below.\n\n\nLight grey is in stock; armrests cost extra.\n\n\nThursday works.\n\nBob\n',
        );
        expect(reply!).toHaveLength(2);
    });

    it('folds a partial quote (one paragraph of the earlier message)', () =>
    {
        const partial = `About this part:

> We are furnishing a small office for four people and need four desks
> and four chairs.

Four of each is fine.
`;
        const [, reply] = detect([{ body: ALICE_1 }, { body: partial }]);
        expect(shown(partial, reply!)).toBe('About this part:\n\n\nFour of each is fine.\n');
    });

    it('links each quoted part to its own message when two messages are quoted', () =>
    {
        const carol = `The delivery van can only park in the side street between eight and noon on weekdays.\n`;
        const both = `Summary for the team:

> We are furnishing a small office for four people and need four desks

plus

> The delivery van can only park in the side street between eight and noon on weekdays.
`;
        const [, , reply] = detect([{ body: ALICE_1 }, { body: carol }, { body: both }]);
        expect(reply!.map((f) => f.related)).toEqual([10, 20]);
        expect(shown(both, reply!)).toBe('Summary for the team:\n\n\nplus\n\n');
    });
});

describe('detectQuotedOverlap: thresholds', () =>
{
    it('folds a short earlier message quoted in full', () =>
    {
        const short = 'Yes, Wednesday works for me.\n';
        const reply = `Great, see you.\n\n> Yes, Wednesday works for me.\n`;
        const [first, second] = detect([{ body: short }, { body: reply }]);
        expect(first).toEqual([]);
        expect(folded(reply, second!)).toBe('> Yes, Wednesday works for me.\n');
    });

    it('does not fold a common short phrase', () =>
    {
        const [, second] = detect([{ body: 'Thanks a lot!\n' }, { body: 'Thanks a lot!\n\nBob\n' }]);
        expect(second).toEqual([]);
    });

    it('does not fold part of a short message, nor a shared run below the minimum', () =>
    {
        const short = 'Please call me tomorrow about the delivery time.\n';
        const reply = 'I will call you tomorrow. Please call me tomorrow if it changes.\n';
        const words = MIN_RUN_WORDS - 1;
        const a = `${Array.from({ length: words }, (_, k) => `shared${k}`).join(' ')} end of message one\n`;
        const b = `start ${Array.from({ length: words }, (_, k) => `shared${k}`).join(' ')} other text\n`;
        const [, shortResult] = detect([{ body: short }, { body: reply }]);
        const [, sharedResult] = detect([{ body: a }, { body: b }]);
        expect(shortResult).toEqual([]);
        expect(sharedResult).toEqual([]);
    });

    it('folds a shared run of exactly the minimum length', () =>
    {
        const run = Array.from({ length: MIN_RUN_WORDS }, (_, k) => `shared${k}`).join(' ');
        const [, second] = detect([{ body: `${run} first\n` }, { body: `new line\n> ${run}\n` }]);
        expect(folded(`new line\n> ${run}\n`, second!)).toBe(`> ${run}\n`);
    });
});

describe('detectQuotedOverlap: direction', () =>
{
    it('never folds a message because a later message quoted it', () =>
    {
        const [first] = detect([{ body: ALICE_1 }, { body: BOB_2 }, { body: `Fwd:\n${ALICE_1}` }]);
        expect(first).toEqual([]);
    });

    it('folds the reply even when its clock puts it first (In-Reply-To wins)', () =>
    {
        const [reply, original] = detect([
            { body: BOB_2, id: 'reply@example.test', inReplyTo: 'orig@example.test' },
            { body: ALICE_1, id: 'orig@example.test' },
        ]);
        expect(original).toEqual([]);
        expect(folded(BOB_2, reply!)).toBe(quote(ALICE_1));
        expect(reply!.map((f) => f.related)).toEqual([20]);
    });

    it('uses References too, and falls back to the order when neither or both reference', () =>
    {
        const viaReferences = detect([
            { body: BOB_2, id: 'reply@example.test', references: ['x@example.test', 'orig@example.test'] },
            { body: ALICE_1, id: 'orig@example.test' },
        ]);
        expect(viaReferences[1]).toEqual([]);
        expect(viaReferences[0]!.length).toBe(1);

        // No references: the later one (here the original, by a wrong clock) is folded.
        const noReferences = detect([{ body: BOB_2 }, { body: ALICE_1 }]);
        expect(noReferences[0]).toEqual([]);
        expect(folded(ALICE_1, noReferences[1]!)).toBe(ALICE_1);

        // Both reference each other: again the later one.
        const both = detect([
            { body: BOB_2, id: 'b@example.test', inReplyTo: 'a@example.test' },
            { body: ALICE_1, id: 'a@example.test', inReplyTo: 'b@example.test' },
        ]);
        expect(both[0]).toEqual([]);
        expect(both[1]!.length).toBe(1);
    });

    it('keeps the earliest of two identical copies shown and links to it', () =>
    {
        const [a, b, c] = detect([{ body: ALICE_1 }, { body: ALICE_1 }, { body: BOB_2 }]);
        expect(a).toEqual([]);
        expect(b).toEqual([{ start: 0, end: ALICE_1.length, reason: 'quoted-overlap', related: 10 }]);
        expect(c!.map((f) => f.related)).toEqual([10]);
    });

    // Task 8.13b-3, review round 2 (M1): an email holding an attached email always quotes it.
    const FORWARD = `Please see the email below.\n\n${ALICE_1}`;

    it('folds the holder, never the email it holds, whatever the order says (holds wins over the clocks)', () =>
    {
        // The attached email (index 20) comes after its holder (index 10), say by a date with no zone.
        const [holder, held] = detect([{ body: FORWARD, holds: [20] }, { body: ALICE_1 }]);
        expect(held).toEqual([]);
        expect(folded(FORWARD, holder!)).toBe(ALICE_1);
        expect(holder!.map((f) => f.related)).toEqual([20]);
        // Without the link, the later one is folded: the attached email's own text, as quoted from its holder.
        const [plainHolder, plainHeld] = detect([{ body: FORWARD }, { body: ALICE_1 }]);
        expect(plainHolder).toEqual([]);
        expect(folded(ALICE_1, plainHeld!)).toBe(ALICE_1);
    });

    it('holds wins over the reference headers too, and over an identical copy kept by order', () =>
    {
        // The attached email claims to reply to its holder: still never folded as quoted from it.
        const [held, holder] = detect([
            { body: ALICE_1, id: 'a@example.test', inReplyTo: 'p@example.test' },
            { body: FORWARD, id: 'p@example.test', holds: [10] },
        ]);
        expect(held).toEqual([]);
        expect(holder!.map((f) => f.related)).toEqual([10]);
        // Two identical bodies, the later one held by the earlier: the holder is the one folded.
        const [first, second] = detect([{ body: ALICE_1, holds: [20] }, { body: ALICE_1 }]);
        expect(second).toEqual([]);
        expect(first).toEqual([{ start: 0, end: ALICE_1.length, reason: 'quoted-overlap', related: 20 }]);
    });

    // Task 8.13b-3, review round 3 (M2): a holder counts as referencing what the emails it holds reference.
    it('a holder counts as referencing what its held emails reference: it, not the email they reply to, is folded', () =>
    {
        // The reply (index 10) quotes Ann's email; the forward (index 20) holds the reply; Ann's email (index 30)
        // has no date, so it comes last. Ann's email and the forward share her text, and neither lists the other.
        const REPLY = `Fine by me.\n\nOn Monday, Ann wrote:\n> ${ALICE_1}`;
        const specs = (holds: boolean): Spec[] => [
            { body: REPLY, id: 'b@example.test', inReplyTo: 'a@example.test' },
            { body: `${FORWARD}\n\nFine by me.\n\nOn Monday, Ann wrote:\n> ${ALICE_1}`, id: 'c@example.test', ...(holds ? { holds: [10] } : {}) },
            { body: ALICE_1, id: 'a@example.test' },
        ];
        const [, forward, ann] = detect(specs(true));
        expect(ann).toEqual([]);
        // The forward's copy is folded (as quoted from the reply, its longest match).
        expect(folded(specs(true)[1]!.body, forward!)).toContain(ALICE_1);
        // Without the holder link, the later one (Ann's email) is folded as quoted from the forward.
        const [, , plainAnn] = detect(specs(false));
        expect(plainAnn!.some((f) => f.related === 20)).toBe(true);
        // At any depth: held through a middle forward, the same.
        const deep = detect([
            { body: REPLY, id: 'b@example.test', inReplyTo: 'a@example.test' },
            { body: `${FORWARD}\n\n${REPLY}`, id: 'm@example.test', holds: [10] },
            { body: `Passing it on.\n\n${FORWARD}\n\n${REPLY}`, id: 'c@example.test', holds: [20, 10] },
            { body: ALICE_1, id: 'a@example.test' },
        ]);
        expect(deep[3]).toEqual([]);
    });

    it('both holding each other (not expected) or entries that are not numbers: the usual rules', () =>
    {
        const both = detect([{ body: FORWARD, holds: [20] }, { body: ALICE_1, holds: [10] }]);
        expect(both[0]).toEqual([]);
        expect(folded(ALICE_1, both[1]!)).toBe(ALICE_1);
        const junk = detect([{ body: FORWARD, holds: ['20', null, Number.NaN] }, { body: ALICE_1 }]);
        expect(junk[0]).toEqual([]);
        expect(folded(ALICE_1, junk[1]!)).toBe(ALICE_1);
        // A held index that is no message of the list changes nothing.
        const stray = detect([{ body: FORWARD, holds: [999] }, { body: ALICE_1 }]);
        expect(stray[0]).toEqual([]);
    });

    it('does not fold text repeated inside one message', () =>
    {
        const para = 'The four desks should be light grey and the chairs should have armrests and wheels.\n';
        expect(detect([{ body: `${para}\n${para}\n${para}` }])).toEqual([[]]);
    });
});

describe('detectQuotedOverlap: text variations', () =>
{
    it('matches across accents (composed vs decomposed), case, nbsp and quote markers', () =>
    {
        const original = "Les bureaux et chaises d'essai pour votre \u00E9quipe seront livr\u00E9s le jeudi 6 mars entre 8h et 12h.\n";
        const reply =
            'Merci.\n\n> LES BUREAUX ET CHAISES D\u2019ESSAI pour votre e\u0301quipe\n' +
            '> seront\u00A0livre\u0301s le jeudi 6\u00A0mars entre 8h et 12h.\n';
        const [, second] = detect([{ body: original }, { body: reply }]);
        expect(shown(reply, second!)).toBe('Merci.\n\n');
    });

    it('handles CRLF bodies: folds whole lines including the CRLF', () =>
    {
        const reply = BOB_2.replace(/\n/g, '\r\n');
        const [, second] = detect([{ body: ALICE_1 }, { body: reply }]);
        expect(shown(reply, second!)).toBe(BOB_HEAD.replace(/\n/g, '\r\n'));
        expect(second![0]!.end).toBe(reply.length);
    });

    it('keeps a line shown when it mixes new and quoted text', () =>
    {
        const run = Array.from({ length: MIN_RUN_WORDS }, (_, k) => `word${k}`).join(' ');
        const mixed = `My answer: ${run}\nNext line\n`;
        const [, second] = detect([{ body: `${run}\n` }, { body: mixed }]);
        expect(second).toEqual([]);
    });

    it('handles empty input, empty bodies and bodies without words', () =>
    {
        expect(detectQuotedOverlap([])).toEqual([]);
        expect(detect([{ body: '' }, { body: '' }, { body: '>>>\n\n' }])).toEqual([[], [], []]);
        expect(detect([{ body: '' }, { body: ALICE_1 }])).toEqual([[], []]);
    });

    it('labels a signature repeated by its sender as quoted-overlap (known limitation)', () =>
    {
        const disclaimer =
            'DISCLAIMER: This e-mail and any attachments are confidential and intended solely for the addressee.\n';
        const one = `The quote is attached.\n\n${disclaimer}`;
        const two = `Delivery is planned for Monday.\n\n${disclaimer}`;
        const [, second] = detect([{ body: one }, { body: two }]);
        expect(folded(two, second!)).toBe(disclaimer);
    });
});

describe('detectQuotedOverlap: line rule (never fold new words)', () =>
{
    it('folds nothing in a single-line body that mixes new text and a quote', () =>
    {
        const original = 'We are furnishing a small office for four people and need four desks and chairs.';
        const reply =
            'Sure, I can deliver on Monday and the price is 1200 euros including setup. ' +
            'From: Alice Sent: Mon Subject: desks ' +
            original;
        const [, second] = detect([{ body: original }, { body: reply }]);
        expect(second).toEqual([]);
    });

    it('keeps an answer shown when it repeats a sentence of the earlier message on the same line', () =>
    {
        const question =
            'Hi Bob.\nCould you please confirm that the delivery will arrive before noon on Friday the 14th?\nThanks. Alice\n';
        const answer =
            'Hi Alice.\nYou asked: could you please confirm that the delivery will arrive before noon on Friday the 14th? ' +
            'Yes it will, the driver leaves at 8.\nBob\n';
        const [, second] = detect([{ body: question }, { body: answer }]);
        expect(second).toEqual([]);
    });

    it('does not fold a new line that follows a greeting repeated in every message', () =>
    {
        const greeting = 'Good morning everyone and welcome to the weekly planning notes for';
        expect(tokenizeWords(greeting)).toHaveLength(MIN_RUN_WORDS - 1);
        const specs = Array.from({ length: 120 }, (_, n) => ({ body: `${greeting}\nPoint ${n}: order ${n * 3} chairs.\n` }));
        const result = detect(specs);
        result.forEach((folds, k) =>
        {
            expect(state(specs[k]!.body, folds, `Point ${k}:`), `message ${k}`).toBe('shown');
        });
        // The 11-word greeting alone is below the minimum run, so nothing is folded at all.
        expect(result.every((folds) => folds.length === 0)).toBe(true);
    });

    it('does not fold longer new lines that contain a short earlier message', () =>
    {
        const cases: [string, string][] = [
            ['Yes that works fine', 'Ok.\nYes that works fine for me but only after 3pm, otherwise Thursday.\n'],
            ['See you on Monday then', 'Great.\nSee you on Monday then, and bring the contract with the new prices.\n'],
            ['Agenda: budget chairs desks lamps', 'My agenda: budget chairs desks lamps parking\n'],
            ['Agenda:\n- budget\n- chairs\n- desks\n- lamps', 'My agenda:\n- budget\n- chairs\n- desks\n- lamps\n- parking\n'],
        ];
        for (const [short, reply] of cases)
        {
            const [, second] = detect([{ body: short }, { body: reply }]);
            expect(second, reply).toEqual([]);
        }
    });

    it('still folds a short earlier message quoted alone on its own lines', () =>
    {
        const reply = 'Agreed.\n\n> Agenda:\n> - budget\n> - chairs\n> - desks\n> - lamps\n';
        const [, second] = detect([{ body: 'Agenda:\n- budget\n- chairs\n- desks\n- lamps' }, { body: reply }]);
        expect(shown(reply, second!)).toBe('Agreed.\n\n');
    });

    it('shrinks a run that starts and ends mid-line to its fully covered lines', () =>
    {
        const original = 'alpha one two three four\nfive six seven eight nine\nten eleven twelve thirteen fourteen\nfifteen sixteen\nomega\n';
        // The quote shares its first and last lines with new words.
        const reply =
            'New start alpha one two three four\nfive six seven eight nine\nten eleven twelve thirteen fourteen\nfifteen sixteen\nomega and new end\n';
        const [, second] = detect([{ body: original }, { body: reply }]);
        expect(folded(reply, second!)).toBe('five six seven eight nine\nten eleven twelve thirteen fourteen\nfifteen sixteen\n');
        // When the fully covered lines hold fewer than MIN_RUN_WORDS words, the run is dropped.
        const shortReply = 'New start alpha one two three four\nfive six seven eight nine\nten eleven new end\n';
        const [, third] = detect([{ body: original }, { body: shortReply }]);
        expect(third).toEqual([]);
    });

    it('still finds a quote that starts inside a longer mid-line run against another message', () =>
    {
        // The run against `other` starts mid-line on new text and goes on into the
        // quote; the line rule drops it, and the real quote of `asked` is found
        // by walking on from the next line.
        const asked = 'Can you deliver the four desks on Monday morning\nand the chairs on Tuesday afternoon please?\n';
        expect(tokenizeWords(asked)).toHaveLength(16);
        const other = 'We changed the plan again, sorry. Can you deliver the four desks on Monday\n';
        for (const prefix of ['', '> '])
        {
            const reply = `Ok, noted. We changed the plan again, sorry.\n${quote(asked, prefix)}`;
            const [, , third] = detect([{ body: asked }, { body: other }, { body: reply }]);
            expect(shown(reply, third!), prefix).toBe('Ok, noted. We changed the plan again, sorry.\n');
            expect(third!.map((f) => f.related), prefix).toEqual([10]);
        }
    });

    it('keeps both runs when a mid-line run and the retried run overlap and both cover whole lines', () =>
    {
        const lineB = 'bravo one two three four five six seven\n';
        const lineC = 'charlie one two three four five six seven\n';
        const lineD = 'delta one two three four five six seven\n';
        const older = `${lineB}${lineC}${lineD}`; // 24 words
        const other = `tail word\n${lineB}${lineC}`; // 18 words
        const reply = `New words here, tail word\n${lineB}${lineC}${lineD}`;
        const [, , third] = detect([{ body: older }, { body: other }, { body: reply }]);
        // The run against `other` starts mid-line at "tail" and keeps lines B and C
        // (16 words); the retry at "bravo" finds the longer run against `older`.
        expect(shown(reply, third!)).toBe('New words here, tail word\n');
        expect(third!.map((f) => [f.related, reply.slice(f.start, f.end)])).toEqual([
            [20, `${lineB}${lineC}`],
            [10, `${lineB}${lineC}${lineD}`],
        ]);
    });

    it('keeps a new line shown when the run extends into it (the quote is folded without it)', () =>
    {
        const original = 'the meeting is moved to the big room on the second floor next to the kitchen\n';
        const reply = `> ${original}next to the kitchen there is no parking though\n`;
        const [, second] = detect([{ body: original }, { body: reply }]);
        expect(shown(reply, second!)).toBe('next to the kitchen there is no parking though\n');
    });

    it('folds bare ">" lines next to a folded block, but leaves blank lines and "--" at its edges shown', () =>
    {
        const run = Array.from({ length: MIN_RUN_WORDS }, (_, k) => `shared${k}`).join(' ');
        const reply = `New text.\n\n>\n> ${run}\n> \n>>\n\n--\nBob\n`;
        const [, second] = detect([{ body: `${run}\n` }, { body: reply }]);
        expect(folded(reply, second!)).toBe(`>\n> ${run}\n> \n>>\n`);
        expect(shown(reply, second!)).toBe('New text.\n\n\n--\nBob\n');
    });

    it('folds word-less lines between two folded blocks, even of different messages', () =>
    {
        const a = Array.from({ length: MIN_RUN_WORDS }, (_, k) => `alpha${k}`).join(' ');
        const c = Array.from({ length: MIN_RUN_WORDS }, (_, k) => `gamma${k}`).join(' ');
        const reply = `Both:\n> ${a}\n\n--\n> ${c}\nEnd\n`;
        const [, , third] = detect([{ body: `${a}\n` }, { body: `${c}\n` }, { body: reply }]);
        expect(shown(reply, third!)).toBe('Both:\nEnd\n');
        // Message 10's block includes the blank line and "--" below it; message 20 links the last quote.
        expect(third!.map((f) => f.related)).toEqual([10, 20]);
        expect(folded(reply, [third![0]!])).toBe(`> ${a}\n\n--\n`);
    });
});

describe('detectQuotedOverlap: purity', () =>
{
    it('does not modify its input', () =>
    {
        const messages = inputs([
            { body: ALICE_1, id: 'a@example.test' },
            { body: BOB_2, id: 'b@example.test', inReplyTo: 'a@example.test', references: ['a@example.test'] },
        ]);
        const snapshot = JSON.stringify(messages);
        for (const message of messages)
        {
            Object.freeze(message);
        }
        Object.freeze(messages);
        detectQuotedOverlap(messages);
        expect(JSON.stringify(messages)).toBe(snapshot);
    });

    it('is deterministic', () =>
    {
        const specs = [{ body: ALICE_1 }, { body: BOB_2 }, { body: `${quote(BOB_2)}\nok\n` }];
        expect(detectQuotedOverlap(inputs(specs))).toEqual(detectQuotedOverlap(inputs(specs)));
    });

    it('tolerates bad runtime data without throwing', () =>
    {
        const bad = [
            { bodyText: 42, messageId: null, inReplyTo: null, references: null, index: 1 },
            { bodyText: ALICE_1, messageId: 7, inReplyTo: 7, references: [null], index: 2 },
        ] as unknown as OverlapInput[];
        expect(detectQuotedOverlap(bad)).toEqual([[], []]);
        expect(detectQuotedOverlap(null as unknown as OverlapInput[])).toEqual([]);
    });
});

describe('detectQuotedOverlap: speed', () =>
{
    it('handles 300 messages, each quoting the whole thread before it, quickly', () =>
    {
        const specs: Spec[] = [];
        let previous = '';
        for (let n = 1; n <= 300; n++)
        {
            const fresh = `Update ${n}: batch ${n * 7} of item ${n * 13} is ready.\n`;
            const body = previous === '' ? fresh : `${fresh}\n-----Original Message-----\nFrom: Bob Sample, day ${n - 1}\n\n${previous}`;
            specs.push({ body });
            previous = body;
        }
        const totalChars = specs.reduce((sum, s) => sum + s.body.length, 0);
        expect(totalChars).toBeGreaterThan(1_000_000);

        const startTime = performance.now();
        const result = detectQuotedOverlap(inputs(specs));
        const ms = performance.now() - startTime;
        console.log(`overlap speed: 300 messages, ${(totalChars / 1e6).toFixed(2)} MB, ${ms.toFixed(0)} ms`);
        expect(ms).toBeLessThan(5000);

        // Every message after the first: only its new line and the separator stay shown.
        result.forEach((folds, k) =>
        {
            const body = specs[k]!.body;
            if (k === 0)
            {
                expect(folds).toEqual([]);
            }
            else
            {
                expect(folds.map((f) => f.related)).toEqual([10 * k]);
                expect(shown(body, folds)).toBe(body.slice(0, body.indexOf('\n\n', body.indexOf('From:')) + 2));
            }
        });
    });

    it('stays fast when many runs start mid-line and cross into the next line', () =>
    {
        // The original: 2000 blocks of 18 distinct words. Each reply puts a new
        // word in front of the first 6 words of each block, so every block gives
        // a run that starts mid-line and goes on into the next line (a retry).
        const blocks = Array.from({ length: 2000 }, (_, b) => Array.from({ length: 18 }, (_, k) => `w${b}x${k}`));
        const original = `${blocks.map((ws) => ws.join(' ')).join('\n')}\n`;
        const specs: Spec[] = [{ body: original }];
        for (let r = 1; r <= 20; r++)
        {
            specs.push({
                body: blocks.map((ws, b) => `new${r}y${b} ${ws.slice(0, 6).join(' ')}\n${ws.slice(6).join(' ')}\n`).join(''),
            });
        }
        const startTime = performance.now();
        const result = detectQuotedOverlap(inputs(specs));
        const ms = performance.now() - startTime;
        console.log(`overlap speed: 20 replies x 2000 mid-line runs, ${ms.toFixed(0)} ms`);
        expect(ms).toBeLessThan(5000);
        // Only the second line of each block (12 words, all quoted) is folded.
        result.slice(1).forEach((folds, k) =>
        {
            const body = specs[k + 1]!.body;
            const expected = blocks.map((ws, b) => `new${k + 1}y${b} ${ws.slice(0, 6).join(' ')}\n`).join('');
            expect(shown(body, folds)).toBe(expected);
        });
    });

    it('stays fast when the same boilerplate repeats many times', () =>
    {
        const block = 'please find the weekly report attached as usual and reply if anything is missing ';
        const body = `${block.repeat(400)}\n`; // about 6000 words, every shingle repeated hundreds of times
        const specs = Array.from({ length: 50 }, () => ({ body }));
        const startTime = performance.now();
        const result = detectQuotedOverlap(inputs(specs));
        const ms = performance.now() - startTime;
        console.log(`overlap speed: 50 x ${body.length} chars of repeated boilerplate, ${ms.toFixed(0)} ms`);
        expect(ms).toBeLessThan(5000);
        expect(result[0]).toEqual([]);
        for (const folds of result.slice(1))
        {
            expect(folds).toEqual([{ start: 0, end: body.length, reason: 'quoted-overlap', related: 10 }]);
        }
    });
});
