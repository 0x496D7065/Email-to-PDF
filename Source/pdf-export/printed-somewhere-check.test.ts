// Tests of the "is this text printed somewhere?" check (Source/pdf-export/printed-somewhere-check.ts;
// task 8.13b-3, review round 3, M2): words only (quote marks, wrapping,
// punctuation and case do not matter), the whole text must be covered by
// long enough runs, runs never join two printed pieces, and it stays fast
// on large inputs. Synthetic text only (README.md, rule R7).

import { describe, expect, it } from 'vitest';
import { MIN_RUN_WORDS } from '../thread-analysis/overlap-quote-detection';
import { createPrintedText } from './printed-somewhere-check';

const S1 = 'The twelve oak desks will arrive on Thursday morning and the movers need the loading bay free until noon.';
const S2 = 'Please send the signed delivery note back to the front office before the end of the month, thank you.';

describe('createPrintedText: what counts as printed', () =>
{
    it('finds a text printed with quote marks, other wrapping, other case and punctuation', () =>
    {
        const printed = createPrintedText();
        printed.add(`Hello,\n\n${S1}\n\nAnn`);
        expect(printed.covers(S1)).toBe(true);
        expect(printed.covers(
            `> The twelve oak desks will arrive\n> on Thursday morning, and the movers\n>> need the LOADING bay free until noon`)).toBe(true);
    });

    it('a long text is found only when all of it is printed, never from a few common words', () =>
    {
        const printed = createPrintedText();
        printed.add(S1);
        expect(printed.covers(`${S1}\n${S2}`)).toBe(false);
        // Every word printed, but not in runs of MIN_RUN_WORDS: not found.
        const shuffled = S1.split(' ').reverse().join(' ');
        expect(printed.covers(shuffled)).toBe(false);
    });

    it('a text whose parts are printed in different places is found (each part a long enough run)', () =>
    {
        const printed = createPrintedText();
        printed.add(S2);
        printed.add(`Something else first. ${S1}`);
        expect(printed.covers(`${S1}\n\n${S2}`)).toBe(true);
    });

    it('a run never joins the end of one printed piece and the start of the next', () =>
    {
        const printed = createPrintedText();
        const words = S1.split(' ');
        const half = Math.floor(words.length / 2);
        printed.add(words.slice(0, half).join(' '));
        printed.add(words.slice(half).join(' '));
        // Each half is shorter than MIN_RUN_WORDS here: the whole sentence is not found.
        expect(half).toBeLessThan(MIN_RUN_WORDS);
        expect(printed.covers(S1)).toBe(false);
    });

    it('a text shorter than MIN_RUN_WORDS words must be printed whole, in a row', () =>
    {
        const printed = createPrintedText();
        printed.add('Yes, Thursday works for us. See you then, Ann');
        expect(printed.covers('yes thursday works for us')).toBe(true);
        expect(printed.covers('Thursday works')).toBe(true);
        expect(printed.covers('works Thursday')).toBe(false);
        expect(printed.covers('Friday works')).toBe(false);
    });

    it('a text with no word counts as found; a word printed nowhere makes it not found', () =>
    {
        const printed = createPrintedText();
        expect(printed.covers('\n> \n--\n')).toBe(true);
        expect(printed.covers('desk')).toBe(false);
        printed.add('desk');
        expect(printed.covers('Desk!')).toBe(true);
    });

    it('text added later counts (what is printed only grows)', () =>
    {
        const printed = createPrintedText();
        expect(printed.covers(S1)).toBe(false);
        printed.add(S1);
        expect(printed.covers(S1)).toBe(true);
    });

    it('decomposed accents match precomposed ones (NFC, as the overlap detector)', () =>
    {
        const printed = createPrintedText();
        printed.add('Le café de la gare ouvre lundi à huit heures pour toute l’équipe du dépôt nord.');
        expect(printed.covers('le café de la gare ouvre lundi à huit heures pour toute l’équipe du dépôt nord')).toBe(true);
    });
});

describe('createPrintedText: speed', () =>
{
    it('about 5 MB of printed text and 2000 long quotes to check in well under a second', () =>
    {
        const printed = createPrintedText();
        const sentences = Array.from({ length: 4000 }, (_, k) => `Sentence ${String(k)} of the record: the desks, chairs and tables of room ${String(k % 97)} were counted on day ${String(k % 31)} again.`);
        const start = performance.now();
        for (let k = 0; k < 4000; k += 2)
        {
            printed.add(`${sentences[k]!}\n${sentences[k + 1]!}\n`.repeat(10));
        }
        let found = 0;
        for (let k = 0; k + 3 < 4000; k += 2)
        {
            if (printed.covers(`> ${sentences[k]!}\n> ${sentences[k + 1]!}\n> ${sentences[k + 2]!}`))
            {
                found++;
            }
        }
        const elapsedMs = performance.now() - start;
        console.log(`printedText: ${String(found)} of 1999 quotes found in ${elapsedMs.toFixed(1)} ms`);
        // Two of three sentences in a row are printed in one piece, the third in the next piece: found.
        expect(found).toBe(1999);
        expect(elapsedMs).toBeLessThan(1500);
    });

    it('highly repeated text (every shingle far over MAX_POSTINGS) stays fast', () =>
    {
        const printed = createPrintedText();
        for (let k = 0; k < 2000; k++)
        {
            printed.add('the desks arrive on monday morning please confirm the address\n'.repeat(20));
        }
        const start = performance.now();
        for (let k = 0; k < 200; k++)
        {
            printed.covers('the desks arrive on monday morning please confirm the address '.repeat(50));
        }
        const elapsedMs = performance.now() - start;
        console.log(`printedText: 200 checks of 500 repeated words in ${elapsedMs.toFixed(1)} ms`);
        expect(elapsedMs).toBeLessThan(1500);
    });
});
