// The strings system: t('group.key', params) returns the text for the page.
//
// Why our own tiny version instead of an i18n library: we only need
// "look up a string, fill in {name} placeholders, pick a plural form", which
// is a few lines, and every dependency is something to trust and audit
// (README.md, rule R3). The browser's built-in Intl.PluralRules,
// Intl.NumberFormat and Intl.ListFormat know the plural, number and list
// rules of each language.
//
// Safety: t() returns plain text. Callers must only put it into the page
// with textContent (src/ui/dom.ts does this), so a value such as a file name
// can never be read as HTML (README.md, rule R4). Nothing is stored anywhere
// (README.md, rule R5): the chosen language lives in this module's memory
// only (no storage, no cookie, no URL), and "Clear everything" keeps it.
//
// Languages: the ones shipped are listed in catalog.ts. One language is
// ACTIVE at a time (setLocale / getLocale, 'en' until the page picks one),
// and t() uses it. translator(locale) gives the text, number, list and
// plural rules of one language explicitly: the PDF worker uses it with the
// language of its request and never reads the active one. A translator is
// made once per language and kept: it holds only that language's strings
// and Intl objects, never any email text.
//
// Detection is NOT done here: src/main.ts calls pickLocale() once with the
// browser's list, so tests never follow the machine's own language.
//
// Type checking: `MessageKey` is the list of every valid key, built from
// en.ts, so a typo in a key is a compile error. The params are checked too:
// t('drop.reading', { done: 1, total: 3 }) compiles, a missing or misspelled
// placeholder does not, and a plural entry always needs a numeric `count`.

import { CATALOG, LANGUAGE_NAMES } from './catalog';
import type { en } from './en';

/** The two plural forms we use. English, French and Dutch need only these two. */
export interface PluralForms {
    readonly one: string;
    readonly other: string;
}

/** The shape of a language file: same keys as en.ts, any string values. */
type Widen<T> = T extends string ? string : { readonly [K in keyof T]: Widen<T[K]> };
export type Messages = Widen<typeof en>;

/** Every key, as a dotted path, e.g. 'steps.add.title' or 'warnings.parse.no-body'. */
type Leaves<T, Prefix extends string = ''> = {
    [K in keyof T & string]: T[K] extends string | PluralForms ? `${Prefix}${K}` : Leaves<T[K], `${Prefix}${K}.`>;
}[keyof T & string];
export type MessageKey = Leaves<typeof en>;

/** The English value at a dotted key (its literal type, used to find the placeholders). */
type At<T, K extends string> = K extends `${infer Head}.${infer Rest}`
    ? Head extends keyof T
        ? At<T[Head], Rest>
        : never
    : K extends keyof T
        ? T[K]
        : never;

/** 'Reading file {done} of {total}' -> 'done' | 'total'. */
type Placeholders<S> = S extends `${string}{${infer Name}}${infer Rest}` ? Name | Placeholders<Rest> : never;
type PlaceholdersOf<V> = V extends PluralForms
    ? Placeholders<V['one']> | Placeholders<V['other']> | 'count'
    : Placeholders<V>;

type ParamsFor<K extends string> = {
    readonly [P in PlaceholdersOf<At<typeof en, K>>]: P extends 'count' ? number : string | number;
};
/** No second argument for a string without placeholders, a params object otherwise. */
export type MessageArgs<K extends string> = [PlaceholdersOf<At<typeof en, K>>] extends [never] ? [] : [params: ParamsFor<K>];
/** The keys whose text has no placeholder, so t(key) needs no params (e.g. for a list of keys). */
export type PlainMessageKey = { [K in MessageKey]: MessageArgs<K> extends [] ? K : never }[MessageKey];

/** The language used until the page picks one, and when nothing better fits. */
export const DEFAULT_LOCALE = 'en';

/** The languages shipped (lowercase primary subtags, e.g. 'en'), in the picker's order. */
export const SUPPORTED_LOCALES: readonly string[] = Object.freeze(Object.keys(CATALOG));

/** True for a language code the page ships (exact match: 'en', not 'EN' or 'en-GB'). */
export function isSupportedLocale(value: unknown): value is string
{
    return typeof value === 'string' && SUPPORTED_LOCALES.includes(value);
}

/**
 * The language to start with, from the browser's preferred languages
 * (navigator.languages, most preferred first). Only the FIRST one counts (a
 * user decision): its primary subtag, in any case ('fr' of 'fr-BE'), if the
 * page ships it, else English. The rest of the list is never looked at.
 * Pure: src/main.ts passes the browser's list.
 */
export function pickLocale(languages: readonly string[], supported: readonly string[] = SUPPORTED_LOCALES): string
{
    const first = languages[0];
    if (typeof first !== 'string')
    {
        return DEFAULT_LOCALE;
    }
    const primary = first.trim().toLowerCase().split(/[-_]/)[0] ?? '';
    return supported.includes(primary) ? primary : DEFAULT_LOCALE;
}

/** A language's name in that language (e.g. "English"), for the picker. Never translated. */
export function languageName(locale: string): string
{
    return (Object.hasOwn(LANGUAGE_NAMES, locale) ? LANGUAGE_NAMES[locale] : undefined) ?? locale;
}

/** The text, number, list and plural rules of one language. */
export interface Translator {
    /** Its code, also the BCP 47 tag for <html lang> and Intl. */
    readonly locale: string;
    /** The text for `key`, placeholders filled in. Put the result into the page with textContent only. */
    readonly t: <K extends MessageKey>(key: K, ...args: MessageArgs<K>) => string;
    /** A number written the language's way (1,234 in English). */
    readonly number: (value: number) => string;
    /** Texts joined the language's way ("a, b, c"). */
    readonly list: (items: readonly string[]) => string;
    /** The plural form for `count`, with the language's own rules. */
    readonly plural: (forms: PluralForms, count: number) => string;
}

let active = DEFAULT_LOCALE;
const translators = new Map<string, Translator>();

/** Makes `locale` the page language for t(). Throws for a language the page does not ship (a bug). */
export function setLocale(locale: string): void
{
    if (!isSupportedLocale(locale))
    {
        throw new Error(`setLocale(): unsupported language "${String(locale)}"`);
    }
    active = locale;
}

/** The page language (its code, also used for <html lang>). */
export function getLocale(): string
{
    return active;
}

/** Looks up a dotted key in a language file. undefined if it does not exist. */
export function lookup(table: Messages, key: string): string | PluralForms | undefined
{
    let node: unknown = table;
    for (const part of key.split('.'))
    {
        if (typeof node !== 'object' || node === null || !Object.hasOwn(node, part))
        {
            return undefined;
        }
        node = (node as Record<string, unknown>)[part];
    }
    if (typeof node === 'string')
    {
        return node;
    }
    if (isPluralForms(node))
    {
        return node;
    }
    return undefined;
}

/** True for an object with exactly the plural shape { one, other }. */
export function isPluralForms(value: unknown): value is PluralForms
{
    if (typeof value !== 'object' || value === null)
    {
        return false;
    }
    const v = value as Record<string, unknown>;
    return Object.keys(v).length === 2 && typeof v.one === 'string' && typeof v.other === 'string';
}

/** The `{name}` placeholders of a template, in order of appearance (duplicates kept). */
export function placeholdersIn(template: string): string[]
{
    return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '');
}

/**
 * Replaces each `{name}` with its param. Numbers are written the local way
 * (1,234 in English; `locale` defaults to the page language). A placeholder
 * without a param is left as it is, so a mistake shows up as visible
 * "{name}" text instead of crashing the page.
 */
export function interpolate(template: string, params: Readonly<Record<string, string | number>>, locale: string = active): string
{
    const tr = translator(locale);
    return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    {
        if (!Object.hasOwn(params, name))
        {
            return whole;
        }
        const value = params[name];
        return typeof value === 'number' ? tr.number(value) : String(value);
    });
}

/** Picks the plural form for `count` with the language's own rules (`locale` defaults to the page language). */
export function pluralForm(forms: PluralForms, count: number, locale: string = active): string
{
    return translator(locale).plural(forms, count);
}

/**
 * The translator of one shipped language, made once and kept (see the top
 * of this file). Throws for a language the page does not ship (a bug: the
 * PDF worker checks its request first, src/pipeline/pdf-protocol.ts).
 */
export function translator(locale: string): Translator
{
    const known = translators.get(locale);
    if (known !== undefined)
    {
        return known;
    }
    const messages = isSupportedLocale(locale) ? CATALOG[locale] : undefined;
    if (messages === undefined)
    {
        throw new Error(`translator(): unsupported language "${String(locale)}"`);
    }
    const pluralRules = new Intl.PluralRules(locale);
    const numberFormat = new Intl.NumberFormat(locale);
    const listFormat = new Intl.ListFormat(locale, { style: 'short', type: 'unit' });
    const tr: Translator = {
        locale,
        t: (key, ...args) =>
        {
            const params: Readonly<Record<string, string | number>> = args[0] ?? {};
            const value = lookup(messages, key);
            // Only reachable by bypassing the types (e.g. a key built at run time):
            // show the key rather than nothing, so the mistake is visible.
            if (value === undefined)
            {
                return key;
            }
            if (typeof value === 'string')
            {
                return interpolate(value, params, locale);
            }
            const count = params.count;
            return interpolate(tr.plural(value, typeof count === 'number' ? count : Number.NaN), params, locale);
        },
        number: (value) => numberFormat.format(value),
        list: (items) => listFormat.format(items),
        plural: (forms, count) => (pluralRules.select(count) === 'one' ? forms.one : forms.other),
    };
    translators.set(locale, tr);
    return tr;
}

/**
 * The text for `key` in the page language, placeholders filled in.
 * Put the result into the page with textContent only.
 */
export function t<K extends MessageKey>(key: K, ...args: MessageArgs<K>): string
{
    return translator(active).t(key, ...args);
}
