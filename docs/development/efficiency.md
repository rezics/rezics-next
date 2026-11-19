# Delivery efficiency

## Output and flow

Use the existing hourly report for development, repairs and release separately. Track accepted user journeys, landed
product additions, throughput and elapsed time. A journey is an adopted user path that passes real integrated
acceptance. Keep the published walkthrough cadence of at least every three hours where the campaign requires one.
Report remaining journeys and the finish forecast.

Measure product additions across `apps/`, `services/` and `packages/` per elapsed hour and per attributable active
coding worker-hour. Keep the denominators visible and separate. Count useful added production lines without
subtracting deletions. Exclude tests, stories, fixtures, recordings, documentation, JSON, snapshots, generated
files, verification tooling and moves or formatting without functional change. Report those work classes
separately. Keep quality, deletions that simplify the product and completed small repairs visible as outcomes.

The coding diagnostic target is 1,000 landed product lines per attributable coding worker-hour on comparable
implementation work. Treat a miss as evidence to investigate, never as a reason to pad a change. During the Web
reconstruction campaign, the existing target remains 50,000 useful Web product additions per completed UTC hour.
Count `apps/web/src/**`, `apps/auth/src/**` and `packages/ui/src/**` from the pinned `dev` revision. Report gaps in
Web attribution as unknown. Apply the [review publication cadence](storybook.md#review-publication-cadence)
and replan immediately after six hours without useful visible reconstruction delivery.

Compare time and allowance on matched task class, scope, stage and model profile. Split worker occupancy into active
writing, diagnosis, preparation, check wait, integration wait and idle capacity. Keep native and managed attempts,
retries, and parent and child usage deduplicated. Use observable source checkpoints and execution events. Label
unattributable activity unknown and keep it out of active coding time.

| Observation | Manager action |
| --- | --- |
| Little product source during acceptance while ready work exists | Restore independent coding slots from the same allowance. Reduce competing broad checks or staff their actual critical path. |
| Long delay to first useful source | Supply the first writable boundary, usable input and a focused brief. Remove unrelated reading or split only at an actual dependency. |
| Slow repair before the first actionable failure | Reuse prepared inputs and capture the earliest failing phase. Route repeated setup faults to the fixture or runner owner. |
| Source ready but late to land | Remove the queue or ownership conflict that held the coherent increment; apply direct integration. |
| High active coding time for a small exact change | Inspect a bounded sample of reads, tool steps and repeated work. Tighten the brief or compare routed profiles on matched output and quality. |

Use `goal report --flow` at the existing cadence. The existing alert targets are flow efficiency at least 40%,
oldest queue entry at most 60 minutes, landing p90 below 30 minutes and attempts per integration at most 1.5.
Handle breaches the same day. Read each hourly bucket once and report conflicting attribution as unknown.

## Release and repair metrics

For each [release batch](release.md#candidate-and-time-budget) track time from first in-scope source integration to
verified publication and time from qualification entry to its terminal outcome. Count held, withdrawn or reduced
batches against the original scope; report the number released in 12 hours over all started batches. Record
time to first actionable failure, time from reproducing it to a qualified fix, check-host time, repeated physical
starts and cumulative agent occupancy per release. Report rollbacks and hotfixes beside speed.

Measure development during release windows too. Compare useful source and accepted development outcomes on matched
work, and report capacity diverted to verification or repair. A shorter release at the cost of stalled independent
development is a scheduling failure. Use these measures in the existing progress report.

## Daily improvement

Use the existing evidence to fix the largest recurring cost from dispatch to publication. Reuse the owner's
validated result. Repeat work when a conflict, changed input or missing required proof changes a decision.
Measure comparable work after moving or removing a costly step. Source or document changes alone do not establish
faster delivery.

Price each guard by the defects it prevents and its measured cost in attempts, time and allowance. Let a capable
owner repair a mismatch where it appears. Preserve required money, authorization, data integrity and release
proof. The guard ledger uses distinct firings in the trailing seven days and the observed immediate next attempt.
Token totals add input and output; cached input is part of input. See
[agent conduct](agent-conduct.md#briefs) and the [guard research](../research/gpt-defensive-programming-opus-5-5.md).

## Planning

- Plan complete independently writable increments. Size them by the outcome and expected effort. A bounded
  repair can be a few lines. Batch related diagnostics by their common owning cause.
- Name the caller, required interface and smallest real acceptance boundary. Where a producer is missing, finish
  independent behavior and identify the unbound seam.
- Admit up to 32 managed tasks per Goal at worker start, including ready work, waiting checks and landings.
  Dependency-held, urgent and control-plane tasks retain their exceptions.
- Route broken `dev` type, boot and test outcomes under the manager's urgent grant. Use
  [first-public scope](../scope.md) to allocate resident product work. Prepare the next independent increment before
  a worker parks.
- Commission research only for a named decision and consumer. Give a co-owner the revision, open decision,
  proposed answer and affected consumer.

## Operating discipline

Set implementation width from ready work, observed writing, allowance and host capacity. Admit checks separately.
Protect active development capacity before assigning additional broad acceptance. At each checkpoint restore capacity
when a release has displaced ready unrelated source work. Apply [direct source
integration](delivery.md#direct-source-integration) and [check placement](verification.md#check-placement).
Use the existing checkpoint and event route for actionable failures. Repair any repeated alarm at its owner.

Track allowance per landed outcome and per useful product line by Goal, task class and profile. Use bounded briefs,
decisive evidence and compact continuations. Resume from source already written. Keep an active writer on the next
ready increment while asynchronous checks run. After equivalent failures change the approach at the owner boundary.
Keep the controller's retry limits and use its configured routes and pacing. Compare profiles on matched accepted
work before changing a default.

Use the routed profile for ambiguous debugging, design, shared contracts, security and money. A brief may name
`gpt-6-luna` for exact edits or familiar wiring. Higher effort is a bounded choice for the task. Simple placement,
result delivery and deduplication belong in the existing tools when their inputs and decisions are deterministic.

Provider capacity reports and ambiguous usage-limit errors with fresh allowance use bounded controller retries.
Codex uses the configured Standard tier (`serviceTier: "default"`), and Fast requires the maintainer's permission.
Prefer the eligible pool whose allowance resets first when real work is ready. Observe reserves, pauses and host
limits. Keep account settings private. Explicitly authorized Grok research stays in the unit's worktree and its
usage is counted separately.

## Incident method

When delivery slows or misses its forecast, start with the largest evidenced loss. State the observation and source,
the decision or repeated action that sustained it, the causal explanation and its confidence, what to stop or change,
the repair owner, and the next comparable outcome. Token totals and exhausted resources describe costs, not causes.
Do not infer loaded prompt size from repository size or attribute delay to a model setting without supporting evidence.

Repair the class at its owner and remove the superseded action or rule. Do not add another gate, watcher, audit or
recurring report by default. Keep incident evidence in operating records or a short report, outside default prompts;
put only reusable rules in owner documents and link them from templates and briefs.

Use the existing progress checkpoint to compare delivery time, accepted outcomes, repeated failures and manager cost.
State unknown attribution and untested hypotheses. A document edit or passing tooling test is not evidence of faster
delivery; when no comparable outcome has run, report the improvement as unverified. Follow the
[incident procedure](../../.agents/skills/rezics-workflow/references/efficiency.md#incident-analysis).
