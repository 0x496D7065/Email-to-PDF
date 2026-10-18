// Entry point of the page: loads the styles and builds the page (the shell,
// step 1's file picker, step 2's preview with its counts, include
// checkboxes and notes, and "Clear everything"; see src/ui/page.ts).
// Nothing is logged and nothing is stored (README.md, rule R5).
import './ui/app.css';
import { pdfFontsReady } from './pdf/fonts';
import { mountPage } from './ui/page';

const root = document.getElementById('app');
if (root) mountPage(root);

// The PDF fonts are imported here, by the page entry, so their chunk
// (assets/pdf-fonts-[hash].js) is loaded together with the page and the
// tool keeps working offline afterwards (README.md, rule R1). Using them
// (a quick check of their WOFF headers) keeps the bundler from dropping the
// import while nothing else uses the fonts yet. The flag says only whether
// the app's own fonts are there; it holds no user data.
document.documentElement.dataset.pdfFonts = pdfFontsReady() ? 'ready' : 'missing';
