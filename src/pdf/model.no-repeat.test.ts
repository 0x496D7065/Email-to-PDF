// Unit tests for the no-repeat rule of the PDF document model (user
// decision 2026-11-06, task 8.10; src/pdf/model.ts: printedElsewhere,
// headerShownInPdf, withoutPrintedElsewhere, buildPdfDocument): when "Print
// full original text" is off, a part of an email's text that the PDF
// prints as an email of its own is left out of that email's text, except
// the writer's own text and kept signatures (B1, S5: a place that holds
// them is not cut at all, review round 3) and header lines the printed
// header cannot show (B2, S3, S4); a rebuilt email that is not in the PDF
// leaves its text where the plan puts it; with "Print full original text"
// everything is printed as written. The deliberate repeat of option A (3a)
// is checked as intended behaviour.
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
  headerLinesEnd,
  headerShownInPdf,
  holdsOwnText,
  pdfBodyText,
  planPdfOrder,
  printedElsewhere,
  withoutPrintedElsewhere,
  type BodyIntervals,
  type PdfDocument,
  type PdfEmail,
} from './model';
import { createPdfStrings } from './strings';
import { lineText } from './text';

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

function build(result: EngineResult, options: { positions?: readonly number[]; rebuilt?: readonly number[]; policy?: OutputPolicy; plans?: MessagePlan[] } = {}): PdfDocument {
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
  it('covers the text of each chosen rebuilt email; its header lines stay when its date is only estimated (B2); nothing for one not chosen', () => {
    const result = engineOf(FORWARD, [2]);
    const entries = rebuiltEntries(result);
    expect(entries).toHaveLength(2);
    // The quoted dates of this conversation have no zone of their own ("Mon, Mar 3, 2025 at 6:52 PM").
    expect(entries.every((r) => r.rebuilt.dateApproximate)).toBe(true);
    const order = planPdfOrder(result, [0], entries.map((r) => r.id));
    const all = printedElsewhere(result, order.slots, order.pdfNumberByPosition);
    const places = entries.map((r) => [r.rebuilt.headerEnd, r.rebuilt.end] as const).sort((a, b) => a[0] - b[0]);
    // The texts only: the header lines between them stay, so two intervals.
    expect(all.get(0)).toEqual(places);
    // Only the newer one chosen: only its text.
    const newer = entries.find((r) => r.rebuilt.generation === 1)!;
    const one = planPdfOrder(result, [0], [newer.id]);
    expect(printedElsewhere(result, one.slots, one.pdfNumberByPosition).get(0)).toEqual([[newer.rebuilt.headerEnd, newer.rebuilt.end]]);
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

  it('leaves out the kept pieces inside the parts, cut at their bounds; the writer\'s own text ("text") always stays (B1)', () => {
    const cut = withoutPrintedElsewhere(body, ranges, [[9, 33]]);
    expect(cut.leftOut).toBe(true);
    expect(cut.ranges).toEqual([
      { start: 0, end: 9, keep: true, reason: 'text' },
      { start: 9, end: 24, keep: false, reason: 'forwarded' },
      { start: 24, end: 33, keep: true, reason: 'text' },
    ]);
    // Even a part covering the whole body leaves every 'text' range whole.
    expect(withoutPrintedElsewhere(body, ranges, [[0, 33]]).ranges.filter((r) => r.reason === 'text')).toEqual([ranges[0], ranges[2]]);
  });

  it('a "text" range loses only its white space inside a part', () => {
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
    // A part that holds text of a 'text' range: that range stays whole.
    expect(withoutPrintedElsewhere(spaced, r, [[2, 14]]).ranges[0]).toEqual(r[0]);
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
    // ALLOWED REPEAT (B2): the quoted dates have no zone ("Mon, Mar 3, 2025 at 6:52 PM"), so the
    // rebuilt emails print an estimate; the original header lines stay in the forward, as written.
    const body = result.messages[0]!.message.bodyText;
    const headerLines = rebuiltEntries(result)
      .map((r) => r.rebuilt)
      .sort((a, b) => a.start - b.start)
      .map((r) => body.slice(r.start, r.headerEnd));
    expect(squash(bodyOf(forward))).toBe(squash([FORWARD.messages![2]!.text, ...headerLines].join('\n')));
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

  it('the switch off, or a rebuilt email unticked: its text stays in the forward, as the plan says', () => {
    const result = engineOf(FORWARD, [2]);
    const off = build(result, { rebuilt: [] });
    const plain = bodyOf(realOf(off, 0));
    expect(realOf(off, 0).flags.printedElsewhere).toBe(false);
    for (const k of [0, 1]) expect(squash(plain)).toContain(sentence(FORWARD, k));
    // Only the older one chosen: the newer one stays in the forward, the older one leaves it.
    const older = rebuiltEntries(result).find((r) => r.rebuilt.generation === 2)!;
    const doc = build(result, { rebuilt: [older.id] });
    const forward = squash(bodyOf(realOf(doc, 0)));
    expect(forward).toContain(sentence(FORWARD, 1));
    expect(forward).not.toContain(sentence(FORWARD, 0));
    expect(doc.emails.filter((e) => squash(bodyOf(e)).includes(sentence(FORWARD, 0)))).toHaveLength(1);
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

describe('B2: header lines stay when the rebuilt header rows cannot show all they say', () => {
  const exactBody = exactDates(buildThread(FORWARD.messages!).body);
  const engineFor = (body: string): EngineResult => runEngine([{ ok: true, message: realFile(FORWARD.messages!, 2, body) }]);
  /** The header lines of the rebuilt message of `generation` in the forward, as written. */
  const headerOf = (result: EngineResult, generation: number): string => {
    const r = result.reconstructed.find((x) => x.rebuilt.generation === generation)!.rebuilt;
    return result.messages[0]!.message.bodyText.slice(r.start, r.headerEnd);
  };
  const keptIn = (doc: PdfDocument, header: string): boolean => squash(bodyOf(realOf(doc, 0))).includes(squash(header));

  it('dates with a zone and every field shown: both header blocks are left out', () => {
    const result = engineFor(exactBody);
    const doc = build(result);
    expect(keptIn(doc, headerOf(result, 1))).toBe(false);
    expect(keptIn(doc, headerOf(result, 2))).toBe(false);
  });

  it('a Bcc line: that header block stays, as written; the other one goes; the texts go', () => {
    const body = exactBody.replace(/^(To: Carol Test <carol@sample\.invalid>)$/mu, '$1\nBcc: Dan Hidden <dan@example.test>');
    expect(body).not.toBe(exactBody);
    const result = engineFor(body);
    expect(rebuiltEntries(result)).toHaveLength(2);
    const header = headerOf(result, 1);
    expect(header).toContain('Bcc: Dan Hidden');
    const doc = build(result);
    expect(keptIn(doc, header)).toBe(true);
    expect(keptIn(doc, headerOf(result, 2))).toBe(false);
    for (const k of [0, 1]) expect(doc.emails.filter((e) => squash(bodyOf(e)).includes(sentence(FORWARD, k)))).toHaveLength(1);
  });

  it('a From value with two mailboxes ("Unknown sender"): that header block stays', () => {
    const body = exactBody.replace('From: Bob Sample <bob@furniture.example.test>', 'From: Bob Sample <bob@furniture.example.test>, Erin Other <erin@example.test>');
    expect(body).not.toBe(exactBody);
    const result = engineFor(body);
    const r = result.reconstructed.find((x) => x.rebuilt.generation === 1)!;
    expect(r.rebuilt.from).toEqual([]);
    const doc = build(result);
    expect(keptIn(doc, headerOf(result, 1))).toBe(true);
    expect(keptIn(doc, headerOf(result, 2))).toBe(false);
  });

  it('an estimated date (no zone of its own): that header block stays, the text goes', () => {
    const result = engineOf(FORWARD, [2]);
    const doc = build(result);
    for (const g of [1, 2]) expect(keptIn(doc, headerOf(result, g))).toBe(true);
    for (const k of [0, 1]) expect(doc.emails.filter((e) => squash(bodyOf(e)).includes(sentence(FORWARD, k)))).toHaveLength(1);
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

// Review round 3 of task 8.10: attribution first (finding 1), a kept
// signature like own text (S5), name-only recipients (S3), a strong match
// with a real file (S4), and the deliberate repeat of option A (3a).

describe('attribution first: a place that holds own text or a kept signature is not cut at all (finding 1, S5)', () => {
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

  it('withoutPrintedElsewhere: a kept signature inside a part stays, like own text (S5)', () => {
    const r: PlanRange[] = [
      { start: 0, end: 4, keep: true, reason: 'text' },
      { start: 4, end: 25, keep: true, reason: 'forwarded' },
      { start: 25, end: 33, keep: true, reason: 'signature' },
    ];
    const cut = withoutPrintedElsewhere(body, r, [[4, 33]]);
    expect(cut.ranges).toEqual([r[0], { ...r[1], keep: false }, r[2]]);
    const repeated: PlanRange[] = [r[0]!, r[1]!, { ...r[2]!, reason: 'repeated-signature' }];
    expect(withoutPrintedElsewhere(body, repeated, [[4, 33]]).ranges[2]).toEqual(repeated[2]);
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

  it('every email added as a file: the quoted texts go, the header lines (and what is left of them) stay whole', () => {
    const result = engineOf(c, [0, 1, 2]);
    const doc = build(result, { rebuilt: [] });
    for (const k of [0, 1, 2]) expect(doc.emails.filter((e) => squash(bodyOf(e)).includes(sentence(c, k))), `message ${String(k)}`).toHaveLength(1);
    for (const r of result.reconstructed) {
      const position = result.positionByIndex[r.sourceIndex]!;
      const body = result.messages[position]!.message.bodyText;
      const lines = squash(body.slice(r.rebuilt.start, headerLinesEnd(body, r.rebuilt)));
      expect(squash(bodyOf(realOf(doc, position)))).toContain(lines);
    }
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

  it('S4, the whole PDF: every email added, an estimated quoted date with a strong match: those header lines leave the forward', () => {
    const result = engineOf(FORWARD, [0, 1, 2]);
    const forward = result.messages.findIndex((m) => m.message.subject === FORWARD.messages![2]!.subject);
    const linked = result.reconstructed.filter((r) => r.link === 'real' && result.positionByIndex[r.sourceIndex] === forward);
    expect(linked.length).toBeGreaterThan(0);
    const order = planPdfOrder(result, result.messages.map((_, k) => k), []);
    const plans = planOutput(result.messages, DEFAULT_OUTPUT_POLICY);
    const cut = printedElsewhere(result, order.slots, order.pdfNumberByPosition, new Map(plans.map((p, k) => [k, p] as const))).get(forward)!;
    const body = result.messages[forward]!.message.bodyText;
    let strong = 0;
    for (const r of linked) {
      expect(r.rebuilt.dateApproximate).toBe(true);
      const real = result.messages[result.positionByIndex[r.realIndex!]!]!.message;
      const shown = headerShownInPdf(body, r.rebuilt, { kind: 'real', message: real, strong: r.match!.strong && !r.match!.ambiguousDate });
      // Its text is cut; its header lines only when the file's header rows show them.
      expect(cut.some(([a, b]) => a <= r.rebuilt.headerEnd && r.rebuilt.end <= b)).toBe(true);
      expect(cut.some(([a, b]) => a <= r.rebuilt.start && r.rebuilt.headerEnd <= b && r.rebuilt.start < b)).toBe(shown);
      if (r.match!.strong && shown) {
        strong++;
        expect(squash(bodyOf(realOf(build(result, { rebuilt: [] }), forward)))).not.toContain(squash(body.slice(r.rebuilt.start, r.rebuilt.headerEnd)));
      }
    }
    expect(strong).toBeGreaterThan(0);
  });
});

describe('3a, option A (user decision 2026-11-07): the first and the last Outlook files only, a KNOWN, DELIBERATE repeat', () => {
  it('a middle email the plan cannot check stays in the last email (its whole place) and is printed by its rebuilt email too', () => {
    const c = thread('outlook-en x3');
    const last = c.messages!.length - 1;
    const result = engineOf(c, [0, last]);
    const doc = build(result);
    const lastPosition = result.messages.findIndex((m) => m.message.subject === c.messages![last]!.subject && m.message.from[0]?.address === c.messages![last]!.from.address);
    const lastEmail = realOf(doc, lastPosition);
    let repeated = 0;
    for (let k = 1; k < last; k++) {
      const holding = doc.emails.filter((e) => squash(bodyOf(e)).includes(sentence(c, k)));
      // Intended (README, "Known limit (repeats)"): the last email keeps it, as its own text, and its rebuilt email prints it.
      if (holding.length === 2) {
        repeated++;
        expect(holding).toContain(lastEmail);
        expect(holding.filter((e) => e.rebuilt !== null)).toHaveLength(1);
      } else {
        expect(holding).toHaveLength(1);
      }
    }
    expect(repeated).toBeGreaterThan(0);
    // The first email, a real file, is printed once.
    expect(doc.emails.filter((e) => squash(bodyOf(e)).includes(sentence(c, 0)))).toHaveLength(1);
  });
});
