// Unit tests for step 3 wired into the page (download-step.ts, page.ts), in
// Node with the recording fake DOM (tests/support/fake-dom.ts), the real
// steps 1 and 2 and engine, a controllable fake processFiles, a fake PDF
// maker (no worker), fake blob: URLs and a fixed clock. Synthetic messages
// only. The real worker, download and blob: URL are checked in Chromium by
// e2e/download.spec.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDocument, FakeElement, FakeEventTarget } from '../../tests/support/fake-dom';
import { runEngine, type EngineResult } from '../engine/engine';
import type { EmailAddress, NormalizedMessage, ParseResult } from '../parsing/types';
import type { ProcessOptions, ProcessResult } from '../pipeline/process-files';
import type { MakePdfRequest, PdfFontBytes } from '../pipeline/pdf-protocol';
import type { PdfOutcome } from '../pipeline/pdf-runner';
import type { FileLike } from '../pipeline/read-files';
import type { ListenerTarget } from './add-files';
import { noteText } from './download-step';
import { t } from './i18n';
import { mountPage, type Page } from './page';

// ------------------------------------------------------------------ synthetic data

const ALICE: EmailAddress = { name: 'Alice Example', address: 'alice@example.com' };
const CAROL: EmailAddress = { name: 'Carol Test', address: 'carol@example.net' };
const ORIGIN = 'http://127.0.0.1:4173';
const NOW = Date.UTC(2025, 5, 1, 12, 0, 0);
// The fonts' content does not matter to the page: it only passes them on.
const FONTS = { 'sans-regular': new Uint8Array(1) } as unknown as PdfFontBytes;

let counter = 0;
function make(): NormalizedMessage {
  counter++;
  return {
    messageId: `d${String(counter)}@example.com`,
    inReplyTo: null,
    references: [],
    date: { utcMs: Date.UTC(2025, 2, 3, 8, 15) + counter * 60_000, original: 'synthetic', offsetMinutes: 0, zoneKnown: true },
    from: [ALICE],
    to: [CAROL],
    cc: [],
    bcc: [],
    subject: `Garden bench ${String(counter)}`,
    bodyText: `Hello Carol,\n\nThe bench is painted green, note ${String(counter)}.\n\nAlice\n`,
    attachments: [],
    source: { fileName: `bench-${String(counter)}.eml`, sha256: counter.toString(16).padStart(64, '0'), kind: 'eml' },
    warnings: [],
  };
}
const engineOf = (messages: readonly NormalizedMessage[]): EngineResult => runEngine(messages.map((message): ParseResult => ({ ok: true, message })));

function fakeFile(name: string): FileLike {
  return { name, size: 10, arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)) };
}

/** Lets pending promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

// ------------------------------------------------------------------ fake page

let root: FakeElement;
let page: Page;
let window: FakeEventTarget;
let calls: { files: readonly FileLike[]; options: ProcessOptions; resolve: (r: ProcessResult) => void }[];
let tasks: { task: () => void; handle: number }[];
let runs: { request: MakePdfRequest; signal: AbortSignal; resolve: (o: PdfOutcome) => void }[];
let created: string[];
let revoked: string[];

/** What a test may change in the page it mounts (see mount). */
interface MountOptions {
  /** The preview's chunk size (default 1000: the whole list in one task). */
  readonly chunkSize?: number;
  /** The PDF labels' clock (default: performance.now). */
  readonly labelsNow?: () => number;
}

/** Mounts the page with fakes; called by beforeEach, and again by a test that needs other options. */
function mount(settings: MountOptions = {}): void {
  root = new FakeElement('div');
  window = new FakeEventTarget();
  calls = [];
  tasks = [];
  runs = [];
  created = [];
  revoked = [];
  let next = 0;
  const schedule = (task: () => void): number => {
    const handle = ++next;
    tasks.push({ task, handle });
    return handle;
  };
  const cancel = (handle: unknown): void => {
    tasks = tasks.filter((x) => x.handle !== handle);
  };
  page = mountPage(root as unknown as HTMLElement, {
    addFiles: {
      process: (files, options) => new Promise((resolve) => calls.push({ files, options, resolve })),
      listenerTarget: window as unknown as ListenerTarget,
    },
    preview: { zones: ['America/New_York', 'Asia/Tokyo', 'UTC'], initialZone: 'America/New_York', chunkSize: settings.chunkSize ?? 1000, schedule, cancel },
    pdfLabels: { schedule, cancel, ...(settings.labelsNow === undefined ? {} : { now: settings.labelsNow }) },
    download: {
      run: (request, signal) => new Promise((resolve) => runs.push({ request, signal, resolve })),
      createUrl: () => {
        const url = `blob:${ORIGIN}/0000-${String(created.length + 1)}`;
        created.push(url);
        return url;
      },
      revokeUrl: (url) => revoked.push(url),
      origin: ORIGIN,
      now: () => NOW,
      fonts: FONTS,
    },
  });
}

/** Stops what the mounted page still has going. */
function unmount(): void {
  page.addFiles.destroy();
  page.preview.reset();
  page.pdfLabels.reset();
}

/** Replaces the page of beforeEach by one with other options. */
function remount(settings: MountOptions): void {
  unmount();
  mount(settings);
}

beforeEach(() => {
  vi.stubGlobal('document', new FakeDocument());
  mount();
});

afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
});

function byId(id: string): FakeElement {
  const found = root.descendants().find((e) => e.getAttribute('id') === id);
  if (!found) throw new Error(`no element with id ${id}`);
  return found;
}
const hasClass = (e: FakeElement, name: string): boolean => (e.getAttribute('class') ?? '').split(' ').includes(name);
const items = (): FakeElement[] => byId('preview-list').children.filter((c): c is FakeElement => c instanceof FakeElement);
const button = () => byId('download-button');
const note = () => byId('download-note');
const link = () => byId('download-link');
const status = () => byId('status').textContent;
const runTasks = (): void => {
  while (tasks.length > 0) tasks.shift()?.task();
};

function choose(...names: string[]): void {
  const input = byId('file-input');
  input.files = names.map(fakeFile);
  input.fire('change');
}

/** Adds `count` emails and waits until the list and its PDF plans are ready. */
async function addAndShow(count = 3): Promise<EngineResult> {
  const messages = Array.from({ length: count }, make);
  const result = engineOf(messages);
  choose(...messages.map((m) => m.source.fileName));
  calls.at(-1)?.resolve({ ok: true, engine: result });
  await settle();
  runTasks();
  return result;
}

function lastRun() {
  const run = runs.at(-1);
  if (run === undefined) throw new Error('no PDF run');
  return run;
}

/** Presses "Make the PDF" and lets the fake maker finish with a PDF of `pageCount` pages. */
async function makeReady(pageCount = 5): Promise<string> {
  button().click();
  lastRun().resolve({ ok: true, bytes: new Uint8Array([37, 80, 68, 70, 45]), fileName: 'correspondence-2025-06-01.pdf', pageCount });
  await settle();
  const url = created.at(-1);
  if (url === undefined) throw new Error('no URL');
  return url;
}

function expectNoLink(): void {
  expect(link().hasAttribute('hidden')).toBe(true);
  expect(link().hasAttribute('href')).toBe(false);
  expect(link().hasAttribute('download')).toBe(false);
  expect(link().textContent).toBe('');
}

const isUnavailable = () => button().getAttribute('aria-disabled') === 'true';

// ------------------------------------------------------------------ tests

describe('step 3: when the PDF can be made', () => {
  it('is unavailable until emails are shown, saying why; pressing it then does nothing', async () => {
    expect(isUnavailable()).toBe(true);
    expect(button().hasAttribute('disabled')).toBe(false);
    expect(button().getAttribute('aria-describedby')).toBe('download-note');
    expect(note().textContent).toBe(t('download.unavailable.no-emails'));
    button().click();
    expect(runs).toEqual([]);

    // Files being read: "please wait".
    choose('a.eml');
    expect(isUnavailable()).toBe(true);
    expect(note().textContent).toBe(t('download.unavailable.busy'));
    calls.at(-1)?.resolve({ ok: true, engine: engineOf([make(), make()]) });
    await settle();
    // The list is shown, its PDF plans are still being worked out: still waiting.
    expect(isUnavailable()).toBe(true);
    expect(note().textContent).toBe(t('download.unavailable.busy'));
    button().click();
    expect(runs).toEqual([]);
    runTasks();
    expect(isUnavailable()).toBe(false);
    expect(button().hasAttribute('aria-disabled')).toBe(false);
    expect(note().textContent).toBe(t('download.available'));
    expectNoLink();
    expect(byId('download-area').getAttribute('data-state')).toBe('idle');
  });

  it('says so when every email is unticked, and is available again once one is ticked', async () => {
    await addAndShow(2);
    const boxes = items().map((item) => item.descendants().find((e) => hasClass(e, 'include-checkbox'))!);
    for (const box of boxes) {
      box.checked = false;
      box.fire('change');
    }
    // The plans are being worked out again: waiting.
    expect(note().textContent).toBe(t('download.unavailable.busy'));
    runTasks();
    expect(isUnavailable()).toBe(true);
    expect(note().textContent).toBe(t('download.unavailable.none-included'));
    button().click();
    expect(runs).toEqual([]);
    boxes[1]!.checked = true;
    boxes[1]!.fire('change');
    runTasks();
    expect(isUnavailable()).toBe(false);
  });

  it('waits for the list to be complete, even when the PDF plans are ready before it', async () => {
    // One email per chunk: the list takes several tasks, and the plans
    // (one slice for 6 emails) are ready while chunks are still waiting.
    remount({ chunkSize: 1 });
    const messages = Array.from({ length: 6 }, make);
    const result = engineOf(messages);
    choose(...messages.map((m) => m.source.fileName));
    calls.at(-1)?.resolve({ ok: true, engine: result });
    await settle();
    let stepsWithPlansWhileRendering = 0;
    for (let steps = 0; page.preview.isRendering(); steps++) {
      expect(steps).toBeLessThan(100);
      const plans = page.pdfLabels.currentPlans();
      if (plans !== null && plans.result === result) stepsWithPlansWhileRendering++;
      expect(isUnavailable()).toBe(true);
      expect(note().textContent).toBe(t('download.unavailable.busy'));
      button().click();
      expect(runs).toEqual([]);
      tasks.shift()?.task();
    }
    // The case this test is about really happened: plans up to date, list not complete.
    expect(stepsWithPlansWhileRendering).toBeGreaterThan(0);
    runTasks();
    expect(items()).toHaveLength(6);
    expect(isUnavailable()).toBe(false);
    expect(note().textContent).toBe(t('download.available'));
    button().click();
    expect(runs).toHaveLength(1);
  });

  it('says so, and makes nothing, when the PDF plans could not be worked out', async () => {
    // A clock that throws makes the labels' planning fail (its catch calls `failed`).
    remount({
      labelsNow: () => {
        throw new Error('synthetic planning failure');
      },
    });
    await addAndShow(3);
    expect(page.preview.isRendering()).toBe(false);
    expect(page.pdfLabels.currentPlans()).toBeNull();
    expect(isUnavailable()).toBe(true);
    expect(note().textContent).toBe(t('download.unavailable.labels-failed'));
    button().click();
    expect(runs).toEqual([]);
  });

  it('stays unavailable after a batch with no email', async () => {
    choose('notes.txt');
    calls.at(-1)?.resolve({ ok: true, engine: engineOf([]) });
    await settle();
    runTasks();
    expect(note().textContent).toBe(t('download.unavailable.no-emails'));
    expect(isUnavailable()).toBe(true);
  });
});

describe('step 3: making the PDF', () => {
  it('sends exactly the preview\'s plans, the chosen zone, the page\'s time and the fonts', async () => {
    const result = await addAndShow(3);
    byId('preview-zone').value = 'Asia/Tokyo';
    byId('preview-zone').fire('change');
    const plans = page.pdfLabels.currentPlans();
    expect(plans).not.toBeNull();
    button().click();
    expect(runs).toHaveLength(1);
    const { request } = lastRun();
    expect(request.type).toBe('make');
    expect(request.fonts).toBe(FONTS);
    expect(request.input.result).toBe(result);
    // The very objects the preview's labels were made from.
    expect(request.input.plans).toBe(plans?.plans);
    expect(request.input.positions).toBe(plans?.positions);
    expect(request.input.policy).toBe(plans?.policy);
    expect(request.input.timeZone).toBe('Asia/Tokyo');
    expect(request.input.generatedAt).toBe(NOW);
  });

  it('shows and announces progress; pressing again meanwhile starts nothing', async () => {
    await addAndShow();
    button().click();
    expect(isUnavailable()).toBe(true);
    expect(note().textContent).toBe(t('download.making'));
    expect(status()).toBe(t('download.making'));
    expect(byId('download-area').getAttribute('data-state')).toBe('making');
    expect(byId('download-area').getAttribute('aria-busy')).toBe('true');
    button().click();
    expect(runs).toHaveLength(1);
    expectNoLink();
  });

  it('when ready: the download starts once, and "Download again" stays with the blob: URL and the file name', async () => {
    await addAndShow();
    const url = await makeReady(12);
    expect(link().getAttribute('href')).toBe(url);
    expect(link().getAttribute('download')).toBe('correspondence-2025-06-01.pdf');
    expect(link().hasAttribute('hidden')).toBe(false);
    expect(link().textContent).toBe(t('download.again', { fileName: 'correspondence-2025-06-01.pdf' }));
    expect(link().clicks).toBe(1);
    const ready = t('download.ready', { fileName: 'correspondence-2025-06-01.pdf', count: 12 });
    expect(ready).toBe('Your PDF is ready: correspondence-2025-06-01.pdf, 12 pages. The download has started.');
    expect(status()).toBe(ready);
    expect(note().textContent).toBe(ready);
    expect(byId('download-area').getAttribute('data-state')).toBe('ready');
    expect(byId('download-area').hasAttribute('aria-busy')).toBe(false);
    // Not revoked after the click: the link still needs it.
    expect(revoked).toEqual([]);
    // The button stays available (a new PDF replaces this one).
    expect(isUnavailable()).toBe(false);
  });

  it('a new PDF revokes the previous one\'s URL', async () => {
    await addAndShow();
    const first = await makeReady();
    button().click();
    expect(revoked).toEqual([first]);
    expectNoLink();
  });

  it.each([
    ['timeout', t('download.error.timeout')],
    ['tool-error', t('download.error.tool-error')],
    ['not-started', t('download.error.not-started')],
  ] as const)('explains a failure (%s) calmly, and lets the user try again', async (error, text) => {
    await addAndShow();
    button().click();
    lastRun().resolve({ ok: false, error });
    await settle();
    expect(note().textContent).toBe(text);
    expect(hasClass(note(), 'error-message')).toBe(true);
    expect(status()).toBe(text);
    expect(text).not.toMatch(/damaged|corrupt/i);
    expectNoLink();
    expect(created).toEqual([]);
    expect(isUnavailable()).toBe(false);
    button().click();
    expect(runs).toHaveLength(2);
    expect(hasClass(note(), 'error-message')).toBe(false);
  });
});

describe('step 3: a change of choice drops the PDF', () => {
  const changes: [string, () => void][] = [
    [
      'an email unticked',
      () => {
        const box = items()[0]!.descendants().find((e) => hasClass(e, 'include-checkbox'))!;
        box.checked = false;
        box.fire('change');
      },
    ],
    [
      'another time zone',
      () => {
        byId('preview-zone').value = 'UTC';
        byId('preview-zone').fire('change');
      },
    ],
    [
      '"Put everything in the PDF"',
      () => {
        byId('pdf-everything').checked = true;
        byId('pdf-everything').fire('change');
      },
    ],
    ['files added', () => choose('more.eml')],
  ];

  it.each(changes)('%s after the PDF is ready: link removed, URL revoked, "make it again" note', async (_label, change) => {
    await addAndShow();
    const url = await makeReady();
    change();
    expect(revoked).toEqual([url]);
    expectNoLink();
    expect(byId('download-area').getAttribute('data-state')).toBe('idle');
    // Once the page is ready again, the note says why the PDF went away.
    calls.at(-1)?.resolve({ ok: true, engine: engineOf([make(), make()]) });
    await settle();
    runTasks();
    expect(note().textContent).toBe(t('download.changed'));
    expect(isUnavailable()).toBe(false);
  });

  it.each(changes)('%s while the PDF is being made: the job is stopped and its PDF never offered', async (_label, change) => {
    await addAndShow();
    button().click();
    const run = lastRun();
    change();
    expect(run.signal.aborted).toBe(true);
    run.resolve({ ok: true, bytes: new Uint8Array(5), fileName: 'correspondence-2025-06-01.pdf', pageCount: 3 });
    await settle();
    expect(created).toEqual([]);
    expectNoLink();
    expect(byId('download-area').getAttribute('data-state')).toBe('idle');
  });

  // The status line (the page's one live region) must not keep announcing a
  // PDF that is gone: "Making your PDF..." or "Your PDF is ready".
  const announced: [string, () => void][] = [changes[1]!, changes[2]!];

  it.each(announced)('%s while the PDF is being made: the status line says the PDF was removed', async (_label, change) => {
    await addAndShow();
    button().click();
    expect(status()).toBe(t('download.making'));
    change();
    expect(status()).toBe(t('download.changed'));
    expect(note().textContent).not.toBe(t('download.making'));
  });

  it.each(announced)('%s when the PDF is ready: the status line says the PDF was removed', async (_label, change) => {
    await addAndShow();
    await makeReady();
    expect(status()).toBe(t('download.ready', { fileName: 'correspondence-2025-06-01.pdf', count: 5 }));
    change();
    expect(status()).toBe(t('download.changed'));
    // Once the plans are made again, the note says it too.
    runTasks();
    expect(note().textContent).toBe(t('download.changed'));
  });

  it('a change with no PDF made or being made announces nothing about a PDF', async () => {
    await addAndShow();
    const before = status();
    changes[1]![1]();
    expect(status()).toBe(before);
    expect(status()).not.toBe(t('download.changed'));
  });

  describe('one announcement per action (the status line is the page\'s one live region)', () => {
    /** Every text the status line was given from here on, in order. */
    function recordStatus(): string[] {
      const said: string[] = [];
      const setStatus = page.shell.setStatus.bind(page.shell);
      vi.spyOn(page.shell, 'setStatus').mockImplementation((text) => {
        said.push(text);
        setStatus(text);
      });
      return said;
    }
    const untickFirst = changes[0]![1];
    const combined = (count: string): string => `${count} ${t('download.changed')}`;

    it('the combined text reads as two sentences', () => {
      expect(combined('2 of 3 emails will be in the PDF.')).toBe(
        '2 of 3 emails will be in the PDF. Your choices changed, so the previous PDF was removed. Make the PDF again to include them.',
      );
      expect(t('download.changedAfter', { news: 'A.', changed: 'B.' })).toBe('A. B.');
    });

    it('unticking an email when the PDF is ready: the count and the removal, once, together', async () => {
      await addAndShow(3);
      const url = await makeReady();
      const said = recordStatus();
      untickFirst();
      expect(said).toEqual([combined('2 of 3 emails will be in the PDF.')]);
      expect(status()).toBe(combined('2 of 3 emails will be in the PDF.'));
      expect(revoked).toEqual([url]);
      // The labels settling later announce nothing more.
      runTasks();
      expect(said).toHaveLength(1);
      expect(status()).toBe(combined('2 of 3 emails will be in the PDF.'));
      expect(note().textContent).toBe(t('download.changed'));
    });

    it('unticking an email while the PDF is being made: the count and the removal, once, together', async () => {
      await addAndShow(3);
      button().click();
      const run = lastRun();
      const said = recordStatus();
      untickFirst();
      expect(run.signal.aborted).toBe(true);
      expect(said).toEqual([combined('2 of 3 emails will be in the PDF.')]);
      expect(status()).toBe(combined('2 of 3 emails will be in the PDF.'));
      runTasks();
      run.resolve({ ok: true, bytes: new Uint8Array(5), fileName: 'correspondence-2025-06-01.pdf', pageCount: 3 });
      await settle();
      expect(said).toHaveLength(1);
    });

    it('unticking an email with no PDF: the count alone', async () => {
      await addAndShow(3);
      const said = recordStatus();
      untickFirst();
      expect(said).toEqual(['2 of 3 emails will be in the PDF.']);
      runTasks();
      expect(said).toHaveLength(1);
      expect(status()).toBe('2 of 3 emails will be in the PDF.');
    });

    it('unticking an email after a failed PDF: the count alone (no PDF was removed)', async () => {
      await addAndShow(3);
      button().click();
      lastRun().resolve({ ok: false, error: 'timeout' });
      await settle();
      const said = recordStatus();
      untickFirst();
      expect(said).toEqual(['2 of 3 emails will be in the PDF.']);
    });

    it('another time zone when the PDF is ready: the removal alone', async () => {
      await addAndShow(3);
      await makeReady();
      const said = recordStatus();
      changes[1]![1]();
      expect(said).toEqual([t('download.changed')]);
      expect(status()).toBe(t('download.changed'));
    });

    it('ticking an email back after the PDF was removed: the count alone', async () => {
      await addAndShow(3);
      await makeReady();
      untickFirst();
      runTasks();
      const said = recordStatus();
      const box = items()[0]!.descendants().find((e) => hasClass(e, 'include-checkbox'))!;
      box.checked = true;
      box.fire('change');
      runTasks();
      expect(said).toEqual(['3 of 3 emails will be in the PDF.']);
    });
  });

  it('showing the folded text is not a change of the PDF', async () => {
    await addAndShow();
    const url = await makeReady();
    byId('preview-show-folded').checked = true;
    byId('preview-show-folded').fire('change');
    expect(revoked).toEqual([]);
    expect(link().getAttribute('href')).toBe(url);
  });
});

describe('step 3: "Clear everything" and leaving the page', () => {
  it('"Clear everything" while the PDF is being made: stopped, nothing offered, back to the start', async () => {
    await addAndShow();
    button().click();
    const run = lastRun();
    byId('clear-everything').click();
    expect(run.signal.aborted).toBe(true);
    run.resolve({ ok: true, bytes: new Uint8Array(5), fileName: 'correspondence-2025-06-01.pdf', pageCount: 3 });
    await settle();
    expect(created).toEqual([]);
    expectNoLink();
    expect(status()).toBe(t('clear.done'));
    expect(note().textContent).toBe(t('download.unavailable.no-emails'));
    expect(isUnavailable()).toBe(true);
    expect(byId('download-area').getAttribute('data-state')).toBe('idle');
  });

  it('"Clear everything" after the PDF is ready: URL revoked, link removed, no "changed" note', async () => {
    await addAndShow();
    const url = await makeReady();
    byId('clear-everything').click();
    expect(revoked).toEqual([url]);
    expectNoLink();
    expect(note().textContent).toBe(t('download.unavailable.no-emails'));
    // Adding files again starts from a clean step 3.
    await addAndShow();
    expect(note().textContent).toBe(t('download.available'));
  });

  it('leaving the page (pagehide) revokes the URL and removes the link', async () => {
    await addAndShow();
    const url = await makeReady();
    window.fire('pagehide');
    expect(revoked).toEqual([url]);
    expectNoLink();
  });
});

describe('noteText', () => {
  it('gives every reason a text of its own', () => {
    const idle = { kind: 'idle', changed: false } as const;
    const texts = (['no-emails', 'busy', 'none-included', 'labels-failed'] as const).map((r) => noteText(idle, r));
    expect(new Set(texts).size).toBe(4);
    expect(noteText(idle, 'labels-failed')).toBe(t('download.unavailable.labels-failed'));
    // A reason wins over "changed"; "changed" over "available".
    expect(noteText({ kind: 'idle', changed: true }, 'busy')).toBe(t('download.unavailable.busy'));
    expect(noteText({ kind: 'idle', changed: true }, null)).toBe(t('download.changed'));
    expect(noteText({ kind: 'ready', url: 'blob:x', fileName: 'a.pdf', pageCount: 1 }, null)).toBe(
      'Your PDF is ready: a.pdf, 1 page. The download has started.',
    );
  });
});
