# Delivery efficiency

Use allowance per accepted landing as the efficiency metric; also measure accepted outcomes per unit of time.
Codex runs on the Standard tier (`serviceTier: "default"`). Fast requires the maintainer's explicit permission.
Keep allowance balances, account selection and operating ceilings in private configuration. Worker occupancy, tokens consumed and nominal model price
are diagnostic inputs, not success measures.

Record attempts and accepted landings by Goal, task class and model profile. Include failed, replaced and abandoned
attempts. Count resumed cumulative usage by deltas, once.

Maintain an hourly ledger of allowance per landing, wait requests, replacement input, compactions and acceptance
failures. Monitor hourly. At least every three hours inspect the preceding twelve hours for the largest avoidable costs:
unready briefs, repeated exploration, context rereads, polling, retries, merge conflicts, checks and idle capacity.
Fix the largest cause the same day and compare before and after.

Investigate a task needing a third attempt before any further retry. Classify each lost attempt as infrastructure,
contract, rebase or model failure, fix the class and record the evidence before continuing. An increased retry limit
is not a repair. Controller retry limits still apply.

“Selected model is at capacity” and an ambiguous “usage limit” with fresh allowance remaining are provider faults.
Use the controller's bounded retry policy; never switch service tier or mark an allowance exhausted on that evidence
alone. Keep private readings outside Git.

Report progress and material slowdowns every two hours, with measured rates and causes. Separate measured timestamps
and durations from estimates.

Keep instructions short and contexts focused. Prefer reusable evidence and owner links to repeated repository
exploration. Use event-driven waits and fresh continuations rather than polling through model turns.

Apply the [brief preflight](delivery.md#brief-preflight) before spending an attempt. Keep independent and overlapping
work moving under the delivery dependency rules; remove artificial dependencies. Avoid restarting unchanged work or repeating checks without new evidence.

Set concurrency from measured worker memory, check capacity, queueing and allowance per landing. Worker and heavy-check
admission are separate controls. More workers are useful only when accepted throughput justifies their cost.

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
