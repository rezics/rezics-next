# Daily delivery-step audit: 2026-11-09 UTC

Window: **2026-11-09T00:00:00.000Z ≤ event time < 2026-11-10T00:00:00.000Z**.
Recommend merging landing state transitions and lifecycle recording under one operation identity. There are
80 enqueue events for 40 attempt identities, but only 1 of 40 integrations has a complete same-day landing interval.
These observations establish an accounting gap, not duplicate execution or a measured throughput loss.

## Evidence and limits

A read-only SQLite backup completed at 2026-11-10T00:22:54.262013Z; its maximum flow sequence is 198637 and
latest flow timestamp is 2026-11-10T00:21:43.046Z. Reader revision: `87c09e9f66488d7f3e1b221f01e9597fc279ffe1`.
Retained evidence is in this worktree's `.temp/daily-step-audit-2026-11-09/`: `goal.sqlite`, `capture.json`,
`since-report.json`, `daily.json` and `export.ts`. Raw records and task identities are excluded from this report.

The existing report handler was invoked with `report --flow --since 2026-11-09T00:00:00.000Z --json`, using
`runWorkerCommand` and a private-backup store rather than creating a runtime against the read-only main checkout.
Its complete output is retained in `since-report.json`. It includes November 10: for example, 233 start intervals
and 14,739 ms versus the bounded day's 229 intervals and 14,323 ms. Its seven-day guard ledger and capture-time
lifecycle/task states are not daily catch evidence. Daily totals below use 1,452 `flow_events`, 562 `worker_events`
and 135 `dev_verifier_runs` rows, each filtered at both boundaries; the verifier window uses `created_at`.
The bounded flow reader uses midnight as its clock and an empty task list to avoid inferring historical task state.

Method: follow the existing owner's half-open UTC window and unknown-cost rules; the contract-named report
owns these findings. No operational design is adopted here; adoption belongs in the [Goal owner](../README.md#delivery-flow-telemetry).
All step **allowance costs are unknown**: retained records do not allocate allowance consumption by step and UTC day.
Resolver tokens below are observed token usage, not allowance percentages; cached tokens are not added to input.
Time sums are recorded elapsed intervals, overlap across steps and exclude missing/cross-boundary pairs. They are
neither additive pipeline wall time nor CPU cost. Zero recorded events or complete intervals never means zero cost.
A catch is a recorded refusal, failed outcome or diagnostic; unique defects and prevented incidents remain unknown.

## Step ledger

| Step                                           | Failure prevented                                          | Recorded daily catches and activity                                                                                                                                                                        | Recorded time cost                                                                | Disposition                                                                                  |
| ---------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Dispatch and contract validation               | Work starts with an unusable or fragmented contract        | 50 dispatches; 1 returned brief for an estimate below the configured minimum; other rejection counts unknown; 9 active and 5 prelaunch amendments are repairs                                              | Unknown: 0 complete dispatch intervals                                            | Keep validation and in-place amendment                                                       |
| Admission and protected launch                 | Overload, duplicate or unauthenticated worker launches     | 229 start requests and starts; 3 waiting-resume launch failures report `Error: Proof execution unavailable: authenticated exact read-only source registration required`; other admission catches unknown   | 14,323 ms across 229 request/start intervals; earlier admission wait unknown      | Keep protection; move recurring proof-registration faults to their owner repair              |
| Worker execution and owner decisions           | Incomplete implementation or obsolete interpretation       | 229 worker starts and finishes; 29 accepted owner-decision events; defect catches unknown                                                                                                                  | 57,428,289 ms across 229 matched worker segments                                  | Keep decisions in the running session                                                        |
| Session chaining                               | Repeated setup for compatible follow-on work               | 18 offers; 11 no-overlapping-brief and 7 context-limit declines; these are scheduling choices, not defect catches                                                                                          | Unknown                                                                           | Keep optional; no saving demonstrated                                                        |
| Worker checks, slot waits and evidence custody | Unchecked or changed-after-check source lands              | 0 check request/acquire/release events; executed-check and product-catch counts unknown; 26 historical-proof-reader-unavailable records; 1 typing-evidence-pending and 2 typing-recovery-authorized events | Unknown; no durable slot intervals                                                | Keep checks; merge evidence settlement with physical-run identity                            |
| Attempt classification and repair routing      | Repeated attempts without a changed response               | 11 exit classifications: 10 environment and 1 spec-conflict; not 11 unique defects                                                                                                                         | Unknown                                                                           | Keep routing; move recurring environment failures to class repair                            |
| Landing enqueue and settlement                 | Lost queue ownership or untraceable completion             | 80 enqueues for 40 attempt identities; 47 starts, 40 finishes, 39 closures; catches unknown                                                                                                                | 3,898 ms across only 1 complete interval; integration coverage 1/40               | Merge state transitions and lifecycle recording                                              |
| Candidate composition and conflict resolution  | Unresolved overlapping edits reach dev                     | 5 conflict observations, 5 resolver completions and 5 conflict-landed events describe the same five observed conflicts                                                                                     | Resolver execution 218,804 ms; input 720,663, cached 613,760, output 6,265 tokens | Keep repair inside landing                                                                   |
| Dev transpile                                  | TypeScript syntax errors reach dev                         | 35 passes, 0 recorded handbacks, 0 unavailable; 180 TypeScript files among 234 changed-file observations                                                                                                   | 2,872 ms across 35 measured runs                                                  | Keep cheap candidate check                                                                   |
| Dev architecture                               | Undetected module/architecture violations                  | 38 passes and 1 diagnostic run with 5 violations; 0 handbacks; diagnostics did not block landing                                                                                                           | 801,616 ms across 39 measured runs                                                | Keep diagnostic mode; measure completed repairs before moving it                             |
| Dev Kernel import                              | A candidate cannot import/boot its Kernel surface          | 0 recorded runs; catches unknown                                                                                                                                                                           | Unknown                                                                           | Keep contract; record execution before judging value                                         |
| Controller acceptance and scope gate           | Failed acceptance or undeclared sensitive edits land       | 40 gate outcomes, all passing; 0 recorded gate refusals; source acceptance coverage is not established by a passing merge outcome                                                                          | hostMs sum 1,389,056; nested candidate work overlaps                              | Keep exact-candidate and scope protection                                                    |
| Dev publication and integration                | A stale/wrong ref advances or accepted work disappears     | 39 dev updates and 40 integrations; publication/ref-race catches unknown; event totals do not prove one-to-one publication history                                                                         | Unknown: 0 complete dev-update and integration intervals                          | Keep atomic publication; merge its lifecycle recording with settlement                       |
| Independent dev verification                   | Deferred checks or interacting changes regress             | 135 command records: 87 pass, 33 fail, 15 infrastructure; 2 timed-out records overlap those outcomes; unique defects unknown                                                                               | Unknown: records lack elapsed/start/end fields                                    | Keep independent verification; move shared infrastructure repair to its owner                |
| Page-data verification                         | Live page/API/seed defects escape isolated checks          | 13 boot failures; 0 completed page-data runs recorded; missing post-boot checks remain unverified                                                                                                          | Unknown                                                                           | Keep end-to-end verification; move recurring boot faults into shared environment/seed repair |
| Promotion gates, attribution and quarantine    | A failing candidate releases or the wrong change is blamed | 0 promotion-stage flow events; catches and daily gate/publication activity unknown; mutable promotion state is not transition history                                                                      | Unknown: 0 complete promotion intervals                                           | Keep release protection; record terminal outcomes before removing any gate                   |

Historical-proof-reader failures include `BuildMessage: Unexpected #!/usr/bin/env bun`. Page-data failures comprise
2 import-transport errors (both HTTP 503), 1 `process failed without output`, and 10 seed/finalization errors.
Those labels come from durable first-error lines, not a fresh root-cause diagnosis. Failed historical checks are not
passing evidence. Conflict labels across flow and worker tables are not added together as separate catches.

## One structural change and its measure

Give each actual landing operation a durable identity and one owner API that commits its queue-state transition
and lifecycle event together in SQLite. Make replay idempotent; retain genuine retries as distinct operations.
Write a start and terminal outcome for each operation, deriving flow history from these transitions. This extends
the previous day's recommendation because the recording gap remains; it does not establish whether a repair was attempted.
Use the existing database and owner, without another telemetry service or copied upstream code.

Baseline: enqueue events / attempt identities = **80/40 = 2.0**; integrations with a complete same-day landing
interval = **1/40 = 2.5%**. Repeated enqueues may be legitimate retries; the baseline cannot distinguish them.
After adoption, compare two complete UTC days: target **one enqueue per operation** and **100% terminal-operation
timing coverage**, following recorded starts across midnight for terminal cohorts. Separate retries by operation
identity so deduplication cannot conceal work. Report unknown boundaries explicitly. Track integrations/day,
landing p90, retry count and allowance/integration as secondary measures; allowance remains unknown until allocated.
Keep the change if coverage reaches its target without a throughput regression at comparable offered work.
Confidence is high in the accounting gap, moderate in the design, and unknown in any speed or allowance benefit.

## Primary sources and reproduction

REZICS, AGPL-3.0-only: [interval pairing](../src/flow.ts#L187), [flow report handler](../src/worker-commands.ts#L387),
[telemetry owner](../README.md#delivery-flow-telemetry), and the timestamped SQLite tables named above.
`export.ts` retains the handler call and `flowReport(readFlow(backup, start).filter(e => e.at < end), [], endMs)`.
Gate costs sum `worker_events.body.hostMs` for `gate-outcome`; resolver cost subtracts detail.startedAt from event.at.
Chain decline reasons use the JSON `detail.reason` field, not the entire serialized detail string.
The report's window, counts and costs are checked against the retained backup and bounded export. No executable code
changes; product suites, test wrapper and compiler are not required for this report-only audit and were not run.

External primary sources were read from existing clones under the main checkout's `.reference/`; no clone code was
installed, built or executed. Their reuse is registered in `.reference/INDEX.md` outside the declared report path.

- OpenTelemetry semantic conventions, `delivery-tooling/semantic-conventions`, commit
  `7b31585fe9661d855b7f1745722aa20979eaf847`, Apache-2.0 (`LICENSE`):
  [docs/cicd/cicd-spans.md](https://github.com/open-telemetry/semantic-conventions/blob/7b31585fe9661d855b7f1745722aa20979eaf847/docs/cicd/cicd-spans.md)
  requires task-run identity and result. The [official documentation](https://opentelemetry.io/docs/specs/semconv/cicd/cicd-spans/)
  was also retrieved. This supports distinguishing runs, skipped work and failures, not adopting a new tracing service.
- Temporal Server, `delivery-tooling/temporal`, commit `3eb5fb80523443d8583bcec463843275908f1bbc`, MIT (`LICENSE`):
  [common/persistence/data_interfaces.go](https://github.com/temporalio/temporal/blob/3eb5fb80523443d8583bcec463843275908f1bbc/common/persistence/data_interfaces.go#L241)
  groups workflow mutation and events in its update request. This is a design precedent; the proposed SQLite
  transaction boundary is a REZICS recommendation, not a claim that this interface proves storage atomicity.
