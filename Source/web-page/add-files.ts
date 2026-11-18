// Step 1: adding email files, by drag-and-drop or with a "choose" button.
//
// What it does:
// - keeps the added files in a list, in memory only (README.md, rule R5);
//   adding more files later adds them to the list;
// - after each addition, runs processFiles on the WHOLE list (finding
//   identical copies needs every message at once) and hands the result to
//   `onResult` (step 2 shows it);
// - shows progress while it works, then a short summary and the files that
//   could not be read, with the reason. One bad file never stops the others.
//
// UI choices (accessibility and safety):
// - The visible control is a real <button>. The <input type="file"> is
//   `hidden` (not shown, not focusable, not in the accessibility tree) and
//   the button opens it with input.click(). A native button gets Enter,
//   Space, focus and its accessible name for free, and there is only ONE tab
//   stop. (A <label> styled as a button cannot be reached with Tab, and a
//   visually hidden but focusable input would add a second, invisible one.)
// - Page-wide drag-and-drop listeners on `window` always cancel the
//   browser's default action: otherwise a file dropped a little next to the
//   drop zone would make the browser OPEN it in place of this page, and
//   everything the user added would be gone.
// - Files dropped outside the drop zone are NOT added: a calm message says
//   where to drop them. The zone lights up while files are dragged over it,
//   so a drop that adds files is always one the user could see coming.
// - Only real files are taken from a drop (no links or text). A dropped
//   folder is recognised where the browser can tell (webkitGetAsEntry) and
//   gets a calm message; elsewhere it fails as an unreadable file.
// - While files are being read, the area is aria-busy and the button is
//   aria-disabled (still focusable, see page-shell.ts), described by the progress
//   line so it says why. Files dropped meanwhile wait
//   in a queue and are read in one more round once the current one is done;
//   a visible notice says so until that round starts.
// - The progress line and bar follow every file. The status line (the
//   page's one live region, also visible) gets one stable text per round with
//   no file number ("Reading 120 files..."), then "putting in order", then the
//   result: a screen reader does not read out hundreds of updates, and the
//   visible status never shows a file number that looks stuck while the
//   progress line moves on.
//
// Every word comes from translations/ and goes into the page with textContent
// through createSafeElement() (README.md, rule R4). File names are untrusted: text only.
// The technical details of a failed file are the parser's own English
// words (never translated), marked lang="en" for screen readers.
//
// Language change (relabel): the fixed words are recorded (Source/web-page/static-labels.ts);
// the notice, progress line and summary are written again from what this
// step keeps anyway (numbers and codes, never a translated sentence); each
// failed file's reason is rewritten in place, so its "Technical details"
// stays open or closed and keeps the focus.

import { processFiles, UNEXPECTED_BATCH_DETAIL } from '../worker-pipeline/process-files';
import { attachedCount } from '../web-page-logic/attached-links';
import type { PageShell } from './page-shell';
import { createSafeElement, setSafeAttribute } from './safe-dom';
import { t } from './translations';
import { createStaticLabels } from './static-labels';
import type { FileLike, ProcessOptions, ProcessProgress, ProcessResult } from '../../Header/file-processing';
import type { FailedFile } from '../../Header/thread-analysis-result';

/** The file types the chooser offers (drops are checked by the parsers anyway). */
export const ACCEPTED_TYPES = '.eml,.msg';

/** Where page-wide listeners go (`window` in the page, a fake in unit tests). */
export interface ListenerTarget
{
    addEventListener(type: string, listener: (event: Event) => void): void;
    removeEventListener(type: string, listener: (event: Event) => void): void;
}

export interface AddFilesOptions
{
    /** Called with each finished result (not for results made stale by more files or by reset()). */
    readonly onResult: (result: ProcessResult) => void;
    /** Replaceable for unit tests. Default: the real pipeline (processFiles). */
    readonly process?: (files: readonly FileLike[], options: ProcessOptions) => Promise<ProcessResult>;
    /** Where the page-wide drag-and-drop listeners go. Default: window. */
    readonly listenerTarget?: ListenerTarget;
    /** Called whenever hasFiles() may have changed (files added, reset()). */
    readonly onFilesChange?: () => void;
}

export interface AddFiles
{
    /**
     * Forgets every file and puts step 1 back as it was at the start (for
     * "Clear everything"). A run still going is cancelled: its workers are
     * terminated and its result is thrown away.
     */
    reset(): void;
    /** True once files were added (being read, waiting, or read), until reset(). */
    hasFiles(): boolean;
    /** True while files are being read and organized (step 3 waits for the result). */
    isBusy(): boolean;
    /** Moves the keyboard focus to the "choose files" button. */
    focus(): void;
    /** Writes step 1's words again in the page language now (nothing is rebuilt). */
    relabel(): void;
    /** Removes the page-wide listeners (tests; the page keeps them for its whole life). */
    destroy(): void;
}

// ---------------------------------------------------------------------------
// Pure helpers (unit tested without a DOM).

/** The parts of a DataTransfer item used here. */
export interface DataTransferItemLike
{
    readonly kind: string;
    getAsFile(): FileLike | null;
    /** Chromium, Firefox and Safari have it; it tells a folder from a file. */
    webkitGetAsEntry?: () => { readonly isDirectory: boolean } | null;
}

/** The parts of a DataTransfer used here. */
export interface DataTransferLike
{
    readonly types?: ArrayLike<string>;
    readonly items?: ArrayLike<DataTransferItemLike>;
    readonly files?: ArrayLike<FileLike>;
}

/** True if a drag carries files (as opposed to a link or some text). */
export function carriesFiles(dataTransfer: DataTransferLike | null | undefined): boolean
{
    return dataTransfer?.types !== undefined && Array.from(dataTransfer.types).includes('Files');
}

/**
 * The files of a drop, and how many folders were left out. Must be called
 * during the drop event itself: browsers empty the DataTransfer afterwards.
 */
export function filesFromDrop(dataTransfer: DataTransferLike | null | undefined): { files: FileLike[]; folders: number }
{
    const files: FileLike[] = [];
    let folders = 0;
    const items = dataTransfer?.items === undefined ? [] : Array.from(dataTransfer.items);
    if (items.length === 0)
    {
        // No item list (older browsers): the plain file list. A folder then shows
        // up as a file that cannot be read, and is listed as such.
        return { files: dataTransfer?.files === undefined ? [] : Array.from(dataTransfer.files), folders };
    }
    for (const item of items)
    {
        // 'string' items are links or text: never taken.
        if (item.kind !== 'file')
        {
            continue;
        }
        let isFolder = false;
        try
        {
            isFolder = item.webkitGetAsEntry?.()?.isDirectory === true;
        }
        catch
        {
            // No entry information: treat it as a file; a folder then fails to read.
        }
        if (isFolder)
        {
            folders++;
            continue;
        }
        const file = item.getAsFile();
        if (file !== null)
        {
            files.push(file);
        }
    }
    return { files, folders };
}

/** One file that could not be read, as listed in step 1. */
export interface FailedEntry
{
    readonly fileName: string;
    readonly error: FailedFile['error'];
    readonly detail: string;
}

/** A failed file's item in the page: what its reason line is rewritten from (see relabel). */
interface FailedItem
{
    readonly reason: HTMLParagraphElement;
    /** The <strong> with the file name, or with the "no name" text when `unnamed`. */
    readonly name: HTMLElement;
    readonly unnamed: boolean;
    readonly error: FailedFile['error'];
    /** Its "Technical details" line. */
    readonly summary: HTMLElement;
}

/** What step 1 shows after a batch. */
export interface BatchSummary
{
    readonly filesAdded: number;
    readonly filesFailed: number;
    /** Every email found, the ones attached inside other emails included. */
    readonly messagesFound: number;
    /** How many of `messagesFound` were attached inside other emails (task 8.13b-4, P4). */
    readonly attachedFound: number;
    readonly duplicatesMerged: number;
    readonly failed: readonly FailedEntry[];
    /** Set when the whole batch has no result (ok: false). */
    readonly batchError: Extract<ProcessResult, { ok: false }>['error'] | null;
}

/** The numbers and lists step 1 shows for a result. */
export function summarize(result: ProcessResult): BatchSummary
{
    if (result.ok)
    {
        const { counts, failed } = result.threadAnalysis;
        return {
            filesAdded: counts.filesGiven,
            filesFailed: counts.filesFailed,
            messagesFound: counts.messagesFound,
            attachedFound: attachedCount(result.threadAnalysis),
            duplicatesMerged: counts.duplicatesMerged,
            failed: failed.map((f) => ({ fileName: f.fileName, error: f.error, detail: f.detail })),
            batchError: null,
        };
    }
    // No thread analysis result: count what was read, the emails attached inside the
    // files read included (as the thread analysis counts them, task 8.13b-4, Q7).
    // Duplicates are unknown (not merged).
    const failed = result.parsed.flatMap((p) => (p.ok ? [] : [{ fileName: p.fileName, error: p.error, detail: p.detail }]));
    const attachedFound = result.parsed.reduce((n, p) => n + (p.ok && Array.isArray(p.attached) ? p.attached.length : 0), 0);
    return {
        filesAdded: result.parsed.length,
        filesFailed: failed.length,
        messagesFound: result.parsed.length - failed.length + attachedFound,
        attachedFound,
        duplicatesMerged: 0,
        failed,
        batchError: result.error,
    };
}

/**
 * "12 files added. 2 could not be read. 9 emails found. 1 identical copy
 * merged." With emails attached inside other emails: "9 emails found (2
 * attached inside other emails)." (task 8.13b-4, P4).
 */
export function summaryText(summary: BatchSummary): string
{
    const parts = [t('added.files', { count: summary.filesAdded })];
    if (summary.filesFailed > 0)
    {
        parts.push(t('added.failed', { count: summary.filesFailed }));
    }
    parts.push(
        summary.attachedFound > 0
            ? t('added.messagesAttached', { count: summary.messagesFound, attached: t('counts.attachedFound', { count: summary.attachedFound }) })
            : t('added.messages', { count: summary.messagesFound }),
    );
    if (summary.duplicatesMerged > 0)
    {
        parts.push(t('added.merged', { count: summary.duplicatesMerged }));
    }
    return parts.join(' ');
}

/**
 * The status line while a round of `total` files is read: set once at the
 * start of the round, with no file number (the progress line has those).
 */
export function readingStatusText(total: number): string
{
    return total === 1 ? t('drop.readingOne') : t('drop.readingMany', { total });
}

/** The progress line: which file is being read, then "putting in order". */
export function progressText(progress: ProcessProgress): string
{
    if (progress.stage === 'organizing')
    {
        return t('drop.organizing');
    }
    // processFiles reports files DONE; the user wants to know which one is
    // being read now, so "Reading file 1 of 3" while the first one is read.
    const current = Math.min(progress.filesDone + 1, progress.filesTotal);
    return t('drop.reading', { done: current, total: progress.filesTotal });
}

// ---------------------------------------------------------------------------
// The step 1 interface.

/** A safe failed result for a process function that broke its "never rejects" promise. */
function unexpectedResult(): ProcessResult
{
    return { ok: false, error: 'unexpected', detail: UNEXPECTED_BATCH_DETAIL, parsed: [] };
}

/** True for a DOM node (an event target can also be window or document). */
function isNode(value: unknown): value is Node
{
    return typeof value === 'object' && value !== null && typeof (value as { nodeType?: unknown }).nodeType === 'number';
}

/** Builds step 1 inside shell.addArea and wires it up. */
export function mountAddFiles(shell: PageShell, options: AddFilesOptions): AddFiles
{
    const processBatch = options.process ?? processFiles;
    const target: ListenerTarget = options.listenerTarget ?? window;
    const labels = createStaticLabels();

    // --- Elements -----------------------------------------------------------
    const input = labels.attr(
        createSafeElement('input', { attrs: { type: 'file', id: 'file-input', multiple: true, accept: ACCEPTED_TYPES, hidden: true } }),
        'aria-label',
        'actions.chooseFiles',
    );
    const button = labels.text(
        createSafeElement('button', { attrs: { type: 'button', id: 'choose-files', class: 'button button-primary', 'aria-describedby': 'drop-accepted' } }),
        'actions.chooseFiles',
    );
    const zone = createSafeElement('div', {
        attrs: { id: 'drop-zone', class: 'drop-zone', 'data-state': 'idle' },
        children: [
            labels.text(createSafeElement('p', { attrs: { class: 'drop-zone-text' } }), 'drop.zone'),
            button,
            labels.text(createSafeElement('p', { attrs: { id: 'drop-accepted', class: 'note' } }), 'drop.accepted'),
            input,
        ],
    });
    // A visible message about the last addition: folders left out (kept until
    // the next addition), and/or files waiting for the current round.
    const notice = createSafeElement('p', { attrs: { id: 'add-notice', class: 'notice', hidden: true } });

    const progressLabel = createSafeElement('label', { attrs: { id: 'add-progress-label', for: 'add-progress-bar' } });
    const progressBar = createSafeElement('progress', { attrs: { id: 'add-progress-bar', class: 'progress-bar' } });
    const progressBox = createSafeElement('div', { attrs: { id: 'add-progress', class: 'progress', hidden: true }, children: [progressLabel, progressBar] });

    const summaryLine = createSafeElement('p', { attrs: { id: 'add-summary-text', class: 'summary-text' } });
    const batchError = createSafeElement('p', { attrs: { id: 'add-batch-error', class: 'error-message', hidden: true } });
    const failedList = createSafeElement('ul', { attrs: { id: 'add-failed-list', class: 'failed-list' } });
    const failedBox = createSafeElement('div', {
        attrs: { id: 'add-failed', hidden: true },
        children: [labels.text(createSafeElement('h3', { attrs: { class: 'failed-title' } }), 'added.failedTitle'), failedList],
    });
    const summaryBox = createSafeElement('div', { attrs: { id: 'add-summary', class: 'summary', hidden: true }, children: [summaryLine, batchError, failedBox] });

    shell.addArea.replaceChildren(zone, notice, progressBox, summaryBox);

    // --- State (memory only, README.md, rule R5) ------------------------------
    let files: FileLike[] = [];
    let pending: FileLike[] = [];
    let busy = false;
    // The two parts of the notice (see showNotice): how many folders the last
    // drop left out, and whether files wait for the current round.
    let foldersLeftOut = 0;
    let queuedNotice = false;
    // What the progress line and the summary show (numbers and codes only), to
    // write them again in another language; null: nothing shown.
    let lastProgress: ProcessProgress | null = null;
    let lastSummary: Omit<BatchSummary, 'failed'> | null = null;
    // The failed files' items in the page, to rewrite their reasons in place.
    let failedItems: FailedItem[] = [];
    // Increased by reset(): a run that started before it throws its result away.
    let generation = 0;
    // Cancels the current run's workers (reset()); one per run.
    let controller: AbortController | null = null;
    // Whether this round already put "putting in order" in the status line.
    let organizingAnnounced = false;

    function filesChanged(): void
    {
        try
        {
            options.onFilesChange?.();
        }
        catch
        {
            // A broken listener must not stop step 1.
        }
    }

    function setDragOver(over: boolean): void
    {
        setSafeAttribute(zone, 'data-state', over ? 'over' : 'idle');
    }

    function setBusy(value: boolean): void
    {
        busy = value;
        setSafeAttribute(shell.addArea, 'aria-busy', value ? 'true' : false);
        setSafeAttribute(button, 'aria-disabled', value ? 'true' : false);
        // While unavailable, the button's description starts with why: the
        // progress line ("Reading file 3 of 10..."), then the usual note.
        setSafeAttribute(button, 'aria-describedby', value ? 'add-progress-label drop-accepted' : 'drop-accepted');
        setSafeAttribute(progressBox, 'hidden', !value);
    }

    // The queued message lives here, not only in the status line: "putting in
    // order" or the next round may replace the status line soon after, so it
    // could vanish unread.
    function showNotice(): void
    {
        const folderText = foldersLeftOut > 0 ? t('drop.folders', { count: foldersLeftOut }) : '';
        const text = [folderText, queuedNotice ? t('drop.queued') : ''].filter((part) => part !== '').join(' ');
        notice.textContent = text;
        setSafeAttribute(notice, 'hidden', text === '');
    }

    function showProgress(progress: ProcessProgress): void
    {
        const text = progressText(progress);
        lastProgress = progress;
        progressLabel.textContent = text;
        if (progress.stage === 'reading')
        {
            setSafeAttribute(progressBar, 'max', String(progress.filesTotal));
            setSafeAttribute(progressBar, 'value', String(progress.filesDone));
        }
        else
        {
            // No value: an "in progress" bar with no percentage (the thread analysis gives none).
            setSafeAttribute(progressBar, 'value', false);
        }
        // The status line (the page's one live region) does not follow the files
        // (it got its text when the round started, see run()); it only changes
        // once more, for "putting in order".
        if (progress.stage === 'organizing' && !organizingAnnounced)
        {
            organizingAnnounced = true;
            shell.setStatus(text);
        }
    }

    /** The reason line of a failed file: its name (or the "no name" text) and why it failed. */
    function writeReason(item: FailedItem): void
    {
        if (item.unnamed)
        {
            item.name.textContent = t('added.noName');
        }
        // The <strong> is kept (it holds the file name); only the words change.
        item.reason.replaceChildren(item.name, ' ', t(`errors.file.${item.error}`));
        item.summary.textContent = t('added.details');
    }

    function failedItem(entry: FailedEntry, index: number): HTMLLIElement
    {
        const reasonId = `add-failed-${String(index)}-reason`;
        const name = createSafeElement('strong', entry.fileName === '' ? {} : { text: entry.fileName });
        const reason = createSafeElement('p', { attrs: { id: reasonId, class: 'failed-reason' } });
        // Every file has its own "Technical details": described by its
        // file name and reason, so each one says which file it is about.
        const summary = createSafeElement('summary', { attrs: { 'aria-describedby': reasonId } });
        const item: FailedItem = { reason, name, unnamed: entry.fileName === '', error: entry.error, summary };
        writeReason(item);
        failedItems.push(item);
        return createSafeElement('li', {
            attrs: { class: 'failed-file' },
            children: [
                reason,
                createSafeElement('details', {
                    children: [
                        summary,
                        // The parser's own technical words, in English in every language.
                        createSafeElement('p', { attrs: { class: 'failed-detail', lang: 'en' }, text: entry.detail }),
                    ],
                }),
            ],
        });
    }

    /** The summary line and the batch error, in the page language. */
    function writeSummary(summary: Omit<BatchSummary, 'failed'>): { line: string; errorText: string }
    {
        const line = summaryText({ ...summary, failed: [] });
        summaryLine.textContent = line;
        const errorText = summary.batchError === null ? '' : t(`errors.batch.${summary.batchError}`);
        batchError.textContent = errorText;
        return { line, errorText };
    }

    function showResult(result: ProcessResult): void
    {
        const summary = summarize(result);
        lastSummary = {
            filesAdded: summary.filesAdded,
            filesFailed: summary.filesFailed,
            messagesFound: summary.messagesFound,
            attachedFound: summary.attachedFound,
            duplicatesMerged: summary.duplicatesMerged,
            batchError: summary.batchError,
        };
        const { line, errorText } = writeSummary(lastSummary);
        setSafeAttribute(batchError, 'hidden', errorText === '');
        failedItems = [];
        failedList.replaceChildren(...summary.failed.map((entry, index) => failedItem(entry, index)));
        setSafeAttribute(failedBox, 'hidden', summary.failed.length === 0);
        setSafeAttribute(summaryBox, 'hidden', false);
        shell.setStatus(errorText === '' ? line : `${errorText} ${line}`);
        // Step 2 needs the thread analysis's result: after a batch error there is none to show.
        shell.setCheckReady(result.ok && result.threadAnalysis.messages.length > 0);
    }

    async function run(): Promise<void>
    {
        const myGeneration = generation;
        const myController = new AbortController();
        controller = myController;
        setBusy(true);
        let result: ProcessResult;
        // Files added during a round wait in `pending`; one more round then
        // reads the whole list again with them, and only its result is shown.
        do
        {
            files = [...files, ...pending];
            pending = [];
            // The waiting files are being read now: the queued message is done.
            if (queuedNotice)
            {
                queuedNotice = false;
                showNotice();
            }
            const batch = [...files];
            // One stable status text for the whole round (see the top of this file).
            organizingAnnounced = false;
            shell.setStatus(readingStatusText(batch.length));
            try
            {
                result = await processBatch(batch, {
                    onProgress: (progress) =>
                    {
                        if (myGeneration === generation)
                        {
                            showProgress(progress);
                        }
                    },
                    signal: myController.signal,
                });
            }
            catch
            {
                result = unexpectedResult();
            }
            if (myGeneration !== generation)
            {
                return; // reset() was pressed meanwhile
            }
        } while (pending.length > 0);
        controller = null;
        setBusy(false);
        showResult(result);
        options.onResult(result);
    }

    function add(newFiles: readonly FileLike[]): void
    {
        if (newFiles.length === 0)
        {
            return;
        }
        pending = [...pending, ...newFiles];
        if (busy)
        {
            filesChanged();
            queuedNotice = true;
            showNotice();
            // Announced once too; the status line keeps it until "putting in
            // order", the next round's start or the result replaces it.
            shell.setStatus(t('drop.queued'));
            return;
        }
        void run();
        // After run() started: it marks step 1 busy at once (before its first
        // wait), so a listener already sees the files as being read (step 3).
        filesChanged();
    }

    // --- Choose button ------------------------------------------------------
    button.addEventListener('click', () =>
    {
        if (busy)
        {
            return; // aria-disabled: does nothing, but stays focusable
        }
        input.click();
    });
    input.addEventListener('change', () =>
    {
        const chosen = input.files === null ? [] : Array.from(input.files);
        // Cleared so that choosing the same file again still counts as a change.
        input.value = '';
        foldersLeftOut = 0;
        showNotice();
        add(chosen);
    });

    // --- Drag and drop (page-wide, see the top of this file) ------------------
    const insideZone = (eventTarget: EventTarget | null): boolean => isNode(eventTarget) && zone.contains(eventTarget);

    const onDragOver = (event: Event): void =>
    {
        // Always cancelled: this is what stops the browser from opening a dropped file.
        event.preventDefault();
        const drag = event as DragEvent;
        const over = insideZone(drag.target) && carriesFiles(drag.dataTransfer);
        if (over && drag.dataTransfer)
        {
            drag.dataTransfer.dropEffect = 'copy';
        }
        setDragOver(over);
    };
    const onDragLeave = (event: Event): void =>
    {
        // relatedTarget is null when the pointer leaves the page (or the drag is cancelled).
        if ((event as DragEvent).relatedTarget === null)
        {
            setDragOver(false);
        }
    };
    const onDrop = (event: Event): void =>
    {
        event.preventDefault();
        setDragOver(false);
        const drag = event as DragEvent;
        if (!insideZone(drag.target))
        {
            if (carriesFiles(drag.dataTransfer))
            {
                shell.setStatus(t('drop.outside'));
            }
            return;
        }
        const { files: dropped, folders } = filesFromDrop(drag.dataTransfer);
        const folderText = folders > 0 ? t('drop.folders', { count: folders }) : '';
        foldersLeftOut = folders;
        showNotice();
        if (dropped.length > 0)
        {
            add(dropped);
        }
        else
        {
            shell.setStatus(folderText === '' ? t('drop.nothing') : folderText);
        }
    };

    const listeners: [string, (event: Event) => void][] = [
        ['dragenter', onDragOver],
        ['dragover', onDragOver],
        ['dragleave', onDragLeave],
        ['drop', onDrop],
    ];
    for (const [type, listener] of listeners)
    {
        target.addEventListener(type, listener);
    }

    return {
        reset()
        {
            generation++;
            // Terminates the run's workers; its late result is ignored (generation).
            controller?.abort();
            controller = null;
            files = [];
            pending = [];
            // Forgets the last choice in the file input too (README.md, rule R5).
            input.value = '';
            setBusy(false);
            setDragOver(false);
            foldersLeftOut = 0;
            queuedNotice = false;
            showNotice();
            lastProgress = null;
            lastSummary = null;
            failedItems = [];
            progressLabel.textContent = '';
            summaryLine.textContent = '';
            batchError.textContent = '';
            failedList.replaceChildren();
            setSafeAttribute(batchError, 'hidden', true);
            setSafeAttribute(failedBox, 'hidden', true);
            setSafeAttribute(summaryBox, 'hidden', true);
            shell.setStatus('');
            shell.setCheckReady(false);
            filesChanged();
        },
        hasFiles: () => files.length > 0 || pending.length > 0,
        isBusy: () => busy,
        focus()
        {
            button.focus();
        },
        relabel()
        {
            labels.relabel();
            showNotice();
            if (lastProgress !== null)
            {
                progressLabel.textContent = progressText(lastProgress);
            }
            if (lastSummary !== null)
            {
                writeSummary(lastSummary);
            }
            for (const item of failedItems)
            {
                writeReason(item);
            }
        },
        destroy()
        {
            for (const [type, listener] of listeners)
            {
                target.removeEventListener(type, listener);
            }
        },
    };
}
