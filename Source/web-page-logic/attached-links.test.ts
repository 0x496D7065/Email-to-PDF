// Unit tests for Source/web-page-logic/attached-links.ts (task 8.13b-4): the
// "Attached to" / "Attached emails" links (P1, Q1/Q2), the note for an email
// sent as an attachment that could not be read (P3, Q5: on its holder and on
// every email printing that holder inline) and the attached count (P4). The
// files are built in memory from synthetic text and read by the real parser
// and engine, so the note follows what the parser really lists (README.md,
// rule R7: synthetic data only).

import { describe, expect, it } from 'vitest';
import { runEngine } from '../thread-analysis/engine';
import { createEmlParser } from '../email-reading/eml';
import type { HtmlToTextResult } from '../email-reading/html-to-text';
import { attachedCount, attachedLinks } from './attached-links';
import type { ParseResult } from '../../Header/parsed-email';
import type { EngineMessage, EngineResult } from '../../Header/thread-analysis-result';

const crlf = (...lines: string[]): string => lines.join('\r\n');
const stub = (html: string): HtmlToTextResult => ({ text: `[html ${String(html.length)}]`, truncated: false });
const eml = createEmlParser({ htmlToText: stub });

const plain = (text: string): string => crlf('Content-Type: text/plain; charset=utf-8', '', text);
const mixed = (b: string, ...parts: string[]): string =>
    crlf(`Content-Type: multipart/mixed; boundary="${b}"`, '', ...parts.flatMap((p) => [`--${b}`, p]), `--${b}--`, '');
const rfc822 = (message: string, disposition?: string): string =>
    crlf('Content-Type: message/rfc822', ...(disposition === undefined ? [] : [`Content-Disposition: ${disposition}`]), '', message);
const asFile = (name: string): string => `attachment; filename="${name}"`;

const head = (name: string, date: string): string[] => [
    `From: ${name} <${name}@example.test>`,
    'To: Team <team@example.test>',
    `Date: ${date}`,
    `Subject: ${name} subject`,
    `Message-ID: <${name}@example.test>`,
    'MIME-Version: 1.0',
];
const simple = (name: string, date: string, body: string): string => crlf(...head(name, date), '', body);
const holding = (name: string, date: string, ...parts: string[]): string => crlf(...head(name, date), mixed(`b-${name}`, ...parts));

const DATE_1 = 'Mon, 2 Jun 2025 10:00:00 +0000';
const DATE_2 = 'Tue, 3 Jun 2025 10:00:00 +0000';
const DATE_3 = 'Wed, 4 Jun 2025 10:00:00 +0000';
const DATE_4 = 'Thu, 5 Jun 2025 10:00:00 +0000';
const BODY = (who: string): string => `${who} wrote this text about the oak desks and the delivery window on Friday morning.`;
/** An email part that the parser cannot read as an email: nothing to show (no header lines, no text, no attachment). */
const UNREADABLE = '\r\n';

async function run(...files: [string, string][]): Promise<EngineResult>
{
    const parsed: ParseResult[] = [];
    for (const [name, text] of files)
    {
        parsed.push(await eml.parse({ name, bytes: new TextEncoder().encode(text) }));
    }
    return runEngine(parsed);
}
const numberOf = (out: EngineResult, subject: string): number =>
{
    const position = out.messages.findIndex((m) => m.message.subject === subject);
    if (position < 0)
    {
        throw new Error(`no message ${subject}`);
    }
    return position + 1;
};
const at = <T>(list: readonly T[], out: EngineResult, subject: string): T => list[numberOf(out, subject) - 1] as T;

describe('attachedLinks: Attached to / Attached emails (P1)', () =>
{
    it('links an inline forward and its holder both ways, with list numbers', async () =>
    {
        const out = await run(['carol.eml', holding('carol', DATE_2, plain(BODY('Carol')), rfc822(simple('bob', DATE_1, BODY('Bob'))))]);
        const links = attachedLinks(out);
        expect(at(links.attachedTo, out, 'bob subject')).toEqual([numberOf(out, 'carol subject')]);
        expect(at(links.attachedEmails, out, 'carol subject')).toEqual([numberOf(out, 'bob subject')]);
        expect(at(links.attachedTo, out, 'carol subject')).toEqual([]);
        expect(at(links.attachedEmails, out, 'bob subject')).toEqual([]);
        expect(links.unread).toEqual([null, null]);
    });

    it('links an email sent as a file, and every level of a nested one to its own holder only', async () =>
    {
        const inner = holding('bob', DATE_2, plain(BODY('Bob')), rfc822(simple('alice', DATE_1, BODY('Alice')), asFile('alice.eml')));
        const out = await run(['carol.eml', holding('carol', DATE_3, plain(BODY('Carol')), rfc822(inner, asFile('bob.eml')))]);
        const links = attachedLinks(out);
        expect(at(links.attachedTo, out, 'alice subject')).toEqual([numberOf(out, 'bob subject')]);
        expect(at(links.attachedTo, out, 'bob subject')).toEqual([numberOf(out, 'carol subject')]);
        expect(at(links.attachedEmails, out, 'carol subject')).toEqual([numberOf(out, 'bob subject')]);
        expect(at(links.attachedEmails, out, 'bob subject')).toEqual([numberOf(out, 'alice subject')]);
        expect(links.unread).toEqual([null, null, null]);
    });

    it('lists several attached emails in ascending order', async () =>
    {
        const out = await run([
            'dan.eml',
            holding('dan', DATE_4, plain(BODY('Dan')), rfc822(simple('carol', DATE_3, BODY('Carol')), asFile('c.eml')), rfc822(simple('alice', DATE_1, BODY('Alice')))),
        ]);
        const links = attachedLinks(out);
        expect(at(links.attachedEmails, out, 'dan subject')).toEqual([numberOf(out, 'alice subject'), numberOf(out, 'carol subject')]);
    });

    it('links to the card that shows a merged copy: a dropped file wins, and the holder still lists it', async () =>
    {
        const bob = simple('bob', DATE_1, BODY('Bob'));
        const out = await run(['bob.eml', bob], ['carol.eml', holding('carol', DATE_2, plain(BODY('Carol')), rfc822(bob, asFile('fwd.eml')))]);
        expect(out.messages).toHaveLength(2); // the attached copy was merged into bob.eml
        const links = attachedLinks(out);
        expect(at(links.attachedTo, out, 'bob subject')).toEqual([numberOf(out, 'carol subject')]);
        expect(at(links.attachedEmails, out, 'carol subject')).toEqual([numberOf(out, 'bob subject')]);
    });

    it('names every holder when the same email is attached in two files', async () =>
    {
        const bob = simple('bob', DATE_1, BODY('Bob'));
        const out = await run(
            ['carol.eml', holding('carol', DATE_2, plain(BODY('Carol')), rfc822(bob, asFile('a.eml')))],
            ['dan.eml', holding('dan', DATE_3, plain(BODY('Dan')), rfc822(bob, asFile('b.eml')))],
        );
        expect(out.messages).toHaveLength(3);
        const links = attachedLinks(out);
        expect(at(links.attachedTo, out, 'bob subject')).toEqual([numberOf(out, 'carol subject'), numberOf(out, 'dan subject')]);
    });

    it('never links an email to itself, and gives empty lists without attached emails', async () =>
    {
        const out = await run(['bob.eml', simple('bob', DATE_1, BODY('Bob'))]);
        expect(attachedLinks(out)).toEqual({ attachedTo: [[]], attachedEmails: [[]], unread: [null] });
        const self = { ...out, attached: [{ index: 0, parentIndex: 0, fileIndex: 0, path: [1], names: [''], places: [], keptShowsHeader: true }] } as EngineResult;
        expect(attachedLinks(self).attachedTo).toEqual([[]]);
    });

    it('skips broken entries instead of throwing', async () =>
    {
        const out = await run(['carol.eml', holding('carol', DATE_2, plain(BODY('Carol')), rfc822(simple('bob', DATE_1, BODY('Bob'))))]);
        const broken = { ...out, attached: [null, 7, { index: 'x' }, ...(out.attached ?? [])] } as unknown as EngineResult;
        expect(() => attachedLinks(broken)).not.toThrow();
        const notList = { ...out, attached: 'nope' } as unknown as EngineResult;
        expect(attachedLinks(notList).attachedTo).toEqual([[], []]);
    });
});

describe('attachedLinks: unread email sent as an attachment (P3)', () =>
{
    it('notes the holder of an email sent as a file that could not be read', async () =>
    {
        const out = await run(['carol.eml', holding('carol', DATE_2, plain(BODY('Carol')), rfc822(UNREADABLE, asFile('broken.eml')))]);
        expect(out.messages).toHaveLength(1);
        expect(out.messages[0]?.message.attachments.map((a) => a.mimeType)).toEqual(['message/rfc822']);
        expect(out.messages[0]?.parserWarnings).not.toContain('forwarded-message-not-expanded');
        expect(attachedLinks(out).unread).toEqual(['attached-unread']);
    });

    it('notes the holder and every email that prints it inline, up to the file', async () =>
    {
        const bob = holding('bob', DATE_2, plain(BODY('Bob')), rfc822(UNREADABLE, asFile('broken.eml')));
        const carol = holding('carol', DATE_3, plain(BODY('Carol')), rfc822(bob));
        const out = await run(['dan.eml', holding('dan', DATE_4, plain(BODY('Dan')), rfc822(carol))]);
        const links = attachedLinks(out);
        expect(at(links.unread, out, 'bob subject')).toBe('attached-unread');
        expect(at(links.unread, out, 'carol subject')).toBe('attached-unread-inside');
        expect(at(links.unread, out, 'dan subject')).toBe('attached-unread-inside');
    });

    it('does not note an email that holds the holder as a file only (not printed inside it)', async () =>
    {
        const bob = holding('bob', DATE_2, plain(BODY('Bob')), rfc822(UNREADABLE, asFile('broken.eml')));
        const out = await run(['carol.eml', holding('carol', DATE_3, plain(BODY('Carol')), rfc822(bob, asFile('bob.eml')))]);
        const links = attachedLinks(out);
        expect(at(links.unread, out, 'bob subject')).toBe('attached-unread');
        expect(at(links.unread, out, 'carol subject')).toBeNull();
    });

    it('gives a holder the holder note even when an email inside it has one too', async () =>
    {
        const bob = holding('bob', DATE_1, plain(BODY('Bob')), rfc822(UNREADABLE, asFile('broken-1.eml')));
        const out = await run(['carol.eml', holding('carol', DATE_2, plain(BODY('Carol')), rfc822(bob), rfc822(UNREADABLE, asFile('broken-2.eml')))]);
        const links = attachedLinks(out);
        expect(at(links.unread, out, 'bob subject')).toBe('attached-unread');
        expect(at(links.unread, out, 'carol subject')).toBe('attached-unread');
    });

    it('says nothing when every email sent as a file was read, next to an unread one when one is not', async () =>
    {
        const read = rfc822(simple('bob', DATE_1, BODY('Bob')), asFile('bob.eml'));
        const all = await run(['carol.eml', holding('carol', DATE_2, plain(BODY('Carol')), read)]);
        expect(attachedLinks(all).unread).toEqual([null, null]);
        const some = await run(['carol.eml', holding('carol', DATE_2, plain(BODY('Carol')), read, rfc822(UNREADABLE, asFile('broken.eml')))]);
        expect(at(attachedLinks(some).unread, some, 'carol subject')).toBe('attached-unread');
    });

    it('leaves an inline forward that could not be read to its own note (forwarded-message-not-expanded)', async () =>
    {
        const out = await run(['carol.eml', holding('carol', DATE_2, plain(BODY('Carol')), rfc822(UNREADABLE), rfc822(UNREADABLE, asFile('broken.eml')))]);
        expect(out.messages[0]?.parserWarnings).toContain('forwarded-message-not-expanded');
        expect(attachedLinks(out).unread).toEqual([null]);
    });

    it('says nothing for a bounce report, whose original email is never read', async () =>
    {
        const report = crlf(
            ...head('postmaster', DATE_2),
            'Content-Type: multipart/report; report-type=delivery-status; boundary="r"',
            '',
            '--r',
            plain('Your message could not be delivered.'),
            '--r',
            crlf('Content-Type: message/delivery-status', '', 'Reporting-MTA: dns; mail.example.test', '', 'Final-Recipient: rfc822; nobody@example.test', 'Action: failed', 'Status: 5.1.1'),
            '--r',
            rfc822(simple('bob', DATE_1, BODY('Bob'))),
            '--r--',
            '',
        );
        const out = await run(['bounce.eml', report]);
        expect(out.messages).toHaveLength(1);
        expect(out.messages[0]?.message.attachments.map((a) => a.mimeType)).toContain('message/rfc822');
        expect(attachedLinks(out).unread).toEqual([null]);
    });

    it('says nothing for a .msg file (an unread Outlook item has its own note)', async () =>
    {
        const out = await run(['carol.eml', holding('carol', DATE_2, plain(BODY('Carol')), rfc822(UNREADABLE, asFile('broken.eml')))]);
        const email = out.messages[0] as EngineMessage;
        const asMsg = { ...out, messages: [{ ...email, message: { ...email.message, source: { ...email.message.source, kind: 'msg' as const } } }] };
        expect(attachedLinks(asMsg).unread).toEqual([null]);
    });

    it('notes the inline holders of a holder merged into a dropped file', async () =>
    {
        const bob = holding('bob', DATE_1, plain(BODY('Bob')), rfc822(UNREADABLE, asFile('broken.eml')));
        const out = await run(['bob.eml', bob], ['carol.eml', holding('carol', DATE_2, plain(BODY('Carol')), rfc822(bob))]);
        expect(out.messages).toHaveLength(2);
        const links = attachedLinks(out);
        expect(at(links.unread, out, 'bob subject')).toBe('attached-unread');
        expect(at(links.unread, out, 'carol subject')).toBe('attached-unread-inside');
    });
});

describe('attachedCount (P4)', () =>
{
    it('counts every attached email read, merged copies included', async () =>
    {
        const bob = simple('bob', DATE_1, BODY('Bob'));
        expect(attachedCount(await run(['bob.eml', bob]))).toBe(0);
        const out = await run(['bob.eml', bob], ['carol.eml', holding('carol', DATE_2, plain(BODY('Carol')), rfc822(bob, asFile('a.eml')), rfc822(simple('alice', DATE_1, BODY('Alice'))))]);
        expect(attachedCount(out)).toBe(2);
        expect(out.counts.messagesFound).toBe(4);
        expect(attachedCount({ attached: 'nope' } as unknown as EngineResult)).toBe(0);
    });
});
