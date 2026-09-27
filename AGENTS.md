# AI agent instructions

Put task-created temporary files in `.temp/`.

Use only the tools, versions and root commands in `docs/development/toolchain.md`;
change that page first to add or replace a tool. Run commands through Task
(`task --list`; arguments after `--`); Yarn only installs dependencies. The main
checkout's `task dev` serves the shared local backend under Aspire on fixed ports;
in a worktree `task dev` runs only web and Storybook on random ports against it
(`-- --backend` for an isolated backend). Find addresses with `task urls` or
Aspire's MCP server, and configuration with `task env` and each workspace's
`.env.example`.

No Goal is active; backend phase 1 finished on 2026-09-27. When the maintainer
starts a Goal, it runs under `docs/goals/README.md`: one Claude Opus 5.5
`xhigh` manager dispatches worker processes through `bun scripts/goal/goalctl.ts`.
Since the maintainer's 2026-09-26 direction, new workers run on Codex CLI with
GPT-6 Sol (`gpt-6-sol`) at `high` or `xhigh`, pinned per brief; simpler tasks may
run on GPT-6 Luna (Codex) or Grok 4.7, paced because their quotas run until
exhausted. Each model's allowed efforts are listed with its engine in
`docs/development/toolchain.md`. Workers follow
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
verification through `task qa -- --backend --record`. Affected checks use
`task test -- --affected [<base>]` (`--list` previews the plan); explicit `task test`
paths and selected backend QA tiers remain for narrower diagnosis. See
`docs/plan/execution-workflow.md#batch-cadence`.
Documentation-only batches use `task docs:check`.
