// Tests for the thread analysis pipeline (README.md, rules R6 and R7). Synthetic data only.
// The random collapse-never-delete tests and the speed test are in
// analyze-thread.property.test.ts; the run over the fixtures in analyze-thread.fixtures.test.ts.

import { describe, expect, it } from 'vitest';
import type { DedupeResult } from './dedupe';
import { DEFAULT_THREAD_ANALYSIS_PARTS, primaryReason, analyzeThread, type ThreadAnalysisParts } from './analyze-thread';
import { checkSegments, joinSegments, type FoldRange } from './fold-segments';
import type { EmailAddress, NormalizedMessage, ParseResult } from '../../Header/parsed-email';
import type { AnalyzedMessage, ThreadAnalysisResult, FoldReason, Segment } from '../../Header/thread-analysis-result';

// ------------------------------------------------------------------ factory

const ALICE: EmailAddress = { name: 'Alice Example', address: 'alice@example.test' };
const BOB: EmailAddress = { name: 'Bob Sample', address: 'bob@furniture.example.test' };

const DATE_MS = Date.parse('2025-03-04T07:00:00Z');
let fileCounter = 0;

/** A synthetic message from Alice to Bob; `fields` overrides any field. Unique file name, id and date per call. */
function make(fields: Partial<NormalizedMessage> = {}): NormalizedMessage
{
    fileCounter++;
    return {
        messageId: `m${fileCounter}@example.test`,
        inReplyTo: null,
        references: [],
        date: { utcMs: DATE_MS + fileCounter * 60_000, original: 'Tue, 4 Mar 2025 08:00:00 +0100', offsetMinutes: 60, zoneKnown: true },
        from: [ALICE],
        to: [BOB],
        cc: [],
        bcc: [],
        subject: 'Desks',
        bodyText: `Hello Bob,\n\nThe desks arrive on Monday, note ${fileCounter}.\n\nAlice\n`,
        attachments: [],
        source: { fileName: `file-${fileCounter}.eml`, sha256: fileCounter.toString(16).padStart(64, '0'), kind: 'eml' },
        warnings: [],
        ...fields,
    };
}

const ok = (message: NormalizedMessage): ParseResult => ({ ok: true, message });
const failure = (fileName: string): ParseResult => ({
    ok: false,
    fileName,
    sha256: 'f'.repeat(64),
    error: 'corrupt',
    detail: 'damaged file structure: synthetic',
});
const undatedDate: NormalizedMessage['date'] = { utcMs: null, original: '', offsetMinutes: null, zoneKnown: false };

/** The kept message whose input position is `index`. */
function byIndex(out: ThreadAnalysisResult, index: number): AnalyzedMessage
{
    const position = out.positionByIndex[index];
    if (position === null || position === undefined)
    {
        throw new Error(`input ${index} has no kept message`);
    }
    return out.messages[position]!;
}

/** The reasons of the segment(s) covering the first occurrence of `snippet`; throws if they differ. */
function reasonsAt(message: AnalyzedMessage, snippet: string): readonly FoldReason[]
{
    const body = message.message.bodyText;
    const offset = body.indexOf(snippet);
    if (offset < 0)
    {
        throw new Error(`snippet not found: ${snippet}`);
    }
    const covering = message.segments.filter((s) => s.start < offset + snippet.length && s.end > offset);
    const first = covering[0]!;
    for (const segment of covering)
    {
        expect(segment.reasons, snippet).toEqual(first.reasons);
    }
    return first.reasons;
}

// Bob's repeated signature and disclaimer: long enough for the overlap
// detector to match it in his earlier message too.
const BOB_SIGNATURE =
    'Met vriendelijke groeten,\nBob Sample\nSample Furniture - Showroom\n\n' +
    'DISCLAIMER: This e-mail and any attachments are confidential and intended\nsolely for the addressee.';

// ------------------------------------------------------------------ tests

describe('primaryReason', () =>
{
    it('prefers signature, then reply-header, quote-marker, quoted-overlap', () =>
    {
        expect(primaryReason([])).toBeNull();
        expect(primaryReason(['quoted-overlap'])).toBe('quoted-overlap');
        expect(primaryReason(['quoted-overlap', 'signature'])).toBe('signature');
        expect(primaryReason(['quoted-overlap', 'quote-marker'])).toBe('quote-marker');
        expect(primaryReason(['quote-marker', 'reply-header'])).toBe('reply-header');
        expect(primaryReason(['quoted-overlap', 'quote-marker', 'reply-header', 'signature'])).toBe('signature');
    });
});

describe('analyzeThread: files, indices and counts', () =>
{
    it('returns an empty result for no input', () =>
    {
        expect(analyzeThread([])).toEqual({
            messages: [],
            failed: [],
            counts: { filesGiven: 0, messagesFound: 0, duplicatesMerged: 0, filesFailed: 0, undated: 0, withFolds: 0 },
            positionByIndex: [],
            reconstructed: [],
            timeline: [],
            reconstructionWarnings: [],
        });
    });

    it('counts every file given (filesGiven) and, separately, the ones that failed', () =>
    {
        const out = analyzeThread([failure('a.eml'), ok(make()), failure('b.msg')]);
        expect(out.counts.filesGiven).toBe(3);
        expect(out.counts.filesFailed).toBe(2);
        expect(out.counts.messagesFound).toBe(1);
    });

    it('lists failed files with their reason and keeps reading the others', () =>
    {
        const a = make();
        const b = make();
        const results = [failure('broken-1.eml'), ok(a), failure('broken-2.msg'), ok(b)];
        const out = analyzeThread(results);
        expect(out.failed).toEqual([
            { index: 0, fileName: 'broken-1.eml', sha256: 'f'.repeat(64), error: 'corrupt', detail: 'damaged file structure: synthetic' },
            { index: 2, fileName: 'broken-2.msg', sha256: 'f'.repeat(64), error: 'corrupt', detail: 'damaged file structure: synthetic' },
        ]);
        expect(out.messages.map((m) => m.index)).toEqual([1, 3]);
        expect(out.messages[0]!.message).toBe(a); // same object, unchanged
        expect(out.positionByIndex).toEqual([null, 0, null, 1]);
        expect(out.counts).toEqual({ filesGiven: 4, messagesFound: 2, duplicatesMerged: 0, filesFailed: 2, undated: 0, withFolds: 0 });
    });

    it('uses input positions for kept messages, merged copies and dedupe warnings', () =>
    {
        const original = make({ messageId: 'same@example.test' });
        const copy = { ...original, source: { ...original.source, fileName: 'copy.msg', kind: 'msg' as const } };
        const conflicting = make({ messageId: 'same@example.test', bodyText: 'Something else entirely.\n' });
        // A failed file first, so dedupe's own numbering (parsed messages only) would be off by one.
        const results = [failure('broken.eml'), ok(conflicting), ok(original), ok(copy)];
        const out = analyzeThread(results);
        const kept = byIndex(out, 2);
        expect(kept.duplicates).toEqual([{ source: copy.source, index: 3, rule: 'message-id' }]);
        expect(kept.dedupeWarnings).toEqual([{ code: 'same-id-different-content', related: [1], relatedTotal: 1 }]);
        expect(byIndex(out, 1).dedupeWarnings).toEqual([{ code: 'same-id-different-content', related: [2, 3], relatedTotal: 2 }]);
        expect(out.positionByIndex[3]).toBe(out.positionByIndex[2]);
        expect(out.counts.duplicatesMerged).toBe(1);
        expect(out.counts.messagesFound).toBe(3);
    });

    it('orders by date, puts undated messages last by file order, and counts them', () =>
    {
        const late = make({ date: { ...make().date, utcMs: DATE_MS + 10 * 86_400_000 } });
        const early = make({ date: { ...make().date, utcMs: DATE_MS - 86_400_000 } });
        const undatedA = make({ date: undatedDate, warnings: ['missing-date'] });
        const undatedB = make({ date: undatedDate, warnings: ['missing-date'] });
        const out = analyzeThread([ok(undatedB), ok(late), ok(undatedA), ok(early)]);
        expect(out.messages.map((m) => [m.index, m.order])).toEqual([
            [3, 'by-date'],
            [1, 'by-date'],
            [0, 'file-order'],
            [2, 'file-order'],
        ]);
        expect(out.counts.undated).toBe(2);
        expect(byIndex(out, 0).parserWarnings).toEqual(['missing-date']);
    });

    it('never modifies its input, and the result survives a structured clone', () =>
    {
        const first = make(
            { bodyText: `Hello Alice,\n\nThe quote follows next week, after the visit to the room.\n\n${BOB_SIGNATURE}\n`, from: [BOB] });
        const reply = make({
            inReplyTo: first.messageId,
            references: [first.messageId!],
            bodyText: `Thanks Bob.\n\nOn Mon, 3 Mar 2025 at 14:02, Bob Sample <bob@furniture.example.test> wrote:\n${first.bodyText
                .split('\n')
                .map((l) => `> ${l}`)
                .join('\n')}\n`,
        });
        const results = [ok(reply), failure('x.eml'), ok(first)];
        const snapshot = JSON.stringify(results);
        const out = analyzeThread(results);
        expect(JSON.stringify(results)).toBe(snapshot);
        expect(structuredClone(out)).toEqual(out);
    });
});

describe('analyzeThread: detectors working together', () =>
{
    it('links quoted history to the input position of the quoted message', () =>
    {
        const first = make({ bodyText: 'We are furnishing a small office for four people and need desks, chairs and one meeting table.\n' });
        const reply = make({
            inReplyTo: first.messageId,
            references: [first.messageId!],
            bodyText: `Yes, I can come on Wednesday.\n\n${first.bodyText}`,
        });
        const out = analyzeThread([failure('x.eml'), ok(reply), ok(first)]);
        const message = byIndex(out, 1);
        expect(reasonsAt(message, 'Yes, I can come')).toEqual([]);
        expect(reasonsAt(message, 'We are furnishing')).toEqual(['quoted-overlap']);
        const folded = message.segments.find((s) => s.folded)!;
        expect(folded.related).toEqual([2]);
        expect(out.messages[out.positionByIndex[2]!]!.message).toBe(first);
        expect(out.counts.withFolds).toBe(1);
    });

    it('labels a repeated signature as signature although the overlap detector also folds it', () =>
    {
        const one = make({ from: [BOB], bodyText: `Hello Alice,\n\nThe quote follows after the visit.\n\n${BOB_SIGNATURE}\n` });
        const two = make({ from: [BOB], bodyText: `Hello Alice,\n\nThe delivery is planned for Friday morning.\n\n${BOB_SIGNATURE}\n` });
        const out = analyzeThread([ok(one), ok(two)]);
        const second = byIndex(out, 1);
        expect(reasonsAt(second, 'Bob Sample\nSample Furniture')).toEqual(['quoted-overlap', 'signature']);
        expect(primaryReason(reasonsAt(second, 'DISCLAIMER: This e-mail'))).toBe('signature');
        expect(reasonsAt(second, 'The delivery is planned')).toEqual([]);
        // In the first message only the signature detector can fold it.
        expect(reasonsAt(byIndex(out, 0), 'Bob Sample\nSample Furniture')).toEqual(['signature']);
    });

    it('folds a signature above a quote, but never one inside the quoted history (ownTextEnd)', () =>
    {
        const one = make({ from: [BOB], bodyText: `Hello Alice,\n\nThe quote follows after the visit.\n\n${BOB_SIGNATURE}\n` });
        const quoted = BOB_SIGNATURE.split('\n')
            .map((l) => `> ${l}`)
            .join('\n');
        const two = make({
            from: [BOB],
            bodyText: `Hello Alice,\n\nFriday works.\n\n${BOB_SIGNATURE}\n\nOn Mon, 3 Mar 2025 at 14:02, Bob Sample <bob@furniture.example.test> wrote:\n> Old text here.\n${quoted}\n`,
        });
        const out = analyzeThread([ok(one), ok(two)]);
        const message = byIndex(out, 1);
        expect(primaryReason(reasonsAt(message, 'Met vriendelijke groeten,'))).toBe('signature');
        const quoteAt = message.message.bodyText.indexOf('On Mon, 3 Mar');
        for (const segment of message.segments)
        {
            if (segment.end > quoteAt)
            {
                expect(segment.reasons).not.toContain('signature');
            }
        }
        expect(primaryReason(reasonsAt(message, 'On Mon, 3 Mar'))).toBe('reply-header');
    });
});

describe('analyzeThread: safety net (never lose text, even with a broken detector)', () =>
{
    const body = 'Hello Bob,\n\nThe desks arrive on Monday.\n\nAlice\n';

    it('shows the whole body when the segments do not cover it', () =>
    {
        const dropsLastChar = (text: string): Segment[] =>
            text.length < 2 ? [] : [{ start: 0, end: text.length - 1, folded: false, reasons: [], related: [] }];
        const out = analyzeThread(
            [ok(make({ bodyText: body })), ok(make({ bodyText: '' }))], { ...DEFAULT_THREAD_ANALYSIS_PARTS, buildSegments: dropsLastChar });
        const message = byIndex(out, 0);
        expect(message.segments).toEqual([{ start: 0, end: body.length, folded: false, reasons: [], related: [] }]);
        expect(message.threadAnalysisWarnings).toEqual(['folding-disabled']);
        // An empty body has no segments: that is valid, no warning.
        expect(byIndex(out, 1).segments).toEqual([]);
        expect(byIndex(out, 1).threadAnalysisWarnings).toEqual([]);
    });

    it('shows the whole body when the segments have the right text but a bad shape', () =>
    {
        // Covers the text, but folded without a reason: checkSegments rejects it.
        const badShape = (text: string): Segment[] => [{ start: 0, end: text.length, folded: true, reasons: [], related: [] }];
        const message = analyzeThread([ok(make({ bodyText: body }))], { ...DEFAULT_THREAD_ANALYSIS_PARTS, buildSegments: badShape }).messages[0]!;
        expect(message.segments.every((s) => !s.folded)).toBe(true);
        expect(message.threadAnalysisWarnings).toEqual(['folding-disabled']);
    });

    it('shows the whole body when building the segments throws', () =>
    {
        const throws = (): Segment[] =>
        {
            throw new Error('synthetic bug');
        };
        const message = analyzeThread([ok(make({ bodyText: body }))], { ...DEFAULT_THREAD_ANALYSIS_PARTS, buildSegments: throws }).messages[0]!;
        expect(joinSegments(body, message.segments)).toBe(body);
        expect(message.threadAnalysisWarnings).toEqual(['folding-disabled']);
    });

    it('skips a detector that throws and keeps the folds of the others', () =>
    {
        const quotedBody = `Thanks.\n\n> line one of the quote\n> line two of the quote\n`;
        const results = [ok(make({ bodyText: quotedBody })), ok(make({ bodyText: body }))];
        const out = analyzeThread(results, {
            ...DEFAULT_THREAD_ANALYSIS_PARTS,
            detectQuotedOverlap: () =>
            {
                throw new Error('synthetic bug');
            },
            // Fails for the second message only.
            detectReplyHeaders: (text) =>
            {
                if (text === body)
                {
                    throw new Error('synthetic bug');
                }
                return [];
            },
        });
        const first = byIndex(out, 0);
        expect(first.threadAnalysisWarnings).toEqual(['detector-failed']);
        expect(reasonsAt(first, '> line one')).toEqual(['quote-marker']);
        expect(byIndex(out, 1).threadAnalysisWarnings).toEqual(['detector-failed']);
        for (const message of out.messages)
        {
            expect(checkSegments(message.message.bodyText, message.segments)).toEqual([]);
            expect(joinSegments(message.message.bodyText, message.segments)).toBe(message.message.bodyText);
        }
    });

    it('survives detectors returning bad shapes (undefined, numbers, null entries, throwing getters)', () =>
    {
        // Detector results of the wrong runtime type, as a future bug could give.
        // Cast through `never`: the point is to break the declared types.
        const bad = (value: () => unknown): never => value as never;
        const throwingFold = (): FoldRange =>
        {
            const fold = { end: 3, reason: 'quote-marker' as const };
            Object.defineProperty(fold, 'start', {
                enumerable: true,
                get: () =>
                {
                    throw new Error('synthetic bug');
                },
            });
            return fold as FoldRange;
        };
        const quoted = 'Thanks.\n\n> line one of the quote\n> line two of the quote\n';
        const cases: { name: string; parts: Partial<ThreadAnalysisParts>; warnings: string[] }[] = [
            { name: 'overlap: undefined', parts: { detectQuotedOverlap: bad(() => undefined) }, warnings: ['detector-failed'] },
            { name: 'overlap: a number', parts: { detectQuotedOverlap: bad(() => 42) }, warnings: ['detector-failed'] },
            { name: 'overlap: entries null/undefined', parts: { detectQuotedOverlap: bad(() => [null, undefined]) }, warnings: ['detector-failed'] },
            { name: 'overlap: lists with null entries', parts: { detectQuotedOverlap: bad(() => [[null, undefined, 5], [null]]) }, warnings: [] },
            { name: 'signatures: undefined', parts: { detectSignatures: bad(() => undefined) }, warnings: ['detector-failed'] },
            { name: 'signatures: a string', parts: { detectSignatures: bad(() => 'oops') }, warnings: ['detector-failed'] },
            { name: 'signatures: throwing getter', parts: { detectSignatures: bad(() => [[throwingFold()], [throwingFold()]]) }, warnings: ['folding-disabled'] },
            { name: 'quote markers: undefined', parts: { detectQuoteMarkers: bad(() => undefined) }, warnings: ['detector-failed'] },
            { name: 'quote markers: a number', parts: { detectQuoteMarkers: bad(() => 7) }, warnings: ['detector-failed'] },
            { name: 'quote markers: a Set (iterable, not an array)', parts: { detectQuoteMarkers: bad(() => new Set()) }, warnings: ['detector-failed'] },
            { name: 'quote markers: null/undefined entries', parts: { detectQuoteMarkers: bad(() => [null, undefined, 3]) }, warnings: [] },
            { name: 'reply headers: throwing getter', parts: { detectReplyHeaders: bad(() => [throwingFold()]) }, warnings: ['detector-failed'] },
            { name: 'reply headers: null', parts: { detectReplyHeaders: bad(() => null) }, warnings: ['detector-failed'] },
        ];
        for (const testCase of cases)
        {
            const results = [ok(make({ bodyText: quoted })), ok(make({ bodyText: body }))];
            let out: ThreadAnalysisResult | undefined;
            expect(() => (out = analyzeThread(results, { ...DEFAULT_THREAD_ANALYSIS_PARTS, ...testCase.parts })), testCase.name).not.toThrow();
            for (const message of out!.messages)
            {
                expect(joinSegments(message.message.bodyText, message.segments), testCase.name).toBe(message.message.bodyText);
                expect(checkSegments(message.message.bodyText, message.segments), testCase.name).toEqual([]);
                expect(message.threadAnalysisWarnings, testCase.name).toEqual(testCase.warnings);
            }
        }
    });

    it('applies none of a per-message detector folds when reading a later entry throws', () =>
    {
        const throwing = { end: 30, reason: 'reply-header' as const };
        Object.defineProperty(throwing, 'start', {
            enumerable: true,
            get: () =>
            {
                throw new Error('synthetic bug');
            },
        });
        const out = analyzeThread([ok(make({ bodyText: body }))], {
            ...DEFAULT_THREAD_ANALYSIS_PARTS,
            detectReplyHeaders: () => [{ start: 0, end: 10, reason: 'reply-header' }, throwing as FoldRange],
        });
        const message = out.messages[0]!;
        expect(message.threadAnalysisWarnings).toEqual(['detector-failed']);
        expect(message.segments.some((s) => s.reasons.includes('reply-header'))).toBe(false);
        expect(message.segments.some((s) => s.folded)).toBe(false);
        expect(joinSegments(body, message.segments)).toBe(body);
        expect(checkSegments(body, message.segments)).toEqual([]);
    });

    it('does not let bad fold starts shrink ownTextEnd (the signature detector input)', () =>
    {
        let seen: readonly (number | undefined)[] = [];
        analyzeThread([ok(make({ bodyText: body }))], {
            ...DEFAULT_THREAD_ANALYSIS_PARTS,
            detectQuoteMarkers: () => [
                null as never,
                { start: '5' as never, end: 9, reason: 'quote-marker' },
                { start: -1, end: 9, reason: 'quote-marker' },
                { start: 2.5, end: 9, reason: 'quote-marker' },
            ],
            detectReplyHeaders: () => [{ start: 20, end: 30, reason: 'reply-header' }],
            detectSignatures: (inputs) =>
            {
                seen = inputs.map((i) => i.ownTextEnd);
                return inputs.map(() => []);
            },
        });
        expect(seen).toEqual([20]);
    });

    it('keeps every message on its own when de-duplication throws or returns a bad result', () =>
    {
        const original = make({ messageId: 'same@example.test' });
        const copy = { ...original, source: { ...original.source, fileName: 'copy.msg', kind: 'msg' as const } };
        const results = [ok(original), failure('x.eml'), ok(copy)];
        expect(analyzeThread(results).counts.duplicatesMerged).toBe(1); // the real dedupe merges them
        const broken: ((messages: readonly NormalizedMessage[]) => DedupeResult)[] = [
            () =>
            {
                throw new Error('synthetic bug');
            },
            // A message missing.
            (messages) => ({ kept: [{ message: messages[0]!, index: 0, duplicates: [], warnings: [] }], mergedCount: 0 }),
            // A duplicate index out of range.
            (messages) => ({
                kept: [{ message: messages[0]!, index: 0, duplicates: [{ source: copy.source, index: 9, rule: 'message-id' }], warnings: [] }],
                mergedCount: 1,
            }),
            // A message listed twice.
            (messages) => ({
                kept: [
                    { message: messages[0]!, index: 0, duplicates: [{ source: copy.source, index: 0, rule: 'message-id' }], warnings: [] },
                    { message: messages[1]!, index: 1, duplicates: [], warnings: [] },
                ],
                mergedCount: 1,
            }),
            // A warning pointing nowhere.
            (messages) => ({
                kept: messages.map((message, index) => ({
                    message,
                    index,
                    duplicates: [],
                    warnings: [{ code: 'same-id-different-content' as const, related: [-1], relatedTotal: 1 }],
                })),
                mergedCount: 0,
            }),
            // The right indices with the wrong message object: message 1's text would be lost.
            (messages) => ({
                kept: [
                    { message: messages[0]!, index: 0, duplicates: [], warnings: [] },
                    { message: messages[0]!, index: 1, duplicates: [], warnings: [] },
                ],
                mergedCount: 0,
            }),
            // A merged copy whose source is not the copy at its index.
            (messages) => ({
                kept: [{ message: messages[0]!, index: 0, duplicates: [{ source: original.source, index: 1, rule: 'message-id' }], warnings: [] }],
                mergedCount: 1,
            }),
            // Lists that are iterable but not arrays (the result is mapped afterwards).
            (messages) => ({
                kept: new Set(messages.map((message, index) => ({ message, index, duplicates: [], warnings: [] }))) as never,
                mergedCount: 0,
            }),
            (messages) => ({
                kept: [
                    { message: messages[0]!, index: 0, duplicates: new Set([{ source: copy.source, index: 1, rule: 'message-id' as const }]) as never, warnings: [] },
                ],
                mergedCount: 1,
            }),
            (messages) => ({
                kept: messages.map((message, index) => ({ message, index, duplicates: [], warnings: new Set() as never })),
                mergedCount: 0,
            }),
            (messages) => ({
                kept: messages.map((message, index) => ({
                    message,
                    index,
                    duplicates: [],
                    warnings: [{ code: 'same-id-different-content' as const, related: new Set([0, 1]) as never, relatedTotal: 2 }],
                })),
                mergedCount: 0,
            }),
        ];
        for (const dedupe of broken)
        {
            const out = analyzeThread(results, { ...DEFAULT_THREAD_ANALYSIS_PARTS, dedupe });
            expect(out.messages.map((m) => m.index).sort()).toEqual([0, 2]);
            expect(out.positionByIndex[1]).toBeNull();
            for (const message of out.messages)
            {
                expect(message.duplicates).toEqual([]);
                expect(message.dedupeWarnings).toEqual([]);
                expect(message.threadAnalysisWarnings).toEqual(['dedupe-failed']);
                expect(joinSegments(message.message.bodyText, message.segments)).toBe(message.message.bodyText);
            }
            expect(out.counts.duplicatesMerged).toBe(0);
        }
    });

    it('ignores bad fold ranges from a detector without losing text', () =>
    {
        const out = analyzeThread([ok(make({ bodyText: body }))], {
            ...DEFAULT_THREAD_ANALYSIS_PARTS,
            detectQuoteMarkers: () => [
                { start: -5, end: 1e9, reason: 'quote-marker' },
                { start: Number.NaN, end: 3, reason: 'quote-marker' },
                { start: 4, end: 2, reason: 'quote-marker' },
            ],
        });
        const message = out.messages[0]!;
        expect(joinSegments(body, message.segments)).toBe(body);
        expect(message.threadAnalysisWarnings).toEqual([]);
    });
});

describe('analyzeThread: very many folds (no stack overflow)', () =>
{
    it('handles a 4.8 MB body of alternating quote blocks with the real detectors', () =>
    {
        const body = 'Hi\n' + '> qq\n> rr\nplain\n'.repeat(300_000);
        const startTime = performance.now();
        let out: ThreadAnalysisResult | undefined;
        expect(() => (out = analyzeThread([ok(make({ bodyText: body }))]))).not.toThrow();
        const ms = performance.now() - startTime;
        console.log(`engine big body: ${(body.length / 1e6).toFixed(2)} MB, ${out!.messages[0]!.segments.length} segments, ${ms.toFixed(0)} ms`);
        const message = out!.messages[0]!;
        expect(joinSegments(body, message.segments)).toBe(body);
        expect(checkSegments(body, message.segments)).toEqual([]);
        expect(message.threadAnalysisWarnings).toEqual([]);
        expect(message.segments.filter((s) => s.folded).length).toBeGreaterThanOrEqual(300_000);
        expect(ms).toBeLessThan(30_000);
    }, 60_000);

    it('handles stub detectors returning about 300k ranges each', () =>
    {
        const body = 'ab\n'.repeat(300_000);
        const ranges = (reason: FoldReason): FoldRange[] =>
            Array.from({ length: 300_000 }, (_, i) => ({ start: i * 3, end: i * 3 + 2, reason }));
        const out = analyzeThread([ok(make({ bodyText: body }))], {
            ...DEFAULT_THREAD_ANALYSIS_PARTS,
            detectQuotedOverlap: (inputs) => inputs.map(() => ranges('quoted-overlap')),
            detectQuoteMarkers: () => ranges('quote-marker'),
            detectReplyHeaders: () => ranges('reply-header'),
            detectSignatures: (inputs) => inputs.map(() => ranges('signature')),
        });
        const message = out.messages[0]!;
        expect(joinSegments(body, message.segments)).toBe(body);
        expect(message.threadAnalysisWarnings).toEqual([]);
        expect(message.segments.length).toBe(600_000);
    }, 60_000);
});
