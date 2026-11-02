# Daily delivery-step audit: 2026-10-31 UTC

Window: **2026-10-31T00:00:00.000Z ≤ event time < 2026-11-01T00:00:00.000Z**.
A read-only SQLite backup completed at 2026-11-01T00:21:50.486004Z supplies the durable evidence.
No live controller state, references, services or configuration were changed.

Landing is the reader's observed bottleneck: **418 complete enqueue-to-finish intervals total 200.161 h,
with p90 68.403 min**, exceeding the 30-minute target. These overlapping intervals include waiting and retries;
they are neither processor time nor a sum of independent task latencies. Recommend making compatible
control-plane releases use a multi-member cohort by default, sharing one final-head proof and publication.
Savings and the cause of individual waits remain unproved.

## Included flow report

```sh
bun tools/goal/src/cli.ts report --flow --since 2026-10-31T00:00:00.000Z --json
```

The complete JSON response, the bounded daily aggregates and the event census are machine evidence kept in the Goal
state directory, not in Git.
It was extracted through the production report handler against the private backup, bypassing the CLI's orphan
recovery and manager-command recording. This is research evidence extraction, not the deferred acceptance run.
The handler returned 0; source is pinned below. Its lifecycle `asOf` is 2026-11-01T00:22:18.063Z.

`--since` has no upper bound: `commandOutput` includes early November 1 events and capture-time lifecycle state.
Only the attachment's `previousUtcDay*` fields support daily numbers here. They filter both UTC boundaries;
flow uses midnight as its clock and omits current terminal task states rather than projecting them backwards.
Historic pending queues remain unknown because pre-window requests and midnight task states are unavailable
in this bounded calculation. Empty check/verification/promotion event streams cannot establish empty queues.

| Stage interval recorded wholly inside the day | Pairs |  Sum (ms) | p90 (ms) |
| --------------------------------------------- | ----: | --------: | -------: |
| Dispatch → first start request                |   329 | 205447942 |  1082423 |
| Start request → task running                  |   597 |     39061 |       82 |
| Check request → release                       |     0 |   unknown |  unknown |
| Worker start → finish                         |   608 | 331228041 |  1254742 |
| Landing enqueue → finish                      |   418 | 720578300 |  4104185 |
| Dev update                                    |     0 |   unknown |  unknown |
| Verification                                  |     0 |   unknown |  unknown |
| Integration                                   |     0 |   unknown |  unknown |
| Promotion                                     |     0 |   unknown |  unknown |

There were 337 dispatches, 612 launches across 598 distinct task/attempt pairs, 618 worker finishes,
932 landing-enqueue events and 466 worker landing-request events. Replays/resumes are not independent work.
There were 321 integration events for 311 distinct tasks and 311 dev updates. These count source integration,
not native journeys or promotion. The daily reader reports 37.13% flow efficiency across 282 eligible rows
(target ≥40%) and 1.373 launches per integrated task (target ≤1.5); missing check waits and resumed launches
prevent interpreting these as productive efficiency or distinct attempts. Cross-midnight intervals are excluded.

## Step-by-step value and cost

**Allowance cost is unknown for every step.** No durable stage-attributed allowance ledger was found;
concurrent pool observations and token totals cannot establish it. Execution cost is unknown unless stated.
Failure observations below are recorded interceptions or exits, not a census of unique defects prevented.
No step is removed merely because catches were unrecorded.

| Step                                                                    | Failure prevented                                                                | Recorded catches during the day                                                                                                                                                         | Time cost; recommendation                                                                                                                                    |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Dispatch contract, ownership/risk and dependency admission              | Unauthorized, inconsistent or unready work starts                                | unknown; no complete refusal ledger                                                                                                                                                     | Execution unknown; dispatch residence above includes holds. **Keep**.                                                                                        |
| Capacity/allowance admission and source preparation                     | Resource exhaustion or launching against unavailable/stale source                | 36 launch failures: 21 advanced integration source, 7 Git errors, 3 dirty read-only proof trees, 3 unavailable producer ABI, 1 missing captured input, 1 proof capacity/custody refusal | Admission/preparation duration unknown; 597 task-running pairs cover only part of launch. **Keep** guards.                                                   |
| Worker implementation and local validation                              | Incomplete behavior or compiler errors delivered as source success               | Local validation catches unknown; 116 classified exits: 57 environment, 56 specification conflict, 3 scope growth                                                                       | 92.008 h paired worker residence; productive/idle/check split unknown. **Keep**.                                                                             |
| Heavy-check admission, custody and terminal collection                  | Oversubscription, lost results or leaked check ownership                         | Catch total unknown; 2015 proof-capacity-queued events are waits, not failures                                                                                                          | Wait/execution unknown; no paired check flow events. **Keep**.                                                                                               |
| Worker result, attempt fence and durable enqueue                        | Stale attempts or missing source publish a landing                               | unknown; 932 enqueues versus 466 request events expose duplicate accounting, not twice the output                                                                                       | Separate duration unknown. **Keep** fences; **merge** replay accounting by request identity.                                                                 |
| Landing setup, formatting and derived outputs                           | Invalid source or generated output reaches integration                           | unknown; no setup-stage rejection recorded, without a complete setup-catch ledger                                                                                                       | Separate duration unknown. **Keep**.                                                                                                                         |
| Rebase and frozen-input checks                                          | Conflicting changes or protected assertions are lost                             | 68 rebase-stage refusals across 68 task/attempt pairs; 65 name conflicted files. Frozen-file catch total unknown                                                                        | Rebase-labelled outcomes total 1004534 ms of host residence, including earlier work. **Keep**.                                                               |
| Scope/risk and candidate/ref validation                                 | Undeclared risk or obsolete candidate publishes                                  | 1 scope-labelled refusal: release refs moved through five validation attempts; actual scope catches unknown                                                                             | Labelled host residence 1605716 ms; scope execution unknown. **Keep**.                                                                                       |
| Candidate typing and required release gates                             | Compiler, regression or protocol failures publish                                | 52 gate-stage refusals, all control-plane; 11 explicitly record `failsOnMain: false`. Other attribution unknown; do not call all 52 new regressions                                     | Labelled host residence 36066284 ms (10.018 h); individual checks/lease occupancy unknown. **Keep** gates; **merge** compatible release proofs into cohorts. |
| Git publication, semantic-loss and no-effect guards                     | Lost changes or ineffective patches advance refs                                 | 4 merge-stage refusals: 2 semantic-loss and 2 no-effect assertions                                                                                                                      | All 315 merge-labelled outcomes total 20505879 ms residence, including 311 successes. **Keep**.                                                              |
| Dev update and integration settlement                                   | Source success is reported before durable ref/outcome publication                | Preventive catches unknown; 311 successful updates are not catches                                                                                                                      | Per-step execution unknown. **Keep** atomic publication and outcome fencing.                                                                                 |
| Independent head/baseline verification                                  | New regressions escape attribution; old failures are blamed on new work          | 3110 persisted check results, 1339 failed results; unique new defects unknown. Retained daily findings are 2000 `unknown`, not clean comparisons                                        | Duration unknown: cached result rows lack execution windows. **Keep** baseline distinction and bounded concurrency.                                          |
| Promotion capture, full gate, stabilization and atomic main publication | Untested or raced candidate reaches main; incompatible histories are overwritten | Daily catch and promotion counts unknown; no promotion flow events. Singleton phase at capture is `stabilize-blocked`, without a day-attributable transition                            | Gate, wait, stabilization and publication costs unknown. **Keep** safety gates; **merge** compatible control-plane source releases as below.                 |

The retained verifier findings include 1420 absent-head-command sources, 140 absent-baseline-command sources,
324 unclassifiable head failures and 116 unclassifiable baseline results. Retention may omit earlier findings;
these are observed rows, not all checks or distinct defects. Neither these nor failed check outputs establish
baseline status for this report-only change. Historical proof reconciliations are not new proofs executed that day.
`hostMs` measures residence through an outcome stage, including prior work; it is not that stage's isolated cost.

## One structural change and its measure

**Make the existing control-plane cohort receiver the normal manager handoff when multiple compatible,
source-complete main-lane requests are ready.** Retain ordinary per-task fallback when no cohort is eligible.
The durable day shows only two cohort claims with one member each, while 52 control-plane gate refusals and
10 successful control-plane merge outcomes were recorded. Eligibility of all those requests is unknown.
Thus the record shows no multi-member amortization, not proof that batching would have fixed those failures.

The current ordinary control-plane release holds both main and dev train leases across proof and publication.
Sharing a final-head proof across compatible members can reduce repeated lane occupancy at the observed landing
bottleneck. The causal contribution of those leases to yesterday's waits is unknown: do not remove locks or gates
on this evidence. Use the existing immutable manifest, source guards, exact-candidate proof, atomic ref transaction,
finite retry budget and recursive split on failures. Do not retry an unchanged failed cohort wholesale.
The shared source pattern is fenced durable transitions plus exact-revision evidence, with explicit unknowns
where receipts are missing; amortize that existing proof boundary rather than weakening it.

Owner: control-plane manager; adoption belongs in the Goal tooling delivery contract. Compare the next complete
UTC day of eligible releases with this day, reporting cohort sizes and singleton exceptions, actual final-head
proof executions per successfully released source, landing p90 and sum of complete landing intervals.
Baseline: p90 **4104185 ms**, sum **720578300 ms / 418 pairs**, two singleton claims; proof executions per source,
lease-hold time, allowance per release and native-journey throughput are **unknown**. Instrument those receipts
before claiming savings. Success requires multi-member releases, fewer proof executions per released source than
a measured comparable singleton cohort, and landing p90 below 30 minutes, with no increase in new post-release
defects or missing member outcomes. Report split/retry work as cost. No change or benefit is claimed as implemented.

## Sources and decisions

Primary sources are the snapshot of `goal.sqlite` tables `flow_events`, `worker_events`, `landing_batch_claims`,
`dev_verifier_runs`, `dev_verifier_findings` and `worker_promotions`, plus REZICS source at
[d893df41173d27d24e4e3a0c19128c7bb03f4f21](https://github.com/rezics/rezics-next/tree/d893df41173d27d24e4e3a0c19128c7bb03f4f21):
[flow reader](https://github.com/rezics/rezics-next/blob/d893df41173d27d24e4e3a0c19128c7bb03f4f21/tools/goal/src/flow.ts),
[report handler](https://github.com/rezics/rezics-next/blob/d893df41173d27d24e4e3a0c19128c7bb03f4f21/tools/goal/src/worker-commands.ts),
[store](https://github.com/rezics/rezics-next/blob/d893df41173d27d24e4e3a0c19128c7bb03f4f21/tools/goal/src/store.ts),
[landing queue](https://github.com/rezics/rezics-next/blob/d893df41173d27d24e4e3a0c19128c7bb03f4f21/tools/goal/src/land.ts),
[train](https://github.com/rezics/rezics-next/blob/d893df41173d27d24e4e3a0c19128c7bb03f4f21/tools/goal/src/merge-train.ts),
[promotion](https://github.com/rezics/rezics-next/blob/d893df41173d27d24e4e3a0c19128c7bb03f4f21/tools/goal/src/promotion.ts),
and [cohort mechanics](../README.md#explicit-control-plane-cohort-release).
Source licence: [AGPL-3.0-only](../package.json), [full licence](../../../LICENSE). No external comparison or clone
was needed: this question concerns REZICS's recorded delivery path, not an unchosen external design.

Decisions: UTC October 31 is the previous day; the specific report placement supersedes generic `docs/research/`.
Machine identifiers stay in the raw evidence in the state directory;
private allowance/account configuration is excluded. Local extraction scripts and backup remain under `.temp/`.
Existing `tools/goal/src/flow.test.ts` supplies the named acceptance tests and is unchanged. Original acceptance,
native and browser verification are deferred by launch policy; only local Goal workspace typing is permitted.

Local foreground `bun run --cwd tools/goal typecheck` passed with exit status 0 after the report was committed.
This establishes workspace typing only. Deferred acceptance is `bun tools/goal/src/cli.ts report --flow --json`;
no acceptance suite, native/browser check, root check, worker-check or remote check was started.
Companion evidence SHA-256: `6ca57e787b7cce11226220684158580b80173b631608f75485499dda9f9f27df`.
