// Type of the one Node function the browser tests use to read a synthetic
// fixture from disk (Helper/Test/browser-tests/preview.spec.ts), or a downloaded PDF as bytes
// (Helper/Test/browser-tests/download.spec.ts; Node returns a Buffer, which is a Uint8Array). The
// project has no Node type package, and the tests run in Node through
// Playwright, so this states just that function. Test-only: tsconfig.json
// also covers Source/, so this declaration would let app code type-check an
// import of node:fs; the no-restricted-imports and no-restricted-syntax
// rules for Source/ in eslint.config.js refuse any node: import there, static
// or import().
// readdirSync lists the built files of dist/ (Helper/Test/browser-tests/offline-reload.spec.ts:
// the service worker's precache list must be exactly those).
// writeFileSync rewrites the generated phone forward fixtures, only when asked,
// into the folder that existsSync checks first; both take a file URL built from
// import.meta.url (Helper/Test/test-support/phone-forward-fixtures.test.ts).
declare module 'node:fs'
{
    export function readFileSync(path: string, encoding: 'utf8'): string;
    export function readFileSync(path: string): Uint8Array;
    export function existsSync(path: URL): boolean;
    export function writeFileSync(path: URL, data: string): void;
    export function readdirSync(path: string, options: { recursive: true; withFileTypes: true }): { name: string; parentPath: string; isFile(): boolean }[];
}
