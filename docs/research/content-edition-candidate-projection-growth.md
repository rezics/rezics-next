# Creator edition candidate projection growth

## Binding

The inspected source revision is `d50464392475ae4a76362a7ed0bb1e9646126501`. The owning row is “Creator edition candidate projection” in `services/kernel/src/content/README.md` (Cost table). Its contract is one native creation event, one bounded source envelope of at most 1000 slots, a released source snapshot that checks the immutable edition and original account write basis, followed by one creator-home fence check and an idempotent candidate insert. The source and creator partitions are distinct in this fixture.

The private fixture uses `mediaRealmDownloadFixture` for the migrated Growth database, native Auth, production Access, and HTTP Kernel. It creates the concept, grant, source thread, and edition through native commands. It records the edition's exact `content.edition` row, matching `editorial.write_basis` row, and `core.outbox` slot; missing or mismatched source evidence throws before delivery. The registered runtime is `composeNativeCollectionRuntime`, which composes `registerContent` and relays the committed outbox through `relayThrough`. The test awaits the deterministic `content_creator_edition` workflow and checks its committed candidate and output event. It does not construct or inject a CloudEvent, call the effect directly, or synthesize selected source state.

The fixed selected ancestry is one published source thread, post, revision, body, creator, subject, and native account scopes. Each measured worker operation creates and relays one new edition event; its recorded event count is checked against the 1000-slot ceiling. A separate native-creation series captures the real HTTP, Access, and source validation path without relaying the creation event in its measured callback. It also verifies that creation alone writes no creator candidate or creator-indexed event.

## Independent growth axes and capture

Each series grows from 256 to 1024 to 4096 unrelated rows before its warmup and measured operation:

1. Source-home `content.edition` and `core.outbox` history.
2. Creator-home `content.creator_edition` candidate history.
3. `access.account` history in the creator home and `editorial.write_basis` history in both homes, with corresponding unrelated outbox slots so the partition histories remain readable.

The existing admitted `seed` helper performs setup before observation. `checkGrowth` captures actual rows, shared blocks, statements, plans, and access paths for native creation and for the registered relay plus worker. Each series uses the shared classifier with constant rows, logarithmic blocks, and constant statements; the assertions require all three scales, nonempty physical evidence, and indexed access paths. The selected body and worker envelope do not grow with the unrelated populations. No planner setting or budget relaxation is used. The source snapshot, creator command, Access checks, native Auth deletion, and final erasure fence are production boundaries.

The duplicate-delivery case holds the real checkpoint compare-and-advance query after one relay has enqueued the workflow, then lets a second relay read the same committed outbox event and advance the checkpoint. It awaits the registered workflow and requires one candidate and one creator-indexed outbox event. The erasure case uses `deletePersona` through native Auth and its existing consent, relays the committed tombstone, and pauses the authored cleanup command after the participant has closed the creator fence. It then relays a real pending edition event and requires no late candidate or creator-indexed event while the Content erasure outcome remains pending. Candidate ownership is also checked through the account editions API; an unrelated account receives 404.

## Evidence and decisions

The unchanged focused `edition-index.test.ts` already pins exact source rejection: changing the committed event ID rejects with `Edition creation provenance mismatch`. This growth test preserves that assertion and exercises the accepted source through the registered worker. Missing exact source joins, a non-account write basis, a mismatched body or ancestry, an oversized event envelope, and an unsuccessful worker workflow fail with explicit fixture errors.

Decision: use the existing outsider actor as creator and a distinct source home so the lifecycle case deletes only the account created for this source. The focused acceptance is deferred to controller integration; this document reports the operation binding and assertions, not measurements.

The research read `docs/goals/content.md`, the Cost row in `services/kernel/src/content/README.md`, `services/kernel/test/content/edition-index.test.ts`, `services/kernel/test/support/growth.ts`, `services/kernel/test/support/growth-capture.ts`, `services/kernel/test/content/media-realm-download-fixture.ts`, `services/kernel/test/content/media-native-collection-fixture.ts`, `services/kernel/src/content/edition-index.ts`, and the Content erasure fence and authored cleanup implementation.
