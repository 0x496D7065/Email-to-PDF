// Entry point of the page: loads the styles and builds the page (the shell,
// step 1's file picker, step 2's preview with its counts, include
// checkboxes and notes, and "Clear everything"; see src/ui/page.ts).
// Nothing is logged and nothing is stored (README.md, rule R5).
import './ui/app.css';
import { mountPage } from './ui/page';

const root = document.getElementById('app');
if (root) mountPage(root);
