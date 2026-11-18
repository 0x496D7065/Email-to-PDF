// Unit tests for the preview rows of emails attached inside other emails
// (task 8.13b-4): "Attached to: email #N" (P1 / Q1), "Attached emails: #4,
// #6" (Q2), both plain text (Q4), and "Also in" naming the same chain as the
// PDF's File row (P2 / Q3), through one shared helper. In Node with the
// recording fake DOM (Helper/Test/test-support/fake-dom.ts), on the real parser and
// engine; the real page is checked in Chromium by Helper/Test/browser-tests/attached.spec.ts.
// Synthetic data only (README.md, rule R7).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDocument, FakeElement } from '../../Helper/Test/test-support/fake-dom';
import { analyzeThread } from '../thread-analysis/analyze-thread';
import { DEFAULT_OUTPUT_POLICY, planOutput } from '../thread-analysis/output-plan';
import { createEmlParser } from '../email-reading/eml-parser';
import type { HtmlToTextResult } from '../email-reading/html-to-text';
import { buildPdfDocument } from '../pdf-export/build-pdf-document';
import { createPdfStrings } from '../pdf-export/pdf-strings';
import { lineText } from '../pdf-export/pdf-text-transforms';
import { setLocale, t } from './translations';
import { alsoInText, attachedEmailsText, attachedToText, mountPreview, type Preview } from './preview';
import type { ParseResult } from '../../Header/parsed-email';
import type { EngineResult } from '../../Header/thread-analysis-result';

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
const BODY = (who: string): string => `${who} wrote this text about the oak desks and the delivery window on Friday morning.`;

async function run(...files: [string, string][]): Promise<EngineResult>
{
    const parsed: ParseResult[] = [];
    for (const [name, text] of files)
    {
        parsed.push(await eml.parse({ name, bytes: new TextEncoder().encode(text) }));
    }
    return analyzeThread(parsed);
}

// ------------------------------------------------------------------ fake page

let fakeDocument: FakeDocument;
let area: FakeElement;
let preview: Preview;

beforeEach(() =>
{
    fakeDocument = new FakeDocument();
    vi.stubGlobal('document', fakeDocument);
    vi.stubGlobal('window', { innerHeight: 600 });
    area = new FakeElement('div');
    preview = mountPreview({ checkArea: area as unknown as HTMLDivElement }, { zones: ['UTC'], initialZone: 'UTC', chunkSize: 1000 });
});

afterEach(() =>
{
    preview.reset();
    setLocale('en');
    vi.unstubAllGlobals();
});

const hasClass = (e: FakeElement, name: string): boolean => (e.getAttribute('class') ?? '').split(' ').includes(name);
const items = (): FakeElement[] =>
{
    const list = area.descendants().find((e) => e.getAttribute('id') === 'preview-list');
    if (list === undefined)
    {
        throw new Error('no list');
    }
    return list.children.filter((c): c is FakeElement => c instanceof FakeElement);
};
const subjectOf = (item: FakeElement): string => item.descendants().find((e) => hasClass(e, 'message-subject'))?.textContent ?? '';
const card = (subject: string): FakeElement =>
{
    const found = items().find((i) => subjectOf(i) === subject);
    if (found === undefined)
    {
        throw new Error(`no card ${subject}`);
    }
    return found;
};
const numberOf = (subject: string): string => card(subject).descendants().find((e) => hasClass(e, 'message-number'))?.textContent ?? '';
function meta(item: FakeElement, name: string): string | null
{
    const dd = item.descendants().find((e) => e.tagName === 'dd' && hasClass(e, `meta-${name}`));
    return dd === undefined ? null : dd.textContent;
}
const label = (item: FakeElement, name: string): string | undefined =>
    item.descendants().find((e) => e.tagName === 'dt' && hasClass(e, `meta-${name}`))?.textContent;
/** The meta row names of a card, in order. */
const rowNames = (item: FakeElement): string[] =>
    item
        .descendants()
        .filter((e) => e.tagName === 'dt')
        .map((e) => (e.getAttribute('class') ?? '').replace(/^meta-/, ''));

// ------------------------------------------------------------------ pure helpers

describe('row texts', () =>
{
    it('"email #2" / "emails #2, #5" and "#4, #6"; nothing for none', () =>
    {
        expect(attachedToText([])).toBe('');
        expect(attachedToText([2])).toBe('email #2');
        expect(attachedToText([2, 5])).toBe('emails #2, #5');
        expect(attachedEmailsText([])).toBe('');
        expect(attachedEmailsText([4])).toBe('#4');
        expect(attachedEmailsText([4, 6])).toBe('#4, #6');
        expect(attachedEmailsText([1234])).toBe('#1234');
        setLocale('fr');
        expect(attachedToText([2])).toBe('l’e-mail #2');
        expect(attachedToText([2, 5])).toBe('les e-mails #2 et #5');
        setLocale('nl');
        // (Intl's short unit list in Dutch has no "en".)
        expect(attachedToText([2, 5])).toBe('e-mails #2, #5');
    });
});

// ------------------------------------------------------------------ the page

describe('Attached to / Attached emails rows', () =>
{
    it('shows both rows, with the numbers shown in the list, as plain text', async () =>
    {
        const out = await run([
            'carol.eml',
            holding('carol', DATE_3, plain(BODY('Carol')), rfc822(simple('bob', DATE_2, BODY('Bob'))), rfc822(simple('alice', DATE_1, BODY('Alice')), asFile('alice.eml'))),
        ]);
        preview.show(out);
        expect(items().map(subjectOf)).toEqual(['alice subject', 'bob subject', 'carol subject']);
        expect([label(card('alice subject'), 'attached-to'), meta(card('alice subject'), 'attached-to')]).toEqual([t('preview.attachedTo'), `email ${numberOf('carol subject')}`]);
        expect(meta(card('bob subject'), 'attached-to')).toBe('email #3');
        expect([label(card('carol subject'), 'attached-emails'), meta(card('carol subject'), 'attached-emails')]).toEqual([t('preview.attachedEmails'), '#1, #2']);
        expect(meta(card('carol subject'), 'attached-to')).toBeNull();
        expect(meta(card('alice subject'), 'attached-emails')).toBeNull();
        // After the attachments, before "Also in".
        expect(rowNames(card('carol subject'))).toEqual(['date', 'author', 'to', 'attachments', 'attached-emails']);
        // Plain text: no link, no button, nothing focusable added (Q4).
        for (const element of fakeDocument.created)
        {
            expect(['a', 'button']).not.toContain(element.tagName);
            expect(element.hasAttribute('href') || element.hasAttribute('tabindex')).toBe(false);
        }
    });

    it('shows no row without attached emails', async () =>
    {
        preview.show(await run(['bob.eml', simple('bob', DATE_1, BODY('Bob'))]));
        expect(rowNames(items()[0]!)).toEqual(['date', 'author', 'to']);
    });

    it('writes the rows again in the page language, with the same numbers', async () =>
    {
        preview.show(await run(['carol.eml', holding('carol', DATE_2, plain(BODY('Carol')), rfc822(simple('bob', DATE_1, BODY('Bob'))))]));
        setLocale('fr');
        preview.relabel();
        expect([label(card('bob subject'), 'attached-to'), meta(card('bob subject'), 'attached-to')]).toEqual(['Joint à', 'l’e-mail #2']);
        expect([label(card('carol subject'), 'attached-emails'), meta(card('carol subject'), 'attached-emails')]).toEqual(['E-mails joints', '#1']);
        setLocale('nl');
        preview.relabel();
        expect([label(card('bob subject'), 'attached-to'), meta(card('bob subject'), 'attached-to')]).toEqual(['Bijgevoegd bij', 'e-mail #2']);
        expect(label(card('carol subject'), 'attached-emails')).toBe('Bijgevoegde e-mails');
    });

    it('follows a new result (files added): new numbers, and nothing left of the old links after a reset', async () =>
    {
        const carol = holding('carol', DATE_2, plain(BODY('Carol')), rfc822(simple('bob', DATE_1, BODY('Bob'))));
        preview.show(await run(['carol.eml', carol]));
        expect(meta(card('bob subject'), 'attached-to')).toBe('email #2');
        // An older email added: every number moves down by one.
        preview.show(await run(['carol.eml', carol], ['early.eml', simple('early', 'Sun, 1 Jun 2025 10:00:00 +0000', BODY('Early'))]));
        expect(meta(card('bob subject'), 'attached-to')).toBe('email #3');
        expect(meta(card('carol subject'), 'attached-emails')).toBe('#2');
        preview.reset();
        expect(items()).toEqual([]);
        preview.show(await run(['bob.eml', simple('bob', DATE_1, BODY('Bob'))]));
        expect(meta(items()[0]!, 'attached-to')).toBeNull();
    });

    it('links a dropped file to the email that holds a copy of it (the dropped file wins)', async () =>
    {
        const bob = simple('bob', DATE_1, BODY('Bob'));
        preview.show(await run(['bob.eml', bob], ['carol.eml', holding('carol', DATE_2, plain(BODY('Carol')), rfc822(bob, asFile('fwd.eml')))]));
        expect(items()).toHaveLength(2);
        expect(meta(card('bob subject'), 'attached-to')).toBe('email #2');
        expect(meta(card('carol subject'), 'attached-emails')).toBe('#1');
    });
});

describe('"Also in": the same chain as the PDF File row (P2)', () =>
{
    /** The PDF File row of the email with `subject`, as text lines. */
    function pdfFileRow(out: EngineResult, subject: string, locale: string): string[]
    {
        const positions = out.messages.map((_, k) => k);
        const plans = planOutput(
            positions.map((p) => out.messages[p]!),
            DEFAULT_OUTPUT_POLICY,
        );
        const strings = createPdfStrings(locale);
        const pdfDocument = buildPdfDocument({ result: out, positions, plans, policy: DEFAULT_OUTPUT_POLICY, timeZone: 'UTC', generatedAt: Date.UTC(2025, 5, 10), strings });
        const email = pdfDocument.emails.find((e) => e.position !== null && out.messages[e.position]?.message.subject === subject);
        return email?.fields.find((f) => f.label === strings.fileLabel)?.value.map(lineText) ?? [];
    }

    it('names an attached copy merged into a dropped file by its chain, not by the holder file alone', async () =>
    {
        const bob = simple('bob', DATE_1, BODY('Bob'));
        const out = await run(
            ['bob.eml', bob],
            ['parent.eml', holding('carol', DATE_2, plain(BODY('Carol')), rfc822(bob, asFile('fwd.eml')))],
            ['other.eml', holding('dan', DATE_3, plain(BODY('Dan')), rfc822(bob))],
        );
        preview.show(out);
        expect(meta(card('bob subject'), 'also-in')).toBe('parent.eml › fwd.eml, other.eml › (attached email 1)');
        for (const locale of ['en', 'fr', 'nl'] as const)
        {
            setLocale(locale);
            preview.relabel();
            const row = pdfFileRow(out, 'bob subject', locale);
            // The PDF row: the kept copy first, then each merged copy; the preview's row: the merged copies.
            expect(row[0]).toBe('bob.eml');
            expect(meta(card('bob subject'), 'also-in')).toBe(row.slice(1).join(', '));
        }
        setLocale('fr');
        preview.relabel();
        expect(meta(card('bob subject'), 'also-in')).toBe('parent.eml › fwd.eml, other.eml › (e-mail joint 1)');
    });

    it('still names a plain merged copy by its file name, and a copy without a name by the tool words', async () =>
    {
        const bob = simple('bob', DATE_1, BODY('Bob'));
        const out = await run(['bob.eml', bob], ['copy.eml', bob], ['', bob]);
        preview.show(out);
        expect(meta(items()[0]!, 'also-in')).toBe(`copy.eml, ${t('added.noName')}`);
        expect(alsoInText(out, out.messages[0]!.duplicates[0]!)).toBe('copy.eml');
    });
});
