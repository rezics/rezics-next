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

Selection preparation follows `hostedPostAuthorization.prepare`; only the catalogue locator runs before native
Post authorship/container visibility/participation, authority-anchor and authoritative-time `post:revise` admission.
It reads the expected immutable structure/selected rows with the original partition/deadline, then validates target
attachments outside the write transaction. Keep complete preparation only for that invocation's attempt time; every
retry re-admits and rereads, so failed preparation cannot lend a later transaction earlier selections. This admits
reads, not mutation. Transactional authorization still consumes the single-use proof and rechecks the container
before receipts, with existing finalization. For admitted authors selection/attachment errors precede receipts;
head/publication CAS follows them. Empty withdrawal, exact replay, responses, events and both 512 limits stay unchanged.

## Versioned outline adoption

Decision: adopt the [shared versioned ordered forest](../../../../docs/knowledge-workspaces.md#shared-versioned-outline-primitive)
with Book-owned placement values, identity bindings, authorization and release manifests. Implement point add,
reorder/reparent and removal against an expected draft with stable `parentId`/`beforeOccurrenceId` anchors. Parts may
parent children; chapters cannot. Occurrence kind and target Post remain permanent; a title or exact target revision
change creates a new value under the same occurrence. Do not introduce a universal graph table or use Knowledge's
notebook/document schema. Installed routes, schemas, production settings and release limits stay unchanged.
Root append establishes no arbitrary-outline or release readiness.

### Evidence and migration

Sources checked before this decision: this document; Knowledge's
[storage/concurrency contract](../../../../docs/knowledge-workspaces.md#structure-storage-and-concurrency) and Content's
[Notebook reorganization](README.md#notebook-reorganization-and-revision-recovery);
[`knowledge-order.ts`](knowledge-order.ts), [`knowledge-commands.ts`](knowledge-commands.ts),
[`knowledge-reads.ts`](knowledge-reads.ts), [`knowledge-model.ts`](knowledge-model.ts);
[`hosted-chapters-tree.ts`](hosted-chapters-tree.ts), [`hosted-chapters-model.ts`](hosted-chapters-model.ts),
[`hosted-chapters-store.ts`](hosted-chapters-store.ts), [`hosted-chapters-append.ts`](hosted-chapters-append.ts),
[`hosted-chapters-commands.ts`](hosted-chapters-commands.ts), [`hosted-append-lifecycle.ts`](hosted-append-lifecycle.ts),
[`db/content/schema.sql`](../../db/content/schema.sql);
the independent [Knowledge model](../../../../docs/research/knowledge-workspaces-model-astra.md) and
[product investigation](../../../../docs/research/knowledge-workspaces-product-astra.md),
[scalability audit](../../../../docs/research/universal-scalability-audit.md) and its
[follow-up](../../../../docs/research/universal-scalability-follow-up.md);
Collection's [`collection-publication-staging.ts`](../library/collection-publication-staging.ts),
[`collection-publication-staging-state.ts`](../library/collection-publication-staging-state.ts) and
[native staging fixture](../../test/library/collection-publication-staging.test.ts).
The main checkout's read-only `.reference/INDEX.md` supplies provenance, not an outline storage benchmark.
The audit's whole-snapshot finding still applies to replacement; sealed-prefix
append and selected publication now avoid that scan only for their own operations. Knowledge's delivered AVL
supersedes the premise that only a mutable outline exists; its current keys and lookup limits remain relevant.

Keep three version descriptors readable: legacy snapshot, sealed snapshot plus inclusive stream high-water, and
new forest. Install no eager whole-catalogue conversion. For the first arbitrary edit, pin its exact source and
prepare a baseline forest in retained bounded steps. Snapshot input seeks its ordinal index; sealed input visits
base then offsets through the captured high-water, never the latest stream tail or a descriptor chain. Preserve
occurrence IDs, title/target selections, sibling order and preorder. Build point facts, sibling roots and summaries;
seal only after complete source coverage and activate under source-head CAS. Until completion the old draft and
all old readers/writers remain authoritative. A racing append/replacement makes activation stale; it cannot become
a mixed baseline. Preparation restart/expiry releases its holds and reclaims its abandoned nodes in bounded work.

Reuse the 512-row snapshot writer and bounded selection publisher unchanged. A new replacement may still intentionally
shrink a larger draft. Existing exact snapshots, descriptors, publications, receipts, checkpoints and cursors retain
their addresses and current Access behavior. Never rewrite old versions into the current forest or infer that an
unused current base is reclaimable. Knowledge needs no wholesale migration: adapt existing sibling roots, add the
historical point/summary access paths with a pinned resumable baseline, and retain `history_complete` behavior;
do not fabricate unavailable pre-baseline history.

## Prepared Book publication

Choose Book-owned **prepare → seal → activate**, separate from structural indexing. It can start against the delivered
snapshot/prefix reader before forest storage is decided. It publishes a manifest of exact target selections, not
Post bodies or Knowledge documents. Collection staging is an invariant example: its
[seal reader](../library/collection-publication-staging.ts) checks native source identity, frontier exhaustion,
evidence/member fences and current native inputs; the fixture keeps complete A selected while B is interrupted.
Reuse that reasoning, not Collection's custody, query population, Search proof or tables.

Prepare captures catalogue, initiator, partition epoch, expected draft and publication IDs, selector mode, exact
source descriptor and expiry under ordinary current Post author/revise admission. Modes are `whole` (every placement
of that exact draft) and `selection` (the exact explicit occurrence IDs). A fresh later draft is never substituted.
The current maximum is 512 manifest placements **including parts/ancestors** for either mode. A larger whole draft
is rejected once the bounded source proves a 513th member; it is never silently truncated. Selection input retains
its 512 cap, duplicate/unknown rejection and requirement that every ancestor is explicitly selected. Do not add
unselected private ancestors automatically. Empty selection uses existing atomic withdrawal; it is not an unfinished
or accidentally empty preparation. No API for this protocol is claimed mounted by this decision.

Persist one small control row, indexed selected/staged rows and a durable raw frontier; no growing JSON array or
process-local completion flag. One retained step consumes at most the existing Book page bound of 20 source rows
(with one lookahead), bounds metadata/target checks and writes at most that page plus fixed control/effect records.
Selection uses bounded exact membership probes, ordered by the pinned source, not a full outline scan. Whole uses
raw traversal exhaustion, not the number of visible/disclosed rows. Parts and duplicate Post occurrences remain
distinct. Store deterministic immutable title/kind/parent/target revision/digest values, with a private rolling
commitment over canonical ordered rows and committed counts/frontier. Keep ordinals/dense sibling positions as
manifest projections. Across steps, commit output and frontier atomically; exact retries cannot skip or duplicate a
row. A crash after a step but before response returns the same native receipt.

Seal proves source identity/epoch, complete traversal or settlement of every requested ID, uniqueness, explicit
ancestor closure and exact ordered manifest coverage. It checks persisted staged rows, never caller-supplied counts,
digests or a `complete` boolean. Sparse/unavailable input is not empty success. Bind the seal to preparation version,
source descriptor, selection digest, staged-row commitment, counts and lifecycle fences; expiry/cancel/erasure makes
it unusable. With the unchanged 512 cap, final closure/order and seal verification may read at most 512 small rows.
No larger release is authorized by moving that work into a job.

Activation runs ordinary current native author/container/`post:revise` admission **before receipt replay**, reads the
native seal by locator, and prepares/rechecks every distinct exact target through existing attachment metadata and
retained original Access/ancestry observations. Check thread/Post/revision/stored digest/author/licence with zero
bodies. Preparation-time permission results are not reusable authority. Current target revocation, erasure or changed
observation rejects activation; dependency errors remain errors. Use the existing command proof/finalization machinery
and its deadlines, not a copied permission formula or a fresh source read that blesses an old observation.

After authorized receipt replay, CAS the draft against the pinned source and the publication against its expected
ID; a draft edit during preparation therefore requires a new preparation. Final retained checks close the admitted
observations, and the Book-home transaction exposes the complete immutable manifest and advances its publication
pointer with an identity-only event/receipt. It exposes no partial rows. Complete A remains selected through partial
B, a failed seal/activation, crash or stale CAS; a lost successful activation response replays B exactly even after
later changes, provided current authorization still admits replay. Cancel/expiry discards B without withdrawing A.
Cross-home metadata checks retain their existing native consistency contract, not a new distributed transaction.

Only an admitted author sees preparation progress/selection. Public routes, history projections, discovery,
notifications, outbox and URLs receive no preparation locator, private title, unselected occurrence, target or body.
A release still requires ordinary Post publication and current target disclosure; preparing a release publishes
nothing. Private rows and commitments follow Book erasure and hold/reclamation policy. A seal cannot preserve
private selections after their lifecycle fence closes. Current limits bound activation to at most 512 rows/targets;
any future larger release needs a separately adopted activation-currentness mechanism, not another numeric increase.

### Implementation handoff and acceptance

Deliver these independently reviewable slices; none changes release exposure before native proof:

1. **Forest port and Knowledge adapter:** extract the delivered path-copy algorithm without product types/SQL;
   add reverse seeks/summary laws and historical placement facts. Keep current cursor/title/publication semantics.
   Extend [`knowledge-history.test.ts`](../../test/content/knowledge-history.test.ts) for exact historical point and
   children after reorder, reparent/removal and local rebalance. Preserve existing replay/cycle/body assertions.
2. **Directory storage check, then Book adapter:** compare the two directory mechanisms and growth dimensions
   [named by the shared contract](../../../../docs/knowledge-workspaces.md#cost-storage-choice-and-retention).
   Add retained key-generation completion, Book rank/chapter summaries and descriptor migration. Preserve
   [`hosted-append-read.test.ts`](../../test/content/hosted-append-read.test.ts),
   [`hosted-root-append.test.ts`](../../test/content/hosted-root-append.test.ts) and
   [`hosted-append-lifecycle.test.ts`](../../test/content/hosted-append-lifecycle.test.ts).
3. **Book publication preparation:** implement owned control/rows, pinned capture, bounded steps, native seal and
   activation. This can start now against snapshot/prefix selection; forest support is another source adapter.
   Keep [`hosted-release-selection.test.ts`](../../test/content/hosted-release-selection.test.ts),
   [`hosted-release-selection-admission.test.ts`](../../test/content/hosted-release-selection-admission.test.ts) and
   [`hosted-append-release.test.ts`](../../test/content/hosted-append-release.test.ts) assertions unchanged.
4. **Native/API and mounted receiving:** only after owner commands/readers exist, mount declared operations and
   generate the client. Studio source/destination review uses stable observed IDs and one expected revision;
   one confirmation issues one bounded command. Knowledge organization retains its current stale/reselect behavior.
   Existing [Book reader](../../../../apps/web/src/books/reader/README.md) exact links/checkpoints remain compatible.

The missing executable acceptance belongs with those implementations, rather than green tests of this document:

| Case                          | Required user-visible/native assertion                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `outline.anchor-move`         | Insert before/end, reorder/no-op and reparent preserve IDs; stale, wrong-parent, deleted and self anchors never silently choose another destination. Opposite moves cannot commit a cycle; exact depth boundaries and parent-kind rules hold.                                                                                                                              |
| `outline.hot-gap-subtree`     | Repeated insertion at one gap reaches local exhaustion and retained generation completion; interrupted/stale rebuild leaves old readers intact. Moving a large subtree changes no descendant rows; exact historical point/children/preorder and both chapter directions stay correct, including empty parts and concealed slots.                                           |
| `outline.migration-retention` | Pinned legacy and sealed-prefix baselines match independent traversal; a later append is excluded and stale activation fails. Resume after crash, expiry and erasure; old receipts/checkpoints/releases and shared-prefix roots survive reclamation.                                                                                                                       |
| `book.prepare-activate`       | Whole and explicit selection pin exact versions, retain explicit closure and the 512 cap (whole 513 rejects). Interrupted B leaves A; duplicate step/commit-loss retry is exact; forged/partial/expired seals, draft/publication races and revoked author/target fail without exposing private selection or bytes. Successful B retains pinned digests after later drafts. |
| `outline.mounted-review`      | Mounted native HTTP repeats current admission on page/confirmation/replay; Studio and Knowledge keep choices after 412/409 but require fresh review, issue one move per confirmation and retire session-stale results. Book preparation displays A until B activates; anonymous/public projections reveal no private progress.                                             |

Run the native cases through the owning Kernel `check` runner with explicit implementation test files; mounted
consumer cases through their owning Web runner. Add only stories for review, preparing-with-old-release, conflict
and unavailable states once those controls exist. Growth proof varies sibling width, history, hot-gap repetition,
subtree size and depth separately, accounting for native authorization, body bytes (zero on metadata paths), SQL
buffers/WAL, retained storage and cleanup. These are implementation acceptance requirements, not passed checks or
release-readiness evidence from this specification.

## Bounded root append

`hosted_catalogue.append_root_chapter` mounts the delivered sealed-base/root-only command on Dev. It takes the
expected draft, fresh routed occurrence, bounded title and one exact target under ordinary native Post author/container
admission, write rate limit, Idempotency-Key, session anchors and private/no-store. Parent is null; the new chapter
follows the last root's whole subtree. Duplicate target Posts under fresh IDs are valid; identity reuse, retargeting,
moves and nested append are not. It changes neither Post bodies nor the publication pointer. Client generation and
Web receiving remain separate gates; Dev exposure authorizes no Main/public rollout.

Legacy replacement remains capped at 512/depth 16 by `hosted-chapters-{tree,limits,schemas}.ts`; legacy database
positions/ordinals remain 0–511. Web's `studio/hosted-native.ts` drains the outline, `hosted-structure.ts` materializes
it and `hosted-adapter.ts` sends replacement. Old Web must refuse oversized outlines and never save a partial tree;
new Web must append from an exact head/window without draining pages. The root-only slice does not close arbitrary
outline authoring, whole long-Book publication or the [Book requirement](../../../../docs/goals/content.md).

### Immutable representation and internal write

A `hosted_append_descriptor` names one sealed legacy structure, placement/root counts and inclusive high-water
(-1 for empty). The base revision is the stream ID. One append creates one immutable row and descriptor sharing
that base; offset starts at zero, root position is base root count plus offset, ordinal base placement count plus
offset. There are two segments, never a chain. Replacement starts a new snapshot; later append seals a new stream.
Old descriptors cannot see later offsets.

Full route/catalogue/stream/offset and stream/occurrence indexes support prefix seeks/exact membership. Base/revision
and occurrence/stream indexes support cleanup; same-home FKs retain shared bases. Migration up copies/scans no tree;
down removes unused descriptors/storage but refuses while append rows remain, even after replacement. No destructive
cascade, compaction, mutable prefix or history walk is introduced.

Current native authorship/container participation and `post:revise` precede receipts. Preparation/final retained
metadata checks validate only the new exact target with deadlines and zero bodies. Replay returns its original draft
after later appends; changed operands conflict. Receipt lookup precedes locked head CAS: fresh keys against one head
have one winner and one 412, with no spent offset/partial placements. Revoked authority cannot recover from a receipt.
The append receipt kind is separate; the existing revise event carries only catalogue/revision identities.

A legacy head seals lazily after admission/receipt/head fence with two descending indexed `LIMIT 1` extrema probes
(preorder and root position), empty yielding zero. Read at most two placements and copy none. Append reads one
descriptor/identity and writes one occurrence, append row, descriptor, head plus ordinary receipt/event records.
Structural work does not grow with Book width/depth/history apart from B-tree descent; native Access/partition work
remains charged.

### Pinned mixed-revision reads

Select revision/descriptor in one partition snapshot; absent descriptor means legacy snapshot. Publication manifests
retain their original revision key without a descriptor probe. Current native catalogue metadata/revise admission
precedes draft placement disclosure and closes before response. Keep exact selectors, query/viewer/session binding,
partition epoch, private/no-store and anchors.

Exact occurrence probes base primary key then stream/occurrence fenced by high-water. Root children seek base sibling
positions plus offsets; outline seeks base preorder plus offsets; chapter navigation seeks chapter-only base ordinal
and prefix in either direction. Parts remain origins. Nested children use only the base parent/position index.
Forward merge is base then prefix, reverse prefix then base. Seek at most `limit+1` per segment and retain only the
first `limit+1`: no counts, OFFSET, history walk, refill or full-tree selection. Only the first `limit` raw slots get
retained target metadata checks; duplicate exact targets share observation. Withheld slots advance without titles/
targets. Metadata selects zero bodies; exact opening fetches/verifies one ordinary Post body.

Offsets cross SQL/JSON as decimal text. Derive ordinal/position using bigint before exact number conversion; storage
keeps counts within `MAX_SAFE_INTEGER`. Cast legacy seek boundary to bigint, leaving the indexed column untouched.
Read addresses/cursors accept safe integers beyond 511; replacement still accepts at most 512 with dense 0–511
positions. Checked arithmetic rejects overflow; no larger arbitrary Book cap is adopted. Full replacement can
intentionally shrink a larger draft; stale replacement still gets 412.

Release selection uses bounded explicit IDs from pinned base/prefix, not all source placements, then writes its own
dense manifest. [Bounded private-title disposition](hosted-append-lifecycle.md) owns terminal cleanup and shared-base
retention; neither a replacement nor a newer current head proves an old exact base/prefix dead.
Native/mounted acceptance, installed Client/Web receiving and measured growth remain release gates. Growth must
cover 1,000/10,000/100,000 appends, many revisions, indexed extrema, constant structural rows, zero metadata bodies,
selected release, lifecycle and composed authority costs. No latency/readiness claim follows from source delivery.

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

Owner list/get include optional `title` only from final retained Post/Thread metadata: an opening Post's observed
Thread title, `slice(0,512)`; reply/null labels omit it with no ID fallback. Title participates in the original
fingerprint; a change withholds the item until a fresh request. No extra lookup/body read or public discovery,
Thread DTO or revision-header change follows.

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

## Reading

| Operation ID                        | Method and path                                                       | Query                                             |
| ----------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------- |
| `hosted_catalogue.get`              | `GET /v1/hostedCatalogues/{id}`                                       | selection, optional `includeTitle=1`              |
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

Decision: `hosted_catalogue.get` accepts the exact opt-in `includeTitle=1` and may add optional `title` to that
`HostedRevision` response only when the selected revision is a publication and the final retained native observation
confirms a currently published opening Post. For an exact historical publication, `title` describes that current
opening, not a frozen historical label. Draft structures, private or withheld Posts and reply titles supply no title;
the default response and every other reader schema keep their existing shape. The generated query property is
`includeTitle` with value `'1'`, and the response property is `title`. The later Web receiver is
[`apps/web/src/books/reader/native-api.ts`](../../../../apps/web/src/books/reader/native-api.ts): its generated
`hostedCatalogues({ id }).get` query and strict `HostedRevision` decoder must opt in and accept `title` before the
mounted reader uses it. This projection adds no native read and selects no chapter body.

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
Base64 decodes to the exact canonical snapshot covered by that digest, including stable block IDs. The native 2 MiB body bound applies. Parts
and unavailable chapters have a null document. Responses use private, no-store caching and record native session
anchors.

Decision: expose the existing metadata resolver as `hosted_catalogue.resolve_metadata` for Book occurrence and
breadcrumb reads. Its closed response contains only `catalogueId`, `revisionId`, `kind`, `sourceRevisionId` and
`occurrence`, reusing the selection, current Access, session anchors, private/no-store and error semantics of exact
opening. Available chapters include title and exact target; parts include title and a null target. Unavailable slots
retain the existing title/target omissions. There is no `document` field and the operation reads zero chapter bodies.
Exact body opening keeps `hosted_catalogue.resolve` and its canonical digest verification unchanged.

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

## Cost and integration boundaries

Complete replacement/release validate at most 512 placements; root append validates one. Distinct exact targets
use initial/final retained native metadata, zero bodies. Replacement writes one bounded snapshot; append writes
one occurrence/row/descriptor, lazily installing its sealed base. Publication reads only selected source rows.
Legacy reads use exact catalogue/revision and parent/origin probes plus at most 21 indexed candidates; mixed-prefix
bounds are defined above. Subject discovery examines at most 21 indexed `subject_thread`/same-route catalogue-Post
candidates and discloses at most 20, with catalogue/target disclosure repeated at completion.

Subject cursors bind the Subject epoch; each catalogue uses its own routed home epoch across initial observation,
exact release selection and final authority. Changed catalogues are suppressed while raw progress continues;
unrelated Subject/catalogue epochs do not conceal an admitted Book. Metadata observations use full thread/Post/
revision/digest and unchanged author/licence. Exact opening alone loads/verifies one body's digest/size, then closes
the original observation: a fresh read cannot bless a changed source. Attachment validation owns write admission.

Pages retain metadata/authority handles; exact resolution serializes one canonical body. Charge native Access,
Accounts, Board, Realm, partition, transaction, serialization and bytes. Content HTTP/event composition remains
ordinary; schema dump/client publication, native integration and measured growth stay with their existing owners.
The proposed forest/publication protocol adds no mounted operation or release-readiness claim.
