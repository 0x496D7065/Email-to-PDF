// Tests for step 6 of the engine (task 7.5): messages rebuilt from quoted
// text, their links and the timeline, and the safety net around them
// (README.md, rules R6 and R7). Synthetic data only. The linking rules
// themselves are tested in rebuild-links.test.ts, the targets over the
// generated conversations in rebuild-links.measure.test.ts.

import { describe, expect, it } from 'vitest';
import type { EmailAddress, NormalizedMessage, ParseResult } from '../parsing/types';
import { buildThread } from '../../tests/support/thread-builder';
import { chain } from '../../tests/support/thread-cases';
import { DEFAULT_PARTS, runEngine, type EngineParts, type EngineResult } from './engine';
import { MAX_RECONSTRUCTED, MAX_SOURCE_LENGTH, reconstructQuotedMessages, type ReconstructedMessage } from './reconstruct';
import { reconstruct } from './segments';

const ALICE: EmailAddress = { name: 'Alice Example', address: 'alice@example.test' };

let counter = 0;
function make(fields: Partial<NormalizedMessage> = {}): NormalizedMessage
{
    counter++;
    return {
        messageId: `rebuild-${counter}@example.test`,
        inReplyTo: null,
        references: [],
        date: { utcMs: Date.parse('2025-03-05T12:00:00Z') + counter * 60_000, original: '', offsetMinutes: 60, zoneKnown: true },
        from: [ALICE],
        to: [],
        cc: [],
        bcc: [],
        subject: 'Re: Desks',
        bodyText: `Hello, note ${counter}.\n`,
        attachments: [],
        source: { fileName: `rebuild-${counter}.eml`, sha256: counter.toString(16).padStart(64, '0'), kind: 'eml' },
        warnings: [],
        ...fields,
    };
}
const ok = (message: NormalizedMessage): ParseResult => ({ ok: true, message });

/** The last email of a 4-message Gmail conversation (3 quoted generations). */
const THREAD = buildThread(chain(['gmail-en', 'gmail-en', 'gmail-en']));
const last = (): NormalizedMessage => make({ bodyText: THREAD.body, subject: THREAD.subject, date: { utcMs: Date.parse(THREAD.instantUtc), original: '', offsetMinutes: 0, zoneKnown: true } });

const NO_REBUILD: EngineParts = { ...DEFAULT_PARTS, reconstructQuotedMessages: () => [] };

/** Everything the app used before task 7.5. */
const realPart = (out: EngineResult): unknown => ({ messages: out.messages, failed: out.failed, counts: out.counts, positionByIndex: out.positionByIndex });

describe('runEngine: rebuilt messages (step 6)', () =>
{
    it('adds rebuilt messages and a timeline, and changes nothing else', () =>
    {
        const results = [ok(make()), { ok: false as const, fileName: 'x.eml', sha256: null, error: 'corrupt' as const, detail: 'synthetic' }, ok(last())];
        const out = runEngine(results);
        expect(realPart(out)).toEqual(realPart(runEngine(results, NO_REBUILD)));
        expect(out.reconstructed.map((r) => [r.sourceIndex, r.rebuilt.generation, r.link])).toEqual([
            [2, 1, 'entry'],
            [2, 2, 'entry'],
            [2, 3, 'entry'],
        ]);
        expect(out.reconstructed.map((r) => r.rebuilt.start)).toEqual(THREAD.headers.map((h) => h.start));
        // The conversation, oldest first, before the email that quotes it; the other email (dated later) last.
        // Generation 2's header shows its time in another zone than the source's, so
        // its estimate (read in the source's zone) is later than generation 1's: capped.
        expect(out.timeline).toEqual([
            { kind: 'rebuilt', id: 2, placement: 'by-date' },
            { kind: 'rebuilt', id: 1, placement: 'capped-by-quoter' },
            { kind: 'rebuilt', id: 0, placement: 'by-date' },
            { kind: 'message', position: 0 },
            { kind: 'message', position: 1 },
        ]);
        expect(out.messages[0]?.index).toBe(2);
        expect(out.reconstructionWarnings).toEqual([]);
        expect(structuredClone(out)).toEqual(out);
    });

    it('gives the rebuilder the body, the subject and the offset of the Date header', () =>
    {
        const calls: unknown[] = [];
        const m = make({ subject: 'Fwd: Desks', date: { utcMs: 1, original: '', offsetMinutes: -330, zoneKnown: true } });
        runEngine([ok(m)], { ...DEFAULT_PARTS, reconstructQuotedMessages: (body, options) => (calls.push([body, options]), []) });
        expect(calls).toEqual([[m.bodyText, { subject: 'Fwd: Desks', sourceOffsetMinutes: -330 }]]);
    });

    it('keeps the incomplete fields of a header read short (for the preview and the PDF)', () =>
    {
        const wrapped = buildThread(chain(['outlook-nl', 'outlook-nl'], { quote: { people: 'name', wrapAt: 60 }, moreTo: [ALICE, ALICE, ALICE, ALICE] }));
        const out = runEngine([ok(make({ bodyText: wrapped.body, subject: wrapped.subject }))]);
        expect(out.reconstructed.some((r) => r.rebuilt.incomplete.length > 0)).toBe(true);
    });
});

describe('runEngine: rebuilding safety net', () =>
{
    it('a rebuilder that throws for one email: a warning for it, the others rebuilt, the real messages unchanged', () =>
    {
        const bad = last();
        const good = make({ bodyText: THREAD.body.replace('Hello', 'Hi') });
        const results = [ok(good), ok(bad)];
        const out = runEngine(results, {
            ...DEFAULT_PARTS,
            reconstructQuotedMessages: (body, options) =>
            {
                if (body === bad.bodyText)
                {
                    throw new Error('synthetic bug');
                }
                return reconstructQuotedMessages(body, options);
            },
        });
        expect(realPart(out)).toEqual(realPart(runEngine(results)));
        expect(out.reconstructionWarnings).toEqual([{ index: 1, code: 'reconstruct-failed' }]);
        expect(out.reconstructed.length).toBe(3);
        expect(out.reconstructed.every((r) => r.sourceIndex === 0)).toBe(true);
    });

    const body = THREAD.body;
    const real = reconstructQuotedMessages(body, { subject: THREAD.subject, sourceOffsetMinutes: 0 });
    const first = real[0] as ReconstructedMessage;
    const withFirst = (changes: Record<string, unknown>): unknown[] => [{ ...first, ...changes }, ...real.slice(1)];
    const throwingGetter = (): unknown =>
    {
        const r: Record<string, unknown> = { ...first };
        Object.defineProperty(r, 'end', {
            enumerable: true,
            get: () =>
            {
                throw new Error('synthetic bug');
            },
        });
        return [r];
    };
    it.each([
        ['not a list', () => 'oops'],
        ['a Set', () => new Set(real)],
        ['a null entry', () => [null]],
        ['text that is not the source slice', () => withFirst({ reconstructedText: `${first.reconstructedText}!` })],
        ['text with its quote marks kept but depth 0', () => withFirst({ depth: 0, quoteMarksRemoved: false })],
        ['end past the body', () => withFirst({ end: body.length + 1 })],
        ['overlapping messages', () => [first, { ...real[1], start: first.start }]],
        ['a wrong generation', () => withFirst({ generation: 2 })],
        ['a header end before its start', () => withFirst({ headerEnd: first.start })],
        ['a bad date', () => withFirst({ date: { text: 'x', wallMs: 'soon', precision: 'minute', estimatedUtcMs: 1, basis: 'none' } })],
        ['a bad sender', () => withFirst({ from: [{ name: 1, address: '' }] })],
        ['a bad incomplete list', () => withFirst({ incomplete: ['bcc'] })],
        ['quoteMarksRemoved not matching the depth', () => withFirst({ quoteMarksRemoved: false })],
        ['a getter that throws', throwingGetter],
        ['too many messages', () => Array.from({ length: MAX_RECONSTRUCTED + 1 }, () => first)],
    ])('an invalid rebuilder result (%s): nothing rebuilt from that email, a warning', (_label, result) =>
    {
        const out = runEngine([ok(last())], { ...DEFAULT_PARTS, reconstructQuotedMessages: result as never });
        expect(out.reconstructed).toEqual([]);
        expect(out.timeline).toEqual([{ kind: 'message', position: 0 }]);
        expect(out.reconstructionWarnings).toEqual([{ index: 0, code: 'reconstruct-failed' }]);
        expect(out.messages[0]?.engineWarnings).toEqual([]);
    });

    it('copies only the known fields of a rebuilt message (plain data)', () =>
    {
        const out = runEngine([ok(last())], { ...DEFAULT_PARTS, reconstructQuotedMessages: () => [{ ...first, extra: () => 1 }] as never });
        expect(out.reconstructed[0]?.rebuilt).toEqual(first);
        expect(structuredClone(out)).toEqual(out);
    });

    it('a body over MAX_SOURCE_LENGTH is not rebuilt: a limit warning', () =>
    {
        let called = false;
        const huge = make({ bodyText: 'a'.repeat(MAX_SOURCE_LENGTH + 1) });
        const out = runEngine([ok(huge)], {
            detectQuotedOverlap: (inputs) => inputs.map(() => []),
            detectQuoteMarkers: () => [],
            detectReplyHeaders: () => [],
            detectSignatures: (inputs) => inputs.map(() => []),
            buildSegments: (b) => [{ start: 0, end: b.length, folded: false, reasons: [], related: [] }],
            reconstructQuotedMessages: () => ((called = true), []),
        });
        expect(called).toBe(false);
        expect(out.reconstructionWarnings).toEqual([{ index: 0, code: 'reconstruct-limit' }]);
        expect(out.timeline).toEqual([{ kind: 'message', position: 0 }]);
    });

    it('MAX_RECONSTRUCTED messages rebuilt from one email: kept, with a limit warning (there may be more)', () =>
    {
        const long = buildThread(chain(Array.from({ length: MAX_RECONSTRUCTED + 1 }, () => 'outlook-en' as const)));
        const out = runEngine([ok(make({ bodyText: long.body, subject: long.subject }))]);
        expect(out.reconstructed.length).toBe(MAX_RECONSTRUCTED);
        expect(out.reconstructionWarnings).toEqual([{ index: 0, code: 'reconstruct-limit' }]);
        expect(out.timeline.length).toBe(MAX_RECONSTRUCTED + 1);
    }, 60_000);

    it.each([
        [
            'throws',
            () =>
            {
                throw new Error('synthetic bug');
            },
        ],
        ['drops a real message from the timeline', () => ({ reconstructed: [], timeline: [] })],
        ['reorders the real messages', () => ({ reconstructed: [], timeline: [{ kind: 'message', position: 1 }, { kind: 'message', position: 0 }] })],
        ['lists a linked rebuilt message as an entry', () => ({ reconstructed: [{ id: 0, link: 'real' }], timeline: [{ kind: 'rebuilt', id: 0 }, { kind: 'message', position: 0 }, { kind: 'message', position: 1 }] })],
        ['leaves out an entry', () => ({ reconstructed: [{ id: 0, link: 'entry' }], timeline: [{ kind: 'message', position: 0 }, { kind: 'message', position: 1 }] })],
    ])('linking that %s: nothing rebuilt, every message warned, the real messages unchanged', (_label, link) =>
    {
        const results = [ok(make()), ok(last())];
        const out = runEngine(results, { ...DEFAULT_PARTS, linkRebuilt: link as never });
        expect(realPart(out)).toEqual(realPart(runEngine(results)));
        expect(out.reconstructed).toEqual([]);
        expect(out.timeline).toEqual([
            { kind: 'message', position: 0 },
            { kind: 'message', position: 1 },
        ]);
        // In the order of the messages: the quoting email is the older one.
        expect(out.reconstructionWarnings).toEqual([
            { index: 1, code: 'reconstruct-failed' },
            { index: 0, code: 'reconstruct-failed' },
        ]);
    });
});

describe('runEngine: quoted history the splitter did not rebuild (7.4 review note)', () =>
{
    // The oldest quoted message gets a line one level less deep than its body:
    // the splitter refuses its header (rule R4) and drops the message holding
    // it, so only generation 1 is kept and everything after its end is in no
    // rebuilt message.
    const broken = THREAD.body.replace('>>> We are furnishing', '>> We are furnishing');
    const h2 = THREAD.headers[1]!.start;

    it('the splitter stops early here (precondition)', () =>
    {
        expect(broken).not.toBe(THREAD.body);
        const kept = reconstructQuotedMessages(broken, { subject: THREAD.subject, sourceOffsetMinutes: 0 });
        expect(kept.map((r) => [r.generation, r.end])).toEqual([[1, h2]]);
    });

    it('nothing marks that tail as rebuilt or hides it, even when its messages are dropped as real files', () =>
    {
        const messages = chain(['gmail-en', 'gmail-en', 'gmail-en']);
        const source = make({ bodyText: broken, subject: THREAD.subject });
        // The two oldest messages of the tail, dropped as real files.
        const older = [0, 1].map((i) =>
            make({ from: [messages[i]!.from], bodyText: buildThread(messages.slice(0, i + 1)).body, date: { utcMs: Date.parse('2025-03-03T08:15:00Z') + i * 18_420_000, original: '', offsetMinutes: 60, zoneKnown: true } }),
        );
        const results = [ok(source), ...older.map(ok)];
        const out = runEngine(results);
        expect(realPart(out)).toEqual(realPart(runEngine(results, NO_REBUILD)));
        const fromSource = out.reconstructed.filter((r) => r.sourceIndex === 0);
        expect(fromSource.length).toBe(1);
        for (const r of fromSource)
        {
            expect(r.rebuilt.end).toBeLessThanOrEqual(h2);
        }
        // Every rebuilt message from any email stays inside its own source's rebuilt range.
        for (const r of out.reconstructed)
        {
            expect(r.sourceIndex === 0 ? r.rebuilt.end <= h2 : true).toBe(true);
        }
        // The tail is still shown by the source message itself, whole.
        const kept = out.messages[out.positionByIndex[0]!]!;
        expect(reconstruct(broken, kept.segments)).toBe(broken);
        expect(kept.segments.filter((s) => s.end > h2).map((s) => broken.slice(Math.max(s.start, h2), s.end)).join('')).toBe(broken.slice(h2));
        // And every real message is in the timeline.
        expect(out.timeline.filter((e) => e.kind === 'message').length).toBe(3);
    });
});
