// The messages rebuilt from quoted text, as step 2 shows them (milestone 7,
// task 7.6; brief section 8.6). The engine rebuilds them and places them in
// one timeline with the real emails (Source/thread-analysis/link-rebuilt-messages.ts); this file
// only decides what the preview shows of them, in which order, and which of
// them the reader wants in the PDF. It decides nothing about the text.
//
// What is shown (user decisions 2026-10-27):
// - Only rebuilt messages with their own timeline entry (link 'entry') get a
//   card, at their place in the timeline. One linked to a real dropped email
//   ('real') gets none: the real file wins. A copy of another rebuilt one
//   ('same-as') gets none either: its entry says "same quoted text also in
//   email #K" instead (alsoNumbers).
// - A card shows the rebuilt text (quote marks and their indentation
//   removed: the one form change the user allowed, with a fixed note), its
//   sender, recipients, subject and date as read from the quoted header,
//   and the number of the email it was taken from. It has NO number of its
//   own: numbers belong to the real emails.
// - Collapse, never delete (brief section 7): a card is only a second view
//   of a part of its source email. The source email's own card is not
//   changed and keeps every character of its text.
//
// Which rebuilt messages go into the PDF (RebuiltSelection): all of them by
// default; one switch leaves ALL of them out, and each card has its own
// checkbox, like a real email. Like Source/web-page-logic/email-selection.ts, a choice is
// remembered by stable keys that survive adding more files (the list is then
// worked out again and ids change): the SHA-256 of the source file plus the
// offset where the quoted header starts in its body, for the entry and for
// every copy of it (and for every file merged into a source). A rebuilt
// message is left out if ANY of its keys was left out. Memory only
// (README.md, rule R5). On top of that, a rebuilt message FOLLOWS the
// emails it was read from (user decision Q1 (a), task 7.7; rebuiltInPdf):
// it is in the PDF only while one of them is. The review applies both
// (Source/web-page/review.ts, includedRebuilt) and the PDF applies the follow-source
// rule again with its own list of emails (Source/pdf-export/build-pdf-document.ts, planPdfOrder).
// And while "Print full original text" is ticked (OutputPolicy
// .unfoldEverything; user decisions 2026-10-28 and 2026-10-29, tasks 7.8b
// and 7.8c), NO rebuilt message is shown or goes into the PDF: the source
// emails are then printed whole, quoted history included, so a rebuilt
// message would only print the same text a second time (rebuiltInPdf's
// `unfoldEverything` option, the review and the PDF model). The review then
// shows the switch unticked and disabled. The choices above are not touched
// by it: unticking "Print full original text" brings back exactly the
// previous state. The quoted text stays in its source email's card, folded
// as usual (collapse, never delete).
//
// Pure functions, no DOM (README.md, rule R7).

import { selectionKeys } from './email-selection';
import type { EmailAddress } from '../../Header/parsed-email';
import type { PreviewSlot, RebuiltCard, RebuiltDate, RebuiltInPdf, RebuiltSource } from '../../Header/preview-display';
import type { EngineRebuilt, TimelineEntry } from '../../Header/rebuilt-emails';
import type { EngineMessage, EngineResult } from '../../Header/thread-analysis-result';

/**
 * The preview's order: the engine's timeline. Defensive: if the timeline is
 * missing or does not hold every real email exactly once, or names a rebuilt
 * message that is not an entry, the real emails alone in list order (never
 * an email missing because of a bad timeline).
 */
export function previewOrder(result: Pick<EngineResult, 'messages' | 'timeline' | 'reconstructed'>): PreviewSlot[]
{
    const plain = (): PreviewSlot[] => result.messages.map((_, position) => ({ kind: 'message', position }));
    // (Array.isArray would turn a readonly array's type into any[]: hence the typed copies.)
    const timeline: readonly TimelineEntry[] | undefined = Array.isArray(result.timeline) ? result.timeline : undefined;
    const reconstructed: readonly EngineRebuilt[] = Array.isArray(result.reconstructed) ? result.reconstructed : [];
    if (timeline === undefined)
    {
        return plain();
    }
    const seen = new Set<number>();
    const seenIds = new Set<number>();
    const out: PreviewSlot[] = [];
    for (const entry of timeline)
    {
        if (entry.kind === 'message')
        {
            const position = entry.position;
            if (!Number.isInteger(position) || position < 0 || position >= result.messages.length || seen.has(position))
            {
                return plain();
            }
            seen.add(position);
            out.push({ kind: 'message', position: position });
        }
        else
        {
            const rebuiltEmail = reconstructed[entry.id];
            if (rebuiltEmail === undefined || rebuiltEmail.id !== entry.id || rebuiltEmail.link !== 'entry' || seenIds.has(entry.id))
            {
                return plain();
            }
            seenIds.add(entry.id);
            out.push({ kind: 'rebuilt', id: entry.id });
        }
    }
    return seen.size === result.messages.length ? out : plain();
}

/** The rebuilt messages that get a card (link 'entry'), in preview order. */
export function rebuiltEntries(result: Pick<EngineResult, 'messages' | 'timeline' | 'reconstructed'>): EngineRebuilt[]
{
    const out: EngineRebuilt[] = [];
    for (const slot of previewOrder(result))
    {
        if (slot.kind !== 'rebuilt')
        {
            continue;
        }
        const rebuiltEmail = result.reconstructed[slot.id];
        if (rebuiltEmail !== undefined)
        {
            out.push(rebuiltEmail);
        }
    }
    return out;
}

/** The kept email a rebuilt message was taken from, or undefined (not expected). */
export function sourceMessageOf(rebuiltEmail: Pick<EngineRebuilt, 'sourceIndex'>, result: Pick<EngineResult, 'messages' | 'positionByIndex'>): EngineMessage | undefined
{
    const position = result.positionByIndex[rebuiltEmail.sourceIndex];
    return typeof position === 'number' ? result.messages[position] : undefined;
}

/** The list number (1-based, "#3") of the email a rebuilt message was taken from; null if unknown (not expected). */
export function sourceNumber(rebuiltEmail: Pick<EngineRebuilt, 'sourceIndex'>, result: Pick<EngineResult, 'positionByIndex'>): number | null
{
    const position = result.positionByIndex[rebuiltEmail.sourceIndex];
    return typeof position === 'number' ? position + 1 : null;
}

/**
 * The list numbers of the OTHER emails that quote the same text
 * (alsoQuotedIn, input positions), ascending, unique, without the source
 * itself and without unknown positions.
 */
export function alsoNumbers(rebuiltEmail: Pick<EngineRebuilt, 'sourceIndex' | 'alsoQuotedIn'>, result: Pick<EngineResult, 'positionByIndex'>): number[]
{
    const own = sourceNumber(rebuiltEmail, result);
    const numbers = new Set<number>();
    for (const index of rebuiltEmail.alsoQuotedIn)
    {
        const position = result.positionByIndex[index];
        if (typeof position === 'number' && position + 1 !== own)
        {
            numbers.add(position + 1);
        }
    }
    return [...numbers].sort((a, b) => a - b);
}

/** The keys of one rebuilt entry: source file hash + "@" + header offset, for it and every copy (see the top). */
export function rebuiltSelectionKeys(rebuiltEmail: EngineRebuilt, result: Pick<EngineResult, 'messages' | 'positionByIndex' | 'reconstructed'>): string[]
{
    const keys = new Set<string>();
    const add = (candidate: EngineRebuilt | undefined): void =>
    {
        if (candidate === undefined)
        {
            return;
        }
        const source = sourceMessageOf(candidate, result);
        if (source === undefined)
        {
            return;
        }
        for (const hash of selectionKeys(source))
        {
            keys.add(`${hash}@${String(candidate.rebuilt.start)}`);
        }
    };
    add(rebuiltEmail);
    for (const id of rebuiltEmail.copies)
    {
        add(result.reconstructed[id]);
    }
    return [...keys];
}

/** The rebuilt messages' include choices (memory only). */
export interface RebuiltSelection
{
    /** The switch: false leaves every rebuilt message out of the PDF (and out of the preview list). */
    includeAll(): boolean;
    setIncludeAll(included: boolean): void;
    /** The card's own checkbox: true unless the reader left it out (whatever the switch says). */
    isTicked(rebuiltEmail: EngineRebuilt, result: EngineResult): boolean;
    setTicked(rebuiltEmail: EngineRebuilt, result: EngineResult, ticked: boolean): void;
    /** Goes into the PDF: the switch is on and the card is ticked. */
    isIncluded(rebuiltEmail: EngineRebuilt, result: EngineResult): boolean;
    /** Back to the defaults: switch on, every card ticked. */
    clear(): void;
}

export function createRebuiltSelection(): RebuiltSelection
{
    const excluded = new Set<string>();
    let all = true;
    const isTicked = (rebuiltEmail: EngineRebuilt, result: EngineResult): boolean => !rebuiltSelectionKeys(rebuiltEmail, result).some((k) => excluded.has(k));
    return {
        includeAll: () => all,
        setIncludeAll(included)
        {
            all = included;
        },
        isTicked,
        setTicked(rebuiltEmail, result, ticked)
        {
            for (const key of rebuiltSelectionKeys(rebuiltEmail, result))
            {
                if (ticked)
                {
                    excluded.delete(key);
                }
                else
                {
                    excluded.add(key);
                }
            }
        },
        isIncluded: (rebuiltEmail, result) => all && isTicked(rebuiltEmail, result),
        clear()
        {
            excluded.clear();
            all = true;
        },
    };
}

/** The rebuilt entries the reader wants in the PDF (switch on, card ticked), in preview (timeline) order. Not yet the follow-source rule (rebuiltInPdf). */
export function includedRebuilt(result: EngineResult, selection: RebuiltSelection): EngineRebuilt[]
{
    if (!selection.includeAll())
    {
        return [];
    }
    return rebuiltEntries(result).filter((r) => selection.isIncluded(r, result));
}

/**
 * Every place the quoted text of entry `rebuiltEmail` was read: the entry first, then
 * its copies (link 'same-as', ascending id). A copy that does not point back
 * to the entry, or whose email is unknown, is left out (not expected).
 */
export function rebuiltSources(rebuiltEmail: EngineRebuilt, result: Pick<EngineResult, 'positionByIndex' | 'reconstructed'>): RebuiltSource[]
{
    const out: RebuiltSource[] = [];
    const add = (candidate: EngineRebuilt | undefined): void =>
    {
        if (candidate === undefined)
        {
            return;
        }
        const position = result.positionByIndex[candidate.sourceIndex];
        if (typeof position === 'number')
        {
            out.push({ rebuilt: candidate, position });
        }
    };
    add(rebuiltEmail);
    for (const id of rebuiltEmail.copies)
    {
        const copy = result.reconstructed[id];
        if (copy !== undefined && copy.link === 'same-as' && copy.sameAs === rebuiltEmail.id)
        {
            add(copy);
        }
    }
    return out;
}

/** Options of rebuiltInPdf. */
export interface RebuiltInPdfOptions
{
    /** "Print full original text" is ticked (OutputPolicy.unfoldEverything): no rebuilt entry is in the PDF (see the top). */
    readonly unfoldEverything?: boolean;
}

/**
 * THE FOLLOW-SOURCE RULE (user decision Q1 (a), task 7.7): a rebuilt entry
 * goes into the PDF only while at least one email it was read from (the
 * entry's own source, or the source of one of its copies) is in the PDF.
 * `numberOf` gives the PDF number of a list position, or null when that
 * email is not in the PDF. Returns null when no source is in the PDF.
 *
 * The copy shown is the entry's own when its source is in the PDF, else the
 * copy whose source has the smallest PDF number: so the source named (the
 * preview's "In the PDF: taken from #N") is always an email in the PDF, and
 * the text and header shown are exactly the ones read from that email.
 * Every other source in the PDF is listed in `also`. (The PDF itself names
 * neither, user decision 2026-11-02, task 8.3.)
 *
 * With `options.unfoldEverything` ("Print full original text" ticked, user
 * decision 2026-10-28) the answer is always null: the source emails are
 * printed whole, so the rebuilt entry would only repeat their quoted text.
 */
export function rebuiltInPdf(
    rebuiltEmail: EngineRebuilt,
    result: Pick<EngineResult, 'positionByIndex' | 'reconstructed'>,
    numberOf: (position: number) => number | null,
    options: RebuiltInPdfOptions = {},
): RebuiltInPdf | null
{
    if (options.unfoldEverything === true)
    {
        return null;
    }
    let best: { source: RebuiltSource; number: number } | null = null;
    const numbers = new Set<number>();
    for (const source of rebuiltSources(rebuiltEmail, result))
    {
        const number = numberOf(source.position);
        if (number === null)
        {
            continue;
        }
        numbers.add(number);
        // The entry's own source wins when it is in the PDF (it comes first); else the smallest number.
        if (best === null || (best.source.rebuilt !== rebuiltEmail && number < best.number))
        {
            best = { source, number };
        }
    }
    if (best === null)
    {
        return null;
    }
    const chosen = best;
    return { shown: chosen.source, number: chosen.number, also: [...numbers].filter((n) => n !== chosen.number).sort((a, b) => a - b) };
}

/** The date of a rebuilt message (see RebuiltDate). */
export function rebuiltDate(rebuiltEmail: Pick<EngineRebuilt, 'rebuilt'>): RebuiltDate
{
    const { dateText, date, dateApproximate } = rebuiltEmail.rebuilt;
    if (dateText === null || dateText.trim() === '')
    {
        return { kind: 'none' };
    }
    const text = dateText;
    if (date === null)
    {
        return { kind: 'unreadable', text };
    }
    if (date.precision === 'minute' && typeof date.estimatedUtcMs === 'number' && Number.isFinite(date.estimatedUtcMs))
    {
        return { kind: 'moment', utcMs: date.estimatedUtcMs, approximate: dateApproximate, text };
    }
    if (date.precision === 'day' && typeof date.wallMs === 'number' && Number.isFinite(date.wallMs))
    {
        const wallDate = new Date(date.wallMs);
        if (!Number.isNaN(wallDate.getTime()))
        {
            return { kind: 'day', day: wallDate.toISOString().slice(0, 10), approximate: dateApproximate, text };
        }
    }
    return { kind: 'unreadable', text };
}

const blank = (m: EmailAddress): boolean => m.name.trim() === '' && m.address.trim() === '';

export function rebuiltCard(rebuiltEmail: EngineRebuilt, result: Pick<EngineResult, 'positionByIndex'>): RebuiltCard
{
    const message = rebuiltEmail.rebuilt;
    return {
        id: rebuiltEmail.id,
        subject: message.subject !== null && message.subject.trim() !== '' ? message.subject : null,
        from: message.from.filter((x) => !blank(x)),
        to: message.to.filter((x) => !blank(x)),
        cc: message.cc.filter((x) => !blank(x)),
        toIncomplete: message.incomplete.includes('to'),
        ccIncomplete: message.incomplete.includes('cc'),
        date: rebuiltDate(rebuiltEmail),
        sourceNumber: sourceNumber(rebuiltEmail, result),
        alsoNumbers: alsoNumbers(rebuiltEmail, result),
        quoteMarksRemoved: message.quoteMarksRemoved,
        text: message.reconstructedText,
    };
}
