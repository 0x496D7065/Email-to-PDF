// Unit tests for the safe element builder (README.md, rule R4). They run in
// Node with a recording fake DOM (tests/support/fake-dom.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeDocument, FakeElement, FakeText } from '../../tests/support/fake-dom';
import { URL_ALLOWLIST } from '../../scripts/no-network-rules.mjs';
import {
  attributeProblem,
  DONATION_IMAGE,
  DONATION_URL,
  donationLink,
  el,
  isOwnBlobUrl,
  isSafeUrl,
  SAFE_TAGS,
  setBlobHref,
  setSafeAttribute,
  type SafeTag,
} from './dom';

let doc: FakeDocument;

beforeEach(() => {
  doc = new FakeDocument();
  vi.stubGlobal('document', doc);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** el() returns real DOM types; in these tests they are fake elements. */
function fake(element: unknown): FakeElement {
  return element as FakeElement;
}

describe('el', () => {
  it('creates the element with its attributes, text and children', () => {
    const child = el('span', { text: 'child' });
    const p = fake(el('p', { attrs: { id: 'x', class: 'note', 'aria-live': 'polite' }, text: 'Hello', children: [child, ' tail'] }));
    expect(p.tagName).toBe('p');
    expect([...p.attributes]).toEqual([
      ['id', 'x'],
      ['class', 'note'],
      ['aria-live', 'polite'],
    ]);
    expect(p.textContent).toBe('Hellochild tail');
    expect(p.children[0]).toBe(child);
    expect(p.children[1]).toBeInstanceOf(FakeText);
  });

  it('shows markup-looking text as text (textContent / text nodes only)', () => {
    const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const p = fake(el('p', { text: hostile, children: [hostile] }));
    expect(p.textContent).toBe(hostile + hostile);
    // Only the <p> itself was created: the string never became elements.
    expect(doc.created.map((e) => e.tagName)).toEqual(['p']);
  });

  it('sets boolean attributes: true = present and empty, false = left out', () => {
    const b = fake(el('button', { attrs: { disabled: true, hidden: false } }));
    expect(b.getAttribute('disabled')).toBe('');
    expect(b.hasAttribute('hidden')).toBe(false);
  });

  it('refuses tags outside the safe list, even through a cast', () => {
    for (const tag of ['script', 'iframe', 'object', 'embed', 'style', 'link', 'base', 'meta', 'template', 'svg', 'form', 'img']) {
      expect(() => el(tag as SafeTag), tag).toThrow(/not allowed/);
    }
    expect(doc.created).toEqual([]);
  });

  it('creates every safe tag', () => {
    for (const tag of SAFE_TAGS) expect(fake(el(tag)).tagName).toBe(tag);
  });

  it('refuses dangerous attributes and throws before adding the element anywhere', () => {
    expect(() => el('button', { attrs: { onclick: 'alert(1)' } })).toThrow(/event handler/);
    // eslint-disable-next-line no-restricted-syntax -- deliberately asks for srcdoc to prove el() refuses it
    expect(() => el('div', { attrs: { srcdoc: '<p>x</p>' } })).toThrow(/not allowed/);
    expect(() => el('a', { attrs: { href: 'javascript:alert(1)' } })).toThrow(/fragment or a relative/);
  });
});

describe('attributeProblem', () => {
  it('accepts ordinary attributes', () => {
    for (const name of ['id', 'class', 'type', 'for', 'role', 'aria-label', 'aria-describedby', 'data-state', 'accept', 'tabindex', 'hidden']) {
      expect(attributeProblem(name, 'x'), name).toBeNull();
    }
  });

  it('refuses every event handler, whatever the case', () => {
    for (const name of ['onclick', 'onerror', 'onload', 'onfocus', 'on']) {
      expect(attributeProblem(name, 'x'), name).toMatch(/event handler/);
    }
    // Uppercase names are refused by the name rule (HTML lowercases them anyway).
    expect(attributeProblem('OnClick', 'x')).toMatch(/not allowed/);
  });

  it('refuses srcdoc, style and odd attribute names', () => {
    expect(attributeProblem('srcdoc', '<p>')).toMatch(/not allowed/);
    expect(attributeProblem('srcset', 'a.png 1x')).toMatch(/not allowed/);
    expect(attributeProblem('srclang', 'en')).toMatch(/not allowed/);
    expect(attributeProblem('style', 'color:red')).toMatch(/not allowed/);
    for (const name of ['xlink:href', 'a b', '', '1x', 'x"y', 'x=y']) {
      expect(attributeProblem(name, 'x'), name).toMatch(/not allowed/);
    }
  });

  it('refuses URL attributes other than href and src', () => {
    for (const name of ['action', 'formaction', 'poster', 'data', 'ping', 'background', 'cite', 'manifest']) {
      expect(attributeProblem(name, '#x'), name).toMatch(/URL attribute/);
    }
  });

  it('allows href and src only with safe values', () => {
    expect(attributeProblem('href', '#privacy')).toBeNull();
    expect(attributeProblem('src', 'icons/logo.png')).toBeNull();
    expect(attributeProblem('href', 'https://example.invalid/')).toMatch(/fragment or a relative/);
  });
});

describe('isSafeUrl', () => {
  it('accepts fragments and plain same-site relative paths', () => {
    for (const url of ['#', '#main', '#step-2', 'privacy.html', './privacy.html', '../a/b.html', '/privacy', 'page?x=1&y=2#top']) {
      expect(isSafeUrl(url), url).toBe(true);
    }
  });

  it('refuses schemes, other sites and hidden tricks', () => {
    for (const url of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'data:text/html,<p>',
      'blob:x',
      'https://example.invalid/',
      'http://example.invalid/',
      'mailto:someone@example.invalid',
      '//example.invalid/x',
      '\\\\example.invalid\\x',
      '/\\example.invalid',
      '#a b',
      '#a\u0000b',
      '#a\u007fb',
      '',
    ]) {
      expect(isSafeUrl(url), JSON.stringify(url)).toBe(false);
    }
  });
});

describe('setSafeAttribute', () => {
  it('sets, empties and removes, and refuses like el()', () => {
    const div = new FakeElement('div');
    const target = div as unknown as Element;
    setSafeAttribute(target, 'hidden', true);
    expect(div.getAttribute('hidden')).toBe('');
    setSafeAttribute(target, 'hidden', false);
    expect(div.hasAttribute('hidden')).toBe(false);
    setSafeAttribute(target, 'data-state', 'ready');
    expect(div.getAttribute('data-state')).toBe('ready');
    expect(() => setSafeAttribute(target, 'onmouseover', 'x')).toThrow(/event handler/);
    expect(div.hasAttribute('onmouseover')).toBe(false);
  });

  it('checks the name before removing too', () => {
    const target = new FakeElement('div') as unknown as Element;
    expect(() => setSafeAttribute(target, 'xlink:href', false)).toThrow(/not allowed/);
    expect(() => setSafeAttribute(target, 'Hidden', false)).toThrow(/not allowed/);
    // A URL attribute can still be removed (no value to check).
    expect(() => setSafeAttribute(target, 'href', false)).not.toThrow();
  });
});

describe('isOwnBlobUrl / setBlobHref (step 3 download link only)', () => {
  const ORIGIN = 'http://127.0.0.1:4173';
  const OWN = `blob:${ORIGIN}/0f8c2b6e-1a2b-4c3d-9e8f-0123456789ab`;

  it('accepts exactly a blob: URL of this page', () => {
    expect(isOwnBlobUrl(OWN, ORIGIN)).toBe(true);
    expect(isOwnBlobUrl(`blob:${ORIGIN}/ABCDEF-12`, ORIGIN)).toBe(true);
  });

  it('refuses anything else', () => {
    for (const url of [
      'blob:x',
      `blob:${ORIGIN}/`,
      `blob:${ORIGIN}/0f8c?x=1`,
      `blob:${ORIGIN}/../x`,
      `blob:${ORIGIN}/0f8c#a`,
      `blob:${ORIGIN}/0f8c\n`,
      `blob:${ORIGIN}/0f8c\u{0}`,
      `blob:${ORIGIN}.example.invalid/0f8c`,
      'blob:http://example.invalid/0f8c',
      `${ORIGIN}/0f8c`,
      `BLOB:${ORIGIN}/0f8c`,
      'javascript:alert(1)',
      'data:application/pdf,x',
      '',
    ]) {
      expect(isOwnBlobUrl(url, ORIGIN), JSON.stringify(url)).toBe(false);
    }
    // No usable origin (not a browser page, or an opaque one): nothing is accepted.
    expect(isOwnBlobUrl('blob:null/0f8c', 'null')).toBe(false);
    expect(isOwnBlobUrl('blob:/0f8c', '')).toBe(false);
  });

  it('sets href only to such a URL; el() and setSafeAttribute still refuse every blob: URL', () => {
    const a = new FakeElement('a');
    const link = a as unknown as HTMLAnchorElement;
    setBlobHref(link, OWN, ORIGIN);
    expect(a.getAttribute('href')).toBe(OWN);
    expect(() => setBlobHref(link, 'blob:http://example.invalid/0f8c', ORIGIN)).toThrow(/blob: URL made by this page/);
    expect(() => setBlobHref(link, 'javascript:alert(1)', ORIGIN)).toThrow(/blob: URL made by this page/);
    expect(a.getAttribute('href')).toBe(OWN);
    expect(() => setSafeAttribute(link, 'href', OWN)).toThrow(/fragment or a relative/);
    expect(() => el('a', { attrs: { href: OWN } })).toThrow(/fragment or a relative/);
  });
});

describe('donationLink (the Ko-fi button only)', () => {
  it('builds a plain link to DONATION_URL, opening a new tab, around the bundled image', () => {
    const { link, image } = donationLink('donate-link');
    const a = fake(link);
    const img = fake(image);
    expect(doc.created.map((e) => e.tagName)).toEqual(['a', 'img']);
    expect([...a.attributes]).toEqual([
      ['href', DONATION_URL],
      ['id', 'donate-link'],
      ['class', 'donate'],
      ['target', '_blank'],
      ['rel', 'noopener noreferrer'],
    ]);
    expect(a.children).toEqual([img]);
    // Its own pixel size (no layout shift); the alt text is set by the caller.
    expect([...img.attributes]).toEqual([
      ['class', 'donate-image'],
      ['src', 'ko-fi/support_me_on_kofi_blue.png'],
      ['width', '980'],
      ['height', '198'],
    ]);
  });

  it('points at the one URL of the build check allowlist, and the image at a same-site relative path', () => {
    expect(URL_ALLOWLIST).toEqual([DONATION_URL]);
    expect(isSafeUrl(DONATION_IMAGE.src)).toBe(true);
    expect(DONATION_IMAGE.src.startsWith('/')).toBe(false);
  });

  it('is the only way to an https: link or an image: el() and setSafeAttribute still refuse both', () => {
    expect(() => el('a', { attrs: { href: DONATION_URL } })).toThrow(/fragment or a relative/);
    expect(() => setSafeAttribute(new FakeElement('a') as unknown as Element, 'href', DONATION_URL)).toThrow(/fragment or a relative/);
    expect(() => el('img' as SafeTag)).toThrow(/not allowed/);
  });
});
