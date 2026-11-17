// A synthetic, test-only language for the language-switching tests: every
// English string of Source/page/translations/en.ts with each ASCII letter swapped for an
// accented look-alike and the whole text in brackets, e.g. "Add your emails"
// -> "[Àďď ýöüŕ éɱàîļš]". Placeholders ({count}, {name}...) are kept as they
// are, so t() fills them in exactly like in English. After a switch, any
// English word still on the page is one that was not rewritten.
//
// The app's name is kept as it is: it is never translated (a user decision).
//
// Never bundled: only test files import this, and they add it to the
// catalog with vi.mock, e.g.
//   vi.mock('./translations/catalog', async (importOriginal) =>
//     withTestLocales(await importOriginal(), ['xx']));
// so the shipped page has English only.

import { en } from '../../Source/page/translations/en';
import type { Messages } from '../../Source/page/translations/index';

/** The code of the synthetic language (not a real language). */
export const TEST_LOCALE = 'xx';

const LOWER = 'àƀçďéƒğĥîĵķļɱñöþʠŕšţüṽŵẋýž';
const UPPER = 'ÀƁÇĎÉƑĞĤÎĴĶĻṀÑÖÞǪŔŠŢÜṼŴẊÝŽ';

/** One letter's look-alike (anything that is not an ASCII letter is kept). */
function swap(ch: string): string
{
    const code = ch.charCodeAt(0);
    if (code >= 97 && code <= 122)
    {
        return LOWER[code - 97] ?? ch;
    }
    if (code >= 65 && code <= 90)
    {
        return UPPER[code - 65] ?? ch;
    }
    return ch;
}

/** "[...]" with every letter swapped, placeholders kept. */
export function pseudo(text: string): string
{
    const parts = text.split(/(\{\w+\})/);
    return `[${parts.map((part) => (/^\{\w+\}$/.test(part) ? part : Array.from(part, swap).join(''))).join('')}]`;
}

/** Same shape as en: strings and plural forms rewritten with pseudo(). */
function rewrite(value: unknown, path: string): unknown
{
    if (typeof value === 'string')
    {
        return path === 'app.name' ? value : pseudo(value);
    }
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, inner]) => [key, rewrite(inner, path === '' ? key : `${path}.${key}`)]),
    );
}

/** The synthetic language's strings. */
export function testMessages(): Messages
{
    return rewrite(en, '') as Messages;
}

/** Its name in the picker (in brackets, so it is never taken for a real language's name). */
export function testLanguageName(locale: string): string
{
    return `[Pseudo ${locale}]`;
}

/** The shape of Source/page/translations/catalog.ts. */
interface Catalog
{
    readonly CATALOG: Readonly<Record<string, Messages>>;
    readonly LANGUAGE_NAMES: Readonly<Record<string, string>>;
}

/** The real catalog plus the synthetic language under each code of `locales` (for vi.mock). */
export function withTestLocales(real: Catalog, locales: readonly string[] = [TEST_LOCALE]): Catalog
{
    const messages = testMessages();
    return {
        CATALOG: { ...real.CATALOG, ...Object.fromEntries(locales.map((code) => [code, messages])) },
        LANGUAGE_NAMES: { ...real.LANGUAGE_NAMES, ...Object.fromEntries(locales.map((code) => [code, testLanguageName(code)])) },
    };
}
