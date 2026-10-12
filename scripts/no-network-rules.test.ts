// Self-test for the "no network" check: feeds it synthetic strings with
// planted violations and checks that each one is reported.
import { describe, expect, it } from 'vitest';
import { checkBuiltHtml, checkHeadersFile, findViolations, normalizeUrl } from './no-network-rules.mjs';

const src = { isDist: false };
const dist = { isDist: true };

describe('findViolations', () => {
  it('accepts clean code', () => {
    expect(findViolations('const status = "ok";\nel.textContent = status;', src)).toEqual([]);
  });

  it('finds fetch( in all its forms, with the line number', () => {
    const found = findViolations('a();\nfetch("x");\nfetch ("x"); window.fetch("x");', src);
    expect(found.map((f) => [f.line, f.match])).toEqual([
      [2, 'fetch('],
      [3, 'fetch ('],
      [3, 'fetch('],
    ]);
  });

  it('does not flag words that merely contain fetch', () => {
    expect(findViolations('prefetch(); const fetched = 1;', src)).toEqual([]);
  });

  it('finds other network and storage APIs', () => {
    const code = 'new WebSocket(u); navigator.sendBeacon(u); localStorage.x; document.cookie; caches.open(n);';
    expect(findViolations(code, src).map((f) => f.match)).toEqual([
      'WebSocket',
      'sendBeacon',
      'localStorage',
      'document.cookie',
      'caches.',
    ]);
  });

  it('finds URLs that are not allowlisted', () => {
    const found = findViolations('<img src="https://example.com/x.png"> see http://example.org.', src);
    expect(found.map((f) => f.match)).toEqual(['https://example.com/x.png', 'http://example.org']);
  });

  it('finds WebSocket URLs (ws:// and wss://)', () => {
    const found = findViolations('connect("wss://example.invalid/x"); connect("WS://example.invalid/y");', src);
    expect(found.map((f) => f.match)).toEqual(['wss://example.invalid/x', 'WS://example.invalid/y']);
  });

  it('finds URLs with escaped slashes in dist-like text', () => {
    const code = String.raw`var c={"u":"https:\/\/example.invalid\/a.json"},d='http:/\/example.invalid';`;
    expect(findViolations(code, dist).map((f) => f.match)).toEqual([
      'https://example.invalid/a.json',
      'http://example.invalid',
    ]);
  });

  it('flags test code only in dist/', () => {
    const code = 'import "vitest"; describe("x", () => {});';
    expect(findViolations(code, src)).toEqual([]);
    expect(findViolations(code, dist).map((f) => f.match)).toEqual(['vitest', 'describe(']);
  });
});

describe('normalizeUrl', () => {
  it('unescapes slashes so an escaped URL compares equal to its allowlist form', () => {
    expect(normalizeUrl(String.raw`https:\/\/example.invalid\/repo`)).toBe('https://example.invalid/repo');
    expect(normalizeUrl('wss:\\/\\/example.invalid\\/x\\')).toBe('wss://example.invalid/x');
    expect(normalizeUrl('https://example.invalid/repo.')).toBe('https://example.invalid/repo');
  });
});

describe('checkBuiltHtml', () => {
  const meta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'" />`;

  it('accepts a CSP meta placed before scripts and links', () => {
    expect(checkBuiltHtml(`<head>${meta}<script src="/a.js"></script><link href="/a.css"></head>`)).toEqual([]);
  });

  it('rejects a CSP meta placed after a script', () => {
    expect(checkBuiltHtml(`<head><script src="/a.js"></script>${meta}</head>`)).toHaveLength(1);
  });

  it('rejects a missing CSP meta or missing directives', () => {
    expect(checkBuiltHtml('<head></head>')).toHaveLength(1);
    expect(checkBuiltHtml(`<meta http-equiv="Content-Security-Policy" content="script-src 'self'" />`)).toHaveLength(2);
  });
});

describe('checkHeadersFile', () => {
  it('accepts complete headers', () => {
    const text = [
      '/*',
      "  Content-Security-Policy: default-src 'none'; connect-src 'none'; frame-ancestors 'none'",
      '  Referrer-Policy: no-referrer',
      '  Permissions-Policy: camera=()',
    ].join('\n');
    expect(checkHeadersFile(text)).toEqual([]);
  });

  it('reports every missing header', () => {
    expect(checkHeadersFile('/*\n')).toHaveLength(3);
  });
});
