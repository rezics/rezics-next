# Hosted catalogue API

The hosted book profile extends an existing Post in its current home. The Post remains the catalogue identity and
authority. Commands use ordinary Post owner/container admission and native receipts; they create no resources,
grants, Subjects or bodies. Columns and individual articles continue to use ordinary Posts without a catalogue.

## Authoring and release

| Operation ID                           | Method and path                                    | Input                                                                   |
| -------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------- |
| `hosted_catalogue.create`              | `POST /v1/hostedCatalogues`                        | `postId`, `threadId`, `placements`                                      |
| `hosted_catalogue.revise`              | `POST /v1/hostedCatalogues/{id}:revise`            | `expectedRevisionId`, `placements`                                      |
| `hosted_catalogue.append_root_chapter` | `POST /v1/hostedCatalogues/{id}:appendRootChapter` | `expectedRevisionId`, `occurrenceId`, `title`, `target`                 |
| `hosted_catalogue.publish`             | `POST /v1/hostedCatalogues/{id}:publish`           | `expectedRevisionId`, nullable `expectedPublicationId`, `occurrenceIds` |

Every command requires an Idempotency-Key and returns `catalogueId` and the newly selected `revisionId`. Create
returns 201; revise, root append and publish return 200. A fresh command with a stale head or release returns 412.
Native authorization precedes receipt lookup, while concurrency comparisons follow it: an authorized exact retry
can return its original immutable revision after later changes. An altered request under the same key conflicts.

Each placement supplies `occurrenceId`, nullable `parentId`, zero-based sibling `position`, `title` and `kind`.
Parts have no target. Chapters supply a target containing `threadId`, `postId`, `revisionId` and lowercase SHA-256
hex. The occurrence and parent IDs carry the catalogue's route; target identities carry the target Post's route.
A complete replacement has at most 512 occurrences, depth 16 and 256 Unicode characters per title. Empty structures, empty
parts, duplicate Post selections under distinct occurrences and root-only chapter lists are valid. Chapters cannot
parent children. Duplicate IDs, cycles, missing parents and noncontiguous sibling positions are invalid requests.

Revise replaces the complete tree and retains immutable history. Occurrence identity permanently fixes the kind
and target Post, even after removal; moves, titles, sibling order and exact revision selections may change. Target
attachment validation uses exact native `readPostMetadata`, followed by its retained original source observation
and prepared ancestry/current Access check. Create, revise and publish compare thread, Post, revision, stored
SHA-256, author and licence without loading revision bodies, even when selecting an old revision. Each distinct
thread/Post/revision/digest is completed sequentially; identical duplicate placements share that check. Erasure,
concealment, a changed observation or any identity mismatch returns the existing not-found error. A failed command
rolls back its own changes and never erases the independently saved target Post. Metadata admits attachment
identity; it does not prove reader bytes. Exact body resolution retains full-document fetch and digest verification.

Native acceptance is deferred to the dev verifier: unchanged create/revise/publish success and denials with zero
revision body loads, including old-version and wrong-thread selections, and retained-observation changes. Existing
exact reader body and digest assertions remain unchanged.

Publication selects an ancestor-closed subset of the expected current structure. It stores a separate immutable
manifest, with dense positions and preorder preserving the selected relative order, and advances the publication
pointer in the same transaction. An empty selection withdraws the current TOC and removes the catalogue from
`hosted_catalogue.for_subject`. It does not publish any Post body:
ordinary Post publication and target disclosure remain necessary. Published bytes are selected by exact revision
and digest, never replaced with the current head. Later draft edits do not change a release. The three registered
events contain only catalogue/revision identities; no private target selections enter the outbox.

Decision: nonempty publication resolves the expected structure's immutable append descriptor and reads only the
bounded explicit IDs, once per sealed-base/prefix segment. Legacy snapshots use their original revision key;
stream hits use the base stream identity and inclusive pinned high-water. Base ordinal order followed by append
offset order preserves native preorder and exact targets. Empty withdrawal verifies that the source is a structure
but reads no descriptor or placement rows. The shared release validator still rejects duplicate and unknown IDs
and missing ancestors, then assigns dense sibling positions and preorder; the selection cap remains 512.

Decision: publication selection runs in command preparation after `hostedPostAuthorization.prepare`, before
attachment validation. Only the initial catalogue locator runs earlier to locate the Post authority. Native
preparation checks Post authorship, container/Board visibility and participation, validates the authority anchor
and runs Access's `post:revise` formula at the attempt's authoritative time. It admits selection reads; it does not
grant mutation. Transactional authorization still consumes the bound, single-use proof and rechecks the prepared
container before receipt lookup; finalization retains its existing checks. No permission formula is duplicated.
Selection uses the original catalogue partition and snapshot deadline, and attachments retain the command deadline
outside the write transaction. Only complete preparation retains placements, keyed by that invocation's attempt
time. Every retry prepares current authority and rereads the exact immutable expected structure and selected rows;
a failed preparation cannot supply an earlier selection to a later transaction. For admitted authors, selection and
attachment rejection still precede receipts, while head/publication CAS follows receipts. Exact replay, empty
withdrawal, responses and events retain their existing behavior. The 512-input replacement and release-selection limits remain unchanged.

The focused `hosted-release-selection.test.ts` fixture distinguishes source rows selected at the store boundary
from the final manifest and covers sparse ordering, withdrawal and selection rejection.
`hosted-release-selection-admission.test.ts` reuses the native hosted fixture to pin owner admission before source
reads and selection errors, admitted rejection, exact publish/replay after a later draft and current authority on
replay. Existing replay acceptance in `hosted-chapters.test.ts` remains unchanged. Run these cases after landing in
the dev verifier. Mounted native and growth proof remain deferred; this source pass runs changed-file formatting
and the affected Kernel typecheck.

## Bounded root append

Decision: expose the existing root-only append as `hosted_catalogue.append_root_chapter` at
`POST /v1/hostedCatalogues/{id}:appendRootChapter`. Its closed body is `expectedRevisionId`, fresh
`occurrenceId`, bounded `title` and exact `target`; its success body is the existing `{catalogueId, revisionId}`
response. The existing sealed-base/prefix command, native admission, receipt replay and mixed-revision reader remain
the implementation. This route is mounted on Dev; installed Client and Web receiving are separate work.
The [Book requirement](../../../../docs/goals/content.md) still includes nested parts, arbitrary add/reorder/move,
frozen publication and exact links. This root-only slice does not close it or remove every logical limit.

### Premises and sources

Legacy complete replacement remains limited to 512 placements and depth 16 by `hosted-chapters-{tree,limits,schemas}.ts`;
`db/content/schema.sql` restricts legacy positions/ordinals to 0–511. Its writer inserts complete snapshots.
Web's `studio/hosted-native.ts` drains outlines, `hosted-structure.ts` materializes the tree, and `hosted-adapter.ts`
sends complete replacements. Paging alone therefore cannot enable a long Book write.

Original design sources: the authoring/release and cost contracts here; those files; `hosted-chapters-model.ts`;
`test/content/hosted-{chapters,author-outline,chapters-growth}.test.ts`; Web's `tests/studio-hosted-outline.test.ts`;
[architecture's bounded-work rule](../../../../docs/architecture.md);
[Knowledge structure/storage](../../../../docs/knowledge-workspaces.md#structure-storage-and-concurrency);
`library/collection-order-placement.ts`; and the main checkout's read-only `.reference/INDEX.md`.
PostgreSQL's [ordered index seeks](https://www.postgresql.org/docs/18/indexes-ordering.html) and
[leading-key constraints](https://www.postgresql.org/docs/18/indexes-multicolumn.html) support the access-path design;
actual plans remain measurement work. Knowledge's mutable notebook and Collection's order repair cannot preserve
old immutable Book membership directly; root append needs neither fractional keys nor rebalance.

Sources read before mixed-reader implementation: this owner contract and the named internal storage handoff's
`hosted-chapters-append.ts`, append migration and root-append fixtures; `hosted-chapters-{reads,store,cursor,schemas,
model,disclosure}.ts`; and the existing author-outline/navigation metadata fixtures. The dependency is received
by cherry-pick. The read slice changes no writer or migration.

Sources read before selected mixed-release implementation: this owner contract; `hostedReleasePlacements` and
the exact membership/page helpers in `hosted-chapters-store.ts`; the pinned descriptor in `hosted-chapters-append.ts`
and `hosted-chapters-model.ts`; `hosted-append-read-exact.sql`; release preparation and immutable writing in
`hosted-chapters-commands.ts`; `selectHostedRelease`; and the existing release-selection/admission and append-read
fixtures. The combined writer/read dependency is present in the base.

### Immutable representation and internal write

`hosted_append_descriptor` names one sealed legacy structure revision, its placement/root counts and an inclusive
high-water mark. The base revision is also the stream identity; an empty prefix has high-water -1. Each append adds
one immutable `hosted_append` row and one descriptor sharing that base. Offsets start at zero; root position is
base root count plus offset, and preorder ordinal is base placement count plus offset. There are exactly two
segments, never a descriptor chain. Old descriptors cannot see later rows. Complete replacement starts a fresh
legacy snapshot; a subsequent append seals it as a new stream without changing earlier rows or bindings.

Full `(route,catalogue,stream,offset)` and `(route,catalogue,stream,occurrence)` indexes support prefix seeks and
exact membership. Base/revision and occurrence/stream indexes support bounded cleanup discovery. Same-home
foreign keys retain existing native routing and keep shared bases alive. Migration up copies/scans no legacy tree;
down removes unused storage/lazy base descriptors but refuses while any append row remains, even after replacement.
No destructive cascade, compaction, mutable prefix or history walk is introduced.

The internal operation in `hosted-chapters-commands.ts` takes catalogue, expected draft revision, one fresh routed
occurrence, title and exact chapter target with ordinary Idempotency-Key. Parent is null; the new root follows
the last root's entire subtree. Duplicate target Posts under fresh occurrences are valid; identity reuse,
retargeting, moves and nested append are not. Kind and target Post remain permanent occurrence identities.
Chapter bodies are independently saved Posts. Publication pointers and those Posts are untouched.

Native Post authorship, container disclosure/participation and `post:revise` precede receipts. Preparation and final
retained metadata validate one distinct exact target with known deadlines and zero bodies; earlier targets are not
revalidated. The ordinary command transaction, single-use authority, receipt and rollback machinery remain in use.
An authorized exact replay returns its original immutable draft after later appends; changed operands conflict.
Receipt lookup precedes locked head CAS; two fresh keys against one expected head have one winner and one 412,
without spending an offset or leaving partial placements. Revoked authority cannot recover access from a receipt.
The append receipt kind is separate; the existing revise event contains only catalogue/revision identities.

A legacy head seals lazily after admission/receipt/head fence with two indexed descending `LIMIT 1` probes:
preorder maximum and root-position maximum, each plus one, empty yielding zero. At most two placements are read,
none copied. Append then reads one descriptor/occurrence identity and writes one occurrence, stream row,
descriptor, head update and ordinary receipt/event records. Structural rows/title bytes/dependency calls do not
grow with Book width, depth or revision history, apart from B-tree descent. Native Access/container/partition work
remains charged. The internal root fixtures pin these bounds, replay, races and depth-16 append beyond 512.

### Pinned mixed-revision reads

Decision: read each exact draft through its immutable descriptor, seek at most `limit+1` candidates per indexed
base/prefix segment and merge once; preserve legacy snapshot/publication semantics and widen only read addresses and
cursor frontiers to safe integers. Full replacement remains on its original bounded contract.

Selection reads the revision and optional descriptor in one partition snapshot. Missing descriptors retain the
legacy snapshot key; frozen publications use their original manifests without a descriptor probe. Current native
catalogue metadata and retained revise admission precede placement disclosure and close again before response.
Exact selectors, query/viewer/session binding, partition epoch, private/no-store and anchors remain unchanged.

Exact occurrence lookup probes the base primary key then, if needed, one stream/occurrence key fenced by the
inclusive watermark. It cannot see another stream or later append. Root children seek base sibling positions and
prefix offsets; outline seeks base preorder and prefix offsets; previous/next seek the base chapter-only ordinal
index and prefix offsets in the requested direction. Parts remain navigation origins. Nested children use only
the base parent/position index. There is no whole-tree selection, count, offset pagination, history walk or refill.

All base addresses precede every append address. Forward merge concatenates base then prefix; reverse merge
concatenates prefix then base. It inspects at most twice `limit+1` candidates and retains the first `limit+1`.
Only the first `limit` raw slots receive ordinary retained metadata disclosure; duplicate exact targets share the
existing observation. Withheld slots expose only address/kind and advance the raw frontier. Pages/occurrence
metadata select zero chapter bodies; exact opening alone fetches and verifies the ordinary Post body.

Offsets cross the database boundary as decimal text. Derived ordinal/position use bigint arithmetic before exact
number conversion; storage checks keep counts at or below `MAX_SAFE_INTEGER`. Legacy seeks cast the boundary
parameter to bigint, leaving the indexed column untouched, so a frontier beyond int4 stays exact. Read wire
positions and cursor frontiers accept safe integers beyond 511; legacy replacement input stays at 0–511 and 512
placements. The concrete compatibility defect fixed is position 512 being rejected by the old response schema
and continuation decoder. No larger arbitrary Book cap is adopted; checked arithmetic rejects exact-count overflow.

### Receiving, exposure and verification

Depth 16, title length 256, page size 20, 512 release IDs and bounded complete-replacement input remain logical
limits. Exact full replacement may intentionally shrink a larger draft; it is not a merge, and stale replacement
still gets 412. Existing snapshots, publications, exact identities, links and receipts remain immutable.

The receiving contract and remaining release gates are:

- The mounted Dev operation is `hosted_catalogue.append_root_chapter`, exposed to generated clients as
  `POST /v1/hostedCatalogues/{id}:appendRootChapter`. Its closed JSON input is `{expectedRevisionId, occurrenceId,
  title, target}`; success is HTTP 200 with `{catalogueId, revisionId}`. It uses the ordinary `Idempotency-Key`,
  authenticated `post:revise` action, write rate limit, session anchor and `private, no-store` response. Client
  generation/receiving is unchanged and remains a separate gate.
- Release selection reads explicit IDs from the pinned base/prefix and builds the existing separate dense manifest.
  Native authorization, target admission, receipts and CAS remain unchanged. `hosted-append-release.test.ts` pins
  mixed ordering, exact targets/replay and links, later-prefix withholding, withdrawal and zero unselected/body reads.
- Lifecycle erasure/cleanup uses the [bounded private-title disposition](hosted-append-lifecycle.md). The tombstone
  persistence, exact replayable pages and both native workflow receivers are implemented; lifecycle/native
  acceptance remains deferred to the Dev verifier.
- Mounted HTTP witness execution, native fixture execution, query-plan/growth proof and installed Client/Web
  receiving remain deferred to their owners and the Dev verifier. This Dev exposure does not publish Main or authorize public
  rollout. Old Web must refuse oversized outlines and never save a partial tree; new Web must append from an exact
  head and bounded outline window without draining pages. Unsupported organizing remains explicit pending its own
  immutable-order design.

The mixed-reader fixtures `test/content/hosted-append-read*.test.ts` cover cross-segment order, root/preorder address
differences, nested children, exact prefix membership, old links, zero-body metadata, concealed raw progression,
revision-pinned continuation/expiry, revoked catalogue disclosure and exact large addresses. Existing
outline/navigation session/query-binding and initial/final revise-loss assertions remain unchanged.
Source checks are changed-file formatting and one affected Kernel typecheck; these native fixtures run after
landing in the dev verifier. Mounted, browser, query-plan and growth verification remain deferred. Growth proof
must cover 1,000/10,000/100,000 appends and many revisions, indexed extrema, constant structural rows/zero bodies,
release selection, bounded lifecycle and composed native authority costs. No measured latency/cost claim is made.
Publishing an entire long Book, deeper nesting and scalable arbitrary reorganization remain follow-on work.

## Author inventory

`own_hosted_catalogues.list` (`GET /v1/accounts/{accountId}/hostedCatalogues`) accepts `scope=same-home`
(the default) or `scope=all-homes`, optional `limit` (1–20), and an opaque `cursor`.
`own_hosted_catalogues.get` (`GET /v1/accounts/{accountId}/hostedCatalogues/{id}`) resolves an exact owned
catalogue in its native Post home without a caller-supplied thread. Both require the acting account to match
`accountId`, including organization actors, with current account admission, delegation and consent.

Decision: preserve same-home behavior and cursor identity; all-homes uses one hosted-membership fact in the existing
author-item locator, bounded source recovery in the own-drafts maintenance workflow, and native per-home disclosure.
The inventory never enumerates Posts or account homes on a request. The locator is only a candidate directory:
each entry repeats current Post, Board, Realm and ancestor disclosure, original author, `post:revise`, and the exact
catalogue head/release state in that entry's own home. A hidden, erased, changed or no-longer-editable candidate is
omitted, including all identifiers and unpublished heads. Dependency errors propagate instead of becoming empty pages.

Responses contain `scope`, `viewer`, `items` and `nextCursor`; exact selection returns `item` instead of the page fields.
Entries contain catalogue/thread IDs, original Post creation time, current Post revision/visibility, structure head and
nullable publication ID, plus an optional `title`. They contain no manuscript bodies or placement selections.
Same-home responses keep
`scope={kind:'same-home',route:accountRoute,crossHome:'unavailable'}`. All-homes responses use `kind='all-homes'` and
`crossHome='complete'` only when both initial and final coverage observations prove the native census complete and no
pending source projection for that author; otherwise `crossHome='partial'`. Exact foreign selection also uses all-homes
scope and reports current coverage, even when its exact record is already available before recovery finishes.

Decision: owner list and exact get share native `readPostMetadata` and its retained original Access/ancestry
observation, selecting zero revision body bytes. After account and coverage work, that observation closes with current
`post:revise` and catalogue thread, creation time, structure head and publication pointer checks in the same source
transaction. The originally observed Post revision, author and partition/epoch remain the disclosure fences; taken-down
Posts remain omitted. A fresh head read cannot replace the original proof. Scope, coverage, raw-key continuation and
native session anchors retain the same contract.

Decision: owner list and exact get copy optional `title` only from their final retained native Post/Thread
metadata observation. The existing native draft rule applies: only the opening Post may use its observed Thread
title, bounded with `slice(0, 512)`; reply anchors and null titles omit the field without an ID-derived fallback.
The Thread title is part of the original native fingerprint, so a changed title withholds the item until a fresh
request. Withheld, erased or unavailable observations supply neither an item nor a borrowed label. No additional
lookup, authority or body read is introduced. This additive field is private to the owner inventory; public
discovery, Thread HTTP DTOs and revision headers retain their existing contracts.

Later native proof: `hosted-owner-inventory-metadata.test.ts` observes metadata-only chain selections for same-home
and all-homes paging and exact owner get, including partial/complete coverage and private/no-store session responses.
It pins available/bounded opening titles, absent reply labels and erased items. It also changes a Post title after
the initial metadata read and requires the original retained observation to withhold it; fresh requests can observe
the new revision. Existing owner acceptance keeps its authority, pointer, erasure and cursor
assertions; its dependency-error injection targets the metadata reader. Run both owner test files in the dev verifier
after landing; native acceptance is deferred in this source pass.

All-homes pages seek at most `limit+1` hosted author-item keys ordered by original creation time descending, then ID
ascending, preserving microseconds and ties. At most `limit` sources are hydrated; denied slots are never refilled.
The encrypted continuation uses the last consumed raw key even for an empty sparse page. It binds the original scope,
limit, account, client, delegation, authentication epoch, scope ceiling and author partition epoch. A same-home cursor
cannot continue all-homes, and vice versa. Source anchors use each actual Post partition/epoch, independently of the
author locator partition. Ordinary private/no-store caching and native session anchors apply.

Native catalogue creation leaves an indexed pending obligation in its Post transaction. Post restoration leaves a new
obligation because asynchronous erasure may have removed the locator. Each existing own-drafts maintenance step repairs
at most 20 pending source keys plus 20 catalogue census keys, releasing source checkouts before author commands. It
projects membership under the existing account-erasure fence and late cleanup protocol, carrying current draft metadata
when advancing the locator watermark. Only a committed projection may acknowledge the unchanged source head/security
revision in the same partition epoch. Failure leaves pending work or the census frontier available for retry. The
initial census is over catalogue primary keys, not all Posts, and completes only after all selected keys are projected.
New insertions behind its frontier are covered by their native pending obligations. No new watcher or schedule is added.

Later acceptance: run `bun run --cwd services/kernel check test/content/hosted-chapters-owner.test.ts test/content/event-registration.test.ts` in the dev
verifier after landing. Pin native remote-home exact selection before recovery, complete versus partial coverage,
same-home compatibility, indexed timestamp ties, sparse continuation, cursor scope/session/epoch binding, current
author/revise/container disclosure, mid-read head/erasure changes, bounded idempotent recovery and restoration.
Recovery acceptance also holds a source observation across a newer live Post projection and checks that membership
is added without regressing its draft metadata or acknowledging the changed source.
Existing hosted reading, HTTP and Subject catalogue assertions remain unchanged. Native/browser/growth and broader
acceptance are deferred for this source sprint; the controller publishes the generated client.

## Reading

| Operation ID                        | Method and path                                                       | Query                                             |
| ----------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------- |
| `hosted_catalogue.get`              | `GET /v1/hostedCatalogues/{id}`                                       | selection                                         |
| `hosted_catalogue.children`         | `GET /v1/hostedCatalogues/{id}/children`                              | selection, optional `parentId`, `limit`, `cursor` |
| `hosted_catalogue.resolve`          | `GET /v1/hostedCatalogues/{id}/occurrences/{occurrenceId}`            | selection                                         |
| `hosted_catalogue.resolve_metadata` | `GET /v1/hostedCatalogues/{id}/occurrences/{occurrenceId}/metadata`   | selection                                         |
| `hosted_catalogue.navigate`         | `GET /v1/hostedCatalogues/{id}/occurrences/{occurrenceId}/navigation` | selection, `direction`, `limit`, `cursor`         |
| `hosted_catalogue.for_subject`      | `GET /v1/subjects/{id}/hostedCatalogues`                              | optional `limit`, `cursor`                        |

Selection accepts optional `revisionId` and `kind` (`structure` or `publication`). Without either, it chooses the
current release. `kind=structure` chooses the current draft head, including a catalogue that has never released.
An exact revision remains addressable after moves, removals, later releases or withdrawal; an accompanying kind
must match it. Private structures require current `post:revise` as well as ordinary catalogue Post disclosure.
Metadata contains `catalogueId`, selected `revisionId`, `kind` and nullable `sourceRevisionId`.

`hosted_catalogue.for_subject` lists current public publications associated with an
existing Subject. Candidates come from indexed `subject_thread` rows and same-route
published catalogue-post subject references. Each page inspects at most 21 raw
catalogues, discloses at most 20, and never refills concealed slots. Empty
publications are absent. Historical exact occurrence reads use `hosted_catalogue.resolve` or
`hosted_catalogue.resolve_metadata` and still obey current catalogue and target Access.

Every read retains native catalogue disclosure and repeats it before returning. Chapter disclosure independently
retains the exact native target Post, Board, Realm and ancestor checks. Erased, concealed, missing or changed
targets return an unavailable slot containing only occurrence ID, parent, position, kind and availability. Titles,
target references, digests, attribution and bytes are withheld. Dependency failures remain failures, not evidence
that a target is absent. Parts disclose their titles under catalogue authority.

Library checkpoint pages resolve the saved publication revision and occurrence through the same current catalogue
and target Access checks. Their metadata-only Content binding returns the available title and exact target reference
without selecting chapter bodies; concealed targets return only unavailable metadata while Library retains the
owner's saved address. The selected historical publication remains usable after later chapter moves or current TOC
withdrawal, and opening the checkpoint still uses exact resolution to fetch bytes under current Access.

Resolution returns the selected occurrence and a nullable `document`. Available chapters deliver `encoding=base64`,
the canonical UTF-8 Document bytes as `canonicalBytes`, lowercase `sha256`, original Post `authorId` and `licence`.
Decoding the base64 string yields the bytes covered by that digest. The document is the exact submitted canonical
snapshot for the selected Post revision, including its stable block IDs. The native 2 MiB body bound applies. Parts
and unavailable chapters have a null document. Responses use private, no-store caching and record native session
anchors.

Decision: expose the existing metadata resolver as `hosted_catalogue.resolve_metadata` for Book occurrence and
breadcrumb reads. Its closed response contains only `catalogueId`, `revisionId`, `kind`, `sourceRevisionId` and
`occurrence`, reusing the selection, current Access, session anchors, private/no-store and error semantics of exact
opening. Available chapters include title and exact target; parts include title and a null target. Unavailable slots
retain the existing title/target omissions. There is no `document` field and the operation reads zero chapter bodies.
Exact body opening keeps `hosted_catalogue.resolve` and its canonical digest verification unchanged.

Focused mounted acceptance in `hosted-occurrence-metadata.test.ts` covers current/historical and structure selections,
parts, concealed slots, boundary errors, session/cache headers and zero metadata body reads alongside exact opening.
Run it and the route-registration fixture in the dev verifier after landing; mounted native, browser and broad
acceptance remain deferred. Existing `hosted-navigation-metadata.test.ts` retains exact-body/digest assertions.

Children default to the root; an explicit parent must be a part in the selected revision. Navigation uses preorder
and returns only chapters, excluding the origin. `direction=next` returns ascending order; `previous` returns
descending order, nearest first. A part can serve as the navigation origin.

The default and maximum page limit is 20. A page selects at most limit plus one indexed rows, discloses at most
limit targets, and never refills denied slots. The last raw position determines `nextCursor`. Continuations bind
catalogue, original selector, selected immutable revision, kind, parent/origin, direction, limit, actor identity,
client, delegation, authentication epoch and scope ceiling. They retain the original partition epoch, navigation
origin and 15-minute lifetime. A later release or draft edit does not move a continuing page to another revision.
Changed query bindings, invalid tokens and replaced partition epochs return 400.

## Author outline

Decision: `hosted_catalogue.outline` is an additive author operation at
`GET /v1/hostedCatalogues/{id}/outline`. It pages all placements, including nested
and empty parts, in one indexed immutable preorder stream. It requires an acting
account and current `post:revise` for both structure and publication selections,
including continuations and the final retained native Post/container check.
Public release disclosure alone does not admit this operation.

The closed query accepts the existing optional `revisionId`, `kind`, `limit` and
`cursor`, with the same default release selector and default/maximum limit 20.
The response reuses the existing revision, occurrence and page wire types. Parent
IDs and sibling positions retain their tree meaning; preorder does not renumber
siblings. Available parts retain titles and null targets. Withheld chapters keep
only their occurrence, parent, position, kind and unavailable status.

One route/catalogue/revision/ordinal index seek selects at most `limit+1` raw
rows. The last consumed ordinal advances the cursor even when target metadata
is withheld; there is no per-parent traversal, refill, total count or manuscript
body selection. Retained native metadata disclosure, exact catalogue/revision
and partition epoch, private/no-store and session anchors follow ordinary hosted
reads. Tokens bind the acting account/session, original selector and distinct
outline mode, preserving the first page's revision, epoch and lifetime. The installed full-replacement outline
retains its 512-placement and depth-16 limits; mixed-prefix outline exposure follows the prerequisites above.

The focused `hosted-author-outline.test.ts` source fixture covers nested/empty
parts, ordered bounded pages, immutable continuation, admission and final retained
revise loss, zero body reads and mounted cache/session behavior. Route registration
is recorded in `test/kernel.test.ts`. These tests run after landing in the dev
verifier; mounted, browser, growth and broad verification remain deferred. Client,
Studio and generated publication stay with their existing owners.

## Author history

Decision: `hosted_catalogue.history` is a separate owner-only
`GET /v1/hostedCatalogues/{id}/history` page over the immutable revision index;
opening an entry reuses the existing exact-selection reads.

The query accepts only optional `limit` (default and maximum 20) and `cursor`.
Both structures and publications appear, including an empty withdrawal release.
Items contain only `catalogueId`, `revisionId`, `kind`, nullable `sourceRevisionId`,
`createdAt`, `isCurrentDraft` and `isCurrentRelease`. Publication source IDs select
existing structure revisions. Structure source IDs are null. The current flags
reflect the catalogue pointers at the final authorization snapshot of each page;
a withdrawal remains the current release even though its manifest is empty.
There are no titles, chapter targets, digests, bodies, receipt or transaction IDs,
counts or nested occurrence reads in the response.

History requires the authenticated acting account to be the native catalogue
Post author, with current Post disclosure and `post:revise`. It repeats native
Post, container and revise checks and verifies the catalogue thread and partition
anchor before returning. Public release access and container management alone do
not grant history discovery. A continuation always repeats current admission;
revoked permissions cannot be recovered from a retained token. Cross-home exact
catalogue identities use their own route and do not depend on the author inventory.

Decision: author catalogue history uses native `readPostMetadata` and its exact retained original Access/ancestry
callback for admission and final authorization, selecting zero revision bodies before or after the bounded index
page. Current author and `post:revise`, catalogue/thread and partition epoch identity, final draft/release flags and
opaque cursor binding retain their existing behavior. A changed original Post observation withholds the page;
a fresh head read cannot replace that proof. Body-serving routes keep ordinary body disclosure.

The existing `hosted-chapters-history.test.ts` owner fixture observes zero body selections across initial,
continued and exhausted pages and rejected cursors, one index read bounded by `limit+1`, and original-observation
changes at admission and after page selection. Its existing authorization, cursor, exact reopening and wire assertions
remain unchanged. Run these native tests in the dev verifier after landing; this source pass runs only changed-file
formatting and the affected Kernel typecheck. Mounted native, browser, Storybook and broad acceptance are deferred.

Ordering is `created_at DESC, revision_id DESC`, preserving database microseconds
and using UUID order to break ties. A covering index on route, catalogue and that
ordering supports a strict tuple seek on every page, selecting at most `limit+1`
small records and returning at most `limit`. Newer saves do not invalidate a
continuation or cause earlier rows to repeat. This is a live history directory,
not a frozen inventory: each page refreshes the current flags. An exhausted page
has a null `nextCursor` and never counts or scans all revisions.

Continuations encrypt their raw boundary and bind catalogue, limit, account,
client, delegation, authentication epoch, scope ceiling and partition epoch.
They preserve the first page's 15-minute lifetime. Invalid, altered, expired,
rebound or replaced-partition cursors return 400 after current author admission.
All responses use private, no-store caching and native session anchors. This
reader owns its source SQL and index; it has no dependency on the active author
inventory writer or Commerce checkpoint writer.

Later native acceptance covers mixed history and exact reopening after moves,
removal and withdrawal; tied timestamps and exhausted pages; current flags after
new saves; non-author/public denial; revoked authority with retained cursors;
query/session/epoch binding and fixed expiry; and bounded indexed source reads.
These tests run in the dev verifier after landing. Client generation remains with
the controller.

## Cost and integration boundaries

Complete-replacement and release mutations validate at most 512 placements; mounted root append validates one.
Each reads its distinct exact selected targets through the existing native
metadata reader, including a final retained check, with zero revision body loads. Complete replacements write one snapshot and bounded
placement/identity inserts under the catalogue home transaction. Root append writes one occurrence, one append
row and one descriptor; the first append additionally installs the empty sealed-base descriptor.
Publication reads only explicitly selected source placements and processes their attachments. Reads perform exact
catalogue and revision probes, at most one parent/origin probe and one indexed page query of at most 21 rows.
Subject discovery seeks at most 21 indexed `subject_thread` and same-route catalogue-post candidates, then
discloses at most 20 current publications. Each selected target has an initial and final native disclosure;
catalogue disclosure also repeats at completion.
Decision: Subject continuations remain bound to the Subject partition epoch; each catalogue derives its home from its routed identity and is disclosed only while its initial retained metadata admission, exact publication selection and final retained authority share that catalogue home's epoch. A changed catalogue is suppressed while raw cursor progress continues, and unrelated Subject or catalogue epochs do not hide an admitted Book.
Decision: Contents, previous/next and metadata-only occurrence reads share retained native metadata disclosure,
keyed by the complete thread/Post/revision/digest identity. Initial and final checks load zero chapter bodies and
compare exact identity plus unchanged author/licence. Denied slots still advance the raw frontier without titles
or targets. Exact opening loads one body through ordinary Post disclosure, verifies its canonical digest and size,
then closes the original metadata observation; a fresh exact read cannot bless a changed original source.
The attachment validator remains the write-admission owner; metadata disclosure does not certify canonical bytes.

Native observation is deferred to the dev verifier: `hosted-navigation-metadata.test.ts` observes zero body probes
for Contents, both navigation directions and occurrence metadata, and exactly one verified body on exact opening.
It also pins retained-source changes, concealed sparse slots and raw cursor continuation. Existing hosted reader,
HTTP and Subject eligibility acceptance remains unchanged. No native/browser/Storybook or broader suite runs in
the source pass; changed-file formatting and the affected Kernel typecheck are its selected checks.
Pages retain metadata and authority handles, not manuscript bodies. Resolution serializes one canonical body.
All nested native Access, Accounts, Board, Realm, partition, transaction, serialization and body work remains charged.

The ordinary Content HTTP composition mounts these declarations and the existing event catalogue registers their
events. Schema dump refresh, installed client publication, integration acceptance and measured native growth belong
to the existing integration and publication workflows. No alternate publisher or local readiness assertion is supplied.
