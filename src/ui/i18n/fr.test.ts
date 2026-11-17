// Unit tests for the French strings (fr.ts): complete, every text really
// translated (with an explicit list of the few that are the same in both
// languages), the same placeholders as English, French typography, the
// same caution as English where it matters, and characters the PDF fonts
// can draw. Pure data checks plus the bundled fonts: no DOM.
import { beforeAll, describe, expect, it } from 'vitest';
import { readWoffFont, type ParsedFont } from '../../pdf/font/font';
import { PDF_FONTS, type PdfFontName } from '../../pdf/fonts';
import { createPdfStrings } from '../../pdf/strings';
import { en } from './en';
import { fr } from './fr';
import { isPluralForms, type Messages, pickLocale, placeholdersIn, translator } from './index';

// Type check: fr has every key of en, and nothing else (an object literal
// typed as Messages rejects a missing and an extra key alike; see index.ts).
const typed: Messages = fr;

const NBSP = '\u00A0';
const NNBSP = '\u202F';

/** Every [dotted key, text] of a language file; a plural gives two entries, "key.one" and "key.other". */
function texts(table: unknown, prefix = ''): [string, string][]
{
    return Object.entries(table as Record<string, unknown>).flatMap(([key, value]): [string, string][] =>
    {
        if (typeof value === 'string') return [[prefix + key, value]];
        if (isPluralForms(value)) return [[`${prefix}${key}.one`, value.one], [`${prefix}${key}.other`, value.other]];
        return texts(value, `${prefix}${key}.`);
    });
}

const enTexts = new Map(texts(en));
const frTexts = texts(typed);

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
    // Words that are French too.
    'preview.cc',
    'preview.date',
    'pdf.reason.signature',
    'pdf.document.dates',
    'pdf.document.column.date',
    'pdf.document.column.page',
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
    'pdf.document.column.dateInZone',
    'pdf.document.attachment',
    'pdf.document.attachmentNoType',
]);

describe('French strings', () =>
{
    it('have the same keys as English (plural forms included)', () =>
    {
        expect(frTexts.map(([key]) => key)).toEqual([...enTexts.keys()]);
    });

    it('are all translated, except the listed texts that are the same in both languages', () =>
    {
        const entryKey = (key: string): string => (enTexts.has(key) && !/\.(one|other)$/.test(key) ? key : key.replace(/\.(one|other)$/, ''));
        const same = frTexts.filter(([key, text]) => text === enTexts.get(key)).map(([key]) => entryKey(key));
        expect([...new Set(same)].sort()).toEqual([...SAME_AS_ENGLISH].sort());
        // No French text is an English sentence of another key either.
        const english = new Set(enTexts.values());
        for (const [key, text] of frTexts)
        {
            if (SAME_AS_ENGLISH.has(key.replace(/\.(one|other)$/, ''))) continue;
            expect(english.has(text), `${key}: "${text}"`).toBe(false);
        }
    });

    it('use the same placeholders as English, key by key and plural form by plural form', () =>
    {
        for (const [key, text] of frTexts)
        {
            const sorted = (t: string): string[] => [...new Set(placeholdersIn(t))].sort();
            expect(sorted(text), key).toEqual(sorted(enTexts.get(key) ?? ''));
        }
    });

    it('keep the app name and the PDF file names as decided (ASCII file names)', () =>
    {
        expect(fr.app.name).toBe('Email to PDF');
        expect(fr.pdf.document.fileName).toBe('correspondance-{date}.pdf');
        expect(fr.pdf.document.fileNameNoDate).toBe('correspondance.pdf');
        expect(fr.pdf.document.fileName).toMatch(/^[a-z0-9-]+\{date\}\.pdf$/);
    });

    describe('typography', () =>
    {
        it('never has a plain space before : ; ! ? or », or after «', () =>
        {
            for (const [key, text] of frTexts)
            {
                expect(text, key).not.toMatch(/ [:;!?»]/);
                expect(text, key).not.toMatch(/« /);
            }
        });

        it('has a no-break space (U+00A0) before ":" and inside « », a narrow one (U+202F) before ; ! ?', () =>
        {
            for (const [key, text] of frTexts)
            {
                // ":" right after a word is part of it ("blob:"), else it follows U+00A0.
                for (const m of text.matchAll(/(.):/g))
                {
                    const before = m[1] ?? '';
                    if (/[A-Za-z]/.test(before)) expect(text.slice(Math.max(0, (m.index ?? 0) - 3), (m.index ?? 0) + 2), key).toBe('blob:');
                    else expect(before, `${key}: "${text}"`).toBe(NBSP);
                }
                for (const m of text.matchAll(/(.)[;!?]/g)) expect(m[1], `${key}: "${text}"`).toBe(NNBSP);
                for (const m of text.matchAll(/«(.)/g)) expect(m[1], `${key}: "${text}"`).toBe(NBSP);
                for (const m of text.matchAll(/(.)»/g)) expect(m[1], `${key}: "${text}"`).toBe(NBSP);
                // Every « is closed.
                expect((text.match(/«/g) ?? []).length, key).toBe((text.match(/»/g) ?? []).length);
            }
        });

        it('uses the typographic apostrophe and no English quotation marks', () =>
        {
            for (const [key, text] of frTexts) expect(text, key).not.toMatch(/['"“”]/);
            expect(fr.disclaimer.text).toContain('l’envoyer');
        });

        it('writes "..." only for the mail menu that shows three dots, "…" otherwise', () =>
        {
            const withDots = frTexts.filter(([, text]) => text.includes('...')).map(([key]) => key);
            expect(withDots).toEqual(['help.clients.outlookNew.how']);
            expect(fr.drop.reading.endsWith('…')).toBe(true);
        });

        it('has no other invisible or unusual space', () =>
        {
            for (const [key, text] of frTexts) expect(text, key).not.toMatch(/[\u2000-\u200B\u2060\u3000\t]/);
        });
    });

    describe('meaning kept where it matters', () =>
    {
        it('the disclaimer: as is, no guarantee, not legal advice, check the PDF, the original files remain the reference', () =>
        {
            const text = fr.disclaimer.text;
            for (const part of ['fourni tel quel', 'sans aucune garantie', 'pas un conseil juridique', 'Vérifiez le PDF', 'restent la référence'])
            {
                expect(text).toContain(part);
            }
        });

        it('the privacy panel names the "Clear everything" button exactly as the button says it', () =>
        {
            expect(fr.privacy.does.wiped).toContain(`«${NBSP}${fr.actions.clearEverything}${NBSP}»`);
        });

        it('the mail-client help keeps the same hedging as English, and has no link or address', () =>
        {
            const clients = Object.keys(en.help.clients) as (keyof typeof en.help.clients)[];
            for (const client of clients)
            {
                const english = en.help.clients[client].how;
                const french = fr.help.clients[client].how;
                // "usually" -> "généralement", "may" -> "peut", as many times.
                const count = (text: string, word: RegExp): number => (text.match(word) ?? []).length;
                expect(count(french, /généralement/g), client).toBe(count(english, /\busually\b/g));
                expect(count(french, /\bpeut\b/g), client).toBe(count(english, /\bmay\b/g));
            }
            expect(fr.help.note).toMatch(/peuvent changer/);
            for (const [key, text] of frTexts) expect(text, key).not.toMatch(/https?:|www\.|@/);
        });
    });
});

describe('the French translator', () =>
{
    const tr = translator('fr');

    it('writes numbers and lists the French way (Intl, not by hand)', () =>
    {
        expect(tr.number(1234)).toBe(new Intl.NumberFormat('fr').format(1234));
        expect(tr.number(1234)).not.toBe('1,234');
        expect(tr.number(1.5)).toBe('1,5');
        expect(tr.t('drop.reading', { done: 1, total: 1234 })).toBe(`Lecture du fichier 1 sur ${new Intl.NumberFormat('fr').format(1234)}…`);
        expect(tr.list(['#1', '#3'])).toBe(new Intl.ListFormat('fr', { style: 'short', type: 'unit' }).format(['#1', '#3']));
    });

    it('uses the French plural rules: 0 and 1 are singular', () =>
    {
        expect(tr.t('counts.files', { count: 0 })).toBe('0 fichier');
        expect(tr.t('counts.files', { count: 1 })).toBe('1 fichier');
        expect(tr.t('counts.files', { count: 2 })).toBe('2 fichiers');
        expect(tr.t('added.failed', { count: 3 })).toBe('3 n’ont pas pu être lus.');
        // The "included" line follows the total, without a verb that would have to agree with the other number.
        expect(tr.t('counts.included', { included: 1, count: 5 })).toBe(`E-mails dans le PDF${NBSP}: 1 sur 5.`);
        expect(tr.t('counts.included', { included: 1, count: 1 })).toBe(`E-mail dans le PDF${NBSP}: 1 sur 1.`);
    });

    it('is picked for a French browser (first language only)', () =>
    {
        expect(pickLocale(['fr-BE'])).toBe('fr');
        expect(pickLocale(['fr'])).toBe('fr');
        expect(pickLocale(['en-GB', 'fr-BE'])).toBe('en');
    });
});

describe('the PDF in French', () =>
{
    it('has French texts and a French, ASCII-only file name', () =>
    {
        const strings = createPdfStrings('fr');
        expect(strings.locale).toBe('fr');
        expect(strings.title).toBe('Correspondance par e-mail');
        expect(strings.producer).toBe('Email to PDF');
        expect(strings.pageFooter(3, 12)).toBe('Page 3 sur 12');
        expect(strings.fileName('2025-06-02')).toBe('correspondance-2025-06-02.pdf');
        expect(strings.fileName(null)).toBe('correspondance.pdf');
        expect(strings.size(2048)).toBe('2 Ko');
        expect(strings.size(1.4 * 1024 * 1024)).toBe('1,4 Mo');
        expect(strings.size(1)).toBe('1 octet');
    });

    describe('every character of the French texts is in the PDF fonts', () =>
    {
        const fonts: Partial<Record<PdfFontName, ParsedFont>> = {};
        beforeAll(async () =>
        {
            for (const name of ['sans-regular', 'sans-bold', 'sans-italic'] as const) fonts[name] = await readWoffFont(PDF_FONTS[name]);
        });

        it.each(['sans-regular', 'sans-bold', 'sans-italic'] as const)('%s', (name) =>
        {
            const font = fonts[name]!;
            const missing = new Set<string>();
            for (const [, text] of frTexts) for (const ch of text) if (!font.hasGlyph(ch.codePointAt(0) ?? 0)) missing.add(ch);
            expect([...missing]).toEqual([]);
            // Including the spaces of French typography and of French numbers (Intl uses U+202F).
            expect(font.hasGlyph(0x00a0) && font.hasGlyph(0x202f)).toBe(true);
            // And the "Nº" of the PDF index column (U+00BA, masculine ordinal indicator).
            expect(font.hasGlyph(0x00ba)).toBe(true);
        });
    });

    it('heads the PDF index column with "Nº" (U+00BA, not the degree sign)', () =>
    {
        expect(createPdfStrings('fr').columns.number).toBe('Nº');
    });
});
