# REZICS implementation goal

## Outcome

Implement and qualify REZICS's complete retained first-delivery product scope in
[capabilities M01–M10](docs/product/capabilities.md#capability-coverage), using the
selected architecture and owning contracts. Deliver working backend, web client,
storage integrations and reproducible installation/recovery procedures. Follow
[S0–S3 and stages A–G](docs/plan/README.md); S0–S2 are early milestones, not the final
completion condition.

Complete and qualify the retained M01–M10 backend and API scope first, including
its storage, authority, cross-service and operational boundaries. Build the full
web product journey after that API scope passes its owning gates. The Phase 0 web
skeleton and browser checks needed to keep its existing contracts healthy remain
part of the foundation.

The product's [separate activation boundaries](docs/product/capabilities.md#activation-boundaries)
and [first-release exclusions](docs/plan/README.md#first-stage-product-and-indexing-scope)
remain in force. Preserve native capability requirements when an external provider
cannot supply a feature. Do not silently shrink scope to a prototype, public-only
search or a document-only result.

## Activation and durable state

This file is the repository's goal specification. It does not start a Codex Goal,
select a model or authorize runtime work merely by being present or read. The
maintainer activates execution by asking a task to establish a Goal from it,
selecting **GPT-6 Sol (`gpt-6-sol`)** in that task. Ordinary maintenance requests
remain limited to their requested scope.

On activation, reconcile [Active execution](docs/plan/README.md#active-execution)
with this implementation scope. A completed documentation-preparation entry must
not block the newly requested implementation. The plan owns current scope,
batches, blockers and next actions; the [qualification page](docs/plan/qualification.md)
owns recorded evidence. Update the existing tables rather than creating another
progress log here. The Codex Goal owns its task lifecycle.
Keep this file's completion contract stable unless the user changes the target.

## Start and continue

1. At activation, read [the plan](docs/plan/README.md) (its active execution, implemented
   baseline and execution program), the [toolchain lock](docs/development/toolchain.md)
   and the [executable harness](docs/testing/test-harness.md). Inspect the working
   tree; distinguish existing code, design and executed evidence. Preserve
   unrelated work. Later batches load changed sections and current owners, not
   the entire documentation tree or prior research history again.
2. Complete Phase 0 (P0.1–P0.8) before product batches. It connects the toolchain,
   local services, the Fuseki command module, the model compiler, the harness,
   the web skeleton and the PostgreSQL Content/search binding, so that later
   batches can be qualified by one `yarn qa` run. Until P0.4 implements that
   command, group the available checks at batch boundaries; do not substitute
   repeated manual integration runs for the missing harness.
3. For each batch, write its row in the execution program. Choose the next unmet
   dependency and load only its owners through the
   [task reading routes](docs/plan/README.md#task-reading-routes). Resolve
   consequential uncertainty with primary sources through the
   [official source index](docs/development/external-sources.md).
4. Implement the complete batch with its tests and required consumers, following
   the [batch cadence](docs/plan/execution-workflow.md#batch-cadence). Exercise real
   boundaries where the owning cases require them, including denied, stale,
   concurrent, partial and recovery outcomes. Name tests with acceptance IDs.
   Reconcile affected contracts when evidence requires a design correction; keep
   the selected architecture and capability scope. Create packages with their
   first working consumers rather than empty scaffolds.
5. The coordinator runs `yarn qa` once for the merged batch, records the result
   in its row and commits. The final batch uses `yarn qa --record` instead, as
   described in the workflow. Continue to the next batch while the Goal is active
   and resources permit. After interruption or context compaction, read the
   active scope/current batch and inspect the checkout, then load only the
   owners needed for its recorded next action.
   A passing batch does not complete the whole Goal.

## Delivery cadence and throughput

Optimize for verified working capability delivered per unit of time and context:

- **Toolchain first.** Prioritize P0.1 and the runnable P0.4 harness core; make one
  real existing path work through root commands and shared setup before widening
  implementation. Grow its coverage with the other Phase 0 modules. Use only the
  toolchain lock; apply documented gate fallbacks without open-ended research.
- **Context and interaction cost.** Follow the workflow's
  [context discipline](docs/plan/execution-workflow.md#context-and-agent-coordination).
  Load only the active slice, batch independent reads/operations and bound tool
  output. Give agents self-contained module briefs rather than the full research
  conversation. Work through complete modules, not one model round trip per edit.
- **Cadence.** Accumulate a coherent batch of code and tests (about 60 minutes of
  implementation), then qualify it once within the 30-minute QA budget. Do not
  test after each edit or wait merely to fill the time box. Early targeted runs
  require a concrete blocker whose result determines the next implementation
  step. Apply the workflow's repair and rerun rules.
- **Parallelism.** The coordinating task splits each batch into disjoint modules and
  runs parallel subagents, each in its own worktree. It merges the worktrees into
  `main` and owns centralized verification. Subagents deliver code, tests and
  affected acceptance IDs; they do not each run a full suite or duplicate stack
  setup. The harness may parallelize isolated tests inside the coordinated run.
- **Generation.** Prefer generators, such as the model compiler and schema, client
  and test-data generation, over hand-writing derivable code. Build them against
  the current profiles and working consumers; avoid a speculative universal system.
- **Throughput.** Measure accepted capability and acceptance IDs delivered per
  elapsed hour, including model turns, context processing, tools, QA and repair.
  Use available task statistics and harness timings to identify the dominant
  cost. Changed lines and test time alone cannot establish efficiency. Never
  inflate code or reduce required coverage to meet a throughput target.
- **Evidence.** Evidence is the recorded harness run. Keep plan rows short; do not
  write narrative evidence or commit hand-written evidence files.
- **Order.** After Phase 0, complete and qualify the retained M01–M10 backend and
  API batches before the full web product journey. The S2 authenticated journey
  first passes through actual APIs and owners. Recovery drills grow inside the
  harness's fault/recovery tier alongside their backend features. Keep the Phase 0
  web skeleton and necessary browser regression checks healthy while API work runs.
- **Autonomy.** Continue routine implementation, qualification, repair and commits
  without asking the user to pick every next step. If one dependency is blocked,
  advance independent work and record what will unblock the rest.

## Execution scope

Work in the existing checkout on `main`. The maintainer authorizes autonomous
local commits for implementation and its supporting docs and tests. Parallel
agents use local branches in worktrees under `.temp/worktrees/`, which the
coordinator merges into `main` and then removes. Do not push to a remote. Inspect
and stage only the relevant changes, include required consumers, and commit
coherent merged batches.

Activating this goal requests:

- repository implementation, dependency installation and generation;
- Docker images and Compose projects for local services and disposable QA stacks;
- deterministic, property, integration, fault/recovery and load tests;
- scoped Storybook review;
- **full-application browser verification of the implemented local user
  journeys.** This explicitly activates the rendered QA boundary in
  [frontend acceptance](docs/plan/frontend.md).

Follow applicable repository skills when their actual task scope is triggered.

Qualify installation, practical load and isolated restoration using available
authorized resources. Production publication, paid provisioning and separately
operated product campaigns need their own deployment/operating scope. Missing
credentials or host access must be recorded as specific blockers while independent
work continues; do not replace required evidence with invented passes.

## Completion evidence

Mark the Goal complete only when all of the following are true:

- Every retained M01–M10 capability is mapped to implemented owners/consumers and
  its applicable acceptance evidence in the plan. No required behavior remains
  a stub, unexplained omission or unresolved blocker.
- [G1–G6](docs/plan/README.md#acceptance-gates), the
  [backend map](docs/plan/backend-acceptance.md) and
  [frontend acceptance](docs/plan/frontend.md) pass for the selected delivery scope.
  One full `yarn qa --record` run on a clean source tree passes and shows no
  failing or uncovered retained acceptance ID on the
  [qualification page](docs/plan/qualification.md). Schemas, mock-only tests and
  documentation checks qualify only what they cover. This single run both
  verifies and records; do not precede it with an identical full run.
- The documented installation and the first authenticated Work/Realm/edit/search
  journey run from a reproducible checkout; backup/isolated restore and measured
  practical workload meet the selected operational objectives. Billion-row planning
  arithmetic is not a substitute for these checks or an initial-release gate.
- Maintained docs describe the delivered behavior, commands and remaining explicit
  rollout boundaries. Required checks pass, and the final report links to evidence
  and states the precise qualified scope.

A budget limit, interruption or missing external prerequisite does not satisfy
these conditions. Preserve the next action and blocker evidence in the plan;
follow the Codex Goal lifecycle for pause, continuation or blocked status.

## Establishing the Codex Goal

Select GPT-6 Sol in the intended task and ask it to establish a Goal that implements
this file's outcome and full execution scope, including local full-application
browser verification, using the plan as the durable progress owner. In a CLI that
supports it, `/goal` followed by that objective is the equivalent entry point.
See [official Goals guidance](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex).
The file is an explicit input to the task, not a special automatically executed
filename. The maintainer sets any execution budget in Codex.
