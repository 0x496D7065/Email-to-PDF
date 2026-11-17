// Unit tests for the PDF labels' planning (pdf-labels.ts), in Node with the
// recording fake DOM (tests/support/fake-dom.ts), a hand-run task queue and
// a fake clock. Synthetic messages only, run through the real engine and the
// real plan. The wiring with the page and the preview is tested in
// page.test.ts, the real page in e2e/pdf-labels.spec.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDocument, FakeElement } from '../../tests/support/fake-dom';
import { buildThread, instantOf } from '../../tests/support/thread-builder';
import { THREAD_CASES } from '../../tests/support/thread-cases';
import { printedElsewhereRanges } from '../ui-model/printed-elsewhere';
import { rebuiltEntries } from '../ui-model/rebuilt';
import { runEngine, type EngineResult } from '../engine/engine';
import { DEFAULT_OUTPUT_POLICY, planOutput } from '../engine/output-plan';
import type { EmailAddress, NormalizedMessage, ParseResult } from '../parsing/types';
import { setLocale } from './i18n';
import { en } from './i18n/en';
import { fr } from './i18n/fr';
import { DEBOUNCE_MS, SLICE_MS, createPdfLabels, type PdfLabels } from './pdf-labels';
import type { PreviewPdfPlans } from './preview';

const ALICE: EmailAddress = { name: 'Alice Example', address: 'alice@example.test' };
const BOB: EmailAddress = { name: 'Bob Sample', address: 'bob@example.test' };
const SIGNATURE = '\n-- \nAlice Example\nGarden Benches (fictional company)\n';

let counter = 0;
function make(from: EmailAddress, bodyText: string): NormalizedMessage
{
    counter++;
    return {
        messageId: `pl${String(counter)}@example.test`,
        inReplyTo: null,
        references: [],
        date: { utcMs: Date.parse('2025-03-03T08:15:00Z') + counter * 3_600_000, original: 'synthetic', offsetMinutes: 0, zoneKnown: true },
        from: [from],
        to: [],
        cc: [],
        bcc: [],
        subject: `Bench ${String(counter)}`,
        bodyText,
        attachments: [],
        source: { fileName: `pl-${String(counter)}.eml`, sha256: (5000 + counter).toString(16).padStart(64, '0'), kind: 'eml' },
        warnings: [],
    };
}
const engineOf = (messages: readonly NormalizedMessage[]): EngineResult =>
    runEngine(messages.map((message): ParseResult => ({ ok: true, message })));
/** Alice twice with the same signature, Bob in between. */
const threeEmails = (): EngineResult =>
    engineOf([make(ALICE, `The bench is green.\n${SIGNATURE}`), make(BOB, 'Thanks, noted.\n'), make(ALICE, `The bench is delivered.\n${SIGNATURE}`)]);

// ------------------------------------------------------------------ harness

let tasks: { task: () => void; delay: number; handle: number }[];
let clock: number;
let applied: (PreviewPdfPlans | null)[];
let failures: number;
let included: number[];
let rebuiltChosen: () => readonly number[];
/** The rebuilt cards the reader unticked (task 8.13a review round 2). */
let rebuiltUnticked: () => readonly number[];
/** "Rebuild conversation from replies" off (task 8.13a, Q2). */
let switchOff: boolean;
let labels: PdfLabels;

function mount(): void
{
    tasks = [];
    clock = 0;
    applied = [];
    failures = 0;
    let next = 0;
    labels = createPdfLabels({
        includedPositions: () => included,
        includedRebuilt: () => rebuiltChosen(),
        rebuildingOff: () => switchOff,
        untickedRebuilt: () => rebuiltUnticked(),
        setPdfPlans: (plans) => applied.push(plans),
        failed: () => failures++,
        schedule: (task, delay) =>
        {
            const handle = ++next;
            tasks.push({ task, delay, handle });
            return handle;
        },
        cancel: (handle) =>
        {
            tasks = tasks.filter((x) => x.handle !== handle);
        },
        // Every reading of the clock moves it on 5 ms: a slice ends after a few emails.
        now: () => (clock += 5),
    });
}

/** Runs the queued tasks until none is left; returns how many ran. */
function runAll(): number
{
    let ran = 0;
    while (tasks.length > 0)
    {
        tasks.shift()?.task();
        ran++;
    }
    return ran;
}

const last = (): PreviewPdfPlans | null | undefined => applied.at(-1);
/** The first element of the checkbox field (checkbox, label, note) with this tag. */
const part = (tag: string): FakeElement | undefined => (labels.element as unknown as FakeElement).descendants().find((c) => c.tagName === tag);
const checkbox = (): FakeElement => part('input')!;

beforeEach(() =>
{
    vi.stubGlobal('document', new FakeDocument());
    included = [];
    rebuiltChosen = () => [];
    rebuiltUnticked = () => [];
    switchOff = false;
    mount();
});

afterEach(() =>
{
    labels.reset();
    vi.unstubAllGlobals();
});

// ------------------------------------------------------------------ tests

describe('createPdfLabels', () =>
{
    it('has a labelled checkbox, unticked, and the default policy', () =>
    {
        const box = checkbox();
        expect(box.getAttribute('type')).toBe('checkbox');
        expect(box.getAttribute('id')).toBe('pdf-everything');
        const label = part('label');
        expect(label?.getAttribute('for')).toBe('pdf-everything');
        expect(label?.textContent).toBe('Print full original text (quoted replies and signatures included)');
        expect(box.checked).toBe(false);
        expect(labels.getPdfPolicy()).toEqual(DEFAULT_OUTPUT_POLICY);
        expect(labels.currentPlans()).toBeNull();
    });

    it('has a visible note under the checkbox, read with it, and relabelled with the page (tasks 7.8b, 7.8c)', () =>
    {
        const note = part('p');
        expect(note?.getAttribute('id')).toBe('pdf-everything-note');
        expect(note?.getAttribute('hidden')).toBeNull();
        expect(checkbox().getAttribute('aria-describedby')).toBe('pdf-everything-note');
        expect(note?.textContent).toBe(en.pdf.everythingNote);
        // What it must say (user decision 2026-10-29: the first part only, nothing about rebuilt emails).
        expect(note?.textContent).toContain('more than once');
        expect(note?.textContent).toContain('cleaner PDF');
        expect(note?.textContent).not.toMatch(/rebuilt/i);
        setLocale('fr');
        try
        {
            labels.relabel();
            expect(note?.textContent).toBe(fr.pdf.everythingNote);
            expect(part('label')?.textContent).toBe(fr.pdf.everything);
        }
        finally
        {
            setLocale('en');
        }
    });

    it('hides the labels at once, then gives the plans of the included emails, after a pause', () =>
    {
        const result = threeEmails();
        included = [0, 1, 2];
        labels.show(result);
        expect(applied).toEqual([null]);
        expect(tasks).toHaveLength(1);
        expect(tasks[0]?.delay).toBe(DEBOUNCE_MS);
        expect(labels.currentPlans()).toBeNull();
        runAll();
        const plans = last();
        expect(plans?.result).toBe(result);
        expect([...(plans?.views.keys() ?? [])]).toEqual([0, 1, 2]);
        // The very same plans as planOutput (the PDF's own function) gives.
        const expected = planOutput(result.messages);
        expect([0, 1, 2].map((p) => plans?.views.get(p)?.plan)).toEqual(expected);
        // "Same signature as in email #1".
        const repeated = expected[2]?.ranges.find((r) => r.reason === 'repeated-signature');
        expect(plans?.views.get(2)?.signatureFrom.get(repeated?.start ?? -1)).toBe(1);
        expect(labels.currentPlans()).toMatchObject({ result, positions: [0, 1, 2], plans: expected, policy: DEFAULT_OUTPUT_POLICY });
    });

    it('a position without an email (a bug) is skipped without shifting the plans of the others', () =>
    {
        const result = threeEmails();
        included = [0, 7, 2];
        labels.show(result);
        runAll();
        const plans = last();
        expect([...(plans?.views.keys() ?? [])]).toEqual([0, 2]);
        // Email #3 gets its own plan (the one planOutput makes for emails #1 and #3), not a shifted one.
        const expected = planOutput([result.messages[0]!, result.messages[2]!]);
        expect(plans?.views.get(0)?.plan).toEqual(expected[0]);
        expect(plans?.views.get(2)?.plan).toEqual(expected[1]);
        const repeated = expected[1]?.ranges.find((r) => r.reason === 'repeated-signature');
        expect(repeated).toBeDefined();
        expect(plans?.views.get(2)?.signatureFrom.get(repeated?.start ?? -1)).toBe(1);
        // The PDF step gets the same pairs: positions[k] goes with plans[k].
        expect(labels.currentPlans()).toMatchObject({ positions: [0, 2], plans: expected });
    });

    it('works in short slices, so a big batch never blocks the page', () =>
    {
        const messages: NormalizedMessage[] = [];
        for (let k = 0; k < 60; k++)
        {
            messages.push(make(k % 2 === 0 ? ALICE : BOB, `Note ${String(k)} about the benches.\n${SIGNATURE}`));
        }
        const result = engineOf(messages);
        included = result.messages.map((_, p) => p);
        labels.show(result);
        // Each email reads the clock once (5 ms): about SLICE_MS / 5 emails per task.
        const ran = runAll();
        expect(ran).toBeGreaterThanOrEqual(Math.floor(60 / Math.ceil(SLICE_MS / 5)));
        expect(last()?.views.size).toBe(60);
    });

    it('an untick changes which signature is first; labels are hidden until the new plans are ready', () =>
    {
        const result = threeEmails();
        included = [0, 1, 2];
        labels.show(result);
        runAll();
        const before = last();
        expect(before?.views.get(2)?.plan.ranges.some((r) => r.reason === 'repeated-signature' && !r.keep)).toBe(true);

        included = [1, 2]; // #1 unticked
        labels.refresh();
        expect(last()).toBeNull(); // hidden at once: never a stale label
        expect(labels.currentPlans()).toBeNull();
        runAll();
        const after = last();
        expect([...(after?.views.keys() ?? [])]).toEqual([1, 2]);
        expect(after?.views.get(2)?.plan.ranges.some((r) => r.reason === 'signature' && r.keep)).toBe(true);
        expect(after?.views.get(2)?.signatureFrom.size).toBe(0);
        expect(labels.currentPlans()?.positions).toEqual([1, 2]);

        // Ticked back: the inputs of plans already made would be shown again once
        // new plans are made; here the last plans are for [1, 2], so it plans again.
        included = [0, 1, 2];
        labels.refresh();
        expect(last()).toBeNull();
        runAll();
        expect(last()?.views.get(2)?.plan).toEqual(before?.views.get(2)?.plan);
    });

    it('ticking back before the new plans are made shows the plans already made, without planning again', () =>
    {
        const result = threeEmails();
        included = [0, 1, 2];
        labels.show(result);
        runAll();
        const made = last();
        included = [1, 2];
        labels.refresh();
        expect(last()).toBeNull();
        included = [0, 1, 2];
        labels.refresh();
        expect(last()).toBe(made);
        expect(tasks).toHaveLength(0); // the planning for [1, 2] was cancelled
        expect(labels.currentPlans()?.positions).toEqual([0, 1, 2]);
    });

    it('a newer change cancels the planning in progress; nothing changes for the same inputs', () =>
    {
        const result = threeEmails();
        included = [0, 1, 2];
        labels.show(result);
        labels.refresh(); // same inputs, already on its way
        expect(tasks).toHaveLength(1);
        expect(applied).toEqual([null]);
        included = [0, 2];
        labels.refresh();
        expect(tasks).toHaveLength(1);
        runAll();
        expect([...(last()?.views.keys() ?? [])]).toEqual([0, 2]);
        expect(applied.filter((a) => a !== null)).toHaveLength(1); // the cancelled planning gave nothing
        const count = applied.length;
        labels.refresh(); // nothing changed: nothing to do, the labels stay
        expect(applied).toHaveLength(count);
        expect(tasks).toHaveLength(0);
    });

    it('starts again if the inputs changed without a refresh (defensive)', () =>
    {
        const result = threeEmails();
        included = [0, 1, 2];
        labels.show(result);
        included = [0, 1];
        runAll();
        expect([...(last()?.views.keys() ?? [])]).toEqual([0, 1]);
    });

    it('the checkbox puts everything in the PDF: every range kept', () =>
    {
        const result = threeEmails();
        included = [0, 1, 2];
        labels.show(result);
        runAll();
        const box = checkbox();
        box.checked = true;
        box.fire('change');
        expect(last()).toBeNull();
        expect(labels.getPdfPolicy()).toEqual({ ...DEFAULT_OUTPUT_POLICY, unfoldEverything: true });
        runAll();
        for (const v of last()?.views.values() ?? [])
        {
            expect(v.plan.ranges.every((r) => r.keep)).toBe(true);
        }
        expect(labels.currentPlans()?.policy.unfoldEverything).toBe(true);
    });

    it('a new result drops the old plans; no result means no plans', () =>
    {
        const first = threeEmails();
        included = [0, 1, 2];
        labels.show(first);
        runAll();
        const second = threeEmails();
        labels.show(second);
        expect(last()).toBeNull();
        expect(labels.currentPlans()).toBeNull();
        runAll();
        expect(last()?.result).toBe(second);
        labels.show(null);
        expect(last()).toBeNull();
        expect(tasks).toHaveLength(0);
        expect(labels.currentPlans()).toBeNull();
    });

    it('reset (Clear everything): unticks the checkbox, stops the planning, drops the plans', () =>
    {
        const result = threeEmails();
        included = [0, 1, 2];
        labels.show(result);
        runAll();
        const box = checkbox();
        box.checked = true;
        box.fire('change');
        expect(tasks).toHaveLength(1);
        labels.reset();
        expect(box.checked).toBe(false);
        expect(tasks).toHaveLength(0);
        expect(last()).toBeNull();
        expect(labels.currentPlans()).toBeNull();
        expect(labels.getPdfPolicy()).toEqual(DEFAULT_OUTPUT_POLICY);
        // Shown again: planned from scratch with the defaults.
        labels.show(result);
        runAll();
        expect(labels.currentPlans()?.policy).toEqual(DEFAULT_OUTPUT_POLICY);
    });

    it('tells the preview when the plans cannot be made (not expected)', () =>
    {
        const result = threeEmails();
        // An email whose body cannot even be read: planOutput's own safety net cannot help.
        const broken = { ...result.messages[0]!, message: new Proxy(result.messages[0]!.message, { get: () =>
        {
            throw new Error('broken');
        } }) };
        const bad: EngineResult = { ...result, messages: [broken, ...result.messages.slice(1)] };
        included = [0, 1, 2];
        labels.show(bad);
        runAll();
        expect(failures).toBe(1);
        expect(labels.currentPlans()).toBeNull();
        expect(applied).toEqual([null]);
    });
});

describe('the no-repeat cut in the views (task 8.11)', () =>
{
    const FORWARD = THREAD_CASES.find((c) => c.id === 'gmail forward of an outlook thread')!;
    /** The forward of FORWARD alone: two earlier emails rebuilt from it. */
    function forwardAlone(): EngineResult
    {
        const m = FORWARD.messages![2]!;
        const utcMs = instantOf(m.sent, m.zone);
        return engineOf([
            { ...make(m.from, buildThread(FORWARD.messages!).body), to: [...m.to], subject: m.subject, date: { utcMs, original: new Date(utcMs).toUTCString(), offsetMinutes: m.zone.offsetMinutes, zoneKnown: true } },
        ]);
    }
    const printedAsOf = (plans: PreviewPdfPlans | null | undefined): unknown[] => (plans?.views.get(0)?.pdfRanges ?? []).flatMap((r) => (r.printedAs === null ? [] : [r.printedAs]));

    it('hands over the views with the PDF\'s cut for the rebuilt emails chosen; rebuiltChanged hands them over again without planning', () =>
    {
        const result = forwardAlone();
        const ids = rebuiltEntries(result).map((r) => r.id);
        expect(ids).toHaveLength(2);
        included = [0];
        rebuiltChosen = () => ids;
        labels.show(result);
        runAll();
        const plans = labels.currentPlans()!;
        expect(last()?.views.get(0)?.pdfRanges).toEqual(printedElsewhereRanges({ ...plans, rebuilt: ids }).get(0));
        const kinds = (): string[] => printedAsOf(last()).map((p) => `${(p as { kind: string }).kind} ${String((p as { id: number }).id)}`);
        expect(new Set(kinds())).toEqual(new Set(ids.map((id) => `rebuilt ${String(id)}`)));
        // One unticked: the same plans (no planning), the new cut; the unticked forwarded part is left out too (Q2, task 8.13a).
        rebuiltChosen = () => [ids[0]!];
        rebuiltUnticked = () => [ids[1]!];
        labels.rebuiltChanged();
        expect(tasks).toEqual([]);
        expect(labels.currentPlans()).toBe(plans);
        expect(new Set(kinds())).toEqual(new Set([`rebuilt ${String(ids[0])}`, `unticked ${String(ids[1])}`]));
        expect(last()?.views.get(0)?.pdfRanges).toEqual(printedElsewhereRanges({ ...plans, rebuilt: [ids[0]!], unticked: [ids[1]!] }).get(0));
        // One merely not chosen (not reported unticked, review round 2): its forwarded part stays, only the chosen one is cut.
        rebuiltUnticked = () => [];
        labels.rebuiltChanged();
        expect(new Set(kinds())).toEqual(new Set([`rebuilt ${String(ids[0])}`]));
        // None ticked: both forwarded parts left out, printed nowhere.
        rebuiltChosen = () => [];
        rebuiltUnticked = () => ids;
        labels.rebuiltChanged();
        expect(new Set(kinds())).toEqual(new Set(ids.map((id) => `unticked ${String(id)}`)));
        // None chosen and none reported unticked: nothing is cut.
        rebuiltUnticked = () => [];
        labels.rebuiltChanged();
        expect(last()?.views.get(0)?.pdfRanges).toBeUndefined();
        // The switch off: no rebuilt email is unticked, the plan's own ranges.
        rebuiltUnticked = () => ids;
        switchOff = true;
        labels.rebuiltChanged();
        expect(last()?.views.get(0)?.pdfRanges).toBeUndefined();
    });

    it('nothing is handed over while plans are on their way; they get the choice made by then', () =>
    {
        const result = forwardAlone();
        const ids = rebuiltEntries(result).map((r) => r.id);
        included = [0];
        labels.show(result);
        expect(applied).toEqual([null]);
        labels.rebuiltChanged();
        expect(applied).toEqual([null]);
        rebuiltChosen = () => ids;
        runAll();
        expect(printedAsOf(last()).length).toBeGreaterThan(0);
    });

    it('"Print full original text": no cut, the rebuilt emails are not even asked for', () =>
    {
        const result = forwardAlone();
        included = [0];
        let asked = 0;
        rebuiltChosen = () =>
        {
            asked++;
            return rebuiltEntries(result).map((r) => r.id);
        };
        checkbox().checked = true;
        checkbox().fire('change');
        labels.show(result);
        runAll();
        expect(last()?.views.get(0)?.pdfRanges).toBeUndefined();
        expect(asked).toBe(0);
    });

    it('a cut that cannot be worked out: the labels fail (never a label that may be wrong)', () =>
    {
        const result = forwardAlone();
        included = [0];
        rebuiltChosen = () =>
        {
            throw new Error('synthetic failure');
        };
        labels.show(result);
        runAll();
        expect(failures).toBe(1);
        expect(applied).toEqual([null]);
        // Working again: the next hand-over shows the labels.
        rebuiltChosen = () => [];
        labels.rebuiltChanged();
        expect(last()).not.toBeNull();
    });
});
