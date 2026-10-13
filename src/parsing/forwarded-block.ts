// The format of the block the .eml adapter writes for each inline forwarded
// message it expands into a body (see expandForwarded in eml.ts). It lives in
// its own tiny module so the reply-header detector (src/engine/reply-header.ts)
// can recognize the tool's own block, and never fold it as if it were a
// mail client's header, without importing the whole adapter.

/** The line that starts each expanded forwarded message in bodyText. */
export const FORWARDED_SEPARATOR = '---------- Forwarded message ----------';

/**
 * The header labels that may follow FORWARDED_SEPARATOR, in the order the
 * adapter writes them. Each one appears at most once, as "Label: value", and
 * missing headers are skipped (see forwardedHeaderLines in eml.ts).
 */
export const FORWARDED_HEADER_LABELS: readonly string[] = ['From', 'Sender', 'Date', 'Subject', 'To', 'Cc', 'Bcc'];
