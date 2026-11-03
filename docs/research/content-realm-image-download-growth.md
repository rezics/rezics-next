# Realm image derivative download growth

This binds the missing native growth evidence named by [Content's Realm image cost](../../services/kernel/src/content/README.md#cost-realm-image-summary-and-download) and Content's [Done-when clauses](../goals/content.md#done-when). It adds no runtime behavior.

## Measured operation

The test uses the production Access factory mounted by the real kernel fixture. Its one reader uploads and manages a fixed protected Realm in a fixed Space. The private fixture reserves a `realm-icon` through `POST /v1/realms/{realmId}/media`, stores the fixed PNG, completes it through the existing media command, replays the same completion key, and publishes it with the existing image job. The test selects that image through the authorized Realm `PATCH` settings command with `If-Match`, then replays the same key and verifies only one settings revision was added.

The selected media row must retain its exact `claimed_realm_id` and `claimed_at`. The test captures original and derivative bytes from the test object store and checks the selected derivative's size and SHA-256 against the registered publication and the actual HTTP authorization response.

Every measured operation uses the same Alice credential and makes four requests: an ordinary derivative authorization, the same derivative with its current `If-None-Match`, an original request, and a conditional request for an unavailable media ID. The authorized kernel endpoint returns its existing `200` decision for a matching conditional header; this test does not require `304`. Successful responses must be `private, no-store`. The original and unavailable requests remain refused and disclose no object metadata.

After measurement, Alice loses only `realm:read`. Her `realm:manage` grant and uploader identity remain. A fresh conditional request for the selected derivative must be concealed like an unknown ID, and the summary reader must return no image. The test then erases the selected media through the existing command and checks the same unavailable behavior while the permanent claim marker remains. No cached summary or earlier authorization is reused.

## Independent growth axes

Both checks use the shared physical observer and SQL classifier in `test/support/growth.ts`, one warm-up and one measured repetition at each scale. Scales are 256, 1024 and 4096; the route home, partition count, selected Realm, selected media, selected derivative, byte sizes and request set stay fixed.

| Axis | Fixture-only pressure | Measured rows |
| --- | --- | --- |
| Unrelated same-home population | One unrelated Space, Realm, current Realm revision and reserved media item per ordinal | Space, Realm, Realm revision and media |
| Retained history | One unrelated Realm with detached retained settings revisions, expired non-overlapping grant and ban ranges, reserved media rows and receipt history | Realm, Realm revision, ban, grant and media |

Only unrelated pressure is seeded directly. The selected reservation, completion, publication and Realm settings claim all use their registered production paths. The checks bound examined rows and statements as constant, shared blocks as logarithmic, and request/response bytes as constant. They also assert fixed relation row work and indexed access on the physically grown relations. Each sample emits exact statement, row, buffer, byte and seeding/settling values as `REALM_IMAGE_GROWTH` output.

## Revision and execution record

The clean base was `c968558f1f20e21ca88ac8e7b26754a3fd642d7a`. The test and private fixture were last changed at `0bb6950812a6352eac8f2d5166607f567294b43`; the focused command was launched against that revision:

```sh
bun run --cwd services/kernel check test/content/growth-realm-image-download.test.ts
```

The runner stopped before the target test at `error: Schema dump differs from db/library/schema.sql.` It also reported `Checked source commit/tree: UNKNOWN (no retained source provenance at this boundary).` No target assertion ran and no three-scale measurements were produced. The library schema files were unchanged by this task. The native growth acceptance remains deferred to integration.

`bun run --cwd services/kernel typecheck` was retried after correcting the two errors reported in the new files. The remote check twice timed out during source-artifact publication with `reason: absolute preparation deadline exceeded`; the workspace typecheck therefore did not complete on the final test revision. Its first run also reported errors in unchanged access, history, search and unrelated test files. Browser, native app, root and worker checks were not run under the launch instructions.
