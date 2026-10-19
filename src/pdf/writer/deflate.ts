// Compression for PDF streams: the platform's CompressionStream('deflate')
// writes the zlib format, which is exactly PDF's /FlateDecode. Built into
// browsers, workers and Node 22; no dependency, no network (README.md, rule
// R1).

/** The zlib-compressed bytes of `data`. */
export async function deflate(data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
