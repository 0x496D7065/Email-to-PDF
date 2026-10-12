// Unit test for the .eml adapter when postal-mime's internals change while an
// inline forwarded message is parsed. It lives in its own file because it
// mocks ./eml-tree: every other test uses the real module. Synthetic data
// only (README.md, rule R7).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmlParser } from './eml';
import { parseEmlTree, PostalMimeInternalsError } from './eml-tree';

// parseEmlTree is wrapped in a spy that calls the real function, so each test
// can make one chosen call fail. PostalMimeInternalsError stays the real class.
vi.mock('./eml-tree', async (importOriginal) => {
  const original = await importOriginal<typeof import('./eml-tree')>();
  return { ...original, parseEmlTree: vi.fn(original.parseEmlTree) };
});

const realParseEmlTree = (await vi.importActual<typeof import('./eml-tree')>('./eml-tree')).parseEmlTree;

/** An outer message with one text part and one inline forwarded message. */
const DATA = new TextEncoder().encode(
  [
    'From: alice@example.test',
    'Date: Tue, 3 Jun 2025 14:05:09 +0200',
    'Message-ID: <outer@example.test>',
    'Content-Type: multipart/mixed; boundary="b"',
    '',
    '--b',
    'Content-Type: text/plain',
    '',
    'Outer text.',
    '--b',
    'Content-Type: message/rfc822',
    '',
    'From: carol@example.test',
    'Subject: Inner',
    '',
    'Inner text.',
    '--b--',
    '',
  ].join('\r\n'),
);

const parser = createEmlParser({ htmlToText: () => ({ text: '', truncated: false }) });

/** Lets the first parseEmlTree call (the file) run for real and makes the second (the forward) throw. */
function failSecondCall(error: Error): void {
  vi.mocked(parseEmlTree)
    .mockImplementationOnce(realParseEmlTree)
    .mockImplementationOnce(() => Promise.reject(error));
}

describe('createEmlParser: errors while parsing an inline forwarded message', () => {
  beforeEach(() => {
    vi.mocked(parseEmlTree).mockClear();
  });

  it('a PostalMimeInternalsError is re-thrown: the file is corrupt, never a quiet unexpanded forward', async () => {
    failSecondCall(new PostalMimeInternalsError('simulated change'));
    const result = await parser.parse({ name: 'f.eml', bytes: DATA });
    expect(vi.mocked(parseEmlTree)).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe('corrupt');
    expect(result.detail).toMatch(/^postal-mime internals changed/);
    expect(result.detail).toContain('simulated change');
  });

  it('any other error only leaves the forward unexpanded (control case)', async () => {
    failSecondCall(new Error('broken inner message'));
    const result = await parser.parse({ name: 'f.eml', bytes: DATA });
    expect(vi.mocked(parseEmlTree)).toHaveBeenCalledTimes(2);
    if (!result.ok) throw new Error(`expected ok, got ${result.error}: ${result.detail}`);
    expect(result.message.bodyText).toBe('Outer text.');
    expect(result.message.warnings).toEqual(['forwarded-message-not-expanded']);
    expect(result.message.attachments).toHaveLength(1);
  });
});
