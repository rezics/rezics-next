# Main-site read APIs

G-212 implementation/design, 2026-09-27. This is a dispatch map; remove sections
as their owner contracts and tests take over. Main owns admission and selection;
Server Components consume typed Main responses in parallel.

## Verified starting point

`routes/works.ts` has writes and exact revision, translation-link, derivation and
release reads, but no Work item/list read. `resources.ts` supplies summaries,
previews, avatar selection and sitemap; its batch names Work/MainVersion, Realm,
Space, Concept and semantic resources, **not Agent profiles**. Realm names already
have a public owner reader behind summaries. `agents.ts` creates Agents; Access
Agent-control reads are authority tools, not public profiles. No public Realm
home, Agent/user inventory, my-Works/contributions list, moderation queue or
general audit-log collection was found. Collections/compositions, report items,
Realm reply items/counts and private progress already have reads. Phrase search
in `api-contract.ts` requires 2–80 characters.

The Work metadata profile currently stores an English title and semantic types;
it has no original-title marker or Main Version label. AuthorCredit records are
confirmed external author references; they are not native Agents. Agent creation
stores a display name but no handle. Classification acceptance is not a numeric
relevance score. The template returns explicit nulls for these absent meanings,
instead of manufacturing values. Native versions are published contributions
and fixed releases; a language difference alone is not a translation assertion.
Bibliographic editions require a separate owner contract.

## Shared read contract

- UUID paths identify resources; response identities remain native IRIs. Resolve
  `/w/{slug}` through existing `GET /v1/addresses/work/{slug}` first. Slugs never
  become alternate Work identities.
- Collections accept `limit` (1–20, default 20) and an opaque `cursor`. They return
  `{items,nextCursor,sourcePosition,count:{value,kind:'exact-page',total:null}}`.
  Empty admitted pages can still have a next cursor. No estimated corpus total
  is implied. Native relations choose a page before hydration; clients never
  download a collection to paginate it locally.
- Encrypted cursors bind the collection, filters and graph epoch/sequence. A
  changed graph returns 409 and requires a fresh page; malformed, cross-query or
  restarted-process cursors return 400. This conservative template sacrifices
  continuation availability during writes. A later indexed snapshot owner can
  replace it without changing client pagination. Every page rechecks admission.
- `scope=global|realm|mine`; Realm requires its IRI, Mine requires a bearer and
  `actingSubject`. Global is an independent population; Mine means this Account
  principal's standing Global rating, never an aggregate of private Realms.
  The initial Realm reads admit public active Realms only. Private Realm reads
  need a future Access read-lease owner; even members currently receive 404 here.
- Public Works require a current reviewed Main selection and current public
  contribution publication. Private Work metadata requires current Access
  `work.read` authority, rechecked after hydration. Draft bodies never appear.
  Erased Content pins and graph protection exclude the Work. Existing summary
  ownership supplies covers and the Access title-restriction fence. A missing
  Work and a denied Work share 404. Source damage is 503, budget excess 422.
- Every operation checks graph lineage/restore hold and fences the result against
  a final graph position; authenticated reads also fence principal activation.
  Responses use `no-store`. Data is independently consistent per resource call;
  a page may compare `sourcePosition` when it needs a single shared basis.

Pagination follows [AIP-158](https://google.aip.dev/158): bounded collections,
opaque continuation and authorization on every request. Keyset ordering uses
explicit order keys and an IRI tie-breaker because SPARQL requires explicit
[solution ordering](https://www.w3.org/TR/sparql11-query/#modOrderBy).
Sources consulted 2026-09-27; these are semantic guidance, not Jena cost evidence.

## Implemented Work template

Schemas live in `services/main/src/modules/work/read-contract.ts`; routes export
concrete response schemas through `MainApp`, including optional bearer OpenAPI
security. `services/main/tests/work-read.test.ts` compiles a web-style
`treaty<MainApp>` consumer. Existing low-level endpoints remain available.

| GET path | Parameters and result | Existing owner reused |
| --- | --- | --- |
| `/v1/works/{id}` | `language`, optional authenticated reader; localized title/fallback basis, types, cover, current MainVersion/revision, selected language, nullable original title/Main label, links | Resource summary, media and Access; replaces the Work page's generic resource lookup |
| `/v1/works/{id}/versions` | cursor, `kind=text-variant|release`, `contentLanguage`; published contribution/release IDs, exact revision, language, selected flag | Publication selections and fixed-release graph; body/exact release endpoints stay separate |
| `/v1/works/{id}/rating-contexts` | scope, cursor; supported standing Contexts with question and scale | Global and Realm rating Context owners |
| `/v1/works/{id}/ratings` | scope, optional `context`; count, mean, full discrete distribution and actual scale; `no-context` differs from an empty population | The sealed Access inventory and verified rating snapshot used by Global/synthesis APIs; one adapter adds Realm-only and own-slot reductions |
| `/v1/works/{id}/classifications` | Global/Realm scope, language, cursor; accepted senses/concepts, localized name, decision/source, nullable relevance | Existing classification resolver, post-cutover exact Statement supports and Access judgment protection |
| `/v1/works/{id}/adoptions` | language, cursor; public Realm names, exact selection, contribution and language | Realm selection and public Realm summary owners |
| `/v1/works/{id}/credits` | cursor; confirmed external author references, explicit null native Agent/name/handle | Existing AuthorCredit current/revision projection |
| `/v1/works/{id}/history` | cursor; metadata revision identities, epoch/sequence and exact-read links | Work revision anchors; no unreviewed historical text or private audit actors |
| `/v1/works` | scoped recent/top-rated public Work cards, type/Sense filters, language, cursor; no phrase required | Discovery generation, current publication/protection fences, batched summaries/media |

If several supported rating Contexts exist, callers select one from the Context
collection; the aggregate never silently chooses a question. Global has a 1–5
scale and Realm standing ratings 1–10. Personal classification decisions are
not defined, so Mine is rejected on that collection. Classification scope
switching preserves local rejection and Global inheritance. Recent means latest
metadata revision, ordered by retained restore-lineage rank, descending sequence
and Work IRI; up to 32 restore edges are admitted. The template History used
stable revision-IRI order; G-236 replaces that ordering below.

The Overview consumes the header, credits, ratings, classifications and adoption
resources concurrently. The Versions tab consumes its own page. Contents uses
the current Main Version's Book composition. G-236 uses Realm reply placements
whose exact root is the Work IRI. Its History is ordered
by retained restore epoch, graph sequence and event IRI; it exposes metadata
revision identities, current public publication decisions and currently released
reply placements. Actor identities and unreleased reply bytes stay out of both
feeds.

## Cost and evidence

`WORK_READ_COST` enforces 20 returned candidates, 160 graph calls, 4 MiB graph
bytes and a 10-second graph deadline; each new direct query is capped at 512 KiB.
Exceeding the envelope withholds the response. Existing Access and object adapters
retain their own time/byte limits; there is no new remote retry loop. The header
uses five graph calls, checked by the native test. Simple pages add one candidate
query and one bounded hydration batch (public Realm names add their owner reads).
Discovery now reads its indexed projection before two summary batches between
position fences; its build and cost evidence are owned below. Hydration is O(P)
for P ≤ 20. Classification composes at most 20 existing resolutions,
one exact support association/batch and up to 512 judgment checks; the owner's
support overflow is a budget failure, not an exact empty page. Ratings reuse
100 sealed slots, one graph snapshot and 512 KiB of verified manifests; Mine
verifies that same complete population before reducing only its own slot.

These are logical/output bounds. Native Jena may scan and sort D relation
candidates for a high-degree Work (O(D log D)); LIMIT does not prove indexed
early stopping. The first template is **not** large-corpus cost qualification.
The discovery owner separately measures its PostgreSQL page seeks; graph build
enumeration remains unqualified at large corpus sizes. Tests exercise native
Jena/Access/Content, cursor continuation, private/erased exclusion, missing-title
translation, Global/Realm/Mine distributions, concurrent revocation and restore.
No bulk fixture preparation is needed for these correctness probes.

## Dispatch remaining families

Every proposed collection uses the same cursor envelope; every direct read is
one exact resource with a byte budget. No task may expose private Account data
as an Agent profile. The following owners can run in parallel after this template
lands; composition-root additions follow the worker protocol.

| Task / claimable paths | API/result and dependencies | Cost/disclosure contract to implement |
| --- | --- | --- |
| Reader: `routes/work-contents.ts`, `modules/work-contents/**`, `tests/work-contents*.ts` | `GET /works/{id}/contents?version&language&parent&cursor`; `GET /chapters/{id}?revision&language` returns body, selected basis, previous/next and progress identity. The version is the current Main Version; the chapter revision is a stale guard on the current composition head. | ≤20 occurrences per parent; one verified body ≤1 MiB; no recursive flattening; targets admitted individually, Main Version, parent and language bound in cursor. |
| Discussion/history: `routes/work-activity.ts`, `modules/work-activity/**`, `tests/work-activity*.ts` | `GET /works/{id}/discussion?realm&cursor`, `/history?kind&cursor`; reviewed Realm replies and public revision/decision events. The template metadata-only route is replaced. | ≤20 candidates, ≤4 MiB Content batch and exact active placement/review checks; hidden actors and unreleased bodies excluded. The retained-epoch graph query sorts Work-scoped candidates in O(H log H) native work for H events. An indexed chronological seek remains a separate large-corpus task. |
| Discovery filters: `routes/discovery.ts`, `modules/discovery/**`, `tests/discovery*.ts` | `/works?sort=recent|top-rated&type&term&scope&context`; explicit standing rating Context for top-rated/Mine, Sense term, decision reasons, exact page and cumulative exact/lower-bound match counts. Phrase profiles are preserved. | Access migration 315 and explicit bounded build/activation APIs provide the eligible projection. Native tests measure one seek and ≤21 candidates for every filter/order combination. Graph or relevant Access changes invalidate the generation; refresh is explicit. GET never aggregates Work ratings. |
| Agent/profile/library: `routes/profiles.ts`, `modules/profiles/**`, `tests/profiles*.ts` plus separately claimed Agent/address owners | `GET /agents/{id}`, `/handles/{handle}`, `/agents/{id}/works`, `/agents/{id}/collections`, `/me/contributions`, `/me/ratings`; public display name/kind/handle, attribution, shelf cards and ratings. Define native credit links, handle allocation and public profile disclosure first. | ≤20 items, batch summaries; public/private collection partition before pagination, Account identity and private contributions require current principal/representation proof. Reuse collections and ratings. |
| Realm home/log: `routes/realm-reads.ts`, `modules/realm-reads/**`, `tests/realm-read*.ts` | `GET /realms/{realm}`, `/realms/{realm}/works`, `/realms/{realm}/decisions`; public Space name/icon, adopted Works, adoption/classification/semantic-Context-rule revisions. Description, banner, community rules, public moderators and public roster have no published owner yet, so the header reports null or unknown rather than inferring them from Access grants. | ≤20 records and exact page count, unknown membership total. Public graph revisions supply the decision relation without receipts or private actors; the first implementation has an O(D log D) scan/sort bound for D eligible revisions, not a measured seek bound. A materialized public decision index and public community-rule/roster publication need separate write owners before large-scale browsing or those fields become available. Private Realm reads need an Access lease owner. |
| Management: `routes/management-reads.ts`, `modules/management-reads/**`, `tests/management-read*.ts` | `GET /realms/{realm}/moderation?state&type&cursor` pages Realm-scoped governance report cases; `/realms/{realm}/audit?kind&cursor` pages attributable governance and organization-publication decisions. A Realm governance reader must represent an active Agent with `governance.moderate` on `governance:realm:{realm IRI}`. | ≤20 rows; private, no-store; final Access authority and graph Realm/restore checks. The existing Access indexes seek by scope/state/time (case) or scope/time (decision); kind filtering can scan earlier nonmatches, bounded by the 5-second SQL statement timeout. The cursor binds the graph position and selected Access head identities. Pending contribution and correction queues need their own Realm-keyed owner indexes and admission contract; they are not represented as empty report pages. |
| Metadata completeness: separately claim Work metadata/model, Agent credit and classification owners | Original-language title and localized metadata writes, native Agent credits/handles, bibliographic editions, and a defined relevance policy. The template's null fields can become meaningful only with these writes. | Owner schema and command validation precede reader extensions; no derived display value presented as recorded fact. |

The reader selects the one Book composition attached to the Work's current Main
Version. Native text contributions and fixed releases do not own separate
compositions, so a `version` naming either is unavailable. The `parent` query
pages one group; previous/next stay among the group's eligible chapter siblings.
Chapter targets are public only while a current Content publication has public
eligibility. This permits a published Post chapter without inventing a separate
Main selection for the Post. An authenticated reader can see a target under
current `work.read` authority, but chapter bodies still require that public
Content publication. Progress remains private through the existing composition
occurrence API, using the returned occurrence and selected Content revision.
One parent page uses a Structure tree range and at most 20 target/publication
checks; a chapter does one exact Content read and checks at most 20 sibling
candidates per direction. The native sibling query may sort D placements for a
high-degree parent (conservatively O(D log D)); this is a logical bound, not
large-corpus Jena qualification. A reader navigation index is needed if measured
high-degree parents exceed the 10-second read deadline.

G-240 implements the existing Access governance cases and decisions as private
Realm reads. The earlier management row described pending contribution and
correction items as if Realm-keyed owner indexes and review admission already
existed. They do not, so the API accepts report-case types only; it does not
return an empty page for unsupported queue types. The report writer currently
accepts a caller-supplied authority scope: only reports written with the exact
`governance:realm:{realm IRI}` scope and matching Realm context appear here.
An owner change must enforce that relationship before this queue can claim
complete Realm report coverage. The selected Access head identities are a
conservative cursor fence for current writes; a durable Realm read revision is
needed for precise continuation across every Access update at scale. G-250 owns
those follow-up indexes and report-scope enforcement.

G-237's expanded claim implemented the missing projection as a separate derived
family. The [discovery owner](../../services/main/src/modules/discovery/README.md)
records the rating/population choices, build/refresh procedure and cost limits;
the [contract](../../services/main/src/modules/discovery/contract.ts) and
[native test](../../tests/qa/integration/discovery-projection.test.ts) carry the
schemas and assertions. QA `20260927t162614-85bc8d` passed native disclosure,
Global/Realm/Mine, migrated classification protection, concurrent activation,
lease recovery and first/deep page plans over 20,000 Works/80,000 index entries.
The Work template now explicitly builds discovery generations; its integration
passed in `20260927t162237-c0a66b`. The discovery fixture must run alone until the
manager adds it to `isolatedIntegrationFiles` in `scripts/qa/core.ts` (G-244's
claim during this implementation). The integration-directory path is already
discovered by the QA tier; no acceptance case ID was assigned by this brief.

`services/main/tests/work-read.integration.test.ts` is registered in the QA
integration gate and isolated-project lists: its classification cutover and
restore probes require a fresh dataset. G-214's typed acceptance case descriptions
are separate from executable test registration. The native probe passed all 59
assertions in QA run `20260927t155248-dd7bf5` with `REZICS_QA_SHARDS=2`.
The worktree Task adapter redirected only QA-slot bookkeeping into this worktree
because the main checkout is read-only to this worker; the ordinary QA harness
handled startup, bootstrap, test execution, artifacts and teardown. The manager
should run the registered test and affected-plan remainder after merge.
