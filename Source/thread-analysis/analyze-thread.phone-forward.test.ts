// End-to-end tests of the rebuild on a phone forward of a long FLAT thread (task 9.9a): a shape
// some phone mail apps produce, 13 earlier messages with no ">" marks. Every test runs the
// real chain: parse (.eml fixtures 94 to 97) or a body built in code (the same shape in French,
// English and Dutch: Helper/Test/test-support/phone-forward-thread.ts) -> analyzeThread -> output
// plan -> buildPdfDocument, and checks, field by field, the list of earlier emails a correct
// rebuild gives: newest first in the body, oldest first in the timeline and the PDF.
// The dates are checked as written (wall-clock values), not as displayed: the display of time
// zones is another task (9.9c).
// Fixture 98 (the same thread as Android HTML) needs the browser's DOMParser: it is checked card by
// card in the built site (Helper/Test/browser-tests/rebuilt.spec.ts).
// Synthetic data only (Helper/Test/test-data/README.md).

import { describe, expect, it } from 'vitest';
import {
    PHONE_FORWARD_FORMS,
    phoneForwardThread,
    squashWhiteSpace,
    type ExpectedPhoneForwardEmail,
} from '../../Helper/Test/test-support/phone-forward-thread';
import { createEmlParser } from '../email-reading/eml-parser';
import { buildPdfDocument } from '../pdf-export/build-pdf-document';
import { createPdfStrings } from '../pdf-export/pdf-strings';
import { lineText } from '../pdf-export/pdf-text-transforms';
import { rebuiltHasNoPrintableText } from '../web-page-logic/no-printable-text';
import { rebuiltEntries } from '../web-page-logic/rebuilt-email-display';
import { analyzeThread } from './analyze-thread';
import { DEFAULT_OUTPUT_POLICY, planOutput } from './output-plan';
import type { NormalizedMessage } from '../../Header/parsed-email';
import type { PdfEmail } from '../../Header/pdf-document-model';
import type { ThreadAnalysisResult } from '../../Header/thread-analysis-result';

const files = import.meta.glob<string>('../../Helper/Test/test-data/eml/9[4-7]-*.eml', { query: '?raw', import: 'default', eager: true });

// The HTML part of fixture 97 is never read (its text part wins); fixture 98 is checked in the browser.
const parser = createEmlParser({ htmlToText: () => ({ text: '[stub html-to-text]', truncated: false }) });

async function parseFixture(name: string): Promise<NormalizedMessage>
{
    const raw = files[`../../Helper/Test/test-data/eml/${name}`];
    if (raw === undefined)
    {
        throw new Error(`no fixture ${name}`);
    }
    const parsed = await parser.parse({ name, bytes: new TextEncoder().encode(raw) });
    if (!parsed.ok)
    {
        throw new Error(`${name}: ${parsed.detail}`);
    }
    return parsed.message;
}

/** A forwarding email with `body`, built in code (the shape in other languages). */
function messageWith(body: string, subject: string): NormalizedMessage
{
    const utcMs = Date.UTC(2026, 10, 17, 18, 24, 15);
    return {
        messageId: 'phone-forward-code@client.test',
        inReplyTo: null,
        references: [],
        date: { utcMs, original: 'Tue, 17 Nov 2026 19:24:15 +0100', offsetMinutes: 60, zoneKnown: true },
        from: [{ name: 'Claire Example', address: 'claire@client.test' }],
        to: [{ name: '', address: 'office@client.test' }],
        cc: [],
        bcc: [],
        subject,
        bodyText: body,
        attachments: [],
        source: { fileName: 'phone-forward.eml', sha256: '0'.repeat(64), kind: 'eml' },
        warnings: [],
    };
}

const wallOf = (ms: number | null | undefined): string | null => (typeof ms === 'number' ? new Date(ms).toISOString().slice(0, 16) : null);

/** The rebuilt list of `result`, field by field, against `expected` (newest first). Returns the problems found. */
function rebuiltProblems(result: ThreadAnalysisResult, expected: readonly ExpectedPhoneForwardEmail[]): string[]
{
    const problems: string[] = [];
    if (result.reconstructed.length !== expected.length)
    {
        problems.push(`${result.reconstructed.length} rebuilt, want ${expected.length}`);
    }
    expected.forEach((want, k) =>
    {
        const entry = result.reconstructed[k];
        if (entry === undefined)
        {
            return;
        }
        const got = entry.rebuilt;
        const text = squashWhiteSpace(got.reconstructedText);
        const have = {
            link: entry.link,
            generation: got.generation,
            kind: got.kind,
            from: got.from,
            to: got.to,
            cc: got.cc,
            dateText: got.dateText,
            wall: wallOf(got.date?.wallMs),
            subject: got.subject,
            subjectFromChain: got.subjectFromChain,
            noOwnText: got.noOwnText,
            textStart: text.slice(0, want.first.length),
            textEnd: want.last === '' ? text : text.slice(-want.last.length),
        };
        const wanted = {
            link: 'entry',
            generation: k + 1,
            kind: want.kind,
            from: [want.from],
            to: want.to,
            cc: want.cc,
            dateText: want.dateText,
            wall: want.wall,
            subject: want.subject,
            subjectFromChain: want.subjectFromChain,
            noOwnText: want.noOwnText,
            textStart: want.first,
            textEnd: want.last,
        };
        for (const key of Object.keys(wanted) as (keyof typeof wanted)[])
        {
            if (JSON.stringify(have[key]) !== JSON.stringify(wanted[key]))
            {
                problems.push(`#${k + 1} ${want.dateText}: ${key} ${JSON.stringify(have[key])}, want ${JSON.stringify(wanted[key])}`);
            }
        }
    });
    return problems;
}

const fieldOf = (email: PdfEmail, label: string): string | undefined => email.fields.find((f) => f.label === label)?.value.map(lineText).join(' / ');
const mailbox = (box: { readonly name: string; readonly address: string }): string => (box.name === '' ? box.address : `${box.name} <${box.address}>`);

/** Everything a correct rebuild of the shape gives, from the analysis to the PDF. */
function expectWholeChain(message: NormalizedMessage, expected: readonly ExpectedPhoneForwardEmail[]): void
{
    const result = analyzeThread([{ ok: true, message }]);
    expect(rebuiltProblems(result, expected)).toEqual([]);

    // The timeline: oldest first (the empty ones too), then the email that was dropped.
    const byId = new Map(result.reconstructed.map((r) => [r.id, r]));
    const order = result.timeline.map((entry) => (entry.kind === 'message' ? 'file' : (byId.get(entry.id)?.rebuilt.dateText ?? '?')));
    const oldestFirst = [...expected].reverse().map((e) => e.dateText);
    expect(order).toEqual([...oldestFirst, 'file']);

    // Counts: 13 rebuilt, 10 with text (the 3 empty ones are left out of the PDF: task 8.14).
    const entries = rebuiltEntries(result);
    expect(entries).toHaveLength(13);
    expect(entries.filter((r) => !rebuiltHasNoPrintableText(r))).toHaveLength(10);
    // rebuiltEntries lists them oldest first.
    expect(entries.filter((r) => r.rebuilt.noOwnText).map((r) => r.rebuilt.dateText)).toEqual([...expected].reverse().filter((e) => e.noOwnText).map((e) => e.dateText));

    // The PDF with every rebuilt email chosen (the default): 10 rebuilt emails, oldest first, then the file's.
    const positions = result.messages.map((_, k) => k);
    const plans = planOutput(positions.map((p) => result.messages[p]!), DEFAULT_OUTPUT_POLICY);
    const pdf = buildPdfDocument({ result, positions, plans, policy: DEFAULT_OUTPUT_POLICY, timeZone: 'UTC', generatedAt: 0,
        strings: createPdfStrings('en'), rebuilt: entries.map((r) => r.id) });
    const printed = [...expected].reverse().filter((e) => !e.noOwnText);
    // Signatures (task 9.9b-2, user decision F4): each workshop email ends with the same closing line and
    // 15-line signature, folded in every one of them (rebuilt emails, counted together), and printed in the
    // first one only (rule 3 of output-plan.ts, as for real emails). Sender -> folded blocks printed so far.
    const printedBlocks = new Map<string, Set<string>>();
    let foldedEmails = 0;
    let leftOut = 0;
    expect(pdf.emails).toHaveLength(11);
    expect(pdf.index.entries).toHaveLength(11);
    expect(pdf.cover.emailCount).toBe(11);
    printed.forEach((want, k) =>
    {
        const email = pdf.emails[k]!;
        const where = `Email ${k + 1} (${want.dateText})`;
        expect(email.rebuilt, where).not.toBeNull();
        expect(email.heading, where).toBe(`Email ${k + 1}`);
        expect(fieldOf(email, 'From'), where).toBe(mailbox(want.from));
        expect(fieldOf(email, 'Subject'), where).toBe(want.subject);
        expect(fieldOf(email, 'Cc'), where).toBe(want.cc.length === 0 ? undefined : want.cc.map(mailbox).join(', '));
        // The text, whole but for a signature block its sender's earlier email printed already. Until dates are
        // printed as written (task 9.9c), a header whose time is only estimated cannot be shown by the header
        // rows: its lines are moved to the top of the text (task 8.13a, Q4; PdfRebuiltInfo.movedHeaders).
        const shownEntry = result.reconstructed[email.rebuilt!.shownId]!;
        const rebuilt = shownEntry.rebuilt;
        const headerLines = message.bodyText.slice(rebuilt.start, rebuilt.headerEnd);
        const body = squashWhiteSpace(email.body.map(lineText).join('\n'));
        const text = squashWhiteSpace(rebuilt.reconstructedText);
        const folds = (shownEntry.segments ?? []).filter((s) => s.folded);
        expect(folds.every((s) => s.reasons.join() === 'signature'), where).toBe(true);
        const sender = want.from.address;
        const seen = printedBlocks.get(sender) ?? new Set<string>();
        printedBlocks.set(sender, seen);
        let kept = rebuilt.reconstructedText;
        for (const fold of [...folds].reverse())
        {
            const block = squashWhiteSpace(rebuilt.reconstructedText.slice(fold.start, fold.end));
            if (seen.has(block))
            {
                kept = kept.slice(0, fold.start) + kept.slice(fold.end);
                leftOut++;
            }
            seen.add(block);
        }
        foldedEmails += folds.length > 0 ? 1 : 0;
        expect(body, where).toBe(squashWhiteSpace(email.rebuilt!.movedHeaders === 0 ? kept : `${headerLines}\n${kept}`));
        expect(text.startsWith(want.first), `${where}: starts with "${want.first}"`).toBe(true);
        expect(text.endsWith(want.last), `${where}: ends with "${want.last}"`).toBe(true);
        // The bookmark ends with the subject; a long one is cut (MAX_BOOKMARK_LENGTH, ending with U+2026).
        const bookmark = pdf.index.entries[k]!.bookmark;
        const shownSubject = bookmark.slice(bookmark.indexOf(': ') + 2);
        expect(shownSubject === want.subject || (shownSubject.endsWith('\u2026') && want.subject.startsWith(shownSubject.slice(0, -1))), where).toBe(true);
    });
    // The four workshop emails fold their block; the first one printed keeps it, the three later ones leave it
    // out, so the PDF prints the signature once. The client's emails end differently each time: nothing folded.
    expect([foldedEmails, leftOut]).toEqual([4, 3]);
    const pdfText = squashWhiteSpace(pdf.emails.map((e) => e.body.map(lineText).join('\n')).join('\n'));
    const workshopEmail = result.reconstructed.find((r) => r.segments !== undefined)!;
    const signatureFold = workshopEmail.segments!.find((s) => s.folded)!;
    const signatureText = squashWhiteSpace(workshopEmail.rebuilt.reconstructedText.slice(signatureFold.start, signatureFold.end));
    expect(signatureText.split(' ').length).toBeGreaterThan(30);
    expect(pdfText.split(signatureText).length - 1).toBe(1);
    // Collapse, never delete: each folded block is still in its rebuilt text (the preview shows it, folded).
    for (const r of result.reconstructed)
    {
        expect((r.segments ?? []).map((s) => r.rebuilt.reconstructedText.slice(s.start, s.end)).join('')).toBe(r.segments === undefined ? '' : r.rebuilt.reconstructedText);
    }
    const last = pdf.emails[10]!;
    expect(last.rebuilt).toBeNull();
    expect(fieldOf(last, 'Subject')).toBe(message.subject);
    // F2 (user decision 2026-11-19, task 9.9b): no header lines with no text anywhere in the PDF. Every
    // other part of the file's text is printed as a rebuilt email above (each one's text checked whole),
    // and the 3 empty ones (the empty forward at the top, the empty attributions over 27 Sep 08:27 and
    // 14 Jul 16:53) are printed nowhere, not even in the file's own text: that text is empty, so it shows
    // the "(no text)" placeholder (task 8.14, Q6). Before task 9.9b it printed those 3 header blocks.
    expect(last.body).toEqual([]);
    expect(last.notes.map(lineText)).toEqual(['(no text)']);
    // With rebuilding off, or every rebuilt email unticked, their lines are not printed either. Only the
    // empty 14 Jul attribution has the very words of another header (the one with text under it), which
    // the file's text prints once, with its text, when rebuilding is off.
    const headerOf = (r: (typeof result.reconstructed)[number]): string => squashWhiteSpace(message.bodyText.slice(r.rebuilt.start, r.rebuilt.headerEnd));
    const emptyHeaders = result.reconstructed.filter((r) => rebuiltHasNoPrintableText(r)).map(headerOf);
    expect(emptyHeaders).toHaveLength(3);
    for (const [mode, extra] of [
        ['rebuilding off', { rebuilt: [], rebuildingOff: true }],
        ['every rebuilt email unticked', { rebuilt: [], unticked: entries.map((r) => r.id) }],
    ] as const)
    {
        const other = buildPdfDocument({ result, positions, plans, policy: DEFAULT_OUTPUT_POLICY, timeZone: 'UTC', generatedAt: 0,
            strings: createPdfStrings('en'), ...extra });
        const text = squashWhiteSpace(other.emails.map((e) => e.body.map(lineText).join('\n')).join('\n'));
        const withText = (h: string): number => result.reconstructed.filter((r) => !rebuiltHasNoPrintableText(r) && headerOf(r) === h).length;
        expect(emptyHeaders.map((h) => text.split(h).length - 1), mode)
            .toEqual(emptyHeaders.map((h) => (mode === 'rebuilding off' ? withText(h) : 0)));
    }
}

describe('phone forward of a flat thread: the fixtures (parse -> analysis -> plan -> PDF)', () =>
{
    const french = phoneForwardThread('fr');

    it.each([
        ['94-phone-forward-flat.eml'],
        ['95-phone-forward-wrapped.eml'],
        ['96-phone-forward-cut-address.eml'],
        ['97-phone-forward-alternative.eml'],
    ])('%s: 13 rebuilt (10 with text), field by field, then the PDF', async (name) =>
    {
        const message = await parseFixture(name);
        expect(message.subject).toBe(french.subject);
        expect(message.from).toEqual([{ name: 'Claire Exemple', address: 'claire@client.test' }]);
        expectWholeChain(message, french.expected);
    });

    it('the fixtures hold the French form: 94 and the text part of 97 exactly, 95 and 96 wrapped', async () =>
    {
        expect((await parseFixture('94-phone-forward-flat.eml')).bodyText).toBe(french.body);
        // The line break before a MIME boundary belongs to the boundary: the text part of 97 has no last line break.
        expect(`${(await parseFixture('97-phone-forward-alternative.eml')).bodyText}\n`).toBe(french.body);
        const wrapped = (await parseFixture('95-phone-forward-wrapped.eml')).bodyText;
        expect(wrapped).not.toBe(french.body);
        expect(squashWhiteSpace(wrapped)).toBe(squashWhiteSpace(french.body));
        // 96: the long attributions cut inside the address (then wrapped at 76: three of them over three lines).
        const cut = (await parseFixture('96-phone-forward-cut-address.eml')).bodyText;
        expect(cut).toContain('Exemple) " <atelier@meub\nles-exemple.test> a \u00e9crit :');
        expect(cut).toContain('Exemple) "\n<atelier@meubles\n-exemple.test> a \u00e9crit :');
        expect(cut).toContain('Exemple) "\n<atelier@meubles-\nexemple.test> a \u00e9crit :');
        expect(cut).toContain('Exemple) "\n<atelier@meubles-exemple\n.test> a \u00e9crit :');
        expect(squashWhiteSpace(cut.replace(/(<atelier@[^>\n]*)\n/gu, '$1'))).toBe(squashWhiteSpace(french.body));
    });

    it('96: each attribution cut inside its address is read whole (joined without a space)', async () =>
    {
        const result = analyzeThread([{ ok: true, message: await parseFixture('96-phone-forward-cut-address.eml') }]);
        const workshop = result.reconstructed.filter((r) => r.rebuilt.from[0]?.address === 'atelier@meubles-exemple.test' && r.rebuilt.kind === 'reply');
        expect(workshop.map((r) => r.rebuilt.dateText)).toEqual(['6 oct. 2026 09:34', '2 oct. 2026 16:21', '1 oct. 2026 11:15', '8 juil. 2026 11:36']);
        expect(workshop.every((r) => r.rebuilt.from[0]?.name === 'Atelier Test (Meubles Test - Exemple)')).toBe(true);
    });
});

describe('phone forward of a flat thread: the same shape in French, English and Dutch (built in code)', () =>
{
    it.each(PHONE_FORWARD_FORMS.map((form) => [form]))('%s: 13 rebuilt (10 with text), field by field, then the PDF', (form) =>
    {
        const thread = phoneForwardThread(form);
        expectWholeChain(messageWith(thread.body, thread.subject), thread.expected);
    });

    it('the forms differ only where they should: "at" / "om" / "\u00e0" or not, and the language', () =>
    {
        const lines = (form: Parameters<typeof phoneForwardThread>[0]): string[] => phoneForwardThread(form).body.split('\n');
        expect(lines('en')).toContain('On 27 Sep 2026, at 08:27, Claire Example <claire@client.test> wrote:');
        expect(lines('en-bare')).toContain('On 27 Sep 2026 08:27, Claire Example <claire@client.test> wrote:');
        expect(lines('nl')).toContain('Op 27 sep. 2026 om 08:27 heeft Claire Voorbeeld <claire@client.test> het volgende geschreven:');
        expect(lines('nl-bare')).toContain('Op 27 sep. 2026 08:27 heeft Claire Voorbeeld <claire@client.test> het volgende geschreven:');
        expect(lines('fr')).toContain('Le 27 sept. 2026 08:27, Claire Exemple <claire@client.test> a \u00e9crit :');
        expect(lines('fr-a')).toContain('Le 27 sept. 2026 \u00e0 08:27, Claire Exemple <claire@client.test> a \u00e9crit :');
        expect(lines('en')).toContain('Sent: Wednesday, September 30, 2026 10:38 PM');
        expect(lines('nl')).toContain('Verzonden: woensdag 30 september 2026 22:38');
    });
});
