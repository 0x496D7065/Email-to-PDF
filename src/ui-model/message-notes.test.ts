// Unit tests for the notes of an email (message-notes.ts). Synthetic data only.
import { describe, expect, it } from 'vitest';
import type { DedupeWarning } from '../engine/dedupe';
import { runEngine, type EngineMessage } from '../engine/engine';
import type { NormalizedMessage, ParseResult } from '../parsing/types';
import { t } from '../ui/i18n';
import { DEDUPE_WARNINGS, ENGINE_WARNINGS, messageNotes, PARSE_WARNINGS, PDF_NOTES, pdfPlanNote, relatedListNumbers } from './message-notes';

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
    for (const list of [PARSE_WARNINGS, DEDUPE_WARNINGS, ENGINE_WARNINGS]) expect(new Set(list).size).toBe(list.length);
  });
});

describe('pdfPlanNote', () => {
  it('says when the PDF keeps a whole email, and why', () => {
    expect(pdfPlanNote({ keptAllBecauseEmpty: false, fallback: false })).toBeNull();
    expect(pdfPlanNote({ keptAllBecauseEmpty: true, fallback: false })).toBe('pdf-kept-all-empty');
    expect(pdfPlanNote({ keptAllBecauseEmpty: false, fallback: true })).toBe('pdf-fallback');
    expect(new Set(PDF_NOTES).size).toBe(PDF_NOTES.length);
    for (const code of PDF_NOTES) expect(t(`review.pdfNote.${code}`)).toMatch(/^The whole email will be in the PDF: /);
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
