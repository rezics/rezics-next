# Hosted catalogue API

The hosted book profile extends an existing Post in its current home. The Post remains the catalogue identity and
authority. Commands use ordinary Post owner/container admission and native receipts; they create no resources,
grants, Subjects or bodies. Columns and individual articles continue to use ordinary Posts without a catalogue.

## Authoring and release

| Operation ID               | Method and path                          | Input                                                                   |
| -------------------------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| `hosted_catalogue.create`  | `POST /v1/hostedCatalogues`              | `postId`, `threadId`, `placements`                                      |
| `hosted_catalogue.revise`  | `POST /v1/hostedCatalogues/{id}:revise`  | `expectedRevisionId`, `placements`                                      |
| `hosted_catalogue.publish` | `POST /v1/hostedCatalogues/{id}:publish` | `expectedRevisionId`, nullable `expectedPublicationId`, `occurrenceIds` |

Every command requires an Idempotency-Key and returns `catalogueId` and the newly selected `revisionId`. Create
returns 201; revise and publish return 200. A fresh command with a stale head or release returns 412. Native
authorization precedes receipt lookup, while concurrency comparisons follow it: an authorized exact retry can
return its original immutable revision after later changes. An altered request under the same key conflicts.

Each placement supplies `occurrenceId`, nullable `parentId`, zero-based sibling `position`, `title` and `kind`.
Parts have no target. Chapters supply a target containing `threadId`, `postId`, `revisionId` and lowercase SHA-256
hex. The occurrence and parent IDs carry the catalogue's route; target identities carry the target Post's route.
A structure has at most 512 occurrences, depth 16 and 256 Unicode characters per title. Empty structures, empty
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

Decision: publication reads only the bounded explicit occurrence selection from the exact expected structure
revision, using the existing route/catalogue/revision/occurrence primary key and stored ordinal order. Empty
withdrawal verifies that source revision is a structure but issues no placement query. The shared release validator
still rejects duplicate and unknown IDs and missing ancestors, then assigns dense sibling positions and preorder.

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
withdrawal, responses and events retain their existing behavior. The 512-occurrence limits remain unchanged.

The focused `hosted-release-selection.test.ts` fixture distinguishes source rows selected at the store boundary
from the final manifest and covers sparse ordering, withdrawal and selection rejection.
`hosted-release-selection-admission.test.ts` reuses the native hosted fixture to pin owner admission before source
reads and selection errors, admitted rejection, exact publish/replay after a later draft and current authority on
replay. Existing replay acceptance in `hosted-chapters.test.ts` remains unchanged. Run these cases after landing in
the dev verifier. Mounted native and growth proof remain deferred; this source pass runs changed-file formatting
and the affected Kernel typecheck.

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
nullable publication ID. They contain no titles, manuscript bodies or placement selections. Same-home responses keep
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

Later native proof: `hosted-owner-inventory-metadata.test.ts` observes metadata-only chain selections for same-home
and all-homes paging and exact owner get, including partial/complete coverage and private/no-store session responses.
It also changes a Post after the initial metadata read and requires the original retained observation to withhold it;
fresh requests can observe the new revision. Existing owner acceptance keeps its authority, pointer, erasure and cursor
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
outline mode, preserving the first page's revision, epoch and lifetime. The
512-placement and depth-16 limits remain unchanged.

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

Mutations validate at most 512 placements and read each distinct exact selected target through the existing native
metadata reader, including a final retained check, with zero revision body loads. They write one snapshot and bounded
placement/identity inserts under the catalogue home transaction.
Publication reads only explicitly selected source placements and processes their attachments. Reads perform exact
catalogue and revision probes, at most one parent/origin probe and one indexed page query of at most 21 rows.
Subject discovery seeks at most 21 indexed `subject_thread` and same-route catalogue-post candidates, then
discloses at most 20 current publications. Each selected target has an initial and final native disclosure;
catalogue disclosure also repeats at completion.
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
