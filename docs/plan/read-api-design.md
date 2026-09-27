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
| `/v1/works` | language, cursor; recent public Work cards, no phrase required | Current Work heads, publication disclosure, batched summaries/media |

If several supported rating Contexts exist, callers select one from the Context
collection; the aggregate never silently chooses a question. Global has a 1–5
scale and Realm standing ratings 1–10. Personal classification decisions are
not defined, so Mine is rejected on that collection. Classification scope
switching preserves local rejection and Global inheritance. Recent means latest
metadata revision, ordered by retained restore-lineage rank, descending sequence
and Work IRI; up to 32 restore edges are admitted. History currently uses stable
revision-IRI order and returns sequence explicitly; a chronological history view
belongs with the full history owner below.

The Overview consumes the header, credits, ratings, classifications and adoption
resources concurrently. The Versions tab consumes its own page. Contents,
Discussion and comprehensive History require the next owners; the template does
not invent a Work-to-composition or Work-to-discussion-root mapping.

## Cost and evidence

`WORK_READ_COST` enforces 20 returned candidates, 160 graph calls, 4 MiB graph
bytes and a 10-second graph deadline; each new direct query is capped at 512 KiB.
Exceeding the envelope withholds the response. Existing Access and object adapters
retain their own time/byte limits; there is no new remote retry loop. The header
uses five graph calls, checked by the native test. Simple pages add one candidate
query and one bounded hydration batch (public Realm names add their owner reads).
Recent adds one capped lineage query, one candidate query, one type batch and two
summary batches between position fences. Hydration is O(P) for P ≤ 20, with
O(P × 3) type comparisons. Classification composes at most 20 existing resolutions,
one exact support association/batch and up to 512 judgment checks; the owner's
support overflow is a budget failure, not an exact empty page. Ratings reuse
100 sealed slots, one graph snapshot and 512 KiB of verified manifests; Mine
verifies that same complete population before reducing only its own slot.

These are logical/output bounds. Native Jena may scan and sort N eligible heads
for recent discovery (O(N log N) conservative bound), or D relation candidates
for a high-degree Work (O(D log D)); LIMIT does not prove indexed early stopping.
The first template is **not** large-corpus cost qualification. A measured browse
projection/index is a follow-up before scaling Discover. Tests exercise native
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
| Reader: `routes/work-contents.ts`, `modules/work-contents/**`, `tests/work-contents*.ts` | `GET /works/{id}/contents?version&language&cursor`; `GET /chapters/{id}?revision&language` returns body, selected basis, previous/next. Define Work→composition selection and reuse composition page/exact Content/progress APIs. | ≤20 occurrences; one verified body ≤1 MiB; no recursive flattening; targets admitted individually, selected version and language bound in cursor. |
| Discussion/history: `routes/work-activity.ts`, `modules/work-activity/**`, `tests/work-activity*.ts` | `GET /works/{id}/discussion?realm&cursor`, `/history?kind&cursor`; reviewed replies and public revision/decision events. Replace template metadata-only history at integration. | ≤20 records; current public review/admission on each item; hidden actors and unreleased bodies excluded. History index required for chronological scans across epochs. |
| Discovery filters: `routes/discovery.ts`, `modules/discovery/**`, `tests/discovery*.ts` | Extend `/works?sort=recent|top-rated&type&term&scope`; preserve `POST /queries` phrase profiles and exact/lower-bound counts with matched-field/decision reasons. | Indexed eligible read projection with a measured seek+P bound; never synchronously aggregate all Work ratings. Depends on rating selection policy and classification query semantics, not reader/profile tasks. |
| Agent/profile/library: `routes/profiles.ts`, `modules/profiles/**`, `tests/profiles*.ts` plus separately claimed Agent/address owners | `GET /agents/{id}`, `/handles/{handle}`, `/agents/{id}/works`, `/agents/{id}/collections`, `/me/contributions`, `/me/ratings`; public display name/kind/handle, attribution, shelf cards and ratings. Define native credit links, handle allocation and public profile disclosure first. | ≤20 items, batch summaries; public/private collection partition before pagination, Account identity and private contributions require current principal/representation proof. Reuse collections and ratings. |
| Realm home/log: `routes/realm-reads.ts`, `modules/realm-reads/**`, `tests/realm-read*.ts` | `GET /realms/{id}`, `/realms/{id}/works`, `/realms/{id}/decisions`; name, description/banner/rules, membership summary, public moderators, adoption/classification/rule-change events. Reuse public Realm summary and selection owners. | ≤20 records; count owner must distinguish exact/unknown; private roster grants do not imply public membership. Implement a public decision index, then add leased private Realm reads separately. |
| Management: `routes/management-reads.ts`, `modules/management-reads/**`, `tests/management-read*.ts` | `GET /realms/{id}/moderation?state&type&cursor`, `/realms/{id}/audit?kind&cursor`; actionable report/contribution/correction items and audited outcomes. | Indexed state/type+ID seeks ≤20; moderator admission and final revocation fence; no public alias for private queues or audit actors. Reuse report/review/admission owners. |
| Metadata completeness: separately claim Work metadata/model, Agent credit and classification owners | Original-language title and localized metadata writes, native Agent credits/handles, bibliographic editions, and a defined relevance policy. The template's null fields can become meaningful only with these writes. | Owner schema and command validation precede reader extensions; no derived display value presented as recorded fact. |

G-214 owns `scripts/qa/acceptance.ts` during this wave. Register
`services/main/tests/work-read.integration.test.ts` in its integration gate list
at integration. Its isolated native probe currently runs through a temporary
worktree Task wrapper because the standard Goal QA-slot wrapper writes in the
read-only main checkout. The manager should run the normal registered tier and
the affected-plan remainder after merge.
