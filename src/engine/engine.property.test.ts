// Property tests for the engine pipeline (README.md, rules R6 and R7).
//
// Random synthetic threads (seeded, so every run is the same) go through
// runEngine, and the collapse-never-delete invariants are checked for every
// one of them:
// - the segments of every kept message are a valid cover of its body, and
//   joining them (or the "unfold all" view) gives the body back exactly;
// - every parsed message is either kept or listed as a duplicate of a kept
//   message with the same normalized body; exact copies are merged (by
//   Message-ID, or by author + date + body when neither copy has an id), and
//   copies sharing a Message-ID but with a different body are NOT merged;
// - the output order respects the dates; failed files are all listed;
// - nothing throws and the input is not modified;
// - rebuilding (task 7.5) only adds data: messages, segments, counts and
//   positions are the same as with rebuilding off; every rebuilt message is
//   its source body slice with only quote marks and indentation removed;
//   the timeline holds every kept message once, in order, and exactly the
//   rebuilt entries; every link points to a kept message or an entry.
// The same generator builds the large batch for the speed test.
//
// The random generator is a few lines (mulberry32), so no dependency is needed.
// Synthetic data only: reserved names and *.test / *.invalid addresses.

import { describe, expect, it } from 'vitest';
import type { EmailAddress, NormalizedMessage, ParseResult } from '../parsing/types';
import { normalizeBody, type DuplicateRule } from './dedupe';
import { DEFAULT_PARTS, runEngine, type EngineParts, type EngineResult, type EngineStage } from './engine';
import { checkSegments, FOLD_REASONS, reconstruct, visibleView, type FoldReason } from './segments';

// ------------------------------------------------------------- generator

/** mulberry32: a tiny seeded generator, returns numbers in [0, 1). */
function makeRandom(seed: number): () => number
{
    let a = seed >>> 0;
    return () =>
    {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

interface Person
{
    readonly mailbox: EmailAddress;
    readonly signature: string;
}

const PEOPLE: readonly Person[] = [
    { mailbox: { name: 'Alice Example', address: 'alice@example.test' }, signature: '-- \nAlice Example\nSent from my laptop' },
    {
        mailbox: { name: 'Bob Sample', address: 'bob@furniture.example.test' },
        signature: 'Met vriendelijke groeten,\nBob Sample\nSample Furniture - Showroom',
    },
    { mailbox: { name: 'Carol Test', address: 'carol@sample.invalid' }, signature: 'Cordialement,\nCarol Test\n\u00C9quipe Livraisons' },
];

// Accents, a decomposed letter (e + U+0301) and an emoji (a surrogate pair), via \u escapes.
const WORDS = (
    'desk chair table office delivery invoice quote room measure visit monday tuesday friday morning ' +
    'price order sample fabric colour meeting truck driver floor door key plan week ' +
    'caf\u00E9 \u00E9t\u00E9 na\u00EFve gr\u00FC\u00DFe Stra\u00DFe r\u00E9union li\u00E8ge ' +
    'cre\u0301che \uD83D\uDE00 \uD83D\uDCE6 10:00 2025 EUR 1,250'
).split(' ');

function pick<V>(random: () => number, list: readonly V[]): V
{
    return list[Math.floor(random() * list.length)]!;
}

/** Fresh text: 1 to 3 paragraphs (plus `extra`) of 1 to 3 lines of 4 to 13 words. */
function freshText(random: () => number, serial: number, extra: number): string
{
    const paragraphs: string[] = [];
    const count = 1 + extra + Math.floor(random() * 3);
    for (let p = 0; p < count; p++)
    {
        const lines: string[] = [];
        const lineCount = 1 + Math.floor(random() * 3);
        for (let l = 0; l < lineCount; l++)
        {
            const words = Array.from({ length: 4 + Math.floor(random() * 10) }, () => pick(random, WORDS));
            lines.push(words.join(' '));
        }
        paragraphs.push(lines.join('\n'));
    }
    // A unique first line, so two messages never share their opening text by chance.
    return `Note ${serial}: ${paragraphs.join('\n\n')}`;
}

/** The last `max` characters' worth of whole lines of `body` (long histories are cut, for size). */
function capped(body: string, max: number): string
{
    if (body.length <= max)
    {
        return body;
    }
    const cut = body.indexOf('\n', body.length - max);
    return cut < 0 ? body : body.slice(0, cut + 1);
}

type QuoteStyle = 'none' | 'marker' | 'outlook' | 'outlook-fr' | 'bare';

function quoteBlock(style: QuoteStyle, previous: string, author: Person, subject: string): string
{
    const plain = previous.replace(/\r\n/g, '\n');
    const addr = `${author.mailbox.name} <${author.mailbox.address}>`;
    switch (style)
    {
        case 'none':
            return '';
        case 'marker':
            return `\n\nOn Mon, 3 Mar 2025 at 14:02, ${addr} wrote:\n${plain
                .split('\n')
                .map((line) => (line === '' ? '>' : `> ${line}`))
                .join('\n')}\n`;
        case 'outlook':
            return `\n\n________________________________\nFrom: ${addr}\nSent: Monday, March 3, 2025 9:15 AM\nTo: Alice Example <alice@example.test>\nSubject: ${subject}\n\n${plain}`;
        case 'outlook-fr':
            return `\n\nDe : ${addr}\nEnvoy\u00E9 : lundi 3 mars 2025 09:15\n\u00C0 : Carol Test <carol@sample.invalid>\nObjet : ${subject}\n\n${plain}`;
        case 'bare':
            // Quoted without markers or header: only the overlap detector can see it.
            return `\n\n${plain}`;
    }
}

interface Batch
{
    readonly results: ParseResult[];
    /** Pairs [original, copy] of input positions that are exact copies and must be merged. */
    readonly copies: [number, number][];
    /** Pairs [original, other] with the same Message-ID but a different body: must NOT be merged. */
    readonly conflicts: [number, number][];
}

interface BatchOptions
{
    readonly threads: number;
    readonly maxMessages: number;
    readonly maxQuoteChars: number;
    /** Chances in [0, 1]. */
    readonly undated: number;
    readonly duplicate: number;
    readonly failed: number;
    readonly emptyBody: number;
    readonly crlf: number;
    readonly shuffle: boolean;
    /** True: exactly `threads` threads of exactly `maxMessages` messages (else random up to those). */
    readonly fixedShape?: boolean;
    /** Paragraphs added to every fresh text (default 0), to make bigger batches. */
    readonly extraParagraphs?: number;
}

const SMALL: BatchOptions = {
    threads: 4,
    maxMessages: 7,
    maxQuoteChars: 4000,
    undated: 0.1,
    duplicate: 0.15,
    failed: 0.05,
    emptyBody: 0.05,
    crlf: 0.2,
    shuffle: true,
};

const BASE_MS = Date.parse('2025-03-01T08:00:00Z');

/** Builds a random batch of parse results (threads, duplicates, failures), in a random drop order. */
function makeBatch(seed: number, options: BatchOptions): Batch
{
    const random = makeRandom(seed);
    const entries: { result: ParseResult; copyOf: number | null; conflictOf?: number }[] = [];
    let serial = 0;
    const threadCount = options.fixedShape === true ? options.threads : 1 + Math.floor(random() * options.threads);
    for (let t = 0; t < threadCount; t++)
    {
        const count = options.fixedShape === true ? options.maxMessages : 1 + Math.floor(random() * options.maxMessages);
        const ids: string[] = [];
        let previous = '';
        let previousAuthor = pick(random, PEOPLE);
        let clock = BASE_MS + Math.floor(random() * 30) * 86_400_000;
        for (let p = 0; p < count; p++)
        {
            serial++;
            const author = pick(random, PEOPLE);
            const subject = p === 0 ? `Thread ${t} about ${pick(random, WORDS)}` : `RE: Thread ${t}`;
            let body: string;
            if (random() < options.emptyBody)
            {
                body = '';
            }
            else
            {
                const signature = random() < 0.7 ? `\n\n${author.signature}` : '';
                const style: QuoteStyle = p === 0 ? 'none' : pick(random, ['none', 'marker', 'outlook', 'outlook-fr', 'bare'] as const);
                body = `${freshText(random, serial, options.extraParagraphs ?? 0)}${signature}${quoteBlock(style, capped(previous, options.maxQuoteChars), previousAuthor, subject)}\n`;
            }
            if (random() < options.crlf)
            {
                body = body.replace(/\n/g, '\r\n');
            }
            clock += 60_000 + Math.floor(random() * 5) * 3_600_000;
            const undated = random() < options.undated;
            const messageId = `t${t}-m${p}-s${seed}@example.test`;
            // Which kind of copy (if any) follows this message. 'author-date-body':
            // neither copy has a Message-ID, so only author + date + body can prove
            // they are the same (needs a date). 'conflict': same Message-ID, other body.
            const copyKind =
                random() < options.duplicate ? pick(random, ['message-id', 'author-date-body', 'conflict'] as const) : null;
            const noId = copyKind === 'author-date-body' && !undated;
            const message: NormalizedMessage = {
                messageId: noId ? null : messageId,
                inReplyTo: ids[ids.length - 1] ?? null,
                references: ids.slice(-10),
                date: undated
                    ? { utcMs: null, original: '', offsetMinutes: null, zoneKnown: false }
                    : { utcMs: clock, original: new Date(clock).toUTCString(), offsetMinutes: 0, zoneKnown: true },
                from: [author.mailbox],
                to: [previousAuthor.mailbox],
                cc: [],
                bcc: [],
                subject,
                bodyText: body,
                attachments: [],
                source: { fileName: `file-${serial}.eml`, sha256: serial.toString(16).padStart(64, '0'), kind: 'eml' },
                warnings: undated ? ['missing-date'] : [],
            };
            const original = entries.length;
            entries.push({ result: { ok: true, message }, copyOf: null });
            const copySource: NormalizedMessage['source'] = {
                fileName: `copy-${serial}.msg`,
                sha256: `c${serial.toString(16).padStart(63, '0')}`,
                kind: 'msg',
            };
            if (copyKind === 'conflict')
            {
                // Same Message-ID, different text (e.g. an edited re-send): both stay.
                const other: NormalizedMessage = { ...message, bodyText: `Edited ${freshText(random, serial, 0)}\n`, source: copySource };
                entries.push({ result: { ok: true, message: other }, copyOf: null, conflictOf: original });
            }
            else if (copyKind !== null)
            {
                // The same message from another export: other file, and maybe the
                // other line-end style (normalizeBody makes them equal).
                const swapped = body.includes('\r\n') ? body.replace(/\r\n/g, '\n') : body.replace(/\n/g, '\r\n');
                const copy: NormalizedMessage = { ...message, bodyText: random() < 0.5 ? swapped : body, source: copySource };
                entries.push({ result: { ok: true, message: copy }, copyOf: original });
            }
            if (random() < options.failed)
            {
                entries.push({
                    result: { ok: false, fileName: `broken-${serial}.eml`, sha256: null, error: 'corrupt', detail: 'damaged file structure: synthetic' },
                    copyOf: null,
                });
            }
            ids.push(messageId);
            previous = body;
            previousAuthor = author;
        }
    }
    // Drop order: shuffled (Fisher-Yates), keeping track of the copy pairs.
    const order = entries.map((_, i) => i);
    if (options.shuffle)
    {
        for (let i = order.length - 1; i > 0; i--)
        {
            const j = Math.floor(random() * (i + 1));
            [order[i], order[j]] = [order[j]!, order[i]!];
        }
    }
    const newPosition = new Map(order.map((old, position) => [old, position]));
    const results = order.map((old) => entries[old]!.result);
    const copies: [number, number][] = [];
    const conflicts: [number, number][] = [];
    entries.forEach((e, old) =>
    {
        if (e.copyOf !== null)
        {
            copies.push([newPosition.get(e.copyOf)!, newPosition.get(old)!]);
        }
        if (e.conflictOf !== undefined)
        {
            conflicts.push([newPosition.get(e.conflictOf)!, newPosition.get(old)!]);
        }
    });
    return { results, copies, conflicts };
}

// ------------------------------------------------------------- invariants

/** Checks every collapse-never-delete invariant of one engine run. */
function checkInvariants(
    results: readonly ParseResult[],
    out: EngineResult,
    copies: readonly [number, number][],
    conflicts: readonly [number, number][] = [],
): void
{
    // Failed files: every one listed, with its reason, in input order.
    const failedIndices = results.flatMap((r, i) => (r.ok ? [] : [i]));
    expect(out.failed.map((f) => f.index)).toEqual(failedIndices);
    for (const f of out.failed)
    {
        const r = results[f.index]!;
        if (r.ok)
        {
            throw new Error('listed as failed but parsed');
        }
        expect(f).toEqual({ index: f.index, fileName: r.fileName, sha256: r.sha256, error: r.error, detail: r.detail });
    }

    // Every parsed message: kept or a duplicate of a kept one, exactly once.
    const seen = new Map<number, number>();
    out.messages.forEach((m, position) =>
    {
        for (const i of [m.index, ...m.duplicates.map((d) => d.index)])
        {
            expect(seen.has(i), `input ${i} listed twice`).toBe(false);
            seen.set(i, position);
        }
    });
    results.forEach((r, i) =>
    {
        expect(seen.get(i) ?? null).toBe(r.ok ? out.positionByIndex[i] : null);
        if (r.ok)
        {
            expect(seen.has(i), `input ${i} lost`).toBe(true);
        }
    });
    for (const [a, b] of copies)
    {
        expect(out.positionByIndex[a], `copy ${b} of ${a} not merged`).toBe(out.positionByIndex[b]);
    }
    // Same Message-ID, different body: never merged, and both say why.
    for (const [a, b] of conflicts)
    {
        expect(out.positionByIndex[a], `conflicting ${b} merged into ${a}`).not.toBe(out.positionByIndex[b]);
        for (const i of [a, b])
        {
            const kept = out.messages[out.positionByIndex[i]!]!;
            expect(kept.dedupeWarnings.map((w) => w.code)).toContain('same-id-different-content');
        }
    }

    for (const m of out.messages)
    {
        const r = results[m.index]!;
        expect(r.ok && r.message).toBe(m.message); // the same object, never a rewritten copy
        const body = m.message.bodyText;
        // The core rule: the body is fully recoverable from the output.
        expect(checkSegments(body, m.segments)).toEqual([]);
        expect(reconstruct(body, m.segments)).toBe(body);
        const unfolded = visibleView(body, m.segments, { unfoldAll: true });
        expect(unfolded.map((b) => b.text).join('')).toBe(body);
        expect(unfolded.some((b) => b.collapsed)).toBe(false);
        expect(visibleView(body, m.segments, { unfoldAll: false }).map((b) => b.text).join('')).toBe(body);
        expect(m.engineWarnings).toEqual([]);
        expect(m.parserWarnings).toBe(m.message.warnings);
        for (const s of m.segments)
        {
            for (const rel of s.related)
            {
                expect(out.positionByIndex[rel]).not.toBeNull();
            }
        }
        // Merged copies: provably identical, so same normalized body.
        for (const d of m.duplicates)
        {
            const copy = results[d.index]!;
            if (!copy.ok)
            {
                throw new Error('a failed file listed as a duplicate');
            }
            expect(normalizeBody(copy.message.bodyText)).toBe(normalizeBody(body));
            expect(d.source).toBe(copy.message.source);
        }
    }

    // Order: dated messages first, by date; then undated ones by input position.
    let lastMs = -Infinity;
    let lastUndated = -1;
    let undatedSeen = false;
    for (const m of out.messages)
    {
        if (m.order === 'by-date')
        {
            expect(undatedSeen).toBe(false);
            expect(m.message.date.utcMs).not.toBeNull();
            expect(m.message.date.utcMs!).toBeGreaterThanOrEqual(lastMs);
            lastMs = m.message.date.utcMs!;
        }
        else
        {
            undatedSeen = true;
            expect(m.message.date.utcMs).toBeNull();
            expect(m.index).toBeGreaterThan(lastUndated);
            lastUndated = m.index;
        }
    }

    const parsedCount = results.filter((r) => r.ok).length;
    expect(out.counts).toEqual({
        filesGiven: results.length,
        messagesFound: parsedCount,
        duplicatesMerged: parsedCount - out.messages.length,
        filesFailed: failedIndices.length,
        undated: out.messages.filter((m) => m.order === 'file-order').length,
        withFolds: out.messages.filter((m) => m.segments.some((s) => s.folded)).length,
    });
}

/**
 * True if `text` is `slice` with only quote marks (">") and spacing
 * (whitespace other than line breaks) removed: an independent check of
 * reconstruct.ts step 4, letter by letter.
 */
function onlyMarksRemoved(slice: string, text: string): boolean
{
    const removable = (ch: string): boolean => ch === '>' || (ch !== '\n' && /\s/u.test(ch));
    let j = 0;
    for (let i = 0; i < text.length; i++)
    {
        while (j < slice.length && slice[j] !== text[i])
        {
            if (!removable(slice[j]!))
            {
                return false;
            }
            j++;
        }
        if (j >= slice.length)
        {
            return false;
        }
        j++;
    }
    for (; j < slice.length; j++)
    {
        if (!removable(slice[j]!))
        {
            return false;
        }
    }
    return true;
}

const NO_REBUILD: EngineParts = { ...DEFAULT_PARTS, reconstructQuotedMessages: () => [] };

/** The rebuild invariants of one engine run (see the file comment); `baseline` = the same run with rebuilding off. */
function checkRebuilt(out: EngineResult, baseline?: EngineResult): void
{
    if (baseline !== undefined)
    {
        expect(out.messages).toEqual(baseline.messages);
        expect(out.failed).toEqual(baseline.failed);
        expect(out.counts).toEqual(baseline.counts);
        expect(out.positionByIndex).toEqual(baseline.positionByIndex);
    }
    const keptAt = (index: number | null): boolean => index !== null && out.messages[out.positionByIndex[index] ?? -1]?.index === index;
    const bySource = new Map<number, number[]>();
    out.reconstructed.forEach((r, id) =>
    {
        expect(r.id).toBe(id);
        expect(keptAt(r.sourceIndex), `rebuilt ${id}: source`).toBe(true);
        const body = out.messages[out.positionByIndex[r.sourceIndex]!]!.message.bodyText;
        const { start, headerEnd, end, depth } = r.rebuilt;
        expect(0 <= start && start < headerEnd && headerEnd <= end && end <= body.length, `rebuilt ${id}: offsets`).toBe(true);
        const slice = body.slice(headerEnd, end);
        expect(onlyMarksRemoved(slice, r.rebuilt.reconstructedText), `rebuilt ${id}: text`).toBe(true);
        if (depth === 0)
        {
            expect(r.rebuilt.reconstructedText).toBe(slice);
        }
        expect(r.rebuilt.quoteMarksRemoved).toBe(depth > 0);
        const list = bySource.get(r.sourceIndex) ?? [];
        list.push(id);
        bySource.set(r.sourceIndex, list);
        if (r.link === 'real')
        {
            expect(keptAt(r.realIndex), `rebuilt ${id}: real link`).toBe(true);
            expect(r.realIndex).not.toBe(r.sourceIndex);
            expect(r.match).not.toBeNull();
        }
        else if (r.link === 'same-as')
        {
            const entry = out.reconstructed[r.sameAs ?? -1];
            expect(entry?.link, `rebuilt ${id}: same-as`).toBe('entry');
            expect(entry?.copies).toContain(id);
            expect(entry?.sourceIndex).not.toBe(r.sourceIndex);
        }
        else
        {
            for (const c of r.copies)
            {
                expect(out.reconstructed[c]?.sameAs).toBe(id);
            }
            expect(r.alsoQuotedIn).toEqual([...new Set(r.copies.map((c) => out.reconstructed[c]!.sourceIndex))].sort((a, b) => a - b));
        }
    });
    // Per source: generations 1, 2, ... in body order, never overlapping.
    for (const ids of bySource.values())
    {
        let end = 0;
        ids.forEach((id, k) =>
        {
            const r = out.reconstructed[id]!.rebuilt;
            expect(r.generation).toBe(k + 1);
            expect(r.start).toBeGreaterThanOrEqual(end);
            end = r.end;
        });
    }
    // Timeline: every kept message once, in order; exactly the entries, once each.
    expect(out.timeline.flatMap((e) => (e.kind === 'message' ? [e.position] : []))).toEqual(out.messages.map((_, p) => p));
    const entries = out.timeline.flatMap((e) => (e.kind === 'rebuilt' ? [e.id] : []));
    expect([...entries].sort((a, b) => a - b)).toEqual(out.reconstructed.filter((r) => r.link === 'entry').map((r) => r.id));
    expect(out.reconstructionWarnings).toEqual([]);
}

/**
 * Heuristic for this generator: every fresh text opens with a unique
 * "Note N:", so a rebuilt message and the real message (or the copy) it is
 * linked to must open with the same N. Returns the links that do not.
 */
function wrongLinks(out: EngineResult): string[]
{
    const serial = (text: string): string | null => /Note (\d+):/u.exec(text)?.[1] ?? null;
    const wrong: string[] = [];
    for (const r of out.reconstructed)
    {
        const mine = serial(r.rebuilt.reconstructedText);
        if (mine === null || r.link === 'entry')
        {
            continue;
        }
        const other =
            r.link === 'real'
                ? serial(out.messages[out.positionByIndex[r.realIndex!]!]!.message.bodyText)
                : serial(out.reconstructed[r.sameAs!]!.rebuilt.reconstructedText);
        if (other !== mine)
        {
            wrong.push(`rebuilt ${r.id} (Note ${mine}) linked to Note ${other ?? '?'}`);
        }
    }
    return wrong;
}

/** First non-blank line of a body, with its offset. */
function firstLine(body: string): { at: number; text: string } | null
{
    const match = /[^\r\n]*\S[^\r\n]*/.exec(body);
    return match === null ? null : { at: match.index, text: match[0] };
}

// ------------------------------------------------------------------ tests

describe('runEngine: collapse-never-delete over random synthetic threads', () =>
{
    it('keeps every invariant for 300 seeded batches', () =>
    {
        let messages = 0;
        let folded = 0;
        let duplicates = 0;
        let undated = 0;
        let failed = 0;
        const reasonsSeen = new Map<FoldReason, number>();
        const rulesSeen = new Map<DuplicateRule, number>();
        let conflictCount = 0;
        let rebuilt = 0;
        const links = new Map<string, number>();
        for (let seed = 1; seed <= 300; seed++)
        {
            const { results, copies, conflicts } = makeBatch(seed, SMALL);
            const snapshot = JSON.stringify(results);
            let out: EngineResult | undefined;
            expect(() => (out = runEngine(results)), `seed ${seed}`).not.toThrow();
            if (out === undefined)
            {
                throw new Error('no result');
            }
            expect(JSON.stringify(results), `seed ${seed}: input modified`).toBe(snapshot);
            checkInvariants(results, out, copies, conflicts);
            checkRebuilt(out, seed % 5 === 0 ? runEngine(results, NO_REBUILD) : undefined);
            rebuilt += out.reconstructed.length;
            expect(wrongLinks(out), `seed ${seed}`).toEqual([]);
            for (const r of out.reconstructed)
            {
                links.set(r.link, (links.get(r.link) ?? 0) + 1);
            }
            conflictCount += conflicts.length;
            for (const m of out.messages)
            {
                for (const s of m.segments)
                {
                    for (const r of s.reasons)
                    {
                        reasonsSeen.set(r, (reasonsSeen.get(r) ?? 0) + 1);
                    }
                }
                for (const d of m.duplicates)
                {
                    rulesSeen.set(d.rule, (rulesSeen.get(d.rule) ?? 0) + 1);
                }
            }
            // Heuristic, but holds for this generator: each message opens with its
            // own new text, and no detector folds it.
            for (const m of out.messages)
            {
                const line = firstLine(m.message.bodyText);
                if (line === null)
                {
                    continue;
                }
                const covering = m.segments.filter((s) => s.start < line.at + line.text.length && s.end > line.at);
                expect(covering.every((s) => !s.folded), `seed ${seed}: first line of input ${m.index} folded`).toBe(true);
            }
            // The result is plain data: a structured clone is equal to it.
            expect(structuredClone(out)).toEqual(out);
            messages += out.counts.messagesFound;
            folded += out.counts.withFolds;
            duplicates += out.counts.duplicatesMerged;
            undated += out.counts.undated;
            failed += out.counts.filesFailed;
        }
        console.log(
            `engine property test: 300 batches, ${messages} messages, ${duplicates} duplicates merged, ` +
                `${undated} undated, ${failed} failed files, ${folded} kept messages with folds, ` +
                `${conflictCount} same-id conflicts; fold reasons ${JSON.stringify(Object.fromEntries(reasonsSeen))}, ` +
                `dedupe rules ${JSON.stringify(Object.fromEntries(rulesSeen))}, ` +
                `${rebuilt} rebuilt messages, links ${JSON.stringify(Object.fromEntries(links))}`,
        );
        // Not vacuous: the generator really produced each case.
        expect(folded).toBeGreaterThan(300);
        expect(duplicates).toBeGreaterThan(50);
        expect(undated).toBeGreaterThan(50);
        expect(failed).toBeGreaterThan(20);
        expect(conflictCount).toBeGreaterThan(10);
        expect(rebuilt).toBeGreaterThan(300);
        expect(links.get('entry') ?? 0).toBeGreaterThan(50);
        for (const reason of FOLD_REASONS)
        {
            expect(reasonsSeen.get(reason) ?? 0, `fold reason ${reason}`).toBeGreaterThan(0);
        }
        for (const rule of ['message-id', 'author-date-body'] as const)
        {
            expect(rulesSeen.get(rule) ?? 0, `dedupe rule ${rule}`).toBeGreaterThan(0);
        }
        // About 1.5 s alone; far slower when every test file runs at once. No speed claim here (see the speed test below).
    }, 60_000);

    it('keeps every invariant with no files, only failed files or only empty bodies', () =>
    {
        const fail = (n: number): ParseResult => ({ ok: false, fileName: `bad-${n}.msg`, sha256: null, error: 'too-large', detail: 'over the size limit' });
        const allFailed = [fail(1), fail(2)];
        checkInvariants(allFailed, runEngine(allFailed), []);
        expect(runEngine(allFailed).messages).toEqual([]);
        checkInvariants([], runEngine([]), []);
        const empty = makeBatch(7, { ...SMALL, emptyBody: 1, duplicate: 0, failed: 0 });
        const out = runEngine(empty.results);
        checkInvariants(empty.results, out, empty.copies, empty.conflicts);
        checkRebuilt(out, runEngine(empty.results, NO_REBUILD));
        for (const m of out.messages)
        {
            expect(m.segments).toEqual([]);
        }
    });
});

describe('runEngine: speed on a large batch', () =>
{
    it('runs 2000 messages in 50 threads (about 5 MB) within a generous bound', () =>
    {
        const batch = makeBatch(2025, {
            threads: 50,
            maxMessages: 40,
            fixedShape: true,
            maxQuoteChars: 6000,
            extraParagraphs: 4,
            undated: 0.02,
            duplicate: 0.02,
            failed: 0.005,
            emptyBody: 0.01,
            crlf: 0.2,
            shuffle: true,
        });
        const chars = batch.results.reduce((n, r) => n + (r.ok ? r.message.bodyText.length : 0), 0);

        const times = new Map<EngineStage, number>();
        let current: EngineStage | null = null;
        let since = 0;
        const t0 = performance.now();
        const out = runEngine(batch.results, {
            ...DEFAULT_PARTS,
            onStage: (stage) =>
            {
                const now = performance.now();
                if (current !== null)
                {
                    times.set(current, now - since);
                }
                current = stage;
                since = now;
            },
        });
        const total = performance.now() - t0;
        const row = [...times].map(([stage, ms]) => `${stage} ${ms.toFixed(0)} ms`).join(', ');
        console.log(
            `engine speed: ${batch.results.length} files, ${(chars / 1e6).toFixed(2)} MB of body text, ` +
                `total ${total.toFixed(0)} ms (${row})`,
        );
        expect(batch.results.length).toBeGreaterThanOrEqual(2000);
        expect(chars).toBeGreaterThan(4_000_000);
        checkInvariants(batch.results, out, batch.copies, batch.conflicts);
        checkRebuilt(out);
        expect(total).toBeLessThan(30_000);
    }, 60_000);
});
