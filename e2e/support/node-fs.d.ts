// Type of the one Node function the browser tests use to read a synthetic
// fixture from disk (e2e/preview.spec.ts), or a downloaded PDF as bytes
// (e2e/download.spec.ts; Node returns a Buffer, which is a Uint8Array). The
// project has no Node type package, and the tests run in Node through
// Playwright, so this states just that function. Test-only: tsconfig.json
// also covers src/, so this declaration would let app code type-check an
// import of node:fs; the no-restricted-imports and no-restricted-syntax
// rules for src/ in eslint.config.js refuse any node: import there, static
// or import().
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function readFileSync(path: string): Uint8Array;
}
