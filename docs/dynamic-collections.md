# Dynamic Collections

This specification extends [Library and Collections](library-and-collections.md). It is specification-only: it adds no runtime route, schema, worker, definition, local query engine or parallel shelf implementation.
The first implementation scope is built-in dynamic Collections and the shared Collection members page. User-saved query runtime follows after that scope; its bounded language is specified here so later work has a closed contract.

## Model and identity

A Collection keeps one identity, curator, title, description, visibility, follow state, Zone mount, and schema.org `ItemList` surface. Membership has one of two kinds:

- **Curated:** ordered member occurrences. Repeated subject IDs are allowed. Each occurrence keeps its own ID, note, and order.
- **Dynamic:** a saved predicate evaluated against the curator's personal library facts and admitted indexed catalogue properties. A
  subject appears at most once, regardless of how many matching facts it has.

**DECIDED DTO:** `membershipKind` discriminates a union, never a bag of optional fields. Curated Collections retain required `createdAt`, `updatedAt`, `memberCount` and `orderEpoch`. Dynamic Collections omit all four; Web displays no count/time, never zero. An unrenamed dynamic `title` is null or absent; an explicit owner rename wins. Both owner and public dynamic DTOs include `builtinKind: 'everything' | 'state'`. State `builtinLabels` is the actual accepted state's standard BCP47 locale map (`zh-Hans`/`zh-Hant`, never `zh`), or `{}` when absent; Web uses its neutral Other fallback. Everything uses Web's normal localized message. Only owner discovery may include the private `builtin` tuple; public DTOs never disclose profile/state IDs, predicates, pins or release digests. No fixed vertical vocabulary is added. A dynamic member item contains `kind: "dynamic"`, its `subjectId`, and the same optional subject summary as a curated item. It has no occurrence ID, note, or added time. No route creates a pretend occurrence for a dynamic result.

The first-scope built-ins are:

1. Everything, one stable Collection identity for every account, including an empty account.
2. **One state Collection per state identity** for every library profile whose state set is in use by that account.

Built-ins are logical on reads and private by default; account setup creates no state-view fanout. Every Collection GET uses
`readOnly(pool)` and creates no header, grant, receipt, event, work intent, or other lazy write.
The private owner list `GET /v1/collections?curatorAccountId=...` includes logical Everything and proven in-use state tuples before stored rows exist, without `collection:create` or a write scope. `GET /v1/accounts/:accountId/collections` remains public-profile disclosure and honors `public_views.collections`, even for the curator.
A state set is in use when a retained personal fact's subject refers to that profile and state set; resolve its bounded states
from the exact pinned release. Retirement blocks new bindings but retained facts keep old pinned identities resolvable, including for undo.
Soft-deleted facts can keep identities resolvable for undo but never contribute membership. State listing is paged and creates no fanout.

### Logical identity and first-write materialization

Derive each built-in ID with the existing `route/route.ts` `derivedId`, owner UUID namespace, and owner's route. The exact domain-separated names are `JSON.stringify(['library.collection.builtin', 1, 'everything'])` and
`JSON.stringify(['library.collection.builtin', 1, 'state', profileId, stateSetId, stateId])`. Read and write use the same helper.
Release digest, accepting type, labels, current time, visibility, and stored/materialized state are not identity inputs; a
conflicting nonmatching row at the deterministic ID fails closed without changing the logical ID. Logical built-ins have revision 0; their first authorized owner write commits revision 1 under native CAS. Built-ins cannot be deleted. State labels and materialization never change identity.

Opaque state-ID lookup uses one owner-derived reference point `(route, collectionId)` mapping to an in-use accepted tuple. This is commerce data, not permission, membership or list authority. Only the owner's admitted fact command under the actual fact fence, or bounded native repair fenced against terminal deletion, maintains it; GET and follow never create references. Resolve one point, then apply the same existing logical-owner read/follow resource/action authorization. Unknown and denied IDs use the same one-probe concealment path, with no state-ever-used oracle or tuple-hint ABI/extra Access port. Membership still reads actual facts. No copied Definitions or historical-profile enumeration is permitted. Terminal deletion makes references unresolvable immediately and purges them boundedly; delayed repair cannot recreate a deleted owner. The reference store/producer and materializer remain implementation work.

Only the first owner WRITE that needs storage materializes a built-in, inside that write's native command. Use `parentCreationAuthorization` on the owner's account and a materializer-local `deriveAccess` that permits only that command's own write action when actor, owner, route, carried scope, and current native account authority match. Initialize the
`library.collection` resource grant in the same native transaction through existing `bound()` capability; call `shareAccount` there to fence terminal deletion, and declare `x-resource-types` on every materializing route. Follow uses its own write action
and scope; update uses `collection:update`. No `collection:read` override, `account:manage`, `account:suspend`, `gate:any`, fake actor, grant SQL, extra Access port, or eager account/state fanout is allowed. Restrict writes to Everything and proven
in-use state tuples. A logical-only source evaluates current owner facts and native authority; it never manufactures a row, grant, or ready empty result.

**DECIDED:** `Everything` contains unique subjects with at least one live personal library fact: a non-null optional entry state, one or more independent labels, a retained progress session/history record, or a retained holding. Clearing a state removes only its state-view membership; another live fact preserves Everything.
A cleared empty entry shell, follow, curated Collection occurrence, catalogue fact, rating, or published-log snapshot alone do not create presence. No additional presence flag is introduced. Removing the last live fact removes membership; soft-deleted facts never count,
even while restorable.

**DECIDED:** readable subjects need no profile for generic labels or curated occurrence add/remove; label-only subjects get no default state or state Collection. Missing/retired profiles block only NEW state/progress/holding values; historic own facts stay readable/clearable. Real visibility, scopes, CAS, deletion fences and authorization-before-receipt apply; no default/legacy fallback.
### Profile keys and release changes

Definitions remain the canonical registry. Resolve the accepted `type.profileId` reference through `TypeDefinition.library.profileId`; do not infer a profile from a type label, a vertical name, or a fixed five-state enum.
The semantic key for a state view is the scoped state identity `(profileId, stateSetId, stateId)`; stored provenance/pins identify the accepting immutable `releaseDigest`, the sole revision address.
Localized labels are presentation only and never form the key.

The persisted Collection ID is stable for the curator and built-in key; its opaque query basis pins the accepting release. A label-only release change preserves state identity and membership; no meaningRevision/profileRevision field or provider exists.
A meaning change requires an explicit bounded profile migration or a distinct state identity. Existing fixed-key state values map without semantic loss to the canonical compatibility profile by explicit migration in pages of at most `P`; labels never choose or rewrite state identities.
A retired profile is not rebound: retained facts and their state Collections keep their old pin and identity, and a profile with no retained facts creates no state views. If a pinned release is unavailable, reads fail closed for restart or repair; activation or retirement invalidates affected cursors without synchronously rewriting every account.

## One Collection page

The existing Collection resource and `GET /v1/collections/{collectionId}/members` remain the canonical page for both membership
kinds. The Web shelf page is this page for the account's built-in dynamic Collection, with no shelf template fork; it uses the actual
shared Collection page/template. The shelf has no independent list route or cursor.
Collection list and detail reads include built-ins visible to the curator. Curated response fields and occurrence
behavior remain intact. Both kinds use the same page envelope, page-size limit, filter and sort validation, subject summary
resolver, cursor codec, follow target, export, and Zone-mount identity.

| Page behavior                   | Curated                                                              | Dynamic                                                                              |
| ------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Returned identity               | one row per occurrence; duplicate `subjectId` values remain distinct | one row per unique `subjectId`                                                       |
| Default order                   | Existing Collection ordinal and occurrence-ID keyset                 | Stable subject-ID keyset                                                             |
| Note, occurrence ID, added time | Present as today                                                     | Absent                                                                               |
| Exact member total              | Existing curated `memberCount` remains exact within its cap          | Absent                                                                               |
| Membership edits                | Add, remove, move, and note edit as today                            | Add, remove, move, and note edits fail with `409 dynamic_membership_immutable`       |
| Collection metadata             | Existing title, description, visibility and revision rules           | Same rules; built-in query identity is immutable and built-ins cannot be deleted     |

The page size is `P`, `1 <= P <= 100`; a request returns at most `P` items. If bounded candidate work is exhausted first,
`members` may be empty while `next` is non-null; the cursor resumes after the last candidate examined to avoid repeating filtered
or unreadable candidates. A null cursor means exhaustion. Dynamic results promise neither a global count nor a full page.

The common filter is the existing closed shared Search/semantic filter document. A filter is accepted only when its current semantic
plan can use an indexed seek or a bounded anchored probe for each candidate. Existing integrated shelf-index helpers may supply
bounded facts as adapters, but they do not own Collection membership or establish a second list authority. The Collection layer does
not define a second property whitelist, copy private facts into Search, or add a private catalogue-holder directory. Unsupported
filter or sort shapes return `422 unsupported_query`; they never fall back to a scan, cross-partition SQL join, or full-account
sort. A sort must have a shared native order key and a stable subject-ID tiebreaker. Layout (`grid`, `list`, or `table`) is
presentation state; it does not change membership, authorization, or server paging.

Bulk selection, export, follow, and Zone mounting use the same Collection ID and shared kernel protocols. Dynamic selection
enumerates unique subject IDs, never fake occurrences. Library bulk uses its existing durable operation through a Collection source
adapter; occurrence actions remain unavailable. Export streams the same bounded page and emits subject links only. A private
Collection cannot become public through follow or mount; existing Zone rules decide mount eligibility. No local subsystem is added.

## Access and disclosure

Every dynamic Collection is private until its curator explicitly changes visibility. Reads authorize the Collection before searching
candidates. A private or unknown Collection has the same not-found response for another account and an anonymous viewer. Suspended
accounts fail closed. Changing visibility uses the existing Collection authorization and revision check. Unlisted and public
visibility continue to use the existing direct-read and listing rules.

The curator's private descriptor may identify the built-in profile and state. It never appears for another viewer. A public or
unlisted members page returns only its ordinary Collection metadata and subject summaries that pass the current viewer's native `subject:read` check. It returns no state, label, progress, holding, query body, predicate, profile pin, private candidate count, or
private member count. Collection membership never grants subject access. Filtering by an owner's personal facts remains owner-only.
These exclusions concern private fact values; the agreed `builtinKind` and accepted `builtinLabels` presentation remain public.
An inaccessible subject is omitted and consumes candidate budget just like any other rejected candidate.

Private facts and private dynamic results do not enter public Search/FTS, public Collection membership, subject Collection counts,
or other public projections. Explicitly published dynamic results use the shared monotonic public listing/projection protocol with a
per-kind dynamic adapter. Its public contribution contains only a Collection ID, unique subject IDs, and the shared protocol's
source stamp. It contains no private fact, query, state, label, progress, holding, or count of private matches. A source change,
visibility revocation, or deletion advances the authoritative source stamp. Older projection events cannot restore a withdrawn
membership. Public reads apply the current shared eligibility and subject-access checks; stale or uncertain rows are withheld until
the shared projection is safe.

Curated listing-freshness defects remain with their current owner. Shared monotonic ordering, revoke-before-disclosure, rebuild, and
bounded reconciliation still need closure before dynamic adoption. This spec adds no second public-membership table, event clock,
freshness classifier, or projection engine.

### Account deletion and adopted public output

Account deletion is terminal at fresh authentication plus typed confirmation time `T`; only `account-tombstoned.v1`
exists. There is no account restore, scheduled/cancelled event, `accountDeletionState` port, or account-generation
counter. Private, UNLISTED and already-deleted payloads hide at `T`; bounded durable purge starts at once and erases them
as work settles. The 30-day undo window applies to individual-record deletion only. Legal-hold integration is deferred from first scope; this specification requires no new hold or payload-custody engine.

**DECIDED:** Collection identities and retained sets are classified at `T`; only Collections active and PUBLIC then
survive. A public dynamic Collection freezes its last complete published subject set at its last completely published
generation. It remains read-only and de-identified, returning unique subject IDs through current viewer-native access;
private predicates and facts are not public output. Pending or unpublished generation B never replaces completed A.
Never evaluate a fresh query at `T` over undisclosed private facts; if no generation completed, no subject set is
manufactured. Private, UNLISTED and already-deleted Collections, including formerly-public ones, are erased by bounded work.

The durable terminal handoff records freeze/revoke and bounded purge work, then returns without waiting for projection consumers; the
delete response may precede purge completion. Delayed delivery cannot adopt B or resurrect erased facts. [Deletion](deletion.md)
governs individual-record tombstones and 30-day undo: restore rechecks `deleted_at`/`purge_after`/CAS and restores the same historic
fact and pin. Individual early purge needs platform permission. Takedown never schedules purge; legal-order purge needs platform authority. Business transitions define neither undo
nor purge timing, and this contract adds no lifecycle engine or synchronous wait.

## Saved-query language for the later runtime phase

First-scope runtime supports only the built-ins above. It does not expose a route that saves or runs user-authored queries. The
later query runtime uses a closed JSON AST compiled by the shared kernel query planner:

```ts
type SavedQuery =
  | { and: SavedQuery[] }
  | { or: SavedQuery[] }
  | { not: SavedQuery }
  | { predicate: { property: string; operator: string; value: unknown } };
```

The operator, property, literal, and index-plan registries are those admitted by current definitions and shared semantic/filter
contracts. This document does not add fields to those registries. The envelope is strict and rejects unknown keys, operators,
property/revision pairs, incompatible profile meanings, and values of the wrong declared type. It permits at most 4,096 canonical UTF-8 bytes, nesting depth 8, 32 leaves, and 32 values in one set-membership literal. There is no arbitrary SQL, JSONPath, regular
expression, user code, or network-backed predicate. Negation is allowed only where the shared index proves complete absence at the
bound generation; otherwise saving is rejected.

Saving compiles and validates the full AST against the exact profile and semantic release, supported index generation, visibility
policy, and owner's current allowed facts. The server stores a canonical owner-only AST and immutable query revision. An unsupported or not-ready predicate fails at save time; it is never treated as an empty result. Public publication exposes only the resulting
accessible subjects, never the AST, predicate names, private inputs, or query counts. Changing the AST, compatible profile pin, or
index basis advances the query basis and invalidates cursors. Custom query execution is not enabled until the shared planner and
native index-plan acceptance tests exist.

## Query and cursor bounds

`P` is the returned page size. Dynamic reads examine at most `C = 4P` unique subject candidates, with `C <= 400`. Catalogue residual
checks are bounded indexed lookups anchored to an already selected candidate. The owner partition is the only source for private
facts; catalogue properties use their current semantic owner. There is no cross-partition SQL join, full-account scan, OFFSET page,
exact global count, or synchronous update of every view for an account. Source-fact and profile changes update a bounded set of fact
indexes and shared projection intents. Repairs use ordered pages of at most `P`, O(P) memory, idempotent source stamps, and no
fanout transaction proportional to account size.

One shared opaque encrypted cursor binds viewer, route, Collection ID and incarnation, query revision, sort and filter, page size,
profile/release pin, source/projection generation, keyset tuple, and expiry. Anonymous binding uses `viewer: null` and its
timestamp-free token is deterministic and timeless; account-bound tokens expire after the shared 15-minute lifetime.
Retirement of a cursor key invalidates tokens for both viewer kinds.
Collections use the shared codec and key ring without local cryptography or a local TTL.
Tampering, viewer or Collection mismatch, changed query/profile/generation, and expiry fail closed with the shared cursor
errors. The token reveals no raw predicate, profile/state key, incarnation, or private candidate value. Dynamic keysets use the
stable unique subject ID; curated keysets use the existing ordinal plus occurrence ID. Pages use current-keyset semantics: there is
no cross-page snapshot. A basis change returns `409 stale_cursor`; the client starts again. It never silently switches meaning
partway through a traversal.

Growth acceptance runs native first and deep page plans at three account scales with `P` fixed: legal shared `checkGrowth`
values `64`, `512`, and `4096`.
Inputs include sparse catalogue filters, hidden subjects, filtered-empty intermediate pages, and many unrelated owner facts.
It records actual rows examined, PostgreSQL buffers, statements, and the shared cost classifier.
It proves candidate/anchor bounds and no account-size scan or join; a page size
assertion alone is insufficient.

## Acceptance outcomes

The API suites cover curated ordering, Everything/state views, profiles and old pins, overlapping labels, source changes, viewer
authorization, disclosure, Search/count isolation, query and cursor bounds, and stale projection delivery. The label outcomes also
prove read-only owner discovery and reads cause no writes, denied follow/update do not materialize, and first authorized writes keep
the logical IDs. User-saved-query runtime outcomes remain a separate later phase. Dynamic outcomes additionally require actual SQL point evidence for opaque state references, identical denied/unknown concealment, and terminal deletion defeating paused repair and follow. No runtime pass is claimed by these specifications.

## Ordered implementation plan

Each implementation landing slice is capped at eight files. Contracts and imports land before production code; do not create
parallel query, bulk, projection, or shelf machinery to avoid a missing owner import.

| Order | Owner and work                                                                                                                                                                                                                                | Expected file surface                                                                                                                                            |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Library and Definitions contract owners adopt profile/default-migration, independent-label presence, dynamic DTO, and test fixture contracts.                                                                                                 | `docs/dynamic-collections.md`, `specs/dynamic-collections-driver.ts`, `specs/dynamic-collections-outcomes.test.ts`, `specs/dynamic-collections-contract.test.ts` |
| 2     | Shared Query/List owner supplies the admitted property/filter registry, opaque cursor binding, keyset semantics, `C` budget instrumentation, and cross-partition access boundary.                                                             | `packages/filter/src/`, `services/kernel/src/tokens/cursor.ts`; shared query planner closure still required                                                                                                               |
| 3     | Definitions and Library implement the canonical profile registry and explicit default migration, then independent labels; retain old immutable pins and keep migration work paged.                                                            | Existing profile compiler/release, Library fact model and migration code plus their acceptance owners                                                            |
| 4     | Library Collection owner adds built-in identity/read adapters to the existing Collection model, routes, reader, and indexed fact sources. Curated commands and DTOs retain their present contracts.                                           | `services/kernel/src/library/collection-model.ts`, `collection-routes.ts`, `collection-reads.ts`, one migration, one indexed dynamic-member query                |
| 5     | Shared listing-freshness owner closes the existing monotonic protocol gap; Library adds only a dynamic per-kind adapter and terminal freeze/revoke input. Account deletion owns the bounded durable handoff.                                  | `services/kernel/src/library/listing.ts`, `listing-freshness-contract.ts`; Access events/port and protocol closure required                                                                                         |
| 6     | Existing Library bulk owner admits unique dynamic Collection selection through its durable operation contract. No new workflow, manifest, cursor, or retention subsystem.                                                                     | `services/kernel/src/library/bulk-contract.ts`, `bulk-contract.md`; these specify work, not an implemented shared engine                                                                                                 |
| 7     | Web owner adapts the existing CollectionView surface, `CollectionPage` in `apps/web/src/library/collection-page.tsx`, loaded by `collection-load.ts` and `collection.ts` and rendered at `/collections/$id`; the library shelf remains `ShelfView` in `shelf-view.tsx`, `shelf-rows.ts` and `/library`. Keep both addresses and avoid a template fork. Retire `/library/shelf` client/API/tests after the shared engine is live. | `apps/web/src/library/collection-page.tsx`, `apps/web/src/library/collection-load.ts`, `apps/web/src/library/collection.ts`, `apps/web/src/library/shelf-view.tsx`, `apps/web/src/library/shelf-rows.ts`, `apps/web/src/routes/library/index.tsx`, `apps/web/src/routes/collections/$id.tsx` |
| 8     | Library, Shared Query/List, Shared Projection, Account Deletion, Bulk, and Web owners run real acceptance suites and three-scale first/deep-page growth checks before enabling the route.                                                     | No extra files without an import or failing acceptance that needs them                                                                                           |

The eight ordered owner groups keep each landing slice within eight files. Confirmed Web paths above identify existing sources; proposed migrations/adapters and shared query/list/bulk/projection engines remain implementation work and must follow their owner contracts.

## Decisions fixed by this specification

- Empty accounts have one private Everything identity and no state views. Everything presence includes state, labels,
  sessions, or holdings, so clearing a state alone does not erase remaining library presence.
- Built-in state identities use the canonical profile/state registry and stored accepting release pins, never a global vocabulary or
  localized labels. Old pins survive activation and retirement without reinterpretation.
- Dynamic results are unique subjects. Curated duplicate occurrences and their notes/order remain unchanged.
- A query-basis mutation invalidates the old cursor with `stale_cursor`; pagination does not promise a snapshot.
- Public dynamic output is only accessible subject membership. On terminal account deletion,
  only active-PUBLIC output retains its last complete published generation; private payload hides at `T` and is erased by bounded work, with durable handoff waiting for no consumer.
- User-authored queries are defined as a bounded later runtime phase and are not first-scope outcomes.
