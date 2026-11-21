// The "phone forward of a flat thread" shape (task 9.9a), as plain text, in French, English and
// Dutch, with the list of earlier emails a correct rebuild finds in it. Test-only.
//
// A shape some phone mail apps produce when they forward a forward of a long thread: no ">" marks
// at all. The content is an invented office-furniture order (Helper/Test/test-data/README.md,
// content rules) between a client and a furniture workshop. Newest first, the body holds 13
// earlier emails, none quoted with ">":
// - an EMPTY forward block (marker + From / Date / Subject / To / Cc, nothing under it),
// - a forward block with a short text,
// - mobile attributions ("Le 6 oct. 2026 09:34, ... a ecrit :") with the text at the SAME depth,
// - four Outlook blocks (From / Sent / To / [Cc] / Subject), one with a Cc,
// - two empty attributions, each followed directly by another one (27 Sep 08:31 over 08:27; and
//   14 Jul 16:53 twice: a duplicate pair),
// - a 15-line workshop signature, repeated under each workshop email.
// The French form ('fr') is the text part of fixtures 94 and 97 (Helper/Test/test-data/eml/); 95
// and 96 wrap it, 98 is the same thread as Android HTML (all five written by
// phone-forward-fixtures.ts from phoneForwardParts).
// Forms: 'fr' as the phone writes it ("09:34," without "a"), 'fr-a' with "a"; 'en' ("On 6 Oct
// 2026, at 09:34, ... wrote:") and 'en-bare' (no "at"); 'nl' ("Op 6 okt. 2026 om 09:34 heeft ...
// het volgende geschreven:") and 'nl-bare' (no "om").
// Synthetic data only (Helper/Test/test-data/README.md): *.test addresses, fake numbers.
// Non-ASCII letters are written as \u escapes so this file stays ASCII.

import type { EmailAddress } from '../../../Header/parsed-email';

export type PhoneForwardForm = 'fr' | 'fr-a' | 'en' | 'en-bare' | 'nl' | 'nl-bare';

export const PHONE_FORWARD_FORMS: readonly PhoneForwardForm[] = ['fr', 'fr-a', 'en', 'en-bare', 'nl', 'nl-bare'];

/** One earlier email as a correct rebuild gives it (newest first = body order). */
export interface ExpectedPhoneForwardEmail
{
    readonly kind: 'reply' | 'forward';
    readonly from: EmailAddress;
    /** Header blocks only; [] for attributions. */
    readonly to: readonly EmailAddress[];
    readonly cc: readonly EmailAddress[];
    /** The date as written in the header (cleaned). */
    readonly dateText: string;
    /** The wall-clock time as written, "YYYY-MM-DDTHH:MM" (QuotedDate.wallMs; no zone conversion). */
    readonly wall: string;
    /** As shown: the header's own, or for an attribution the chain's (user decision F3). */
    readonly subject: string;
    readonly subjectFromChain: boolean;
    /** No text under the header (user decision F2): left out of the PDF. */
    readonly noOwnText: boolean;
    /** The text, white space squashed, starts with `first` and ends with `last` ('' for an empty one). */
    readonly first: string;
    readonly last: string;
}

export interface PhoneForwardThread
{
    /** The body text of the forwarding email, "\n" line breaks, ends with "\n". */
    readonly body: string;
    /** The forwarding email's subject. */
    readonly subject: string;
    /** Newest first (generation 1 first). */
    readonly expected: readonly ExpectedPhoneForwardEmail[];
}

/** One earlier email as written in the body (for the fixture files, which also write it as HTML). */
export interface PhoneForwardPart
{
    /** forward: a forward block; outlook: an Outlook header block; attribution: one attribution line. */
    readonly shape: 'forward' | 'outlook' | 'attribution';
    /** Written by the workshop (the other emails are the client's). */
    readonly byWorkshop: boolean;
    /** The header lines as the plain text writes them. */
    readonly head: readonly string[];
    /** The paragraphs under the header ([] when empty), the workshop signature included. */
    readonly body: readonly string[];
    readonly expected: ExpectedPhoneForwardEmail;
}

/** Everything a fixture writer needs: the parts and the words of the form. */
export interface PhoneForwardParts
{
    readonly subject: string;
    readonly client: EmailAddress;
    readonly workshop: EmailAddress;
    readonly second: EmailAddress;
    /** The forwarding email's recipient (an address only). */
    readonly office: string;
    readonly parts: readonly PhoneForwardPart[];
}

/** The words of one language. */
interface Language
{
    readonly subject: string;
    readonly client: { readonly name: string; readonly address: string };
    readonly workshop: { readonly name: string; readonly address: string };
    readonly second: { readonly name: string; readonly address: string };
    readonly office: string;
    readonly forwardMarker: string;
    /** Forward block labels: from, date, subject, to, cc (with their colon and spaces). */
    readonly forwardLabels: readonly [string, string, string, string, string];
    /** Outlook block labels: from, sent, to, cc, subject. */
    readonly outlookLabels: readonly [string, string, string, string, string];
    /** The attribution line for a date ("6 oct. 2026", "09:34") and a mailbox as written. */
    readonly attribution: (day: string, time: string, mailbox: string, connector: boolean) => { line: string; dateText: string };
    /** Short date ("6 oct. 2026") of a day of 2026: month 1-12. */
    readonly shortDay: (day: number, month: number) => string;
    /** Outlook "Sent" value of a day of 2026 (month 1-12) and a time. */
    readonly outlookDate: (month: number, day: number, hour: number, minute: number) => string;
    readonly signature: readonly string[];
    readonly texts: Texts;
}

/** The own texts, paragraphs separated by a blank line. */
interface Texts
{
    readonly f2: readonly string[];
    readonly a1: readonly string[];
    readonly o1: readonly string[];
    readonly a2: readonly string[];
    readonly o2: readonly string[];
    readonly a3: readonly string[];
    readonly o3: readonly string[];
    readonly a5: readonly string[];
    readonly a7: readonly string[];
    readonly a8: readonly string[];
}

const two = (n: number): string => String(n).padStart(2, '0');
const FR_MONTHS_SHORT = ['janv.', 'f\u00e9vr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'ao\u00fbt', 'sept.', 'oct.', 'nov.', 'd\u00e9c.'];
const EN_MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const NL_MONTHS_SHORT = ['jan.', 'feb.', 'mrt.', 'apr.', 'mei', 'jun.', 'jul.', 'aug.', 'sep.', 'okt.', 'nov.', 'dec.'];
const FR_MONTHS = ['janvier', 'f\u00e9vrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'ao\u00fbt', 'septembre', 'octobre', 'novembre', 'd\u00e9cembre'];
const EN_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const NL_MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
const FR_WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const EN_WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const NL_WEEKDAYS = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
/** The weekday (0 = Sunday) of a day of 2026. */
const weekday = (month: number, day: number): number => new Date(Date.UTC(2026, month - 1, day)).getUTCDay();

const FRENCH: Language = {
    subject: 'Tables de r\u00e9union - commande TEST-4821',
    client: { name: 'Claire Exemple', address: 'claire@client.test' },
    workshop: { name: 'Atelier Test (Meubles Test - Exemple)', address: 'atelier@meubles-exemple.test' },
    second: { name: 'Second Vendeur (Meubles Test - Exemple)', address: 'second@meubles-exemple.test' },
    office: 'bureau@client.test',
    forwardMarker: '---------- Message transf\u00e9r\u00e9 ----------',
    forwardLabels: ['De : ', 'Date : ', 'Objet : ', '\u00c0 : ', 'Cc :'],
    outlookLabels: ['De : ', 'Envoy\u00e9 : ', '\u00c0 : ', 'Cc : ', 'Objet : '],
    attribution: (day, time, mailbox, connector) =>
    {
        const dateText = connector ? `${day} \u00e0 ${time}` : `${day} ${time}`;
        return { line: `Le ${dateText}, ${mailbox} a \u00e9crit :`, dateText };
    },
    shortDay: (day, month) => `${day} ${FR_MONTHS_SHORT[month - 1] ?? '?'} 2026`,
    outlookDate: (month, day, hour, minute) => `${FR_WEEKDAYS[weekday(month, day)] ?? '?'} ${day} ${FR_MONTHS[month - 1] ?? '?'} 2026 ${two(hour)}:${two(minute)}`,
    signature: [
        'L\'\u00e9quipe de l\'Atelier Test',
        'Meubles Test - Exemple',
        'Mobilier de bureau sur mesure',
        'Zone artisanale Exemple, hall B',
        'Bo\u00eete postale 99',
        '0000 Villefictive',
        'Standard : +00 0 000 00 00',
        'Atelier : +00 0 000 00 99',
        'Horaires : 8 h - 12 h et 13 h - 17 h',
        'Ferm\u00e9 le week-end',
        'Visites de l\'atelier le mercredi',
        'Catalogue : www.catalogue-exemple.test',
        'Livraison offerte d\u00e8s quatre meubles',
        'Merci de rappeler votre num\u00e9ro de commande.',
        'Pensez \u00e0 l\'environnement avant d\'imprimer ce courriel.',
    ],
    texts: {
        f2: ['Bonjour\nMerci pour ces explications, je regarde les plans ce soir.\nJe vous rappelle demain matin pour fixer la date.', 'Bien \u00e0 vous'],
        a1: [
            'Ch\u00e8re Madame,',
            'Je vous remercie pour votre message et pour les plans transmis ce lundi.',
            'Comme convenu, le devis d\u00e9finitif vous sera adress\u00e9 au plus tard dix jours avant la livraison. L\'acompte peut \u00eatre vers\u00e9 \u00e0 la commande.',
            'La livraison pourrait avoir lieu le jeudi 22 octobre \u00e0 10 heures dans vos bureaux, sous r\u00e9serve de la disponibilit\u00e9 du transporteur.',
            'Tr\u00e8s cordialement,',
        ],
        o1: [
            'Bonjour,',
            'Vous trouverez ci-joint le plan de la salle ainsi que le bon de commande sign\u00e9.',
            'Pouvez-vous me confirmer le montant exact de l\'acompte ?',
            'Merci d\'avance,\nClaire Exemple',
        ],
        a2: [
            'Ch\u00e8re Madame,',
            'Nous avons bien re\u00e7u votre accord sur le prix. Pour la suite, nous avons besoin du plan de la salle et du bon de commande sign\u00e9.',
            'Tr\u00e8s cordialement,',
        ],
        o2: ['Bonjour,', 'Je confirme mon accord sur le prix indiqu\u00e9 dans le devis.', 'Bien cordialement,\nClaire Exemple'],
        a3: ['Ch\u00e8re Madame,', 'Le transporteur nous a confirm\u00e9 ses tarifs. Pouvez-vous nous confirmer votre accord sur le prix total ?', 'Tr\u00e8s cordialement,'],
        o3: ['Bonjour Monsieur,', 'Avez-vous des nouvelles du transporteur concernant le prix ?', 'Merci,\nClaire Exemple'],
        a5: ['Petite pr\u00e9cision : je serai absente du 12 au 16 octobre.'],
        a7: [
            'Bonjour Monsieur,',
            'Suite \u00e0 notre entretien t\u00e9l\u00e9phonique, je vous confirme que nous souhaitons commander quatre tables de r\u00e9union.',
            'Pouvez-vous ouvrir un dossier \u00e0 notre nom ?',
            'Bien \u00e0 vous,\nClaire Exemple',
        ],
        a8: [
            'Ch\u00e8re Madame,',
            'Je fais suite \u00e0 votre appel. Je vous propose un premier rendez-vous dans notre atelier pour discuter de votre commande.',
            'Tr\u00e8s cordialement,',
        ],
    },
};

const ENGLISH: Language = {
    subject: 'Meeting tables - order TEST-4821',
    client: { name: 'Claire Example', address: 'claire@client.test' },
    workshop: { name: 'Workshop Test (Furniture Test - Example)', address: 'workshop@furniture-example.test' },
    second: { name: 'Second Seller (Furniture Test - Example)', address: 'second@furniture-example.test' },
    office: 'office@client.test',
    forwardMarker: '---------- Forwarded message ---------',
    forwardLabels: ['From: ', 'Date: ', 'Subject: ', 'To: ', 'Cc:'],
    outlookLabels: ['From: ', 'Sent: ', 'To: ', 'Cc: ', 'Subject: '],
    attribution: (day, time, mailbox, connector) =>
    {
        const dateText = connector ? `${day}, at ${time}` : `${day} ${time}`;
        return { line: `On ${dateText}, ${mailbox} wrote:`, dateText };
    },
    shortDay: (day, month) => `${day} ${EN_MONTHS_SHORT[month - 1] ?? '?'} 2026`,
    outlookDate: (month, day, hour, minute) =>
        `${EN_WEEKDAYS[weekday(month, day)] ?? '?'}, ${EN_MONTHS[month - 1] ?? '?'} ${day}, 2026 ${hour % 12 === 0 ? 12 : hour % 12}:${two(minute)} ${hour < 12 ? 'AM' : 'PM'}`,
    signature: [
        'The Workshop Test team',
        'Furniture Test - Example',
        'Made-to-measure office furniture',
        'Example craft park, hall B',
        'PO Box 99',
        '0000 Fictive Town',
        'Switchboard: +00 0 000 00 00',
        'Workshop: +00 0 000 00 99',
        'Hours: 8 am - 12 noon and 1 pm - 5 pm',
        'Closed at weekends',
        'Workshop visits on Wednesdays',
        'Catalogue: www.catalogue-example.test',
        'Free delivery from four pieces',
        'Please quote your order number.',
        'Please consider the environment before printing this email.',
    ],
    texts: {
        f2: ['Hello\nThank you for explaining, I will read the plans tonight.\nI will call you tomorrow morning to set the date.', 'Kind regards'],
        a1: [
            'Dear Madam,',
            'Thank you for your message and for the plans sent on Monday.',
            'As agreed, the final quote will be sent to you at least ten days before the delivery. The deposit can be paid with the order.',
            'The delivery could take place on Thursday 22 October at 10 o\'clock at your office, if the carrier is free.',
            'Best regards,',
        ],
        o1: [
            'Hello,',
            'Please find attached the plan of the room and the signed order form.',
            'Could you confirm the exact amount of the deposit?',
            'Thanks in advance,\nClaire Example',
        ],
        a2: [
            'Dear Madam,',
            'We have received your agreement on the price. Next, we need the plan of the room and the signed order form.',
            'Best regards,',
        ],
        o2: ['Hello,', 'I confirm that I agree with the price in the quote.', 'Kind regards,\nClaire Example'],
        a3: ['Dear Madam,', 'The carrier has confirmed its rates. Could you confirm that you agree with the total price?', 'Best regards,'],
        o3: ['Hello,', 'Do you have any news from the carrier about the price?', 'Thanks,\nClaire Example'],
        a5: ['One more thing: I will be away from 12 to 16 October.'],
        a7: [
            'Hello,',
            'Further to our phone call, I confirm that we wish to order four meeting tables.',
            'Could you open a file in our name?',
            'Kind regards,\nClaire Example',
        ],
        a8: ['Dear Madam,', 'Further to your call, I suggest a first meeting at our workshop to discuss your order.', 'Best regards,'],
    },
};

const DUTCH: Language = {
    subject: 'Vergadertafels - bestelling TEST-4821',
    client: { name: 'Claire Voorbeeld', address: 'claire@client.test' },
    workshop: { name: 'Werkplaats Test (Meubelen Test - Voorbeeld)', address: 'werkplaats@meubelen-voorbeeld.test' },
    second: { name: 'Tweede Verkoper (Meubelen Test - Voorbeeld)', address: 'tweede@meubelen-voorbeeld.test' },
    office: 'kantoor@client.test',
    forwardMarker: '---------- Doorgestuurd bericht ---------',
    forwardLabels: ['Van: ', 'Datum: ', 'Onderwerp: ', 'Aan: ', 'CC:'],
    outlookLabels: ['Van: ', 'Verzonden: ', 'Aan: ', 'CC: ', 'Onderwerp: '],
    attribution: (day, time, mailbox, connector) =>
    {
        const dateText = connector ? `${day} om ${time}` : `${day} ${time}`;
        return { line: `Op ${dateText} heeft ${mailbox} het volgende geschreven:`, dateText };
    },
    shortDay: (day, month) => `${day} ${NL_MONTHS_SHORT[month - 1] ?? '?'} 2026`,
    outlookDate: (month, day, hour, minute) => `${NL_WEEKDAYS[weekday(month, day)] ?? '?'} ${day} ${NL_MONTHS[month - 1] ?? '?'} 2026 ${two(hour)}:${two(minute)}`,
    signature: [
        'Het team van Werkplaats Test',
        'Meubelen Test - Voorbeeld',
        'Kantoormeubelen op maat',
        'Ambachtelijke zone Voorbeeld, hal B',
        'Postbus 99',
        '0000 Verzonnenstad',
        'Centrale: +00 0 000 00 00',
        'Werkplaats: +00 0 000 00 99',
        'Openingsuren: 8 - 12 uur en 13 - 17 uur',
        'Gesloten in het weekend',
        'Bezoek aan de werkplaats op woensdag',
        'Catalogus: www.catalogus-voorbeeld.test',
        'Gratis levering vanaf vier meubelen',
        'Vermeld altijd uw bestelnummer.',
        'Denk aan het milieu voor u deze e-mail afdrukt.',
    ],
    texts: {
        f2: ['Hallo\nBedankt voor de uitleg, ik bekijk de plannen vanavond.\nIk bel u morgenochtend om de datum vast te leggen.', 'Met vriendelijke groet'],
        a1: [
            'Geachte mevrouw,',
            'Bedankt voor uw bericht en voor de plannen die u maandag stuurde.',
            'Zoals afgesproken ontvangt u de definitieve offerte ten minste tien dagen voor de levering. Het voorschot kan bij de bestelling worden betaald.',
            'De levering kan plaatsvinden op donderdag 22 oktober om 10 uur op uw kantoor, als de vervoerder beschikbaar is.',
            'Met vriendelijke groeten,',
        ],
        o1: [
            'Hallo,',
            'In de bijlage vindt u het plan van de zaal en de ondertekende bestelbon.',
            'Kunt u het juiste bedrag van het voorschot bevestigen?',
            'Alvast bedankt,\nClaire Voorbeeld',
        ],
        a2: [
            'Geachte mevrouw,',
            'Wij hebben uw akkoord over de prijs ontvangen. Nu hebben wij het plan van de zaal en de ondertekende bestelbon nodig.',
            'Met vriendelijke groeten,',
        ],
        o2: ['Hallo,', 'Ik bevestig mijn akkoord met de prijs in de offerte.', 'Met vriendelijke groet,\nClaire Voorbeeld'],
        a3: ['Geachte mevrouw,', 'De vervoerder heeft zijn tarieven bevestigd. Kunt u uw akkoord over de totale prijs bevestigen?', 'Met vriendelijke groeten,'],
        o3: ['Hallo,', 'Hebt u nieuws van de vervoerder over de prijs?', 'Bedankt,\nClaire Voorbeeld'],
        a5: ['Nog iets: ik ben afwezig van 12 tot 16 oktober.'],
        a7: [
            'Hallo,',
            'Naar aanleiding van ons telefoongesprek bevestig ik dat wij vier vergadertafels willen bestellen.',
            'Kunt u een dossier op onze naam openen?',
            'Met vriendelijke groet,\nClaire Voorbeeld',
        ],
        a8: ['Geachte mevrouw,', 'Naar aanleiding van uw telefoontje stel ik een eerste afspraak in onze werkplaats voor om uw bestelling te bespreken.', 'Met vriendelijke groeten,'],
    },
};

const LANGUAGES: Readonly<Record<'fr' | 'en' | 'nl', Language>> = { fr: FRENCH, en: ENGLISH, nl: DUTCH };

const squashed = (text: string): string => text.replace(/\s+/gu, ' ').trim();

/** The 13 earlier emails of the shape in one form, newest first, with the words a fixture writer needs. */
export function phoneForwardParts(form: PhoneForwardForm): PhoneForwardParts
{
    const lang = LANGUAGES[form.slice(0, 2) as 'fr' | 'en' | 'nl'];
    const connector = form === 'fr-a' || form === 'en' || form === 'nl';
    const client: EmailAddress = lang.client;
    const workshop: EmailAddress = lang.workshop;
    const second: EmailAddress = lang.second;
    const clientBox = `${client.name} <${client.address}>`;
    // The phone writes the workshop's name in quotes with a space before the closing quote.
    const workshopQuoted = `"${workshop.name} " <${workshop.address}>`;
    const workshopPlain = `${workshop.name} <${workshop.address}>`;
    const re = `RE: ${lang.subject}`;
    const reLower = `Re: ${lang.subject}`;
    const forwarded = `Fwd: ${re}`;
    const [fromLabel, dateLabel, subjectLabel, toLabel, ccLabel] = lang.forwardLabels;
    const [outFrom, outSent, outTo, outCc, outSubject] = lang.outlookLabels;
    const wall = (month: number, day: number, hour: number, minute: number): string => `2026-${two(month)}-${two(day)}T${two(hour)}:${two(minute)}`;
    const firstLine = (paragraph: string | undefined): string => squashed((paragraph ?? '').split('\n')[0] ?? '');
    const lastLine = (paragraph: string | undefined): string => squashed((paragraph ?? '').split('\n').pop() ?? '');

    const forward = (month: number, day: number, hour: number, minute: number, subject: string, to: EmailAddress, toWritten: string,
        body: readonly string[]): PhoneForwardPart =>
    {
        const dateText = `${lang.shortDay(day, month)} ${two(hour)}:${two(minute)}`;
        const ends = body.length === 0 ? { first: '', last: '' } : { first: firstLine(body[0]), last: squashed(body[body.length - 1] ?? '') };
        return {
            shape: 'forward',
            byWorkshop: false,
            head: [lang.forwardMarker, `${fromLabel}${clientBox}`, `${dateLabel}${dateText}`, `${subjectLabel}${subject}`, `${toLabel}${toWritten}`, ccLabel],
            body,
            expected: { kind: 'forward', from: client, to: [to], cc: [], dateText, wall: wall(month, day, hour, minute), subject, subjectFromChain: false,
                noOwnText: body.length === 0, ...ends },
        };
    };
    const outlook = (month: number, day: number, hour: number, minute: number, subject: string, body: readonly string[],
        withCc: boolean): PhoneForwardPart =>
    {
        const dateText = lang.outlookDate(month, day, hour, minute);
        const head = [`${outFrom}${clientBox}`, `${outSent}${dateText}`, `${outTo}${workshopPlain}`];
        if (withCc)
        {
            head.push(`${outCc}"${second.name}" <${second.address}>`);
        }
        head.push(`${outSubject}${subject}`);
        return {
            shape: 'outlook',
            byWorkshop: false,
            head,
            body,
            expected: { kind: 'reply', from: client, to: [workshop], cc: withCc ? [second] : [], dateText, wall: wall(month, day, hour, minute), subject,
                subjectFromChain: false, noOwnText: false, first: firstLine(body[0]), last: lastLine(body[body.length - 1]) },
        };
    };
    const attribution = (who: 'client' | 'workshop', month: number, day: number, hour: number, minute: number, subject: string,
        own: readonly string[]): PhoneForwardPart =>
    {
        const byWorkshop = who === 'workshop';
        const { line, dateText } = lang.attribution(lang.shortDay(day, month), `${two(hour)}:${two(minute)}`, byWorkshop ? workshopQuoted : clientBox, connector);
        const signed = byWorkshop && own.length > 0;
        const body = signed ? [...own, ...lang.signature] : own;
        const ends = body.length === 0 ? { first: '', last: '' } : { first: firstLine(body[0]), last: lastLine(body[body.length - 1]) };
        return {
            shape: 'attribution',
            byWorkshop,
            head: [line],
            body,
            expected: { kind: 'reply', from: byWorkshop ? workshop : client, to: [], cc: [], dateText, wall: wall(month, day, hour, minute), subject,
                subjectFromChain: true, noOwnText: body.length === 0, ...ends },
        };
    };

    const t = lang.texts;
    const parts: PhoneForwardPart[] = [
        forward(11, 17, 19, 23, forwarded, { name: '', address: lang.office }, lang.office, []),
        forward(10, 6, 13, 58, re, workshop, workshopQuoted, t.f2),
        attribution('workshop', 10, 6, 9, 34, re, t.a1),
        outlook(10, 5, 20, 7, re, t.o1, false),
        attribution('workshop', 10, 2, 16, 21, re, t.a2),
        outlook(10, 1, 18, 52, re, t.o2, false),
        attribution('workshop', 10, 1, 11, 15, re, t.a3),
        outlook(9, 30, 22, 38, reLower, t.o3, true),
        attribution('client', 9, 27, 8, 31, reLower, []),
        attribution('client', 9, 27, 8, 27, reLower, t.a5),
        attribution('client', 7, 14, 16, 53, reLower, []),
        attribution('client', 7, 14, 16, 53, reLower, t.a7),
        attribution('workshop', 7, 8, 11, 36, reLower, t.a8),
    ];
    return { subject: forwarded, client, workshop, second, office: lang.office, parts };
}

/** Builds the body of the forwarding email in one form, with the expected rebuilt emails. */
export function phoneForwardThread(form: PhoneForwardForm): PhoneForwardThread
{
    const { subject, parts } = phoneForwardParts(form);
    // Each part: its header lines together, then its paragraphs, a blank line between them.
    const body = `${parts.map((p) => [p.head.join('\n'), ...p.body].join('\n\n')).join('\n\n')}\n`;
    return { body, subject, expected: parts.map((p) => p.expected) };
}

/** `text` with every run of white space made one space, trimmed (how the tests compare rebuilt texts). */
export function squashWhiteSpace(text: string): string
{
    return squashed(text);
}
