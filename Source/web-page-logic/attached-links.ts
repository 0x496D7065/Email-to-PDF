// Emails attached inside other emails, as the preview shows them (task
// 8.13b-4; user decisions 2026-11-15). Nothing here goes into the PDF (Q8).
//
// - "Attached to: email #2" on the card of an attached email (P1 / Q1), and
//   "Attached emails: #4, #6" on the card of the email holding them (Q2).
//   The numbers are the list numbers the preview shows (position + 1), as
//   plain text (Q4). Both rows come from the same links, so they always
//   agree: when an attached copy was merged into another copy (a dropped
//   file always wins, or two files hold the same attached email), the link
//   goes to the card that shows it (positionByIndex), and so does a link to
//   a holder that was merged. A link from a card to itself is left out.
//   Ticking or unticking never changes a list number; a new result (files
//   added) brings new links.
// - A note when an email sent as an attachment (.eml, a message/rfc822 part
//   that is not printed inline) could not be read as an email of its own
//   (P3 / Q5): on the email it is attached to ('attached-unread') and on
//   every email that prints that one inline, up to the dropped file's own
//   email ('attached-unread-inside'). The parser keeps such a part listed
//   with no warning (task 8.13b-1), so it is found here: the email's own
//   message/rfc822 attachments (AttachmentInfo without attachedIndex) are
//   more than its attached emails read as emails of their own without a
//   place in its text (EngineAttached with no places). It is NOT said:
//   - for a .msg file: an attached Outlook item that was not read already
//     gives the 'forwarded-message-not-expanded' warning (msg.ts);
//   - for an email that already has 'forwarded-message-not-expanded': an
//     inline forward that could not be read is listed the same way, so the
//     count cannot tell the two apart, and that note already says an
//     attached email is only listed (never a second, possibly wrong note);
//   - for a bounce or feedback report (it lists a message/delivery-status
//     or message/feedback-report part): the parser never reads the original
//     email such a report carries (eml.ts, readContent), it is evidence.
//   An email that is both a holder and inside one gets the holder note only.
//
// Pure functions, no DOM (README.md, rule R7). Never throws for a broken
// entry: an entry that is not usable is skipped.

import { attachedAt } from '../thread-analysis/engine';
import type { AttachedLinks, UnreadAttachedCode } from '../../Header/preview-display';
import type { EngineAttached, EngineAttachedPlace, EngineResult } from '../../Header/thread-analysis-result';

/** The attachment type of an email inside an .eml file. */
const RFC822 = 'message/rfc822';
/** The parts that make an email a bounce or feedback report (as in Source/email-reading/eml.ts, REPORT_TYPES). */
const REPORT_TYPES: ReadonlySet<string> = new Set(['message/delivery-status', 'message/feedback-report']);

type LinkInput = Pick<EngineResult, 'messages' | 'positionByIndex' | 'attached' | 'counts'>;

/** A list position from an input position, or null (unknown, a failed file). */
function positionOf(result: LinkInput, index: number): number | null
{
    const position = result.positionByIndex[index];
    return typeof position === 'number' && Number.isInteger(position) && position >= 0 && position < result.messages.length ? position : null;
}

/** The numbers of a set, ascending. */
function sorted(set: ReadonlySet<number> | undefined): number[]
{
    return set === undefined ? [] : [...set].sort((a, b) => a - b);
}

/** True if the email at `position` holds an email sent as an attachment that was not read (see the top of this file). */
function holdsUnread(result: LinkInput, position: number, readAsFile: ReadonlyMap<number, number>): boolean
{
    const email = result.messages[position];
    if (email === undefined)
    {
        return false;
    }
    const message = email.message;
    if (message.source.kind !== 'eml' || message.warnings.includes('forwarded-message-not-expanded'))
    {
        return false;
    }
    // Its own attachments only: those of an email printed inside it carry attachedIndex.
    const own = message.attachments.filter((a) => a.attachedIndex === undefined);
    if (own.some((a) => REPORT_TYPES.has(a.mimeType)))
    {
        return false;
    }
    const listed = own.filter((a) => a.mimeType === RFC822).length;
    return listed > (readAsFile.get(email.index) ?? 0);
}

/** Every attached entry that can be used (an object with whole-number positions and a places list). */
function usableEntries(result: LinkInput): EngineAttached[]
{
    const list: unknown = result.attached;
    if (!Array.isArray(list))
    {
        return [];
    }
    return (list as readonly unknown[]).filter(
        (attachedEntry): attachedEntry is EngineAttached =>
            typeof attachedEntry === 'object' &&
            attachedEntry !== null &&
            Number.isInteger((attachedEntry as EngineAttached).index) &&
            Number.isInteger((attachedEntry as EngineAttached).parentIndex) &&
            Array.isArray((attachedEntry as EngineAttached).places),
    );
}

/** The links and notes of a result (see the top of this file). */
export function attachedLinks(result: LinkInput): AttachedLinks
{
    const count = result.messages.length;
    const to = new Map<number, Set<number>>();
    const held = new Map<number, Set<number>>();
    const add = (map: Map<number, Set<number>>, position: number, number: number): void =>
    {
        let set = map.get(position);
        if (set === undefined)
        {
            map.set(position, (set = new Set()));
        }
        set.add(number);
    };
    const entries = usableEntries(result);
    // How many emails each email (by input position) holds as files, read as emails of their own.
    const readAsFile = new Map<number, number>();
    for (const attachedEntry of entries)
    {
        if (attachedEntry.places.length === 0)
        {
            readAsFile.set(attachedEntry.parentIndex, (readAsFile.get(attachedEntry.parentIndex) ?? 0) + 1);
        }
        const child = positionOf(result, attachedEntry.index);
        const holder = positionOf(result, attachedEntry.parentIndex);
        if (child === null || holder === null || child === holder)
        {
            continue;
        }
        add(to, child, holder + 1);
        add(held, holder, child + 1);
    }

    // The holder note first, for every email: it wins over the "inside" note.
    const unread: (UnreadAttachedCode | null)[] = Array.from({ length: count }, (_, p) => (holdsUnread(result, p, readAsFile) ? 'attached-unread' : null));
    for (let position = 0; position < count; position++)
    {
        if (unread[position] !== 'attached-unread')
        {
            continue;
        }
        // The emails that print it inline: the places of every copy of it (the
        // kept one and the copies merged into it), at every level.
        const email = result.messages[position];
        const copies = email === undefined ? [] : [email.index, ...email.duplicates.map((d) => d.index)];
        for (const index of copies)
        {
            const places: unknown = attachedAt(result, index)?.places;
            if (!Array.isArray(places))
            {
                continue;
            }
            for (const place of places as readonly EngineAttachedPlace[])
            {
                const holder = positionOf(result, place.holderIndex);
                if (holder !== null && unread[holder] === null)
                {
                    unread[holder] = 'attached-unread-inside';
                }
            }
        }
    }

    return {
        attachedTo: Array.from({ length: count }, (_, p) => sorted(to.get(p))),
        attachedEmails: Array.from({ length: count }, (_, p) => sorted(held.get(p))),
        unread,
    };
}

/** How many emails were found attached inside other emails (task 8.13b-4, P4): every one read as an email of its own, merged copies included. */
export function attachedCount(result: Pick<EngineResult, 'attached'>): number
{
    return Array.isArray(result.attached) ? result.attached.length : 0;
}
