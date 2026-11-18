// The PDF document model with emails attached inside dropped files (task
// 8.13b-3, user decisions 2026-11-10): each attached email has its own
// slot, number, index entry and File row (Q5); with "Print full original
// text" off its printed block is left out of the email holding it, "printed
// as" it (or left out with it when unticked, Q3), so nothing is printed
// twice; with it on, every body is whole and every attached email printed
// as well (Q4). The preview's labels (printedElsewhereRanges) say the same.
// The files are built in memory from synthetic text and read by the real
// parsers (README.md, rule R7).

import { describe, expect, it } from 'vitest';
import { referenceDisplayText } from '../../Helper/Test/test-support/pdf-reference';
import { buildMsg, type MsgSpec } from '../../Helper/Test/test-data/msg/builder';
import { DEFAULT_PARTS, runEngine, type EngineParts } from '../thread-analysis/engine';
import { detectQuotedOverlap } from '../thread-analysis/overlap';
import { DEFAULT_OUTPUT_POLICY, planOutput } from '../thread-analysis/output-plan';
import { createEmlParser } from '../email-reading/eml-parser';
import { FORWARDED_SEPARATOR } from '../email-reading/forwarded-block';
import type { HtmlToTextResult } from '../email-reading/html-to-text';
import { createMsgParser } from '../email-reading/msg-parser';
import { printedElsewhereRanges } from '../web-page-logic/printed-elsewhere';
import { rebuiltEntries } from '../web-page-logic/rebuilt-email-display';
import { buildPdfDocument, FILE_CHAIN_SEPARATOR, noRepeat } from './model';
import { createPdfStrings } from './strings';
import { lineText } from './text';
import type { OutputPolicy } from '../../Header/output-plan';
import type { ParseResult } from '../../Header/parsed-email';
import type { PdfDocument, PdfEmail } from '../../Header/pdf-document-model';
import type { EngineResult } from '../../Header/thread-analysis-result';

const crlf = (...lines: string[]): string => lines.join('\r\n');
const stub = (html: string): HtmlToTextResult => ({ text: `[html ${String(html.length)}]`, truncated: false });
const eml = createEmlParser({ htmlToText: stub });
const msg = createMsgParser({ htmlToText: stub });
const strings = createPdfStrings('en');

const plain = (text: string): string => crlf('Content-Type: text/plain; charset=utf-8', '', text);
const mixed = (b: string, ...parts: string[]): string =>
    crlf(`Content-Type: multipart/mixed; boundary="${b}"`, '', ...parts.flatMap((p) => [`--${b}`, p]), `--${b}--`, '');
const rfc822 = (message: string, disposition?: string): string =>
    crlf('Content-Type: message/rfc822', ...(disposition === undefined ? [] : [`Content-Disposition: ${disposition}`]), '', message);
const head = (name: string, date: string | null): string[] => [
    `From: ${name} <${name}@example.test>`,
    'To: Team <team@example.test>',
    ...(date === null ? [] : [`Date: ${date}`]),
    `Subject: ${name} subject`,
    `Message-ID: <${name}@example.test>`,
    'MIME-Version: 1.0',
];
const simple = (name: string, date: string | null, body: string): string => crlf(...head(name, date), '', body);
const holding = (name: string, date: string | null, ...parts: string[]): string => crlf(...head(name, date), mixed(`b-${name}`, ...parts));

const OWN = 'Please find the forwarded figures below, as promised during the call.';
const A_BODY = 'The quarterly figures for the north warehouse are attached and the totals were checked twice by the team.';
const B_BODY = 'Please confirm the delivery window for the twelve oak desks before Friday so the movers can plan the route.';
const MON = 'Mon, 2 Jun 2025 10:00:00 +0200';
const TUE = 'Tue, 3 Jun 2025 14:00:00 +0200';

async function parseEml(name: string, text: string): Promise<ParseResult>
{
    const r = await eml.parse({ name, bytes: new TextEncoder().encode(text) });
    if (!r.ok)
    {
        throw new Error(r.detail);
    }
    return r;
}

const squash = (s: string): string => s.replace(/\s+/gu, ' ').trim();
const bodyOf = (e: PdfEmail): string => e.body.map(lineText).join('\n');
const fileRow = (e: PdfEmail): string[] => e.fields.find((f) => f.label === strings.fileLabel)!.value.map(lineText);

/** The PDF model of `out` with the emails at `positions` (default: all). */
function docOf(out: EngineResult, policy: OutputPolicy = DEFAULT_OUTPUT_POLICY, positions = out.messages.map((_, k) => k)): PdfDocument
{
    const plans = planOutput(
        positions.map((p) => out.messages[p]!),
        policy,
    );
    return buildPdfDocument({ result: out, positions, plans, policy, timeZone: 'America/New_York', generatedAt: Date.UTC(2025, 5, 10), strings });
}
/** The preview's labels for the same input (Source/web-page-logic/printed-elsewhere.ts). */
function labelsOf(out: EngineResult, policy: OutputPolicy = DEFAULT_OUTPUT_POLICY, positions = out.messages.map((_, k) => k))
{
    const plans = planOutput(
        positions.map((p) => out.messages[p]!),
        policy,
    );
    return printedElsewhereRanges({ result: out, positions, plans, policy, rebuilt: [] });
}
const emailOf = (d: PdfDocument, out: EngineResult, subject: string): PdfEmail | undefined =>
    d.emails.find((e) => e.position !== null && out.messages[e.position]?.message.subject === subject);
const positionOf = (out: EngineResult, subject: string): number => out.messages.findIndex((m) => m.message.subject === subject);
/** How many emails of the PDF print `text`. */
const printedIn = (d: PdfDocument, text: string): number => d.emails.filter((e) => squash(bodyOf(e)).includes(squash(text))).length;

describe('PDF model: an inline forward (.eml) printed as an email of its own', () =>
{
    const build = async (): Promise<EngineResult> =>
        runEngine([await parseEml('parent.eml', holding('alice', TUE, plain(OWN), rfc822(simple('bob', MON, A_BODY))))]);

    it('folded: its own entry and page, its block cut from the parent ("printed as" it), never printed twice', async () =>
    {
        const out = await build();
        const d = docOf(out);
        expect(d.emails).toHaveLength(2);
        expect(d.index.entries.map((e) => e.number)).toEqual([1, 2]);
        const parent = emailOf(d, out, 'alice subject')!;
        const attached = emailOf(d, out, 'bob subject')!;
        expect(squash(bodyOf(parent))).toBe(squash(OWN));
        expect(bodyOf(parent)).not.toContain(FORWARDED_SEPARATOR);
        expect(squash(bodyOf(attached))).toContain(squash(A_BODY));
        expect(printedIn(d, A_BODY)).toBe(1);
        expect(parent.flags.printedElsewhere).toBe(true);
        // Q5: the File row names the file, then the attachment (no name: its number).
        expect(fileRow(parent)).toEqual(['parent.eml']);
        expect(fileRow(attached)).toEqual([`parent.eml${FILE_CHAIN_SEPARATOR}(attached email 1)`]);
        // The preview labels the same part, with the email it is printed as.
        const ranges = labelsOf(out).get(positionOf(out, 'alice subject'))!;
        const cut = ranges.filter((r) => r.printedAs !== null);
        expect(cut.map((r) => r.printedAs)).toEqual([{ kind: 'email', position: positionOf(out, 'bob subject'), number: attached.number }]);
        const body = out.messages[positionOf(out, 'alice subject')]!.message.bodyText;
        expect(body.slice(cut[0]!.start, cut[0]!.end).startsWith(FORWARDED_SEPARATOR)).toBe(true);
    });

    it('unticked (Q3): left out of the PDF and out of its parent too, labelled so in the preview', async () =>
    {
        const out = await build();
        const positions = [positionOf(out, 'alice subject')];
        const d = docOf(out, DEFAULT_OUTPUT_POLICY, positions);
        expect(d.emails).toHaveLength(1);
        expect(printedIn(d, A_BODY)).toBe(0);
        expect(squash(bodyOf(d.emails[0]!))).toBe(squash(OWN));
        const cut = labelsOf(out, DEFAULT_OUTPUT_POLICY, positions)
            .get(positions[0]!)!
            .filter((r) => r.printedAs !== null);
        expect(cut.map((r) => r.printedAs)).toEqual([{ kind: 'unticked-attached', position: positionOf(out, 'bob subject') }]);
    });

    it('the parent unticked: the attached email is still printed on its own', async () =>
    {
        const out = await build();
        const d = docOf(out, DEFAULT_OUTPUT_POLICY, [positionOf(out, 'bob subject')]);
        expect(d.emails).toHaveLength(1);
        expect(printedIn(d, A_BODY)).toBe(1);
        expect(printedIn(d, OWN)).toBe(0);
    });

    it('full original text (Q4): the parent whole, the attached email printed as well', async () =>
    {
        const out = await build();
        const policy = { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true };
        const d = docOf(out, policy);
        const parent = emailOf(d, out, 'alice subject')!;
        expect(bodyOf(parent)).toBe(referenceDisplayText(out.messages[positionOf(out, 'alice subject')]!.message.bodyText));
        expect(bodyOf(parent)).toContain(FORWARDED_SEPARATOR);
        expect(printedIn(d, A_BODY)).toBe(2);
        expect(labelsOf(out, policy).size).toBe(0);
        expect(noRepeat({ result: out, positions: [0, 1], plans: [], policy }).parts.size).toBe(0);
    });
});

describe('PDF model: other kinds of attached emails', () =>
{
    it('sent as an attachment (.eml): printed on its own with its name; the parent body is untouched', async () =>
    {
        const out = runEngine([
            await parseEml('parent.eml', holding('alice', TUE, plain(OWN), rfc822(simple('bob', MON, A_BODY), 'attachment; filename="figures.eml"'))),
        ]);
        const d = docOf(out);
        expect(d.emails).toHaveLength(2);
        expect(fileRow(emailOf(d, out, 'bob subject')!)).toEqual([`parent.eml${FILE_CHAIN_SEPARATOR}figures.eml`]);
        expect(squash(bodyOf(emailOf(d, out, 'alice subject')!))).toBe(squash(OWN));
        expect(emailOf(d, out, 'alice subject')!.attachments?.items.map(lineText)[0]).toContain('figures.eml');
        expect(printedIn(d, A_BODY)).toBe(1);
    });

    it('an attached Outlook email (.msg): printed on its own, File row "outer.msg › item name"', async () =>
    {
        const inner: MsgSpec = {
            id: 'inner',
            description: 'inner',
            strings: 'unicode',
            subject: 'Inner item',
            sender: { name: 'Bob', smtp: 'bob@example.test' },
            recipients: [{ type: 'to', name: 'Team', smtp: 'team@example.test' }],
            bodyText: B_BODY,
            submitTime: '2025-06-02T08:00:00Z',
            messageId: '<inner-item@example.test>',
        };
        const outer: MsgSpec = { ...inner, id: 'outer', subject: 'Outer item', bodyText: OWN, submitTime: '2025-06-03T08:00:00Z', messageId: '<outer-item@example.test>', attachedItems: [{ displayName: 'Inner item', message: inner }] };
        const parsed = await msg.parse({ name: 'outer.msg', bytes: buildMsg(outer) });
        const out = runEngine([parsed]);
        const d = docOf(out);
        expect(d.emails.map((e) => fileRow(e))).toEqual([[`outer.msg${FILE_CHAIN_SEPARATOR}Inner item.msg`], ['outer.msg']]);
        expect(printedIn(d, B_BODY)).toBe(1);
        expect(printedIn(d, OWN)).toBe(1);
    });

    it('nested inline forwards: each printed once, each block cut where it is printed; the File row chains every level', async () =>
    {
        const b = simple('carol', 'Sun, 1 Jun 2025 09:00:00 +0200', B_BODY);
        const a = holding('bob', MON, plain(A_BODY), crlf('Content-Type: message/rfc822; name="inner.eml"', '', b));
        const out = runEngine([await parseEml('parent.eml', holding('alice', TUE, plain(OWN), rfc822(a)))]);
        const all = docOf(out);
        expect(all.emails).toHaveLength(3);
        expect(printedIn(all, A_BODY)).toBe(1);
        expect(printedIn(all, B_BODY)).toBe(1);
        expect(squash(bodyOf(emailOf(all, out, 'alice subject')!))).toBe(squash(OWN));
        expect(squash(bodyOf(emailOf(all, out, 'bob subject')!))).toBe(squash(A_BODY));
        expect(fileRow(emailOf(all, out, 'carol subject')!)).toEqual([['parent.eml', '(attached email 1)', 'inner.eml'].join(FILE_CHAIN_SEPARATOR)]);
        // The middle one unticked: its text nowhere, the innermost still printed once.
        const noMiddle = docOf(out, DEFAULT_OUTPUT_POLICY, [positionOf(out, 'carol subject'), positionOf(out, 'alice subject')]);
        expect(printedIn(noMiddle, A_BODY)).toBe(0);
        expect(printedIn(noMiddle, B_BODY)).toBe(1);
        // The innermost unticked: left out of both emails that print its block.
        const noInner = docOf(out, DEFAULT_OUTPUT_POLICY, [positionOf(out, 'bob subject'), positionOf(out, 'alice subject')]);
        expect(printedIn(noInner, B_BODY)).toBe(0);
        expect(printedIn(noInner, A_BODY)).toBe(1);
    });

    it('a duplicate of a dropped file (Q8): the block is cut and printed as the dropped copy; unticked, left out', async () =>
    {
        const copy = simple('bob', MON, A_BODY);
        const out = runEngine([await parseEml('parent.eml', holding('alice', TUE, plain(OWN), rfc822(copy))), await parseEml('bob.eml', copy)]);
        expect(out.counts.duplicatesMerged).toBe(1);
        const d = docOf(out);
        expect(d.emails).toHaveLength(2);
        const kept = emailOf(d, out, 'bob subject')!;
        expect(fileRow(kept)).toEqual(['bob.eml', `parent.eml${FILE_CHAIN_SEPARATOR}(attached email 1)`]);
        expect(printedIn(d, A_BODY)).toBe(1);
        const cut = labelsOf(out).get(positionOf(out, 'alice subject'))!.filter((r) => r.printedAs !== null);
        expect(cut.map((r) => r.printedAs)).toEqual([{ kind: 'email', position: positionOf(out, 'bob subject'), number: kept.number }]);
        const without = docOf(out, DEFAULT_OUTPUT_POLICY, [positionOf(out, 'alice subject')]);
        expect(printedIn(without, A_BODY)).toBe(0);
    });

    it('the same file added twice: each email once, the block cut once', async () =>
    {
        const text = holding('alice', TUE, plain(OWN), rfc822(simple('bob', MON, A_BODY)));
        const out = runEngine([await parseEml('one.eml', text), await parseEml('two.eml', text)]);
        const d = docOf(out);
        expect(d.emails).toHaveLength(2);
        expect(printedIn(d, A_BODY)).toBe(1);
        expect(printedIn(d, OWN)).toBe(1);
    });

    it('an undated attached email comes just before its parent in the PDF, with "no date" in the index', async () =>
    {
        const out = runEngine([await parseEml('parent.eml', holding('alice', TUE, plain(OWN), rfc822(simple('bob', null, A_BODY))))]);
        const d = docOf(out);
        expect(d.emails.map((e) => out.messages[e.position!]!.message.subject)).toEqual(['bob subject', 'alice subject']);
        expect(d.emails[0]!.flags.undated).toBe(true);
        expect(lineText(d.index.entries[0]!.date)).toBe(strings.noDate);
        expect(d.cover.undated).toBe(1);
    });
});

describe('PDF model: only what an attached email\'s page prints is left out of the email holding it (review round 4, M1)', () =>
{
    // Cy forwards Ben's reply inline; Ben's reply quotes an older email of Ann's, which is NOT among the files.
    // Ben's page leaves that quote out (quoted history): it must stay in Cy's copy of Ben's block.
    const OLD = 'UNIQUE-OLD the storage room keys were handed to the caretaker on Monday morning after the inspection.';
    const FINE = 'Fine by me, I will tell the front desk about the loading bay today and book the lift.';
    const NOTE = 'Forwarding the note from Ben about the move, for the record of the facilities team.';
    const WED = 'Wed, 4 Jun 2025 10:00:00 +0200';
    const withHeader = `${FINE}\r\n\r\nOn Mon, 2 Jun 2025 at 10:00, Ann Old <ann@example.test> wrote:\r\n> ${OLD}\r\n`;
    // A reply header with neither a readable date nor a sender mailbox: the quote cannot be rebuilt
    // (reconstruct.ts, R1), but Ben's plan still leaves it out as quoted history.
    const marksOnly = `${FINE}\r\n\r\nOn a quiet afternoon last spring, the old office team wrote:\r\n> ${OLD}\r\n`;
    const build = async (benBody: string): Promise<EngineResult> => runEngine([await parseEml('cy.eml', holding('cy', WED, plain(NOTE), rfc822(simple('ben', TUE, benBody))))]);

    /** The PDF and the preview's ranges for Cy, for one way of choosing rebuilt emails. */
    function both(out: EngineResult, extra: { readonly rebuilt?: number[]; readonly unticked?: number[]; readonly rebuildingOff?: boolean }, positions = out.messages.map((_, k) => k))
    {
        const plans = planOutput(
            positions.map((p) => out.messages[p]!),
            DEFAULT_OUTPUT_POLICY,
        );
        const input = { result: out, positions, plans, policy: DEFAULT_OUTPUT_POLICY, rebuilt: extra.rebuilt ?? [], ...(extra.unticked === undefined ? {} : { unticked: extra.unticked }), ...(extra.rebuildingOff === undefined ? {} : { rebuildingOff: extra.rebuildingOff }) };
        const d = buildPdfDocument({ ...input, timeZone: 'UTC', generatedAt: 0, strings });
        return { d, ranges: printedElsewhereRanges(input) };
    }

    /** The checks for one mode: OLD printed in Cy (and labelled so in the preview), Ben's own text once, on his page. */
    function expectKept(out: EngineResult, d: PdfDocument, ranges: ReturnType<typeof printedElsewhereRanges>): void
    {
        const cy = positionOf(out, 'cy subject');
        const cyBody = out.messages[cy]!.message.bodyText;
        expect(squash(bodyOf(emailOf(d, out, 'cy subject')!))).toContain(squash(OLD));
        expect(squash(bodyOf(emailOf(d, out, 'ben subject')!))).not.toContain(squash(OLD));
        expect(printedIn(d, FINE)).toBe(1);
        expect(printedIn(d, NOTE)).toBe(1);
        // The preview says the same: the quote is in a kept piece of Cy, never in one labelled "printed as" Ben.
        const at = cyBody.indexOf(OLD);
        const list = ranges.get(cy)!;
        expect(list.some((r) => r.keep && r.printedAs === null && r.start <= at && at < r.end)).toBe(true);
        for (const r of list.filter((x) => x.printedAs !== null))
        {
            expect(cyBody.slice(r.start, r.end)).not.toContain(OLD);
        }
        // Ben's own answer is cut from Cy, labelled "printed as" Ben.
        const fine = cyBody.indexOf(FINE);
        expect(list.some((r) => r.printedAs?.kind === 'email' && r.printedAs.position === positionOf(out, 'ben subject') && r.start <= fine && fine < r.end)).toBe(true);
    }

    it('rebuilding off: the old quote stays in Cy\'s forward', async () =>
    {
        const out = await build(withHeader);
        const { d, ranges } = both(out, { rebuildingOff: true });
        expectKept(out, d, ranges);
    });

    it('rebuilding on, no rebuilt email chosen (every one unticked): the old quote stays in Cy\'s forward', async () =>
    {
        const out = await build(withHeader);
        const ids = rebuiltEntries(out).map((r) => r.id);
        expect(ids.length).toBeGreaterThan(0);
        const { d, ranges } = both(out, { rebuilt: [], unticked: ids });
        expectKept(out, d, ranges);
    });

    it('a quote that cannot be rebuilt (a reply header with no date and no sender): the old quote stays in Cy\'s forward', async () =>
    {
        const out = await build(marksOnly);
        expect(rebuiltEntries(out)).toEqual([]);
        const { d, ranges } = both(out, {});
        expectKept(out, d, ranges);
    });

    it('the rebuilt email chosen: the old quote is printed (as the rebuilt email, and still in Cy: a repeat, never a loss)', async () =>
    {
        const out = await build(withHeader);
        const ids = rebuiltEntries(out).map((r) => r.id);
        const { d } = both(out, { rebuilt: ids });
        expect(printedIn(d, OLD)).toBeGreaterThanOrEqual(1);
        expect(printedIn(d, FINE)).toBe(1);
    });

    it('Ben unticked (Q3): his whole block, quote included, is left out of Cy', async () =>
    {
        const out = await build(withHeader);
        const { d } = both(out, { rebuildingOff: true }, [positionOf(out, 'cy subject')]);
        expect(printedIn(d, OLD)).toBe(0);
        expect(printedIn(d, FINE)).toBe(0);
        expect(printedIn(d, NOTE)).toBe(1);
    });

    it('nested: the middle email unticked (Q3), the innermost ticked: what the innermost\'s page leaves out stays in the outer holder', async () =>
    {
        // Cy forwards Bea's email inline; Bea's email forwards Dan's reply inline; Dan's reply quotes Ann's older
        // email, which is NOT among the files. Bea is unticked, so her whole block is left out of Cy, LESS what
        // Dan's page does not print (the old quote, rebuilding off): that must stay in Cy (collapse, never delete).
        const BEA = 'Bea adds that the movers asked for the lift to be reserved from eight until noon on the day.';
        const dan = simple('dan', TUE, withHeader);
        const bea = holding('bea', TUE, plain(BEA), rfc822(dan));
        const out = runEngine([await parseEml('cy.eml', holding('cy', WED, plain(NOTE), rfc822(bea)))]);
        expect(out.messages.map((m) => m.message.subject).sort()).toEqual(['bea subject', 'cy subject', 'dan subject']);
        const cy = positionOf(out, 'cy subject');
        const positions = [cy, positionOf(out, 'dan subject')].sort((x, y) => x - y);
        const { d, ranges } = both(out, { rebuildingOff: true }, positions);
        expect(d.emails).toHaveLength(2);
        expect(squash(bodyOf(emailOf(d, out, 'cy subject')!))).toContain(squash(OLD));
        expect(squash(bodyOf(emailOf(d, out, 'dan subject')!))).not.toContain(squash(OLD));
        expect(printedIn(d, OLD)).toBe(1);
        expect(printedIn(d, FINE)).toBe(1);
        expect(printedIn(d, BEA)).toBe(0);
        expect(printedIn(d, NOTE)).toBe(1);
        // The preview agrees: the quote is in a kept piece of Cy, never in one labelled "printed as" or "left out".
        const cyBody = out.messages[cy]!.message.bodyText;
        const at = cyBody.indexOf(OLD);
        expect(at).toBeGreaterThan(0);
        const list = ranges.get(cy)!;
        expect(list.some((r) => r.keep && r.printedAs === null && r.start <= at && at < r.end)).toBe(true);
        for (const r of list.filter((x) => x.printedAs !== null))
        {
            expect(cyBody.slice(r.start, r.end)).not.toContain(OLD);
        }
        // Bea's own text is labelled as left out with her (unticked attached email).
        const bea0 = cyBody.indexOf(BEA);
        expect(list.some((r) => r.printedAs?.kind === 'unticked-attached' && r.printedAs.position === positionOf(out, 'bea subject') && r.start <= bea0 && bea0 < r.end)).toBe(true);
    });
});

describe('PDF model: copies of the email holding an attached email, and copies of the attached email (review round 4, S1 and D2)', () =>
{
    it('S1: the holder merged into a copy without the attached list: an unticked attached email is printed in no copy, a ticked one once', async () =>
    {
        const text = holding('alice', TUE, plain(OWN), rfc822(simple('bob', MON, A_BODY)));
        const withList = await parseEml('one.eml', text);
        if (!withList.ok)
        {
            throw new Error('not read');
        }
        // The same email, its attached list not read, LF line ends and trailing spaces, and a Bcc line: this copy is kept.
        const body = withList.message.bodyText.replace(/\r\n/gu, '\n').replace(/\n/gu, '  \n');
        const noList: ParseResult = { ok: true, message: { ...withList.message, bodyText: body, bcc: [{ name: '', address: 'archive@example.test' }], source: { ...withList.message.source, fileName: 'two.eml', sha256: '0'.repeat(64) } } };
        for (const files of [
            [withList, noList],
            [noList, withList],
        ])
        {
            const out = runEngine(files);
            expect(out.counts.duplicatesMerged).toBe(1);
            expect(out.messages.find((m) => m.message.subject === 'alice subject')!.message.source.fileName).toBe('two.eml');
            const all = docOf(out);
            expect(printedIn(all, A_BODY)).toBe(1);
            expect(printedIn(all, OWN)).toBe(1);
            const unticked = docOf(out, DEFAULT_OUTPUT_POLICY, [positionOf(out, 'alice subject')]);
            expect(printedIn(unticked, A_BODY)).toBe(0);
            expect(printedIn(unticked, OWN)).toBe(1);
        }
    });

    it('D2: the dropped file wins over an attached copy with a Bcc line; that Bcc line stays printed in the holder (header lines only)', async () =>
    {
        const out = runEngine([
            await parseEml('parent.eml', holding('alice', TUE, plain(OWN), rfc822(simple('bob', MON, A_BODY).replace('MIME-Version', 'Bcc: boss@example.test\r\nMIME-Version')))),
            await parseEml('bob.eml', simple('bob', MON, A_BODY)),
        ]);
        expect(out.counts.duplicatesMerged).toBe(1);
        const d = docOf(out);
        const bob = emailOf(d, out, 'bob subject')!;
        expect(fileRow(bob)).toEqual(['bob.eml', `parent.eml${FILE_CHAIN_SEPARATOR}(attached email 1)`]);
        expect(bob.fields.some((f) => f.label === 'Bcc')).toBe(false);
        const parent = bodyOf(emailOf(d, out, 'alice subject')!);
        expect(parent).toContain('Bcc: boss@example.test');
        expect(printedIn(d, A_BODY)).toBe(1);
        // The same header data: the header lines go too.
        const same = runEngine([await parseEml('parent.eml', holding('alice', TUE, plain(OWN), rfc822(simple('bob', MON, A_BODY)))), await parseEml('bob.eml', simple('bob', MON, A_BODY))]);
        expect(bodyOf(emailOf(docOf(same), same, 'alice subject')!)).not.toContain(FORWARDED_SEPARATOR);
    });
});

describe('PDF model: collapse, never delete, with attached emails', () =>
{
    it('full original text: every kept email, attached ones included, is printed whole', async () =>
    {
        const b = simple('carol', null, B_BODY);
        const a = holding('bob', MON, plain(A_BODY), rfc822(b));
        const dup = simple('dave', 'Wed, 4 Jun 2025 09:00:00 +0200', 'A copy also dropped on its own.');
        const out = runEngine([
            await parseEml('parent.eml', holding('alice', TUE, plain(OWN), rfc822(a), rfc822(dup, 'attachment; filename="dup.eml"'))),
            await parseEml('dup.eml', dup),
        ]);
        const d = docOf(out, { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true });
        expect(d.emails).toHaveLength(out.messages.length);
        expect(out.messages).toHaveLength(4);
        for (const e of d.emails)
        {
            const m = out.messages[e.position!]!;
            expect(bodyOf(e), m.message.subject).toBe(referenceDisplayText(m.message.bodyText));
        }
        // Folded: every email's own text is still printed exactly once.
        const folded = docOf(out);
        for (const text of [OWN, A_BODY, B_BODY, 'A copy also dropped on its own.'])
        {
            expect(printedIn(folded, text), text).toBe(1);
        }
    });

    // Review round 2 of task 8.13b-3 (M1): an attached email dated after the email holding it, or an
    // undated copy of it dropped after that email, once lost its own text (folded as quoted from its
    // holder, while its block was cut from the holder as printed by it).
    const UNIQUE_A = 'UNIQUE-A the north warehouse inventory count finished early and every shelf label was replaced this week.';
    const aWithForward = (date: string | null): string => holding('bob', date, plain(UNIQUE_A), rfc822(simple('carol', 'Sun, 1 Jun 2025 09:00:00 +0200', B_BODY)));

    it('an attached email dated after its holder (a date with no zone) keeps its own text in the PDF', async () =>
    {
        const out = runEngine([await parseEml('parent.eml', holding('alice', 'Mon, 2 Jun 2025 10:30:00 +0200', plain(OWN), rfc822(aWithForward('Mon, 2 Jun 2025 10:00:00'))))]);
        expect(out.messages.map((m) => m.message.subject)).toEqual(['carol subject', 'alice subject', 'bob subject']);
        const d = docOf(out);
        for (const text of [OWN, UNIQUE_A, B_BODY])
        {
            expect(printedIn(d, text), text).toBe(1);
        }
        expect(squash(bodyOf(emailOf(d, out, 'bob subject')!))).toContain(squash(UNIQUE_A));
    });

    it('an undated attached email also dropped after its undated holder keeps its own text in the PDF', async () =>
    {
        const out = runEngine([
            await parseEml('parent.eml', holding('alice', null, plain(OWN), rfc822(aWithForward(null)))),
            await parseEml('a.eml', aWithForward(null)),
        ]);
        const kept = out.messages.find((m) => m.message.subject === 'bob subject')!;
        expect(kept.message.source.fileName).toBe('a.eml');
        const d = docOf(out);
        for (const text of [OWN, UNIQUE_A, B_BODY])
        {
            expect(printedIn(d, text), text).toBe(1);
        }
    });

    it('safety net: if the engine ever folded an attached email\'s text as quoted from its holder, that text stays in the holder (never nowhere)', async () =>
    {
        // The overlap detector told nothing about which email holds which: the engine fix undone.
        const noHolds: EngineParts = { ...DEFAULT_PARTS, detectQuotedOverlap: (messages) => detectQuotedOverlap(messages.map((m) => ({ bodyText: m.bodyText, messageId: m.messageId, inReplyTo: m.inReplyTo, references: m.references, index: m.index }))) };
        const out = runEngine([await parseEml('parent.eml', holding('alice', 'Mon, 2 Jun 2025 10:30:00 +0200', plain(OWN), rfc822(aWithForward('Mon, 2 Jun 2025 10:00:00'))))], noHolds);
        const bob = out.messages[positionOf(out, 'bob subject')]!;
        // Bob's own text really is folded as quoted from Alice here.
        expect(bob.segments.some((s) => s.folded && s.related.includes(0))).toBe(true);
        const d = docOf(out);
        expect(printedIn(d, UNIQUE_A)).toBeGreaterThanOrEqual(1);
        expect(squash(bodyOf(emailOf(d, out, 'alice subject')!))).toContain(squash(UNIQUE_A));
        // Review round 4 (M1): only what Bob's page prints is cut from Alice's email (his header lines, say),
        // labelled "printed as" Bob; his own text, which his page leaves out here, stays. Carol's block, printed
        // whole on her page, is cut too.
        const alice = positionOf(out, 'alice subject');
        const aliceBody = out.messages[alice]!.message.bodyText;
        const cut = labelsOf(out).get(alice)!.filter((r) => r.printedAs !== null);
        const asBob = { kind: 'email', position: positionOf(out, 'bob subject'), number: emailOf(d, out, 'bob subject')!.number };
        const asCarol = { kind: 'email', position: positionOf(out, 'carol subject'), number: emailOf(d, out, 'carol subject')!.number };
        expect(cut.map((r) => r.printedAs)).toContainEqual(asCarol);
        expect(cut.every((r) => [asBob, asCarol].some((x) => JSON.stringify(x) === JSON.stringify(r.printedAs)))).toBe(true);
        for (const r of cut)
        {
            expect(squash(aliceBody.slice(r.start, r.end))).not.toContain(squash(UNIQUE_A));
        }
        expect(printedIn(d, UNIQUE_A)).toBe(1);
        for (const text of [OWN, B_BODY])
        {
            expect(printedIn(d, text), text).toBe(1);
        }
        // Bob unticked (Q3): his block is left out of Alice's email too (no safety net needed: nothing is promised).
        const without = docOf(out, DEFAULT_OUTPUT_POLICY, [positionOf(out, 'alice subject'), positionOf(out, 'carol subject')]);
        expect(printedIn(without, UNIQUE_A)).toBe(0);
    });

    it('when unsure, keep: a block whose text cannot be matched to the attached email\'s body stays whole in its holder', async () =>
    {
        // A hand-changed result: one word of the block in Alice's body differs from Bob's own body ("north"
        // became "south", same length so every offset stays valid). normalizeBody does not ignore that, so the
        // block cannot be matched to Bob's body for certain: no part of it may be left out of Alice's email.
        const real = runEngine([await parseEml('parent.eml', holding('alice', TUE, plain(OWN), rfc822(simple('bob', MON, A_BODY))))]);
        const alice = positionOf(real, 'alice subject');
        const bob = positionOf(real, 'bob subject');
        const realBody = real.messages[alice]!.message.bodyText;
        expect(realBody.split('north').length).toBe(2);
        const changedBody = realBody.replace('north', 'south');
        const CHANGED = A_BODY.replace('north', 'south');
        const out: EngineResult = { ...real, messages: real.messages.map((m, k) => (k === alice ? { ...m, message: { ...m.message, bodyText: changedBody } } : m)) };
        const places = out.attached!.find((a) => out.positionByIndex[a.index] === bob)!.places.filter((p) => out.positionByIndex[p.holderIndex] === alice);
        expect(places).toHaveLength(1);
        const { start, end } = places[0]!;
        expect(changedBody.slice(start, end)).toContain(CHANGED);
        const positions = out.messages.map((_, k) => k);
        const plans = planOutput(
            positions.map((p) => out.messages[p]!),
            DEFAULT_OUTPUT_POLICY,
        );
        const parts = noRepeat({ result: out, positions, plans, policy: DEFAULT_OUTPUT_POLICY }).parts.get(alice) ?? [];
        for (const p of parts)
        {
            expect(p.end <= start || p.start >= end, JSON.stringify(p)).toBe(true);
        }
        const d = docOf(out);
        expect(squash(bodyOf(emailOf(d, out, 'alice subject')!))).toContain(squash(CHANGED));
        expect(squash(bodyOf(emailOf(d, out, 'alice subject')!))).toContain(squash(OWN));
        expect(squash(bodyOf(emailOf(d, out, 'bob subject')!))).toContain(squash(A_BODY));
    });
});
