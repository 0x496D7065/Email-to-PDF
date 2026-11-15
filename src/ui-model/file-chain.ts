// Where one copy of an email came from, as one line: its file name, or, for
// an email attached inside a dropped file (task 8.13b-3, Q5), the file name
// and then the attachment name at each level down to it: "parent.eml ›
// forwarded.eml". An attachment without a name is shown as "(attached email
// N)", N being its number among the emails attached at that level.
//
// ONE helper for both places that show it (task 8.13b-4, P2 / Q3), so they
// can never disagree: the PDF's File row (src/pdf/model.ts, fileRowLine)
// and the preview's "Also in" row (src/ui/preview.ts). The words ("(file
// without a name)", "(attached email N)") are passed in, so this file has
// none of its own.
//
// Pure function, no DOM (README.md, rule R7). The names are untrusted text:
// they are returned as they are, for the caller to show as text only.

import { attachedAt, type EngineResult } from '../engine/engine';

/** Between the levels of an attached email's chain: "parent.eml › forwarded.eml". */
export const FILE_CHAIN_SEPARATOR = ' › ';

/** The tool's own words in a chain, in the language shown. */
export interface FileChainWords {
  /** For a file without a name: "(file without a name)". */
  readonly noFileName: string;
  /** For an attachment without a name, by its number at that level: "(attached email 2)". */
  attachedNoName(number: number): string;
}

/** One copy's chain. */
export interface FileChain {
  readonly text: string;
  /**
   * True when `text` is only the tool's own words (a file's own email, the
   * file without a name): the PDF draws it as such, never through its
   * character check. False when it holds names read from the files.
   */
  readonly ownWords: boolean;
}

/**
 * The chain of the copy at input position `index` (a kept email or a merged
 * copy), whose file is named `fileName` (NormalizedMessage.source.fileName;
 * blank: "(file without a name)").
 */
export function fileChain(result: Pick<EngineResult, 'attached' | 'counts'>, index: number, fileName: string, words: FileChainWords): FileChain {
  const file = fileName.trim() === '' ? null : fileName;
  const attached = attachedAt(result, index);
  if (attached === undefined) return file === null ? { text: words.noFileName, ownWords: true } : { text: file, ownWords: false };
  const levels = attached.names.map((name, k) => (name.trim() === '' ? words.attachedNoName(attached.path[k] ?? k + 1) : name));
  return { text: [file ?? words.noFileName, ...levels].join(FILE_CHAIN_SEPARATOR), ownWords: false };
}
