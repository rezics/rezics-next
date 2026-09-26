# AI agent instructions

Put task-created temporary files in `.temp/`.

Use only the tools, versions and root commands in `docs/development/toolchain.md`;
change that page first to add or replace a tool.

Default to the main task. Delegate only justified independent work under
`docs/plan/execution-workflow.md#delegation-and-worker-lifecycle`; default to
fresh briefs and at most two active workers. Workers finish after handoff, without
idle polling. Harness/data parallelism does not require model-agent parallelism.
For the active backend management Goal, dispatch workers only on `gpt-6-sol`
with `xhigh` reasoning. Do not dispatch to GPT-6 Astra or use it as a fallback.

API operations define backend behavior; UI consumes the APIs. The current Goal
excludes frontend implementation and browser acceptance.

Design owner schemas first, bulk-build test data once, save a consistent backup
and restore isolated copies. Routine data preparation has a hard 10-minute limit,
including restore/startup/readiness. Do not repeat full-corpus validation or
public-command seeding; see `docs/storage/workload-budgets.md#data-preparation-and-import`.

Write tests with implementation. Normal batches run affected backend tests and
relevant static checks through documented root commands, not the full suite.
Final acceptance performs the clean rebuild and full backend verification through
`yarn qa --backend --record`. For ordinary affected checks, use documented explicit
`yarn test` paths and selected backend QA tiers; automatic affected selection is
still pending.
See `docs/plan/execution-workflow.md#batch-cadence`.
Documentation-only batches use `yarn docs:check`.
