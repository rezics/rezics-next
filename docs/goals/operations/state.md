# State

The checkpoint for [this Goal](GOAL.md), recording
`task:G-2205:3`, `mail:851e00f8-1995-47d5-9a39-aa047b61d6a9`,
`mail:e45675de-dab1-4513-865f-06a002505ae5` and
`mail:76b32f0a-620e-4a0f-b15e-76e4a0f39785` under
`checkpoint:5e268dbb-1498-4d16-9444-ef7473aac98e`, carrying forward the
previous checkpoint's decisions. All three listed mail deliveries are acknowledged.

| Field | State |
| --- | --- |
| Manager | Enrolled with the coordinator on 2026-10-13 15:34 UTC |
| Proved on physical fixtures | D108 restore consumption qualifies in two post-fix restores; no physical erasure row or OPS10 pass is proved |
| Fixture | Current small `fx-small-180553eb933a` built once in 154.817 active seconds; post-fix restores qualify in 37.620 and 65.559 active seconds. Both it and superseded `fx-small-a3a906c1c1b7` remain retained; no pruning or repeat build is authorized |
| Measures (`task goal -- status`) | Refreshed operations reading: first-attempt share 83% (5/6); attempts per landed task median 1, max 3 (G-2205); 23.5M input / 85.3k output tokens; tokens per proved row unavailable; no recorded refusals. No below-half dispatch stop is triggered |

## Work in progress

| Work | Decision and next action |
| --- | --- |
| G-2202, release payload and image (D026) | Running, first attempt. Capture the missing-import failure, then prove packaged Main and actual local release-image startup with image identity and a healthy answer. An API failure after startup is a partial handoff |
| G-2203, disposable Fuseki support (D016, D075, D109) | Program reports the support step accepted on main at `2502fc2597a7` (three files), task closed verified and claims released. Selected image, killed-container restart and bounded redacted readiness logs are landed support; physical checks remain red. Program already mailed API the revision |
| G-2205, campaign fixture evidence (D108) | Attempt 3 consumer fix `ff6c24d890d58d1cb29234d6b8b7425fc6adaaf3` accepted as partial support; `land --step` succeeded, on main as `ef88de57e`. It admits only the authenticated initial model-bootstrap sequence advance and accounts for `align-model`. Static gates and 18 supporting tests pass; both post-fix restores qualify. Physical campaign remains red at candidate startup: `Content source field missing or ambiguous: field`. Keep open pending API's accepted G-2249 qualification and exact verdict; no worker resume now. Evidence: `.temp/worktrees/g-2205/.temp/goal/d108-evidence-inventory.json` |
| G-2248, copied PostgreSQL startup | Partial support accepted and `land --step` succeeded at `01c3c623b1a0efc53ef0e95a0c7cfc4b5a22fd6b`. The primary's command-line `max_locks_per_transaction=256` was absent from backup configuration; the copy defaulted to 64. Capturing and applying the primary value repairs copied startup, with retained redacted diagnostics. QA reaches restore admission after 179.703 s preparation, then fails on retained-coverage journal epoch after 111 assertions. Keep open; no further worker work until API's accepted prerequisite and G-2269's accepted setup correction |
| G-2269, original source-erasure newer-head setup | Already running at the epoch-prerequisite decision; sole editor of the original comment-source-erasure test. API's G-2266 qualification is accepted on main at `67988f2bf2c5896142a817efd3d2e1de66fc037f`: real PostgreSQL, 41 assertions, 58.252 seconds active preparation, full check passed; service unchanged. Matching epochs publish; transactional historical supersession rolls back; stale NULL-to-1 and 1-to-2 captures refuse unchanged. No setup acceptance or physical pass is recorded by these events |
| G-2287, sibling newer-head setups | Brief committed at `1280f5d98` and dispatched for completion/production siblings after the accepted G-2266 qualification. Correct historical stale-capture setup through authenticated coverage and existing `copy.faultRetained`; preserve the actual newer-head restore refusal, journal, epoch fence, all final outcomes and budgets. No shared mechanism or service repair is authorized |
| G-2249, retained Content and crash-fence qualification | API's existing retained-source qualification is running; G-2205's candidate refusal and matching log hash are carried into its retained-source and missing/ambiguous-source probes. The exception alone classifies neither a fixture nor a native defect. No completed qualification or accepted API revision is supplied; API will notify operations with revision, verdict, QA identities and evidence. Crash-fence remains a separate probe |
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

G-2248's successful support landing is acknowledged; do not repeat it or close
the still-unproved task. G-2266's accepted publication qualification is a
prerequisite, not physical erasure or a scope promotion; its closure belongs to
API and no further worker work is authorized. Decide G-2269's original setup and
G-2287's sibling handoffs separately; resume G-2248 for the original physical
drill only after G-2269's correction is accepted, consuming the accepted API
revision above. No stale publication admission, journal mutation, resealing,
retries or weakened assertions are authorized. Selected history and
borrowed-custody failures remain outside these claims and waive no gate.
D016's retained Content and crash-fence questions remain API's separate probes.
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
