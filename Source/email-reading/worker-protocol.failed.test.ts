// The worker side's last line of defence (worker-protocol.ts): if parsing
// ever rejects (a bug: the adapters turn every bad file into a result), the
// worker answers 'failed' instead of going silent, so the page can fail that
// one file at once. Kept in its own file because it replaces deferred-html.ts
// with a mock for the whole file.

import { describe, expect, it, vi } from 'vitest';
import { createWorkerSide } from './worker-protocol';
import type { FromWorker } from '../../Header/parse-worker-messages';

vi.mock('./deferred-html', () => ({
    parseWithDeferredHtml: () => Promise.reject(new TypeError('internal bug')),
}));

describe('createWorkerSide when parsing rejects', () =>
{
    it("posts { type: 'failed' } without any error text", async () =>
    {
        const posted: FromWorker[] = [];
        const handle = createWorkerSide((message) => posted.push(message));
        handle({ type: 'parse', name: 'a.eml', kind: 'eml', bytes: new Uint8Array([0x41]) });
        await vi.waitFor(() => expect(posted).toEqual([{ type: 'failed' }]));
    });
});
