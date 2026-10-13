# State

The checkpoint for [this Goal](GOAL.md), recording `task:G-2248:3`,
`mail:92b643a6-3f0e-47e8-a248-f1c9460a43eb`,
`mail:89fd3025-f03d-4f7c-b1e8-b81b7b60db78`, `task:G-2287:3`,
`mail:eac2fe19-4122-4883-b505-a9b196f7275a`,
`mail:5bf10cd0-5bf1-40e1-92e8-564e8c23a8e0`,
`mail:d0fb5521-54d2-4e9d-be21-cd94797bcf8b` and
`mail:6dd0658d-6144-43e2-bb0e-a9eb46488a2f` under
`checkpoint:577f3e97-f595-435b-a17f-b3f1201a6234`, carrying forward the
previous checkpoint's decisions. All six listed mail deliveries are acknowledged.

| Field | State |
| --- | --- |
| Manager | Enrolled with the coordinator on 2026-10-13 15:34 UTC |
| Proved on physical fixtures | D108 restore consumption qualifies in two post-fix restores; no physical erasure row or OPS10 pass is proved |
| Fixture | Current small `fx-small-180553eb933a` built once in 154.817 active seconds; post-fix restores qualify in 37.620 and 65.559 active seconds. Both it and superseded `fx-small-a3a906c1c1b7` remain retained; no pruning or repeat build is authorized |
| Measures (`task goal -- status`) | Last available operations reading: first-attempt share 75% (6/8); attempts per landed task median 1, max 3 (G-2248); 42.7M input / 168.7k output tokens; tokens per proved row unavailable; no recorded refusals. Status was reread at this checkpoint, but an updated operations measure was unavailable; these are carried figures, not a fresh efficiency verdict. No new physical row is proved |

## Work in progress

| Work | Decision and next action |
| --- | --- |
| G-2202, release payload and image (D026) | Running, first attempt. Capture the missing-import failure, then prove packaged Main and actual local release-image startup with image identity and a healthy answer. An API failure after startup is a partial handoff |
| G-2203, disposable Fuseki support (D016, D075, D109) | Program reports the support step accepted on main at `2502fc2597a7` (three files), task closed verified and claims released. Selected image, killed-container restart and bounded redacted readiness logs are landed support; physical checks remain red. Program already mailed API the revision |
| G-2205, campaign fixture evidence (D108) | Attempt 3 consumer fix `ff6c24d890d58d1cb29234d6b8b7425fc6adaaf3` accepted as partial support; `land --step` succeeded, on main as `ef88de57e`. It admits only the authenticated initial model-bootstrap sequence advance and accounts for `align-model`. Static gates and 18 supporting tests pass; both post-fix restores qualify. Physical campaign remains red at candidate startup: `Content source field missing or ambiguous: field`. Keep open pending API's accepted G-2249 qualification and exact verdict; no worker resume now. Evidence: `.temp/worktrees/g-2205/.temp/goal/d108-evidence-inventory.json` |
| G-2248, copied PostgreSQL startup and shared lost-outcome helper | Startup support remains landed at `01c3c623b1a0efc53ef0e95a0c7cfc4b5a22fd6b`. Accepted helper support landed at `3a9662260de1ea1da8b5dc89e2203c0f661d782f`: lost outer outcome injects `08007`, deferred Access unavailable write uses `55P03`, with assertions and fences preserved. Source-stable completion QA `20261013t223605-88996b` stopped at the existing 15-second `pg_verifybackup` limit before any candidate or fault: 22 assertions, preparation failed at 198.100 s, disposal at 206.925 s, admission wait 411.225 s separately. Four fixture unit files pass (9 tests, 65 assertions); no fault behavior or physical outcome is proved. Keep open, with no resume or repeated landing; fixture editing is released to G-2366. Original rerun still needs G-2269's accepted setup and the accepted API prerequisite |
| G-2269, original source-erasure newer-head setup | Already running at the epoch-prerequisite decision; sole editor of the original comment-source-erasure test. API's G-2266 qualification is accepted on main at `67988f2bf2c5896142a817efd3d2e1de66fc037f`: real PostgreSQL, 41 assertions, 58.252 seconds active preparation, full check passed; service unchanged. Matching epochs publish; transactional historical supersession rolls back; stale NULL-to-1 and 1-to-2 captures refuse unchanged. No setup acceptance or physical pass is recorded by these events |
| G-2287, sibling newer-head setups | Handoff remains pending; no landing accepted. Correction `cfb0f308b553bbd68b7ac23431cfa95a668c221d` follows the historical fault contract. Attempt 3's source-stable production measurement exhausted the ceiling at 364.964 active seconds (Program's rounded reading 365.0); it does not requalify the file. Source construction took 178.8 s; operations 1 and 2 took about 45 and 109 s, and operation 3 was unfinished at 346 s. Host load reached 93 after seven stacks started, but preparation cost is structural. No further unchanged run, resume or landing; await accepted G-2366 retention support and G-2248 helper support for later committed-tree qualification |
| G-2366, shared retained-source preparation | Sole retention mechanism for operations and API; Program's dated design reading and four conditions are committed and the amended brief was requeued. Key source-affecting input digests, never commits; one builder per key; coded bounded retention with failed-manifest removal and preparation rebuild; reuse `scripts/fixture/` copy/layout/manifest with per-file hashes, RDF digest and owner-state descriptor. Owner-erasure is the first adapter and proof; API's Content producer is the second adapter. Build once within 600 active seconds outside operation clocks; each consumer first verifies the manifest, then restores an isolated copy without producer or corpus-smoke reruns. G-2248's fixture claim is released; respect G-2281's landing-owned harness claim until Program releases it |
| G-2367, history-reader cause preservation | API committed and invoked dispatch of the bounded repair for the guard failure at `services/main/src/modules/work/history.ts:134`. Preserve `RevisionReadBudgetExceeded`, message, budgets, abort precedence and refusal meaning; require exact-cause regression and unchanged restore-closure guard. Await API's accepted-main notification; no classifier change, gate waiver, expensive restore run or physical proof follows |
| G-2249, retained Content and crash-fence qualification | API's isolated title-only crash qualification remains landed at `fe7e0002fd0a0cda0e15b029ae641036efa85d9e`: source-stable QA `20261013t215346-33fc0f`, 22 assertions, 121764 ms. It proves neither interrupted-body recovery nor physical erasure. API was directed to the sole G-2366 mechanism for stopped-source integrity metadata and isolated restore; its Content adapter step 1 starts only after G-2366 merges and Program mails API the accepted commit. No accepted retained reconstruction or missing/ambiguous-source verdict binds G-2205's candidate facts yet; D016 and campaign prerequisites remain unresolved |
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
still-unproved task. Its fixture claim is lent to G-2366, with no concurrent
fixture edits. Program attributed the verification timeout to host saturation
from 22:31 to 23:04 UTC and restored the load gate; this changes no timeout or
qualification verdict. No extra expensive run is authorized. API owns G-2367's
cause-preservation finding and will supply the accepted revision after landing;
borrowed-custody failures remain outside these claims and waive no gate.

G-2287's final measurement was reported and decided; no further unchanged run,
worker resume or landing is authorized. G-2366 is the single approved source
preparation mechanism, shared with API. Preserve G-2281's harness claim until
Program releases it. Its owner-erasure adapter must prove reuse, manifest
integrity and isolated restore before later production/completion qualification;
the API adapter starts on Program's accepted-commit notification. No second
retention brief is needed. Preserve both G-2205 backups outside the new
mechanism's bounded retention policy. No per-test ceiling or assertion moves.

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
