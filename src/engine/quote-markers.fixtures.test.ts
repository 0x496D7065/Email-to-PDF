// Runs quote-marker detection over every synthetic fixture (tests/fixtures),
// parsed by the real .eml and .msg adapters. It measures how much of each
// message is folded and checks the key expectations (README.md, rule R7).

import { describe, expect, it } from 'vitest';
import { parseAllFixtures } from '../../tests/fixtures/parse-all';
import { detectQuoteMarkers } from './quote-markers';
import { buildSegments, checkSegments, reconstruct, type FoldRange } from './segments';

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
    const messages = await parseAllFixtures();
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
