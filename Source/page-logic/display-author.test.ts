// Unit tests for the shown author (display-author.ts), with synthetic
// mailboxes and the parsed synthetic fixtures (README.md, rule R7).

import { describe, expect, it } from 'vitest';
import { parseAllFixtures } from '../../Helper/Test/test-data/parse-all';
import type { EmailAddress } from '../email-reading/types';
import { displayAuthor } from './display-author';

const ALICE: EmailAddress = { name: 'Alice Example', address: 'alice@example.test' };
const BOB: EmailAddress = { name: 'Bob Sample', address: 'bob@example.test' };
const CAROL: EmailAddress = { name: 'Carol Test', address: 'carol@example.test' };

describe('displayAuthor', () =>
{
    it('shows the From mailboxes, all of them, in order', () =>
    {
        expect(displayAuthor({ from: [ALICE, BOB] })).toEqual({ source: 'from', mailboxes: [ALICE, BOB] });
    });

    it('From wins over the sender ("sent on behalf of" keeps the author)', () =>
    {
        expect(displayAuthor({ from: [ALICE], sender: CAROL })).toEqual({ source: 'from', mailboxes: [ALICE] });
    });

    it('an empty From with a sender present shows the sender', () =>
    {
        expect(displayAuthor({ from: [], sender: CAROL })).toEqual({ source: 'sender', mailboxes: [CAROL] });
    });

    it('From entries with neither name nor address count as empty', () =>
    {
        const blank = { name: ' ', address: '' };
        expect(displayAuthor({ from: [blank], sender: CAROL })).toEqual({ source: 'sender', mailboxes: [CAROL] });
        expect(displayAuthor({ from: [blank, BOB] })).toEqual({ source: 'from', mailboxes: [BOB] });
    });

    it('a name alone or an address alone is enough', () =>
    {
        const nameOnly = { name: 'Alice Example', address: '' };
        const addressOnly = { name: '', address: 'bob@example.test' };
        expect(displayAuthor({ from: [nameOnly] }).mailboxes).toEqual([nameOnly]);
        expect(displayAuthor({ from: [], sender: addressOnly }).mailboxes).toEqual([addressOnly]);
    });

    it('neither From nor sender: the "none" marker', () =>
    {
        expect(displayAuthor({ from: [] })).toEqual({ source: 'none', mailboxes: [] });
        expect(displayAuthor({ from: [], sender: { name: '', address: '' } })).toEqual({ source: 'none', mailboxes: [] });
    });

    it('never changes the message', () =>
    {
        const message = Object.freeze({ from: Object.freeze([ALICE]), sender: Object.freeze(CAROL) });
        expect(() => displayAuthor(message)).not.toThrow();
    });

    it('every parsed fixture shows its From; only the one without a From shows the marker', async () =>
    {
        for (const m of await parseAllFixtures())
        {
            const shown = displayAuthor(m);
            const file = m.source.fileName;
            if (m.from.length > 0)
            {
                expect(shown.source, file).toBe('from');
            }
            else
            {
                expect(shown.source, file).toBe(m.sender === undefined ? 'none' : 'sender');
            }
        }
        const missing = (await parseAllFixtures()).find((m) => m.source.fileName === 'eml/75-missing-from-to-subject.eml');
        expect(missing && displayAuthor(missing).source).toBe('none');
    });
});
