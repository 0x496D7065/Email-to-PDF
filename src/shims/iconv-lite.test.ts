// Proves that the .msg parser (@kenjiuno/msgreader) works with our
// iconv-lite shim instead of the real Node-only package.
//
// The .msg files are SYNTHETIC: built in memory with msgreader's own writer
// (`burn`), never read from disk (README.md, rule R7; no real emails).
import MsgReader from '@kenjiuno/msgreader';
import { burn, type Entry } from '@kenjiuno/msgreader/lib/Burner';
import DataStream from '@kenjiuno/msgreader/lib/DataStream';
import { TypeEnum } from '@kenjiuno/msgreader/lib/Reader';
import { describe, expect, it } from 'vitest';

/** A string as UTF-16LE bytes, like .msg "Unicode" (PT_UNICODE, ...001F) properties. */
function utf16le(text: string): Uint8Array
{
    const bytes = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++)
    {
        const code = text.charCodeAt(i);
        bytes[2 * i] = code & 0xff;
        bytes[2 * i + 1] = code >> 8;
    }
    return bytes;
}

/** Builds a minimal .msg in memory: a root folder holding one stream per property. */
function buildMsg(streams: Record<string, Uint8Array>): DataView
{
    const entries: Entry[] = [{ name: 'Root Entry', type: TypeEnum.ROOT, children: [], length: 0 }];
    for (const [name, bytes] of Object.entries(streams))
    {
        entries[0]?.children?.push(entries.length);
        entries.push({ name, type: TypeEnum.DOCUMENT, binaryProvider: () => bytes, length: bytes.length });
    }
    const bytes = burn(entries);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

describe('iconv-lite shim with msgreader', () =>
{
    it('reads a Unicode subject and plain body with non-ASCII characters', () =>
    {
        const msg = buildMsg({
            // 0037 = subject, 1000 = plain-text body; type 001F = UTF-16LE string.
            '__substg1.0_0037001F': utf16le('Café meeting'),
            '__substg1.0_1000001F': utf16le('Hello from café.'),
        });
        const fields = new MsgReader(msg).getFileData();
        expect(fields.subject).toBe('Café meeting');
        expect(fields.body).toBe('Hello from café.');
    });

    it('decodes an ANSI (windows-1252) subject through the shim', () =>
    {
        // Type 001E = 8-bit "ANSI" string: decoded by iconv-lite.decode(), i.e. our shim.
        const msg = buildMsg({ '__substg1.0_0037001E': new Uint8Array([0x43, 0x61, 0x66, 0xe9]) }); // "Caf" + é
        const reader = new MsgReader(msg);
        reader.parserConfig = { ansiEncoding: 'windows-1252' };
        const fields = reader.getFileData();
        expect(fields.subject).toBe('Café');
    });

    it('is really the shim that msgreader loads (encode throws our message)', () =>
    {
        const stream = new DataStream(new ArrayBuffer(16), 0, DataStream.LITTLE_ENDIAN);
        expect(() => stream.writeString('x', 'windows-1252', 1)).toThrow('iconv-lite shim');
    });
});
