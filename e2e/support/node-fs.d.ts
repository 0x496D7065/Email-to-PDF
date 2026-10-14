// Type of the one Node function the browser tests use to read a synthetic
// fixture from disk (e2e/preview.spec.ts). The project has no Node type
// package, and the tests run in Node through Playwright, so this states just
// that function. Test-only: the app never imports node:fs.
declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
}
