// Colour contrast check (WCAG AA) for browser tests, without an
// accessibility library (no new dependency): every visible element with text
// of its own must reach 4.5:1 against its background, 3:1 for large text.
// Used by e2e/app-shell.spec.ts (the empty page) and e2e/preview.spec.ts
// (the preview with folded text shown).
import type { Page } from '@playwright/test';

/**
 * The texts below `rootSelector` with too little contrast, as
 * 'TAG "text" ratio:1'. When fewer than `minChecked` texts were found, the
 * result is one entry saying so, so a check that saw nothing cannot pass.
 */
export async function contrastFailures(page: Page, rootSelector = 'body', minChecked = 6): Promise<string[]>
{
    return page.evaluate(
        ({ selector, min }) =>
        {
            type Rgba = [number, number, number, number];
            const parse = (color: string): Rgba =>
            {
                const n = color.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 1];
                return [n[0] ?? 0, n[1] ?? 0, n[2] ?? 0, n[3] ?? 1];
            };
            const luminance = ([r, g, b]: Rgba): number =>
            {
                const channel = (v: number): number =>
                {
                    const s = v / 255;
                    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
                };
                return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
            };
            // The first ancestor with an opaque background colour (white if none).
            const background = (start: Element): Rgba =>
            {
                for (let e: Element | null = start; e; e = e.parentElement)
                {
                    const bg = parse(getComputedStyle(e).backgroundColor);
                    if (bg[3] > 0)
                    {
                        return bg;
                    }
                }
                return [255, 255, 255, 1];
            };

            const found: string[] = [];
            let checked = 0;
            for (const element of document.querySelectorAll(`${selector}, ${selector} *`))
            {
                const ownText = [...element.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
                if (!ownText || element.getClientRects().length === 0)
                {
                    continue;
                }
                const style = getComputedStyle(element);
                const fg = luminance(parse(style.color));
                const bg = luminance(background(element));
                const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
                const size = Number.parseFloat(style.fontSize);
                const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
                checked++;
                if (ratio < (large ? 3 : 4.5))
                {
                    found.push(`${element.tagName} "${element.textContent}" ${ratio.toFixed(2)}:1`);
                }
            }
            return checked >= min ? found : [`only ${String(checked)} texts checked`];
        },
        { selector: rootSelector, min: minChecked },
    );
}
