// Shared helpers of the font reader (src/pdf/font/): a bounds-checked
// big-endian reader, the font error type, the limits, and the sfnt table
// checksum.
//
// The font reader is pure and worker-safe (pure, as in rule R7): no DOM, no
// Node APIs, no network (rule R1). Every count and offset comes from the
// file, so each one is checked against the data length before use, and every
// loop is bounded by a count that has already been checked that way.

/** The one error type the font reader throws for damaged or unsupported input. */
export class FontError extends Error {
  override name = 'FontError';
}

/** Throws a FontError. Typed `never` so callers can use it as an expression. */
export function fail(message: string): never {
  throw new FontError(message);
}

/**
 * Turns anything caught into a FontError (an Error is wrapped with its
 * message and kept as the cause; a thrown non-Error becomes a plain message),
 * so the reader never lets a non-Error escape.
 */
export function toFontError(error: unknown, context: string): FontError {
  if (error instanceof FontError) return error;
  if (error instanceof Error) return new FontError(`${context}: ${error.message}`, { cause: error });
  return new FontError(`${context}: unexpected failure`);
}

/** Largest WOFF file or decompressed font accepted (16 MiB). Plex is about 0.2 MB. */
export const MAX_FONT_BYTES = 16 * 1024 * 1024;

/** sfnt version of TrueType outlines, the only flavor FontFile2 accepts. */
export const TRUETYPE_FLAVOR = 0x00010000;

/** Most tables accepted in a font. Plex has 17 or 18; real fonts rarely pass 30. */
export const MAX_TABLES = 64;

/** The 4 bytes of a table tag as text, e.g. 0x68656164 -> "head". */
export function tagName(tag: number): string {
  return String.fromCharCode((tag >>> 24) & 0xff, (tag >>> 16) & 0xff, (tag >>> 8) & 0xff, tag & 0xff);
}

/** Rounds a length up to a multiple of 4 (sfnt tables are 4-byte aligned). */
export function pad4(length: number): number {
  return (length + 3) & ~3;
}

/**
 * Big-endian reads from a byte range, each checked against its end. A read
 * outside the range is a FontError naming `label`, never a silent undefined.
 */
export class BinaryReader {
  readonly length: number;
  private readonly view: DataView;

  constructor(
    readonly bytes: Uint8Array,
    readonly label: string,
  ) {
    this.length = bytes.length;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** Fails unless `size` bytes from `offset` are inside the range. */
  need(offset: number, size: number, what = 'data'): void {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 0 || offset + size > this.length) {
      fail(`${this.label}: ${what} at byte ${offset} (${size} bytes) is past the end (${this.length} bytes)`);
    }
  }

  u8(offset: number): number {
    this.need(offset, 1);
    return this.view.getUint8(offset);
  }

  u16(offset: number): number {
    this.need(offset, 2);
    return this.view.getUint16(offset);
  }

  i16(offset: number): number {
    this.need(offset, 2);
    return this.view.getInt16(offset);
  }

  u32(offset: number): number {
    this.need(offset, 4);
    return this.view.getUint32(offset);
  }

  i32(offset: number): number {
    this.need(offset, 4);
    return this.view.getInt32(offset);
  }

  /** A view (not a copy) of `size` bytes from `offset`. */
  slice(offset: number, size: number, what?: string): Uint8Array {
    this.need(offset, size, what);
    return this.bytes.subarray(offset, offset + size);
  }
}

/**
 * The sfnt table checksum: the sum, modulo 2^32, of the table read as
 * big-endian uint32 values, the last one padded with zero bytes.
 */
export function tableChecksum(bytes: Uint8Array, offset: number, length: number): number {
  if (offset < 0 || length < 0 || offset + length > bytes.length) fail('checksum range is past the end of the data');
  let sum = 0;
  const end = offset + length;
  const whole = offset + (length & ~3);
  for (let i = offset; i < whole; i += 4) {
    // `bytes[i]!`: i < whole <= end <= bytes.length, checked above.
    sum = (sum + ((bytes[i]! << 24) | (bytes[i + 1]! << 16) | (bytes[i + 2]! << 8) | bytes[i + 3]!)) >>> 0;
  }
  if (whole < end) {
    let last = 0;
    for (let i = 0; i < 4; i++) last = (last << 8) | (whole + i < end ? bytes[whole + i]! : 0);
    sum = (sum + (last >>> 0)) >>> 0;
  }
  return sum;
}

/** The tag "head" as a uint32, used by the checksum special case. */
export const TAG_HEAD = 0x68656164;

/**
 * The checksum of a table as stored in a font directory. For 'head' it is
 * computed with head.checkSumAdjustment (bytes 8 to 11) taken as 0, as the
 * OpenType spec requires; that field holds a whole-font value, set last.
 */
export function directoryChecksum(tag: number, bytes: Uint8Array, offset: number, length: number): number {
  const sum = tableChecksum(bytes, offset, length);
  if (tag !== TAG_HEAD || length < 12) return sum;
  const adjustment = ((bytes[offset + 8]! << 24) | (bytes[offset + 9]! << 16) | (bytes[offset + 10]! << 8) | bytes[offset + 11]!) >>> 0;
  return (sum - adjustment) >>> 0;
}
