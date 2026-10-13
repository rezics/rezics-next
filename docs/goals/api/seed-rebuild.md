# Retained population checkpoint rebuild

The 2026-10-13 rebuild is blocked before the first retained checkpoint. This
preparation gates growth checks only; it gates no API outcome row.

## Source and run

- Source commit: `4d8d4fdd71051b06a6fd45d6a68a73cd5d777552`, committed main
  at worker startup; the worktree was clean and QA reported source stable.
- Build QA run: `20261013t043735-74bf49`; source project:
  `20261013t043735-74bf49-f1`.
- Build command: `bun scripts/goal/goalctl.ts test tests/qa/fault-recovery/work-profile-seed-build.test.ts`.
- Environment overrides: `REZICS_FIXTURE_ROOT="$PWD/.temp/fixture"` and
  `REZICS_QA_ARTIFACT_ROOT="$PWD/.temp/qa"`, with `$PWD` set to the worker
  worktree. These use the existing directory overrides to retain all files
  inside the authorized write boundary.
- Evidence, relative to this worktree:
  `.temp/qa/20261013t043735-74bf49/summary.md`,
  `.temp/qa/20261013t043735-74bf49/shards/fault-recovery-f1.xml`,
  `.temp/qa/20261013t043735-74bf49/logs/fault-recovery-f1.log` and
  `.temp/goal/seed-build.log`.

## Failure

The initial `small` stage failed on command
`checkpoint:site-publication:4:4`, issuing
`POST /v1/zones/d7209ea3-ce07-8ff7-bb0b-50edcfc3e105/site-publications`.
The response was HTTP 400, code `invalid_zone_configuration`, with the title
“Every home variant must belong to the Zone home document”.

The [population setup](../../../tests/qa/support/seed-checkpoint-population.ts)
creates a content draft with the Zone as its resource, then
`growSeedCheckpointPopulation` publishes that draft as the home page without
configuring a Zone home document. The
[publication validator](../../../services/main/src/modules/zone/configuration.ts)
rejects a publication when `head.homeDocument` is absent or any published page
differs from it. This is a builder precondition mismatch, not a preparation
timeout or a storage compatibility refusal. The same growth helper serves all
three cuts, so later cuts share this precondition.

Product code, generators, compatibility policy, population axes and test
assertions were not changed. No refusal was bypassed.

## Checkpoints and timings

| Cut | Build result | Startup / build / backup / total stage timings |
| --- | --- | --- |
| 4 Works (`small`) | Failed before backup | Not emitted; test body failed after 47.885897 s |
| 16 Works (`medium`) | Not reached | Not measured |
| 64 Works (`large`) | Not reached | Not measured |

The fault/recovery shard took 48.04464441 s (QA summary rounds to 48.1 s).
These durations do not prove a completed stage's startup-inclusive 600-second
budget. No complete stage timing record was produced.

The intended retained index is
`.temp/work-profiles/seed-checkpoints/retained.json`; per-cut manifests would
be under
`.temp/work-profiles/seed-checkpoints/20261013t043735-74bf49-f1/manifests/`.
Neither the retained index nor any per-cut manifest or stopped backup was
produced. Consequently there is no retained compatibility digest to compare.

Restore run ID: none. The dependent command
`bun scripts/goal/goalctl.ts test tests/qa/integration/work-profile-seed-checkpoints.test.ts`
was not run because the build produced no checkpoint. Exact retained
populations, identities, restore timings and isolated writes remain unproved.

## Next action

Assign a separate builder repair to satisfy the existing Zone home-document
publication precondition through its API. Then rerun the build alone and the
checkpoint restore check alone, retaining the existing assertions and
600-second stage limits. This worktree's local evidence and backup directory
must be preserved or explicitly selected by that follow-up; they are not
shared retained storage.
