// Decides which parser reads a dropped file: by its name AND by its first
// bytes, so a renamed file still goes to the parser that can read it.
//
// Rules (README.md, rule R4: email input is untrusted):
// - The file starts with the Compound File signature (D0 CF 11 E0 A1 B1 1A E1),
//   the container classic Outlook uses for .msg:
//     - named .msg or .eml -> read as .msg. Outlook can save a message as
//       .msg under any name, and the .eml parser cannot read this binary
//       format at all. A Compound File that is not an Outlook message (a
//       renamed Word .doc) is then rejected by the .msg parser with a clear
//       detail;
//     - any other name -> 'unsupported-type' (a .doc, .xls, ... file).
// - Named .msg WITHOUT the signature:
//     - if it starts like an email header ("Name: value" on the first
//       line) -> read as .eml: some programs save a plain internet message
//       under a .msg name;
//     - otherwise -> 'corrupt': it is not a readable Outlook file (cut off,
//       damaged, or something else renamed).
// - Named .eml WITHOUT the signature: read as .eml, unless the start of the
//   file holds NUL bytes (binary data, never in an internet message) ->
//   'unsupported-type'.
// - An empty file -> 'corrupt' (nothing to read).
// - Any other name -> 'unsupported-type'.
// The extension is compared without regard to case (".EML", ".Msg").

import type { FileKind } from '../../Header/parse-worker-messages';
import type { ParseErrorCode } from '../../Header/parsed-email';

/** Where a file goes: a parser, or a rejection with a short reason for the preview. */
export type FileTypeDecision =
    | { readonly kind: FileKind }
    | { readonly error: ParseErrorCode; readonly detail: string };

/** Compound File signature ([MS-CFB] 2.2, "Header Signature"). */
const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;

/** How many leading bytes are looked at to tell text from binary. */
const SNIFF_LENGTH = 4096;

/** True if `bytes` starts with the Compound File signature. */
export function hasCfbSignature(bytes: Uint8Array): boolean
{
    return bytes.length >= CFB_SIGNATURE.length && CFB_SIGNATURE.every((b, i) => bytes[i] === b);
}

/** The lower-case extension after the last dot ("" if none): "Mail.EML" -> "eml". */
export function extensionOf(name: string): string
{
    const dot = name.lastIndexOf('.');
    return dot === -1 ? '' : name.slice(dot + 1).toLowerCase();
}

/**
 * True if the file starts like an internet message: its first line is a
 * header field ("Name: value", RFC 5322 field name = printable ASCII except
 * ":"), after an optional UTF-8 byte order mark.
 */
export function startsLikeEmailHeader(bytes: Uint8Array): boolean
{
    let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    const start = i;
    // A field name is at most a few dozen characters; 256 is generous.
    while (i < bytes.length && i - start < 256)
    {
        const b = bytes[i] ?? 0;
        if (b === 0x3a)
        {
            return i > start; // ':' after at least one name character
        }
        if (b < 0x21 || b > 0x7e)
        {
            return false;
        }
        i++;
    }
    return false;
}

/** True if the first SNIFF_LENGTH bytes contain a NUL byte (binary data). */
function hasNulNearStart(bytes: Uint8Array): boolean
{
    return bytes.subarray(0, SNIFF_LENGTH).includes(0);
}

/** Decides which parser reads `name` / `bytes`, see the rules at the top of this file. */
export function detectFileType(name: string, bytes: Uint8Array): FileTypeDecision
{
    const extension = extensionOf(name);
    if (extension !== 'eml' && extension !== 'msg')
    {
        return { error: 'unsupported-type', detail: 'not an email file: only .eml and .msg files can be read' };
    }
    if (bytes.length === 0)
    {
        return { error: 'corrupt', detail: 'the file is empty' };
    }
    if (hasCfbSignature(bytes))
    {
        return { kind: 'msg' };
    }
    if (extension === 'msg')
    {
        if (startsLikeEmailHeader(bytes))
        {
            return { kind: 'eml' };
        }
        return { error: 'corrupt', detail: 'damaged file structure: this is not a readable Outlook message file' };
    }
    if (hasNulNearStart(bytes))
    {
        return { error: 'unsupported-type', detail: 'not an email file: the file holds binary data' };
    }
    return { kind: 'eml' };
}
