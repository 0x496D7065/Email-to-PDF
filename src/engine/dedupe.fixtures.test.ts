// Runs de-duplication over every synthetic fixture (tests/fixtures), parsed
// by the real .eml and .msg adapters, and checks the groups against the
// manifest's `duplicateGroup` marks (README.md, rule R7).

import { describe, expect, it } from 'vitest';
import { FIXTURES } from '../../tests/fixtures/manifest';
import { buildMsg } from '../../tests/fixtures/msg/builder';
import { MSG_SPECS } from '../../tests/fixtures/msg/specs';
import { createEmlParser } from '../parsing/eml';
import type { HtmlToTextResult } from '../parsing/html-to-text';
import { createMsgParser } from '../parsing/msg';
import type { NormalizedMessage } from '../parsing/types';
import { dedupe, normalizeBody } from './dedupe';

// Node has no DOMParser, so HTML bodies go through a stub (as in the adapter
// manifest tests). It only affects the HTML-only fixtures, none of which is
// a duplicate. The stub is NOT a converter and must never be used outside tests.
const htmlToText = (html: string): HtmlToTextResult => ({ text: `[stub html-to-text] ${html.length} chars`, truncated: false });
const emlParser = createEmlParser({ htmlToText });
const msgParser = createMsgParser({ htmlToText });

const emlFiles = import.meta.glob<string>('../../tests/fixtures/eml/*.eml', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Parses every fixture, in manifest order. The file name is the manifest id. */
async function parseAll(): Promise<NormalizedMessage[]> {
  const messages: NormalizedMessage[] = [];
  for (const f of FIXTURES) {
    let bytes: Uint8Array;
    if (f.kind === 'eml') {
      const raw = emlFiles[`../../tests/fixtures/${f.id}`];
      if (raw === undefined) throw new Error(`missing file for ${f.id}`);
      bytes = new TextEncoder().encode(raw); // fixtures are 7-bit ASCII
    } else {
      const spec = MSG_SPECS.find((s) => s.id === f.id);
      if (spec === undefined) throw new Error(`missing spec for ${f.id}`);
      bytes = buildMsg(spec);
    }
    const parser = f.kind === 'eml' ? emlParser : msgParser;
    const result = await parser.parse({ name: f.id, bytes });
    if (!result.ok) throw new Error(`${f.id} failed to parse: ${result.detail}`);
    messages.push(result.message);
  }
  return messages;
}

describe('dedupe over the parsed fixtures', () => {
  it('merges exactly the manifest duplicate groups', async () => {
    const messages = await parseAll();
    const result = dedupe(messages);

    // Expected: one group per `duplicateGroup` value, every other fixture alone.
    const expected = new Map<string, string[]>();
    for (const f of FIXTURES) {
      const key = f.duplicateGroup ?? `single:${f.id}`;
      expected.set(key, [...(expected.get(key) ?? []), f.id]);
    }
    const actual = result.kept.map((k) => [k.message.source.fileName, ...k.duplicates.map((d) => d.source.fileName)].sort());
    expect(actual.sort()).toEqual([...expected.values()].map((ids) => ids.sort()).sort());
    expect(result.mergedCount).toBe(FIXTURES.length - expected.size);

    // No fixture triggers an engine warning.
    for (const k of result.kept) expect(k.warnings).toEqual([]);

    // Every merged copy has the representative's normalized body.
    for (const k of result.kept) {
      for (const d of k.duplicates) {
        expect(normalizeBody(messages[d.index]!.bodyText)).toBe(normalizeBody(k.message.bodyText));
      }
    }
  });

  it('records which rule merged each copy', async () => {
    const result = dedupe(await parseAll());
    const rules = new Map(result.kept.flatMap((k) => k.duplicates.map((d) => [d.source.fileName, d.rule] as const)));
    expect(Object.fromEntries(rules)).toEqual({
      // order-2: .eml 11 is kept; the received copy 30 and the .msg export share its Message-ID.
      'eml/30-dup-order-2-copy.eml': 'message-id',
      'msg-09-dup-of-eml-order-2': 'message-id',
      // confirm-0305: 31 is kept; 32 (other id) and 33 (no id) match by author + date + body.
      'eml/32-dup-confirm-b-other-id.eml': 'author-date-body',
      'eml/33-dup-confirm-c-no-id.eml': 'author-date-body',
    });
    const keptNames = result.kept.map((k) => k.message.source.fileName);
    expect(keptNames).toContain('eml/11-order-2-bob-outlook-en.eml');
    expect(keptNames).toContain('eml/31-dup-confirm-a.eml');
  });
});
