# AI agent instructions

Put task-created temporary files in `.temp/`.

Use only the tools, versions and root commands in `docs/development/toolchain.md`;
change that page first to add or replace a tool.

The active backend Goal runs under `docs/goals/README.md`: one Claude Opus 5.5
`xhigh` manager dispatches Opus 5.5 worker processes through
`bun scripts/goal/goalctl.ts`, with effort pinned per brief (`medium` by default,
`high` or `xhigh` by complexity, never `max`). Workers follow
`docs/goals/worker.md`: they change only their claimed cases and paths, work in
their own worktree, start no other agents and finish after one handoff. The
manager alone merges, runs wave QA and commits on `main`. Outside the Goal, work
in the main task. Claude does research; Grok 4.7 only supplements X evidence as
a read-only lookup.

The maintainer may update any documentation at any time with any tool. Treat
those updates as authoritative: detect them, adapt, never revert them silently;
refine them toward best practice only in a separate, explained commit.

API operations define backend behavior; UI consumes the APIs. The current Goal
excludes frontend implementation and browser acceptance.

Design owner schemas first, then verify a real write/read API template per
operation family, then implement repetitive operations from those templates.
Bulk-build test data once, save a consistent backup and restore isolated copies.
Routine data preparation has a hard 10-minute limit, including
restore/startup/readiness. Do not repeat full-corpus validation or public-command
seeding; see `docs/storage/workload-budgets.md#data-preparation-and-import`.

Write tests with implementation. Workers run only their claimed tests through
`goalctl test` and relevant static checks; the manager runs affected checks per
integration wave. Final acceptance performs the clean rebuild and full backend
verification through `yarn qa --backend --record`. Affected checks use
`yarn test --affected [<base>]` (`--list` previews the plan); explicit `yarn test`
paths and selected backend QA tiers remain for narrower diagnosis. See
`docs/plan/execution-workflow.md#batch-cadence`.
Documentation-only batches use `yarn docs:check`.
