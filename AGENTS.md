# AI agent instructions

Put task-created temporary files in `.temp/`.

Use only the tools, versions and root commands in `docs/development/toolchain.md`;
change that page first to add or replace a tool.

Write tests with the implementation; execute verification in coherent batches
under `docs/plan/execution-workflow.md#batch-cadence`. The coordinator runs the
merged batch through `yarn qa`, which includes `yarn check`. Reserve targeted
`yarn test` and standalone `yarn check` for concrete blocking diagnostics or
repair checks, not each edit or each agent. Documentation-only batches use
`yarn docs:check`; the full suite runs only through `yarn qa`.
