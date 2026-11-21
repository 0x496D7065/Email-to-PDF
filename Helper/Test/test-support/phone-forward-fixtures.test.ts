// The phone forward fixtures 94 to 98 (Helper/Test/test-data/eml/) are exactly what their
// generator gives (phone-forward-fixtures.ts, from phoneForwardParts in phone-forward-thread.ts):
// change the generator or the thread, never the files by hand.
// To rewrite the five files after such a change (from the project folder):
//   WRITE_PHONE_FORWARD_FIXTURES=1 npx vitest run Helper/Test/test-support/phone-forward-fixtures.test.ts
// then run the whole test suite. Synthetic data only (Helper/Test/test-data/README.md).

import { existsSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hardWrap, phoneForwardFixtureFiles, quotedPrintable } from './phone-forward-fixtures';

const committed = import.meta.glob<string>('/Helper/Test/test-data/eml/9[4-8]-phone-forward-*.eml', { query: '?raw', import: 'default', eager: true });
const generated = phoneForwardFixtureFiles();
// The key prefix of `committed` (project root relative, as import.meta.glob gives it).
const FOLDER = 'Helper/Test/test-data/eml/';
// The same folder on disk, found from this file (not from the current directory).
const WRITE_FOLDER = new URL('../test-data/eml/', import.meta.url);

describe('phone forward fixtures 94 to 98: the committed files are the generator output', () =>
{
    if (import.meta.env['WRITE_PHONE_FORWARD_FIXTURES'] === '1')
    {
        it('rewrites the five files', () =>
        {
            expect(existsSync(WRITE_FOLDER), `the fixture folder ${WRITE_FOLDER.href} must exist`).toBe(true);
            for (const [name, content] of generated)
            {
                writeFileSync(new URL(name, WRITE_FOLDER), content);
            }
            expect(generated.size).toBe(5);
        });
        return;
    }

    it('gives the five files, and only them', () =>
    {
        expect(Object.keys(committed).map((p) => p.slice(p.lastIndexOf('/') + 1)).sort()).toEqual([...generated.keys()].sort());
    });

    it.each([...generated.keys()].map((name) => [name]))('%s is byte for byte the generator output', (name) =>
    {
        const file = committed[`/${FOLDER}${name}`];
        expect(file, `${name}: rewrite it (see the comment at the top of this file)`).toBe(generated.get(name));
    });

    it('writes ASCII only, CRLF line breaks, no line over 76 characters but two header lines', () =>
    {
        for (const [name, content] of generated)
        {
            expect(/^[\x20-\x7e\r\n]*$/u.test(content), name).toBe(true);
            expect(content.replace(/\r\n/gu, '').includes('\n') || content.replace(/\r\n/gu, '').includes('\r'), name).toBe(false);
            expect(content.split('\r\n').filter((l) => l.length > 76 && !/^(Subject|X-Android-Message-ID): /u.test(l)), name).toEqual([]);
        }
    });
});

describe('the encoders of the generator', () =>
{
    it('quotedPrintable: "=" and non-ASCII encoded, soft breaks within 76 characters, a space at a line end encoded', () =>
    {
        expect(quotedPrintable('a=b \u00e9 \n')).toBe('a=3Db =C3=A9=20\r\n');
        expect(quotedPrintable(`${'x'.repeat(74)}\u00e9y`)).toBe(`${'x'.repeat(74)}=\r\n=C3=A9y`);
        // A piece may end between the two bytes of one letter (the decoder joins them).
        expect(quotedPrintable(`${'x'.repeat(72)}\u00e9y`)).toBe(`${'x'.repeat(72)}=C3=\r\n=A9y`);
        expect(quotedPrintable(`${'x'.repeat(75)}`)).toBe('x'.repeat(75));
        expect(quotedPrintable(`${'x'.repeat(76)}`)).toBe(`${'x'.repeat(75)}=\r\nx`);
    });

    it('hardWrap: breaks at the last space within 76 characters, drops that space, leaves short lines', () =>
    {
        const words = `${'a'.repeat(40)} ${'b'.repeat(35)} c`;
        expect(hardWrap(words)).toBe(`${'a'.repeat(40)} ${'b'.repeat(35)}\nc`);
        expect(hardWrap('short line\n')).toBe('short line\n');
    });
});
