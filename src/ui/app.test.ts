// Unit tests for the page shell, in Node with the recording fake DOM
// (tests/support/fake-dom.ts). The real page is checked in Chromium by
// e2e/app-shell.spec.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDocument, FakeElement, FakeText } from '../../tests/support/fake-dom';
import { mountApp, type AppShell } from './app';
import { t } from './i18n';

let doc: FakeDocument;
let root: FakeElement;
let shell: AppShell;

beforeEach(() => {
  doc = new FakeDocument();
  vi.stubGlobal('document', doc);
  root = new FakeElement('div');
  root.append(new FakeText('old content'));
  shell = mountApp(root as unknown as HTMLElement);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function all(tag: string): FakeElement[] {
  return root.descendants().filter((e) => e.tagName === tag);
}

function byId(id: string): FakeElement {
  const found = root.descendants().find((e) => e.getAttribute('id') === id);
  if (!found) throw new Error(`no element with id ${id}`);
  return found;
}

describe('mountApp', () => {
  it('replaces the root content with header, main and footer landmarks', () => {
    expect(root.children.map((c) => (c instanceof FakeElement ? c.tagName : 'text'))).toEqual(['header', 'main', 'footer']);
  });

  it('sets the page language and title from the strings module', () => {
    expect(doc.documentElement.getAttribute('lang')).toBe('en');
    expect(doc.title).toBe(t('app.name'));
  });

  it('shows the app name as the only h1, with the promise', () => {
    expect(all('h1').map((h) => h.textContent)).toEqual([t('app.name')]);
    expect(root.textContent).toContain(t('app.promise'));
  });

  it('has three step sections in order, each named by its heading', () => {
    const sections = all('section');
    expect(sections.map((s) => s.getAttribute('id'))).toEqual(['step-add', 'step-check', 'step-download']);
    const main = all('main')[0];
    expect(main?.descendants().filter((e) => e.tagName === 'h2').map((h) => h.textContent)).toEqual([
      `${t('steps.number', { number: 1 })} ${t('steps.add.title')}`,
      `${t('steps.number', { number: 2 })} ${t('steps.check.title')}`,
      `${t('steps.number', { number: 3 })} ${t('steps.download.title')}`,
    ]);
    for (const section of sections) {
      const heading = byId(section.getAttribute('aria-labelledby') ?? '');
      expect(heading.tagName).toBe('h2');
      expect(section.descendants()).toContain(heading);
    }
  });

  it('has one polite live region, present from the start and empty', () => {
    const live = root.descendants().filter((e) => e.hasAttribute('aria-live'));
    expect(live).toHaveLength(1);
    expect(live[0]?.getAttribute('aria-live')).toBe('polite');
    expect(live[0]?.getAttribute('role')).toBe('status');
    expect(live[0]?.textContent).toBe('');
    shell.setStatus('Reading file 1 of 2...');
    expect(live[0]?.textContent).toBe('Reading file 1 of 2...');
    shell.setStatus('');
    expect(live[0]?.textContent).toBe('');
  });

  it('starts step 2 in the waiting state and switches it', () => {
    const step = byId('step-check');
    const waiting = byId('check-waiting');
    expect(step.getAttribute('data-state')).toBe('waiting');
    expect(waiting.hasAttribute('hidden')).toBe(false);
    expect(byId('check-area').hasAttribute('hidden')).toBe(true);
    expect(shell.checkArea).toBe(byId('check-area'));

    shell.setCheckReady(true);
    expect(step.getAttribute('data-state')).toBe('ready');
    expect(waiting.hasAttribute('hidden')).toBe(true);
    expect(byId('check-area').hasAttribute('hidden')).toBe(false);

    shell.setCheckReady(false);
    expect(step.getAttribute('data-state')).toBe('waiting');
    expect(waiting.hasAttribute('hidden')).toBe(false);
    expect(byId('check-area').hasAttribute('hidden')).toBe(true);
  });

  it('has an empty container for step 1', () => {
    expect(shell.addArea).toBe(byId('add-area'));
    expect(byId('add-area').children).toEqual([]);
  });

  it('has a "Make the PDF" button that is unavailable but focusable, described by its note (why)', () => {
    const button = byId('download-button');
    expect(shell.downloadButton).toBe(button);
    expect(button.tagName).toBe('button');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.textContent).toBe(t('actions.makePdf'));
    expect(button.getAttribute('aria-disabled')).toBe('true');
    // Not `disabled`: a disabled button cannot be reached with Tab.
    expect(button.hasAttribute('disabled')).toBe(false);
    const note = byId(button.getAttribute('aria-describedby') ?? '');
    expect(shell.downloadNote).toBe(note);
    expect(note.textContent).toBe(t('download.unavailable.no-emails'));
    // The download link's container comes after the note, empty for now.
    expect(shell.downloadArea).toBe(byId('download-area'));
    expect(byId('download-area').children).toEqual([]);
  });

  it('has a "Clear everything" button at the end of step 1, unavailable but focusable, described by its note', () => {
    const button = byId('clear-everything');
    expect(shell.clearButton).toBe(button);
    expect(button.tagName).toBe('button');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.textContent).toBe(t('actions.clearEverything'));
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(false);
    // Described by why it is unavailable first, then its note; both visible.
    expect(button.getAttribute('aria-describedby')).toBe('clear-unavailable clear-note');
    expect(byId('clear-unavailable').textContent).toBe(t('clear.unavailable'));
    expect(byId('clear-unavailable').hasAttribute('hidden')).toBe(false);
    expect(byId('clear-note').textContent).toBe(t('clear.note'));
    const area = byId('clear-area').children;
    expect(area.indexOf(byId('clear-unavailable'))).toBe(area.indexOf(byId('clear-note')) - 1);
    // In step 1, after the add area (so after the "choose" button in the Tab order).
    const step = byId('step-add');
    expect(step.descendants()).toContain(button);
    const order = step.descendants();
    expect(order.indexOf(button)).toBeGreaterThan(order.indexOf(byId('add-area')));
    expect(byId('add-area').contains(button)).toBe(false);
  });

  it('setClearAvailable switches the button between available and aria-disabled', () => {
    const button = byId('clear-everything');
    shell.setClearAvailable(true);
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    // Available: the reason is gone, the note alone describes it.
    expect(button.getAttribute('aria-describedby')).toBe('clear-note');
    expect(byId('clear-unavailable').hasAttribute('hidden')).toBe(true);
    shell.setClearAvailable(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.getAttribute('aria-describedby')).toBe('clear-unavailable clear-note');
    expect(byId('clear-unavailable').hasAttribute('hidden')).toBe(false);
  });

  describe('privacy panel', () => {
    const topics = [
      ['privacy.does.title', ['privacy.does.local', 'privacy.does.noUpload', 'privacy.does.noSaving', 'privacy.does.wiped', 'privacy.does.pdf']],
      ['privacy.never.title', ['privacy.never.upload', 'privacy.never.tracking', 'privacy.never.remote', 'privacy.never.attachments']],
      ['privacy.check.title', ['privacy.check.offline', 'privacy.check.network', 'privacy.check.source']],
      ['privacy.notes.title', ['privacy.notes.trust', 'privacy.notes.console', 'privacy.notes.scripts', 'disclaimer.text']],
    ] as const;

    it('is a closed <details> in the header, after the promise, opened by its summary', () => {
      const panel = byId('privacy');
      expect(panel.tagName).toBe('details');
      expect(panel.hasAttribute('open')).toBe(false);
      const header = root.children[0] as FakeElement;
      expect(header.children.map((c) => (c instanceof FakeElement ? c.getAttribute('class') : 'text'))).toEqual(['app-name', 'promise', 'privacy']);
      // The summary comes first, so it is the line shown while closed (and the panel's name).
      const summary = panel.children[0] as FakeElement;
      expect(summary.tagName).toBe('summary');
      expect(summary.textContent).toBe(t('privacy.summary'));
      expect(all('summary')).toEqual([summary]);
    });

    it('has one h2 per topic, with its points in order, then the disclaimer', () => {
      const panel = byId('privacy');
      const headings = panel.descendants().filter((e) => /^h\d$/.test(e.tagName));
      expect(headings.map((h) => h.tagName)).toEqual(['h2', 'h2', 'h2', 'h2']);
      expect(headings.map((h) => h.textContent)).toEqual(topics.map(([title]) => t(title)));
      for (const [title, points] of topics) {
        const heading = headings.find((h) => h.textContent === t(title));
        const topic = panel.descendants().find((e) => e.tagName === 'div' && e.children[0] === heading);
        const texts = topic?.descendants().filter((e) => e.tagName === 'li' || e.tagName === 'p').map((e) => e.textContent);
        expect(texts, title).toEqual(points.map((key) => t(key)));
      }
      // The first three topics are lists, the last one short paragraphs.
      expect(panel.descendants().filter((e) => e.tagName === 'ul')).toHaveLength(3);
    });

    it('says what the page does, never does, how to check it, and its limits', () => {
      const text = byId('privacy').textContent;
      for (const phrase of [
        'only inside this browser tab',
        'Nothing leaves your computer',
        'no cookies, no browser storage',
        'Only the PDF you choose to download is saved',
        '"Clear everything"',
        'A PDF you already downloaded stays in your downloads',
        'never opens attached files',
        'turn off your internet',
        'Network tab',
        "The page's own files load once",
        'open source',
        'can see that the page was loaded, but never your emails',
        'Content Security Policy',
        '[U+05D0]',
        'Latin, Greek and Cyrillic text shows normally',
        'not legal advice',
      ]) {
        expect(text).toContain(phrase);
      }
    });

    it('has no link and no heading level other than h2 (the steps are h2 too)', () => {
      const panel = byId('privacy');
      expect(panel.descendants().filter((e) => e.tagName === 'a')).toEqual([]);
      expect(panel.descendants().some((e) => ['h1', 'h3', 'h4'].includes(e.tagName))).toBe(false);
    });
  });

  it('ends step 3 with the disclaimer, after the download area', () => {
    const step = byId('step-download');
    const disclaimer = byId('download-disclaimer');
    expect(disclaimer.tagName).toBe('p');
    expect(disclaimer.textContent).toBe(t('disclaimer.text'));
    expect(step.children.at(-1)).toBe(disclaimer);
    const order = step.descendants();
    expect(order.indexOf(disclaimer)).toBeGreaterThan(order.indexOf(byId('download-area')));
    // Not the button's description: that one says what the button does now.
    expect(byId('download-button').getAttribute('aria-describedby')).toBe('download-note');
  });

  it('has no external links and no inline styles or handlers', () => {
    for (const element of doc.created) {
      for (const name of element.attributes.keys()) {
        expect(name).not.toMatch(/^(on|style$|href$|src$)/);
      }
    }
  });

  it('uses unique ids', () => {
    const ids = root.descendants().flatMap((e) => e.getAttribute('id') ?? []);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
