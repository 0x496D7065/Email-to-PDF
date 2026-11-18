// The production parsers: both adapters wired to the browser's inert HTML
// converter (browser-html-to-text.ts). Unit tests create the adapters with their own
// converter instead, since Node has no DOMParser.
//
// The page must not read dropped files with these directly: use parseFiles
// (parse-files.ts), which adds the size limits, the file type decision, the
// Compound File check before msgreader, and a Web Worker with a time limit
// (README.md, rule R4). These run on the page's own thread, unguarded.

import { createEmlParser } from './eml-parser';
import { htmlToTextWithDomParser } from './browser-html-to-text';
import type { HtmlToTextResult } from './html-to-text';
import { createMsgParser } from './msg-parser';
import type { EmailParser } from '../../Header/parsed-email';

/** The parsers the page uses, one per supported file type. */
export interface BrowserParsers
{
    readonly eml: EmailParser;
    readonly msg: EmailParser;
}

/** Creates the .eml and .msg parsers with the DOMParser-based HTML converter. */
export function createBrowserParsers(): BrowserParsers
{
    // Wrapped so that the converter is always called with the default limits.
    const htmlToText = (html: string): HtmlToTextResult => htmlToTextWithDomParser(html);
    return { eml: createEmlParser({ htmlToText }), msg: createMsgParser({ htmlToText }) };
}
