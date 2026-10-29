# Delivery efficiency

## Output and flow

Use native journey receipts as the primary output measure: a user-visible journey in the
[first public scope](../scope.md) working end to end on the integrated revision. Track a burn-down of the scope's
remaining journeys. Lines, landings and attempts are diagnostics only; allowance and worker occupancy explain cost,
not delivered output.

Measure flow with `goal report --flow`. The manager host must alarm hourly against these absolute targets:

- Flow efficiency (working time divided by dispatch-to-integration time) is at least 40%.
- No queue's oldest entry is older than 60 minutes.
- Landing p90 is under 30 minutes.
- Attempts per integrated task are at most 1.5.

Handle a breached target the same day. Separate measured timestamps and durations from estimates; do not invent
missing timing.

## Daily improvement

Audit every pipeline step from dispatch to promotion daily. Justify each step by the failures it actually catches
against its cost. Move, merge or remove steps with low catches and high cost. For example, dev landings re-ran every
check even though dev is the unstable branch; those checks moved to post-merge verification.

Make one structural change per day aimed at the current bottleneck stage: identify it, exploit its capacity,
subordinate other stages to it, then elevate it where needed. Measure before and after on comparable work and
record the effect, including when it is not yet observable.

## Planning

- Plan a few complete journeys at a time, each with one integrating owner and a native demo receipt.
- Write consumer-first briefs: name the caller, the export or route it needs and one failing native outcome.
  Implement a missing port together with its binding in the same task; do not create a contract-only tier.
- Make a task one useful behaviour: one implementation plus its caller. Group symmetric readers or adapters.
- Commission research only for a named open choice with a consumer task; use one report by default.
- Send a handoff as one message containing the revision, remaining question, proposed decision and affected consumer.
  Co-owner review answers accept or one counterexample.

These rules were adopted on 2026-10-29. The
[delivery report on main](https://github.com/rezics/rezics-next/blob/main/tools/goal/reports/delivery-efficiency-20261029.md)
provides the evidence.

## Operating discipline

Codex runs on the Standard tier (`serviceTier: "default"`). Fast requires the maintainer's explicit permission.
Keep allowance balances, account selection and operating ceilings in private configuration. Tokens consumed and
nominal model price are diagnostic inputs, not success measures.

Record attempts and accepted landings by Goal, task class and model profile. Include failed, replaced and abandoned
attempts. Count resumed cumulative usage by deltas, once.

Maintain an hourly diagnostic ledger of allowance, wait requests, replacement input, compactions and acceptance
failures alongside the flow report. Use it to locate avoidable costs in briefs, exploration, rereads, polling,
retries, conflicts, checks and idle capacity; apply the daily bottleneck change above.

Investigate a task needing a third attempt before any further retry. Classify each lost attempt as infrastructure,
contract, rebase or model failure, fix the class and record the evidence before continuing. An increased retry limit
is not a repair. Controller retry limits still apply.

“Selected model is at capacity” and an ambiguous “usage limit” with fresh allowance remaining are provider faults.
Use the controller's bounded retry policy; never switch service tier or mark an allowance exhausted on that evidence
alone. Keep private readings outside Git.

Keep instructions short and contexts focused. Prefer reusable evidence and owner links to repeated repository
exploration. Use event-driven waits and fresh continuations rather than polling through model turns.

Apply the [brief preflight](delivery.md#brief-preflight) before spending an attempt. Keep independent and overlapping
work moving under the delivery dependency rules; remove artificial dependencies. Avoid restarting unchanged work or repeating checks without new evidence.

Set concurrency from measured worker memory, check capacity, queueing and journey throughput. Worker and heavy-check
admission are separate controls. More workers are useful only when journey throughput justifies their cost.

Keep routing policy in tracked configuration and private allowance settings locally. Compare profiles on representative
accepted work before changing defaults.

A model pin changes routing, not authorization to exceed an operating budget. Pause and pacing policy must be enforced
by the controller.

Do not spend allowance merely to exhaust it before a reset. Preserve explicit pauses and spending limits.

## Incident method

When work slows or an attempt is lost, enumerate every evidenced cause from task states, attempt records, run logs
and `failure.json`. Name the class of each cause: for example, shared-file holds, wrong brief premises, oversized
checks, unnoticed long attempts, unvalidated integration configuration, or branch and propagation gaps. Distinguish
observations from hypotheses; do not invent missing timing or claim a fix without evidence.

Repair each class in tools or workflow: a control-plane change, a gate or a brief rule must prevent recurrence beyond
the individual task. Tell every manager the adopted rule and its owner link. Verify its effect in the next hourly
report using comparable evidence; if the effect is not yet observable, record that limit and the next observation.
Use the [worked incident procedure](../../.agents/skills/rezics-workflow/references/efficiency.md#incident-analysis)
when preparing the cause-to-fix record.
