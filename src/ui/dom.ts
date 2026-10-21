// The one way the page builds HTML elements: el('p', { text: 'Hello' }).
//
// Why a helper: email content is untrusted (README.md, rule R4). This file
// only uses createElement, setAttribute, textContent and append, which can
// never turn a string into markup or code. On top of that it refuses the
// attributes that could run code or load something, even with a string we
// wrote ourselves, so a mistake fails loudly instead of opening a hole:
// - event handlers (any name starting with "on", e.g. onclick);
// - srcdoc (a whole HTML document inside a frame), srcset, and style (inline styles
//   are blocked by the Content Security Policy anyway, README.md, rule R2);
// - URL attributes, except href/src holding a '#fragment' or a plain
//   relative path on the same site. Anything with a scheme (javascript:,
//   data:, https:, ...) or starting with // is refused (README.md, rule R1).
//   Only setBlobHref (below) may set a blob: URL, and only one this page
//   made itself (the finished PDF, already in memory).
// - tags that can run code, load things or hold raw markup (script, iframe,
//   style, template, ...): only the tags in SAFE_TAGS can be created.

/** Tags the page may create. Add a tag here only if it cannot run code or load anything. */
export const SAFE_TAGS = [
  'a',
  'button',
  'details',
  'div',
  'dd',
  'dl',
  'dt',
  'em',
  'fieldset',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'header',
  'input',
  'label',
  'legend',
  'li',
  'main',
  'nav',
  'ol',
  'option',
  'output',
  'p',
  'pre',
  'progress',
  'section',
  'select',
  'small',
  'span',
  'strong',
  'summary',
  'time',
  'ul',
] as const;
export type SafeTag = (typeof SAFE_TAGS)[number];

/** Attributes that take a URL. Only href and src are allowed, and only with safe values. */
const URL_ATTRIBUTES = new Set([
  'action',
  'background',
  'cite',
  'data',
  'formaction',
  'href',
  'manifest',
  'ping',
  'poster',
  'src',
  'srcset',
]);
const ALLOWED_URL_ATTRIBUTES = new Set(['href', 'src']);
// Inline styles are blocked by the CSP anyway (README.md, rule R2).
const FORBIDDEN_ATTRIBUTES = new Set(['style']);

// Lowercase letters, digits and dashes: covers id, class, aria-*, data-*,
// for, type, role... and rules out odd names such as "xlink:href".
const ATTRIBUTE_NAME = /^[a-z][a-z0-9-]*$/;
// A same-site relative path: letters, digits and a few safe signs, no colon
// (so no scheme), no backslash, no spaces. An optional ?query or #fragment
// uses the same characters plus = & %.
const RELATIVE_URL = /^[A-Za-z0-9._~/-]+(?:[?#][A-Za-z0-9._~/?#=&%-]*)?$/;
// A fragment: '#' then no spaces or backslashes. Control characters are
// refused separately (hasControlCharacter): browsers silently drop tabs and
// newlines inside URLs, which could hide a scheme.
const FRAGMENT = /^#[^\s\\]*$/;

/** True if the text holds a control character (code 0-31 or 127). */
function hasControlCharacter(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Is `value` a safe URL for href/src? Only '#fragment' or a relative path on
 * the same site (never starting with //, which would be another site).
 */
export function isSafeUrl(value: string): boolean {
  if (hasControlCharacter(value)) return false;
  if (value.startsWith('#')) return FRAGMENT.test(value);
  return !value.startsWith('//') && RELATIVE_URL.test(value);
}

/**
 * Is `value` a blob: URL made by this page with URL.createObjectURL, i.e.
 * exactly "blob:" + the page's origin + "/" + an id of hex digits and
 * dashes? Such a URL points at data already in this tab's memory (the
 * finished PDF), never at the network. `origin` is the page's own
 * (location.origin); an opaque origin ("null") is refused.
 */
export function isOwnBlobUrl(value: string, origin: string): boolean {
  if (hasControlCharacter(value) || origin === '' || origin === 'null') return false;
  const prefix = `blob:${origin}/`;
  return value.startsWith(prefix) && /^[0-9A-Fa-f-]+$/.test(value.slice(prefix.length));
}

/**
 * The one exception to the href rule above, for step 3's download link
 * (src/ui/download-step.ts): sets `href` to a blob: URL made by this page
 * (see isOwnBlobUrl). Throws for anything else. el() and setSafeAttribute
 * keep refusing every blob: URL.
 */
export function setBlobHref(link: HTMLAnchorElement, url: string, origin: string): void {
  if (!isOwnBlobUrl(url, origin)) throw new Error('setBlobHref(): href may only hold a blob: URL made by this page');
  link.setAttribute('href', url);
}

/**
 * Why setting this attribute is refused, or null if it is fine.
 * Pure function, unit tested without a DOM.
 */
export function attributeProblem(name: string, value: string): string | null {
  if (!ATTRIBUTE_NAME.test(name)) return `attribute name "${name}" is not allowed`;
  if (name.startsWith('on')) return `event handler attribute "${name}" is not allowed (use addEventListener)`;
  if (FORBIDDEN_ATTRIBUTES.has(name)) return `attribute "${name}" is not allowed`;
  // Every src-something except src itself: srcset, and the frame attribute
  // that holds a whole HTML document. Matched by prefix so that word never
  // appears in the built code, where the build check bans it outright.
  if (name.startsWith('src') && name !== 'src') return `attribute "${name}" is not allowed`;
  if (URL_ATTRIBUTES.has(name)) {
    if (!ALLOWED_URL_ATTRIBUTES.has(name)) return `URL attribute "${name}" is not allowed`;
    if (!isSafeUrl(value)) return `"${name}" may only hold a #fragment or a relative same-site path`;
  }
  return null;
}

/** Attribute values: a string, or true (present, empty) / false (left out), e.g. { disabled: true }. */
export type AttributeValue = string | boolean;

export interface ElementOptions {
  readonly attrs?: Readonly<Record<string, AttributeValue>>;
  /** Set with textContent: always shown as text, never read as HTML. */
  readonly text?: string;
  /** Appended in order. A string becomes a text node (never HTML). */
  readonly children?: readonly (Node | string)[];
}

/** Sets one attribute after checking it (see attributeProblem). Throws if refused. */
export function setSafeAttribute(element: Element, name: string, value: AttributeValue): void {
  if (value === false) {
    // Removing is harmless, but an odd name is still a bug in our code.
    if (!ATTRIBUTE_NAME.test(name)) throw new Error(`el(): attribute name "${name}" is not allowed`);
    element.removeAttribute(name);
    return;
  }
  const text = value === true ? '' : value;
  const problem = attributeProblem(name, text);
  if (problem !== null) throw new Error(`el(): ${problem}`);
  element.setAttribute(name, text);
}

/**
 * Creates an element. Throws (instead of silently skipping) when asked for a
 * tag or attribute that is not allowed: that is a bug in our code, and it
 * should be found by the tests, not hidden.
 */
export function el<K extends SafeTag>(tag: K, options: ElementOptions = {}): HTMLElementTagNameMap[K] {
  // Checked at run time too, in case a tag arrives through an `as` cast.
  if (!(SAFE_TAGS as readonly string[]).includes(tag)) throw new Error(`el(): tag "${tag}" is not allowed`);
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(options.attrs ?? {})) setSafeAttribute(element, name, value);
  if (options.text !== undefined) element.textContent = options.text;
  if (options.children !== undefined) element.append(...options.children);
  return element;
}
