# AI agent instructions

Put task-created temporary files in `.temp/`.

Use only the tools, versions and root commands in `docs/development/toolchain.md`;
change that page first to add or replace a tool.

Tests are code (`docs/testing/test-harness.md`): run `yarn check` and targeted
`yarn test` while implementing, and the full suite only through `yarn qa`.
