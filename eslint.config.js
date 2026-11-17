// ESLint "flat config". Run with: npm run lint
//
// The extra rules below are an EARLY WARNING for the hard rules in
// README.md, rules R1, R4 and R5 (no network, no innerHTML, no storage).
// They catch mistakes while coding; the real guarantee is the build check
// on the bundled output (scripts/check-no-network.mjs) plus the Content Security Policy.
import js from '@eslint/js';
import stylistic from '@stylistic/eslint-plugin';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

// APIs that can send data over the network or store data in the browser.
const network = 'Network APIs are forbidden in the tool page (README.md, rule R1).';
const storage = 'Message data must stay in memory only (README.md, rule R5).';
const html = 'Email content is untrusted: use textContent, never HTML injection (README.md, rule R4).';

// Properties and methods that turn a string into HTML (README.md, rule R4).
// The build check (scripts/no-network-rules.mjs) looks for the same names in
// the bundled output.
const htmlSinks = [
    'innerHTML',
    'outerHTML',
    'insertAdjacentHTML',
    'createContextualFragment',
    'srcdoc',
    'setHTMLUnsafe',
    'parseHTMLUnsafe',
];
// The same list as a regex for the AST selectors below, e.g. /^(innerHTML|...)$/
const htmlSinkPattern = `/^(${htmlSinks.join('|')})$/`;

// AST selectors for 'no-restricted-syntax' (README.md, rule R4). A named
// list because flat config REPLACES a rule's options in each block that sets
// it: the src/ block below repeats these and adds its own.
const restrictedSyntax = [
    // The same names written as el['innerHTML'] (computed access) or as an
    // object key, e.g. Object.assign(el, { innerHTML: x }).
    {
        selector: `MemberExpression[computed=true][property.value=${htmlSinkPattern}]`,
        message: html,
    },
    { selector: `Property[key.name=${htmlSinkPattern}]`, message: html },
    { selector: `Property[key.value=${htmlSinkPattern}]`, message: html },
    // el.setAttribute('onclick', ...) / ('srcdoc', ...) when the name is
    // written as a literal or a template literal (`on${x}`: its first
    // text part is checked). Names built at run time are caught by
    // src/ui/dom.ts (el / setSafeAttribute), which refuses them.
    ...[
        ['setAttribute', 0],
        ['setAttributeNS', 1],
    ].flatMap(([method, index]) =>
        [`arguments.${index}.value`, `arguments.${index}.quasis.0.value.cooked`].map((path) => ({
            selector: `CallExpression[callee.property.name='${method}'][${path}=/^(on|srcdoc$)/i]`,
            message: `${html} Event handler and srcdoc attributes are forbidden; use addEventListener.`,
        })),
    ),
];

// The app runs in the browser only: node: modules are for tests and scripts.
const nodeOnly = 'The app runs in the browser only; node: modules are for tests and scripts.';
// import('node:fs') written as a string or a template literal. Static
// imports are caught by 'no-restricted-imports' in the src/ block below.
const dynamicNodeImports = [
    { selector: 'ImportExpression[source.value=/^node:/]', message: nodeOnly },
    { selector: 'ImportExpression[source.quasis.0.value.cooked=/^node:/]', message: nodeOnly },
];

const forbiddenGlobals = {
    fetch: network,
    XMLHttpRequest: network,
    WebSocket: network,
    EventSource: network,
    localStorage: storage,
    sessionStorage: storage,
    indexedDB: storage,
};

export default defineConfig(
    { ignores: ['dist/', 'node_modules/'] },

    js.configs.recommended,

    // Type-aware TypeScript rules. "projectService" reuses tsconfig.json, so
    // ESLint sees exactly the same types as `npm run typecheck`.
    tseslint.configs.recommendedTypeChecked,
    {
        languageOptions: {
            parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
        },
    },

    // This file (and any other plain .js config) is not part of tsconfig.json,
    // so type-aware rules are switched off for .js files instead of widening
    // the TypeScript project just to include tooling config.
    // Same for the plain-JS build scripts in scripts/*.mjs.
    { files: ['**/*.js', '**/*.mjs'], ...tseslint.configs.disableTypeChecked },

    // Layout (task 9.6): 4-space indent with `case` one level inside `switch`,
    // and Allman braces ({ and } on their own lines) for every code block.
    // Object, array and type literals are data, not blocks: brace-style leaves
    // them alone (an object literal must also stay on its `return` line).
    // Quotes: single, except double quotes or a template literal where they
    // avoid escaping a quote (as the code already did).
    // curly: every if/else/for/while/do body is a braced block, even a single
    // statement, so the Allman layout above applies to it too.
    {
        plugins: { '@stylistic': stylistic },
        rules: {
            curly: ['error', 'all'],
            '@stylistic/indent': ['error', 4, { SwitchCase: 1 }],
            '@stylistic/brace-style': ['error', 'allman', { allowSingleLine: false }],
            '@stylistic/semi': ['error', 'always'],
            '@stylistic/quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: 'always' }],
            '@stylistic/no-trailing-spaces': 'error',
            '@stylistic/eol-last': ['error', 'always'],
            '@stylistic/no-tabs': 'error',
        },
    },

    // scripts/*.mjs run in Node, not the browser. `process` is imported from
    // 'node:process'; `console` is declared here by hand so no extra globals
    // package is needed.
    { files: ['scripts/**/*.mjs'], languageOptions: { globals: { console: 'readonly' } } },

    // Privacy/security early-warning rules (README.md, rules R1, R4 and R5).
    {
        rules: {
            // Bare use: fetch(...), new WebSocket(...), localStorage.setItem(...)
            'no-restricted-globals': [
                'error',
                ...Object.entries(forbiddenGlobals).map(([name, message]) => ({ name, message })),
            ],
            'no-restricted-properties': [
                'error',
                // Same APIs reached through window./globalThis./self.
                ...['window', 'globalThis', 'self'].flatMap((object) =>
                    Object.entries(forbiddenGlobals).map(([property, message]) => ({ object, property, message })),
                ),
                { object: 'navigator', property: 'sendBeacon', message: network },
                { object: 'document', property: 'cookie', message: storage },
                // Every way to turn a string into markup, read or written: x.innerHTML,
                // x.outerHTML, x.insertAdjacentHTML(), range.createContextualFragment(),
                // frame.srcdoc, el.setHTMLUnsafe(), Document.parseHTMLUnsafe(),
                // document.write()/writeln(). write/writeln are banned on any object,
                // so an alias such as `const d = document; d.write(x)` is caught too.
                ...htmlSinks.map((property) => ({ property, message: html })),
                { property: 'write', message: html },
                { property: 'writeln', message: html },
            ],
            // See restrictedSyntax above.
            'no-restricted-syntax': ['error', ...restrictedSyntax],
            // Running strings as code (the CSP forbids it too, README.md, rule R2).
            'no-eval': 'error',
            'no-implied-eval': 'error',
            'no-new-func': 'error',
        },
    },
    // The app runs in the browser only. e2e/support/node-fs.d.ts declares
    // 'node:fs' for the browser tests, and tsconfig.json covers src/ and e2e/
    // together, so typecheck alone would not stop app code importing it.
    // 'no-restricted-imports' sees static imports only, so dynamic import()
    // is caught by 'no-restricted-syntax', which must repeat the shared
    // selectors (this block replaces that rule's options for src/).
    {
        files: ['src/**/*.ts'],
        rules: {
            'no-restricted-imports': ['error', { patterns: [{ group: ['node:*'], message: nodeOnly }] }],
            'no-restricted-syntax': ['error', ...restrictedSyntax, ...dynamicNodeImports],
        },
    },
    // The service worker (src/sw/service-worker.ts) is the one shipped file
    // allowed to call fetch(): a listed file of this site missing from its
    // copy is fetched from this site again, and nothing is stored (README.md,
    // "How the privacy model works"; the build check has the same single
    // exception, RULE_EXEMPTIONS in scripts/no-network-rules.mjs). Only bare
    // `fetch` is allowed there; every other entry of the list still applies.
    {
        files: ['src/sw/service-worker.ts'],
        rules: {
            'no-restricted-globals': [
                'error',
                ...Object.entries(forbiddenGlobals)
                    .filter(([name]) => name !== 'fetch')
                    .map(([name, message]) => ({ name, message })),
            ],
        },
    },
    // e2e/ browser tests deliberately try forbidden things (fetch, remote
    // images) inside the page to PROVE the CSP blocks them. That code runs
    // only in the test browser and is never shipped, so the early-warning
    // rules above are switched off for e2e/ only.
    {
        files: ['e2e/**'],
        rules: {
            'no-restricted-globals': 'off',
            'no-restricted-properties': 'off',
            'no-restricted-syntax': 'off',
        },
    },
);
