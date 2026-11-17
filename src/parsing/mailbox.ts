// Small pure helpers on mailboxes, shared by the .eml and .msg adapters.

import type { EmailAddress } from './types';

/**
 * The actual sender to keep next to the From mailboxes, or undefined if it
 * adds nothing ("sent on behalf of", see NormalizedMessage.sender).
 *
 * undefined if `sender` is missing, has neither a name nor an address, or is
 * the same mailbox as one of `from`:
 * - with an address: some From mailbox has the same address, compared without
 *   regard to letter case (the display names are not compared);
 * - without an address (only possible in a malformed file): some From
 *   mailbox has the same display name.
 * An empty `from` never matches, so a sender with no From is kept: it is
 * then the only author information in the file.
 */
export function senderIfDifferent(sender: EmailAddress | undefined, from: readonly EmailAddress[]): EmailAddress | undefined
{
    if (sender === undefined || (sender.name === '' && sender.address === '')) return undefined;
    if (sender.address !== '')
    {
        const address = sender.address.toLowerCase();
        return from.some((f) => f.address.toLowerCase() === address) ? undefined : sender;
    }
    return from.some((f) => f.name === sender.name) ? undefined : sender;
}
