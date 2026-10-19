// Unit tests for the wired page and "Clear everything" (page.ts), in Node
// with the recording fake DOM (tests/support/fake-dom.ts), the real step 1,
// step 2 and engine, and a controllable fake processFiles. Synthetic
// messages only. The real page, files and workers are checked in Chromium by
// e2e/clear.spec.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDocument, FakeElement, FakeEventTarget } from '../../tests/support/fake-dom';
import { runEngine, type EngineResult } from '../engine/engine';
import type { EmailAddress, NormalizedMessage, ParseResult } from '../parsing/types';
import type { ProcessOptions, ProcessResult } from '../pipeline/process-files';
import type { FileLike } from '../pipeline/read-files';
import type { ListenerTarget } from './add-files';
import { t } from './i18n';
import { mountPage, showResultInStep2, type Page } from './page';

// ------------------------------------------------------------------ synthetic data

const ALICE: EmailAddress = { name: 'Alice Example', address: 'alice@example.test' };
const BOB: EmailAddress = { name: 'Bob Sample', address: 'bob@example.test' };

let counter = 0;
function make(fields: Partial<NormalizedMessage> = {}): NormalizedMessage {
  counter++;
  return {
    messageId: `p${String(counter)}@example.test`,
    inReplyTo: null,
    references: [],
    date: { utcMs: Date.parse('2025-03-03T08:15:00Z') + counter * 60_000, original: 'synthetic', offsetMinutes: 0, zoneKnown: true },
    from: [ALICE],
    to: [BOB],
    cc: [],
    bcc: [],
    subject: `Garden bench ${String(counter)}`,
    bodyText: `Hello Bob,\n\nThe bench is painted green, note ${String(counter)}.\n\n> Earlier: is the bench ready?\n\nAlice\n`,
    attachments: [],
    source: { fileName: `bench-${String(counter)}.eml`, sha256: counter.toString(16).padStart(64, '0'), kind: 'eml' },
    warnings: [],
    ...fields,
  };
}
const failedFile = (fileName: string): ParseResult => ({ ok: false, fileName, sha256: null, error: 'unsupported-type', detail: 'not an email file' });
const engineOf = (messages: readonly NormalizedMessage[], extra: readonly ParseResult[] = []): EngineResult =>
  runEngine([...messages.map((message): ParseResult => ({ ok: true, message })), ...extra]);

function fakeFile(name: string): FileLike {
  return { name, size: 10, arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)) };
}

/** A controllable processFiles: each call waits until the test resolves it. */
function controlledProcess() {
  const calls: { files: readonly FileLike[]; options: ProcessOptions; resolve: (r: ProcessResult) => void }[] = [];
  const process = (files: readonly FileLike[], options: ProcessOptions): Promise<ProcessResult> =>
    new Promise((resolve) => calls.push({ files, options, resolve }));
  return { calls, process };
}

/** Lets pending promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// ------------------------------------------------------------------ fake page

let root: FakeElement;
let page: Page;
let control: ReturnType<typeof controlledProcess>;
let tasks: { task: () => void; handle: number }[];

function mount(chunkSize = 1000): void {
  root = new FakeElement('div');
  control = controlledProcess();
  tasks = [];
  let next = 0;
  // One queue for the list's chunks and the PDF labels' planning (the delay is ignored: tests run tasks by hand).
  const schedule = (task: () => void): number => {
    const handle = ++next;
    tasks.push({ task, handle });
    return handle;
  };
  const cancel = (handle: unknown): void => {
    tasks = tasks.filter((x) => x.handle !== handle);
  };
  page = mountPage(root as unknown as HTMLElement, {
    addFiles: { process: control.process, listenerTarget: new FakeEventTarget() as unknown as ListenerTarget },
    preview: {
      zones: ['America/New_York', 'Asia/Tokyo', 'UTC'],
      initialZone: 'America/New_York',
      chunkSize,
      schedule,
      cancel,
    },
    pdfLabels: { schedule, cancel },
  });
}

beforeEach(() => {
  vi.stubGlobal('document', new FakeDocument());
  mount();
});

afterEach(() => {
  page.addFiles.destroy();
  page.preview.reset();
  page.pdfLabels.reset();
  vi.unstubAllGlobals();
});

function byId(id: string): FakeElement {
  const found = root.descendants().find((e) => e.getAttribute('id') === id);
  if (!found) throw new Error(`no element with id ${id}`);
  return found;
}
const hasClass = (e: FakeElement, name: string): boolean => (e.getAttribute('class') ?? '').split(' ').includes(name);
const items = (): FakeElement[] => byId('preview-list').children.filter((c): c is FakeElement => c instanceof FakeElement);
const clearButton = () => byId('clear-everything');
const chooseButton = () => byId('choose-files');
const status = () => byId('status').textContent;

function choose(...names: string[]): void {
  const input = byId('file-input');
  input.files = names.map(fakeFile);
  input.value = 'C:\\fakepath\\x.eml';
  input.fire('change');
}

/** Everything a test shows: the texts that must be gone after "Clear everything". */
function emailTexts(messages: readonly NormalizedMessage[], failedNames: readonly string[]): string[] {
  return [
    ...messages.flatMap((m) => [m.subject, m.source.fileName, 'painted green', 'Earlier: is the bench ready?']),
    ...failedNames,
    ALICE.address,
    BOB.address,
  ];
}

/** Adds two emails and a failed file, and waits until everything is shown. */
async function addAndShow(): Promise<{ messages: NormalizedMessage[]; result: EngineResult }> {
  const messages = [make(), make()];
  // An identical copy of the first email in another file: merged, its file name shown as "Also in".
  const copy: NormalizedMessage = { ...messages[0]!, source: { fileName: 'bench-copy.eml', sha256: 'f'.repeat(64), kind: 'eml' } };
  const result = engineOf([...messages, copy], [failedFile('notes.txt')]);
  expect(result.counts.duplicatesMerged).toBe(1);
  choose(...messages.map((m) => m.source.fileName), 'bench-copy.eml', 'notes.txt');
  control.calls.at(-1)?.resolve({ ok: true, engine: result });
  await settle();
  while (tasks.length > 0) tasks.shift()?.task();
  return { messages, result };
}

function expectEmpty(texts: readonly string[]): void {
  const all = root.textContent;
  for (const text of texts) expect(all).not.toContain(text);
  expect(byId('file-input').value).toBe('');
  expect(items()).toEqual([]);
  expect(byId('add-summary').hasAttribute('hidden')).toBe(true);
  expect(byId('add-failed-list').children).toEqual([]);
  expect(byId('add-progress').hasAttribute('hidden')).toBe(true);
  expect(byId('review-files-text').textContent).toBe('');
  expect(byId('review-messages').textContent).toBe('');
  expect(byId('review-included').textContent).toBe('');
  expect(byId('review-notes').textContent).toBe('');
  expect(byId('step-check').getAttribute('data-state')).toBe('waiting');
  expect(byId('check-area').hasAttribute('hidden')).toBe(true);
  expect(page.addFiles.hasFiles()).toBe(false);
  expect(page.preview.isRendering()).toBe(false);
  expect(page.review.includedMessages()).toEqual([]);
  expect(page.review.includedPositions()).toEqual([]);
  expect(clearButton().getAttribute('aria-disabled')).toBe('true');
  // The PDF labels: checkbox unticked, no plans, nothing waiting.
  expect(byId('pdf-everything').checked).toBe(false);
  expect(page.pdfLabels.currentPlans()).toBeNull();
  expect(page.pdfLabels.getPdfPolicy().unfoldEverything).toBe(false);
  expect(page.preview.pdfLabelState()).toBe('off');
}

// ------------------------------------------------------------------ tests

describe('showResultInStep2', () => {
  it('gives the result to the review first, then to the list', () => {
    const order: string[] = [];
    const result: ProcessResult = { ok: true, engine: engineOf([]) };
    showResultInStep2(
      result,
      { showResult: (r) => order.push(r === result ? 'review' : 'other') },
      { showResult: (r) => order.push(r === result ? 'preview' : 'other') },
    );
    expect(order).toEqual(['review', 'preview']);
  });
});

describe('mountPage', () => {
  it('shows a result in step 1 and step 2', async () => {
    const { result } = await addAndShow();
    expect(items()).toHaveLength(result.messages.length);
    expect(byId('review-included').textContent).toBe('2 of 2 emails will be in the PDF.');
    expect(byId('add-failed-list').children).toHaveLength(1);
  });

  it('marks what the PDF leaves out; an untick moves the "first" signature; the checkbox puts everything in', async () => {
    const signature = '\n-- \nAlice Example\nGarden Benches (fictional company)\n';
    const messages = [make({ bodyText: `The bench is green.\n${signature}` }), make({ bodyText: `The bench is delivered.\n${signature}` })];
    choose(...messages.map((m) => m.source.fileName));
    control.calls.at(-1)?.resolve({ ok: true, engine: engineOf(messages) });
    await settle();
    expect(page.preview.pdfLabelState()).toBe('updating');
    while (tasks.length > 0) tasks.shift()?.task();
    expect(page.preview.pdfLabelState()).toBe('ready');
    const labelOf = (k: number): string =>
      items()[k]!.descendants().find((e) => hasClass(e, 'pdf-label'))?.textContent.trim() ?? '';
    expect(labelOf(0)).toBe('In the PDF: signature');
    expect(labelOf(1)).toBe('Not in the PDF: same signature as in email #1');
    expect(page.pdfLabels.currentPlans()?.positions).toEqual([0, 1]);

    const box = items()[0]!.descendants().find((e) => hasClass(e, 'include-checkbox'))!;
    box.checked = false;
    box.fire('change');
    expect(page.preview.pdfLabelState()).toBe('updating'); // hidden at once
    expect(page.pdfLabels.currentPlans()).toBeNull();
    while (tasks.length > 0) tasks.shift()?.task();
    expect(page.preview.pdfLabelState()).toBe('ready');
    expect(labelOf(1)).toBe('In the PDF: signature');
    expect(page.pdfLabels.currentPlans()?.positions).toEqual([1]);

    const everything = byId('pdf-everything');
    everything.checked = true;
    everything.fire('change');
    while (tasks.length > 0) tasks.shift()?.task();
    expect(page.pdfLabels.getPdfPolicy().unfoldEverything).toBe(true);
    expect(page.pdfLabels.currentPlans()?.policy.unfoldEverything).toBe(true);
    expect(labelOf(1)).toBe('In the PDF: signature');

    // Clear everything: the checkbox and the plans are gone too (see expectEmpty).
    clearButton().click();
    expectEmpty([]);
  });

  it('an empty list (no email found) gets its counts too', async () => {
    choose('notes.txt');
    control.calls[0]?.resolve({ ok: true, engine: engineOf([], [failedFile('notes.txt')]) });
    await settle();
    expect(byId('review-included').textContent).toBe('0 of 0 emails will be in the PDF.');
  });
});

describe('"Clear everything": availability', () => {
  it('is unavailable (aria-disabled, still focusable) until files are added; pressing it then does nothing', () => {
    expect(clearButton().getAttribute('aria-disabled')).toBe('true');
    expect(clearButton().hasAttribute('disabled')).toBe(false);
    clearButton().click();
    expect(status()).toBe('');
    expect(chooseButton().focuses).toBe(0);
  });

  it('becomes available as soon as files are added (while they are read), and unavailable after clearing', async () => {
    choose('a.eml');
    expect(clearButton().hasAttribute('aria-disabled')).toBe(false);
    control.calls[0]?.resolve({ ok: true, engine: engineOf([make()]) });
    await settle();
    expect(clearButton().hasAttribute('aria-disabled')).toBe(false);
    clearButton().click();
    expect(clearButton().getAttribute('aria-disabled')).toBe('true');
  });

  it('stays unavailable when nothing was added (a cancelled dialog)', () => {
    const input = byId('file-input');
    input.files = [];
    input.fire('change');
    expect(clearButton().getAttribute('aria-disabled')).toBe('true');
  });

  it('is available when every file failed (the failed list is something to clear)', async () => {
    choose('notes.txt');
    control.calls[0]?.resolve({ ok: true, engine: engineOf([], [failedFile('notes.txt')]) });
    await settle();
    expect(clearButton().hasAttribute('aria-disabled')).toBe(false);
  });
});

describe('"Clear everything": after a finished batch', () => {
  it('empties every part of the page, announces it and moves the focus to the "choose" button', async () => {
    const { messages } = await addAndShow();
    // Some choices to forget: one email unticked, another zone, folded text shown.
    const box = items()[0]!.descendants().find((e) => hasClass(e, 'include-checkbox'))!;
    box.checked = false;
    box.fire('change');
    expect(page.review.includedPositions()).toEqual([1]);
    const zone = byId('preview-zone');
    zone.value = 'Asia/Tokyo';
    zone.fire('change');
    const folded = byId('preview-show-folded');
    folded.checked = true;
    folded.fire('change');
    const texts = emailTexts(messages, ['notes.txt', 'bench-copy.eml']);
    // Everything but the read files' names is on the page before (those only show for merged copies).
    const fileNames = new Set(messages.map((m) => m.source.fileName));
    for (const text of texts.filter((x) => !fileNames.has(x))) expect(root.textContent).toContain(text);

    clearButton().click();

    expectEmpty(texts);
    expect(status()).toBe(t('clear.done'));
    expect(status()).toBe('Everything was cleared.');
    expect(chooseButton().focuses).toBe(1);
    expect(page.preview.zone()).toBe('America/New_York');
    expect(zone.value).toBe('America/New_York');
    expect(folded.checked).toBe(false);
  });

  it('adding files again works, with every email included again (the choices were forgotten)', async () => {
    const first = await addAndShow();
    const box = items()[0]!.descendants().find((e) => hasClass(e, 'include-checkbox'))!;
    box.checked = false;
    box.fire('change');
    clearButton().click();

    // The same files again (same hashes): no choice may come back.
    choose(...first.messages.map((m) => m.source.fileName));
    expect(control.calls.at(-1)?.files.map((f) => f.name)).toEqual(first.messages.map((m) => m.source.fileName));
    control.calls.at(-1)?.resolve({ ok: true, engine: engineOf(first.messages) });
    await settle();
    expect(items()).toHaveLength(2);
    expect(page.review.includedPositions()).toEqual([0, 1]);
    expect(byId('review-included').textContent).toBe('2 of 2 emails will be in the PDF.');
    expect(byId('add-summary-text').textContent).toBe('2 files added. 2 emails found.');
    expect(clearButton().hasAttribute('aria-disabled')).toBe(false);
  });
});

describe('"Clear everything": while processing', () => {
  it('cancels the run (its workers) and ignores its late progress and result', async () => {
    const messages = [make(), make()];
    choose(...messages.map((m) => m.source.fileName));
    const run = control.calls[0]!;
    run.options.onProgress?.({ stage: 'reading', filesDone: 1, filesTotal: 2 });
    expect(status()).toBe('Reading file 2 of 2...');

    clearButton().click();
    expect(run.options.signal?.aborted).toBe(true);
    expect(status()).toBe(t('clear.done'));
    expect(byId('add-area').hasAttribute('aria-busy')).toBe(false);
    expect(chooseButton().hasAttribute('aria-disabled')).toBe(false);

    // The run ends later anyway: nothing of it may appear.
    run.options.onProgress?.({ stage: 'organizing', filesDone: 2, filesTotal: 2 });
    run.resolve({ ok: true, engine: engineOf(messages) });
    await settle();
    while (tasks.length > 0) tasks.shift()?.task();
    expectEmpty(emailTexts(messages, []));
    expect(status()).toBe(t('clear.done'));
  });

  it('cancels files waiting for a second round too', async () => {
    choose('a.eml');
    choose('b.eml'); // waits
    clearButton().click();
    control.calls[0]?.resolve({ ok: true, engine: engineOf([make()]) });
    await settle();
    // No second round was started for the waiting file.
    expect(control.calls).toHaveLength(1);
    expectEmpty([]);
  });
});

describe('"Clear everything": while the list is built in chunks', () => {
  beforeEach(() => {
    page.addFiles.destroy();
    mount(1);
  });

  it('leaves an empty list; the chunks that were waiting never run', async () => {
    const messages = [make(), make(), make(), make()];
    choose(...messages.map((m) => m.source.fileName));
    control.calls[0]?.resolve({ ok: true, engine: engineOf(messages) });
    await settle();
    expect(items()).toHaveLength(1);
    expect(page.preview.isRendering()).toBe(true);
    const waiting = [...tasks];
    expect(waiting.length).toBeGreaterThan(0);

    clearButton().click();
    expect(tasks).toEqual([]); // cancelled
    // Even if a cancelled chunk still ran, it would add nothing.
    for (const { task } of waiting) task();
    expectEmpty(emailTexts(messages, []));
  });
});
