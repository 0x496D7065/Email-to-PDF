// Colour contrast check (WCAG AA) for browser tests, without an
// accessibility library (no new dependency): every visible element with text
// of its own must reach 4.5:1 against its background, 3:1 for large text.
// Used by Helper/Test/browser-tests/app-shell.spec.ts (the empty page) and Helper/Test/browser-tests/preview.spec.ts
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
                const numbers = color.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 1];
                return [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0, numbers[3] ?? 1];
            };
            const luminance = ([r, g, b]: Rgba): number =>
            {
                const channel = (channelValue: number): number =>
                {
                    const scaled = channelValue / 255;
                    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
                };
                return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
            };
            // The first ancestor with an opaque background colour (white if none).
            const background = (start: Element): Rgba =>
            {
                for (let element: Element | null = start; element; element = element.parentElement)
                {
                    const backgroundRgba = parse(getComputedStyle(element).backgroundColor);
                    if (backgroundRgba[3] > 0)
                    {
                        return backgroundRgba;
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
                const textLuminance = luminance(parse(style.color));
                const backgroundLuminance = luminance(background(element));
                const ratio = (Math.max(textLuminance, backgroundLuminance) + 0.05) / (Math.min(textLuminance, backgroundLuminance) + 0.05);
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
