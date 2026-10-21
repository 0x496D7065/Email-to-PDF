// The whole page wired together: the shell (app.ts), step 1 (add-files.ts),
// step 2 (preview.ts with review.ts around it), step 3 (download-step.ts)
// and "Clear everything". src/main.ts only calls mountPage; this module is
// unit tested with the fake DOM (page.test.ts) and in Chromium
// (e2e/clear.spec.ts, e2e/download.spec.ts).
//
// Results: step 1 hands each new result to step 2, the review FIRST, then
// the list (see showResultInStep2), then the PDF labels (src/ui/pdf-labels.ts),
// which are worked out again on each tick or untick and once the list is
// complete.
//
// Step 3 makes the PDF from exactly the plans the labels show (pdfInput),
// and only once they are up to date (pdfUnavailable). Every change of what
// goes into the PDF drops a PDF made or being made (choicesChanged): files
// added, a new result, an email ticked or unticked, "Put everything in the
// PDF", the time zone, and new plans. So a PDF that no longer matches the
// page is never offered.
//
// "Clear everything" (README.md, rule R5: in memory only). The button is
// available as soon as files were added, also while they are being read and
// while the list is still being built. Pressing it:
// - step 1 (addFiles.reset): cancels the run still going, which terminates
//   its parse or engine worker at once (src/pipeline/process-files.ts) and
//   throws away anything it would still report; forgets every file, empties
//   the file input, the summary, the failed-files list and the notices, and
//   hides step 2;
// - step 2 (preview.reset, review.reset): empties the list, cancels the
//   chunks still waiting, puts the time zone and the "show quoted text"
//   checkbox back to their defaults, forgets every include choice and
//   empties the counts; (pdfLabels.reset) unticks "Put everything in the
//   PDF", stops the planning still going and drops every plan;
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

import type { EngineResult } from '../engine/engine';
import { PDF_FONTS } from '../pdf/fonts';
import type { ProcessResult } from '../pipeline/process-files';
import type { PdfJobInput } from '../pipeline/pdf-protocol';
import { createBrowserPdfWorker, pdfTimeoutMs, runPdfInWorker } from '../pipeline/pdf-runner';
import { mountAddFiles, type AddFiles, type AddFilesOptions } from './add-files';
import { mountApp, type AppShell } from './app';
import { mountDownloadStep, type DownloadStep, type DownloadStepOptions } from './download-step';
import { t } from './i18n';
import { createPdfLabels, type PdfLabels, type PdfLabelsOptions } from './pdf-labels';
import type { PdfUnavailable } from './pdf-job';
import { mountPreview, type Preview, type PreviewOptions } from './preview';
import { createReview, type Review } from './review';

export interface PageOptions {
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

export interface Page {
  readonly shell: AppShell;
  readonly addFiles: AddFiles;
  readonly preview: Preview;
  readonly review: Review;
  /** What the PDF leaves out: getPdfPolicy() and currentPlans() for the PDF step. */
  readonly pdfLabels: PdfLabels;
  /** Step 3: the "Make the PDF" button and the download. */
  readonly download: DownloadStep;
  /** What "Clear everything" does (see the top of this file). */
  clearEverything(): void;
}

/** The browser's way to offer the PDF: a Blob in memory and its blob: URL. */
function blobUrl(bytes: Uint8Array): string {
  return URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: 'application/pdf' }));
}

/**
 * Gives a step 1 result to step 2: the review first, so it knows the result
 * before the preview reports the list complete (an empty list is complete
 * at once), then the list. See src/ui/review.ts.
 */
export function showResultInStep2(result: ProcessResult, review: Pick<Review, 'showResult'>, preview: Pick<Preview, 'showResult'>): void {
  review.showResult(result);
  preview.showResult(result);
}

/** Builds the page inside `root` and wires its parts together. */
export function mountPage(root: HTMLElement, options: PageOptions = {}): Page {
  const shell = mountApp(root);
  // The result shown in step 2 (null: none), and whether its PDF plans failed.
  let shown: EngineResult | null = null;
  let plansFailed = false;
  // Step 3 is mounted last (it asks the other steps for their state at
  // once); the hooks below only run later, on the user's actions.
  /** A choice that goes into the PDF changed: a PDF made or being made is dropped. */
  const choicesChanged = (): void => download.inputsChanged();

  // The "N of M emails will be in the PDF" line is announced through the status line.
  // Each tick or untick also works the PDF labels out again.
  const review = createReview({
    announce: (text) => shell.setStatus(text),
    onChange: () => {
      pdfLabels.refresh();
      choicesChanged();
    },
  });
  // The PDF labels of step 2 (src/ui/pdf-labels.ts): their checkbox sits in the preview's toolbar.
  // New plans (or none) also mean a PDF made from the old ones is stale.
  const pdfLabels = createPdfLabels({
    ...options.pdfLabels,
    includedPositions: () => review.includedPositions(),
    setPdfPlans: (plans) => {
      plansFailed = false;
      preview.setPdfPlans(plans);
      choicesChanged();
    },
    failed: () => {
      plansFailed = true;
      preview.pdfPlansFailed();
      choicesChanged();
    },
    // Deliberately a second path besides setPdfPlans and failed: the PDF is
    // dropped on the user's change itself, whatever the labels then do with
    // their plans (they call neither when plans for those inputs are already
    // on their way). Dropping twice is harmless.
    onPolicyChange: choicesChanged,
  });
  const preview = mountPreview(shell, {
    ...options.preview,
    header: [review.element],
    toolbarItems: [pdfLabels.element],
    decorate: review.decorate,
    onRendered: (result) => {
      review.rendered(result);
      // Once the list is complete, an email without a decorated item counts as included (src/ui/review.ts).
      pdfLabels.refresh();
      download.refresh();
    },
    onZoneChange: choicesChanged,
  });
  // Step 1 opens or closes step 2 itself; step 2 shows each new result.
  const addFiles = mountAddFiles(shell, {
    ...options.addFiles,
    onResult: (result) => {
      shown = result.ok ? result.engine : null;
      plansFailed = false;
      showResultInStep2(result, review, preview);
      pdfLabels.show(shown);
      choicesChanged();
    },
    // Files added (or cleared): the emails of a PDF made before are no longer the ones shown.
    onFilesChange: () => {
      shell.setClearAvailable(addFiles.hasFiles());
      choicesChanged();
    },
  });

  /** Why the PDF cannot be made now, or null (see PdfUnavailable in src/ui/pdf-job.ts). */
  function pdfUnavailable(): PdfUnavailable | null {
    if (addFiles.isBusy()) return 'busy';
    if (shown === null || shown.messages.length === 0) return 'no-emails';
    if (plansFailed) return 'labels-failed';
    const plans = pdfLabels.currentPlans();
    if (preview.isRendering() || plans === null || plans.result !== shown) return 'busy';
    return plans.positions.length === 0 ? 'none-included' : null;
  }

  /**
   * What goes in the PDF: exactly the plans the preview's labels show
   * (currentPlans is null while they are being worked out again, and the
   * button is unavailable then), and the time zone picked in step 2.
   */
  function pdfInput(generatedAt: number): PdfJobInput | null {
    const plans = pdfLabels.currentPlans();
    if (plans === null || plans.result !== shown) return null;
    return { result: plans.result, positions: plans.positions, plans: plans.plans, policy: plans.policy, timeZone: preview.zone(), generatedAt };
  }

  const settings = options.download ?? {};
  const download = mountDownloadStep(shell, {
    unavailable: pdfUnavailable,
    input: pdfInput,
    fonts: settings.fonts ?? PDF_FONTS,
    run:
      settings.run ??
      ((request, signal) =>
        runPdfInWorker(request, { createWorker: createBrowserPdfWorker, timeoutMs: pdfTimeoutMs(request.input.positions.length), signal })),
    createUrl: settings.createUrl ?? blobUrl,
    revokeUrl: settings.revokeUrl ?? ((url) => URL.revokeObjectURL(url)),
    // No `location` outside a browser (unit tests that pass no origin): no link can be shown then.
    origin: settings.origin ?? (typeof location === 'undefined' ? '' : location.origin),
    now: settings.now ?? Date.now,
    ...(settings.listenerTarget === undefined && options.addFiles?.listenerTarget === undefined
      ? {}
      : { listenerTarget: settings.listenerTarget ?? options.addFiles?.listenerTarget }),
  });

  function clearEverything(): void {
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
    addFiles.focus();
  }

  shell.clearButton.addEventListener('click', () => {
    // aria-disabled: still focusable, but does nothing while there is nothing to clear.
    if (!addFiles.hasFiles()) return;
    clearEverything();
  });

  return { shell, addFiles, preview, review, pdfLabels, download, clearEverything };
}
