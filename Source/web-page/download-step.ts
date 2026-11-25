// Step 3: the "Make the PDF" button, its note, and the "Download again" link.
// The state lives in pdf-job.ts (no DOM); this file shows it and wires the
// button. Source/web-page/mount-page.ts says when the PDF can be made (`unavailable`), what
// goes in it (`input`) and when a choice changed (inputsChanged).
//
// - The button is aria-disabled (still focusable) while a PDF cannot be
//   made or is being made; its note (its accessible description) always
//   says why, or what pressing it does.
// - Pressing it: the time of the PDF is taken here, on the page; the PDF is
//   made in a worker (Source/worker-pipeline/pdf-worker-runner.ts), so the page never freezes.
//   The status line (the page's one live region) says "Making your PDF...",
//   then that it is ready (file name and page count), or a calm error.
// - When the PDF is ready, its download starts once by itself (a click on
//   the link, made by the page), and the link stays as "Download again".
//   The link's href is the PDF's blob: URL (setBlobHref, Source/web-page/safe-dom.ts);
//   its `download` attribute gives the file name, in the page language
//   (correspondence-YYYY-MM-DD.pdf in English).
// - Every change of choice (Source/web-page/mount-page.ts calls inputsChanged), "Clear
//   everything" (reset) and leaving the page (pagehide) drop the PDF: the
//   link is hidden and loses its href, the URL is revoked, a job still
//   running is stopped. A stale PDF is never offered. When a change of
//   choice drops a PDF being made or ready, the status line says so
//   (download.changed), so it never keeps announcing a PDF that is gone.
//   A change that has news of its own (an email ticked or unticked: "2 of 3
//   emails will be in the PDF.") passes it to inputsChanged, which makes ONE
//   announcement of it: the news alone, or the news followed by
//   download.changed when the PDF was dropped (download.changedAfter). Two
//   announcements in a row would replace each other in the one live region.
//   When that news turns out to word otherwise once final (the count line
//   waits for the PDF labels' cut, task 9.9f), newsCorrected says it again in
//   its place, the same way (with download.changed if it had it), but only
//   while the status line still says it.
// - The link sits in a line that keeps its place when empty (see app.css),
//   so the page below does not jump when it appears.
// Only our own words are shown, with textContent (README.md, rule R4).
// Nothing is stored (README.md, rule R5).

import type { ListenerTarget } from './add-files';
import type { PageShell } from './page-shell';
import { createSafeElement, setBlobHref, setSafeAttribute } from './safe-dom';
import { t } from './translations';
import { createPdfJob, type PdfJob, type PdfJobState, type PdfUnavailable } from './pdf-job';
import type { MakePdfRequest, PdfFontBytes, PdfJobInput, PdfOutcome } from '../../Header/pdf-worker-messages';

export interface DownloadStepOptions
{
    /** Why a PDF cannot be made now, or null when it can. */
    readonly unavailable: () => PdfUnavailable | null;
    /** What goes in the PDF, with `generatedAt` as its time; null if nothing can be made. */
    readonly input: (generatedAt: number) => PdfJobInput | null;
    /** The WOFF bytes of the PDF fonts (copied to the worker; this page keeps them). */
    readonly fonts: PdfFontBytes;
    /** Makes the PDF (the browser: runPdfInWorker with the PDF worker). */
    readonly run: (request: MakePdfRequest, signal: AbortSignal) => Promise<PdfOutcome>;
    /** The PDF's bytes -> a blob: URL (the browser: a Blob and URL.createObjectURL). */
    readonly createUrl: (bytes: Uint8Array, fileName: string) => string;
    /** The browser: URL.revokeObjectURL. */
    readonly revokeUrl: (url: string) => void;
    /** The page's origin (location.origin), to check the blob: URL. */
    readonly origin: string;
    /** The clock (Date.now): the PDF's "Made on" date and its file name. */
    readonly now: () => number;
    /** Where 'pagehide' is listened for (default: window). */
    readonly listenerTarget?: ListenerTarget;
}

export interface DownloadStep
{
    /** Shows whether the button is available now (call after anything `unavailable` depends on changed). */
    refresh(): void;
    /**
     * A choice changed: stops a running PDF, drops a ready one. `news`: what
     * the same action announces itself (see the top of this file); the status
     * line then gets it, alone or with download.changed, in one announcement.
     */
    inputsChanged(news?: string): void;
    /**
     * The news last given to inputsChanged (`said`) turned out to word
     * otherwise once final (task 9.9f review: the count line, once the PDF
     * labels' cut came). If the status line still says `said` (nothing else
     * was announced since), it says `news` instead, in the same way: alone,
     * or followed by download.changed when that change dropped the PDF.
     * Otherwise nothing.
     */
    newsCorrected(said: string, news: string): void;
    /** "Clear everything": stops and drops everything. */
    reset(): void;
    /** Writes the note (and the link, if any) again in the page language, from the state. */
    relabel(): void;
    /** The current state (for tests). */
    state(): PdfJobState;
}

/** The note under the button for a state. */
export function noteText(state: PdfJobState, unavailable: PdfUnavailable | null): string
{
    switch (state.kind)
    {
        case 'making':
            return t('download.making');
        case 'ready':
            return t('download.ready', { fileName: state.fileName, count: state.pageCount });
        case 'error':
            return t(`download.error.${state.error}`);
        case 'idle':
            if (unavailable !== null)
            {
                return t(`download.unavailable.${unavailable}`);
            }
            return state.changed ? t('download.changed') : t('download.available');
    }
}

export function mountDownloadStep(shell: Pick<PageShell, 'downloadButton' | 'downloadNote' | 'downloadArea' | 'setStatus' | 'statusText'>, options: DownloadStepOptions): DownloadStep
{
    const button = shell.downloadButton;
    const note = shell.downloadNote;
    const link = createSafeElement('a', { attrs: { id: 'download-link', class: 'download-link', hidden: true } });
    const linkLine = createSafeElement('p', { attrs: { class: 'download-again' }, children: [link] });
    shell.downloadArea.replaceChildren(linkLine);
    // The news of the change being handled by inputsChanged (null: none), and
    // whether its drop of the PDF was announced (with that news).
    let news: string | null = null;
    let dropAnnounced = false;
    // The last news inputsChanged put in the status line: the news, whether
    // with the drop, and the words written (newsCorrected corrects them only
    // while the status line still says them).
    let shown: { readonly news: string; readonly dropped: boolean; readonly text: string } | null = null;

    /** Writes `news` in the status line, alone or with the drop, and remembers it. */
    function showNews(text: string, dropped: boolean): void
    {
        const changed = t('download.changed');
        const written = dropped ? t('download.changedAfter', { news: text, changed }) : text;
        shell.setStatus(written);
        shown = { news: text, dropped, text: written };
    }

    const job: PdfJob = createPdfJob({
        run: options.run,
        createUrl: options.createUrl,
        revokeUrl: options.revokeUrl,
        onChange: (state) =>
        {
            render();
            if (state.kind === 'making')
            {
                shell.setStatus(t('download.making'));
            }
            else if (state.kind === 'error')
            {
                shell.setStatus(noteText(state, null));
            }
            else if (state.kind === 'ready')
            {
                shell.setStatus(noteText(state, null));
                // The download starts once by itself; the link stays for "Download again".
                link.click();
            }
            else if (state.changed)
            {
                // A choice dropped a PDF being made or ready: the status line must
                // not keep saying "Making your PDF..." or "Your PDF is ready".
                if (news === null)
                {
                    shell.setStatus(t('download.changed'));
                }
                else
                {
                    showNews(news, true);
                }
                dropAnnounced = true;
            }
        },
    });

    function safeUnavailable(): PdfUnavailable | null
    {
        try
        {
            return options.unavailable();
        }
        catch
        {
            return 'busy';
        }
    }

    function showLink(state: PdfJobState): void
    {
        if (state.kind === 'ready')
        {
            try
            {
                setBlobHref(link, state.url, options.origin);
            }
            catch
            {
                // Not our own blob: URL (a bug): no link at all rather than a wrong one.
                hideLink();
                return;
            }
            setSafeAttribute(link, 'download', state.fileName);
            link.textContent = t('download.again', { fileName: state.fileName });
            setSafeAttribute(link, 'hidden', false);
            return;
        }
        hideLink();
    }

    function hideLink(): void
    {
        setSafeAttribute(link, 'hidden', true);
        setSafeAttribute(link, 'href', false);
        setSafeAttribute(link, 'download', false);
        link.textContent = '';
    }

    function render(): void
    {
        const state = job.state();
        const unavailable = safeUnavailable();
        const off = state.kind === 'making' || unavailable !== null;
        setSafeAttribute(button, 'aria-disabled', off ? 'true' : false);
        note.textContent = noteText(state, unavailable);
        setSafeAttribute(note, 'class', state.kind === 'error' ? 'note download-note error-message' : 'note download-note');
        setSafeAttribute(shell.downloadArea, 'data-state', state.kind);
        setSafeAttribute(shell.downloadArea, 'aria-busy', state.kind === 'making' ? 'true' : false);
        showLink(state);
    }

    button.addEventListener('click', () =>
    {
        // aria-disabled: still focusable, but does nothing.
        if (job.isMaking() || safeUnavailable() !== null)
        {
            return;
        }
        let input: PdfJobInput | null;
        try
        {
            input = options.input(options.now());
        }
        catch
        {
            input = null;
        }
        if (input === null)
        {
            return;
        }
        job.start({ type: 'make', input, fonts: options.fonts });
    });

    // Leaving the page (or putting it in the back/forward cache): the PDF is dropped.
    (options.listenerTarget ?? window).addEventListener('pagehide', () => job.reset());

    render();

    return {
        refresh: render,
        inputsChanged(text)
        {
            news = text ?? null;
            dropAnnounced = false;
            try
            {
                job.inputsChanged();
            }
            finally
            {
                news = null;
            }
            // No PDF was dropped: the news alone.
            if (!dropAnnounced && text !== undefined)
            {
                showNews(text, false);
            }
            render();
        },
        newsCorrected(said, text)
        {
            // Only while the status line still says that news (nothing announced since).
            if (shown === null || shown.news !== said || shell.statusText() !== shown.text)
            {
                return;
            }
            showNews(text, shown.dropped);
        },
        reset: () => job.reset(),
        relabel: render,
        state: () => job.state(),
    };
}
