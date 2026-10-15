# State

Checkpoint `ffebfab6-6566-44c0-bae5-4cbed4dd5ad2` for [this Goal](GOAL.md),
carrying forward `checkpoint:9992e78d-8512-462e-b7cc-c27180d39cca` and recording
only these handled events:

- `task:G-2248:23` (completion passed; production timed out; Program had already decided and resumed the worker).
- `task:G-2248:27` (cleanup-clock repair offered as partial; production again timed out; Program asked to decide the partial landing and remaining startup cost).

Both task turns acknowledged receipt in their reports to Program. This
checkpoint supplies no mail ID; the Operations mail inbox was empty. Later
parallel decisions, handoffs and landing results are outside this checkpoint.
It updates state only and authorizes no new work or proof.

| Field | State |
| --- | --- |
| Manager | Enrolled with the coordinator on 2026-10-13 15:34 UTC |
| Phase | Program directly steers G-2248 and G-2205. Event 23 found Program's cleanup decision `5cdc2e5c92` already committed and attempt 24 started. Event 27 referred partial repair `a5cebfde1064e193080ba70df0658d237609163a` and remaining production restore/startup cost to Program. Operations starts no landing, resume or closure; the authorized rerun is consumed |
| Proved on physical fixtures | D108 restore consumption qualifies in two post-fix restores. G-2248 completion passed with 103 expect calls on `7aad8d39c3234b06e21fd2ca8ea0f9c9a8826940`, including `08007`, running-state, replay/release and final erasure. It was not rerun on the cleanup repair. Production, full fixture disposal and OPS10 remain unproved; no complete scope row is established by these events |
| Fixture | G-2248 published current `c2b19656…` once and both consumers reused it, with source/key stability and physical custody verified before and after. Normal retention pruned superseded `7a2197cc…`; historical preservation directions below do not block that task. Event 27 also reports stable source/key and verified immutable custody. G-2205's last carried rebased check still lacked `postgres_data` custody for `fx-small-180553eb933a`; Program assigns it its own rebuild |
| Measures | No complete row newly proved. `task goal -- status` returned no figures before yielding; this no-wait turn claims no refreshed measures. Historical scope sample: 67/68 rows, 402 proved and 6 pending cells. Earlier Operations sample: 50% first attempts (that day 0%, 0/5), landed-task median 2, max 15 (G-2248), 110.5M input / 532k output tokens, 14 first / 12 step / 14 fix attempts and seven inferred fixes. Tokens per proved row remain unavailable. G-2248 has reached event 27, beyond the three-attempt cap. The repeated failures now isolate production cost: separating cleanup removed the candidate-5 disposal stall, but candidate-6 startup still exhausted 360 seconds. Program has the request to scope that remaining cost; no production improvement or complete outcome is accepted |

## Handled decisions and next action

Event 23 supplied no implementation to land. Completion QA
`20261015t200423-eab99f` passed with 103 expect calls on source-stable
`7aad8d39c3234b06e21fd2ca8ea0f9c9a8826940`. Production QA
`20261015t201053-9c32cf` timed out at 362.336 seconds against the unchanged
360-second operation limit; candidate 5 disposal and remaining production
assertions were unproved. Evidence:
`.temp/worktrees/g-2248/.temp/goal/final-qualification-handoff.md`.
Operations acknowledged the event in
`.temp/goal-orchestration/mail/operations-g2248-event23-program.md`.
Program's 20:23 UTC decision `5cdc2e5c92` was already committed and attempt 24
had started, so no duplicate ruling, resume, landing or closure followed.

Event 27 offered cleanup-clock repair
`a5cebfde1064e193080ba70df0658d237609163a` as `RESULT: partial`, reporting
12 tests / 78 assertions and selected types, lint and guards passing. It
separates capped cleanup from operation timing and retains bounded disposal
diagnostics; CLI overlaps with G-2668/G-2673 remain for merge resolution.
The one authorized production rerun, QA `20261015t203658-ff0867`, failed at
360.101 active operation seconds during candidate 6 PostgreSQL startup.
Candidate 5 disposal completed in 3.972 seconds; excluded cleanup totalled
20.627 seconds under its separate 120-second bound. The prior disposal stall
did not recur. Fourteen case-pass observations reached delivering-search-lease,
but delivering-download-lease, final completion and full fixture disposal
remain unproved. Completion was not rerun on this repair. Source/key and
verified immutable custody stayed stable before and after the failed consumer;
owned processes were stopped, but harness cleanup proves no full disposal.
Evidence: `.temp/worktrees/g-2248/.temp/goal/disposal-qualification-handoff.md`.

Operations acknowledged event 27 and asked Program whether to accept the
repair as a partial landing and scope remaining restore/startup cost under
the unchanged operation bound, in
`.temp/goal-orchestration/mail/operations-g2248-event27-program.md`
(`mail:0852d402-89e4-41cb-8170-7bfdce735e19`). No production outcome was
accepted and no brief edit, further retry, landing, resume or closure was
initiated. Program owns that next decision; this checkpoint makes none.

## Carried custody decisions

G-2205 event 8 was a failed rebased landing check, not an accepted OPS10
outcome. QA `20261015t193652-0e862f` refused missing `postgres_data` custody for
`fx-small-180553eb933a` in restore-0 after 2.270 seconds; zero copies qualified
and no merge occurred. Eight pre-merge unit/guard files, types, lint and AST
passed. Worker QA `20261015t192358-8901b0` used `fx-small-3639021cd088` and
reported 19 tests / 217 assertions, a 132.194-second build and 32.214/38.577-second
restores; that different-fixture result does not discharge the failed check.
Operations sent the reconciliation question to Program in
`.temp/goal-orchestration/mail/operations-g2205-event8-program.md` and made no
brief edit, resume, repeated landing or closure.

G-2248 event 21 stopped before preparation or either consumer on clean frozen
`a05911a9b01cba1c9ffb78ff472ea63b3f683415`: exact key `c2b19656…` was absent,
the two-source policy would prune protected `7a2197cc…`, and G-2205's historical
manifest was absent at its recorded path. Both publication manifest hashes
were unchanged, which does not establish physical custody. Evidence:
`.temp/worktrees/g-2248/.temp/goal/collation-qualification-handoff.md`.
Operations referred the custody/retention question in
`.temp/goal-orchestration/mail/operations-g2248-attempt21-program.md`, accepted
no physical outcome and started nothing; attempt-22 artifacts already existed.

Program's supplied 19:59 UTC mail points to decision `7aad8d39c3` in G-2248.
It supersedes every earlier decision in that brief: completion and production
physical erasure consumers must pass on current main; prune superseded custody
through normal retention, prepare and verify current `c2b19656…` once through
Task admission, then run completion followed by production once each serially.
Stop only for a consumer assertion failure or product refusal. Superseded
evidence protection and G-2205's historical manifest are no longer stop reasons;
G-2205 rebuilds its own fixture. Program already resumed G-2248. Operations
awaits the resulting event without starting a wait, worker or landing here.
Those earlier events contained no accepted qualification or successful landing
result; completion's later pass is recorded above.

## Earlier G-2248 qualification evidence

The following is historical evidence. Program's 19:59 UTC ruling above
supersedes its frozen-tree, preservation, stop and separate-resume directions.

Event 15 accepted a correct compatibility refusal, not a physical outcome.
Completion QA `20261015t184354-9332cf` requested current key `5a242e29…` while
the protected publication was `7a2197cc…`; production did not start. Changing
only the transitive `scripts/goal/config.ts` digest reproduced the new key, so
the earlier descriptor-only preflight was insufficient. Decision `375cbb936`
narrowed continuation to one existing producer invocation if matching custody
was absent, on a clean accepted tree frozen through preparation and later
qualification. It resumed the worker for preparation only, with consumers held
for a separate decision. The transitive inventory finding remains listed only.

Event 17 accepted current-key publication as a qualification prerequisite, not
a consumer outcome. Job `3f771fb1-8bd3-4a3e-a2b6-11f5d9a076e1` published one
build, zero reuses on frozen clean
`375cbb93609aac36cc19802b99971b561bde5c92`, with the same recomputed key before
and after publication:
`rs-owner-erasure-source-5a242e29f0fe04127521a7a71ca209e4fd4f483b33de2877da1b510eb5fa64bd`.
Producer work was 73.727 active seconds; physical preparation and verification
144.982 active seconds, under separate unchanged 600-second bounds. Cleanup
succeeded and protected custody stayed intact. Manifest structural digest:
`bb5bc68d32b57c09ff743f03d4792f6b0d6b9264accc6be645abf48f108434f1`;
integrity digest:
`723566ef3186663daac9e154dcffb38f81ef526932dcad572de01d7dcc0e2199`.
Evidence: `.temp/worktrees/g-2248/.temp/goal/current-key-custody-handoff.md`.
Decision `d1b9e5cd9` resumed completion then production serially, once each,
stopping at the first refusal on that same frozen tree and worktree-local root
`.temp/worktrees/g-2248/.temp/fixture/retained-sources`. It preserved source/key
preflight, physical custody checks, all assertions and separate unchanged clocks;
it authorized no retry, repair or preparation.

Program's 19:04 UTC mail took direct steering of G-2248 and G-2205. Operations
must send findings to Program instead of adding decisions to either brief.

Event 20's detailed handoff is `RESULT: partial`, despite the event's missing
RESULT classification. Completion QA `20261015t190804-a24af0`, admitted job
`7bed64f9-4f87-48db-bfde-1017e4deea53`, started restored native PostgreSQL and
the graph, then refused `CREATE DATABASE WITH TEMPLATE` for the Relay template:
recorded collation 2.41 versus host 2.43, SQLSTATE `XX000`. Both producer and
native tools report PostgreSQL 18.6; the producer image uses Debian trixie.
The authored `08007` injection was not reached, production was skipped and
completion OPS12 had zero passes / one failure / six expect calls. The clean
frozen source and exact key stayed stable; physical custody verification passed
before and after disposal, and protected evidence survived. Shard elapsed was
111.998 seconds; QA aggregate active time 165.810 seconds and admission wait
10.162 seconds. This is a collation refusal, not budget exhaustion. No repair,
preparation, retry, implementation landing or closure followed. Evidence:
`.temp/worktrees/g-2248/.temp/goal/frozen-tree-qualification-handoff.md`.

Operations mailed Program the brief path, evidence and repair question in
`.temp/goal-orchestration/mail/operations-g2248-attempt20-program.md`. Program's
19:19 UTC answer scoped G-2678: reindex and refresh collation version on the
disposable retained PostgreSQL copy, aligning producer and consumer collation
environments if possible. Program owns the resume after that repair lands:
completion then production on the frozen tree. These handled events contain
no G-2678 landing result and accept no lost-outcome, final-erasure or OPS10 proof.
No Operations brief edit, resume, landing, dispatch or close is due here.

## Prior host and publication evidence

Events 6–8 offered no repository implementation or physical proof. Completion
QA `20261015t180958-b6354d` refused missing `pg_config` before source selection;
production did not start. The next job refused at sudo authentication, and the
authenticated job then found no `postgresql-devel-18.6-1.fc44` package. Decisions
`62b0be26a`, `8c59dd659` and `5f8d5cd66` resumed the same worker for host repair,
then provider discovery, without changing the engine or compatibility identity.

Event 11 accepted signed Fedora `postgresql-private-devel` and
`postgresql-server-devel` 18.6-1.fc44: real `pg_config`, `pg_ctl` and `postgres`
agree on 18.6. Completion QA `20261015t182635-47a36a` at frozen
`0e9245e2be624724e094eca07ca0becfb3f12081` then refused missing retained custody
before physical assertions; production did not start. Decision `76b9c9d5c3`
resumed only custody inspection and, if absent, one existing producer invocation;
it stopped automatic continuation to consumers.

Event 13 delivered verified publication at frozen clean
`76b9c9d5c329b1e5d994bc276b88b445438f4675`, admitted job
`e468e8f3-5300-4ea9-bd11-9812f1b260c4`: one build, zero reuses, producer 27.178
active seconds and physical preparation 110.910 active seconds, both with zero
admission wait and separate unchanged 600-second bounds. Cleanup succeeded,
protected backups stayed unchanged, and no pruning occurred. Source key:
`rs-owner-erasure-source-7a2197cc5d1e8a5b563fa91d9b1dd986146b7f8d54923180ef7e2fd4b64917fb`.
Its manifest, backup and graph volumes are local to
`.temp/worktrees/g-2248/.temp/fixture/retained-sources`; another checkout's root
is not equivalent custody. Verified manifest digest:
`82e23cf0392799ca2a259d4521b43602d826525d5d6de610d58517eb239c8787`;
integrity digest:
`594392be5f888e6a3838e65fec306f113d2fb8ca2c608c39bf8938a48262c34c`.
Evidence: `.temp/worktrees/g-2248/.temp/goal/retained-source-publication-handoff.md`.

That publication proved no consumer outcome. Program had already committed qualification decision
`8d801db67d` and resumed attempt 14; event 13 therefore made no duplicate resume,
brief edit or landing. Later decisions and next action are recorded above;
retain all fault, custody, release and final-erasure assertions, separate clocks
and unchanged budgets. The original comment drill stays held on
its separate prerequisites. The host installer/declaration gap is listed only:
`docs/development/toolchain.md` omits the matching providers, and
`scripts/dev/cli.ts` does not resolve or check `pg_config`. No repair is
dispatched by this checkpoint.

## Carried wave-build decisions

The following records the earlier build decisions. Their no-stack/no-resume
directions do not override G-2248's later qualification authorization above;
this checkpoint supplies no new acceptance for the other tasks.

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
| G-2480, release image runtime import closure | Attempt 2 accepted as build support on `wave/1` through `da6c1369296b0fa07d1667e7172a04a90c256501`, including `5206c29f6`, `38e8e110a` and `94cade3c8`; brief decision committed at `6a34f7ae9`. Pinned import closure, installed-import refusal after production focus, dependency/exclusion coverage and frontend focus are preserved. Handoff reports 19 passing stack-free tests, types, lint, AST and post-rebase scripts typecheck. The unregistered `services/main/tests/also-enjoyed-read-cost.integration.test.ts` refused its guard; Program now reports registration repaired on the wave, with no waiver or extra G-2480 repair. Remains open for the wave after prove: no resume or individual landing |
| G-2481, declared retained-source producer clock | Attempt 2 accepted as build support at `2c6b00efbb0b910d463dcbcbb2569ff51b01be52`, verified on `wave/1`; brief decision committed at `42d672c9a`. Published `producerBuild?: { deadlineMs: number; evidence: string; run(context: SourceContext): Promise<void> }` runs under existing producer/key leases before `adapter.build` starts the unchanged physical-cut clock. Manifest provenance records declared timing and evidence. Handoff reports 35 passing owner tests, types, lint/AST and post-rebase scripts typecheck. API G-2427 and G-2482 consume it. Program accepted the decision and owns both wave guard findings: integration-test registration has been on the wave since 07:04 UTC; generation was underway and will repeat before prove. No waiver or Operations repair. Preserve G-2417's failure repair at `8f665f906`; keep open for wave landing after prove, with no individual landing or resume |
| G-2482, owner-erasure adapter producer phase | Attempt 3 accepted as build support at `0e9ebaec96a12c7e1355c0cc65a5e958e26b773e`, verified on `wave/1`; brief decision committed at `ce79e4759` and Program notified. One suspended fixture producer adopts G-2481's declaration before recovery fencing and coverage capture, preserving separate unchanged 600-second producer, preparation and restore bounds. Stack-free tests cover ordering, manifest timing, both deadline refusals, keyed staging cleanup and primary-error preservation with retryable cleanup. Handoff reports focused QA `20261014t074935-eac2ae`, types/lint/AST/guards after generation and final post-rebase types. Preserve the source-input digest regression and all six original physical tests below. No physical outcome is proved; keep open for wave landing after prove, with no resume or individual landing |
| G-2485, scheduled restore drill registration | Attempt 3 accepted as build support on `wave/1` at `fb4b82552ec4fcf6e0c2f7ccaf0fa36d95a2d5f0` under the existing bounded-registration brief. Nine-file review preserves QA slot admission, startup admission and memory leasing; 18 executable drills use singleton serial consumers, retained-only selection and separate active/admission clocks. Handoff reports passing stack-free owner/unit checks, types, lint/AST and post-rebase scripts typecheck. The full guards stopped on upstream registration, later repaired and covered by a targeted inventory test; full batch was not rerun. Generated outputs were restored: Program runs generation and all wave gates before prove, with no waiver. Three independent-restore targets remain absent and unregistered; their obligations remain. Keep open for wave landing after prove; no individual landing, worker resume or brief change |
| G-2513, independent-restore test recovery | Program's 07:29 UTC request confirms all three absent targets are first-public-scope work; brief committed at `83a0d0c50`. Attempt 2 failed on workspace routing before implementation; attempt 3 was already running, so no duplicate resume. Attempt 3 accepted as build support at `4ce968d7516ef3e5dfff703c1224692d8c9958ad` and `f5afa32e6285738e3c61d759c023d5e5576d5661`, verified on `wave/1`. All three targets are registered in the 21-entry serial plan; handoff reports passing stack-free checks and 80/80 historical assertion call sites preserved. The refusal target exposes original authority missing-custody assertions; no historical target of that name was found. Program notified in `mail:a46c4c3f-7760-4ab2-b03e-4a3fdf1a6a95`. Existing brief permits exact unresolved prerequisites, so no brief change. Keep open for wave landing after prove; no individual landing, close or worker resume. Physical restore, authority, refusal and disposal remain unproved |

## Carried prove-phase obligations

At the prior checkpoint, Program had the Operations prove-phase list and
G-2482's acceptance. No stopped
qualification worker is resumed during build. Native erasure gaps were
forwarded to API. G-2480, G-2481, G-2482 and G-2485 stay open to land with the
wave after prove. G-2513's recovery is also accepted as build support and stays
open for that wave landing. Program owns generation, whole-wave gates and the
physical prove prerequisites below. This checkpoint starts no worker or landing.

| Work | Required proof |
| --- | --- |
| Release image and recovery (G-2480 / G-2202) | Run `scripts/ops/tests/g-919-release-images.test.ts`, `tests/qa/integration/fresh-install.test.ts`, `tests/qa/fault-recovery/second-host-format-upgrade.test.ts` and `tests/qa/fault-recovery/g-727-launch-drill.test.ts`; qualify actual OCI role startup and recovery. G-2202's payload repair is on main at `498a578a2`; its packaged-Main healthy answer proves no actual image startup or complete recovery |
| Declared producer clock (G-2481) | Run `scripts/qa/retained-source.test.ts` in prove. Build-support acceptance establishes no physical custody, restore or erasure outcome |
| Owner-erasure adapter and campaign (G-2482 / G-2248 / G-2205) | Preserve all six original files under `tests/qa/fault-recovery/`: `comment-source-erasure.test.ts`, `owner-restore-erasure-production.test.ts`, `owner-restore-erasure-completion.test.ts`, `owner-restore-erasure-source-closure.test.ts`, `erasure-campaign.test.ts`, `erasure-campaign-qualification.test.ts`. First-adapter publication/custody/restore, production/completion erasure and campaign outcomes remain unproved |
| Independent restore and schedule (G-2485 / G-2513) | Execute `independent-restore.test.ts`, `independent-restore-authority.test.ts` and `independent-restore-refusals.test.ts` under `tests/qa/fault-recovery/` in the accepted 21-entry serial plan. Provenance and assertion comparison: `.temp/worktrees/g-2513/.temp/goal/handoff.md`. Preserve original success, read/write, authority, authentication, refusal, recovery, disposal and budget assertions. Program runs generation and all wave gates, explicitly prepares compatible `independent-authority-source` and `independent-recipe-source` custody (Recipe also needs a compatible retained small fixture), then executes through Task against isolated retained copies. Historical `realm_directory_position` capture refusal remains unproved; report it if it recurs. Registration and test recovery discharge no physical obligation. Physical restore, erasure drills and second-host rollback belong to prove |
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
