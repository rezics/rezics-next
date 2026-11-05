# Semantic design status

Status inventory, 2026-10-30. The two systems below are Semantic's **In** rows in
[current scope](../scope.md). This follows the backend design audit at
`.temp/goal/supermanager/backend-design-audit-20261030.md` (read from the read-only main checkout)
and the current minimal execution direction: document existing design, research and missing journeys;
do not add architecture or run a proof campaign. Current code-only minimal landings have **not proven these rows**.
The [Goal's](../goals/semantic.md) original main/root gate remains unproven and promotion is currently paused.
Source inspection and owner delivery statements below describe implementation, not tested or promoted completion.
The declared local acceptance remains later proof; no checks are run for this prose-only report.

## Catalogue, editorial contributions, identity resolution, definitions and vertical editors

**Design owners.** [Semantic](../../services/kernel/src/semantic/README.md) owns facts, editorial decisions,
revisions, identity and native disclosure; [Definitions](../../packages/definitions/README.md) owns release
vocabulary, profiles and inert presentation hints. [Subject pages](../subject-pages.md) and
[Presentation](../../services/kernel/src/presentation/README.md) own the common rendering handoff;
[Collection presentation](../collection-presentation.md) owns the joint list/editor boundary and
[Deletion](../deletion.md) owns lifecycle policy. Public scope admits existing released profiles, common editors
and ordinary contributions/readers. Custom publication, advanced identity mutation, reviewed vocabulary seeds
and measured-input expansion remain closed behind explicit platform grants until polished.

**Research.** [Catalogue serialization research](catalogue-schema-org-mapping.md) links primary executable
[Open Library work](https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/openlibrary/templates/type/work/view.html#L136)
and [edition](https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/openlibrary/templates/type/edition/view.html#L136)
templates: web serialization does not collapse native work/edition identity. Those template excerpts were also
read in the retained reference clone. [Filter data mappings](catalogue-filter-data-mappings.md) reviews
[SKOS](https://www.w3.org/TR/2009/REC-skos-reference-20090818/),
[wordCount](https://schema.org/wordCount) and pinned
[Wikidata word measurements](https://www.wikidata.org/w/index.php?title=Property:P6570&oldid=2527590037);
vocabulary mappings do not supply native measured facts. [Identity research](identity-concurrent-groups-current.md)
uses [PostgreSQL locking](https://www.postgresql.org/docs/19/explicit-locking.html) and
[DBOS workflow semantics](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial), with explicit native-custody
limitations. **NONE** for a delivered product-shaping study of the complete contributor/editor/identity-resolution
UI journey. [Catalogue/editorial journey design](catalogue-editorial-journey-design.md) is **pending**, absent from
this checkout and not read; this inventory does not depend on its delivery. Existing technical research is partial
coverage, not a substitute for that report.

| Page / control / state                                               | Exact existing API / DTO, or GAP                                                                                                                                                                                                                                          | Storage / source / authority                                                                                                                                                                    | Current implementation or GAP                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reader opens `/subjects/{id}` then `/subjects/{id}/{slug}` and views | `GET /v1/subjects/{id}` → `{subject: ItemSchema,account,summary,related}`; `POST /v1/pages:read {target:{subject,view?},languages?}` → common `PageResponseSchema`                                                                                                        | `semantic.subject`, `fact`, `revision`, pinned `definition_release`; presentation profile; current subject/Context and related-target Access                                                    | Web canonical loader, common renderer and typed native handlers exist. Relations use `GET /v1/subjects/{id}/relations` and `GET /v1/subjects/{id}/links`; complete disclosure/freshness remains owner acceptance.                                                                       |
| Create a subject / describe a vertical                               | `POST /v1/subjects` with `ItemInputSchema {type,labels,descriptions?,aliases?,statements?}` → `201 {subject}`                                                                                                                                                             | Subject partition, revision-1 self mapping and ordinary Global `subject:create`; released Type, not a vertical backend                                                                          | Native command exists. **GAP:** no mounted subject-create or semantic field-editor page found in the current web route tree. Presentation curation below edits layout, not subject facts.                                                                                               |
| Propose sourced facts; compare candidates and revisions              | `POST /v1/subjects/{id}/candidates {statement}` → `{candidate,revision}`; `GET /v1/subjects/{id}/candidates?property=&context=` → `{candidates,adoption,next}`; `GET /v1/subjects/{id}/revisions` → `{revisions,next}`                                                    | `candidate`, `retraction`, `revision`; statement references/source and current Context/subject authority                                                                                        | Native proposal/history handlers exist. **GAP:** contributor form, provenance comparison and dispute/history UI journey.                                                                                                                                                                |
| Context acceptor accepts/rejects, then adopts ranked values          | `POST /v1/subjects/{id}/candidates/{candidate}:accept` and `POST /v1/subjects/{id}/candidates/{candidate}:reject` use `DecisionBody {context,expected_head}`; `POST /v1/subjects/{id}:adopt` uses `AdoptionBody` with mode, selection/ranks and expected head             | `acceptance`, `acceptance_current`, `adoption`, `fact`, new subject revision; `context:accept` and `context:adopt` are distinct                                                                 | Native decision/adoption handlers exist; inherit/replace/suppress and ranks are represented. **GAP:** acceptor controls, stale-head recovery and complete visible result journey.                                                                                                       |
| Resolve duplicate identity / follow redirect                         | Mounted `POST /v1/subjects:merge {subjects:[id,id]}` declares `200 {survivor,redirected,revision}`; source read has `308 Location`                                                                                                                                        | `redirect`, `merge_member`, `identity_epoch_*`; Global merge authority plus `subject_identity` platform gate                                                                                    | **GAP:** the owner contract instead requires admitted `202 {operation:{id}}` and `/v1/subjectIdentityOperations/{id}` polling; current mounted route does not deliver that journey. Mapping/participant completion and resolution UI remain owned work; advanced mutation stays closed. |
| Read definitions; publish/activate custom vocabulary                 | `GET /v1/definitions/active` → `{digest,head}`; `GET /v1/definitions/releases/{digest}`; `POST /v1/definitions/releases {release}` → `{digest}`; `POST /v1/definitions/releases/{digest}:activate {expected_head}` → `{digest,head}`; `GET /v1/contexts/{id}/definitions` | `definition_release`, `definition_activation`, `context_extension`, `context_extension_activation`; immutable digest vs active head; Global/Context authority and `definition_publication` gate | Release reads/compiler and Global/Context publication handlers exist. **GAP:** publication management UI and whole cold-publication/resource-bound delivery; custom writes stay closed.                                                                                                 |
| Edit common vertical presentation at `/curate/presentation`          | `GET /v1/presentation/active`, `GET /v1/presentation/profiles/{digest}`; `POST /v1/presentation/profiles {profile}` → `{digest}`, then `POST /v1/presentation/profiles/{digest}:activate {expected_head}` → `{digest,head}`                                               | `presentation.profile`, `presentation.profile_activation`; current publish/activate authority, separate from semantic definition activation                                                     | Signed-in curation, Puck `PageEditor`, validation and stale/forbidden/unavailable states exist. Edits overview templates by generic/base/Type/route; this is not a complete vertical fact editor.                                                                                       |
| Use Type hints in Collection member lists                            | Existing definitions GET carries `TypeDefinition.listPresentation?`; **GAP:** selected `readListPresentationFacts` native producer and FULL member enrichment                                                                                                             | Release hints are inert; Semantic owns actual currently disclosed facts; Commerce owns Collection occurrences, kind derivation and final member disclosure; Web renders                         | Compiler/schema/bundle and normal recordings deliver optional hints. Collection Web still has exact-Type ratio fallback. Collection kind/cover projections and complete fact delivery remain separate owner work.                                                                       |
| Delete/restore contributions or Context; erase an account            | `DELETE /v1/contexts/{id}` / `POST /v1/contexts/{id}:restore {}` → `{context:{id,state}}`; `POST /v1/subjects/{id}:hide`, `:takedown`, `:restore` are moderation. **GAP:** ordinary contribution delete/restore and full purge/hold journey                               | Native lifecycle/owner evidence and `semantic.erasure_*`; Accounts' terminal obligation; shared-history and source custodians retain their own duties                                           | Context lifecycle is owner-delivered; moderation is not personal deletion. Local erasure work must not ACK missing source/shared-copy custody; whole retention/restoration/erasure remains unproven.                                                                                    |

**Already-owned whole slices and gaps.** Semantic owns contributor proposal → Context decision → adoption →
revision/readback, release publication/activation and pins, native identity publication/participant closure,
current fact/disclosure producers and its lifecycle participant. Web owns the corresponding usable controls and
common rendering; Search owns admitted indexed execution, not semantic source truth. Definitions' current hints
are `{imageAspect,keyFacts}` (0–4 representable effective properties), inherited as a whole and emitted per Type;
they grant no authority and contain no fact values. Collection `presentationKind` is a TypeId, not member Type,
membership or a private Label. Commerce owns its override/complete-auto-kind and editor/source integration;
Semantic supplies the bounded fact batch, Web consumes the generated handoff. Reviewed vocabulary seeds and
genuine word-count assertions are still producer gaps. No complete editorial or vertical-editor journey is
claimed from native handlers, definitions data or layout editing alone.

Source basis: mounted [kernel composition](../../services/kernel/src/http/kernel.ts), Semantic
[subjects](../../services/kernel/src/semantic/http/subjects.ts), [definitions](../../services/kernel/src/semantic/http/definitions.ts)
and [Contexts](../../services/kernel/src/semantic/http/contexts.ts), native
[schema](../../services/kernel/db/semantic/schema.sql), definitions [exports](../../packages/definitions/src/index.ts)
and [compiler](../../packages/definitions/src/compile.ts), web [routes](../../apps/web/src/routes),
[subject loader](../../apps/web/src/features/pages/subject-queries.ts),
[curation actions](../../apps/web/src/features/pages/curate-actions.ts) and
[Collection fallback](../../apps/web/src/library/collection-presentation.ts). These were read to name surfaces,
without re-verifying another owner's delivery.

## Zones

**Design owners.** [Zones](../zones.md) owns resource/configuration, routed pages and lifecycle;
[Zone membership](../zone-membership.md) owns source composition;
[Filtered lists](../filtered-lists.md) owns indexed observations, current disclosure, preparation and cost.
[Collection sources](../collection-source.md), [dynamic Collections](../dynamic-collections.md) and
[Collection presentation](../collection-presentation.md) retain their own source/publication/editor boundaries;
[Deletion](../deletion.md) retains erasure policy. Current public scope is configured static routed sites with
**no source reads**. Saved-scope/mounted-Collection unions, direct catalogue targets and retained preparation
remain closed behind `zone_sources` platform grants until polished. A Zone is a site, not source authority.

**Research.** [Saved scopes and mounts](zone-scopes-and-mounts.md) has primary-source precedent in
[Open Library list expansion](https://github.com/internetarchive/openlibrary/blob/37e446827465be2febad416de1bc18753b66997d/openlibrary/core/lists/model.py)
and [AIP-158 pagination](https://google.aip.dev/158). The retained list-source excerpts were read: seed expansion
can produce duplicate works; that is not proof of a bounded private union. Existing
[TypeList ordering research](zone-type-list-order-current.md) distinguishes native ordered candidates from UUID
membership; its historical port/codec recommendations do not override current owners. **NONE** for a delivered
whole site-owner/visitor product journey study. [Zones site journey design](zones-site-journey-design.md) is
**pending**, absent from this checkout and not read; this page needs no dependency on it.

| Page / control / state                                              | Exact existing API / DTO, or GAP                                                                                                                                                                                    | Storage / source / authority                                                                                                                   | Current implementation or GAP                                                                                                                                                                                                 |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owner creates/selects a starter and finds own sites                 | `POST /v1/zones {configuration:ZoneStarter,mounts,visibility}` → `201 ZoneResponse`; `GET /v1/zones?limit=&cursor=&deleted=` → `{zones,next}`                                                                       | `zones.zone` keyed by route/Zone, owner index; Global `zone:create`, initialized owner grants                                                  | Resource handlers exist; eight starter JSON files instantiate nothing. **GAP:** mounted owner listing/create/configuration UI.                                                                                                |
| Owner configures and publishes visibility                           | `GET /v1/zones/{id}/configuration` → `{zone,configuration,mounts}`; `PUT` same path with `{configuration,mounts}`; `POST /v1/zones/{id}:publish {visibility}` → `ZoneResponse`                                      | Same row's configuration, mounts, release digest, revision/visibility; current owner/configure/publish authority, If-Match on mutations        | Resource CAS/idempotency path exists. **GAP:** usable owner editor and its stale/denied/retry flow. Publishing site visibility does not publish Collection output or grant source rights.                                     |
| Visitor opens `/zones/{id}` or `/zones/{id}/{relativeRoute}`        | `GET /v1/zones/{id}` → `ZoneMetadataResponse`; `POST /v1/zones/{id}:readPage {target:{route},languages?}` → `ZonePageResponse` (common page plus safe `zone`)                                                       | Current Zone row/Access and configured document; active common presentation profile; no catalogue/Collection reads                             | Native static runtime and web shell/routes exist. Static succeeds only when planned reads are empty; unknown routes conceal with 404. Active profile readiness is still required.                                             |
| Configured page needs a source; visitor browses union or mount list | **GAP:** `GET /v1/zones/{id}/subjects` → selected `{subjects,next}` and `GET /v1/zones/{id}/collections` → `{collections,next}` are not mounted by current `zoneRoutes`; existing `:readPage` is the static runtime | Saved filters from pinned definitions; Commerce's current Collection source; Search's admitted plan; Zone stores descriptors, not member truth | Current source-dependent `:readPage` proves Zone readability, then gate admission: ungranted `403 platform_closed`; granted `503 semantic_not_ready`, `Retry-After: 1`. No working union/default source execution is claimed. |
| Visitor opens `/zones/{id}/subjects/{subjectId}/{view?}`            | Existing web route sends `:readPage {target:{subject,view?},languages?}` then uses common subject/view loaders                                                                                                      | Current original AND terminal subject disclosure plus real union membership and source permissions; global subject URL stays canonical         | Web shell/common-renderer route exists. **GAP:** native source eligibility and page execution; a route file is not supported dynamic behavior.                                                                                |
| Preparing / unavailable / concealed page                            | Contract requires complete `200 ZonePageResponse`, retained `202 {next}` or `503` Problem + Retry-After; web continuation handling exists                                                                           | Existing durable work/prepared results are derived; every continuation reauthorizes viewer, Zone, sources and disclosure dependencies          | **GAP:** native retained preparation and complete useful pages. Current static handler does not deliver the dynamic 202 journey. No partial document or fake empty success establishes readiness.                             |
| Owner deletes/restores; moderator withholds; terminal cleanup       | `DELETE /v1/zones/{id}` and `POST /v1/zones/{id}:restore {}` → `ZoneResponse`; **GAP:** documented takedown/release and platform purge/hold/releaseHold routes are not mounted                                      | `zones.zone` lifecycle/withholding/hold fields; current Zone roles vs separate Platform purge authority; Accounts' terminal obligation         | Resource soft-delete/restore exists. **GAP:** Zone withholding, purge/retention scheduler and complete account/source/shared-history cleanup; schema columns do not deliver those operations.                                 |

**Already-owned whole slices and gaps.** Semantic owns Zone resource/static reading and the missing admitted
membership → direct eligibility → complete page/preparation → lifecycle slice. Search supplies actual admitted
indexed execution and privacy/freshness repair; Commerce supplies current curated/built-in/published/frozen
Collection sources; Web owns owner controls, shell and visitor states. These are existing responsibilities, not
new scope. Current contracts require complete useful pages, genuine exhaustion or readiness, native name/public
Collection-count order for TypeLists, immediate privacy reductions and canonical uniqueness; historical raw-prefix
limits or sorting a truncated UUID page cannot satisfy them. Cost belongs to each admitted plan and the aggregate
common page, with bounded retained progress on existing work infrastructure, not a new service or proof campaign.

Source custody, derived index custody, completely published Collection output and terminal erasure custody remain
distinct. A readable Zone never authorizes a private mount; an index/checkpoint never certifies source permission;
site publication never certifies a Collection generation; local cleanup never certifies the shared-history or
delivery participant. At terminal deletion, only eligible de-identified public contributions/completed public
generations may survive under their owner policy; private/unlisted payload and pending generations do not.

Source basis: mounted [Zone HTTP](../../services/kernel/src/zones/http.ts),
[schemas](../../services/kernel/src/zones/contract.ts), [static runtime](../../services/kernel/src/zones/page-runtime.ts),
[resource reads](../../services/kernel/src/zones/resource-reads.ts),
[storage](../../services/kernel/db/zones/schema.sql), web [Zone read loader](../../apps/web/src/zones/zone-read.ts)
and [routed pages](../../apps/web/src/routes/zones). Reference excerpts came from the read-only
`.reference/partitioned-sitemap-feeds/openlibrary/openlibrary/templates/type/{work,edition}/view.html`
and `openlibrary/core/lists/model.py`, located through the main checkout's `.reference/INDEX.md`.
No code/product changes, owner re-testing or promotion claim accompany this inventory.
