// Calls the injected HTML-to-text converter for both adapters (.eml, .msg),
// so that a converter failure is reported as what it is, never as a damaged
// file: the adapters catch HtmlConversionError, leave that HTML part out and
// add the 'html-body-unreadable' warning (the rest of the message is kept).
//
// Without this wrapper a TypeError or RangeError thrown inside the converter
// (for example a stack overflow on a hostile document) would reach the
// adapter's catch-all and look like a broken file: the .msg adapter maps
// those errors to "damaged property: ...".

import type { HtmlToTextResult } from './html-to-text';

/** The injected converter threw, or returned something that is not a { text, truncated } result. */
export class HtmlConversionError extends Error
{
    /**
     * The converter's own reason, without the "HTML body could not be
     * converted: " prefix. The worker path (deferred-html.ts) sends this
     * reason from the page back to the worker.
     */
    readonly reason: string;

    constructor(reason: string)
    {
        super(`HTML body could not be converted: ${reason.trim() === '' ? 'unknown error' : reason}`);
        this.name = 'HtmlConversionError';
        this.reason = reason;
    }
}

/**
 * Runs `htmlToText(html)`. Any error it throws, and any return value that is
 * not an object with a string `text` and a boolean `truncated`, becomes an
 * HtmlConversionError. The adapters warn 'html-body-truncated' when
 * `truncated` is true.
 */
export function convertHtmlBody(htmlToText: (html: string) => HtmlToTextResult, html: string): HtmlToTextResult
{
    let result: unknown;
    try
    {
        result = htmlToText(html);
    }
    catch (error)
    {
        throw new HtmlConversionError(error instanceof Error ? error.message : String(error));
    }
    if (!isResult(result))
    {
        throw new HtmlConversionError('the converter returned no text');
    }
    // A new object: nothing else the converter may have attached is kept.
    return { text: result.text, truncated: result.truncated };
}

function isResult(value: unknown): value is HtmlToTextResult
{
    if (typeof value !== 'object' || value === null)
    {
        return false;
    }
    const candidate = value as { text?: unknown; truncated?: unknown };
    return typeof candidate.text === 'string' && typeof candidate.truncated === 'boolean';
}
