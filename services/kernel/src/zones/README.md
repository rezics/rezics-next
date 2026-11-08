# Zone runtime integration

[Zones](../../../../docs/zones.md), [membership](../../../../docs/zone-membership.md) and
[filtered lists](../../../../docs/filtered-lists.md) own behavior.

Zone resource create, configure, publish, current-owner reads, mutation and platform hold/purge/takedown go through
`resource-access-port.ts` and the constructed `resource-application.ts`. `composeZoneResource`, `createKernel` and
`zoneRoutes` bind Access's public producer (`access/zone-resource-adapter.ts`) via `adapters/resource-access.ts`.
HTTP maps admission (`requireAccount`, `If-Match`) and outcomes (status, Location, ETag, cache) onto that instance.
Parent locks, CAS, compiled page authorization, current owner fences, History enrollment and native participant
cleanup stay in `resource-head.ts` and the owner command bodies. Collection remains the separate Library port.

`http.ts` mounts `GET /v1/zones/{id}/collections`, `GET /v1/zones/{id}/subjects` and one `zone.read_page` composition in `page-runtime.ts`.
Zone membership work and mounted Collection reads go through `collection-port.ts`. `composeZoneCollection` and `zoneRoutes`
bind `library/zone-collection-adapter.ts`, which supplies `CollectionSourceLedger`, `readCollection`, `collectionReadView`
and `collectionResourceSchema`. `ZoneWorkLedger` wraps that host at call time. The mounted Collection summary route uses
the requesting Actor's current Zone `zone:read` admission, then the existing `zone_sources` gate and each Collection
owner's `readCollection` projection through the port. It returns only the currently readable summaries in configured
mount order. Hidden mounts add no output or cursor position.
Kernel supplies the same optional real Search service used by Search routes, native Access, routing key, clock
and Accounts key ring. Static documents with no planned reads take the original independent 200 path.
Source-dependent and direct-subject reads first use current Zone authority and native
`admitGroup('zone_sources')`; exposure grants no source permission.

## Callable composition

`resource-reads.ts` returns an internal, withholding-filtered descriptor from the existing Zone head alongside
its authoritative time. It never adds configuration to the public shell. `membership.ts` prepares each original
saved filter with its immutable release digest through `createSearchScopeForService`. Mounted Collections first
use actual `createCollectionSource().prepare`; Source identity comes from `readNativeCollectionScopeIdentity`,
not a Collection ID cast. Current predicates, same-statement/unknown semantics, original/terminal Access and Source
eligibility remain with these owners. Only native concealed Sources are omitted; missing evidence is unavailable.

Structural Collection discovery uses `readCanonicalSourceState` and `seekCanonicalSourceGroup`, followed by
`containsSubject` and its actual `CollectionAliasProgress`. This exposes the unfinished canonical group without
pretending that the settled-only Collection prefix proved exhaustion. Native Scope collections use `sourcePrefix`.
Catalogue UUID discovery uses `prefix`; common TypeList name/count discovery exclusively uses `orderedPrefix`
and its real typed tuples. No public Search result page, UUID post-sort or local predicate interpreter is used.

`union.ts` discovers every source through a common covered watermark, merges only that settled range and tests
current OR membership. One unfinished canonical group retains its actual owner progress before the frontier;
independent native true can settle OR within the completely discovered range. Partial discovery retains only
the next source ordinal, bounded merged keys and common minimum coverage, so a small page can finish discovering
all 32 sources across bounded requests without an owner-cursor vector. MemberSource is an essential
conjunct of the Zone union. Locators for complete reads survive a later read's preparation. Before disclosure,
positive witnesses and current Zone/profile/source authority are checked again. No permission or truth vector is
retained. Native Collection evidence hints stay request-local and are checked again by that owner.

`page-work.ts` stores disposable bounded page locators in `zones.page_preparation`, not another Zone configuration
or membership table. Thirty-two keyed slots per Zone/viewer bound simultaneous retained requests; each row has
a 1,048,576-byte ceiling (including full native tuples for 128 output slots and bounded discovery). Source/configuration/lifecycle changes remove those rows in the Zone transaction; eviction
and unusable cursors restart ordinary authorization. Accounts alone supplies encryption and the existing search
profile: eight keys, 4,864 unpadded base64url characters, fifteen minutes for every viewer. Stable route, viewer,
Zone and body bind AAD; mutable basis, generation and retained revision are encrypted position keys. Owner cursors,
allow vectors and proofs never enter the public token. There is no new token lifetime or worker.

A changed retained frontier yields private/no-store `202 {next}`. Complete common pages plus the safe Zone shell
yield 200. Unready or impossible/no-progress work yields standard 503 with Retry-After and no partial document.
An admitted source-free direct target is concealed 404. The separate mounted Collection GET is a finite summary
list, not the Zone's UUID Subject union.

## Mounted Collection summary list

The cursor uses the default list profile and binds method, Zone, viewer and limit. Its locator is the last
disclosed Collection ID plus current Zone and lifecycle revisions; each request re-reads every configured mount
through the bound Collection read port. Only a native `not_found` is omitted. Other owner errors,
including unavailable reads with their original Retry-After, abort the whole response. A first and final Zone
basis read and two serial source passes revalidate mount configuration, visibility, owner activity, Collection
permissions and safe summaries before returning `{collections,next}`. No Collection members, owner predicates or
hidden source ordinals are read or retained.

Decision: the mounted Zone Collection route keeps the native `ZoneCollectionPublicView` vocabulary by statically
wrapping the existing Library schema; generated declarations and client helpers use that same route type.

### Cost

- The Zone has at most 16 configured mounts. Each pass reads at most 16 owner summaries; the full request makes
  at most 32 serial `readCollection` calls, two Zone basis reads and one gate admission. Each Zone basis performs
  one `zone:read` check and its own read-only Zone transaction; current Zone-head and owner-account verification
  remain within those reads.
- There are at most 16 output slots. The response byte cost is the selected existing Collection projections,
  the `{collections,next}` envelope and one cursor. The default cursor has three position keys and remains under
  the existing 4,096-character cap. Neither rows nor token positions include hidden mount IDs or ordinals.
- The Zone holds no checkout across owner calls. Each Collection keeps its documented Access, presentation and
  currentness bounds; no member, history or owner-index scan is added.

## Owner dependencies and verification boundary

Search has native ordered preparation and orderedPrefix bodies. They restore/capture complete observations, validate privacy-reduction coverage and currentness, read bounded ordered rows, verify native hits and revalidate before return. Collection input additionally requires a complete bounded population and current membership. Missing source or privacy evidence and unaffordable work still produce readiness; this implementation does not prove every ordered journey.

Ordinary `createKernel` binds the native Content cover/tuple lifecycle so Zone summary reads work without identity
participants. `GET /v1/zones/{id}/subjects` is mounted from `page-runtime.ts`. It reuses `createZoneReads().page`,
`zone_sources` admission, `createZoneMembership`/`advanceZoneUnion`/`revalidateZoneUnion` and
`readSubjectSummaryObservation`, with the default list-cursor profile, predecessor replay and `409 stale_cursor`
for expired or incompatible tokens. The Zone reader restarts that stale token once under current authority.
Missing current summaries are unavailable, never omitted. TypeList membership and `zoneObservedReadKey` stay in
that same runtime so Search does not import Zones and restricted observations cannot leak into a global Search
dispatch. Generated OpenAPI and the installed client remain promotion outputs. The native Subject GET design is
owned by [Zones](../../../../docs/zones.md#routes-and-native-declarations) and
[Zone membership](../../../../docs/zone-membership.md).

Native takedown and release (`:takedown`, `:releaseTakedown`) withhold and restore exact configuration pointers
under `moderation:takedown`; configuration edits rebind live decisions to moved elements and retain superseded or
removed originals in restricted custody; configuration reads with a live decision are owner-only (`takedown.ts`).
Platform `:hold`/`:releaseHold`/`:purge` commit hold and cleanup intent on Global Context (`zone:purge`);
`purgeZonePage` is the bounded worker. Account-erasure Zone payload and ordinary retention's final purged marker
use `lockZoneHead`/`compareAndSetZone`; a live hold defers the locator and does not clear withholding.
Terminal grant drain reads the committed `access.erasure` version/T, pages both Access grant stores, and
CAS-persists the returned cursor on the Zone until both stores complete; empty `resource_grant` progress no
longer stalls owner-role cleanup. Proposed
prepareZoneCleanup and lockZoneCleanup are not callable exports; the current ordinary record authority remains
unchanged. Zone cleanup follows the [adopted branch contract](../../../../docs/zones.md#deletion-restoration-withholding-and-durable-cleanup).
Native, growth and browser acceptance for six-surface walks, source publication, privacy repair, withholding,
purge, account cleanup and default-world outcomes remain unproved; helper setup and type evidence do not establish
them. Access grant minimization, Content order-scope and History durable-work remain open.

## Authored names

Saved configurations use `ZoneConfiguration`: a bounded partial language map plus optional
`primaryLanguage` inside the existing versioned configuration JSON. Explicit primary names admit a
single authored language and optional translations; legacy eight-name configurations remain valid
without rewriting. `validateZoneConfiguration` retains all page, scope, text and closed-field checks;
`validateZoneStarter` and generic Composition label validation are unchanged. Native commands keep
ordinary authorization, sealed replay, CAS and one-partition writes. No separate rename operation or
translation service is introduced. Public metadata carries the primary language only through the
existing withholding filter. Zone readers and owner surfaces share `pickZoneName` over disclosed maps.

The naming journey is authored in `test/zones/naming.test.ts` using the existing real resource fixture.
Its native execution, growth evidence, browser interaction and captures remain deferred; workspace typing
alone does not establish native behavior.
