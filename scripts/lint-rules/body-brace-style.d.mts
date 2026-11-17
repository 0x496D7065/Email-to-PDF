// Type declarations for body-brace-style.mjs, so its TypeScript test can
// import that plain-JS module under strict type checking. Keep in sync with it.
import type { Rule } from 'eslint';

declare const rule: Rule.RuleModule;
export default rule;
