// TEST-ONLY entry point for Helper/Test/browser-tests/html-to-text.spec.ts. Never part of the site:
// Source/index.html and Source/main.ts do not import it, so `vite build` (dist/) never
// contains it. The spec bundles it in memory with the project's own Vite
// config and serves it to the page through a Playwright route, so the real
// production code (browser-parsers.ts, browser-html-to-text.ts, html-to-text.ts,
// postal-mime) runs in each test browser under the site's real CSP.

export { createBrowserParsers } from '../../../../Source/email-reading/browser-parsers';
export { htmlToTextWithDomParser } from '../../../../Source/email-reading/browser-html-to-text';
export type { HtmlToTextLimits, HtmlToTextResult } from '../../../../Source/email-reading/html-to-text';
// The synthetic fixture's raw text, inlined by Vite's `?raw` (the test runner
// has no file system types; see the spec for why).
export { default as FIXTURE_50 } from '../../test-data/eml/50-html-only.eml?raw';
