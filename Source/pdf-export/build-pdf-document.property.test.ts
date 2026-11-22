// Property and speed tests for the PDF document model (Source/pdf-export/build-pdf-document.ts).
//
// Random synthetic emails (seeded, so every run is the same), with bodies
// full of awkward text (control characters, lone surrogates, CR, U+2028,
// tabs, bidi controls, tag characters and flags, noncharacters, joiners,
// emoji, combining marks, runs of blank lines, quotes, reply headers,
// signatures), are run through the real thread analysis and output plan, and:
// - with "include everything" (README.md, rule R6), every email's body in
//   the model is the full body after the documented display transforms only
//   (checked against the independent Helper/Test/test-support/reference-pdf-text-transforms.ts); and
//   compared with the body with every quote mark kept, the ONLY characters
//   missing are the quote prefixes at line starts (tasks 8.1 and 8.6,
//   quotePrefixProblems): every other character of the message is in the
//   output;
// - with the default policy, every shown line is a piece of that full text
//   (nothing is invented, only parts are left out), and the numbering maps
//   back to the included emails;
// - with the rebuilt emails ON (task 7.7), every real email stays, and its
//   body is the same as without them except for lines left out because a
//   rebuilt email in the PDF prints them (task 8.10, the no-repeat rule:
//   each such line comes from where that rebuilt email was read, and is in
//   another email's text or is a line of the quoted header), and every
//   email, rebuilt ones too, is numbered 1..n in PDF order (task 8.3);
// - S6 (review round 3 of task 8.10, as changed by task 8.13a, Q3): every
//   non-blank range the plan calls the writer's own text ('text') is still
//   printed with rebuilt emails chosen, in the writer's own email, or, only
//   where its place holds no text the plan marks as a quote (the plan could
//   not check any of it: a middle email of an Outlook chain), in the email
//   that prints that place; also in unmarked Outlook chains with answers
//   typed inside the quotes and random files and rebuilt emails in;
// - the first three also with the same emails grouped into files with
//   emails attached inside them (task 8.13b-3, review round 2): inline or
//   as a file for the first two, only as a file for the third (the printed
//   blocks of inline ones are checked in build-pdf-document.attached.property.test.ts);
// - 2000 emails build in well under a second.
// Synthetic data only: made-up names, *.test addresses. Every invisible or
// special character is written as a \u escape.

import { describe, expect, it } from 'vitest';
import { quotePrefixProblems, referenceDisplayLines, referenceDisplayText } from '../../Helper/Test/test-support/reference-pdf-text-transforms';
import { buildThread, instantOf } from '../../Helper/Test/test-support/thread-builder';
import { THREAD_CASES } from '../../Helper/Test/test-support/thread-cases';
import { analyzeThread } from '../thread-analysis/analyze-thread';
import { DEFAULT_OUTPUT_POLICY, planOutput } from '../thread-analysis/output-plan';
import { groupAsAttached, type AttachMode } from '../../Helper/Test/test-support/attached-builder';
import { hasNoPrintableText, pdfPositions } from '../web-page-logic/no-printable-text';
import { rebuiltEntries } from '../web-page-logic/rebuilt-email-display';
import { buildPdfDocument, headerLinesEnd, holdsQuotedText, applyNoRepeatRule, pdfRanges, type PrintedPart } from './build-pdf-document';
import { createPdfStrings } from './pdf-strings';
import { lineText } from './pdf-text-transforms';
import type { MessagePlan } from '../../Header/output-plan';
import type { EmailAddress, NormalizedMessage, ParseResult } from '../../Header/parsed-email';
import type { PdfDocument, PdfEmail } from '../../Header/pdf-document-model';
import type { ReconstructedMessage } from '../../Header/rebuilt-emails';
import type { ThreadAnalysisResult } from '../../Header/thread-analysis-result';

/** mulberry32: a tiny seeded generator, returns numbers in [0, 1). */
function makeRandom(seed: number): () => number
{
    let state = seed >>> 0;
    return () =>
    {
        state = (state + 0x6d2b79f5) >>> 0;
        let bits = state;
        bits = Math.imul(bits ^ (bits >>> 15), bits | 1);
        bits ^= bits + Math.imul(bits ^ (bits >>> 7), bits | 61);
        return ((bits ^ (bits >>> 14)) >>> 0) / 4294967296;
    };
}

function pick<V>(random: () => number, list: readonly V[]): V
{
    return list[Math.floor(random() * list.length)]!;
}

const PEOPLE: readonly EmailAddress[] = [
    { name: 'Alice Example', address: 'alice@example.test' },
    { name: 'Bob Sample', address: 'bob@furniture.example.test' },
    { name: 'Carol Test', address: 'carol@sample.test' },
    { name: '', address: 'dan@example.test' },
    { name: 'Erin Été', address: 'ERIN@example.test' },
];

const PIECES: readonly string[] = [
    'The desks arrive on Monday morning.',
    'Please confirm the delivery address for the four chairs.',
    'Café cafe\u{0301} naïve',
    '\u{1F600} \u{1F44D}',
    '\n',
    '\n',
    '\n',
    '\r\n',
    '\r',
    '\n\n\n\n',
    '\r\n\r\n\r\n',
    ' ',
    '\t',
    '  \t \n',
    '\u0000',
    '\u0007',
    '\u001B',
    '\u000B',
    '\u000C',
    '\u007F',
    '\u0085',
    '\u009F',
    '\u{FFFE}',
    '\u{FFFF}',
    '\u{FFFD}\u{FEFF}',
    '\uD83D',
    '\uDE00',
    '\u{00A0}',
    '\u{2028}',
    '\u{2029}',
    // Group 1 of Source/pdf-export/pdf-text-transforms.ts beyond the controls: bidi controls, annotation, noncharacters, tags.
    '\u{202E}',
    '\u{2066}x\u{2069}',
    '\u{FFF9}',
    '\u{FDD0}',
    '\u{1FFFE}',
    '\u{10FFFF}',
    '\u{E0001}',
    '\u{E0067}',
    '\u{E007F}',
    '\u{1F3F4}',
    '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}',
    '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}',
    '\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}',
    // Not kept: a non-standard subdivision ("usca"), upper case ("GBENG"), a space tag, no terminator.
    '\u{1F3F4}\u{E0075}\u{E0073}\u{E0063}\u{E0061}\u{E007F}',
    '\u{1F3F4}\u{E0047}\u{E0042}\u{E0045}\u{E004E}\u{E0047}\u{E007F}',
    '\u{1F3F4}\u{E0067}\u{E0020}\u{E0062}\u{E007F}',
    '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}',
    // Groups 2 and 3: kept as they are.
    '\u{1F469}\u{200D}\u{1F4BB}',
    '\u{2764}\u{FE0F}',
    '\u{200B}',
    '\u{200E}\u{200F}\u{061C}',
    'soft\u{00AD}hyphen',
    '[U+0000]',
];

/** Quotes, reply headers and signatures: what the output plan may leave out. */
const STRUCTURE: readonly string[] = [
    '> quoted line from before\n',
    'On Tue, 4 Mar 2025 at 09:00, Bob Sample <bob@furniture.example.test> wrote:\n',
    '-- \nAlice Example\nExample Office Supplies\n',
    'Thanks,\n',
];

/**
 * Nested and odd quote prefixes (task 8.1): levels, spaces between marks, a
 * tab, ">" alone, a ">" mid-line, a ">" after U+2028, VT / FF in the
 * prefix (shown as codes, the prefix stops there). Put into some bodies
 * at a place chosen from the email's number (withQuotes), not from the
 * random generator, so the other random choices stay as they were.
 */
const QUOTES: readonly string[] = [
    '>> older line\n> > > oldest line\n',
    '  >\t> indented marks\n>\n> \n',
    'a > b stays\n',
    '\u{2028}> after a line separator\n',
    '>>>>>> six levels deep\n>>>>> five\n',
    '\v> vertical tab first\n> \f> form feed between\n>\v after\n',
    '\u{E0100}> supplement selector first\n>\u{E01EF}>\u{00A0}no-break space after\n\u{3164}> filler stays\n>\u{2800}> braille blank stays\n',
];

/** `body` with one of QUOTES put in at a place given by `messageIndex` (every second email). */
function withQuotes(body: string, messageIndex: number): string
{
    if (messageIndex % 2 === 1)
    {
        return body;
    }
    const insertAt = (messageIndex * 7919) % (body.length + 1);
    return body.slice(0, insertAt) + QUOTES[(messageIndex >> 1) % QUOTES.length]! + body.slice(insertAt);
}

function randomBody(random: () => number): string
{
    const n = Math.floor(random() * 25);
    let body = '';
    // One piece in four is structure, so plans with left-out parts stay common.
    for (let k = 0; k < n; k++)
    {
        body += random() < 0.25 ? pick(random, STRUCTURE) : pick(random, PIECES);
    }
    return body;
}

function randomMessage(random: () => number, messageIndex: number): NormalizedMessage
{
    const dated = random() < 0.85;
    return {
        messageId: random() < 0.9 ? `prop-${String(messageIndex)}@example.test` : null,
        inReplyTo: null,
        references: [],
        date: dated
            ? { utcMs: Date.UTC(2025, 0, 1) + Math.floor(random() * 3e10), original: 'x', offsetMinutes: 60, zoneKnown: true }
            : { utcMs: null, original: random() < 0.5 ? 'garbled\u0000date' : '', offsetMinutes: null, zoneKnown: false },
        from: random() < 0.95 ? [pick(random, PEOPLE)] : [],
        to: [pick(random, PEOPLE)],
        cc: random() < 0.3 ? [pick(random, PEOPLE)] : [],
        bcc: [],
        subject: random() < 0.1 ? '' : `Re: ${pick(random, PIECES)}`,
        bodyText: withQuotes(randomBody(random), messageIndex),
        attachments: random() < 0.2
            ? [{ fileName: `file\u0007${String(messageIndex)}.pdf`, size: Math.floor(random() * 2e6), mimeType: 'application/pdf' }] : [],
        source: { fileName: `prop-${String(messageIndex)}.eml`, sha256: messageIndex.toString(16).padStart(64, '0'), kind: 'eml' },
        warnings: [],
    };
}

/**
 * How the random emails of a seed are dropped (task 8.13b-3, review round 2):
 * each as a file of its own (as before), or grouped into files with emails
 * attached inside them (Helper/Test/test-support/attached-builder.ts) inline or as a
 * file, or only as a file (no printed block in any body).
 */
type Grouping = 'files' | AttachMode;
const GROUPINGS: readonly Grouping[] = ['files', 'random'];

/** The parse results for `messages` under `grouping`; the grouping has its own random numbers, so the seed's emails stay the same. */
function filesOf(messages: readonly NormalizedMessage[], seed: number, grouping: Grouping): ParseResult[]
{
    if (grouping === 'files')
    {
        return messages.map((message) => ({ ok: true as const, message }));
    }
    return groupAsAttached(messages, makeRandom(seed + 50_000), { mode: grouping });
}
/** How many attached emails the property tests saw (they must really be there). */
let attachedSeen = 0;
/** How many ticked emails with no text the property tests saw left out (task 8.14; they must really be there). */
let noTextSeen = 0;

/**
 * Task 8.14: the ticked emails not in the PDF (`positions` less `printed`)
 * are exactly those with no text: their body is white space only (so no
 * text is printed nowhere) and none has a PDF number; with none of them
 * (`printed` equal to `positions`), the slots are the ticked emails, as
 * before. Returns how many were left out.
 */
function expectOnlyNoTextLeftOut(result: ThreadAnalysisResult, positions: readonly number[], printed: readonly number[],
    pdfDocument: PdfDocument): number
{
    const left = positions.filter((p) => !printed.includes(p));
    for (const position of left)
    {
        const message = result.messages[position]!.message;
        expect(message.bodyText, `position ${String(position)}`).not.toMatch(/\S/u);
        expect(hasNoPrintableText(message)).toBe(true);
        expect(pdfDocument.pdfNumberByPosition[position]).toBeNull();
    }
    for (const position of printed)
    {
        expect(hasNoPrintableText(result.messages[position]!.message)).toBe(false);
    }
    if (left.length === 0)
    {
        expect(realEmails(pdfDocument).map((x) => x.position)).toEqual([...positions]);
    }
    return left.length;
}

const strings = createPdfStrings('en');
const bodyOf = (e: PdfEmail): string => e.body.map(lineText).join('\n');

/**
 * Per rebuilt entry in the PDF, the signature blocks its PDF text leaves out (task 9.9b-2: printed in an
 * earlier email of the same sender), as display text, squashed (the plans of applyNoRepeatRule).
 */
function leftOutSignatures(result: ThreadAnalysisResult, rebuiltPlans: ReturnType<typeof applyNoRepeatRule>['rebuiltPlans'],
    order: ReturnType<typeof applyNoRepeatRule>['order']): Map<number, string[]>
{
    const out = new Map<number, string[]>();
    for (const slot of order.slots)
    {
        if (slot.kind !== 'rebuilt')
        {
            continue;
        }
        const text = slot.source.shown.rebuilt.rebuilt.reconstructedText;
        const blocks = (rebuiltPlans.get(slot.entry.id)?.shown.ranges ?? []).filter((r) => !r.keep)
            .map((r) => squash(referenceDisplayText(text.slice(r.start, r.end)))).filter((b) => b !== '');
        out.set(slot.entry.id, blocks);
        expect(result.reconstructed[slot.entry.id]?.id).toBe(slot.entry.id);
    }
    return out;
}
const squash = (s: string): string => s.replace(/\s+/gu, ' ').trim();

/**
 * S6 (review round 3 of task 8.10): every kept range of reason 'text' with
 * text other than white space (the writer's own text, B1) is still in the
 * writer's own PDF email `email`, after the display transforms, white space
 * squashed. Matched IN ORDER, each range after the end of the one before it
 * (review finding G5, task 8.11): a short range ("Ok") cannot pass by
 * matching the same letters elsewhere in the body (in an earlier range's
 * words, or in quoted text before it); each range has its own place, in
 * the order of the body. The match is searched from the end of the previous
 * one (the kept text in between may be quoted text the plan keeps). Returns
 * how many ranges were checked.
 */
function expectOwnTextKept(body: string, plan: MessagePlan | undefined, email: PdfEmail, where: string,
    made?: { pdfDocument: PdfDocument; parts: readonly PrintedPart[]; places: readonly ReconstructedMessage[]; leftOut?: ReadonlyMap<number, readonly string[]> }): number
{
    if (plan === undefined || plan.fallback)
    {
        return 0;
    }
    const shown = squash(bodyOf(email));
    // Task 8.13a, Q3: the plan's ranges as the PDF cuts them; a 'text' piece left out names the email that prints it.
    const ranges = (made === undefined ? null : pdfRanges(body, plan, DEFAULT_OUTPUT_POLICY, made.parts)) ?? plan.ranges.map((r) => ({ ...r, printedAs: null }));
    let checked = 0;
    let from = 0;
    for (const range of ranges)
    {
        if (range.reason !== 'text')
        {
            continue;
        }
        const own = squash(referenceDisplayText(body.slice(range.start, range.end)));
        if (own === '')
        {
            continue;
        }
        if (range.printedAs != null && made !== undefined)
        {
            // Printed elsewhere: only from a place whose text holds no quoted text, and in the email named.
            const place = made.places.find((p) => p.start <= range.start && range.end <= p.end);
            expect(place, `${where}: own text [${String(range.start)}, ${String(range.end)}) cut inside a place`).toBeDefined();
            expect(range.printedAs.kind, where).not.toBe('unticked');
            // F6 (task 9.9b) cuts only folded pieces of a forwarded part, never the writer's own text.
            expect(range.printedAs.kind, where).not.toBe('not-rebuilt');
            const linesEnd = headerLinesEnd(body, place!);
            if (!/\S/u.test(body.slice(Math.max(range.start, linesEnd), range.end)))
            {
                // Header lines the plan took for own text (a wrapped list, a Subject line): moved to the rebuilt
                // email, or dropped for a real file that shows its own header (Q4).
                if (range.printedAs.kind === 'rebuilt')
                {
                    expect(squash(bodyOf(made.pdfDocument.emails[range.printedAs.number - 1]!)),
                        `${where}: header lines "${own.slice(0, 40)}" moved`).toContain(own);
                }
            }
            else
            {
                expect(holdsQuotedText(body, plan.ranges, linesEnd, place!.end), `${where}: own text cut next to quoted text`).toBe(false);
                // An empty rebuilt email's place (F2, 'no-text') has no text below its header lines: never here.
                expect(range.printedAs.kind, where).not.toBe('no-text');
                if (range.printedAs.kind === 'email')
                {
                    expect(squash(bodyOf(made.pdfDocument.emails[range.printedAs.number - 1]!)),
                        `${where}: own text "${own.slice(0, 40)}" in Email ${String(range.printedAs.number)}`).toContain(own);
                }
                if (range.printedAs.kind === 'rebuilt')
                {
                    // Task 9.9b-2: a rebuilt email leaves out a signature block of its sender that an email
                    // before it printed (rule 3): the own text is in it but for those blocks, printed earlier.
                    const number = range.printedAs.number;
                    const blocks = made.leftOut?.get(range.printedAs.id) ?? [];
                    let rest = own;
                    for (const block of blocks)
                    {
                        const earlier = made.pdfDocument.emails.slice(0, number - 1).map((e) => squash(bodyOf(e))).join('\n');
                        expect(earlier, `${where}: left-out signature "${block.slice(0, 40)}" printed before Email ${String(number)}`).toContain(block);
                        if (rest.includes(block))
                        {
                            leftOutSignatureSeen++;
                        }
                        rest = rest.split(block).join('\u0000');
                    }
                    const printedThere = squash(bodyOf(made.pdfDocument.emails[number - 1]!));
                    let at = 0;
                    for (const piece of rest.split('\u0000').map((x) => x.trim()).filter((x) => x !== ''))
                    {
                        const found = printedThere.indexOf(piece, at);
                        expect(found, `${where}: own text "${piece.slice(0, 40)}" in Email ${String(number)}`).toBeGreaterThanOrEqual(0);
                        at = found + piece.length;
                    }
                }
            }
            movedOwn++;
            checked++;
            continue;
        }
        if (!range.keep)
        {
            continue;
        }
        const ownStart = shown.indexOf(own, from);
        expect(ownStart,
            `${where}: own text [${String(range.start)}, ${String(range.end)}) "${own.slice(0, 40)}", in order after ${String(from)}`).toBeGreaterThanOrEqual(0);
        from = ownStart + own.length;
        checked++;
    }
    return checked;
}
/** How many own-text pieces S6 found printed as another email (Q3). */
let movedOwn = 0;
/** Own-text pieces whose rebuilt email left out a repeated signature block of it (task 9.9b-2). */
let leftOutSignatureSeen = 0;
/** The real emails of a document with their list position (rebuilt emails have none: left out first). */
const realEmails = (pdfDocument: PdfDocument): { email: PdfEmail; position: number }[] =>
    pdfDocument.emails.flatMap((e) => (e.rebuilt === null && e.position !== null ? [{ email: e, position: e.position }] : []));

describe('PDF document model properties', () =>
{
    it('with "include everything", every body is the full text after the display transforms only (also with attached emails)', () =>
    {
        let quoted = 0;
        for (const grouping of GROUPINGS)
        {
            for (let seed = 1; seed <= 40; seed++)
            {
                const random = makeRandom(seed);
                const messages = Array.from({ length: 12 }, (_, k) => randomMessage(random, seed * 100 + k));
                const result = analyzeThread(filesOf(messages, seed, grouping));
                attachedSeen += result.attached?.length ?? 0;
                const positions = result.messages.map((_, k) => k).filter(() => random() < 0.8);
                const policy = { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true };
                // Plans made with the DEFAULT policy on purpose: "include everything" must not depend on them.
                const plans = planOutput(
                    positions.map((p) => result.messages[p]!),
                    DEFAULT_OUTPUT_POLICY,
                );
                const pdfDocument = buildPdfDocument({ result, positions, plans, policy, timeZone: 'America/New_York', generatedAt: 0, strings });
                // Task 8.14: only the emails with no text are left out (white space only: nothing printed nowhere).
                const printed = pdfPositions(result, positions);
                noTextSeen += expectOnlyNoTextLeftOut(result, positions, printed, pdfDocument);
                expect(pdfDocument.emails).toHaveLength(printed.length);
                let codes = 0;
                for (const { email, position } of realEmails(pdfDocument))
                {
                    const analyzedMessage = result.messages[position]!;
                    const where = `seed ${String(seed)} position ${String(email.position)}`;
                    expect(bodyOf(email), where).toBe(referenceDisplayText(analyzedMessage.message.bodyText));
                    // Tasks 8.1 and 8.6: nothing but the quote prefixes is missing.
                    expect(quotePrefixProblems(analyzedMessage.message.bodyText, email.body.map(lineText)), where).toEqual([]);
                    quoted += referenceDisplayLines(analyzedMessage.message.bodyText, { quotes: false }).filter((l) => /^\s*>/u.test(l)).length;
                    for (const line of email.body)
                    {
                        for (const run of line)
                        {
                            expect(run.text).not.toMatch(/[\n\r\u{2028}\u{2029}]/u);
                        }
                    }
                    codes += email.flags.controlChars;
                }
                expect(pdfDocument.controlChars).toBe(codes);
            }
        }
        // The random emails must really hold quoted lines.
        expect(quoted).toBeGreaterThan(100);
    });

    it('with the default policy, every shown line is a piece of the full text, and numbers map back (also with attached emails)', () =>
    {
        let withOmissions = 0;
        for (const grouping of GROUPINGS)
        {
            for (let seed = 101; seed <= 140; seed++)
            {
                const random = makeRandom(seed);
                const messages = Array.from({ length: 12 }, (_, k) => randomMessage(random, seed * 100 + k));
                const result = analyzeThread(filesOf(messages, seed, grouping));
                attachedSeen += result.attached?.length ?? 0;
                const positions = result.messages.map((_, k) => k).filter(() => random() < 0.8);
                const plans = planOutput(positions.map((p) => result.messages[p]!));
                withOmissions += plans.filter((p) => p.ranges.some((r) => !r.keep)).length;
                const pdfDocument = buildPdfDocument(
                    { result, positions, plans, policy: DEFAULT_OUTPUT_POLICY, timeZone: 'Asia/Tokyo', generatedAt: 0, strings });
                // Task 8.14: the emails with no text are left out, the others numbered 1..k without a gap.
                const printed = pdfPositions(result, positions);
                noTextSeen += expectOnlyNoTextLeftOut(result, positions, printed, pdfDocument);
                printed.forEach((p, k) => expect(pdfDocument.pdfNumberByPosition[p]).toBe(k + 1));
                expect(pdfDocument.pdfNumberByPosition.filter((n) => n !== null)).toHaveLength(printed.length);
                for (const { email, position } of realEmails(pdfDocument))
                {
                    const full = referenceDisplayText(result.messages[position]!.message.bodyText);
                    for (const line of email.body)
                    {
                        const shown = lineText(line);
                        if (shown.trim() !== '')
                        {
                            expect(full, `seed ${String(seed)}`).toContain(shown);
                        }
                    }
                }
            }
        }
        // The random emails must really exercise left-out parts.
        expect(withOmissions).toBeGreaterThan(20);
    });

    it('with rebuilt emails chosen, every real email stays; under "Print full original text" each shows its full text and no rebuilt email is in (tasks 7.7, 7.8b)', () =>
    {
        let rebuiltShown = 0;
        let changed = 0;
        let ownTextChecked = 0;
        // With attached emails, only sent as files: no printed block in any body, so every part left out
        // is still one of a rebuilt email (blocks are checked in build-pdf-document.attached.property.test.ts).
        for (const grouping of ['files', 'file'] as const)
        {
            for (let seed = 201; seed <= 240; seed++)
            {
                const random = makeRandom(seed);
                const messages = Array.from({ length: 12 }, (_, k) =>
                {
                    const message = randomMessage(random, seed * 100 + k);
                    // A quoted history after the new text, so the thread analysis has earlier emails to rebuild.
                    const quoted = Array.from({ length: 1 + Math.floor(random() * 4) }, () => `> ${pick(random, PIECES)}`).join('\n');
                    const history = `\n\nOn Tue, 4 Mar 2025 at 09:${String(10 + (k % 50))}, ${pick(random, ['Bob Sample <bob@furniture.example.test>', 'Carol Test <carol@sample.test>'])} wrote:\n> The desks arrive on Monday morning.\n${quoted}\n`;
                    return random() < 0.7 ? { ...message, bodyText: message.bodyText + history } : message;
                });
                const result = analyzeThread(filesOf(messages, seed, grouping));
                attachedSeen += result.attached?.length ?? 0;
                const positions = result.messages.map((_, k) => k).filter(() => random() < 0.8);
                const policy = { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true };
                const included = positions.map((p) => result.messages[p]!);
                // Each document is built with plans of its own policy, as the app does (Source/web-page/pdf-labels.ts).
                const defaultPlans = planOutput(included, DEFAULT_OUTPUT_POLICY);
                const everythingPlans = planOutput(included, policy);
                const rebuilt = rebuiltEntries(result).map((r) => r.id);
                // The default policy: the rebuilt emails chosen are in, between the real ones (which all stay, numbered alike).
                const defaultInput = { result, positions, plans: defaultPlans, policy: DEFAULT_OUTPUT_POLICY, timeZone: 'America/New_York', generatedAt: 0, strings };
                const folded = buildPdfDocument({ ...defaultInput, rebuilt });
                const foldedReal = realEmails(folded);
                rebuiltShown += folded.emails.length - foldedReal.length;
                expect(foldedReal.map((x) => x.position)).toEqual(positions);
                // Task 8.3: every email, rebuilt ones too, is numbered 1..n in PDF order, index alike;
                // the real emails keep their order and carry the number pdfNumberByPosition gives.
                const all = folded.emails.map((_, k) => k + 1);
                expect(folded.emails.map((x) => x.number)).toEqual(all);
                expect(folded.index.entries.map((x) => x.number)).toEqual(all);
                expect(folded.cover.emailCount).toBe(folded.emails.length);
                for (const { email, position } of foldedReal)
                {
                    expect(folded.pdfNumberByPosition[position]).toBe(email.number);
                }
                expect(folded.pdfNumberByPosition.filter((n) => n !== null)).toHaveLength(positions.length);
                // Task 8.10 (the no-repeat rule; before it, task 7.7 wanted the real
                // emails' text the same with and without rebuilt emails): a real
                // email's text changes only where it quotes a rebuilt email that is in
                // the PDF (flag printedElsewhere), and then only by lines left out,
                // each one from the place such a rebuilt email was read from, and
                // printed elsewhere (in another email's text) unless it is a line of
                // the quoted header (shown as that email's header rows).
                const plain = realEmails(buildPdfDocument({ ...defaultInput, rebuilt: [] }));
                expect(foldedReal.map((x) => x.position)).toEqual(plain.map((x) => x.position));
                const inPdf = new Set(folded.emails.flatMap((e) => (e.rebuilt === null ? [] : [e.rebuilt.id])));
                const otherTexts = (self: PdfEmail): string => folded.emails.filter((e) => e !== self).map(bodyOf).join('\n');
                for (const [k, { email, position }] of foldedReal.entries())
                {
                    const before = plain[k]!.email;
                    if (!email.flags.printedElsewhere)
                    {
                        expect(bodyOf(email), `seed ${String(seed)} position ${String(position)}`).toBe(bodyOf(before));
                        continue;
                    }
                    changed++;
                    const body = result.messages[position]!.message.bodyText;
                    const index = result.messages[position]!.index;
                    const realInPdf = (rebuiltEntry: (typeof result.reconstructed)[number]): boolean =>
                    {
                        const realPosition = rebuiltEntry.realIndex === null ? null : result.positionByIndex[rebuiltEntry.realIndex];
                        return typeof realPosition === 'number' && realPosition !== position && folded.pdfNumberByPosition[realPosition] !== null;
                    };
                    const places = result.reconstructed.filter(
                        (rebuiltEntry) =>
                            rebuiltEntry.sourceIndex === index &&
                        ((rebuiltEntry.link === 'entry' && inPdf.has(rebuiltEntry.id))
                            || (rebuiltEntry.link === 'same-as' && rebuiltEntry.sameAs !== null && inPdf.has(rebuiltEntry.sameAs))
                            || (rebuiltEntry.link === 'real' && realInPdf(rebuiltEntry))),
                    );
                    expect(places.length, `seed ${String(seed)} position ${String(position)}`).toBeGreaterThan(0);
                    // What is left out: the lines of the text before that are not in the text now (as a multiset).
                    const left = new Map<string, number>();
                    for (const line of email.body.map(lineText))
                    {
                        left.set(line, (left.get(line) ?? 0) + 1);
                    }
                    // Whole lines are compared (a short line such as "Ok" must be a line there, not a piece of one).
                    const linesOf = (text: string): Set<string> => new Set(text.split('\n').map((x) => x.trim()));
                    const others = linesOf(otherTexts(email));
                    const placeLines = places.map((r) => linesOf(referenceDisplayText(body.slice(r.rebuilt.start, r.rebuilt.end))));
                    const headerLines = places.map((r) => linesOf(referenceDisplayText(body.slice(r.rebuilt.start, r.rebuilt.headerEnd))));
                    for (const line of before.body.map(lineText))
                    {
                        const leftCount = left.get(line) ?? 0;
                        if (leftCount > 0)
                        {
                            left.set(line, leftCount - 1);
                            continue;
                        }
                        if (line.trim() === '')
                        {
                            continue;
                        }
                        const where = `seed ${String(seed)} position ${String(position)}: "${line}"`;
                        expect(placeLines.some((set) => set.has(line.trim())), where).toBe(true);
                        const asHeader = headerLines.some((set) => set.has(line.trim()));
                        // A line with no word in it (only symbols, emoji or characters shown as codes) may
                        // differ between two copies linked 'same-as': link-rebuilt-messages.ts (rule 2)
                        // compares words only. Seen since task 9.9a rebuilds more of the random bodies.
                        const hasWords = /[\p{L}\p{N}]/u.test(line.replace(/\[U\+[0-9A-F]{4,6}\]/gu, ''));
                        expect(asHeader || others.has(line.trim()) || !hasWords, where).toBe(true);
                    }
                    // Nothing new: every line now was a line before.
                    for (const [line, leftCount] of left)
                    {
                        expect(leftCount, `seed ${String(seed)} position ${String(position)}: extra "${line}"`).toBe(0);
                    }
                }
                // S6 (review round 3 of task 8.10): the writer's own text is still in the writer's own email,
                // or (Q3, task 8.13a) in the rebuilt email that prints its place. Since task 9.9a a strong
                // "On ... wrote:" line with unquoted text under it is rebuilt too (a flat attribution), so a
                // random body can hold such a place: its text is printed as that rebuilt email.
                const { parts: defaultParts, rebuiltPlans: defaultRebuiltPlans, order: defaultOrder } = applyNoRepeatRule({ ...defaultInput, rebuilt });
                const leftOut = leftOutSignatures(result, defaultRebuiltPlans, defaultOrder);
                for (const [k, { email, position }] of foldedReal.entries())
                {
                    const places = result.reconstructed.filter((r) => result.positionByIndex[r.sourceIndex] === position).map((r) => r.rebuilt);
                    ownTextChecked += expectOwnTextKept(result.messages[position]!.message.bodyText, defaultPlans[k], email,
                        `seed ${String(seed)} position ${String(position)}`, { pdfDocument: folded, parts: defaultParts.get(position) ?? [], places, leftOut });
                }
                // "Print full original text" (user decision 2026-10-28): the same choice gives NO rebuilt email.
                const pdfDocument = buildPdfDocument(
                    { result, positions, plans: everythingPlans, policy, timeZone: 'America/New_York', generatedAt: 0, strings, rebuilt });
                const real = realEmails(pdfDocument);
                expect(pdfDocument.emails).toHaveLength(real.length);
                expect(pdfDocument.cover.emailCount).toBe(real.length);
                expect(pdfDocument.index.entries.every((x) => !x.rebuilt)).toBe(true);
                // Every included real email is there once, numbered 1..k in list order, with its full text.
                expect(real.map((x) => x.position)).toEqual(positions);
                expect(real.map((x) => x.email.number)).toEqual(positions.map((_, k) => k + 1));
                for (const { email, position } of real)
                {
                    const body = result.messages[position]!.message.bodyText;
                    expect(bodyOf(email), `seed ${String(seed)} position ${String(position)}`).toBe(referenceDisplayText(body));
                    expect(quotePrefixProblems(body, email.body.map(lineText)), `seed ${String(seed)} position ${String(position)}`).toEqual([]);
                }
            }
        }
        // The random emails must really give rebuilt emails in the PDF.
        expect(rebuiltShown).toBeGreaterThan(20);
        // And some real emails must really lose a part printed elsewhere (task 8.10).
        expect(changed).toBeGreaterThan(0);
        expect(ownTextChecked).toBeGreaterThan(100);
    });

    it('S6: in unmarked Outlook chains with answers typed inside the quotes, the writer\'s own text stays in the writer\'s email, unless its place holds no quoted text (then the email that prints the place has it: Q3, task 8.13a), whatever files and rebuilt emails are in (task 8.10)', () =>
    {
        const chains = THREAD_CASES.filter((c) => c.group.startsWith('outlook') || c.id === 'outlook-en 7 generations');
        expect(chains.length).toBeGreaterThan(8);
        let checked = 0;
        let inPlaces = 0;
        for (let seed = 301; seed <= 360; seed++)
        {
            const random = makeRandom(seed);
            const threadCase = pick(random, chains);
            const messages = threadCase.messages!;
            const last = messages.length - 1;
            // The last email, with an answer typed at a random line start inside its quoted history.
            const built = buildThread(messages).body;
            const quoteStart = built.indexOf('\n', built.indexOf(messages[last]!.text.split('\n\n')[1]!.split('\n')[0]!)) + 1;
            const lineStarts = [...built.matchAll(/\n/gu)].map((m) => m.index + 1).filter((at) => at > quoteStart && at < built.length);
            const answerAt = pick(random, lineStarts);
            const answer = `My answer ${String(seed)}: the desks arrive on Thursday morning.\n\n`;
            const lastBody = built.slice(0, answerAt) + answer + built.slice(answerAt);
            const files = messages.flatMap((threadMessage, i): NormalizedMessage[] =>
            {
                if (i !== last && random() < 0.5)
                {
                    return [];
                }
                const utcMs = instantOf(threadMessage.sent, threadMessage.zone);
                return [
                    {
                        messageId: `s6-${String(seed)}-${String(i)}@example.test`,
                        inReplyTo: null,
                        references: [],
                        date: { utcMs, original: new Date(utcMs).toUTCString(), offsetMinutes: threadMessage.zone.offsetMinutes, zoneKnown: true },
                        from: [threadMessage.from],
                        to: threadMessage.to,
                        cc: threadMessage.cc ?? [],
                        bcc: [],
                        subject: threadMessage.subject,
                        bodyText: i === last ? lastBody : buildThread(messages.slice(0, i + 1)).body,
                        attachments: [],
                        source: { fileName: `s6-${String(i)}.eml`, sha256: (seed * 100 + i).toString(16).padStart(64, '0'), kind: 'eml' },
                        warnings: [],
                    },
                ];
            });
            const result = analyzeThread(files.map((message) => ({ ok: true as const, message })));
            const positions = result.messages.map((_, k) => k);
            const plans = planOutput(result.messages, DEFAULT_OUTPUT_POLICY);
            const rebuilt = rebuiltEntries(result)
                .map((r) => r.id)
                .filter(() => random() < 0.7);
            const pdfDocument = buildPdfDocument(
                { result, positions, plans, policy: DEFAULT_OUTPUT_POLICY, timeZone: 'UTC', generatedAt: 0, strings, rebuilt });
            const { parts, rebuiltPlans, order } = applyNoRepeatRule({ result, positions, plans, policy: DEFAULT_OUTPUT_POLICY, rebuilt });
            const leftOut = leftOutSignatures(result, rebuiltPlans, order);
            for (const { email, position } of realEmails(pdfDocument))
            {
                const body = result.messages[position]!.message.bodyText;
                const where = `seed ${String(seed)} ${threadCase.id} position ${String(position)}`;
                const places = result.reconstructed.filter((r) => result.positionByIndex[r.sourceIndex] === position).map((r) => r.rebuilt);
                checked += expectOwnTextKept(body, plans[position], email, where, { pdfDocument, parts: parts.get(position) ?? [], places, leftOut });
                // How often own text sits inside a place the rule could cut (the case S6 guards).
                for (const rebuiltEntry of result.reconstructed)
                {
                    if (rebuiltEntry.sourceIndex !== result.messages[position]!.index)
                    {
                        continue;
                    }
                    if (plans[position]!.ranges.some((x) => x.keep && x.reason === 'text' && x.start < rebuiltEntry.rebuilt.end
                        && rebuiltEntry.rebuilt.headerEnd < x.end
                        && /\S/u.test(body.slice(Math.max(x.start, rebuiltEntry.rebuilt.headerEnd), Math.min(x.end, rebuiltEntry.rebuilt.end)))))
                    {
                        inPlaces++;
                    }
                }
            }
            // (The answer itself is checked only where the plan calls it the writer's own: typed inside a
            // quote the plan cannot confirm, the plan leaves it out with the quote, the accepted limit at
            // the top of Source/thread-analysis/output-plan.ts, unchanged by task 8.10.)
        }
        expect(checked).toBeGreaterThan(100);
        expect(inPlaces).toBeGreaterThan(20);
        // Q3 (task 8.13a): some own-text pieces are middle emails the plan could not check, printed as their rebuilt emails.
        expect(movedOwn).toBeGreaterThan(5);
    });

    it('the tests above really ran with emails attached inside dropped files (task 8.13b-3)', () =>
    {
        console.log(`PDF model properties: ${String(attachedSeen)} attached emails seen`);
        expect(attachedSeen).toBeGreaterThan(500);
        // Task 8.14: the random emails include some with no text (an empty random body), left out of the PDF.
        expect(noTextSeen).toBeGreaterThan(0);
        // Task 9.9b-2: some rebuilt emails left out a signature block their sender printed earlier.
        console.log(`PDF model properties: ${String(leftOutSignatureSeen)} own-text pieces with a repeated signature left out`);
        expect(leftOutSignatureSeen).toBeGreaterThan(0);
    });

    it('builds 2000 emails in well under a second', () =>
    {
        const random = makeRandom(7);
        const paragraph = 'The desks arrive on Monday morning. Please confirm the delivery address for the four chairs and the meeting table.\n';
        const messages = Array.from({ length: 2000 }, (_, k) => ({
            ...randomMessage(random, k),
            bodyText: `Hello,\n\n${paragraph.repeat(1 + (k % 12))}\n\t\u0000 note ${String(k)}\n\n\n\n-- \nSender ${String(k % 7)}\nExample Office Supplies\n`,
        }));
        const result = analyzeThread(messages.map((message) => ({ ok: true as const, message })));
        const positions = result.messages.map((_, k) => k);
        const plans = planOutput(result.messages);
        const input = { result, positions, plans, policy: DEFAULT_OUTPUT_POLICY, timeZone: 'Australia/Sydney', generatedAt: 0, strings };
        buildPdfDocument(input); // warm-up (formatter caches, JIT)
        const start = performance.now();
        const pdfDocument = buildPdfDocument(input);
        const elapsedMs = performance.now() - start;
        console.log(`PDF document model: 2000 emails in ${elapsedMs.toFixed(1)} ms`);
        expect(pdfDocument.emails).toHaveLength(2000);
        expect(elapsedMs).toBeLessThan(1000);
    });
});
