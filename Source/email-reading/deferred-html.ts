// Parsing in a Web Worker while converting HTML on the page.
//
// The problem: files are parsed in a Web Worker (see parse-worker-runner.ts), but
// the inert HTML-to-text converter needs DOMParser (browser-html-to-text.ts), which only
// exists on the page, not inside workers.
//
// The solution, "record, then replay" (two passes, both inside the worker):
// 1. The adapter runs with a RECORDING converter: it returns an empty text
//    and notes every HTML string it is handed, in call order. If nothing was
//    recorded (plain-text mail, the usual case), that result is final.
// 2. Otherwise the HTML strings go to the page, which converts them with
//    DOMParser (convertHtmlList) and sends the results back.
// 3. The adapter runs AGAIN on the same bytes with a REPLAYING converter
//    that returns those results in the same order. That result is final.
//
// The adapters are deterministic: the same bytes ask for the same HTML in the
// same order (which parts are converted depends only on the MIME structure,
// never on a converted text). So pass 3 sees exactly what a direct call to
// the real converter would have returned, and every rule of the adapter
// (how texts are joined, empty conversions, 'html-converted-body',
// 'html-body-truncated', 'html-body-unreadable' for a part the converter
// failed on) applies unchanged. The replaying converter also checks that it
// is handed the same HTML it recorded, so a mismatch can never put a text in
// the wrong place: a mismatch fails the whole file (it would be a bug, and
// the file's text could not be trusted to be complete).
//
// Why not placeholders (return a unique marker in pass 1, then replace the
// markers in the finished text on the page)? The adapter decides things
// from the converted text: an empty conversion adds no text and no line
// break, a text that ends with a line break is joined differently. A marker
// is never empty, so the page would have to redo those rules. Record and
// replay needs none of that, and no marker can ever collide with email text.
// The cost: a message whose body needs HTML conversion is parsed twice.
// Since emails sent as attachments are read too (eml-parser.ts, readDeferred), a
// file whose only HTML sits inside such an email now takes this two-pass
// path as well.

import { findCompoundFileDamage } from './compound-file-check';
import { createEmlParser } from './eml-parser';
import { sha256Hex } from './file-hash';
import { convertHtmlBody, HtmlConversionError } from './html-conversion';
import type { HtmlToTextResult } from './html-to-text';
import { createMsgParser } from './msg-parser';
import type { ConversionOutcome, FileKind } from '../../Header/parse-worker-messages';
import type { EmailParser, InputFile, ParseResult } from '../../Header/parsed-email';

/** Sends HTML strings to the page and waits for their conversions, in the same order. */
export type ConvertOnPage = (htmls: readonly string[]) => Promise<readonly ConversionOutcome[]>;

/** Detail of a file whose page answer did not match what was recorded (a bug, never a bad file). */
export const MISMATCH_DETAIL = 'HTML body could not be converted: the converted text did not come back from the page';

function parserFor(kind: FileKind, htmlToText: (html: string) => HtmlToTextResult): EmailParser
{
    return kind === 'eml' ? createEmlParser({ htmlToText }) : createMsgParser({ htmlToText });
}

/**
 * Parses one file of a known kind (inside the worker). HTML conversions are
 * done by `convertOnPage`, see the top of this file. A .msg file first goes
 * through the Compound File check (compound-file-check.ts). Never throws for a bad
 * file: like the adapters, any failure becomes a 'corrupt' result.
 */
export async function parseWithDeferredHtml(file: InputFile, kind: FileKind, convertOnPage: ConvertOnPage): Promise<ParseResult>
{
    if (kind === 'msg')
    {
        const damage = findCompoundFileDamage(file.bytes);
        if (damage !== null)
        {
            return { ok: false, error: 'corrupt', detail: damage, fileName: file.name, sha256: await sha256Hex(file.bytes) };
        }
    }

    const recorded: string[] = [];
    const recording = (html: string): HtmlToTextResult =>
    {
        recorded.push(html);
        return { text: '', truncated: false };
    };
    const first = await parserFor(kind, recording).parse(file);
    if (recorded.length === 0)
    {
        return first;
    }

    // Pass 3 runs even if pass 1 failed: a converter failure on the page must
    // win over a later problem in the file, exactly as with a direct converter.
    const outcomes = await convertOnPage(recorded);
    let next = 0;
    let mismatch = false;
    const replaying = (html: string): HtmlToTextResult =>
    {
        const outcome = outcomes[next];
        if (mismatch || outcome === undefined || recorded[next] !== html)
        {
            // Once out of step, every later answer is suspect too.
            mismatch = true;
            throw new Error('mismatch');
        }
        next++;
        // The adapter turns this into its 'html-body-unreadable' warning, exactly
        // as it does when a direct converter throws.
        if (!outcome.ok)
        {
            throw new Error(outcome.reason);
        }
        return { text: outcome.text, truncated: outcome.truncated };
    };
    const result = await parserFor(kind, replaying).parse(file);
    // The adapter would have read a mismatch as one unreadable part; it is not
    // (see the top of this file), so the file fails instead.
    if (mismatch)
    {
        return { ok: false, error: 'corrupt', detail: MISMATCH_DETAIL, fileName: file.name, sha256: await sha256Hex(file.bytes) };
    }
    return result;
}

/**
 * Converts the recorded HTML strings ON THE PAGE, in order, with the real
 * converter (`htmlToText`, htmlToTextWithDomParser in the browser). Uses
 * convertHtmlBody, so a converter that throws or returns something that is
 * not a { text, truncated } result gives the same reason as in a direct
 * call. A failure does not stop the list: the adapter leaves that one part
 * out and goes on with the next ones, so every string gets an outcome.
 */
export function convertHtmlList(htmls: readonly string[], htmlToText: (html: string) => HtmlToTextResult): ConversionOutcome[]
{
    const outcomes: ConversionOutcome[] = [];
    for (const html of htmls)
    {
        try
        {
            const { text, truncated } = convertHtmlBody(htmlToText, html);
            outcomes.push({ ok: true, text, truncated });
        }
        catch (error)
        {
            const reason =
                error instanceof HtmlConversionError ? error.reason : error instanceof Error ? error.message : String(error);
            outcomes.push({ ok: false, reason });
        }
    }
    return outcomes;
}
