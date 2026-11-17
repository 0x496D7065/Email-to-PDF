// Runs the real .msg adapter on every synthetic .msg spec in
// Helper/Test/test-data/msg/specs.ts (built in memory, never stored on disk) and
// compares the result with Helper/Test/test-data/manifest.ts (README.md, rule R7).

import { describe, expect, it } from 'vitest';
import { FIXTURES, type FixtureExpectation } from '../../Helper/Test/test-data/manifest';
import { buildMsg } from '../../Helper/Test/test-data/msg/builder';
import { MSG_SPECS } from '../../Helper/Test/test-data/msg/specs';
import { createEmlParser } from './eml';
import type { HtmlToTextResult } from './html-to-text';
import { createMsgParser } from './msg';
import type { NormalizedMessage } from '../../Header/parsed-email';

// The real HTML-to-text converter needs the browser's DOMParser, which Node
// does not have, and no DOM library is installed. So here the converter is a
// stub that only marks that the HTML path was taken. The real converter is
// checked in Chromium by Helper/Test/browser-tests/html-to-text.spec.ts. The stub is NOT a
// converter and must never be used outside tests.
const STUB_PREFIX = '[stub html-to-text]';
/** Every HTML string handed to the stub; the stub's output names the index (as in eml.manifest.test.ts). */
const htmlCalls: string[] = [];
const htmlToText = (html: string): HtmlToTextResult => ({ text: `${STUB_PREFIX} #${String(htmlCalls.push(html) - 1)}`, truncated: false });
const msgParser = createMsgParser({ htmlToText });
const emlParser = createEmlParser({ htmlToText });

const emlFiles = import.meta.glob<string>('../../Helper/Test/test-data/eml/*.eml', {
    query: '?raw',
    import: 'default',
    eager: true,
});

// Fixtures whose body is HTML-only: their converted text is checked in the
// browser (Helper/Test/browser-tests/full-flow.spec.ts, with the real converter). Every other field
// (and the 'html-converted-body' warning) is checked here.
const BODY_CHECKS_NEED_HTML_TO_TEXT = new Set(['msg-13-html-only']);

const msgFixtures = FIXTURES.filter((f) => f.kind === 'msg');

async function parseMsgFixture(id: string): Promise<NormalizedMessage>
{
    const spec = MSG_SPECS.find((s) => s.id === id);
    if (spec === undefined)
    {
        throw new Error(`missing spec for ${id}`);
    }
    const result = await msgParser.parse({ name: `${id}.msg`, bytes: buildMsg(spec) });
    if (!result.ok)
    {
        throw new Error(`${id} failed to parse: ${result.detail}`);
    }
    return result.message;
}

async function parseEmlFixture(id: string): Promise<NormalizedMessage>
{
    const raw = emlFiles[`../../Helper/Test/test-data/${id}`];
    if (raw === undefined)
    {
        throw new Error(`missing file for ${id}`);
    }
    // Fixtures are 7-bit ASCII (checked by the privacy guard), so this gives the exact file bytes.
    const result = await emlParser.parse({ name: id, bytes: new TextEncoder().encode(raw) });
    if (!result.ok)
    {
        throw new Error(`${id} failed to parse: ${result.detail}`);
    }
    return result.message;
}

describe('.msg adapter matches the manifest', () =>
{
    it('covers all 13 .msg specs', () =>
    {
        expect(msgFixtures).toHaveLength(13);
        expect(MSG_SPECS).toHaveLength(13);
    });

    it.each(msgFixtures.map((f) => [f.id, f] as const))('%s', async (id, expected: FixtureExpectation) =>
    {
        const message = await parseMsgFixture(id);

        expect(message.messageId).toBe(expected.messageId);
        expect(message.inReplyTo).toBe(expected.inReplyTo);
        expect(message.references).toEqual(expected.references);

        // .msg dates (see the manifest header): exact UTC instant, zone known,
        // offsetMinutes not asserted unless the manifest gives it.
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
        expect(message.subject).toBe(expected.subject ?? '');

        expect(message.attachments).toEqual(expected.attachments);
        expect([...message.warnings].sort()).toEqual([...expected.warnings].sort());

        expect(message.source.fileName).toBe(`${id}.msg`);
        expect(message.source.kind).toBe('msg');
        expect(message.source.sha256).toMatch(/^[0-9a-f]{64}$/);

        if (BODY_CHECKS_NEED_HTML_TO_TEXT.has(id))
        {
            // The stub was used, and was handed the HTML body as stored, which holds
            // the snippets that need no tag removal.
            expect(message.bodyText.startsWith(STUB_PREFIX)).toBe(true);
            const html = htmlCalls[Number(message.bodyText.slice(STUB_PREFIX.length + 2))] ?? '';
            expect(html).toContain('<p>Hello Alice,</p>');
            expect(html).toContain('Plan your route');
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
        // Outlook stores CRLF; the adapter gives LF line ends like the .eml adapter.
        expect(message.bodyText).not.toContain('\r');
    });
});

// A message saved from Outlook (.msg) and the same message as .eml must
// normalize to the same values, or de-duplication (Milestone 3) cannot see
// that they are one message. The manifest marks such pairs with the same
// `duplicateGroup`.
describe('cross-format duplicates normalize alike', () =>
{
    const pairs = msgFixtures.flatMap((m) =>
        FIXTURES.filter((e) => e.kind === 'eml' && m.duplicateGroup !== undefined && e.duplicateGroup === m.duplicateGroup).map(
            (e) => [m.id, e.id] as const,
        ),
    );

    it('the manifest has at least one .msg/.eml duplicate pair', () =>
    {
        expect(pairs.length).toBeGreaterThan(0);
    });

    it.each(pairs)('%s = %s', async (msgId, emlId) =>
    {
        const fromMsg = await parseMsgFixture(msgId);
        const fromEml = await parseEmlFixture(emlId);

        expect(fromMsg.messageId).toBe(fromEml.messageId);
        expect(fromMsg.inReplyTo).toBe(fromEml.inReplyTo);
        expect(fromMsg.references).toEqual(fromEml.references);
        expect(fromMsg.date.utcMs).toBe(fromEml.date.utcMs);
        expect(fromMsg.from).toEqual(fromEml.from);
        expect(fromMsg.to).toEqual(fromEml.to);
        expect(fromMsg.cc).toEqual(fromEml.cc);
        expect(fromMsg.bcc).toEqual(fromEml.bcc);
        expect(fromMsg.sender).toEqual(fromEml.sender);
        expect(fromMsg.subject).toBe(fromEml.subject);
        expect(fromMsg.attachments).toEqual(fromEml.attachments);
        // Same text and same line ends. Only the final line break may differ:
        // the .eml body ends with one, the Outlook body property does not.
        expect(fromMsg.bodyText.trimEnd()).toBe(fromEml.bodyText.trimEnd());
    });
});
