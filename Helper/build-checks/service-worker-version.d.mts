// Type declarations for service-worker-version.mjs, so TypeScript (vite.config.ts,
// Source/offline-copy/precache-list.ts and the tests) can import that plain-JS module
// under strict type checking. Keep in sync with it.

export const MANIFEST_PLACEHOLDER: string;

export const VERSION_LENGTH: number;

export function manifestVersion(files: readonly { path: string; bytes: Uint8Array }[], serviceWorkerCode: string,
    headersFile: string | Uint8Array): string;

export function readBuiltManifest(serviceWorkerJs: string): { version: string; paths: string[] };
