// Tests for chronological ordering (README.md, rule R7). Synthetic data only:
// only the fields the ordering reads are built.

import { describe, expect, it } from 'vitest';
import { orderMessages, type Orderable } from './chronological-order';
import { MAX_DISPLAYABLE_MS, MIN_DISPLAYABLE_MS } from './time-format';

interface Item extends Orderable
{
    readonly label: string;
}

/** A minimal entry: a label for the assertions, a date (or null) and an input position. */
function item(label: string, utcMs: number | null, index: number): Item
{
    return { label, index, message: { date: { utcMs } } };
}

/** Builds entries with `index` = array position, like dedupe's `kept`. */
function items(...specs: [string, number | null][]): Item[]
{
    return specs.map(([label, utcMs], index) => item(label, utcMs, index));
}

const T = (iso: string): number => Date.parse(iso);

function labels(result: ReturnType<typeof orderMessages<Item>>): string[]
{
    return result.map((entry) => entry.item.label);
}

/** Deterministic shuffle (small linear congruential generator), so failures can be replayed. */
function shuffled<V>(values: readonly V[], seed: number): V[]
{
    const copy = [...values];
    let state = seed;
    for (let i = copy.length - 1; i > 0; i--)
    {
        state = (state * 1103515245 + 12345) % 2147483648;
        const j = state % (i + 1);
        [copy[i], copy[j]] = [copy[j] as V, copy[i] as V];
    }
    return copy;
}

describe('orderMessages', () =>
{
    it('returns an empty array for no input', () =>
    {
        expect(orderMessages([])).toEqual([]);
    });

    it('sorts dated messages oldest first by their UTC moment', () =>
    {
        const input = items(
            ['c', T('2025-04-02T12:00:00Z')],
            ['a', T('2025-04-01T08:00:00Z')],
            ['b', T('2025-04-02T09:00:00Z')],
        );
        const result = orderMessages(input);
        expect(labels(result)).toEqual(['a', 'b', 'c']);
        expect(result.every((entry) => entry.order === 'by-date')).toBe(true);
    });

    it('orders by the true instant, not by the local clock time of each sender', () =>
    {
        // 10:00 in Tokyo (+09:00) is 01:00 UTC; 05:00 in New York (-04:00) is 09:00 UTC.
        // The parser already turned both into utcMs, so the "later-looking" 10:00 comes first.
        const input = items(['ny-0500', T('2025-04-02T05:00:00-04:00')], ['tokyo-1000', T('2025-04-02T10:00:00+09:00')]);
        expect(labels(orderMessages(input))).toEqual(['tokyo-1000', 'ny-0500']);
    });

    it('breaks ties on the same instant by the lower input index', () =>
    {
        const same = T('2025-04-02T09:00:00Z');
        const input = [item('second', same, 7), item('first', same, 2), item('earlier', same - 1, 9)];
        expect(labels(orderMessages(input))).toEqual(['earlier', 'first', 'second']);
    });

    it('uses the array position as a last tie-breaker if two entries share an index', () =>
    {
        const same = T('2025-04-02T09:00:00Z');
        const input = [item('x', same, 1), item('y', same, 1), item('u1', null, 0), item('u2', null, 0)];
        expect(labels(orderMessages(input))).toEqual(['x', 'y', 'u1', 'u2']);
    });

    it('puts undated messages after all dated ones, in input order, flagged as file order', () =>
    {
        const input = items(
            ['undated-1', null],
            ['late', T('2030-01-01T00:00:00Z')],
            ['undated-2', null],
            ['early', T('1999-12-31T23:59:59Z')],
            ['undated-3', null],
        );
        const result = orderMessages(input);
        expect(labels(result)).toEqual(['early', 'late', 'undated-1', 'undated-2', 'undated-3']);
        expect(result.map((entry) => entry.order)).toEqual(['by-date', 'by-date', 'file-order', 'file-order', 'file-order']);
    });

    it('orders undated messages by their input index, not by where they sit in the array', () =>
    {
        const input = [item('u-index-5', null, 5), item('u-index-1', null, 1), item('u-index-3', null, 3)];
        expect(labels(orderMessages(input))).toEqual(['u-index-1', 'u-index-3', 'u-index-5']);
    });

    it('treats NaN and Infinity like a missing date instead of corrupting the sort', () =>
    {
        const input = items(['nan', Number.NaN], ['b', 2000], ['inf', Number.POSITIVE_INFINITY], ['a', 1000]);
        const result = orderMessages(input);
        expect(labels(result)).toEqual(['a', 'b', 'nan', 'inf']);
        expect(result.map((entry) => entry.order)).toEqual(['by-date', 'by-date', 'file-order', 'file-order']);
    });

    it('treats a moment outside the displayable range (years 0001-9999) as missing, like the display does', () =>
    {
        const yearZero = T('0000-06-15T12:00:00Z');
        const input = items(
            ['far-future', 1e20],
            ['date-max', 8.64e15],
            ['b', 2000],
            ['date-min', -8.64e15],
            ['year-zero', yearZero],
            ['a', 1000],
        );
        const result = orderMessages(input);
        expect(labels(result)).toEqual(['a', 'b', 'far-future', 'date-max', 'date-min', 'year-zero']);
        expect(result.map((entry) => entry.order)).toEqual([
            'by-date',
            'by-date',
            'file-order',
            'file-order',
            'file-order',
            'file-order',
        ]);
    });

    it('sorts the exact range boundaries by date and one millisecond beyond them by file order', () =>
    {
        const input = items(
            ['above-max', MAX_DISPLAYABLE_MS + 1],
            ['max', MAX_DISPLAYABLE_MS],
            ['below-min', MIN_DISPLAYABLE_MS - 1],
            ['min', MIN_DISPLAYABLE_MS],
        );
        const result = orderMessages(input);
        expect(labels(result)).toEqual(['min', 'max', 'above-max', 'below-min']);
        expect(result.map((entry) => entry.order)).toEqual(['by-date', 'by-date', 'file-order', 'file-order']);
    });

    it('handles dates before 1970 (negative utcMs) and epoch zero', () =>
    {
        const input = items(['epoch', 0], ['before', T('1969-07-20T20:17:00Z')], ['after', 1]);
        expect(labels(orderMessages(input))).toEqual(['before', 'epoch', 'after']);
    });

    it('gives the same output whatever order the input arrives in', () =>
    {
        const base = T('2025-01-01T00:00:00Z');
        // Fixed indexes, so each entry keeps its identity when the array is shuffled.
        const entries: Item[] = [];
        for (let i = 0; i < 60; i++)
        {
            // Every 5th message is undated; dates repeat (i % 7) to create ties.
            entries.push(item(`m${i}`, i % 5 === 0 ? null : base + (i % 7) * 60_000, i));
        }
        const expected = labels(orderMessages(entries));
        for (const seed of [1, 2, 3, 42, 2025])
        {
            expect(labels(orderMessages(shuffled(entries, seed)))).toEqual(expected);
        }
    });

    it('never modifies the input array or its entries, and keeps the same entry objects', () =>
    {
        const input = items(['b', 2], ['u', null], ['a', 1]);
        const snapshot = JSON.stringify(input);
        const arrayCopy = [...input];
        const result = orderMessages(input);
        expect(JSON.stringify(input)).toBe(snapshot);
        expect(input).toEqual(arrayCopy);
        input.forEach((entry, i) => expect(entry).toBe(arrayCopy[i]));
        expect(result[0]?.item).toBe(input[2]);
        expect(result).not.toBe(input);
    });

    it('works on frozen input (no in-place sort)', () =>
    {
        const input = Object.freeze(items(['b', 2], ['a', 1]).map((entry) => Object.freeze(entry)));
        expect(labels(orderMessages(input))).toEqual(['a', 'b']);
    });

    it('accepts dedupe KeptMessage-like entries with extra fields', () =>
    {
        const kept = [
            { index: 0, message: { date: { utcMs: 5, original: 'x' }, subject: 'later' }, duplicates: [], warnings: [] },
            { index: 1, message: { date: { utcMs: 3, original: 'y' }, subject: 'sooner' }, duplicates: [], warnings: [] },
        ];
        expect(orderMessages(kept).map((entry) => entry.item.message.subject)).toEqual(['sooner', 'later']);
    });

    it('sorts a 10,000-message thread quickly and correctly', () =>
    {
        const base = T('2024-01-01T00:00:00Z');
        const count = 10_000;
        const entries: Item[] = [];
        for (let i = 0; i < count; i++)
        {
            // Spread over a year, with some exact ties and some undated messages.
            const utcMs = i % 97 === 0 ? null : base + ((i * 7919) % 5000) * 3_600_000;
            entries.push(item(`m${i}`, utcMs, i));
        }
        const input = shuffled(entries, 7);

        const start = performance.now();
        const result = orderMessages(input);
        const elapsed = performance.now() - start;

        expect(result).toHaveLength(count);
        // Generous bound: this takes a few milliseconds; only a quadratic slip would fail it.
        expect(elapsed).toBeLessThan(2000);

        let previous: Item | undefined;
        let seenUndated = false;
        for (const entry of result)
        {
            const utcMs = entry.item.message.date.utcMs;
            if (utcMs === null)
            {
                seenUndated = true;
                expect(entry.order).toBe('file-order');
                if (previous?.message.date.utcMs === null)
                {
                    expect(entry.item.index).toBeGreaterThan(previous.index);
                }
            }
            else
            {
                expect(seenUndated).toBe(false); // no dated message after an undated one
                expect(entry.order).toBe('by-date');
                const prevMs = previous?.message.date.utcMs;
                if (previous !== undefined && prevMs !== null && prevMs !== undefined)
                {
                    expect(utcMs).toBeGreaterThanOrEqual(prevMs);
                    if (utcMs === prevMs)
                    {
                        expect(entry.item.index).toBeGreaterThan(previous.index);
                    }
                }
            }
            previous = entry.item;
        }
        expect(new Set(result.map((entry) => entry.item)).size).toBe(count); // nothing lost or repeated
    });
});
