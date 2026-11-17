// Chronological ordering of the kept messages. A pure function with no page
// or DOM access, so it can be unit tested in isolation (README.md, rule R7).
//
// Messages are sorted by their true moment in time (`date.utcMs`, which the
// parser already converted to UTC), never by the text of the Date header, so
// two senders in different time zones end up in the right order.
//
// Rules:
// 1. Messages with a date come first, oldest first. Equal dates keep their
//    input order (lower `index` first), so the result never depends on how
//    the sort happens to break ties.
// 2. Messages without a usable date come after all dated ones, in input
//    order, and are marked `order: 'file-order'` so the preview and the PDF
//    can say "date missing: placed by file order". We do not guess a place
//    from the thread (In-Reply-To / References): a guess could be wrong, and
//    file order is easy to explain.
//
// A date whose time zone was unknown (`zoneKnown: false`) still sorts by
// `utcMs`: the parser read it as UTC and already added the
// 'unknown-time-zone' warning, which stays the one signal for the preview.
// No new warning is added here.
//
// "Usable date" means inside the range the display can show (years 0001 to
// 9999, minus a one-day margin, see isDisplayableMs in time-format.ts). A
// moment outside it is treated as missing, so a message is never sorted by a
// date that the preview then shows as "no date".
//
// Pure function: no DOM, no storage, and the input array and its entries are
// never modified. The entries in the result are the same objects as in the input.

import { isDisplayableMs } from './time-format';

/** The smallest shape `orderMessages` needs: a date and an input position. */
export interface Orderable {
    readonly message: { readonly date: { readonly utcMs: number | null } };
    /** Position in the original input (for KeptMessage: the representative's position). */
    readonly index: number;
}

/** Why an entry is where it is. */
export type OrderReason =
    | 'by-date' // placed by its date (utcMs)
    | 'file-order' // no usable date: placed after all dated messages, in input order
    // No usable date, and attached inside another email: placed just before the
    // email it is attached to (user decision 2026-11-10, Q7, task 8.13b-3). Set
    // by the engine (src/engine/engine.ts, placeUndatedAttached), never by
    // orderMessages.
    | 'before-parent';

/** One entry of the ordered list. */
export interface OrderedEntry<T> {
    /** The input entry, unchanged (same object). */
    readonly item: T;
    readonly order: OrderReason;
}

/** True if `utcMs` is a moment we can sort by and display (null, NaN, Infinity and far-off moments are not). */
function hasUsableDate(utcMs: number | null): utcMs is number
{
    return isDisplayableMs(utcMs);
}

/**
 * Sorts messages chronologically (see the rules at the top of this file).
 * Returns a new array; `items` is not modified.
 */
export function orderMessages<T extends Orderable>(items: readonly T[]): OrderedEntry<T>[]
{
    // Remember each entry's array position as a last tie-breaker, in case two
    // entries share an `index` (not possible after dedupe, but cheap to cover).
    const decorated = items.map((item, position) => ({ item, position }));

    const dated = decorated.filter((d) => hasUsableDate(d.item.message.date.utcMs));
    const undated = decorated.filter((d) => !hasUsableDate(d.item.message.date.utcMs));

    const byInputOrder = (a: (typeof decorated)[number], b: (typeof decorated)[number]): number =>
        a.item.index - b.item.index || a.position - b.position;

    dated.sort((a, b) =>
    {
        // Both are numbers here (filtered above); `?? 0` only satisfies the type checker.
        const diff = (a.item.message.date.utcMs ?? 0) - (b.item.message.date.utcMs ?? 0);
        return diff || byInputOrder(a, b);
    });
    undated.sort(byInputOrder);

    return [
        ...dated.map((d): OrderedEntry<T> => ({ item: d.item, order: 'by-date' })),
        ...undated.map((d): OrderedEntry<T> => ({ item: d.item, order: 'file-order' })),
    ];
}
