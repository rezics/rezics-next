# State

The checkpoint for [this Goal](GOAL.md), recording
`task:G-2248:1`, `mail:ac913b39-fba8-4233-9cb2-d4e7ef25ca38`,
`mail:d1d60776-b542-4e07-b4ba-2074ca5e0cec`, `task:G-2205:2`,
`mail:c4ca5d84-4d5d-43d0-88b3-d79453c95160` and
`mail:ac7e07a4-2e3c-4ee4-972a-5ac0bd33b564` under
`checkpoint:f9388543-98b7-48a7-a00e-ebbcd6507c22`, carrying forward the
previous checkpoint's decisions. All four listed mail deliveries are acknowledged.

| Field | State |
| --- | --- |
| Manager | Enrolled with the coordinator on 2026-10-13 15:34 UTC |
| Proved on physical fixtures | Nothing yet |
| Fixture | G-2205 prepares the current small generation once through existing tools, then retains its backup; qualification is pending. Program observed `fx-small-180553eb933a` as current at 18:55 UTC; this is provenance, not a fixed id. The superseded `fx-small-a3a906c1c1b7` stays until the new backup qualifies |
| Measures (`task goal -- status`) | Refreshed reading: first-attempt share 80% (4/5); attempts per landed task median 1, max 1 (G-2248); 16.5M input / 60.4k output tokens; tokens per proved row unavailable; no recorded refusals. No below-half dispatch stop is triggered |

## Work in progress

| Work | Decision and next action |
| --- | --- |
| G-2202, release payload and image (D026) | Running, first attempt. Capture the missing-import failure, then prove packaged Main and actual local release-image startup with image identity and a healthy answer. An API failure after startup is a partial handoff |
| G-2203, disposable Fuseki support (D016, D075, D109) | Program reports the support step accepted on main at `2502fc2597a7` (three files), task closed verified and claims released. Selected image, killed-container restart and bounded redacted readiness logs are landed support; physical checks remain red. Program already mailed API the revision |
| G-2205, campaign fixture evidence (D108) | Attempt 2 captured a correct compatibility refusal before copy/readiness: changed used model inputs and inserted Content migration `194_payload_reference_index.sql` supersede the backup. No D108 consumer defect or qualification is proved. Program's ruling supersedes the support-owner prerequisite; brief committed at `ba6eb1fa4`, worker resumed as attempt 3 to build the current small generation once and capture authentic evidence. Build and each restore have separate 600-second ceilings |
| G-2248, copied PostgreSQL startup | Partial support accepted and `land --step` succeeded at `01c3c623b1a0efc53ef0e95a0c7cfc4b5a22fd6b`. The primary's command-line `max_locks_per_transaction=256` was absent from backup configuration; the copy defaulted to 64. Capturing and applying the primary value repairs copied startup, with retained redacted diagnostics. QA reaches restore admission after 179.703 s preparation, then fails on retained-coverage journal epoch after 111 assertions. Keep open; no further worker work until API's accepted prerequisite and G-2269's accepted setup correction |
| G-2269, original source-erasure newer-head setup | Operations is the sole setup editing owner; brief committed at `52ba9b3fb` and queued until API's focused real-PostgreSQL regression is on accepted main. API confirmed ownership and will supply accepted revision, capture identities and journal epochs. Preserve the actual newer-head held restore scenario and every final outcome assertion; G-2248's fixture is read-only |
| G-2249, retained Content and crash-fence qualification | API owns two separate probes with current assertions intact. The qualification brief proves neither contract. G-2203's support baseline is now accepted and Program has sent API the revision; operations need not relay it. No probe result or accepted API revision is recorded here |
| Access recovery classification | API retains sole review and landing ownership in G-2214. G-2205's attempt-2 evidence records accepted Access revision `e2a24d6427c6237683a8c203f241c5467e0d51f3` present at capture `cd490077773a4c1bae92a34535f1bbfecef74e8f`; no independent physical restore is proved |
| Erasure composition | API owns G-2223's fourth `mediaObjects` argument and real-composition Media regression. G-2205's same evidence records accepted composition revision `4aacb759395d48d9c7a80a08ba802cd68d1e4bf4` present at capture; no full physical erasure proof follows |

**Next action.** Decide G-2202 on its handoff. G-2203 is already closed verified;
do not land or close it again. Decide G-2205's resumed handoff on authentic
current-generation evidence, build and restore seconds, fixture identity and
evidence path. A build over 600 seconds is a partial setup failure, not a longer
budget. Before pruning, its worker reports to Program the supported count of
small or medium backups superseded by inserted migrations since 2026-10-06,
or the retained manifests' limits. No hand rebuilding, larger corpus, data repair
or compatibility weakening is authorized.

G-2248's successful support landing is acknowledged; do not repeat it or close
the still-unproved task. API's G-2266 owns the retained journal epoch prerequisite
and remains read-only on the original test and fixture. G-2269 starts only after
the accepted focused regression and qualified setup findings; after its setup
correction is accepted, resume G-2248 for the original physical drill. No stale
coverage admission, journal mutation, false resealing, retries or weakened
assertions are authorized. A fixture prerequisite is handed off separately.
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
