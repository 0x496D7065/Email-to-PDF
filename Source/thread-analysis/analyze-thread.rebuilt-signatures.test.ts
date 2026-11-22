// Tests for step 7 of the thread analysis (task 9.9b-2, user decision F4): the signature folds of the
// emails rebuilt from quoted text, by the same rules as for real emails (signature-detection.ts),
// the frequency rule counting the sender's real and rebuilt emails together, each email once.
// Synthetic data only: made-up names, *.test addresses.

import { describe, expect, it } from 'vitest';
import { DEFAULT_THREAD_ANALYSIS_PARTS, analyzeThread, type ThreadAnalysisParts } from './analyze-thread';
import { checkSegments, joinSegments } from './fold-segments';
import { MIN_BLOCK_CHARS, MIN_MESSAGES_PER_SENDER, minRepeat } from './signature-detection';
import type { EmailAddress, NormalizedMessage, ParseResult } from '../../Header/parsed-email';
import type { AnalyzedRebuiltMessage } from '../../Header/rebuilt-emails';
import type { ThreadAnalysisResult } from '../../Header/thread-analysis-result';

const BOB: EmailAddress = { name: 'Bob Sample', address: 'bob@furniture.example.test' };
const CAROL: EmailAddress = { name: 'Carol Writer', address: 'carol@client.test' };

let counter = 0;
function make(fields: Partial<NormalizedMessage> = {}): NormalizedMessage
{
    counter++;
    return {
        messageId: `rebuilt-signature-${counter}@example.test`,
        inReplyTo: null,
        references: [],
        date: { utcMs: Date.parse('2025-03-10T12:00:00Z') + counter * 60_000, original: '', offsetMinutes: 0, zoneKnown: true },
        from: [CAROL],
        to: [],
        cc: [],
        bcc: [],
        subject: 'Re: Desks',
        bodyText: `Hello, note ${counter}.\n`,
        attachments: [],
        source: { fileName: `rebuilt-signature-${counter}.eml`, sha256: counter.toString(16).padStart(64, '0'), kind: 'eml' },
        warnings: [],
        ...fields,
    };
}
const ok = (message: NormalizedMessage): ParseResult => ({ ok: true, message });
const NO_REBUILD: ThreadAnalysisParts = { ...DEFAULT_THREAD_ANALYSIS_PARTS, reconstructQuotedMessages: () => [] };

/** Bob's repeated block: his closing line, name, company and phone line. */
const BLOCK = ['Best regards,', 'Bob Sample', 'Sample Furniture', 'Order desk: +00 0 000 00 00'];
const quote = (depth: number, lines: readonly string[]): string => lines.map((line) => `${'>'.repeat(depth)}${line === '' ? '' : ' '}${line}`).join('\n');
const attribution = (depth: number, day: string, who: EmailAddress): string =>
    `${'>'.repeat(depth)}${depth === 0 ? '' : ' '}On ${day} 2025 at 10:00, ${who.name} <${who.address}> wrote:`;

/** Carol's reply quoting Bob, who quotes Carol, who quotes Bob (Gmail style, ">" one level deeper each time). */
function chainBody(options: { firstBob?: readonly string[]; secondBob?: readonly string[]; bobAddress?: string } = {}): string
{
    const bob = { ...BOB, address: options.bobAddress ?? BOB.address };
    return [
        'Thanks Bob, noted.',
        '',
        attribution(0, 'Tue, 4 Mar', bob),
        quote(1, options.secondBob ?? ['Hello Carol,', 'The desks are ready for delivery on Friday.', '', ...BLOCK]),
        '>',
        attribution(1, 'Mon, 3 Mar', CAROL),
        quote(2, ['Hello Bob,', 'When can you deliver the desks?', 'Carol']),
        '>>',
        attribution(2, 'Fri, 28 Feb', bob),
        quote(3, options.firstBob ?? ['Hello Carol,', 'Your order is confirmed.', '', ...BLOCK]),
        '',
    ].join('\n');
}

/** The folded texts of a rebuilt email (its signature folds). */
const foldedTexts = (r: AnalyzedRebuiltMessage | undefined): string[] =>
    (r?.segments ?? []).filter((s) => s.folded).map((s) => r!.rebuilt.reconstructedText.slice(s.start, s.end));
const bobs = (out: ThreadAnalysisResult): AnalyzedRebuiltMessage[] => out.reconstructed.filter((r) => r.rebuilt.from[0]?.address.toLowerCase() === BOB.address);
/** Everything that does not depend on rebuilding. */
const realPart = (out: ThreadAnalysisResult): unknown => ({ messages: out.messages, failed: out.failed, counts: out.counts, positionByIndex: out.positionByIndex });

describe('analyzeThread: signatures of rebuilt emails (step 7, task 9.9b-2)', () =>
{
    it('the thresholds are the ones real emails use', () =>
    {
        expect([MIN_MESSAGES_PER_SENDER, MIN_BLOCK_CHARS, minRepeat(2), minRepeat(10)]).toEqual([2, 20, 2, 3]);
    });

    it('folds a block a sender repeats in two rebuilt emails, and nothing else; the real email is unchanged', () =>
    {
        const results = [ok(make({ bodyText: chainBody() }))];
        const out = analyzeThread(results);
        expect(out.reconstructed.map((r) => [r.rebuilt.from[0]?.address, r.link])).toEqual([
            [BOB.address, 'entry'],
            [CAROL.address, 'entry'],
            [BOB.address, 'entry'],
        ]);
        for (const bobEmail of bobs(out))
        {
            expect(foldedTexts(bobEmail)).toEqual([`${BLOCK.join('\n')}\n`]);
            const segments = bobEmail.segments!;
            expect(segments.filter((s) => s.folded).every((s) => s.reasons.join() === 'signature' && s.related.length === 0)).toBe(true);
            // Collapse, never delete: the segments give the text back.
            expect(checkSegments(bobEmail.rebuilt.reconstructedText, segments)).toEqual([]);
            expect(joinSegments(bobEmail.rebuilt.reconstructedText, segments)).toBe(bobEmail.rebuilt.reconstructedText);
        }
        // Carol's rebuilt email ends with a name only: no block, no segments.
        expect(out.reconstructed[1]!.segments).toBeUndefined();
        // The real email: exactly as without rebuilding (step 7 only adds to the rebuilt ones).
        expect(realPart(out)).toEqual(realPart(analyzeThread(results, NO_REBUILD)));
        expect(structuredClone(out)).toEqual(out);
    });

    it('counts the sender\'s real files with the rebuilt emails, the address compared as for real emails', () =>
    {
        // Carol quotes ONE email of Bob's; Bob's block is also in a file of his own (another email).
        const quoting = make({ bodyText: [
            'Thanks Bob.',
            '',
            // An address written in capitals in the quote is the same sender (lower-cased, as senderKeyOf does).
            attribution(0, 'Tue, 4 Mar', { ...BOB, address: 'BOB@Furniture.Example.test' }),
            quote(1, ['Hello Carol,', 'The desks are ready for delivery on Friday.', '', ...BLOCK]),
            '',
        ].join('\n') });
        const bobFile = make({ from: [BOB], subject: 'Desks: invoice', bodyText: ['Hello Carol,', 'Please find the invoice below: EUR 1,250.', '', ...BLOCK, ''].join('\n') });
        const alone = analyzeThread([ok(quoting)]);
        expect(alone.reconstructed).toHaveLength(1);
        // One message of Bob's: the frequency rule needs two.
        expect(alone.reconstructed[0]!.segments).toBeUndefined();
        const withFile = analyzeThread([ok(bobFile), ok(quoting)]);
        expect(withFile.reconstructed.map((r) => r.link)).toEqual(['entry']);
        expect(foldedTexts(withFile.reconstructed[0])).toEqual([`${BLOCK.join('\n')}\n`]);
        // The real file's own folds are those without rebuilding: its signature counts the real files only
        // (Bob has one), so it is not folded as a signature there (known limit, see analyze-thread.ts step 7).
        expect(realPart(withFile)).toEqual(realPart(analyzeThread([ok(bobFile), ok(quoting)], NO_REBUILD)));
        expect(withFile.messages.find((m) => m.message === bobFile)!.segments.some((s) => s.reasons.includes('signature'))).toBe(false);
    });

    it('never counts one email twice: a copy quoted in another file, or a copy of a real file, is folded only by what it repeats', () =>
    {
        // Bob's ONE email, quoted by two emails of Carol's (an entry and its same-as copy).
        const bobText = ['Hello Carol,', 'The desks are ready for delivery on Friday.', '', ...BLOCK];
        const reply = (note: string): NormalizedMessage => make({ bodyText: [note, '', attribution(0, 'Tue, 4 Mar', BOB), quote(1, bobText), ''].join('\n') });
        const twice = analyzeThread([ok(reply('Thanks Bob.')), ok(reply('Friday is fine, thanks.'))]);
        expect(twice.reconstructed.map((r) => r.link).sort()).toEqual(['entry', 'same-as']);
        for (const copy of twice.reconstructed)
        {
            // One message of Bob's: the frequency rule needs two, so nothing folds. (Counted twice, nothing would fold
            // either: the whole text repeats, so a block would start at its first line, SAFETY a of signature-detection.ts.
            // The next test pins that copies are not counted.)
            expect(copy.segments, copy.link).toBeUndefined();
        }
        // Bob's email as a real file too: the rebuilt copy is linked to it ('real') and not counted.
        const bobFile = make({ from: [BOB], date: { utcMs: Date.parse('2025-03-04T10:00:00Z'), original: '', offsetMinutes: 0, zoneKnown: true },
            bodyText: `${bobText.join('\n')}\n` });
        const withReal = analyzeThread([ok(bobFile), ok(reply('Thanks Bob.'))]);
        expect(withReal.reconstructed.map((r) => r.link)).toEqual(['real']);
        expect(withReal.reconstructed[0]!.segments).toBeUndefined();
    });

    it('counts an entry once, not once per copy: the copies do not make a block "repeated" that is not', () =>
    {
        // Bob's ONE email, quoted in three of Carol's files: an entry and two same-as copies.
        const bobText = ['Hello Carol,', 'The desks are ready for delivery on Friday.', '', ...BLOCK];
        const reply = (note: string): NormalizedMessage => make({ bodyText: [note, '', attribution(0, 'Tue, 4 Mar', BOB), quote(1, bobText), ''].join('\n') });
        // Eight real files of Bob's (dated days later: none is the quoted email), one of them with the same block.
        const bobFile = (line: string, block: boolean): NormalizedMessage =>
            make({ from: [BOB], subject: 'Desks: update', bodyText: ['Hello Carol,', line, '', ...(block ? BLOCK : ['Bob']), ''].join('\n') });
        const results = [
            ok(bobFile('Please find the invoice below: EUR 1,250.', true)),
            ...[1, 2, 3, 4, 5, 6, 7].map((n) => ok(bobFile(`Update ${String(n)}: the chairs are on their way.`, false))),
            ok(reply('Thanks Bob.')),
            ok(reply('Friday is fine, thanks.')),
            ok(reply('Noted, see you Friday.')),
        ];
        const out = analyzeThread(results);
        expect(out.reconstructed.map((r) => r.link)).toEqual(['entry', 'same-as', 'same-as']);
        // Counted: 8 real files + the entry = 9 messages, so a pair must be in minRepeat(9) = 3 of them; the block
        // is in 2 (one file, the entry). Were each copy counted (11 messages, minRepeat 4), it would be in 4: folded.
        expect(minRepeat(9)).toBe(3);
        expect(minRepeat(11)).toBe(4);
        expect(out.reconstructed.map((r) => r.segments)).toEqual([undefined, undefined, undefined]);
    });

    it('never folds the writer\'s own words: a short closing, a sender with one email, a text that is all repeated', () =>
    {
        // Short closing ("Thanks, / Bob": under MIN_BLOCK_CHARS), twice.
        const short = analyzeThread([ok(make({ bodyText: chainBody({ firstBob: ['Hello Carol,', 'Your order is confirmed.', 'Thanks,', 'Bob'],
            secondBob: ['Hello Carol,', 'The desks are ready.', 'Thanks,', 'Bob'] }) }))]);
        expect(bobs(short).map((r) => r.segments)).toEqual([undefined, undefined]);
        // The whole text the same twice ("Any update? / Thanks, / Bob Sample ..."): it is the message, not a signature.
        const same = ['Any update on the delivery date?', ...BLOCK];
        const whole = analyzeThread([ok(make({ bodyText: chainBody({ firstBob: same, secondBob: same }) }))]);
        expect(bobs(whole)).toHaveLength(2);
        expect(bobs(whole).map((r) => r.segments)).toEqual([undefined, undefined]);
        // A block that is Bob's in one email only (the other one ends differently): one message has it, nothing folds.
        const once = analyzeThread([ok(make({ bodyText: chainBody({ secondBob: ['Hello Carol,', 'The desks are ready.', 'Bob'] }) }))]);
        expect(bobs(once).map((r) => r.segments)).toEqual([undefined, undefined]);
    });

    it('folds a "-- " signature in a rebuilt email even when its sender has one email (the delimiter rule)', () =>
    {
        const out = analyzeThread([ok(make({ bodyText: [
            'Thanks Bob.',
            '',
            attribution(0, 'Tue, 4 Mar', BOB),
            quote(1, ['Hello Carol,', 'The desks are ready.', '', '-- ', 'Bob Sample', 'Sample Furniture']),
            '',
        ].join('\n') }))]);
        expect(foldedTexts(out.reconstructed[0])).toEqual(['-- \nBob Sample\nSample Furniture\n']);
    });

    it('leaves a block inside a deeper quote of a rebuilt text to the quote (its own text ends there, as for a real email)', () =>
    {
        // Both of Bob's emails quote the same block with ">" and no header of its own, under his own words:
        // not his own text (its own end is the quote, found by the quote-marker detector), so neither counted
        // nor folded. Counted as own text, the quoted block would repeat in both and fold.
        const quotedBlock = ['Our terms:', ...BLOCK.map((l) => `> ${l}`)];
        const out = analyzeThread([ok(make({ bodyText: chainBody({
            firstBob: ['Hello Carol,', 'Your order is confirmed.', '', ...quotedBlock],
            secondBob: ['Hello Carol,', 'The desks are ready.', '', ...quotedBlock],
        }) }))]);
        expect(bobs(out)).toHaveLength(2);
        expect(bobs(out).every((r) => r.rebuilt.reconstructedText.includes('> Order desk: +00 0 000 00 00'))).toBe(true);
        expect(bobs(out).map((r) => r.segments)).toEqual([undefined, undefined]);
    });

    it('safety net: a detector that throws or returns nonsense leaves the rebuilt texts unfolded, and the rest unchanged', () =>
    {
        const results = [ok(make({ bodyText: chainBody() }))];
        const good = analyzeThread(results);
        const bodies = new Set(good.messages.map((m) => m.message.bodyText));
        const unfolded = (out: ThreadAnalysisResult): void =>
        {
            expect(realPart(out)).toEqual(realPart(good));
            expect(out.timeline).toEqual(good.timeline);
            expect(out.reconstructionWarnings).toEqual([]);
            expect(out.reconstructed).toEqual(good.reconstructed.map((r) => ({ ...r, segments: undefined })));
        };
        // The signature detector, on its second call (step 7) only: step 4c (the real emails) works as before.
        const secondCall = (bad: (inputs: readonly unknown[]) => unknown): ThreadAnalysisParts =>
        {
            let calls = 0;
            return {
                ...DEFAULT_THREAD_ANALYSIS_PARTS,
                detectSignatures: (inputs) => (++calls === 1 ? DEFAULT_THREAD_ANALYSIS_PARTS.detectSignatures(inputs) : bad(inputs) as never),
            };
        };
        unfolded(analyzeThread(results, secondCall(() =>
        {
            throw new Error('boom');
        })));
        unfolded(analyzeThread(results, secondCall(() => 'not a list')));
        unfolded(analyzeThread(results, secondCall(() => [[], [], 5, null, [{ start: -3, end: 1e9, reason: 'signature' }]])));
        // A fold with another reason is not used.
        unfolded(analyzeThread(results, secondCall((inputs) => inputs.map(() => [{ start: 0, end: 5, reason: 'quote-marker' }]))));
        // The quote detectors throwing on a rebuilt text only: that text has no own end, so no fold.
        const quoteMarkersOnRebuilt: ThreadAnalysisParts = {
            ...DEFAULT_THREAD_ANALYSIS_PARTS,
            detectQuoteMarkers: (text) =>
            {
                if (!bodies.has(text))
                {
                    throw new Error('boom');
                }
                return DEFAULT_THREAD_ANALYSIS_PARTS.detectQuoteMarkers(text);
            },
        };
        unfolded(analyzeThread(results, quoteMarkersOnRebuilt));
        const replyHeadersOnRebuilt: ThreadAnalysisParts = {
            ...DEFAULT_THREAD_ANALYSIS_PARTS,
            detectReplyHeaders: (text, subject) => (bodies.has(text) ? DEFAULT_THREAD_ANALYSIS_PARTS.detectReplyHeaders(text, subject) : ('nonsense' as never)),
        };
        unfolded(analyzeThread(results, replyHeadersOnRebuilt));
        // Its own end unknown, a rebuilt text has no own line at all (ownTextEnd 0): not even a "-- " signature
        // (folded by the delimiter rule, which needs no count) is folded then. With the whole text as own text it would be.
        const delimited = [ok(make({ bodyText: [
            'Thanks Bob.',
            '',
            attribution(0, 'Tue, 4 Mar', BOB),
            quote(1, ['Hello Carol,', 'The desks are ready.', '', '-- ', 'Bob Sample', 'Sample Furniture']),
            '',
        ].join('\n') }))];
        const delimitedBodies = new Set(delimited.map((r) => (r.ok ? r.message.bodyText : '')));
        expect(analyzeThread(delimited).reconstructed[0]!.segments?.some((s) => s.folded)).toBe(true);
        const throwsOnRebuilt = analyzeThread(delimited, {
            ...DEFAULT_THREAD_ANALYSIS_PARTS,
            detectQuoteMarkers: (text) =>
            {
                if (!delimitedBodies.has(text))
                {
                    throw new Error('boom');
                }
                return DEFAULT_THREAD_ANALYSIS_PARTS.detectQuoteMarkers(text);
            },
        });
        expect(throwsOnRebuilt.reconstructed).toHaveLength(1);
        expect(throwsOnRebuilt.reconstructed[0]!.segments).toBeUndefined();
        // Segments that are not a cover of the text: that text is shown whole.
        unfolded(analyzeThread(results, { ...DEFAULT_THREAD_ANALYSIS_PARTS, buildSegments: (text, folds) =>
            (bodies.has(text) ? DEFAULT_THREAD_ANALYSIS_PARTS.buildSegments(text, folds) : [{ start: 0, end: 1, folded: true, reasons: ['signature'], related: [] }]) }));
    });
});
