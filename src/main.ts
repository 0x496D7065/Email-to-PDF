// Entry point of the page: loads the styles and builds the page (the shell,
// step 1's file picker, step 2's preview with its counts, include
// checkboxes and notes, and "Clear everything"; see src/ui/page.ts).
// Nothing is logged and nothing is stored (README.md, rule R5).
import './ui/app.css';
import { pdfFontsReady } from './pdf/fonts';
import { registerWhenLoaded } from './sw/register';
import { mountPage } from './ui/page';

const root = document.getElementById('app');
if (root) mountPage(root);

// The PDF fonts are imported here, by the page entry, so their chunk
// (assets/pdf-fonts-[hash].js) is loaded together with the page and the
// tool keeps working offline afterwards (README.md, rule R1). Step 3 hands
// their bytes to the PDF worker (src/ui/page.ts), which never imports them
// itself. The flag says only whether the app's own fonts are there; it
// holds no user data.
document.documentElement.dataset.pdfFonts = pdfFontsReady() ? 'ready' : 'missing';

// The offline copy of the site's own files (src/sw/), so the page can also
// be reopened while offline after one visit online. Built site only:
// `npm run dev` has no service worker (import.meta.env.PROD is false there,
// and this line is left out of the dev code). It never touches your emails.
if (import.meta.env.PROD) registerWhenLoaded(window, navigator);
