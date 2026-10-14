# State

The checkpoint for [this Goal](GOAL.md), recording `task:G-2366:1`,
`mail:db9f5da9-3aad-4f68-92e3-a899ecfcebb5` and
`mail:875cbb22-dc0d-43fa-97f6-c34e8c8e4cb0` under
`checkpoint:6cb18b8f-7471-4202-bdda-7ba59c611a9b`, carrying forward
`checkpoint:d935fcdd-bc1e-4679-b581-75da1507f8a8`'s decisions. Both listed
mail deliveries and G-2366's successful partial-landing mail
`mail:0daf9fb4-1306-41d9-b3e3-7ed9af5e780f` are acknowledged. This records
only those handled decisions, not later handoffs running beside this checkpoint.

| Field | State |
| --- | --- |
| Manager | Enrolled with the coordinator on 2026-10-13 15:34 UTC |
| Proved on physical fixtures | D108 restore consumption qualifies in two post-fix restores; no physical erasure row or OPS10 pass is proved |
| Fixture | Current small `fx-small-180553eb933a` built once in 154.817 active seconds; post-fix restores qualify in 37.620 and 65.559 active seconds. Both it and superseded `fx-small-a3a906c1c1b7` remain retained; no pruning or repeat build is authorized |
| Measures (`task goal -- status`) | Last available operations reading: first-attempt share 75% (6/8); attempts per landed task median 1, max 3 (G-2248); 42.7M input / 168.7k output tokens; tokens per proved row unavailable; no recorded refusals. A status reading was requested at this checkpoint but returned no updated measure before the turn ended without waiting; these are carried figures, not a fresh efficiency verdict. No new physical row is proved |

## Work in progress

| Work | Decision and next action |
| --- | --- |
| G-2202, release payload and image (D026) | Running, first attempt. Capture the missing-import failure, then prove packaged Main and actual local release-image startup with image identity and a healthy answer. An API failure after startup is a partial handoff |
| G-2203, disposable Fuseki support (D016, D075, D109) | Program reports the support step accepted on main at `2502fc2597a7` (three files), task closed verified and claims released. Selected image, killed-container restart and bounded redacted readiness logs are landed support; physical checks remain red. Program already mailed API the revision |
| G-2205, campaign fixture evidence (D108) | Attempt 3 consumer fix `ff6c24d890d58d1cb29234d6b8b7425fc6adaaf3` accepted as partial support; `land --step` succeeded, on main as `ef88de57e`. It admits only the authenticated initial model-bootstrap sequence advance and accounts for `align-model`. Static gates and 18 supporting tests pass; both post-fix restores qualify. Physical campaign remains red at candidate startup: `Content source field missing or ambiguous: field`. Keep open pending API's accepted G-2249 qualification and exact verdict; no worker resume now. Evidence: `.temp/worktrees/g-2205/.temp/goal/d108-evidence-inventory.json` |
| G-2248, consolidated owner-erasure consumer qualification | Reclaimed and resumed as attempt 4 for exactly one changed retained-source completion qualification on accepted retention support `ef12a2d0c81ff796d2bffbf22207b699dc7468a1` and helper `3a9662260de1ea1da8b5dc89e2203c0f661d782f` (`08007` lost outer outcome, `55P03` unavailable write). Adopt G-2287's preserved historical setup correction `1dc1f851d85688215f82cd1b2daaba6617ab8a31` into the two sibling consumers, preserving every assertion. G-2366's unproved first-adapter and production/completion physical obligations transfer here; no second physical runner. Source preparation is outside the 360-second operation clock, with separate unchanged 600-second preparation and restore/readiness ceilings. No production timing rerun or original comment drill is released; fixture, lifecycle, harness and service edits remain excluded. No physical outcome is proved |
| G-2269, original source-erasure newer-head setup | Already running at the epoch-prerequisite decision; sole editor of the original comment-source-erasure test. API's G-2266 qualification is accepted on main at `67988f2bf2c5896142a817efd3d2e1de66fc037f`: real PostgreSQL, 41 assertions, 58.252 seconds active preparation, full check passed; service unchanged. Matching epochs publish; transactional historical supersession rolls back; stale NULL-to-1 and 1-to-2 captures refuse unchanged. No setup acceptance or physical pass is recorded by these events |
| G-2287, sibling newer-head setups | Closed cancelled into G-2248; claims released and branch `goal/g-2287` preserved with correction `1dc1f851d85688215f82cd1b2daaba6617ab8a31` for adoption. No independent obligation remains. Saturated-host copy-3 timeout and timing readings prove no product fact; no rerun for a better time or physical acceptance follows |
| G-2366, shared retained-source preparation | Partial mechanism support accepted and landed at `ef12a2d0c81ff796d2bffbf22207b699dc7468a1` (including `22053e9cd` and `6fe82f03e`); closed verified for support only, claims released. Sole mechanism remains `RetainedSources` / `RetainedSourceAdapter<M, C>` in `scripts/qa/retained-source.ts`, building on `scripts/fixture/`. Physical first-adapter proof and production/completion obligations transfer to G-2248. API received the accepted revision and contract in `mail:887249ba-4bae-47a8-b2bb-198cb250393f`; Program received the scope transfer and request for its accepted-commit notification in `mail:ced4ed6d-9dd5-4a2c-9561-b8ccdfa8fb57`. Complete handoff survives cleanup at `.temp/goal-orchestration/runs/G-2366/worktree-temp/goal/retained-source-handoff.md`. Passed mechanism gates prove no physical source, restore or erasure |
| G-2367, history-reader cause preservation | API committed and invoked dispatch of the bounded repair for the guard failure at `services/main/src/modules/work/history.ts:134`. Preserve `RevisionReadBudgetExceeded`, message, budgets, abort precedence and refusal meaning; require exact-cause regression and unchanged restore-closure guard. Await API's accepted-main notification; no classifier change, gate waiver, expensive restore run or physical proof follows |
| G-2249, retained Content and crash-fence qualification | API's isolated title-only crash qualification remains landed at `fe7e0002fd0a0cda0e15b029ae641036efa85d9e`: source-stable QA `20261013t215346-33fc0f`, 22 assertions, 121764 ms; no interrupted-body recovery or physical erasure. API committed its preparation-only adapter cut at `7af374980`, consuming accepted `ef12a2d0` and the preserved handoff. Preparation acceptance and actual step landing still precede G-2364 and valid reconstruction. API already owns G-2205's exact candidate refusal; its log SHA-256 `5a0b2f956c149e8c1196552cd42c7e87bd8041641ae4520b08311bdd40eb0ba9` remains binding in the residual verdict. No accepted semantic qualification or campaign release follows |
| Access recovery classification | API retains sole review and landing ownership in G-2214. G-2205's attempt-2 evidence records accepted Access revision `e2a24d6427c6237683a8c203f241c5467e0d51f3` present at capture `cd490077773a4c1bae92a34535f1bbfecef74e8f`; no independent physical restore is proved |
| Erasure composition | API owns G-2223's fourth `mediaObjects` argument and real-composition Media regression. G-2205's same evidence records accepted composition revision `4aacb759395d48d9c7a80a08ba802cd68d1e4bf4` present at capture; no full physical erasure proof follows |

**Next action.** Decide G-2202 on its handoff. G-2203 is already closed verified;
do not land or close it again. G-2205's partial landing is acknowledged; do not
repeat it or close the task. Resume its original campaign only after API supplies
accepted G-2249 qualification and rules on its candidate facts. Preserve every
campaign assertion and both backups; no repeat build, pruning, native/API repair,
fixture-production change or compatibility weakening is authorized. Build and
each restore retain separate 600-second ceilings; admission waits are separate.

Program was sent the retained-manifest inventory: two surviving backups built
since 2026-10-06 (one small, one medium) are currently affected by inserted
predecessor migrations `194_payload_reference_index.sql` and
`883_source_author_name_position.sql`. Three shared manifests survive; these
snapshots establish neither historical event counts nor rebuild frequency.

G-2248's second partial landing is acknowledged; do not repeat it or close the
still-unproved task. Its resumed worker owns only the two sibling consumers;
it may not edit the shared fixture. Program's accepted admission-clock correction at `13436f6dc80b`
supersedes G-2248's and G-2287's time-based readings from the saturated
2026-10-13 22:31–23:04 UTC window. No timing-based budget or structural-cost
verdict survives; the observed verification timeout remains diagnostic only.
The one newly authorized retained-source completion run counts its limit from
admission, excludes queueing and records source preparation separately from
isolated consumer work under unchanged ceilings. Freeze the complete tree
before that admitted run. Record physical source key, manifest/backup paths,
producer revision/image, build/reuse counts, immutable custody digests before
and after disposal, source stability, assertions, timings and exact
fault/response/running/replay/release/final-erasure evidence. A subsequent owner
refusal is a partial handoff with the failing command and retained evidence;
no automatic repeat, timeout increase or assertion weakening is authorized.
API owns G-2367's
cause-preservation finding and will supply the accepted revision after landing;
borrowed-custody failures remain outside these claims and waive no gate.

G-2287 is cancelled into G-2248; do not restart or land it. Its preserved setup
correction is adopted and reviewed against the accepted API epoch contract in
G-2248. G-2366 is closed verified for landed mechanism support, with no
physical proof inferred from closure. G-2248 owns the first-adapter proof and
later production/completion obligations; only one completion qualification is
released now. The foreground Recipe callback adaptation remains a separate
consumer finding outside that run. G-2366 remains the single approved source
preparation mechanism shared with API; no second retention brief is needed.
Preserve both G-2205 backups outside bounded retention. No per-test ceiling or
assertion moves. Do not repeat the successful G-2366 landing or closure.

The accepted interface keys source-affecting digests and explicit inputs,
never commits; one builder per key, with a coded two-source retention bound.
Build once within 600 active seconds outside operation clocks. Verify all
immutable manifest-bound custody before consumption and after restore/disposal;
restore an isolated copy through the existing volume-copy tools without
producer or corpus-smoke reruns. Dispose through the lease handle, removing
only keyed producer resources. Preparation alone may rebuild refused custody;
selection and restore never produce or reseal.

G-2366's shared interface is bound to API's `retained-content-source-v1`
contract at `4bfe7ce57`: one main-selected public companion and one published,
publicly eligible Content variant, with approval relay/delivery drained and
the projection cursor at the Content cut. Declared producer inputs and
source-affecting digests determine the key; generated identities, epochs and
timings are manifest provenance. Bind graph/index backup, object evidence and
isolated-restorable Content/Access/Main relay owner state, including authority,
outbox, cursor/delivery positions, retained facts, byte digest and baseline
public answer. Valid, missing and ambiguous copies consume one valid source;
API keeps their assertions in the existing split qualifications. The old
Content backup `rezics-retained-d8dfd354-8cbc-41d3-a79c-63c687bf90bf` is partial
evidence and cannot be resealed or supplemented from former live state.
Preserve it and all existing Content/crash backups outside bounded retention.
The existing Program reading covers this interface; no second mechanism or
reading is needed. API's preparation-only cut at `7af374980` changes no
operations brief or worker action. It releases no physical campaign, native
repair, repeated consumer landing or semantic qualification; accepted
preparation and its actual step landing still precede reconstruction.

G-2266's accepted publication qualification remains a prerequisite, not physical
erasure or a scope promotion; closure belongs to API. Decide G-2269's original
setup separately. G-2248's original drill remains pending its accepted correction
and API revision `67988f2bf2c5896142a817efd3d2e1de66fc037f`; any next physical
qualification needs a separate decision on preparation and accepted
prerequisites. No stale publication admission, journal mutation, resealing,
retries or weakened assertions are authorized. D016's retained Content probe
and the original physical crash assertions remain unresolved by the title-only
verdict. Program reports preparation recovery is automatic from tool revision
`d22063edd`; report "is being prepared" lasting over five minutes as a fault.
This checkpoint changes only state, grants no new work or proof and requests no
additional Program ruling.

## Carried work

Carried from the trust-ops end-of-run table at
`archive/goals:program-2026-10-06/study-2026-10-12/`; unmerged commits are under
`refs/archive/2026-10-12/goal/<task>`. Each item becomes a drill written first,
or is dropped.

| Work | Where it stands | What is left |
| --- | --- | --- |
| Access recovery classification (`g-2025`) | 390 tables classed; G-2205 records accepted Access revision `e2a24d6427c6` at capture | API retains ownership; physical restore remains unproved |
| Erasure reconcile and operator step (`g-1793`) | Blocked on the row above; no commits | Start after it |
| Erasure proofs on live storage, backup and replay (`g-1794` to `g-1797`) | Test files written before the erasure core was on `main`; last runs red, not re-run. G-2205 records the accepted composition revision at capture | Rebase and run once each against accepted prerequisites; current fixture qualification remains pending |
| Independent physical restore (`g-1776`) | Both drills stop before child restore on "base Access row changed", the class the first row fixes | Rebase and run on the small fixture after the first row lands |
| Drill scheduling (`g-1775`) and the restore drill chain | One commit on a branch; three further steps were briefed and never started | Register the drills and run them serially |
| Physical erasure of a deleted person | The tombstone owner is on `main`; two native gaps are named expected failures (the SHA-256 form of an operation id, author-prefix entries on surviving Works); the candidate Java is on tag `g1980-java-image-d-candidate` | The native purge and its proof, inside the 30-day retention window |
| Release image | Governance imports the model registry at runtime; Dockerfile model-tree inclusion was not verified | G-2202 proves the payload and actual release image startup |

## From the regression of 2026-10-13

What the program's reading of the run on `main` d2a2e3166 gives this Goal for
its start (the second row confirms the release image's question above: the
packaged Main cannot load):

- D016, 4 files (task operations): Disposable physical-erasure Fuseki copies do not become ready; inspect their startup and retained command-module compatibility. Source: `tests/qa/fault-recovery/search-ops-support.ts`.
- D026, 3 files (task operations): Release payload omits model/compiler/registry.ts imported by governance/effects.ts; packaged Main cannot load. Source: `scripts/ops/release-payload.ts`.
- D075, 1 file (task operations): Search-generation fault drill loses its required Fuseki container before the explicit restart. Source: `tests/qa/fault-recovery/search-ops-support.ts`.
- D105, 1 file (self-caused): Focused Yarn dependency-fetch socket closed in owner-8 at 05:37:12–05:37:48 UTC while workers ran; the identical production image-context file passes alone in QA 20261013t122035-5d72f4. Source: `scripts/ops/release-images.ts`.
- D108, 1 file (task operations): Physical campaign fixture supplies incomplete readiness/compatibility evidence to restore qualification. Source: `tests/qa/fault-recovery/erasure-campaign-qualification.test.ts`.
- D109, 1 file (obsolete test): Physical restore test hardcodes an old derived Fuseki image hash rather than the selected content-addressed image; it fails before the drill starts. Changed promise: docs/development/toolchain.md:24–25: Fuseki tag is content-addressed, derived by scripts/dev/fuseki-image.ts. Source: `tests/qa/fault-recovery/comment-source-erasure.test.ts`.

## Notes

- A restore with live workers no longer conflicts on checkpoints, but a one-page
  index can answer 503 while startup healing runs. Seven findings on that code
  were listed and not fixed; two of them (a missing custody object, a weaker
  completion policy at Zone startup) are the likeliest to stop a drill.
- The backup is taken and restored through the existing tools only; a drill
  never repairs data by hand.
