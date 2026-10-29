// Unit tests for the emails rebuilt from quoted text in the PDF document
// model (src/pdf/model.ts: planPdfOrder, buildPdfDocument; task 7.7):
// their place, the numbering, the follow-source rule, the switch, what a
// rebuilt email shows, the index, the cover, and the hashes of real files
// only. Synthetic fixtures only (tests/fixtures/eml), run through the real
// engine and output plan, as the app does; a few results are edited by hand
// to reach rare cases (a day without a time, no sender, a list read short).
import { beforeAll, describe, expect, it } from 'vitest';
import { parseAllFixtures } from '../../tests/fixtures/parse-all';
import { runEngine, type EngineRebuilt, type EngineResult } from '../engine/engine';
import { DEFAULT_OUTPUT_POLICY, planOutput, type OutputPolicy } from '../engine/output-plan';
import type { QuotedDate } from '../engine/quoted-date';
import type { NormalizedMessage } from '../parsing/types';
import { rebuiltEntries } from '../ui-model/rebuilt';
import { buildPdfDocument, planPdfOrder, rebuiltAnchor, type PdfBlock, type PdfDocument, type PdfEmail } from './model';
import { createPdfStrings, type PdfStrings } from './strings';
import { bodyLines, lineText, type PdfLine } from './text';

let fixtures: Map<string, NormalizedMessage>;
beforeAll(async () => {
  fixtures = new Map((await parseAllFixtures()).map((m) => [m.source.fileName, m]));
});
const fixture = (name: string): NormalizedMessage => {
  const m = fixtures.get(`eml/${name}`);
  if (m === undefined) throw new Error(`no fixture ${name}`);
  return m;
};
const engineOf = (...names: string[]): EngineResult => runEngine(names.map((n) => ({ ok: true as const, message: fixture(n) })));

/** The last email of a synthetic thread: alone, it gives 3 rebuilt entries (ids 2, 1, 0, oldest first) before it. */
const LAST = '13-order-4-bob-outlook-nl.eml';
/** The email before it: with LAST, the two older emails are quoted in both (an entry and a copy each). */
const THIRD = '12-order-3-alice-gmail.eml';
const EN = createPdfStrings('en');

/** A copy of `result` with rebuilt message `id` changed by `edit`. */
function withRebuilt(result: EngineResult, id: number, edit: (r: EngineRebuilt) => EngineRebuilt): EngineResult {
  return { ...result, reconstructed: result.reconstructed.map((r) => (r.id === id ? edit(r) : r)) };
}

/** Builds the document of `result` with the given real positions (default all) and rebuilt ids (default every entry). */
function build(
  result: EngineResult,
  options: { positions?: readonly number[]; rebuilt?: readonly number[] | null; timeZone?: string; strings?: PdfStrings; policy?: OutputPolicy } = {},
): PdfDocument {
  const positions = options.positions ?? result.messages.map((_, k) => k);
  const policy = options.policy ?? DEFAULT_OUTPUT_POLICY;
  const plans = planOutput(
    positions.map((p) => result.messages[p]!),
    policy,
  );
  const rebuilt = options.rebuilt === undefined ? rebuiltEntries(result).map((r) => r.id) : options.rebuilt;
  return buildPdfDocument({
    result,
    positions,
    plans,
    policy,
    timeZone: options.timeZone ?? 'Africa/Lagos',
    generatedAt: Date.UTC(2025, 5, 1, 12, 0, 0),
    strings: options.strings ?? EN,
    ...(rebuilt === null ? {} : { rebuilt }),
  });
}

const text = (line: PdfLine): string => lineText(line);
const fieldOf = (e: PdfEmail, label: string): string[] | undefined => e.fields.find((f) => f.label === label)?.value.map(text);
const rebuiltOf = (doc: PdfDocument): PdfEmail[] => doc.emails.filter((e) => e.rebuilt !== null);
const blockTexts = (blocks: readonly PdfBlock[]): string[] =>
  blocks.flatMap((b) => {
    switch (b.kind) {
      case 'heading':
      case 'paragraph':
        return [text(b.line)];
      case 'fields':
        return b.rows.map((r) => `${r.label}: ${r.value.map(text).join(' / ')}`);
      case 'list':
        return b.items.map((item) => item.map(text).join(' / '));
    }
  });

/** Entries with a copy in the other email, and where each copy was read (list positions). */
function sharedEntries(result: EngineResult): { entry: EngineRebuilt; own: number; other: number; copy: EngineRebuilt }[] {
  return rebuiltEntries(result)
    .filter((e) => e.copies.length > 0)
    .map((entry) => {
      const copy = result.reconstructed[entry.copies[0]!]!;
      return { entry, copy, own: result.positionByIndex[entry.sourceIndex]!, other: result.positionByIndex[copy.sourceIndex]! };
    });
}

// ---------------------------------------------------------------- the plan

describe('planPdfOrder', () => {
  it('puts each rebuilt email chosen at its place in the timeline, before the email it was taken from, without a number', () => {
    const result = engineOf(LAST);
    const order = planPdfOrder(result, [0], [0, 1, 2]);
    expect(order.slots.map((s) => (s.kind === 'email' ? `email ${String(s.number)}` : `rebuilt ${String(s.entry.id)}`))).toEqual([
      'rebuilt 2',
      'rebuilt 1',
      'rebuilt 0',
      'email 1',
    ]);
    expect(order.pdfNumberByPosition).toEqual([1]);
    for (const slot of order.slots) {
      if (slot.kind !== 'rebuilt') continue;
      expect(slot.source.number).toBe(1);
      expect(slot.source.also).toEqual([]);
      expect(slot.source.shown.rebuilt).toBe(slot.entry);
    }
  });

  it('gives none with the switch off ([] or nothing given), and the real emails exactly as before', () => {
    const result = engineOf(LAST);
    for (const ids of [[], undefined]) {
      const order = planPdfOrder(result, [0], ids);
      expect(order.slots).toEqual([{ kind: 'email', position: 0, number: 1, plan: 0 }]);
    }
  });

  it('follows the source email: none when the email they were taken from is not in the PDF (user decision Q1 (a))', () => {
    const result = engineOf(LAST);
    expect(planPdfOrder(result, [], [0, 1, 2]).slots).toEqual([]);
    expect(planPdfOrder(result, [], [0, 1, 2]).pdfNumberByPosition).toEqual([null]);
  });

  it('ignores unknown, repeated and non-entry ids', () => {
    const result = engineOf(LAST);
    const order = planPdfOrder(result, [0], [99, -1, 1.5, 1, 1, Number.NaN]);
    expect(order.slots.map((s) => (s.kind === 'email' ? 'email' : s.entry.id))).toEqual([1, 'email']);
    // A copy ('same-as') or a rebuilt email matched to a real file ('real') never gets a place of its own.
    const two = engineOf(THIRD, LAST);
    const all = two.reconstructed.map((r) => r.id);
    const ids = planPdfOrder(two, [0, 1], all).slots.flatMap((s) => (s.kind === 'rebuilt' ? [s.entry.id] : []));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(two.reconstructed[id]!.link).toBe('entry');
    expect(new Set(ids).size).toBe(ids.length);
    const files = engineOf('10-order-1-alice.eml', '11-order-2-bob-outlook-en.eml', THIRD, LAST);
    expect(planPdfOrder(files, [0, 1, 2, 3], files.reconstructed.map((r) => r.id)).slots.every((s) => s.kind === 'email')).toBe(true);
  });

  it('gives no rebuilt email when the timeline is not valid (the real emails alone, as given)', () => {
    const result = engineOf(LAST);
    const order = planPdfOrder({ ...result, timeline: [] }, [0], [0, 1, 2]);
    expect(order.slots.map((s) => s.kind)).toEqual(['email']);
  });

  it('names emails by their number IN THE PDF, which differs from the preview number once an email is left out', () => {
    const result = engineOf(THIRD, LAST);
    expect(result.messages).toHaveLength(2);
    const shared = sharedEntries(result);
    expect(shared.length).toBeGreaterThan(0);
    // Only the second email (preview #2) in the PDF: it is email 1 there.
    const order = planPdfOrder(result, [1], rebuiltEntries(result).map((r) => r.id));
    expect(order.pdfNumberByPosition).toEqual([null, 1]);
    const rebuilt = order.slots.filter((s) => s.kind === 'rebuilt');
    expect(rebuilt.length).toBeGreaterThan(0);
    for (const slot of rebuilt) {
      expect(slot.source.shown.position).toBe(1);
      expect(slot.source.number).toBe(1);
      expect(slot.source.also).toEqual([]);
    }
  });

  it('keeps a text quoted in several emails while one of them is in the PDF, taken from one in the PDF (follow-source rule)', () => {
    const result = engineOf(THIRD, LAST);
    expect(sharedEntries(result).length).toBeGreaterThan(0);
    for (const { entry, copy, own, other } of sharedEntries(result)) {
      expect(own).not.toBe(other);
      const plan = (positions: number[]) => {
        const order = planPdfOrder(result, positions, [entry.id]);
        const slot = order.slots.find((s) => s.kind === 'rebuilt');
        return slot?.kind === 'rebuilt' ? slot.source : null;
      };
      // Both in: its own source, the other one "also in".
      const both = plan([0, 1]);
      expect(both?.shown.rebuilt).toBe(entry);
      expect(both?.number).toBe(own + 1);
      expect(both?.also).toEqual([other + 1]);
      // Its own source left out: shown as read from the other email, which it names.
      const otherOnly = plan([other]);
      expect(otherOnly?.shown.rebuilt).toBe(copy);
      expect(otherOnly?.shown.position).toBe(other);
      expect(otherOnly?.number).toBe(1);
      expect(otherOnly?.also).toEqual([]);
      // Neither: not in the PDF.
      expect(plan([])).toBeNull();
    }
  });

  it('keeps the real emails in the order given (positions not in list order), the rebuilt ones placed before the first later email', () => {
    const result = engineOf(LAST);
    const order = planPdfOrder(result, [0, 0, 7], [2]);
    expect(order.slots.map((s) => s.kind)).toEqual(['rebuilt', 'email']);
  });
});

// ---------------------------------------------------------------- the document

describe('a rebuilt email in the PDF document', () => {
  it('is marked in its heading, has no number and no position, and names the email it was taken from', () => {
    const doc = build(engineOf(LAST));
    expect(doc.emails.map((e) => e.heading)).toEqual([
      'Earlier email (rebuilt from quoted text in email 1)',
      'Earlier email (rebuilt from quoted text in email 1)',
      'Earlier email (rebuilt from quoted text in email 1)',
      'Email 1',
    ]);
    expect(doc.emails.map((e) => e.number)).toEqual([null, null, null, 1]);
    expect(doc.emails.map((e) => e.position)).toEqual([null, null, null, 0]);
    expect(doc.emails.map((e) => e.anchor)).toEqual([rebuiltAnchor(2), rebuiltAnchor(1), rebuiltAnchor(0), 'email-1']);
    expect(rebuiltOf(doc).map((e) => e.rebuilt)).toEqual([2, 1, 0].map((id) => ({ id, shownId: id, sourcePosition: 0, takenFrom: 1, also: [] })));
    expect(doc.pdfNumberByPosition).toEqual([1]);
  });

  it('shows the fields read from the quote, a "Taken from" row and never a File row', () => {
    const doc = build(engineOf(LAST));
    const [, gmail, outlookNl] = rebuiltOf(doc);
    expect(outlookNl!.fields.map((f) => f.label)).toEqual(['From', 'To', 'Date', 'Subject', 'Taken from']);
    expect(fieldOf(outlookNl!, 'From')).toEqual(['Alice Example <alice@example.test>']);
    expect(fieldOf(outlookNl!, 'Subject')).toEqual(['Re: Office desks and chairs']);
    expect(fieldOf(outlookNl!, 'Taken from')).toEqual(['email 1']);
    // A time read without a zone of its own: "about", in the chosen zone, and as written.
    expect(fieldOf(outlookNl!, 'Date')).toEqual([expect.stringMatching(/^about 2025-03-03 \d\d:40 UTC\+01:00$/), 'As written in the quote: maandag 3 maart 2025 15:40']);
    for (const e of rebuiltOf(doc)) expect(fieldOf(e, 'File')).toBeUndefined();
    // An attribution has no subject: our own placeholder, muted.
    expect(gmail!.fields.find((f) => f.label === 'Subject')!.value).toEqual([[{ role: 'muted', text: '(subject not in the quote)' }]]);
  });

  it('carries the fixed note of the preview (with the PDF number) and its rebuilt text, whole', () => {
    const result = engineOf(LAST);
    const doc = build(result);
    expect(rebuiltOf(doc).map((e) => e.notes.map(text))).toEqual([
      ['Rebuilt from the quoted text in email 1. Quote marks removed; may be incomplete or inexact.'],
      ['Rebuilt from the quoted text in email 1. Quote marks removed; may be incomplete or inexact.'],
      ['Rebuilt from the quoted text in email 1. May be incomplete or inexact.'],
    ]);
    for (const e of rebuiltOf(doc)) {
      const r = result.reconstructed[e.rebuilt!.id]!;
      expect(e.body.map(text)).toEqual(bodyLines(r.rebuilt.reconstructedText).lines.map(text));
      expect(e.body.map(text).join('\n')).not.toMatch(/^>/m);
      expect(e.attachments).toBeNull();
    }
  });

  it('says where else the same text is quoted, with PDF numbers', () => {
    const result = engineOf(THIRD, LAST);
    const doc = build(result);
    const also = rebuiltOf(doc).flatMap((e) => e.notes.map(text).filter((n) => n.startsWith('Same quoted text')));
    expect(also.length).toBe(sharedEntries(result).length);
    for (const line of also) expect(line).toMatch(/^Same quoted text also in email [12]\.$/);
  });

  it('shows "about" only for a time: a day alone is shown as written (user decision Q2)', () => {
    const base = engineOf(LAST);
    const day = Date.UTC(2025, 2, 3);
    const dated = (date: Partial<QuotedDate>, approximate: boolean) =>
      withRebuilt(base, 0, (r) => ({
        ...r,
        rebuilt: {
          ...r.rebuilt,
          dateText: '3 March 2025',
          dateApproximate: approximate,
          date: { text: '3 March 2025', wallMs: day, precision: 'day', estimatedUtcMs: day - 3_600_000, basis: 'source-offset', ...date },
        },
      }));
    for (const approximate of [true, false]) {
      const e = rebuiltOf(build(dated({}, approximate))).find((x) => x.rebuilt!.id === 0)!;
      expect(fieldOf(e, 'Date')).toEqual(['2025-03-03', 'As written in the quote: 3 March 2025']);
    }
    const doc = build(dated({}, true));
    const entry = doc.index.entries.find((x) => x.anchor === rebuiltAnchor(0))!;
    expect(text(entry.date)).toBe('2025-03-03');
    // A time: "about" in the index too (short form, no offset).
    const timeEntry = build(base).index.entries.find((x) => x.anchor === rebuiltAnchor(0))!;
    expect(text(timeEntry.date)).toMatch(/^about 2025-03-03 \d\d:40$/);
    // Unreadable or missing.
    const unreadable = withRebuilt(base, 0, (r) => ({ ...r, rebuilt: { ...r.rebuilt, dateText: 'gisteren', date: null } }));
    expect(fieldOf(rebuiltOf(build(unreadable)).find((x) => x.rebuilt!.id === 0)!, 'Date')).toEqual(['(date could not be read)', 'As written in the quote: gisteren']);
    const none = withRebuilt(base, 0, (r) => ({ ...r, rebuilt: { ...r.rebuilt, dateText: null, date: null } }));
    const noneEmail = rebuiltOf(build(none)).find((x) => x.rebuilt!.id === 0)!;
    expect(fieldOf(noneEmail, 'Date')).toEqual(['(no date)']);
    expect(noneEmail.flags.undated).toBe(true);
  });

  it('says "Unknown sender" and "(list may be incomplete)" when the quote says no more', () => {
    const result = withRebuilt(engineOf(LAST), 0, (r) => ({ ...r, rebuilt: { ...r.rebuilt, from: [], incomplete: ['to', 'cc'], cc: [] } }));
    const doc = build(result);
    const e = rebuiltOf(doc).find((x) => x.rebuilt!.id === 0)!;
    expect(fieldOf(e, 'From')).toEqual(['Unknown sender']);
    expect(fieldOf(e, 'To')?.[0]).toMatch(/^.+ \(list may be incomplete\)$/);
    expect(fieldOf(e, 'Cc')).toEqual(['(list may be incomplete)']);
    const entry = doc.index.entries.find((x) => x.anchor === rebuiltAnchor(0))!;
    expect(entry.from).toEqual([{ role: 'muted', text: 'Unknown sender' }]);
  });

  it('counts the control characters of its text, shown as codes', () => {
    const result = withRebuilt(engineOf(LAST), 0, (r) => ({ ...r, rebuilt: { ...r.rebuilt, reconstructedText: 'Hello\u0007 there' } }));
    const doc = build(result);
    const e = rebuiltOf(doc).find((x) => x.rebuilt!.id === 0)!;
    expect(e.flags.controlChars).toBe(1);
    expect(doc.controlChars).toBe(build(engineOf(LAST)).controlChars + 1);
  });

  it('is written in the PDF language', () => {
    const doc = build(engineOf(LAST), { strings: createPdfStrings('fr') });
    const e = rebuiltOf(doc)[0]!;
    expect(e.heading).toBe('E-mail antérieur (reconstitué à partir du texte cité dans l’e-mail 1)');
    expect(fieldOf(e, 'Tiré de')).toEqual(['l’e-mail 1']);
    expect(text(doc.index.entries[0]!.subject).startsWith('[Reconstitué] ')).toBe(true);
  });
});

describe('the index, the bookmarks and the cover with rebuilt emails', () => {
  it('index: no number, the subject starts with the marker, a link anchor of its own; bookmark marked too', () => {
    const doc = build(engineOf(LAST));
    const entries = doc.index.entries;
    expect(entries.map((e) => e.number)).toEqual([null, null, null, 1]);
    expect(entries.map((e) => e.rebuilt)).toEqual([true, true, true, false]);
    expect(entries.map((e) => e.anchor)).toEqual(doc.emails.map((e) => e.anchor));
    for (const e of entries.slice(0, 3)) {
      expect(e.subject[0]).toEqual({ role: 'field-label', text: '[Rebuilt]' });
      expect(text(e.subject).startsWith('[Rebuilt] ')).toBe(true);
      expect(e.bookmark.startsWith('[Rebuilt] ')).toBe(true);
      expect(e.attachments).toBe(0);
    }
    expect(entries[2]!.bookmark).toBe('[Rebuilt] 2025-03-03, Alice Example: Re: Office desks and chairs');
    expect(entries[1]!.bookmark).toMatch(/^\[Rebuilt\] \d{4}-\d\d-\d\d, .+: \(subject not in the quote\)$/);
    expect(entries[3]!.bookmark.startsWith('1. ')).toBe(true);
  });

  it('cover: a count row and a section saying what rebuilt emails are; "Emails" counts real emails only', () => {
    const doc = build(engineOf(LAST));
    expect(doc.cover.emailCount).toBe(1);
    expect(doc.cover.rebuiltCount).toBe(3);
    const texts = blockTexts(doc.cover.blocks);
    expect(texts).toContain('Emails: 1 email');
    expect(texts).toContain('Rebuilt emails: 3 earlier emails rebuilt from quoted text');
    expect(texts).toContain('Earlier emails rebuilt from quoted text');
    expect(texts).toContain(EN.rebuiltIntro);
    expect(EN.rebuiltIntro).toMatch(/not original files/);
    expect(EN.rebuiltIntro).toContain(EN.rebuiltMarker);
    // One rebuilt email: singular.
    const one = build(engineOf(LAST), { rebuilt: [0] });
    expect(blockTexts(one.cover.blocks)).toContain('Rebuilt emails: 1 earlier email rebuilt from quoted text');
  });

  it('cover: SHA-256 hashes of the REAL files only; a rebuilt email has none and is not a source', () => {
    const doc = build(engineOf(LAST));
    const file = fixture(LAST).source;
    expect(doc.cover.sources).toEqual([{ fileName: file.fileName, sha256: file.sha256, kind: file.kind, inputIndex: 0, email: 1, mergedCopy: false }]);
    const hashes = blockTexts(doc.cover.blocks).join('\n').match(/\b[0-9a-f]{64}\b/g);
    expect(hashes).toEqual([file.sha256]);
    for (const e of rebuiltOf(doc)) expect(e.fields.map((f) => f.value.map(text).join(' ')).join(' ')).not.toMatch(/[0-9a-f]{64}/);
  });

  it('nothing about rebuilt emails when none is chosen (switch off), and the real email is exactly the same either way', () => {
    const result = engineOf(LAST);
    const off = build(result, { rebuilt: [] });
    const absent = build(result, { rebuilt: null });
    const on = build(result);
    expect(off).toEqual(absent);
    expect(off.emails.map((e) => e.heading)).toEqual(['Email 1']);
    expect(off.cover.rebuiltCount).toBe(0);
    expect(blockTexts(off.cover.blocks).some((t) => /rebuilt/i.test(t))).toBe(false);
    // Collapse, never delete: the source email is untouched (its quoted history folded exactly as before).
    expect(on.emails.find((e) => e.number === 1)).toEqual(off.emails[0]);
    expect(on.index.entries.find((e) => e.number === 1)).toEqual(off.index.entries[0]);
    expect(on.cover.sources).toEqual(off.cover.sources);
    expect(on.cover.dateRange).toEqual(off.cover.dateRange);
    expect(on.cover.participants).toEqual(off.cover.participants);
  });

  it('the source email unticked: no rebuilt email at all (it follows its source)', () => {
    const result = engineOf(THIRD, LAST);
    const doc = build(result, { positions: [] });
    expect(doc.emails).toEqual([]);
    expect(doc.cover.rebuiltCount).toBe(0);
  });
});

describe('"Print full original text" (policy.unfoldEverything; user decision 2026-10-28, task 7.8b)', () => {
  const EVERYTHING: OutputPolicy = { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true };

  it('leaves every rebuilt email out, whatever was chosen: no heading, no index marker, no bookmark, nothing on the cover', () => {
    const result = engineOf(LAST);
    const ids = rebuiltEntries(result).map((r) => r.id);
    expect(ids).toHaveLength(3);
    const doc = build(result, { rebuilt: ids, policy: EVERYTHING });
    expect(rebuiltOf(doc)).toEqual([]);
    expect(doc.emails.map((e) => e.number)).toEqual([1]);
    expect(doc.emails.some((e) => e.heading.startsWith('Earlier email'))).toBe(false);
    expect(doc.index.entries.map((e) => e.rebuilt)).toEqual([false]);
    expect(doc.index.entries.some((e) => e.bookmark.includes(EN.rebuiltMarker) || text(e.subject).includes(EN.rebuiltMarker))).toBe(false);
    expect(doc.cover.rebuiltCount).toBe(0);
    expect(doc.cover.emailCount).toBe(1);
    const cover = blockTexts(doc.cover.blocks);
    expect(cover.some((t) => /rebuilt/i.test(t))).toBe(false);
    expect(cover).not.toContain(EN.rebuiltSection);
    expect(cover).not.toContain(EN.rebuiltIntro);
  });

  it('prints the source email whole, quoted history included (collapse, never delete), the same as with no rebuilt email chosen', () => {
    const result = engineOf(LAST);
    const ids = rebuiltEntries(result).map((r) => r.id);
    const doc = build(result, { rebuilt: ids, policy: EVERYTHING });
    const body = doc.emails[0]!.body.map(text);
    expect(body).toEqual(bodyLines(result.messages[0]!.message.bodyText).lines.map(text));
    // Every rebuilt text is inside it, so nothing of them is lost.
    for (const r of rebuiltEntries(result)) {
      const lines = r.rebuilt.reconstructedText.split('\n').filter((l) => l.trim() !== '');
      for (const line of lines) expect(body.join('\n')).toContain(line.trim());
    }
    expect(doc).toEqual(build(result, { rebuilt: [], policy: EVERYTHING }));
  });

  it('back to the default policy, the same choice gives the rebuilt emails again (nothing forgotten)', () => {
    const result = engineOf(LAST);
    const ids = rebuiltEntries(result).map((r) => r.id);
    build(result, { rebuilt: ids, policy: EVERYTHING });
    const doc = build(result, { rebuilt: ids });
    expect(rebuiltOf(doc)).toHaveLength(3);
    expect(doc.cover.rebuiltCount).toBe(3);
  });

  it('also when the text is quoted in several emails', () => {
    const result = engineOf(THIRD, LAST);
    const doc = build(result, { policy: EVERYTHING });
    expect(rebuiltOf(doc)).toEqual([]);
    expect(doc.emails.map((e) => e.number)).toEqual([1, 2]);
    expect(rebuiltOf(build(result))).not.toEqual([]);
  });
});
