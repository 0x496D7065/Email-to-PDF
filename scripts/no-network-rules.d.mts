// Type declarations for no-network-rules.mjs, so the TypeScript test file can
// import that plain-JS module under strict type checking. Keep in sync with it.

export interface Finding
{
    /** 1-based line number. */
    line: number;
    /** The exact text that matched. */
    match: string;
    /** Which rule was broken, with the README.md rule reference. */
    reason: string;
}

export const URL_ALLOWLIST: readonly string[];

/** URLs allowed only inside one dist/ file (`onlyIn`, relative to dist/). */
export const FILE_URL_ALLOWLIST: readonly { url: string; onlyIn: string }[];

/** URLs allowed only inside one source file (`onlyIn`, relative to the project root). */
export const SOURCE_FILE_URL_ALLOWLIST: readonly { url: string; onlyIn: string }[];

export function isUrlAllowed(url: string, distFile: string | undefined, sourceFile?: string): boolean;

export const RULES: readonly { id?: string; pattern: RegExp; reason: string; distOnly?: boolean }[];

/** The only rule exceptions: one rule, one built file and its source (the service worker). */
export const RULE_EXEMPTIONS: readonly { rule: string; distFile: string; sourceFile: string }[];

export function isRuleExempt(rule: { id?: string }, isDist: boolean, distFile: string | undefined, sourceFile: string | undefined): boolean;

/** Unescapes \/ and trims trailing punctuation, before the allowlist comparison. */
export function normalizeUrl(raw: string): string;

export interface ScanOptions
{
    isDist: boolean;
    /** dist/ files only: path relative to dist/. */
    distFile?: string;
    /** Source files only: path relative to the project root. */
    sourceFile?: string;
}

export function findViolations(text: string, options: ScanOptions): Finding[];

export function checkBuiltHtml(html: string): string[];

export function checkHeadersFile(text: string): string[];

/** Undoes JavaScript string escapes (\n, \", \uXXXX, ...) everywhere in `text`. */
export function decodeJsEscapes(text: string): string;

/** Shortest base64-looking run reported by findOpaquePayloads (10000). */
export const OPAQUE_PAYLOAD_MIN_LENGTH: number;

/** Long base64-looking literals (opaque payloads the other rules cannot see into). */
export function findOpaquePayloads(text: string, minLength?: number): Finding[];

/** Findings visible only after decodeJsEscapes (code embedded in strings, e.g. inlined workers). */
export function findEmbeddedViolations(text: string, options: ScanOptions): Finding[];
