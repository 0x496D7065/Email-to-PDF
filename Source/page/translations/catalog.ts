// The languages the page ships, in the order the language picker shows them
// (Source/page/app.ts). Adding a language: write its file (same shape as en.ts,
// typed as `Messages`), then add it to both tables below. The picker
// appears by itself once there are two or more (English, French and Dutch
// today).
//
// Kept apart from index.ts so the strings system has one place that lists
// the languages; tests add a synthetic language here with vi.mock (see
// tests/support/test-locale.ts), so nothing test-only is ever bundled.

import { en } from './en';
import { fr } from './fr';
import { nl } from './nl';
import type { Messages } from './index';

/** Language code (lowercase primary subtag, e.g. 'en') -> its strings. */
export const CATALOG: Readonly<Record<string, Messages>> = { en, fr, nl };

/**
 * Each language's name in that language (its endonym), shown in the
 * picker. Never translated: a reader looks for their own language's name.
 */
export const LANGUAGE_NAMES: Readonly<Record<string, string>> = { en: 'English', fr: 'Français', nl: 'Nederlands' };
