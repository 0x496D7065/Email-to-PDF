// How a list of header-like data is written on one line, in the preview and
// in the PDF: the mailboxes of a field (From, To, Cc, Bcc...) and the names
// of the source files an email was also found in ("Also in").
//
// Always with a plain ", ", in every language: such a list is a set of
// values, not a sentence, so no "and"/"et" is put before the last one
// (it would look like part of the data). Prose lists, such as email
// numbers ("#1 et #3"), keep the language's own list rules (Intl.ListFormat).
// Pure functions, no DOM (README.md, rule R7).

/** The separator between the values of one header-like list. */
export const MAILBOX_SEPARATOR = ', ';

/** "a, b, c": the texts as given, '' for none. */
export function joinPlain(items: readonly string[]): string
{
    return items.join(MAILBOX_SEPARATOR);
}

/** "Alice <a@x.test>, Bob <b@x.test>, Carol <c@x.test>": the texts as given, '' for none. */
export function joinMailboxes(items: readonly string[]): string
{
    return joinPlain(items);
}
