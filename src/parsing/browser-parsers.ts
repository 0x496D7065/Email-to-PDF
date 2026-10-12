// The production parsers: both adapters wired to the browser's inert HTML
// converter (html-dom.ts). Unit tests create the adapters with their own
// converter instead, since Node has no DOMParser.

import { createEmlParser } from './eml';
import { htmlToTextWithDomParser } from './html-dom';
import type { HtmlToTextResult } from './html-to-text';
import { createMsgParser } from './msg';
import type { EmailParser } from './types';

/** The parsers the page uses, one per supported file type. */
export interface BrowserParsers {
  readonly eml: EmailParser;
  readonly msg: EmailParser;
}

/** Creates the .eml and .msg parsers with the DOMParser-based HTML converter. */
export function createBrowserParsers(): BrowserParsers {
  // Wrapped so that the converter is always called with the default limits.
  const htmlToText = (html: string): HtmlToTextResult => htmlToTextWithDomParser(html);
  return { eml: createEmlParser({ htmlToText }), msg: createMsgParser({ htmlToText }) };
}
