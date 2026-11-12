# Delivery efficiency

## Output and flow

Two measures run together, and neither replaces the other:

- **Accepted journeys measure what is delivered.** A journey is a user-visible path in the
  [first public scope](../scope.md). The list is fixed in owner documents before work starts, so splitting work
  cannot create journeys. A journey is accepted only when it works end to end on the integrated revision, seen in the
  running-product walkthrough, which runs at least every three hours, or by a native receipt. Track the burn-down of
  the remaining journeys and the projected finish date.
- **Landed product lines measure throughput**, against the hourly floor below. They show whether the work system is
  producing at the rate the burn-down needs.

Landings and attempts are diagnostics; allowance and worker occupancy explain cost.

Each coding worker targets at least 1,000 landed product lines per worker-hour. Review workers individually and
separate source delivery, check waits, and unknown attribution. When a worker is below target, repair the brief,
admission, or verification cause and keep independent code moving. Do not add code merely to meet the count.

Target 20,000 landed product lines per hour, aiming for 40,000, alongside accepted journeys and quality. Count
additions under `apps/`, `services/` and `packages/` excluding tests, stories, fixtures, recordings, JSON, snapshots
and generated files, including emitted declarations. Never pad output or subtract deletions.

Size a complete journey, including backend and interface, to finish in about an hour (usually 2,000–3,000 lines).
The controller returns product briefs under 1,200 estimated lines or over 4,000 body characters. Split only at a
real dependency; complete independent parts now and hold only the receiving seam. Continue the remainder after
most of the brief is built. Report reverts, review findings and repeated failures beside throughput.

Measure flow with `goal report --flow`. The manager host must alarm hourly against these absolute targets:

- Flow efficiency (working time divided by dispatch-to-integration time) is at least 40%.
- No queue's oldest entry is older than 60 minutes.
- Landing p90 is under 30 minutes.
- Attempts per integrated task are at most 1.5.

Handle a breached target the same day. Separate measured timestamps and durations from estimates; do not invent
missing timing.

Decision: The hourly report reads each UTC bucket once, normalizes landing targets during aggregation, and reports conflicting task attribution as unknown; lifecycle and other window policies remain unchanged.

The control plane exists to cut the cost of each landed outcome, and agents are its resolvers. A problem an agent
can fix where it appears goes to an agent at that point, and the pipeline continues. Such problems include a merge
conflict, a stale base, a formatting or derived-file failure, and a brief that disagrees with the code. Ending an
attempt is allowed only when no agent can fix the problem there. Every path that ends an attempt without landing is
measured in attempts, worker hours and tokens, and the hourly report names the three largest causes.

## Daily improvement

Audit every pipeline step from dispatch to promotion daily. Justify each step by the failures it actually catches
against its cost. Move, merge or remove steps with low catches and high cost. For example, dev landings re-ran every
check even though dev is the unstable branch; those checks moved to post-merge verification.

Decision: check-result planning batch-reads committed workspace manifests into one cached tree projection for closure, package tree IDs and global inputs; the default reuse policy stays unchanged.

Trust agents. In the delivery workflow, efficiency outranks defensive safety: REZICS is a community product, and a
mistake on dev is caught and returned after integration. A guard that distrusts agent work is defensive programming
against the agents, and it must earn its cost. Such guards refuse, reject, fail an attempt, forbid a check or
re-verify trusted work. A guard is kept only when its measured catches of real defects outweigh the attempts, hours
and tokens it costs, and when no agent could repair the problem in place. Money movement is the exception, and keeps
its guards: payments, payouts and balances. The efficiency review covers guards like any other step. A new guard
states the defect it prevents and is measured from its first firing.

Decision: guard rewrite and landed shares use observed immediate next attempts for firings in the trailing seven days; hours are summed, and token totals add input and output because cached input is already included in input.

Decision: the trailing-seven-day guard ledger builds call-local attempt indexes once and aggregates each record's distinct known guards in one pass; the firing window and immediate-next metrics remain unchanged.

Price a guard before briefing it; a prohibition can turn a repairable mismatch into a lost attempt. Keep
fingerprints that prove required identity or avoid more work than they add and change a real decision. Avoid
scaffolding for states outside supported behavior. Review the guard ledger against the
[defensive programming evidence](../research/gpt-defensive-programming-opus-5-5.md).

Make one structural change per day aimed at the current bottleneck stage: identify it, exploit its capacity,
subordinate other stages to it, then elevate it where needed. Measure before and after on comparable work and
record the effect, including when it is not yet observable.

## Planning

- Plan a few complete journeys at a time, each with one integrating owner and a native demo receipt.
- Name the caller, its required export or route, and one failing native outcome. Implement a missing port with
  its binding when the producer exists; where it does not, finish the independent behavior and name the exact
  unbound seam. A mock binding does not finish a journey.
- Make a task one complete outcome of about 1,500 to 3,000 product lines, landed with one check: a whole capability
  row, a whole system or one migration step across a module. Chain similar work in one worker, not in slivers. State
  the expected line count in the brief. Keep at most six tasks in flight per Goal.
- Repairs of integrated code that is broken on dev (type diagnostics, boot failures, failing tests named in landed
  summaries) go out as urgent briefs under the manager's urgent grant. They are exempt from the size floor, carry an
  honest estimate, and are batched per area, never one per diagnostic.
- Take outcomes in this order: capability rows still red, each built end to end until its composed acceptance passes;
  systems that [scope](../scope.md) lists as built but closed, finished to the polish bar and kept closed; then the
  [architecture migration](../research/architecture-paradigms-opus-5-5.md) steps in the Goal's own modules. Deferred
  systems stay deferred until the scope table changes.
- Commission research only for a named open choice with a consumer task; use one report by default.
- Send a handoff as one message containing the revision, remaining question, proposed decision and affected consumer.
  Co-owner review answers accept or one counterexample.

Decision: enforce the six-task per-Goal limit at worker start admission; waiting checks and landing count, dependency-held, urgent and control-plane tasks are exempt, and ready work starts in order when a slot opens.

## Operating discipline

- The supermanager decides operational and engineering trade-offs itself, by the best efficiency, and does not wait for
  the maintainer. It reports the decision afterwards.
- Every hour the supermanager checks that each manager session is running and its inbox is read, and renews a paused
  one. Control-plane work goes out as briefs the supermanager dispatches; no manager inbox stands in for that.
- Decision: manager and worker prompts link here; managers keep the next independent writable slice ready, and workers
  checkpoint then repair in-scope evidence, parking only blocked checks or dependencies.
- Give each worker a writable outcome and an owned boundary. Name the failing behaviour, current evidence and the
  smallest required check. Let the worker choose the repair order and take the next evidenced fix within that
  boundary; coordinate a new boundary before touching another worker's scope. Checkpoint coherent source and keep
  the next independent repair ready before the current one parks. While its check runs, admit that repair within
  existing limits. Return exact failures to their source owner. At review, track writing, ready repairs, admission
  waits and verification separately; distinguish missing implementation from unintegrated or unverified source.
- At the hourly review, the supermanager acts on the largest evidenced loss and reports the effect or the next
  measurement. If evidence is missing, collect the smallest useful observation. Use existing watchers; clear obsolete
  work and assign independent repairs before adjusting worker width within allowance and host limits.
- An alarm fires only on a real problem, and its receiver fixes the cause at once. An alarm that repeats for the same
  cause without a fix escalates to the supermanager. Throttling or batching an alarm hides the problem; fix the cause or
  the threshold.
- Managers challenge any rule or instruction, the supermanager's included, as soon as evidence shows it produces bad
  results.
  Codex runs on the Standard tier (`serviceTier: "default"`). Fast requires the maintainer's explicit permission.
  Keep allowance balances, account selection and operating ceilings in private configuration.

Token efficiency is a primary measure, beside output: allowance spent per landed product line and per landed
outcome, tracked per Goal, task class and model profile. It improves in three ways:

- **Clear prompts.** The manager names current evidence, one outcome, its write scope, and the permitted checks
  separately from later acceptance. In a shared checkout, claim files or a directory before editing and tell
  peers about overlaps. Replace a repeated bad premise; keep completed source and remove stale briefs.
- **The simplest model that does the work.** A well-specified implementation journey runs on GPT-6 Luna at max
  effort. Stronger models are kept for the work that needs them: review-prone or citation-heavy work, hard
  debugging, and design. Change a routing default only after comparing profiles on representative accepted work.
- **No rework.** Attempts that end without landing are the largest token cost. Remove their causes, as set out under
  "Output and flow".

Fold repairs into the journey they serve. An estimate predicts landed source; it is not a task label. Price each
new refusal, bound or guard as required by [agent conduct](agent-conduct.md#briefs).

For an explicitly authorized code-only window, use isolated worktrees outside controller-owned task custody.
Checkpoint coherent source and record the exact deferred acceptance. Count saved source, integrated code and
accepted journeys separately. Compare the whole delivery cost before changing routine models or worker width.

The brief writer picks the model by the task's difficulty. A simple, well-specified brief pins `model: gpt-6-luna` and
`effort: max` in its front matter. Examples: exact edits the brief names, fixture, data or translation work, and wiring
that follows an existing pattern. Judgment work keeps the routed default: debugging an unknown cause, design,
cross-module contracts, security and money.

Decision: the cross-module evidence and admission work for one reviewed Person across VN and anime retains the routed
model default.

Record attempts and accepted landings by Goal, task class and model profile. Include failed, replaced and abandoned
attempts. Count resumed cumulative usage by deltas, once.

Maintain an hourly diagnostic ledger of allowance, wait requests, replacement input, compactions and acceptance
failures alongside the flow report. Use it to locate avoidable costs in briefs, exploration, rereads, polling,
retries, conflicts, checks and idle capacity; apply the daily bottleneck change above.

Product work integrating into dev retries without a limit or an approval: retry it, with an amended brief when that
helps, and keep it moving. For a task needing a third attempt, classify each lost attempt as infrastructure, contract,
rebase or model failure, fix the class and record the evidence alongside those retries, not before them; a retry is
not a repair. Control-plane, stabilize and verification work keep the controller's retry limits and wait for that
investigation before a further retry.

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

Decision: This cross-module imports seed and franchise journey keeps the routed default because it requires debugging
unknown causes and cross-module contract and security judgment.

A model pin changes routing, not authorization to exceed an operating budget. Pause and pacing policy must be enforced
by the controller.

Plan against each pool's observed reset and remaining allowance. When real work is ready, prefer the eligible pool
whose allowance expires first and queue work early enough to save coherent changes before reset. Stay within explicit
pauses, reserves, pacing and host limits; leave allowance unused when no suitable work is ready.

Decision: The Claude allowance keeps the resident supermanager running and nothing else. It routes no workers, and it
holds no reserve beyond that; workers run on Codex and Cursor.

## Incident method

When work slows or an attempt is lost, enumerate every evidenced cause from task states, attempt records, run logs
and `failure.json`. Name the class of each cause: for example, shared-file holds, wrong brief premises, oversized
checks, unnoticed long attempts, unvalidated integration configuration, or branch and propagation gaps. Distinguish
observations from hypotheses; do not invent missing timing or claim a fix without evidence.

Repair each class where it appears: give the problem to an agent at that point (resolver, same-session fix,
regeneration), so the pipeline continues. Add a check that refuses or ends work only when no agent can repair the
problem in place. Register that check in the guard ledger with the defect it prevents, and price it from its first
firing. Tell every manager the adopted rule and its owner link. Verify its effect in the next hourly
report using comparable evidence; if the effect is not yet observable, record that limit and the next observation.
Use the [worked incident procedure](../../.agents/skills/rezics-workflow/references/efficiency.md#incident-analysis)
when preparing the cause-to-fix record.
