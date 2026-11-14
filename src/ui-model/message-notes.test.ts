// Unit tests for the notes of an email (message-notes.ts). Synthetic data only.
import { describe, expect, it } from 'vitest';
import type { DedupeWarning } from '../engine/dedupe';
import { runEngine, type EngineMessage } from '../engine/engine';
import type { NormalizedMessage, ParseResult } from '../parsing/types';
import { t } from '../ui/i18n';
import { codedCharacters, DEDUPE_WARNINGS, ENGINE_WARNINGS, messageNotes, PARSE_WARNINGS, PDF_NOTES, pdfPlanNote, REBUILD_WARNINGS, relatedListNumbers } from './message-notes';

let counter = 0;
function make(fields: Partial<NormalizedMessage> = {}): NormalizedMessage {
  counter++;
  return {
    messageId: `n${String(counter)}@example.test`,
    inReplyTo: null,
    references: [],
    date: { utcMs: Date.parse('2025-03-03T08:15:00Z') + counter * 60_000, original: 'synthetic', offsetMinutes: 60, zoneKnown: true },
    from: [{ name: 'Alice Example', address: 'alice@example.test' }],
    to: [{ name: 'Bob Sample', address: 'bob@example.test' }],
    cc: [],
    bcc: [],
    subject: `Chairs ${String(counter)}`,
    bodyText: `Hello Bob,\n\nNote ${String(counter)} about the chairs.\n\nAlice\n`,
    attachments: [],
    source: { fileName: `n-${String(counter)}.eml`, sha256: counter.toString(16).padStart(64, '0'), kind: 'eml' },
    warnings: [],
    ...fields,
  };
}

/** A kept email with the given warnings, for messageNotes directly. */
function engineMessage(fields: Partial<EngineMessage> = {}): EngineMessage {
  const message = make();
  return {
    message,
    index: 0,
    order: 'by-date',
    duplicates: [],
    dedupeWarnings: [],
    parserWarnings: [],
    engineWarnings: [],
    segments: [],
    ...fields,
  };
}

describe('code lists', () => {
  it('name each code once', () => {
    for (const list of [PARSE_WARNINGS, DEDUPE_WARNINGS, ENGINE_WARNINGS, REBUILD_WARNINGS]) expect(new Set(list).size).toBe(list.length);
  });
});

describe('pdfPlanNote', () => {
  it('says when the PDF keeps a whole email, and why', () => {
    expect(pdfPlanNote({ keptAllBecauseEmpty: false, fallback: false })).toBeNull();
    expect(pdfPlanNote({ keptAllBecauseEmpty: true, fallback: false })).toBe('pdf-kept-all-empty');
    expect(pdfPlanNote({ keptAllBecauseEmpty: false, fallback: true })).toBe('pdf-fallback');
    expect(new Set(PDF_NOTES).size).toBe(PDF_NOTES.length);
    expect(t('review.pdfNote.pdf-kept-all-empty')).toMatch(/^The whole email will be in the PDF: /);
    expect(t('review.pdfNote.pdf-fallback')).toMatch(/^The whole email will be in the PDF: /);
  });

  it('does not say "the whole email" when parts of it are printed as emails of their own (task 8.11, S1, done in task 8.13a)', () => {
    expect(pdfPlanNote({ keptAllBecauseEmpty: true, fallback: false }, true)).toBe('pdf-kept-all-empty-elsewhere');
    expect(pdfPlanNote({ keptAllBecauseEmpty: true, fallback: false }, false)).toBe('pdf-kept-all-empty');
    // A plan not trusted: the body is printed whole anyway (no part is left out of it).
    expect(pdfPlanNote({ keptAllBecauseEmpty: false, fallback: true }, true)).toBe('pdf-fallback');
    expect(pdfPlanNote({ keptAllBecauseEmpty: false, fallback: false }, true)).toBeNull();
    expect(t('review.pdfNote.pdf-kept-all-empty-elsewhere')).toBe(
      'The tool could not tell its own text from the quote: everything is in the PDF except the parts printed as emails of their own.',
    );
  });
});

describe('relatedListNumbers', () => {
  it('maps input positions to 1-based list numbers, never the email itself', () => {
    // Inputs 0..4 sit at list positions 2, null (failed file), 0, 2, 1. Own position: 0.
    const byIndex = [2, null, 0, 2, 1];
    expect(relatedListNumbers([0, 1, 2, 3, 4, 99], 0, byIndex)).toEqual([2, 3]);
    expect(relatedListNumbers([], 0, byIndex)).toEqual([]);
    expect(relatedListNumbers([2], 0, byIndex)).toEqual([]);
  });
});

describe('messageNotes', () => {
  it('gives no notes to an email without warnings', () => {
    expect(messageNotes(engineMessage(), 0, [0])).toEqual([]);
  });

  it('lists the date notes, then "placed at the end", then the other notes, in a fixed order', () => {
    const m = engineMessage({
      order: 'file-order',
      parserWarnings: ['missing-message-id', 'html-converted-body', 'missing-date'],
      engineWarnings: ['folding-disabled', 'detector-failed'],
    });
    expect(messageNotes(m, 0, [0])).toEqual([
      { kind: 'parse', code: 'missing-date' },
      { kind: 'order', code: 'file-order' },
      { kind: 'parse', code: 'html-converted-body' },
      { kind: 'parse', code: 'missing-message-id' },
      { kind: 'engine', code: 'detector-failed' },
      { kind: 'engine', code: 'folding-disabled' },
    ]);
  });

  it('says an undated attached email is placed just before the email it is attached to (task 8.13b-3, Q7)', () => {
    const m = engineMessage({ order: 'before-parent', parserWarnings: ['missing-date'] });
    expect(messageNotes(m, 0, [0])).toEqual([
      { kind: 'parse', code: 'missing-date' },
      { kind: 'order', code: 'before-parent' },
    ]);
  });

  it('adds the problems while rebuilding earlier emails from the quote of THIS email, last, each once', () => {
    const m = engineMessage({ index: 3, engineWarnings: ['detector-failed'] });
    const warnings = [
      { index: 2, code: 'reconstruct-failed' as const },
      { index: 3, code: 'reconstruct-limit' as const },
      { index: 3, code: 'reconstruct-failed' as const },
      { index: 3, code: 'reconstruct-limit' as const },
    ];
    expect(messageNotes(m, 0, [null, null, null, 0], warnings)).toEqual([
      { kind: 'engine', code: 'detector-failed' },
      { kind: 'rebuild', code: 'reconstruct-failed' },
      { kind: 'rebuild', code: 'reconstruct-limit' },
    ]);
    expect(messageNotes(m, 0, [null, null, null, 0])).toEqual([{ kind: 'engine', code: 'detector-failed' }]);
    for (const code of REBUILD_WARNINGS) expect(t(`warnings.rebuild.${code}`)).toMatch(/still in this email[.]$/);
  });

  it('shows each code once even if it is repeated', () => {
    const m = engineMessage({ parserWarnings: ['no-body', 'no-body'], engineWarnings: ['dedupe-failed', 'dedupe-failed'] });
    expect(messageNotes(m, 0, [0]).map((n) => n.code)).toEqual(['no-body', 'dedupe-failed']);
  });

  it('points look-alike notes to the other emails and counts the ones left off the list', () => {
    const warnings: DedupeWarning[] = [
      // Input 1 is this email itself (position 0): never listed.
      { code: 'possible-duplicate-not-merged', related: [1, 2, 3], relatedTotal: 7 },
      { code: 'same-id-different-content', related: [2], relatedTotal: 1 },
    ];
    const m = engineMessage({ dedupeWarnings: warnings });
    expect(messageNotes(m, 0, [null, 0, 2, 1])).toEqual([
      { kind: 'dedupe', code: 'same-id-different-content', related: [3], more: 0 },
      { kind: 'dedupe', code: 'possible-duplicate-not-merged', related: [2, 3], more: 4 },
    ]);
  });

  it('works on a real engine result: same id, different content, each points to the other', () => {
    const a = make({ messageId: 'same@example.test', bodyText: 'First text.\n' });
    const b = make({ messageId: 'same@example.test', bodyText: 'Another text.\n' });
    const result = runEngine([a, b].map((message): ParseResult => ({ ok: true, message })));
    expect(result.messages).toHaveLength(2);
    const notes = result.messages.map((m, position) => messageNotes(m, position, result.positionByIndex));
    expect(notes[0]).toContainEqual({ kind: 'dedupe', code: 'same-id-different-content', related: [2], more: 0 });
    expect(notes[1]).toContainEqual({ kind: 'dedupe', code: 'same-id-different-content', related: [1], more: 0 });
  });
});

describe('codedCharacters (task 8.8: the PDF shows them as codes without a note, so the app says it)', () => {
  it('counts what the PDF writes as a code, in every text the PDF can show of the email', () => {
    expect(codedCharacters(engineMessage())).toBe(0);
    const at = (fields: Partial<NormalizedMessage>, extra: Partial<EngineMessage> = {}): number => codedCharacters(engineMessage({ message: make(fields), ...extra }));
    // Body: a NUL and a lone surrogate; tabs, line breaks, U+2028 and emoji are not codes.
    expect(at({ bodyText: 'a\u0000b\tc\r\nd\u2028e \u{1F600} \uD800' })).toBe(2);
    expect(at({ subject: 'Re\u0007' })).toBe(1);
    expect(at({ from: [{ name: 'Ali\u001Bce', address: 'alice@example.test' }] })).toBe(1);
    expect(at({ to: [{ name: '', address: 'b\u202Eob@example.test' }] })).toBe(1);
    expect(at({ cc: [{ name: '\u0085', address: '' }], bcc: [{ name: '\u0001', address: '' }] })).toBe(2);
    expect(at({ sender: { name: 'Desk\u0002', address: 'desk@example.test' } })).toBe(1);
    expect(at({ attachments: [{ fileName: 'plan\u0000.png', size: 1, mimeType: 'image/png\u0003' }] })).toBe(2);
    expect(at({ source: { fileName: 'odd\u0004.eml', sha256: 'a'.repeat(64), kind: 'eml' } })).toBe(1);
    const copy = { ...make({ source: { fileName: 'copy\u0005.eml', sha256: 'b'.repeat(64), kind: 'eml' } }) };
    expect(at({}, { duplicates: [{ index: 1, source: copy.source, rule: 'message-id' }] })).toBe(1);
    // The date as written only counts when the PDF shows it: when the date could not be read.
    expect(at({ date: { utcMs: Date.parse('2025-03-03T08:15:00Z'), original: 'Mon\u0007', offsetMinutes: 0, zoneKnown: true } })).toBe(0);
    expect(at({ date: { utcMs: null, original: 'Mon\u0007', offsetMinutes: null, zoneKnown: false } })).toBe(1);
  });

  it('gives an email with such characters one note, after the look-alike notes; none without', () => {
    expect(messageNotes(engineMessage(), 0, [0])).toEqual([]);
    const notes = messageNotes(engineMessage({ message: make({ bodyText: 'a\u0000b\u0000c' }), parserWarnings: ['missing-message-id'] }), 0, [0]);
    expect(notes).toEqual([
      { kind: 'parse', code: 'missing-message-id' },
      { kind: 'chars', code: 'coded-characters' },
    ]);
    expect(t('review.codedCharacters')).toBe('This email contains hidden or damaged characters. In the PDF they may appear as codes such as [U+0000].');
  });
});
