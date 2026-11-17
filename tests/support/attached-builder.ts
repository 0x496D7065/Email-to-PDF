// Test support (task 8.13b-3, review round 2): a ParseResult with emails
// attached inside it (ParseResult.attached), built directly from synthetic
// NormalizedMessage objects, without a parser. An inline child is printed in
// its parent's bodyText the way the .eml adapter prints a forward (a
// FORWARDED_SEPARATOR line, header lines, a blank line, then the child's
// text, its own inline children included), and its places are worked out at
// every level it is printed in; a child sent "as a file" has no place. The
// list is in pre-order (a parent before its children), as the parsers give
// it. groupAsAttached turns a list of messages into such files at random
// (seeded), for the property tests. Synthetic data only (README.md, rule R7).

import { FORWARDED_SEPARATOR } from '../../src/parsing/forwarded-block';
import type { AttachedMessage, AttachedPlace, NormalizedMessage, ParseResult } from '../../src/parsing/types';

/** One email of the tree, with the emails attached inside it. */
export interface AttachedNode {
    /** Its own text is `message.bodyText`; the blocks of its inline children are added after it. */
    readonly message: NormalizedMessage;
    readonly children?: readonly AttachedChild[];
}

export interface AttachedChild {
    readonly node: AttachedNode;
    /** true: printed inside the parent's text (an inline forward); false: only sent as a file (no place). */
    readonly inline: boolean;
    /** The attachment name (AttachedMessage.name), '' by default. */
    readonly name?: string;
}

interface Rendered {
    readonly node: AttachedNode;
    /** The final bodyText (own text, then the inline children's blocks). */
    readonly body: string;
    readonly kids: readonly {
        readonly child: AttachedChild;
        readonly rendered: Rendered;
        /** [blockStart, blockEnd) in `body`, and where the child's text starts in it; null when not inline. */
        readonly block: { readonly start: number; readonly end: number; readonly textStart: number } | null;
    }[];
}

/** The header lines of a forwarded block for `m` (no trailing line break). */
function blockHeader(m: NormalizedMessage): string
{
    const from = m.from.map((a) => (a.name === '' ? a.address : `${a.name} <${a.address}>`)).join(', ');
    const lines = [FORWARDED_SEPARATOR, ...(from === '' ? [] : [`From: ${from}`])];
    if (m.date.original !== '') lines.push(`Date: ${m.date.original}`);
    if (m.subject !== '') lines.push(`Subject: ${m.subject}`);
    return lines.join('\n');
}

function render(node: AttachedNode): Rendered
{
    let body = node.message.bodyText;
    const kids: Rendered['kids'][number][] = [];
    for (const child of node.children ?? [])
    {
        const rendered = render(child.node);
        if (!child.inline)
        {
            kids.push({ child, rendered, block: null });
            continue;
        }
        body += body === '' || body.endsWith('\n') ? '\n' : '\n\n';
        const start = body.length;
        body += `${blockHeader(rendered.node.message)}\n\n`;
        const textStart = body.length;
        body += rendered.body;
        kids.push({ child, rendered, block: { start, end: body.length, textStart } });
    }
    return { node, body, kids };
}

/**
 * The ParseResult of a dropped file whose own email is `root`, with every
 * email attached inside it, at any depth. Each attached message gets
 * `source.attachedPath` (and the file's name and hash), as the parsers do.
 */
export function attachedResult(root: AttachedNode): Extract<ParseResult, { ok: true }>
{
    const top = render(root);
    const attached: AttachedMessage[] = [];
    // `ups`: the emails above `self`, nearest first: their attached index (-1: the file's email) and where the
    // text of the email below them starts in their body (null: that one is not printed inline there).
    const walk = (r: Rendered, self: number, path: readonly number[], ups: readonly { readonly holder: number; readonly offset: number | null }[]): void =>
    {
        r.kids.forEach((kid, k) =>
        {
            const ownPath = [...path, k + 1];
            // Places: in the parent, then each email above while the one below it is printed inline there.
            const places: AttachedPlace[] = [];
            if (kid.block !== null)
            {
                let start = kid.block.start;
                let end = kid.block.end;
                places.push({ holder: self, start, end });
                for (const up of ups)
                {
                    if (up.offset === null) break;
                    start += up.offset;
                    end += up.offset;
                    places.push({ holder: up.holder, start, end });
                }
            }
            const index = attached.length;
            const m = kid.rendered.node.message;
            attached.push({
                message: { ...m, bodyText: kid.rendered.body, source: { ...root.message.source, attachedPath: ownPath } },
                parent: self,
                places,
                path: ownPath,
                name: kid.child.name ?? '',
            });
            // For the child's own children: this email is the nearest holder above them.
            const nextUps = [{ holder: self, offset: kid.block === null ? null : kid.block.textStart }, ...ups];
            walk(kid.rendered, index, ownPath, nextUps);
        });
    };
    walk(top, -1, [], []);
    return { ok: true, message: { ...root.message, bodyText: top.body }, ...(attached.length === 0 ? {} : { attached }) };
}

/** How `groupAsAttached` attaches an email: always inline, always as a file, or either (seeded). */
export type AttachMode = 'inline' | 'file' | 'random';

/**
 * Groups `messages`, in order, into dropped files with emails attached inside
 * them, seeded by `random`: each message either starts a new file or (share
 * `attachShare`, never the first) is attached inside an email of an earlier
 * file, inline or as a file per `mode`, at most `maxDepth` levels below the
 * file's own email. Some attachments get a name, some none. One ParseResult
 * per file (attachedResult), in the order the files were started.
 */
export function groupAsAttached(
    messages: readonly NormalizedMessage[],
    random: () => number,
    { mode = 'random', attachShare = 0.5, maxDepth = 3 }: { readonly mode?: AttachMode; readonly attachShare?: number; readonly maxDepth?: number } = {},
): Extract<ParseResult, { ok: true }>[]
{
    interface Draft {
        readonly message: NormalizedMessage;
        readonly depth: number;
        readonly children: AttachedChild[];
    }
    const roots: Draft[] = [];
    const all: Draft[] = [];
    messages.forEach((message, k) =>
    {
        const holders = all.filter((d) => d.depth < maxDepth);
        if (holders.length > 0 && random() < attachShare)
        {
            const holder = holders[Math.floor(random() * holders.length)]!;
            const node: Draft = { message, depth: holder.depth + 1, children: [] };
            const inline = mode === 'inline' || (mode === 'random' && random() < 0.6);
            holder.children.push({ node, inline, ...(random() < 0.5 ? { name: `attached-${String(k)}.eml` } : {}) });
            all.push(node);
            return;
        }
        const node: Draft = { message, depth: 0, children: [] };
        roots.push(node);
        all.push(node);
    });
    return roots.map((r) => attachedResult(r));
}
