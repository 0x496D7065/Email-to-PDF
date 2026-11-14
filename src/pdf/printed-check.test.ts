// Tests of the "is this text printed somewhere?" check (src/pdf/printed-check.ts;
// task 8.13b-3, review round 3, M2): words only (quote marks, wrapping,
// punctuation and case do not matter), the whole text must be covered by
// long enough runs, runs never join two printed pieces, and it stays fast
// on large inputs. Synthetic text only (README.md, rule R7).

import { describe, expect, it } from 'vitest';
import { MIN_RUN_WORDS } from '../engine/overlap';
import { printedText } from './printed-check';

const S1 = 'The twelve oak desks will arrive on Thursday morning and the movers need the loading bay free until noon.';
const S2 = 'Please send the signed delivery note back to the front office before the end of the month, thank you.';

describe('printedText: what counts as printed', () => {
  it('finds a text printed with quote marks, other wrapping, other case and punctuation', () => {
    const p = printedText();
    p.add(`Hello,\n\n${S1}\n\nAnn`);
    expect(p.covers(S1)).toBe(true);
    expect(p.covers(`> The twelve oak desks will arrive\n> on Thursday morning, and the movers\n>> need the LOADING bay free until noon`)).toBe(true);
  });

  it('a long text is found only when all of it is printed, never from a few common words', () => {
    const p = printedText();
    p.add(S1);
    expect(p.covers(`${S1}\n${S2}`)).toBe(false);
    // Every word printed, but not in runs of MIN_RUN_WORDS: not found.
    const shuffled = S1.split(' ').reverse().join(' ');
    expect(p.covers(shuffled)).toBe(false);
  });

  it('a text whose parts are printed in different places is found (each part a long enough run)', () => {
    const p = printedText();
    p.add(S2);
    p.add(`Something else first. ${S1}`);
    expect(p.covers(`${S1}\n\n${S2}`)).toBe(true);
  });

  it('a run never joins the end of one printed piece and the start of the next', () => {
    const p = printedText();
    const words = S1.split(' ');
    const half = Math.floor(words.length / 2);
    p.add(words.slice(0, half).join(' '));
    p.add(words.slice(half).join(' '));
    // Each half is shorter than MIN_RUN_WORDS here: the whole sentence is not found.
    expect(half).toBeLessThan(MIN_RUN_WORDS);
    expect(p.covers(S1)).toBe(false);
  });

  it('a text shorter than MIN_RUN_WORDS words must be printed whole, in a row', () => {
    const p = printedText();
    p.add('Yes, Thursday works for us. See you then, Ann');
    expect(p.covers('yes thursday works for us')).toBe(true);
    expect(p.covers('Thursday works')).toBe(true);
    expect(p.covers('works Thursday')).toBe(false);
    expect(p.covers('Friday works')).toBe(false);
  });

  it('a text with no word counts as found; a word printed nowhere makes it not found', () => {
    const p = printedText();
    expect(p.covers('\n> \n--\n')).toBe(true);
    expect(p.covers('desk')).toBe(false);
    p.add('desk');
    expect(p.covers('Desk!')).toBe(true);
  });

  it('text added later counts (what is printed only grows)', () => {
    const p = printedText();
    expect(p.covers(S1)).toBe(false);
    p.add(S1);
    expect(p.covers(S1)).toBe(true);
  });

  it('decomposed accents match precomposed ones (NFC, as the overlap detector)', () => {
    const p = printedText();
    p.add('Le café de la gare ouvre lundi à huit heures pour toute l’équipe du dépôt nord.');
    expect(p.covers('le café de la gare ouvre lundi à huit heures pour toute l’équipe du dépôt nord')).toBe(true);
  });
});

describe('printedText: speed', () => {
  it('about 5 MB of printed text and 2000 long quotes to check in well under a second', () => {
    const p = printedText();
    const sentences = Array.from({ length: 4000 }, (_, k) => `Sentence ${String(k)} of the record: the desks, chairs and tables of room ${String(k % 97)} were counted on day ${String(k % 31)} again.`);
    const start = performance.now();
    for (let k = 0; k < 4000; k += 2) p.add(`${sentences[k]!}\n${sentences[k + 1]!}\n`.repeat(10));
    let found = 0;
    for (let k = 0; k + 3 < 4000; k += 2) if (p.covers(`> ${sentences[k]!}\n> ${sentences[k + 1]!}\n> ${sentences[k + 2]!}`)) found++;
    const ms = performance.now() - start;
    console.log(`printedText: ${String(found)} of 1999 quotes found in ${ms.toFixed(1)} ms`);
    // Two of three sentences in a row are printed in one piece, the third in the next piece: found.
    expect(found).toBe(1999);
    expect(ms).toBeLessThan(1500);
  });

  it('highly repeated text (every shingle far over MAX_POSTINGS) stays fast', () => {
    const p = printedText();
    for (let k = 0; k < 2000; k++) p.add('the desks arrive on monday morning please confirm the address\n'.repeat(20));
    const start = performance.now();
    for (let k = 0; k < 200; k++) p.covers('the desks arrive on monday morning please confirm the address '.repeat(50));
    const ms = performance.now() - start;
    console.log(`printedText: 200 checks of 500 repeated words in ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(1500);
  });
});
