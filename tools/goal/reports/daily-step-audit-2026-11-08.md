# Daily delivery-step audit: 2026-11-08 UTC

Audit window: **2026-11-08T00:00:00.000Z ≤ event time < 2026-11-09T00:00:00.000Z**.
Recommend merging landing queue mutation, settlement and lifecycle recording into one idempotent transaction:
44 enqueue events cover 22 attempt identities, and none of the 18 integrations has a complete landing interval.

## Evidence and interpretation

A SQLite backup through a read-only connection to the controller's `.temp/goal/goal.sqlite` completed at
2026-11-09T02:07:59.691182Z. Its maximum flow sequence is 197232; latest event is 2026-11-09T02:07:06.049Z.
The reader revision is `f10b0bb34de332752291a363943dd44bcb7a605f`.
Daily counts use 892 `flow_events`, timestamped `worker_events`, and `dev_verifier_runs.created_at` in that backup.
Decision: retain the owner's half-open UTC-day rule and separate the complete since-only export from bounded daily counts
([owner](../README.md#hourly-delivery-report)); the contract-named report is the research deliverable.
No operational design is adopted by this report; the recommendation below needs an owner decision before implementation.

All step **allowance costs are unknown**: durable records do not allocate pool allowance consumption by step and UTC day.
Token counts below are observed tokens, not allowance percentages. Time sums are elapsed observations, can overlap,
and exclude missing intervals; they are neither CPU costs nor complete daily costs. A catch means a recorded refusal,
failed outcome or diagnostic, not proof of a unique defect or a prevented production incident. Unknown never means zero.

## Step ledger

| Step                                                         | Failure prevented                                                                        | Recorded catches and activity within the day                                                                                                                           | Recorded time cost                                                                                                                                             | Recommendation                                                                              |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Dispatch and contract validation                             | Starting work without a usable contract or declared ownership                            | 24 dispatch events; pre-dispatch rejections unknown; 12 active and 2 prelaunch contract amendments are repairs, not catches                                            | Unknown: no complete dispatch intervals                                                                                                                        | Keep validation; keep amendment repair in place                                             |
| Admission and protected launch                               | Resource overload and an unprotected or duplicate worker                                 | 150 start requests and starts; 1 launch-failed event; admission refusals unknown                                                                                       | 10,026 ms across 150 request/start pairs; admission waiting before request unknown                                                                             | Keep; separate admission wait from launcher time                                            |
| Worker execution and owner decisions                         | Incomplete implementation and stale contract interpretation                              | 150 starts, 158 finishes; 24 owner decisions accepted; defect catch count unknown                                                                                      | 118,757,737 ms across 150 matched worker segments; incomplete segments excluded                                                                                | Keep; owner decisions stay in the session                                                   |
| Session chaining                                             | Repeated setup when another compatible brief can reuse context                           | 13 offers, 12 no-overlapping-brief declines, 1 context-limit decline; these are scheduling decisions, not defect catches                                               | Unknown                                                                                                                                                        | Keep optional; no throughput conclusion from declined offers                                |
| Worker checks, slot waits and evidence settlement            | Landing unchecked or changed-after-check source                                          | Check request/acquisition/release events: 0 recorded; check catches and executed-check count unknown; 1 typing-evidence-pending and 1 typing-recovery-authorized event | Unknown; absent slot events cannot establish zero wait                                                                                                         | Keep checks; merge evidence settlement with the recorded physical run identity              |
| Retry, scope and environment classification                  | Repeating an unrepairable attempt without changing the response                          | 29 exit classifications: 24 environment, 3 scope-growth, 1 spec-conflict, 1 pool-exhausted; not 29 unique defects                                                      | Unknown; 56 attempt records ended that day, distinct from resumable worker segments                                                                            | Keep repair routing; remove repeated fresh attempts only after repair-in-place is supported |
| Landing enqueue and lifecycle settlement                     | Lost or duplicated queue ownership and untraceable landing                               | 44 enqueues for 22 identities; 24 starts, 21 finishes, 19 closures; catches unknown                                                                                    | Only 3 complete intervals, totaling 1,887,626 ms; successful integration interval coverage 0/18                                                                | Merge mutations and lifecycle events under one operation identity                           |
| Candidate composition and conflict resolution                | Publishing a candidate with unresolved overlapping changes                               | 2 conflict observations, 2 resolver completions and 2 conflict-landed events; these refer to the same two conflicts                                                    | Resolver execution 143,211 ms from recorded startedAt to resolver-finished; input 490,607, cached 420,992, output 3,789 tokens, without adding cached to input | Keep repair in the landing path                                                             |
| Dev transpile                                                | Syntax errors in changed TypeScript                                                      | 17 passes, 0 recorded handbacks, 0 unavailable; 238 TypeScript files among 300 changed-file observations                                                               | 1,216 ms across 17 measured runs                                                                                                                               | Keep cheap candidate check                                                                  |
| Dev architecture                                             | Module-boundary and architecture contract violations                                     | 14 passes and 3 diagnostic runs reporting 6 violations; 0 recorded handbacks                                                                                           | 403,754 ms across 17 measured runs; violation diagnostics are not blocked landings                                                                             | Keep diagnostic mode; measure repair completion before moving it                            |
| Dev Kernel import                                            | A candidate that cannot boot/import its Kernel surface                                   | 0 run events recorded; catch count unknown                                                                                                                             | Unknown                                                                                                                                                        | Keep contract; instrument execution before judging value                                    |
| Controller acceptance and scope gate                         | Publishing failed acceptance or undeclared sensitive changes                             | 21 outcomes: 18 pass, 3 fail; refusals: acceptance-failed, undeclared-risk-area, rebase-conflict (dependency HTTP 503)                                                 | hostMs sum 908,778; includes 0 for failed acceptance, so complete execution cost unknown                                                                       | Keep exact-candidate proof and scope gate; distinguish product failures from infrastructure |
| Dev update and integration                                   | Advancing the wrong ref or losing the accepted result                                    | 18 updated and 18 integrated events; ref-race/refusal catches unknown                                                                                                  | Unknown: no requested/updated or requested/integrated pairs                                                                                                    | Keep atomic publication; merge its lifecycle recording with settlement                      |
| Independent dev verification                                 | Regressions across landed changes and deferred checks                                    | 78 command records: 38 pass, 37 fail, 3 infrastructure; the 3 infrastructure records also timed out; unique defects unknown                                            | Unknown: these durable evidence records have no elapsed/start/end fields                                                                                       | Keep independent verification; failed records are not passing evidence                      |
| Page-data verification                                       | Broken live page/API/seed paths hidden by isolated checks                                | 7 boot failures: 3 ECONNREFUSED, 3 token acquisition/auth HTTP 401, 1 discovery-maintenance failure; no completed page-data run recorded                               | Unknown                                                                                                                                                        | Keep end-to-end check; move recurring boot faults to the owning shared environment repair   |
| Promotion gates, attribution, quarantine and ref publication | Releasing a failing frozen candidate, misattributing failures or publishing a stale head | 0 promotion-stage events recorded; catches unknown; mutable promotion state cannot reconstruct a day's transitions                                                     | Unknown                                                                                                                                                        | Keep release checks; record timestamped run outcomes before considering removal             |

Nested rows overlap: gate time is not additive with landing or worker time. Conflict events are counted once per
identity, not once per emitted label. A successful check does not establish that a guard caught a defect.
The seven-day guard ledger and capture-time task/promotion states in the raw export are not daily catch measurements.

## One structural change and its measure

Move landing enqueue, terminal settlement and their event writes into one owner API with one SQLite transaction per
state transition. Give each actual landing operation a durable identity, retain retries as separate operations, make
replays idempotent, and record one start and one terminal result before closing the interval. Derive flow history
from those transitions. Do not add a second telemetry service, weaken a check, or copy upstream implementation.

Baseline: enqueue rows / distinct attempt identities = **44/22 = 2.0**; successful integration identities with a
complete landing interval = **0/18 = 0%**. These are identity-level observations, not proof every repeated enqueue
is an invalid retry. After adoption, compare two complete UTC days: require **one enqueue per operation** and
**100% terminal-operation interval coverage**, reporting missing boundaries as unknown. Separate legitimate retries
by operation identity so deduplication cannot hide work. Track landing p90, integrations/day, retry count and
allowance/integration as secondary measures; allowance remains unknown until durably allocated. Keep the change if
coverage reaches the target without reducing integrations/day at comparable offered work; investigate any regression.
Confidence is high in the observed recording gap, moderate in the transaction design, and unknown in its throughput
benefit. If operation identities show all duplicates are legitimate retries, revise deduplication while retaining
complete terminal timing. No causal speedup is claimed from this one-day audit.

## Primary sources

REZICS sources: [flow interval rules](../src/flow.ts#L187), [report composition](../src/worker-commands.ts#L387),
[flow owner](../README.md#delivery-flow-telemetry) and the SQLite tables identified above (repository AGPL-3.0-only).
Daily stage totals were calculated with `flowReport(readFlow(backup, start).filter(e => e.at < end), [], endMs)`;
empty tasks deliberately avoid using capture-time task state to infer midnight queues or efficiency.
Event counts group `flow_events` by stage/action and `worker_events` by kind with `at >= start AND at < end`;
verifier outcomes use the same window on `created_at`. Resolver durations subtract detail.startedAt from event.at.

- OpenTelemetry semantic conventions, commit `7b31585fe9661d855b7f1745722aa20979eaf847`, Apache-2.0 (`LICENSE`):
  reused `.reference/delivery-tooling/semantic-conventions` under the main checkout; read via `git show`, without execution.
  [docs/cicd/cicd-spans.md](https://github.com/open-telemetry/semantic-conventions/blob/7b31585fe9661d855b7f1745722aa20979eaf847/docs/cicd/cicd-spans.md)
  specifies task-run identity and terminal result. The [official documentation](https://opentelemetry.io/docs/specs/semconv/cicd/cicd-spans/)
  was also retrieved. This supports distinguishing operations and results; it does not prescribe our storage design.
- Temporal Server, commit `3eb5fb80523443d8583bcec463843275908f1bbc`, MIT (`LICENSE`): reused
  `.reference/delivery-tooling/temporal`; read via `git show`, without execution.
  [common/persistence/data_interfaces.go](https://github.com/temporalio/temporal/blob/3eb5fb80523443d8583bcec463843275908f1bbc/common/persistence/data_interfaces.go#L241)
  couples workflow mutation and workflow events in an update request and exposes mutation version/condition fields.
  This is an established design precedent for versioned state-plus-history updates, not evidence of REZICS catch rates.
