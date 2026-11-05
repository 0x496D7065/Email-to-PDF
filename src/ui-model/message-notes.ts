// The notes of one email in the preview: everything the tool was unsure
// about or had to work around for it (a missing date, an unknown time zone,
// text converted from HTML, a look-alike email that was not merged, a fold
// detector that failed, earlier emails in its quote that could not be
// rebuilt, characters the PDF will show as codes, ...). The words come from the strings module
// (src/ui/i18n/en.ts); this file only decides WHICH notes an email gets, in
// which order, and which other emails they point to.
//
// Every code has a label: the lists below must name every code of its type
// (a compile-time check fails otherwise), and en.ts types each label group
// with `satisfies Record<Code, string>`.
//
// Pure functions, no DOM (README.md, rule R7).

import type { DedupeWarningCode } from '../engine/dedupe';
import type { EngineMessage, EngineWarningCode, ReconstructionWarning, ReconstructionWarningCode } from '../engine/engine';
import type { MessagePlan } from '../engine/output-plan';
import { isDisplayableMs } from '../engine/time-format';
import type { ParseWarning } from '../parsing/types';
// Pure, no DOM: the PDF's own rule for which characters become a code.
import { codedCharacterCount } from '../pdf/text';

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
 * Notes about the PDF plan of one email (src/engine/output-plan.ts, rules 4
 * and 5): the whole email goes into the PDF because the tool could not tell
 * what to leave out. They depend on which emails are included, so the
 * preview shows them with its PDF labels (src/ui/preview.ts), not with the
 * notes above.
 */
export const PDF_NOTES = ['pdf-kept-all-empty', 'pdf-fallback'] as const;
export type PdfNoteCode = (typeof PDF_NOTES)[number];

/** The PDF note of a plan, or null. */
export function pdfPlanNote(plan: Pick<MessagePlan, 'keptAllBecauseEmpty' | 'fallback'>): PdfNoteCode | null {
  if (plan.fallback) return 'pdf-fallback';
  if (plan.keptAllBecauseEmpty) return 'pdf-kept-all-empty';
  return null;
}

/** One note of one email. */
export type MessageNote =
  | { readonly kind: 'parse'; readonly code: ParseWarning }
  // Placed after the dated emails, in file order (no usable date).
  | { readonly kind: 'order'; readonly code: 'file-order' }
  | {
      readonly kind: 'dedupe';
      readonly code: DedupeWarningCode;
      /** The other emails' numbers in the list (1-based), ascending; never this email. */
      readonly related: readonly number[];
      /**
       * How many more FILES are involved but not listed (the engine caps its
       * list). Files, not emails: several files can be one merged email,
       * possibly one already listed, so this is never worded as emails.
       */
      readonly more: number;
    }
  | { readonly kind: 'engine'; readonly code: EngineWarningCode }
  // Some of its characters will show in the PDF as codes such as "[U+0000]" (task 8.8: said here, not in the PDF).
  | { readonly kind: 'chars'; readonly code: 'coded-characters' }
  // Earlier emails in its quote could not (all) be rebuilt; the quote itself is untouched.
  | { readonly kind: 'rebuild'; readonly code: ReconstructionWarningCode };

/**
 * The list numbers (1-based) of the emails a warning points to: input
 * positions turned into list positions with `positionByIndex`, without this
 * email itself, failed files or unknown positions; ascending, unique.
 */
export function relatedListNumbers(related: readonly number[], ownPosition: number, positionByIndex: readonly (number | null)[]): number[] {
  const numbers = new Set<number>();
  for (const index of related) {
    const position = positionByIndex[index];
    if (typeof position === 'number' && position !== ownPosition) numbers.add(position + 1);
  }
  return [...numbers].sort((a, b) => a - b);
}

/**
 * How many characters of an email the PDF writes as codes such as
 * "[U+0000]" (src/pdf/text.ts, group 1: control characters, broken
 * characters and the like): in the texts the PDF can show of it, which are
 * its header fields, attachment names and types, file names, its date as
 * written when that date could not be read, and its whole text (the parts
 * the PDF leaves out included: the count does not depend on the plan).
 */
export function codedCharacters(m: EngineMessage): number {
  const message = m.message;
  const texts: string[] = [message.subject, message.bodyText, message.source.fileName, ...m.duplicates.map((d) => d.source.fileName)];
  for (const box of [...message.from, ...message.to, ...message.cc, ...message.bcc, ...(message.sender === undefined ? [] : [message.sender])]) {
    texts.push(box.name, box.address);
  }
  for (const a of message.attachments) texts.push(a.fileName, a.mimeType);
  if (!isDisplayableMs(message.date.utcMs)) texts.push(message.date.original);
  return texts.reduce((n, text) => n + (typeof text === 'string' ? codedCharacterCount(text) : 0), 0);
}

/**
 * The notes of the email at `position` (0-based) in the list, in the order
 * shown. [] if none. `rebuildWarnings`: the result's reconstructionWarnings
 * (only those of this email, by its input position, are used).
 */
export function messageNotes(
  m: EngineMessage,
  position: number,
  positionByIndex: readonly (number | null)[],
  rebuildWarnings: readonly ReconstructionWarning[] = [],
): MessageNote[] {
  const notes: MessageNote[] = [];
  const parse = new Set<ParseWarning>(m.parserWarnings);
  for (const code of PARSE_WARNINGS) {
    if (parse.has(code)) notes.push({ kind: 'parse', code });
    // The "placed at the end" note right after the date notes.
    if (code === DATE_WARNINGS[DATE_WARNINGS.length - 1] && m.order === 'file-order') notes.push({ kind: 'order', code: 'file-order' });
  }
  for (const code of DEDUPE_WARNINGS) {
    for (const w of m.dedupeWarnings) {
      if (w.code !== code) continue;
      // relatedTotal counts input files (src/engine/dedupe.ts), like `related`.
      const total = Number.isInteger(w.relatedTotal) ? w.relatedTotal : w.related.length;
      notes.push({
        kind: 'dedupe',
        code,
        related: relatedListNumbers(w.related, position, positionByIndex),
        more: Math.max(0, total - w.related.length),
      });
    }
  }
  if (codedCharacters(m) > 0) notes.push({ kind: 'chars', code: 'coded-characters' });
  const engine = new Set<EngineWarningCode>(m.engineWarnings);
  for (const code of ENGINE_WARNINGS) if (engine.has(code)) notes.push({ kind: 'engine', code });
  const rebuild = new Set<ReconstructionWarningCode>(rebuildWarnings.filter((w) => w.index === m.index).map((w) => w.code));
  for (const code of REBUILD_WARNINGS) if (rebuild.has(code)) notes.push({ kind: 'rebuild', code });
  return notes;
}
