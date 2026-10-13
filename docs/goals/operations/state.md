# State

The checkpoint for [this Goal](GOAL.md), recording decisions for
`start:961009ed-8838-4fb1-af46-04f649cb4562`,
`mail:e5a72312-a305-476b-b480-a6709559c8dc` and
`mail:40fb4148-0a07-41a7-b296-d94df3ce4daa` under
`checkpoint:ac46ef98-145e-4db4-b270-4fa7ba3e4884`.

| Field | State |
| --- | --- |
| Manager | Enrolled with the coordinator on 2026-10-13 15:34 UTC |
| Proved on physical fixtures | Nothing yet |
| Fixture | The small physical fixture `fx-small-a3a906c1c1b7`, built at `main` 1e05bf2d4 |
| Measures (`task goal -- status`) | First-attempt share 100% (2/2); no landed-task median yet; 2.3M input / 10.2k output tokens; tokens per proved row unavailable; no recorded refusals |

## Work in progress

| Work | Decision and next action |
| --- | --- |
| G-2202, release payload and image (D026) | Running, first attempt. Capture the missing-import failure, then prove packaged Main and actual local release-image startup with image identity and a healthy answer. An API failure after startup is a partial handoff |
| G-2203, disposable Fuseki support (D016, D075, D109) | Running, first attempt. Capture container logs and failing startup/restart, then prove readiness and explicit restart with the selected content-addressed image; keep erasure assertions intact |
| G-2205, campaign fixture evidence (D108) | Queued behind G-2203. Capture the actual readiness/compatibility mismatch on the retained small fixture and fix only fixture consumption. Missing producer evidence or API composition is a partial handoff |
| Access recovery classification | API owns the sole review and landing through `5bb07365f` in G-2214, including owner operations. The handled status mail reports admission refused pending Program's dated Design-note reading; API already requested that reading. No accepted landing revision is recorded |
| Erasure composition | API owns the composition area; the handled owner queries found no live file claimant. API was sent the archived G-2062 Outcome item 4 source and real-composition Media case: the production constructor must receive `mediaObjects`. This was never implemented in the archived run; no accepted revision is recorded |

**Next action.** Decide G-2202 and G-2203 on their handoffs; G-2205 follows
G-2203. Independent physical restore and scheduling start only from API's
actual accepted Access main revision. Full erasure proofs also require API's
separate accepted composition revision. API retains both notifications;
operations creates no competing adoption or review. This checkpoint grants no
new worker work or proof. The measured first-attempt share does not trigger
the below-half dispatch stop.

## Carried work

Carried from the trust-ops end-of-run table at
`archive/goals:program-2026-10-06/study-2026-10-12/`; unmerged commits are under
`refs/archive/2026-10-12/goal/<task>`. Each item becomes a drill written first,
or is dropped.

| Work | Where it stands | What is left |
| --- | --- | --- |
| Access recovery classification (`g-2025`) | 390 tables classed; last review predates two reported fix rounds | API's G-2214 reviews and lands; wait for its accepted revision |
| Erasure reconcile and operator step (`g-1793`) | Blocked on the row above; no commits | Start after it |
| Erasure proofs on live storage, backup and replay (`g-1794` to `g-1797`) | Test files written before the erasure core was on `main`; last runs red, not re-run | Rebase and run once each; they also wait for the erasure service's composition hunk in the [api](../api/state.md) Goal |
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
