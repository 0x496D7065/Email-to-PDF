// Keyboard differences between the test browsers that the Tab-order tests
// must allow for.

/**
 * Does the Tab key skip links in this browser? WebKit does, like Safari by
 * default: links are reached with Option+Tab, or with Tab once the reader
 * turns on Safari's "Press Tab to highlight each item on a webpage". The
 * page leaves that choice to the reader (no tabindex to force it), so in
 * WebKit the Ko-fi button, the page's only link, is not a Tab stop.
 * Chromium and Firefox stop on links on Windows and Linux (where these
 * tests run). On macOS, Firefox (like Safari and WebKit) skips links by
 * default unless the reader changes the system or browser setting.
 */
export function tabSkipsLinks(browserName: string): boolean
{
    return browserName === 'webkit';
}
