// Browser test of the page shell: one screen, three steps (add, check,
// download), accessible and working under the strict CSP (README.md, rules
// R1, R2 and R4). Runs in Chromium against the built site served by
// `vite preview` (see playwright.config.ts).
//
// No accessibility library (such as axe-core) is used, to avoid a new
// dependency: landmarks, names, keyboard order, focus outlines and colour
// contrast are checked explicitly below.
import { expect, test, type Page } from '@playwright/test';
import { en } from '../src/ui/i18n/en.ts';

declare global {
  interface Window {
    __shellViolations: string[];
    __focusables: Element[];
  }
}

/** Console errors and uncaught page errors, collected per test. */
let problems: string[] = [];

test.beforeEach(async ({ page }) => {
  problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  // Records CSP violations before any of the app's scripts run.
  await page.addInitScript(() => {
    window.__shellViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__shellViolations.push(`${event.effectiveDirective} ${event.blockedURI}`);
    });
  });
});

/** Opens the page and waits until the shell is built. */
async function open(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'networkidle' });
  await expect(page.getByRole('main')).toBeVisible();
}

test('shows the three steps in order, with landmarks, language and title', async ({ page }) => {
  await open(page);

  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page).toHaveTitle(en.app.name);

  await expect(page.getByRole('banner')).toHaveCount(1);
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByRole('contentinfo')).toHaveCount(1);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(en.app.name);
  await expect(page.getByRole('banner')).toContainText(en.app.promise);

  const steps = [en.steps.add.title, en.steps.check.title, en.steps.download.title];
  const headings = page.getByRole('main').getByRole('heading', { level: 2 });
  await expect(headings).toHaveText(steps.map((title, i) => `Step ${String(i + 1)} ${title}`));

  // Each step is a region named by its heading, so it can be reached directly.
  for (const [i, title] of steps.entries()) {
    await expect(page.getByRole('region', { name: `Step ${String(i + 1)} ${title}` })).toBeVisible();
  }
});

test('starts with step 2 waiting and the download unavailable but explained', async ({ page }) => {
  await open(page);

  await expect(page.locator('#check-waiting')).toHaveText(en.steps.check.waiting);
  await expect(page.locator('#check-area')).toBeHidden();

  const download = page.getByRole('button', { name: en.actions.downloadPdf });
  await expect(download).toHaveAttribute('aria-disabled', 'true');
  await expect(download).toHaveAccessibleDescription(en.steps.download.comingSoon);
  // Assistive technology (and Playwright) see it as disabled...
  await expect(download).toBeDisabled();
  // ...yet it can still be focused, and pressing it does nothing (no
  // navigation, no error). The keyboard is used because Playwright refuses
  // to click a button it considers disabled.
  const url = page.url();
  await download.focus();
  await expect(download).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Space');
  expect(page.url()).toBe(url);
  expect(problems).toEqual([]);
});

test('has one polite live region for status messages', async ({ page }) => {
  await open(page);
  const live = page.locator('[aria-live]');
  await expect(live).toHaveCount(1);
  await expect(live).toHaveAttribute('aria-live', 'polite');
  await expect(live).toHaveAttribute('role', 'status');
  await expect(page.getByRole('status')).toHaveCount(1);
});

test('gives every control an accessible name', async ({ page }) => {
  await open(page);
  const roles = ['button', 'link', 'checkbox', 'radio', 'textbox', 'combobox'] as const;
  let controls = 0;
  for (const role of roles) {
    for (const control of await page.getByRole(role).all()) {
      await expect(control).toHaveAccessibleName(/\S/);
      controls++;
    }
  }
  expect(controls).toBeGreaterThan(0);
});

test('reaches every interactive element with Tab, in page order, with a visible focus outline', async ({ page }) => {
  await open(page);

  const count = await page.evaluate(() => {
    const selector = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]';
    window.__focusables = [...document.querySelectorAll(selector)].filter(
      (e) =>
        !(e as HTMLButtonElement).disabled && e.getAttribute('tabindex') !== '-1' && e.getClientRects().length > 0,
    );
    // A positive tabindex would break the natural order: there must be none.
    return document.querySelectorAll('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])').length === 0
      ? window.__focusables.length
      : -1;
  });
  expect(count).toBeGreaterThan(0);

  for (let i = 0; i < count; i++) {
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
      const active = document.activeElement;
      const style = active ? getComputedStyle(active) : null;
      return {
        index: active ? window.__focusables.indexOf(active) : -1,
        outlineStyle: style?.outlineStyle ?? 'none',
        outlineWidth: Number.parseFloat(style?.outlineWidth ?? '0'),
      };
    });
    expect(focus.index).toBe(i);
    expect(focus.outlineStyle).not.toBe('none');
    expect(focus.outlineWidth).toBeGreaterThanOrEqual(2);
  }
});

test('has enough colour contrast for every text (WCAG AA)', async ({ page }) => {
  await open(page);

  const failures = await page.evaluate(() => {
    type Rgba = [number, number, number, number];
    const parse = (color: string): Rgba => {
      const n = color.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 1];
      return [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 1];
    };
    const luminance = ([r, g, b]: Rgba): number => {
      const channel = (v: number): number => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    // The first ancestor with an opaque background colour (white if none).
    const background = (start: Element): Rgba => {
      for (let e: Element | null = start; e; e = e.parentElement) {
        const bg = parse(getComputedStyle(e).backgroundColor);
        if (bg[3] > 0) return bg;
      }
      return [255, 255, 255, 1];
    };

    const found: string[] = [];
    let checked = 0;
    for (const element of document.querySelectorAll('body *')) {
      const ownText = [...element.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
      if (!ownText || element.getClientRects().length === 0) continue;
      const style = getComputedStyle(element);
      const fg = luminance(parse(style.color));
      const bg = luminance(background(element));
      const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
      const size = Number.parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      checked++;
      if (ratio < (large ? 3 : 4.5)) found.push(`${element.tagName} "${element.textContent}" ${ratio.toFixed(2)}:1`);
    }
    return checked > 5 ? found : [`only ${String(checked)} texts checked`];
  });
  expect(failures).toEqual([]);
});

test('fits a narrow phone screen without sideways scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await open(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('has no inline styles, no inline handlers and no links to other sites', async ({ page }) => {
  await open(page);
  const found = await page.evaluate(() =>
    [...document.querySelectorAll('*')].flatMap((e) =>
      [...e.attributes]
        .filter((a) => a.name === 'style' || a.name.startsWith('on') || /^(href|src)$/.test(a.name))
        .map((a) => `${e.tagName} ${a.name}`)
        // The page's own script and stylesheet are the only allowed src/href.
        .filter((s) => !/^(SCRIPT src|LINK href)$/.test(s)),
    ),
  );
  expect(found).toEqual([]);
});

test('loads without console errors, page errors or CSP violations', async ({ page }) => {
  await open(page);
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => window.__shellViolations)).toEqual([]);
  expect(problems).toEqual([]);
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('explains that JavaScript is needed', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.noscript')).toContainText('needs JavaScript');
    expect(problems).toEqual([]);
  });
});
