# REZICS implementation goal

## Outcome

Implement and qualify REZICS's complete retained first-delivery backend scope in
[capabilities M01–M10](docs/product/capabilities.md#capability-coverage), using the
selected architecture and owning contracts. Deliver working backend and APIs,
storage integrations and reproducible installation/recovery procedures. Follow
[S0–S3 and stages A–G](docs/plan/README.md); S0–S2 are early milestones, not the final
completion condition.

Retain the selected TypeScript/Bun application stack, including Better Auth.
Improve delivery through the execution strategy, data preparation and bounded
access paths; no Rust migration is selected. Every operation needs a derived
[cost contract](docs/storage/workload-budgets.md#complexity-contracts) and
[complexity checks](docs/testing/complexity.md). Small, varied fixtures test those
contracts; separately scoped host/capacity tests qualify deployment claims.

Complete and qualify the retained M01–M10 backend and API scope, including its
storage, authority, cross-service and operational boundaries. The maintainer
removed frontend implementation, web journeys, Storybook and rendered browser
acceptance from this Goal on 2026-09-26. Existing frontend files remain in the
repository; they do not contribute to this Goal's completion denominator.
Preserve the backend portions of mixed frontend/backend cases and qualify them
through real API clients and owners. APIs own every business operation; UI and BFF
only consume them. Backend behavior and qualification must run without web code.

The requested execution target is 10 elapsed hours for 100% of that backend
scope. Follow the [ten-hour proposal](docs/plan/README.md#backend-only-ten-hour-proposal).
Setup, implementation, research, coordination, QA and repairs all consume that
budget. This is a target, not evidence that the remaining scope fits. Report a
forecast miss as soon as the measured work exposes it; never remove backend
requirements or count partial cases as complete to satisfy the deadline. This
planning revision does not activate a new Goal or start its execution clock.

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

That selects the managing task, not a fixed worker model. The active Goal
forbids Astra dispatch. Its coordinator chooses Sol/xhigh for uncertain
cross-owner, authority, transaction and recovery slices, and may choose
Luna/max for bounded repetitive implementation only after owner schema and a
real write/read API template are verified. Model and effort are explicit on
each dispatch.

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
2. Require the working root commands, shared harness and actual owner dependencies
   needed by the next batch. Phase 0 (P0.1–P0.8) organizes foundation work; an
   unrelated unfinished foundation case must not block every product slice.
   Carry remaining cases in the plan and grow their coverage with consumers.
   None is waived from final qualification. Check affected backend behavior at
   ordinary batch boundaries; reserve the complete suite for final qualification.
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
5. The coordinator runs affected checks for the merged batch, records their scope
   in its row and commits. Final qualification runs the complete backend suite
   and fresh construction. Continue to the next batch while the Goal is active
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
- **Reuse first.** Use established libraries for ordinary persistence, migrations,
  authentication, schema/client generation and background job mechanics. The
  plan proposes Drizzle for PostgreSQL application data, with one bounded
  compatibility gate and exact pins before adoption. Keep domain authorization,
  immutable publication, cross-owner recovery and graph semantics explicit.
  Do not build a generic ORM, migration framework, scheduler or package solver
  when an admitted tool already provides the required semantics.
- **Context and interaction cost.** Follow the workflow's
  [context discipline](docs/plan/execution-workflow.md#context-and-agent-coordination).
  Load only the active slice, batch independent reads/operations and bound tool
  output. Give agents self-contained module briefs rather than the full research
  conversation. Work through complete modules, not one model round trip per edit.
- **Cadence.** Accumulate a coherent batch of code and tests, then run affected
  backend tests and relevant static checks once. Do not test after each edit or
  rerun unrelated tiers. Full reconstruction, comprehensive recovery and the
  complete backend suite belong to final acceptance or a relevant diagnostic.
  Apply the workflow's repair and rerun rules.
- **Delegation.** Default to completing the slice in the main task. Delegate only
  independent, bounded work whose expected time or quality benefit exceeds its
  context, coordination and integration cost. Start with at most two active
  workers under the workflow's [delegation policy](docs/plan/execution-workflow.md#delegation-and-worker-lifecycle);
  do not fill available slots automatically. Reassess that limit only from
  merged passing operations and observed rework cost. Use fresh,
  self-contained briefs.
  Workers return their deliverable and finish; they do not remain alive to poll
  jobs or await hypothetical follow-up work. The main task owns integration and
  centralized QA; harness parallelism does not require additional model agents.
  Keep one active integration batch and at most one independent next slice;
  close the repair queue before stacking dependent batches. Long experiments
  use a pinned isolated checkout rather than freezing `main`.
- **Preparation and cost.** Design owner schemas first, bulk-build test data once
  and save a consistent complete backup. Restore isolated copies for ordinary
  development; preparation, startup and minimal readiness together must finish
  within 10 minutes. Reuse fixtures across code-only changes. Do not repeat
  full-corpus scans, receipt replay or background command seeding. Exercise the
  changed operation through the API with small fresh inputs. Complete
  reconstruction and deeper validation belong to final acceptance. Exceeding
  the ceiling requires fixing preparation, never increasing its timeout.
  Track CPU/engine work, calls, bytes, memory and write amplification, not only
  latency. The current data baseline is 500 million business entities/documents;
  this is neither a triple count nor a mandatory daily test size.
- **Generation.** Prefer generators, such as the model compiler and schema, client
  and test-data generation, over hand-writing derivable code. Build them against
  the current profiles and working consumers; avoid a speculative universal system.
- **Throughput.** Measure accepted capability and acceptance IDs delivered per
  elapsed hour and per total task token usage, including the main task and every
  worker. Separate cached input, uncached input and output; include coordination,
  QA and repair. Keep GPT-6 Sol; use medium effort for routine bounded work and
  reserve xhigh for difficult reasoning where task controls permit, following
  the workflow. Explicit user settings take precedence. Do not alter global
  configuration. Changed lines, agent activity and test time alone cannot
  establish efficiency; preserve required coverage.
- **Evidence.** Evidence is the recorded harness run. Keep plan rows short; do not
  write narrative evidence or commit hand-written evidence files.
- **Order.** With the required foundations available, complete and qualify the
  retained M01–M10 backend and API batches. The S2 authenticated journey passes
  through actual APIs and owners. Recovery drills grow inside the harness's
  fault/recovery tier alongside their backend features. Frontend work is outside
  this Goal; implement the explicit backend QA scope before final qualification.
- **Autonomy.** Continue routine implementation, qualification, repair and commits
  without asking the user to pick every next step. If one dependency is blocked,
  advance independent work and record what will unblock the rest.

## Execution scope

Work in the existing checkout on `main`. The maintainer authorizes autonomous
local commits for implementation and its supporting docs and tests. Delegated
code writers with fully disjoint paths may share `main` under coordinator-owned
commits; overlapping writes use local branches in `.temp/worktrees/` and are
merged serially by the coordinator. Shared routes, migrations and QA have one
integration owner. Do not push to a remote. Inspect
and stage only the relevant changes, include required consumers, and commit
coherent merged batches.

Activating this goal requests:

- repository implementation, dependency installation and generation;
- Docker images and Compose projects for local services and disposable QA stacks;
- deterministic, property, integration, fault/recovery and load tests;
- backend HTTP/SDK/MCP consumer verification where required by the retained
  contracts, without frontend rendering or browser acceptance.

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
- Backend [G1–G4 and G6](docs/plan/README.md#acceptance-gates) and the
  [backend map](docs/plan/backend-acceptance.md) pass for the selected delivery scope.
  G5 and frontend acceptance are outside this Goal. One full backend-scoped
  recorded QA run on a clean source tree passes and shows no
  failing, partial or uncovered retained backend acceptance case on the
  [qualification page](docs/plan/qualification.md). Schemas, mock-only tests and
  documentation checks qualify only what they cover. This single run both
  verifies and records; do not precede it with an identical full run. The backend
  scope selector and recorder are available; complete backend case declarations
  and executed evidence remain prerequisites. See the
  [harness](docs/testing/test-harness.md#backend-only-goal-scope).
- The documented installation and the first authenticated Work/Realm/edit/search
  journey run from a reproducible checkout; backup/isolated restore and measured
  practical workload meet the selected operational objectives. All required paths
  have reviewed complexity bounds and applicable counterexample checks. Planning
  arithmetic and small tests do not certify capacity for the current 500 million
  entities; qualify actual rollout capacity separately before claiming it.
- Maintained docs describe the delivered behavior, commands and remaining explicit
  rollout boundaries. Required checks pass, and the final report links to evidence
  and states the precise qualified scope.

A budget limit, interruption or missing external prerequisite does not satisfy
these conditions. Preserve the next action and blocker evidence in the plan;
follow the Codex Goal lifecycle for pause, continuation or blocked status.

## Establishing the Codex Goal

Select GPT-6 Sol in the intended task and ask it to establish a Goal that implements
this file's backend-only outcome and execution scope, using the plan as the
durable progress owner and the ten-hour proposal as the execution budget. In a CLI that
supports it, `/goal` followed by that objective is the equivalent entry point.
See [official Goals guidance](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex).
The file is an explicit input to the task, not a special automatically executed
filename. The maintainer sets any execution budget in Codex.
