// Parses every synthetic fixture (this folder) with the real .eml and .msg
// adapters, in manifest order. Shared by the thread analysis's fixture tests
// (Source/thread-analysis/*.fixtures.test.ts) so they all see the same parsed messages.
// Test-only: never imported by the app.

import { createEmlParser } from '../../../Source/email-reading/eml-parser';
import type { HtmlToTextResult } from '../../../Source/email-reading/html-to-text';
import { createMsgParser } from '../../../Source/email-reading/msg-parser';
import { FIXTURES } from './manifest';
import { buildMsg } from './msg/builder';
import { MSG_SPECS } from './msg/specs';
import type { NormalizedMessage } from '../../../Header/parsed-email';

// Node has no DOMParser, so HTML bodies go through a stub (as in the adapter
// manifest tests). It only affects the HTML-only fixtures. The stub is NOT a
// converter and must never be used outside tests.
const htmlToText = (html: string): HtmlToTextResult => ({ text: `[stub html-to-text] ${html.length} chars`, truncated: false });
const emlParser = createEmlParser({ htmlToText });
const msgParser = createMsgParser({ htmlToText });

const emlFiles = import.meta.glob<string>('./eml/*.eml', {
    query: '?raw',
    import: 'default',
    eager: true,
});

/** Parses every fixture, in manifest order. Each message's file name is its manifest id. */
export async function parseAllFixtures(): Promise<NormalizedMessage[]>
{
    const messages: NormalizedMessage[] = [];
    for (const fixture of FIXTURES)
    {
        let bytes: Uint8Array;
        if (fixture.kind === 'eml')
        {
            const raw = emlFiles[`./${fixture.id}`];
            if (raw === undefined)
            {
                throw new Error(`missing file for ${fixture.id}`);
            }
            bytes = new TextEncoder().encode(raw); // fixtures are 7-bit ASCII
        }
        else
        {
            const spec = MSG_SPECS.find((s) => s.id === fixture.id);
            if (spec === undefined)
            {
                throw new Error(`missing spec for ${fixture.id}`);
            }
            bytes = buildMsg(spec);
        }
        const parser = fixture.kind === 'eml' ? emlParser : msgParser;
        const result = await parser.parse({ name: fixture.id, bytes });
        if (!result.ok)
        {
            throw new Error(`${fixture.id} failed to parse: ${result.detail}`);
        }
        messages.push(result.message);
    }
    return messages;
}
