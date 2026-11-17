// Parses every synthetic fixture (this folder) with the real .eml and .msg
// adapters, in manifest order. Shared by the engine's fixture tests
// (src/engine/*.fixtures.test.ts) so they all see the same parsed messages.
// Test-only: never imported by the app.

import { createEmlParser } from '../../src/parsing/eml';
import type { HtmlToTextResult } from '../../src/parsing/html-to-text';
import { createMsgParser } from '../../src/parsing/msg';
import type { NormalizedMessage } from '../../src/parsing/types';
import { FIXTURES } from './manifest';
import { buildMsg } from './msg/builder';
import { MSG_SPECS } from './msg/specs';

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
    for (const f of FIXTURES)
    {
        let bytes: Uint8Array;
        if (f.kind === 'eml')
        {
            const raw = emlFiles[`./${f.id}`];
            if (raw === undefined)
            {
                throw new Error(`missing file for ${f.id}`);
            }
            bytes = new TextEncoder().encode(raw); // fixtures are 7-bit ASCII
        }
        else
        {
            const spec = MSG_SPECS.find((s) => s.id === f.id);
            if (spec === undefined)
            {
                throw new Error(`missing spec for ${f.id}`);
            }
            bytes = buildMsg(spec);
        }
        const parser = f.kind === 'eml' ? emlParser : msgParser;
        const result = await parser.parse({ name: f.id, bytes });
        if (!result.ok)
        {
            throw new Error(`${f.id} failed to parse: ${result.detail}`);
        }
        messages.push(result.message);
    }
    return messages;
}
