// TEST-ONLY entry point for e2e/html-to-text.spec.ts. Never part of the site:
// index.html and src/main.ts do not import it, so `vite build` (dist/) never
// contains it. The spec bundles it in memory with the project's own Vite
// config and serves it to the page through a Playwright route, so the real
// production code (browser-parsers.ts, html-dom.ts, html-to-text.ts,
// postal-mime) runs in each test browser under the site's real CSP.

export { createBrowserParsers } from '../../src/parsing/browser-parsers';
export { htmlToTextWithDomParser } from '../../src/parsing/html-dom';
export type { HtmlToTextLimits, HtmlToTextResult } from '../../src/parsing/html-to-text';
// The synthetic fixture's raw text, inlined by Vite's `?raw` (the test runner
// has no file system types; see the spec for why).
export { default as FIXTURE_50 } from '../../tests/fixtures/eml/50-html-only.eml?raw';
