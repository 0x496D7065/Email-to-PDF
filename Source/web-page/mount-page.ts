// The whole page wired together: the shell (page-shell.ts), step 1 (add-files.ts),
// step 2 (preview.ts with review.ts around it), step 3 (download-step.ts)
// and "Clear everything". Source/main.ts only calls mountPage; this module is
// unit tested with the fake DOM (mount-page.test.ts) and in Chromium
// (Helper/Test/browser-tests/clear.spec.ts, Helper/Test/browser-tests/download.spec.ts).
//
// Results: step 1 hands each new result to step 2, the review FIRST, then
// the list (see showResultInStep2), then the PDF labels (Source/web-page/pdf-labels.ts),
// which are worked out again on each tick or untick and once the list is
// complete.
//
// Focus after a new result: the result rebuilds step 1's failed-files list
// and step 2's list, so a control the keyboard focus was on (an include
// checkbox, a "Technical details") may be gone, and the browser then puts
// the focus back on <body>, at the top of the page. Only in that case (the
// focus is on <body> AND the control it was last on is no longer in the
// page) the focus goes to step 1's "choose" button (where files are added,
// right above the new summary). Focus anywhere else is never moved, and
// neither is a focus on <body> that no removal caused: after the page
// loads, or after a mouse click on plain text (a mouse or touch press makes
// the page forget the control the focus was on), so a mouse
// user reading far down the list is not scrolled back up. The page keeps a
// reference only to that one control, and forgets it on "Clear everything".
// New PDF plans do not rebuild the list, only some emails' bodies: there the
// preview itself puts the focus back on the redrawn fold (Source/web-page/preview.ts),
// in the same task, so the focus never reaches <body> and this check, which
// runs on new results only, has nothing to do.
//
// Rebuilt emails (task 7.6): the review's switch sits in the preview's
// toolbar and the review decorates their cards (decorateRebuilt); a change
// of the switch or of a rebuilt card's checkbox drops a PDF made before and
// is announced (onRebuiltChange). The PDF shows the ones the review gives
// (review.includedRebuilt(), task 7.7: ticked, switch on, and an email they
// were read from in the PDF), at their place in time (Source/pdf-export/model.ts).
// While "Print full original text" is ticked, none of them is shown or in
// the PDF, and the switch is unticked and disabled (user decision
// 2026-10-29, task 7.8c): the review reads the PDF labels' policy
// (unfoldEverything); a change of that checkbox sets the switch and the
// cards again (everythingChanged), shows or hides every card
// (preview.refreshRebuilt) and announces the new rebuilt line. The PDF
// model leaves them out under that policy too (Source/pdf-export/model.ts).
//
// Step 3 makes the PDF from exactly the plans the labels show (pdfInput),
// and only once they are up to date (pdfUnavailable). Every change of what
// goes into the PDF drops a PDF made or being made (choicesChanged): files
// added, a new result, an email ticked or unticked, "Print full original
// text", the time zone, and new plans. So a PDF that no longer matches the
// page is never offered.
//
// "Clear everything" (README.md, rule R5: in memory only). The button is
// available as soon as files were added, also while they are being read and
// while the list is still being built. Pressing it:
// - step 1 (addFiles.reset): cancels the run still going, which terminates
//   its parse or engine worker at once (Source/worker-pipeline/process-files.ts) and
//   throws away anything it would still report; forgets every file, empties
//   the file input, the summary, the failed-files list and the notices, and
//   hides step 2;
// - step 2 (preview.reset, review.reset): empties the list, cancels the
//   chunks still waiting, puts the time zone and the "show quoted text"
//   checkbox back to their defaults, forgets every include choice and
//   empties the counts; (pdfLabels.reset) unticks "Print full original
//   text", stops the planning still going and drops every plan;
// - step 3 (download.reset): stops a PDF being made (its worker is
//   terminated), drops a finished one (its blob: URL is revoked, the
//   "Download again" link removed);
// - says "Everything was cleared." in the status line (the page's one live
//   region) and moves the focus to step 1's "choose" button, so a keyboard
//   or screen reader user is not left on a button that is now unavailable.
// No confirmation is asked: the user can simply add the files again. After
// it, nothing on the page holds the emails, their file names or the File
// objects, so the browser can free them. Reloading or closing the tab does
// the same, since nothing is ever stored (no storage, cookies or caches).
// This is the user's own, explicit action: nothing else ever drops text
// (README.md, rule R6).
//
// Language (setLanguage, called by the picker in the header, Source/web-page/page-shell.ts):
// makes the new language the page language, then each part writes its own
// words again from its own state (relabel: nothing is rebuilt, so ticks,
// the time zone, open folds, "show quoted text", "Print full original
// text", the plans, the focus and the scroll position all stay), sets
// <html lang> and the title, and makes ONE announcement through step 3
// (inputsChanged): the PDF's words and file name follow the language, so a
// PDF made or being made is dropped like after any other change, and never
// made again by itself. Nothing about the language is stored, and "Clear
// everything" keeps it.

import { PDF_FONTS } from '../pdf-export/bundled-fonts';
import { pdfPositions } from '../web-page-logic/no-printable-text';
import { createBrowserPdfWorker, pdfTimeoutMs, runPdfInWorker } from '../worker-pipeline/pdf-worker-runner';
import { mountAddFiles, type AddFiles, type AddFilesOptions } from './add-files';
import { applyDocumentLanguage, mountPageShell, type PageShell } from './page-shell';
import { mountDownloadStep, type DownloadStep, type DownloadStepOptions } from './download-step';
import { getLocale, isSupportedLocale, setLocale, t } from './translations';
import { createPdfLabels, type PdfLabels, type PdfLabelsOptions } from './pdf-labels';
import type { PdfUnavailable } from './pdf-job';
import { mountPreview, type Preview, type PreviewOptions } from './preview';
import { createReview, type Review } from './review';
import type { ProcessResult } from '../../Header/file-processing';
import type { PdfJobInput } from '../../Header/pdf-worker-messages';
import type { EngineResult } from '../../Header/thread-analysis-result';

export interface PageOptions
{
    /** Passed to step 1 (unit tests: a fake process function and a fake window). */
    readonly addFiles?: Pick<AddFilesOptions, 'process' | 'listenerTarget'>;
    /** Passed to step 2 (unit tests: fixed zones, chunk scheduling). */
    readonly preview?: Pick<PreviewOptions, 'chunkSize' | 'schedule' | 'cancel' | 'zones' | 'initialZone'>;
    /** Passed to the PDF labels (unit tests: scheduling and clock). */
    readonly pdfLabels?: Pick<PdfLabelsOptions, 'schedule' | 'cancel' | 'now'>;
    /**
     * Passed to step 3 (unit tests: a fake PDF maker, fake blob: URLs, a fixed
     * clock and origin). The page-wide 'pagehide' listener goes to
     * `listenerTarget`, else to step 1's, else to window.
     */
    readonly download?: Partial<Pick<DownloadStepOptions, 'run' | 'createUrl' | 'revokeUrl' | 'origin' | 'now' | 'fonts' | 'listenerTarget'>>;
}

export interface Page
{
    readonly shell: PageShell;
    readonly addFiles: AddFiles;
    readonly preview: Preview;
    readonly review: Review;
    /** What the PDF leaves out: getPdfPolicy() and currentPlans() for the PDF step. */
    readonly pdfLabels: PdfLabels;
    /** Step 3: the "Make the PDF" button and the download. */
    readonly download: DownloadStep;
    /** What "Clear everything" does (see the top of this file). */
    clearEverything(): void;
    /**
     * Shows the page in another shipped language (see the top of this file).
     * Does nothing for the language already shown or one the page does not ship.
     */
    setLanguage(locale: string): void;
}

/** The browser's way to offer the PDF: a Blob in memory and its blob: URL. */
function blobUrl(bytes: Uint8Array): string
{
    return URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }));
}

/**
 * Gives a step 1 result to step 2: the review first, so it knows the result
 * before the preview reports the list complete (an empty list is complete
 * at once), then the list. See Source/web-page/review.ts.
 */
export function showResultInStep2(result: ProcessResult, review: Pick<Review, 'showResult'>, preview: Pick<Preview, 'showResult'>): void
{
    review.showResult(result);
    preview.showResult(result);
}

/**
 * True when the focused control was removed: the focus fell back to the
 * page's <body> AND the control it was last on (`lastFocused`, null: none)
 * is no longer in the page. A focus on <body> for any other reason (page
 * just loaded, a click on plain text) gives false.
 */
export function focusedControlWasRemoved(
    pageDocument: { readonly activeElement: unknown; readonly body: unknown },
    lastFocused: { readonly isConnected: boolean } | null,
): boolean
{
    const onBody = pageDocument.body !== null && pageDocument.body !== undefined && pageDocument.activeElement === pageDocument.body;
    return onBody && lastFocused !== null && !lastFocused.isConnected;
}

/** Builds the page inside `root` and wires its parts together. */
export function mountPage(root: HTMLElement, options: PageOptions = {}): Page
{
    // The picker only calls back on the reader's action, once everything below exists.
    const shell = mountPageShell(root, { onLanguageChange: (locale) => setLanguage(locale) });
    // The result shown in step 2 (null: none), and whether its PDF plans failed.
    let shown: EngineResult | null = null;
    let plansFailed = false;
    // The control the focus was last on (null: none). See the top of this file.
    // A mouse or touch press forgets it first: a press on a control focuses
    // that control right after (focusin), a press on plain text focuses
    // nothing, so the control left behind is not taken for a removed one.
    let lastFocused: Node | null = null;
    document.addEventListener('pointerdown', () =>
    {
        lastFocused = null;
    });
    document.addEventListener('focusin', (event) =>
    {
        lastFocused = event.target as Node | null;
    });
    // Step 3 is mounted last (it asks the other steps for their state at
    // once); the hooks below only run later, on the user's actions.
    /** A choice that goes into the PDF changed: a PDF made or being made is dropped. */
    const choicesChanged = (): void => download.inputsChanged();

    // Each tick or untick: step 3 drops a PDF made or being made and announces
    // the "N of M emails will be in the PDF" line in the status line, in ONE
    // announcement with "the previous PDF was removed" when it dropped one
    // (Source/web-page/download-step.ts). Done first, so the drop happens here with the
    // line and not inside the labels' refresh below (whose own call then has
    // nothing left to drop). Then the PDF labels are worked out again.
    const review = createReview({
        onChange: (announcement) =>
        {
            download.inputsChanged(announcement);
            pdfLabels.refresh();
        },
        // The rebuilt emails' switch or a rebuilt card's checkbox: a PDF made
        // before is dropped (and said so with the new line). The plans of the
        // real emails do not depend on it, but their no-repeat labels do (task
        // 8.11): the plans in use go to the preview again with the new cut,
        // after the announcement (so its drop is the one announced; handing the
        // plans over again then has nothing left to drop). Every rebuilt card
        // (a stand-in the review could not decorate too) is shown or hidden with
        // the switch. No line ('': not expected here, the review gives '' only
        // when the switch is hidden): only the drop, if any, is announced.
        onRebuiltChange: (announcement) =>
        {
            preview.refreshRebuilt();
            download.inputsChanged(announcement === '' ? undefined : announcement);
            pdfLabels.rebuiltChanged();
        },
        // "Print full original text" ticked: no rebuilt email shown or in the PDF (Source/web-page/review.ts).
        unfoldEverything: () => pdfLabels.getPdfPolicy().unfoldEverything,
    });
    // The PDF labels of step 2 (Source/web-page/pdf-labels.ts): their checkbox sits in the preview's toolbar.
    // New plans (or none) also mean a PDF made from the old ones is stale.
    const pdfLabels = createPdfLabels({
        ...options.pdfLabels,
        includedPositions: () => review.includedPositions(),
        // The same rebuilt emails as the PDF step (pdfInput), for the no-repeat labels (task 8.11).
        includedRebuilt: () => review.includedRebuilt().map((r) => r.id),
        // The switch off: no rebuilt email is "unticked", forwarded parts stay (task 8.13a, Q2), as in pdfInput.
        rebuildingOff: () => !review.rebuiltShown(),
        // Only the cards the reader really unticked leave their forwarded parts out (task 8.13a review round 2), as in pdfInput.
        untickedRebuilt: () => review.untickedRebuilt(),
        setPdfPlans: (plans) =>
        {
            plansFailed = false;
            preview.setPdfPlans(plans);
            choicesChanged();
        },
        failed: () =>
        {
            plansFailed = true;
            preview.pdfPlansFailed();
            choicesChanged();
        },
        // Deliberately a second path besides setPdfPlans and failed: the PDF is
        // dropped on the user's change itself, whatever the labels then do with
        // their plans (they call neither when plans for those inputs are already
        // on their way). Dropping twice is harmless. The rebuilt cards follow
        // the checkbox (none shown or in the PDF while it is ticked, the switch
        // disabled): their new line is announced with the drop, when there are
        // rebuilt emails. The PDF is dropped even if writing the cards again throws.
        onPolicyChange: () =>
        {
            let line = '';
            try
            {
                line = review.everythingChanged();
                preview.refreshRebuilt();
            }
            finally
            {
                download.inputsChanged(line === '' ? undefined : line);
            }
        },
    });
    const preview = mountPreview(shell, {
        ...options.preview,
        header: [review.element],
        toolbarItems: [pdfLabels.element, review.rebuiltSwitch],
        decorate: review.decorate,
        decorateRebuilt: review.decorateRebuilt,
        rebuiltShown: () => review.rebuiltShown(),
        onRendered: (result) =>
        {
            review.rendered(result);
            // Once the list is complete, an email without a decorated item counts as included (Source/web-page/review.ts).
            pdfLabels.refresh();
            // A rebuilt card without a decorated item too: the no-repeat labels follow (task 8.11).
            pdfLabels.rebuiltChanged();
            download.refresh();
        },
        onZoneChange: choicesChanged,
    });
    // Step 1 opens or closes step 2 itself; step 2 shows each new result.
    const addFiles = mountAddFiles(shell, {
        ...options.addFiles,
        onResult: (result) =>
        {
            shown = result.ok ? result.engine : null;
            plansFailed = false;
            showResultInStep2(result, review, preview);
            pdfLabels.show(shown);
            choicesChanged();
            // The rebuilt lists may have taken the focused control with them (see the top of this file).
            if (focusedControlWasRemoved(document, lastFocused))
            {
                addFiles.focus();
            }
        },
        // Files added (or cleared): the emails of a PDF made before are no longer the ones shown.
        onFilesChange: () =>
        {
            shell.setClearAvailable(addFiles.hasFiles());
            choicesChanged();
        },
    });

    /** Why the PDF cannot be made now, or null (see PdfUnavailable in Source/web-page/pdf-job.ts). */
    function pdfUnavailable(): PdfUnavailable | null
    {
        if (addFiles.isBusy())
        {
            return 'busy';
        }
        if (shown === null || shown.messages.length === 0)
        {
            return 'no-emails';
        }
        if (plansFailed)
        {
            return 'labels-failed';
        }
        const plans = pdfLabels.currentPlans();
        if (preview.isRendering() || plans === null || plans.result !== shown)
        {
            return 'busy';
        }
        if (plans.positions.length === 0)
        {
            return 'none-included';
        }
        // Every ticked email has no text: the PDF would hold none of them (task 8.14).
        return pdfPositions(plans.result, plans.positions).length === 0 ? 'none-with-text' : null;
    }

    /**
     * What goes in the PDF: exactly the plans the preview's labels show
     * (currentPlans is null while they are being worked out again, and the
     * button is unavailable then), and the time zone picked in step 2.
     */
    function pdfInput(generatedAt: number): PdfJobInput | null
    {
        const plans = pdfLabels.currentPlans();
        if (plans === null || plans.result !== shown)
        {
            return null;
        }
        return {
            result: plans.result,
            positions: plans.positions,
            plans: plans.plans,
            // The rebuilt emails ticked whose source email is in the PDF ([] when
            // the switch is off, and under "Print full original text", whose plans
            // these are: the PDF model leaves them out then anyway).
            rebuilt: plans.policy.unfoldEverything ? [] : review.includedRebuilt().map((r) => r.id),
            // The switch off (task 8.13a, Q2): no rebuilt email counts as unticked, forwarded parts stay in their forward.
            rebuildingOff: !review.rebuiltShown(),
            // The rebuilt cards the reader unticked: only their forwarded parts are left out (an entry merely not chosen stays inline).
            unticked: plans.policy.unfoldEverything ? [] : [...review.untickedRebuilt()],
            policy: plans.policy,
            timeZone: preview.zone(),
            generatedAt,
            // The PDF's words and file name are in the page language.
            locale: getLocale(),
        };
    }

    const settings = options.download ?? {};
    const download = mountDownloadStep(shell, {
        unavailable: pdfUnavailable,
        input: pdfInput,
        fonts: settings.fonts ?? PDF_FONTS,
        run:
            settings.run ??
            ((request, signal) =>
                runPdfInWorker(request, { createWorker: createBrowserPdfWorker, timeoutMs: pdfTimeoutMs(request.input.positions.length + (request.input.rebuilt?.length ?? 0)), signal })),
        createUrl: settings.createUrl ?? blobUrl,
        revokeUrl: settings.revokeUrl ?? ((url) => URL.revokeObjectURL(url)),
        // No `location` outside a browser (unit tests that pass no origin): no link can be shown then.
        origin: settings.origin ?? (typeof location === 'undefined' ? '' : location.origin),
        now: settings.now ?? Date.now,
        ...(settings.listenerTarget === undefined && options.addFiles?.listenerTarget === undefined
            ? {}
            : { listenerTarget: settings.listenerTarget ?? options.addFiles?.listenerTarget }),
    });

    function clearEverything(): void
    {
        addFiles.reset();
        preview.reset();
        review.reset();
        pdfLabels.reset();
        download.reset();
        shown = null;
        plansFailed = false;
        download.refresh();
        // Defensive: reset() already does this (through onFilesChange).
        shell.setClearAvailable(false);
        shell.setStatus(t('clear.done'));
        lastFocused = null;
        addFiles.focus();
    }

    function setLanguage(locale: string): void
    {
        if (!isSupportedLocale(locale) || locale === getLocale())
        {
            return;
        }
        setLocale(locale);
        shell.relabel();
        addFiles.relabel();
        review.relabel();
        pdfLabels.relabel();
        preview.relabel();
        // Deliberate: relabel first, then inputsChanged below drops the PDF.
        download.relabel();
        applyDocumentLanguage();
        // One announcement, in the new language; a PDF made or being made is
        // dropped (and said so in the same announcement), never made again here.
        download.inputsChanged(t('language.changed'));
    }

    shell.clearButton.addEventListener('click', () =>
    {
        // aria-disabled: still focusable, but does nothing while there is nothing to clear.
        if (!addFiles.hasFiles())
        {
            return;
        }
        clearEverything();
    });

    return { shell, addFiles, preview, review, pdfLabels, download, clearEverything, setLanguage };
}
