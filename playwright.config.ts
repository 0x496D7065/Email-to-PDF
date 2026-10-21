// Playwright: end-to-end tests in a real browser. Run with: npm run test:e2e
//
// The tests in e2e/ load the BUILT site (what we publish) and check the
// "no network" guarantee and the Content Security Policy
// (README.md, rules R1, R2 and R3).
import { defineConfig, devices } from '@playwright/test';

// Fixed address so the tests know which origin is "ours". 127.0.0.1 instead
// of "localhost" avoids IPv4/IPv6 ambiguity on Windows.
const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${String(PORT)}`;

export default defineConfig({
  testDir: 'e2e',
  // Plain console output; no HTML report folder is generated.
  reporter: 'list',
  retries: 0,
  use: { baseURL: BASE_URL },
  // The three browser engines. WebKit is Safari's engine, not Safari itself.
  // Install them with: npm run test:e2e:install
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  // Playwright starts this server before the tests and stops it afterwards.
  // It always rebuilds first, so the tests never run against a stale dist/.
  // `vite preview` serves dist/ with the same security headers as Cloudflare
  // (see `preview.headers` in vite.config.ts). --strictPort makes it fail
  // instead of silently picking another port.
  webServer: {
    command: `npm run build && npm run preview -- --host 127.0.0.1 --port ${String(PORT)} --strictPort`,
    url: BASE_URL,
    // Never reuse a server that happens to be running: always test a fresh build.
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
