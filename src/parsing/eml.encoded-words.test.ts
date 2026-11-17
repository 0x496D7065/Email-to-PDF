// Unit test for the .eml adapter on a header made of very many joinable
// RFC 2047 base64 encoded words (advisory GHSA-f2hq-32vh-53cc: postal-mime
// before 4.0.8 took quadratic time on such a header, so one small hostile
// file could freeze the parse worker). Synthetic input only (README.md,
// rule R7).
//
// The time bound leaves room for a slow CI machine: postal-mime 4.0.8 parses
// this file in about 35 ms, while the quadratic decoder of 4.0.5 needed about
// 3,000 ms, three times the bound (measured when the library was upgraded,
// task 9.5).

import { describe, expect, it } from 'vitest';
import { createEmlParser } from './eml';
import type { HtmlToTextResult } from './html-to-text';

const htmlToText = (html: string): HtmlToTextResult => ({ text: html, truncated: false });

/**
 * `count` adjacent base64 encoded words of three letters each, so none has a
 * "=" pad and every one may be joined to the one before:
 * "=?UTF-8?B?YWJj?= =?UTF-8?B?YmNk?= ..." ("abc", "bcd", ...).
 */
function joinableWords(count: number): { header: string; decoded: string } {
  const words = Array.from({ length: count }, (_, k) =>
    [0, 1, 2].map((j) => String.fromCharCode(97 + ((k + j) % 26))).join(''),
  );
  return { header: words.map((w) => `=?UTF-8?B?${btoa(w)}?=`).join(' '), decoded: words.join('') };
}

describe('createEmlParser: a header of very many joinable base64 encoded words', () => {
  it('is decoded in full and in linear time, not quadratic', async () => {
    // 100,000 words: a 1.7 MB header, under postal-mime's 2 MiB header limit (eml.ts).
    const COUNT = 100_000;
    const { header, decoded } = joinableWords(COUNT);
    const file = new TextEncoder().encode(
      [
        'From: Alice Example <alice@example.test>',
        'To: Bob Sample <bob@example.test>',
        `Subject: ${header}`,
        'Date: Tue, 3 Jun 2025 14:05:09 +0200',
        'Message-ID: <many-words@example.test>',
        'MIME-Version: 1.0',
        '',
        'Body text.',
        '',
      ].join('\r\n'),
    );
    const started = Date.now();
    const result = await createEmlParser({ htmlToText }).parse({ name: 'many-words.eml', bytes: file });
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.subject).toBe(decoded);
    expect(result.message.bodyText).toBe('Body text.\n');
    expect(elapsed).toBeLessThan(1000);
  });
});
