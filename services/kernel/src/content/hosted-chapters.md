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
| `hosted_catalogue.move_draft_point`                 | `POST /v1/hostedCatalogues/{id}:moveDraftPoint`                                         | `expectedRevisionId`, `occurrenceId`, nullable `parentId`/`beforeOccurrenceId`                       |
| `hosted_catalogue.bind_chapter_language`            | `POST /v1/hostedCatalogues/{id}/occurrences/{occurrenceId}:bindLanguage`                 | expected draft head, canonical language, selected title/exact target or clear, optional declared default |
| `hosted_catalogue.occurrence_languages`             | `GET /v1/hostedCatalogues/{id}/occurrences/{occurrenceId}/languages`                     | exact revision/kind and bounded opaque page continuation                                            |
| `hosted_catalogue.occurrence_body`                  | `GET /v1/hostedCatalogues/{id}/occurrences/{occurrenceId}/body`                          | exact revision/kind; new language/preferred keys or pinned language plus complete Post/revision/SHA tuple |
| `hosted_catalogue.publish`                          | `POST /v1/hostedCatalogues/{id}:publish`                                                | `expectedRevisionId`, nullable `expectedPublicationId`, `occurrenceIds`                              |
| `hosted_catalogue.prepare_release`                  | `POST /v1/hostedCatalogues/{id}:prepareRelease`                                         | caller-generated `stageId`, `expectedRevisionId`, nullable `expectedPublicationId`, `mode`           |
| `hosted_catalogue.prepare_release_append_batch`     | `POST /v1/hostedCatalogues/{id}/publicationPreparations/{stageId}:appendSelectionBatch` | `batchId`, `occurrenceIds` (1–1,024)                                                                 |
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
limited to 1,024 IDs with no aggregate cap. Preparation responses are private and no-store, expose only retained
progress and candidate counts, and never select the publication pointer.

Decision: native Book acceptance advances retained preparation through bounded `:advance` requests with fresh
route-native step IDs until candidate coverage is complete before sealing; a finite fixture cap is only a liveness
guard and does not impose a production aggregate limit.

Decision: preparation route registration returns its chained Elysia type through chapter composition, so the
generated Kernel client exposes all seven mounted commands and Studio calls them directly with inferred operands.

Activation start, authority advance and activate are mounted beside the seven preparation commands and use the
ordinary generated client. They return 200 with exact native progress, a literal state and nullable publication ID.
Empty bodies, routed catalogue/stage IDs, current `post:revise` before receipt replay, the original deadline,
session anchors and `private, no-store` remain mandatory. Missing locators return 404, incompatible or stale review
returns 412, and author denial returns 403. Restart keeps the sealed private candidate and the previous release.
Native acceptance covers exact selection/readback, replay, stale-authority retention and boundary refusal through
ordinary Kernel composition; source and generated declarations do not replace that evidence.

Each placement supplies `occurrenceId`, nullable `parentId`, zero-based sibling `position`, `title` and `kind`.
Parts have no target. Chapters supply a target containing `threadId`, `postId`, `revisionId` and lowercase SHA-256
hex. The occurrence and parent IDs carry the catalogue's route; target identities carry the target Post's route.
A complete replacement has at most 512 occurrences, depth 16 and 256 Unicode characters per title. Empty structures, empty
parts, duplicate Post selections under distinct occurrences and root-only chapter lists are valid. Chapters cannot
parent children. Duplicate IDs, cycles, missing parents and noncontiguous sibling positions are invalid requests.

Revise replaces the complete tree and retains immutable history. Occurrence identity permanently fixes the kind
and canonical default target Post, even after removal; moves, titles, sibling order and exact revision selections may change. Target
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
and missing ancestors, then assigns dense sibling positions and preorder; the direct publish selection cap remains 512.

Decision: hosted structure create/revise/root append/direct publish, point insertion and chapter-target update first
run `preflightCommandReceipt` with the original kind, key, digest, principal, partition and deadline under
`hostedPostAuthorization`. Current Post authorship/container visibility/participation, authority-anchor and
authoritative-time `post:revise` admission still precede receipt lookup. An authorized exact hit returns the stored
response and command position without reading a mutable release selection or probing attached sources. A miss runs
the full preparation: direct publish reads its expected immutable structure/selected rows, and each changed exact
target is checked with native metadata and its retained original observation outside the write transaction. The
ordinary command then repeats authorization and receipt lookup, consumes the single-use proof, rechecks/finalizes the
container, and applies head/publication CAS atomically with immutable rows, receipt and event. Fresh selection and
attachment failures still write nothing; stale CAS follows preparation. Digest conflicts and minimized results keep
their native command behavior. Empty withdrawal, responses, events and the existing 512-placement direct-request
limits stay unchanged; prepared selection batches use the 1,024-ID cap below.

Decision: chapter-target updates and single-chapter publication mint their write Access evidence only after exact
selection and foreign attachment admission finish. Receipt preflight remains before those reads; transaction
authorization and final source eligibility remain current under the original request deadline.

Decision: bulk and point catalogue mutations complete exact chapter attachment admission before minting final
attempt-bound Post authorization evidence. Keep the absolute request deadline, Access evidence TTL, receipt replay
order, and transactional authority/container checks unchanged.

## Chapter body languages

Chapter body-language choice is part of the first-public Book reader. Content owns an explicit draft language
association for a stable chapter occurrence and the immutable publication selection of its alternatives. Each
canonical language key selects an existing exact thread/Post/revision/SHA target and its authored chapter title.
The existing canonical default target Post and occurrence kind remain permanent. Language associations do not
retarget that default, infer translations, create another document model or copy body bytes into hosted storage.
Ordinary Post editing, revisions, authorship, licence and source consent retain their existing owners.

A binding change uses the expected draft head and the existing chapter-target attachment/authority machinery.
Publication atomically freezes the selected language bindings, default and TOC under one release. Each selected
alternative passes its own exact source eligibility; selecting a language grants no additional draft or direct
Post visibility. Later private body edits or association changes cannot replace a frozen target. Every public
language list and body resolution rechecks current catalogue and exact target disclosure. Inaccessible alternatives
supply no private language label, count or target metadata.

Language preference is separate from an exact body address. While creating a chapter destination, try the explicit
language, then the caller's preferred exact language keys in order, then the declared default, using only actual
readable alternatives in the selected release. Report the actual selected language and title. Do not infer a
translation from tag prefixes, UI locale, similar text or neighboring chapters. Once an address pins the exact
Post/revision/digest, a preference never substitutes different bytes. Changing language explicitly creates a new
exact selection. An unavailable pinned target remains unavailable; fallback applies only when creating a new
selection. Existing single-language destinations retain the default body.

Publication retains language, selected title and exact target in its own immutable namespace, fully prepared under
the existing bounded staging/target-proof process before activation. Activation selects only a complete namespace
in the same transaction as the publication pointer CAS. Before that commit it remains a private candidate, including
sealed or aborted preparations; preparation is never evidence of publication. Exact namespace reads require the
committed publication descriptor, not a guessed namespace ID or a complete stage. After activation its rows remain
addressable by that exact publication, including older releases after withdrawal, and survive ordinary staging
cleanup. Cleanup follows that retained publication identity rather than only the current publication pointer. Reused point-publication chapters may retain their existing immutable public namespace rather than copying
or consulting a private temporal source. There is no post-activation copying or finalization window.

Public language/title/body selection reads the retained publication namespace, not a temporal private binding at
an old version frontier. Private language facts therefore redact independently through the existing terminal
native-authority and receipt path. Distinguish one-way title redaction from an author's cleared binding; preserve
identity and exact-binding facts required by the existing retention contract without returning a redacted private
label. Unactivated namespace payload remains candidate-owned and is cleaned or disposed under the same native
terminal authority; it never inherits published retention merely from being prepared. Do not scan all historical
public manifests for each private fact or introduce a second authorization/witness protocol.

Store and read associations by publication/draft identity, occurrence and canonical language key. One exact choice
uses keyed access; language enumeration uses the existing hosted page budget and sparse continuation, without eager
body fetches or whole-book scans. Point association changes and prepared publication reuse existing request,
selection-ingestion and target-proof step bounds; additional alternatives count as real target work rather than
multiplying an unchecked nested array. Direct request caps are not lifetime language or complete-release ceilings.
Large sets make resumable progress under the existing publication preparation instead of a new arbitrary limit.

Web preserves language preference through outline and previous/next destinations and browser navigation, independently
of interface locale. The native exact body remains authoritative for a saved/resumed hosted-reading checkpoint;
positions from one alternative cannot be reinterpreted as positions in another. The
[reader owner](../../../../apps/web/src/books/reader/README.md#chapter-body-languages) owns the control and address
lifetime; native and mounted acceptance remain separate release obligations.

## Canonical draft initialization

Public create and full revise initialize the ordered draft directly, including nonempty nested placements. The
bounded input is the ordinary authoring request; point editing and chapter-language binding work immediately on
its returned head. Root append uses the same ordered owner. Larger input uses bounded native preparation rather
than a technical draft conversion surface. The mutable draft manifest writer, fallback reader and conversion API
are retired after their callers move; existing development data is handled by one-time maintenance rather than
a permanent second runtime. Immutable publication selections retain their exact snapshot and current-disclosure
semantics. Occurrence kind and canonical default Post identities stay permanent across full replacement.

Bounded direct publication initializes an immutable ordered candidate selection in that same engine. It retains
the public TOC, exact body revisions and native read authority as its own domain; it does not publish a mutable
draft. Single-chapter publication can extend that selection immediately, without a technical public-baseline
conversion control. Larger complete releases keep the ordinary bounded preparation and atomic activation path.

## Ordered selection model

Book uses the [shared versioned ordered forest](../../../../docs/knowledge-workspaces.md#shared-versioned-outline-primitive)
with its own placement values, permanent occurrence identities, Post authority and immutable publication selections.
Knowledge's notebook/document schema and sharing scope do not become Book storage or permission sources. Parts
may parent children; chapters cannot. A title, placement or exact body-revision change keeps its logical occurrence.

The native descriptor binds `(route, catalogue, revision)` to one generation, kind and as-of sequence. Structure
revisions select draft generations; publication revisions select immutable candidate snapshots. Point lookup,
children, outline, rank/select and chapter navigation all read that same descriptor. Sibling, preorder and chapter
indexes carry bounded subtree/chapter/depth summaries. Historical selections use their exact version, never the
current head, an accumulated delta chain or a scan of later revisions.

Public create, full revise and direct publication ingest at most the existing request bound into these native
occurrence and index stores. Initialization computes summaries and balanced indexes in work proportional to the
explicit input. Point insert/remove/move, root append, title/body updates and chapter-language bindings then
change only their keyed occurrence and affected index/ancestor paths. They do not relabel all siblings, copy a
book or impose a total structure ceiling. Each command retains ordinary owner authority, receipt replay,
expected-head CAS, independent source attachment admission and exact events.

Complete publication preparation consumes its retained selection in bounded steps before one atomic activation.
Language alternatives count as real ingestion/target work. Snapshot reads expand only requested index ranges;
physical node batches remain bounded at 512 and foreground pages at the hosted page budget plus lookahead.
Metadata pages never hydrate chapter bodies. Logical index work and physical SQL, Access, bytes and cleanup work
are counted independently under the [Cost contract](#cost-and-integration-boundaries).

### Development maintenance

Existing development snapshots and append streams are inputs to one-time maintenance. Use the retained bounded
input, ordered builder and materialization primitives to install canonical descriptors while preserving occurrence
identities, exact body selections, immutable publication IDs, receipts and current source authority. This is not a
product route, Studio control, automatic read fallback or a second mutable draft model. New public create, revise,
append and publication commands use the canonical initialization and point paths above.

## Book publication contract

Choose one exact public snapshot model with two launch paths: **point publish** for serial work, and
**prepare → seal → activate** for complete input. A public version contains independent selected membership/value
and sibling roots, point lookup and chapter summaries; it may share immutable index paths, never select the private
draft root. Each selected value pins occurrence, kind, parent, title and exact target revision/digest. The catalogue
holds one atomic publication pointer. No full manifest copy or unbounded delta chain is a publication version.
Old release IDs, occurrence links, cursors and checkpoints keep their exact selections under current native access.
Both paths use the shared structural primitive; neither changes Knowledge's individual-document publication.

Decision: publication preparation imports its advance phase from the staging source; publication and release-candidate
sequence adapters forward `readNodes` to the selected immutable snapshot workspace. Staging remains at 20 placements
per step, and sequence reads keep physical node batches capped at 512.

### Point publication for serial Books

The native `publishChapter` and `replacePublishedChapter` operations select exact public chapter values.
Each carries expected draft/publication IDs, exact source occurrence/target selection and an idempotency key.
`publishChapter` adds one chapter at a stable public `parentId`/`beforeOccurrenceId` (null means end). Resolve these
against the expected public snapshot, not the draft; an anchor present only in the draft is invalid.
Any not-yet-public ancestor must be explicitly reviewed/selected in the same depth-bounded operand; never silently
publish private ancestor titles. `replacePublishedChapter` changes exactly one already-selected occurrence's chosen
body revision/digest, retaining its public parent, order and other values unless explicitly selected in that bounded
operand. Kind/canonical default target Post identity stays permanent. It does not copy newer draft choices into other public chapters.

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

Point publication resolves the expected immutable candidate descriptor directly. It captures the fixed native
authority vector before observing the opening and changed targets, then locks only those sources' dependency homes
on the writer's connection. The Content writer stages its bounded index delta and commits the revision descriptor,
namespace selection and publication pointer under the ordinary native command and CAS.
Technical mutable-draft and public-baseline conversion APIs are retired.

Copy only the affected sibling, preorder and chapter index paths and at most H explicitly selected ancestors; create
one small version root/count summary and atomically CAS the publication pointer with receipt/identity-only event.
Normal append or single revision replacement is O(H log N) logical index changes, independent of total
public/private chapters; physical SQL/I/O is counted separately. Other draft and public selections remain unchanged.
Withdrawing the complete TOC changes its pointer/discovery state in bounded work; cleanup paginates held storage.
A point operation never needs a complete manifest write or validation pass.

### Private-to-public boundary

Every selected target also passes Content's current exact-revision disclosure policy at metadata and body reads; a
hard restriction defeats Book membership and source consent. This section continues to own Book-scoped consent only
for a genuinely private source. See [Content's Post revision access decision](README.md#native-post-history-selection).

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
Direct publication retains explicit reference-selection behavior: an inaccessible
selected target remains neutral unavailable to that reader, with no private title, target metadata or body.

Decision: Contents and navigation share retained ordinary metadata checks by exact source target; private selected
occurrences retain their own catalogue, publication and occurrence consent proof plus native source and Access
observations through final disclosure. Page reads remain metadata-only.

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

Decision: persist the existing Access client identity rule (1–1024 printable non-space ASCII bytes) with separate
`octet_length` bounds and a `"C"`-collated printable-character exclusion. Access principals and UUIDv7 command or
provenance transaction IDs are not Content-route resource IDs; only source-local resource IDs retain route equality.
PostgreSQL limits POSIX repetition bounds to 255 ([documentation](https://www.postgresql.org/docs/current/functions-matching.html#POSIX-MATCHING));
rollback refuses to restore the unusable `{1,1024}` expression or reject valid non-local principals and transactions.

## Prepared Book publication

Decision: the mounted author API uses expected draft/publication IDs only as stale-intent preconditions, gives each
source-pinned stage a 24-hour lifetime from native command time, and returns retained progress, candidate counts and
only the stage's immutable source revision, expected draft and expected publication IDs; preparation never selects
the publication pointer.

Decision: the native command gate serializes same-Pool work per partition, but separate service pools share only row
locks. Preparation start locks an existing stage before the current catalogue row, matching fresh source-step lock
order. A missing stage key still serializes first creation on the catalogue row; stale pointers and exact source, mode
and native-deadline mismatches keep their existing precondition outcomes.

Decision: preparation progress inspects the optional retained candidate by exact stage, source seal and owner epoch,
returning null before materialization and its existing checkpoint afterwards. It never seals, allocates or advances
a candidate. Later draft/publication movement does not reject this retained observation or relabel the stage;
fresh start, advance and seal retain stale-intent admission. Current author/owner admission precedes exact receipt
replay, which preserves the committed response. Existing expiry and terminal progress semantics remain in force.

Decision: a fresh progress read is a no-effect command when its locked stage observation makes no change. If that
observation persists the retained stage's expiry transition, the existing preparation-changed event records it once;
an exact authorized receipt replay keeps the original reply without emitting another event.

Decision: preparation Advance reads at most one exact source page of 20 rows and its frontier before the catalogue
write checkout, then observes each new exact target after releasing the read connection. The write transaction
revalidates current caller and stage owner, the pinned source, stage state/frontiers and exact page before storing
those observations. `hosted-publication-staging.ts` owns the shared page and target-observation path for mounted and
standalone callers; `hosted-publication-preparation.ts` joins it to command authorization and receipt replay.

Decision: selection append emits preparation-changed when it adds a retained batch or its locked progress read persists
expiry; an exact retained batch replay under a fresh authorized command receipt adds no input and emits no change event.

Decision: fresh activation start, authority advancement and candidate selection require the exact candidate's stage
to remain sealed and its `expires_at` to be strictly later than native command time. The indexed candidate/stage
point read compares timestamps in PostgreSQL inside the owning command transaction, preserving timestamp precision
and the existing locks and their order. Equality is expired, even while
the collector has not visited the stage. Fresh keys cannot bypass expiry through existing activation progress;
current author admission still precedes exact committed receipt replay, which returns before lifecycle admission
and never moves the publication pointer again. The current public edition remains selected and readable under its
ordinary disclosure rules; expired unpublished candidates remain private.

Decision: native activation commands return explicit command effects. A new pass, authority-page advance or stale
authority restart emits the existing activation-changed event; the first pointer commit emits publication-activated;
retained start, ready/activated advance and activated retries use `noEffect` and emit no event.

Decision: fresh whole-source building and selection building/closing advances replay their exact native step receipt
before checking expiry, then lock the exact catalogue row after the stage row and compare both pinned draft and
publication IDs before source traversal, candidate settlement or closure-frontier writes. A stale pointer returns the
existing 412 conflict without changing retained progress. Current author admission remains before outer receipt
replay, and exact acknowledged steps and retained progress remain available after pointer movement.

Decision: every fresh activation body takes the existing stage row fence before activation/candidate locks,
authority-home comparison and the final catalogue CAS, retaining it through final authorization, receipt and commit.
Build and reclaim already fence the stage before candidate work. A cancellation committed first prevents selection;
activation committed first keeps its exact receipt and selected edition after cancellation or expiry. Cancellation
does not unpublish; withdrawal remains a separate command. Exact authorized receipt replay precedes this fence.

Decision: mounted Cancel emits preparation-changed only when its locked transition persisted cancellation or expiry.
A terminal-stage retry with a fresh outer key is a no-effect command; an authorized exact receipt replay keeps its original response.

Decision: because the HTTP body accepts any syntactically valid `HostedId` for `stepId`, every fresh
hosted-preparation advance requires that ID to share the catalogue's native route before progress is read or candidate
materialization/page writes occur; otherwise the wrong-route ID can consume a page and cannot be corrected in place.
The pure route precondition runs only on a receipt miss after current authorization; exact committed receipts replay
unchanged. It reuses the staging conflict response and adds no storage query.

Decision: one immutable receipt keyed by catalogue, stage and routed `stepId` preserves the exact preparation response
across source pages, candidate creation/pages and exhausted acknowledgements; indexed legacy source receipts remain
intact and are consulted before phase dispatch.

Decision: new advance receipts also retain the bounded staging checkpoint in `result_checkpoint`. The column stays
nullable for immutable receipts written before this snapshot existed; retries of those rows return HTTP 503
(`dependency_unavailable`) without replacing the receipt or advancing work. The author reads current progress and
uses a new step ID to continue. Never reconstruct historical counters or frontiers from the live stage. Rollback
refuses after any checkpoint has been acknowledged.

Decision: materialize a sealed exact stage into one private candidate generation using the shared hosted version store and sequence builder; consume at most 20 source-ordered rows per replayable step, densify sparse selected ranks, rederive selected sibling positions, and require the pinned source fence at coverage seal.

Decision: advertise and enforce a 1,024-ID selection batch cap, based on an isolated interleaved 40-sample benchmark;
the cap doubles request capacity over 512 with a modest write and lock increase, while 2,048 and 4,096 materially
increase persistence and replay costs. Keep source-ordered candidate generation, 20-row replayable steps, exact target
observations separate from current authority proof, source-owned titles for terminal redaction, and activation of the
sealed generation without rebuilding it.

|   IDs | Compact JSON body bytes | Write P95 (ms) | Stage lock P95 (ms) | Exact replay P95 (ms) |
| ----: | ----------------------: | -------------: | ------------------: | --------------------: |
|   512 |                  20,036 |          11.84 |                0.79 |                  2.06 |
| 1,024 |                  40,004 |          14.03 |                0.87 |                  3.11 |
| 2,048 |                  79,940 |          29.22 |                1.04 |                  3.90 |
| 4,096 |                 159,812 |          42.01 |                1.22 |                  6.64 |

The measurements use route-valid generated IDs and a fresh empty selection stage. Request bytes count the compact
UTF-8 JSON body; write P95 covers the append transaction through commit, lock P95 covers its stage `FOR UPDATE`
query, and exact replay P95 covers the repeated transaction with the same batch ID and body. These measure bounded
input persistence; later source selection, closure and candidate building continue in separate 20-row steps.

Ordered staging pins the current immutable revision, generation and sequence, pages whole sources through bounded
preorder reads, and resolves selected points and candidate titles from that same snapshot; legacy snapshot and prefix
sources retain their existing readers.

Decision: cleanup enters only cancelled, expired or failed unsealed stages under the exact owner epoch and stage lock;
it uses one 100-row budget across indexed candidate, input and target keysets while retaining terminal progress,
existing staging receipts and all source/lifecycle records.

Decision: sealed whole and explicit-selection Book candidate reclamation follows the
[terminal source claim contract](hosted-append-lifecycle.md#cancelled-sealed-book-candidate-reclamation),
including cancelled sources reaching their normal expiry, exact-generation pins and retained receipts.

Decision: the existing hourly Content collection sweep scans one global expiry-index keyset of at most 100 stage keys and advances at most one existing 100-row cleanup step per pass; pinned or unsupported states advance with the exact source, owner epoch, candidate and reason retained for recovery, while each cleanup owner resumes its own persisted frontier.

Staging is Book-owned, independent of Collection custody. Collection's
[seal reader](../library/collection-publication-staging.ts) and
[fixture](../../test/library/collection-publication-staging.test.ts) exemplify native source identity, complete
frontiers, member/evidence fences and keeping complete A selected while B is interrupted. Reuse those invariants,
not its tables, Search evaluator, query population or proof types.

Capture initiator, catalogue/epoch, exact immutable draft descriptor, expected draft/publication IDs, mode and expiry
under current native admission. `whole` selects every placement of that pinned draft. `selection` imports explicit
IDs in bounded batches into an indexed selection set; settle duplicate/unknown IDs and require explicit ancestor
closure before seal. Neither mode has a total 512 ceiling. The direct `:publish` remains a <=512 bounded
request; larger input uses retained batches, never one giant request or growing JSON array. A fresh later draft
is not substituted. A new selection batch locks and compares both current pointers before inserting; an existing
exact batch receipt replays before that stale-pointer check. Empty explicit selection is deliberate atomic
withdrawal, never incomplete preparation.

Decision: a fresh selection Freeze locks its stage, then the current catalogue row, and compares both pinned draft
and publication IDs before persisting the frozen input version or phase. A stale pointer leaves collection progress
untouched; already frozen stages remain no-ops, and exact authorized command receipts replay before this check.

Decision: mounted Freeze emits preparation-changed only when a locked stage first persists its input frozen version.
A fresh-key retry of an already frozen stage returns its current progress without another event; exact authorized
receipt replay preserves the original response.

Decision: every mounted preparation command returns an explicit `changed` or `none` effect. Start uses native stage
replay evidence; Advance combines locked expiry evidence with source-step, source-seal, candidate-begin and candidate-page
replay evidence; Seal combines source-seal, candidate-begin and candidate-seal evidence. A newly persisted expiry
emits once, while terminal observations and candidate advancement after complete coverage emit nothing. Advance uses
replay evidence rather than processed-row counts or response state because a zero-row source step can persist a phase
transition or failure. Exact outer receipt replay still returns its committed response without another event.

Persist a small control row, indexed input/output, selected snapshot roots and a durable raw traversal frontier.
Use existing Book page 20 plus lookahead for one processing step (1,024 is at most an ingestion batch). Each step
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

Decision: the initiating account ID and authentication epoch are native actor identity, independent of the Book
storage route. Catalogue, stage, candidate generation, source revision, expected head and expected publication IDs
still follow their actual catalogue route; current actor admission and exact receipt replay remain unchanged across
account homes.

**Adopted activation currentness:** capture the installed 4,096-home generation/epoch vector before fresh source
observations. A replayable pass requires ordinary anonymous public eligibility for the catalogue opening. At most
20 distinct staged chapter targets per page use current public eligibility or exact Book-scoped consent. Both checks
include current Board/Realm/Space ancestry, source incarnation, author/licence, erasure, Access state and the keyed
sparse Post revision restriction. An admitted author receives 412 with `catalogue_not_public` or
`chapter_not_eligible` as the reason for an ineligible source. The candidate stays sealed and the publication pointer
stays fixed for a fresh review. Restriction transitions must advance the same source-home epoch in their native
transaction; the Post restriction owner supplies that keyed transition. Persist only the dependency homes actually proved. A changed
epoch restarts these authority pages against a fresh vector while preserving the sealed candidate and old public
release. The final command locks and compares only those homes in ascending order on the catalogue command client;
it holds them through the immutable descriptor write, root selection, publication-pointer CAS, receipt, event and
COMMIT. It performs no per-target metadata/body reads and does no foreign checkout while those locks are held.

Decision: authority advances settle current author authority and exact receipt replay before preparing and observing
one exact target page outside the command checkout. The stage-locked command rechecks the pass, cursor, candidate,
opening and staged page before retaining observations against that pass's fixed vector; stale concurrent pages
conflict and cancellation keeps the stage-row serialization order.

Ordinary partition log position is not an authority epoch; home movement changes its generation. The 4,096-home
vector bounds topology work, not Book size. This fixed-home vector supersedes the proposed universal singleton lock.

Current author admission still precedes receipt replay. A successful replay for a currently admitted author returns
its original publication after a later target revoke without reactivating it. Current reader disclosure remains
independent and mandatory after activation; a revoked or erased target becomes unavailable under its existing
reader rules. Expiring native eligibility requires native next-transition evidence. Existing preparation expiry,
Money/benefit guards, exact edition retention and retained-root reclamation stay with their current owners; this
activation adds no common Book table, universal lock, global sweeper or cleanup path.

Whole-build preparation uses a bounded committed frontier, coverage and seal, then one atomic publication pointer;
it copies no full manifest and follows no unbounded delta chain. Point publish and whole build share the immutable
root format, exact-target/consent contract, reader/cursor, CAS, receipt and native authority; they do not share a
job lifecycle. A successful serial chapter during preparation makes the original expected publication stale (412);
replacing it requires a new activation intent and key.

Decision: the focused currentness fixture uses 21 distinct private draft revisions with exact catalogue consent,
revokes one cross-home consent after candidate seal, preserves A and the same candidate, then renews consent and
retries only authority pages. It also pins source and container takedown, Realm/Space lifecycle, earliest erasure,
stale CAS, successful replay and current reader denial.

Decision: the Post restriction owner’s sparse exact-revision state is another source-home invalidator. Its keyed
native transition must advance the existing authority epoch so a prepared eligible observation cannot select
blocked bytes; activation adds no per-edit consent, entitlement or pointer behavior for restrictions.

Decision: `restrictPostRevision` runs `mutateContentPostRevisionRestriction` and
`post-revision-restriction.sql`, which increments the owning Post `security_revision` in the restriction transaction.
Appeal reversal reaches `liftTakedown` and `lift-takedown.sql`'s `exact_post_change`, incrementing that same field.
The existing `post_publication_authority` watcher carries both transitions into the source-home authority epoch;
activation adds no parallel invalidator.

Durable Book-scoped consent and a later withheld reader slot are **not** that activation proof. Consent may keep an
already issued exact-revision intent after the issuer later loses ordinary edit role, while explicit revoke, erasure
and container-read loss still deny bytes immediately. Source consent commits in the source home; the Book pointer
commits in the catalogue home. A revocation that races the last source check can leave a committed unavailable slot,
and the reader must refuse bytes. That lazy withheld view is current reader denial. It does not prove that every
newly selected target remained eligible at activation, independently of N. Keep the strict activation-currentness
requirement until native proof supports an explicit adopted replacement. Keep cross-home activation and immediate
reader denial as separate obligations.

### Release-candidate disposition and acceptance

The temporal candidate and bounded authority proof are one native publication path. Root append, point publication
and complete-release preparation retain their own selected-input bounds and share the same exact reader. Current
native authority, source consent, receipt/CAS and retention rules remain independent of Studio or reader UI state.
Required native suites include
[`hosted-publication-activation-currentness.test.ts`](../../test/content/hosted-publication-activation-currentness.test.ts),
[`hosted-publication-activation-http.test.ts`](../../test/content/hosted-publication-activation-http.test.ts) and
[`hosted-chapter-languages.test.ts`](../../test/content/hosted-chapter-languages.test.ts). Mounted author/reader and
physical-growth evidence remain separate release gates under the [Content Goal](../../../../docs/goals/content.md#acceptance).

| Case                          | Required native/API and mounted evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `outline.anchor-history`      | Insert/reorder/reparent by observed ID, no-effect, wrong/deleted/self/foreign anchors, cycle/depth boundary, opposite moves, stale 412 and exact authorized replay. Historical point/children/preorder/previous-next retain old order/targets after edits and removal; current Knowledge cursor still returns 409 and titles remain current.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `outline.scale`               | At >512 and 1k/10k/100k placements exercise the row-per-node temporal adapter. Repeat hot-gap edits beyond numeric-window exhaustion and move a large unchanged subtree; count logical probes separately from SQL/I/O, descendant rows (zero), reads/WAL/retained bytes. Denied/private siblings neither become visible nor trigger whole-list refill. Grow width/history/subtree independently; record values against the derived bounds. A fixed-page alternative needs the same native evidence.                                                                                                                                                                                                                                                                |
| `book.serial-point`           | On thousands of chapters append one public chapter and replace exactly one selected revision without manifest rewrite, full revalidation or other draft/public changes. Unpublished catalogue refuses before pointer advance. An already-public target uses Access public eligibility with no consent row. A private opening becomes Book-readable only after exact Book-scoped consent of one selected revision under proved published membership; the direct Post, other Books and unselected revisions stay private. Revoke between observation and commit, and after success: fail or neutral unavailable under native rules, never draft/title/body leakage or newer-byte substitution. Preserve exact old cursor/link/checkpoint, stale and replay outcomes. |
| `book.complete-batch`         | Whole and explicit ancestor-closed selection exceed 512 at 1k/10k/100k; complete publish and withdrawal, not just initial pages. With two real pools and barriers, check 21 targets in two pages, revoke across homes after seal, preserve A, then renew eligibility and repeat only the authority pass. Interrupt a page, reverse dependency lock order, roll back, and cover early erasure/container/takedown invalidators, stale CAS, lost-response replay and current reader denial. An unrelated-home writer proceeds. Count vector rows/locks separately and assert zero final target reads for 1 and 21 targets. Bound each step and final activation; verify zero bodies and no rescanned prefix.                                                          |
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

`appendRootChapter` inserts one stable chapter into the canonical ordered draft at the root end. It uses ordinary
Post edit authority, the expected draft head, native receipt replay and the same point/index writer as insertion.
It never changes the public selection or copies prior chapters. Later publication explicitly chooses the exact
chapter revision and language alternatives. Indexed sibling, preorder and chapter changes follow the selected
paths; the total draft and release size has no direct-request ceiling. Existing development append streams belong
to the one-time maintenance input, not a parallel runtime writer or reader.

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
that a target is absent. Parts disclose their titles under catalogue authority. Book page target preparation and
finalization use the shared `database/bounded-read-window.ts` ordered concurrency utility.

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

Decision: an inclusive first-page rank visits its selected chapter once, then its directional subtree and eligible
ancestors in order; continuation remains exclusive of its cursor anchor.

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

Decision: versioned Book pages use the selected sibling, preorder or chapter read set, prove every retained anchor in that root, and traverse one bounded in-order window; bigint ranks become numeric positions only at the existing wire projection, while route selection and disclosure remain with the hosted reader. Outline and chapter pages hydrate only visible candidates with one temporal occurrence batch and one distinct-parent sibling-root batch, preserve exact point reads, and resolve chapter-origin membership and rank in one chapter-weighted traversal.

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

## Hosted publication retention

Decision: drain at most 16 deterministic cleanup steps during the existing hourly Content collection workflow,
using a pending-work index and one-hour retry time for pins or cleanup conflicts; each step still uses the existing
100-row transaction limit and retirement authority.

Decision: retention takes the existing staging-row lock with `NOWAIT` inside each per-row savepoint. SQLSTATE `55P03`
leaves the due pending key and its availability unchanged while later keys in the bounded page can proceed; a later
bounded pass revisits the pending key through the existing keyset cursor.

The Library entry-retention worker provides the pacing reference: it runs every ten minutes, processes 100 durable
single-key pages per segment, then enqueues a bounded maintenance continuation while its partition cursor remains.
Content keeps its hourly `content.collection.hourly` schedule and does not add a scheduler or continuation queue. Each
scheduled Content sweep runs at most 16 retention segments, and each segment runs at most one existing staging or
candidate cleanup step. That caps cleanup at 1,600 deleted rows per sweep, or 1,600 rows per hour. Each segment also
examines at most 100 due keys and advances at most 100 legacy stage keys, for at most 3,200 returned stage keys per
sweep while legacy adoption is active.

The indexed pending projection contains only unfinished stages. New stages enter it in their creation transaction;
completed cleanup removes the projection row in the same transaction while retaining stage and cleanup receipts.
Existing rows are adopted through a durable `(route, catalogue, stage)` keyset, at most 100 per segment. Adoption
checks both cleanup completion markers and never inserts already-completed stages. The due index orders by
`available_at`; a pin or recognized cleanup conflict records the existing issue and moves that stage to one hour
after the sweep cutoff, so it leaves the current due page. Mode eligibility remains unchanged for whole and
selection candidates returned by the cleanup primitive.

Each DBOS page receives `<workflowID>:retention:<segment>` and derives the exact candidate cleanup step ID from that
page identity and the retained owner binding. A restart reuses the committed page output and does not repeat its
cleanup step. The focused retention test covers a 120-stage completed prefix, a persistent pin, resumable staging
and candidate cleanup, page replay, the per-segment key/write caps and an empty due pass after adoption.

## Cost and integration boundaries

Direct create, complete replacement and publication validate at most 512 explicit placements and the admitted
combined language-selection work. Distinct exact target checks select metadata only. Ordered initialization builds
occurrence facts, sibling/preorder/chapter indexes and summaries in O(N) work and memory for the explicit input;
point append/edit/move uses bounded index and ancestor paths rather than a prior-book copy. No mutable manifest or
append-stream writer/reader remains on the public path. Complete larger releases use retained bounded preparation.
A language enumeration examines at most 21 indexed keys and discloses at most 20 current alternatives. Exact
language selection is a full-key lookup; preference selection tries at most one explicit plus sixteen preferred
keys before the declared default. Contents/navigation compose that bounded work per returned chapter, never all
chapter languages or target bodies. Namespace ingestion and target proof each retain the existing 20-item step
bound. Publication copies selected title/target metadata only, with no canonical body copies. Published namespaces
are sealed before the single pointer transaction; private fact and abandoned-candidate cleanup page owned rows.
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

Decision: Contents and navigation prepare independent target metadata in a local four-operation window per phase.
Ordinary preparations remain grouped by full target key, privately consented fallback remains one per occurrence,
and retained finalizations use a separate four-operation window. For canonical-only selection, a page of 20 chapters performs at most
40 initial preparations and 20 finalizations. Language preference adds the bounded per-choice metadata work above,
with no chapter-body reads; response and anchor order,
raw continuation and final catalogue disclosure remain unchanged.

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
