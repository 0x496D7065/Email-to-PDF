// Line endings of body text, shared by the .eml and .msg adapters.
//
// Every bodyText leaves the adapters with LF ("\n") line ends only, so every
// later step (the engine's detectors, the preview, the PDF) sees the same
// lines, whatever the source format wrote: CRLF (Outlook, raw MIME) or a lone
// CR (old Mac files; postal-mime turns CRLF into LF but leaves a lone CR).

/**
 * Turns every CRLF and every lone CR into LF. This only normalises how the
 * source file marks line ends: no character other than CR is changed, added
 * or removed, so the message text itself is never rewritten (README.md, rule
 * R6). The SHA-256 of a message is taken from the file bytes, not from this
 * text, so it does not change.
 */
export function toLfLineEndings(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}
