// Unit tests for the Dutch strings (nl.ts): complete, every text really
// translated (with an explicit list of the few that are the same in both
// languages), the same placeholders as English, Dutch typography, the same
// caution as English where it matters, and characters the PDF fonts can
// draw. Pure data checks plus the bundled fonts: no DOM.
import { beforeAll, describe, expect, it } from 'vitest';
import { readWoffFont } from '../../pdf-export/font-reader/parse-font';
import { PDF_FONTS } from '../../pdf-export/bundled-fonts';
import { createPdfStrings } from '../../pdf-export/pdf-strings';
import { en } from './en';
import { nl } from './nl';
import { isPluralForms, type Messages, pickLocale, placeholdersIn, translator } from './index';
import type { ParsedFont, PdfFontName } from '../../../Header/pdf-fonts';

// Type check: nl has every key of en, and nothing else (an object literal
// typed as Messages rejects a missing and an extra key alike; see index.ts).
const typed: Messages = nl;

/** Every [dotted key, text] of a language file; a plural gives two entries, "key.one" and "key.other". */
function texts(table: unknown, prefix = ''): [string, string][]
{
    return Object.entries(table as Record<string, unknown>).flatMap(([key, value]): [string, string][] =>
    {
        if (typeof value === 'string')
        {
            return [[prefix + key, value]];
        }
        if (isPluralForms(value))
        {
            return [[`${prefix}${key}.one`, value.one], [`${prefix}${key}.other`, value.other]];
        }
        return texts(value, `${prefix}${key}.`);
    });
}

const enTexts = new Map(texts(en));
const nlTexts = texts(typed);

/**
 * The only texts written exactly as in English, each for a reason. Anything
 * else equal to English is an untranslated string.
 */
const SAME_AS_ENGLISH: ReadonlySet<string> = new Set([
    // The app's name is never translated (user decision).
    'app.name',
    // Mail program names (user decision: product names are not translated).
    'help.clients.thunderbird.name',
    'help.clients.appleMail.name',
    // Words and units that are Dutch too.
    'preview.cc',
    'preview.bcc',
    'preview.size.bytes',
    'preview.size.kb',
    'preview.size.mb',
    // Only placeholders and punctuation: nothing to translate.
    'download.changedAfter',
    'preview.messageNumber',
    'preview.mailbox',
    'preview.attachment',
    'preview.attachmentNoType',
    'preview.foldLabel',
    'preview.foldLabelFrom',
    'counts.sentence',
    'counts.messagesFoundAttached',
    'pdf.document.attachment',
    'pdf.document.attachmentNoType',
    'pdf.document.emailBookmark',
]);

/** How many times a pattern occurs in a text. */
const count = (text: string, pattern: RegExp): number => (text.match(pattern) ?? []).length;

describe('Dutch strings', () =>
{
    it('have the same keys as English (plural forms included)', () =>
    {
        expect(nlTexts.map(([key]) => key)).toEqual([...enTexts.keys()]);
    });

    it('are all translated, except the listed texts that are the same in both languages', () =>
    {
        const entryKey = (key: string): string => (enTexts.has(key) && !/\.(one|other)$/.test(key) ? key : key.replace(/\.(one|other)$/, ''));
        const same = nlTexts.filter(([key, text]) => text === enTexts.get(key)).map(([key]) => entryKey(key));
        expect([...new Set(same)].sort()).toEqual([...SAME_AS_ENGLISH].sort());
        // No Dutch text is an English sentence of another key either.
        const english = new Set(enTexts.values());
        for (const [key, text] of nlTexts)
        {
            if (SAME_AS_ENGLISH.has(key.replace(/\.(one|other)$/, '')))
            {
                continue;
            }
            expect(english.has(text), `${key}: "${text}"`).toBe(false);
        }
    });

    it('use the same placeholders as English, key by key and plural form by plural form', () =>
    {
        for (const [key, text] of nlTexts)
        {
            const sorted = (t: string): string[] => [...new Set(placeholdersIn(t))].sort();
            expect(sorted(text), key).toEqual(sorted(enTexts.get(key) ?? ''));
        }
    });

    it('keep the app name and the PDF file names as decided (ASCII file names)', () =>
    {
        expect(nl.app.name).toBe('Email to PDF');
        expect(nl.pdf.document.fileName).toBe('correspondentie-{date}.pdf');
        expect(nl.pdf.document.fileNameNoDate).toBe('correspondentie.pdf');
        expect(nl.pdf.document.fileName).toMatch(/^[a-z0-9-]+\{date\}\.pdf$/);
    });

    it('say "e-mail" (never "email", except in the app name) and the formal "u" (never "je" or "jij")', () =>
    {
        for (const [key, text] of nlTexts)
        {
            if (key !== 'app.name')
            {
                expect(text, key).not.toMatch(/(?<!\p{L})email/iu);
            }
            expect(text, key).not.toMatch(/(?<!\p{L})(je|jij|jou|jouw|jullie)(?!\p{L})/iu);
        }
        expect(nl.steps.add.title).toBe('Voeg uw e-mails toe');
    });

    describe('typography', () =>
    {
        it('quotes with “…” only, each one closed, hugging the quoted words', () =>
        {
            for (const [key, text] of nlTexts)
            {
                // No straight double quote, no « », no low-9 „ or single quotes as quotation marks.
                expect(text, key).not.toMatch(/["«»„‘‚]/);
                expect(count(text, /“/g), key).toBe(count(text, /”/g));
                expect(text, key).not.toMatch(/“\s|\s”/);
                // Opening before closing, never nested.
                expect(text.replace(/[^“”]/g, ''), key).toMatch(/^(“”)*$/);
            }
            expect(nl.privacy.check.network).toContain('“/sw.js”');
        });

        it('uses the typographic apostrophe, only inside a word (pagina’s)', () =>
        {
            for (const [key, text] of nlTexts)
            {
                expect(text, key).not.toMatch(/'/);
                for (const match of text.matchAll(/(.)’(.)/g))
                {
                    expect(`${match[1] ?? ''}${match[2] ?? ''}`, `${key}: "${text}"`).toMatch(/^\p{L}\p{L}$/u);
                }
                expect(text, key).not.toMatch(/^’|’$/);
            }
            expect(nl.download.ready.other).toContain('pagina’s');
        });

        it('has no space before punctuation and no special space at all (unlike French)', () =>
        {
            for (const [key, text] of nlTexts)
            {
                // A space before "." only starts a file extension (".eml").
                expect(text, key).not.toMatch(/\s[:;!?,]|\s\.(?![a-z])/);
                expect(text, key).not.toMatch(/[\u00A0\u202F\u2000-\u200F\u2028-\u202E\u2060-\u206F\u3000\uFEFF\t\r\n]/);
            }
        });

        it('writes "..." only for the mail menu that shows three dots, "…" otherwise', () =>
        {
            const withDots = nlTexts.filter(([, text]) => text.includes('...')).map(([key]) => key);
            expect(withDots).toEqual(['help.clients.outlookNew.how']);
            expect(nl.drop.reading.endsWith('…')).toBe(true);
        });
    });

    describe('meaning kept where it matters', () =>
    {
        it('the disclaimer: as is, no guarantee, not legal advice, check the PDF, the original files remain the reference', () =>
        {
            const text = nl.disclaimer.text;
            for (const part of ['in de huidige staat', 'zonder enige garantie', 'geen juridisch advies', 'Controleer de PDF', 'blijven leidend'])
            {
                expect(text).toContain(part);
            }
        });

        it('the privacy panel names the "Clear everything" button exactly as the button says it', () =>
        {
            expect(nl.privacy.does.wiped).toContain(`“${nl.actions.clearEverything}”`);
        });

        it('the privacy panel keeps its key promises', () =>
        {
            expect(nl.privacy.does.noUpload).toBe('Niets uit uw bestanden verlaat uw computer.');
            expect(nl.privacy.does.noSaving).toContain('bewaart niets van u: geen cookies');
            // The offline copy holds the page's own files, never the emails.
            expect(nl.privacy.check.offline).toContain('(nooit van uw e-mails)');
            expect(nl.privacy.notes.trust).toContain('maar nooit uw e-mails');
            expect(nl.privacy.notes.hostReports).toContain('bevat nooit uw bestanden of uw e-mails');
            expect(nl.privacy.notes.hostReports).toContain('naar het bedrijf waar deze site op staat');
            expect(nl.privacy.check.network).toContain('er gaat niets van deze pagina naar internet');
            // "No analytics": the usual Dutch word for visitor statistics.
            expect(nl.privacy.never.tracking).toContain('geen bezoekersstatistieken');
        });

        it('the mail-client help keeps the same hedging as English, and has no link or address', () =>
        {
            const clients = Object.keys(en.help.clients) as (keyof typeof en.help.clients)[];
            // "usually" -> "meestal", "may" -> "mogelijk", "can" -> "kan/kunt/kunnen", as many times.
            const hedges = (english: string, dutch: string, where: string): void =>
            {
                expect(count(dutch, /(?<!\p{L})meestal(?!\p{L})/giu), where).toBe(count(english, /\busually\b/gi));
                expect(count(dutch, /(?<!\p{L})mogelijk(?!\p{L})/giu), where).toBe(count(english, /\bmay\b/gi));
                expect(count(dutch, /(?<!\p{L})(kan|kunt|kunnen)(?!\p{L})/giu), where).toBe(count(english, /\bcan\b/gi));
                // No stronger or extra hedge words that English does not have.
                expect(dutch, where).not.toMatch(/(?<!\p{L})(altijd|zeker|gewoonlijk|vaak|misschien|wellicht|normaal)(?!\p{L})/iu);
            };
            for (const client of clients)
            {
                hedges(en.help.clients[client].how, nl.help.clients[client].how, client);
            }
            hedges(en.help.note, nl.help.note, 'note');
            // Classic Outlook: either file type, depending on the version.
            expect(nl.help.clients.outlookClassic.how).toContain('.eml- of .msg-bestand, afhankelijk van uw Outlook-versie');
            for (const [key, text] of nlTexts)
            {
                expect(text, key).not.toMatch(/https?:|www\.|@/);
            }
        });
    });
});

describe('the Dutch translator', () =>
{
    const dutch = translator('nl');

    it('writes numbers and lists the Dutch way (Intl, not by hand)', () =>
    {
        expect(dutch.number(1234)).toBe(new Intl.NumberFormat('nl').format(1234));
        expect(dutch.number(1234)).toBe('1.234');
        expect(dutch.number(1.5)).toBe('1,5');
        expect(dutch.t('drop.reading', { done: 1, total: 1234 })).toBe('Bestand 1 van 1.234 wordt gelezen…');
        expect(dutch.list(['#1', '#3'])).toBe(new Intl.ListFormat('nl', { style: 'short', type: 'unit' }).format(['#1', '#3']));
    });

    it('uses the Dutch plural rules: only 1 is singular', () =>
    {
        expect(dutch.t('counts.files', { count: 0 })).toBe('0 bestanden');
        expect(dutch.t('counts.files', { count: 1 })).toBe('1 bestand');
        expect(dutch.t('counts.files', { count: 2 })).toBe('2 bestanden');
        expect(dutch.t('added.failed', { count: 3 })).toBe('3 konden niet worden gelezen.');
        expect(dutch.t('download.ready', { fileName: 'x.pdf', count: 2 })).toBe('Uw PDF is klaar: x.pdf, 2 pagina’s. Het downloaden is begonnen.');
        // The "included" line follows the total, without a verb that would have to agree with the other number.
        expect(dutch.t('counts.included', { included: 1, count: 5 })).toBe('In de PDF: 1 van 5 e-mails.');
        expect(dutch.t('counts.included', { included: 1, count: 1 })).toBe('In de PDF: 1 van 1 e-mail.');
        // "12 bestanden, waarvan 1 niet kon worden gelezen."
        const failed = dutch.t('counts.filesFailed', { count: 1 });
        expect(dutch.t('counts.sentence', { text: dutch.t('counts.filesWithFailed', { files: dutch.t('counts.files', { count: 12 }), failed }) })).toBe(
            '12 bestanden, waarvan 1 niet kon worden gelezen.',
        );
    });

    it('is picked for a Dutch browser (first language only)', () =>
    {
        expect(pickLocale(['nl-BE'])).toBe('nl');
        expect(pickLocale(['nl-NL'])).toBe('nl');
        expect(pickLocale(['nl'])).toBe('nl');
        expect(pickLocale(['de', 'nl'])).toBe('en');
        expect(pickLocale(['en-GB', 'nl-BE'])).toBe('en');
    });
});

describe('the PDF in Dutch', () =>
{
    it('has Dutch texts and a Dutch, ASCII-only file name', () =>
    {
        const strings = createPdfStrings('nl');
        expect(strings.locale).toBe('nl');
        expect(strings.title).toBe('E-mailcorrespondentie');
        expect(strings.producer).toBe('Email to PDF');
        expect(strings.pageFooter(3, 12)).toBe('Pagina 3 van 12');
        expect(strings.fileName('2025-06-02')).toBe('correspondentie-2025-06-02.pdf');
        expect(strings.fileName(null)).toBe('correspondentie.pdf');
        expect(strings.size(2048)).toBe('2 KB');
        expect(strings.size(1.4 * 1024 * 1024)).toBe('1,4 MB');
        expect(strings.size(1)).toBe('1 byte');
        expect(strings.columns.number).toBe('Nr.');
    });

    describe('every character of the Dutch texts is in the PDF fonts', () =>
    {
        const fonts: Partial<Record<PdfFontName, ParsedFont>> = {};
        beforeAll(async () =>
        {
            for (const name of ['sans-regular', 'sans-bold', 'sans-italic'] as const)
            {
                fonts[name] = await readWoffFont(PDF_FONTS[name]);
            }
        });

        it.each(['sans-regular', 'sans-bold', 'sans-italic'] as const)('%s', (name) =>
        {
            const font = fonts[name]!;
            const missing = new Set<string>();
            for (const [, text] of nlTexts)
            {
                for (const character of text)
                {
                    if (!font.hasGlyph(character.codePointAt(0) ?? 0))
                    {
                        missing.add(character);
                    }
                }
            }
            expect([...missing]).toEqual([]);
            // And the Dutch letters with marks that names and email text often use
            // (één, geëxporteerd, ruïne, ...), the quotes, the apostrophe and the ellipsis.
            const extra = [...'éèëêïíóöüáäàÉËÏÖÜ“”’…'].filter((ch) => !font.hasGlyph(ch.codePointAt(0) ?? 0));
            expect(extra).toEqual([]);
        });
    });
});
