import './style.css';

// Always write text with textContent, never innerHTML: email content is
// untrusted and must never be interpreted as HTML (README.md, rule R4).
const status = document.querySelector<HTMLParagraphElement>('#status');

if (status) {
  status.textContent =
    'Coming soon: drop your exported emails here. Everything stays in your browser.';
}
