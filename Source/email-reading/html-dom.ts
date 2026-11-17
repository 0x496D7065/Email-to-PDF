// Browser-side HTML-to-text: parses an HTML body with DOMParser, then hands
// the tree to the pure converter in html-to-text.ts.
//
// Why DOMParser is safe for untrusted email HTML (README.md, rule R4):
// `new DOMParser().parseFromString(html, 'text/html')` builds a separate,
// INERT document. It has no browsing context (no window of its own), so:
// - scripting is disabled in it: <script> elements are never run, and inline
//   event handlers (onload, onerror, onclick, ...) never fire;
// - nothing is fetched: images, stylesheets, fonts, frames and objects are
//   not loaded (a document without a browsing context loads no resources);
// - nothing navigates: <meta http-equiv="refresh">, <base> and links do
//   nothing.
// This code only READS that document. It never inserts any part of it into
// the live page (no innerHTML, no appendChild/importNode/adoptNode into the
// page's document, no iframe), so the document stays inert. The strict CSP
// (README.md, rule R2) is a second line of defence: even if a node ever
// reached the live page, inline scripts and remote images would be blocked.
//
// Seen in Chromium: the page's CSP is also checked while DOMParser parses.
// An inline event handler, a <style> block or a <base> element in the email
// is reported as a CSP violation (an error line in the DevTools console
// that names the Content Security Policy), although nothing runs and
// nothing is loaded. Those reports stay in the browser: the CSP has no
// report-uri. Helper/Test/browser-tests/html-to-text.spec.ts checks all of this, with and without
// the CSP.

import { htmlTreeToText, type HtmlToTextLimits, type HtmlToTextResult } from './html-to-text';

/**
 * Converts an HTML string to plain text in the browser, without rendering it.
 * `truncated` tells whether the text was cut at the output limit.
 */
export function htmlToTextWithDomParser(html: string, limits?: HtmlToTextLimits): HtmlToTextResult
{
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    return htmlTreeToText(parsed, limits);
}
