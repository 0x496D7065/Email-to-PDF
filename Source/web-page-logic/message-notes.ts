// The notes of one email in the preview: everything the tool was unsure
// about or had to work around for it (a missing date, an unknown time zone,
// text converted from HTML, a look-alike email that was not merged, a fold
// detector that failed, earlier emails in its quote that could not be
// rebuilt, characters the PDF will show as codes, ...). The words come from the strings module
// (Source/web-page/translations/en.ts); this file only decides WHICH notes an email gets, in
// which order, and which other emails they point to.
//
// Every code has a label: the lists below must name every code of its type
// (a compile-time check fails otherwise), and en.ts types each label group
// with `satisfies Record<Code, string>`.
//
// Pure functions, no DOM (README.md, rule R7).

import { isDisplayableMs } from '../thread-analysis/time-format';
// Pure, no DOM: the PDF's own rule for which characters become a code.
import { codedCharacterCount } from '../pdf-export/pdf-text-transforms';
import type { MessagePlan } from '../../Header/output-plan';
import type { ParseWarning } from '../../Header/parsed-email';
import type { MessageNote, UnreadAttachedCode } from '../../Header/preview-display';
import type { DedupeWarningCode, EngineMessage, EngineWarningCode, ReconstructionWarning, ReconstructionWarningCode } from '../../Header/thread-analysis-result';

/**
 * Compile-time check that `List` names every member of `Union`: resolves to
 * `true` when complete, to `never` otherwise (so assigning `true` fails).
 */
type Complete<Union, List extends readonly unknown[]> = [Exclude<Union, List[number]>] extends [never] ? true : never;

/** Date notes, shown first (the "placed at the end" note follows them). */
const DATE_WARNINGS = ['missing-date', 'unparseable-date', 'unknown-time-zone'] as const satisfies readonly ParseWarning[];

/** Every parser warning, in the order shown: date notes first, then the rest. */
export const PARSE_WARNINGS = [
    ...DATE_WARNINGS,
    'html-body-unreadable',
    'html-body-truncated',
    'rtf-only-body',
    'text-encoding-uncertain',
    'html-converted-body',
    'forwarded-message-not-expanded',
    'no-body',
    'missing-message-id',
] as const satisfies readonly ParseWarning[];
const parseWarningsComplete: Complete<ParseWarning, typeof PARSE_WARNINGS> = true;

/** Every de-duplication warning, in the order shown. */
export const DEDUPE_WARNINGS = [
    'same-id-different-content',
    'possible-duplicate-not-merged',
    'duplicate-date-differs',
    'duplicate-recipients-differ',
    'duplicate-sender-differs',
    'duplicate-threading-differs',
] as const satisfies readonly DedupeWarningCode[];
const dedupeWarningsComplete: Complete<DedupeWarningCode, typeof DEDUPE_WARNINGS> = true;

/** Every engine warning, in the order shown. */
export const ENGINE_WARNINGS = ['detector-failed', 'folding-disabled', 'dedupe-failed'] as const satisfies readonly EngineWarningCode[];
const engineWarningsComplete: Complete<EngineWarningCode, typeof ENGINE_WARNINGS> = true;

/** Every warning about rebuilding earlier emails from this email's quote (task 7.6), in the order shown. */
export const REBUILD_WARNINGS = ['reconstruct-failed', 'reconstruct-limit'] as const satisfies readonly ReconstructionWarningCode[];
const rebuildWarningsComplete: Complete<ReconstructionWarningCode, typeof REBUILD_WARNINGS> = true;

// Read once so the checks above are not "unused" (they matter at compile time only).
void [parseWarningsComplete, dedupeWarningsComplete, engineWarningsComplete, rebuildWarningsComplete];

/**
 * Notes about the PDF plan of one email (Source/thread-analysis/output-plan.ts, rules 4
 * and 5): the whole email goes into the PDF because the tool could not tell
 * what to leave out. They depend on which emails are included, so the
 * preview shows them with its PDF labels (Source/web-page/preview.ts), not with the
 * notes above.
 * 'pdf-kept-all-empty-elsewhere' (task 8.11, finding S1, done in task
 * 8.13a): rule 4 keeps the whole email, but the PDF's no-repeat rule
 * (Source/pdf-export/build-pdf-document.ts) still leaves out of it the parts it prints as emails
 * of their own, so "the whole email" would not be true.
 */
export const PDF_NOTES = ['pdf-kept-all-empty', 'pdf-kept-all-empty-elsewhere', 'pdf-fallback'] as const;
export type PdfNoteCode = (typeof PDF_NOTES)[number];

/**
 * The PDF note of a plan, or null. `printedElsewhere`: the PDF leaves parts
 * of this email out because it prints them as emails of their own (the
 * preview's view of the email has such parts, Source/web-page-logic/pdf-plan.ts).
 */
export function pdfPlanNote(plan: Pick<MessagePlan, 'keptAllBecauseEmpty' | 'fallback'>, printedElsewhere = false): PdfNoteCode | null
{
    if (plan.fallback)
    {
        return 'pdf-fallback';
    }
    if (plan.keptAllBecauseEmpty)
    {
        return printedElsewhere ? 'pdf-kept-all-empty-elsewhere' : 'pdf-kept-all-empty';
    }
    return null;
}

/**
 * The list numbers (1-based) of the emails a warning points to: input
 * positions turned into list positions with `positionByIndex`, without this
 * email itself, failed files or unknown positions; ascending, unique.
 */
export function relatedListNumbers(related: readonly number[], ownPosition: number, positionByIndex: readonly (number | null)[]): number[]
{
    const numbers = new Set<number>();
    for (const index of related)
    {
        const position = positionByIndex[index];
        if (typeof position === 'number' && position !== ownPosition)
        {
            numbers.add(position + 1);
        }
    }
    return [...numbers].sort((a, b) => a - b);
}

/**
 * How many characters of an email the PDF writes as codes such as
 * "[U+0000]" (Source/pdf-export/pdf-text-transforms.ts, group 1: control characters, broken
 * characters and the like): in the texts the PDF can show of it, which are
 * its header fields, attachment names and types, file names, its date as
 * written when that date could not be read, and its whole text (the parts
 * the PDF leaves out included: the count does not depend on the plan).
 */
export function codedCharacters(email: EngineMessage): number
{
    const message = email.message;
    const texts: string[] = [message.subject, message.bodyText, message.source.fileName, ...email.duplicates.map((d) => d.source.fileName)];
    for (const box of [...message.from, ...message.to, ...message.cc, ...message.bcc, ...(message.sender === undefined ? [] : [message.sender])])
    {
        texts.push(box.name, box.address);
    }
    for (const attachment of message.attachments)
    {
        texts.push(attachment.fileName, attachment.mimeType);
    }
    if (!isDisplayableMs(message.date.utcMs))
    {
        texts.push(message.date.original);
    }
    return texts.reduce((n, text) => n + (typeof text === 'string' ? codedCharacterCount(text) : 0), 0);
}

/**
 * The notes of the email at `position` (0-based) in the list, in the order
 * shown. [] if none. `rebuildWarnings`: the result's reconstructionWarnings
 * (only those of this email, by its input position, are used).
 * `unreadAttached`: this email's unread-attached note, worked out over the
 * whole result (Source/web-page-logic/attached-links.ts), shown right after the
 * parser's notes (the "only listed as an attachment" one among them).
 */
export function messageNotes(
    email: EngineMessage,
    position: number,
    positionByIndex: readonly (number | null)[],
    rebuildWarnings: readonly ReconstructionWarning[] = [],
    unreadAttached: UnreadAttachedCode | null = null,
): MessageNote[]
{
    const notes: MessageNote[] = [];
    const parse = new Set<ParseWarning>(email.parserWarnings);
    for (const code of PARSE_WARNINGS)
    {
        if (parse.has(code))
        {
            notes.push({ kind: 'parse', code });
        }
        // The "placed at the end" (or "placed before the email it is attached to") note right after the date notes.
        if (code === DATE_WARNINGS[DATE_WARNINGS.length - 1] && (email.order === 'file-order' || email.order === 'before-parent'))
        {
            notes.push({ kind: 'order', code: email.order });
        }
    }
    if (unreadAttached !== null)
    {
        notes.push({ kind: 'attached', code: unreadAttached });
    }
    for (const code of DEDUPE_WARNINGS)
    {
        for (const warning of email.dedupeWarnings)
        {
            if (warning.code !== code)
            {
                continue;
            }
            // relatedTotal counts input files (Source/thread-analysis/dedupe.ts), like `related`.
            const total = Number.isInteger(warning.relatedTotal) ? warning.relatedTotal : warning.related.length;
            notes.push({
                kind: 'dedupe',
                code,
                related: relatedListNumbers(warning.related, position, positionByIndex),
                more: Math.max(0, total - warning.related.length),
            });
        }
    }
    if (codedCharacters(email) > 0)
    {
        notes.push({ kind: 'chars', code: 'coded-characters' });
    }
    const engine = new Set<EngineWarningCode>(email.engineWarnings);
    for (const code of ENGINE_WARNINGS)
    {
        if (engine.has(code))
        {
            notes.push({ kind: 'engine', code });
        }
    }
    const rebuild = new Set<ReconstructionWarningCode>(rebuildWarnings.filter((w) => w.index === email.index).map((w) => w.code));
    for (const code of REBUILD_WARNINGS)
    {
        if (rebuild.has(code))
        {
            notes.push({ kind: 'rebuild', code });
        }
    }
    return notes;
}
