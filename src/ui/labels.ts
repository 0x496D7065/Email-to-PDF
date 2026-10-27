// Our own fixed words on the page, recorded so they can be written again in
// another language (src/ui/page.ts, setLanguage).
//
// Each record is an element, a string key, its params (our own numbers
// only, such as a step number) and where the text goes: the element's text
// or one of its attributes (e.g. aria-label). Never a closure, and never an
// email's text: a record only says WHICH of our strings goes WHERE, so it
// keeps nothing of the user's alive. Texts made from an email (a mailbox
// line, a fold label) are rewritten by their module from its own state
// instead (each module's relabel()).
//
// Text goes in with textContent and attributes through setSafeAttribute
// (src/ui/dom.ts), like everywhere else (README.md, rule R4).

import { setSafeAttribute } from './dom';
import { t, type MessageArgs, type MessageKey } from './i18n';

interface LabelRecord {
  readonly element: Element;
  /** null: the element's text; else the attribute's name. */
  readonly attribute: string | null;
  readonly key: MessageKey;
  readonly params: Readonly<Record<string, string | number>> | undefined;
}

/** A module's fixed words: set once, written again by relabel(). */
export interface StaticLabels {
  /** Sets `element`'s text to t(key, params) now and on each relabel(). Returns the element. */
  text<E extends Element, K extends MessageKey>(element: E, key: K, ...args: MessageArgs<K>): E;
  /** Sets the attribute `name` of `element` to t(key, params) now and on each relabel(). Returns the element. */
  attr<E extends Element, K extends MessageKey>(element: E, name: string, key: K, ...args: MessageArgs<K>): E;
  /** Writes every recorded text again, in the page language now. */
  relabel(): void;
}

/** Untyped call of t(), for a key and params already checked when they were recorded. */
const textOf = (record: LabelRecord): string =>
  (t as (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string)(record.key, record.params);

function apply(record: LabelRecord): void {
  const text = textOf(record);
  if (record.attribute === null) record.element.textContent = text;
  else setSafeAttribute(record.element, record.attribute, text);
}

export function createStaticLabels(): StaticLabels {
  const records: LabelRecord[] = [];
  const add = (record: LabelRecord): void => {
    apply(record);
    records.push(record);
  };
  return {
    text(element, key, ...args) {
      add({ element, attribute: null, key, params: args[0] });
      return element;
    },
    attr(element, name, key, ...args) {
      add({ element, attribute: name, key, params: args[0] });
      return element;
    },
    relabel() {
      for (const record of records) apply(record);
    },
  };
}
