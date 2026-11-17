// Expected normalized values for every SYNTHETIC fixture (README.md, rule R7).
//
// One entry per .eml file in Helper/Test/test-data/eml/ and per .msg builder spec in
// Helper/Test/test-data/msg/specs.ts; synthetic-guard.test.ts fails if they drift
// apart. The parser tasks (.eml 2.4, .msg 2.5) assert their output against
// these values; the engine (Milestone 3) uses `thread`, `duplicateGroup` and
// `tags` for ordering, de-duplication and folding tests.
//
// Conventions (same as Source/email-reading/types.ts):
// - ids (messageId, inReplyTo, references) are WITHOUT < >.
// - `date.utcMs` is null when the date is missing or unparseable.
// - `subject` is null when the Subject header is MISSING (an empty
//   "Subject:" header would be ''). `from` / `to` / `cc` / `bcc` are [] when
//   the header is missing.
// - `sender` is undefined when the normalized message must have NO sender
//   key: no Sender header (.msg: no separate PR_SENDER_* mailbox), or one
//   that is the same mailbox as a From mailbox (address, letter case ignored). How the parser stores a missing subject in the
//   normalized message is the parser task's decision; the manifest only
//   records that the header was absent.
// - `warnings` is a set: compare it sorted, order is not meaningful.
// - `bodyContains`: short snippets of the DECODED plain-text body (after
//   charset/transfer decoding, or after HTML-to-text for HTML-only mail).
//   `bodyExcludes`: text that must never reach the plain-text body (script
//   code, event handlers, remote URLs).
// - .msg dates: a .msg stores the sent time as an exact UTC instant without
//   the sender's offset, so `zoneKnown` is true and `offsetMinutes` is not
//   asserted (left undefined) for .msg entries.

import type { ParseWarning } from '../../../Source/email-reading/types';

export interface ExpectedAddress
{
    readonly name: string;
    readonly address: string;
}

export interface ExpectedAttachment
{
    readonly fileName: string;
    readonly mimeType: string;
    /** Decoded size in bytes. */
    readonly size: number;
}

export interface FixtureExpectation
{
    /** .eml: path below Helper/Test/test-data/ (e.g. "eml/01-plain-english.eml"). .msg: the builder spec id. */
    readonly id: string;
    readonly kind: 'eml' | 'msg';
    readonly description: string;
    readonly messageId: string | null;
    readonly inReplyTo: string | null;
    readonly references: readonly string[];
    readonly date: {
        readonly utcMs: number | null;
        readonly zoneKnown: boolean;
        /** undefined = not asserted (used for .msg, see the header comment). */
        readonly offsetMinutes?: number | null;
    };
    readonly from: readonly ExpectedAddress[];
    readonly to: readonly ExpectedAddress[];
    readonly cc: readonly ExpectedAddress[];
    readonly bcc: readonly ExpectedAddress[];
    /** The actual sender when it differs from From ("on behalf of"); undefined = absent (see the header comment). */
    readonly sender?: ExpectedAddress;
    /** null = no Subject header at all (see the header comment). */
    readonly subject: string | null;
    readonly attachments: readonly ExpectedAttachment[];
    readonly warnings: readonly ParseWarning[];
    readonly bodyContains: readonly string[];
    readonly bodyExcludes?: readonly string[];
    /** Thread membership; `position` is the 1-based CHRONOLOGICAL position (not file order). */
    readonly thread?: { readonly id: string; readonly position: number };
    /** Fixtures with the same value are provably identical messages (same Message-ID, or same sender + date + body). */
    readonly duplicateGroup?: string;
    /**
     * Content features for the quote/signature tests, e.g.
     * "quote:gmail-en", "quote:outlook-nl", "signature:alice-dashdash",
     * "signature:bob", "disclaimer:bob".
     */
    readonly tags: readonly string[];
}

const utc = (iso: string): number => Date.parse(iso);

const ALICE: ExpectedAddress = { name: 'Alice Example', address: 'alice@example.test' };
const BOB: ExpectedAddress = { name: 'Bob Sample', address: 'bob@furniture.example.test' };
/** Non-ASCII display name: RFC 2047 encoded in the .eml headers (Q, B, and ISO-8859-1 Q). */
const CAROL: ExpectedAddress = { name: 'Carol Test - Équipe Livraisons', address: 'carol@sample.invalid' };
const PLANNING: ExpectedAddress = { name: 'Sample Furniture Planning', address: 'planning@furniture.example.test' };
const NEWS: ExpectedAddress = { name: 'Sample Furniture News', address: 'news@furniture.example.test' };

const BOB_BLOCKS = ['signature:bob', 'disclaimer:bob'] as const;
const NO_THREAD_IDS = { inReplyTo: null, references: [] } as const;

/** A plain .eml entry: most fields shared, overrides per fixture. */
function eml(
    file: string,
    fields: Omit<FixtureExpectation, 'id' | 'kind' | 'attachments' | 'cc' | 'bcc' | 'warnings' | 'tags'> &
        Partial<Pick<FixtureExpectation, 'attachments' | 'cc' | 'bcc' | 'warnings' | 'tags'>>,
): FixtureExpectation
{
    return { id: `eml/${file}`, kind: 'eml', attachments: [], cc: [], bcc: [], warnings: [], tags: [], ...fields };
}

function msg(
    id: string,
    fields: Omit<FixtureExpectation, 'id' | 'kind' | 'attachments' | 'cc' | 'bcc' | 'warnings' | 'tags'> &
        Partial<Pick<FixtureExpectation, 'attachments' | 'cc' | 'bcc' | 'warnings' | 'tags'>>,
): FixtureExpectation
{
    return { id, kind: 'msg', attachments: [], cc: [], bcc: [], warnings: [], tags: [], ...fields };
}

/** Zone known, with its offset in minutes. */
const at = (iso: string, offsetMinutes: number) => ({ utcMs: utc(iso), zoneKnown: true, offsetMinutes });
/** .msg time: exact UTC instant, offset not asserted. */
const msgAt = (iso: string) => ({ utcMs: utc(iso), zoneKnown: true });

const ORDER_2_FIELDS = {
    messageId: 'order-2.bob@furniture.example.test',
    inReplyTo: 'order-1.alice@example.test',
    references: ['order-1.alice@example.test'],
    from: [BOB],
    to: [ALICE],
    subject: 'RE: Office desks and chairs',
    bodyContains: ['I can come by on Wednesday 5 March', 'Sent: Monday, March 3, 2025 9:15 AM'],
    duplicateGroup: 'order-2',
    tags: ['quote:outlook-en', ...BOB_BLOCKS, 'signature:alice-dashdash'],
} as const;

const CONFIRM_FIELDS = {
    ...NO_THREAD_IDS,
    date: at('2025-03-04T07:00:00Z', 60),
    from: [PLANNING],
    to: [ALICE],
    subject: 'Appointment confirmed',
    bodyContains: ['Your appointment with Sample Furniture is confirmed'],
    duplicateGroup: 'confirm-0305',
} as const;

export const FIXTURES: readonly FixtureExpectation[] = [
    // ------------------------------------------------------------------ .eml
    eml('01-plain-english.eml', {
        description: 'Plain UTF-8 (ASCII-only) English message, all common headers, CRLF line ends.',
        messageId: 'plain-1.alice@example.test',
        ...NO_THREAD_IDS,
        date: at('2025-02-28T17:45:10Z', 60),
        from: [ALICE],
        to: [BOB],
        cc: [{ name: 'Carol Test', address: 'carol@sample.invalid' }],
        subject: 'Office key for next week',
        bodyContains: ['I will leave the office key at the front desk'],
        tags: ['signature:alice-dashdash'],
    }),

    // Thread "order": EN, Outlook EN block, Gmail quote, Outlook NL block.
    eml('10-order-1-alice.eml', {
        description: 'Thread order 1/4: first message.',
        messageId: 'order-1.alice@example.test',
        ...NO_THREAD_IDS,
        date: at('2025-03-03T08:15:00Z', 60),
        from: [ALICE],
        to: [BOB],
        subject: 'Office desks and chairs',
        bodyContains: ['We are furnishing a small office for four people'],
        thread: { id: 'order', position: 1 },
        tags: ['signature:alice-dashdash'],
    }),
    eml('11-order-2-bob-outlook-en.eml', {
        description: 'Thread order 2/4: Outlook-style English header block (From/Sent/To/Subject), signature + disclaimer.',
        ...ORDER_2_FIELDS,
        date: at('2025-03-03T13:02:00Z', 60),
        thread: { id: 'order', position: 2 },
    }),
    eml('12-order-3-alice-gmail.eml', {
        description: 'Thread order 3/4: Gmail-style "On ... wrote:" with > quotes of the whole previous message.',
        messageId: 'order-3.alice@example.test',
        inReplyTo: 'order-2.bob@furniture.example.test',
        references: ['order-1.alice@example.test', 'order-2.bob@furniture.example.test'],
        date: at('2025-03-03T14:40:12Z', 60),
        from: [ALICE],
        to: [BOB],
        subject: 'Re: Office desks and chairs',
        bodyContains: ['Wednesday at 10:00 works for me.', 'On Mon, 3 Mar 2025 at 14:02, Bob Sample'],
        thread: { id: 'order', position: 3 },
        tags: ['quote:gmail-en', 'quote:outlook-en', 'signature:alice-dashdash', ...BOB_BLOCKS],
    }),
    eml('13-order-4-bob-outlook-nl.eml', {
        description: 'Thread order 4/4: Dutch Outlook header block (Van/Verzonden/Aan/Onderwerp), deep nesting.',
        messageId: 'order-4.bob@furniture.example.test',
        inReplyTo: 'order-3.alice@example.test',
        references: ['order-1.alice@example.test', 'order-2.bob@furniture.example.test', 'order-3.alice@example.test'],
        date: at('2025-03-06T15:20:00Z', 60),
        from: [BOB],
        to: [ALICE],
        subject: 'RE: Office desks and chairs',
        bodyContains: ['come to EUR 1,250, VAT included', 'Verzonden: maandag 3 maart 2025 15:40'],
        thread: { id: 'order', position: 4 },
        tags: ['quote:outlook-nl', 'quote:gmail-en', 'quote:outlook-en', ...BOB_BLOCKS, 'signature:alice-dashdash'],
    }),

    // Thread "delivery": French, Apple Mail, Gmail FR, Outlook FR. UTF-8 quoted-printable.
    // It delivers TRIAL desks and chairs (6 Mar); the real order is confirmed in 40
    // (10 Mar), planned in 41 and delivered on Monday 17 Mar (see 72, 60).
    eml('20-delivery-1-carol.eml', {
        description: 'Thread delivery 1/4: French, UTF-8 quoted-printable, Q-encoded sender name.',
        messageId: 'delivery-1.carol@sample.invalid',
        ...NO_THREAD_IDS,
        date: at('2025-03-04T10:20:00Z', 60),
        from: [CAROL],
        to: [ALICE],
        cc: [BOB],
        subject: 'Livraison des bureaux',
        bodyContains: ["Les bureaux et chaises d'essai pour votre équipe", 'sera présent.'],
        thread: { id: 'delivery', position: 1 },
        tags: ['signature:carol'],
    }),
    eml('21-delivery-2-alice-apple.eml', {
        description: 'Thread delivery 2/4: Apple Mail style, attribution line inside the quote ("> On ... wrote:").',
        messageId: 'delivery-2.alice@example.test',
        inReplyTo: 'delivery-1.carol@sample.invalid',
        references: ['delivery-1.carol@sample.invalid'],
        date: at('2025-03-04T12:05:30Z', 60),
        from: [ALICE],
        to: [CAROL],
        cc: [BOB],
        subject: 'Re: Livraison des bureaux',
        bodyContains: ['Please ring at the side door.', '> On 4 Mar 2025, at 11:20, Carol Test - Équipe Livraisons'],
        thread: { id: 'delivery', position: 2 },
        tags: ['quote:apple-en', 'signature:alice-dashdash', 'signature:carol'],
    }),
    eml('22-delivery-3-carol-gmail-fr.eml', {
        description: 'Thread delivery 3/4: French Gmail attribution "Le ... a écrit :" with nested > quotes.',
        messageId: 'delivery-3.carol@sample.invalid',
        inReplyTo: 'delivery-2.alice@example.test',
        references: ['delivery-1.carol@sample.invalid', 'delivery-2.alice@example.test'],
        date: at('2025-03-04T13:31:00Z', 60),
        from: [CAROL],
        to: [ALICE],
        cc: [BOB],
        subject: 'Re: Livraison des bureaux',
        bodyContains: ['le chauffeur sonnera à la porte latérale', 'Le mar. 4 mars 2025 à 13:05, Alice Example'],
        thread: { id: 'delivery', position: 3 },
        tags: ['quote:gmail-fr', 'quote:apple-en', 'signature:carol', 'signature:alice-dashdash'],
    }),
    eml('23-delivery-4-alice-outlook-fr.eml', {
        description: 'Thread delivery 4/4: French Outlook header block (De/Envoyé/À/Cc/Objet).',
        messageId: 'delivery-4.alice@example.test',
        inReplyTo: 'delivery-3.carol@sample.invalid',
        references: ['delivery-1.carol@sample.invalid', 'delivery-2.alice@example.test', 'delivery-3.carol@sample.invalid'],
        date: at('2025-03-06T11:10:00Z', 60),
        from: [ALICE],
        to: [CAROL],
        cc: [BOB],
        subject: 'RE: Livraison des bureaux',
        bodyContains: ['The trial desks and chairs arrived this morning', 'Envoyé : mardi 4 mars 2025 14:31'],
        thread: { id: 'delivery', position: 4 },
        tags: ['quote:outlook-fr', 'quote:gmail-fr', 'quote:apple-en', 'signature:carol', 'signature:alice-dashdash'],
    }),

    // Duplicates.
    eml('30-dup-order-2-copy.eml', {
        description: 'Duplicate of 11 (same Message-ID and body), as received: extra Received/Delivered-To headers.',
        ...ORDER_2_FIELDS,
        date: at('2025-03-03T13:02:00Z', 60),
        thread: { id: 'order', position: 2 },
    }),
    eml('31-dup-confirm-a.eml', {
        description: 'Duplicate pair by sender + date + body: this copy has a Message-ID.',
        ...CONFIRM_FIELDS,
        messageId: 'confirm-0305@furniture.example.test',
    }),
    eml('32-dup-confirm-b-other-id.eml', {
        description: 'Same sender + date + body as 31, but a DIFFERENT Message-ID (re-sent through a relay).',
        ...CONFIRM_FIELDS,
        messageId: 'confirm-0305.resent@relay.example.invalid',
    }),
    eml('33-dup-confirm-c-no-id.eml', {
        description: 'Same sender + date + body as 31, with NO Message-ID.',
        ...CONFIRM_FIELDS,
        messageId: null,
        warnings: ['missing-message-id'],
    }),

    // Encodings.
    eml('40-enc-latin1-qp.eml', {
        description: 'ISO-8859-1 quoted-printable body; ISO-8859-1 Q-encoded sender name.',
        messageId: 'confirmation-1.carol@sample.invalid',
        ...NO_THREAD_IDS,
        date: at('2025-03-10T09:00:00Z', 60),
        from: [CAROL],
        to: [ALICE],
        subject: 'Confirmation de commande',
        bodyContains: ['Nous avons bien reçu votre commande', 'coloris « gris clair »', 'est prêt (entrée côté cour)'],
        tags: ['signature:carol'],
    }),
    eml('41-enc-utf8-base64.eml', {
        description: 'UTF-8 base64 body (Dutch, euro sign, diaeresis), signature + disclaimer.',
        messageId: 'plan-1.bob@furniture.example.test',
        ...NO_THREAD_IDS,
        date: at('2025-03-11T08:00:00Z', 60),
        from: [BOB],
        to: [ALICE],
        subject: 'Planning van de levering',
        bodyContains: ['€ 1.250 (incl. btw)', 'Eén dag werk', 'coördinatie', 'Groeten ook aan Carol (Équipe Livraisons).'],
        tags: [...BOB_BLOCKS],
    }),
    eml('42-enc-rfc2047.eml', {
        description:
            'RFC 2047: subject folded over two encoded words (B then Q), B-encoded sender name, Q-encoded recipient (all UTF-8).',
        messageId: 'meeting-1.carol@sample.invalid',
        ...NO_THREAD_IDS,
        date: at('2025-03-12T16:05:00Z', 60),
        from: [CAROL],
        to: [BOB],
        subject: 'Réunion de livraison – vendredi',
        bodyContains: ['faire le point vendredi à 9h'],
        tags: ['signature:carol'],
    }),
    eml('43-enc-windows1252.eml', {
        description: 'windows-1252 quoted-printable body; only bytes 0xA0-0xFF (no 0x80-0x9F), so Node and browsers agree.',
        messageId: 'billing-1.bob@furniture.example.test',
        ...NO_THREAD_IDS,
        date: at('2025-03-13T10:30:00Z', 60),
        from: [BOB],
        to: [ALICE],
        subject: 'Factuurgegevens',
        bodyContains: ['financiële afhandeling', 'geïnteresseerd', 'café-hoek', 'één bureau'],
        tags: ['signature:bob'],
    }),

    // HTML.
    eml('50-html-only.eml', {
        description: 'HTML-only body (no text/plain) with inert script, onload/onclick/onerror, tracking pixel, javascript: link.',
        messageId: 'news-2025-03@furniture.example.test',
        ...NO_THREAD_IDS,
        date: at('2025-03-12T07:30:00Z', 0),
        from: [NEWS],
        to: [ALICE],
        subject: 'Spring offer: office chairs',
        warnings: ['html-converted-body'],
        bodyContains: ['Dear Alice,', 'Spring offer on office chairs', 'Book a visit'],
        bodyExcludes: ['SCRIPT-RAN', 'ONLOAD-RAN', 'CLICK-RAN', 'ONERROR-RAN', 'JS-LINK-RAN', 'tracker.invalid', 'font-family', '<p>'],
    }),
    eml('51-html-alternative.eml', {
        description: 'multipart/alternative (text + HTML); HTML has script, iframe, form, remote CSS/background/pixel.',
        messageId: 'catalogue-1.carol@sample.invalid',
        ...NO_THREAD_IDS,
        date: at('2025-03-14T08:45:00Z', 60),
        from: [CAROL],
        to: [ALICE],
        subject: 'Nouveau catalogue',
        bodyContains: ['Notre nouveau catalogue de bureaux est disponible.', "Remise de 5 % jusqu'à fin mars."],
        bodyExcludes: ['HOVER-RAN', 'tracker.invalid', 'frame.invalid', '<b>'],
        tags: ['signature:carol'],
    }),

    // Attachment.
    eml('60-attachment.eml', {
        description: 'multipart/mixed with one small base64 text attachment (metadata only), signature + disclaimer.',
        messageId: 'deliverynote-2025-017.bob@furniture.example.test',
        ...NO_THREAD_IDS,
        date: at('2025-03-21T10:00:00Z', 60),
        from: [BOB],
        to: [ALICE],
        subject: 'Delivery note 2025-017',
        attachments: [{ fileName: 'delivery-note-2025-017.txt', mimeType: 'text/plain', size: 136 }],
        bodyContains: ['Please find attached the delivery note'],
        bodyExcludes: ['SYNTHETIC TEST DOCUMENT'],
        tags: [...BOB_BLOCKS],
    }),

    // Missing / broken headers.
    eml('70-no-date.eml', {
        description: 'No Date header at all.',
        messageId: 'nodate-1.alice@example.test',
        ...NO_THREAD_IDS,
        date: { utcMs: null, zoneKnown: false, offsetMinutes: null },
        from: [ALICE],
        to: [BOB],
        subject: 'Spare chair',
        warnings: ['missing-date'],
        bodyContains: ['leave the spare chair in the storage room'],
    }),
    eml('71-bad-date.eml', {
        description: 'Unparseable Date header ("not a date"): no date at all, so it can never become parseable.',
        messageId: 'baddate-1.alice@example.test',
        ...NO_THREAD_IDS,
        date: { utcMs: null, zoneKnown: false, offsetMinutes: null },
        from: [ALICE],
        to: [BOB],
        subject: 'Cable trays',
        warnings: ['unparseable-date'],
        bodyContains: ['look at the cable trays'],
    }),
    eml('72-no-message-id.eml', {
        description: 'No Message-ID header.',
        messageId: null,
        ...NO_THREAD_IDS,
        date: at('2025-03-15T09:20:00Z', 60),
        from: [ALICE],
        to: [BOB],
        subject: 'Thank you',
        warnings: ['missing-message-id'],
        bodyContains: ['See you on Monday for the delivery'],
    }),
    eml('73-date-no-zone.eml', {
        description: 'Date without a time zone: read as UTC for sorting only and flagged.',
        messageId: 'nozone-1.alice@example.test',
        ...NO_THREAD_IDS,
        date: { utcMs: utc('2025-03-11T16:45:00Z'), zoneKnown: false, offsetMinutes: null },
        from: [ALICE],
        to: [BOB],
        subject: 'Old desks',
        warnings: ['unknown-time-zone'],
        bodyContains: ['The old desks can stay until Friday'],
    }),
    eml('74-date-localized-weekday.eml', {
        description: 'Date with a French weekday ("mer.,"), otherwise valid.',
        messageId: 'frweekday-1.alice@example.test',
        ...NO_THREAD_IDS,
        date: at('2025-03-12T09:30:00Z', 60),
        from: [ALICE],
        to: [BOB],
        subject: 'Parking',
        bodyContains: ['park the van in front of the office on Monday'],
    }),
    eml('75-missing-from-to-subject.eml', {
        description: 'No From, no To and no Subject header (Date and Message-ID present).',
        messageId: 'noheaders-1@example.test',
        ...NO_THREAD_IDS,
        date: at('2025-03-14T14:00:00Z', 60),
        from: [],
        to: [],
        subject: null,
        bodyContains: ['the grey office chair in room 2 needs a new wheel'],
    }),

    // Thread "setup": three time zones; file order (a, b, c, d) != chronological order (b, d, a, c).
    eml('80-setup-a-carol.eml', {
        description: 'Thread setup 3/4 (+0000): French Gmail attribution; local time 13:45 looks earlier than it is.',
        messageId: 'setup-3.carol@sample.invalid',
        inReplyTo: 'setup-2.alice@example.test',
        references: ['setup-1.bob@furniture.example.test', 'setup-2.alice@example.test'],
        date: at('2025-06-10T13:45:00Z', 0),
        from: [CAROL],
        to: [ALICE, BOB],
        subject: 'Re: Setup check on Thursday',
        bodyContains: ['avec les échantillons de tissu', 'Le mar. 10 juin 2025 à 13:30, Alice Example'],
        thread: { id: 'setup', position: 3 },
        tags: ['quote:gmail-fr', 'quote:gmail-en', 'signature:carol', 'signature:alice-dashdash', ...BOB_BLOCKS],
    }),
    eml('81-setup-b-bob.eml', {
        description: 'Thread setup 1/4 (+0200): first message, signature + disclaimer.',
        messageId: 'setup-1.bob@furniture.example.test',
        ...NO_THREAD_IDS,
        date: at('2025-06-10T13:00:00Z', 120),
        from: [BOB],
        to: [ALICE, CAROL],
        subject: 'Setup check on Thursday',
        bodyContains: ['Can we meet at the office on Thursday 12 June at 9:00'],
        thread: { id: 'setup', position: 1 },
        tags: [...BOB_BLOCKS],
    }),
    eml('82-setup-c-bob.eml', {
        description: 'Thread setup 4/4 (+0200): Dutch attribution "Op ... schreef ...:", three quote levels.',
        messageId: 'setup-4.bob@furniture.example.test',
        inReplyTo: 'setup-3.carol@sample.invalid',
        references: ['setup-1.bob@furniture.example.test', 'setup-2.alice@example.test', 'setup-3.carol@sample.invalid'],
        date: at('2025-06-10T14:10:00Z', 120),
        from: [BOB],
        to: [ALICE, CAROL],
        subject: 'Re: Setup check on Thursday',
        bodyContains: ['Perfect, see you Thursday.', 'Op di 10 jun 2025 om 15:45 schreef Carol Test - Équipe Livraisons'],
        thread: { id: 'setup', position: 4 },
        tags: ['quote:dutch-op-schreef', 'quote:gmail-fr', 'quote:gmail-en', ...BOB_BLOCKS, 'signature:carol', 'signature:alice-dashdash'],
    }),
    eml('83-setup-d-alice.eml', {
        description: 'Thread setup 2/4 (-0500): US-style Gmail attribution; local time 08:30 looks earliest but is not.',
        messageId: 'setup-2.alice@example.test',
        inReplyTo: 'setup-1.bob@furniture.example.test',
        references: ['setup-1.bob@furniture.example.test'],
        date: at('2025-06-10T13:30:00Z', -300),
        from: [ALICE],
        to: [BOB, CAROL],
        subject: 'Re: Setup check on Thursday',
        bodyContains: ['Thursday 9:00 is fine', 'On Tue, Jun 10, 2025 at 8:00 AM Bob Sample'],
        thread: { id: 'setup', position: 2 },
        tags: ['quote:gmail-en', 'signature:alice-dashdash', ...BOB_BLOCKS],
    }),

    // Sender and Bcc.
    eml('90-sender-on-behalf.eml', {
        description: 'Sent on behalf of: Sender (the planning mailbox) differs from From (Bob), so `sender` is kept.',
        messageId: 'slot-1.planning@furniture.example.test',
        ...NO_THREAD_IDS,
        date: at('2025-03-18T07:30:00Z', 60),
        from: [BOB],
        sender: PLANNING,
        to: [ALICE],
        subject: 'Delivery slot confirmed',
        bodyContains: ['On behalf of Bob: the delivery slot for the remaining chairs'],
    }),
    eml('91-sender-same-as-from.eml', {
        description: 'Sender header naming the From mailbox in other letter case: no `sender`.',
        messageId: 'slot-2.alice@example.test',
        ...NO_THREAD_IDS,
        date: at('2025-03-18T09:05:00Z', 60),
        from: [ALICE],
        to: [BOB],
        subject: 'Delivery slot on Thursday',
        bodyContains: ['Thursday afternoon is fine'],
    }),
    eml('92-bcc-own-copy.eml', {
        description: "The sender's own copy with a Bcc header folded over two lines (two mailboxes).",
        messageId: 'keys-1.alice@example.test',
        ...NO_THREAD_IDS,
        date: at('2025-03-19T15:20:00Z', 60),
        from: [ALICE],
        to: [BOB],
        bcc: [{ name: 'Carol Test', address: 'carol@sample.invalid' }, PLANNING],
        subject: 'Spare keys for the delivery team',
        bodyContains: ['The spare keys for the delivery team are at the front desk.'],
    }),
    eml('93-answers-between-lines.eml', {
        description:
            'Answers written between the quoted lines (no quoted tail to fold); a Sender and a Cc mailbox found in no other fixture; ' +
            'quoted-printable body with an emoji, a tab, a control character (BEL) and accents.',
        messageId: 'answers-1.bob@furniture.example.test',
        ...NO_THREAD_IDS,
        date: at('2025-03-11T16:20:00Z', 0),
        from: [BOB],
        sender: { name: 'Erin Test', address: 'erin@furniture.example.test' },
        to: [ALICE],
        cc: [{ name: 'Dana Sample', address: 'dana.sample@example.test' }],
        subject: 'Answers between the lines',
        bodyContains: [
            'My answers are between your lines.',
            '> start whenever suits you.',
            'Good, the van will take the old desks on Friday. \u{1F600}',
            'Price list:\tdesk\u{7}chair',
            'Caf\u{E9} cr\u{E8}me \u{E0} c\u{F4}t\u{E9}.',
        ],
        tags: ['quote:gmail-en'],
    }),

    // ------------------------------------------------------------------ .msg (built from msg/specs.ts)
    msg('msg-01-plain-unicode', {
        description: 'Plain Unicode .msg, To + Cc.',
        messageId: 'msg-plain-1.alice@example.test',
        ...NO_THREAD_IDS,
        date: msgAt('2025-04-01T07:30:00Z'),
        from: [ALICE],
        to: [BOB],
        cc: [CAROL],
        subject: 'Réunion de livraison – planning',
        bodyContains: ['mercredi à 9h, café prévu.', '(één uur, € 0 extra)'],
        tags: ['signature:alice-dashdash'],
    }),
    msg('msg-02-chain-1-bob', {
        description: 'Chain 1/3, Exchange sender: from.address must be the SMTP fallback, not the X.500 DN.',
        messageId: 'msg-chain-1.bob@furniture.example.test',
        ...NO_THREAD_IDS,
        date: msgAt('2025-04-02T09:00:00Z'),
        from: [BOB],
        to: [ALICE],
        subject: 'Offerte vergadertafel',
        bodyContains: ['Hierbij mijn offerte voor de vergadertafel'],
        thread: { id: 'msg-chain', position: 1 },
        tags: [...BOB_BLOCKS],
    }),
    msg('msg-03-chain-2-alice-fr', {
        description: 'Chain 2/3, French Outlook block; In-Reply-To/References from raw properties 0x1042/0x1039.',
        messageId: 'msg-chain-2.alice@example.test',
        inReplyTo: 'msg-chain-1.bob@furniture.example.test',
        references: ['msg-chain-1.bob@furniture.example.test'],
        date: msgAt('2025-04-02T12:15:00Z'),
        from: [ALICE],
        to: [BOB],
        subject: 'RE: Offerte vergadertafel',
        bodyContains: ['the quote is accepted', 'Envoyé : mercredi 2 avril 2025 11:00'],
        thread: { id: 'msg-chain', position: 2 },
        tags: ['quote:outlook-fr', ...BOB_BLOCKS],
    }),
    msg('msg-04-chain-3-bob-nl', {
        description: 'Chain 3/3, Dutch Outlook block, transport headers (agree with the properties).',
        messageId: 'msg-chain-3.bob@furniture.example.test',
        inReplyTo: 'msg-chain-2.alice@example.test',
        references: ['msg-chain-1.bob@furniture.example.test', 'msg-chain-2.alice@example.test'],
        date: msgAt('2025-04-03T06:40:00Z'),
        from: [BOB],
        to: [ALICE],
        subject: 'RE: Offerte vergadertafel',
        bodyContains: ['ik noteer maandag 5 mei', 'Verzonden: woensdag 2 april 2025 14:15'],
        thread: { id: 'msg-chain', position: 3 },
        tags: ['quote:outlook-nl', 'quote:outlook-fr', ...BOB_BLOCKS],
    }),
    msg('msg-05-html-and-plain', {
        description: 'Plain + HTML bodies: the plain body is used; the HTML never runs or loads.',
        messageId: 'msg-catalogue-1.carol@sample.invalid',
        ...NO_THREAD_IDS,
        date: msgAt('2025-04-04T10:00:00Z'),
        from: [CAROL],
        to: [ALICE],
        subject: 'Nouveau catalogue',
        bodyContains: ['Voici notre catalogue de printemps.'],
        bodyExcludes: ['MSG-SCRIPT-RAN', 'MSG-ONLOAD-RAN', 'tracker.invalid', '<b>'],
        tags: ['signature:carol'],
    }),
    msg('msg-06-attachment', {
        description: 'One text attachment (metadata only).',
        messageId: 'msg-pakbon-2025-021.bob@furniture.example.test',
        ...NO_THREAD_IDS,
        date: msgAt('2025-04-10T13:00:00Z'),
        from: [BOB],
        to: [ALICE],
        subject: 'Pakbon 2025-021',
        attachments: [{ fileName: 'pakbon-2025-021.txt', mimeType: 'text/plain', size: 128 }],
        bodyContains: ['In bijlage de pakbon'],
        bodyExcludes: ['SYNTHETIC TEST DOCUMENT'],
        tags: [...BOB_BLOCKS],
    }),
    msg('msg-07-no-sent-time', {
        description: 'No sent/received time: date missing, never invented.',
        messageId: 'msg-draft-1.alice@example.test',
        ...NO_THREAD_IDS,
        date: { utcMs: null, zoneKnown: false },
        from: [ALICE],
        to: [BOB],
        subject: 'Note: spare chair',
        warnings: ['missing-date'],
        bodyContains: ['the spare chair is in the storage room'],
    }),
    msg('msg-08-ansi-cp1252', {
        description: 'ANSI strings, code page 1252 (read with ansiEncoding "windows-1252").',
        messageId: 'msg-ack-1.carol@sample.invalid',
        ...NO_THREAD_IDS,
        date: msgAt('2025-04-15T08:20:00Z'),
        from: [CAROL],
        to: [ALICE],
        subject: 'Accusé de réception',
        bodyContains: ['Nous accusons réception de votre commande.', 'Crème, château, Noël, ça va.'],
        tags: ['signature:carol'],
    }),
    msg('msg-09-dup-of-eml-order-2', {
        description: 'Cross-format duplicate of eml 11/30 (same Message-ID; body identical up to CRLF line ends and the final line break).',
        ...ORDER_2_FIELDS,
        date: msgAt('2025-03-03T13:02:00Z'),
        thread: { id: 'order', position: 2 },
    }),
    msg('msg-10-on-behalf', {
        description: 'Sent on behalf of: from = the represented mailbox (Bob), sender = the planning mailbox; both via the SMTP fallback.',
        messageId: 'msg-levering-1.planning@furniture.example.test',
        ...NO_THREAD_IDS,
        date: msgAt('2025-04-28T07:45:00Z'),
        from: [BOB],
        sender: PLANNING,
        to: [ALICE],
        subject: 'Levering vergadertafel',
        bodyContains: ['worden op maandag 5 mei tussen 9:00 en'],
        tags: [...BOB_BLOCKS],
    }),
    msg('msg-11-bcc-own-copy', {
        description: "Sender's own copy: one Bcc recipient kept, the empty Bcc row skipped; represented = sender, so no `sender`.",
        messageId: 'msg-chairs-1.alice@example.test',
        ...NO_THREAD_IDS,
        date: msgAt('2025-04-29T09:10:00Z'),
        from: [ALICE],
        to: [BOB],
        bcc: [CAROL],
        subject: 'Chairs for the meeting room',
        bodyContains: ['two extra chairs for the meeting room'],
        tags: ['signature:alice-dashdash'],
    }),
    msg('msg-12-represented-is-sender', {
        description: 'Represented mailbox = sender (same X.500 address): no `sender`; from borrows the sender SMTP address.',
        messageId: 'msg-stoelen-1.bob@furniture.example.test',
        ...NO_THREAD_IDS,
        date: msgAt('2025-04-29T11:30:00Z'),
        from: [BOB],
        to: [ALICE],
        subject: 'Stoelen vergaderzaal',
        bodyContains: ['Twee extra stoelen zijn geen probleem.'],
        tags: [...BOB_BLOCKS],
    }),
    msg('msg-13-html-only', {
        description: 'HTML-only body: converted to plain text; script, handler, stylesheet, pixel and link URL never reach the text.',
        messageId: 'msg-showroom-1.carol@sample.invalid',
        ...NO_THREAD_IDS,
        date: msgAt('2025-04-22T09:00:00Z'),
        from: [{ name: 'Carol Test', address: 'carol@sample.invalid' }],
        to: [ALICE],
        subject: 'Showroom visit on Friday',
        warnings: ['html-converted-body'],
        bodyContains: ['Hello Alice,', 'The showroom visit is on Friday 25 April at 14:00.', 'Plan your route'],
        bodyExcludes: [
            'MSG13-SCRIPT-RAN',
            'MSG13-ONERROR-RAN',
            'document.title',
            'onerror',
            'href',
            'cdn.invalid',
            'tracker.invalid',
            'shop.invalid',
            '<p>',
            '<b>',
        ],
    }),
];
