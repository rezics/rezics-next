# Dynamic Collections

This specification extends [Library and Collections](library-and-collections.md). Built-in dynamic Collections,
the shared members page and the saved rule editor use one Source and the shared filter grammar. The
[Collection editor](collection-presentation.md) adds ordinary owned saved dynamic Collections to this scope;
their implementation does not change a built-in identity or meaning.

[Filtered lists](filtered-lists.md) owns the shared complete indexed observation, current disclosure, direct/prepared
admission, useful pages, freshness, canonical-list identity and cost contract. Required behavior below is distinct
from the current incomplete dynamic runtime, source factories and publication integration. The
[native owner plan](library-owner-queries.md#native-candidate-support-and-complete-observations) alone owns the
shared OWNER candidate/support directory, native predicate access and complete selective observations/repair;
this document consumes it without another architecture or numeric authority.

## Model and identity

A Collection keeps one identity, curator, title, description, visibility, follow state, Zone mount, and schema.org `ItemList` surface. Membership has one of two kinds:

- **Curated:** ordered member occurrences. Repeated subject IDs are allowed. Each occurrence keeps its own ID, note, and order.
- **Dynamic:** a saved predicate evaluated against the curator's personal library facts and admitted indexed catalogue properties. A
  subject appears at most once, regardless of how many matching facts it has.

**DECIDED DTO:** `membershipKind` discriminates a union, never a bag of optional fields. Curated Collections retain required `createdAt`, `updatedAt`, `memberCount` and `orderEpoch`. Dynamic Collections omit all four; Web displays no count/time, never zero. An unrenamed dynamic `title` is null or absent; an explicit owner rename wins. Built-in dynamic DTOs include `builtinKind: 'everything' | 'state' | 'liked'`; ordinary saved-dynamic DTOs omit `builtinKind` and carry their explicit title. State `builtinLabels` is the actual accepted state's standard BCP47 locale map (`zh-Hans`/`zh-Hant`, never `zh`), or `{}` when absent; Web uses its neutral Other fallback. Liked and Everything use Web's normal localized messages. Liked is always private with owner tuple `{kind:'liked'}`; it exposes no public profile/predicate/pin fields or curated count/time/order. Only owner discovery may include the private `builtin` tuple; public DTOs never disclose profile/state IDs, predicates, pins or release digests. No fixed vertical vocabulary is added. A dynamic member item contains `kind: "dynamic"`, its `subjectId`, and the same optional subject summary as a curated item. It has no occurrence ID, note, or added time. No route creates a pretend occurrence for a dynamic result.

The first-scope built-ins are:

1. Everything, one stable Collection identity for every account, including an empty account.
2. **One state Collection per state identity** for every library profile whose state set is in use by that account.
3. Liked, one stable private logical identity for every account, including genuine empty 200, backed by Content's
   current SUBJECT like/love source. Reactions alone add neither Everything presence nor state support.

Built-ins are logical on reads and private by default; account setup creates no state-view fanout. Collection resource,
list, detail, and logical built-in discovery reads are pure: they create no Collection header, grant, receipt, domain
event, or other user-visible resource state. Liked follows the same logical/read-only contract; its identity and
Content raw/version integration remain implementation requirements; its shared DTO/discovery binding must preserve
this scope without treating the existing Everything/state helper as Liked delivery. The common members GET is the
sole read exception: it may start bounded, retained derived preparation as an idempotent cache fill under the
existing quotas and budgets. Its key includes the
actual viewer, Collection, validated filter and sort, and accepted release/meaning. Only the derived preparation
record and its work intent may be written. This cannot materialize a Collection, grant access, or perform a receipt,
domain event, rename, follow, or other resource mutation. Authorization, current source eligibility, and privacy are
checked before disclosure and revalidated by the owning admitted plan; preparation is never cached authority.
Collection list previews remain read-only and never reserve Members preparation; the common Members GET is the sole
preparation entry point because it carries the current bound Source and filter read.
Accounts owns the additive fenced event-free operational transaction plus atomic durable intent/native SPEC.
Use only its actual [Core contract/export](../services/kernel/src/command/README.md#operational-transactions):
the adopted mechanism uses same-client DBOS `enqueueInTransaction`, native Access/current-T finalization and
partition/account fences with existing DBOS recovery, not a separate intent table or relay. Executor source and
its frozen contract are now present. Library has native reservation, exact touch and step admission. Positioned
History registration and its prepaid child adapter are available as internal seams. Mounted cache-fill consumption,
the funded Source producer, completed results, and full native custody proof remain pending.
`runCommand`/`noEffect`, fabricated transactions or post-commit WorkClient enqueue do not implement this exception.

When a members GET has retained preparation genuinely underway, it returns HTTP 202 with `Retry-After` and the exact
closed `application/json` body `{preparing:true}`. The client retries the same validated URL and cursor; a later GET
returns the useful prepared page or final 200 page. The 202 response and owner/private preparation and pages use
`private, no-store` and never mirror private facts. The 202 body has no members, next, operation ID, partial data, or
receipt. Preparation cannot manufacture a successful empty members or next page, treat permanent 202 as progress,
or make a missing or unavailable runtime ready; unavailable work remains 503. A genuinely exhausted 200 retains
`{members:[],next:null}`. Zone `POST /v1/zones/{id}:readPage` and its existing `202 {next}` wire are unchanged.
Members status recovery retains the original Collection, filter and opaque cursor through 202/503/200; only the current response sets preparation feedback, and a completed response clears earlier preparation feedback.

The private owner list `GET /v1/collections?curatorAccountId=...` includes logical Everything and proven in-use state tuples before stored rows exist, without `collection:create` or a write scope. `GET /v1/accounts/:accountId/collections` remains public-profile disclosure and honors `public_views.collections`, even for the curator.
A state set is in use through live entries or retained session/holding facts with actual accepted pins. Labels and trash do not establish state-set support. Discovery unions the supported sibling state identities; each contributing fact retains its own accepted pin and meaning. Retirement blocks new bindings but retained facts keep old pinned identities resolvable, including for undo.
Soft-deleted facts can keep identities resolvable for undo but never contribute membership. State listing is paged and creates no fanout.

### Logical identity and first-write materialization

For Everything and state, derive each built-in ID with the existing `route/route.ts` `derivedId`, owner UUID namespace, and owner's route. The exact domain-separated names are `JSON.stringify(['library.collection.builtin', 1, 'everything'])` and
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

The persisted Collection ID is stable for the curator and built-in key. For an UNMATERIALIZED PRIVATE state view,
presentation selects the lexicographically smallest CURRENTLY SUPPORTED immutable release digest CONTAINING THAT
STATE. This selects presentation only; digest order is neither chronology nor compatibility. Discovery unions
supported sibling state identities and each fact keeps its own accepted pin and meaning. A materialized header's
accepted meaning and a public complete generation's accepted meaning stay FIXED; an owner's rename wins. Later
support/reader selection uses indexed seeks, never a scan of all supported releases/history. The opaque query basis
binds actual accepted meaning; this policy introduces no runtime ABI or replacement native fact authority. A label-only release change preserves state identity and membership; no meaningRevision/profileRevision field or provider exists.
A meaning change requires an explicit bounded profile migration or a distinct state identity. Existing fixed-key state values map without semantic loss to the canonical compatibility profile by explicit migration in pages of at most `P`; labels never choose or rewrite state identities.
A retired profile is not rebound: retained facts and their state Collections keep their old pin and identity, and a profile with no retained facts creates no state views. If a pinned release is unavailable, reads fail closed for restart or repair; activation or retirement invalidates affected cursors without synchronously rewriting every account.

The Collection page retains its authorized header when a Members read fails and retries the same Collection,
validated filter and cursor. It distinguishes native preparing (202), unavailable admission (503), failed reads
and successful ready pages; no pending or unavailable result becomes empty success. Status recovery is disabled
while editing, moving or removing members or retaining a frozen draft. See the
[Members C3 composition](../services/kernel/src/library/members-preparation-contract.md#approved-c3-composition)
for the finite parent required before new preparation admission.

## One Collection page

Native growth fixtures stage real nonmatching catalogue subjects before scenario subjects so sparse owner-source growth can add preceding facts without rewriting selected membership; this fixed catalogue baseline is separate from each axis's grow-to total.

The existing Collection resource and `GET /v1/collections/{collectionId}/members` remain the canonical page for both membership
kinds. The Web shelf page is this page for the account's built-in dynamic Collection, with no shelf template fork; it uses the actual
shared Collection page/template. The shelf has no independent list route or cursor.
Collection list and detail reads include built-ins visible to the curator. Curated response fields and occurrence
behavior remain intact. Both kinds use the same page envelope, page-size limit, filter and sort validation, subject summary
resolver, cursor codec, follow target, export, and Zone-mount identity.

| Page behavior                   | Curated                                                                  | Dynamic                                                                          |
| ------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| Returned identity               | one card per canonical subject; editor retains all occurrences           | one row per unique `subjectId`                                                   |
| Default order                   | Admitted canonical browsing order; editor keeps ordinal/occurrence order | Stable subject-ID keyset                                                         |
| Note, occurrence ID, added time | Preserved in occurrence editing                                          | Absent                                                                           |
| Exact member total              | Stored occurrence count retains its contract; never a filtered total     | Absent                                                                           |
| Membership edits                | Add, remove, move, and note edit as today                                | Add, remove, move, and note edits fail with `409 dynamic_membership_immutable`   |
| Collection metadata             | Existing title, description, visibility and revision rules               | Same rules; built-in query identity is immutable and built-ins cannot be deleted |

The page size is `P`, `1 <= P <= 100`. Success fills the requested page or establishes a genuinely exhausted
final page. If admitted work cannot establish either, return explicit preparation/readiness with retained progress.
Never expose successful short/empty raw-candidate windows as pages. Dynamic results expose no global count.

The common members HTTP filter is URL-encoded `JSON.stringify` of an admitted shared `@rezics/filter`
`FilterDocument` in the `filter` query parameter. Source, filter and sort are admitted together under the existing
`collection_member.list` operation, with shared release/datatype/unit and same-statement qualifier semantics.
The route now validates this shared input, but returns explicit unavailability until the common Source supplies
execution admission; accepting the syntax does not advertise working filter execution. Clients require advertised
execution support before enabling controls. No second grammar/property whitelist or browser-side membership
filtering. Unknown stays unknown under NOT.
Commerce owns direct owner index and prepared owner result plans; Search owns catalogue compilation, preparation
and freshness. These prose plan names introduce no executable discriminants. A direct plan needs a page-derived
bound including engine work; otherwise prepare an indexed result in bounded steps retaining settled work, or reject
422 before enumeration. Typed parameterized range/qualifier SQL may execute the shared meaning. Existing integrated shelf-index helpers may supply
bounded facts as adapters, but they do not own Collection membership or establish a second list authority. The Collection layer does
not define a second property whitelist, copy private facts into Search, or add a private catalogue-holder directory. Unsupported
filter or sort shapes return `422 unsupported_query`; they never fall back to an unadmitted request-time scan, [cross-partition SQL join](architecture.md#data-access), or full-account
sort. Bounded retained preparation follows the shared contract. A sort must have a shared native order key and a stable subject-ID tiebreaker. Layout (`grid`, `list`, or `table`) is
presentation state; it does not change membership, authorization, or server paging.

Bulk selection, export, follow, and Zone mounting use the same Collection ID and shared kernel protocols. Dynamic selection
enumerates unique subject IDs, never fake occurrences. Library bulk uses its existing durable operation through a Collection source
adapter; occurrence actions remain unavailable. Export streams the same bounded page and emits subject links only. A private
Collection cannot become public through follow or mount; existing Zone rules decide mount eligibility. No local subsystem is added.

## Access and disclosure

Liked is always private. Other dynamic Collections are private until their curator explicitly changes visibility. Reads authorize the Collection before searching
candidates. A private or unknown Collection has the same not-found response for another account and an anonymous viewer. Suspended valid bearers receive 403 `account_suspended` everywhere, including public/unlisted reads. Missing/invalid/revoked credentials use 401 where required; there is no anonymous-floor exception. Changing visibility uses the existing Collection authorization and revision check. Unlisted and public
visibility continue to use the existing direct-read and listing rules.

The curator's private descriptor may identify the built-in profile and state. It never appears for another viewer. A public or
unlisted members page returns only its ordinary Collection metadata and subject summaries that pass the current viewer's native original AND terminal eligibility, Access, consent, foreign target and source-tuple fence checks. It returns no state, label, progress, holding, query body, predicate, profile pin, private candidate count, or
private member count. Collection membership never grants subject access. Filtering by an owner's personal facts remains owner-only.
These exclusions concern private fact values; publishable built-ins retain the agreed public `builtinKind` and accepted `builtinLabels` presentation. Liked has no public presentation DTO.
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

Current candidate checks alone cannot protect exclusions and order. Query-level privacy-reduction invalidation and
acknowledgement is also required under [Filtered lists](filtered-lists.md#current-disclosure-and-query-privacy).
Local reductions invalidate public use in their authoritative transaction; foreign source-fence, target, consent
and Collection reductions invalidate affected public use immediately. Acknowledgement covers actual refresh-visible
repair, including dependent foreign repair. Observe safety before execution and revalidate before disclosure;
unsafe, changed, missing or pending acknowledgement means preparing/readiness. Withheld harem facts cannot affect
NOT harem exclusion/order/counts merely because returned subjects pass Access. Paused-indexer cases remain preparing
until the local reduction and all affected foreign repair are acknowledged. Checkpoints, local securityRevision,
ordinary complete generations, returned-ID checks or omitted counts do not certify safety. This abstract seam is
not a certificate store, safety-token ABI, global sweep or new permission authority; native ports remain incomplete.
Omit unsafe totals/facet counts over unchecked populations, with no approximate/as_of or zero/row-length fallback.

Ordinary catalogue edits become filterable within 60 seconds in healthy operation; actual source-to-searchable
lag over five minutes yields readiness. Engine refresh alone is insufficient. Privacy reductions apply immediately;
owner writes appear on the owner's next read, including prepared owner views.

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

Every new directory/support/change/registration/frontier/prepared/intent store, identity effect and first-apply
custody joins the exact Library [A5 inventory](../services/kernel/src/library/README.md#retention-inventory), bound
to native transactionId/component/job and terminal T. Shared history/work artifacts join their actual owner custody;
missing whole-role proof stays pending. Heads/counters are removed last after fact hooks cannot recreate them.

The durable terminal handoff records freeze/revoke and bounded purge work, then returns without waiting for projection consumers; the
delete response may precede purge completion. Delayed delivery cannot adopt B or resurrect erased facts. [Deletion](deletion.md)
governs individual-record tombstones and 30-day undo: restore rechecks `deleted_at`/`purge_after`/CAS and restores the same historic
fact and pin. Individual early purge needs platform permission. Takedown never schedules purge; legal-order purge needs platform authority. Business transitions define neither undo
nor purge timing, and this contract adds no lifecycle engine or synchronous wait.

## Saved queries and execution admission

Decision: second-scope saved queries use the installed rule, Source, Members and explicit Publication contracts
with `id` order; private meaning stays private, with no new grammar, sort family or publication engine. The
[second-scope plan](research/commerce-second-scope-plan.md) owns the delivery slices and their composition.

Saved dynamic Collections use `POST /v1/collections` with the closed body
`{membershipKind:'dynamic',title,description?,visibility,rule:{filter,sort?},presentationKind?,coverMediaId?}`.
`PUT /v1/collections/{collectionId}/rule` takes the closed body `{revision,filter,sort?}` and returns
`200 {collection}`. The numeric revision is the current Collection CAS. A rule edit increments the rule's own
revision and Source generation once; a title/cover edit does not edit its rule. Curated creation and metadata
operations retain their existing bodies and grants. Both operations use the same
closed catalogue grammar and semantic admission; this document does not create a second catalogue predicate AST.
Owner predicates remain owner-only and require reviewed shared admission/native owner plans. Definitions and
accepted pins own meaning, not localized labels or fixed vertical vocabulary. The shared pure matcher is the
conformance reference, not mandatory request-time raw-fact replay. Incomplete coverage remains unknown under NOT.

Saving validates the full filter + source + order against immutable meaning, complete indexed coverage, visibility
and owner authority. Admitted negatives need complete coverage; unsupported execution rejects 422 before enumeration.
A supported prepared plan may become ready through retained finite work. Private AST/facts and private candidate
counts never become public output. Publication exposes only the last complete adopted subject set. Custom query
execution remains unavailable until the actual shared native admission and member producer are bound.

### Saved editor implementation boundary

`collection-rules.ts` supplies shared parsing/immutable-release admission, complete expanded private-family
dependency extraction, native current authorization before receipt replay, and route-leading rule storage/CAS
helpers consumed by the existing Collection commands. Only the actual common preparation declaration's `id`
sort is currently named; other string sorts reject `422 unsupported_query`. These helpers do not prove an
executable source plan. The private rule has one retained copy on its Collection row; receipts/events contain no
AST and no new work payload retains it. Existing terminal header deidentification clears the rule in that same
row mutation. No public Collection projection selects its AST, release or private family operands. Dynamic
metadata omits curated counts and timestamps; it never turns an unavailable source into ready-empty output.

`createCollectionSource`, `createMembersPreparation`, saved-rule admission and native owner-read binding now
have production implementations. Their presence does not establish a complete executable saved-source plan:
current native source, identity and whole-query disclosure evidence remain required. Missing evidence returns
explicit `503 dependency_unavailable`; dynamic reads never fall back to curated occurrences or false empty output.
The HTTP outcome suite still requires actual saved creation, CAS/replay and useful member/clear/Undo outcomes.

Public dynamic execution requires the actual complete explicit Publication provider. Native episode, work,
staging and final-command bodies are present; their saved-source composition and complete output must be proved.
Non-private saved creation currently refuses with `dependency_unavailable`. Public/unlisted requests, including an
editor's public request, cannot evaluate current private curator facts. Source presence is no successful public
membership claim. Generated artifacts and native outcome checks remain controller-owned after integration.

Saved-rule drafts compare exact title, description and filter structure (including operand order) with their initial
or confirmed-save baseline. Stay preserves the draft; Leave discards local edits without cancelling an original
pending command. Navigation and supported unload warn even for an unresolved save; label-choice search and editor
focus do not count as edits. Reload preserves that baseline and draft, and uncertain retries retain their exact
sender, credential, request and key. Confirmed saves and authority retirement clear navigation protection.

### Selected whole-query publication contract; native bodies pending

[`collection-publication-work-admission.ts`](../services/kernel/src/library/collection-publication-work-admission.ts)
owns the literal server-only `CollectionPublicationLocator` (`route`, `ownerAccountId`, `collectionId`,
`publicationId`) and `CollectionPublicationWorkDefinition`. Its exact owner calls are
`admitCollectionPublicationStep(tx: OperationalTransaction, locator: CollectionPublicationLocator): Promise<boolean>`
and `readCollectionPublicationWorkDefinition(tx: OperationalTransaction, locator: CollectionPublicationLocator):
Promise<CollectionPublicationWorkDefinition | null>`. Both are explicitly temporary unavailable adapters until
the native episode/evidence producer replaces them. Exported declarations and getter data grant no admission,
completion, Source acknowledgement or ordinary reader disclosure.

Search's selected additive `collection-publication` work role carries the live Core `OperationalTransaction`
and this locator. It borrows neither curated Members nor Kind preparation. Before any Source or Type-audience
IO, its adapter must verify the live work-step, exact installed pool, owner/account/partition resources, original
deadline and actual `commandTime(tx)`, then call native admit and getter on that same client. It compares the
entire native definition again after foreign staging and before settling progress. Changed, missing, moved or
unavailable evidence means unavailable. Mechanical work uses the shared Source/compiler/evaluator and existing
WorkAllowance; it restores no Actor and creates no second evaluator or permission engine.

Input and target use the **same actual Collection ID**, with explicit distinct references: input
`kind:'private_working_source'` selects its authorized private native population (`scope:'private_builtin'`);
target `kind:'collection_output'` names its eventual public/unlisted complete output. Equal IDs never select a
Source kind implicitly. Neither active explicit output nor frozen/public output supplies the working population.
The native getter carries actual expanded pinned `{filter,sort:'id',release:{digest,value:FilterRelease}}`,
NativeSourceIdentity, CollectionSourceObservation, IdentityScopeObservation, IdentityNativeReceipt repair proof,
NativeSourceCustody, releaseDigest and audience, together with the immutable rule, committed creation and actual
native output references. Private working Source admission for this episode is still missing implementation.

[`collection-publication-episode-contract.ts`](../services/kernel/src/library/collection-publication-episode-contract.ts)
owns the selected begin input, source/target/rule references, immutable creation payload and phase/result data.
The Collection row retains the sole private query AST. Episodes retain its immutable digest, rule revision,
release, Collection incarnation/revision and Source generation references, checking current bytes on each use;
they store no second query/profile mirror. Everything/state retain their actual deterministic IDs,
first-write materialization and accepted pinned meaning. Liked stays private; unsupported targets refuse.
Native bodies allocate actual operation/source/output references, never caller-invented UUIDs or receipts.

Begin belongs to the current owner's ordinary authenticated `collection:update`, CAS, idempotency and full
expanded private-family authority. Its native transaction commits the immutable operation and exact source/target
payload with the real creation receipt. `captureDurableInitiator(commandAccessContext(...), actor)` captures the
original admitted account/delegation; `durableInitiatorCommitment` binds the complete DurableInitiatorRecord in
that receipt. The domain reader is the actual DurableInitiatorReader, independently checking exact native
operation/source/receipt provenance and returning only its allowlisted original record. Missing evidence cannot
be reconstructed from current state or permission-shaped JSON.

`staging` and `awaiting_activation` retain B's actual building CollectionOutputRef without a publication receipt;
`refused` keeps B separate from selected complete A. `complete` requires the actual CollectionOutputPublication.
Phase data, count, a first page and the delivered explicit 0..100 selected-set helper in
`collection-publication.ts` do not prove whole-query exhaustion. B stages in bounded steps over the same native
Source/compiler, with query/source/identity/current fences before work and at finalization; unchanged A remains
selected until genuine full exhaustion and successful final activation.

Final activation uses WorkContext.getAuthorization()'s same mounted Access/current readConsent and pool with
createInitiatorRestorer and the real domain reader. Every runCommand retry/replay restores the initiator **inside
CommandAuthorization.prepare at that attempt.time**, then delegates ordinary resourceAuthorization or
accessCommandAuthorization prepare/authorize at the same T before receipt lookup. Current consent, principal,
scopes, floor/operator/delegation, mounted authority and Collection/episode/query/output/source/lifecycle fences
are independently rechecked. Only that real authorized collection:update CommandTransaction invokes the native
output hooks; Core basis, receipt, event and complete B selection commit atomically. Mechanical staging has no
final command authority. Existing output hooks currently require ordinary command authority even for appends;
bounded operational staging bodies must supply their own native admitted integration, without bypassing them.

Native episode/provenance/admission, bounded staging and restored final-command bodies are present in source;
their complete runtime binding and native outcome proof remain required. Source, receiving, publication, control,
late-writer and creation-evidence retention must join the existing native inventory
and disposition obligations. These declarations claim no receiving/frozen/root support, NoData, cleanup authority
or native/runtime pass. Original public dynamic C5, whole-query, replay/revocation and terminal outcomes remain
the unmet acceptance basis; the controller retains native proof and ordinary runtime recovery work.

## Query, identity and cursor bounds

Success fills the requested page or proves a genuinely exhausted final page. If direct work cannot establish
that outcome, return explicit preparation/readiness and retain settled work. The old `4P` candidate formula is not
a completion guarantee or a replacement numeric budget. Performance supplies per-plan bounds in actual units;
no chain of short/empty successful pages over raw nonmatches. Fixed finite ready inputs must reach useful output
after finite preparation, including crash/replay. No whole-account synchronous fanout or new scheduler/service.

Canonical browsing uses maintained canonical-ID indexes and unique prepared result rows. Identity observation,
publication and cursor currentness cover the actual source and complete query dependencies, including excluded and
order originals. Only relevant pending work prepares; changed relevant basis restarts cursors. Continuous disjoint
jobs cannot stall a finite unchanged owner source; no global active marker or universal page gate.
At most 4,096 originals per group are admitted before effects;
published redirects are direct to active terminals. No request-time exhaustive alias walking or all-home sweeps.
The SAME `library-private-follow-counts` participant covers EVERY Library canonical record, including OWNER
candidate/support directories and concurrent first-apply rekey custody. No third participant/independent ACK;
follow-only completion is insufficient. Exact native transactionId/component/job/epoch/version/scope and every
prior removal/addition/fence use the shared native receipt contract, with terminal/account/source fences and stale
destination rejection. The [owner plan](library-owner-queries.md#shared-operational-identity-and-disclosure-producers)
links the semantic scoped concurrent protocol authority and separate still-required Source2a observation producer.
Stored originals and occurrence notes/multiplicity remain; editing preserves occurrences. Canonical owner views
select latest state with conflict visible, union labels, keep copies/sessions separate and address new writes to
current terminals. Current original and terminal disclosure remains required.

Keep the existing owner cursor envelope, codec, key ring and binding to viewer, route, Collection/incarnation,
filter/query, order, page size, accepted meaning/pins, source/result generation, identity epoch and keyset. Mutable
bases stay inside encrypted position, stable request fields in authenticated binding. GET anonymous tokens remain
deterministic/timeless; account tokens keep fifteen-minute lifetime. Tampering/rebinding/expiry fail closed through
existing errors; changed basis returns stale_cursor and a fresh traversal, never silent meaning changes. Reauthorize
every read. Zone POST retains its separate Search profile and fresh-start-on-unusable-progress policy; no schema,
status/body, cursor codec or common DTO change is selected here.

## Cost

### Direct and ready-result dynamic pages

- Touches: named owner/catalogue index seeks or ready unique result rows, actual candidates including duplicates/
  rejects/lookahead, current source and original/terminal Access, complete disclosure dependencies, summaries and
  control/epoch reads.
- Bound: derive per plan in candidates/keys, points, examined/removed rows, buffers, statements/connections, bytes,
  engine work and output slots. Composed common pages stay within 16 distinct reads and 128 TOTAL output slots.
  Each page/step supplies the INTERNAL cost object and separate shared harness counters in
  [Filtered lists](filtered-lists.md#cost); reviewed native specifications bind actual counters, not this prose.
- Growth check: real API/native first/deep/sparse pages at three geometric scales, all owner pools, unrelated
  history/population and alias/duplicate axes. Performance sets numeric limits and executable captures. Returned
  array length, LIMIT, timeout or old 256-proof tests do not prove engine work or replacement acceptance.

### Preparation and index maintenance

- Touches: bounded native input/frontier/result writes, source and foreign dependencies, shared durable work/outbox,
  canonical mapping/index changes during pending identity epoch and terminal fences.
- Bound: each step admits rows/keys/points/bytes/statements/engine operations and retains settled progress. Finite
  total work follows relevant finite input and changed dependencies. No per-built-in witness mirror, repeated
  restart from zero, unbounded synchronous fanout or stored permission.
- Growth check: native three-scale interruption/replay, concurrent privacy change, complete activation/catch-up,
  terminal fencing and useful-page completion. Permanent preparing is failure.

## Acceptance outcomes

The [shared matrix](filtered-lists.md#shared-acceptance-matrix) runs the same scenarios across curated Collections,
Everything, state Collections, public/unlisted/private visibility and mounted Zones. Require harem light novels,
Book wordCount > 1,000,000 (exact threshold and absent excluded), and combined, in public Zone/Collection, own
library without state and own library with own state. Owner-only NOT state X includes no entry. Released Concepts,
genuine words versus characters and reviewed mappings remain separate producer prerequisites. Preserve same-statement
qualifiers/units, compact/expanded conformance, two-release pins, healthy/max lag, owner read-after-write, paused-indexer
NOT/order/count privacy, foreign fences/targets, finite sparse/crash-replay preparation, direct-target disclosure,
canonical cross-page uniqueness, pending-epoch readiness and native current cursor reauthorization/session/cache.

The API suites cover curated ordering, Everything/state views, profiles and old pins, overlapping labels, source changes, viewer
authorization, disclosure, Search/count isolation, query and cursor bounds, and stale projection delivery. The label outcomes also
prove read-only owner discovery and reads cause no writes, denied follow/update do not materialize, and first authorized writes keep
the logical IDs. Saved-rule editor outcomes are in the same adopted scope and require the shared Source and
preparation binding above. Dynamic outcomes additionally require actual SQL point evidence for opaque state
references, identical denied/unknown concealment, and terminal deletion defeating paused repair and follow.
No runtime pass is claimed by these specifications.

## Ordered implementation plan

Each implementation landing slice is capped at eight files. Contracts and imports land before production code; do not create
parallel query, bulk, projection, or shelf machinery to avoid a missing owner import.

| Order | Owner and work                                                                                                                                                                                                                                                                                                                                                                                                                   | Expected file surface                                                                                                                                                                                                                                                                        |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Library and Definitions contract owners adopt profile/default-migration, independent-label presence, dynamic DTO, and test fixture contracts.                                                                                                                                                                                                                                                                                    | `docs/dynamic-collections.md`, `specs/dynamic-collections-driver.ts`, `specs/dynamic-collections-outcomes.test.ts`, `specs/dynamic-collections-contract.test.ts`                                                                                                                             |
| 2     | Shared Query/List owner supplies the admitted property/filter registry, opaque cursor binding, keyset semantics, per-plan work instrumentation, and cross-partition access boundary.                                                                                                                                                                                                                                             | `packages/filter/src/`, `services/kernel/src/tokens/cursor.ts`; shared query planner closure still required                                                                                                                                                                                  |
| 3     | Definitions and Library implement the canonical profile registry and explicit default migration, then independent labels; retain old immutable pins and keep migration work paged.                                                                                                                                                                                                                                               | Existing profile compiler/release, Library fact model and migration code plus their acceptance owners                                                                                                                                                                                        |
| 4     | Library Collection owner adds built-in identity/read adapters to the existing Collection model, routes, reader, and indexed fact sources. Curated commands and DTOs retain their present contracts.                                                                                                                                                                                                                              | `services/kernel/src/library/collection-model.ts`, `collection-routes.ts`, `collection-reads.ts`, one migration, one indexed dynamic-member query                                                                                                                                            |
| 5     | Shared listing-freshness owner closes the existing monotonic protocol gap; Library adds only a dynamic per-kind adapter and terminal freeze/revoke input. Account deletion owns the bounded durable handoff.                                                                                                                                                                                                                     | `services/kernel/src/library/listing.ts`, `listing-freshness-contract.ts`; Access events/port and protocol closure required                                                                                                                                                                  |
| 6     | Existing Library bulk owner admits unique dynamic Collection selection through its durable operation contract. No new workflow, manifest, cursor, or retention subsystem.                                                                                                                                                                                                                                                        | `services/kernel/src/library/bulk-contract.ts`, `bulk-contract.md`; these specify work, not an implemented shared engine                                                                                                                                                                     |
| 7     | Web owner adapts the existing CollectionView surface, `CollectionPage` in `apps/web/src/library/collection-page.tsx`, loaded by `collection-load.ts` and `collection.ts` and rendered at `/collections/$id`; the library shelf remains `ShelfView` in `shelf-view.tsx`, `shelf-rows.ts` and `/library`. Keep both addresses and avoid a template fork. Retire `/library/shelf` client/API/tests after the shared engine is live. | `apps/web/src/library/collection-page.tsx`, `apps/web/src/library/collection-load.ts`, `apps/web/src/library/collection.ts`, `apps/web/src/library/shelf-view.tsx`, `apps/web/src/library/shelf-rows.ts`, `apps/web/src/routes/library/index.tsx`, `apps/web/src/routes/collections/$id.tsx` |
| 8     | Library, Shared Query/List, Shared Projection, Account Deletion, Bulk, and Web owners run real acceptance suites and three-scale first/deep-page growth checks before enabling the route.                                                                                                                                                                                                                                        | No extra files without an import or failing acceptance that needs them                                                                                                                                                                                                                       |

The eight ordered owner groups keep each landing slice within eight files. Confirmed Web paths above identify existing sources; proposed migrations/adapters and shared query/list/bulk/projection engines remain implementation work and must follow their owner contracts.

## Decisions fixed by this specification

- Empty accounts have one private Everything identity and no state views. Everything presence includes state, labels,
  sessions, or holdings, so clearing a state alone does not erase remaining library presence.
- Built-in state identities use the canonical profile/state registry and stored accepting release pins, never a global vocabulary or
  localized labels. Old pins survive activation and retirement without reinterpretation.
- Browsing returns unique canonical subjects. Curated editing preserves duplicate occurrences, their notes and order.
- A query-basis mutation invalidates the old cursor with `stale_cursor`; pagination does not promise a snapshot.
- Public dynamic output is only accessible subject membership. On terminal account deletion,
  only active-PUBLIC output retains its last complete published generation; private payload hides at `T` and is erased by bounded work, with durable handoff waiting for no consumer.
- User-authored queries are defined as a bounded later runtime phase and are not first-scope outcomes.
