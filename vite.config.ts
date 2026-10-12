import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // Vite normally injects a small "modulepreload" polyfill that calls fetch().
    // Every browser we target supports modulepreload natively, and the brief
    // forbids network APIs in the shipped code, so we turn the polyfill off.
    modulePreload: { polyfill: false },
  },
});
