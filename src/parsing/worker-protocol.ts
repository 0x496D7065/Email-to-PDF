// The messages between the page and a parse worker, and the worker's side of
// the conversation.
//
// One worker parses one file:
//   page   -> worker: { type: 'parse', name, kind, bytes }
//   worker -> page:   { type: 'html', htmls }          (only if HTML must be converted)
//   page   -> worker: { type: 'conversions', outcomes }
//   worker -> page:   { type: 'result', result }       (or { type: 'failed' })
// Then the page terminates the worker. See deferred-html.ts for why HTML
// goes to the page, and worker-runner.ts for the page's side.
//
// Messages are copied between the two by the browser (structured clone), so
// they hold plain data only. The file's bytes are MOVED (transferred) to the
// worker, not copied. Nothing here is stored anywhere: everything lives in
// memory until the worker is terminated (README.md, rule R5).

import { parseWithDeferredHtml, type ConversionOutcome } from './deferred-html';
import type { FileKind } from './file-type';
import { FORWARDED_SEPARATOR } from './forwarded-block';
import type { ParseResult } from './types';

export interface ParseRequest {
  readonly type: 'parse';
  readonly name: string;
  readonly kind: FileKind;
  readonly bytes: Uint8Array;
}

export interface ConversionsReply {
  readonly type: 'conversions';
  readonly outcomes: readonly ConversionOutcome[];
}

/** Page -> worker. */
export type ToWorker = ParseRequest | ConversionsReply;

export interface HtmlRequest {
  readonly type: 'html';
  readonly htmls: readonly string[];
}

export interface ResultMessage {
  readonly type: 'result';
  readonly result: ParseResult;
}

/** The worker hit an error it could not turn into a result (a bug, not a bad file). */
export interface FailedMessage {
  readonly type: 'failed';
}

/** Worker -> page. */
export type FromWorker = HtmlRequest | ResultMessage | FailedMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** True if `data` is a well-formed page -> worker message. */
export function isToWorker(data: unknown): data is ToWorker {
  if (!isRecord(data)) return false;
  if (data.type === 'parse') {
    return typeof data.name === 'string' && (data.kind === 'eml' || data.kind === 'msg') && data.bytes instanceof Uint8Array;
  }
  return data.type === 'conversions' && Array.isArray(data.outcomes);
}

/** True if `data` is a well-formed worker -> page message. */
export function isFromWorker(data: unknown): data is FromWorker {
  if (!isRecord(data)) return false;
  if (data.type === 'html') return Array.isArray(data.htmls) && data.htmls.every((h) => typeof h === 'string');
  if (data.type === 'result') return isRecord(data.result) && typeof data.result.ok === 'boolean' && hasWellFormedAttached(data.result);
  return data.type === 'failed';
}

/**
 * Checks the attached-email fields of a result (ParseResult.attached,
 * source.attachedPath, AttachmentInfo.attachedIndex, see types.ts) strictly,
 * so later steps can index with them without checking again:
 * - a failed result has no `attached`; a successful one has a message with
 *   an attachments list and a source, and its source has no attachedPath;
 * - `attached`, when there, is a non-empty list; each entry's parent is -1
 *   or an earlier entry, its path is its parent's path plus one number from
 *   1, its message's source.attachedPath is the same path, and its name is
 *   a string;
 * - its places name its ancestors in order, nearest first (parent, then the
 *   parent's parent, ...), and each one is a range of that holder's
 *   bodyText that starts with the forwarded separator line;
 * - an attachedIndex is an index of `attached`: on the file's own email any
 *   entry, on an attached email one of its descendants;
 * - every entry's source has the file email's fileName, sha256 and kind;
 * - in a .msg result (kind 'msg', task 8.13b-2) no entry has a place and no
 *   attachment has an attachedIndex: an attached Outlook item is never
 *   printed in another email's body.
 */
export function hasWellFormedAttached(result: Record<string, unknown>): boolean {
  if (result.ok !== true) return !('attached' in result);
  const { message } = result;
  if (!isRecord(message) || !isRecord(message.source) || 'attachedPath' in message.source) return false;
  if (!('attached' in result)) return attachmentsPointInto(message.attachments, () => false);
  const { attached } = result;
  if (!Array.isArray(attached) || attached.length === 0) return false;
  const file = message.source;
  const isMsg = file.kind === 'msg';

  const entries: { parent: number; path: readonly number[]; body: string }[] = [];
  const isAncestor = (ancestor: number, of: number): boolean => {
    for (let at = entries[of]?.parent ?? -1; at !== -1; at = entries[at]?.parent ?? -1) if (at === ancestor) return true;
    return false;
  };
  const bodyOf = (holder: number): unknown => (holder === -1 ? message.bodyText : entries[holder]?.body);
  for (const [index, entry] of attached.entries()) {
    if (!isRecord(entry) || !isRecord(entry.message) || !isRecord(entry.message.source)) return false;
    const { parent, path, places, name } = entry;
    const { bodyText, source } = entry.message;
    if (!isInteger(parent) || parent < -1 || parent >= index || typeof bodyText !== 'string' || typeof name !== 'string') return false;
    const parentPath = parent === -1 ? [] : (entries[parent]?.path ?? []);
    if (!isPath(path) || path.length !== parentPath.length + 1 || parentPath.some((n, i) => path[i] !== n)) return false;
    if (!isPath(source.attachedPath) || source.attachedPath.length !== path.length) return false;
    if (source.attachedPath.some((n, i) => path[i] !== n)) return false;
    if (source.fileName !== file.fileName || source.sha256 !== file.sha256 || source.kind !== file.kind) return false;
    entries.push({ parent, path, body: bodyText });
    if (!Array.isArray(places) || (isMsg && places.length !== 0)) return false;
    let holder: number | undefined = parent;
    for (const place of places as unknown[]) {
      if (!isRecord(place) || place.holder !== holder || holder === undefined) return false;
      const body = bodyOf(holder);
      const { start, end } = place;
      if (typeof body !== 'string' || !isInteger(start) || !isInteger(end)) return false;
      if (start < 0 || end < start || end > body.length || !body.startsWith(FORWARDED_SEPARATOR, start)) return false;
      holder = holder === -1 ? undefined : (entries[holder]?.parent ?? undefined);
    }
  }
  if (!attachmentsPointInto(message.attachments, (target) => !isMsg && target < attached.length)) return false;
  return attached.every((entry, index) =>
    attachmentsPointInto((entry as { message: Record<string, unknown> }).message.attachments, (target) => !isMsg && isAncestor(index, target)),
  );
}

/** True if `attachments` is a list of records whose attachedIndex, where present, is an integer accepted by `allowed`. */
function attachmentsPointInto(attachments: unknown, allowed: (target: number) => boolean): boolean {
  if (!Array.isArray(attachments)) return false;
  return attachments.every(
    (a) => isRecord(a) && (!('attachedIndex' in a) || (isInteger(a.attachedIndex) && a.attachedIndex >= 0 && allowed(a.attachedIndex))),
  );
}

function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
}

/** A non-empty list of attachment numbers, each an integer from 1. */
function isPath(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((n) => isInteger(n) && n >= 1);
}

/**
 * The worker's side: returns the function to call with each message the
 * worker receives. `post` sends a message to the page. Kept apart from
 * parse-worker.ts (which only wires it to the worker's global scope) so it
 * runs in unit tests without a browser.
 */
export function createWorkerSide(post: (message: FromWorker) => void): (data: unknown) => void {
  let waiting: ((outcomes: readonly ConversionOutcome[]) => void) | null = null;
  let started = false;

  const run = async (request: ParseRequest): Promise<void> => {
    try {
      const result = await parseWithDeferredHtml({ name: request.name, bytes: request.bytes }, request.kind, (htmls) =>
        new Promise((resolve) => {
          waiting = resolve;
          post({ type: 'html', htmls: [...htmls] });
        }),
      );
      post({ type: 'result', result });
    } catch {
      // The adapters never throw for a bad file; this is a bug. The page
      // reports it as a failed worker, without JavaScript internals.
      post({ type: 'failed' });
    }
  };

  return (data) => {
    if (!isToWorker(data)) return;
    if (data.type === 'conversions') {
      const resolve = waiting;
      waiting = null;
      resolve?.(data.outcomes);
      return;
    }
    // One file per worker: a second request is ignored.
    if (started) return;
    started = true;
    void run(data);
  };
}
