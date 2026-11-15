# Delivery-step audit: 2026-11-14 UTC

Window: **[2026-11-14T00:00:00.000Z, 2026-11-15T00:00:00.000Z)**.
Recommendation: merge architecture delta validation and open-violation reconciliation around one candidate graph.
Keep the correctness gates. This is a research recommendation; no executable policy or owner contract is adopted.

## Evidence and accounting

Retained evidence: `.temp/daily-step-audit-2026-11-14/` in the audit worktree. The shared SQLite database was read
through a read-only connection into a private snapshot, completed at 2026-11-15T00:23:15.830128Z. The existing CLI
ran against that snapshot with local `GOAL_MAIN_CHECKOUT`, `GOAL_STATE_DIRECTORY` and `GOAL_LOCAL_CONFIG` overrides:

```sh
bun tools/goal/src/cli.ts report --flow --since 2026-11-14T00:00:00.000Z --until 2026-11-15T00:00:00.000Z --json
```

`flow.json` retains that output. `events.json` contains **7,881 events**, selected by `at >= since AND at < until`.
`landing-operations.json` contains **385 terminal operations**, selected by the same predicate on `terminal_at`,
including legacy terminal events without operation IDs if present. All 385 have IDs and measured durations here.
Their full start-to-terminal durations include **1 operation started before the day**; they are not midnight-clipped.
The corresponding SHA-256 hashes are:

```text
flow.json                aac8aa72fa40035200b80186c24bf495b9eb7960ed3d66f2943cf913cdec4cbe
events.json              860e20bf393be557d10cc4f2d209c30796c63f201b1241dae464ba183955935d
landing-operations.json  813f9d215d4b15505a1e1fd2881d29bbe1612cb09877eff51515115316f96406
```

Times below are recorded milliseconds, not CPU time. Other paired stage intervals require both boundaries in the
event window; additional time from incomplete intervals is unknown. Nested intervals overlap: do not add them.
**Allowance cost is unknown for every step**; the retained telemetry supplies no attributable quota deltas.
Recorded resolver tokens below are not an allowance or money conversion. A diagnostic, rejection or conflict is a
recorded catch, not proof of a unique avoided production defect. Zero timing samples mean unknown time.
Current inventories, line totals, live queues and trailing-seven-day metrics in the CLI output are excluded.

## Dispatch through promotion

| Step | Failure prevented or exposed | Recorded catches and activity in the window | Recorded time cost (ms); allowance unknown | Disposition |
| --- | --- | --- | --- | --- |
| Dispatch preflight and routing | Invalid briefs, ownership or execution profiles | 365 dispatches; 84 estimate-floor advisories; no recorded returns. Actual defect catches unknown. | Unknown | Keep routing and contract validation; advisories do not demonstrate prevented defects |
| Start, dependency preparation and attempt fencing | Unusable installations or stale worker attempts | 553 matched starts; preparation/fence catches unknown | 46,707 across 553 start pairs; preparation breakdown unknown | Keep |
| Worker implementation, review and scoped validation | Incorrect source or premature success | 553 launches, 543 finishes, 16 closures; source/check catches unknown | 368,213,509 across 537 matched worker intervals, including embedded work and waits | Keep |
| Optional brief chaining | Unnecessary launches or context overflow | 340 offers, 1 chained event, 339 declines: 294 no-overlapping-brief, 45 context-limit; eligibility decisions, not product catches | Unknown | Keep; no measured saving |
| Check execution and worker resumption | Lost or duplicate check handoffs | 146 ready groups, 145 resumed, 1 without a resume in this bounded cohort; 63 ready timestamps unavailable. Product catches unknown. | 7,868,531 execution and 28,464,288 terminal-to-resume across 83 timed groups | Keep durable handoffs |
| Resume admission | Resource overload or stale admission | 49 resume-unavailable events; wait reasons affect 41 host-pressure, 34 worker-slice-reserve and 36 ticket-order groups, with overlap | 12,806,419 admission wait across 145 groups; overlaps resumption time | Keep |
| Landing queue and operation settlement | Lost, repeated or unfinished integrations | 385 terminal operations: 360 finished, 15 resolver-requeued, 10 acknowledged; terminal outcomes are not successful-integration counts | 28,240,730 execution across 385; p50 55,122, p90 75,192; queue wait unknown | Keep operation identity |
| Composition, declared paths, ancestry and formatting | Wrong-tree edits, scope escapes or malformed composition | Individual guard catches unknown; 16 dev-conflict observations across 16 task/attempt identities | Breakdown unknown within landing | Keep |
| Conflict resolution and replay | Unresolved or incorrect merge resolutions | 16 resolver-finished phases; 13 dev-conflict-landed observations; neither is a distinct-defect denominator | 868,951 across 16 resolve phases; replay breakdown unknown | Keep |
| Changed-file transpile | TypeScript syntax errors | 294 observations: 291 passed, 3 syntax repair handbacks | 14,905 across 294 observations | Keep |
| Kernel schema and derived generation | Stale or invalid generated schemas | 6 schema-tagged repair handbacks; diagnostics do not establish 6 unique product defects. Successful executions unknown. | 479 across the 6 failed samples only; total unknown | Keep |
| Architecture delta and violation reconciliation | Fatal manifest/parser/ratchet errors and unresolved boundaries | 319 delta executions: 301 passed, 18 diagnostic; 79 landable violation-line occurrences, not unique defects. Fatal catches and full-audit executions unknown. | 8,429,262 across 319 deltas; separate full-audit cost unknown | Merge candidate graph computation |
| Conditional Kernel entry import | Entry-load regressions | No import observations; executions and catches unknown | Unknown | Keep conditional guard |
| Configured root typecheck, boot and control-plane checks | Composed-tree type, startup or controller regressions | Executions, skips and catches unknown in retained evidence | Unknown | Keep configured gates |
| Dev ref update and integration settlement | Ref races or declaring unpublished source integrated | 338 dev-update observations; 348 integration events for 348 distinct tasks; refusal catches unknown | Unknown; no paired stage intervals | Keep |
| Independent verifier | Integrated boot, API or behavioral regressions | No verification flow events; 0 verifier-run and 0 finding rows created in the day. Actual executions and catches unknown. | Unknown | Keep; absence is not a pass |
| Page-data verification | Broken page wiring or missing persona coverage | No page-data-run observations; executions and catches unknown | Unknown | Keep |
| Promotion, stabilization and publication | Releasing a candidate failing root/task gates or publication checks | No promotion flow events; daily attempts, catches and promotions unknown | Unknown | Keep correctness gates |

The CLI's `devTranspile` aggregate combines **300 observations / 15,384 ms / 9 repair handbacks**. The table splits
these using `detail.guard`: **3** `dev-landing-transpile` returns and **6** `dev-landing-schema` returns. This avoids
mislabeling schema failures as syntax catches. Resolver token sums are input **3,034,472**, cached **2,554,496**,
output **23,112** across the 16 phases; cached input is not an additional independent cost.
There are **753 enqueue events**: **384 distinct operation IDs** and **369 events without IDs**. These are not
753 executions. The independent terminal-operation denominator includes starts outside the day.
`dev_verifier_runs.json` and `dev_verifier_findings.json` retain the bounded `created_at` exports. The singleton
`promotion-state.json` has no daily event timestamps; its current phase cannot establish yesterday's outcomes.

## One structural change and its measure

Have `checkLandingArchitectureCandidate` return both the exact-base delta and the complete candidate violation
snapshot from one graph calculation. Reuse the complete snapshot in `recordDevArchitecture` when settling open
violations. The current source invokes `auditLandingArchitecture` separately when violations remain open.
A delta alone cannot establish that an old violation disappeared. Preserve fatal returns, repair ownership,
candidate/base identity, configuration identity, and publication-aware settlement. No existing gate is removed.

Baseline: **319 distinct candidate/base pairs**, **8,429,262 ms** of measured delta checks; the full-audit count,
time and allowance remain unknown. The code establishes a repeated-computation path, not measured daily savings.
First measure the existing path for one complete UTC day, then the replacement for two complete UTC days. Record
an operation ID, candidate/base/configuration, open-violation state, complete-snapshot availability, graph-build
count, start/end, outcome and diagnostic class. Today's delta-only total cannot baseline the combined cost.
Success requires at most one candidate graph build per evaluation, complete reconciliation coverage when needed,
and no lost fatal diagnostics or incorrect violation closures. Compare total architecture time per candidate and
landing p50/p90 against the measured pre-change day, stratified by changed-file count and open-violation state; report integrations
and offered work. Lower comparable time with unchanged correctness coverage demonstrates benefit. Missing
coverage or no reduction does not. Allowance savings stay unknown until attributable measurements exist.
Adoption belongs to the control-plane owner in `tools/goal/README.md`; that document is outside this brief.

## Primary sources and validation

- REZICS at `674fe847ef087af8d6941f4c2c343c60876ac33a`, [AGPL-3.0 licence](../../../LICENSE):
  [flow window and pairing](../src/flow.ts), [CLI report assembly](../src/worker-commands.ts),
  [landing stages and reconciliation](../src/merge-train.ts), [architecture execution](../src/landing-architecture.ts),
  and [durable verifier/promotion storage](../src/store.ts).
  [Upstream revision](https://github.com/rezics/rezics-next/tree/674fe847ef087af8d6941f4c2c343c60876ac33a).
- OpenTelemetry [CI/CD span conventions](https://opentelemetry.io/docs/specs/semconv/cicd/cicd-spans/): distinguish
  task-run identity, terminal result and error class. Apply that accounting model to the existing SQLite ledger;
  no external tracing service or copied code is proposed. Reused clone under the main checkout:
  `.reference/delivery-tooling/semantic-conventions/`, file `docs/cicd/cicd-spans.md`, revision
  `7b31585fe9661d855b7f1745722aa20979eaf847`,
  [Apache-2.0 licence](https://github.com/open-telemetry/semantic-conventions/blob/7b31585fe9661d855b7f1745722aa20979eaf847/LICENSE).
  Updated `.reference/INDEX.md`; read pinned files with `git show`, without installing, building or running clone code.

Validation: `.temp/daily-step-audit-2026-11-14/validate.py` checks the report's window, counts, timing and hashes
against retained exports. No executable code changed; compiler, test wrapper and product suites are not required.
