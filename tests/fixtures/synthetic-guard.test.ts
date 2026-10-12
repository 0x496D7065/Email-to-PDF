// Privacy safety net for the test fixtures (README.md, rule R7: test data is
// synthetic only). Fails the test run if anything under
// tests/fixtures/ looks like it could be, or contain, a real email:
//   1. a file type other than .eml / .ts / .md (in particular any .msg file
//      on disk: .msg fixtures are built in memory from msg/specs.ts), or any
//      hidden (dot) file or folder,
//   2. an .eml that is not 7-bit ASCII (so the string read here is exactly
//      the file's bytes) or lacks the "X-Synthetic-Fixture: true" header,
//   3. an email address, Message-ID, URL (also "//host"), www host or bare
//      host with a common real TLD that is not a reserved test name (*.test,
//      *.invalid), or an IP address outside the documentation ranges; also
//      inside base64 (nested too), quoted-printable, RFC 2047, HTML
//      character references and percent-encoded text,
//   4. a .msg spec with such an address, or a built .msg without the marker,
//   5. manifest.ts out of sync with the .eml files and the .msg specs.
//
// Files are read with Vite's import.meta.glob + "?raw" (no Node types needed).
// `exhaustive: true` makes the glob include dot-files and dot-folders, which it
// skips by default; there is no node_modules under tests/fixtures/ to slow it.

import MsgReader from '@kenjiuno/msgreader';
import { describe, expect, it } from 'vitest';
import {
  findForbiddenHosts,
  hasHiddenSegment,
  hasSyntheticMarker,
  isAllowedHost,
  isReservedTestHost,
  isSevenBitAscii,
} from './guard-rules';
import { FIXTURES } from './manifest';
import { buildMsgView, SYNTHETIC_MARKER_PROP_ID, SYNTHETIC_MARKER_VALUE } from './msg/builder';
import { MSG_SPECS } from './msg/specs';

/** Every file under tests/fixtures/, keyed "./eml/01-plain-english.eml", as text. */
const files = import.meta.glob<string>('./**/*', { query: '?raw', import: 'default', eager: true, exhaustive: true });
const paths = Object.keys(files).sort();
const emlPaths = paths.filter((p) => /\.eml$/i.test(p));

describe('synthetic fixture guard', () => {
  it('finds the fixture files', () => {
    expect(emlPaths.length).toBeGreaterThan(0);
  });

  it.each(paths)('%s has an allowed file type', (path) => {
    // .msg on disk would be binary and cannot be checked here: build them from specs instead.
    expect(/\.(eml|ts|md)$/.test(path), `${path}: only .eml, .ts and .md files may live in tests/fixtures/`).toBe(true);
  });

  it.each(paths)('%s is not a hidden (dot) file or inside a dot-folder', (path) => {
    expect(hasHiddenSegment(path), `${path}: no dot-files or dot-folders in tests/fixtures/`).toBe(false);
  });

  it.each(emlPaths)('%s is 7-bit ASCII and marked synthetic', (path) => {
    const text = files[path] ?? '';
    expect(isSevenBitAscii(text), `${path}: encode non-ASCII text with quoted-printable, base64 or RFC 2047`).toBe(true);
    expect(hasSyntheticMarker(text), `${path}: missing "X-Synthetic-Fixture: true" header`).toBe(true);
  });

  it.each(paths)('%s uses only reserved test domains', (path) => {
    expect(findForbiddenHosts(files[path] ?? ''), path).toEqual([]);
  });

  it.each(MSG_SPECS.map((s) => [s.id, s] as const))('.msg spec %s uses only reserved test domains', (_, spec) => {
    expect(findForbiddenHosts(JSON.stringify(spec, null, 1))).toEqual([]);
  });

  it.each(MSG_SPECS.map((s) => [s.id, s] as const))('.msg spec %s carries the synthetic marker when built', (_, spec) => {
    const reader = new MsgReader(buildMsgView(spec));
    reader.parserConfig = { includeRawProps: true, ansiEncoding: 'windows-1252' };
    const marker = reader.getFileData().rawProps?.find((p) => p.propertyTag?.startsWith(SYNTHETIC_MARKER_PROP_ID));
    expect(marker?.value).toBe(SYNTHETIC_MARKER_VALUE);
  });

  it('manifest.ts lists exactly the .eml files and the .msg specs, once each', () => {
    const ids = FIXTURES.map((f) => f.id);
    expect(new Set(ids).size, 'duplicate manifest ids').toBe(ids.length);
    expect(FIXTURES.filter((f) => f.kind === 'eml').map((f) => f.id).sort()).toEqual(emlPaths.map((p) => p.slice(2)));
    expect(FIXTURES.filter((f) => f.kind === 'msg').map((f) => f.id).sort()).toEqual(MSG_SPECS.map((s) => s.id).sort());
  });
});

// The guard must itself be trustworthy: prove each rule catches a planted
// problem. Bad domains are assembled from pieces so this file's own source
// (which the guard also scans) never contains one.
describe('synthetic fixture guard rules (self-test)', () => {
  const bad = ['planted', 'example', 'com'].join('.');
  const badAddress = `someone@${bad}`;
  // Not a reserved name, but no "real" TLD either: only the email rule can catch it,
  // so it proves each DECODING step on its own (the bare-host rule stays silent).
  const hidden = ['planted', 'example'].join('.');
  const hiddenAddress = `someone@${hidden}`;
  const ip = (...parts: number[]): string => parts.join('.');

  it('accepts reserved test hosts only', () => {
    expect(isReservedTestHost('example.test')).toBe(true);
    expect(isReservedTestHost('mail.example.invalid')).toBe(true);
    expect(isReservedTestHost(bad)).toBe(false);
    expect(isReservedTestHost('test.example')).toBe(false);
    expect(isAllowedHost('[2001:db8::1]')).toBe(true);
    expect(isAllowedHost(ip(203, 0, 113, 9))).toBe(true);
    expect(isAllowedHost(ip(10, 0, 0, 1))).toBe(false);
  });

  it('flags plain, URL and www hosts', () => {
    expect(findForbiddenHosts(`To: ${badAddress}`)).not.toEqual([]);
    expect(findForbiddenHosts(`see ${'https:'}//${bad}/x`)).not.toEqual([]);
    expect(findForbiddenHosts(`see www.${hidden}`)).not.toEqual([]);
    expect(findForbiddenHosts('To: a@example.test, <b@x.invalid>, cid:c@example.test, https://x.invalid/p.png')).toEqual([]);
  });

  it('flags protocol-relative URLs', () => {
    expect(findForbiddenHosts(`<img src="${'//'}${hidden}/p.png">`)).not.toEqual([]);
    expect(findForbiddenHosts(`<img src="${'//'}user@${hidden}:8080/p.png">`)).not.toEqual([]);
    expect(findForbiddenHosts('<img src="//cdn.invalid/p.png"> //[2001:db8::1]/x // a comment')).toEqual([]);
  });

  it('flags bare host names with a common real TLD', () => {
    expect(findForbiddenHosts(`Visit ${bad} today.`)).not.toEqual([]);
    expect(findForbiddenHosts(`shop.${'co'}.${'uk'}`)).not.toEqual([]);
    expect(findForbiddenHosts(`MAIL.${'EXAMPLE'}.${'DE'}`)).not.toEqual([]);
    expect(findForbiddenHosts(`write to ${'mail'}.${'ru'} today`)).not.toEqual([]);
    expect(findForbiddenHosts('Visit shop.example.test or x.com.invalid; version 1.2; e.g. this.')).toEqual([]);
  });

  it('flags IPv4 addresses outside the documentation and loopback ranges', () => {
    expect(findForbiddenHosts(`Received: from [${ip(10, 1, 2, 3)}]`)).not.toEqual([]);
    expect(findForbiddenHosts(`DNS ${ip(8, 8, 8, 8)}.`)).not.toEqual([]);
    expect(findForbiddenHosts(`see ${'http:'}//${ip(198, 51, 101, 1)}:80/x`)).not.toEqual([]);
    const allowed = [ip(192, 0, 2, 10), ip(198, 51, 100, 7), ip(203, 0, 113, 255), ip(127, 0, 0, 1)].join(' ');
    expect(findForbiddenHosts(`${allowed} at 10:00:00, version 1.2.3`)).toEqual([]);
  });

  it('flags IPv6 addresses outside 2001:db8::/32 and ::1', () => {
    expect(findForbiddenHosts(`from [${['2001', '4860', '', '8888'].join(':')}]`)).not.toEqual([]);
    expect(findForbiddenHosts(['fe80', '0', '0', '0', '1', '2', '3', '4'].join(':'))).not.toEqual([]);
    expect(findForbiddenHosts(`see ${'http:'}//[${['2600', '', '1'].join(':')}]/x`)).not.toEqual([]);
    expect(findForbiddenHosts('from [2001:db8::25] and [::1] at 10:00:00 +0100, 2001:DB8:0:0:0:0:0:1')).toEqual([]);
  });

  it('flags non-ASCII (IDN) email domains', () => {
    expect(findForbiddenHosts(`To: someone@b\u00fccher.${'example'}`)).not.toEqual([]);
    expect(findForbiddenHosts(`To: <someone@\u4f8b\u3048.${'example'}>`)).not.toEqual([]);
    expect(findForbiddenHosts('To: someone@b\u00fccher.test')).toEqual([]);
  });

  it('flags hosts hidden by base64, quoted-printable and RFC 2047', () => {
    const base64 = `Content-Transfer-Encoding: base64\n\n${btoa(`Mail ${hiddenAddress} now`)}\n`;
    expect(findForbiddenHosts(base64)).not.toEqual([]);
    const softBreak = `${hiddenAddress.slice(0, 12)}=\n${hiddenAddress.slice(12)}`;
    expect(findForbiddenHosts(softBreak)).not.toEqual([]);
    const qpEscaped = hiddenAddress.replace('@', '=40');
    expect(findForbiddenHosts(qpEscaped)).not.toEqual([]);
    const encodedWord = `From: =?UTF-8?B?${btoa(hiddenAddress)}?=`;
    expect(findForbiddenHosts(encodedWord)).not.toEqual([]);
  });

  it('decodes RFC 2047 words at the end of a line and words split over two encoded words', () => {
    const b = (s: string): string => `=?UTF-8?B?${btoa(s)}?=`;
    const q = (s: string): string => `=?UTF-8?Q?${s.replace('@', '=40')}?=`;
    // A word that ends the line: the "?=" + line end must not be taken for a QP soft break.
    expect(findForbiddenHosts(`Subject: ${b(hiddenAddress)}\r\nX-A: 1\r\n`)).not.toEqual([]);
    expect(findForbiddenHosts(`Subject: ${b(hiddenAddress)}\nX-A: 1\n`)).not.toEqual([]);
    // Whitespace between adjacent encoded words is dropped (RFC 2047 section 6.2).
    expect(findForbiddenHosts(`Subject: ${b(hiddenAddress.slice(0, 10))} ${b(hiddenAddress.slice(10))}\n`)).not.toEqual([]);
    expect(findForbiddenHosts(`Subject: ${q(hiddenAddress.slice(0, 11))} ${q(hiddenAddress.slice(11))}\n`)).not.toEqual([]);
    // Folded across two header lines.
    expect(findForbiddenHosts(`Subject: ${b(hiddenAddress.slice(0, 10))}\r\n ${b(hiddenAddress.slice(10))}\r\n`)).not.toEqual([]);
    // Clean folded words stay clean.
    expect(findForbiddenHosts(`Subject: ${b('a@example')}\r\n ${q('.test')}\r\n`)).toEqual([]);
  });

  it('decodes an RFC 2047 word split by a QP soft break right after one of its own "?"', () => {
    const data = btoa(hiddenAddress);
    expect(findForbiddenHosts(`From: =?UTF-8?=\nB?${data}?= <a@example.test>\n`)).not.toEqual([]);
    expect(findForbiddenHosts(`From: =?UTF-8?B?=\r\n${data}?= <a@example.test>\r\n`)).not.toEqual([]);
    // The same split around a clean word stays clean.
    expect(findForbiddenHosts(`From: =?UTF-8?=\nB?${btoa('a@example.test')}?= <a@example.test>\n`)).toEqual([]);
  });

  it('decodes HTML references and percent-encoding inside RFC 2047 words', () => {
    const b = (s: string): string => `=?UTF-8?B?${btoa(s)}?=`;
    expect(findForbiddenHosts(`Subject: ${b(hiddenAddress.replace('@', '&#64;'))}\n`)).not.toEqual([]);
    expect(findForbiddenHosts(`Subject: ${b(hiddenAddress.replace('@', '%40'))}\n`)).not.toEqual([]);
    expect(findForbiddenHosts(`Subject: ${b('a&#64;example.test 10%40off')}\n`)).toEqual([]);
  });

  it('decodes layered encodings: HTML references or percent-encoding inside quoted-printable', () => {
    expect(findForbiddenHosts(hiddenAddress.replace('@', '=26#64;'))).not.toEqual([]);
    expect(findForbiddenHosts(`mailto:${hiddenAddress.replace('@', '=2540')}`)).not.toEqual([]);
  });

  it('flags hosts hidden by HTML character references and percent-encoding', () => {
    expect(findForbiddenHosts(hiddenAddress.replace('@', '&#64;'))).not.toEqual([]);
    expect(findForbiddenHosts(hiddenAddress.replace('@', '&#x40;'))).not.toEqual([]);
    expect(findForbiddenHosts(hiddenAddress.replace('@', '&commat;').replace('.', '&period;'))).not.toEqual([]);
    expect(findForbiddenHosts(`mailto:${hiddenAddress.replace('@', '%40')}`)).not.toEqual([]);
    expect(findForbiddenHosts('Caf&eacute; 10&nbsp;% off, 5 % &#233;t&#xE9;, a&#64;example.test')).toEqual([]);
  });

  it('decodes base64 parts whose Content-Transfer-Encoding is folded or has extra text', () => {
    const body = btoa(`Mail ${hiddenAddress} now`);
    expect(findForbiddenHosts(`Content-Transfer-Encoding:\n\tbase64\n\n${body}\n`)).not.toEqual([]);
    expect(findForbiddenHosts(`Content-Transfer-Encoding: BASE64 (comment)\r\n\r\n${body}\r\n`)).not.toEqual([]);
    expect(findForbiddenHosts(`content-transfer-encoding: "base64"; x=y\n\n${body.slice(0, 10)}\n${body.slice(10)}\n--b--\n`)).not.toEqual(
      [],
    );
  });

  it('decodes base64 inside an attached message/rfc822 (itself base64)', () => {
    const inner = `From: a@example.test\nContent-Type: text/plain\nContent-Transfer-Encoding: base64\n\n${btoa(hiddenAddress)}\n`;
    const outer = `Content-Type: message/rfc822\nContent-Transfer-Encoding: base64\n\n${btoa(inner)}\n`;
    expect(findForbiddenHosts(outer)).not.toEqual([]);
    expect(findForbiddenHosts(`Content-Type: message/rfc822\n\n${inner}`)).not.toEqual([]);
  });

  it('rejects hidden (dot) files and folders', () => {
    expect(hasHiddenSegment('./.x.eml')).toBe(true);
    expect(hasHiddenSegment('./eml/.hidden/a.eml')).toBe(true);
    expect(hasHiddenSegment('./eml/.DS_Store')).toBe(true);
    expect(hasHiddenSegment('./eml/a.eml')).toBe(false);
    expect(hasHiddenSegment('../fixtures/eml/a.b.eml')).toBe(false);
  });

  it('requires the marker in the top-level headers and 7-bit text', () => {
    expect(hasSyntheticMarker('From: a@example.test\nX-Synthetic-Fixture: true\n\nbody')).toBe(true);
    expect(hasSyntheticMarker('From: a@example.test\n\nX-Synthetic-Fixture: true')).toBe(false);
    expect(isSevenBitAscii('café')).toBe(false);
    expect(isSevenBitAscii('plain\r\ntext\t1')).toBe(true);
  });
});
