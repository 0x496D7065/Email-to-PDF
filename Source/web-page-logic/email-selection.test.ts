// Unit tests for the include/exclude choices (email-selection.ts). Synthetic data only.
import { describe, expect, it } from 'vitest';
import { createEmailSelection, includedPositions, selectionKeys } from './email-selection';
import type { AnalyzedMessage } from '../../Header/thread-analysis-result';

/** A minimal kept email: only what email-selection.ts reads (its file hash and its merged copies' hashes). */
function kept(sha256: string, merged: readonly string[] = []): AnalyzedMessage
{
    return {
        message: { source: { fileName: `${sha256}.eml`, sha256, kind: 'eml' } },
        duplicates: merged.map((h, k) => ({ source: { fileName: `${h}.eml`, sha256: h, kind: 'eml' }, index: k + 1, rule: 'message-id' })),
    } as unknown as AnalyzedMessage;
}

describe('selectionKeys', () =>
{
    it('is the file hash of the kept copy, then those of its merged copies, without repeats', () =>
    {
        expect(selectionKeys(kept('aa'))).toEqual(['aa']);
        expect(selectionKeys(kept('aa', ['bb', 'cc']))).toEqual(['aa', 'bb', 'cc']);
        // The same file added twice and merged: one key.
        expect(selectionKeys(kept('aa', ['aa', 'bb']))).toEqual(['aa', 'bb']);
    });
});

describe('selectionKeys: emails attached inside a file (task 8.13b-3)', () =>
{
    /** An email attached inside file `sha256` at `path`. */
    const attached = (sha256: string, path: number[]): AnalyzedMessage =>
        ({ message: { source: { fileName: `${sha256}.eml`, sha256, kind: 'eml', attachedPath: path } },
            duplicates: [] }) as unknown as AnalyzedMessage;

    it('adds the place in the file to the file hash', () =>
    {
        expect(selectionKeys(attached('aa', [2, 1]))).toEqual(['aa/2.1']);
    });

    it('gives an attached email its own choice, independent of the email it is attached to (Q2)', () =>
    {
        const selection = createEmailSelection();
        const parent = kept('aa');
        const child = attached('aa', [1]);
        const sibling = attached('aa', [2]);
        selection.setIncluded(child, false);
        expect([selection.isIncluded(parent), selection.isIncluded(child), selection.isIncluded(sibling)]).toEqual([true, false, true]);
        selection.setIncluded(parent, false);
        selection.setIncluded(child, true);
        expect([selection.isIncluded(parent), selection.isIncluded(child)]).toEqual([false, true]);
    });

    it('a dropped copy kept with the attached one merged into it: one choice for both', () =>
    {
        const selection = createEmailSelection();
        const merged = {
            message: { source: { fileName: 'bb.eml', sha256: 'bb', kind: 'eml' } },
            duplicates: [{ source: { fileName: 'aa.eml', sha256: 'aa', kind: 'eml', attachedPath: [1] }, index: 3, rule: 'message-id' }],
        } as unknown as AnalyzedMessage;
        expect(selectionKeys(merged)).toEqual(['bb', 'aa/1']);
        selection.setIncluded(merged, false);
        expect([selection.isIncluded(attached('aa', [1])), selection.isIncluded(kept('aa'))]).toEqual([false, true]);
    });
});

describe('createSelection', () =>
{
    it('includes every email until it is left out, and again when ticked back', () =>
    {
        const selection = createEmailSelection();
        const first = kept('aa');
        const second = kept('bb');
        expect([selection.isIncluded(first), selection.isIncluded(second)]).toEqual([true, true]);
        selection.setIncluded(first, false);
        expect([selection.isIncluded(first), selection.isIncluded(second)]).toEqual([false, true]);
        selection.setIncluded(first, false); // twice: no change
        expect(selection.isIncluded(first)).toBe(false);
        selection.setIncluded(first, true);
        expect(selection.isIncluded(first)).toBe(true);
    });

    it('keeps the choice when a later run keeps another copy of the same email', () =>
    {
        const selection = createEmailSelection();
        // First run: file "aa" kept, nothing merged yet. Left out.
        selection.setIncluded(kept('aa'), false);
        // Second run: a copy "bb" (e.g. with a Bcc line) is kept and "aa" merged into it.
        expect(selection.isIncluded(kept('bb', ['aa']))).toBe(false);
        // Left out with its merged copy, then a third run splits them again: both stay out.
        const both = createEmailSelection();
        both.setIncluded(kept('bb', ['aa']), false);
        expect([both.isIncluded(kept('aa')), both.isIncluded(kept('bb'))]).toEqual([false, false]);
        // Ticking the merged email back includes every copy.
        both.setIncluded(kept('bb', ['aa']), true);
        expect([both.isIncluded(kept('aa')), both.isIncluded(kept('bb'))]).toEqual([true, true]);
    });

    it('forgets everything on clear()', () =>
    {
        const selection = createEmailSelection();
        selection.setIncluded(kept('aa'), false);
        selection.setIncluded(kept('bb'), false);
        selection.clear();
        expect([selection.isIncluded(kept('aa')), selection.isIncluded(kept('bb'))]).toEqual([true, true]);
    });
});

describe('includedPositions', () =>
{
    it('lists the included positions in list order', () =>
    {
        const selection = createEmailSelection();
        const list = [kept('aa'), kept('bb'), kept('cc'), kept('dd')];
        expect(includedPositions(list, selection)).toEqual([0, 1, 2, 3]);
        selection.setIncluded(list[1]!, false);
        selection.setIncluded(list[3]!, false);
        expect(includedPositions(list, selection)).toEqual([0, 2]);
        expect(includedPositions([], selection)).toEqual([]);
    });
});
