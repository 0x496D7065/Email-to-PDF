// Local ESLint rule (task 9.6, wired in eslint.config.js as 'local/body-brace-style').
// It adds the layout checks that @stylistic/brace-style leaves out, for
// bodies (code blocks, interface and enum bodies), not for data literals:
//   1. Interface and enum bodies get Allman braces like code blocks: `{` on
//      its own line, the members on the lines between, `}` on its own line.
//   2. An empty body is never written `{}` on one line: `{` and `}` go on
//      separate lines, for code blocks (functions, if, catch, class, ...),
//      for a `switch` without cases, and for interface and enum bodies.
// Type literals (`type R = { a: number }`, parameter types) and object
// literals are data, not bodies: this rule does not look at them.
// The fix only turns the spaces before a brace or member into a line break
// (CRLF if the file already uses CRLF, else LF); @stylistic/indent then sets
// the indent.

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
    meta: {
        type: 'layout',
        docs: { description: 'Allman braces for interface and enum bodies, and no empty {} on one line' },
        fixable: 'whitespace',
        schema: [],
        messages: {
            openOwnLine: 'Put the opening brace of this body on its own line.',
            afterOpen: 'Start the body on the line after the opening brace.',
            closeOwnLine: 'Put the closing brace of this body on its own line.',
            emptyOneLine: 'Put the braces of an empty body on separate lines.',
        },
    },
    create(context)
    {
        const sourceCode = context.sourceCode;
        const sameLine = (a, b) => a.loc.end.line === b.loc.start.line;
        /** The line break the file already uses, so a fix never mixes CRLF and LF. */
        const eol = sourceCode.text.includes('\r\n') ? '\r\n' : '\n';
        /** Fix: the spaces between `token` and the token or comment before it become one line break. */
        const breakBefore = (token) => (fixer) =>
            fixer.replaceTextRange([sourceCode.getTokenBefore(token, { includeComments: true }).range[1], token.range[0]], eol);

        /** `{` and `}` of an empty body on one line (a comment inside still counts as empty). */
        function checkEmpty(open, close)
        {
            if (sourceCode.getTokenAfter(open) === close && sameLine(open, close))
            {
                context.report({ loc: open.loc, messageId: 'emptyOneLine', fix: breakBefore(close) });
            }
        }

        /** Full Allman check for an interface or enum body. */
        function checkAllman(node)
        {
            const open = sourceCode.getFirstToken(node);
            const close = sourceCode.getLastToken(node);
            const before = sourceCode.getTokenBefore(open);
            const first = sourceCode.getTokenAfter(open, { includeComments: true });
            const last = sourceCode.getTokenBefore(close, { includeComments: true });
            if (before && sameLine(before, open))
            {
                context.report({ loc: open.loc, messageId: 'openOwnLine', fix: breakBefore(open) });
            }
            if (first === close)
            {
                checkEmpty(open, close);
                return;
            }
            if (sameLine(open, first))
            {
                context.report({ loc: open.loc, messageId: 'afterOpen', fix: breakBefore(first) });
            }
            if (sameLine(last, close))
            {
                context.report({ loc: close.loc, messageId: 'closeOwnLine', fix: breakBefore(close) });
            }
        }

        /** Code blocks: @stylistic/brace-style checks the rest, only the empty case is left for this rule. */
        const checkBlock = (node) => checkEmpty(sourceCode.getFirstToken(node, node.type === 'StaticBlock' ? 1 : 0), sourceCode.getLastToken(node));

        /** A `switch` without cases is an empty body too; its `{` is the first brace after the discriminant. */
        function checkSwitch(node)
        {
            if (node.cases.length === 0)
            {
                checkEmpty(sourceCode.getTokenAfter(node.discriminant, { filter: (t) => t.value === '{' }), sourceCode.getLastToken(node));
            }
        }

        return {
            TSInterfaceBody: checkAllman,
            TSEnumBody: checkAllman,
            BlockStatement: checkBlock,
            StaticBlock: checkBlock,
            ClassBody: checkBlock,
            TSModuleBlock: checkBlock,
            SwitchStatement: checkSwitch,
        };
    },
};

export default rule;
