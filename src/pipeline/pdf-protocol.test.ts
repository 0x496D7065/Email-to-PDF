// Unit tests for the PDF worker's messages and its side of the conversation
// (pdf-protocol.ts), in Node without a browser: the real makePdf (fonts
// parsed from their bytes, as the worker does) and fakes. Synthetic emails
// only (made-up names, *.test addresses). The real worker is
// checked in Chromium by e2e/download.spec.ts.

import { describe, expect, it } from 'vitest';
import { readPdf } from '../../tests/support/pdf-reader';
import { runEngine } from '../engine/engine';
import { DEFAULT_OUTPUT_POLICY, planOutput } from '../engine/output-plan';
import type { NormalizedMessage, ParseResult } from '../parsing/types';
import { PDF_FONTS } from '../pdf/fonts';
import type { GeneratedPdf } from '../pdf/generate';
import { createPdfWorkerSide, isFromPdfWorker, isToPdfWorker, makePdf, ownBuffer, type FromPdfWorker, type MakePdfRequest, type PdfJobInput } from './pdf-protocol';

function make(k: number): NormalizedMessage {
  const n = String(k + 1);
  return {
    messageId: `protocol-${n}@example.test`,
    inReplyTo: null,
    references: [],
    date: { utcMs: Date.UTC(2025, 2, 4, 8) + k * 3_600_000, original: 'Tue, 4 Mar 2025 08:00:00 +0000', offsetMinutes: 0, zoneKnown: true },
    from: [{ name: 'Alice Example', address: 'alice@example.test' }],
    to: [{ name: 'Bob Sample', address: 'bob@sample.test' }],
    cc: [],
    bcc: [],
    subject: `Garden bench, part ${n}`,
    bodyText: `Hello Bob,\n\nThe bench is painted green, note ${n}.\n\nAlice\n`,
    attachments: [],
    source: { fileName: `bench-${n}.eml`, sha256: (k + 1).toString(16).padStart(64, '0'), kind: 'eml' },
    warnings: [],
  };
}

function inputFor(count: number): PdfJobInput {
  const result = runEngine(Array.from({ length: count }, (_, k): ParseResult => ({ ok: true, message: make(k) })));
  const positions = result.messages.map((_, k) => k);
  const plans = planOutput(
    positions.map((p) => result.messages[p]!),
    DEFAULT_OUTPUT_POLICY,
  );
  return { result, positions, plans, policy: DEFAULT_OUTPUT_POLICY, timeZone: 'Asia/Tokyo', generatedAt: Date.UTC(2025, 5, 1, 20, 0, 0), locale: 'en' };
}

const REQUEST: MakePdfRequest = { type: 'make', input: inputFor(3), fonts: PDF_FONTS };

describe('message checks', () => {
  it('accepts a well-formed request', () => {
    expect(isToPdfWorker(REQUEST)).toBe(true);
    // Through structured clone too (what the worker really receives).
    expect(isToPdfWorker(structuredClone(REQUEST))).toBe(true);
  });

  it.each([
    ['null', null],
    ['another type', { ...REQUEST, type: 'run' }],
    ['no input', { type: 'make', fonts: PDF_FONTS }],
    ['no fonts', { type: 'make', input: REQUEST.input }],
    ['a missing font', { ...REQUEST, fonts: { ...PDF_FONTS, 'mono-regular': undefined } }],
    ['a font that is not bytes', { ...REQUEST, fonts: { ...PDF_FONTS, 'sans-bold': [1, 2, 3] } }],
    ['positions and plans of different lengths', { ...REQUEST, input: { ...REQUEST.input, positions: [0, 1] } }],
    ['no time zone', { ...REQUEST, input: { ...REQUEST.input, timeZone: undefined } }],
    ['no generation time', { ...REQUEST, input: { ...REQUEST.input, generatedAt: '2025-06-01' } }],
    ['no result', { ...REQUEST, input: { ...REQUEST.input, result: null } }],
    ['no policy', { ...REQUEST, input: { ...REQUEST.input, policy: null } }],
    // The worker never falls back to a language of its own.
    ['no language', { ...REQUEST, input: { ...REQUEST.input, locale: undefined } }],
    ['a language the page does not ship', { ...REQUEST, input: { ...REQUEST.input, locale: 'xx' } }],
    ['a language tag that is not exactly a shipped code', { ...REQUEST, input: { ...REQUEST.input, locale: 'en-US' } }],
    ['a language code in capitals', { ...REQUEST, input: { ...REQUEST.input, locale: 'EN' } }],
    ['a language that is not a string', { ...REQUEST, input: { ...REQUEST.input, locale: ['en'] } }],
  ])('rejects %s as a request', (_label, data) => {
    expect(isToPdfWorker(data)).toBe(false);
  });

  it('accepts a PDF and a failure from the worker', () => {
    expect(isFromPdfWorker({ type: 'done', bytes: new Uint8Array(1), fileName: 'a.pdf', pageCount: 2 })).toBe(true);
    expect(isFromPdfWorker({ type: 'failed' })).toBe(true);
  });

  it.each([
    ['null', null],
    ['an unknown type', { type: 'progress' }],
    ['bytes that are not bytes', { type: 'done', bytes: [1], fileName: 'a.pdf', pageCount: 2 }],
    ['no file name', { type: 'done', bytes: new Uint8Array(1), pageCount: 2 }],
    ['a broken page count', { type: 'done', bytes: new Uint8Array(1), fileName: 'a.pdf', pageCount: 1.5 }],
    ['a negative page count', { type: 'done', bytes: new Uint8Array(1), fileName: 'a.pdf', pageCount: -1 }],
  ])('rejects %s from the worker', (_label, data) => {
    expect(isFromPdfWorker(data)).toBe(false);
  });
});

describe('ownBuffer', () => {
  it('uses a view over a whole buffer as it is, copies a part of a larger one', () => {
    const whole = new Uint8Array([1, 2, 3]);
    expect(ownBuffer(whole).buffer).toBe(whole.buffer);
    const big = new Uint8Array([9, 1, 2, 3, 9]);
    const part = ownBuffer(big.subarray(1, 4));
    expect([...part]).toEqual([1, 2, 3]);
    expect(part.buffer).not.toBe(big.buffer);
    expect(part.byteLength).toBe(part.buffer.byteLength);
  });
});

describe('makePdf (the worker\'s work, fonts parsed from their bytes)', () => {
  it('makes the PDF of the request, named after the generation day in the chosen zone', async () => {
    const pdf = await makePdf(structuredClone(REQUEST));
    expect(new TextDecoder().decode(pdf.bytes.subarray(0, 5))).toBe('%PDF-');
    // 2025-06-01 20:00 UTC is already 2 June in Tokyo.
    expect(pdf.fileName).toBe('correspondence-2025-06-02.pdf');
    expect(pdf.pageCount).toBe(readPdf(pdf.bytes).pages().length);
    expect(pdf.pageCount).toBeGreaterThanOrEqual(3);
  });

  it('rejects for a broken font (the worker then says "failed")', async () => {
    await expect(makePdf({ ...REQUEST, fonts: { ...PDF_FONTS, 'sans-regular': new Uint8Array(10) } })).rejects.toThrow();
  });
});

describe('createPdfWorkerSide', () => {
  const FAKE: GeneratedPdf = { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), fileName: 'correspondence-2025-06-01.pdf', pageCount: 2 };

  function side(make: (request: MakePdfRequest) => Promise<GeneratedPdf> = () => Promise.resolve(FAKE)) {
    const posted: { message: FromPdfWorker; transfer: Transferable[] }[] = [];
    const handle = createPdfWorkerSide((message, transfer) => posted.push({ message, transfer }), make);
    return { posted, handle };
  }

  it('makes the PDF and MOVES its bytes to the page', async () => {
    const { posted, handle } = side();
    await handle(REQUEST);
    expect(posted).toHaveLength(1);
    const [{ message, transfer } = { message: null, transfer: [] }] = posted;
    expect(message).toEqual({ type: 'done', bytes: FAKE.bytes, fileName: FAKE.fileName, pageCount: 2 });
    expect(transfer).toEqual([(message as { bytes: Uint8Array }).bytes.buffer]);
  });

  it('works end to end with the real makePdf', async () => {
    const { posted, handle } = side(makePdf);
    await handle(structuredClone(REQUEST));
    const message = posted[0]?.message;
    expect(message?.type).toBe('done');
    if (message?.type !== 'done') return;
    expect(isFromPdfWorker(message)).toBe(true);
    expect(message.pageCount).toBe(readPdf(message.bytes).pages().length);
  });

  it('says "failed" (no details) when making the PDF throws', async () => {
    const { posted, handle } = side(() => Promise.reject(new Error('Bob Sample secret detail')));
    await handle(REQUEST);
    expect(posted).toEqual([{ message: { type: 'failed' }, transfer: [] }]);
  });

  it('says "failed" when the PDF cannot be sent', async () => {
    let calls = 0;
    const posted: FromPdfWorker[] = [];
    const handle = createPdfWorkerSide(
      (message) => {
        calls++;
        if (calls === 1) throw new Error('DataCloneError');
        posted.push(message);
      },
      () => Promise.resolve(FAKE),
    );
    await handle(REQUEST);
    expect(posted).toEqual([{ type: 'failed' }]);
  });

  it('ignores malformed messages and a second request', async () => {
    let made = 0;
    const { posted, handle } = side(() => {
      made++;
      return Promise.resolve(FAKE);
    });
    await handle({ type: 'make' });
    await handle(null);
    expect(posted).toEqual([]);
    await handle(REQUEST);
    await handle(REQUEST);
    expect(made).toBe(1);
    expect(posted).toHaveLength(1);
  });
});
