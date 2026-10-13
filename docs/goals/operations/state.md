# State

The checkpoint for [this Goal](GOAL.md). Not started; written on 2026-10-12 from
the trust-ops manager's end-of-run table, archived at
`archive/goals:program-2026-10-06/study-2026-10-12/`.

| Field | State (2026-10-12) |
| --- | --- |
| Manager | None. The program starts one when the erasure and recovery contracts are stable |
| Proved on physical fixtures | Nothing yet |
| Fixture | The small physical fixture `fx-small-a3a906c1c1b7`, built at `main` 1e05bf2d4 |

## Carried work

Unmerged work is kept as commits under `refs/archive/2026-10-12/goal/<task>`.
Each item becomes a drill written first, or is dropped.

| Work | Where it stands | What is left |
| --- | --- | --- |
| Access recovery classification (`g-2025`) | 390 tables classed; the last review (four P1, sixteen P2) predates two further rounds that report every finding fixed; no review ran after them | Review and land; then let journal-bound custody transitions compare as base plus authenticated transition. This gates everything below |
| Erasure reconcile and operator step (`g-1793`) | Blocked on the row above; no commits | Start after it |
| Erasure proofs on live storage, backup and replay (`g-1794` to `g-1797`) | Test files written before the erasure core was on `main`; last runs red, not re-run | Rebase and run once each; they also wait for the erasure service's composition hunk in the [api](../api/state.md) Goal |
| Independent physical restore (`g-1776`) | Both drills stop before child restore on "base Access row changed", the class the first row fixes | Rebase and run on the small fixture after the first row lands |
| Drill scheduling (`g-1775`) and the restore drill chain | One commit on a branch; three further steps were briefed and never started | Register the drills and run them serially |
| Physical erasure of a deleted person | The tombstone owner is on `main`; two native gaps are named expected failures (the SHA-256 form of an operation id, author-prefix entries on surviving Works); the candidate Java is on tag `g1980-java-image-d-candidate` | The native purge and its proof, inside the 30-day retention window |
| Release image | Governance imports the model registry at runtime; whether `infra/release/Dockerfile` copies the model tree was raised in a review and not verified | Build the release image and start Main from it |

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
