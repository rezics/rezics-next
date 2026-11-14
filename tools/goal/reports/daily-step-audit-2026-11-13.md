# Delivery-step audit: 2026-11-13 UTC

Window: **[2026-11-13T00:00:00.000Z, 2026-11-14T00:00:00.000Z)**. Counts use
persisted event timestamps; landing costs use operations terminating in that window, including starts before midnight.
Decision: count diagnostic executions separately from prevented defects, and preserve existing guard placement while
recommending shared architecture computation; this report adopts no executable policy change.

## Evidence and limits

The retained export is `.temp/daily-step-audit-2026-11-13/flow.json`, produced by:

```sh
bun tools/goal/src/cli.ts report --flow --since 2026-11-13T00:00:00Z --until 2026-11-14T00:00:00Z --json
```

Read-only exports of `flow_events` and terminal `landing_operations`, using the same inclusive/exclusive predicates,
are retained beside it as `events.json` and `landing-operations.json`. There are **4,754 events** and **190 terminal
operations**. SHA-256, respectively:

```text
flow.json                4e930c4c2e5235dbfeb7c8d92c18daec1a194109e26b457b56b0b8e646a4e043
events.json              12e29f11b21ef106235d96673262c8b7ceba776910aabc72c0d7cf8c7d4b7155
landing-operations.json  39ba937fbd614ac924ecb08c42c228033efc9fde87ef1fea0155a8cfc6fc6a0f
```

All costs below are recorded milliseconds, not CPU time or estimates. Non-landing stage totals cover matched
intervals in the bounded export; missing boundaries leave additional time unknown. Nested costs overlap and must
not be added. **Allowance cost is unknown for every step**: these exports contain no attributable quota deltas.
Resolver token observations are reported separately below; they do not establish allowance consumption.
Zero timing samples mean unknown time, even where the JSON aggregate is zero. Missing catches mean unknown,
not zero defects. Current task inventories, historical line attribution, live queues and seven-day guard/attempt
statistics do not establish this day's counts; they are excluded.

## Dispatch through promotion

“Caught” identifies a recorded return, diagnostic or conflict, not a proven avoided production incident.

| Step | Failure it prevents or exposes | Recorded catches and activity in this UTC day | Recorded time cost | Disposition |
| --- | --- | --- | --- | --- |
| Dispatch preflight and routing | Unusable briefs or wrong ownership/profile | 3 returns: 2 estimate-floor, 1 body-size; 9 advisory observations; 211 dispatched. These are policy catches, not demonstrated product defects. | Unknown; no matched dispatch interval | Keep ownership/routing; do not infer effectiveness of size rules from returns alone |
| Start, dependency preparation and attempt fencing | Launching stale attempts or broken installations | 484 requested/started pairs; preparation/fence catches unknown | 35,961 over 484 start pairs; preparation breakdown unknown | Keep |
| Worker implementation, review and scoped checks | Incorrect or incomplete source and premature success | 484 launches, 476 finishes, 3 explicit closures; source/check failure catches unknown | 265,828,385 over 475 matched worker intervals, including embedded work/waits | Keep |
| Optional brief chaining | Context overflow or unnecessary fresh sessions | 157 offers declined: 128 no overlapping brief, 29 context limit; these are eligibility decisions | Unknown | Keep; no saving demonstrated |
| Check execution/admission and worker resumption | Resource overload, duplicate or lost check handoffs | 57 ready and 57 resumed handoffs; 0 ready-without-resume in this bounded cohort; 14 ready timestamps unavailable; 6 resume-unavailable events. Product catches unknown. | 5,864,244 execution and 22,460,929 terminal-to-resume over 43 timed handoffs; admission wait 14,358,125 over 57 | Keep |
| Landing queue and operation settlement | Lost, duplicated or unfinished integration operations | 190 terminal operations: 180 finished, 10 resolver-requeued; these are outcomes, not guard catches | 9,526,431 over all 190; p50 32,176, p90 85,338; unknown-duration count 0 | Keep operation identity |
| Composition, path/ancestry checks and formatting | Wrong-tree publication, undeclared edits or unresolved merges | Individual guard catches unknown; 10 observed dev conflicts across 10 task/attempt identities | Breakdown unknown within landing | Keep |
| Conflict resolution and replay | Publishing unresolved or incorrect conflict resolutions | 10 dev-conflict-landed observations; 11 resolver-finished phases; not 11 distinct conflicts | 576,245 over 11 recorded resolve phases; replay/queue breakdown unknown | Keep |
| Changed-file transpile | Syntax failures in executable TypeScript | 157 passed executions; 0 recorded repair handbacks/unavailable; confirmed defect catches unknown | 12,265 over 157 | Keep |
| Architecture delta and open-violation reconciliation | Manifest/parser/ratchet failures and unresolved module boundaries | 178 executions: 168 passed, 10 diagnostic; 112 reported landable violation-line occurrences, not unique defects; 0 recorded repair handbacks | 4,215,622 over 178 delta checks; separate full-audit time unknown | Merge graph computation as proposed below |
| Kernel schema/derived generation and entry imports | Stale derived schemas or entry-load failures | Schema catches unknown; 0 Kernel-import samples; execution coverage unknown | Unknown | Keep conditional checks |
| Configured root typecheck and optional boot guard | Composed-tree type or startup regressions | Catches, executions and skips unknown in this export | Unknown | Keep configured ownership |
| Dev ref update and integration settlement | Ref races or declaring an unpublished task landed | 177 dev-update observations; 180 integration events, each for a distinct task, including 10 urgent tasks; refusal catches unknown | Unknown; no matched stage intervals | Keep |
| Independent verifier and page-data checks | Integrated behavior, boot, API or page regressions | No verification-stage or page-data-run observations; actual executions/catches unknown | Unknown | Keep; absence of flow evidence is not a pass |
| Promotion, stabilization and publication | Releasing a candidate that fails root/task gates or publication checks | No promotion-stage observations; actual attempts, catches and promotions unknown | Unknown | Keep correctness gates |

Resume wait reasons overlap: worker-slice-reserve 31, host-pressure 24, ticket-order 21, urgent-slots 5.
They count affected handoff groups, not independent failed checks. Resolver token vectors sum to input **1,821,246**,
cached **1,494,400**, output **14,728** across the 11 phases; no conversion to money or quota is supported.
There are 372 enqueue events, but only 191 carry distinct operation IDs; 181 have no operation ID. Do not treat
372 events as 372 executions or infer duplicate execution. Terminal operation identity supplies the landing denominator.

## One structural change and its measure

**Recommend merging architecture delta validation and open-violation reconciliation into one candidate graph
evaluation.** Today `checkLandingArchitectureCandidate` invokes `scripts/architecture.ts --changed <base>`;
`recordDevArchitecture` can invoke `auditLandingArchitecture` again while violations are open. Have the first
evaluation expose both the exact-base delta and the complete current violation set, reused for reconciliation.
Retain manifest/parser/ratchet returns, landable-boundary repair routing, exact candidate/base attribution and
publication-aware settlement. A delta alone cannot prove an older violation disappeared. Owner: control-plane
manager; adoption belongs in the integration section of `tools/goal/README.md` before implementation.

Baseline: 178 measured delta executions cost 4,215,622 ms; full-audit invocation count, cost and allowance are
unknown. This is an evidenced duplicate-computation path, not measured duplicate daily work or a proven saving.
For the first two complete UTC days after deployment, record one operation per actual architecture execution,
candidate/base, open-violation state, complete-snapshot availability, start/end, result and diagnostic class.
Success requires at most one candidate-graph evaluation per candidate/base, complete reconciliation coverage where
needed, and no lost fatal diagnostics or incorrect violation closures. Compare total architecture time per candidate
and landing p50/p90 against this day, stratified by changed-file count and open-violation state, with integrations
and offered work reported alongside. Lower comparable time with unchanged correctness coverage demonstrates help;
missing coverage or no reduction withdraws the recommendation. Allowance savings remain unknown until measured.

## Primary sources

- REZICS source at `dc66d86e20b00f5e52bedbc056942ffe76dbd747`, [AGPL-3.0 licence](../../../LICENSE):
  [flow window/operation reader and stage pairing](../src/flow.ts), [bounded CLI assembly](../src/worker-commands.ts),
  [architecture invocations](../src/landing-architecture.ts), [candidate reconciliation](../src/merge-train.ts),
  [resolver measurements](../src/train-resolver.ts), and the authoritative
  [integration contract](../README.md#integration-promotion-culprit-isolation-and-attempt-fencing) and
  [telemetry contract](../README.md#delivery-flow-telemetry).
  Upstream: [REZICS source revision](https://github.com/rezics/rezics-next/tree/dc66d86e20b00f5e52bedbc056942ffe76dbd747).
- OpenTelemetry [Tracing API](https://opentelemetry.io/docs/specs/otel/trace/api/), sections “Span” and “End”:
  operations have identity and start/end boundaries; ending one operation does not end nested operations.
  Apply that accounting model to the existing SQLite ledger, with no new tracing service or copied code.
  Retrieved clone `.reference/daily-step-audit/opentelemetry-specification/`, revision
  `a4e05d9704fc5218d85a4154fb5b143ea3f5340e`, file `specification/trace/api.md`,
  [Apache-2.0 licence](https://github.com/open-telemetry/opentelemetry-specification/blob/a4e05d9704fc5218d85a4154fb5b143ea3f5340e/LICENSE);
  indexed in `.reference/INDEX.md`. No clone code was installed, built or executed.

Validation: compare the committed window, counts, durations, outcomes and evidence hashes with the retained exports.
This report changes no executable code; product suites, wrapper and compiler are not required.
