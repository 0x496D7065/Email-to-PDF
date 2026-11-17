// Month and weekday names per language: plain data used by quoted-date.ts to
// read the dates mail clients write in quote headers ("Monday, March 3, 2025
// 9:15 AM", "lun. 3 mars 2025 \u00e0 14:02", "ma 3 mrt 2025 om 14:02").
//
// To support another language, add one entry to DATE_LANGUAGES below; the
// reader needs no change.
//
// How the reader uses this data:
// - Words are compared to a CLEANED token: lower case, Unicode NFC, one
//   final "." removed ("mrt." -> "mrt", "lun." -> "lun"). So write every
//   word below in lower case, NFC, without a final period.
// - Words of all languages are accepted together (a Dutch month after an
//   English weekday is still read). A word must never name two different
//   months, or two different weekdays (checked by quoted-date.test.ts).
// - One word may be both a month and a weekday: French "mar" (mardi,
//   Tuesday) is also English "Mar" (March). The reader takes it as the
//   weekday only when it is the first word AND another month word follows
//   ("mar. 4 mars 2025"); otherwise it is the month ("Mar 3, 2025").
// - Forms without their accent are listed too ("fevrier", "aout"), because
//   plain-text copies sometimes lose accents.
//
// Non-ASCII letters are written as \u escapes so this file stays ASCII:
// \u00e0 = a grave, \u00e9 = e acute, \u00fb = u circumflex.

export interface DateLanguage {
    /** Language code, for readers and tests only. */
    readonly code: string;
    /** Twelve entries, January first: every way the month is written. */
    readonly months: readonly (readonly string[])[];
    /** Seven entries, SUNDAY first (like Date.getUTCDay): every way the weekday is written. */
    readonly weekdays: readonly (readonly string[])[];
    /** Small words between the date and the time ("at", "\u00e0", "om"); skipped. */
    readonly connectors: readonly string[];
}

export const DATE_LANGUAGES: readonly DateLanguage[] = [
    {
        code: 'en',
        months: [
            ['january', 'jan'],
            ['february', 'feb'],
            ['march', 'mar'],
            ['april', 'apr'],
            ['may'],
            ['june', 'jun'],
            ['july', 'jul'],
            ['august', 'aug'],
            ['september', 'sep', 'sept'],
            ['october', 'oct'],
            ['november', 'nov'],
            ['december', 'dec'],
        ],
        weekdays: [
            ['sunday', 'sun'],
            ['monday', 'mon'],
            ['tuesday', 'tue', 'tues'],
            ['wednesday', 'wed'],
            ['thursday', 'thu', 'thur', 'thurs'],
            ['friday', 'fri'],
            ['saturday', 'sat'],
        ],
        connectors: ['at'],
    },
    {
        code: 'fr',
        months: [
            ['janvier', 'janv'],
            ['f\u00e9vrier', 'f\u00e9vr', 'f\u00e9v', 'fevrier', 'fevr', 'fev'],
            ['mars'],
            ['avril', 'avr'],
            ['mai'],
            ['juin'],
            ['juillet', 'juil'],
            ['ao\u00fbt', 'aout'],
            ['septembre', 'sept'],
            ['octobre', 'oct'],
            ['novembre', 'nov'],
            ['d\u00e9cembre', 'd\u00e9c', 'decembre', 'dec'],
        ],
        weekdays: [
            ['dimanche', 'dim'],
            ['lundi', 'lun'],
            ['mardi', 'mar'],
            ['mercredi', 'mer'],
            ['jeudi', 'jeu'],
            ['vendredi', 'ven'],
            ['samedi', 'sam'],
        ],
        // "a" is "\u00e0" that lost its accent in a plain-text copy.
        connectors: ['\u00e0', 'a'],
    },
    {
        code: 'nl',
        months: [
            ['januari', 'jan'],
            ['februari', 'feb'],
            ['maart', 'mrt'],
            ['april', 'apr'],
            ['mei'],
            ['juni', 'jun'],
            ['juli', 'jul'],
            ['augustus', 'aug'],
            ['september', 'sep', 'sept'],
            ['oktober', 'okt'],
            ['november', 'nov'],
            ['december', 'dec'],
        ],
        weekdays: [
            ['zondag', 'zo'],
            ['maandag', 'ma'],
            ['dinsdag', 'di'],
            ['woensdag', 'wo'],
            ['donderdag', 'do'],
            ['vrijdag', 'vr'],
            ['zaterdag', 'za'],
        ],
        connectors: ['om'],
    },
];
