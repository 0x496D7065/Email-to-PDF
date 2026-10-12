// Browser replacement for the `iconv-lite` package (wired up with
// `resolve.alias` in vite.config.ts).
//
// Why: @kenjiuno/msgreader (the .msg parser) depends on iconv-lite, which
// needs Node's `Buffer` (through `safer-buffer`). That crashes in the browser
// and would also ship extra code and URLs. msgreader only uses two functions
// of it (in lib/DataStream.js), so this file provides just those two, using
// the browser's built-in TextDecoder. No Buffer polyfill is needed.

/**
 * Called by msgreader's DataStream.readString() to decode non-Unicode
 * ("ANSI", PT_STRING8) text, only when the caller passes an `ansiEncoding`.
 * `encoding` must be a label the browser's TextDecoder knows, for example
 * 'windows-1252' or 'shift_jis'; anything else throws a RangeError.
 */
export function decode(bytes: Uint8Array, encoding: string): string {
  return new TextDecoder(encoding).decode(bytes);
}

/**
 * Called only by msgreader's DataStream.writeString(), which this app never
 * uses (we only READ .msg files). Fails loudly instead of writing wrong bytes.
 */
export function encode(_text: string, encoding: string): never {
  throw new Error(`iconv-lite shim: encode("${encoding}") is not supported (read-only use of msgreader).`);
}
