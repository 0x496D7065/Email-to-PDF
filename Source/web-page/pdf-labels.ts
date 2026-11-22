// Step 2: works out what the PDF will leave out, for the preview's labels
// (Source/web-page/preview.ts), and holds the "Print full original text (quoted
// replies and signatures included)" checkbox (OutputPolicy.unfoldEverything,
// off by default; user decision 2026-10-29, task 7.8c). Under the checkbox,
// a short visible note says what ticking it means: every email in full,
// quoted earlier emails included, so the same text may appear more than
// once; unticked gives a cleaner PDF. The note is the checkbox's
// description (aria-describedby), so a screen reader reads it with the
// checkbox. While it is ticked, the "Rebuild conversation from replies"
// switch is unticked and disabled and no rebuilt email is shown or printed
// (Source/web-page/review.ts, Source/pdf-export/build-pdf-document.ts).
//
// The plans are the PDF's own: planOutput's rules (planOutputSteps,
// Source/thread-analysis/output-plan.ts) on the INCLUDED emails, in list order, with the
// current policy. The PDF step uses the same plans (currentPlans) and the
// same policy (getPdfPolicy), so the preview shows exactly what the PDF does.
//
// When they are worked out again: a new result (files added), an email
// ticked or unticked (which signature comes "first" can change, and which
// quoted emails are in the PDF), the list finished (an email the page could
// not decorate then counts as included, see Source/web-page/review.ts), the checkbox.
// Each time (Source/web-page/mount-page.ts calls show / refresh):
// - the labels are hidden at once (preview.setPdfPlans(null)), so a label
//   that may be wrong is never shown; ticking an email back so that the
//   inputs are those of the plans already made shows those plans again;
// - after a short pause (DEBOUNCE_MS, so ticking several emails in a row
//   works the plans out once), the plans are made one email at a time, in
//   tasks of about SLICE_MS each, so the page never freezes. 2000 emails
//   take about 0.2 to 0.6 s of work in total, spread over many tasks;
// - when done, and only if the inputs did not change meanwhile, the preview
//   gets them (and applies them in chunks of its own). A newer change
//   cancels the work in progress.
// Why on the page and not in the thread-analysis worker: the plans need the emails,
// which are already here; sending thousands of emails to a worker on each
// tick would cost about as much as working the plans out, and the worker is
// stopped once its run is over. Short slices keep the page responsive.
//
// Printed as an email of its own (task 8.11): with the checkbox unticked,
// the PDF also leaves out of a body the parts it prints as emails of their
// own (the no-repeat rule of Source/pdf-export/build-pdf-document.ts, task 8.10), which depends on
// the rebuilt emails chosen too (`includedRebuilt`, Source/web-page/review.ts) and
// on those the reader unticked (`untickedRebuilt`, task 8.13a, Q2). The
// views handed to the preview carry that cut (pdfRanges), worked out by the
// PDF model's own functions (Source/web-page-logic/printed-elsewhere.ts) from the
// same input the PDF step gets. It is worked out again each time plans are
// handed over, and on rebuiltChanged() (the switch or a rebuilt card
// changed: the plans stay, only the cut changes). If it fails, the labels
// are reported as failed (never a label that may be wrong).
//
// Memory only (README.md, rule R5): the checkbox, the policy and the plans
// live in this page; reset() ("Clear everything") unticks the checkbox and
// drops every plan.

import { DEFAULT_OUTPUT_POLICY, planOutputSteps } from '../thread-analysis/output-plan';
import { signatureSources } from '../web-page-logic/pdf-plan';
import { pdfCut } from '../web-page-logic/printed-elsewhere';
import { createSafeElement } from './safe-dom';
import { createStaticLabels } from './static-labels';
import type { PreviewPdfPlans } from './preview';
import type { MessagePlan, OutputPolicy } from '../../Header/output-plan';
import type { PdfView, PlannedEmail } from '../../Header/pdf-plan';
import type { AnalyzedMessage, ThreadAnalysisResult } from '../../Header/thread-analysis-result';

/** Pause after a change before the plans are worked out (ms). */
export const DEBOUNCE_MS = 150;
/** About how long one task of planning may run (ms) before it lets the page breathe. */
export const SLICE_MS = 12;

/** The PDF plans of the included emails, as the PDF step needs them. */
export interface PdfPlans
{
    readonly result: ThreadAnalysisResult;
    readonly policy: OutputPolicy;
    /** List positions of the included emails, in list order (a position without an email is not in it). */
    readonly positions: readonly number[];
    /** One plan per position, same order. */
    readonly plans: readonly MessagePlan[];
}

export interface PdfLabelsOptions
{
    /** The included emails' list positions, in list order (Source/web-page/review.ts). */
    readonly includedPositions: () => readonly number[];
    /** Hands the plans to the preview (null: hide the labels). */
    readonly setPdfPlans: (plans: PreviewPdfPlans | null) => void;
    /** Tells the preview the plans could not be made. */
    readonly failed: () => void;
    /** Runs a task later (default: setTimeout). Returns a handle for `cancel`. */
    readonly schedule?: (task: () => void, delayMs: number) => unknown;
    readonly cancel?: (handle: unknown) => void;
    /** A clock in ms (default: performance.now). */
    readonly now?: () => number;
    /** Called after the user ticked or unticked the checkbox (Source/web-page/mount-page.ts: a PDF made before is dropped). */
    readonly onPolicyChange?: () => void;
    /**
     * Ids of the rebuilt emails the PDF gets (Source/web-page/review.ts,
     * includedRebuilt), for the no-repeat labels (see the top). Default: none.
     */
    readonly includedRebuilt?: () => readonly number[];
    /**
     * True while "Rebuild conversation from replies" is off (Source/web-page/review.ts,
     * rebuiltShown false): no rebuilt email counts as unticked, so no
     * forwarded part is left out for it (task 8.13a, Q2). Default: false.
     */
    readonly rebuildingOff?: () => boolean;
    /**
     * Ids of the rebuilt emails whose card the reader unticked
     * (Source/web-page/review.ts, untickedRebuilt), the same as the PDF step gets: only
     * their forwarded parts are left out (task 8.13a review round 2). Default:
     * none (an entry merely not chosen is never taken for unticked).
     */
    readonly untickedRebuilt?: () => readonly number[];
}

export interface PdfLabels
{
    /** The checkbox field and its note, for the preview's toolbar. */
    readonly element: HTMLDivElement;
    /** A new result is shown (null: none). */
    show(result: ThreadAnalysisResult | null): void;
    /** The included emails may have changed: works the plans out again if needed. */
    refresh(): void;
    /** For "Clear everything": unticks the checkbox, cancels the work, drops the plans. */
    reset(): void;
    /** The policy the PDF must use. */
    getPdfPolicy(): OutputPolicy;
    /** The plans of the current inputs, or null while they are being worked out (or there are none). */
    currentPlans(): PdfPlans | null;
    /** Writes the checkbox's label and note again in the page language (the plans do not depend on it). */
    relabel(): void;
    /** The rebuilt emails chosen changed: the plans in use go to the preview again with the new no-repeat cut (see the top). */
    rebuiltChanged(): void;
}

/** The input of one planning: everything the plans depend on. */
interface Inputs
{
    readonly result: ThreadAnalysisResult;
    readonly policy: OutputPolicy;
    readonly positions: readonly number[];
    readonly key: string;
}

export function createPdfLabels(options: PdfLabelsOptions): PdfLabels
{
    const schedule = options.schedule ?? ((task: () => void, delayMs: number): unknown => setTimeout(task, delayMs));
    const cancel = options.cancel ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));
    const now = options.now ?? ((): number => performance.now());

    // --- State (memory only, README.md, rule R5) ------------------------------
    let result: ThreadAnalysisResult | null = null;
    // The last plans made, and whether they match the current inputs.
    let made: { readonly inputs: Inputs; readonly plans: PdfPlans; readonly preview: PreviewPdfPlans } | null = null;
    let upToDate = false;
    // The planning waiting or in progress.
    let job: { readonly inputs: Inputs; handle: unknown } | null = null;

    const labels = createStaticLabels();
    const checkbox = createSafeElement('input', { attrs: { type: 'checkbox', id: 'pdf-everything', 'aria-describedby': 'pdf-everything-note' } });
    const element = createSafeElement('div', {
        attrs: { class: 'field field-everything' },
        children: [
            createSafeElement('div', {
                attrs: { class: 'field-checkbox' },
                children: [checkbox, labels.text(createSafeElement('label', { attrs: { for: 'pdf-everything' } }), 'pdf.everything')],
            }),
            labels.text(createSafeElement('p', { attrs: { id: 'pdf-everything-note', class: 'field-note' } }), 'pdf.everythingNote'),
        ],
    });

    function policy(): OutputPolicy
    {
        return Object.freeze({ ...DEFAULT_OUTPUT_POLICY, unfoldEverything: checkbox.checked });
    }

    function inputsNow(analysisResult: ThreadAnalysisResult): Inputs
    {
        const outputPolicy = policy();
        const positions = [...options.includedPositions()];
        const key = `${outputPolicy.appQuotedHistory}|${outputPolicy.signatures}|${outputPolicy.unfoldEverything ? 'all' : ''}|${positions.join(',')}`;
        return { result: analysisResult, policy: outputPolicy, positions, key };
    }

    function stopJob(): void
    {
        if (job !== null)
        {
            cancel(job.handle);
        }
        job = null;
    }

    /**
     * The plans for the preview and for the PDF step. `planned` and `plans`
     * are in the same order (plans[k] is the plan of planned[k]); if their
     * lengths differ (a bug), nothing is shown rather than a label of another
     * email.
     */
    function finish(inputs: Inputs, planned: readonly PlannedEmail[], plans: MessagePlan[]): void
    {
        if (plans.length !== planned.length)
        {
            options.failed();
            return;
        }
        const sources = signatureSources(planned, plans);
        const views = new Map<number, PdfView>();
        planned.forEach(({ position }, k) =>
        {
            const plan = plans[k];
            if (plan !== undefined)
            {
                views.set(position, { plan, signatureFrom: sources.get(position) ?? new Map() });
            }
        });
        const preview: PreviewPdfPlans = { result: inputs.result, views };
        const positions = planned.map((e) => e.position);
        made = { inputs, plans: { result: inputs.result, policy: inputs.policy, positions, plans }, preview };
        upToDate = true;
        handOver(made);
    }

    /**
     * The views of `madePlans` with the no-repeat cut of the PDF (see the top): the
     * same input as the PDF step (Source/web-page/mount-page.ts, pdfInput), with the rebuilt
     * emails chosen now.
     */
    function withCut(madePlans: NonNullable<typeof made>): PreviewPdfPlans
    {
        if (madePlans.plans.policy.unfoldEverything)
        {
            return madePlans.preview;
        }
        const rebuilt = [...(options.includedRebuilt?.() ?? [])];
        const unticked = [...(options.untickedRebuilt?.() ?? [])];
        const { ranges: cut, rebuiltPlans } = pdfCut({ ...madePlans.plans, rebuilt, rebuildingOff: options.rebuildingOff?.() === true, unticked });
        // The signature plans of the rebuilt cards in the PDF (task 9.9b-2): the labels of their folds.
        const rebuiltViews = new Map<number, PdfView>();
        for (const [id, plan] of rebuiltPlans)
        {
            rebuiltViews.set(id, { plan, signatureFrom: new Map() });
        }
        const withRebuilt = (preview: PreviewPdfPlans): PreviewPdfPlans => (rebuiltViews.size === 0 ? preview : { ...preview, rebuiltViews });
        if (cut.size === 0)
        {
            return withRebuilt(madePlans.preview);
        }
        const views = new Map(madePlans.preview.views);
        for (const [position, pdfRanges] of cut)
        {
            const view = views.get(position);
            if (view !== undefined)
            {
                views.set(position, { ...view, pdfRanges });
            }
        }
        return withRebuilt({ result: madePlans.preview.result, views });
    }

    /** Hands the plans of `madePlans` to the preview, with the no-repeat cut; if that cannot be worked out, the labels fail (never a wrong one). */
    function handOver(madePlans: NonNullable<typeof made>): void
    {
        let preview: PreviewPdfPlans;
        try
        {
            preview = withCut(madePlans);
        }
        catch
        {
            options.failed();
            return;
        }
        options.setPdfPlans(preview);
    }

    /** Works the plans out for `inputs`, in slices, after the pause. */
    function start(inputs: Inputs): void
    {
        stopJob();
        // The included emails that exist (a position without an email, a bug, is
        // skipped here once): the plans are made from this list and matched back
        // to it in the same order, so plans[k] always belongs to planned[k].
        const planned: PlannedEmail[] = [];
        const messages: AnalyzedMessage[] = [];
        for (const position of inputs.positions)
        {
            const email = inputs.result.messages[position];
            if (email === undefined)
            {
                continue;
            }
            planned.push({ message: email.message, position });
            messages.push(email);
        }
        let steps: Generator<MessagePlan, void, undefined> | null = null;
        const plans: MessagePlan[] = [];
        const mine = { inputs, handle: null as unknown };
        const slice = (): void =>
        {
            if (job !== mine)
            {
                return; // cancelled or replaced meanwhile
            }
            try
            {
                steps ??= planOutputSteps(messages, inputs.policy);
                const until = now() + SLICE_MS;
                for (;;)
                {
                    const step = steps.next();
                    if (step.done === true)
                    {
                        break;
                    }
                    plans.push(step.value);
                    if (now() >= until)
                    {
                        mine.handle = schedule(slice, 0);
                        return;
                    }
                }
            }
            catch
            {
                // Not expected (planOutput keeps a bad email whole instead of throwing).
                job = null;
                options.failed();
                return;
            }
            job = null;
            // Defensive: the inputs changed without a refresh(): start again.
            if (result !== inputs.result || inputsNow(inputs.result).key !== inputs.key)
            {
                refresh();
                return;
            }
            finish(inputs, planned, plans);
        };
        job = mine;
        mine.handle = schedule(slice, DEBOUNCE_MS);
    }

    function refresh(): void
    {
        if (result === null)
        {
            stopJob();
            upToDate = false;
            options.setPdfPlans(null);
            return;
        }
        const inputs = inputsNow(result);
        if (made !== null && made.inputs.result === result && made.inputs.key === inputs.key)
        {
            // Back to the inputs of the plans already made (an email ticked back): shown again at once.
            stopJob();
            if (!upToDate)
            {
                upToDate = true;
                // The rebuilt emails chosen may have changed meanwhile: the cut is worked out again.
                handOver(made);
            }
            return;
        }
        if (job !== null && job.inputs.result === result && job.inputs.key === inputs.key)
        {
            return; // already on its way
        }
        upToDate = false;
        options.setPdfPlans(null);
        start(inputs);
    }

    checkbox.addEventListener('change', () =>
    {
        refresh();
        try
        {
            options.onPolicyChange?.();
        }
        catch
        {
            // The labels follow the checkbox either way.
        }
    });

    return {
        element,
        show(next)
        {
            if (next === result)
            {
                return;
            }
            result = next;
            made = null;
            upToDate = false;
            refresh();
        },
        refresh,
        reset()
        {
            stopJob();
            result = null;
            made = null;
            upToDate = false;
            checkbox.checked = false;
            options.setPdfPlans(null);
        },
        getPdfPolicy: policy,
        currentPlans: () => (upToDate && made !== null && made.inputs.result === result ? made.plans : null),
        relabel: () => labels.relabel(),
        rebuiltChanged()
        {
            // Only plans in use go again; plans on their way get the new choice when they are handed over.
            if (upToDate && made !== null && made.inputs.result === result)
            {
                handOver(made);
            }
        },
    };
}
