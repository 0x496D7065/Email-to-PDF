// Unit tests for Source/web-page-logic/file-chain.ts (task 8.13b-4, P2 / Q3): the one
// helper behind the PDF's File row and the preview's "Also in" row.
// Synthetic data only (README.md, rule R7).

import { describe, expect, it } from 'vitest';
import { FILE_CHAIN_SEPARATOR as PDF_SEPARATOR } from '../pdf-export/build-pdf-document';
import { FILE_CHAIN_SEPARATOR, fileChain, type FileChainWords } from './file-chain';
import type { AnalyzedAttachedMessage, ThreadAnalysisResult } from '../../Header/thread-analysis-result';

const words: FileChainWords = { noFileName: '(no name)', attachedNoName: (n) => `(attached ${String(n)})` };

/** A result with 2 dropped files and the given attached entries (input positions 2, 3, ...). */
function resultWith(
    ...attached: Omit<AnalyzedAttachedMessage, 'index' | 'fileIndex' | 'places' | 'keptShowsHeader'>[]
): Pick<ThreadAnalysisResult, 'attached' | 'counts'>
{
    return {
        counts: { filesGiven: 2, messagesFound: 2 + attached.length, duplicatesMerged: 0, filesFailed: 0, undated: 0, withFolds: 0 },
        ...(attached.length === 0
            ? {}
            : { attached: attached.map((a, k) => ({ ...a, index: 2 + k, fileIndex: 0, places: [], keptShowsHeader: true })) }),
    };
}

describe('fileChain', () =>
{
    it('is the file name alone for a file of its own; the tool words when it has none', () =>
    {
        const result = resultWith();
        expect(fileChain(result, 0, 'bob.eml', words)).toEqual({ text: 'bob.eml', ownWords: false });
        expect(fileChain(result, 1, '', words)).toEqual({ text: '(no name)', ownWords: true });
        expect(fileChain(result, 1, '   ', words)).toEqual({ text: '(no name)', ownWords: true });
    });

    it('names each level down to an attached email, "(attached N)" for a level without a name', () =>
    {
        const result = resultWith({ parentIndex: 0, path: [1], names: ['fwd.eml'] }, { parentIndex: 2, path: [1, 3], names: ['', ''] });
        expect(fileChain(result, 2, 'parent.eml', words)).toEqual({ text: `parent.eml${FILE_CHAIN_SEPARATOR}fwd.eml`, ownWords: false });
        expect(fileChain(result, 3, 'parent.eml', words).text).toBe(['parent.eml', '(attached 1)', '(attached 3)'].join(' › '));
        // A file without a name still starts the chain, with the tool's words; the chain holds names, so not own words only.
        expect(fileChain(result, 2, '', words)).toEqual({ text: `(no name)${FILE_CHAIN_SEPARATOR}fwd.eml`, ownWords: false });
    });

    it('keeps names as they are (untrusted text, shown as text by the callers)', () =>
    {
        const result = resultWith({ parentIndex: 0, path: [1], names: ['<b>x</b>.eml'] });
        expect(fileChain(result, 2, 'a&b.eml', words).text).toBe('a&b.eml › <b>x</b>.eml');
    });

    it('uses the attached entry of the very input position only', () =>
    {
        const result = resultWith({ parentIndex: 0, path: [1], names: ['fwd.eml'] });
        // Input position 4 has no entry: a plain file name.
        expect(fileChain(result, 4, 'other.eml', words).text).toBe('other.eml');
    });

    it('is the separator the PDF model exports', () =>
    {
        expect(PDF_SEPARATOR).toBe(FILE_CHAIN_SEPARATOR);
        expect(FILE_CHAIN_SEPARATOR).toBe(' \u{203A} ');
    });
});
