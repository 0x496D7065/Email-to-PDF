// Random tests of collapse, never delete when emails QUOTE each other (task
// 8.13b-3, review round 3, finding M2). Seeded random conversations
// (tests/support/quoting-builder.ts: reply headers in English, French and
// Dutch with ">" marks, Outlook header blocks, "-----Original Message-----",
// forwards, a quoted sentence alone, text pasted with no header; right,
// missing and wrong In-Reply-To; right, missing, unreadable and wrong
// dates) are run through the real engine, output plan and PDF model with
// "Print full original text" off, dropped:
// - each email as a file of its own (plain files: the loss that existed
//   before task 8.13b-3, an undated or wrong-clock email whose paragraph a
//   reply quotes without In-Reply-To);
// - grouped into files with emails attached inside them, inline or as a
//   file, up to three levels deep (tests/support/attached-builder.ts), with
//   some attached emails also dropped as files of their own (copies, merged).
// Random ticks and random rebuilt emails chosen. Checked:
// - every ticked email's own sentence is printed at least once in the PDF
//   (the PRINTED SOMEWHERE check, src/pdf/model.ts, and the engine's
//   withHeldReferences, src/engine/overlap.ts); how often one is printed
//   twice is counted and reported (allowed: restoring may print twice);
// - an unticked email's sentence is printed nowhere when no ticked email's
//   own text quotes it (Q3: an unticked attached email is left out of the
//   emails holding it too);
// - with "Print full original text" on, every ticked email's whole text.
// Synthetic data only: made-up names, *.test addresses (README.md, rule R7).

import { describe, expect, it } from 'vitest';
import { groupAsAttached } from '../../tests/support/attached-builder';
import { referenceDisplayText } from '../../tests/support/pdf-reference';
import { quotingCase, quotingSentence, type QuotingCase } from '../../tests/support/quoting-builder';
import { DEFAULT_PARTS, runEngine, type EngineParts, type EngineResult } from '../engine/engine';
import { detectQuotedOverlap } from '../engine/overlap';
import { DEFAULT_OUTPUT_POLICY, planOutput, type MessagePlan, type OutputPolicy } from '../engine/output-plan';
import type { NormalizedMessage, ParseResult } from '../parsing/types';
import { rebuiltEntries } from '../ui-model/rebuilt';
import { buildPdfDocument, noRepeat, type PdfEmail } from './model';
import { createPdfStrings } from './strings';
import { lineText } from './text';

/** mulberry32: a tiny seeded generator, returns numbers in [0, 1). */
function makeRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const strings = createPdfStrings('en');
const squash = (s: string): string => s.replace(/\s+/gu, ' ').trim();
const bodyOf = (e: PdfEmail): string => e.body.map(lineText).join('\n');

type Dropped = 'files' | 'attached';

/**
 * The parse results of a case: each email a file, or grouped with emails attached inside files (and some
 * copies dropped too). The emails of `missing` (indices into c.messages) are in no file at all: emails
 * the reader did not add, whose text is only in the quotes of others (review round 4, M1).
 */
function filesOf(c: QuotingCase, dropped: Dropped, random: () => number, missing: ReadonlySet<number>): ParseResult[] {
  const present = c.messages.filter((_, k) => !missing.has(k));
  if (dropped === 'files') return present.map((message) => ({ ok: true as const, message }));
  const files: ParseResult[] = groupAsAttached(present, random, { mode: 'random', attachShare: 0.6 });
  // Copies: some attached emails with none attached inside them also dropped as files of their own
  // (merged with them by Message-ID). One holding others would come with its own attached list, as a
  // parser gives it; a file whose inline forwards were not read as attached emails is another case.
  for (const f of [...files]) {
    if (!f.ok) continue;
    const list = f.attached ?? [];
    list.forEach((a, k) => {
      if (list.some((x) => x.parent === k) || random() >= 0.2) return;
      files.push({ ok: true, message: { ...a.message, source: { fileName: `copy-${a.message.messageId ?? ''}.eml`, sha256: 'c'.repeat(64), kind: 'eml' } } });
    });
  }
  return files;
}

interface Tally {
  cases: number;
  ticked: number;
  lost: number;
  twice: number;
  unticked: number;
  attached: number;
  /** Sentences that the plan of a ticked email keeps (outside parts left out on purpose: an unticked email's block or forwarded part). */
  keptChecked: number;
  /** ... of which printed nowhere in the PDF (expected: 0). */
  keptLost: number;
  /** Sentences of emails the reader did not add (in no file), kept by the plan of a ticked email (quoted history, review round 4, M1). */
  missingChecked: number;
  /** ... of which printed nowhere in the PDF (expected: 0). */
  missingLost: number;
  failures: string[];
}

const tally = (): Tally => ({ cases: 0, ticked: 0, lost: 0, twice: 0, unticked: 0, attached: 0, keptChecked: 0, keptLost: 0, missingChecked: 0, missingLost: 0, failures: [] });

/**
 * Per email in the PDF (list position): the text its plan KEEPS, less the parts the no-repeat rule leaves
 * out on purpose (kind 'unticked': a forwarded part of an unticked rebuilt email, Q2 of task 8.13a;
 * 'unticked-attached': the block of an unticked attached email, Q3), as display text (no ">" marks).
 * Every sentence in it must be printed somewhere in the PDF: the no-repeat rule may move text to another
 * email, never lose it (review round 4, M1).
 */
function keptTexts(out: EngineResult, positions: readonly number[], plans: readonly MessagePlan[], rebuilt: readonly number[], unticked: readonly number[]): Map<number, string> {
  const { parts } = noRepeat({ result: out, positions, plans, policy: DEFAULT_OUTPUT_POLICY, rebuilt, unticked });
  const texts = new Map<number, string>();
  positions.forEach((position, k) => {
    const body = out.messages[position]!.message.bodyText;
    const onPurpose = (parts.get(position) ?? []).filter((p) => p.printedAs.kind === 'unticked' || p.printedAs.kind === 'unticked-attached');
    const pieces: string[] = [];
    for (const r of plans[k]!.ranges) {
      if (!r.keep) continue;
      let from = r.start;
      for (const p of [...onPurpose].sort((a, b) => a.start - b.start)) {
        if (p.end <= from || p.start >= r.end) continue;
        if (p.start > from) pieces.push(body.slice(from, p.start));
        from = Math.min(p.end, r.end);
      }
      if (from < r.end) pieces.push(body.slice(from, r.end));
    }
    texts.set(position, squash(pieces.map((piece) => referenceDisplayText(piece)).join('\n')));
  });
  return texts;
}

/** One case: the folded PDF of a random selection, every own sentence checked; then the full text. */
function check(c: QuotingCase, out: EngineResult, random: () => number, where: string, t: Tally, missing: ReadonlySet<number>): void {
  t.cases++;
  t.attached += out.attached?.length ?? 0;
  const positions = out.messages.map((_, k) => k).filter(() => random() < 0.75);
  const ids = rebuiltEntries(out).map((r) => r.id);
  const rebuilt = ids.filter(() => random() < 0.5);
  const unticked = ids.filter((id) => !rebuilt.includes(id));
  const plansOf = (policy: OutputPolicy): MessagePlan[] =>
    planOutput(
      positions.map((p) => out.messages[p]!),
      policy,
    );
  const make = (policy: OutputPolicy) =>
    buildPdfDocument({
      result: out,
      positions,
      plans: plansOf(policy),
      policy,
      timeZone: 'UTC',
      generatedAt: 0,
      strings,
      rebuilt,
      unticked,
    });
  const doc = make(DEFAULT_OUTPUT_POLICY);
  const bodies = doc.emails.map((e) => squash(bodyOf(e)));
  const ticked = new Set(positions);
  const tickedIds = new Set(positions.map((p) => out.messages[p]!.message.messageId));
  // No text kept by a ticked email's plan is printed nowhere (the no-repeat rule only moves text).
  const kept = [...keptTexts(out, positions, plansOf(DEFAULT_OUTPUT_POLICY), rebuilt, unticked).values()];
  c.sentences.forEach((s, k) => {
    const sentence = squash(s);
    if (!kept.some((text) => text.includes(sentence))) return;
    const isMissing = missing.has(k);
    t.keptChecked++;
    if (isMissing) t.missingChecked++;
    if (bodies.some((b) => b.includes(sentence))) return;
    t.keptLost++;
    if (isMissing) t.missingLost++;
    t.failures.push(`${where}: email ${String(k)}${isMissing ? ' (not added)' : ''}: kept by a ticked email's plan, printed nowhere`);
  });
  c.messages.forEach((m, k) => {
    if (missing.has(k)) return;
    const sentence = squash(c.sentences[k]!);
    const times = bodies.filter((b) => b.includes(sentence)).length;
    const position = out.messages.findIndex((x) => x.message.messageId === m.messageId);
    if (ticked.has(position)) {
      t.ticked++;
      if (times === 0) {
        t.lost++;
        t.failures.push(`${where}: email ${String(k)} (ticked) printed nowhere`);
      }
      if (times > 1) t.twice++;
    } else {
      t.unticked++;
      // Quoted in the own text of a ticked email (not only in the block of an email holding it): it may be printed there.
      const quoted = c.messages.some((x, j) => j !== k && tickedIds.has(x.messageId) && squash(referenceDisplayText(x.bodyText)).includes(sentence));
      if (!quoted && times !== 0) t.failures.push(`${where}: email ${String(k)} (unticked, quoted by no ticked email) printed ${String(times)} times`);
    }
  });
  // "Print full original text": every ticked email whole.
  const full = make({ ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true });
  for (const e of full.emails) {
    if (e.position === null) continue;
    if (bodyOf(e) !== referenceDisplayText(out.messages[e.position]!.message.bodyText)) t.failures.push(`${where}: full text of position ${String(e.position)} not whole`);
  }
}

/** The real overlap detector, told nothing about which email holds which (the engine's fixes for attached emails undone). */
const NO_HOLDS: EngineParts = {
  ...DEFAULT_PARTS,
  detectQuotedOverlap: (messages) => detectQuotedOverlap(messages.map((m) => ({ bodyText: m.bodyText, messageId: m.messageId, inReplyTo: m.inReplyTo, references: m.references, index: m.index }))),
};

function run(dropped: Dropped, seeds: number, quoteShare: number, parts: EngineParts = DEFAULT_PARTS, label = ''): Tally {
  const t = tally();
  for (let seed = 1; seed <= seeds; seed++) {
    const random = makeRandom(seed * 7 + Math.round(quoteShare * 100));
    const c = quotingCase(random, `q${String(seed)}`, { quoteShare });
    // Some emails not added at all (review round 4, M1): never all of them.
    const missing = new Set<number>();
    c.messages.forEach((_, k) => {
      if (random() < 0.25 && missing.size + 1 < c.messages.length) missing.add(k);
    });
    const out = runEngine(filesOf(c, dropped, random, missing), parts);
    check(c, out, random, `${dropped}${label} share ${String(quoteShare)} seed ${String(seed)}`, t, missing);
  }
  console.log(
    `quoting random cases (${dropped}${label}, quote share ${String(quoteShare)}): ${String(t.cases)} cases, ${String(t.attached)} attached emails, ${String(t.ticked)} ticked emails checked: lost ${String(t.lost)}, printed twice ${String(t.twice)}; ${String(t.unticked)} unticked; kept text checked ${String(t.keptChecked)}, printed nowhere ${String(t.keptLost)}; quoted text of emails not added checked ${String(t.missingChecked)}, printed nowhere ${String(t.missingLost)}`,
  );
  return t;
}

describe('collapse, never delete, with emails quoting each other: random cases (task 8.13b-3, review round 3, M2)', () => {
  for (const share of [0.35, 0.7]) {
    it(`plain files, quote share ${String(share)}: every ticked email's own text, and all text kept by a ticked email's plan, printed at least once (600 cases)`, () => {
      const t = run('files', 600, share);
      expect(t.failures.slice(0, 10)).toEqual([]);
      expect(t.lost).toBe(0);
      expect(t.keptLost).toBe(0);
      expect(t.missingLost).toBe(0);
      expect(t.ticked).toBeGreaterThan(1000);
      expect(t.unticked).toBeGreaterThan(300);
    }, 120_000);

    it(`emails attached inside files, quote share ${String(share)}: every ticked email's own text, and all text kept by a ticked email's plan (quoted history of emails not added included), printed at least once (600 cases)`, () => {
      const t = run('attached', 600, share);
      expect(t.failures.slice(0, 10)).toEqual([]);
      expect(t.lost).toBe(0);
      expect(t.keptLost).toBe(0);
      expect(t.missingLost).toBe(0);
      expect(t.attached).toBeGreaterThan(600);
      expect(t.ticked).toBeGreaterThan(1000);
      // The cases must really hold quoted history of emails not added, kept inside forwards.
      expect(t.missingChecked).toBeGreaterThan(15);
    }, 120_000);
  }

  it('speed: 2000 emails, each pasting the text of the one before, none dated (a candidate in every email): the PDF model in well under a second', () => {
    const messages: NormalizedMessage[] = [];
    for (let k = 0; k < 2000; k++) {
      const name = `speed${String(k)}`;
      const before = k === 0 ? '' : `\n\n${quotingSentence(`speed${String(k - 1)}`)}\n${quotingSentence(`speed${String(k - 1)}`)}`;
      messages.push({
        messageId: `${name}@example.test`,
        inReplyTo: null,
        references: [],
        date: { utcMs: null, original: '', offsetMinutes: null, zoneKnown: false },
        from: [{ name: `Person ${String(k % 5)}`, address: `p${String(k % 5)}@example.test` }],
        to: [{ name: 'Team', address: 'team@example.test' }],
        cc: [],
        bcc: [],
        subject: `Note ${String(k)}`,
        bodyText: `Hello team,\n\n${quotingSentence(name)}\n${quotingSentence(name)}${before}\n`,
        attachments: [],
        source: { fileName: `${name}.eml`, sha256: k.toString(16).padStart(64, '0'), kind: 'eml' },
        warnings: [],
      });
    }
    const out = runEngine(messages.map((message) => ({ ok: true as const, message })));
    const positions = out.messages.map((_, k) => k);
    const plans = planOutput(out.messages, DEFAULT_OUTPUT_POLICY);
    const input = { result: out, positions, plans, policy: DEFAULT_OUTPUT_POLICY, timeZone: 'UTC', generatedAt: 0, strings };
    buildPdfDocument(input); // warm-up
    const start = performance.now();
    const doc = buildPdfDocument(input);
    const ms = performance.now() - start;
    const restored = noRepeat({ ...input, rebuilt: [] }).restored.size;
    console.log(`quoting speed case: 2000 emails in ${ms.toFixed(1)} ms, ${String(restored)} emails with restored text`);
    expect(doc.emails).toHaveLength(2000);
    const bodies = doc.emails.map((e) => squash(bodyOf(e)));
    for (let k = 0; k < 2000; k += 97) expect(bodies.some((b) => b.includes(squash(quotingSentence(`speed${String(k)}`))))).toBe(true);
    expect(ms).toBeLessThan(1500);
  }, 120_000);

  it('the PRINTED SOMEWHERE check alone (the engine\'s holder links undone): still at least once (400 cases with attached emails)', () => {
    const t = run('attached', 400, 0.5, NO_HOLDS, ' no holds');
    expect(t.failures.slice(0, 10)).toEqual([]);
    expect(t.lost).toBe(0);
    expect(t.keptLost).toBe(0);
  }, 120_000);
});
