// The whole page wired together: the shell (app.ts), step 1 (add-files.ts),
// step 2 (preview.ts with review.ts around it) and "Clear everything".
// src/main.ts only calls mountPage; this module is unit tested with the
// fake DOM (page.test.ts) and in Chromium (e2e/clear.spec.ts).
//
// Results: step 1 hands each new result to step 2, the review FIRST, then
// the list (see showResultInStep2).
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
//   empties the counts;
// - says "Everything was cleared." in the status line (the page's one live
//   region) and moves the focus to step 1's "choose" button, so a keyboard
//   or screen reader user is not left on a button that is now unavailable.
// No confirmation is asked: the user can simply add the files again. After
// it, nothing on the page holds the emails, their file names or the File
// objects, so the browser can free them. Reloading or closing the tab does
// the same, since nothing is ever stored (no storage, cookies or caches).
// This is the user's own, explicit action: nothing else ever drops text
// (README.md, rule R6).

import type { ProcessResult } from '../pipeline/process-files';
import { mountAddFiles, type AddFiles, type AddFilesOptions } from './add-files';
import { mountApp, type AppShell } from './app';
import { t } from './i18n';
import { mountPreview, type Preview, type PreviewOptions } from './preview';
import { createReview, type Review } from './review';

export interface PageOptions {
  /** Passed to step 1 (unit tests: a fake process function and a fake window). */
  readonly addFiles?: Pick<AddFilesOptions, 'process' | 'listenerTarget'>;
  /** Passed to step 2 (unit tests: fixed zones, chunk scheduling). */
  readonly preview?: Pick<PreviewOptions, 'chunkSize' | 'schedule' | 'cancel' | 'zones' | 'initialZone'>;
}

export interface Page {
  readonly shell: AppShell;
  readonly addFiles: AddFiles;
  readonly preview: Preview;
  readonly review: Review;
  /** What "Clear everything" does (see the top of this file). */
  clearEverything(): void;
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
  // The "N of M emails will be in the PDF" line is announced through the status line.
  const review = createReview({ announce: (text) => shell.setStatus(text) });
  const preview = mountPreview(shell, { ...options.preview, header: [review.element], decorate: review.decorate, onRendered: review.rendered });
  // Step 1 opens or closes step 2 itself; step 2 shows each new result.
  const addFiles = mountAddFiles(shell, {
    ...options.addFiles,
    onResult: (result) => showResultInStep2(result, review, preview),
    onFilesChange: () => shell.setClearAvailable(addFiles.hasFiles()),
  });

  function clearEverything(): void {
    addFiles.reset();
    preview.reset();
    review.reset();
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

  return { shell, addFiles, preview, review, clearEverything };
}
