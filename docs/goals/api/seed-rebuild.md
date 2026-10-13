# Retained population checkpoint rebuild

The 2026-10-13 rebuild remains blocked before a fresh retained checkpoint.
The final fix round accepts fixture-authorized canonical manifest storage and
preserves the Zone helper repair. The builder now reaches backup, where the
backup writer refuses the canonical directory. This preparation gates growth
checks only; it gates no API outcome row.

## Fix round 2: backup writer boundary refusal (final)

Source commit: `cf6291ff94fb056072d0d6a88f1181ecbcf98c0e`. Both QA runs
reported source stable. The manifest directory guard now derives its retained
store from the existing `fixtureRoot` authority, accepting that configured
`work-profiles` store across worktrees. Its unit proof rejects unrelated paths,
traversal escapes and sibling-prefix paths for checkout, `/tmp` and retained
storage, and verifies that a fixture override replaces the shared authority.
The existing population, compatibility, restore and timing assertions and the
Zone configuration helper are unchanged.

Both commands ran separately, build first, with
`REZICS_FIXTURE_ROOT=/home/edge/projects/rezics/rezics-next/.temp/fixture` and
`REZICS_QA_ARTIFACT_ROOT="$PWD/.temp/qa"`, where `$PWD` is this worktree:

| Operation | Command | QA run / project | Result |
| --- | --- | --- | --- |
| Build | `bun scripts/goal/goalctl.ts test tests/qa/fault-recovery/work-profile-seed-build.test.ts` | `20261013t052525-0c67d2` / `20261013t052525-0c67d2-f1` | Failed at the backup writer after population verification |
| Restore | `bun scripts/goal/goalctl.ts test tests/qa/integration/work-profile-seed-checkpoints.test.ts` | `20261013t052721-342c59` / `20261013t052721-342c59-1` | Refused old retained compatibility before restore |

Build fails at `scripts/load/catalogue-backup.ts:37` with
`Catalogue backups must stay in this checkout .temp`. The call chain is
`prepareWorkProfileCorpus` → `createCorpusBackupDriver.backup` →
`retainStoppedOwnerBackup` → `privateDirectory`. That guard accepts only
checkout-local `.temp` destinations; the configured destination is under
`/home/edge/projects/rezics/rezics-next/.temp/work-profiles/seed-checkpoints/20261013t052525-0c67d2-f1/backups/`.
The manifest guard and Zone home publication no longer refuse this run.
Population verification completes before this backup call, but no cut is
retained and no completed stage timing is emitted. The new run directory
contains only an empty `manifests/` directory; no manifest or backup file was
produced, and the existing `retained.json` still names its older source run.

| Cut | Build result | Startup / build / backup / total stage timings |
| --- | --- | --- |
| 4 Works (`small`) | Failed at backup directory validation | Not emitted; test body failed after 47.871406 s |
| 16 Works (`medium`) | Not reached | Not measured |
| 64 Works (`large`) | Not reached | Not measured |

The build shard took 48.100753461 s. These are failure durations, not completed
startup-inclusive stage timings; the three 600-second cut budgets remain
unproved.

Restore reads canonical `retained.json`, source run
`20261012t075323-befbaf-f1`. Its actual manifest files still exist, relative to
`/home/edge/projects/rezics/rezics-next/.temp/work-profiles/seed-checkpoints/`:

- `20261012t075323-befbaf-f1/manifests/work-profile-b4c931e2c592dfc0.json` (4 Works).
- `20261012t075323-befbaf-f1/manifests/work-profile-a5c8fd99b1e0dae0.json` (16 Works).
- `20261012t075323-befbaf-f1/manifests/work-profile-d03a2add833ca7e7.json` (64 Works).

Each retains digest
`2267b93e67353a81bda9db726207ed775a2f3c71be0d955267f1dc78c982613c`;
current compatibility is
`8408eeb6f7a9e456f1b59bceb751198d8aa1befb7e7b95d96bb3d6a16316a4f4`.
The existing `compatibleLoadStorage` returns false for every cut. Differences
remain in the generated model manifest, Compose and Content, Access and Relay
migrations. The full comparison and manifest existence checks are in
`.temp/goal/seed-compatibility-fix-2.json`. Restore fails at
`scripts/load/work-profile-corpus.ts:397` with
`Corpus storage/model compatibility changed`; no compatibility refusal was
bypassed. Its test body took 5.458436 s and its shard 5.703778002 s. Restore
evidence is `[]`: no copy, isolated write or completed restore timing was
proved.

Evidence relative to this worktree:

- `.temp/goal/seed-build-fix-2.log` and `.temp/goal/seed-restore-fix-2.log`.
- `.temp/qa/20261013t052525-0c67d2/summary.md`,
  `shards/fault-recovery-f1.xml` and `logs/fault-recovery-f1.log` within that run.
- `.temp/qa/20261013t052721-342c59/summary.md`,
  `shards/integration-1.xml` and `logs/integration-1.log` within that run.
- `.temp/work-profile-seed-restores-20261013t052721-342c59-1.json`.

Scoped unit command:
`bun scripts/goal/goalctl.ts test tests/qa/unit/g-1024-corpus.test.ts -t 'corpus|retained population|preparation'`.
It passed six tests with 157 assertions, including the manifest boundary,
population cuts, build reuse, compatibility, isolated restore and preparation
deadline proofs. Four other tests were filtered out; the unrelated plan-path
test creates files in the home directory, outside this worker's write scope.
`task scripts:typecheck`, type-aware oxlint on both changed files and
`task ast-grep -- scan scripts/load/work-profile-corpus.ts tests/qa/unit/g-1024-corpus.test.ts`
passed. The affected plan is `.temp/goal/seed-affected-fix-2.log`; its remaining
unit, owner and integration files belong to the manager's regression run.
`task docs:check` and the single `task guards` run passed; their logs are
`.temp/goal/seed-docs-check-fix-2.log` and `.temp/goal/seed-guards-fix-2.log`.

Next: manager decision after the final fix round. The remaining refusal belongs
to the canonical backup destination boundary in `catalogue-backup.ts`, outside
this claim. Either assign that owner a repair under the existing fixture-root
authority or run the committed changes from main after landing. Then build
alone and restore alone with canonical retained storage. No additional repair
round, product change, policy weakening, temporary copy or whole tier was run.

## Fix round 1: canonical storage refusal (historical)

Source commit: `8ba330d0c0b3388017b43274c63fa9644b9a1fd9`. Both QA runs
reported source stable. The helper now prepares the Zone home document through
`PUT /v1/zones/{id}/configuration`, reads its identity through `GET` on that
operation, saves the variant on that document, and retains the same page ID
for publication. The defect class was a mismatch between configured document,
draft resource and published page; both mismatched helper sites were repaired.
Product code, population and restore assertions, generators, compatibility
policy and product policy are unchanged. The new helper flow has not yet run
in a completed build because the earlier storage guard refuses its directory.

The following commands ran separately, build first, with
`REZICS_FIXTURE_ROOT=/home/edge/projects/rezics/rezics-next/.temp/fixture` and
`REZICS_QA_ARTIFACT_ROOT="$PWD/.temp/qa"`, where `$PWD` is this worktree:

| Operation | Command | QA run / project | Result |
| --- | --- | --- | --- |
| Build | `bun scripts/goal/goalctl.ts test tests/qa/fault-recovery/work-profile-seed-build.test.ts` | `20261013t045755-e14406` / `20261013t045755-e14406-f1` | Failed before population initialization |
| Restore | `bun scripts/goal/goalctl.ts test tests/qa/integration/work-profile-seed-checkpoints.test.ts` | `20261013t045931-7ff9b8` / `20261013t045931-7ff9b8-1` | Refused old retained compatibility before restore |

Build fails at `scripts/load/work-profile-corpus.ts:290` with
`Corpus manifests must stay in this checkout or /tmp`. Its guard accepts only
directories inside the executing checkout or `/tmp`, while the required
manifest directory is canonical git-common storage:
`/home/edge/projects/rezics/rezics-next/.temp/work-profiles/seed-checkpoints/20261013t045755-e14406-f1/manifests/`.
The guard runs before `recipe.build`; no fresh manifest, backup or retained
index was produced. The test body took 11.487689 s and its shard 11.659418022 s.
These are failure durations, not completed startup-inclusive stage timings.
All three new cuts (4, 16, 64 Works) remain unproved.

Restore reads the existing canonical `retained.json`, source run
`20261012t075323-befbaf-f1`. Its three actual manifest files, relative to
`/home/edge/projects/rezics/rezics-next/.temp/work-profiles/seed-checkpoints/`,
are:

- `20261012t075323-befbaf-f1/manifests/work-profile-b4c931e2c592dfc0.json` (4 Works).
- `20261012t075323-befbaf-f1/manifests/work-profile-a5c8fd99b1e0dae0.json` (16 Works).
- `20261012t075323-befbaf-f1/manifests/work-profile-d03a2add833ca7e7.json` (64 Works).

All three retain compatibility digest
`2267b93e67353a81bda9db726207ed775a2f3c71be0d955267f1dc78c982613c`;
the current digest is
`8408eeb6f7a9e456f1b59bceb751198d8aa1befb7e7b95d96bb3d6a16316a4f4`.
The existing `compatibleLoadStorage` returns false for every cut. Differences
include the generated model manifest, Compose definition and Content, Access
and Relay migrations; the full per-cut comparison is retained in
`.temp/goal/seed-compatibility-fix-1.json`. Restore fails at
`scripts/load/work-profile-corpus.ts:391` with
`Corpus storage/model compatibility changed`. The test body took 7.999634 s
and its shard 8.254642983 s. No copy, isolated write or restore timing was
proved; the refusal was preserved.

Evidence relative to this worktree:

- `.temp/goal/seed-build-fix-1.log` and `.temp/goal/seed-restore-fix-1.log`.
- `.temp/qa/20261013t045755-e14406/summary.md`,
  `shards/fault-recovery-f1.xml` and `logs/fault-recovery-f1.log` within that run.
- `.temp/qa/20261013t045931-7ff9b8/summary.md`,
  `shards/integration-1.xml` and `logs/integration-1.log` within that run.

Scoped checks passed: `task scripts:typecheck`, type-aware oxlint on the
changed helper, and `task ast-grep -- scan tests/qa/support/seed-checkpoint-population.ts`.
`task docs:check` and the single `task guards` run also passed; their logs are
`.temp/goal/seed-docs-check-fix-1.log` and `.temp/goal/seed-guards-fix-1.log`.
The affected plan also names seed-checkpoints and zone-navigation-growth unit
tests, and library-growth, recipe-page-growth, search-ranked-growth and
zone-navigation-growth integration tests; these belong to the manager's
regression run, not this rebuild.

Next: assign the canonical manifest-directory guard to its owner, or run this
committed repair from the main checkout after landing. Then rerun build alone
and restore alone using the canonical fixture root. Changing
`scripts/load/work-profile-corpus.ts` is outside this helper-only fix claim;
neither a worktree-local substitute nor `/tmp` would satisfy retained storage.

## Initial attempt (historical)

### Source and run

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

### Failure

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

### Checkpoints and timings

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

### Next action at the initial handoff

Assign a separate builder repair to satisfy the existing Zone home-document
publication precondition through its API. Then rerun the build alone and the
checkpoint restore check alone, retaining the existing assertions and
600-second stage limits. This worktree's local evidence and backup directory
must be preserved or explicitly selected by that follow-up; they are not
shared retained storage.
