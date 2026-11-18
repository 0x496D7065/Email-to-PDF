// Tests for the quoted header field reader (milestone 7, task 7.3; README.md,
// rule R7). Synthetic data only: the ground-truth threads of
// Helper/Test/test-support/thread-cases.ts, fixtures 13 and 22, and small bodies below.
//
// Non-ASCII letters are written as \u escapes so this file stays ASCII:
// \u00e0 = a grave, \u00e9 = e acute, \u00c0 = capital A grave,
// \u00c9 = capital E acute, \u00a0 = no-break space.

import { describe, expect, it } from 'vitest';
import { parseAllFixtures } from '../../Helper/Test/test-data/parse-all';
import { expectedFields, fieldDiffs } from '../../Helper/Test/test-support/quoted-header-truth';
import { THREAD_CASES } from '../../Helper/Test/test-support/thread-cases';
import { headerLabelCounts, MAX_MAILBOXES, parseMailboxList, readQuotedHeader, type QuotedHeaderFields } from './quoted-header';
import { findReplyHeaders } from './reply-header';
import type { EmailAddress } from '../../Header/parsed-email';

/** The fields of every header findReplyHeaders finds in `body`. */
function readAll(body: string, subject = ''): QuotedHeaderFields[]
{
    return findReplyHeaders(body, subject).map((h) => readQuotedHeader(body, h));
}

/** The one header of `body`. */
function readOne(body: string, subject = ''): QuotedHeaderFields
{
    const all = readAll(body, subject);
    expect(all).toHaveLength(1);
    return all[0] as QuotedHeaderFields;
}

const box = (name: string, address = ''): EmailAddress => ({ name, address });

/** The ground-truth case whose names-only To list is wrapped: refused on purpose (file comment, rule 1). */
const NAMES_ONLY_WRAPPED = 'outlook-nl wrapped names only';

describe('readQuotedHeader: every header of the ground-truth threads', () =>
{
    it('reads from, to, cc, subject, the date text and the true header end', () =>
    {
        const problems: string[] = [];
        let checked = 0;
        for (const testCase of THREAD_CASES)
        {
            if (testCase.id === NAMES_ONLY_WRAPPED)
            {
                continue; // a safe refusal (next test)
            }
            const found = findReplyHeaders(testCase.thread.body, testCase.thread.subject);
            for (const header of testCase.thread.headers)
            {
                const hit = found.find((f) => f.start === header.start);
                if (hit === undefined)
                {
                    problems.push(`${testCase.id}: generation ${header.generation} not found`);
                    continue;
                }
                checked++;
                const diffs = fieldDiffs(header, readQuotedHeader(testCase.thread.body, hit));
                if (diffs.length > 0)
                {
                    problems.push(`${testCase.id}: generation ${header.generation} (${header.style}): ${diffs.join('; ')}`);
                }
            }
        }
        expect(problems).toEqual([]);
        expect(checked).toBeGreaterThan(100);
    });

    it('refuses a wrapped names-only list: the label line only, flagged incomplete, nothing after it read', () =>
    {
        const testCase = THREAD_CASES.find((x) => x.id === NAMES_ONLY_WRAPPED);
        if (testCase === undefined)
        {
            throw new Error('case missing');
        }
        let checked = 0;
        for (const foundHeader of findReplyHeaders(testCase.thread.body, testCase.thread.subject))
        {
            const truth = testCase.thread.headers.find((h) => h.start === foundHeader.start);
            if (truth === undefined)
            {
                continue;
            }
            checked++;
            const want = expectedFields(truth);
            const got = readQuotedHeader(testCase.thread.body, foundHeader);
            expect(got.from).toEqual(want.from);
            expect(got.dateText).toBe(want.dateText);
            expect(got.cc).toEqual(want.cc);
            // Fewer names than written, each one the start of the true name (the
            // line may wrap inside a name): never a body line, never made up.
            expect(got.to.length).toBeGreaterThan(0);
            expect(got.to.length).toBeLessThan(want.to.length);
            got.to.forEach((b, i) => expect(want.to[i]?.name.startsWith(b.name)).toBe(true));
            expect(got.incomplete).toEqual(['to']);
            // The wrapped lines (and the Subject after them) are not read: they stay in the original text.
            expect(got.subject).toBeNull();
            expect(got.headerEnd).toBe(foundHeader.headEnd);
        }
        expect(checked).toBe(2);
    });

    it('fixes the wrapped To/Cc header end of findReplyHeaders (7.1 gap)', () =>
    {
        const wrapped = THREAD_CASES.filter((c) => c.group === 'outlook-wrapped');
        expect(wrapped.length).toBeGreaterThan(0);
        let shortened = 0;
        for (const testCase of wrapped)
        {
            if (testCase.id === NAMES_ONLY_WRAPPED)
            {
                continue; // refused (test above)
            }
            for (const foundHeader of findReplyHeaders(testCase.thread.body, testCase.thread.subject))
            {
                const truth = testCase.thread.headers.find((h) => h.start === foundHeader.start);
                if (truth === undefined)
                {
                    continue;
                }
                if (foundHeader.headEnd < truth.headEnd)
                {
                    shortened++;
                }
                const got = readQuotedHeader(testCase.thread.body, foundHeader);
                expect(got.headerEnd).toBe(truth.headEnd);
                expect(got.headerEnd).toBeGreaterThanOrEqual(foundHeader.headEnd);
            }
        }
        expect(shortened).toBeGreaterThan(0); // the gap is really there in findReplyHeaders
    });
});

describe('readQuotedHeader: fixtures', () =>
{
    it('reads the three headers of fixture 13 (Outlook NL over a Gmail quote over a quoted Outlook EN block)', async () =>
    {
        const message = (await parseAllFixtures()).find((x) => x.source.fileName === 'eml/13-order-4-bob-outlook-nl.eml');
        if (message === undefined)
        {
            throw new Error('fixture 13 missing');
        }
        const body = message.bodyText;
        const found = findReplyHeaders(body, message.subject ?? undefined);
        const got = found.map((h) => readQuotedHeader(body, h));
        expect(got).toHaveLength(3);
        const alice = box('Alice Example', 'alice@example.test');
        const bob = box('Bob Sample', 'bob@furniture.example.test');
        const lineEnd = (snippet: string): number => body.indexOf('\n', body.indexOf(snippet)) + 1;
        expect(got[0]).toEqual({ from: [alice], to: [bob], cc: [], subject: 'Re: Office desks and chairs', dateText: 'maandag 3 maart 2025 15:40', headerEnd: lineEnd('Onderwerp: Re:'), incomplete: [] });
        expect(got[1]).toEqual({ from: [bob], to: [], cc: [], subject: null, dateText: 'Mon, 3 Mar 2025 at 14:02', headerEnd: lineEnd('On Mon, 3 Mar 2025'), incomplete: [] });
        expect(got[2]).toEqual({ from: [alice], to: [bob], cc: [], subject: 'Office desks and chairs', dateText: 'Monday, March 3, 2025 9:15 AM', headerEnd: lineEnd('> Subject: Office'), incomplete: [] });
        // The body text is left as it was.
        expect(message.bodyText).toBe(body);
    });

    it('reads both attributions of fixture 22 (Gmail FR, Apple EN inside ">>", accented name)', async () =>
    {
        const message = (await parseAllFixtures()).find((x) => x.source.fileName === 'eml/22-delivery-3-carol-gmail-fr.eml');
        if (message === undefined)
        {
            throw new Error('fixture 22 missing');
        }
        const got = findReplyHeaders(message.bodyText, message.subject ?? undefined).map((h) => readQuotedHeader(message.bodyText, h));
        expect(got.map((g) => [g.from, g.dateText, g.subject])).toEqual([
            [[box('Alice Example', 'alice@example.test')], 'mar. 4 mars 2025 \u00e0 13:05', null],
            [[box('Carol Test - \u00c9quipe Livraisons', 'carol@sample.invalid')], '4 Mar 2025, at 11:20', null],
        ]);
    });
});

describe('readQuotedHeader: header blocks', () =>
{
    const RULE = '_'.repeat(32);

    it('reads an Outlook EN block with names only and a Bcc it does not report as Cc', () =>
    {
        const body = [
            'Fine by me.',
            '',
            RULE,
            'From: Bob Sample',
            'Sent: Monday, March 3, 2025 9:15 AM',
            'To: Alice Example; Carol Test; Dave Placeholder; Erin Fictive',
            'Bcc: Frank Mockup',
            'Subject: RE: Desks',
            '',
            'Old text.',
            '',
        ].join('\n');
        const got = readOne(body);
        expect(got.from).toEqual([box('Bob Sample')]);
        expect(got.to).toEqual([box('Alice Example'), box('Carol Test'), box('Dave Placeholder'), box('Erin Fictive')]);
        expect(got.cc).toEqual([]);
        expect(got.subject).toBe('RE: Desks');
        expect(got.dateText).toBe('Monday, March 3, 2025 9:15 AM');
        expect(got.incomplete).toEqual([]);
        expect(got.headerEnd).toBe(body.indexOf('\n', body.indexOf('Subject:')) + 1);
    });

    it('reads French labels with a space before the colon, mailto addresses and a nbsp', () =>
    {
        const body = [
            'Merci.',
            '',
            "-----Message d'origine-----",
            'De\u00a0: Carol Test [mailto:carol@sample.invalid]',
            'Envoy\u00e9 : lundi 3 mars 2025 15:40',
            '\u00c0 : Alice Example [mailto:alice@example.test]',
            'Cc : Bob Sample [mailto:bob@furniture.example.test]',
            'Objet : RE : Livraison',
            '',
            'Ancien texte.',
        ].join('\n');
        const got = readOne(body);
        expect(got.from).toEqual([box('Carol Test', 'carol@sample.invalid')]);
        expect(got.to).toEqual([box('Alice Example', 'alice@example.test')]);
        expect(got.cc).toEqual([box('Bob Sample', 'bob@furniture.example.test')]);
        expect(got.subject).toBe('RE : Livraison');
        expect(got.dateText).toBe('lundi 3 mars 2025 15:40');
    });

    it('reads a Gmail forward with bold-star labels, comma lists and quoted names', () =>
    {
        const body = [
            'See below.',
            '',
            '---------- Forwarded message ---------',
            '*From:* "Sample, Bob" <bob@furniture.example.test>',
            '*Date:* Mon, Mar 3, 2025 at 2:02 PM',
            '*Subject:* Desks',
            '*To:* Alice Example <alice@example.test>, carol@sample.invalid',
            '',
            'Forwarded text.',
        ].join('\n');
        const got = readOne(body, 'Fwd: Desks');
        expect(got.from).toEqual([box('Sample, Bob', 'bob@furniture.example.test')]);
        expect(got.to).toEqual([box('Alice Example', 'alice@example.test'), box('', 'carol@sample.invalid')]);
        expect(got.subject).toBe('Desks');
        expect(got.dateText).toBe('Mon, Mar 3, 2025 at 2:02 PM');
    });

    it('reads a block inside a ">>" quote at its own depth only', () =>
    {
        const body = [
            'New text.',
            '',
            '>> -----Original Message-----',
            '>> From: Bob Sample <bob@furniture.example.test>',
            '>> Sent: Monday, March 3, 2025 9:15 AM',
            '>> To: Alice Example <alice@example.test>,',
            '>> Carol Test <carol@sample.invalid>',
            '>> Subject: Desks',
            '>>',
            '>> Old text.',
        ].join('\n');
        const got = readOne(body);
        expect(got.to).toEqual([box('Alice Example', 'alice@example.test'), box('Carol Test', 'carol@sample.invalid')]);
        expect(got.subject).toBe('Desks');
        expect(got.headerEnd).toBe(body.indexOf('>>\n>> Old'));
    });

    it('never reads a list continuation after the last label: the list is flagged incomplete instead', () =>
    {
        const goesOn = ['---------- Forwarded message ---------', 'From: Bob <bob@x.example.test>', 'Date: Mon, Mar 3, 2025 at 2:02 PM', 'Subject: Desks', 'To: Alice <alice@example.test>,', 'Carol <carol@sample.invalid>', 'Body line one.', ''].join('\n');
        const goesOnFields = readOne(goesOn, 'Fwd: Desks');
        expect(goesOnFields.to).toEqual([box('Alice', 'alice@example.test')]);
        expect(goesOnFields.incomplete).toEqual(['to']);
        expect(goesOnFields.headerEnd).toBe(goesOn.indexOf('Carol <carol'));
        // No blank line between the last label and the body, no "," or ";": the body line is not read.
        const stops = ['---------- Forwarded message ---------', 'From: Bob <bob@x.example.test>', 'Date: Mon, Mar 3, 2025 at 2:02 PM', 'Subject: Desks', 'To: Alice <alice@example.test>', 'Body line one.', ''].join('\n');
        const stopsFields = readOne(stops, 'Fwd: Desks');
        expect(stopsFields.to).toEqual([box('Alice', 'alice@example.test')]);
        expect(stopsFields.headerEnd).toBe(stops.indexOf('Body line one.'));
    });

    it('does not read a following block or intro line as a continuation', () =>
    {
        const body = [
            RULE,
            'From: Bob <bob@x.example.test>',
            'Sent: Monday, March 3, 2025 9:15 AM',
            'To: Alice <alice@example.test>;',
            '-----Original Message-----',
            'From: Carol <carol@sample.invalid>',
            'Sent: Monday, March 3, 2025 8:15 AM',
            'To: Bob <bob@x.example.test>',
            '',
        ].join('\n');
        const first = readAll(body)[0];
        expect(first?.to).toEqual([box('Alice', 'alice@example.test')]);
        expect(first?.headerEnd).toBe(body.indexOf('-----Original'));
    });

    it('leaves missing fields empty: no subject is ever made up', () =>
    {
        const body = ['Begin forwarded message:', '', 'From: Bob <bob@x.example.test>', 'Date: 3 March 2025 at 14:02:00 GMT+9', 'To: Alice <alice@example.test>', '', 'Text.'].join('\n');
        const got = readOne(body, 'Fwd: Office desks and chairs');
        expect(got.subject).toBeNull();
        expect(got.cc).toEqual([]);
        expect(got.dateText).toBe('3 March 2025 at 14:02:00 GMT+9');
        const emptySubject = readOne(body.replace('To: Alice', 'Subject:\nTo: Alice'), 'Fwd: x');
        expect(emptySubject.subject).toBe('');
    });

    it('a separator alone gives empty fields', () =>
    {
        const body = 'Text.\n\n-----Original Message-----\n\nOld text.\n';
        const got = readOne(body);
        expect(got).toEqual({ from: [], to: [], cc: [], subject: null, dateText: null, headerEnd: body.indexOf('\n\nOld') + 1, incomplete: [] });
    });
});

describe('readQuotedHeader: attributions', () =>
{
    const attribution = (line: string): QuotedHeaderFields => readOne(`New.\n\n${line}\n> Old text.\n`);

    it.each([
        ['On Mon, Mar 3, 2025 at 2:02 PM Bob Sample <bob@x.example.test> wrote:', 'Bob Sample', 'bob@x.example.test', 'Mon, Mar 3, 2025 at 2:02 PM'],
        ['On Mon, 3 Mar 2025 at 14:02, Bob Sample <bob@x.example.test> wrote:', 'Bob Sample', 'bob@x.example.test', 'Mon, 3 Mar 2025 at 14:02'],
        ['On 3 Mar 2025, at 14:02, Bob Sample <bob@x.example.test> wrote:', 'Bob Sample', 'bob@x.example.test', '3 Mar 2025, at 14:02'],
        ['On 03/03/2025 14:02, Bob Sample wrote:', 'Bob Sample', '', '03/03/2025 14:02'],
        ['On Mon, 3 Mar 2025 at 14:02, bob@x.example.test wrote:', '', 'bob@x.example.test', 'Mon, 3 Mar 2025 at 14:02'],
        ['On Mon, 3 Mar 2025 at 14:02, "Sample, Bob" <bob@x.example.test> wrote:', 'Sample, Bob', 'bob@x.example.test', 'Mon, 3 Mar 2025 at 14:02'],
        ['On 3/3/25 2:02 p.m., Bob Sample [mailto:bob@x.example.test] wrote:', 'Bob Sample', 'bob@x.example.test', '3/3/25 2:02 p.m.'],
        ['Le lun. 3 mars 2025 \u00e0 14:02, Bob Sample <bob@x.example.test> a \u00e9crit :', 'Bob Sample', 'bob@x.example.test', 'lun. 3 mars 2025 \u00e0 14:02'],
        ['Le 3 mars 2025 \u00e0 14:02, Bob Sample <bob@x.example.test> a ecrit:', 'Bob Sample', 'bob@x.example.test', '3 mars 2025 \u00e0 14:02'],
        ['Op ma 3 mrt 2025 om 14:02 schreef Bob Sample <bob@x.example.test>:', 'Bob Sample', 'bob@x.example.test', 'ma 3 mrt 2025 om 14:02'],
        ['Op 3 mrt. 2025 om 14:02 heeft Bob Sample <bob@x.example.test> het volgende geschreven:', 'Bob Sample', 'bob@x.example.test', '3 mrt. 2025 om 14:02'],
    ])('%s', (line, name, address, date) =>
    {
        const got = attribution(line);
        expect(got.from).toEqual([box(name, address)]);
        expect(got.dateText).toBe(date);
        expect(got.to).toEqual([]);
        expect(got.subject).toBeNull();
    });

    it('reads an attribution wrapped over two lines (address split at the wrap)', () =>
    {
        const got = readOne('New.\n\nOn Mon, Mar 3, 2025 at 2:02 PM Bob Sample <\nbob@x.example.test> wrote:\n> Old text.\n');
        expect(got.from).toEqual([box('Bob Sample', 'bob@x.example.test')]);
        expect(got.dateText).toBe('Mon, Mar 3, 2025 at 2:02 PM');
    });

    it('leaves the name and date empty when the split is not clear-cut (the address stays)', () =>
    {
        // An unquoted comma inside the name: the "date" would end with a word.
        const comma = attribution('On Mon, 3 Mar 2025 at 14:02, Sample, Bob <bob@x.example.test> wrote:');
        expect(comma.from).toEqual([box('', 'bob@x.example.test')]);
        expect(comma.dateText).toBeNull();
        // A digit in what would be the name.
        const digit = attribution('On Monday, Team 42 <team@x.example.test> wrote:');
        expect(digit.from).toEqual([box('', 'team@x.example.test')]);
        expect(digit.dateText).toBeNull();
        // No comma, no time, no address: nothing at all.
        expect(attribution('On 3 March Bob Sample wrote:').from).toEqual([]);
        expect(attribution('On 3 March Bob Sample wrote:').dateText).toBeNull();
    });

    it('Dutch without an address: a clause after the name is not read as the name', () =>
    {
        const clause = readOne('Hoi,\n\nOp 3 maart 2025 schreef Bob dat hij later komt:\n> ok\n');
        expect(clause.from).toEqual([]);
        expect(clause.dateText).toBe('3 maart 2025');
        // Too many words, even all capitalized or particles.
        expect(attribution('Op 3 maart 2025 schreef Bob Van Der Berg Junior:').from).toEqual([]);
        // A name with Dutch particles is kept.
        expect(attribution('Op 3 maart 2025 schreef Jan van der Berg:').from).toEqual([box('Jan van der Berg')]);
        expect(attribution("Op 3 maart 2025 schreef Piet in 't Veld:").from).toEqual([box("Piet in 't Veld")]);
        expect(attribution('Op 3 mrt. 2025 om 14:02 heeft Bob Sample het volgende geschreven:').from).toEqual([box('Bob Sample')]);
        // With an address the name is read as before (the address bounds it).
        expect(attribution('Op 3 maart 2025 schreef Jan van der Berg <jan@x.example.test>:').from).toEqual([box('Jan van der Berg', 'jan@x.example.test')]);
        // "in" is a particle only before "'t".
        expect(attribution('Op 3 maart 2025 schreef Piet in Veld:').from).toEqual([]);
    });

    it('EN/FR without an address: a clause where the name is gives no sender, the date is kept', () =>
    {
        const clauses: readonly [string, string][] = [
            ['On 3 March 2025, Bob forwarded what Carol wrote:', '3 March 2025'],
            ['Le 3 mars 2025, Bob a transmis ce que Carol a \u00e9crit :', '3 mars 2025'],
            ['On Mon, Mar 3, 2025, Bob replied and wrote:', 'Mon, Mar 3, 2025'],
            ['On Mon, Mar 3, 2025, Bob said that he wrote:', 'Mon, Mar 3, 2025'],
            // Accepted cost: a lowercase word before the name.
            ['On 3 March 2025, my colleague Bob wrote:', '3 March 2025'],
        ];
        for (const [text, date] of clauses)
        {
            const got = attribution(text);
            expect(got.from, text).toEqual([]);
            expect(got.dateText, text).toBe(date);
        }
        // Name-shaped names are still read, French particles included.
        expect(attribution('On 3 March 2025, Bob Sample wrote:').from).toEqual([box('Bob Sample')]);
        expect(attribution('Le 3 mars 2025, Jean de La Fontaine a \u00e9crit :').from).toEqual([box('Jean de La Fontaine')]);
        expect(attribution('Le 3 mars 2025, Jeanne d\'Arc a \u00e9crit :').from).toEqual([box("Jeanne d'Arc")]);
        expect(attribution('Le 3 mars 2025, Marie du Bois a \u00e9crit :').from).toEqual([box('Marie du Bois')]);
    });

    it('with an address, a name that is not name-shaped is dropped and the address kept (7.3 review)', () =>
    {
        const cases: readonly [string, string | null][] = [
            ['On 3 March 2025, my colleague Bob <bob@x.example.test> wrote:', '3 March 2025'],
            ['On 3 March 2025, I <bob@x.example.test> wrote:', '3 March 2025'],
            ['Le 3 mars 2025, Je <bob@x.example.test> a \u00e9crit :', '3 mars 2025'],
            ['Op 3 maart 2025 schreef Ik <bob@x.example.test>:', '3 maart 2025'],
            ['On 3 March 2025, Bob & Carol <bob@x.example.test> wrote:', '3 March 2025'],
            ['On 3 March 2025, Bob/Carol <bob@x.example.test> wrote:', '3 March 2025'],
            // No opener: no date, the same name test.
            ['my colleague Bob <bob@x.example.test> wrote:', null],
            ['Bob & Carol <bob@x.example.test> wrote:', null],
        ];
        for (const [text, date] of cases)
        {
            const got = attribution(text);
            expect(got.from, text).toEqual([box('', 'bob@x.example.test')]);
            expect(got.dateText, text).toBe(date);
        }
        // A name-shaped name with an address is still read.
        expect(attribution('On 3 March 2025, Bob Sample <bob@x.example.test> wrote:').from).toEqual([box('Bob Sample', 'bob@x.example.test')]);
        expect(attribution('Bob Sample <bob@x.example.test> wrote:').from).toEqual([box('Bob Sample', 'bob@x.example.test')]);
        // With an address the word count is not limited: the address bounds the name (fixture 22 has such a name).
        expect(attribution('On 3 March 2025, Carol Test - Delivery Team Ghent <carol@sample.invalid> wrote:').from).toEqual([box('Carol Test - Delivery Team Ghent', 'carol@sample.invalid')]);
    });

    it('without an address, a pronoun alone or a name with "&" or "/" gives no sender (the date is kept)', () =>
    {
        for (const text of ['On 3 March 2025, I wrote:', 'Le 3 mars 2025, Je a \u00e9crit :', 'Op 3 maart 2025 schreef Ik:', 'On 3 March 2025, Bob & Carol wrote:', 'On 3 March 2025, Bob / Carol wrote:'])
        {
            const got = attribution(text);
            expect(got.from, text).toEqual([]);
            expect(got.dateText, text).not.toBeNull();
        }
    });

    it('reads a bare attribution (no opener): address and plain name only, no date', () =>
    {
        const got = readOne('New.\n\nBob Sample <bob@x.example.test> wrote:\n> Old text.\n');
        expect(got.from).toEqual([box('Bob Sample', 'bob@x.example.test')]);
        expect(got.dateText).toBeNull();
        const noAddress = readOne('New.\n\nas Carol wrote:\n> Old text.\n');
        expect(noAddress.from).toEqual([]);
    });

    it.each([
        // Two people, two addresses for one person, a name holding another address: no sender, no date.
        'On Mon, 3 Mar 2025 at 10:00, Bob <bob@x.example.test>, Carol <carol@sample.invalid> wrote:',
        'On Mon, 3 Mar 2025 at 10:00, Bob <bob@x.example.test> <carol@sample.invalid> wrote:',
        'On Mon, 3 Mar 2025 at 10:00, carol@sample.invalid <bob@x.example.test> wrote:',
        'On Mon, 3 Mar 2025 at 10:00, "carol@sample.invalid" <bob@x.example.test> wrote:',
        'On 4 Mar 2025, at 11:20, "Bob <boss@x.example.test>" <carol@sample.invalid> wrote:',
        'Bob <bob@x.example.test> <carol@sample.invalid> wrote:',
        // An "@" but no address read at the end.
        'On 4 Mar 2025, at 11:20, Carol <carol@sample.invalid> as sent to the team wrote:',
    ])('two addresses (or an unread one) give nothing: %s', (line) =>
    {
        const got = attribution(line);
        expect(got.from).toEqual([]);
        expect(got.dateText).toBeNull();
    });

    it.each([
        // The same address written twice (any case) is one sender; the name holding it is not shown.
        ['On Mon, 3 Mar 2025 at 10:00, bob@x.example.test <mailto:BOB@x.example.test> wrote:', '', 'BOB@x.example.test', 'Mon, 3 Mar 2025 at 10:00'],
        ['On Mon, 3 Mar 2025 at 10:00, Bob Sample <mailto:bob@x.example.test> wrote:', 'Bob Sample', 'bob@x.example.test', 'Mon, 3 Mar 2025 at 10:00'],
        ['On Mon, 3 Mar 2025 at 10:00, Bob Sample <bob@x.example.test<mailto:bob@x.example.test>> wrote:', 'Bob Sample', 'bob@x.example.test', 'Mon, 3 Mar 2025 at 10:00'],
        // A comment after the address is left aside.
        ['On 4 Mar 2025, at 11:20, Carol <carol@sample.invalid> (Legal) wrote:', 'Carol', 'carol@sample.invalid', '4 Mar 2025, at 11:20'],
        // Dutch "... schreef <name> <addr> het volgende:".
        ['Op 3 mrt 2025 om 10:00 schreef Bob <bob@x.example.test> het volgende:', 'Bob', 'bob@x.example.test', '3 mrt 2025 om 10:00'],
        // A name holding ";" or ":" is not shown (two people, or "Bob wrote: Carol").
        ['On 4 Mar 2025, at 11:20, Bob; Carol <carol@sample.invalid> wrote:', '', 'carol@sample.invalid', '4 Mar 2025, at 11:20'],
        ['On 4 Mar 2025, at 11:20, Bob wrote: Carol <carol@sample.invalid> wrote:', '', 'carol@sample.invalid', '4 Mar 2025, at 11:20'],
    ])('reads the one address and no misleading name: %s', (line, name, address, date) =>
    {
        const got = attribution(line);
        expect(got.from).toEqual([box(name, address)]);
        expect(got.dateText).toBe(date);
    });
});

describe('readQuotedHeader: wrapped lists never take body text (file comment, rule 1)', () =>
{
    const SEPARATOR = '-----Original Message-----';
    const HEAD = [SEPARATOR, 'From: Bob <bob@x.example.test>', 'Sent: Mon 3/3/2025 10:00'];
    /** The one header of `lines` joined, and the offset of `snippet` in it. */
    const read = (lines: readonly string[], subject = ''): { got: QuotedHeaderFields; offsetOf: (snippet: string) => number } =>
    {
        const body = `${lines.join('\n')}\n`;
        return { got: readOne(body, subject), offsetOf: (snippet) => body.indexOf(snippet) };
    };

    it('a Subject never continues, even with a label-like line further down (B1)', () =>
    {
        const { got, offsetOf } = read([...HEAD, 'To: Carol <carol@sample.invalid>', 'Subject: P', 'Hi Carol,', 'Please see below.', 'Date: Friday works for me.', '', 'Bye']);
        expect(got.subject).toBe('P');
        expect(got.dateText).toBe('Mon 3/3/2025 10:00');
        expect(got.headerEnd).toBe(offsetOf('Hi Carol,'));
    });

    it('a complete list without a separator does not go on: the body and its "Cc:" line stay out (B1)', () =>
    {
        const { got, offsetOf } = read([...HEAD, 'To: Carol <carol@sample.invalid>', 'Hello Carol this is body', 'more body', 'Cc: something in body', '', 'end']);
        expect(got.to).toEqual([box('Carol', 'carol@sample.invalid')]);
        expect(got.cc).toEqual([]);
        expect(got.headerEnd).toBe(offsetOf('Hello Carol'));
    });

    it('a names-only list does not take a body line either', () =>
    {
        const { got, offsetOf } = read(
            [...HEAD, 'To: Carol Doe; Dan Roe', 'Hello Carol this is body', 'more body', 'Cc: something in body', '', 'end']);
        // A text line follows the list: it may go on, and "Dan Roe" may be cut short there: left out.
        expect(got.to).toEqual([box('Carol Doe')]);
        expect(got.incomplete).toEqual(['to']);
        expect(got.cc).toEqual([]);
        expect(got.headerEnd).toBe(offsetOf('Hello Carol'));
        // Digits or a colon are not in names: the list is not continued, and the Subject after it is not read.
        const digits = read([...HEAD, 'To: Alice Example; Carol Test;', 'see the file: 3 pages', 'Subject: x', '', 'end']);
        expect(digits.got.to).toEqual([box('Alice Example'), box('Carol Test')]);
        expect(digits.got.subject).toBeNull();
        expect(digits.got.headerEnd).toBe(digits.offsetOf('see the file'));
    });

    it.each([
        ['To: Carol <carol@sample.invalid>;', ['Hi Carol, the contract is attached.']],
        ['To: Carol <carol@sample.invalid>,', ['Hi Carol, the contract is attached.']],
        ['To: Carol <carol@sample.invalid>,', ['Hi Carol,', 'the contract.']],
        ['To: Carol <carol@sample.invalid>;', ['Hi Carol,', 'the contract.', 'Cc: Dan']],
    ])('a list ending with ";" or "," does not take a body line right after it (B2): %s', (to, bodyLines) =>
    {
        const { got, offsetOf } = read([SEPARATOR, 'From: Bob <bob@x.example.test>', 'Sent: Mon 3/3/2025 10:00', 'Subject: P', to, ...bodyLines, '']);
        expect(got.to).toEqual([box('Carol', 'carol@sample.invalid')]);
        expect(got.cc).toEqual([]);
        expect(got.headerEnd).toBe(offsetOf(bodyLines[0] ?? ''));
    });

    it('a body line right after the last label, with a label-like line within MAX_CONTINUATION_LINES lines, stays out (S3)', () =>
    {
        const gmail = read(['---------- Forwarded message ---------', 'From: Bob <bob@x.example.test>', 'Date: Mon, Mar 3, 2025 at 2:02 PM', 'Subject: P', 'To: Carol <carol@sample.invalid>, Dan <dan@example.test>', 'Thanks for the call.', 'Cc: is fine by me', ''], 'Fwd: P');
        expect(gmail.got.to).toEqual([box('Carol', 'carol@sample.invalid'), box('Dan', 'dan@example.test')]);
        expect(gmail.got.cc).toEqual([]);
        expect(gmail.got.headerEnd).toBe(gmail.offsetOf('Thanks for'));
    });

    it('wrapped lines followed by a label of a role already read (or From) are not taken', () =>
    {
        const repeated = read([...HEAD, 'Subject: P', 'To: Carol <carol@sample.invalid>;', 'Eve <eve@sample.invalid>', 'To: Dan said this in the body', 'Date: Friday', '']);
        expect(repeated.got.to).toEqual([box('Carol', 'carol@sample.invalid')]);
        expect(repeated.got.incomplete).toEqual(['to']);
        expect(repeated.got.dateText).toBe('Mon 3/3/2025 10:00');
        expect(repeated.got.headerEnd).toBe(repeated.offsetOf('Eve <eve'));
        const from = read([...HEAD, 'To: Carol <carol@sample.invalid>;', 'Eve <eve@sample.invalid>', 'From: Zed <zed@example.test>', 'Subject: P', '']);
        expect(from.got.to).toEqual([box('Carol', 'carol@sample.invalid')]);
        expect(from.got.incomplete).toEqual(['to']);
        expect(from.got.subject).toBeNull();
        expect(from.got.headerEnd).toBe(from.offsetOf('Eve <eve'));
    });

    it('reads a list wrapped inside a mailbox when a new label follows, and a wrapped Bcc without reporting it', () =>
    {
        const { got, offsetOf } = read([...HEAD, 'To: Carol Test <carol@sample.invalid>; Frank', 'Mockup <frank@example.test>; Heidi Stub', '<heidi@sample.invalid>', 'Bcc: Secret <s@example.test>;', 'Other <o@example.test>', 'Cc: Dan <dan@example.test>', 'Subject: P', 'Body.']);
        expect(got.to).toEqual([box('Carol Test', 'carol@sample.invalid'), box('Frank Mockup', 'frank@example.test'), box('Heidi Stub', 'heidi@sample.invalid')]);
        expect(got.cc).toEqual([box('Dan', 'dan@example.test')]);
        expect(got.subject).toBe('P');
        expect(got.headerEnd).toBe(offsetOf('Body.'));
    });

    it('a mailbox cut short is not completed by a body line, even before a new label', () =>
    {
        const { got, offsetOf } = read([...HEAD, 'To: Carol <carol@sample.invalid>; Frank', 'will call you tomorrow.', 'Cc: Dan <dan@example.test>', 'Subject: P', '']);
        // Frank has no address on the label line and may be cut short there: left out, the list flagged.
        expect(got.to).toEqual([box('Carol', 'carol@sample.invalid')]);
        expect(got.incomplete).toEqual(['to']);
        expect(got.cc).toEqual([]);
        expect(got.subject).toBeNull();
        expect(got.headerEnd).toBe(offsetOf('will call'));
    });

    // Gmail forward head (To is the last label) and an Outlook head with names only.
    const FORWARD = ['---------- Forwarded message ---------', 'From: Bob', 'Date: Mon, 3 Mar 2025 at 10:00', 'Subject: Contract'];
    const FORWARD_ADDRESS = ['---------- Forwarded message ---------', 'From: Bob <bob@x.example.test>', 'Date: Mon, 3 Mar 2025 at 10:00', 'Subject: Contract'];

    it.each([
        ['N2: a body line, then a Cc label', [...FORWARD, 'To: Carol Doe; Frank Roe;', 'Thanks Bob', 'Cc: Dan']],
        ['N4: a closing line, then a Bcc label', [...FORWARD, 'To: Carol Doe; Frank Roe;', 'Kind regards, Carol', 'Bcc: x']],
        ['N5: a short line, then a Subject label', ['From: Bob', 'Sent: Monday, 3 March 2025 10:00', 'To: Carol Doe; Frank Roe;', 'See you soon', 'Subject: x', '', 'body']],
        ['N6: an Outlook list of names really wrapped', ['From: Bob <bob@x.example.test>', 'Sent: Monday, 3 March 2025 10:00', 'To: Carol Doe; Frank Roe;', 'Gina Poe; Heidi Stub', 'Subject: x', '', 'body']],
        ['N10: two body lines, then a Cc label', [...FORWARD, 'To: Carol Doe; Frank Roe;', 'Thanks Bob', 'See below', 'Cc: Dan']],
        ['FR1: "Madame," then "Objet :"', ['De : Bob', 'Envoy\u00e9 : lundi 3 mars 2025 10:00', '\u00c0 : Carol Doe; Frank Roe;', 'Madame,', 'Objet : demande']],
    ])('a names-only list never continues on the next lines (%s)', (_name, lines) =>
    {
        const body = `${lines.join('\n')}\n`;
        const { got, offsetOf } = read(lines, body.startsWith('---') ? 'Fwd: Contract' : 'RE: x');
        expect(got.to).toEqual([box('Carol Doe'), box('Frank Roe')]);
        expect(got.cc).toEqual([]);
        expect(got.incomplete).toEqual(['to']);
        // The line after the list is the first one not read (the label after it neither).
        const after = lines[lines.findIndex((l) => l.includes('Frank Roe;')) + 1] ?? '';
        expect(got.headerEnd).toBe(offsetOf(after));
    });

    it.each([
        ['a lowercase word in the name', 'Write to Dan <dan@x.example.test>'],
        ['a lowercase word, then ";"', 'See dan <dan@x.example.test>;'],
        ['more than MAX_NAME_WORDS words', 'Please Send It To Dan <dan@x.example.test>'],
        ['a bare address', 'dan@x.example.test'],
        ['a bare no-reply address', 'noreply@x.example.test'],
    ])('a wrapped line is not taken, even before a new label, with %s', (_name, line) =>
    {
        const { got, offsetOf } = read([...HEAD, 'To: Carol <carol@sample.invalid>,', line, 'Cc: Eve <eve@example.test>', 'Subject: P', '']);
        expect(got.to).toEqual([box('Carol', 'carol@sample.invalid')]);
        expect(got.cc).toEqual([]);
        expect(got.subject).toBeNull();
        expect(got.incomplete).toEqual(['to']);
        expect(got.headerEnd).toBe(offsetOf(line));
    });

    it.each([
        ['FR2: "Madame" (French Outlook)', ['De : Bob <bob@x.test>', 'Envoy\u00e9 : lundi 3 mars 2025 10:00', '\u00c0 : Carol <carol@x.test>;', 'Madame Doe <md@x.test>', 'Objet : demande', '', 'corps']],
        ['"Dear" (English Outlook)', ['From: Bob <bob@x.test>', 'Sent: Monday, 3 March 2025 10:00', 'To: Carol <carol@x.test>;', 'Dear Bob <bob@x.test>', 'Subject: request', '', 'body']],
        ['"Geachte" (Dutch Outlook)', ['Van: Bob <bob@x.test>', 'Verzonden: maandag 3 maart 2025 10:00', 'Aan: Carol <carol@x.test>;', 'Geachte Jan <jan@x.test>', 'Onderwerp: verzoek', '', 'tekst']],
        ['"Goedemorgen" (Dutch Outlook)', ['Van: Bob <bob@x.test>', 'Verzonden: maandag 3 maart 2025 10:00', 'Aan: Carol <carol@x.test>;', 'Goedemorgen Jan <jan@x.test>', 'Onderwerp: verzoek', '', 'tekst']],
        ['"Bonsoir" (French Outlook)', ['De : Bob <bob@x.test>', 'Envoy\u00e9 : lundi 3 mars 2025 10:00', '\u00c0 : Carol <carol@x.test>;', 'Bonsoir Jan <jan@x.test>', 'Objet : demande', '', 'corps']],
        ['"Good morning" (English Outlook)', ['From: Bob <bob@x.test>', 'Sent: Monday, 3 March 2025 10:00', 'To: Carol <carol@x.test>;', 'Good Morning Jan <jan@x.test>', 'Subject: request', '', 'body']],
        ['"Mr." with a trailing dot',['From: Bob <bob@x.test>', 'Sent: Monday, 3 March 2025 10:00', 'To: Carol <carol@x.test>;', 'Mr. Jan <jan@x.test>', 'Subject: request', '', 'body']],
    ])('a wrapped line starting with a salutation or title is not a recipient (%s)', (_name, lines) =>
    {
        const { got, offsetOf } = read(lines, 'RE: x');
        expect(got.to).toEqual([box('Carol', 'carol@x.test')]);
        expect(got.cc).toEqual([]);
        // The greeting line is the first one not read; the subject label after it neither.
        expect(got.subject).toBeNull();
        expect(got.incomplete).toEqual(['to']);
        expect(got.headerEnd).toBe(offsetOf(lines[3] ?? ''));
    });

    it('a normal wrapped mailbox is still read before the next label', () =>
    {
        const { got, offsetOf } = read(['From: Bob <bob@x.test>', 'Sent: Monday, 3 March 2025 10:00', 'To: Carol <carol@x.test>;', 'Erin Fox <erin@x.test>', 'Subject: request', '', 'body'], 'RE: x');
        expect(got.to).toEqual([box('Carol', 'carol@x.test'), box('Erin Fox', 'erin@x.test')]);
        expect(got.subject).toBe('request');
        expect(got.incomplete).toEqual([]);
        // The header ends at the blank line after the Subject.
        expect(got.headerEnd).toBe(offsetOf('\n\nbody') + 1);
    });

    it.each([
        ['A6: a sentence with a mailbox', [...FORWARD_ADDRESS, 'To: Carol <carol@x.example.test>,', 'Write to Dan <dan@x.example.test>', 'hello']],
        ['A13: a mailbox and ";", then text', [...FORWARD_ADDRESS, 'To: Carol <carol@x.example.test>;', 'See Dan <dan@x.example.test>;', 'ok']],
        ['A5: a bare address, then text', [...FORWARD_ADDRESS, 'To: Carol <carol@x.example.test>;', 'dan@x.example.test', 'hello']],
        ['T1: a bare address, then a blank line', [...FORWARD_ADDRESS, 'To: Carol <carol@x.example.test>,', 'noreply@x.example.test', '', 'body']],
    ])('a list with an address does not continue after the last label (%s)', (_name, lines) =>
    {
        const { got, offsetOf } = read(lines, 'Fwd: Contract');
        expect(got.to).toEqual([box('Carol', 'carol@x.example.test')]);
        expect(got.incomplete).toEqual(['to']);
        expect(got.headerEnd).toBe(offsetOf(lines[5] ?? ''));
    });

    it.each([
        ['F1: two mailboxes', 'Bob <bob@x.example.test>, Carol <carol@sample.invalid>'],
        ['F2: "on behalf of" after a comma', 'Bob <bob@x.example.test>, on behalf of Carol <carol@sample.invalid>'],
        ['F3: "de la part de" after ";"', 'Bob <bob@x.example.test>; de la part de Carol <carol@sample.invalid>'],
        ['two "Last, First" mailboxes', 'Sample, Bob <bob@x.example.test>; Doe, Carol <carol@sample.invalid>'],
    ])('a From line with more than one mailbox gives no sender (%s)', (_name, from) =>
    {
        const { got } = read([SEPARATOR, `From: ${from}`, 'Sent: Mon 3/3/2025 10:00', 'To: Dan <dan@example.test>', 'Subject: P', '', 'Body.']);
        expect(got.from).toEqual([]);
        expect(got.to).toEqual([box('Dan', 'dan@example.test')]);
        expect(got.subject).toBe('P');
    });

    it('flags a To / Cc list that may go on unread, and only such a list', () =>
    {
        // Cc ends with ";" and body text follows: flagged; To is followed by a label: not flagged.
        const cc = read([...HEAD, 'To: Carol <carol@sample.invalid>;', 'Cc: Dan <dan@example.test>;', 'see below', '']);
        expect(cc.got.cc).toEqual([box('Dan', 'dan@example.test')]);
        expect(cc.got.incomplete).toEqual(['cc']);
        // A names-only list wrapped inside a name: no separator at the end, but a
        // text line follows. "Ivan" (really "Ivan Fixture") may be cut: left out.
        const cut = read([...HEAD, 'To: Carol Doe; Ivan', 'Fixture; Judy Roe', 'Subject: P', '']);
        expect(cut.got.to).toEqual([box('Carol Doe')]);
        expect(cut.got.incomplete).toEqual(['to']);
        // The same with an address before (A8): "Heidi" may be cut, left out.
        const heidi = read([...FORWARD_ADDRESS, 'To: Carol <carol@x.example.test>; Heidi', 'Thanks for this', 'hello'], 'Fwd: Contract');
        expect(heidi.got.to).toEqual([box('Carol', 'carol@x.example.test')]);
        expect(heidi.got.incomplete).toEqual(['to']);
        // A complete mailbox with an address is kept even when text follows (A12).
        const kept = read([...FORWARD_ADDRESS, 'To: Carol <carol@x.example.test>', 'Thanks Bob', 'Cc: Dan <dan@example.test>'], 'Fwd: Contract');
        expect(kept.got.to).toEqual([box('Carol', 'carol@x.example.test')]);
        expect(kept.got.cc).toEqual([]);
        expect(kept.got.incomplete).toEqual(['to']);
        // The last label, then a blank line (Gmail): complete.
        const gmail = read([...FORWARD_ADDRESS, 'To: Carol <carol@x.example.test>, Dan <dan@example.test>', '', 'body'], 'Fwd: Contract');
        expect(gmail.got.incomplete).toEqual([]);
        // A trailing ";" before a blank line or the end of the text: may go on, flagged.
        expect(read([...FORWARD_ADDRESS, 'To: Carol <carol@x.example.test>;', '', 'body'], 'Fwd: Contract').got.incomplete).toEqual(['to']);
        // A wrapped list taken before the next label: read to its end, not flagged.
        const wrapped = read([...HEAD, 'To: Carol Test <carol@sample.invalid>;', 'Frank Mockup <frank@example.test>', 'Cc: Dan <dan@example.test>;', 'Eve Roe <eve@example.test>', 'Subject: P', '']);
        expect(wrapped.got.to).toEqual([box('Carol Test', 'carol@sample.invalid'), box('Frank Mockup', 'frank@example.test')]);
        expect(wrapped.got.cc).toEqual([box('Dan', 'dan@example.test'), box('Eve Roe', 'eve@example.test')]);
        expect(wrapped.got.subject).toBe('P');
        expect(wrapped.got.incomplete).toEqual([]);
    });

    it('reads Outlook plain-text addresses ("addr<mailto:addr>") in a block', () =>
    {
        const { got } = read([...HEAD.slice(0, 1), 'From: Bob Sample <bob@x.example.test<mailto:bob@x.example.test>>', 'Sent: Mon 3/3/2025 10:00', 'To: Carol <carol@sample.invalid<mailto:carol@sample.invalid>>', 'Subject: P', '', 'Body.']);
        expect(got.from).toEqual([box('Bob Sample', 'bob@x.example.test')]);
        expect(got.to).toEqual([box('Carol', 'carol@sample.invalid')]);
    });
});

describe('readQuotedHeader: a To / Cc value that yields no mailbox is flagged incomplete (rule 3)', () =>
{
    const HEAD = ['-----Original Message-----', 'From: Bob <bob@x.example.test>', 'Sent: Mon 3/3/2025 10:00'];
    const read = (lines: readonly string[]): QuotedHeaderFields => readOne(`${lines.join('\n')}\n\nOld text.\n`);

    it.each([
        ['To', 'Carol <carol@sample.invalid<mailto:mallory@sample.invalid>>'],
        ['To', 'Carol <carol@sample.invalid> (Legal)'],
        ['Cc', 'Carol <carol@sample.invalid> (Legal)'],
    ])('%s: %s', (label, value) =>
    {
        const got = read([...HEAD, `${label}: ${value}`, 'Subject: P']);
        expect(got.to).toEqual([]);
        expect(got.cc).toEqual([]);
        expect(got.incomplete).toEqual([label.toLowerCase()]);
    });

    it('does not flag an empty value, a value of separators only, or a readable one', () =>
    {
        expect(read([...HEAD, 'To:', 'Cc: ;', 'Subject: P']).incomplete).toEqual([]);
        const ok = read([...HEAD, 'To: Carol <carol@sample.invalid>', 'Cc: Dan Roe', 'Subject: P']);
        expect(ok.incomplete).toEqual([]);
        expect(ok.to).toEqual([box('Carol', 'carol@sample.invalid')]);
    });
});

describe('parseMailboxList', () =>
{
    it.each([
        ['Bob Sample <bob@x.example.test>; Carol Test <carol@sample.invalid>', [box('Bob Sample', 'bob@x.example.test'), box('Carol Test', 'carol@sample.invalid')]],
        ['Bob Sample <bob@x.example.test>, Carol Test <carol@sample.invalid>', [box('Bob Sample', 'bob@x.example.test'), box('Carol Test', 'carol@sample.invalid')]],
        ['Sample, Bob; Test, Carol', [box('Sample, Bob'), box('Test, Carol')]],
        ['Sample, Bob', [box('Sample, Bob')]],
        ['Sample, Bob <bob@x.example.test>, carol@sample.invalid', [box('Sample, Bob', 'bob@x.example.test'), box('', 'carol@sample.invalid')]],
        ['Bob Sample, carol@sample.invalid', [box('Bob Sample'), box('', 'carol@sample.invalid')]],
        ['"Test; Carol" <carol@sample.invalid>', [box('Test; Carol', 'carol@sample.invalid')]],
        ["'bob@x.example.test'", [box('', 'bob@x.example.test')]],
        ["'Bob Sample' <bob@x.example.test>", [box('Bob Sample', 'bob@x.example.test')]],
        ['=?UTF-8?Q?Carol_Test?= <carol@sample.invalid>', [box('', 'carol@sample.invalid')]],
        // A name holding "<", ">", "@" or "mailto:" is never shown (it could show an address that is not the mailbox's own).
        ['Bob <not an address>', []],
        ['Bob Sample <mailto:bob@x.example.test>', [box('Bob Sample', 'bob@x.example.test')]],
        ['<mailto:bob@x.example.test>', [box('', 'bob@x.example.test')]],
        // Outlook plain text: the address, then its link; both must agree.
        ['Bob Sample <bob@x.example.test<mailto:bob@x.example.test>>; Carol <carol@sample.invalid<mailto:CAROL@sample.invalid>>', [box('Bob Sample', 'bob@x.example.test'), box('Carol', 'carol@sample.invalid')]],
        ['Bob Sample <bob@x.example.test<mailto:eve@sample.invalid>>', []],
        ['bob@x.example.test <bob@x.example.test>', [box('', 'bob@x.example.test')]],
        // Another address before the address: whose mailbox it is, is not clear. The others are kept.
        ['"carol@sample.invalid" <bob@x.example.test>, Dan <dan@example.test>', [box('Dan', 'dan@example.test')]],
        ['Assistant <a@x.example.test> on behalf of Bob <bob@x.example.test>', []],
        // Rule 3: a comma after a name without an address does not split (documented limit).
        ['Carol Doe, Dan Roe <dan@example.test>', [box('Carol Doe, Dan Roe', 'dan@example.test')]],
        // Group syntax is not supported (documented): the group name and the first address are dropped.
        ['Team: carol@sample.invalid, dan@example.test;', [box('', 'dan@example.test')]],
        [' ; , ;', []],
        ['', []],
    ])('%s', (value, want) =>
    {
        expect(parseMailboxList(value)).toEqual(want);
    });

    it('gives [] for a list longer than MAX_MAILBOXES and never throws on odd input', () =>
    {
        expect(parseMailboxList(Array.from({ length: MAX_MAILBOXES + 1 }, (_, i) => `p${i}@x.example.test`).join(', '))).toEqual([]);
        expect(parseMailboxList(undefined as unknown as string)).toEqual([]);
        // One mailbox (the quote is never closed) whose name would hold "<" and "@": dropped.
        expect(parseMailboxList('"unclosed <a@b.test>, x')).toEqual([]);
    });
});

describe('readQuotedHeader: odd input', () =>
{
    it('never throws and keeps the given header end', () =>
    {
        expect(readQuotedHeader(undefined as unknown as string, { start: 0, headEnd: 5 }).headerEnd).toBe(5);
        expect(readQuotedHeader('abc', { start: 2, headEnd: 1 })).toEqual({ from: [], to: [], cc: [], subject: null, dateText: null, headerEnd: 1, incomplete: [] });
        // A header end past the text is clamped to it.
        expect(readQuotedHeader('abc', { start: 0, headEnd: 99 })).toEqual({ from: [], to: [], cc: [], subject: null, dateText: null, headerEnd: 3, incomplete: [] });
        expect(readQuotedHeader('abc', null as unknown as { start: number; headEnd: number }).headerEnd).toBe(0);
        expect(readQuotedHeader('abc', { start: Number.NaN, headEnd: 2 }).headerEnd).toBe(2);
    });

    it('survives random bodies built from header pieces (no throw, headerEnd >= headEnd)', () =>
    {
        const pieces = ['From: ', 'Sent: ', 'To: ', 'Cc: ', 'Bcc: ', 'Subject: ', 'De : ', '\u00c0 : ', 'Van: ', 'On ', 'Le ', 'Op ', ' wrote:', ' a \u00e9crit :', ' schreef ', '<', '>', '[mailto:', ']', '"', "'", ',', ';', '@', 'x', ' ', '\n', '\r\n', '> ', '>>', '2:02 PM', '2025', '_'.repeat(12), '-----Original Message-----', '=?UTF-8?Q?a?='];
        let seed = 7;
        const rand = (limit: number): number =>
        {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return seed % limit;
        };
        for (let round = 0; round < 400; round++)
        {
            let body = '';
            const length = 5 + rand(80);
            for (let k = 0; k < length; k++)
            {
                body += pieces[rand(pieces.length)] ?? '';
            }
            for (const header of findReplyHeaders(body, rand(2) === 0 ? 'Fwd: x' : 'Re: x'))
            {
                const got = readQuotedHeader(body, header);
                expect(got.headerEnd).toBeGreaterThanOrEqual(header.headEnd);
                expect(got.headerEnd).toBeLessThanOrEqual(body.length);
            }
        }
    });

    it('stays fast on long values and long lines (bounded, linear)', () =>
    {
        const many = Array.from({ length: 400 }, (_, i) => `Person ${i}`).join(', ');
        const body = `${'_'.repeat(32)}\nFrom: Bob <bob@x.example.test>\nSent: Monday, March 3, 2025 9:15 AM\nTo: ${many}\n${'y'.repeat(500_000)}\nSubject: x\n`;
        const started = Date.now();
        const got = readOne(body);
        expect(Date.now() - started).toBeLessThan(2000);
        // Commas without addresses make one name; that name is too long to keep: left empty, nothing invented.
        expect(got.to).toEqual([]);
        expect(got.subject).toBeNull(); // the over-long line stops the block
    });
});

describe('headerLabelCounts (task 8.10)', () =>
{
    it('counts the label lines of each role in the header lines, Bcc and repeats included, at any depth', () =>
    {
        const body = 'Hi.\n\n> From: Bob Example <bob@example.test>\n> Sent: Monday, March 3, 2025 9:15 AM\n> To: Carol <carol@example.test>\n> Bcc: Dan <dan@example.test>\n> To: Erin <erin@example.test>\n> Subject: Plan\n>\n> Text.\n';
        const start = body.indexOf('> From');
        const end = body.indexOf('>\n> Text');
        const counts = headerLabelCounts(body, start, end);
        expect(Object.fromEntries(counts)).toEqual({ from: 1, sent: 1, to: 2, bcc: 1, subject: 1 });
        // CRLF line breaks read the same.
        const crlf = body.replace(/\n/gu, '\r\n');
        expect(Object.fromEntries(headerLabelCounts(crlf, crlf.indexOf('> From'), crlf.indexOf('>\r\n> Text')))).toEqual({ from: 1, sent: 1, to: 2, bcc: 1, subject: 1 });
    });

    it('an attribution or text lines: no label line', () =>
    {
        const body = 'On Mon, 3 Mar 2025 at 09:15, Bob <bob@example.test> wrote:\n> Text.\n';
        expect(headerLabelCounts(body, 0, body.indexOf('>')).size).toBe(0);
    });

    it('odd input gives an empty map, never throws', () =>
    {
        expect(headerLabelCounts('From: Bob\n', 0, 99).size).toBe(0);
        expect(headerLabelCounts('From: Bob\n', -1, 4).size).toBe(0);
        expect(headerLabelCounts('From: Bob\n', 4, 4).size).toBe(0);
        expect(headerLabelCounts(null as unknown as string, 0, 4).size).toBe(0);
    });
});
