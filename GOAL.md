# REZICS implementation goal

## Outcome

Implement and qualify REZICS's complete retained first-delivery product scope in
[capabilities M01–M10](docs/product/capabilities.md#capability-coverage), using the
selected architecture and owning contracts. Deliver working backend, web client,
storage integrations and reproducible installation/recovery procedures. Follow
[S0–S3 and stages A–G](docs/plan/README.md); S0–S2 are early milestones, not the final
completion condition.

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
not block the newly requested implementation. The plan owns current scope, phase,
remaining work, blockers and evidence; update its existing status tables rather
than creating another progress log here. The Codex Goal owns its task lifecycle.
Keep this file's completion contract stable unless the user changes the target.

## Start and continue

1. Read [the plan](docs/plan/README.md), [architecture](docs/architecture/overview.md)
   and [coverage map](docs/architecture/coverage.md). Inspect the current working
   tree and implemented artifacts; distinguish existing code, design and executed
   evidence. Preserve unrelated work.
2. Choose the next unmet dependency or highest-impact blocker. Use the
   [task reading routes](docs/plan/README.md#task-reading-routes) and owning links
   to load the relevant contracts, realization and acceptance. Read additional
   owners when the change crosses their boundaries.
3. Record the slice's concrete outcome, owners, outstanding decisions and exit
   evidence in the plan. Resolve consequential uncertainty with primary sources
   through the [official source index](docs/development/external-sources.md).
   Keep exact API examples compatible with selected dependency versions.
4. Implement the complete slice and its required consumers. Reconcile affected
   contracts when evidence requires a design correction; retain the user's
   selected architecture and capability scope. Create packages with their first
   working consumers rather than counting empty scaffolds as delivery.
5. Follow [execution phases](docs/plan/execution-workflow.md): implementation,
   relevant test authoring, verification and repair. Exercise real boundaries
   where required, including denied, stale, concurrent, partial and recovery
   outcomes. Carry acceptance IDs into test/evidence references.
6. Record actual results and the next executable step in the plan. Continue to
   the next unmet slice while the Goal is active and resources permit. After
   interruption or context compaction, reread the plan and inspect the checkout
   before resuming. A passing slice does not complete the whole Goal.

## Execution scope

Activating this goal requests repository implementation, necessary dependency
installation and generation, disposable local databases/services, deterministic
and integration tests, scoped Storybook review, and **full-application browser
verification of the implemented local user journeys**. That last item explicitly
activates the rendered QA boundary in [frontend acceptance](docs/plan/frontend.md).
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
  Schemas, mock-only tests and documentation checks qualify only what they cover.
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
