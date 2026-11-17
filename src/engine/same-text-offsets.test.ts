// mapOffsets (task 8.13b-3, review round 4): offsets between two copies of
// the same text, as de-duplication compares bodies. Synthetic text only.

import { describe, expect, it } from 'vitest';
import { normalizeBody } from './dedupe';
import { mapOffsets } from './same-text-offsets';

describe('mapOffsets', () =>
{
    it('identical texts: the same offsets', () =>
    {
        expect(mapOffsets('abc\ndef', 'abc\ndef', [0, 2, 4, 7])).toEqual([0, 2, 4, 7]);
    });

    it('other line ends (CRLF / LF / CR): line starts, columns and line ends follow', () =>
    {
        const from = 'Hello team,\n\nThe oak desks.\nKind regards\n';
        const to = 'Hello team,\r\n\r\nThe oak desks.\r\nKind regards\r\n';
        const at = from.indexOf('oak');
        const [start, mid, end, last] = mapOffsets(from, to, [from.indexOf('The'), at, from.indexOf('\nKind'), from.length]) as [number, number, number, number];
        expect(to.slice(start, start + 3)).toBe('The');
        expect(to.slice(mid, mid + 3)).toBe('oak');
        expect(to.slice(end, end + 2)).toBe('\r\n');
        expect(last).toBe(to.length);
        expect(mapOffsets('a\rb', 'a\nb', [2])).toEqual([2]);
    });

    it('trailing spaces and blank lines at the very start and end', () =>
    {
        const from = '\n\nfirst line   \nsecond\n\n\n';
        const to = 'first line\nsecond';
        expect(mapOffsets(from, to, [0, from.indexOf('first'), from.indexOf('second'), from.indexOf('   '), from.length])).toEqual([0, 0, to.indexOf('second'), 'first line'.length, to.length]);
        // Inside the trailing blank lines (not the very end): the end of the last line with text.
        expect(mapOffsets(from, to, [from.length - 1])).toEqual([to.length]);
    });

    it('NFC: a composed and a decomposed accent are the same line; a column after it in a line written differently is not sure', () =>
    {
        const from = 'Caf\u{0065}\u{0301} ouvert\nfin';
        const to = 'Caf\u{00E9} ouvert\nfin';
        expect(normalizeBody(from)).toBe(normalizeBody(to));
        expect(mapOffsets(from, to, [0, from.indexOf('fin'), from.indexOf('\n')])).toEqual([0, to.indexOf('fin'), to.indexOf('\n')]);
        expect(mapOffsets(from, to, [from.indexOf('ouvert')])).toBeNull();
        // Before the accent the line is written the same: that column is sure.
        expect(mapOffsets(from, to, [2])).toEqual([2]);
    });

    it('different texts, or offsets out of range: null', () =>
    {
        expect(mapOffsets('one\ntwo', 'one\nthree', [0])).toBeNull();
        expect(mapOffsets('one\ntwo', 'one\n\ntwo', [0])).toBeNull();
        expect(mapOffsets('one', 'one ', [-1])).toBeNull();
        expect(mapOffsets('one', 'one ', [4])).toBeNull();
        expect(mapOffsets('one', 'one ', [1.5])).toBeNull();
    });

    it('only blank lines on both sides', () =>
    {
        expect(mapOffsets('\n \n', '', [0, 1, 3])).toEqual([0, 0, 0]);
        // The very end maps to the very end.
        expect(mapOffsets('', '\r\n', [0])).toEqual([2]);
    });

    it('random copies that normalizeBody calls equal: every line start maps to the same line', () =>
    {
        let seed = 7;
        const random = (): number =>
        {
            seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
            return seed / 4294967296;
        };
        for (let round = 0; round < 300; round++)
        {
            const lines = Array.from({ length: 1 + Math.floor(random() * 6) }, (_, k) => (random() < 0.2 ? '' : `line ${String(k)} caf\u{00E9}`));
            const write = (decompose: boolean): string =>
            {
                // A lone CR before an empty line ending in LF would read as one CRLF: lone CRs are tested above.
                const ends = ['\n', '\r\n', '\n'];
                const pad = (): string => (random() < 0.5 ? '' : ' \t ');
                const body = lines.map((l) => `${decompose ? l.normalize('NFD') : l}${pad()}`);
                const lead = random() < 0.3 ? ['', ' '] : [];
                return [...lead, ...body, ...(random() < 0.5 ? [''] : [])].map((l) => `${l}${ends[Math.floor(random() * 3)]!}`).join('');
            };
            const from = write(false);
            const to = write(random() < 0.5);
            expect(normalizeBody(from)).toBe(normalizeBody(to));
            const starts = [0];
            for (let k = 0; k < from.length; k++) if (from[k] === '\n' || (from[k] === '\r' && from[k + 1] !== '\n')) starts.push(k + 1);
            const mapped = mapOffsets(from, to, starts);
            expect(mapped).not.toBeNull();
            // Each line with text keeps its text after the mapped offset.
            starts.forEach((s, k) =>
            {
                const text = from.slice(s).split(/\r\n|\r|\n/u)[0]!.replace(/[ \t]+$/u, '');
                if (text === '') return;
                expect(to.slice(mapped![k]).normalize('NFC').startsWith(text.normalize('NFC')), `round ${String(round)} line ${String(k)}`).toBe(true);
            });
        }
    });
});
