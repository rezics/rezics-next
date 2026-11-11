# Daily delivery-step audit: 2026-11-10 UTC

Window: **2026-11-10T00:00:00.000Z ≤ event time < 2026-11-11T00:00:00.000Z**.
Recommend completing the already adopted operation-based landing ledger. The day records **52 enqueues for
26 attempt identities**, but only **2 of 26 integrations** have complete same-day landing intervals. This is
an accounting gap; repeated events do not establish duplicate execution or a measured throughput loss.

## Evidence and method

Reader revision: `0957dbfcbba144431014313ae74eafe13f898bd3`. A read-only SQLite backup completed at
2026-11-11T00:22:24.101301Z; maximum flow sequence 200082, latest flow timestamp 2026-11-11T00:21:00.524Z.
Retained evidence: this worktree's `.temp/daily-step-audit-2026-11-10/`, containing `goal.sqlite`, `capture.json`,
the existing CLI's `flow.json`, bounded table exports, `export.ts`, `bounded-flow.json` and `verify.py`.
Raw identities remain outside Git. The CLI command was:

```sh
bun tools/goal/src/cli.ts report --flow --since 2026-11-10T00:00:00Z --json
```

That output includes November 11: 134 start intervals costing 8,489 ms, versus the bounded day's 130 and
8,298 ms. Its seven-day guard ledger and capture-time lifecycle/task states are not daily catches.
Daily evidence filters both boundaries: **1,437 flow events, 324 worker events and 171 verifier records**;
the verifier cohort uses `created_at`. The bounded flow reader uses midnight as its clock and no current task
list, avoiding invented historical states. All counts below refer to this window, not cumulative snapshots.

Decision: the explicit contract's report path owns this audit instead of the generic research destination;
recommendations remain evidence for adoption by the [Goal owner](../README.md#delivery-flow-telemetry).
All step **allowance costs are unknown**: no retained allocation establishes allowance consumed per step and day.
Token observations are not allowance percentages; cached input is a subset, not additional input.
Elapsed sums overlap and are not additive pipeline wall time or CPU cost. Flow durations include only complete
same-day pairs; missing or cross-midnight boundaries remain unknown. Verifier durations describe rounds whose
records fall in the day, not time clipped to midnight. Recorded catches are failures, refusals or diagnostics;
unique defects and counterfactual incidents prevented remain unknown. Zero recorded runs does not mean zero cost.

## Step ledger

| Step                                                       | Failure prevented                                         | Daily recorded catches and activity                                                                                        | Recorded elapsed cost                                                  | Disposition                                                                         |
| ---------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Dispatch and contract validation                           | Unusable or fragmented contracts start work               | 31 dispatches; rejection count unknown; 1 active amendment is a repair                                                     | Unknown: 0 complete dispatch intervals                                 | Keep validation and in-place amendment                                              |
| Admission and protected launch                             | Overload, duplicate or unauthenticated launches           | 130 requests and starts; admission refusals unknown                                                                        | 8,298 ms / 130 request/start pairs; earlier admission wait unknown     | Keep protection                                                                     |
| Historical proof admission                                 | Untrusted or inapplicable historical evidence is accepted | 16 reader-unavailable events: 8 parser, 7 source/ancestry, 1 dirty-source refusals                                         | Unknown                                                                | Keep source authentication; move recurring reader faults to owner repair            |
| Worker execution and owner decisions                       | Incomplete work or obsolete interpretation survives       | 130 starts and finishes; 22 accepted decisions and 21 deliveries; defect catches unknown                                   | 31,914,049 ms / 130 worker segments                                    | Keep decisions inside the running session                                           |
| Session chaining                                           | Compatible follow-on work repeats setup                   | 2 offers, both declined for context limit; these are scheduling decisions                                                  | Unknown                                                                | Keep bounded reuse                                                                  |
| Worker checks and check-slot custody                       | Failed source or lost check results appear green          | 0 check-stage events; execution and catch counts unknown                                                                   | Unknown: 0 complete check intervals                                    | Keep evidence boundary; do not infer passes                                         |
| Exit classification and repair routing                     | A stopped attempt retries without a changed response      | 1 pool-exhausted classification; unique incident count unknown                                                             | Unknown                                                                | Keep routing; move capacity response to pool owner                                  |
| Landing enqueue and settlement                             | Queue ownership or terminal outcomes disappear            | 52 enqueues / 26 attempt identities; 27 starts, 26 finishes, 24 closures; catches unknown                                  | 3,838 ms / 2 complete intervals; integration coverage 2/26             | Merge state transitions and lifecycle recording                                     |
| Candidate composition and conflict resolution              | Unresolved overlapping edits reach dev                    | 1 observed conflict, resolver completion and conflict-landed event describe the same conflict                              | Resolver 62,318 ms; input 191,277, cached 156,544, output 1,695 tokens | Keep repair inside landing                                                          |
| Dev transpile                                              | TypeScript syntax errors reach dev                        | 23 passes, 0 handbacks, 0 unavailable                                                                                      | 2,675 ms / 23 measured runs                                            | Keep cheap candidate check                                                          |
| Dev architecture                                           | Module violations go undetected                           | 23 passes; 1 diagnostic with 1 violation; 0 handbacks; diagnostic did not block landing                                    | 538,816 ms / 24 measured runs                                          | Keep diagnostic mode; measure repair yield before changing placement                |
| Dev Kernel import                                          | A candidate cannot import or boot Kernel                  | 0 recorded runs; catches unknown                                                                                           | Unknown                                                                | Keep contract; record execution before judging value                                |
| Controller acceptance and scope gate                       | Failed acceptance or undeclared sensitive edits land      | 26 passing gate outcomes, 0 recorded refusals; merge success does not establish source acceptance coverage                 | 654,682 ms summed `hostMs`; overlaps nested candidate work             | Keep exact-candidate and scope protection                                           |
| Dev publication and integration                            | Stale refs advance or accepted work disappears            | 24 dev updates, 26 integrations; ref-race catches unknown; totals do not prove one-to-one publication history              | Unknown: 0 complete update/integration intervals                       | Keep atomic publication; merge lifecycle recording with settlement                  |
| Independent dev verification                               | Deferred checks or interacting changes regress            | 135 command records: 99 pass, 36 fail; 36 round summaries: 28 fail, 8 infrastructure; summaries are not additional defects | 24,262,435 ms / 36 round summaries; per-command allocation unknown     | Keep verification; move repeated environment failures to their owner                |
| Page-data verification and repair admission                | Live page/API/seed defects escape isolated checks         | 2 boot failures, 6 check failures, 5 run summaries; 12 repair routes: 5 dispatched, 7 refused                              | Unknown                                                                | Keep live coverage and scope admission; repair readiness/provenance at their owners |
| Promotion candidate, full gate, attribution and quarantine | Failing candidates release or the wrong change is blamed  | 0 promotion-stage flow events; gate, quarantine and publication catches unknown                                            | Unknown: 0 complete promotion intervals                                | Keep release protection; require transition evidence before removing a gate         |

The 36 failed verifier command records comprise 29 `scripts/workspace-imports.ts`, 2 Kernel boot,
2 Collection page, 1 Collection privacy, 1 Settings page and 1 combined UI shelf-toolbar/Goal managers run.
Round summaries overlap command records; neither repeated failures nor the 8 infrastructure rounds are passes.
Round `output` contains structured `durationMs`, even though individual command records lack elapsed fields.
Historical parser refusals contain `BuildMessage: Unexpected #!/usr/bin/env bun`; the other refusals require
the delivered producer/captured integration ancestor or a Git-clean source. These are durable labels, not new diagnoses.

Five page-data summaries describe 595 section observations: 6 DATA, 10 EMPTY, 466 UNAVAILABLE, 101 API and
12 SEED. These are repeated observations across runs, not 579 distinct defects. Run summaries and failure events
can share a run identity; 5 + 8 does not establish 13 independent executions. Boot failures concern seed finalization
and artifact handoff; check failures include navigation, readiness and output-provenance failures. Unrun probes remain
unverified. Mutable `worker_promotions` state and the success-only `check_results` cache cannot establish daily
promotion transition counts or failure costs.

## One structural change and its measure

Complete the [adopted landing-ledger design](../README.md#delivery-flow-telemetry): one landing owner API commits
queue-state transitions and their flow events in the same SQLite transaction, keyed by durable operation identity.
Replay emits no second event; a genuine retry receives a distinct operation. Preserve start and terminal outcome,
including across midnight. Use the existing database; no new telemetry service or upstream code is needed.

Baseline: **52/26 = 2.0 enqueues per attempt identity** and **2/26 = 7.69% same-day integration timing coverage**.
These are accounting measures, not proof of excess execution. Following adoption, measure two complete UTC days:
target **one enqueue per operation** and **100% start/terminal coverage for terminal operations**, reading earlier
starts across midnight. Keep retries distinct and missing boundaries unknown. Track integrations/day, landing p90,
retry count and allowance/integration as secondary outcomes at comparable offered work; allowance remains unknown
until allocated. Keep the change if coverage reaches its target without a throughput regression. This extends the
prior audit's recommendation; current evidence does not establish implementation status or savings.

## Primary sources and verification

REZICS, AGPL-3.0-only ([package licence](../package.json), [text](../../../LICENSE)): the retained SQLite tables,
[flow pairing](../src/flow.ts), [report handler](../src/worker-commands.ts), [Goal telemetry contract](../README.md#delivery-flow-telemetry)
and [dev verifier contract](../README.md#development-verification), at the reader revision above.
`export.ts` applies `flowReport(boundedEvents, [], midnightMs)`; `verify.py` independently checks database exports,
interval pairing, all reported counts/costs and the report window against the retained snapshot.

External primary sources were read through `git show` from existing clones under the main checkout's `.reference/`;
reuse is registered in `.reference/INDEX.md`, the only write outside this worktree. No clone was installed, built or run.

- OpenTelemetry semantic-conventions, `delivery-tooling/semantic-conventions`, commit
  `7b31585fe9661d855b7f1745722aa20979eaf847`, Apache-2.0 (`LICENSE`):
  [docs/cicd/cicd-spans.md](https://github.com/open-telemetry/semantic-conventions/blob/7b31585fe9661d855b7f1745722aa20979eaf847/docs/cicd/cicd-spans.md)
  and [official specification](https://opentelemetry.io/docs/specs/semconv/cicd/cicd-spans/) distinguish task-run identity,
  result, system errors and skipped work. This supports explicit run boundaries, without requiring a tracing service.
- Temporal Server, `delivery-tooling/temporal`, commit `3eb5fb80523443d8583bcec463843275908f1bbc`, MIT (`LICENSE`):
  [common/persistence/data_interfaces.go](https://github.com/temporalio/temporal/blob/3eb5fb80523443d8583bcec463843275908f1bbc/common/persistence/data_interfaces.go#L241)
  groups workflow mutation and events in an update request. This is a design precedent; SQLite atomicity is our
  recommendation, not a property proved by that interface. Both sources support learning a design, not copying code.

Report-only validation checks counts and window. Product acceptance/native/browser/root/growth suites, the test
wrapper and compiler are not required by this contract and were not run. No executable source changed.
