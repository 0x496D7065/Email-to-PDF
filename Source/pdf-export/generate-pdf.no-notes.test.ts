// The whole PDF path (generatePdf, real fonts, our own writer), read back
// from the written file as text (Helper/Test/test-support/pdf-reader.ts), for task 8.8
// (user rule 2026-11-05): the PDF is the final product and holds NO notes.
// Nothing in it says that something went wrong, may be missing or may be
// inaccurate, or how the tool works: the app says all of that in step 2
// (Source/web-page/review.ts, Source/web-page/preview.ts).
//
// One set of synthetic emails holds every case that used to get a note: a
// thread whose last email gives rebuilt emails (one with a time read without
// a zone), several files, an identical copy merged into another file's
// email, a file that could not be read, an undated email, a date that could
// not be read (with a control character in it), a sender time zone not
// given, control characters in a body, a plan that fell back and one that
// kept everything, and every parser warning about content not shown in
// full. Made in English, French and Dutch, in a valid zone and in a zone
// that is not recognized. Checked:
// - none of the removed PDF texts, and none of the app's own notes, appear
//   anywhere in the PDF (cover, index, emails, bookmarks);
// - what stays: the blank-field placeholders, "Page X of Y" on every page,
//   the bookmarks, the source files with their SHA-256 (the merged copy like
//   any other), the date as written alone in its row, just "UTC" for a zone
//   that is not recognized;
// - collapse, never delete: the engine result is the same after the PDF is
//   made, and the model still holds the data behind the removed notes.
import { beforeAll, describe, expect, it } from 'vitest';
import { parseAllFixtures } from '../../Helper/Test/test-data/parse-all';
import { readOutline, readPageRuns, readPdf, textLines } from '../../Helper/Test/test-support/pdf-reader';
import { analyzeThread } from '../thread-analysis/analyze-thread';
import { DEFAULT_OUTPUT_POLICY, planOutput } from '../thread-analysis/output-plan';
import { CATALOG } from '../web-page/translations/catalog';
import { isPluralForms } from '../web-page/translations';
import { rebuiltEntries } from '../web-page-logic/rebuilt-email-display';
import { generatePdf, type PdfFonts } from './generate-pdf';
import { loadPdfFonts } from './load-bundled-fonts';
import { buildPdfDocument } from './build-pdf-document';
import { createPdfStrings } from './pdf-strings';
import type { MessagePlan } from '../../Header/output-plan';
import type { NormalizedMessage, ParseResult } from '../../Header/parsed-email';
import type { EngineResult } from '../../Header/thread-analysis-result';

const LOCALES = ['en', 'fr', 'nl'] as const;
type Locale = (typeof LOCALES)[number];
const GENERATED_AT = Date.UTC(2025, 5, 1, 12, 0, 0);
const BASE_MS = Date.UTC(2025, 3, 10, 9, 0, 0);
const THREAD_LAST = 'eml/13-order-4-bob-outlook-nl.eml';

let fonts: PdfFonts;
let threadLast: NormalizedMessage;
beforeAll(async () =>
{
    fonts = await loadPdfFonts();
    const found = (await parseAllFixtures()).find((m) => m.source.fileName === THREAD_LAST);
    if (found === undefined)
    {
        throw new Error(`no fixture ${THREAD_LAST}`);
    }
    threadLast = found;
});

let counter = 0;
function make(subject: string, fields: Partial<NormalizedMessage> = {}): NormalizedMessage
{
    counter++;
    return {
        messageId: `no-notes-${String(counter)}@example.test`,
        inReplyTo: null,
        references: [],
        date: { utcMs: BASE_MS + counter * 86_400_000, original: 'synthetic', offsetMinutes: 60, zoneKnown: true },
        from: [{ name: 'Erin Sample', address: 'erin@example.test' }],
        to: [{ name: 'Finn Example', address: 'finn@example.test' }],
        cc: [],
        bcc: [],
        subject,
        bodyText: `Hello Finn,\n\nThis is note number ${String(counter)} about the ${subject.toLowerCase()} shelves.\n\nErin\n`,
        attachments: [],
        source: { fileName: `no-notes-${String(counter)}.eml`, sha256: (0xa000 + counter).toString(16).padStart(64, '0'), kind: 'eml' },
        warnings: [],
        ...fields,
    };
}

const UNREADABLE_FILE = 'unreadable-file.eml';
const UNREADABLE_SHA = 'e'.repeat(64);
const COPY_FILE = 'identical-copy.eml';
const COPY_SHA = 'c'.repeat(64);
const DATE_WRITTEN = 'Someday\u0007 around noon';

/** Every case at once (see the top of this file), with the subjects of the two emails whose plans are changed. */
function input(): { results: ParseResult[] }
{
    const merged = make('Merged');
    const copy: NormalizedMessage = { ...merged, source: { fileName: COPY_FILE, sha256: COPY_SHA, kind: 'eml' } };
    const results: ParseResult[] = [
        { ok: true, message: threadLast },
        { ok: true, message: merged },
        { ok: false, fileName: UNREADABLE_FILE, sha256: UNREADABLE_SHA, error: 'corrupt', detail: 'synthetic' },
        { ok: true, message: copy },
        // Undated, no subject, no sender, no text: every blank-field placeholder. Its text could not be read
        // (RTF only), so it stays in the PDF with "(no text)" (task 8.14 leaves out an email with no text at all).
        {
            ok: true,
            message: make('', {
                from: [],
                bodyText: '',
                date: { utcMs: null, original: '', offsetMinutes: null, zoneKnown: false },
                warnings: ['missing-date', 'no-body', 'rtf-only-body'],
            }),
        },
        { ok: true, message: make('Unreadable date', { date: { utcMs: null, original: DATE_WRITTEN, offsetMinutes: null, zoneKnown: false }, warnings: ['unparseable-date'] }) },
        { ok: true, message: make('Unknown zone', { date: { utcMs: BASE_MS, original: 'Thu, 10 Apr 2025 09:00:00', offsetMinutes: null, zoneKnown: false }, warnings: ['unknown-time-zone'] }) },
        {
            ok: true,
            message: make('Content', {
                warnings: ['html-converted-body', 'html-body-truncated', 'html-body-unreadable', 'rtf-only-body', 'forwarded-message-not-expanded'],
                attachments: [{ fileName: '', size: null, mimeType: '' }],
            }),
        },
        { ok: true, message: make('Control', { bodyText: 'Line\u0000one and a bell \u0007 here.\n' }) },
        { ok: true, message: make('Fallback') },
        { ok: true, message: make('Kept all') },
    ];
    return { results };
}

/** The plans the app would make, with "Fallback" falling back and "Kept all" kept whole (plan rules 4 and 5). */
function plansOf(result: EngineResult, positions: readonly number[]): MessagePlan[]
{
    return planOutput(positions.map((p) => result.messages[p]!)).map((plan, k) =>
    {
        const subject = result.messages[positions[k]!]!.message.subject;
        if (subject === 'Fallback')
        {
            return { ...plan, fallback: true };
        }
        if (subject === 'Kept all')
        {
            return { ...plan, keptAllBecauseEmpty: true };
        }
        return plan;
    });
}

/** Lines may wrap anywhere; French puts no-break spaces before colons: compare with white space collapsed. */
const flat = (text: string): string => text.replace(/\s+/g, ' ');
const bare = (text: string): string => text.replace(/\s+/g, '');

/** What the PDF wrote before task 8.8 (those strings are gone from the catalogs). */
const REMOVED_PDF_TEXTS: Record<Locale, string[]> = {
    en: [
        'No email in this PDF has a usable date.',
        '{count} email has no usable date. It is placed after the dated emails, in the order the files were added.',
        '{count} emails have no usable date. They are placed after the dated emails, in the order the files were added.',
        '{zone} (the chosen time zone was not recognized)',
        'email {number} (identical copy, merged)',
        'Files that could not be read',
        'These files were added but could not be read. Nothing from them is in this PDF.',
        'no fingerprint (the file was not read)',
        '{count} control or broken character in the emails is shown as a code such as [U+0000].',
        '{count} control or broken characters in the emails are shown as codes such as [U+0000].',
        'Date as written in the email: {text}',
        'The whole email is shown: the tool could not tell its own text from the quote.',
        'The whole email is shown: the tool could not work out which parts to leave out.',
    ],
    fr: [
        'Aucun e-mail de ce PDF n’a de date utilisable.',
        '{count} e-mail n’a pas de date utilisable. Il est placé après les e-mails datés, dans l’ordre où les fichiers ont été ajoutés.',
        '{count} e-mails n’ont pas de date utilisable. Ils sont placés après les e-mails datés, dans l’ordre où les fichiers ont été ajoutés.',
        '{zone} (le fuseau horaire choisi n’a pas été reconnu)',
        'e-mail {number} (copie identique, fusionnée)',
        'Fichiers qui n’ont pas pu être lus',
        'Ces fichiers ont été ajoutés mais n’ont pas pu être lus. Rien de leur contenu ne figure dans ce PDF.',
        'pas d’empreinte (le fichier n’a pas été lu)',
        '{count} caractère de contrôle ou endommagé dans les e-mails est affiché sous forme de code, comme [U+0000].',
        '{count} caractères de contrôle ou endommagés dans les e-mails sont affichés sous forme de codes, comme [U+0000].',
        'Date telle qu’écrite dans l’e-mail : {text}',
        'L’e-mail entier est affiché : l’outil n’a pas pu distinguer son propre texte de la citation.',
        'L’e-mail entier est affiché : l’outil n’a pas pu déterminer quelles parties laisser de côté.',
    ],
    nl: [
        'Geen enkele e-mail in deze PDF heeft een bruikbare datum.',
        '{count} e-mail heeft geen bruikbare datum. Die staat na de e-mails met een datum, in de volgorde waarin de bestanden zijn toegevoegd.',
        '{count} e-mails hebben geen bruikbare datum. Ze staan na de e-mails met een datum, in de volgorde waarin de bestanden zijn toegevoegd.',
        '{zone} (de gekozen tijdzone werd niet herkend)',
        'e-mail {number} (identieke kopie, samengevoegd)',
        'Bestanden die niet konden worden gelezen',
        'Deze bestanden zijn toegevoegd, maar konden niet worden gelezen. Niets daaruit staat in deze PDF.',
        'geen vingerafdruk (het bestand is niet gelezen)',
        '{count} stuurteken of beschadigd teken in de e-mails wordt getoond als een code zoals [U+0000].',
        '{count} stuurtekens of beschadigde tekens in de e-mails worden getoond als codes zoals [U+0000].',
        'Datum zoals geschreven in de e-mail: {text}',
        'De hele e-mail wordt getoond: de tool kon de eigen tekst niet van het citaat onderscheiden.',
        'De hele e-mail wordt getoond: de tool kon niet bepalen welke delen moeten worden weggelaten.',
    ],
};

/** The pdf.document keys removed in task 8.8. */
const REMOVED_KEYS = ['noDates', 'undated', 'zoneFallback', 'sourceCopy', 'unreadable', 'unreadableIntro', 'noFingerprint', 'controlChars', 'dateAsWritten', 'keptAllEmpty', 'fallback'];

/** Every text of a catalog value, plural forms included. */
function textsOf(value: unknown): string[]
{
    if (typeof value === 'string')
    {
        return [value];
    }
    if (isPluralForms(value))
    {
        return Object.values(value).flatMap(textsOf);
    }
    if (typeof value === 'object' && value !== null)
    {
        return Object.values(value).flatMap(textsOf);
    }
    return [];
}

/** The app's own notes in `locale` (said in step 2, never in the PDF), and the removed PDF texts, cut at their placeholders. */
function forbidden(locale: Locale): string[]
{
    const catalog = CATALOG[locale]!;
    const appNotes = [
        ...textsOf(catalog.warnings),
        ...textsOf(catalog.preview.order),
        catalog.preview.zoneNotRecognized,
        catalog.preview.dateAsWritten,
        ...textsOf(catalog.review.pdfNote),
        catalog.review.codedCharacters,
        catalog.rebuilt.explain,
        catalog.rebuilt.noteMarks,
        catalog.rebuilt.noteNoMarks,
    ];
    return [...REMOVED_PDF_TEXTS[locale], ...appNotes].flatMap((text) => text.split(/\{[a-z]+\}/i).map((piece) => piece.trim())).filter((piece) => piece.length >= 10);
}

async function make8(locale: Locale, timeZone: string)
{
    const result = analyzeThread(input().results);
    const before = JSON.stringify(result);
    const positions = result.messages.map((_, k) => k);
    const plans = plansOf(result, positions);
    const rebuilt = rebuiltEntries(result).map((r) => r.id);
    const base = { result, positions, plans, rebuilt, policy: DEFAULT_OUTPUT_POLICY, timeZone, generatedAt: GENERATED_AT };
    const made = await generatePdf({ ...base, fonts, locale });
    const pdfDocument = buildPdfDocument({ ...base, strings: createPdfStrings(locale) });
    const pdf = readPdf(made.bytes);
    const pages = (await readPageRuns(pdf)).map((runs) => textLines(runs).map((l) => l.shown));
    const all = flat(pages.map((lines) => lines.join(' ')).join(' '));
    const bookmarks = readOutline(pdf)!.items.map((i) => i.title);
    return { result, before, rebuilt, pdfDocument, pages, all, bookmarks };
}

describe('task 8.8: the PDF holds no notes', () =>
{
    it('the removed texts are gone from the PDF strings and from every catalog', () =>
    {
        for (const locale of LOCALES)
        {
            const keys = Object.keys(CATALOG[locale]!.pdf.document);
            for (const key of REMOVED_KEYS)
            {
                expect(keys, `${locale}: pdf.document.${key}`).not.toContain(key);
            }
            const stringsRecord = createPdfStrings(locale) as unknown as Record<string, unknown>;
            for (const key of ['noDates', 'undated', 'zoneFallback', 'sourceCopy', 'unreadableHeading', 'unreadableIntro', 'noFingerprint', 'controlChars', 'dateAsWritten', 'zoneUnknown', 'keptAllEmpty', 'fallback', 'contentNotes'])
            {
                expect(stringsRecord[key], `${locale}: ${key}`).toBeUndefined();
            }
            expect(forbidden(locale).length, locale).toBeGreaterThan(20);
        }
    });

    for (const locale of LOCALES)
    {
        for (const timeZone of ['Africa/Lagos', 'Not/A_Zone'])
        {
            it(`${locale}, ${timeZone}: no note anywhere; placeholders, footer, bookmarks and file list kept`, async () =>
            {
                const strings = createPdfStrings(locale);
                const { result, before, rebuilt, pdfDocument, pages, all, bookmarks } = await make8(locale, timeZone);

                // The set has every case.
                expect(rebuilt.length).toBeGreaterThan(0);
                expect(pdfDocument.emails.some((e) => e.rebuilt !== null && e.flags.zoneUnknown)).toBe(true);
                expect(result.counts.duplicatesMerged).toBe(1);
                expect(result.failed).toHaveLength(1);
                expect(pdfDocument.emails.filter((e) => e.flags.planFallback)).toHaveLength(1);
                expect(pdfDocument.emails.filter((e) => e.flags.keptAllBecauseEmpty)).toHaveLength(1);
                expect(pdfDocument.emails.some((e) => e.rebuilt === null && e.flags.zoneUnknown)).toBe(true);
                expect(pdfDocument.cover.undated).toBeGreaterThanOrEqual(2);
                expect(pdfDocument.controlChars).toBeGreaterThanOrEqual(3);
                expect(pdfDocument.zoneFallback).toBe(timeZone === 'Not/A_Zone');

                // No removed text and no app note, anywhere: pages and bookmarks.
                for (const forbiddenText of forbidden(locale))
                {
                    expect(all, `"${forbiddenText}"`).not.toContain(flat(forbiddenText));
                    for (const title of bookmarks)
                    {
                        expect(title, `"${forbiddenText}"`).not.toContain(forbiddenText);
                    }
                }
                // Nothing of the file that could not be read.
                expect(all).not.toContain(UNREADABLE_FILE);
                expect(bare(all)).not.toContain(UNREADABLE_SHA);
                // No paragraph on the cover, and no line above an email's text but "(no text)".
                expect(pdfDocument.cover.blocks.some((b) => b.kind === 'paragraph')).toBe(false);
                for (const email of pdfDocument.emails)
                {
                    for (const line of email.notes)
                    {
                        expect(line.map((r) => r.text).join('')).toBe(strings.noText);
                    }
                }

                // Kept: the blank-field placeholders.
                for (const placeholder of [strings.noSubject, strings.unknownSender, strings.noText, strings.noAttachmentName, strings.noDate])
                {
                    expect(all, placeholder).toContain(flat(placeholder));
                }
                // Kept: the date as written, alone in its row (its control character as a code).
                expect(bare(all)).toContain(bare(`${strings.dateLabel} Someday[U+0007] around noon ${strings.subjectLabel}`));
                // Kept: the zone used, and nothing after it.
                const zoneShown = timeZone === 'Not/A_Zone' ? 'UTC' : 'Africa/Lagos';
                expect(all).toContain(`${strings.timeZoneLabel} ${zoneShown} ${strings.generatedLabel}`);
                // No source file list and no SHA-256 (task 8.12); the merged copy is still named, in its email's File row.
                expect(bare(all)).not.toMatch(/[0-9a-f]{64}/);
                expect(bare(all)).toContain(bare(COPY_FILE));
                // Kept: "Page X of Y" at the foot of every page; one bookmark per email after the cover and the index.
                pages.forEach((lines, k) => expect(lines.at(-1)).toBe(strings.pageFooter(k + 1, pages.length)));
                expect(bookmarks).toHaveLength(pdfDocument.emails.length + 2);
                expect(bookmarks.slice(0, 2)).toEqual([strings.coverBookmark, pdfDocument.index.heading]);

                // Collapse, never delete: the engine data is unchanged by making the PDF.
                expect(JSON.stringify(result)).toBe(before);
            });
        }
    }
});
