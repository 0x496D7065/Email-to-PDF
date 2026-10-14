// Self-test for the "no network" check: feeds it synthetic strings with
// planted violations and checks that each one is reported.
import { describe, expect, it } from 'vitest';
import {
  checkBuiltHtml,
  checkHeadersFile,
  decodeJsEscapes,
  findEmbeddedViolations,
  findOpaquePayloads,
  findViolations,
  normalizeUrl,
  OPAQUE_PAYLOAD_MIN_LENGTH,
  URL_ALLOWLIST,
} from './no-network-rules.mjs';

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

describe('HTML injection APIs (README.md, rule R4)', () => {
  it('flags every HTML injection API in dist/, in minified shapes', () => {
    const code = [
      'e.innerHTML=t;',
      'e.outerHTML+=t;',
      'e["innerHTML"]=t;',
      'Object.assign(e,{innerHTML:t});',
      'e.insertAdjacentHTML("beforeend",t);',
      'r.createContextualFragment(t);',
      'f.srcdoc=t;',
      'e.setHTMLUnsafe(t);Document.parseHTMLUnsafe(t);',
      'document.write(t);document . writeln (t);',
    ].join('\n');
    expect(findViolations(code, dist).map((f) => [f.line, f.match])).toEqual([
      [1, 'innerHTML'],
      [2, 'outerHTML'],
      [3, 'innerHTML'],
      [4, 'innerHTML'],
      [5, 'insertAdjacentHTML'],
      [6, 'createContextualFragment'],
      [7, 'srcdoc'],
      [8, 'setHTMLUnsafe'],
      [8, 'parseHTMLUnsafe'],
      [9, 'document.write('],
      [9, 'document . writeln ('],
    ]);
    expect(findViolations(code, dist).every((f) => f.reason.includes('rule R4'))).toBe(true);
  });

  it('does not flag them in src/ (comments there say "never innerHTML"; ESLint covers the source)', () => {
    expect(findViolations('// never use innerHTML here\ne.textContent = t;', src)).toEqual([]);
  });

  it('does not flag safe look-alikes', () => {
    const code = 'e.textContent=t;e.innerText=t;writer.write(t);e.myinnerHTMLx=1;e.srcdocument=1;';
    expect(findViolations(code, dist)).toEqual([]);
  });
});

describe('file-scoped URL allowlist (third-party notices)', () => {
  const apache = 'Apache License\n   http://www.apache.org/licenses/\n   http://www.apache.org/licenses/LICENSE-2.0\n';
  const notices = { isDist: true, distFile: 'THIRD_PARTY_NOTICES.txt' };

  it('keeps the global allowlist empty', () => {
    expect(URL_ALLOWLIST).toEqual([]);
  });

  it('accepts the Apache license URLs inside dist/THIRD_PARTY_NOTICES.txt', () => {
    expect(findViolations(apache, notices)).toEqual([]);
  });

  it('still rejects other URLs inside the notices file', () => {
    const found = findViolations('see https://example.invalid/x', notices);
    expect(found.map((f) => f.match)).toEqual(['https://example.invalid/x']);
  });

  it('rejects the Apache license URLs in any other dist/ file', () => {
    for (const distFile of ['assets/index-abc123.js', 'index.html', 'sub/THIRD_PARTY_NOTICES.txt']) {
      expect(findViolations(apache, { isDist: true, distFile })).toHaveLength(2);
    }
    expect(findViolations(apache, dist)).toHaveLength(2);
  });

  it('rejects the Apache license URLs in src/, even with a notices file name', () => {
    expect(findViolations(apache, src)).toHaveLength(2);
    expect(findViolations(apache, { isDist: false, distFile: 'THIRD_PARTY_NOTICES.txt' })).toHaveLength(2);
  });

  it('does not allow a longer URL that merely starts with an allowed one', () => {
    expect(findViolations('http://www.apache.org/licenses/x.js', notices)).toHaveLength(1);
  });

  it('rejects an uppercase Apache URL inside the notices file (no case folding)', () => {
    const found = findViolations('HTTP://WWW.APACHE.ORG/licenses/', notices);
    expect(found.map((f) => f.match)).toEqual(['HTTP://WWW.APACHE.ORG/licenses/']);
  });

  it('rejects the Apache URLs in a notices file name with different case', () => {
    expect(findViolations(apache, { isDist: true, distFile: 'third_party_notices.txt' })).toHaveLength(2);
  });

  it('rejects the Apache URLs in a backslash path ending in the notices file name', () => {
    expect(findViolations(apache, { isDist: true, distFile: 'sub\\THIRD_PARTY_NOTICES.txt' })).toHaveLength(2);
  });
});

describe('normalizeUrl', () => {
  it('unescapes slashes so an escaped URL compares equal to its allowlist form', () => {
    expect(normalizeUrl(String.raw`https:\/\/example.invalid\/repo`)).toBe('https://example.invalid/repo');
    expect(normalizeUrl('wss:\\/\\/example.invalid\\/x\\')).toBe('wss://example.invalid/x');
    expect(normalizeUrl('https://example.invalid/repo.')).toBe('https://example.invalid/repo');
  });
});

describe('decodeJsEscapes', () => {
  it('undoes every kind of string escape, in one pass', () => {
    // B is one backslash, written as a char code to keep these strings readable.
    const B = String.fromCharCode(92);
    const NL = String.fromCharCode(10);
    const TAB = String.fromCharCode(9);
    expect(decodeJsEscapes(`a${B}nb${B}tc${B}"d${B}'e${B}${B}f${B}/g`)).toBe(`a${NL}b${TAB}c"d'e${B}f/g`);
    expect(decodeJsEscapes(`${B}x66${B}u0065${B}u{74}ch`)).toBe('fetch');
    // A double backslash is ONE literal backslash: it does not start an escape.
    expect(decodeJsEscapes(`x${B}${B}ny`)).toBe(`x${B}ny`);
    // A line continuation (backslash, then a real line break) disappears.
    expect(decodeJsEscapes(`a${B}${NL}b`)).toBe('ab');
    expect(decodeJsEscapes('no escapes here')).toBe('no escapes here');
  });
});

describe('findEmbeddedViolations (code inlined as a string, e.g. a worker)', () => {
  // The shape Vite gives an inlined worker: its whole code in ONE string
  // literal, where each line break is written \n.
  const inlined = (workerCode: string): string => `const jsContent=${JSON.stringify(workerCode)};new Blob([jsContent]);`;

  it('finds network APIs that the raw scan misses right after an escaped line break', () => {
    const bundle = inlined('let a=1;\nXMLHttpRequest;\nfetch("x");\nindexedDB.open("x");');
    // The raw text has "\nXMLHttpRequest": the "n" hides the word boundary.
    expect(findViolations(bundle, dist)).toEqual([]);
    expect(findEmbeddedViolations(bundle, dist).map((f) => f.match)).toEqual(['XMLHttpRequest', 'fetch(', 'indexedDB']);
    expect(findEmbeddedViolations(bundle, dist)[0]?.reason).toMatch(/inside a string/);
  });

  it('finds HTML injection APIs and URLs written with escapes', () => {
    const bundle = inlined('x;\ninnerHTML=1;') + String.raw`const u="\x68ttps://example.invalid/a";`;
    expect(findEmbeddedViolations(bundle, dist).map((f) => f.match)).toEqual(['innerHTML', 'https://example.invalid/a']);
  });

  it('does not repeat findings the raw scan already reports, and accepts clean code', () => {
    expect(findEmbeddedViolations('fetch("x");', dist)).toEqual([]);
    expect(findEmbeddedViolations(`fetch("x");${inlined('a;\nfetch("y");')}`, dist).map((f) => f.match)).toEqual(['fetch(']);
    expect(findEmbeddedViolations(inlined('const a = 1;\nself.onmessage = (e) => self.postMessage(e.data);'), dist)).toEqual([]);
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

describe('findOpaquePayloads (guards the worker inlining format)', () => {
  // Synthetic base64-looking text of a given length (no real payload).
  const run = (length: number): string => 'QUJD+/09'.repeat(Math.ceil(length / 8)).slice(0, length);

  it('uses a 10k-character threshold', () => {
    expect(OPAQUE_PAYLOAD_MIN_LENGTH).toBe(10000);
  });

  it('reports a worker inlined as base64 (atob of a long literal)', () => {
    const bundle = `const a=1;
const w=atob("${run(12000)}==");new Worker(URL.createObjectURL(new Blob([w])));`;
    const findings = findOpaquePayloads(bundle);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(2);
    expect(findings[0]?.match).toHaveLength(12002); // padding included
    expect(findings[0]?.reason).toMatch(/base64/);
  });

  it('reports a long run even without atob (any decoder could be used)', () => {
    expect(findOpaquePayloads(`x="${run(OPAQUE_PAYLOAD_MIN_LENGTH)}"`)).toHaveLength(1);
  });

  it('ignores runs just under the threshold and ordinary minified code', () => {
    expect(findOpaquePayloads(`x="${run(OPAQUE_PAYLOAD_MIN_LENGTH - 1)}"`)).toEqual([]);
    const minified = 'function a(b,c){return b+c}var d=a(1,2);'.repeat(5000);
    expect(findOpaquePayloads(minified)).toEqual([]);
    // Today's format: the worker as a plain (escaped) string literal.
    expect(findOpaquePayloads('const s="self.onmessage=(e)=>{postMessage(e.data)};";'.repeat(2000))).toEqual([]);
  });

  it('reports each long run separately, with its line', () => {
    const findings = findOpaquePayloads(`${run(10000)}
;
${run(11000)}`);
    expect(findings.map((f) => [f.line, f.match.length])).toEqual([
      [1, 10000],
      [3, 11000],
    ]);
  });

  it('accepts a custom threshold', () => {
    expect(findOpaquePayloads('abc;abcdef', 6).map((f) => f.match)).toEqual(['abcdef']);
  });
});
