# Daily delivery-step audit: 2026-11-12 UTC

Window: **2026-11-12T00:00:00.000Z ≤ event time < 2026-11-13T00:00:00.000Z**.
Keep the delivery protections; move boot-check queue/preparation accounting outside its execution phase.
The day records **5,308 flow events**, **1,605 worker events** and **309 verifier records**.
Infrastructure dominates timed verifier commands: **162/260**, costing **17,707,792 ms**; this is elapsed
command-wrapper time, not proven time spent executing tests. All per-step allowance costs remain **unknown**.

## Evidence and counting

Reader revision: `6bb5fc419ba3d161a76fc153b4951467ec614a1d`. A read-only SQLite backup completed at
2026-11-13T00:23:27.861630Z, maximum flow sequence 208224. Retained evidence in this worktree's
`.temp/daily-step-audit-2026-11-12/` includes `goal.sqlite`, `capture.json`, `since-flow.json`,
`bounded-flow.json`, bounded table exports and `verify.py`. The bounded export SHA-256 is
`3b5fc51a117487226493c0facc38cd6b84cf2ff404610326023382df0e752e78`.
The existing CLI read the local backup using `GOAL_STATE_DIRECTORY` set to that evidence directory:

```sh
bun tools/goal/src/cli.ts report --flow --since 2026-11-12T00:00:00.000Z --json
bun tools/goal/src/cli.ts report --flow --since 2026-11-12T00:00:00.000Z --until 2026-11-13T00:00:00.000Z --json
```

The first export includes today's events: 562 start pairs / 40,568 ms, versus 553 / 39,849 ms bounded.
Use only the second export for daily flow totals. Current queues, mutable task state, the seven-day guard ledger
and retry-ratio metadata do not establish daily catches. Worker rows use `at`; verifier rows use `created_at`;
landing operations and command costs use terminal timestamps inside the same half-open day, including recorded
starts before midnight. Legacy command-cache rows are a separate cohort from execution identities.

“Catches” means recorded refusals, failures or diagnostics, not unique defects or proof of incidents prevented.
Observations overlap across steps. Complete start/worker pairs are bounded-event pairs; absent boundaries stay
unknown. Elapsed sums overlap and cannot be added into pipeline wall time or CPU time. **Allowance is unknown
for every ledger row**; tokens do not establish allowance consumed. Zero recorded events does not prove zero runs.

## Step ledger

| Step | Failure prevented | Daily catches and activity | Recorded elapsed cost | Action |
| --- | --- | --- | --- | --- |
| Dispatch and contract validation | Unready or unauthorized work starts | 194 dispatches; 7 returns: 1 authority, 6 brief-size; 13 prelaunch and 9 active amendments are repair activity | Unknown: no dispatch interval | Keep validation and in-place amendments |
| Capacity admission and protected launch | Overload or duplicate/unprotected workers | 553 requests and starts; refusal count unknown | 39,849 ms / 553 pairs; preceding admission wait unknown | Keep |
| Historical proof admission | Untrusted historical evidence becomes current proof | 1 reader-unavailable refusal; remaining provenance catches unknown | Unknown | Keep custody; repair unavailable reader at its owner |
| Worker execution and attempt fence | Stale publication or lost work | 553 starts and 553 finishes; fencing catches unknown | 210,814,327 ms / 551 complete pairs | Keep |
| Source checks and proof custody | Failed or unavailable source checks appear passed | 37 proof-failed and 37 proof-failure-routed observations overlap; 1 proof-verified; total source-check runs unknown | Unknown; verifier command timings below are a different cohort | Keep |
| Exit classification and recovery | Failed attempts retry without corrective routing | 16 classifications: 13 environment, 2 scope-growth, 1 pool-exhausted; 50 tool-blocker incident-failure observations are not unique incidents | Unknown | Keep; move shared environment repair to its owner |
| Landing queue and terminal settlement | Ownership or terminal outcomes disappear | 350 enqueues / 167 attempt identities; 183 terminal operations: 163 finished, 16 resolver-requeued, 4 acknowledged; catches unknown | 16,421,746 ms / 182 timed operations; 1 duration unknown | Keep atomic operation ledger |
| Candidate composition, conflict resolution and publication | Incompatible or stale candidates publish | 15 dev-conflict and 15 conflict observations overlap; 15 resolver completions and 15 conflict landings; 1 abandoned resolution; 6 failed gate outcomes: 1 setup, 5 gate | 850,332 ms / 15 resolver spans, nested in landing; other composition costs unknown | Keep conflict handling and exact-candidate guards |
| Candidate transpile, schema and import guards | Syntax or startup defects reach dev | 2 transpile repair handbacks / 148 measured checks; 146 passed; no Kernel-import flow rows; schema/import catches unknown | Transpile 19,996 ms; schema/import unknown | Keep; absence of import rows is not a pass |
| Candidate architecture delta | Invalid manifests/parsing/ratchets or new boundary debt escape | 158 checks: 145 passed, 13 diagnostic; 0 repair handbacks; diagnostics are not blocking failures | 3,821,194 ms / 158 checks | Keep delta check and same-day boundary repair |
| Dev update and integration settlement | Published work lacks durable integration attribution | 156 dev updates; 157 integration events / 155 distinct tasks; settlement catches unknown | Unknown: no complete stage pairs | Keep; event and task counts have different units |
| Independent verifier, setup and affected checks | Composed source/test defects escape worker checks | 260 terminal commands: 95 pass, 3 fail, 162 infrastructure; 1 additional execution record still running in the snapshot is unverified | 25,771,203 ms: pass 8,032,645; fail 30,766; infrastructure 17,707,792 | Keep; move boot phase accounting as proposed below |
| Live page/API/seed verification and repair | Runtime or live-data defects escape isolated tests | 3 boot failures, 3 check failures, 5 run summaries; 8 repair routes: 7 resumed, 1 dispatched | Unknown | Keep live coverage and owner repair routing |
| Promotion candidate and release gate | An incorrect candidate becomes a release | 0 promotion-stage flow rows; full-gate and publication catch counts unknown | Unknown | Keep full root and task acceptance gates |
| Promotion attribution, culprit isolation and quarantine | Wrong culprit attribution or repeated known defects | Daily attribution/isolation/quarantine catches unknown; mutable promotion state is insufficient | Unknown | Keep; no evidence supports removal |

The 309 verifier records comprise 33 rounds, 261 execution records (260 terminal, 1 running), and 15 legacy
command records. Rounds record **28,488,689 ms**, with 186 testsRun: 73 passed, 7 failed, 106 unknown.
These units overlap command records and cannot be added or equated. Terminal command receipt/result matching is
**260/260**, with no duplicate execution identities; this is partial-day rollout evidence, not two complete days.
Five page runs supply 595 section observations: 539 UNAVAILABLE, 36 API, 11 EMPTY, 7 DATA, 2 SEED.
Resolver usage records 2,845,214 input tokens, including 2,324,864 cached, and 23,921 output tokens;
cached input is a subset. None of these observations prices step allowance.

## One structural change and its measure

Recommend that the Goal verifier and remote-check owners **separate remote admission/preparation from boot
execution in the existing command receipt and deadline handling**. Persist phase boundaries under the same
execution identity, start the boot-execution budget only at actual execution, and retain an overall round deadline
covering all phases. Preparation or queue failure remains infrastructure/unverified; it must never become a pass.
Preserve every boot assertion, setup requirement, selected test and promotion gate. Use the existing owners and
ledger, without another watcher or monitoring service. This is a recommendation for adoption into the
[verifier contract](../README.md#development-verification), not an adopted executable policy.

Baseline: **84 Kernel boot executions across 28 rounds and 28 heads**, exactly three per round, all timed out
and classified infrastructure, total **11,005,452 ms**. The durable output contains both admission waits and
preparation work; the command receipts have **0 structured phase-boundary sets / 260 terminal runs**. It is
unknown which phase caused each timeout, whether the underlying boot would pass, or how much time is avoidable.
This recommendation addresses that attribution and budget boundary; it does not assume all infrastructure has one cause.

For the first two complete UTC days after adoption, require **100%** of terminal remote boot runs to have
queue/preparation/execution/terminal boundaries or an explicit unreached phase, **zero** non-passing outcomes labeled
passed, and unchanged assertion coverage. Compare timed-out boot executions per captured head, boot completion
rate, phase elapsed sums, and verifier round time at comparable offered work. Today's baseline is 194 dispatches,
157 integration events and 33 verifier rounds; terminal commands are **62.31% infrastructure (162/260)**.
Success means fewer infrastructure boot timeouts per head and lower round time without more escaped boot defects
or deferred checks. Phase coverage alone proves better accounting; time and allowance savings remain unproven.

## Sources and validation

Primary REZICS evidence: retained SQLite backup and exports; [flow pairing and reader](../src/flow.ts),
[report handler](../src/worker-commands.ts), [command execution](../src/dev-verifier-execution.ts),
[command storage](../src/dev-verifier-storage.ts), [verifier](../src/dev-verifier.ts),
[remote-check phases](../../../scripts/remote-check.ts), and the owning
[integration/promotion contract](../README.md#integration-promotion-culprit-isolation-and-attempt-fencing).
Source URL: [pinned repository revision](https://github.com/rezics/rezics-next/tree/6bb5fc419ba3d161a76fc153b4951467ec614a1d).
Licence: [AGPL-3.0-only](../package.json), [licence text](../../../LICENSE).

External primary source: reused clone
`/home/edge/projects/rezics/rezics-next/.reference/delivery-tooling/semantic-conventions`, indexed in the
worktree-local `.reference/INDEX.md`, revision `7b31585fe9661d855b7f1745722aa20979eaf847`, Apache-2.0 (`LICENSE`).
Its [CI/CD span specification](https://github.com/open-telemetry/semantic-conventions/blob/7b31585fe9661d855b7f1745722aa20979eaf847/docs/cicd/cicd-spans.md)
defines task-run identity and distinct success, failure, system-error, timeout and skip outcomes. Applying that
identity/outcome model to REZICS's existing phase receipts is this report's design inference, not code to copy.
Only source text was read with Git; nothing from the clone was installed, built or run.

Decision: use the contract-named report as this audit's owner; retain raw evidence and the reference index locally,
leave missing measurements unknown, and defer structural-policy adoption to the Goal owner; supermanager notified.
Only this report is committed. Files outside declared paths are ignored `.temp/` evidence and `.reference/INDEX.md`.
`verify.py` checks the report window, counts, costs, cohorts and receipt pairing against retained evidence after commit.
No executable code changed; compiler, test wrapper and acceptance/native/browser/root/growth suites were not run,
as the report-only contract requires telemetry validation instead.
