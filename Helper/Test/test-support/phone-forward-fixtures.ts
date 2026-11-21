// The generator of the phone forward fixtures 94 to 98 (task 9.9a): the five .eml files of
// Helper/Test/test-data/eml/ holding the French form of phoneForwardParts (phone-forward-thread.ts).
// Helper/Test/test-support/phone-forward-fixtures.test.ts checks that the committed files are
// exactly what this gives, and rewrites them on request (see that file). Test-only.
//
// - 94: the plain text, quoted-printable.
// - 95: the same text hard-wrapped at 76 characters at spaces (long attributions over two lines).
// - 96: the same text with the workshop's attributions cut inside the address (after 13, 16, 17
//   and 24 characters of "<address>"), then wrapped at 76 as in 95.
// - 97: multipart/alternative: the plain text (read) and a simple HTML part (never read).
// - 98: HTML only, base64, as an Android mail app writes a forward of a forward: each forward's body
//   one blockquote deeper than its header lines, Outlook HTML inside (MsoNormal paragraphs, a
//   border-top header block), "&nbsp;" before the colons, a tab before the closing quote of the
//   workshop's display name, a no-break space after the first word of the forward's text.
// Every file: CRLF line breaks, ASCII only (non-ASCII letters are encoded), no line over 76
// characters but the Subject header. Synthetic data only (Helper/Test/test-data/README.md).

import { phoneForwardParts, type PhoneForwardPart, type PhoneForwardParts } from './phone-forward-thread';

/** When the forwarding email was sent: its wall-clock time and UTC offset (the Date header). */
export const PHONE_FORWARD_SENT = { year: 2026, month: 11, day: 17, hour: 19, minute: 24, offsetMinutes: 60 } as const;

/** The five fixtures, in file order: name, seconds of the Date header (so they are not duplicates), Message-ID. */
const FIXTURES = [
    { name: '94-phone-forward-flat.eml', second: 15, id: 'phone-forward-a' },
    { name: '95-phone-forward-wrapped.eml', second: 16, id: 'phone-forward-b' },
    { name: '96-phone-forward-cut-address.eml', second: 17, id: 'phone-forward-b2' },
    { name: '97-phone-forward-alternative.eml', second: 18, id: 'phone-forward-c' },
    { name: '98-phone-forward-android-html.eml', second: 19, id: 'phone-forward-c3' },
] as const;

/** Where 96 cuts the workshop's attributions: characters of "<address>" kept on the first line, in body order. */
export const PHONE_FORWARD_CUTS: readonly number[] = [13, 16, 17, 24];

const WRAP_WIDTH = 76;
const BOUNDARY = 'phone-forward-boundary-0001';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number): string => String(n).padStart(2, '0');

/** The body text of `parts` ("\n" line breaks, ends with "\n"), as phoneForwardThread builds it. */
function plainBody(parts: readonly PhoneForwardPart[]): string
{
    return `${parts.map((p) => [p.head.join('\n'), ...p.body].join('\n\n')).join('\n\n')}\n`;
}

/** The UTF-8 bytes of one character as "=XX" groups, or the character itself when it may stay. */
function qpToken(char: string, lineEnd: boolean): string
{
    const code = char.codePointAt(0) ?? 0;
    if ((char === ' ' || char === '\t') && lineEnd)
    {
        return `=${code.toString(16).toUpperCase().padStart(2, '0')}`;
    }
    if (char === ' ' || char === '\t' || (code >= 33 && code <= 126 && char !== '='))
    {
        return char;
    }
    return [...new TextEncoder().encode(char)].map((b) => `=${b.toString(16).toUpperCase().padStart(2, '0')}`).join('');
}

/**
 * Quoted-printable (RFC 2045 6.7) of `text` ("\n" line breaks), CRLF line breaks: each line cut in pieces of at most
 * 75 characters, a soft break ("=") after each piece but the last. A piece may end between the "=XX" groups of one
 * character (allowed: the decoder joins the bytes).
 */
export function quotedPrintable(text: string): string
{
    return text.split('\n').map((line) =>
    {
        const chars = [...line];
        const tokens = chars.flatMap((c, i) => qpToken(c, i === chars.length - 1).match(/=[0-9A-F]{2}|[^=]/gu) ?? []);
        const out: string[] = [];
        let current = '';
        for (const token of tokens)
        {
            if (current.length + token.length > WRAP_WIDTH - 1)
            {
                out.push(`${current}=`);
                current = '';
            }
            current += token;
        }
        out.push(current);
        return out.join('\r\n');
    }).join('\r\n');
}

/** RFC 2047 "Q" encoded word of a header value. */
function encodedWord(value: string): string
{
    const q = [...value].map((c) => (c === ' ' ? '_' : c === '_' || c === '?' ? `=${c.charCodeAt(0).toString(16).toUpperCase()}` : qpToken(c, false))).join('');
    return `=?UTF-8?Q?${q}?=`;
}

/** Each line longer than 76 characters broken at its last space that keeps it within 76 (the space dropped). */
export function hardWrap(text: string): string
{
    return text.split('\n').map((line) =>
    {
        if (line.length <= WRAP_WIDTH)
        {
            return line;
        }
        const out: string[] = [];
        let current: string | null = null;
        for (const word of line.split(' '))
        {
            if (current === null)
            {
                current = word;
            }
            else if (current.length + 1 + word.length <= WRAP_WIDTH)
            {
                current += ` ${word}`;
            }
            else
            {
                out.push(current);
                current = word;
            }
        }
        out.push(current ?? '');
        return out.join('\n');
    }).join('\n');
}

/** `parts` with the k-th attribution of the workshop cut after PHONE_FORWARD_CUTS[k] characters of its "<address>". */
function cutAddresses(parts: readonly PhoneForwardPart[], workshopAddress: string): PhoneForwardPart[]
{
    let k = 0;
    return parts.map((part) =>
    {
        const line = part.head[0] ?? '';
        const at = line.indexOf(`<${workshopAddress}>`);
        const cut = PHONE_FORWARD_CUTS[k];
        if (part.shape !== 'attribution' || !part.byWorkshop || at < 0 || cut === undefined)
        {
            return part;
        }
        k++;
        return { ...part, head: [`${line.slice(0, at + cut)}\n${line.slice(at + cut)}`] };
    });
}

const escapeHtml = (text: string): string => text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');

/** The simple HTML part of 97: header lines in a div, paragraphs, each attribution opening a blockquote. */
function simpleHtml(parts: readonly PhoneForwardPart[]): string
{
    let html = '<html><body>';
    let open = 0;
    for (const part of parts)
    {
        const head = part.head.map(escapeHtml).join('<br>');
        if (part.shape === 'attribution')
        {
            html += `<div class="gmail_attr">${head}<br></div><blockquote>`;
            open++;
        }
        else
        {
            html += `<div class="gmail_quote">${head}<br></div>`;
        }
        html += part.body.map((p) => `<p>${escapeHtml(p).replace(/\n/gu, '<br>')}</p>`).join('');
    }
    return `${html}${'</blockquote>'.repeat(open)}</body></html>`;
}

const ANDROID_QUOTE = 'margin:0 0 0 0.8ex;border-left:1px #ccc solid;padding-left:1ex';
const OUTLOOK_QUOTE = 'border:none;border-left:solid #cccccc 1pt;padding:0cm 0cm 0cm 6pt;margin-left:4.8pt;margin-top:5pt;margin-right:0cm';
const MSO_TEXT = '<p class="MsoNormal"><span style="font-size:11.0pt;font-family:&quot;Calibri&quot;,sans-serif">';
const MSO_BLANK = '<p class="MsoNormal"><span style="font-size:11.0pt">&nbsp;</span></p>\n';

/** A line as the Android app writes it: a tab before the closing quote of a display name, "&nbsp;" before the colon of a label or of an attribution's end. */
function androidLine(line: string, attribution = false): string
{
    const escaped = escapeHtml(line).replace(/ &quot; &lt;/gu, '\t&quot; &lt;');
    return attribution ? escaped.replace(/ :$/u, '&nbsp;:') : escaped.replace(/^([^:]*?) :/u, '$1&nbsp;:');
}

/** `line` (escaped) with each "&lt;address&gt;" made a mailto link, as Outlook writes it. */
const withMailto = (escaped: string): string => escaped.replace(/&lt;([^&\s]+@[^&\s]+)&gt;/gu, '&lt;<a href="mailto:$1">$1</a>&gt;');

/** The paragraphs of a part as Outlook HTML: one MsoNormal paragraph per line, a blank one between paragraphs. */
function outlookParagraphs(body: readonly string[]): string
{
    return body.map((p) => p.split('\n').map((l) => `${MSO_TEXT}${escapeHtml(l)}</span></p>\n`).join('')).join(MSO_BLANK);
}

/** The HTML of 98 (see the file comment). Expects the shape of phoneForwardParts: two forwards, one attribution, then the rest. */
function androidHtml(thread: PhoneForwardParts): string
{
    const [outer, inner, firstReply, ...rest] = thread.parts;
    if (outer?.shape !== 'forward' || inner?.shape !== 'forward' || firstReply?.shape !== 'attribution')
    {
        throw new Error('phone forward fixtures: unexpected shape');
    }
    const forwardHead = (part: PhoneForwardPart): string => part.head.map((l) => `${androidLine(l)}${l.endsWith(':') ? ' ' : ''}<br>`).join('');
    const ownLines = inner.body.map((p, k) =>
        p.split('\n').map((l, i) => `<div dir="auto">${escapeHtml(l)}${k === 0 && i === 0 ? '&nbsp;' : ''}</div>`).join('')).join('<div dir="auto"><br></div>');
    let html = '<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"></head><body><div dir="auto"></div>' +
        `<div class="gmail_quote">${forwardHead(outer)}<br type="attribution">` +
        '<blockquote class="quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex"><div dir="auto"></div>' +
        `<div class="elided-text">${forwardHead(inner)}<br type="attribution"><blockquote style="${ANDROID_QUOTE}">` +
        `<div dir="auto"><div dir="auto">${ownLines}</div><div dir="auto"><br></div>` +
        `<div class="gmail_quote">${androidLine(firstReply.head.join(' '), true)}<br type="attribution"><blockquote style="${ANDROID_QUOTE}">` +
        '<div style="word-wrap:break-word"><div class="WordSection1">\n' +
        outlookParagraphs(firstReply.body);
    let open = 0;
    for (const part of rest)
    {
        if (part.shape === 'outlook')
        {
            const rows = part.head.map((l) =>
            {
                const [label = '', value = ''] = androidLine(l).split(/(?<=&nbsp;:) /u);
                return `<b>${label}</b> ${withMailto(value)}`;
            });
            html += '<div>\n<div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm">\n' +
                `<p class="MsoNormal"><b><span lang="FR">${rows.join('<br>\n')}</span></b></p>\n</div>\n</div>\n<p class="MsoNormal">&nbsp;</p>\n`;
        }
        else
        {
            html += `<p class="MsoNormal">${withMailto(androidLine(part.head.join(' '), true))}</p>\n<blockquote style="${OUTLOOK_QUOTE}">\n<div>\n<div>\n`;
            open++;
        }
        html += outlookParagraphs(part.body);
    }
    return `${html}${'</div>\n</div>\n</blockquote>\n'.repeat(open)}</div></div></blockquote></div></div></blockquote></div></blockquote></div></body></html>`;
}

/** Base64 of the UTF-8 bytes of `text`, in lines of 76 characters, CRLF line breaks. */
function base64Lines(text: string): string
{
    let binary = '';
    for (const byte of new TextEncoder().encode(text))
    {
        binary += String.fromCharCode(byte);
    }
    return (btoa(binary).match(/.{1,76}/gu) ?? []).join('\r\n');
}

/** The Date header value of the forwarding email at `second`. */
function dateHeader(second: number): string
{
    const s = PHONE_FORWARD_SENT;
    const weekday = WEEKDAYS[new Date(Date.UTC(s.year, s.month - 1, s.day)).getUTCDay()] ?? '?';
    const sign = s.offsetMinutes < 0 ? '-' : '+';
    const offset = Math.abs(s.offsetMinutes);
    return `${weekday}, ${s.day} ${MONTHS[s.month - 1] ?? '?'} ${s.year} ${two(s.hour)}:${two(s.minute)}:${two(second)} ${sign}${two(Math.floor(offset / 60))}${two(offset % 60)}`;
}

/** The five fixture files (name -> exact content), in file order. */
export function phoneForwardFixtureFiles(): ReadonlyMap<string, string>
{
    const thread = phoneForwardParts('fr');
    const body = plainBody(thread.parts);
    const files = new Map<string, string>();
    for (const [k, fixture] of FIXTURES.entries())
    {
        const head = [
            `From: ${thread.client.name} <${thread.client.address}>`,
            `To: ${thread.office}`,
            `Date: ${dateHeader(fixture.second)}`,
            `Subject: ${encodedWord(thread.subject)}`,
            `Message-ID: <${fixture.id}@client.test>`,
            'X-Synthetic-Fixture: true',
        ];
        let rest: string;
        if (k <= 2)
        {
            const text = k === 0 ? body : k === 1 ? hardWrap(body) : hardWrap(plainBody(cutAddresses(thread.parts, thread.workshop.address)));
            rest = `MIME-Version: 1.0\r\nContent-Type: text/plain; charset="UTF-8"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${quotedPrintable(text)}`;
        }
        else if (k === 3)
        {
            const partHead = (type: string): string => `--${BOUNDARY}\r\nContent-Type: ${type}; charset="UTF-8"\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n`;
            rest = `MIME-Version: 1.0\r\nContent-Type: multipart/alternative; boundary="${BOUNDARY}"\r\n\r\n` +
                `${partHead('text/plain')}${quotedPrintable(body)}${partHead('text/html')}${quotedPrintable(`${simpleHtml(thread.parts)}\n`)}--${BOUNDARY}--\r\n`;
        }
        else
        {
            head.push('X-Android-Message-ID: <a1b2c3d4-0000-0000-0000-000000000000@email.android.test>');
            rest = `MIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(androidHtml(thread))}\r\n`;
        }
        files.set(fixture.name, `${head.join('\r\n')}\r\n${rest}`);
    }
    return files;
}
