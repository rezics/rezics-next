# Zone runtime integration

[Zones](../../../../docs/zones.md), [membership](../../../../docs/zone-membership.md) and
[filtered lists](../../../../docs/filtered-lists.md) own behavior.

`http.ts` mounts one `zone.read_page` composition in `page-runtime.ts`. Kernel supplies the same optional real
Search service used by Search routes, native Access, routing key, clock and Accounts key ring. Static documents
with no planned reads take the original independent 200 path. Source-dependent and direct-subject reads first
use current Zone authority and native `admitGroup('zone_sources')`; exposure grants no source permission.

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
independent native true can settle OR within the completely discovered range. MemberSource is an essential
conjunct of the Zone union. Locators for complete reads survive a later read's preparation. Before disclosure,
positive witnesses and current Zone/profile/source authority are checked again. No permission or truth vector is
retained. Native Collection evidence hints stay request-local and are checked again by that owner.

`page-work.ts` stores disposable bounded page locators in `zones.page_preparation`, not another Zone configuration
or membership table. Thirty-two keyed slots per Zone/viewer bound simultaneous retained requests; each row has
a 65,536-byte ceiling. Source/configuration/lifecycle changes remove those rows in the Zone transaction; eviction
and unusable cursors restart ordinary authorization. Accounts alone supplies encryption and the existing search
profile: eight keys, 4,864 unpadded base64url characters, fifteen minutes for every viewer. Stable route, viewer,
Zone and body bind AAD; mutable basis, generation and retained revision are encrypted position keys. Owner cursors,
allow vectors and proofs never enter the public token. There is no new token lifetime or worker.

A changed retained frontier yields private/no-store `202 {next}`. Complete common pages plus the safe Zone shell
yield 200. Unready or impossible/no-progress work yields standard 503 with Retry-After and no partial document.
An admitted source-free direct target is concealed 404. GET UUID list semantics are separate.

## Owner dependencies and verification boundary

The selected declarations now exist in `../search/scope-ordered.ts` and are re-exported by `scope-source.ts`:
`ScopeNativeOrder`, name/count tuples, ordered prepare controls, and `orderedPrefix` with covered range, work and
public cost. In this input, `scope-source.ts` ordered `prepare` and `orderedPrefix` validate these requests then
return unavailability. Their first actual native bodies/preparation/physical/current-source implementation remains
a Search dependency. The consumer calls those exact methods and cannot turn their declaration into readiness.
Existing underlying Source `metadata_missing` also remains honest. There is no alternate ordered engine here.

The existing acceptance case in `test/zones/static-page-runtime.test.ts` names this composition and uses the same
released fixture/governor setup, actual curated Source, duplicate Book occurrences and a reread current header.
It follows real 202 to a complete page and compares owner name/count results, direct membership and source removal.
`outcome-driver.ts` already admits only `zone_sources` through explicit closed `setup.openFeatures`; default
openings and ungranted 403 assertions remain unchanged. Existing acceptance tests are not rewritten.

Local delivery runs Kernel typing only. Native six-surface, Source publication, physical/growth, privacy repair,
GET lists, withholding/purge/account cleanup and worker/default-world completion remain their existing obligations;
source integration does not certify them. No external reference implementation is named by this contract.
