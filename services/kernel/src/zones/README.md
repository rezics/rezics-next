# Zone runtime integration

[Zones](../../../../docs/zones.md), [membership](../../../../docs/zone-membership.md) and
[filtered lists](../../../../docs/filtered-lists.md) own behavior. This file records the executable dependencies
of the source-dependent page runtime; it does not introduce another Source interface or change those contracts.

`http.ts` mounts `zone.read_page` with the existing closed body, optional query cursor, common-page response
and separate preparation response. `page-runtime.ts` currently executes static configured documents only.
Source-dependent execution remains behind native `zone_sources` admission and returns retryable readiness.

## Available owner handoffs

`../search/service.ts` registers its real pool, client, prefix, Source, release reader and clock through
`registerSearchScopeRuntime`. `../search/service-scope.ts` uses that registration in
`createSearchScopeForService(service, options)`; only an unregistered service fails construction. Its returned
`../search/scope-source.ts` adapter implements `prepare`, `prefix`, `evaluate`, `sourcePrefix` and `ordinalPrefix`.
Preparation preserves the supplied saved filter and release digest. Evaluation uses the native shared Scope
interpreter, current owner evidence and work receipts. These operations still require real underlying readiness;
registration does not make a Source with `metadata_missing` ready.

`../library/collection-source.ts` implements `prepare`, `prefix`, `containsSubject`, `readRawStoredPrefix` and
`readRawOrdinalPrefix` over native Collection authority, canonical storage, identity and original/terminal Access.
`../library/canonical-source-store.ts` implements its canonical state, seek and group reads. In particular,
`containsSubject` can return `not_proven` with a bounded `CollectionAliasProgress`; this is not absence.
Raw stored prefixes and curated occurrence ordinals do not supply canonical name/count ordering.

## Remaining executable handoffs

These are source observations, not failed native acceptance results. The following closed declarations do not
provide the ordered/preparation contract required by common Zone TypeLists:

| Required handoff                     | Actual owner export                                                                                                                                                                                                                                                                                                                       | Missing capability                                                                                                                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Name/count ordered source input      | `../search/service-scope-order.ts` exports `SearchScopeOrder` with only `kind: 'id'` and `kind: 'ordinal'`. `scope-source.ts` `prefix` hardcodes `sort: 'id'`; `ordinalPrefix` consumes curated native ordinal keys.                                                                                                                      | No callable Scope operation accepts common TypeList `name` or `collections` order with covered input, current evidence and native work accounting. Public Search supports those sorts, but its complete result page is not this port. |
| Retained ordered union preparation   | `../library/members-preparation.ts` exports `PreparationDefinition` with `sort: 'id' \| 'ordinal'`; `createMembersPreparation` methods `reserve`, `touch` and `admitStep` throw `dependency_unavailable`. `../search/scope-preparation.ts` retains individual native Scope capture; `scope-source.ts` retains curated ordinal processing. | None declares a retained name/count result over a Zone's original saved scopes and mounted Collections. Existing capture and ordinal storage are not a Zone union preparation binding.                                                |
| Unfinished canonical discovery group | `collection-source.ts` `prefix` throws `dependency_unavailable` when its internal `containsSubject` returns `not_proven`. Its prefix result contains only settled candidates, coverage and exhaustion.                                                                                                                                    | The prefix caller cannot obtain the discovered unfinished subject and its actual alias progress to retain the boundary before that group. `containsSubject` offers resumable progress only once the subject is known.                 |

The consumer needs the actual owner's callable ordered/preparation declarations and implementation, including
covered range, resumable unfinished group, current basis and native work receipts. No replacement API is declared
here. Sorting an ID page, forwarding a whole public Search page, retaining an allow vector or inventing another
worker/Source would not supply this handoff.

Default kernel composition must eventually pass the same actual Search service, native Collection producer,
Actor/time/deadline and existing work client through those owner ports. Zone ownership, exposure and configured
source IDs never supply source or subject authority. Static execution remains independent of these dependencies.

## Available cursor owner

`../tokens/list-cursor.ts` already exports `encodeListCursor` and `decodeListCursor`. The Search profile has eight
position keys, a 4,864-character unpadded base64url limit and a fifteen-minute lifetime for every viewer. Bind the
route, Zone, viewer and stable request shape in associated data; mutable current bases belong inside the position.
Unusable valid-shaped POST tokens restart current authorization. A 202 may be issued only after actual retained
work advances; unavailable execution must keep the standard 503 without a replacement cursor or partial document.

## Verification boundary

The existing native `user-site`, `membership-contract` and `page-continuation-contract` assertions remain unchanged.
An additional `static-page-runtime` case uses the same released discovery world with native Search and the real
Library population's public curated Collection. It rereads the current Collection header after occurrence writes,
retains the duplicate Book occurrence, opens only `zone_sources` through the existing governor setup API and
requires common TypeList name/count results, direct union membership and current source removal. A 202 is followed
to completion; readiness never counts as a successful page. Default fixture openings are unchanged.

Native acceptance remains for integration. This inventory establishes no dynamic runtime, useful-page, growth,
worker replay or privacy pass. No external reference implementation is named by the Zone runtime contracts.
