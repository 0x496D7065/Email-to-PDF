// Entry point of the page: loads the styles, builds the app shell, the file
// picker of step 1 and the preview of step 2. Nothing is logged and nothing
// is stored (README.md, rule R5).
import './ui/app.css';
import { mountAddFiles } from './ui/add-files';
import { mountApp } from './ui/app';
import { mountPreview } from './ui/preview';

const root = document.getElementById('app');
if (root) {
  const shell = mountApp(root);
  const preview = mountPreview(shell);
  // Step 1 opens or closes step 2 itself; the preview shows each new result.
  mountAddFiles(shell, { onResult: (result) => preview.showResult(result) });
}
