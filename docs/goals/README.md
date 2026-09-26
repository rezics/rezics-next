# Backend Goal program

Status: prepared on 2026-09-26 for a Claude Code manager; not started. The root
[GOAL](../../GOAL.md) is the completion contract, the [execution plan](../plan/README.md)
is the slice status ledger, and this page is the operating manual for the
manager. The retained scope is all 276 backend acceptance cases across M01–M10;
frontend implementation and browser acceptance are excluded.

## Management handover

The GPT-6 Sol Codex program ran from 03:57:20 UTC on 2026-09-26 and is paused at
`0dd3817` with no live workers. It integrated G-001–G-037, left 25 affected-verified
complete-case candidates (IAM02 partial) and produced no recorded backend run.
Its log is in the [program history](history/codex-program-2026-09-26.md). Do not
resume its threads or tasks.

Measured lessons that shape this program:

- About 2.5 candidate cases per hour; a 10-hour finish needs roughly ten times that.
- A two-worker cap and one shared QA stack serialized work. Harness selected runs
  already create their own `rezics-qa-<run>` project on dynamic ports; one
  selected integration run took about 34 s including about 9 s of stack startup.
- Twelve of 37 slices deepened package-ecosystem cases that all stayed partial.
  Choose work by cases it can close, not by depth in one owner.
- `services/main/src/app.ts` (5,485 lines, 52 commits on 2026-09-26) and QA
  coverage declarations were merge hotspots.
- Concurrency without exclusive claims produced duplicate or overlapping work,
  and a manager without a verified stop operation could not safely replace a
  worker. This program makes both mechanical.

The Claude program starts when the maintainer runs the [Goal prompt](#goal-prompt).

## Roles and models

| Role | Model and effort | Responsibility |
| --- | --- | --- |
| Manager | Interactive Claude Code, Opus 5.5, `xhigh`, bypass permission mode, session name `goal-manager` | Closure map, decomposition, briefs, claims, dispatch, merges, wave QA, commits, plan status and forecast. It writes no feature code except small integration fixes. |
| Worker (default) | `claude -p`, Opus 5.5, `medium` | Template-following API bundles, tests, coverage declarations, fixtures, routine repairs. |
| Worker (complex) | Opus 5.5, `high` | Non-trivial semantics after a template exists, cross-module consumers, failed-wave repairs, merge conflicts. |
| Worker (hardest) | Opus 5.5, `xhigh` | Owner schemas, the first template of each operation family, authority/IAM, transactions, erasure, recovery and owner reconciliation. |
| Scout | Opus 5.5, `medium`, no path claims | Read-only closure-map and audit tasks. |

Never use `max` effort. A worker whose model or effort cannot be pinned is not
dispatched. Escalate by resuming the same worker at a higher effort when it
reports a design ambiguity or blocker, or after a second failed attempt.

## Goal prompt

The maintainer starts the manager in tmux from the repository root in bypass
permission mode and sends the prompt below:

```sh
claude -n goal-manager --model claude-opus-5-5 --effort xhigh --dangerously-skip-permissions
```

```text
You are the REZICS backend Goal manager. Read GOAL.md and docs/goals/README.md,
follow them as the operating manual, and run the Goal to completion.
Local host credentials are in .temp/vault/ (manager only; never pass to workers
or external tools). The maintainer may update docs at any time; adapt as the
program describes.
```

`/goal` may wrap the same text with the completion condition "`yarn qa --backend
--record` passed on a clean tree and the final report is written, or the
25-hour outer bound is reached and the final report is written".

## Phases

The phase order is the maintainer's direction: database structure, then API
templates, then bulk implementation, then unified testing. Gates apply per
domain; shared cross-owner structures (Access/authority, receipts, outbox,
recovery manifests) come first because every domain depends on them. The
[plan](../plan/README.md#backend-only-ten-hour-proposal) holds the time budget.

1. **Phase 0, closure map (about 30 min).** Two to four scouts split the 276
   retained IDs by domain and record for each open case: current status
   (candidate, partial, missing), owner and existing route/schema, the missing
   assertions, dependencies and a proposed bundle. The manager turns this into
   the plan's backlog rows. One worker extracts per-domain route registration from
   `app.ts` and per-domain QA coverage declaration files without behavior change.
2. **Phase A, owner schemas.** One worker per domain delivers tables,
   constraints, indexes, RDF shapes, migrations in its reserved number range,
   typed table declarations and a migration test on empty and existing
   databases. The manager reviews the domain schemas together before merging, to
   catch duplicate concepts such as a second receipt or outbox model. One worker
   builds the bulk fixture generator: direct bulk loading into owner tables and
   TDB2, never public commands, then one consistent backup.
3. **Phase B, API templates.** For each operation family (protected command
   write, exact revision/history read, query/page, authority decision,
   recovery-covered owner, external source adapter) that a domain lacks, one
   worker builds a real write/read API with receipts, idempotency, denial,
   stale and recovery tests, a cost contract and a short extension note naming
   the files to copy. Existing verified templates, such as G-035's Work scalar
   value, are reused.
4. **Phase C, bulk implementation.** Case-closing bundles of two to six cases
   that follow a verified template, mostly at medium effort. A bundle closes
   every assertion of its cases or names the missing one as partial.
5. **Phase D, unified testing.** Freeze new subsystems, rehearse fresh
   construction and fixture restore, run one full `yarn qa --backend` on the
   integrated source, repair in one queue, then one clean
   `yarn qa --backend --record` and the final report.

## Worker processes

Workers are separate `claude -p` processes, not in-session subagents. All state
changes go through `bun scripts/goal/goalctl.ts`, run by the manager from the
main checkout:

| Command | Effect |
| --- | --- |
| `init --manager goal-manager` | Records the program start used for elapsed time and the manager session name. |
| `dispatch docs/goals/tasks/G-NNN.md [--dry-run]` | Validates the brief, refuses overlapping claims, unmet dependencies, the live-worker limit and a restricted 5-hour usage level, then creates `.temp/worktrees/g-nnn` on branch `goal/g-nnn` from `main`, installs dependencies (about 6 s), copies the brief and starts a detached worker. |
| `wait G-NNN` | Run in the background. Blocks until the worker process exits, then prints branch, cleanliness, scope check and the handoff. |
| `resume G-NNN -m <text> [--effort e] [--fresh]` | Continues the same worker session with full context after it exited, optionally at another effort; `--fresh` starts a new session on the same worktree. |
| `stop G-NNN` | Terminates the worker's process group and confirms exit. Claims and worktree remain. |
| `scope G-NNN` | Lists commits ahead, dirty files and files outside the claim. |
| `merge G-NNN [--allow-scope]` | Requires an exited worker, a clean worktree and in-scope files; rebases the branch onto `main` and fast-forwards `main`. A conflict marks the task `conflict` for the worker to resolve. |
| `close G-NNN verified|cancelled` | Removes the worktree and releases the claims. |
| `status` / `usage` | Live workers, states, elapsed time and the 5-hour usage level. |
| `test <yarn test args>` / `slot -- <cmd>` | Runs a check inside one of the shared QA slots. |

The lifecycle is dispatch, background `wait`, handoff, then merge or resume,
and finally close after the wave verifies it. Workers follow the
[worker protocol](worker.md). Worker processes are detached and survive a
manager restart. After a restart, `status` shows them and `wait` is re-armed
for each live one.

The manager does not send instructions into a running worker; a live
cross-session inbox would let any local session steer an autonomous process. To
change a worker's task, `stop` it and `resume` it with the new instruction.
Workers may message `goal-manager` only for urgent cross-task hazards.

## Briefs and duplicate prevention

Briefs live at `docs/goals/tasks/G-NNN.md`, numbered from G-038, and stay under
about 40 lines. The frontmatter is machine-checked:

```text
---
id: G-041
title: Poll ballot owner schema
effort: xhigh                         # medium | high | xhigh
cases: [GOV11, GOV12]
paths: [services/main/src/modules/poll/**, tests/qa/integration/poll-*.test.ts]
migrations: [main/access:040-044]    # <directory>:<first>-<last>
shared: [route:poll, coverage:GOV]
depends: [G-039]
---
```

The body states the deliverable and exact assertions, owners to read, the
template to follow, checks to run and known risks. The manager commits new
briefs with its next plan update.

Duplicate work is prevented mechanically:

- One dispatcher. Only the manager runs `dispatch`, `resume`, `merge` and
  `close`; workers never pick up work themselves.
- Exclusive claims. A case ID, an overlapping path glob, an overlapping migration
  range or a shared slot held by an unclosed task blocks dispatch. Path overlap
  is conservative: a shared literal prefix counts.
- One task, one session. Retries resume the same session in the same worktree;
  a replacement starts only after `stop` confirms the previous process exited.
- Scope at merge. Files outside the claim reject the merge unless the manager
  deliberately passes `--allow-scope` after review.
- Proposals, not side work. Workers report needed out-of-scope work as proposed
  tasks; the manager decides whether to create a brief.
- Phase order removes semantic duplicates: one reviewed owner schema per domain
  and one template per operation family before bulk work.
- State survives compaction. After a context reset, rebuild from `goalctl
  status`, the plan table and `git log`, not from memory.

## Integration and QA

- Workers check only their claimed tests through `goalctl test`, which limits
  concurrent QA stacks (default 8 slots, `GOAL_QA_SLOTS`).
- Every 30–45 minutes, or sooner when handoffs accumulate, the manager runs an
  integration wave: merge ready tasks one at a time, regenerate derived artifacts
  once (`yarn gen`), run `yarn check:backend` once and one combined selected run
  of the merged tests, then commit plan status. Failures return to the
  responsible session through `resume`; unrelated passing tasks are closed as
  verified.
- Dispatch work on the longest remaining dependency chain first, then
  independent bundles that keep capacity busy. Dependent briefs dispatch only
  after their dependency is merged and its wave passed.
- Only the manager runs full `yarn qa --backend` or `--record`, each once per
  distinct source as the [batch cadence](../plan/execution-workflow.md#batch-cadence)
  allows.

## Capacity and usage

- Up to 25 live workers (`GOAL_MAX_WORKERS`). Ramp from about 6 in phase 0 to
  8–12 in phases A and B and up to 25 in phase C while the merge queue stays
  short. Merge throughput, not the slot count, sets the useful width.
- The interactive status line writes `~/.claude/usage/latest.json`; `goalctl
  usage` classifies it. At 80% or more of the 5-hour window used (under 20%
  remaining), dispatch no new workers and let running ones finish; at 95%, only
  merge and test. Resume dispatching after the window resets. A snapshot older
  than 30 minutes is unknown; refresh it by taking a manager turn.
- Back off on API rate-limit errors instead of retrying in a loop.
- Docker Desktop has 24 GB for QA stacks. If its socket disappears, run
  `systemctl --user start docker-desktop` and re-run the affected check.

## Research

Claude does the research. Use primary sources from the
[official source index](../development/external-sources.md) for consequential
decisions, and record them where the owning contract requires. Grok 4.7
supplements that with current X posts, for example about a library defect,
through the headless command in the [worker protocol](worker.md#research). Its
results are leads to verify. Grok and Cursor Agent do not write code in this
program; the maintainer limited Grok to X research. Cursor Agent may use only
Grok 4.7 models if the maintainer uses it directly.

## Maintainer documentation changes

The maintainer may change any documentation at any time with any tool,
including during the run. Treat those changes as authoritative input:

- At every checkpoint and before writing a brief or plan update, check
  `git log` and `git status` for changes the manager did not make, and re-read
  the changed sections of GOAL.md, AGENTS.md, this program, the plan, the
  workflow and affected contracts.
- Adapt running work to them: finish, stop and resume, or re-brief affected
  tasks. Never revert or silently overwrite a maintainer edit.
- The manager may refine a maintainer edit toward best practice or consistency.
  Do so in a separate commit that states the reason.
- When a manager commit must touch a file that has uncommitted maintainer edits,
  include them intact and say so in the commit message.
- Workers branch from committed `main`, so uncommitted edits do not reach them.
  When maintainer edits have stayed unchanged for a checkpoint interval and
  `yarn docs:check` passes, commit them as a separate "Adopt maintainer
  documentation update" commit before dispatching briefs that depend on them.

## Checkpoints and recovery

- Handle every `wait` completion immediately. Once per elapsed hour and at each
  phase gate, add a checkpoint of at most five lines to the
  [plan](../plan/README.md#active-management-program).
- Forecast at elapsed 2:00 from merged passing cases per hour against the closure
  map, then at each checkpoint. The target is 10 hours with a 25-hour outer bound.
  Report a forecast miss immediately; never shrink scope or count partial cases.
- After compaction, restart or interruption: run `goalctl status`, read the
  plan's active rows and recent checkpoints, `git log -20`, re-arm `wait` for
  live workers, then continue the recorded next action.
- Local credentials for host administration, such as a `sudo` password, are in
  `.temp/vault/`. Only the manager reads them, only for local host
  administration, and never copies them into briefs, commits, logs or prompts to
  other tools.

## Task size and ownership

Use a complete API/owner behavior as the normal unit: schema and constraints,
state transitions, authorization, idempotency/concurrency behavior, API wiring,
and applicable recovery/complexity tests. A typical bundle should reach an
integrated result in 45–90 minutes. Small dependent repairs stay with their
owner session. Create briefs only when their inputs are clear; keep uncertain
downstream work as coarse backlog. Counting briefs is not a progress metric.

`app.ts`, OAuth scopes, generated registries, migration ordering, recovery
manifests and QA coverage declarations are shared boundaries. Claim them as
shared slots, and let the manager sequence registrations and migration numbers.
Where a shared file causes repeated collisions, make the smallest useful module
extraction. Worktree isolation alone does not resolve semantic conflicts.

## What the manager may change

The manager may split or combine tasks, revise plans, reassign ownership, change
sequencing, estimates and concurrency, and create repair tasks when evidence
warrants it. It may improve this program and the workflow when measured
evidence shows a better practice, recording the reason in the commit.

The manager preserves the root outcome and every retained acceptance requirement.
Splitting a task does not delete unmet assertions. Lowering required quality or
removing product scope changes the maintainer's requested outcome, not the
schedule, and needs the maintainer's decision.

## Background evidence

| Evidence | Observation | What transfers to this project |
| --- | --- | --- |
| [OpenAI Symphony](https://openai.com/index/open-source-codex-orchestration-symphony/), 2026-04-27; [service specification](https://github.com/openai/symphony/blob/main/SPEC.md) | A tracker-backed scheduler runs isolated issue workspaces with bounded concurrency, reconciliation and retries. Repository-owned workflow instructions describe execution policy. The reference implementation is an engineering preview. | The proposed manager/task/workspace architecture has a concrete precedent. Its current tracker integration does not establish that this repository's Markdown files are a supported queue without an adapter. |
| [Cursor's initial scaling experiment](https://cursor.com/blog/scaling-agents), 2026-01-14 | Flat coordination and a shared locked task file bottlenecked workers. Hierarchical planning helped; a dedicated integrator also became a bottleneck. Large generated projects still needed review. | Explicit decomposition and ownership matter. Central authority must not turn every change into manual work for one agent. |
| [Cursor's revised swarm](https://cursor.com/blog/agent-swarm-model-economics), 2026-07-20 | With matching models and elapsed budgets, a revised harness reached 73–85% of a held-out SQL suite after four hours versus 11–77% for the old harness. It combined decision ownership, shared design records, conflict resolution and other interventions. | Harness design can materially improve results. The comparison does not isolate concurrency, does not supply a controlled solo baseline, and does not qualify all database properties. Adopt the coordination principles, not its custom version-control project. |
| [Anthropic multiagent experiments](https://www.anthropic.com/research/multiagent-systems), 2026-08-13 | In twelve-hour game-building experiments, teams from ten to eighty agents encountered coordination and integration problems. CEO-style prompts alone did not resolve the poor product outcomes. | Adding a manager persona and more workers is insufficient for dependent engineering. Evaluate complete behavior after integration. |
| [MSEval](https://arxiv.org/html/2607.27877v1), 2026-07-30 | Ten coding projects and ten collaboration modes yielded no universally best topology. The runtime combined periodic synchronization with active messages. Web-app concentration and limited repeated trials constrain generalization. | Select ownership and handoffs for the actual dependency graph; measure elapsed time, quality and total cost together. This is design evidence, not a REZICS completion forecast. |
| [Scaling agent systems, revised paper](https://arxiv.org/html/2512.08296v3), 2026-04-08 | The revised study contains 260 configurations and six benchmarks. Its small SWE-bench subset did not establish a coding advantage for multiple agents; uncertainty is substantial. | Benchmark accuracy changes must not be presented as project speedups. Do not extrapolate small teams or older models to a hundred-worker delivery guarantee. |

There is also evidence against permanent process accumulation:
[Anthropic's long-running harness report](https://www.anthropic.com/engineering/harness-design-long-running-apps)
removed scaffolding as model capability improved. A more elaborate harness could
deliver a richer result while taking longer and costing more. Add a coordination
mechanism to resolve an observed failure, then reassess its cost.

This program is an engineering proposal derived from these sources, the paused
program's measurements and the repository's current boundaries. It has not been
benchmarked here.
