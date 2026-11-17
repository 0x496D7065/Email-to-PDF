// SHA-256 of a file's bytes. The app uses it to recognize a file again: the
// reader's include/exclude choices are kept by file hash
// (src/ui-model/selection.ts) and so are the ids of rebuilt emails
// (src/ui-model/rebuilt.ts). It is no longer printed in the PDF (user
// decision 2026-11-09, task 8.12).
//
// Uses the Web Crypto API (`crypto.subtle`), built into every modern browser
// and into Node 22 as a global, so no hashing library is needed. It runs
// locally: nothing is sent anywhere.

/** Returns the SHA-256 of `bytes` as 64 lowercase hex characters. */
export async function sha256Hex(bytes: Uint8Array): Promise<string>
{
    // digest() is typed to want a buffer backed by a plain ArrayBuffer; the
    // `as` tells TypeScript that ours is (a Uint8Array from a File always is).
    // A view backed by a SharedArrayBuffer would be rejected by digest() at
    // runtime; the app never creates one.
    const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
    // Each byte becomes two hex digits, e.g. 10 -> "0a".
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
