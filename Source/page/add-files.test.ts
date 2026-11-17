// Unit tests for step 1 (adding files), in Node with the recording fake DOM
// (Helper/Test/test-support/fake-dom.ts) and a fake processFiles. The real page, real
// files and real workers are checked in Chromium by Helper/Test/browser-tests/add-files.spec.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDocument, FakeElement, FakeEventTarget } from '../../Helper/Test/test-support/fake-dom';
import {
    carriesFiles,
    filesFromDrop,
    mountAddFiles,
    progressText,
    readingStatusText,
    summarize,
    summaryText,
    type AddFiles,
    type DataTransferItemLike,
    type ListenerTarget,
} from './add-files';
import { mountApp, type AppShell } from './app';
import { t } from './translations';
import type { FileLike, ProcessOptions, ProcessResult } from '../../Header/file-processing';
import type { ParseErrorCode, ParseResult } from '../../Header/parsed-email';
import type { EngineResult } from '../../Header/thread-analysis-result';

// --- Helpers ----------------------------------------------------------------

function fakeFile(name: string): FileLike
{
    return { name, size: 10, arrayBuffer: () => Promise.resolve(new ArrayBuffer(10)) };
}

function fileItem(file: FileLike, isDirectory = false): DataTransferItemLike
{
    return { kind: 'file', getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory }) };
}

/** An engine result with the given counts and failed files (no real messages needed here). */
function engineResult(
    given: number,
    found: number,
    merged: number,
    failed: { fileName: string; error: ParseErrorCode; detail: string }[],
    attached = 0,
): ProcessResult
{
    const kept = found - merged;
    const engine = {
        messages: Array.from({ length: kept }, () => ({})),
        failed: failed.map((f, i) => ({ ...f, index: i, sha256: null })),
        counts: { filesGiven: given, messagesFound: found, duplicatesMerged: merged, filesFailed: failed.length, undated: 0, withFolds: 0 },
        positionByIndex: [],
        // Only the number of entries matters to the counts (task 8.13b-4, P4).
        ...(attached === 0 ? {} : { attached: Array.from({ length: attached }, () => ({})) }),
    } as unknown as EngineResult;
    return { ok: true, engine };
}

/** A controllable processFiles: each call waits until the test resolves it. */
function controlledProcess()
{
    const calls: { files: readonly FileLike[]; options: ProcessOptions; resolve: (r: ProcessResult) => void }[] = [];
    const process = (files: readonly FileLike[], options: ProcessOptions): Promise<ProcessResult> =>
        new Promise((resolve) => calls.push({ files, options, resolve }));
    return { calls, process };
}

/** Lets pending promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

let doc: FakeDocument;
let root: FakeElement;
let shell: AppShell;
let win: FakeEventTarget;
let statuses: string[];
let checkReady: boolean[];
let results: ProcessResult[];
let control: ReturnType<typeof controlledProcess>;
let addFiles: AddFiles;
let filesChanges: number;

function byId(id: string): FakeElement
{
    const found = root.descendants().find((e) => e.getAttribute('id') === id);
    if (!found)
    {
        throw new Error(`no element with id ${id}`);
    }
    return found;
}

const zone = () => byId('drop-zone');
const input = () => byId('file-input');
const button = () => byId('choose-files');
const lastStatus = () => statuses.at(-1);

/** Chooses files with the file input, as the browser does after the dialog closes. */
function choose(...names: string[]): void
{
    input().files = names.map(fakeFile);
    input().value = 'C:\\fakepath\\x.eml';
    input().fire('change');
}

/** Drops on `target` (default: the drop zone's text) through the window listeners. */
function drop(items: DataTransferItemLike[], target: unknown = zone().children[0])
{
    return win.fire('drop', { target, dataTransfer: { types: ['Files'], items } });
}

beforeEach(() =>
{
    doc = new FakeDocument();
    vi.stubGlobal('document', doc);
    root = new FakeElement('div');
    const real = mountApp(root as unknown as HTMLElement);
    statuses = [];
    checkReady = [];
    results = [];
    // Record what step 1 asks of the shell, and still update the real shell.
    shell = {
        ...real,
        addArea: real.addArea,
        setStatus: (message) =>
        {
            statuses.push(message);
            real.setStatus(message);
        },
        setCheckReady: (ready) =>
        {
            checkReady.push(ready);
            real.setCheckReady(ready);
        },
    };
    win = new FakeEventTarget();
    control = controlledProcess();
    filesChanges = 0;
    addFiles = mountAddFiles(shell, {
        onResult: (r) => results.push(r),
        process: control.process,
        listenerTarget: win as unknown as ListenerTarget,
        onFilesChange: () => filesChanges++,
    });
});

afterEach(() =>
{
    addFiles.destroy();
    vi.unstubAllGlobals();
});

// --- Pure helpers -------------------------------------------------------------

describe('carriesFiles', () =>
{
    it('is true only for drags that carry files', () =>
    {
        expect(carriesFiles({ types: ['Files'] })).toBe(true);
        expect(carriesFiles({ types: ['text/uri-list', 'text/plain'] })).toBe(false);
        expect(carriesFiles({})).toBe(false);
        expect(carriesFiles(null)).toBe(false);
    });
});

describe('filesFromDrop', () =>
{
    it('takes file items only, in order, and skips links and text', () =>
    {
        const a = fakeFile('a.eml');
        const b = fakeFile('b.msg');
        const link: DataTransferItemLike = { kind: 'string', getAsFile: () => a };
        expect(filesFromDrop({ items: [fileItem(a), link, fileItem(b)] })).toEqual({ files: [a, b], folders: 0 });
    });

    it('counts folders and leaves them out', () =>
    {
        const a = fakeFile('a.eml');
        expect(filesFromDrop({ items: [fileItem(fakeFile('Mail'), true), fileItem(a), fileItem(fakeFile('Old'), true)] })).toEqual({
            files: [a],
            folders: 2,
        });
    });

    it('treats an item as a file when the browser gives no entry information', () =>
    {
        const a = fakeFile('a.eml');
        const noEntry: DataTransferItemLike = { kind: 'file', getAsFile: () => a };
        const nullEntry: DataTransferItemLike = { kind: 'file', getAsFile: () => a, webkitGetAsEntry: () => null };
        const throwing: DataTransferItemLike = {
            kind: 'file',
            getAsFile: () => a,
            webkitGetAsEntry: () =>
            {
                throw new Error('no entries here');
            },
        };
        expect(filesFromDrop({ items: [noEntry, nullEntry, throwing] }).files).toEqual([a, a, a]);
    });

    it('skips a file item the browser cannot hand over', () =>
    {
        expect(filesFromDrop({ items: [{ kind: 'file', getAsFile: () => null }] })).toEqual({ files: [], folders: 0 });
    });

    it('falls back to the plain file list when there is no item list', () =>
    {
        const a = fakeFile('a.eml');
        expect(filesFromDrop({ files: [a] })).toEqual({ files: [a], folders: 0 });
        expect(filesFromDrop({ items: [], files: [a] })).toEqual({ files: [a], folders: 0 });
        expect(filesFromDrop(null)).toEqual({ files: [], folders: 0 });
    });
});

describe('summarize and summaryText', () =>
{
    it('uses the engine counts and failed files', () =>
    {
        const summary = summarize(engineResult(12, 10, 1, [{ fileName: 'notes.txt', error: 'unsupported-type', detail: 'not an email file' }]));
        expect(summary).toEqual({
            filesAdded: 12,
            filesFailed: 1,
            messagesFound: 10,
            attachedFound: 0,
            duplicatesMerged: 1,
            failed: [{ fileName: 'notes.txt', error: 'unsupported-type', detail: 'not an email file' }],
            batchError: null,
        });
        expect(summaryText(summary)).toBe('12 files added. 1 could not be read. 10 emails found. 1 identical copy merged.');
    });

    it('leaves out zero failures and zero merges, with English plurals', () =>
    {
        expect(summaryText(summarize(engineResult(1, 1, 0, [])))).toBe('1 file added. 1 email found.');
        expect(summaryText(summarize(engineResult(3, 0, 0, [])))).toBe('3 files added. 0 emails found.');
    });

    it('says how many emails were attached inside other emails, only when there are some (task 8.13b-4, P4)', () =>
    {
        const one = summarize(engineResult(1, 2, 0, [], 1));
        expect(one.attachedFound).toBe(1);
        expect(summaryText(one)).toBe('1 file added. 2 emails found (1 attached inside another email).');
        expect(summaryText(summarize(engineResult(3, 5, 1, [], 2)))).toBe('3 files added. 5 emails found (2 attached inside other emails). 1 identical copy merged.');
        expect(summaryText(summarize(engineResult(3, 3, 0, [], 0)))).toBe('3 files added. 3 emails found.');
    });

    it('counts what was read when the whole batch failed', () =>
    {
        const parsed: ParseResult[] = [
            { ok: false, fileName: 'big.eml', sha256: null, error: 'too-large', detail: 'too big' },
            { ok: true, message: {} as never },
        ];
        const summary = summarize({ ok: false, error: 'engine-timeout', detail: 'slow', parsed });
        expect(summary).toEqual({
            filesAdded: 2,
            filesFailed: 1,
            messagesFound: 1,
            attachedFound: 0,
            duplicatesMerged: 0,
            failed: [{ fileName: 'big.eml', error: 'too-large', detail: 'too big' }],
            batchError: 'engine-timeout',
        });
    });

    it('counts the emails attached inside the files read when the whole batch failed (task 8.13b-4, Q7)', () =>
    {
        const attached = (n: number): never => Array.from({ length: n }, () => ({})) as never;
        const parsed: ParseResult[] = [
            { ok: true, message: {} as never, attached: attached(2) },
            { ok: false, fileName: 'big.eml', sha256: null, error: 'too-large', detail: 'too big' },
            { ok: true, message: {} as never },
            { ok: true, message: {} as never, attached: attached(1) },
        ];
        const summary = summarize({ ok: false, error: 'engine-failed', detail: 'broken', parsed });
        // 3 files read + 3 attached emails, as the engine counts them (EngineCounts.messagesFound).
        expect(summary).toMatchObject({ filesAdded: 4, filesFailed: 1, messagesFound: 6, attachedFound: 3, duplicatesMerged: 0 });
        expect(summaryText(summary)).toBe('4 files added. 1 could not be read. 6 emails found (3 attached inside other emails).');
    });
});

describe('progressText', () =>
{
    it('names the file being read (one more than done), then the ordering step', () =>
    {
        expect(progressText({ stage: 'reading', filesDone: 0, filesTotal: 10 })).toBe('Reading file 1 of 10...');
        expect(progressText({ stage: 'reading', filesDone: 2, filesTotal: 10 })).toBe('Reading file 3 of 10...');
        expect(progressText({ stage: 'reading', filesDone: 10, filesTotal: 10 })).toBe('Reading file 10 of 10...');
        expect(progressText({ stage: 'organizing', filesDone: 10, filesTotal: 10 })).toBe(t('drop.organizing'));
    });
});

describe('readingStatusText', () =>
{
    it('gives the number of files, never a file number', () =>
    {
        expect(readingStatusText(1)).toBe('Reading your file...');
        expect(readingStatusText(2)).toBe('Reading 2 files. This can take a moment; the progress bar below shows how far it is.');
        expect(readingStatusText(1500)).toBe('Reading 1,500 files. This can take a moment; the progress bar below shows how far it is.');
    });
});

// --- The interface ----------------------------------------------------------------

describe('mountAddFiles: elements', () =>
{
    it('builds the zone with its text, a labelled button and a hidden multi-file input', () =>
    {
        expect(shell.addArea.children[0]).toBe(zone());
        expect(zone().textContent).toContain(t('drop.zone'));
        expect(button().tagName).toBe('button');
        expect(button().getAttribute('type')).toBe('button');
        expect(button().textContent).toBe(t('actions.chooseFiles'));
        expect(byId(button().getAttribute('aria-describedby') ?? '').textContent).toBe(t('drop.accepted'));
        expect(input().getAttribute('type')).toBe('file');
        expect(input().hasAttribute('multiple')).toBe(true);
        expect(input().getAttribute('accept')).toBe('.eml,.msg');
        expect(input().hasAttribute('hidden')).toBe(true);
        expect(zone().contains(input())).toBe(true);
    });

    it('has a progress bar labelled by its text, hidden at first, and hidden summary parts', () =>
    {
        const bar = byId('add-progress-bar');
        expect(bar.tagName).toBe('progress');
        expect(byId('add-progress-label').getAttribute('for')).toBe('add-progress-bar');
        expect(byId('add-progress').hasAttribute('hidden')).toBe(true);
        expect(byId('add-summary').hasAttribute('hidden')).toBe(true);
        expect(byId('add-notice').hasAttribute('hidden')).toBe(true);
    });

    it('uses no inline styles, handlers or links, and unique ids', () =>
    {
        // The shell's Ko-fi button (Source/page/app.test.ts checks it) is the one link and image.
        const donate = root.descendants().filter((e) => e.getAttribute('id') === 'donate-link' || e.getAttribute('class') === 'donate-image');
        expect(donate.map((e) => e.tagName)).toEqual(['a', 'img']);
        for (const element of doc.created)
        {
            if (donate.includes(element))
            {
                continue;
            }
            for (const name of element.attributes.keys())
            {
                expect(name).not.toMatch(/^(on|style$|href$|src$)/);
            }
        }
        const ids = root.descendants().flatMap((e) => e.getAttribute('id') ?? []);
        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe('mountAddFiles: choosing files', () =>
{
    it('the button opens the file chooser', () =>
    {
        button().click();
        expect(input().clicks).toBe(1);
    });

    it('runs processFiles on the chosen files, shows progress, then the summary', async () =>
    {
        choose('a.eml', 'b.msg');
        expect(control.calls).toHaveLength(1);
        expect(control.calls[0]?.files.map((f) => f.name)).toEqual(['a.eml', 'b.msg']);
        // Cleared, so choosing the same file again is still a change.
        expect(input().value).toBe('');

        // Busy: area aria-busy, button aria-disabled (not disabled), progress shown.
        expect(shell.addArea.getAttribute('aria-busy')).toBe('true');
        expect(button().getAttribute('aria-disabled')).toBe('true');
        expect(button().hasAttribute('disabled')).toBe(false);
        expect(byId('add-progress').hasAttribute('hidden')).toBe(false);
        // Its description says why first: the progress line, then the usual note.
        expect(button().getAttribute('aria-describedby')).toBe('add-progress-label drop-accepted');
        // The status line says what is going on, once, with no file number.
        expect(statuses).toEqual([readingStatusText(2)]);

        const { options, resolve } = control.calls[0] ?? expect.unreachable();
        options.onProgress?.({ stage: 'reading', filesDone: 0, filesTotal: 2 });
        expect(byId('add-progress-label').textContent).toBe('Reading file 1 of 2...');
        expect(byId('add-progress-bar').getAttribute('max')).toBe('2');
        expect(byId('add-progress-bar').getAttribute('value')).toBe('0');
        expect(lastStatus()).toBe(readingStatusText(2));
        options.onProgress?.({ stage: 'reading', filesDone: 1, filesTotal: 2 });
        expect(byId('add-progress-bar').getAttribute('value')).toBe('1');
        options.onProgress?.({ stage: 'organizing', filesDone: 2, filesTotal: 2 });
        expect(lastStatus()).toBe(t('drop.organizing'));
        // No value: an "in progress" bar.
        expect(byId('add-progress-bar').hasAttribute('value')).toBe(false);

        const result = engineResult(2, 2, 0, []);
        resolve(result);
        await settle();

        expect(results).toEqual([result]);
        expect(shell.addArea.hasAttribute('aria-busy')).toBe(false);
        expect(button().hasAttribute('aria-disabled')).toBe(false);
        expect(byId('add-progress').hasAttribute('hidden')).toBe(true);
        expect(byId('add-summary').hasAttribute('hidden')).toBe(false);
        expect(byId('add-summary-text').textContent).toBe('2 files added. 2 emails found.');
        expect(byId('add-failed').hasAttribute('hidden')).toBe(true);
        expect(lastStatus()).toBe('2 files added. 2 emails found.');
        expect(checkReady).toEqual([true]);
        expect(button().getAttribute('aria-describedby')).toBe('drop-accepted');
    });

    it('shows every progress update, but the status line changes only at the start, for "putting in order" and for the result', async () =>
    {
        choose(...Array.from({ length: 10 }, (_, i) => `${String(i)}.eml`));
        const { options, resolve } = control.calls[0] ?? expect.unreachable();
        for (let done = 0; done <= 10; done++)
        {
            options.onProgress?.({ stage: 'reading', filesDone: done, filesTotal: 10 });
            // The visible line follows every file.
            expect(byId('add-progress-label').textContent).toBe(`Reading file ${String(Math.min(done + 1, 10))} of 10...`);
            expect(byId('add-progress-bar').getAttribute('value')).toBe(String(done));
        }
        options.onProgress?.({ stage: 'organizing', filesDone: 10, filesTotal: 10 });
        // A repeated report is not announced again.
        options.onProgress?.({ stage: 'organizing', filesDone: 10, filesTotal: 10 });
        expect(statuses).toEqual([readingStatusText(10), t('drop.organizing')]);
        resolve(engineResult(10, 10, 0, []));
        await settle();
        expect(statuses).toEqual([readingStatusText(10), t('drop.organizing'), '10 files added. 10 emails found.']);
    });

    it('a second round (files added meanwhile) gets its own start text and its own "putting in order"', async () =>
    {
        choose('a.eml');
        const first = control.calls[0] ?? expect.unreachable();
        first.options.onProgress?.({ stage: 'organizing', filesDone: 1, filesTotal: 1 });
        choose('b.eml', 'c.eml');
        first.resolve(engineResult(1, 1, 0, []));
        await settle();
        const second = control.calls[1] ?? expect.unreachable();
        second.options.onProgress?.({ stage: 'reading', filesDone: 0, filesTotal: 3 });
        second.options.onProgress?.({ stage: 'organizing', filesDone: 3, filesTotal: 3 });
        expect(statuses).toEqual([readingStatusText(1), t('drop.organizing'), t('drop.queued'), readingStatusText(3), t('drop.organizing')]);
    });

    it('ignores an empty choice (dialog cancelled)', () =>
    {
        choose();
        input().files = null;
        input().fire('change');
        expect(control.calls).toHaveLength(0);
    });

    it('the button does nothing while busy', () =>
    {
        choose('a.eml');
        button().click();
        expect(input().clicks).toBe(0);
    });
});

describe('mountAddFiles: results', () =>
{
    it('lists failed files with their reason, the technical detail and the file name as text', async () =>
    {
        choose('a.eml', '<b>notes</b>.txt', '');
        control.calls[0]?.resolve(
            engineResult(3, 1, 0, [
                { fileName: '<b>notes</b>.txt', error: 'unsupported-type', detail: 'not an email file: only .eml and .msg files can be read' },
                { fileName: '', error: 'too-large', detail: 'the file is larger than 50 MB, the limit for one file' },
            ]),
        );
        await settle();

        expect(byId('add-failed').hasAttribute('hidden')).toBe(false);
        expect(byId('add-failed').textContent).toContain(t('added.failedTitle'));
        const items = byId('add-failed-list').children as FakeElement[];
        expect(items).toHaveLength(2);
        expect(items[0]?.textContent).toBe(
            `<b>notes</b>.txt ${t('errors.file.unsupported-type')}${t('added.details')}not an email file: only .eml and .msg files can be read`,
        );
        // The name is a text node inside <strong>: never markup.
        const strong = items[0]?.descendants().find((e) => e.tagName === 'strong');
        expect(strong?.descendants()).toEqual([]);
        expect(items[0]?.descendants().map((e) => e.tagName)).toEqual(['p', 'strong', 'details', 'summary', 'p']);
        expect(items[1]?.textContent).toContain(t('added.noName'));
        expect(items[1]?.textContent).toContain(t('errors.file.too-large'));
        expect(byId('add-summary-text').textContent).toBe('3 files added. 2 could not be read. 1 email found.');
        expect(checkReady).toEqual([true]);
        // Each "Technical details" is described by its own file name and reason.
        items.forEach((item, index) =>
        {
            const summary = item.descendants().find((e) => e.tagName === 'summary');
            const reason = byId(summary?.getAttribute('aria-describedby') ?? '');
            expect(reason.getAttribute('id')).toBe(`add-failed-${String(index)}-reason`);
            expect(item.contains(reason)).toBe(true);
            expect(reason.getAttribute('class')).toBe('failed-reason');
        });
    });

    it('a worker failure or a time limit is not shown as a damaged file', async () =>
    {
        choose('a.eml', 'b.msg', 'c.eml');
        control.calls[0]?.resolve(
            engineResult(3, 1, 0, [
                { fileName: 'b.msg', error: 'tool-error', detail: 'the reading step stopped unexpectedly (worker failed)' },
                { fileName: 'c.eml', error: 'timeout', detail: 'took too long to read (stopped)' },
            ]),
        );
        await settle();
        const items = byId('add-failed-list').children as FakeElement[];
        expect(items[0]?.textContent).toContain(`b.msg ${t('errors.file.tool-error')}`);
        expect(items[1]?.textContent).toContain(`c.eml ${t('errors.file.timeout')}`);
        expect(t('errors.file.tool-error')).toBe(
            'The tool could not read this file. To try again, reconnect to the internet, reload the page and add it again. If it fails again, the tool cannot read this file.',
        );
        for (const item of items)
        {
            expect(item.textContent).not.toContain(t('errors.file.corrupt'));
        }
    });

    it('a file the browser could not open is not shown as a damaged file', async () =>
    {
        choose('a.eml', 'moved.eml');
        control.calls[0]?.resolve(engineResult(2, 1, 0, [{ fileName: 'moved.eml', error: 'unreadable', detail: 'could not be read from your computer' }]));
        await settle();
        const items = byId('add-failed-list').children as FakeElement[];
        expect(items[0]?.textContent).toContain(`moved.eml ${t('errors.file.unreadable')}`);
        expect(items[0]?.textContent).not.toContain(t('errors.file.corrupt'));
        expect(t('errors.file.unreadable')).toBe('Your browser could not open this file. It may have been moved or changed since you chose it. Add it again.');
    });

    it('every piece of reload advice says the internet is needed (an offline page cannot reload)', () =>
    {
        const keys = ['errors.file.timeout', 'errors.file.tool-error', 'errors.batch.engine-timeout', 'errors.batch.engine-failed', 'errors.batch.unexpected'] as const;
        for (const key of keys)
        {
            expect(t(key)).toContain('reconnect to the internet, reload the page');
        }
        for (const key of ['errors.file.unreadable', 'errors.file.corrupt'] as const)
        {
            expect(t(key)).not.toMatch(/reload/i);
        }
    });

    it('does not open step 2 when no email was found', async () =>
    {
        choose('notes.txt');
        control.calls[0]?.resolve(engineResult(1, 0, 0, [{ fileName: 'notes.txt', error: 'unsupported-type', detail: 'x' }]));
        await settle();
        expect(checkReady).toEqual([false]);
    });

    it('shows the batch error and keeps the list of failed files when the engine fails', async () =>
    {
        choose('a.eml', 'big.eml');
        control.calls[0]?.resolve({
            ok: false,
            error: 'engine-failed',
            detail: 'the engine failed',
            parsed: [{ ok: true, message: {} as never }, { ok: false, fileName: 'big.eml', sha256: null, error: 'too-large', detail: 'too big' }],
        });
        await settle();
        expect(byId('add-batch-error').hasAttribute('hidden')).toBe(false);
        expect(byId('add-batch-error').textContent).toBe(t('errors.batch.engine-failed'));
        expect(byId('add-summary-text').textContent).toBe('2 files added. 1 could not be read. 1 email found.');
        expect(byId('add-failed-list').children).toHaveLength(1);
        expect(lastStatus()).toBe(`${t('errors.batch.engine-failed')} 2 files added. 1 could not be read. 1 email found.`);
        expect(checkReady).toEqual([false]);
        expect(results).toHaveLength(1);
    });

    it('turns a process function that rejects into a calm batch error', async () =>
    {
        addFiles.destroy();
        root = new FakeElement('div');
        const real = mountApp(root as unknown as HTMLElement);
        const got: ProcessResult[] = [];
        addFiles = mountAddFiles(real, {
            onResult: (r) => got.push(r),
            process: () => Promise.reject(new Error('bug')),
            listenerTarget: win as unknown as ListenerTarget,
        });
        choose('a.eml');
        await settle();
        expect(got).toEqual([{ ok: false, error: 'unexpected', detail: expect.any(String) as string, parsed: [] }]);
        expect(byId('add-batch-error').textContent).toBe(t('errors.batch.unexpected'));
    });
});

describe('mountAddFiles: adding more files', () =>
{
    it('re-runs on the whole list (old files first) each time files are added', async () =>
    {
        choose('a.eml');
        control.calls[0]?.resolve(engineResult(1, 1, 0, []));
        await settle();
        choose('b.eml', 'a.eml');
        expect(control.calls[1]?.files.map((f) => f.name)).toEqual(['a.eml', 'b.eml', 'a.eml']);
    });

    it('queues files added while busy, then runs once more with all of them and shows only that result', async () =>
    {
        choose('a.eml');
        choose('b.eml');
        expect(lastStatus()).toBe(t('drop.queued'));
        // Also in the visible notice, which progress updates do not overwrite.
        expect(byId('add-notice').hasAttribute('hidden')).toBe(false);
        expect(byId('add-notice').textContent).toBe(t('drop.queued'));
        control.calls[0]?.options.onProgress?.({ stage: 'reading', filesDone: 0, filesTotal: 1 });
        expect(byId('add-notice').textContent).toBe(t('drop.queued'));
        drop([fileItem(fakeFile('c.msg'))]);
        expect(control.calls).toHaveLength(1);
        expect(byId('add-notice').textContent).toBe(t('drop.queued'));

        control.calls[0]?.resolve(engineResult(1, 1, 0, []));
        await settle();
        // The stale result is not shown; one more round with every file.
        expect(results).toEqual([]);
        expect(control.calls).toHaveLength(2);
        // That round reads the waiting files: the notice has done its job.
        expect(byId('add-notice').hasAttribute('hidden')).toBe(true);
        expect(control.calls[1]?.files.map((f) => f.name)).toEqual(['a.eml', 'b.eml', 'c.msg']);
        expect(shell.addArea.getAttribute('aria-busy')).toBe('true');

        const final = engineResult(3, 3, 0, []);
        control.calls[1]?.resolve(final);
        await settle();
        expect(results).toEqual([final]);
        expect(control.calls).toHaveLength(2);
        expect(shell.addArea.hasAttribute('aria-busy')).toBe(false);
    });
});

describe('mountAddFiles: the queued notice', () =>
{
    it('keeps the folder message next to it, and reset() clears both', () =>
    {
        choose('a.eml');
        drop([fileItem(fakeFile('Mail'), true), fileItem(fakeFile('b.eml'))]);
        expect(byId('add-notice').textContent).toBe(`${t('drop.folders', { count: 1 })} ${t('drop.queued')}`);
        addFiles.reset();
        expect(byId('add-notice').hasAttribute('hidden')).toBe(true);
        expect(byId('add-notice').textContent).toBe('');
    });
});

describe('mountAddFiles: drag and drop', () =>
{
    it('always cancels the browser default (no navigation), everywhere on the page', () =>
    {
        for (const type of ['dragenter', 'dragover', 'drop'])
        {
            expect(win.fire(type, { target: root, dataTransfer: { types: ['Files'], items: [] } }).defaultPrevented, type).toBe(true);
            expect(win.fire(type, { target: zone(), dataTransfer: { types: ['text/uri-list'] } }).defaultPrevented, type).toBe(true);
            expect(win.fire(type, { target: win, dataTransfer: null }).defaultPrevented, type).toBe(true);
        }
    });

    it('shows the drag-over state only for files over the zone', () =>
    {
        const dataTransfer = { types: ['Files'], dropEffect: 'none' };
        win.fire('dragover', { target: zone().children[0], dataTransfer });
        expect(zone().getAttribute('data-state')).toBe('over');
        expect(dataTransfer.dropEffect).toBe('copy');
        win.fire('dragover', { target: root, dataTransfer });
        expect(zone().getAttribute('data-state')).toBe('idle');
        win.fire('dragenter', { target: zone(), dataTransfer: { types: ['text/plain'] } });
        expect(zone().getAttribute('data-state')).toBe('idle');
    });

    it('clears the drag-over state when the drag leaves the page, not when it moves inside', () =>
    {
        win.fire('dragover', { target: zone(), dataTransfer: { types: ['Files'] } });
        win.fire('dragleave', { target: zone(), relatedTarget: button() });
        expect(zone().getAttribute('data-state')).toBe('over');
        win.fire('dragleave', { target: zone(), relatedTarget: null });
        expect(zone().getAttribute('data-state')).toBe('idle');
    });

    it('adds the files dropped on the zone', () =>
    {
        win.fire('dragover', { target: zone(), dataTransfer: { types: ['Files'] } });
        const event = drop([fileItem(fakeFile('a.eml')), fileItem(fakeFile('b.msg'))]);
        expect(event.defaultPrevented).toBe(true);
        expect(zone().getAttribute('data-state')).toBe('idle');
        expect(control.calls[0]?.files.map((f) => f.name)).toEqual(['a.eml', 'b.msg']);
    });

    it('ignores files dropped outside the zone, with a calm message', () =>
    {
        const event = drop([fileItem(fakeFile('a.eml'))], byId('step-download'));
        expect(event.defaultPrevented).toBe(true);
        expect(control.calls).toHaveLength(0);
        expect(lastStatus()).toBe(t('drop.outside'));
    });

    it('says nothing when a link or text is dropped outside the zone', () =>
    {
        win.fire('drop', { target: root, dataTransfer: { types: ['text/uri-list'], items: [{ kind: 'string', getAsFile: () => null }] } });
        expect(statuses).toEqual([]);
    });

    it('explains a drop with no file in it', () =>
    {
        win.fire('drop', { target: zone(), dataTransfer: { types: ['text/uri-list'], items: [{ kind: 'string', getAsFile: () => null }] } });
        expect(control.calls).toHaveLength(0);
        expect(lastStatus()).toBe(t('drop.nothing'));
    });

    it('leaves dropped folders out with a notice, and still reads the files', () =>
    {
        drop([fileItem(fakeFile('Mail'), true), fileItem(fakeFile('a.eml'))]);
        expect(byId('add-notice').hasAttribute('hidden')).toBe(false);
        expect(byId('add-notice').textContent).toBe('1 folder could not be added. Open it and add the email files inside it instead.');
        expect(control.calls[0]?.files.map((f) => f.name)).toEqual(['a.eml']);
    });

    it('only folders: the notice, read aloud too, and nothing is processed', () =>
    {
        drop([fileItem(fakeFile('Mail'), true), fileItem(fakeFile('Old'), true)]);
        expect(control.calls).toHaveLength(0);
        expect(byId('add-notice').textContent).toBe(t('drop.folders', { count: 2 }));
        expect(lastStatus()).toBe(t('drop.folders', { count: 2 }));
    });

    it('the folder notice goes away with the next addition', async () =>
    {
        drop([fileItem(fakeFile('Mail'), true)]);
        choose('a.eml');
        await settle();
        expect(byId('add-notice').hasAttribute('hidden')).toBe(true);
    });

    it('destroy() removes the page-wide listeners', () =>
    {
        addFiles.destroy();
        expect(win.fire('drop', { target: zone(), dataTransfer: { types: ['Files'], items: [] } }).defaultPrevented).toBe(false);
        for (const type of ['dragenter', 'dragover', 'dragleave', 'drop'])
        {
            expect(win.listeners.count(type), type).toBe(0);
        }
    });
});

describe('mountAddFiles: reset', () =>
{
    it('forgets every file and puts step 1 back as at the start', async () =>
    {
        choose('a.eml');
        control.calls[0]?.resolve(engineResult(1, 1, 0, [{ fileName: 'x.txt', error: 'corrupt', detail: 'x' }]));
        await settle();
        drop([fileItem(fakeFile('Mail'), true)]);

        addFiles.reset();
        expect(byId('add-summary').hasAttribute('hidden')).toBe(true);
        expect(byId('add-failed-list').children).toEqual([]);
        expect(byId('add-notice').hasAttribute('hidden')).toBe(true);
        expect(byId('add-progress').hasAttribute('hidden')).toBe(true);
        expect(lastStatus()).toBe('');
        expect(checkReady.at(-1)).toBe(false);

        choose('b.eml');
        expect(control.calls[1]?.files.map((f) => f.name)).toEqual(['b.eml']);
    });

    it('throws away the result of a run that was still going', async () =>
    {
        choose('a.eml');
        const first = control.calls[0];
        addFiles.reset();
        expect(shell.addArea.hasAttribute('aria-busy')).toBe(false);
        expect(button().hasAttribute('aria-disabled')).toBe(false);
        first?.options.onProgress?.({ stage: 'organizing', filesDone: 1, filesTotal: 1 });
        first?.resolve(engineResult(1, 1, 0, []));
        await settle();
        expect(results).toEqual([]);
        expect(byId('add-summary').hasAttribute('hidden')).toBe(true);
        expect(lastStatus()).toBe('');
    });

    it('reset, then a new run starts, then the OLD run resolves: the old result is ignored', async () =>
    {
        choose('a.eml');
        const old = control.calls[0];
        addFiles.reset();
        choose('b.eml');
        const current = control.calls[1];
        expect(current?.files.map((f) => f.name)).toEqual(['b.eml']);
        expect(shell.addArea.getAttribute('aria-busy')).toBe('true');
        const statusesBefore = statuses.length;

        // The old run reports progress and finishes while the new one is going.
        old?.options.onProgress?.({ stage: 'organizing', filesDone: 1, filesTotal: 1 });
        old?.resolve(engineResult(1, 1, 0, [{ fileName: 'a.eml', error: 'corrupt', detail: 'old' }]));
        await settle();
        expect(results).toEqual([]);
        expect(statuses.length).toBe(statusesBefore);
        expect(byId('add-summary').hasAttribute('hidden')).toBe(true);
        // The new run is untouched: still busy, and no extra round was started.
        expect(shell.addArea.getAttribute('aria-busy')).toBe('true');
        expect(control.calls).toHaveLength(2);

        const final = engineResult(1, 1, 0, []);
        current?.resolve(final);
        await settle();
        expect(results).toEqual([final]);
        expect(byId('add-summary-text').textContent).toBe('1 file added. 1 email found.');
        expect(byId('add-failed').hasAttribute('hidden')).toBe(true);
        expect(shell.addArea.hasAttribute('aria-busy')).toBe(false);
    });

    it('cancels the run still going: its signal is aborted (workers terminated), a new run gets a fresh one', () =>
    {
        choose('a.eml');
        const old = control.calls[0];
        expect(old?.options.signal?.aborted).toBe(false);
        addFiles.reset();
        expect(old?.options.signal?.aborted).toBe(true);
        choose('b.eml');
        expect(control.calls[1]?.options.signal?.aborted).toBe(false);
        expect(control.calls[1]?.options.signal).not.toBe(old?.options.signal);
    });

    it('cancels during a queued second round too', async () =>
    {
        choose('a.eml');
        choose('b.eml'); // queued
        control.calls[0]?.resolve(engineResult(1, 1, 0, []));
        await settle();
        const second = control.calls[1];
        expect(second?.files.map((f) => f.name)).toEqual(['a.eml', 'b.eml']);
        addFiles.reset();
        expect(second?.options.signal?.aborted).toBe(true);
        second?.resolve(engineResult(2, 2, 0, []));
        await settle();
        expect(results).toEqual([]);
        expect(addFiles.hasFiles()).toBe(false);
    });

    it('empties the file input', () =>
    {
        choose('a.eml');
        input().value = 'C:\\fakepath\\a.eml'; // as if the browser still showed it
        addFiles.reset();
        expect(input().value).toBe('');
    });

    it('does not abort a finished run again, and reset() with nothing added is harmless', async () =>
    {
        addFiles.reset();
        choose('a.eml');
        const call = control.calls[0];
        call?.resolve(engineResult(1, 1, 0, []));
        await settle();
        addFiles.reset();
        // The run had finished: its signal was never needed.
        expect(call?.options.signal?.aborted).toBe(false);
    });
});

describe('mountAddFiles: hasFiles, onFilesChange and focus', () =>
{
    it('has no files at first; files being read, waiting or read count; reset() forgets them', async () =>
    {
        expect(addFiles.hasFiles()).toBe(false);
        expect(filesChanges).toBe(0);
        choose('a.eml');
        expect(addFiles.hasFiles()).toBe(true);
        expect(filesChanges).toBe(1);
        choose('b.eml'); // queued while busy
        expect(filesChanges).toBe(2);
        control.calls[0]?.resolve(engineResult(1, 1, 0, []));
        await settle();
        control.calls[1]?.resolve(engineResult(2, 2, 0, []));
        await settle();
        expect(addFiles.hasFiles()).toBe(true);
        addFiles.reset();
        expect(addFiles.hasFiles()).toBe(false);
        expect(filesChanges).toBe(3);
    });

    it('a batch where every file failed still has files (the failed list is shown)', async () =>
    {
        choose('notes.txt');
        control.calls[0]?.resolve(engineResult(1, 0, 0, [{ fileName: 'notes.txt', error: 'unsupported-type', detail: 'x' }]));
        await settle();
        expect(addFiles.hasFiles()).toBe(true);
    });

    it('an empty choice, a folder-only drop or a drop outside the zone adds nothing', () =>
    {
        input().files = [];
        input().fire('change');
        drop([fileItem(fakeFile('Mail'), true)]);
        drop([fileItem(fakeFile('a.eml'))], null);
        expect(addFiles.hasFiles()).toBe(false);
        expect(filesChanges).toBe(0);
    });

    it('a listener that throws does not stop step 1', () =>
    {
        addFiles.destroy();
        root = new FakeElement('div');
        const real = mountApp(root as unknown as HTMLElement);
        const local = controlledProcess();
        const broken = mountAddFiles(real, {
            onResult: () => undefined,
            process: local.process,
            listenerTarget: new FakeEventTarget() as unknown as ListenerTarget,
            onFilesChange: () =>
            {
                throw new Error('synthetic listener failure');
            },
        });
        choose('a.eml');
        expect(local.calls).toHaveLength(1);
        expect(() => broken.reset()).not.toThrow();
        broken.destroy();
    });

    it('focus() moves the focus to the "choose" button', () =>
    {
        expect(button().focuses).toBe(0);
        addFiles.focus();
        expect(button().focuses).toBe(1);
    });
});
