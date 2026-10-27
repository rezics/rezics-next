# Dynamic Collections

This specification extends [Library and Collections](library-and-collections.md). It is specification-only: it adds no runtime route, schema, worker, definition, local query engine
or parallel shelf implementation.
The first implementation scope is built-in dynamic Collections and the shared Collection members page.
User-saved query runtime follows after that scope; its bounded language is specified here so later work has a closed contract.

## Model and identity

A Collection keeps one identity, curator, title, description, visibility, follow state, Zone mount, and schema.org `ItemList`
surface. Membership has one of two kinds:

- **Curated:** ordered member occurrences. Repeated subject IDs are allowed. Each occurrence keeps its own ID, note, and order.
- **Dynamic:** a saved predicate evaluated against the curator's personal library facts and admitted indexed catalogue properties. A
  subject appears at most once, regardless of how many matching facts it has.

Curated Collections continue to use their existing identity and wire shape. Dynamic Collection metadata adds a `membershipKind:
"dynamic"` discriminator and an owner-only built-in descriptor; it omits `memberCount`. A dynamic member item contains `kind:
"dynamic"`, its `subjectId`, and the same optional subject summary as a curated item. It has no occurrence ID, note, or added time.
No route creates a pretend occurrence for a dynamic result. Public responses omit the built-in descriptor and all predicate details.

The first-scope built-ins are:

1. Everything, one stable Collection identity for every account, including an empty account.
2. **One state Collection per state identity** for every library profile whose state set is in use by that account.

Built-ins are private by default. They are resolved lazily: account setup creates no state-view fanout; reading or following a
built-in materializes only that identity. A state set is in use when the account has any retained personal library fact for a
subject whose accepted type refers to that profile and state set. Resolve the bounded state list from the exact accepted profile
release pinned by those facts. A profile with no personal facts creates no state Collections. Retirement blocks new profile bindings
but does not erase or rebind retained facts; their old pinned state identities remain resolvable, including lazy materialization.
Listing state Collections is paged and does not eagerly create every possible Collection for the account.

`Everything` contains the unique subjects with at least one current personal library fact: a non-null optional entry state, one or
more independent labels, a retained progress session/history record, or a retained holding. Clearing a state removes that state-view
membership. It does not remove the subject from `Everything` while any label, session, or holding remains. A cleared empty entry
shell contributes nothing. Removing the last personal fact removes the subject from `Everything`.
A follow, curated Collection occurrence, catalogue fact, rating, or published-log snapshot alone does not create library presence. No additional presence flag is introduced.

### Profile keys and release changes

Definitions remain the canonical registry. Resolve the accepted `type.profileId` reference; do not infer a profile from a type
label, a vertical name, or a fixed five-state enum. The semantic key for a state view is the scoped state identity
`(profileId, stateSetId, stateId)` plus the compatible state meaning in the accepted profile release.
Localized labels are presentation only and never form the key.

The persisted Collection ID is stable for the curator and built-in key. Its query basis pins the profile release and state meaning.
A compatible release can continue an existing pin; a label-only change cannot alter membership.
A meaning change requires an explicit bounded profile migration or a distinct state identity. Existing fixed-key state values map without semantic loss to the canonical compatibility profile by explicit migration in pages of at most `P`;
labels never choose or rewrite state identities.
A retired profile is not rebound to the currently active profile: retained facts and their state Collections keep their old pin and identity, and no profile with no retained facts creates state views.
If the pinned release is unavailable, the read fails closed and requests a restart or repair; it never guesses a replacement
meaning. Profile activation or retirement changes the profile generation and invalidates affected cursors without synchronously
rewriting every account.

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
| Exact member total              | Existing curated `memberCount` remains exact within its cap          | Not returned unless a bounded maintained projection explicitly proves an exact value |
| Membership edits                | Add, remove, move, and note edit as today                            | Add, remove, move, and note edits fail with `409 dynamic_membership_immutable`       |
| Collection metadata             | Existing title, description, visibility and revision rules           | Same rules; built-in query identity is immutable and built-ins cannot be deleted     |

The page size is `P`, `1 <= P <= 100`. A request returns at most `P` items. If bounded candidate work is exhausted before the page
fills, `members` may be empty while `next` is non-null; the cursor resumes after the last candidate examined, not the last returned
item. This prevents repeating filtered or unreadable candidates. A null cursor means the candidate range is exhausted. Dynamic
results do not promise a global count or a full page.

The common filter is the existing closed shared Search/semantic filter document. A filter is accepted only when its current semantic
plan can use an indexed seek or a bounded anchored probe for each candidate. Existing integrated shelf-index helpers may supply
bounded facts as adapters, but they do not own Collection membership or establish a second list authority. The Collection layer does
not define a second property whitelist, copy private facts into Search, or add a private catalogue-holder directory. Unsupported
filter or sort shapes return `422 unsupported_query`; they never fall back to a scan, cross-partition SQL join, or full-account
sort. A sort must have a shared native order key and a stable subject-ID tiebreaker. Layout (`grid`, `list`, or `table`) is
presentation state; it does not change membership, authorization, or server paging.

Bulk selection, export, follow, and Zone mounting use the same Collection ID and shared kernel protocols. Dynamic selection
enumerates unique subject IDs. It does not select fake occurrences. Library-level bulk actions use the existing durable operation,
authorization, idempotency, cancellation, and per-target outcome contract through a Collection source adapter owned by the Library
bulk contract. Collection occurrence actions remain unavailable for dynamic members. Export streams the same bounded page and emits
subject links only. A private Collection cannot become public through a mount or follow. Existing Zone rules decide which published
Collections are eligible for mounting. No query-local bulk, export, follow, or retention subsystem is added here.

## Access and disclosure

Every dynamic Collection is private until its curator explicitly changes visibility. Reads authorize the Collection before searching
candidates. A private or unknown Collection has the same not-found response for another account and an anonymous viewer. Suspended
accounts fail closed. Changing visibility uses the existing Collection authorization and revision check. Unlisted and public
visibility continue to use the existing direct-read and listing rules.

The curator's private descriptor may identify the built-in profile and state. It never appears for another viewer. A public or
unlisted members page returns only its ordinary Collection metadata and subject summaries that pass the current viewer's native `subject:read` check. It returns no state, label, progress, holding, query body, predicate, profile pin, private candidate count, or
private member count. Collection membership never grants subject access. Filtering by an owner's personal facts remains owner-only.
An inaccessible subject is omitted and consumes candidate budget just like any other rejected candidate.

Private facts and private dynamic results do not enter public Search/FTS, public Collection membership, subject Collection counts,
or other public projections. Explicitly published dynamic results use the shared monotonic public listing/projection protocol with a
per-kind dynamic adapter. Its public contribution contains only a Collection ID, unique subject IDs, and the shared protocol's
source stamp. It contains no private fact, query, state, label, progress, holding, or count of private matches. A source change,
visibility revocation, or deletion advances the authoritative source stamp. Older projection events cannot restore a withdrawn
membership. Public reads apply the current shared eligibility and subject-access checks; stale or uncertain rows are withheld until
the shared projection is safe.

Curated listing-freshness defects remain with their current owner. Dynamic Collections adopt the shared protocol only after its
monotonic ordering, revoke-before-disclosure, rebuild, and bounded-reconciliation requirements are met. This spec does not add a
second public-membership table, event clock, or freshness classifier.

### Account deletion and adopted public output

Account deletion erases private library facts and every private dynamic predicate. A private Collection is removed under the
existing bounded cleanup protocol. An explicitly public or unlisted dynamic Collection with an activated public projection is an
adopted public contribution. Deletion freezes its last complete published subject set, metadata, and Collection identity as a
read-only public Collection. The retained set is unique subjects only; the predicate and all private facts are erased. Public
readers continue to check each subject with their own current access. No `memberCount` or private predicate is retained. A
publication that never activated a complete public generation has no adopted subject set and is withdrawn during deletion.

The account-deletion barrier records the terminal freeze/revoke intent and private cleanup checkpoints durably, then returns without waiting for projection consumers.
Consumers converge later through the shared monotonic protocol. Events older than the terminal stamp
are ignored, so deleted facts cannot restore membership. Missing private facts never mean “the current query matches nothing,” and a
saved predicate is never retained to reconstruct membership. The public contribution is the last completely activated output;
unprojected work was not yet published and is not promised as part of the retained set.

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

Growth acceptance runs native first and deep page plans at three account scales with `P` fixed.
Inputs include sparse catalogue filters, hidden subjects, filtered-empty intermediate pages, and many unrelated owner facts.
It records actual rows examined, PostgreSQL buffers, statements, and the shared cost classifier.
It proves candidate/anchor bounds and no account-size scan or join; a page size
assertion alone is insufficient.

## Acceptance outcomes

The real API suite in [the dynamic Collection driver contract](../specs/dynamic-collections-driver.ts) covers curated duplicates,
order, notes, follow and mount; Everything and profile state views through the same page and cursor; game, recipe, and record
profiles; overlapping labels and optional state; profile activation, retirement, and old pins; empty accounts; source-fact changes;
owner, other, anonymous, and suspended viewers; viewer-native subject access; private-query non-leakage; public-subject-only output;
Search/count isolation; candidate caps and unsupported shapes; cursor viewer, Collection, query, expiry, and key-rotation binding;
and deletion with stale projection events. User-saved-query runtime outcomes are deliberately absent from this first-scope suite and
remain a separate later phase.

## Ordered implementation plan

Each implementation landing slice is capped at eight files. Contracts and imports land before production code; do not create
parallel query, bulk, projection, or shelf machinery to avoid a missing owner import.

| Order | Owner and work                                                                                                                                                                                                                                | Expected file surface                                                                                                                                            |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Library and Definitions contract owners adopt profile/default-migration, independent-label presence, dynamic DTO, and test fixture contracts.                                                                                                 | `docs/dynamic-collections.md`, `specs/dynamic-collections-driver.ts`, `specs/dynamic-collections-outcomes.test.ts`, `specs/dynamic-collections-contract.test.ts` |
| 2     | Shared Query/List owner supplies the admitted property/filter registry, opaque cursor binding, keyset semantics, `C` budget instrumentation, and cross-partition access boundary.                                                             | Existing shared filter/query and cursor files only                                                                                                               |
| 3     | Definitions and Library implement the canonical profile registry and explicit default migration, then independent labels; retain old immutable pins and keep migration work paged.                                                            | Existing profile compiler/release, Library fact model and migration code plus their acceptance owners                                                            |
| 4     | Library Collection owner adds built-in identity/read adapters to the existing Collection model, routes, reader, and indexed fact sources. Curated commands and DTOs retain their present contracts.                                           | `services/kernel/src/library/collection-model.ts`, `collection-routes.ts`, `collection-reads.ts`, one migration, one indexed dynamic-member query                |
| 5     | Shared listing-freshness owner closes the existing monotonic protocol gap; Library adds only a dynamic per-kind adapter and terminal freeze/revoke input. Account deletion owns the bounded durable handoff.                                  | Existing shared projection and deletion entrypoints; one Library adapter                                                                                         |
| 6     | Existing Library bulk owner admits unique dynamic Collection selection through its durable operation contract. No new workflow, manifest, cursor, or retention subsystem.                                                                     | Existing bulk contract, route/worker, and their acceptance tests                                                                                                 |
| 7     | Web owner renders the built-in Collection ID in the actual shared page/template with no shelf template fork. Retire `/library/shelf` client/API/tests after the shared engine is live; a temporary alias may delegate to its page and cursor. | `apps/web/src/library/collection-page.tsx`, `apps/web/src/routes/library/index.tsx`, existing shelf loader/client only as required                               |
| 8     | Library, Shared Query/List, Shared Projection, Account Deletion, Bulk, and Web owners run real acceptance suites and three-scale first/deep-page growth checks before enabling the route.                                                     | No extra files without an import or failing acceptance that needs them                                                                                           |

The plan has eight ordered owner groups and keeps each landing slice within eight files. Exact code paths must be confirmed from
imports in the owning branch before implementation. If an owner contract is not present, adopt it first; do not duplicate its
protocol locally.

## Decisions fixed by this specification

- Empty accounts have one private Everything identity and no state views. Profile use includes state, labels, sessions, or holdings,
  so clearing a state alone does not erase remaining library presence.
- Built-in state identities use the canonical profile/state registry and compatible semantic meaning, never a global vocabulary or
  localized labels. Old pins survive activation and retirement without reinterpretation.
- Dynamic results are unique subjects. Curated duplicate occurrences and their notes/order remain unchanged.
- A query-basis mutation invalidates the old cursor with `stale_cursor`; pagination does not promise a snapshot.
- Public dynamic output is only accessible subject membership. On account deletion an activated public/unlisted output freezes as an
  adopted unique-subject contribution; private facts and predicates are erased, and deletion does not wait for downstream consumers.
- User-authored queries are defined as a bounded later runtime phase and are not first-scope outcomes.
