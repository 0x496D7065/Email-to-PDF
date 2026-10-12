// ESLint "flat config". Run with: npm run lint
//
// The extra rules below are an EARLY WARNING for the hard rules in
// PROJECT_BRIEF.md section 6 (no network, no storage, no innerHTML).
// They catch mistakes while coding; the real guarantee is the build check
// on the bundled output (Task 1.5) plus the Content Security Policy.
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

// APIs that can send data over the network or store data in the browser.
const network = 'Network APIs are forbidden in the tool page (PROJECT_BRIEF.md 6.1).';
const storage = 'Message data must stay in memory only (PROJECT_BRIEF.md 6.5).';
const html = 'Email content is untrusted: use textContent, never HTML injection (PROJECT_BRIEF.md 6.4).';

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
  { files: ['**/*.js'], ...tseslint.configs.disableTypeChecked },

  // Privacy/security early-warning rules (PROJECT_BRIEF.md section 6).
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
        { property: 'insertAdjacentHTML', message: html },
      ],
      'no-restricted-syntax': [
        'error',
        // el.innerHTML = ..., el.outerHTML += ..., el['innerHTML'] = ...
        {
          selector:
            'AssignmentExpression > MemberExpression.left:matches([property.name=/^(inner|outer)HTML$/], [property.value=/^(inner|outer)HTML$/])',
          message: html,
        },
      ],
    },
  },
);
