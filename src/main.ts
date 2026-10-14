// Entry point of the page: loads the styles, builds the app shell, the file
// picker of step 1 and the preview of step 2 (the list, plus the counts,
// include checkboxes and notes of review.ts). Nothing is logged and nothing
// is stored (README.md, rule R5).
import './ui/app.css';
import { mountAddFiles } from './ui/add-files';
import { mountApp } from './ui/app';
import { mountPreview } from './ui/preview';
import { createReview } from './ui/review';

const root = document.getElementById('app');
if (root) {
  const shell = mountApp(root);
  // The "N of M emails will be in the PDF" line is announced through the status line.
  const review = createReview({ announce: (text) => shell.setStatus(text) });
  const preview = mountPreview(shell, { header: [review.element], decorate: review.decorate, onRendered: review.rendered });
  // Step 1 opens or closes step 2 itself; step 2 shows each new result:
  // the list first (it never depends on the counts), then the counts.
  mountAddFiles(shell, {
    onResult: (result) => {
      preview.showResult(result);
      review.showResult(result);
    },
  });
}
