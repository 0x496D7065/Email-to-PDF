// The PDF file structure: header, numbered objects, the classic
// cross-reference table and the trailer. The output is kept as a list of
// byte chunks with a running offset (no giant string), so documents of tens
// of megabytes are fine; the total is capped (MAX_OUTPUT_BYTES).
//
// Peak memory is about twice the output: finish() copies the chunks into
// the final buffer before letting them go, so a file at the cap needs about
// 2 x MAX_OUTPUT_BYTES (512 MiB for the default 256 MiB cap) in the worker.
//
// Deterministic: the /ID is derived from a SHA-256 of the bytes before the
// trailer (Web Crypto, available in pages and workers), so the same input
// always gives the same file. No dates anywhere.
import { ascii, fail, int } from './syntax';

/** Largest PDF the writer produces (256 MiB; about twice that is needed while writing, see above). */
export const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;

/** "%PDF-1.7", then a comment with 4 bytes above 127 so tools treat the file as binary. */
const HEADER = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]);

export class PdfFile {
  private readonly chunks: Uint8Array[] = [];
  private size = 0;
  /** offsets[n] = byte offset of object n (index 0 unused). */
  private readonly offsets: (number | undefined)[] = [undefined];

  constructor(private readonly maxBytes: number = MAX_OUTPUT_BYTES) {
    this.push(HEADER);
  }

  /** Reserves the next object number. */
  alloc(): number {
    this.offsets.push(undefined);
    return this.offsets.length - 1;
  }

  /** Writes object `n` with `body` (PDF syntax, ASCII). */
  object(n: number, body: string): void {
    this.begin(n);
    this.push(ascii(`${n} 0 obj\n${body}\nendobj\n`));
  }

  /** Writes stream object `n`: `entries` are extra dictionary entries (ASCII), /Length is added. */
  stream(n: number, entries: string, data: Uint8Array): void {
    this.begin(n);
    this.push(ascii(`${n} 0 obj\n<< /Length ${int(data.length)}${entries === '' ? '' : ' ' + entries} >>\nstream\n`));
    this.push(data);
    this.push(ascii('\nendstream\nendobj\n'));
  }

  /** The finished file: cross-reference table and trailer appended. Briefly holds the chunks and the result (about 2x the output). */
  async finish(root: number, info: number): Promise<Uint8Array<ArrayBuffer>> {
    const count = this.offsets.length;
    const lines: string[] = ['xref\n', `0 ${count}\n`, '0000000000 65535 f \n'];
    for (let n = 1; n < count; n++) {
      const offset = this.offsets[n];
      if (offset === undefined) fail(`internal: object ${n} was reserved but never written`);
      lines.push(`${String(offset).padStart(10, '0')} 00000 n \n`);
    }
    const xrefAt = this.size;
    this.push(ascii(lines.join('')));

    // The trailer's length does not depend on the /ID value (always 32 hex
    // digits), so the whole file is allocated once and the body hashed in place.
    const trailer = (id: string): Uint8Array =>
      ascii(`trailer\n<< /Size ${count} /Root ${root} 0 R /Info ${info} 0 R /ID [<${id}> <${id}>] >>\nstartxref\n${xrefAt}\n%%EOF\n`);
    const trailerLength = trailer('0'.repeat(32)).length;
    this.checkSize(trailerLength);
    const bodyLength = this.size;
    const result = new Uint8Array(bodyLength + trailerLength);
    let at = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, at);
      at += chunk.length;
    }
    this.chunks.length = 0; // the chunks are in `result` now: let them go
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', result.subarray(0, bodyLength)));
    let id = '';
    for (const byte of digest.subarray(0, 16)) id += byte.toString(16).toUpperCase().padStart(2, '0');
    result.set(trailer(id), bodyLength);
    return result;
  }

  private begin(n: number): void {
    if (!Number.isInteger(n) || n < 1 || n >= this.offsets.length) fail(`internal: object ${n} was never reserved`);
    if (this.offsets[n] !== undefined) fail(`internal: object ${n} written twice`);
    this.offsets[n] = this.size;
  }

  private checkSize(extra: number): void {
    if (this.size + extra > this.maxBytes) {
      fail(`the PDF would be larger than ${Math.floor(this.maxBytes / (1024 * 1024))} MiB`);
    }
  }

  private push(bytes: Uint8Array): void {
    this.checkSize(bytes.length);
    this.chunks.push(bytes);
    this.size += bytes.length;
  }
}
