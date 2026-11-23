// Random tests of collapse, never delete with emails attached inside dropped
// files (task 8.13b-3, review round 2, finding M1). Seeded random .eml files
// (so every run is the same) are read by the real .eml parser and run
// through the real thread analysis, output plan and PDF model with "Print full
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
// - the no-repeat rule alone (Source/pdf-export/build-pdf-document.ts, blockClaims: only what an
//   attached email's page prints is left out of the email holding it,
//   review round 4), with an overlap detector that ignores the holder links
//   (`holds`, Source/thread-analysis/overlap-quote-detection.ts): still at least once.
// Synthetic data only: made-up names, *.test addresses (README.md, rule R7).

import { describe, expect, it } from 'vitest';
import { DEFAULT_THREAD_ANALYSIS_PARTS, analyzeThread, type ThreadAnalysisParts } from '../thread-analysis/analyze-thread';
import { detectQuotedOverlap } from '../thread-analysis/overlap-quote-detection';
import { DEFAULT_OUTPUT_POLICY, planOutput } from '../thread-analysis/output-plan';
import { createEmlParser } from '../email-reading/eml-parser';
import type { HtmlToTextResult } from '../email-reading/html-to-text';
import { rebuiltEntries } from '../web-page-logic/rebuilt-email-display';
import { buildPdfDocument } from './build-pdf-document';
import { createPdfStrings } from './pdf-strings';
import { lineText } from './pdf-text-transforms';
import type { ParseResult } from '../../Header/parsed-email';
import type { PdfDocument, PdfEmail } from '../../Header/pdf-document-model';
import type { ThreadAnalysisResult } from '../../Header/thread-analysis-result';

/** mulberry32: a tiny seeded generator, returns numbers in [0, 1). */
function makeRandom(seed: number): () => number
{
    let state = seed >>> 0;
    return () =>
    {
        state = (state + 0x6d2b79f5) >>> 0;
        let bits = state;
        bits = Math.imul(bits ^ (bits >>> 15), bits | 1);
        bits ^= bits + Math.imul(bits ^ (bits >>> 7), bits | 61);
        return ((bits ^ (bits >>> 14)) >>> 0) / 4294967296;
    };
}

const crlf = (...lines: string[]): string => lines.join('\r\n');
const stub = (html: string): HtmlToTextResult => ({ text: `[html ${String(html.length)}]`, truncated: false });
const emlParser = createEmlParser({ htmlToText: stub });
const strings = createPdfStrings('en');

const plain = (text: string): string => crlf('Content-Type: text/plain; charset=utf-8', '', text);
const mixed = (boundary: string, ...parts: string[]): string =>
    crlf(`Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts.flatMap((p) => [`--${boundary}`, p]), `--${boundary}--`, '');
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
    let hash = 0;
    for (const character of name)
    {
        hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
    }
    const words = Array.from({ length: 10 }, (_, k) => WORDS[(hash >>> (k * 3)) % WORDS.length]!);
    return `Own words of ${name}: the ${words.join(' ')} were checked again this week.`;
}

/** The .eml text of `spec` (its attached emails inside it). */
function emlOf(spec: Spec): string
{
    const head = [
        `From: ${spec.name} <${spec.name}@example.test>`,
        'To: Team <team@example.test>',
        ...(spec.date === null ? [] : [`Date: ${spec.date}`]),
        `Subject: ${spec.name} subject`,
        `Message-ID: <${spec.name}@example.test>`,
        ...(spec.inReplyTo === null ? [] : [`In-Reply-To: <${spec.inReplyTo}@example.test>`]),
        'MIME-Version: 1.0',
    ];
    if (spec.children.length === 0)
    {
        return crlf(...head, 'Content-Type: text/plain; charset=utf-8', '', sentenceOf(spec.name));
    }
    return crlf(...head,
        mixed(`b-${spec.name}`, plain(sentenceOf(spec.name)), ...spec.children.map((c) => rfc822(emlOf(c.spec), c.asFile, c.spec.name))));
}

function randomDate(random: () => number): string | null
{
    const kind = random();
    const hours = String(8 + Math.floor(random() * 10)).padStart(2, '0');
    const minutes = String(Math.floor(random() * 60)).padStart(2, '0');
    const day = 1 + Math.floor(random() * 3);
    const when = `${['Sun', 'Mon', 'Tue'][day - 1]!}, ${String(day)} Jun 2025 ${hours}:${minutes}:00`;
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

function randomCase(random: () => number, caseId: number): Case
{
    const all: Spec[] = [];
    const make = (depth: number): Spec =>
    {
        const spec: Spec = { name: `c${String(caseId)}e${String(all.length)}`, date: randomDate(random), inReplyTo: null, children: [] };
        all.push(spec);
        const kids = depth >= 3 ? 0 : Math.floor(random() * (depth === 0 ? 3 : 2.4));
        for (let k = 0; k < kids; k++)
        {
            spec.children.push({ spec: make(depth + 1), asFile: random() < 0.3 });
        }
        return spec;
    };
    const roots = Array.from({ length: 1 + Math.floor(random() * 2.5) }, () => make(0));
    // Random In-Reply-To links, to any email of the case (an attached one too, either way round).
    for (const spec of all)
    {
        if (random() < 0.4)
        {
            (spec as { inReplyTo: string | null }).inReplyTo = all[Math.floor(random() * all.length)]!.name;
        }
    }
    const files: string[] = roots.map(emlOf);
    // Copies: attached emails also dropped on their own, a whole file twice.
    for (const spec of all)
    {
        if (!roots.includes(spec) && random() < 0.25)
        {
            files.push(emlOf(spec));
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
    return Promise.all(files.map((text, k) => emlParser.parse({ name: `f${String(k)}.eml`, bytes: new TextEncoder().encode(text) })));
}

interface Tally
{
    checked: number;
    twice: number;
    unticked: number;
    attachedChecked: number;
    failures: string[];
}

/** Builds the folded PDF of a random selection of `result` and checks every email's own sentence. */
function check(result: ThreadAnalysisResult, random: () => number, where: string, tally: Tally): void
{
    const positions = result.messages.map((_, k) => k).filter(() => random() < 0.75);
    const plans = planOutput(
        positions.map((p) => result.messages[p]!),
        DEFAULT_OUTPUT_POLICY,
    );
    const ids = rebuiltEntries(result).map((r) => r.id);
    const rebuilt = ids.filter(() => random() < 0.5);
    const unticked = ids.filter((id) => !rebuilt.includes(id));
    const pdfDocument: PdfDocument = buildPdfDocument(
        { result, positions, plans, policy: DEFAULT_OUTPUT_POLICY, generatedOffsetMinutes: 0, generatedAt: 0, strings, rebuilt, unticked });
    const bodies = pdfDocument.emails.map((e) => squash(bodyOf(e)));
    const ticked = new Set(positions);
    result.messages.forEach((analyzedMessage, position) =>
    {
        const name = analyzedMessage.message.subject.replace(/ subject$/u, '');
        const sentence = squash(sentenceOf(name));
        const times = bodies.filter((b) => b.includes(sentence)).length;
        if (ticked.has(position))
        {
            tally.checked++;
            if (analyzedMessage.message.source.attachedPath !== undefined
                || analyzedMessage.duplicates.some((d) => d.source.attachedPath !== undefined))
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

/** The real overlap detector, told nothing about which email holds which (the thread analysis fix of M1 undone). */
const NO_HOLDS: ThreadAnalysisParts = {
    ...DEFAULT_THREAD_ANALYSIS_PARTS,
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
            const testCase = randomCase(random, seed);
            const result = analyzeThread(await parseAll(testCase.files));
            if ((result.attached?.length ?? 0) > 0)
            {
                withAttached++;
            }
            check(result, random, `seed ${String(seed)}`, tally);
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
            const testCase = randomCase(random, seed);
            const result = analyzeThread(await parseAll(testCase.files), NO_HOLDS);
            check(result, random, `seed ${String(seed)} (no holds)`, tally);
        }
        console.log(`attached random cases, safety net alone: 400 cases, ${String(tally.checked)} ticked emails checked, printed twice: ${String(tally.twice)}`);
        expect(tally.failures.slice(0, 10)).toEqual([]);
        // Printing twice would be allowed here (never nowhere). Since review round 4 (M1) the holder keeps
        // exactly what the attached email's page leaves out, so the count is reported, not required.
    }, 120_000);
});
