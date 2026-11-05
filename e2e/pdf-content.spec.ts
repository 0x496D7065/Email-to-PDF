// Browser test of WHAT the PDF says (README.md, rules R1, R2, R4, R5 and R6),
// in each test browser against the BUILT site served by `vite preview` (see
// playwright.config.ts), with the real pipeline and the real workers. The
// other specs check that a PDF is made and downloaded (e2e/download.spec.ts:
// the download itself, offline, "Clear everything", stale links, a big
// batch); this one reads the downloaded file back, page by page, as text
// (tests/support/pdf-reader.ts: glyphs through ToUnicode = what a reader
// sees; /ActualText first = what a reader copies), and checks it against
// expectations made HERE from the fixtures, never from the app's output.
//
// The input: every synthetic fixture (each .eml of tests/fixtures/eml and
// each .msg built from tests/fixtures/msg/specs.ts), dropped on step 1 with a
// real DataTransfer, as in e2e/full-flow.spec.ts. One of them, ANSWERS
// (eml/93-answers-between-lines.eml), holds what no other fixture has:
// point-by-point answers between quoted lines, an emoji the fonts lack, a
// tab, a control character, and a Sender and a Cc mailbox found in no other
// email. Then one email is unticked ("Parking") and the zone
// "America/New_York" is picked (the browser's own zone is Tokyo).
//
// 1. "the PDF as made by default": the cover (title, date range, count,
//    zone, generation time, no note of any kind (task 8.8), the people, every
//    source file with its SHA-256 computed here, in Node, over the exact
//    bytes dropped); the index (one row per email, in order: number, short
//    date in the chosen zone, sender, subject, attachments, and the page
//    where that email's heading really is; each row a link to it); the
//    bookmarks; "Page X of Y" on every page; the unticked email nowhere;
//    the first line of every email; the PDF-only policy (src/engine/
//    output-plan.ts): quoted history added by the mail app left out of the
//    reply (and still in the email it came from), a repeated signature only
//    where its sender first used it, a quote the writer answered between
//    its lines kept (its "> " marks not printed; every body line, quoted or
//    not, one step in from the header rows, tasks 8.1 and 8.6); accents
//    drawn as real glyphs; the emoji drawn as the
//    code "[U+1F600]" while the copy layer holds the emoji itself.
// 2. "Print full original text": the full body of every email is in its
//    own part of the PDF, in order (rule R6, collapse never delete), after
//    the documented display transforms only (tests/support/pdf-reference.ts:
//    tabs as 4 spaces, at most 2 blank lines, outer blank lines trimmed,
//    control characters as "[U+XXXX]", quote marks at line starts removed),
//    compared with white space
//    normalised (the PDF wraps lines). The bodies come from the same
//    fixture bytes parsed here in Node; the two HTML-only emails, whose text
//    needs the browser's DOMParser, are checked with the manifest's
//    snippets only. For every email, the manifest's hand-written snippets
//    are also found in order in its part (a check that does not rest on the
//    parser).
//
// Read back, a line is its runs joined; a space is put between two runs
// only where the page leaves a gap. Such spaces are allowed only in the
// index table and in label/value rows ("From" + its value), never inside a
// line of email text.
//
// Throughout (see e2e/support/watch.ts): after the page's own files, only
// the own-origin blob: URLs of the inlined workers and, at most once, the
// PDF's (the "Download again" link; all in memory), no
// WebSocket, no CSP violation in the page or a worker (the parse-time
// reports of DOMParser for the HTML fixtures are tolerated, with their
// console lines, as in e2e/full-flow.spec.ts), every worker a parse, engine
// or PDF worker that ended, nothing stored.
//
// Test data is made up (README.md, rule R7): the shared fixtures only.
import { readFileSync } from 'node:fs';
import { expect, test, type Download, type Page } from '@playwright/test';
import { createServer } from 'vite';
import type * as EmlModule from '../src/parsing/eml.ts';
import type * as MsgModule from '../src/parsing/msg.ts';
import type { EmailParser } from '../src/parsing/types.ts';
import { en } from '../src/ui/i18n/en.ts';
import { FIXTURES, type ExpectedAddress, type ExpectedAttachment } from '../tests/fixtures/manifest.ts';
import type * as Builder from '../tests/fixtures/msg/builder.ts';
import type * as Specs from '../tests/fixtures/msg/specs.ts';
import { readDests, readLinks, readOutline, readPageRuns, readPdf, textLines, type PageRun, type TextLine } from '../tests/support/pdf-reader.ts';
import { referenceDisplayText } from '../tests/support/pdf-reference.ts';
import {
  engineOf,
  isParseTimeReport,
  PARSE_TIME_CONSOLE,
  untoleratedReports,
  watchPage,
  withoutSelectConsole,
  withoutSelectReports,
  workerCspReports,
  workersNamed,
  type Watch,
} from './support/watch.ts';

declare global {
  interface Window {
    __contentViolations: string[];
  }
}

/** Project root as a file path ("file:///C:/x/" -> "C:/x/"), as in vite.config.ts. */
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');

// ---------------------------------------------------------------- the input

/** The fixture with answers between quoted lines, the emoji, the tab, the control character (see the top). */
const ANSWERS_ID = 'eml/93-answers-between-lines.eml';
/** Its Cc and its Sender: in no other fixture, so the cover lists them only if it reads Cc and Sender. */
const ANSWERS_CC = { name: 'Dana Sample', address: 'dana.sample@example.test' };
const ANSWERS_SENDER = { name: 'Erin Test', address: 'erin@furniture.example.test' };

/** The email unticked before the PDF is made. */
const UNTICKED_ID = 'eml/74-date-localized-weekday.eml';
const UNTICKED_SUBJECT = 'Parking';
const UNTICKED_TEXT = 'park the van in front of the office';

// The browser's zone, and the one picked in the page (both with no half hours; New York has DST).
const BROWSER_ZONE = 'Asia/Tokyo';
const ZONE = 'America/New_York';
test.use({ timezoneId: BROWSER_ZONE });
/** "Now" for the page: 2025-06-01 20:00 UTC = 16:00 in New York, already 2 June in Tokyo. */
const FIXED_NOW = Date.UTC(2025, 5, 1, 20, 0, 0);

/** One dropped file and what this test expects of it. */
interface Source {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly bytes: number[];
  /** SHA-256 of `bytes`, computed in Node (lower-case hex). */
  readonly sha256: string;
  /** Duplicate group (the id when it has none). */
  readonly group: string;
  readonly utcMs: number | null;
  /** As the PDF names them when missing. */
  readonly subject: string;
  readonly author: string;
  readonly fromAddress: string;
  readonly people: readonly ExpectedAddress[];
  readonly attachments: readonly ExpectedAttachment[];
  readonly snippets: readonly string[];
  /** The decoded body (parsed here in Node), or null when it comes from HTML (no DOMParser in Node). */
  readonly body: string | null;
}

/** Built in beforeAll, in drop order (a fixed shuffle, as in e2e/full-flow.spec.ts). */
let sources: Source[] = [];

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** SHA-256 in the test process (Node's Web Crypto), independent of the page. */
async function sha256(bytes: Uint8Array): Promise<string> {
  return hex(await globalThis.crypto.subtle.digest('SHA-256', bytes.slice()));
}

const authorOf = (from: readonly ExpectedAddress[], sender: ExpectedAddress | undefined): string => {
  const shown = from.filter((m) => m.name.trim() !== '' || m.address.trim() !== '');
  const m = shown[0] ?? sender;
  if (shown.length > 1) throw new Error('the expected author of several From mailboxes is not written here');
  if (m === undefined) return en.preview.author.none;
  return m.name.trim() !== '' ? m.name : m.address;
};

test.beforeAll(async () => {
  // The .msg builder and the parsers need Vite's module loader (see
  // e2e/full-flow.spec.ts): middleware mode opens no port and serves nothing.
  const server = await createServer({
    root: ROOT,
    configFile: `${ROOT}vite.config.ts`,
    logLevel: 'warn',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false },
  });
  const built: Source[] = [];
  try {
    const { buildMsg } = (await server.ssrLoadModule('/tests/fixtures/msg/builder.ts')) as typeof Builder;
    const { MSG_SPECS } = (await server.ssrLoadModule('/tests/fixtures/msg/specs.ts')) as typeof Specs;
    const { createEmlParser } = (await server.ssrLoadModule('/src/parsing/eml.ts')) as typeof EmlModule;
    const { createMsgParser } = (await server.ssrLoadModule('/src/parsing/msg.ts')) as typeof MsgModule;
    // Node has no DOMParser: an HTML body is marked, and its email is checked with the manifest's snippets.
    const HTML = '\u{0}html';
    const htmlToText = (): { text: string; truncated: boolean } => ({ text: HTML, truncated: false });
    const parsers: Record<'eml' | 'msg', EmailParser> = { eml: createEmlParser({ htmlToText }), msg: createMsgParser({ htmlToText }) };
    const bodyOf = async (kind: 'eml' | 'msg', name: string, bytes: Uint8Array): Promise<string | null> => {
      const result = await parsers[kind].parse({ name, bytes });
      if (!result.ok) throw new Error(`${name} does not parse`);
      return result.message.bodyText.includes(HTML) ? null : result.message.bodyText;
    };

    for (const f of FIXTURES) {
      const name = f.kind === 'eml' ? f.id.slice('eml/'.length) : `${f.id}.msg`;
      let bytes: Uint8Array;
      if (f.kind === 'eml') {
        // The fixtures are 7-bit ASCII text.
        bytes = new TextEncoder().encode(readFileSync(`${ROOT}tests/fixtures/${f.id}`, 'utf8'));
      } else {
        const spec = MSG_SPECS.find((s) => s.id === f.id);
        if (spec === undefined) throw new Error(`no .msg spec ${f.id}`);
        bytes = buildMsg(spec);
      }
      built.push({
        id: f.id,
        name,
        type: f.kind === 'eml' ? 'message/rfc822' : 'application/vnd.ms-outlook',
        bytes: Array.from(bytes),
        sha256: await sha256(bytes),
        group: f.duplicateGroup ?? f.id,
        utcMs: f.date.utcMs,
        subject: f.subject === null || f.subject.trim() === '' ? en.preview.noSubject : f.subject,
        author: authorOf(f.from, f.sender),
        fromAddress: f.from[0]?.address ?? '',
        people: [...f.from, ...(f.sender === undefined ? [] : [f.sender]), ...f.to, ...f.cc],
        attachments: f.attachments,
        snippets: f.bodyContains,
        body: await bodyOf(f.kind, name, bytes),
      });
    }
  } finally {
    await server.close();
  }
  sources = built.map((_, i) => built[(i * 7) % built.length]).filter((s): s is Source => s !== undefined);
  expect(new Set(sources.map((s) => s.name)).size).toBe(built.length);
});

/**
 * The emails of the PDF, in order: one per duplicate group, by date, the
 * undated ones last in drop order (src/engine/order.ts), without the
 * unticked one. Each with every file of its group. Throws if two emails
 * share a date (their order would not be known here).
 */
function expectedEmails(): { readonly first: Source; readonly files: readonly Source[] }[] {
  const groups = new Map<string, Source[]>();
  for (const s of sources) groups.set(s.group, [...(groups.get(s.group) ?? []), s]);
  const list = [...groups.values()].map((files) => ({ first: files[0]!, files }));
  const dated = list.filter((e) => e.first.utcMs !== null).sort((a, b) => (a.first.utcMs ?? 0) - (b.first.utcMs ?? 0));
  for (let i = 1; i < dated.length; i++) if (dated[i]?.first.utcMs === dated[i - 1]?.first.utcMs) throw new Error(`same date: ${dated[i]?.first.id ?? ''}`);
  const undated = list.filter((e) => e.first.utcMs === null);
  return [...dated, ...undated].filter((e) => e.first.id !== UNTICKED_ID);
}

// ---------------------------------------------------------------- formatting, as the PDF should write it

/** Fills an i18n template ("{count} emails"). */
const fill = (template: string, values: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const value = values[key];
    if (value === undefined) throw new Error(`no value for {${key}}`);
    return String(value);
  });

/** A moment in the chosen zone, with Intl in Node: "YYYY-MM-DD", "YYYY-MM-DD HH:mm", "YYYY-MM-DD HH:mm:ss UTC-04:00". */
function inZone(ms: number): { day: string; short: string; full: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(new Date(ms));
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  const day = `${part('year')}-${part('month')}-${part('day')}`;
  const offset = part('timeZoneName').replace('GMT', '') || '+00:00';
  return { day, short: `${day} ${part('hour')}:${part('minute')}`, full: `${day} ${part('hour')}:${part('minute')}:${part('second')} UTC${offset}` };
}

/** White space runs as one space, trimmed (the PDF wraps lines where it likes). */
const norm = (text: string): string => text.replace(/\s+/g, ' ').trim();
/** No white space at all (for hashes and names a line may break anywhere in). */
const bare = (text: string): string => text.replace(/\s+/g, '');
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const count = (text: string, part: string): number => text.split(part).length - 1;

const attachmentText = (a: ExpectedAttachment): string =>
  `${a.fileName} ${fill(en.pdf.document.attachment, { size: fill(a.size === 1 ? en.preview.size.bytes.one : en.preview.size.bytes.other, { count: a.size }), type: a.mimeType })}`;

// ---------------------------------------------------------------- reading the PDF back

/** One email's part of the PDF: from its heading to the next heading (footers left out). */
interface Section {
  readonly lines: readonly TextLine[];
  /** Copied text, lines joined with LF. */
  readonly copied: string;
  readonly headingPage: number;
}

interface ReadBack {
  readonly pageCount: number;
  readonly cover: readonly TextLine[];
  readonly indexPages: readonly number[];
  /** Lines per page, footer left out. */
  readonly pages: readonly (readonly TextLine[])[];
  readonly runs: readonly (readonly PageRun[])[];
  readonly sections: readonly Section[];
  readonly links: ReturnType<typeof readLinks>;
  readonly outline: NonNullable<ReturnType<typeof readOutline>>;
}

/** Reads the file, checks the footers, finds the cover, the index pages and each email's section by its destination. */
async function readBack(bytes: Uint8Array, emails: number): Promise<ReadBack> {
  const pdf = readPdf(bytes);
  const pageCount = pdf.pages().length;
  const runs = await readPageRuns(pdf);
  const pages: TextLine[][] = [];
  for (const [p, pageRuns] of runs.entries()) {
    const lines = textLines(pageRuns);
    // "Page X of Y" on every page, at the very bottom, and nowhere else.
    const footer = lines.at(-1);
    expect(footer?.copied, `footer of page ${String(p + 1)}`).toBe(fill(en.pdf.document.pageFooter, { page: p + 1, total: pageCount }));
    expect(footer?.shown).toBe(footer?.copied);
    const body = lines.slice(0, -1);
    expect(body.filter((l) => /^Page \d+ of \d+$/.test(l.copied))).toEqual([]);
    pages.push(body);
  }

  const dests = readDests(pdf);
  const indexPage = dests.get('index')?.page;
  const firstEmailPage = dests.get('email-1')?.page;
  if (indexPage === undefined || firstEmailPage === undefined) throw new Error('no index or no first email destination');
  expect(dests.get('cover')?.page).toBe(0);
  expect(indexPage).toBeGreaterThan(0);

  // Each email's heading: the first line below its destination, on its page.
  const flat = pages.flatMap((lines, page) => (page >= firstEmailPage ? lines.map((line) => ({ line, page })) : []));
  const starts: number[] = [];
  for (let k = 1; k <= emails; k++) {
    const dest = dests.get(`email-${String(k)}`);
    if (dest === undefined) throw new Error(`no destination email-${String(k)}`);
    const at = flat.findIndex((x) => x.page === dest.page && x.line.y < dest.top);
    expect(flat[at]?.line.copied, `heading of email ${String(k)}`).toBe(fill(en.pdf.document.emailHeading, { number: k }));
    expect(dest.top - (flat[at]?.line.y ?? 0)).toBeLessThan(30);
    starts.push(at);
  }
  expect(dests.has(`email-${String(emails + 1)}`)).toBe(false);
  const sections = starts.map((start, k): Section => {
    const lines = flat.slice(start, starts[k + 1] ?? flat.length).map((x) => x.line);
    return { lines, copied: lines.map((l) => l.copied).join('\n'), headingPage: flat[start]!.page };
  });

  // Spaces put between runs (see the top): on the cover and in the emails,
  // only one, after the label of a label/value row or the bullet of a list
  // item. (The index table is read by column instead.)
  const d = en.pdf.document;
  const v = en.preview;
  const labels = new Set([d.dates, d.emails, d.generated, d.timeZone, v.from, v.author.sender, v.to, v.cc, v.bcc, v.date, v.subject, d.file, '\u{2022}']);
  for (const line of [...pages.slice(0, indexPage).flat(), ...flat.map((x) => x.line)]) {
    if (line.insertedSpaces === 0) continue;
    const label = line.runs[0]?.copied ?? '';
    expect({ line: line.copied, label: labels.has(label), spaces: line.insertedSpaces }).toEqual({ line: line.copied, label: true, spaces: 1 });
  }

  const outline = readOutline(pdf);
  if (outline === undefined) throw new Error('no outline');
  return {
    pageCount,
    cover: pages.slice(0, indexPage).flat(),
    indexPages: Array.from({ length: firstEmailPage - indexPage }, (_, i) => indexPage + i),
    pages,
    runs,
    sections,
    links: readLinks(pdf),
    outline,
  };
}

/**
 * The text of a table cell: the runs of `lines` in the column [from, to),
 * as lines. Returns `expected` when those lines are `expected` wrapped (each
 * line a piece of it, together all of it: a cell may wrap at a space or
 * after a "/" or "-", which the file does not record), else the lines
 * joined with " | " (so a failure shows them).
 */
function cellText(lines: readonly TextLine[], from: number, to: number, expected: string): string {
  const runs = lines.flatMap((l) => l.runs.filter((r) => r.x >= from - 0.01 && r.x < to - 0.01));
  const cell = textLines(runs).map((l) => norm(l.copied));
  return bare(cell.join('')) === bare(expected) && cell.every((line) => norm(expected).includes(line)) ? expected : cell.join(' | ');
}

// ---------------------------------------------------------------- the checks shared by both PDFs

/** Cover, index, bookmarks, links, and the unticked email absent: the same in both PDFs. */
function checkFront(doc: ReadBack, emails: ReturnType<typeof expectedEmails>, made: string): void {
  const E = emails.length;
  const d = en.pdf.document;

  // --- Cover -------------------------------------------------------------
  const cover = doc.cover.map((l) => l.copied).join('\n');
  const coverText = norm(cover);
  expect(doc.cover[0]?.copied).toBe(d.title);
  const dated = emails.map((e) => e.first.utcMs).filter((ms): ms is number => ms !== null);
  const range = fill(d.dateRange, { first: inZone(Math.min(...dated)).full, last: inZone(Math.max(...dated)).full });
  expect(coverText).toContain(`${d.dates} ${range}`);
  const undated = E - dated.length;
  expect(undated).toBe(3);
  expect(coverText).toContain(`${d.emails} ${fill(d.emailCount.other, { count: E })}`);
  expect(coverText).toContain(`${d.timeZone} ${ZONE.replaceAll('_', ' ')}`);
  expect(coverText).toContain(`${d.generated} ${made}`);
  // No notes on the cover (task 8.8): not about the undated emails, nor about
  // ANSWERS's control character (a BEL, quoted-printable encoded), which the
  // app notes on its card instead.
  for (const removed of ['have no usable date', 'has no usable date', 'control or broken character', 'could not be read', 'not recognized']) {
    expect(coverText).not.toContain(removed);
  }

  // People: exactly the addresses of From, Sender, To and Cc of the included emails, each with a name it was given.
  const peopleAt = doc.cover.findIndex((l) => l.copied === d.people);
  const sourcesAt = doc.cover.findIndex((l) => l.copied === d.sources);
  expect(peopleAt).toBeGreaterThan(0);
  expect(sourcesAt).toBeGreaterThan(peopleAt);
  const peopleText = doc.cover
    .slice(peopleAt + 1, sourcesAt)
    .map((l) => l.copied)
    .join('\n');
  const names = new Map<string, Set<string>>();
  for (const e of emails) {
    for (const p of e.first.people) {
      if (p.address === '') continue;
      const key = p.address.toLowerCase();
      names.set(key, new Set([...(names.get(key) ?? []), ...(p.name === '' ? [] : [p.name])]));
    }
  }
  const shownAddresses = [...peopleText.matchAll(/[\w.+-]+@[\w.-]+\.(?:test|invalid)/g)].map((m) => m[0].toLowerCase());
  expect([...shownAddresses].sort()).toEqual([...names.keys()].sort());
  for (const [address, known] of names) {
    const line = peopleText.split('\n').find((l) => l.toLowerCase().includes(address)) ?? '';
    if (known.size > 0) expect([...known].some((name) => line.includes(`${name} <`)), line).toBe(true);
  }
  // A person named only in a Cc header, and one only in a Sender header (of
  // ANSWERS, in no other fixture): listed, with their names.
  for (const [person, field] of [
    [ANSWERS_CC, 'cc'],
    [ANSWERS_SENDER, 'sender'],
  ] as const) {
    const where = FIXTURES.flatMap((f) =>
      (['from', 'sender', 'to', 'cc', 'bcc'] as const).flatMap((key) => {
        const value = f[key];
        const list = value === undefined ? [] : 'address' in value ? [value] : value;
        return list.some((m) => m.address.toLowerCase() === person.address) ? [`${f.id} ${key}`] : [];
      }),
    );
    expect(where, person.address).toEqual([`${ANSWERS_ID} ${field}`]);
    expect(norm(peopleText), person.address).toContain(`${person.name} <${person.address}>`);
  }

  // Source files: every file of every included email (merged copies too), with the SHA-256 computed here.
  const coverBare = bare(cover);
  let sourceCount = 0;
  for (const [k, e] of emails.entries()) {
    for (const f of e.files) {
      // "<name> - email 3", then the SHA-256 on the next line; a merged copy alike (task 8.8: no "(identical copy, merged)").
      const line = bare(`${f.name} - ${fill(d.sourceEmail, { number: k + 1 })}`);
      // (The 64 hex digits right after the number keep "email 1" from matching "email 12".)
      const match = new RegExp(`${escapeRegExp(line)}${f.sha256}`).exec(coverBare);
      expect(match, `${f.name} with its SHA-256 on the cover`).not.toBeNull();
      sourceCount++;
    }
    expect(e.files.length, `${e.first.id}: at least its kept file`).toBeGreaterThanOrEqual(1);
  }
  expect(cover).not.toContain('identical copy');
  // Every file but the unticked one, and no other source line.
  expect(sourceCount).toBe(sources.length - 1);
  expect(coverBare.match(/-email\d+/g)).toHaveLength(sourceCount);

  // --- Index ---------------------------------------------------------------
  const indexLines = doc.indexPages.flatMap((p) => doc.pages[p] ?? []);
  expect(indexLines[0]?.copied).toBe(d.index);
  const titleLine = indexLines.find((l) => l.runs[0]?.copied === d.column.number);
  if (titleLine === undefined) throw new Error('no column titles');
  const titleX = (title: string): number => {
    const run = titleLine.runs.find((r) => r.copied.startsWith(title));
    if (run === undefined) throw new Error(`no column title ${title}`);
    return run.x;
  };
  const columns = {
    number: -Infinity,
    date: titleX(d.column.date),
    from: titleX(d.column.from),
    subject: titleX(d.column.subject),
    page: titleX(d.column.page),
  };
  const firstRow = doc.links.find((l) => l.dest === 'email-1');
  const headerLines = (doc.pages[doc.indexPages[0]!] ?? []).filter((l) => l.y <= titleLine.y && l.y > (firstRow?.rect[3] ?? 0));
  const dateTitle = fill(d.column.dateInZone, { zone: ZONE.replaceAll('_', ' ') });
  expect(cellText(headerLines, columns.date, columns.from, dateTitle)).toBe(dateTitle);

  const rowLinks = doc.links.filter((l) => l.dest.startsWith('email-'));
  expect(new Set(rowLinks.map((l) => l.dest)).size).toBe(E);
  expect(doc.links.every((l) => doc.indexPages.includes(l.page))).toBe(true);
  for (const [k, e] of emails.entries()) {
    const anchor = `email-${String(k + 1)}`;
    const lines = rowLinks
      .filter((l) => l.dest === anchor)
      .flatMap((l) => (doc.pages[l.page] ?? []).filter((line) => line.y > l.rect[1] && line.y < l.rect[3]));
    const extrasAt = lines.findIndex((l) => l.runs.some((r) => r.x >= columns.date - 0.01 && r.copied.startsWith(d.column.attachments)));
    const bands = extrasAt < 0 ? lines : lines.slice(0, extrasAt);
    const ms = e.first.utcMs;
    const want = {
      number: String(k + 1),
      date: ms === null ? en.preview.noDate : inZone(ms).short,
      from: norm(e.first.author),
      subject: norm(e.first.subject),
      // The page where that email's heading really is.
      page: String((doc.sections[k]?.headingPage ?? -2) + 1),
    };
    const row = {
      number: cellText(bands, columns.number, columns.date, want.number),
      date: cellText(bands, columns.date, columns.from, want.date),
      from: cellText(bands, columns.from, columns.subject, want.from),
      subject: cellText(bands, columns.subject, columns.page, want.subject),
      page: cellText(bands, columns.page, Infinity, want.page),
    };
    expect(row, `index row ${String(k + 1)} (${e.first.id})`).toEqual(want);
    // One line each for the number, the date and the page.
    for (const [from, to] of [
      [columns.number, columns.date],
      [columns.date, columns.from],
      [columns.page, Infinity],
    ] as const) {
      expect(textLines(bands.flatMap((l) => l.runs.filter((r) => r.x >= from - 0.01 && r.x < to - 0.01)))).toHaveLength(1);
    }
    // Attachments under the row: name, size, type.
    const extras = norm(extrasAt < 0 ? '' : lines.slice(extrasAt).map((l) => l.copied).join(' '));
    if (e.first.attachments.length === 0) expect(extrasAt, e.first.id).toBe(-1);
    for (const a of e.first.attachments) expect(extras).toContain(attachmentText(a));
  }

  // --- Bookmarks: Cover, Index, then one per email, in order. ---------------
  expect(doc.outline.items.map((i) => [i.title, i.dest])).toEqual([
    [d.coverBookmark, 'cover'],
    [d.index, 'index'],
    ...emails.map((e, k) => {
      const ms = e.first.utcMs;
      const day = ms === null ? en.preview.noDate : inZone(ms).day;
      return [fill(d.emailBookmark, { number: k + 1, date: day, from: e.first.author, subject: e.first.subject }), `email-${String(k + 1)}`];
    }),
  ]);
  expect(doc.outline.items.every((i) => i.children.length === 0)).toBe(true);

  // --- The unticked email: nowhere. ------------------------------------------
  const all = doc.pages.flat().map((l) => l.copied).join('\n');
  expect(all).not.toContain(UNTICKED_TEXT);
  expect(doc.outline.items.some((i) => i.title.includes(UNTICKED_SUBJECT))).toBe(false);
  expect(indexLines.some((l) => l.copied.includes(UNTICKED_SUBJECT))).toBe(false);
  const unticked = sources.find((s) => s.id === UNTICKED_ID);
  expect(coverBare).not.toContain(bare(unticked?.name ?? '?'));
  expect(coverBare).not.toContain(unticked?.sha256 ?? '?');
}

// ---------------------------------------------------------------- the page

let origin = '';
let watch: Watch;
let loadedAt = 0;
let problems: string[] = [];
let downloads: Download[] = [];

test.beforeEach(async ({ context, page, baseURL }) => {
  origin = new URL(baseURL ?? '').origin;
  problems = [];
  downloads = [];
  watch = await watchPage(context, page, origin);
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('dialog', (dialog) => {
    problems.push(`dialog: ${dialog.message()}`);
    void dialog.dismiss();
  });
  page.on('download', (download) => downloads.push(download));
  await page.addInitScript(() => {
    window.__contentViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      // "select": WebKit's report about a <select> (see withoutSelectReports).
      const where = event.target === document ? 'parse' : event.target instanceof HTMLSelectElement ? 'select' : 'live';
      window.__contentViolations.push(`${event.effectiveDirective} ${event.blockedURI} ${where}`);
    });
  });
});

const makeButton = (page: Page) => page.getByRole('button', { name: en.actions.makePdf });

/** Opens the page, drops every file, unticks one email, picks the zone: ready to make the PDF. */
async function prepare(page: Page): Promise<ReturnType<typeof expectedEmails>> {
  await page.clock.setFixedTime(FIXED_NOW);
  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.locator('#drop-zone')).toBeVisible();
  loadedAt = watch.requests.length;

  // A real drop: a DataTransfer made in the page, and the drag events a browser fires.
  const transfer = await page.evaluateHandle((list) => {
    const data = new DataTransfer();
    for (const f of list) data.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: f.type }));
    return data;
  }, sources.map((s) => ({ name: s.name, type: s.type, bytes: s.bytes })));
  const cancelled = await page.evaluate(
    (data) =>
      ['dragenter', 'dragover', 'drop'].map((type) => {
        const zone = document.querySelector('#drop-zone');
        if (zone === null) throw new Error('no drop zone');
        return !zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
      }),
    transfer,
  );
  expect(cancelled).toEqual([true, true, true]);

  const groups = new Set(sources.map((s) => s.group)).size;
  const items = page.locator('#preview-list > li');
  await expect(items).toHaveCount(groups, { timeout: 60_000 });
  await expect(page.locator('#preview-list')).not.toHaveAttribute('aria-busy', /.*/, { timeout: 60_000 });

  await items
    .filter({ has: page.locator('.message-subject', { hasText: new RegExp(`^${UNTICKED_SUBJECT}$`) }) })
    .getByRole('checkbox', { name: en.actions.include })
    .uncheck();
  await expect(page.locator('#review-included')).toHaveText(`${String(groups - 1)} of ${String(groups)} emails will be in the PDF.`);
  await page.getByLabel(en.preview.zone).selectOption(ZONE);
  await expect(page.getByLabel(en.preview.zone)).toHaveValue(ZONE);
  await expect(makeButton(page)).not.toHaveAttribute('aria-disabled', /.*/, { timeout: 60_000 });
  await expect(page.locator('#download-note')).toHaveText(en.download.available);
  const emails = expectedEmails();
  expect(emails).toHaveLength(groups - 1);
  return emails;
}

/** Presses "Make the PDF" and returns the downloaded bytes. */
async function makePdf(page: Page): Promise<Uint8Array> {
  const next = page.waitForEvent('download', { timeout: 60_000 });
  await makeButton(page).click();
  const download = await next;
  // Named after the day it was made in the CHOSEN zone (still 1 June in New York, 2 June in Tokyo).
  expect(download.suggestedFilename()).toBe(`correspondence-${inZone(FIXED_NOW).day}.pdf`);
  return new Uint8Array(readFileSync(await download.path()));
}

/** Once everything has settled: nothing left the page, no CSP violation, every worker known and ended, nothing stored. */
async function expectNothingLeftThePage(page: Page): Promise<void> {
  await page.waitForTimeout(500);
  // After the page's own files: the workers' blob: URLs, and at most once
  // the PDF's, the one blob: URL of the "Download again" link (all
  // own-origin, in memory). Chromium may or may not list the download of a
  // blob: URL as a request; nothing else may be there.
  const ownBlob = new RegExp(`^blob:${escapeRegExp(origin)}/[0-9a-f-]+$`);
  const workerUrls = new Set(watch.workers.map((w) => w.url()));
  for (const url of workerUrls) expect(url).toMatch(ownBlob);
  const pdfUrl = await page.locator('#download-link').getAttribute('href');
  expect(pdfUrl).toMatch(ownBlob);
  expect(workerUrls.has(pdfUrl ?? '')).toBe(false);
  const others = watch.requests.slice(loadedAt).filter((url) => !workerUrls.has(url));
  expect(others.length).toBeLessThanOrEqual(1);
  expect(others.filter((url) => url !== pdfUrl)).toEqual([]);
  expect(watch.requests.every((url) => url.startsWith('blob:') || new URL(url).origin === origin)).toBe(true);
  expect(watch.websockets).toEqual([]);
  const browserName = engineOf(page.context());
  const violations = withoutSelectReports(browserName, await page.evaluate(() => window.__contentViolations));
  expect(untoleratedReports(browserName, violations)).toEqual([]);
  expect(workerCspReports(watch)).toEqual([]);
  const named = (['parse-worker', 'engine-worker', 'pdf-worker'] as const).reduce((sum, name) => sum + workersNamed(watch, watch.workers, name).length, 0);
  expect(named).toBe(watch.workers.length);
  await expect.poll(() => watch.closedWorkers.length).toBe(watch.workers.length);
  const directives = violations.filter(isParseTimeReport).map((v) => v.split(' ')[0] ?? '');
  const consoleProblems = withoutSelectConsole(browserName, problems);
  for (const known of PARSE_TIME_CONSOLE) {
    expect(consoleProblems.filter((p) => known.line.test(p)).length).toBeLessThanOrEqual(directives.filter((x) => known.directives.includes(x)).length);
  }
  expect(consoleProblems.filter((p) => !PARSE_TIME_CONSOLE.some((known) => known.line.test(p)))).toEqual([]);
  const stored = await page.evaluate(async () => ({
    localStorage: localStorage.length,
    sessionStorage: sessionStorage.length,
    indexedDB: (await indexedDB.databases()).length,
    caches: (await caches.keys()).length,
    cookie: document.cookie,
  }));
  expect(stored).toEqual({ localStorage: 0, sessionStorage: 0, indexedDB: 0, caches: 0, cookie: '' });
}

// ---------------------------------------------------------------- the tests

/** The section of the email of this fixture (by its duplicate group). */
function sectionOf(doc: ReadBack, emails: ReturnType<typeof expectedEmails>, id: string): Section {
  const group = sources.find((s) => s.id === id)?.group;
  const k = emails.findIndex((e) => e.first.group === group);
  const section = doc.sections[k];
  if (section === undefined) throw new Error(`${id} is not in the PDF`);
  return section;
}

test('the PDF as made by default: cover, index, pages, and only what each writer wrote', async ({ page }) => {
  test.setTimeout(90_000);
  const emails = await prepare(page);
  const doc = await readBack(await makePdf(page), emails.length);
  checkFront(doc, emails, inZone(FIXED_NOW).full);
  const sectionText = doc.sections.map((s) => norm(s.copied));

  // Each email: its first own line (the first line of its body with text; the manifest's first snippet for the HTML-only ones).
  for (const [k, e] of emails.entries()) {
    const firstLine = e.first.body === null ? e.first.snippets[0] : e.first.body.split('\n').find((line) => line.trim() !== '');
    expect(firstLine, e.first.id).toBeDefined();
    expect(sectionText[k], e.first.id).toContain(norm(referenceDisplayText(firstLine ?? '')));
    // Attachments, in the email too: the label, then name, size and type.
    for (const a of e.first.attachments) {
      const text = sectionText[k] ?? '';
      expect(text).toContain(attachmentText(a));
      expect(text.lastIndexOf(en.preview.attachments, text.indexOf(attachmentText(a)))).toBeGreaterThan(text.indexOf(e.first.snippets[0] ?? '?'));
    }
    if (e.first.attachments.length === 0) expect(sectionText[k]).not.toContain(`${en.preview.attachments} `);
  }

  // Quoted history added by the mail app: out of the reply (its reply header
  // too), still in the email it came from, so exactly once in the PDF.
  // [reply, a line of its reply header, quoted text, the email it came from]
  const appQuotes: [string, string, string, string][] = [
    ['eml/11-order-2-bob-outlook-en.eml', 'Sent: Monday, March 3, 2025 9:15 AM', 'We are furnishing a small office for four people', 'eml/10-order-1-alice.eml'],
    ['eml/12-order-3-alice-gmail.eml', 'On Mon, 3 Mar 2025 at 14:02, Bob Sample', 'I can come by on Wednesday 5 March', 'eml/11-order-2-bob-outlook-en.eml'],
    ['eml/22-delivery-3-carol-gmail-fr.eml', 'Le mar. 4 mars 2025 \u{E0} 13:05, Alice Example', 'Please ring at the side door.', 'eml/21-delivery-2-alice-apple.eml'],
    ['msg-04-chain-3-bob-nl', 'Verzonden: woensdag 2 april 2025 14:15', 'the quote is accepted', 'msg-03-chain-2-alice-fr'],
  ];
  const everything = sectionText.join('\n');
  for (const [reply, header, quoted, from] of appQuotes) {
    expect(sources.find((s) => s.id === reply)?.body, reply).toContain(header);
    expect(everything, reply).not.toContain(header);
    expect(norm(sectionOf(doc, emails, reply).copied), reply).not.toContain(quoted);
    expect(norm(sectionOf(doc, emails, from).copied), from).toContain(quoted);
    expect(count(everything, quoted), quoted).toBe(1);
  }

  // A signature: only in the first email (in PDF order) where its sender wrote it.
  const signatures: [string, string][] = [
    ['alice@example.test', 'Sent from my laptop'],
    ['bob@furniture.example.test', 'DISCLAIMER: This e-mail and any attachments are confidential'],
  ];
  for (const [sender, text] of signatures) {
    const writers = emails.flatMap((e, k) => (e.first.fromAddress === sender && norm(e.first.body ?? '').includes(text) ? [k] : []));
    expect(writers.length, text).toBeGreaterThan(2);
    expect(count(everything, text), text).toBe(1);
    expect(sectionText[writers[0]!], text).toContain(text);
  }

  // A quote the writer answered between its lines: kept, attribution and all, in order;
  // its "> " marks not printed; quoted and own lines at the same x, one step in from the header rows (tasks 8.1, 8.6).
  const answersSection = sectionOf(doc, emails, ANSWERS_ID);
  const answers = norm(answersSection.copied);
  const quotedLines = ['I will leave the office key at the front desk on Monday, so your team can', 'start whenever suits you. The old desks are already in the storage room.'];
  const inOrder = [
    'My answers are between your lines.',
    'On Fri, 28 Feb 2025 at 17:00, Alice Example <alice@example.test> wrote:',
    ...quotedLines,
    'Good, the van will take the old desks on Friday.',
    'Price list: desk[U+0007]chair',
    'Caf\u{E9} cr\u{E8}me \u{E0} c\u{F4}t\u{E9}.',
  ];
  let at = -1;
  for (const text of inOrder) {
    const found = answers.indexOf(text, at + 1);
    expect(found, text).toBeGreaterThan(at);
    at = found;
  }
  const xOf = (text: string): number => {
    const line = answersSection.lines.find((l) => norm(l.copied).startsWith(norm(text)));
    if (line === undefined) throw new Error(`no line ${text}`);
    return line.runs[0]!.x;
  };
  const own = xOf('My answers are between your lines.');
  expect(xOf('Good, the van will take the old desks on Friday.')).toBeCloseTo(own, 2);
  // No step per quote level: the quoted lines at the same x as the own text,
  // which is 14 pt in from the header labels (src/pdf/layout/config.ts, bodyIndent).
  for (const text of quotedLines) expect(xOf(text), text).toBeCloseTo(own, 2);
  expect(own - xOf('From')).toBeCloseTo(14, 2);
  for (const l of answersSection.lines) expect(l.copied, 'no quote mark at a line start').not.toMatch(/^\s*>/u);

  // ANSWERS' header rows, from the manifest: each label, then its value, in
  // order (From, Sent by, To, Cc, Date in the chosen zone, Subject).
  const fixture = FIXTURES.find((f) => f.id === ANSWERS_ID);
  const answersMs = fixture?.date.utcMs;
  if (fixture === undefined || fixture.sender === undefined || answersMs === null || answersMs === undefined) throw new Error(`${ANSWERS_ID}: no date or no Sender`);
  const v = en.preview;
  const mailboxes = (list: readonly ExpectedAddress[]): string => list.map((m) => fill(v.mailbox, { name: m.name, address: m.address })).join(', ');
  expect([fixture.sender, ...fixture.cc]).toEqual([ANSWERS_SENDER, ANSWERS_CC]);
  const rowLabels = new Set([v.from, v.author.sender, v.to, v.cc, v.bcc, v.date, v.subject]);
  const headerRows = sectionOf(doc, emails, ANSWERS_ID)
    .lines.filter((l) => l.insertedSpaces > 0 && rowLabels.has(l.runs[0]?.copied ?? ''))
    .map((l) => l.copied);
  expect(headerRows, `${ANSWERS_ID}: header rows`).toEqual([
    `${v.from} ${mailboxes(fixture.from)}`,
    `${v.author.sender} ${mailboxes([fixture.sender])}`,
    `${v.to} ${mailboxes(fixture.to)}`,
    `${v.cc} ${mailboxes(fixture.cc)}`,
    `${v.date} ${inZone(answersMs).full}`,
    `${v.subject} ${fixture.subject ?? '?'}`,
  ]);

  // Accents are real glyphs: shown as they are copied. The only codes drawn
  // in the emails are those of ANSWERS: the emoji the fonts lack, and the
  // control character.
  const lines = doc.sections.flatMap((s) => s.lines);
  for (const text of ['Nous avons bien re\u{E7}u votre commande', 'Cr\u{E8}me, ch\u{E2}teau, No\u{EB}l, \u{E7}a va.', 'financi\u{EB}le afhandeling', 'coloris \u{AB} gris clair \u{BB}']) {
    const line = lines.find((l) => l.copied.includes(text));
    expect(line?.shown, text).toContain(text);
  }
  const coded = lines.filter((l) => l.shown.includes('[U+'));
  expect(coded.map((l) => l.shown)).toEqual(['Good, the van will take the old desks on Friday. [U+1F600]', 'Price list:    desk[U+0007]chair']);
  // The emoji: drawn as its code, copied as itself.
  expect(coded[0]?.copied).toBe('Good, the van will take the old desks on Friday. \u{1F600}');
  // The control character: drawn and copied as its code, never as itself.
  expect(coded[1]?.copied).not.toContain('\u{7}');
  // Both lines are several runs (text, then the code in its own span), joined with no space put in.
  expect(coded.map((l) => [l.runs.length > 1, l.insertedSpaces])).toEqual([
    [true, 0],
    [true, 0],
  ]);

  expect(downloads).toHaveLength(1);
  await expectNothingLeftThePage(page);
});

test('"Print full original text": every email\'s whole text, in order', async ({ page }) => {
  test.setTimeout(90_000);
  const emails = await prepare(page);
  await page.getByLabel(en.pdf.everything).check();
  await expect(page.locator('#preview-list[data-pdf-labels="ready"]')).toHaveCount(1);
  await expect(makeButton(page)).not.toHaveAttribute('aria-disabled', /.*/);
  const doc = await readBack(await makePdf(page), emails.length);
  checkFront(doc, emails, inZone(FIXED_NOW).full);

  // Invisible characters (src/pdf/text.ts, group 2) are not in the copy
  // layer: the copy layer is what you see. The fixtures have none; dropped
  // from the expectation all the same.
  const INVISIBLE: readonly (readonly [number, number])[] = [
    [0x34f, 0x34f],
    [0x61c, 0x61c],
    [0x200b, 0x200f],
    [0x2060, 0x2064],
    [0xfe00, 0xfe0f],
    [0xfeff, 0xfeff],
  ];
  const visible = (text: string): string =>
    Array.from(text)
      .filter((c) => !INVISIBLE.some(([lo, hi]) => (c.codePointAt(0) ?? 0) >= lo && (c.codePointAt(0) ?? 0) <= hi))
      .join('');
  let htmlOnly = 0;
  for (const [k, e] of emails.entries()) {
    const section = norm(doc.sections[k]?.copied ?? '');
    // Every email: the manifest's hand-written snippets, in order, as the PDF writes them.
    let at = -1;
    for (const snippet of e.first.snippets) {
      const found = section.indexOf(norm(visible(referenceDisplayText(snippet))), at + 1);
      expect(found, `${e.first.id}: ${snippet}`).toBeGreaterThan(at);
      at = found;
    }
    const bodies = e.files.map((f) => f.body);
    if (bodies.every((b) => b === null)) {
      // From HTML (no DOMParser here): the snippets only.
      htmlOnly++;
      continue;
    }
    // The whole body, as the PDF writes it. The files of a duplicate group are identical emails: one body for all.
    const shown = bodies.map((b) => (b === null ? null : norm(visible(referenceDisplayText(b)))));
    expect(new Set(shown).size, `${e.first.id}: the bodies of its duplicate group`).toBe(1);
    expect(section, `${e.first.id}: the whole body is in its part of the PDF`).toContain(shown[0] ?? '?');
  }
  expect(htmlOnly).toBe(2);

  // What the default PDF leaves out is in: the quoted history, every repeated signature.
  const everything = doc.sections.map((s) => norm(s.copied)).join('\n');
  expect(everything).toContain('Sent: Monday, March 3, 2025 9:15 AM');
  expect(count(everything, 'Sent from my laptop')).toBeGreaterThan(1);

  expect(downloads).toHaveLength(1);
  await expectNothingLeftThePage(page);
});
