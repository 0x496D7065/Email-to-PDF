// Compares the fields read from a quoted header (Source/thread-analysis/quoted-header.ts)
// with the ground truth of the thread builder (thread-builder.ts). Shared by
// the reader's tests and the reconstruction measurement. Test-only.

import type { QuotedHeaderFields } from '../../../Source/thread-analysis/quoted-header';
import type { ExpectedHeader, Person } from './thread-builder';
import type { EmailAddress } from '../../../Header/parsed-email';

/** People as a header writes them: the address only when it is written (Outlook names-only blocks and Thunderbird attributions have none). */
function expectedBoxes(people: readonly Person[], written: string | undefined): EmailAddress[]
{
    if (written === undefined)
    {
        return [];
    }
    return people.map((p) => ({ name: p.name, address: written.includes(p.address) ? p.address : '' }));
}

/** The fields a perfect reader returns for `header`. */
export function expectedFields(header: ExpectedHeader): QuotedHeaderFields
{
    return {
        from: expectedBoxes([header.sender], header.fields.from),
        to: expectedBoxes(header.to, header.fields.to),
        cc: expectedBoxes(header.cc, header.fields.cc),
        subject: header.fields.subject ?? null, // attributions hold no subject
        dateText: header.fields.date,
        headerEnd: header.headEnd,
        incomplete: [], // a perfect reader reads every list to its end
    };
}

/** Differences between what was read and the ground truth of one header ([] when they agree). */
export function fieldDiffs(header: ExpectedHeader, got: QuotedHeaderFields): string[]
{
    const want = expectedFields(header);
    const diffs: string[] = [];
    for (const key of Object.keys(want) as (keyof QuotedHeaderFields)[])
    {
        if (JSON.stringify(got[key]) !== JSON.stringify(want[key]))
        {
            diffs.push(`${key}: got ${JSON.stringify(got[key])}, want ${JSON.stringify(want[key])}`);
        }
    }
    return diffs;
}
