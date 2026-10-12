// Runs the real .eml adapter on every synthetic fixture in tests/fixtures/eml/
// and compares the result with tests/fixtures/manifest.ts (README.md, rule R7).

import { describe, expect, it } from 'vitest';
import { FIXTURES, type FixtureExpectation } from '../../tests/fixtures/manifest';
import { createEmlParser } from './eml';
import type { NormalizedMessage } from './types';

const files = import.meta.glob<string>('../../tests/fixtures/eml/*.eml', {
  query: '?raw',
  import: 'default',
  eager: true,
});

// HTML-to-text is a later task (2.6). This stub only marks that the HTML path
// was taken; it is NOT a converter and must never be used outside tests.
const STUB_PREFIX = '[stub html-to-text]';
const parser = createEmlParser({ htmlToText: (html) => `${STUB_PREFIX} ${html.length} chars` });

// Fixtures whose body is HTML-only: their bodyContains/bodyExcludes need the
// real HTML-to-text step, so those two checks wait for task 2.6. Every other
// field (and the 'html-only-body' warning) is still checked now.
const BODY_CHECKS_NEED_HTML_TO_TEXT = new Set(['eml/50-html-only.eml']);

const emlFixtures = FIXTURES.filter((f) => f.kind === 'eml');

async function parseFixture(id: string): Promise<NormalizedMessage> {
  const raw = files[`../../tests/fixtures/${id}`];
  if (raw === undefined) throw new Error(`missing file for ${id}`);
  // Fixtures are 7-bit ASCII (checked by the privacy guard), so this gives the exact file bytes.
  const result = await parser.parse({ name: id, bytes: new TextEncoder().encode(raw) });
  if (!result.ok) throw new Error(`${id} failed to parse: ${result.detail}`);
  return result.message;
}

describe('.eml adapter matches the manifest', () => {
  it('covers all 30 .eml fixtures', () => {
    expect(emlFixtures).toHaveLength(30);
    expect(Object.keys(files)).toHaveLength(30);
  });

  it.each(emlFixtures.map((f) => [f.id, f] as const))('%s', async (id, expected: FixtureExpectation) => {
    const message = await parseFixture(id);

    expect(message.messageId).toBe(expected.messageId);
    expect(message.inReplyTo).toBe(expected.inReplyTo);
    expect(message.references).toEqual(expected.references);

    expect(message.date.utcMs).toBe(expected.date.utcMs);
    expect(message.date.zoneKnown).toBe(expected.date.zoneKnown);
    if (expected.date.offsetMinutes !== undefined) expect(message.date.offsetMinutes).toBe(expected.date.offsetMinutes);

    expect(message.from).toEqual(expected.from);
    expect(message.to).toEqual(expected.to);
    expect(message.cc).toEqual(expected.cc);
    // The manifest writes a MISSING Subject header as null (fixture 75); the
    // adapter stores it as '' (NormalizedMessage keeps `subject: string`).
    expect(message.subject).toBe(expected.subject ?? '');

    expect(message.attachments).toEqual(expected.attachments);
    expect([...message.warnings].sort()).toEqual([...expected.warnings].sort());

    expect(message.source.fileName).toBe(id);
    expect(message.source.kind).toBe('eml');
    expect(message.source.sha256).toMatch(/^[0-9a-f]{64}$/);

    if (BODY_CHECKS_NEED_HTML_TO_TEXT.has(id)) {
      // Deferred to task 2.6 (see above). For now: the stub was used.
      expect(message.bodyText.startsWith(STUB_PREFIX)).toBe(true);
      return;
    }
    for (const snippet of expected.bodyContains) expect(message.bodyText).toContain(snippet);
    for (const snippet of expected.bodyExcludes ?? []) expect(message.bodyText).not.toContain(snippet);
  });

  // Placeholder so the deferred checks stay visible in the test report.
  it.todo('50-html-only: bodyContains/bodyExcludes after the real HTML-to-text (task 2.6)');
});
