// Compares the fields read from a quoted header (src/engine/quoted-header.ts)
// with the ground truth of the thread builder (thread-builder.ts). Shared by
// the reader's tests and the reconstruction measurement. Test-only.

import type { EmailAddress } from '../../src/parsing/types';
import type { QuotedHeaderFields } from '../../src/engine/quoted-header';
import type { ExpectedHeader, Person } from './thread-builder';

/** People as a header writes them: the address only when it is written (Outlook names-only blocks and Thunderbird attributions have none). */
function expectedBoxes(people: readonly Person[], written: string | undefined): EmailAddress[] {
  if (written === undefined) return [];
  return people.map((p) => ({ name: p.name, address: written.includes(p.address) ? p.address : '' }));
}

/** The fields a perfect reader returns for header `h`. */
export function expectedFields(h: ExpectedHeader): QuotedHeaderFields {
  return {
    from: expectedBoxes([h.sender], h.fields.from),
    to: expectedBoxes(h.to, h.fields.to),
    cc: expectedBoxes(h.cc, h.fields.cc),
    subject: h.fields.subject ?? null, // attributions hold no subject
    dateText: h.fields.date,
    headerEnd: h.headEnd,
    incomplete: [], // a perfect reader reads every list to its end
  };
}

/** Differences between what was read and the ground truth of one header ([] when they agree). */
export function fieldDiffs(h: ExpectedHeader, got: QuotedHeaderFields): string[] {
  const want = expectedFields(h);
  const diffs: string[] = [];
  for (const key of Object.keys(want) as (keyof QuotedHeaderFields)[]) {
    if (JSON.stringify(got[key]) !== JSON.stringify(want[key])) diffs.push(`${key}: got ${JSON.stringify(got[key])}, want ${JSON.stringify(want[key])}`);
  }
  return diffs;
}
