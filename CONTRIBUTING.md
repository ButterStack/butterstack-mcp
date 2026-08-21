# Contributing to butterstack-mcp

Thanks for taking a look. This is a small, dependency-free MCP server, so the
bar for contributing is low.

## Development

The server has zero runtime dependencies, only Node builtins. There is
nothing to install for local development beyond Node itself.

```bash
git clone https://github.com/ButterStack/butterstack-mcp.git
cd butterstack-mcp
npm test
```

`engines.node` in `package.json` is set to `>=18` as a supported-versions
policy, not because the code needs anything newer. If you touch `index.js`,
avoid syntax or builtins that would raise that floor without a good reason.

## Running the server by hand

The server speaks JSON-RPC over stdio. You can drive it directly to sanity
check a change:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | node index.js
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node index.js
```

Set `BUTTERSTACK_API_TOKEN` and, if you're pointed at something other than
production, `BUTTERSTACK_HOST` before exercising a tool that actually calls
the ButterStack API.

## Tests

Tests use Node's built-in `node:test` runner, no test framework dependency.
Run them with `npm test`. If you're adding a regression test for a security
fix, make sure the assertion matches the fix's own wording rather than a
loose keyword, and confirm the test actually fails against the pre-fix code
before you consider it done. A test that passes either way isn't a test.

## Pull requests

- Keep changes focused. If you're fixing a bug, a note on how to reproduce it
  helps.
- Run `npm test` before opening the PR.
- No em dashes in code, comments, or commit messages, please. Plain
  punctuation only.

## Reporting a security issue

Please do not open a public issue for a security vulnerability. Email
hello@butterstack.com instead.
