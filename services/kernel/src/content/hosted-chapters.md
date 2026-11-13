# Hosted catalogue API

The hosted book profile extends an existing Post in its current home. The Post remains the catalogue identity and
authority. Commands use ordinary Post owner/container admission and native receipts; they create no resources,
grants, Subjects or bodies. Columns and individual articles continue to use ordinary Posts without a catalogue.

## Authoring and release

| Operation ID                                        | Method and path                                                                         | Input                                                                                                |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `hosted_catalogue.create`                           | `POST /v1/hostedCatalogues`                                                             | `postId`, `threadId`, `placements`                                                                   |
| `hosted_catalogue.revise`                           | `POST /v1/hostedCatalogues/{id}:revise`                                                 | `expectedRevisionId`, `placements`                                                                   |
| `hosted_catalogue.append_root_chapter`              | `POST /v1/hostedCatalogues/{id}:appendRootChapter`                                      | `expectedRevisionId`, `occurrenceId`, `title`, `target`                                              |
| `hosted_catalogue.insert_draft_point`               | `POST /v1/hostedCatalogues/{id}:insertDraftPoint`                                       | `expectedRevisionId`, `occurrenceId`, nullable `parentId`/`beforeOccurrenceId`, `title`, `placement` |
| `hosted_catalogue.remove_draft_point`               | `POST /v1/hostedCatalogues/{id}:removeDraftPoint`                                       | `expectedRevisionId`, `occurrenceId`                                                                 |
| `hosted_catalogue.update_draft_point`               | `POST /v1/hostedCatalogues/{id}:updateDraftPoint`                                       | `expectedRevisionId`, `occurrenceId`, `title`, explicit nullable `target`                            |
| `hosted_catalogue.move_draft_point`                 | `POST /v1/hostedCatalogues/{id}:moveDraftPoint`                                         | `expectedRevisionId`, `occurrenceId`, `parentId`, nullable `beforeOccurrenceId`                      |
| `hosted_catalogue.convert_draft`                    | `POST /v1/hostedCatalogues/{id}:convertDraft`                                           | `expectedRevisionId`, bounded `step`, retained `inputId` and native page cursor when paging          |
| `hosted_catalogue.publish`                          | `POST /v1/hostedCatalogues/{id}:publish`                                                | `expectedRevisionId`, nullable `expectedPublicationId`, `occurrenceIds`                              |
| `hosted_catalogue.prepare_release`                  | `POST /v1/hostedCatalogues/{id}:prepareRelease`                                         | caller-generated `stageId`, `expectedRevisionId`, nullable `expectedPublicationId`, `mode`           |
| `hosted_catalogue.prepare_release_append_batch`     | `POST /v1/hostedCatalogues/{id}/publicationPreparations/{stageId}:appendSelectionBatch` | `batchId`, `occurrenceIds` (1–512)                                                                   |
| `hosted_catalogue.prepare_release_freeze_selection` | `POST /v1/hostedCatalogues/{id}/publicationPreparations/{stageId}:freezeSelection`      | empty object                                                                                         |
| `hosted_catalogue.prepare_release_advance`          | `POST /v1/hostedCatalogues/{id}/publicationPreparations/{stageId}:advance`              | `stepId`                                                                                             |
| `hosted_catalogue.prepare_release_progress`         | `POST /v1/hostedCatalogues/{id}/publicationPreparations/{stageId}:progress`             | empty object                                                                                         |
| `hosted_catalogue.prepare_release_cancel`           | `POST /v1/hostedCatalogues/{id}/publicationPreparations/{stageId}:cancel`               | empty object                                                                                         |
| `hosted_catalogue.prepare_release_seal`             | `POST /v1/hostedCatalogues/{id}/publicationPreparations/{stageId}:seal`                 | empty object                                                                                         |

Every command requires an Idempotency-Key and returns `catalogueId`. Create returns 201; revise, root append, draft
point writes, conversion steps and publish return 200. Conversion returns private phase/count progress and adds the
new `revisionId` only after activation. A fresh command with a stale head or release returns 412.
Native authorization precedes receipt lookup, while concurrency comparisons follow it: an authorized exact retry
can return its original immutable revision after later changes. An altered request under the same key conflicts.

Preparation start returns 202 and the remaining preparation commands return 200. Start supplies a route-native
`stageId`; expected draft/publication IDs are only stale-intent preconditions. Selection batches are independently
limited to 512 IDs with no aggregate cap. Preparation responses are private and no-store, expose only retained
progress and candidate counts, and never select the publication pointer.

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

Decision: SQL observer evidence assigns only the captured half-open interval around a nested native revision to that
revision; the enclosing attachment proof still checks metadata probes before and after it.

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
with Book-owned placement values, identity bindings, authorization and release manifests. `10cec8a9ed` delivered
keyed copy-on-write balancing only; Book uses stable occurrence handles, generation/as-of node and occurrence lookup,
count/rank/select, split/join, sibling/preorder/chapter indexes, current membership proof, head CAS and a distinct
Book adapter. Implement point add, reorder/reparent and removal against an expected draft with stable
`parentId`/`beforeOccurrenceId` anchors. Parts may parent children; chapters cannot. Occurrence kind and target Post
remain permanent; a title or exact target revision change creates a new value under the same occurrence. Do not
introduce a universal graph table, a parallel permission engine, or Knowledge's notebook/document schema. There is
no permanent total structure cap, eager migration, global key relabel, history chain or per-edit full copy. This
decision changes no installed route, schema or production setting. The current 512 limits bound compatibility
requests, never the supported total structure or release. Root append establishes no arbitrary-outline,
serial-publication or release readiness.

Interfaces: the shared sequence port is `point`, `children`, `outline`, `projected`, `rank`, `select`,
`insert`/`move`/`remove` and `apply` in
[Knowledge workspaces](../../../../docs/knowledge-workspaces.md#shared-versioned-outline-primitive). Persistence
is a Book adapter over that port; initial SQL is row-per-node temporal as-of indexes. Exact source consent is a
Content command/read seam mounted at the source Post: issue, reuse or revoke
`(catalogueId, threadId, postId, revisionId, sha256)` under source admission, then Book membership proof plus current
Access/ancestry/Board/Realm/takedown/erasure on read. Dependencies
are `versioned-outline-order.ts`, `hosted-chapters-{model,store,commands,reads,attachments}.ts`,
`readPostMetadata`/`readPost`, and Access [`public-eligibility.ts`](../access/public-eligibility.ts). Knowledge keeps
`knowledge-order.ts`. No Collection tables, no second permission engine, no new architecture module.

Decision: a cross-parent move cuts the stable occurrence subtree's contiguous preorder and chapter ranges and
splices them at the destination's aggregate rank; it updates sibling roots, moved-root containment and only changed
ancestor summaries, without visiting descendants.

Decision: mount the stable-anchor move as `moveDraftPoint`; require an existing part `parentId`, and interpret a
null `beforeOccurrenceId` as the end of that parent's sibling list. The existing move command retains author
admission, receipt, idempotent replay and the identity-only revise event. The native move adapter selects and writes
the expected ordered snapshot in the same transaction as its head CAS. An adjacent move returns the current
revision without writing a new revision or event.

Decision: the retained binder resolves the expected immutable structure descriptor after author admission; the
native adapter proves selected membership and bounded containment paths in that draft snapshot, then commits all
three final index roots, moved containment and changed size/chapter summaries through one store overlay with the
revision-head CAS. Adjacent no-op retains the existing revision; selection and writes never enumerate the subtree
or load target bodies. Route mounting remains with its owner.

Decision: point insertion and subtree removal resolve one expected snapshot and update the existing sibling,
preorder and chapter indexes; removal cuts ranges by stored aggregates without visiting descendants, preserving
historical roots and permanent occurrence identity. Admitted authors bind insert and subtree removal through
`hostedPostAuthorization` and `runCommand` against the native `createHostedVersionWrite` producer: one expected
snapshot per attempt, changed chapter attachments validated before the transaction, exact receipt replay before
expected-head CAS, and an atomic commit of sibling/preorder/chapter roots, permanent occurrence identity, changed
ancestor summaries, exact immutable revision descriptor, draft pointer, receipt and the identity-only revise event.
Empty catalogues activate one new draft generation on the first point write without attaching the compatibility head
to that generation; the first committed point revision is the first ordered descriptor. Nonempty unmapped legacy
drafts stay on replacement until the ordered-generation builder activates them. Ordered expected revisions consume
`resolveHostedVersionRevision` and `readHostedVersionSnapshot` with the exact returned generation, kind and sequence;
`commitHostedVersionRevision` records the new descriptor and CAS-advances the draft pointer. Compatibility readers
remain for unmapped revisions. Mapped structure revisions fork GET children, outline, navigation and resolve onto the
versioned indexes so advancing the catalogue head never serves an empty legacy page. Do not add a parallel SQL adapter.

Decision: `updateDraftPoint` requires the new title and resulting exact target state (`null` for a part, the
complete thread/Post/revision/digest tuple for a chapter); the occurrence kind and bound chapter Thread/Post cannot
change. After ordinary catalogue author admission it validates the exact target through the existing attachment
observation, then reads one expected temporal snapshot and writes the occurrence plus its sibling, preorder and
chapter payloads through one final-per-key overlay. The immutable descriptor and expected draft pointer commit in the
same catalogue-home transaction; counts, containment, order, descendants and public selection stay unchanged.
Receipt replay remains after authorization and before draft-head comparison. The logical work follows only the
selected index paths; physical SQL probes are reported separately from logical probes.

Decision: focused command and HTTP tests pin insert/remove admission, receipt replay before head CAS, stale-head
412, reused occurrence identity, nested insert, subtree removal that preserves historical snapshots, and GET
children after a point write; they already cover mounted author insert/remove/readback, old exact revision after
edits, stale CAS/replay and private draft disclosure. Planner unit tests, bounded physical probes beyond 512 and
native/browser/root suites stay with their owners.

Decision: Content binds each ordered Book revision to one immutable `(catalogue, generation, sequence)` snapshot.
Exact reads distinguish ordered, compatibility and missing revisions; structure revisions bind draft generations,
publication revisions bind candidate generations and retain the expected draft as source. The shared transaction
seam inserts the native revision and descriptor before CAS-advancing only the caller's draft or publication pointer.
Decision: keep the existing producer, command and HTTP tests; genericize snapshot helpers so structure writes require
draft generations and publication writes require candidate generations. After both producers, add the snapshot and
generation-kind foreign keys in `20261113121340_hosted_version_revision_snapshot_fk.sql` because the descriptor table
did not exist at the store producer timestamp.

Decision: the private adapter appends route/catalogue-bound node and occurrence versions by generation and sequence,
stores sibling/preorder/chapter roots explicitly, and collapses each transaction's repeated keys to their final row.
History seeks use the full equality prefix followed by sequence descending; tombstones are tested after selecting the
latest row. The generation row is the only head fence. This representation stays unmounted and does not alter legacy
snapshots or sealed prefixes.

### Evidence and migration

Sources checked before this decision: this document; Knowledge's
[storage/concurrency contract](../../../../docs/knowledge-workspaces.md#structure-storage-and-concurrency) and Content's
[Notebook reorganization](README.md#notebook-reorganization-and-revision-recovery);
[`knowledge-order.ts`](knowledge-order.ts), [`knowledge-commands.ts`](knowledge-commands.ts),
[`knowledge-reads.ts`](knowledge-reads.ts), [`knowledge-model.ts`](knowledge-model.ts);
[`hosted-chapters-tree.ts`](hosted-chapters-tree.ts), [`hosted-chapters-model.ts`](hosted-chapters-model.ts),
[`hosted-chapters-store.ts`](hosted-chapters-store.ts), [`hosted-chapters-append.ts`](hosted-chapters-append.ts),
[`hosted-chapters-commands.ts`](hosted-chapters-commands.ts),
[`hosted-chapters-attachments.ts`](hosted-chapters-attachments.ts), [`hosted-chapters-reads.ts`](hosted-chapters-reads.ts),
[`hosted-migration-input.ts`](hosted-migration-input.ts) and its model and native tests,
[`hosted-append-lifecycle.ts`](hosted-append-lifecycle.ts),
[`db/content/schema.sql`](../../db/content/schema.sql),
[`20261111120000_hosted_chapters.sql`](../../db/content/migrations/20261111120000_hosted_chapters.sql),
[`20261113025800_hosted_root_append.sql`](../../db/content/migrations/20261113025800_hosted_root_append.sql),
[`20261113035450_hosted_private_title_redaction.sql`](../../db/content/migrations/20261113035450_hosted_private_title_redaction.sql),
[`20261113091612_hosted_migration_input.sql`](../../db/content/migrations/20261113091612_hosted_migration_input.sql), and
[`20261113131801_hosted_version_draft_activation.sql`](../../db/content/migrations/20261113131801_hosted_version_draft_activation.sql);
the independent [Knowledge model](../../../../docs/research/knowledge-workspaces-model-astra.md) and
[product investigation](../../../../docs/research/knowledge-workspaces-product-astra.md),
[scalability audit](../../../../docs/research/universal-scalability-audit.md) and its
[follow-up](../../../../docs/research/universal-scalability-follow-up.md);
Collection's [`collection-publication-staging.ts`](../library/collection-publication-staging.ts),
[`collection-publication-staging-state.ts`](../library/collection-publication-staging-state.ts) and
[native staging fixture](../../test/library/collection-publication-staging.test.ts).
The main checkout's read-only `.reference/INDEX.md` supplies provenance, not an outline storage benchmark.
No separately retained external serial-publication prompt was found in the linked reports/reference index; the
maintainer's serial-publication acceptance governs this decision, without inventing an external citation.

The audit's whole-snapshot finding still applies to replacement; sealed-prefix
append and selected publication now avoid that scan only for their own operations. Knowledge's delivered keyed AVL
and `10cec8a9ed` supersede the premise that only a mutable outline exists; they do not supply generation/as-of
lookup, rank/select, split/join or chapter indexes. Count logical probes and physical SQL/I/O separately.

Keep three version descriptors readable: legacy snapshot, sealed snapshot plus inclusive stream high-water, and
ordered generation. Install no eager whole-catalogue conversion. For the first arbitrary edit, pin its exact source
and prepare a baseline forest in retained bounded steps. Snapshot input seeks its ordinal index; sealed input visits
base then offsets through the captured high-water, never the latest stream tail or a descriptor chain. Preserve
occurrence IDs, title/target selections, sibling order and preorder. Build point facts, sibling/preorder/chapter
indexes and summaries; seal only after complete source coverage and activate under source-head CAS. Until completion
the old draft and all old readers/writers remain authoritative. A racing append/replacement makes activation stale;
it cannot become a mixed baseline. Preparation restart/expiry releases its holds and reclaims its abandoned nodes
in bounded work. Old descriptors, links, receipts and cursors keep their addresses.

Decision: a nonempty sealed private builder activates by copying its existing occurrence facts, sibling/preorder/chapter
nodes and sibling roots into one private draft generation through the temporal store in bounded replayable pages,
retaining parent subtree accumulators until exact coverage is recorded; commit then writes the immutable structure
revision and CAS-advances only the current source draft head. Empty complete sources stay on the first-point-write
path; cancelled, erased, expired or stale sources keep the previous head, old exact revisions, cursors and the public
pointer. Unavailable titles stay null. No HTTP route and no publication pointer change.

Decision: `POST /v1/hostedCatalogues/:id:convertDraft` is a private author step command for source capture, builder
begin/page/seal, and activation begin/page/commit. A page step replays native input advancement and applies at most
20 retained entries; callers echo only the returned native frontier as a replay precondition, while source records,
page payloads, coverage proof, seal readiness and activation stay producer-owned. Every step remains bound to the
captured input and original expected draft revision.

Retain the 512-row snapshot writer and explicit-selection publisher as compatibility operations. A replacement
may intentionally shrink a larger draft; the client must identify it as whole replacement, never a saved page. Existing exact snapshots, descriptors, publications, receipts, checkpoints and cursors retain
their addresses and current Access behavior. Never rewrite old versions into the current forest or infer that an
unused current base is reclaimable. Knowledge needs no wholesale migration: adapt existing sibling roots, add the
historical point/summary access paths with a pinned resumable baseline, and retain `history_complete` behavior;
do not fabricate unavailable pre-baseline history. For the first point publication over a legacy public manifest,
build a separate pinned public baseline from that manifest, never from the private draft. Hold it privately until
the point commit CASes the original publication; racing publication invalidates it. Old public IDs stay readable.

Decision: the public-baseline source binds the active publication ID, route/home and actor context, then pages only
that retained manifest by raw ordinal; it reports pointer staleness without following the draft, preserves neutral
unavailable slots, and relies on immutable publication retention while the ordered-generation builder owns its
frontier, candidate state and CAS of the original publication ID.

Decision: the public-baseline producer binds the publication, thread and actor-scope hash to a separate resumable
source identity, reuses the existing builder point, sibling-root, page and sequence stores with the source-neutral
sequence application, and seals complete coverage without changing catalogue pointers.

Decision: public-baseline receiving copies the sealed source into one private candidate through resumable temporal
pages, shares activation's occurrence/node/root writer, verifies counts and roots without a final source scan, and
returns only after rechecking the original publication; unavailable values remain null.

Decision: a private author progression endpoint advances one bounded build or receiving page, or one lifecycle
transition per request against its retained publication and actor-bound frontier; only an internally completed and
verified receiver candidate may enter the point-publication transaction.

## Book publication contract

Choose one exact public snapshot model with two launch paths: **point publish** for serial work, and
**prepare → seal → activate** for complete input. A public version contains independent selected membership/value
and sibling roots, point lookup and chapter summaries; it may share immutable index paths, never select the private
draft root. Each selected value pins occurrence, kind, parent, title and exact target revision/digest. The catalogue
holds one atomic publication pointer. No full manifest copy or unbounded delta chain is a publication version.
Old release IDs, occurrence links, cursors and checkpoints keep their exact selections under current native access.
Both paths use the shared structural primitive; neither changes Knowledge's individual-document publication.

### Point publication for serial Books

Define owner operations `publishChapter` and `replacePublishedChapter` (contract names, not installed routes).
Each carries expected draft/publication IDs, exact source occurrence/target selection and an idempotency key.
`publishChapter` adds one chapter at a stable public `parentId`/`beforeOccurrenceId` (null means end). Resolve these
against the expected public snapshot, not the draft; an anchor present only in the draft is invalid.
Any not-yet-public ancestor must be explicitly reviewed/selected in the same depth-bounded operand; never silently
publish private ancestor titles. `replacePublishedChapter` changes exactly one already-selected occurrence's chosen
body revision/digest, retaining its public parent, order and other values unless explicitly selected in that bounded
operand. Kind/target Post identity stays permanent. It does not copy newer draft choices into other public chapters.

Under current catalogue Post author/container/`post:revise` admission, read that exact source occurrence and its
ancestor chain, then validate only the changed exact targets through native metadata and retained original Access/
ancestry observations. Native public eligibility of the catalogue Post is a separate precondition for reporting a
newly public Book. Changed targets use [exact source consent](#private-to-public-boundary) or the installed public
eligibility seam; do not require global Post publication of a private opening. Recheck these observations at commit
with existing deadlines/finalization; zero body reads. Do not revalidate every unchanged public target: their
membership is already selected and their disclosure is always current. Authorized receipt replay precedes
publication CAS. A stale fresh command fails without index or pointer changes.

Decision: point publication prepares retained anonymous metadata checks for the catalogue opening and only newly
selected exact targets. Its Content writer now binds the exact native candidate snapshot, point delta, immutable
descriptor and publication CAS in one transaction. The native command first rechecks current post-revision admission
and preflights the exact receipt, then prepares stale-dependent occurrence reads and changed-target checks. An
authorized replay therefore returns before a later head can stale its original request; a fresh stale request writes
no index rows or pointer.

Decision: each point operand pins the exact draft occurrence and target against both expected heads, explicitly selects draft-only ancestors, and resolves stable anchors only in the expected public snapshot; point admission uses Content's existing exact revision-disclosure observation for private openings beside retained public eligibility, then rechecks source currentness and consent in finalization. Native HTTP handlers join these retained checks to the ordered-version transaction; Book reads prove the selected published occurrence internally before using the exact source-consent gate.

Decision: ordered point publications resolve their exact candidate descriptor and snapshot; legacy publications use
only a prepared candidate baseline whose captured source publication ID equals the expected public selection. The
Content writer stages the point delta and commits native index rows, the immutable revision descriptor and
publication pointer CAS in the same transaction. Until the active owner exports a sealed exact legacy baseline
binding, native point commands reject compatibility publication descriptors with a stale-publication precondition;
the compatibility publisher remains unchanged.

Copy only the affected sibling, preorder and chapter index paths and at most H explicitly selected ancestors; create
one small version root/count summary and atomically CAS the publication pointer with receipt/identity-only event.
Normal append or single revision replacement is O(H log N) logical index changes, independent of total
public/private chapters; physical SQL/I/O is counted separately. Other draft and public selections remain unchanged.
Withdrawing the complete TOC changes its pointer/discovery state in bounded work; cleanup paginates held storage.
A point operation never needs a complete manifest write or validation pass.

### Private-to-public boundary

[`validateHostedChapterAttachments`](hosted-chapters-attachments.ts) proves attachment identity/read admission,
not public Post eligibility. [`resolveHostedOccurrenceMetadata`](hosted-chapters-reads.ts) and exact body opening
separately run current target disclosure. Selecting a manifest neither globally publishes a Post nor changes its
grants. Ordinary direct Post, other Books and unselected revisions stay on their current Access path.

Decision: Content-owned **exact Book-scoped source consent** may make only one selected revision of a private
opening, including that opening's draft Thread wrapper, readable under proved published membership. Consent binds catalogue, thread, post, revision and digest, issued under
source `post:revise` and container admission. Book proves activated or retained publication membership, then Content
verifies the scoped consent and current native ancestry, Board, Realm, takedown, erasure and incarnation gates.
Reuse Content and Access mechanisms; do not add a parallel permission engine or a client-supplied bearer grant.
Already-public targets keep the installed Access [public eligibility](../access/public-eligibility.ts) seam as the
baseline and need no consent row. A private/unpublished catalogue still leaves A selected and returns a private
author-visible refusal; publish that catalogue Post explicitly before retry. A private opening without consent
refuses the same way; after consent, the selected revision is Book-readable while the direct Post/Thread URL,
other Books and unselected revisions remain unchanged. Use a new key after deliberate re-review.
Keep the installed compatibility publisher's existing reference-selection behavior unchanged: an inaccessible
selected target remains neutral unavailable to that reader, with no private title, target metadata or body.

Later target draft edits do not change selected bytes. A newly published target revision does not substitute for the
Book's selected revision. Revocation, takedown or erasure after a successful Book pointer change can make even an
old exact Book link unavailable; Book never overrides current target access. Author-readable, publicly eligible and
Book-scoped-consent-readable are separate native observations. Do not infer reader bytes from an author metadata
read, cache a permission callback, or implement consent by loading the body. Public/anonymous projections never
receive private progress or selection details. Embedded private media stays with Media.

Decision: source-side exact consent is the native `revision-disclosure` primitive mounted at the source Post.
`POST /v1/posts/{id}:issueRevisionDisclosure` and `POST /v1/posts/{id}:revokeRevisionDisclosure` bind the
authenticated actor, exact source tuple, intended Book, idempotency key and deadline. Catalogue ownership and a
path UUID alone do not admit. Issue and revoke reuse the installed source commands and typed receipts; they use
source `post:revise` plus container admission. Attachment metadata is observed after admission and never authorizes
issuance. Private draft openings are the first scoped case. Already-public targets keep Access public eligibility
with no consent row. Consent observation does not grant read. Reader membership remains a Book-owned typed seam with
no writable caller proof. Distinct migration `20261113091251_revision_disclosure.sql`. Staged activation-currentness
is unchanged.

| Operation ID                      | Method and path                                | Input                                         |
| --------------------------------- | ---------------------------------------------- | --------------------------------------------- |
| `post.issue_revision_disclosure`  | `POST /v1/posts/{id}:issueRevisionDisclosure`  | `catalogueId`, exact `target`                 |
| `post.revoke_revision_disclosure` | `POST /v1/posts/{id}:revokeRevisionDisclosure` | `disclosureId`, `catalogueId`, exact `target` |

Both commands require an Idempotency-Key, return the original receipt (`disclosureId`, `state`, `catalogueId`,
`reused`, optional `durableInitiator`) with `Cache-Control: private, no-store`, and replay that receipt. The path
Post must equal `target.postId`. Native source, container, erasure, public-source and mismatch errors stay as they
are. Direct Post visibility, other Books and unselected revisions stay unchanged.

## Prepared Book publication

Decision: the mounted author API uses expected draft/publication IDs only as stale-intent preconditions, gives each source-pinned stage a 24-hour lifetime from native command time, and returns only retained progress and candidate counts; preparation never selects the publication pointer.

Decision: materialize a sealed exact stage into one private candidate generation using the shared hosted version store and sequence builder; consume at most 20 source-ordered rows per replayable step, densify sparse selected ranks, rederive selected sibling positions, and require the pinned source fence at coverage seal.

Decision: private staging uses a source-ordered candidate generation, 20-row replayable steps and selection batches of
at most 512; exact target observations stay separate from current authority proof, source titles remain source-owned
for terminal redaction, and this slice exposes no activation.

Ordered staging pins the current immutable revision, generation and sequence, pages whole sources through bounded
preorder reads, and resolves selected points and candidate titles from that same snapshot; legacy snapshot and prefix
sources retain their existing readers.

Decision: cleanup enters only cancelled, expired or failed unsealed stages under the exact owner epoch and stage lock;
it uses one 100-row budget across indexed candidate, input and target keysets while retaining terminal progress,
existing staging receipts and all source/lifecycle records.

Staging is Book-owned, independent of Collection custody. Collection's
[seal reader](../library/collection-publication-staging.ts) and
[fixture](../../test/library/collection-publication-staging.test.ts) exemplify native source identity, complete
frontiers, member/evidence fences and keeping complete A selected while B is interrupted. Reuse those invariants,
not its tables, Search evaluator, query population or proof types.

Capture initiator, catalogue/epoch, exact immutable draft descriptor, expected draft/publication IDs, mode and expiry
under current native admission. `whole` selects every placement of that pinned draft. `selection` imports explicit
IDs in bounded batches into an indexed selection set; settle duplicate/unknown IDs and require explicit ancestor
closure before seal. Neither mode has a total 512 ceiling. The current `:publish` remains a <=512 compatibility
request; larger input uses retained batches, never one giant request or growing JSON array. A fresh later draft
is not substituted. Empty explicit selection is deliberate atomic withdrawal, never incomplete preparation.

Persist a small control row, indexed input/output, selected snapshot roots and a durable raw traversal frontier.
Use existing Book page 20 plus lookahead for one processing step (512 is at most an ingestion batch). Each step
bounds metadata checks, memory and writes, including O(H log N) path changes per admitted row; it commits output,
commitment/counts and frontier atomically. Whole traverses pinned source to raw exhaustion, not visible exhaustion.
Selection probes exact requested IDs and ancestors through indexes; it must not scan all N for every batch or
repeatedly sort/renumber the growing prefix. Derive each input's preorder rank from the pinned source summaries
and index staging by that immutable source rank; process it once to build selected sequences. Dense public ordinals
remain read projections. Freeze the imported input version before coverage/closure sealing; later additions require
a new version and invalidate the seal. Duplicate target Posts under distinct occurrences remain distinct membership.

Preparation validates each distinct selected target's exact thread/Post/revision/stored digest/author/licence under
native attachment admission, with zero bodies. Persist immutable source observations, not serialized authorization
callbacks. Seal proves every requested ID settled, complete coverage, uniqueness, explicit closure, order, immutable
output root/count commitment and lifecycle holds from native state. Accumulate these proofs per step; no final
O(N) synchronous reread. Seal binds source/epoch, selection/input version, output roots and expiry. Partial/sparse/
unavailable input and caller-supplied `complete` booleans never produce a seal. Total build may cost O(N log N),
with O(N) temporary rows and bounded memory per step; retries resume their frontier without revisiting the prefix.

Activation re-admits the current initiator/container/`post:revise` authority **before receipt replay** and consumes a
native seal by locator. After replay, CAS the pinned draft and expected publication, enforce lifecycle/expiry and
native current-target authority proof, and atomically select the completed output root with receipt/event. Complete
A stays selected through partial B, failed seal/activation, crash, cancel, expiry or stale CAS. Lost successful
activation replays B exactly after later changes only for a currently admitted author. No partial output is public;
private progress, targets and commitments stay author-only and follow Book erasure/hold policy.

**Activation-currentness gate:** the installed per-invocation attachment checks are not a durable aggregate authority
proof for an arbitrarily large release. Rechecking all N targets in one final transaction is forbidden; permission
checks made in earlier batches are insufficient. Before enabling staged activation, Content/Access must deliver a
native retained validity proof binding every newly selected target/source observation to current eligibility and
invalidation, whose final validation is bounded independently of N. It must cover cross-home revocation between the
last step and activation, not only draft CAS, a TTL or a caller epoch. A source fence that can change without
invalidating that proof fails the contract. No such capability is claimed installed by this decision. Build the
control/step/seal path now; keep activation disabled until that proof and its revoked-after-last-step test exist.
Current reader disclosure remains mandatory even after a valid activation; no distributed permission transaction is
invented here. Point publication can launch independently because its changed-target set is depth-bounded.

Whole-build preparation uses a bounded committed frontier, coverage and seal, then one atomic publication pointer;
it copies no full manifest and follows no unbounded delta chain. Point publish and whole build share the immutable
root format, exact-target/consent contract, reader/cursor, CAS, receipt and native authority; they do not share a
job lifecycle. A successful serial chapter during preparation makes the original expected publication stale (412);
replacing it requires a new activation intent and key.

Durable Book-scoped consent and a later withheld reader slot are **not** that activation proof. Consent may keep an
already issued exact-revision intent after the issuer later loses ordinary edit role, while explicit revoke, erasure
and container-read loss still deny bytes immediately. Source consent commits in the source home; the Book pointer
commits in the catalogue home. A revocation that races the last source check can leave a committed unavailable slot,
and the reader must refuse bytes. That lazy withheld view is current reader denial. It does not prove that every
newly selected target remained eligible at activation, independently of N. Keep the strict activation-currentness
requirement until native proof supports an explicit adopted replacement. Keep cross-home activation and immediate
reader denial as separate obligations.

### Release-candidate disposition and implementation handoff

The specification is decided; **Book release-candidate readiness remains blocked** by missing generation/as-of
sequence implementation, point public-snapshot publication with exact source consent, and large-batch
activation-currentness. Root append, a design document, or raising a request cap closes none of these gates. The
initial persistence adapter is the row-per-node PostgreSQL temporal port in the shared outline contract; a fixed-page
alternative needs native evidence and does not reopen predecessor-versus-radix comparison. Deliver these source slices:

1. **First source slice — exact point public snapshots:** in `hosted-chapters-{model,store,commands,reads}.ts` and a
   new owner `hosted-publication-point.ts`, bind the snapshot/sequence storage port; implement changed-target
   admission, Book-scoped exact source consent, selected-ancestor closure, receipt/CAS orchestration and exact reader
   dispatch. Keep Access public eligibility as the already-public target baseline. `versioned-outline-order.ts` holds
   keyed copy-on-write balancing only; add rank/select, split/join, as-of lookup, three indexes and membership proof
   beside it, preserving the Knowledge adapter. Freeze `hosted-publication-point.test.ts`: unpublished catalogue
   refuses; public target uses eligibility without consent; private opening needs Book-scoped consent then succeeds
   while the direct Post and unselected revisions stay private; one selected revision replacement; unchanged
   siblings; old links and replay. A fake port is not launch evidence. Coordinate consent and eligibility with
   Content/Access rather than reproducing policy.
2. **Scalable adapter and migration:** implement the row-per-node temporal adapter behind the sequence port, owner
   storage/index migrations, historical point/reverse/rank/chapter summaries and resumable snapshot/sealed-prefix
   conversion. Count logical probes and physical SQL/I/O separately. Extend
   [`knowledge-history.test.ts`](../../test/content/knowledge-history.test.ts) and
   `versioned-outline-order.test.ts`; retain existing cursor/title/body/publication assertions. No per-edit rebuild,
   eager migration, global key relabel or history-chain replay.
3. **Complete Book publication:** add `hosted-publication-staging.ts` and `hosted-publication-staging.test.ts` for
   pinned whole/selection, durable input/frontiers, seal and atomic activation/withdrawal. Preparation can start with
   snapshot/prefix sources now; final activation depends on the native validity-proof gate above. Keep installed
   release-selection/admission/append-release assertions; their 512 bounds describe those compatibility requests.
4. **Declared native API and mounted consumers:** mount owner point/batch commands, generate the client, then add
   Studio source/destination/selection review and progress. One confirmation issues one bounded command with stable
   IDs and one expected version; conflict retains choices but requires fresh review. Keep Knowledge's current versus
   historical distinction and [Book exact-reader](../../../../apps/web/src/books/reader/README.md) compatibility.
   No full-outline drain, private preparation projection or production exposure change belongs in these slices.

Freeze these missing acceptance cases with those implementations; no executable product assertions change in this
specification-only patch. They are release gates, not claims that future tests passed:

| Case                          | Required native/API and mounted evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `outline.anchor-history`      | Insert/reorder/reparent by observed ID, no-effect, wrong/deleted/self/foreign anchors, cycle/depth boundary, opposite moves, stale 412 and exact authorized replay. Historical point/children/preorder/previous-next retain old order/targets after edits and removal; current Knowledge cursor still returns 409 and titles remain current.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `outline.scale`               | At >512 and 1k/10k/100k placements exercise the row-per-node temporal adapter. Repeat hot-gap edits beyond numeric-window exhaustion and move a large unchanged subtree; count logical probes separately from SQL/I/O, descendant rows (zero), reads/WAL/retained bytes. Denied/private siblings neither become visible nor trigger whole-list refill. Grow width/history/subtree independently; record values against the derived bounds. A fixed-page alternative needs the same native evidence.                                                                                                                                                                                                                                                                |
| `book.serial-point`           | On thousands of chapters append one public chapter and replace exactly one selected revision without manifest rewrite, full revalidation or other draft/public changes. Unpublished catalogue refuses before pointer advance. An already-public target uses Access public eligibility with no consent row. A private opening becomes Book-readable only after exact Book-scoped consent of one selected revision under proved published membership; the direct Post, other Books and unselected revisions stay private. Revoke between observation and commit, and after success: fail or neutral unavailable under native rules, never draft/title/body leakage or newer-byte substitution. Preserve exact old cursor/link/checkpoint, stale and replay outcomes. |
| `book.complete-batch`         | Whole and explicit ancestor-closed selection exceed 512 at 1k/10k/100k; complete publish and withdrawal, not just initial pages. Interrupt before/after committed steps and activation response; A persists until complete B. Duplicate/unknown/missing ancestor, source/publication race, expiry, forged/partial seal and authority revoked after last step fail safely. Bound each step and final activation; verify zero bodies and no rescanned prefix.                                                                                                                                                                                                                                                                                                        |
| `outline.migration-retention` | Legacy and sealed-prefix pinned baselines equal independent traversal; later appends are excluded and stale activation fails. Resume crash/expiry/erasure. Old releases, receipts/cursors/checkpoints and shared prefixes survive held-root cleanup; abandoned roots reclaim in bounded steps. Withdrawal is bounded; total cleanup is measured separately.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `outline.mounted-review`      | Native HTTP repeats admission on page/confirmation/replay; Studio and Knowledge preserve choices after 412/409 and require review. Point publication distinguishes unpublished-catalogue refusal, missing-consent refusal and Book-scoped selected-revision success; batch progress displays A until B activates. Anonymous/other-account responses expose no private siblings/progress. Session changes retire stale results.                                                                                                                                                                                                                                                                                                                                     |

Run native cases with explicit files through the owning Kernel `check` runner and mounted cases through the owning
Web runner after implementation. Add stories only for review, preparing-with-old-release, conflict and unavailable
states backed by native DTOs. Keep existing
[`hosted-root-append`](../../test/content/hosted-root-append.test.ts),
[`hosted-append-read`](../../test/content/hosted-append-read.test.ts),
[`hosted-append-lifecycle`](../../test/content/hosted-append-lifecycle.test.ts),
[`hosted-release-selection`](../../test/content/hosted-release-selection.test.ts),
[`hosted-release-selection-admission`](../../test/content/hosted-release-selection-admission.test.ts) and
[`hosted-append-release`](../../test/content/hosted-append-release.test.ts) assertions. Growth/currentness/mounted proof
is required before release and remains unverified here; ordinary acceptance runs after landing in the dev verifier.

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

Decision: private migration input pins the admitted current structure revision and its immutable append descriptor/high-water, advances a durable ordinal/offset frontier in bounded pages, stores no source payload in receipts, reconstructs committed intervals under fresh admission, and holds the source for 30 days until consumption, expiry or cancellation; source erasure releases the hold, while unavailable/redacted slots advance raw coverage without title or target metadata disclosure.

Decision: hosted version building applies at most 20 contiguous source-order entries per page, replays by the exact starting source frontier, and writes only isolated candidate facts and sibling/preorder/chapter indexes; unavailable titles and targets remain null, and sealing requires current complete coverage without changing live catalogue pointers.

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

Decision: versioned Book pages use the selected sibling, preorder or chapter read set, prove every retained anchor in that root, and traverse one bounded in-order window; bigint ranks become numeric positions only at the existing wire projection, while route selection and disclosure remain with the hosted reader.

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

Compatibility complete replacement/release validate at most 512 placements; mounted root append validates one.
Distinct exact targets use initial/final retained native metadata, zero bodies. Replacement writes one bounded
snapshot and placement/identity inserts under the catalogue home transaction; append writes one occurrence, one
append row and one descriptor, lazily installing its empty sealed-base descriptor. Publication reads only selected
source rows and processes their attachments. Legacy reads use exact catalogue/revision probes, at most one
parent/origin probe and one indexed page query of at most 21 rows; mixed-prefix bounds are defined above.
Subject discovery examines at most 21 indexed `subject_thread`/same-route catalogue-Post candidates and discloses
at most 20, with initial/final target disclosure and catalogue disclosure repeated at completion.

Subject cursors bind the Subject epoch; each catalogue uses its own routed home epoch across initial observation,
exact release selection and final authority. Changed catalogues are suppressed while raw progress continues;
unrelated Subject/catalogue epochs do not conceal an admitted Book. Contents, previous/next and metadata-only
occurrence reads share retained native metadata disclosure using full thread/Post/revision/digest and unchanged
author/licence; initial/final checks load zero chapter bodies. Denied slots advance the raw frontier without titles
or targets. Exact opening alone loads one body through ordinary Post disclosure, verifies its canonical digest/size,
then closes the original observation: a fresh read cannot bless a changed source. Attachment validation owns write
admission; metadata disclosure does not certify canonical bytes.

Decision: attachment-denial coverage checks each thread, revision and digest mismatch for `not_found` and zero body
loads. Cross-route native rejection has no read-chain probe; admitted attachment writes retain the metadata-only
probe requirement. Mounted append coverage reuses the suite-owned Auth/DBOS fixture and creates a fresh catalogue
within it.

Decision: hosted chapter identity coverage binds occurrences to each catalogue route and uses route-correct
nonmatching target IDs so native admission returns `not_found`; malformed-route coverage retains its 400 contract.

Pages retain metadata/authority handles; exact resolution serializes one canonical body. Charge native Access,
Accounts, Board, Realm, partition, transaction, serialization and bytes. Native HTTP now mounts ordered point publish
commands and composes consent-aware Book occurrence reads; consent issue/revoke routes, schema dump/client
publication and measured growth stay with their existing owners. The focused HTTP journey is the mount witness;
broader acceptance and release-readiness claims remain with their owners.
