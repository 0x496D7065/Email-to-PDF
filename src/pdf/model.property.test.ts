// Property and speed tests for the PDF document model (src/pdf/model.ts).
//
// Random synthetic emails (seeded, so every run is the same), with bodies
// full of awkward text (control characters, lone surrogates, CR, U+2028,
// tabs, bidi controls, tag characters and flags, noncharacters, joiners,
// emoji, combining marks, runs of blank lines, quotes, reply headers,
// signatures), are run through the real engine and output plan, and:
// - with "include everything" (README.md, rule R6), every email's body in
//   the model is the full body after the documented display transforms only
//   (checked against the independent tests/support/pdf-reference.ts);
// - with the default policy, every shown line is a piece of that full text
//   (nothing is invented, only parts are left out), and the numbering maps
//   back to the included emails;
// - with the rebuilt emails ON (task 7.7), every real email's body is still
//   the same as without them (collapse, never delete), and every email,
//   rebuilt ones too, is numbered 1..n in PDF order (task 8.3);
// - 2000 emails build in well under a second.
// Synthetic data only: made-up names, *.test addresses. Every invisible or
// special character is written as a \u escape.

import { describe, expect, it } from 'vitest';
import { referenceDisplayText } from '../../tests/support/pdf-reference';
import { runEngine } from '../engine/engine';
import { DEFAULT_OUTPUT_POLICY, planOutput } from '../engine/output-plan';
import type { EmailAddress, NormalizedMessage } from '../parsing/types';
import { rebuiltEntries } from '../ui-model/rebuilt';
import { buildPdfDocument, type PdfDocument, type PdfEmail } from './model';
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

function pick<V>(random: () => number, list: readonly V[]): V {
  return list[Math.floor(random() * list.length)]!;
}

const PEOPLE: readonly EmailAddress[] = [
  { name: 'Alice Example', address: 'alice@example.test' },
  { name: 'Bob Sample', address: 'bob@furniture.example.test' },
  { name: 'Carol Test', address: 'carol@sample.test' },
  { name: '', address: 'dan@example.test' },
  { name: 'Erin Été', address: 'ERIN@example.test' },
];

const PIECES: readonly string[] = [
  'The desks arrive on Monday morning.',
  'Please confirm the delivery address for the four chairs.',
  'Café cafe\u{0301} naïve',
  '\u{1F600} \u{1F44D}',
  '\n',
  '\n',
  '\n',
  '\r\n',
  '\r',
  '\n\n\n\n',
  '\r\n\r\n\r\n',
  ' ',
  '\t',
  '  \t \n',
  '\u0000',
  '\u0007',
  '\u001B',
  '\u000B',
  '\u000C',
  '\u007F',
  '\u0085',
  '\u009F',
  '\u{FFFE}',
  '\u{FFFF}',
  '\u{FFFD}\u{FEFF}',
  '\uD83D',
  '\uDE00',
  '\u{00A0}',
  '\u{2028}',
  '\u{2029}',
  // Group 1 of src/pdf/text.ts beyond the controls: bidi controls, annotation, noncharacters, tags.
  '\u{202E}',
  '\u{2066}x\u{2069}',
  '\u{FFF9}',
  '\u{FDD0}',
  '\u{1FFFE}',
  '\u{10FFFF}',
  '\u{E0001}',
  '\u{E0067}',
  '\u{E007F}',
  '\u{1F3F4}',
  '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}',
  '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}',
  '\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}',
  // Not kept: a non-standard subdivision ("usca"), upper case ("GBENG"), a space tag, no terminator.
  '\u{1F3F4}\u{E0075}\u{E0073}\u{E0063}\u{E0061}\u{E007F}',
  '\u{1F3F4}\u{E0047}\u{E0042}\u{E0045}\u{E004E}\u{E0047}\u{E007F}',
  '\u{1F3F4}\u{E0067}\u{E0020}\u{E0062}\u{E007F}',
  '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}',
  // Groups 2 and 3: kept as they are.
  '\u{1F469}\u{200D}\u{1F4BB}',
  '\u{2764}\u{FE0F}',
  '\u{200B}',
  '\u{200E}\u{200F}\u{061C}',
  'soft\u{00AD}hyphen',
  '[U+0000]',
];

/** Quotes, reply headers and signatures: what the output plan may leave out. */
const STRUCTURE: readonly string[] = [
  '> quoted line from before\n',
  'On Tue, 4 Mar 2025 at 09:00, Bob Sample <bob@furniture.example.test> wrote:\n',
  '-- \nAlice Example\nExample Office Supplies\n',
  'Thanks,\n',
];

function randomBody(random: () => number): string {
  const n = Math.floor(random() * 25);
  let body = '';
  // One piece in four is structure, so plans with left-out parts stay common.
  for (let k = 0; k < n; k++) body += random() < 0.25 ? pick(random, STRUCTURE) : pick(random, PIECES);
  return body;
}

function randomMessage(random: () => number, k: number): NormalizedMessage {
  const dated = random() < 0.85;
  return {
    messageId: random() < 0.9 ? `prop-${String(k)}@example.test` : null,
    inReplyTo: null,
    references: [],
    date: dated
      ? { utcMs: Date.UTC(2025, 0, 1) + Math.floor(random() * 3e10), original: 'x', offsetMinutes: 60, zoneKnown: true }
      : { utcMs: null, original: random() < 0.5 ? 'garbled\u0000date' : '', offsetMinutes: null, zoneKnown: false },
    from: random() < 0.95 ? [pick(random, PEOPLE)] : [],
    to: [pick(random, PEOPLE)],
    cc: random() < 0.3 ? [pick(random, PEOPLE)] : [],
    bcc: [],
    subject: random() < 0.1 ? '' : `Re: ${pick(random, PIECES)}`,
    bodyText: randomBody(random),
    attachments: random() < 0.2 ? [{ fileName: `file\u0007${String(k)}.pdf`, size: Math.floor(random() * 2e6), mimeType: 'application/pdf' }] : [],
    source: { fileName: `prop-${String(k)}.eml`, sha256: k.toString(16).padStart(64, '0'), kind: 'eml' },
    warnings: [],
  };
}

const strings = createPdfStrings('en');
const bodyOf = (e: PdfEmail): string => e.body.map(lineText).join('\n');
/** The real emails of a document with their list position (rebuilt emails have none: left out first). */
const realEmails = (d: PdfDocument): { e: PdfEmail; position: number }[] =>
  d.emails.flatMap((e) => (e.rebuilt === null && e.position !== null ? [{ e, position: e.position }] : []));

describe('PDF document model properties', () => {
  it('with "include everything", every body is the full text after the display transforms only', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const random = makeRandom(seed);
      const messages = Array.from({ length: 12 }, (_, k) => randomMessage(random, seed * 100 + k));
      const result = runEngine(messages.map((message) => ({ ok: true as const, message })));
      const positions = result.messages.map((_, k) => k).filter(() => random() < 0.8);
      const policy = { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true };
      // Plans made with the DEFAULT policy on purpose: "include everything" must not depend on them.
      const plans = planOutput(
        positions.map((p) => result.messages[p]!),
        DEFAULT_OUTPUT_POLICY,
      );
      const doc = buildPdfDocument({ result, positions, plans, policy, timeZone: 'America/New_York', generatedAt: 0, strings });
      expect(doc.emails).toHaveLength(positions.length);
      let codes = 0;
      for (const { e, position } of realEmails(doc)) {
        const m = result.messages[position]!;
        expect(bodyOf(e), `seed ${String(seed)} position ${String(e.position)}`).toBe(referenceDisplayText(m.message.bodyText));
        for (const line of e.body) for (const run of line) expect(run.text).not.toMatch(/[\n\r\u{2028}\u{2029}]/u);
        codes += e.flags.controlChars;
      }
      expect(doc.controlChars).toBe(codes);
    }
  });

  it('with the default policy, every shown line is a piece of the full text, and numbers map back', () => {
    let withOmissions = 0;
    for (let seed = 101; seed <= 140; seed++) {
      const random = makeRandom(seed);
      const messages = Array.from({ length: 12 }, (_, k) => randomMessage(random, seed * 100 + k));
      const result = runEngine(messages.map((message) => ({ ok: true as const, message })));
      const positions = result.messages.map((_, k) => k).filter(() => random() < 0.8);
      const plans = planOutput(positions.map((p) => result.messages[p]!));
      withOmissions += plans.filter((p) => p.ranges.some((r) => !r.keep)).length;
      const doc = buildPdfDocument({ result, positions, plans, policy: DEFAULT_OUTPUT_POLICY, timeZone: 'Asia/Tokyo', generatedAt: 0, strings });
      positions.forEach((p, k) => expect(doc.pdfNumberByPosition[p]).toBe(k + 1));
      expect(doc.pdfNumberByPosition.filter((n) => n !== null)).toHaveLength(positions.length);
      for (const { e, position } of realEmails(doc)) {
        const full = referenceDisplayText(result.messages[position]!.message.bodyText);
        for (const line of e.body) {
          const shown = lineText(line);
          if (shown.trim() !== '') expect(full, `seed ${String(seed)}`).toContain(shown);
        }
      }
    }
    // The random emails must really exercise left-out parts.
    expect(withOmissions).toBeGreaterThan(20);
  });

  it('with rebuilt emails chosen, every real email stays; under "Print full original text" each shows its full text and no rebuilt email is in (tasks 7.7, 7.8b)', () => {
    let rebuiltShown = 0;
    for (let seed = 201; seed <= 240; seed++) {
      const random = makeRandom(seed);
      const messages = Array.from({ length: 12 }, (_, k) => {
        const m = randomMessage(random, seed * 100 + k);
        // A quoted history after the new text, so the engine has earlier emails to rebuild.
        const quoted = Array.from({ length: 1 + Math.floor(random() * 4) }, () => `> ${pick(random, PIECES)}`).join('\n');
        const history = `\n\nOn Tue, 4 Mar 2025 at 09:${String(10 + (k % 50))}, ${pick(random, ['Bob Sample <bob@furniture.example.test>', 'Carol Test <carol@sample.test>'])} wrote:\n> The desks arrive on Monday morning.\n${quoted}\n`;
        return random() < 0.7 ? { ...m, bodyText: m.bodyText + history } : m;
      });
      const result = runEngine(messages.map((message) => ({ ok: true as const, message })));
      const positions = result.messages.map((_, k) => k).filter(() => random() < 0.8);
      const policy = { ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true };
      const included = positions.map((p) => result.messages[p]!);
      // Each document is built with plans of its own policy, as the app does (src/ui/pdf-labels.ts).
      const defaultPlans = planOutput(included, DEFAULT_OUTPUT_POLICY);
      const everythingPlans = planOutput(included, policy);
      const rebuilt = rebuiltEntries(result).map((r) => r.id);
      // The default policy: the rebuilt emails chosen are in, between the real ones (which all stay, numbered alike).
      const defaultInput = { result, positions, plans: defaultPlans, policy: DEFAULT_OUTPUT_POLICY, timeZone: 'America/New_York', generatedAt: 0, strings };
      const folded = buildPdfDocument({ ...defaultInput, rebuilt });
      const foldedReal = realEmails(folded);
      rebuiltShown += folded.emails.length - foldedReal.length;
      expect(foldedReal.map((x) => x.position)).toEqual(positions);
      // Task 8.3: every email, rebuilt ones too, is numbered 1..n in PDF order, index alike;
      // the real emails keep their order and carry the number pdfNumberByPosition gives.
      const all = folded.emails.map((_, k) => k + 1);
      expect(folded.emails.map((x) => x.number)).toEqual(all);
      expect(folded.index.entries.map((x) => x.number)).toEqual(all);
      expect(folded.cover.emailCount).toBe(folded.emails.length);
      for (const { e, position } of foldedReal) expect(folded.pdfNumberByPosition[position]).toBe(e.number);
      expect(folded.pdfNumberByPosition.filter((n) => n !== null)).toHaveLength(positions.length);
      // Task 7.7: the real emails' text is the same with and without rebuilt emails.
      const plain = realEmails(buildPdfDocument({ ...defaultInput, rebuilt: [] }));
      expect(foldedReal.map((x) => bodyOf(x.e)), `seed ${String(seed)}`).toEqual(plain.map((x) => bodyOf(x.e)));
      // "Print full original text" (user decision 2026-10-28): the same choice gives NO rebuilt email.
      const doc = buildPdfDocument({ result, positions, plans: everythingPlans, policy, timeZone: 'America/New_York', generatedAt: 0, strings, rebuilt });
      const real = realEmails(doc);
      expect(doc.emails).toHaveLength(real.length);
      expect(doc.cover.emailCount).toBe(real.length);
      expect(doc.index.entries.every((x) => !x.rebuilt)).toBe(true);
      // Every included real email is there once, numbered 1..k in list order, with its full text.
      expect(real.map((x) => x.position)).toEqual(positions);
      expect(real.map((x) => x.e.number)).toEqual(positions.map((_, k) => k + 1));
      for (const { e, position } of real) {
        expect(bodyOf(e), `seed ${String(seed)} position ${String(position)}`).toBe(referenceDisplayText(result.messages[position]!.message.bodyText));
      }
    }
    // The random emails must really give rebuilt emails in the PDF.
    expect(rebuiltShown).toBeGreaterThan(20);
  });

  it('builds 2000 emails in well under a second', () => {
    const random = makeRandom(7);
    const paragraph = 'The desks arrive on Monday morning. Please confirm the delivery address for the four chairs and the meeting table.\n';
    const messages = Array.from({ length: 2000 }, (_, k) => ({
      ...randomMessage(random, k),
      bodyText: `Hello,\n\n${paragraph.repeat(1 + (k % 12))}\n\t\u0000 note ${String(k)}\n\n\n\n-- \nSender ${String(k % 7)}\nExample Office Supplies\n`,
    }));
    const result = runEngine(messages.map((message) => ({ ok: true as const, message })));
    const positions = result.messages.map((_, k) => k);
    const plans = planOutput(result.messages);
    const input = { result, positions, plans, policy: DEFAULT_OUTPUT_POLICY, timeZone: 'Australia/Sydney', generatedAt: 0, strings };
    buildPdfDocument(input); // warm-up (formatter caches, JIT)
    const start = performance.now();
    const doc = buildPdfDocument(input);
    const ms = performance.now() - start;
    console.log(`PDF document model: 2000 emails in ${ms.toFixed(1)} ms`);
    expect(doc.emails).toHaveLength(2000);
    expect(ms).toBeLessThan(1000);
  });
});
