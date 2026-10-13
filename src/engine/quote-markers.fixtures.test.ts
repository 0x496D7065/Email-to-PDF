// Runs quote-marker detection over every synthetic fixture (tests/fixtures),
// parsed by the real .eml and .msg adapters. It measures how much of each
// message is folded and checks the key expectations (README.md, rule R7).

import { describe, expect, it } from 'vitest';
import { FIXTURES } from '../../tests/fixtures/manifest';
import { buildMsg } from '../../tests/fixtures/msg/builder';
import { MSG_SPECS } from '../../tests/fixtures/msg/specs';
import { createEmlParser } from '../parsing/eml';
import type { HtmlToTextResult } from '../parsing/html-to-text';
import { createMsgParser } from '../parsing/msg';
import type { NormalizedMessage } from '../parsing/types';
import { detectQuoteMarkers } from './quote-markers';
import { buildSegments, checkSegments, reconstruct, type FoldRange } from './segments';

// Node has no DOMParser, so HTML bodies go through a stub (as in the adapter
// manifest tests). The stub is NOT a converter and must never be used outside tests.
const htmlToText = (html: string): HtmlToTextResult => ({ text: `[stub html-to-text] ${html.length} chars`, truncated: false });
const emlParser = createEmlParser({ htmlToText });
const msgParser = createMsgParser({ htmlToText });

const emlFiles = import.meta.glob<string>('../../tests/fixtures/eml/*.eml', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/** Parses every fixture, in manifest order. */
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

interface Measured {
  readonly file: string;
  readonly body: string;
  readonly folds: readonly FoldRange[];
  readonly foldedChars: number;
}

/** True when every character of `snippet` (first occurrence) is folded / shown. */
function state(m: Measured, snippet: string): 'folded' | 'shown' | 'mixed' {
  const at = m.body.indexOf(snippet);
  if (at < 0) throw new Error(`${m.file}: snippet not found: ${snippet}`);
  const covered = (i: number): boolean => m.folds.some((f) => f.start <= i && i < f.end);
  let foldedCount = 0;
  for (let i = at; i < at + snippet.length; i++) if (covered(i)) foldedCount++;
  if (foldedCount === 0) return 'shown';
  return foldedCount === snippet.length ? 'folded' : 'mixed';
}

describe('quote-marker detection over the parsed fixtures', () => {
  it('folds the ">" quotes and keeps each message\'s own first line shown', async () => {
    const messages = await parseAll();
    const all = new Map<string, Measured>();
    for (const message of messages) {
      const body = message.bodyText;
      const folds = detectQuoteMarkers(body);
      const segments = buildSegments(body, folds);
      expect(checkSegments(body, segments)).toEqual([]);
      expect(reconstruct(body, segments)).toBe(body);
      const foldedChars = segments.filter((s) => s.folded).reduce((n, s) => n + s.end - s.start, 0);
      const file = message.source.fileName;
      all.set(file, { file, body, folds, foldedChars });
    }
    const get = (file: string): Measured => {
      const m = all.get(file);
      if (m === undefined) throw new Error(`no result for ${file}`);
      return m;
    };

    // Measurement (the README asks to measure detection, not assume it).
    const rows = [...all.values()]
      .filter((m) => m.foldedChars > 0)
      .map((m) => `${m.file}: ${m.foldedChars}/${m.body.length} chars folded in ${m.folds.length} block(s)`);
    console.log(`quote markers on fixtures (messages with folds):\n${rows.join('\n')}`);

    // [file, new text that must stay shown, ">"-quoted text that must be folded]
    const replies: [string, string, string][] = [
      ['eml/12-order-3-alice-gmail.eml', 'Wednesday at 10:00 works for me.', '> Thank you for your message.'],
      ['eml/21-delivery-2-alice-apple.eml', 'Please ring at the side d', "> Les bureaux et chaises d'essai"],
    ];
    for (const [file, fresh, quoted] of replies) {
      const m = get(file);
      expect(state(m, fresh), `${file}: new text`).toBe('shown');
      expect(state(m, quoted), `${file}: quoted text`).toBe('folded');
    }

    // Every message: its first non-empty line (the start of its own new
    // text in every fixture) stays shown.
    expect(all.size).toBe(messages.length);
    for (const m of all.values()) {
      const firstLine = m.body.split(/\r\n|\n|\r/).find((line) => line.trim() !== '');
      if (firstLine === undefined) continue; // no text at all: nothing to fold
      expect(state(m, firstLine), `${m.file}: first line`).toBe('shown');
    }

    // Messages without any ">" line get no fold.
    for (const m of all.values()) {
      if (!/^\s*>/m.test(m.body)) expect(m.folds, m.file).toEqual([]);
    }
  });
});
