// Runs the real .eml adapter on every synthetic fixture in Helper/Test/test-data/eml/
// and compares the result with Helper/Test/test-data/manifest.ts (README.md, rule R7).

import { describe, expect, it } from 'vitest';
import { FIXTURES, type FixtureExpectation } from '../../Helper/Test/test-data/manifest';
import { createEmlParser } from './eml-parser';
import type { NormalizedMessage } from '../../Header/parsed-email';

const files = import.meta.glob<string>('../../Helper/Test/test-data/eml/*.eml', {
    query: '?raw',
    import: 'default',
    eager: true,
});

// The real HTML-to-text converter needs the browser's DOMParser, which Node
// does not have, and no DOM library is installed (writing a second HTML
// parser just for tests would test that parser, not the browser's). So here
// the converter is a stub that records the HTML it was handed. The real
// conversion of these fixtures, with their bodyContains/bodyExcludes, is
// checked in Chromium by Helper/Test/browser-tests/html-to-text.spec.ts. The stub is NOT a
// converter and must never be used outside tests.
const STUB_PREFIX = '[stub html-to-text]';
/** Every HTML string handed to the stub; the stub's output names the index. */
const htmlCalls: string[] = [];
const parser = createEmlParser({
    htmlToText: (html) => ({ text: `${STUB_PREFIX} #${String(htmlCalls.push(html) - 1)}`, truncated: false }),
});

// Fixtures whose body is HTML-only: their converted text is checked in the
// browser (see above). Every other field (and the 'html-converted-body' warning)
// is checked here.
// The value: a piece of markup the decoded HTML holds (the stub was handed the HTML itself).
const BODY_CHECKS_NEED_HTML_TO_TEXT = new Map([
    ['eml/50-html-only.eml', '<p>Dear Alice,</p>'],
    ['eml/98-phone-forward-android-html.eml', 'Date&nbsp;: 6 oct. 2026 13:58<br>'],
]);

const emlFixtures = FIXTURES.filter((f) => f.kind === 'eml');

async function parseFixture(id: string): Promise<NormalizedMessage>
{
    const raw = files[`../../Helper/Test/test-data/${id}`];
    if (raw === undefined)
    {
        throw new Error(`missing file for ${id}`);
    }
    // Fixtures are 7-bit ASCII (checked by the privacy guard), so this gives the exact file bytes.
    const result = await parser.parse({ name: id, bytes: new TextEncoder().encode(raw) });
    if (!result.ok)
    {
        throw new Error(`${id} failed to parse: ${result.detail}`);
    }
    return result.message;
}

describe('.eml adapter matches the manifest', () =>
{
    it('covers all 39 .eml fixtures', () =>
    {
        expect(emlFixtures).toHaveLength(39);
        expect(Object.keys(files)).toHaveLength(39);
    });

    it.each(emlFixtures.map((f) => [f.id, f] as const))('%s', async (id, expected: FixtureExpectation) =>
    {
        const message = await parseFixture(id);

        expect(message.messageId).toBe(expected.messageId);
        expect(message.inReplyTo).toBe(expected.inReplyTo);
        expect(message.references).toEqual(expected.references);

        expect(message.date.utcMs).toBe(expected.date.utcMs);
        expect(message.date.zoneKnown).toBe(expected.date.zoneKnown);
        if (expected.date.offsetMinutes !== undefined)
        {
            expect(message.date.offsetMinutes).toBe(expected.date.offsetMinutes);
        }

        expect(message.from).toEqual(expected.from);
        expect(message.to).toEqual(expected.to);
        expect(message.cc).toEqual(expected.cc);
        expect(message.bcc).toEqual(expected.bcc);
        // `sender` is either a mailbox or no key at all, never `sender: undefined`.
        expect('sender' in message).toBe(expected.sender !== undefined);
        expect(message.sender).toEqual(expected.sender);
        // The manifest writes a MISSING Subject header as null (fixture 75); the
        // adapter stores it as '' (NormalizedMessage keeps `subject: string`).
        expect(message.subject).toBe(expected.subject ?? '');

        expect(message.attachments).toEqual(expected.attachments);
        expect([...message.warnings].sort()).toEqual([...expected.warnings].sort());

        expect(message.source.fileName).toBe(id);
        expect(message.source.kind).toBe('eml');
        expect(message.source.sha256).toMatch(/^[0-9a-f]{64}$/);

        if (BODY_CHECKS_NEED_HTML_TO_TEXT.has(id))
        {
            // The stub was used, and was handed the DECODED HTML (quoted-printable
            // undone, soft line breaks joined), which holds the visible snippets.
            // The converted text itself is checked in Helper/Test/browser-tests/html-to-text.spec.ts.
            expect(message.bodyText.startsWith(STUB_PREFIX)).toBe(true);
            const html = htmlCalls[Number(message.bodyText.slice(STUB_PREFIX.length + 2))] ?? '';
            expect(html).toContain(BODY_CHECKS_NEED_HTML_TO_TEXT.get(id));
            expect(html).not.toContain('=3D'); // quoted-printable (or base64) was decoded
            for (const snippet of expected.bodyContains)
            {
                expect(html).toContain(snippet);
            }
            return;
        }
        for (const snippet of expected.bodyContains)
        {
            expect(message.bodyText).toContain(snippet);
        }
        for (const snippet of expected.bodyExcludes ?? [])
        {
            expect(message.bodyText).not.toContain(snippet);
        }
    });
});
