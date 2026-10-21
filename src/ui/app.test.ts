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
    expect(all('h2').map((h) => h.textContent)).toEqual([
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
    expect(byId(button.getAttribute('aria-describedby') ?? '').textContent).toBe(t('clear.note'));
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
    shell.setClearAvailable(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.hasAttribute('disabled')).toBe(false);
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
