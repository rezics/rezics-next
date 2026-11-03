# Realm presentation claim growth binding

## Contract and source binding

This acceptance binds the Realm presentation media cost in [Content](../../services/kernel/src/content/README.md#realm-presentation-media) to the native `PATCH /v1/realms/:id` command. The inspected source revision is `c968558f1f20e21ca88ac8e7b26754a3fd642d7a` on `worker/d643d6da-0252-431e-9c28-6e8daa2cba9b`. The command enters through the real HTTP handler, production `Access` factory, current Realm management authority and head/revision compare-and-swap, then its registered media-claim effect. No standalone claim route or generic command substitute is involved.

The selected assets are uploaded through native reserve and completion requests, then published by `createImageJob.process`. A successful setup asserts that each selected row is available, has image variants, and remains unclaimed until the measured settings update. Each upload uses fixed image bytes. Setup also creates a decoy Realm and selected assets used only for check-growth warmup.

## Measured cases

The unrelated-population series runs independent 0-, 1-, and 2-slot cases at scales 256, 1024, and 4096. The target Realm, selected asset ids, request shape, partition, asset byte count, and change count stay fixed within each case. Each scale adds that many unrelated Realm revisions and available media rows. A new command is prepared from the actual current head at each point and measured through the native PATCH. The expected permanent media update counts are respectively 0, 1, and 2. A further observed two-slot PATCH checks that the two media updates execute in UUID lock order.

The retained-history series uses a separate Realm and fixed pair of selected assets. Its history axis is the exact number of settings revisions at 256, 1024, and 4096, with matching retained receipts, outbox records, and write-basis rows. The setup appends linked revisions with empty presentation values and moves the head to the final setup revision. It seeds no selected claim and does not fabricate any published media state. The measured two-slot change still enters through the native PATCH and must perform two claim updates.

For both axes, `checkGrowth` and the shared SQL observer/classifier measure statements, returned/affected rows, buffer blocks and shared hits/reads, plus classified background runner work. Bounds are constant statements and rows and logarithmic blocks. Selected command receipt/revision bindings are checked for the exact actor, admitted scopes, client, requested-by identity, author, and predecessor. Same-key retry is checked as a replay; a fresh key with unchanged input is checked as a new admitted command. Clearing settings leaves old revision bindings and permanent media claims intact.

The refusal series measures native requests against the same unrelated-population scales. Four unavailable or mismatched assets (unpublished, wrong purpose, wrong Realm, and wrong uploader) must all return `media_unavailable`; a stale head must return `precondition_failed`. The selected Realm heads, revisions, receipts, and media claims are checked for rollback. Refused request work is part of the measured operation.

## Execution record

The inspected source revision is `c968558f1f20e21ca88ac8e7b26754a3fd642d7a`; the focused acceptance and fixture were added in commit `bd2374b4ae` and refined in the following worktree commit. The fixture is `growthRealmPresentationClaimFixture`, built on the shared `mediaRealmDownloadFixture` without modifying it. It uploads and publishes selected assets through native routes and the registered image job; unrelated populations and empty-presentation history are setup-only seeds.

The focused command is:

```sh
bun run --cwd services/kernel check test/content/growth-realm-presentation-claim.test.ts
```

The focused command stopped in the kernel schema-dump preflight, before loading the test file or reaching a test assertion. Its exact error was `error: Schema dump differs from db/library/schema.sql.` The preflight named `native_public_output_binding` as the expected first object and `members_preparation` as the actual first object. Neither schema file is changed by this work. No three-scale physical sample was produced:

| Case                                     | 256         | 1024        | 4096        |
| ---------------------------------------- | ----------- | ----------- | ----------- |
| 0 changed slots vs unrelated Realm/media | not reached | not reached | not reached |
| 1 changed slot vs unrelated Realm/media  | not reached | not reached | not reached |
| 2 changed slots vs unrelated Realm/media | not reached | not reached | not reached |
| 2 changed slots vs retained history      | not reached | not reached | not reached |
| media and stale-CAS refusals             | not reached | not reached | not reached |

The attempted kernel typecheck first failed in shared check preparation with `reason: absolute preparation deadline exceeded` during `source-artifact-publication`. Its retry reached TypeScript and reported existing diagnostics in unrelated, unmodified kernel files; it reported none in the new acceptance or fixture. The schema preflight and typecheck diagnostics remain integration execution limits, not passing acceptance evidence. This binding does not claim a promotion or add a proof-registration gate.
