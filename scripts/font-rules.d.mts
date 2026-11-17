// Type declarations for font-rules.mjs, so TypeScript tests can import that
// plain-JS module under strict type checking. Keep in sync with it.

export interface FontFile
{
    /** Path relative to the project root, e.g. 'src/fonts/IBMPlexSans-Regular.woff'. */
    file: string;
    /** SHA-256 of the official, unmodified file, lowercase hex. */
    sha256: string;
}

export const PDF_FONT_FILES: readonly FontFile[];

export const FONT_CHUNK_PATTERN: RegExp;

export const NUMBER_ARRAY_MIN_LENGTH: number;

export const FONT_CHUNK_MAX_OTHER_TEXT: number;

export function sha256Hex(bytes: Uint8Array): string;

export interface NumberArray
{
    /** 1-based line of the first number. */
    line: number;
    /** Offsets of the run in the text. */
    start: number;
    end: number;
    values: number[];
}

export function findNumberArrays(text: string, minLength?: number): NumberArray[];

export interface TextFile
{
    /** Path relative to dist/, forward slashes. */
    path: string;
    text: string;
}

export function checkNumberArrays(files: readonly TextFile[], fonts?: readonly FontFile[], minLength?: number): string[];

export function checkFontChunkLoadedAtStartup(html: string, files: readonly TextFile[]): string[];

export function checkSourceFonts(files: readonly { path: string; bytes: Uint8Array }[], fonts?: readonly FontFile[]): string[];

export function isFontFile(path: string): boolean;

export function isBytesImportAllowed(file: string, fontsDir: string): boolean;
