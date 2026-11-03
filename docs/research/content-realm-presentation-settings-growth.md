# Realm presentation settings operation binding

This suite binds [Content Done-when 3 and Acceptance](../goals/content.md) to
[the community settings Cost contract](../../services/kernel/src/community/README.md#cost-presentation-settings-and-rules-adoption).
It adds acceptance coverage; it changes no production behavior or budget.

Decision: grow unrelated Realms, retained selected Realm revisions and retained selected rules revisions as three
independent axes; successful selection uses no media, with two fixed unavailable media identities exercising rollback.

## Native operation

The focused entry is
`services/kernel/test/community/growth-realm-presentation-settings.test.ts`; its private binding is
`services/kernel/test/community/support/growth-realm-presentation-settings-fixture.ts`.
`createReactionRelayBase` supplies ordinary native accounts, the production Access factory, released definitions,
Realm/board creation and published Content authoring. A fresh registered `createKernel` composition receives the
shared growth database's instrumented pool and the original production Access, credentials and receipt keys.

Setup authors a 65,536 canonical UTF-8 byte Text revision through the native post revision HTTP command, with native
SPDX licence and SHA-256. Another ordinary revision becomes the post head; the exact earlier pin stays fixed.
No source selection, authority result, successful media claim or event is injected.

Each observation wraps only `PATCH /v1/realms/:realmId` with the real If-Match and idempotency headers. It includes
`updateRealm`, `prepareRealmRulesSelection` / `readExactPublishedRules`, current Access, Realm checkout/CAS,
transactional media selection when requested, and the route's final `readRealm` response binding. These are synchronous
registered native commands; this operation has no required asynchronous runner stage. Setup authoring and subsequent
board disclosure checks are separate, unmeasured operations. A header/home read never stands in for the settings command.

## Population and assertions

Every branch has a fresh isolated native database, selected Realm and post, so earlier series cannot mask growth.
Each axis seeds 256, 1,024 and 4,096 rows outside observation:

| Axis | Pressure | Fixed selected neighborhood |
| --- | --- | --- |
| Unrelated Realms | New same-route Realm/Space identities and revisions | One selected Realm, host, board, post and pin |
| Realm revisions | A retained revision branch of the selected Realm | Current Realm head and rules pin |
| Rules revisions | Retained revisions of the selected post | Current post head, exact selected revision and Realm |

Historical pressure clones native small revision snapshots, without moving either selected head, manufacturing
command outcomes or emitting events. Realm history retains predecessor links; native Content revision storage has no
predecessor column. Seeded row counts and unchanged source heads/receipts/events are asserted before observation.
The selected rules source has one post and no ancestors, within the owning 33-item chain bound; there is one settings
change, no page scan and no variable batch limit. The selected source bytes and reference cardinality stay fixed.

`checkGrowth` supplies native auto_explain rows, buffers, statements and wire-byte captures, normal warmups/repetitions,
settling and the shared classifier. Bounds remain constant rows/statements/bytes and logarithmic blocks. Assertions
also require stable statement counts, actual Realm work for admitted operations, at most six revision rows (current
root-post head, exact pin metadata and body in each source round) and 66 post rows over the source's two rounds,
and the shared growing-relation access-path check wherever that branch touches it.
No planner settings or tolerance overrides are installed.

Each axis covers adoption, empty selection, idempotent replay, stale CAS, missing post/revision, foreign Realm pin,
two unavailable media references, denied management, replay after native management-grant revocation and concealed rules.
Successful settings append exactly one revision/receipt/event per command; stale, refused and replayed commands append
none. Native grant/revoke commands establish current replay denial. Completion checks preserve the later post
head and original published pin/body/licence/digest, and conceal rules after native takedown. One focused case refuses
a natively authored 65,537-byte rules revision. Existing media claim and exact rules disclosure suites retain their
own independent internal growth series.

## Execution limits

Source inspection was bound to clean base `c968558f1f20e21ca88ac8e7b26754a3fd642d7a`.
Existing `community/presentation.test.ts` covers focused native outcomes but has no corresponding settings growth
series; the generic `community/growth-realm.test.ts` measures ordinary Realm updates without presentation selection.
Inspected bindings also include the native content system, shared growth observer/classifier/seed/access-path helpers,
native Realm update and exact rules preparation/read paths, and their generated storage schemas. No reference source
is named by this contract.

Eventual focused acceptance from the worktree root:
`bun run --cwd services/kernel check test/community/growth-realm-presentation-settings.test.ts`.
Scoped compiler command: `bun run --cwd services/kernel typecheck`.
Authored assertions and three-scale series are not measured passes. Controller launch deferral applies to native
acceptance; no reached native assertion or three-scale observation is claimed by this document. Runtime profiles and
exact execution revision belong to the check runner, not a committed evidence file.
