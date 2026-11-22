// Cases where a rebuilt message must NOT be linked to a real file, nor
// merged with another copy (task 7.5, review round 2). A wrong link would
// later remove a quoted message from the timeline and the PDF by declaring
// it identical to a different message; a visible repeat is acceptable
// (link-rebuilt-messages.ts, file comment). Each case runs the whole thread analysis on
// hand-written synthetic emails, so the splitter, the header reader and the
// date reader take part, and first checks that the quoted message IS
// rebuilt (the case is not empty). Synthetic data only (README.md, rule R7).

import { describe, expect, it } from 'vitest';
import { buildThread, instantOf, type ThreadMessage } from '../../Helper/Test/test-support/thread-builder';
import { chain } from '../../Helper/Test/test-support/thread-cases';
import { analyzeThread } from './analyze-thread';
import { comparableText } from './link-rebuilt-messages';
import type { EmailAddress, NormalizedMessage, ParseResult } from '../../Header/parsed-email';
import type { AnalyzedRebuiltMessage } from '../../Header/rebuilt-emails';
import type { ThreadAnalysisResult } from '../../Header/thread-analysis-result';

const ALICE: EmailAddress = { name: 'Alice Example', address: 'alice@example.test' };
const BOB: EmailAddress = { name: 'Bob Sample', address: 'bob@example.test' };
const CAROL: EmailAddress = { name: 'Carol Test', address: 'carol@sample.invalid' };

let counter = 0;
/** A dropped email sent at `iso` (UTC) from a zone `offsetMinutes` east of UTC (null: zone unknown). */
function email(from: EmailAddress, iso: string, body: string, offsetMinutes: number | null = 0, subject = 'Re: Delivery'): NormalizedMessage
{
    counter++;
    return {
        messageId: `adversarial-${counter}@example.test`,
        inReplyTo: null,
        references: [],
        date: { utcMs: Date.parse(iso), original: '', offsetMinutes, zoneKnown: offsetMinutes !== null },
        from: [from],
        to: [from === BOB ? ALICE : BOB],
        cc: [],
        bcc: [],
        subject,
        bodyText: body,
        attachments: [],
        source: { fileName: `adversarial-${counter}.eml`, sha256: counter.toString(16).padStart(64, '0'), kind: 'eml' },
        warnings: [],
    };
}

const run = (...messages: NormalizedMessage[]): ThreadAnalysisResult =>
    analyzeThread(messages.map((message): ParseResult => ({ ok: true, message })));

/** Gmail-style reply: own text, then "On <date>, <who> wrote:" and the quoted lines. */
const gmailReply = (own: string, date: string, who: string, quoted: string): string =>
    `${own}\n\nOn ${date}, ${who} wrote:\n${quoted
        .split('\n')
        .map((l) => (l === '' ? '>' : `> ${l}`))
        .join('\n')}\n`;

/** Outlook-style reply: own text, then a separator and a header block. `separator` is put between the header and the body. */
const outlookReply = (own: string, header: readonly string[], quoted: string, separator = '\n'): string =>
    `${own}\n\n________________________________\n${header.join('\n')}\n${separator}${quoted}`;

const WHO = 'Alice Example <alice@example.test>';

/** The rebuilt messages sent by Alice; there must be at least `min` (the case is not empty). */
function aliceRebuilt(out: ThreadAnalysisResult, min = 1): AnalyzedRebuiltMessage[]
{
    const list = out.reconstructed.filter((r) => r.rebuilt.from.length === 1 && (r.rebuilt.from[0]?.name === ALICE.name || r.rebuilt.from[0]?.address === ALICE.address));
    expect(list.length, 'rebuilt messages from Alice').toBeGreaterThanOrEqual(min);
    return list;
}

/** No rebuilt message is linked to a real file or merged with another copy. */
function expectNoLink(out: ThreadAnalysisResult): void
{
    expect(out.reconstructed.map((r) => `${r.id}:${r.link}`)).toEqual(out.reconstructed.map((r) => `${r.id}:entry`));
    // Every real message and every rebuilt message is in the timeline.
    expect(out.timeline.filter((e) => e.kind === 'rebuilt')).toHaveLength(out.reconstructed.length);
    expect(out.timeline.filter((e) => e.kind === 'message')).toHaveLength(out.messages.length);
}

// A ~60-word invoice template; only the figures change.
const invoice = (invoiceNumber: string, amount: string): string =>
    `Hello Bob,\n\nPlease find attached invoice ${invoiceNumber} for the delivery of the office desks and chairs last week. ` +
    `The total amount of ${amount} euro is due within thirty days of the invoice date. Payment can be made by bank ` +
    `transfer to the account mentioned on the invoice. Let me know if anything is unclear.\n\nBest regards,\nAlice Example\nAccounts\n`;

const SIGNATURE = 'Alice Example\nSales Manager\nExample Furniture Ltd.\nRue de l\u2019Exemple 12, 1000 Brussels\nPhone +32 2 555 01 23\n';

describe('rebuilt messages that must not be linked to a real file', () =>
{
    it('B1: a template with other figures, 5.5 h from the real one (off the zone grid)', () =>
    {
        const real = email(ALICE, '2025-03-03T15:12:31Z', invoice('2025-031', '1200'));
        const reply = email(BOB, '2025-03-03T16:00:00Z', gmailReply('Thanks, we will check it.', 'Mon, 3 Mar 2025 at 09:40', WHO, invoice('2025-030', '950')));
        const out = run(real, reply);
        aliceRebuilt(out);
        expectNoLink(out);
    });

    it('B1 variant: the same template with one changed number, on the zone grid the same day', () =>
    {
        const real = email(ALICE, '2025-03-03T15:12:31Z', invoice('2025-031', '1200'));
        // 10:12 read in the source zone (UTC) is 5 h before the real message: on the grid.
        const reply = email(BOB, '2025-03-03T16:00:00Z', gmailReply('Thanks, we will check it.', 'Mon, 3 Mar 2025 at 10:12', WHO, invoice('2025-031', '1250')));
        const out = run(real, reply);
        aliceRebuilt(out);
        expectNoLink(out);
    });

    it('B2: "OK" five hours from a real "OK" (on the grid, but a short text)', () =>
    {
        const real = email(ALICE, '2025-03-03T15:00:00Z', 'OK\n');
        const reply = email(BOB, '2025-03-03T16:00:00Z', gmailReply('Good, then we go ahead.', 'Mon, 3 Mar 2025 at 10:00', WHO, 'OK'));
        const out = run(real, reply);
        aliceRebuilt(out);
        expectNoLink(out);
    });

    it('B2: an EXACT quoted date five hours from a real "Thanks!" (a forward)', () =>
    {
        const real = email(ALICE, '2025-03-03T15:00:00Z', 'Thanks!\n\nAlice\n');
        const body =
            'See below.\n\n---------- Forwarded message ---------\nFrom: Alice Example <alice@example.test>\n' +
            'Date: Mon, 3 Mar 2025 10:00:00 +0000\nSubject: Delivery\nTo: Bob Sample <bob@example.test>\n\nThanks!\n\nAlice\n';
        const out = run(real, email(BOB, '2025-03-03T16:00:00Z', body, 0, 'Fwd: Delivery'));
        const [rebuilt] = aliceRebuilt(out);
        expect(rebuilt?.rebuilt.dateApproximate).toBe(false);
        expectNoLink(out);
    });

    it('B4: a header read short by "yields no mailbox" (no leftover lines): the different first paragraph still counts', () =>
    {
        const header = ['From: Alice Example <alice@example.test>', 'Sent: Monday, March 3, 2025 10:00 AM', 'To: Bob Sample <bob@example.test> (Legal)', 'Subject: Delivery'];
        const quoted = `No, the delivery on Friday does not work for us at all.\n\n${SIGNATURE}`;
        const reply = email(BOB, '2025-03-03T15:00:00Z', outlookReply('Understood, I will call the driver.\n\nBob', header, quoted, ''));
        const real = email(ALICE, '2025-03-03T14:00:00Z', `Yes, fine.\n\n${SIGNATURE}`);
        const out = run(real, reply);
        const [rebuilt] = aliceRebuilt(out);
        expect(rebuilt?.rebuilt.incomplete).toEqual(['to']);
        expect(rebuilt?.rebuilt.to).toEqual([]);
        expect(rebuilt?.rebuilt.reconstructedText.startsWith('No, the delivery')).toBe(true);
        expectNoLink(out);
    });

    it('two different messages of one sender the same day: "Thanks!", "Received, thanks", "OK, thanks."', () =>
    {
        for (const text of ['Thanks!', 'Received, thanks', 'OK, thanks.'])
        {
            const real = email(ALICE, '2025-03-03T09:00:00Z', `${text}\n`);
            const reply = email(BOB, '2025-03-03T15:00:00Z', gmailReply('Noted.', 'Mon, 3 Mar 2025 at 14:00', WHO, text));
            const out = run(real, reply);
            aliceRebuilt(out);
            expectNoLink(out);
        }
    });

    it('a name-only sender: a short text, even at the very same minute', () =>
    {
        const real = email(ALICE, '2025-03-03T10:00:00Z', 'Thanks, see you tomorrow.\n');
        const reply = email(BOB, '2025-03-03T11:00:00Z', gmailReply('Fine.', 'Mon, 3 Mar 2025 at 10:00', 'Alice Example', 'Thanks, see you tomorrow.'));
        const out = run(real, reply);
        const [rebuilt] = aliceRebuilt(out);
        expect(rebuilt?.rebuilt.from).toEqual([{ name: 'Alice Example', address: '' }]);
        expectNoLink(out);
    });

    it('a forward with an approximate date: another short text the same day', () =>
    {
        const real = email(ALICE, '2025-03-03T09:00:00Z', 'Received, thanks.\n');
        const header = ['From: Alice Example <alice@example.test>', 'Sent: Monday, March 3, 2025 2:00 PM', 'To: Bob Sample <bob@example.test>', 'Subject: Delivery'];
        const out = run(real, email(BOB, '2025-03-03T15:00:00Z', outlookReply('FYI.', header, 'Received, thanks.\n'), 0, 'FW: Delivery'));
        aliceRebuilt(out);
        expectNoLink(out);
    });

    it('an ambiguous numeric date ("04/03/2025 10:00") and "OK, thanks." against a real 3 April "OK, thanks."', () =>
    {
        const real = email(ALICE, '2025-04-03T10:00:00Z', 'OK, thanks.\n');
        const reply = email(BOB, '2025-04-03T12:00:00Z', gmailReply('Then it is settled.', '04/03/2025 10:00', WHO, 'OK, thanks.'));
        const out = run(real, reply);
        const [rebuilt] = aliceRebuilt(out);
        expect(rebuilt?.rebuilt.date?.wallMs ?? null).toBeNull(); // unreadable: ambiguous
        expectNoLink(out);
    });

    it('an empty quoted body against an empty real body at the same minute', () =>
    {
        const real = email(ALICE, '2025-03-03T10:00:00Z', '\n');
        const header = ['From: Alice Example <alice@example.test>', 'Sent: Monday, March 3, 2025 10:00 AM', 'To: Bob Sample <bob@example.test>', 'Subject: Delivery'];
        const out = run(real, email(BOB, '2025-03-03T11:00:00Z', outlookReply('See the empty email below.', header, '\n')));
        aliceRebuilt(out);
        expectNoLink(out);
    });
});

describe('copies of quoted messages that must not be merged', () =>
{
    it('B3: "OK, thanks." quoted at 10:00 and at 18:00 by two emails from one zone', () =>
    {
        const one = email(BOB, '2025-03-03T11:00:00Z', gmailReply('Good.', 'Mon, 3 Mar 2025 at 10:00', WHO, 'OK, thanks.'));
        const two = email(BOB, '2025-03-03T19:00:00Z', gmailReply('Good again.', 'Mon, 3 Mar 2025 at 18:00', WHO, 'OK, thanks.'));
        const out = run(one, two);
        aliceRebuilt(out, 2);
        expectNoLink(out);
    });

    it('the same short text at the same wall time quoted from two zones (two different moments)', () =>
    {
        const one = email(BOB, '2025-03-03T11:00:00Z', gmailReply('Good.', 'Mon, 3 Mar 2025 at 10:00', WHO, 'Thanks!'), 60);
        const two = email(CAROL, '2025-03-03T17:00:00Z', gmailReply('Good again.', 'Mon, 3 Mar 2025 at 10:00', WHO, 'Thanks!'), -300);
        const out = run(one, two);
        aliceRebuilt(out, 2);
        expectNoLink(out);
    });

    it('B5: "Sent: yesterday" and "OK, thanks." in two emails six days apart', () =>
    {
        const header = ['From: Alice Example <alice@example.test>', 'Sent: yesterday', 'To: Bob Sample <bob@example.test>', 'Subject: Delivery'];
        const one = email(BOB, '2025-03-03T11:00:00Z', outlookReply('Good.', header, 'OK, thanks.\n'));
        const two = email(BOB, '2025-03-09T11:00:00Z', outlookReply('Good again.', header, 'OK, thanks.\n'));
        const out = run(one, two);
        aliceRebuilt(out, 2);
        expectNoLink(out);
    });

    it('the same undated header text with a year and a day, but sources six days apart', () =>
    {
        const quoted = invoice('2025-031', '1200');
        const one = email(BOB, '2025-03-03T11:00:00Z', gmailReply('Good.', '04/03/2025 10:00', WHO, quoted));
        const two = email(BOB, '2025-03-09T11:00:00Z', gmailReply('Good again.', '04/03/2025 10:00', WHO, quoted));
        const out = run(one, two);
        aliceRebuilt(out, 2);
        expectNoLink(out);
    });

    it('a template with one changed number, quoted at the same minute by two emails', () =>
    {
        const one = email(BOB, '2025-03-03T11:00:00Z', gmailReply('Good.', 'Mon, 3 Mar 2025 at 10:00', WHO, invoice('2025-031', '1200')));
        const two = email(BOB, '2025-03-03T12:00:00Z', gmailReply('Good again.', 'Mon, 3 Mar 2025 at 10:00', WHO, invoice('2025-032', '1200')));
        const out = run(one, two);
        aliceRebuilt(out, 2);
        expectNoLink(out);
    });

    // Task 9.9b-4: two EMPTY quoted bodies under the very same header (sender address, date and time, subject, To, Cc)
    // are now linked by that header (link-rebuilt-messages.ts, file comment, 2, EMPTY COPIES): there is no text to lose.
    // Any header fact that differs still means no link.
    it('empty quoted bodies at the same minute: linked only when every header fact is the same', () =>
    {
        const header = ['From: Alice Example <alice@example.test>', 'Sent: Monday, March 3, 2025 10:00 AM', 'To: Bob Sample <bob@example.test>', 'Subject: Delivery'];
        const pair = (other: readonly string[]): ThreadAnalysisResult =>
            run(email(BOB, '2025-03-03T11:00:00Z', outlookReply('Empty one.', header, '\n')), email(BOB, '2025-03-03T12:00:00Z', outlookReply('Empty two.', other, '\n')));
        const same = pair(header);
        expect(aliceRebuilt(same, 2).map((r) => r.link)).toEqual(['entry', 'same-as']);
        for (const [k, line] of [
            [1, 'Sent: Monday, March 3, 2025 10:01 AM'],
            [0, 'From: Alice Example <alice@sample.invalid>'],
            [2, 'To: Carol Test <carol@sample.invalid>'],
            [3, 'Subject: Re: Delivery'],
        ] as const)
        {
            const other = header.map((l, i) => (i === k ? line : l));
            const out = pair(other);
            expect(out.reconstructed.length, line).toBeGreaterThanOrEqual(2);
            expectNoLink(out);
        }
        expectNoLink(pair([...header.slice(0, 3), 'Cc: Carol Test <carol@sample.invalid>', header[3] as string]));
    });
});

// Review round 3: one word changed inside an otherwise identical text, and
// identical recurring messages a day apart.

/** A ~45-word decision; only `w` changes. No figures. */
const decision = (word: string): string =>
    `Hello Bob,\n\nAfter reviewing the proposal with the board this afternoon, we have decided to ${word} the offer for the renovation of the warehouse. ` +
    `Our lawyer will send you the formal letter by the end of the week, together with the signed documents.\n\nBest regards,\nAlice\n`;

/** The same text sent to several people; only the greeting changes. */
const merged = (name: string): string =>
    `Hello ${name},\n\nWe are pleased to invite you to the opening of our new showroom. There will be a short tour of the new collection, ` +
    `followed by drinks and a small buffet in the garden. Please let us know whether you can come before the end of next week.\n\nBest regards,\nAlice\n`;

/** An invitation; only the list of invitees changes. */
const invitation = (invitees: string): string =>
    `Hello Bob,\n\nThe kick-off meeting for the warehouse renovation will take place next Monday in the large meeting room. ` +
    `The invited people are ${invitees} and they should bring the floor plans and the budget overview. Please confirm your presence by Friday.\n\nBest regards,\nAlice\n`;

/** The same reminder every morning. */
const REMINDER =
    'Good morning team,\n\nThis is the daily reminder to update the shared project board before the stand-up meeting. ' +
    'Please add your progress, your plans for today and anything that blocks you, so that we can keep the meeting short.\n\nThank you,\nAlice\n';

/** Two figures that trade places. */
const moved = (from: string, to: string): string =>
    `Hello Bob,\n\nThe delivery of the office desks was moved from ${from} to ${to} on Thursday, because the driver has another appointment in the morning. ` +
    `Please make sure that someone can open the side door of the building and that the lift is free.\n\nBest regards,\nAlice\n`;

describe('one word changed inside the text: never the same message (review round 3)', () =>
{
    it('accept vs reject, a zone offset apart (5 h on the grid)', () =>
    {
        const real = email(ALICE, '2025-03-03T15:00:20Z', decision('accept'));
        const reply = email(BOB, '2025-03-03T16:00:00Z', gmailReply('Noted, thanks.', 'Mon, 3 Mar 2025 at 10:00', WHO, decision('reject')));
        const out = run(real, reply);
        aliceRebuilt(out);
        expectNoLink(out);
    });

    it('accept vs "not accept", a zone offset apart', () =>
    {
        const real = email(ALICE, '2025-03-03T15:00:20Z', decision('accept'));
        const reply = email(BOB, '2025-03-03T16:00:00Z', gmailReply('Noted, thanks.', 'Mon, 3 Mar 2025 at 10:00', WHO, decision('not accept')));
        const out = run(real, reply);
        aliceRebuilt(out);
        expectNoLink(out);
    });

    it('accept vs reject at the very same minute (exact)', () =>
    {
        const real = email(ALICE, '2025-03-03T15:00:20Z', decision('accept'));
        const reply = email(BOB, '2025-03-03T16:00:00Z', gmailReply('Noted, thanks.', 'Mon, 3 Mar 2025 at 15:00', WHO, decision('reject')));
        const out = run(real, reply);
        aliceRebuilt(out);
        expectNoLink(out);
    });

    it('accept vs reject in the real sender zone (strong): Alice in UTC-5, Bob in UTC', () =>
    {
        const real = email(ALICE, '2025-03-03T15:00:20Z', decision('accept'), -300);
        const reply = email(BOB, '2025-03-03T16:00:00Z', gmailReply('Noted, thanks.', 'Mon, 3 Mar 2025 at 10:00', WHO, decision('reject')));
        const out = run(real, reply);
        aliceRebuilt(out);
        expectNoLink(out);
    });

    it('accept vs reject in a forward with an exact date ("Date: ... 10:00:00 -0500")', () =>
    {
        const real = email(ALICE, '2025-03-03T15:00:20Z', decision('accept'), -300);
        const body =
            'See below.\n\n---------- Forwarded message ---------\nFrom: Alice Example <alice@example.test>\n' +
            `Date: Mon, 3 Mar 2025 10:00:00 -0500\nSubject: Offer\nTo: Bob Sample <bob@example.test>\n\n${decision('reject')}`;
        const out = run(real, email(BOB, '2025-03-03T16:00:00Z', body, 0, 'Fwd: Offer'));
        const [rebuilt] = aliceRebuilt(out);
        expect(rebuilt?.rebuilt.dateApproximate).toBe(false);
        expectNoLink(out);
    });

    it('accept vs reject with a name-only sender at the same minute', () =>
    {
        const real = email(ALICE, '2025-03-03T15:00:20Z', decision('accept'));
        const reply = email(BOB, '2025-03-03T16:00:00Z', gmailReply('Noted, thanks.', 'Mon, 3 Mar 2025 at 15:00', 'Alice Example', decision('reject')));
        const out = run(real, reply);
        const [rebuilt] = aliceRebuilt(out);
        expect(rebuilt?.rebuilt.from).toEqual([{ name: 'Alice Example', address: '' }]);
        expectNoLink(out);
    });

    it('a mail merge: "Hello Bob," vs "Hello Carol," at the same minute', () =>
    {
        const real = email(ALICE, '2025-03-03T15:00:20Z', merged('Bob'));
        const reply = email(CAROL, '2025-03-03T16:00:00Z', gmailReply('I will be there.', 'Mon, 3 Mar 2025 at 15:00', WHO, merged('Carol')));
        const out = run(real, reply);
        aliceRebuilt(out);
        expectNoLink(out);
    });

    it('two different invitee lists at the same minute', () =>
    {
        const real = email(ALICE, '2025-03-03T15:00:20Z', invitation('Ann Smith; Dan Brown'));
        const reply = email(BOB, '2025-03-03T16:00:00Z', gmailReply('Noted.', 'Mon, 3 Mar 2025 at 15:00', WHO, invitation('Eve Stone; Fay Lane')));
        const out = run(real, reply);
        aliceRebuilt(out);
        expectNoLink(out);
    });

    it('two figures that trade places ("from 10:00 to 14:00" vs "from 14:00 to 10:00")', () =>
    {
        const real = email(ALICE, '2025-03-03T15:00:20Z', moved('10:00', '14:00'));
        const reply = email(BOB, '2025-03-03T16:00:00Z', gmailReply('Noted.', 'Mon, 3 Mar 2025 at 15:00', WHO, moved('14:00', '10:00')));
        const out = run(real, reply);
        aliceRebuilt(out);
        expectNoLink(out);
    });

    it('copies: accept vs reject quoted at the same minute by two emails from one zone', () =>
    {
        const one = email(BOB, '2025-03-03T11:00:00Z', gmailReply('Good.', 'Mon, 3 Mar 2025 at 10:00', WHO, decision('accept')));
        const two = email(BOB, '2025-03-03T12:00:00Z', gmailReply('Good again.', 'Mon, 3 Mar 2025 at 10:00', WHO, decision('reject')));
        const out = run(one, two);
        aliceRebuilt(out, 2);
        expectNoLink(out);
    });

    it('copies: accept vs reject, the same wall time quoted from two zones', () =>
    {
        const one = email(BOB, '2025-03-03T11:00:00Z', gmailReply('Good.', 'Mon, 3 Mar 2025 at 10:00', WHO, decision('accept')), 60);
        const two = email(CAROL, '2025-03-03T17:00:00Z', gmailReply('Good again.', 'Mon, 3 Mar 2025 at 10:00', WHO, decision('reject')), -300);
        const out = run(one, two);
        aliceRebuilt(out, 2);
        expectNoLink(out);
    });

    it('copies: a mail merge quoted at the same minute', () =>
    {
        const one = email(BOB, '2025-03-03T11:00:00Z', gmailReply('I will be there.', 'Mon, 3 Mar 2025 at 10:00', WHO, merged('Bob')));
        const two = email(CAROL, '2025-03-03T12:00:00Z', gmailReply('Me too.', 'Mon, 3 Mar 2025 at 10:00', WHO, merged('Carol')));
        const out = run(one, two);
        aliceRebuilt(out, 2);
        expectNoLink(out);
    });
});

describe('the same text a day apart: a recurring message, not the same one (review round 3)', () =>
{
    it('a daily reminder: the real one on Monday 09:00, the quoted one on Tuesday 09:00 (minutes)', () =>
    {
        const real = email(ALICE, '2025-03-03T09:00:12Z', REMINDER);
        const reply = email(BOB, '2025-03-04T10:00:00Z', gmailReply('Done.', 'Tue, 4 Mar 2025 at 09:00', WHO, REMINDER));
        const out = run(real, reply);
        const [rebuilt] = aliceRebuilt(out);
        expect(rebuilt?.rebuilt.date?.precision).toBe('minute');
        expectNoLink(out);
    });

    it('a daily reminder: the quoted one dated the next day only ("On 4 March 2025")', () =>
    {
        const real = email(ALICE, '2025-03-03T09:00:12Z', REMINDER);
        const reply = email(BOB, '2025-03-04T10:00:00Z', gmailReply('Done.', '4 March 2025', WHO, REMINDER));
        const out = run(real, reply);
        const [rebuilt] = aliceRebuilt(out);
        expect(rebuilt?.rebuilt.date?.precision).toBe('day');
        expectNoLink(out);
    });

    it('copies: Monday 09:00 quoted from UTC, Tuesday 10:00 quoted from UTC+1', () =>
    {
        const one = email(BOB, '2025-03-03T11:00:00Z', gmailReply('Done.', 'Mon, 3 Mar 2025 at 09:00', WHO, REMINDER), 0);
        const two = email(CAROL, '2025-03-04T11:00:00Z', gmailReply('Done too.', 'Tue, 4 Mar 2025 at 10:00', WHO, REMINDER), 60);
        const out = run(one, two);
        aliceRebuilt(out, 2);
        expectNoLink(out);
    });
});

describe('the same messages DO link when the evidence is there (controls)', () =>
{
    it('the decision quoted unchanged, a zone offset apart; and the reminder quoted the same day', () =>
    {
        const real = email(ALICE, '2025-03-03T15:00:20Z', decision('accept'));
        const reply = email(BOB, '2025-03-03T16:00:00Z', gmailReply('Noted, thanks.', 'Mon, 3 Mar 2025 at 10:00', WHO, decision('accept')));
        expect(aliceRebuilt(run(real, reply)).map((r) => r.link)).toEqual(['real']);
        const daily = email(ALICE, '2025-03-03T09:00:12Z', REMINDER);
        const same = email(BOB, '2025-03-03T10:00:00Z', gmailReply('Done.', 'Mon, 3 Mar 2025 at 09:00', WHO, REMINDER));
        expect(aliceRebuilt(run(daily, same)).map((r) => r.link)).toEqual(['real']);
    });

    it('copies of the reminder: the same wall time quoted from UTC and UTC+1', () =>
    {
        const one = email(BOB, '2025-03-03T11:00:00Z', gmailReply('Done.', 'Mon, 3 Mar 2025 at 09:00', WHO, REMINDER), 0);
        const two = email(CAROL, '2025-03-03T11:30:00Z', gmailReply('Done too.', 'Mon, 3 Mar 2025 at 09:00', WHO, REMINDER), 60);
        expect(aliceRebuilt(run(one, two), 2).map((r) => r.link)).toEqual(['entry', 'same-as']);
    });

    it('a real file and its quoted copy at the same minute, even when short', () =>
    {
        const real = email(ALICE, '2025-03-03T10:00:31Z', 'OK, thanks.\n');
        const reply = email(BOB, '2025-03-03T11:00:00Z', gmailReply('Good.', 'Mon, 3 Mar 2025 at 10:00', WHO, 'OK, thanks.'));
        const out = run(real, reply);
        expect(aliceRebuilt(out).map((r) => r.link)).toEqual(['real']);
    });

    it('the invoice quoted with the same figures, read in another zone (on the grid)', () =>
    {
        const real = email(ALICE, '2025-03-03T15:12:31Z', invoice('2025-031', '1200'));
        const reply = email(BOB, '2025-03-03T16:00:00Z', gmailReply('Thanks, we will check it.', 'Mon, 3 Mar 2025 at 10:12', WHO, invoice('2025-031', '1200')));
        const out = run(real, reply);
        expect(aliceRebuilt(out).map((r) => [r.link, r.match?.strong])).toEqual([['real', false]]);
    });

    it('one short message quoted by two emails at the same minute', () =>
    {
        const one = email(BOB, '2025-03-03T11:00:00Z', gmailReply('Good.', 'Mon, 3 Mar 2025 at 10:00', WHO, 'OK, thanks.'));
        const two = email(BOB, '2025-03-03T12:00:00Z', gmailReply('Good again.', 'Mon, 3 Mar 2025 at 10:00', WHO, 'OK, thanks.'));
        const out = run(one, two);
        expect(aliceRebuilt(out, 2).map((r) => r.link)).toEqual(['entry', 'same-as']);
    });
});

// Review round 4, policy (b): the compared texts must hold the very same
// words; one side may only also END with a signature block (and a rebuilt
// text only START with header leftovers). Any other extra word at the start
// or the end, at any date level, means no link and no merge.

/** An Outlook header for Alice sent at `sent` ("Monday, March 3, 2025 10:00 AM"). */
const outlookHeader = (sent: string): string[] => ['From: Alice Example <alice@example.test>', `Sent: ${sent}`, 'To: Bob Sample <bob@example.test>', 'Subject: Delivery'];

/** A ~50-word message with no figures and no closing. */
const LONG =
    'Hello Bob,\n\nAfter reviewing the proposal with the board this afternoon, we have decided to accept the offer for the renovation of the warehouse. ' +
    'Our lawyer will send you the formal letter by the end of the week, together with the signed documents and the planning overview.\n';

describe('policy (b): short texts with one more word, same sender, same minute (round 4, blocker)', () =>
{
    const PAIRS: readonly (readonly [string, string])[] = [
        ['Approved.', 'Not approved.'],
        ['OK', 'Not OK'],
        ['Yes', 'Yes, cancelled'],
        ['Approved.\n\nAlice', 'Not approved.\n\nAlice'],
    ];
    for (const [a, b] of PAIRS)
    {
        for (const [quoted, real] of [
            [a, b],
            [b, a],
        ] as const)
        {
            it(`quoted ${JSON.stringify(quoted)} vs real ${JSON.stringify(real)} (Gmail, the same minute)`, () =>
            {
                const out = run(
                    email(ALICE, '2025-03-03T10:00:31Z', `${real}\n`),
                    email(BOB, '2025-03-03T11:00:00Z', gmailReply('Noted.', 'Mon, 3 Mar 2025 at 10:00', WHO, quoted)),
                );
                aliceRebuilt(out);
                expectNoLink(out);
            });
        }
    }

    it('"Agreed" vs "Not agreed" under an Outlook header, the same minute, both ways', () =>
    {
        for (const [quoted, real] of [
            ['Agreed\n', 'Not agreed\n'],
            ['Not agreed\n', 'Agreed\n'],
        ] as const)
        {
            const out = run(email(ALICE, '2025-03-03T10:00:31Z', real), email(BOB, '2025-03-03T11:00:00Z', outlookReply('Noted.', outlookHeader('Monday, March 3, 2025 10:00 AM'), quoted)));
            aliceRebuilt(out);
            expectNoLink(out);
        }
    });

    it('an exact quoted date (a forward): "Approved." vs a real "Not approved."', () =>
    {
        const body =
            'See below.\n\n---------- Forwarded message ---------\nFrom: Alice Example <alice@example.test>\n' +
            'Date: Mon, 3 Mar 2025 10:00:00 +0000\nSubject: Delivery\nTo: Bob Sample <bob@example.test>\n\nApproved.\n';
        const out = run(email(ALICE, '2025-03-03T10:00:31Z', 'Not approved.\n'), email(BOB, '2025-03-03T11:00:00Z', body, 0, 'Fwd: Delivery'));
        const [rebuilt] = aliceRebuilt(out);
        expect(rebuilt?.rebuilt.dateApproximate).toBe(false);
        expectNoLink(out);
    });

    it('copies: "Approved." and "Not approved." quoted at the same minute are never merged', () =>
    {
        const one = email(BOB, '2025-03-03T11:00:00Z', gmailReply('Good.', 'Mon, 3 Mar 2025 at 10:00', WHO, 'Approved.'));
        const two = email(BOB, '2025-03-03T12:00:00Z', gmailReply('Good again.', 'Mon, 3 Mar 2025 at 10:00', WHO, 'Not approved.'));
        const out = run(one, two);
        aliceRebuilt(out, 2);
        expectNoLink(out);
    });
});

describe('policy (b): extra words at the start or the end of a long text, at every date level (round 4)', () =>
{
    // The first 60% of the words of LONG.
    const words = LONG.split(' ');
    const prefix60 = `${words.slice(0, Math.ceil(words.length * 0.6)).join(' ')}\n`;
    const VARIANTS: readonly (readonly [string, string])[] = [
        ['an update line at the end', `${LONG}\nUpdate: legal did not approve, so this is cancelled.\n`],
        ['an update line at the start', `Update: legal did not approve, so this is cancelled.\n\n${LONG}`],
        ['"No." before the body', `No.\n\n${LONG}`],
        ['a PS at the end', `${LONG}\nPS: on second thought, we decline.\n`],
        ['a name-like line after a blank line that is not the sender', `${LONG}\nCancelled\n`],
        ['the sender name, then a veto line', `${LONG}\nAlice\nNot Approved\n`],
        // The sender name, then a title-case line that is no contact marker
        // (follow-up to round 4): never a signature block, whatever the word.
        ['the sender name, then "Afgelast"', `${LONG}\nAlice\nAfgelast\n`],
        ['the sender name, then "Rescinded"', `${LONG}\nAlice\nRescinded\n`],
        ['the sender name, then "Disregard This Email"', `${LONG}\nAlice\nDisregard This Email\n`],
        ['the sender name, then a date', `${LONG}\nAlice\n12 March 2025\n`],
        ['the sender name, then an amount', `${LONG}\nAlice\nTotal 950 EUR\n`],
        ['a "-- " separator, the sender name, then "Rescinded"', `${LONG}-- \nAlice\nRescinded\n`],
    ];
    // The date levels: exact (the same minute), strong (the real sender's zone), zone (on the grid).
    const LEVELS: readonly (readonly [string, string, number])[] = [
        ['exact', 'Mon, 3 Mar 2025 at 15:00', 0],
        ['strong', 'Mon, 3 Mar 2025 at 10:00', -300],
        ['zone', 'Mon, 3 Mar 2025 at 10:00', 0],
    ];
    for (const [label, extended] of VARIANTS)
    {
        for (const [level, date, aliceZone] of LEVELS)
        {
            it(`${label}: ${level}, both ways`, () =>
            {
                for (const [quoted, real] of [
                    [extended, LONG],
                    [LONG, extended],
                ] as const)
                {
                    const out = run(email(ALICE, '2025-03-03T15:00:20Z', real, aliceZone), email(BOB, '2025-03-03T16:00:00Z', gmailReply('Noted, thanks.', date, WHO, quoted)));
                    aliceRebuilt(out);
                    expectNoLink(out);
                }
            });
        }
        it(`${label}: copies at the same minute`, () =>
        {
            const one = email(BOB, '2025-03-03T11:00:00Z', gmailReply('Good.', 'Mon, 3 Mar 2025 at 10:00', WHO, LONG));
            const two = email(BOB, '2025-03-03T12:00:00Z', gmailReply('Good again.', 'Mon, 3 Mar 2025 at 10:00', WHO, extended));
            const out = run(one, two);
            aliceRebuilt(out, 2);
            expectNoLink(out);
        });
    }

    it('a 60% prefix of a longer message, the same minute, both ways and as copies', () =>
    {
        for (const [quoted, real] of [
            [prefix60, LONG],
            [LONG, prefix60],
        ] as const)
        {
            const out = run(email(ALICE, '2025-03-03T15:00:20Z', real), email(BOB, '2025-03-03T16:00:00Z', gmailReply('Noted.', 'Mon, 3 Mar 2025 at 15:00', WHO, quoted)));
            aliceRebuilt(out);
            expectNoLink(out);
        }
        const one = email(BOB, '2025-03-03T11:00:00Z', gmailReply('Good.', 'Mon, 3 Mar 2025 at 10:00', WHO, LONG));
        const two = email(BOB, '2025-03-03T12:00:00Z', gmailReply('Good again.', 'Mon, 3 Mar 2025 at 10:00', WHO, prefix60));
        const out = run(one, two);
        aliceRebuilt(out, 2);
        expectNoLink(out);
    });
});

describe('policy (b): the source zone unknown (round 4, S2)', () =>
{
    it('a daily reminder: real Monday 09:00:12Z, quoted "Tue, 4 Mar 2025 at 09:00" by an email of unknown zone', () =>
    {
        const real = email(ALICE, '2025-03-03T09:00:12Z', REMINDER);
        const reply = email(BOB, '2025-03-04T10:00:00Z', gmailReply('Done.', 'Tue, 4 Mar 2025 at 09:00', WHO, REMINDER), null);
        const out = run(real, reply);
        const [rebuilt] = aliceRebuilt(out);
        expect(rebuilt?.rebuilt.date?.basis).toBe('none');
        expectNoLink(out);
    });

    it('control: the same reminder quoted the same day by an email of unknown zone does link', () =>
    {
        const real = email(ALICE, '2025-03-03T09:00:12Z', REMINDER);
        const reply = email(BOB, '2025-03-03T10:00:00Z', gmailReply('Done.', 'Mon, 3 Mar 2025 at 09:00', WHO, REMINDER), null);
        const out = run(real, reply);
        const [rebuilt] = aliceRebuilt(out);
        expect(rebuilt?.rebuilt.date?.basis).toBe('none');
        expect(rebuilt?.link).toBe('real');
    });
});

describe('policy (b): what still links (round 4 controls)', () =>
{
    const SIGNED = `${LONG}\n${SIGNATURE}`;

    it('identical texts: a short one at the same minute, a long one a zone offset apart', () =>
    {
        const short = run(email(ALICE, '2025-03-03T10:00:31Z', 'Approved.\n'), email(BOB, '2025-03-03T11:00:00Z', gmailReply('Noted.', 'Mon, 3 Mar 2025 at 10:00', WHO, 'Approved.')));
        expect(aliceRebuilt(short).map((r) => r.link)).toEqual(['real']);
        const long = run(email(ALICE, '2025-03-03T15:00:20Z', LONG), email(BOB, '2025-03-03T16:00:00Z', gmailReply('Noted.', 'Mon, 3 Mar 2025 at 10:00', WHO, LONG)));
        expect(aliceRebuilt(long).map((r) => r.link)).toEqual(['real']);
    });

    it('the quote lacks the trailing signature block the real one has, and the reverse (the same minute)', () =>
    {
        for (const [quoted, real] of [
            [LONG, SIGNED],
            [SIGNED, LONG],
        ] as const)
        {
            const out = run(email(ALICE, '2025-03-03T15:00:20Z', real), email(BOB, '2025-03-03T16:00:00Z', gmailReply('Noted.', 'Mon, 3 Mar 2025 at 15:00', WHO, quoted)));
            expect(aliceRebuilt(out).map((r) => r.link)).toEqual(['real']);
        }
    });

    it('a signature after a "-- " separator line, missing in the quote', () =>
    {
        const real = `${LONG}-- \nAlice Example\nSales Manager\nTel: +32 2 123 45 67\n`;
        const out = run(email(ALICE, '2025-03-03T15:00:20Z', real), email(BOB, '2025-03-03T16:00:00Z', gmailReply('Noted.', 'Mon, 3 Mar 2025 at 10:00', WHO, LONG)));
        expect(aliceRebuilt(out).map((r) => r.link)).toEqual(['real']);
    });

    it('one-sided blocks after a blank line: the name alone, or with a phone number or a mail address (both ways)', () =>
    {
        for (const block of ['Alice\n', 'Alice\nSales Manager\n+32 2 123 45 67\n', 'Alice\nSales Manager\nalice@example.test\n'])
        {
            for (const [quoted, real] of [
                [LONG, `${LONG}\n${block}`],
                [`${LONG}\n${block}`, LONG],
            ] as const)
            {
                const out = run(email(ALICE, '2025-03-03T15:00:20Z', real), email(BOB, '2025-03-03T16:00:00Z', gmailReply('Noted.', 'Mon, 3 Mar 2025 at 15:00', WHO, quoted)));
                expect(aliceRebuilt(out).map((r) => r.link), JSON.stringify(block)).toEqual(['real']);
            }
        }
    });

    it('copies: one with the signature block, one without', () =>
    {
        const one = email(BOB, '2025-03-03T11:00:00Z', gmailReply('Good.', 'Mon, 3 Mar 2025 at 10:00', WHO, SIGNED));
        const two = email(BOB, '2025-03-03T12:00:00Z', gmailReply('Good again.', 'Mon, 3 Mar 2025 at 10:00', WHO, LONG));
        expect(aliceRebuilt(run(one, two), 2).map((r) => r.link)).toEqual(['entry', 'same-as']);
    });

    it('header leftovers at the start of the rebuilt text (a wrapped Dutch Outlook To list read short)', () =>
    {
        const messages = chain(['outlook-nl'], { quote: { people: 'name', wrapAt: 60 }, moreTo: [ALICE, ALICE, ALICE, ALICE] });
        const [first, second] = messages as [ThreadMessage, ThreadMessage];
        const asEmail = (threadMessage: ThreadMessage, body: string): NormalizedMessage => ({
            ...email(threadMessage.from, new Date(instantOf(threadMessage.sent, threadMessage.zone)).toISOString(), body,
                threadMessage.zone.offsetMinutes, threadMessage.subject),
            to: threadMessage.to,
        });
        const out = run(asEmail(first, buildThread([first]).body), asEmail(second, buildThread(messages).body));
        const [rebuilt] = aliceRebuilt(out);
        expect(rebuilt?.rebuilt.incomplete).toEqual(['to']);
        expect(rebuilt?.rebuilt.reconstructedText.startsWith('Hello Bob')).toBe(false);
        expect(comparableText(rebuilt?.rebuilt as AnalyzedRebuiltMessage['rebuilt']).startsWith('Hello Bob')).toBe(true);
        expect(rebuilt?.link).toBe('real');
    });
});
