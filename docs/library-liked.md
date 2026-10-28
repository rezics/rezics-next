# Liked Collection

This document adopts Liked's built-in identity, owner wire and membership contract. It extends
[Library and Collections](library-and-collections.md) and [Dynamic Collections](dynamic-collections.md);
their existing curated, Everything and state outcomes remain unchanged. The additive `liked` kind and
unconditional discovery below supersede the older dynamic document's two-kind enumeration only.
[Owner queries](library-owner-queries.md), [profile consumers](library-profile-consumers.md),
[Collection source](collection-source.md) and [filtered lists](filtered-lists.md) retain their authorities.
This is specification and native acceptance delivery, not an implemented or exposed Liked reader.

## Identity and common wire

Every account has exactly one stable logical Liked Collection, including an account with no reactions or
Library facts. It is always discoverable in the authorized owner's common Collection list and readable by
that owner while empty. Discovery never depends on reaction count, a profile, an entry, state-set support,
a materialized header or a prior visit. Every account likewise retains logical Everything. The existing
empty-owner outcome counts one Everything and zero state views; it does not assert one Collection in total.
Adding Liked therefore needs no conditional-discovery exception or change to that frozen outcome.

Use the existing `derivedId` scheme, the owner's UUID namespace and the owner's route. The exact name is
`JSON.stringify(['library.collection.builtin', 1, 'liked'])`. The domain and version are unchanged from
Everything and state identities. Materialization, renaming, reaction changes, definitions releases and
emptying the Collection never change its ID. A conflicting nonmatching stored row fails closed. The native
`builtinCollectionId` helper does not yet admit this tag; this document does not add a runtime helper.

Use the existing common routes:

```text
GET /v1/collections?curatorAccountId={ownAccountId}
GET /v1/collections/{collectionId}
GET /v1/collections/{collectionId}/members
```

Owner descriptors use `membershipKind: 'dynamic'`, `builtinKind: 'liked'`,
`builtin: {kind: 'liked'}`, the same Collection ID and curator, and private visibility by default.
The private built-in key is owner-only. Do not expose another owner's logical identity through discovery,
point lookup, members, metadata or a different denial. Dynamic descriptors omit `memberCount`, `createdAt`,
`updatedAt` and `orderEpoch`; do not manufacture zeros or timestamps. Unrenamed titles follow the general
localized built-in presentation rule. An explicit authorized owner rename wins where general built-in
metadata writes are supported. Logical revision 0 and first-write materialization follow the general
built-in rules; there is no new read-grant override or Liked materialization policy.

Dynamic member items have `kind: 'dynamic'`, `subjectId` and the common optional subject summary. They omit
occurrence ID, note, ordinal and added time. Membership is read-only: no occurrence can be added, removed,
moved or annotated. The general `409 dynamic_membership_immutable` rule applies. Copying selected subjects
to a curated Collection creates independent occurrences; later reaction changes do not edit those copies.
There is no shelf endpoint, separate DTO, cursor codec, filter union or Liked-specific members engine.

All discovery, point and member GETs are domain-read-only, including repeated empty reads. They create no
header, grant, receipt, outbox event, repair, work intent or enqueue. Native read/session headers are not
domain writes. Native authorization still applies; logical ownership is not a replacement Access decision.

## Current membership and independent facts

Membership is the existence of the owner's current **subject-target** `like` or `love` reaction with
currently eligible original support and terminal. Either kind qualifies. Multiple qualifying originals
for one canonical subject yield one member. Clearing one contribution preserves membership while another
qualifying contribution remains; clearing the last removes it on the owner's next read.

The current Content table has one slot per actor and target, so `PUT` replaces that target's kind rather
than adding a second kind. Switching like to love preserves membership; replacing it with laugh, insightful
or sad removes it. Clearing deletes that slot. The OR rule also covers canonical groups with more than one
stored qualifying target; it does not invent simultaneous kinds in one slot or rewrite original facts.

Bob's reactions never qualify for Alice. Thread and post reactions never qualify, even when they reference
the same subject. Catalogue metadata, tags, profile support, reaction counts and reactor projections cannot
confer a like. A currently readable unprofiled subject may be liked; no synthetic profile or default state
is needed. Subject creation by an editor grants no shortcut for a different reacting owner.

Reactions alone establish no Everything presence, entry, state, label assignment, session/history, holding,
accepted profile pin or state sibling. Liked and Everything are separate populations. The
[owner presence union](library-owner-queries.md#presence) remains unchanged, and this adoption adds no
`owner.reaction` filter leaf. Existing profile, dynamic and curated suites keep their contracts.

The actual Content HTTP write is `PUT /v1/subjects/{id}/reaction` with the closed JSON body
`{"kind":"like"}` (or `love`, `laugh`, `insightful`, `sad`) and a structured `Idempotency-Key`; it returns
`200 {kind}`. `DELETE` on that path has no body and returns 204. Own reaction GET returns `{kind}` with null
for absence; merged reads retain Content's native redirect behavior. These are current commands, not a
new Collection write or reader adapter. Current subject reaction Access and original/terminal eligibility
remain Content/native boundaries.

## Indexed source, canonical pages and privacy

Content owns the future owner-partition subject-reaction indexed reader, SQL, partial index and native cost
tests. The selected raw candidate order is stored subject ID (`target_id`), with the actor's route and ID
leading the keyset. Only subject targets whose current kind is like or love qualify. Do not sort or count
an actor's entire reaction history, scan every kind behind LIMIT, or use target-home reactor/count
projections as owner truth. Content must publish its actual reviewed reader ABI before Library consumes it;
no callable `liked-read.ts`, native-source callback or source adapter is defined by this document.

That stored-ID keyset is a **raw candidate source**, not a canonical public-page proof. Maintained canonical
indexes or unique prepared owner rows must establish canonical order and cross-page uniqueness. Resolving
and deduplicating aliases in each returned raw window cannot do so. Preserve stored originals. Never choose
an arbitrary readable terminal or group representative that exposes a hidden original. Current original
support and terminal disclosure both apply, including when the only eligible original is last in a large
group. No per-page all-alias or all-home sweep is admitted.

Semantic owns canonical mapping and the shared serialized pending/published identity epoch. While pending,
canonical lists prepare; changed published epochs restart cursors. Native source/version observations,
current disclosure and privacy-reduction repair/acknowledgement remain required independent boundaries.
An epoch, complete generation, indexed row or prepared handle grants no permission. This specification
supplies neither a complete epoch ACK nor a receipt/callback-based authorization substitute.

Library composes the actual Content source with the common direct owner or prepared owner result plan.
Admit source, shared filter and order together under [filtered lists](filtered-lists.md). A successful page
fills the requested size or proves genuine final exhaustion. Otherwise return retained preparation with
finite progress, or the existing unavailable outcome when progress is impossible. Finite ready inputs,
including sparse matches, must reach useful full/final output after finite work. Endless preparing and
successful empty/short raw windows fail. No copied exact-fact witnesses, public mirror of private facts or
per-Liked membership cache is permitted. Common preparation is disposable derived data, never authority.

Owner output, preparation and continuation are private and `no-store`. Use the common signed/encrypted
useful-page cursor and existing GET policy, binding the viewer, route, Collection, query/order/size,
actual source/result basis and published identity epoch. Reauthorize every continuation. Another account
and anonymous readers receive the same 404 `not_found` as an unknown private ID, on point and members.
Native suspension revokes the pre-suspension bearer: 401 `invalid_credentials` and
`WWW-Authenticate: Bearer error="invalid_token"`. Do not invent a valid suspended actor to obtain a
hypothetical 403; [owner queries](library-owner-queries.md#viewer-self-binding-and-admission) owns this correction.

This private default introduces no new permission or public fresh-query policy. Where general explicit
publication is actually supported, public readers consume only completed published membership with current
subject disclosure, never fresh private Liked evaluation. Public fields/cursors do not change for private
changes that leave published output unchanged. Existing terminal retention of eligible completed public A,
exclusion of pending B, and private/unlisted erasure remain unchanged.

## Native acceptance and delivery boundary

[Native user cases](../services/kernel/test/library/liked-user-cases.test.ts) consume the actual
`createReleasedDiscoveryFixture({version:1})`, its `createSubject`, genuine Auth/Access/default kernel and
original `{status,headers,body}` responses. They freeze empty discovery and repeated own reads, stable ID,
private dynamic omissions, actual like/love/change/clear, remaining qualifying members, Bob and nonqualifying
kinds, unprofiled subjects, thread/post controls, fact separation, useful signed paging, concealment and the
real revoked suspended bearer. No driver injection, model, permission map, fake gate, successful fallback,
skip or caught-as-pass path supplies acceptance.

The committed fixture opens Collections through its actual governor. Its current export does **not** expose
the native pool/read-only inspection capability or a shared opener for other required families. It also has
no same-owner read-only token factory. Those are shared fixture producer gaps: a native `platform_closed`
response during required Library/progress setup is a prerequisite failure, not an owner-denial or empty-list
pass. Consume only an actual committed shared gate/read-only capability export when provided; do not
duplicate governance bootstrap, cast a hidden pool, install grants or guess its future signature.
When that inspection capability is available, compare native header/grant/receipt/outbox state around GETs
and inspect unchanged fact/pin state around reactions. Until then HTTP observations cannot prove those
storage invariants. No new released word/form/diet data is required for basic Liked.

Separate missing runtime producers remain: the built-in identity tag and dynamic DTO/discovery/point reader;
Content's indexed raw reader; shared native source/version, canonical epoch/current-disclosure ports; and
common useful owner members/preparation plans. `createCollectionSource` is still an unavailable factory,
and existing native stored-header/raw-range helpers do not compose these missing capabilities. A prerequisite
failure must be reported distinctly from a reached missing-descriptor/reader assertion. Native RED is required;
spec integration, a missing-driver verifier or a format check is not full native acceptance, exposure or promotion.

Run the named acceptance once after the final relevant edit:

```sh
bun scripts/worker-check.ts -- bun run --cwd services/kernel check test/library/liked-user-cases.test.ts
```

## Cost

- Touches: current owner-partition Content subject-reaction index, shared canonical epoch and native
  original/terminal eligibility, and the common owner result plan.
- Bound: [filtered-list direct/ready/preparation and useful-page budgets](filtered-lists.md#cost), including
  raw, rejected, duplicate, lookahead and current-disclosure work. No actor-history sort/count, per-page group
  sweep, free permission work or independent Liked budget.
- Growth check: native 64/512/4,096 population, matches, sparse matches, unrelated history, owner pools,
  aliases/duplicates and page depth, plus genuinely empty and denied paths. Measure actual indexed and
  preparation work, finite progress, pending epochs and continuation revocation. These runtime obligations
  remain open; this specification supplies no fabricated capture or composed-cost pass.
