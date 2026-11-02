# Daily delivery-step audit: 2026-11-01 UTC

Window: **2026-11-01T00:00:00.000Z ≤ event time < 2026-11-02T00:00:00.000Z**.
Evidence: a SQLite read-only backup of the controller's `goal.sqlite`, completed at
2026-11-02T00:22:37.117298Z. Analysis used the private worktree copy; live controller state was not modified.

The flow reader identifies **landing** as the bottleneck. Its 447 complete enqueue-to-finish intervals total
**272206474 ms (75.613 h)**, with **p90 2325136 ms (38.752 min)**, above the 30-minute target.
These overlapping residence intervals include waits and retries; they do not measure CPU or isolated gate time.
Recommend separating read-only queue inspection from an authoritative landing-admission transition. Yesterday's
33327 `landing.started` observations covered only 474 task/attempt pairs; they are not 33327 executions.

## Included flow report

```sh
bun tools/goal/src/cli.ts report --flow --since 2026-11-01T00:00:00.000Z --json
```

The following is the aggregate projection of that report. The complete unchanged JSON is retained in
[local command-output.json](../../../.temp/daily-step-audit/command-output.json), SHA-256
`03a19ebf3f2e6ee8b4c3cdcbf4fd1c7567c51830ed70c8787c97b44db1c8d427`.
The production `runWorkerCommand` report handler returned 0 against the private backup. This was evidence
extraction, not an acceptance check: the CLI wrapper was bypassed because it performs orphan recovery and
manager-command recording. Task identifiers and detailed lifecycle rows stay in local evidence, following AGENTS.

```json
{
  "stages": [
    { "stage": "dispatch", "count": 360, "totalMs": 94431597, "p50Ms": 1579, "p90Ms": 3929 },
    { "stage": "start", "count": 596, "totalMs": 42400, "p50Ms": 65, "p90Ms": 87 },
    { "stage": "check", "count": 0, "totalMs": 0, "p50Ms": null, "p90Ms": null },
    { "stage": "worker", "count": 595, "totalMs": 511822552, "p50Ms": 621312, "p90Ms": 1920619 },
    { "stage": "landing", "count": 447, "totalMs": 272206474, "p50Ms": 6183, "p90Ms": 2325136 },
    { "stage": "dev-update", "count": 0, "totalMs": 0, "p50Ms": null, "p90Ms": null },
    { "stage": "verification", "count": 0, "totalMs": 0, "p50Ms": null, "p90Ms": null },
    { "stage": "integration", "count": 0, "totalMs": 0, "p50Ms": null, "p90Ms": null },
    { "stage": "promotion", "count": 0, "totalMs": 0, "p50Ms": null, "p90Ms": null }
  ],
  "bottleneck": "landing",
  "flowEfficiency": 0.6621553640793026,
  "attemptsPerIntegrated": 1.1794871794871795,
  "queues": [
    { "stage": "start", "length": 0, "oldestAgeMs": 0 },
    { "stage": "check", "length": 0, "oldestAgeMs": 0 },
    { "stage": "landing", "length": 0, "oldestAgeMs": 0 },
    { "stage": "verification", "length": 0, "oldestAgeMs": 0 },
    { "stage": "promotion", "length": 0, "oldestAgeMs": 0 }
  ],
  "lifecycle": {
    "asOf": "2026-11-02T00:23:19.833Z",
    "trailingHour": {
      "startsAt": "2026-11-01T23:23:19.833Z",
      "endsAt": "2026-11-02T00:23:19.833Z",
      "durationMs": 3600000
    },
    "promotion": { "available": true, "phase": "stabilize-blocked", "phaseAgeMs": null }
  }
}
```

`--since` has no upper bound and uses current task states. Consequently its queues and lifecycle describe capture
time, not midnight; missing request events also make zero queue lengths inconclusive. Daily numbers below instead
filter both UTC boundaries, call the same flow reader with midnight as its clock, and omit current terminal states
rather than projecting them backwards. Historic queue lengths/oldest ages remain **unknown**. Empty stage streams
mean unknown costs, despite the reader's zero totals. Cross-midnight intervals are excluded, not assigned zero cost.

| Interval wholly inside the day                          | Complete pairs |  Sum (ms) | p90 (ms) |
| ------------------------------------------------------- | -------------: | --------: | -------: |
| Dispatch → first start request                          |            359 |  93171291 |     3929 |
| Start request → task running                            |            595 |     42349 |       87 |
| Worker start → finish                                   |            595 | 511822552 |  1920619 |
| Landing enqueue → finish                                |            447 | 272206474 |  2325136 |
| Check, dev-update, verification, integration, promotion |         0 each |   unknown |  unknown |

The daily event census has 359 dispatches, 600 launches across 595 task/attempt pairs, 596 worker finishes,
898 landing enqueues across 449 pairs, and 449 worker landing requests. Both store and queue emit enqueue receipts;
898 is not twice the delivered work. There are 356 integration events across 352 pairs / 351 tasks, and 352 dev
updates. These are source settlements, not native journeys. The bounded reader reports 66.22% flow efficiency
across 324 eligible rows and 1.179 launches per integrated task. Missing check waits and same-attempt resumes limit
interpretation; neither ratio establishes productive efficiency or distinct attempts per delivered journey.

## Step value, observed catches and cost

**Allowance cost is unknown for every row:** no durable stage-attributed allowance ledger is available.
Counts are observed negative receipts, not unique defects prevented; successful transitions are not catches.
`hostMs` measures cumulative host residence through the outcome, including earlier stages. It cannot isolate a
step's execution cost, and overlapping/batched work must not be added as independent elapsed time.

| Step                                                                  | Failure prevented                                                                       | Recorded catches in the day                                                                                                                                                                    | Time cost and disposition                                                                                                                  |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Dispatch contract, ownership/risk and dependency admission            | Unauthorized, inconsistent or unavailable work starts                                   | unknown; no complete refusal ledger                                                                                                                                                            | Execution unknown; dispatch residence above. **Keep**.                                                                                     |
| Capacity/allowance admission and source preparation                   | Oversubscription or launching against absent/stale source                               | 3 failed resume launches require authenticated exact read-only source registration; 3 environment notices repeat that cause, not 3 extra catches. Other admission catches unknown              | Admission/preparation execution unknown; 42349 ms request-to-task-running residence covers only part of launch. **Keep**.                  |
| Worker implementation and local compiler validation                   | Incomplete behavior or compiler errors delivered as source success                      | Local check catches unknown; 132 classified exit events: 63 spec-conflict, 51 environment, 18 scope-growth                                                                                     | 511822552 ms paired worker residence; productive/idle/check split unknown. **Keep**.                                                       |
| Heavy-check slot admission, custody and result collection             | Oversubscription, lost results or leaked execution ownership                            | 5 proof-failed receipts; unique defects and custody refusals unknown. 2 proof-capacity-queued events are waits                                                                                 | Wait/execution unknown; no paired check flow events. **Keep**.                                                                             |
| Worker result/attempt fence and durable landing enqueue               | Stale attempts, missing source or lost handoffs enter publication                       | unknown; 449 requests and 898 enqueue events reveal duplicate accounting, not failures caught                                                                                                  | Separate execution unknown. **Keep** fences and durable enqueue.                                                                           |
| Landing selection/admission                                           | Work begins without queue ownership or current-attempt authority                        | unknown; 33327 start observations / 474 pairs cannot count admissions                                                                                                                          | Selection execution unknown; landing residence above. **Move** start receipt to actual admission; **remove** writes from queue inspection. |
| Candidate preparation, formatting and derived output                  | Invalid syntax or stale generated output reaches integration                            | 3 setup-stage refusals, all formatter/parser failures                                                                                                                                          | 14242 ms setup-labelled cumulative residence; isolated preparation time unknown. **Keep**.                                                 |
| Rebase, committed-work and frozen-file guards                         | Conflicting changes, empty delivery or changed protected assertions survive composition | 33 rebase-stage refusals: 31 carry conflict paths, 2 report no committed work beyond base/frozen acceptance. Frozen-file catches unknown                                                       | 120385 ms rebase-labelled cumulative residence; isolated rebase time unknown. **Keep**.                                                    |
| Scope/risk and exact-candidate/ref validation                         | Undeclared risk or obsolete candidate publishes                                         | unknown; no scope-labelled refusal recorded, without a complete guard ledger                                                                                                                   | Isolated cost unknown. **Keep**.                                                                                                           |
| Candidate typing, affected acceptance and control-plane release proof | Compiler, regression or provider/protocol errors publish                                | 85 gate-stage refusals, all control-plane; 21 explicitly record `failsOnMain: false`, 64 have unknown baseline attribution. Includes 25 interruption-budget refusals; 85 is not 85 new defects | 22914105 ms (6.365 h) gate-labelled cumulative residence; compiler/suite/lease split unknown. **Keep**.                                    |
| Semantic-loss/no-effect checks and atomic Git publication             | Lost changes, ineffective patches or raced refs publish                                 | 3 merge-stage refusals: 1 retained task-deleted-lines conflict, 2 no-effect assertions                                                                                                         | 15959850 ms merge-labelled cumulative residence, including 348 successes; isolated publication time unknown. **Keep**.                     |
| Dev update and durable integration settlement                         | Source success is reported before ref/outcome settlement                                | Preventive catches unknown; 352 updates and 356 integration events are positive receipts                                                                                                       | Execution unknown; no request/end pairs. **Keep**.                                                                                         |
| Independent head/baseline verification                                | New regressions escape attribution or existing failures are blamed on a change          | 2305 retained check results, 862 failed; 1484 retained findings, all `unknown`. Unique new defects unknown                                                                                     | Execution duration unknown: cached result bodies have no execution windows. **Keep** baseline distinction and bounded admission.           |
| Promotion capture, full gate and stabilization                        | Untested/incompatible product candidate reaches main                                    | Daily catches unknown; all 24 hourly promotion snapshots say `stabilize-blocked`, with unknown phase age                                                                                       | Gate/wait/stabilization costs unknown; snapshots do not prove continuous residence. **Keep**.                                              |
| Promotion atomic main publication and reconciliation                  | Raced refs overwrite histories or completion precedes publication                       | Daily catches and promoted count unknown; no promotion flow events establish a complete publication census                                                                                     | Publication/reconciliation time unknown. **Keep**.                                                                                         |

Verifier findings comprise 1038 absent-head-command sources, 132 absent-baseline-command sources, 259 unclassifiable
head failures and 55 unclassifiable baseline results. Retention can omit older rows; these are observed findings,
not a census of unique defects. No baseline failure for this report-only change is inferred from them.

## One structural recommendation and its measure

**Make landing queue inspection read-only, followed by one idempotent, fenced admission transition that emits
`landing.started` only when execution is admitted.** Keep inspection/deferral distinguishable from execution.
`SqliteLandingQueue.nextBatch` currently writes a start event for every selected row. `MergeTrain.drain` uses it
while scanning possible members; `integrateOrdinary` also uses it in `devPending`, including its 50 ms wait loop.
The source therefore explains why an observation can generate a start without work beginning; it does not prove
which caller generated each historical event.

The day contains **32853 starts beyond the first per task/attempt**. Four pairs account for 31767 of the 33327
observations (counts 8119, 8068, 7841 and 7739). Legitimate restarts within a pair are unknown, so 32853 is neither
an exact removable-write count nor a count of duplicated proofs. A single durable admission identity should bind
the queue entry, attempt, execution generation and candidate when known, and close on deferral/finish/recovery.
Repeated reads must be pure; retries still need their own real admissions and all existing source/ref/proof fences.
This applies the source's shared pattern—atomic fenced transitions with replayable durable outcomes—to the start
boundary. It removes synchronous telemetry writes from inspection at the reported bottleneck; time and allowance
savings remain unproved. No guard or release proof is proposed for removal.

Owner: control-plane manager; adoption belongs in the Goal tooling contract. Compare the next complete UTC day
of comparable landing volume, splitting source preparation, admission wait, proof execution and restart generation.
Require **zero start writes from read-only inspection** and exactly one start receipt per actual admission identity,
including after recovery. Baseline: 33327 starts / 474 pairs; actual admissions and inspection-write duration unknown.
Measure landing p90 against **2325136 ms** and the **1800000 ms** target, and proof executions per successfully
released source, recording split/retry cost. Claim throughput improvement only if comparable landing p90 falls
without more post-release defects, missing outcomes or changed proof coverage. Require a measured comparable
pre-change window for newly instrumented costs; unknown allowance/native-journey baselines cannot show savings.
This report recommends the change; implementation and benefit are not claimed.

## Evidence, sources and decisions

Primary evidence is the controller backup's `flow_events`, `worker_events`, `dev_verifier_runs`,
`dev_verifier_findings`, `landing_batch_claims` and `lifecycle_metric_emissions`. No new batch claims were recorded
inside the day; that does not establish zero execution of earlier cohorts. Local scripts, backup and raw output
are under `.temp/daily-step-audit/`; bounded events and computations are in `daily-events.json` and
`flow-evidence.json`. The latter's SHA-256 is
`bc0c3bc01cbce2f4beb6b8df6351879bfb9857860448aace8b3b62635227730b`.
Daily selection is `at >= '2026-11-01T00:00:00.000Z' AND at < '2026-11-02T00:00:00.000Z'`;
verifier tables use `created_at` and hourly snapshots use `hour_bucket`. Counts are grouped by persisted event kind,
stage and outcome, with task/attempt deduplication only where explicitly stated.

Implementation sources, pinned to the audited checkout's base
[01c786c14be1449f738faf6a23a13bf6ddfb59b6](https://github.com/rezics/rezics-next/tree/01c786c14be1449f738faf6a23a13bf6ddfb59b6):
[flow reader](https://github.com/rezics/rezics-next/blob/01c786c14be1449f738faf6a23a13bf6ddfb59b6/tools/goal/src/flow.ts),
[report handler](https://github.com/rezics/rezics-next/blob/01c786c14be1449f738faf6a23a13bf6ddfb59b6/tools/goal/src/worker-commands.ts),
[CLI side effects](https://github.com/rezics/rezics-next/blob/01c786c14be1449f738faf6a23a13bf6ddfb59b6/tools/goal/src/cli.ts),
[store](https://github.com/rezics/rezics-next/blob/01c786c14be1449f738faf6a23a13bf6ddfb59b6/tools/goal/src/store.ts),
[queue](https://github.com/rezics/rezics-next/blob/01c786c14be1449f738faf6a23a13bf6ddfb59b6/tools/goal/src/land.ts),
[train](https://github.com/rezics/rezics-next/blob/01c786c14be1449f738faf6a23a13bf6ddfb59b6/tools/goal/src/merge-train.ts),
[verifier](https://github.com/rezics/rezics-next/blob/01c786c14be1449f738faf6a23a13bf6ddfb59b6/tools/goal/src/dev-verifier.ts),
[promotion](https://github.com/rezics/rezics-next/blob/01c786c14be1449f738faf6a23a13bf6ddfb59b6/tools/goal/src/promotion.ts).
Source licence: [AGPL-3.0-only](../package.json), [licence text](../../../LICENSE).
No external clone or comparative design research was needed: the question concerns this repository's recorded path.

Decisions: November 1 is the previous UTC day. The specific report destination overrides generic `docs/research/`.
A private backup and direct report handler preserve read-only access to the main checkout while providing the
requested report without running deferred acceptance. Aggregate JSON is included above; identifiers stay local.
Research evidence is not an adopted policy. Only this report is tracked; no code, frozen file or acceptance test
was changed. The existing `tools/goal/src/flow.test.ts` supplies the named tests. Local Goal workspace typing is
required; original acceptance (`bun tools/goal/src/cli.ts report --flow --json`), acceptance tests, native/browser,
root, worker-check and remote-check verification are deferred under the launch policy.

Local foreground `bun run --cwd tools/goal typecheck` passed with exit status 0 after the report commit.
This is workspace typing only; deferred acceptance/native obligations remain with integration.
