// Entry point of the page: loads the styles and builds the app shell.
import './ui/app.css';
import { mountApp } from './ui/app';

const root = document.getElementById('app');
if (root) mountApp(root);
