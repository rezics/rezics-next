# State

Checkpoint `cf9878de-aa39-4b2a-933e-7132611b77b5` for [this Goal](GOAL.md),
carrying forward `checkpoint:437955ba-eef0-4022-9174-e5d878e74c67` and recording
only these handled events:

- `mail:2691f4d5-98f1-4fe7-ace8-6307b07b254e` (acknowledged 06:22:47 UTC).
- `mail:2fe76e83-0ba8-45b1-8a12-96440aab2fff` (acknowledged 06:23:38 UTC).
- `mail:85532105-520d-4050-b7f9-d87daaa65491` (acknowledged 06:29:32 UTC).
- `task:G-2485:2`, `task:G-2482:2`, and `task:G-2480:2`.
- `mail:e63f828e-b70a-47ae-8f32-8bb172008ee8` (acknowledged 06:46:41 UTC).

All acknowledgement times are on 2026-10-14. Later parallel handoffs are outside
this checkpoint. It updates state only and authorizes no new work or proof.

| Field | State |
| --- | --- |
| Manager | Enrolled with the coordinator on 2026-10-13 15:34 UTC |
| Phase | Build on `wave/1`; no QA stack, recording, coverage or physical qualification. Program runs the whole suite in prove and merges the wave to main once through the gate |
| Proved on physical fixtures | D108 restore consumption qualifies in two post-fix restores; no physical erasure row or OPS10 pass is proved. These events add no proved row |
| Fixture | Small `fx-small-180553eb933a` built once in 154.817 active seconds; post-fix restores qualify in 37.620 and 65.559 active seconds. Preserve it and superseded `fx-small-a3a906c1c1b7`; no pruning or repeat build |
| Measures | Current `task goal -- status` scope sample: 50/67 rows, 319 proved and 83 pending cells. Last recorded Operations sample: 82% first attempts (then today 100%, 2/2), landed-task median 1, max 4 (G-2248), 61.6M input / 294.3k output tokens, 9 first / 5 step / 2 fix attempts, one fix inferred. These are historical, not wave measures; current attempt/token rollups and tokens per proved row are unavailable in this checkpoint's returned sample. Retained preparation refusals remain evidence regardless of counters; G-2248's cap finding remains. Program measured 43% of worker input waiting versus 10% editing and 202/603 attempts on record tasks; the wave addresses those named causes. No weekly efficiency improvement is inferred |

## Wave build decisions

Program stopped the old workers and dropped the old queue at 06:01 UTC,
including G-2479. The four Operations build briefs were already committed and
dispatched before the handled wave mail; that turn started no duplicate work.
The repair correction was committed in all four briefs and their workers were
resumed. `paths: []` and `cases: []` impose no task-claim boundary: workers change
the files the outcome needs, native modules included. Repair follows code
reading; failing-before runs, growth series and stack logs belong to prove.
Where two causes remain, repair the more likely one, test each and name the
choice. A tests-only handoff is unfinished. No case-claim tool change is needed.

| Work | Handled decision and next action |
| --- | --- |
| G-2480, release image runtime import closure | Attempt 2 accepted as build support on `wave/1` through `da6c1369296b0fa07d1667e7172a04a90c256501`, including `5206c29f6`, `38e8e110a` and `94cade3c8`; brief decision committed at `6a34f7ae9`. Pinned import closure, installed-import refusal after production focus, dependency/exclusion coverage and frontend focus are preserved. Handoff reports 19 passing stack-free tests, types, lint, AST and post-rebase scripts typecheck. G-2474's unregistered `services/main/tests/also-enjoyed-read-cost.integration.test.ts` still refuses the guard; Program was notified, with no waiver or extra G-2480 repair. Remains open for the wave after prove: no resume or individual landing |
| G-2481, declared retained-source producer clock | Consolidates dropped G-2437 into the existing lifecycle on the wave. Preserve G-2417's failure repair on main at `8f665f906`. Publish the declared-build/physical-cut interface and its wave commit in the handoff to Operations and consumers; API G-2427 and G-2482 consume it. These events record no published-interface acceptance |
| G-2482, owner-erasure adapter producer phase | Attempt 2 is an unfinished no-commit partial; nothing can land. Decision committed at `76d662669`: adopt G-2481's boundary before recovery fencing and coverage capture, preserving the lifecycle and source-input digest regression. Shared classification/proof-contract and registration failures waive no gate. Program's 06:44 UTC answer requires no intervening Program action: when G-2481's handoff names its commit pushed to `wave/1`, resume G-2482 once with `rebase onto wave/1; G-2481's interface is at <commit>`. Held until that event; no resume in this checkpoint |
| G-2485, scheduled restore drill registration | Program's 06:17 UTC ruling needs no new reading for bounded g-1775 adoption; boundary committed at `8b6c2915a`. Attempt 2 ended without a handoff; no implementation accepted. Decision at `9ced396c2` requested resume, queued at that turn's host memory floor. Make registration-only core edits directly despite task claims, preserving QA slot admission, startup admission and memory leasing. Register executable drills on main; recover absent independent-restore targets from archived design within about two hours, or list exact omissions while registering what exists. No nonexistent target, second scheduler, fixture rebuild or budget increase; hand off wave commit, checks and executable serial plan |

## Prove phase and next action

Program has the Operations prove-phase list. No stopped qualification worker is
resumed during build. Native erasure gaps were forwarded to API. Read G-2481's
handoff when delivered and apply the single G-2482 resume above; decide other
build handoffs when delivered. G-2480 stays open to land with the wave.

| Work | Required proof |
| --- | --- |
| Release image and recovery (G-2480 / G-2202) | Run `scripts/ops/tests/g-919-release-images.test.ts`, `tests/qa/integration/fresh-install.test.ts`, `tests/qa/fault-recovery/second-host-format-upgrade.test.ts` and `tests/qa/fault-recovery/g-727-launch-drill.test.ts`; qualify actual OCI role startup and recovery. G-2202's payload repair is on main at `498a578a2`; its packaged-Main healthy answer proves no actual image startup or complete recovery |
| Owner-erasure adapter and campaign (G-2482 / G-2248 / G-2205) | Preserve all six original files under `tests/qa/fault-recovery/`: `comment-source-erasure.test.ts`, `owner-restore-erasure-production.test.ts`, `owner-restore-erasure-completion.test.ts`, `owner-restore-erasure-source-closure.test.ts`, `erasure-campaign.test.ts`, `erasure-campaign-qualification.test.ts`. First-adapter publication/custody/restore, production/completion erasure and campaign outcomes remain unproved |
| Independent restore and schedule (G-2485) | Execute the serial registered restore chain against isolated retained copies. Account for absent archived targets explicitly. Physical restore, erasure drills and second-host rollback belong to prove |
| API Content and Realm prerequisites | G-2427 consumes G-2481's wave interface; G-2365 still needs a complete verified Realm source. G-2249 preparation, reconstruction, G-2364 and original physical crash/campaign outcomes are not accepted by these events |

## Retained evidence and contracts

Earlier support decisions remain evidence, not authorization to restart old
qualification workers or repeat landings.

| Work | Retained result |
| --- | --- |
| G-2203 | Disposable Fuseki support accepted on main at `2502fc2597a7`, closed verified, claims released. Selected image, killed-container restart and redacted readiness logs prove support only; Program already notified API |
| G-2205 | Attempt-3 bootstrap/align-model support landed as `ef88de57e`; 18 supporting tests and both post-fix restores qualify. Campaign candidate still refuses `Content source field missing or ambiguous: field`; API owns the finding and exact accepted G-2249 verdict. Evidence: `.temp/worktrees/g-2205/.temp/goal/d108-evidence-inventory.json` |
| G-2248 / G-2398 / G-2269 | Sibling newer-head and completion support landed; G-2398's `fusekiBuildInputs` repair and G-2269's original setup are on main as G-2482's brief records. QA `20261014t005750-bf28c9` refused in 5.573 seconds on deleted `infra/fuseki` before source-key construction: no manifest, backup, candidate, completion or `08007` evidence. Twenty tests / 90 assertions proved support only. G-2248 retains G-2366's first-adapter and production/completion obligations. Evidence: `.temp/worktrees/g-2248/.temp/goal/retained-completion-handoff.md` |
| G-2366 / G-2287 | Shared mechanism support landed at `ef12a2d0c81ff796d2bffbf22207b699dc7468a1`, closed verified; handoff survives at `.temp/goal-orchestration/runs/G-2366/worktree-temp/goal/retained-source-handoff.md`. G-2287 cancelled into G-2248; correction `1dc1f851d85688215f82cd1b2daaba6617ab8a31` retained. No independent obligation, repeated landing or physical proof |
| API G-2266 / G-2367 | Publication prerequisite on main at `67988f2bf2c5896142a817efd3d2e1de66fc037f`: real PostgreSQL, 41 assertions, 58.252 seconds preparation; matching epochs publish, historical supersession rolls back, stale NULL-to-1 and 1-to-2 refuse unchanged. No physical erasure. History-reader cause preservation remains API-owned; preserve budget identity, abort precedence and closure guard |
| Access / composition | API owns review and landing; G-2205 capture records accepted Access `e2a24d6427c6237683a8c203f241c5467e0d51f3` and composition `4aacb759395d48d9c7a80a08ba802cd68d1e4bf4`. No independent restore or full erasure follows |
| G-2249 | Title-only crash qualification landed at `fe7e0002fd0a0cda0e15b029ae641036efa85d9e`, QA `20261013t215346-33fc0f`, 22 assertions / 121764 ms. No interrupted-body recovery or erasure. Attempt 8 refused deleted inputs before producer startup; attempt 9 QA `20261014t014343-980411` reached stopped custody without a manifest, then helper-held volume removal masked the primary exception. Neither original cause, budget verdict nor complete cleanup is proved. Evidence: `.temp/worktrees/g-2249/.temp/goal/handoff.md` and `preparation-failure-inspection.json` there. Candidate log SHA-256: `5a0b2f956c149e8c1196552cd42c7e87bd8041641ae4520b08311bdd40eb0ba9` |

`RetainedSources` / `RetainedSourceAdapter<M, C>` in
`scripts/qa/retained-source.ts`, building on `scripts/fixture/`, remains the sole
approved lifecycle. Keys use declared inputs and source-affecting byte digests,
never commits; missing declared inputs refuse. One builder owns each key under
its producer lease, with a coded two-source retention bound. G-2481 carries
Program's 04:22 UTC contract: an adapter-declared build runs once per key under
its own declared, evidenced deadline; the unchanged 600-second preparation clock
then begins at the physical cut and covers cut, seal and verification.
Undeclared adapters retain the clock from `adapter.build`. Restore, startup and
readiness retain their own 600-second bound; operation time retains 360 seconds.
Active build, admission wait and test time stay distinct. Failed/overrun builds
seal nothing and clean staging; preserve primary exception/cause/stack, secondary
cleanup evidence and available phase/active/admission timings. No budget rises.

Verify immutable manifest-bound custody before consumption and after restore
and disposal. Restore isolated copies through existing volume-copy tools;
dispose through the lease handle, removing only keyed producer resources.
Selection and restore never produce, supplement or reseal. Preserve historical
backups and unpublished staging, including both G-2205 backups outside bounded
retention. Keep every authentication, refusal, journal/epoch, erasure, release,
disposal and budget assertion; no retry or weaker compatibility is authorized.

The shared Content contract remains API's `retained-content-source-v1` at
`4bfe7ce57`: one main-selected public companion and one eligible published
variant, drained approval delivery and projection at the cut; bind graph/index,
object bytes, Content/Access/Main relay authority and cursor/outbox custody,
retained facts, digest and baseline public answer. Valid/missing/ambiguous copies
consume one valid source in the existing split qualifications. Old backup
`rezics-retained-d8dfd354-8cbc-41d3-a79c-63c687bf90bf` is partial evidence and
cannot be supplemented or resealed; preserve all Content/crash backups.

Program's admission-clock correction `13436f6dc80b` supersedes timing verdicts
from the saturated 2026-10-13 22:31–23:04 UTC window; verification timeout remains
diagnostic. G-2249 QA `20261014t032708-1acffe` was the host startup queue without
a slot; `20261014t025357-ae0b81` was the host memory stall. Those readings prove
no product fault or accepted preparation. The former bounded recheck
authorization is superseded during wave build by the no-stack decision. D105's
dependency-fetch failure likewise gives no retry permission. Historical retained
manifest counts establish neither rebuild frequency nor event counts.

Carried unfinished drills remain independent restore (`g-1776`), erasure
backup/replay (`g-1794`–`g-1797`), reconcile/operator steps (`g-1793`) and serial
schedule (`g-1775`), with archived refs under
`refs/archive/2026-10-12/goal/<task>`. Native deleted-person gaps (operation-id
SHA-256 form and author-prefix entries on surviving Works) are API work under
Program's referral. Startup index 503s and incomplete custody remain findings,
not grounds to edit copied data. This checkpoint requests no new Program ruling.
