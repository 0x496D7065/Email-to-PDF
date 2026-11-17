// Who to show as the author of a message in the preview and the PDF.
//
// Lives in Source/page-logic/ (not Source/thread-analysis/): these helpers decide how
// already-organized data is presented, they detect nothing. Pure functions,
// no DOM (README.md, rule R7), so they are unit tested in Node.

import type { EmailAddress, NormalizedMessage } from '../../Header/parsed-email';
import type { AuthorSource } from '../../Header/preview-display';

export interface DisplayAuthor
{
    readonly source: AuthorSource;
    /** The mailboxes to show: non-empty for 'from' and 'sender', [] for 'none'. */
    readonly mailboxes: readonly EmailAddress[];
}

/** True if a mailbox has neither a name nor an address worth showing. */
function isBlank(mailbox: EmailAddress): boolean
{
    return mailbox.name.trim() === '' && mailbox.address.trim() === '';
}

/**
 * The author to show: the From mailboxes if there is at least one with a
 * name or an address, else the `sender` mailbox if it has one, else none.
 * Blank From entries (no name, no address) carry nothing to show and are
 * skipped. The message itself is never changed.
 */
export function displayAuthor(message: Pick<NormalizedMessage, 'from' | 'sender'>): DisplayAuthor
{
    const from = message.from.filter((m) => !isBlank(m));
    if (from.length > 0)
    {
        return { source: 'from', mailboxes: from };
    }
    if (message.sender !== undefined && !isBlank(message.sender))
    {
        return { source: 'sender', mailboxes: [message.sender] };
    }
    return { source: 'none', mailboxes: [] };
}
