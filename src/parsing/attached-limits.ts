// Limits for reading the emails attached inside a dropped file (.eml:
// message/rfc822 parts, see eml.ts; .msg: attached Outlook items, see
// msg.ts), shared by both adapters so the two formats are read with the same
// bounds (README.md, rule R4: guard against malformed or hostile files).
// Each adapter's own comments say how it applies them.

/**
 * How many levels of attached emails are read: the dropped file's own email
 * is level 0, an email attached to it level 1, and so on. Emails deeper than
 * this stay listed as attachments of the email holding them and get no
 * AttachedMessage (their text stays in the original file).
 */
export const MAX_FORWARD_DEPTH = 5;

/**
 * How many attached emails are read per dropped file, all levels together.
 * Each one costs a full read of its data, so this bounds the work and memory
 * a hostile file can cause. An attempt counts even if the email then turns
 * out to be unreadable. The rest stay listed as attachments and get no
 * AttachedMessage.
 */
export const MAX_EXPANDED_FORWARDS = 200;
