// The no-repeat rule (user decision 2026-11-06, task 8.10; Source/pdf-export/build-pdf-document.ts,
// printedElsewhere): when "Print full original text" is off, no email is
// printed twice in the PDF. A part of an email's text that the PDF prints
// as an email of its own (a rebuilt email, or the real file a rebuilt one
// is linked to) is left out of that email's text, like quoted history; a
// rebuilt email that is NOT in the PDF leaves its text where the plan puts
// it, so nothing is lost, except a forwarded part whose rebuilt email the
// reader unticked (task 8.13a, Q2: left out; "Print full original text"
// prints it). Checked on the whole PDF path (generatePdf, real fonts, our
// own writer), read back from the written file as text, over every
// conversation of Helper/Test/test-support/thread-cases.ts, in several ways:
// - the last email alone, every rebuilt email chosen: each email of the
//   conversation is in the PDF exactly once;
// - the last email alone, some rebuilt emails unticked: those stay in the
//   text of the email that quotes them exactly as with the switch off (a
//   forwarded one is left out), and still nothing is printed twice;
// - every email added as a real file (rebuilt ones linked to them): each
//   email exactly once;
// - the first and the last only: each email exactly once (task 8.13a, Q3,
//   option B: the deliberate repeat of 3a, option A, is gone; a middle
//   email inside an unmarked Outlook quote is cut from the last email and
//   printed as its rebuilt email).
// Header lines are not counted here: only the emails' own sentences are
// (Source/pdf-export/build-pdf-document.header-lines.test.ts checks them).
// An email of the conversation is found by its own sentence (thread-cases.ts,
// SENTENCES: one per email, unique in a conversation), white space ignored
// (a line may wrap anywhere). Synthetic data only (README.md, rule R7).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { instantOf, type ThreadMessage } from '../../Helper/Test/test-support/thread-builder';
import { buildThread } from '../../Helper/Test/test-support/thread-builder';
import { THREAD_CASES, type ThreadCase } from '../../Helper/Test/test-support/thread-cases';
import { readDests, readPageRuns, readPdf, textLines } from '../../Helper/Test/test-support/pdf-reader';
import { analyzeThread } from '../thread-analysis/analyze-thread';
import { DEFAULT_OUTPUT_POLICY, planOutput } from '../thread-analysis/output-plan';
import { rebuiltEntries } from '../web-page-logic/rebuilt-email-display';
import { generatePdf, type PdfFonts } from './generate-pdf';
import { loadPdfFonts } from './load-bundled-fonts';
import { headerLinesEnd, holdsOwnText, holdsQuotedText } from './build-pdf-document';
import type { OutputPolicy } from '../../Header/output-plan';
import type { NormalizedMessage } from '../../Header/parsed-email';
import type { ThreadAnalysisResult } from '../../Header/thread-analysis-result';

let fonts: PdfFonts;
beforeAll(async () =>
{
    fonts = await loadPdfFonts();
});

/** Message `messageIndex` of a conversation as a real file (its body quotes the ones before it). */
function realFile(messages: readonly ThreadMessage[], messageIndex: number, tag: string): NormalizedMessage
{
    const threadMessage = messages[messageIndex]!;
    const messageId = (k: number): string => `${tag}-${String(k)}@example.test`;
    const utcMs = instantOf(threadMessage.sent, threadMessage.zone);
    return {
        messageId: messageId(messageIndex),
        inReplyTo: messageIndex === 0 ? null : messageId(messageIndex - 1),
        references: Array.from({ length: messageIndex }, (_, k) => messageId(k)),
        date: { utcMs, original: new Date(utcMs).toUTCString(), offsetMinutes: threadMessage.zone.offsetMinutes, zoneKnown: true },
        from: [threadMessage.from],
        to: threadMessage.to,
        cc: threadMessage.cc ?? [],
        bcc: [],
        subject: threadMessage.subject,
        bodyText: buildThread(messages.slice(0, messageIndex + 1)).body,
        attachments: [],
        source: { fileName: `${tag}-${String(messageIndex)}.eml`, sha256: (messageIndex + 1).toString(16).padStart(64, '0'), kind: 'eml' },
        warnings: [],
    };
}

const squash = (s: string): string => s.replace(/\s+/gu, ' ').trim();

/** The own sentence of each email of the conversation (the paragraph between the greeting and "Best regards,"), white space squashed. */
function sentences(threadCase: ThreadCase): string[]
{
    return threadCase.messages!.map((threadMessage) =>
    {
        const sentence = threadMessage.text.split('\n\n')[1];
        if (sentence === undefined)
        {
            throw new Error(`${threadCase.id}: no sentence`);
        }
        return squash(sentence);
    });
}

/**
 * The PDF of `dropped` (conversation indices) with the given rebuilt ids (default: every entry; the others
 * unticked by the reader), read back: the text of each email, in PDF order.
 */
async function emailTexts(threadCase: ThreadCase, dropped: readonly number[],
    options: { rebuilt?: (result: ThreadAnalysisResult) => number[]; rebuildingOff?: boolean; policy?: OutputPolicy } = {})
{
    const tag = threadCase.id.replace(/[^a-z0-9]+/giu, '-');
    const result = analyzeThread(dropped.map((i) => ({ ok: true as const, message: realFile(threadCase.messages!, i, tag) })));
    const positions = result.messages.map((_, k) => k);
    const policy = options.policy ?? DEFAULT_OUTPUT_POLICY;
    const plans = planOutput(
        positions.map((p) => result.messages[p]!),
        policy,
    );
    const rebuilt = options.rebuilt?.(result) ?? rebuiltEntries(result).map((r) => r.id);
    // Every rebuilt email not chosen is one the reader unticked (as the review step reports it; ignored with the switch off).
    const unticked = rebuiltEntries(result)
        .map((r) => r.id)
        .filter((id) => !rebuilt.includes(id));
    const made = await generatePdf({ result, positions, plans, rebuilt, rebuildingOff: options.rebuildingOff ?? false, unticked, policy, generatedOffsetMinutes: 0, generatedAt: Date.UTC(2025, 5, 1, 12, 0, 0), fonts, locale: 'en' });
    const pdf = readPdf(made.bytes);
    const pages = (await readPageRuns(pdf)).map((runs) => textLines(runs).map((l) => l.shown).join(' '));
    const dests = readDests(pdf);
    const starts: number[] = [];
    for (let emailNumber = 1; dests.has(`email-${String(emailNumber)}`); emailNumber++)
    {
        starts.push(dests.get(`email-${String(emailNumber)}`)!.page);
    }
    const texts = starts.map((page, k) => squash(pages.slice(page, starts[k + 1] ?? pages.length).join(' ')));
    return { texts, result };
}

/** How many emails of the PDF hold each sentence, and how many times in all. */
function counts(texts: readonly string[], all: readonly string[]): { emails: number; times: number }[]
{
    return all.map((sentence) =>
    {
        let emails = 0;
        let times = 0;
        for (const text of texts)
        {
            const occurrences = text.split(sentence).length - 1;
            if (occurrences > 0)
            {
                emails++;
            }
            times += occurrences;
        }
        return { emails, times };
    });
}

const last = (c: ThreadCase): number => c.messages!.length - 1;

/**
 * Message `conversationIndex` of a conversation is a middle one whose text
 * reaches the last email through unmarked Outlook quotes only: every later
 * message quotes the one before it in an outlook-* style (no ">" marks), so
 * the plan of the last email cannot tell that text from an answer typed in
 * the quote (rule 2b).
 */
function outlookAllTheWay(threadCase: ThreadCase, conversationIndex: number): boolean
{
    if (conversationIndex === 0 || conversationIndex === last(threadCase))
    {
        return false;
    }
    return threadCase.messages!.slice(conversationIndex + 1).every((m) => m.quote?.style.startsWith('outlook') === true);
}

/**
 * The first and the last files only: the middle sentences that option A of
 * 3a printed twice (user decision 2026-11-07), pinned for some named
 * conversations (by conversation index). Since task 8.13a (Q3, option B)
 * each is printed once, as its rebuilt email, and left out of the last
 * email; they are the middle places the plan keeps as own text with no
 * quoted text. A change here is a change of behaviour.
 */
const PINNED_REPEATS: ReadonlyMap<string, readonly number[]> = new Map([
    ['outlook-en x3', [1, 2]],
    ['outlook-en 7 generations', [1, 2, 3, 4, 5, 6]],
    ['fixture-13 shape', [2]],
    ['gmail-fr forward, then outlook-fr reply', [1]],
    // No repeat: a three-message Outlook chain (as observed), and a Gmail chain (">" marks).
    ['outlook-en names only', []],
    ['gmail-en x3', []],
]);
const once = (n: number): { emails: number; times: number }[] => Array.from({ length: n }, () => ({ emails: 1, times: 1 }));

describe('no email twice in the PDF (task 8.10), every conversation of thread-cases.ts', () =>
{
    let untickedForwards = 0;
    afterAll(() =>
    {
        // Task 8.13a, Q2: the forward cases have forwarded parts left out with their unticked rebuilt emails.
        expect(untickedForwards).toBeGreaterThan(3);
    });

    it('has cases with messages, forwards among them', () =>
    {
        expect(THREAD_CASES.every((c) => c.messages !== undefined)).toBe(true);
        expect(THREAD_CASES.filter((c) => c.group === 'forward')).toHaveLength(8);
    });

    for (const threadCase of THREAD_CASES)
    {
        describe(threadCase.id, () =>
        {
            it('the last email alone, every rebuilt email chosen: each email of the conversation exactly once', async () =>
            {
                const { texts } = await emailTexts(threadCase, [last(threadCase)]);
                // Every earlier email is rebuilt in these conversations (README.md, accuracy): one PDF email each, plus the last.
                expect(texts).toHaveLength(threadCase.messages!.length);
                expect(counts(texts, sentences(threadCase))).toEqual(once(threadCase.messages!.length));
                // And each in its own email, in conversation order.
                sentences(threadCase).forEach((s, k) => expect(texts[k], `email ${String(k + 1)}`).toContain(s));
            });

            it('the last email alone, some rebuilt emails unticked: their text as with the switch off (a forwarded one: left out, Q2), never twice', async () =>
            {
                const all = sentences(threadCase);
                const off = counts((await emailTexts(threadCase, [last(threadCase)], { rebuilt: () => [], rebuildingOff: true })).texts, all);
                // Untick every other rebuilt email (the newest kept), in timeline order.
                const { texts, result } = await emailTexts(threadCase, [last(threadCase)], {
                    rebuilt: (r) => rebuiltEntries(r).map((x) => x.id).filter((_, k, list) => (list.length - 1 - k) % 2 === 0),
                });
                const chosen = new Set(rebuiltEntries(result).map((x) => x.id).filter((_, k, list) => (list.length - 1 - k) % 2 === 0));
                expect(texts).toHaveLength(1 + chosen.size);
                const now = counts(texts, all);
                // Never twice.
                for (const [sentenceIndex, sentenceCounts] of now.entries())
                {
                    expect(sentenceCounts.times, `sentence ${String(sentenceIndex)}`).toBeLessThanOrEqual(1);
                }
                // A chosen one is in the PDF once, as its own email; an unticked one exactly as with the switch
                // off, unless it is a forwarded part of the last email (Q2, task 8.13a): then it is nowhere.
                const plan = planOutput(result.messages, DEFAULT_OUTPUT_POLICY)[0]!;
                const forwardedAt = plan.fallback ? null : (plan.ranges.find((r) => r.reason === 'forwarded')?.start ?? null);
                const conversationOf = new Map(rebuiltEntries(result).map((x) => [x.id, threadCase.messages!.length - 1 - x.rebuilt.generation]));
                for (const [id, conversationIndex] of conversationOf)
                {
                    const forwarded = forwardedAt !== null && result.reconstructed[id]!.rebuilt.start >= forwardedAt;
                    if (chosen.has(id))
                    {
                        expect(now[conversationIndex], `chosen ${String(conversationIndex)}`).toEqual({ emails: 1, times: 1 });
                    }
                    else if (forwarded)
                    {
                        untickedForwards++;
                        expect(now[conversationIndex], `unticked forwarded ${String(conversationIndex)}`).toEqual({ emails: 0, times: 0 });
                    }
                    else
                    {
                        expect(now[conversationIndex], `unticked ${String(conversationIndex)}`).toEqual(off[conversationIndex]);
                    }
                }
                expect(now[last(threadCase)]).toEqual({ emails: 1, times: 1 });
            });

            it('every email added as a real file: each exactly once', async () =>
            {
                const { texts } = await emailTexts(
                    threadCase,
                    threadCase.messages!.map((_, k) => k),
                );
                expect(counts(texts, sentences(threadCase))).toEqual(once(threadCase.messages!.length));
            });

            it('the first and the last added: each exactly once (Q3, option B, task 8.13a: the repeat of 3a, option A, is gone)', async () =>
            {
                const { texts, result } = await emailTexts(threadCase, [0, last(threadCase)]);
                // USER DECISION 2026-11-09 (task 8.13a, Q3, option B, replacing option A of review finding
                // 3a): in an unmarked Outlook quote, the plan of the last email (rule 2b of output-plan.ts)
                // can check only the quoted emails that are in the PDF as files: a middle email that is not
                // (here, every one but the first) is labelled the writer's own text ('text') only because it
                // cannot be proved a quote. Its place holds no quoted text, so it is cut from the last email
                // like any other place and printed once, as its rebuilt email (with its header lines on
                // top). The writer's answer next to a quote the plan checked still stays (B1, see
                // Source/pdf-export/build-pdf-document.no-repeat.test.ts).
                const got = counts(texts, sentences(threadCase));
                expect(got).toEqual(once(threadCase.messages!.length));
                // The cases where option A repeated a sentence (PINNED_REPEATS): each is now in its rebuilt email only.
                const lastText = texts[texts.length - 1]!;
                for (const sentenceIndex of PINNED_REPEATS.get(threadCase.id) ?? [])
                {
                    expect(lastText,
                        `sentence ${String(sentenceIndex)} left out of the last email`).not.toContain(sentences(threadCase)[sentenceIndex]);
                    expect(outlookAllTheWay(threadCase, sentenceIndex), `sentence ${String(sentenceIndex)}`).toBe(true);
                }
                // Consistency with the mechanism: those are exactly the middle places the plan keeps as own text, with no quoted text.
                const lastPosition = result.messages.findIndex((m) =>
                    (m.message.messageId ?? '').endsWith(`-${String(last(threadCase))}@example.test`));
                const body = result.messages[lastPosition]!.message.bodyText;
                const plan = planOutput(result.messages, DEFAULT_OUTPUT_POLICY)[lastPosition]!;
                const keptAsOwn = (conversationIndex: number): boolean =>
                {
                    const rebuiltEntry = result.reconstructed.find((x) => result.positionByIndex[x.sourceIndex] === lastPosition
                        && x.rebuilt.generation === last(threadCase) - conversationIndex);
                    return rebuiltEntry !== undefined
                        && holdsOwnText(body, plan.ranges, headerLinesEnd(body, rebuiltEntry.rebuilt), rebuiltEntry.rebuilt.end)
                        && !holdsQuotedText(body, plan.ranges, headerLinesEnd(body, rebuiltEntry.rebuilt), rebuiltEntry.rebuilt.end);
                };
                const pinned = PINNED_REPEATS.get(threadCase.id);
                if (pinned !== undefined)
                {
                    expect(sentences(threadCase).flatMap((_, k) => (k !== 0 && k !== last(threadCase) && keptAsOwn(k) ? [k] : []))).toEqual(pinned);
                }
            });
        });
    }
});
