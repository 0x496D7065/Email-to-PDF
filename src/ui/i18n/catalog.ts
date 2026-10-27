// The languages the page ships, in the order the language picker shows them
// (src/ui/app.ts). Adding a language: write its file (same shape as en.ts,
// typed as `Messages`), then add it to both tables below. The picker
// appears by itself once there are two or more.
//
// Kept apart from index.ts so the strings system has one place that lists
// the languages; tests add a synthetic language here with vi.mock (see
// tests/support/test-locale.ts), so nothing test-only is ever bundled.

import { en } from './en';
import type { Messages } from './index';

/** Language code (lowercase primary subtag, e.g. 'en') -> its strings. */
export const CATALOG: Readonly<Record<string, Messages>> = { en };

/**
 * Each language's name in that language (its endonym), shown in the
 * picker. Never translated: a reader looks for their own language's name.
 */
export const LANGUAGE_NAMES: Readonly<Record<string, string>> = { en: 'English' };
