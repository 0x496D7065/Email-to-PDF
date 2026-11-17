// "Is this text really printed somewhere in the PDF?" (task 8.13b-3, review
// round 3, finding M2; collapse, never delete, README.md rule R6).
//
// WHAT IT IS USED FOR. The PDF model's PRINTED SOMEWHERE check
// (Source/pdf-export/model.ts, printedNowhere) asks this module about CANDIDATES
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
// Source/thread-analysis/overlap.ts): only WORDS count (tokenizeWords: letters and
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
// its first SHINGLE_WORDS words (as in overlap.ts), so a run hidden behind
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

import { MAX_POSTINGS, MIN_RUN_WORDS, SHINGLE_WORDS, tokenizeWords } from '../thread-analysis/overlap';

/** The text the PDF prints, built piece by piece, and the check against it. */
export interface PrintedText
{
    /** Adds one piece of printed text (a run of words never goes on from one piece into the next). */
    add(text: string): void;
    /** Whether every word of `text` is inside a long enough run of printed words (see the top of this file). */
    covers(text: string): boolean;
}

/** A 32-bit hash of SHINGLE_WORDS word ids starting at `at` (FNV-1a style); collisions are checked by comparing the words. */
function hashAt(ids: readonly number[], at: number): number
{
    let h = 0x811c9dc5;
    for (let t = 0; t < SHINGLE_WORDS; t++)
    {
        h = Math.imul(h ^ (ids[at + t] ?? 0), 0x01000193);
    }
    return h;
}

/** An empty PrintedText. */
export function printedText(): PrintedText
{
    const vocabulary = new Map<string, number>();
    // Every printed word as an id, and the piece it belongs to.
    const ids: number[] = [];
    const pieceOf: number[] = [];
    // Shingle hash -> start positions (the first MAX_POSTINGS); word id -> every position.
    const shingles = new Map<number, number[]>();
    const places = new Map<number, number[]>();
    let pieces = 0;

    function add(text: string): void
    {
        const words = tokenizeWords(text);
        if (words.length === 0)
        {
            return;
        }
        const piece = pieces++;
        const from = ids.length;
        for (const w of words)
        {
            let id = vocabulary.get(w.key);
            if (id === undefined)
            {
                id = vocabulary.size;
                vocabulary.set(w.key, id);
            }
            const at = ids.length;
            ids.push(id);
            pieceOf.push(piece);
            const list = places.get(id);
            if (list === undefined)
            {
                places.set(id, [at]);
            }
            else
            {
                list.push(at);
            }
        }
        for (let g = from; g + SHINGLE_WORDS <= ids.length; g++)
        {
            const h = hashAt(ids, g);
            const list = shingles.get(h);
            if (list === undefined)
            {
                shingles.set(h, [g]);
            }
            else if (list.length < MAX_POSTINGS)
            {
                list.push(g);
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
        const c: number[] = [];
        for (const w of words)
        {
            const id = vocabulary.get(w.key);
            if (id === undefined)
            {
                return false; // a word printed nowhere
            }
            c.push(id);
        }
        // Equal words from s (in c) and g (printed), in one piece: how many in a row.
        const runAt = (s: number, g: number): number =>
        {
            const piece = pieceOf[g];
            let len = 0;
            while (s + len < n && g + len < ids.length && ids[g + len] === c[s + len] && pieceOf[g + len] === piece)
            {
                len++;
            }
            return len;
        };
        if (n < SHINGLE_WORDS)
        {
            // All of it in a row: tried at every place of its rarest word.
            let rare = 0;
            for (let j = 1; j < n; j++)
            {
                if ((places.get(c[j]!)?.length ?? 0) < (places.get(c[rare]!)?.length ?? 0))
                {
                    rare = j;
                }
            }
            for (const p of places.get(c[rare]!) ?? [])
            {
                const g = p - rare;
                if (g >= 0 && runAt(0, g) === n)
                {
                    return true;
                }
            }
            return false;
        }
        const least = Math.min(MIN_RUN_WORDS, n);
        // `e`: the first word not covered yet. A run covering it that starts before e - least + 1 holds a
        // run of at least `least` words starting there that covers it too, so those starts are enough.
        let e = 0;
        while (e < n)
        {
            let reach = -1;
            const last = Math.min(e, n - SHINGLE_WORDS);
            for (let s = Math.max(0, e - least + 1); s <= last; s++)
            {
                for (const g of shingles.get(hashAt(c, s)) ?? [])
                {
                    const len = runAt(s, g);
                    if (len >= least && s + len > e && s + len > reach)
                    {
                        reach = s + len;
                    }
                }
            }
            if (reach < 0)
            {
                return false;
            }
            e = reach;
        }
        return true;
    }

    return { add, covers };
}
