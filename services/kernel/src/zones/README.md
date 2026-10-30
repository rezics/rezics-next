# Zone runtime integration

[Zones](../../../../docs/zones.md), [membership](../../../../docs/zone-membership.md) and
[filtered lists](../../../../docs/filtered-lists.md) own behavior. This file records the executable dependencies
of the source-dependent page runtime; it does not introduce another Source interface or change those contracts.

`http.ts` mounts `zone.read_page` with the existing closed body, optional query cursor, common-page response
and separate preparation response. `page-runtime.ts` currently executes static configured documents only.
Source-dependent execution remains behind native `zone_sources` admission and returns retryable readiness.

## Missing executable handoffs

The following are source observations, not failed acceptance results. No native acceptance was run for this
inventory. Export presence alone must not be treated as an available runtime.

| Required owner handoff                       | Actual import and implementation                                                                                                                                                                                                                                                     | Integration consequence                                                                                                                                              |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Commerce canonical Collection producer       | `../library/collection-source.ts`: `createCollectionSource({pool, access, clock?})` exports `prepare`, `prefix`, `containsSubject` and `readRawStoredPrefix`. Every method throws `ProblemError('dependency_unavailable')`.                                                          | There is no executable curated, built-in, published or frozen source to compose. An empty replacement would incorrectly prove absence.                               |
| Same-service Search scope factory            | `../search/service-scope.ts`: `createSearchScopeForService(service, options)` always throws `ProblemError('index_not_ready')`, including after registration. `registerSearchScopeRuntime` has no production caller.                                                                  | Passing the existing kernel Search service cannot execute a saved scope. Constructing another Search client or scope engine in Zones would bypass the owner handoff. |
| Admitted indexed scope execution             | `../search/scope-source.ts`: `createSearchScopeSource` exposes `prepare`, `prefix` and `evaluate`; all execution ends in readiness. Prefix requests contain only `afterSubject`, `quota` and `budget`, with no name/count ordering or retained ordered-result operation.             | These declarations cannot execute the required common name/count union or retain its ordered preparation. Zones cannot infer a new owner API from these types.       |
| Complete public projection and query privacy | `../semantic/public-filter-source-contract.ts` declares types for a future `../semantic/public-filter-source.ts` export `publicFilterSource`, including `readPublicFilterProjectionPage`, `readPrivacyReductionHeads` and `readPrivacyReductionPage`. That runtime module is absent. | Current returned-subject checks cannot prove safe NOT, excluded candidates or ordering. The contract types are not a Source binding.                                 |
| Existing durable preparation                 | `../library/members-preparation.ts`: `createMembersPreparation` exposes `reserve`, `touch` and `admitStep`; each throws an explicit unimplemented error. Its admitted definition supports only `sort: 'id'`.                                                                         | No real retained name/count preparation can be bound through this export. A cursor alone supplies neither work nor eventual completion.                              |

The Commerce raw/canonical storage helpers in `../library/canonical-source-store.ts` also throw
`dependency_unavailable`; they are not a substitute producer. The older identity-home sweep and alias recovery
prescriptions in those scaffolds are explicitly superseded by the current owner documents. Implementing them in
Zones would conflict with the current source-scoped identity and bounded indexed-list requirements.

The missing dependency is executable owner behavior and its ordered/preparation binding, rather than a missing
Zone transport schema. Once supplied, default kernel composition must pass the actual Search service, Commerce
producer, native Actor/time/deadline and existing work client through that binding. Zone grants never supply source
or subject authority. Static page execution must remain independent of these dependencies.

## Available cursor owner

`../tokens/list-cursor.ts` already exports `encodeListCursor` and `decodeListCursor`. The Search profile has eight
position keys, a 4,864-character unpadded base64url limit and a fifteen-minute lifetime for every viewer. Bind the
route, Zone, viewer and stable request shape in associated data; mutable current bases belong inside the position.
Unusable valid-shaped POST tokens restart current authorization. A 202 may be issued only after actual retained
work advances; unavailable execution must keep the standard 503 without a replacement cursor or partial document.

## Verification boundary

The existing native `user-site`, `membership-contract`, `page-continuation-contract` and `static-page-runtime`
suites remain unchanged. Their post-integration command is the acceptance authority. This inventory establishes
no dynamic runtime, useful-page, growth, native persona, worker replay or privacy pass. No external reference
implementation is named by the Zone runtime contracts.
