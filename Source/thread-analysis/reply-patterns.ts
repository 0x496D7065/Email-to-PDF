// Reply-header patterns per language: plain data used by reply-header.ts.
//
// To support another language, add one entry to REPLY_LANGUAGES below; the
// detector needs no change. The patterns copy what common mail clients
// (Gmail, Apple Mail, Outlook) typically write above quoted or forwarded
// text in that language.
//
// How the detector reads this data:
// - Every regular expression is tested against a CLEANED copy of one line
//   (or of two lines joined by a space, for a wrapped attribution): leading
//   ">" quote markers removed, every run of whitespace (nbsp included)
//   turned into one space, trimmed, Unicode NFC. So the patterns below can
//   use single spaces and need no "^\s*" or ">" handling. They are tested
//   case-insensitively (the detector adds the flags), so write them in lower
//   case.
// - Header labels are plain words (any case), compared case-insensitively.
//   A label line is "Label: value", "Label : value" (French typography),
//   "*Label:* value" (bold written as stars by some plain-text converters).
//   Labels of all languages are accepted in one block, because some clients
//   mix them (for example a Dutch "Van:" block with an English "Date:").
//
// Non-ASCII letters are written as \u escapes so this file stays ASCII:
// \u00e9 = e acute, \u00c0 = capital A grave, \u2019 = right single quote
// (a "curly" apostrophe).

/** The header label words of one language, by role. */
export interface HeaderLabels
{
    /** The sender line. A header block must START with one of these. */
    readonly from: readonly string[];
    /** The date line ("Sent" in Outlook, "Date" in Apple Mail and Gmail forwards). */
    readonly sent: readonly string[];
    readonly to: readonly string[];
    /** Copy lines. */
    readonly cc: readonly string[];
    /**
     * Blind-copy lines. For detection they count exactly like Cc lines; the
     * field reader (quoted-header.ts) reads past them and never reports them.
     */
    readonly bcc: readonly string[];
    readonly subject: readonly string[];
}

export interface ReplyLanguage
{
    /** Language code, for readers and tests only. */
    readonly code: string;
    /**
     * Attribution lines ("On <date>, <name> wrote:"). `opener` matches the
     * start of the line, `ending` its end. A line that starts with `opener`
     * and ends with an `ending` (of the same language) is an attribution;
     * a line with only an `ending` is one only when a ">" quote follows it
     * (see reply-header.ts).
     */
    readonly attribution: {
        readonly opener: RegExp;
        readonly endings: readonly RegExp[];
        /**
         * How quoted-header.ts reads the date and the sender out of an
         * attribution (detection does not use this). `tail` matches what follows
         * the sender at the end of the line (" wrote:"). `verbs`: the words
         * written between the date and the sender when the language puts the
         * verb first (Dutch "Op <date> schreef <name>:"); without them, the last
         * comma separates the date from the sender.
         */
        readonly parts: {
            readonly tail: RegExp;
            readonly verbs?: readonly string[];
        };
    };
    /** Outlook-style "original message" separator lines (whole line). */
    readonly separators: readonly RegExp[];
    /** Lines that introduce a FORWARDED message (whole line). */
    readonly forwardMarkers: readonly RegExp[];
    /** Subject prefixes of a forward, without the colon ("Fwd" for "Fwd: ..."). */
    readonly forwardSubjectPrefixes: readonly string[];
    readonly labels: HeaderLabels;
}

export const REPLY_LANGUAGES: readonly ReplyLanguage[] = [
    {
        code: 'en',
        attribution: {
            // Gmail: "On Mon, 3 Mar 2025 at 14:02, Bob <bob@x.test> wrote:"
            // Apple: "On 4 Mar 2025, at 11:20, Carol <carol@x.test> wrote:"
            opener: /^on /,
            endings: [/\bwrote ?:$/],
            parts: { tail: / ?\bwrote ?:$/ },
        },
        separators: [/^-{2,} ?original message ?-{2,}$/],
        forwardMarkers: [
            /^-{2,} ?forwarded message ?-{2,}$/, // Gmail, Outlook
            /^begin forwarded message ?:$/, // Apple Mail
        ],
        forwardSubjectPrefixes: ['FW', 'Fwd'],
        labels: {
            from: ['From'],
            sent: ['Sent', 'Date'],
            to: ['To'],
            cc: ['Cc'],
            bcc: ['Bcc'],
            subject: ['Subject'],
        },
    },
    {
        code: 'fr',
        attribution: {
            // Gmail: "Le mar. 4 mars 2025 a 13:05, Alice <alice@x.test> a ecrit :"
            // Apple: "Le 4 mars 2025 a 11:20, Carol <carol@x.test> a ecrit :"
            // (with the accents). "[e\u00e9]" also accepts a lost accent.
            opener: /^le /,
            endings: [/\ba [e\u00e9]crit ?:$/],
            parts: { tail: / ?\ba [e\u00e9]crit ?:$/ },
        },
        separators: [/^-{2,} ?message d['\u2019]origine ?-{2,}$/],
        forwardMarkers: [
            /^-{2,} ?message transf[e\u00e9]r[e\u00e9] ?-{2,}$/, // Gmail
            /^d[e\u00e9]but du message r[e\u00e9]exp[e\u00e9]di[e\u00e9] ?:$/, // Apple Mail
        ],
        forwardSubjectPrefixes: ['TR', 'Fwd'],
        labels: {
            from: ['De'],
            // "Envoye" without its accent, as for "A" below.
            sent: ['Envoy\u00e9', 'Envoye', 'Date'],
            // "A" without its accent is common in plain-text copies.
            to: ['\u00c0', 'A'],
            cc: ['Cc'],
            bcc: ['Cci'],
            subject: ['Objet'],
        },
    },
    {
        code: 'nl',
        attribution: {
            // Gmail: "Op ma 3 mrt 2025 om 14:02 schreef Bob <bob@x.test>:"
            // Apple: "Op 4 mrt. 2025 om 11:20 heeft Carol <carol@x.test> het volgende geschreven:"
            // In Dutch the verb comes before the name, so the first ending only asks
            // for "schreef" somewhere before the final colon.
            opener: /^op /,
            endings: [/\bschreef\b.*:$/, /\bhet volgende geschreven ?:$/],
            // "... schreef Bob <bob@x.test>:", "... schreef Bob <bob@x.test> het volgende:",
            // "... heeft Carol <carol@x.test> het volgende geschreven:"
            parts: { tail: /(?: het volgende(?: geschreven)?)? ?:$/, verbs: ['schreef', 'heeft'] },
        },
        separators: [/^-{2,} ?oorspronkelijk bericht ?-{2,}$/],
        forwardMarkers: [
            /^-{2,} ?doorgestuurd bericht ?-{2,}$/, // Gmail
            /^begin doorgestuurd bericht ?:$/, // Apple Mail
        ],
        forwardSubjectPrefixes: ['Doorst', 'FW'],
        labels: {
            from: ['Van'],
            sent: ['Verzonden', 'Datum'],
            to: ['Aan'],
            cc: ['CC'],
            bcc: ['BCC'],
            subject: ['Onderwerp'],
        },
    },
];

/**
 * Outlook's plain-text rule above a reply header block (its HTML <hr> written
 * as a row of underscores). Only meaningful right above a header block: a
 * row of underscores alone is also a common divider in signatures.
 */
export const OUTLOOK_RULE = /^_{10,}$/;
