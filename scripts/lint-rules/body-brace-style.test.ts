// Unit test for the local ESLint rule body-brace-style.mjs (task 9.6):
// small synthetic code snippets that must pass or fail, and the text the
// auto-fix makes of each failing one.
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';
import rule from './body-brace-style.mjs';

// RuleTester builds its own test cases; run them as vitest tests. (Set with
// Object.assign: the privacy guard of the test code would read the member
// access to `it` as a host name with the .it country domain.)
Object.assign(RuleTester, { describe, it, itOnly: it.only });

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });

tester.run('body-brace-style', rule, {
    valid: [
        'interface A\n{\n    a: number;\n}',
        'export interface B extends A\n{\n    b: string;\n}',
        'interface C\n{\n}',
        'enum D\n{\n    X,\n    Y,\n}',
        // Type literals, object literals and parameter types are not bodies.
        'type R = { a: number };',
        'function f(p: { a: number }): { b: string }\n{\n    return { b: String(p.a) };\n}',
        'const o = {};',
        'const p = () => ({});',
        'function q()\n{\n    return {};\n}',
        'type T = {};',
        'interface E\n{\n    nested: { a: number };\n}',
        // Code blocks: empty ones have their braces on separate lines.
        'function g()\n{\n}',
        'try\n{\n    g();\n}\ncatch\n{\n}',
        'const h = () =>\n{\n};',
        'class K\n{\n}',
        'class L\n{\n    static\n    {\n    }\n}',
        'declare global\n{\n}',
        // A comment alone in an empty block spreads it over lines already.
        'function m()\n{\n    // nothing to do\n}',
        'switch (x)\n{\n}',
        'switch (x)\n{\n    case 1:\n        break;\n}',
    ],
    invalid: [
        {
            code: 'interface A { a: number }',
            output: 'interface A\n{\na: number\n}',
            errors: [{ messageId: 'openOwnLine' }, { messageId: 'afterOpen' }, { messageId: 'closeOwnLine' }],
        },
        {
            code: 'export interface B extends A {\n    b: string;\n}',
            output: 'export interface B extends A\n{\n    b: string;\n}',
            errors: [{ messageId: 'openOwnLine' }],
        },
        {
            code: 'interface C {}',
            output: 'interface C\n{\n}',
            errors: [{ messageId: 'openOwnLine' }, { messageId: 'emptyOneLine' }],
        },
        {
            code: 'interface F\n{ /* note */ }',
            output: 'interface F\n{\n/* note */\n}',
            errors: [{ messageId: 'afterOpen' }, { messageId: 'closeOwnLine' }],
        },
        {
            code: 'enum D { X, Y }',
            output: 'enum D\n{\nX, Y\n}',
            errors: [{ messageId: 'openOwnLine' }, { messageId: 'afterOpen' }, { messageId: 'closeOwnLine' }],
        },
        {
            code: 'function g()\n{}',
            output: 'function g()\n{\n}',
            errors: [{ messageId: 'emptyOneLine' }],
        },
        {
            code: 'function m()\n{ /* nothing */ }',
            output: 'function m()\n{ /* nothing */\n}',
            errors: [{ messageId: 'emptyOneLine' }],
        },
        {
            code: 'const h = () =>\n{};',
            output: 'const h = () =>\n{\n};',
            errors: [{ messageId: 'emptyOneLine' }],
        },
        {
            code: 'class K\n{}',
            output: 'class K\n{\n}',
            errors: [{ messageId: 'emptyOneLine' }],
        },
        {
            code: 'class L\n{\n    static\n    {}\n}',
            output: 'class L\n{\n    static\n    {\n}\n}',
            errors: [{ messageId: 'emptyOneLine' }],
        },
        {
            code: 'declare global\n{}',
            output: 'declare global\n{\n}',
            errors: [{ messageId: 'emptyOneLine' }],
        },
        {
            code: 'try\n{\n    g();\n}\ncatch\n{}',
            output: 'try\n{\n    g();\n}\ncatch\n{\n}',
            errors: [{ messageId: 'emptyOneLine' }],
        },
        {
            code: 'namespace N\n{}',
            output: 'namespace N\n{\n}',
            errors: [{ messageId: 'emptyOneLine' }],
        },
        {
            code: 'switch (x) {}',
            output: 'switch (x) {\n}',
            errors: [{ messageId: 'emptyOneLine' }],
        },
        // A CRLF file gets CRLF line breaks from the fix, never a mixed file.
        {
            code: 'interface A {\r\n    a: number;\r\n}\r\nfunction g()\r\n{}',
            output: 'interface A\r\n{\r\n    a: number;\r\n}\r\nfunction g()\r\n{\r\n}',
            errors: [{ messageId: 'openOwnLine' }, { messageId: 'emptyOneLine' }],
        },
    ],
});
