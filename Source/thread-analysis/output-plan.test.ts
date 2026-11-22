// Tests for the PDF output plan (output-plan.ts). The emails go through the
// real thread analysis (analyzeThread), so the plan sees the same segments as the app.
// Synthetic data only: made-up names, *.test addresses; non-ASCII characters
// are written as \u escapes.

import { describe, expect, it } from 'vitest';
import { FORWARDED_SEPARATOR } from '../email-reading/forwarded-block';
import { analyzeThread } from './analyze-thread';
import {
    DEFAULT_OUTPUT_POLICY,
    normalizeLine,
    planOutput,
    planRebuiltText,
    quotedChain,
    type PlanInput,
    type QuoteContext,
    wordLines,
} from './output-plan';
import { detectReplyHeaders } from './reply-header';
import { buildSegments, type FoldRange } from './fold-segments';
import type { MessagePlan, OutputPolicy, PlanReason } from '../../Header/output-plan';
import type { EmailAddress, NormalizedMessage } from '../../Header/parsed-email';
import type { AnalyzedMessage, Segment } from '../../Header/thread-analysis-result';

const ALICE: EmailAddress = { name: 'Alice Example', address: 'alice@example.test' };
const BOB: EmailAddress = { name: 'Bob Sample', address: 'bob@furniture.example.test' };
const CAROL: EmailAddress = { name: 'Carol Test', address: 'carol@sample.test' };

const BASE_MS = Date.parse('2025-03-03T09:00:00Z');
let serial = 0;

interface MailSpec
{
    readonly from: EmailAddress;
    readonly body: string;
    readonly subject?: string;
    /** Minutes after BASE_MS (default: the order of creation). */
    readonly minutes?: number;
    readonly inReplyTo?: string | null;
}

function mail(spec: MailSpec): NormalizedMessage
{
    serial++;
    const ms = BASE_MS + (spec.minutes ?? serial) * 60_000;
    return {
        messageId: `m${serial}@example.test`,
        inReplyTo: spec.inReplyTo ?? null,
        references: spec.inReplyTo ? [spec.inReplyTo] : [],
        date: { utcMs: ms, original: new Date(ms).toUTCString(), offsetMinutes: 0, zoneKnown: true },
        from: [spec.from],
        to: [spec.from === ALICE ? BOB : ALICE],
        cc: [],
        bcc: [],
        subject: spec.subject ?? 'Office furniture',
        bodyText: spec.body,
        attachments: [],
        source: { fileName: `file-${serial}.eml`, sha256: serial.toString(16).padStart(64, '0'), kind: 'eml' },
        warnings: [],
    };
}

/** Runs the thread analysis; the kept messages in chronological order. */
function analyze(...mails: NormalizedMessage[]): AnalyzedMessage[]
{
    return [...analyzeThread(mails.map((message) => ({ ok: true as const, message }))).messages];
}

function byBody(messages: readonly AnalyzedMessage[], snippet: string): AnalyzedMessage
{
    const message = messages.find((x) => x.message.bodyText.includes(snippet));
    if (message === undefined)
    {
        throw new Error(`no message with ${snippet}`);
    }
    return message;
}

function kept(input: PlanInput, messagePlan: MessagePlan): string
{
    return messagePlan.ranges.filter((r) => r.keep).map((r) => input.message.bodyText.slice(r.start, r.end)).join('');
}

function omitted(input: PlanInput, messagePlan: MessagePlan): string
{
    return messagePlan.ranges.filter((r) => !r.keep).map((r) => input.message.bodyText.slice(r.start, r.end)).join('');
}

/** The reasons of the ranges overlapping `snippet` (first occurrence). */
function reasonsAt(input: PlanInput, messagePlan: MessagePlan, snippet: string): PlanReason[]
{
    const offset = input.message.bodyText.indexOf(snippet);
    if (offset < 0)
    {
        throw new Error(`snippet not found: ${snippet}`);
    }
    return [...new Set(messagePlan.ranges.filter((r) => r.start < offset + snippet.length && r.end > offset).map((r) => r.reason))];
}

/** Plans `messages` and checks the cover of every plan. */
function plan(messages: readonly PlanInput[], policy: OutputPolicy = DEFAULT_OUTPUT_POLICY): MessagePlan[]
{
    const plans = planOutput(messages, policy);
    expect(plans).toHaveLength(messages.length);
    plans.forEach((messagePlan, k) =>
    {
        const body = messages[k]!.message.bodyText;
        expect(messagePlan.ranges.map((r) => body.slice(r.start, r.end)).join('')).toBe(body);
    });
    return plans;
}

const ALICE_TEXT = [
    'Hi Bob,',
    '',
    'Could you deliver the oak desk and the four grey chairs on Friday morning?',
    'The office is on the second floor and the lift is large enough for the desk.',
    '',
    'Thanks,',
    'Alice',
].join('\n');

const quoted = (text: string): string =>
    text
        .split('\n')
        .map((line) => (line === '' ? '>' : `> ${line}`))
        .join('\n');

const BOB_SIGNATURE = '-- \nBob Sample\nSample Furniture (fictional company)';

describe('planOutput: app quoted history', () =>
{
    it('Gmail-style reply: leaves out the attribution and the quote, keeps own text and signature', () =>
    {
        const own = 'Hi Alice,\n\nYes, Friday morning works. Our driver will call you one hour before.\n\n';
        const tail = `On Mon, 3 Mar 2025 at 14:02, Alice Example <alice@example.test> wrote:\n${quoted(ALICE_TEXT)}\n`;
        const all = analyze(mail({ from: ALICE, body: ALICE_TEXT }), mail({ from: BOB, body: `${own}${BOB_SIGNATURE}\n\n${tail}` }));
        const reply = byBody(all, 'Our driver');
        const [, messagePlan] = plan(all);
        expect(kept(reply, messagePlan!)).toBe(`${own}${BOB_SIGNATURE}\n\n`);
        expect(omitted(reply, messagePlan!)).toBe(tail);
        expect(reasonsAt(reply, messagePlan!, 'On Mon')).toEqual(['app-quoted-history']);
        expect(reasonsAt(reply, messagePlan!, 'Bob Sample\n')).toEqual(['signature']);
        expect(messagePlan!.tailStart).toBe(reply.message.bodyText.indexOf('On Mon'));
        expect(messagePlan!.keptAllBecauseEmpty).toBe(false);
        expect(messagePlan!.fallback).toBe(false);
    });

    it('Outlook-style reply (From / Sent / To / Subject): leaves out the block and the quote below it', () =>
    {
        const own = 'Hello Alice,\n\nThe delivery is booked for Friday between 9:00 and 11:00.\n\n';
        const tail = [
            '________________________________',
            'From: Alice Example <alice@example.test>',
            'Sent: Monday, March 3, 2025 9:15 AM',
            'To: Bob Sample <bob@furniture.example.test>',
            'Subject: Office furniture',
            '',
            ALICE_TEXT,
            '',
        ].join('\n');
        const all = analyze(mail({ from: ALICE, body: ALICE_TEXT }), mail({ from: BOB, body: `${own}${BOB_SIGNATURE}\n\n${tail}` }));
        const reply = byBody(all, 'delivery is booked');
        const [, messagePlan] = plan(all);
        expect(kept(reply, messagePlan!)).toBe(`${own}${BOB_SIGNATURE}\n\n`);
        expect(omitted(reply, messagePlan!)).toBe(tail);
    });

    it.each([
        ['French attribution', 'Le lun. 3 mars 2025 \u{E0} 14:02, Alice Example <alice@example.test> a \u{E9}crit :\n' + quoted(ALICE_TEXT) + '\n'],
        ['Dutch attribution', 'Op ma 3 mrt 2025 om 14:02 schreef Alice Example <alice@example.test>:\n' + quoted(ALICE_TEXT) + '\n'],
        [
            'French Outlook block',
            'De : Alice Example <alice@example.test>\nEnvoy\u{E9} : lundi 3 mars 2025 09:15\n\u{C0} : Bob Sample <bob@furniture.example.test>\nObjet : Bureau\n\n' +
                ALICE_TEXT +
                '\n',
        ],
        [
            'Dutch Outlook block',
            'Van: Alice Example <alice@example.test>\nVerzonden: maandag 3 maart 2025 09:15\nAan: Bob Sample <bob@furniture.example.test>\nOnderwerp: Bureau\n\n' +
                ALICE_TEXT +
                '\n',
        ],
    ])('%s: the quoted history is left out', (_name, tail) =>
    {
        const own = 'Bonjour Alice,\n\nVrijdag is goed, de chauffeur belt een uur vooraf.\n\n';
        const all = analyze(mail({ from: ALICE, body: ALICE_TEXT }), mail({ from: BOB, body: `${own}${tail}` }));
        const reply = byBody(all, 'chauffeur');
        const [, messagePlan] = plan(all);
        expect(kept(reply, messagePlan!)).toBe(own);
        expect(omitted(reply, messagePlan!)).toBe(tail);
    });

    it('a quote without any header, found by the overlap detector only, is left out', () =>
    {
        const own = 'Fine, Friday it is. See you then.\n\n';
        const all = analyze(mail({ from: ALICE, body: ALICE_TEXT }), mail({ from: BOB, body: `${own}${ALICE_TEXT}\n` }));
        const reply = byBody(all, 'Friday it is');
        expect(reply.segments.some((s) => s.reasons.includes('quoted-overlap'))).toBe(true);
        const [, messagePlan] = plan(all);
        expect(kept(reply, messagePlan!)).toBe(own);
    });

    it('keeps an overlap tail that repeats the SAME sender (own resend or disclaimer)', () =>
    {
        const first = 'Dear all,\n\nThe showroom is closed on Monday 10 March for the yearly inventory of all furniture.\n';
        const own = 'Reminder, see my message below.\n\n';
        const all = analyze(mail({ from: BOB, body: first }), mail({ from: BOB, body: `${own}${first}` }));
        const second = byBody(all, 'Reminder');
        expect(second.segments.some((s) => s.reasons.includes('quoted-overlap'))).toBe(true);
        const [, messagePlan] = plan(all);
        expect(kept(second, messagePlan!)).toBe(second.message.bodyText);
        expect(messagePlan!.tailStart).toBeNull();
    });

    it('an email that would be left with no text is kept whole, flagged keptAllBecauseEmpty', () =>
    {
        const body = `On Mon, 3 Mar 2025 at 14:02, Alice Example <alice@example.test> wrote:\n${quoted(ALICE_TEXT)}\n`;
        const all = analyze(mail({ from: ALICE, body: ALICE_TEXT }), mail({ from: BOB, body }));
        const [first, messagePlan] = plan(all);
        expect(first!.keptAllBecauseEmpty).toBe(false);
        expect(kept(all[1]!, messagePlan!)).toBe(body);
        expect(messagePlan!.keptAllBecauseEmpty).toBe(true);
        expect(messagePlan!.tailStart).toBe(0); // still classified
        expect(reasonsAt(all[1]!, messagePlan!, 'On Mon')).toEqual(['app-quoted-history']);
    });

    it('keptAllBecauseEmpty: a repeated signature in an email kept whole is kept too', () =>
    {
        const tail = `On Mon, 3 Mar 2025 at 14:02, Alice Example <alice@example.test> wrote:\n${quoted(ALICE_TEXT)}\n`;
        // Hand-made folds: a body that is only Bob's (repeated) signature and a quote.
        const body = `${BOB_SIGNATURE}\n\n${tail}`;
        const quoteStart = body.indexOf('On Mon');
        const folds: FoldRange[] = [
            { start: 0, end: quoteStart, reason: 'signature' },
            { start: quoteStart, end: body.length, reason: 'reply-header' },
        ];
        const first = `First note.\n\n${BOB_SIGNATURE}\n`;
        const inputs: PlanInput[] = [
            {
                message: mail({ from: BOB, body: first }),
                segments: buildSegments(first, [{ start: first.indexOf('-- '), end: first.length, reason: 'signature' }]),
                index: 0,
            },
            { message: mail({ from: BOB, body }), segments: buildSegments(body, folds), index: 1 },
        ];
        const plans = plan(inputs);
        expect(plans[1]!.keptAllBecauseEmpty).toBe(true);
        expect(plans[1]!.omittedSignatures).toBe(0);
        expect(kept(inputs[1]!, plans[1]!)).toBe(body);
        expect(reasonsAt(inputs[1]!, plans[1]!, 'Bob Sample')).toEqual(['repeated-signature']);
        // Without the rule, the same plan with policy 'keep' keeps the quote and leaves out the signature.
        const keepPlans = plan(inputs, { ...DEFAULT_OUTPUT_POLICY, appQuotedHistory: 'keep' });
        expect(keepPlans[1]!.keptAllBecauseEmpty).toBe(false);
        expect(keepPlans[1]!.omittedSignatures).toBe(1);
    });
});

describe('planOutput: quotes the writer typed on purpose', () =>
{
    it('interleaved point-by-point answers: everything is kept', () =>
    {
        const body = [
            'Hi Alice, answers below.',
            '',
            '> Could you deliver the oak desk and the four grey chairs on Friday morning?',
            '> The office is on the second floor.',
            '',
            'Yes, Friday morning is fine.',
            '',
            '> The lift is large enough for the desk.',
            '> Please check the size anyway.',
            '',
            'I checked, it fits.',
            '',
        ].join('\n');
        const all = analyze(mail({ from: ALICE, body: ALICE_TEXT }), mail({ from: BOB, body }));
        const reply = byBody(all, 'answers below');
        const [, messagePlan] = plan(all);
        expect(kept(reply, messagePlan!)).toBe(body);
        expect(reasonsAt(reply, messagePlan!, '> The lift')).toEqual(['writer-quote']);
        expect(messagePlan!.tailStart).toBeNull();
    });

    it('bottom-posting (own text below the quote): everything is kept', () =>
    {
        const body = `On Mon, 3 Mar 2025 at 14:02, Alice Example <alice@example.test> wrote:\n${quoted(ALICE_TEXT)}\n\nYes, Friday morning works for us.\n`;
        const all = analyze(mail({ from: ALICE, body: ALICE_TEXT }), mail({ from: BOB, body }));
        const reply = byBody(all, 'works for us');
        const [, messagePlan] = plan(all);
        expect(kept(reply, messagePlan!)).toBe(body);
        expect(reasonsAt(reply, messagePlan!, 'On Mon')).toEqual(['writer-quote']);
    });

    it('an overlap fold in the middle, followed by own text, is kept', () =>
    {
        const body = `Here is what Alice asked:\n\n${ALICE_TEXT}\n\nMy comment: the lift was replaced last year, so it fits.\n`;
        const all = analyze(mail({ from: ALICE, body: ALICE_TEXT }), mail({ from: CAROL, body }));
        const reply = byBody(all, 'My comment');
        expect(reply.segments.some((s) => s.reasons.includes('quoted-overlap'))).toBe(true);
        const [, messagePlan] = plan(all);
        expect(kept(reply, messagePlan!)).toBe(body);
    });
});

describe('planOutput: forwards are not quoted history', () =>
{
    const gmailForward = (content: string): string =>
        `---------- Forwarded message ---------\nFrom: Alice Example <alice@example.test>\nDate: Mon, 3 Mar 2025 at 14:02\nSubject: Office furniture\nTo: Bob Sample <bob@furniture.example.test>\n\n${content}\n`;

    it('a forward with no own text keeps the forwarded content, even when overlap folded it', () =>
    {
        const body = gmailForward(ALICE_TEXT);
        const all = analyze(mail({ from: ALICE, body: ALICE_TEXT }), mail({ from: BOB, body, subject: 'Fwd: Office furniture' }));
        const forward = byBody(all, 'Forwarded message');
        expect(forward.segments.some((s) => s.reasons.includes('quoted-overlap'))).toBe(true);
        const [, messagePlan] = plan(all);
        expect(kept(forward, messagePlan!)).toBe(body);
        expect(reasonsAt(forward, messagePlan!, 'Could you deliver')).toEqual(['forwarded']);
        expect(messagePlan!.tailStart).toBeNull();
    });

    it('a forward marker counts even when the subject is not a forward subject', () =>
    {
        const body = `Carol, see below.\n\n${gmailForward(ALICE_TEXT)}`;
        const all = analyze(mail({ from: ALICE, body: ALICE_TEXT }), mail({ from: BOB, body, subject: 'Office furniture' }));
        const forward = byBody(all, 'Carol, see below');
        const [, messagePlan] = plan(all);
        expect(kept(forward, messagePlan!)).toBe(body);
    });

    it('"-----Original Message-----" is a forward with a FW: subject, a reply with RE:', () =>
    {
        const block = `-----Original Message-----\nFrom: Alice Example <alice@example.test>\nSent: Monday, March 3, 2025 9:15 AM\nTo: Bob Sample <bob@furniture.example.test>\nSubject: Office furniture\n\n${ALICE_TEXT}\n`;
        const own = 'Carol, for your information.\n\n';
        for (const [subject, expectKept] of [
            ['FW: Office furniture', `${own}${block}`],
            ['RE: Office furniture', own],
        ] as const)
        {
            const all = analyze(mail({ from: ALICE, body: ALICE_TEXT }), mail({ from: BOB, body: `${own}${block}`, subject }));
            const [, messagePlan] = plan(all);
            expect(kept(all[1]!, messagePlan!), subject).toBe(expectKept);
        }
    });

    it('a reply above an attached email: the quote is left out, the attached email (block of the .eml reader) kept', () =>
    {
        const own = 'Hi Alice, I attach the confirmation from the warehouse.\n\n';
        const quote = `On Mon, 3 Mar 2025 at 14:02, Alice Example <alice@example.test> wrote:\n${quoted(ALICE_TEXT)}\n\n`;
        const attached = `${FORWARDED_SEPARATOR}\nFrom: Warehouse <warehouse@example.test>\nDate: Mon, 3 Mar 2025 10:00:00 +0000\nSubject: Stock\n\nThe oak desk is in stock.\n`;
        const all = analyze(mail({ from: ALICE, body: ALICE_TEXT }), mail({ from: BOB, body: `${own}${quote}${attached}` }));
        const reply = byBody(all, 'confirmation from the warehouse');
        const [, messagePlan] = plan(all);
        // The blank line after the quote is not folded, so it stays.
        expect(kept(reply, messagePlan!)).toBe(`${own}\n${attached}`);
        expect(omitted(reply, messagePlan!)).toBe(quote.slice(0, -1));
        expect(reasonsAt(reply, messagePlan!, 'The oak desk is in stock')).toEqual(['forwarded']);
    });

    it('an Outlook reply quoting a forward: the forward is part of the quoted history', () =>
    {
        const own = 'Thanks, noted.\n\n';
        const tail = `________________________________\nFrom: Alice Example <alice@example.test>\nSent: Monday, March 3, 2025 9:15 AM\nTo: Bob Sample <bob@furniture.example.test>\nSubject: FW: Stock\n\nSee below.\n\n${gmailForward('The oak desk is in stock, says the warehouse.')}`;
        const all = analyze(mail({ from: BOB, body: `${own}${tail}` }));
        const [messagePlan] = plan(all);
        expect(kept(all[0]!, messagePlan!)).toBe(own);
        expect(omitted(all[0]!, messagePlan!)).toBe(tail);
    });
});

describe('planOutput: signatures, first per sender', () =>
{
    const bobMail = (text: string, signature = BOB_SIGNATURE, minutes?: number): NormalizedMessage =>
        mail({ from: BOB, body: `${text}\n\n${signature}\n`, ...(minutes === undefined ? {} : { minutes }) });

    it('an identical signature is kept once, then left out', () =>
    {
        const all = analyze(bobMail('First note about the desk.'), bobMail('Second note about the chairs.'), bobMail('Third note.'));
        const plans = plan(all);
        expect(plans.map((p) => p.omittedSignatures)).toEqual([0, 1, 1]);
        expect(kept(all[0]!, plans[0]!)).toContain('Bob Sample');
        // The fold takes the signature's last line break with it.
        expect(kept(all[1]!, plans[1]!)).toBe('Second note about the chairs.\n\n');
        expect(reasonsAt(all[1]!, plans[1]!, 'Bob Sample')).toEqual(['repeated-signature']);
    });

    it('a changed signature is kept (once)', () =>
    {
        const newSignature = '-- \nBob Sample\nSample Furniture, new showroom address';
        const all = analyze(bobMail('First note.'), bobMail('Second note.', newSignature), bobMail('Third note.', newSignature));
        expect(plan(all).map((p) => p.omittedSignatures)).toEqual([0, 0, 1]);
    });

    it('the same signature text from another sender is independent', () =>
    {
        const signature = '-- \nSample Office\nMain Street 1';
        const all = analyze(
            mail({ from: BOB, body: `Note from Bob.\n\n${signature}\n` }),
            mail({ from: ALICE, body: `Note from Alice.\n\n${signature}\n` }),
            mail({ from: BOB, body: `Bob again.\n\n${signature}\n` }),
        );
        expect(plan(all).map((p) => p.omittedSignatures)).toEqual([0, 0, 1]);
    });

    it('excluding the first email makes the next one the first', () =>
    {
        const all = analyze(bobMail('First note.'), bobMail('Second note.'), bobMail('Third note.'));
        expect(plan(all.slice(1)).map((p) => p.omittedSignatures)).toEqual([0, 1]);
    });

    it('a signature inside a left-out tail does not count as kept', () =>
    {
        // Hand-made folds: Bob's signature quoted inside Alice's reply (overlap tail).
        const aliceBody = `Thanks Bob.\n\n${'Old note from Bob about the desk delivery on Friday morning at the office.'}\n${BOB_SIGNATURE}\n`;
        const tailStart = aliceBody.indexOf('Old note');
        const signatureStart = aliceBody.indexOf('-- ');
        const folds: FoldRange[] = [
            { start: tailStart, end: aliceBody.length, reason: 'quoted-overlap', related: 0 },
            { start: signatureStart, end: aliceBody.length, reason: 'signature' },
        ];
        const bobBody = `New note.\n\n${BOB_SIGNATURE}\n`;
        const bobFolds: FoldRange[] = [{ start: bobBody.indexOf('-- '), end: bobBody.length, reason: 'signature' }];
        const inputs: PlanInput[] = [
            { message: mail({ from: ALICE, body: 'x' }), segments: buildSegments('x', []), index: 0 },
            { message: mail({ from: BOB, body: aliceBody }), segments: buildSegments(aliceBody, folds), index: 5 },
            { message: mail({ from: BOB, body: bobBody }), segments: buildSegments(bobBody, bobFolds), index: 6 },
        ];
        // related 0 is included and has another sender (Alice), so the tail is left out.
        const plans = plan(inputs);
        expect(kept(inputs[1]!, plans[1]!)).toBe('Thanks Bob.\n\n');
        expect(plans[1]!.omittedSignatures).toBe(0);
        expect(plans[2]!.omittedSignatures).toBe(0);
        expect(kept(inputs[2]!, plans[2]!)).toBe(bobBody);
    });

    it('a signature that the overlap detector also folds is not the start of quoted history', () =>
    {
        const body = `Own text here.\n\n${BOB_SIGNATURE}\n\nOn Mon, 3 Mar 2025 at 14:02, Alice wrote:\n> line one\n> line two\n`;
        const signatureStart = body.indexOf('-- ');
        const signatureEnd = body.indexOf('\n\nOn Mon') + 1;
        const quoteStart = body.indexOf('On Mon');
        const folds: FoldRange[] = [
            { start: signatureStart, end: signatureEnd, reason: 'signature' },
            { start: signatureStart, end: signatureEnd, reason: 'quoted-overlap', related: 1 },
            { start: quoteStart, end: body.length, reason: 'reply-header' },
        ];
        const input: PlanInput = { message: mail({ from: BOB, body }), segments: buildSegments(body, folds) };
        const [messagePlan] = plan([input]);
        expect(messagePlan!.tailStart).toBe(quoteStart);
        expect(kept(input, messagePlan!)).toBe(body.slice(0, quoteStart));
    });
});

describe('planOutput: policy variants', () =>
{
    const own = 'Hi Alice,\n\nFriday works.\n\n';
    const tail = `On Mon, 3 Mar 2025 at 14:02, Alice Example <alice@example.test> wrote:\n${quoted(ALICE_TEXT)}\n`;
    const build = (): AnalyzedMessage[] =>
        analyze(
            mail({ from: ALICE, body: ALICE_TEXT }),
            mail({ from: BOB, body: `${own}${BOB_SIGNATURE}\n\n${tail}` }),
            mail({ from: BOB, body: `Second note.\n\n${BOB_SIGNATURE}\n` }),
        );

    it("appQuotedHistory 'keep': the tail stays in (still labelled)", () =>
    {
        const all = build();
        const plans = plan(all, { ...DEFAULT_OUTPUT_POLICY, appQuotedHistory: 'keep' });
        expect(kept(all[1]!, plans[1]!)).toBe(all[1]!.message.bodyText);
        expect(reasonsAt(all[1]!, plans[1]!, 'On Mon')).toEqual(['app-quoted-history']);
        expect(plans[2]!.omittedSignatures).toBe(1);
    });

    it("signatures 'all': every signature stays in (repeats still labelled)", () =>
    {
        const all = build();
        const plans = plan(all, { ...DEFAULT_OUTPUT_POLICY, signatures: 'all' });
        expect(plans.map((p) => p.omittedSignatures)).toEqual([0, 0, 0]);
        expect(reasonsAt(all[2]!, plans[2]!, 'Bob Sample')).toEqual(['repeated-signature']);
        expect(omitted(all[1]!, plans[1]!)).toBe(tail);
    });

    it("signatures 'none': every signature fold is left out", () =>
    {
        const all = build();
        const plans = plan(all, { ...DEFAULT_OUTPUT_POLICY, signatures: 'none' });
        expect(plans.map((p) => p.omittedSignatures)).toEqual([0, 1, 1]);
        expect(kept(all[1]!, plans[1]!)).toBe(`${own}\n`);
    });

    it('unfoldEverything: nothing is left out', () =>
    {
        const all = build();
        const plans = plan(all, { appQuotedHistory: 'omit', signatures: 'none', unfoldEverything: true });
        plans.forEach((messagePlan, k) =>
        {
            expect(messagePlan.ranges.every((r) => r.keep)).toBe(true);
            expect(kept(all[k]!, messagePlan)).toBe(all[k]!.message.bodyText);
        });
        expect(plans[1]!.tailStart).not.toBeNull(); // still classified
    });
});

describe('planOutput: safety', () =>
{
    it('invalid segments: the whole body is kept, flagged fallback', () =>
    {
        const body = 'Some text\n> a\n> b\n';
        const input: PlanInput = { message: mail({ from: BOB, body }), segments: [{ start: 0, end: 3, folded: true, reasons: ['quote-marker'], related: [] }] };
        const [messagePlan] = planOutput([input]);
        expect(messagePlan).toEqual({ ranges: [{ start: 0, end: body.length, keep: true, reason: 'text' }], tailStart: null, omittedSignatures: 0, keptAllBecauseEmpty: false, fallback: true });
    });

    it('an empty body gives no ranges; an empty list gives no plans', () =>
    {
        const input: PlanInput = { message: mail({ from: BOB, body: '' }), segments: [] };
        expect(planOutput([input])[0]!.ranges).toEqual([]);
        expect(planOutput([])).toEqual([]);
    });

    it('text that is not folded is never left out, whitespace inside a tail included', () =>
    {
        const body = 'Own.\n\nA1\nA2\n\nB1\nB2\n\n';
        // The tail starts at an overlap fold linked to an included email of another sender.
        const folds: FoldRange[] = [
            { start: body.indexOf('A1'), end: body.indexOf('\n\nB1') + 1, reason: 'quoted-overlap', related: 3 },
            { start: body.indexOf('B1'), end: body.length - 1, reason: 'quote-marker' },
        ];
        const input: PlanInput = { message: mail({ from: BOB, body }), segments: buildSegments(body, folds) };
        const other: PlanInput = { message: mail({ from: ALICE, body: 'x' }), segments: buildSegments('x', []), index: 3 };
        const [messagePlan] = plan([input, other]);
        expect(messagePlan!.tailStart).toBe(body.indexOf('A1'));
        expect(kept(input, messagePlan!)).toBe('Own.\n\n\n\n');
        expect(omitted(input, messagePlan!)).toBe('A1\nA2\nB1\nB2\n');
    });
});

describe('planOutput: text below an Outlook-style quote (rule 2b)', () =>
{
    const EN_BLOCK =
        'From: Alice Example <alice@example.test>\nSent: Monday, March 3, 2025 9:15 AM\nTo: Bob Sample <bob@furniture.example.test>\nSubject: Office furniture\n\n';
    const FR_BLOCK =
        'De : Alice Example <alice@example.test>\nEnvoy\u{E9} : lundi 3 mars 2025 09:15\n\u{C0} : Bob Sample <bob@furniture.example.test>\nObjet : Bureau\n\n';
    const NL_BLOCK =
        '-----Oorspronkelijk bericht-----\nVan: Alice Example <alice@example.test>\nVerzonden: maandag 3 maart 2025 09:15\nAan: Bob Sample <bob@furniture.example.test>\nOnderwerp: Bureau\n\n';
    const BELOW = 'Yes, Friday works, our driver Dan will call one hour before.\n\nBob\n';

    /** Runs the thread analysis over Alice's email and Bob's reply; plans with or without Alice's email included. */
    function run(body: string, aliceIncluded: boolean): { reply: AnalyzedMessage; messagePlan: MessagePlan }
    {
        const all = analyze(mail({ from: ALICE, body: ALICE_TEXT }), mail({ from: BOB, body }));
        const reply = all.find((m) => m.message.bodyText === body)!;
        expect(reply.segments.some((s) => s.reasons.includes('quoted-overlap'))).toBe(true);
        const included = aliceIncluded ? all : [reply];
        const plans = plan(included);
        return { reply, messagePlan: plans[included.indexOf(reply)]! };
    }

    it('P1: own text below a confirmed quote (quoted email included): everything is kept', () =>
    {
        const body = `${EN_BLOCK}${ALICE_TEXT}\n\n${BELOW}`;
        const { reply, messagePlan } = run(body, true);
        expect(kept(reply, messagePlan)).toBe(body);
        expect(messagePlan.tailStart).toBeNull();
        expect(messagePlan.keptAllBecauseEmpty).toBe(false);
        expect(reasonsAt(reply, messagePlan, 'Yes, Friday works')).toEqual(['text']);
        expect(reasonsAt(reply, messagePlan, 'From: Alice')).toEqual(['writer-quote']);
    });

    it('P1 with a greeting above: everything is kept', () =>
    {
        const body = `Hi Alice, see my answer below.\n\n${EN_BLOCK}${ALICE_TEXT}\n\n${BELOW}`;
        const { reply, messagePlan } = run(body, true);
        expect(kept(reply, messagePlan)).toBe(body);
    });

    it('P2: the quoted email NOT included: the block and all below it are left out (accepted limit)', () =>
    {
        const own = 'Hi Alice, see my answer below.\n\n';
        const body = `${own}${EN_BLOCK}${ALICE_TEXT}\n\n${BELOW}`;
        const { reply, messagePlan } = run(body, false);
        expect(kept(reply, messagePlan)).toBe(own);
        expect(messagePlan.tailStart).toBe(own.length);
    });

    it('P2 with no text above the block: rule 4 keeps the whole body', () =>
    {
        const body = `${EN_BLOCK}${ALICE_TEXT}\n\n${BELOW}`;
        const { reply, messagePlan } = run(body, false);
        expect(kept(reply, messagePlan)).toBe(body);
        expect(messagePlan.keptAllBecauseEmpty).toBe(true);
    });

    it('P3: an unconfirmed header block in own text: the block and below are left out, the line above stays', () =>
    {
        const own = 'The warehouse sent me this yesterday:\n\n';
        const body = `${own}From: Warehouse <warehouse@example.test>\nSent: Monday, March 3, 2025 9:15 AM\nTo: Bob Sample <bob@furniture.example.test>\n\nMY OWN COMMENT: the desk is late, the chairs are on time.\n\nBob\n`;
        const all = analyze(mail({ from: BOB, body }));
        const [messagePlan] = plan(all);
        expect(kept(all[0]!, messagePlan!)).toBe(own);
        expect(messagePlan!.keptAllBecauseEmpty).toBe(false);
    });

    it.each([
        ['P9 French', FR_BLOCK, 'Oui, vendredi convient, le chauffeur appellera une heure avant.\n'],
        ['P10 Dutch', NL_BLOCK, 'JA VRIJDAG is goed.\n'],
    ])('%s block: own text below is kept when the quoted email is included, left out when not', (_name, block, below) =>
    {
        const own = 'Bonjour Alice,\n\n';
        const body = `${own}${block}${ALICE_TEXT}\n\n${below}`;
        const included = run(body, true);
        expect(kept(included.reply, included.messagePlan)).toBe(body);
        expect(reasonsAt(included.reply, included.messagePlan, below.slice(0, 10))).toEqual(['text']);
        const alone = run(body, false);
        expect(kept(alone.reply, alone.messagePlan)).toBe(own);
    });

    it('a confirmed quote with nothing below it (normal top-posting): still left out', () =>
    {
        const own = 'Hi Alice,\n\nFriday works, our driver will call one hour before.\n\n';
        const body = `${own}${EN_BLOCK}${ALICE_TEXT}\n`;
        const { reply, messagePlan } = run(body, true);
        expect(kept(reply, messagePlan)).toBe(own);
        expect(messagePlan.tailStart).toBe(own.length);
    });

    it('N1: text below a confirmed quote that repeats an email NOT included is kept (it would be nowhere in the PDF)', () =>
    {
        const own = 'Hi Alice,\n\nFriday works.\n\n';
        const carol = 'Carol wrote earlier that the side door is closed on Fridays after four in the afternoon.';
        const body = `${own}${EN_BLOCK}${ALICE_TEXT}\n\n${carol}\n`;
        const all = analyze(mail({ from: CAROL, body: carol }), mail({ from: ALICE, body: ALICE_TEXT }), mail({ from: BOB, body }));
        const reply = all.find((m) => m.message.bodyText === body)!;
        const carolAt = body.indexOf('Carol wrote');
        expect(reply.segments.find((s) => s.start <= carolAt && carolAt < s.end)!.reasons).toContain('quoted-overlap');
        const included = all.filter((m) => m.message.from[0] !== CAROL);
        const messagePlan = plan(included)[included.indexOf(reply)]!;
        expect(kept(reply, messagePlan)).toBe(body);
        expect(messagePlan.keptAllBecauseEmpty).toBe(false);
        expect(reasonsAt(reply, messagePlan, 'Carol wrote')).toEqual(['text']);
        // A4: the same with the writer's own earlier email (not included) and an own line above it.
        const bobOld = 'All deliveries are made between eight and noon, and the driver needs a free parking place in front of the building.';
        const body2 = `${own}${EN_BLOCK}${ALICE_TEXT}\n\nAbout parking:\n${bobOld}\n`;
        const all2 = analyze(mail({ from: BOB, body: bobOld }), mail({ from: ALICE, body: ALICE_TEXT }), mail({ from: BOB, body: body2 }));
        const reply2 = all2.find((m) => m.message.bodyText === body2)!;
        const included2 = all2.filter((m) => m.message.bodyText !== bobOld);
        expect(kept(reply2, plan(included2)[included2.indexOf(reply2)]!)).toBe(body2);
    });

    it('nested history (the quoted email has its own quote, as mail apps write it): left out, whether its source is included or not', () =>
    {
        const own = 'Hi Alice,\n\nFriday works.\n\n';
        const carol = 'The side door of the building is closed on Fridays after four in the afternoon, please use the front.';
        const nested = `-----Original Message-----\nFrom: Carol Test <carol@sample.test>\nSent: Friday, February 28, 2025 4:00 PM\nTo: Alice Example <alice@example.test>\nSubject: Door\n\n${carol}\n`;
        const aliceBody = `${ALICE_TEXT}\n\n${nested}`;
        const body = `${own}${EN_BLOCK}${aliceBody}`;
        const all = analyze(mail({ from: CAROL, body: carol }), mail({ from: ALICE, body: aliceBody }), mail({ from: BOB, body }));
        const reply = all.find((m) => m.message.bodyText === body)!;
        for (const included of [all, all.filter((m) => m.message.from[0] !== CAROL)])
        {
            const messagePlan = plan(included)[included.indexOf(reply)]!;
            expect(kept(reply, messagePlan)).toBe(own);
            expect(messagePlan.tailStart).toBe(own.length);
        }
    });

    it('S1: a line between the confirmed quote and a later ">" block is own text: everything is kept', () =>
    {
        const own = 'Hi Alice,\n\nFriday works.\n\n';
        const body = `${own}${EN_BLOCK}${ALICE_TEXT}\n\nSent from my phone\n\n> older line about the invoice\n> another older line\n`;
        const { reply, messagePlan } = run(body, true);
        expect(kept(reply, messagePlan)).toBe(body);
        expect(reasonsAt(reply, messagePlan, 'Sent from my phone')).toEqual(['text']);
    });

    it('a ">" block right after the confirmed quote is covered: left out with it', () =>
    {
        const own = 'Hi Alice,\n\nFriday works.\n\n';
        const body = `${own}${EN_BLOCK}${ALICE_TEXT}\n\n> older line about the invoice\n> another older line\n`;
        const { reply, messagePlan } = run(body, true);
        expect(reply.segments.some((s) => s.reasons.includes('quote-marker'))).toBe(true);
        expect(kept(reply, messagePlan)).toBe(own);
    });

    it('S1: a line typed in the MIDDLE of a confirmed quote is own text: everything is kept', () =>
    {
        const own = 'Hi Alice,\n\nFriday works.\n\n';
        const parts = ALICE_TEXT.split('\n');
        const withGap = [...parts.slice(0, 3), '(noted)', ...parts.slice(3)].join('\n');
        const body = `${own}${EN_BLOCK}${withGap}\n`;
        const { reply, messagePlan } = run(body, true);
        const gap = body.indexOf('(noted)');
        const gapSegment = reply.segments.find((s) => s.start <= gap && gap < s.end)!;
        expect(gapSegment.reasons).toEqual(['reply-header']); // only the region fold: an uncovered gap
        expect(kept(reply, messagePlan)).toBe(body);
        expect(reasonsAt(reply, messagePlan, '(noted)')).toEqual(['text']);
    });

    it('S1: a line with no letter or digit after the quote proves nothing: left out with it', () =>
    {
        const own = 'Hi Alice,\n\nFriday works.\n\n';
        const body = `${own}${EN_BLOCK}${ALICE_TEXT}\n\n* * * ---\n`;
        const { reply, messagePlan } = run(body, true);
        const offset = body.indexOf('* * *');
        expect(reply.segments.find((s) => s.start <= offset && offset < s.end)!.reasons).toEqual(['reply-header']);
        expect(kept(reply, messagePlan)).toBe(own);
    });
});

describe('planOutput: rule 2b, review round 3', () =>
{
    const EN_BLOCK =
        'From: Alice Example <alice@example.test>\nSent: Monday, March 3, 2025 9:15 AM\nTo: Bob Sample <bob@furniture.example.test>\nSubject: Office furniture\n\n';
    const ANSWER = 'Yes, Friday works, our driver will call you one hour before.';
    const SIGNATURE =
        'Kind regards,\nBob Sample\nSample Furniture (fictional company)\nShowroom: 12 Example Street, Testville\nPhone +00 000 000 000';
    const DISCLAIMER = 'This message is confidential and intended only for the addressee. If you received it by mistake please delete it and tell the sender.';
    const DASH_SIGNATURE = '-- \nBob Sample\nSample Furniture (fictional company)\nPhone +00 000 000 000';

    /** Bob's first email (with `closing`), Alice's email, Bob's Outlook-style reply `body`: all included. */
    function threeMails(closing: string, body: string): { reply: AnalyzedMessage; messagePlan: MessagePlan }
    {
        const first = mail({ from: BOB, body: `Hello Alice, about the desks for your office.\n\n${closing}\n` });
        const all = analyze(first, mail({ from: ALICE, body: ALICE_TEXT }), mail({ from: BOB, body }));
        const reply = all.find((m) => m.message.bodyText === body)!;
        return { reply, messagePlan: plan(all)[all.indexOf(reply)]! };
    }

    it.each([
        ['T1: a repeated signature', SIGNATURE, true],
        ['T3: a repeated disclaimer', `Bob\n\n${DISCLAIMER}`, true],
        ['T2: a repeated "-- " signature', DASH_SIGNATURE, false],
    ])('B1, %s after the own answer below the quote: everything is kept', (_name, closing, linkedToOwnMail) =>
    {
        const body = `Hi Alice,\n\n${EN_BLOCK}${ALICE_TEXT}\n\n${ANSWER}\n\n${closing}\n`;
        const { reply, messagePlan } = threeMails(closing, body);
        // The closing is folded as a quote of Bob's OWN first email (input position 0).
        const closingAt = body.lastIndexOf(closing.slice(0, 12));
        const closingSegment = reply.segments.find((s) => s.start <= closingAt + 20 && closingAt + 20 < s.end)!;
        if (linkedToOwnMail)
        {
            expect(closingSegment.related).toEqual([0]);
        }
        expect(kept(reply, messagePlan)).toBe(body);
        expect(messagePlan.tailStart).toBeNull();
        expect(messagePlan.keptAllBecauseEmpty).toBe(false);
        expect(reasonsAt(reply, messagePlan, ANSWER)).toEqual(['text']);
    });

    it('B1, T4: the same with nothing above the header: kept by rule 2b, not by rule 4', () =>
    {
        const closing = `Bob\n\n${DISCLAIMER}`;
        const body = `${EN_BLOCK}${ALICE_TEXT}\n\n${ANSWER}\n\n${closing}\n`;
        const { reply, messagePlan } = threeMails(closing, body);
        expect(kept(reply, messagePlan)).toBe(body);
        expect(messagePlan.keptAllBecauseEmpty).toBe(false);
        expect(messagePlan.tailStart).toBeNull();
    });

    it('A3: an answer typed between two quoted paragraphs of an Outlook-style quote is kept', () =>
    {
        const alice = [
            'Hi Bob,',
            '',
            'Could you deliver the oak desk and the four grey chairs on Friday morning before ten?',
            '',
            'The office is on the second floor and the lift is large enough for the desk and the chairs.',
            '',
            'Thanks,',
            'Alice',
        ];
        const answer = 'Yes, at nine, the driver is booked.';
        const body = `See my answers below.\n\n${EN_BLOCK}${[...alice.slice(0, 3), answer, ...alice.slice(3)].join('\n')}\n`;
        const all = analyze(mail({ from: ALICE, body: alice.join('\n') }), mail({ from: BOB, body }));
        const reply = byBody(all, answer);
        const [, messagePlan] = plan(all);
        expect(kept(reply, messagePlan!)).toBe(body);
        expect(reasonsAt(reply, messagePlan!, answer)).toEqual(['text']);
        expect(messagePlan!.keptAllBecauseEmpty).toBe(false);
    });

    const CAROL_NOTE = 'Please note the showroom is closed on Monday 10 March for the yearly inventory of all furniture items.';

    it.each([
        ['A5: an own line, then a sentence of Carol', `Friday is fine, but note what Carol wrote:\n${CAROL_NOTE}\n`],
        ['S2: only a sentence of Carol (not the quoted email)', `${CAROL_NOTE}\n`],
    ])('%s below the quote (Carol included): everything is kept', (_name, below) =>
    {
        const body = `Hi Alice,\n\n${EN_BLOCK}${ALICE_TEXT}\n\n${below}`;
        const all = analyze(mail({ from: CAROL, body: CAROL_NOTE }), mail({ from: ALICE, body: ALICE_TEXT }), mail({ from: BOB, body }));
        const reply = all.find((m) => m.message.bodyText === body)!;
        const offset = body.indexOf('showroom is closed');
        expect(reply.segments.find((s) => s.start <= offset && offset < s.end)!.related).toEqual([0]); // linked to Carol only
        const messagePlan = plan(all)[all.indexOf(reply)]!;
        expect(kept(reply, messagePlan)).toBe(body);
        expect(messagePlan.keptAllBecauseEmpty).toBe(false);
    });

    it('A9: an own line, then a ">" quote of another email of Alice: everything is kept', () =>
    {
        const alice2 =
            'Hi Bob,\n\nThe chairs must be the grey model with armrests and the wheels for carpet floors.\nPlease also bring the assembly tools because our staff has none at the office.\n\nAlice';
        const body = `Hi Alice,\n\n${EN_BLOCK}${ALICE_TEXT}\n\nAnd about your other mail:\n${quoted(alice2)}\n`;
        const all = analyze(mail({ from: ALICE, body: ALICE_TEXT }), mail({ from: ALICE, body: alice2 }), mail({ from: BOB, body }));
        const reply = all.find((m) => m.message.bodyText === body)!;
        const messagePlan = plan(all)[all.indexOf(reply)]!;
        expect(kept(reply, messagePlan)).toBe(body);
        expect(messagePlan.keptAllBecauseEmpty).toBe(false);
    });

    // ---- hand-made segments: the reply-header detector's folds plus chosen overlap / signature folds

    const OWN = 'Hi Alice,\n\nFriday works.\n\n';
    const other = (from: EmailAddress, index: number, body = 'x', folds: FoldRange[] = []): PlanInput => ({
        message: mail({ from, body }),
        segments: buildSegments(body, folds),
        index,
    });
    /** A fold over the first occurrence of `snippet` (from its start to its end). */
    function over(body: string, snippet: string, reason: FoldRange['reason'], related?: number): FoldRange
    {
        const start = body.indexOf(snippet);
        if (start < 0)
        {
            throw new Error(`snippet not found: ${snippet}`);
        }
        return related === undefined ? { start, end: start + snippet.length, reason } : { start, end: start + snippet.length, reason, related };
    }
    /** Bob's reply `body` at input position 9 (the detector's reply-header folds plus `extra`), planned after `others`. */
    function handPlan(body: string, extra: readonly FoldRange[], others: readonly PlanInput[]): { input: PlanInput; messagePlan: MessagePlan }
    {
        const input: PlanInput = { message: mail({ from: BOB, body }), segments: buildSegments(body, [...detectReplyHeaders(body), ...extra]), index: 9 };
        const plans = plan([...others, input]);
        return { input, messagePlan: plans[plans.length - 1]! };
    }

    const PARA_A = 'Could you deliver the oak desk and the four grey chairs on Friday morning?\n';
    const PARA_B = 'Our standard delivery hours are from eight to noon on every weekday.\n';
    const PARA_C = 'The side door of the building is closed on Fridays after four in the afternoon.\n';
    const PARA_D = 'The parking place in front of the building is reserved for deliveries.\n';
    const nestedHeader = (name: string): string =>
        `-----Original Message-----\nFrom: ${name} <someone@sample.test>\nSent: Friday, February 28, 2025 4:00 PM\nTo: Alice Example <alice@example.test>\nSubject: Door\n\n`;

    it("B1: the writer's own earlier email does not decide which email is quoted", () =>
    {
        const body = `${OWN}${EN_BLOCK}${PARA_B}\n${PARA_A}`;
        // PARA_B: quoted from Bob's own email (position 3); PARA_A: from Alice's (position 0).
        const folds = [over(body, PARA_B, 'quoted-overlap', 3), over(body, PARA_A, 'quoted-overlap', 0)];
        const { input, messagePlan } = handPlan(body, folds, [other(ALICE, 0), other(BOB, 3)]);
        expect(kept(input, messagePlan)).toBe(OWN);
    });

    it('a whitespace-only overlap piece does not confirm the quote', () =>
    {
        const body = `${OWN}${EN_BLOCK}\n\n${PARA_A}`;
        // Only the blank lines are "quoted" from Alice: the quote is not confirmed, so PARA_A is not own text.
        const blankStart = body.indexOf('Subject: Office furniture\n') + 'Subject: Office furniture\n'.length;
        const folds: FoldRange[] = [{ start: blankStart, end: body.indexOf(PARA_A), reason: 'quoted-overlap', related: 0 }];
        const { input, messagePlan } = handPlan(body, folds, [other(ALICE, 0)]);
        expect(kept(input, messagePlan)).toBe(OWN);
    });

    it('a signature after the quote is not own text', () =>
    {
        const body = `${OWN}${EN_BLOCK}${PARA_A}\n${BOB_SIGNATURE}\n`;
        const folds = [over(body, PARA_A, 'quoted-overlap', 0), over(body, `${BOB_SIGNATURE}\n`, 'signature')];
        const { input, messagePlan } = handPlan(body, folds, [other(ALICE, 0)]);
        expect(kept(input, messagePlan)).toBe(OWN);
        // Control: without the signature fold, those lines are own text.
        const bare = handPlan(body, folds.slice(0, 1), [other(ALICE, 0)]);
        expect(kept(bare.input, bare.messagePlan)).toBe(body);
    });

    it('a marked header that runs to the end is not rule 2b (its lines start the tail)', () =>
    {
        const block = `> From: Alice Example <alice@example.test>\n> Sent: Monday, March 3, 2025 9:15 AM\n> To: Bob Sample <bob@furniture.example.test>\n> Subject: Office furniture\n>\n> ${PARA_A}> one more quoted line here\n`;
        const body = `${OWN}${block}`;
        const headers = detectReplyHeaders(body);
        expect(headers.map((h) => [h.start, h.end])).toEqual([[OWN.length, body.length]]);
        // No quote-marker fold here, so the last line is covered by the region fold only.
        const { input, messagePlan } = handPlan(body, [over(body, `> ${PARA_A}`, 'quoted-overlap', 0)], [other(ALICE, 0)]);
        expect(kept(input, messagePlan)).toBe(OWN);
    });

    it("S2: the quoted email's own quoted chain (transitive, included emails only) is covered", () =>
    {
        // Alice (0) quotes Carol (1), Carol quotes Dave (2).
        const body = `${OWN}${EN_BLOCK}${PARA_A}\n${nestedHeader('Carol Test')}${PARA_C}\n${nestedHeader('Dave Old')}${PARA_D}`;
        const folds = [over(body, PARA_A, 'quoted-overlap', 0), over(body, PARA_C, 'quoted-overlap', 1), over(body, PARA_D, 'quoted-overlap', 2)];
        const alice = other(ALICE, 0, PARA_C, [{ start: 0, end: PARA_C.length, reason: 'quoted-overlap', related: 1 }]);
        const carol = other(CAROL, 1, PARA_D, [{ start: 0, end: PARA_D.length, reason: 'quoted-overlap', related: 2 }]);
        const dave = other({ name: 'Dave Old', address: 'dave@sample.test' }, 2);
        const chained = handPlan(body, folds, [alice, carol, dave]);
        expect(kept(chained.input, chained.messagePlan)).toBe(OWN);
        // Alice quotes nobody: Carol's and Dave's lines are linked to other emails only -> own text, kept.
        const unchained = handPlan(body, folds, [other(ALICE, 0), carol, dave]);
        expect(kept(unchained.input, unchained.messagePlan)).toBe(body);
        // Carol not included: the chain stops at Alice, Dave's lines are not covered -> kept.
        const broken = handPlan(body, folds, [alice, dave]);
        expect(kept(broken.input, broken.messagePlan)).toBe(body);
        // Without the nested header lines being covered, they would count as own text: check they are found.
        const nestedAt = body.indexOf('-----Original');
        expect(detectReplyHeaders(body).some((h) => h.start === nestedAt)).toBe(true);
    });

    it('S2: the chain only follows quote links to INCLUDED emails, and only quote links', () =>
    {
        const body = `${OWN}${EN_BLOCK}${PARA_A}\n${nestedHeader('Carol Test')}${PARA_C}`;
        const folds = [over(body, PARA_A, 'quoted-overlap', 0), over(body, PARA_C, 'quoted-overlap', 1)];
        const link = (reason: FoldRange['reason']): PlanInput => other(ALICE, 0, PARA_C, [{ start: 0, end: PARA_C.length, reason, related: 1 }]);
        // Alice quotes Carol, Carol included: covered.
        const included = handPlan(body, folds, [link('quoted-overlap'), other(CAROL, 1)]);
        expect(kept(included.input, included.messagePlan)).toBe(OWN);
        // Carol not included: her lines would be nowhere in the PDF -> own text, kept (N1).
        const notIncluded = handPlan(body, folds, [link('quoted-overlap')]);
        expect(kept(notIncluded.input, notIncluded.messagePlan)).toBe(body);
        // A link on a fold that is not a quote (here a signature) is not a quote link.
        const notAQuote = handPlan(body, folds, [link('signature'), other(CAROL, 1)]);
        expect(kept(notAQuote.input, notAQuote.messagePlan)).toBe(body);
    });

    it("S2: the quoted email is the first piece's link of ANOTHER sender, not the writer's own email linked with it", () =>
    {
        const body = `${OWN}${EN_BLOCK}${PARA_A}\n${PARA_B}`;
        // PARA_A is in Alice's (0) and in Bob's own (3) email; PARA_B only in Bob's.
        const folds = [over(body, PARA_A, 'quoted-overlap', 0), over(body, PARA_A, 'quoted-overlap', 3), over(body, PARA_B, 'quoted-overlap', 3)];
        const { input, messagePlan } = handPlan(body, folds, [other(ALICE, 0), other(BOB, 3)]);
        expect(kept(input, messagePlan)).toBe(body);
    });

    it('a nested header with nothing quoted below it: its lines are covered', () =>
    {
        const body = `${OWN}${EN_BLOCK}${PARA_A}\n${nestedHeader('Carol Test')}`;
        const { input, messagePlan } = handPlan(body, [over(body, PARA_A, 'quoted-overlap', 0)], [other(ALICE, 0)]);
        expect(kept(input, messagePlan)).toBe(OWN);
    });

    it('quotedChain: follows links transitively, only through included emails, and stops on cycles', () =>
    {
        const links = new Map<number, number[]>([
            [0, [1, 7]],
            [1, [2, 0]],
            [2, [1]],
            [7, [8]],
        ]);
        const included = new Set([0, 1, 2, 8]);
        const context: QuoteContext = {
            isIncluded: (i) => included.has(i),
            sameSender: () => false,
            quotedLinks: (i) => (included.has(i) ? (links.get(i) ?? []) : []),
            wordLinesOf: () => [],
            linePlaces: () => [],
        };
        const sorted = (s: ReadonlySet<number>): number[] => [...s].sort((a, b) => a - b);
        expect(sorted(quotedChain([0], context))).toEqual([0, 1, 2]); // 7 is not included, so 8 is not reached
        expect(sorted(quotedChain([7, 2], context))).toEqual([0, 1, 2]); // a start that is not included (7) is dropped
        expect(quotedChain([], context).size).toBe(0);
    });

    it('Mr: a signature also folded as a quote of an included email of another sender is not the start of the tail', () =>
    {
        const body = `Own text here.\n\n${BOB_SIGNATURE}\n`;
        const signature = over(body, `${BOB_SIGNATURE}\n`, 'signature');
        const input: PlanInput = { message: mail({ from: BOB, body }), segments: buildSegments(body, [signature, { ...signature, reason: 'quoted-overlap', related: 1 }]), index: 2 };
        const [, messagePlan] = plan([other(CAROL, 1), input]);
        expect(messagePlan!.tailStart).toBeNull();
        expect(kept(input, messagePlan!)).toBe(body);
        expect(reasonsAt(input, messagePlan!, 'Bob Sample')).toEqual(['signature']);
    });

    describe('review round 4: text before the first confirming piece, emoji and digits', () =>
    {
        /** Alice's email `aliceBody` and Bob's reply `body`, through the thread analysis, both included. */
        function pair(aliceBody: string, body: string): { reply: AnalyzedMessage; messagePlan: MessagePlan }
        {
            const all = analyze(mail({ from: ALICE, body: aliceBody }), mail({ from: BOB, body }));
            const reply = all.find((m) => m.message.bodyText === body)!;
            return { reply, messagePlan: plan(all)[all.indexOf(reply)]! };
        }
        /** The fold reasons of Bob's segment at `snippet`. */
        const reasonsOfSegment = (reply: AnalyzedMessage, snippet: string): readonly string[] =>
        {
            const offset = reply.message.bodyText.indexOf(snippet);
            return reply.segments.find((s) => s.start <= offset && offset < s.end)!.reasons;
        };
        // Alice's email opens with lines too short for the overlap detector.
        const ALICE_SHORT_OPENING = 'Hi Bob,\n\nFriday ok?\n\nThe office is on the second floor and the lift is large enough for the desk and the chairs we ordered.\n\nThanks,\nAlice';
        const LONG = 'The office is on the second floor and the lift is large enough for the desk and the chairs we ordered.';

        it.each([
            ['R3: an emoji', '\u{1F44D}'],
            ['M17: only digits', '10:30'],
        ])('%s as the only answer below a confirmed quote: everything is kept', (_name, answer) =>
        {
            const body = `Hi Alice,\n\n${EN_BLOCK}${ALICE_TEXT}\n\n${answer}\n`;
            const { reply, messagePlan } = pair(ALICE_TEXT, body);
            expect(reasonsOfSegment(reply, answer)).toEqual(['reply-header']);
            expect(kept(reply, messagePlan)).toBe(body);
            expect(messagePlan.keptAllBecauseEmpty).toBe(false);
            expect(reasonsAt(reply, messagePlan, answer)).toEqual(['text']);
        });

        it('R4: an answer typed right under a short quoted question, before the first confirming piece, is kept', () =>
        {
            const answer = 'Yes, Friday at nine.';
            const body = `See below.\n\n${EN_BLOCK}Hi Bob,\n\nFriday ok?\n${answer}\n\n${LONG}\n\nThanks,\nAlice\n`;
            const { reply, messagePlan } = pair(ALICE_SHORT_OPENING, body);
            // The opening and the answer are folded by the header region only (too short to match).
            expect(reasonsOfSegment(reply, answer)).toEqual(['reply-header']);
            expect(reasonsOfSegment(reply, LONG)).toContain('quoted-overlap');
            expect(kept(reply, messagePlan)).toBe(body);
            expect(messagePlan.tailStart).toBeNull();
            expect(reasonsAt(reply, messagePlan, answer)).toEqual(['text']);
        });

        it('R5: a line typed straight under the header lines, above the quoted text, is kept', () =>
        {
            const line = 'My answers are marked with BOB.';
            const body = `See below.\n\n${EN_BLOCK}${line}\n\n${ALICE_TEXT}\n`;
            const { reply, messagePlan } = pair(ALICE_TEXT, body);
            expect(reasonsOfSegment(reply, line)).toEqual(['reply-header']);
            expect(kept(reply, messagePlan)).toBe(body);
            expect(reasonsAt(reply, messagePlan, line)).toEqual(['text']);
        });

        it('R10: a second answer after the first confirming piece is still found', () =>
        {
            const body = `See below.\n\n${EN_BLOCK}Hi Bob,\n\nFriday ok?\nYes.\n\n${LONG}\nGreat, no stairs then.\n\nThanks,\nAlice\n`;
            const { reply, messagePlan } = pair(ALICE_SHORT_OPENING, body);
            expect(kept(reply, messagePlan)).toBe(body);
            expect(reasonsAt(reply, messagePlan, 'Great, no stairs')).toEqual(['text']);
        });

        it('top-posting over a quoted email that opens with a short greeting and question: the quote is still left out', () =>
        {
            const own = 'Hi Alice,\n\nFriday at nine works.\n\n';
            const body = `${own}${EN_BLOCK}${ALICE_SHORT_OPENING}\n`;
            const { reply, messagePlan } = pair(ALICE_SHORT_OPENING, body);
            expect(kept(reply, messagePlan)).toBe(own);
            expect(messagePlan.tailStart).toBe(own.length);
        });

        it("top-posting, the quoted email's own short opening cut off by a nested header the mail app rewrote: still left out", () =>
        {
            const bobOld = 'Hello Alice,\n\nAll deliveries are made between eight and noon, and the driver needs a free parking place in front of the building.\n\nBob';
            const bobHeader = (sent: string): string =>
                `From: Bob Sample <bob@furniture.example.test>\nSent: ${sent}\nTo: Alice Example <alice@example.test>\nSubject: Office furniture\n\n`;
            const aliceBody = `Hi Bob,\n\nFriday ok?\n\n${bobHeader('Monday, March 3, 2025 9:15 AM')}${bobOld}`;
            const own = 'Yes, see you then.\n\n';
            const body = `${own}${EN_BLOCK}Hi Bob,\n\nFriday ok?\n\n${bobHeader('3 March 2025 09:15')}${bobOld}\n`;
            for (const withBobOld of [true, false])
            {
                const all = analyze(mail({ from: BOB, body: bobOld }), mail({ from: ALICE, body: aliceBody }), mail({ from: BOB, body }));
                const reply = all.find((m) => m.message.bodyText === body)!;
                // The opening is not matched by the overlap detector: only the line check covers it.
                expect(reasonsOfSegment(reply, 'Friday ok?')).toEqual(['reply-header']);
                const included = withBobOld ? all : all.filter((m) => m.message.bodyText !== bobOld);
                const messagePlan = plan(included)[included.indexOf(reply)]!;
                expect(kept(reply, messagePlan), `Bob's old email included: ${withBobOld}`).toBe(own);
            }
        });

        it('the line check: covered only when every line occurs, as a whole line, in an email of the quoted chain', () =>
        {
            const opening = 'Hi  Bob,\n\n\u{A0}Friday ok?  \n';
            const body = `${OWN}${EN_BLOCK}${opening}\n${PARA_A}`;
            const folds = [over(body, PARA_A, 'quoted-overlap', 0)];
            // Alice (0) has both lines (spaces aside): covered, the quote is left out.
            const covered = handPlan(body, folds, [other(ALICE, 0, `Hi Bob,\nFriday ok?\n${PARA_A}`)]);
            expect(kept(covered.input, covered.messagePlan)).toBe(OWN);
            // Only one of the lines in Alice's email: the other one is own text, everything is kept.
            const half = handPlan(body, folds, [other(ALICE, 0, `Hi Bob,\n${PARA_A}`)]);
            expect(kept(half.input, half.messagePlan)).toBe(body);
            // A line inside a longer line of Alice's email does not count.
            const part = handPlan(body, folds, [other(ALICE, 0, `Hi Bob,\nFriday ok? Or Monday?\n${PARA_A}`)]);
            expect(kept(part.input, part.messagePlan)).toBe(body);
            // The lines are in an included email that is NOT in the quoted chain (Carol, 1): own text, kept.
            const elsewhere = handPlan(body, folds, [other(ALICE, 0, PARA_A), other(CAROL, 1, 'Hi Bob,\nFriday ok?\n')]);
            expect(kept(elsewhere.input, elsewhere.messagePlan)).toBe(body);
            // In an email of the chain that Alice quotes (Carol, 1): covered.
            const aliceQuotesCarol = other(ALICE, 0, PARA_A, [{ start: 0, end: PARA_A.length, reason: 'quoted-overlap', related: 1 }]);
            const chained = handPlan(body, folds, [aliceQuotesCarol, other(CAROL, 1, 'Hi Bob,\nFriday ok?\n')]);
            expect(kept(chained.input, chained.messagePlan)).toBe(OWN);
        });

        it('after the first confirming piece, only overlap counts: a short quoted line it did not match keeps the email (when unsure, keep)', () =>
        {
            const body = `${OWN}${EN_BLOCK}${PARA_A}\nThanks,\nAlice\n`;
            const { input, messagePlan } = handPlan(body, [over(body, PARA_A, 'quoted-overlap', 0)], [other(ALICE, 0, `${PARA_A}\nThanks,\nAlice`)]);
            expect(kept(input, messagePlan)).toBe(body);
        });

        it('M18: an overlap piece ABOVE the header does not decide which email is quoted', () =>
        {
            const top = `Hi Alice,\n\n${PARA_C}My own line about it.\n\n`;
            const body = `${top}${EN_BLOCK}${PARA_A}`;
            // PARA_C above the header: quoted from Carol (1); the quote below: Alice (0).
            const folds = [over(body, PARA_C, 'quoted-overlap', 1), over(body, PARA_A, 'quoted-overlap', 0)];
            const { input, messagePlan } = handPlan(body, folds, [other(ALICE, 0), other(CAROL, 1)]);
            expect(kept(input, messagePlan)).toBe(top);
        });

        it('M20: an Outlook-style reply followed by an attached email: the quote is left out, the attached email kept', () =>
        {
            const own = 'Hi Alice, see the warehouse note.\n\n';
            const attached = `${FORWARDED_SEPARATOR}\nFrom: Warehouse <warehouse@example.test>\nDate: Mon, 3 Mar 2025 10:00:00 +0000\nSubject: Stock\n\nThe oak desk is in stock and ready to ship.\n`;
            const body = `${own}${EN_BLOCK}${ALICE_TEXT}\n\n${attached}`;
            const { reply, messagePlan } = pair(ALICE_TEXT, body);
            expect(kept(reply, messagePlan)).toBe(`${own}${attached}`);
            expect(reasonsAt(reply, messagePlan, 'The oak desk is in stock')).toEqual(['forwarded']);
        });

        it('normalizeLine: NFC, runs of white space as one space, trimmed', () =>
        {
            expect(normalizeLine(' \u{A0}Friday\t\u{A0} ok?  ')).toBe('Friday ok?');
            expect(normalizeLine('Caf\u{65}\u{301}')).toBe('Caf\u{E9}');
        });

        it('wordLines: the lines with a letter, a digit or an emoji, normalized, in order', () =>
        {
            expect(wordLines('Hi  Bob,\r\n\n--\n* * *\n10:30\r\u{1F44D}\nThanks,')).toEqual(['Hi Bob,', '10:30', '\u{1F44D}', 'Thanks,']);
            expect(wordLines('')).toEqual([]);
        });

        describe('the line check is positional (review round 4, S1)', () =>
        {
            // A short generic answer typed inside the quoted opening must stay own
            // text even when the same line stands somewhere else in the chain.
            // "See below." above the header is kept anyway, so rule 4 cannot rescue the answer.
            it.each([
                [
                    'G2: "Yes." under the quoted question, Alice has a "Yes." line further down',
                    `Hi Bob,\n\nFriday ok?\n\n${LONG}\nYes.\n\nThanks,\nAlice`,
                    `See below.\n\n${EN_BLOCK}Hi Bob,\n\nFriday ok?\nYes.\n\n${LONG}\nYes.\n\nThanks,\nAlice\n`,
                    'Friday ok?\nYes.',
                ],
                [
                    'G3: "Thanks!" under the greeting, Alice closes with "Thanks!"',
                    `Hi Bob,\n\nFriday ok?\n\n${LONG}\n\nThanks!\nAlice`,
                    `See below.\n\n${EN_BLOCK}Hi Bob,\nThanks!\n\nFriday ok?\n\n${LONG}\n\nThanks!\nAlice\n`,
                    'Hi Bob,\nThanks!',
                ],
                [
                    'G4: "Thanks," straight under the header lines, Alice closes with "Thanks,"',
                    ALICE_TEXT,
                    `See below.\n\n${EN_BLOCK}Thanks,\n\n${ALICE_TEXT}\n`,
                    'Thanks,', // its first occurrence: the line under the header
                ],
                ['G5 (control): "Yes." with no such line in the chain', ALICE_SHORT_OPENING, `See below.\n\n${EN_BLOCK}Hi Bob,\n\nFriday ok?\nYes.\n\n${LONG}\n\nThanks,\nAlice\n`, 'Friday ok?\nYes.'],
            ])('%s: everything is kept', (_name, aliceBody, body, snippet) =>
            {
                const { reply, messagePlan } = pair(aliceBody, body);
                expect(reply.segments.some((s) => s.reasons.includes('quoted-overlap'))).toBe(true); // confirmed
                expect(kept(reply, messagePlan)).toBe(body);
                expect(messagePlan.tailStart).toBeNull();
                expect(messagePlan.keptAllBecauseEmpty).toBe(false);
                expect(reasonsAt(reply, messagePlan, snippet)).toEqual(['text']);
            });

            it('G8: a date answer under the quoted question, the same line in an email the quoted email quotes: kept', () =>
            {
                const note = 'Monday 10 March\n\nThe showroom is closed that day for the yearly inventory of all furniture items in stock.';
                const carolHeader = 'From: Carol Test <carol@sample.test>\nSent: Monday, March 3, 2025 8:00 AM\nTo: Alice Example <alice@example.test>\nSubject: Notice\n\n';
                const aliceBody = `Hi Bob,\n\nWhich day?\n\n${LONG}\n\nThanks,\nAlice\n\n${carolHeader}${note}`;
                const body = `See below.\n\n${EN_BLOCK}Hi Bob,\n\nWhich day?\nMonday 10 March\n\n${LONG}\n\nThanks,\nAlice\n\n${carolHeader}${note}\n`;
                const all = analyze(mail({ from: CAROL, body: note, subject: 'Notice' }), mail({ from: ALICE, body: aliceBody }),
                    mail({ from: BOB, body }));
                const reply = all.find((m) => m.message.bodyText === body)!;
                const messagePlan = plan(all)[all.indexOf(reply)]!;
                expect(kept(reply, messagePlan)).toBe(body);
                expect(reasonsAt(reply, messagePlan, 'Which day?\nMonday 10 March')).toEqual(['text']);
            });

            it('a multi-line opening: covered only as consecutive word lines of ONE chain email, its first ones at the top', () =>
            {
                const opening = 'Hi Bob,\n\nFriday ok?\nSee you.\n';
                const body = `${OWN}${EN_BLOCK}${opening}\n${PARA_A}`;
                const folds = [over(body, PARA_A, 'quoted-overlap', 0)];
                // Alice's first word lines, in order (blank lines aside): covered, the quote is left out.
                const consecutive = handPlan(body, folds, [other(ALICE, 0, `Hi Bob,\n\nFriday ok?\n\nSee you.\n${PARA_A}`)]);
                expect(kept(consecutive.input, consecutive.messagePlan)).toBe(OWN);
                // The same lines with another word line between them: own text, everything is kept.
                const gap = handPlan(body, folds, [other(ALICE, 0, `Hi Bob,\nFriday ok?\nOr Monday.\nSee you.\n${PARA_A}`)]);
                expect(kept(gap.input, gap.messagePlan)).toBe(body);
                // Alice's email ends before the last line (which is only in Carol's email, not in the chain): own text.
                const short = handPlan(body, folds, [other(ALICE, 0, 'Hi Bob,\n\nFriday ok?'), other(CAROL, 1, 'See you.')]);
                expect(kept(short.input, short.messagePlan)).toBe(body);
                // In another order: own text.
                const order = handPlan(body, folds, [other(ALICE, 0, `Friday ok?\nHi Bob,\nSee you.\n${PARA_A}`)]);
                expect(kept(order.input, order.messagePlan)).toBe(body);
                // Split over two emails of the chain (Alice quotes Carol, 1), even at the same places: own text.
                const aliceQuotesCarol = other(ALICE, 0, `Hi Bob,\nFriday ok?\n${PARA_A}`, [{ start: 0, end: 7, reason: 'quoted-overlap', related: 1 }]);
                const split = handPlan(body, folds, [aliceQuotesCarol, other(CAROL, 1, 'First line.\nSecond line.\nSee you.\n')]);
                expect(kept(split.input, split.messagePlan)).toBe(body);
                // All of them in Carol's email (in the chain): covered.
                const inCarol = handPlan(body, folds, [aliceQuotesCarol, other(CAROL, 1, 'Hi Bob,\nFriday ok?\nSee you.\n')]);
                expect(kept(inCarol.input, inCarol.messagePlan)).toBe(OWN);
            });

            it('at the top of the quote, the lines must be the FIRST word lines of the chain email', () =>
            {
                const body = `${OWN}${EN_BLOCK}Thanks,\n\n${PARA_A}`;
                const folds = [over(body, PARA_A, 'quoted-overlap', 0)];
                // "Thanks," is in Alice's email, but not at its top: own text, everything is kept.
                const later = handPlan(body, folds, [other(ALICE, 0, `Hi Bob,\n${PARA_A}Thanks,\nAlice`)]);
                expect(kept(later.input, later.messagePlan)).toBe(body);
                // Alice's email opens with it: covered.
                const top = handPlan(body, folds, [other(ALICE, 0, `Thanks,\n${PARA_A}`)]);
                expect(kept(top.input, top.messagePlan)).toBe(OWN);
            });

            it('below an earlier word piece of the quote, the lines may be anywhere in the chain email (consecutive)', () =>
            {
                // Alice quoted a paragraph of Bob's own (overlap, not confirming), then asked her question.
                const body = `${OWN}${EN_BLOCK}Hi Bob,\n\n${PARA_B}Friday ok?\n\n${PARA_A}`;
                const folds = [over(body, PARA_B, 'quoted-overlap', 5), over(body, PARA_A, 'quoted-overlap', 0)];
                const alice = other(ALICE, 0, `Hi Bob,\n${PARA_B}Friday ok?\n${PARA_A}`);
                const covered = handPlan(body, folds, [alice, other(BOB, 5, PARA_B)]);
                expect(kept(covered.input, covered.messagePlan)).toBe(OWN);
                // A line Alice does not have there: own text.
                const answered = `${OWN}${EN_BLOCK}Hi Bob,\n\n${PARA_B}Friday ok?\nYes.\n\n${PARA_A}`;
                const own = handPlan(answered, [over(answered, PARA_B, 'quoted-overlap', 5), over(answered, PARA_A, 'quoted-overlap', 0)], [alice, other(BOB, 5, PARA_B)]);
                expect(kept(own.input, own.messagePlan)).toBe(answered);
            });
        });
    });
});

describe('planOutput: when unsure, keep (review round 1)', () =>
{
    it('P6: an overlap-only paragraph of an email that is NOT included is kept', () =>
    {
        const own = 'Fine, Friday it is. See you then.\n\n';
        const all = analyze(mail({ from: ALICE, body: ALICE_TEXT }), mail({ from: BOB, body: `${own}${ALICE_TEXT}\n` }));
        const reply = byBody(all, 'Friday it is');
        const [messagePlan] = plan([reply]);
        expect(kept(reply, messagePlan!)).toBe(reply.message.bodyText);
        expect(messagePlan!.tailStart).toBeNull();
    });

    it('P14: ">" lines without a reply header are kept (likely pasted by the writer)', () =>
    {
        const body = 'Plan:\n> step one: measure the room\n> step two: order the desks\n';
        const all = analyze(mail({ from: BOB, body }));
        expect(all[0]!.segments.some((s) => s.reasons.includes('quote-marker'))).toBe(true);
        const [messagePlan] = plan(all);
        expect(kept(all[0]!, messagePlan!)).toBe(body);
        expect(reasonsAt(all[0]!, messagePlan!, '> step one')).toEqual(['writer-quote']);
    });

    it('a ">" quote without a reply header is kept even when its email is included', () =>
    {
        const own = 'Agreed, see the point below.\n\n';
        const all = analyze(mail({ from: ALICE, body: ALICE_TEXT }), mail({ from: BOB, body: `${own}${quoted(ALICE_TEXT)}\n` }));
        const reply = byBody(all, 'Agreed');
        const [, messagePlan] = plan(all);
        expect(kept(reply, messagePlan!)).toBe(reply.message.bodyText);
    });

    it('S4 / M5: a forward subject keeps an attribution quote of an included email', () =>
    {
        const body = `FYI\n\nOn Mon, 3 Mar 2025 at 14:02, Alice Example <alice@example.test> wrote:\n${quoted(ALICE_TEXT)}\n`;
        const all = analyze(mail({ from: ALICE, body: ALICE_TEXT }), mail({ from: BOB, body, subject: 'Fwd: Office furniture' }));
        const forward = byBody(all, 'FYI');
        const [, messagePlan] = plan(all);
        expect(kept(forward, messagePlan!)).toBe(body);
        expect(messagePlan!.tailStart).toBeNull();
        // Control: the same body with a reply subject loses the quote.
        const replyAll = analyze(mail({ from: ALICE, body: ALICE_TEXT }), mail({ from: BOB, body, subject: 'RE: Office furniture' }));
        const [, replyAllPlan] = plan(replyAll);
        expect(kept(byBody(replyAll, 'FYI'), replyAllPlan!)).toBe('FYI\n\n');
    });

    it('P13 / M7: a forward header inside a ">" quote is not a forward boundary (part of the quoted history)', () =>
    {
        const own = 'Thanks, noted.\n\n';
        const tail = [
            'On Mon, 3 Mar 2025 at 14:02, Alice Example <alice@example.test> wrote:',
            '> See below.',
            '>',
            '> ---------- Forwarded message ---------',
            '> From: Carol Test <carol@sample.test>',
            '> Date: Mon, 3 Mar 2025 at 10:00',
            '> Subject: Stock',
            '> To: Alice Example <alice@example.test>',
            '>',
            '> The oak desk is in stock, says the warehouse.',
            '',
        ].join('\n');
        const all = analyze(mail({ from: BOB, body: `${own}${tail}` }));
        const [messagePlan] = plan(all);
        expect(kept(all[0]!, messagePlan!)).toBe(own);
        expect(messagePlan!.ranges.some((r) => r.reason === 'forwarded')).toBe(false);
    });

    it('P13b / M7: a quoted forward header with no reply header around it is a writer quote, not a forwarded part', () =>
    {
        const body = [
            'Thanks, see what the warehouse said:',
            '',
            '> ---------- Forwarded message ---------',
            '> From: Carol Test <carol@sample.test>',
            '> Date: Mon, 3 Mar 2025 at 10:00',
            '> Subject: Stock',
            '> To: Alice Example <alice@example.test>',
            '>',
            '> The oak desk is in stock, says the warehouse.',
            '',
        ].join('\n');
        const all = analyze(mail({ from: BOB, body }));
        const [messagePlan] = plan(all);
        expect(kept(all[0]!, messagePlan!)).toBe(body);
        expect(reasonsAt(all[0]!, messagePlan!, '> The oak desk')).toEqual(['writer-quote']);
    });

    /** Hand-made: own text, then an overlap-only fold (no signature) linked to input position 0. */
    function overlapCase(fromReply: EmailAddress | null, fromQuoted: EmailAddress | null): { input: PlanInput; plans: MessagePlan[] }
    {
        const body = 'Own text.\n\nOld paragraph about the desk delivery on Friday morning at the second floor office.\n';
        const offset = body.indexOf('Old');
        const quotedMail: NormalizedMessage = { ...mail({ from: ALICE, body: 'x' }), from: fromQuoted === null ? [] : [fromQuoted] };
        const replyMail: NormalizedMessage = { ...mail({ from: BOB, body }), from: fromReply === null ? [] : [fromReply] };
        const input: PlanInput = {
            message: replyMail,
            segments: buildSegments(body, [{ start: offset, end: body.length, reason: 'quoted-overlap', related: 0 }]),
            index: 1,
        };
        return { input, plans: plan([{ message: quotedMail, segments: buildSegments('x', []), index: 0 }, input]) };
    }

    it('M3: an overlap-only tail linked to an included email of the SAME sender is kept', () =>
    {
        const same = overlapCase(BOB, BOB);
        expect(kept(same.input, same.plans[1]!)).toBe(same.input.message.bodyText);
        const other = overlapCase(BOB, ALICE);
        expect(kept(other.input, other.plans[1]!)).toBe('Own text.\n\n');
    });

    it('M12: an unknown sender is never "the same sender" (the tail is left out)', () =>
    {
        const unknown = overlapCase(null, null);
        expect(kept(unknown.input, unknown.plans[1]!)).toBe('Own text.\n\n');
    });

    it('a lone folded whitespace piece outside the tail is labelled text', () =>
    {
        const body = 'Own text.\n\nMore own text.\n';
        const offset = body.indexOf('\n\n') + 1;
        const input: PlanInput = {
            message: mail({ from: BOB, body }),
            segments: buildSegments(body, [{ start: offset, end: offset + 1, reason: 'quote-marker' }]),
        };
        const [messagePlan] = plan([input]);
        expect(messagePlan!.ranges).toEqual([{ start: 0, end: body.length, keep: true, reason: 'text' }]);
    });
});

describe('planRebuiltText: rule 3 for an email rebuilt from quoted text (task 9.9b-2)', () =>
{
    const TEXT = 'Hello Carol,\nThe desks are ready.\n\nBest regards,\nBob Sample\nSample Furniture\n';
    const blockStart = TEXT.indexOf('Best regards');
    const SEGMENTS = buildSegments(TEXT, [{ start: blockStart, end: TEXT.length, reason: 'signature' }]);
    const KEY = 'Best regards,\nBob Sample\nSample Furniture';

    it('keeps the first block of a sender and records it; leaves the same block out the next time', () =>
    {
        const memory = new Map<string, Set<string>>();
        const first = planRebuiltText(TEXT, SEGMENTS, BOB.address, DEFAULT_OUTPUT_POLICY, memory);
        expect(first.ranges).toEqual([
            { start: 0, end: blockStart, keep: true, reason: 'text' },
            { start: blockStart, end: TEXT.length, keep: true, reason: 'signature' },
        ]);
        expect([first.omittedSignatures, first.keptAllBecauseEmpty, first.fallback, first.tailStart]).toEqual([0, false, false, null]);
        expect([...memory.get(BOB.address) ?? []]).toEqual([KEY]);
        const second = planRebuiltText(TEXT, SEGMENTS, BOB.address, DEFAULT_OUTPUT_POLICY, memory);
        expect(second.ranges[1]).toEqual({ start: blockStart, end: TEXT.length, keep: false, reason: 'repeated-signature' });
        expect(second.omittedSignatures).toBe(1);
        // Another sender, or an unknown one (''), keeps it.
        expect(planRebuiltText(TEXT, SEGMENTS, ALICE.address, DEFAULT_OUTPUT_POLICY, memory).ranges[1]?.keep).toBe(true);
        expect(planRebuiltText(TEXT, SEGMENTS, '', DEFAULT_OUTPUT_POLICY, memory).ranges[1]?.keep).toBe(true);
        expect(memory.has('')).toBe(false);
    });

    it('follows the policy: "all" keeps every block, "none" leaves every one out, "include everything" keeps all', () =>
    {
        const seen = (): Map<string, Set<string>> => new Map([[BOB.address, new Set([KEY])]]);
        expect(planRebuiltText(TEXT, SEGMENTS, BOB.address, { ...DEFAULT_OUTPUT_POLICY, signatures: 'all' }, seen()).ranges[1]?.keep).toBe(true);
        expect(planRebuiltText(TEXT, SEGMENTS, BOB.address, { ...DEFAULT_OUTPUT_POLICY, signatures: 'none' }, new Map()).ranges[1]).toEqual(
            { start: blockStart, end: TEXT.length, keep: false, reason: 'signature' });
        expect(planRebuiltText(TEXT, SEGMENTS, BOB.address, { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true }, seen()).ranges.every((r) => r.keep)).toBe(true);
    });

    it('keeps the whole text without folds, with segments that are not a cover (fallback), and when nothing with text would stay (rule 4)', () =>
    {
        const whole = { ranges: [{ start: 0, end: TEXT.length, keep: true, reason: 'text' }], tailStart: null, omittedSignatures: 0, keptAllBecauseEmpty: false };
        expect(planRebuiltText(TEXT, undefined, BOB.address, DEFAULT_OUTPUT_POLICY, new Map())).toEqual({ ...whole, fallback: false });
        expect(planRebuiltText(TEXT, 'x' as never, BOB.address, DEFAULT_OUTPUT_POLICY, new Map())).toEqual({ ...whole, fallback: false });
        expect(planRebuiltText(TEXT, [{ start: 0, end: 3, folded: true, reasons: ['signature'], related: [] }], BOB.address, DEFAULT_OUTPUT_POLICY, new Map()))
            .toEqual({ ...whole, fallback: true });
        expect(planRebuiltText('', [], BOB.address, DEFAULT_OUTPUT_POLICY, new Map())).toEqual({ ...whole, ranges: [], fallback: false });
        // A text that is all one repeated block (never given by the detector, SAFETY a): kept whole.
        const all = buildSegments(TEXT, [{ start: 0, end: TEXT.length, reason: 'signature' }]);
        const memory = new Map([[BOB.address, new Set(['Hello Carol,\nThe desks are ready.\nBest regards,\nBob Sample\nSample Furniture'])]]);
        const allPlan = planRebuiltText(TEXT, all, BOB.address, DEFAULT_OUTPUT_POLICY, memory);
        expect(allPlan.keptAllBecauseEmpty).toBe(true);
        expect(allPlan.ranges).toEqual([{ start: 0, end: TEXT.length, keep: true, reason: 'repeated-signature' }]);
        expect(allPlan.omittedSignatures).toBe(0);
    });

    it('a fold with another reason than signature is the writer\'s text (only signature folds are planned)', () =>
    {
        const nameAt = TEXT.indexOf('Bob Sample');
        const fold = (start: number, end: number, reason: 'signature' | 'quote-marker'): Segment => ({ start, end, folded: true, reasons: [reason], related: [] });
        const shown: Segment = { start: 0, end: blockStart, folded: false, reasons: [], related: [] };
        const mixed = planRebuiltText(TEXT, [shown, fold(blockStart, nameAt, 'signature'), fold(nameAt, TEXT.length, 'quote-marker')], BOB.address,
            DEFAULT_OUTPUT_POLICY, new Map());
        expect(mixed.ranges.map((r) => [TEXT.slice(r.start, r.end), r.reason])).toEqual([
            ['Hello Carol,\nThe desks are ready.\n\n', 'text'],
            ['Best regards,\n', 'signature'],
            ['Bob Sample\nSample Furniture\n', 'text'],
        ]);
    });
});
