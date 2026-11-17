// Windows code page numbers, as stored in Outlook .msg files, mapped to the
// text encoding labels the browser's TextDecoder understands.

/**
 * Outlook code page numbers (Windows code page identifiers) -> encoding labels
 * the browser's TextDecoder understands (the WHATWG Encoding Standard). The
 * iconv-lite shim used by msgreader only accepts such labels.
 */
const CODEPAGE_ENCODINGS: ReadonlyMap<number, string> = new Map([
    [866, 'ibm866'],
    [874, 'windows-874'],
    [932, 'shift_jis'],
    [936, 'gbk'],
    [949, 'euc-kr'],
    [950, 'big5'],
    [1200, 'utf-16le'],
    [1201, 'utf-16be'],
    [1250, 'windows-1250'],
    [1251, 'windows-1251'],
    [1252, 'windows-1252'],
    [1253, 'windows-1253'],
    [1254, 'windows-1254'],
    [1255, 'windows-1255'],
    [1256, 'windows-1256'],
    [1257, 'windows-1257'],
    [1258, 'windows-1258'],
    [10000, 'macintosh'],
    [20127, 'us-ascii'],
    [20866, 'koi8-r'],
    [20936, 'gbk'],
    [21866, 'koi8-u'],
    [28591, 'iso-8859-1'],
    [28592, 'iso-8859-2'],
    [28593, 'iso-8859-3'],
    [28594, 'iso-8859-4'],
    [28595, 'iso-8859-5'],
    [28596, 'iso-8859-6'],
    [28597, 'iso-8859-7'],
    [28598, 'iso-8859-8'],
    [28599, 'iso-8859-9'],
    [28603, 'iso-8859-13'],
    [28605, 'iso-8859-15'],
    [38598, 'iso-8859-8-i'],
    [50220, 'iso-2022-jp'],
    [50221, 'iso-2022-jp'],
    [50222, 'iso-2022-jp'],
    [51932, 'euc-jp'],
    [51949, 'euc-kr'],
    [54936, 'gb18030'],
    [65001, 'utf-8'],
]);

/**
 * The TextDecoder label for an Outlook code page number, or null if the code
 * page is missing, not a number, not in CODEPAGE_ENCODINGS, or not supported
 * by this browser (TextDecoder throws a RangeError for unknown labels).
 */
export function encodingForCodepage(codepage: unknown): string | null
{
    if (typeof codepage !== 'number') return null;
    const label = CODEPAGE_ENCODINGS.get(codepage);
    if (label === undefined) return null;
    try
    {
        new TextDecoder(label);
        return label;
    }
    catch (error)
    {
        if (error instanceof RangeError) return null;
        throw error;
    }
}

/** Every label in the table, for tests that check each one is a valid TextDecoder label. */
export function allCodepageLabels(): string[]
{
    return [...new Set(CODEPAGE_ENCODINGS.values())];
}
