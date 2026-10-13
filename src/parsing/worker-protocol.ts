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
  if (data.type === 'result') return isRecord(data.result) && typeof data.result.ok === 'boolean';
  return data.type === 'failed';
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
