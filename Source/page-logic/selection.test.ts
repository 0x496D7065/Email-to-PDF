// Unit tests for the include/exclude choices (selection.ts). Synthetic data only.
import { describe, expect, it } from 'vitest';
import type { EngineMessage } from '../thread-analysis/engine';
import { createSelection, includedPositions, selectionKeys } from './selection';

/** A minimal kept email: only what selection.ts reads (its file hash and its merged copies' hashes). */
function kept(sha256: string, merged: readonly string[] = []): EngineMessage
{
    return {
        message: { source: { fileName: `${sha256}.eml`, sha256, kind: 'eml' } },
        duplicates: merged.map((h, k) => ({ source: { fileName: `${h}.eml`, sha256: h, kind: 'eml' }, index: k + 1, rule: 'message-id' })),
    } as unknown as EngineMessage;
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
    const attached = (sha256: string, path: number[]): EngineMessage =>
        ({ message: { source: { fileName: `${sha256}.eml`, sha256, kind: 'eml', attachedPath: path } }, duplicates: [] }) as unknown as EngineMessage;

    it('adds the place in the file to the file hash', () =>
    {
        expect(selectionKeys(attached('aa', [2, 1]))).toEqual(['aa/2.1']);
    });

    it('gives an attached email its own choice, independent of the email it is attached to (Q2)', () =>
    {
        const s = createSelection();
        const parent = kept('aa');
        const child = attached('aa', [1]);
        const sibling = attached('aa', [2]);
        s.setIncluded(child, false);
        expect([s.isIncluded(parent), s.isIncluded(child), s.isIncluded(sibling)]).toEqual([true, false, true]);
        s.setIncluded(parent, false);
        s.setIncluded(child, true);
        expect([s.isIncluded(parent), s.isIncluded(child)]).toEqual([false, true]);
    });

    it('a dropped copy kept with the attached one merged into it: one choice for both', () =>
    {
        const s = createSelection();
        const merged = {
            message: { source: { fileName: 'bb.eml', sha256: 'bb', kind: 'eml' } },
            duplicates: [{ source: { fileName: 'aa.eml', sha256: 'aa', kind: 'eml', attachedPath: [1] }, index: 3, rule: 'message-id' }],
        } as unknown as EngineMessage;
        expect(selectionKeys(merged)).toEqual(['bb', 'aa/1']);
        s.setIncluded(merged, false);
        expect([s.isIncluded(attached('aa', [1])), s.isIncluded(kept('aa'))]).toEqual([false, true]);
    });
});

describe('createSelection', () =>
{
    it('includes every email until it is left out, and again when ticked back', () =>
    {
        const s = createSelection();
        const a = kept('aa');
        const b = kept('bb');
        expect([s.isIncluded(a), s.isIncluded(b)]).toEqual([true, true]);
        s.setIncluded(a, false);
        expect([s.isIncluded(a), s.isIncluded(b)]).toEqual([false, true]);
        s.setIncluded(a, false); // twice: no change
        expect(s.isIncluded(a)).toBe(false);
        s.setIncluded(a, true);
        expect(s.isIncluded(a)).toBe(true);
    });

    it('keeps the choice when a later run keeps another copy of the same email', () =>
    {
        const s = createSelection();
        // First run: file "aa" kept, nothing merged yet. Left out.
        s.setIncluded(kept('aa'), false);
        // Second run: a copy "bb" (e.g. with a Bcc line) is kept and "aa" merged into it.
        expect(s.isIncluded(kept('bb', ['aa']))).toBe(false);
        // Left out with its merged copy, then a third run splits them again: both stay out.
        const both = createSelection();
        both.setIncluded(kept('bb', ['aa']), false);
        expect([both.isIncluded(kept('aa')), both.isIncluded(kept('bb'))]).toEqual([false, false]);
        // Ticking the merged email back includes every copy.
        both.setIncluded(kept('bb', ['aa']), true);
        expect([both.isIncluded(kept('aa')), both.isIncluded(kept('bb'))]).toEqual([true, true]);
    });

    it('forgets everything on clear()', () =>
    {
        const s = createSelection();
        s.setIncluded(kept('aa'), false);
        s.setIncluded(kept('bb'), false);
        s.clear();
        expect([s.isIncluded(kept('aa')), s.isIncluded(kept('bb'))]).toEqual([true, true]);
    });
});

describe('includedPositions', () =>
{
    it('lists the included positions in list order', () =>
    {
        const s = createSelection();
        const list = [kept('aa'), kept('bb'), kept('cc'), kept('dd')];
        expect(includedPositions(list, s)).toEqual([0, 1, 2, 3]);
        s.setIncluded(list[1]!, false);
        s.setIncluded(list[3]!, false);
        expect(includedPositions(list, s)).toEqual([0, 2]);
        expect(includedPositions([], s)).toEqual([]);
    });
});
