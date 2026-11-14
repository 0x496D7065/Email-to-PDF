// Which emails go into the PDF: the per-email include/exclude choice of step 2.
//
// Every email starts included. The reader can leave one out with its
// checkbox; it then stays in the preview (dimmed), with all its text, and is
// only left out of the PDF (README.md, rule R6: an excluded email is never
// removed or hidden). The choice lives in memory only (README.md, rule R5).
//
// The stable key: each choice is remembered by the SHA-256 of the email's
// source FILE, not by its place in the list. Adding more files runs the
// whole set again: numbers and positions shift, and the kept copy of a
// merged email may become another file (e.g. a copy with a Bcc line wins).
// The file hashes do not change, so:
// - an email's keys are the hash of its kept copy plus the hashes of every
//   copy merged into it (`selectionKeys`);
// - leaving an email out records ALL its keys; including it again forgets
//   all of them;
// - an email is included unless ANY of its keys was left out. So a merged
//   email stays left out when a later run keeps another of its copies.
// A file's own email is keyed by the file hash alone. An email attached
// inside a file (task 8.13b-3) is keyed by the file hash plus its place in
// the file (source.attachedPath, "<hash>/2.1"), so it has its own choice,
// independent of the email it is attached to (user decision 2026-11-10,
// Q2). A format with several emails per file (.mbox, later) must add the
// email's place in its file to the key too.
// The same file added twice has the same hash: its two copies are merged
// anyway (provably identical). If they ever both stay (de-duplication
// failed), they share one choice, which is the safe reading.
//
// Pure functions, no DOM (README.md, rule R7).

import type { EngineMessage } from '../engine/engine';
import type { NormalizedMessage } from '../parsing/types';

/** The key of one copy: its file's SHA-256, plus "/" and its place in the file for an attached email ("<hash>/2.1"). */
export function sourceKey(source: NormalizedMessage['source']): string {
  const path = source.attachedPath;
  return Array.isArray(path) && path.length > 0 ? `${source.sha256}/${path.join('.')}` : source.sha256;
}

/** The keys of one email: its copy's key (sourceKey), then those of the copies merged into it (unique). */
export function selectionKeys(m: EngineMessage): string[] {
  const keys = [sourceKey(m.message.source), ...m.duplicates.map((d) => sourceKey(d.source))];
  return [...new Set(keys)];
}

/** The include/exclude choices (memory only). */
export interface Selection {
  /** True unless the reader left this email out. */
  isIncluded(m: EngineMessage): boolean;
  /** Records the reader's choice for this email. */
  setIncluded(m: EngineMessage, included: boolean): void;
  /** Forgets every choice: every email is included again. */
  clear(): void;
}

export function createSelection(): Selection {
  const excluded = new Set<string>();
  return {
    isIncluded: (m) => !selectionKeys(m).some((key) => excluded.has(key)),
    setIncluded(m, included) {
      for (const key of selectionKeys(m)) {
        if (included) excluded.delete(key);
        else excluded.add(key);
      }
    },
    clear: () => excluded.clear(),
  };
}

/** The list positions (0-based, chronological) of the included emails, ascending. */
export function includedPositions(messages: readonly EngineMessage[], selection: Selection): number[] {
  const positions: number[] = [];
  messages.forEach((m, position) => {
    if (selection.isIncluded(m)) positions.push(position);
  });
  return positions;
}
