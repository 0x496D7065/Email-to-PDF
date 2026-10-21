// The strings system: t('group.key', params) returns the text for the page.
//
// Why our own tiny version instead of an i18n library: we only need
// "look up a string, fill in {name} placeholders, pick a plural form", which
// is a few lines, and every dependency is something to trust and audit
// (README.md, rule R3). The browser's built-in Intl.PluralRules and
// Intl.NumberFormat know the plural and number rules of each language.
//
// Safety: t() returns plain text. Callers must only put it into the page
// with textContent (src/ui/dom.ts does this), so a value such as a file name
// can never be read as HTML (README.md, rule R4). Nothing is stored anywhere
// (README.md, rule R5): the language is a constant for now.
//
// Type checking: `MessageKey` is the list of every valid key, built from
// en.ts, so a typo in a key is a compile error. The params are checked too:
// t('drop.reading', { done: 1, total: 3 }) compiles, a missing or misspelled
// placeholder does not, and a plural entry always needs a numeric `count`.

import { en } from './en';

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
type Args<K extends string> = [PlaceholdersOf<At<typeof en, K>>] extends [never] ? [] : [params: ParamsFor<K>];
/** The keys whose text has no placeholder, so t(key) needs no params (e.g. for a list of keys). */
export type PlainMessageKey = { [K in MessageKey]: Args<K> extends [] ? K : never }[MessageKey];

/** The page language (BCP 47 tag). Also used for <html lang>. */
export const LOCALE = 'en';
const messages: Messages = en;
const pluralRules = new Intl.PluralRules(LOCALE);
const numberFormat = new Intl.NumberFormat(LOCALE);

/** Looks up a dotted key in a language file. undefined if it does not exist. */
export function lookup(table: Messages, key: string): string | PluralForms | undefined {
  let node: unknown = table;
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null || !Object.hasOwn(node, part)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node === 'string') return node;
  if (isPluralForms(node)) return node;
  return undefined;
}

/** True for an object with exactly the plural shape { one, other }. */
export function isPluralForms(value: unknown): value is PluralForms {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).length === 2 && typeof v.one === 'string' && typeof v.other === 'string';
}

/** The `{name}` placeholders of a template, in order of appearance (duplicates kept). */
export function placeholdersIn(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '');
}

/**
 * Replaces each `{name}` with its param. Numbers are written the local way
 * (1,234 in English). A placeholder without a param is left as it is, so a
 * mistake shows up as visible "{name}" text instead of crashing the page.
 */
export function interpolate(template: string, params: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    if (!Object.hasOwn(params, name)) return whole;
    const value = params[name];
    return typeof value === 'number' ? numberFormat.format(value) : String(value);
  });
}

/** Picks the plural form for `count` with the language's own rules. */
export function pluralForm(forms: PluralForms, count: number): string {
  return pluralRules.select(count) === 'one' ? forms.one : forms.other;
}

/**
 * The text for `key` in the page language, placeholders filled in.
 * Put the result into the page with textContent only.
 */
export function t<K extends MessageKey>(key: K, ...args: Args<K>): string {
  const params: Readonly<Record<string, string | number>> = args[0] ?? {};
  const value = lookup(messages, key);
  // Only reachable by bypassing the types (e.g. a key built at run time):
  // show the key rather than nothing, so the mistake is visible.
  if (value === undefined) return key;
  if (typeof value === 'string') return interpolate(value, params);
  const count = params.count;
  return interpolate(pluralForm(value, typeof count === 'number' ? count : Number.NaN), params);
}
