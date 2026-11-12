# Daily delivery-step audit: 2026-11-11 UTC

Window: **2026-11-11T00:00:00.000Z ≤ event time < 2026-11-12T00:00:00.000Z**.
Keep the delivery protections; merge verifier command-result persistence and flow completion into one transaction.
The day contains **2,807 flow events, 830 worker events and 182 verifier records**. Verifier rounds record
36,445,640 ms, but individual command costs and all step allowance costs remain unknown.

## Evidence and counting

Reader revision: `3b7e0c3f2ccde4f02e3ba9e90ebba877fc18e342`. Read-only SQLite backup completed at
2026-11-12T00:22:17.671605Z, maximum flow sequence 202914. Retained evidence is in this worktree's
`.temp/daily-step-audit-2026-11-11/`: `goal.sqlite`, `capture.json`, `flow.json`, `bounded-flow.json`,
bounded table exports and `verify.py`. Raw identities and output remain outside Git. The existing reader ran
against a worktree-local copy, with these arguments:

```sh
bun tools/goal/src/cli.ts report --flow --since 2026-11-11T00:00:00Z --json
bun tools/goal/src/cli.ts report --flow --since 2026-11-11T00:00:00Z --until 2026-11-12T00:00:00Z --json
```

The first export includes the next day: 263 start intervals / 17,286 ms; the bounded export has
254 / 16,709 ms. Its current queues, lifecycle snapshot and seven-day guard ledger are not daily catches.
The second export supplies historical flow counts and costs; worker events use `at`, verifier records use
`created_at`, all with the same half-open window. No current task state supplies historical evidence.

“Catches” below means recorded failures, refusals or diagnostics, not unique defects or counterfactual incidents
prevented. Repeated and nested observations overlap. Elapsed sums are neither CPU time nor additive pipeline
wall time. Start/worker sums include complete same-day intervals only; landing costs use terminal operations
in the day and their recorded starts, including earlier starts. Verifier time is whole-round duration for the
completion-record cohort, not time clipped to midnight. **Allowance cost is unknown for every row**: no durable
per-step/day allocation exists. Token observations do not establish allowance consumed.

## Step ledger

| Step | Failure it prevents | Daily catches and activity | Recorded elapsed cost | Recommendation |
| --- | --- | --- | --- | --- |
| Dispatch and contract validation | Invalid or unready contracts start work | 89 dispatches; rejection count unknown; 17 prelaunch and 15 active amendments are repair activity | Unknown: no complete dispatch interval | Keep validation and in-place amendment |
| Admission and protected launch | Resource overload or duplicate launches | 254 requests and 254 starts; refusal count unknown | 16,709 ms / 254 pairs; earlier admission wait unknown | Keep protection |
| Historical proof admission | Untrusted evidence substitutes for current proof | 14 reader refusals: 6 parser, 6 source/ancestry, 2 dirty-source | Unknown | Keep provenance checks; repair readers at their owner |
| Worker execution and attempt fence | Stale workers publish or work is lost | 254 starts, 252 finishes; fencing catches unknown | 128,701,101 ms / 252 complete pairs | Keep execution and fencing |
| Source checks and proof custody | Failed or unavailable checks appear passed | 0 check-stage flow events; 17 proof-failed and 17 proof-failure-routed observations overlap; actual check-run count unknown | Unknown | Keep proof boundary; merge result/flow publication |
| Exit classification and recovery | Failures retry without a corrective response | 9 classifications: 8 environment, 1 pool-exhausted; 25 tool-blocker-incident-failure observations are not distinct incidents | Unknown | Keep routing; move environment repair to its owner |
| Landing enqueue and settlement | Queue ownership or terminal results disappear | 146 enqueues / 70 attempt identities; 76 terminal operations: 70 finished, 6 resolver-requeued; catches unknown | 3,433,628 ms / 72 timed operations; 4 legacy durations unknown | Keep atomic operation ledger |
| Candidate composition and conflict resolution | Conflicting edits reach dev unresolved | 6 observed conflicts and 6 conflict-landed events; 4 resolver completions are overlapping evidence | 173,769 ms / 4 completed resolvers | Keep repair inside landing |
| Dev transpile | Invalid TypeScript syntax reaches dev | 62 passes, 0 handbacks, 0 unavailable | 3,683 ms / 62 runs | Keep cheap candidate check |
| Dev architecture | Module violations go unseen | 64 passes, 4 diagnostics with 87 violation observations; 0 handbacks; diagnostics did not block landing | 1,512,311 ms / 68 runs | Keep diagnostic mode; measure repair yield |
| Dev Kernel import | Candidate cannot import or boot Kernel | 0 recorded runs; catch count unknown | Unknown | Keep contract; establish execution evidence |
| Controller acceptance and scope gate | Rejected source or undeclared sensitive edits land | 70 merge-stage passing outcomes, 0 recorded refusals; source acceptance coverage unknown | 2,656,269 ms summed hostMs, overlapping candidate work | Keep candidate and scope protection |
| Dev publication and integration | Stale refs advance or accepted work disappears | 67 dev updates, 70 integrations; ref-race catches unknown; totals do not prove one-to-one publication | Unknown: no complete update/integration intervals | Keep atomic publication |
| Independent dev verification | Deferred checks or interacting changes regress | 140 command records: 110 pass, 30 fail; 42 round summaries: 23 fail, 19 infrastructure; not additional defects | 36,445,640 ms / 42 rounds; per-command allocation unknown | Keep verification; merge result and flow completion |
| Page-data verification and repair routing | Live page/API/seed defects escape isolated checks | 2 boot failures, 6 check failures, 7 summaries; 18 repair routes: 13 dispatched, 5 resumed | Unknown | Keep live coverage and repair admission |
| Promotion candidate and release gate | A failing candidate releases | 0 promotion-stage flow events; full-gate and publication catches unknown | Unknown | Keep release protection; require transition evidence |
| Promotion attribution and quarantine | The wrong change is blamed or a known culprit returns | Attribution, culprit-isolation and quarantine counts unknown | Unknown | Keep isolation; do not remove an unmeasured safeguard |

The 30 failed verifier command records include 11 workspace-import checks, 6 typecheck commands and 13 other
commands. Round summaries separately record 220 testsRun: 62 passed, 29 failed, 129 unknown. These aggregates
have different units from cached command records and cannot be added or equated; infrastructure and unknown
outcomes are unverified. Seven page-data summaries contain 833 section observations: 13 DATA, 20 EMPTY,
731 UNAVAILABLE, 46 API, 23 SEED. Repeated observations and failure/summary events can describe the same run.
Resolver usage records total 718,405 input, including 591,232 cached, and 5,040 output tokens; cached input is
not additional input. Mutable promotion state and the success-only check cache cannot establish daily catches.

## One structural change and its measure

Recommend that the Goal verifier owner **atomically persist each command's run identity, start, terminal result,
error class and flow completion with its existing result record**. Keep product failure, infrastructure error,
skipped and unknown distinct; a round summary references its command runs instead of substituting for them.
Use the existing SQLite owner, following the delivered landing-operation pattern; do not add another monitoring
service or weaken a gate. This is a recommendation for adoption into the
[Goal verifier contract](../README.md#development-verification), not an adopted executable change.

Baseline: 140 verifier command records have **0 structured elapsed fields** and the day has **0 check-stage
flow events**. Landing already demonstrates measurable boundaries: **72/76 = 94.74%** terminal timing coverage;
the remaining four legacy operations stay unknown. Repeated enqueue events do not prove duplicate execution.
OpenTelemetry's run-identity/result pattern and REZICS's atomic landing ledger share the needed design:
one durable execution identity with explicit boundaries and outcome, rather than joining by task alone.

For the first two complete UTC days after adoption, require **100% of terminal verifier command runs** to have
matching result and flow receipts and valid start/end duration, **zero duplicate terminal receipts per run**, and
**zero infrastructure/skipped/unknown outcomes labeled passed**. Compare round elapsed time and integrations/day
at comparable offered work (this day: 42 rounds, 70 integrations, 89 dispatches); report retries and missing evidence
separately. Allowance savings remain unknown until allocation exists. Coverage demonstrates better accounting;
only a comparable improvement in delivery time or allowance demonstrates delivery efficiency.

## Primary sources and validation

REZICS primary sources, pinned to the reader revision above: retained SQLite telemetry;
[flow reader and operation pairing](../src/flow.ts), [existing report handler](../src/worker-commands.ts),
[flow owner contract](../README.md#delivery-flow-telemetry) and [verifier owner contract](../README.md#development-verification).
Source URL: [REZICS revision](https://github.com/rezics/rezics-next/tree/3b7e0c3f2ccde4f02e3ba9e90ebba877fc18e342/tools/goal).
Licence: [AGPL-3.0-only](../package.json), [licence text](../../../LICENSE).

External primary source: OpenTelemetry semantic-conventions, existing clone
`/home/edge/projects/rezics/rezics-next/.reference/delivery-tooling/semantic-conventions`, revision
`7b31585fe9661d855b7f1745722aa20979eaf847`, Apache-2.0 (`LICENSE`), reused in `.reference/INDEX.md`.
[docs/cicd/cicd-spans.md](https://github.com/open-telemetry/semantic-conventions/blob/7b31585fe9661d855b7f1745722aa20979eaf847/docs/cicd/cicd-spans.md)
and the [official CI/CD span specification](https://opentelemetry.io/docs/specs/semconv/cicd/cicd-spans/) describe
task-run identity and separate success, failure, system error and skipped results. Applying that pattern to the
existing SQLite ledger is this report's inference; no upstream implementation is proposed for copying.
The clone was read with `git show`; nothing from it was installed, built or run.

The contract's explicit report destination is used; recommendations await owner adoption. The reference index
is the only file changed outside the declared report paths. `verify.py` checks the window, counts and elapsed
sums against the retained backup and CLI exports. No executable code changed; compiler, test wrapper and ordinary
acceptance/native/browser/root/growth suites were not run, as this report-only contract requires no such runs.
