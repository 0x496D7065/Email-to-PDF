// Browser test of the "no network" guarantee and the Content Security Policy
// (README.md, rules R1, R2 and R3). Runs against the built site served by
// `vite preview` (see playwright.config.ts).
//
// Only reserved `.invalid` domains are used: they can never resolve to a real
// server. On top of that, a safety net aborts any request that leaves the
// local preview server, so even a broken CSP could not reach the internet.
import { expect, test, type BrowserContext, type Page, type Request } from '@playwright/test';
import { cspForHeader, cspForMeta, PERMISSIONS_POLICY, REFERRER_POLICY } from '../src/security/headers.ts';

/** What we keep from each `securitypolicyviolation` event. */
interface Violation {
  directive: string;
  blockedURI: string;
  /** The policy that was violated: tells the header CSP and the meta CSP apart. */
  policy: string;
}

declare global {
  interface Window {
    __cspViolations: Violation[];
  }
}

/**
 * Request types that mean "the page talked to a server on its own".
 * WebSockets are not in this list: Playwright does not report them as
 * requests, so they are recorded separately by `routeWebSocket` (see
 * watchNetwork).
 */
const FORBIDDEN_TYPES = ['fetch', 'xhr', 'eventsource', 'ping'];

// Shared per-test state, reset in beforeEach. This assumes the tests in this
// file never run in parallel within one worker (true with the current config:
// Playwright runs the tests of a file one after another unless
// `fullyParallel` or `test.describe.configure({ mode: 'parallel' })` is set).
let origin = '';
let requests: Request[] = [];
let websockets: string[] = [];

/**
 * Records every request of the context (pages and their workers) and aborts
 * any request that is not to the local preview server (safety net).
 * WebSockets never reach `context.on('request')` or `context.route`; the
 * `routeWebSocket` handler both records and closes them (the app has no
 * reason to open one), so test (a) sees any attempt. Recording must happen
 * here: once routed, Playwright substitutes the page's WebSocket, so it may
 * produce neither a `page.on('websocket')` event nor a CSP violation.
 * WebSockets opened inside workers are not covered by routeWebSocket (and
 * their CSP violations fire inside the worker); the app has no workers yet —
 * add a worker test when it does.
 */
async function watchNetwork(context: BrowserContext): Promise<void> {
  context.on('request', (request) => requests.push(request));
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort('blockedbyclient'),
  );
  await context.routeWebSocket(/.*/, async (ws) => {
    websockets.push(ws.url());
    await ws.close();
  });
}

/** CSP violations collected in the page since it loaded. */
function violations(page: Page): Promise<Violation[]> {
  return page.evaluate(() => window.__cspViolations);
}

test.beforeEach(async ({ context, page, baseURL }) => {
  origin = new URL(baseURL ?? '').origin;
  requests = [];
  websockets = [];
  await watchNetwork(context);
  // Runs in the page before any of the app's scripts: stores each CSP
  // violation on `window` so the test can read them back.
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations.push({
        directive: event.effectiveDirective,
        blockedURI: event.blockedURI,
        policy: event.originalPolicy,
      });
    });
  });
});

test('loads with zero requests outside its own origin', async ({ page }) => {
  // "networkidle" = no request for 500 ms, i.e. the app has settled.
  await page.goto('/', { waitUntil: 'networkidle' });

  const urls = requests.map((request) => request.url());
  expect(urls.length).toBeGreaterThan(0);
  for (const url of urls) expect(new URL(url).origin, url).toBe(origin);

  const talking = requests.filter((request) => FORBIDDEN_TYPES.includes(request.resourceType()));
  expect(talking.map((request) => `${request.resourceType()} ${request.url()}`)).toEqual([]);
  expect(websockets).toEqual([]);
});

test('loads with zero CSP violations', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  expect(await violations(page)).toEqual([]);
});

test('sends the security headers and the meta CSP', async ({ page }) => {
  const response = await page.goto('/');
  expect(response).not.toBeNull();
  const headers = response?.headers() ?? {};
  expect(headers['content-security-policy']).toBe(cspForHeader());
  expect(headers['referrer-policy']).toBe(REFERRER_POLICY);
  expect(headers['permissions-policy']).toBe(PERMISSIONS_POLICY);

  const meta = page.locator('meta[http-equiv="Content-Security-Policy"]');
  await expect(meta).toHaveAttribute('content', cspForMeta());
});

test('shows the placeholder status text', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toHaveText(/Everything stays in your browser/);
});

/** Does forbidden things inside the page: a fetch() and a remote image. */
async function tryForbiddenThings(page: Page): Promise<void> {
  const fetchResult = await page.evaluate(async () => {
    try {
      await fetch('https://example.invalid/x');
      return 'resolved';
    } catch {
      return 'rejected';
    }
  });
  expect(fetchResult).toBe('rejected');

  await page.evaluate(() => {
    const img = document.createElement('img');
    img.src = 'https://example.invalid/p.png';
    document.body.append(img);
  });
}

/** Violations as sorted "directive blockedURI | policy" strings. */
async function violationKeys(page: Page): Promise<string[]> {
  return (await violations(page)).map((v) => `${v.directive} ${v.blockedURI} | ${v.policy}`).sort();
}

/**
 * Checks that it was the CSP that stopped the image, not the safety net:
 * Chromium reports the blocked image as a request that failed with reason
 * "csp" (a request aborted by the safety net would show a different reason).
 * The blocked fetch never even becomes a request.
 */
async function expectImageBlockedByCsp(): Promise<void> {
  await expect
    .poll(() =>
      requests
        .filter((request) => new URL(request.url()).origin !== origin)
        .map((request) => `${request.url()} ${request.failure()?.errorText ?? 'not failed'}`),
    )
    .toEqual(['https://example.invalid/p.png csp']);
}

// Positive control: proves the CSP is really enforced, by deliberately doing
// forbidden things inside the page and checking the browser blocks them.
// Both policies (header and meta) must report each violation on their own,
// so a silently ignored copy would make this test fail.
test('the CSP blocks fetch() and remote images (header and meta)', async ({ page }) => {
  await page.goto('/', { waitUntil: 'networkidle' });
  await tryForbiddenThings(page);

  // Violation events arrive asynchronously, so poll until all are recorded.
  const expected = [];
  for (const policy of [cspForHeader(), cspForMeta()]) {
    expected.push(`connect-src https://example.invalid/x | ${policy}`);
    expected.push(`img-src https://example.invalid/p.png | ${policy}`);
  }
  await expect.poll(() => violationKeys(page)).toEqual(expected.sort());

  await expectImageBlockedByCsp();
});

// Hosts that cannot send headers (e.g. GitHub Pages) rely on the meta tag
// alone. Serve the same page WITHOUT the CSP header and check the meta tag
// still blocks everything on its own. The safety net stays active.
test('the meta CSP alone blocks fetch() and remote images', async ({ page }) => {
  await page.route(
    (url) => url.origin === origin && url.pathname === '/',
    async (route) => {
      const response = await route.fetch();
      const headers = { ...response.headers() };
      delete headers['content-security-policy'];
      await route.fulfill({ response, headers, body: await response.text() });
    },
  );

  const response = await page.goto('/', { waitUntil: 'networkidle' });
  expect(response?.headers()['content-security-policy']).toBeUndefined();
  expect(await violations(page)).toEqual([]);

  await tryForbiddenThings(page);

  const policy = cspForMeta();
  await expect
    .poll(() => violationKeys(page))
    .toEqual(
      [`connect-src https://example.invalid/x | ${policy}`, `img-src https://example.invalid/p.png | ${policy}`].sort(),
    );

  await expectImageBlockedByCsp();
});
