// Random tests of collapse, never delete with emails attached inside dropped
// files (task 8.13b-3, review round 2, finding M1). Seeded random .eml files
// (so every run is the same) are read by the real .eml parser and run
// through the real engine, output plan and PDF model with "Print full
// original text" off: trees of emails attached inline or as a file, up to
// three levels deep, with random dates (with a zone, without one, missing,
// unreadable), random In-Reply-To links (to any email of the case, also
// "backwards"), copies of attached emails (and of whole files) also dropped
// as files of their own, in random file order, random ticks and random
// rebuilt emails chosen. Each email has one sentence of its own, found in
// no other email's own text. Checked:
// - every ticked email's own sentence is printed at least once in the PDF;
//   how often one is printed twice is counted (expected: never);
// - an unticked email's sentence is printed nowhere (Q3: an unticked
//   attached email is left out of the email holding it too);
// - the no-repeat rule alone (src/pdf/model.ts, blockClaims: only what an
//   attached email's page prints is left out of the email holding it,
//   review round 4), with an overlap detector that ignores the holder links
//   (`holds`, src/engine/overlap.ts): still at least once.
// Synthetic data only: made-up names, *.test addresses (README.md, rule R7).

import { describe, expect, it } from 'vitest';
import { DEFAULT_PARTS, runEngine, type EngineParts, type EngineResult } from '../engine/engine';
import { detectQuotedOverlap } from '../engine/overlap';
import { DEFAULT_OUTPUT_POLICY, planOutput } from '../engine/output-plan';
import { createEmlParser } from '../parsing/eml';
import type { HtmlToTextResult } from '../parsing/html-to-text';
import type { ParseResult } from '../parsing/types';
import { rebuiltEntries } from '../ui-model/rebuilt';
import { buildPdfDocument, type PdfDocument, type PdfEmail } from './model';
import { createPdfStrings } from './strings';
import { lineText } from './text';

/** mulberry32: a tiny seeded generator, returns numbers in [0, 1). */
function makeRandom(seed: number): () => number
{
    let a = seed >>> 0;
    return () =>
    {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const crlf = (...lines: string[]): string => lines.join('\r\n');
const stub = (html: string): HtmlToTextResult => ({ text: `[html ${String(html.length)}]`, truncated: false });
const eml = createEmlParser({ htmlToText: stub });
const strings = createPdfStrings('en');

const plain = (text: string): string => crlf('Content-Type: text/plain; charset=utf-8', '', text);
const mixed = (b: string, ...parts: string[]): string =>
    crlf(`Content-Type: multipart/mixed; boundary="${b}"`, '', ...parts.flatMap((p) => [`--${b}`, p]), `--${b}--`, '');
const rfc822 = (message: string, asFile: boolean, name: string): string =>
    crlf('Content-Type: message/rfc822', ...(asFile ? [`Content-Disposition: attachment; filename="${name}.eml"`] : []), '', message);

/** One email of a case. */
interface Spec
{
    readonly name: string;
    /** The Date header's value, or null for none. */
    readonly date: string | null;
    readonly inReplyTo: string | null;
    readonly children: { readonly spec: Spec; readonly asFile: boolean }[];
}

const WORDS = ['north', 'warehouse', 'shelf', 'label', 'oak', 'desk', 'invoice', 'route', 'mover', 'window', 'figure', 'total', 'chair', 'table', 'delivery', 'count'];

/** The sentence of its own of email `name`: long enough to be matched as a quote, and unique. */
function sentenceOf(name: string): string
{
    let h = 0;
    for (const c of name)
    {
        h = (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0;
    }
    const words = Array.from({ length: 10 }, (_, k) => WORDS[(h >>> (k * 3)) % WORDS.length]!);
    return `Own words of ${name}: the ${words.join(' ')} were checked again this week.`;
}

/** The .eml text of `s` (its attached emails inside it). */
function emlOf(s: Spec): string
{
    const head = [
        `From: ${s.name} <${s.name}@example.test>`,
        'To: Team <team@example.test>',
        ...(s.date === null ? [] : [`Date: ${s.date}`]),
        `Subject: ${s.name} subject`,
        `Message-ID: <${s.name}@example.test>`,
        ...(s.inReplyTo === null ? [] : [`In-Reply-To: <${s.inReplyTo}@example.test>`]),
        'MIME-Version: 1.0',
    ];
    if (s.children.length === 0)
    {
        return crlf(...head, 'Content-Type: text/plain; charset=utf-8', '', sentenceOf(s.name));
    }
    return crlf(...head, mixed(`b-${s.name}`, plain(sentenceOf(s.name)), ...s.children.map((c) => rfc822(emlOf(c.spec), c.asFile, c.spec.name))));
}

function randomDate(random: () => number): string | null
{
    const kind = random();
    const hh = String(8 + Math.floor(random() * 10)).padStart(2, '0');
    const mm = String(Math.floor(random() * 60)).padStart(2, '0');
    const day = 1 + Math.floor(random() * 3);
    const when = `${['Sun', 'Mon', 'Tue'][day - 1]!}, ${String(day)} Jun 2025 ${hh}:${mm}:00`;
    if (kind < 0.45)
    {
        return `${when} +0200`;
    }
    if (kind < 0.65)
    {
        return when; // no zone
    }
    if (kind < 0.85)
    {
        return null;
    }
    return 'sometime last week'; // unreadable
}

interface Case
{
    readonly files: string[];
    readonly all: Spec[];
}

function randomCase(random: () => number, id: number): Case
{
    const all: Spec[] = [];
    const make = (depth: number): Spec =>
    {
        const s: Spec = { name: `c${String(id)}e${String(all.length)}`, date: randomDate(random), inReplyTo: null, children: [] };
        all.push(s);
        const kids = depth >= 3 ? 0 : Math.floor(random() * (depth === 0 ? 3 : 2.4));
        for (let k = 0; k < kids; k++)
        {
            s.children.push({ spec: make(depth + 1), asFile: random() < 0.3 });
        }
        return s;
    };
    const roots = Array.from({ length: 1 + Math.floor(random() * 2.5) }, () => make(0));
    // Random In-Reply-To links, to any email of the case (an attached one too, either way round).
    for (const s of all)
    {
        if (random() < 0.4)
        {
            (s as { inReplyTo: string | null }).inReplyTo = all[Math.floor(random() * all.length)]!.name;
        }
    }
    const files: string[] = roots.map(emlOf);
    // Copies: attached emails also dropped on their own, a whole file twice.
    for (const s of all)
    {
        if (!roots.includes(s) && random() < 0.25)
        {
            files.push(emlOf(s));
        }
    }
    if (random() < 0.1)
    {
        files.push(files[0]!);
    }
    // Random file order.
    for (let k = files.length - 1; k > 0; k--)
    {
        const j = Math.floor(random() * (k + 1));
        [files[k], files[j]] = [files[j]!, files[k]!];
    }
    return { files, all };
}

const squash = (s: string): string => s.replace(/\s+/gu, ' ').trim();
const bodyOf = (e: PdfEmail): string => e.body.map(lineText).join('\n');

async function parseAll(files: readonly string[]): Promise<ParseResult[]>
{
    return Promise.all(files.map((text, k) => eml.parse({ name: `f${String(k)}.eml`, bytes: new TextEncoder().encode(text) })));
}

interface Tally
{
    checked: number;
    twice: number;
    unticked: number;
    attachedChecked: number;
    failures: string[];
}

/** Builds the folded PDF of a random selection of `out` and checks every email's own sentence. */
function check(out: EngineResult, random: () => number, where: string, tally: Tally): void
{
    const positions = out.messages.map((_, k) => k).filter(() => random() < 0.75);
    const plans = planOutput(
        positions.map((p) => out.messages[p]!),
        DEFAULT_OUTPUT_POLICY,
    );
    const ids = rebuiltEntries(out).map((r) => r.id);
    const rebuilt = ids.filter(() => random() < 0.5);
    const unticked = ids.filter((id) => !rebuilt.includes(id));
    const doc: PdfDocument = buildPdfDocument({ result: out, positions, plans, policy: DEFAULT_OUTPUT_POLICY, timeZone: 'UTC', generatedAt: 0, strings, rebuilt, unticked });
    const bodies = doc.emails.map((e) => squash(bodyOf(e)));
    const ticked = new Set(positions);
    out.messages.forEach((m, position) =>
    {
        const name = m.message.subject.replace(/ subject$/u, '');
        const sentence = squash(sentenceOf(name));
        const times = bodies.filter((b) => b.includes(sentence)).length;
        if (ticked.has(position))
        {
            tally.checked++;
            if (m.message.source.attachedPath !== undefined || m.duplicates.some((d) => d.source.attachedPath !== undefined))
            {
                tally.attachedChecked++;
            }
            if (times === 0)
            {
                tally.failures.push(`${where}: ${name} (ticked) printed nowhere`);
            }
            if (times > 1)
            {
                tally.twice++;
            }
        }
        else
        {
            tally.unticked++;
            if (times !== 0)
            {
                tally.failures.push(`${where}: ${name} (unticked) printed ${String(times)} times`);
            }
        }
    });
}

/** The real overlap detector, told nothing about which email holds which (the engine fix of M1 undone). */
const NO_HOLDS: EngineParts = {
    ...DEFAULT_PARTS,
    detectQuotedOverlap: (messages) => detectQuotedOverlap(messages.map((m) => ({ bodyText: m.bodyText, messageId: m.messageId, inReplyTo: m.inReplyTo, references: m.references, index: m.index }))),
};

describe('collapse, never delete, with attached emails: random cases (task 8.13b-3, review round 2)', () =>
{
    it('every ticked email\'s own text is printed at least once, an unticked one nowhere (1000 random cases)', async () =>
    {
        const tally: Tally = { checked: 0, twice: 0, unticked: 0, attachedChecked: 0, failures: [] };
        let withAttached = 0;
        for (let seed = 1; seed <= 1000; seed++)
        {
            const random = makeRandom(seed);
            const c = randomCase(random, seed);
            const out = runEngine(await parseAll(c.files));
            if ((out.attached?.length ?? 0) > 0)
            {
                withAttached++;
            }
            check(out, random, `seed ${String(seed)}`, tally);
        }
        console.log(`attached random cases: 1000 cases (${String(withAttached)} with attached emails), ${String(tally.checked)} ticked emails checked (${String(tally.attachedChecked)} attached), ${String(tally.unticked)} unticked, printed twice: ${String(tally.twice)}`);
        expect(tally.failures.slice(0, 10)).toEqual([]);
        expect(tally.twice).toBe(0);
        // The cases must really exercise attached emails.
        expect(withAttached).toBeGreaterThan(500);
        expect(tally.attachedChecked).toBeGreaterThan(1000);
        expect(tally.unticked).toBeGreaterThan(300);
    }, 120_000);

    it('the no-repeat rule\'s safety net alone (holder links ignored by the overlap detector) still prints every ticked email\'s own text at least once', async () =>
    {
        const tally: Tally = { checked: 0, twice: 0, unticked: 0, attachedChecked: 0, failures: [] };
        for (let seed = 1; seed <= 400; seed++)
        {
            const random = makeRandom(seed);
            const c = randomCase(random, seed);
            const out = runEngine(await parseAll(c.files), NO_HOLDS);
            check(out, random, `seed ${String(seed)} (no holds)`, tally);
        }
        console.log(`attached random cases, safety net alone: 400 cases, ${String(tally.checked)} ticked emails checked, printed twice: ${String(tally.twice)}`);
        expect(tally.failures.slice(0, 10)).toEqual([]);
        // Printing twice would be allowed here (never nowhere). Since review round 4 (M1) the holder keeps
        // exactly what the attached email's page leaves out, so the count is reported, not required.
    }, 120_000);
});
