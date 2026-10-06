---
# Coarse areas other Goals' briefs may not claim (goalctl reads them at every dispatch).
# The program owns the Goal tooling and the shared QA harness; inventories other
# Goals append to (integration lists, coverage declarations) stay unowned.
areas:
  - scripts/goal/**
  - docs/goals/README.md
  - docs/goals/manager.md
  - docs/goals/worker.md
  - scripts/qa/affected.ts
  - scripts/qa/acceptance.ts
  - scripts/qa/cli.ts
  - scripts/qa/core.ts
  - scripts/qa/test.ts
  - scripts/qa/e2e.ts
  - scripts/qa/integration-shards.ts
  - scripts/qa/resource-classes.ts
  - scripts/qa/browser-budget.ts
  - scripts/qa/stack-environment.ts
  - scripts/qa/stack-ownership.ts
  - tests/qa/support/**
---

# Program

Status: designed on 2026-10-07 by the architecture session at the maintainer's
request ("你負責設計我們之後的運行架構"); [state.md](state.md) records where the
work stands.

The program's manager is the **supermanager**: it runs no product work and
reviews no other Goal's diffs. It makes three delivery Goals faster and safer by
owning what none of them can own alone.

| Goal | Outcome |
| --- | --- |
| [kernel](../kernel/GOAL.md) | Core contracts of the target architecture |
| [trust-ops](../trust-ops/GOAL.md) | Authority, platform gates, safety, erasure, deployment preparation |
| [launch](../launch/GOAL.md) | The first public scope through the API and the browser |

## Design record

The target architecture (v0.2, Traditional Chinese) is the shared design record:
`/home/edge/projects/rezics/rezics-next/.temp/arch-review-2/target-architecture.md`.
Its evidence is in `.temp/arch-review*/` and `.temp/goal-design/` (D1 QA
and operations, D2 work decomposition) under the same root. Workers in
worktrees read it by that absolute path. As each decision settles in code or an
owner document, the program folds it out of the record (the record's last
paragraph lists the owners) and the record is retired at the end.

Its criteria bind every Goal:

- **Asymptotic scale.** A slow engine is acceptable; a design whose
  per-operation cost grows with total data or population is not. Every read,
  write, validation, authorization, inference and erasure touches a bounded
  neighbourhood, and cross-partition effects propagate asynchronously. v1 stays
  single-node Jena; it adopts no form a partitioned future must tear out.
- **Architecture, not API count.** One meaning has one representation, queries
  and constraints are standard data, and a new view or vertical adds a query, a
  shape and a fixture, not a handler.
- **Gradual opening.** Unpolished capabilities stay closed behind platform
  permissions and open one group at a time ([trust-ops](../trust-ops/GOAL.md)).
- The cut lines in the record's §12 hold in every brief.

## Duties

1. **Contracts board.** Cross-Goal dependencies are named contracts, not task
   IDs (archived tasks leave the live ledger): C0 current definitions and
   custody boundary, C1 common admission and exposure, C2 bounded SHACL and
   Blocks, C3 local basis, stream and cursor, C4 Statement, acceptance and
   classification, C5 template reads and page facade, C6 component history and
   receipt custody. [state.md](state.md) records each contract's owner, the
   commit it landed in and the acceptance that proved it. A Goal builds on a
   contract only after it lands there.
2. **Main-wide regression.** The program holds it permanently (it no longer
   rotates between Goal managers). See [QA tiers](#qa-tiers).
3. **Shared resources.** Host memory, the QA slots and the heavy lock, the
   live-worker cap, and each account's spending before its reset. It raises the
   cap from 5 to 8 once P1 and P2 land and host memory stays above 10 GiB
   available, and to 12 after 12–20 waves show no new OOM and 20–40% fewer heavy
   test-project-hours per merged task (D1).
4. **Manager survival.** Four managers share one Claude account. The program
   watches the 5-hour projection, asks managers to shorten turns or lower
   effort before Claude dispatch would stop, and restarts a manager that
   died (its tmux session `goal-<goal>`, the start message in
   [manager.md](../manager.md#starting-a-manager)).
5. **Launch operation matrix.** trust-ops proposes which operations and groups
   are public at launch (with launch's input); the program approves it. The
   foundation that must stay public to avoid a lockout (sign-in, sessions,
   recovery, public reads of public resources, health) is listed explicitly.
6. **Retire production-readiness.** Every item of its GOAL.md and state.md now
   has an owner below or in another Goal. After checking that each one landed
   in a brief, the program removes its row from the root GOAL.md and runs
   `task goal -- goal close production-readiness`. The salvage branches
   (`goal/g-403`, `g-418`, `g-422`, `g-432`, `g-433`, `g-435`) are material
   for their new owners, never whole cherry-picks.

## QA tiers

Maintainer, 2026-10-07: QA, not writing code, takes most of the resources; the
supermanager runs the full tests so others run fewer of them. D1 measured why.
Integration plus fault/recovery were about 97% of recorded tier time (22.9 h and
3.4 h in three days). `--affected` often selects most of the backend (837 files
from 5 changed paths). Heavy runs collided three times in one day (OOM).

| Tier | Runs | When |
| --- | --- | --- |
| Worker | Its own unit tests and types; an integration test it adds or fixes; the smallest API counterexample for authority or transaction work | Before handoff |
| Goal wave | Affected unit, owner static checks, the wave's necessary cross-module integration files, changed stories and journeys, and a populated-state rehearsal for migrations | Each short wave, on a pinned wave commit |
| Program | Batched heavy affected sets across Goals; the full unit, model, integration, fault/recovery, web and Accounts Storybook and browser journeys; confirmation, attribution, routing | About every 4 hours or 12 waves, earlier after a major contract or security change; only one pending snapshot while one runs |

Goal managers no longer run whole tiers. A failure found by the program goes to
the owning manager with its evidence, and does not hold the program's other
work. Authority, erasure and transaction counterexamples stay wave gates; the
periodic run adds breadth, not the first line of defence.

## First tasks

| Task | Outcome | Engine |
| --- | --- | --- |
| P1 | Safe stop and shared-branch merge: stopping one task never kills a sharer or its stack; a shared branch's merge marks every delivered task merged; import de-duplication keeps type and value imports apart. **Blocks shared worktrees.** | `codex` high |
| P2 | QA leases and selection: no stack starts without a slot, failed restores clean up, front-end changes never silently drop out of `--affected`, `resume` re-checks the usage gate as `dispatch` does | `codex-1` high |
| P3 | `task goal -- regress`: pin `main` to one SHA in its own worktree, run the complete manifest (gates and subdirectories included) in batches that take and release the heavy lock, record a merge event `{before, after, goal, taskIds}` at every merge, bisect a failure over merge events (at most 8 probes, `unavailable`/`inherited`/`inconclusive` instead of a guess), write results to `.temp/goal-orchestration/inbox/<goal>.jsonl`, and classify infrastructure, order-dependent and flaky failures apart from regressions. About 650–1,000 lines with tests; no daemon, database or second runner (D1 §7) | `codex-1` xhigh |
| P4 | Storybook only once per run (a selected journey no longer drags the whole web Storybook), Accounts Storybook and journeys in the harness, memory caps for the QA stack's PostgreSQL, RustFS and child stacks | `cursor` high, Claude review |
| P5 | Fix the five order-dependent tests inherited from write-concurrency and the fault injectors that count background work, using the fresh-state list | `grok` high |

## Completion

The program ends after the three delivery Goals close: it folds the remaining
design record into owner documents, removes its row from the root GOAL.md and
closes itself. Capacity qualification at 300 million and 500 million business
entities is not a closing condition of this round; it starts as its own Goal once
the maintainer sets the hardware and the population census (record §13).
