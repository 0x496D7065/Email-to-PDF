// Security headers for the built site: the single source of truth.
//
// Used ONLY at build time by vite.config.ts (never imported by the app):
//   - writes dist/_headers (Cloudflare Pages reads it and sends real HTTP headers)
//   - adds a <meta> CSP + referrer tag to dist/index.html as a fallback for
//     hosts that cannot set headers (e.g. GitHub Pages).
// Keeping the policy here once means the two copies can never drift apart.
//
// README.md, rule R2: TIGHTEN ONLY. Do not add 'unsafe-inline',
// 'unsafe-eval', hashes, nonces or remote hosts without the user's approval.

/** The Content Security Policy, one directive per entry: [name, sources]. */
export const CSP_DIRECTIVES: readonly (readonly [string, string])[] = [
  ['default-src', "'none'"],
  ['script-src', "'self'"],
  ['style-src', "'self'"],
  ['img-src', "'self' data: blob:"],
  ['font-src', "'self'"],
  ['connect-src', "'none'"],
  ['worker-src', "'self' blob:"],
  ['form-action', "'none'"],
  ['base-uri', "'none'"],
  ['object-src', "'none'"],
  ['frame-src', "'none'"],
  // Forbids other sites from embedding this page in a frame (clickjacking).
  // Browsers IGNORE this directive in a <meta> tag, so it is header-only.
  ['frame-ancestors', "'none'"],
];

/** Directives browsers ignore when the CSP comes from a <meta> tag. */
const HEADER_ONLY_DIRECTIVES = new Set(['frame-ancestors', 'report-uri', 'sandbox']);

/** Full policy for the HTTP header. */
export function cspForHeader(): string {
  return CSP_DIRECTIVES.map(([name, sources]) => `${name} ${sources}`).join('; ');
}

/** Same policy minus the header-only directives, for the <meta> fallback. */
export function cspForMeta(): string {
  return CSP_DIRECTIVES.filter(([name]) => !HEADER_ONLY_DIRECTIVES.has(name))
    .map(([name, sources]) => `${name} ${sources}`)
    .join('; ');
}

/**
 * Path of the service worker script (the offline copy of the site's own
 * files, src/sw/). It is written into dist/ by the build (vite.config.ts).
 */
export const SERVICE_WORKER_PATH = '/sw.js';

/**
 * The CSP of the service worker script's OWN response (/sw.js only).
 *
 * A service worker does not take the page's CSP: its own fetches (storing
 * the site's files, and answering the page from that copy) follow the CSP
 * sent with sw.js itself. With the page's `connect-src 'none'` it could not
 * store anything. User-approved exception, exactly this one: the page
 * policy with ONLY connect-src set to 'self' (the site's own address, never
 * another one). Everything else stays as strict as the page's:
 * `script-src 'self'` (the worker's own script is not checked against it,
 * and it loads no other script: the build check bans the call that would),
 * `worker-src 'self' blob:` (a service worker cannot start workers,
 * so this changes nothing), and `default-src 'none'` for the rest. The page
 * itself (header and <meta>) keeps `connect-src 'none'`.
 */
export function cspForServiceWorker(): string {
  return CSP_DIRECTIVES.map(([name, sources]) => `${name} ${name === 'connect-src' ? "'self'" : sources}`).join('; ');
}

/**
 * The security headers sent with the file at `pathname` (the same for every
 * file except the service worker script, which gets its own CSP). Used by
 * `npm run preview` (vite.config.ts); dist/_headers says the same for
 * Cloudflare Pages (cloudflareHeadersFile).
 */
export function securityHeadersFor(pathname: string): Record<string, string> {
  return {
    'Content-Security-Policy': pathname === SERVICE_WORKER_PATH ? cspForServiceWorker() : cspForHeader(),
    'Referrer-Policy': REFERRER_POLICY,
    'Permissions-Policy': PERMISSIONS_POLICY,
  };
}

/**
 * Powerful browser features the app never uses, all switched off.
 * `()` means "allowed for nobody". Reading dropped files / the file picker is
 * not a Permissions-Policy feature, so it is unaffected.
 */
export const PERMISSIONS_POLICY = [
  'accelerometer',
  'autoplay',
  'browsing-topics',
  'camera',
  'display-capture',
  'encrypted-media',
  'fullscreen',
  'geolocation',
  'gyroscope',
  'hid',
  'idle-detection',
  'magnetometer',
  'microphone',
  'midi',
  'payment',
  'publickey-credentials-get',
  'screen-wake-lock',
  'serial',
  'usb',
  'xr-spatial-tracking',
]
  .map((feature) => `${feature}=()`)
  .join(', ');

export const REFERRER_POLICY = 'no-referrer';

/**
 * Contents of dist/_headers in Cloudflare Pages format: a URL pattern line,
 * then indented "Name: value" lines. `/*` = every file on the site.
 *
 * The service worker script matches `/*` too. Cloudflare joins two values
 * of the same header with a comma, and a browser treats a comma-joined CSP
 * as two policies that must BOTH allow a request, so the page's
 * `connect-src 'none'` would still apply to it. Its rule therefore first
 * removes the CSP of `/*` (`! Content-Security-Policy`), then sets its own
 * (cspForServiceWorker). Its other headers are those of `/*`.
 */
export function cloudflareHeadersFile(): string {
  return [
    '# Generated by vite.config.ts from src/security/headers.ts. Do not edit dist/_headers.',
    '/*',
    `  Content-Security-Policy: ${cspForHeader()}`,
    `  Referrer-Policy: ${REFERRER_POLICY}`,
    `  Permissions-Policy: ${PERMISSIONS_POLICY}`,
    SERVICE_WORKER_PATH,
    '  ! Content-Security-Policy',
    `  Content-Security-Policy: ${cspForServiceWorker()}`,
    '',
  ].join('\n');
}
