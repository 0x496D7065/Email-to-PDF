// Unit tests for the no-repeat rule of the PDF document model (user
// decision 2026-11-06, task 8.10; src/pdf/model.ts: printedElsewhere,
// headerShownInPdf, withoutPrintedElsewhere, buildPdfDocument): when "Print
// full original text" is off, a part of an email's text that the PDF
// prints as an email of its own is left out of that email's text, header
// lines included, except the writer's answer (B1, S5: a place whose text
// holds own text or a kept signature next to quoted text is not cut at
// all, review round 3, narrowed by task 8.13a Q3: a place of own text only,
// such as a middle email of an Outlook chain, is cut). Header lines the
// printed header cannot show (B2, S3, S4) move to the top of the rebuilt
// email (task 8.13a, Q4), or are dropped when a real file prints the email.
// A forwarded part of an unticked rebuilt email is left out (Q2); any other
// rebuilt email not in the PDF leaves its text where the plan puts it; with
// "Print full original text" everything is printed as written.
// The whole PDF path is checked over every test conversation in
// src/pdf/generate.no-repeat.test.ts. Synthetic data only
// (tests/support/thread-cases.ts; README.md, rule R7).
import { describe, expect, it } from 'vitest';
import { buildThread, instantOf, type ThreadMessage } from '../../tests/support/thread-builder';
import { THREAD_CASES, type ThreadCase } from '../../tests/support/thread-cases';
import { runEngine, type EngineResult } from '../engine/engine';
import { DEFAULT_OUTPUT_POLICY, planOutput, type MessagePlan, type OutputPolicy, type PlanRange } from '../engine/output-plan';
import type { NormalizedMessage } from '../parsing/types';
import { rebuiltEntries } from '../ui-model/rebuilt';
import {
  buildPdfDocument,
  extraTail,
  headerLinesEnd,
  headerShownInPdf,
  holdsOwnText,
  holdsQuotedText,
  noRepeat,
  pdfBodyText,
  pdfRanges,
  planPdfOrder,
  printedElsewhere,
  printedElsewhereParts,
  withoutPrintedElsewhere,
  type BodyIntervals,
  type PdfDocument,
  type PdfEmail,
} from './model';
import { createPdfStrings } from './strings';
import { bodyLines, lineText } from './text';

const EN = createPdfStrings('en');
const EVERYTHING: OutputPolicy = { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true };

function thread(id: string): ThreadCase {
  const c = THREAD_CASES.find((x) => x.id === id);
  if (c === undefined) throw new Error(`no case ${id}`);
  return c;
}

/** Message `i` of a conversation as a real file (its body quotes the ones before it); `body` replaces its body. */
function realFile(messages: readonly ThreadMessage[], i: number, body?: string): NormalizedMessage {
  const m = messages[i]!;
  const utcMs = instantOf(m.sent, m.zone);
  return {
    messageId: `no-repeat-${String(i)}@example.test`,
    inReplyTo: null,
    references: [],
    date: { utcMs, original: new Date(utcMs).toUTCString(), offsetMinutes: m.zone.offsetMinutes, zoneKnown: true },
    from: [m.from],
    to: m.to,
    cc: m.cc ?? [],
    bcc: [],
    subject: m.subject,
    bodyText: body ?? buildThread(messages.slice(0, i + 1)).body,
    attachments: [],
    source: { fileName: `no-repeat-${String(i)}.eml`, sha256: (i + 1).toString(16).padStart(64, '0'), kind: 'eml' },
    warnings: [],
  };
}

function engineOf(c: ThreadCase, dropped: readonly number[]): EngineResult {
  return runEngine(dropped.map((i) => ({ ok: true as const, message: realFile(c.messages!, i) })));
}

function build(
  result: EngineResult,
  options: { positions?: readonly number[]; rebuilt?: readonly number[]; unticked?: readonly number[]; rebuildingOff?: boolean; policy?: OutputPolicy; plans?: MessagePlan[] } = {},
): PdfDocument {
  const positions = options.positions ?? result.messages.map((_, k) => k);
  const policy = options.policy ?? DEFAULT_OUTPUT_POLICY;
  return buildPdfDocument({
    result,
    positions,
    plans:
      options.plans ??
      planOutput(
        positions.map((p) => result.messages[p]!),
        policy,
      ),
    policy,
    timeZone: 'UTC',
    generatedAt: Date.UTC(2025, 5, 1, 12, 0, 0),
    strings: EN,
    rebuilt: options.rebuilt ?? rebuiltEntries(result).map((r) => r.id),
    rebuildingOff: options.rebuildingOff ?? false,
    unticked: options.unticked ?? [],
  });
}

const bodyOf = (e: PdfEmail): string => e.body.map(lineText).join('\n');
const realOf = (doc: PdfDocument, position: number): PdfEmail => doc.emails.find((e) => e.position === position)!;
const squash = (s: string): string => s.replace(/\s+/gu, ' ').trim();
/** The own sentence of message `k` of a conversation (thread-cases.ts), white space squashed. */
const sentence = (c: ThreadCase, k: number): string => squash(c.messages![k]!.text.split('\n\n')[1]!);

const FORWARD = thread('gmail forward of an outlook thread');

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number): string => String(n).padStart(2, '0');
/** An RFC 5322 date in UTC with its zone written ("Mon, 3 Mar 2025 17:52:00 +0000"): an exact quoted date. */
function rfcDate(utcMs: number): string {
  const d = new Date(utcMs);
  return `${DAYS[d.getUTCDay()]!}, ${String(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]!} ${String(d.getUTCFullYear())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())} +0000`;
}

/**
 * The quoted dates of a FORWARD body ("Date:" / "Sent:" lines, newest first)
 * written with their own zone, at the true instant of each quoted email, so
 * the rebuilt emails print them exactly (and still match the real files).
 */
function exactDates(body: string): string {
  const quoted = FORWARD.messages!.slice(0, 2).reverse();
  let k = 0;
  const out = body.replace(/^(Date|Sent): .+$/gmu, (line, label: string) => {
    const m = quoted[k++];
    return m === undefined ? line : `${label}: ${rfcDate(instantOf(m.sent, m.zone))}`;
  });
  if (k !== 2) throw new Error(`FORWARD has ${String(k)} quoted dates: update exactDates`);
  return out;
}

describe('printedElsewhere', () => {
  it('covers the whole place of each chosen rebuilt email, header lines included, even when its date is only estimated (task 8.13a, Q4); nothing for one not chosen', () => {
    const result = engineOf(FORWARD, [2]);
    const entries = rebuiltEntries(result);
    expect(entries).toHaveLength(2);
    // The quoted dates of this conversation have no zone of their own ("Mon, Mar 3, 2025 at 6:52 PM").
    expect(entries.every((r) => r.rebuilt.dateApproximate)).toBe(true);
    const order = planPdfOrder(result, [0], entries.map((r) => r.id));
    const all = printedElsewhere(result, order.slots, order.pdfNumberByPosition);
    const places = entries.map((r) => [r.rebuilt.start, r.rebuilt.end] as const).sort((a, b) => a[0] - b[0]);
    // The two places touch: one interval, header lines included (they move to the rebuilt emails, Q4).
    expect(places[0]![1]).toBe(places[1]![0]);
    expect(all.get(0)).toEqual([[places[0]![0], places[1]![1]]]);
    // Only the newer one chosen: only its place.
    const newer = entries.find((r) => r.rebuilt.generation === 1)!;
    const one = planPdfOrder(result, [0], [newer.id]);
    expect(printedElsewhere(result, one.slots, one.pdfNumberByPosition).get(0)).toEqual([[newer.rebuilt.start, newer.rebuilt.end]]);
    // None chosen, or the source not in the PDF: nothing.
    const none = planPdfOrder(result, [0], []);
    expect(printedElsewhere(result, none.slots, none.pdfNumberByPosition).size).toBe(0);
    const out = planPdfOrder(result, [], entries.map((r) => r.id));
    expect(printedElsewhere(result, out.slots, out.pdfNumberByPosition).size).toBe(0);
  });

  it('covers a part linked to a real email only while that real email is in the PDF', () => {
    const result = engineOf(FORWARD, [0, 1, 2]);
    const linked = result.reconstructed.filter((r) => r.link === 'real');
    expect(linked.length).toBeGreaterThan(0);
    const all = planPdfOrder(result, [0, 1, 2]);
    const covered = printedElsewhere(result, all.slots, all.pdfNumberByPosition);
    for (const r of linked) {
      const source = result.positionByIndex[r.sourceIndex]!;
      // Its text at least (its header lines too only when the header rows show all they say, B2).
      expect(covered.get(source)!.some(([a, b]) => a <= r.rebuilt.headerEnd && r.rebuilt.end <= b)).toBe(true);
    }
    // The real emails they are linked to left out: their places are not covered.
    const sources = new Set(linked.map((r) => result.positionByIndex[r.sourceIndex]!));
    const realOnes = new Set(linked.map((r) => result.positionByIndex[r.realIndex!]!));
    const positions = [...sources].filter((p) => !realOnes.has(p));
    const only = planPdfOrder(result, positions);
    const left = printedElsewhere(result, only.slots, only.pdfNumberByPosition);
    for (const r of linked) {
      const source = result.positionByIndex[r.sourceIndex]!;
      expect((left.get(source) ?? []).some(([a, b]) => a < r.rebuilt.end && r.rebuilt.start < b)).toBe(false);
    }
  });

  it('covers a copy of a chosen entry in the other email that quotes it (link "same-as"), and neither when the entry is not chosen', () => {
    const c = thread('gmail-en x3');
    const result = engineOf(c, [2, 3]);
    const copies = result.reconstructed.filter((r) => r.link === 'same-as');
    expect(copies.length).toBeGreaterThan(0);
    const all = planPdfOrder(result, [0, 1], rebuiltEntries(result).map((r) => r.id));
    const covered = printedElsewhere(result, all.slots, all.pdfNumberByPosition);
    for (const copy of copies) {
      const source = result.positionByIndex[copy.sourceIndex]!;
      expect(covered.get(source)!.some(([a, b]) => a <= copy.rebuilt.headerEnd && copy.rebuilt.end <= b)).toBe(true);
    }
    const copy = copies[0]!;
    const without = rebuiltEntries(result)
      .map((r) => r.id)
      .filter((id) => id !== copy.sameAs);
    const some = planPdfOrder(result, [0, 1], without);
    const left = printedElsewhere(result, some.slots, some.pdfNumberByPosition);
    for (const r of [copy, result.reconstructed[copy.sameAs!]!]) {
      const source = result.positionByIndex[r.sourceIndex]!;
      expect((left.get(source) ?? []).some(([a, b]) => a < r.rebuilt.end && r.rebuilt.start < b)).toBe(false);
    }
  });

  it('skips a rebuilt email whose place is not inside its source body (when unsure, keep)', () => {
    const result = engineOf(FORWARD, [2]);
    const length = result.messages[0]!.message.bodyText.length;
    const broken: EngineResult = {
      ...result,
      reconstructed: result.reconstructed.map((r) => ({ ...r, rebuilt: { ...r.rebuilt, start: r.rebuilt.start, end: length + 5 } })),
    };
    const order = planPdfOrder(broken, [0], rebuiltEntries(broken).map((r) => r.id));
    expect(printedElsewhere(broken, order.slots, order.pdfNumberByPosition).size).toBe(0);
  });
});

describe('withoutPrintedElsewhere', () => {
  const body = 'own text\nFrom: x\nquoted\nmore own\n';
  const ranges: PlanRange[] = [
    { start: 0, end: 9, keep: true, reason: 'text' },
    { start: 9, end: 24, keep: true, reason: 'forwarded' },
    { start: 24, end: 33, keep: true, reason: 'text' },
  ];

  it('leaves out the kept pieces inside the parts, cut at their bounds, whatever their reason (task 8.13a: printedElsewhere alone decides what goes)', () => {
    const cut = withoutPrintedElsewhere(body, ranges, [[9, 24]]);
    expect(cut.leftOut).toBe(true);
    expect(cut.ranges).toEqual([
      { start: 0, end: 9, keep: true, reason: 'text' },
      { start: 9, end: 24, keep: false, reason: 'forwarded' },
      { start: 24, end: 33, keep: true, reason: 'text' },
    ]);
    // A part over a 'text' range cuts it too (before task 8.13a it stayed whole; printedElsewhere now
    // gives no part for a place that holds the writer's answer, B1 / Q3).
    expect(withoutPrintedElsewhere(body, ranges, [[9, 33]]).ranges).toEqual([
      { start: 0, end: 9, keep: true, reason: 'text' },
      { start: 9, end: 24, keep: false, reason: 'forwarded' },
      { start: 24, end: 33, keep: false, reason: 'text' },
    ]);
  });

  it('a "text" range is cut at the bounds of a part, its white space and its text alike', () => {
    const spaced = 'Yes.\n\n\nquoted\n';
    const r: PlanRange[] = [
      { start: 0, end: 7, keep: true, reason: 'text' },
      { start: 7, end: 14, keep: true, reason: 'writer-quote' },
    ];
    const cut = withoutPrintedElsewhere(spaced, r, [[5, 14]]);
    expect(cut.ranges).toEqual([
      { start: 0, end: 5, keep: true, reason: 'text' },
      { start: 5, end: 7, keep: false, reason: 'text' },
      { start: 7, end: 14, keep: false, reason: 'writer-quote' },
    ]);
    expect(withoutPrintedElsewhere(spaced, r, [[2, 14]]).ranges.slice(0, 2)).toEqual([
      { start: 0, end: 2, keep: true, reason: 'text' },
      { start: 2, end: 7, keep: false, reason: 'text' },
    ]);
  });

  it('touching and overlapping parts (as printedElsewhere merges them) cut each range once', () => {
    const r: PlanRange[] = [{ start: 0, end: 33, keep: true, reason: 'forwarded' }];
    expect(withoutPrintedElsewhere(body, r, [[9, 24]]).ranges).toEqual([
      { start: 0, end: 9, keep: true, reason: 'forwarded' },
      { start: 9, end: 24, keep: false, reason: 'forwarded' },
      { start: 24, end: 33, keep: true, reason: 'forwarded' },
    ]);
  });

  it('cuts a range in the middle and leaves left-out ranges as they are', () => {
    const cut = withoutPrintedElsewhere(body, [{ start: 0, end: 9, keep: false, reason: 'app-quoted-history' }, ...ranges.slice(1)], [[12, 18]]);
    expect(cut.ranges).toEqual([
      { start: 0, end: 9, keep: false, reason: 'app-quoted-history' },
      { start: 9, end: 12, keep: true, reason: 'forwarded' },
      { start: 12, end: 18, keep: false, reason: 'forwarded' },
      { start: 18, end: 24, keep: true, reason: 'forwarded' },
      { start: 24, end: 33, keep: true, reason: 'text' },
    ]);
  });

  it('nothing printed elsewhere: the same ranges; white space alone does not count as left out', () => {
    expect(withoutPrintedElsewhere(body, ranges, [])).toEqual({ ranges, leftOut: false });
    const spaced = 'abc\n\n\ndef';
    const r: PlanRange[] = [{ start: 0, end: 9, keep: true, reason: 'forwarded' }];
    expect(withoutPrintedElsewhere(spaced, r, [[3, 6]]).leftOut).toBe(false);
  });

  it('pdfBodyText: the parts are left out of the kept text, except under "Print full original text"', () => {
    const plan: MessagePlan = { ranges, tailStart: null, omittedSignatures: 0, keptAllBecauseEmpty: false, fallback: false };
    const parts: BodyIntervals = [[9, 24]];
    expect(pdfBodyText(body, plan, DEFAULT_OUTPUT_POLICY, parts).text).toBe('own text\nmore own\n');
    expect(pdfBodyText(body, plan, EVERYTHING, parts).text).toBe(body);
    // A plan that is not trusted: the whole body (when unsure, keep).
    expect(pdfBodyText(body, { ...plan, fallback: true }, DEFAULT_OUTPUT_POLICY, parts).text).toBe(body);
  });
});

describe('buildPdfDocument: no email twice (task 8.10)', () => {
  it('a forward: the forwarded emails, printed as emails of their own, are left out of the forward', () => {
    const result = engineOf(FORWARD, [2]);
    const doc = build(result);
    expect(doc.emails).toHaveLength(3);
    const forward = realOf(doc, 0);
    expect(forward.flags.printedElsewhere).toBe(true);
    // The quoted dates have no zone ("Mon, Mar 3, 2025 at 6:52 PM"), so the rebuilt emails print an
    // estimate: the original header lines leave the forward and are printed, as written, at the top of
    // the rebuilt email they belong to (task 8.13a, Q4; before, they stayed in the forward, B2).
    const body = result.messages[0]!.message.bodyText;
    expect(squash(bodyOf(forward))).toBe(squash(FORWARD.messages![2]!.text));
    for (const r of rebuiltEntries(result)) {
      const e = doc.emails.find((x) => x.rebuilt?.id === r.id)!;
      expect(e.rebuilt!.movedHeaders).toBe(1);
      const lines = squash(body.slice(r.rebuilt.start, r.rebuilt.headerEnd));
      expect(squash(bodyOf(e))).toBe(squash(`${lines}\n${r.rebuilt.reconstructedText}`));
      // Exactly once in the PDF.
      expect(doc.emails.filter((x) => squash(bodyOf(x)).includes(lines))).toEqual([e]);
    }
    for (const k of [0, 1]) {
      const holding = doc.emails.filter((e) => squash(bodyOf(e)).includes(sentence(FORWARD, k)));
      expect(holding.map((e) => e.rebuilt !== null)).toEqual([true]);
    }
  });

  it('a forward whose quoted dates carry their own zone: its header lines are left out too', () => {
    const result = runEngine([{ ok: true, message: realFile(FORWARD.messages!, 2, exactDates(buildThread(FORWARD.messages!).body)) }]);
    const entries = rebuiltEntries(result);
    expect(entries).toHaveLength(2);
    expect(entries.every((r) => !r.rebuilt.dateApproximate)).toBe(true);
    const doc = build(result);
    const forward = realOf(doc, 0);
    expect(squash(bodyOf(forward))).toBe(squash(FORWARD.messages![2]!.text));
    // No header line of a forwarded email left in it.
    expect(bodyOf(forward)).not.toMatch(/^(From|Date|Sent|Subject|To):/mu);
    expect(bodyOf(forward)).not.toContain('Forwarded message');
  });

  it('the switch off: the forwarded emails stay in the forward, as the plan says (no rebuilt email is "unticked")', () => {
    const result = engineOf(FORWARD, [2]);
    const off = build(result, { rebuilt: [], rebuildingOff: true });
    const plain = bodyOf(realOf(off, 0));
    expect(realOf(off, 0).flags.printedElsewhere).toBe(false);
    for (const k of [0, 1]) expect(squash(plain)).toContain(sentence(FORWARD, k));
  });

  it('a forwarded email whose rebuilt email is unticked is left out of the forward (task 8.13a, Q2); "Print full original text" still prints it', () => {
    const result = engineOf(FORWARD, [2]);
    const ids = rebuiltEntries(result).map((r) => r.id);
    const none = build(result, { rebuilt: [], unticked: ids });
    expect(none.emails).toHaveLength(1);
    expect(squash(bodyOf(realOf(none, 0)))).toBe(squash(FORWARD.messages![2]!.text));
    // Only the older one ticked: the newer one (unticked) is nowhere, the older one is printed once, as its rebuilt email.
    const older = rebuiltEntries(result).find((r) => r.rebuilt.generation === 2)!;
    const doc = build(result, { rebuilt: [older.id], unticked: ids.filter((id) => id !== older.id) });
    const forward = squash(bodyOf(realOf(doc, 0)));
    expect(forward).toBe(squash(FORWARD.messages![2]!.text));
    expect(doc.emails.filter((e) => squash(bodyOf(e)).includes(sentence(FORWARD, 1)))).toHaveLength(0);
    expect(doc.emails.filter((e) => squash(bodyOf(e)).includes(sentence(FORWARD, 0))).map((e) => e.rebuilt?.id)).toEqual([older.id]);
    // Collapse, never delete: the full text prints the whole forward.
    const full = build(result, { rebuilt: [], policy: EVERYTHING });
    for (const k of [0, 1, 2]) expect(squash(bodyOf(realOf(full, 0)))).toContain(sentence(FORWARD, k));
  });

  it('a rebuilt email merely missing from the chosen ones is NOT unticked (task 8.13a review round 2): its forwarded part stays in the forward', () => {
    const result = engineOf(FORWARD, [2]);
    const ids = rebuiltEntries(result).map((r) => r.id);
    // No `unticked` (the card list fell back, a card could not be shown, the review list failed): nothing is cut for Q2.
    for (const doc of [build(result, { rebuilt: [] }), build(result, { rebuilt: [], unticked: [] })]) {
      expect(doc.emails).toHaveLength(1);
      expect(realOf(doc, 0).flags.printedElsewhere).toBe(false);
      for (const k of [0, 1]) expect(squash(bodyOf(realOf(doc, 0)))).toContain(sentence(FORWARD, k));
    }
    const plans = planOutput(result.messages, DEFAULT_OUTPUT_POLICY);
    for (const rebuilt of [undefined, [] as number[]]) {
      expect(noRepeat({ result, positions: [0], plans, policy: DEFAULT_OUTPUT_POLICY, ...(rebuilt === undefined ? {} : { rebuilt }) }).parts.size).toBe(0);
    }
    // One unticked, the other only missing: only the unticked one is left out.
    expect(ids).toHaveLength(2);
    const first = ids[0]!;
    const parts = noRepeat({ result, positions: [0], plans, policy: DEFAULT_OUTPUT_POLICY, rebuilt: [], unticked: [first] }).parts.get(0)!;
    expect(parts.map((p) => p.printedAs)).toEqual([{ kind: 'unticked', id: first }]);
    expect(parts[0]).toMatchObject({ start: result.reconstructed[first]!.rebuilt.start, end: result.reconstructed[first]!.rebuilt.end });
    // An id both chosen and "unticked" counts as chosen; the switch off ignores `unticked`.
    expect(build(result, { rebuilt: ids, unticked: ids }).emails).toHaveLength(3);
    expect(realOf(build(result, { rebuilt: [], unticked: ids, rebuildingOff: true }), 0).flags.printedElsewhere).toBe(false);
  });

  it('"Print full original text": the forward is printed whole and no rebuilt email is in', () => {
    const result = engineOf(FORWARD, [2]);
    const doc = build(result, { policy: EVERYTHING });
    expect(doc.emails).toHaveLength(1);
    expect(doc.emails[0]!.flags.printedElsewhere).toBe(false);
    expect(doc).toEqual(build(result, { policy: EVERYTHING, rebuilt: [] }));
    for (const k of [0, 1, 2]) expect(squash(bodyOf(doc.emails[0]!))).toContain(sentence(FORWARD, k));
  });

  it('every email added as a file: the forwarded part is left out of the forward, the real files print it', () => {
    const result = engineOf(FORWARD, [0, 1, 2]);
    const doc = build(result, { rebuilt: [] });
    for (const k of [0, 1, 2]) expect(doc.emails.filter((e) => squash(bodyOf(e)).includes(sentence(FORWARD, k))), `message ${String(k)}`).toHaveLength(1);
    // Without the real files it quotes, the forward keeps them.
    const alone = build(result, { positions: [2], rebuilt: [] });
    for (const k of [0, 1, 2]) expect(squash(bodyOf(alone.emails[0]!))).toContain(sentence(FORWARD, k));
  });

  it('a forward with no text of its own (dates with a zone): "(no text)", its forwarded emails printed once as their own', () => {
    const built = buildThread(FORWARD.messages!);
    const passedOn = exactDates(built.body.slice(built.headers[0]!.start));
    const result = runEngine([{ ok: true, message: realFile(FORWARD.messages!, 2, passedOn) }]);
    expect(rebuiltEntries(result)).toHaveLength(2);
    const doc = build(result);
    const forward = realOf(doc, 0);
    expect(forward.body).toEqual([]);
    expect(forward.notes.map(lineText)).toEqual([EN.noText]);
    for (const k of [0, 1]) expect(doc.emails.filter((e) => squash(bodyOf(e)).includes(sentence(FORWARD, k)))).toHaveLength(1);
  });

  it('a reply: its quoted history is left out by its plan anyway, the rule changes nothing', () => {
    const c = thread('outlook-en x3');
    const result = engineOf(c, [3]);
    const on = build(result);
    const off = build(result, { rebuilt: [] });
    expect(bodyOf(realOf(on, 0))).toBe(bodyOf(realOf(off, 0)));
    expect(realOf(on, 0).flags.printedElsewhere).toBe(false);
  });
});

// Round 2 of task 8.10 (user decisions 2026-11-06): B1, the writer's own
// text always stays in the writer's own email; B2, header lines stay when
// the rebuilt email's header rows cannot show all they say.

const ALICE = { name: 'Alice Example', address: 'alice@example.test' };
const BOB = { name: 'Bob Sample', address: 'bob@example.test' };

/** A synthetic real file. */
function file(n: number, from: { name: string; address: string }, to: { name: string; address: string }, utcMs: number, subject: string, bodyText: string): NormalizedMessage {
  return {
    messageId: `round2-${String(n)}@example.test`,
    inReplyTo: null,
    references: [],
    date: { utcMs, original: new Date(utcMs).toUTCString(), offsetMinutes: 0, zoneKnown: true },
    from: [from],
    to: [to],
    cc: [],
    bcc: [],
    subject,
    bodyText,
    attachments: [],
    source: { fileName: `round2-${String(n)}.eml`, sha256: String(n).padStart(64, '0'), kind: 'eml' },
    warnings: [],
  };
}

describe('B1: an answer typed below an unmarked Outlook quote stays in the writer\'s own email', () => {
  const aliceText = 'Hello Bob,\n\nCould you please confirm the delivery of the twelve oak desks and the matching chairs before the end of next week?\n\nBest regards,\nAlice\n';
  const answer = 'My answer: the desks arrive on Thursday morning at the north entrance.';
  const bobText =
    'Hi Alice,\n\nSee my answer below the quote.\n\nBob\n\n' +
    '________________________________\nFrom: Alice Example <alice@example.test>\nSent: Monday, March 3, 2025 5:15 PM\nTo: Bob Sample <bob@example.test>\nSubject: Desks\n\n' +
    `${aliceText}\n${answer}\n`;
  const result = runEngine([
    { ok: true, message: file(1, ALICE, BOB, Date.UTC(2025, 2, 3, 17, 15), 'Desks', aliceText) },
    { ok: true, message: file(2, BOB, ALICE, Date.UTC(2025, 2, 4, 9, 0), 'RE: Desks', bobText) },
  ]);
  const bobPosition = result.messages.findIndex((m) => m.message.from[0]?.address === BOB.address);
  const alicePosition = result.messages.findIndex((m) => m.message.from[0]?.address === ALICE.address);
  const quoted = 'Could you please confirm the delivery of the twelve oak desks';

  it('the case is rule 2b: the answer is the writer\'s own text, inside the rebuilt email\'s place', () => {
    const plan = planOutput(result.messages, DEFAULT_OUTPUT_POLICY)[bobPosition]!;
    const at = bobText.indexOf(answer);
    expect(plan.ranges.find((r) => r.start <= at && at < r.end)).toMatchObject({ keep: true, reason: 'text' });
    const entries = rebuiltEntries(result);
    expect(entries).toHaveLength(1);
    const r = entries[0]!;
    expect(r.rebuilt.headerEnd <= at && at < r.rebuilt.end).toBe(true);
    expect(r.rebuilt.reconstructedText).toContain(answer);
  });

  it('the rebuilt email ticked: attribution first, that place is not cut at all (header, quote and answer stay together); an allowed repeat', () => {
    const doc = build(result);
    const bob = realOf(doc, bobPosition);
    // Review round 3, finding 1: cutting the quote around the answer while the header lines stay
    // would print Bob's answer right under "From: Alice Example". So the place that holds the
    // answer stays exactly as the plan says, as with the rebuilt email unticked.
    expect(bodyOf(bob)).toBe(bodyOf(realOf(build(result, { rebuilt: [] }), bobPosition)));
    expect(bob.flags.printedElsewhere).toBe(false);
    const text = squash(bodyOf(bob));
    expect(text).toContain(answer);
    expect(text).toContain('See my answer below the quote.');
    expect(text).toContain(quoted);
    // The answer comes after the quoted email's text, never right after its header lines.
    const header = text.indexOf('Subject: Desks');
    expect(header).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(quoted)).toBeGreaterThan(header);
    expect(text.indexOf(answer)).toBeGreaterThan(text.indexOf(quoted));
    // ALLOWED REPEAT: the rebuilt email (and Alice's real file) print it too.
    expect(squash(bodyOf(realOf(doc, alicePosition)))).toContain(quoted);
    const rebuilt = doc.emails.find((e) => e.rebuilt !== null)!;
    expect(squash(bodyOf(rebuilt))).toContain(answer);
  });

  it('printedElsewhere: with the plans, that place covers nothing; without them (no check), it would', () => {
    const order = planPdfOrder(result, result.messages.map((_, k) => k), rebuiltEntries(result).map((r) => r.id));
    const plans = planOutput(result.messages, DEFAULT_OUTPUT_POLICY);
    const byPosition = new Map(plans.map((p, k) => [k, p] as const));
    expect(printedElsewhere(result, order.slots, order.pdfNumberByPosition, byPosition).get(bobPosition)).toBeUndefined();
    expect(printedElsewhere(result, order.slots, order.pdfNumberByPosition).get(bobPosition)?.length).toBeGreaterThan(0);
    // A plan that is not trusted: the body is printed whole anyway, so no check is made with it.
    const fallback = new Map([[bobPosition, { ...plans[bobPosition]!, fallback: true }]]);
    expect(printedElsewhere(result, order.slots, order.pdfNumberByPosition, fallback).get(bobPosition)?.length).toBeGreaterThan(0);
  });

  it('the rebuilt email unticked: the writer\'s email is as its plan says, the quote kept with the answer', () => {
    const doc = build(result, { rebuilt: [] });
    const bob = squash(bodyOf(realOf(doc, bobPosition)));
    expect(bob).toContain(answer);
    expect(bob).toContain(quoted);
  });
});

describe('B2 / Q4: header lines the rebuilt header rows cannot show move to the top of that rebuilt email (task 8.13a)', () => {
  const exactBody = exactDates(buildThread(FORWARD.messages!).body);
  const engineFor = (body: string): EngineResult => runEngine([{ ok: true, message: realFile(FORWARD.messages!, 2, body) }]);
  /** The header lines of the rebuilt message of `generation` in the forward, as written. */
  const headerOf = (result: EngineResult, generation: number): string => {
    const r = result.reconstructed.find((x) => x.rebuilt.generation === generation)!.rebuilt;
    return result.messages[0]!.message.bodyText.slice(r.start, r.headerEnd);
  };
  const keptIn = (doc: PdfDocument, header: string): boolean => squash(bodyOf(realOf(doc, 0))).includes(squash(header));
  /** Whether the rebuilt email of `generation` starts with `header` (moved there, verbatim) and nothing else prints it. */
  const movedTo = (doc: PdfDocument, result: EngineResult, generation: number, header: string): boolean => {
    const id = result.reconstructed.find((x) => x.rebuilt.generation === generation)!.id;
    const e = doc.emails.find((x) => x.rebuilt?.id === id)!;
    const elsewhere = doc.emails.filter((x) => x !== e && squash(bodyOf(x)).includes(squash(header)));
    return squash(bodyOf(e)).startsWith(squash(header)) && elsewhere.length === 0;
  };

  it('dates with a zone and every field shown: both header blocks are left out, and moved nowhere (the rows show them)', () => {
    const result = engineFor(exactBody);
    const doc = build(result);
    for (const g of [1, 2]) {
      expect(keptIn(doc, headerOf(result, g))).toBe(false);
      expect(movedTo(doc, result, g, headerOf(result, g))).toBe(false);
    }
    expect(doc.emails.every((e) => e.rebuilt === null || e.rebuilt.movedHeaders === 0)).toBe(true);
  });

  it('a Bcc line: that header block leaves the forward and is printed, as written, at the top of its rebuilt email; the other one goes; the texts go', () => {
    const body = exactBody.replace(/^(To: Carol Test <carol@sample\.invalid>)$/mu, '$1\nBcc: Dan Hidden <dan@example.test>');
    expect(body).not.toBe(exactBody);
    const result = engineFor(body);
    expect(rebuiltEntries(result)).toHaveLength(2);
    const header = headerOf(result, 1);
    expect(header).toContain('Bcc: Dan Hidden');
    const doc = build(result);
    expect(keptIn(doc, header)).toBe(false);
    expect(movedTo(doc, result, 1, header)).toBe(true);
    expect(keptIn(doc, headerOf(result, 2))).toBe(false);
    expect(movedTo(doc, result, 2, headerOf(result, 2))).toBe(false);
    for (const k of [0, 1]) expect(doc.emails.filter((e) => squash(bodyOf(e)).includes(sentence(FORWARD, k)))).toHaveLength(1);
  });

  it('a From value with two mailboxes ("Unknown sender"): that header block moves to its rebuilt email', () => {
    const body = exactBody.replace('From: Bob Sample <bob@furniture.example.test>', 'From: Bob Sample <bob@furniture.example.test>, Erin Other <erin@example.test>');
    expect(body).not.toBe(exactBody);
    const result = engineFor(body);
    const r = result.reconstructed.find((x) => x.rebuilt.generation === 1)!;
    expect(r.rebuilt.from).toEqual([]);
    const doc = build(result);
    expect(keptIn(doc, headerOf(result, 1))).toBe(false);
    expect(movedTo(doc, result, 1, headerOf(result, 1))).toBe(true);
    expect(keptIn(doc, headerOf(result, 2))).toBe(false);
  });

  it('an estimated date (no zone of its own): both header blocks move to their rebuilt emails, the texts go', () => {
    const result = engineOf(FORWARD, [2]);
    const doc = build(result);
    for (const g of [1, 2]) {
      expect(keptIn(doc, headerOf(result, g))).toBe(false);
      expect(movedTo(doc, result, g, headerOf(result, g))).toBe(true);
    }
    for (const k of [0, 1]) expect(doc.emails.filter((e) => squash(bodyOf(e)).includes(sentence(FORWARD, k)))).toHaveLength(1);
  });

  it('the rebuilt email not in the PDF and not an unticked forward (the switch off): the header lines stay where they are', () => {
    const result = engineOf(FORWARD, [2]);
    const doc = build(result, { rebuilt: [], rebuildingOff: true });
    for (const g of [1, 2]) expect(keptIn(doc, headerOf(result, g))).toBe(true);
  });

  it('headerShownInPdf: each thing the header rows cannot show keeps the lines', () => {
    const result = engineFor(exactBody);
    const body = result.messages[0]!.message.bodyText;
    const r = result.reconstructed.find((x) => x.rebuilt.generation === 1)!.rebuilt;
    const self = (x: typeof r): boolean => headerShownInPdf(body, x, { kind: 'rebuilt', rebuilt: x });
    expect(self(r)).toBe(true);
    expect(self({ ...r, dateApproximate: true })).toBe(false);
    expect(self({ ...r, dateText: null, date: null })).toBe(false); // no date read (an attribution not split)
    expect(self({ ...r, date: null })).toBe(true); // a date that could not be read: printed as written
    expect(self({ ...r, date: { ...r.date!, precision: 'day', wallMs: Date.UTC(2025, 2, 3) } })).toBe(true); // a day alone: printed as written
    expect(self({ ...r, from: [] })).toBe(false);
    expect(self({ ...r, from: [{ name: '', address: 'bob@furniture.example.test' }] })).toBe(false); // no name read
    expect(self({ ...r, incomplete: ['to'] })).toBe(false);
    expect(self({ ...r, subject: null })).toBe(false); // the lines hold a Subject line not read
    // A copy read from another email with a different header: the lines stay.
    expect(headerShownInPdf(body, r, { kind: 'rebuilt', rebuilt: { ...r, subject: 'Other' } })).toBe(false);
    expect(headerShownInPdf(body, r, { kind: 'rebuilt', rebuilt: { ...r } })).toBe(true);
    // A label written twice (only the first value is read).
    const extra = 'To: Carol Test <carol@sample.invalid>\n';
    const twice = body.slice(0, r.headerEnd) + extra + body.slice(r.headerEnd);
    expect(headerShownInPdf(twice, { ...r, headerEnd: r.headerEnd + extra.length }, { kind: 'rebuilt', rebuilt: r })).toBe(false);
  });

  it('headerShownInPdf against a real file: same sender name, subject and recipients, and an exact date', () => {
    const result = engineFor(exactBody);
    const body = result.messages[0]!.message.bodyText;
    const r = result.reconstructed.find((x) => x.rebuilt.generation === 1)!.rebuilt;
    const real = realFile(FORWARD.messages!, 1);
    expect(headerShownInPdf(body, r, { kind: 'real', message: real })).toBe(true);
    expect(headerShownInPdf(body, r, { kind: 'real', message: { ...real, subject: 'Something else' } })).toBe(false);
    expect(headerShownInPdf(body, r, { kind: 'real', message: { ...real, to: [] } })).toBe(false);
    expect(headerShownInPdf(body, r, { kind: 'real', message: { ...real, from: [{ ...real.from[0]!, name: 'B. Sample' }] } })).toBe(false);
    expect(headerShownInPdf(body, { ...r, date: { ...r.date!, precision: 'day', wallMs: Date.UTC(2025, 2, 3) } }, { kind: 'real', message: real })).toBe(false);
  });
});

describe('the cut places: CRLF bodies, touching and overlapping places', () => {
  it('a CRLF body: every cut starts and ends at a line start (after "\\r\\n"); the forward keeps only its own text', () => {
    const body = exactDates(buildThread(FORWARD.messages!).body).replace(/\n/gu, '\r\n');
    const result = runEngine([{ ok: true, message: realFile(FORWARD.messages!, 2, body) }]);
    const entries = rebuiltEntries(result);
    expect(entries).toHaveLength(2);
    const order = planPdfOrder(result, [0], entries.map((r) => r.id));
    const cuts = printedElsewhere(result, order.slots, order.pdfNumberByPosition).get(0)!;
    expect(cuts.length).toBeGreaterThan(0);
    for (const [a, b] of cuts) {
      expect(a === 0 || body.slice(a - 2, a) === '\r\n', `cut at ${String(a)}`).toBe(true);
      expect(b === body.length || body.slice(b - 2, b) === '\r\n', `cut end ${String(b)}`).toBe(true);
    }
    const forward = realOf(build(result), 0);
    expect(squash(bodyOf(forward))).toBe(squash(FORWARD.messages![2]!.text));
    expect(bodyOf(forward)).not.toContain('\r');
  });

  it('a place linked to a real file and a place of a rebuilt entry that touch in one body: one cut', () => {
    const result = runEngine([
      { ok: true, message: realFile(FORWARD.messages!, 1) },
      { ok: true, message: realFile(FORWARD.messages!, 2, exactDates(buildThread(FORWARD.messages!).body)) },
    ]);
    const forwardPosition = result.messages.findIndex((m) => m.message.subject === FORWARD.messages![2]!.subject);
    const inForward = result.reconstructed
      .filter((r) => result.positionByIndex[r.sourceIndex] === forwardPosition)
      .sort((a, b) => a.rebuilt.start - b.rebuilt.start);
    expect(inForward.map((r) => r.link)).toEqual(['real', expect.stringMatching(/^(entry|same-as)$/u)]);
    const newer = inForward[0]!;
    const older = inForward[1]!;
    expect(newer.rebuilt.end).toBe(older.rebuilt.start);
    const order = planPdfOrder(
      result,
      result.messages.map((_, k) => k),
      rebuiltEntries(result).map((r) => r.id),
    );
    expect(printedElsewhere(result, order.slots, order.pdfNumberByPosition).get(forwardPosition)).toEqual([[newer.rebuilt.start, older.rebuilt.end]]);
    const doc = build(result);
    expect(squash(bodyOf(realOf(doc, forwardPosition)))).toBe(squash(FORWARD.messages![2]!.text));
    for (const k of [0, 1, 2]) expect(doc.emails.filter((e) => squash(bodyOf(e)).includes(sentence(FORWARD, k))), `message ${String(k)}`).toHaveLength(1);
  });

  it('overlapping places (odd offsets) are merged into one cut', () => {
    const result = runEngine([{ ok: true, message: realFile(FORWARD.messages!, 2, exactDates(buildThread(FORWARD.messages!).body)) }]);
    const g1 = result.reconstructed.find((r) => r.rebuilt.generation === 1)!.rebuilt;
    const g2 = result.reconstructed.find((r) => r.rebuilt.generation === 2)!.rebuilt;
    const odd: EngineResult = {
      ...result,
      reconstructed: result.reconstructed.map((r) => (r.rebuilt === g2 ? { ...r, rebuilt: { ...g2, start: g1.headerEnd, headerEnd: g1.headerEnd } } : r)),
    };
    const order = planPdfOrder(odd, [0], rebuiltEntries(odd).map((r) => r.id));
    expect(printedElsewhere(odd, order.slots, order.pdfNumberByPosition).get(0)).toEqual([[g1.start, g2.end]]);
  });
});

describe('printedElsewhereParts, pdfRanges, noRepeat: where the PDF prints each part left out (task 8.11, for the preview)', () => {
  const slotNumber = (order: ReturnType<typeof planPdfOrder>, id: number): number => order.slots.find((s) => s.kind === 'rebuilt' && s.entry.id === id)!.number;

  it('each part names the rebuilt email that prints it (its entry and PDF number); merged, the parts are printedElsewhere', () => {
    const result = engineOf(FORWARD, [2]);
    const entries = rebuiltEntries(result);
    const order = planPdfOrder(result, [0], entries.map((r) => r.id));
    const parts = printedElsewhereParts(result, order.slots, order.pdfNumberByPosition).get(0)!;
    // The whole places, header lines included (task 8.13a, Q4: the dates have no zone of their own, so
    // those lines move to the rebuilt emails).
    const expected = entries
      .map((r) => ({ start: r.rebuilt.start, end: r.rebuilt.end, printedAs: { kind: 'rebuilt' as const, id: r.id, number: slotNumber(order, r.id) } }))
      .sort((a, b) => a.start - b.start);
    expect(parts).toEqual(expected);
    // Merged: the two places touch, one interval.
    expect(printedElsewhere(result, order.slots, order.pdfNumberByPosition).get(0)).toEqual([[expected[0]!.start, expected[1]!.end]]);
  });

  it('a part linked to a real file names that file: its list position and PDF number', () => {
    const result = engineOf(FORWARD, [0, 1, 2]);
    const order = planPdfOrder(result, [0, 1, 2]);
    const all = printedElsewhereParts(result, order.slots, order.pdfNumberByPosition);
    const linked = result.reconstructed.filter((r) => r.link === 'real');
    expect(linked.length).toBeGreaterThan(0);
    for (const r of linked) {
      const source = result.positionByIndex[r.sourceIndex]!;
      const real = result.positionByIndex[r.realIndex!]!;
      const part = all.get(source)!.find((p) => p.start <= r.rebuilt.headerEnd && r.rebuilt.end <= p.end)!;
      expect(part.printedAs).toEqual({ kind: 'email', position: real, number: order.pdfNumberByPosition[real] });
    }
  });

  it('touching places of a real file and of a rebuilt entry: two parts (one per email), one cut', () => {
    const result = runEngine([
      { ok: true, message: realFile(FORWARD.messages!, 1) },
      { ok: true, message: realFile(FORWARD.messages!, 2, exactDates(buildThread(FORWARD.messages!).body)) },
    ]);
    const forward = result.messages.findIndex((m) => m.message.subject === FORWARD.messages![2]!.subject);
    const [newer, older] = result.reconstructed.filter((r) => result.positionByIndex[r.sourceIndex] === forward).sort((a, b) => a.rebuilt.start - b.rebuilt.start);
    const order = planPdfOrder(result, result.messages.map((_, k) => k), rebuiltEntries(result).map((r) => r.id));
    const parts = printedElsewhereParts(result, order.slots, order.pdfNumberByPosition).get(forward)!;
    const real = result.positionByIndex[newer!.realIndex!]!;
    const entry = older!.link === 'entry' ? older!.id : older!.sameAs!;
    expect(parts).toEqual([
      { start: newer!.rebuilt.start, end: newer!.rebuilt.end, printedAs: { kind: 'email', position: real, number: order.pdfNumberByPosition[real] } },
      { start: older!.rebuilt.start, end: older!.rebuilt.end, printedAs: { kind: 'rebuilt', id: entry, number: slotNumber(order, entry) } },
    ]);
    expect(printedElsewhere(result, order.slots, order.pdfNumberByPosition).get(forward)).toEqual([[newer!.rebuilt.start, older!.rebuilt.end]]);
  });

  it('overlapping places (odd offsets): each piece goes to the innermost place, nothing covered twice', () => {
    const result = runEngine([{ ok: true, message: realFile(FORWARD.messages!, 2, exactDates(buildThread(FORWARD.messages!).body)) }]);
    const e1 = result.reconstructed.find((r) => r.rebuilt.generation === 1)!;
    const e2 = result.reconstructed.find((r) => r.rebuilt.generation === 2)!;
    const g1 = e1.rebuilt;
    const odd: EngineResult = {
      ...result,
      reconstructed: result.reconstructed.map((r) => (r === e2 ? { ...r, rebuilt: { ...r.rebuilt, start: g1.headerEnd, headerEnd: g1.headerEnd } } : r)),
    };
    const order = planPdfOrder(odd, [0], rebuiltEntries(odd).map((r) => r.id));
    expect(printedElsewhereParts(odd, order.slots, order.pdfNumberByPosition).get(0)).toEqual([
      { start: g1.start, end: g1.headerEnd, printedAs: { kind: 'rebuilt', id: e1.id, number: slotNumber(order, e1.id) } },
      { start: g1.headerEnd, end: e2.rebuilt.end, printedAs: { kind: 'rebuilt', id: e2.id, number: slotNumber(order, e2.id) } },
    ]);
  });

  it('pdfRanges: the plan cut exactly as withoutPrintedElsewhere cuts it, each piece left out naming its email; null when the PDF prints the plan or the whole body', () => {
    const result = engineOf(FORWARD, [2]);
    const order = planPdfOrder(result, [0], rebuiltEntries(result).map((r) => r.id));
    const parts = printedElsewhereParts(result, order.slots, order.pdfNumberByPosition).get(0)!;
    const body = result.messages[0]!.message.bodyText;
    const plan = planOutput(result.messages, DEFAULT_OUTPUT_POLICY)[0]!;
    const ranges = pdfRanges(body, plan, DEFAULT_OUTPUT_POLICY, parts)!;
    expect(ranges).not.toBeNull();
    // The same characters kept as the PDF's own cut.
    const keptBy = (list: readonly PlanRange[]): string => list.map((r) => (r.keep ? body.slice(r.start, r.end) : '\u0000'.repeat(r.end - r.start))).join('');
    expect(keptBy(ranges)).toBe(keptBy(withoutPrintedElsewhere(body, plan.ranges, printedElsewhere(result, order.slots, order.pdfNumberByPosition).get(0)!).ranges));
    // A contiguous cover of the body; a piece names an email only when left out, and then lies inside a part of that email.
    expect(ranges[0]!.start).toBe(0);
    ranges.forEach((r, k) => expect(r.start).toBe(k === 0 ? 0 : ranges[k - 1]!.end));
    expect(ranges.at(-1)!.end).toBe(body.length);
    const named = ranges.filter((r) => r.printedAs !== null);
    expect(named.length).toBeGreaterThan(0);
    for (const r of named) {
      expect(r.keep).toBe(false);
      expect(parts.some((p) => p.start <= r.start && r.end <= p.end && p.printedAs === r.printedAs)).toBe(true);
    }
    // Nothing named for what the plan already left out.
    for (const r of ranges) if (r.printedAs === null && !r.keep) expect(plan.ranges.some((x) => !x.keep && x.start <= r.start && r.end <= x.end)).toBe(true);
    // The whole body printed, or nothing left out this way: null.
    expect(pdfRanges(body, plan, EVERYTHING, parts)).toBeNull();
    expect(pdfRanges(body, plan, DEFAULT_OUTPUT_POLICY, [])).toBeNull();
    expect(pdfRanges(body, { ...plan, fallback: true }, DEFAULT_OUTPUT_POLICY, parts)).toBeNull();
    expect(pdfRanges(body, null, DEFAULT_OUTPUT_POLICY, parts)).toBeNull();
  });

  it('noRepeat is what buildPdfDocument uses: the same order and parts; none and no rebuilt email under "Print full original text"', () => {
    const result = engineOf(FORWARD, [2]);
    const ids = rebuiltEntries(result).map((r) => r.id);
    const plans = planOutput(result.messages, DEFAULT_OUTPUT_POLICY);
    const got = noRepeat({ result, positions: [0], plans, policy: DEFAULT_OUTPUT_POLICY, rebuilt: ids });
    const order = planPdfOrder(result, [0], ids);
    expect(got.order).toEqual(order);
    expect(got.parts).toEqual(printedElsewhereParts(result, order.slots, order.pdfNumberByPosition, new Map([[0, plans[0]]])));
    expect(got.elsewhere).toEqual(printedElsewhere(result, order.slots, order.pdfNumberByPosition, new Map([[0, plans[0]]])));
    const doc = build(result, { positions: [0], plans, rebuilt: ids });
    expect(doc.pdfNumberByPosition).toEqual(order.pdfNumberByPosition);
    const printed = pdfBodyText(result.messages[0]!.message.bodyText, plans[0], DEFAULT_OUTPUT_POLICY, got.elsewhere.get(0));
    expect(bodyOf(realOf(doc, 0))).toBe(bodyLines(printed.text, { notLineStarts: printed.notLineStarts }).lines.map(lineText).join('\n'));
    const everything = noRepeat({ result, positions: [0], plans, policy: EVERYTHING, rebuilt: ids });
    expect(everything.parts.size).toBe(0);
    expect(everything.elsewhere.size).toBe(0);
    expect(everything.order.slots.every((s) => s.kind === 'email')).toBe(true);
  });
});

// Review round 3 of task 8.10: attribution first (finding 1), a kept
// signature like own text (S5), name-only recipients (S3), a strong match
// with a real file (S4), and the deliberate repeat of option A (3a).

describe('attribution first: a place whose text holds own text or a kept signature next to quoted text is not cut at all (finding 1, S5, narrowed by task 8.13a Q3)', () => {
  const body = 'own\nFrom: x\nquoted\nmine\n-- \nSig\n';
  //            0   4        13      20    25   29   33

  it('holdsOwnText: a kept "text", "signature" or "repeated-signature" range with text in the span', () => {
    const ranges = (reason: PlanRange['reason'], keep = true): PlanRange[] => [
      { start: 0, end: 4, keep: true, reason: 'text' },
      { start: 4, end: 20, keep: true, reason: 'forwarded' },
      { start: 20, end: 33, keep, reason },
    ];
    expect(holdsOwnText(body, ranges('text'), 4, 33)).toBe(true);
    expect(holdsOwnText(body, ranges('signature'), 4, 33)).toBe(true);
    expect(holdsOwnText(body, ranges('repeated-signature'), 4, 33)).toBe(true);
    // Left out by the plan, or another reason: no.
    expect(holdsOwnText(body, ranges('signature', false), 4, 33)).toBe(false);
    expect(holdsOwnText(body, ranges('writer-quote'), 4, 33)).toBe(false);
    expect(holdsOwnText(body, ranges('app-quoted-history'), 4, 33)).toBe(false);
    // Only the part inside the span counts, and white space alone does not.
    expect(holdsOwnText(body, ranges('forwarded'), 4, 20)).toBe(false);
    expect(holdsOwnText(body, ranges('forwarded'), 3, 20)).toBe(false); // "\n" of the first range
    expect(holdsOwnText(body, ranges('forwarded'), 2, 20)).toBe(true); // "w\n"
  });

  it('holdsQuotedText: a range the plan marks as a quote, kept or not, with text in the span', () => {
    const ranges = (reason: PlanRange['reason'], keep = true): PlanRange[] => [
      { start: 0, end: 4, keep: true, reason: 'text' },
      { start: 4, end: 20, keep, reason },
      { start: 20, end: 33, keep: true, reason: 'text' },
    ];
    for (const reason of ['writer-quote', 'app-quoted-history', 'forwarded'] as const) {
      expect(holdsQuotedText(body, ranges(reason), 0, 33), reason).toBe(true);
      expect(holdsQuotedText(body, ranges(reason, false), 0, 33), reason).toBe(true);
    }
    expect(holdsQuotedText(body, ranges('signature'), 0, 33)).toBe(false);
    expect(holdsQuotedText(body, ranges('text'), 0, 33)).toBe(false);
    expect(holdsQuotedText(body, ranges('forwarded'), 20, 33)).toBe(false);
  });

  it('withoutPrintedElsewhere: a kept signature inside a part is cut too (task 8.13a: printedElsewhere gives no part for a place that holds the writer\'s answer)', () => {
    const r: PlanRange[] = [
      { start: 0, end: 4, keep: true, reason: 'text' },
      { start: 4, end: 25, keep: true, reason: 'forwarded' },
      { start: 25, end: 33, keep: true, reason: 'signature' },
    ];
    const cut = withoutPrintedElsewhere(body, r, [[4, 33]]);
    expect(cut.ranges).toEqual([r[0], { ...r[1], keep: false }, { ...r[2], keep: false }]);
  });

  /** A forward whose quoted dates carry their zone, a plan for it with `reason` (kept) on `line` of the newer forwarded email's text. */
  function forwardWith(reason: PlanRange['reason'], keep = true) {
    const result = runEngine([{ ok: true, message: realFile(FORWARD.messages!, 2, exactDates(buildThread(FORWARD.messages!).body)) }]);
    const body = result.messages[0]!.message.bodyText;
    const g1 = result.reconstructed.find((r) => r.rebuilt.generation === 1)!.rebuilt;
    const g2 = result.reconstructed.find((r) => r.rebuilt.generation === 2)!.rebuilt;
    const at = body.indexOf(FORWARD.messages![1]!.text.split('\n\n')[1]!.split('\n')[0]!, g1.headerEnd);
    expect(at > g1.headerEnd && at < g1.end).toBe(true);
    const lineEnd = body.indexOf('\n', at) + 1;
    const plan: MessagePlan = {
      ranges: [
        { start: 0, end: g1.start, keep: true, reason: 'text' },
        { start: g1.start, end: at, keep: true, reason: 'forwarded' },
        { start: at, end: lineEnd, keep, reason },
        { start: lineEnd, end: body.length, keep: true, reason: 'forwarded' },
      ],
      tailStart: null,
      omittedSignatures: 0,
      keptAllBecauseEmpty: false,
      fallback: false,
    };
    const order = planPdfOrder(result, [0], rebuiltEntries(result).map((r) => r.id));
    const cut = printedElsewhere(result, order.slots, order.pdfNumberByPosition, new Map([[0, plan]]));
    return { result, plan, g1, g2, cut: cut.get(0) ?? [] };
  }

  it('printedElsewhere: a place whose text holds own text or a kept signature covers nothing; the other place is still cut', () => {
    for (const reason of ['text', 'signature', 'repeated-signature'] as const) {
      const { g1, g2, cut } = forwardWith(reason);
      expect(cut, reason).toEqual([[g2.start, g2.end]]);
      expect(cut.some(([a, b]) => a < g1.end && g1.start < b), reason).toBe(false);
    }
    // A signature the plan leaves out, or a quote: the place is cut, header lines included.
    for (const [reason, keep] of [['signature', false], ['writer-quote', true]] as const) {
      const { g1, g2, cut } = forwardWith(reason, keep);
      expect(cut, reason).toEqual([[g1.start, g2.end]]);
    }
  });

  it('Q3 (task 8.13a): a place whose text is own text only, with no quoted range (the plan could not check any of it), IS cut whole', () => {
    const result = runEngine([{ ok: true, message: realFile(FORWARD.messages!, 2, exactDates(buildThread(FORWARD.messages!).body)) }]);
    const body = result.messages[0]!.message.bodyText;
    const g1 = result.reconstructed.find((r) => r.rebuilt.generation === 1)!.rebuilt;
    const g2 = result.reconstructed.find((r) => r.rebuilt.generation === 2)!.rebuilt;
    // The newer forwarded email's whole place labelled 'text' (as rule 2b labels an unmarked Outlook quote it cannot check).
    const plan: MessagePlan = {
      ranges: [
        { start: 0, end: g1.start, keep: true, reason: 'text' },
        { start: g1.start, end: g1.end, keep: true, reason: 'text' },
        { start: g1.end, end: body.length, keep: true, reason: 'forwarded' },
      ],
      tailStart: null,
      omittedSignatures: 0,
      keptAllBecauseEmpty: false,
      fallback: false,
    };
    const order = planPdfOrder(result, [0], rebuiltEntries(result).map((r) => r.id));
    expect(printedElsewhere(result, order.slots, order.pdfNumberByPosition, new Map([[0, plan]])).get(0)).toEqual([[g1.start, g2.end]]);
    const doc = build(result, { plans: [plan] });
    expect(squash(bodyOf(realOf(doc, 0)))).toBe(squash(FORWARD.messages![2]!.text));
    for (const k of [0, 1]) expect(doc.emails.filter((e) => squash(bodyOf(e)).includes(sentence(FORWARD, k)))).toHaveLength(1);
  });

  it('the whole PDF: that place stays in the forward exactly as its plan says, header lines included', () => {
    const { result, plan, g1 } = forwardWith('text');
    const doc = build(result, { plans: [plan] });
    const forward = bodyOf(realOf(doc, 0));
    const body = result.messages[0]!.message.bodyText;
    expect(squash(forward)).toContain(squash(body.slice(g1.start, g1.end)));
    expect(squash(forward)).not.toContain(sentence(FORWARD, 0));
  });
});

describe('header lines read short: the lines left at the top of the text stay with the header', () => {
  const c = thread('outlook-nl wrapped names only');

  it('headerLinesEnd: after the rest of the wrapped list, the Subject line and the blank line; headerEnd when nothing is left', () => {
    const result = engineOf(c, [1]);
    const body = result.messages[0]!.message.bodyText;
    const r = result.reconstructed[0]!.rebuilt;
    expect(r.incomplete.length).toBeGreaterThan(0);
    const end = headerLinesEnd(body, r);
    expect(end).toBeGreaterThan(r.headerEnd);
    expect(body.slice(r.headerEnd, end)).toMatch(/Onderwerp: .+\n\s*\n$/u);
    expect(body.slice(end).trim().startsWith('Hello Bob,')).toBe(true);
    // A header read whole: its own end.
    const whole = engineOf(FORWARD, [2]);
    for (const x of whole.reconstructed) expect(headerLinesEnd(whole.messages[0]!.message.bodyText, x.rebuilt)).toBe(x.rebuilt.headerEnd);
    // Everything left over: the whole place; odd input: headerEnd.
    expect(headerLinesEnd(body, { ...r, reconstructedText: 'Onderwerp: x\n' })).toBe(r.end);
    expect(headerLinesEnd(body, { ...r, reconstructedText: undefined as unknown as string })).toBe(r.headerEnd);
  });

  it('every email added as a file: the quoted texts and their header lines (and what is left of them) go: the real files show their own headers (task 8.13a, Q4)', () => {
    const result = engineOf(c, [0, 1, 2]);
    const doc = build(result, { rebuilt: [] });
    for (const k of [0, 1, 2]) expect(doc.emails.filter((e) => squash(bodyOf(e)).includes(sentence(c, k))), `message ${String(k)}`).toHaveLength(1);
    expect(result.reconstructed.length).toBeGreaterThan(0);
    for (const r of result.reconstructed) {
      expect(r.link).toBe('real');
      const position = result.positionByIndex[r.sourceIndex]!;
      const body = result.messages[position]!.message.bodyText;
      const lines = squash(body.slice(r.rebuilt.start, headerLinesEnd(body, r.rebuilt)));
      expect(squash(bodyOf(realOf(doc, position)))).not.toContain(lines);
    }
  });

  it('the last email alone, a reply: its plan leaves the quoted history out, so no header line is moved (only lines the body would print move)', () => {
    const result = engineOf(c, [2]);
    const doc = build(result);
    expect(doc.emails.filter((e) => e.rebuilt !== null).length).toBeGreaterThan(0);
    for (const e of doc.emails) if (e.rebuilt !== null) expect(e.rebuilt.movedHeaders).toBe(0);
    expect(noRepeat({ result, positions: [0], plans: planOutput(result.messages, DEFAULT_OUTPUT_POLICY), policy: DEFAULT_OUTPUT_POLICY, rebuilt: rebuiltEntries(result).map((x) => x.id) }).moved.size).toBe(0);
  });
});

describe('header lines against a real file: name-only recipients (S3), a strong match (S4)', () => {
  const exactBody = exactDates(buildThread(FORWARD.messages!).body);

  it('S3: a To / Cc mailbox read without an address matches the file\'s mailbox of the same name', () => {
    const result = runEngine([{ ok: true, message: realFile(FORWARD.messages!, 2, exactBody) }]);
    const body = result.messages[0]!.message.bodyText;
    const r = result.reconstructed.find((x) => x.rebuilt.generation === 1)!.rebuilt;
    const real = realFile(FORWARD.messages!, 1);
    expect(r.to.length).toBeGreaterThan(0);
    const namesOnly = { ...r, to: r.to.map((m) => ({ name: m.name, address: '' })) };
    expect(headerShownInPdf(body, namesOnly, { kind: 'real', message: real })).toBe(true);
    // White space inside the name does not count; another name does.
    const spaced = { ...r, to: r.to.map((m) => ({ name: ` ${m.name.replace(' ', '  ')} `, address: '' })) };
    expect(headerShownInPdf(body, spaced, { kind: 'real', message: real })).toBe(true);
    const other = { ...r, to: [{ name: 'Somebody Else', address: '' }] };
    expect(headerShownInPdf(body, other, { kind: 'real', message: real })).toBe(false);
    // A name-only mailbox of the file matches too.
    const realNames = { ...real, to: real.to.map((m) => ({ name: m.name, address: '' })) };
    expect(headerShownInPdf(body, namesOnly, { kind: 'real', message: realNames })).toBe(true);
    // An address read must still be among the file's addresses.
    expect(headerShownInPdf(body, r, { kind: 'real', message: realNames })).toBe(false);
  });

  it('G3 (task 8.11): a To / Cc mailbox read with a name and an address needs the same name when the file\'s mailbox of that address has one', () => {
    const result = runEngine([{ ok: true, message: realFile(FORWARD.messages!, 2, exactBody) }]);
    const body = result.messages[0]!.message.bodyText;
    const r = result.reconstructed.find((x) => x.rebuilt.generation === 1)!.rebuilt;
    const real = realFile(FORWARD.messages!, 1);
    const read = r.to[0]!;
    expect(read.name).not.toBe('');
    expect(read.address).not.toBe('');
    // The baseline: same name and address, the lines may go.
    expect(headerShownInPdf(body, r, { kind: 'real', message: real })).toBe(true);
    // "Robert <bob@x>" read, the file says "Bob <bob@x>": the row does not show the name written, the lines stay (B2).
    const robert = { ...r, to: [{ name: 'Robert', address: read.address }, ...r.to.slice(1)] };
    const bob = { ...real, to: real.to.map((m) => (m.address.toLowerCase() === read.address.toLowerCase() ? { ...m, name: 'Bob' } : m)) };
    expect(headerShownInPdf(body, robert, { kind: 'real', message: bob })).toBe(false);
    expect(headerShownInPdf(body, r, { kind: 'real', message: bob })).toBe(false);
    // Same normalisation as before: outer and inner white space do not count, letter case does.
    const spaced = { ...r, to: [{ name: ` ${read.name.replace(' ', '   ')} `, address: read.address.toUpperCase() }, ...r.to.slice(1)] };
    expect(headerShownInPdf(body, spaced, { kind: 'real', message: real })).toBe(true);
    const shouted = { ...r, to: [{ name: read.name.toUpperCase(), address: read.address }, ...r.to.slice(1)] };
    expect(headerShownInPdf(body, shouted, { kind: 'real', message: real })).toBe(false);
    // Only one side has a name: the address alone decides, as before.
    const nameless = { ...r, to: [{ name: '', address: read.address }, ...r.to.slice(1)] };
    expect(headerShownInPdf(body, nameless, { kind: 'real', message: real })).toBe(true);
    const fileNameless = { ...real, to: real.to.map((m) => (m.address.toLowerCase() === read.address.toLowerCase() ? { ...m, name: '' } : m)) };
    expect(headerShownInPdf(body, r, { kind: 'real', message: fileNameless })).toBe(true);
  });

  it('S4: an estimated date stops it, unless the link has a strong date match; the other reasons still stop it', () => {
    const result = engineOf(FORWARD, [2]);
    const body = result.messages[0]!.message.bodyText;
    const r = result.reconstructed.find((x) => x.rebuilt.generation === 1)!.rebuilt;
    expect(r.dateApproximate).toBe(true);
    const real = realFile(FORWARD.messages!, 1);
    expect(headerShownInPdf(body, r, { kind: 'real', message: real })).toBe(false);
    expect(headerShownInPdf(body, r, { kind: 'real', message: real, strong: false })).toBe(false);
    expect(headerShownInPdf(body, r, { kind: 'real', message: real, strong: true })).toBe(true);
    // Still not for a rebuilt email printed (its date is an estimate).
    expect(headerShownInPdf(body, r, { kind: 'rebuilt', rebuilt: r })).toBe(false);
    // The other reasons keep the lines.
    expect(headerShownInPdf(body, { ...r, incomplete: ['cc'] }, { kind: 'real', message: real, strong: true })).toBe(false);
    expect(headerShownInPdf(body, { ...r, from: [] }, { kind: 'real', message: real, strong: true })).toBe(false);
    expect(headerShownInPdf(body, r, { kind: 'real', message: { ...real, subject: 'Other' }, strong: true })).toBe(false);
    expect(headerShownInPdf(body, { ...r, date: { ...r.date!, precision: 'day' } }, { kind: 'real', message: real, strong: true })).toBe(false);
    const bccLine = 'Bcc: Dan Hidden <dan@example.test>\n';
    const bcc = body.slice(0, r.headerEnd) + bccLine + body.slice(r.headerEnd);
    expect(headerShownInPdf(bcc, { ...r, headerEnd: r.headerEnd + bccLine.length },{ kind: 'real', message: { ...real, bcc: [{ name: 'Dan Hidden', address: 'dan@example.test' }] }, strong: true })).toBe(false);
    // A sender read with no name: the file's From shows the same address.
    const nameless = { ...r, from: [{ name: '', address: real.from[0]!.address }] };
    expect(headerShownInPdf(body, nameless, { kind: 'real', message: real, strong: true })).toBe(true);
    expect(headerShownInPdf(body, { ...nameless, from: [{ name: '', address: 'other@example.test' }] }, { kind: 'real', message: real, strong: true })).toBe(false);
    expect(headerShownInPdf(body, nameless, { kind: 'rebuilt', rebuilt: nameless })).toBe(false);
  });

  it('S4, the whole PDF: every email added: the quoted header lines leave the forward, the real file shows its own header (task 8.13a, Q4: whether or not its rows show all they say)', () => {
    const result = engineOf(FORWARD, [0, 1, 2]);
    const forward = result.messages.findIndex((m) => m.message.subject === FORWARD.messages![2]!.subject);
    const linked = result.reconstructed.filter((r) => r.link === 'real' && result.positionByIndex[r.sourceIndex] === forward);
    expect(linked.length).toBeGreaterThan(0);
    const order = planPdfOrder(result, result.messages.map((_, k) => k), []);
    const plans = planOutput(result.messages, DEFAULT_OUTPUT_POLICY);
    const cut = printedElsewhere(result, order.slots, order.pdfNumberByPosition, new Map(plans.map((p, k) => [k, p] as const))).get(forward)!;
    const body = result.messages[forward]!.message.bodyText;
    let strong = 0;
    const doc = build(result, { rebuilt: [] });
    for (const r of linked) {
      expect(r.rebuilt.dateApproximate).toBe(true);
      const real = result.messages[result.positionByIndex[r.realIndex!]!]!.message;
      const shown = headerShownInPdf(body, r.rebuilt, { kind: 'real', message: real, strong: r.match!.strong && !r.match!.ambiguousDate });
      if (r.match!.strong && shown) strong++;
      // The whole place is cut, header lines included, and they are printed nowhere (the real file's rows are its header).
      expect(cut.some(([a, b]) => a <= r.rebuilt.start && r.rebuilt.end <= b)).toBe(true);
      const lines = squash(body.slice(r.rebuilt.start, r.rebuilt.headerEnd));
      expect(doc.emails.filter((e) => squash(bodyOf(e)).includes(lines))).toHaveLength(0);
    }
    expect(strong).toBeGreaterThan(0);
  });
});

describe('Q3, option B (user decision 2026-11-09, task 8.13a, replaces 3a option A): the first and the last Outlook files only', () => {
  for (const id of ['outlook-en x3', 'outlook-fr x3', 'outlook-nl x3', 'outlook-en 7 generations']) {
    it(`${id}: each middle email the plan cannot check is printed once, as its rebuilt email, with its header lines on top; cut from the last email`, () => {
      const c = thread(id);
      const last = c.messages!.length - 1;
      const result = engineOf(c, [0, last]);
      const lastPosition = result.messages.findIndex((m) => m.message.subject === c.messages![last]!.subject && m.message.from[0]?.address === c.messages![last]!.from.address);
      const plans = planOutput(result.messages, DEFAULT_OUTPUT_POLICY);
      const body = result.messages[lastPosition]!.message.bodyText;
      const doc = build(result);
      const lastEmail = realOf(doc, lastPosition);
      // The case: the middle texts are 'text' for the plan (it cannot check them), with no quoted range in their place.
      const middles = result.reconstructed.filter((r) => result.positionByIndex[r.sourceIndex] === lastPosition && r.link === 'entry');
      expect(middles.length).toBe(last - 1);
      for (const r of middles) {
        expect(holdsOwnText(body, plans[lastPosition]!.ranges, r.rebuilt.headerEnd, r.rebuilt.end)).toBe(true);
        const e = doc.emails.find((x) => x.rebuilt?.id === r.id)!;
        // Its header lines (an Outlook "Sent:" line has no zone) are printed, as written, at the top of the rebuilt email only.
        const lines = squash(bodyLines(body.slice(r.rebuilt.start, r.rebuilt.headerEnd)).lines.map(lineText).join('\n'));
        expect(squash(bodyOf(e)).startsWith(lines)).toBe(true);
        expect(squash(bodyOf(lastEmail))).not.toContain(lines);
      }
      for (let k = 1; k < last; k++) {
        const holding = doc.emails.filter((e) => squash(bodyOf(e)).includes(sentence(c, k)));
        expect(holding, `message ${String(k)}`).toHaveLength(1);
        expect(holding[0]!.rebuilt, `message ${String(k)}`).not.toBeNull();
      }
      // The first email, a real file, is printed once; the last one keeps its own text.
      expect(doc.emails.filter((e) => squash(bodyOf(e)).includes(sentence(c, 0)))).toHaveLength(1);
      expect(squash(bodyOf(lastEmail))).toContain(sentence(c, last));
      // The rebuilt emails unticked (not forwarded parts): the middle emails stay in the last email, nothing is lost.
      const none = build(result, { rebuilt: [] });
      for (let k = 1; k < last; k++) expect(squash(bodyOf(realOf(none, lastPosition)))).toContain(sentence(c, k));
      // "Print full original text": the last email whole.
      const full = build(result, { policy: EVERYTHING });
      for (let k = 0; k <= last; k++) expect(squash(bodyOf(realOf(full, lastPosition)))).toContain(sentence(c, k));
    });
  }
});

describe('Q2 (user decision 2026-11-09, task 8.13a): a forwarded email unticked is left out; one the tool refused to rebuild stays', () => {
  // A forward whose forwarded header gives no sender mailbox and no readable date: reconstruct.ts refuses it (R1).
  const refusedBody =
    'Hi Carol,\n\nSee the invoice note below.\n\nAlice\n\n---------- Forwarded message ---------\nFrom: the accounting team\nDate: sometime in March\nSubject: Desk invoice\n\nThe invoice for the twelve oak desks is attached.\n';
  const refusedText = 'The invoice for the twelve oak desks is attached.';
  const refused = file(41, ALICE, BOB, Date.UTC(2025, 2, 5, 9, 0), 'Fwd: Desk invoice', refusedBody);
  const forward = realFile(FORWARD.messages!, 2);

  it('the cases: the refused forward has a forwarded part and no rebuilt email; the other one has two', () => {
    const result = runEngine([{ ok: true, message: refused }]);
    expect(result.reconstructed).toEqual([]);
    const plan = planOutput(result.messages, DEFAULT_OUTPUT_POLICY)[0]!;
    expect(plan.ranges.some((r) => r.reason === 'forwarded' && r.keep)).toBe(true);
    expect(rebuiltEntries(engineOf(FORWARD, [2]))).toHaveLength(2);
  });

  it('both rebuilt emails unticked: the rebuildable forwarded emails are left out, the refused one stays inline; full text and the preview keep everything', () => {
    const result = runEngine([
      { ok: true, message: refused },
      { ok: true, message: forward },
    ]);
    const positions = result.messages.map((_, k) => k);
    const refusedAt = result.messages.findIndex((m) => m.message.subject === 'Fwd: Desk invoice');
    const forwardAt = result.messages.findIndex((m) => m.message.subject === forward.subject);
    const ids = rebuiltEntries(result).map((r) => r.id);
    const doc = build(result, { rebuilt: [], unticked: ids });
    expect(squash(bodyOf(realOf(doc, refusedAt)))).toContain(refusedText);
    expect(squash(bodyOf(realOf(doc, refusedAt)))).toContain('From: the accounting team');
    expect(squash(bodyOf(realOf(doc, forwardAt)))).toBe(squash(FORWARD.messages![2]!.text));
    for (const k of [0, 1]) expect(doc.emails.some((e) => squash(bodyOf(e)).includes(sentence(FORWARD, k)))).toBe(false);
    // The preview's labels: the left-out parts name no PDF email ('unticked'); the refused forward has no cut.
    const plans = planOutput(result.messages, DEFAULT_OUTPUT_POLICY);
    const { parts } = noRepeat({ result, positions, plans, policy: DEFAULT_OUTPUT_POLICY, rebuilt: [], unticked: ids });
    expect(parts.get(refusedAt)).toBeUndefined();
    expect(parts.get(forwardAt)!.map((p) => p.printedAs)).toEqual(
      result.reconstructed
        .filter((r) => result.positionByIndex[r.sourceIndex] === forwardAt)
        .sort((a, b) => a.rebuilt.start - b.rebuilt.start)
        .map((r) => ({ kind: 'unticked', id: r.id })),
    );
    expect(ids).toHaveLength(2);
    // Collapse, never delete: "Print full original text" prints both forwards whole.
    const full = build(result, { policy: EVERYTHING });
    expect(squash(bodyOf(realOf(full, refusedAt)))).toContain(refusedText);
    for (const k of [0, 1, 2]) expect(squash(bodyOf(realOf(full, forwardAt)))).toContain(sentence(FORWARD, k));
    // The switch off: nothing is unticked, both forwards as their plans say.
    const off = build(result, { rebuilt: [], unticked: ids, rebuildingOff: true });
    for (const k of [0, 1]) expect(squash(bodyOf(realOf(off, forwardAt)))).toContain(sentence(FORWARD, k));
    expect(squash(bodyOf(realOf(off, refusedAt)))).toContain(refusedText);
  });

  it('a refused quote NESTED inside an unticked forwarded email is left out with it (it is part of that email\'s place); full text keeps it', () => {
    // A forwarded email (rebuildable: a sender and a readable date) that itself quotes a part the tool does not
    // rebuild (no sender mailbox, no readable date). (A refused FORWARD header there makes the tool refuse the
    // outer email too: then nothing is rebuilt and everything stays inline, as in the test above.)
    const nestedBody =
      'Hi Carol,\n\nSee the notes below.\n\nAlice\n\n---------- Forwarded message ---------\nFrom: Bob Sample <bob@example.test>\nDate: Tue, 4 Mar 2025 09:00:00 +0000\nSubject: Fwd: Desk invoice\nTo: Alice Example <alice@example.test>\n\n' +
      'Alice, the accounting team sent this note about the twelve oak desks.\n\n' +
      '> From: the accounting team\n> Date: sometime in March\n> Subject: Desk invoice\n>\n> The invoice for the twelve oak desks is attached.\n';
    const result = runEngine([{ ok: true, message: file(42, ALICE, BOB, Date.UTC(2025, 2, 5, 9, 0), 'Fwd: Fwd: Desk invoice', nestedBody) }]);
    const ids = rebuiltEntries(result).map((r) => r.id);
    expect(ids).toHaveLength(1);
    const place = result.reconstructed[ids[0]!]!.rebuilt;
    // The case: the refused part lies inside the rebuilt email's place (its text runs on to the end).
    expect(nestedBody.slice(place.headerEnd, place.end)).toContain(refusedText);
    const doc = build(result, { rebuilt: [], unticked: ids });
    const forward = squash(bodyOf(realOf(doc, 0)));
    expect(forward).toContain('See the notes below.');
    expect(forward).not.toContain('the accounting team sent this note');
    expect(forward).not.toContain(refusedText);
    // Ticked: printed once, in its rebuilt email, refused part included.
    const ticked = build(result);
    expect(ticked.emails.filter((e) => squash(bodyOf(e)).includes(refusedText)).map((e) => e.rebuilt?.id)).toEqual([ids[0]]);
    // Not unticked (only missing from the chosen ones), and "Print full original text": the forward keeps it.
    expect(squash(bodyOf(realOf(build(result, { rebuilt: [] }), 0)))).toContain(refusedText);
    expect(squash(bodyOf(realOf(build(result, { policy: EVERYTHING }), 0)))).toContain(refusedText);
  });

  it('nothing is left out for an unticked email when its forward is not in the PDF, or the forward\'s plan is not trusted (printed whole)', () => {
    const result = engineOf(FORWARD, [2]);
    const ids = rebuiltEntries(result).map((r) => r.id);
    // The forward left out of the PDF: nothing cut anywhere (no email in the PDF holds it).
    expect(noRepeat({ result, positions: [], plans: [], policy: DEFAULT_OUTPUT_POLICY, rebuilt: ids }).parts.size).toBe(0);
    // Untrusted plan: the forward is printed whole, nothing marked as left out for an unticked email.
    const plans = planOutput(result.messages, DEFAULT_OUTPUT_POLICY).map((p) => ({ ...p, fallback: true }));
    expect(noRepeat({ result, positions: [0], plans, policy: DEFAULT_OUTPUT_POLICY, rebuilt: [] }).parts.size).toBe(0);
  });
});

describe('a copy that ends with a signature block the printed copy lacks (task 8.13a review round 2, rules 1c / 2 of rebuild-links.ts)', () => {
  const CAROL = { name: 'Carol Test', address: 'carol@example.test' };
  const DAVE = { name: 'Dave Sample', address: 'dave@example.test' };
  const aliceText = 'Hello Bob,\n\nCould you please confirm the delivery of the twelve oak desks and the matching chairs before the end of next week?\n\nBest regards,\nAlice\n';
  const aliceQuote =
    '\n________________________________\nFrom: Alice Example <alice@example.test>\nSent: Monday, March 3, 2025 5:15 PM\nTo: Bob Sample <bob@example.test>\nSubject: Desks\n\n' + aliceText;
  const bobText = 'Hello Alice,\n\nThe twelve oak desks and the matching chairs leave our warehouse on Wednesday morning and reach the north entrance before noon.\n\n';
  const signature = 'Bob Sample\nPhone +32 2 555 01 23\n';
  /** Bob's answer to Alice (never added as a file), quoted Outlook style with Alice's email below it. */
  const bobQuote = (withSignature: boolean, sent: string): string =>
    `________________________________\nFrom: Bob Sample <bob@example.test>\nSent: ${sent}\nTo: Alice Example <alice@example.test>\nSubject: RE: Desks\n\n` +
    bobText +
    (withSignature ? signature : '') +
    aliceQuote;
  // Carol's copy ends with Bob's signature block; Dave's has none but an exact date (more known fields: the best copy, the entry).
  const carolBody = `Hi Alice,\n\nThe chairs suit us too.\n\nCarol\n\n${bobQuote(true, 'Tuesday, March 4, 2025 9:00 AM')}`;
  const daveBody = `Hi Alice,\n\nThe desks suit us.\n\nDave\n\n${bobQuote(false, 'Tue, 4 Mar 2025 09:00:00 +0000')}`;
  const result = runEngine([
    { ok: true, message: file(50, ALICE, BOB, Date.UTC(2025, 2, 3, 17, 15), 'Desks', aliceText) },
    { ok: true, message: file(51, CAROL, ALICE, Date.UTC(2025, 2, 5, 9, 0), 'RE: Desks', carolBody) },
    { ok: true, message: file(52, DAVE, ALICE, Date.UTC(2025, 2, 5, 11, 0), 'RE: Desks', daveBody) },
  ]);
  const carolAt = result.messages.findIndex((m) => m.message.from[0]?.address === CAROL.address);
  const daveAt = result.messages.findIndex((m) => m.message.from[0]?.address === DAVE.address);
  const positions = result.messages.map((_, k) => k);
  const plans = planOutput(result.messages, DEFAULT_OUTPUT_POLICY);
  const bobCopies = result.reconstructed.filter((r) => r.rebuilt.from[0]?.address === BOB.address);
  const carolCopy = bobCopies.find((r) => result.positionByIndex[r.sourceIndex] === carolAt)!;
  const ids = rebuiltEntries(result).map((r) => r.id);

  it('the case: two copies of Bob\'s email, Dave\'s the entry and Carol\'s (with the block) a "same-as" copy; Carol\'s place is own text only for the plan (Q3: cut)', () => {
    expect(bobCopies).toHaveLength(2);
    expect(bobCopies.find((r) => result.positionByIndex[r.sourceIndex] === daveAt)!.link).toBe('entry');
    expect(carolCopy.link).toBe('same-as');
    expect(carolCopy.rebuilt.reconstructedText).toContain(signature);
    const body = result.messages[carolAt]!.message.bodyText;
    const linesEnd = headerLinesEnd(body, carolCopy.rebuilt);
    expect(holdsOwnText(body, plans[carolAt]!.ranges, linesEnd, carolCopy.rebuilt.end)).toBe(true);
    expect(holdsQuotedText(body, plans[carolAt]!.ranges, linesEnd, carolCopy.rebuilt.end)).toBe(false);
    // The rebuilt email prints Dave's copy: no block.
    const rebuilt = build(result).emails.find((e) => e.rebuilt?.id === carolCopy.sameAs)!;
    expect(squash(bodyOf(rebuilt))).toContain(squash(bobText));
    expect(squash(bodyOf(rebuilt))).not.toContain('555 01 23');
  });

  it('nothing is lost: the block stays inline in Carol\'s email (it was printed nowhere before this fix); the shared words are printed once, as the rebuilt email', () => {
    const doc = build(result);
    const holding = doc.emails.filter((e) => squash(bodyOf(e)).includes('Phone +32 2 555 01 23'));
    expect(holding).toHaveLength(1);
    expect(holding[0]!.position).toBe(carolAt);
    expect(doc.emails.filter((e) => squash(bodyOf(e)).includes(squash(bobText)))).toHaveLength(1);
    const carol = squash(bodyOf(realOf(doc, carolAt)));
    expect(carol).toContain('The chairs suit us too.');
    expect(carol).not.toContain(squash(bobText));
    expect(carol).not.toContain('From: Bob Sample');
    // The preview reads the same parts: the cut part ends where the block starts; the block is in no part.
    const body = result.messages[carolAt]!.message.bodyText;
    const tail = body.indexOf(signature);
    const parts = noRepeat({ result, positions, plans, policy: DEFAULT_OUTPUT_POLICY, rebuilt: ids }).parts.get(carolAt)!;
    const own = parts.find((p) => p.start === carolCopy.rebuilt.start)!;
    expect(own).toEqual({ start: carolCopy.rebuilt.start, end: tail, printedAs: { kind: 'rebuilt', id: carolCopy.sameAs, number: expect.any(Number) as number } });
    for (const p of parts) expect(p.end <= tail || p.start >= tail + signature.length).toBe(true);
    // "Print full original text" prints Carol's email whole anyway.
    expect(squash(bodyOf(realOf(build(result, { policy: EVERYTHING }), carolAt)))).toContain(squash(bobText + signature));
  });

  it('the other way round (the copy printed has the block, the one cut has none): the whole place is cut, as before', () => {
    // Carol's copy (the block) with the exact date: the entry; Dave's, without the block, is the copy cut.
    const swapped = runEngine([
      { ok: true, message: file(50, ALICE, BOB, Date.UTC(2025, 2, 3, 17, 15), 'Desks', aliceText) },
      { ok: true, message: file(51, CAROL, ALICE, Date.UTC(2025, 2, 5, 9, 0), 'RE: Desks', `Hi Alice,\n\nThe chairs suit us too.\n\nCarol\n\n${bobQuote(false, 'Tuesday, March 4, 2025 9:00 AM')}`) },
      { ok: true, message: file(52, DAVE, ALICE, Date.UTC(2025, 2, 5, 11, 0), 'RE: Desks', `Hi Alice,\n\nThe desks suit us.\n\nDave\n\n${bobQuote(true, 'Tue, 4 Mar 2025 09:00:00 +0000')}`) },
    ]);
    const at = swapped.messages.findIndex((m) => m.message.from[0]?.address === CAROL.address);
    const copy = swapped.reconstructed.find((r) => r.rebuilt.from[0]?.address === BOB.address && swapped.positionByIndex[r.sourceIndex] === at)!;
    expect(copy.link).toBe('same-as');
    const swappedPlans = planOutput(swapped.messages, DEFAULT_OUTPUT_POLICY);
    const parts = noRepeat({ result: swapped, positions: swapped.messages.map((_, k) => k), plans: swappedPlans, policy: DEFAULT_OUTPUT_POLICY, rebuilt: rebuiltEntries(swapped).map((r) => r.id) }).parts.get(at)!;
    expect(parts.find((p) => p.start === copy.rebuilt.start)?.end).toBe(copy.rebuilt.end);
    // The rebuilt email prints the block (Dave's own email may keep its copy too, as its plan says).
    const doc = build(swapped);
    expect(squash(bodyOf(doc.emails.find((e) => e.rebuilt?.id === copy.sameAs)!))).toContain('Phone +32 2 555 01 23');
  });

  it('the real-link variant: Bob\'s own file (no block) is in the PDF; Carol\'s forwarded copy (with the block) is cut up to the block, which stays inline once', () => {
    // Bob's reply added as a real file: its body has his text, no signature block, then Alice's email quoted.
    // Carol forwards it with the block (a forward: the plan marks the place 'forwarded', no own text, so it is cut;
    // an Outlook-style reply quoting it would hold the block as own text next to the quote and be kept whole (Q3);
    // a `>`-quoted reply reaches extraTail, but its block stays in the plan's folded quote).
    const bobBody = bobText + aliceQuote;
    const fwd = `Dave, see below.\n\n---------- Forwarded message ---------\nFrom: Bob Sample <bob@example.test>\nDate: Tue, 4 Mar 2025 at 09:00\nSubject: RE: Desks\nTo: Alice Example <alice@example.test>\n\n${bobText}${signature}${aliceQuote}`;
    const real = runEngine([
      { ok: true, message: file(50, ALICE, BOB, Date.UTC(2025, 2, 3, 17, 15), 'Desks', aliceText) },
      { ok: true, message: file(53, BOB, ALICE, Date.UTC(2025, 2, 4, 9, 0), 'RE: Desks', bobBody) },
      { ok: true, message: file(51, CAROL, DAVE, Date.UTC(2025, 2, 5, 9, 0), 'Fwd: RE: Desks', fwd) },
    ]);
    const at = real.messages.findIndex((m) => m.message.from[0]?.address === CAROL.address);
    const bobAt = real.messages.findIndex((m) => m.message.from[0]?.address === BOB.address);
    const copy = real.reconstructed.find((r) => r.rebuilt.from[0]?.address === BOB.address && real.positionByIndex[r.sourceIndex] === at)!;
    expect(copy.link).toBe('real');
    expect(real.positionByIndex[copy.realIndex!]).toBe(bobAt);
    const realPlans = planOutput(real.messages, DEFAULT_OUTPUT_POLICY);
    const body = real.messages[at]!.message.bodyText;
    const tail = body.indexOf(signature);
    const parts = noRepeat({ result: real, positions: real.messages.map((_, k) => k), plans: realPlans, policy: DEFAULT_OUTPUT_POLICY, rebuilt: rebuiltEntries(real).map((r) => r.id) }).parts.get(at)!;
    const own = parts.find((p) => p.start === copy.rebuilt.start)!;
    expect(own).toEqual({ start: copy.rebuilt.start, end: tail, printedAs: { kind: 'email', position: bobAt, number: expect.any(Number) as number } });
    for (const p of parts) expect(p.end <= tail || p.start >= tail + signature.length).toBe(true);
    // The PDF: the block once, in Carol's email; Bob's words once, in his own file.
    const doc = build(real);
    const holding = doc.emails.filter((e) => squash(bodyOf(e)).includes('Phone +32 2 555 01 23'));
    expect(holding.map((e) => e.position)).toEqual([at]);
    expect(doc.emails.filter((e) => squash(bodyOf(e)).includes(squash(bobText)))).toHaveLength(1);
    expect(squash(bodyOf(realOf(doc, bobAt)))).toContain(squash(bobText));
  });

  it('a CRLF body: the block\'s line is still found exactly, the block printed exactly once', () => {
    const crlf = (s: string): string => s.replaceAll('\n', '\r\n');
    const r2 = runEngine([
      { ok: true, message: file(50, ALICE, BOB, Date.UTC(2025, 2, 3, 17, 15), 'Desks', crlf(aliceText)) },
      { ok: true, message: file(51, CAROL, ALICE, Date.UTC(2025, 2, 5, 9, 0), 'RE: Desks', crlf(carolBody)) },
      { ok: true, message: file(52, DAVE, ALICE, Date.UTC(2025, 2, 5, 11, 0), 'RE: Desks', crlf(daveBody)) },
    ]);
    const at = r2.messages.findIndex((m) => m.message.from[0]?.address === CAROL.address);
    const copy = r2.reconstructed.find((r) => r.rebuilt.from[0]?.address === BOB.address && r2.positionByIndex[r.sourceIndex] === at)!;
    expect(copy.link).toBe('same-as');
    const body = r2.messages[at]!.message.bodyText;
    // The block's first line starts right after a CRLF: the part ends exactly there.
    const tail = body.indexOf(crlf(signature));
    expect(tail).toBeGreaterThan(0);
    expect(body.slice(tail - 2, tail)).toBe('\r\n');
    const parts = noRepeat({ result: r2, positions: r2.messages.map((_, k) => k), plans: planOutput(r2.messages, DEFAULT_OUTPUT_POLICY), policy: DEFAULT_OUTPUT_POLICY, rebuilt: rebuiltEntries(r2).map((r) => r.id) }).parts.get(at)!;
    expect(parts.find((p) => p.start === copy.rebuilt.start)?.end).toBe(tail);
    const doc = build(r2);
    expect(doc.emails.filter((e) => squash(bodyOf(e)).includes('Phone +32 2 555 01 23')).map((e) => e.position)).toEqual([at]);
    expect(doc.emails.filter((e) => squash(bodyOf(e)).includes(squash(bobText)))).toHaveLength(1);
  });

  it('when unsure where the block starts (its line is not inside the place), the whole place is kept, block included', () => {
    const body = result.messages[carolAt]!.message.bodyText;
    // The helper: the real case gives the block's offset; more text lines than the place has gives 'unsure'.
    expect(extraTail(body, carolCopy.rebuilt, bobText)).toBe(body.indexOf(signature));
    const longer = { ...carolCopy.rebuilt, reconstructedText: '\n'.repeat(500) + carolCopy.rebuilt.reconstructedText };
    expect(extraTail(body, longer, bobText)).toBe('unsure');
    // Not strings (malformed): unsure too.
    expect(extraTail(body, { ...carolCopy.rebuilt, reconstructedText: undefined as unknown as string }, bobText)).toBe('unsure');
    // No block, or the printed text has it all: null (cut the whole place).
    expect(extraTail(body, carolCopy.rebuilt, bobText + signature)).toBeNull();
    // Through noRepeat: the same malformed copy keeps Carol's place whole (no part starts there), nothing lost.
    const odd: EngineResult = { ...result, reconstructed: result.reconstructed.map((r) => (r.id === carolCopy.id ? { ...r, rebuilt: longer } : r)) };
    const parts = noRepeat({ result: odd, positions, plans, policy: DEFAULT_OUTPUT_POLICY, rebuilt: ids }).parts.get(carolAt) ?? [];
    expect(parts.some((p) => p.start < carolCopy.rebuilt.end && p.end > carolCopy.rebuilt.start)).toBe(false);
  });
});
