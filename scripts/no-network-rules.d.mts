// Type declarations for no-network-rules.mjs, so the TypeScript test file can
// import that plain-JS module under strict type checking. Keep in sync with it.

export interface Finding {
  /** 1-based line number. */
  line: number;
  /** The exact text that matched. */
  match: string;
  /** Which rule was broken, with the README.md rule reference. */
  reason: string;
}

export const URL_ALLOWLIST: readonly string[];

export const RULES: readonly { pattern: RegExp; reason: string; distOnly?: boolean }[];

/** Unescapes \/ and trims trailing punctuation, before the allowlist comparison. */
export function normalizeUrl(raw: string): string;

export function findViolations(text: string, options: { isDist: boolean }): Finding[];

export function checkBuiltHtml(html: string): string[];

export function checkHeadersFile(text: string): string[];
