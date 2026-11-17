// Unit tests for reply-header detection (README.md, rule R7). All text is
// synthetic. Non-ASCII letters are written as \u escapes (files stay ASCII).

import { describe, expect, it } from 'vitest';
import { createEmlParser } from '../email-reading/eml';
import { FORWARDED_SEPARATOR } from '../email-reading/forwarded-block';
import { htmlTreeToText, type HtmlNode, type HtmlToTextResult } from '../email-reading/html-to-text';
import {
    ATTRIBUTION_MAX_LENGTH,
    detectReplyHeaders,
    findReplyHeaders,
    isForwardSubject,
    MIN_HEADER_LINES,
} from './reply-header';
import { buildSegments, checkSegments, reconstruct, type FoldRange } from './segments';

/** Joins lines with "\n" (no trailing line break). */
const lines = (...l: string[]): string => l.join('\n');

/** Runs the detector and checks the invariants every result must keep. */
function detect(body: string, subject?: string): FoldRange[]
{
    const copy = `${body}`;
    const folds = detectReplyHeaders(body, subject);
    expect(body).toBe(copy); // never modified
    expect(detectReplyHeaders(body, subject)).toEqual(folds); // deterministic
    for (const f of folds)
    {
        expect(f.reason).toBe('reply-header');
        expect(f.related).toBeUndefined();
        expect(f.start).toBeLessThan(f.end);
    }
    const segments = buildSegments(body, folds);
    expect(checkSegments(body, segments)).toEqual([]);
    expect(reconstruct(body, segments)).toBe(body);
    return folds;
}

/** The folded text pieces, in order. */
function foldedTexts(body: string, subject?: string): string[]
{
    return buildSegments(body, detect(body, subject))
        .filter((s) => s.folded)
        .map((s) => body.slice(s.start, s.end));
}

/** Everything from `snippet` (first occurrence) to the end of the body. */
const fromHere = (body: string, snippet: string): string =>
{
    const at = body.indexOf(snippet);
    if (at < 0)
    {
        throw new Error(`snippet not found: ${snippet}`);
    }
    return body.slice(at);
};

const QUOTE = ['> Hello Alice,', '>', '> The desks arrive on Thursday.', '> Bob'];

describe('detectReplyHeaders: attribution lines', () =>
{
    const cases: [string, string][] = [
        ['en', 'On Mon, 3 Mar 2025 at 14:02, Bob Sample <bob@example.test> wrote:'],
        ['fr', 'Le lun. 3 mars 2025 \u00e0 14:02, Bob Sample <bob@example.test> a \u00e9crit :'],
        ['nl', 'Op ma 3 mrt 2025 om 14:02 schreef Bob Sample <bob@example.test>:'],
        ['en Apple', 'On 4 Mar 2025, at 11:20, Carol Test <carol@example.test> wrote:'],
        ['fr Apple', 'Le 4 mars 2025 \u00e0 11:20, Carol Test <carol@example.test> a \u00e9crit :'],
        ['nl Apple', 'Op 4 mrt. 2025 om 11:20 heeft Carol Test <carol@example.test> het volgende geschreven:'],
    ];

    for (const [lang, attribution] of cases)
    {
        it(`${lang}: folds the attribution and its ">" block; a reply below the quote stays shown`, () =>
        {
            const body = lines('Thanks, see my answer below.', '', attribution, ...QUOTE, '', 'Bottom-posted answer.', 'Alice');
            expect(foldedTexts(body)).toEqual([`${lines(attribution, ...QUOTE)}\n`]);
        });
    }

    const wrapped: [string, string, string][] = [
        ['en', 'On Mon, 3 Mar 2025 at 14:02, Bob Sample <', 'bob@example.test> wrote:'],
        ['fr', 'Le lun. 3 mars 2025 \u00e0 14:02, Bob Sample <bob@example.test> a', '\u00e9crit :'],
        ['nl', 'Op ma 3 mrt 2025 om 14:02 schreef Bob Sample <', 'bob@example.test>:'],
    ];
    for (const [lang, a, b] of wrapped)
    {
        it(`${lang}: an attribution wrapped over two lines folds both lines with the quote`, () =>
        {
            const body = lines('New text on top.', '', a, b, ...QUOTE, '', 'More new text.');
            expect(foldedTexts(body)).toEqual([`${lines(a, b, ...QUOTE)}\n`]);
        });
    }

    it('blank lines between the attribution and the quote are folded with them', () =>
    {
        const body = lines('Top.', 'On Tue, Bob Sample <bob@example.test> wrote:', '', '', ...QUOTE, 'After.');
        expect(foldedTexts(body)).toEqual([`${lines('On Tue, Bob Sample <bob@example.test> wrote:', '', '', ...QUOTE)}\n`]);
    });

    it('a strong attribution without a ">" quote folds alone; the text after it stays shown', () =>
    {
        const body = lines('Top.', '', 'On Tue, 4 Mar 2025, Bob Sample wrote:', '', 'Unmarked quoted text.');
        expect(foldedTexts(body)).toEqual(['On Tue, 4 Mar 2025, Bob Sample wrote:\n']);
    });

    it('"<name> wrote:" folds only when a ">" quote follows', () =>
    {
        expect(foldedTexts(lines('Bob Sample wrote:', ...QUOTE, 'Mine.'))).toEqual([`${lines('Bob Sample wrote:', ...QUOTE)}\n`]);
        expect(detect(lines('As Carol Test wrote:', 'the delivery is on time.'))).toEqual([]);
        expect(detect(lines('Carol schreef:', 'de levering is op tijd.'))).toEqual([]);
        expect(detect(lines('Carol a \u00e9crit :', 'la livraison est \u00e0 l\u2019heure.'))).toEqual([]);
    });

    it('an attribution inside a quote folds with its own ">" block, never the unquoted text after it', () =>
    {
        const body = lines(
            'My reply.',
            '',
            '> On 4 Mar 2025, at 11:20, Carol Test <carol@example.test> wrote:',
            '>',
            '> Bonjour Alice,',
            '> Les bureaux arrivent jeudi.',
            '',
            'Text after the quote.',
        );
        expect(foldedTexts(body)).toEqual([`${lines(...body.split('\n').slice(2, 6))}\n`]);
    });

    it('ordinary sentences are not attributions', () =>
    {
        expect(detect('On Monday I wrote: see below')).toEqual([]);
        expect(detect(lines('On Monday we met at the office.', 'It went well.'))).toEqual([]);
        expect(detect(lines('Le bureau est pr\u00eat.', 'Op maandag komt de levering.'))).toEqual([]);
        expect(detect(lines('He wrote: "the desks are fine" and left.', '> quoted', '> lines'))).toEqual([]);
    });

    it('a strong attribution without a ">" quote and without a digit, "@" or "<" stays shown (the sender\'s own story)', () =>
    {
        expect(detect(lines('On Monday I wrote:', 'the order is confirmed.', 'Alice'))).toEqual([]);
        expect(detect(lines('Some context.', 'On Monday, Bob wrote:', 'that he would come. I doubt it.', 'Alice'))).toEqual([]);
        expect(detect(lines('Souvenir :', 'Le lundi, Paul a \u00e9crit :', 'qu\u2019il viendrait.'))).toEqual([]);
        expect(detect(lines('Op maandag schreef Bob:', 'dat hij zou komen.'))).toEqual([]);
    });

    it('a strong attribution without a ">" quote folds alone when it holds a digit, "@" or "<"', () =>
    {
        for (const attribution of [
            'On 3 March, Bob wrote:',
            'On Monday, bob@example.test wrote:',
            'On Monday, Bob <bob wrote:',
            'Le 3 mars, Paul a \u00e9crit :',
        ])
        {
            const body = lines('Top.', attribution, 'Unmarked quoted text.');
            expect(foldedTexts(body)).toEqual([`${attribution}\n`]);
        }
    });

    it('with a ">" quote after it, a strong attribution folds even without a digit or address', () =>
    {
        const body = lines('On Monday, Bob wrote:', '> I will come', 'He did not come.');
        expect(foldedTexts(body)).toEqual([`${lines('On Monday, Bob wrote:', '> I will come')}\n`]);
    });

    it(`a line longer than ATTRIBUTION_MAX_LENGTH (${ATTRIBUTION_MAX_LENGTH}) is never an attribution`, () =>
    {
        const long = `On Monday ${'and then something else '.repeat(15)}I wrote:`;
        expect(long.length).toBeGreaterThan(ATTRIBUTION_MAX_LENGTH);
        expect(detect(lines(long, ...QUOTE))).toEqual([]);
    });

    it('two lines wrap only when the first starts with the opener', () =>
    {
        expect(detect(lines('We discussed it and', 'Bob Sample <bob@example.test> wrote:', 'normal text'))).toEqual([]);
    });

    it('tolerates nbsp, extra spaces and upper case', () =>
    {
        const attribution = '  ON Mon,\u00a03 Mar 2025, Bob Sample\u00a0WROTE\u00a0:  ';
        const body = lines('Top.', attribution, ...QUOTE);
        expect(foldedTexts(body)).toEqual([lines(attribution, ...QUOTE)]);
    });
});

describe('detectReplyHeaders: Outlook header blocks (replies fold to the end)', () =>
{
    const blocks: [string, string[]][] = [
        [
            'en',
            [
                'From: Alice Example <alice@example.test>',
                'Sent: Monday, March 3, 2025 9:15 AM',
                'To: Bob Sample <bob@example.test>',
                'Subject: Office desks',
            ],
        ],
        [
            'fr',
            [
                'De : Carol Test <carol@example.test>',
                'Envoy\u00e9 : mardi 4 mars 2025 14:31',
                '\u00c0 : Alice Example <alice@example.test>',
                'Cc : Bob Sample <bob@example.test>',
                'Objet : Re: Livraison des bureaux',
            ],
        ],
        [
            'nl',
            [
                'Van: Alice Example <alice@example.test>',
                'Verzonden: woensdag 2 april 2025 14:15',
                'Aan: Bob Sample <bob@example.test>',
                'Onderwerp: RE: Offerte vergadertafel',
            ],
        ],
    ];
    const separators: Record<string, string> = {
        en: '-----Original Message-----',
        fr: "----- Message d'origine -----",
        nl: '-----Oorspronkelijk bericht-----',
    };

    for (const [lang, header] of blocks)
    {
        const quoted = ['', 'Quoted text of the earlier message.', '', '-- ', 'Signature'];

        it(`${lang}: a plain block folds from its first line to the end`, () =>
        {
            const body = lines('Reply on top.', '', 'Alice', '', ...header, ...quoted);
            expect(foldedTexts(body, 'Re: Office desks')).toEqual([fromHere(body, header[0] ?? '')]);
        });

        it(`${lang}: Outlook's row of underscores is folded with the block`, () =>
        {
            const body = lines('Reply on top.', '', '________________________________', ...header, ...quoted);
            expect(foldedTexts(body)).toEqual([fromHere(body, '____')]);
        });

        it(`${lang}: an "original message" separator is folded with the block`, () =>
        {
            const separator = separators[lang] ?? '';
            const body = lines('Reply on top.', '', separator, ...header, ...quoted);
            expect(foldedTexts(body)).toEqual([fromHere(body, separator)]);
        });

        it(`${lang}: CRLF line breaks work the same`, () =>
        {
            const body = ['Reply on top.', '', ...header, ...quoted].join('\r\n');
            expect(foldedTexts(body)).toEqual([fromHere(body, header[0] ?? '')]);
        });
    }

    it('accepts labels written as "*Label:*", with nbsp, and "Date" for the sent line', () =>
    {
        const body = lines(
            'Top.',
            '*From:* Alice Example <alice@example.test>',
            '*Date:* Monday, March 3, 2025 9:15 AM',
            '*To:* Bob Sample <bob@example.test>',
            'Quoted.',
        );
        expect(foldedTexts(body)).toEqual([fromHere(body, '*From:*')]);
        const fr = lines('Haut.', 'De\u00a0: Carol', 'Envoy\u00e9\u00a0: mardi 4 mars 2025', 'Objet\u00a0: Livraison', 'Cit\u00e9.');
        expect(foldedTexts(fr)).toEqual([fromHere(fr, 'De\u00a0:')]);
    });

    it('accepts the French "Envoye" without its accent', () =>
    {
        const body = lines('Haut.', 'De : Carol <carol@example.test>', 'Envoye : mardi 4 mars 2025 14:31', 'A : Alice', 'Objet : y', '', 'Vieux.');
        expect(foldedTexts(body)).toEqual([fromHere(body, 'De :')]);
    });

    it('folds the block as the HTML converter writes an Outlook reply', () =>
    {
        // Outlook's HTML: a rule, then bold labels separated by <br>, in a div.
        const text = (value: string): HtmlNode => ({ nodeType: 3, nodeName: '#text', nodeValue: value, childNodes: [] });
        const el = (name: string, ...children: (HtmlNode | string)[]): HtmlNode => ({
            nodeType: 1,
            nodeName: name.toUpperCase(),
            nodeValue: null,
            childNodes: children.map((c) => (typeof c === 'string' ? text(c) : c)),
            getAttribute: () => null,
        });
        const label = (name: string, value: string): (HtmlNode | string)[] => [el('b', name), value, el('br')];
        const root: HtmlNode = {
            nodeType: 9,
            nodeName: '#document',
            nodeValue: null,
            childNodes: [
                el(
                    'body',
                    el('p', 'Reply on top.'),
                    el(
                        'div',
                        el('hr'),
                        el(
                            'p',
                            ...label('Van:', ' Alice Example <alice@example.test>'),
                            ...label('Verzonden:', '\u00a0woensdag 2 april 2025 14:15'),
                            ...label('Aan:', ' Bob Sample <bob@example.test>'),
                            el('b', 'Onderwerp:'),
                            ' Offerte',
                        ),
                        el('p', 'Quoted text.'),
                    ),
                ),
            ],
        };
        const body = htmlTreeToText(root).text;
        expect(body).toContain('Van: Alice Example');
        expect(foldedTexts(body)).toEqual([fromHere(body, 'Van:')]);
    });

    it('a block inside a ">" quote folds only to the end of that quote', () =>
    {
        const body = lines(
            'Top.',
            '> ________________________________',
            '> From: Alice Example <alice@example.test>',
            '> Sent: Monday, March 3, 2025 9:15 AM',
            '> Subject: Desks',
            '>',
            '> Quoted text.',
            '',
            'Text after the quote.',
        );
        expect(foldedTexts(body)).toEqual([`${lines(...body.split('\n').slice(1, 7))}\n`]);
    });

    it('the end-of-body fold stops before a forwarded block written by the .eml adapter', () =>
    {
        const body = lines(
            'Top.',
            'From: Alice <alice@example.test>',
            'Sent: Monday',
            'To: Bob',
            'Quoted.',
            '',
            FORWARDED_SEPARATOR,
            'From: Carol Test <carol@example.test>',
            'Subject: Catalogue',
            '',
            'Forwarded text.',
        );
        expect(foldedTexts(body)).toEqual([`${lines('From: Alice <alice@example.test>', 'Sent: Monday', 'To: Bob', 'Quoted.', '')}\n`]);
    });

    it(`label-like lines in normal text are not a block (fewer than ${MIN_HEADER_LINES}, no From first, no date)`, () =>
    {
        expect(detect(lines('From: the warehouse, 3 boxes', 'To: the office', 'Thanks.'))).toEqual([]);
        expect(detect(lines('From: the warehouse', 'To: the office', 'Subject: chairs', 'Cc: nobody'))).toEqual([]);
        expect(detect(lines('Sent: Monday', 'From: Alice', 'To: Bob', 'Subject: x'))).toEqual([]);
        expect(detect(lines('From: Alice', 'Sent: Monday', 'Cc: Carol'))).toEqual([]);
    });

    describe('a block without an intro needs an address or a date with a year or time', () =>
    {
        const negatives: [string, string][] = [
            [
                'en label',
                lines(
                    'Here is the label I need printed:',
                    'From: the warehouse',
                    'Date: Monday',
                    'To: the office',
                    '',
                    'Please send it by Friday, it is URGENT.',
                    'Alice',
                ),
            ],
            [
                'en letter',
                lines('I got a letter:', 'From: Tax office', 'Date: 3 March', 'Subject: overdue payment', 'They want 300 EUR. What do I do?'),
            ],
            [
                'fr letter',
                lines('Voici le courrier :', 'De : la mairie', 'Date : lundi', 'Objet : permis', 'Ils demandent un papier. Tu peux m\u2019aider ?'),
            ],
            ['fr Envoye', lines('Le formulaire :', 'De : la mairie', 'Envoy\u00e9 : lundi 3 mars', '\u00c0 : la pr\u00e9fecture', 'Merci de r\u00e9pondre.')],
            ['nl form', lines('Formulier:', 'Van: het archief', 'Datum: maandag', 'Aan: de balie', 'Graag bevestigen. Groet, Alice')],
            ['nl Verzonden', lines('Het briefje:', 'Van: de gemeente', 'Verzonden: dinsdag', 'Onderwerp: vergunning', 'Wat moet ik doen?')],
            ['inside a ">" quote', lines('Top.', '> From: the warehouse', '> Date: Monday', '> To: the office', '> Send it Friday.', 'Mine.')],
        ];
        for (const [name, body] of negatives)
        {
            it(`${name}: the whole body stays shown`, () =>
            {
                expect(detect(body)).toEqual([]);
            });
        }

        const positives: [string, string[]][] = [
            ['address in From', ['From: Alice Example <alice@example.test>', 'Date: Monday', 'To: the office']],
            ['mailto in To', ['From: Alice Example', 'Sent: Monday', 'To: Bob Sample [mailto:bob@example.test]', 'Subject: x']],
            ['address in Cc', ['Van: Alice', 'Verzonden: maandag', 'Cc: bob@example.test', 'Aan: Bob']],
            // Blind-copy labels (their own `bcc` list in reply-patterns.ts) count exactly like Cc.
            ['address in Bcc', ['From: Alice', 'Sent: Monday', 'Bcc: bob@example.test', 'To: Bob']],
            ['address in Cci', ['De : Alice', 'Envoy\u00e9 : lundi', 'Cci : bob@example.test', 'Objet : x']],
            ['address in BCC', ['Van: Alice', 'Verzonden: maandag', 'BCC: bob@example.test', 'Aan: Bob']],
            ['year in Date', ['De : la mairie', 'Date : lundi 3 mars 2025', 'Objet : permis']],
            ['time in Sent', ['From: the warehouse', 'Sent: Monday 9:15 AM', 'To: the office']],
        ];
        for (const [name, header] of positives)
        {
            it(`${name}: folds to the end`, () =>
            {
                const body = lines('Reply on top.', '', ...header, '', 'Older text.');
                expect(foldedTexts(body)).toEqual([fromHere(body, header[0] ?? '')]);
            });
        }

        it('inside a ">" quote, with an address: folds to the end of the quote', () =>
        {
            const body = lines('Top.', '> From: Alice <alice@example.test>', '> Date: Monday', '> To: Bob', '> Old.', 'Mine.');
            expect(foldedTexts(body)).toEqual([`${lines(...body.split('\n').slice(1, 5))}\n`]);
        });

        it('a 4-digit number in a From or To value is not a date; an address in the Date value is not an address', () =>
        {
            expect(detect(lines('From: room 1234', 'Date: Monday', 'To: room 5678', 'Text.'))).toEqual([]);
            expect(detect(lines('From: the warehouse', 'Date: ask desk@example.test', 'To: the office', 'Text.'))).toEqual([]);
        });

        it('with an intro, the shape alone is enough (unchanged)', () =>
        {
            const body = lines('Top.', '________________________________', 'From: the warehouse', 'Date: Monday', 'To: the office', 'Old.');
            expect(foldedTexts(body)).toEqual([fromHere(body, '____')]);
        });
    });

    it('a row of underscores alone stays shown', () =>
    {
        expect(detect(lines('Alice', '________________________________', 'Example Ltd (fictional)'))).toEqual([]);
    });

    it('a separator alone folds alone; with a From label after it, it folds to the end', () =>
    {
        const alone = lines('Top.', '-----Original Message-----', 'Some text.');
        expect(foldedTexts(alone)).toEqual(['-----Original Message-----\n']);
        const short = lines('Top.', '-----Original Message-----', 'From: Alice', 'Sent: Monday', '', 'Quoted.');
        expect(foldedTexts(short)).toEqual([fromHere(short, '-----Original')]);
    });
});

describe('detectReplyHeaders: forwards fold the header lines only', () =>
{
    const header = ['From: Alice Example <alice@example.test>', 'Date: Mon, 3 Mar 2025 at 09:15', 'Subject: Desks', 'To: Bob Sample <bob@example.test>'];
    const content = ['', 'The forwarded message, which the reader needs.', 'Alice'];

    const markers: [string, string, string[]][] = [
        ['Gmail en', '---------- Forwarded message ---------', header],
        ['Gmail fr', '---------- Message transf\u00e9r\u00e9 ---------', ['De : Alice', 'Date : lun. 3 mars 2025', 'Objet : Bureaux', '\u00c0 : Bob']],
        ['Gmail nl', '---------- Doorgestuurd bericht ---------', ['Van: Alice', 'Date: ma 3 mrt 2025', 'Subject: Bureaus', 'To: Bob']],
    ];
    for (const [name, marker, labels] of markers)
    {
        it(`${name}: marker + header lines folded, content shown`, () =>
        {
            const body = lines('FYI, see below.', '', marker, ...labels, ...content);
            expect(foldedTexts(body)).toEqual([`${lines(marker, ...labels)}
`]);
        });
    }

    const apple: [string, string][] = [
        ['en', 'Begin forwarded message:'],
        ['fr', 'D\u00e9but du message r\u00e9exp\u00e9di\u00e9 :'],
        ['nl', 'Begin doorgestuurd bericht:'],
    ];
    for (const [lang, marker] of apple)
    {
        it(`Apple ${lang}: marker, blank line and header lines folded, content shown`, () =>
        {
            const body = lines('FYI.', '', marker, '', ...header, ...content);
            expect(foldedTexts(body)).toEqual([`${lines(marker, '', ...header)}
`]);
        });
    }

    for (const subject of ['FW: Desks', 'Fwd: Desks', 'TR: Bureaux', 'Doorst: Bureaus', 'fw:Desks'])
    {
        it(`subject "${subject}": an Outlook block folds its separator and labels only`, () =>
        {
            const outlook = ['________________________________', 'From: Alice', 'Sent: Monday', 'To: Bob', 'Subject: Desks'];
            const body = lines('FYI.', '', ...outlook, ...content);
            expect(foldedTexts(body, subject)).toEqual([`${lines(...outlook)}
`]);
        });
    }

    it('the subject rule covers the first block only; the forwarded message\'s own reply block folds to the end', () =>
    {
        const body = lines(
            'FYI.',
            '-----Original Message-----',
            'From: Alice',
            'Sent: Tuesday',
            'To: Bob',
            '',
            'Forwarded reply text.',
            '',
            'From: Bob <bob@example.test>',
            'Sent: Monday',
            'To: Alice',
            '',
            'Older history.',
        );
        expect(foldedTexts(body, 'FW: Desks')).toEqual([
            `${lines('-----Original Message-----', 'From: Alice', 'Sent: Tuesday', 'To: Bob')}
`,
            fromHere(body, 'From: Bob'),
        ]);
    });

    for (const subject of ['[EXT] FW: Desks', '[External] TR: Bureaux', '[EXT] [Partner] Fwd: Desks', ' [ext]Doorst: Bureaus'])
    {
        it(`subject "${subject}": leading tags are skipped, it is a forward`, () =>
        {
            expect(isForwardSubject(subject)).toBe(true);
            const outlook = ['________________________________', 'From: Alice', 'Sent: Monday', 'To: Bob', 'Subject: Desks'];
            const body = lines('FYI.', '', ...outlook, '', 'The forwarded message.');
            expect(foldedTexts(body, subject)).toEqual([`${lines(...outlook)}\n`]);
        });
    }

    it('a tag alone or a tag before a reply prefix is not a forward', () =>
    {
        expect(isForwardSubject('[EXT] Desks')).toBe(false);
        expect(isForwardSubject('[EXT] RE: FW: Desks')).toBe(false);
        expect(isForwardSubject('[FW: Desks')).toBe(false);
    });

    it('a reply subject ("RE: FW: ...") is not a forward', () =>
    {
        expect(isForwardSubject('RE: FW: Desks')).toBe(false);
        expect(isForwardSubject('Fwd: Desks')).toBe(true);
        expect(isForwardSubject('Forward planning')).toBe(false);
        expect(isForwardSubject(undefined)).toBe(false);
        expect(isForwardSubject(42)).toBe(false);
    });

    it('a forward marker alone folds alone', () =>
    {
        expect(foldedTexts(lines('FYI.', 'Begin forwarded message:', '', 'Text.'))).toEqual(['Begin forwarded message:\n']);
    });
});

describe('detectReplyHeaders: the .eml adapter\'s own forwarded block', () =>
{
    const stub = (html: string): HtmlToTextResult => ({ text: `[stub] ${html.length}`, truncated: false });
    const parser = createEmlParser({ htmlToText: stub });
    const crlf = (...l: string[]): string => l.join('\r\n');

    /** A synthetic outer message with one inline forwarded message (all headers the block can show). */
    const eml = (subject: string, innerBody: string): Uint8Array =>
        new TextEncoder().encode(
            crlf(
                'From: Alice Example <alice@example.test>',
                'To: Bob Sample <bob@example.test>',
                `Subject: ${subject}`,
                'Date: Tue, 3 Jun 2025 14:05:09 +0200',
                'Message-ID: <outer@example.test>',
                'MIME-Version: 1.0',
                'Content-Type: multipart/mixed; boundary="fw"',
                '',
                '--fw',
                'Content-Type: text/plain; charset=utf-8',
                '',
                'See the message below.',
                '--fw',
                'Content-Type: message/rfc822',
                '',
                'From: Carol Test <carol@example.test>',
                'Sender: Dave Test <dave@example.test>',
                'Date: Mon, 2 Jun 2025 09:00:00 +0000',
                'Subject: Catalogue',
                'To: Alice Example <alice@example.test>',
                'Cc: Bob Sample <bob@example.test>',
                'Bcc: Erin Test <erin@example.test>',
                'Message-ID: <inner@example.test>',
                '',
                innerBody,
                '--fw--',
                '',
            ),
        );

    async function bodyOf(subject: string, innerBody: string): Promise<string>
    {
        const result = await parser.parse({ name: 'forward.eml', bytes: eml(subject, innerBody) });
        if (!result.ok)
        {
            throw new Error(result.detail);
        }
        return result.message.bodyText;
    }

    it('is never folded, whatever the subject', async () =>
    {
        const body = await bodyOf('Fwd: Catalogue', 'The spring catalogue is attached.');
        // The real adapter output, with every label it can write.
        const block = fromHere(body, FORWARDED_SEPARATOR).split('\n').slice(0, 8);
        expect(block.map((l) => l.split(':')[0])).toEqual([
            FORWARDED_SEPARATOR,
            'From',
            'Sender',
            'Date',
            'Subject',
            'To',
            'Cc',
            'Bcc',
        ]);
        expect(detect(body, 'Fwd: Catalogue')).toEqual([]);
        expect(detect(body, 'Catalogue')).toEqual([]);
    });

    it('a reply header inside the forwarded message is still detected', async () =>
    {
        const inner = crlf('Here it is.', '', 'On Sun, 1 Jun 2025, Alice Example <alice@example.test> wrote:', '> Can you send', '> the catalogue?');
        const body = await bodyOf('Fwd: Catalogue', inner);
        expect(foldedTexts(body, 'Fwd: Catalogue')).toEqual([
            lines('On Sun, 1 Jun 2025, Alice Example <alice@example.test> wrote:', '> Can you send', '> the catalogue?') +
                (body.endsWith('\n') ? '\n' : ''),
        ]);
    });

    it('the same separator inside a ">" quote is a normal forward marker', () =>
    {
        const body = lines('Top.', `> ${FORWARDED_SEPARATOR}`, '> From: Carol', '> Date: Monday', '> Subject: x', '>', '> Text.');
        expect(foldedTexts(body)).toEqual([`${lines(...body.split('\n').slice(1, 5))}\n`]);
    });
});

describe('detectReplyHeaders: robustness', () =>
{
    it('empty text and texts without headers give []', () =>
    {
        expect(detect('')).toEqual([]);
        expect(detect('\n\n  \n')).toEqual([]);
        expect(detect('Hello Bob,\n\nThe chairs are fine.\n\nAlice')).toEqual([]);
    });

    it('never throws on a non-string body', () =>
    {
        for (const bad of [undefined, null, 42, {}, ['On x wrote:']])
        {
            expect(detectReplyHeaders(bad as string)).toEqual([]);
        }
    });

    it('a non-string subject is ignored', () =>
    {
        const body = lines('Top.', 'Begin forwarded message:', 'From: A', 'Date: B', 'To: C', 'Content.');
        expect(detectReplyHeaders(body, 42 as unknown as string)).toEqual(detectReplyHeaders(body));
    });

    it('results are sorted by position', () =>
    {
        const body = lines(
            'Top.',
            'On Tue, Bob wrote:',
            ...QUOTE,
            'Middle.',
            '-----Original Message-----',
            'Unrelated.',
            'From: Alice <alice@example.test>',
            'Sent: Monday',
            'To: Bob',
            'Old.',
        );
        const folds = detect(body);
        expect(folds.length).toBe(3);
        expect(folds.map((f) => f.start)).toEqual([...folds.map((f) => f.start)].sort((a, b) => a - b));
    });

    it('a very long body without line breaks is handled quickly', () =>
    {
        const body = `${'word '.repeat(200_000)}wrote:`;
        expect(detect(body)).toEqual([]);
    });

    // Linear cost: a run of label lines that is not a block is scanned once,
    // not once per From line in it. The budget is generous for slow CI runners
    // (a quadratic scan took many seconds for 10 000 lines).
    for (const [name, body] of [
        ['100 000 "From: a" lines', 'From: a\n'.repeat(100_000)],
        ['50 000 "From: a / Cc: b" pairs', 'From: a\nCc: b\n'.repeat(50_000)],
    ] as const)
    {
        it(`${name}: handled in well under a second`, () =>
        {
            const t = performance.now();
            expect(detectReplyHeaders(body)).toEqual([]);
            expect(performance.now() - t).toBeLessThan(1000);
        });
    }
});

describe('findReplyHeaders: kind, marked and headEnd (used by the PDF output plan)', () =>
{
    /** [text of the header lines, text of the whole range, kind, marked] for each header found. */
    const describeAll = (body: string, subject?: string): [string, string, string, boolean][] =>
        findReplyHeaders(body, subject).map((h) => [body.slice(h.start, h.headEnd), body.slice(h.start, h.end), h.kind, h.marked]);

    it('gives the same ranges as detectReplyHeaders', () =>
    {
        const body = lines('Own text.', '', 'On Mon, 3 Mar 2025 at 14:02, Alice <alice@example.test> wrote:', ...QUOTE, '');
        expect(findReplyHeaders(body).map((h) => ({ start: h.start, end: h.end, reason: 'reply-header' }))).toEqual(detect(body));
    });

    it('an attribution with its ">" block: header lines = the attribution, range = with the block', () =>
    {
        const attribution = 'On Mon, 3 Mar 2025 at 14:02, Alice <alice@example.test> wrote:\n';
        const body = `Own text.\n\n${attribution}${lines(...QUOTE)}\n\nMore own text.\n`;
        expect(describeAll(body)).toEqual([[attribution, `${attribution}${lines(...QUOTE)}\n`, 'reply', false]]);
    });

    it('a strong attribution alone: header lines = range', () =>
    {
        const attribution = 'On Mon, 3 Mar 2025 at 14:02, Alice <alice@example.test> wrote:\n';
        expect(describeAll(`Own.\n\n${attribution}Unmarked quote.\n`)).toEqual([[attribution, attribution, 'reply', false]]);
    });

    it('an attribution inside a ">" quote is marked', () =>
    {
        const body = lines('Own.', '', '> On Mon, 3 Mar 2025 at 14:02, Carol <carol@example.test> wrote:', '> > old line', '');
        expect(describeAll(body)).toEqual([
            ['> On Mon, 3 Mar 2025 at 14:02, Carol <carol@example.test> wrote:\n', '> On Mon, 3 Mar 2025 at 14:02, Carol <carol@example.test> wrote:\n> > old line\n', 'reply', true],
        ]);
    });

    it('an Outlook reply block: header lines = intro + labels, range = to the end of the body', () =>
    {
        const head = lines(
            '-----Original Message-----',
            'From: Alice <alice@example.test>',
            'Sent: Monday, March 3, 2025 9:15 AM',
            'To: Bob <bob@example.test>',
            'Subject: Desks',
            '',
        );
        const body = `Own.\n\n${head}Quoted text.\n\nText below.\n`;
        expect(describeAll(body, 'RE: Desks')).toEqual([[head, fromHere(body, '-----Original'), 'reply', false]]);
        // The same block with a forward subject is a forward: header lines only.
        expect(describeAll(body, 'FW: Desks')).toEqual([[head, head, 'forward', false]]);
    });

    it('a lone separator: reply, marked or not', () =>
    {
        expect(describeAll('Own.\n\n-----Original Message-----\nText.\n')).toEqual([
            ['-----Original Message-----\n', '-----Original Message-----\n', 'reply', false],
        ]);
        expect(describeAll('Own.\n\n> -----Original Message-----\n> Text.\n')).toEqual([
            ['> -----Original Message-----\n', '> -----Original Message-----\n', 'reply', true],
        ]);
    });

    it('a forward marker: forward, marked inside a ">" quote', () =>
    {
        const fwd = lines(
            '---------- Forwarded message ---------',
            'From: Carol <carol@example.test>',
            'Date: Mon, 3 Mar 2025 at 10:00',
            'Subject: Stock',
            'To: Alice <alice@example.test>',
            '',
        );
        const quotedFwd = fwd
            .split('\n')
            .map((l) => (l === '' ? l : `> ${l}`))
            .join('\n');
        expect(describeAll(`See below.\n\n${fwd}In stock.\n`)).toEqual([[fwd, fwd, 'forward', false]]);
        expect(describeAll(`See below.\n\n${quotedFwd}> In stock.\n`)).toEqual([[quotedFwd, quotedFwd, 'forward', true]]);
        // A lone forward marker (no header lines after it).
        expect(describeAll('See below.\n\n> ---------- Forwarded message ---------\n> In stock.\n')).toEqual([
            ['> ---------- Forwarded message ---------\n', '> ---------- Forwarded message ---------\n', 'forward', true],
        ]);
    });
});
