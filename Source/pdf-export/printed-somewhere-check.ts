// "Is this text really printed somewhere in the PDF?" (task 8.13b-3, review
// round 3, finding M2; collapse, never delete, README.md rule R6).
//
// WHAT IT IS USED FOR. The PDF model's PRINTED SOMEWHERE check
// (Source/pdf-export/build-pdf-document.ts, printedNowhere) asks this module about CANDIDATES
// only: in a real email in the PDF whose plan is used (valid, not a
// fallback), a piece its plan leaves out (not a signature) that lies in a
// folded segment whose ONLY reason is 'quoted-overlap' and that is linked
// to an email in the PDF: text with no "> " marks and no reply header of its
// own, left out only because another email in the PDF holds the same words
// (output-plan.ts rule 2, an overlap start). Quoted history under a reply
// header or behind "> " marks, signatures, and the parts the no-repeat rule
// leaves out (printed as another email) are never candidates. Each such
// decision is right almost always, but two of them can point at each other
// (X's paragraph left out "because its reply Y holds it", while Y leaves its
// quote of it out as quoted history). printedNowhere builds the text the PDF
// really prints (add, one piece per printed run of a body, per rebuilt email)
// and, per candidate in PDF order, asks `covers`; a candidate NOT found is
// printed after all (and then counts as printed for the next ones).
//
// HOW TEXT IS COMPARED (the way the overlap detector matches quotes,
// Source/thread-analysis/overlap-quote-detection.ts): only WORDS count (tokenizeWords: letters and
// digits, NFC, lower case), so "> " quote marks, line wrapping, indentation,
// blank lines and punctuation make no difference. Let n be the candidate's
// word count and least = min(MIN_RUN_WORDS, n) (MIN_RUN_WORDS = 12, about
// one sentence). The candidate is FOUND when every one of its words lies
// inside a run of at least `least` consecutive words that is printed, in the
// same order, inside ONE added piece (a run never joins the end of one piece
// and the start of the next). So:
// - n >= 12: found only when whole runs of 12 words or more cover all of it
//   (several runs, from several pieces, may cover it), never from a few
//   common words here and there;
// - 4 <= n < 12 (SHINGLE_WORDS = 4): found only when all n words are
//   printed in a row, in one piece;
// - 1 <= n < 4: the same (all of it in a row), looked for at every place of
//   its rarest word;
// - n = 0 (blank lines, a bare ">", "--"): found: there is nothing in it a
//   reader could miss, and the overlap detector never matches such text.
//
// WHEN UNSURE, NOT FOUND, so the candidate is printed (maybe twice, never
// nowhere): a word printed nowhere makes it not found at once; a run of 4
// or more words is looked for only from the first MAX_POSTINGS places of
// its first SHINGLE_WORDS words (as in overlap-quote-detection.ts), so a run hidden behind
// a very common shingle is missed; and a candidate mixing a short text
// printed alone (fewer than 12 words, say a one-line email) into a longer
// one is not found, since that short text is no run of 12.
//
// Cost: adding text is linear in its length. Checking a text of n words:
// for each word not yet covered, at most MIN_RUN_WORDS starting points,
// each with at most MAX_POSTINGS places, each run compared word by word; a
// found run moves the check past its end, so a long quote printed in one
// piece costs about n x MIN_RUN_WORDS x (places of its shingles). A text of
// fewer than SHINGLE_WORDS words: the places of its rarest word.
//
// Pure: no DOM, no clock, nothing stored (README.md, rules R5 and R7).

import { MAX_POSTINGS, MIN_RUN_WORDS, SHINGLE_WORDS, tokenizeWords } from '../thread-analysis/overlap-quote-detection';

/** The text the PDF prints, built piece by piece, and the check against it. */
export interface PrintedText
{
    /** Adds one piece of printed text (a run of words never goes on from one piece into the next). */
    add(text: string): void;
    /** Whether every word of `text` is inside a long enough run of printed words (see the top of this file). */
    covers(text: string): boolean;
}

/** A 32-bit hash of SHINGLE_WORDS word ids starting at `start` (FNV-1a style); collisions are checked by comparing the words. */
function shingleHashAt(wordIds: readonly number[], start: number): number
{
    let hash = 0x811c9dc5;
    for (let offset = 0; offset < SHINGLE_WORDS; offset++)
    {
        hash = Math.imul(hash ^ (wordIds[start + offset] ?? 0), 0x01000193);
    }
    return hash;
}

/** An empty PrintedText. */
export function createPrintedText(): PrintedText
{
    const vocabulary = new Map<string, number>();
    // Every printed word as an id, and the piece it belongs to.
    const wordIds: number[] = [];
    const pieceOfWord: number[] = [];
    // Shingle hash -> start positions (the first MAX_POSTINGS); word id -> every position.
    const shingles = new Map<number, number[]>();
    const places = new Map<number, number[]>();
    let pieceCount = 0;

    function add(text: string): void
    {
        const words = tokenizeWords(text);
        if (words.length === 0)
        {
            return;
        }
        const pieceIndex = pieceCount++;
        const firstNewWord = wordIds.length;
        for (const word of words)
        {
            let wordId = vocabulary.get(word.key);
            if (wordId === undefined)
            {
                wordId = vocabulary.size;
                vocabulary.set(word.key, wordId);
            }
            const position = wordIds.length;
            wordIds.push(wordId);
            pieceOfWord.push(pieceIndex);
            const positions = places.get(wordId);
            if (positions === undefined)
            {
                places.set(wordId, [position]);
            }
            else
            {
                positions.push(position);
            }
        }
        for (let shingleStart = firstNewWord; shingleStart + SHINGLE_WORDS <= wordIds.length; shingleStart++)
        {
            const hash = shingleHashAt(wordIds, shingleStart);
            const starts = shingles.get(hash);
            if (starts === undefined)
            {
                shingles.set(hash, [shingleStart]);
            }
            else if (starts.length < MAX_POSTINGS)
            {
                starts.push(shingleStart);
            }
        }
    }

    function covers(text: string): boolean
    {
        const words = tokenizeWords(text);
        const n = words.length;
        if (n === 0)
        {
            return true;
        }
        const candidateIds: number[] = [];
        for (const word of words)
        {
            const wordId = vocabulary.get(word.key);
            if (wordId === undefined)
            {
                return false; // a word printed nowhere
            }
            candidateIds.push(wordId);
        }
        // Equal words from candidateStart (in candidateIds) and printedStart (printed), in one piece: how many in a row.
        const runAt = (candidateStart: number, printedStart: number): number =>
        {
            const pieceIndex = pieceOfWord[printedStart];
            let runLength = 0;
            while (candidateStart + runLength < n && printedStart + runLength < wordIds.length
                && wordIds[printedStart + runLength] === candidateIds[candidateStart + runLength]
                && pieceOfWord[printedStart + runLength] === pieceIndex)
            {
                runLength++;
            }
            return runLength;
        };
        if (n < SHINGLE_WORDS)
        {
            // All of it in a row: tried at every place of its rarest word.
            let rarestAt = 0;
            for (let j = 1; j < n; j++)
            {
                if ((places.get(candidateIds[j]!)?.length ?? 0) < (places.get(candidateIds[rarestAt]!)?.length ?? 0))
                {
                    rarestAt = j;
                }
            }
            for (const place of places.get(candidateIds[rarestAt]!) ?? [])
            {
                const printedStart = place - rarestAt;
                if (printedStart >= 0 && runAt(0, printedStart) === n)
                {
                    return true;
                }
            }
            return false;
        }
        const least = Math.min(MIN_RUN_WORDS, n);
        // `firstUncovered`: the first word not covered yet. A run covering it that starts before firstUncovered - least + 1 holds a
        // run of at least `least` words starting there that covers it too, so those starts are enough.
        let firstUncovered = 0;
        while (firstUncovered < n)
        {
            let coveredTo = -1;
            const lastStart = Math.min(firstUncovered, n - SHINGLE_WORDS);
            for (let candidateStart = Math.max(0, firstUncovered - least + 1); candidateStart <= lastStart; candidateStart++)
            {
                for (const printedStart of shingles.get(shingleHashAt(candidateIds, candidateStart)) ?? [])
                {
                    const runLength = runAt(candidateStart, printedStart);
                    if (runLength >= least && candidateStart + runLength > firstUncovered && candidateStart + runLength > coveredTo)
                    {
                        coveredTo = candidateStart + runLength;
                    }
                }
            }
            if (coveredTo < 0)
            {
                return false;
            }
            firstUncovered = coveredTo;
        }
        return true;
    }

    return { add, covers };
}
