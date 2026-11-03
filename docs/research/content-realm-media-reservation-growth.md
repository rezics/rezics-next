# Realm asset reservation growth binding

## Bound operation

This binds the existing `POST /v1/realms/{realmId}/media` reservation to native HTTP, current Realm management,
and the committed `content.media.reserve` command. It stops at the reserved object and its
`com.rezics.content.media.reserved.v1` event. Upload completion, Realm settings claims, publication, and downloads
remain in their owner checks.

The selected Realm is the fixed protected Realm from `mediaRealmDownloadFixture`. Alice receives `realm:manage`
through the native grant route and is also the bearer uploader. Bob retains `realm:read` without management. The
payload is one fixed PNG with a fixed byte count and SHA-256 across all scales and paths. Both `realm-icon` and
`realm-banner` are admitted; the response keeps the declared digest private as `sha256: null` while state is
`reserved`.

The test uses `testKernel`, whose Access resolver is built by the production `runtimeDefaults().access` factory. It
uses the native HTTP route and command runner, then checks the persisted media row, idempotency receipt, and registered
media-reserved outbox event. No selected reservation, receipt, grant, event, or published state is seeded directly.

## Independent growth axes

| Axis                                       | Seeded outside observation at 256, 1024, and 4096                                                                   | Held fixed                                                           |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Same-home Realm, media, receipt population | Unrelated same-partition Spaces, Realms and their current revisions, reserved Realm media, and reserve receipts     | Selected Realm, manager, request payload, and existing selected rows |
| Retained Realm, grant, command history     | Unrelated same-partition Spaces, Realms and revisions, expired `realm:manage` grants, and retained reserve receipts | Selected Realm, manager, request payload, and existing selected rows |

Fresh admission, receipt replay, and refusals have separate growth captures on each axis. The refusal capture includes
the original manager replaying after `realm:manage` is revoked and a different current principal with read but no
management. Management is restored before the allowed replay capture; the replay must return the original response.
The observed report includes refused-request statements, rows, shared buffers, SQL request/response bytes, plans,
control/catalog work, and seed/settlement work.

The owning `Cost: Realm asset reservation` bound remains constant rows and statements with indexed logarithmic block
work as `R` grows. The check asserts those bounds through the shared growth classifier and checks indexed access paths
for Realm, Realm revision, grant, media, receipt, and outbox relations. It also rejects account-image and content
revision-history reads.

## Execution record

- Base revision: `c968558f1f20e21ca88ac8e7b26754a3fd642d7a`.
- Submitted revision: `fed78d538ccdce04db3ef9c3080cd2d27776419d` (test and fixture source; this record was added afterward).
- Test: `services/kernel/test/content/growth-realm-media-reservation.test.ts`.
- Command: `bun run --cwd services/kernel check test/content/growth-realm-media-reservation.test.ts`.
- Reached assertions: the check script stopped in `assertSchemaConsistency` before loading this test. Exact error: `Schema dump differs from db/library/schema.sql.` The expected dump contains `library.native_public_output_binding`; the actual dump contains `library.members_preparation` at that location. The schema inputs are unchanged from the base. The owning seam is Library schema generation/order, outside this reservation slice.
- Three-scale observations: none were collected. The test declares separate admission, replay, and refusal captures on the same-home and retained-history axes at 256, 1024, and 4096; the schema preflight prevented all six captures from running.
- Execution limits: `bun run --cwd services/kernel typecheck` used the remote check host but stopped during source artifact publication. The host's error began `remote-check: infrastructure failure` and reported `reason: absolute preparation deadline exceeded`, `elapsedMs: 899914`, and `stalledPhase: source-artifact-publication`. The focused check and kernel typecheck are therefore not passes. The controller defers frozen Content acceptance, native suite reruns, and promotion checks to integration; this record does not claim Goal completion evidence.
