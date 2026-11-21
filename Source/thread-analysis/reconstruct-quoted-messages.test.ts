// Tests for reconstruct-quoted-messages.ts (milestone 7, task 7.4). Synthetic data only
// (README.md, rule R7): example.test / sample.invalid addresses, invented
// people. Non-ASCII letters are written as \u escapes.

import { describe, expect, it } from 'vitest';
import { buildThread, type BuiltThread, type QuoteStyle } from '../../Helper/Test/test-support/thread-builder';
import { chain as styleChain, NEGATIVE_CASES, THREAD_CASES } from '../../Helper/Test/test-support/thread-cases';
import { FORWARDED_SEPARATOR } from '../email-reading/forwarded-block';
import { MAX_QUOTE_DEPTH, MAX_RECONSTRUCTED, MAX_SOURCE_LENGTH, reconstructQuotedMessages, removeQuoteMarks } from './reconstruct-quoted-messages';
import type { ReconstructedMessage } from '../../Header/rebuilt-emails';

const rebuild = (body: string, subject = 'Re: Office desks', sourceOffsetMinutes: number | null = 0): ReconstructedMessage[] =>
    reconstructQuotedMessages(body, { subject, sourceOffsetMinutes });

const lines = (...l: string[]): string => `${l.join('\n')}\n`;

/** An independent reading of option A: up to `depth` ">" marks (spaces before each) and one space (or no-break space) after them removed per line. */
function oracle(slice: string, depth: number): string
{
    if (depth === 0)
    {
        return slice;
    }
    const marks = new RegExp(`^(?:[^\\S\\r\\n]*>){1,${depth}}[ \\u00a0]?`, 'u');
    return slice
        .split(/(\r\n|\r|\n)/u)
        .map((part, i) => (i % 2 === 1 ? part : part.replace(marks, '')))
        .join('');
}

/** Whether `small` is `big` with only ">" and whitespace characters deleted. */
function onlyMarksRemoved(big: string, small: string): boolean
{
    let j = 0;
    for (let i = 0; i < big.length; i++)
    {
        if (j < small.length && big.charAt(i) === small.charAt(j))
        {
            j++;
        }
        else if (big.charAt(i) !== '>' && !/\s/u.test(big.charAt(i)))
        {
            return false;
        }
    }
    return j === small.length;
}

/** The collapse-never-delete properties every result must have. */
function checkProperties(body: string, got: readonly ReconstructedMessage[]): string[]
{
    const problems: string[] = [];
    got.forEach((message, i) =>
    {
        if (!(message.start < message.headerEnd && message.headerEnd <= message.end && message.end <= body.length))
        {
            problems.push(`#${i}: offsets ${message.start} ${message.headerEnd} ${message.end}`);
        }
        const next = got[i + 1];
        if (next !== undefined && next.start !== message.end)
        {
            problems.push(`#${i}: ends at ${message.end}, next starts at ${next.start}`);
        }
        if (message.generation !== i + 1)
        {
            problems.push(`#${i}: generation ${message.generation}`);
        }
        const slice = body.slice(message.headerEnd, message.end);
        if (message.reconstructedText !== oracle(slice, message.depth))
        {
            problems.push(`#${i}: text is not the slice with ${message.depth} marks removed`);
        }
        if (!onlyMarksRemoved(slice, message.reconstructedText))
        {
            problems.push(`#${i}: more than marks removed`);
        }
        if (message.reconstructedText.split('\n').length !== slice.split('\n').length)
        {
            problems.push(`#${i}: line count changed`);
        }
        if (message.quoteMarksRemoved !== message.depth > 0)
        {
            problems.push(`#${i}: quoteMarksRemoved`);
        }
    });
    return problems;
}

describe('reconstructQuotedMessages: the generated threads (ground truth)', () =>
{
    it('rebuilds every earlier message, in order, with the right offsets, generation, depth and kind', () =>
    {
        const problems: string[] = [];
        for (const testCase of THREAD_CASES)
        {
            const got = rebuild(testCase.thread.body, testCase.thread.subject);
            if (got.length !== testCase.thread.headers.length)
            {
                problems.push(`${testCase.id}: ${got.length} rebuilt, ${testCase.thread.headers.length} expected`);
                continue;
            }
            testCase.thread.headers.forEach((header, i) =>
            {
                const message = got[i];
                if (message === undefined)
                {
                    return;
                }
                const want = { start: header.start, generation: header.generation, depth: header.textDepth };
                const have = { start: message.start, generation: message.generation, depth: message.depth };
                if (JSON.stringify(want) !== JSON.stringify(have))
                {
                    problems.push(`${testCase.id} #${i}: ${JSON.stringify(have)}, want ${JSON.stringify(want)}`);
                }
            });
            const last = got[got.length - 1];
            if (last !== undefined && last.end !== testCase.thread.body.length)
            {
                problems.push(`${testCase.id}: last ends at ${last.end}`);
            }
        }
        expect(problems).toEqual([]);
    });

    it('rebuilt text is the message as written (trimmed), except the two headers read short (names-only wrapped list)', () =>
    {
        const misses: string[] = [];
        for (const testCase of THREAD_CASES)
        {
            const got = rebuild(testCase.thread.body, testCase.thread.subject);
            testCase.thread.headers.forEach((header, i) =>
            {
                if (got[i]?.reconstructedText.trim() !== header.ownText)
                {
                    misses.push(`${testCase.id} #${i}`);
                }
            });
        }
        expect(misses).toEqual(['outlook-nl wrapped names only #0', 'outlook-nl wrapped names only #1']);
    });

    it('keeps every character: the properties hold for every case (collapse, never delete)', () =>
    {
        for (const testCase of THREAD_CASES)
        {
            expect(checkProperties(testCase.thread.body, rebuild(testCase.thread.body, testCase.thread.subject)), testCase.id).toEqual([]);
        }
    });

    it('keeps the raw header text in the source: [start, headerEnd) is the header as written', () =>
    {
        for (const testCase of THREAD_CASES)
        {
            const got = rebuild(testCase.thread.body, testCase.thread.subject);
            testCase.thread.headers.forEach((header, i) =>
            {
                const message = got[i];
                if (message === undefined || testCase.id === 'outlook-nl wrapped names only')
                {
                    return;
                }
                expect(testCase.thread.body.slice(message.start, message.headerEnd), `${testCase.id} #${i}`)
                    .toBe(testCase.thread.body.slice(header.start, header.headEnd));
            });
        }
    });

    it('dates: read in the source zone, approximate; with the source zone the first one is exact in time', () =>
    {
        for (const testCase of THREAD_CASES)
        {
            const first = testCase.thread.headers[0];
            if (first === undefined)
            {
                continue;
            }
            // The source is the quoting message: its zone is the zone gen 1 is shown in.
            const got = rebuild(testCase.thread.body, testCase.thread.subject, first.shownIn.offsetMinutes)[0];
            // Thunderbird's numeric dates such as 03/04/2025 (3 April or 4 March?) are unreadable on purpose (quoted-date.ts).
            if (first.style === 'thunderbird-en' && got?.date?.wallMs === null)
            {
                expect(got.dateApproximate, testCase.id).toBe(true);
                continue;
            }
            expect(got?.date?.estimatedUtcMs ?? null, testCase.id).toBe(Date.parse(first.instantUtc));
            const written = got?.date?.basis === 'written-zone' || got?.date?.basis === 'rfc-zone';
            expect(got?.dateApproximate, testCase.id).toBe(!written);
        }
    });

    it('a date with a written zone (Apple forward "GMT+5:30") is exact; no source offset gives basis "none"', () =>
    {
        const testCase = THREAD_CASES.find((t) => t.id === 'apple forward of a gmail thread');
        if (testCase === undefined)
        {
            throw new Error('case missing');
        }
        const got = rebuild(testCase.thread.body, testCase.thread.subject, null);
        expect(got[0]?.kind).toBe('forward');
        expect(got[0]?.date?.basis).toBe('written-zone');
        expect(got[0]?.dateApproximate).toBe(false);
        expect(got[0]?.date?.estimatedUtcMs).toBe(Date.parse(testCase.thread.headers[0]?.instantUtc ?? ''));
        expect(got[1]?.date?.basis).toBe('none');
        expect(got[1]?.dateApproximate).toBe(true);
    });

    it('rebuilds inside forwarded text (user decision Q3)', () =>
    {
        const testCase = THREAD_CASES.find((t) => t.id === 'forward in the middle');
        if (testCase === undefined)
        {
            throw new Error('case missing');
        }
        expect(rebuild(testCase.thread.body, testCase.thread.subject).map((m) => [m.generation, m.kind, m.depth])).toEqual([
            [1, 'reply', 1],
            [2, 'forward', 1],
            [3, 'reply', 2],
        ]);
    });
});

describe('reconstructQuotedMessages: negatives (no rebuilt message)', () =>
{
    it.each(NEGATIVE_CASES.map((n) => [n.id, n] as const))('%s', (_id, negativeCase) =>
    {
        expect(rebuild(negativeCase.body, negativeCase.subject)).toEqual([]);
    });
});

const GMAIL = 'On Mon, 3 Mar 2025 at 14:02, Bob Sample <bob@furniture.example.test> wrote:';
const GMAIL_2 = 'On Mon, 3 Mar 2025 at 09:10, Alice Example <alice@example.test> wrote:';
const OUTLOOK = (who = 'Bob Sample <bob@furniture.example.test>'): string[] => [
    '_'.repeat(32),
    `From: ${who}`,
    'Sent: Monday, March 3, 2025 9:15 AM',
    'To: Alice Example <alice@example.test>',
    'Subject: Office desks',
];

describe('reconstructQuotedMessages: refusal rules', () =>
{
    it('a Gmail chain is rebuilt (control for the cases below)', () =>
    {
        const body = lines('Thanks.', '', GMAIL, '> Hello Alice,', '> Wednesday works.', '>', `> ${GMAIL_2}`, '>> Hello Bob,', '>> Can you come?');
        const got = rebuild(body);
        expect(got.map((m) => [m.generation, m.depth, m.reconstructedText])).toEqual([
            [1, 1, 'Hello Alice,\nWednesday works.\n\n'],
            [2, 2, 'Hello Bob,\nCan you come?\n'],
        ]);
        expect(got[0]?.from).toEqual([{ name: 'Bob Sample', address: 'bob@furniture.example.test' }]);
    });

    it('R4: unquoted text between quoted lines (interleaved answers) refuses the message', () =>
    {
        expect(rebuild(lines('Answers below.', '', GMAIL, '> Can you come?', 'Yes.', '> Parking?', 'No.'))).toEqual([]);
    });

    it('R4: interleaved answers one level down drop that message AND its holder (its end is unknown)', () =>
    {
        const body = lines('Thanks.', '', GMAIL, '> Hello,', '>', `> ${GMAIL_2}`, '>> Can you come?', '> Yes, I can.', '>> Parking?');
        expect(rebuild(body)).toEqual([]);
        // The messages before the holder are kept.
        const outer = lines('Thanks.', '', ...OUTLOOK(), '', 'Hello.', '', GMAIL, '> Hello,', '>', `> ${GMAIL_2}`, '>> Can you come?', '> Yes.', '>> Parking?');
        expect(rebuild(outer).map((m) => m.generation)).toEqual([1]);
        expect(rebuild(outer)[0]?.end).toBe(outer.indexOf(GMAIL));
    });

    it('R4: text after the quote (bottom-posting) refuses the message', () =>
    {
        expect(rebuild(lines(GMAIL, '> Can you come?', '> Bob', '', 'Yes, see you then.'))).toEqual([]);
    });

    it('R3: depth going back (an unmarked block inside a ">" quote) stops the chain and drops the holder', () =>
    {
        const body = lines('Thanks.', '', GMAIL, '> Hello,', '> see below.', '', ...OUTLOOK('Carol Test <carol@sample.invalid>'), '', 'Old text.');
        expect(rebuild(body)).toEqual([]);
    });

    it('R3: an attribution whose quote skips a level is refused (Gmail and Apple forms)', () =>
    {
        expect(rebuild(lines('Thanks.', '', GMAIL, '>> Hello,', '>> Old text.'))).toEqual([]);
        expect(rebuild(lines('Thanks.', '', `> ${GMAIL}`, '>> Hello,', '>> Old text.'))).toEqual([]);
    });

    it('R3: an attribution with no quote after it is refused unless it is strict (F1, task 9.9a: see below)', () =>
    {
        // No time in the date, no address, no opener, or prose around it: refused, as before task 9.9a.
        expect(rebuild(lines('Thanks.', '', 'On Mon, 3 Mar 2025, Bob Sample <bob@furniture.example.test> wrote:', 'Hello,', 'Old text.'))).toEqual([]);
        expect(rebuild(lines('Thanks.', '', 'On Mon, 3 Mar 2025 at 14:02, Bob Sample wrote:', 'Hello,', 'Old text.'))).toEqual([]);
        expect(rebuild(lines('Thanks.', '', 'Bob Sample <bob@furniture.example.test> wrote:', 'Hello,', 'Old text.'))).toEqual([]);
        expect(rebuild(lines('Thanks.', '', 'As I said on Mon, 3 Mar 2025 at 14:02, Bob Sample <bob@furniture.example.test> wrote:', 'Hello,'))).toEqual([]);
        expect(rebuild(lines('Thanks.', '', 'On Monday, Bob Sample <bob@furniture.example.test> wrote:', '', GMAIL_2, 'Old text.'))).toEqual([]);
    });

    it('R1: a header with no readable sender and no readable date is refused', () =>
    {
        expect(rebuild(lines('Thanks.', '', 'On Monday, someone wrote:', '> Old text.', '> More.'))).toEqual([]);
        expect(rebuild(lines('Thanks.', '', '-----Original Message-----', 'From:', 'Sent: soon', 'Subject: x', '', 'Old.'))).toEqual([]);
    });

    it('R1: a block without an intro line needs both a sender and a readable date', () =>
    {
        const noIntro = (sent: string): string => lines('Thanks.', '', 'From: Bob Sample <bob@furniture.example.test>', `Sent: ${sent}`, 'To: Alice Example <alice@example.test>', '', 'Old.');
        expect(rebuild(noIntro('Monday, March 3, 2025 9:15 AM')).length).toBe(1);
        expect(rebuild(noIntro('in March 2025'))).toEqual([]);
    });

    it('R1: with an intro line but no readable date, the sender needs an address or a name-shaped name', () =>
    {
        const prose = 'Hello Bob,\n\nSee you.\n\n________________________________\nFrom: the accounting team\nSent: in March 2025\nSubject: missing receipts\n\nCould you send yours?\n';
        expect(rebuild(prose)).toEqual([]);
        const withIntro = (from: string): string => lines('Thanks.', '', '_'.repeat(32), `From: ${from}`, 'Sent: in March 2025', 'Subject: x', '', 'Old.');
        expect(rebuild(withIntro('Bob Sample <bob@furniture.example.test>')).length).toBe(1);
        expect(rebuild(withIntro('Bob Sample')).length).toBe(1);
        expect(rebuild(withIntro('the accounting team'))).toEqual([]);
    });

    it('R1: a weak header inside the chain stops it and drops its holder; the messages before stay', () =>
    {
        const body = lines('Thanks.', '', ...OUTLOOK(), '', 'First.', '', ...OUTLOOK('Carol Test <carol@sample.invalid>'), '', 'Second.', '', '-----Original Message-----', '', 'Third.');
        const got = rebuild(body);
        expect(got.map((m) => m.reconstructedText.trim())).toEqual(['First.']);
        expect(got[0]?.end).toBe(body.indexOf('_'.repeat(32), body.indexOf('First.')));
    });

    it('a name with an address but not name-shaped is dropped, the address kept (7.3 follow-up)', () =>
    {
        const got = rebuild(lines('Thanks.', '', 'On 3 March 2025, my colleague Bob <bob@furniture.example.test> wrote:', '> Old text.', '> More.'));
        expect(got[0]?.from).toEqual([{ name: '', address: 'bob@furniture.example.test' }]);
    });

    it('stops before the forwarded block the .eml adapter writes (another message)', () =>
    {
        const body = lines('Thanks.', '', GMAIL, '> Old text.', '> More.', '', FORWARDED_SEPARATOR, 'From: Carol Test <carol@sample.invalid>', 'Subject: x', '', 'Attached message.', '', GMAIL_2, '> Older.', '> Text.');
        const got = rebuild(body);
        expect(got.length).toBe(1);
        expect(got[0]?.end).toBe(body.indexOf(FORWARDED_SEPARATOR));
    });

    it('Outlook: the kind and subject come from the header, never from the source subject', () =>
    {
        const body = lines('Thanks.', '', ...OUTLOOK(), '', 'Old.');
        const got = rebuild(body, 'FW: Office desks');
        expect(got[0]?.kind).toBe('forward');
        expect(got[0]?.subject).toBe('Office desks');
        expect(got[0]?.to).toEqual([{ name: 'Alice Example', address: 'alice@example.test' }]);
        expect(got[0]?.quoteMarksRemoved).toBe(false);
        expect(got[0]?.reconstructedText).toBe('\nOld.\n');
    });
});

describe('reconstructQuotedMessages: flat threads, empty headers, nested forwards (task 9.9a)', () =>
{
    const BOB = { name: 'Bob Sample', address: 'bob@furniture.example.test' };
    const FORWARD = (date = 'Mon, 3 Mar 2025 at 14:02'): string[] => [
        '---------- Forwarded message ---------',
        'From: Bob Sample <bob@furniture.example.test>',
        `Date: ${date}`,
        'Subject: Desks for the office',
        'To: Alice Example <alice@example.test>',
    ];
    const summary = (got: readonly ReconstructedMessage[]): unknown[] =>
        got.map((m) => ({ kind: m.kind, depth: m.depth, empty: m.noOwnText, text: m.reconstructedText.trim(), subject: m.subject, fromChain: m.subjectFromChain }));

    it('F1: a strict attribution with its text at the same depth (no ">") is rebuilt', () =>
    {
        const got = rebuild(lines('Thanks.', '', GMAIL, 'Hello,', 'Old text.'));
        expect(summary(got)).toEqual([{ kind: 'reply', depth: 0, empty: false, text: 'Hello,\nOld text.', subject: 'Re: Office desks', fromChain: true }]);
        expect(got[0]?.from).toEqual([BOB]);
        expect(got[0]?.quoteMarksRemoved).toBe(false);
        expect(got[0]?.reconstructedText).toBe('Hello,\nOld text.\n');
    });

    it('F1: a flat chain of strict attributions (as phones forward a thread), in French and Dutch too', () =>
    {
        const fr = 'Le 3 mars 2025 14:02, "Bob Sample " <bob@furniture.example.test> a \u00e9crit :';
        const nl = 'Op 3 mrt. 2025 om 09:10 heeft Alice Example <alice@example.test> het volgende geschreven:';
        const got = rebuild(lines('Thanks.', '', fr, '', 'Bonjour,', '', nl, '', 'Hallo,', 'Oude tekst.'));
        expect(got.map((m) => [m.depth, m.from[0]?.address, m.dateText, m.reconstructedText.trim()])).toEqual([
            [0, 'bob@furniture.example.test', '3 mars 2025 14:02', 'Bonjour,'],
            [0, 'alice@example.test', '3 mrt. 2025 om 09:10', 'Hallo,\nOude tekst.'],
        ]);
        expect(got[0]?.from[0]?.name).toBe('Bob Sample');
    });

    it('F1: a flat attribution after a ">" one keeps the chain rule: going back a level is refused', () =>
    {
        const body = lines('Thanks.', '', GMAIL, '> Hello,', '>', GMAIL_2, 'Old text.');
        expect(rebuild(body)).toEqual([]);
    });

    it('F1: a flat attribution never claims the writer\'s own answer around a quote (all its text must be at its depth)', () =>
    {
        const attribution = 'On 4 May 2026 10:00, Bob <bob@x.test> wrote:';
        // Flat text, then a quote, then the writer\'s answer: the unquoted lines are not a quoted body.
        expect(rebuild(lines(attribution, 'quoted?', '', '> real quote', '', 'my answer'))).toEqual([]);
        // Quote first, then the answer (Gmail shape with an interleaved answer): refused by R4, as before.
        expect(rebuild(lines(attribution, '> real quote', '', 'my answer'))).toEqual([]);
        // Mixed depths with no text after the quote: still not all at one depth, refused.
        expect(rebuild(lines(attribution, 'quoted?', '> real quote', '>> older quote'))).toEqual([]);
        // Writer\'s text first, then the flat attribution with a quote under it: nothing rebuilt either.
        expect(rebuild(lines('Thanks.', '', attribution, 'quoted?', '', '> real quote', '', 'my answer'))).toEqual([]);
        // Control: the same attribution with only flat text is rebuilt.
        expect(rebuild(lines(attribution, 'quoted?', '', 'more quoted')).map((m) => m.reconstructedText.trim())).toEqual(['quoted?\n\nmore quoted']);
    });

    it('F2 (R6): an empty Outlook block is rebuilt as an empty email and the chain goes on', () =>
    {
        const body = lines('Thanks.', '', ...OUTLOOK(), '', ...OUTLOOK('Carol Test <carol@sample.invalid>'), '', 'Old text.');
        const got = rebuild(body);
        expect(summary(got)).toEqual([
            { kind: 'reply', depth: 0, empty: true, text: '', subject: 'Office desks', fromChain: false },
            { kind: 'reply', depth: 0, empty: false, text: 'Old text.', subject: 'Office desks', fromChain: false },
        ]);
        expect(got[1]?.from[0]?.address).toBe('carol@sample.invalid');
        expect(checkProperties(body, got)).toEqual([]);
    });

    it('F2 (R6): an empty strict attribution directly followed by another one; the chain goes on', () =>
    {
        const body = lines('Thanks.', '', GMAIL, '', GMAIL_2, '', 'Old text.');
        const got = rebuild(body);
        expect(got.map((m) => [m.noOwnText, m.depth, m.from[0]?.address, m.reconstructedText.trim()])).toEqual([
            [true, 0, BOB.address, ''],
            [false, 0, 'alice@example.test', 'Old text.'],
        ]);
        expect(checkProperties(body, got)).toEqual([]);
    });

    it('F2 (R6): an empty attribution takes the depth of the next header when that is one deeper', () =>
    {
        const got = rebuild(lines('Thanks.', '', GMAIL, `> ${GMAIL_2}`, '>> Hello Bob,', '>> Can you come?'));
        expect(got.map((m) => [m.noOwnText, m.depth, m.reconstructedText])).toEqual([[true, 1, ''], [false, 2, 'Hello Bob,\nCan you come?\n']]);
    });

    it('F2 (R6): an empty strict attribution at the end of the quoted history is an empty email', () =>
    {
        const got = rebuild(lines('Thanks.', '', GMAIL, ''));
        expect(got.map((m) => [m.noOwnText, m.depth, m.reconstructedText])).toEqual([[true, 0, '\n']]);
    });

    it('F2 (R6): an empty NON-strict attribution is still refused (and stops the chain)', () =>
    {
        expect(rebuild(lines('Thanks.', '', 'On Monday, Bob Sample <bob@furniture.example.test> wrote:', '', GMAIL_2, 'Old text.'))).toEqual([]);
        // Inside a chain: its holder is dropped too, the messages before stay.
        const body = lines('Thanks.', '', ...OUTLOOK(), '', 'First.', '', GMAIL, 'Second.', '', 'On Monday, Carol Test <carol@sample.invalid> wrote:', '', GMAIL_2,
            'Third.');
        expect(rebuild(body).map((m) => m.reconstructedText.trim())).toEqual(['First.']);
    });

    it('P1: a forward whose body is one ">" level deeper than its header lines (Android mail) is rebuilt at that level', () =>
    {
        const body = lines('Thanks.', '', ...FORWARD(), '', '> Hello Alice,', '> The desks are ready.', '>', '> Bob');
        const got = rebuild(body, 'Fwd: Desks for the office');
        expect(summary(got)).toEqual([
            { kind: 'forward', depth: 1, empty: false, text: 'Hello Alice,\nThe desks are ready.\n\nBob', subject: 'Desks for the office', fromChain: false },
        ]);
        expect(got[0]?.quoteMarksRemoved).toBe(true);
    });

    it('P1: the nested body may hold the next message (a Gmail quote one level down)', () =>
    {
        const body = lines('Thanks.', '', ...FORWARD(), '', `> ${GMAIL_2}`, '>> Hello Bob,', '>> Can you come?');
        const got = rebuild(body, 'Fwd: Desks for the office');
        // The forward's own part is empty (its header is followed by the next header, one level deeper): an empty forward
        // at that depth (R6), then the Gmail quote.
        expect(got.map((m) => [m.kind, m.noOwnText, m.depth])).toEqual([['forward', true, 1], ['reply', false, 2]]);
        expect(got[1]?.reconstructedText).toBe('Hello Bob,\nCan you come?\n');
    });

    it('P1: only when ALL its text lines are one level deeper; else the body stays at the header depth', () =>
    {
        const body = lines('Thanks.', '', ...FORWARD(), '', '> Hello Alice,', 'Unquoted line.');
        const got = rebuild(body, 'Fwd: Desks for the office');
        expect(got.map((m) => [m.depth, m.reconstructedText.trim()])).toEqual([[0, '> Hello Alice,\nUnquoted line.']]);
    });

    it('P1: not for an Outlook block (user decision F7), not even in a forwarded email', () =>
    {
        for (const subject of ['Re: Office desks', 'FW: Office desks'])
        {
            const got = rebuild(lines('Thanks.', '', ...OUTLOOK(), '', '> Old text.', '> More.'), subject);
            expect(got.map((m) => [m.depth, m.reconstructedText.trim()]), subject).toEqual([[0, '> Old text.\n> More.']]);
        }
    });

    it('F3: an attribution takes the subject of the nearest newer header that has one, else the source subject', () =>
    {
        const quoted = OUTLOOK().map((l) => `> ${l}`);
        const body = lines('Thanks.', '', GMAIL, '> Hello,', '>', ...quoted, '>', '> Older.', '>', `> ${GMAIL_2}`, '>> Oldest.');
        const got = rebuild(body, 'Re: Re: Office desks');
        expect(got.map((m) => [m.subject, m.subjectFromChain])).toEqual([
            ['Re: Re: Office desks', true], // nothing newer: the dropped email's own subject
            ['Office desks', false], // the Outlook block's own
            ['Office desks', true], // the Outlook block above it
        ]);
        // No subject anywhere: none.
        const none = reconstructQuotedMessages(lines(GMAIL, '> Old text.'), { subject: '', sourceOffsetMinutes: 0 });
        expect(none.map((m) => [m.subject, m.subjectFromChain])).toEqual([[null, false]]);
    });

    it('wrapped attributions: over two or three lines, a cut inside the address joined without a space', () =>
    {
        const head = 'On Mon, 3 Mar 2025 at 14:02, Bob Sample';
        for (const wrapped of [
            [head, '<bob@furniture.example.test> wrote:'],
            [`${head} <bob@furni`, 'ture.example.test> wrote:'],
            [head, '<bob@furniture', '.example.test> wrote:'],
            ['On Mon, 3 Mar 2025 at 14:02,', 'Bob Sample <bob@furniture.example.test>', 'wrote:'],
        ])
        {
            const got = rebuild(lines('Thanks.', '', ...wrapped, 'Hello,', 'Old text.'));
            expect(got.map((m) => [m.from, m.dateText, m.reconstructedText]), wrapped.join(' / ')).toEqual([[[BOB], 'Mon, 3 Mar 2025 at 14:02', 'Hello,\nOld text.\n']]);
        }
        // Four lines are never one attribution.
        expect(rebuild(lines('Thanks.', '', 'On Mon, 3 Mar 2025', 'at 14:02,', 'Bob Sample <bob@furniture.example.test>', 'wrote:', 'Hello,'))).toEqual([]);
    });
});

describe('reconstructQuotedMessages: phone styles and empty own texts, built by the thread builder (task 9.9a)', () =>
{
    /** `styles` chained, with the own text of the messages at `empty` left out. */
    const built = (styles: readonly QuoteStyle[], empty: readonly number[]): BuiltThread =>
        buildThread(styleChain(styles).map((m, i) => (empty.includes(i) ? { ...m, text: '' } : m)));

    it.each([
        ['flat FR chain, one empty', ['mobile-fr', 'mobile-fr', 'mobile-fr'], [1]],
        ['flat EN and NL, two empty in a row', ['mobile-en', 'mobile-nl', 'mobile-en', 'mobile-nl'], [1, 2]],
        ['flat inside an Outlook block and a Gmail forward, empty forward', ['mobile-fr', 'outlook-fr', 'mobile-fr', 'gmail-forward-fr', 'mobile-fr'], [3, 5]],
        ['flat inside a Gmail ">" quote', ['mobile-en', 'mobile-en', 'gmail-en', 'mobile-en'], [2]],
        ['an empty Gmail attribution over a deeper one', ['gmail-en', 'gmail-en', 'mobile-en'], [1]],
    ] as const)('%s: every earlier message, field by field', (_name, styles, empty) =>
    {
        const thread = built(styles, empty);
        const got = rebuild(thread.body, thread.subject);
        // The subject an attribution shows: the nearest newer header block's (F3), else the source's.
        let chainSubject = thread.subject;
        const want = thread.headers.map((h) =>
        {
            const isBlock = !(h.style.startsWith('mobile-') || h.style.startsWith('gmail-en') || h.style.startsWith('apple-') || h.style === 'thunderbird-en');
            const subject = isBlock ? h.subject : chainSubject;
            chainSubject = subject;
            return { generation: h.generation, start: h.start, depth: h.textDepth, from: [h.sender.name, h.sender.address], date: h.fields.date, subject,
                fromChain: !isBlock, empty: h.ownText === '', text: h.ownText };
        });
        const have = got.map((m) => ({ generation: m.generation, start: m.start, depth: m.depth, from: [m.from[0]?.name, m.from[0]?.address], date: m.dateText,
            subject: m.subject, fromChain: m.subjectFromChain, empty: m.noOwnText, text: m.reconstructedText.trim() }));
        expect(have).toEqual(want);
        expect(checkProperties(thread.body, got)).toEqual([]);
    });
});

describe('removeQuoteMarks (option A)', () =>
{
    const strip = (text: string, depth: number): string => removeQuoteMarks(text, 0, text.length, depth);

    it.each([
        ['> a\n> b\n', 1, 'a\nb\n'],
        ['>> a\n>\n', 1, '> a\n\n'],
        ['>> a\n', 2, 'a\n'],
        ['> > a\n', 1, '> a\n'],
        ['> > a\n', 2, 'a\n'],
        ['>a\n', 1, 'a\n'],
        ['>  a\n', 1, ' a\n'], // one space only
        ['  > a\n', 1, 'a\n'], // spaces before a mark belong to it
        ['>\t a\n', 1, '\t a\n'], // a tab is not the space after the mark
        ['>\u00a0a\n', 1, 'a\n'], // a no-break space is (P3, task 9.9a: "> &nbsp;" from HTML)
        ['>\u00a0\u00a0a\n', 1, '\u00a0a\n'], // one only
        ['> \u00a0a\n', 1, '\u00a0a\n'], // a space then a no-break space: the space only
        ['> a\r\n> b\r\n', 1, 'a\r\nb\r\n'],
        ['>\n\n> b', 2, '\n\nb'], // blank lines lose the marks they have
        ['> a -> b > c\n', 1, 'a -> b > c\n'], // only leading marks
        ['no marks\n', 0, 'no marks\n'],
    ] as const)('%j at depth %d', (text, depth, want) =>
    {
        expect(strip(text, depth)).toBe(want);
        expect(strip(text, depth)).toBe(oracle(text, depth));
    });

    it('reads only [from, to)', () =>
    {
        expect(removeQuoteMarks('xx> a\n> b\nyy', 2, 10, 1)).toBe('a\nb\n');
    });
});

describe('reconstructQuotedMessages: odd and hostile input', () =>
{
    it('never throws on odd input', () =>
    {
        expect(reconstructQuotedMessages(undefined as unknown as string, { sourceOffsetMinutes: 0 })).toEqual([]);
        expect(reconstructQuotedMessages('', { sourceOffsetMinutes: null })).toEqual([]);
        expect(reconstructQuotedMessages(lines(GMAIL, '> a', '> b'), undefined as unknown as { sourceOffsetMinutes: null }).length).toBe(1);
        expect(reconstructQuotedMessages(lines(GMAIL, '> a', '> b'), { sourceOffsetMinutes: Number.NaN }).length).toBe(1);
    });

    it('random bodies built from header pieces: no throw, and the properties hold', () =>
    {
        const pieces = ['From: ', 'Sent: ', 'To: ', 'Subject: ', 'De : ', 'Van: ', 'On ', 'Le ', ' wrote:', ' a \u00e9crit :', ' schreef ', '<a@x.example.test>', 'Bob Sample', ',', ';', 'Mon, 3 Mar 2025 at 14:02', 'Monday, March 3, 2025 9:15 AM', '2025', 'x', ' ', '\n', '\n', '\r\n', '> ', '>', '>> ', '> > ', '_'.repeat(32), '-----Original Message-----', FORWARDED_SEPARATOR, '\u00a0'];
        let seed = 11;
        const rand = (limit: number): number =>
        {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed % limit;
        };
        for (let round = 0; round < 600; round++)
        {
            let body = '';
            const length = 5 + rand(120);
            for (let k = 0; k < length; k++)
            {
                body += pieces[rand(pieces.length)] ?? '';
            }
            expect(checkProperties(body, rebuild(body, rand(2) === 0 ? 'Fwd: x' : 'Re: x')), body).toEqual([]);
        }
    });

    it('generated threads with random lines inserted: the properties hold, and never more messages than real ones', () =>
    {
        const inserts = ['', '>', 'Inline answer.', '> inserted quote', '>> deeper', '> > apple deeper', '-----Original Message-----', 'From: x', `> ${GMAIL}`, GMAIL, '\r', '  > spaced'];
        let seed = 5;
        const rand = (limit: number): number =>
        {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed % limit;
        };
        let rebuilt = 0;
        for (let round = 0; round < 400; round++)
        {
            const testCase = THREAD_CASES[rand(THREAD_CASES.length)];
            if (testCase === undefined)
            {
                continue;
            }
            const bodyLines = testCase.thread.body.split('\n');
            const lineIndex = rand(bodyLines.length);
            bodyLines.splice(lineIndex, 0, inserts[rand(inserts.length)] ?? '');
            const body = bodyLines.join('\n');
            const got = rebuild(body, testCase.thread.subject);
            rebuilt += got.length;
            expect(checkProperties(body, got), `${testCase.id} + line ${lineIndex}`).toEqual([]);
            // An inserted GMAIL line may be a real-looking extra header; the others never add messages.
            expect(got.length, `${testCase.id} + line ${lineIndex}`).toBeLessThanOrEqual(testCase.thread.headers.length + 1);
        }
        expect(rebuilt).toBeGreaterThan(0); // the properties were checked on real results, not only on []
    });

    it('a body over MAX_SOURCE_LENGTH is not read', () =>
    {
        const body = lines(GMAIL, '> a', '> b') + 'x'.repeat(MAX_SOURCE_LENGTH);
        expect(rebuild(body)).toEqual([]);
    });

    it('thousands of ">" levels: fast, nothing rebuilt beyond MAX_QUOTE_DEPTH', () =>
    {
        const deep = `${'>'.repeat(200_000)} ${GMAIL}\n${'>'.repeat(200_001)} old\n`;
        const startTime = performance.now();
        expect(rebuild(deep)).toEqual([]);
        // A Gmail chain 150 levels deep: the chain stops past MAX_QUOTE_DEPTH (the last holder dropped too).
        const parts: string[] = ['Thanks.', ''];
        for (let d = 0; d < 150; d++)
        {
            parts.push(`${'>'.repeat(d)}${d === 0 ? '' : ' '}${GMAIL}`, `${'>'.repeat(d + 1)} text ${d}`, '>'.repeat(d + 1));
        }
        const chain = lines(...parts);
        const got = rebuild(chain);
        expect(got.length).toBe(MAX_QUOTE_DEPTH - 1);
        expect(Math.max(...got.map((m) => m.depth))).toBeLessThanOrEqual(MAX_QUOTE_DEPTH);
        expect(checkProperties(chain, got)).toEqual([]);
        expect(performance.now() - startTime).toBeLessThan(2000);
    });

    it('thousands of header-like lines: fast and nothing rebuilt', () =>
    {
        for (const body of ['From: a\n'.repeat(100_000), `${GMAIL}\n> x\n`.repeat(5_000), 'From: a <a@x.example.test>\nSent: 2025\nTo: b\n'.repeat(30_000)])
        {
            const startTime = performance.now();
            expect(rebuild(body)).toEqual([]);
            expect(performance.now() - startTime).toBeLessThan(2000);
        }
    });

    it(`a long Outlook chain: at most MAX_RECONSTRUCTED (${MAX_RECONSTRUCTED}) messages, the last one still ends at the next header`, () =>
    {
        const block = lines(...OUTLOOK(), '', 'Old text.', '');
        const body = `Thanks.\n\n${block.repeat(MAX_RECONSTRUCTED + 20)}`;
        const startTime = performance.now();
        const got = rebuild(body);
        expect(performance.now() - startTime).toBeLessThan(3000);
        expect(got.length).toBe(MAX_RECONSTRUCTED);
        expect(got[got.length - 1]?.end).toBe('Thanks.\n\n'.length + MAX_RECONSTRUCTED * block.length);
        expect(checkProperties(body, got)).toEqual([]);
    });

    it('a huge quoted body is handled in linear time', () =>
    {
        const quoted = Array.from({ length: 200_000 }, (_, i) => `> line ${i} of the old message\n`).join('');
        const body = `Thanks.\n\n${GMAIL}\n${quoted}`;
        const startTime = performance.now();
        const got = rebuild(body);
        expect(performance.now() - startTime).toBeLessThan(3000);
        expect(got.length).toBe(1);
        expect(checkProperties(body, got)).toEqual([]);
    });
});
