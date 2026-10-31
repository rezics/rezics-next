# Daily delivery-step audit: 2026-10-30 UTC

Window: **2026-10-30T00:00:00.000Z ≤ event time < 2026-10-31T00:00:00.000Z**.
The UTC clock still reads October 31, even though the local calendar reads November 1.
Evidence is a read-only SQLite backup captured at 2026-10-31T14:07:02Z; no live controller state was changed.
The [machine evidence](../../../docs/research/daily-step-audit-evidence.json) includes the full report JSON,
bounded daily flow, event census and historical promotion observations. It is an attachment to this report.

The strongest actionable finding is a misleading start queue: **303 of 304 supposedly pending start requests
already have a later worker-start event for the same attempt inside the day**. Merge the launch receipts before
using this apparent bottleneck to change capacity. No allowance saving or throughput improvement is established.

## Daily flow and its limits

The included command is:

```sh
bun tools/goal/src/cli.ts report --flow --since 2026-10-30T00:00:00.000Z --json
```

`commandOutput` in the attachment is the complete production report-handler response, generated at
2026-10-31T14:08:08.485Z against the private backup. The handler was invoked directly with these arguments;
the CLI's orphan recovery and manager recording were bypassed to keep the main checkout read-only.
This is evidence extraction, not execution of the deferred acceptance command.
`--since` has no upper bound, so that response also contains October 31 observations. Its lifecycle section
is capture-time state, not yesterday's state. **Only `previousUtcDayFlow` and `previousUtcDayCensus` inform the
daily numbers below**: they filter durable timestamps at both UTC boundaries and use midnight as the flow clock.

| Recorded flow stage | Complete intervals | Sum of intervals | p90 |
| --- | ---: | ---: | ---: |
| Dispatch → first start request | 651 | 174.264 h | 4.813 s |
| Start request → task running | 2,089 | 189.176 s | 111 ms |
| Check request → release | 0 | unknown | unknown |
| Worker running → finish | 2,307 | 700.615 h | 32.456 min |
| Landing enqueue → finish | 1,203 | 105.798 h | 9.424 min |
| Dev update | 0 | unknown | unknown |
| Verification | 0 | unknown | unknown |
| Integration | 0 | unknown | unknown |
| Promotion | 0 | unknown | unknown |

Zero complete intervals means missing pairs, not free execution. There are 710 dev-update events and 726
integration events for 710 distinct tasks, but no corresponding request timestamps. The window contains
685 dispatches, 2,392 worker launches, 2,321 finishes and 2,510 landing-enqueue events. These are event counts,
not independent delivered journeys. Cross-midnight intervals are excluded; intervals overlap and cannot be added
as elapsed wall time or stage CPU cost. Repeated requests and resumes remain in the production reader's totals.

The reader reports 46.23% flow efficiency across 587 eligible task rows and 2.610 launches per integrated task.
Missing check-slot telemetry means residency can be counted as working; repeated launches can be resumes.
Neither number establishes true productive efficiency or distinct attempts per delivery. Its apparent queues at
midnight are start 304 requests (oldest 23.885 h) and landing 104 (15.350 h); check, verification and promotion
have no recorded pending requests, so their actual queues are unknown. Cancellation and terminal reconciliation
are incomplete in this reader. Its named bottleneck, `start`, therefore needs the correction recommended below.

## What each step buys

**Allowance cost is unknown for every row.** Concurrent pool before/after observations do not attribute spend to
individual stages. Stage execution time is also unknown unless a measured interval is explicitly shown above.
Counts below are recorded rejection or failure observations, not inferred unique defects prevented.

| Step | Failure it prevents | Recorded catches in the UTC day | Time cost and disposition |
| --- | --- | --- | --- |
| Dispatch: brief, ownership, risk and dependency admission | Unauthorized, contradictory or prematurely runnable work | unknown; dispatch refusals have no complete durable census | Execution unknown; dispatch-to-request intervals above include holding. **Keep**. |
| Capacity, allowance admission and worktree launch | Starting without resources or a valid source checkout | Preventive catches unknown; 16 `launch-failed` events all report `Error: git -c failed` | Admission wait unknown; task-running receipt interval above does not measure all preparation. **Keep admission; merge launch receipts**. |
| Worker implementation and local validation | Delivering incomplete behavior or uncompilable source | Local validation catches unknown; 743 exit classifications: 471 environment, 261 spec-conflict, 11 scope-growth. These are failed exits, not proven product defects | 700.615 recorded residency hours; productive/check/idle split unknown. **Keep**. |
| Heavy-check slot admission and release | Oversubscribing shared checks or leaking leases | unknown; no check-slot flow events in this window | Queue and execution costs unknown. **Keep**, with no zero-cost claim. |
| Worker result, attempt fencing and durable landing enqueue | Stale attempts, missing commits or incomplete results publishing delivery | unknown; 1,255 `landing-requested` events versus 2,510 enqueue events show replay/duplicate counting, not twice the useful work | Separate execution unknown. **Keep guards; merge duplicate request accounting**. |
| Landing setup and formatting | Landing invalid source or an ineligible attempt | 2 setup rejections: one formatter parse error and one task-not-ready error | Per-step execution unknown. **Keep**. |
| Rebase, frozen-file and resolution checks | Integrating incompatible changes or losing protected assertions | 431 rebase-stage rejections across 431 task/attempt pairs; 384 name conflicted files. Remaining causes and total conflicts unknown | Per-step execution unknown. **Keep safety checks**; rejection count is not a complete conflict census. |
| Scope/risk validation and candidate freshness | Publishing undeclared-risk work or a candidate validated against moved refs | 1 scope-stage rejection is a moving-release-ref failure; actual scope-violation catches unknown | Per-step execution unknown. **Keep**, classify by cause rather than stage label. |
| Candidate typing and required landing gates | Compiler/regression failures reaching the target branch | 38 gate-stage rejections; 11 explicitly have `failsOnMain: false`. Others include Git/ref failures; all 38 cannot be called regressions | Per-check time unknown. **Keep compiler/control-plane gates**; broad dev checks stay after integration under current policy. |
| Merge/no-effect guard and atomic target update | Silent loss of worker changes, stale publication and false integration | 24 merge-stage rejections; 711 successful outcomes. Atomic-update/fence refusal census unknown | Per-step execution unknown; full landing interval above includes waiting. **Keep**. |
| Independent dev verification and baseline attribution | Undetected integrated regressions and blaming existing failures on new tasks | 707 stored command receipts: 315 pass, 392 fail; 573 findings, all `unknown`, with 364 distinct signatures. Proven newly introduced defects unknown | Receipt execution durations absent; verification flow pairs absent. **Keep after integration**; do not promote unknown findings to causal catches. |
| Promotion preflight, frozen candidate, full gate, isolation and main publication | Advancing main without correctness evidence, or reverting innocent tasks | Catch count unknown; no promotion flow events. Fifteen historical hourly observations show `gate-head` ten times, then `stabilize-blocked` five times; phase ages are unknown | Wait, gate, isolation and publication costs unknown. **Keep**; snapshots do not establish continuous gate duration or zero promotions. |

Landing outcomes carry cumulative `hostMs`: setup 1,666; rebase 4,576,397; scope 2,327,708;
gate 27,189,829; merge 40,243,563. These measure residence through the terminal stage, not that stage alone;
shared/batched work can overlap. They must not be substituted for missing per-step execution costs.
No step is recommended for removal on the strength of an unrecorded catch count.

## One structural change and the adoption measure

**Use one atomic attempt-launch transition to publish both worker-start and admission-complete receipts.**
`store.ts` currently emits `start.started` when the *task* changes to running, but emits `worker.started` when
an *attempt* changes to running. A resumed launch can therefore start work without closing its start request.
The reader also retains duplicate pending requests. Keep resource admission and attempt fencing; derive the
start queue from unmatched launch requests, close them on the authoritative attempt launch, and reconcile
terminal attempts. This changes the control-plane transition boundary, not product acceptance requirements.

The evidence baseline is 304 pending request events across 192 task/attempt pairs: 303 requests have a later
same-attempt worker start, 296 a later finish, and 77 a later integration. These sets overlap.
Shared patterns in the existing source are atomic fenced state publication, durable at-least-once delivery,
and readers requiring matching transition receipts. Align the start queue with those existing mechanisms.

After adoption, compare the next complete UTC day's new launch cohort with this one, separating first launches
and resumes. Require **zero pending requests that already have a later same-attempt launch or terminal receipt**
(baseline 303 for launches), and at least 99% matched request/launch receipts. Report unmatched active requests,
duplicate requests, oldest actual wait and request-to-launch p90 separately. Retain the raw event counts so a
lower queue count cannot be obtained by dropping legitimate waiters. Track integrated journeys per day as an
outcome guard; historical journey throughput and allowance savings are unknown. Reassess capacity only after
this correction; the recommendation has not been implemented or measured after adoption.

## Sources, decisions and handoff

Primary sources are REZICS's own durable operational records and implementation, pinned to
[6d3f767467c85dbb9d3bb561d12af784407bd92c](https://github.com/rezics/rezics-next/tree/6d3f767467c85dbb9d3bb561d12af784407bd92c):
[flow reader](https://github.com/rezics/rezics-next/blob/6d3f767467c85dbb9d3bb561d12af784407bd92c/tools/goal/src/flow.ts),
[report handler](https://github.com/rezics/rezics-next/blob/6d3f767467c85dbb9d3bb561d12af784407bd92c/tools/goal/src/worker-commands.ts),
[state/receipt writers](https://github.com/rezics/rezics-next/blob/6d3f767467c85dbb9d3bb561d12af784407bd92c/tools/goal/src/store.ts),
[landing queue](https://github.com/rezics/rezics-next/blob/6d3f767467c85dbb9d3bb561d12af784407bd92c/tools/goal/src/land.ts),
[merge train](https://github.com/rezics/rezics-next/blob/6d3f767467c85dbb9d3bb561d12af784407bd92c/tools/goal/src/merge-train.ts),
and `tools/goal/src/{dev-verifier,promotion,lifecycle-metrics}.ts` at that revision.
Repository source licence: [AGPL-3.0-only](../../goal/package.json); full [licence text](../../../LICENSE).
No external clone, installation, copied implementation or outside comparative research was needed for this telemetry audit.

The specific contract path takes precedence over the generic research-directory instruction. The only additional
file is `docs/research/daily-step-audit-evidence.json`, needed to include complete JSON while keeping this report
concise. Raw identifiers are retained only in that requested telemetry attachment. The snapshot predates later
base updates; historical evidence is not relabeled as fresh telemetry. Unknown costs and causal catch counts
remain unknown; recommendations await manager adoption into the owning efficiency/control-plane document.
Existing `tools/goal/src/flow.test.ts` already supplies the named tests and is unchanged. Original acceptance,
native and browser verification remain deferred; only local `tools/goal` workspace typing is permitted here.
