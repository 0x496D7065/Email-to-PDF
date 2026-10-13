// Entry point of the page: loads the styles, builds the app shell and the
// file picker of step 1. Nothing is logged and nothing is stored
// (README.md, rule R5).
import './ui/app.css';
import { mountAddFiles } from './ui/add-files';
import { mountApp } from './ui/app';

const root = document.getElementById('app');
if (root) {
  const shell = mountApp(root);
  mountAddFiles(shell, {
    onResult: () => {
      // Step 2 (the preview) will show the result here. For now step 1 shows
      // the summary and opens step 2 by itself.
    },
  });
}
