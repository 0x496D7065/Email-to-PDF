// defineConfig from 'vitest/config' is Vite's own defineConfig plus types for
// the `test` section below, so one file configures both the build and tests.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  build: {
    // Vite normally injects a small "modulepreload" polyfill that calls fetch().
    // Every browser we target supports modulepreload natively, and the brief
    // forbids network APIs in the shipped code, so we turn the polyfill off.
    modulePreload: { polyfill: false },
  },
  test: {
    // Unit tests sit next to the code they test, e.g. src/lib/foo.test.ts.
    // They run in Node (no browser DOM): detection and parsing logic is kept
    // as pure functions (PROJECT_BRIEF.md 8.3). The production build never
    // includes them because nothing in index.html/main.ts imports them.
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
