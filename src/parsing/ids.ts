// Message-ID style values (Message-ID, In-Reply-To, References), normalized
// the same way for every adapter: without the surrounding < >, trimmed.
// Threading and duplicate detection compare these strings directly, so the
// .eml and .msg adapters must both use these helpers.

/** Ids written the normal way, "<...>". Also splits "<a><b>" (no space between). */
const BRACKETED_ID = /<([^<>]*)>/g;

/**
 * All ids in a header value, in header order, without < > and trimmed.
 * If the value contains any "<...>" id, only those count: old clients add
 * prose such as `<id> (Alice's message of Monday)`, which must not become ids.
 * Otherwise (sloppy clients that drop the brackets) the value is split on
 * whitespace. Empty ids are skipped.
 */
export function parseIdList(value: string | null | undefined): string[] {
  if (value === null || value === undefined) return [];
  const bracketed = [...value.matchAll(BRACKETED_ID)].map((match) => (match[1] ?? '').trim());
  const ids = bracketed.length > 0 ? bracketed : value.split(/\s+/);
  return ids.filter((id) => id !== '');
}

/** The first id in a header value (Message-ID, In-Reply-To), or null if there is none. */
export function parseSingleId(value: string | null | undefined): string | null {
  return parseIdList(value)[0] ?? null;
}
