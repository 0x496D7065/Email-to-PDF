// Unit tests for the preview's no-repeat labels (task 8.11;
// printed-elsewhere.ts with pdf-plan.ts): over every conversation of
// tests/support/thread-cases.ts, with "Print full original text" off and
// several sets of files and rebuilt emails chosen, the parts the preview
// labels "printed as email #N" are EXACTLY the parts the PDF leaves out of
// that email because it prints them as an email of its own, and N names the
// email of the PDF that prints them. With "Print full original text" on,
// nothing is labelled that way. The PDF side is read from the PDF model's
// own output (buildPdfDocument): the body of each email it prints.
// Synthetic data only (README.md, rule R7).
import { describe, expect, it } from 'vitest';
import { buildThread, instantOf, type ThreadMessage } from '../../tests/support/thread-builder';
import { THREAD_CASES, type ThreadCase } from '../../tests/support/thread-cases';
import { runEngine, type EngineResult } from '../engine/engine';
import { DEFAULT_OUTPUT_POLICY, planOutput, type MessagePlan, type OutputPolicy } from '../engine/output-plan';
import type { NormalizedMessage } from '../parsing/types';
import { buildPdfDocument, noRepeat, pdfBodyText, withoutPrintedElsewhere, type PdfDocument, type PdfEmail } from '../pdf/model';
import { createPdfStrings } from '../pdf/strings';
import { bodyLines, lineText } from '../pdf/text';
import { pdfBlocks, signatureSources, type PdfView, type PrintedAs } from './pdf-plan';
import { printedElsewhereRanges } from './printed-elsewhere';
import { rebuiltEntries } from './rebuilt';

const EN = createPdfStrings('en');

/** Message `i` of a conversation as a real file (its body quotes the ones before it). */
function realFile(messages: readonly ThreadMessage[], i: number, tag: string): NormalizedMessage {
  const m = messages[i]!;
  const id = (k: number): string => `${tag}-${String(k)}@example.test`;
  const utcMs = instantOf(m.sent, m.zone);
  return {
    messageId: id(i),
    inReplyTo: i === 0 ? null : id(i - 1),
    references: Array.from({ length: i }, (_, k) => id(k)),
    date: { utcMs, original: new Date(utcMs).toUTCString(), offsetMinutes: m.zone.offsetMinutes, zoneKnown: true },
    from: [m.from],
    to: m.to,
    cc: m.cc ?? [],
    bcc: [],
    subject: m.subject,
    bodyText: buildThread(messages.slice(0, i + 1)).body,
    attachments: [],
    source: { fileName: `${tag}-${String(i)}.eml`, sha256: (i + 1).toString(16).padStart(64, '0'), kind: 'eml' },
    warnings: [],
  };
}

const squash = (s: string): string => s.replace(/\s+/gu, ' ').trim();
const bodyOf = (e: PdfEmail): string => e.body.map(lineText).join('\n');
const keyOf = (p: PrintedAs): string => {
  switch (p.kind) {
    case 'rebuilt':
      return `rebuilt ${String(p.id)} = Email ${String(p.number)}`;
    case 'email':
      return `email #${String(p.position + 1)} = Email ${String(p.number)}`;
    case 'unticked':
      return `unticked rebuilt ${String(p.id)} (not in the PDF)`;
  }
};

/** Where `sentence` (white space squashed) starts in `body`, white space and ">" quote marks between its words allowed; -1 if not found. */
function placeOf(body: string, sentence: string): number {
  const words = sentence.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'));
  return body.search(new RegExp(words.join('(?:\\s|>)+'), 'u'));
}

/** The own sentence of each email of the conversation, white space squashed. */
function sentences(c: ThreadCase): string[] {
  return c.messages!.map((m) => squash(m.text.split('\n\n')[1]!));
}

interface Scenario {
  readonly name: string;
  /** Conversation indices dropped as files. */
  readonly dropped: (last: number) => number[];
  /** The rebuilt ids chosen, from all of them in timeline order. */
  readonly rebuilt: (ids: readonly number[]) => number[];
}

const SCENARIOS: readonly Scenario[] = [
  { name: 'the last email alone, every rebuilt email ticked', dropped: (l) => [l], rebuilt: (ids) => [...ids] },
  { name: 'the last email alone, no rebuilt email ticked', dropped: (l) => [l], rebuilt: () => [] },
  { name: 'the last email alone, every other rebuilt email ticked', dropped: (l) => [l], rebuilt: (ids) => ids.filter((_, k) => (ids.length - 1 - k) % 2 === 0) },
  { name: 'every email as a file, every rebuilt email ticked', dropped: (l) => Array.from({ length: l + 1 }, (_, k) => k), rebuilt: (ids) => [...ids] },
  { name: 'every email as a file, no rebuilt email ticked', dropped: (l) => Array.from({ length: l + 1 }, (_, k) => k), rebuilt: () => [] },
  { name: 'the first and the last, every rebuilt email ticked', dropped: (l) => [0, l], rebuilt: (ids) => [...ids] },
  { name: 'the first and the last, no rebuilt email ticked', dropped: (l) => [0, l], rebuilt: () => [] },
];

/** The engine result, plans and PDF of a scenario (every email ticked), as the app makes them. */
function setUp(c: ThreadCase, s: Scenario, policy: OutputPolicy = DEFAULT_OUTPUT_POLICY) {
  const tag = c.id.replace(/[^a-z0-9]+/giu, '-');
  const last = c.messages!.length - 1;
  const result: EngineResult = runEngine(s.dropped(last).map((i) => ({ ok: true as const, message: realFile(c.messages!, i, tag) })));
  const positions = result.messages.map((_, k) => k);
  const plans = planOutput(
    positions.map((p) => result.messages[p]!),
    policy,
  );
  const ids = rebuiltEntries(result).map((r) => r.id);
  const rebuilt = s.rebuilt(ids);
  // Every rebuilt email not chosen is one the reader unticked (src/ui/review.ts, untickedRebuilt, with every card shown).
  const unticked = ids.filter((id) => !rebuilt.includes(id));
  const input = { result, positions, plans, policy, rebuilt, unticked };
  const doc: PdfDocument = buildPdfDocument({ ...input, timeZone: 'UTC', generatedAt: Date.UTC(2025, 5, 1, 12, 0, 0), strings: EN });
  // The preview's views, as src/ui/pdf-labels.ts makes them.
  const sources = signatureSources(
    positions.map((p) => ({ message: result.messages[p]!.message, position: p })),
    plans,
  );
  const cut = printedElsewhereRanges(input);
  const views = new Map<number, PdfView>();
  positions.forEach((p, k) => {
    const ranges = cut.get(p);
    views.set(p, { plan: plans[k]!, signatureFrom: sources.get(p) ?? new Map(), ...(ranges === undefined ? {} : { pdfRanges: ranges }) });
  });
  return { result, positions, plans, input, doc, views };
}

/** Per non-blank character of a body: where the preview says it is printed instead (only characters so labelled). */
function labelled(body: string, result: EngineResult, position: number, view: PdfView): Map<number, PrintedAs> {
  const out = new Map<number, PrintedAs>();
  for (const { block, label } of pdfBlocks(body, result.messages[position]!.segments, view)) {
    const printedAs = label?.printedAs ?? null;
    if (printedAs === null) continue;
    expect(label!.status).toBe('out');
    for (let i = block.start; i < block.end; i++) if (/\S/u.test(body[i]!)) out.set(i, printedAs);
  }
  return out;
}

/** Per non-blank character of a body: kept by `plan` but left out of the PDF (the cut the PDF makes, read from `ranges`). */
function cutChars(body: string, plan: MessagePlan, ranges: readonly { start: number; end: number; keep: boolean }[]): Set<number> {
  const keptByPlan = new Uint8Array(body.length);
  for (const r of plan.ranges) if (r.keep) keptByPlan.fill(1, r.start, r.end);
  const out = new Set<number>();
  for (const r of ranges) {
    if (r.keep) continue;
    for (let i = r.start; i < r.end; i++) if (keptByPlan[i] === 1 && /\S/u.test(body[i]!)) out.add(i);
  }
  return out;
}

describe('"printed as email #N" labels say exactly what the PDF leaves out (task 8.11), every conversation of thread-cases.ts', () => {
  let labelledSomewhere = 0;
  let rebuiltTargets = 0;
  let realTargets = 0;
  let untickedTargets = 0;
  let sentencesLabelled = 0;
  let sentencesKept = 0;

  for (const c of THREAD_CASES) {
    describe(c.id, () => {
      for (const s of SCENARIOS) {
        it(s.name, () => {
          const { result, positions, plans, input, doc, views } = setUp(c, s);
          const { elsewhere } = noRepeat(input);
          const all = sentences(c);
          for (const [k, position] of positions.entries()) {
            const body = result.messages[position]!.message.bodyText;
            const plan = plans[k]!;
            const email = doc.emails.find((e) => e.position === position)!;
            // The PDF model's own body is the plan cut by the no-repeat parts (ties the parts to the real output).
            const parts = elsewhere.get(position) ?? [];
            const printed = pdfBodyText(body, plan, DEFAULT_OUTPUT_POLICY, parts);
            expect(email.body.map(lineText), `${c.id} #${String(position + 1)} body`).toEqual(bodyLines(printed.text, { notLineStarts: printed.notLineStarts }).lines.map(lineText));
            // 1. The characters labelled are exactly the characters the PDF leaves out by this rule.
            const marks = labelled(body, result, position, views.get(position)!);
            const cut = cutChars(body, plan, withoutPrintedElsewhere(body, plan.ranges, parts).ranges);
            expect([...marks.keys()].sort((a, b) => a - b), `${c.id} #${String(position + 1)} labelled`).toEqual([...cut].sort((a, b) => a - b));
            expect(email.flags.printedElsewhere).toBe(cut.size > 0);
            labelledSomewhere += marks.size > 0 ? 1 : 0;
            // 2. N names the email the PDF prints it as.
            for (const target of new Map([...marks.values()].map((p) => [keyOf(p), p])).values()) {
              if (target.kind === 'unticked') {
                // Q2 (task 8.13a): a forwarded part of an unticked rebuilt email, printed nowhere.
                untickedTargets++;
                expect(input.rebuilt, keyOf(target)).not.toContain(target.id);
                expect(input.unticked, keyOf(target)).toContain(target.id);
                expect(doc.emails.some((e) => e.rebuilt?.id === target.id), keyOf(target)).toBe(false);
                continue;
              }
              const shown = doc.emails[target.number - 1]!;
              expect(shown.number, keyOf(target)).toBe(target.number);
              if (target.kind === 'rebuilt') {
                rebuiltTargets++;
                expect(shown.rebuilt?.id, keyOf(target)).toBe(target.id);
              } else {
                realTargets++;
                expect(shown.position, keyOf(target)).toBe(target.position);
                expect(doc.pdfNumberByPosition[target.position]).toBe(target.number);
              }
            }
            // 3. Read on the emails' own sentences: one labelled is gone from this email and in the email named;
            //    one kept by the plan and not labelled is still in this email.
            const shownHere = squash(bodyOf(email));
            for (const sentence of all) {
              const start = placeOf(body, sentence);
              if (start < 0) continue;
              const target = marks.get(start);
              if (target !== undefined) {
                sentencesLabelled++;
                expect(shownHere, `${c.id}: "${sentence}" labelled ${keyOf(target)}`).not.toContain(sentence);
                if (target.kind === 'unticked') expect(doc.emails.filter((e) => squash(bodyOf(e)).includes(sentence)), `${c.id}: "${sentence}" nowhere in the PDF`).toHaveLength(0);
                else expect(squash(bodyOf(doc.emails[target.number - 1]!)), `${c.id}: "${sentence}" in ${keyOf(target)}`).toContain(sentence);
              } else if (plan.ranges.some((r) => r.keep && r.start <= start && start < r.end)) {
                sentencesKept++;
                expect(shownHere, `${c.id}: "${sentence}" kept`).toContain(sentence);
              }
            }
          }
        });
      }

      it('"Print full original text": nothing is labelled "printed as" (every email is printed whole)', () => {
        const everything = { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true };
        const { result, positions, input, views } = setUp(c, SCENARIOS[0]!, everything);
        expect(printedElsewhereRanges(input).size).toBe(0);
        for (const p of positions) {
          expect(views.get(p)!.pdfRanges).toBeUndefined();
          expect(labelled(result.messages[p]!.message.bodyText, result, p, views.get(p)!).size).toBe(0);
        }
      });
    });
  }

  it('the cases really exercise the labels, with both kinds of email named', () => {
    // At the time of writing: 64 emails with labels, 23 rebuilt and 74 real emails named, 97 sentences labelled, 683 kept.
    expect(labelledSomewhere).toBeGreaterThan(50);
    expect(rebuiltTargets).toBeGreaterThan(15);
    expect(realTargets).toBeGreaterThan(50);
    // Task 8.13a, Q2: forwarded parts left out with their unticked rebuilt emails.
    expect(untickedTargets).toBeGreaterThan(5);
    expect(sentencesLabelled).toBeGreaterThan(80);
    expect(sentencesKept).toBeGreaterThan(500);
  });
});
