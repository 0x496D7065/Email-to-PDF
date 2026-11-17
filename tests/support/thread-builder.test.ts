// The ground-truth builder must itself be right, or the reconstruction
// measurements prove nothing: offsets must point at the headers, own texts
// must be recoverable verbatim, depths and generations must match the text,
// and the localized dates must be the real calendar days.

import { describe, expect, it } from 'vitest';
import { ALICE, BOB, chain, LAGOS, NEGATIVE_CASES, THREAD_CASES, TOKYO } from './thread-cases';
import { buildThread, formatQuotedDate, instantOf, QUOTE_STYLES, unquote, type ExpectedHeader } from './thread-builder';

/** Number of ">" markers at the start of a line ("> > x" and ">> x" both give 2). */
function markers(line: string): number
{
    const m = /^[> ]*/.exec(line)?.[0] ?? '';
    return [...m].filter((ch) => ch === '>').length;
}

/** Header text with line breaks and quote markers removed (wrapped lines joined by one space). */
function joinedHeader(body: string, h: ExpectedHeader): string
{
    return body
        .slice(h.start, h.headEnd)
        .split('\n')
        .map((line) => line.replace(/^(?:> ?)*/, ''))
        .filter((line) => line !== '')
        .join(' ');
}

describe('thread builder: localized quote dates', () =>
{
    // 2025-03-03 is a Monday.
    const at = instantOf({ year: 2025, month: 3, day: 3, hour: 14, minute: 2 }, LAGOS);
    it.each([
        ['outlook-en', 'Monday, March 3, 2025 2:02 PM'],
        ['outlook-fr', 'lundi 3 mars 2025 14:02'],
        ['outlook-nl', 'maandag 3 maart 2025 14:02'],
        ['gmail-en', 'Mon, Mar 3, 2025 at 2:02 PM'],
        ['gmail-en-gb', 'Mon, 3 Mar 2025 at 14:02'],
        ['gmail-fr', 'lun. 3 mars 2025 \u00e0 14:02'],
        ['gmail-nl', 'ma 3 mrt 2025 om 14:02'],
        ['apple-en', '3 Mar 2025, at 14:02'],
        ['apple-fr', '3 mars 2025 \u00e0 14:02'],
        ['apple-nl', '3 mrt. 2025 om 14:02'],
        ['apple-forward-en', '3 March 2025 at 14:02:00 GMT+1'],
        ['thunderbird', '03/03/2025 14:02'],
    ] as const)('%s: %s', (format, expected) =>
    {
        expect(formatQuotedDate(format, at, LAGOS)).toBe(expected);
    });

    it('shows the moment in the quoting zone (another day and a 12-hour clock past midnight)', () =>
    {
        expect(formatQuotedDate('outlook-en', at, TOKYO)).toBe('Monday, March 3, 2025 10:02 PM');
        const late = instantOf({ year: 2025, month: 3, day: 3, hour: 23, minute: 30 }, LAGOS);
        expect(formatQuotedDate('outlook-en', late, TOKYO)).toBe('Tuesday, March 4, 2025 7:30 AM');
        expect(formatQuotedDate('outlook-fr', late, TOKYO)).toBe('mardi 4 mars 2025 07:30');
        expect(formatQuotedDate('apple-forward-en', late, { name: 'Asia/Kathmandu', offsetMinutes: 345 })).toBe('4 March 2025 at 04:15:00 GMT+5:45');
    });

    it('writes 12 AM just after midnight and 12 PM just after noon', () =>
    {
        const midnight = instantOf({ year: 2025, month: 3, day: 3, hour: 0, minute: 5 }, LAGOS);
        const noon = instantOf({ year: 2025, month: 3, day: 3, hour: 12, minute: 30 }, LAGOS);
        expect(formatQuotedDate('outlook-en', midnight, LAGOS)).toBe('Monday, March 3, 2025 12:05 AM');
        expect(formatQuotedDate('gmail-en', midnight, LAGOS)).toBe('Mon, Mar 3, 2025 at 12:05 AM');
        expect(formatQuotedDate('outlook-en', noon, LAGOS)).toBe('Monday, March 3, 2025 12:30 PM');
        expect(formatQuotedDate('gmail-en', noon, LAGOS)).toBe('Mon, Mar 3, 2025 at 12:30 PM');
        expect(formatQuotedDate('outlook-fr', midnight, LAGOS)).toBe('lundi 3 mars 2025 00:05');
    });

    it('writes accented French months and crosses a year boundary', () =>
    {
        const feb = instantOf({ year: 2025, month: 2, day: 14, hour: 10, minute: 30 }, LAGOS);
        const aug = instantOf({ year: 2025, month: 8, day: 15, hour: 7, minute: 45 }, LAGOS);
        const dec = instantOf({ year: 2025, month: 12, day: 31, hour: 23, minute: 50 }, LAGOS);
        expect(formatQuotedDate('outlook-fr', feb, LAGOS)).toBe('vendredi 14 f\u00e9vrier 2025 10:30');
        expect(formatQuotedDate('gmail-fr', aug, LAGOS)).toBe('ven. 15 ao\u00fbt 2025 \u00e0 07:45');
        expect(formatQuotedDate('apple-fr', dec, LAGOS)).toBe('31 d\u00e9cembre 2025 \u00e0 23:50');
        // The same moment seen in Tokyo is already in the next year.
        expect(formatQuotedDate('outlook-fr', dec, TOKYO)).toBe('jeudi 1 janvier 2026 07:50');
        expect(formatQuotedDate('thunderbird', dec, TOKYO)).toBe('01/01/2026 07:50');
        expect(formatQuotedDate('outlook-en', dec, TOKYO)).toBe('Thursday, January 1, 2026 7:50 AM');
    });
});

describe('thread builder: exact rendering', () =>
{
    it('writes the shape of fixture 13 (Outlook NL over a Gmail quote over an Outlook EN block)', () =>
    {
        const t = buildThread(chain(['outlook-en', 'gmail-en', 'outlook-nl'], { zones: [LAGOS] }));
        const lines = t.body.split('\n');
        const at = (text: string): number => lines.indexOf(text);
        expect(at('________________________________')).toBeGreaterThan(0);
        expect(lines.slice(at('________________________________'), at('________________________________') + 5)).toEqual([
            '________________________________',
            'Van: Alice Example <alice@example.test>',
            'Verzonden: maandag 3 maart 2025 19:29',
            'Aan: Bob Sample <bob@furniture.example.test>',
            'Onderwerp: RE: Office desks and chairs',
        ]);
        expect(at('On Mon, Mar 3, 2025 at 2:22 PM Bob Sample <bob@furniture.example.test> wrote:')).toBeGreaterThan(0);
        expect(at('> ________________________________')).toBeGreaterThan(0);
        expect(at('> Sent: Monday, March 3, 2025 9:15 AM')).toBeGreaterThan(0);
        expect(at('> Hello Bob,')).toBeGreaterThan(0);
        expect(t.headers.map((h) => [h.generation, h.depth, h.textDepth, h.style])).toEqual([
            [1, 0, 0, 'outlook-nl'],
            [2, 0, 1, 'gmail-en'],
            [3, 1, 1, 'outlook-en'],
        ]);
    });

    it('nests ">>" for Gmail and "> >" for Apple, and puts the Apple attribution inside the quote', () =>
    {
        const gmail = buildThread(chain(['gmail-en', 'gmail-en'])).body;
        expect(gmail).toContain('\n>> Hello Bob,\n');
        expect(gmail).toMatch(/\n> On [^\n]+ wrote:\n>> Hello Bob,/);
        const apple = buildThread(chain(['apple-en', 'apple-en'])).body;
        expect(apple).toContain('\n> > Hello Bob,\n');
        expect(apple).toMatch(/\n> On [^\n]+ wrote:\n>\n> Hello Alice,/);
    });

    it('wraps long To/Cc values without a label on the continuation lines', () =>
    {
        const t = THREAD_CASES.find((c) => c.id === 'outlook-en wrapped to/cc')?.thread;
        expect(t).toBeDefined();
        const h = t?.headers[0];
        if (t === undefined || h === undefined) return;
        const block = t.body.slice(h.start, h.headEnd).split('\n');
        expect(block.length).toBeGreaterThan(7); // intro + 5 labels + at least 2 continuation lines + ''
        expect(block.every((line) => line.length <= 76)).toBe(true);
        expect(joinedHeader(t.body, h)).toContain(`To: ${h.fields.to ?? ''} Cc: ${h.fields.cc ?? ''} Subject: `);
    });
});

describe('thread builder: ground truth over every case', () =>
{
    it('covers every quote style at least once', () =>
    {
        const used = new Set(THREAD_CASES.flatMap((c) => c.thread.headers.map((h) => h.style)));
        expect([...QUOTE_STYLES].filter((s) => !used.has(s))).toEqual([]);
        expect(Math.max(...THREAD_CASES.map((c) => c.thread.headers.length))).toBeGreaterThanOrEqual(8);
    });

    it('renders other dates than early March: accented months and a year boundary', () =>
    {
        const dates = THREAD_CASES.flatMap((c) => c.thread.headers.map((h) => h.fields.date)).join('\n');
        expect(dates).toContain(' f\u00e9vrier 2025 ');
        expect(dates).toContain(' ao\u00fbt 2025 ');
        expect(dates).toContain(' d\u00e9cembre 2025 ');
        expect(dates).toMatch(/\b2026\b/);
        const year = THREAD_CASES.find((c) => c.id === 'mixed, 31 December into 1 January')?.thread;
        expect(year?.headers.at(-1)?.instantUtc.startsWith('2025-12-31')).toBe(true);
        expect(year?.instantUtc.startsWith('2026-01-01')).toBe(true);
    });

    it('writes French Outlook subjects with "RE :" and "TR :"', () =>
    {
        const fr = THREAD_CASES.find((c) => c.id === 'outlook-fr x3')?.thread;
        expect(fr?.subject).toBe('RE : Office desks and chairs');
        const fwd = THREAD_CASES.find((c) => c.id === 'outlook-fr forward (TR : subject)')?.thread;
        expect(fwd?.subject).toBe('TR : RE : Office desks and chairs');
        expect(fwd?.headers[0]?.kind).toBe('forward');
    });

    it.each(THREAD_CASES.map((c) => [c.id, c] as const))('%s', (_, c) =>
    {
        const { body, headers } = c.thread;
        expect(body.endsWith('\n')).toBe(true);
        // The last message's own text starts the body.
        expect(body.slice(0, c.thread.ownEnd)).toMatch(/^Hello \w+,\n\n[\s\S]+\n\nBest regards,\n\w+$/);
        let previous = c.thread.ownEnd;
        // A possible timeline: every message is later than the one it quotes,
        // and the last (dropped) message is the latest of all.
        let later = Date.parse(c.thread.instantUtc);
        headers.forEach((h, k) =>
        {
            expect(Date.parse(h.instantUtc), `message ${h.index} before the one quoting it`).toBeLessThan(later);
            later = Date.parse(h.instantUtc);
            // Newest first, in body order, one generation further each time.
            expect(h.generation).toBe(k + 1);
            expect(h.start).toBeGreaterThan(previous);
            expect(h.start < h.headEnd && h.headEnd <= h.ownStart && h.ownStart < h.ownEnd).toBe(true);
            previous = h.ownEnd;
            // The header starts and ends at line starts.
            expect(body.charAt(h.start - 1)).toBe('\n');
            expect(body.charAt(h.headEnd - 1)).toBe('\n');
            const firstLine = body.slice(h.start, body.indexOf('\n', h.start));
            expect(markers(firstLine)).toBe(h.depth);
            // The header holds the fields as written.
            const joined = joinedHeader(body, h);
            expect(joined).toContain(h.fields.from);
            expect(joined).toContain(h.fields.date);
            if (h.fields.subject !== undefined) expect(joined).toContain(h.fields.subject);
            if (h.fields.to !== undefined) expect(joined).toContain(h.fields.to);
            if (h.fields.cc !== undefined) expect(joined).toContain(h.fields.cc);
            // The own text is there verbatim once its quote markers are removed.
            const rendered = body.slice(h.ownStart, h.ownEnd);
            expect(markers(rendered)).toBe(h.textDepth);
            expect(unquote(rendered, h.textDepth)).toBe(h.ownText);
            expect(Number.isNaN(Date.parse(h.instantUtc))).toBe(false);
        });
    });

    it('records the instant in UTC and the zone the header is shown in', () =>
    {
        const t = buildThread([
            { from: ALICE, to: [BOB], sent: { year: 2025, month: 3, day: 3, hour: 9, minute: 15 }, zone: TOKYO, subject: 'Desks', text: 'Hello Bob,\n\nA quote please.' },
            { from: BOB, to: [ALICE], sent: { year: 2025, month: 3, day: 3, hour: 8, minute: 0 }, zone: LAGOS, subject: 'RE: Desks', text: 'Sure.', quote: { style: 'outlook-en' } },
        ]);
        expect(t.headers[0]?.instantUtc).toBe('2025-03-03T00:15:00.000Z');
        expect(t.headers[0]?.shownIn).toEqual(LAGOS);
        expect(t.headers[0]?.fields.date).toBe('Monday, March 3, 2025 1:15 AM');
    });
});

describe('thread builder: negative cases', () =>
{
    it.each(NEGATIVE_CASES.map((c) => [c.id, c] as const))('%s', (_, c) =>
    {
        expect(c.body.endsWith('\n')).toBe(true);
        expect(c.realHeaders.length > 0).toBe(c.expect === 'refuse');
        for (const at of c.realHeaders) expect(at === 0 || c.body.charAt(at - 1) === '\n').toBe(true);
    });
});
