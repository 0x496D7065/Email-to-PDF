// Tests for de-duplication (README.md, rules R6 and R7). Synthetic data only.

import { describe, expect, it } from 'vitest';
import type { EmailAddress, NormalizedMessage } from '../parsing/types';
import {
  authorKey,
  DATE_TOLERANCE_MS,
  dedupe,
  fromKey,
  MAX_RELATED,
  normalizeBody,
  subjectKey,
  type DedupeResult,
  type KeptMessage,
} from './dedupe';

// ------------------------------------------------------------------ factory

const ALICE: EmailAddress = { name: 'Alice Example', address: 'alice@example.test' };
const BOB: EmailAddress = { name: 'Bob Sample', address: 'bob@furniture.example.test' };
const CAROL: EmailAddress = { name: 'Carol Test', address: 'carol@sample.invalid' };
const PLANNING: EmailAddress = { name: 'Sample Furniture Planning', address: 'planning@furniture.example.test' };

const DATE_MS = Date.parse('2025-03-04T07:00:00Z');
let fileCounter = 0;

/**
 * A synthetic message: Alice to Bob, fixed date and body, a unique file
 * name and fake SHA-256 each call. `fields` overrides any field.
 */
function make(fields: Partial<NormalizedMessage> = {}): NormalizedMessage {
  fileCounter++;
  return {
    messageId: 'm1@example.test',
    inReplyTo: null,
    references: [],
    date: { utcMs: DATE_MS, original: 'Tue, 4 Mar 2025 08:00:00 +0100', offsetMinutes: 60, zoneKnown: true },
    from: [ALICE],
    to: [BOB],
    cc: [],
    bcc: [],
    subject: 'Desks',
    bodyText: 'Hello Bob,\n\nThe desks arrive on Monday.\n\nAlice\n',
    attachments: [],
    source: { fileName: `file-${String(fileCounter)}.eml`, sha256: fileCounter.toString(16).padStart(64, '0'), kind: 'eml' },
    warnings: [],
    ...fields,
  };
}

/** A date `deltaMs` after the default one. */
function at(deltaMs: number): NormalizedMessage['date'] {
  return { ...make().date, utcMs: DATE_MS + deltaMs };
}

/** The groups as sorted lists of file names (order-free, for comparing). */
function groupsOf(result: DedupeResult): string[][] {
  return result.kept
    .map((k) => [k.message.source.fileName, ...k.duplicates.map((d) => d.source.fileName)].sort())
    .sort((a, b) => (a.join() < b.join() ? -1 : 1));
}

/** The warning codes of a kept message. */
function codes(k: KeptMessage): string[] {
  return k.warnings.map((w) => w.code);
}

/** Recipient keys as the engine compares them (lower-cased address, else the name). */
function keys(list: readonly EmailAddress[]): string[] {
  return list.map((m) => (m.address !== '' ? m.address.toLowerCase() : `name:${m.name}`));
}

/**
 * The collapse-never-delete property (README.md, rule R6): every input
 * message is either kept, or listed exactly once in a kept message's
 * `duplicates`, and the kept copy holds everything the merged copy had.
 */
function expectNothingLost(input: readonly NormalizedMessage[], result: DedupeResult): void {
  const seen = new Map<number, number>();
  for (const k of result.kept) {
    const kept = k.message;
    expect(input[k.index]).toBe(kept);
    seen.set(k.index, (seen.get(k.index) ?? 0) + 1);
    for (const d of k.duplicates) {
      const copy = input[d.index]!;
      expect(copy.source).toBe(d.source);
      // Same content.
      expect(normalizeBody(copy.bodyText)).toBe(normalizeBody(kept.bodyText));
      expect(subjectKey(copy.subject)).toBe(subjectKey(kept.subject));
      expect(fromKey(copy)).toBe(fromKey(kept));
      expect(copy.attachments.map((a) => a.fileName).sort()).toEqual(kept.attachments.map((a) => a.fileName).sort());
      // The kept copy covers the merged copy's header data.
      for (const role of ['to', 'cc', 'bcc'] as const) {
        const keptKeys = new Set(keys(kept[role]));
        for (const key of keys(copy[role])) expect(keptKeys.has(key)).toBe(true);
      }
      if (copy.sender !== undefined) {
        expect(kept.sender).toBeDefined();
        expect(keys([kept.sender!])).toEqual(keys([copy.sender]));
      }
      if (copy.inReplyTo !== null) expect(kept.inReplyTo).toBe(copy.inReplyTo);
      for (const ref of copy.references) expect(kept.references).toContain(ref);
      // The rule really holds.
      const keptMs = kept.date.utcMs;
      const copyMs = copy.date.utcMs;
      if (d.rule === 'message-id') {
        expect(copy.messageId).not.toBeNull();
        expect(copy.messageId).toBe(kept.messageId);
        if (keptMs !== null && copyMs !== null) expect(Math.abs(keptMs - copyMs)).toBeLessThanOrEqual(DATE_TOLERANCE_MS);
      } else {
        expect(authorKey(copy)).not.toBe('');
        expect(authorKey(kept)).not.toBe('');
        expect(copyMs).not.toBeNull();
        expect(copyMs).toBe(keptMs);
      }
      // A known date is never dropped.
      if (copyMs !== null) expect(keptMs).not.toBeNull();
      seen.set(d.index, (seen.get(d.index) ?? 0) + 1);
    }
    // Warnings: at most MAX_RELATED positions, ascending, never the group's own members.
    const members = new Set([k.index, ...k.duplicates.map((d) => d.index)]);
    for (const w of k.warnings) {
      expect(w.related.length).toBeLessThanOrEqual(MAX_RELATED);
      expect(w.related.length).toBe(Math.min(w.relatedTotal, MAX_RELATED));
      for (let i = 1; i < w.related.length; i++) expect(w.related[i]!).toBeGreaterThan(w.related[i - 1]!);
      for (const i of w.related) expect(members.has(i)).toBe(false);
    }
  }
  expect(seen.size).toBe(input.length);
  for (const count of seen.values()) expect(count).toBe(1);
  expect(result.mergedCount).toBe(result.kept.reduce((n, k) => n + k.duplicates.length, 0));
  expect(result.kept.length + result.mergedCount).toBe(input.length);
}

function run(input: readonly NormalizedMessage[]): DedupeResult {
  const result = dedupe(input);
  expectNothingLost(input, result);
  return result;
}

// ------------------------------------------------------------------ helpers

describe('normalizeBody', () => {
  it('unifies line ends, trailing spaces and outer blank lines', () => {
    expect(normalizeBody('\r\n\r\nHi  \r\nthere\t\rend \n\n\n')).toBe('Hi\nthere\nend');
  });

  it('applies Unicode NFC', () => {
    expect(normalizeBody('cafe\u0301')).toBe('caf\u00E9');
  });

  it('keeps inner blank lines, inner spaces, leading spaces, case and quotes', () => {
    const text = 'A\n\n\nb  c\n  > Quoted\nNON-BREAKING\u00A0';
    expect(normalizeBody(text)).toBe(text);
  });

  it('turns an all-blank body into the empty string', () => {
    expect(normalizeBody(' \r\n\t\n')).toBe('');
  });
});

describe('subjectKey', () => {
  it('trims, collapses inner whitespace and applies NFC, nothing else', () => {
    expect(subjectKey('  Re:\t Office\r\n  desks  ')).toBe('Re: Office desks');
    expect(subjectKey('Cafe\u0301')).toBe('Caf\u00E9');
    expect(subjectKey('RE: [External] Desks')).toBe('RE: [External] Desks');
  });
});

describe('fromKey', () => {
  it('is order-free and case-free, and counts a mailbox without address by its name', () => {
    expect(fromKey(make({ from: [BOB, { name: 'A', address: 'Alice@Example.TEST' }] }))).toBe(fromKey(make({ from: [ALICE, BOB] })));
    expect(fromKey(make({ from: [{ name: 'Alice Example', address: '' }] }))).toBe('["name:Alice Example"]');
  });
});

describe('authorKey', () => {
  it('uses the first From address, lower-cased', () => {
    expect(authorKey(make({ from: [{ name: 'A', address: 'Alice@Example.TEST' }, BOB] }))).toBe('alice@example.test');
  });

  it('falls back to sender when there is no From, else empty', () => {
    expect(authorKey(make({ from: [], sender: PLANNING }))).toBe(PLANNING.address);
    expect(authorKey(make({ from: [] }))).toBe('');
  });
});

// ------------------------------------------------------------------ rules

describe('dedupe: matching rules', () => {
  it('merges same Message-ID + same body, rule message-id', () => {
    const a = make();
    const b = make({ date: at(1000) }); // .msg times can differ slightly
    const result = run([a, b]);
    expect(result.kept).toHaveLength(1);
    expect(result.mergedCount).toBe(1);
    expect(result.kept[0]!.message).toBe(a);
    expect(result.kept[0]!.duplicates).toEqual([{ source: b.source, index: 1, rule: 'message-id' }]);
    expect(result.kept[0]!.warnings).toEqual([]);
  });

  it('does NOT merge same Message-ID with a different body, and warns on both with the other index', () => {
    const a = make();
    const b = make({ bodyText: 'Hello Bob,\n\nThe desks arrive on Tuesday.\n\nAlice\n' });
    const result = run([a, b]);
    expect(result.mergedCount).toBe(0);
    expect(result.kept.map((k) => k.warnings)).toEqual([
      [{ code: 'same-id-different-content', related: [1], relatedTotal: 1 }],
      [{ code: 'same-id-different-content', related: [0], relatedTotal: 1 }],
    ]);
  });

  it('does NOT merge same Message-ID with a different author', () => {
    const result = run([make(), make({ from: [BOB] })]);
    expect(result.mergedCount).toBe(0);
    expect(result.kept.every((k) => codes(k).includes('same-id-different-content'))).toBe(true);
  });

  it('merges by author + date + body when there is no Message-ID', () => {
    const a = make({ messageId: null });
    const b = make({ messageId: null, from: [{ name: 'alice', address: 'ALICE@example.test' }] });
    const result = run([a, b]);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]!.duplicates[0]!.rule).toBe('author-date-body');
  });

  it('merges by author + date + body when the Message-IDs differ (re-sent copy)', () => {
    const result = run([make(), make({ messageId: 'other@relay.example.invalid' })]);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]!.duplicates[0]!.rule).toBe('author-date-body');
    expect(result.kept[0]!.warnings).toEqual([]);
  });

  it('does NOT merge the same body with a different date (no common id)', () => {
    expect(run([make({ messageId: null }), make({ messageId: null, date: at(60_000) })]).mergedCount).toBe(0);
  });

  it('does NOT use the author + date rule when the date is missing', () => {
    const noDate = { utcMs: null, original: '', offsetMinutes: null, zoneKnown: false };
    expect(run([make({ messageId: null, date: noDate }), make({ messageId: null, date: noDate })]).mergedCount).toBe(0);
    // ...but the same Message-ID still merges them, also when only one date is missing.
    expect(run([make({ date: noDate }), make({ date: noDate })]).mergedCount).toBe(1);
    expect(run([make({ date: noDate }), make()]).mergedCount).toBe(1);
  });

  it('does NOT use the author + date rule when the author is empty', () => {
    const anon = { from: [], messageId: null };
    expect(run([make(anon), make(anon)]).mergedCount).toBe(0);
    // An author that only exists as `sender` (no From) does count.
    expect(run([make({ ...anon, sender: PLANNING }), make({ ...anon, sender: PLANNING })]).mergedCount).toBe(1);
    // Same Message-ID with no author on either side: merged.
    expect(run([make({ from: [] }), make({ from: [] })]).mergedCount).toBe(1);
  });

  it('merges bodies that differ only in CRLF/LF, trailing spaces and the final line break', () => {
    const a = make({ messageId: null, bodyText: 'Hello Bob,\n\nThe desks arrive on Monday.\n\nAlice\n' });
    const b = make({ messageId: null, bodyText: 'Hello Bob,  \r\n\r\nThe desks arrive on Monday.\t\r\n\r\nAlice' });
    expect(run([a, b]).mergedCount).toBe(1);
  });

  it('does NOT merge bodies that differ in inner whitespace, blank lines or letter case', () => {
    const base = make({ messageId: null });
    for (const bodyText of [
      'Hello Bob,\n\nThe desks  arrive on Monday.\n\nAlice\n',
      'Hello Bob,\n\n\nThe desks arrive on Monday.\n\nAlice\n',
      'Hello Bob,\n\nthe desks arrive on Monday.\n\nAlice\n',
      '  Hello Bob,\n\nThe desks arrive on Monday.\n\nAlice\n',
    ]) {
      expect(run([base, make({ messageId: null, bodyText })]).mergedCount).toBe(0);
    }
  });

  it('needs the same attachment names (as a multiset), ignoring size and type', () => {
    const note = { fileName: 'note.txt', size: 136, mimeType: 'text/plain' };
    const a = make({ attachments: [note, { ...note, fileName: 'plan.txt' }] });
    const sameNames = make({ attachments: [{ fileName: 'plan.txt', size: null, mimeType: '' }, { ...note, size: 140 }] });
    expect(run([a, sameNames]).mergedCount).toBe(1);

    const otherName = make({ attachments: [note, { ...note, fileName: 'plan-v2.txt' }] });
    const res = run([a, otherName]);
    expect(res.mergedCount).toBe(0);
    expect(codes(res.kept[0]!)).toEqual(['same-id-different-content']);

    const repeated = make({ attachments: [note, note] });
    const once = make({ attachments: [note] });
    expect(run([repeated, once]).mergedCount).toBe(0);
  });
});

describe('dedupe: subject', () => {
  it('does NOT merge when the subject differs by a tag or a reply prefix', () => {
    for (const subject of ['[External] Desks', 'Re: Desks', 'desks']) {
      const result = run([make(), make({ subject })]);
      expect(result.mergedCount).toBe(0);
      expect(codes(result.kept[0]!)).toEqual(['same-id-different-content']);
      // Also without a Message-ID (author + date): kept apart, nothing to warn about.
      expect(run([make({ messageId: null }), make({ messageId: null, subject })]).mergedCount).toBe(0);
    }
  });

  it('merges subjects that differ only in outer or inner whitespace', () => {
    expect(run([make({ subject: 'Office desks' }), make({ subject: '  Office \t desks ' })]).mergedCount).toBe(1);
    expect(run([make({ messageId: null, subject: 'Office desks' }), make({ messageId: null, subject: 'Office\r\n desks' })]).mergedCount).toBe(1);
  });
});

describe('dedupe: From list', () => {
  it('does NOT merge when one copy has an extra From mailbox', () => {
    const result = run([make(), make({ from: [ALICE, CAROL] })]);
    expect(result.mergedCount).toBe(0);
    expect(codes(result.kept[0]!)).toEqual(['same-id-different-content']);
    expect(run([make({ messageId: null }), make({ messageId: null, from: [ALICE, CAROL] })]).mergedCount).toBe(0);
  });

  it('merges From lists that differ only in order, letter case or display name', () => {
    const a = make({ from: [ALICE, CAROL] });
    const b = make({ from: [{ ...ALICE, address: 'ALICE@example.test' }, { ...CAROL, name: 'carol' }] });
    expect(run([a, b]).mergedCount).toBe(1);
    // Reordered, by Message-ID and by author + date.
    expect(run([make({ from: [ALICE, CAROL] }), make({ from: [CAROL, ALICE] })]).mergedCount).toBe(1);
    const noId = { messageId: null };
    expect(run([make({ ...noId, from: [ALICE, CAROL] }), make({ ...noId, from: [CAROL, ALICE] })]).mergedCount).toBe(1);
  });

  it('compares From mailboxes without address by name', () => {
    const alice = { name: 'Alice Example', address: '' };
    const other = { name: 'Bob Sample', address: '' };
    expect(run([make({ from: [alice] }), make({ from: [alice] })]).mergedCount).toBe(1);
    const result = run([make({ from: [alice] }), make({ from: [other] })]);
    expect(result.mergedCount).toBe(0);
    expect(codes(result.kept[0]!)).toEqual(['same-id-different-content']);
    // A name-only author is still "empty" for the author + date rule.
    expect(run([make({ messageId: null, from: [alice] }), make({ messageId: null, from: [alice] })]).mergedCount).toBe(0);
  });
});

describe('dedupe: date under the Message-ID rule', () => {
  it(`merges dates up to ${String(DATE_TOLERANCE_MS)} ms apart`, () => {
    expect(run([make(), make({ date: at(DATE_TOLERANCE_MS) })]).mergedCount).toBe(1);
    expect(run([make(), make({ date: at(-DATE_TOLERANCE_MS) })]).mergedCount).toBe(1);
  });

  it('does NOT merge dates further apart, and warns', () => {
    const result = run([make(), make({ date: at(DATE_TOLERANCE_MS + 1) })]);
    expect(result.mergedCount).toBe(0);
    expect(result.kept.map((k) => k.warnings)).toEqual([
      [{ code: 'duplicate-date-differs', related: [1], relatedTotal: 1 }],
      [{ code: 'duplicate-date-differs', related: [0], relatedTotal: 1 }],
    ]);
  });

  it('a chain of close dates cannot merge two copies too far apart', () => {
    const half = DATE_TOLERANCE_MS * 0.75;
    const result = run([make(), make({ date: at(half) }), make({ date: at(2 * half) })]);
    expect(result.kept).toHaveLength(2);
    for (const k of result.kept) {
      const members = [k.index, ...k.duplicates.map((d) => d.index)];
      expect(members.includes(0) && members.includes(2)).toBe(false);
    }
    expect(result.kept.every((k) => codes(k).includes('duplicate-date-differs'))).toBe(true);
  });
});

describe('dedupe: recipients and sender', () => {
  it("merges the sender's own copy with Bcc and keeps the Bcc copy", () => {
    const received = make();
    const ownCopy = make({ bcc: [CAROL] });
    const result = run([received, ownCopy]);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]!.message).toBe(ownCopy);
    expect(result.kept[0]!.index).toBe(1);
    expect(result.kept[0]!.duplicates.map((d) => d.index)).toEqual([0]);
  });

  it('compares addresses without letter case', () => {
    const result = run([make({ to: [{ name: 'Bob', address: 'BOB@furniture.example.test' }] }), make()]);
    expect(result.mergedCount).toBe(1);
    expect(result.kept[0]!.index).toBe(0); // equal sets: earliest wins
  });

  it('does NOT merge copies whose recipients conflict, and warns', () => {
    const result = run([make({ cc: [CAROL] }), make({ bcc: [PLANNING] })]);
    expect(result.mergedCount).toBe(0);
    expect(result.kept.map(codes)).toEqual([['duplicate-recipients-differ'], ['duplicate-recipients-differ']]);
  });

  it('does NOT merge when the same person is in a different header (Cc in one, Bcc in the other)', () => {
    const result = run([make({ cc: [CAROL] }), make({ bcc: [CAROL] })]);
    expect(result.mergedCount).toBe(0);
    expect(codes(result.kept[0]!)).toEqual(['duplicate-recipients-differ']);
  });

  it('prefers the copy with a sender when recipients are equal', () => {
    const plain = make();
    const onBehalf = make({ sender: PLANNING });
    const result = run([plain, onBehalf]);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]!.message).toBe(onBehalf);
  });

  it('does NOT merge copies with two different senders', () => {
    const result = run([make({ sender: PLANNING }), make({ sender: CAROL })]);
    expect(result.mergedCount).toBe(0);
    expect(codes(result.kept[0]!)).toEqual(['duplicate-sender-differs']);
  });

  it('does NOT merge when the copy with more recipients is the one without the sender', () => {
    // Keeping either copy would lose header data (the Bcc line or the sender).
    const result = run([make({ sender: PLANNING }), make({ bcc: [CAROL] })]);
    expect(result.mergedCount).toBe(0);
    expect(codes(result.kept[0]!)).toEqual(['duplicate-sender-differs']);
  });
});

describe('dedupe: missing date', () => {
  const noDate = { utcMs: null, original: '', offsetMinutes: null, zoneKnown: false };

  it('keeps the dated copy when merging with an undated copy, in either order', () => {
    for (const order of [0, 1]) {
      const undated = make({ date: noDate });
      const dated = make();
      const result = run(order === 0 ? [undated, dated] : [dated, undated]);
      expect(result.kept).toHaveLength(1);
      expect(result.kept[0]!.message).toBe(dated);
      expect(result.kept[0]!.duplicates[0]!.rule).toBe('message-id');
      expect(result.kept[0]!.warnings).toEqual([]);
    }
  });

  it('keeps a dated copy for any input order (two undated, two dated copies)', () => {
    const input = [make({ date: noDate }), make(), make({ date: noDate }), make({ date: at(1000) })];
    let seed = 11;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let round = 0; round < 25; round++) {
      const shuffled = [...input];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      const result = run(shuffled);
      expect(result.kept).toHaveLength(1);
      expect(result.kept[0]!.message.date.utcMs).not.toBeNull();
      // Dated copies cover each other: the earliest in input order wins.
      const firstDated = shuffled.findIndex((m) => m.date.utcMs !== null);
      expect(result.kept[0]!.index).toBe(firstDated);
    }
  });

  it('does NOT merge when the undated copy has a Bcc line the dated copy lacks, and warns', () => {
    const result = run([make({ date: noDate, bcc: [CAROL] }), make()]);
    expect(result.mergedCount).toBe(0);
    expect(result.kept.map((k) => k.warnings)).toEqual([
      [{ code: 'duplicate-date-differs', related: [1], relatedTotal: 1 }],
      [{ code: 'duplicate-date-differs', related: [0], relatedTotal: 1 }],
    ]);
  });

  it('does NOT merge when the undated copy has the sender the dated copy lacks', () => {
    const apart = run([make({ date: noDate, sender: PLANNING }), make()]);
    expect(apart.mergedCount).toBe(0);
    expect(codes(apart.kept[0]!)).toEqual(['duplicate-date-differs']);
  });

  it('names the threading headers when they and the date both stand in the way', () => {
    const result = run([make({ date: noDate, references: ['o@example.test'] }), make()]);
    expect(result.mergedCount).toBe(0);
    expect(codes(result.kept[0]!)).toEqual(['duplicate-threading-differs']);
  });
});

describe('dedupe: threading headers', () => {
  it('keeps the copy with In-Reply-To and more References', () => {
    const bare = make();
    const threaded = make({ inReplyTo: 'p@example.test', references: ['o@example.test', 'p@example.test'] });
    const partial = make({ references: ['p@example.test'] });
    const result = run([bare, partial, threaded]);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]!.message).toBe(threaded);
  });

  it('does NOT merge copies with different In-Reply-To, and warns', () => {
    const result = run([make({ inReplyTo: 'p@example.test' }), make({ inReplyTo: 'q@example.test' })]);
    expect(result.mergedCount).toBe(0);
    expect(result.kept.map(codes)).toEqual([['duplicate-threading-differs'], ['duplicate-threading-differs']]);
  });

  it('does NOT merge copies whose References do not contain one another', () => {
    const result = run([make({ references: ['o@example.test'] }), make({ references: ['p@example.test'] })]);
    expect(result.mergedCount).toBe(0);
    expect(codes(result.kept[0]!)).toEqual(['duplicate-threading-differs']);
  });

  it('does NOT merge when the copy with more recipients has fewer References', () => {
    const result = run([make({ bcc: [CAROL] }), make({ references: ['o@example.test'] })]);
    expect(result.mergedCount).toBe(0);
    expect(codes(result.kept[0]!)).toEqual(['duplicate-threading-differs']);
  });
});

describe('dedupe: groups', () => {
  it('builds three-way groups and lists every merged copy in input order', () => {
    const a = make();
    const other = make({ messageId: 'other@example.test', bodyText: 'Something else' });
    const b = make({ source: { fileName: 'copy.msg', sha256: 'f'.repeat(64), kind: 'msg' } });
    const c = make({ messageId: null });
    const result = run([a, other, b, c]);
    expect(result.kept.map((k) => k.index)).toEqual([0, 1]);
    expect(result.mergedCount).toBe(2);
    expect(result.kept[0]!.duplicates).toEqual([
      { source: b.source, index: 2, rule: 'message-id' },
      { source: c.source, index: 3, rule: 'author-date-body' },
    ]);
  });

  it('merges an .eml and an .msg copy of the same message', () => {
    const eml = make({ bodyText: 'Hi Bob,\n\nSee you Monday.\n\nAlice\n' });
    const msg = make({
      bodyText: 'Hi Bob,\r\n\r\nSee you Monday.\r\n\r\nAlice',
      date: { utcMs: DATE_MS, original: new Date(DATE_MS).toISOString(), offsetMinutes: null, zoneKnown: true },
      source: { fileName: 'copy.msg', sha256: 'e'.repeat(64), kind: 'msg' },
    });
    const result = run([msg, eml]);
    expect(result.kept).toHaveLength(1);
    expect(result.kept[0]!.message).toBe(msg);
    expect(result.kept[0]!.duplicates[0]!.source.kind).toBe('eml');
  });

  it('a chain cannot merge two messages that differ (id link + author/date link)', () => {
    // a ~ b by Message-ID (both from Alice, dates within the tolerance);
    // b ~ c by author + date (c has another id). a and c share no id and no date.
    const a = make({ messageId: 'x@example.test', date: at(-60_000) });
    const b = make({ messageId: 'x@example.test' });
    const c = make({ messageId: 'y@example.test' });
    const result = run([a, b, c]);
    expect(result.kept).toHaveLength(2);
    for (const k of result.kept) {
      const members = [k.index, ...k.duplicates.map((d) => d.index)];
      expect(members.includes(0) && members.includes(2)).toBe(false);
    }
    // Both sides are flagged, each pointing at the message it matched in the other group.
    for (const k of result.kept) {
      const members = [k.index, ...k.duplicates.map((d) => d.index)];
      const flag = k.warnings.find((w) => w.code === 'possible-duplicate-not-merged');
      expect(flag).toBeDefined();
      expect(flag!.related).toHaveLength(1);
      expect(members).not.toContain(flag!.related[0]);
    }
  });

  it('a chain cannot merge two copies whose recipients conflict through a common smaller copy', () => {
    const small = make();
    const withCc = make({ cc: [CAROL] });
    const withBcc = make({ bcc: [PLANNING] });
    const result = run([withCc, small, withBcc]);
    expect(result.kept).toHaveLength(2);
    for (const k of result.kept) {
      const members = [k.index, ...k.duplicates.map((d) => d.index)];
      expect(members.includes(0) && members.includes(2)).toBe(false);
    }
    expect(result.kept.every((k) => codes(k).includes('duplicate-recipients-differ'))).toBe(true);
    // `related` never lists a member of the message's own group.
    for (const k of result.kept) {
      const members = new Set([k.index, ...k.duplicates.map((d) => d.index)]);
      for (const w of k.warnings) for (const i of w.related) expect(members.has(i)).toBe(false);
    }
  });

  it('keeps kept messages in the input order of their representative', () => {
    const x = make({ messageId: 'x@example.test', bodyText: 'X' });
    const a = make();
    const y = make({ messageId: 'y@example.test', bodyText: 'Y' });
    const aOwnCopy = make({ bcc: [CAROL] });
    const result = run([x, a, y, aOwnCopy]);
    expect(result.kept.map((k) => k.index)).toEqual([0, 2, 3]);
  });

  it('does not modify the input', () => {
    const input = [make(), make({ bcc: [CAROL] }), make({ messageId: null }), make({ bodyText: 'Other' })];
    const snapshot = structuredClone(input);
    const frozen = Object.freeze(input.map((m) => Object.freeze(m)));
    run(frozen);
    expect(input).toEqual(snapshot);
  });

  it('gives the same groups for any input order', () => {
    const input = [
      make(),
      make({ bcc: [CAROL] }),
      make({ messageId: null }),
      make({ cc: [PLANNING] }), // conflicts with the Bcc copy
      make({ messageId: 'z@example.test', bodyText: 'Z' }),
      make({ messageId: 'z@example.test', bodyText: 'Z\r\n' }),
      make({ messageId: 'x@example.test', date: at(-1) }),
      make({ date: at(90_000) }), // close to the first copies, but not to the next one
      make({ date: at(180_000) }),
      make({ references: ['o@example.test'] }),
    ];
    const expected = groupsOf(run(input));
    // A fixed pseudo-random sequence, so the test is repeatable.
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let round = 0; round < 25; round++) {
      const shuffled = [...input];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      expect(groupsOf(run(shuffled))).toEqual(expected);
    }
  });

  it('handles an empty input', () => {
    expect(dedupe([])).toEqual({ kept: [], mergedCount: 0 });
  });

  it('never merges a copy flagged html-body-unreadable or html-body-truncated with an unflagged one', () => {
    for (const warning of ['html-body-unreadable', 'html-body-truncated'] as const) {
      // Same text: e.g. copy A had a text/plain part "Intro" plus an HTML part
      // the converter failed on (or cut), copy B only the "Intro" part.
      const flagged = make({ bodyText: 'Intro', warnings: [warning] });
      const plain = make({ bodyText: 'Intro' });
      for (const input of [[flagged, plain], [plain, flagged]]) {
        const result = run(input);
        expect(result.mergedCount, warning).toBe(0);
        expect(result.kept.map((k) => k.message.warnings), warning).toEqual(input.map((m) => m.warnings));
        // Same Message-ID, different content: both say so.
        for (const k of result.kept) expect(codes(k), warning).toEqual(['same-id-different-content']);
      }
      // Two copies with the same warning still merge.
      expect(run([flagged, make({ bodyText: 'Intro', warnings: [warning] })]).mergedCount, warning).toBe(1);
    }
  });

  it('never merges an RTF-only copy (empty text, flagged rtf-only-body) with a copy that has no body', () => {
    // Both have an empty bodyText: the .msg has an RTF body that cannot be
    // shown, the other copy really has no body. Keeping the no-body copy
    // would hide that content exists.
    const rtfOnly = make({ bodyText: '', warnings: ['rtf-only-body'] });
    const noBody = make({ bodyText: '' });
    for (const input of [[rtfOnly, noBody], [noBody, rtfOnly]]) {
      const result = run(input);
      expect(result.mergedCount).toBe(0);
      expect(result.kept.map((k) => k.message.warnings)).toEqual(input.map((m) => m.warnings));
      for (const k of result.kept) expect(codes(k)).toEqual(['same-id-different-content']);
    }
    // Two RTF-only copies still merge.
    expect(run([rtfOnly, make({ bodyText: '', warnings: ['rtf-only-body'] })]).mergedCount).toBe(1);
  });

  it('keeps parser warnings untouched on the representative', () => {
    const a = make({ messageId: null, warnings: ['missing-message-id'] });
    const result = run([a, make({ messageId: null, warnings: ['missing-message-id'] })]);
    expect(result.kept[0]!.message.warnings).toBe(a.warnings);
    expect(result.kept[0]!.warnings).toEqual([]);
  });
});

describe('dedupe: warning size', () => {
  it(`lists at most ${String(MAX_RELATED)} related positions, the lowest ones, with the true total`, () => {
    // 30 identical copies with a Bcc line, and at position 10 one copy whose Cc conflicts with them.
    const input = Array.from({ length: 31 }, (_, i) => (i === 10 ? make({ cc: [CAROL] }) : make({ bcc: [PLANNING] })));
    const result = run(input);
    expect(result.kept).toHaveLength(2);
    const ccCopy = result.kept.find((k) => k.index === 10)!;
    const lowest = [...Array.from({ length: 10 }, (_, i) => i), ...Array.from({ length: 10 }, (_, i) => i + 11)];
    expect(ccCopy.warnings).toEqual([{ code: 'duplicate-recipients-differ', related: lowest, relatedTotal: 30 }]);
    const bccGroup = result.kept.find((k) => k.index !== 10)!;
    expect(bccGroup.duplicates).toHaveLength(29);
    expect(bccGroup.warnings).toEqual([{ code: 'duplicate-recipients-differ', related: [10], relatedTotal: 1 }]);
  });

  it('caps same-id-different-content too', () => {
    const input = [make(), ...Array.from({ length: 25 }, (_, i) => make({ bodyText: `Version ${String(i)}` }))];
    const result = run(input);
    expect(result.mergedCount).toBe(0);
    expect(result.kept[0]!.warnings).toEqual([
      { code: 'same-id-different-content', related: Array.from({ length: 20 }, (_, i) => i + 1), relatedTotal: 25 },
    ]);
    expect(result.kept[5]!.warnings).toEqual([
      { code: 'same-id-different-content', related: [0, 1, 2, 3, 4, ...Array.from({ length: 15 }, (_, i) => i + 6)], relatedTotal: 25 },
    ]);
  });

  it('counts each related message once, also when several group members relate to it', () => {
    // Two merged copies with different header data both conflict with the Cc copy.
    const result = run([make({ bcc: [PLANNING] }), make({ bcc: [PLANNING], references: ['o@example.test'] }), make({ cc: [CAROL] })]);
    expect(result.kept).toHaveLength(2);
    const group = result.kept.find((k) => k.duplicates.length === 1)!;
    expect(group.warnings).toEqual([{ code: 'duplicate-recipients-differ', related: [2], relatedTotal: 1 }]);
    const cc = result.kept.find((k) => k.index === 2)!;
    expect(cc.warnings).toEqual([{ code: 'duplicate-recipients-differ', related: [0, 1], relatedTotal: 2 }]);
  });
});

describe('dedupe: speed', () => {
  // Generous bounds so a slow CI machine passes; the point is "not quadratic".
  it('5000 messages with the same body, 50 authors, distinct dates, no ids: under 2 s', () => {
    const input = Array.from({ length: 5000 }, (_, i) =>
      make({
        messageId: null,
        bodyText: 'Thanks!',
        from: [{ name: 'Sender', address: `sender-${String(i % 50)}@example.test` }],
        date: at(i * 1000),
      }),
    );
    const start = performance.now();
    const result = dedupe(input);
    const elapsed = performance.now() - start;
    expect(result.mergedCount).toBe(0);
    expect(elapsed).toBeLessThan(2000);
  });

  it('5000 messages with the same body and one author: under 2 s', () => {
    const input = Array.from({ length: 5000 }, (_, i) => make({ messageId: null, bodyText: 'Thanks!', date: at(i * 1000) }));
    const start = performance.now();
    expect(dedupe(input).mergedCount).toBe(0);
    expect(performance.now() - start).toBeLessThan(2000);
  });

  it('many shared ids and dates (100 messages x 20 copies, plus 1000 copies of one message): under 2 s', () => {
    const input: NormalizedMessage[] = [];
    for (let m = 0; m < 100; m++) {
      for (let c = 0; c < 20; c++) {
        input.push(make({ messageId: `m${String(m)}@example.test`, bodyText: 'Thanks!', date: at(m * 1000) }));
      }
    }
    for (let c = 0; c < 1000; c++) input.push(make({ messageId: 'big@example.test', bodyText: 'Same' }));
    const start = performance.now();
    const result = dedupe(input);
    const elapsed = performance.now() - start;
    expect(result.kept).toHaveLength(101);
    expect(elapsed).toBeLessThan(2000);
  });

  it('5000 copies of one message whose Cc alternates between two values: under 2 s, warnings capped', () => {
    const input = Array.from({ length: 5000 }, (_, i) => make({ bodyText: 'Same', cc: [i % 2 === 0 ? CAROL : PLANNING] }));
    const start = performance.now();
    const result = dedupe(input);
    const elapsed = performance.now() - start;
    expect(result.kept).toHaveLength(2);
    for (const k of result.kept) {
      expect(k.duplicates).toHaveLength(2499);
      expect(k.warnings).toHaveLength(1);
      expect(k.warnings[0]!.code).toBe('duplicate-recipients-differ');
      expect(k.warnings[0]!.relatedTotal).toBe(2500);
      expect(k.warnings[0]!.related).toEqual(Array.from({ length: MAX_RELATED }, (_, i) => 2 * i + (k.index % 2 === 0 ? 1 : 0)));
    }
    expect(elapsed).toBeLessThan(2000);
  });
});
