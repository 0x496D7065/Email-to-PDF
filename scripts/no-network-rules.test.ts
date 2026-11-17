// Self-test for the "no network" check: feeds it synthetic strings with
// planted violations and checks that each one is reported.
import { describe, expect, it } from 'vitest';
import {
    checkBuiltHtml,
    checkHeadersFile,
    decodeJsEscapes,
    FILE_URL_ALLOWLIST,
    findEmbeddedViolations,
    findOpaquePayloads,
    findViolations,
    isRuleExempt,
    normalizeUrl,
    OPAQUE_PAYLOAD_MIN_LENGTH,
    RULE_EXEMPTIONS,
    RULES,
    SOURCE_FILE_URL_ALLOWLIST,
    URL_ALLOWLIST,
} from './no-network-rules.mjs';

const src = { isDist: false };
const dist = { isDist: true };

describe('findViolations', () =>
{
    it('accepts clean code', () =>
    {
        expect(findViolations('const status = "ok";\nel.textContent = status;', src)).toEqual([]);
    });

    it('finds fetch( in all its forms, with the line number', () =>
    {
        const found = findViolations('a();\nfetch("x");\nfetch ("x"); window.fetch("x");', src);
        expect(found.map((f) => [f.line, f.match])).toEqual([
            [2, 'fetch('],
            [3, 'fetch ('],
            [3, 'fetch('],
        ]);
    });

    it('does not flag words that merely contain fetch', () =>
    {
        expect(findViolations('prefetch(); const fetched = 1;', src)).toEqual([]);
    });

    it('finds other network and storage APIs', () =>
    {
        const code = 'new WebSocket(u); navigator.sendBeacon(u); localStorage.x; document.cookie; caches.open(n);';
        expect(findViolations(code, src).map((f) => f.match)).toEqual([
            'WebSocket',
            'sendBeacon',
            'localStorage',
            'document.cookie',
            'caches.',
        ]);
    });

    it('finds URLs that are not allowlisted', () =>
    {
        const found = findViolations('<img src="https://example.com/x.png"> see http://example.org.', src);
        expect(found.map((f) => f.match)).toEqual(['https://example.com/x.png', 'http://example.org']);
    });

    it('finds WebSocket URLs (ws:// and wss://)', () =>
    {
        const found = findViolations('connect("wss://example.invalid/x"); connect("WS://example.invalid/y");', src);
        expect(found.map((f) => f.match)).toEqual(['wss://example.invalid/x', 'WS://example.invalid/y']);
    });

    it('finds URLs with escaped slashes in dist-like text', () =>
    {
        const code = String.raw`var c={"u":"https:\/\/example.invalid\/a.json"},d='http:/\/example.invalid';`;
        expect(findViolations(code, dist).map((f) => f.match)).toEqual([
            'https://example.invalid/a.json',
            'http://example.invalid',
        ]);
    });

    it('flags test code only in dist/', () =>
    {
        const code = 'import "vitest"; describe("x", () => {});';
        expect(findViolations(code, src)).toEqual([]);
        expect(findViolations(code, dist).map((f) => f.match)).toEqual(['vitest', 'describe(']);
    });
});

describe('HTML injection APIs (README.md, rule R4)', () =>
{
    it('flags every HTML injection API in dist/, in minified shapes', () =>
    {
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

    it('does not flag them in Source/ (comments there say "never innerHTML"; ESLint covers the source)', () =>
    {
        expect(findViolations('// never use innerHTML here\ne.textContent = t;', src)).toEqual([]);
    });

    it('does not flag safe look-alikes', () =>
    {
        const code = 'e.textContent=t;e.innerText=t;writer.write(t);e.myinnerHTMLx=1;e.srcdocument=1;';
        expect(findViolations(code, dist)).toEqual([]);
    });
});

describe('global URL allowlist (the Ko-fi donation link)', () =>
{
    const kofi = 'https://ko-fi.com/0x496d7065';

    it('holds exactly the donation URL and nothing else', () =>
    {
        expect(URL_ALLOWLIST).toEqual([kofi]);
    });

    it('accepts exactly the donation URL in Source/ and in every dist/ file, also with escaped slashes', () =>
    {
        const code = `l.setAttribute("href","${kofi}");`;
        expect(findViolations(code, src)).toEqual([]);
        expect(findViolations(code, { isDist: false, sourceFile: 'Source/page/dom.ts' })).toEqual([]);
        for (const distFile of ['assets/index-abc123.js', 'index.html'])
        {
            expect(findViolations(code, { isDist: true, distFile })).toEqual([]);
        }
        expect(findViolations(String.raw`var u="https:\/\/ko-fi.com\/0x496d7065";`, dist)).toEqual([]);
    });

    it('rejects every other Ko-fi address: another page, a longer path, a query, a fragment, http:, another host, other letter case', () =>
    {
        const others = [
            'https://ko-fi.com/someone-else',
            `${kofi}/shop`,
            `${kofi}?ref=x`,
            `${kofi}#x`,
            'http://ko-fi.com/0x496d7065',
            'https://storage.ko-fi.com/cdn/x.png',
            'https://ko-fi.com/0X496D7065',
        ];
        for (const url of others)
        {
            expect(findViolations(`"${url}"`, src).map((f) => f.match), url).toEqual([url]);
            expect(findViolations(`"${url}"`, dist).map((f) => f.match), url).toEqual([url]);
        }
    });
});

describe('file-scoped URL allowlist (third-party notices)', () =>
{
    const apache = 'Apache License\n   http://www.apache.org/licenses/\n   http://www.apache.org/licenses/LICENSE-2.0\n';
    const notices = { isDist: true, distFile: 'THIRD_PARTY_NOTICES.txt' };

    it('keeps the global allowlist to the Ko-fi donation link only (see below)', () =>
    {
        expect(URL_ALLOWLIST).toHaveLength(1);
    });

    it('accepts the Apache license URLs inside dist/THIRD_PARTY_NOTICES.txt', () =>
    {
        expect(findViolations(apache, notices)).toEqual([]);
    });

    it('still rejects other URLs inside the notices file', () =>
    {
        const found = findViolations('see https://example.invalid/x', notices);
        expect(found.map((f) => f.match)).toEqual(['https://example.invalid/x']);
    });

    it('rejects the Apache license URLs in any other dist/ file', () =>
    {
        for (const distFile of ['assets/index-abc123.js', 'index.html', 'sub/THIRD_PARTY_NOTICES.txt'])
        {
            expect(findViolations(apache, { isDist: true, distFile })).toHaveLength(2);
        }
        expect(findViolations(apache, dist)).toHaveLength(2);
    });

    it('rejects the Apache license URLs in Source/, even with a notices file name', () =>
    {
        expect(findViolations(apache, src)).toHaveLength(2);
        expect(findViolations(apache, { isDist: false, distFile: 'THIRD_PARTY_NOTICES.txt' })).toHaveLength(2);
    });

    it('does not allow a longer URL that merely starts with an allowed one', () =>
    {
        expect(findViolations('http://www.apache.org/licenses/x.js', notices)).toHaveLength(1);
    });

    it('rejects an uppercase Apache URL inside the notices file (no case folding)', () =>
    {
        const found = findViolations('HTTP://WWW.APACHE.ORG/licenses/', notices);
        expect(found.map((f) => f.match)).toEqual(['HTTP://WWW.APACHE.ORG/licenses/']);
    });

    it('rejects the Apache URLs in a notices file name with different case', () =>
    {
        expect(findViolations(apache, { isDist: true, distFile: 'third_party_notices.txt' })).toHaveLength(2);
    });

    it('rejects the Apache URLs in a backslash path ending in the notices file name', () =>
    {
        expect(findViolations(apache, { isDist: true, distFile: 'sub\\THIRD_PARTY_NOTICES.txt' })).toHaveLength(2);
    });
});

describe('file-scoped URL allowlist (font license)', () =>
{
    const ofl = 'This license is copied below, and is also available with a FAQ at:\nhttp://scripts.sil.org/OFL\n';
    const notices = { isDist: true, distFile: 'THIRD_PARTY_NOTICES.txt' };
    const licenseFile = { isDist: false, sourceFile: 'Source/pdf-export/fonts/LICENSE.txt' };

    it('lists exactly the one SIL link, for the notices file and the license file only', () =>
    {
        expect(FILE_URL_ALLOWLIST.filter((entry) => entry.url.includes('sil.org'))).toEqual([
            { url: 'http://scripts.sil.org/OFL', onlyIn: 'THIRD_PARTY_NOTICES.txt' },
        ]);
        expect(SOURCE_FILE_URL_ALLOWLIST).toEqual([{ url: 'http://scripts.sil.org/OFL', onlyIn: 'Source/pdf-export/fonts/LICENSE.txt' }]);
    });

    it('accepts the SIL link inside dist/THIRD_PARTY_NOTICES.txt and Source/pdf-export/fonts/LICENSE.txt', () =>
    {
        expect(findViolations(ofl, notices)).toEqual([]);
        expect(findViolations(ofl, licenseFile)).toEqual([]);
    });

    it('rejects the SIL link in any other dist/ or source file', () =>
    {
        for (const distFile of ['assets/index-abc123.js', 'assets/pdf-fonts-abc.js', 'index.html', 'Source/pdf-export/fonts/LICENSE.txt'])
        {
            expect(findViolations(ofl, { isDist: true, distFile }), distFile).toHaveLength(1);
        }
        for (const sourceFile of ['Source/pdf-export/fonts.ts', 'Source/pdf-export/fonts/license.txt', 'Source/LICENSE.txt', 'Source/index.html', 'THIRD_PARTY_NOTICES.txt'])
        {
            expect(findViolations(ofl, { isDist: false, sourceFile }), sourceFile).toHaveLength(1);
        }
        expect(findViolations(ofl, src)).toHaveLength(1);
        expect(findViolations(ofl, dist)).toHaveLength(1);
    });

    it('does not let a source-file entry count for dist/, or a dist/ entry for the source', () =>
    {
        expect(findViolations(ofl, { isDist: true, distFile: 'x.js', sourceFile: 'Source/pdf-export/fonts/LICENSE.txt' })).toHaveLength(1);
        expect(findViolations(ofl, { isDist: false, distFile: 'THIRD_PARTY_NOTICES.txt', sourceFile: 'Source/x.ts' })).toHaveLength(1);
    });

    it('rejects variants of the SIL link even in the license file', () =>
    {
        for (const url of ['https://scripts.sil.org/OFL', 'http://scripts.sil.org/OFL/x.js', 'http://scripts.sil.org/', 'https://openfontlicense.org'])
        {
            expect(findViolations(url, licenseFile), url).toHaveLength(1);
            expect(findViolations(url, notices), url).toHaveLength(1);
        }
    });

    it('keeps the Apache links out of the font license file', () =>
    {
        expect(findViolations('http://www.apache.org/licenses/', licenseFile)).toHaveLength(1);
    });
});

describe('normalizeUrl', () =>
{
    it('unescapes slashes so an escaped URL compares equal to its allowlist form', () =>
    {
        expect(normalizeUrl(String.raw`https:\/\/example.invalid\/repo`)).toBe('https://example.invalid/repo');
        expect(normalizeUrl('wss:\\/\\/example.invalid\\/x\\')).toBe('wss://example.invalid/x');
        expect(normalizeUrl('https://example.invalid/repo.')).toBe('https://example.invalid/repo');
    });
});

describe('decodeJsEscapes', () =>
{
    it('undoes every kind of string escape, in one pass', () =>
    {
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

describe('findEmbeddedViolations (code inlined as a string, e.g. a worker)', () =>
{
    // The shape Vite gives an inlined worker: its whole code in ONE string
    // literal, where each line break is written \n.
    const inlined = (workerCode: string): string => `const jsContent=${JSON.stringify(workerCode)};new Blob([jsContent]);`;

    it('finds network APIs that the raw scan misses right after an escaped line break', () =>
    {
        const bundle = inlined('let a=1;\nXMLHttpRequest;\nfetch("x");\nindexedDB.open("x");');
        // The raw text has "\nXMLHttpRequest": the "n" hides the word boundary.
        expect(findViolations(bundle, dist)).toEqual([]);
        expect(findEmbeddedViolations(bundle, dist).map((f) => f.match)).toEqual(['XMLHttpRequest', 'fetch(', 'indexedDB']);
        expect(findEmbeddedViolations(bundle, dist)[0]?.reason).toMatch(/inside a string/);
    });

    it('finds HTML injection APIs and URLs written with escapes', () =>
    {
        const bundle = inlined('x;\ninnerHTML=1;') + String.raw`const u="\x68ttps://example.invalid/a";`;
        expect(findEmbeddedViolations(bundle, dist).map((f) => f.match)).toEqual(['innerHTML', 'https://example.invalid/a']);
    });

    it('does not repeat findings the raw scan already reports, and accepts clean code', () =>
    {
        expect(findEmbeddedViolations('fetch("x");', dist)).toEqual([]);
        expect(findEmbeddedViolations(`fetch("x");${inlined('a;\nfetch("y");')}`, dist).map((f) => f.match)).toEqual(['fetch(']);
        expect(findEmbeddedViolations(inlined('const a = 1;\nself.onmessage = (e) => self.postMessage(e.data);'), dist)).toEqual([]);
    });
});

describe('checkBuiltHtml', () =>
{
    const meta = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; connect-src 'none'" />`;

    it('accepts a CSP meta placed before scripts and links', () =>
    {
        expect(checkBuiltHtml(`<head>${meta}<script src="/a.js"></script><link href="/a.css"></head>`)).toEqual([]);
    });

    it('rejects a CSP meta placed after a script', () =>
    {
        expect(checkBuiltHtml(`<head><script src="/a.js"></script>${meta}</head>`)).toHaveLength(1);
    });

    it('rejects a missing CSP meta or missing directives', () =>
    {
        expect(checkBuiltHtml('<head></head>')).toHaveLength(1);
        expect(checkBuiltHtml(`<meta http-equiv="Content-Security-Policy" content="script-src 'self'" />`)).toHaveLength(2);
    });
});

describe('checkHeadersFile', () =>
{
    const PAGE = "  Content-Security-Policy: default-src 'none'; connect-src 'none'; frame-ancestors 'none'";
    const SW = "  Content-Security-Policy: default-src 'none'; connect-src 'self'; frame-ancestors 'none'";
    const complete = (swRule: string[] = ['/sw.js', '  ! Content-Security-Policy', SW]): string =>
        ['# comment', '/*', PAGE, '  Referrer-Policy: no-referrer', '  Permissions-Policy: camera=()', ...swRule].join('\n');

    it('accepts complete headers', () =>
    {
        expect(checkHeadersFile(complete())).toEqual([]);
    });

    it('reports every missing header', () =>
    {
        // The three page headers, and the /sw.js rule.
        expect(checkHeadersFile('/*\n')).toHaveLength(4);
    });

    it('needs the /sw.js rule', () =>
    {
        expect(checkHeadersFile(complete([]))).toEqual([expect.stringMatching(/exactly one rule for \/sw\.js/)]);
    });

    it('the /sw.js rule must detach the page CSP before setting its own', () =>
    {
        for (const rule of [
            ['/sw.js', SW],
            ['/sw.js', SW, '  ! Content-Security-Policy'],
            ['/sw.js', '  ! Content-Security-Policy'],
            ['/sw.js', '  ! Content-Security-Policy', SW, SW],
        ])
        {
            expect(checkHeadersFile(complete(rule)), rule.join('|')).toEqual([expect.stringMatching(/must remove the page CSP/)]);
        }
    });

    it("the /sw.js CSP must be the page's with only connect-src 'self'", () =>
    {
        for (const csp of [
            PAGE, // unchanged: the worker could not store the files
            "  Content-Security-Policy: default-src 'none'; connect-src *; frame-ancestors 'none'",
            "  Content-Security-Policy: default-src 'self'; connect-src 'self'; frame-ancestors 'none'",
            "  Content-Security-Policy: default-src 'none'; connect-src 'self' https://cdn.invalid/ ; frame-ancestors 'none'",
            "  Content-Security-Policy: default-src 'none'; connect-src 'self'",
        ])
        {
            expect(checkHeadersFile(complete(['/sw.js', '  ! Content-Security-Policy', csp])), csp).toEqual([expect.stringMatching(/only connect-src 'self'/)]);
        }
    });

    it('the /sw.js rule changes nothing but the CSP', () =>
    {
        expect(checkHeadersFile(complete(['/sw.js', '  ! Content-Security-Policy', SW, '  ! Referrer-Policy']))).toEqual([
            expect.stringMatching(/may only replace the Content-Security-Policy/),
        ]);
    });

    it('no other rule may set or remove a CSP', () =>
    {
        for (const lines of [['/assets/*', '  ! Content-Security-Policy'], ['/x.js', SW]])
        {
            expect(checkHeadersFile(`${complete()}\n${lines.join('\n')}`)).toEqual([expect.stringMatching(/only \/sw\.js may/)]);
        }
    });

    it('a second CSP in the /* rule counts as missing (two policies, comma-joined)', () =>
    {
        const text = complete().replace(PAGE, `${PAGE}\n${PAGE}`);
        expect(checkHeadersFile(text)).toContain('missing Content-Security-Policy: header (README.md, rule R2)');
    });
});

describe('rule exceptions (the service worker only)', () =>
{
    const swCode = 'caches.open(c).then((x) => x.match(p) ?? fetch(r));';

    it('are exactly fetch( and caches. in sw.js and its source', () =>
    {
        expect(RULE_EXEMPTIONS).toEqual([
            { rule: 'fetch', distFile: 'sw.js', sourceFile: 'Source/offline-copy/service-worker.ts' },
            { rule: 'caches', distFile: 'sw.js', sourceFile: 'Source/offline-copy/service-worker.ts' },
        ]);
        expect(RULES.filter((rule) => rule.id !== undefined).map((rule) => rule.id)).toEqual(['fetch', 'caches']);
    });

    it('allow those two calls in dist/sw.js and Source/offline-copy/service-worker.ts', () =>
    {
        expect(findViolations(swCode, { isDist: true, distFile: 'sw.js' })).toEqual([]);
        expect(findViolations(swCode, { isDist: false, sourceFile: 'Source/offline-copy/service-worker.ts' })).toEqual([]);
        expect(findEmbeddedViolations(JSON.stringify(swCode), { isDist: true, distFile: 'sw.js' })).toEqual([]);
    });

    it('still report them in every other file, Source/ and dist/ alike', () =>
    {
        for (const options of [
            { isDist: true, distFile: 'assets/index-abc.js' },
            { isDist: true, distFile: 'assets/sw.js' },
            { isDist: true, distFile: 'index.html' },
            { isDist: true },
            { isDist: false, sourceFile: 'Source/offline-copy/sw-logic.ts' },
            { isDist: false, sourceFile: 'Source/main.ts' },
            { isDist: false },
            // The two scopes never mix: the dist name for a source file, and the reverse.
            { isDist: false, sourceFile: 'sw.js' },
            { isDist: true, distFile: 'Source/offline-copy/service-worker.ts' },
        ])
        {
            expect(findViolations(swCode, options).map((f) => f.match), JSON.stringify(options)).toEqual(['fetch(', 'caches.']);
        }
    });

    it('do not switch off any other rule in sw.js', () =>
    {
        const code = 'new XMLHttpRequest(); new WebSocket(u); importScripts(u); localStorage.x; indexedDB.open(n); navigator.sendBeacon(u); x.innerHTML = y; fetch("https://cdn.invalid/x");';
        expect(findViolations(code, { isDist: true, distFile: 'sw.js' }).map((f) => f.match)).toEqual([
            'XMLHttpRequest',
            'WebSocket',
            'sendBeacon',
            'importScripts',
            'localStorage',
            'indexedDB',
            'innerHTML',
            'https://cdn.invalid/x',
        ]);
    });

    it('isRuleExempt needs a rule id and the matching file', () =>
    {
        expect(isRuleExempt({}, true, 'sw.js', undefined)).toBe(false);
        expect(isRuleExempt({ id: 'fetch' }, true, 'sw.js', undefined)).toBe(true);
        expect(isRuleExempt({ id: 'fetch' }, true, undefined, 'Source/offline-copy/service-worker.ts')).toBe(false);
        expect(isRuleExempt({ id: 'fetch' }, false, 'sw.js', undefined)).toBe(false);
        expect(isRuleExempt({ id: 'caches' }, false, undefined, 'Source/offline-copy/service-worker.ts')).toBe(true);
        expect(isRuleExempt({ id: 'other' }, true, 'sw.js', undefined)).toBe(false);
    });
});

describe('findOpaquePayloads (guards the worker inlining format)', () =>
{
    // Synthetic base64-looking text of a given length (no real payload).
    const run = (length: number): string => 'QUJD+/09'.repeat(Math.ceil(length / 8)).slice(0, length);

    it('uses a 10k-character threshold', () =>
    {
        expect(OPAQUE_PAYLOAD_MIN_LENGTH).toBe(10000);
    });

    it('reports a worker inlined as base64 (atob of a long literal)', () =>
    {
        const bundle = `const a=1;
const w=atob("${run(12000)}==");new Worker(URL.createObjectURL(new Blob([w])));`;
        const findings = findOpaquePayloads(bundle);
        expect(findings).toHaveLength(1);
        expect(findings[0]?.line).toBe(2);
        expect(findings[0]?.match).toHaveLength(12002); // padding included
        expect(findings[0]?.reason).toMatch(/base64/);
    });

    it('reports a long run even without atob (any decoder could be used)', () =>
    {
        expect(findOpaquePayloads(`x="${run(OPAQUE_PAYLOAD_MIN_LENGTH)}"`)).toHaveLength(1);
    });

    it('ignores runs just under the threshold and ordinary minified code', () =>
    {
        expect(findOpaquePayloads(`x="${run(OPAQUE_PAYLOAD_MIN_LENGTH - 1)}"`)).toEqual([]);
        const minified = 'function a(b,c){return b+c}var d=a(1,2);'.repeat(5000);
        expect(findOpaquePayloads(minified)).toEqual([]);
        // Today's format: the worker as a plain (escaped) string literal.
        expect(findOpaquePayloads('const s="self.onmessage=(e)=>{postMessage(e.data)};";'.repeat(2000))).toEqual([]);
    });

    it('reports each long run separately, with its line', () =>
    {
        const findings = findOpaquePayloads(`${run(10000)}
;
${run(11000)}`);
        expect(findings.map((f) => [f.line, f.match.length])).toEqual([
            [1, 10000],
            [3, 11000],
        ]);
    });

    it('accepts a custom threshold', () =>
    {
        expect(findOpaquePayloads('abc;abcdef', 6).map((f) => f.match)).toEqual(['abcdef']);
    });
});
